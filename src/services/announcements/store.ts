import { testSeamEnabled } from '../../utils/testSeam.js'
import { MOCK_ANNOUNCEMENTS, SEED_SEEN } from './mock.js'
import { parseReadGate, withFinished } from './readGate.js'
import { fetchAnnouncements, parseAnnouncementItem } from './remote.js'
import type { ReadGateMap } from './readGate.js'
import type {
  Announcement,
  AnnouncementList,
  AnnouncementSeenMap,
  AnnouncementWithReadState,
} from './types.js'

/**
 * 公告的**列表来源 + 已读状态**存储与订阅。
 *
 * 数据链路（自下而上）：
 *  `remote.ts`（静态站的 `announcements.json`，主备回退、宽松解析、失败返回 `null`）
 *    → 本文件的**列表缓存**（`localStorage`，冷启动先渲染它）
 *    → 排序 + 已读 + 未读数（`buildAnnouncementList`）
 *    → `useAnnouncements()`（`useSyncExternalStore`）。
 *
 * 四件事，全在这个文件里，界面只读不算：
 *  1. 已读表落 `localStorage`（`chat-demo:announcements-seen`，值 `{ [id]: timestamp }`）；
 *  2. 排序（`publishedAt` 倒序）与 `unreadCount` 在这里算完，界面拿到的就是最终形状；
 *  3. **读出门禁**（`chat-demo:announcements-read-gate`，值 `{ [id]: finishedAt }`）也在这里读写 ——
 *     「这条公告已经强制读过 5 秒，永远不再强制」按 **id** 记账，纯逻辑在 `./readGate.ts`；
 *  4. 订阅用 `useSyncExternalStore` 那一套（`subscribe` + 取快照），与 `src/app/viewport.ts`
 *     的写法同形 —— 但这层**不 import React**，纯 Node 里可直接 import 做单测。
 *
 * 刷新与失败口径（公告特有的两条，版本清单不需要）：
 *  · **冷启动先吃缓存**：模块加载时同步读一次缓存，首帧就带数据（红点不会「先消失再出现」）；
 *  · **失败静默**：全失败就继续用缓存 / 空列表，**绝不弹错误** —— 公告拉不到不是故障；
 *  · **1 小时 TTL + 页面重新可见**：`visibilitychange` 时若距上次成功超过 1 小时才再拉一次
 *    （公告会随运营发布变化，长时间挂着的页面需要它；版本清单不用这么勤）。
 *
 * 为什么不沿用 `zustand`（`settings.ts` / `toastState.ts` 那套）：这里的真实来源是 **localStorage**
 * 而不是内存 store，`useSyncExternalStore` 的「快照 + 订阅」正好对上 —— 已读表变了就把新快照推出去，
 * 界面不需要知道 localStorage 长什么样。快照是**同引用**的（没写就不换对象），否则
 * `useSyncExternalStore` 会在每次 render 都判成「变了」而反复重渲染。
 */

/** 已读表：`{ [announcementId]: 读到的那一刻（毫秒） }` */
export const SEEN_STORAGE_KEY = 'chat-demo:announcements-seen'

/**
 * 「首次进入的公告弹窗已经弹过」的标记（有值即弹过，值本身不参与判断）。
 *
 * **弹窗出现的那一刻就写**（不是关闭时写）：用户切后台被系统杀掉时，`dismiss` 根本没机会执行，
 * 等关闭再写就等于「每次被杀都重弹一次」。它现在只剩两个作用：
 *  1. 老用户兼容 —— 门禁键（`READ_GATE_STORAGE_KEY`）从没写过时，有它就是「本机弹过」；
 *  2. 排查问题时能看出「这台机器到底弹过没有」。
 */
export const POPUP_SHOWN_STORAGE_KEY = 'chat-demo:announcements-popup-shown'

/**
 * 读出门禁：`{ [announcementId]: 读满 5 秒的那一刻（毫秒时间戳） }`。
 *
 * 它是「这条公告**永远不再强制**」的唯一来源 —— 与 `POPUP_SHOWN`（一次性的「弹过没有」）不同，
 * 它按 **id** 记账，所以「换新公告 → 重新强制 5 秒」和「同一条公告永不重强制」能同时成立。
 * 读写的纯逻辑在 `./readGate.ts`（零 React、零 localStorage，可直接单测）。
 */
export const READ_GATE_STORAGE_KEY = 'chat-demo:announcements-read-gate'

/** 远程列表缓存：`{ version, fetchedAt, items }`（冷启动先渲染它，再异步换上新的） */
export const CACHE_STORAGE_KEY = 'chat-demo:announcements-cache'

/** 调试开关：URL 带这个参数时清掉已读 / 弹窗标记**与列表缓存**（产品方反复看弹窗效果用） */
export const RESET_PARAM = 'ann-reset'

/**
 * 演示开关：URL 带这个参数时**不联网**，直接用 `mock.ts` 的 4 条（没网时给人看效果用）。
 * 默认（不带参数）走远程 —— 这是本单的语义反转：mock 从「默认」变成「显式演示」。
 */
export const DEMO_PARAM = 'ann-demo'

/** 缓存结构版本：字段有增减就 +1，旧结构整份丢弃（不做字段猜测式迁移） */
const CACHE_VERSION = 1
/** 缓存条数上限：远超真实公告量，够覆盖「很久没打开」的用户 */
const CACHE_MAX_ITEMS = 200
/** 字符数上限：128 KiB ≈ 5MB 配额的 2.5%，与其它设置项共享空间，不许无限增长 */
const CACHE_MAX_CHARS = 128 * 1024

/**
 * 后台刷新的最小间隔：距**上次成功**超过 1 小时，且页面重新可见时才再拉一次。
 * 取 1 小时的理由：公告的时效性是「天」级，1 小时的偏差无感；而每次切回前台都拉一遍，
 * 对一个常驻的手机 WebView 就是无意义的请求量。
 */
const REFRESH_TTL_MS = 60 * 60 * 1000

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

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** 校验从 localStorage 读回来的东西：只认「普通对象 + 有限数值」，脏数据一律当空表 */
const normalizeSeen = (value: unknown): AnnouncementSeenMap | null => {
  if (!object(value)) {
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

/** URL 参数判定（非浏览器环境 / 取不到 `location` 一律当作没有） */
const hasSearchParam = (name: string): boolean => {
  try {
    if (typeof location === 'undefined') {
      return false
    }
    return new URLSearchParams(location.search).has(name)
  } catch {
    return false
  }
}

/** 演示模式只在**模块生命周期内判定一次**（中途改 URL 不生效，与其它调试开关同形） */
let demoFlag: boolean | null = null
const demoMode = (): boolean => {
  if (demoFlag === null) {
    demoFlag = hasSearchParam(DEMO_PARAM)
  }
  return demoFlag
}

/**
 * 列表缓存的样子。`fetchedAt` 是**最后一次成功**拉取的时间，也是「1 小时 TTL」的起点 ——
 * 它必须跟着列表一起落盘，否则冷启动的第一次 `visibilitychange` 会把上次成功当成「从未成功」，
 * 每次切回前台都白拉一遍。
 */
type AnnouncementsCache = {
  fetchedAt: number
  items: Announcement[]
}

/**
 * 读缓存：任何一项不合格都返回 `null`（**不返回半份**）。
 *
 * 缓存是外部可变数据（用户能手改、旧版本可能写坏、结构可能升级），所以读回来一律走
 * `remote.ts` 的**同一个** `parseAnnouncementItem` 重新校验 —— 脏记录不许冒充公告上屏。
 * 条数超上限就按顺序截断（缓存只是兜底，丢几条旧的比整份不用更划算）。
 */
const readCache = (): AnnouncementsCache | null => {
  const raw = readRaw(CACHE_STORAGE_KEY)
  if (raw === null || raw === '') {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!object(parsed) || parsed['version'] !== CACHE_VERSION) {
    return null
  }
  const fetchedAt = parsed['fetchedAt']
  if (!Number.isSafeInteger(fetchedAt) || Number(fetchedAt) <= 0) {
    return null
  }
  const rows = parsed['items']
  if (!Array.isArray(rows)) {
    return null
  }
  const items: Announcement[] = []
  const seen = new Set<string>()
  for (const row of rows.slice(0, CACHE_MAX_ITEMS)) {
    const item = parseAnnouncementItem(row)
    if (item === null || seen.has(item.id)) {
      continue
    }
    seen.add(item.id)
    items.push(item)
  }
  return { fetchedAt: Number(fetchedAt), items }
}

/**
 * 写缓存：先按 `publishedAt` 倒序、截到上限，再按字符数兜底裁剪（丢掉最旧的那些）。
 *
 * 为什么不直接 `JSON.stringify` 就完事：localStorage 是与会话 / 设置共享的 5MB，
 * 一条被写爆的正文（20000 字上限 × 200 条）理论上就能吃掉一大块。写不进去时**宁可不缓存**，
 * 也不留一份半截的（半截 JSON 读回来只会被判失败，等于白占空间）。
 */
const saveCache = (): void => {
  const fetchedAt = lastFetchedAt
  if (fetchedAt === null) {
    return
  }
  let rows = [...items]
    .sort((left, right) => Date.parse(right.publishedAt) - Date.parse(left.publishedAt))
    .slice(0, CACHE_MAX_ITEMS)
  for (;;) {
    const payload = JSON.stringify({ version: CACHE_VERSION, fetchedAt, items: rows })
    if (payload.length <= CACHE_MAX_CHARS) {
      writeRaw(CACHE_STORAGE_KEY, payload)
      return
    }
    if (rows.length <= 1) {
      // 单条就超上限（正文被写爆）：放弃缓存，本次会话仍按内存里的列表走
      return
    }
    rows = rows.slice(0, -1)
  }
}

// ---------------------------------------------------------------------------
// 模块状态：列表、最近一次成功时间、加载状态
// ---------------------------------------------------------------------------

/** 冷启动的第一份数据：演示模式 → mock；否则 → 缓存（没有缓存就是空列表，等异步拉取补上） */
const coldStartItems = (): readonly Announcement[] => {
  if (demoMode()) {
    return MOCK_ANNOUNCEMENTS
  }
  return cachedItems
}

const initialCache = demoMode() ? null : readCache()

/** 缓存里读回来的列表（空数组 = 缓存没有/坏了） */
const cachedItems: readonly Announcement[] = initialCache?.items ?? []

/** 当前列表（远程数据 / 缓存 / demo 的 mock；**列表变化一律走 `publish()`**） */
let items: readonly Announcement[] = coldStartItems()

/** 最近一次**成功**拉取的时间（冷启动时取缓存里的 `fetchedAt`）；`null` = 从没成功过 */
let lastFetchedAt: number | null = initialCache?.fetchedAt ?? null

/** 「首屏数据已落定」：弹窗据此判断「现在没有未读」还是「还没拉到，先别判定」 */
let settled = demoMode()

/** 首次加载是否已经启动过（`ensureLoaded` 只跑一次） */
let started = false

/** 是否有一轮拉取在飞（同一时刻只允许一轮） */
let loading = false

/**
 * 轮次令牌：`resetAnnouncementState()` 会 +1，让**在飞的那一轮**结果作废。
 * 没有它的话，「reset 触发的新一轮」会与「旧一轮」互相覆盖，最后上屏的是旧数据。
 */
let runToken = 0

/** 当前快照：**同一个引用**直到下一次写入，`useSyncExternalStore` 靠它判断「有没有变」 */
let snapshot: AnnouncementList = buildAnnouncementList(items, loadSeen())

const listeners = new Set<() => void>()

/** 重算快照并通知订阅者（所有写入口只走这一条，避免「改了没广播」） */
const publish = (): void => {
  snapshot = buildAnnouncementList(items, loadSeen())
  for (const listener of listeners) {
    listener()
  }
}

/**
 * 拉一轮：成功就替换列表 + 落缓存；失败（`null`）就**什么都不改**，继续用缓存。
 *
 * 无论成功失败，结束时都 `publish()` 一次 —— 这不只是为了「数据变了要广播」：
 * 快照换了引用，`AnnouncementPopup` 那个「只判定一次」的 effect 才会**再跑一遍**，
 * 从而把「首屏数据已落定」这件事告诉它（否则冷启动无缓存时，弹窗会因为
 * 「那一刻列表还是空的」而永久不弹）。多一次重渲染，换掉一个真 bug，划算。
 */
const refresh = async (): Promise<void> => {
  if (loading || demoMode()) {
    settled = true
    return
  }
  loading = true
  const token = ++runToken
  try {
    const remote = await fetchAnnouncements()
    if (token !== runToken) {
      // 期间被 reset 抢占：这一轮结果丢掉，不写盘、不上屏
      return
    }
    if (remote !== null) {
      items = remote
      lastFetchedAt = Date.now()
      saveCache()
    }
  } catch {
    // `fetchAnnouncements` 已把网络 / HTTP / 解析失败都收成 `null`；这里只兜意外，同样静默
  } finally {
    if (token === runToken) {
      loading = false
      settled = true
      publish()
    }
  }
}

/**
 * 页面重新可见时按 TTL 补拉一次。
 *
 * 判据是「距上次**成功**超过 1 小时」：一次成功的拉取之后，用户切来切去都不再请求；
 * 从没成功过（`lastFetchedAt === null`）则视为「早该拉了」，重新可见立刻试一轮 ——
 * 这正是「上次是被断网挡住」的那个场景。
 */
const onVisibilityChange = (): void => {
  let visible = false
  try {
    visible = document.visibilityState === 'visible'
  } catch {
    return
  }
  if (!visible || loading) {
    return
  }
  if (lastFetchedAt !== null && Date.now() - lastFetchedAt < REFRESH_TTL_MS) {
    return
  }
  void refresh()
}

let visibilityBound = false
const listenForVisibility = (): void => {
  if (visibilityBound) {
    return
  }
  if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') {
    return
  }
  visibilityBound = true
  document.addEventListener('visibilitychange', onVisibilityChange)
}

/**
 * 「首次加载」的总闸：**幂等**，第一次调用时挂上 `visibilitychange` 并起一轮拉取。
 *
 * 为什么不在组件里 `useEffect` 里拉：调用方有三个（列表页 / 弹窗 / 侧栏红点 / 设置页那一行），
 * 任何一个先挂载都可能触发；把闸放在 store 这一层，调用方一行都不用改，也不会重复请求。
 *
 * **绝不在这里同步 `publish()`**：它会在 render 期间被调用（`listAnnouncements` 即 getSnapshot），
 * 同步广播等于「渲染中改状态」，React 会警告或反复重渲染。异步替换是唯一的写法。
 */
export const ensureLoaded = (): void => {
  if (started) {
    return
  }
  started = true
  // 测试接缝：启动期不自动拉公告（黄金/L1 是「启动即操作界面」，多一次弹窗会把输入框挡住）。
  // 手工触发的 `?ann-demo` / `?ann-reset` 不走这条早退。
  if (testSeamEnabled() && !demoMode()) {
    settled = true
    return
  }
  if (demoMode()) {
    settled = true
    return
  }
  listenForVisibility()
  void refresh()
}

/** 「首屏数据还没落定」（弹窗用：这时列表为空不代表「没有公告」） */
export const announcementsPending = (): boolean => !settled

/**
 * 公告列表（带 `read` 标记），按 `publishedAt` 倒序，并附 `unreadCount`。
 * 返回值在两次写入之间是**同一个对象**，可以直接当 `useSyncExternalStore` 的 getSnapshot。
 *
 * 顺带触发 `ensureLoaded()`：这是**读取入口**，「第一次有人要列表」就是加载的时机。
 */
export const listAnnouncements = (): AnnouncementList => {
  ensureLoaded()
  return snapshot
}

/** 订阅已读状态变化（`useSyncExternalStore` 的 subscribe），返回退订函数 */
export const subscribe = (listener: () => void): (() => void) => {
  ensureLoaded()
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

/** 一键已读：**当前列表**里全部未读标记为已读（没有未读时是空操作） */
export const markAllRead = (): void => {
  const seen = loadSeen()
  const now = Date.now()
  let changed = false
  for (const item of items) {
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

/**
 * 列表里**最新的一条**公告（弹窗的候选）；没有公告返回 `null`。
 *
 * 为什么是「最新」而不是「最新的未读」（改前的 `latestUnreadAnnouncement`）：强制阅读的门禁按
 * **id** 记账，如果候选是「最新的未读」，用户读完 A 之后列表里更老的未读 B 就成了候选，
 * 下次启动会被 B 再强制 5 秒 —— 那就成了「每次开机都要读一条老公告」。
 * 「同一条只强制一次」+「换新公告才重新强制」两句话要同时成立，候选必须是**最新那条**。
 */
export const latestAnnouncement = (
  list: AnnouncementList = snapshot
): AnnouncementWithReadState | null => list.items[0] ?? null

/** 首次进入的公告弹窗弹过没有 */
export const hasShownPopup = (): boolean => readRaw(POPUP_SHOWN_STORAGE_KEY) !== null

/**
 * 记「弹过了」。**展示即调**（不是关闭时调）：
 * 用户看到公告后切后台、被系统杀进程，`dismiss` 永远不会执行；写在这里才不会下次启动又弹一遍。
 */
export const markPopupShown = (): void => {
  writeRaw(POPUP_SHOWN_STORAGE_KEY, new Date().toISOString())
}

/**
 * 读门禁表。`null` = **这个键从没被写过**（老用户 / 刚 `?ann-reset`）—— 与空表 `{}` 的语义不同：
 *   · `null` + `POPUP_SHOWN` 有值 → 老用户，视为已读、不强制（不破坏既有「弹过一次」的判定）；
 *   · `{}` → 新版本已经接管过门禁（说明这是新语义的用户），照常按 id 强制。
 * 键在、内容坏了（手改 / 半截 JSON）→ 当空表：宁可多强制一次，也不要永久跳过强制阅读。
 */
export const readReadGate = (): ReadGateMap | null => {
  const raw = readRaw(READ_GATE_STORAGE_KEY)
  if (raw === null) {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  return parseReadGate(parsed)
}

/**
 * 初始化门禁键（写空表 `{}`）。**弹窗展示时立刻调**：
 * 它把「这台机器由新版本接管门禁」这件事落盘，从此老标记 `POPUP_SHOWN` 不再豁免强制 ——
 * 否则「展示即写 POPUP_SHOWN」会让没读满 5 秒就被杀进程的用户永久逃掉强制阅读。
 */
export const initReadGate = (): void => {
  if (readRaw(READ_GATE_STORAGE_KEY) !== null) {
    return
  }
  writeRaw(READ_GATE_STORAGE_KEY, '{}')
}

/**
 * 记「这条已经强制读完」（满 5 秒 / 用户点掉弹窗）。之后同一条公告**永远不再弹、也不再强制**；
 * 换新 id 才重新强制 5 秒。写入门禁是幂等的：重复写只是刷新时间戳。
 */
export const markReadGate = (id: string): void => {
  const gate = readReadGate() ?? {}
  writeRaw(READ_GATE_STORAGE_KEY, JSON.stringify(withFinished(gate, id, Date.now())))
}

/**
 * 清掉「已读」与「已弹过」两个标记 + **读出门禁** + **列表缓存**（调试用，见 `RESET_PARAM`）。
 *
 * 门禁一起清的理由：带 `?ann-reset` 刷新时要能**重新看到强制阅读 5 秒**，这是产品方反复验收
 * 这一条的唯一入口；留着门禁就会「reset 了却直接可关」，看起来像没生效。
 *
 * 为什么连缓存一起清：不清的话，带 `?ann-reset` 刷新后屏幕上仍是那份**旧列表**
 * （缓存优先渲染），「重置了但看起来什么都没变」，调试的人会以为开关没生效。
 * 清完立刻重新拉一轮，数据回来前列表是空的 —— 这是有意的：宁可空一下，
 * 也不要让「旧的已读态 + 新拉的数据」混在一起骗人。
 *
 * 演示模式（`?ann-demo`）下清完**回到 mock 基线**（`SEED_SEEN`：1 条已读），
 * 而不是「4 条全未读」：产品方要看的是「有红点 + 有一条已读不长红点」的完整形态，
 * 全清反而看不出对比。弹窗标记是真清空 —— 带 `?ann-reset` 刷新一次就会重新弹最新那条。
 */
export const resetAnnouncementState = (): void => {
  removeRaw(SEEN_STORAGE_KEY)
  removeRaw(POPUP_SHOWN_STORAGE_KEY)
  removeRaw(READ_GATE_STORAGE_KEY)
  removeRaw(CACHE_STORAGE_KEY)
  seenCache = null
  lastFetchedAt = null
  // 作废在飞的那一轮（它的结果属于「reset 之前」，不许覆盖马上要拉的新数据）
  runToken += 1
  loading = false
  if (demoMode()) {
    items = MOCK_ANNOUNCEMENTS
    settled = true
    publish()
    return
  }
  items = []
  settled = false
  started = false
  publish()
  // 立刻补一轮，别让用户对着空列表等下一次 visibilitychange
  ensureLoaded()
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
