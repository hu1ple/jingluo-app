// [layer: unit | 纯 Node（纯函数，零 I/O 零网络） | 耗时: <1s]
//
// 豁免登记契约（门禁优化第 7 条）：**任何豁免都必须会过期，而且必须自己暴露已经失效**。
//
// 这里钉的是 `scripts/lib/exemption-policy.mjs` 的纯函数；真正的读写与报告在
// `scripts/check-test-exemptions.mjs`（CI 步骤 `pnpm run check:exemptions`），
// 它自带的 `--selftest` 跑的是同一批判据的端到端版本。
//
// 为什么要有这个文件（而不是「脚本能跑就行」）：
//   这份契约一旦被改松，症状是「门禁绿了但没有一个人被拦」—— 静默失效，看输出看不出来。
//   所以每条判据都要有一条**必红的反例**钉在这里：改松任何一条，这个文件先红。
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  KIND_SPECS,
  PROBLEM,
  buildSnapshot,
  daysBetween,
  diffSnapshots,
  isIsoDay,
  issueNumber,
  issueRefOf,
  summarize,
  validateEntry,
} from '../../scripts/lib/exemption-policy.mjs'

const TODAY = '2026-11-25'

/** 一条**完全合法**的 known-red（下面每个反例只破坏它一个字段 —— 这样失败信息能直接指出「是哪个字段的判据没了」） */
const GOOD = {
  reason: '集成层 upstream-html 在标准产物下仍返回半截 HTML：契约要求整页折叠，产品未做到，属真实产品缺陷（C 类）。',
  evidence: '2026-11-19 实测 FAIL 12.4s，日志见 #432 附件；--baseline 复跑同样红',
  followUp: '#432',
  addedAt: '2026-11-19',
  reviewAfter: '2027-01-31',
  lastRedAt: '2026-11-24',
}

const check = (over = {}, options = {}) =>
  validateEntry({
    kind: 'integration-known-red',
    key: 'k',
    entry: { ...GOOD, ...over },
    today: TODAY,
    issueStates: options.issueStates ?? new Map(),
    exists: options.exists ?? (() => true),
    resolveFile: options.resolveFile ?? (() => 'tests/integration/x.test.mjs'),
  })

const codes = (result) => result.problems.map((problem) => problem.code)

test('合法条目：放行，并算出还剩几天（判据有边界，才谈得上「必红」不等于「恒红」）', () => {
  const result = check()
  assert.deepEqual(codes(result), [], `合法条目被误杀：${JSON.stringify(result.problems, null, 2)}`)
  assert.equal(result.ok, true)
  assert.equal(result.daysLeft, daysBetween(TODAY, GOOD.reviewAfter))
  assert.ok(result.daysLeft > 0)
})

test('缺 reason / reason 是占位句 → 非法（「暂时允许」四个字不是理由）', () => {
  assert.ok(codes(check({ reason: '' })).includes(PROBLEM.MISSING_REASON))
  assert.ok(codes(check({ reason: '先这样' })).includes(PROBLEM.MISSING_REASON), '太短，写不清为什么')
  assert.ok(codes(check({ reason: '（待补：抽掉后删本条）' })).includes(PROBLEM.PLACEHOLDER_REASON))
})

test('缺 / 假证据 → 非法（证据里必须有可复核的事实：日期 / 提交号 / 工单号）', () => {
  assert.ok(codes(check({ evidence: '' })).includes(PROBLEM.MISSING_EVIDENCE))
  assert.ok(codes(check({ evidence: '一直就是红的，大家都知道' })).includes(PROBLEM.UNCITED_EVIDENCE))
})

test('缺承接单 / 承接单不是工单引用 → 非法', () => {
  assert.ok(codes(check({ followUp: '' })).includes(PROBLEM.MISSING_FOLLOWUP))
  assert.ok(codes(check({ followUp: '以后再说' })).includes(PROBLEM.INVALID_FOLLOWUP))
  assert.ok(!codes(check({ followUp: 'zzy-repo/jingluo-app#432' })).includes(PROBLEM.INVALID_FOLLOWUP), 'owner/repo#N 是合法形态')
})

test('承接单已关闭 → 非法（关单说明这件事该结案，豁免不能比承接单活得久）', () => {
  const result = check({}, { issueStates: new Map([[432, 'closed']]) })
  assert.ok(codes(result).includes(PROBLEM.FOLLOWUP_CLOSED))
  const open = check({}, { issueStates: new Map([[432, 'open']]) })
  assert.ok(!codes(open).includes(PROBLEM.FOLLOWUP_CLOSED))
})

test('缺到期日 / 到期日非法 / 到期日远到等于没有 → 非法', () => {
  assert.ok(codes(check({ reviewAfter: '' })).includes(PROBLEM.MISSING_REVIEW_AFTER), '没有到期日 = 永久后门')
  assert.ok(codes(check({ reviewAfter: '2027-02-31' })).includes(PROBLEM.INVALID_REVIEW_AFTER), '2 月 31 日不是日期')
  assert.ok(codes(check({ reviewAfter: '2030-01-01' })).includes(PROBLEM.WINDOW_TOO_LONG), '超出该类最长复核窗口')
})

test('已过期 → 非法（到期当天仍有效，第二天才红）', () => {
  assert.ok(codes(check({ reviewAfter: '2026-11-24' })).includes(PROBLEM.EXPIRED))
  const lastDay = check({ reviewAfter: TODAY })
  assert.ok(!codes(lastDay).includes(PROBLEM.EXPIRED), '到期当天仍然有效：reviewAfter 是「最晚复审到哪一天」')
  assert.equal(lastDay.status, 'expiring')
})

test('已跑绿 → 非法：两种「跑绿」的机器形态都要判（自有观测字段 / 隔离后跑绿）', () => {
  // ① 条目自己记着上一次实跑是 pass
  assert.ok(codes(check({ lastObserved: 'pass' })).includes(PROBLEM.FIXED))
  // ② flaky 隔离区里「隔离之后又跑绿了」—— 用的是登记簿已有的字段，不需要人再填任何东西
  const quarantine = validateEntry({
    kind: 'flaky-quarantine',
    key: 'tests/unit/x.test.mjs',
    entry: {
      reason: '首帧竞态：同 runner 上失败一次、重跑绿，属时序 flake，已改成等终态待验证。',
      followUp: '#406',
      quarantinedAt: '2026-11-20',
      lastGreen: '2026-11-24T02:00:00.000Z',
      reviewAfter: '2026-12-20',
    },
    today: TODAY,
    resolveFile: () => 'tests/unit/x.test.mjs',
  })
  assert.ok(codes(quarantine).includes(PROBLEM.FIXED), `隔离后跑绿必须报 FIXED：${JSON.stringify(quarantine.problems)}`)
})

test('对象文件已经不存在 → 非法（跑不到的东西不需要豁免）', () => {
  const result = check({}, { exists: () => false })
  assert.ok(codes(result).includes(PROBLEM.DEAD_ENTRY))
  const noTarget = validateEntry({
    kind: 'adversarial-known-defect',
    key: 'a1',
    entry: { reason: GOOD.reason, evidence: GOOD.evidence, followUp: '#432', addedAt: GOOD.addedAt, reviewAfter: GOOD.reviewAfter },
    today: TODAY,
    resolveFile: () => false,
  })
  assert.ok(codes(noTarget).includes(PROBLEM.DEAD_ENTRY), '条目缺 file / 组为空也要判死登记')
})

test('环境问题不许塞进豁免；写清「不是环境问题」的不算命中', () => {
  assert.ok(codes(check({ reason: '本机缺产物 dist-standard，跑不了，先记成已知红。' })).includes(PROBLEM.ENV_AS_EXEMPTION))
  assert.ok(codes(check({ reason: '端口被占导致整批假红，先放这里。' })).includes(PROBLEM.ENV_AS_EXEMPTION))
  const rebutted = check({ reason: '断言等的是「整页折叠」而产品返回半截 HTML；这不是环境问题（同一步在标准产物下稳定复现）。' })
  assert.ok(!codes(rebutted).includes(PROBLEM.ENV_AS_EXEMPTION), '带反驳词的归因不该被误杀')
})

test('声称还红但很久没人实跑 → 非法（豁免的是红，不是猜测）', () => {
  assert.ok(codes(check({ lastRedAt: '' })).includes(PROBLEM.STALE_OBSERVATION))
  assert.ok(codes(check({ lastRedAt: '2026-08-01' })).includes(PROBLEM.STALE_OBSERVATION), '超过 60 天没人跑过')
  assert.ok(!codes(check({ lastRedAt: '2026-11-01' })).includes(PROBLEM.STALE_OBSERVATION))
})

test('不是豁免的东西不被套「到期日」（机制不许无差别乱压摩擦）', () => {
  const weight = validateEntry({
    kind: 'shard-weight',
    key: 'caps.test.mjs',
    entry: { ms: 2959, addedAt: '2026-11-20', reviewAfter: '2026-11-20' },
    today: TODAY,
    resolveFile: () => 'tests/integration/caps.test.mjs',
  })
  assert.equal(weight.exemption, false)
  assert.deepEqual(codes(weight), [], '分片权重只影响均衡度，不该有 reason / 到期日这类豁免字段要求')
  assert.equal(KIND_SPECS['shard-weight'].requireReviewAfter, false)
  assert.equal(KIND_SPECS['flaky-infra-signature'].exemption, false, '签名登记不放行任何文件 → 不算豁免')
})

test('日期判据自身：非法日期不许被 Date.parse 蒙混过去', () => {
  assert.equal(isIsoDay('2026-02-31'), false, 'Date.parse 会把它滚成 3/3，必须回环比对')
  assert.equal(isIsoDay('2026-2-3'), false)
  assert.equal(isIsoDay('2026-02-03'), true)
  assert.equal(daysBetween('2026-11-25', '2026-12-25'), 30)
  assert.equal(daysBetween('坏日期', '2026-12-25'), null, '算不出来就是 null，不许假装算出来了')
})

test('工单引用归一：#N / owner/repo#N / issue URL 都能取出单号', () => {
  assert.equal(issueNumber('#892'), 892)
  assert.equal(issueNumber('zzy-repo/jingluo-app#892'), 892)
  assert.equal(issueNumber('https://github.com/zzy-repo/jingluo-app/issues/892'), 892)
  assert.equal(issueNumber('看那个单'), null)
  assert.equal(issueRefOf({ followUp: '#1', issue: '#2' }), '#1', '两个都有时 followUp（承接单）优先')
  assert.equal(issueRefOf({ issue: 611 }), '#611', '数字形态的 issue 也要认')
})

test('趋势：新增/移除都点名（不设上限，只让「只增不减」显形）', () => {
  const before = { today: '2026-11-20', entries: { 'fast-subset-exclude': ['a', 'b'] } }
  const after = { today: TODAY, entries: { 'fast-subset-exclude': ['b', 'c'], 'duplication-baseline': ['g1'] } }
  const diff = diffSnapshots(before, after)
  assert.equal(diff.totalBefore, 2)
  assert.equal(diff.totalAfter, 3)
  const fast = diff.rows.find((row) => row.kind === 'fast-subset-exclude')
  assert.deepEqual(fast.added, ['c'])
  assert.deepEqual(fast.removed, ['a'])
  assert.deepEqual(diff.rows.find((row) => row.kind === 'duplication-baseline').added, ['g1'])
})

test('快照只记「真的放行了某件事」的条目（不是豁免的登记不进豁免总数）', () => {
  const results = [
    { kind: 'integration-known-red', key: 'a', exemption: true, problems: [], ok: true, status: 'ok' },
    { kind: 'shard-weight', key: 'b', exemption: false, problems: [], ok: true, status: 'ok' },
  ]
  const snapshot = buildSnapshot({ today: TODAY, results })
  assert.deepEqual(snapshot.entries, { 'integration-known-red': ['a'] })
  const summary = summarize(results)
  assert.equal(summary.total, 2)
  assert.equal(summary.exemptions, 1, '豁免总数只数「放行了某件事」的那些')
})
