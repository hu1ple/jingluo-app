# #102 阅读设置（字号 / 字重 / 行高）验收截图

**这是浏览器视口截图（Chromium 设备模拟，`deviceScaleFactor: 2`），不是真机截图。**
两档宽度：390 × 844、360 × 740。生成命令：

```bash
pnpm build:internal
node scripts/shot-mobile.mjs --page=reading-settings --viewport=390,360
```

会话 fixture 是本地写入 IndexedDB 的一条样本对话，正文第一段固定为
「字号样本：这一行用来对比阅读设置的档位。」——量字号时按这句话找元素，
所以「到底变了没有」有数字可查，不是看图猜。

## 文件

| 文件 | 内容 |
| --- | --- |
| `390/reading-settings-01-message-default-390.png` | 消息区，默认档（标准 / 常规 / 标准） |
| `390/reading-settings-02-settings-reading-default-390.png` | 设置 → 通用设置，滚到「字号」：三个下拉都在，默认档回显正确 |
| `390/reading-settings-03-settings-size-dropdown-open-390.png` | 「字号」下拉展开（小 / 标准 / 大 / 特大） |
| `390/reading-settings-04-settings-weight-dropdown-open-390.png` | 「字重」下拉展开（常规 / 中等 / 粗体） |
| `390/reading-settings-05-settings-lineheight-dropdown-open-390.png` | 「行高」下拉展开（紧凑 / 标准 / 宽松） |
| `390/reading-settings-06-settings-reading-max-390.png` | 三档都选到最大后的设置面板（特大 / 粗体 / 宽松） |
| `390/reading-settings-07-message-max-390.png` | 关掉面板后的消息区，最大档渲染对比 |
| `360/…-360.png` | 同上七张，360 × 740 档 |

## 量到的数字（`getComputedStyle` + `getAttribute`）

| 项 | 默认档 | 最大档（特大 / 粗体 / 宽松） |
| --- | --- | --- |
| `data-ds-reading-size/-weight/-line` | standard / regular / standard | xlarge / bold / relaxed |
| 正文段 `font-size` | 16px | **20px** |
| `font-weight` | 400 | **600** |
| `line-height` | 28px | **40.8px** |
| 段宽（390 档 / 360 档） | 320 / 320 | 340 / 320 |
| 消息层横向溢出 | 无 | 无（`scrollWidth === clientWidth`，390 / 360 都是 390/390、360/360） |
| 文档级横向滚动 | 无 | 无（`documentElement.scrollWidth === clientWidth`） |

## 观察

- 三个下拉两档都渲染完整、可点开、选完回显正确，设置**真的落地**到 `documentElement` 的三个 `data-ds-reading-*` 属性上，正文 16 → 20px、400 → 600、28 → 40.8px，不是只改了回显。
- 最大档下正文没有横向溢出、没有压字，390 档段落变宽到 340（可用宽 358 内含内边距），360 档仍是 320，说明容器按视口收放。
- 说明文案本身（「只作用于消息区：聊天正文、思考内容和你自己发的消息；设置面板与输入框不跟着变。」）在三档下都完整可见，没有和下拉控件叠字。
- 未测边界：真机（无 adb / 模拟器）；深色主题下的对比度；`系统字号`（如 iOS 动态字体）叠加；超长英文单词的断行。
