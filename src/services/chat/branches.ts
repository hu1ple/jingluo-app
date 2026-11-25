import type { AssistantMessage, FileAttachment, Message, Session } from './types.js'

/**
 * 一条被修好的损坏数据。**只记类型与条数，不记任何正文**，用于调用方写一条诊断日志
 * （诊断采集层在 store 侧，本文件保持零运行时依赖，才能被 unit 测试直接 import）。
 */
export type SessionDamage = {
  /** messages（会话消息列表）/ files（消息附件）/ blocks（回答内容块） */
  field: 'messages' | 'files' | 'blocks'
  /** reset = 置空数组；drop = 丢掉这一条（整条消息或数组里认不出的元素） */
  action: 'reset' | 'drop'
  /** 出问题的消息 id（消息级问题才有） */
  messageId?: string
  /** 原来的值类型（null / object / string / undefined…） */
  received: string
  /** 丢掉的元素个数（action=drop 时才有） */
  dropped?: number
}

/** 损坏数据的上报口；调用方（store）用它记一条 error 级诊断 */
export type SessionDamageReporter = (damage: SessionDamage[]) => void

const typeOfValue = (value: unknown): string =>
  value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value

/** 认得出是一条消息吗：对象、非空、id 是字符串。认不出的整条丢掉（留着一定在渲染或请求时炸） */
const isUsableMessage = (value: unknown): value is Message =>
  typeof value === 'object' && value !== null && typeof (value as { id?: unknown }).id === 'string'

/** 附件至少要有个 string id，否则 MessageFile 拿它当列表 key 会出现重复 key / undefined */
const isUsableFile = (value: unknown): value is FileAttachment =>
  typeof value === 'object' && value !== null && typeof (value as { id?: unknown }).id === 'string'

/** 单条消息的字段兜底：数组字段不是数组就置空，数组里认不出的元素丢掉 */
const repairMessage = (message: Message, damage: SessionDamage[]): Message => {
  if (message.role === 'user') {
    const files: unknown = message.files
    if (!Array.isArray(files)) {
      damage.push({
        field: 'files',
        action: 'reset',
        messageId: message.id,
        received: typeOfValue(files),
      })
      return { ...message, files: [] }
    }
    const usable = files.filter(isUsableFile)
    if (usable.length !== files.length) {
      damage.push({
        field: 'files',
        action: 'drop',
        messageId: message.id,
        received: 'array',
        dropped: files.length - usable.length,
      })
      return { ...message, files: usable }
    }
    return message
  }
  if (message.role === 'assistant') {
    const blocks: unknown = message.blocks
    if (!Array.isArray(blocks)) {
      damage.push({
        field: 'blocks',
        action: 'reset',
        messageId: message.id,
        received: typeOfValue(blocks),
      })
      return { ...message, blocks: [] }
    }
    const usable = blocks.filter((block) => typeof block === 'object' && block !== null)
    if (usable.length !== blocks.length) {
      damage.push({
        field: 'blocks',
        action: 'drop',
        messageId: message.id,
        received: 'array',
        dropped: blocks.length - usable.length,
      })
      return { ...message, blocks: usable as AssistantMessage['blocks'] }
    }
  }
  return message
}

/**
 * 数据健壮性（issue #28）：存储被写坏时（导入中断 / 半写入 / 外部改库），
 * `messages` / `files` / `blocks` 可能是 null。`null.length`、`null.map` 会抛 TypeError，
 * 在渲染期就是整屏白屏。这里「能修就修（置空 / 丢弃坏元素），修不了就跳过该条」，
 * 并把修过什么上报给调用方记诊断。
 */
const repairMessages = (session: Session, damage: SessionDamage[]): Message[] => {
  const source: unknown = session.messages
  if (!Array.isArray(source)) {
    damage.push({ field: 'messages', action: 'reset', received: typeOfValue(source) })
    return []
  }
  const messages: Message[] = []
  let changed = false
  for (const item of source) {
    if (!isUsableMessage(item)) {
      damage.push({ field: 'messages', action: 'drop', received: typeOfValue(item), dropped: 1 })
      changed = true
      continue
    }
    const repaired = repairMessage(item, damage)
    changed = changed || repaired !== item
    messages.push(repaired)
  }
  // 一处都没修就还回原数组，保持对象引用不变（store 靠它判断要不要回写）
  return changed ? messages : source
}

/**
 * 将线性消息列表规范化为单分支，保留消息 ID、内容及时间。
 *
 * `onDamage` 可选：修过损坏字段时回调一次（store 用它记 `stage=session.normalize` 的诊断）。
 * 没有任何损坏时保持原对象引用不变 —— store 靠 `session !== stored` 判断是否需要回写修复后的数据。
 */
export const normalizeSession = (session: Session, onDamage?: SessionDamageReporter): Session => {
  const damage: SessionDamage[] = []
  const messages = repairMessages(session, damage)
  const repaired: Session =
    session.rootMessageId !== undefined
      ? messages === session.messages
        ? session
        : { ...session, messages }
      : {
          ...session,
          rootMessageId: messages[0]?.id ?? null,
          messages: messages.map((message, index, list) => ({
            ...message,
            parentId: list[index - 1]?.id ?? null,
            selectedChildId: list[index + 1]?.id,
          })),
        }
  if (damage.length > 0) {
    onDamage?.(damage)
  }
  if (typeof repaired.userIdentity === 'string') {
    const { userIdentity, ...rest } = repaired
    const prompt = typeof rest.customSystemPrompt === 'string' ? rest.customSystemPrompt : ''
    return { ...rest, customSystemPrompt: [prompt, userIdentity && '用户身份：' + userIdentity].filter(Boolean).join('\n\n') }
  }
  return repaired
}

/** 展示内容与请求上下文共用当前选中的分支路径。 */
export const getVisibleMessages = (session: Session): Message[] => {
  if (session.rootMessageId === undefined) {
    return session.messages
  }
  const byId = new Map(session.messages.map((message) => [message.id, message]))
  const path: Message[] = []
  let id = session.rootMessageId
  while (id) {
    const message = byId.get(id)
    if (!message) {
      break
    }
    path.push(message)
    byId.delete(id)
    id = message.selectedChildId ?? null
  }
  return path
}

export type MessageVersions = { ids: string[]; index: number }

/** 一次遍历收集兄弟版本；版本列表未变化时复用旧对象与索引，避免流式正文更新重绘历史消息。 */
export const buildMessageVersions = (
  session: Session,
  previous: ReadonlyMap<string, MessageVersions>
): ReadonlyMap<string, MessageVersions> => {
  const groups = new Map<string | null | undefined, string[]>()
  for (const message of session.messages) {
    const key = session.rootMessageId === undefined ? message.id : message.parentId
    const ids = groups.get(key)
    if (ids) {
      ids.push(message.id)
    } else {
      groups.set(key, [message.id])
    }
  }

  const versions = new Map<string, MessageVersions>()
  let unchanged = previous.size === session.messages.length
  for (const ids of groups.values()) {
    const cachedIds = previous.get(ids[0])?.ids
    const stableIds =
      cachedIds?.length === ids.length && ids.every((id, index) => id === cachedIds[index])
        ? cachedIds
        : ids
    ids.forEach((id, index) => {
      const cached = previous.get(id)
      const version =
        cached?.ids === stableIds && cached.index === index ? cached : { ids: stableIds, index }
      versions.set(id, version)
      if (version !== cached) {
        unchanged = false
      }
    })
  }
  return unchanged ? previous : versions
}

/** 新消息挂在指定父节点下，并选择新分支；原节点与其后续对话保持不变。 */
export const appendBranch = (
  original: Session,
  parentId: string | null,
  messages: Message[]
): Session => {
  const session = normalizeSession(original)
  const first = messages[0]
  if (!first) {
    return session
  }
  return {
    ...session,
    rootMessageId: parentId === null ? first.id : session.rootMessageId,
    messages: [
      ...session.messages.map((message) =>
        message.id === parentId ? { ...message, selectedChildId: first.id } : message
      ),
      ...messages.map((message, index) => ({
        ...message,
        parentId: messages[index - 1]?.id ?? parentId,
        selectedChildId: messages[index + 1]?.id,
      })),
    ],
  }
}

/** 仅允许切换当前路径上某一节点的兄弟版本，恢复该版本已选中的后续分支。 */
export const selectVersion = (original: Session, messageId: string): Session => {
  const session = normalizeSession(original)
  const message = session.messages.find((item) => item.id === messageId)
  if (!message || !getVisibleMessages(session).some((item) => item.parentId === message.parentId)) {
    return original
  }
  return {
    ...session,
    rootMessageId: message.parentId === null ? message.id : session.rootMessageId,
    messages: session.messages.map((item) =>
      item.id === message.parentId ? { ...item, selectedChildId: message.id } : item
    ),
  }
}
