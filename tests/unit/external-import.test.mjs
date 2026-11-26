// [layer: unit | 依赖: 无（纯 Node；原生桥 / fetch 都是注入替身，不建 Android 工程、不连网） | 耗时: <2s]
//
// 外部应用文件导入（WPS / 微信 / QQ / 系统文件管理器的「打开方式 / 分享」）的 L0 用例。
//
// 被测物只有一个：`src/services/externalImport.ts`（把原生批次转成 `File[]` + `rejected`）。
// 这一层只替换「外部世界」，业务代码原样运行：
//   - `@capacitor/core`：平台 / 桥替身（`getPlatform()` 读 `globalThis.__externalPlatform`）；
//   - `fetch` 出的字节：注入 `readBlob`，不碰真磁盘、不发请求。
//
//   node --test tests/unit/external-import.test.mjs
//   node tests/run-layer.mjs unit --only external-import
//
// 覆盖（对应需求 1~10 的验收点）：
//   [1] 非 Android 平台 → 完全不订阅、不报错（Web 端零行为变化）
//   [2] 冷启动：`consumePending()` 里的批次转成 `File`（MIME 按规范值给）
//   [3] 单文件 / 多文件（`filesReceived` 事件推过来的那一批同样走通）
//   [4] `application/octet-stream` 按扩展名二次校验；MIME 与扩展名不符 → 拒
//   [5] 不支持的扩展名 → 拒绝，且**不产生任何 File**（不会进草稿）
//   [6] 超限 → 拒绝（带上限值，提示里要用）
//   [7] 重复签名 → 只导入一次（事件与 consumePending 双投递也吃不掉第二份）
//   [8] 导入 / 被拒 / 被跳过之后都调 `clearTemp(ids)`（不留临时文件）
// 另外三条静态一致性断言（本机没有 Android SDK，只能靠它们防漂移）：
//   [9] `AndroidManifest.xml` 的三组 intent-filter 的 MIME 与 `SUPPORTED_EXTENSIONS` 对齐，
//       且没有 `*/*`、没有 BROWSABLE、没有存储权限
//  [10] `ExternalFilePlugin.java` 的三个体积上限字面量与 `ATTACHMENT_LIMITS` 一致
//  [11] 接线：外部导入复用 `useAttachmentDrafts().addFiles()`，且没有第二套解析 / 落盘
import '../helpers/injected.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { registerHooks } from 'node:module'
import { asTypescript } from '../fixtures/domain05/hooks.mjs'

const ROOT = path.resolve(import.meta.dirname, '../..')

/** `@capacitor/core` 替身：平台读 `globalThis.__externalPlatform`，`convertFileSrc` 原样返回 */
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@capacitor/core') {
      const source = `
        export const Capacitor = {
          getPlatform: () => globalThis.__externalPlatform,
          isNativePlatform: () => globalThis.__externalPlatform === 'android' || globalThis.__externalPlatform === 'ios',
          convertFileSrc: (value) => value,
        }
        export const CapacitorHttp = { get: async () => ({}) }
        export const registerPlugin = () => globalThis.__externalBridge ?? {}
      `
      return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true }
    }
    const typescript = asTypescript(specifier, context.parentURL)
    if (typescript !== null) {
      return { url: typescript, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})

globalThis.__externalPlatform = 'android'
globalThis.__externalBridge = {}

const mod = await import('../../src/services/externalImport.ts')
const limits = await import('../../src/services/attachments/limits.ts')

const {
  isExternalImportSupported,
  resolveImportExtension,
  resetExternalImportState,
  subscribeExternalImport,
} = mod

const MB = 1024 * 1024

/** 每个用例前重置：平台、进程内去重表、收件箱（去重表不清会让「同一份文件」跨用例消失） */
const reset = (platform = 'android') => {
  globalThis.__externalPlatform = platform
  resetExternalImportState()
}

/**
 * 假桥：`pending` 是 `consumePending()` 依次返回的批次（用完后返回空批次），
 * `emit()` 模拟原生 `filesReceived` 事件（热启动那条路）。
 */
const makeBridge = ({ pending = [] } = {}) => {
  const calls = { consume: 0, clear: [], listeners: 0, removed: 0 }
  const queue = [...pending]
  const handlers = []
  const bridge = {
    consumePending: async () => {
      calls.consume += 1
      return queue.length > 0 ? queue.shift() : { files: [], rejected: [] }
    },
    clearTemp: async ({ ids }) => {
      calls.clear.push(ids)
    },
    addListener: async (name, listener) => {
      assert.equal(name, 'filesReceived', '事件名必须是 filesReceived')
      calls.listeners += 1
      handlers.push(listener)
      return {
        remove: async () => {
          calls.removed += 1
        },
      }
    },
  }
  return { bridge, calls, emit: (batch) => handlers.forEach((handler) => handler(batch)) }
}

/** 读字节的替身：只记 srcPath，返回一份固定字节的 Blob（不碰磁盘） */
const makeReader = () => {
  const read = []
  return {
    read,
    readBlob: async (srcPath) => {
      read.push(srcPath)
      return new Blob([new Uint8Array([0x25, 0x50, 0x44, 0x46])])
    },
  }
}

const txt = (over = {}) => ({
  id: 'id-txt',
  name: 'note.txt',
  mimeType: 'text/plain',
  size: 4,
  srcPath: '/data/user/0/pkg/cache/external-import/id-txt-note.txt',
  ...over,
})
const docx = (over = {}) => ({
  id: 'id-docx',
  name: 'grader.docx',
  mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  size: 8,
  srcPath: '/data/user/0/pkg/cache/external-import/id-docx-grader.docx',
  ...over,
})
const pdf = (over = {}) => ({
  id: 'id-pdf',
  name: 'paper.pdf',
  mimeType: 'application/pdf',
  size: 12,
  srcPath: '/data/user/0/pkg/cache/external-import/id-pdf-paper.pdf',
  ...over,
})

/** 一次订阅 + 收集所有批次（用例里都只关心这串） */
const collect = async (options = {}) => {
  const batches = []
  const { bridge, calls, emit } = makeBridge(options)
  const reader = makeReader()
  const unsubscribe = await subscribeExternalImport((batch) => batches.push(batch), {
    bridge,
    readBlob: options.readBlob ?? reader.readBlob,
    now: options.now,
  })
  return { batches, calls, emit, read: reader.read, unsubscribe, bridge }
}

/* ------------------------------------------------------------------ [1] 非 Android */

test('[1] 非 Android 平台：完全不订阅、不报错', async () => {
  reset('web')
  const { bridge, calls } = makeBridge({ pending: [{ files: [txt()], rejected: [] }] })
  const batches = []
  let threw = false
  let unsubscribe
  try {
    unsubscribe = await subscribeExternalImport((batch) => batches.push(batch), { bridge })
  } catch {
    threw = true
  }
  assert.equal(threw, false, 'Web 端不许抛错（调用方没有 try/catch 的习惯）')
  assert.equal(isExternalImportSupported(), false)
  assert.equal(typeof unsubscribe, 'function', 'Web 端也要返回可调用的退订函数')
  assert.doesNotThrow(() => unsubscribe())
  // 三条关键：一次桥调用都没有 → 网页端「没有这个功能」时行为与现在完全一致
  assert.equal(calls.consume, 0, 'Web 端不许调用 consumePending')
  assert.equal(calls.listeners, 0, 'Web 端不许注册 filesReceived 监听')
  assert.equal(batches.length, 0, 'Web 端不许产出任何批次（也就不会弹提示）')

  // 对照：同一条桥在 android 上确实会订阅（否则上面的 0 只是「桥坏了」）
  reset('android')
  const android = await collect({ pending: [{ files: [txt()] }] })
  assert.equal(android.batches.length, 1)
  assert.equal(android.batches[0].files.length, 1)
  android.unsubscribe()
})

/* ------------------------------------------------------------------ [2] 冷启动 pending */

test('[2] 冷启动：consumePending 的批次转成 File（MIME 用规范值）', async () => {
  reset()
  const { batches, calls, read, unsubscribe } = await collect({
    pending: [{ files: [pdf()] }],
  })
  assert.equal(calls.consume, 2, '冷启动先 drain 一次，监听挂上后再补 drain 一次（收窄竞态窗口）')
  assert.equal(batches.length, 1)
  const [batch] = batches
  assert.equal(batch.rejected.length, 0)
  assert.equal(batch.files.length, 1)
  const [file] = batch.files
  assert.ok(file instanceof File, '必须是真 File（addFiles 只认 File）')
  assert.equal(file.name, 'paper.pdf')
  assert.equal(file.type, 'application/pdf', 'MIME 要按扩展名归一成规范值')
  assert.equal(file.size, 4, '字节来自 readBlob 的 Blob，不是原生报的 size')
  assert.deepEqual(read, [pdf().srcPath], '按 srcPath 走 convertFileSrc 读字节（不是 base64）')
  unsubscribe()
})

/* ------------------------------------------------------------------ [3] 单文件 / 多文件 */

test('[3] 单文件（SEND）与多文件（SEND_MULTIPLE）都走同一条路', async () => {
  reset()
  // 冷启动：单文件
  const single = await collect({ pending: [{ files: [txt()] }] })
  assert.equal(single.batches[0].files.length, 1)
  single.unsubscribe()

  // 热启动：一批三个文件（SEND_MULTIPLE 的语义），由事件推过来
  reset()
  const multi = await collect()
  multi.emit({ files: [txt(), docx(), pdf()] })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(multi.batches.length, 1)
  assert.equal(multi.batches[0].files.length, 3)
  assert.deepEqual(
    multi.batches[0].files.map((file) => file.type),
    [
      'text/plain',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/pdf',
    ]
  )
  multi.unsubscribe()
})

/* ------------------------------------------------------------------ [4] octet-stream 二次校验 */

test('[4] octet-stream / 空 MIME 按扩展名判定；MIME 与扩展名不符则拒', async () => {
  reset()
  // 直接钉住判定函数：octet-stream 与空串都「交给扩展名」
  assert.equal(resolveImportExtension('a.txt', 'application/octet-stream'), '.txt')
  assert.equal(resolveImportExtension('a.pdf', 'application/octet-stream'), '.pdf')
  assert.equal(resolveImportExtension('a.docx', ''), '.docx')
  assert.equal(resolveImportExtension('a.txt', 'text/plain; charset=utf-8'), '.txt')
  assert.equal(resolveImportExtension('a.exe', 'application/octet-stream'), null)
  assert.equal(resolveImportExtension('a.pdf', 'application/msword'), null, '改名成 .pdf 的 doc 要被挡下')
  assert.equal(resolveImportExtension('noext', 'application/pdf'), null)

  const { batches, unsubscribe } = await collect({
    pending: [
      {
        files: [
          txt({ id: 'o1', name: 'wps.txt', mimeType: 'application/octet-stream', srcPath: '/cache/o1' }),
          pdf({ id: 'o2', name: 'wps.pdf', mimeType: 'application/octet-stream', srcPath: '/cache/o2' }),
          txt({ id: 'o3', name: 'fake.exe', mimeType: 'application/octet-stream', srcPath: '/cache/o3' }),
          txt({ id: 'o4', name: 'lying.pdf', mimeType: 'application/msword', srcPath: '/cache/o4' }),
        ],
      },
    ],
  })
  const [batch] = batches
  assert.deepEqual(
    batch.files.map((file) => `${file.name}:${file.type}`),
    ['wps.txt:text/plain', 'wps.pdf:application/pdf'],
    'octet-stream 的两个按扩展名收下，并换成规范 MIME'
  )
  assert.deepEqual(
    batch.rejected.map((item) => `${item.name}:${item.reason}`),
    ['fake.exe:unsupported', 'lying.pdf:unsupported'],
    '扩展名不支持 / MIME 与扩展名不符的都进 rejected'
  )
  unsubscribe()
})

/* ------------------------------------------------------------------ [5] 不支持的扩展名不产生草稿 */

test('[5] 不支持的扩展名：拒绝且不产生任何 File（不会进草稿）', async () => {
  reset()
  const { batches, read, calls, unsubscribe } = await collect({
    pending: [
      { files: [{ id: 'z1', name: 'setup.exe', mimeType: 'application/octet-stream', size: 99, srcPath: '/cache/z1' }] },
    ],
  })
  const [batch] = batches
  assert.equal(batch.files.length, 0, '一个 File 都不许产出（草稿里就不会多出卡片）')
  assert.deepEqual(batch.rejected, [{ name: 'setup.exe', reason: 'unsupported' }])
  assert.deepEqual(read, [], '被拒的文件一个字节都不读')
  assert.deepEqual(calls.clear, [['z1']], '被拒的副本也要清掉（原生可能已经落过副本）')
  unsubscribe()
})

/* ------------------------------------------------------------------ [6] 超限 */

test('[6] 超限：拒绝，并带上限值（提示里要显示上限）', async () => {
  reset()
  assert.equal(limits.ATTACHMENT_LIMITS.pdfMaxBytes, 50 * MB, '前提：PDF 上限就是 50MB')
  const { batches, read, unsubscribe } = await collect({
    pending: [
      {
        files: [
          pdf({ id: 'big', name: 'huge.pdf', size: 51 * MB, srcPath: '/cache/big' }),
          txt({ id: 'ok', name: 'fine.txt', size: 5 * MB, srcPath: '/cache/ok' }),
        ],
      },
    ],
  })
  const [batch] = batches
  assert.equal(batch.files.length, 1, '正好等于上限的仍要收下（边界不许误杀）')
  assert.equal(batch.files[0].name, 'fine.txt')
  assert.deepEqual(batch.rejected, [
    { name: 'huge.pdf', reason: 'tooLarge', size: 51 * MB, limitBytes: 50 * MB },
  ])
  assert.deepEqual(read, ['/cache/ok'], '超限的不读字节（原生那边也不会复制）')
  unsubscribe()
})

/* ------------------------------------------------------------------ [7] 重复签名 */

test('[7] 重复签名：只导入一次（事件 + consumePending 双投递也不重复）', async () => {
  reset()
  const reader = makeReader()
  const { bridge, calls, emit } = makeBridge({ pending: [{ files: [txt()] }] })
  const batches = []
  const unsubscribe = await subscribeExternalImport((batch) => batches.push(batch), {
    bridge,
    readBlob: reader.readBlob,
  })
  assert.equal(batches.length, 1)
  assert.equal(batches[0].files.length, 1)

  // 同一个文件（同 id / srcPath / size）再来一次：这一次是「同一次分享的第二份投递」
  emit({ files: [txt()] })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(reader.read.length, 1, '同一份文件只读一次字节（不会重复解析）')
  const imported = batches.reduce((total, batch) => total + batch.files.length, 0)
  assert.equal(imported, 1, '只导入一次')
  // 第二份既没有文件也没有拒绝项 → 连 handler 都不该被调（界面不弹提示、草稿不多卡片）
  assert.equal(batches.length, 1, '重复的那一批完全静默（不产生一个空批次）')
  const cleared = calls.clear.flat()
  assert.deepEqual(cleared, ['id-txt', 'id-txt'], '重复那份的副本仍然要清掉（它会触发一次 clearTemp）')

  unsubscribe()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(calls.removed >= 1, true, '退订要真的把监听摘掉')
})

/* ------------------------------------------------------------------ [8] clearTemp */

test('[8] 导入完成后调用 clearTemp(ids)：成功的和被拒的副本都清', async () => {
  reset()
  const { batches, calls, unsubscribe } = await collect({
    pending: [
      {
        files: [txt({ id: 'c1', srcPath: '/cache/c1' }), pdf({ id: 'c2', size: 60 * MB, srcPath: '/cache/c2' })],
        rejected: [{ name: 'x.bin', reason: 'readFailed' }],
      },
    ],
  })
  assert.equal(batches.length, 1)
  assert.equal(batches[0].files.length, 1)
  assert.deepEqual(calls.clear, [['c1', 'c2']], '一次调用带上这一批的所有 id（导入完就该删副本）')
  unsubscribe()
})

/* ------------------------------------------------------------------ [9] 清单 MIME 与 TS 单一来源对齐 */

test('[9] AndroidManifest：三组 intent-filter 的 MIME 从 SUPPORTED_EXTENSIONS 派生，且不接 */*', () => {
  const manifest = readFileSync(path.join(ROOT, 'android/app/src/main/AndroidManifest.xml'), 'utf8')
  const expected = [
    'text/plain',
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/octet-stream',
  ].sort()

  const filters = manifest.split('<intent-filter>').slice(0)
  const pick = (action) => {
    const block = filters.find(
      (item) => item.includes(`android:name="android.intent.action.${action}"`) && item.includes('</intent-filter>')
    )
    assert.ok(block, `清单里必须有 ${action} 的 intent-filter`)
    return block.slice(0, block.indexOf('</intent-filter>'))
  }

  for (const action of ['VIEW', 'SEND', 'SEND_MULTIPLE']) {
    const block = pick(action)
    const types = [...block.matchAll(/android:mimeType="([^"]+)"/g)].map((match) => match[1])
    assert.deepEqual(
      [...new Set(types)].sort(),
      expected,
      `${action} 的 MIME 必须正好是「支持格式的 MIME + octet-stream」`
    )
    assert.equal(types.includes('*/*'), false, `${action} 不许用 */* 一揽子接`)
    assert.equal(block.includes('BROWSABLE'), false, `${action} 不许带 BROWSABLE（会抢浏览器选择器）`)
    assert.ok(
      block.includes('android.intent.category.DEFAULT'),
      `${action} 必须带 CATEGORY_DEFAULT，否则系统不会把它当隐式 intent 的候选`
    )
  }

  const view = pick('VIEW')
  assert.ok(view.includes('android:scheme="content"'), 'VIEW 要声明 content://')
  assert.ok(view.includes('android:scheme="file"'), 'VIEW 要声明 file://')

  // 需求第 10 条：不申请全盘存储权限（清单里一条读存储权限都不许有）
  for (const permission of [
    'android.permission.READ_EXTERNAL_STORAGE',
    'android.permission.WRITE_EXTERNAL_STORAGE',
    'android.permission.MANAGE_EXTERNAL_STORAGE',
  ]) {
    assert.equal(manifest.includes(permission), false, `不许申请 ${permission}`)
  }
})

/* ------------------------------------------------------------------ [10] Java 上限与 TS 对齐 */

test('[10] ExternalFilePlugin 的体积上限字面量与 ATTACHMENT_LIMITS 一致', () => {
  const java = readFileSync(
    path.join(ROOT, 'android/app/src/main/java/com/example/deepseekchat/ExternalFilePlugin.java'),
    'utf8'
  )
  const literal = (field) => {
    const match = java.match(new RegExp(`${field}\\s*=\\s*(\\d+)L\\s*\\*\\s*1024\\s*\\*\\s*1024`))
    assert.ok(match, `Java 里找不到 ${field} 的「N * 1024 * 1024」写法`)
    return Number(match[1]) * MB
  }
  assert.equal(literal('TXT_MAX_BYTES'), limits.ATTACHMENT_LIMITS.txtMaxBytes)
  assert.equal(literal('DOCX_MAX_BYTES'), limits.ATTACHMENT_LIMITS.docxMaxBytes)
  assert.equal(literal('PDF_MAX_BYTES'), limits.ATTACHMENT_LIMITS.pdfMaxBytes)
})

/* ------------------------------------------------------------------ [11] 接线断言 */

test('[11] 接线：复用既有 addFiles、只在新建对话接货、没有第二套解析', () => {
  const chatInput = readFileSync(path.join(ROOT, 'src/components/chatInput/ChatInput.tsx'), 'utf8')
  assert.ok(
    chatInput.includes('useExternalImportInbox(sessionId, docDrafts.addFiles)'),
    '导入的文件必须交给既有的 useAttachmentDrafts().addFiles()'
  )
  assert.ok(chatInput.includes('useAttachmentDrafts('), '前提：输入区本来就挂着 useAttachmentDrafts')

  const hook = readFileSync(path.join(ROOT, 'src/components/chatInput/useExternalImport.ts'), 'utf8')
  assert.ok(hook.includes('sessionId !== null'), '只有「新建对话」那一版输入区接货')
  assert.ok(hook.includes('newChat()'), '导入成功后必须新建对话（不污染当前会话）')
  assert.ok(hook.includes('batch.files.length === 0'), '没有可导入的文件时不切会话、不入队')
  assert.equal(/sendMessage|uploadFile|uploadAttachment/.test(hook), false, '不许自动发送 / 上传')

  const service = readFileSync(path.join(ROOT, 'src/services/externalImport.ts'), 'utf8')
  assert.equal(
    /from '\.\/attachments\/parsers|parseDocxFile\(|parsePdfFile\(|parseTxtFile\(/.test(service),
    false,
    '外部导入不许自带 / 另调解析实现（解析只有 parsers/ 一套，由 manager 统一调度）'
  )

  const app = readFileSync(path.join(ROOT, 'src/app/App.tsx'), 'utf8')
  assert.ok(app.includes('useExternalImportBridge()'), '订阅挂在 App 级（与当前会话无关）')

  const matrix = readFileSync(path.join(ROOT, 'docs/capability-matrix.md'), 'utf8')
  assert.ok(matrix.includes('外部应用文件导入'), '能力矩阵必须登记「外部应用文件导入」一行')
})
