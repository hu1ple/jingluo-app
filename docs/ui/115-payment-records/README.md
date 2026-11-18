# #115 付款记录页验收截图

**这是浏览器视口截图（Chromium 设备模拟，`deviceScaleFactor: 2`），不是真机截图。**
两档宽度：390 × 844、360 × 740。生成命令：

```bash
pnpm build:internal
node scripts/shot-mobile.mjs --page=payment-records --viewport=390,360
```

入口位置：**设置 → 数据管理 → 付款记录 → 查看**（`data-testid="payment-records-open"`，
`src/components/settings/SettingsDialog.tsx`）。

## 数据的来源与边界（重要）

`GET https://apia.ecsafe.cn/api/orders` 在截图时被 Playwright `context.route` 拦掉，
回的是代码注释里记录的**真实响应形状**：

```json
{ "customer_id": 10, "total_paid_yuan": 0.0, "orders": [] }
```

也就是说：**当前账号没有订单，这里只截到空状态**。
带订单列表（卡密后 4 位、兑换状态、多笔金额）的渲染**没有验证**——没有真实订单可截，
也不伪造假订单。后续要补的话，需要一笔真实付款或后端返回样例行。

## 文件

| 文件 | 内容 |
| --- | --- |
| `390/payment-records-01-settings-data-entry-390.png` | 数据管理页里「付款记录」入口（副标题：已支付订单、金额、卡密后 4 位与兑换状态） |
| `390/payment-records-02-payment-records-390.png` | 点「查看」后的弹层，整屏 |
| `390/payment-records-03-payment-records-closeup-390.png` | 弹层放大（358 × 246） |
| `360/…-360.png` | 同上三张，360 × 740 档（弹层 328 × 246） |

## 量到的内容

弹层 `innerText`（两档一致）：

```
付款记录
累计已支付
¥0.00
还没有付款记录。购买套餐并付款后，这里会列出每一笔订单。
刷新
```

- 两档下弹层都把设置面板盖住，`[role="dialog"]` 共 2 层（外层设置面板 + 付款记录层），宽度 = 视口宽 - 32px 边距。
- 空状态文案与「刷新」按钮都在可视区内，没有溢出、没有截断。
- 量到 `state.empty = true`、`state.error = false`（无「请求失败 / Unauthorized」类文案）。

## 未测边界

- 有订单数据时的列表渲染、金额汇总、卡密后 4 位脱敏、兑换状态徽标（无数据）。
- 网络失败 / 未配置 API Key 的错误态（本次未构造）。
- 真机（无 adb / 模拟器，按规范不虚报）。
