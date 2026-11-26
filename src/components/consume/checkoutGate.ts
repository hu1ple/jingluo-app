/**
 * 付款入口的**登录闸门**（产品口径 2026-11-26）：没登录不能去跳转支付链接 ——
 * 点「购买 / 充值」时一次 `pay-link` 都不发、一个收款页都不开，改成弹一句「要先登录」。
 *
 * ## 为什么判定要单独住一层
 *
 * 真正的付款编排在 `BuyTab.openCheckout()` 里，而 `.tsx` 在裸 Node 里 import 不了（JSX 不在类型擦除
 * 范围内）—— 把「什么算已登录」直接写在组件里，这条判据就只能靠读源码猜，改错也没有用例拦。
 * 所以这里住两样东西：
 *
 *  1. `needsLoginForCheckout(snapshot)`：**纯函数**，零 React 依赖，只吃登录态快照；
 *  2. `beginCheckout(deps)`：闸门 + 同步占位 + 取地址的**顺序**，依赖全部由调用方注入 ——
 *     于是「未登录时零请求、零标签页」这件事可以被真的跑一遍，而不是靠正则数源码里谁在谁前面。
 *
 * ## 顺序为什么是这个顺序（`BuyTab` 文件头那段话的续集）
 *
 * Web 端 `window.open` 只要脱离用户点击的同步栈就会被浏览器当弹窗拦掉，而收款页地址要
 * `await fetchPayLink()` 才回来。所以三段只能是：
 *
 *     判定（同步）→ 占位页（同步，仍在点击栈里）→ 取地址（第一个 await）→ 导航
 *
 * `beginCheckout` 是 `async` 的，但**函数体会同步跑完到第一个 `await` 为止** —— 调它跟调一个同步
 * 函数看到的前半段行为一样。闸门放在最前面，未登录时整段在 `openPlaceholder` / `fetchLink` 之前
 * 就返回了：没有标签页、没有请求，这是这条闸门的全部价值。
 *
 * ## 「已登录」到底是哪个字段
 *
 * 快照就是 `getAuthSnapshot()`（`services/auth/store.ts:798`）的返回值。判定口径（保守优先）：
 *
 *  - `state === 'authenticated'` 是**唯一的放行值**。另外三个值各有含义，但都不放行：
 *    `unauthenticated`（没凭据）、`authenticating`（启动恢复 / 登录中 —— 还不知道是谁）、
 *    `expired`（有过凭据但已失效，回登录页那条）。
 *  - `restored === false`（启动恢复没跑完）**不额外判**：那种时刻 `state` 也不可能是
 *    `authenticated`（`restoreAuth` 是先写 `authenticating` 再写终态），所以「加载中」自动落在
 *    「按未登录处理」这一边 —— 宁可让用户多点一次「去登录」，也不能让一个身份没确认的人开出收款页。
 *  - **还要有可用的凭据**（`token.accessToken` 是非空字符串）：`state` 与 `token` 在 store 里是
 *    两个字段，只认其中一个的话，一处写坏就会变成「界面说有身份、请求却带空 header」。
 *
 * 反向对照：`tests/unit/checkout-login-gate.test.mjs` ④ 把这条闸门摘掉后必须变红。
 */

/**
 * 判定只读这么多：`state` + `token.accessToken`。
 *
 * 故意**不**要 `AuthSnapshot` 的完整类型：这个函数是纯判定，塞给它一个只有这两个字段的对象
 * （用例里就是这么干的）也应该能跑；真正的 `AuthSnapshot` 结构上天然满足它。
 */
export type CheckoutAuthSnapshot =
  | {
      state?: unknown
      token?: { accessToken?: unknown } | null
    }
  | null
  | undefined

/** 已登录 = 身份是 `authenticated` **且**手里有一颗非空 accessToken（见文件头「哪个字段」） */
export const isCheckoutAuthenticated = (snapshot: CheckoutAuthSnapshot): boolean => {
  if (snapshot === null || typeof snapshot !== 'object') {
    return false
  }
  if (snapshot.state !== 'authenticated') {
    return false
  }
  const token = snapshot.token
  if (token === null || token === undefined || typeof token !== 'object') {
    return false
  }
  const accessToken = token.accessToken
  return typeof accessToken === 'string' && accessToken.trim() !== ''
}

/**
 * 点「购买 / 充值」时要不要先让用户登录。
 *
 * `true` = 拦（**不发 pay-link、不开收款页、不开新标签页**，只弹登录提示）；
 * `false` = 放行，走原来的付款链路。读不到快照（`undefined` / `null` / 非对象）同样拦。
 */
export const needsLoginForCheckout = (snapshot: CheckoutAuthSnapshot): boolean =>
  !isCheckoutAuthenticated(snapshot)

/** 闸门的结论：要么「先去登录」，要么「放行，占位页已开出来、地址已到手」 */
export type CheckoutPrelude<Tab, Link> =
  | { action: 'login-required' }
  | { action: 'proceed'; tab: Tab | null; link: Link }

/** `beginCheckout` 的全部外部依赖（付款链路一行没改，只是被注进来了） */
export type CheckoutPreludeDeps<Tab, Link> = {
  /** 读当前登录态：生产里是 `getAuthSnapshot`，用例里是假快照 */
  readAuth: () => CheckoutAuthSnapshot
  /** 未登录时**唯一**被允许的副作用：弹「需要登录」的弹窗（设置方负责） */
  promptLogin: () => void
  /** 放行之后、占位页之前：置忙碌态（`payBusyRef` + 「正在获取收款页…」），防连点开出两个收款页 */
  onProceed?: () => void
  /** Web：**同步**开占位页并返回它；原生：返回 `null`。必须在第一个 `await` 之前跑完 */
  openPlaceholder: () => Tab | null
  /** 现取收款页地址（`fetchPayLink`）。**只有放行之后才会被调用** */
  fetchLink: () => Promise<Link>
}

/**
 * 「点购买」的同步前置 + 取地址（顺序见文件头）。
 *
 * 返回 `{ action: 'login-required' }` 时：`openPlaceholder` / `fetchLink` 一次都没被调用 ——
 * 未登录用户看不到新标签页，网络里也不会有 `pay-link`。
 */
export const beginCheckout = async <Tab, Link>({
  readAuth,
  promptLogin,
  onProceed,
  openPlaceholder,
  fetchLink,
}: CheckoutPreludeDeps<Tab, Link>): Promise<CheckoutPrelude<Tab, Link>> => {
  // ★ 闸门：必须排在占位页 / 取地址之前，否则未登录用户仍然会看到一个空标签页
  if (needsLoginForCheckout(readAuth())) {
    promptLogin()
    return { action: 'login-required' }
  }
  onProceed?.()
  const tab = openPlaceholder()
  const link = await fetchLink()
  return { action: 'proceed', tab, link }
}
