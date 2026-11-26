/**
 * 外部应用文件导入（Android：`ACTION_VIEW` / `ACTION_SEND` / `ACTION_SEND_MULTIPLE`）。
 *
 * ## 一句话
 *
 * WPS / 微信 / QQ / 系统文件管理器把文件「打开方式 / 分享」给鲸落时，原生侧
 * （`ExternalFilePlugin`）把文件读成 App 私有 cache 里的一份副本，本模块把副本读成 `File`，
 * 然后**交给既有的附件链路**（`useAttachmentDrafts().addFiles()` → `attachmentManager.addFile()`）。
 * 这里**不做任何解析**：TXT / DOCX / PDF 的解析器只有一套，在 `services/attachments/parsers/`。
 *
 * ## 三条边界（都是硬约束）
 *
 * 1. **Web 端零行为变化**：`getPlatform() !== 'android'` 时 `subscribeExternalImport()` 直接返回
 *    一个空退订函数 —— 不订阅、不注册监听、不抛错、不渲染任何入口。Web 端根本没有「外部应用
 *    分享进来」这个场景，装一个入口只会让用户点了没反应。
 * 2. **不发送、不上传**：本模块只产出 `File`，进草稿即止（解析在本地做，`addFile()` 只写
 *    IndexedDB）。发不发送由用户在输入区自己决定。
 * 3. **拒绝要明说**：类型不支持 / 超限 / 没权限 / 读失败 / 空文件一律进 `rejected`，由调用方
 *    逐条提示（文案 key 见 `externalImportRejectMessage()`）。**不静默过滤**。
 *
 * ## 数据形状
 *
 * 原生 → JS（`consumePending()` 的返回值与 `filesReceived` 事件的 payload 同形）：
 *
 * ```json
 * { "files": [{ "id": "…", "name": "报告.pdf", "mimeType": "application/pdf",
 *               "size": 1234, "srcPath": "/data/user/0/<pkg>/cache/external-import/<id>-报告.pdf" }],
 *   "rejected": [{ "name": "a.exe", "reason": "unsupported", "size": 42 }] }
 * ```
 *
 * 为什么用 `srcPath` + `fetch(convertFileSrc(...))` 而不是 base64：20MB 的 DOCX 走 base64 要
 * 过桥 27MB 字符串，WebView 直接 OOM；`fetch` 是一次本地 HTTP 请求（Capacitor 的
 * `/_capacitor_file_` 协议），拿到的是 Blob，内存里只有一份。
 *
 * ## 去重与临时文件
 *
 * - **去重**：签名 = `id + srcPath + size`（原生侧已经按 `uri + size + lastModified` 挡过一层），
 *   10 分钟 TTL。事件与 `consumePending()` 两条路都可能送同一批过来（谁先到谁取走），
 *   这一层保证**只导入一次**。
 * - **临时文件**：导入（或被拒/被跳过）之后立刻 `clearTemp(ids)` 删掉原生副本；原生侧另有
 *   冷启动 24h 清扫兜底。
 */
import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'
import {
  MIME_BY_EXTENSION,
  SIZE_LIMIT_BYTES,
  UNKNOWN_MIME_TYPES,
  extensionOf,
  sizeLimitOf,
  supportsExtension,
  type SupportedExtension,
} from './attachments/limits.js'
import { recordEvent } from './diagnostics/collector.js'

/** 原生事件名（与 `ExternalFilePlugin` 的 `notifyListeners` 一致） */
export const EXTERNAL_IMPORT_EVENT = 'filesReceived'

/** 原生桥（形状与 `ExternalFilePlugin` 逐字对应） */
export type ExternalFileBridge = {
  /** 取走「还没送出去的批次」；冷启动时先调它一次，进程内不会重复给 */
  consumePending(): Promise<RawBatch | null | undefined>
  /** 删掉原生副本；删不到不报错 */
  clearTemp(options: { ids: string[] }): Promise<void>
  addListener(
    name: typeof EXTERNAL_IMPORT_EVENT,
    listener: (batch: RawBatch) => void
  ): Promise<PluginListenerHandle>
}

export type RawFile = {
  id: string
  name: string
  mimeType?: string
  size?: number
  srcPath: string
}

/** 原生侧的拒绝码（`ExternalFilePlugin` 的 `rejected[].reason`） */
export type RawRejectReason = 'unsupported' | 'tooLarge' | 'noPermission' | 'readFailed'

export type RawRejected = { name: string; reason?: string; size?: number }

export type RawBatch = { files?: RawFile[]; rejected?: RawRejected[] }

/**
 * 统一的拒绝码（原生码 + JS 侧自己判出来的两种）。
 *
 * `empty` 只在 JS 侧出现：原生不做「空文件」判定（它只关心能不能读、超不超限），
 * 而空文件进了 `addFiles()` 也会被拒 —— 在这里判掉，用户看到的提示更准。
 */
export type ExternalImportReason = RawRejectReason | 'empty'

/** 拒绝项。`size` / `limitBytes` 只在知道的时候给（原生拒绝超限时会带上 size） */
export type ExternalImportRejected = {
  name: string
  reason: ExternalImportReason
  size?: number
  limitBytes?: number
}

/** 一次导入（或一次「只被拒」的分享）的结果 */
export type ExternalImportBatch = {
  /** 可以直接交给 `useAttachmentDrafts().addFiles()` 的文件 */
  files: File[]
  /** 没进来的，逐条带原因；调用方按 `externalImportRejectMessage()` 出文案 */
  rejected: ExternalImportRejected[]
  /** 因为「同一次分享已经收过」而跳过的条数（不提示、不入草稿） */
  duplicates: number
}

export type ExternalImportHandler = (batch: ExternalImportBatch) => void

export const nativeExternalFile = registerPlugin<ExternalFileBridge>('ExternalFile')

/** 能力探测：只有 Android 原生壳里有这条通路；Web / iOS 一律当作不支持 */
export const isExternalImportSupported = (): boolean => Capacitor.getPlatform() === 'android'

/**
 * 把原生的 MIME + 文件名归一成「支持哪种格式」。
 *
 * 与 `manager.ts` 的 `resolveExtension()` 同一口径（MIME 只信一半）：
 * - `text/plain` / `application/pdf` / docx 的 MIME → 必须与扩展名逐字相符；
 * - 空串 / `application/octet-stream`（WPS、微信、QQ、下载目录的常见取值）→ 视为「没给」，
 *   判定**交给扩展名**；
 * - 扩展名不在 `SUPPORTED_EXTENSIONS` → `null`（调用方落 `unsupported`）。
 *
 * 这就是「`octet-stream` 按扩展名二次校验」的落点：一个改名成 `.pdf` 的 exe 在这里被挡下。
 */
export const resolveImportExtension = (
  name: string,
  mimeType?: string
): SupportedExtension | null => {
  const extension = extensionOf(name)
  if (!supportsExtension(extension)) {
    return null
  }
  const mime = (mimeType ?? '').trim().toLowerCase().split(';')[0] ?? ''
  if (UNKNOWN_MIME_TYPES.has(mime)) {
    return extension
  }
  return MIME_BY_EXTENSION[extension].includes(mime) ? extension : null
}

/** 去重窗口：原生侧也是 10 分钟，两边同一个量级 */
const SEEN_TTL_MS = 10 * 60 * 1000
/** 进程内去重表（订阅/退订之间不清空：切会话重挂载不该让同一批文件再来一次） */
const SEEN = new Map<string, number>()

const pruneSeen = (now: number): void => {
  for (const [signature, stamp] of SEEN) {
    if (now - stamp > SEEN_TTL_MS) {
      SEEN.delete(signature)
    }
  }
}

const seenRecently = (signature: string, now: number): boolean => {
  const stamp = SEEN.get(signature)
  return stamp !== undefined && now - stamp <= SEEN_TTL_MS
}

/** 只给单测用：把进程内去重表清空，避免用例之间互相污染 */
export const resetExternalImportState = (): void => {
  SEEN.clear()
  inbox.length = 0
  sink = null
}

const signatureOf = (item: RawFile): string =>
  `${item.id}|${item.srcPath}|${item.size === undefined ? -1 : item.size}`

/** 默认的 blob 读取：Capacitor 的本地文件协议，一次请求拿一个 Blob（不走 base64） */
const fetchBlobOf = async (srcPath: string): Promise<Blob> => {
  const response = await fetch(Capacitor.convertFileSrc(srcPath))
  if (!response.ok) {
    throw new Error(`EXTERNAL_IMPORT_FETCH_${response.status}`)
  }
  return await response.blob()
}

const normalizeRejectReason = (reason: string | undefined): ExternalImportReason => {
  if (
    reason === 'unsupported' ||
    reason === 'tooLarge' ||
    reason === 'noPermission' ||
    reason === 'readFailed'
  ) {
    return reason
  }
  // 未知码按「读失败」处理：至少让用户知道这个文件没进来，而不是静默消失
  return 'readFailed'
}

/** 一次导入的可注入依赖（单测用；生产一律用默认值） */
export type ExternalImportDeps = {
  bridge?: ExternalFileBridge
  /** 读副本字节；默认走 `fetch(convertFileSrc(srcPath))` */
  readBlob?: (srcPath: string) => Promise<Blob>
  now?: () => number
}

/**
 * 把一批原生条目变成 `File[]` + `rejected`。
 *
 * 顺序固定：**去重 → 扩展名 / MIME 二次校验 → 体积 → 空文件 → 读字节**。
 * 前四步都不碰磁盘以外的资源，读字节放最后，被拒的文件一个字节都不读。
 */
const convertBatch = async (
  raw: RawBatch | null | undefined,
  deps: Required<Pick<ExternalImportDeps, 'readBlob' | 'now'>>
): Promise<{ batch: ExternalImportBatch; clearIds: string[] }> => {
  const files: File[] = []
  const rejected: ExternalImportRejected[] = []
  const clearIds: string[] = []
  let duplicates = 0

  for (const item of raw?.rejected ?? []) {
    rejected.push({
      name: item.name ?? '',
      reason: normalizeRejectReason(item.reason),
      ...(typeof item.size === 'number' ? { size: item.size } : {}),
      ...(sizeLimitOf(item.name ?? '') === undefined ? {} : { limitBytes: sizeLimitOf(item.name ?? '') }),
    })
    // 原生已经落过副本的可能没有（被拒的不复制）—— 有 id 才清
    const id = (item as { id?: string }).id
    if (typeof id === 'string' && id !== '') {
      clearIds.push(id)
    }
  }

  for (const item of raw?.files ?? []) {
    const now = deps.now()
    pruneSeen(now)
    const signature = signatureOf(item)
    if (seenRecently(signature, now)) {
      // 同一次分享的第二份投递（事件 + consumePending，或重复 intent）：跳过，不提示也不入草稿
      duplicates += 1
      clearIds.push(item.id)
      continue
    }
    SEEN.set(signature, now)

    const extension = resolveImportExtension(item.name, item.mimeType)
    if (extension === null) {
      rejected.push({ name: item.name, reason: 'unsupported' })
      clearIds.push(item.id)
      continue
    }
    if (typeof item.size === 'number' && item.size === 0) {
      rejected.push({ name: item.name, reason: 'empty' })
      clearIds.push(item.id)
      continue
    }
    if (typeof item.size === 'number' && item.size > SIZE_LIMIT_BYTES[extension]) {
      rejected.push({
        name: item.name,
        reason: 'tooLarge',
        size: item.size,
        limitBytes: SIZE_LIMIT_BYTES[extension],
      })
      clearIds.push(item.id)
      continue
    }

    try {
      const blob = await deps.readBlob(item.srcPath)
      files.push(
        new File([blob], item.name, {
          // MIME 用规范值：`octet-stream` 交给 manager 会被当成「没给」，而这里已经判准了
          type: MIME_BY_EXTENSION[extension][0],
          lastModified: now,
        })
      )
      clearIds.push(item.id)
    } catch {
      rejected.push({ name: item.name, reason: 'readFailed' })
      clearIds.push(item.id)
    }
  }

  return { batch: { files, rejected, duplicates }, clearIds }
}

/**
 * 订阅外部导入。
 *
 * 顺序（冷启动 / 热启动都要对）：
 * 1. `consumePending()` —— 桥就绪前收到的 intent 在原生队列里，先取一次（冷启动走这条）；
 * 2. `addListener('filesReceived')` —— 之后每次分享由原生推过来（热启动 / 后台走这条）。
 *
 * 非 Android、或桥不可用 / 调用抛错 → 返回空退订函数并**记一条诊断**，不打断任何调用方
 * （Web 端 `getPlatform()` 是 `web`，在第一行就返回了，连桥都不会碰）。
 */
export const subscribeExternalImport = async (
  handler: ExternalImportHandler,
  deps: ExternalImportDeps = {}
): Promise<() => void> => {
  const platform = Capacitor.getPlatform()
  if (platform !== 'android') {
    return () => {}
  }
  const bridge = deps.bridge ?? nativeExternalFile
  const readBlob = deps.readBlob ?? fetchBlobOf
  const now = deps.now ?? Date.now

  let disposed = false
  let listener: PluginListenerHandle | undefined

  const deliver = async (raw: RawBatch | null | undefined): Promise<void> => {
    if (disposed) {
      return
    }
    let converted: { batch: ExternalImportBatch; clearIds: string[] }
    try {
      converted = await convertBatch(raw, { readBlob, now })
    } catch {
      recordEvent('warning', 'external_import_convert_failed', {
        'external.platform': platform,
        'external.stage': 'convert',
      })
      return
    }
    if (disposed) {
      return
    }
    const { batch, clearIds } = converted
    if (batch.files.length > 0 || batch.rejected.length > 0) {
      handler(batch)
    }
    if (clearIds.length > 0) {
      // 副本已经读成 Blob 了，删原生文件不会影响后续解析
      await bridge.clearTemp({ ids: clearIds }).catch(() => {
        // 删不掉不是用户问题：原生侧还有 24h 清扫
      })
    }
  }

  try {
    await deliver(await bridge.consumePending())
    listener = await bridge.addListener(EXTERNAL_IMPORT_EVENT, (batch) => {
      void deliver(batch)
    })
    // 补一次：首次 drain 与「监听真正挂上」之间还有一个很窄的窗口，
    // 这一小段里收到的 intent 原生会留在队列里（没有监听器就不推）。
    await deliver(await bridge.consumePending())
  } catch {
    recordEvent('warning', 'external_import_unavailable', {
      'external.platform': platform,
      'external.stage': 'subscribe',
    })
    await listener?.remove().catch(() => {})
    return () => {}
  }

  return () => {
    disposed = true
    void listener?.remove().catch(() => {})
  }
}

/* ------------------------------------------------------------------ 收件箱（「新建对话」的接货口）
 *
 * 为什么要有这一层：导入成功要**自动进入新建对话页并展示附件**（需求第 6 条），
 * 而附件只能由挂载着的输入区（`useAttachmentDrafts().addFiles()`）接。两件事的时机不一定对齐：
 * 用户在别的会话里时，得先切到「新对话」（新输入区要等一次渲染才挂载），文件不能就地塞进
 * 当前会话的草稿里。所以：先入队，新输入区挂上来时再取走。
 */

let sink: ((files: File[]) => void) | null = null
const inbox: File[] = []

const drainInbox = (): void => {
  if (sink === null || inbox.length === 0) {
    return
  }
  const files = inbox.splice(0, inbox.length)
  sink(files)
}

/** 把导入成功的文件交给「新建对话」的输入区（没有接货口就先排队） */
export const enqueueExternalImport = (files: File[]): void => {
  if (files.length === 0) {
    return
  }
  inbox.push(...files)
  drainInbox()
}

/**
 * 注册接货口（只在「新建对话」那一版输入区里注册，见 `ChatInput`）。
 * 返回退订函数：输入区卸载后不再往它身上塞文件。
 */
export const takeExternalImport = (handler: (files: File[]) => void): (() => void) => {
  sink = handler
  drainInbox()
  return () => {
    if (sink === handler) {
      sink = null
    }
  }
}
