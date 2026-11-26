// [layer: golden | 依赖: playwright + chromium + 标准产物 dist + mock 上游 + consume 接口全桩 | 预算: ≤60s]
//
// 黄金回归 · 域「账户可选」（#608 拆掉登录墙）：
//
//   ① **全新安装、不登录** → 首屏直接进聊天（没有登录页）；
//   ② **只填 Key**（服务配置 + Key，没有账号）→ 发一条消息 → 收到流式回复；
//   ③ 设置 → 数据管理 → 账户与消费 → **账号 tab** 里能注册（局部卡片，不跳整屏），注册即登录；
//   ④ 未登录时「我的额度」是**引导态**（不是报错、不是空白）。
//
// 为什么这四件事必须一起守：它们在 #608 之前是**一条链上的四个缺口** —— 根部被 `<AuthGate>` 包着，
// 于是 ① 首屏是登录页、② 官方渠道 + 自己的 Key 一个都用不了、③ 注册入口只在登录墙里、
// ④ 额度面板对未登录的人只回 401 文案。这一条跑通，等于「账户是可选能力」这个前提成立。
//
// 与 L0/L1 的分工：登录 / 注册的**分支矩阵**（401 / 500 / 冲突 / 发码频控 / 邀请码）在
// `tests/unit/auth-*.test.mjs`、`tests/unit/consume-panels-*.test.mjs` 与
// `tests/unit/account-optional-608.test.mjs` 里，这里**不重复**，只回答「用户那条主路径还在不在」。
//
// 后端全桩、**一个真请求都不发**：
//   · 对话上游 = 本机 mock SSE（`tests/fixtures/domain01-02/mock-upstream.mjs`）；
//   · 消费侧（sub2api）= `page.route` 按真契约回包（面板信封 + `access_token` / `user` / `page_size`）；
//   · 支付侧（apia 的 `/api/orders`）= 空列表（「我的卡密」tab 一进来就会取，不桩会去连真站）。
//
// 跑法（仓库根目录）：
//   node --test tests/golden/g16-account-optional.test.mjs
//   node tests/run-golden.mjs --only g16
// 产物由用例自己准备：它要的是**发版形态**（不带 `TEST_AUTH_SEAM`）的 `dist-noseam`，
// 缺了就现场构建一次 —— 拿带接缝的测试产物测「未登录」等于测了个假前提（见文件里的注释）。
import assert from 'node:assert'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'

import { startMockUpstream, writeStream } from '../fixtures/domain01-02/mock-upstream.mjs'
import { bodyText, brief, openGoldenPage, runGolden, serveGoldenApp, waitFor, waitForBoot } from '../helpers/golden.mjs'
import { consumeBaseUrl, payBaseUrl } from '../../scripts/lib/endpoints.mjs'
// 设置新 IA 的唯一路径（一级列表 + 二级页）：与 L1 同一份实现，别在这里自己点 DOM
import { ACCOUNT_ROW, openAccountRow, openSettingsPage, SETTINGS_ROW } from '../helpers/helpers.mjs'
// #596：切到 ours 时 Key 只能是「服务端下发」的形态（Key + 下发标记）
import { seedClaimedOursKey } from '../helpers/ours-claim.mjs'

const ROOT = path.resolve(import.meta.dirname, '../..')
/**
 * 这条用例要的是**发版形态**的产物（没有登录接缝）。
 *
 * 为什么不能借用黄金层的默认产物：CI 的 golden job 为了 G1~G15 带 `TEST_AUTH_SEAM=1` 构建，
 * DefinePlugin 把假会话内联进产物，于是「未登录」这个前提在测试构建里根本不存在 —— 拿它测 #608
 * 等于测了个假前提。而 #608 要守的恰恰是**用户装的那个包**：不登录、只填 Key，首屏就能聊天。
 *
 * 所以这里自己准备一份 `dist-noseam`（`DIST_OUT` + **不带** `TEST_AUTH_SEAM` 的同一条构建命令）。
 * 缺了就在用例里构建一次（约 6s，与本仓 unit 层 `gate-negative-controls` 里跑真构建是同一套做法），
 * 产物比源码旧也会重建 —— 「产物陈旧仍全绿」是这道防线最坏的失败方式。
 */
const NOSEAM_DIST = process.env.GOLDEN_NOSEAM_DIST ?? path.join(ROOT, 'dist-noseam')
/** build.mjs 的 `DIST_OUT` 只认相对仓库根的路径（绝对路径会让产物落到意料之外的地方），这里保持一致 */
const NOSEAM_DIST_OUT = 'dist-noseam'

const newestSourceMtime = (dir) => {
  let newest = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    const mtime = entry.isDirectory() ? newestSourceMtime(full) : statSync(full).mtimeMs
    newest = Math.max(newest, mtime)
  }
  return newest
}

/** 发版形态产物：缺 / 旧就现场构建一次（不带接缝） */
const ensureNoSeamDist = () => {
  const indexFile = path.join(NOSEAM_DIST, 'index.html')
  const fresh = existsSync(indexFile) && statSync(indexFile).mtimeMs >= newestSourceMtime(path.join(ROOT, 'src'))
  if (fresh) {
    return
  }
  if (process.env.GOLDEN_NOSEAM_DIST !== undefined) {
    throw new Error(
      `GOLDEN_NOSEAM_DIST 指定的产物缺 / 旧：${NOSEAM_DIST}（外部指定时由调用方自己构建，用例不覆盖它）`
    )
  }
  execFileSync(process.execPath, [path.join(ROOT, 'scripts/build.mjs')], {
    cwd: ROOT,
    // 显式摘掉接缝：这条产物必须是用户真正拿到的那一份
    env: { ...process.env, DIST_OUT: NOSEAM_DIST_OUT, TEST_AUTH_SEAM: '' },
    stdio: 'pipe',
  })
}

/** 只填 Key 的那把 Key（全新安装：localStorage 里只有服务配置，**没有账号 token**） */
const KEY = 'sk-golden-g16-000000000000000016'
const MODEL = 'mock-model'
/** 上游回答正文：只在「真的发出去了」时才可能出现在回答区 */
const ANSWER = '只填 Key 也能收到的回答'
/** 注册用的邮箱 / 密码（密码 8 位以上才过本地校验，见 authForm.MIN_PASSWORD_LENGTH） */
const EMAIL = 'g16@example.invalid'
const PASSWORD = 'g16-password'
/** 服务端面板信封：`code:0` + data（与 #484 实测形状一致） */
const envelope = (data) => ({ code: 0, message: 'success', data })

/** 收尾上限：超时就不再等（结论已经拿到，卡在清理里等于假红） */
const withDeadline = async (work, ms = 8000) => {
  let timer = null
  try {
    await Promise.race([
      Promise.resolve().then(work),
      new Promise((resolve) => {
        timer = setTimeout(resolve, ms)
      }),
    ])
  } finally {
    if (timer !== null) {
      clearTimeout(timer)
    }
  }
}

/** 最后一条回答的正文（与 G2/G3 用同一个内容选择器） */
const answerText = async (page) => {
  const nodes = page.locator('.ds-assistant-message-main-content')
  return (await nodes.count()) === 0 ? '' : (await nodes.last().innerText()).replace(/\s+/gu, ' ').trim()
}

/**
 * consume（sub2api）+ 支付（apia）全桩，**按 host + path 登记**（#667 跟进）。
 *
 * 只有四条被允许的 consume 路由：`settings/public`（注册入口显不显示由它说了算）、`auth/register`、
 * `user/profile` 与 `keys`。**其余一律 404** —— 主路径若悄悄多打一个接口，会在记录里露出来
 * （`consumeCalls`），不会因为「恰好也返回 200」被兜住。
 *
 * 为什么 host 必须进桩（原来只按 `page.route(`${consumeBaseUrl}/**`)` 前缀匹配）：那串前缀一旦
 * 因为端点配置改写而对不上，请求会**真的出网**打到真站；而如果代码把地址改道到另一台机器，
 * 桩不命中 → 请求要么出网、要么安静失败，用例只表现为「注册不成功」。现在未命中的请求由总闸
 * 记录（`method host+path`）并 abort，收尾断言直接点名它。
 */
const consumeHost = new URL(consumeBaseUrl).host
const apiaHost = new URL(payBaseUrl).host
const jsonHeaders = { 'content-type': 'application/json' }

const backendStubs = (consumeCalls) => [
  {
    // 整台 consume 主机都登记下来：命中后逐条分派，未登记的路径回 404（留证据而不是兜住）
    name: 'consume',
    host: consumeHost,
    path: /^\/.*$/u,
    respond: ({ path }) => {
      // 记录在 Node 侧（**不要**在 route handler 里调 page.evaluate：那会和页面的 fetch 互相等）
      consumeCalls.push(path)
      const json = (status, body) => ({ status, headers: jsonHeaders, body: JSON.stringify(body) })
      if (path === '/api/v1/settings/public') {
        // 注册入口必须由服务端开关打开：本地不许写死（#484 §3.1d）
        return json(
          200,
          envelope({ registration_enabled: true, email_verify_enabled: false, invitation_code_enabled: false })
        )
      }
      if (path === '/api/v1/auth/register') {
        // 注册即登录：成功体与 login 同形（`access_token` + `user`），见 services/auth/transport.ts 的文件头
        return json(
          200,
          envelope({
            access_token: 'g16-access-token',
            refresh_token: 'g16-refresh-token',
            expires_in: 3600,
            token_type: 'Bearer',
            user: { id: 16, email: EMAIL, username: '', role: 'user' },
          })
        )
      }
      if (path === '/api/v1/user/profile') {
        return json(200, envelope({ id: 16, email: EMAIL, username: '', role: 'user', balance: 12.5 }))
      }
      if (path === '/api/v1/keys') {
        // 空列表是正常态（不是错误）：账号 tab 登录后第一屏就是「还没有 Key」+ 创建框
        return json(200, envelope({ items: [], total: 0, page: 1, page_size: 20, pages: 0 }))
      }
      return json(404, { code: 404, message: `no route ${path}` })
    },
  },
  {
    // 支付侧（apia）：「我的卡密」tab 一打开就取 `/api/orders`，不桩会去连真站
    name: 'apia-orders',
    host: apiaHost,
    path: /^\/api\/orders$/u,
    respond: () => ({
      status: 200,
      headers: jsonHeaders,
      body: JSON.stringify({ customer_id: 0, total: 0, limit: 20, offset: 0, total_paid_yuan: 0, orders: [] }),
    }),
  },
]

/**
 * 原生桥桩（Capacitor 替身）—— 与 `g15-purchase.test.mjs` 同一套配方（见 `tests/golden/README.md`）。
 *
 * 为什么这条用例**必须**有它：消费层（`services/consume/http.ts`，#484 §4.6）只走原生
 * `CapacitorHttp`；`Capacitor.isNativePlatform()` 为假时它直接返回 `unsupported`，
 * **一个请求都不发**。于是「注册」这一步在浏览器里根本走不到 `/api/v1/auth/register`，
 * 断言 `consumeCalls.includes('/api/v1/auth/register')` 会假红。
 *
 * 做法：`window.androidBridge` 存在 → 平台判定为 android → `isNativePlatform()` 为真；
 * `window.Capacitor.PluginHeaders` 把 `CapacitorHttp.request` 声明成 promise 方法 → 核心层
 * 调 `nativePromise` 而不是 web 实现。这里让 `nativePromise` **在页面里真发一次 `fetch`** ——
 * 于是请求仍然落在本文件上面的 `page.route` 路由表上（`consumeCalls` 照常记录、CORS 预检照常
 * 走一遍），替身只负责「让原生通道存在」，不替用例改任何响应。
 */
const nativeBridgeStub = () => {
  window.androidBridge = { postMessage: () => {} }
  window.Capacitor = {
    PluginHeaders: [{ name: 'CapacitorHttp', methods: [{ name: 'request', rtype: 'promise' }] }],
    nativePromise: async (plugin, method, options) => {
      if (plugin !== 'CapacitorHttp') {
        return {}
      }
      const headers = {}
      for (const [name, value] of Object.entries(options?.headers ?? {})) {
        headers[String(name).toLowerCase()] = String(value)
      }
      const init = { method: String(options?.method ?? 'GET'), headers }
      if (typeof options?.data === 'string' && options.data !== '') {
        init.body = options.data
      }
      const response = await fetch(String(options?.url ?? ''), init)
      const text = await response.text()
      const responseHeaders = {}
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value
      })
      return { status: response.status, headers: responseHeaders, data: text, url: response.url }
    },
    nativeCallback: async () => '',
  }
}

/**
 * 设置 → **账户与消费**（2026-11-24 改版后的唯一真实路径）。
 *
 * 改前的写法是「点设置 → 点 `role=tab` 的『数据管理』→ 点 `account-consume-open`」：
 * #807 那次改版把一级列表 + 二级页做出来之后，「数据管理」页只剩导入/导出/反馈/删除，
 * 账户与消费被提成**一级列表里的一行**（`account-consume-open`），`role=tab` 整排消失 ——
 * 于是旧写法一进来就是 15s `locator.click` 超时（红在「找不到 tab」，不是产品坏了）。
 * 现在走 helpers 的唯一路径（与 L1 同一份 IA 口径，见 `tests/helpers/helpers.mjs` 文件头）。
 */
const openSettingsDataTab = async (page) => openSettingsPage(page, SETTINGS_ROW.consume)

test('G16 账户可选：不登录首屏可用 → 只填 Key 能收发 → 账号 tab 能注册 → 未登录额度给引导', async () => {
  // 发版形态产物（无登录接缝）：这条路径的前提就是「这台机器没有账号」
  ensureNoSeamDist()
  // 明确**不需要**接缝，跳过登录接缝前置自检（#510）：这条用例测的就是「没有账号也能用」，
  // 它要的恰恰是**无接缝**产物（`ensureNoSeamDist()` 用 `TEST_AUTH_SEAM=''` 构建的那一份）。
  const app = await serveGoldenApp(NOSEAM_DIST, { requiresAuthSeam: false })
  const mock = await startMockUpstream()
  mock.state.respond = async (_call, res) => writeStream(res, { chunks: [ANSWER] })

  /** consume 侧打过的路径（Node 侧收集，主路径断言「注册走了白名单端点」用） */
  const consumeCalls = []
  // 全新安装的全部「凭据」：只有服务配置 + 一把 Key，**没有** `chat-demo:auth-token`
  const { page, close, guard } = await openGoldenPage(app.url, {
    // 原生通道替身：没有它，消费层在浏览器里恒返回 `unsupported`，「注册」那一步走不到端点
    initScripts: [nativeBridgeStub],
    storage: {
      'chat-demo:provider-kind': 'anthropic',
      'chat-demo:api-key': KEY,
      'chat-demo:base-url:anthropic': mock.url,
      'chat-demo:model:anthropic': MODEL,
    },
    backends: {
      stubs: backendStubs(consumeCalls),
      // 对话上游是本机真起的 mock（端口 0）：显式放行，别的 host 一律拦下并记账
      allowHosts: [new URL(mock.url).host],
    },
  })
  try {
    await waitForBoot(page)

    const result = await runGolden(
      { id: 'G16', domain: '账户可选', title: '不登录首屏可用 → 只填 Key 能收发 → 账号 tab 能注册 → 未登录额度给引导' },
      async (ctx) => {
        // ── 1. 全新安装不登录：首屏就是聊天，没有登录页 ─────────────────────────
        ctx.begin('首屏（未登录）')
        const token = await page.evaluate(() => window.localStorage.getItem('chat-demo:auth-token'))
        const textarea = page.locator('textarea')
        const chatReady = await waitFor(page, async () => (await textarea.count()) > 0)
        if (!chatReady) {
          ctx.abort('不登录也能拿到聊天输入框', '页面上有 textarea', `body=${brief(await bodyText(page))}`)
        }
        const emailInputs = await page.locator('input[type="email"]').count()
        ctx.expect('首屏没有登录墙（没有账号 token、也没有登录表单）', token === null && emailInputs === 0, {
          expected: 'auth-token=null 且 页面上没有 input[type=email]',
          actual: `auth-token=${String(token)} / email 输入框 ${emailInputs} 个`,
        })

        // ── 2. 只填 Key → 发消息 → 收到流式回复 ───────────────────────────────
        ctx.begin('只填 Key 发消息')
        await textarea.last().click()
        await textarea.last().fill('不登录也能说话吗')
        await page.getByRole('button', { name: /^发送$|^Send$/ }).first().click()
        const replied = await waitFor(page, async () => (await answerText(page)).includes(ANSWER))
        ctx.expect('没有账号、只有 Key 也能收到回复', replied, {
          expected: ANSWER,
          actual: brief(await answerText(page)),
        })
        const tokenAfterChat = await page.evaluate(() => window.localStorage.getItem('chat-demo:auth-token'))
        ctx.expect('聊天全程没有偷偷建立账号会话', tokenAfterChat === null, {
          expected: 'auth-token 仍为 null',
          actual: String(tokenAfterChat),
        })

        // ── 3. 切到「我们的渠道」：账户入口只在这里出现（#166 的判据没变）────────
        ctx.begin('切到我们的渠道')
        // #596：切到 ours 时把 Key 种成「服务端下发」形态（只写 Key 会被发送前守卫判成未领取）
        await seedClaimedOursKey(page, KEY)
        await page.reload({ waitUntil: 'domcontentloaded' })
        if (!(await waitForBoot(page))) {
          ctx.abort('切渠道后重新进主界面', '欢迎页 / 会话列表可见', `body=${brief(await bodyText(page))}`)
        }

        // ── 4. 未登录时「我的额度」是引导态（#817：整页已删，这一拍改断**入口不存在**）──
        ctx.begin('未登录的额度 tab')
        // 前置条件：这一页（「账户与消费」入口）只在**自有渠道**下出现（#166 / #562 的判据没变）。
        // 第 2 步为了打本地 mock 上游走的是 anthropic 渠道，这里把渠道切到 ours 再 reload ——
        // 这是用例自己的环境准备，不是产品行为（切换后「只填的 Key」仍在，未登录态不变）。
        // #596：切到 ours 时把 Key 种成「服务端下发」形态（只写 Key 会被发送前守卫判成未领取）
        await seedClaimedOursKey(page, KEY)
        await page.reload({ waitUntil: 'domcontentloaded' })
        await waitForBoot(page)
        ctx.expect('切到自有渠道后仍未登录（切渠道不动账号态）', (await page.evaluate(() => window.localStorage.getItem('chat-demo:auth-token'))) === null, {
          expected: 'auth-token=null',
          actual: String(await page.evaluate(() => window.localStorage.getItem('chat-demo:auth-token'))),
        })
        await openSettingsDataTab(page)
        if (!(await waitFor(page, async () => (await page.getByTestId('account-consume-wallet').count()) > 0))) {
          ctx.abort('「账户与消费」页打开', 'L1 三行（模型来源 / 我的钱包 / 账号）在位', `body=${brief(await bodyText(page))}`)
        }
        // #817：「我的额度」整页退场（余额卡里的入口一起删了），未登录引导态那一套 `quota-*` 节点
        // 一并消失。这一拍只断「它真的不在了」；头像/登录这一档的引导态由账号页
        // （下面第 4 拍 + `tests/unit/consume-panels-quota.test.mjs` 的模型层）继续覆盖。
        await openAccountRow(page, ACCOUNT_ROW.wallet)
        const walletHeadShown = await waitFor(page, async () => (await page.getByTestId('account-consume-wallet-head').count()) > 0)
        ctx.expect(
          '未登录的钱包页：余额卡给「—」/「…」，且「我的额度」入口与面板都已删除',
          walletHeadShown &&
            (await page.getByTestId('account-consume-tab-quota').count()) === 0 &&
            (await page.getByTestId('quota-panel').count()) === 0,
          {
            expected: 'account-consume-wallet-head 出现；account-consume-tab-quota ×0；quota-panel ×0',
            actual: `head=${walletHeadShown} entry=${await page.getByTestId('account-consume-tab-quota').count()} panel=${await page.getByTestId('quota-panel').count()}`,
          }
        )

        // ── 4. 账号页（未登录）：**这一页本身就是登录卡**，不是登录墙、不是整屏 ────
        //
        // 口径变化（2026-11）：#788 把账号 L2 页改成「资料行 + 登录卡」手写版，
        // 未登录时挂的是 `SettingsAuthCard`（`settings-auth-card`，登录 / 注册分段 + 「暂不登录」），
        // 改版前的 `AccountPanel`（`account-optional-notice` / `account-fill-key` / `account-auth-card`）
        // 在设置里已经没有挂载点了 —— 断言按**现在的产品形状**写，不按已经不存在的节点写。
        ctx.begin('账号页（未登录）')
        // 「账号」是**账户与消费 L1** 的一行（改版前是同一页里的一个 tab）：上一步停在钱包 L2，
        // 先按 `account-consume-back` 退回 L1（openAccountRow 负责这一跳）。
        await openAccountRow(page, ACCOUNT_ROW.account)
        const authCard = page.getByTestId('settings-auth-card')
        const cardShown = await waitFor(page, async () => (await authCard.count()) > 0)
        if (!cardShown) {
          ctx.abort(
            '未登录进「账号」页就是登录 / 注册卡',
            '[data-testid="settings-auth-card"] 出现',
            `body=${brief(await bodyText(page))}`
          )
        }
        ctx.expect('登录 / 注册卡在设置弹层里（局部卡片，没有整屏登录墙）', (await page.getByRole('dialog').count()) > 0, {
          expected: '设置弹层仍在（role=dialog ≥1）',
          actual: `role=dialog ×${await page.getByRole('dialog').count()}`,
        })
        // #608 的口子：不登录也能用 —— 卡上直接给「暂不登录」（点了去填 API Key），不是逼人注册
        ctx.expect('卡上有「暂不登录」（不登录也能用的入口还在）', (await page.getByTestId('account-consume-skip-login').count()) === 1, {
          expected: 'account-consume-skip-login ×1',
          actual: `${await page.getByTestId('account-consume-skip-login').count()} 个`,
        })

        // ── 5. 注册：服务端开关打开 → 填表 → 提交走白名单端点 → 回到登录表单 ──────
        //
        // 2026-11-25 的产品口径：**注册成功不建立会话，终点是登录表单**（邮箱预填 + 一句
        // 「注册成功，请登录」），「注册即登录」那一版已经退场（见 SettingsAuthCard 文件头第四条）。
        // 所以这里钉的是「注册这条链路通不通、走的是哪个端点、回到哪一屏」，不是「登录态被悄悄建起来」。
        ctx.begin('注册')
        await page.getByTestId('auth-segmented-register').click()
        const registerEmail = page.getByTestId('settings-auth-email')
        if (!(await waitFor(page, async () => (await registerEmail.count()) > 0))) {
          ctx.abort('切到「注册」分段后露出邮箱输入框', 'settings-auth-email 出现', `body=${brief(await authCard.innerText())}`)
        }
        await registerEmail.fill(EMAIL)
        ctx.expect(
          '注册分段是一张完整表单：邮箱 + 验证码 + 密码 + 确认密码（同一张卡里，不换屏）',
          (await page.getByTestId('settings-auth-code').count()) === 1 &&
            (await page.getByTestId('settings-auth-password').count()) === 1 &&
            (await page.getByTestId('settings-auth-confirm').count()) === 1,
          {
            expected: 'code / password / confirm 各 1 个',
            actual: `code=${await page.getByTestId('settings-auth-code').count()} password=${await page.getByTestId('settings-auth-password').count()} confirm=${await page.getByTestId('settings-auth-confirm').count()}`,
          }
        )
        await page.getByTestId('settings-auth-password').fill(PASSWORD)
        await page.getByTestId('settings-auth-confirm').fill(PASSWORD)
        await page.getByTestId('settings-auth-submit').click()

        const notice = page.getByTestId('settings-auth-notice')
        const backToLogin = await waitFor(page, async () => (await notice.count()) > 0)
        const noticeText = backToLogin ? (await notice.innerText()).replace(/\s+/gu, ' ').trim() : ''
        ctx.expect('注册成功后回到登录表单并给出「注册成功，请登录」', backToLogin && noticeText.includes('注册成功'), {
          expected: 'settings-auth-notice 含「注册成功」',
          actual: backToLogin ? brief(noticeText) : `body=${brief(await authCard.innerText())}`,
        })
        ctx.expect('注册全程没有偷偷建立账号会话（注册 ≠ 登录）', (await page.evaluate(() => window.localStorage.getItem('chat-demo:auth-token'))) === null, {
          expected: 'auth-token 仍为 null',
          actual: String(await page.evaluate(() => window.localStorage.getItem('chat-demo:auth-token'))),
        })
        ctx.expect('注册走的是白名单端点 /api/v1/auth/register', consumeCalls.includes('/api/v1/auth/register'), {
          expected: '/api/v1/auth/register 被调用',
          actual: consumeCalls.join(' | '),
        })

        // ── 出站总闸（#667 跟进）：整条路径没有一条请求漏到白名单之外 ────────────
        ctx.begin('不连真实服务')
        guard.assertNoLeak(ctx)
      }
    )

    // 黄金 runner 的口径：断言失败已经在 ctx 里记过，这里再兜一层「一条都没红」
    assert.equal(result.failures.length, 0, `G16 有 ${result.failures.length} 条断言失败：${result.failures.join(' / ')}`)
  } finally {
    // 收尾带上限：SSE 长连接 / 未结算的 route handler 会让 close 之间互相等，
    // 那时宁可留一条残留，也不能把用例卡成「事件循环已退出但 Promise 还在挂」。
    await withDeadline(() => close())
    await withDeadline(() => mock.close())
    await withDeadline(() => app.close())
  }
})
