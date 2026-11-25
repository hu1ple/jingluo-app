/** `pnpm run check:capabilities` —— #209 的盘点闸门（**默认档 = 有账期的拦截**）。
 *
 * 三件事，按顺序：
 *
 * 1. 遍历 `src/**`，把同一份源码喂给三个**纯判定**模块（三层结构的第三层就是这里：
 *    判定在 `scripts/lib/*.mjs`，CLI 只遍历 + 汇总 + 打印）；
 * 2. 类别 4（行为 / 布局）读 `docs/ui/209-behavior/*.json` 的真实测量快照，
 *    缺文件只报「未采集」—— 采集要模拟器，缺文件是环境状态，不是代码问题，**不算失败**；
 * 3. 汇总出「总命中 / 各类缺陷数 / 有缺陷的 `文件:行` 清单 / 指向对应 docs」。
 *
 * ## 分级：什么拦、什么只提示
 *
 * 判据只有一条 —— **改错之后有多难挽回**：
 *
 * | 情形 | 档位 | 依据 |
 * | --- | --- | --- |
 * | 缺陷**没记账** | **红（默认就红）** | 新引入的低内核用法在构建期、在高版本设备上都看不见，发出去才炸 |
 * | 缺陷**记了账且未到期** | 提示 | 已有人认领、有到期日，见 `scripts/audit-debt/check-capabilities.json` |
 * | 缺陷**记了账但已到期** | **红（默认就红）** | 豁免会过期：没有期限的容忍 = 永久放弃 |
 * | 缺陷数比账面**少** | 提示 | 别人修好了，改账本的人未必是修的人 —— 正确改动不许红 |
 * | 类别 4 快照缺失 | 提示 | 采集要模拟器，缺文件是环境状态 |
 *
 * 2026-11 之前的版本是「默认永远 exit 0，`--strict` 才 exit 1」，注释写着「等 6 条 lane 落地后
 * 再接 CI」—— **没有日期**。实测那一档挂了 10 处真实缺陷（5 处 `scrollbar-gutter` 无兜底、
 * 5 处「依赖 fetch 是本尊」）常年只打印不拦，唯一产出是让人以为有人在看。现在改成记账制：
 * 已知的 10 处进账本（带到期日），**新增的一处没登记就红**，到期的也红。
 *
 * `--strict` 仍然保留（缺陷数 > 0 就 exit 1，不看账本），给「缺陷清零后把它拧成绝对档」用；
 * 但**不再是**唯一会红的情形 —— 默认档就会咬。
 *
 * ## 扫描范围（与既有门禁保持一致）
 *
 * - 类别 1 / 2：`src/**` 全部文本源文件（`.ts .tsx .js .mjs .cjs .jsx .css .html .md`）；
 *   CSS 与 Markdown 对 API 判定会被整篇抹空，所以多喂进去不会造成假阳性。
 * - 类别 2 的 CSS 范围包含**普通 `.css`**，不只是 `*.module.css` —— #217 把 `check:gap`
 *   扩到全部 `.css` 之后，两个门禁必须是同一个范围，否则同一份源码会被两套口径判成两个结论。
 * - 类别 3：`.ts .tsx .js .mjs .cjs .jsx .html`（与 `docs/capabilities/host.md` 的 190 文件口径同源）。
 * - 类别 4：`docs/ui/209-behavior/*.json` 里带 `width` 字段的测量快照（`before-summary.json` 这类
 *   派生文件没有 `width`，自动跳过）。
 *
 * ## 退出码
 *
 * - `0`：没有未记账缺陷、没有到期债（可以有「已记账且在账期内」的缺陷）
 * - `1`：有未记账缺陷 / 有到期债 / 账本形状不合规；`--strict` 下任何缺陷都算
 * - `2`：用法 / 环境错误（未知参数、`src/` 下一个文件都没扫到）
 *
 * ## 已知边界
 *
 * - 只统计静态审计能看见的东西：动态取用（`Reflect.get(o, 'at')`）、第三方 chunk、
 *   构建期产物都不在内（详见 `docs/capabilities/api.md` 的「已知边界」）。
 * - 「缺陷」的口径是各模块自己的结论，不在这里二次判定：类别 1 `uncovered`、类别 2
 *   `defect` / `false-positive`、类别 3 `真实漏洞`、类别 4 `不成立`；其余（`entry-polyfill`、
 *   `covered`、`degraded`、`无风险`、`需动态验证`、`成立`、`未测`）都**不算**缺陷。
 *
 * ## 自证
 *
 * `node scripts/check-capabilities.mjs --selftest`：造一份**故意违规**的 fixture（低内核 API +
 * 无兜底 CSS），断言它被判红并且点名 `文件:行`；再断言「记账后不红、到期后必红」。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { auditApiAssumptions, summarize as summarizeApi } from './lib/apiAssumptionAudit.mjs'
import { VERDICT_TEXT as CSS_VERDICT_TEXT, auditCssAssumptions } from './lib/cssAssumptionAudit.mjs'
import { auditHostCapabilities } from './lib/hostCapabilityAudit.mjs'
import { isVendored } from './lib/vendoredPaths.mjs'
import { VERDICT as BEHAVIOR_VERDICT, auditBehaviorAssumptions } from './lib/behaviorAssumptionAudit.mjs'
import { debtSummary, loadDebt, renderSelftest, settleDebt, todayStr } from './lib/auditDebt.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..')
const BEHAVIOR_DIR = path.join('docs', 'ui', '209-behavior')

const DOCS = {
  api: 'docs/capabilities/api.md',
  css: 'docs/capabilities/css.md',
  host: 'docs/capabilities/host.md',
  behavior: 'docs/capabilities/behavior.md',
}

const LABELS = {
  api: '类别 1  JS 内置 API / 语言特性',
  css: '类别 2  CSS 特性 / @supports',
  host: '类别 3  平台与宿主能力',
  behavior: '类别 4  行为 / 布局假设',
}

/** 扫描的扩展名：`.md` 只为了文件数口径与 `docs/capabilities/api.md` 对齐，判定模块会整篇抹空 */
const EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx', '.css', '.html', '.md']
const SCRIPT_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx', '.html'])
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.git'])

export const USAGE = `用法：node scripts/check-capabilities.mjs [选项]

  （默认档）             未记账缺陷 / 到期债 → exit 1；已记账且在账期内的缺陷只提示
  --strict               任何缺陷都 exit 1（不看账本；缺陷清零后可用它）
  --root <dir>           换一个仓库根（默认本仓；测试与 --selftest 用它注入 fixture）
  --behavior-dir <dir>   换一个类别 4 测量快照目录（默认 <root>/docs/ui/209-behavior）
  --json                 只输出机器可读报告（PR 里的数字全从这抄）
  --selftest             自带负向对照：故意违规必须被拦，记账后必须不拦，到期必须再拦
  --help                 就是这段
`

class UsageError extends Error {}

const toPosix = (file) => file.split('\\').join('/')

/** 递归收集文本源文件，返回 `{ path, ext, text }`，`path` 是相对仓库根的 POSIX 路径 */
export const collectSources = (srcDir, root) => {
  const files = []
  const walk = (dir) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      // vendored 第三方目录不进我们的能力盘点（#417），名单见 scripts/lib/vendoredPaths.mjs
      if (isVendored(full)) continue
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
        walk(full)
        continue
      }
      if (!entry.isFile()) continue
      const ext = path.extname(entry.name).toLowerCase()
      if (!EXTENSIONS.includes(ext)) continue
      files.push({ path: toPosix(path.relative(root, full)), ext, text: fs.readFileSync(full, 'utf8') })
    }
  }
  if (fs.existsSync(srcDir)) walk(srcDir)
  return files
}

/** 类别 4 的输入：带 `width` 的测量快照。没有就报「未采集」，不抛错、不算失败 */
export const loadBehaviorInput = (dir, root) => {
  const shown = toPosix(path.relative(root, dir)) || dir
  if (!fs.existsSync(dir)) {
    return { dir: shown, status: 'not-collected', measurements: [], skipped: [], reason: `${shown} 不存在` }
  }
  const measurements = []
  const skipped = []
  for (const name of fs.readdirSync(dir).sort()) {
    if (!name.toLowerCase().endsWith('.json')) continue
    let parsed
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))
    } catch {
      skipped.push(name)
      continue
    }
    const width = parsed?.width
    if (typeof width !== 'string' && typeof width !== 'number') {
      skipped.push(name)
      continue
    }
    measurements.push(parsed)
  }
  if (measurements.length === 0) {
    return { dir: shown, status: 'not-collected', measurements, skipped, reason: `${shown} 里没有带 width 的测量快照` }
  }
  return { dir: shown, status: 'collected', measurements, skipped, reason: '' }
}

/** 跑完四类盘点，返回报告对象（`--json` 直接打印它） */
export const auditAll = ({ root = REPO_ROOT, behaviorDir } = {}) => {
  const sources = collectSources(path.join(root, 'src'), root)
  const scriptSources = sources.filter((source) => SCRIPT_EXTENSIONS.has(source.ext))

  const apiResult = auditApiAssumptions(sources.map((source) => ({ path: source.path, text: source.text })))
  const cssResult = auditCssAssumptions(sources.map((source) => ({ path: source.path, content: source.text })))
  // 类别 3 的范围限定在脚本 / HTML（`host.md` 的口径），CSS 与 Markdown 里的同名文字不是调用点
  const hostResult = auditHostCapabilities(scriptSources.map((source) => ({ file: source.path, text: source.text })))
  const behaviorInput = loadBehaviorInput(behaviorDir ?? path.join(root, BEHAVIOR_DIR), root)
  const behaviorResult =
    behaviorInput.status === 'collected'
      ? auditBehaviorAssumptions(behaviorInput.measurements)
      : { findings: [], summary: { assumptionCount: 4, holds: 0, falsified: 0, untested: 4, widths: [], issuesToOpen: [] } }

  // 账目 id = 类别 | 文件 | 能力名。**故意不含行号**：行号会随正确改动漂移，拿它当账目 id
  // 就退化成「钉死现状」—— 挪一行代码会让整本账失真（这一族最典型的老毛病）。
  const apiDefects = apiResult.hits
    .filter((hit) => hit.verdict === 'uncovered')
    .map((hit) => ({
      category: 'api',
      key: `api|${hit.file}|${hit.api}`,
      file: hit.file,
      line: hit.line,
      label: `${hit.api} 存在（首支持 Chromium ${hit.firstSupported}，无兜底）`,
    }))
  const cssDefects = cssResult.hits
    .filter((hit) => hit.verdict === 'defect' || hit.verdict === 'false-positive')
    .map((hit) => ({
      category: 'css',
      key: `css|${hit.file}|${hit.feature}`,
      file: hit.file,
      line: hit.line,
      label: `${hit.feature} —— ${CSS_VERDICT_TEXT[hit.verdict]}：${hit.reason}`,
    }))
  const hostDefects = hostResult.hits
    .filter((hit) => hit.verdict === '真实漏洞')
    .map((hit) => ({
      category: 'host',
      key: `host|${hit.file}|${hit.capability}`,
      file: hit.file,
      line: hit.line,
      label: hit.reason ? `${hit.capability}（风险${hit.risk}）：${hit.reason}` : `${hit.capability}（风险${hit.risk}）`,
    }))
  const behaviorDefects = behaviorResult.findings
    .filter((finding) => finding.verdict === BEHAVIOR_VERDICT.falsified)
    .map((finding) => ({
      category: 'behavior',
      key: `behavior|-|${finding.assumption}`,
      file: null,
      line: null,
      label: `${finding.assumption} 被实测证伪`,
    }))

  const apiSummary = summarizeApi(apiResult)
  const categories = {
    api: {
      label: LABELS.api,
      docs: DOCS.api,
      files: apiSummary.filesScanned,
      hits: apiSummary.total,
      byVerdict: apiSummary.byVerdict,
      defects: apiDefects.length,
    },
    css: {
      label: LABELS.css,
      docs: DOCS.css,
      files: cssResult.summary.files,
      filesWithHits: cssResult.summary.filesWithHits,
      hits: cssResult.summary.hits,
      byVerdict: cssResult.summary.byVerdict,
      byRisk: cssResult.summary.byRisk,
      hitFiles: [...new Set(cssResult.hits.map((hit) => hit.file))].sort(),
      defects: cssDefects.length,
    },
    host: {
      label: LABELS.host,
      docs: DOCS.host,
      files: hostResult.summary.files,
      hits: hostResult.summary.total,
      byVerdict: hostResult.summary.byVerdict,
      byRisk: hostResult.summary.byRisk,
      needsDynamic: hostResult.summary.needsDynamic.length,
      defects: hostDefects.length,
    },
    behavior: {
      label: LABELS.behavior,
      docs: DOCS.behavior,
      status: behaviorInput.status,
      dir: behaviorInput.dir,
      reason: behaviorInput.reason,
      skipped: behaviorInput.skipped,
      widths: behaviorResult.summary.widths,
      hits: behaviorResult.findings.length,
      byVerdict: { 成立: behaviorResult.summary.holds, 不成立: behaviorResult.summary.falsified, 未测: behaviorResult.summary.untested },
      findings: behaviorResult.findings.map((finding) => ({ assumption: finding.assumption, verdict: finding.verdict })),
      defects: behaviorDefects.length,
    },
  }

  const defectHits = [...apiDefects, ...cssDefects, ...hostDefects, ...behaviorDefects]
  const byExtension = {}
  for (const source of sources) byExtension[source.ext] = (byExtension[source.ext] ?? 0) + 1

  return {
    issue: 209,
    strict: false,
    scanned: {
      total: sources.length,
      byExtension,
      files: { css: sources.filter((source) => source.ext === '.css').map((source) => source.path) },
      scope: { api: sources.length, css: sources.length, host: scriptSources.length },
    },
    categories,
    defectHits,
    totals: {
      staticHits: categories.api.hits + categories.css.hits + categories.host.hits,
      behaviorFindings: categories.behavior.hits,
      hits: categories.api.hits + categories.css.hits + categories.host.hits + categories.behavior.hits,
      defects: defectHits.length,
    },
  }
}

/** 中文按两格宽算，否则中文表头会跟数字对不齐 */
const cjkWidth = (text) => {
  let width = 0
  for (const char of text) width += /[\u3000-\u9fff\uff00-\uffef]/u.test(char) ? 2 : 1
  return width
}

const column = (text, width) => text + ' '.repeat(Math.max(0, width - cjkWidth(text)))

const countText = (value) => (Number.isFinite(value) ? String(value) : '—')

const formatCategoryLine = (report) => {
  const { api, css, host, behavior } = report.categories
  const behaviorHits = behavior.status === 'collected' ? String(behavior.hits) : '—'
  const behaviorNote =
    behavior.status === 'collected'
      ? `缺陷 ${behavior.defects}（成立 ${behavior.byVerdict.成立} / 不成立 ${behavior.byVerdict.不成立} / 未测 ${behavior.byVerdict.未测}）`
      : `未采集（${behavior.reason}，不算失败）`
  const rows = [
    [api.label, `命中 ${countText(api.hits)}`, `缺陷 ${api.defects}（uncovered 裸调用无兜底）`, api.docs],
    [
      css.label,
      `命中 ${countText(css.hits)}`,
      `缺陷 ${css.defects}（真实缺陷 ${css.byVerdict.defect ?? 0} + 探测假阳性 ${css.byVerdict['false-positive'] ?? 0}）`,
      css.docs,
    ],
    [host.label, `命中 ${countText(host.hits)}`, `缺陷 ${host.defects}（真实漏洞；另有需动态验证 ${host.needsDynamic}）`, host.docs],
    [behavior.label, `命中 ${behaviorHits}`, behaviorNote, behavior.docs],
  ]
  const widths = [0, 1, 2].map((index) => Math.max(...rows.map((row) => cjkWidth(row[index]))) + 2)
  return rows.map((row) => row.slice(0, 3).map((cell, index) => column(cell, widths[index])).join('') + `→ ${row[3]}`)
}

/**
 * 每一类缺陷的「一句话事故」与「一条修复入口」。
 * 报错只给 `文件:行` 等于把判断留给读者；这里把「不修会怎样」和「下一步敲什么」一起印出来。
 */
const ACCIDENT = {
  api: '老内核（低于首支持版本）上这条调用直接抛 TypeError 或静默不生效 —— 构建期、高版本设备、单测全都看不见，只有真实用户的机器会白屏。',
  css: '低内核上这条样式整条作废，布局错位；构建期不报错，高版本设备也复现不出来，只有截图里能看出挤在一起。',
  host: '宿主把能力换掉或拿走后，这条通路**静默失效**：不报错、不降级，只是数据不再上报 / 功能不再触发，往往在排查真问题时才发现。',
  behavior: '文档写的布局假设已被实测证伪 —— 按它改代码会改错方向（假设本身错了，不是实现错）。',
}
const FIX_HINT = {
  api: '按 docs/capabilities/api.md 的「兜底写法」一节补兜底（`typeof X === "function"` 分支或降级路径），改完重跑本命令',
  css: '按 docs/capabilities/css.md 的「兜底写法」补 `@supports` / 渐进降级，改完重跑本命令',
  host: '按 docs/capabilities/host.md 改：要么加「宿主已替换」的检测，要么改成不强依赖本尊的调用方式',
  behavior: '按 docs/capabilities/behavior.md 重测并把结论写回文档（先改文档，再改代码方向）',
}

/**
 * 人读的报告。
 * `debt` 为 `null` 时只打印缺陷清单（`--selftest` / 单测直接调 formatReport 时用）。
 */
export const formatReport = (report, { strict = false, debt = null } = {}) => {
  const { scanned, categories, defectHits, totals } = report
  const extensions = Object.entries(scanned.byExtension)
    .sort((a, b) => b[1] - a[1])
    .map(([ext, count]) => `${ext} ${count}`)
    .join(' / ')

  const lines = [
    '#209 能力假设盘点（默认档：未记账缺陷 / 到期债 → exit 1）',
    '',
    `扫描范围：src/** 共 ${scanned.total} 个文件（${extensions}）`,
    `  类别 1 / 2 口径：全部 ${scanned.scope.api} 个（CSS、Markdown 对 API 判定整篇抹空）`,
    `  类别 3 口径：.ts/.tsx/.js/.mjs/.cjs/.jsx/.html 共 ${scanned.scope.host} 个（与 docs/capabilities/host.md 同源）`,
    categories.behavior.status === 'collected'
      ? `  类别 4 口径：${categories.behavior.dir}/*.json 的 ${categories.behavior.widths.length} 份测量快照（宽度 ${categories.behavior.widths.join(' / ')}）`
      : `  类别 4 口径：${categories.behavior.dir}/*.json —— 未采集`,
    '',
    ...formatCategoryLine(report),
    '',
    `总命中 ${totals.hits}（静态 ${totals.staticHits} + 行为 ${totals.behaviorFindings} 条假设结论）`,
    `各类缺陷数：api ${categories.api.defects} / css ${categories.css.defects} / host ${categories.host.defects} / behavior ${categories.behavior.defects} —— 合计 ${totals.defects}`,
    '',
  ]

  if (defectHits.length === 0) {
    lines.push('✅ 四类盘点都没有缺陷。')
    return lines.join('\n')
  }

  // 按账目 id 分组打印：同一处（同文件同能力）算一笔，行号只是「现在在哪」
  const grouped = new Map()
  for (const hit of defectHits) {
    const group = grouped.get(hit.key) ?? { ...hit, lines: [] }
    if (hit.file) group.lines.push(`${hit.file}:${hit.line}`)
    group.label = hit.label
    grouped.set(hit.key, group)
  }

  const settledKeys = new Set(debt ? debt.settled.map((item) => item.key) : [])
  const expiredKeys = new Set(debt ? debt.expired.map((item) => item.key) : [])
  const unregisteredKeys = new Set(debt ? debt.unregistered.map((item) => item.key) : [])

  const bucket = (keys) => [...grouped.values()].filter((group) => keys.has(group.key))
  const printBucket = (title, groups, note) => {
    if (!groups.length) return
    lines.push(`${title}（${groups.reduce((sum, item) => sum + item.lines.length, 0)} 处 / ${groups.length} 笔）：`)
    if (note) lines.push(`  ${note}`)
    for (const group of groups) {
      const entry = debt?.entries?.get?.(group.key)
      const where = group.lines.length ? group.lines.join('  ') : '（测量结论，无行号）'
      // 一行一条（`[类别] 文件:行  <判据>`）：紧凑、可 grep，也免得报错比缺陷本身还长
      lines.push(`  [${group.category}] ${where}  ${group.label}`)
      lines.push(`      事故：${ACCIDENT[group.category]}`)
      lines.push(`      修法：${FIX_HINT[group.category]}`)
      if (entry) {
        lines.push(
          `      账上：${entry.issue} 到期 ${entry.expires}（剩 ${entry.left} 天）—— ${entry.why}`,
        )
      }
    }
    lines.push('')
  }

  printBucket('❌ 未记账的缺陷（新增的、没人认领的）', bucket(unregisteredKeys), '这一档是本门禁真正的红：要么修掉，要么按下面的格式登记一笔债（带到期日 + 承接单号）。')
  printBucket('❌ 已到期（豁免会过期，过期即红）', bucket(expiredKeys), '修掉，或者带新理由续期 —— 续期也要 ≤ 90 天。')
  printBucket('⚠ 已记账、在账期内（不拦，但每跑一次都会提醒）', bucket(settledKeys))

  if (debt && debt.shrink.length) {
    lines.push(`ℹ 账面比实际多 ${debt.shrink.length} 笔（修好了但没销账 —— 提示，不判红）：`)
    for (const item of debt.shrink) {
      lines.push(`  ${item.key}  登记 ${item.registered}，实际 ${item.count}  → 从账本里删掉这行，或把 count 改成 ${item.count}`)
    }
    lines.push('')
  }

  if (strict) lines.push(`❌ --strict：${totals.defects} 处能力假设缺陷（不看账本），exit 1。`)
  else if (debt && (debt.unregistered.length || debt.expired.length))
    lines.push(`❌ exit 1：未记账 ${debt.unregistered.length} 笔 / 到期 ${debt.expired.length} 笔。`)
  return lines.join('\n')
}

const parseArgs = (argv) => {
  const options = {
    root: REPO_ROOT,
    behaviorDir: null,
    strict: false,
    json: false,
    help: false,
    selftest: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--strict') options.strict = true
    else if (arg === '--json') options.json = true
    else if (arg === '--selftest') options.selftest = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--root' || arg === '--behavior-dir') {
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) throw new UsageError(`${arg} 需要一个目录`)
      index += 1
      if (arg === '--root') options.root = path.resolve(value)
      else options.behaviorDir = path.resolve(value)
    } else throw new UsageError(`未知参数：${arg}`)
  }
  return options
}

/** 把缺陷清单汇总成账目 Map（`key -> {count, sample}`），结账用它 */
export const toActual = (defectHits) => {
  const actual = new Map()
  for (const hit of defectHits) {
    const item = actual.get(hit.key) ?? { count: 0, sample: hit.file ? `${hit.file}:${hit.line}` : '（无行号）' }
    item.count += 1
    actual.set(hit.key, item)
  }
  return actual
}

/**
 * `--selftest`：**故意做错必须被拦**。四拍：
 *   ① 干净 fixture → exit 0
 *   ② 塞一处低内核 API（`Promise.withResolvers`）+ 一处无兜底 CSS → **必须 exit 1**，且点名 `文件:行`
 *   ③ 把这两处记进账（临时账本，未到期）→ **必须回到 exit 0**（容忍在账期内的已知缺陷）
 *   ④ 同一本账，日期改成过期 → **必须再 exit 1**，且报「已到期」（这一拍是「豁免会过期」的证明）
 */
const selftest = () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'check-capabilities-selftest-'))
  const cases = []
  const run = (args, env = {}) => {
    const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
    })
    return { status: result.status, out: `${result.stdout ?? ''}${result.stderr ?? ''}` }
  }
  try {
    const srcDir = path.join(tmp, 'src')
    fs.mkdirSync(srcDir, { recursive: true })
    fs.writeFileSync(path.join(srcDir, 'clean.ts'), 'export const ok = 1\n', 'utf8')

    // ① 干净
    const clean = run(['--root', tmp])
    cases.push({ name: '① 干净 fixture 不拦', ok: clean.status === 0, detail: `exit ${clean.status}` })

    // ② 故意违规
    // 两种写法都要抓到：带泛型的调用形式曾经整条漏判（名字后必须紧跟 `(` 的规则），
    // 于是「门禁看起来在跑、命中数悄悄少一个」—— 这一拍专门钉住它。
    fs.writeFileSync(
      path.join(srcDir, 'probe.ts'),
      'export const a = Promise.withResolvers()\nexport const b = Promise.withResolvers<number>()\n',
      'utf8',
    )
    fs.writeFileSync(path.join(srcDir, 'probe.css'), '.x {\n  scrollbar-gutter: stable;\n}\n', 'utf8')
    const dirty = run(['--root', tmp, '--json'])
    const dirtyReport = JSON.parse(dirty.out.slice(dirty.out.indexOf('{')))
    const dirtyJson = run(['--root', tmp])
    cases.push({
      name: '② 故意塞违规 → 必须 exit 1',
      ok: dirtyJson.status === 1,
      detail: `exit ${dirtyJson.status}，缺陷 ${dirtyReport.totals.defects}`,
    })
    cases.push({
      name: '② 带泛型的调用形式（`withResolvers<T>()`）也必须算命中',
      ok: dirtyJson.out.includes('src/probe.ts:2') && dirtyReport.totals.defects === 3,
      detail: `缺陷 ${dirtyReport.totals.defects}`,
    })
    cases.push({
      name: '② 报错点名 `文件:行` 且给出修法',
      ok:
        /src\/probe\.(ts|css):\d+/.test(dirtyJson.out) &&
        dirtyJson.out.includes('事故：') &&
        dirtyJson.out.includes('修法：'),
      detail: /src\/probe\.(ts|css):\d+/.test(dirtyJson.out) ? '点了名' : '没点名',
    })

    // ③ 记账（未到期）→ 不拦
    const debtDir = path.join(tmp, 'scripts', 'audit-debt')
    fs.mkdirSync(debtDir, { recursive: true })
    const expires = todayStr(new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10))
    const entries = {}
    for (const [key, found] of toActual(dirtyReport.defectHits)) {
      entries[key] = { count: found.count, why: 'selftest：假装有人认领了', issue: '#0', expires }
    }
    fs.writeFileSync(
      path.join(debtDir, 'check-capabilities.json'),
      JSON.stringify({ gate: 'check-capabilities', entries }, null, 2),
      'utf8',
    )
    const booked = run(['--root', tmp])
    cases.push({ name: '③ 记账未到期 → 不拦（exit 0）', ok: booked.status === 0, detail: `exit ${booked.status}` })

    // ④ 到期 → 再拦
    const past = todayStr('2020-01-01')
    const expiredEntries = {}
    for (const key of Object.keys(entries)) {
      expiredEntries[key] = { ...entries[key], expires: past }
    }
    fs.writeFileSync(
      path.join(debtDir, 'check-capabilities.json'),
      JSON.stringify({ gate: 'check-capabilities', entries: expiredEntries }, null, 2),
      'utf8',
    )
    const expired = run(['--root', tmp], { AUDIT_TODAY: todayStr() })
    cases.push({
      name: '④ 账到期 → 必须 exit 1 且报「已到期」',
      ok: expired.status === 1 && expired.out.includes('已到期'),
      detail: `exit ${expired.status}`,
    })

    // ⑤ 新增一处没登记的缺陷 → 必须拦（账只减不增）
    const more = {}
    for (const key of Object.keys(entries)) more[key] = { ...entries[key] }
    fs.writeFileSync(
      path.join(debtDir, 'check-capabilities.json'),
      JSON.stringify({ gate: 'check-capabilities', entries: more }, null, 2),
      'utf8',
    )
    fs.writeFileSync(path.join(srcDir, 'extra.css'), '.y {\n  scrollbar-gutter: stable;\n}\n', 'utf8')
    const grew = run(['--root', tmp])
    cases.push({
      name: '⑤ 新增未登记缺陷 → 必须 exit 1',
      ok: grew.status === 1 && grew.out.includes('未记账'),
      detail: `exit ${grew.status}`,
    })

    // ⑥ 账本形状不合规（没有到期日）→ 必须拦
    fs.writeFileSync(
      path.join(debtDir, 'check-capabilities.json'),
      JSON.stringify({ gate: 'check-capabilities', entries: { 'css|x|1': { why: '无期限', issue: '#0' } } }, null, 2),
      'utf8',
    )
    const shapeless = run(['--root', tmp])
    cases.push({
      name: '⑥ 没有到期日的账本 → 必须 exit 1（永久豁免不存在）',
      ok: shapeless.status === 1 && shapeless.out.includes('expires'),
      detail: `exit ${shapeless.status}`,
    })
  } catch (error) {
    cases.push({ name: 'selftest 自身抛错', ok: false, detail: error.message })
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
  return renderSelftest('check:capabilities', cases)
}

/** 真正的入口（测试也可以直接调，不必起进程） */
export const main = (argv) => {
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`check:capabilities 参数错误：${error.message}\n\n${USAGE}`)
      return 2
    }
    throw error
  }
  if (options.help) {
    console.log(USAGE)
    return 0
  }
  if (options.selftest) return selftest() ? 0 : 1

  const report = auditAll(options)
  if (report.scanned.total === 0) {
    console.error(`check:capabilities 在 ${path.join(options.root, 'src')} 下一个文件都没扫到，不谎报「通过」。`)
    return 2
  }

  const debt = loadDebt({ root: options.root, gate: 'check-capabilities' })
  const settled = settleDebt({ actual: toActual(report.defectHits), debt })
  const summary = debtSummary({ actual: toActual(report.defectHits), debt, result: settled })
  const debtProblems = debt.problems

  if (options.json) {
    const out = {
      ...report,
      strict: options.strict,
      debt: {
        file: debt.shown,
        entries: debt.entries.size,
        settled: settled.settled.length,
        unregistered: settled.unregistered.map(({ key, count, sample, why }) => ({ key, count, sample, why })),
        expired: settled.expired.map(({ key, count, entry, overdueDays }) => ({
          key,
          count,
          issue: entry.issue,
          expires: entry.expires,
          overdueDays,
        })),
        shrink: settled.shrink.map(({ key, registered, found }) => ({ key, registered, actual: found.count })),
        problems: debtProblems,
      },
    }
    console.log(JSON.stringify(out, null, 2))
  } else {
    const text = formatReport(report, { strict: options.strict, debt: settled })
    console.log(text)
    if (debt.exists) {
      console.log(
        `\n账本 ${debt.shown}：${summary.registered} 笔 / 共 ${summary.booked} 处` +
          (summary.nearest
            ? `；最近到期 ${summary.nearest.key} → ${summary.nearest.expires}（剩 ${summary.nearest.left} 天，到期即红）`
            : '；当前没有在账期内的条目'),
      )
    } else if (report.totals.defects > 0) {
      console.log(
        `\n账本 ${debt.shown} 不存在 —— 这 ${report.totals.defects} 处缺陷没有任何一条有到期日，` +
          '按「有账期的容忍」登记（why / issue / expires）或直接修掉。',
      )
    }
    if (debtProblems.length) {
      console.log('\n❌ 账本形状不合规（形状不合规的账本就是白名单）：')
      for (const problem of debtProblems) console.log(`  ${problem}`)
    }
  }

  if (debtProblems.length) return 1
  if (options.strict && report.totals.defects > 0) return 1
  if (settled.unregistered.length || settled.expired.length) return 1
  return 0
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = main(process.argv.slice(2))
}
