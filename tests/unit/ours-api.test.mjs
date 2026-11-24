// [layer: unit | 依赖: 无（纯 Node，零浏览器） | 耗时: <1s] 说明见 tests/README.md
// 「我们的渠道」卡密 / 支付服务（https://apia.ecsafe.cn）契约层单测（Issue #21）。
// 只 import src/services/ours/api.ts，用假 transport 断言「发了什么请求、怎么解释响应」，
// 完全不碰 DOM / Capacitor / 网络。
//
//   cd /root/worktrees/deepseek-pay-integration && node tests/unit/ours-api.test.mjs
//
// 覆盖（对应任务书验收）：
//   [1] 套餐：价格与积分全部取服务端（p1 = ¥3.00 / 300 积分），不硬编码；渲染模板可拼
//   [2] 积分只显示积分（#75）：额度文案不再做 points→人民币折算，zh/en 均无「约可消费 / about ¥」
//   [3] Key 校验：只回答有效/无效，不含任何额度；URL 不带 Key，走 Authorization 头
//   [4] 旧下单 / 查单链路已停用（#331）：api.ts 不再导出 /buy · /api/buy · /api/order 那套函数，
//       src 里没有 `/api/buy` 字面量，也没有 pollOrder / queryOrder / createBuyOrder 的调用点
//   [5] 兑换：request_id 固定用卡密；202 CREDIT_PENDING 是「处理中」不是失败
//   [6] 兑换错误码：API_KEY_INVALID / CARD_ALREADY_USED / CARD_NOT_FOUND / VERIFY_UNAVAILABLE / RATE_LIMITED
//   [7] 隐私：整条链路一条 console 都没有；文案/错误里没有完整 Key 与完整卡密
import { installTsResolve } from '../helpers/dom-env.mjs'
import { createSelfCheck, fakeTransport, jsonResponse as json } from '../helpers/ours-check.mjs'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

// 装配走公共入口（#408 收尾批）：`.js→.ts` 解析 + 自查断言骨架都不再逐文件手抄。
// 本文件没有模块替身（只 import 真源码，网络走假 transport 注入），所以 installTsResolve 不带 stubs。
installTsResolve()

const { zh } = await import('../../src/i18n/zh.ts')
const { en } = await import('../../src/i18n/en.ts')
const oursApi = await import('../../src/services/ours/api.ts')
const { payBaseUrl } = await import('../../scripts/lib/endpoints.mjs')
const {
  fetchPayLink,
  formatPlanMeta,
  formatPlanPrice,
  formatPoints,
  isOpenableCheckout,
  maskCard,
  maskKey,
  OURS_API_BASE,
  probeApiKey,
} = await import('../../src/services/ours/api.ts')
const oursApiModule = await import('../../src/services/ours/api.ts')

/** 与 i18n/index.ts 的 createTranslate 同一套占位符替换（只取 zh 文案，避开浏览器 store） */
const translate = (key, params) =>
  zh[key].replace(/\{(\w+)\}/g, (placeholder, name) =>
    params?.[name] === undefined ? placeholder : String(params[name])
  )

const KEY = 'sk-ours-unit-test-654321'
const KEY_TAIL = KEY.slice(-6)
const CARD = 'CARD-8f3a9b7c2d-4471'
const CARD_TAIL = CARD.slice(-4)
const OUT_TRADE_NO = 'CP2026111816102637F0F8AA'
const ORDER_TOKEN = 'Lsx2M8cBadOaJrXElnZBLISmtImUtfp9'
/** 实测的 /buy 302 Location（2026-11-18，真实收银台地址结构） */
const REAL_LOCATION = `https://pay.xiaodouap.cn/submit.php?pid=10268375&type=alipay&out_trade_no=${OUT_TRADE_NO}&notify_url=https%3A%2F%2Fapia.ecsafe.cn%2Fnotify&return_url=https%3A%2F%2Fapia.ecsafe.cn%2Freturn%3Fno%3D${OUT_TRADE_NO}%26order_token%3D${ORDER_TOKEN}&name=%E5%85%A5%E9%97%A8%E5%8C%85&money=3.00&sitename=muse2api&sign=da74773b105616c2eeed1821d788ab5b&sign_type=MD5`

const { failures, checks, ok, bad, eq, truthy } = createSelfCheck()

// ---------------------------------------------------------------- [1] 套餐价格文案（#861 起不再请求 /api/plans）
console.log('\n[1] 价格 / 额度文案格式化（套餐接口已下线，只留纯函数）')
{
  const plan = { id: 'p1', name: '入门包 100万 token', price: 3.0, points: 300, currency: 'CNY', enabled: true }
  eq(OURS_API_BASE, payBaseUrl, '卡密服务地址 = 配置里的 pay.baseUrl')
  eq(OURS_API_BASE.startsWith('https://'), true, '卡密服务走 HTTPS')
  eq(formatPlanPrice(plan), '¥3.00', '价格文案')
  // #487：单位统一为元（100 积分 = 1 元），300 积分 = ¥3.00
  eq(formatPoints(plan.points, zh.oursPointsUnit), '3.00 元', '额度文案（元）')
  eq(formatPlanMeta(plan, zh.oursPointsUnit), '¥3.00 · 3.00 元', '套餐行渲染文案（元）')
  eq(typeof oursApiModule.fetchPlans, 'undefined', 'api.ts 不再导出 fetchPlans（#861：/api/plans 已下线）')
}

// ---------------------------------------------------------------- [2] 额度按元显示
// #487：维护者要求统一计量（1 元 = 1 额度，无 USD 概念），旧「只显示积分、不折算」（#75）作废。
// 折算系数（100 积分 = 1 元）只有一处：src/utils/money.ts 的 POINTS_PER_YUAN / pointsToYuan。
console.log('\n[2] 额度按元显示：100 积分 = 1 元（#487 统一计量）')
{
  eq(
    translate('oursQuotaValue', { points: formatPoints(300, zh.oursPointsUnit) }),
    '3.00 元',
    '额度整行文案：300 积分 → 3.00 元'
  )
  eq(
    translate('oursQuotaValue', { points: formatPoints(100, zh.oursPointsUnit) }),
    '1.00 元',
    '额度整行文案：100 积分 → 1.00 元'
  )
  // 折算函数不在本模块里再长一份（只有 utils/money.ts 那一份），防止出现第二套系数
  eq(typeof oursApi.pointsToYuan, 'undefined', '不在 ours/api 里再导出一份 pointsToYuan')
  eq(typeof oursApi.formatYuan, 'undefined', '不在 ours/api 里再导出一份 formatYuan')
  eq(typeof oursApi.POINTS_PER_YUAN, 'undefined', '不在 ours/api 里再导出一份 POINTS_PER_YUAN')
  // zh/en 都不许留死键与残留换算模板
  const residue = []
  for (const [locale, table] of [['zh', zh], ['en', en]]) {
    for (const [key, text] of Object.entries(table)) {
      if (!key.startsWith('ours')) continue
      if (typeof text !== 'string') continue
      if (/\{yuan\}|约可消费|approx|about \{/.test(text)) residue.push(`${locale}.${key}=${text}`)
    }
  }
  eq(residue, [], 'zh/en 额度相关文案里没有第二套「约合 ¥」折算模板（#487：统一走元口径）')
  truthy(!/token/.test(zh.oursQuotaValue), '额度文案里没有 token')
  truthy(!/\$/.test(zh.oursQuotaValue), '额度文案里没有美元符号')
  // #487：本单位是元，zh 全表不许再出现 USD 字面量（留着就等于还承认 USD 口径）
  truthy(!/USD/i.test(JSON.stringify(zh)), '文案里没有 USD')
}

// ---------------------------------------------------------------- [3] Key 校验
console.log('\n[3] Key 校验：只回答有效/无效，不碰额度')
{
  const { transport, calls } = fakeTransport([json(200, { api_key: '…0383f0', valid: true })])
  const state = await probeApiKey(KEY, transport)
  eq(state.status, 'valid', 'valid=true → valid')
  eq(state.keyTail, `••••${KEY_TAIL}`, 'Key 只露尾 6 位')
  eq(calls[0].url, `${OURS_API_BASE}/api/balance`, 'URL 不带 query')
  eq(calls[0].headers.Authorization, `Bearer ${KEY}`, 'Authorization 头')
  truthy(!calls[0].url.includes(KEY), 'URL 里没有完整 Key')
  truthy(!('points' in state) && !('balance' in state), '返回值里没有额度字段（额度只认邀请服务）')

  const invalid = await probeApiKey(KEY, fakeTransport([json(200, { api_key: '…0383f0', valid: false })]).transport)
  eq(invalid.status, 'invalid', 'valid=false → invalid')
  const timeout = await probeApiKey(KEY, fakeTransport([{ kind: 'timeout' }]).transport)
  eq(timeout.status, 'timeout', '超时')
  const network = await probeApiKey(KEY, fakeTransport([{ kind: 'network' }]).transport)
  eq(network.status, 'network', '断网')
  const html = await probeApiKey(KEY, fakeTransport([{ kind: 'response', status: 200, text: '<html>' }]).transport)
  eq(html.status, 'invalid-json', '非法 JSON')
  const empty = await (async () => {
    const { transport: t2, calls: c2 } = fakeTransport([json(200, { valid: true })])
    return { state: await probeApiKey('   ', t2), calls: c2 }
  })()
  eq(empty.calls.length, 0, '空 Key 一次请求都不发')
  eq(empty.state.status, 'invalid', '空 Key → invalid')
}

// ---------------------------------------------------------------- [4][5] /buy
console.log('\n[4] 旧下单 / 查单链路已停用（#331）：没有 /api/buy 字面量，也没有轮询入口')
{
  // api.ts 不再导出这套函数：界面拿不到，也就没人能再拼回来（typeof 断言比 grep 更硬）
  const retired = ['buyUrl', 'startCheckout', 'parseCheckoutTarget', 'createBuyOrder', 'queryOrder', 'pollOrder']
  for (const name of retired) {
    eq(typeof oursApiModule[name], 'undefined', `api.ts 不再导出 ${name}`)
  }
  eq(typeof oursApiModule.isOpenableCheckout, 'function', 'isOpenableCheckout 仍保留（收款页也要判 https）')
  eq(typeof oursApiModule.fetchPayLink, 'function', '收款页地址改走 fetchPayLink（/api/pay-link）')

  // 源码级：生产代码里不许再出现 /api/buy 字面量，也不许再调旧链路函数
  const root = path.resolve(import.meta.dirname, '../..')
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : walk(full)
      return /\.(ts|tsx)$/u.test(entry.name) ? [full] : []
    })
  const files = walk(path.join(root, 'src'))
  const strip = (text) => text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '')
  const offenders = (pattern) =>
    files
      .filter((file) => pattern.test(strip(readFileSync(file, 'utf8'))))
      .map((file) => path.relative(root, file).split(path.sep).join('/'))
  eq(offenders(/\/api\/buy/u), [], 'src 里没有 /api/buy 字面量')
  eq(offenders(/\bpollOrder\b/u), [], 'src 里没有 pollOrder 调用点')
  eq(offenders(/\b(queryOrder|createBuyOrder|startCheckout|buyUrl)\b/u), [], 'src 里没有旧下单 / 查单函数')
  eq(offenders(/navigateTopLevel|openCheckoutInApp|withBuyCustomerId/u), [], 'src 里没有旧收银台跳转工具')
  eq(
    files.filter((file) => /(orderStore|returnParams|inAppPay)\.ts$/u.test(file)).length,
    0,
    '订单存档 / 回跳解析 / 内嵌收银台编排三个模块已删除'
  )
}
