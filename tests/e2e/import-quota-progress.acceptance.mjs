// 浏览器验收（本单 ① ②）：导入前剩余空间预检 / 进度 / 取消，三档视口截图。
//
// 这不是 unit 层用例，是**一次性验收脚本**（文件名不带 `.test.`，任何 layer runner 都不会枚举它）：
// 它要真的起一个 dev server（端口 8144）、真的点开设置、真的选一个 ZIP、真的看进度条与取消按钮。
//
//   # 1) 起 dev server（另一个终端）
//   npx rspack serve -c rspack.config.ts --port 8144
//   # 2) 跑验收
//   APP_URL=http://127.0.0.1:8144 node tests/e2e/import-quota-progress.acceptance.mjs
//
// 三档场景（每档都在 390 / 360 两个宽度各跑一遍）：
//   A 空间不足 → **导入前**被拦：一条会话都没入库，提示带「还差多少 / 当前可用多少」
//   B 正常导入 → 进度条从 0 走到 100、文案里的会话数对得上、完成后会话真的在库里
//   C 中途取消 → 停止、列表没有新增、暂存被清
//
// 「空间不足」不靠造几百 MB 的包：`navigator.storage.estimate()` 在页面里被桩掉，
// 归档本身是中等大小（几百条会话，几 MB 级），既跑得快又能让进度条真的走到中间态。
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright'
import { buildArchiveZip } from '../fixtures/domain05/archive-fixture.mjs'
import { assertNoEgress, installEgressGate, openSettingsRoot } from '../helpers/helpers.mjs'
import { BUILTIN_KEY_CLAIM_STUB } from '../fixtures/consume-gateway-stubs/builtin-key-claim.mjs'
import { CONSUME_AUTH_FLAGS_STUB } from '../fixtures/consume-gateway-stubs/account-consume-chain.mjs'
import { DIST_STARTUP_STUBS } from '../fixtures/startup/startup-chain-stubs.mjs'

/**
 * dev server 起的是**非接缝**产物，冷启动会真发四条与本用例无关的请求
 * （`settings/public` 的注册开关 + 分发机的 announcements / releases）。
 * 全部按「上游正常但没有内容」应答 —— 出站总闸一个字没放宽（桩之外照样记未登记 → 红）。
 */
const STARTUP_STUBS = [BUILTIN_KEY_CLAIM_STUB, CONSUME_AUTH_FLAGS_STUB, ...DIST_STARTUP_STUBS]

const APP_URL = process.env.APP_URL || 'http://127.0.0.1:8144'
const SHOT_DIR = path.resolve('docs/ui')
const VIEWPORTS = {
  390: { width: 390, height: 844 },
  360: { width: 360, height: 740 },
}
/** 够大才看得见中间态（进度条从 0 到 100 之间要能被采样到）；不靠造几百 MB。 */
const SESSIONS = 900
const TITLE_PREFIX = '配额进度验收会话'

const failures = []
const check = (name, ok, detail = '') => {
  if (ok) {
    console.log(`  ✓ ${name}`)
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/** 真库计数（不是看 DOM：界面显示 0 条、库里 300 条是两种完全不同的 bug）。 */
const dbCounts = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open('chat-demo')
        request.onerror = () => reject(request.error)
        request.onsuccess = () => {
          const db = request.result
          const names = ['sessions', 'sessionsStaging', 'filesStaging'].filter((name) =>
            db.objectStoreNames.contains(name)
          )
          const out = { sessions: 0, sessionsStaging: 0, filesStaging: 0 }
          if (names.length === 0) {
            resolve(out)
            return
          }
          let left = names.length
          for (const name of names) {
            const count = db.transaction(name, 'readonly').objectStore(name).count()
            count.onsuccess = () => {
              out[name] = count.result
              left -= 1
              if (left === 0) {
                resolve(out)
              }
            }
            count.onerror = () => reject(count.error)
          }
        }
      })
  )

/**
 * 页面内的进度采样器：每 80ms 记一次「进度文案 + 进度条的 scaleX」。
 * 读的是**真实渲染出来的东西**（文案是 `正在导入… n/总数 个会话`，进度条是 src 里
 * `style={{ transform: 'scaleX(percent/100)' }}` 写下的内联样式），不是从代码里猜的。
 */
const startSampler = (page) =>
  page.evaluate(() => {
    window.__IMPORT_SAMPLES__ = []
    window.__IMPORT_SAMPLER__ = setInterval(() => {
      // 整篇找，不要 `querySelector('[role="dialog"]')` —— 设置弹层本身也是 role=dialog，
      // 且排在前面，那样只会取到外层那个（里面没有进度条），采样永远是空。
      const label = document.querySelector('[class*="progressLabel"]')
      const fill = document.querySelector('[class*="progressFill"]')
      if (label === null && fill === null) {
        return
      }
      const text = label === null ? '' : label.textContent || ''
      const transform = fill === null ? '' : fill.style.transform || ''
      const match = /scaleX\(([\d.]+)\)/.exec(transform)
      window.__IMPORT_SAMPLES__.push({
        at: performance.now(),
        text,
        percent: match === null ? null : Math.round(Number(match[1]) * 100),
        sessions: /(\d+)\/(\d+)\s*个会话/.exec(text)?.[1] ?? null,
        total: /(\d+)\/(\d+)\s*个会话/.exec(text)?.[2] ?? null,
      })
    }, 80)
  })

const readSamples = (page) => page.evaluate(() => window.__IMPORT_SAMPLES__ ?? [])

/**
 * 窄屏（360）下侧栏在抽屉里，「设置」按钮不可见 —— 先点「打开边栏」。
 * 390 档同理（本仓两档都走移动布局），所以这一步在两档都执行（可见时直接返回）。
 */
const openSiderIfNeeded = async (page) => {
  const settingsButton = page.getByRole('button', { name: '设置', exact: true })
  if (await settingsButton.isVisible().catch(() => false)) {
    return
  }
  const menu = page.getByRole('button', { name: '打开边栏' })
  await menu.waitFor({ state: 'visible', timeout: 10000 })
  await menu.click()
  await page.waitForTimeout(350)
}

/** 打开「设置 → 数据」页，返回 ZIP 输入框。 */
const openImportRow = async (page) => {
  await openSiderIfNeeded(page)
  await openSettingsRoot(page)
  await page.getByTestId('settings-row-data').first().click()
  return page.locator('input[type="file"][accept*="zip"]')
}

const pickFile = async (page, fileInput, filePath) => {
  await fileInput.setInputFiles(filePath)
  const confirm = page.getByRole('dialog', { name: /确认导入历史对话/ })
  await confirm.waitFor({ timeout: 10000 })
  return confirm
}

const shoot = async (page, name) => {
  await page.screenshot({ path: path.join(SHOT_DIR, name), fullPage: false })
  console.log(`    → 截图 docs/ui/${name}`)
}

const runScenario = async (browser, width, archivePath) => {
  const viewport = VIEWPORTS[width]
  const context = await browser.newContext({
    locale: 'zh-CN',
    viewport,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  })
  const page = await context.newPage()
  const pageErrors = []
  const requestFailures = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  page.on('requestfailed', (request) => {
    // dev server 的 HMR 长连接在关闭上下文时会被记一条，与被测通路无关，排除掉
    if (request.url().startsWith(APP_URL)) {
      return
    }
    requestFailures.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? ''}`)
  })

  /**
   * 桩 `navigator.storage`：`estimate()` 的返回值由 `window.__STORAGE_MODE__` 决定。
   * 为什么桩它而不是造一个几百 MB 的包：验收要的是「空间不足时导入前就被拦」，
   * 而真实配额在小机器上不可控；桩掉的是**浏览器能力**（本来就是环境），不是被测代码。
   */
  await context.addInitScript(() => {
    window.__STORAGE_MODE__ = 'ok'
    const estimate = async () =>
      window.__STORAGE_MODE__ === 'blocked'
        ? { quota: 1000, usage: 999 } // 只剩 1 字节
        : { quota: 4 * 1024 * 1024 * 1024, usage: 0 }
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: { estimate, persist: async () => false, persisted: async () => false },
    })
  })

  await installEgressGate(page, { stubs: STARTUP_STUBS, appUrl: APP_URL })
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => window.localStorage.clear())
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(900)

  console.log(`\n=== 视口 ${width} · A 空间不足：导入前就被拦 ===`)
  await page.evaluate(() => {
    window.__STORAGE_MODE__ = 'blocked'
  })
  let fileInput = await openImportRow(page)
  let confirm = await pickFile(page, fileInput, archivePath)
  await startSampler(page)
  await confirm.getByRole('button', { name: '确认导入', exact: true }).click()
  const blocked = page.getByText(/设备剩余空间不足/)
  await blocked.first().waitFor({ timeout: 20000 })
  const blockedText = (await blocked.first().textContent()) ?? ''
  check('出现「设备剩余空间不足」的拒绝文案', /设备剩余空间不足/.test(blockedText), blockedText)
  check(
    '文案说出「还差多少」与「当前可用多少」（数字插值，不是写死的）',
    /还差\s*[\d.]+\s*(B|KB|MB)/.test(blockedText) && /当前可用\s*[\d.]+\s*(B|KB|MB)/.test(blockedText),
    blockedText
  )
  const blockedCounts = await dbCounts(page)
  check('一个会话都没入库', blockedCounts.sessions === 0, JSON.stringify(blockedCounts))
  check('暂存也是空的（压根没开始写）', blockedCounts.sessionsStaging === 0, JSON.stringify(blockedCounts))
  const blockedSamples = await readSamples(page)
  check(
    '被拦时进度条没有跑到中间（拒绝发生在导入之前）',
    blockedSamples.every((sample) => sample.percent === null || sample.percent === 0),
    JSON.stringify(blockedSamples.map((sample) => sample.percent).slice(-5))
  )
  check('侧栏没有出现导入的会话', (await page.getByText(new RegExp(TITLE_PREFIX)).count()) === 0)
  await shoot(page, `import-quota-blocked-${width}.png`)

  console.log(`\n=== 视口 ${width} · B 空间充足：进度条 0 → 100 ===`)
  // 同一页面再来一次：这次 estimate 给足配额
  await page.getByRole('button', { name: /关闭|Close|取消/ }).first().click().catch(() => {})
  await page.evaluate(() => window.localStorage.clear())
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(900)
  await page.evaluate(() => {
    window.__STORAGE_MODE__ = 'ok'
  })
  fileInput = await openImportRow(page)
  confirm = await pickFile(page, fileInput, archivePath)
  await startSampler(page)
  const startedAt = Date.now()
  await confirm.getByRole('button', { name: '确认导入', exact: true }).click()

  // 抓一张「进度条在中间」的截图：等到会话数 > 0 且 < 总数
  let midShot = false
  const deadline = Date.now() + 120000
  while (Date.now() < deadline) {
    const samples = await readSamples(page)
    const mid = samples.find(
      (sample) =>
        sample.percent !== null && sample.percent > 0 && sample.percent < 100 && sample.sessions !== null
    )
    if (mid && !midShot) {
      await shoot(page, `import-progress-${width}.png`)
      console.log(`    → 中间态：${mid.text}（进度条 ${mid.percent}%）`)
      midShot = true
    }
    if ((await page.getByText(new RegExp(`已导入 ${SESSIONS} 个会话`)).count()) > 0) {
      break
    }
    await page.waitForTimeout(60)
  }
  await page.getByText(new RegExp(`已导入 ${SESSIONS} 个会话`)).waitFor({ timeout: 60000 })
  const elapsed = Date.now() - startedAt
  check('出现「已导入 N 个会话」的完成提示', true, `${elapsed}ms`)
  console.log(`    → 整段导入耗时 ${elapsed}ms，采样 ${(await readSamples(page)).length} 条`)
  check('抓到了进度条的中间态（不是 0 → 100 一步到位）', midShot)

  const samples = await readSamples(page)
  const percents = samples.map((sample) => sample.percent).filter((value) => value !== null)
  check('进度条百分比单调不减', percents.every((value, index) => index === 0 || value >= percents[index - 1]), JSON.stringify(percents))
  check('进度条最后到达 100%', percents.at(-1) === 100, String(percents.at(-1)))
  check('进度条确实从 0 起步', Math.min(...percents) === 0, String(Math.min(...percents)))

  // 只取真的带「n/总数」的帧：`sessions` 为 null 的帧用 Number(null)=0 会伪造出一个 0，破坏单调性
  const sessionCounts = samples
    .filter((sample) => sample.sessions !== null)
    .map((sample) => Number(sample.sessions))
  check('「已处理 X/Y 个会话」的 X 单调不减', sessionCounts.every((value, index) => index === 0 || value >= sessionCounts[index - 1]))
  check(
    '文案里的会话总数 = 包里的会话数',
    samples.some((sample) => sample.total === String(SESSIONS)),
    JSON.stringify(samples.map((sample) => sample.total).filter(Boolean).slice(-3))
  )
  check(
    '文案里的已处理会话数真的走到了 N（最后一个中间态 = 总数）',
    Math.max(...sessionCounts) === SESSIONS,
    String(Math.max(...sessionCounts))
  )
  const doneCounts = await dbCounts(page)
  check(`导入后库里会话数 = ${SESSIONS}`, doneCounts.sessions === SESSIONS, JSON.stringify(doneCounts))
  await shoot(page, `import-completed-${width}.png`)

  console.log(`\n=== 视口 ${width} · C 中途取消：不留半截数据 ===`)
  await page.getByRole('button', { name: /关闭|Close|取消/ }).first().click().catch(() => {})
  await page.evaluate(() => window.localStorage.clear())
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(900)
  await page.evaluate(() => {
    window.__STORAGE_MODE__ = 'ok'
  })
  const before = await dbCounts(page)
  fileInput = await openImportRow(page)
  confirm = await pickFile(page, fileInput, archivePath)
  await confirm.getByRole('button', { name: '确认导入', exact: true }).click()
  // 等到真的开始逐会话入库（暂存里已经有东西）再点取消：空手取消证明不了清理
  await page.waitForFunction(
    () =>
      new Promise((resolve) => {
        const request = indexedDB.open('chat-demo')
        request.onsuccess = () => {
          const db = request.result
          if (!db.objectStoreNames.contains('sessionsStaging')) {
            resolve(false)
            return
          }
          const count = db.transaction('sessionsStaging', 'readonly').objectStore('sessionsStaging').count()
          count.onsuccess = () => resolve(count.result > 5)
          count.onerror = () => resolve(false)
        }
        request.onerror = () => resolve(false)
      }),
    undefined,
    { timeout: 60000 }
  )
  await shoot(page, `import-cancelled-${width}.png`)
  await confirm.getByRole('button', { name: '取消', exact: true }).click()
  await page.waitForTimeout(2500)
  const after = await dbCounts(page)
  check(
    '取消后列表没有新增（正式库会话数不变）',
    after.sessions === before.sessions,
    `${before.sessions} → ${after.sessions}`
  )
  check('取消后暂存被清空（不留半截数据）', after.sessionsStaging === 0, JSON.stringify(after))
  check('取消后没有出现「已导入」提示', (await page.getByText(/已导入 \d+ 个会话/).count()) === 0)

  check(`视口 ${width}：pageerror = 0`, pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
  check(`视口 ${width}：requestfailed = 0`, requestFailures.length === 0, requestFailures.slice(0, 3).join(' | '))

  await context.close()
}

const run = async () => {
  await mkdir(SHOT_DIR, { recursive: true })
  const dir = await mkdtemp(path.join(tmpdir(), 'import-quota-acceptance-'))
  const archivePath = path.join(dir, 'deepseek_data.zip')
  await writeFile(archivePath, buildArchiveZip({ sessionCount: SESSIONS, titlePrefix: TITLE_PREFIX }))
  console.log(`归档：${archivePath}（${SESSIONS} 条会话）`)

  const browser = await chromium.launch()
  try {
    for (const width of Object.keys(VIEWPORTS)) {
      await runScenario(browser, width, archivePath)
    }
  } finally {
    await browser.close()
  }

  assertNoEgress(failures)
  if (failures.length > 0) {
    console.error(`\nFAIL 导入配额 / 进度 / 取消验收：${failures.length} 条断言失败`)
    for (const failure of failures) {
      console.error(`  ✗ ${failure}`)
    }
    process.exit(1)
  }
  console.log('\nPASS 导入配额 / 进度 / 取消验收（390 / 360）')
}

await run()
