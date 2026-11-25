// [layer: unit | 依赖: fake-indexeddb、React、pdfjs 和仓库内文档夹具 | 耗时: <3s]
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { openAsBlob } from 'node:fs'
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import * as fake from 'fake-indexeddb'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { installEndpointsGlobals, installTsResolve, loadTsModule } from '../helpers/dom-env.mjs'

for (const [name, value] of Object.entries(fake)) {
  if (name === 'indexedDB' || name.startsWith('IDB')) globalThis[name] ??= value
}
installTsResolve()
installEndpointsGlobals()
const { attachmentManager: manager } = await loadTsModule('src/services/attachments/manager.ts')
const { getChatDB } = await loadTsModule('src/services/chat/db.ts')
const { getAttachmentService, setAttachmentService } = await loadTsModule(
  'src/components/attachments/attachmentService.ts'
)
const { useAttachmentDrafts } = await loadTsModule(
  'src/components/attachments/useAttachmentDrafts.ts'
)
const { useToast } = await loadTsModule('src/components/base/toastState.ts')
const { getSnapshot } = await loadTsModule('src/services/diagnostics/collector.ts')

const txt = (text, name = 'sample.txt') => new File([text], name, { type: 'text/plain' })
const storeKeys = async (store) => (await getChatDB()).getAllKeys(store)
const created = new Set()
async function addFile(file) {
  const attachment = await manager.addFile(file)
  created.add(attachment.id)
  return attachment
}
after(async () => {
  for (const id of created) await manager.remove(id)
})

function failWrite(t, storeName, errorName) {
  const error = new DOMException('injected write failure', errorName)
  for (const method of ['add', 'put']) {
    const original = IDBObjectStore.prototype[method]
    t.mock.method(IDBObjectStore.prototype, method, function (...args) {
      if (this.name === storeName) throw error
      return original.apply(this, args)
    })
  }
  return error
}

test('指纹计算降级时只读取一次选中的原件，两种算法共享同一份原件和标准 SHA-256', async (t) => {
  const file = txt('one source read')
  const native = await addFile(file)
  const reads = t.mock.method(file, 'arrayBuffer')
  t.mock.method(crypto.subtle, 'digest', async () => {
    throw new Error('digest unavailable')
  })
  const fallback = await addFile(file)
  assert.equal(reads.mock.callCount(), 1)
  assert.equal(native.sha256, createHash('sha256').update('one source read').digest('hex'))
  assert.equal(fallback.localPath, native.localPath)
  assert.notEqual(fallback.id, native.id)
})

test('选中的本地文件被删除后，再次添加时提示读取失败，已保存的副本仍能解析', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'attachment-read-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'local.txt')
  await writeFile(path, 'saved local contents')
  const file = new File([await openAsBlob(path)], 'local.txt', { type: 'text/plain' })
  const saved = await addFile(file)
  await unlink(path)
  await assert.rejects(manager.addFile(file), {
    stage: 'attachment.read',
    causeName: 'NotReadableError',
  })
  assert.equal((await manager.parse(saved.id)).status, 'success')
  assert.equal(await manager.getText(saved.id), 'saved local contents')
})

test('同一文件可复用或补回旧版 WebCrypto 的原件，删除新引用后旧附件仍能解析', async () => {
  const db = await getChatDB()
  // 旧版在小端设备上按 32 位字编码 digest 的实际值（输入为 abc）。
  const sha256 = 'bf1678baeacf018fde4041412322ae5da36103b09c7a179661ff10b4ad1500f2'
  const old = {
    id: 'att-old-byte-order',
    filename: 'old.txt',
    mimeType: 'text/plain',
    size: 3,
    sha256,
    localPath: 'attachment-' + sha256,
    status: 'pending',
    createdAt: 1,
  }
  await db.put('files', { id: old.localPath, blob: txt('abc') })
  await db.put('attachments', old)
  created.add(old.id)
  const before = await storeKeys('files')
  const added = await addFile(txt('abc', 'renamed.txt'))
  assert.equal(added.localPath, old.localPath)
  assert.equal(added.sha256, old.sha256)
  assert.deepEqual(await storeKeys('files'), before)
  await manager.remove(added.id)
  assert.equal(await (await db.get('files', old.localPath)).blob.text(), 'abc')
  await db.delete('files', old.localPath)
  const restored = await addFile(txt('abc'))
  assert.equal(restored.localPath, old.localPath)
  await manager.remove(restored.id)
  assert.equal((await manager.parse(old.id)).status, 'success')
  assert.equal(await manager.getText(old.id), 'abc')
})

test('并发添加相同内容时只新增一份原件，两条附件记录都已提交', async () => {
  const before = await storeKeys('files')
  const [a, b] = await Promise.all(
    ['a.txt', 'b.txt'].map((name) => addFile(txt('concurrent adds', name)))
  )
  assert.notEqual(a.id, b.id)
  assert.equal(a.localPath, b.localPath)
  assert.equal((await storeKeys('files')).length, before.length + 1)
  assert.deepEqual(await manager.getMeta(a.id), a)
  assert.deepEqual(await manager.getMeta(b.id), b)
})

for (const shared of [false, true]) {
  test(
    shared ? '重复添加写记录失败时，原有附件仍可读取' : '首次添加写记录失败时，刚写入的原件也回滚',
    async (t) => {
      const file = txt(shared ? 'previous attachment' : 'new attachment')
      const previous = shared ? await addFile(file) : undefined
      const files = await storeKeys('files')
      const attachments = await storeKeys('attachments')
      const failure = failWrite(t, 'attachments', 'QuotaExceededError')
      await assert.rejects(manager.addFile(file), (error) => {
        assert.equal(error.stage, 'attachment.store')
        assert.equal(error.cause, failure)
        return true
      })
      assert.deepEqual(await storeKeys('files'), files)
      assert.deepEqual(await storeKeys('attachments'), attachments)
      if (previous) {
        assert.deepEqual(await manager.getMeta(previous.id), previous)
        const source = await (await getChatDB()).get('files', previous.localPath)
        assert.equal(await source.blob.text(), 'previous attachment')
      }
    }
  )
}

test('写请求已成功但事务在提交前中止时，不返回附件，两张表都回滚', async (t) => {
  const files = await storeKeys('files')
  const attachments = await storeKeys('attachments')
  let recordWritten = false
  const add = IDBObjectStore.prototype.add
  t.mock.method(IDBObjectStore.prototype, 'add', function (...args) {
    const request = add.apply(this, args)
    if (this.name === 'attachments') {
      request.addEventListener('success', () => {
        recordWritten = true
        this.transaction.abort()
      })
    }
    return request
  })
  await assert.rejects(manager.addFile(txt('abort before commit')), {
    stage: 'attachment.store',
    causeName: 'AbortError',
  })
  assert.equal(recordWritten, true)
  assert.deepEqual(await storeKeys('files'), files)
  assert.deepEqual(await storeKeys('attachments'), attachments)
})

test('没有 Blob.arrayBuffer 的宿主可以添加并解析 TXT、DOCX 和 PDF', async (t) => {
  const read = Blob.prototype.arrayBuffer
  const reader = globalThis.FileReader
  const win = globalThis.window
  const pdfjs = createRequire(import.meta.url)('pdfjs-dist/legacy/build/pdf.js')
  globalThis.window = { pdfjsLib: { getDocument: pdfjs.getDocument, GlobalWorkerOptions: {} } }
  Blob.prototype.arrayBuffer = undefined
  globalThis.FileReader = class {
    readAsArrayBuffer(blob) {
      read.call(blob).then(
        (buffer) => {
          this.result = buffer
          this.onload()
        },
        (error) => {
          this.error = error
          this.onerror()
        }
      )
    }
  }
  t.after(() => {
    Blob.prototype.arrayBuffer = read
    if (reader === undefined) delete globalThis.FileReader
    else globalThis.FileReader = reader
    if (win === undefined) delete globalThis.window
    else globalThis.window = win
  })
  // DOCX 夹具含表格，解析器按原有约定给出表格转换提示，并标为 partial。
  for (const [ext, status, text] of [
    ['txt', 'success', '第三段 end.'],
    ['docx', 'partial', '| 甲'],
    ['pdf', 'success', 'Hello golden'],
  ]) {
    const name = 'tiny.' + ext
    const bytes = await readFile(new URL('../fixtures/golden/' + name, import.meta.url))
    const added = await addFile(new File([bytes], name))
    const saved = await (await getChatDB()).get('files', added.localPath)
    assert.deepEqual(Buffer.from(await read.call(saved.blob)), bytes)
    const parsed = await manager.parse(added.id)
    assert.equal(
      parsed.status,
      status,
      name + ': ' + (parsed.errorMessage ?? parsed.warnings ?? '')
    )
    assert.ok((await manager.getText(added.id)).includes(text), name)
  }
})

// 使用输入区实际的 addFiles 回调和实际的 toast store，仅提供 React 的挂载上下文。
function pickForToast(file) {
  let addFiles
  function Draft() {
    addFiles = useAttachmentDrafts().addFiles
    return null
  }
  renderToStaticMarkup(createElement(Draft))
  return new Promise((resolve) => {
    const unsubscribe = useToast.subscribe((state) => {
      if (state.message) {
        unsubscribe()
        resolve(state.message)
      }
    })
    addFiles([file])
  })
}

test(
  '文件读取、准备、空间不足、其他写入错误和服务未注册各有对应的提示',
  { timeout: 3000 },
  async (t) => {
    const previous = getAttachmentService()
    const win = globalThis.window
    globalThis.window = { setTimeout: () => 0, clearTimeout() {} }
    t.after(() => {
      setAttachmentService(previous)
      if (win === undefined) delete globalThis.window
      else globalThis.window = win
    })
    setAttachmentService(manager)
    const file = txt('error routing', 'source.txt')
    const read = t.mock.method(file, 'arrayBuffer', async () => {
      throw new DOMException('private detail', 'NotReadableError')
    })
    assert.deepEqual(await pickForToast(file), {
      key: 'attachAddReadFailed',
      params: { name: file.name },
    })
    assert.equal(read.mock.callCount(), 1)
    read.mock.restore()
    const makeId = t.mock.method(crypto, 'randomUUID', () => {
      throw new DOMException('private detail', 'OperationError')
    })
    assert.deepEqual(await pickForToast(file), {
      key: 'attachAddPrepareFailed',
      params: { name: file.name },
    })
    makeId.mock.restore()
    for (const [errorName, key] of [
      ['QuotaExceededError', 'attachAddStorageFull'],
      ['NS_ERROR_DOM_QUOTA_REACHED', 'attachAddStorageFull'],
      ['DataCloneError', 'attachAddStorageFailed'],
    ]) {
      failWrite(t, 'files', errorName)
      assert.deepEqual(await pickForToast(file), { key, params: { name: file.name } })
      t.mock.restoreAll()
    }
    const entries = getSnapshot().logs.filter(
      (entry) => entry.msg === 'document attachment add failed'
    )
    assert.deepEqual(
      entries.slice(-5).map((entry) => entry.meta),
      [
        { stage: 'attachment.read', 'error.name': 'NotReadableError' },
        { stage: 'attachment.prepare', 'error.name': 'OperationError' },
        { stage: 'attachment.store', 'error.name': 'QuotaExceededError' },
        { stage: 'attachment.store', 'error.name': 'NS_ERROR_DOM_QUOTA_REACHED' },
        { stage: 'attachment.store', 'error.name': 'DataCloneError' },
      ]
    )
    t.mock.method(manager, 'addFile', async () => {
      throw new Error('unexpected failure')
    })
    assert.deepEqual(await pickForToast(file), {
      key: 'attachAddFailed',
      params: { name: file.name },
    })
    setAttachmentService(null)
    assert.equal((await pickForToast(file)).key, 'attachUnavailable')
  }
)
