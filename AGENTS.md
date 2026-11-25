# AGENTS.md

本文件给所有参与本仓库的智能体与协作者看。**动手前先读规范正文。**

## 必读

- Issue 规范：[`docs/ISSUE-STANDARD.md`](docs/ISSUE-STANDARD.md)
- 协作流程（认领 / 分支 / 验收）：[`docs/CONTRIBUTING-ISSUES.md`](https://github.com/zzy-repo/deepseek-app/blob/test/429-error-mapping/docs/CONTRIBUTING-ISSUES.md)

## 三条硬规则

1. **任务只认 GitHub Issue。** 聊天里的口头计划不算任务；开工前把 Issue 状态改成 `status:in-progress`，完成后按该 Issue 的关闭条件关闭。
2. **一次只做一件事。** 一条 Issue 最多 5 项必做内容；发现问题另开 Issue 或记入 follow-up backlog，不在原单堆积。
3. **不许伪造完成。** 必须给修复前失败证据、回归真实输出、UI 截图（390 / 360）、未测边界。模拟结果不得写成真机通过。

## Issue 关闭纪律（closing keyword）

> **事故（2026-11-19，PR #389）**：正文第 49 行写了
> `Closes #362? 不——域 1+2 只是十域中的两域，母单 #362 保持开启。`
> 作者本意是**否定**，但 GitHub 的 closing keyword 解析器**只看字符串、不看语义**：
> squash 合并（14:44:51Z）后一秒（14:44:53Z）就把追踪单 #362 自动关了。而 #362 阶段二
> 实际只完成 2/5（A/E 完成，B/C/D 未完成）、L0 耗时目标未达成、6 个命名违规未改、
> 5 个 fixture 还在散放。16:09:06Z 才人工 reopen —— 那 1 小时 24 分里，这单对所有人
> 都是"看起来完成了"，剩余工作没有承接单。

规则：

1. **PR 正文禁止对追踪单用 closing keyword。** 目标是母单（标题带 `[TRACK]` / `[追踪]`
   的汇总单，如 #362 / #301 / #285 / #245 / #62）时，**只写 `Refs #N`**，
   不写 `Closes / Fixes / Resolves #N`（含 `Closes: #N`、大写的 `CLOSES #N`）。
2. **否定句一样会被匹配。** `Closes #362? 不` / `这个 PR 不 Closes #362` 都算数 ——
   关键词后面只要跟一个 `#数字` 就成立，问号、括号、"我是否定意思"一概不看。
   想表达"不关它"，**就别把那串字写出来**：写「母单 #362 保持开启」「Refs #362」即可。
   需要举例说明规则时，用 `Closes #N`（`N` 不是数字，构不成引用）。
3. **追踪单只允许人工关闭**，且必须在 checklist 全部 ✅ 之后，按下面的命令手动关。
   任何一个子项没完成就继续挂着，未完成项另开承接单。
4. **普通 issue 可以由 PR 自动关闭**，但**合并后必须核对被引用 issue 的状态**：
   `gh issue view <n> --json state,title,closedAt` 逐条确认；关错了立刻 reopen，
   并在该单评论里写清"被 PR 误关、剩余工作是什么"。
5. **合并前核对 CI 全绿，并且分清"是谁红的"。** `gh pr view <n> --json statusCheckRollup`；
   若红的是 main 上的既有问题、与你的改动无关，**先修 main，不要在红的基础上叠加 PR** ——
   PR 的 CI 跑的是 merge-ref（main + 你的分支），main 一红，所有在飞的 PR 都跟着红，
   最后谁也说不清是谁弄坏的。（实测：为 #362 落地本节的 #411 就被 #402 拖红 —— main 上
   `src/services/memory` 带 324 条 lint 错误，而 #402 是在自身 CI 已 FAILURE 时被合并的，见 #417。）

官方口径（GitHub docs: Linking a pull request to an issue）：关键词只有 9 个 ——
`close / closes / closed / fix / fixes / fixed / resolve / resolves / resolved`；可带冒号、
不分大小写；引用形态有 `#10`、`owner/repo#100`、完整 issue URL 三种；只看 **PR 描述和
commit message**，且只在 PR 指向**默认分支**时生效。自动关闭发生在**合并那一刻**，
写错了改正文也救不回来（只能 reopen）。

```bash
# 合并后核对被引用的 issue 有没有被误关
gh issue view <n> --json state,title,closedAt
# 追踪单人工关闭（先确认 checklist 全 ✅）
gh issue edit <n> --remove-label status:in-progress --add-label status:done
gh issue close <n> --comment "checklist 全 ✅，阶段 X 完成；剩余：<无/已转 #M>"

# 合并前自查 PR 正文（可选脚本，见下）
node scripts/check-issue-close-keywords.mjs --pr <pr-number>
node scripts/check-issue-close-keywords.mjs --body-file pr-body.md --strict
```

静态检查状态：`scripts/check-issue-close-keywords.mjs` 能查出「正文 closing keyword 指向
`[TRACK]`/`[追踪]` 单」，**但目前没有进 CI**——接线要改 `.github/workflows/ci.yml`
（加 `pull-requests: read` 权限 + 一步 `--strict`），而落地这条规则的那次改动只覆盖文档与
模板。**在接线完成前，它只能手动跑：别把"脚本存在"当成"规则生效"。** 追踪：见
[`docs/ISSUE-STANDARD.md`](docs/ISSUE-STANDARD.md) 第七节。

## 门禁治理（加 / 删 / 豁免）

仓库里有几十道门禁（`scripts/check-*.mjs`、产物扫描、测试层、发布校验）。**每道门禁为什么存在、
红了该找谁、怎么加、怎么删**只有一个地方写：**[`docs/testing/gates-ledger.md`](docs/testing/gates-ledger.md)**。
动手改门禁前先看那一页，本节只留四条硬规则：

1. **一道门禁存在的理由，必须能写成一句话的事故**：「因为曾经有人 X，导致 Y」，Y 是用户能感知的
   后果（白屏 / 下载 404 / 已装用户无法升级 / 数据对不上）。写不出来 → 这道门禁不该存在。
2. **新增门禁的准入在"添加的时候"生效**，不是事后审计：必须交齐 **事故 + 证据 + 为什么现有门禁防不住
   + 它自己怎么被证伪（负向对照四拍）**，并同步补 `ci.yml` 步骤、`tests/unit/domain10-gate-wiring.test.mjs`
   的接线断言、以及台账一行。缺一样就别提 PR（详见台账 §3）。
3. **先全绿再接线。** 接一道恒红的门禁等于没有门禁 —— 它会变成 CI 的背景色，然后没人再看。
   确实还不能接线的，必须登记进 `KNOWN_UNWIRED` 并写理由：**登记 ≠ 生效**。
4. **豁免会过期。** known-red 与豁免只许以基线条目形式存在，每条必须带 `reason` + 一条「会被自动发现
   过期」的判据（跑绿即报 `FIXED?`，或 `reviewAfter` 到期判红），且**只减不增**。规矩与现有载体清单见
   台账 §5；不要再把口径写进某个 json 的 `note` 字段里 —— 那里没人读得到。

红了先分清是谁的红：`exit 2` = 门禁没跑起来（不是你的改动）、`exit 1` + 点名你碰过的文件 = 你的、
点名你没碰过的 = 既有债（先修 main）、`SKIP(env)`/`77` = 环境不满足（**不是绿**）。对照表见台账 §1。

## 常用命令

### 第一步：改完先跑本地门禁（别把「5 秒能发现的事」留给 CI）

```bash
pnpm hooks:install     # 一次性：接上 .githooks（commit 跑提交档、push 跑默认档）
pnpm dev-check         # 改完那一刻：32 道内容门禁 + 类型 + lint，一次给结论（实测 ~14s）
pnpm dev-check -- --content   # 只想快速过一遍（~4s）：纯内容门禁，pre-commit 跑的就是这条
```

**为什么是这条而不是「记得跑一下 CI 里的那些 check」**：仓库里 42 个 `check:*` 门禁，
每一个都便宜（0.1~8s），但以前只在 CI 里跑 —— 也就是说「一个 CRLF 文件」「一对仅大小写不同的
文件名」「一行写死的 IP」要等你 push 之后 3~8 分钟才知道，而那时人的反应多半是**绕过**而不是修。
`dev-check` 不新增任何检查，它只是把**已有**的那批搬到最便宜的失败点上，并且：

- **红可归因**：它先看你的改动集，再决定这条红是「你这次改坏的」（阻塞，exit 1）还是
  「HEAD 上本来就有的」（不阻塞，△ 标出来）。所以它不会变成第二条「反正天天红」的命令。
- **失败自带下一步**：每条红都打印该门禁自己的修法 + 单跑命令 + 为什么有这道门禁。
- **判不了 ≠ 通过**：缺产物/缺依赖时它明说「判不了」，不伪装成绿。

口径、分档、归因规则见 [`docs/TESTING-POLICY.md`](docs/TESTING-POLICY.md) 第 2 节与第 14 节；
要更厚的一层用 `pnpm test:fast`（≤60s，超预算自己判红），全量只在合并前/发版前跑
（`pnpm test:full`）。**不要在红的基础上继续推** —— 先看那条红是谁的、归哪张单。

```bash
# 认领
gh issue comment <n> --body "/claim 分支 feat/xxx"
gh issue edit <n> --remove-label status:todo --add-label status:in-progress

# 查看当前可做
gh issue list --label status:todo

# 关闭（先打 done 标签）
gh issue edit <n> --remove-label status:review --add-label status:done
gh issue close <n>
```

### 网络：GitHub 必须走代理

本机直连 github 不通（`github.com` 被解析到 `57.155.223.240`；`git fetch` 报
`RPC failed; curl 28 ... port 443`，`git push` 报 `GnuTLS recv error (-110)`）。
**所有** fetch / push / ls-remote / gh 命令都要带代理，否则表现为超时或 TLS 中断：

```bash
export https_proxy=http://127.0.0.1:7897
export http_proxy=http://127.0.0.1:7897

# 一次性写法（不常驻环境变量）
timeout 120 env https_proxy=http://127.0.0.1:7897 http_proxy=http://127.0.0.1:7897 \
  git fetch origin --prune
timeout 120 env https_proxy=http://127.0.0.1:7897 http_proxy=http://127.0.0.1:7897 \
  git push --force-with-lease=<branch>:<old-sha> origin <branch>

# 不依赖本地 ref 缓存的复核（推完必查）
timeout 60 env https_proxy=http://127.0.0.1:7897 git ls-remote --heads origin <branch>
# socks5 亦可：-x socks5h://127.0.0.1:7897，或 ALL_PROXY=socks5h://127.0.0.1:7897
```

磁盘卫生（清 `node_modules` 不删 worktree）见
[`docs/RELEASE-MANUAL.md`](docs/RELEASE-MANUAL.md) 第 10 节第 6 条。

## 行尾（EOL）：提交前必须 LF

`.gitattributes` 定的是 `* text=auto eol=lf` —— **仓库里 git 跟踪的文本文件一律 LF**，
所以在提交前把编辑器 / IDE 的行尾设成 LF，别提交 CRLF。

为什么这条是硬规矩（#533）：行尾噪音会**假性放大**冲突。#323 的 30 个改动文件里 27 个
只有行尾不同，`+8126/−7757` 里一大半不是真实改动，于是「17 个真实冲突」变成
「19 个文件 21 个 hunk」；review 看不清改了什么，`git blame` 也失效。

**Windows 贡献者必看**：把 `core.autocrlf` 设成 `false`（或 `input`），**不要用 `true`**：

```bash
git config core.autocrlf false    # 推荐：工作区与索引都是 LF
# 或者
git config core.autocrlf input    # checkout 不动、checkin 归一为 LF（次选）
```

`core.autocrlf=true` 会在 checkout 时把 LF 写成 CRLF，于是你本地每个文件都是脏的，
提交上去又和 Linux/macOS 的人互相打架 —— 这正是 #323 那 27 个文件的来源。

**门禁**（CI 的 checks job 里有这一步，摘不掉）：

```bash
pnpm run check:eol                     # 有违规 → 打印 文件:首个 CRLF 行号 并 exit 1
node scripts/check-eol.mjs --fix       # 把违规文本文件原地归一为 LF（只改行尾，保留 BOM 与其余字节）
node scripts/check-eol.mjs --selftest  # 脚本自带反例：CRLF 文本必红、.bat 与二进制必豁免
```

**为什么 `*.bat`（`android/gradlew.bat`）豁免 CRLF**：`.gitattributes` 里写的是
`*.bat -text !eol`，也就是「这类文件不做行尾转换」，工作区与索引里都保留 CRLF。
原因是 cmd.exe 解析批处理里的 `label` / `goto` 在 LF-only 下有坑（`goto :eof` 这类写法
会读错行）。同理 `*.cmd`。它们不是「检查漏了」，是**按约定不转** —— 门禁从
`.gitattributes` 读豁免口径，改 `.gitattributes` 就等于改门禁。

二进制（apk / aab / zip / jar / keystore / png / jpg / bcmap …）同样不判行尾，
名单来自 `.gitattributes` 的 `binary` 行（新增二进制类型请加在那里，不要在脚本里加）。

**归一行尾的提交必须单独一次**（只改行尾、不改内容），这样以后追历史可以用
`git blame --ignore-rev <那个 commit>` 直接跳过噪音。存量归一就是这么做的（#533 第二个 commit）。

## 禁止

- 提交真实 API Key、管理 Token、签名下载链接
- 把用户反馈原始日志 / 联系方式写进 Issue
- 直接 push `main`（发布走 release 分支）
- 同时跑多台模拟器；重构建串行（内存有限）
- `git add -A` 提交无关改动
