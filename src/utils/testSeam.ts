/**
 * 测试接缝（`TEST_AUTH_SEAM=1` 的测试构建）里要**跳过的「启动期副作用」**。
 *
 * 为什么需要：黄金回归与 L1 都是「启动即操作界面」的用例，而启动期的两类网络副作用会把它们
 * 全弄红 ——
 *   1. 启动拉公告并**弹公告弹窗**：modal 遮罩挡住输入框，几乎每个用例的 `textarea.click()` 都会
 *      卡到 30s 超时（实测 58 次重试仍不可点）；
 *   2. 启动检查更新：直连真实分发域拉 `releases.json`，把黄金回归的「不连真实服务」判据打穿。
 *
 * 这两件事在**测试构建里没有意义**（用例要验的是别的功能），所以接缝里一律不跑；生产构建里
 * `__TEST_SEAM__` 是 `undefined`，下面整个判断被死代码消除 —— 与 `__TEST_AUTH_STATE__` 同一套
 * 口径（见 scripts/lib/testAuthSeam.mjs，`check:test-seam` 会拦「接缝混进发布产物」）。
 *
 * 手工触发不受影响：`?ann-demo` / `?ann-reset` / `?update-check` 仍然照常工作，所以公告与
 * 强制更新可以写**专用用例**（用 `page.route` 桩 json）来覆盖，而不是靠启动副作用。
 */
declare const __TEST_SEAM__: unknown

export const testSeamEnabled = (): boolean => {
  try {
    return typeof __TEST_SEAM__ !== 'undefined' && __TEST_SEAM__ === true
  } catch {
    // 打包环境外（单测直接 import 源码）取不到这个常量
    return false
  }
}
