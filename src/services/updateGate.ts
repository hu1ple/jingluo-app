/**
 * 启动检查更新 + 强制更新的**检测层**（本单新增）。
 *
 * ## 为什么要有这一层
 *
 * 仓库里更新链路本来是完整的：`fetchManifest` → `parseManifest` → `selectUpdate` →
 * `resolveUpdatePolicy` → `resolveUpdatePrompt`（snooze）→ 下载（sha256）→ 安装。
 * 但这一整套只长在「设置 → 关于 → 应用更新」那个二级页里（`AppUpdateField.tsx`）：
 * **用户不点设置就永远不会检查**，于是 `minSupportedVersionCode`（强制更新）这个机制等于空转。
 *
 * 本文件只做一件事：把「启动时该不该拦人」这件事抽成**一个纯判定入口**，
 * 让 App 在首屏之后异步问一次。判据一行都不重写 —— 四件套原样复用，本文件只负责
 * 「什么时候问、问不到怎么办、问到了算什么档」。
 *
 * ## 判定顺序（`checkUpdateGate`）
 *
 * 0. **版本号**：`versionCode` 非正整数（构建期没注入 / 被改坏）→ `none`。
 *    本机版本号读不出来不是「你必须升级」的证据。
 * 1. **节流**：`localStorage['chat-demo:update-last-checked-at']` 距今 < 6 小时 → **不发请求**，
 *    改用本地清单快照判定（`?update-check` 参数可强制真查一次，便于产品方看效果）。
 * 2. **拉清单**：`fetchManifest()`（内部已含私有清单 → 公网清单的回退），带 2.5s `AbortController`
 *    超时。**拉不到 / 超时 / 解析失败一律 `none`**（fail-open：服务端挂了不许把人锁死）。
 * 3. **选版本**：`selectUpdate(rows, versionCode, variant, channel)`，抛错 / 没有候选 → `none`。
 * 4. **判策略**：`resolveUpdatePolicy(release.updatePolicy, versionCode, now)`（唯一实现，含
 *    `expiresAt` 失效与 `minSupportedVersionCode` 优先）。`normal` → `none`；
 *    `soft` → 再过一层 `resolveUpdatePrompt`（snooze 期内不弹）；`forced` → 见第 5、6 条。
 * 5. **平台**：`isAndroidUpdate()` 为假（网页）→ **永不 `forced`**。网页刷新即最新，没有安装这个概念，
 *    弹一个关不掉的「请更新」只会把网页用户彻底锁死。
 * 6. **快照时效**：本次判定若来自**缓存快照**（第 1 条节流命中时），且快照距今 > 24 小时 →
 *    **不判 `forced`**（陈旧策略不许拦人）。同一条快照若服务端写的是 `soft`，仍然照常展示
 *    「有新版」（可关闭的那一档不受 24 小时限制）。
 *
 * ## 两条刻意的取舍（写在这里，免得后来者以为漏了）
 *
 * · **拉清单失败不回落到快照**：失败就是 `none`。快照兜底是设置页「检查失败」那一屏的事
 *   （#412），启动拦截比它激进得多 —— 拿一份可能过期的清单去禁用一个能发消息的输入框，
 *   代价远大于「这次没拦住」。
 * · **判定出 `forced` 之前已经发出的消息不追溯**：本层是异步的（网络往返 1~2 秒），
 *   这期间用户发出去的消息既不会撤回、也不会被中止。只读模式约束的是**判定之后**的入口，
 *   追溯会变成「回答发到一半被打断」，那是更糟的体验（也违反「不中断流式输出」）。
 */

import { bundledApp, currentVariant, isAndroidUpdate } from './appUpdate.js'
import {
  fetchManifest,
  readManifestSnapshot,
  readUpdateChannel,
  saveManifestSnapshot,
  selectUpdate,
  type ArtifactVariant,
  type StorageLike,
  type UpdateChannel,
  type UpdateRelease,
} from './updateManifest.js'
import {
  resolveUpdatePolicy,
  resolveUpdatePrompt,
  type ResolvedUpdatePolicy,
} from './updatePolicy.js'

/**
 * 检测结果。三档之外没有第四种状态：`none` 就是「什么都不做」，
 * 界面据此决定弹不弹、锁不锁发送 —— 判定层不携带任何「待会儿再说」的中间态。
 */
export type UpdateGate =
  | { kind: 'none' }
  | { kind: 'soft'; release: UpdateRelease; policy: ResolvedUpdatePolicy }
  | { kind: 'forced'; release: UpdateRelease; policy: ResolvedUpdatePolicy }

/** 「什么都不做」的唯一实例（判定层返回值不持有可变状态，共享一个冻结对象是安全的） */
const NONE: UpdateGate = Object.freeze({ kind: 'none' as const })

/** 上次真查的时间戳（毫秒）。与其它设置项同一 `chat-demo:` 前缀 */
export const UPDATE_GATE_LAST_CHECKED_KEY = 'chat-demo:update-last-checked-at'
/** 节流窗口：6 小时内不重复请求更新服务 */
export const UPDATE_GATE_THROTTLE_MS = 6 * 60 * 60 * 1000
/**
 * 快照判 `forced` 的年龄上限：24 小时。
 * 比节流窗口（6 小时）宽，是因为它要覆盖「上次检查是 2 小时前、但清单其实是 3 天前拿到的」
 * 这种情形 —— 那时策略可能早就撤了，拿它锁人就是在拿陈旧策略拦人。
 */
export const UPDATE_GATE_SNAPSHOT_FORCED_MAX_AGE_MS = 24 * 60 * 60 * 1000
/** 清单请求超时：2.5 秒。首屏之后跑，但也别让用户的第一次「发送」等它 */
export const UPDATE_GATE_TIMEOUT_MS = 2500
/** 强制检查的 URL 参数（产品方反复看效果用；也给自动化用例一个确定性入口） */
export const UPDATE_GATE_FORCE_PARAM = 'update-check'

/** 本机已装版本（默认取构建期注入的那一份，与设置页 `bundledApp()` 同一口径） */
export interface InstalledSnapshot {
  version: string
  versionCode: number
  variant: ArtifactVariant
}

/** 可注入依赖：测试与「网页预览 / 原生包」两种环境都靠它，本文件自己不摸全局 */
export interface UpdateGateDeps {
  /** 当前时间（毫秒），测试用来把「6 小时 / 24 小时」变成一次参数 */
  now?: number
  /** 清单请求实现（默认 `fetch`）；用例塞假 fetch 即可覆盖 500 / 脏 JSON / 超时 */
  request?: typeof fetch
  /** 存储介质（默认 `localStorage`）；列表项既有 `StorageLike` 直接复用 */
  storage?: StorageLike | null
  /** 平台判定（默认 `isAndroidUpdate()`）；`false` = 网页，永不 `forced` */
  isAndroid?: () => boolean
  /** 本机版本（默认 `bundledApp()` + `currentVariant()`） */
  installed?: () => InstalledSnapshot
  /** 更新渠道（默认读持久化的选择，回落「版本名带 - → 预发布」） */
  channel?: UpdateChannel
  /** 忽略节流，强制真查一次（等价 URL 上的 `?update-check`） */
  force?: boolean
  /** 请求超时（毫秒） */
  timeoutMs?: number
  /** 本地 snooze 到期时刻（默认读 settings 里那份）；`soft` 在期内不弹 */
  snoozedUntil?: number
}

/** 本机快照：构建期注入值读不到时退化成「版本号未知」，由第 0 条判 `none` */
const localInstalled = (): InstalledSnapshot => {
  const app = bundledApp()
  return { version: app.version, versionCode: app.versionCode, variant: currentVariant() }
}

/** 渠道默认值：版本名带 `-`（`1.4.0-beta.1`）说明装的是预发布包 —— 与设置页同一条口径 */
const defaultChannel = (version: string): UpdateChannel =>
  /-/.test(version) ? 'prerelease' : 'stable'

/**
 * 读「上次真查的时间」。没有 / 脏值 / 存储不可用 → `undefined`（= 该查一次了）。
 * 宁可多查一次，也不要因为一个坏时间戳永远不查。
 */
const readLastCheckedAt = (storage?: StorageLike | null): number | undefined => {
  try {
    const raw = (storage ?? localStorage).getItem(UPDATE_GATE_LAST_CHECKED_KEY)
    if (raw === null || raw === '') {
      return undefined
    }
    const at = Number(raw)
    return Number.isFinite(at) && at > 0 ? at : undefined
  } catch {
    return undefined
  }
}

/** 写「上次真查的时间」：写不进去不影响本次判定（隐私模式 / 配额满） */
const writeLastCheckedAt = (at: number, storage?: StorageLike | null): void => {
  try {
    ;(storage ?? localStorage).setItem(UPDATE_GATE_LAST_CHECKED_KEY, String(at))
  } catch {
    // 存不下就等于「不节流」：下次启动会再查一次，比把界面带崩划算
  }
}

/** URL 上有没有 `?update-check`（纯读，改不了任何判定，只是跳过 6 小时节流） */
const forceParamPresent = (): boolean => {
  try {
    return (
      typeof location !== 'undefined' &&
      new URLSearchParams(location.search).has(UPDATE_GATE_FORCE_PARAM)
    )
  } catch {
    return false
  }
}

/** 本次判定的数据来源：`live` = 刚拉到的新清单；`snapshot` = 本地缓存（带它的成功时间） */
type GateSource = { kind: 'live' } | { kind: 'snapshot'; savedAt: number }

interface GateContext {
  /** 平台判定结果在入口处算一次，后面各分支不再重复问 */
  android: boolean
  installed: InstalledSnapshot
  channel: UpdateChannel
  now: number
  snoozedUntil: number | undefined
}

/**
 * 把「一份清单」判成三档。**所有判据都在这一个函数里**，`live` 与 `snapshot` 只差一条时效规则，
 * 避免「两条路径各写一份早晚漂移」。
 */
const evaluate = (rows: UpdateRelease[], source: GateSource, ctx: GateContext): UpdateGate => {
  // 3) 选版本：同一套 `selectUpdate`（变体 × 渠道 × 当前版本），不另写筛选
  let release: UpdateRelease | undefined
  try {
    release = selectUpdate(rows, ctx.installed.versionCode, ctx.installed.variant, ctx.channel)
      .release
  } catch {
    // INVALID_CURRENT_VERSION / AMBIGUOUS_RELEASE：判不清就不拦人
    return NONE
  }
  if (release === undefined) {
    return NONE
  }
  // 4) 判策略：`resolveUpdatePolicy` 是唯一实现（含 expiresAt / 最低支持版本优先于 mode）
  let policy: ResolvedUpdatePolicy
  try {
    policy = resolveUpdatePolicy(release.updatePolicy, ctx.installed.versionCode, ctx.now)
  } catch {
    return NONE
  }
  if (policy.mode === 'forced') {
    // 5) 平台：网页永不 forced（刷新即最新，没有安装概念）
    if (!ctx.android) {
      return NONE
    }
    // 6) 快照时效：超过 24 小时的快照不许判 forced（陈旧策略不许拦人）
    if (
      source.kind === 'snapshot' &&
      ctx.now - source.savedAt > UPDATE_GATE_SNAPSHOT_FORCED_MAX_AGE_MS
    ) {
      return NONE
    }
    return { kind: 'forced', release, policy }
  }
  if (policy.mode === 'soft') {
    // 4b) soft 再过一层 snooze（唯一实现；forced 不写 snooze，也没有「稍后」）
    const decision = resolveUpdatePrompt({
      policy: release.updatePolicy,
      currentVersionCode: ctx.installed.versionCode,
      snoozedUntil: ctx.snoozedUntil,
      now: ctx.now,
    })
    return decision.show ? { kind: 'soft', release, policy } : NONE
  }
  // normal（含「清单根本没下发策略」）→ 什么都不做：更新入口仍在设置页
  return NONE
}

/**
 * 启动检查：返回「该不该拦人」。**永不抛**（fail-open），所有失败路径都收敛成 `{ kind: 'none' }`。
 *
 * 调用点只该有一处（`App` 的首屏 effect），并且**不要 await 它** —— 它不阻塞渲染，
 * 结果落到 `updateGateState` 的轻量 store 上。
 */
export const checkUpdateGate = async (deps: UpdateGateDeps = {}): Promise<UpdateGate> => {
  const now = deps.now ?? Date.now()
  const installed = (deps.installed ?? localInstalled)()
  // 0) 版本号非法 → 不拦（读不出来不是「你必须升级」的证据）
  if (!Number.isSafeInteger(installed.versionCode) || installed.versionCode <= 0) {
    return NONE
  }
  const android = (deps.isAndroid ?? isAndroidUpdate)()
  const channel =
    deps.channel ?? readUpdateChannel(defaultChannel(installed.version), deps.storage)
  const ctx: GateContext = {
    android,
    installed,
    channel,
    now,
    // snooze 只在 soft 用到；显式注入优先（用例不碰真实 storage）
    snoozedUntil: deps.snoozedUntil,
  }
  const force = deps.force ?? forceParamPresent()

  // 1) 节流：6 小时内查过就不再请求（`?update-check` 例外）
  const lastCheckedAt = readLastCheckedAt(deps.storage)
  const throttled =
    !force && lastCheckedAt !== undefined && now - lastCheckedAt < UPDATE_GATE_THROTTLE_MS
  if (throttled) {
    // 不发请求，但仍用本地快照判定一次：策略可能是上次刚下发的（强制更新不该因为节流而失效），
    // 只是「陈旧快照不判 forced」那条闸（evaluate 第 6 条）会在里面兜住。
    const snapshot = readManifestSnapshot(now, deps.storage)
    return snapshot === undefined
      ? NONE
      : evaluate(snapshot.rows, { kind: 'snapshot', savedAt: snapshot.savedAt }, ctx)
  }

  // 2) 拉清单：2.5s 超时，任何失败都 fail-open
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? UPDATE_GATE_TIMEOUT_MS)
  try {
    const manifest = await fetchManifest(controller.signal, deps.request ?? fetch)
    // 拉到了就存快照（best-effort）：节流窗口内的下一次启动靠它判定，设置页失败兜底也用它
    try {
      saveManifestSnapshot({ rows: manifest.rows, base: manifest.base, savedAt: now }, deps.storage)
    } catch {
      // 存不下 / 写爆配额：本次判定照常用刚拉到的清单
    }
    return evaluate(manifest.rows, { kind: 'live' }, ctx)
  } catch {
    // 断网 / 5xx / 脏 JSON / 超时 / 被 abort：一律 none（服务端挂了绝不把人锁死）
    return NONE
  } finally {
    clearTimeout(timer)
    // 记「查过了」放在 finally：失败也算一次尝试，否则断网时每开一次 App 都打一轮服务端。
    // 代价是「失败后 6 小时内不再自动查」——更新入口在设置页仍然随时可手动检查。
    writeLastCheckedAt(now, deps.storage)
  }
}
