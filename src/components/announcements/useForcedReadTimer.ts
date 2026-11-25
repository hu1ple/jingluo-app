import { useCallback, useEffect, useRef, useState } from 'react'
import {
  FORCE_READ_SECONDS,
  createReadTimer,
  remainingSeconds,
  type ReadTimer,
} from '../../services/announcements/readGate.js'

/**
 * 公告弹窗的**强制阅读倒计时**（5 秒内不许关）。
 *
 * 口径（产品原话：首次强制 5s，但别因为「切出程序」就重来一遍）：
 *
 *  · **一个时间基准**：弹窗出现时记一次 `shownAt`，剩余永远是
 *    `required - (now - shownAt)`。这是**墙钟差值**，不是「每秒 +1」的计数器 ——
 *    切后台后 `setInterval` 会被浏览器节流到 1s/分钟甚至整段不跑，计数器必然少走。
 *  · **离屏也照常计时**：切出去 8 秒回来，差值里就有了那 8 秒 → 剩余 0、按钮直接可用。
 *    没有「暂停 / 扣减离屏时间」那一套：用户切出去就是不想看，回来不该再等一遍。
 *  · **绝不清零**：计时器存在 `useRef`，只有公告 id 变了（换了新公告）才新建。
 *    父组件重渲染、快照换引用、`visibilitychange` 抖动都不碰它 —— 这就是「不因为切程序就重来」。
 *
 * `setInterval` 在这里**只负责重新读一次剩余秒数**（重绘），不参与计时。
 * `visibilitychange` 监听也**只做一件事**：回到前台时立刻重算一次，免得界面最多等 200ms 才把按钮解禁。
 */

/**
 * 当前时刻（ms）。用**墙钟** `Date.now()`：计时口径就是「用户在真实世界里过了多久」 ——
 * 切后台被节流、设备休眠都要照算，这正是「切出去 8 秒回来直接能关」的来源。
 * 取不到 `Date.now` 的极端环境退回 `performance.now()`（仍是「基准点 + 差值」，不是计数器）。
 */
const readClock = (): number =>
  typeof Date.now === 'function' ? Date.now() : Math.round(performance.now())

/**
 * 重绘间隔 200ms：秒数要「看着在跳」但不至于每帧 setState。
 * 它**不影响准确性** —— 剩余时间由墙钟差算出，掉帧 / 节流只会让秒数晚一点重绘，不会少算。
 */
const TICK_MS = 200

export type ForcedReadState = {
  /** 还剩几秒（0 = 读满了） */
  remainingSeconds: number
  /** 读满了没有（= 「知道了」/ Esc / 点遮罩 可用的判据） */
  ready: boolean
}

export type ForcedReadOptions = {
  /** 当前展示的公告 id；换 id = 换一条公告 → 以此刻为基准重新计 5 秒。`null` = 没有弹窗 */
  id: string | null
  /** 弹窗是不是开着（收起后不再计时） */
  active: boolean
  /** 读满 5 秒时回调**一次**（写读出门禁用） */
  onFinished: () => void
}

export const useForcedReadTimer = ({ id, active, onFinished }: ForcedReadOptions): ForcedReadState => {
  const timerRef = useRef<ReadTimer>(createReadTimer(readClock()))
  const [remaining, setRemaining] = useState(FORCE_READ_SECONDS)
  /** 保证 `onFinished` 每条公告只触发一次（200ms 一跳，读满后会跳很多次） */
  const firedRef = useRef(false)
  const activeRef = useRef(active)
  activeRef.current = active
  const onFinishedRef = useRef(onFinished)
  onFinishedRef.current = onFinished

  /**
   * 一「跳」：用墙钟差重算剩余秒数 → 读满时回调一次。不累加、不推进任何计数器。
   * `useCallback` 空依赖：它只读 ref 与 setState，天然稳定，于是可以被两个 effect 安全依赖。
   */
  const step = useCallback(() => {
    if (!activeRef.current) {
      return
    }
    const left = remainingSeconds(timerRef.current, readClock())
    setRemaining(left)
    if (left === 0 && !firedRef.current) {
      firedRef.current = true
      onFinishedRef.current()
    }
  }, [])

  // 换公告（新 id）才重新计时；同一条的重渲染**不碰** ref（否则每次重渲染都回到 5s）
  useEffect(() => {
    if (id === null) {
      return
    }
    timerRef.current = createReadTimer(readClock())
    firedRef.current = false
    setRemaining(FORCE_READ_SECONDS)
  }, [id])

  // 计时驱动：只负责重绘（剩余时间由墙钟差给出，节流 / 掉帧都不影响结果）
  useEffect(() => {
    if (!active || id === null) {
      return
    }
    step()
    const handle = window.setInterval(step, TICK_MS)
    return () => window.clearInterval(handle)
  }, [active, id, step])

  // 回到前台：立刻重算一次（**不暂停、不扣减**，只让按钮解禁不必等下一跳）
  useEffect(() => {
    if (!active) {
      return
    }
    const onVisibilityChange = () => {
      let visible = true
      try {
        visible = document.visibilityState === 'visible'
      } catch {
        visible = true
      }
      if (visible) {
        step()
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => document.removeEventListener('visibilitychange', onVisibilityChange)
  }, [active, step])

  return { remainingSeconds: remaining, ready: remaining === 0 }
}
