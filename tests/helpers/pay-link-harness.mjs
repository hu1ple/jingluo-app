// #861 收款链接两条用例（`pay-link-861` / `pay-link-hardening-861`）共用的**装配**。
//
// 为什么要有它：两条用例的被测对象是同一对模块（`ours/api.ts` 的 `fetchPayLink` + `ours/transport.ts`
// 的 `openPayLinkInApp`），装配也逐字相同 —— `.js→.ts` 解析 + 原生浏览器替身 + 假 transport +
// 「与 BuyTab.openCheckout 同一条编排」的 `buyFlow`，35 行抄了两份（`check:test-duplication` 的 R1）。
// 两份副本漂成两种口径的风险是实的：`buyFlow` 里「成功才打开、失败只给文案」这条编排一旦只改一处，
// 另一处就在用另一条链路断言同一句文案。
//
// **抽出来的是装配，不是断言**：`response` / `fakeTransport` 的形状、`buyFlow` 的编排与返回字段、
// `resetStubs` 的复位面都与原来逐字相同；每条断言仍留在各自文件里（它们的意图不同：
// `pay-link-861` 守请求路径 / 状态码 → 文案，`pay-link-hardening-861` 守 URL 协议闸与失败信封）。
//
// 用法：
//
//   import { createPayLinkHarness } from '../helpers/pay-link-harness.mjs'
//   const { api, transport, zh, en, ROOT, cap, resetStubs, SHOP_URL, response, fakeTransport, buyFlow } =
//     await createPayLinkHarness({
//       stubs: {
//         '@capacitor/core': fixtureUrl('domain03-04/checkout-plugins.mjs'),
//         '@capacitor/browser': fixtureUrl('domain03-04/checkout-browser.mjs'),
//       },
//     })
//
// **替身表由调用方给，不从本文件里写死**：`tests/run-layer.mjs` 的 `harnessKey()` 是扫**用例源码**
// 认出「这一族替身」的（`fixtureUrl('<目录>/…')` / `fixtures/<目录>/` 字面量）。把 `fixtureUrl(...)`
// 藏进 helper，这两个文件就会掉进 `no-fixture` 桶、与别的替身家族同批 —— 而 `registerHooks` 装的
// 钩子进程内只增不减，批内串扰是真红（#513 那一类）。所以替身表留在用例文件里，只把「怎么装、
// 装完给什么」收进来。
//
// 顺序要求同 `installTsResolve`：hook 必须在动态 `import()` 被测源码之前装好，所以本函数
// 内部先 `installTsResolve()` 再 import，调用方 `await` 它之后才拿得到 `api` / `transport`。
import { fileURLToPath } from 'node:url'

import { installTsResolve } from './dom-env.mjs'

/** 两条用例共用的「合法收款页」样本（`https:` 是唯一被接受的口径） */
export const SHOP_URL = 'https://wzyp.cn/shop/DIWOOHLR'

/**
 * 装好装配并返回用例要用的全部句柄。
 *
 * @param {{ stubs: Record<string, string> | Array<[RegExp, string]>, onResolve?: Function }} options
 *   `stubs` / `onResolve` 原样转给 `installTsResolve`（口径见 `helpers/dom-env.mjs`）。
 */
export const createPayLinkHarness = async ({ stubs, onResolve } = {}) => {
  installTsResolve({ stubs, onResolve })

  /**
   * `@capacitor/browser` 替身（`fixtures/domain03-04/checkout-browser.mjs`）读写的就是这个全局。
   * `finish()` 让用例能模拟「用户把打开的页面关掉」：把已注册的 `browserFinished` 监听依次调一遍。
   * 两个文件原本一份带 `finish()`、一份不带 —— 这里合成一份：多出来的方法没有任何断言依赖它，
   * 少掉它则是删能力（`pay-link-861` 原来那版就带）。
   */
  globalThis.__cap = {
    native: true,
    browser: {
      opens: [],
      listeners: [],
      rejectOpen: false,
      removeCount: 0,
      finish() {
        for (const item of [...this.listeners]) {
          item.handler()
        }
      },
    },
  }

  const api = await import('../../src/services/ours/api.ts')
  const transport = await import('../../src/services/ours/transport.ts')
  const { zh } = await import('../../src/i18n/zh.ts')
  const { en } = await import('../../src/i18n/en.ts')

  /** 仓库根（`tests/helpers/` → `../..`）：与用例文件里的 `new URL('../../', import.meta.url)` 同一个值 */
  const ROOT = fileURLToPath(new URL('../../', import.meta.url))
  const cap = () => globalThis.__cap

  /** 每条用例前复位替身：`native` 回 true、打开记录 / 监听 / 拒绝开关 / 移除计数清零 */
  const resetStubs = () => {
    cap().native = true
    cap().browser.opens.length = 0
    cap().browser.listeners.length = 0
    cap().browser.rejectOpen = false
    cap().browser.removeCount = 0
  }

  /** 假 HTTP 响应：`api.ts` 只认 `{ kind, status, text }` 三个字段 */
  const response = (status, body) => ({
    kind: 'response',
    status,
    text: typeof body === 'string' ? body : JSON.stringify(body),
  })

  /** 只回放同一个结果的假 transport（与 `ours-check.mjs` 的「有序回放」版语义不同，别混用） */
  const fakeTransport = (result) => {
    const calls = []
    return {
      calls,
      transport: async (request) => {
        calls.push(request)
        return result
      },
    }
  }

  /** 与 BuyTab.openCheckout 同一条编排：取地址 → 成功才打开；失败只给文案 */
  const buyFlow = async (result) => {
    resetStubs()
    const fake = fakeTransport(result)
    const link = await api.fetchPayLink(fake.transport)
    let opened = null
    if (link.status === 'ok') {
      opened = await transport.openPayLinkInApp(link.url, () => {})
    }
    return {
      link,
      opened,
      calls: fake.calls,
      opens: cap().browser.opens.length,
      listeners: cap().browser.listeners.length,
    }
  }

  return { api, transport, zh, en, ROOT, cap, resetStubs, SHOP_URL, response, fakeTransport, buyFlow }
}
