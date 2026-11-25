import { Capacitor, CapacitorHttp } from '@capacitor/core'
import { fail } from './errors.js'
import { readSessionFile } from './schema.js'
import { toLocalSessionResult } from './toLocal.js'
import type { ChatMessage, FileEntry, Fragment } from './format.js'

const origin = 'https://chat.deepseek.com'

export function shareIdOf(input: string): string {
  const raw = input.trim()
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return fail('shareInvalid')
  }
  if (url.hostname !== 'chat.deepseek.com' || url.username || url.password)
    {
      return fail('shareUnofficial')
    }
  if (url.origin !== origin || !url.pathname.startsWith('/share/') || /[\\\s]/.test(raw))
    {
      return fail('shareInvalid')
    }
  // URL normalizes dot segments and missing slashes; validate the original share path too.
  const match =
    /^https:\/\/chat\.deepseek\.com(?::443)?\/share\/([A-Za-z0-9_-]{1,128})\/?(?:[?#].*)?$/i.exec(
      raw
    )
  return match?.[1] ?? fail('shareInvalid')
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return fail('shareUnreadable')
  }
  return value as Record<string, unknown>
}

// ---------------------------------------------------------------------------
// 分享内容 → 归档形状的归一化层（必须在 readSessionFile 之前跑）
//
// 为什么不能原样透传给 schema：`schema.ts` 校验的是**本机导出的归档**，口径是
// 「可空字段必须显式 null、时间必须是 `…Z` 的 ISO 字符串、file_entry 八个字段齐全」。
// 而官方分享接口给的是网站的形状：
//   1. 文件用 `message_id` 而不是 `id`；消息时间是 unix 秒；文件时间是 unix 秒；
//   2. `token_usage` / `export_path` / `width` / `height` **整个字段缺省**（不是 null）；
//   3. `export_path` 指向的是**对方设备**的会话目录。
// 只要 1 或 2 成立，整个 FILE 片段就被 schema 的 `fragment()` 吞成 null，紧接着
// 「片段数量必须一致」的比对就把**整段会话**判成 shareUnreadable —— 于是「带附件的官方
// 分享必定导入失败」，且与附件是不是图片无关。所以这里先把分享的形状映射成归档的形状。
// ---------------------------------------------------------------------------

/** 对象或 null：分享里出现怪东西时返回 null，由调用方决定丢弃，而不是抛错。 */
const row = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

/** 非负整数字段（schema 的 count 口径）：小数取整；缺失 / 非法返回 null。 */
const countOf = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null

/** id 类字段：分享偶尔给数字字符串，统一成整数。 */
const idOf = (value: unknown): number | null =>
  countOf(typeof value === 'string' && value.trim() ? Number(value) : value)

/**
 * 时间字段 → 归档要的 ISO 字符串：
 * - 数字 / 数字字符串按 **unix 秒**（≥1e11 视为毫秒，防对方改了精度）；
 * - 已经是 `…Z` 的 ISO 原样放过（保留微秒精度，schema 也接受）；
 * - 其它一律 null —— **由调用方决定丢弃哪个文件**，绝不因此判整段会话失败。
 */
const isoOf = (value: unknown): string | null => {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)) {
    return Number.isFinite(Date.parse(value)) ? value : null
  }
  const numeric = typeof value === 'string' ? Number(value) : value
  if (typeof numeric !== 'number' || !Number.isFinite(numeric)) {
    return null
  }
  const milliseconds = Math.abs(numeric) >= 1e11 ? numeric : numeric * 1000
  const date = new Date(milliseconds)
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}

/**
 * 分享 files[] 的一项 → 归档 FileEntry：缺省的可空字段补 null、file_size 缺省按 0。
 * 拿不到 `id` / `file_name` / 可用时间的文件返回 null —— 丢的是**这一个文件**，
 * 同片段里其它文件与整段文字都不受影响。
 */
const shareFile = (value: unknown): FileEntry | null => {
  const item = row(value)
  if (!item) {
    return null
  }
  const id =
    typeof item.id === 'string' && item.id
      ? item.id
      : typeof item.id === 'number' && Number.isFinite(item.id)
        ? String(item.id)
        : null
  const name = typeof item.file_name === 'string' && item.file_name ? item.file_name : null
  const insertedAt = isoOf(item.inserted_at)
  if (id === null || name === null || insertedAt === null) {
    return null
  }
  return {
    id,
    file_name: name,
    file_size: countOf(item.file_size) ?? 0,
    token_usage: countOf(item.token_usage),
    inserted_at: insertedAt,
    export_path: typeof item.export_path === 'string' ? item.export_path : null,
    is_image: item.is_image === true,
    width: countOf(item.width),
    height: countOf(item.height),
  }
}

/** schema 认识的片段类型；分享里出现别的（对方比本机新）只丢这一段。 */
const fragmentTypes = new Set([
  'REQUEST',
  'RESPONSE',
  'TEMPLATE_RESPONSE',
  'THINK',
  'TIP',
  'CONTENT_RISK',
  'PARTIAL_FILE_READ',
  'TOOL_SEARCH',
  'TOOL_OPEN',
  'TOOL_FIND',
  'READ_LINK',
  'FILE',
  'TOOL_IMAGE_SEARCH',
])

/**
 * 分享片段 → 归档片段。返回 null 表示「这段不要了」：未知类型、或 FILE 片段里的文件
 * **全部**映射失败（一个都不剩就没必要留个空壳）。
 */
const shareFragment = (value: unknown): Fragment | null => {
  const item = row(value)
  if (!item || typeof item.type !== 'string' || !fragmentTypes.has(item.type)) {
    return null
  }
  if (item.type === 'FILE') {
    const files = (Array.isArray(item.files) ? item.files : []).flatMap((entry) => {
      const file = shareFile(entry)
      return file === null ? [] : [file]
    })
    return files.length ? { type: 'FILE', files } : null
  }
  if (item.type === 'THINK') {
    // 思考耗时是唯一带默认值的字段（可空），坏值按 null 处理，别连累这段思考。
    return {
      ...item,
      type: 'THINK',
      elapsed_secs:
        typeof item.elapsed_secs === 'number' && Number.isFinite(item.elapsed_secs)
          ? item.elapsed_secs
          : null,
    } as Fragment
  }
  return item as Fragment
}

const roles = new Set<ChatMessage['role']>(['USER', 'ASSISTANT'])
const statuses = new Set<ChatMessage['status']>([
  'WIP',
  'FINISHED',
  'CONTENT_FILTER',
  'FAILED',
  'INCOMPLETE',
  'CONTEXT_LENGTH_EXCEEDED',
  'TIMEOUT',
])

/**
 * 分享消息 → 归档 ChatMessage。`timestamp` 是会话级兜底时间：
 * 单条消息时间不可解析时沿用它（宁可时间戳不准，也不能因此丢一整条消息的文字）。
 * 返回 null 只发生在「没有可用 message_id 或 role」—— 那时消息树无法重建，整段没法导入。
 */
const shareMessage = (value: unknown, timestamp: string): ChatMessage | null => {
  const item = row(value)
  if (!item) {
    return null
  }
  const id = idOf(item.message_id)
  const role = typeof item.role === 'string' ? item.role.toUpperCase() : ''
  if (id === null || !roles.has(role as ChatMessage['role'])) {
    return null
  }
  const status = typeof item.status === 'string' ? item.status.toUpperCase() : ''
  return {
    id,
    parent_id: idOf(item.parent_id),
    role: role as ChatMessage['role'],
    // 缺状态 / 陌生状态按「已完成」处理：分享出来的是已经说完的会话。
    status: statuses.has(status as ChatMessage['status'])
      ? (status as ChatMessage['status'])
      : 'FINISHED',
    thinking_enabled: item.thinking_enabled === true,
    search_enabled: item.search_enabled === true,
    accumulated_token_usage: countOf(item.accumulated_token_usage) ?? 0,
    inserted_at: isoOf(item.inserted_at) ?? timestamp,
    fragments: (Array.isArray(item.fragments) ? item.fragments : []).flatMap((entry) => {
      const fragment = shareFragment(entry)
      return fragment === null ? [] : [fragment]
    }),
  }
}

export function sessionFromShare(id: string, body: unknown) {
  const envelope = object(body)
  if (envelope.code !== 0) {
    return fail('shareFetchFailed')
  }
  const result = object(envelope.data)
  if (result.biz_code !== 0) {
    return fail(result.biz_msg === 'share does not exist' ? 'shareUnavailable' : 'shareFetchFailed')
  }
  const data = object(result.biz_data)
  if (!Array.isArray(data.messages) || !data.messages.length) {
    return fail('shareUnreadable')
  }
  try {
    // 会话级兜底时间：会话时间 → 首条可解析的消息时间 → 现在（只用于时间戳坏掉的消息）。
    const timestamp =
      isoOf(data.inserted_at) ??
      data.messages.map((value: unknown) => isoOf(row(value)?.inserted_at)).find((at) => at !== null) ??
      new Date().toISOString()
    const messages = data.messages.map((value: unknown) => shareMessage(value, timestamp) ?? fail('shareUnreadable'))
    const file = readSessionFile({
      id: 'deepseek-share-' + id,
      title: typeof data.title === 'string' ? data.title : null,
      messages,
      current_message_id: messages[messages.length - 1].id,
      inserted_at: messages[0].inserted_at,
      updated_at: new Date().toISOString(),
    })
    // 只比对**非 FILE** 片段：FILE 片段里的文件允许按条丢失（映射不出的那个文件没了，文字还在）。
    // 未知类型的片段已在归一化层丢掉，所以这里拦到的是「本该认识、内容却坏了」的片段 ——
    // 这种还是判失败，否则会出现「消息里一个字都没有」的静默空洞。
    const textFragments = (fragments: readonly { type: string }[]) =>
      fragments.filter((item) => item.type !== 'FILE').length
    if (
      file.messages.some(
        (m, i) => textFragments(m.fragments) !== textFragments(messages[i].fragments)
      )
    )
      {
        return fail('shareUnreadable')
      }
    // `skipped` 是**降级**语义（#49），不是致命：分享的附件路径属于对方设备，本机合成 id
    // 必然对不上，只能「该会话的附件未迁移」。只有 local.ok === false 才判整段失败。
    const local = toLocalSessionResult(file, { degradeFiles: true })
    if (!local.ok) {
      return fail('shareUnreadable')
    }
    return local.session.session
  } catch {
    return fail('shareUnreadable')
  }
}

export async function readDeepSeekShare(input: string) {
  const id = shareIdOf(input)
  let status: number
  let body: unknown
  try {
    // 只有原生端会走到这里（网页端入口已隐藏）：CapacitorHttp 走系统网络栈，不受 CORS 限制。
    // 曾经为网页端留过一条 `/api/deepseek-share/<id>` 同源转发分支，但它要求线上多跑一个
    // 中转进程 —— 产品决定不为一个低频功能加运维，网页端直接不提供入口，分支随之删除。
    if (!Capacitor.isNativePlatform()) {
      return fail('shareUnavailable')
    }
    const response = await CapacitorHttp.get({
      url: origin + '/api/v0/share/content?share_id=' + id,
      headers: { Accept: 'application/json' },
      responseType: 'json',
      connectTimeout: 10000,
      readTimeout: 20000,
      disableRedirects: true,
    })
    status = response.status
    body = response.data
  } catch {
    return fail('shareFetchFailed')
  }
  if (status === 410 || (Capacitor.isNativePlatform() && status === 404))
    {
      return fail('shareUnavailable')
    }
  if (status !== 200) {
    return fail('shareFetchFailed')
  }
  return sessionFromShare(id, body)
}
