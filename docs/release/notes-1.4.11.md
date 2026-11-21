# Release 正文模板：deepseek-chat 1.4.11（**draft，未发布**）

> 这是**模板**，不是发布物，也不代表 v1.4.11 已经存在。
> 填完 `<…>` 占位符 → 按「§0 填写步骤」逐项替换 → 用「§2 正文」那一段作为 `gh release create --notes-file` 的输入。
>
> 版本号理由见 §1。正文里**只允许**出现「§2 运行配置（公开部分）」表里那四个域名：
> 裸 IP、webroot 绝对路径、私有清单文件名、任何凭据字样**一律不进正文**（判据见 §3）。

---

## 0. 填写步骤（出包后 5 分钟能填完）

| # | 占位符 | 从哪来 | 命令 |
| --- | --- | --- | --- |
| 1 | `<SIZE_BYTES>` / `<SIZE_MIB>` | 出包产物实际字节 | `stat -c%s $APK` |
| 2 | `<SHA256>` | 三种工具交叉（node:crypto / sha256sum / openssl 应一致） | `sha256sum $APK` |
| 3 | `<MD5>` | 同上 | `md5sum $APK` |
| 4 | `<SIZE_MIB>` | 字节 ÷ 1048576，保留两位 | `awk "BEGIN{printf \"%.2f\", $(stat -c%s $APK)/1048576}"` |
| 5 | 变更摘要 | 见 §4「变更摘要的来源」 | `git log v1.4.9..<merge-sha> --oneline` |

**顺序是硬要求**：先出包拿 sha256/size → 再填正文 → 再建 draft → 上传 → 回读资产 sha256 → 才 publish。
正文里的 sha256 必须是**已上传资产**算出来的那份，不是「本轮构建想当然的那份」。

---

## 1. 版本号结论（本次的建议值，供合并时定稿）

| 项 | 值 | 依据 |
| --- | --- | --- |
| `version` | **1.4.11** | `v1.4.10` **已发布**（2026-11-21T14:44Z，`a21dfb7b`，versionCode 29），故在其之上递增 |
| `androidVersionCode` | **30** | 已发布最高是 `v1.4.10` 的 **29**，严格递增取 **30**；**递减会导致覆盖安装失败** |
| 不复用的号 | `1.4.2` | 历史事故号，永不复用（`docs/RELEASE-CHECKLIST.md` P5） |
| 不可用的号 | `1.4.4` | 已用于 staging 预发布（`v1.4.4-staging`），不占正式位但也不回填 |

> 备选：若维护者认为本批功能属于 minor 级，可用 `1.5.0`（`versionCode` 仍是 **30**）。
> 两条路都满足「version 严格递增 + versionCode 严格递增」，**只有 1.4.11 与现行 patch 节奏一致**。
>
> 说明：`v1.4.10` 已发布（三行模型来源 / 自动兑现 / 域名切换都在里面）。本版正文仍保留一段「延续 1.4.10」，
> 原因是这三块是本版其余改动的前提（比如自动兑现的数据源修正建立在 1.4.10 的闭环之上）；若不想重复，删掉那一段即可，不影响其余内容。

---

## 2. 正文（下面 `<!-- BODY-START -->` 到 `<!-- BODY-END -->` 之间就是发布正文）

<!-- BODY-START -->

## deepseek-chat 1.4.11

- versionName: `1.4.11`
- versionCode: `30`
- 文件: `deepseek-chat-1.4.11.apk`
- 大小: **<SIZE_BYTES>** 字节（<SIZE_MIB> MiB）
- SHA-256: `<SHA256>`
- MD5: `<MD5>`

### 变更摘要

**对话（用户可见）**
- 未登录 / 没有可用渠道 / 没有可用 Key 时，**发送前就拦下**并提示该去哪配：不再发出去才报错，也不再白跑一次请求

**历史额度迁移（用户可见；功能开关仍默认关）**
- 补齐迁移链路两处真缺口：**设备指纹终于有写入方**（登录成功后、claim 之前解析落盘；拿不到就一个字节都不写，失败静默，不阻断登录）
- 迁移**结果上屏**：「我的钱包」页底部显示「历史额度已迁移：¥X」；服务端早已自动迁过但金额为 0 时给「仍要迁移」兜底入口；开关关闭时组件零痕迹，切号清结果不串号

**钱包（用户可见）**
- 自动兑现的数据源修正：改为问**订单接口**取最新一笔待兑现订单 —— 原来看的「已兑流水」在真卡还没兑换时查不到，会出现「付款回来 0 次兑换、余额不动」
- 到账 toast「已自动到账 ¥X」；处理中 / 失败给「去兑换」入口且**不重试**；本地按订单号去重，不落卡密原文

**延续 1.4.10（已发布，未变更）**
- 设置 →「账户与消费 → 模型来源」为一屏**三行**列表（内置服务 / 第三方服务 / DeepSeek 官方服务），点行进子页
- 付款后自动兑现；登录卡分段常显「登录 | 注册」；Web 侧兜底传输
- 更新首选渠道为域名（同一台机器，明文 http），回退 https 不变；安装前照旧核对 SHA-256 / 包名 / versionCode

### 运行配置（公开部分）

| 项 | 值 | 说明 |
| --- | --- | --- |
| 消费网关 `consume.baseUrl` | `https://apia.ecsafe.cn/staging` | 额度 / 卡密 / 账号 / 我的钱包 |
| 支付网关 `pay.baseUrl` | `https://apia.ecsafe.cn` | 支付下单 |
| 更新分发（首选） | `http://jingluo.nekoai.com.cn` | 明文 http；域名指向原分发机（同一台） |
| 更新回退 | `https://dl.rose7.cn` | 首选不可达时使用，https |
| 变体 `variant` | `standard` | 不含 internal 联调标记 |
| 构建类型 `buildType` | `stable` | 走正式更新通道 |
| WebView 基线 | Chromium 83 | 语法 / API 下限，低于此版本不保证 |

### 校验方法

```
sha256sum deepseek-chat-1.4.11.apk
apksigner verify --print-certs deepseek-chat-1.4.11.apk
```

第一行应等于上面的 SHA-256；第二行的 `certificate SHA-256 digest` 应是已发布证书指纹
（与上一版一致 —— 指纹变了说明签名材料被换过，装过旧版的机器会覆盖安装失败）。

<!-- BODY-END -->

---

## 3. 正文禁词自检（**发布前必跑，命中就不许发**）

```bash
# 取出正文那一段（不含本模板的说明与 §3/§4/§5），逐条扫禁区。
# 注意：模式串必须**锚到行首的完整注释行**，否则会连下面这条命令自己一起捞进来（第一版就踩了这个坑）。
awk '/^<!-- BODY-END -->/{f=0} f; /^<!-- BODY-START -->$/{f=1}' \
  docs/release/notes-1.4.11.md > /tmp/notes-1.4.11.md
head -3 /tmp/notes-1.4.11.md     # 应看到「## deepseek-chat 1.4.11」

# 禁词口径 = scripts/audit-release.mjs 的 FORBIDDEN_NEEDLES（大小写敏感，字面量）
for n in '140.210.' '62.106.' '123.207.' '/var/www' 'releases.json' 'primaryBase' 'token'; do
  if grep -nF -- "$n" /tmp/notes-1.4.11.md; then echo "FAIL: 正文命中 $n"; exit 1; fi
done
echo "OK：正文 0 命中（IP 段 / webroot / 私有清单名 / 内部字段名 / 凭据字样）"
```

**这条不是形式**：正文是公网可见面，`audit:release` 的第 9 项判据（`forbidden-words`）用的就是同一张表。

> ⚠️ 与 staging runbook 的口径差异（**别照错那份**）：`docs/release/staging-release-runbook.md` §6.4 的
> 公开自证正则把 `rose7.cn` / `ecsafe.cn` / `https://` 全列为禁区 —— 那是**预发布（staging）正文**的口径，
> 目的是不让 staging 包被当成正式版。**正式版**按本节的禁词表判（域名是产品端点，必须能让用户看到）。
> 若把本模板正文丢进 §6.4 那条正则里跑，会因为「运行配置（公开部分）」表而红 —— 那是预期行为，不是本次的红。

---

## 4. 变更摘要的来源（只写**这一版真的包含**的改动）

口径（`docs/RELEASE-CHECKLIST.md` P4：「CHANGELOG 只写这一版真实包含的改动」）：

```bash
# ① 上一个已发布 tag 到本次合并提交之间的全部提交（不是到分支头 —— 分支头会漂）
LAST=$(git describe --tags --abbrev=0 --match 'v1.4.*' v1.4.9 2>/dev/null || echo v1.4.9)
MERGE_SHA=<合并进 main 的提交 sha>
git log "$LAST".."$MERGE_SHA" --oneline --no-merges

# ② 只取用户可见的两类（feat / fix）；test / docs / chore 不进用户正文
git log "$LAST".."$MERGE_SHA" --pretty='%s' --no-merges | grep -E '^(feat|fix)'

# ③ 用户看得见的那部分要有出处：每个 feat 后面括号里的 issue 号即出处
```

填写规则：

- **只写 `feat` / `fix` 且用户能感知的**；`test:` / `docs:` / `chore:` 一律不写进用户正文（可以留在 CHANGELOG 的内部备注里）。
- 每条一句话，说「用户现在能做什么 / 不再遇到什么」，不写提交标题原文。
- 同一类改动合并成一条，别按 commit 逐条列（上一版就是这么写的：修复 / 界面 / 登录 三段）。
- **没有合进 main 的功能一个字都不许写**（1.4.7 事故：版本 PR 把未合入的 UI 写进了变更记录）。
- 版本 PR 里同步 `CHANGELOG.md` 的同版本小节 —— 它同时是 dl 的 `meta.changes` 与 Release 正文的来源
  （`scripts/release-check.mjs` 第 3 项会验 `CHANGELOG.md` 有没有 `## 1.4.11` 段）。

---

## 5. 本模板刻意留空/不留的东西

| 项 | 为什么不写 |
| --- | --- |
| 裸 IP、端口 | 正文公网可见；禁词表第一档就是三个历史 IP 段 |
| 分发机绝对路径（webroot 形态） | 同上，`/var/…` 这类路径属于内部拓扑 |
| 私有清单文件名 | 它会等于把私有包的直链广播出去（#601 事故的形状） |
| 任何凭据 / 令牌字样 | 小写字面量一律按泄漏处理 |
| 证书指纹以外的签名细节 | 只给用户可自证的 SHA-256 与 apksigner 指纹 |
| 「发送前拦截」那条（#793） | 已合入 main（PR #798 → `96498289`），正文与 CHANGELOG 均可写。合入前曾标注「必须复核」，已按事实去掉 |
