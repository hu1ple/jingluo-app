# 付款登录闸门的界面取证（未登录不许跳支付）

产品口径（2026-11-26）：**没登录不能去跳转支付链接**。未登录点「购买 / 充值」时 ——

1. **不取地址、不开收款页**：网络里没有 `pay-link` 请求；Web 不开新标签页、原生不开 App 内 popover；
2. 改成弹一张**要求登录**的弹窗，给「去登录」入口；
3. 登录后的行为**一个字都没变**（`fetchPayLink` → `openPayLinkInApp` / 占位页 → 导航这条链没动）。

判据与顺序住在 `src/components/consume/checkoutGate.ts`（纯函数 `needsLoginForCheckout()` +
依赖注入的 `beginCheckout()`），组件侧只有 `src/components/consume/BuyTab.tsx` 的 `openCheckout()` 开头
那一道闸门；单元用例是 `tests/unit/checkout-login-gate.test.mjs`。

## 取证方式

Playwright（Chromium headless，`deviceScaleFactor: 2`，`locale: zh-CN`）打开**本机 dev server**，
沿「设置 → 账户与消费 → 我的钱包 → 去支付 → 前往购买」点下去，同时监听网络与 `popup` 事件。

- **未登录**：默认 dev 构建。断言弹窗出现、`pay-link` 请求数 = 0、新标签页数 = 0；
  再点「去登录」断言落到账号页且 `settings-auth-card` 在。
- **已登录**：把凭据按 `chat-demo:auth-token` 的落盘格式写进 localStorage，由产品自己的
  `restoreAuth()` 走一遍启动恢复（`/api/v1/user/profile` 由 `page.route` 桩成真用户），
  再断同一路径：**没有**登录弹窗、`pay-link` 请求 1 发、收款页在新标签页打开。
- 收款页地址（`/api/v1/pay-link`）与收款页本身都只在本机桩里，**没有真的打开联动小铺**。

这是**浏览器视口截图，不是真机截图**。

## 截图（390 × 844 主档 / 360 × 740 窄档）

| 文件 | 场景 | 结论 |
| --- | --- | --- |
| `pay-login-gate-signed-out-390-before-click.png` | 未登录，购买页（点之前） | 入口只有一个「前往购买」 |
| `pay-login-gate-signed-out-390-prompt.png` | 未登录，点「前往购买」之后 | 「需要登录后才能购买」弹窗 + 「取消 / 去登录」 |
| `pay-login-gate-signed-out-390-account-card.png` | 点「去登录」之后 | 落在账号页，登录 / 注册卡在屏幕上 |
| `pay-login-gate-signed-out-360-before-click.png` | 同上，360 宽 | 布局不挤、不横向溢出 |
| `pay-login-gate-signed-out-360-prompt.png` | 同上，360 宽 | 弹窗仍完整可读（两个按钮都在） |
| `pay-login-gate-signed-out-360-account-card.png` | 同上，360 宽 | 登录 / 注册卡与分段控件都在 |
| `pay-login-gate-signed-in-390-before-click.png` | 已登录，购买页（点之前） | 账号行是邮箱，不是「登录 / 注册」 |
| `pay-login-gate-signed-in-390-opened.png` | 已登录，点「前往购买」之后 | 没有弹窗；收款页已在新标签页打开，本页给「已在新标签页打开收款页」 |

## 未测 / 边界

- **原生端**（App 内 popover）没有跑真机：这条闸门在 `beginCheckout` 里位于 `isNativePlatform()`
  分支之前，原生与 Web 走的是同一次判定；原生那一支的打开行为本身没改，仍由
  `tests/unit/ours-inapp-buy.test.mjs` 与 `pay-link-hardening-861` 钉住。
- **登录态还在恢复中**（`restored: false` / `state: 'authenticating'`）按未登录处理：宁可让用户多点
  一次「去登录」，也不让身份没确认的人开出收款页。这段体验是「点了弹登录窗」，不是「转圈等恢复」。
- 已登录那一组的 `/api/v1/**` 全部是本机桩，**不是**对真实服务的结果。
