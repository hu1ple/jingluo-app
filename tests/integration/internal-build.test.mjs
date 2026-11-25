// [layer: integration | 依赖: playwright + chromium + 本地静态服务（上游用 page.route 打桩） | 耗时: ~1 分钟]
//
// 内测构建里「内置服务」的**安全属性**（裁决 2026-11-26，见 docs/testing/product-debt.md）。
//
// 这条用例之前钉的是改版前的**界面形状**（「渠道」下拉 4 个选项、内置行里的只读 Key 行 +
// 「重新领取」按钮）——#807 / #800 之后那些形状被产品有意删掉，用例跟着红，但**产品没做错事**。
// 按「守护意图不守护现状」，这里改成只钉三件**用户真的会被伤害**的事：
//
//   ① 界面不出现 Key 明文（内置服务那把由服务端下发，本机只该看到尾号/掩码）
//   ② 内置服务行的**地址 / 模型不可被本地编辑**（内置值也不许被摊在界面上）
//   ③ 切到别的来源后，原内置 Key **不被带到本地存储**（共用槽位换成用户自己的那把，
//      内置那把不许被复制进任何别的键 —— 包括只留指纹/尾号的「下发标记」）
//
// 「有没有『重新领取』按钮」这类形状**不再断言**：按钮可以来可以走，Key 明文外泄 / 地址被改 /
// 凭证串走不能。
//
//   TEST_AUTH_SEAM=1 node scripts/build.mjs --internal        # 内测产物 → dist/
//   node tests/run-layer.mjs integration --case tests/integration/internal-build.test.mjs
//
// 前置：`TEST_AUTH_SEAM=1` 的内测产物（variant=internal），否则 SKIP(env)。
// 上游全部打桩：消费网关（领取查重 / 账号资料）走 DSH 既有桩，推理走 page.route —— 一个字节都不出网。
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { chromium } from 'playwright'
import { serveDir, verifyAppUrl, verifyDist } from '../helpers/env.mjs'
import { seedClaimedApiKey } from '../helpers/ours-claim.mjs'
import {
  capturePaths,
  closeSettings,
  finish,
  installEgressGate,
  openApiConfigSection,
  openSourceRow,
} from '../helpers/helpers.mjs'
import { inferenceBaseUrl } from '../../scripts/lib/endpoints.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')
const DIST = process.env.DIST_DIR || path.join(ROOT, 'dist')
const PORT = process.env.PORT
let APP_URL = process.env.APP_URL || ''
// #812：推理地址与登录环境同源（config/endpoints.json 的 consume.baseUrl）
const API_URL = inferenceBaseUrl
const MESSAGES_URL = `${API_URL}/v1/chat/completions`
const HOST = new URL(API_URL).hostname
const MODEL = 'deepseek-v4.1-flash'
const KEY = 'sk-internal-acceptance-key'
/** 切到第三方来源时用户自己填的那把（#596：内置那把绝不能被当成本机凭证带走） */
const OWN_KEY = 'sk-user-third-party-0123456789'
const THIRD_BASE = 'https://anthropic-relay.example.test'
const THIRD_MODEL = 'claude-relay-model'
const REPLY = '内测版验收回复：内置渠道已生效。'
/**
 * 界面上禁止出现的能力描述（能不能用只体现在入口显隐上，不写文案）—— 既有契约，别在重写时丢掉。
 * 它断的是**文案口径**，不是界面形状，所以和上面三条安全属性并列保留。
 */
const FORBIDDEN_WORDS = ['基础对话', '不支持', '已关闭', '仅支持', 'capability', '能力']
/** 证据截图写进系统临时目录：仓库里不留未跟踪产物（`git status` 必须是空的） */
const SHOT_DIR = process.env.SHOT_DIR || path.join(tmpdir(), 'internal-build-shots')

const failures = []
const ok = (message) => console.log(`  ok  ${message}`)
const bad = (message) => {
  failures.push(message)
  console.error(`  ✗   ${message}`)
}
/** 证据行：只打印，不进断言（红绿由 ok/bad 决定） */
const note = (message) => console.log(`  ·   ${message}`)

/** 轮询到条件成立：不靠 sleep（docs/TESTING-POLICY.md §11.5） */
const until = async (predicate, { timeoutMs = 8000, stepMs = 100 } = {}) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return true
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, stepMs))
  }
}

// ---------- 0) 起静态服务（内测构建） ----------
verifyDist(DIST, { variant: 'internal' })
const served = await serveDir(DIST, { port: PORT, label: '内测产物 dist' })
APP_URL = APP_URL || served.url
await verifyAppUrl(APP_URL, DIST, { variant: 'internal' })

const browser = await chromium.launch()
const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1280, height: 900 } })
const page = await context.newPage()

/**
 * 出站总闸（#673）：先在 `goto` 之前装好，白名单只有被测产物自身 + 推理 host。
 * 消费网关那两条与用例无关、却每次都会真出网的链（领取查重 / 账号资料）由既有桩应答。
 */
await installEgressGate(page, { appUrl: APP_URL, allowHosts: [new URL(API_URL).host] })

/** 推理上游：拦截并回 OpenAI 形状 SSE；断言直接看浏览器实际发出的 URL / 头 / 请求体 */
await page.route(`${API_URL}/**`, async (route) => {
  const url = route.request().url()
  if (url.includes('/models')) {
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: [{ id: MODEL, type: 'model' }] }),
    })
    return
  }
  if (!url.includes('/v1/chat/completions')) {
    await route.fulfill({ status: 200, headers: { 'content-type': 'application/json' }, body: '{}' })
    return
  }
  await route.fulfill({
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
    body: [
      `data: ${JSON.stringify({
        id: 'chatcmpl-mock-internal',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
      })}`,
      '',
      `data: ${JSON.stringify({
        id: 'chatcmpl-mock-internal',
        choices: [{ index: 0, delta: { content: REPLY }, finish_reason: null }],
      })}`,
      '',
      `data: ${JSON.stringify({
        id: 'chatcmpl-mock-internal',
        choices: [],
        usage: { prompt_tokens: 12, completion_tokens: 24, total_tokens: 36 },
      })}`,
      '',
      `data: ${JSON.stringify({
        id: 'chatcmpl-mock-internal',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      })}`,
      '',
      'data: [DONE]',
      '',
      '',
    ].join('\n'),
  })
})

const requests = capturePaths(page)

const shot = async (name) => {
  mkdirSync(SHOT_DIR, { recursive: true })
  const file = path.join(SHOT_DIR, `${name}.png`)
  await page.screenshot({ path: file, fullPage: true })
  note(`截图 ${file}`)
}

const settingsDialog = () =>
  page.locator('[role="dialog"]:has([data-testid="settings-list"], [data-testid^="settings-page-"])')

const readStorage = () =>
  page.evaluate(() => {
    const out = {}
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index)
      out[key] = window.localStorage.getItem(key)
    }
    return out
  })

/**
 * ① 界面不出现 Key 明文。
 *
 * 判据 = 「用户看见/抄得走的都是掩码」：
 *   · 任何**渲染成文字**的地方（可见文本、`textContent`、`title` / `aria-label` / `placeholder`）都不许有原文；
 *   · 输入框里**允许**持有原文，但必须是 `type="password"`（浏览器只会画掩码），且不许是可见的输入框
 *     （展开区的 Key 格是草稿态，收起时 `hidden`；这正是产品自己的口令输入形态）。
 * 只看 innerText 会漏掉「隐藏面板里塞了一段可复制的文字」，只看输入框会把所有口令框判红 —— 两处都要。
 */
const expectNoKeyPlaintext = async (where) => {
  const result = await page.evaluate((secret) => {
    const text = []
    if ((document.body.innerText ?? '').includes(secret)) text.push('可见文本')
    if ((document.body.textContent ?? '').includes(secret)) text.push('DOM 文本节点')
    for (const node of document.querySelectorAll('[title], [aria-label], [placeholder]')) {
      for (const attribute of ['title', 'aria-label', 'placeholder']) {
        const value = node.getAttribute(attribute)
        if (value !== null && value.includes(secret)) text.push(`${attribute}=${value.slice(0, 16)}…`)
      }
    }
    const holders = []
    for (const field of document.querySelectorAll('input, textarea')) {
      // `value` 属性与 `value` 属性值都算：React 首渲染会把受控值写成属性，
      // 「值只藏在属性里」与「值在 property 里」对用户是同一件事。
      const holds = String(field.value ?? '').includes(secret) || String(field.getAttribute('value') ?? '').includes(secret)
      if (!holds) continue
      holders.push({
        type: field.getAttribute('type') ?? 'text',
        label: field.getAttribute('aria-label') ?? '?',
        visible: field.checkVisibility?.() ?? true,
      })
    }
    return { text, holders }
  }, KEY)
  const unmasked = result.holders.filter((holder) => holder.type !== 'password')
  const visibleMasked = result.holders.filter((holder) => holder.type === 'password' && holder.visible)
  if (result.holders.length > 0) {
    note(
      `${where} 持有 Key 的输入框：${result.holders
        .map((holder) => `${holder.label}(type=${holder.type},visible=${holder.visible})`)
        .join(' / ')}`
    )
  }
  if (result.text.length > 0) {
    bad(`① ${where} 把 Key 明文渲染成了文字/属性：${result.text.join(' / ')}`)
  } else if (unmasked.length > 0) {
    bad(`① ${where} 有非口令输入框持有 Key 原文（能直接读到）：${unmasked.map((h) => h.label).join(' / ')}`)
  } else if (visibleMasked.length > 0) {
    // 口令框「可见且有值」= 屏幕上那一格是掩码串（用户看见的不是原文），这是产品自己的编辑态；
    // 但内置服务**不该**有可见的 Key 格（#800），所以这里仍要报出来。
    bad(`① ${where} 内置服务上出现了可见的 Key 输入框：${visibleMasked.map((h) => h.label).join(' / ')}`)
  } else {
    ok(`① ${where} 没有 Key 明文（文字 / 属性都查过；持有原文的口令框全部掩码且不可见）`)
  }
}

/** ② 内置服务行：一个可编辑控件都不许有（地址 / 模型也在这条里——它们连行都不渲染） */
const expectNoEditableBuiltinFields = async (where) => {
  const panel = page.getByTestId('settings-source-builtin-panel')
  const counts = await panel.evaluate((node) => ({
    // `type=file` 是「导入历史 / 聊天背景」用的隐藏选择器，不是配置入口
    editable: [...node.querySelectorAll('input, textarea, select')].filter(
      (field) => field.getAttribute('type') !== 'file'
    ).length,
    url: node.querySelectorAll('input[inputmode="url"]').length,
    password: node.querySelectorAll('input[type="password"]').length,
  }))
  note(`${where} 内置行展开区控件：${JSON.stringify(counts)}`)
  if (counts.editable !== 0) {
    bad(`② ${where} 内置行还有可编辑控件 ${counts.editable} 个（地址 / 模型 / Key 都不许在本地改）`)
  } else {
    ok(`② ${where} 内置行没有任何可编辑控件（地址 / 模型 / Key 都改不了）`)
  }
  // 内置值也不能被摊在界面上：既然看不见，就没有「照着抄走」这条路
  const text = await panel.innerText()
  const leaked = [HOST, MODEL].filter((secret) => text.includes(secret))
  if (leaked.length > 0) {
    bad(`② ${where} 内置行的展开区把内置值露出来了：${leaked.join(' / ')}`)
  } else {
    ok(`② ${where} 内置行的展开区不展示内置地址 / 模型`)
  }
}

try {
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => window.localStorage.clear())
  // #596：内测构建默认来源是内置服务，Key 只能由服务端下发 —— 种「已领取」形态（Key + 下发标记）
  await seedClaimedApiKey(page, KEY)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await until(async () => (await page.locator('textarea').count()) > 0)

  // ---------- ① 设置页（内置服务那一行） ----------
  console.log('\n① 界面不出现 Key 明文')
  await openApiConfigSection(page, { row: 'builtin' })
  const dialog = settingsDialog().first()
  await expectNoKeyPlaintext('内置服务设置页')
  // 当前使用 = 内置服务那一行打勾（打勾只绑生效来源，不绑「展开」）
  const checked = page.locator(
    '[data-testid="settings-source-accordion"] button[aria-expanded]:has([data-testid="settings-source-current"])'
  )
  const checkedLabel = (await checked.count()) > 0 ? (await checked.first().innerText()).trim().replace(/\n/g, ' ') : ''
  if (!/内置服务/.test(checkedLabel)) {
    bad(`内置服务不是「当前使用」那一行：${JSON.stringify(checkedLabel)}`)
  } else {
    ok(`当前使用 = ${checkedLabel}`)
  }

  // 文案口径（既有契约）：内置服务这一屏不许出现能力描述
  const settingsText = await dialog.innerText()
  const forbidden = FORBIDDEN_WORDS.filter((word) => settingsText.includes(word))
  if (forbidden.length > 0) {
    bad(`设置页出现了能力描述文案：${forbidden.join(' / ')}`)
  } else {
    ok('设置页没有能力描述文案（既有契约）')
  }

  // ---------- ② 内置服务行的地址 / 模型不可本地编辑 ----------
  console.log('\n② 内置服务行的地址 / 模型不可被本地编辑')
  await openSourceRow(page, 'builtin')
  await expectNoEditableBuiltinFields('展开后')
  await expectNoKeyPlaintext('展开内置行后')
  await shot('internal-builtin-row')

  // 「改不了」不是只有界面一层：真正发出去的地址 / 模型必须还是内置 spec 的那一份
  await closeSettings(page)

  const textarea = page.locator('textarea').last()
  await textarea.click()
  await textarea.fill('你好，内测版')
  await page.getByRole('button', { name: /^发送$|^Send$/ }).first().click()
  const replied = await until(async () => (await page.getByText(REPLY.slice(0, 10)).count()) > 0, { timeoutMs: 20000 })
  if (!replied) {
    bad('打桩上游的回复没有渲染到消息列表（内置来源发不出去）')
  } else {
    ok('打桩上游的回复已渲染到消息列表')
  }

  const posts = requests.filter(
    (request) => request.method === 'POST' && new URL(request.url).pathname === '/v1/chat/completions'
  )
  note(
    `浏览器发出的请求（略去产物自身静态资源）：${
      requests
        .filter((request) => !request.url.startsWith(APP_URL))
        .map((request) => `${request.method} ${request.url}`)
        .join(' , ') || '（无）'
    }`
  )
  if (posts.length === 0) {
    bad(`没有发出发消息请求（期望 ${MESSAGES_URL}）`)
  } else {
    const hit = posts[0]
    let body = {}
    try {
      body = JSON.parse(hit.postData ?? '{}')
    } catch {
      bad('请求体不是 JSON')
    }
    if (hit.url !== MESSAGES_URL) {
      bad(`发消息 URL 不是内置地址：${hit.url}`)
    } else {
      ok(`发消息 URL = ${hit.url}（内置 spec，不是本地可改值）`)
    }
    if (body.model !== MODEL) {
      bad(`body.model 不是内置模型：${JSON.stringify(body.model)}`)
    } else {
      ok(`body.model = ${body.model}（内置 spec）`)
    }
    if (hit.headers.authorization !== `Bearer ${KEY}`) {
      bad(`Authorization 头不对：${JSON.stringify(hit.headers.authorization)}`)
    } else {
      ok('Authorization = Bearer <服务端下发的那把>')
    }
  }

  // ---------- ③ 切到别的来源：原内置 Key 不被带到本地存储 ----------
  console.log('\n③ 切到别的来源后，原内置 Key 不被带到本地存储')
  await openApiConfigSection(page, { row: 'third' })
  const fill = async (field, value) => {
    const input = page.getByTestId(`settings-source-draft-${field}`)
    await input.first().fill(value)
  }
  await fill('baseUrl', THIRD_BASE)
  await fill('model', THIRD_MODEL)
  await fill('apiKey', OWN_KEY)
  await page.getByTestId('settings-source-third-confirm').first().click()
  const switched = await until(
    async () => (await page.evaluate(() => window.localStorage.getItem('chat-demo:provider-kind'))) !== 'ours'
  )
  const kind = await page.evaluate(() => window.localStorage.getItem('chat-demo:provider-kind'))
  if (!switched) {
    bad(`切不到第三方来源：chat-demo:provider-kind=${JSON.stringify(kind)}`)
  } else {
    ok(`生效来源已切到第三方（chat-demo:provider-kind=${kind}）`)
  }

  const stored = await readStorage()
  note(`localStorage: ${JSON.stringify(stored)}`)
  if (stored['chat-demo:api-key'] !== OWN_KEY) {
    bad(`③ 切来源后共用槽位不是用户自己的那把：${JSON.stringify(stored['chat-demo:api-key'])}`)
  } else {
    ok('③ 共用槽位换成了用户自己的 Key（内置那把没有被带过去）')
  }
  // 全量扫：内置那把不许被复制进任何别的键（含「下发标记」—— 它只该留指纹/尾号）
  const carriers = Object.entries(stored)
    .filter(([, value]) => typeof value === 'string' && value.includes(KEY))
    .map(([name]) => name)
  if (carriers.length > 0) {
    bad(`③ 内置 Key 原文出现在 localStorage 的这些键里：${carriers.join(', ')}`)
  } else {
    ok('③ 内置 Key 原文不在 localStorage 的任何键里（下发标记只留指纹 / 尾号）')
  }
  const mark = stored['chat-demo:ours-server-key']
  if (typeof mark === 'string' && mark.includes(KEY)) {
    bad('③ 下发标记里存了 Key 原文')
  } else {
    ok('③ 下发标记不含 Key 原文')
  }
  await expectNoKeyPlaintext('切到第三方来源后的设置页')
  await shot('internal-switched-third')
} catch (error) {
  failures.push(`用例异常：${error instanceof Error ? error.message : String(error)}`)
} finally {
  served.kill()
}

await finish(browser, 'tests/integration/internal-build.test.mjs', failures)
