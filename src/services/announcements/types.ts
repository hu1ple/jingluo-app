/**
 * 公告（站内通知）的数据形状。
 *
 * 本轮只做**本地 mock**：没有后端、没有网络、没有 `@capacitor/core` —— 数据来自 `./mock.ts`，
 * 已读状态来自 `localStorage`（见 `./store.ts`）。形状按「将来接后端时不用改界面」定的：
 * 后端换一份 `Announcement[]` 进来，`store.ts` 那层 view 逻辑（排序 / 已读 / 未读数）一行都不用动。
 */

/**
 * 公告级别。
 * - `normal`：普通公告
 * - `important`：重要公告 —— 弹窗标题前加醒目标记（红色感叹号），列表里同样标出来
 */
export type AnnouncementLevel = 'normal' | 'important'

export type Announcement = {
  /** 稳定 id：已读状态按它存（`{ [id]: timestamp }`），**换 id 就等于重新变未读** */
  id: string
  title: string
  /** 正文：允许换行（长公告靠它验证换行 / 滚动），也允许纯单段短文本 */
  body: string
  /** 发布时间，ISO 8601 字符串（`new Date(iso)` 可解析）；列表按它倒序 */
  publishedAt: string
  level: AnnouncementLevel
}

/** 列表里的一行：公告本体 + 这条在**本机**读过没有 */
export type AnnouncementWithReadState = Announcement & { read: boolean }

/** `listAnnouncements()` 的返回：带 `read` 标记的列表 + 未读条数（一次算完，避免界面自己再数一遍） */
export type AnnouncementList = {
  items: AnnouncementWithReadState[]
  unreadCount: number
}

/** 已读表：id → 读到的那一刻（毫秒时间戳，留着以后做「最近读过」/ 服务端同步时对账） */
export type AnnouncementSeenMap = Record<string, number>
