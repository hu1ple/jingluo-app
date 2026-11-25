// [layer: integration | 依赖: playwright + chromium + 标准产物（runner 注入 APP_URL） | 耗时: <1 分钟]
//
// 「自有渠道」的钱入口 —— 旧 `OursServicesDialog` 退役后的**渠道门禁 + 新页面上屏**验收（#166 / #562）。
//
// 历史：#21 时这个文件验的是 `OursServicesDialog` 本体（设备码 / 领取 / 额度 / 邀请 / 兑换 / 购买，
// 十几个小节 556 行）。#482/#487 把设置页的钱入口并成「账户与消费」一页四个 tab，#561 删掉了
// 三个旧弹层，#562 删掉了最后一个 `OursServicesDialog`。旧弹层的 DOM（`ours-services-row` /
// `ours-services-dialog` / `ours-*` 一整族 testid）已经**不存在**，逐节断言它等于断言已删的东西，
// 所以本文件只保留仍然有效的那部分，并把体检对象换成新页面：
//
//   [A] 入口只在自有渠道出现：DeepSeek 官方 / 第三方 baseUrl 下一条 DOM 都没有，切回来跟着回来
//       —— 判据仍是 #166，只是入口从 `<OursServicesRow>` 换成「账户与消费」那一格。
//   [B] 点开就是新页面：四个 tab 齐全、旧弹层的 testid 一处都不剩（删除要可验证，不是「大概删了」）。
//   [C] tab 切换落到对应面板（我的额度 / 账号）—— 这两条正是消息流里「额度不足 → 我的额度」
//       「Key 失效 → 账号」两个 CTA 的目标 tab（`openAccountConsume('quota' | 'account')`）。
//
// 数据面全部打桩（不自起服务、不碰真网络）：消费侧 base 来自 `config/endpoints.json` 的
// `consume.baseUrl`（本地联调默认 `http://127.0.0.1:18000`），支付侧是多维 `pay.baseUrl`。
// 打桩只回最小合法体，面板的加载 / 空 / 错误三态由 L0（`consume-panels-*`）覆盖，这里只看「上没上屏」。
import { chromium } from 'playwright'

import {
  APP_URL,
  clickApiKeyConfirm,
  finish,
  fillApiKey,
  fillBaseUrl,
  fillModel,
  openApiConfigSection,
  openSettingsRoot,
} from '../helpers/helpers.mjs'
// #596：内置服务（ours）的 Key 只能由服务端下发 —— 种「已领取」形态（Key + 下发标记），
// 否则点「内置服务」这一行会走领取链路（真出网 401），而本用例要的只是「切到哪一行」。
import { claimedOursStorage } from '../helpers/ours-claim.mjs'
import { verifyAppUrl } from '../helpers/env.mjs'
import { payBaseUrl } from '../../scripts/lib/endpoints.mjs'

const name = 'tests/integration/ours-services.test.mjs'
/** 本用例不发消息，Key 只用来满足「确认使用」的非空校验与「已领取内置 Key」这一前提 */
const FAKE_KEY = 'sk-ours-services-0123456789'

const failures = []
const ok = (message) => console.log(`  ok  ${message}`)
const bad = (message) => {
  failures.push(message)
  console.log(`  ✗ ${message}`)
}
const eq = (actual, expected, label) => {
  if (actual === expected) {
    ok(`${label} = ${JSON.stringify(actual)}`)
  } else {
    bad(`${label}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
  }
}
const truthy = (condition, label) => (condition ? ok(label) : bad(label))

/** 打桩：消费侧（sub2api）与支付侧（apia）各回一份最小合法体，其余一律 404 JSON */
const wireMock = async (page) => {
  const json = (status, body) => ({
    status,
    contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' },
    body: JSON.stringify(body),
  })

  // 消费侧：JWT 身份 + 额度 + 订单 + 卡密兑换。L1 里 Capacitor HTTP 不存在，
  // `services/consume` 走 fetch —— 所以这些路由是唯一的数据来源。
  await page.route('http://127.0.0.1:18000/**', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith('/auth/profile') || url.pathname.endsWith('/user/profile')) {
      await route.fulfill(json(200, { id: 1, email: 'e2e@example.com', username: 'e2e' }))
      return
    }
    if (url.pathname.includes('/usage')) {
      await route.fulfill(json(200, { remaining: 0, used: 0, total: 0, items: [] }))
      return
    }
    if (url.pathname.includes('/keys')) {
      await route.fulfill(json(200, { items: [] }))
      return
    }
    await route.fulfill(json(200, { items: [] }))
  })

  // 支付侧：套餐空列表（#331 之后套餐可以全线下架，界面必须给可读空态而不是报错）
  await page.route(`${payBaseUrl}/**`, async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.includes('/api/plans')) {
      await route.fulfill(json(200, { plans: [] }))
      return
    }
    await route.fulfill(json(404, { code: 'NOT_FOUND', message: 'no route' }))
  })
}

await verifyAppUrl(APP_URL, undefined, { variant: 'standard' })
const browser = await chromium.launch()
try {
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 390, height: 844 } })
  const page = await context.newPage()
  const consoleErrors = []
  page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error' && !/^Failed to load resource:/.test(message.text())) {
      consoleErrors.push(message.text())
    }
  })
  await wireMock(page)

  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' })
  /**
   * 种「自有渠道 + 已领取内置 Key」的形态。
   *
   * 为什么不能再像以前那样只写 `provider-kind`：那条注释说「应用会自己弹出设置」，
   * 而「没有 Key 就自动弹设置层」这个行为**已经被产品删掉了**（主线 0b22d4fa / d17e2a92），
   * 于是下面自己点「设置」→ 390 视口下侧栏是抽屉、`设置` 按钮不在可视区 → 实测 30s 超时。
   * 现在改成：设置层由共享 helper 显式打开（先「打开边栏」），渠道切换走
   * 「模型来源 → 展开那一行 → 确认使用」的真实路径；内置服务的 Key 用「已领取」形态种入，
   * 免得夹具去跑一次真实领取（#596：只写 Key 没有下发标记会被判 unclaimed）。
   */
  await page.evaluate((storage) => {
    window.localStorage.clear()
    for (const [key, value] of Object.entries(storage)) {
      window.localStorage.setItem(key, value)
    }
    window.localStorage.setItem('chat-demo:provider-kind', 'ours')
  }, await claimedOursStorage(FAKE_KEY))
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(900)

  const openRow = () => page.getByTestId('account-consume-open').count()
  const oldRow = () => page.getByTestId('ours-services-row').count()
  const oldDialog = () => page.getByTestId('ours-services-dialog').count()

  /** 390 视口下侧栏是抽屉：先「打开边栏」（宽屏没有这个按钮，就不用点），再走共享 helper 进设置 */
  const ensureSettingsRoot = async () => {
    if ((await page.getByRole('dialog').count()) === 0) {
      const drawer = page.getByRole('button', { name: /^打开边栏$|^Open sidebar$/ })
      if ((await drawer.count()) > 0) {
        await drawer.first().click()
        await page.waitForTimeout(250)
      }
    }
    await openSettingsRoot(page)
  }

  /**
   * 切到某一行的生效来源（#807：展开 ≠ 生效）。
   *
   * 落点全部走「设置 → 账户与消费 → 模型来源」，切完回一级列表 —— 因为「账户与消费」入口
   * 挂在一级列表上，在二级页里数是 0 个（改版前那套 `selectProviderKind` + 下拉即生效已经不成立）。
   */
  const useSource = async (row, fill = {}) => {
    await openApiConfigSection(page, { row })
    if (row === 'third') {
      await fillBaseUrl(page, fill.baseUrl)
      await fillModel(page, fill.model)
    }
    if (row === 'builtin') {
      // 内置服务是「行即动作」：点行头就选中（已领取形态下不发任何请求）
    } else {
      await fillApiKey(page, FAKE_KEY)
      await clickApiKeyConfirm(page)
    }
    await openSettingsRoot(page)
  }

  // ---------- [A] 入口只在自有渠道出现（#166） ----------
  console.log('\n[A] 渠道门禁')
  // 「账户与消费」入口挂在设置**一级列表**上（`openSettingsDataSection` 会进到二级页，那里数不到），
  // 所以先把设置开在一级列表；若当前已在某个二级页，`openSettingsRoot` 会自己逐级退回。
  await ensureSettingsRoot()
  eq(await openRow(), 1, '自有渠道下有「账户与消费」入口')
  eq(await oldRow(), 0, '旧 `ours-services-row` 已退役（一处分都不留）')
  eq(await oldDialog(), 0, '旧 `ours-services-dialog` 已退役')

  await useSource('official')
  eq(await openRow(), 0, 'DeepSeek 官方下没有「账户与消费」入口')
  const officialText = await page.getByRole('dialog').first().innerText()
  truthy(!/设备码|邀请码|卡密/.test(officialText), 'DeepSeek 官方设置页没有自有渠道文案')

  await useSource('builtin')
  eq(await openRow(), 1, '切回自有渠道后入口恢复')

  await useSource('third', { baseUrl: 'https://relay.example.com', model: 'gpt-4o-mini' })
  eq(await openRow(), 0, '第三方 baseUrl 下没有入口（#166）')

  await useSource('builtin')
  eq(await openRow(), 1, '会话内切回自有渠道后入口恢复（store 订阅，不用刷新）')

  // ---------- [B] 点开就是「账户与消费」四 tab 新页面 ----------
  console.log('\n[B] 新页面上屏')
  await page.getByTestId('account-consume-open').click()
  const panel = page.getByTestId('account-consume-page')
  await panel.waitFor({ state: 'visible', timeout: 10000 })
  ok('点「账户与消费」打开的是新页面')
  eq(await oldDialog(), 0, '打开后也没有旧弹层')
  // #817：「我的额度」这一页已删（余额卡里的入口也删了），四 tab 的老口径收成三个可达入口 ——
  // 卡密 / 购买 / 账号都在 L2，L1 上是「模型来源 / 我的钱包 / 账号」三行。
  eq(await page.getByTestId('account-consume-tab-quota').count(), 0, '「我的额度」入口已删（#817）')
  for (const tab of ['cards', 'account']) {
    eq(await page.getByTestId(`account-consume-tab-${tab}`).count(), 1, `入口「${tab}」存在`)
  }
  // 默认落在「我的卡密」：付款回跳（openAccountConsume() 的缺省 tab）就是为了让用户看到卡密
  // （先判存在再读属性：节点不在时 getAttribute 会挂 30s，红在超时而不是「没有这个 tab」）
  const cardsTab = page.getByTestId('account-consume-tab-cards')
  eq(
    (await cardsTab.count()) > 0 && (await cardsTab.getAttribute('aria-selected')) === 'true',
    true,
    '默认落在「我的卡密」tab（付款回跳的目标）'
  )

  // ---------- [C] 另两页各自上屏（消息流两个 CTA 的目标） ----------
  console.log('\n[C] 页内切换')
  // #817：「我的额度」页没了，CTA 落在钱包页（页首 = 余额卡 + 付款入口）
  await page.getByTestId('account-consume-wallet').click()
  await page.waitForTimeout(600)
  truthy(
    (await page.getByTestId('account-consume-wallet-head').count()) > 0,
    '「我的钱包」页有余额卡 + 付款入口那一行'
  )
  await page.getByTestId('account-consume-back').click()
  await page.getByTestId('account-consume-tab-account').click()
  await page.waitForTimeout(600)
  truthy((await page.getByTestId('account-consume-page').innerText()).length > 0, '「账号」tab 有内容')

  truthy(consoleErrors.length === 0, `没有 console / pageerror：${consoleErrors.slice(0, 3).join(' | ')}`)
  await context.close()
} catch (error) {
  // 原来只有 try/finally：中途抛异常（选择器点不到 / 那一屏的结构变了）时 finally 会先打印 PASS
  // 再让异常冒泡，日志上像通过、runner 仍判 FAIL，后面的小节也一起消失。补 catch，让失败如实报。
  bad(`用例异常：${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
} finally {
  await finish(browser, name, failures)
}
