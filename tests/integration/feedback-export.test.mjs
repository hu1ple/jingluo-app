// [layer: integration | isolated mobile viewport; no device or real backend]
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { serveDir, verifyDist } from '../helpers/env.mjs'
import { assertNoEgress, installEgressGate } from '../helpers/helpers.mjs'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
// 需要**标准包**（本用例要能打开反馈弹窗，内测包把入口钉死）。默认用 dist-standard，
// 与「dist 里放内测包」的用例互不干扰；按 main 的约定不隐式构建，缺产物就 SKIP(env) 并给出构建命令。
const STANDARD = process.env.DIST_STANDARD_DIR || path.join(root, 'dist-standard')
// 环境守卫：产物缺失 / 陈旧 / 种类不对 → SKIP(env)，不产生假红（Issue #19）
await verifyDist(STANDARD, { variant: 'standard' })
// 端口自动发现（PORT 可注入），避免固定端口撞车
const served = await serveDir(STANDARD, { port: process.env.PORT, label: '标准产物 dist-standard' })
const port = served.port
/** #686：出站总闸的失败会收进这里，再下面用一条 assert 定成红 */
const failures = []
/**
 * 「设置层在场吗」——按设置层自己的标识判，**不是**按「屏幕上有没有一层 `role="dialog"`」。
 *
 * 为什么必须这样：公告弹层（`settings-announcement-popup`）、启动更新提示（`StartupUpdatePrompt`）、
 * 分支确认（`SessionBranchDialog`）、图片预览、附件面板**都**是 `Modal` → 都带 `role="dialog"`。
 * 用 dialog 计数当「设置开着」，等于把这五个东西当成同一个 —— 2026-11-25 那条
 * 「无 Key 首启自动打开设置」的过期断言就是靠公告弹层蒙过去的。
 *
 * 设置层自己的两个标识（`src/components/settings/SettingsDialog.tsx`）：
 * 一级列表 `settings-list`、二级页 `settings-page-<page>`。两者有一个在，设置层就在。
 */
const SETTINGS_LAYER = '[data-testid="settings-list"], [data-testid^="settings-page-"]'
const settingsLayer = (scope) => scope.locator(SETTINGS_LAYER)
const browser = await chromium.launch({ headless: true })
try {
  const context = await browser.newContext({ viewport: { width: 393, height: 851 }, isMobile: true, deviceScaleFactor: 1, locale: 'zh-CN', acceptDownloads: true })
  /**
   * 场景前提：**产物一开屏就是「已配置」**（种一把官方 Key），本用例只测「离线导出日志」。
   *
   * 为什么要种：`TEST_AUTH_SEAM=1` 让产物认为已登录，于是**未配置**的首屏会走 #803
   * 「登录后自动领内置 Key」→ 两条真实的 `GET https://apia.ecsafe.cn/api/v1/keys?search=app-<设备前缀>`
   * （实测：不种 Key 时首屏就有 2 次出站）。那既不是本用例的对象，也会让下面「0 次真实出网」
   * 的断言红在一个与本用例无关的链路上。种了之后总闸实测 0 次出站 —— 断言的含义没变，
   * 依然是「导出这条路一次网都不许出」。
   */
  await context.addInitScript(() => {
    window.localStorage.setItem('chat-demo:provider-kind', 'deepseek')
    window.localStorage.setItem('chat-demo:api-key', 'sk-testkey-feedback-export')
  })
  const page = await context.newPage()
  /**
   * #686：出站总闸，**必须在 `page.goto` 之前**装上（首屏请求一旦发出去就收不回来，#673 的 g16 就是这么漏的）。
   *
   * 以前这里还有一条 `context.route(/feedback\.rose7\.cn/, abort)` —— 只认 host 的连接级拦截，
   * **没有任何断言**：别的 host 漏出去照样绿，连「它到底拦到过东西没有」都无从判断。
   * 接上总闸后实测：本用例的出站**一次都没到过 `feedback.rose7.cn`**（传输层已被
   * `setFeedbackTransport` 换成 offline 桩），那条 abort 是死代码，已由总闸取代 —— 真有人
   * 开始往那儿发，总闸会**记录 + abort + 断言点名**，比静默 abort 严格，不是放宽。
   */
  await installEgressGate(page, { appUrl: `http://127.0.0.1:${port}` })
  for (let tries = 0; ; tries++) {
    try { await page.goto(`http://127.0.0.1:${port}/?diag-debug`); break } catch (error) { if (tries > 10) throw error }
  }
  await page.waitForFunction(() => !!window.__diagnostics)
  await page.evaluate(() => {
    // Focused legacy-engine capability test: export must not rely on these APIs.
    Array.prototype.toSorted = undefined
    Array.prototype.toReversed = undefined
    Blob.prototype.stream = undefined
    window.TextEncoder = undefined
    window.__diagnostics.setFeedbackTransport({ name: 'offline-test', send: async () => ({ ok: false, error: 'network' }) })
    window.__diagnostics.recordError('offline-test marker', { 'http.status': 503, token: 'PRIVATE_TOKEN', content: 'PRIVATE_CHAT' })
  })
  // 进设置：**按设置层自己的标识**等它出现，而不是「屏幕上有没有一层 role=dialog」。
  // 改前这里写的是 `if (dialog 数为 0) { 点 /侧边栏|菜单|sidebar|menu/ → 点设置 }`，两个问题叠在一起：
  //   1) 那个分支从来没执行过 —— 它靠的是「无 Key 首启会自动弹设置」这个**已废掉的旧行为**
  //      （2026-11-25 产品决定：压根不自动打开设置）。也就是说里面那行失效的选择器
  //      `/侧边栏|菜单|sidebar|menu/` 一直是死代码：本仓的抽屉开关文案是「打开边栏 / 收起边栏」
  //      （i18n `expandSiderbarButton` / `collapseSiderbarButton`），一个都不匹配。
  //      旧行为一撤，分支开始真的执行，于是这条用例当场红在「找不到菜单按钮」。
  //   2) 「有 dialog」不等于「设置开着」：公告弹层（`settings-announcement-popup`）和启动更新提示
  //      也都是 `role="dialog"`，共用 `Modal`。靠 dialog 计数判断会把它们当成设置层。
  // 现在它守护的事：**从首屏走到「设置 → 数据管理 → 写反馈」这条路必须点得通**（不是「碰巧已经开着」）。
  if ((await settingsLayer(page).count()) === 0) {
    const expandSidebar = page.getByRole('button', { name: /^(打开边栏|Open sidebar)$/ })
    if ((await expandSidebar.count()) > 0) {
      await expandSidebar.first().click()
    }
    await page.getByRole('button', { name: /^设置$|^Settings$/ }).first().click()
  }
  await settingsLayer(page).first().waitFor({ state: 'visible', timeout: 10_000 })
  // 设置改版（2026-11-24）后是「一级列表 + 二级页」：「数据管理」是列表里的一行
  // （`settings-row-data`），不再是 `role="tab"` —— 全仓已经没有任何 role=tab 了。
  await page.getByTestId('settings-row-data').first().click()
  await page.getByRole('button', { name: /写反馈/ }).first().click()
  // 反馈弹层按自己的标题认（`Modal` 用 `aria-labelledby` 把标题挂成可访问名），
  // 不用 `.last()`：同一时刻屏幕上有设置层 + 反馈层两层 dialog，位置/顺序不是身份。
  const form = page.getByRole('dialog', { name: /^(反馈与日志|Feedback & logs)$/ })
  const save = form.getByRole('button', { name: '保存日志文件' })
  await save.waitFor({ state: 'visible' })
  const out = path.join(root, 'docs/ui')
  await mkdir(out, { recursive: true })
  await page.screenshot({ path: path.join(out, 'feedback-export-mobile.png') })
  // Blank description is valid for local export; HTTP is entirely offline from here.
  await context.setOffline(true)
  const firstDownload = page.waitForEvent('download')
  await save.click()
  const first = await firstDownload
  // 版本号取自构建产物本身（rspack 注入的 meta[name=application-version]），
  // 不再硬编码：以前写死 v1.4.0-beta.6，发到 beta.7 就假红（Issue #19）。
  const buildVersion = await page.evaluate(
    () => document.querySelector('meta[name="application-version"]')?.content ?? '',
  )
  assert.ok(buildVersion, '构建产物缺少 meta[name=application-version]（产物陈旧或不是本仓库构建）')
  assert.match(
    first.suggestedFilename(),
    new RegExp(`deepseek-feedback-.*v${buildVersion.replace(/\./g, '\\.')}\\.json$`),
  )
  const firstText = await readFile(await first.path(), 'utf8')
  assert.ok(!firstText.includes('PRIVATE_TOKEN'))
  assert.ok(!firstText.includes('PRIVATE_CHAT'))
  assert.equal(JSON.parse(firstText).delivery, 'local-only-not-submitted')
  await form.locator('#feedback-description').fill('Form text stays local on failed upload')
  await form.locator('#feedback-contact').fill('private@example.org')
  await form.getByRole('button', { name: /^提交$/ }).click()
  await form.getByRole('alert').waitFor()
  assert.ok(await save.isEnabled())
  await page.screenshot({ path: path.join(out, 'feedback-export-after-upload-failure-mobile.png') })
  const nextDownload = page.waitForEvent('download')
  await save.click()
  const downloaded = await nextDownload
  const text = await readFile(await downloaded.path(), 'utf8')
  const data = JSON.parse(text)
  assert.equal(data.lastSubmissionFailure.code, 'network')
  assert.ok(!text.includes('Form text stays local'))
  assert.ok(!text.includes('private@example.org'))
  assert.equal(await form.locator('#feedback-description').inputValue(), 'Form text stays local on failed upload')
  assert.ok(await form.getByRole('alert').isVisible())
  const snapshot = await page.evaluate(() => window.__diagnostics.getDiagnosticsSnapshot())
  assert.ok(snapshot.logs.length > 0)
  assert.ok(!snapshot.logs.some(entry => entry.msg.includes('feedback-accepted')))
  await writeFile(path.join(out, 'feedback-export-sample.json'), text)
  // #686：收尾断言「漏出 = 0」—— 本用例把传输层换成了 offline 桩，一次都不该真发出去
  assertNoEgress(failures)
  assert.deepEqual(failures, [], `出站总闸未通过：${failures.join('；')}`)
  console.log('PASS: mobile offline blank export + upload failure export; privacy; description/logs retained; no accepted event')
} finally { await browser.close(); served.kill() }
