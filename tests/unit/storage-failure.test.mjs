// [layer: unit | 纯 Node，无浏览器无网络（只有 structuredClone / Error 这类标准能力） | 耗时: <1s]
//
// P0 事故「清了后台以后聊天记录都不见了」的**逻辑层证据**。
//
// 事故链条（已复现，不再重复推导）：
//   1. `saveSession` 把 `sessions + sessionSummaries + files` 放在**同一个**事务里 →
//      任一 store 写失败（DataCloneError / QuotaExceededError / WebKit UnknownError）= 整条会话不落盘；
//   2. 失败态只活在内存（`sessionSaveErrors: Record<id, boolean>`）→ 重启后连横幅都没有；
//   3. `navigator.storage.persist()` 从未调用 → 整库可被系统淘汰（表现为「静默空列表」）。
//
// 本文件钉住「修完之后的分级 / 兜底 / 文案」这三块**纯逻辑**（没有 IndexedDB、没有浏览器）：
//   A `classifyStorageFailure`：四类判定（DataClone / Quota / WebKit UnknownError / InvalidState / 其它）
//   B `stripNonCloneableFields`：函数字段被剔除、普通字段保留、没坏字段时**原样返回**
//   C 横幅三档：kind → 档位 → i18n key，且 `unavailable` 不给重试
//   D `sessionSaveErrors` 兼容：旧值 `true` 当可重试档读；多原因时按最严重档
//
// 为什么 import 真代码而不是抄一份判定逻辑：判定口径的价值全在「生产里跑的就是这几行」，
// 抄一份替身只会在替身漂移时变绿（#547 的教训）。`db.ts` 的依赖图很干净
// （`idb` + `mergeSessions` + `blobKeys`，其余全是 `import type`），裸 Node 能直接装。
import '../helpers/injected.mjs'

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { installTsResolve, loadTsModule } from '../helpers/dom-env.mjs'

installTsResolve()

const db = await loadTsModule('src/services/chat/db.ts')
const zh = (await loadTsModule('src/i18n/zh.ts')).zh
const en = (await loadTsModule('src/i18n/en.ts')).en

const namedError = (name, message = 'boom') => {
  const error = new Error(message)
  error.name = name
  return error
}

// ---------------------------------------------------------------- A 四类判定

test('A1 classifyStorageFailure：DataCloneError → clone（会话里有不可克隆字段）', () => {
  assert.equal(db.classifyStorageFailure(namedError('DataCloneError', 'could not be cloned')), 'clone')
})

test('A2 classifyStorageFailure：QuotaExceededError → quota（Chromium / Firefox 两种名字都认）', () => {
  assert.equal(
    db.classifyStorageFailure(namedError('QuotaExceededError', 'The quota has been exceeded.')),
    'quota'
  )
  assert.equal(db.classifyStorageFailure(namedError('NS_ERROR_DOM_QUOTA_REACHED')), 'quota')
})

test('A3 classifyStorageFailure：WebKit 写 blob 的 UnknownError → unavailable（重试没用）', () => {
  assert.equal(db.classifyStorageFailure(namedError('UnknownError', 'An unknown error occurred')), 'unavailable')
  // 宿主没有 IndexedDB（无痕 / 分区存储被拦 / WebView 关存储）同样归这一档
  assert.equal(db.classifyStorageFailure(namedError('StorageUnavailableError')), 'unavailable')
  assert.equal(db.classifyStorageFailure(namedError('NotSupportedError')), 'unavailable')
})

test('A4 classifyStorageFailure：InvalidStateError → unknown（连接在关，重连后能再试）', () => {
  assert.equal(db.classifyStorageFailure(namedError('InvalidStateError', 'The database connection is closing')), 'unknown')
})

test('A5 classifyStorageFailure：其它 / 非 Error 抛值 → unknown（不许猜成「环境不支持」）', () => {
  assert.equal(db.classifyStorageFailure(new Error('QuotaExceededError')), 'unknown', 'name 不是 QuotaExceededError 就不能当配额')
  assert.equal(db.classifyStorageFailure('something went wrong'), 'unknown')
  assert.equal(db.classifyStorageFailure(undefined), 'unknown')
  assert.deepEqual(
    [...db.STORAGE_FAILURE_KINDS].sort(),
    ['clone', 'quota', 'unavailable', 'unknown'],
    '四类就是这四类：多一类少一类都要改这里'
  )
})

test('A6 storageFailureOf：只带元数据（kind / name / message / stores），message 截断', () => {
  const failure = db.storageFailureOf(namedError('QuotaExceededError', 'x'.repeat(500)), 'files')
  assert.equal(failure.kind, 'quota')
  assert.equal(failure.name, 'QuotaExceededError')
  assert.equal(failure.stores, 'files')
  assert.equal(failure.message.length, 200, 'message 截断到 200，避免把长句塞进日志')
  assert.equal(typeof failure.at, 'number')
})

// ---------------------------------------------------------------- B 不可克隆字段的兜底剔除

test('B1 顶层函数字段被剔除，其余字段与内容一个不动', () => {
  const session = {
    id: 's1',
    title: '标题',
    createdAt: 1,
    updatedAt: 2,
    messages: [{ id: 'm1', role: 'user', content: '你好' }],
    // 典型来源：某个回调 / 句柄被挂到了会话对象上
    onDone: () => {},
  }
  const { value, removed } = db.stripNonCloneableFields(session)
  assert.deepEqual(removed, ['onDone'])
  assert.equal('onDone' in value, false, '函数字段必须被剔除，否则重试还是 DataCloneError')
  assert.equal(value.id, 's1')
  assert.equal(value.title, '标题')
  assert.deepEqual(value.messages, session.messages, '消息内容不许被兜底逻辑吃掉')
  assert.doesNotThrow(() => structuredClone(value), '剔除之后必须真的可克隆')
})

test('B2 没有坏字段时**不改动**：返回原引用、removed 为空', () => {
  const session = { id: 's2', title: '干净', messages: [{ id: 'm', role: 'user', content: 'hi' }] }
  const result = db.stripNonCloneableFields(session)
  assert.equal(result.value, session, '干净数据必须原样返回（连引用都不能换，避免无谓重写）')
  assert.deepEqual(result.removed, [])
})

test('B3 坏字段藏在消息里：只剔成员，绝不整条消息扔掉', () => {
  const session = {
    id: 's3',
    messages: [
      { id: 'm1', role: 'user', content: '第一句' },
      { id: 'm2', role: 'assistant', blocks: [{ type: 'text', text: '回答' }], onRender: () => {} },
    ],
  }
  const { value, removed } = db.stripNonCloneableFields(session)
  assert.deepEqual(removed, ['messages[1].onRender'])
  assert.equal(value.messages.length, 2, '两条消息都必须留着 —— 剔除字段不能变成丢对话')
  assert.equal(value.messages[1].id, 'm2')
  assert.equal('onRender' in value.messages[1], false)
  assert.doesNotThrow(() => structuredClone(value))
})

test('B4 消息里的三种不可克隆成员（函数 / symbol / WeakMap）都只剔成员，消息条数不变', () => {
  for (const [label, bad] of [
    ['函数', () => {}],
    ['symbol', Symbol('handle')],
    ['WeakMap', new WeakMap()],
  ]) {
    const session = {
      id: 's4',
      messages: [
        { id: 'm1', role: 'user', content: '第一句' },
        { id: 'm2', role: 'assistant', blocks: [{ type: 'text', text: '回答' }], bad },
      ],
    }
    const { value, removed } = db.stripNonCloneableFields(session)
    assert.deepEqual(removed, ['messages[1].bad'], `${label}：只记路径`)
    assert.equal(value.messages.length, 2, `${label}：不许因为一个坏成员丢掉整条对话`)
    assert.equal('bad' in value.messages[1], false)
    assert.doesNotThrow(() => structuredClone(value), `${label}：剔除之后必须真的可克隆`)
  }
})

test('B5 数组一律不动：下次修复失败也不许把 messages / blocks 当成可疑对象删掉', () => {
  // Proxy 让 structuredClone 抛 DataCloneError，但它**是数组的元素**，兜底逻辑只能保留
  const hostile = new Proxy([{ id: 'm1' }], {})
  const session = { id: 's5', messages: hostile }
  const { value, removed } = db.stripNonCloneableFields(session)
  assert.notEqual(value.messages, undefined, 'messages 是「删了就等于丢对话」的关键字段，不许被剔除')
  assert.deepEqual(removed, [], '修不动就不动它，由上层把失败如实上报')
})

// ---------------------------------------------------------------- C 横幅三档

test('C1 kind=unknown / clone → 可重试档文案，且**必须**给重试', () => {
  for (const kind of ['unknown', 'clone']) {
    const tier = db.saveBannerTierOf(kind)
    assert.equal(tier, 'retry', `${kind} 是可重试档`)
    assert.equal(db.SAVE_BANNER_MESSAGE[tier], 'sessionSaveFailedRetryable')
    assert.equal(db.saveBannerRetryable(tier), true, '可重试档必须显示重试按钮')
  }
})

test('C2 kind=quota → 「本机存储空间不足…」并给重试', () => {
  const tier = db.saveBannerTierOf('quota')
  assert.equal(tier, 'quota')
  assert.equal(db.SAVE_BANNER_MESSAGE[tier], 'sessionSaveFailedQuota')
  assert.equal(db.saveBannerRetryable(tier), true)
})

test('C3 kind=unavailable → 「建议用 App 打开」，且**不显示重试**', () => {
  const tier = db.saveBannerTierOf('unavailable')
  assert.equal(tier, 'unavailable')
  assert.equal(db.SAVE_BANNER_MESSAGE[tier], 'sessionSaveFailedUnavailable')
  assert.equal(db.saveBannerRetryable(tier), false, '环境写不进去：重试点了也是同一个结果，不许给假出口')
})

test('C4 三档文案在 zh / en 成对存在且非空（不留孤立 key、不跨语言借原文）', () => {
  for (const key of Object.values(db.SAVE_BANNER_MESSAGE)) {
    assert.equal(typeof zh[key], 'string', `zh 缺 ${key}`)
    assert.equal(typeof en[key], 'string', `en 缺 ${key}`)
    assert.ok(zh[key].length > 0 && en[key].length > 0, `${key} 不许是空文案`)
  }
})

// ---------------------------------------------------------------- D sessionSaveErrors 兼容

test('D1 旧值 true（P0 之前的 Record<id, boolean>）当可重试档读', () => {
  assert.deepEqual(db.normalizeStorageFailure(true), { kind: 'unknown' })
  assert.equal(db.selectSaveBannerTier({ a: true }), 'retry', '旧值没有分类，不许被判成「环境不支持」')
})

test('D2 空 / 假值 → 没有横幅', () => {
  assert.equal(db.selectSaveBannerTier({}), null)
  assert.equal(db.selectSaveBannerTier({ a: false }), null, '旧代码写过的 false 表示「已恢复」，不能弹横幅')
  assert.equal(db.selectSaveBannerTier(undefined), null)
})

test('D3 多原因并存时按最严重档：unavailable > quota > 可重试', () => {
  const quota = { kind: 'quota' }
  const clone = { kind: 'clone' }
  const unavailable = { kind: 'unavailable' }
  assert.equal(db.selectSaveBannerTier({ a: clone, b: quota }), 'quota')
  assert.equal(db.selectSaveBannerTier({ a: quota, b: unavailable }), 'unavailable')
  assert.equal(db.selectSaveBannerTier({ a: true, b: unavailable }), 'unavailable')
  // 未知 kind（脏值）退化成可重试，不许冒充实环境问题
  assert.equal(db.selectSaveBannerTier({ a: { kind: 'nonsense' } }), 'retry')
})
