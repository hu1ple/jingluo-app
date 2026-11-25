# main 四道既有红的处置记录（2026-11-26）

基线：`origin/main = 77720a32`（`Merge pull request #891`）。本文记录四道「本来就红」的内容档门禁
各自的**性质判定 / 改动 / 自证**，以及顺手量到的其它现状。分支 `gate/mainred`。

依据 `AGENTS.md` 第五节：main 一红，所有在飞 PR 都跟着红 —— 所以既有红先修 main，不在红的基础上叠 PR。

## 一、四道红的性质（先判性质，再动手）

| 门禁 | 改前 | 性质 | 结论 |
|---|---|---|---|
| `check-hardcoded-ip` | exit 1，4 处 | **判据咬到自己**（4 处全是 `scripts/` 里的**说明文字**，不是可调地址） | 4 行按门禁自己文档规定的 `check-ip-allow`（注释行白名单外的例外通道）带理由豁免 |
| `check-consume-api` | exit 1，1 处 | **判据钉错了边**（把第三方公开只读接口判成「消费我们网关」） | `PATH_WHITELIST` 加一条**带理由**的 `/api/v0/share/content` |
| `check-log-coverage` | exit 1，2 项 | **真缺陷**（console hook 的 error meta 只有 `stage` 一个键，栈在这一步就丢了） | 补字段；顺带删掉已被这次修复消解的 2 条失效登记 |
| `check-refactor-direction` | exit 1（A2） | **依赖红**：A2 的实体就是跑 `check-consume-api`，它红是因为上游那 1 条 | 一行没改 —— 上游转绿，A2 自己就绿了 |

「四道是唯一挡在 main 全绿的 content 档红」这句在本次基线上**不成立**：另有两道也是红的（第五节），
但都不在本单领地（`tests/**` 与 `docs/ui/**`），另 lane 处理。

## 二、逐条：它防的事故 / 我改的是哪一侧 / 凭什么

### 2.1 `check-hardcoded-ip` 的 4 处 —— 改判据侧（用它自己的例外通道）

4 处命中（改前行号）：

- `scripts/check-consume-api.mjs:16` —— R4「废弃域」判据原文
- `scripts/lib/consumeEndpoints.mjs:29` —— 规则 2 原文
- `scripts/lib/hardcodedIpAudit.mjs:42` —— 门禁自身历史（#274 之前白名单是手写的）
- `scripts/verify-release-apk.mjs:62` —— 引用 #651 发版铁律原文（staging 指向哪台机）

**这条判据原本防的事故**：三代写死 IP（`123.207.199.196` → `62.106.70.167` → `140.210.13.146`）的
迁移全靠 `grep -rn` 自觉，漏一处就是一处线上故障 —— 用户升级后打到一台已经不存在的机器上，界面只会转圈。
所以要拦的是**代码里又抄了一遍可调地址**。

**这 4 处为什么不是那个事故**：四处全是 `scripts/` 里的注释文字，不参与运行、不发请求，
写出来的目的正是「说清不许出现什么」/「说清以前是什么」。删掉地址，判据就说不清了。

**根因可归因（不是有人新写了地址）**：#875 `442d829f`
（`chore(config): 反馈地址换成域名，移除 allowedHosts/allowedPorts 里的裸 IP`）把裸 IP 从
`config/endpoints.json` 的 `allowedHosts` 里删了，于是「注释行里的白名单主机放过」这条豁免对它们失效 ——
**同一批文件一个字都没改就一起变红**。实证：把 `allowedHosts` 换回 #875 之前的值，用同一份
`scanText` 扫这 4 个文件，四处全部 `[]`（绿）。

**我改的是哪一侧**：判据侧（放行判定），且只用门禁自己文档里写好的通道 ——
`scripts/check-hardcoded-ip.mjs` 文件头第 25 行原本就写着：「同一行（或上一行）带 `check-ip-allow` 标记的
字面量：给『已下线主机名单』『规范条款号』这类必须写出 IP 形状的地方用，必须注明理由」。
仓库里已有先例（`scripts/lib/consumeEndpoints.mjs` 的 `DEPRECATED_MARKERS` 两条、`scripts/check-refactor-direction.mjs`
的 `LEGACY_ADDRESS_RULES`）都用的这个通道。**没有放宽任何判据**：代码行里再写地址、注释行里写白名单外地址，
照样红（第三节自证）。

顺带把 `scripts/check-refactor-direction.mjs` 里两处同类文字（A1 判据原文）补上显式标记：它们当时是
**偶然**绿的（行里出现 `android`，撞进了 `VERSION_MARKERS` 版本词表），不是按意图豁免的。

### 2.2 `check-consume-api` 的 `/api/v0/share/content` —— 改白名单侧（带理由）

调用点：`src/services/chat/history/deepseekShare.ts:300`，拼的是
`origin + '/api/v0/share/content?share_id=' + id`，`origin = 'https://chat.deepseek.com'`
（同文件常量，走 CapacitorHttp 原生网络栈）。

**这条判据原本防的事故**（#484 §三）：重构期客户端四处乱调后端，绕开 consume / pay 两个 base，
新增能力不评审就先上线 —— 白名单是一张「只许调这些」的端点表。

**为什么这处不属于那个事故**：它打的是**官方 DeepSeek 分享页自己用的公开读接口**（分享会话导入），
不经过 `config/endpoints.json` 的 consume / pay，不带我们的 JWT / `sk-` Key，也不是「我们后端的新能力」。
门禁拿「消费我们自己网关」的尺子量第三方只读接口 = 判据钉错了对象。

**为什么是进白名单、而不是改代码绕过去**：判据扫的是**路径字面量**。把路径换成常量、拼进变量，
字面量规则就一起失灵了 —— 那是把门禁关掉，不是把问题修掉。所以正确归宿是白名单，
并按本仓惯例**带 reason**（`scripts/lib/consumeApiAudit.mjs` 里条目上方写 `§3.7` 整段理由：
它是什么、为什么不该被这条判据管、以及它**不免**什么 —— 改成打 `consume.baseUrl + 该路径` 时
R2/R4 仍各红一次）。

收窄性自证：`/api/v0/share/other` 仍红（这条白名单是精确项，不是 `/api/v0/*` 前缀通配），见第三节试验 2。

### 2.3 `check-log-coverage` 的 `collector.ts:1039` —— 改实现侧（真缺陷）

`installConsoleHook` 里包 `console.error` / `console.warn` 的 `record(...)`，meta 只有 `{ stage: 'console' }`。

**这条判据原本防的事故**（#301 表 3）：新加的埋点只写一句人话，排查时切不出维度 ——
「日志太笼统」的成本要等用户反馈时才付。

**为什么是真缺陷**：这条埋点记的是**别人**的 console 输出。只有 `stage` 等于「我知道它来自 console」，
没有第二个维度；更要紧的是 `console.error(err)` 这个最常见写法，`safeString(err)` 只留 `Error: xxx`，
**`stack` 在这一步就没了**，事后拿不回来。

**改动**（实现侧，按判据补齐，不压制判据）：补 `'console.args'`（实参个数），并在首个实参是 `Error` 时
并入 `errorMeta`（`error.name` / `error.stack` / `http.status`）—— 与 `window.onerror` / `unhandledrejection`
两条 hook 同一套字段。

**顺带删掉 2 条失效登记**（`scripts/log-coverage-baseline.json` 的 `metaDebt`）：`collector.ts::warning::#1`
与 `collector.ts::error::#4` 登记的就是**这一条埋点**（同一个 `record` 调用，kind 是三元的两个分支）。
把字段补齐后它不再违规，登记必须删 —— 这正是该门禁「登记簿只能减，代码修好不删登记照样红」的设计。
（`error::#4` 在改前就已显示「失效」，原因见第六节：同组内新增了调用点，序号漂了。）

### 2.4 `check-refactor-direction` 的 A2 —— 没改，跟进上游

A2 的实体是「跑 `scripts/check-consume-api.mjs` 看 exit code」，**它不复制上游规则**，只把上游的结论
（exit code + 尾部样本行）搬进自己的证据里。所以它红就是 2.2 那条没修；2.2 修好，A2 自动转绿。

关于「把上游红整段搬进自己输出是重复劳动」：现状已经是「引用上游结论」而不是「重写判据」，
真正的重复只有一次 `spawn`（~310ms，纯文本扫描）。改成缓存 / 复用上游判定都需要额外状态，
收益不抵风险，**本单不改**（留作可选改进，见第七节）。

## 三、自证

改前 / 改后（同一台机器，`origin/main` 的干净 worktree vs 本分支）：

```
改前（77720a32）                              改后（gate/mainred）
check-hardcoded-ip      EXIT=1 4 处    →     EXIT=0  违规 0 处（扫 529 个文件）
check-consume-api       EXIT=1 1 处    →     EXIT=0  白名单 37 条（原 36）
check-log-coverage      EXIT=1 2 项    →     EXIT=0  R3 通过、登记簿 4 条
check-refactor-direction EXIT=1 A2 FAIL →    EXIT=0  A1–A6 全绿，A7 MANUAL
```

四组「故意破坏必须被拦」（每次破坏后还原，再确认回到绿）：

| # | 破坏 | 结果 |
|---|---|---|
| 1 | 在 `src/` 下临时新建一个探针文件（`__gate_neg_ip_probe.ts`），一行写 `const NEG_UPSTREAM = '140.210.13.146'`，另一行注释写白名单外的旧机 `62.106.70.167` | `check-hardcoded-ip` 报 `:2` 与 `:4` 两处 → exit 1；删除 → exit 0 |
| 2 | 同 CI 做法往 `src/` 的探针文件里塞 `/api/v1/__gate_neg_not_whitelisted`；另测近似路径 `/api/v0/share/other` | 两条都 exit 1 并点名文件:行（证明新白名单是精确项）；删除 → exit 0 |
| 3 | 把 `collector.ts` 的 meta 改回只剩 `{ stage: 'console' }` | `check-log-coverage` 报 R3 meta 贫瘠（warning / error 各一条）→ exit 1；还原 → exit 0 |
| 4 | 往 `src/` 塞一条白名单外路径（= 把调用挪回错误层） | `check-refactor-direction` A2 FAIL，证据行指向上游输出与 `文件:行` → exit 1；还原 → exit 0 |

其它门禁（本分支）：`npx tsc` exit 0、`npx oxlint src` exit 0（0 warnings / 341 文件）、
`check-eol` exit 0（1516 个文本文件无 CRLF）、`check:consume-api --selftest` exit 0。

## 四、为什么这不算「把判据放宽来变绿」

| 门禁 | 是否动判据 | 论证 |
|---|---|---|
| hardcoded-ip | 否（只是用了文档写明的例外通道，逐行带理由） | 哪一处是「判据该拦的事故」？没有 —— 四处都是规则书文字，不可调、不发请求。判据本来的意图（代码里别抄地址）一点没动：破坏试验 1 立刻红 |
| consume-api | 是，且是**修判据钉错的对象**：`/api/v0/share/content` 是第三方公开只读接口 | 判据想防的是「客户端绕开我们的 base 乱调我们后端」；这个接口不是我们的后端。白名单条目带整段理由 + 收窄说明，近似路径仍红 |
| log-coverage | 否 | 改的是实现（补字段）。基线只**删**了 2 条已被修复消解的登记，没有新增任何豁免 |
| refactor-direction | 否 | 一行未改 |

## 五、全仓现状（`origin/main` 上除 `check-doc-refs` 之外的红）

本分支实测的静态内容档门禁：

- 绿：`check:hygiene` `check:eol` `check:dup-impl` `check:case-collision` `check:db-version`
  `check:test-layout` `check:manifest` `check:i18n` `check:endpoints` `check:capabilities`
  `check:redact` `check:guard` `check:icon` `check:retention` `check:identity` `check:limits`
  `check:webroot-hygiene` `check:artifact-prefix` `check:private-publish-root` `check:compat-baseline`
- 本单修绿：`check:ip` `check:consume-api` `check:log-coverage` `check:refactor-direction`
- **仍红（不在本单领地，另 lane）**：
  - `check:test-duplication`（exit 1）—— R1 逐字重复 ≥20 行、基线外 2 组：
    `tests/unit/pay-link-861.test.mjs` ↔ `tests/unit/pay-link-hardening-861.test.mjs`（35 行）、
    `tests/unit/memory-session-scope-399.test.mjs` ↔ `tests/unit/session-branch-831.test.mjs`（28 行）。
    已确认在 `origin/main` 干净 worktree 上同样 exit 1。领地归 `tests/**`。
  - `check:ui-shots`（exit 1）——  orphan 截图 121+ 条 + 悬空引用 8 条（`docs/ui/819-invite-flash/README.md`、
    `docs/ui/819-invite-visible/README.md` 里的 `-360.png` 裸名）。同样在干净 main 上 exit 1。领地归 `docs/ui/**`。
  - `check:doc-refs`（exit 1）—— 本单按约定不看它（另 lane 在处理文档引用漂移）。
- 需要产物 / 设备的（本地判不了，与本次改动无关）：`check:test-seam` `check:bundle-target` `check:legacy`
  `check:syntax-floor` `check:matrix` 均因 `dist/` 不存在而报「先构建」（exit 2 / 1），不是判红；
  `check:keystore`（缺 `keystore.properties`，exit 2）与 `check:apk`（缺 APK 路径，exit 2）是用法 / 环境码。

单元测试层：`npm run test` 在本分支与干净 `origin/main` 上是**同一份失败清单**（逐文件比对过），
与本次改动无关；其中 `tests/unit/check-ip-version.test.mjs` 的 2 条失败正是 #875 的残留——
它还在断言「`140.210.13.146` 在 `allowedHosts` 里」的旧口径（注释行放过、代码行报
`allowed-host-in-code`）。`tests/**` 不在本单领地，未改。

## 六、顺手量到的两个判据缺陷（另开单，不在本单修）

1. **`VERSION_MARKERS` 里含 `android`，构成一处漏报**。`scripts/lib/hardcodedIpAudit.mjs` 里
   `VERSION_MARKERS` 收了 `android`，而 `HOST_MARKERS` 里没有对应否决词，于是「行内有 android + 一个真地址」
   会被当版本语境整行放过。实测：`// android 端连 140.210.13.146` → **0 命中**（漏）；
   同句加一个地址语义词 `// android 服务器连 140.210.13.146` → 报 1 处。
   本次不给词表动刀：它会波及所有 lane 的既有行，且需要配套负向对照（`tests/unit/check-ip-version.test.mjs` 已红，
   测试侧也归别人）。建议单独开单处理，并把「注释里写旧机」这类统一改用 `check-ip-allow` 显式登记。
2. **`metaDebt` 的序号键会漂**。`scripts/log-coverage-baseline.json` 用
   `文件::kind::label#组内序号` 定位，而 `collector.ts` 里 5 条 error 记录的 label 都是空串（消息是表达式，
   抽不出字面量），于是「同组新增一条」就把后面所有序号顶走 —— 登记簿看起来「失效」，
   真正的违规却在另一个序号上（改前：`error::#4` 报失效，实际违规在 `#5`）。
   现在这两条已随缺陷修复一起删除，但机制本身还在（其余 4 条 `metaDebt` 同样暴露）。建议单独开单。

## 七、需要跨 lane 整合的事

1. **`scripts/log-coverage-baseline.json` 可能被两条 lane 同时改**：本单删了
   `collector.ts::warning::#1` 与 `collector.ts::error::#4`。「另有 1 条基线失效已另 lane 处理」指的就是
   `error::#4`；两次删除是**同一行删除**，git 合并不会冲突，谁先合都行，保留一份即可。
   注意：只删 `error::#4` 而不改 `collector.ts` 是**不够**的 —— 改前真正违规的是 `#5`（console hook），
   基线失效只是序号漂移的假象。
2. **`check:test-duplication` / `check:ui-shots` 的红**归 `tests/**` 与 `docs/ui/**` 的 lane；两处不修，
   main 不会全绿，本单的 CI 也会被拖红（正是 `AGENTS.md` 第五节那条）。
3. **`tests/unit/check-ip-version.test.mjs` 的 2 条失败**是 #875 的后续：测试口径还停在旧白名单上，
   需要 `tests/**` lane 按新口径（`allowedHosts` 只剩域名）重写这两条断言。
4. `check-doc-refs` 另 lane 处理；本单新增本文档时已保证只引用真实存在的路径。

## 八、改动清单

```
scripts/check-consume-api.mjs           +2   R4 判据原文补 check-ip-allow（带理由）
scripts/check-refactor-direction.mjs    +2   A1 判据原文补标记（含把「偶然绿」改成显式）
scripts/lib/consumeApiAudit.mjs         +19  §3.7 白名单条目 /api/v0/share/content（整段理由 + 收窄口径）
scripts/lib/consumeEndpoints.mjs        +2/-1 规则 2 原文补 check-ip-allow
scripts/lib/hardcodedIpAudit.mjs        +1   门禁自身历史补 check-ip-allow
scripts/log-coverage-baseline.json      -2   metaDebt 删 2 条（被本次修复消解的登记）
scripts/verify-release-apk.mjs          +1   #651 铁律原文补 check-ip-allow
src/services/diagnostics/collector.ts   +12  console hook 补 meta 字段（console.args + errorMeta）
docs/gate-mainred-20261126.md           新增  本文
```

`src/services/chat/history/deepseekShare.ts` **一行未改**：判定是「接口不是我们的网关 → 白名单是它的正确归宿」，
改代码反而会把字面量判据绕过去。
