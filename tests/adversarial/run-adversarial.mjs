// 红队 / 对抗用例的运行器（不进 tests/run-layer.mjs 的 LAYERS，因此默认基线不受影响）。
//
//   node tests/adversarial/run-adversarial.mjs            # 跑全部
//   node tests/adversarial/run-adversarial.mjs --only a3  # 只跑一条（也支持直接 node 单个文件）
//   node tests/adversarial/run-adversarial.mjs --json     # 机器可读
//   node tests/adversarial/run-adversarial.mjs --record   # 记录本次实测结果（只写 lastObserved，不动豁免）
//   node tests/adversarial/run-adversarial.mjs --record --accept-fixed
//                                                        # 显式把「已修好的 known-defect」翻成 green 并删豁免字段
//
// 语义：用例本身 exit 0 = 符合期望；exit 1 = 期望没被满足。
// 真产品缺陷不会被「修绿」——baseline 里标 known-defect 的用例允许红，但一旦变绿会报 REGRESSION
// （提示缺陷可能被修了，需要人工确认后更新 baseline）；标 green 的用例变红同样报 REGRESSION。
//
// ---- 门禁优化第 7 条（2026-11-25）：known-defect 是豁免，`--record` 不许替人销账 ----
//
// 以前的 `--record` 会把「known-defect 用例跑绿了」直接写回 `verdict: "green"` ——
// 也就是说**跑一遍就能把一条豁免抹掉**，而「为什么它可以不修」只活在人脑子里。
// 现在拆成两件事：
//   · `--record` 只写**观测**（`lastObserved` / `lastObservedAt`），verdict 一个字都不改；
//   · 要把 known-defect 翻成 green（= 删掉这条豁免），必须显式 `--accept-fixed`，
//     且翻转时会打印「删掉了哪条豁免的哪些字段」—— 销账是一次决定，不是一次跑测试的副作用。
// 观测字段同时是 `pnpm run check:exemptions` 的输入：`lastObserved: "pass"` 会被判 `fixed-exemption` 红，
// 所以「跑绿了但没人回来删」这件事现在两边都会喊。
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const baselinePath = join(here, 'baseline.json')
const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'))

const args = process.argv.slice(2)
const json = args.includes('--json')
const record = args.includes('--record')
/** 显式销账：把「已修好」的 known-defect 翻成 green 并删掉豁免字段（默认关闭，见文件头） */
const acceptFixed = args.includes('--accept-fixed')
const onlyIndex = args.indexOf('--only')
const only = onlyIndex === -1 ? null : args[onlyIndex + 1]

const cases = Object.entries(baseline.cases)
  .filter(([id]) => only === null || id.startsWith(only))
  .map(([id, meta]) => ({ id, ...meta }))

/** known-defect = 豁免：缺 reason / followUp / reviewAfter 的条目在跑之前就点名（不阻断跑，拦人的是 check:exemptions） */
const incompleteDefects = cases.filter((item) => {
  if (item.verdict !== 'known-defect') return false
  const followUp = typeof item.followUp === 'string' ? item.followUp.trim() : ''
  return !item.reason || !followUp || !item.reviewAfter
})
if (incompleteDefects.length > 0) {
  console.log(`⚠ ${incompleteDefects.length} 条 known-defect 缺 reason / followUp / reviewAfter：${incompleteDefects.map((item) => item.id).join(', ')}`)
  console.log('  豁免必须写得清「为什么可以不修、谁承接、哪天复审」；pnpm run check:exemptions 会因此判红。')
}

const results = []
for (const item of cases) {
  const startedAt = Date.now()
  let code = 0
  let output = ''
  try {
    output = execFileSync(process.execPath, [join(here, 'cases', item.file)], {
      encoding: 'utf8',
      cwd: join(here, '..', '..'),
      timeout: 180_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    code = error.status ?? 1
    output = `${error.stdout ?? ''}${error.stderr ?? ''}`
  }
  const ms = Date.now() - startedAt
  const green = code === 0
  const expected = item.verdict
  let status = 'PASS'
  if (green && expected === 'known-defect') {
    status = 'REGRESSION'
  } else if (!green && expected === 'green') {
    status = 'REGRESSION'
  } else if (!green && expected === 'known-defect') {
    status = 'KNOWN-DEFECT'
  }
  const summary = output
    .split('\n')
    .filter((line) => /^\[[a-z]\d\]|^FAIL/.test(line))
    .join('\n')
  results.push({ id: item.id, bucket: item.bucket, title: item.title, status, ms, code, summary })
}

if (record) {
  const today = new Date().toISOString().slice(0, 10)
  const flipped = []
  for (const result of results) {
    const meta = baseline.cases[result.id]
    // 观测先落地：它既是大白话的「上次跑出什么」，也是 check:exemptions 判 fixed-exemption 的输入
    meta.lastObserved = result.code === 0 ? 'pass' : 'red'
    meta.lastObservedAt = today
    if (meta.verdict !== 'known-defect') continue
    if (result.code !== 0) continue
    if (!acceptFixed) {
      // 跑绿了但没让人确认 → 保留豁免，只把事实记下来（并让下面打印 FIXED?）
      continue
    }
    meta.verdict = 'green'
    const dropped = ['reason', 'evidence', 'followUp', 'addedAt', 'reviewAfter'].filter((field) => field in meta)
    for (const field of dropped) delete meta[field]
    flipped.push({ id: result.id, dropped })
  }
  writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8')
  const fixedButKept = results.filter((result) => result.code === 0 && baseline.cases[result.id]?.verdict === 'known-defect')
  if (fixedButKept.length > 0) {
    console.log('')
    console.log(`FIXED?  ${fixedButKept.map((result) => result.id).join(', ')}`)
    console.log('  这些用例记着 known-defect 但这次跑绿了。**豁免不会自己消失**：请人工确认缺陷已修好后')
    console.log(`  删掉断言/用例与 baseline 条目，或显式跑 --record --accept-fixed 把 verdict 翻成 green。`)
  }
  for (const item of flipped) {
    console.log(`ACCEPT-FIXED  ${item.id}：verdict known-defect → green，已删豁免字段 ${item.dropped.join(' / ') || '（无）'}`)
  }
}

if (json) {
  console.log(JSON.stringify({ results }, null, 2))
} else {
  for (const result of results) {
    console.log(`${result.status.padEnd(12)} ${result.id.padEnd(4)} ${result.title}（${result.ms}ms）`)
    if (result.status !== 'PASS') {
      for (const line of result.summary.split('\n').filter(Boolean)) {
        console.log(`             ${line}`)
      }
    }
  }
  const counts = results.reduce((acc, result) => {
    acc[result.status] = (acc[result.status] ?? 0) + 1
    return acc
  }, {})
  const regressions = results.filter((result) => result.status === 'REGRESSION')
  console.log('')
  console.log(
    `合计 ${results.length}：PASS ${counts.PASS ?? 0}，KNOWN-DEFECT ${counts['KNOWN-DEFECT'] ?? 0}，REGRESSION ${counts.REGRESSION ?? 0}`
  )
  if (regressions.length > 0) {
    console.log(`REGRESSION 用例：${regressions.map((result) => result.id).join(', ')}（需要人工确认后更新 baseline.json）`)
  }
  process.exit(regressions.length === 0 ? 0 : 1)
}
