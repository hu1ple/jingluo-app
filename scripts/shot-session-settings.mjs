#!/usr/bin/env node
/**
 * 每会话聊天背景的浏览器验收（本单）。
 *
 *   APP_URL=http://127.0.0.1:8122 node scripts/shot-session-settings.mjs
 *
 * 做什么（390 / 360 各跑一遍）：
 *   1. 种两条会话（A / B）进 IndexedDB（v15，与 `db.ts` 的 DB_VERSION 同源）；
 *   2. A 会话：点右上角「聊天设置」→ 抽屉两行都在 → 进「聊天背景」→ 选远山 → 淡化 60 / 模糊 8
 *      → 保存 → 回聊天区，断言 `main[data-chat-background=on]` 且 `data-chat-background-style=mountain`；
 *   3. 切到 B 会话 → 断言 `main` **没有** `data-chat-background`（关键：会话之间不串）；
 *   4. 设置里换「默认背景」（真 file input 上传）→ B 跟着变（没有单独设置过），
 *      A 仍然是远山（单独设置过的不受影响）；
 *   5. 截图 4 张 × 2 档，并把 pageerror / requestfailed 计数打出来（都必须是 0）。
 *
 * 端口不写死：读 `APP_URL`（默认 8122 —— 本单约定的 8120 被本机另一个服务占着，见 PR 说明），
 * 与 `check-hardcoded-ports` 的口径一致：测试/脚本里的端口一律走 env。
 */
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'

const APP_URL = process.env.APP_URL ?? 'http://127.0.0.1:8122'
const OUT_DIR = process.env.OUT_DIR ?? '/tmp/session-settings-shots'
/** 与 `src/services/chat/db.ts` 的 DB_VERSION 保持一致（改版本号要同步这里，见 shot-mobile 的同一条注释） */
const DB_VERSION = 15
const VIEWPORTS = {
  390: { width: 390, height: 844 },
  360: { width: 360, height: 740 },
}

/** 1×1 PNG：给设置页「默认背景」的 file input 用（走真实压缩链路：decode → canvas → JPEG） */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

/** 种会话：先让应用自己把库建出来（warmer 页），再按 v15 结构写 sessions / sessionSummaries */
const seedInPage = async ({ version, sessions }) => {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('chat-demo', version)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  await new Promise((resolve, reject) => {
    const tx = db.transaction(['sessions', 'sessionSummaries'], 'readwrite')
    for (const session of sessions) {
      const { fileIds, ...record } = session
      tx.objectStore('sessions').put(record)
      tx.objectStore('sessionSummaries').put({ ...fileIds, ...session, fileIds: [] })
    }
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
  db.close()
}

const message = (id, role, text, at) => ({
  id,
  role,
  content: text,
  createdAt: at,
  ...(role === 'assistant' ? { status: 'done' } : {}),
})

const sessions = [
  {
    id: 'sess-a',
    title: '会话 A（单独设置背景）',
    createdAt: Date.now() - 200000,
    updatedAt: Date.now() - 100000,
    messages: [
      message('a-1', 'user', '这一条会话我想用远山背景。', Date.now() - 190000),
      message('a-2', 'assistant', '好的，背景只对这一条会话生效。', Date.now() - 180000),
    ],
  },
  {
    id: 'sess-b',
    title: '会话 B（跟随默认背景）',
    createdAt: Date.now() - 300000,
    updatedAt: Date.now() - 250000,
    messages: [
      message('b-1', 'user', '这条会话什么都不单独设置。', Date.now() - 290000),
      message('b-2', 'assistant', '那它就应该跟着设置里的默认背景走。', Date.now() - 280000),
    ],
  },
]

/** React 受控 range：必须走原生 setter + input 事件，否则 React 认为值没变 */
const setRange = async (page, testId, value) => {
  await page.$eval(`[data-testid="${testId}"]`, (element, next) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(element, String(next))
    element.dispatchEvent(new Event('input', { bubbles: true }))
  }, value)
}

const siderVisible = async (page) => {
  const sider = await page.$('[data-testid="sider"]')
  return sider === null ? false : await sider.isVisible().catch(() => false)
}

/** 打开侧栏；已经开着就什么都不做（重复点「打开边栏」会被抽屉自己挡住，是正常的产品行为） */
const openSider = async (page) => {
  if (await siderVisible(page)) {
    return
  }
  const menu = page.getByRole('button', { name: '打开边栏' })
  await menu.click()
  await page.waitForTimeout(500)
}

/** 选完会话把抽屉收起来（正常路径里 activeId 变化会自动收，这里兜一手） */
const closeSiderIfOpen = async (page) => {
  if (await siderVisible(page)) {
    await page.keyboard.press('Escape')
    await page.waitForTimeout(400)
  }
}

const mainBackground = (page) =>
  page.$eval('main', (element) => ({
    on: element.getAttribute('data-chat-background'),
    style: element.getAttribute('data-chat-background-style'),
    image: element.style.getPropertyValue('--chat-background-image'),
    mask: element.style.getPropertyValue('--chat-background-mask'),
    blur: element.style.getPropertyValue('--chat-background-blur'),
  }))

const runViewport = async (browser, width) => {
  const viewport = VIEWPORTS[width]
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    locale: 'zh-CN',
  })
  const pageErrors = []
  const requestFailed = []
  /**
   * 启动期网络副作用一律就地应答（公告 / 更新清单 / 账号态…）：它们不是本单的被测物，
   * 但**不能**让它们变成 `requestfailed`（超时后 abort 会记一条 net::ERR_ABORTED）。
   * 应用本体的请求（同源：dev server）照常放行。
   */
  await context.route('**/*', (route) => {
    const url = route.request().url()
    if (url.startsWith(APP_URL)) {
      return route.continue()
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
  })

  const warmer = await context.newPage()
  await warmer.goto(APP_URL, { waitUntil: 'domcontentloaded' })
  await warmer.evaluate(seedInPage, { version: DB_VERSION, sessions })
  await warmer.close()

  const page = await context.newPage()
  page.on('pageerror', (error) => pageErrors.push(String(error)))
  page.on('requestfailed', (request) => requestFailed.push(`${request.url()} :: ${request.failure()?.errorText}`))
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)

  const shots = {}
  const shot = async (name) => {
    const file = path.join(OUT_DIR, `session-settings-${name}-${width}.png`)
    await page.screenshot({ path: file })
    shots[name] = file
  }

  // ---- 欢迎页（新会话）同样能进「聊天设置」 ----
  await page.click('[data-testid="chat-settings-open"]')
  await page.waitForSelector('[data-testid="chat-settings-sheet"]')
  await page.waitForTimeout(500)
  const welcomeFacts = await page.evaluate(() => {
    const sheet = document.querySelector('[data-testid="chat-settings-sheet"]')
    const background = sheet?.querySelector('[data-testid="chat-settings-background"]')
    const prompt = sheet?.querySelector('[data-testid="chat-settings-prompt"]')
    return {
      sheetOpen: Boolean(sheet),
      promptEnabled: prompt instanceof HTMLButtonElement && !prompt.disabled,
      // 新会话还没有 id：背景那一行必须是禁用态（不是"点了没反应"）
      backgroundDisabled: background instanceof HTMLButtonElement && background.disabled,
      needsSessionHint: (background?.textContent ?? '').includes('发出第一条消息后可用'),
    }
  })
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)

  // ---- 打开 A 会话 ----
  await openSider(page)
  await page.click('[data-testid="sider-session-sess-a"]')
  await page.waitForTimeout(600)
  await closeSiderIfOpen(page)

  // ---- 抽屉：两行都在 ----
  await page.click('[data-testid="chat-settings-open"]')
  await page.waitForSelector('[data-testid="chat-settings-sheet"]')
  // 等抽屉的进场动画（240ms）走完再截图，否则会拍到「半透明 + 背后文字透出来」的中间帧
  await page.waitForTimeout(500)
  const sheetFacts = await page.evaluate(() => {
    const sheet = document.querySelector('[data-testid="chat-settings-sheet"]')
    return {
      prompt: Boolean(sheet?.querySelector('[data-testid="chat-settings-prompt"]')),
      background: Boolean(sheet?.querySelector('[data-testid="chat-settings-background"]')),
      scope: (sheet?.textContent ?? '').includes('设置仅对当前聊天生效'),
      rows: Array.from(sheet?.querySelectorAll('[data-testid^="chat-settings-"]') ?? []).map((node) =>
        (node.textContent ?? '').replace(/\s+/gu, ' ').trim(),
      ),
    }
  })
  await shot('sheet')

  // ---- 第一行「自定义提示词」仍然打开既有的 PersonaDrawer（本单没重写它） ----
  await page.click('[data-testid="chat-settings-prompt"]')
  await page.waitForTimeout(500)
  const promptDrawerOpen = await page.evaluate(() =>
    Boolean(document.querySelector('[role="dialog"] textarea')),
  )
  await page.keyboard.press('Escape')
  await page.waitForSelector('[data-testid="chat-settings-sheet"]')
  await page.waitForTimeout(400)

  // ---- 背景页：选远山 + 淡化 60 + 模糊 8 → 保存 ----
  await page.click('[data-testid="chat-settings-background"]')
  await page.waitForSelector('[data-testid="chat-background-page"]')
  await page.waitForTimeout(500)
  await page.click('[data-testid="chat-background-style-mountain"]')
  await setRange(page, 'chat-background-opacity', 60)
  await setRange(page, 'chat-background-blur', 8)
  await page.waitForTimeout(300)
  const pageFacts = await page.evaluate(() => {
    const root = document.querySelector('[data-testid="chat-background-page"]')
    const text = (root?.textContent ?? '').replace(/\s+/gu, ' ')
    return {
      hasUpload: Boolean(root?.querySelector('[data-testid="chat-background-upload"]')),
      hasOpacity: Boolean(root?.querySelector('[data-testid="chat-background-opacity"]')),
      hasBlur: Boolean(root?.querySelector('[data-testid="chat-background-blur"]')),
      hasReset: Boolean(root?.querySelector('[data-testid="chat-background-reset"]')),
      hasSave: Boolean(root?.querySelector('[data-testid="chat-background-save"]')),
      text,
      previewMask: getComputedStyle(root.querySelector('[data-testid="chat-background-preview"]')).getPropertyValue('--chat-background-mask'),
    }
  })
  await shot('background-page')
  await page.click('[data-testid="chat-background-save"]')
  await page.waitForTimeout(800)

  // ---- 关闭抽屉 → A 会话应用了背景 ----
  const closeSheet = async () => {
    const sheet = await page.$('[data-testid="chat-settings-sheet"]')
    if (sheet) {
      const close = await page.$('[data-testid="chat-settings-sheet"] button[aria-label="关闭"]')
      if (close) {
        await close.click()
      } else {
        await page.keyboard.press('Escape')
      }
      await page.waitForTimeout(500)
    }
  }
  await closeSheet()
  await page.waitForTimeout(500)
  const appliedA = await mainBackground(page)
  await shot('applied')

  // ---- 切到 B 会话：背景不受影响 ----
  await openSider(page)
  await page.click('[data-testid="sider-session-sess-b"]')
  await page.waitForTimeout(700)
  await closeSiderIfOpen(page)
  const appliedB = await mainBackground(page)
  await shot('sibling-unaffected')

  // ---- 设置页：默认背景改名 / 描述 + 换一张默认背景 ----
  await openSider(page)
  await page.getByTestId('sider').getByRole('button', { name: '设置', exact: true }).click()
  await page.waitForTimeout(600)
  // 「默认背景」在设置 → 外观 那一页（`ChatBackgroundField`），不是设置首页
  await page.click('[data-testid="settings-row-appearance"]')
  await page.waitForTimeout(500)
  const settingsCopy = await page.evaluate(() => {
    const text = (document.body.textContent ?? '').replace(/\s+/gu, ' ')
    return { hasDefaultLabel: text.includes('默认背景'), hasSemantics: text.includes('新会话默认使用；单独设置过的会话不受影响') }
  })
  await page.locator('input[type="file"][aria-label="上传"]').first().setInputFiles({
    name: 'default.png',
    mimeType: 'image/png',
    buffer: PNG_1PX,
  })
  await page.waitForTimeout(1200)
  const keyboardClose = page.getByRole('button', { name: '关闭' }).first()
  await keyboardClose.click().catch(() => page.keyboard.press('Escape'))
  await page.waitForTimeout(600)
  const globalAppliedB = await mainBackground(page)

  // A 会话：单独设置过 → 仍是远山，不跟着默认背景变
  await openSider(page)
  await page.click('[data-testid="sider-session-sess-a"]')
  await page.waitForTimeout(700)
  await closeSiderIfOpen(page)
  const globalAppliedA = await mainBackground(page)

  // ---- 刷新后 A 会话仍是远山（真的落库了，不是只活在内存里） ----
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)
  await openSider(page)
  await page.click('[data-testid="sider-session-sess-a"]')
  await page.waitForTimeout(800)
  await closeSiderIfOpen(page)
  const afterReloadA = await mainBackground(page)

  await context.close()
  return {
    width,
    welcomeFacts,
    promptDrawerOpen,
    sheetFacts,
    pageFacts,
    appliedA,
    appliedB,
    globalAppliedB,
    globalAppliedA,
    afterReloadA,
    settingsCopy,
    shots,
    pageErrors,
    requestFailed,
  }
}

const main = async () => {
  await mkdir(OUT_DIR, { recursive: true })
  const browser = await chromium.launch()
  const results = []
  for (const width of [390, 360]) {
    results.push(await runViewport(browser, width))
  }
  await browser.close()
  console.log(JSON.stringify(results, null, 2))

  const failures = []
  for (const result of results) {
    const check = (ok, label) => {
      if (!ok) {
        failures.push(`[${result.width}] ${label}`)
      }
    }
    check(result.welcomeFacts.sheetOpen, '欢迎页（新会话）也能打开聊天设置')
    check(result.welcomeFacts.promptEnabled, '欢迎页里「自定义提示词」可点')
    check(result.welcomeFacts.backgroundDisabled && result.welcomeFacts.needsSessionHint, '欢迎页里「聊天背景」禁用并说明原因')
    check(result.promptDrawerOpen, '第一行仍然打开既有 PersonaDrawer')
    check(result.sheetFacts.prompt && result.sheetFacts.background, '抽屉两行都在')
    check(result.sheetFacts.scope, '抽屉底部「设置仅对当前聊天生效」')
    check(result.pageFacts.hasUpload && result.pageFacts.hasOpacity && result.pageFacts.hasBlur, '背景页控件齐全')
    check(result.pageFacts.hasReset && result.pageFacts.hasSave, '恢复默认 / 保存设置')
    check(result.pageFacts.text.includes('60%') && result.pageFacts.text.includes('8 px'), '滑杆数值显示 60% / 8 px')
    check(result.appliedA.on === 'on' && result.appliedA.style === 'mountain', 'A 会话应用了远山背景')
    check(result.appliedA.blur === '8px', 'A 会话模糊 8px 生效')
    check(result.appliedA.mask === '0.4', 'A 会话淡化 60% → 遮罩 0.4')
    check(result.appliedB.on === null, 'B 会话没有 data-chat-background（不受影响）')
    check(result.settingsCopy.hasDefaultLabel, '设置页改名「默认背景」')
    check(result.settingsCopy.hasSemantics, '设置页描述改成新语义')
    check(result.globalAppliedB.on === 'on' && result.globalAppliedB.image.startsWith('url('), 'B 会话跟着默认背景变')
    check(result.globalAppliedB.style === null, 'B 会话用的是默认图（没有会话级 style）')
    check(result.globalAppliedA.style === 'mountain', 'A 会话单独设置过 → 不跟着默认背景变')
    check(result.afterReloadA.style === 'mountain' && result.afterReloadA.mask === '0.4', '刷新后 A 会话背景仍在（已落库）')
    check(result.pageErrors.length === 0, `pageerror 为 0（实际 ${result.pageErrors.length}）`)
    check(result.requestFailed.length === 0, `requestfailed 为 0（实际 ${result.requestFailed.length}）`)
  }
  if (failures.length > 0) {
    console.error('\n验收失败：\n' + failures.join('\n'))
    process.exitCode = 1
    return
  }
  console.log('\n验收全绿：4 张截图 × 2 档，pageerror / requestfailed 均为 0')
}

await main()
