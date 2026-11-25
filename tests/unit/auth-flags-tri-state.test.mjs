// [layer: unit | L1 流程级 | 依赖: 无（纯 Node + 假 settings reader + renderToStaticMarkup） | 线上事故 2026-11-24]
//
// **注册开关三态**：`unknown`（没读到）/ `enabled` / `disabled`（服务端真的说了 false）。
//
// 事故现场（Android APK v2.0.0）：服务端 `settings/public` 回了 502 的那一次，客户端把「没读到」
// 当成「服务端关了注册」→ 注册被**本地**静默拦掉，屏幕上还写着「注册暂未开放，请稍后或联系管理员」，
// 用户以为是我们关了注册（服务端那天 `REGISTRATION_DISABLED` 是 0 条、注册接口大量 200）。
//
// 本文件钉住的六条（每条都断言「用户能不能提交」，不是只断言一个布尔值）：
//   T1 `{registration_enabled:true}`  → `enabled`，注册真的发得出去
//   T2 `{registration_enabled:false}` → `disabled`，出现 `sub2authRegistrationDisabled`、一个请求都不发
//   T3 `{}` / `{code:0,message:'ok',data:null}` / 错误信封 → `unknown`：**没有**那句文案、**不**拦截
//   T4 读取抛错（网络）→ `unknown` 且**发生了重试**（调用次数 ≥2，间隔落在 300~800ms）
//   T5 4xx → **不重试**（调用次数 == 1），且同样是 `unknown`
//   T6 两次都失败 → `unknown`，再点注册仍走 `signUp`（判定交给服务端）
//
// 另有一条「对照」：把 T3 的回包换成一个真的 `false`（T2），文案就出现了 —— 证明 T3 的绿不是空转，
// 而是「三态」真的把这两条路分开了。
//
// 浏览器验收（Playwright，真 dev server + `page.route` 桩 `settings/public`，三组断言全绿）存证：
//   docs/ui/register-flags-502.png       —— 502 时：没有「注册暂未开放」，只有「功能开关读取失败，点此重试」，注册按钮可点
//   docs/ui/register-flags-disabled.png  —— 服务端真的回 false 时：那句「注册暂未开放，请稍后或联系管理员」才出现
//
//   node --test tests/unit/auth-flags-tri-state.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { setupAuthPanels } from '../helpers/auth-panels-env.mjs'

const { ButtonStub, classNames, hasTestId, markupOf, textOf, translate, zh } = await setupAuthPanels()

const {
  FLAGS_RETRY,
  loadAuthFlags,
  parseAuthFlagsSnapshot,
  setPublicSettingsReader,
  useAuthFlags,
} = await import('../../src/services/auth/flags.ts')
const {
  initialAuthCardState,
  reduceAuthCard,
  registrationGateOfFlags,
  SettingsAuthCardView,
  submitAuthCard,
} = await import('../../src/components/consume/settingsAuthCardModel.ts')

/** 事故里那句误导文案（**只**允许在 `disabled` 时出现） */
const DISABLED_TEXT = zh.sub2authRegistrationDisabled
/** 开关没读到时的可重试行 */
const RETRY_TEXT = zh.settingsAuthFlagsRetry

/** 不真等：单测不该为了退避睡掉 1 秒 */
const noSleep = async () => {}

/**
 * 读一次开关（用真代码）。
 *
 * `retries: 0` 是绝大多数用例的口径 —— 它们测的是「解析 / 判据」，不该被退避拖慢；
 * T4 / T5 / T6 才显式注入 `sleep` + 计数 reader 来钉重试次数与间隔。
 */
const loadWith = (reader, options = {}) => {
  setPublicSettingsReader(reader)
  return loadAuthFlags({ retries: 0, sleep: noSleep, ...options })
}

/** 计数 reader：`fail` 决定第 N 次调用怎么应答（可以让前两次失败、第三次成功） */
const countingReader = (fail) => {
  const calls = []
  const reader = async () => {
    calls.push(calls.length + 1)
    return fail(calls.length)
  }
  return { calls, reader }
}

const networkError = () => {
  const error = new Error('settings/public unreachable')
  error.name = 'TypeError'
  return error
}

/** 带 HTTP 状态的错误（4xx 不许重试的判据就靠这个字段） */
const httpError = (status) => Object.assign(new Error(`HTTP ${status}`), { status })

const fakeSource = () => {
  const calls = { signUp: [], signIn: [], forgotPassword: [] }
  const source = {
    signUp: async (input) => {
      calls.signUp.push(input)
      return { ok: true, data: { id: 'u1' } }
    },
    signIn: async (input) => {
      calls.signIn.push(input)
      return { ok: true, data: { id: 'u1' } }
    },
    forgotPassword: async (input) => {
      calls.forgotPassword.push(input)
      return { ok: true, data: undefined }
    },
  }
  return { calls, source }
}

/** 注册 tab + 三个都填好（本地校验能过，唯一变量只剩「开关」） */
const registerState = () => {
  const filled = [
    { type: 'email', value: 'tri-state@example.com' },
    { type: 'password', value: 'abcd1234' },
    { type: 'confirm', value: 'abcd1234' },
  ]
  return filled.reduce((state, event) => reduceAuthCard(state, event), initialAuthCardState('register'))
}

/** 走容器那条真路径：从 flags store 取三态，再交给 `submitAuthCard` */
const submitFromStore = (source) =>
  submitAuthCard(source, registerState(), {
    submitting: false,
    registration: registrationGateOfFlags(useAuthFlags.getState()),
  })

const renderCard = ({ gate, readFailed }) =>
  markupOf(
    SettingsAuthCardView({
      t: translate,
      c: classNames,
      Button: ButtonStub,
      EyeIcon: () => null,
      EyeOffIcon: () => null,
      state: registerState(),
      submitting: false,
      sendingCode: false,
      countdown: 0,
      errorKey: null,
      registrationGate: gate,
      flagsReadFailed: readFailed,
      onRetryFlags() {},
      onEvent() {},
      onSubmit() {},
      onSendCode() {},
      onForgotSubmit() {},
      onSkip() {},
    })
  )

// --------------------------------------------------------------------------- T1 / T2

test('T1 `{registration_enabled:true}` → enabled，注册真的发得出去', async () => {
  await loadWith(async () => ({ registration_enabled: true, email_verify_enabled: true }))
  const state = useAuthFlags.getState()
  assert.equal(state.registration, 'enabled')
  assert.equal(state.loaded, true)
  assert.equal(state.readFailed, false)
  assert.equal(state.registrationEnabled, true)

  const { calls, source } = fakeSource()
  const events = await submitFromStore(source)
  assert.equal(calls.signUp.length, 1, 'enabled 时必须真的发出注册请求')
  // 产品口径 2026-11-25：注册成功回登录表单（不是停在注册 tab）—— 本用例只关心「发得出去」，
  // 事件的具体形状由 `tests/unit/auth-after-success.test.mjs` 负责
  assert.deepEqual(events, [
    { type: 'back-to-login', notice: 'authRegisterDonePleaseLogin', email: 'tri-state@example.com' },
  ])

  // 视图侧：没有「注册暂未开放」，也没有「读取失败」
  const markup = renderCard({ gate: state.registration, readFailed: state.readFailed })
  assert.equal(markup.includes(DISABLED_TEXT), false, 'enabled 时不许出现「注册暂未开放」')
  assert.equal(hasTestId(markup, 'settings-auth-flags-retry'), false, 'enabled 时不该有「点此重试」')
})

test('T2 `{registration_enabled:false}` → disabled：出现那句文案，且一个注册请求都不发', async () => {
  await loadWith(async () => ({ registration_enabled: false }))
  const state = useAuthFlags.getState()
  assert.equal(state.registration, 'disabled', '服务端**真的**回了 false，才是 disabled')
  assert.equal(state.readFailed, false, '读到了（哪怕是 false）就不算读取失败')

  const { calls, source } = fakeSource()
  const events = await submitFromStore(source)
  assert.equal(calls.signUp.length, 0, 'disabled 时不许发注册请求（本地就拦）')
  assert.deepEqual(events, [{ type: 'notice', notice: 'sub2authRegistrationDisabled' }])

  // 那句话真的上屏了，而且是**那条**文案
  const noticeMarkup = markupOf(
    SettingsAuthCardView({
      t: translate,
      c: classNames,
      Button: ButtonStub,
      EyeIcon: () => null,
      EyeOffIcon: () => null,
      state: reduceAuthCard(registerState(), events[0]),
      submitting: false,
      sendingCode: false,
      countdown: 0,
      errorKey: null,
      registrationGate: state.registration,
      flagsReadFailed: state.readFailed,
      onRetryFlags() {},
      onEvent() {},
      onSubmit() {},
      onSendCode() {},
      onForgotSubmit() {},
      onSkip() {},
    })
  )
  assert.equal(hasTestId(noticeMarkup, 'settings-auth-notice'), true)
  assert.equal(textOf(noticeMarkup, 'settings-auth-notice').includes(DISABLED_TEXT), true)
  assert.equal(textOf(noticeMarkup, 'settings-auth-notice').includes(RETRY_TEXT), false, '读到了开关时不许说「读取失败」')
})

// --------------------------------------------------------------------------- T3

const UNKNOWN_SHAPES = [
  { label: '字段缺失（空对象）', raw: {} },
  { label: '成功信封但 data 是 null', raw: { code: 0, message: 'ok', data: null } },
  {
    label: '错误信封（业务码 + 没有开关字段）',
    raw: { code: 'REGISTRATION_DISABLED', message: 'registration is currently disabled' },
  },
  { label: '非布尔（"true" / 1 都不算读到）', raw: { registration_enabled: 'true', email_verify_enabled: 1 } },
]

test('T3 字段缺失 / data:null / 错误信封 → unknown：不出现该文案、也不拦注册', async (t) => {
  for (const row of UNKNOWN_SHAPES) {
    await t.test(row.label, async () => {
      // 解析层：这一份回包只配得到 `unknown`
      assert.equal(parseAuthFlagsSnapshot(row.raw).registration, 'unknown')

      await loadWith(async () => row.raw)
      const state = useAuthFlags.getState()
      assert.equal(state.registration, 'unknown', `${row.label} 必须落 unknown（不许当成关闭）`)
      assert.equal(state.loaded, false, '没读到 = loaded:false')
      assert.equal(state.readFailed, true, '试过但没拿到 → 界面给「点此重试」')
      assert.equal(state.registrationEnabled, false, '布尔镜像仍是保守 false（它只决定显隐，不决定拦不拦）')

      // 提交层：**不拦**，走 signUp（交给服务端判）
      const { calls, source } = fakeSource()
      const events = await submitFromStore(source)
      assert.equal(calls.signUp.length, 1, `${row.label} 时注册必须照常发出去（不能本地拦）`)
      // 注册成功 → 回登录表单（产品口径 2026-11-25），见 `tests/unit/auth-after-success.test.mjs`
      assert.deepEqual(events, [
        { type: 'back-to-login', notice: 'authRegisterDonePleaseLogin', email: 'tri-state@example.com' },
      ])

      // 视图层：没有「注册暂未开放」，只有一行可重试提示
      const markup = renderCard({ gate: state.registration, readFailed: state.readFailed })
      assert.equal(markup.includes(DISABLED_TEXT), false, `${row.label} 时**不许**出现「注册暂未开放」`)
      assert.equal(hasTestId(markup, 'settings-auth-flags-retry'), true, '要给一个可重试的提示')
      assert.equal(textOf(markup, 'settings-auth-flags-retry').includes(RETRY_TEXT), true)
    })
  }
})

test('T3 对照：同样一条「没有开关字段」的回包，只要多一个 false 就变成 disabled（三态不是摆设）', async () => {
  await loadWith(async () => ({}))
  const unknown = useAuthFlags.getState().registration
  const markupUnknown = renderCard({ gate: unknown, readFailed: true })

  await loadWith(async () => ({ registration_enabled: false }))
  const disabled = useAuthFlags.getState().registration
  const markupDisabled = renderCard({
    gate: disabled,
    readFailed: useAuthFlags.getState().readFailed,
  })

  assert.equal(unknown, 'unknown')
  assert.equal(disabled, 'disabled')
  assert.equal(markupUnknown.includes(DISABLED_TEXT), false)
  assert.equal(markupDisabled.includes(RETRY_TEXT), false)
  assert.notEqual(unknown, disabled, '「没读到」与「服务端说关」必须是两个状态')
})

// --------------------------------------------------------------------------- T4 / T5 / T6

test('T4 读取抛错（网络）→ unknown，且真的重试了（次数 ≥2，间隔 300~800ms）', async () => {
  const { calls, reader } = countingReader(() => {
    throw networkError()
  })
  const delays = []
  setPublicSettingsReader(reader)
  await loadAuthFlags({
    sleep: async (ms) => {
      delays.push(ms)
    },
    random: () => 0.5,
  })

  const state = useAuthFlags.getState()
  assert.equal(state.registration, 'unknown')
  assert.equal(state.readFailed, true)
  assert.ok(calls.length >= 2, `网络错误必须重试（实际只调用了 ${calls.length} 次）`)
  assert.equal(calls.length, 1 + FLAGS_RETRY.retries, `最多重试 ${FLAGS_RETRY.retries} 次（合计 ${1 + FLAGS_RETRY.retries}）`)
  assert.equal(delays.length, FLAGS_RETRY.retries, '每次重试前都要退避')
  for (const ms of delays) {
    assert.ok(ms >= 300 && ms <= 800, `退避要落在 300~800ms（实际 ${ms}ms）`)
  }
  // 真有抖动：两次间隔不该是同一条数
  assert.notEqual(delays[0], delays[1], '退避要带抖动，不能两次一样')

  // 失败结果不许当成「关闭」：注册照常提交
  const { calls: sent, source } = fakeSource()
  await submitFromStore(source)
  assert.equal(sent.signUp.length, 1, '重试耗尽也不能拿失败结果拦人')
})

test('T5 4xx（非 5xx）→ 不重试（调用次数 == 1），状态仍是 unknown', async () => {
  const cases = [
    { label: '抛错带 status:404', reader: () => { throw httpError(404) }, options: {} },
    {
      label: '不抛错但交回 ok:false（error.status:403）',
      reader: async () => ({ ok: false, error: { status: 403, kind: 'http' } }),
      options: { retries: FLAGS_RETRY.retries },
    },
  ]
  for (const row of cases) {
    const { calls, reader } = countingReader(row.reader)
    const delays = []
    setPublicSettingsReader(reader)
    await loadAuthFlags({
      retries: FLAGS_RETRY.retries,
      sleep: async (ms) => {
        delays.push(ms)
      },
      ...row.options,
    })
    assert.equal(calls.length, 1, `${row.label}：4xx 不该重试（实际 ${calls.length} 次）`)
    assert.deepEqual(delays, [], `${row.label}：4xx 不该有退避`)
    assert.equal(useAuthFlags.getState().registration, 'unknown')
  }
})

test('T6 两次都失败 → unknown，再点注册不会被本地拦（真的走 signUp）', async () => {
  const { calls, reader } = countingReader(() => {
    throw networkError()
  })
  setPublicSettingsReader(reader)
  await loadAuthFlags({ sleep: noSleep })

  const state = useAuthFlags.getState()
  assert.equal(state.registration, 'unknown')
  assert.equal(state.readFailed, true)

  // 「再点注册」= 用户没点「重试」直接提交：判定交给服务端
  const { calls: sent, source } = fakeSource()
  await submitFromStore(source)
  assert.equal(sent.signUp.length, 1, '**不许**本地拦截：真关了服务端会回 403 REGISTRATION_DISABLED')
  assert.equal(sent.signIn.length, 0)

  // 点了「重试」并把开关读回来：三态跟着变，注册恢复正常
  setPublicSettingsReader(async () => ({ registration_enabled: true }))
  await loadAuthFlags({ retries: 0, sleep: noSleep })
  assert.equal(useAuthFlags.getState().registration, 'enabled')
  assert.equal(useAuthFlags.getState().readFailed, false, '读到了就把「重试提示」收起来')

  // 收尾：别把假 reader 留给同进程的其他用例
  setPublicSettingsReader(null)
})

// ─────────────────────────────────────────────────────────────────────────────
// T13：reader 必须透传**原始对象**（不能是归一化后的 ConsumePublicSettings）
//
// 线上事故的最后一段：`getPublicSettings()` 用 `bool(raw.x)` 把「字段缺失」压成 false，
// 于是「服务端没给这个字段」被读成「服务端明确说关闭」。这两条钉住 reader 这一层不丢信息。
// ─────────────────────────────────────────────────────────────────────────────
test('T13 reader 透传原始对象：字段缺失 → unknown（不再被归一化成 disabled）', async () => {
  const { createPublicSettingsReader } = await import('../../src/services/auth/transport.ts')
  const reader = createPublicSettingsReader({
    http: { call: async () => ({ ok: true, data: { unrelated: 1 } }) },
  })
  const raw = await reader()
  assert.deepEqual(raw, { unrelated: 1 }, 'reader 不许做字段归一化')
  assert.equal(parseAuthFlagsSnapshot(raw).registration, 'unknown', '缺字段 = 没读到，不是"服务端说关"')
})

test('T14 传递链路：reader → snapshot 三态都对', async () => {
  const { createPublicSettingsReader } = await import('../../src/services/auth/transport.ts')
  const cases = [
    [{ registration_enabled: true }, 'enabled'],
    [{ registration_enabled: false }, 'disabled'],
    [{}, 'unknown'],
    [{ data: { registration_enabled: true } }, 'enabled'],
  ]
  for (const [data, expected] of cases) {
    const reader = createPublicSettingsReader({ http: { call: async () => ({ ok: true, data }) } })
    assert.equal(parseAuthFlagsSnapshot(await reader()).registration, expected, JSON.stringify(data))
  }
  const failing = createPublicSettingsReader({ http: { call: async () => ({ ok: false, error: { status: 502 } }) } })
  assert.equal(await failing(), null, '传输失败给 null')
  assert.equal(parseAuthFlagsSnapshot(await failing()).registration, 'unknown')
})
