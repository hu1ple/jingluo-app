#!/usr/bin/env node
/**
 * check-test-exemptions.mjs —— **豁免登记契约门禁**（门禁优化第 7 条）。
 *
 * 一句话：本仓所有「允许它先这样」的表（基线 / 白名单 / 隔离区 / 排除名单）必须**带证据、带承接单、
 * 带到期日**，并且**自己会烂**：条件一旦不成立，门禁当场红，而不是靠人记得回来删。
 *
 * ## 为什么是「一道门禁管全部豁免」，而不是每份文件各写一套
 *
 * 六份文件的注释里都写着同一套纪律（reason + 证据 + followUp + 跑绿要删），但每份都只在自己那两个
 * 脚本里被**部分**执行，于是缺口各不相同：
 *
 * | 文件 | 之前的「不腐烂」靠什么 | 实际漏在哪 |
 * | --- | --- | --- |
 * | `tests/integration-baseline.json` | `run-layer --baseline` 报 `FIXED?`（跑绿提醒删条目） | `reason` 可以空；`followUp` 无人核对；**没有到期日**；环境问题能被写成 known-red |
 * | `tests/flaky-registry.json` | 跑绿自动解除隔离 + 每周提醒 + 连续 3 次进隔离 | 隔离**没有期限**（提醒只是打印）；`reason` 是自动生成的原始报错；文件删了条目还在 |
 * | `tests/adversarial/baseline.json` | `known-defect` 变绿报 REGRESSION | `--record` 会把 known-defect 直接改回 green（**私自销账**）；没有承接单/到期日 |
 * | `tests/test-duplication-baseline.json` | 组不再重复 → stale 提示（`--strict` 红） | `reason` 有长度检查，但 `issue` 可选、**没有到期日** |
 * | `tests/test-duplication-whitelist.json` | `reason` 必须写（<4 字报错） | `issue` 不强制；**没有到期日**；条目不再命中时无人管 |
 * | `tests/fast-subset.json` | 排除名单失效时打印一句「请删掉」 | **不阻塞**（注释原文「过期条目不阻塞」）；没有到期日、没人重测 |
 *
 * 六套缺口 = 六种「反正没人查」。收到一处之后，纪律才可能被执行一次编写、六处受益；
 * 以后新增第七张表，只要在 `KIND_SPECS` 里登记，就自动获得同一套判据（而不是再来一次「注释纪律」）。
 *
 * ## 四条判据（详见 `scripts/lib/exemption-policy.mjs` 的注释）
 *
 *   1. 元数据不全（缺 reason / 证据 / 承接单 / 到期日，或写「待补」）→ 红；
 *   2. 过期（今天 > `reviewAfter`）、或到期日远到等于没有（超出该类的 `maxReviewDays`）→ 红；
 *   3. 已经不再成立：对象文件没了 / 已经跑绿 / 承接单已关闭 / 声称还红但 N 天没人实跑 → 红；
 *   4. 拿环境问题顶包（缺产物 / 端口被占 / 机器慢）→ 红。
 *
 * ## 「只增不减」怎么处理：让它显形，不设上限
 *
 * 每次跑都会与 `tests/exemption-ledger.json` 的上一份快照比：总数、每类增量、**新增/移除了哪几条**。
 * 不设上限的理由很直接：上限会逼人删掉真豁免来保绿 —— 那就从「豁免会腐烂」退化成「红不等于坏」。
 *
 * ## 用法
 *
 *   node scripts/check-test-exemptions.mjs                  # 门禁模式：任一非法条目 → exit 1
 *   node scripts/check-test-exemptions.mjs --strict          # + 抓不到工单状态也算环境失败（CI 用这个）
 *   node scripts/check-test-exemptions.mjs --json r.json     # 机器可读
 *   node scripts/check-test-exemptions.mjs --now 2027-01-01  # 注入「今天」（自证过期判据用）
 *   node scripts/check-test-exemptions.mjs --issue-states f.json  # 用离线快照代替 gh
 *   node scripts/check-test-exemptions.mjs --no-issues       # 完全不查工单状态（只在无网时手工用）
 *   node scripts/check-test-exemptions.mjs --record          # 把本次状态追加进 tests/exemption-ledger.json
 *   node scripts/check-test-exemptions.mjs --selftest        # 反例自检：四类坏条目必须被判非法
 *
 * 退出码：0 通过 / 1 有非法条目 / 2 环境不具备（文件读不到、`--strict` 下抓不到工单状态、用法错）
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  KIND_SPECS,
  PROBLEM,
  buildSnapshot,
  diffSnapshots,
  isIsoDay,
  issueNumber,
  issueRefOf,
  summarize,
  validateEntry,
} from './lib/exemption-policy.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const LEDGER_FILE = 'tests/exemption-ledger.json'
/** 快照保留份数（再多也没人看；历史要长就去 git 里翻） */
const LEDGER_KEEP = 60

function usage(message) {
  if (message) console.error(`${message}\n`)
  console.error(
    '用法：node scripts/check-test-exemptions.mjs [--strict] [--json <file>] [--now YYYY-MM-DD]\n' +
      '                                          [--issue-states <file>] [--no-issues] [--repo owner/repo]\n' +
      '                                          [--record] [--selftest]',
  )
  process.exit(2)
}

function parseArgs(argv) {
  const opts = { strict: false, json: '', now: new Date().toISOString().slice(0, 10), issueStates: '', noIssues: false, record: false, selftest: false, repo: '' }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--') continue
    else if (arg === '--strict') opts.strict = true
    else if (arg === '--no-issues') opts.noIssues = true
    else if (arg === '--record') opts.record = true
    else if (arg === '--selftest') opts.selftest = true
    else if (arg === '--json') {
      opts.json = argv[++i]
      if (!opts.json || opts.json.startsWith('--')) usage('--json 需要一个输出路径')
    } else if (arg === '--now') {
      opts.now = argv[++i]
      if (!isIsoDay(opts.now)) usage('--now 必须是 YYYY-MM-DD')
    } else if (arg === '--repo') {
      opts.repo = argv[++i]
      if (!opts.repo || opts.repo.startsWith('--')) usage('--repo 需要 owner/repo')
    } else if (arg === '--issue-states') {
      opts.issueStates = argv[++i]
      if (!opts.issueStates || opts.issueStates.startsWith('--')) usage('--issue-states 需要一个文件路径')
    } else usage(`未知参数：${arg}`)
  }
  return opts
}

const abs = (rel) => path.join(ROOT, rel)
const exists = (rel) => existsSync(abs(rel))

function readJson(rel, { required = true } = {}) {
  try {
    return JSON.parse(readFileSync(abs(rel), 'utf8'))
  } catch (error) {
    if (required) {
      console.error(`${rel} 读不到或不是合法 JSON：${error.message}`)
      console.error('  豁免文件的形状坏了 = 这份豁免现在谁都判不了（不是「没有豁免」）→ 按环境失败处理')
      process.exit(2)
    }
    return null
  }
}

/**
 * 从六份文件里捞出所有「登记」，按类别打上 kind。
 * 每类的**目标文件**如何解析也在这里（`resolveFile`）：判定「对象还在不在」需要它。
 */
function collect() {
  const entries = []

  const integration = readJson('tests/integration-baseline.json', { required: false }) ?? {}
  for (const [name, entry] of Object.entries(integration.files ?? {})) {
    if (entry?.expected !== 'known-red') continue
    entries.push({
      kind: 'integration-known-red',
      key: name,
      entry,
      resolveFile: () => `tests/integration/${name}`,
    })
  }

  const flaky = readJson('tests/flaky-registry.json', { required: false }) ?? {}
  for (const [name, entry] of Object.entries(flaky.tests ?? {})) {
    if (!entry?.quarantinedAt) continue
    entries.push({ kind: 'flaky-quarantine', key: name, entry, resolveFile: () => name })
  }
  for (const sig of flaky.infraSignatures ?? []) {
    entries.push({
      kind: 'flaky-infra-signature',
      key: sig?.id ?? '(无 id)',
      entry: { ...sig, addedAt: sig?.firstSeen, reviewAfter: sig?.reviewAfter },
      resolveFile: null,
    })
  }

  const adversarial = readJson('tests/adversarial/baseline.json', { required: false }) ?? {}
  for (const [id, entry] of Object.entries(adversarial.cases ?? {})) {
    if (entry?.verdict !== 'known-defect') continue
    entries.push({
      kind: 'adversarial-known-defect',
      key: id,
      entry,
      resolveFile: () => (entry?.file ? `tests/adversarial/cases/${entry.file}` : false),
    })
  }

  const dupBaseline = readJson('tests/test-duplication-baseline.json', { required: false }) ?? {}
  for (const [index, entry] of (dupBaseline.groups ?? []).entries()) {
    const files = Array.isArray(entry?.files) ? entry.files : []
    const dead = files.find((file) => !exists(file))
    entries.push({
      kind: 'duplication-baseline',
      key: files.length ? files.join(' ↔ ') : `groups[${index}]`,
      entry: { ...entry, addedAt: entry?.addedAt ?? dupBaseline.updatedAt },
      resolveFile: () => (dead ? dead : files[0] ?? false),
    })
  }

  const dupWhitelist = readJson('tests/test-duplication-whitelist.json', { required: false }) ?? {}
  for (const bucket of ['groups', 'keywords', 'titles']) {
    for (const [index, entry] of (dupWhitelist[bucket] ?? []).entries()) {
      const files = Array.isArray(entry?.files) ? entry.files : []
      const dead = files.find((file) => !exists(file))
      entries.push({
        kind: 'duplication-whitelist',
        key: entry?.topic ?? entry?.title ?? (files.length ? files.join(' ↔ ') : `${bucket}[${index}]`),
        entry,
        resolveFile: files.length === 0 ? null : () => (dead ? dead : files[0]),
      })
    }
  }

  const fastSubset = readJson('tests/fast-subset.json', { required: false }) ?? {}
  for (const entry of fastSubset.exclude ?? []) {
    const name = String(entry?.file ?? '')
    entries.push({
      kind: 'fast-subset-exclude',
      key: name || '(缺 file)',
      entry: { ...entry, addedAt: entry?.addedAt ?? fastSubset.measuredAt },
      resolveFile: () => (name ? `tests/unit/${name}` : false),
    })
  }

  const weights = readJson('tests/integration-shard-weights.json', { required: false }) ?? {}
  for (const [name, entry] of Object.entries(weights.files ?? {})) {
    entries.push({
      kind: 'shard-weight',
      key: name,
      entry: { ...entry, reviewAfter: entry?.reviewAfter ?? weights.recordedAt },
      resolveFile: () => `tests/integration/${name}`,
    })
  }

  return entries
}

/**
 * 登记完整性：**「这条登记指向的东西还在不在」**。
 *
 * 与「豁免合法」是两件事，所以分开判：
 *   · `expected: "pass"` 的集成文件登记、`shard-weight` 的权重、对抗基线的 `cases[*].file`
 *     都**不是豁免**（没放行任何红），但都会腐烂 —— 文件改名/删了，登记就变成一条对不上任何东西的行。
 *     它们不需要 reason/到期日，只需要「还指得着」。
 */
function checkRegistrations() {
  const rows = []
  const integration = readJson('tests/integration-baseline.json', { required: false }) ?? {}
  for (const [name, entry] of Object.entries(integration.files ?? {})) {
    if (!exists(`tests/integration/${name}`)) {
      rows.push({ file: 'tests/integration-baseline.json', key: name, message: `登记了 \`${name}\`，但 tests/integration/ 下没有它 —— 改名/删除后没人回来清，这条登记从此对不上任何文件` })
    }
    if (!['pass', 'known-red'].includes(entry?.expected)) {
      rows.push({ file: 'tests/integration-baseline.json', key: name, message: `\`expected\` 只能是 pass / known-red，实际是 ${JSON.stringify(entry?.expected)} —— 判不出「应该是什么状态」，比对就静默放过它` })
    }
  }
  const adversarial = readJson('tests/adversarial/baseline.json', { required: false }) ?? {}
  for (const [id, entry] of Object.entries(adversarial.cases ?? {})) {
    if (!entry?.file) rows.push({ file: 'tests/adversarial/baseline.json', key: id, message: '缺 `file`：不知道这条用例是哪个文件，跑都没法跑' })
    else if (!exists(`tests/adversarial/cases/${entry.file}`)) {
      rows.push({ file: 'tests/adversarial/baseline.json', key: id, message: `case 文件 \`${entry.file}\` 不存在（tests/adversarial/cases/ 下没有）` })
    }
    if (!['green', 'known-defect'].includes(entry?.verdict)) {
      rows.push({ file: 'tests/adversarial/baseline.json', key: id, message: `\`verdict\` 只能是 green / known-defect，实际是 ${JSON.stringify(entry?.verdict)}` })
    }
  }
  const weights = readJson('tests/integration-shard-weights.json', { required: false }) ?? {}
  for (const [name, entry] of Object.entries(weights.files ?? {})) {
    if (!Number.isFinite(Number(entry?.ms)) || Number(entry.ms) <= 0) {
      rows.push({ file: 'tests/integration-shard-weights.json', key: name, message: `\`ms\` 必须是正数（实际 ${JSON.stringify(entry?.ms)}）—— 分片均衡会按 0 估重，那个文件就成了分片里的黑洞` })
    }
  }
  return rows
}

// ─────────────────────────── 工单状态（「指向已关闭的 issue」） ───────────────────────────

/** 本地 / CI 都可能从多个仓库跑：从 `origin` 的 URL 里取 `owner/repo`，让 `gh issue view` 落到**本仓**。
 *  不取的话，`gh` 会用它自己配置的默认仓库 —— 本地实测就撞上过「默认仓库 issues 已关闭」，
 *  于是所有引用都被判成「未核实」。这是**判据的输入搞错了地方**，必须钉住。 */
function repoFromOrigin() {
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: ROOT, encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    const match = url.match(/github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/)
    return match ? match[1] : ''
  } catch {
    return ''
  }
}

/**
 * 工单状态只用来判一件事：**承接单已关闭 = 这件事应该结案，豁免必须删**。
 *
 * 抓不到状态（没网 / 没 `GH_TOKEN` / gh 不在）**不判红**，但也绝不静默 —— 打印「未核实 N 条」，
 * 并且 `--strict`（CI 用它）下改判**环境失败 exit 2**：不是「条目有问题」，而是「这道判据今天没在工作」。
 * 两件事分开，才分得清该改条目还是该修 CI。
 */
function fetchIssueStates(opts, refs) {
  const wanted = [...new Set(refs.map(issueNumber).filter((n) => n !== null))]
  if (wanted.length === 0) return { states: new Map(), source: 'none', missing: [] }
  if (opts.noIssues) return { states: new Map(), source: 'disabled', missing: wanted }
  if (opts.issueStates) {
    const raw = readJson(opts.issueStates, { required: true }) ?? {}
    const states = new Map()
    for (const [key, value] of Object.entries(raw)) {
      const n = issueNumber(key) ?? (Number.isFinite(Number(key)) ? Number(key) : null)
      if (n !== null) states.set(n, String(value?.state ?? value).toLowerCase())
    }
    return { states, source: opts.issueStates, missing: wanted.filter((n) => !states.has(n)) }
  }
  const states = new Map()
  const missing = []
  const repo = opts.repo || repoFromOrigin()
  for (const n of wanted) {
    try {
      const args = ['issue', 'view', String(n), '--json', 'state']
      if (repo) args.push('--repo', repo)
      const out = execFileSync('gh', args, {
        encoding: 'utf8',
        timeout: 20_000,
        stdio: ['ignore', 'pipe', 'ignore'],
        env: process.env,
      })
      const parsed = JSON.parse(out)
      states.set(n, String(parsed.state ?? '').toLowerCase())
    } catch {
      missing.push(n)
    }
  }
  return { states, source: process.env.GH_TOKEN ? 'gh(GH_TOKEN)' : 'gh', missing }
}

// ─────────────────────────── 报告 ───────────────────────────

/** report() 里算过的登记完整性问题，主流程用它决定退出码（不重复扫一遍文件） */
let summaryRegistrations = []

const FILE_OF = Object.fromEntries(Object.entries(KIND_SPECS).map(([kind, spec]) => [kind, spec.file]))

function report(entries, results, issueInfo, opts) {
  const summary = summarize(results)
  // 六份文件**全部列出**（哪怕 0 条）：空表要看得见，否则「这个文件没有豁免」和「这个文件没人检查」长得一样
  const byFile = new Map()
  for (const spec of Object.values(KIND_SPECS)) byFile.set(spec.file, { total: 0, exemptions: 0, illegal: 0, expiring: 0 })
  for (const result of results) {
    const file = FILE_OF[result.kind] ?? '(未知)'
    const bucket = byFile.get(file) ?? { total: 0, exemptions: 0, illegal: 0, expiring: 0 }
    bucket.total += 1
    if (result.exemption) bucket.exemptions += 1
    if (!result.ok) bucket.illegal += 1
    if (result.status === 'expiring') bucket.expiring += 1
    byFile.set(file, bucket)
  }

  console.log(`\n${'='.repeat(78)}\n== 豁免登记契约（exemption contract，今天 ${opts.now}）\n${'='.repeat(78)}`)
  console.log('豁免不是「先这样」的收据，是一张**有期限的欠条**：必须写清为什么、凭据、谁承接、最晚哪天复审。\n')

  const lines = []
  for (const [file, bucket] of [...byFile.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push([file, String(bucket.total), String(bucket.exemptions), String(bucket.illegal), String(bucket.expiring)])
  }
  const head = ['登记文件', '登记数', '其中豁免', '非法', '≤14 天到期']
  /** 终端里中日韩字符占两格：按显示宽度补齐，否则表格会歪（歪掉的表格没人读） */
  const width = (text) => [...String(text)].reduce((sum, ch) => sum + (/[\u1100-\uFFE6]/.test(ch) ? 2 : 1), 0)
  const widths = head.map((cell, index) => Math.max(width(cell), ...lines.map((row) => width(row[index] ?? ''))))
  const pad = (text, size) => `${text}${' '.repeat(Math.max(0, size - width(text)))}`
  console.log(head.map((cell, index) => pad(cell, widths[index])).join('  '))
  console.log(widths.map((size) => '─'.repeat(size)).join('  '))
  for (const row of lines) console.log(row.map((cell, index) => pad(cell, widths[index])).join('  '))
  console.log(
    `\n合计登记 ${summary.total} 条，其中「真的放行了某件事」的豁免 ${summary.exemptions} 条；` +
      `非法 ${summary.illegal} 条${summary.expiring ? `，≤14 天到期 ${summary.expiring} 条` : ''}`,
  )

  if (summary.illegal) {
    console.log('\n-- 非法条目（每一条都要么补齐、要么删掉） --')
    for (const result of summary.worst) {
      console.log(`\n  ✗ [${result.kind}] ${result.key}`)
      for (const problem of result.problems) console.log(`      · ${problem.code}：${problem.message}`)
    }
  }

  if (summary.nearestExpiry.length) {
    console.log('\n-- 最接近到期（到期后本门禁就红，不许「先放一放」） --')
    for (const item of summary.nearestExpiry) {
      const tail = item.daysLeft < 0 ? `已逾期 ${-item.daysLeft} 天` : `${item.daysLeft} 天后到期`
      console.log(`  ${String(item.reviewAfter).padEnd(12)} ${String(item.daysLeft).padStart(5)} 天  [${item.kind}] ${item.key}（${tail}）`)
    }
  }

  const codes = Object.entries(summary.byCode).sort((a, b) => b[1] - a[1])
  if (codes.length) {
    console.log('\n-- 问题分布 --')
    for (const [code, count] of codes) console.log(`  ${String(count).padStart(3)} × ${code}`)
  }

  const registrations = checkRegistrations()
  summaryRegistrations = registrations
  console.log(`\n-- 登记完整性（不指向任何文件 / 值不合法的行） --`)
  if (registrations.length === 0) console.log('  ✅ 每一条登记都还指着一个存在的文件，取值也合法')
  else for (const row of registrations) console.log(`  ✗ ${row.file} → ${row.key}：${row.message}`)

  const verified = [...issueInfo.states.entries()]
  console.log(
    `\n工单状态：来源 ${issueInfo.source}；核实 ${verified.length} 个${issueInfo.missing.length ? `；**未核实 ${issueInfo.missing.length} 个（${issueInfo.missing.map((n) => `#${n}`).join(' ')}）**` : ''}`,
  )
  if (issueInfo.missing.length) {
    console.log('  未核实 ≠ 已通过：它只说明「承接单是否已关闭」这件事今天没查。CI 里用 --strict（缺凭据 → exit 2）。')
  }
  return summary
}

/** 把「只增不减」这件事摆到台面上（不设上限，只让它显形 + 可归因） */
function reportTrend(current, ledger) {
  const snapshots = Array.isArray(ledger?.snapshots) ? ledger.snapshots : []
  if (snapshots.length === 0) {
    console.log(`\n趋势：${LEDGER_FILE} 还没有快照（--record 写下第一份后，下一轮就能看出「谁又加了一条」）。`)
    return null
  }
  const previous = snapshots[snapshots.length - 1]
  const diff = diffSnapshots(previous, current)
  const sign = (n) => (n > 0 ? `+${n}` : String(n))
  console.log(
    `\n趋势（对比 ${previous.today} 的快照）：豁免总数 ${diff.totalBefore} → ${diff.totalAfter}（${sign(diff.totalAfter - diff.totalBefore)}）`,
  )
  for (const row of diff.rows) {
    if (row.before === 0 && row.after === 0) continue
    const delta = row.delta === 0 ? '持平' : sign(row.delta)
    console.log(`  ${row.kind.padEnd(26)} ${String(row.before).padStart(3)} → ${String(row.after).padStart(3)}（${delta}）`)
    for (const key of row.added) console.log(`      + 新增：${key}`)
    for (const key of row.removed) console.log(`      - 移除：${key}`)
  }
  if (diff.totalAfter > diff.totalBefore) {
    console.log('  新增条目已经点名在上面 —— 加一条豁免是一次**决定**，不是一次编辑；review 时照着这张名单问「为什么它可以不修」。')
  }
  return diff
}

// ─────────────────────────── 自证 ───────────────────────────

/**
 * 反例自检：**机制必须先能判自己的坏输入**（第 4 条「能自我证伪」）。
 * 这里造 6 类坏条目 + 1 条合法条目，逐个过 `validateEntry`，任何一个没被拒都 exit 1。
 *
 * 用 `--selftest` 单独跑，不依赖仓库现状（所以它不随「今天有几条真豁免」变化）。
 */
function selftest() {
  const today = '2026-11-25'
  const base = {
    reason: '集成层 upstream-html 在标准产物下仍返回半截 HTML：契约要求整页折叠，产品未做到，属真实产品缺陷（C 类）。',
    evidence: '2026-11-19 实测 FAIL 12.4s，日志见 #432 附件；--baseline 复跑同样红',
    followUp: '#432',
    addedAt: '2026-11-19',
    reviewAfter: '2027-01-31',
    lastRedAt: '2026-11-24',
  }
  const cases = [
    {
      id: 'S1 缺 reason',
      kind: 'integration-known-red',
      entry: { ...base, reason: '' },
      expect: PROBLEM.MISSING_REASON,
    },
    {
      id: 'S1b reason 是占位句',
      kind: 'integration-known-red',
      entry: { ...base, reason: '（待补：写清这是什么重复、什么时候删）' },
      expect: PROBLEM.PLACEHOLDER_REASON,
    },
    {
      id: 'S2 已过期',
      kind: 'integration-known-red',
      entry: { ...base, reviewAfter: '2026-11-24' },
      expect: PROBLEM.EXPIRED,
    },
    {
      id: 'S2b 到期日远到等于没有',
      kind: 'integration-known-red',
      entry: { ...base, reviewAfter: '2029-12-31' },
      expect: PROBLEM.WINDOW_TOO_LONG,
    },
    {
      id: 'S3 已跑绿',
      kind: 'integration-known-red',
      entry: { ...base, lastObserved: 'pass', lastObservedAt: '2026-11-25' },
      expect: PROBLEM.FIXED,
    },
    {
      id: 'S3b 隔离之后又跑绿（flaky）',
      kind: 'flaky-quarantine',
      entry: {
        reason: '首帧竞态：同一台 runner 上失败一次、重跑绿，属时序 flake，已改成等终态待验证。',
        followUp: '#406',
        quarantinedAt: '2026-11-20',
        lastGreen: '2026-11-24T02:00:00.000Z',
        reviewAfter: '2026-12-20',
      },
      expect: PROBLEM.FIXED,
    },
    {
      id: 'S4 指向已关闭的 issue',
      kind: 'integration-known-red',
      entry: { ...base, followUp: '#386' },
      expect: PROBLEM.FOLLOWUP_CLOSED,
      issueStates: new Map([[386, 'closed']]),
    },
    {
      id: 'S5 拿环境问题顶包',
      kind: 'integration-known-red',
      entry: { ...base, reason: '本机没有 dist-standard，产物缺失跑不了，先允许它红。' },
      expect: PROBLEM.ENV_AS_EXEMPTION,
    },
    {
      id: 'S6 对象文件已经不在了',
      kind: 'integration-known-red',
      entry: base,
      expect: PROBLEM.DEAD_ENTRY,
      exists: () => false,
    },
    {
      id: 'S7 声称还红但 60 天没人实跑',
      kind: 'integration-known-red',
      entry: { ...base, lastRedAt: '2026-08-01' },
      expect: PROBLEM.STALE_OBSERVATION,
    },
    {
      id: 'S8 缺承接单',
      kind: 'integration-known-red',
      entry: { ...base, followUp: '' },
      expect: PROBLEM.MISSING_FOLLOWUP,
    },
  ]

  let failed = 0
  console.log(`\n== 自证：坏条目必须被判非法（今天 = ${today}）\n`)
  for (const item of cases) {
    const result = validateEntry({
      kind: item.kind,
      key: item.id,
      entry: item.entry,
      today,
      issueStates: item.issueStates ?? new Map(),
      exists: item.exists ?? (() => true),
      resolveFile: () => 'tests/integration/x.test.mjs',
    })
    const hit = result.problems.some((problem) => problem.code === item.expect)
    if (!hit) {
      failed += 1
      console.log(`  ✗ ${item.id}：**没有被判非法**（期望命中 ${item.expect}，实际 ${result.problems.map((p) => p.code).join(',') || '无问题'}）`)
    } else {
      const problem = result.problems.find((p) => p.code === item.expect)
      console.log(`  ✔ ${item.id} → exit 1 依据「${problem.code}」：${problem.message.slice(0, 76)}…`)
    }
  }

  const good = validateEntry({
    kind: 'integration-known-red',
    key: 'S0 合法条目',
    entry: base,
    today,
    issueStates: new Map([[432, 'open']]),
    exists: () => true,
    resolveFile: () => 'tests/integration/x.test.mjs',
  })
  if (!good.ok) {
    failed += 1
    console.log(`  ✗ S0 合法条目被误杀：${good.problems.map((p) => p.code).join(',')}`)
  } else {
    console.log(`  ✔ S0 合法条目被放行（剩 ${good.daysLeft} 天到期）—— 「必红」不是「恒红」`)
  }

  // 第 7 条的另一半：**不是豁免的东西不该被套到期日**（分片权重只影响均衡度）
  const weight = validateEntry({
    kind: 'shard-weight',
    key: 'caps.test.mjs',
    entry: { ms: 2959, addedAt: '2026-11-20', reviewAfter: '2026-11-20' },
    today,
    exists: () => true,
    resolveFile: () => 'tests/integration/caps.test.mjs',
  })
  if (weight.exemption || [PROBLEM.EXPIRED, PROBLEM.MISSING_REVIEW_AFTER].some((code) => weight.problems.some((p) => p.code === code))) {
    failed += 1
    console.log('  ✗ S9 分片权重被当成豁免套了到期判据（它不放行任何红，不该有到期日）')
  } else {
    console.log('  ✔ S9 分片权重不被当成豁免（`exemption: false`，只做登记完整性）—— 机制没有无差别乱套')
  }

  console.log(failed === 0 ? `\n自证通过：${cases.length} 类坏输入全部被判非法，1 条合法条目放行、1 条非豁免不被误伤 ✅` : `\n自证失败：${failed} 条没被拒 ❌`)
  return failed === 0 ? 0 : 1
}

// ─────────────────────────── 主流程 ───────────────────────────

function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.selftest) return selftest()

  const entries = collect()
  const issueInfo = fetchIssueStates(opts, entries.map((item) => issueRefOf(item.entry)))
  const results = entries.map((item) =>
    validateEntry({
      kind: item.kind,
      key: item.key,
      entry: item.entry,
      today: opts.now,
      issueStates: issueInfo.states,
      exists,
      resolveFile: item.resolveFile,
    }),
  )

  const ledger = readJson(LEDGER_FILE, { required: false })
  const summary = report(entries, results, issueInfo, opts)
  const snapshot = buildSnapshot({ today: opts.now, results, note: `check-test-exemptions @ ${opts.now}` })
  const diff = reportTrend(snapshot, ledger)
  if (opts.record) {
    const snapshots = [...((ledger?.snapshots ?? [])), snapshot].slice(-LEDGER_KEEP)
    writeFileSync(abs(LEDGER_FILE), `${JSON.stringify({ version: 1, note: '豁免总数快照（只追加）。由 scripts/check-test-exemptions.mjs --record 写入；用途：让「豁免只增不减」显形，不设上限。', snapshots }, null, 2)}\n`, 'utf8')
    console.log(`\n已把本次快照追加进 ${LEDGER_FILE}（共 ${snapshots.length} 份）`)
  }

  if (opts.json) {
    writeFileSync(
      path.resolve(opts.json),
      `${JSON.stringify({ today: opts.now, summary, results, issue: { source: issueInfo.source, missing: issueInfo.missing }, trend: diff }, null, 2)}\n`,
      'utf8',
    )
    console.log(`\n--json 已写入 ${opts.json}`)
  }

  if (summaryRegistrations.length > 0) {
    console.log(`\n结论：❌ 有 ${summaryRegistrations.length} 条登记对不上任何文件 —— 登记也是账，账要能兑。`)
    return 1
  }
  if (summary.illegal > 0) {
    console.log('\n结论：❌ 有非法豁免条目 —— 豁免必须带证据 + 承接单 + 到期日，并且条件不成立时自己红。')
    return 1
  }
  if (issueInfo.missing.length > 0 && opts.strict) {
    console.log(
      `\n结论：❌ 环境不具备 —— --strict 下必须核实承接单状态，但有 ${issueInfo.missing.length} 个没核实到` +
        `（gh 不可用 / 无 GH_TOKEN / 网络）。这不是条目有问题，是**这条判据今天没在工作**，先修它。`,
    )
    return 2
  }
  console.log('\n结论：✅ 所有豁免条目都合法、未过期，且没有「已经修好还挂着」的条目。')
  return 0
}

try {
  process.exitCode = main()
} catch (error) {
  console.error(error?.stack ?? String(error))
  process.exitCode = 2
}
