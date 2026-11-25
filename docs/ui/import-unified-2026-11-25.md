# 「数据管理」三行导入统一为行内形态（取证）

> 界面：设置 → 数据管理。三行 = 「导入历史会话」/「从链接导入」/「导入分享会话」。
> 口径：**Playwright Chromium（headless）浏览器视口截图**，390 × 844、`deviceScaleFactor = 2`，
> **不是真机截图**。
>
> - `import-unified-native-390.png` / `import-unified-dialog-gone-390.png`：**原生伪装**
>   （`dist` 的 `index.html` 里 `<head>` 最前面注入
>   `window.CapacitorCustomPlatform = { name: 'android', plugins: {} }; window.androidBridge = window.androidBridge || {};`，
>   手法同仓库外那份「类 APK」静态服务 `index.html`），由本地静态服务提供；
> - `import-unified-web-390.png`：**未注入**的 `rspack serve` dev 产物（真·网页端）。

| 截图 | 证明什么 |
| --- | --- |
| `import-unified-native-390.png` | 三行文案为「导入历史会话 / 从链接导入 / 导入分享会话」；两个链接输入框左右对齐、宽高一致（`getBoundingClientRect()` 的 `left / width / height` 完全相等） |
| `import-unified-web-390.png` | 网页端**整行不渲染**「导入分享会话」（也不留「网页端不支持」的提示）；「从链接导入」同样不渲染 |
| `import-unified-dialog-gone-390.png` | 点「导入分享会话」的「导入」后**没有新弹窗**，失败文案直接落在行内（红字），按钮回到「导入」 |

## 量数（同一轮脚本输出）

| 项 | 「从链接导入」 | 「导入分享会话」 |
| --- | --- | --- |
| 输入框 `left` | 32 | 32 |
| 输入框 `width` | 246 | 246 |
| 输入框 `height` | 44 | 44 |
| 圆角 / 字号 | 10px / 14px | 10px / 14px |

- 三行 label 字号 **16px / 22px**，说明位 **13px**（颜色 `rgb(129, 133, 140)`，三级色）。
- 三行行尾按钮（上传 / 导入 / 导入）右边缘同为 **358**，`left` 286、宽 72、高 44。
- 点「导入」后 `[role="dialog"]` 数量：**1 → 1**（就是设置层自己那个 Modal，没有新增弹窗）；
  正对照：点「删除所有对话」时 1 → **2**（确认弹层被计数），说明计数器对嵌套弹窗是敏感的。
- 行内终态文案：「未能读取分享，请检查网络或稍后重试。」（`shareFetchFailed`，既有 key）。
- 网页端：「导入分享会话」命中数 **0**，分享链接输入框命中数 **0**。
