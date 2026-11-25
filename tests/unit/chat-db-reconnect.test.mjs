// [layer: unit | 依赖: fake-indexeddb | 耗时: <1s]
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as fake from 'fake-indexeddb'
import { unwrap } from 'idb'
import { installTsResolve, loadTsModule } from '../helpers/dom-env.mjs'

// 合并测试批次可能已移除上一文件安装的 IndexedDB 全局。
for (const [name, value] of Object.entries(fake)) {
  if (name === 'indexedDB' || name.startsWith('IDB')) globalThis[name] ??= value
}
installTsResolve()
const db = await loadTsModule('src/services/chat/db.ts')
const session = (id, title) => ({ id, title, createdAt: 1, updatedAt: 1, messages: [] })

test('关闭连接后并发保存与读取共享一次重连，保留最新快照、摘要和附件', async (t) => {
  const a = session('reconnect-a', '旧标题')
  const b = session('reconnect-b', '已有会话')
  await Promise.all([db.saveSession(a), db.saveSession(b)])
  const old = await db.getChatDB()
  old.close()
  const opens = t.mock.method(indexedDB, 'open')
  const file = { id: 'reconnect-file', blob: new Blob(['original']) }
  const latest = { ...a, title: '最新标题' }
  const [, readB, , readA] = await Promise.all([
    db.saveSession({ ...a, title: '第一次修改' }, [file]),
    db.loadSession(b.id),
    db.saveSession(latest),
    db.loadSession(a.id),
  ])
  assert.equal(opens.mock.callCount(), 1)
  assert.deepEqual(readB, b)
  assert.deepEqual(readA, latest)
  assert.equal((await db.loadSessionSummaries()).find(item => item.id === a.id).title, latest.title)
  assert.equal(await (await db.loadFile(file.id)).text(), 'original')
})

test('读取先遇到显式关闭；异常终止后下一次取连接也能重开', async () => {
  const b = session('reconnect-read', '冷会话')
  await db.saveSession(b)
  const old = await db.getChatDB()
  old.close()
  assert.deepEqual(await db.loadSession(b.id), b)
  const reopened = await db.getChatDB()
  fake.forceCloseDatabase(unwrap(reopened))
  assert.notEqual(await db.getChatDB(), reopened)
  assert.deepEqual(await db.loadSession(b.id), b)
})

test('创建事务连续失败只重连一次，解除故障后仍可再次保存', async (t) => {
  const a = session('reconnect-retry', '重试后落盘')
  await db.getChatDB()
  const opens = t.mock.method(indexedDB, 'open')
  const start = t.mock.method(IDBDatabase.prototype, 'transaction', () => {
    throw new DOMException('closing', 'InvalidStateError')
  })
  /**
   * P0 起 `saveSession()` **不抛**：事务 A 失败以 `outcome.failure` 返回。
   * 为什么改：抛异常靠调用方 catch，而「catch 里忘了标红」正是静默丢数据的老路；
   * 返回失败让「落了没落」变成一次必须显式判断的返回值。
   * `InvalidStateError` 归 `unknown`（连接在关，重连后能再试），所以横幅是可重试档。
   */
  const failed = await db.saveSession(a)
  assert.equal(failed.failure?.kind, 'unknown')
  assert.equal(failed.failure?.name, 'InvalidStateError')
  assert.equal(start.mock.callCount(), 2)
  assert.equal(opens.mock.callCount(), 1)
  start.mock.restore()
  const saved = await db.saveSession(a)
  assert.equal(saved.failure, null, '故障解除后必须真的落盘')
  assert.equal(opens.mock.callCount(), 2)
  assert.deepEqual(await db.loadSession(a.id), a)
})

test('事务已创建时的写入错误不触发重连；DataCloneError 只剔坏字段、不带走整条会话', async (t) => {
  const a = session('reconnect-rollback', '原始标题')
  await db.saveSession(a)
  const opens = t.mock.method(indexedDB, 'open')
  const invalid = { ...a, title: '新标题', uncloneable: () => {} }
  /**
   * P0（本单核心）：`DataCloneError` 不再让**整条会话**失败。
   * 改造前 `sessions + sessionSummaries + files` 在同一个事务里，一个坏字段 = 整轮问答一个字都不落盘
   * （内存里照常可用，清后台重开就丢）。现在剔除顶层不可克隆字段后重试一次，其余内容照常落盘。
   * 「写入错误不触发重连 / 重放」这条不变量不变。
   */
  const outcome = await db.saveSession(invalid, [
    { id: 'reconnect-rollback-file', blob: new Blob(['partial']) },
  ])
  assert.equal(outcome.failure, null, '会话必须落盘（坏字段不该带走整条会话）')
  assert.deepEqual(outcome.strippedFields, ['uncloneable'], '剔掉了什么要如实报出来')
  assert.equal(opens.mock.callCount(), 0, '写失败不许触发重连或重放')
  const stored = await db.loadSession(a.id)
  assert.equal(stored.title, '新标题', '除了被剔除的字段，其余内容一个不丢')
  assert.equal(Object.hasOwn(stored, 'uncloneable'), false, '不可克隆字段不许落库')
  assert.equal(await (await db.loadFile('reconnect-rollback-file')).text(), 'partial')
})
