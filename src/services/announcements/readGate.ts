/**
 * 公告「首次**强制阅读 5 秒**」的门禁 —— **纯函数**，零 React、零 localStorage、零 DOM。
 *
 * 两块东西，故意分开：
 *
 *  1. `ReadTimer`：**一次展示期间**的计时器（只活在内存里，组件用 ref 存着）。
 *     它只有一个时间基准：`shownAt` —— 弹窗**首次出现**的那一刻（墙钟 ms）。
 *     剩余时间一律由差值算出：`remaining = required - (now - shownAt)`。
 *
 *    为什么不存「每秒 +1 的计数器」：切后台后浏览器会把 `setInterval` 节流到 1s/分钟、
 *    极端情况下整段不触发，计数器必然少走；而「现在 - 出现那一刻」的差值天然不受节流影响 ——
 *    离屏 8 秒回来，差值就是把那 8 秒算进去了，**回来直接就够 5 秒**（产品口径：
 *    用户切出去就是不想看，回来不该让他再等一遍）。
 *
 *    也**没有**暂停 / 扣减离屏时间的逻辑：那套需要监听 `visibilitychange` 记账，一旦某个平台
 *    不派发该事件（或派发时机不准），就会出现「切出去很久回来还在倒计时」这种更难解释的体感。
 *    这里只有一个基准点，任何时刻重算都是对的。
 *
 *  2. `ReadGateMap`：**落盘的门禁表** `{ [announcementId]: 读满 5 秒的那一刻 }`。
 *     它的语义只有一个：**这个 id 已经强制过一次，永远别再强制**。
 *     某条公告 5 秒读完 / 用户点掉弹窗 → 写一条；同一 id 再展示 → `needsForcedRead()` 为假。
 *     换了新 id（运营发了新公告）→ 表里没有它 → 重新强制 5 秒。
 *
 * 老数据兼容（不能因为上线新逻辑就让老用户又恶心一次）：
 *  门禁键**从来没写过**（`gate === null`）+ 老标记 `POPUP_SHOWN` 有值 → 视为已读、不强制。
 *  这就是改前「弹过一次就再也不弹」的语义，原样保留给存量用户。
 *  门禁键一旦被新版本写过（哪怕值是空表 `{}`），就说明这个用户走的是新语义，
 *  此时老标记不再豁免 —— 否则「展示即写 POPUP_SHOWN」会让**没读满 5 秒就被杀进程**的用户
 *  永久逃掉强制阅读，那就等于没做。
 */

/** 强制阅读秒数（产品口径：5s）。改这里就是改口径，界面文案里的 `{seconds}` 跟着它走 */
export const FORCE_READ_SECONDS = 5

/** 同上，毫秒形态（计时器内部一律用 ms，只在显示时换算成秒） */
export const FORCE_READ_MS = FORCE_READ_SECONDS * 1000

/** 落盘的门禁表：`{ [announcementId]: 读满 5 秒的那一刻（毫秒时间戳） }` */
export type ReadGateMap = Record<string, number>

/**
 * 一次展示期间的计时器（**不可变**：没有 setter，任何「重新计时」都是新建一个对象）。
 *
 * - `shownAt`：弹窗**首次出现**的墙钟时刻（ms）—— 全局唯一的计时基准，只记一次；
 * - `required`：要读满多久（ms）。`0` = 这条不需要强制（已读 / 老用户）→ 剩余永远是 0。
 */
export type ReadTimer = {
  shownAt: number
  required: number
}

/** 纯函数：弹窗出现时建一个计时器（`now` = 出现那一刻的墙钟读数） */
export const createReadTimer = (now: number): ReadTimer => ({ shownAt: now, required: FORCE_READ_MS })

/**
 * 纯函数：`now` 这一刻**已经展示了多久**（ms）。就是墙钟差值，只夹住负数
 * （系统校时 / 用户改时间可能把 `now` 拉回到 `shownAt` 之前，夹住免得算出「负剩余」而提前放行）。
 */
export const elapsedAt = (timer: ReadTimer, now: number): number => Math.max(0, now - timer.shownAt)

/** 纯函数：还剩多少毫秒（不会为负） */
export const remainingMs = (timer: ReadTimer, now: number): number =>
  Math.max(0, timer.required - elapsedAt(timer, now))

/**
 * 纯函数：**还剩几秒**（向上取整，能关的那一刻才是 0）。
 * 向上取整的理由：读到 4.2s 时显示「还剩 1 秒」，比显示「还剩 0 秒但按钮还是灰的」诚实。
 * 它只依赖 `(timer, now)`，同一时刻取多少次都是同一个数 —— 抖动 / 重渲染都不会改变结果。
 */
export const remainingSeconds = (timer: ReadTimer, now: number): number =>
  Math.ceil(remainingMs(timer, now) / 1000)

/** 纯函数：读满了没有（= 「知道了」可用的判据） */
export const isFinished = (timer: ReadTimer, now: number): boolean => remainingMs(timer, now) === 0

/** 纯函数：这一条在门禁表里读完过 —— 返回读完的时刻，没有就是 `null` */
export const finishedAt = (gate: ReadGateMap, id: string): number | null => {
  if (!Object.hasOwn(gate, id)) {
    return null
  }
  const at = gate[id]
  return Number.isFinite(at) ? at : null
}

/**
 * 判定「这条公告要不要强制读 5 秒」的输入。
 *
 * - `gate`：落盘的门禁表；**`null` 表示门禁键从没写过**（老用户 / 刚 reset 过），与空表 `{}` 不同；
 * - `legacyShown`：老标记 `POPUP_SHOWN` 是否有值；
 * - `read`：这条在本机已读（列表里点过「已读」，或上次点过「知道了」）。
 */
export type GateInput = {
  id: string
  gate: ReadGateMap | null
  legacyShown: boolean
  read?: boolean
}

/**
 * 纯函数：要不要强制。
 *
 * 顺序即是优先级：
 *  1. 门禁表里有这个 id → **不要**（同一条公告永远只强制一次，这是本单的核心承诺）；
 *  2. 已读 → **不要**（用户已经处理过它了，没必要再拦）；
 *  3. 门禁键从没写过 + 老标记存在 → **不要**（老用户兼容，见文件头）。
 * 其余一律要：新 id / 全新用户 / 新语义下没读完就被杀掉（`{}` 已写、id 不在表里）。
 */
export const needsForcedRead = ({ id, gate, legacyShown, read = false }: GateInput): boolean => {
  if (gate !== null && finishedAt(gate, id) !== null) {
    return false
  }
  if (read) {
    return false
  }
  if (gate === null && legacyShown) {
    return false
  }
  return true
}

/**
 * 纯函数：这次展示该带一个什么样的计时器。
 * 需要强制 → 以 `now` 为基准全新的 5 秒计时器；不需要 → `required: 0` 的「已满足」计时器（剩余恒为 0）。
 * 组件只调这一个，省得把 `needsForcedRead` 的分支抄一遍。
 */
export const readTimerFor = (input: GateInput, now: number): ReadTimer => {
  if (!needsForcedRead(input)) {
    return { shownAt: now, required: 0 }
  }
  return createReadTimer(now)
}

/** 纯函数：写入门禁（**返回新表**，不改入参 —— 落盘前读快照的地方不该被就地改） */
export const withFinished = (gate: ReadGateMap, id: string, at: number): ReadGateMap => ({
  ...gate,
  [id]: at,
})

/** 纯函数：数据合格的门禁表（`undefined` / `null` / 非对象 / 数组 → `{}`） */
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * 纯函数：校验从 `localStorage` 读回来的门禁表。只认「普通对象 + 有限数值」，脏数据一律丢；
 * 整份不是对象（含 `null` / 数组 / 字符串）就当空表 —— 坏了宁可按「没读过」处理，
 * 也不要让一条脏记录冒充「读完了」而把强制阅读永久跳过。
 */
export const parseReadGate = (value: unknown): ReadGateMap => {
  if (!object(value)) {
    return {}
  }
  const gate: ReadGateMap = {}
  for (const [id, at] of Object.entries(value)) {
    if (typeof at === 'number' && Number.isFinite(at)) {
      gate[id] = at
    }
  }
  return gate
}
