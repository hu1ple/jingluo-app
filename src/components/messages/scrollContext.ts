import { createContext, useContext } from 'react'

/** 渲染更新后请求滚到底部；用户上滑离开底部时由列表忽略 */
export const ScrollToBottomContext = createContext<() => void>(() => {})

export const useScrollToBottom = () => useContext(ScrollToBottomContext)

/**
 * 「回到底部」按钮（Issue #386）要读的状态。
 *
 * 状态由 `MessageList` 内部量出来（它才是滚动层的主人：scroll 监听、内容长高的
 * `ResizeObserver`、跟随底部的开合都在那里），按钮本身不碰 DOM 滚动 —— 这样按钮
 * 可以挂在**输入区**里（输入框上方），不用把输入区搬进消息组件。
 */
export type ScrollToBottomState = {
  /** 滚动位置离底部超过阈值：显示按钮 */
  visible: boolean
  /** 离开底部期间内容又长高了（流式追加）：按钮上补一个小圆点 */
  hasNew: boolean
  /**
   * 有消息正在就地编辑（#610）：编辑是短暂的模态行为，此时整枚按钮不挂载。
   *
   * 按钮挂在输入区、`bottom: 100%`，落在消息区可见部分的最下一条带；编辑框恰好长在那一带，
   * 390 宽下按钮的圆形（含 44px 命中区）就压在编辑框右下角的「发送」上 —— 发送点不到。
   * 由列表经 context 送下来（列表才知道谁在编辑），按钮侧不做任何定位计算。
   */
  editing: boolean
  /** 点按钮：恢复「跟随最新」，平滑滚到底部（reduced-motion / 老内核直接跳） */
  jump: () => void
}

const NOOP_STATE: ScrollToBottomState = {
  visible: false,
  hasNew: false,
  editing: false,
  jump: () => {},
}

export const ScrollToBottomStateContext = createContext<ScrollToBottomState>(NOOP_STATE)

export const useScrollToBottomState = () => useContext(ScrollToBottomStateContext)
