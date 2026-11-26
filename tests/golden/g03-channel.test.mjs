// [layer: golden | 依赖: playwright + chromium + 标准产物 dist + 本机 mock 上游 | 预算: ≤60s]
//
// 黄金回归 · 域 3「渠道」（Issue #404 第二批）。**只跑 1 条主路径**：
//   切渠道（DeepSeek 官方 → Anthropic 协议）→ Key 校验 → 发一条消息成功
//
// 为什么这条值钱：渠道切换是「一次配置改动就静默打断所有请求」的地方 —— 地址/模型/鉴权头任何一项
// 接错，界面都不报错，只是消息永远发不出去（或打到上一家渠道）。这里把三件套填进设置页，
// 用**用户点得着的「测试」按钮**验一次连通性，再真的发一条消息，并核对请求落在新渠道的
// 路径（`/v1/messages`）与鉴权头（`x-api-key`，Anthropic 协议**不带** anthropic-version）。
//
// 与 L1 的分工（tests/integration/provider-channels.test.mjs 已有四渠道 × 入口 × 请求体矩阵）：
// 这里**不**重复四个渠道的入口显隐、不重复请求体逐字节对比、不重复能力文案检查，
// 只回答一个问题：**普通用户把渠道切过去、把 Key 填对、点测试、再发一句话，还通不通。**
//
// 跑法（仓库根目录）：pnpm run build && node tests/golden/g03-channel.test.mjs
import { configureAnthropicChannel, startMockUpstream, writeStream } from '../fixtures/domain01-02/mock-upstream.mjs'
import {
  captureProbeRequests,
  clickApiKeyConfirm,
  clickTest,
  fillApiKey,
  fillBaseUrl,
  fillModel,
  openApiConfigSection,
  sendChat,
  SOURCE_ROW,
} from '../helpers/helpers.mjs'
import { bodyText, brief, openGoldenPage, runGolden, serveGoldenApp, waitFor, waitForBoot } from '../helpers/golden.mjs'

const KEY = 'sk-golden-g03-0123456789abcdef'
/**
 * 模型名以 `claude-` 开头 —— 这不是随便起的：**#794 取消了「协议二选一」**，
 * 第三方服务的协议由地址 / 模型**自动适配**（`src/services/api/protocolDetect.ts`）：
 * 主机名含 `anthropic`、或模型以 `claude` 开头 → Anthropic 协议；否则探一次模型列表再定，
 * 探不出结论就沿用原值。所以「切到 Anthropic 协议」在今天的用户路径上等于
 * **填一个 claude 模型 + 点确认使用**，而不是下拉里选一个协议。
 */
const MODEL = 'claude-golden-g03'
/** 上游回答正文：只在「真的发出去了」时才可能出现在回答区 */
const ANSWER = '渠道切换后的回答'

const answerText = async (page) => {
  const nodes = page.locator('.ds-assistant-message-main-content')
  return (await nodes.count()) === 0 ? '' : (await nodes.last().innerText()).replace(/\s+/gu, ' ').trim()
}

const result = await runGolden(
  { id: 'G3', domain: '渠道', title: '切渠道 → Key 校验 → 发一条消息成功' },
  async (ctx) => {
    const app = await serveGoldenApp()
    const mock = await startMockUpstream()
    mock.state.respond = async (_call, res) => writeStream(res, { chunks: [ANSWER] })
    // 探测请求（GET {baseUrl}/v1/models）由 mock 上游的 /models 路由应答，这里只负责记录
    // 出站总闸：本机 mock 上游（端口 0）显式放行，别的 host 一律拦下并记账（#667 跟进）
    const { page, close, guard } = await openGoldenPage(app.url, {
      backends: { allowHosts: [new URL(mock.url).host] },
    })
    const probes = captureProbeRequests(page)
    try {
      await waitForBoot(page)

      // ── 1. 切渠道：设置 → 账户与消费 → 模型来源 → 第三方服务那一行，露出地址 / 模型 / Key 三件套 ──
      //
      // 2026-11-24 改版 + #807 之后：① 设置是「一级列表 + 二级页」，`role=tab` 那一排没了；
      // ② 渠道/地址/Key 不再长在「数据管理」页，而是「账户与消费 → 模型来源」的三行手风琴里，
      // ③ 「展开 ≠ 生效」—— 切渠道要端点行底的「确认使用」。这三条都在 helpers 里实现，
      // 这里只按**意图**调用（`openApiConfigSection` = 旧「数据管理」页那块字段区的落点）。
      ctx.begin('切渠道')
      await openApiConfigSection(page, { row: SOURCE_ROW.third })
      // 三件套**按「当前展开的那一行」取**（`settings-source-third-panel` 里的三个 testid）。
      // 不数全页 input：三行手风琴的隐藏面板也挂着 `settings-source-draft-apiKey`，
      // 数出来的 password 输入框是 2 个 —— 那是 DOM 里还有另一行的副本，不是字段区少了东西。
      const panel = page.locator('[data-testid="settings-source-third-panel"]')
      const threeFields = await waitFor(
        page,
        async () =>
          (await panel.getByTestId('settings-source-draft-baseUrl').count()) === 1 &&
          (await panel.getByTestId('settings-source-draft-model').count()) === 1 &&
          (await panel.getByTestId('settings-source-draft-apiKey').count()) === 1
      )
      if (!threeFields) {
        ctx.abort(
          '切到「第三方服务」这一行后露出「服务地址 + 模型 + API Key」三件套',
          'settings-source-third-panel 里 baseUrl=1 / model=1 / apiKey=1',
          `body=${brief(await bodyText(page))}`
        )
      }
      // 地址指到本机 mock 上游：不连真实服务，但走的是真实请求路径
      await fillBaseUrl(page, mock.url)
      await fillModel(page, MODEL)
      await fillApiKey(page, KEY)
      // #807：行底按钮从「确定」变成「确认使用」（校验不过只写行内红字、不切渠道 —— helpers 会把红字原样抛出）
      await clickApiKeyConfirm(page)
      const stored = await page.evaluate(() => window.localStorage.getItem('chat-demo:api-key'))
      if (stored !== KEY) {
        ctx.abort('Key 落盘（chat-demo:api-key）', KEY, String(stored))
      }

      // ── 2. Key 校验：点「测试」→ GET {baseUrl}/v1/models + x-api-key → 一句可读结论 ──
      ctx.begin('Key 校验')
      await clickTest(page)
      const probed = await waitFor(page, async () => probes.length > 0)
      if (!probed) {
        ctx.abort(
          '点「测试」真的发出一次模型列表探测',
          `GET ${mock.url}/v1/models`,
          `body=${brief(await bodyText(page))}`
        )
      }
      ctx.expect('探测打的是刚填的那条地址', probes[0].url === `${mock.url}/v1/models`, {
        expected: `${mock.url}/v1/models`,
        actual: probes[0].url,
      })
      /**
       * 探测带的是**刚填的那把 Key** —— 这一条才是「Key 校验」的判据。
       *
       * 不断言「一定是 `x-api-key`」：#794 之后协议由地址 / 模型自动适配（这里模型是 `claude-*`），
       * 而这个「测试」按钮用的是**当前槽位**的协议（`thirdPartyEntryKind()`），用户刚填完还没点
       * 「确认使用」时槽位可能还是 OpenAI 风格 —— 那时带上的是 `authorization: Bearer`。
       * 所以这里钉「Key 确实被带上了、并且两种头里只有一种出现」，把实际情况打出来；
       * 「切到 Anthropic 之后请求头该怎么带」由下面**真的发一条消息**那一拍钉（x-api-key / 无 anthropic-version）。
       */
      const headerCarried = probes[0].apiKey === KEY || probes[0].authorization === `Bearer ${KEY}`
      ctx.expect('探测带上了刚填的那把 Key', headerCarried, {
        expected: `x-api-key 或 authorization: Bearer = 刚填的 Key`,
        actual: `x-api-key=${probes[0].apiKey === KEY ? '对' : probes[0].apiKey === undefined ? '（没带）' : '不对'} / authorization=${probes[0].authorization === `Bearer ${KEY}` ? '对' : probes[0].authorization === undefined ? '（没带）' : '不对'}`,
      })
      const probeOk = await waitFor(page, async () => (await bodyText(page)).includes('连接成功'))
      ctx.expect('校验结论是「连接成功」', probeOk, {
        expected: 'body 含「连接成功（HTTP 200）」',
        actual: `body=${brief(await bodyText(page))}`,
      })

      // ── 3. 发一条消息：请求落到新渠道，正文上屏 ──────────────────────────────────
      ctx.begin('发一条消息')
      const dialog = page.getByRole('dialog').first()
      if ((await dialog.count()) > 0) {
        await dialog
          .getByRole('button', { name: /^关闭$|^Close$/ })
          .first()
          .click()
          .catch(() => {})
      }
      await waitFor(page, async () => (await page.locator('textarea').count()) > 0)
      await sendChat(page, '渠道切换后的第一条提问')
      const answered = await waitFor(page, async () => (await answerText(page)).includes(ANSWER))
      ctx.expect('回答上屏（流式正文出现在回答区）', answered, {
        expected: `回答区含「${ANSWER}」`,
        actual: `回答区=${brief(await answerText(page))}`,
      })
      const call = mock.state.chatCalls[0]
      if (!call) {
        ctx.abort('发出的回答请求落到新渠道', '≥1 次 POST /v1/messages', '0 次')
      }
      const pathname = new URL(call.url, mock.url).pathname
      ctx.expect('请求打到 Anthropic 协议的 /v1/messages', pathname === '/v1/messages', {
        expected: '/v1/messages',
        actual: pathname,
      })
      // 协议对齐的落点：`syncThirdPartyProtocol()` 在发送链路里按「模型以 claude 开头」判成 anthropic，
      // 并把地址/模型搬进 anthropic 那一槽（`adoptThirdPartyConfig`）—— 这里钉这个事实
      const kind = await page.evaluate(() => window.localStorage.getItem('chat-demo:provider-kind'))
      ctx.expect('生效来源已按自动适配切到 anthropic（provider-kind）', kind === 'anthropic', {
        expected: 'chat-demo:provider-kind = anthropic',
        actual: String(kind),
      })
      ctx.expect('请求头带 x-api-key 且不带 anthropic-version（中转 CORS 口径）', call.headers['x-api-key'] === KEY && !call.headers['anthropic-version'], {
        expected: 'x-api-key 带上 Key，且没有 anthropic-version',
        actual: `x-api-key=${call.headers['x-api-key'] === KEY ? '对' : '不对/缺失'}，anthropic-version=${call.headers['anthropic-version'] === undefined ? '（没带）' : '带了'}`,
      })

      // ── 出站总闸（#667 跟进）：整条路径没有一条请求漏到白名单之外 ──────────────
      ctx.begin('不连真实服务')
      guard.assertNoLeak(ctx)

      // 兜底：configureAnthropicChannel 只用来证明「同样的渠道配置也能被 localStorage 直接表达」，
      // 这里不调用它 —— 保留导入是为了让「本地存储键名」这层契约在改动时立刻红。
      void configureAnthropicChannel
    } finally {
      await close()
      await mock.close()
      await app.close()
    }
  }
)

export default result
