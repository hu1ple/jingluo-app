/**
 * 提交守卫（事故：连点注册 → 服务端 IP 限流 5/min → 之后带正确验证码也被 429 挡住 60s）。
 *
 * 两件事，都是**纯逻辑**（不认识 React / DOM / 网络），所以能直接在裸 Node 里被单测钉住：
 *
 *  1. {@link createInFlightLatch} —— **同步** in-flight 闩。
 *     `busy` / `submitting` / `sendingCode` 全是 React state：同一 tick 内连点两次，两次都读到旧值、
 *     两次都放行（`AppUpdateField` 文件里那条老注释：`busy` 是 state，连点两次会都读到旧值）。state 留着
 *     负责置灰与 `aria-busy` 渲染，**「同一 tick 也不放行」只能靠 ref** —— 那就是这里这只闩。
 *     放在哪：组件里 `useRef(createInFlightLatch())`，或纯逻辑模块里一个模块级实例（`submitAuthCard`）。
 *
 *  2. {@link rateLimitSecondsOf} —— 429 → 「等多久」。
 *     429 在用户眼里**不是失败**，是「太频繁，等 N 秒」。秒数只认服务端 `Retry-After`
 *     （归一化后的 `error.retryAfterMs`，见 `services/consume/errors.ts` 的 `retryAfterOf`），
 *     没有这个头才退到 {@link RATE_LIMIT_FALLBACK_SECONDS}。客户端**不自造**频控窗口
 *     （与 `services/consume/auth.ts:440` 同一口径：429 时按 `Retry-After` 倒计时）。
 *
 * 为什么「没有 `Retry-After` 也倒计时」而 `emailBindPanelModel` 是「不倒计时」：
 * 那条链是纯通知接口（发码成功本来就没有 `resend_after`），不假装频控更诚实；而登录 / 注册 / 重置
 * 这条链上**服务端确实在限流**（5/min），用户此刻再点一定还是 429 —— 给一个 60s 的自保间隔，
 * 比让他继续撞墙更接近事实。数字只是「最早可能恢复」的量级，不是客户端自造的频控判定。
 */

/** 服务端没给 `Retry-After` 时的「稍后」秒数（与 `components/consume/panels.ts` 的兜底同值） */
export const RATE_LIMIT_FALLBACK_SECONDS = 60

/**
 * 一把同步闩。
 *
 * `enter()` 的判定与置位在**同一个同步段**里完成（没有 await 夹在中间），所以同一 tick 的第二次调用
 * 必定看到 `active === true`；`exit()` 由调用方在 `finally` 里调 —— 抛错也必须释放，否则一次异常
 * 就把这个入口永久锁死。
 */
export type InFlightLatch = {
  /** 当前是否有一发在飞（排查 / 断言用，不参与渲染） */
  readonly active: boolean
  /** 抢闩：`true` = 抢到（可以发请求），`false` = 已有一发在飞，**这次连请求都不该发** */
  enter: () => boolean
  /** 释放（必须在 `finally` 里调） */
  exit: () => void
}

/** 造一把闩。`useRef(createInFlightLatch())` 就能得到一个跨渲染稳定的同步闩 */
export const createInFlightLatch = (): InFlightLatch => {
  let active = false
  return {
    get active() {
      return active
    },
    enter() {
      if (active) {
        return false
      }
      active = true
      return true
    },
    exit() {
      active = false
    },
  }
}

/**
 * 抢到闩就跑 `work`，跑完（成功 / 抛错）在 `finally` 释放；没抢到返回 `undefined` 且**不执行** `work`。
 *
 * 返回值用 `undefined` 表示「没抢到」而不是抛错：连点不是异常，调用点只需要「这次什么都不做」。
 */
export const runExclusive = async <T>(
  latch: InFlightLatch,
  work: () => Promise<T>
): Promise<T | undefined> => {
  if (!latch.enter()) {
    return undefined
  }
  try {
    return await work()
  } finally {
    latch.exit()
  }
}

/**
 * 一次提交的返回值可能是 promise（真机：store 的 promise），也可能不是（void / 截图脚本的替身）。
 *
 * 两种情况都要把闩放掉，而且**只放一次**：
 *  - 是 promise → 等它 settle（成功 / 失败都放）—— 这样闩 held 到请求结束，第二次点击在弱网下也进不来；
 *  - 不是 promise → 立刻放，接力棒交给 state 的 `busy`（它已经在下一次渲染里置灰按钮）。
 *
 * 参数用 `unknown` 而不是 `void | Promise<…>`：`void` 放进联合类型会被 lint 判非法，
 * 而 `unknown` 同时接受这两种返回（调用点的 prop 类型也照这个口径写）。
 */
export const releaseWhenSettled = (pending: unknown, release: () => void): void => {
  if (pending !== null && typeof pending === 'object' && 'then' in pending) {
    void (pending as PromiseLike<unknown>).then(
      () => {
        release()
      },
      () => {
        release()
      }
    )
    return
  }
  release()
}

/**
 * 429 判据的**最小输入**（结构化取子集：`AuthError` / `Sub2ApiError` / 密码重置的失败联合都能直接传）。
 *
 * 三个字段任一命中就算限流：
 *  - `status === 429`：HTTP 状态码（`errors.ts` 对 429 只按状态码判 —— 那套信封**没有 `code`**）；
 *  - `kind === 'rate_limit'`：归一化类别；
 *  - `reason === 'rate-limited'`：`services/auth/passwordReset.ts` 的失败原因字面量。
 */
export type RateLimitSignal =
  | {
      status?: number | undefined
      kind?: string | undefined
      reason?: string | undefined
      /** 服务端 `Retry-After` 换成的毫秒数（没有这个头 = undefined） */
      retryAfterMs?: number | undefined
    }
  | null
  | undefined

/** 是不是「被限流了」（429 不是失败，见文件头第 2 条） */
export const isRateLimited = (signal: RateLimitSignal): boolean => {
  if (signal === null || signal === undefined) {
    return false
  }
  return signal.status === 429 || signal.kind === 'rate_limit' || signal.reason === 'rate-limited'
}

/**
 * 429 → 冷却秒数；**不是** 429 → `null`（调用点据此区分「等一等」与「真的失败了」）。
 *
 * 秒数来源只有一个：服务端 `Retry-After`（`retryAfterMs`）。取整向上、至少 1 秒。
 * 没有这个头才用 `fallbackSeconds`（默认 {@link RATE_LIMIT_FALLBACK_SECONDS}）。
 */
export const rateLimitSecondsOf = (
  signal: RateLimitSignal,
  fallbackSeconds: number = RATE_LIMIT_FALLBACK_SECONDS
): number | null => {
  if (!isRateLimited(signal)) {
    return null
  }
  const ms = signal?.retryAfterMs
  if (typeof ms === 'number' && Number.isFinite(ms) && ms > 0) {
    return Math.max(1, Math.ceil(ms / 1000))
  }
  return Math.max(1, Math.ceil(fallbackSeconds))
}

/**
 * 倒计时的一步：`>1` 减一秒，`1` 减到 0，`0` 还是 0（不出现负数）。
 *
 * 抽成纯函数是因为三个调用点（注册页两处 / 找回密码两处 / 设置卡）都要「逐秒 setTimeout」，
 * 减到负数会让「请 -1 秒后再试」这种句子有机会上屏。
 */
export const tickCooldown = (seconds: number): number => (seconds > 0 ? seconds - 1 : 0)

/** 发码链路的结局：`ok` 之外只关心「被限流了多久」—— 429 要变成可等待的倒计时，不是一句「失败」 */
export type SendCodeOutcome = {
  ok: boolean
  /** 非空 = 被限流，剩余秒数（来自 `Retry-After`，没有就 60） */
  retryAfterSeconds?: number
}

/** 把一次发码调用的结果归一成 {@link SendCodeOutcome}（`null` 错误 = 成功） */
export const sendCodeOutcomeOf = (
  ok: boolean,
  error: RateLimitSignal
): SendCodeOutcome => {
  if (ok) {
    return { ok: true }
  }
  const seconds = rateLimitSecondsOf(error)
  return seconds === null ? { ok: false } : { ok: false, retryAfterSeconds: seconds }
}
