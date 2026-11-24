// [layer: unit | 依赖: fake-indexeddb | 耗时: <1s]
// 能力探测：宿主没有 IndexedDB 时（Safari 无痕 / WebView 关闭存储 / iframe 分区存储被拦）
// 必须**立刻给出确定错误**，而不是每次读写都再尝试一次 openDB（那会反复失败、刷满日志）。
//
//   node tests/unit/storage-capability-probe.test.mjs
//
// 两份断言：
//   [1] 没有 indexedDB → isIndexedDBAvailable() 为 false，getChatDB / loadSession 都抛
//       StorageUnavailableError（且**不是** idb 的 TypeError/InvalidStateError）
//   [2] 装上 indexedDB 之后同一条链路照常可用（探测不能把正常路径挡掉）
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as fake from 'fake-indexeddb'
import { installTsResolve, loadTsModule } from '../helpers/dom-env.mjs'

installTsResolve()
// 探测在**调用时**求值，所以在 import 之前清掉全局即可模拟「宿主没有这个能力」
const savedIndexedDB = globalThis.indexedDB
delete globalThis.indexedDB
const db = await loadTsModule('src/services/chat/db.ts')

test('[1] 缺能力：立刻给出确定错误，不尝试打开', async (t) => {
  t.after(() => {
    if (savedIndexedDB === undefined) delete globalThis.indexedDB
    else globalThis.indexedDB = savedIndexedDB
  })
  assert.equal(globalThis.indexedDB, undefined, '前置：本用例必须在没有 indexedDB 的环境里跑')
  assert.equal(db.isIndexedDBAvailable(), false, '探测必须如实回答 false')
  await assert.rejects(db.getChatDB(), (error) => {
    assert.equal(error.name, 'StorageUnavailableError')
    assert.ok(error instanceof db.StorageUnavailableError, '必须是专用错误，不能被当成瞬时故障去重试')
    return true
  })
  // 业务入口也要落到同一个错误上（不允许出现 TypeError / InvalidStateError 这类"看起来可重试"的错）
  await assert.rejects(db.loadSession('any-id'), (error) => error.name === 'StorageUnavailableError')
})

test('[2] 有能力的宿主：探测不挡正常路径', async () => {
  // idb 需要的不止 `indexedDB`：`IDBRequest` / `IDBTransaction` 等构造器也要挂上，
  // 否则会报 `IDBRequest is not defined`（与 chat-db-reconnect 用例同一套装法）。
  const installed = []
  for (const [name, value] of Object.entries(fake)) {
    if (name === 'indexedDB' || name.startsWith('IDB')) {
      if (globalThis[name] === undefined) {
        globalThis[name] = value
        installed.push(name)
      }
    }
  }
  globalThis.indexedDB = new fake.IDBFactory()
  installed.push('indexedDB')
  try {
    assert.equal(db.isIndexedDBAvailable(), true)
    const handle = await db.getChatDB()
    assert.ok(handle, '应当拿到可用连接')
    await db.saveSession({ id: 'probe-1', title: '探测', createdAt: 1, updatedAt: 1, messages: [] })
    assert.equal((await db.loadSession('probe-1')).title, '探测')
  } finally {
    for (const name of installed) delete globalThis[name]
  }
})
