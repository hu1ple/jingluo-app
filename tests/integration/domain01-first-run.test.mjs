// [layer: integration | 依赖: playwright + chromium + 本地静态服务 | 耗时: 15~30 秒] 说明见 tests/README.md
// Issue #362（域 1「启动与可用性」）/ #367：最小充分集第 2/5 条。
//
// 这一条只跑一个场景，但三件事必须在**同一条时序**里串起来（表驱动会掩盖「先点发送、再存 Key、再发送」的先后关系）：
//   F1-09 清数据后首启：没有 Key 时**不弹任何弹层**（首屏照常可用），点发送才给一条通知 + 「去选择渠道」按钮；
//   F1-09 从通知进设置存 Key，关掉后**同一条消息能发出去**：不是「点了没反应」，也不是「填了 Key 没用」；
//   F1-01 首屏始终可用：全程侧栏 + 欢迎页在场，没有「正在加载对话...」，没有白屏。
//
// 口径变更（2026-11-25，产品决定）：「没有 Key 就自动弹设置」这个功能被否掉了 ——
// 「压根不需要什么自动打开设置的操作」。所以本条用例改前断言的「首启自动弹设置层」**已过期**，
// 现在断言的是：**首启不弹** → 点发送 → 通知上写着「我还不认识你呢」+ 按钮「去选择渠道」 →
// 点按钮才进设置 → 填 Key → 关闭 → 再发送成功。源码门禁见 `tests/unit/no-auto-settings.test.mjs`。
//
// 为什么以前一条都没覆盖（#362 盘点原文）：`tests/helpers/helpers.mjs` 的 `openSettingsDataSection`
// 把「已经自动弹出」当成通过条件，**放过**了「没弹出」；也没有任何一条断言「无 Key 时点发送会给出可点的入口」。
//
// 跑法（先 pnpm build 生成标准包；本脚本自起临时端口服务）：
//   node tests/integration/domain01-first-run.test.mjs
//   DIST_DIR=/private/artifacts/<commit>/standard node tests/integration/domain01-first-run.test.mjs
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { requireDist, serveDist } from '../helpers/runtime.mjs'
import { verifyAppUrl } from '../helpers/env.mjs'
import { MESSAGES_SSE_OK } from '../helpers/helpers.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')
const DIST = await requireDist(process.env.DIST_DIR || path.join(ROOT, 'dist'))
const name = 'tests/integration/domain01-first-run.test.mjs'
const KEY = 'sk-testkey-domain01-first'
/** 未登录 + 没有 Key 时那条通知的正文（`sendBlockedNoCredentials`，见 src/i18n/zh.ts） */
const NOTICE_NO_CREDENTIALS = '我还不认识你呢'
/** 通知上的按钮（`sendBlockedPickProvider` = 去选择渠道） */
const NOTICE_ACTION = /^去选择渠道$|^Choose provider$/

const failures = []
const ok = (message) => console.log(`  ok  ${message}`)
const bad = (message) => {
  failures.push(message)
  console.error(`  ✗   ${message}`)
}
const expect = (condition, message) => (condition ? ok(message) : bad(message))

const server = await serveDist(DIST, { port: process.env.PORT || 0 })
const APP_URL = server.url
await verifyAppUrl(APP_URL, DIST, { variant: 'standard' })
const browser = await chromium.launch()

const bodyText = async (page) => (await page.locator('body').innerText()).replace(/\s+/g, ' ')
const waitFor = async (page, predicate, timeout = 15_000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await predicate()) {
      return true
    }
    await page.waitForTimeout(120)
  }
  return false
}
const waitForText = (page, part, timeout = 15_000) =>
  waitFor(page, async () => (await bodyText(page)).includes(part), timeout)
/** 屏幕上现在有几层弹层（`role="dialog"` 是本仓唯一的「弹层在场」判据，见 src/app/App.tsx） */
const dialogCount = async (page) => page.getByRole('dialog').count()

/**
 * 首启时可能先出现「公告」弹层（`AnnouncementPopup`，首次强制阅读 5 秒 —— 见 #533 那次提交）。
 *
 * 它和设置弹层**共用同一个 `Modal`**（都是 `role="dialog"`），所以「有没有 dialog」这条断言
 * 必须先把它清掉：否则要么把公告误当成「自动打开了设置」，要么点不到输入框。
 * 倒计时期间关闭按钮是 disabled 的，这里等到它可用再点（不 force click：那会绕过产品规则）。
 */
const dismissAnnouncementIfAny = async (page) => {
  const button = page.locator('[data-testid="settings-announcement-popup-dismiss"]').first()
  try {
    await button.waitFor({ state: 'visible', timeout: 8_000 })
  } catch {
    return false
  }
  await waitFor(page, async () => button.isEnabled(), 20_000)
  await button.click()
  await waitFor(page, async () => (await dialogCount(page)) === 0, 8_000)
  return true
}

try {
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1280, height: 800 } })
  const page = await context.newPage()
  let messageCalls = 0
  // 上游全部打桩，不连外网
  await page.route(/\/models$/, (route) =>
    route.fulfill({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: [{ id: 'deepseek-flash', type: 'model' }] }),
    })
  )
  await page.route(/140\.210\.13\.146:60013/, (route) =>
    route.fulfill({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ customer_id: 'cus-mock', device_id: 'dev-mock' }),
    })
  )
  await page.route(/\/anthropic\/v1\/messages$/, async (route) => {
    messageCalls += 1
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: MESSAGES_SSE_OK,
    })
  })

  // ---------- 清数据后首启：localStorage + IndexedDB 全部清空，再冷启动 ----------
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' })
  await page.evaluate(async () => {
    window.localStorage.clear()
    await new Promise((resolve) => {
      const request = indexedDB.deleteDatabase('chat-demo')
      request.onsuccess = resolve
      request.onerror = resolve
      request.onblocked = resolve
    })
  })
  await page.reload({ waitUntil: 'domcontentloaded' })

  // 分支 1（F1-09）：无 Key 首启**不弹设置**（产品决定 2026-11-25：不许自动打开设置层）。
  // 先把「公告」那层关掉（它与设置共用 role="dialog"，不清掉会把两者混为一谈），
  // 再等一会儿判「设置层没有自己冒出来」—— 避免把「延迟 1 秒才弹」误判成「没弹」。
  await waitForText(page, '今天有什么可以帮到你', 10_000)
  const hadAnnouncement = await dismissAnnouncementIfAny(page)
  ok(`F1-09 首启公告弹层：${hadAnnouncement ? '出现过，已按「开始阅读」关掉' : '没有（已读）'}`)
  await page.waitForTimeout(1200)
  expect(
    (await dialogCount(page)) === 0,
    'F1-09 无 Key 首启不自动打开设置弹层（不打断用户，首屏照常可用）'
  )

  // 分支 2（F1-01）：同一时刻首屏仍然是可用的（不是只给一个弹层 + 白屏）
  const text = await bodyText(page)
  expect(text.includes('今天有什么可以帮到你'), 'F1-01 清数据首启后主区仍是欢迎页（不白屏）')
  expect(text.includes('开启新对话'), 'F1-01 清数据首启后侧栏在场（可开启新对话）')
  expect(!text.includes('正在加载对话'), 'F1-01 清数据首启不卡在「正在加载对话...」')

  // 分支 3（F1-09）：点发送 → 通知（正文 + 「去选择渠道」按钮）→ 点按钮才进设置 → 填 Key →
  // 关闭 → 再发送成功。这条链就是「没有 Key 时用户实际走的那条路」，一步都不许断。
  const textarea = page.locator('textarea').last()
  await textarea.click()
  await textarea.fill('域名 1 首启发一条')
  await page.getByRole('button', { name: /^发送$|^Send$/ }).first().click()

  const notice = page.locator('[role="status"]').filter({ hasText: NOTICE_NO_CREDENTIALS })
  const noticeShown = await waitFor(page, async () => (await notice.count()) > 0, 8_000)
  expect(noticeShown, `F1-09 无 Key 点发送给出通知（文案「${NOTICE_NO_CREDENTIALS}」）`)
  expect(messageCalls === 0, `F1-09 被拦下时一个上游请求都不发（实际 ${messageCalls} 次）`)
  expect(
    (await dialogCount(page)) === 0,
    'F1-09 拦下时**不**自动打开设置（要用户自己点通知上的按钮）'
  )
  const noticeAction = notice.getByRole('button', { name: NOTICE_ACTION }).first()
  expect((await noticeAction.count()) > 0, 'F1-09 通知上有「去选择渠道」按钮（唯一出口）')
  await noticeAction.click()

  const dialogShown = await waitFor(page, async () => (await dialogCount(page)) > 0, 8_000)
  expect(dialogShown, 'F1-09 点通知上的按钮才打开设置弹层')
  if (dialogShown) {
    const dialogText = await page.getByRole('dialog').first().innerText()
    expect(
      /模型来源|账户与消费/.test(dialogText),
      'F1-09 落在「账户与消费」（一级列表：模型来源 / 我的钱包 / 账号）'
    )
  }

  // ---------- 进「模型来源」→ 展开「DeepSeek 官方服务」→ 存 Key → 关弹层 → 直接发一条 ----------
  // 设置是「一级列表 + 手风琴」两层（#727 / #807）：通知按钮只把人送到一级列表，
  // Key 输入框在「模型来源 → DeepSeek 官方服务」里 —— 这条路径就是用户要自己走的那两步。
  await page.locator('[data-testid="account-consume-source"]').first().click()
  const officialRow = page.locator('[data-testid="settings-source-official"]').first()
  await officialRow.waitFor({ state: 'visible', timeout: 10_000 })
  await officialRow.click()
  const officialPanel = page.locator('[data-testid="settings-source-official-panel"]').first()
  await officialPanel.waitFor({ state: 'visible', timeout: 10_000 })
  const keyInput = officialPanel.locator('input[type="password"]').first()
  expect(
    (await keyInput.count()) > 0,
    'F1-09 「DeepSeek 官方服务」展开后有可填的 API Key 输入框'
  )
  await keyInput.fill(KEY)
  await page.locator('[data-testid="settings-source-official-confirm"]').first().click()
  await page.waitForTimeout(400)
  const stillOpen = page.getByRole('dialog').first()
  if ((await stillOpen.count()) > 0) {
    await stillOpen.getByRole('button', { name: /^关闭$|^Close$/ }).first().click()
    await page.waitForTimeout(400)
  }
  expect((await dialogCount(page)) === 0, 'F1-09 存 Key 后弹层能关掉（回到主界面）')

  // 草稿应当还在输入框里（拦下只是不发请求，不该把用户打的字吃掉）；不管在不在都补一遍，
  // 免得这条断言依赖「发送按钮在空草稿时是否可点」这种与本用例无关的实现细节。
  expect(
    (await textarea.inputValue()).trim().length > 0,
    'F1-09 被拦下后草稿还在输入框里（没有把用户打的字丢掉）'
  )
  await textarea.click()
  await textarea.fill('域名 1 首启发一条')
  await page.getByRole('button', { name: /^发送$|^Send$/ }).first().click()
  expect(await waitForText(page, '你好呀'), 'F1-09 存 Key 后直接发送，回答正常上屏')
  expect(messageCalls === 1, `F1-09 只发一次消息请求（实际 ${messageCalls} 次）`)
  expect(
    (await page.getByRole('button', { name: /^发送$|^Send$/ }).count()) > 0,
    'F1-09 回答结束后输入行回到「发送」态（没有卡在生成中）'
  )
  // 刷新后 Key 仍然在：不会再被要求输入（否则「清数据首启」只在第一次成立）
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(800)
  expect(
    (await dialogCount(page)) === 0,
    'F1-09 存下的 Key 在刷新后仍然生效（不再弹设置）'
  )
  await context.close()
} catch (error) {
  bad(`用例异常：${error instanceof Error ? error.message : String(error)}`)
} finally {
  await browser.close()
  await server.close()
  if (failures.length > 0) {
    console.error(`\nFAIL ${name}`)
    for (const failure of failures) {
      console.error(`  ✗ ${failure}`)
    }
    process.exit(1)
  }
  console.log(
    `\nPASS ${name}（1 条串行场景 / 3 条分支：F1-09 首启不弹 + 点了才进设置并发出 + F1-01 首屏可用）`
  )
}
