// [layer: unit | dependencies: none | no build, browser, network or Android]
/**
 * 侧栏「按标题搜索会话」的**纯函数**单测（零 React / 零 DOM / 零 IndexedDB）。
 *
 * 被测物：`src/services/chat/sessionFilter.ts`
 *   · `filterSessionsByTitle(sessions, query)` —— 平铺列表过滤（口径的唯一实现）
 *   · `filterSessionGroups(groups, query)`     —— 时间分组过滤（保留分组元数据，空组整组不显示）
 *
 * 这一组用例钉的是**产品口径**（设计稿 2026-11 侧栏搜索框），四条都不许松：
 *   1. `trim` 后匹配、大小写不敏感、空查询 = 全部（不改变列表）；
 *   2. **只匹配标题** —— 搜消息正文不是这件事（那是全文搜索，另一个单），标题没中的就必须筛掉；
 *   3. 分组结构沿用 `groupSessions`（今天 / 7 天内 / 按月…）：过滤**不重排、不改 label**，
 *      某组过滤后为空则整组连标题一起不出现（否则界面上会留一个「7 天内」下面空空如也）；
 *   4. 纯函数：不改入参（调用方是 React 的 `useMemo`，入参数组被改会让上游状态静默漂移）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

const { filterSessionsByTitle, filterSessionGroups } = await import(
  '../../src/services/chat/sessionFilter.ts'
)

/** 会话摘要的最小形态：过滤**只允许**读 `title`（其余字段只为「看起来像真数据」） */
const session = (id, title, extra = {}) => ({
  id,
  title,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  ...extra,
})

const SESSIONS = [
  session('s1', '打招呼'),
  session('s2', 'React Hooks 入门'),
  session('s3', '周报模板整理'),
  session('s4', 'react 性能优化笔记'),
]

test('① 空查询（含纯空白）→ 返回全量，顺序不变，且不改入参', () => {
  const before = SESSIONS.map((item) => item.id)
  assert.deepEqual(filterSessionsByTitle(SESSIONS, ''), SESSIONS)
  assert.deepEqual(filterSessionsByTitle(SESSIONS, '   '), SESSIONS)
  assert.deepEqual(filterSessionsByTitle(SESSIONS, '\t\n'), SESSIONS)
  assert.deepEqual(
    SESSIONS.map((item) => item.id),
    before,
    '过滤不许改入参数组'
  )
})

test('② 中文子串命中（只按标题的子串，不是前缀）', () => {
  assert.deepEqual(
    filterSessionsByTitle(SESSIONS, '招呼').map((item) => item.id),
    ['s1']
  )
  // 子串不只出现在开头
  assert.deepEqual(
    filterSessionsByTitle(SESSIONS, '模板').map((item) => item.id),
    ['s3']
  )
})

test('③ 大小写不敏感（英文标题）：react / REACT / React 同一结果', () => {
  const ids = (query) => filterSessionsByTitle(SESSIONS, query).map((item) => item.id)
  assert.deepEqual(ids('react'), ['s2', 's4'])
  assert.deepEqual(ids('REACT'), ['s2', 's4'])
  assert.deepEqual(ids('React'), ['s2', 's4'])
  assert.deepEqual(ids('hOoKs'), ['s2'])
})

test('④ 前后空格不影响结果（trim 后匹配，不做「整体包含空格」）', () => {
  const ids = (query) => filterSessionsByTitle(SESSIONS, query).map((item) => item.id)
  assert.deepEqual(ids('  react  '), ['s2', 's4'])
  assert.deepEqual(ids('\t招呼 '), ['s1'])
})

test('⑤ 无匹配 → 空数组（不是 undefined、不是全量）', () => {
  const out = filterSessionsByTitle(SESSIONS, '不存在的关键词')
  assert.ok(Array.isArray(out))
  assert.deepEqual(out, [])
})

test('⑥ 只搜标题：消息正文里有的词不算命中', () => {
  // 真数据里会话摘要没有 messages（`SessionSummary` 只挑 id/title/时间），
  // 但调用方传进来的对象可能带更多字段 —— 过滤**不许**顺手去读它们。
  const withBody = [
    session('b1', '日常闲聊', { messages: [{ role: 'user', content: '帮我看下 Kubernetes 告警' }] }),
    session('b2', 'Kubernetes 排障', { messages: [] }),
  ]
  const out = filterSessionsByTitle(withBody, 'Kubernetes')
  assert.deepEqual(
    out.map((item) => item.id),
    ['b2'],
    'b1 的正文里有这个关键词，但标题没有 → 不许命中（不做全文搜索）'
  )
})

test('⑦ 分组过滤：空组整组不显示，其余组的 key/label/顺序原样保留', () => {
  const groups = [
    { key: 'sessionHistoryTimelineLabelToday', label: '今天', sessions: [SESSIONS[0]] },
    { key: 'sessionHistoryTimelineLabel7days', label: '7 天内', sessions: [SESSIONS[1], SESSIONS[2]] },
    { key: '2024-06', label: '2024-06', sessions: [SESSIONS[3]] },
  ]
  const out = filterSessionGroups(groups, 'react')
  assert.deepEqual(
    out.map((group) => group.key),
    ['sessionHistoryTimelineLabel7days', '2024-06'],
    '「今天」过滤后为空 → 整组（含标题）不出现'
  )
  assert.deepEqual(
    out.map((group) => group.label),
    ['7 天内', '2024-06'],
    'label 与顺序沿用原分组，不重新生成'
  )
  assert.deepEqual(out[0].sessions.map((item) => item.id), ['s2'])
  assert.deepEqual(out[1].sessions.map((item) => item.id), ['s4'])
  // 组数没有凭空变多，原数组也没被改
  assert.equal(groups[0].sessions.length, 1)
  assert.equal(groups[1].sessions.length, 2)

  // 空查询 = 原样返回全部组（引用不变，避免 useMemo 下游无意义重算）
  assert.equal(filterSessionGroups(groups, ''), groups)

  // 一条都不中 → 没有任何组（界面据此显示「没有找到匹配的会话」）
  assert.deepEqual(filterSessionGroups(groups, 'zzz'), [])
})
