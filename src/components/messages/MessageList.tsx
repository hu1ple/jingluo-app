import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useIsMobile } from '../../app/viewport.js'
import {
  buildMessageVersions,
  getVisibleMessages,
  type MessageVersions,
} from '../../services/chat/branches.js'
import { selectMessageVersion } from '../../services/chat/store.js'
import type { Session } from '../../services/chat/types.js'
import { closeSearchPanel } from '../search/searchPanelState.js'
import { prefersReducedMotion } from '../../utils/usePresence.js'
import {
  CLAMP_EPS,
  anchorShiftViewport,
  pickAnchor,
  type RowSpan,
  type ViewportAnchor,
} from '../../utils/scrollAnchor.js'
import { AssistantMessage } from './AssistantMessage.js'
import { ScrollToBottomContext, ScrollToBottomStateContext } from './scrollContext.js'
import { UserMessage } from './UserMessage.js'
import { DEFAULT_ESTIMATE, VirtualRows } from './virtualRows.js'
import {
  decideAnchorCorrection,
  editorCenterPlan,
  isEditorTargetLive,
} from './scrollGuard.js'
import type { Message } from '../../services/chat/types.js'

/**
 * 会话共用可重试的附件上传失败入口，覆盖当前提问与历史消息中的附件。
 * 点击后按失败的回答重新补传附件并请求。
 */
const getUploadRetryId = (messages: Message[], streaming: boolean) => {
  const last = messages.at(-1)
  return !streaming &&
    last?.role === 'assistant' &&
    last.status === 'error' &&
    last.error?.kind === 'upload' &&
    last.error.retryable
    ? last.id
    : null
}
import styles from './MessageList.module.css'

/** 距底部小于该值时视为在底部，流式内容增长时跟随 */
const STICKY_THRESHOLD = 40
/**
 * #386：距底部超过该值时，输入框上方才浮现「回到底部」按钮。
 * 比 `STICKY_THRESHOLD`（40）大得多是刻意的 —— 刚离开底部一两行还在视野里，
 * 这时候弹按钮只会挡住正文；翻上去一两屏才是真的需要它。
 */
const TO_BOTTOM_THRESHOLD = 200
/**
 * #610 钳位修复：用户自己滚过之后多久内不再用「旧锚点的视口快照」。
 * 视口快照记的是「那一刻这一行在屏幕上哪」，用户滚过它就作废了 —— 这条时间窗只是兜底，
 * 真正的判据是 `anchorShiftViewport` 里的「位置变化能不能归因于钳位」。
 */
const USER_SCROLL_WINDOW = 500
const EMPTY_VERSIONS: MessageVersions = { ids: [], index: -1 }

/**
 * #386：平滑滚到最底部。
 *
 * 老内核不认 `scrollTo` 的 options 对象时会把对象当成坐标（NaN，静默不动），
 * 所以先用 `scrollBehavior` 特性检测兜一层，再用 try/catch 兜一层，两条都不成立就
 * 直接赋值 scrollTop —— 功能不丢，只是没有过渡。系统要求「减少动态效果」时同理：
 * 平滑滚动本身也是动态效果。
 */
const smoothScrollToBottom = (element: HTMLElement) => {
  if (prefersReducedMotion() || !('scrollBehavior' in element.style)) {
    element.scrollTop = element.scrollHeight
    return
  }
  try {
    element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' })
  } catch {
    element.scrollTop = element.scrollHeight
  }
}

/**
 * #610：读出挂载窗口里「锚点行」与「第一条可见行」为止的几行几何（内容坐标）。
 *
 * 只读到够用为止（锚点行 + 首条可见行），不遍历整份列表：长会话里挂载的行本来就只有
 * 视口 ± overscan 这一小段。行序与 DOM 顺序一致，所以拿到首条可见行就能提前收工。
 */
const readRowSpans = (
  scroll: HTMLElement,
  content: HTMLElement,
  anchorId: string | null
): (RowSpan & { index: number })[] => {
  // 内容坐标原点：滚动容器自身的内容顶部（rect.top 是视口坐标，加回 scrollTop 即内容坐标）
  const base = scroll.getBoundingClientRect().top - scroll.scrollTop
  const spans: (RowSpan & { index: number })[] = []
  let foundAnchor = anchorId === null
  let foundVisible = false
  for (const row of content.querySelectorAll<HTMLElement>('[data-row-id]')) {
    const id = row.dataset.rowId
    if (!id) {
      continue
    }
    const box = row.getBoundingClientRect()
    spans.push({ id, index: Number(row.dataset.rowIndex), top: box.top - base, height: box.height })
    if (id === anchorId) {
      foundAnchor = true
    }
    if (box.bottom - base > scroll.scrollTop) {
      foundVisible = true
    }
    if (foundAnchor && foundVisible) {
      break
    }
  }
  return spans
}

/**
 * 消息列表（虚拟化，Issue #45）。
 *
 * 只挂载视口附近的行：行高由 `ResizeObserver` 按行实测（流式增长的回答随时在变），
 * 未实测到的行用估值占位，滚动条长度靠上下占位撑住 —— 所以长会话的 DOM 节点数
 * 与历史总条数无关。窗口计算见 `virtualRows.ts`。
 */
export const MessageList = ({
  session,
  streaming,
  footer,
}: {
  session: Session
  streaming: boolean
  footer: React.ReactNode
}) => {
  const isMobile = useIsMobile()
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const stickyRef = useRef(true)
  /** #386：点「回到底部」后平滑滚动是否还在路上（在路上时不写 scrollTop，否则动画被掐断） */
  const jumpRef = useRef(false)
  const scrollTopRef = useRef(0)
  const restoreScrollRef = useRef<{ messageId: string; top: number } | null>(null)
  /** 消息 id → 实测高度；会话切换时清空，避免带上一个会话的估值。 */
  const heightsRef = useRef(new Map<string, number>())
  const measureRef = useRef<ResizeObserver | null>(null)
  const observedRowsRef = useRef(new Set<Element>())
  /**
   * #610：上一次提交时「第一条可见行」的锚点（id + 内容坐标系偏移）。
   * 行高实测回填 / 估值变化会改动上方占位，靠它把阅读位置钉住，见文件末尾那条 layout effect。
   */
  const measureAnchorRef = useRef<(ViewportAnchor & { index: number }) | null>(null)
  const anchorRef = useRef<(ViewportAnchor & { index: number; scrollTop: number }) | null>(null)
  /**
   * #610 钳位修复的账本：锚点校正的目标点偶尔落在内容之外（内容缩短得比「距底距离」还多），
   * `[0, maxScrollTop]` 夹掉的那一截记在这里，等正文长出来再付 —— 否则这一截照样是
   * 「钳位丢多少落点错多少」，只是换了个地方丢。
   */
  const clampOwedRef = useRef(0)
  /** 我们自己最后一次写 scrollTop 的值与时间：滚动事件里要把「自己的写」与「用户滚」分开 */
  const ownWriteRef = useRef({ value: Number.NaN, at: 0 })
  /** 用户自己滚动的最近时刻（非钳位、非我们自己的写）；超过 `USER_SCROLL_WINDOW` 视为没动 */
  const userScrolledAtRef = useRef(0)
  /** #610：本帧的滚动位置是「故意挪的」（版本切换定位），不要被锚点修正拉回去。 */
  const skipAnchorRef = useRef(false)
  const sessionIdRef = useRef(session.id)
  // 实测结果存在 ref 里，靠这个版本的计数触发重算占位。
  const [, setMeasureVersion] = useState(0)
  const [metrics, setMetrics] = useState({ top: 0, viewport: 0 })
  const [editingIds, setEditingIds] = useState(() => new Set<string>())
  const openingEditor = useRef<{ id: string; textarea: HTMLTextAreaElement } | null>(null)
  /**
   * Bug A-1：这一轮**已经居中过**的编辑框消息 id。
   * 原来每帧都重新居中，于是「编辑框一直有焦点」时列表被钉在编辑框上，流式内容全被拽回去。
   */
  const centeredEditorRef = useRef<string | null>(null)
  /** `positionOpeningEditor` 要在 layout effect 里读到最新的编辑集合，又不能让回调身份每帧都变。 */
  const editingIdsRef = useRef<Set<string>>(editingIds)
  editingIdsRef.current = editingIds
  /**
   * Bug B：锚点校正的收敛状态。
   * `previousShift` = 上一次真落地的校正量，`streak` = 本轮连续尝试次数（含被拒的），
   * `blocked` = 本轮已判自激。三者只由**用户手势**（wheel / touchstart / pointerdown / 键盘）清零，
   * 否则我们自己的写入会不断重置它，链永远截不断。
   */
  const anchorGuardRef = useRef({ previousShift: 0, streak: 0, blocked: false })
  const resetAnchorGuard = useCallback(() => {
    anchorGuardRef.current = { previousShift: 0, streak: 0, blocked: false }
    // 用户动手了：欠账与「用户滚过」的标记一起作废 —— 位置归用户说了算
    clampOwedRef.current = 0
    userScrolledAtRef.current = 0
  }, [])
  const onEditingChange = useCallback(
    (id: string, editing: boolean, textarea?: HTMLTextAreaElement | null) => {
      if (editing && textarea) {
        openingEditor.current = { id, textarea }
        centeredEditorRef.current = null
      } else if (openingEditor.current?.id === id) {
        openingEditor.current = null
        centeredEditorRef.current = null
      }
      setEditingIds((previous) => {
        const next = new Set(previous)
        if (editing) {
          next.add(id)
        } else {
          next.delete(id)
        }
        return next
      })
    },
    []
  )
  // 键盘弹出会改变消息区高度，虚拟行实测会改变编辑框位置。两者都按当前 DOM 定位。
  /**
   * Bug A：把「刚打开的编辑框」挪到视口中间。
   *
   * 三处收紧（原来这里是无条件关贴底 + 每帧重新居中 + 不校验引用）：
   *   1. A-2 先验目标还活着（消息仍在 `editingIds`、`textarea` 仍连着文档、焦点仍在它身上），
   *      陈旧的 textarea 引用一律返回 false —— 发送后拿它的 rect 去定位就是把列表往上拽；
   *   2. A-1 只有真的要挪（|shift| ≥ 1）才关掉贴底 / 平滑滚动标记；
   *   3. A-1 同一条消息这一轮只居中一次，之后再进这个函数只「占位」（返回 true，让
   *      ResizeObserver 那条路别再贴底），不会再写 scrollTop。
   */
  const positionOpeningEditor = useCallback(() => {
    const scroll = scrollRef.current
    const target = openingEditor.current
    const textarea = target?.textarea
    const editor = textarea?.parentElement
    if (!isMobile || !scroll || !target || !textarea || !editor) {
      return false
    }
    if (
      !isEditorTargetLive({
        messageId: target.id,
        editingIds: editingIdsRef.current,
        isConnected: textarea.isConnected,
        focused: document.activeElement === textarea,
      })
    ) {
      return false
    }
    const viewport = scroll.getBoundingClientRect()
    const field = textarea.getBoundingClientRect()
    const box = editor.getBoundingClientRect()
    const centered = (viewport.top + viewport.bottom - field.height) / 2
    // 让输入区域居中，同时给下方的取消、发送按钮留出空间。
    const targetTop = Math.max(
      viewport.top + (field.top - box.top),
      Math.min(centered, viewport.bottom - (box.bottom - field.top))
    )
    const plan = editorCenterPlan({
      targetTop,
      currentTop: field.top,
      alreadyCentered: centeredEditorRef.current === target.id,
    })
    if (plan.shift !== 0) {
      centeredEditorRef.current = target.id
      scroll.scrollTop += plan.shift
      scrollTopRef.current = scroll.scrollTop
      // 这也是「我们自己写的位置」：滚动事件里不许记成「用户自己滚」（#610 钳位修复）
      ownWriteRef.current = { value: scroll.scrollTop, at: Date.now() }
    }
    if (!plan.keepSticky) {
      stickyRef.current = false
      jumpRef.current = false
    }
    return true
  }, [isMobile])
  const messages = getVisibleMessages(session)
  const [previousVersions, setPreviousVersions] = useState(() =>
    buildMessageVersions(session, new Map())
  )
  const versions = useMemo(
    () => buildMessageVersions(session, previousVersions),
    [session, previousVersions]
  )
  if (versions !== previousVersions) {
    setPreviousVersions(versions)
  }
  const lastMessageId = messages.at(-1)?.id
  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current
    if (!el) {
      return
    }
    if (jumpRef.current) {
      // 平滑滚动还在路上：这时候写 scrollTop 会把原生动画掐掉（用户看到的就是「点了没动，然后瞬移」）。
      // 内容若又长高了，就朝新的底部再发起一次，落点始终是最新消息。
      smoothScrollToBottom(el)
      return
    }
    if (stickyRef.current) {
      el.scrollTop = el.scrollHeight
      scrollTopRef.current = el.scrollTop
      // 跟随式写入同样是「我们写的」，滚动事件里不许记成用户手势（#610 钳位修复）
      ownWriteRef.current = { value: el.scrollTop, at: Date.now() }
    }
  }, [])

  // #386：输入框上方「回到底部」按钮的状态。默认隐藏 —— 首次进会话就在底部，不该有按钮。
  const [toBottom, setToBottom] = useState({ visible: false, hasNew: false })
  const toBottomRef = useRef(toBottom)
  // 圆点只在流式期间点亮：虚拟列表上翻时行高会重新实测、内容高度跟着抖，
  // 只看「长高了」会把这种抖动当成新内容；流式里长高才是真的来了新 token。
  const streamingRef = useRef(streaming)
  streamingRef.current = streaming

  /**
   * #386：按当前位置刷新按钮状态；只在布尔值真的变了才 setState（滚动事件每帧都来）。
   * @param grew 内容高度刚长高（流式追加 / 新消息）时为 true，记一条「有新内容」
   */
  const syncToBottom = useCallback((grew: boolean) => {
    const el = scrollRef.current
    if (!el) {
      return
    }
    const away = el.scrollHeight - el.scrollTop - el.clientHeight > TO_BOTTOM_THRESHOLD
    const previous = toBottomRef.current
    const next = {
      visible: away,
      hasNew: away && ((grew && streamingRef.current) || previous.hasNew),
    }
    if (next.visible === previous.visible && next.hasNew === previous.hasNew) {
      return
    }
    toBottomRef.current = next
    setToBottom(next)
  }, [])

  /**
   * #386：点「回到底部」—— 先恢复跟随（后续新内容继续自动贴底），再滚到底。
   * 平滑滚动只在**真的支持**时用：`scrollBehavior` 特性检测 + try/catch 双保险，
   * 老 WebView 不认 options 对象时退回直接赋值（否则对象被当成坐标，滚不动）。
   * 系统开了「减少动态效果」时也直接跳 —— 平滑滚动同样是动态效果。
   */
  const jumpToBottom = useCallback(() => {
    const el = scrollRef.current
    if (!el) {
      return
    }
    // 先恢复跟随：动画落地后新内容继续自动贴底（这是 Issue 验收里的「点击后恢复跟随」）
    stickyRef.current = true
    jumpRef.current = true
    // 用户主动回到列表这头，之前判过的「自激」不再有意义（Bug B）
    resetAnchorGuard()
    smoothScrollToBottom(el)
  }, [resetAnchorGuard])

  // 行实测高度 → 未实测行的估值。用已实测高度的均值，比固定常量更接近真实内容。
  let measuredSum = 0
  let measuredCount = 0
  for (const height of heightsRef.current.values()) {
    measuredSum += height
    measuredCount += 1
  }
  const estimate =
    measuredCount === 0
      ? DEFAULT_ESTIMATE
      : Math.max(DEFAULT_ESTIMATE / 2, Math.round(measuredSum / measuredCount))

  const measured = messages.map((message) => heightsRef.current.get(message.id))

  // 内容、键盘和输入框高度变化时，继续遵循当前跟随状态。
  useLayoutEffect(() => {
    const content = contentRef.current
    const scroll = scrollRef.current
    if (!content || !scroll) {
      return
    }
    const observer = new ResizeObserver((entries) => {
      setMetrics((previous) =>
        previous.viewport === scroll.clientHeight
          ? previous
          : { ...previous, viewport: scroll.clientHeight }
      )
      if (!positionOpeningEditor()) {
        scrollToBottom()
      }
      // 内容长高而用户已经翻上去时不会触发 scroll 事件，只能在这里补一次判断（#386）
      syncToBottom(entries.some((entry) => entry.target === content))
    })
    observer.observe(content)
    observer.observe(scroll)
    const releaseEditor = () => {
      openingEditor.current = null
    }
    const events = ['touchstart', 'wheel', 'pointerdown', 'input', 'focusout']
    for (const event of events) {
      scroll.addEventListener(event, releaseEditor, { passive: true })
    }
    // Bug B：用户真的动了（滚轮 / 触摸 / 指针 / 键盘 / 输入）才解封锚点校正的收敛状态。
    // 不能挂在 scroll 事件上 —— 我们自己的校正写入也会触发 scroll，那样刚判的自激立刻被清零。
    const gestures = [...events, 'keydown']
    for (const event of gestures) {
      scroll.addEventListener(event, resetAnchorGuard, { passive: true })
    }
    return () => {
      observer.disconnect()
      for (const event of events) {
        scroll.removeEventListener(event, releaseEditor)
      }
      for (const event of gestures) {
        scroll.removeEventListener(event, resetAnchorGuard)
      }
    }
  }, [positionOpeningEditor, resetAnchorGuard, scrollToBottom, syncToBottom])

  // 单例行高实测：挂载/卸载行时订阅、退订，高度变化（流式增长、版本切换）时重算占位。
  useLayoutEffect(() => {
    const observer = new ResizeObserver((entries) => {
      let changed = false
      for (const entry of entries) {
        const target = entry.target as HTMLElement
        const id = target.dataset.rowId
        if (!id || !target.isConnected) {
          continue
        }
        const blockSize = entry.borderBoxSize?.[0]?.blockSize
        const height =
          typeof blockSize === 'number' && blockSize > 0
            ? blockSize
            : target.getBoundingClientRect().height
        if (!(height > 0)) {
          continue
        }
        const previous = heightsRef.current.get(id)
        if (previous === undefined || Math.abs(previous - height) >= 0.5) {
          heightsRef.current.set(id, height)
          changed = true
        }
      }
      if (changed) {
        const scroll = scrollRef.current
        const content = contentRef.current
        if (scroll && content && !stickyRef.current && !jumpRef.current) {
          const previous = anchorRef.current
          // 位置被浏览器钳过：上一帧记的可达位置现在已越过新 max（用户自己滚动做不到这件事）。
          // 这种情况同样要用**旧锚点** —— 钳位把锚点行在视口里挪了，视口坐标差里记着它（#610）。
          const clamped = previous !== null && (previous.scrollTop ?? 0) > scroll.scrollHeight - scroll.clientHeight + CLAMP_EPS
          if (previous && (previous.scrollTop === scroll.scrollTop || clamped)) {
            // 用户停在原处时用上次布局的坐标，保留上方行自身长高之前的阅读位置。
            measureAnchorRef.current = previous
          } else {
            const rows = readRowSpans(scroll, content, null)
            const row = rows.find(
              item =>
                item.top + item.height > scroll.scrollTop &&
                item.top < scroll.scrollTop + scroll.clientHeight
            )
            // 重新取的锚点也要带视口快照，否则下一次校正会退回内容坐标（丢了钳位那一段）
            measureAnchorRef.current = row
              ? { ...row, scrollTop: scroll.scrollTop, viewportTop: row.top - scroll.scrollTop }
              : null
          }
        }
        setMeasureVersion((version) => version + 1)
      }
    })
    measureRef.current = observer
    return () => {
      observer.disconnect()
      measureRef.current = null
      observedRowsRef.current = new Set()
    }
  }, [])

  // 每次提交后同步「当前挂载了哪些行」，让实测覆盖到新进窗口的行，并退订已卸载的行。
  useLayoutEffect(() => {
    const observer = measureRef.current
    const content = contentRef.current
    if (!observer || !content) {
      return
    }
    const next = new Set<Element>()
    for (const row of content.querySelectorAll<HTMLElement>('[data-row-id]')) {
      next.add(row)
      observer.observe(row)
    }
    for (const row of observedRowsRef.current) {
      if (!next.has(row)) {
        observer.unobserve(row)
      }
    }
    observedRowsRef.current = next
  })

  // 会话切换：上一个会话的实测高度不再有意义，清空后重新量。
  useLayoutEffect(() => {
    if (sessionIdRef.current !== session.id) {
      sessionIdRef.current = session.id
      heightsRef.current.clear()
      anchorRef.current = null
      resetAnchorGuard()
      centeredEditorRef.current = null
      setMeasureVersion((version) => version + 1)
    }
  }, [resetAnchorGuard, session.id])

  // 切换版本后将选择器留在原位置，避免回答长短变化导致操作区跳出视口。
  useLayoutEffect(() => {
    const anchor = restoreScrollRef.current
    const scroll = scrollRef.current
    if (anchor && scroll) {
      const switcher = scroll.querySelector<HTMLElement>(
        `[data-message-version="${CSS.escape(anchor.messageId)}"]`
      )
      if (switcher) {
        scroll.scrollTop += switcher.getBoundingClientRect().top - anchor.top
        // 这一跳是「把版本选择器留在原处」的故意定位，本帧不再做阅读位置修正（#610）
        skipAnchorRef.current = true
      }
      restoreScrollRef.current = null
      return
    }
    stickyRef.current = true
    scrollToBottom()
  }, [session.id, lastMessageId, scrollToBottom])

  useEffect(closeSearchPanel, [session.id, lastMessageId])

  const selectVersion = useCallback(
    (messageId: string, anchorTop: number) => {
      if (streaming) {
        return
      }
      restoreScrollRef.current = { messageId, top: anchorTop }
      stickyRef.current = false
      closeSearchPanel()
      selectMessageVersion(session.id, messageId)
    },
    [session.id, streaming]
  )

  const syncMetrics = useCallback((el: HTMLElement) => {
    const top = el.scrollTop
    const viewport = el.clientHeight
    setMetrics((previous) =>
      previous.top === top && previous.viewport === viewport ? previous : { top, viewport }
    )
  }, [])

  /**
   * Bug B：锚点校正里**不许**同步 setState（原来那句 `syncMetrics(scroll)` 就在校正分支里）。
   *
   * 那条环是：校正写 scrollTop → 同步 setState → 新提交 → 又校正 → …… 实测在长会话里
   * 连写 54 次 `1414 ↔ 1246`（27 次振荡）后 React 抛 `Maximum update depth exceeded`。
   * 这里合并到下一帧，且同一帧只排一次；校正分支本身另有反号 / 次数上限两道闸。
   */
  const metricsFrameRef = useRef(0)
  const syncMetricsSoon = useCallback(
    (el: HTMLElement) => {
      if (metricsFrameRef.current) {
        return
      }
      if (typeof requestAnimationFrame !== 'function') {
        syncMetrics(el)
        return
      }
      metricsFrameRef.current = requestAnimationFrame(() => {
        metricsFrameRef.current = 0
        syncMetrics(el)
      })
    },
    [syncMetrics]
  )
  useEffect(
    () => () => {
      if (metricsFrameRef.current) {
        cancelAnimationFrame(metricsFrameRef.current)
        metricsFrameRef.current = 0
      }
    },
    []
  )

  // 跨移动端断点时切换滚动层，并保持输入框及当前阅读位置。
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) {
      return
    }
    if (stickyRef.current) {
      scrollToBottom()
    } else {
      el.scrollTop = scrollTopRef.current
    }
    syncMetrics(el)
    const onScroll = () => {
      const max = el.scrollHeight - el.clientHeight
      const previous = scrollTopRef.current
      const nearBottom = max - el.scrollTop < STICKY_THRESHOLD
      // 这一次位置变化的来源：我们自己的写入 / 浏览器钳位 / 用户自己滚。
      // 前两者都**不是**「用户想跟到底部」或「用户改了阅读位置」的意思：
      //  - 有欠账（钳位把我们顶到了底部）时不许把贴底打开，否则流式内容一长高就把刚恢复的位置拽走；
      //  - 用户自己滚的定义收紧成「位置变了 + 上一帧位置本来是可达的（没被钳过）+ 不是我们写的」。
      const own = Math.abs(el.scrollTop - ownWriteRef.current.value) < 1 && Date.now() - ownWriteRef.current.at < 500
      const clampedBefore = previous > max + CLAMP_EPS
      if (!own && !clampedBefore && el.scrollTop < previous) {
        userScrolledAtRef.current = Date.now()
      }
      // 仅在用户向上滚动时停止跟随底部，布局或内容增高时保持跟随状态。
      if (nearBottom && clampOwedRef.current === 0) {
        stickyRef.current = true
        // 平滑滚动落地（或用户自己滑回底部）：跟随逻辑可以正常写位置了
        jumpRef.current = false
      } else if (el.scrollTop < previous) {
        stickyRef.current = false
        jumpRef.current = false
      }
      scrollTopRef.current = el.scrollTop
      syncMetrics(el)
      // 用户翻到离底部超过阈值 → 按钮浮现；回到贴底区 → 按钮与「有新内容」圆点一起收掉
      syncToBottom(false)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [isMobile, scrollToBottom, syncToBottom, syncMetrics])

  /**
   * #610（症状二）：把阅读位置钉住。
   *
   * 虚拟列表的行高是实测出来的，没实测的用估值（实测均值）。窗口里新挂上一行、或流式回答长高，
   * 都会改动上方占位的总高 —— 同一份 scrollTop 下，用户正在读的那一行就跳一段，
   * 表现出来正是长会话上滑「滚到某个位置被弹回去」。这里每次提交后记下第一条可见行
   * （`pickAnchor`），下一次提交算出它移动了多少（`anchorShift`），再把这个量补进 scrollTop。
   * layout effect 阶段执行，早于绘制，所以不会闪中间态。
   *
   * 三种情况不修正：贴底跟随（#386 由 scrollToBottom 负责）、版本切换的故意定位、
   * 以及锚点行已经不在列表里（编辑截断 / 删消息 —— 这时宁可不挪）。
   *
   * Bug B：**校正必须收敛**。原来只要位移 ≥ 0.5 就补，补完还在校正里同步 setState 把链续上，
   * 于是「补 168 → 下一帧 −168 → 再补 168」自激：长会话来回滚 3 轮实测写 54 次、振荡 27 次，
   * React 抛 `Maximum update depth exceeded`，整个 `<MessageList>` 被卸掉（prod 构建同样复现）。
   * 现在判定交给 `decideAnchorCorrection`（反号放弃 / 连续次数到顶放弃 / 已判自激钉住），
   * 且校正里不再同步 setState（改 rAF 合并），这条环两头都断了。
   */
  useLayoutEffect(() => {
    const scroll = scrollRef.current
    const content = contentRef.current
    if (!scroll || !content) {
      return
    }
    const skip = skipAnchorRef.current
    skipAnchorRef.current = false
    const anchor = measureAnchorRef.current ?? anchorRef.current
    measureAnchorRef.current = null
    const rows = readRowSpans(scroll, content, anchor?.id ?? null)
    if (!skip && !positionOpeningEditor() && !stickyRef.current && !jumpRef.current) {
      const guard = anchorGuardRef.current
      // A：视口坐标（差值里天然含钳位）；量不到锚点行时才用 B（记账的钳位量）。
      // 两条路互斥，plan 只出一个 shift —— 见 `anchorShiftViewport` 的注释，这里不会补两遍。
      const plan = anchorShiftViewport({
        anchor,
        rows,
        scrollTop: scroll.scrollTop,
        maxScrollTop: scroll.scrollHeight - scroll.clientHeight,
        userMoved:
          userScrolledAtRef.current > 0 && Date.now() - userScrolledAtRef.current < USER_SCROLL_WINDOW,
        owed: clampOwedRef.current,
      })
      const decision = decideAnchorCorrection({
        shift: plan.shift,
        previousShift: guard.previousShift,
        sticky: stickyRef.current,
        jump: jumpRef.current,
        streak: guard.streak,
        blocked: guard.blocked,
      })
      if (decision.apply) {
        guard.previousShift = decision.shift
        guard.streak += 1
        // 落点用 plan.target（已夹到 [0, scrollHeight − clientHeight]），别把自己顶出范围
        const max = scroll.scrollHeight - scroll.clientHeight
        const target = Math.max(0, Math.min(plan.target, max))
        ownWriteRef.current = { value: target, at: Date.now() }
        scroll.scrollTop = target
        scrollTopRef.current = scroll.scrollTop
        // 目标被内容边界夹住的那一截记成欠账（不是不补，是现在没地方补）
        clampOwedRef.current = plan.owed
        // 合并到下一帧，绝不在这里同步 setState（否则又是一条自激环）
        syncMetricsSoon(scroll)
      } else if (decision.reason === 'sign-flip' || decision.reason === 'streak-limit') {
        // 判自激：本条链到此为止，等到用户下一次手势才解封
        guard.blocked = true
        guard.streak += 1
        clampOwedRef.current = plan.owed
      } else {
        // 位置已经对上了（位移不到阈值 / 贴底 / 平滑滚动在路上）：链清零重数
        guard.previousShift = 0
        guard.streak = 0
        // 位移不到阈值但目标仍被夹住（例如欠账这一帧付了 0px）：欠账必须留着
        clampOwedRef.current = plan.owed
      }
    }
    // 下一次提交的参照：本帧第一条可见行（内容坐标 + 视口坐标快照）
    const first = pickAnchor(rows, scroll.scrollTop)
    const visible = rows.find(row => row.id === first?.id)
    anchorRef.current = visible && visible.top < scroll.scrollTop + scroll.clientHeight
      ? {
          ...visible,
          scrollTop: scroll.scrollTop,
          // 视口坐标 = 行顶相对滚动视口顶的偏移（与 readRowSpans 的内容坐标同一原点减 scrollTop）
          viewportTop: visible.top - scroll.scrollTop,
        }
      : null
  })

  const lastIndex = messages.length - 1
  const uploadRetryId = getUploadRetryId(messages, streaming)
  const renderItem = useCallback(
    (message: Message, index: number) =>
      message.role === 'user' ? (
        <UserMessage
          sessionId={session.id}
          message={message}
          retryUploadId={uploadRetryId}
          isFirst={index === 0}
          isLast={index === lastIndex || index === lastIndex - 1}
          busy={streaming}
          versions={versions.get(message.id) ?? EMPTY_VERSIONS}
          onSelectVersion={selectVersion}
          onEditingChange={onEditingChange}
        />
      ) : (
        <AssistantMessage
          sessionId={session.id}
          message={message}
          isLast={index === lastIndex}
          streaming={streaming && index === lastIndex}
          busy={streaming}
          versions={versions.get(message.id) ?? EMPTY_VERSIONS}
          onSelectVersion={selectVersion}
        />
      ),
    [lastIndex, onEditingChange, selectVersion, session.id, streaming, uploadRetryId, versions]
  )

  // 按钮挂在输入区里（输入框上方），所以状态与动作从列表这一层传给 footer 子树
  const toBottomState = useMemo(
    // #610：编辑态一并送下去 —— 按钮在 390 宽会压在编辑框的「发送」上，编辑期间干脆不挂它。
    () => ({ ...toBottom, editing: editingIds.size > 0, jump: jumpToBottom }),
    [toBottom, editingIds, jumpToBottom]
  )

  return (
    <ScrollToBottomContext.Provider value={scrollToBottom}>
      <ScrollToBottomStateContext.Provider value={toBottomState}>
        <div ref={isMobile ? undefined : scrollRef} className={styles.container}>
          <div ref={isMobile ? scrollRef : undefined} className={styles.scroll}>
            <div ref={contentRef} className={styles.column}>
              <VirtualRows
                items={messages}
                retainedIds={editingIds}
                measured={measured}
                measureAnchor={measureAnchorRef.current}
                estimate={estimate}
                scrollTop={metrics.top}
                viewport={metrics.viewport}
                anchorEnd={stickyRef.current}
                getId={(message) => message.id}
                renderItem={renderItem}
              />
            </div>
          </div>
          {footer}
        </div>
      </ScrollToBottomStateContext.Provider>
    </ScrollToBottomContext.Provider>
  )
}
