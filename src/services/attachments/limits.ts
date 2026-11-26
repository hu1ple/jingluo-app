/**
 * #480 文档附件的**域视图**（parsers / manager / UI 的入口名）。
 *
 * ## 这里不是第二份真相源（#562 的硬约束）
 *
 * 数字只有一处：`src/services/limits.ts` 的 `LIMITS`（#275 定的唯一阈值表，`pnpm check:limits`
 * 会扫；本文件已登记进 `scripts/check-limits.mjs` 的 WATCHED 清单，**里面出现任何 4 位以上
 * 数字就算红**）。本文件只做三件事：把 `LIMITS.attachments.doc` 逐字段转出成附件域惯用的
 * 名字、声明受支持的扩展名、给出扩展名的联合类型。
 *
 * 为什么保留这一层而不是让 40 个调用点都写 `LIMITS.attachments.doc.xxx`：
 * 1. 附件域内部的称呼是 `ATTACHMENT_LIMITS.pdfMaxBytes`，比四段点号短，且与「上传」那组
 *    （`LIMITS.attachments.maxSizeMb`，Files API 口径）在阅读上分得开 —— 两者口径不同，
 *    混成一层名字反而更容易拿错（拿 64MB 的上传上限去卡 20MB 的 DOCX 解析）；
 * 2. 逐字段写死（而不是 `= LIMITS.attachments.doc`）是有意的：`limits-config.test.mjs`
 *    有一条「每个 LIMITS 叶子都必须被生产代码以 `LIMITS.xxx` 形式引用」的断言，
 *    整体转出会让这 10 个叶子在源码里"看不见"，那条断言就失效了。
 *
 * 取值一个都没改（#562：只搬位置）。改阈值只手改 `LIMITS.attachments.doc` 与
 * `tests/unit/limits-config.test.mjs` 的 `ORIGINAL_VALUES`，本文件不动。
 */
import { LIMITS } from '../limits.js'

/** #480 文档附件的解析 / 注入限制（唯一来源：`LIMITS.attachments.doc`） */
export const ATTACHMENT_LIMITS = {
  txtMaxBytes: LIMITS.attachments.doc.txtMaxBytes,
  docxMaxBytes: LIMITS.attachments.doc.docxMaxBytes,
  pdfMaxBytes: LIMITS.attachments.doc.pdfMaxBytes,
  maxExtractedChars: LIMITS.attachments.doc.maxExtractedChars,
  docBudgetTokens: LIMITS.attachments.doc.docBudgetTokens,
  minInjectableChars: LIMITS.attachments.doc.minInjectableChars,
  maxFilesPerMessage: LIMITS.attachments.doc.maxFilesPerMessage,
  maxZipEntries: LIMITS.attachments.doc.maxZipEntries,
  maxZipUncompressedBytes: LIMITS.attachments.doc.maxZipUncompressedBytes,
  pdfMinCharsPerPage: LIMITS.attachments.doc.pdfMinCharsPerPage,
  /** #571 关闭条件「支持页数上限」；超限抛 `tooManyPages`，不许截断前 N 页当成功 */
  pdfMaxPages: LIMITS.attachments.doc.pdfMaxPages,
  /** #571 关闭条件「支持超时」；按页抢跑（pdfjs 单页不可中断），超时走 partial，见 parsers/pdf.ts */
  pdfTimeoutMs: LIMITS.attachments.doc.pdfTimeoutMs,
} as const

export const SUPPORTED_EXTENSIONS = ['.txt', '.docx', '.pdf'] as const
export type SupportedExtension = (typeof SUPPORTED_EXTENSIONS)[number]

/**
 * 扩展名 → 允许的 MIME（**唯一来源**）。
 *
 * 谁在读它：
 *  - `manager.ts` 的 `resolveExtension()` —— 入库时的「扩展名 + MIME 双判」；
 *  - `externalImport.ts` —— 外部应用（WPS / 微信 / QQ）分享进来的文件按同一张表归一 MIME；
 *  - `android/app/src/main/AndroidManifest.xml` 的三组 intent-filter（手工展开成字面量，
 *    `tests/unit/external-import.test.mjs` 断言那边与这张表一致）。
 *
 * 类型是 `Record<SupportedExtension, …>`：往 `SUPPORTED_EXTENSIONS` 加一种格式而忘了在这里补
 * MIME，**编译期**就会红，不用等到用户传上来才发现。
 */
export const MIME_BY_EXTENSION: Record<SupportedExtension, readonly string[]> = {
  '.txt': ['text/plain'],
  '.docx': ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  '.pdf': ['application/pdf'],
}

/**
 * 「系统没给 MIME」的两种取值：空串（部分 Android 文件提供器）与 `application/octet-stream`
 * （下载目录、第三方网盘、WPS / 微信分享）。这两种只当作「未提供」，判定交给扩展名；
 * 其余不匹配的 MIME 一律拒绝 —— 把 .exe 改名成 .pdf 会被挡下，且报错说清是 MIME 不符。
 */
export const UNKNOWN_MIME_TYPES: ReadonlySet<string> = new Set(['', 'application/octet-stream'])

/** 扩展名（小写，带点）；没有扩展名时为空串 */
export const extensionOf = (filename: string): string => {
  const dot = filename.lastIndexOf('.')
  return dot > 0 ? filename.slice(dot).toLowerCase() : ''
}

const isSupportedExtension = (extension: string): extension is SupportedExtension =>
  (SUPPORTED_EXTENSIONS as readonly string[]).indexOf(extension) >= 0

/** 供外部按扩展名判支持的同一支判据（不要再各写一份 `includes()`） */
export const supportsExtension = isSupportedExtension

/**
 * 各扩展名的单文件上限（字节）。**逐字段**从 `ATTACHMENT_LIMITS` 取出而不是转发整个对象：
 * `limits-config.test.mjs` 要求每个 `LIMITS` 叶子在生产代码里被显式引用（见文件头）。
 */
export const SIZE_LIMIT_BYTES: Record<SupportedExtension, number> = {
  '.txt': ATTACHMENT_LIMITS.txtMaxBytes,
  '.docx': ATTACHMENT_LIMITS.docxMaxBytes,
  '.pdf': ATTACHMENT_LIMITS.pdfMaxBytes,
}

/** 某个文件名的单文件上限；不支持的扩展名返回 `undefined`（调用方据扩展名先拒） */
export const sizeLimitOf = (filename: string): number | undefined => {
  const extension = extensionOf(filename)
  return isSupportedExtension(extension) ? SIZE_LIMIT_BYTES[extension] : undefined
}

