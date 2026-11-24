import { MOCK_ANNOUNCEMENTS, SEED_SEEN } from './mock.js'
import type {
  Announcement,
  AnnouncementList,
  AnnouncementSeenMap,
  AnnouncementWithReadState,
} from './types.js'

/**
 * 公告的**已读状态**存储与订阅（本轮不连后端，数据来自 `./mock.ts`）。
 *
 * 三件事，全在这个文件里，界面只读不算：
 *  1. 已读表落 `localStorage`（`chat-demo:announcements-seen`，值 `{ [id]: timestamp }`）；
 *  2. 排序（`publishedAt` 倒序）与 `unreadCount` 在这里算完，界面拿到的就是最终形状；
 *  3. 订阅用 `useSyncExternalStore` 那一套（`subscribe` + 取快照），与 `src/app/viewport.ts`
 *     的写法同形 —— 但这层**不 import React**，纯 Node 里可直接 import 做单测。
 *
 * 为什么不沿用 `zustand`（`settings.ts` / `toastState.ts` 那套）：这里的真实来源是 **localStorage**
 * 而不是内存 store，`useSyncExternalStore` 的「快照 + 订阅」正好对上 —— 已读表变了就把新快照推出去，
 * 界面不需要知道 localStorage 长什么样。快照是**同引用**的（没写就不换对象），否则
 * `useSyncExternalStore` 会在每次 render 都判成「变了」而反复重渲染。
 */

/** 已读表：`{ [announcementId]: 读到的那一刻（毫秒） }` */
export const SEEN_STORAGE_KEY = 'chat-demo:announcements-seen'

/** 「首次进入的公告弹窗已经弹过」的标记（有值即弹过，值本身不参与判断） */
export const POPUP_SHOWN_STORAGE_KEY = 'chat-demo:announcements-popup-shown'

/** 调试开关：URL 带这个参数时清掉上面两个标记（产品方反复看弹窗效果用） */
export const RESET_PARAM = 'ann-reset'

/**
 * localStorage 访问一律包一层：隐私模式 / 配额满 / 非浏览器环境（`node --test`）里
 * `localStorage` 可能不存在，甚至 getter 本身抛错。公告是可有可无的装饰，
 * 绝不能因为它把整页带崩 —— 存不下就退化成「只活在内存里」。
 */
const storage = (): Storage | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

const readRaw = (key: string): string | null => {
  const store = storage()
  if (store === null) {
    return null
  }
  try {
    return store.getItem(key)
  } catch {
    return null
  }
}

const writeRaw = (key: string, value: string): void => {
  const store = storage()
  if (store === null) {
    return
  }
  try {
    store.setItem(key, value)
  } catch {
    // 配额满 / 隐私模式：本次会话仍然按内存里的状态走，不抛错、不提示
  }
}

const removeRaw = (key: string): void => {
  const store = storage()
  if (store === null) {
    return
  }
  try {
    store.removeItem(key)
  } catch {
    // 同上：清不掉也只是下次仍显示已读，不影响功能
  }
}

/** 校验从 localStorage 读回来的东西：只认「普通对象 + 有限数值」，脏数据一律当空表 */
const normalizeSeen = (value: unknown): AnnouncementSeenMap | null => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null
  }
  const seen: AnnouncementSeenMap = {}
  for (const [id, at] of Object.entries(value)) {
    if (typeof at === 'number' && Number.isFinite(at)) {
      seen[id] = at
    }
  }
  return seen
}

const saveSeen = (seen: AnnouncementSeenMap): void => {
  writeRaw(SEEN_STORAGE_KEY, JSON.stringify(seen))
}

/**
 * 已读表的内存缓存。加载规则：localStorage 有 → 以它为准；没有 → 用 `SEED_SEEN` 演示基线**并且落盘**
 * （落盘很重要：不落的话每次刷新都重新种，用户点过的「一键已读」在刷新后就白点了）。
 */
let seenCache: AnnouncementSeenMap | null = null

const loadSeen = (): AnnouncementSeenMap => {
  if (seenCache !== null) {
    return seenCache
  }
  const raw = readRaw(SEEN_STORAGE_KEY)
  if (raw === null) {
    seenCache = { ...SEED_SEEN }
    saveSeen(seenCache)
    return seenCache
  }
  let parsed: unknown = null
  try {
    parsed = JSON.parse(raw)
  } catch {
    // 坏 JSON（手改过 / 旧版本格式）：当空表，但**不覆盖**它 —— 下次写入时才重写
    parsed = null
  }
  seenCache = normalizeSeen(parsed) ?? {}
  return seenCache
}

/** 纯函数：排序 + 标已读 + 数未读。抽出来是为了能在单测里直接喂数据，不碰 localStorage */
export const buildAnnouncementList = (
  items: readonly Announcement[],
  seen: AnnouncementSeenMap
): AnnouncementList => {
  const sorted = [...items].sort((left, right) => {
    const delta = Date.parse(right.publishedAt) - Date.parse(left.publishedAt)
    // 时间相同（或都解析不出来）时按 id 兜底，保证顺序稳定 —— 否则 React key 顺序会跳
    return delta !== 0 ? delta : left.id.localeCompare(right.id)
  })
  const rows: AnnouncementWithReadState[] = sorted.map((item) => ({
    ...item,
    read: Object.hasOwn(seen, item.id),
  }))
  return { items: rows, unreadCount: rows.filter((row) => !row.read).length }
}

/** 当前快照：**同一个引用**直到下一次写入，`useSyncExternalStore` 靠它判断「有没有变」 */
let snapshot: AnnouncementList = buildAnnouncementList(MOCK_ANNOUNCEMENTS, loadSeen())

const listeners = new Set<() => void>()

/** 重算快照并通知订阅者（所有写入口只走这一条，避免「改了没广播」） */
const publish = (): void => {
  snapshot = buildAnnouncementList(MOCK_ANNOUNCEMENTS, loadSeen())
  for (const listener of listeners) {
    listener()
  }
}

/**
 * 公告列表（带 `read` 标记），按 `publishedAt` 倒序，并附 `unreadCount`。
 * 返回值在两次写入之间是**同一个对象**，可以直接当 `useSyncExternalStore` 的 getSnapshot。
 */
export const listAnnouncements = (): AnnouncementList => snapshot

/** 订阅已读状态变化（`useSyncExternalStore` 的 subscribe），返回退订函数 */
export const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 把一条公告标记为已读（已读的再点一次是空操作，不写盘、不广播） */
export const markRead = (id: string): void => {
  const seen = loadSeen()
  if (Object.hasOwn(seen, id)) {
    return
  }
  seen[id] = Date.now()
  saveSeen(seen)
  publish()
}

/** 一键已读：全部未读标记为已读（没有未读时是空操作） */
export const markAllRead = (): void => {
  const seen = loadSeen()
  const now = Date.now()
  let changed = false
  for (const item of MOCK_ANNOUNCEMENTS) {
    if (!Object.hasOwn(seen, item.id)) {
      seen[item.id] = now
      changed = true
    }
  }
  if (!changed) {
    return
  }
  saveSeen(seen)
  publish()
}

/** 最新的一条**未读**公告（弹窗只弹它）；全读完了返回 `null` */
export const latestUnreadAnnouncement = (
  list: AnnouncementList = snapshot
): AnnouncementWithReadState | null => list.items.find((item) => !item.read) ?? null

/** 首次进入的公告弹窗弹过没有 */
export const hasShownPopup = (): boolean => readRaw(POPUP_SHOWN_STORAGE_KEY) !== null

/** 记「弹过了」（点「知道了」/ Esc / 点遮罩关掉都算看过一次，刷新后不再自动弹） */
export const markPopupShown = (): void => {
  writeRaw(POPUP_SHOWN_STORAGE_KEY, new Date().toISOString())
}

/**
 * 清掉「已读」与「已弹过」两个标记（调试用，见 `RESET_PARAM`）。
 *
 * 清完**回到 mock 的演示基线**（`SEED_SEEN`：1 条已读 / 3 条未读），而不是「4 条全未读」：
 * 产品方要看的是「有红点 + 有一条已读不长红点」的完整形态，全清反而看不出对比。
 * 弹窗标记是真清空 —— 所以带 `?ann-reset` 刷新一次就会重新弹最新那条。
 */
export const resetAnnouncementState = (): void => {
  removeRaw(SEEN_STORAGE_KEY)
  removeRaw(POPUP_SHOWN_STORAGE_KEY)
  seenCache = null
  publish()
}

/**
 * 调试开关的唯一入口：**只有** URL 里真的出现 `?ann-reset` 才动手，否则什么都不做。
 * 返回值只用于调用方写日志 / 调试，业务上不需要。
 */
export const applyResetFromLocation = (search: string): boolean => {
  if (!new URLSearchParams(search).has(RESET_PARAM)) {
    return false
  }
  resetAnnouncementState()
  return true
}
