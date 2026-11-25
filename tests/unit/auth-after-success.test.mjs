// [layer: unit | L1 流程级 | 依赖: 无（纯 Node + 假 source / 假 transport / 假存储） | 产品要求 2026-11-25]
//
// **注册成功、重置密码成功之后都必须回到「登录表单」**（不是直接登录、也不是停在注册 / 重置那一步）。
//
// 产品原话：「补充一个 ui 逻辑，注册或者忘记密码结束后回到登录界面」。落到这一层就是两条口径：
//
//   ① **注册成功** → `mode: 'login'` + 邮箱预填 + 密码 / 确认密码 / 验证码清空 +
//      notice = `authRegisterDonePleaseLogin`（「注册成功，请登录」）；
//   ② **重置密码成功** → 同样回 `mode: 'login'` + 邮箱预填 + 清掉重置时的中间态 +
//      notice = `authResetDonePleaseLogin`（「密码已重置，请用新密码登录」）；
//   ③ 两条路径**都不许产生 session 写入**：注册的副产物（服务端回的 token）客户端不接管，
//      登录这件事只由用户自己点「登录」触发（`signIn` 才是唯一写会话的显式路径）。
//
// 为什么这条用例必须 import 真代码（而不是对着桩断言）：`settingsAuthCardModel.ts` 的 reducer /
// 提交判定就是界面行为的**唯一**判据，`services/auth/store.ts` 的 `signUp` 就是 token 落盘的唯一
// 位置。桩里写一份「期望的语义」只能证明桩自洽 —— 这一单改的正是那两处真实现。
//
// 现状（改动前）的语义，也就是本用例第一次跑会红的那些断言：
//   · `submitAuthCard` 注册成功只回 `{type:'form-submitted'}` → 卡片停在**注册** tab；
//   · `store.signUp` 成功即 `applySession(...)` → 落盘 token + `state: 'authenticated'` + 触发
//     会话建立钩子（于是 `AuthGate` 直接渲染 children、设置卡直接切到已登录视图）；
//   · 重置成功挂的是旧 key `settingsAuthResetDone`，且**从注册 tab 进来的**忘记密码走完两步会
//     回到**注册** tab（`step: 'form'` 只换页、不换 mode）。
//
// 浏览器侧的同一件事（dev server 上桩 `POST /api/v1/auth/register` / `forgot-password` + `reset-password`
// 成功，点真按钮）留了两组截图作证，改动前 / 后各一组：
//   docs/ui/authflow-before-register-390.png         注册成功后**直接进了已登录的账号页**（改动前）
//   docs/ui/authflow-before-reset-390.png            重置成功后回登录表单（改动前，旧文案 + 只对登录 tab 成立）
//   docs/ui/authflow-before-reset-from-register-390.png  从**注册 tab** 点忘记密码走完两步 → 停在注册 tab（改动前的坑）
//   docs/ui/authflow-after-register-390.png          注册成功 → 登录表单 + 邮箱预填 +「注册成功，请登录」
//   docs/ui/authflow-after-reset-390.png             重置成功 → 登录表单 + 邮箱预填 +「密码已重置，请用新密码登录」
//
//   node tests/unit/auth-after-success.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  createFakeTransport,
  createTokenStorage,
  resetAuthStore,
  setupAuthPanels,
} from '../helpers/auth-panels-env.mjs'

const { translate, ButtonStub, classNames, markupOf, hasTestId, zh } = await setupAuthPanels()

const { createElement } = await import('react')
const {
  initialAuthCardState,
  reduceAuthCard,
  SettingsAuthCardView,
  submitAuthCard,
} = await import('../../src/components/consume/settingsAuthCardModel.ts')
const store = await import('../../src/services/auth/store.ts')
const { en } = await import('../../src/i18n/en.ts')

/** 两枚眼睛图标的替身（真机是 `base/icons.tsx` 的 SVG；这里只要渲染不炸） */
const EyeOpen = () => createElement('svg', { 'data-icon': 'eye-open' })
const EyeClosed = () => createElement('svg', { 'data-icon': 'eye-closed' })

const EMAIL = 'return-to-login@example.invalid'
const PASSWORD = 'brand-new-password'

/** 假后端：注册 / 登录都答成功（只记调用；本用例关心的不是请求，而是成功之后停在哪儿） */
const fakeSource = (outcome = { ok: true }) => {
  const calls = { signIn: [], signUp: [], forgotPassword: [] }
  return {
    calls,
    source: {
      signIn: async (input) => {
        calls.signIn.push(input)
        return outcome
      },
      signUp: async (input) => {
        calls.signUp.push(input)
        return outcome
      },
      forgotPassword: async (input) => {
        calls.forgotPassword.push(input)
        return { ok: true, data: undefined }
      },
    },
  }
}

/** 一次「派事件」= 依次过 reducer（界面里 `dispatch` 的顺序就是这样） */
const applyEvents = (state, events) => events.reduce(reduceAuthCard, state)

/** 注册 tab 的现场：邮箱 / 密码 / 确认密码 / 验证码都填好（提交前的真实状态） */
const registerFilledState = () => {
  let state = initialAuthCardState('register')
  state = reduceAuthCard(state, { type: 'email', value: EMAIL })
  state = reduceAuthCard(state, { type: 'password', value: PASSWORD })
  state = reduceAuthCard(state, { type: 'confirm', value: PASSWORD })
  state = reduceAuthCard(state, { type: 'verify-code', value: '123456' })
  return state
}

// ------------------------------------------------------------------ ① 注册成功 → 回登录表单

test('[①] 注册成功 → 卡片回到「登录」表单：mode=login + 邮箱预填 + 密码/确认密码/验证码清空', async () => {
  const { source, calls } = fakeSource()
  const events = await submitAuthCard(source, registerFilledState(), { submitting: false, registration: 'enabled' })
  assert.equal(calls.signUp.length, 1, '注册请求发出 1 次（前置条件）')

  const next = applyEvents(registerFilledState(), events)
  assert.equal(next.mode, 'login', '注册成功之后必须切回登录 tab（不是停在注册表单，也不是直接进主界面）')
  assert.equal(next.step, 'form', '停在表单页（不在找回密码小页里）')
  assert.equal(next.email, EMAIL, '邮箱要预填：用户刚打过一遍，不该让他再打')
  assert.equal(next.password, '', '密码必须清空（注册时那串密码不能顺手变成登录密码）')
  assert.equal(next.confirmPassword, '', '确认密码清空')
  assert.equal(next.verifyCode, '', '验证码清空（它只属于那一次注册）')
  assert.equal(next.notice, 'authRegisterDonePleaseLogin', '成功提示是新 key（原文：注册成功，请登录）')
})

test('[①] 注册成功之后**不**产生 session 写入：store 仍是未登录，也不触发会话建立钩子', async () => {
  resetAuthStore(store.useAuthStore)
  const storage = createTokenStorage()
  const { transport, calls } = createFakeTransport({
    register: {
      ok: true,
      data: {
        token: { accessToken: 'new-access', refreshToken: 'new-refresh', tokenType: 'Bearer', expiresAt: null },
        user: { id: 9, email: EMAIL, emailVerified: true },
      },
    },
  })
  store.setAuthTokenStorage(storage.storage)
  store.setAuthTransport(transport)
  const established = []
  store.setSessionEstablishedHook((reason) => established.push(reason))

  try {
    // 界面的两个注册入口都走这条：注册成功 ≠ 登录成功
    const result = await store.useAuthStore.getState().signUp({ email: EMAIL, password: PASSWORD }, { autoSignIn: false })
    assert.equal(result.ok, true, '注册本身是成功的（服务端受理了）')
    assert.equal(calls.register.length, 1, '只发一次注册请求')
    assert.equal(storage.writes.length, 0, `注册成功不许把 token 落盘（实际写入：${JSON.stringify(storage.writes)}）`)
    assert.equal(store.useAuthStore.getState().state, 'unauthenticated', '注册成功之后仍然是未登录态')
    assert.equal(store.useAuthStore.getState().token, null, 'store 里不许留注册回的 token')
    assert.deepEqual(established, [], '不许通知会话建立钩子（自动领 Key 只在**显式登录**时发生）')
    assert.equal(calls.login.length, 0, '客户端不许「补偿式」自己登一次（产品要求用户自己登录）')
  } finally {
    store.setSessionEstablishedHook(null)
    store.setAuthTransport(null)
    store.setAuthTokenStorage(null)
    resetAuthStore(store.useAuthStore)
  }
})

test('[①] 显式登录仍然照旧建立会话（这条通路没有被改坏）', async () => {
  resetAuthStore(store.useAuthStore)
  const storage = createTokenStorage()
  const { transport, calls } = createFakeTransport({
    login: {
      ok: true,
      data: {
        token: { accessToken: 'login-access', refreshToken: 'login-refresh', tokenType: 'Bearer', expiresAt: null },
        user: { id: 9, email: EMAIL, emailVerified: true },
      },
    },
  })
  store.setAuthTokenStorage(storage.storage)
  store.setAuthTransport(transport)

  try {
    const result = await store.useAuthStore.getState().signIn({ email: EMAIL, password: PASSWORD })
    assert.equal(result.ok, true)
    assert.equal(calls.login.length, 1)
    assert.equal(store.useAuthStore.getState().state, 'authenticated', '登录成功就是已登录（用户的显式动作）')
    assert.equal(storage.writes.length, 1, '登录成功才写会话')
  } finally {
    store.setAuthTransport(null)
    store.setAuthTokenStorage(null)
    resetAuthStore(store.useAuthStore)
  }
})

// ------------------------------------------------------------------ ② 重置成功 → 回登录表单

test('[②] 重置密码成功 → 回登录表单：mode=login + 邮箱预填 + 清掉重置中间态 + 新提示 key', async () => {
  // 现场：用户是从**注册** tab 点「忘记密码」进来的（改动前的坑就在这里 —— 只换 step 不换 mode，
  // 走完两步会回到注册表单），密码框里还留着注册时打的字
  let state = registerFilledState()
  state = reduceAuthCard(state, { type: 'step', step: 'forgot' })
  // `ResetPasswordPage` 走完两步 → 界面派这一个事件（邮箱以重置页里那个为准：用户可能改过）
  const next = reduceAuthCard(state, {
    type: 'back-to-login',
    notice: 'authResetDonePleaseLogin',
    email: EMAIL,
  })

  assert.equal(next.mode, 'login', '重置成功之后必须落在**登录**表单上（从注册 tab 进来也一样）')
  assert.equal(next.step, 'form', '回到表单页（不在找回密码小页里）')
  assert.equal(next.email, EMAIL, '邮箱预填（重置页里那个邮箱）')
  assert.equal(next.password, '', '密码清空：旧密码已经作废，新密码要用户自己打一次')
  assert.equal(next.confirmPassword, '', '确认密码清空')
  assert.equal(next.verifyCode, '', '验证码清空')
  assert.equal(next.notice, 'authResetDonePleaseLogin', '提示 key 是新的那条（原文：密码已重置，请用新密码登录）')
  assert.equal(next.forgot.outcome, null, '上一次的「已发送」结局跟着清掉')
  assert.equal(next.submitCooldown, 0, '冷却不跨页带过去')
})

test('[②] 重置成功之后**不**产生 session 写入（重置 ≠ 登录）', async () => {
  resetAuthStore(store.useAuthStore)
  const storage = createTokenStorage()
  store.setAuthTokenStorage(storage.storage)
  try {
    // 重置链路的全部动作都在 `ResetPasswordPage` + 这个 reducer 里，一条都不碰 store
    const state = reduceAuthCard(initialAuthCardState('login'), {
      type: 'back-to-login',
      notice: 'authResetDonePleaseLogin',
      email: EMAIL,
    })
    assert.equal(state.password, '')
    assert.equal(storage.writes.length, 0, '重置成功不许写任何凭据')
    assert.equal(store.useAuthStore.getState().state, 'unauthenticated', '重置成功之后仍然是未登录态')
  } finally {
    store.setAuthTokenStorage(null)
    resetAuthStore(store.useAuthStore)
  }
})

// ------------------------------------------------------------------ ③ 文案：新 key 成对，且真的上屏

test('[③] 两条成功提示是新加的成对 key（zh + en），旧 key 不再是这两条链路的终点文案', () => {
  assert.equal(zh.authRegisterDonePleaseLogin, '注册成功，请登录')
  assert.equal(en.authRegisterDonePleaseLogin, 'Registration complete — please sign in.')
  assert.equal(zh.authResetDonePleaseLogin, '密码已重置，请用新密码登录')
  assert.equal(en.authResetDonePleaseLogin, 'Password reset — please sign in with your new password.')
})

test('[③] 回登录表单之后，那句提示真的渲染在卡上（不是只改了状态）', () => {
  const state = reduceAuthCard(initialAuthCardState('register'), {
    type: 'back-to-login',
    notice: 'authRegisterDonePleaseLogin',
    email: EMAIL,
  })
  const markup = markupOf(
    SettingsAuthCardView({
      t: translate,
      c: classNames,
      Button: ButtonStub,
      EyeIcon: EyeOpen,
      EyeOffIcon: EyeClosed,
      state,
      submitting: false,
      sendingCode: false,
      countdown: 0,
      errorKey: null,
      registrationGate: 'enabled',
      flagsReadFailed: false,
      onRetryFlags() {},
      onEvent() {},
      onSubmit() {},
      onSendCode() {},
      onForgotSubmit() {},
      onSkip() {},
    })
  )
  // 登录 tab（不是注册）：页面上没有「确认密码 / 验证码」那两栏，主按钮是「登录」
  assert.equal(hasTestId(markup, 'settings-auth-confirm'), false, '登录 tab 不该有确认密码')
  assert.equal(hasTestId(markup, 'settings-auth-code'), false, '登录 tab 不该有验证码')
  // 主按钮的文案就是「登录」（按标签里的文本判：`data-testid` 后面的属性不值一提）
  assert.match(markup, /data-testid="settings-auth-submit"[^>]*>\s*登录\s*</u, '主按钮回到「登录」')
  assert.equal(hasTestId(markup, 'auth-segmented-register'), true, '分段控件仍在（还能切回注册）')
  assert.match(markup, /注册成功，请登录/u, '成功提示命中 zh 文案')
  assert.match(markup, new RegExp(EMAIL, 'u'), '邮箱预填在输入框的 value 上')
})

// ------------------------------------------------------------------ ④ 三个入口的接线（源码级）
//
// `SettingsAuthCard` 是**线上**那条路径（设置 → 数据管理 → 账户与消费 → 账号），能拿浏览器截图；
// 另外两个入口（`AuthGate` / `LoginPage` 的「忘记密码」返回链）在当前产物里没有挂载点
// （`#608` 拆掉登录墙之后 `AccountPanel` 不再被任何入口挂载），没法点着验 —— 所以这里把它们的
// 接线钉在源码上：`autoSignIn: false`（注册不建会话）与「回登录 + 预填邮箱 + 新提示 key」两条，
// 谁把它们改回去都会在这里红，而不是靠「读过一遍代码」。

const { readFileSync } = await import('node:fs')
const path = await import('node:path')
const ROOT = path.resolve(import.meta.dirname, '../..')
const sourceOf = (file) => readFileSync(path.join(ROOT, file), 'utf8')

test('[④] 设置卡：注册不建会话，两条链路都派 `back-to-login` + 新提示 key', () => {
  const src = sourceOf('src/components/consume/SettingsAuthCard.tsx')
  assert.match(
    src,
    /signUp\(input, \{ autoSignIn: false \}\)/u,
    '设置卡的注册必须传 `{ autoSignIn: false }`（否则注册成功就进了主界面）'
  )
  assert.match(
    src,
    /type: 'back-to-login', notice: 'authResetDonePleaseLogin', email/u,
    '重置成功必须派 `back-to-login`（不是只切 step），并带上重置页里那个邮箱'
  )
})

test('[④] AuthGate：注册成功与重置成功都回登录表单，且登录页带预填邮箱', () => {
  const src = sourceOf('src/components/auth/AuthGate.tsx')
  assert.match(src, /\{ autoSignIn: false \}/u, 'AuthGate 的注册也必须传 `{ autoSignIn: false }`')
  assert.match(
    src,
    /backToLogin\(values\.email\.trim\(\), 'authRegisterDonePleaseLogin'\)/u,
    '注册成功 → 回登录表单 + 邮箱预填 + `authRegisterDonePleaseLogin`'
  )
  assert.match(
    src,
    /backToLogin\(resetEmail, 'authResetDonePleaseLogin'\)/u,
    '重置成功 → 回登录表单 + 邮箱预填 + `authResetDonePleaseLogin`'
  )
  assert.match(src, /initialEmail=\{email\}/u, '登录页 / 重置页都要拿到预填邮箱')
})

test('[④] store：注册的会话落地只在 `autoSignIn !== false` 这条分支里', () => {
  const src = sourceOf('src/services/auth/store.ts')
  const at = src.indexOf('options.autoSignIn === false')
  assert.ok(at > 0, 'store.signUp 必须认 `autoSignIn` 选项')
  const applyAt = src.indexOf("applySession(result.data, 'register')")
  assert.ok(applyAt > at, 'applySession + reason=register 必须排在那条「不建会话」的分支之后')
})
