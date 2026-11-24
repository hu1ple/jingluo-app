import { Fragment, createElement, type ReactElement, type ReactNode } from 'react'

/**
 * 消息列表虚拟化的纯计算 + 渲染层（不含任何样式、不碰 store）。
 *
 * 背景（Issue #45）：`MessageList` 之前把 `getVisibleMessages(session)` 全量 `map` 成节点，
 * 长会话里 DOM 节点数随历史条数线性增长，会话越老越卡。
 *
 * 这里的约定：
 * 1. **高度一行都不许假设是固定值。** 一条消息的高度只有挂载后实测才知道（流式增长的回答还在变），
 *    未实测的行用估值占位，实测到的行立刻覆盖估值 —— 见 `buildLayout`。
 * 2. **挂载窗口只看滚动位置，不看总条数。** 视口高度 + 上下各一段 overscan 之外仅保留正在编辑的行，
 *    未挂载的连续行用占位块（topPad / bottomPad）撑住滚动高度，滚动条长度、滚回顶部都不变。
 * 3. 窗口计算和真正决定「挂载哪些节点」的是同一份代码（`findWindow` → `VirtualRows`），
 *    所以 `tests/unit/message-list-virtual.test.mjs` 用 renderToStaticMarkup 数出来的节点数，
 *    就是组件实际挂载的节点数。
 */

/** 一条消息都没实测过时的兜底估值（px）。 */
export const DEFAULT_ESTIMATE = 120

/** 视口上下额外挂载的像素高度：滚动时先有内容，不至于白屏。 */
export const OVERSCAN_PX = 800

export type RowsLayout = {
  /** 每行的实际高度：实测值优先，否则估值。 */
  heights: number[]
  /** 每行的 top 偏移，`offsets[i] + heights[i] === offsets[i + 1]`。 */
  offsets: number[]
  /** 全部行加起来的总高度，用于撑住滚动条。 */
  total: number
}

export type RowsWindow = {
  /** 挂载窗口 [start, end)，end 不含。 */
  start: number
  end: number
  /** 窗口上方未挂载行的高度和。 */
  topPad: number
  /** 窗口下方未挂载行的高度和。 */
  bottomPad: number
}

const isMeasured = (value: number | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0

/** 实测高度优先；没有实测（或实测无效）就用估值。 */
export const resolveHeights = (
  measured: readonly (number | undefined)[],
  estimate: number = DEFAULT_ESTIMATE
): number[] => {
  const fallback = isMeasured(estimate) ? estimate : DEFAULT_ESTIMATE
  return measured.map((value) => (isMeasured(value) ? value : fallback))
}

/** 高度表 → 偏移表。实测值和估值混在一起算，所以流式增长的行撑开后后面的行会自动往下让。 */
export const buildLayout = (
  measured: readonly (number | undefined)[],
  estimate: number = DEFAULT_ESTIMATE
): RowsLayout => {
  const heights = resolveHeights(measured, estimate)
  const offsets = new Array<number>(heights.length)
  let total = 0
  for (let index = 0; index < heights.length; index += 1) {
    offsets[index] = total
    total += heights[index]
  }
  return { heights, offsets, total }
}

/** 第一个 `offsets[index] >= value` 的下标；找不到返回数组长度。 */
const lowerBound = (offsets: readonly number[], value: number): number => {
  let low = 0
  let high = offsets.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (offsets[middle] < value) {
      low = middle + 1
    } else {
      high = middle
    }
  }
  return low
}

/**
 * 按滚动位置算挂载窗口。
 *
 * `anchorEnd` = 贴底（用户停在最新消息 / 正在流式输出）：直接按「滚到底」算窗口，
 * 这样首帧就把最后几条挂上，自动滚到底和流式跟随不会先闪一下空白，再等第二次渲染。
 */
export const findWindow = ({
  layout,
  scrollTop,
  viewport,
  overscan = OVERSCAN_PX,
  anchorEnd = false,
}: {
  layout: RowsLayout
  scrollTop: number
  viewport: number
  overscan?: number
  anchorEnd?: boolean
}): RowsWindow => {
  const count = layout.heights.length
  if (count === 0) {
    return { start: 0, end: 0, topPad: 0, bottomPad: 0 }
  }

  const height = isMeasured(viewport) ? viewport : 0
  const maxScrollTop = Math.max(0, layout.total - height)
  const top = anchorEnd ? maxScrollTop : Math.min(Math.max(scrollTop, 0), maxScrollTop)
  const margin = Number.isFinite(overscan) && overscan > 0 ? overscan : 0

  const from = top - margin
  const to = top + height + margin

  // 起点：第一行「底部在 from 之下」的行。先二分再往回退一格，兼容 overscan 落在一行中间。
  let start = Math.max(0, lowerBound(layout.offsets, from) - 1)
  while (start + 1 < count && layout.offsets[start] + layout.heights[start] <= from) {
    start += 1
  }

  // 终点：最后一行「顶部在 to 之上」的行，end 不含。
  let end = Math.max(start + 1, lowerBound(layout.offsets, to))
  end = Math.min(end, count)

  const topPad = layout.offsets[start]
  const lastIndex = end - 1
  const bottomPad = Math.max(0, layout.total - (layout.offsets[lastIndex] + layout.heights[lastIndex]))
  return { start, end, topPad, bottomPad }
}

export type VirtualRowsProps<T> = {
  /** 全量数据（长会话可能是几千条）。 */
  items: readonly T[]
  retainedIds?: ReadonlySet<string>
  /** 与 `items` 对齐的实测高度表，没有实测的位置留 undefined。 */
  measured: readonly (number | undefined)[]
  /** 未实测行的估值。 */
  estimate?: number
  /** 滚动容器当前的 scrollTop。 */
  scrollTop?: number
  /** 滚动容器的可见高度；量不到先给 0，窗口会退化成只有 overscan。 */
  viewport?: number
  /** 实测回填前可见的消息及其原内容坐标。 */
  measureAnchor?: { index: number; id: string; top: number } | null
  /** 贴底时按「滚到底」算窗口。 */
  anchorEnd?: boolean
  overscan?: number
  getId: (item: T, index: number) => string
  renderItem: (item: T, index: number) => ReactElement
}

/**
 * 只渲染窗口内行的列表容器：
 * `[上方占位][窗口内的行][下方占位]`，行本身带 `data-row-id` / `data-row-index`
 * 供外层按行实测高度、按 id 定位。
 */
export const VirtualRows = <T,>({
  items,
  retainedIds,
  measured,
  estimate = DEFAULT_ESTIMATE,
  scrollTop = 0,
  viewport = 0,
  anchorEnd = false,
  measureAnchor,
  overscan = OVERSCAN_PX,
  getId,
  renderItem,
}: VirtualRowsProps<T>): ReactElement => {
  const layout = buildLayout(measured, estimate)
  // 按新的内容坐标选择窗口，让旧锚点在父组件补偿 scrollTop 时仍在 DOM 中。
  const shift = measureAnchor && measureAnchor.index >= 0 && measureAnchor.index < items.length &&
    getId(items[measureAnchor.index], measureAnchor.index) === measureAnchor.id
    ? layout.offsets[measureAnchor.index] - measureAnchor.top
    : 0
  const window = findWindow({ layout, scrollTop: scrollTop + shift, viewport, overscan, anchorEnd })

  const children: ReactNode[] = []
  let cursor = 0
  const addSpacer = (end: number) => {
    if (end <= cursor) {
      return
    }
    const bottom = end === items.length
    const endOffset = bottom ? layout.total : layout.offsets[end]
    children.push(createElement('div', {
      key: bottom ? 'virtual-bottom-spacer' : `virtual-spacer-before:${getId(items[end], end)}`,
      'data-virtual-spacer': bottom ? 'bottom' : cursor === 0 ? 'top' : 'gap',
      'aria-hidden': true,
      style: { height: endOffset - layout.offsets[cursor] },
    }))
  }
  const addRow = (index: number) => {
    addSpacer(index)
    const id = getId(items[index], index)
    children.push(createElement(
      'div',
      { key: `row:${id}`, 'data-row-id': id, 'data-row-index': index },
      renderItem(items[index], index)
    ))
    cursor = index + 1
  }

  // 窗口外仅挂载正在编辑的行。保持原有顺序和 key，让输入框、光标与输入法状态一起保留下来。
  const hasRetained = Boolean(retainedIds?.size)
  const start = hasRetained ? 0 : window.start
  const end = hasRetained ? items.length : window.end
  for (let index = start; index < end; index += 1) {
    if ((index >= window.start && index < window.end) || retainedIds?.has(getId(items[index], index))) {
      addRow(index)
    }
  }
  addSpacer(items.length)
  return createElement(Fragment, null, children)
}
