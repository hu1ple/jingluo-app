import type { TranslationMessage } from '../../i18n/index.js'

/**
 * 公告的相对时间（刚刚 / N 分钟前 / N 小时前 / N 天前）。
 *
 * 返回**词条 + 参数**而不是拼好的字符串：文案要跟着语言切换（`zh` / `en`），
 * 在渲染那一刻由 `t(key, params)` 翻；这也让本函数保持纯逻辑，单测里传一个固定的 `now` 就能断言。
 */
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export const relativeTime = (iso: string, now: number = Date.now()): TranslationMessage => {
  const at = Date.parse(iso)
  // 解析不出来（脏数据 / 后端给了空串）：按「刚刚」处理，不显示 NaN 天前
  if (Number.isNaN(at)) {
    return { key: 'announceTimeJustNow' }
  }
  const elapsed = now - at
  if (elapsed < MINUTE) {
    // 负数（发布时间在未来，时钟不同步）也落这里：显示「刚刚」比「-3 分钟前」诚实
    return { key: 'announceTimeJustNow' }
  }
  if (elapsed < HOUR) {
    return { key: 'announceTimeMinutesAgo', params: { count: Math.floor(elapsed / MINUTE) } }
  }
  if (elapsed < DAY) {
    return { key: 'announceTimeHoursAgo', params: { count: Math.floor(elapsed / HOUR) } }
  }
  return { key: 'announceTimeDaysAgo', params: { count: Math.floor(elapsed / DAY) } }
}
