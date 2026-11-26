// [layer: golden | 依赖: playwright + chromium + 标准产物 dist | 预算: ≤60s]
//
// 黄金回归 · 域 10「更新」（Issue #404）。**只跑 1 条主路径**：
//   检查 → 解析清单 → 选对版本 → 下载校验
//
// 为什么这条进第一批：更新链路坏掉的后果是「用户永远收不到新版本」—— 不报错、不白屏，
// 只是安静地什么都不发生，最典型的静默回归。清单解析/筛选/排序的**算法细节**在 L0 已用矩阵钉住，
// 清单失败的分类文案在 L1（domain10-update-check-flow），这里只走「有一条能装的版本 → 选它 → 下载地址对」。
//
// 两台分发机都要 route 住：只拦一台时首选机一旦真的可达，用例会连真服务器（离线环境下表现为超时）。
//
// 跑法（仓库根目录）：pnpm run build && node tests/golden/g10-update.test.mjs
import { readFile } from 'node:fs/promises'

import {
  CURRENT,
  CHANNEL_BUILD_TYPE,
  NEWEST_INSTALLABLE,
  nextPatch,
} from '../helpers/current-version.mjs'
import { bodyText, brief, openGoldenPage, runGolden, serveGoldenApp, waitFor, waitForBoot } from '../helpers/golden.mjs'
import { openSettingsPage, SETTINGS_ROW } from '../helpers/helpers.mjs'

/**
 * 分发机地址：**唯一来源是 `config/endpoints.json`**（`src/services/updateManifest.ts` 的
 * `RELEASE_BASES` 就是构建期从它注入的，这里不抄第二份）。
 *
 * 改前这里写死的是 `http://62.106.70.167:8888` —— 那是 `legacyHosts` 里的旧机，产物早就不往那发了，
 * 于是桩永远不命中、请求一路出网。地址只有一个来源，桩才不会和产物各说各话。
 */
const ENDPOINTS = JSON.parse(await readFile(new URL('../../config/endpoints.json', import.meta.url), 'utf8'))
const PRIMARY = ENDPOINTS.download.primaryBase
const FALLBACK = ENDPOINTS.download.fallbackBase
/**
 * 当前产物版本（build-info.json / __APP_VERSION__）与「更高版本」一律从 tests/helpers/current-version.mjs
 * 派生 —— 版本号只有一个来源（package.json），用例里不抄第二份。
 */
const NEW_VERSION = NEWEST_INSTALLABLE.version
const RELEASE_FILE = `apk/deepseek-chat-${NEW_VERSION}.apk`
const APK_BYTES = 5_452_595

const release = (over = {}) => ({
  version: NEW_VERSION,
  versionCode: NEWEST_INSTALLABLE.versionCode,
  size: APK_BYTES,
  file: RELEASE_FILE,
  changes: ['修复重试与离线提示'],
  buildType: CHANNEL_BUILD_TYPE,
  artifactVariant: 'standard',
  sha256: 'a'.repeat(64),
  ...over,
})

/**
 * 清单：三条记录各司其职 ——
 *   1) 与当前版本相同（不该被当成更新）
 *   2) versionCode 更高但缺 sha256（不可安装，不该被选中）
 *   3) 唯一可安装的新版本（= 期望被选中的那条）
 */
const RELEASES = [
  release({ version: CURRENT.version, versionCode: CURRENT.versionCode }),
  release({
    version: nextPatch(CURRENT.version, 2),
    versionCode: CURRENT.versionCode + 2,
    sha256: undefined,
  }),
  release(),
]

/**
 * 原生桥桩（Capacitor 替身）—— **「检查更新」只在 APK 里落地**（见 `AppVersionField` 的注释：
 * 2026-11-23 起 Web 端只显示版本号，不渲染检查按钮，因为浏览器没有 APK 安装器）。
 *
 * 所以这条主路径必须在 `android` 平台下走：`window.androidBridge` 存在即可让
 * `Capacitor.getPlatform()` 返回 `android`。之后清单不再由浏览器 fetch，而是由**原生侧**回包
 * （`nativeUpdate.manifest()` → `{ body, base }`），所以清单桩挂在桥上、不挂在 route 上 ——
 * 这也正是 APK 的真实链路；把清单留在 `page.route` 里只证明「网页预览能查」，那条链已经不存在了。
 *
 * `download` 只记录参数并立刻回 `{cached:false}`：真机上它把 APK 落到私有目录再交给安装器，
 * 浏览器里没有安装器可交，用例要钉的是「**下发给原生的是哪一条地址 / 哪一份字节校验**」。
 */
const androidUpdateBridgeStub = ({ installed, releases, base }) => {
  window.androidBridge = { postMessage: () => {} }
  const state = { downloads: [], listeners: 0 }
  window.__goldenUpdate = state
  window.Capacitor = {
    PluginHeaders: [
      {
        name: 'AppUpdate',
        methods: [
          { name: 'installed', rtype: 'promise' },
          { name: 'manifest', rtype: 'promise' },
          { name: 'download', rtype: 'promise' },
          { name: 'cancel', rtype: 'promise' },
          { name: 'install', rtype: 'promise' },
          // 进度回调：原生是 callback 语义，核心层会把它包成 `{ remove }` 句柄
          { name: 'addListener', rtype: 'callback' },
        ],
      },
    ],
    nativePromise: async (plugin, method, options) => {
      if (plugin !== 'AppUpdate') {
        return {}
      }
      if (method === 'installed') {
        return installed
      }
      if (method === 'manifest') {
        return { body: JSON.stringify({ releases }), base }
      }
      if (method === 'download') {
        state.downloads.push({ ...options })
        return { cached: false }
      }
      if (method === 'install') {
        return { status: 'installer-opened' }
      }
      return {}
    },
    nativeCallback: async (plugin, method) => {
      if (plugin === 'AppUpdate' && method === 'addListener') {
        state.listeners += 1
        return `g10-listener-${state.listeners}`
      }
      return undefined
    },
  }
}

/** APK 本体：给固定字节数，让「下载校验」能真的取到东西（地址由清单 base + file 拼出） */
const artifactStubs = () => [
  // APK 本体：给固定字节数，让「下载校验」能真的取到东西
  {
    name: 'apk-primary',
    host: new URL(PRIMARY).host,
    path: `/${RELEASE_FILE}`,
    respond: () => ({
      status: 200,
      headers: { 'content-type': 'application/vnd.android.package-archive' },
      body: Buffer.alloc(APK_BYTES, 7),
    }),
  },
]

/** 页面内取数：结论行 + 版本号 + 下载入口 */
const probe = () =>
  (() => {
    const dialog = [...document.querySelectorAll('[role="dialog"]')].pop() ?? null
    const link = [...(dialog?.querySelectorAll('a') ?? [])].find((item) => (item.textContent ?? '').includes('下载 APK'))
    return {
      dialogOpen: dialog !== null,
      status: document.querySelector('[role="status"]')?.textContent?.trim() ?? '',
      title: dialog?.querySelector('h3')?.textContent?.trim() ?? '',
      linkText: (link?.textContent ?? '').trim(),
      linkHref: link?.getAttribute('href') ?? '',
    }
  })()

const result = await runGolden(
  { id: 'G10', domain: '更新', title: '检查 → 解析清单 → 选对版本 → 下载校验' },
  async (ctx) => {
    const app = await serveGoldenApp()
    const { page, close, guard } = await openGoldenPage(app.url, {
      storage: { 'chat-demo:api-key': 'sk-golden-g10' },
      // 平台伪装成 android（`window.androidBridge`）：设置里那一格才会渲染「检查更新」
      initScripts: [
        {
          fn: androidUpdateBridgeStub,
          arg: {
            installed: { version: CURRENT.version, versionCode: CURRENT.versionCode, artifactVariant: 'standard' },
            releases: RELEASES,
            base: PRIMARY,
          },
        },
      ],
      // APK 本体：按 host + path 登记（#667 跟进）；清单走原生桥，不走 route
      backends: { stubs: artifactStubs() },
    })
    try {
      await waitForBoot(page)

      // ── 1. 打开「设置 → 关于（应用更新）」──────────────────────────────────────
      // 2026-11-24 设置改版后是「一级列表 + 二级页」：`role=tab` 的「数据管理 / 关于」整排没了，
      // 「检查更新」按钮在二级页 `settings-page-update` 里。走 helpers 的唯一路径（不自己点 DOM）。
      ctx.begin('打开检查更新')
      await openSettingsPage(page, SETTINGS_ROW.update)
      const entry = page.getByRole('button', { name: '检查更新', exact: true })
      const entryReady = await waitFor(page, async () => (await entry.count()) > 0)
      if (!entryReady) {
        ctx.abort('设置里「应用更新」页有「检查更新」入口', '按钮「检查更新」存在', `body=${brief(await bodyText(page))}`)
      }
      await entry.first().click()

      // ── 2. 解析清单：自动检查后给出「发现新版本」的结论 ────────────────────────
      ctx.begin('解析清单')
      const concluded = await waitFor(page, async () => (await page.evaluate(probe)).status.includes('发现新版本'))
      const seen = await page.evaluate(probe)
      if (!concluded) {
        ctx.abort('清单解析出结论', 'status 含「发现新版本」', `status=${brief(seen.status)}`)
      }

      // ── 3. 选对版本：可安装的最新版（versionCode 更高但缺 sha256 的那条不算） ────
      ctx.begin('选对版本')
      ctx.expect(`弹窗标题是 ${NEW_VERSION}`, seen.title === NEW_VERSION, {
        expected: NEW_VERSION,
        actual: brief(seen.title),
      })
      ctx.expect('清单里的更新说明被渲染出来', (await bodyText(page)).includes('修复重试与离线提示'), {
        expected: 'body 含「修复重试与离线提示」',
        actual: `body=${brief(await bodyText(page))}`,
      })

      // ── 4. 下载校验：用户点「确认下载」→ 下发给原生的地址与校验值都对 ────────────
      //
      // 钉的是 `AppUpdate.download({ url, sha256, size, versionCode })` 这四项 —— 真机上原生侧就靠
      // 这份参数落包 + 校验，地址拼错 / 拿错版本 / 漏了 sha256 都不会当场报错，只会在安装那一步
      // 变成一个看不懂的失败。所以主路径把它当作**可断言的事实**钉在这里。
      ctx.begin('下载校验')
      const expectedHref = `${PRIMARY}/${RELEASE_FILE}`
      const confirmDownload = page.getByRole('button', { name: '确认下载', exact: true })
      const confirmReady = await waitFor(page, async () => (await confirmDownload.count()) > 0)
      if (!confirmReady) {
        ctx.abort('弹窗底部给出下载入口', '按钮「确认下载」存在', `body=${brief(await bodyText(page))}`)
      }
      await confirmDownload.first().click()
      const dispatched = await waitFor(page, async () => (await page.evaluate(() => window.__goldenUpdate.downloads.length)) > 0)
      const downloads = await page.evaluate(() => window.__goldenUpdate.downloads)
      if (!dispatched) {
        ctx.abort('点「确认下载」真的下发给原生', 'AppUpdate.download ≥1 次', `downloads=${downloads.length}`)
      }
      ctx.expect('下发给原生的是选中版本的文件地址', downloads[0].url === expectedHref, {
        expected: expectedHref,
        actual: brief(String(downloads[0].url)),
      })
      const selected = RELEASES[2]
      ctx.expect('下发的校验值/体积/版本号就是选中那一条的（拿错版本会在这里红）', downloads[0].sha256 === selected.sha256 && downloads[0].size === selected.size && downloads[0].versionCode === selected.versionCode, {
        expected: `sha256=${selected.sha256.slice(0, 8)}… / size=${selected.size} / versionCode=${selected.versionCode}`,
        actual: `sha256=${String(downloads[0].sha256).slice(0, 8)}… / size=${downloads[0].size} / versionCode=${downloads[0].versionCode}`,
      })
      // 那条地址真的能取到整包（不是 404 / 半截）。必须在页面里 fetch：分发机跨域，靠桩给的 CORS 头；
      // APIRequestContext 不走 context.route。
      const downloaded = await page.evaluate(
        async (href) => {
          const response = await fetch(href, { signal: AbortSignal.timeout(15000) })
          const bytes = await response.arrayBuffer()
          return { status: response.status, bytes: bytes.byteLength }
        },
        expectedHref
      )
      ctx.expect('该地址返回完整包体', downloaded.status === 200 && downloaded.bytes === APK_BYTES, {
        expected: `HTTP 200 且 ${APK_BYTES} 字节`,
        actual: `HTTP ${downloaded.status} / ${downloaded.bytes} 字节`,
      })

      // ── 出站总闸（#667 跟进）：整条路径没有一条请求漏到白名单之外 ──────────────
      ctx.begin('不连真实服务')
      guard.assertNoLeak(ctx)
    } finally {
      await close()
      await app.close()
    }
  }
)

export default result
