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
  await assert.rejects(db.saveSession(a), { name: 'InvalidStateError' })
  assert.equal(start.mock.callCount(), 2)
  assert.equal(opens.mock.callCount(), 1)
  start.mock.restore()
  await db.saveSession(a)
  assert.equal(opens.mock.callCount(), 2)
  assert.deepEqual(await db.loadSession(a.id), a)
})

test('事务已创建时的写入错误不会触发重连或重放', async (t) => {
  const a = session('reconnect-rollback', '原始标题')
  await db.saveSession(a)
  const opens = t.mock.method(indexedDB, 'open')
  const invalid = { ...a, title: '不应落盘', uncloneable: () => {} }
  await assert.rejects(db.saveSession(invalid, [
    { id: 'reconnect-rollback-file', blob: new Blob(['partial']) },
  ]), { name: 'DataCloneError' })
  assert.deepEqual(await db.loadSession(a.id), a)
  assert.equal(await db.loadFile('reconnect-rollback-file'), undefined)
  assert.equal(opens.mock.callCount(), 0)
})
