/**
 * exemption-policy.mjs —— **豁免登记契约**：一个豁免条目要带哪些信息才算合法、什么时候算「已经烂掉」。
 *
 * ## 为什么要单独一个模块（Issue #919 / 门禁优化第 7 条）
 *
 * 本仓有 6 份「豁免 / 基线 / 白名单」文件，纪律早就写在注释里了（`integration-baseline.json` 的
 * note 写着「known-red 必须写清 reason + 证据 + followUp」「跑绿了要报 FIXED? 并要求删条目」
 * 「禁止把环境问题塞进 known-red」），但**没有一处被机器强制**：
 *   · `reason` 可以是空的，或者写「暂时允许」四个字；
 *   · `followUp` 可以指向一个已经关掉的单、甚至不存在的单；
 *   · 没有到期日 —— 「暂时允许」等于永久允许；
 *   · 条目除了「跑绿」再没有任何失效路径（文件删了、组不重复了，仍然躺在表里）。
 * 结果就是它退化成「一张可以随手加行的表」。
 *
 * 所以这里把契约写成**纯函数**（零 I/O、零网络）：输入是「一条登记 + 今天 + 工单状态」，
 * 输出是「合法 / 为什么非法 / 还剩几天」。真正的读写、抓工单状态、打印报告在
 * `scripts/check-test-exemptions.mjs`，由 `tests/unit/exemption-policy.test.mjs` 钉住。
 *
 * ## 四条判据（每条对应一种「腐烂」）
 *
 *   1. **不完整**（`missing-*` / `invalid-*` / `placeholder-*`）
 *      —— 缺 reason / evidence / followUp / addedAt / reviewAfter，或填了「待补」这种占位。
 *      缺一项就不合法：缺什么，输出里点名什么。
 *   2. **过期**（`expired`）
 *      —— `今天 > reviewAfter`。到期当天仍有效（`reviewAfter` 是「最晚复审到哪一天」，
 *      与 `scripts/check-release-traceability.mjs` 的豁免清单同一口径）。
 *      另外 `reviewAfter` 距今天超过该类允许的最长复核窗口（`maxReviewDays`）也算非法：
 *      一个 3 年后的到期日等于没有到期日。
 *   3. **已经不成立**（`fixed-exemption` / `dead-entry` / `followup-closed` / `stale-observation`）
 *      —— 跑绿了、它豁免的对象没了（文件不存在）、承接单已关闭、或者「声称还红」但已经 N 天没人实跑过。
 *      这四种都是**机器能判**的：判得出来就必须判，否则「豁免会腐烂」还是靠自觉。
 *   4. **拿环境问题顶包**（`env-as-exemption`）
 *      —— 缺产物 / 端口被占 / 机器慢 / 网络抖动 不是「已知红」，是「这次没测」。
 *      塞进 known-red 等于把 SKIP(env) 洗成豁免。判据是关键词 + 反驳词（`不是环境…` 不算命中）。
 *
 * ## 为什么「不是豁免」也要登记（`shard-weights` 那种）
 *
 * `tests/integration-shard-weights.json` 只影响分片均衡度：**没登记的文件照样会被跑**，
 * 没有任何红被放行。给它套「到期日」是纯摩擦，所以 `KIND_SPECS` 里它的 `exemption: false`，
 * 只做「登记完整性」（数字合法、文件还在）——**机制不该无差别套在不是豁免的东西上**。
 */

/** 日期唯一合法形态：`YYYY-MM-DD`（UTC 日）。与 release-traceability 豁免清单同一口径 */
export const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/

export const isIsoDay = (value) => {
  if (typeof value !== 'string' || !ISO_DAY.test(value.trim())) return false
  const at = Date.parse(`${value.trim()}T00:00:00Z`)
  if (!Number.isFinite(at)) return false
  // `2026-02-31` 能被 Date.parse 接受成 3/3，必须回环比对
  return new Date(at).toISOString().slice(0, 10) === value.trim()
}

/** 两个 `YYYY-MM-DD` 的天数差（b - a）；任一不合法 → null（判不了就别假装算得出来） */
export const daysBetween = (a, b) => {
  if (!isIsoDay(a) || !isIsoDay(b)) return null
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000)
}

/**
 * 占位文本。命中的 `reason` 与空 reason 等价：
 * 「（待补：…）」这种句子在报告里长得像有理由，实际是**没有理由**，最容易被后人当成已审过。
 */
export const PLACEHOLDER = /待补|待定|待填|占位|见后续|之后补|TODO|TBD|FIXME|xxx|\?\?\?/i

/**
 * 环境问题的关键词。命中它说明这条「红」其实是「没测成」：
 * 缺产物 / 端口被占 / 机器慢 / 网络抖动 —— 都该修环境或修 SKIP(env) 判据，不该进豁免。
 */
export const ENV_MARKERS = Object.freeze([
  'SKIP(env)',
  'skip(env)',
  '缺产物',
  '产物缺失',
  '产物陈旧',
  '产物种类不对',
  '未构建',
  '没有 dist',
  'dist 不存在',
  '端口被占',
  '端口冲突',
  '端口被别的服务占',
  '没起服务',
  '未注入 APP_URL',
  '网络不通',
  '网络抖动',
  '网络超时',
  '机器太慢',
  '机器慢',
  '负载高',
  '内存不足',
  'OOM',
  '磁盘满',
])

/** 反驳词：写清「这不是环境问题」的句子不算拿环境顶包（否则真红的归因会被误杀） */
export const ENV_REBUTTAL = /不是环境|非环境|并非环境|与环境无关|排除环境|不是缺产物|不是端口/

/** 工单引用：`#386` / `owner/repo#386` / 完整 issue URL 三种形态（GitHub 自己认的也是这三种） */
export const ISSUE_REF = /^(?:[\w.-]+\/[\w.-]+)?#\d+$|^https?:\/\/[^\s]+\/issues\/\d+$/

/** 证据里必须能指到一个**可复核的事实**：日期 / 工单号 / 提交号。含糊的一句话不算证据 */
export const CITE_PATTERN = /\d{4}-\d{2}-\d{2}|\b[0-9a-f]{7,40}\b|#\d+/

/** 一条登记的状态码（输出与 `--json` 都用这里，避免各处各写一套字符串） */
export const PROBLEM = Object.freeze({
  MISSING_REASON: 'missing-reason',
  PLACEHOLDER_REASON: 'placeholder-reason',
  MISSING_EVIDENCE: 'missing-evidence',
  UNCITED_EVIDENCE: 'uncited-evidence',
  MISSING_FOLLOWUP: 'missing-followup',
  INVALID_FOLLOWUP: 'invalid-followup',
  MISSING_ADDED_AT: 'missing-added-at',
  INVALID_ADDED_AT: 'invalid-added-at',
  MISSING_REVIEW_AFTER: 'missing-review-after',
  INVALID_REVIEW_AFTER: 'invalid-review-after',
  WINDOW_TOO_LONG: 'window-too-long',
  EXPIRED: 'expired',
  FIXED: 'fixed-exemption',
  DEAD_ENTRY: 'dead-entry',
  FOLLOWUP_CLOSED: 'followup-closed',
  STALE_OBSERVATION: 'stale-observation',
  ENV_AS_EXEMPTION: 'env-as-exemption',
  INVALID_ENTRY: 'invalid-entry',
})

/**
 * 每条问题（problem）是不是「红」。`unverified-issue` 不在表里：抓不到工单状态是**环境**问题，
 * 与「这条豁免指向已关闭的单」是两件事 —— 混在一起就分不清该改条目还是该修 CI 的 gh 凭据。
 */
export const SEVERITY = Object.freeze({
  [PROBLEM.MISSING_REASON]: 'error',
  [PROBLEM.PLACEHOLDER_REASON]: 'error',
  [PROBLEM.MISSING_EVIDENCE]: 'error',
  [PROBLEM.UNCITED_EVIDENCE]: 'error',
  [PROBLEM.MISSING_FOLLOWUP]: 'error',
  [PROBLEM.INVALID_FOLLOWUP]: 'error',
  [PROBLEM.MISSING_ADDED_AT]: 'error',
  [PROBLEM.INVALID_ADDED_AT]: 'error',
  [PROBLEM.MISSING_REVIEW_AFTER]: 'error',
  [PROBLEM.INVALID_REVIEW_AFTER]: 'error',
  [PROBLEM.WINDOW_TOO_LONG]: 'error',
  [PROBLEM.EXPIRED]: 'error',
  [PROBLEM.FIXED]: 'error',
  [PROBLEM.DEAD_ENTRY]: 'error',
  [PROBLEM.FOLLOWUP_CLOSED]: 'error',
  [PROBLEM.STALE_OBSERVATION]: 'error',
  [PROBLEM.ENV_AS_EXEMPTION]: 'error',
  [PROBLEM.INVALID_ENTRY]: 'error',
})

/**
 * 每类登记的契约。**字段名沿用各文件的历史写法**（`followUp` 与 `issue` 二选一），
 * 不为统一而改名 —— 改名只会制造一次无意义的大 diff，并让「这条记录是谁写的」不可追。
 *
 * `maxReviewDays`：允许的最长复核窗口。它存在是因为「没有期限的暂时允许 = 永久放弃」，
 * 而「三年后再看」在效果上与「没有期限」相同。
 * `obsolescenceDays`：`lastRedAt`（最后一次实跑确认仍是红）的最老容忍天数 —— 超过它，
 * 这条豁免声称的红已经没人见过，要么重跑一次要么删掉。
 *
 * 两个正交的开关，别混：
 *   · `exemption`：**它是否放行了某件事**（红 / 跳过 / 少跑）。只有它进「豁免总数」的趋势账。
 *   · `require*`：**它必须携带哪些字段**。`shard-weight` 两项都关（不是豁免、也不需要理由/到期日）——
 *     机制不该无差别套在不是豁免的东西上：给分片权重加到期日只是纯摩擦，不会让任何东西更安全。
 */
export const KIND_SPECS = Object.freeze({
  'integration-known-red': {
    file: 'tests/integration-baseline.json',
    what: '集成层基线里 `expected: "known-red"` 的文件（允许它红）',
    exemption: true,
    requireReason: true,
    requireEvidence: true,
    citeEvidence: true,
    requireFollowUp: true,
    requireAddedAt: true,
    requireReviewAfter: true,
    forbidEnvReason: true,
    maxReviewDays: 120,
    obsolescenceDays: 60,
    fixOn: '跑绿（`--baseline` 报 FIXED?）或条目自己记着 `lastObserved: "pass"`',
  },
  'flaky-quarantine': {
    file: 'tests/flaky-registry.json',
    what: 'flaky 登记簿里 `quarantinedAt` 非空的条目（跳过该用例）',
    exemption: true,
    requireReason: true,
    requireEvidence: false,
    citeEvidence: false,
    requireFollowUp: true,
    requireAddedAt: true,
    requireReviewAfter: true,
    forbidEnvReason: true,
    maxReviewDays: 45,
    obsolescenceDays: null,
    fixOn: '跑绿（`lastGreen` 晚于 `quarantinedAt`，机制会自动解除隔离，条目应删）',
  },
  'flaky-infra-signature': {
    file: 'tests/flaky-registry.json',
    what: 'runner 自身崩溃的**签名**登记（`infraSignatures`，不放行任何文件 —— 命中只重跑一次）',
    exemption: false,
    requireReason: false,
    requireEvidence: false,
    citeEvidence: false,
    requireFollowUp: true,
    requireAddedAt: true,
    requireReviewAfter: true,
    forbidEnvReason: false,
    maxReviewDays: 365,
    obsolescenceDays: null,
    fixOn: '签名不再出现（重跑仍是同一签名则按真红处理，签名条目可删）',
  },
  'adversarial-known-defect': {
    file: 'tests/adversarial/baseline.json',
    what: '对抗基线里 `verdict: "known-defect"` 的用例（允许它红）',
    exemption: true,
    requireReason: true,
    requireEvidence: true,
    citeEvidence: true,
    requireFollowUp: true,
    requireAddedAt: true,
    requireReviewAfter: true,
    forbidEnvReason: true,
    maxReviewDays: 180,
    obsolescenceDays: null,
    fixOn: '变绿（runner 报 REGRESSION）或条目自己记着 `lastObserved: "pass"`',
  },
  'duplication-baseline': {
    file: 'tests/test-duplication-baseline.json',
    what: 'R1 逐字重复存量组（允许这组重复存在）',
    exemption: true,
    requireReason: true,
    requireEvidence: false,
    citeEvidence: false,
    requireFollowUp: true,
    requireAddedAt: true,
    requireReviewAfter: true,
    forbidEnvReason: false,
    maxReviewDays: 365,
    obsolescenceDays: null,
    fixOn: '那组已经不重复了（`check-test-duplication` 报 stale，`--strict` 下即红）',
  },
  'duplication-whitelist': {
    file: 'tests/test-duplication-whitelist.json',
    what: '跨层重复白名单（R1 组 / R2 主题 / R3 标题）',
    exemption: true,
    requireReason: true,
    requireEvidence: false,
    citeEvidence: false,
    requireFollowUp: true,
    requireAddedAt: true,
    requireReviewAfter: true,
    forbidEnvReason: false,
    maxReviewDays: 365,
    obsolescenceDays: null,
    fixOn: '它放行的那组 / 主题 / 标题已经不再命中',
  },
  'fast-subset-exclude': {
    file: 'tests/fast-subset.json',
    what: '`test:fast` 排除的慢文件（允许它不出现在快速子集里）',
    exemption: true,
    requireReason: true,
    requireEvidence: false,
    citeEvidence: false,
    requireFollowUp: false,
    requireAddedAt: true,
    requireReviewAfter: true,
    forbidEnvReason: false,
    maxReviewDays: 400,
    obsolescenceDays: null,
    fixOn: '文件不存在了；或重测后已经不慢（应回到快速子集）',
  },
  'shard-weight': {
    file: 'tests/integration-shard-weights.json',
    what: '集成分片耗时权重（**不是豁免**：没登记的文件照样会被分进某个分片，没有任何红被放行）',
    exemption: false,
    requireReason: false,
    requireEvidence: false,
    citeEvidence: false,
    requireFollowUp: false,
    requireAddedAt: false,
    requireReviewAfter: false,
    forbidEnvReason: false,
    maxReviewDays: null,
    obsolescenceDays: null,
    fixOn: '文件不存在了（权重对不上任何文件）',
  },
})

/** 取 `followUp` / `issue` 里那一个（历史文件两种写法都有；二选一即可，两个都写则必须一致） */
export const issueRefOf = (entry = {}) => {
  const a = typeof entry.followUp === 'string' ? entry.followUp.trim() : ''
  const b = typeof entry.issue === 'string' ? entry.issue.trim() : typeof entry.issue === 'number' ? `#${entry.issue}` : ''
  return a || b
}

/** 把一条工单引用归一成 `#N`（用于查状态；查不到就返回 null） */
export const issueNumber = (ref) => {
  if (typeof ref !== 'string') return null
  const fromUrl = ref.match(/\/issues\/(\d+)$/)
  if (fromUrl) return Number(fromUrl[1])
  const fromHash = ref.match(/#(\d+)$/)
  if (fromHash) return Number(fromHash[1])
  if (/^\d+$/.test(ref.trim())) return Number(ref.trim())
  return null
}

const textOf = (value) => (typeof value === 'string' ? value.trim() : '')

const push = (problems, code, message) => problems.push({ code, severity: SEVERITY[code] ?? 'error', message })

/**
 * 判一条**登记**（不一定是豁免）是否合法。
 *
 * @param {object} input
 * @param {string} input.kind      —— `KIND_SPECS` 的键
 * @param {string} input.key       —— 条目标识（文件路径 / 组名 / 用例 id），只用于报告
 * @param {object} input.entry     —— 原始条目
 * @param {string} input.today     —— `YYYY-MM-DD`
 * @param {Map<number,string>|object} [input.issueStates] —— 工单号 → `open` / `closed`
 * @param {(rel:string)=>boolean} [input.exists] — 仓库相对路径是否存在（注入，便于自证）
 * @param {(rel:string)=>string|null} [input.resolveFile] — 把条目里的文件名解析成仓库相对路径（注入）
 * @returns {{kind:string,key:string,exemption:boolean,problems:object[],reviewAfter:?string,daysLeft:?number,ok:boolean,status:string}}
 */
export const validateEntry = ({
  kind,
  key,
  entry = {},
  today,
  issueStates = {},
  exists = () => true,
  resolveFile = null,
} = {}) => {
  const spec = KIND_SPECS[kind]
  if (!spec) throw new Error(`未知的豁免类别：${kind}（KIND_SPECS 里没有它）`)
  if (!isIsoDay(today)) throw new Error(`today 必须是 YYYY-MM-DD，收到：${today}`)
  const problems = []
  if (!entry || typeof entry !== 'object') {
    return { kind, key, exemption: spec.exemption, problems: [{ code: PROBLEM.INVALID_ENTRY, severity: 'error', message: '条目不是一个对象' }], reviewAfter: null, daysLeft: null, ok: false, status: 'illegal' }
  }

  const reason = textOf(entry.reason) || textOf(entry.why)
  const evidenceRaw = entry.evidence
  const evidence = Array.isArray(evidenceRaw) ? evidenceRaw.map((item) => textOf(item?.note ?? item?.summary ?? '')).filter(Boolean).join('；') : textOf(evidenceRaw)
  const followUp = issueRefOf(entry)

  // ── ① reason：必须写清「为什么它可以不修」，且不能是占位句
  if (spec.requireReason) {
    if (!reason) push(problems, PROBLEM.MISSING_REASON, '缺 `reason`：不写为什么，这条豁免就是一句「暂时允许」= 永久允许')
    // 占位句先判：它往往也短，但病不一样 —— 「待补」是**假装写过了**，比空着更危险
    else if (PLACEHOLDER.test(reason)) push(problems, PROBLEM.PLACEHOLDER_REASON, `\`reason\` 是占位句（命中 ${String(reason.match(PLACEHOLDER)?.[0] ?? '')}），等于没写理由`)
    else if (reason.length < 12) push(problems, PROBLEM.MISSING_REASON, `\`reason\` 只有 ${reason.length} 个字（<12），写不清「为什么可以不修」`)
  }

  // ── ② evidence：可复核的事实（日期 / 提交号 / 工单号）
  if (spec.requireEvidence) {
    if (!evidence) push(problems, PROBLEM.MISSING_EVIDENCE, '缺 evidence：它是「这条红真的存在」的唯一凭据，没有它后人无法复核')
    else if (PLACEHOLDER.test(evidence)) push(problems, PROBLEM.PLACEHOLDER_REASON, '`evidence` 是占位句（待补/TODO），等于没写证据')
    else if (spec.citeEvidence && !CITE_PATTERN.test(evidence)) {
      push(problems, PROBLEM.UNCITED_EVIDENCE, '`evidence` 里没有可复核的事实（要带日期 `YYYY-MM-DD` / 提交号 / 工单号）')
    } else if (evidence.length < 16) push(problems, PROBLEM.MISSING_EVIDENCE, `\`evidence\` 只有 ${evidence.length} 个字（<16），不足以复核`)
  }

  // ── ③ followUp / issue：承接单必须存在且指得着
  if (!followUp && spec.requireFollowUp) {
    push(problems, PROBLEM.MISSING_FOLLOWUP, '缺 `followUp` / `issue`：没有承接单 = 修复没有任何人负责，到期后也无人复审')
  } else if (followUp && !ISSUE_REF.test(followUp)) {
    push(problems, PROBLEM.INVALID_FOLLOWUP, `\`followUp\`=\`${followUp}\` 不是工单引用（#386 / owner/repo#386 / issue URL 三种形态）`)
  } else {
    const n = issueNumber(followUp)
    const state = n === null ? null : (issueStates instanceof Map ? issueStates.get(n) : issueStates[n] ?? issueStates[`#${n}`])
    if (state === 'closed' || state === 'CLOSED') {
      push(problems, PROBLEM.FOLLOWUP_CLOSED, `承接单 ${followUp} 已关闭 —— 豁免的承接单关了就说明这件事应该结案：删条目，或改指向未关的单`)
    }
  }

  // ── ④ addedAt / reviewAfter：豁免必须有到期日，且期限不许「挪到看不见的地方」
  const addedAt = textOf(entry.addedAt) || textOf(entry.quarantinedAt) || textOf(entry.firstSeen)
  if (!addedAt) {
    if (spec.requireAddedAt) push(problems, PROBLEM.MISSING_ADDED_AT, '缺 `addedAt`（这条豁免是哪天登记、哪天上隔离区的）—— 没有起点就算不出「已经豁免了多久」')
  } else if (!isIsoDay(addedAt)) {
    push(problems, PROBLEM.INVALID_ADDED_AT, `\`addedAt\`=\`${addedAt}\` 不是合法的 YYYY-MM-DD`)
  } else if (daysBetween(addedAt, today) < 0) {
    push(problems, PROBLEM.INVALID_ADDED_AT, `\`addedAt\`=${addedAt} 在今天（${today}）之后 —— 将来才登记的豁免现在就在生效`)
  }

  const reviewAfter = textOf(entry.reviewAfter)
  let daysLeft = null
  if (!reviewAfter) {
    if (spec.requireReviewAfter) push(problems, PROBLEM.MISSING_REVIEW_AFTER, '缺 `reviewAfter`：**没有到期日的豁免就是永久后门**（第 7 条），必须写「最晚复审到哪一天」')
  } else if (!isIsoDay(reviewAfter)) {
    if (spec.requireReviewAfter) push(problems, PROBLEM.INVALID_REVIEW_AFTER, `\`reviewAfter\`=\`${reviewAfter}\` 不是合法的 YYYY-MM-DD（到期判据无从计算）`)
  } else if (spec.requireReviewAfter) {
    daysLeft = daysBetween(today, reviewAfter)
    if (daysLeft < 0) {
      push(problems, PROBLEM.EXPIRED, `**豁免已过期**：reviewAfter=${reviewAfter} < 今天 ${today}（逾期 ${-daysLeft} 天）—— 要么修掉它，要么复审后重设到期日并写清复审结论（续期是复审，不是免检）`)
    } else if (spec.maxReviewDays !== null && daysLeft > spec.maxReviewDays) {
      push(problems, PROBLEM.WINDOW_TOO_LONG, `\`reviewAfter\`=${reviewAfter} 距今 ${daysLeft} 天，超过本类豁免允许的最长复核窗口（${spec.maxReviewDays} 天）—— 到期日放那么远等于没有到期日`)
    }
  }

  // ── ⑤ 「已经不成立」：文件没了 / 已经跑绿 / 声称还红但没人实跑过
  if (resolveFile) {
    const rel = resolveFile(entry)
    if (rel === null || rel === undefined) {
      // 解析不出目标（例如条目自己写错了路径）：交给调用方的结构检查
    } else if (rel === false) {
      push(problems, PROBLEM.DEAD_ENTRY, '条目里没有可解析的目标文件（缺 `file` / 组为空）')
    } else if (!exists(rel)) {
      push(problems, PROBLEM.DEAD_ENTRY, `豁免对象已经不在了（\`${rel}\` 不存在）—— 跑不到的东西不需要豁免，删条目`)
    }
  }
  if (textOf(entry.lastObserved) === 'pass' || textOf(entry.lastObserved) === 'green') {
    push(problems, PROBLEM.FIXED, `条目自己记着 \`lastObserved: "pass"\`（${textOf(entry.lastObservedAt) || '日期未记'}）—— 已经跑绿就必须删条目：留在表里等于把「已修好」继续算成「已知红」`)
  }
  if (entry.quarantinedAt && typeof entry.lastGreen === 'string' && isIsoDay(entry.lastGreen.slice(0, 10)) && entry.quarantinedAt) {
    const green = entry.lastGreen.slice(0, 10)
    const q = textOf(entry.quarantinedAt)
    if (isIsoDay(q) && daysBetween(q, green) !== null && daysBetween(q, green) > 0) {
      push(problems, PROBLEM.FIXED, `隔离之后又跑绿了（quarantinedAt=${q} < lastGreen=${green}）—— 隔离的理由已经不成立，解除隔离并删条目`)
    }
  }
  if (spec.obsolescenceDays !== null) {
    const lastRedAt = textOf(entry.lastRedAt)
    if (!lastRedAt) {
      push(problems, PROBLEM.STALE_OBSERVATION, `缺 \`lastRedAt\`（最后一次**实跑确认仍然是红**的日期）—— 没人跑过的红不能当「已知红」：豁免的是红，不是猜测`)
    } else if (isIsoDay(lastRedAt)) {
      const age = daysBetween(lastRedAt, today)
      if (age !== null && age > spec.obsolescenceDays) {
        push(problems, PROBLEM.STALE_OBSERVATION, `\`lastRedAt\`=${lastRedAt} 距今 ${age} 天（>${spec.obsolescenceDays}）：这条「已知红」已经 ${age} 天没人实跑过 —— 重跑一次并把日期改成今天，或者删掉`)
      }
    } else {
      push(problems, PROBLEM.INVALID_ADDED_AT, `\`lastRedAt\`=\`${lastRedAt}\` 不是合法的 YYYY-MM-DD`)
    }
  }

  // ── ⑥ 拿环境问题顶包：缺产物 / 端口 / 机器慢 是「没测」不是「已知红」
  if (spec.forbidEnvReason) {
    const corpus = `${reason} ${evidence}`
    const hit = ENV_MARKERS.find((marker) => corpus.includes(marker))
    if (hit && !ENV_REBUTTAL.test(corpus)) {
      push(problems, PROBLEM.ENV_AS_EXEMPTION, `理由里出现环境问题「${hit}」—— **环境问题不许塞进豁免**：缺产物/端口/机器慢 的正确处置是 SKIP(env) 或修环境，登记成已知红等于把「没测」洗成「已知」`)
    }
  }

  const ok = problems.length === 0
  const status = !ok ? 'illegal' : daysLeft !== null && daysLeft <= 14 ? 'expiring' : 'ok'
  return { kind, key, exemption: spec.exemption, problems, reviewAfter: reviewAfter || null, daysLeft, ok, status }
}

/** 把一批结果汇总成「每条几合法 / 几过期 / 什么坏了」，报告与 `--json` 共用这一份口径 */
export const summarize = (results = []) => {
  const byCode = {}
  const out = {
    total: results.length,
    exemptions: results.filter((item) => item.exemption).length,
    ok: results.filter((item) => item.ok).length,
    illegal: results.filter((item) => !item.ok).length,
    expiring: results.filter((item) => item.status === 'expiring').length,
    byCode,
    worst: [],
    nearestExpiry: [],
  }
  for (const result of results) {
    for (const problem of result.problems) byCode[problem.code] = (byCode[problem.code] ?? 0) + 1
  }
  out.worst = results.filter((item) => !item.ok).slice(0, 20)
  out.nearestExpiry = results
    .filter((item) => item.daysLeft !== null)
    .sort((a, b) => a.daysLeft - b.daysLeft)
    .slice(0, 8)
    .map((item) => ({ kind: item.kind, key: item.key, reviewAfter: item.reviewAfter, daysLeft: item.daysLeft }))
  return out
}

/**
 * 趋势：本次各文件的条目数 vs 上一份快照。
 *
 * **不设上限**（上限会逼人删掉真豁免来保绿，那是第 1 条「红必须等于坏」的反面）；
 * 只让「只增不减」这件事**显形**：总数、增量、以及**新增/移除了哪几条**（可归因）。
 */
export const diffSnapshots = (previous, current) => {
  const before = previous?.entries ?? {}
  const after = current?.entries ?? {}
  const kinds = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
  const rows = kinds.map((kind) => {
    const was = Array.isArray(before[kind]) ? before[kind] : []
    const now = Array.isArray(after[kind]) ? after[kind] : []
    const added = now.filter((key) => !was.includes(key))
    const removed = was.filter((key) => !now.includes(key))
    return { kind, before: was.length, after: now.length, delta: now.length - was.length, added, removed }
  })
  return {
    previousAt: previous?.today ?? null,
    totalBefore: rows.reduce((sum, row) => sum + row.before, 0),
    totalAfter: rows.reduce((sum, row) => sum + row.after, 0),
    rows,
  }
}

/** 快照形状（写进 `tests/exemption-ledger.json`；只追加，不覆盖历史） */
export const buildSnapshot = ({ today, results = [], note = '' } = {}) => {
  const entries = {}
  for (const result of results) {
    if (!KIND_SPECS[result.kind]?.exemption) continue
    entries[result.kind] = [...(entries[result.kind] ?? []), result.key].sort()
  }
  return { today, recordedAt: new Date().toISOString(), note, entries }
}
