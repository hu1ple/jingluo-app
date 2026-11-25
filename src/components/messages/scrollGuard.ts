/**
 * 消息列表滚动策略的纯计算（Bug A / Bug B 的判定都收在这里）。
 *
 * 为什么单独抽一个文件：这两处判定原来分别写在 `MessageList.tsx` 的
 * `positionOpeningEditor`（约 170~195 行）与锚点校正 layout effect（约 490~507 行）里，
 * 要复现「自激振荡」「编辑框永远居中」得开浏览器跑流式会话才看得见。判定抽成无 DOM、
 * 无 React 的纯函数后，`tests/unit/message-list-scroll-guard.test.mjs` 能把两条 bug 的
 * 方向（收敛 / 不自激 / 不用陈旧引用）直接钉住。
 *
 * 本文件零依赖、零副作用，`tests/unit` 可直接 import。
 */

/** 校正量小于该值视为噪声：不动（子像素级别的写入只会白触发一次 setState） */
export const ANCHOR_SHIFT_MIN = 0.5
/**
 * 没有用户输入（wheel / touchstart / pointerdown）时，同一条提交链最多连着校正几次。
 * 超过就停手 —— 自激时写入本身就产生下一次提交，靠这个上限把链截断。
 */
export const ANCHOR_STREAK_MAX = 3

/** 一次锚点校正要不要生效，以及不生效的原因（原因码只用于排查与用例断言） */
export type AnchorCorrectionReason =
  /** 生效 */
  | 'apply'
  /** 用户还贴底跟随，位置由 `scrollToBottom` 负责 */
  | 'sticky'
  /** 「回到底部」的平滑滚动还在路上 */
  | 'jump'
  /** 位移不到最小阈值 */
  | 'below-threshold'
  /** 与上一帧的校正量反号：再补就来回弹，放弃本次校正 */
  | 'sign-flip'
  /** 连续校正次数到顶：判定为自激，暂停到下一次用户输入 */
  | 'streak-limit'
  /** 本条链已被判定为自激，等用户下一次输入再解封 */
  | 'blocked'

export type AnchorCorrectionInput = {
  /** 本帧算出的校正量（px，负=往上收） */
  shift: number
  /** 上一条提交链里已经应用过的校正量；`null`/`0` 表示链上没有成功校正 */
  previousShift?: number | null
  /** 当前是否仍贴底跟随 */
  sticky: boolean
  /** 「回到底部」的平滑滚动是否还在路上 */
  jump: boolean
  /** 本条链上已经连续尝试过几次（含被拒的），由调用方数 */
  streak?: number
  /**
   * 本条链已经被判定为自激（出现过反号或到过上限），在用户下一次输入之前一律不补。
   * 由调用方维持：`reason === 'sign-flip' | 'streak-limit'` 时置 true，用户手势 / 恢复贴底时清掉。
   */
  blocked?: boolean
}

export type AnchorCorrectionDecision = {
  /** 是否把 `shift` 写进 scrollTop */
  apply: boolean
  /** 真正要写进 scrollTop 的量；不生效时恒为 0 */
  shift: number
  reason: AnchorCorrectionReason
}

/**
 * 锚点校正的收敛器（Bug B）。
 *
 * 目标：同一次提交链里 `shift` 一旦反号（或连续两帧位移互相抵消），就放弃本次校正 ——
 * 否则「补 168 → 下一帧 −168 → 再补 168」会无限自激，实测 27 次振荡后 React 抛
 * `Maximum update depth exceeded` 并把整个 `<MessageList>` 卸掉。
 *
 * 四道闸，按顺序判：
 *   1. 贴底跟随 / 平滑滚动在路上 —— 位置不归这里管，直接让给 `scrollToBottom`
 *   2. 本条链已判自激（blocked）—— 用户下一次手势才解封
 *   3. 位移不到 `ANCHOR_SHIFT_MIN` —— 子像素噪声，不写
 *   4. 与上一帧应用的校正量反号 —— 反号就是「补了又弹回来」，本次放弃并把链钉住
 * 另外 `streak` 到 `ANCHOR_STREAK_MAX` 也停手：自激时**写入本身**会造出下一次提交
 * （写 scrollTop → scroll 事件 → setState → 新提交），链只能靠上限截断。
 */
export const decideAnchorCorrection = (
  input: AnchorCorrectionInput
): AnchorCorrectionDecision => {
  const shift = Number.isFinite(input.shift) ? input.shift : 0
  const streak = Number.isFinite(input.streak) && (input.streak as number) > 0
    ? (input.streak as number)
    : 0
  const previousShift = Number.isFinite(input.previousShift) ? (input.previousShift as number) : 0
  if (input.sticky) {
    return { apply: false, shift: 0, reason: 'sticky' }
  }
  if (input.jump) {
    return { apply: false, shift: 0, reason: 'jump' }
  }
  if (input.blocked) {
    return { apply: false, shift: 0, reason: 'blocked' }
  }
  if (!(Math.abs(shift) >= ANCHOR_SHIFT_MIN)) {
    return { apply: false, shift: 0, reason: 'below-threshold' }
  }
  if (previousShift !== 0 && shift * previousShift < 0) {
    // 上一帧往下补、这一帧要往上补 —— 再补就是来回弹，链到此为止
    return { apply: false, shift: 0, reason: 'sign-flip' }
  }
  if (streak >= ANCHOR_STREAK_MAX) {
    return { apply: false, shift: 0, reason: 'streak-limit' }
  }
  return { apply: true, shift, reason: 'apply' }
}

/** 编辑框目标是否还是「活的」—— 陈旧的 textarea 引用不许再去滚页面（Bug A-2） */
export type EditorTargetInput = {
  /** 编辑框对应的消息 id */
  messageId: string
  /** 当前仍处于编辑态的消息 id 集合 */
  editingIds: Iterable<string>
  /** `textarea.isConnected` */
  isConnected: boolean
  /** `document.activeElement === textarea` */
  focused: boolean
}

/**
 * 编辑框目标是否还是「活的」—— 陈旧的 textarea 引用不许再去滚页面（Bug A-2）。
 *
 * 三条都要成立：消息仍在这一轮的 `editingIds` 里（发送后它可能已经退出编辑态）、
 * `textarea` 还挂在文档上（行被虚拟列表重挂载过就是 false）、焦点还在它身上。
 * 任何一条不成立都说明这是个陈旧引用，拿它的 rect 去定位只会把列表拽到别处。
 */
export const isEditorTargetLive = (input: EditorTargetInput): boolean => {
  if (!input.isConnected || !input.focused) {
    return false
  }
  for (const id of input.editingIds) {
    if (id === input.messageId) {
      return true
    }
  }
  return false
}

/** 居中编辑框的落点计算（Bug A-1） */
export type EditorCenterInput = {
  /** 希望输入框落到哪（视口坐标，已含按钮留白） */
  targetTop: number
  /** 输入框现在在哪（视口坐标） */
  currentTop: number
  /** 这个编辑框这一轮是否已经居中过（同一个消息 id 只居中一次，别每帧都居中） */
  alreadyCentered: boolean
}

export type EditorCenterPlan = {
  /** 要写进 scrollTop 的量；0 = 不动 */
  shift: number
  /** 是否保持贴底跟随；`false` = 关掉跟随（只有真的要挪位置时才关） */
  keepSticky: boolean
}

/**
 * 居中编辑框的落点计算（Bug A-1）。
 *
 * 两个「不许」：位移不到 1px 时不许关贴底（原来无条件 `stickyRef.current = false`，
 * 于是「软键盘没收起、编辑框还带着焦点」的 Android WebView 路径上，发送后这一帧就把
 * 跟随关掉了，之后流式内容再也不跟）；同一条消息这一轮居中过之后不许再居中
 * （每帧重新居中 = 列表被钉在编辑框上，实测 gap 固定 1726px 不动）。
 */
export const editorCenterPlan = (input: EditorCenterInput): EditorCenterPlan => {
  if (input.alreadyCentered) {
    return { shift: 0, keepSticky: true }
  }
  const raw = input.targetTop - input.currentTop
  if (!Number.isFinite(raw) || Math.abs(raw) < 1) {
    return { shift: 0, keepSticky: true }
  }
  return { shift: raw, keepSticky: false }
}
