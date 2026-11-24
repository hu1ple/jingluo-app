import type { Announcement, AnnouncementSeenMap } from './types.js'

/**
 * 公告的本地 mock（4 条）。**正文可以直接写中文**：产品方明确「公告内容只做中文」，
 * 它不是 UI 文案，不进 `src/i18n`（界面标签才走 i18n，见 `AnnouncementList.tsx` / `AnnouncementPopup.tsx`）。
 *
 * 这 4 条刻意覆盖四种形态（产品方要看的就是这四种）：
 *   ① `ann-welcome`      最新一条（几分钟前）+ 未读 + `important`（弹窗 / 列表都要看到醒目标记）
 *   ② `ann-network`      未读（几小时前）
 *   ③ `ann-privacy`      **已读**（3 天前）—— 靠 `SEED_SEEN` 种下去，否则刚打开永远看不到「已读」的样子
 *   ④ `ann-long-body`    正文很长（多段 + 空行），验证 2 行截断、展开换行与滚动
 *
 * 时间用「相对当前时刻」算：固定在某个绝对日期的话，过两天演示就变成「N 天前」，
 * 「最新的那条」看起来和别的没区别；这里每次加载都保证 ① 就是「刚刚 / 几分钟前」。
 */
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** 相对当前时刻往前推 ms，返回 ISO 字符串 */
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString()

/** 长正文：多段、带空行、带超长行，专门用来验证换行 / 截断 / 滚动 */
const LONG_BODY = [
  '这是一条正文很长的公告，用来验证换行、2 行截断、展开后的排版与滚动条。',
  '',
  '第一段：公告栏的正文可能包含多段文字。段与段之间的空行必须保留，所以渲染时用的是 pre-wrap，而不是把换行压成空格。',
  '',
  '第二段：下面这一行故意写得很长，长到在 390px 宽的手机上一定要折行好几遍，用来确认 word-break / overflow-wrap 生效，不会把弹窗撑出屏幕外：',
  'AAAAAAAA-BBBBBBBB-CCCCCCCC-DDDDDDDD-EEEEEEEE-FFFFGGGG-HHHHIIII-JJJJKKKK-LLLLMMMM-NNNNOOOO-PPPPQQQQ',
  '',
  '第三段：弹窗里的正文区最高不超过屏高的 70%，超出部分自己滚；列表里的摘要只显示 2 行，点摘要展开全文，再点收起。',
  '',
  '第四段：如果你在这里能读到这一行，说明滚动到底了，正文没有被裁掉。',
].join('\n')

export const MOCK_ANNOUNCEMENTS: readonly Announcement[] = [
  {
    id: 'ann-welcome',
    title: '公告栏上线：以后通知都在这里看',
    body: '设置 → 公告 里新增了「公告栏」。有未读公告时，公告栏这一行会带一个红点；第一次进入应用时，最新的一条会自动弹一次。\n\n这版数据是本地 mock，用来先看效果，还没有接后端。',
    publishedAt: ago(6 * MINUTE),
    level: 'important',
  },
  {
    id: 'ann-network',
    title: '高峰期回复可能变慢，请错峰使用',
    body: '晚 20:00–23:00 是使用高峰，长对话的首字延迟可能比平时高。这不是故障，也无需重试，错峰使用会明显更快。',
    publishedAt: ago(5 * HOUR),
    level: 'normal',
  },
  {
    id: 'ann-long-body',
    title: '关于长公告的显示（正文很长，可展开与滚动）',
    body: LONG_BODY,
    publishedAt: ago(2 * DAY),
    level: 'normal',
  },
  {
    id: 'ann-privacy',
    title: '隐私说明更新：会话只留在本机',
    body: '会话、附件索引与设置都只存在本机（浏览器本地存储 / IndexedDB），不会因为「打开过应用」而上传。',
    publishedAt: ago(3 * DAY),
    level: 'normal',
  },
]

/**
 * 「已经读过」的演示基线：`ann-privacy`（3 天前那条）种成已读。
 *
 * 只在 `localStorage` 里**还没有** `chat-demo:announcements-seen` 时写入一次（见 `store.ts` 的 `loadSeen`）：
 *  - 不种的话，刚打开的界面上 4 条全是未读，「已读的那条不长红点」这个形态一辈子看不到；
 *  - 种过之后再改已读状态，就完全以本机存的为准 —— 基线不影响真实交互。
 * 时间戳用 0（「很久以前读过」），不参与任何显示逻辑，只表示「这条标记为已读」。
 */
export const SEED_SEEN: AnnouncementSeenMap = {
  'ann-privacy': 0,
}
