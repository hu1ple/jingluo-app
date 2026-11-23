/**
 * 「我们的渠道」的传输层：原生走 CapacitorHttp，Web 走 fetch。
 *
 * 为什么放在单独文件：api.ts / invite/api.ts 是纯逻辑（Node 单测直接 import），
 * 而 @capacitor/core 只在这里出现，Web 端 fetch 也可以被 Playwright 的 page.route 打桩，
 * CORS 失败只当作「网络不可用」，不影响业务逻辑本身。
 *
 * 这一层对外的东西：
 *  - `httpTransport`        业务默认传输：**不跟随重定向**（原生 disableRedirects、Web redirect:'manual'）
 *  - `openPayLinkInApp`     **原生**：在 App 内浏览器打开联动小铺收款页（Issue #331）
 *  - `openPayPlaceholder` / `navigatePayTab` / `closePayPlaceholder`
 *                           **Web**：两段式打开收款页（占位 → 导航），见下面那一节的注释
 *
 * 为什么 Web 要拆成两段（#331 之后的新裁决，改的是「绝不 window.open」那条老禁令）：
 * 老禁令的理由是「整页跳走会把 App 状态弄丢」——那条**仍然成立**，`window.location` 依然禁止。
 * 但 Web 端没有 `@capacitor/browser`，照老裁决就等于「网页版永远买不了」。所以现在放行的是
 * **有控制的新标签页**：标签页由脚本在用户点击的同步栈里 `open()` 出来（拿得到句柄、能导航、
 * 导航失败能关掉），本页（App）保持原样不动 —— 不是 `window.location` 那种整页跳走。
 *
 * Issue #331：支付切到联动小铺后我们**不再建单、也不再读收银台的 302 Location**，
 * 所以原来的 `openCheckout`（系统浏览器）/ `navigateTopLevel`（网页版顶层跳 `/buy`）/
 * `withBuyCustomerId`（给 `/buy` 补 cid）连同 `CheckoutBrowser.resolveLocation` 一起删除。
 * 收款页地址由 `/api/pay-link` 下发，App 内打开即可；付款后卡密由小铺直接发给买家。
 */
import { Capacitor, CapacitorHttp } from '@capacitor/core'
import { isOpenableCheckout, type OursHttpRequest, type OursHttpResult } from './api.js'

export const isNativePlatform = (): boolean => Capacitor.isNativePlatform()

const TIMEOUT_HINTS = ['timeout', 'timed out', 'time out']

const reasonOf = (error: unknown): 'timeout' | 'network' => {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error)
  const lower = text.toLowerCase()
  return lower.includes('abort') || TIMEOUT_HINTS.some((hint) => lower.includes(hint))
    ? 'timeout'
    : 'network'
}

const nativeRequest = async (request: OursHttpRequest): Promise<OursHttpResult> => {
  try {
    const response = await CapacitorHttp.request({
      url: request.url,
      method: request.method,
      headers: request.headers,
      // CapacitorHttp 会把对象序列化成 JSON；字符串原样发出，content-type 由 headers 决定
      data: request.body,
      responseType: 'text',
      connectTimeout: request.timeoutMs,
      readTimeout: request.timeoutMs,
      // 关键：不跟随重定向（业务接口自己解释 3xx，见文件头）
      disableRedirects: true,
    })
    const rawHeaders = (response.headers ?? {}) as Record<string, string>
    const location = (rawHeaders.location ?? rawHeaders.Location ?? '').trim()
    const text =
      typeof response.data === 'string' ? response.data : JSON.stringify(response.data ?? null)
    return { kind: 'response', status: response.status, text, location }
  } catch (error) {
    return { kind: reasonOf(error) }
  }
}

const webRequest = async (request: OursHttpRequest): Promise<OursHttpResult> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), request.timeoutMs)
  try {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      // 关键：不跟随重定向，状态码与 Location 由调用方自己解释
      redirect: 'manual',
      signal: controller.signal,
    })
    const location = response.headers.get('location') ?? ''
    const text = await response.text()
    return { kind: 'response', status: response.status, text, location }
  } catch (error) {
    return { kind: reasonOf(error) }
  } finally {
    clearTimeout(timer)
  }
}

/** 默认传输：原生 CapacitorHttp / Web fetch，两者都不跟随重定向 */
export const httpTransport = (request: OursHttpRequest): Promise<OursHttpResult> =>
  isNativePlatform() ? nativeRequest(request) : webRequest(request)

/**
 * Issue #331：在 App 内打开**联动小铺收款页**。
 *
 * `presentationStyle: 'popover'` —— iOS 卡片式内嵌、Android 全屏 WebView，**都在 App 内**，
 * 不会整页跳走（用户明确要求「页面内打开」）。所以这里**没有**系统浏览器降级：
 * 打不开就直接回 false，由界面给可读提示。
 *
 * Web（非原生）**不在这里开页**：这个函数的返回值被 `tests/unit/pay-link*.test.mjs` 钉成
 * 「非原生 → false」，而且 `window.open` 必须在用户点击的同步栈里（本函数是 async，已经晚了）。
 * Web 走下面的两段式（`openPayPlaceholder` + `navigatePayTab`），由 `BuyTab` 编排；
 * 无论哪一端都**不用 `window.location` 整页跳走**（那会把 App 的状态全丢掉）。
 *
 * 约定：
 *  - 只放行 https；非原生（Web / 没有插件）一律返回 false
 *  - `onClosed` **最多回调一次**（重复触发、关闭与打开失败并存都只算一次）
 *  - 监听在 `open` **之前**注册：页面打开得极快时也不会漏掉第一次关闭
 *  - 返回 false 时监听已经摘掉，不会给下一次打开留下一个假回跳
 *  - `onClosed` 只代表「用户回来了」，**不代表付款成功**（卡密由小铺直接发给买家）
 */
export const openPayLinkInApp = async (url: string, onClosed: () => void): Promise<boolean> => {
  if (!isNativePlatform() || !isOpenableCheckout(url)) {
    return false
  }
  // `@capacitor/browser` 用**动态**引入：网页构建和单测里根本没有这个插件，
  // 静态 import 会让它们连模块都加载不起来（真实症状：tests/unit 里 ENOENT data:…）。
  // 只有原生端真要点「去支付」时才需要它。
  let browser: typeof import('@capacitor/browser').Browser
  try {
    const mod = await import('@capacitor/browser')
    browser = mod.Browser
  } catch {
    return false
  }
  let handle: { remove: () => Promise<void> } | null = null
  let fired = false
  const detach = async (): Promise<void> => {
    const target = handle
    handle = null
    if (target === null) {
      return
    }
    try {
      await target.remove()
    } catch {
      // 摘不掉也不影响：fired 已经保证回调只跑一次
    }
  }
  const finish = (): void => {
    if (fired) {
      return
    }
    fired = true
    void detach()
    onClosed()
  }
  try {
    handle = await browser.addListener('browserFinished', () => finish())
  } catch {
    // 插件没装（老 APK / Web）→ 当作「没有内嵌浏览器」
    return false
  }
  try {
    await browser.open({ url, presentationStyle: 'popover' })
    return true
  } catch {
    // 打不开就摘掉监听再返回 false：否则下一次支付的 browserFinished
    // 会在这里凭空触发一次「用户回来了」，查一张没付过的单。
    await detach()
    return false
  }
}

// ─────────────────────────────── Web 端收款页：两段式打开（占位 → 导航） ─────────────────────

/**
 * Web 端收款页的标签页句柄。**只有 Web 分支拿得到**（原生 / 被拦截 → `null`）。
 *
 * 为什么不是一个裸 `Window`：调用方只需要「能导航、能关掉」两件事，包一层之后
 * `PayTab` 的出现就等于「这条链路已经确认是新标签页模式」，界面按它分支即可。
 */
export type PayTab = { readonly win: Window }

const escapeHtml = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

/**
 * 占位页的最小文档：**只有内联样式**，不引任何外部资源（可以是离线 / 弱网）。
 *
 * 为什么要有它：占位标签页从 `open()` 到真正拿到收款页地址之间有一段网络时延（/api/pay-link
 * 最长 10s），`about:blank` 白屏在那儿会让人以为「点了没反应」，于是再点一次、开出第二个标签页。
 * 文案由调用方传进来（走 i18n），这里只负责排版与转义。
 */
const payPlaceholderHtml = (notice: string): string => {
  const text = escapeHtml(notice)
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    `<title>${text}</title>` +
    '<style>html,body{margin:0;height:100%}' +
    'body{display:flex;align-items:center;justify-content:center;' +
    'font:16px/1.6 -apple-system,system-ui,"Segoe UI",sans-serif;color:#666;background:#fff}' +
    'p{margin:0;padding:0 24px;text-align:center}</style></head>' +
    `<body><p>${text}</p></body></html>`
  )
}

/**
 * **第一段**：在用户点击的**同步栈里**把标签页占出来（`BuyTab.openCheckout` 的第一行）。
 *
 * 为什么必须同步：`window.open` 只要脱离点击的同步栈（中间夹一个 `await` 就够了），
 * 主流浏览器一律按弹窗拦截。而收款页地址要等 `await fetchPayLink()` 回来，
 * 所以顺序只能是「先占位、拿到地址再导航」。
 *
 * 约定：
 *  - 原生 / 服务端渲染（没有 `window`）→ `null`（原生分支走 `openPayLinkInApp`，一个字都不变）
 *  - `window.open` 返回 `null` = 被弹窗拦截 → `null`，由界面给可读提示
 *    （**绝不**退回 `window.location` 整页跳走：那会丢掉 App 的状态）
 *  - 占位页写一句加载提示（上面那份内联文档），并立刻把 `opener` 断掉：
 *    收款页在小铺域名下，不该能通过 `window.opener` 反过来操作我们的页面
 *  - 占位**不代表**打开成功：拿不到地址时由调用方 `closePayPlaceholder()` 关掉
 */
export const openPayPlaceholder = (notice: string): PayTab | null => {
  if (isNativePlatform() || typeof window === 'undefined') {
    return null
  }
  let win: Window | null
  try {
    win = window.open('', '_blank')
  } catch {
    // 某些内嵌 WebView 的 `window.open` 直接抛（被禁用）：当作被拦截
    return null
  }
  if (win === null || win === undefined) {
    return null
  }
  try {
    // 断开 opener：这一句必须在导航**之前**（导航到小铺域名后就是跨源，读不到它的属性了）
    win.opener = null
    const doc = win.document
    doc.open()
    doc.write(payPlaceholderHtml(notice))
    doc.close()
  } catch {
    // 拿不到文档（已被用户关掉 / 浏览器限制）：不影响主流程 —— 导航会整页替换它的内容
  }
  return { win }
}

/**
 * **第二段**：把上一步的占位页导航到收款页地址。返回 `true` = 已发起导航。
 *
 * 约定：
 *  - **只放行 https**（复用 `isOpenableCheckout`：与原生分支同一道闸，明文地址不打开）
 *  - 占位页已经被用户关掉（`win.closed`）→ `false`，由界面给可读提示
 *  - 用 `location.replace`：收款页不占用标签页的历史记录，用户按后退不会退到一个空白的占位页
 *  - 失败**不降级**成 `window.location`（那会把本页整页跳走，App 状态全丢）
 */
export const navigatePayTab = (tab: PayTab, url: string): boolean => {
  if (!isOpenableCheckout(url)) {
    return false
  }
  try {
    if (tab.win.closed === true) {
      return false
    }
    tab.win.location.replace(url)
    return true
  } catch {
    return false
  }
}

/** 关掉占位页（取地址失败 / 导航失败 / 组件已卸载时清理）：`null` 无害，重复调用也安全 */
export const closePayPlaceholder = (tab: PayTab | null): void => {
  if (tab === null) {
    return
  }
  try {
    tab.win.close()
  } catch {
    // 已经关掉了 / 浏览器不让关：没别的事可做，也不该因此打断付款链路
  }
}
