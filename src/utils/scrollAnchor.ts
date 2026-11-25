/**
 * 消息列表「阅读位置锚定」的纯计算（Issue #610 症状二）。
 *
 * 为什么需要：虚拟列表（#45）的行高是**实测**出来的，没实测的用估值占位。窗口里新挂上一行、
 * 或者某一行长高（流式回答 / 进入编辑 / 切换版本），上下占位（`topPad` / `bottomPad`）就会跟着变，
 * 于是同一份 `scrollTop` 下，用户正在读的那一行在屏幕上跳一段 —— 长会话上滑「滚到某个位置被弹回去」
 * 就是这么来的。浏览器的 scroll anchoring 反而会帮倒忙：它盯的是一个 DOM 节点，占位 div 一变高变矮
 * 就按自己的判断改 `scrollTop`（实测能一次跳 900+ px），所以滚动容器上已经关掉它（`overflow-anchor: none`，
 * 见 `MessageList.module.css`），改由这里自己算。
 *
 * 坐标系：**内容坐标**（相对滚动内容顶部，与 `scrollTop` 无关）。这样用户滚动不会让锚点失效，
 * 也不需要给 scroll 事件挂任何额外逻辑。
 *
 * 本文件零 DOM、零 React、零依赖，`tests/unit` 可直接 import（ES2017 语法）。
 */

/** 一行在内容坐标系里的位置：`top` = 行顶距内容顶部，`height` = 行高 */
export type RowSpan = {
  id: string
  top: number
  height: number
}

/** 锚点：行 id + 该行顶部在内容坐标系里的偏移 */
export type ScrollAnchor = {
  /** 消息 id，不是下标 —— 编辑会让后面的消息消失、下标会整体前移 */
  id: string
  top: number
}

const finite = (value: number): boolean => Number.isFinite(value)

/**
 * 取「第一条还露出视口顶」的行当锚点（屏幕上看到的第一行）。
 *
 * @param viewportTop 视口顶在**内容坐标**里的位置，即滚动容器的 `scrollTop`
 * @returns 没有行、或者所有行都已经滚到视口上方时返回 null（这时不做修正）
 */
export const pickAnchor = (rows: readonly RowSpan[], viewportTop: number): ScrollAnchor | null => {
  const top = finite(viewportTop) && viewportTop > 0 ? viewportTop : 0
  for (const row of rows) {
    if (!finite(row.top) || !finite(row.height)) {
      continue
    }
    if (row.top + row.height > top) {
      return { id: row.id, top: row.top }
    }
  }
  return null
}

/**
 * 锚点行在新布局里移动了多少像素 —— 也就是需要补进 `scrollTop` 的量。
 *
 * >0：内容被顶下去了（要跟着往下滚）；<0：内容缩短了（要跟着往上收）。
 * 锚点行已经不在传进来的行里（滚出挂载窗口 / 消息被删）时返回 0：宁可不修正，也不要乱跳。
 */
export const anchorShift = (anchor: ScrollAnchor | null, rows: readonly RowSpan[]): number => {
  if (!anchor) {
    return 0
  }
  for (const row of rows) {
    if (row.id === anchor.id) {
      const shift = row.top - anchor.top
      return finite(shift) ? shift : 0
    }
  }
  return 0
}

/* ------------------------------------------------------------------ 钳位（#610 症状二 · 第二层） */
//
// 上面那套坐标全是**内容坐标**，它有一个盲区：浏览器会因为 `scrollHeight` 变短而**静默**
// 把 `scrollTop` 钳到新的 `maxScrollTop`（收起思考正文时整段卸载，内容一次短几千像素）。
// 这次改动没有任何 setter 调用、也没有任何人记账，而 `anchorShift` 是「在当前 scrollTop 上
// 叠加内容坐标增量」—— 对钳位完全无感，于是**钳位丢多少，落点就永久错多少**。
// 390×844 实测（D = 距底）：D=1600 往返 0、D=1000 −225、D=400 −825、D=120 −1730，
// 误差恒等于钳位量。展开永不钳位（只变长），所以「展开还行、收起才跳」。

/** 钳位判定的容差：scrollTop 可能是小数，别把 0.5px 的差当成钳位 */
export const CLAMP_EPS = 0.5

/**
 * 锚点的**视口快照**：除了内容坐标 `top`，再记一行视口坐标。
 *
 * `viewportTop` 用「该行顶部相对滚动容器顶边的偏移」（= `rect.top − 滚动容器 rect.top`
 * = 内容坐标 − 当时的 scrollTop），不是绝对视口坐标 —— 这样键盘弹起、页面上移都不会污染差值。
 */
export type ViewportAnchor = ScrollAnchor & {
  /** 记锚点时该行顶部相对滚动视口顶的偏移；0 = 行顶与视口顶对齐 */
  viewportTop?: number
  /** 记锚点时的 `scrollTop`；识别「浏览器替我们改了位置」要用它 */
  scrollTop?: number
}

/**
 * 这次校正的位移是怎么算出来的（只用于排查与用例断言）：
 * - `viewport`：视口坐标差（A）。量得到锚点行时一律走这条，差值里**天然包含**钳位量
 * - `content`：内容坐标差（原有行为）。用户自己滚动过 / 锚点是老形状没有视口快照时用
 * - `clamp`：量不到锚点行，只能用记账的钳位量兜底（B）
 * - `none`：无处可算
 */
export type AnchorShiftSource = 'viewport' | 'content' | 'clamp' | 'none'

export type AnchorShiftPlan = {
  /** 真正要写进 scrollTop 的量（= `target − scrollTop`，已含欠账结算） */
  shift: number
  /** 落点，已夹到 `[0, maxScrollTop]` */
  target: number
  /** 记账：被浏览器钳掉多少（`viewport` 路径下只记录，**不再叠加**，见下） */
  clampLoss: number
  /** 这一帧付不掉的差额，留到后续帧继续付（0 = 不欠） */
  owed: number
  source: AnchorShiftSource
}

export type AnchorShiftInput = {
  anchor: ViewportAnchor | null
  /** 当前挂载行（内容坐标，来自 `readRowSpans`） */
  rows: readonly RowSpan[]
  /** 当前 scrollTop —— 可能已经被浏览器钳过 */
  scrollTop: number
  /** 当前可滚上限 `scrollHeight − clientHeight` */
  maxScrollTop: number
  /** 这一帧有没有「用户自己滚动过」（有就不用旧锚点的视口快照，也不记账） */
  userMoved?: boolean
  /** 上一帧没付掉的欠账（`AnchorShiftPlan.owed`） */
  owed?: number
}

const clampTop = (value: number, max: number): number => (value < 0 ? 0 : value > max ? max : value)

/**
 * 视口坐标 + 记账的锚点校正量（#610 钳位修复的 A 与 B）。
 *
 * **为什么要视口坐标**：收起时浏览器把 `scrollTop` 钳掉 Δ，锚点行在视口里跟着挪了 Δ。
 * 「现在这一行的视口 top − 当时记下的视口 top」就把 Δ 算进去了，落点自然是 `记录时 st + 内容位移`
 * —— 不用知道钳位发生过。没有钳位时 `scrollTop` 没变，该式恒等于内容位移（现值不变）。
 *
 * **A 与 B 为什么不会重复补偿**（两条路互斥，按顺序只走一条）：
 *   1. 量得到锚点行 → 走 A（`viewport`）。此时 `clampLoss` **只记录、不加进 shift**，
 *      因为视口差里已经含了它，再加一次就是补两遍；
 *   2. 量不到锚点行（虚拟列表里滚出挂载窗口 / 被删）→ 走 B（`clamp`），这时才把记账的
 *      `clampLoss` 当 shift 用；
 *   3. 用户自己滚动过（`userMoved`）→ 两条都不走，退回内容坐标（旧行为），且 `clampLoss` 记 0。
 * 判「这一帧的位置变化能不能归因于钳位」的口径只有一条：**上一帧记下的位置现在已经不可达**
 * （`anchor.scrollTop > maxScrollTop`）。用户自己滚动不可能造成这个局面（钳位早已把他夹在 max 之内），
 * 所以「用户滚动」不会被误当成钳位补回来。
 *
 * **`owed`（欠账）**：目标点可能落在内容之外（内容缩短得比「你离底的距离」还多，这在虚拟列表
 * 估值占位变化时很常见）。这时 `[0, max]` 夹掉多少就记多少，等正文长出来再付 —— 否则钳位
 * 那一段照样是「无人记账」，只是换了个地方丢。
 */
export const anchorShiftViewport = (input: AnchorShiftInput): AnchorShiftPlan => {
  const st = finite(input.scrollTop) ? input.scrollTop : 0
  const max = finite(input.maxScrollTop) && input.maxScrollTop > 0 ? input.maxScrollTop : 0
  const anchor = input.anchor
  const recorded = anchor && finite(anchor.scrollTop as number) ? (anchor.scrollTop as number) : null
  // 只有「上一帧的位置现在整段不可达」才可能有钳位发生过
  const clamped = recorded !== null && recorded > max + CLAMP_EPS
  const clampLoss =
    clamped && !input.userMoved ? Math.max(0, (recorded as number) - Math.min(st, max)) : 0

  let shift = 0
  let source: AnchorShiftSource = 'none'
  const row = anchor ? input.rows.find((item) => item.id === anchor.id) : undefined
  if (anchor && row && finite(row.top)) {
    const viewportTop = anchor.viewportTop
    // 视口快照可用的条件：有快照 + 没有用户手势 + 这一帧的位置变化能归因于钳位
    const attributable =
      recorded !== null &&
      typeof viewportTop === 'number' &&
      finite(viewportTop) &&
      !input.userMoved &&
      (Math.abs(st - recorded) < CLAMP_EPS ||
        (clamped && Math.abs(st - Math.min(recorded, max)) < CLAMP_EPS))
    if (attributable) {
      // A：视口差 = 内容位移 + 被钳掉的量
      shift = row.top - st - (viewportTop as number)
      source = 'viewport'
    } else {
      // 用户滚过 / 老形状锚点：只补内容位移（旧行为），绝不把用户拽回去
      shift = row.top - anchor.top
      source = 'content'
    }
  } else if (clampLoss !== 0) {
    // B：量不到锚点行，只能用记账的钳位量兜底
    shift = clampLoss
    source = 'clamp'
  }
  if (!finite(shift)) {
    shift = 0
  }

  // 欠账结算：只往下欠（往上没有内容可付），付不掉的部分原样留着
  const owedIn =
    !input.userMoved && finite(input.owed as number) && (input.owed as number) > 0
      ? (input.owed as number)
      : 0
  const desired = st + shift + owedIn
  const target = clampTop(finite(desired) ? desired : st, max)
  return {
    shift: target - st,
    target,
    clampLoss,
    owed: Math.max(0, (finite(desired) ? desired : st) - target),
    source,
  }
}
