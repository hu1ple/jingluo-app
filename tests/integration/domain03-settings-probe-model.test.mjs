// [layer: integration | 依赖: playwright + chromium + 本地 dist-standard 静态服务 | 耗时: ~1 分钟]
//
// #362 / #367 · 域 3 · 「模型来源 → 第三方服务」**草稿态**里的连通性探测（L2）
//
// ## 这条用例钉什么（裁决 2026-11-26，见 docs/testing/product-debt.md 已裁决第 3 条）
//
// #807 之后来源页是三行手风琴，探测入口从「打开模型下拉即探测」改成草稿里的**「测试」按钮**
// （`settings-source-draft-test`）。所以这里钉的是这个入口的**意图**：
//
//   1. 空地址点「测试」→ 必填提示（`settingsBaseUrlRequired`），**一个请求都不发**；
//   2. 有地址没 Key 点「测试」→ 提示先填 Key（`settingsTestApiKeyRequired`），同样不发请求；
//   3. 有地址有 Key 点「测试」→ **真的发出 `GET {草稿地址}/v1/models`**（带鉴权头），
//      并且把结果 / 错误**按档渲染出来**（成功、通了但空、网页、非 JSON、HTTP 5xx、连不上、超时）。
//
// **不再钉**「模型下拉存在 / listbox 渲染了几项 / 选中的模型写回」这类**界面形状**：#807 把模型行
// 收进了「确认使用」之后的生效形态，草稿态里没有那个下拉，也不该为了迁就旧断言把它加回来。
//
// ## 文案口径（自证伪点）
//
// 期望句子从 `src/i18n/zh.ts` 现取（`settingsTestOk` / `settingsTestHttp` / …），用例里不抄字面量：
// 产品改文案 → 这里跟着变（仍断「就是这一档」）；只有**改错档**（把 5xx 说成网络错误）才会红。
//
//   NODE_ENV=production DIST_OUT=dist-standard npx rspack build -c rspack.config.ts
//   node tests/run-layer.mjs integration --case tests/integration/domain03-settings-probe-model.test.mjs
import { chromium } from 'playwright'
import { serveDir, verifyAppUrl, SKIP_CODE } from '../helpers/env.mjs'
import { openApiConfigSection } from '../helpers/helpers.mjs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')
const DIST = process.env.DIST_DIR_STANDARD || path.join(ROOT, 'dist-standard')
const KEY = 'sk-probe-model-0123456789'
const BASE = 'https://probe.example.test'
const MODELS_PATH = '/v1/models'
/** 界面语言钉成中文（zh 表就是断言口径；不跟 shell 的 LANG 走） */
const { zh } = await import('../../src/i18n/zh.ts')

/** 与 i18n 的插值同一口径：`{name}` → params[name] */
const render = (key, params = {}) =>
  String(zh[key]).replace(/\{(\w+)\}/g, (whole, name) =>
    Object.hasOwn(params, name) ? String(params[name]) : whole
  )

/** 带 `{message}` 的那几档：上游 / 浏览器给的原话不可预测，只等值断言模板的前半句 */
const head = (key) => String(zh[key]).split('{message}')[0]

const failures = []
const ok = (message) => console.log(`  ok  ${message}`)
const bad = (message) => {
  failures.push(message)
  console.error(`  ✗   ${message}`)
}

let served
let browser
try {
  served = await serveDir(DIST, { port: process.env.PORT, label: '标准产物 dist-standard' })
  const APP_URL = process.env.APP_URL || served.url
  await verifyAppUrl(APP_URL, DIST, { variant: 'standard' })

  browser = await chromium.launch()
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1280, height: 800 } })
  const page = await context.newPage()

  /** 记录每一次 `/v1/models` 探测（草稿态没有自动探测：只有用户点「测试」才会发生） */
  const probes = []
  let mode = 'ok'
  await page.route(`**${MODELS_PATH}`, async (route) => {
    probes.push({
      url: route.request().url(),
      authorization: route.request().headers()['authorization'] ?? '',
      apiKey: route.request().headers()['x-api-key'] ?? '',
    })
    switch (mode) {
      case 'ok':
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ data: [{ id: 'model-alpha' }, { id: 'model-beta' }] }),
        })
      case 'empty':
        return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
      case 'html':
        return route.fulfill({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: '<!doctype html><title>gateway</title>',
        })
      case 'badjson':
        return route.fulfill({ status: 200, contentType: 'application/json', body: '{"data":[oops' })
      case 'http500':
        return route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: { message: 'upstream boom' } }),
        })
      case 'network':
        return route.abort('failed')
      case 'timeout':
        // 永不 fulfill：探测自己的 AbortController 到点后应给出「超时」而不是「连不上」
        return new Promise(() => {})
      default:
        return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
    }
  })

  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => window.localStorage.clear())
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(600)

  /**
   * 写配置并重载：生效来源 = 第三方（openai 槽位）。
   *
   * 为什么要顺手种一条 `chat-demo:protocol-cache`（#794）：展开「第三方服务」那一行时界面会在后台
   * 判一次协议，判不出来就自己发 `GET {base}/v1/models` 探一次 —— 那条请求与本用例要数的「用户点
   * 「测试」发出的探测」不是一回事，混在一起会让次数断言按机器快慢漂移（实测撞过一次）。
   * 种上「这条地址上次判成 openai」之后，协议判定本地命中缓存，探测次数只剩用户点出来的那几次。
   */
  const seed = async ({ baseUrl = BASE, key = KEY } = {}) => {
    await page.evaluate(
      ({ baseUrl, key }) => {
        window.localStorage.clear()
        window.localStorage.setItem('chat-demo:provider-kind', 'openai')
        if (baseUrl) {
          window.localStorage.setItem('chat-demo:base-url:openai', baseUrl)
          window.localStorage.setItem(
            'chat-demo:protocol-cache',
            JSON.stringify({ [baseUrl]: { p: 'openai', at: 1_700_000_000_000 } })
          )
        }
        if (key) window.localStorage.setItem('chat-demo:api-key', key)
      },
      { baseUrl, key }
    )
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(700)
  }

  /**
   * 设置 → 账户与消费 → 模型来源 → 展开「第三方服务」（草稿态，不改生效来源）。
   * 走 helpers 里那条唯一路径：每一步失败都会说清「卡在哪 / 期望什么 / 现在是什么」。
   */
  const openThirdRow = async () => {
    await openApiConfigSection(page, { row: 'third' })
    return page.locator('[data-testid="settings-source-third-panel"]:not([hidden])').first()
  }

  const draftFill = async (field, value) => {
    await page.getByTestId(`settings-source-draft-${field}`).first().fill(value)
  }

  /** 点草稿里的「测试」，等它从「测试中…」回到「测试」（= 结论已经落地） */
  const clickDraftTest = async () => {
    const start = probes.length
    const button = page.getByTestId('settings-source-draft-test').first()
    await button.click()
    await page
      .locator(`[data-testid="settings-source-draft-test"]:text-is("${zh.settingsTest}")`)
      .first()
      .waitFor({ timeout: 30000 })
      .catch(() => {})
    await page.waitForTimeout(200)
    return probes.length - start
  }

  const panelText = async (panel) => (await panel.innerText()).replace(/\s+/g, ' ')

  /**
   * 一张表 8 行：前三列是「上游长什么样 / 界面该说哪一档 / 这一档要不要真发请求」。
   * `expect` 有两种：`exact` = 整句等值（模板可完全填出来的），`prefix` = 只断模板前半句
   * （后半句是上游/浏览器原话，逐字断言等于把别人家的错误文案抄进用例）。
   */
  const ROWS = [
    {
      id: '1',
      where: '空地址点「测试」',
      mode: 'ok',
      baseUrl: '',
      key: KEY,
      expect: { kind: 'exact', key: 'settingsBaseUrlRequired' },
      requests: 0,
      why: '自填渠道没有内置默认地址，空地址就该本地拦下',
    },
    {
      id: '2',
      where: '有地址没 Key 点「测试」',
      mode: 'ok',
      baseUrl: BASE,
      key: '',
      expect: { kind: 'exact', key: 'settingsTestApiKeyRequired' },
      requests: 0,
      why: '空鉴权打过去只会换回一个 401，不如本地说清楚',
    },
    {
      id: '3',
      where: '上游 200 + 两个模型',
      mode: 'ok',
      expect: {
        kind: 'exact',
        key: 'settingsTestOk',
        params: { status: 200, count: 2, models: 'model-alpha, model-beta' },
      },
      requests: 1,
    },
    {
      id: '4',
      where: '上游 200 但没有模型列表',
      mode: 'empty',
      expect: { kind: 'exact', key: 'settingsTestOkEmpty', params: { status: 200 } },
      requests: 1,
    },
    {
      id: '5',
      where: '上游返回网页（HTML）',
      mode: 'html',
      expect: { kind: 'exact', key: 'settingsTestHtml', params: { status: 200 } },
      requests: 1,
    },
    {
      id: '6',
      where: '上游返回的不是 JSON',
      mode: 'badjson',
      expect: { kind: 'prefix', key: 'settingsTestBadJson' },
      requests: 1,
    },
    {
      id: '7',
      where: '上游 HTTP 500',
      mode: 'http500',
      expect: { kind: 'exact', key: 'settingsTestHttp', params: { status: 500, message: 'upstream boom' } },
      requests: 1,
      forbid: ['settingsTestOk', 'settingsTestNetwork'],
    },
    {
      id: '8',
      where: '连不上（网络层失败）',
      mode: 'network',
      expect: { kind: 'prefix', key: 'settingsTestNetwork' },
      requests: 1,
      forbid: ['settingsTestOk', 'settingsTestHttp'],
    },
    {
      id: '9',
      where: '超时（上游不回应）',
      mode: 'timeout',
      expect: { kind: 'exact', key: 'settingsTestTimeout' },
      requests: 1,
      forbid: ['settingsTestNetwork', 'settingsTestOk'],
      settleMs: 300,
    },
  ]

  for (const row of ROWS) {
    console.log(`\n[${row.id}] ${row.where}${row.why ? `（${row.why}）` : ''}`)
    mode = row.mode
    await seed({ baseUrl: row.baseUrl ?? BASE, key: row.key ?? KEY })
    const panel = await openThirdRow()
    await draftFill('baseUrl', row.baseUrl ?? BASE)
    await draftFill('apiKey', row.key ?? KEY)
    const sent = await clickDraftTest()
    const text = await panelText(panel)
    const expected =
      row.expect.kind === 'exact' ? render(row.expect.key, row.expect.params) : head(row.expect.key)
    if (!text.includes(expected)) {
      bad(
        `${row.id}) ${row.where} 渲染的不是 ${row.expect.key} 那一句\n      期望：${JSON.stringify(expected)}\n      实际：${JSON.stringify(text.slice(0, 200))}`
      )
    } else {
      ok(`${row.id}) ${row.where} → ${row.expect.key}${row.expect.kind === 'prefix' ? '（前半句等值）' : ''}`)
    }
    if (sent !== row.requests) {
      bad(`${row.id}) 期望发出 ${row.requests} 次 ${MODELS_PATH}，实际 ${sent} 次`)
    } else if (row.requests > 0) {
      const hit = probes[probes.length - 1]
      if (!hit.url.startsWith(`${BASE}${MODELS_PATH}`)) {
        bad(`${row.id}) 探测没有打到草稿里的地址：${hit.url}（期望 ${BASE}${MODELS_PATH}）`)
      } else if (hit.authorization === '' && hit.apiKey === '') {
        bad(`${row.id}) 探测请求一个鉴权头都没带`)
      } else {
        ok(`${row.id}) 探测 = GET ${hit.url}（带鉴权头，共 ${sent} 次）`)
      }
    } else {
      ok(`${row.id}) 本地拦下：${MODELS_PATH} 一次都没发`)
    }
    for (const forbidKey of row.forbid ?? []) {
      const forbidden = render(forbidKey, {}).split('{')[0]
      if (forbidden !== '' && text.includes(forbidden)) {
        bad(`${row.id}) ${row.where} 串到了 ${forbidKey} 那一档`)
      }
    }
    // 展开 / 填写 / 探测都**不是**「切换生效来源」（#807）：只改草稿不许动 provider-kind
    const kind = await page.evaluate(() => window.localStorage.getItem('chat-demo:provider-kind'))
    if (kind !== 'openai') {
      bad(`${row.id}) 探测把生效来源改掉了：chat-demo:provider-kind=${JSON.stringify(kind)}（展开 ≠ 生效）`)
    }
    await page.waitForTimeout(row.settleMs ?? 0)
  }
} finally {
  await browser?.close().catch(() => {})
  served?.kill()
}

if (failures.length > 0) {
  console.error(`\nFAIL tests/integration/domain03-settings-probe-model.test.mjs`)
  for (const failure of failures) console.error(`  ✗ ${failure}`)
  process.exit(1)
}
if (!browser) {
  console.error('SKIP(env) 无法启动浏览器')
  process.exit(SKIP_CODE)
}
console.log('\nPASS tests/integration/domain03-settings-probe-model.test.mjs')
