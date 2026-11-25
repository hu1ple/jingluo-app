// [layer: integration | 依赖: 无（纯 Node，不起浏览器、不要产物 ）| 耗时: < 100ms]
//
// `tests/integration-baseline.json` 的**自我校验**：这份清单本身是不是还是真的。
//
// 为什么要有它（这条门禁自己踩过的坑）：那份清单是 L1 的接入口径 —— `run-layer --baseline`
// 只判「相对基线没有新增失败」，`scripts/test-report.mjs` 也从这里数 known-red。
// 于是「清单写得对不对」直接等于「门禁判得对不对」，可它**一直是纯人肉维护**：
//   · 2026-11-25 实测：`tests/integration/` 有 49 个用例文件，清单只登记了 38 个 ——
//     没登记的 11 个不是「跑了但绿」，而是**清单里根本不存在**。`compareWithBaseline` 对
//     未登记文件默认 `expected = 'pass'`，所以「漏登记」在输出里与「登记为 pass」长得一模一样，
//     谁也看不出这一层有 11 个文件从来没被「应该是什么状态」这个问题问过；
//   · 同一个文件里还并排放着一份 `knownRed: {}`。`run-layer` / `test-report` **都不读它**
//     （真相只有 `files[*].expected`）—— 它是一份「看起来能豁免、实际不生效」的第二个注册表，
//     正是「基线腐烂」最省事的那条路：把红条目写进去，命令行依然判新增失败，然后大家开始
//     怀疑门禁，而不是看断言。
//
// 判定口径（每条都对应一个真实的失效模式，不是格式洁癖）：
//   1. **登记完整**：目录里每个 `*.test.mjs` 都在 `files` 里 —— 漏登记 = 这一层有文件没被问过；
//   2. **没有幽灵条目**：`files` 里每条都能在目录里找到文件 —— 改名/删文件后留下的条目会让
//      「红/绿」判定挂在空气上（`known-red` 条目尤其危险：删了文件永远等不到它跑绿）；
//   3. **单一真相**：不许再有 `knownRed` 这类并列注册表 —— 一条豁免只能有**一个**住处；
//   4. **豁免必须可归因**（intent：known-red 必须能回答「为什么红、谁在跟、什么证据」）：
//      `expected === 'known-red'` 的条目必须有非空 `reason` + `evidence` + `followUp`，
//      且 `followUp` 要指向一个跟单（`#数字` 或 URL）；`evidence` 里必须有日期（`YYYY-MM-DD`），
//      否则「实测过」是空话。**环境问题不许当 known-red**：`reason` 里出现下面那组词直接判红；
//   5. `expected` 只有两种取值：`pass` / `known-red`（写错一个字就等于没登记）；
//   6. **不许新增豁免**：本次修复的立场是「known-red 只减不增」，所以这里额外钉住当前态 ——
//      新增 known-red 必须先改这条用例、在 diff 里说清理由（比默默往 JSON 里加一条贵，正是要的）。
//
// 它**不**做的事：不判断「这个用例该不该绿」「断言对不对」——那要真跑。这里只保证
// 「基线清单与磁盘上的文件集合一致，且每一条豁免都写清了 guard 原文要求的三件事」。
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')
const BASELINE_FILE = path.join(ROOT, 'tests/integration-baseline.json')
/** 这份用例自己也要登记（第 1 条规则对它对所有文件一视同仁） */
const SELF = 'baseline-integrity.test.mjs'
/** 当前允许存在的豁免条数。known-red 只减不增：想加必须先改这一行并在 PR 里说明理由。 */
const MAX_KNOWN_RED = 0
/** 「把环境问题塞进 known-red」的典型措辞（#19 / #365 已经踩过一次） */
const ENV_EXCUSES = /(缺产物|产物缺失|端口被占用|没起服务|SKIP\(env\)|环境问题|机器太慢|网络不通)/
const ISO_DATE = /\d{4}-\d{2}-\d{2}/

const failures = []
const check = (ok, message) => {
  if (ok) {
    console.log(`  ok  ${message}`)
  } else {
    failures.push(message)
    console.error(`  ✗   ${message}`)
  }
}

const onDisk = (await readdir(HERE)).filter((name) => name.endsWith('.test.mjs')).sort()
const baseline = JSON.parse(await readFile(BASELINE_FILE, 'utf8'))
const files = baseline.files ?? {}
const registered = Object.keys(files).sort()

// ---------- 1. 登记完整：磁盘上的每个用例都要被问过「应该是什么状态」 ----------
{
  const missing = onDisk.filter((name) => !registered.includes(name))
  check(
    missing.length === 0,
    `目录里 ${onDisk.length} 个用例全部在基线清单里（漏登记 = 它从没被问过「应该是什么状态」）${
      missing.length > 0 ? `：缺 ${missing.join(' / ')}` : ''
    }`,
  )
}

// ---------- 2. 没有幽灵条目 ----------
{
  const ghosts = registered.filter((name) => !onDisk.includes(name))
  check(ghosts.length === 0, `基线清单里 ${registered.length} 条都能在目录里找到文件${ghosts.length > 0 ? `；幽灵条目：${ghosts.join(' / ')}` : ''}`)
  check(registered.includes(SELF), `本用例自己也登记在基线清单里（${SELF}）`)
}

// ---------- 3. 单一真相：没有第二个豁免注册表 ----------
{
  const extras = Object.keys(baseline).filter((key) => !['schemaVersion', 'baseline', 'howToRun', 'guards', 'files'].includes(key))
  check(
    extras.length === 0,
    `基线文件里没有并列的第二份注册表（真相只有 files[*].expected）${extras.length > 0 ? `：多余键 ${extras.join(' / ')}` : ''}`,
  )
}

// ---------- 4/5. 每条登记的形状 + 豁免必须可归因 ----------
const knownRed = []
for (const [name, entry] of Object.entries(files)) {
  const expected = entry?.expected
  if (expected !== 'pass' && expected !== 'known-red') {
    check(false, `${name} 的 expected=${JSON.stringify(expected)}，只允许 pass / known-red`)
    continue
  }
  if (typeof entry.reason !== 'string' || entry.reason.trim() === '') {
    check(false, `${name} 缺 reason（每条都要能回答「这条在守什么」）`)
  }
  if (expected !== 'known-red') {
    continue
  }
  knownRed.push(name)
  const missingBits = ['reason', 'evidence', 'followUp'].filter(
    (key) => typeof entry[key] !== 'string' || entry[key].trim() === '',
  )
  check(missingBits.length === 0, `known-red ${name} 写清了 reason / evidence / followUp${missingBits.length > 0 ? `；缺 ${missingBits.join(' / ')}` : ''}`)
  if (typeof entry.evidence === 'string') {
    check(ISO_DATE.test(entry.evidence), `known-red ${name} 的 evidence 带实测日期（否则「实测过」不算证据）`)
  }
  if (typeof entry.followUp === 'string' && entry.followUp.trim() !== '') {
    check(/[#]\d+|https?:\/\//.test(entry.followUp), `known-red ${name} 的 followUp 指向一个跟单（#issue 或 URL），不能是一句愿望`)
  }
  if (typeof entry.reason === 'string') {
    check(!ENV_EXCUSES.test(entry.reason), `known-red ${name} 不是环境问题伪装（环境问题会 SKIP(env)，不该进基线豁免）`)
  }
}

// ---------- 6. 豁免只减不增 ----------
check(
  knownRed.length <= MAX_KNOWN_RED,
  `known-red 条数 ${knownRed.length} ≤ ${MAX_KNOWN_RED}（只减不增；新增豁免要显式改本用例的 MAX_KNOWN_RED）${
    knownRed.length > MAX_KNOWN_RED ? `：多出 ${knownRed.join(' / ')}` : ''
  }`,
)

if (failures.length > 0) {
  console.error(`\nFAIL tests/integration/${SELF}`)
  for (const failure of failures) {
    console.error(`  ✗ ${failure}`)
  }
  process.exit(1)
}
console.log(
  `\nPASS tests/integration/${SELF}（${onDisk.length} 个用例全部登记 / known-red ${knownRed.length} 条且每条可归因）`,
)
