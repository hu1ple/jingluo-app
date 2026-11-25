/**
 * **安卓通道的更新桥替身**（域10 的 L1 用例用；`d22009fa` 之后必须这么测）。
 *
 * ## 为什么需要它
 *
 * `d22009fa`（「Web 端只显示版本，不渲染检查更新（内置更新仅 APK）」）之后，`SettingsDialog` 按
 * `isAndroidUpdate()` 二选一：**网页构件里整块 `AppUpdateField` 都不渲染**。也就是说
 * 「检查更新 → 清单 → 结论 → 下载」这条链路，产品里**只剩安卓通道**。
 *
 * 只把 `window.androidBridge = {}` 装上（Capacitor 判平台就是看这个）还不够：安卓通道取清单走的是
 * **原生插件** `AppUpdate.manifest()`（`src/services/appUpdate.ts` 的 `nativeUpdate`），
 * 浏览器里没有这个插件，`registerPlugin()` 的代理会按 `Unimplemented` 抛错 ——
 * 界面停在「未预期的错误」，用例红在「插件没有实现」，而不是「更新逻辑坏了」。
 *
 * ## 它替的是什么（只替原生那一层，不替被测物）
 *
 * 安卓 WebView 里是**原生侧**往页面注入两样东西，这里照原样注入：
 *   1. `window.androidBridge`（`getPlatformId()` 据此返回 `'android'`）；
 *   2. `window.Capacitor.PluginHeaders`（插件方法表 —— 有它 `registerPlugin()` 才会把方法转发给原生）
 *      与 `window.Capacitor.nativePromise`（原生调用通道）。
 *
 * `@capacitor/core` 的 `createCapacitor(win)` 保留 `win.Capacitor` 上已有的 `PluginHeaders` /
 * `nativePromise`（只覆写 `getPlatform` / `registerPlugin` 等），所以这两样在页面脚本之前注入即可生效。
 * 被测的 JS（`AppUpdateField` + `check()` + `selectUpdate` + `parseManifest` + 失败分类）
 * **逐行真跑**；被替掉的只有 `AppUpdatePlugin.java` 那一层（与 N5 的 harness 同一分工，
 * 那个 harness 换的是模块，这里换的是通道 —— 效果等价，且不需要另建产物）。
 *
 * ## 分工（别混淆）
 *
 * - **N4 / `update-dialog-517`**（本文件的用户）：真产物 + 真组件，只把原生桥换成剧本；
 * - **N5 / `domain10-update-install-flow`**：rspack alias 换 `@capacitor/core`，连下载 / 安装的
 *   进度事件都编排（那需要 `addListener` 回调可控，只能走模块替身）。
 *
 * ## 剧本（`plan`）形状
 *
 * ```js
 * { installed: { version, versionCode, artifactVariant },      // 设备上装的版本
 *   manifest: { body, base }                                   // 原生侧「真的回了清单」的那台机器
 *           | { error: 'MANIFEST_HTTP_503' } }                 // 原生侧失败：短码与产品同一套（updateFailure.ts）
 * ```
 *
 * 每次原生调用都记账在 `window.__nativeCalls`（`{ method, args }`），用例据此断言
 * 「重查了几次」这类事实（原生通道上没有 fetch，`page.on('request')` 看不到清单请求）。
 */

/** 安卓 WebView 注入的插件方法表（`rtype: 'promise'` = 走 `nativePromise`） */
const METHODS = ['installed', 'manifest', 'download', 'cancel', 'install', 'addListener', 'removeListener']

/**
 * 给 `context`（或 `page`）装上安卓通道 + 更新桥替身。**必须在 `page.goto()` 之前调用。**
 *
 * @param {import('playwright').BrowserContext | import('playwright').Page} scope
 * @param {{installed?: object, manifest?: object}} [plan]
 */
export const installNativeUpdateBridge = async (scope, plan = {}) => {
  await scope.addInitScript(
    ({ plan, methods }) => {
      // ① Capacitor 判平台的依据（`getPlatformId()`：有 androidBridge → 'android'）
      window.androidBridge = {}
      // ② 原生侧注入的插件表与调用通道（`@capacitor/core` 会保留这里已有的一切）
      const cap = (window.Capacitor = window.Capacitor || {})
      cap.PluginHeaders = [{ name: 'AppUpdate', methods: methods.map((name) => ({ name, rtype: 'promise' })) }]
      window.__nativeCalls = []
      const calls = window.__nativeCalls
      const manifest = plan.manifest ?? { body: JSON.stringify({ releases: [] }) }
      cap.nativePromise = async (plugin, method, args) => {
        // 每次调用都记账；`manifest` 额外记下剧本回给 JS 的那台机器（用例据此断「来源有没有漂」）
        calls.push({ plugin, method, args, ...(method === 'manifest' && !manifest.error ? { base: manifest.base } : {}) })
        if (plugin !== 'AppUpdate') {
          throw new Error('UNEXPECTED_PLUGIN:' + plugin)
        }
        if (method === 'installed') {
          return plan.installed ?? { version: '0.0.0', versionCode: 0, artifactVariant: 'standard' }
        }
        if (method === 'manifest') {
          if (manifest.error) {
            // 原生侧失败是以**短码**回来的（`AppUpdatePlugin.java` → `updateFailure.ts` 的分类表）
            throw new Error(manifest.error)
          }
          return { body: manifest.body, base: manifest.base }
        }
        throw new Error('UNEXPECTED_METHOD:' + method)
      }
    },
    { plan, methods: METHODS }
  )
}

/**
 * 「两台分发机的清单剧本」→ 原生桥剧本。
 *
 * 为什么要在用例侧做这一步：`UpdateEndpoint.java` 的「先新机后旧机」是**原生实现**，
 * L1 的 JS 用例测不到它（那是 N5 / 真机的活）。所以这里按原生层同样的口径把它演一遍：
 * 首选机失败就试备用机；备用机也失败，就把备用机那次的状态码当短码抛出去（`MANIFEST_HTTP_<code>`）。
 *
 * @param {{primary?: object, fallback?: object}} plan 一行可以给 {status, releases} / {status, body}
 * @param {{primary: string, fallback: string}} bases 两台机器的 base（来自 config/endpoints.json）
 * @param {(releases: unknown[]) => string} bodyOf 把 releases 序列化成清单正文
 */
export const nativeManifestPlan = (plan, bases, bodyOf) => {
  const read = (spec) => {
    const value = typeof spec === 'function' ? spec() : spec
    return value ?? { status: 200, releases: [] }
  }
  const toBody = (value) =>
    value.releases ? bodyOf(value.releases) : (value.body ?? bodyOf([]))
  const primary = read(plan.primary)
  const primaryOk = (primary.status ?? 200) === 200
  if (primaryOk) {
    return { body: toBody(primary), base: bases.primary }
  }
  const fallback = read(plan.fallback)
  const fallbackOk = (fallback.status ?? 200) === 200
  if (fallbackOk) {
    // 原生回退成功：base 是「真的回了清单」的那台（备用机）
    return { body: toBody(fallback), base: bases.fallback }
  }
  return { error: `MANIFEST_HTTP_${fallback.status ?? 503}` }
}
