# #106 移动端顶栏「双击回顶」验收截图

**这是浏览器视口截图（Chromium 设备模拟，`deviceScaleFactor: 2`），不是真机截图。**
两档宽度：390 × 844、360 × 740。生成命令：

```bash
pnpm build:internal                     # 先出 dist/
node scripts/shot-mobile.mjs --page=header-scroll-top --viewport=390,360
```

会话 fixture 是本地写入 IndexedDB 的 26 轮长对话（`src/**` 未做任何改动），
先滚到底再截图，量到的数字在 `390/metrics.json`、`360/metrics.json`。

## 文件

| 文件 | 内容 |
| --- | --- |
| `390/header-scroll-top-01-topbar-scrolled-to-bottom-390.png` | 消息区滚到底：顶栏仍可见，标题右侧出现「双击回顶」提示 |
| `390/header-scroll-top-02-topbar-closeup-390.png` | 顶栏放大条（0,0,390×150）：标题、提示、新建按钮的相对位置 |
| `390/header-scroll-top-03-after-double-tap-first-message-390.png` | 双击标题后：消息区回到首条消息 |
| `390/header-scroll-top-04-after-double-tap-closeup-390.png` | 回顶后的顶栏 |
| `360/…-360.png` | 同上四张，360 × 740 档 |

## 量到的数字

| 项 | 390 | 360 |
| --- | --- | --- |
| 标题按钮点击区（含内边距） | 258 × **44** | 228 × **44** |
| 「双击回顶」提示 | 52 × 13px，`rgb(173,178,184)` | 52 × 13px，`rgb(173,178,184)` |
| 标题 | 14px，宽 188，未截断 | 14px，宽 158，未截断 |
| 双击前 / 后 `scrollTop` | 6913 → **0** | 6914 → **0** |
| 消息层 `scrollHeight` / `clientHeight` | 7563 / 650 | 7460 / 546 |

## 观察

- 点击区高度 44px（`min-height: 44px`，鼠标/触摸都够），两档都成立——不是「看起来差不多」，是 `getBoundingClientRect()` 量的。
- 提示是 `flex-shrink: 0` 的常驻元素，不随标题长度浮动：fixture 标题 11 个字在两档下都没被挤到截断（`scrollWidth === clientWidth`）；标题更长时才会 ellipsis，此时提示仍占 52px 宽。
- 双击后 `scrollTop` 归零、首条消息进入视口，符合 Issue 里描述的行为。
- 未测边界：真机触摸双击（本机无 adb / 模拟器，按规范不虚报）；`prefers-reduced-motion: reduce` 下动画被降级的情形；超长标题（> 20 字）时提示与标题的实际挤压表现。
