/**
 * 验证码式重置密码（两步）—— **纯逻辑 + 一次传输调用**，可以被裸 Node 直接 import 单测。
 *
 * ## 契约（后端代码已落地，2026-11-24 由 lead 从后端源码确认）
 *
 * ```
 * POST {base}/api/v1/auth/forgot-password   body: { email, mode: 'code' }
 *   200 = 已受理并发信（**该邮箱不存在也回 200**，防枚举；别在这条路上做「邮箱存在性」判断）
 * POST {base}/api/v1/auth/reset-password    body: { email, code, new_password }
 *   token / code 二选一；两个都给或都不给 = 400；new_password < 6 位 = 400
 * ```
 *
 * 两条都是**匿名接口**：请求体不带 `Authorization`（`auth: null`），也不该带 —— 忘记密码的人
 * 正是登不进来的人（`#484 §二`：JWT 只进 header、cookie 无效）。
 *
 * ## 为什么不复用 `consume.auth.forgotPassword` / `consume.auth.resetPassword`
 *
 * 那两个封装实现的是**链接模式**：`forgotPassword` 只把 `{email}` 摊进 body（没有 `mode`），
 * `resetPassword` 发的是 `{password, token?, code?}`（没有 `email`、字段名也不是 `new_password`）。
 * 契约一变，字段名跟着变，硬塞会「类型上过得去、请求体是错的」。所以这里只借**传输层**
 * （`services/consume/http.ts` 的 `call`：地址注入、超时档位、三种信封解包、CapacitorHttp/fetch 双分支），
 * 请求体按新契约自己拼 —— **不新起 fetch 封装、不在本文件写任何地址字面量**（base 来自
 * `__ENDPOINTS__.consume.baseUrl`，`check:consume-api` 只认白名单里的两条路径）。
 *
 * 等链接模式退役、`consume/auth.ts` 的这两个函数改成 code 模式后，本文件可以缩成两行转发
 * （见文件末「与真实契约的差距」）。
 *
 * ## 演示模式（DEMO_MODE）
 *
 * 后端 code 模式没上线时，这套 UI 也要能演给人看。触发条件**只有两种**（见 {@link requestResetCode}）：
 *  1. 后端明确说「没开通」：`404` / `reason` 是 `PASSWORD_RESET_DISABLED` / `PASSWORD_RESET_NOT_CONFIGURED`
 *     / `MODE_NOT_SUPPORTED` 一类「不认这个 mode」；
 *  2. 后端**根本不可达**：`status === 0`（超时 / 连不上 / 非原生平台）。
 * 其余一律**不降级**（429 限流、其它 4xx/5xx 照实报错）—— 「后端骂了我」不等于「没有后端」。
 *
 * 演示会话的退出条件同样是两条：① 下一次 `requestResetCode` 走到**真链路成功**（立刻清掉并把
 * `demo` 置 false）；② `resetPasswordWithCode` 在演示会话里成功一次（用完即销）。另外
 * {@link resetPasswordDemoState} 供界面卸载 / 返回登录时主动清。
 *
 * 演示模式的三条红线（写死在代码里，不是文案约定）：
 *  - **不发任何真实请求**（演示分支在发请求之前就返回）；
 *  - **不写任何凭据**（本文件不 import store / 不碰 localStorage，连 `signIn` 的入口都没有）；
 *  - **不假装登录成功**：`ok: true, demo: true` 只表示「演示流程走完了」，界面必须自己说清楚是演示。
 */

import type { ConsumeCallResult } from '../consume/http.js'
import type { Sub2ApiError } from '../consume/errors.js'

/** 演示模式的固定验证码（界面上会明写，不是「偷偷能用」的后门） */
export const DEMO_CODE = '123456'

/**
 * 演示模式是否可用（构建期常量，默认 true）。
 *
 * 为什么要一个常量而不是纯隐式行为：产品演示 / 客服排障时，「这条流程现在能不能演」得有个
 * 明确的读点；也是 `docs/` 与回报里能被引用的那一个符号。**它不控制降级条件**
 * —— 降级只看后端脸色（见文件头），把它设成 false 才是一刀切「永不演示」。
 *
 * 现在没有构建期覆盖（`rspack` 的 DefinePlugin 里没插这个值）：改这一行就够了，别加第二个开关。
 */
export const DEMO_MODE = true

/** 服务端重置密码的密码下限（契约：`new_password` < 6 位 = 400）；本地同口径预校验，省一次往返 */
export const MIN_RESET_PASSWORD_LENGTH = 6

/** 6 位数字验证码（只判形状；对不对由服务端 / 演示码判） */
export const isValidResetCode = (code: string): boolean => /^\d{6}$/.test(code)

/** 发码失败的原因（**互斥**，界面上每种一句不同的话，不许一律「失败」） */
export type RequestResetFailure =
  /** 后端没开这项能力（404 / 未配置 / 不认 code 模式）—— 唯一会**降级演示**的那种失败之一 */
  | 'not-enabled'
  /** 429：发太频繁（服务端 5/min）。**不降级**，让用户等 */
  | 'rate-limited'
  /** status 0：超时 / 连不上 —— 另一种会**降级演示**的失败 */
  | 'network'
  /** 其它 4xx/5xx（400 参数被拒、5xx、表外码）：照实说「服务端拒绝了」，不猜 */
  | 'failed'

/** 演示会话是怎么来的（决定界面上那句提示怎么说，不改变「固定 123456」这件事） */
export type DemoReason = 'not-enabled' | 'unreachable'

export type RequestResetCodeResult =
  /** `demo: false` = 真后端受理了，会说「已发送」；`demo: true` = 演示会话已开，界面**必须**标注 */
  | { ok: true; demo: false }
  | { ok: true; demo: true; demoReason: DemoReason }
  | { ok: false; reason: RequestResetFailure }

/** 重置失败的原因（同上：每种一句自己的话） */
export type ResetWithCodeFailure =
  /** 码错 / 过期（400 + 码相关业务码；无业务码的 400 也归这里 —— 见 {@link classifyResetFailure}） */
  | 'invalid-code'
  /** 新密码太短（本地已先拦一道，这里留给「服务端说了不算」的场合，例如服务端规则变严） */
  | 'weak-password'
  /** 后端没开这项能力（403 `PASSWORD_RESET_DISABLED` / 404） */
  | 'not-enabled'
  | 'rate-limited'
  | 'network'
  | 'failed'

export type ResetWithCodeResult =
  /** `demo: true` = 演示码对上了，**没有任何后端参与**，界面不许说成「账号已改」 */
  | { ok: true; demo: boolean }
  | { ok: false; reason: ResetWithCodeFailure }

// --------------------------------------------------------------------------- 失败映射（纯函数）

/** 服务端业务码 → 「没开通」。这几条是「后端在，能力不在」的判据（含 mode 不认） */
const NOT_ENABLED_CODES = new Set([
  'PASSWORD_RESET_DISABLED',
  'PASSWORD_RESET_NOT_CONFIGURED',
  'PASSWORD_RESET_UNAVAILABLE',
  'PASSWORD_RESET_MODE_UNSUPPORTED',
  'MODE_NOT_SUPPORTED',
  'UNSUPPORTED_MODE',
  'INVALID_MODE',
])

/**
 * 服务端业务码 → 「验证码错 / 过期」。
 *
 * `INVALID_VERIFY_CODE` 是**实测**来的（2026-11-24，本地 code 模式实例 18082）：
 * `{"code":400,"message":"invalid or expired verification code","reason":"INVALID_VERIFY_CODE"}`。
 * 其余几个是不同版本可能的叫法（表外的码仍会落到 400 兜底，见 {@link classifyResetFailure}）。
 */
const INVALID_CODE_CODES = new Set([
  'INVALID_VERIFY_CODE',
  'VERIFY_CODE_INVALID',
  'INVALID_CODE',
  'INVALID_RESET_CODE',
  'RESET_CODE_INVALID',
  'CODE_INVALID',
  'CODE_EXPIRED',
  'RESET_CODE_EXPIRED',
  'CODE_MISMATCH',
])

/** 服务端业务码 → 「密码太弱」 */
const WEAK_PASSWORD_CODES = new Set([
  'WEAK_PASSWORD',
  'PASSWORD_TOO_SHORT',
  'PASSWORD_TOO_WEAK',
  'INVALID_PASSWORD_LENGTH',
])

/** 业务码：`reason`（面板信封）优先，其次 `code`（中间件字符串 / `HTTP_<status>` 兜底） */
const serverCodes = (error: Sub2ApiError): string[] => {
  const codes = [error.reason ?? '', error.code]
  return codes.filter((value) => value !== '')
}

/**
 * 「后端有这条路由、但没配重置能力」的**旧版本签名**（实测 2026-11-24，生产 `0.2.x` 链接模式）：
 *
 * ```http
 * POST /api/v1/auth/forgot-password {"email":"…","mode":"code"}
 * → 500 {"code":500,"message":"Password reset is not configured"}      // 没有 reason 字段
 * ```
 *
 * 这是本文件**唯一**看 `message` 的地方，而且只用于「内部归类」这一件事（`not-enabled` 还是
 * `failed`），**永不上屏** —— 上屏文案仍由 i18n key 决定（#679 的收口口径针对的是「用户看到什么」）。
 * 不这么判，旧后端那台机器上就永远只能显示「重置失败，请稍后重试」：用户会一直重试，而它**永远不会成功**。
 *
 * 新后端（code 模式）上线后给的是 `403 PASSWORD_RESET_DISABLED` / `404`，这段就该删。
 */
const LEGACY_NOT_CONFIGURED = /password reset is not configured/i

/**
 * 发码失败 → 原因。**顺序：状态码 0（没拿到响应）→ 业务码 → 状态码类别**。
 *
 * 只看 `status` / `reason` / `code`（外加上面那一条旧版本签名），绝不拿 `message` 当文案来源。
 */
export const classifyRequestFailure = (error: Sub2ApiError): RequestResetFailure => {
  if (error.status === 0 || error.kind === 'network') {
    return 'network'
  }
  if (error.status === 429 || error.kind === 'rate_limit') {
    return 'rate-limited'
  }
  if (error.status === 404 || serverCodes(error).some((code) => NOT_ENABLED_CODES.has(code))) {
    return 'not-enabled'
  }
  if (error.status >= 500 && LEGACY_NOT_CONFIGURED.test(error.message)) {
    return 'not-enabled'
  }
  return 'failed'
}

/**
 * 重置失败 → 原因。
 *
 * 400 的兜底是 `invalid-code`：契约里 400 只有两种情况（码不对 / 密码太短），而密码长度本地已经
 * 先拦过（{@link MIN_RESET_PASSWORD_LENGTH}），所以剩下的 400 极大概率是码 —— 归到「码不对」
 * 比归到「后台说不行」对用户更有用（他会去重新获取验证码）。
 */
export const classifyResetFailure = (error: Sub2ApiError): ResetWithCodeFailure => {
  if (error.status === 0 || error.kind === 'network') {
    return 'network'
  }
  if (error.status === 429 || error.kind === 'rate_limit') {
    return 'rate-limited'
  }
  const codes = serverCodes(error)
  if (error.status === 403 || error.status === 404) {
    // 403 有两种：能力没开（上面）与「就是不让你做」。两种都不该说成「码错了」；
    // 但只有「没开」能降级演示，所以只在业务码明确时叫 not-enabled，其余给 failed。
    return codes.some((code) => NOT_ENABLED_CODES.has(code)) ? 'not-enabled' : 'failed'
  }
  if (codes.some((code) => WEAK_PASSWORD_CODES.has(code))) {
    return 'weak-password'
  }
  if (codes.some((code) => INVALID_CODE_CODES.has(code))) {
    return 'invalid-code'
  }
  // 400 且**没有**业务码：服务端把它出成字段校验失败（实测 18082，
  // `"Key: 'ResetPasswordRequest.NewPassword' … failed on the 'min' tag"`）——
  // 这条原话不上屏（#679），只用来分辨「是码错还是密码不合格」。
  if (error.status === 400 && /ResetPasswordRequest\.NewPassword/i.test(error.message)) {
    return 'weak-password'
  }
  if (error.status === 400) {
    return 'invalid-code'
  }
  return 'failed'
}

// --------------------------------------------------------------------------- 演示会话状态

/**
 * 当前演示会话（`null` = 没有）。
 *
 * 只记**邮箱**，不记验证码之外任何东西：验证码是常量 {@link DEMO_CODE}，密码不落任何地方
 * （`resetPasswordWithCode` 收到就判、判完即弃）。`email` 用来保证「A 邮箱开的演示会话不能拿去
 * 重置 B 邮箱」—— 那会让人以为演示真的改了某个账号。
 */
let demoSession: { email: string } | null = null

/** 演示会话是否开着（界面用它决定要不要挂那行「当前为演示模式」） */
export const isDemoSession = (): boolean => demoSession !== null

/** 主动结束演示会话（界面卸载 / 返回登录时调；成功后也会自动清） */
export const resetPasswordDemoState = (): void => {
  demoSession = null
}

// --------------------------------------------------------------------------- 传输（可注入）

/**
 * 一次「匿名 POST」。抽出类型是为了**单测注入假实现**（不发真请求）。
 *
 * 返回 `ConsumeCallResult` 而不是自定义形状：错误对象（`status` / `reason` / `kind`）正是
 * {@link classifyRequestFailure} / {@link classifyResetFailure} 的输入，少一层转换就少一处口径分裂。
 */
export type PasswordResetPost = (
  path: typeof FORGOT_PATH | typeof RESET_PATH,
  body: Record<string, unknown>
) => Promise<ConsumeCallResult<unknown>>

const FORGOT_PATH = '/api/v1/auth/forgot-password'
const RESET_PATH = '/api/v1/auth/reset-password'

/**
 * 默认实现：走**全应用共享**的消费层客户端（`services/consumeClient.ts` 的单例）。
 *
 * 为什么动态 import：本文件要能被裸 Node 直接 import 做单测，而共享客户端会拉进
 * `@capacitor/core` 与身份层的 store（`i18n/index.ts` 对采集层用的是同一招）。
 * 动态 import 在 rspack 里就是一个异步 chunk，产物里不会多一次网络往返。
 */
const postToBackend: PasswordResetPost = async (path, body) => {
  const { getConsumeClient } = await import('../consumeClient.js')
  return getConsumeClient().http.call<unknown>({
    method: 'POST',
    path,
    body,
    // 写操作档位（和 `consume/auth.ts` 的 forgotPassword / resetPassword 一致）
    timeout: 'write',
    // 刻意匿名：忘记密码的人没有会话；带上旧 token 只会让服务端以为这是「已登录改密码」
    auth: null,
  })
}

let post: PasswordResetPost = postToBackend

/** 替换传输实现（单测 / 特殊联调）；传 null 恢复默认 */
export const setPasswordResetPost = (next: PasswordResetPost | null): void => {
  post = next ?? postToBackend
}

// --------------------------------------------------------------------------- 两个动作

/**
 * 第一步：请求验证码。
 *
 * `mode: 'code'` **显式传**：后端现在的缺省就是 code，但显式写出来，将来默认值改成 `link`
 * 也不会把这份前端悄悄带偏（契约里 `mode` 是入参，不是可有可无的注释）。
 *
 * 成功判据只信 2xx（`CONSUME_EFFECT_POLICIES.forgotPassword`：纯通知类，无实体可回查，
 * 且**刻意不回查** —— 回查等于把「这个邮箱存不存在」的探测口开回来）。
 */
export const requestResetCode = async (email: string): Promise<RequestResetCodeResult> => {
  // 每次重新发码都先清掉旧演示会话：上一轮演的不能被这一轮误用
  demoSession = null

  const result = await post(FORGOT_PATH, { email: email.trim(), mode: 'code' })
  if (result.ok) {
    return { ok: true, demo: false }
  }

  const reason = classifyRequestFailure(result.error)
  if (DEMO_MODE && (reason === 'not-enabled' || reason === 'network')) {
    demoSession = { email: email.trim() }
    return { ok: true, demo: true, demoReason: reason === 'network' ? 'unreachable' : 'not-enabled' }
  }
  return { ok: false, reason }
}

/**
 * 第二步：用验证码改密码。
 *
 * 真链路：`{email, code, new_password}`。成功也只表示**服务端受理了**（匿名流程没有会话可回查，
 * `CONSUME_EFFECT_POLICIES.resetPassword`）—— 真正的确认是「用新密码登录一次」，那是界面的事。
 *
 * 演示会话：**一个请求都不发**，只判「码是不是 123456」和「密码够不够长」，判完把会话销掉。
 * 返回 `demo: true` 让界面说「（演示）重置流程已走完，请用新密码登录」而不是「账号密码已改」。
 */
export const resetPasswordWithCode = async (
  email: string,
  code: string,
  newPassword: string
): Promise<ResetWithCodeResult> => {
  const session = demoSession
  if (session !== null && session.email === email.trim()) {
    if (code !== DEMO_CODE) {
      return { ok: false, reason: 'invalid-code' }
    }
    if (newPassword.length < MIN_RESET_PASSWORD_LENGTH) {
      return { ok: false, reason: 'weak-password' }
    }
    demoSession = null
    return { ok: true, demo: true }
  }

  const result = await post(RESET_PATH, {
    email: email.trim(),
    code,
    new_password: newPassword,
  })
  if (result.ok) {
    demoSession = null
    return { ok: true, demo: false }
  }
  return { ok: false, reason: classifyResetFailure(result.error) }
}
