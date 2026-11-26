import type { SessionSummary } from './types.js'

/**
 * 侧栏「按标题搜索会话」的口径 —— 唯一实现，React 组件与单测共用。
 *
 * 为什么抽出来：过滤规则（trim / 大小写 / 只搜标题）与「分组空了怎么办」是**产品口径**，
 * 散在 `Sider.tsx` 的 `useMemo` 里就只能靠浏览器验收，改一个字符没人拦得住；
 * 放在这里是一条纯函数，`tests/unit/sider-session-search.test.mjs` 直接钉住。
 *
 * 边界（刻意不做的事，别在这里悄悄扩面）：
 *   · **只匹配标题**。消息正文 / 附件名 / 分支来源标题都不读 —— 全文搜索是另一件事。
 *   · 不做拼音 / 分词 / 模糊匹配。中文按子串比，命中就是命中。
 *   · 不排序、不重建分组：分组结构（今天 / 昨天 / 7 天内 / 按月，以及置顶组）由调用方给，
 *     这里只负责「筛掉不匹配的行」和「丢掉筛空的组」。
 */

/** 分组结构（与 `groupSessions` 的返回、`Sider` 里置顶组拼出来的形状同构） */
export type SessionGroup = { key: string; label: string; sessions: SessionSummary[] }

/**
 * 查询归一化：`trim` + 小写。
 * 空查询归一成空串，是下面所有函数「返回全量」的判据（纯空白也走这条路）。
 */
export const normalizeTitleQuery = (query: string): string => query.trim().toLowerCase()

/** 单条会话是否命中（`normalizedQuery` 必须已经过 `normalizeTitleQuery`；空串 = 全部命中） */
export const matchesSessionTitle = (title: string, normalizedQuery: string): boolean =>
  normalizedQuery === '' || title.toLowerCase().includes(normalizedQuery)

/**
 * 平铺列表过滤。空查询**原样返回入参**（引用不变，调用方 `useMemo` 的下游不会白算一次）；
 * 否则返回新数组，入参一条都不改。
 */
export const filterSessionsByTitle = (
  sessions: SessionSummary[],
  query: string
): SessionSummary[] => {
  const needle = normalizeTitleQuery(query)
  if (needle === '') {
    return sessions
  }
  return sessions.filter((session) => matchesSessionTitle(session.title, needle))
}

/**
 * 分组过滤：逐组筛行，**整组筛空就连组标题一起丢掉**（否则界面上会剩一个「7 天内」下面空空如也）。
 * 命中不了的组、组内的行序、`key` / `label` 全部沿用原分组 —— 不重新生成，避免和时间分组打架。
 */
export const filterSessionGroups = (groups: SessionGroup[], query: string): SessionGroup[] => {
  const needle = normalizeTitleQuery(query)
  if (needle === '') {
    return groups
  }
  const result: SessionGroup[] = []
  for (const group of groups) {
    const hits = group.sessions.filter((session) => matchesSessionTitle(session.title, needle))
    if (hits.length > 0) {
      result.push({ key: group.key, label: group.label, sessions: hits })
    }
  }
  return result
}
