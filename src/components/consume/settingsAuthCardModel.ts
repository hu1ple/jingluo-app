/**
 * 「登录 / 注册卡」的状态与视图（Issue #797 + #795）—— 没有 hooks、没有请求，纯判定 + 纯渲染。
 *
 * 为什么把逻辑从 `SettingsAuthCard.tsx` 里抽出来：`#797` 的验收项里有一半是「**有没有发请求**」
 * （确认密码不一致时不许发注册请求）、另一半是「点了之后框变不变」（眼睛按钮）。这两类断言都需要
 * 在**裸 Node** 里跑（本仓库 L1 用 `renderToStaticMarkup` 真渲染，`.tsx` 进不来），所以：
 *
 *  · {@link reduceAuthCard}：一个事件一个状态，界面只负责派事件；
 *  · {@link submitAuthCard} / {@link submitForgotPassword}：**唯一**两处可能发请求的判定，
 *    返回「要派给 reducer 的事件」而不是自己 setState —— 于是「不一致 → 一个请求都不发」这句话
 *    可以被一条 `assert.equal(calls.register.length, 0)` 钉住，而不是靠读代码相信；
 *  · {@link SettingsAuthCardView}：`createElement` 视图（`Button` / 眼睛图标由容器注入）。
 *
 * 三个语义口径（都有对应的 issue 条文）：
 *
 *  1. **确认密码只在客户端校验**（#797）：`signUp` 的入参里没有 `confirmPassword`，不一致时
 *     {@link submitAuthCard} 直接返回「拦下」事件。校验时机 = 输入时（`confirmTouched`）+
 *     失焦（`confirm-blur`）+ 提交前（`submit-blocked` / `authCardCanSubmit`），三个入口共用
 *     {@link confirmErrorKeyOf} 这一个判据。
 *  2. **忘记密码不许假装成功**（#795）：{@link forgotOutcomeOf} 把后端的 `message` **原样**带出来，
 *     并追加一句「重置暂未开通，请联系客服」；只有真的 `ok:true` 才说「已发送」。
 *     传输层失败（超时 / 连不上）**没有**后端原话可抄，此时退回归一化文案（`consumeErrNetwork`
 *     这类具体的话，仍然不是「未知错误」），也**不**追加重置未开通 —— 网络问题不等于功能没开。
 *  3. **不弹第二层**（本卡文件头的老规矩）：忘记密码是**卡内的一个小页**（`step: 'forgot'`），
 *     不是盖在设置弹层上的第二层 dialog。
 *  4. **注册 / 重置结束都回登录表单**（产品口径 2026-11-25）：{@link reduceAuthCard} 的
 *     `back-to-login` 是这两条链路唯一的终点 —— `mode: 'login'` + 邮箱预填 + 清空密码 / 验证码 +
 *     一句成功提示（`authRegisterDonePleaseLogin` / `authResetDonePleaseLogin`）。
 *     注册成功**不**建立会话（`store.signUp` 的 `autoSignIn: false`），登录只由用户自己点一次。
 *
 * 另外一条（2026-11-24 线上事故）：**「没读到开关」不等于「服务端关了注册」**。
 * 注册闸门是三态（{@link registrationGateOfContext}）：只有 `'disabled'`（服务端真的回了
 * `registration_enabled: false`）才在 {@link submitAuthCard} 里本地拦下并显示
 * `sub2authRegistrationDisabled`；`'unknown'` 时注册照常提交，由服务端判（真关了它回
 * `403 REGISTRATION_DISABLED`）。视图侧只多一行「功能开关读取失败，点此重试」。
 */

import { createElement, type ReactNode } from 'react'

import type { TranslationKey } from '../../i18n/index.js'
import type { RegistrationGate } from '../../services/auth/flags.js'
import type { ConsumeCallResult } from '../../services/consume/index.js'
import { createInFlightLatch, rateLimitSecondsOf, type InFlightLatch } from '../auth/submitGuard.js'
import { PasswordField, passwordToggleLabelKey } from './passwordInput.js'
import type { ConsumeTranslate, PanelButton, PanelClassNames } from './panels.js'

/** 分段控件的两个 tab */
export type AuthCardMode = 'login' | 'register'

/** 卡内两个小页：表单 / 忘记密码（不是第二层 dialog，见文件头第 3 条） */
export type AuthCardStep = 'form' | 'forgot'

/** 表单级提示：要么是可翻译的文案 key，要么不显示（后端原话走 `forgot.outcome`，不混进来） */
export type AuthCardNotice = TranslationKey | null

/** 忘记密码的结局（`needs-email` = 本地就拦下了，没发请求） */
export type ForgotOutcome =
  | { status: 'needs-email' }
  | { status: 'sent' }
  | {
      status: 'failed'
      /** 后端原话（`Sub2ApiError.message`）；只在这一条上屏，见文件头第 2 条 */
      serverMessage: string | null
      /** 没有后端原话时的退路（归一化文案 key） */
      fallbackKey: TranslationKey | null
      /** 追加的可操作文案：**只在真的收到了后端响应时**给 */
      hintKey: TranslationKey | null
    }

export type ForgotState = {
  /** 请求在飞（按钮置灰 + `aria-busy`） */
  sending: boolean
  outcome: ForgotOutcome | null
}

export type AuthCardState = {
  mode: AuthCardMode
  step: AuthCardStep
  email: string
  password: string
  /** 确认密码：**只在客户端**，永远不进请求体（#797） */
  confirmPassword: string
  verifyCode: string
  /** 密码框是否明文（两个框各自独立；不持久化，提交 / 切 tab / 离开卡片即回隐藏） */
  passwordVisible: boolean
  confirmVisible: boolean
  /** 确认密码被用户碰过（输入 / 失焦）—— 没碰过就不提前飘红 */
  confirmTouched: boolean
  /** 提交过至少一次：提交前的校验结果必须显示出来 */
  submitAttempted: boolean
  /**
   * 表单级提示（如「注册暂未开放」）。
   * 那句话**只有**注册闸门 `'disabled'`（服务端真的回了 `false`）才会走到这里 —— 见
   * `registrationGateOfContext` 与文件头最后一段；`'unknown'` 时不许显示它。
   */
  notice: AuthCardNotice
  /**
   * 提交被 429 挡回来之后的冷却剩余秒数（`0` = 没在冷却）。
   *
   * 429 **不是失败**：这段时间主按钮禁用、屏幕上写「操作太频繁，请 N 秒后再试」，倒计时归零自动恢复。
   * 秒数来自服务端 `Retry-After`（`retryAfterMs`），没有该头就 60s —— 见 `auth/submitGuard.ts`。
   */
  submitCooldown: number
  forgot: ForgotState
}

export type AuthCardEvent =
  | { type: 'mode'; mode: AuthCardMode }
  | { type: 'step'; step: AuthCardStep }
  | { type: 'email'; value: string }
  | { type: 'password'; value: string }
  | { type: 'confirm'; value: string }
  | { type: 'verify-code'; value: string }
  /** 邀请码（#819）：与验证码同一条通路，只是它只在开关开着时才渲染 */
  /** 点眼睛：`field` 决定切哪个框（两个框各自独立，#797 允许二选一，这里选独立） */
  | { type: 'toggle'; field: 'password' | 'confirm' }
  | { type: 'confirm-blur' }
  /** 提交被本地拦下（空字段 / 确认密码不一致）：只让界面把错误显示出来，**不发请求** */
  | { type: 'submit-blocked' }
  /** 请求已发出：恢复隐藏（#797「提交后恢复隐藏」） */
  | { type: 'form-submitted' }
  /**
   * **回到登录表单**（产品口径 2026-11-25：注册成功 / 重置密码成功之后都落在这一格）。
   *
   * 一个事件干四件事，所以必须由 reducer 一次做完（分成四个事件会在中间渲染出一帧「注册 tab +
   * 残留密码」）：① `mode: 'login'`；② 邮箱预填（`email` 由调用方给：注册用表单里那个，
   * 重置用重置页里那个 —— 用户可能在里面改过）；③ 清空密码 / 确认密码 / 验证码与找回密码的结局；
   * ④ 挂一句成功提示。
   */
  | { type: 'back-to-login'; notice: AuthCardNotice; email: string }
  | { type: 'notice'; notice: AuthCardNotice }
  /** 提交撞 429：进冷却（秒数由 `submitAuthCard` 从 `Retry-After` 算出） */
  | { type: 'cooldown'; seconds: number }
  /** 冷却逐秒步进（容器每秒派一次，归零自动恢复可点） */
  | { type: 'cooldown-tick' }
  | { type: 'forgot-sending' }
  | { type: 'forgot-outcome'; outcome: ForgotOutcome }

export const initialForgotState = (): ForgotState => ({ sending: false, outcome: null })

export const initialAuthCardState = (mode: AuthCardMode = 'login'): AuthCardState => ({
  mode,
  step: 'form',
  email: '',
  password: '',
  confirmPassword: '',
  verifyCode: '',
  passwordVisible: false,
  confirmVisible: false,
  confirmTouched: false,
  submitAttempted: false,
  notice: null,
  submitCooldown: 0,
  forgot: initialForgotState(),
})

export const reduceAuthCard = (state: AuthCardState, event: AuthCardEvent): AuthCardState => {
  switch (event.type) {
    case 'mode':
      if (state.mode === event.mode) {
        return state
      }
      // 换 tab = 换一张表单：确认密码 / 可见性 / 校验痕迹都不带过去，免得串味
      return {
        ...initialAuthCardState(event.mode),
        email: state.email,
        password: state.password,
        verifyCode: state.verifyCode,
      }
    case 'step':
      if (state.step === event.step) {
        return state
      }
      return {
        ...state,
        step: event.step,
        notice: null,
        // 进出「忘记密码」页时把上一次的结局清掉（否则再进来会看到上一次的红字）
        forgot: initialForgotState(),
      }
    case 'email':
      return { ...state, email: event.value }
    case 'password':
      // 密码改了也要重新校验确认密码：错误由 `confirmErrorKeyOf` 现算，所以这里只换值
      return { ...state, password: event.value }
    case 'confirm':
      return { ...state, confirmPassword: event.value, confirmTouched: true }
    case 'verify-code':
      return { ...state, verifyCode: event.value }
    case 'toggle':
      return event.field === 'password'
        ? { ...state, passwordVisible: !state.passwordVisible }
        : { ...state, confirmVisible: !state.confirmVisible }
    case 'confirm-blur':
      return { ...state, confirmTouched: true }
    case 'submit-blocked':
      return { ...state, submitAttempted: true, confirmTouched: true }
    case 'form-submitted':
      return {
        ...state,
        submitAttempted: true,
        // #797：提交后恢复隐藏，**不**持久化
        passwordVisible: false,
        confirmVisible: false,
        notice: null,
      }
    case 'back-to-login':
      // 回到登录表单 = 一张**新的登录表单**：注册 / 重置留下的东西（密码、确认密码、验证码、
      // 校验痕迹、冷却、找回密码结局）全部丢掉，只把邮箱和一句回执带过去。
      return {
        ...initialAuthCardState('login'),
        email: event.email,
        notice: event.notice,
      }
    case 'notice':
      return { ...state, notice: event.notice }
    case 'cooldown':
      return { ...state, submitCooldown: Math.max(0, Math.ceil(event.seconds)) }
    case 'cooldown-tick':
      return state.submitCooldown <= 0 ? state : { ...state, submitCooldown: state.submitCooldown - 1 }
    case 'forgot-sending':
      return { ...state, forgot: { sending: true, outcome: null } }
    case 'forgot-outcome':
      return { ...state, forgot: { sending: false, outcome: event.outcome } }
    default:
      return state
  }
}

/**
 * 「两次输入的密码不一致」该不该上屏（`null` = 不显示）。
 *
 * 三个调用点（输入 / 失焦 / 提交前）都用它，避免出现「失焦时报红、输入时又消失」这种两套判据。
 * 只有**注册** tab 才有这一栏；登录 tab 没有确认密码字段（#797 明确要求）。
 */
export const confirmErrorKeyOf = (state: AuthCardState): 'settingsAuthPasswordMismatch' | null => {
  if (state.mode !== 'register' || state.step !== 'form') {
    return null
  }
  if (!state.confirmTouched && !state.submitAttempted) {
    return null
  }
  if (state.confirmPassword === '' && !state.submitAttempted) {
    return null
  }
  return state.password === state.confirmPassword ? null : 'settingsAuthPasswordMismatch'
}

/** 主按钮能不能点：注册 tab 额外要求「确认密码非空且与密码一致」；429 冷却里一律不能点 */
export const authCardCanSubmit = (state: AuthCardState, submitting: boolean): boolean => {
  if (submitting || state.step !== 'form' || state.submitCooldown > 0) {
    return false
  }
  if (state.email.trim() === '' || state.password === '') {
    return false
  }
  if (state.mode === 'login') {
    return true
  }
  return state.confirmPassword !== '' && state.password === state.confirmPassword
}

/**
 * 提交结果的最小读法（**只判断「成了吗 / 是不是 429」**，不把 store 的完整类型搬进来）。
 *
 * `AuthResult<AuthUser>` 天然满足它：`{ok:true,data}` 与 `{ok:false,error:AuthError}` 都结构兼容。
 * `retryAfterMs` 是 `Sub2ApiError` 的字段，`AuthError` 目前没有（传输层没搬）—— 于是真机上秒数
 * 走 60s 兜底；将来传输层把它透出来，这里**不用改**就能按 `Retry-After` 倒计时。
 */
export type AuthCardCallOutcome = {
  ok: boolean
  error?: {
    status?: number | undefined
    kind?: string | undefined
    retryAfterMs?: number | undefined
  } | null
}

/** 卡里唯一会发请求的四个口子（真机是 `useAuthStore` 的三个动作 + `consume.auth.forgotPassword`） */
export type AuthCardSource = {
  signIn: (input: { email: string; password: string }) => Promise<AuthCardCallOutcome>
  /**
   * 注册（#839：**不再有邀请码**）。邀请码改到登录后的「我的邀请」里处理，注册表单与请求体都不带
   * `invitation_code`（`AuthRegisterInput` 里的可选字段留给不可达的旧 `RegisterPage`，这里不传）。
   */
  signUp: (input: {
    email: string
    password: string
    verifyCode?: string
  }) => Promise<AuthCardCallOutcome>
  forgotPassword: (input: { email: string }) => Promise<ConsumeCallResult<unknown>>
}

export type AuthCardSubmitContext = {
  submitting: boolean
  /**
   * 调用方注入的同步闩（容器那一个 ref）。
   *
   * `submitting` 是 props / store 里的渲染态，同一 tick 连点两次会都读到旧值 —— 判定不能只靠它。
   * 容器给了就用容器的；没给（裸 Node 单测 / 别的调用点）用模块级兜底闩，**并发两次调用一定挡得住**。
   */
  latch?: InFlightLatch
  /**
   * **注册闸门三态**（`src/services/auth/flags.ts` 的 `RegistrationGate`）—— 唯一的拦截判据：
   * 只有 `'disabled'`（服务端真的回了 `registration_enabled: false`）才本地拦；
   * `'unknown'`（没读到 / 重试耗尽 / 形状不认识）**一律不拦**，交给服务端判（#484 §3.1d）。
   */
  registration?: RegistrationGate
  /**
   * @deprecated 旧的两布尔口径，只为既有调用点 / 既有单测保留（新代码请传 `registration`）。
   * 语义仍然是旧的：只有「读到了（`true`）且读到的是关」才等价于 `'disabled'`；
   * 其余组合（含没读到）一律 `'unknown'` —— 那次线上事故正是把「没读到」错当成了「关」。
   */
  registrationLoaded?: boolean
  registrationEnabled?: boolean
}

/**
 * 上下文 → 注册闸门三态（**唯一**读法，`submitAuthCard` 与调用方都走它，避免两处各写一套判据）。
 *
 * 优先级：显式的 `registration` 三态 > 旧的两布尔推导。旧口径的映射刻意保守：
 * 「没读到」（`registrationLoaded !== true`）永远落 `'unknown'`，不会被当成关闭。
 */
export const registrationGateOfContext = (ctx: AuthCardSubmitContext): RegistrationGate => {
  if (ctx.registration !== undefined) {
    return ctx.registration
  }
  if (ctx.registrationLoaded === true && ctx.registrationEnabled === false) {
    return 'disabled'
  }
  if (ctx.registrationEnabled === true) {
    return 'enabled'
  }
  return 'unknown'
}

/**
 * flags store 的当前状态 → 卡片判据。
 *
 * 只做一件事：把 `registration` 三态端出来。做成函数是为了让容器与单测**共用同一个映射**
 * （如果哪天 store 的字段名变了，这里一处报错，而不是「单测绿、真机红」）。
 */
export const registrationGateOfFlags = (flags: { registration: RegistrationGate }): RegistrationGate =>
  flags.registration

/**
 * 模块级兜底闩：容器没注入自己的 ref 时用它。
 *
 * 为什么**必须有**：`ctx.submitting` 是渲染态，同一 tick 连点两次都读到 `false`（事故现场：
 * 双击两次注册 → 服务端 IP 限流 5/min → 之后填对验证码也被 429 挡 60s）。调用方 ref 是主防线，
 * 这一层保证「任何调用点都挡得住并发两次」—— 单测里注入假 source 时走的就是它。
 */
const fallbackLatch = createInFlightLatch()

/** 「忘记密码」的闩：同一 tick 连点两次只发一封重置邮件 */
const forgotLatch = createInFlightLatch()

/**
 * 提交表单。**发不发请求全看这里**，界面按钮的 `disabled` 只是顺手（按钮状态可能落后一帧，
 * 所以真正的不发请求必须由本函数保证）。
 *
 * 三层守卫，各管一段：
 *  1. `ctx.submitting` / `submitCooldown`：渲染态的「正在发」「还在冷却」；
 *  2. **同步闩**（`ctx.latch` ?? 模块级兜底）：同一 tick 的第二次调用在这里被挡掉 —— 这一层才是
 *     事故根因的修复（前两层都读不到刚发生的这次调用）；
 *  3. `try/finally`：请求抛错也把闩放掉，否则一次异常就把注册按钮永久锁死。
 */
export const submitAuthCard = async (
  source: AuthCardSource,
  state: AuthCardState,
  ctx: AuthCardSubmitContext
): Promise<AuthCardEvent[]> => {
  if (ctx.submitting || state.submitCooldown > 0) {
    return []
  }
  const latch = ctx.latch ?? fallbackLatch
  if (!latch.enter()) {
    return []
  }
  try {
    return await submitAuthCardLocked(source, state, ctx)
  } finally {
    latch.exit()
  }
}

/** 抢到闩之后的真正判定 + 请求（唯一读点仍是「发不发」这三条） */
const submitAuthCardLocked = async (
  source: AuthCardSource,
  state: AuthCardState,
  ctx: AuthCardSubmitContext
): Promise<AuthCardEvent[]> => {
  const email = state.email.trim()
  if (email === '' || state.password === '') {
    return [{ type: 'submit-blocked' }]
  }
  if (state.mode === 'register') {
    // #797 的核心一条：不一致 → 提交前就返回，`source.signUp` 一次都不调
    if (state.password !== state.confirmPassword) {
      return [{ type: 'submit-blocked' }]
    }
    // 只有「服务端真的说了关」才本地拦；`unknown` 交给服务端（真关了它会回 403 REGISTRATION_DISABLED，
    // 那句文案由 transport 的 AUTH_CODE_MESSAGE_KEYS 给）。把「没读到」拦在这里，就是那次事故。
    if (registrationGateOfContext(ctx) === 'disabled') {
      return [{ type: 'notice', notice: 'sub2authRegistrationDisabled' }]
    }
    const verifyCode = state.verifyCode.trim()
    // 确认密码**不进请求体**：服务端要的只有 email / password / verify_code（邀请码不在注册时填，#839）
    const input: { email: string; password: string; verifyCode?: string } = {
      email,
      password: state.password,
    }
    if (verifyCode !== '') {
      input.verifyCode = verifyCode
    }
    // #839：无论 `invitation_code_enabled` 是 true 还是 false，注册请求都不带邀请码
    return registerSubmitted(await source.signUp(input), email)
  }
  return cooldownOrSubmitted(await source.signIn({ email, password: state.password }))
}

/**
 * 请求结局 → 事件：**429 走冷却，其余（成功 / 别的失败）保持原样**。
 *
 * 「其余失败保持原样」不是偷懒：失败文案由 store 的 `error.messageKey` 经 `errorKey` 上屏
 * （#679 的收口口径），本函数只负责把 429 从「失败」里摘出来 —— 它该是可等待，不是「出错了」。
 */
const cooldownOrSubmitted = (outcome: AuthCardCallOutcome): AuthCardEvent[] => {
  const seconds = outcome.ok ? null : rateLimitSecondsOf(outcome.error)
  if (seconds !== null) {
    return [{ type: 'cooldown', seconds }]
  }
  return [{ type: 'form-submitted' }]
}

/**
 * **注册**的结局 → 事件：429 走冷却，失败留在原表单，**成功回登录表单**。
 *
 * 产品口径（2026-11-25）：注册结束不等于登录 —— 注册成功后卡片切回登录 tab、邮箱预填、
 * 密码清空，并挂一句「注册成功，请登录」；会话不在这里建立（见 `store.signUp` 的
 * `autoSignIn: false`，界面两个入口都传它）。
 */
const registerSubmitted = (outcome: AuthCardCallOutcome, email: string): AuthCardEvent[] => {
  const seconds = outcome.ok ? null : rateLimitSecondsOf(outcome.error)
  if (seconds !== null) {
    return [{ type: 'cooldown', seconds }]
  }
  if (outcome.ok) {
    return [{ type: 'back-to-login', notice: 'authRegisterDonePleaseLogin', email }]
  }
  return [{ type: 'form-submitted' }]
}

/**
 * `POST /api/v1/auth/forgot-password` 的结局 → 上屏用的事件（#795 第 2 / 3 条）。
 *
 * 失败分支的顺序很关键：**先看有没有真的拿到后端响应**（`status > 0`）。拿到了就原样展示
 * `message`（这就是 staging 上那句 `Password reset is not configured`）+ 「请联系客服」；
 * 没拿到（`status === 0`：超时 / 连不上 / 非原生平台）就没有原话可抄，退回归一化文案。
 */
export const forgotOutcomeOf = (result: ConsumeCallResult<unknown>): ForgotOutcome => {
  if (result.ok) {
    return { status: 'sent' }
  }
  const message = result.error.message.trim()
  if (result.error.status > 0) {
    return {
      status: 'failed',
      serverMessage: message === '' ? null : message,
      fallbackKey: message === '' ? result.error.i18nKey : null,
      hintKey: 'settingsAuthForgotNotReady',
    }
  }
  return { status: 'failed', serverMessage: null, fallbackKey: result.error.i18nKey, hintKey: null }
}

/**
 * 忘记密码：空邮箱**本地拦下**（一条请求都不发），非空才真的发。
 *
 * 「发码 / 发重置邮件」这类纯通知接口的成功判据只看 2xx（`consume/auth.ts` 的
 * `CONSUME_EFFECT_POLICIES.forgotPassword`）：没有可回查的证据，所以文案也只说「已发送」，
 * 不承诺「邮件一定到了」。
 */
export const submitForgotPassword = async (
  source: AuthCardSource,
  state: AuthCardState
): Promise<AuthCardEvent[]> => {
  // 同一把同步闩的规矩（见 `submitAuthCard` 的注释）：并发两次只发一封
  if (!forgotLatch.enter()) {
    return []
  }
  try {
    const email = state.email.trim()
    if (email === '') {
      return [{ type: 'forgot-outcome', outcome: { status: 'needs-email' } }]
    }
    const result = await source.forgotPassword({ email })
    return [{ type: 'forgot-outcome', outcome: forgotOutcomeOf(result) }]
  } finally {
    forgotLatch.exit()
  }
}

// --------------------------------------------------------------------------- 视图

export type SettingsAuthCardViewProps = {
  t: ConsumeTranslate
  c: PanelClassNames
  Button: PanelButton
  /** 睁眼 / 闭眼图标（`.tsx` 进来的，见 `passwordInput.ts` 文件头第 3 段） */
  EyeIcon: () => ReactNode
  EyeOffIcon: () => ReactNode
  state: AuthCardState
  submitting: boolean
  sendingCode: boolean
  /** 验证码倒计时剩余秒数（0 = 没在冷却；计时器在容器里） */
  countdown: number
  /**
   * 这一轮发码倒计时是**被 429 挡回来**的（而不是真发出去了）。
   *
   * true 时把提示换成「操作太频繁，请 N 秒后再试」，并压掉 `errorKey` —— store 把 429 归一成
   * 「登录失败，请重试」，那两句话同时出现在屏幕上，用户会以为是自己填错了。
   */
  countdownRateLimited?: boolean
  /** 登录 / 注册失败的文案 key（来自 store 的 `error.messageKey`） */
  errorKey: TranslationKey | null
  /**
   * 注册闸门三态（`src/services/auth/flags.ts`）。视图**只用它决定提示**，不拿它拦人 ——
   * 拦不拦是 `submitAuthCard` 的事，且只有 `'disabled'` 才拦。
   */
  registrationGate: RegistrationGate
  /**
   * 开关「试过了但没拿到」（重试耗尽 / 形状不认识）。为 true 时注册照常可点，
   * 底部多一行「功能开关读取失败，点此重试」—— 而不是假装「注册未开放」。
   */
  flagsReadFailed: boolean
  /** 点那一行提示时重新读一次开关（容器接线到 `loadAuthFlags`） */
  onRetryFlags: () => void
  onEvent: (event: AuthCardEvent) => void
  onSubmit: () => void
  onSendCode: () => void
  onForgotSubmit: () => void
  onSkip: () => void
}

/** 忘记密码那一页：一句说明 + 邮箱 + 发送 + 结局（成功 / 后端原话 + 可操作提示） */
const ForgotView = (props: SettingsAuthCardViewProps): ReactNode => {
  const { t, c, Button, state } = props
  const outcome = state.forgot.outcome
  const emailFilled = state.email.trim() !== ''

  const status: ReactNode[] = []
  if (outcome !== null && outcome.status === 'needs-email') {
    status.push(
      createElement(
        'p',
        { className: c.authError, role: 'alert', 'data-testid': 'settings-auth-forgot-status' },
        t('settingsAuthForgotNeedsEmail')
      )
    )
  }
  if (outcome !== null && outcome.status === 'sent') {
    status.push(
      createElement(
        'p',
        { className: c.authNotice, role: 'status', 'data-testid': 'settings-auth-forgot-status' },
        t('settingsAuthForgotSent')
      )
    )
  }
  if (outcome !== null && outcome.status === 'failed') {
    // 失败：**后端原话照抄**（不替换成「未知错误」），再补一句能做的
    status.push(
      createElement(
        'div',
        {
          className: c.authError,
          role: 'alert',
          'data-testid': 'settings-auth-forgot-status',
        },
        createElement(
          'p',
          { 'data-testid': 'settings-auth-forgot-error-message' },
          outcome.serverMessage ?? (outcome.fallbackKey === null ? '' : t(outcome.fallbackKey))
        ),
        outcome.hintKey === null
          ? null
          : createElement('p', { 'data-testid': 'settings-auth-forgot-error-hint' }, t(outcome.hintKey))
      )
    )
  }

  return createElement(
    'div',
    { className: c.authCard, 'data-testid': 'settings-auth-forgot-form' },
    createElement('h2', { className: c.authForgotTitle }, t('settingsAuthForgotTitle')),
    createElement('input', {
      className: c.authInput,
      type: 'email',
      inputMode: 'email',
      autoComplete: 'email',
      spellCheck: false,
      placeholder: t('settingsAuthEmailPlaceholder'),
      'aria-label': t('sub2authEmail'),
      'data-testid': 'settings-auth-forgot-email',
      value: state.email,
      onChange: (event: { currentTarget: HTMLInputElement }) =>
        props.onEvent({ type: 'email', value: event.currentTarget.value }),
    }),
    createElement(
      Button,
      {
        variant: 'primary',
        size: 'l',
        block: true,
        className: c.authPrimary,
        disabled: !emailFilled || state.forgot.sending,
        testId: 'settings-auth-forgot-submit',
        onClick: props.onForgotSubmit,
      },
      t('settingsAuthForgotSend')
    ),
    ...status,
    createElement(
      'button',
      {
        type: 'button',
        className: c.authLink,
        'data-testid': 'settings-auth-forgot-back',
        onClick: () => props.onEvent({ type: 'step', step: 'form' }),
      },
      t('settingsAuthForgotBack')
    )
  )
}

export const SettingsAuthCardView = (props: SettingsAuthCardViewProps): ReactNode => {
  const { t, c, Button, state } = props
  if (state.step === 'forgot') {
    return ForgotView(props)
  }

  const registering = state.mode === 'register'
  const confirmErrorKey = confirmErrorKeyOf(state)
  const codeLoading = props.sendingCode || props.countdown > 0
  const canSubmit = authCardCanSubmit(state, props.submitting)
  /** 提交链路的 429 冷却（>0 = 主按钮禁用 + 一行「请 N 秒后再试」） */
  const submitCooldown = state.submitCooldown
  const codeRateLimited = props.countdownRateLimited === true && props.countdown > 0
  const rateLimited = submitCooldown > 0 || codeRateLimited

  const segmented = createElement(
    'div',
    { className: c.authSegmented, role: 'group', 'aria-label': t('sub2authAccount') },
    createElement(
      'button',
      {
        type: 'button',
        className: state.mode === 'login' ? `${c.authSeg ?? ''} ${c.authSegOn ?? ''}` : c.authSeg,
        'aria-pressed': state.mode === 'login',
        'data-testid': 'auth-segmented-login',
        onClick: () => props.onEvent({ type: 'mode', mode: 'login' }),
      },
      t('sub2authLogin')
    ),
    createElement(
      'button',
      {
        type: 'button',
        className: state.mode === 'register' ? `${c.authSeg ?? ''} ${c.authSegOn ?? ''}` : c.authSeg,
        'aria-pressed': state.mode === 'register',
        'data-testid': 'auth-segmented-register',
        onClick: () => props.onEvent({ type: 'mode', mode: 'register' }),
      },
      t('sub2authRegister')
    )
  )

  const emailInput = createElement('input', {
    className: c.authInput,
    type: 'email',
    inputMode: 'email',
    autoComplete: 'email',
    spellCheck: false,
    placeholder: t('settingsAuthEmailPlaceholder'),
    'aria-label': t('sub2authEmail'),
    'data-testid': 'settings-auth-email',
    value: state.email,
    onChange: (event: { currentTarget: HTMLInputElement }) =>
      props.onEvent({ type: 'email', value: event.currentTarget.value }),
  })

  const codeRow = registering
    ? createElement(
        'div',
        { className: c.authCodeRow },
        createElement('input', {
          className: `${c.authInput ?? ''} ${c.authCodeInput ?? ''}`,
          type: 'text',
          inputMode: 'numeric',
          autoComplete: 'one-time-code',
          spellCheck: false,
          placeholder: t('settingsAuthCodePlaceholder'),
          'aria-label': t('settingsAuthCodePlaceholder'),
          'data-testid': 'settings-auth-code',
          value: state.verifyCode,
          onChange: (event: { currentTarget: HTMLInputElement }) =>
            props.onEvent({ type: 'verify-code', value: event.currentTarget.value }),
        }),
        createElement(
          'button',
          {
            type: 'button',
            className: c.authCodeButton,
            'data-testid': 'settings-auth-send-code',
            disabled: codeLoading || state.email.trim() === '',
            onClick: props.onSendCode,
          },
          props.countdown > 0
            ? t('settingsAuthCountdown', { seconds: props.countdown })
            : t('settingsAuthSendCode')
        )
      )
    : null

  /**
   * 冷却提示：两条链路共用一句文案（`sub2authTooManyTries`，`{seconds}`= 剩余秒数）。
   *
   * 优先显示**提交**那一条（`submitCooldown`）：它才是「点了注册被挡回来」的直接回执；
   * 发码那一条由按钮自己显示 `{N}s` 倒计时，这里再补一句更完整的「太频繁」。
   */
  const cooldownNote =
    submitCooldown > 0 || codeRateLimited
      ? createElement(
          'p',
          {
            className: c.authNotice,
            role: 'status',
            'data-testid': submitCooldown > 0 ? 'settings-auth-cooldown' : 'settings-auth-code-cooldown',
          },
          t('sub2authTooManyTries', {
            seconds: submitCooldown > 0 ? submitCooldown : props.countdown,
          })
        )
      : null

  // 密码框：登录 tab 复用同一个组件，但**没有**确认密码那一栏（#797）
  const passwordField = createElement(PasswordField, {
    value: state.password,
    visible: state.passwordVisible,
    placeholder: t('settingsAuthPasswordPlaceholder'),
    ariaLabel: t('sub2authPassword'),
    toggleLabel: t(passwordToggleLabelKey(state.passwordVisible)),
    autoComplete: registering ? 'new-password' : 'current-password',
    testId: 'settings-auth-password',
    c: { row: c.authPasswordRow, input: `${c.authInput ?? ''} ${c.authPasswordInput ?? ''}`, toggle: c.authPasswordToggle, error: c.authFieldError },
    EyeIcon: props.EyeIcon,
    EyeOffIcon: props.EyeOffIcon,
    onChange: (value: string) => props.onEvent({ type: 'password', value }),
    onToggle: () => props.onEvent({ type: 'toggle', field: 'password' }),
    onKeyDown: (event: { key: string; nativeEvent: { isComposing: boolean } }) => {
      if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
        props.onSubmit()
      }
    },
  })

  const confirmField = registering
    ? createElement(PasswordField, {
        value: state.confirmPassword,
        visible: state.confirmVisible,
        placeholder: t('settingsAuthConfirmPlaceholder'),
        ariaLabel: t('sub2authConfirmPassword'),
        toggleLabel: t(passwordToggleLabelKey(state.confirmVisible)),
        autoComplete: 'new-password',
        testId: 'settings-auth-confirm',
        c: { row: c.authPasswordRow, input: `${c.authInput ?? ''} ${c.authPasswordInput ?? ''}`, toggle: c.authPasswordToggle, error: c.authFieldError },
        EyeIcon: props.EyeIcon,
        EyeOffIcon: props.EyeOffIcon,
        errorText: confirmErrorKey === null ? undefined : t(confirmErrorKey),
        errorTestId: 'settings-auth-confirm-error',
        onChange: (value: string) => props.onEvent({ type: 'confirm', value }),
        onToggle: () => props.onEvent({ type: 'toggle', field: 'confirm' }),
        onBlur: () => props.onEvent({ type: 'confirm-blur' }),
        onKeyDown: (event: { key: string; nativeEvent: { isComposing: boolean } }) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            props.onSubmit()
          }
        },
      })
    : null

  return createElement(
    'div',
    { className: c.authCard, 'data-testid': 'settings-auth-card' },
    segmented,
    emailInput,
    codeRow,
    passwordField,
    confirmField,
    createElement(
      Button,
      {
        variant: 'primary',
        size: 'l',
        block: true,
        className: c.authPrimary,
        disabled: !canSubmit,
        testId: 'settings-auth-submit',
        onClick: props.onSubmit,
      },
      registering ? t('sub2authRegister') : t('sub2authLogin')
    ),
    // 冷却期间不讲「失败」：429 在用户眼里是「等一等」，不是「你出错了」
    props.errorKey === null || rateLimited
      ? null
      : createElement(
          'div',
          { className: c.authError, role: 'alert', 'data-testid': 'settings-auth-error' },
          t(props.errorKey)
        ),
    cooldownNote,
    state.notice === null
      ? null
      : createElement(
          'div',
          { className: c.authNotice, role: 'status', 'data-testid': 'settings-auth-notice' },
          t(state.notice)
        ),
    // 开关没读到（`unknown` + 试过）：**不**冒充「注册未开放」，只说「读取失败，点此重试」。
    // 这一行只在注册分段出现 —— 登录不受注册开关影响，别在登录卡上加噪音。
    registering && props.registrationGate === 'unknown' && props.flagsReadFailed
      ? createElement(
          'button',
          {
            type: 'button',
            className: c.authLinkDim,
            'data-testid': 'settings-auth-flags-retry',
            onClick: props.onRetryFlags,
          },
          t('settingsAuthFlagsRetry')
        )
      : null,
    // #608 的口子：不登录也能用，直接去填 API Key
    createElement(
      'button',
      {
        type: 'button',
        className: c.authLink,
        'data-testid': 'account-consume-skip-login',
        onClick: props.onSkip,
      },
      t('settingsAuthSkip')
    ),
    createElement(
      'button',
      {
        type: 'button',
        className: c.authLink,
        'data-testid': 'settings-auth-forgot',
        onClick: () => props.onEvent({ type: 'step', step: 'forgot' }),
      },
      `${t('sub2authForgotPassword')}？`
    ),
    registering
      ? createElement(
          'button',
          {
            type: 'button',
            className: c.authLinkDim,
            'data-testid': 'settings-auth-switch-login',
            onClick: () => props.onEvent({ type: 'mode', mode: 'login' }),
          },
          t('settingsAuthHaveAccount')
        )
      : null
  )
}
