# 自定义提示词抽屉：按设计稿重做外观（390 / 360 / 320 + 深色）

**这是浏览器视口截图（headless Chromium 设备模拟，`deviceScaleFactor: 2`、`isMobile: true`、
`hasTouch: true`、`locale: zh-CN`），不是真机截图。** 被测对象是 **dev server（`rspack serve --port 8140`）**
上跑的真代码，不是 mock 页面：会话记录由脚本写进 IndexedDB（`chat-demo` v15）后 reload，
再沿「顶栏人像图标 → 抽屉」这条真路径打开抽屉。

只改外观（`src/components/session/PersonaDrawer.{tsx,module.css}` + `src/i18n/{zh,en}.ts` 的计数 / 副标题文案），
**字数上限、脏检查、超长禁保存、丢弃确认一行代码没动**。

## 截图

| 文件 | 视口 | 内容 |
| --- | --- | --- |
| `persona-redesign-390.png` | 390 × 844 | 抽屉初始态：拖拽把手 / 图标块 + 标题 + 副标题 / 输入卡片 / `0 / 1000` / ⓘ 作用范围 + 取消 / 已保存（禁用） |
| `persona-redesign-full-390.png` | 390 × 844 | 粘贴 1200 字后：计数 `1000 / 1000`（琥珀色）、内容在卡片内滚动 |
| `persona-redesign-dark-390.png` | 390 × 844 | 深色主题同一屏（图标块换深蓝底 + 亮蓝图标，计数琥珀色仍可读） |
| `persona-redesign-320.png` | 320 × 640 | 最窄档：无横向溢出（`scrollWidth == clientWidth == 320`），取消 / 保存仍在同一行 |
| `persona-redesign-360.png` | 360 × 740 | 360 档同上（`scrollWidth == clientWidth == 360`） |
| `persona-redesign-confirm-390.png` | 390 × 844 | 有改动时点关闭 X →「是否保存提示词？」二次确认（沿用既有 `confirm` 流程，未改） |
| `persona-redesign-oversized-390.png` | 390 × 844 | 存量超长（库里 1100 字）：**不截断**、计数红色 `1100 / 1000`、行内提示 + 保存禁用 |

## 实测（`getBoundingClientRect` / `getComputedStyle`，390 档）

| 项目 | 实测 |
| --- | --- |
| 抽屉是否贴底 | `top = 386 > 0`（高 458，390 × 844 下不占满屏） |
| 顶部圆角 | `border-top-left/right-radius = 20px`，底部 `0` |
| 拖拽把手 | 36 × 4，水平居中 |
| 图标块 | 56 × 56，`border-radius = 16px`，浅蓝底 `rgb(237,243,254)` + 蓝色图标 `rgb(57,100,254)` |
| 标题 | 「自定义提示词」，`font-size 20px` / `font-weight 600` |
| 副标题 | 「在这里设置人物、世界观、创作规则或其他要求。」13px 灰 |
| 输入卡片 | 高 252、圆角 14px、`border: 1px solid rgba(0,0,0,.08)`、内边距 `14px 14px 10px` |
| 计数格式 | `0 / 1000`（正则 `/^0 \/ 1000$/` 命中；卡片内左下角） |
| placeholder | 「请输入你的自定义提示词……」 |
| 底部一行 | 左 ⓘ +「仅对当前聊天生效，AI 不会改动。」（**390/360/320 三档实测都是 1 行**，`scope` 高 18px）；右「取消」（白底描边胶囊）+「保存」（蓝色实心胶囊） |
| 底部排版 | 390 减内边距只剩 358px，16 字说明（215px）+ 两个胶囊（176px）放不进同一行 → 说明独占一行、按钮整组折到下一行右对齐（两枚按钮 `top` 相同，不错位）；宽屏（抽屉 max-width 520）两者同排 |
| 全屏编辑 | 页面上无「全屏编辑」字样 |

## 既有行为（未回归）

- 粘贴 1200 字 → 输入框里 **1000 码点**（`[...value].length == 1000`、`maxLength == 2000` 单元），计数 `1000 / 1000`。
- 存量超长（库里 1100 字）打开时**原样显示 1100 字**、计数红色、行内提示「当前内容超过 1000 字…」、保存按钮禁用。
- 未改动时保存按钮文案 `已保存` 且 `disabled`。
- 点 X / 取消关闭有改动的输入 → 「是否保存提示词？」（保存 / 不保存 / 取消）三步，点「取消」回到抽屉、点「不保存」才关闭。
- 无障碍：抽屉 `role="dialog"` + `aria-modal="true"` + `aria-labelledby` 指向标题区，textarea `aria-label="自定义提示词"`，
  X 的 `aria-label="关闭"`；Tab 顺序 textarea → 取消 →（已禁用时跳过保存）。

复现脚本是一次性的（不入库）：Playwright 起 390 / 360 / 320 三个 context，种会话 → 开抽屉 → 量数 + 截图。
