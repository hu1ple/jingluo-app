/**
 * Web 端「收款页开过了 / 用户回来了」这一条信号（`BuyTab` → `AccountConsumePage` 之间的唯一一根线）。
 *
 * ## 为什么需要这个文件
 *
 * 原生端「用户从收款页回来了」由 `@capacitor/browser` 的 `browserFinished` 给
 * （`openPayLinkInApp` 的 `onClosed` → `BuyTab.onPurchased` → `backToCards`）。
 * Web 端收款页开在一个**新标签页**里，没有关页事件，只能靠
 * `document.visibilitychange`（切回来）+ 低频轮询兜底 —— 而「要不要开始听」取决于
 * 「这一次会话里到底有没有真的开出过收款页」。这件事**只有 `BuyTab` 知道**
 * （`navigatePayTab()` 成功那一刻），`AccountConsumePage` 却要拿它来决定挂不挂监听。
 *
 * ## 为什么不走 prop
 *
 * `BuyTab` 的挂载点被 `tests/unit/wallet-pay-entry-817.test.mjs` ① 钉成
 * `<BuyTab onPurchased={backToCards} />`，多一个 prop 就红。所以「开过收款页」这条信号和
 * 「回来了以后要调谁」都由 `BuyTab` 在这里**登记一次**：
 * 它交回来的回调就是自己的 `onPurchased`（= 页面唯一的接线 `backToCards`），
 * 页面那边只 `runWebPayReturn()`，**没有第二个回调名、也没有第二份兑现逻辑**
 * （`tests/unit/wallet-auto-redeem-784.test.mjs` ① 用字面量钉住「`backToCards` 只出现两次」，
 * 这条登记正是为了不破坏它）。
 *
 * 模块本身：`.ts`、不 import React / Capacitor / DOM，裸 Node 可测。
 *
 * ## 语义边界（别扩大它）
 *
 *  - **只在 Web 收款页真的导航成功之后**才 `markWebPayOpened()`：被弹窗拦截、取地址失败都不算；
 *  - 「回来了」**不代表付款成功**：付款结果只在小铺那边，能不能兑现由 `walletAutoRedeem.ts`
 *    按订单状态 + 兑换历史 + 本地指纹判（幂等，且永不自动重试）；
 *  - 触发次数由调用方（页面的可见性监听 / 轮询）自己限制，这里不做节流、也不排队。
 */

type PayReturnHandler = () => void

/** 本次会话有没有真的开出过 Web 收款页（`false` 时一切触发都是空转） */
let payOpened = false
/** 回来了要调的那一条回调（`BuyTab.onPurchased`）；没登记就是 `null` */
let onReturn: PayReturnHandler | null = null
const listeners = new Set<() => void>()

/**
 * Web 收款页导航成功：记下「开过」+ 那条回跳回调，并通知订阅者（页面据此挂可见性监听）。
 *
 * `onWebPayReturn` 可以不给（`BuyTabProps.onPurchased` 是可选 prop）：不给就只算是「开过」，
 * 回来时 `runWebPayReturn()` 会返回 `false`，什么也不做。
 */
export const markWebPayOpened = (onWebPayReturn?: PayReturnHandler): void => {
  payOpened = true
  if (onWebPayReturn !== undefined) {
    onReturn = onWebPayReturn
  }
  // 复制一份再遍历：订阅者在回调里退订（很常见）不能让遍历跳过别人
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch {
      // 一个订阅者炸了不该影响别人：这条信号本身就是「尽力而为」
    }
  }
}

/**
 * 「用户回来了（Web）」——调 `BuyTab` 交回来的那条回调（= `onClosed` 在原生端的同一件事）。
 *
 * 返回 `false` = 没有可调的东西（没开过收款页 / `onPurchased` 缺席）：调用方据此
 * 什么也不做（不要自己补一套「查订单 + 兑现」）。
 */
export const runWebPayReturn = (): boolean => {
  if (!payOpened || onReturn === null) {
    return false
  }
  try {
    onReturn()
    return true
  } catch {
    // 回调自己抛了（理论上不会：`backToCards` 内部全都 `.catch`）：这次算没回成，别把
    // 可见性监听 / 轮询一起炸掉
    return false
  }
}

/** 有没有开出过 Web 收款页（只读，给调用方判断要不要挂监听） */
export const isWebPayOpened = (): boolean => payOpened

/**
 * 订阅「刚开过收款页」。返回退订函数（组件卸载时一定要调，否则会跨会话串台）。
 *
 * **不会**在订阅时补发历史信号：这条只用来「挂上监听」。
 */
export const subscribeWebPayOpened = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 测试 / 排查用：把模块状态清回「没开过收款页」 */
export const resetWebPayReturn = (): void => {
  payOpened = false
  onReturn = null
  listeners.clear()
}
