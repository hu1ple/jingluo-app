/**
 * 断流（stream break）的**体验口径**：哪些情况该自动重试、哪些只该给软提示、哪些必须保留已收内容。
 *
 * 为什么要有这份判定：用户报「流式传输中断时前端会报错」。复现（`docs/ui/streambreak-before-*.png`）
 * 看到的事实是 —— 三种断流形态（首字节前 / 首字节后 / 长时间无数据）**全部**渲染成红色错误条
 * `rgb(236,19,19)` + ⚠ 图标，而其中两种其实已经收到了内容。**「中断」不是「报错」**：
 * 用户已经看到字了，用报错语气吓他、还让他以为内容丢了，是错的。
 *
 * 三条产品口径（本文件是**唯一判定处**，改口径只改这里）：
 *
 * | 场景 | 已收内容 | 已重试 | 自动重试 | 提示语气 |
 * | --- | --- | --- | --- | --- |
 * | 首字节前断开（一个字都没有） | 0 | 否 | ✅ 静默重试 **1** 次 | 软（重试成功后**无任何提示**） |
 * | 首字节前断开，重试仍失败 | 0 | 是 | ❌ | 软（状态行 + 「重新生成」） |
 * | 首字节后断开（已看到内容） | > 0 | — | ❌ **绝不重发** | 警示（状态行，不是错误条） |
 * | idle 超时（连上了、只是不动） | 任意 | — | ❌ 不计入首字节前重试 | 警示 / 软 |
 *
 * 为什么「首字节后」一次都不能重发：重发就是**从头再生成一遍**，用户会看到两遍内容、
 * 上游重复计费，而界面上并没有任何东西提示他「这是第二份」。这条与 `chat/timeoutPolicy.ts`
 * 的 `requiresNoContent` 是同一条纪律，只是这里把它扩到断流与 idle 两档，并顺带给出**视觉语气**。
 *
 * 为什么「静默重试」只有 1 次：#105 的 `STREAM_RETRY_LIMIT`（2 次）是为「弱网 / 5xx / 连接超时」
 * 定的；断流这一档用户什么都没看到时重发是安全的，但**多轮静默重发会把请求量放大**，
 * 而产品要的是「用户无感的一次补救」——成不成，第二次之后就给提示，不再拉着用户干等。
 *
 * 纪律：
 * 1. **不改错误分类**：本文件只处理 `kind` 为 `interrupted` / `idle` 的两档，其余 kind 原样返回
 *    `tone: 'error'`、`retry: false`，由既有的 `errorNotice.ts` 表继续决定文案与按钮；
 * 2. **不改文案文字**：只决定「用哪一档视觉」，具体句子仍由 `describe.ts` 从 i18n 取；
 * 3. **纯模块，不 import 任何东西**：判定要能在 L0 用例里直接跑真代码（同 `timeoutPolicy.ts` 的先例）。
 */

/** 断流两档：连接断掉（interrupted）与连上了但不动（idle） */
export type StreamBreakoutKind = 'interrupted' | 'idle'

/**
 * 提示的视觉语气：
 * - `soft`：中性状态行（用户什么都没看到 / 已经重试过），最轻；
 * - `warn`：警示状态行（内容已收到、需要用户点一下），比 `soft` 显眼，但**不是**报错；
 * - `error`：红色错误条（只在真错误上出现：鉴权 / 额度 / 参数 / 网关…）。
 */
export type StreamBreakoutTone = 'soft' | 'warn' | 'error'

/** 断流两档**实际**会用的语气（永远不含 `error`）：渲染层只接这个类型 */
export type StreamBreakoutSoftTone = Exclude<StreamBreakoutTone, 'error'>

export type StreamBreakoutInput = {
  /** 这一轮**已经向用户输出过**的字符数（正文 + 思考；0 = 一个字都没看到） */
  receivedChars: number
  /** 这一轮是否已经自动重试过（true = 这次失败发生在重试之后） */
  retried: boolean
  /** `ApiError.kind`；不属于断流的值原样放过（不在本文件扩权） */
  kind: string | undefined
}

export type StreamBreakoutDecision = {
  /** 是否自动重发同一条请求（只有「用户还没看到任何内容」且预算没用完时才为 true） */
  retry: boolean
  /** 提示该用什么语气渲染 */
  tone: StreamBreakoutTone
  /** 这一档允许的自动重试**总次数**（0 = 不重试）；调用点用它算「共 N 次」与预算判断 */
  maxRetries: number
}

/**
 * 断流这一档的自动重试上限（**静默**重试，用户无感）。
 *
 * 与 `LIMITS.streamRetryLimit`（2 次，弱网 / 5xx / 连接超时共用）**故意分开**：
 * 那一档的重试会显示「正在第 N 次重试（共 2 次）」，而这一档要的是「悄悄再试一次，
 * 成了就当无事发生；不成再说话」。混用一个数字，要么静默重试变成 2 次（请求被放大，
 * 浏览器验收口径是「网络面板 2 次请求」），要么把弱网重试砍成 1 次（回归 #105）。
 */
export const STREAM_BREAK_RETRY_LIMIT = 1

/** 这个 kind 是不是断流两档之一（其余一律不是本文件的裁决对象） */
export const isStreamBreakoutKind = (kind: string | undefined): kind is StreamBreakoutKind =>
  kind === 'interrupted' || kind === 'idle'

/**
 * **唯一判定处**：给定「收到多少字 / 是否已重试 / 哪一档」，回答「要不要再发一次」与「提示多软」。
 *
 * 判定顺序有讲究（先看 kind、再看内容、最后看预算），三条分支互斥：
 * 1. 不是断流 → 不重发、红色（交给既有错误表）；
 * 2. 是 idle → 不重发（它不是「连接断了」，重发不会更快出字；有内容就说警示，没内容就轻声说）；
 * 3. 已经收到内容 → 不重发（重复输出 / 重复计费的唯一入口就是这里）；
 * 4. 什么都没有 → 静默重试一次，预算用完就软提示。
 */
export const decideStreamBreakout = ({
  receivedChars,
  retried,
  kind,
}: StreamBreakoutInput): StreamBreakoutDecision => {
  // 防御：NaN / 负数字符数按「没收到」处理（调用点算错了也不该判成「有内容」而误伤重试）
  const received = Number.isFinite(receivedChars) && receivedChars > 0
  if (!isStreamBreakoutKind(kind)) {
    return { retry: false, tone: 'error', maxRetries: 0 }
  }
  if (kind === 'idle') {
    return { retry: false, tone: received ? 'warn' : 'soft', maxRetries: 0 }
  }
  if (received) {
    return { retry: false, tone: 'warn', maxRetries: 0 }
  }
  return { retry: !retried, tone: 'soft', maxRetries: STREAM_BREAK_RETRY_LIMIT }
}

/**
 * 断流两档实际会用的语气：这两档**永远**不返回 `error`（红色是鉴权 / 额度 / 参数 / 网关那些
 * 真错误的专属），所以给渲染层一个收窄过的入口 —— 免得到处写 `as` 或各判一次 if。
 *
 * 非断流 kind 传进来时按 `warn` 兜底（而不是 `error`）：调用点写错了也不会把一条断流
 * 重新染成红色报错 —— 那正是这次要修掉的 bug。
 */
export const streamBreakoutTone = (input: StreamBreakoutInput): StreamBreakoutSoftTone => {
  const { tone } = decideStreamBreakout(input)
  return tone === 'error' ? 'warn' : tone
}

/**
 * 一条回复**已经向用户展示过**多少字符（正文 + 思考，工具块不算）。
 *
 * 为什么把思考也算进来：深度思考档里用户在正文出现之前就已经看着思考在滚了 ——
 * 这时候重发同样是「让他把同一段再看一遍」，属于必须拦住的那一类。
 *
 * 入参用结构化类型而不是 `AssistantMessage`：本文件保持零依赖，L0 用例能直接跑真代码。
 */
export const receivedCharsOf = (
  reply: { blocks?: readonly { type: string; text?: string; thinking?: string }[] } | null | undefined
): number => {
  const blocks = reply?.blocks
  if (!blocks || blocks.length === 0) {
    return 0
  }
  return blocks.reduce((total, block) => {
    if (block.type === 'text') {
      return total + (block.text?.length ?? 0)
    }
    if (block.type === 'thinking') {
      return total + (block.thinking?.length ?? 0)
    }
    return total
  }, 0)
}
