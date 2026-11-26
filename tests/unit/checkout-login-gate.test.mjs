// [layer: unit | 依赖: 无（纯 Node；登录态用真 store 的内存态，付款副作用全是桩） | 耗时: <1s]
//
// 产品口径（2026-11-26）：**没登录不能去跳转支付链接** —— 点「购买 / 充值」不取地址、不开收款页
// （Web 不许开新标签、原生不许开 App 内 popover），改成弹一张「要先登录」的弹窗。
//
// 判据与顺序都住在 `src/components/consume/checkoutGate.ts`（纯函数 + 依赖注入），
// 组件那边（`BuyTab.openCheckout`）只是把真实依赖递进去。本文件钉四件事：
//
//   ① 未登录 → `needsLoginForCheckout()` 为 true；
//   ② 已登录 → false（登录后的付款链路一个字都不变）；
//   ③ 登录态**未知 / 加载中**（`authenticating`、`restored: false`、快照读不到）→ **按未登录处理**：
//      保守，绝不放行跳转 —— 宁可让用户多点一次「去登录」；
//   ④ 未登录时 `beginCheckout` 的**可观察后果**：一次 `pay-link` 都不发、一个占位页都不开、
//      只弹登录弹窗；已登录时三件事照旧发生，且**占位页仍在第一个 await 之前**开出来
//      （Web 的 `window.open` 脱离点击同步栈就会被拦，这条顺序不能被这次改动带坏）。
//
// 为什么不渲染 `BuyTab` 本身：`.tsx` 在裸 Node 里 import 不了（JSX 不在类型擦除范围内）。
// 所以「组件真的接上了闸门」用源码断言（⑤）钉，行为由 ④ 在真实现上跑一遍 ——
// 两边合起来才等价于「点了购买会发生什么」。
//
// 跑法：node tests/run-layer.mjs unit --only checkout-login-gate
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { resetAuthStore, setupAuthPanels } from '../helpers/auth-panels-env.mjs'

// 装配（`.js → .ts` 解析 + 浏览器全局 + 构建期注入值）必须在动态 import 被测源码之前跑完
const { zh } = await setupAuthPanels()

const gate = await import('../../src/components/consume/checkoutGate.ts')
const { en } = await import('../../src/i18n/en.ts')
const { getAuthSnapshot, useAuthStore } = await import('../../src/services/auth/store.ts')

const ROOT = new URL('../../', import.meta.url)
const read = (relative) => readFileSync(new URL(relative, ROOT), 'utf8')

/**
 * 只留代码行：注释里解释「旧写法是什么」是允许的，真写出来才算违规。
 * （`BuyTab` 的文件头为了讲清「为什么先同步占位」就写着 `await fetchPayLink()`。）
 */
const codeOnly = (text) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim()
      return !trimmed.startsWith('//') && !trimmed.startsWith('*')
    })
    .join('\n')

/** 一颗形状合法的 accessToken（`AuthSnapshot.token` 只给传输层拼 header 用，界面不读它） */
const token = (accessToken = 'at-gate-test') => ({ accessToken, tokenType: 'Bearer', expiresAt: null })

/** 「已登录」的写法照 store 的终态抄：`state` + `token` 两样都要有（见 checkoutGate 文件头） */
const signInStore = () => {
  resetAuthStore(useAuthStore)
  useAuthStore.setState({
    state: 'authenticated',
    token: token(),
    user: { id: 2, email: 'gate@mock.local', emailVerified: true },
    error: null,
    restored: true,
    submitting: false,
  })
}

// ─────────────────────────────────────────────── ① 未登录 → 必须拦 ──────────────

test('① 未登录：needsLoginForCheckout 为 true（真 store 初值就是这个状态）', () => {
  resetAuthStore(useAuthStore)
  const snapshot = getAuthSnapshot()
  assert.equal(snapshot.state, 'unauthenticated', '对照：store 复位后是「未登录」，这条断言不是空转')
  assert.equal(snapshot.token, null, '未登录时本来就没有凭据')
  assert.equal(gate.isCheckoutAuthenticated(snapshot), false, 'isCheckoutAuthenticated 不认未登录')
  assert.equal(gate.needsLoginForCheckout(snapshot), true, '→ 点「购买」必须先要求登录')
})

// ─────────────────────────────────────────────── ② 已登录 → 一个字都不变 ─────────

test('② 已登录：needsLoginForCheckout 为 false（登录后行为完全不变）', () => {
  signInStore()
  const snapshot = getAuthSnapshot()
  assert.equal(snapshot.state, 'authenticated', '对照：这次快照确实是已登录')
  assert.equal(gate.isCheckoutAuthenticated(snapshot), true, 'state + token 齐了 → 已登录')
  assert.equal(gate.needsLoginForCheckout(snapshot), false, '→ 放行，走原来的付款链路')
})

// ───────────────────── ③ 未知 / 加载中 → 按未登录处理（保守，绝不放行） ──────────

test('③ 登录态未知 / 加载中：一律按未登录处理，绝不放行跳转', () => {
  const UNKNOWN_SNAPSHOTS = [
    ['启动恢复中（authenticating + restored:false）', { state: 'authenticating', token: null, restored: false }],
    ['恢复跑完但仍无身份', { state: 'unauthenticated', restored: true }],
    ['凭据已失效（expired）', { state: 'expired', token: token('at-stale'), restored: true }],
    ['快照读不到（undefined）', undefined],
    ['快照为 null', null],
    ['空对象（没有 state 字段）', {}],
    ['state 是自己也不认识的值', { state: 'loading', token: token() }],
    ['说已登录但没凭据（token:null）', { state: 'authenticated', token: null }],
    ['说已登录但凭据是空串', { state: 'authenticated', token: token('') }],
    ['说已登录但凭据只有空白', { state: 'authenticated', token: token('   ') }],
  ]
  for (const [label, snapshot] of UNKNOWN_SNAPSHOTS) {
    assert.equal(
      gate.needsLoginForCheckout(snapshot),
      true,
      `${label} → 必须拦（保守口径：身份没确认就不许开出收款页）`
    )
  }
  // 真 store 里「恢复中」那一段也用真快照过一遍：`restoreAuth` 期间 state 就是 `authenticating`
  resetAuthStore(useAuthStore)
  useAuthStore.setState({ state: 'authenticating', restored: false })
  assert.equal(
    gate.needsLoginForCheckout(getAuthSnapshot()),
    true,
    'store 真的处于「恢复中」时同样拦（这条走的是真快照，不是手搓对象）'
  )
})

// ──────────── ④ 未登录时的可观察后果：零请求、零占位页、只弹登录弹窗 ────────────

/**
 * 假依赖：把 `beginCheckout` 会碰的每一样都换成记录器。
 *
 * `openPlaceholder` / `fetchLink` 就是「开新标签页」与「发 pay-link」这两件事的替身 ——
 * 它们被调用几次，就是用户看到几个标签页、网络里发出几条 `pay-link`。
 */
const stubDeps = ({ snapshot, record, link = { status: 'ok', url: 'https://wzyp.cn/shop/DIWOOHLR' } }) => ({
  readAuth: () => {
    record.push('readAuth')
    return snapshot
  },
  promptLogin: () => {
    record.push('promptLogin')
  },
  onProceed: () => {
    record.push('onProceed')
  },
  openPlaceholder: () => {
    record.push('openPlaceholder')
    return { tabId: 'fake-placeholder-tab' }
  },
  fetchLink: async () => {
    record.push('fetchLink')
    return link
  },
})

test('④ 未登录点「购买」：不发 pay-link、不开占位页，只弹登录弹窗', async () => {
  resetAuthStore(useAuthStore)
  const record = []
  const result = await gate.beginCheckout(stubDeps({ snapshot: getAuthSnapshot(), record }))

  assert.deepEqual(result, { action: 'login-required' }, '结论只有一种：先去登录')
  assert.deepEqual(record, ['readAuth', 'promptLogin'], '只读了登录态、只弹了弹窗 —— 没有别的副作用')
  assert.equal(
    record.filter((name) => name === 'openPlaceholder').length,
    0,
    '零个占位页：未登录用户不会看到新标签页（订单页也没被开出来）'
  )
  assert.equal(record.filter((name) => name === 'fetchLink').length, 0, '零次取地址：网络里没有 pay-link 请求')
  assert.equal('tab' in result, false, '不放行时连占位页句柄都不往外给（没有可关的东西）')
})

test('④-对照 已登录点「购买」：判定 → 忙碌态 → 占位页 → 取地址，顺序与改前一致', async () => {
  signInStore()
  const record = []
  const result = await gate.beginCheckout(stubDeps({ snapshot: getAuthSnapshot(), record }))

  assert.deepEqual(
    record,
    ['readAuth', 'onProceed', 'openPlaceholder', 'fetchLink'],
    '占位页仍排在取地址之前（Web 的 window.open 必须在点击同步栈里）'
  )
  assert.equal(result.action, 'proceed', '已登录 → 放行')
  assert.deepEqual(result.tab, { tabId: 'fake-placeholder-tab' }, '放行时把占位页句柄交回给组件（失败时要能关掉它）')
  assert.equal(result.link.status, 'ok', '放行时把取到的地址交回给组件（打开收款页用它）')
})

test('④-顺序 占位页在**第一个 await 之前**就开出来了（这条被改动带坏会让 Web 付款全弹窗拦截）', async () => {
  signInStore()
  const record = []
  let releaseLink
  const linkPromise = new Promise((resolve) => {
    releaseLink = resolve
  })
  // 不 await：只看「调用返回 promise 的那一瞬间」发生了哪些事
  const pending = gate.beginCheckout({
    ...stubDeps({ snapshot: getAuthSnapshot(), record }),
    fetchLink: () => {
      record.push('fetchLink')
      return linkPromise
    },
  })

  assert.deepEqual(
    record,
    ['readAuth', 'onProceed', 'openPlaceholder', 'fetchLink'],
    '同步段跑完：判定、忙碌态、占位页都在第一个 await 之前（此时地址还没回来）'
  )
  releaseLink({ status: 'ok', url: 'https://wzyp.cn/shop/DIWOOHLR' })
  assert.equal((await pending).action, 'proceed')
})

// ───────────────────── ⑤ 接线：组件真的把真依赖递给了闸门 ─────────────────────

test('⑤ BuyTab 接的是这道闸门：真依赖注入 + 登录弹窗 + 文案成对', () => {
  const buyTab = read('src/components/consume/BuyTab.tsx')
  const page = read('src/components/consume/AccountConsumePage.tsx')

  // 闸门在 openCheckout 的最前面：登录态就从 store 的只读口取（不猜字段）
  assert.equal(buyTab.includes('beginCheckout({'), true, 'openCheckout 走 checkoutGate.beginCheckout 这道闸门')
  assert.equal(buyTab.includes('readAuth: getAuthSnapshot'), true, '判定输入是 getAuthSnapshot()（唯一只读口）')
  assert.equal(
    buyTab.includes("from './checkoutGate.js'"),
    true,
    '判据只有一份：组件从 checkoutGate 取闸门，不在自己身上再写一份'
  )
  // 判据不许在组件里长第二份（注释里解释字段名是允许的，真写出来才算违规）
  const buyTabCode = codeOnly(buyTab)
  assert.equal(
    /state\s*===\s*'authenticated'/u.test(buyTabCode),
    false,
    '组件里不猜登录态字段（`state === authenticated` 只住在 checkoutGate）'
  )
  assert.equal(
    /token\s*(?:!==|===)\s*null/u.test(buyTabCode),
    false,
    '组件里不去看 token（凭据判定同样只住在 checkoutGate）'
  )

  // 取地址只能经由闸门的 deps：组件里不再有「直接 await 一次 fetchPayLink」的写法
  assert.equal(
    buyTab.includes('fetchLink: () => fetchPayLink(httpTransport)'),
    true,
    'pay-link 是注进闸门的，未登录时闸门根本不会调它'
  )
  assert.equal(buyTabCode.includes('await fetchPayLink('), false, '没有旁路的取地址写法（否则闸门形同虚设）')
  assert.equal(buyTab.includes('openPlaceholder: () =>'), true, '占位页也是注进闸门的（未登录时不会开出来）')

  // 弹窗：有稳定 testid、两个出口，且文案走 i18n
  for (const testId of [
    'account-consume-buy-login-prompt',
    'account-consume-buy-login',
    'account-consume-buy-login-cancel',
  ]) {
    assert.equal(buyTab.includes(`data-testid="${testId}"`), true, `登录弹窗要有 ${testId}（验收要点得到它）`)
  }
  assert.equal(buyTab.includes("t('oursPayLoginTitle')"), true, '标题走 i18n')
  assert.equal(buyTab.includes("t('oursPayLoginBody')"), true, '正文走 i18n')
  assert.equal(buyTab.includes("t('oursPayLoginAction')"), true, '主按钮「去登录」走 i18n')
  assert.equal(buyTab.includes("t('cancel')"), true, '次按钮复用既有「取消」词条，不新造一句')

  // 登录出口：外层递下来的 onNeedLogin（#608 那一套），没接时才退回设置里的账号页
  assert.equal(page.includes('<BuyTab onPurchased={backToCards} onNeedLogin={needLogin} />'), true, '页面把登录出口递给 BuyTab')
  assert.equal(buyTab.includes('openSettings('), true, '没接 onNeedLogin 时的退路是同一条落点（设置 → 账号页）')

  // 文案成对（`check-i18n` 的 R1/R4 之外，这里再钉一句「说的是登录」）
  for (const dictionary of [zh, en]) {
    for (const key of ['oursPayLoginTitle', 'oursPayLoginBody', 'oursPayLoginAction']) {
      assert.equal(typeof dictionary[key], 'string', `zh / en 都缺了 ${key}（成对新增）`)
      assert.notEqual(dictionary[key].trim(), '', `${key} 不许是空串`)
    }
  }
  assert.match(zh.oursPayLoginTitle, /登录/u, '中文标题必须说「登录」')
  assert.match(zh.oursPayLoginBody, /登录/u, '中文正文必须说「登录」')
  assert.match(en.oursPayLoginTitle, /sign in/iu, '英文标题必须说 sign in')
})
