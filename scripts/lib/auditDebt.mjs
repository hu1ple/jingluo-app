/**
 * `scripts/lib/auditDebt.mjs` —— 静态审计族的「记账式豁免」。
 *
 * 解决的问题（这一族最贵的那个病）：**常年 warn、永不拦**。
 * 能力审计挂着 10 处真实缺陷、截图门禁挂着 160 张孤儿图、文档引用门禁挂着 20 处漂移，
 * 全都只打印不拦截，注释写着「先 warn 后 strict」—— 但「之后」没有日期。
 * 于是唯一产出是：**让人以为有人在看**。
 *
 * 记账口径（三条，缺一条就退化成白名单）：
 *
 * 1. **每笔债都要有到期日**（`expires: YYYY-MM-DD`），且登记时不许超过今天 + 90 天
 *    （`MAX_DEBT_DAYS`）。没有「永久豁免」这个选项 —— 想续期就得改日期，改日期就得进 diff。
 * 2. **债只能减不能增**。同一账目下实际违规数 > 登记数 = 新增未登记违规 → **红**；
 *    实际 < 登记数 = 已经修好了但账没销 → 只提示（正确改动不许红，见下面的「为什么缩水不判红」）。
 * 3. **到期即红**，不管 `--strict` 有没有开。这是「先 warn 后 strict」那个空头承诺的替代品：
 *    warn 档可以容忍**在账期内**的已知缺陷，但容忍不了**过了期**的。
 *
 * 账本文件在 `scripts/audit-debt/<gate>.json`：一处门禁一份，跟门禁放在同一个 PR 里评审。
 *
 * ## 为什么缩水（实际 < 登记）不判红
 *
 * 惯例上「基线失真也要红」（`check-log-coverage` 的 R3 基线失效、`check:test-layout --strict`
 * 的失真条目都是这么做的），目的是逼人销账。但那条例子的前提是「这条红有人当场就能修」。
 * 在静态审计族里，修好一处缺陷的往往**不是**改账本的人（另一个 lane 修 `src/**`，本 lane 改
 * `scripts/**`），把他人的正确改动变成红灯，正是这一族「改对了也红」的老毛病（钉死行号、
 * 钉死数量的同一个病根）。所以这里只提示不判红：提示每分钟都会打印，账本不会悄悄漂走。
 *
 * ## 为什么过期判红不算「摩擦过大」
 *
 * 到期红拦的不是「这次改动」，是「这笔债到期了还没人管」。它每周只可能触发一次，而且修法
 * 二选一：**修掉**，或者**带着新理由续期**（续期上限仍是 90 天）。风险与摩擦成正比：
 * 能力审计里那 5 处「依赖 fetch 是本尊」的缺陷，一旦页面上了 wrapper，诊断通路整条哑掉，
 * 而这是**发出去就收不回**的那类问题 —— 它配得上一条会响的钟。
 *
 * ## 自证
 *
 * `settleDebt` 是纯函数，没有 IO：`tests/unit/…` 与各门禁的 `--selftest` 都直接喂对象进去断言。
 * 本模块的 `--selftest` 见各门禁脚本（`node scripts/check-capabilities.mjs --selftest` 等）。
 */

import fs from 'node:fs'
import path from 'node:path'

/** 一笔债最长能挂多久。登记 / 续期时都不许超过「今天 + 这个数」，没有永久豁免 */
export const MAX_DEBT_DAYS = 90

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** 今天的日期（`YYYY-MM-DD`，UTC）。`AUDIT_TODAY` 只给测试 / `--selftest` 用，让过期判定可复现 */
export const todayStr = (override) => {
  if (override && DATE_RE.test(override)) return override
  const env = process.env.AUDIT_TODAY
  if (env && DATE_RE.test(env)) return env
  return new Date().toISOString().slice(0, 10)
}

/** `b - a` 的天数（都是 `YYYY-MM-DD`；解析失败返回 NaN） */
export const daysBetween = (a, b) => {
  const from = Date.parse(`${a}T00:00:00Z`)
  const to = Date.parse(`${b}T00:00:00Z`)
  if (Number.isNaN(from) || Number.isNaN(to)) return Number.NaN
  return Math.round((to - from) / 86_400_000)
}

/** 账本路径：`<root>/scripts/audit-debt/<gate>.json` */
export const debtPath = (root, gate) => path.join(root, 'scripts', 'audit-debt', `${gate}.json`)

/**
 * 读账本并校验每一条的形状。**形状不合规也判红**：一份写不清理由的账本就是白名单。
 *
 * 返回 `{ file, exists, entries: Map<key, entry>, problems: string[] }`，
 * `entries` 的 key 是门禁自己定义的「账目 id」，`entry` 是
 * `{ count, why, issue, expires, at }`（`at` = 距今剩余天数，已过期为负）。
 */
export const loadDebt = ({ root, gate, today = todayStr() }) => {
  const file = debtPath(root, gate)
  const shown = path.relative(root, file).split(path.sep).join('/')
  if (!fs.existsSync(file)) return { file, shown, exists: false, entries: new Map(), problems: [] }

  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    return {
      file,
      shown,
      exists: true,
      entries: new Map(),
      problems: [`${shown} 不是合法 JSON：${error.message}`],
    }
  }

  const problems = []
  const entries = new Map()
  const raw = parsed?.entries
  if (!raw || typeof raw !== 'object') {
    return { file, shown, exists: true, entries, problems: [`${shown} 缺 entries 对象`] }
  }
  for (const [key, entry] of Object.entries(raw)) {
    const where = `${shown} → ${key}`
    if (!entry || typeof entry !== 'object') {
      problems.push(`${where}：登记必须是对象`)
      continue
    }
    const missing = ['why', 'issue', 'expires'].filter((field) => !entry[field])
    if (missing.length) {
      problems.push(`${where}：缺 ${missing.join(' / ')}（理由、承接单号、到期日三样都要有，缺一样就是白名单）`)
      continue
    }
    if (!DATE_RE.test(entry.expires)) {
      problems.push(`${where}：expires 必须是 YYYY-MM-DD（拿到 ${JSON.stringify(entry.expires)}）`)
      continue
    }
    const left = daysBetween(today, entry.expires)
    if (Number.isNaN(left)) {
      problems.push(`${where}：expires 解析不出日期（${entry.expires}）`)
      continue
    }
    if (left > MAX_DEBT_DAYS) {
      problems.push(
        `${where}：expires ${entry.expires} 距今 ${left} 天，超过 ${MAX_DEBT_DAYS} 天上限 —— ` +
          '豁免会过期，不许一次挂出去很远（改：把日期收到 90 天内，到期再续）',
      )
      continue
    }
    const count = entry.count ?? 1
    if (!Number.isInteger(count) || count < 1) {
      problems.push(`${where}：count 必须是 ≥1 的整数（拿到 ${JSON.stringify(entry.count)}）`)
      continue
    }
    entries.set(key, { ...entry, count, left })
  }
  return { file, shown, exists: true, entries, problems }
}

/**
 * 结账。纯函数，无 IO。
 *
 * - `actual`: `Map<key, {count, sample}>`，`sample` 是给人看的「文件:行」示例（可选）
 * - `debt`: `loadDebt()` 的返回值
 *
 * 返回四类：
 * - `unregistered` —— 有一定「账上没登记 / 登记数不够」的违规。**这是真红**：已知缺陷可以挂账，
 *   新缺陷不行。
 * - `expired` —— 到期的债。**这是真红**：豁免不能无限续命。
 * - `shrink` —— **账实不符**：账面登记比实际多（修好了但账没销）。判档由各门禁定，今天的分工：
 *   `check-doc-refs` / `check-ui-shots` **判红**（账实不符 = 账本在骗人，留着它等于拿假账换绿灯）；
 *   `check-capabilities` 仍是提示（未整合，见 docs/gates/audit-debt.md）。
 * - `settled` —— 在账期内、数量也对得上。
 */
export const settleDebt = ({ actual, debt, today = todayStr() }) => {
  const unregistered = []
  const expired = []
  const shrink = []
  const settled = []

  for (const [key, found] of actual) {
    const entry = debt.entries.get(key)
    if (!entry) {
      unregistered.push({ key, ...found, why: '未登记' })
      continue
    }
    if (found.count > entry.count) {
      unregistered.push({
        key,
        ...found,
        why: `登记 ${entry.count} 处，实际 ${found.count} 处（新增的这部分没人认领）`,
      })
      continue
    }
    if (found.count < entry.count) {
      shrink.push({ key, ...found, registered: entry.count, entry })
      continue
    }
    if (entry.left < 0) {
      expired.push({ key, ...found, entry, overdueDays: -entry.left })
      continue
    }
    settled.push({ key, ...found, entry })
  }

  for (const [key, entry] of debt.entries) {
    if (actual.has(key)) continue
    shrink.push({ key, found: { count: 0 }, registered: entry.count, entry })
  }

  return { unregistered, expired, shrink, settled }
}

/** 一句话汇总（门禁的标题行用） */
export const debtSummary = ({ actual, debt, result }) => {
  const total = [...actual.values()].reduce((sum, item) => sum + item.count, 0)
  const booked = [...debt.entries.values()].reduce((sum, entry) => sum + entry.count, 0)
  const nearest = [...debt.entries.entries()]
    .filter(([key]) => actual.has(key))
    .sort((a, b) => a[1].left - b[1].left)[0]
  return {
    total,
    booked,
    registered: debt.entries.size,
    nearest: nearest ? { key: nearest[0], expires: nearest[1].expires, left: nearest[1].left } : null,
    ...result,
  }
}

/**
 * 渲染「故意做错必须被拦」的对照结果。`--selftest` 用它统一输出，避免每个门禁各写一套。
 * `cases: [{name, ok, detail}]`，返回是否全过。
 */
export const renderSelftest = (title, cases) => {
  console.log(`—— ${title}：负向对照（--selftest）——`)
  let failed = 0
  for (const item of cases) {
    console.log(`  ${item.ok ? '✅' : '❌'} ${item.name}${item.detail ? `  ${item.detail}` : ''}`)
    if (!item.ok) failed += 1
  }
  console.log(
    failed === 0
      ? `\n✅ ${cases.length} 条对照全过：这门禁会咬。`
      : `\n❌ ${failed}/${cases.length} 条对照没过：这门禁是装饰品，别信它的绿。`,
  )
  return failed === 0
}
