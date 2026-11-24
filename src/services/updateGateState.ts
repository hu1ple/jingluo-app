/**
 * 启动更新检查的**运行态**（本单新增）。
 *
 * 检测本体在 `services/updateGate.ts`（纯逻辑、可裸跑单测），本文件只管一件事：
 * 把那次异步结果接住，让**任意组件**都能读到「现在是不是必须更新」。
 *
 * 选 zustand + `create` 而不是 Context：仓库里 `toastState.ts` / `mobileSiderState.ts`
 * 都是这个形状（模块级 store + 模块级动作函数），`ChatInput` 的发送门禁要用的是
 * `useUpdateGate.getState()` 这种**非渲染期读取**（点下去的瞬间才算数），Context 做不到。
 *
 * 三条纪律：
 *  1. **只跑一次**：`startUpdateGate()` 有进程级闩（`started`），`App` 的 effect 在
 *     React 18 严格模式下会跑两遍，不能因此打两次清单请求；
 *  2. **不阻塞首屏**：调用方 `void` 掉它即可，本文件不抛错（判定层本来就 fail-open）；
 *  3. **判定结果只增不减**：一旦判出 `forced`，本次运行期间不会被一次更晚的检查改回
 *     `none`（否则用户能靠「再查一次」把只读模式绕开）。
 */

import { create } from 'zustand'
import { checkUpdateGate, type UpdateGate, type UpdateGateDeps } from './updateGate.js'
import { setUpdateSnoozeUntil, useSettings } from './settings.js'
import { snoozeDeadline } from './updatePolicy.js'

export interface UpdateGateRuntime {
  /** 判定结果；`none` 是初始值，也是「还没查 / 没什么要说的」 */
  gate: UpdateGate
  /** 是否已经有结果（`false` = 还在查：公告弹窗据此让位，避免两层 dialog 抢屏） */
  checked: boolean
}

export const useUpdateGate = create<UpdateGateRuntime>(() => ({
  gate: { kind: 'none' },
  checked: false,
}))

/** 进程级闩：`App` 的 effect 只该真查一次 */
let started = false
/** 单测 / 站点内热重载可以重置（生产代码不调它） */
export const resetUpdateGateForTests = () => {
  started = false
  useUpdateGate.setState({ gate: { kind: 'none' }, checked: false })
}

/**
 * 启动检查一次。**调用方不要 await**（`void startUpdateGate()`）：它跑在首屏之后，
 * 结果自己落到 store 里。
 *
 * snooze 到期时刻从设置 store 读（`chat-demo:update-snooze-until` 那条既有链），
 * 不在这里另造一份存储 —— 否则「设置页稍后提醒过」与「启动弹窗」会各看各的。
 */
export const startUpdateGate = async (deps: UpdateGateDeps = {}): Promise<UpdateGate> => {
  if (started) {
    return useUpdateGate.getState().gate
  }
  started = true
  let gate: UpdateGate = { kind: 'none' }
  try {
    gate = await checkUpdateGate({
      snoozedUntil: useSettings.getState().updateSnoozeUntil,
      ...deps,
    })
  } catch {
    // checkUpdateGate 自己宣称永不抛；真抛了也只当「没什么要说的」（fail-open 的第二道保险）
    gate = { kind: 'none' }
  }
  // 已经判出 forced 就不再被覆盖（见文件头第 3 条）
  const current = useUpdateGate.getState().gate
  useUpdateGate.setState({ gate: current.kind === 'forced' ? current : gate, checked: true })
  return useUpdateGate.getState().gate
}

/** 现在是不是「必须更新」的只读模式（发送门禁与「重新生成 / 继续」共用这一条判据） */
export const updateRequiredNow = (): boolean => useUpdateGate.getState().gate.kind === 'forced'

/**
 * soft 的「稍后提醒」：按服务端给的 `snoozeHours` 写一条到期时刻（既有 snooze 链），
 * 然后收起提示。forced 没有这条路径 —— 它压根不该调用到这里。
 */
export const snoozeStartupUpdatePrompt = (): void => {
  const gate = useUpdateGate.getState().gate
  if (gate.kind !== 'soft') {
    return
  }
  try {
    setUpdateSnoozeUntil(snoozeDeadline(Date.now(), gate.policy.snoozeHours))
  } catch {
    // 存不下就只是「这次关掉了」：下次启动还会再提示一次，比把界面带崩划算
  }
}
