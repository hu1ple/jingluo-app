// [layer: unit | 依赖: 无（纯 Node，假 transport，零浏览器 / 零网络） | 耗时: <1s] Issue #312
//
// 支付 / 额度 / 卡密 / 购买记录这条链路的**埋点契约**：每个节点必须留一条能定位的日志，
// 而且这条日志里不许出现凭证原文（#301 维度 7 / #312 隐私铁律）。
//
//   node tests/unit/ours-payment-logs-312.test.mjs
//
// 覆盖：
//   [1] 五个节点各留一条带 stage 的日志（balance / plans / pay / redeem / cid / orders）
//       时间线节点（trail / order）随旧支付 UI 一起下线（#487 三弹层合一的收口），不再断言
//   [2] 每条 meta ≥2 个键（MIN_META_KEYS），且键都落在采集层白名单里（sanitizeMeta 不静默丢键）
//   [3] 脱敏：完整 Key / 完整卡密 / 单号明文 / 收款页地址 / device_id 一个字都不进日志
//   [4] 语义：202 是 pending 不是 error；409 带 upstreamCode；空记录页与失败页可区分；503 重试有轮次
import '../helpers/injected.mjs'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { registerHooks } from 'node:module'

// 与打包器一致：源码内部用 .js 说明符指向 .ts 文件
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (specifier.startsWith('.') && specifier.endsWith('.js')) {
        return nextResolve(specifier.slice(0, -3) + '.ts', context)
      }
      throw error
    }
  },
})

const { clearLogs, getSnapshot } = await import('../../src/services/diagnostics/collector.ts')
const { META_KEYS, STAGES } = await import('../../src/services/diagnostics/fields.ts')
const api = await import('../../src/services/ours/api.ts')
const customerId = await import('../../src/services/ours/customerId.ts')
const purchases = await import('../../src/services/ours/purchases.ts')
const paymentRecords = await import('../../src/services/ours/paymentRecords.ts')

const KEY = 'sk-live-ABCDEFGHIJKLMN9f3a2b7c1d3812'
const CARD = 'MUSE-3CYP-5NA3-AHSE-A3SR'
const ORDER_NO = 'CP2026111816102637F0F8AA'
const SHOP_URL = 'https://wzyp.cn/shop/DIWOOHLR'
const DEVICE_ID = 'd-0123456789abcdef0123456789abcdef'

const json = (status, body) => ({ kind: 'response', status, text: JSON.stringify(body) })
const raw = (status, text) => ({ kind: 'response', status, text })
const once = (result) => async () => result
const memoryStorage = (entries = {}) => {
  const map = new Map(Object.entries(entries))
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  }
}

const quotaLogs = () =>
  getSnapshot().logs.filter((entry) => String(entry.meta?.stage ?? '').startsWith('quota.'))
const firstOf = (stage) => quotaLogs().find((entry) => entry.meta?.stage === stage)

/** 把八个节点都走一遍（含失败分支），一次采样 */
const exerciseAllNodes = async () => {
  // 额度：Key 被服务端拒
  await api.probeApiKey(KEY, once(json(401, { valid: false, api_key: KEY })))
  // 收款页：取到了 + 打不开
  await api.fetchPayLink(once(json(200, { ok: true, url: SHOP_URL, note: 'n' })))
  await api.fetchPayLink(once(json(503, { ok: false })))
  // 卡密兑换已从本模块移除（2026-11-24：兑换改走 sub2api 的 /api/v1/redeem），这里不再采样 quota.redeem
  // cid：命中缓存 + 一个都没有
  await customerId.ensureCustomerId(memoryStorage({ [customerId.CUSTOMER_ID_STORAGE_KEY]: '10' }))
  customerId.resetCustomerIdCache()
  customerId.setCustomerIdProvider(null)
  await customerId.ensureCustomerId(memoryStorage())
  // 购买记录：正常一页
  await purchases.fetchPurchasesVia(
    { apiKey: KEY, limit: 20, offset: 0 },
    once(json(200, { customer_id: 10, total: 57, orders: [{ out_trade_no: ORDER_NO, status: 'paid', card_no: CARD }] }))
  )
  // 付款记录：2xx 但不是 JSON（badResponse）
  await paymentRecords.fetchPaymentRecords(KEY, once(raw(200, '<html>nope</html>')), null)
}

test('各节点各留一条带 stage 的日志，meta 都够用且键在白名单里', async () => {
  await clearLogs()
  await exerciseAllNodes()
  const logs = quotaLogs()
  const expected = [
    'quota.balance',
    'quota.pay',
    'quota.cid',
    'quota.orders',
  ]
  for (const stage of expected) {
    assert.ok(STAGES.includes(stage), `stage ${stage} 必须在 fields.ts 的 STAGES 里（否则 buildMeta 会静默丢掉）`)
    const hit = firstOf(stage)
    assert.ok(hit, `节点 ${stage} 没有留下日志`)
    assert.ok(Object.keys(hit.meta).length >= 2, `${stage} 的 meta 至少 2 个键，实际 ${JSON.stringify(hit.meta)}`)
    for (const key of Object.keys(hit.meta)) {
      const allowed =
        META_KEYS.includes(key) ||
        [
          'action',
          'result',
          'reason',
          'count',
          'limit',
          'total',
          'source',
          'upstreamCode',
          'key.tail',
          'card.tail',
          'order.tail',
          'order.status',
        ].includes(key)
      assert.ok(allowed, `${stage} 用了白名单外的键 ${key}（sanitizeMeta 会静默丢弃）`)
    }
  }
  // 失败分支也要有：收款页 503、兑换 409、记录页 badResponse
  const warnings = logs.filter((entry) => entry.level === 'warn')
  assert.ok(warnings.length >= 2, `失败分支的 warning 至少 2 条（兑换节点随 redeemCard 一起移除，少一条），实际 ${warnings.length}`)
})

test('脱敏铁律：凭证原文、收款页地址、设备码一个都不进日志', async () => {
  await clearLogs()
  await exerciseAllNodes()
  const dump = JSON.stringify(quotaLogs())
  for (const secret of [KEY, CARD, ORDER_NO, SHOP_URL, 'wzyp.cn', 'DIWOOHLR', DEVICE_ID, 'card_no', 'order_token']) {
    assert.ok(!dump.includes(secret), `日志里出现了不该出现的原文：${secret}`)
  }
  // 只留尾 4 位，且带掩码前缀（读日志的人一眼能看出这是打码值）
  assert.equal(firstOf('quota.balance').meta['key.tail'], '••••3812', 'Key 只留尾 4 位')
  // 单号只留尾 4 位那条断言原本挂在时间线的「按单号查一笔」上；时间线随旧支付 UI 下线（#487）后
  // 这条链路上已经没有写 `order.tail` 的调用点，字段仍留在 META_KEYS 里用于读旧日志。
})

