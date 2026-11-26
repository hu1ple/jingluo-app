// [layer: integration | 依赖: playwright + chromium + 本地静态服务 | 耗时: ~1.5 分钟]
// 被测对象：「设置 → 账户与消费 → 模型来源」的**来源选择能力**（2026-11-24 改版 + #807 的 IA / #800 的减法）。
//
// ## 为什么这个文件按新 IA 重写，而不是退役
//
// **「渠道选择」这个能力仍然存在**，只是形状变了（lead 裁决，2026-11-26）：
//
//   旧形状：「数据管理」页上一个「渠道」下拉，四个选项（DeepSeek 官方 / Anthropic 协议 / OpenAI 兼容 / 我们的渠道）；
//   新形状：来源页三行单层手风琴（内置服务 / 第三方服务 / DeepSeek 官方服务），
//           **展开某一行 → 填 / 确认 → 该行打勾成为当前生效来源**（`settings-source-current`）。
//
// 能力还在 → 断言要**钉能力**（能切、切完打勾、切完字段可见性对、切完请求真打到对应端点），
// 不钉旧形状（下拉 / 四个选项 / `providerKindTrigger` 以外的任何 UI 记忆）。
//
// ## 退役的子断言（退役原因：#800）
//
// 退役原因：**对象被产品有意删掉**，不是「跑不过就放过」—— #800 把「模型来源」页要渲染哪些字段行
// 抽成唯一判定 `sourceFieldPlan.sourceFieldRows()`，内置服务（`ours`）的行清单是**空的**
// （Key 由服务端下发、后台幂等对齐），于是下面这些子断言的对象在 DOM 上不再存在：
//
//   1. 「内置服务有只读 Key 行」`settings-managed-key`（含尾号 ···xxxx 的展示）；
//   2. 「内置服务有『重新领取』按钮」`settings-managed-key-claim`；
//      → 两条都退役：那一段 DOM 被 #800 删除。它们原本守的「用户改不了内置 Key」这条**能力**
//        没有跟着退役 —— 见 [5]「内置行一个字都不可编辑」（结构上没有可编辑控件，比只读更硬）。
//   3. 任何「按 dialog 内 input 数量判断是哪种渠道」的写法：退役 —— 第三方与官方两个面板里现在是
//      **同名输入框**（`settings-source-draft-apiKey` 两处都有），数 dialog 里的 input 数已经判不出来源。
//      本文件一律**按展开区归属**数（`settings-source-<row>-panel`），见 `panelInputIds()`。
//
// 另：工具栏各入口的显隐（#813 精简工具栏 / #548 图片 / #538 文档能力门）仍由 caps.test.mjs 与
// compact-toolbar-813.test.mjs 逐条守；本文件只保留「随来源切换而变化」的那一小撮（[2][3][5] 的
// `expectToolbar`），不在这里再抄一份全量矩阵。请求体的扩展字段剥离由 request-body.test.mjs 守。
//
// ## 断言（三条能力，正好是裁决里的三条）
//
//   [1] 默认 + 字段可见性（官方行）：标准构建默认来源 = DeepSeek 官方服务（打勾在官方行）；
//       官方行只有 Key 可填 —— 地址是只读固定行（`settings-source-base-url-fixed`，无可编辑地址框）、
//       模型不可编辑（无模型输入框）；
//   [2] 切完真正生效（官方）：请求打到 api.deepseek.com/anthropic/v1/messages + model deepseek-flash；
//   [3] 能切换到第三方 · 切完打勾 · 字段可见性（三件套都可填）· 真正生效：
//       先填 OpenAI 形状 → /v1/chat/completions + gpt 系列模型；再改填 Anthropic 形状 → /v1/messages
//       + claude 系列模型（同一行，协议由地址/模型自适应，这是 #794 之后的既有行为；
//       先 OpenAI 后 Anthropic 是**判据的先后**决定的，理由写在 [3] 那段的注释里）；
//   [4] 能切换回官方：确认使用 → 打勾回到官方行，请求也回到官方端点；
//   [5] 能切换到内置服务 · 字段可见性（一个字都不可编辑）· 真正生效（Bearer 服务端那把 + 内部地址不外露）；
//   [6] 刷新后当前生效来源还在（持久化）；
//   [7] console error = 0。
//
// 跑法（自己起一份标准产物，上游全部 page.route 打桩）：
//   TEST_AUTH_SEAM=1 DIST_OUT=dist-standard node scripts/build.mjs
//   node tests/integration/provider-channels.test.mjs
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright'
import { serveDir, verifyAppUrl } from '../helpers/env.mjs'
import { installTsResolve } from '../helpers/dom-env.mjs'
import {
  capturePaths,
  clickApiKeyConfirm,
  closeSettings,
  fillApiKey,
  fillBaseUrl,
  fillModel,
  openApiConfigSection,
  openSourceRow,
  providerKindTrigger,
  readProviderKind,
  waitForProviderKind,
} from '../helpers/helpers.mjs'
import { installBuiltinKeyClaimStub } from '../fixtures/consume-gateway-stubs/builtin-key-claim.mjs'
import { CONSUME_PROFILE_STUB } from '../fixtures/consume-gateway-stubs/account-consume-chain.mjs'
import { inferenceBaseUrl } from '../../scripts/lib/endpoints.mjs'

// 页面里种「服务端下发标记」时要用**真的**指纹函数（不在这里重算一份 djb2）：
// 本仓的 `.js` 说明符指向 `.ts` 源码，裸 Node 解析不到，先装解析 hook 再动态 import。
installTsResolve()
const { keyFingerprint } = await import('../../src/services/invite/keyIdentity.ts')

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')
const DIST = process.env.DIST_DIR_STANDARD || path.join(ROOT, 'dist-standard')
const PORT = process.env.PORT
/**
 * 截图落临时目录（可用 `SHOT_DIR` 覆盖）：本文件**不往仓库里写文件** ——
 * 门禁要求 `git status --porcelain` 为空，截图只是取证素材，不该变成 untracked 噪音。
 */
const SHOT_DIR = process.env.SHOT_DIR || path.join(os.tmpdir(), 'provider-channels-shots')

const KEY = 'sk-channels-acceptance-key'
/** 第三方（Anthropic 形状）：主机与模型名都要能被 protocolDetect 判成 anthropic */
const BASE_A = 'https://relay.example.com'
const MODEL_A = 'claude-relay-model'
/** 第三方（OpenAI 形状） */
const BASE_O = 'https://oai.example.com'
const MODEL_O = 'gpt-relay-model'
/** 官方：地址与模型内置（`providers.ts` 的 deepseek.defaults） */
const OFFICIAL_HOST = 'https://api.deepseek.com'
const OFFICIAL_URL = `${OFFICIAL_HOST}/anthropic/v1/messages`
const OFFICIAL_MODEL = 'deepseek-flash'
// #812：推理地址 = 登录环境（consume.baseUrl），不再是另一份 chatBaseUrl
const OURS_HOST = inferenceBaseUrl
const OURS_URL = `${OURS_HOST}/v1/chat/completions`
const OURS_MODEL = 'deepseek-v4.1-flash'

const failures = []
const evidence = []
const ok = (message) => console.log(`  ok  ${message}`)
const bad = (message) => {
  failures.push(message)
  console.error(`  ✗   ${message}`)
}
const note = (message) => {
  evidence.push(message)
  console.log(`  ·   ${message}`)
}

/** Anthropic 风格 SSE（消息正文逐块下发） */
const ANTHROPIC_SSE = [
  'event: message_start',
  'data: {"type":"message_start","message":{"id":"msg_test","type":"message","role":"assistant","content":[],"model":"stub","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"渠道验收回复"}}',
  '',
  'event: content_block_stop',
  'data: {"type":"content_block_stop","index":0}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":3}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
  '',
].join('\n')

/** OpenAI 风格 SSE（chat/completions chunk 流） */
const OPENAI_SSE = [
  'data: {"id":"chatcmpl-stub","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}',
  '',
  'data: {"id":"chatcmpl-stub","choices":[{"index":0,"delta":{"content":"渠道验收回复"},"finish_reason":null}]}',
  '',
  'data: {"id":"chatcmpl-stub","choices":[],"usage":{"prompt_tokens":3,"completion_tokens":3,"total_tokens":6}}',
  '',
  'data: {"id":"chatcmpl-stub","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
  '',
  'data: [DONE]',
  '',
].join('\n')

const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
})
const context = await browser.newContext({
  locale: 'zh-CN',
  viewport: { width: 1280, height: 900 },
  permissions: ['microphone'],
})
const page = await context.newPage()
const consoleErrors = []
page.on('console', (message) => {
  if (message.type() === 'error') {
    consoleErrors.push(message.text())
  }
})
page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`))

const shot = async (name) => {
  mkdirSync(SHOT_DIR, { recursive: true })
  const file = path.join(SHOT_DIR, `provider-channels-${name}.png`)
  await page.screenshot({ path: file, fullPage: true })
  note(`截图 ${file}`)
}

// ───────────────────────────────────── 设置页（新 IA）：当前生效来源 / 展开区

/**
 * 当前生效来源那一行（打勾的那一行，`settings-source-current`）。
 *
 * 一行都没打勾（或行头上没有 `settings-source-current`）时 `row` 为 `null` —— 不替产品编一个
 * 「默认来源」出来：那样「来源丢了」会被伪装成通过。
 */
const checkedRow = async () => {
  const trigger = providerKindTrigger(page)
  const count = await trigger.count()
  if (count !== 1) {
    return { count, row: null, text: '' }
  }
  const testId = await trigger.first().getAttribute('data-testid')
  return {
    count,
    row: String(testId ?? '').replace(/^settings-source-/, ''),
    text: (await trigger.first().innerText()).trim(),
  }
}

/** 断「当前生效来源 = 某一行」：恰好一行打勾，且就是它（**能力**：切完打勾，不钉别的形状） */
const expectCheckedRow = async (where, row, labelRe) => {
  const checked = await checkedRow()
  if (checked.count !== 1) {
    bad(`${where} 当前生效来源应恰好 1 行打勾（settings-source-current），实际 ${checked.count} 行`)
    return
  }
  if (checked.row !== row) {
    bad(`${where} 打勾的不是「${row}」那一行，而是「${checked.row}」（行头文本 ${JSON.stringify(checked.text)}）`)
    return
  }
  if (!labelRe.test(checked.text)) {
    bad(`${where} 打勾那行（${row}）的行头文本不对：${JSON.stringify(checked.text)}（期望匹配 ${labelRe}）`)
    return
  }
  ok(`${where} 当前生效来源 = ${checked.text.split('\n')[0]}（${row} 那一行打勾）`)
}

/** 当前展开着的那一行（#807：同一时间只展开一行）—— 字段可见性只在它里面数 */
const openPanelRow = async (where) => {
  const panels = page.locator('[data-testid="settings-source-accordion"] [data-testid$="-panel"]:not([hidden])')
  const count = await panels.count()
  if (count !== 1) {
    bad(`${where} 应恰好 1 个展开的来源行（[data-testid$="-panel"]:not([hidden])），实际 ${count} 个`)
    return null
  }
  const testId = await panels.first().getAttribute('data-testid')
  return String(testId ?? '').replace(/^settings-source-/, '').replace(/-panel$/, '')
}

/**
 * 展开区里的可编辑输入框（**按展开区归属**数，不按 dialog 数）。
 *
 * 为什么必须带归属：第三方与官方的面板里输入框是**同名**的（`settings-source-draft-*` 各自一份），
 * 「按 dialog 内 input 数量判断哪种渠道」在 #807 之后判不出来源（#800 的退役清单第 3 条）。
 */
const panelInputIds = async (row, where) => {
  const row2 = await openPanelRow(where)
  if (row2 === null) {
    return null
  }
  if (row2 !== row) {
    bad(`${where} 展开的不是「${row}」那一行，而是「${row2}」`)
    return null
  }
  return page
    .locator(`[data-testid="settings-source-${row}-panel"]`)
    .locator('input')
    .evaluateAll((list) => list.map((node) => node.getAttribute('data-testid')))
}

/** 官方行：只有 Key 可填（地址固定只读、模型不可改） */
const expectOfficialFields = async (where) => {
  const ids = await panelInputIds('official', where)
  if (ids === null) {
    return
  }
  note(`${where} 展开区输入框：${JSON.stringify(ids)}`)
  if (ids.length !== 1 || ids[0] !== 'settings-source-draft-apiKey') {
    bad(`${where} 官方行应只有 1 个可编辑输入框（API Key），实际 ${JSON.stringify(ids)}`)
    return
  }
  const fixed = page.locator('[data-testid="settings-source-official-panel"] [data-testid="settings-source-base-url-fixed"]')
  if ((await fixed.count()) !== 1) {
    bad(`${where} 官方行没有「地址固定」只读行（settings-source-base-url-fixed），用户会以为漏了一格`)
    return
  }
  const fixedText = (await fixed.first().innerText()).trim()
  if (!fixedText.includes(new URL(OFFICIAL_HOST).hostname)) {
    bad(`${where} 官方行展示的固定地址不是官方端点：${JSON.stringify(fixedText)}`)
    return
  }
  const inlineError = page.locator('[data-testid="settings-source-official-panel"] [data-testid$="-error"]')
  if ((await inlineError.count()) > 0) {
    bad(`${where} 官方行一展开就有行内红字：${JSON.stringify((await inlineError.first().innerText()).trim())}`)
    return
  }
  ok(`${where} 官方行只有 Key 可填；地址固定为 ${fixedText}（只读，不许改）`)
}

/** 第三方行：三件套（地址 / Key / 模型）都可填 */
const expectThirdFields = async (where) => {
  const ids = await panelInputIds('third', where)
  if (ids === null) {
    return
  }
  note(`${where} 展开区输入框：${JSON.stringify(ids)}`)
  const want = ['settings-source-draft-baseUrl', 'settings-source-draft-apiKey', 'settings-source-draft-model']
  const sorted = [...ids].sort()
  if (JSON.stringify(sorted) !== JSON.stringify([...want].sort())) {
    bad(`${where} 第三方行应是三件套（地址 / Key / 模型）都可填，实际 ${JSON.stringify(ids)}`)
    return
  }
  ok(`${where} 第三方行三件套都可填（地址 / Key / 模型）`)
}

/**
 * 内置行：**一个字都不可编辑**（#800：字段清单为空 → 结构上没有输入框 / Key 展示区 /「重新领取」）。
 *
 * 这条替的是退役的「只读 Key 行 + 重新领取」两条子断言：它们守的能力是「用户改不了内置 Key」，
 * 现在由「结构上没有可编辑控件」来守 —— 比 disabled 更硬（禁用的输入框能被 devtools 打开、能被脚本填值）。
 */
const expectBuiltinFields = async (where) => {
  const ids = await panelInputIds('builtin', where)
  if (ids === null) {
    return
  }
  if (ids.length !== 0) {
    bad(`${where} 内置行不该有任何可编辑输入框（Key 由服务端下发），实际 ${JSON.stringify(ids)}`)
    return
  }
  const panel = page.locator('[data-testid="settings-source-builtin-panel"]')
  const retired = {
    'settings-managed-key': await panel.locator('[data-testid="settings-managed-key"]').count(),
    'settings-managed-key-claim': await panel.locator('[data-testid="settings-managed-key-claim"]').count(),
    draft: await panel.locator('[data-testid^="settings-source-draft-"]').count(),
  }
  const leaked = Object.entries(retired).filter(([, count]) => count !== 0)
  if (leaked.length > 0) {
    bad(`${where} 内置行出现了 #800 已删除的控件：${JSON.stringify(Object.fromEntries(leaked))}`)
    return
  }
  ok(`${where} 内置行没有任何可编辑控件（无输入框 / 无只读 Key 行 / 无「重新领取」，#800 的字段清单为空）`)
}

// ───────────────────────────────────── 聊天页：工具栏入口 / 发消息捕获

const ATTACH_IMAGE = '[data-testid="attach-image"]'
const ATTACH_DOC = '[data-testid="attach-document"]'
const ATTACH_DOC_READY = `${ATTACH_DOC}:not([data-attachment-entry="unavailable"])`

/**
 * 「随来源切换而变化」的那几个入口（能力门；全量矩阵在 caps / compact-toolbar-813 里）。
 *
 *  - 官方（#813）：右侧只留图片入口；文档入口连「不可用」占位都不渲染（`absent`）；
 *  - 第三方 / 内置：#548 的图片入口在且可点、#538 的文档入口在且可点。
 */
const expectToolbar = async (where, want) => {
  const image = await page.locator(ATTACH_IMAGE).count()
  const imageReady = await page.locator(`${ATTACH_IMAGE}:not([aria-disabled="true"])`).count()
  if (image !== 1 || imageReady !== 1) {
    bad(`${where} 图片入口应存在且可点（attach-image 总数 ${image} / 可点 ${imageReady}）`)
  } else {
    ok(`${where} 图片入口存在且可点（attach-image ×1）`)
  }
  const doc = await page.locator(ATTACH_DOC).count()
  if (want.document === 'ready') {
    const ready = await page.locator(ATTACH_DOC_READY).count()
    if (doc !== 1 || ready !== 1) {
      bad(`${where} 文档入口应存在且可点（attach-document 总数 ${doc} / 可点 ${ready}）`)
    } else {
      ok(`${where} 文档入口存在且可点（attach-document ×1）`)
    }
    return
  }
  if (doc !== 0) {
    bad(`${where} 文档入口应不渲染（DOM 里没有节点，#813 精简工具栏），实际 ${doc} 个`)
  } else {
    ok(`${where} 文档入口不渲染（#813：官方工具栏只留图片入口）`)
  }
}

const lastMessageRequest = (requests) =>
  requests.filter((request) => request.method === 'POST' && request.postData).at(-1)

/** 侧栏「设置」入口可见 = 首屏画完了（等终态，不靠 sleep 猜多久够） */
const SEND_BUTTON = /^发送$|^Send$/
const SETTINGS_ENTRY = /^设置$|^Settings$/

const waitForAppReady = async () => {
  await page.getByRole('button', { name: SETTINGS_ENTRY }).first().waitFor({ state: 'visible', timeout: 20000 })
}

/**
 * 「这一轮回复真的结束了」的终态：桩回的正文出现，且输入框右边的「停止生成」按钮消失
 * （流式期间「发送」按位置被它顶掉，流一结束就换回「发送」）。
 *
 * 为什么要等终态而不是睡一会儿：下一轮要再发一条消息，流没结束就发会被拒（或发到上一轮）。
 * 数正文出现次数（不是 `isEnabled`）—— 发送后输入框是空的，那个按钮本来就是 disabled。
 */
const REPLY_TEXT = '渠道验收回复'
const replyCount = () => page.getByText(REPLY_TEXT, { exact: false }).count()
const STOP_CONTROL = 'button[aria-label*="停止"], button[aria-label*="Stop"]'

const waitReplyDone = async (wasReplies, timeout = 20000) => {
  const deadline = Date.now() + timeout
  for (;;) {
    const done = (await replyCount()) > wasReplies && (await page.locator(STOP_CONTROL).count()) === 0
    if (done) {
      return true
    }
    if (Date.now() >= deadline) {
      return false
    }
    await page.waitForTimeout(100)
  }
}

const sendAndCapture = async (requests, text) => {
  const before = requests.length
  const wasReplies = await replyCount()
  const textarea = page.locator('textarea').last()
  await textarea.click()
  await textarea.fill(text)
  await page.getByRole('button', { name: SEND_BUTTON }).first().click()
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    if (requests.slice(before).some((request) => request.method === 'POST' && request.postData)) {
      break
    }
    await page.waitForTimeout(100)
  }
  await waitReplyDone(wasReplies)
  return lastMessageRequest(requests.slice(before))
}

/** 「切完真的生效」：**请求**打到哪个端点、带哪个模型（不只看界面上的打勾） */
const expectLiveRequest = async (requests, where, text, want) => {
  const hit = await sendAndCapture(requests, text)
  if (!hit) {
    bad(`${where} 没有发出消息请求`)
    return null
  }
  if (hit.url !== want.url) {
    bad(`${where} 发消息 URL 不对：期望 ${want.url}，实际 ${hit.url}`)
  } else {
    ok(`${where} 发消息 → ${hit.url}（来源切换真的生效）`)
  }
  let body = {}
  try {
    body = JSON.parse(hit.postData ?? '{}')
  } catch {
    bad(`${where} 请求体不是 JSON：${JSON.stringify(String(hit.postData).slice(0, 80))}`)
    return hit
  }
  if (body.model !== want.model) {
    bad(`${where} model 不对：期望 ${want.model}，实际 ${JSON.stringify(body.model)}`)
  } else {
    ok(`${where} model = ${body.model}`)
  }
  return hit
}

const readStorage = () =>
  page.evaluate(() => {
    const out = {}
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i)
      out[key] = window.localStorage.getItem(key)
    }
    return out
  })

let served
try {
  // 端口自动发现（PORT 可注入）：固定端口会撞到别的用例的静态服务 → 假红
  served = await serveDir(DIST, { port: PORT, label: '标准产物 dist-standard' })
  const APP_URL = served.url
  await verifyAppUrl(APP_URL, DIST, { variant: 'standard' })

  /**
   * 两条「与用例无关的启动链」的替身（`TEST_AUTH_SEAM=1` 让产物以为已登录 → 冷启动会真去领内置 Key、
   * 进账户页会拉一次账号资料）。替身不是放宽：断言一个字没改，只是这两条链不打真网、不刷 console error。
   * 清单来源：`tests/fixtures/startup/startup-chain-stubs.mjs`（黄金层与 L1 共用同一份）。
   */
  await installBuiltinKeyClaimStub(page)
  await page.route(`https://${CONSUME_PROFILE_STUB.host}/api/v1/user/profile`, async (route) => {
    const response = CONSUME_PROFILE_STUB.respond()
    await route.fulfill({ status: response.status, headers: response.headers, body: response.body })
  })

  // ---------- 上游全部打桩，不连外网 ----------
  const stubUpstream = async (base, sse, model) => {
    await page.route(`${base}/**`, async (route) => {
      const url = route.request().url()
      if (url.includes('/models')) {
        await route.fulfill({
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ data: [{ id: model, type: 'model' }] }),
        })
        return
      }
      await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: sse })
    })
  }
  await stubUpstream(OFFICIAL_HOST, ANTHROPIC_SSE, OFFICIAL_MODEL)
  await stubUpstream(BASE_A, ANTHROPIC_SSE, MODEL_A)
  await stubUpstream(BASE_O, OPENAI_SSE, MODEL_O)
  // 内置服务：真地址，但请求由 Playwright 拦截（#812 起走 OpenAI 协议：/v1/chat/completions + Bearer）
  await stubUpstream(OURS_HOST, OPENAI_SSE, OURS_MODEL)

  const requests = capturePaths(page)

  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => window.localStorage.clear())
  // 只种一把 Key，**不**种 provider-kind：这样 [1] 断的是「标准构建的默认来源」，不是我们刚写进去的值
  await page.evaluate((key) => window.localStorage.setItem('chat-demo:api-key', key), KEY)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitForAppReady()

  // ---------- [1] 默认来源 + 官方行字段可见性 ----------
  console.log('\n[1] 默认来源（标准构建）+ 官方行字段可见性')
  const storedKind = await readProviderKind(page)
  if (storedKind !== null) {
    bad(`前置：刚清过的盘不该有 provider-kind，实际 ${JSON.stringify(storedKind)}`)
  }
  await openApiConfigSection(page, { row: 'official' })
  await expectCheckedRow('默认来源', 'official', /DeepSeek 官方服务/)
  await expectOfficialFields('官方行')
  const officialPanelText = await page.locator('[data-testid="settings-source-official-panel"]').innerText()
  if (!officialPanelText.includes(OFFICIAL_MODEL)) {
    bad(`官方行没有露出内置模型 ${OFFICIAL_MODEL}（#339：至少要让用户知道当前用的是哪个模型）`)
  } else {
    ok(`官方行展示只读内置模型 ${OFFICIAL_MODEL}`)
  }
  await shot('official')
  await closeSettings(page)

  // ---------- [2] 官方来源真正生效 ----------
  console.log('\n[2] 官方来源生效（请求路径 + 模型）')
  await expectToolbar('官方来源', { document: 'absent' })
  await expectLiveRequest(requests, '官方来源', '你好，官方来源', {
    url: OFFICIAL_URL,
    model: OFFICIAL_MODEL,
  })

  // ---------- [3] 第三方：能切、打勾、三件套、真正生效（两种协议形状同一行） ----------
  /**
   * 顺序：**先 OpenAI 形状、再 Anthropic 形状**。这不是风格，是判据的先后（`protocolDetect.resolveProtocol`）：
   *
   *   · #794 之后协议不再是用户选的，第三方槽位首次进入时兜底值就是 `openai`（`source: 'default'`），
   *     于是「OpenAI 形状」这一条**必须在槽位还空着的时候**走 —— 否则会先被上一轮的结论/缓存盖住；
   *   · 「Anthropic 形状」有确定性判据（模型名 `claude` 前缀，或主机含 `anthropic`），任何时候都判得出来。
   *
   * 反过来写（先 Anthropic 再 OpenAI）就会红在产品没错的地方：OpenAI 形状只能靠 `/v1/models`
   * 探两次鉴权风格、而两条桩都成功（结论相同 → 「没探明白」），于是协议**故意**保持不变（见该文件头
   * 「不阻塞首条消息」）。这里不替产品编一条它没有的判据，只按它的真实判据排序。
   */
  console.log('\n[3] 第三方服务（OpenAI 形状 → Anthropic 形状）')
  await openApiConfigSection(page, { row: 'third' })
  await expectThirdFields('第三方行（OpenAI 形状）')
  await fillBaseUrl(page, BASE_O)
  await fillModel(page, MODEL_O)
  await fillApiKey(page, KEY)
  await clickApiKeyConfirm(page)
  await waitForProviderKind(page, 'openai')
  await expectCheckedRow('第三方（OpenAI）', 'third', /第三方服务/)
  await shot('third-openai')
  await closeSettings(page)
  await expectToolbar('第三方（OpenAI）', { document: 'ready' })
  await expectLiveRequest(requests, '第三方（OpenAI）', '你好，OpenAI 形状', {
    url: `${BASE_O}/v1/chat/completions`,
    model: MODEL_O,
  })

  // 同一行换成 Anthropic 形状：协议按地址 / 模型自适应（#794 之后没有「协议二选一」）。
  // 「确认使用」只落盘草稿，「切到 anthropic」发生在展开这一行时（`detectThirdPartyProtocol` 的 effect），
  // 所以这里**离开再回来** —— 这也是真实用户路径：配好之后回来看看，界面上就是 Anthropic 形状。
  await openApiConfigSection(page, { row: 'third' })
  await expectThirdFields('第三方行（改填 Anthropic 形状前）')
  await fillBaseUrl(page, BASE_A)
  await fillModel(page, MODEL_A)
  await clickApiKeyConfirm(page)
  await closeSettings(page)
  await openApiConfigSection(page, { row: 'third' })
  await waitForProviderKind(page, 'anthropic')
  await expectCheckedRow('第三方（Anthropic）', 'third', /第三方服务/)
  await shot('third-anthropic')
  await closeSettings(page)
  await expectLiveRequest(requests, '第三方（Anthropic）', '你好，Anthropic 形状', {
    url: `${BASE_A}/v1/messages`,
    model: MODEL_A,
  })

  // ---------- [4] 能切换回官方 ----------
  console.log('\n[4] 切换回官方服务')
  await openApiConfigSection(page, { row: 'official' })
  await fillApiKey(page, KEY)
  await clickApiKeyConfirm(page)
  await waitForProviderKind(page, 'deepseek')
  await expectCheckedRow('切回官方', 'official', /DeepSeek 官方服务/)
  await closeSettings(page)
  await expectLiveRequest(requests, '切回官方', '你好，又回到官方', {
    url: OFFICIAL_URL,
    model: OFFICIAL_MODEL,
  })

  // ---------- [5] 内置服务：能切、一个字都不可编辑、真正生效 ----------
  console.log('\n[5] 内置服务')
  /**
   * 内置服务的切换路径（#807）：**行即动作** —— 本机已经握着「服务端下发的那把」时点行头直接生效
   * （`planBuiltinClick` 的 `select` 分支，不发请求）；没有 / 是旧的才走领取。
   * 这里按「启动对齐之后」的现场种盘（Key + 下发标记，与 `applyManagedKey` 同一形态），
   * 领取链路本身由 `tests/unit/managed-key-596.test.mjs` 逐格验。
   */
  const oursMark = { fingerprint: keyFingerprint(KEY), tail: KEY.slice(-4), at: Date.now(), id: 1 }
  await page.evaluate(
    ([key, mark]) => {
      window.localStorage.setItem('chat-demo:api-key', key)
      window.localStorage.setItem('chat-demo:ours-server-key', JSON.stringify(mark))
    },
    [KEY, oursMark]
  )
  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitForAppReady()
  // 先落到「模型来源」页（展开官方行只是「正在查看」，不改变生效来源），
  // 再**点内置服务行头** —— 这一下就是切换动作本身（#807：内置服务「行即动作」，没有表单也就没有「确认使用」）。
  await openApiConfigSection(page, { row: 'official' })
  await openSourceRow(page, 'builtin')
  await waitForProviderKind(page, 'ours', { steps: ['点「内置服务」行头（行即动作 → 直接设成当前来源）'] })
  await expectCheckedRow('切到内置服务', 'builtin', /内置服务/)
  await expectBuiltinFields('内置行')
  const builtinText = await page.locator('[data-testid="settings-source-builtin-panel"]').innerText()
  // 内置地址的主机与端口取自 config/endpoints.json（#274），不在这里另抄一份
  for (const secret of [new URL(OURS_HOST).hostname, new URL(OURS_HOST).port, OURS_MODEL]) {
    if (secret && builtinText.includes(secret)) {
      bad(`内置行把内部值露在界面上了：${secret}`)
    } else if (secret) {
      ok(`内置行界面不展示 ${secret}`)
    }
  }
  await shot('builtin')
  await closeSettings(page)
  await expectToolbar('内置来源', { document: 'ready' })
  const hitOurs = await expectLiveRequest(requests, '内置来源', '你好，内置服务', {
    url: OURS_URL,
    model: OURS_MODEL,
  })
  if (hitOurs !== null) {
    if (hitOurs.headers.authorization !== `Bearer ${KEY}`) {
      bad(`内置来源 Authorization 头不对：${JSON.stringify(hitOurs.headers.authorization)}`)
    } else {
      ok('内置来源 Authorization = Bearer <服务端下发的那把>')
    }
    if (hitOurs.headers['x-api-key']) {
      bad(`内置来源不该带 x-api-key：${JSON.stringify(hitOurs.headers['x-api-key'])}`)
    } else {
      ok('内置来源未带 x-api-key（OpenAI 协议只用 Bearer）')
    }
  }

  // ---------- [6] 刷新后当前生效来源还在 ----------
  console.log('\n[6] 刷新后来源持久化')
  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitForAppReady()
  await openApiConfigSection(page, { row: 'builtin' })
  await expectCheckedRow('刷新后', 'builtin', /内置服务/)
  const stored = await readStorage()
  if (stored['chat-demo:provider-kind'] !== 'ours') {
    bad(`刷新后 provider-kind 不是 ours：${JSON.stringify(stored['chat-demo:provider-kind'])}`)
  } else {
    ok('刷新后 chat-demo:provider-kind 仍是 ours（来源选择持久化）')
  }
  await closeSettings(page)

  // ---------- [7] console error ----------
  console.log('\n[7] console error')
  if (consoleErrors.length > 0) {
    bad(`console 有 ${consoleErrors.length} 条 error：${consoleErrors.slice(0, 3).join(' | ')}`)
  } else {
    ok('console error = 0')
  }
} catch (error) {
  failures.push(`用例异常：${error instanceof Error ? error.message : String(error)}`)
} finally {
  await browser.close()
  try {
    served?.kill()
  } catch {
    // 已关闭
  }
}

console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'} tests/integration/provider-channels.test.mjs`)
if (evidence.length > 0) {
  console.log('证据：')
  for (const item of evidence) {
    console.log(`  · ${item}`)
  }
}
if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`  ✗ ${failure}`)
  }
  process.exit(1)
}
process.exit(0)
