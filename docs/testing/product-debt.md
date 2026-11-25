# 产品债台账：L1 仍红里「等一句话」的那些

> **这不是「已知红的豁免表」，是未完成决定的清单。** 每条都必须有人答一句话才能继续；
> 到期未答 → 该用例按红处理，不许静默挂着。
>
> **当前状态：待决策 1 条**（`provider-channels`）。已裁决并落地 6 条（2026-11-26）。
> **产品债清零前，L1 不能宣称全绿。**

## 为什么会有这份台账（先看因果，再看用法）

因为红长期是常态，产品改版导致的断言失效**看不见**，于是没人跟 → 滚成债。

这份台账治的是「事后考古」，但**根治要把决策前移**：改版时在 PR 里写清撤销 / 改名了哪些契约
（见 [`.github/PULL_REQUEST_TEMPLATE.md`](../../.github/PULL_REQUEST_TEMPLATE.md) 的
「用户可见契约变更（必填）」一栏），门禁才可能「判变对没有」，而不是每次都来问人。

## 0. 这份台账管什么

L1（`tests/run-layer.mjs integration`）有一批红，它们的共同点是**红得没有争议，但「该断言什么」没有结论**：
产品在 #800 / #807 / 错误文案定稿之后有意删掉了被断言的对象，测试却还在断旧口径。
这类红既不能当「测试 bug」直接改绿（改绿等于替产品决定「这个功能不要了」），
也不能当「产品 bug」催修（产品根本没打算保留它），更不能塞进 `tests/integration-baseline.json`
当豁免（豁免只减不增，且豁免不产生决定）。

所以它们记在这里，**唯一目的是让「谁答、答哪句、什么时候答」可被追**。

### 登记五样（缺一不算登记）

1. **根因**：产品哪次改动导致的，能指到 issue / commit 就指
2. **归属**：O1–O7 角色（按路径边界划，不写人名）
3. **要谁拍板 + 具体要答的那一句话**
4. **复现命令**：一条能直接跑的命令
5. **复核期限**（`reviewAfter`）

### 两个前置，不然你会看到 SKIP(env) 而不是红

产物陈旧 / 没带测试接缝时，这些用例会 `SKIP(env)` —— **SKIP 不是红，也不是绿**，别拿它当证据。

```bash
TEST_AUTH_SEAM=1 node scripts/build.mjs --internal
TEST_AUTH_SEAM=1 NODE_ENV=production DIST_OUT=dist-standard npx rspack build -c rspack.config.ts
```

### 到期规则

`reviewAfter` 到期仍未答 → 该条**按红处理**并升级（在产品债清零前，L1 不能宣称全绿）；
不许把「没人答」写成「已确认可以忽略」。

---

## 1. 已裁决(2026-11-26)：6 条已落地

裁决口径：**红必须等于坏** / **守护意图不守护现状** / 红可归因 / 能自我证伪 / 最便宜的失败点 /
摩擦与风险成正比 / 豁免会过期。**不设数量目标** —— 这 6 条是「把断言挪回意图上」，不是「凑绿」。

原始红证据（裁决前）保留在每条的「改前红」里，**历史不删**。

### 1.1 `tests/integration/internal-build.test.mjs` — 重写（不退役）

- **根因**：#807 `421a7dfa`（模型来源单层手风琴）+ #800 `802ed299`（内置服务不渲染 Key 区）。
  改前断言的对象（「渠道」下拉 4 个选项、内置行的只读 Key 行 +「重新领取」按钮）已被产品有意删除。
- **改前红**：`设置页没有「渠道」下拉`、`ours 渠道 缺只读行或「重新领取」按钮（value=0, claim=0）`、
  `ours 渠道把内置值露在界面上了`，随后 `getByTestId('settings-row-general')` 30s 超时。
- **裁决**：**重写**。钉内置服务的**安全属性**，不钉界面形状：
  ① 界面不出现 Key 明文；② 内置行的地址 / 模型不可被本地编辑（且内置值不摊在界面上）；
  ③ 切到别的来源后，原内置 Key 不被带到本地存储。
  **不要**钉「有没有『重新领取』按钮」这种形状。
- **依据**：形状会改（按钮来又走），而「Key 明文外泄 / 地址被本地改掉 / 凭证被串走」是用户真的会被伤害的事；
  #596 的三类事故（旧 Key 残留、Key 被复制到别的客户端、Key 所属账号不明）都指向这三条。
- **改动摘要**：删掉渠道下拉 / 四选项 / 能力文案 / console-error 等形状断言；改为
  ① 扫可见文本 + DOM 文本 + `title`/`aria-label`/`placeholder` + 输入框值（持有原文的输入框必须是
  `type=password` 且不可见）；② 内置行展开区可编辑控件 = 0、不出现内置地址 / 模型，并断言真发出去的
  URL / model / 鉴权头仍是内置 spec 那一份；③ 切到第三方并填用户自己的 Key 后，共用槽位是用户那把、
  全量扫 localStorage 无内置 Key 原文、下发标记只留指纹 / 尾号。
- **落地后**：`PASS`（`node tests/run-layer.mjs integration --case tests/integration/internal-build.test.mjs`）。

### 1.2 `tests/integration/domain09-settings-reload.test.mjs` — 重写

- **根因**：同上（#807 / #800）。用例按 `getByRole('button', { name: '渠道', exact: true })` 进渠道页，
  改后那个触发器不存在。
- **改前红**：第一步「等渠道下拉出现」超时，后面「重载后凭证隔离」断言一条都没执行到。
- **裁决**：**重写**。意图是「重载后凭证不串」：重载前后**当前生效来源仍是同一行**、
  且别的行的凭证没有被合并 / 丢失。
- **依据**：`chat-demo:provider-kind` 与 `chat-demo:base-url:<kind>` / `chat-demo:model:<kind>` 是
  #339 的根因所在（读取侧串档）；重载是唯一能证明「界面真的消费了存下来的那份」的场景。
- **改动摘要**：`channel` / `switch-keep-key` 两个探针换成 `source`：读打勾的那一行
  （`settings-source-current` 所在行头）比对 seed 的 `provider-kind`；展开第三方 / 官方两行读草稿，
  断言第三方只读自己那一份（不出现另一槽位的地址 / 模型，也不出现老的共享 `chat-demo:model` 残留）、
  官方仍是「地址固定、只填 Key」；R12 追加「生效来源切到内置服务后第三方那一份仍在」。
- **落地后**：`PASS`（13 行；`--case tests/integration/domain09-settings-reload.test.mjs`）。

### 1.3 `tests/integration/domain03-settings-probe-model.test.mjs` — 重写（先查代码确认入口）

- **根因**：#807 `421a7dfa` —— 模型不再用「下拉 + 打开即探测」呈现，也不再有打开即拉列表的行为。
- **改前红**：`模型下拉没有渲染出接口返回的列表：[]`、`空地址没有提示必填`、`空列表没有给出提示`。
- **裁决**：**重写**。草稿形态下探测入口是「测试」按钮（`settings-source-draft-test`）。钉：
  空地址点测试 → 必填提示；有地址点测试 → **真的发出 `/models` 请求**且结果 / 错误被渲染出来。
  **不要**钉「模型下拉存在」。
- **依据**：入口是「用户怎么触发一次探测」这个契约本身；下拉是呈现方式。探测不发请求 = 假功能，
  探测结果不渲染 = 用户点了没反馈，两者才是坏。
- **改动摘要**：五档 —— 空地址（`settingsBaseUrlRequired`，0 次请求）、无 Key（`settingsTestApiKeyRequired`，
  0 次）、上游 200（断言请求 URL 以草稿地址开头 + 带鉴权头 + `settingsTestOk` 那一句）、
  上游 500（`settingsTestHttp`）、连不上（`settingsTestNetwork` 前半句）；期望句子全部从 `src/i18n/zh.ts`
  现取；并断言「展开 / 改草稿 / 探测都不改 `chat-demo:provider-kind`」。
- **落地后**：`PASS`（`--case tests/integration/domain03-settings-probe-model.test.mjs`）。

### 1.4 `tests/integration/domain02-reply-error-ui.test.mjs` — 按当前行为重写

- **根因**：`1e687929`（`feat(i18n): 错误提示改用产品定稿文案`，2026-11-24）把 `replyRateLimited` 换成定稿语气；
  同期 `src/services/api/errors.ts` 的 429 / 额度分类口径也改过。
- **改前红**：`F2-07 界面出现这一档文案 "请求过于频繁"`、`F2-07 文案告诉用户可以重试`、
  `F2-09 回答请求次数 = 1（实际 2）`、`F2-09 界面出现这一档文案 "怎么卡住了喵"`、`F2-09 失败收口后回到可发送态`。
- **裁决**：**按当前行为重写**。429 分类用**等值断言到 i18n key**（不是字面量句子），
  重试次数按实际（**2 次**，即总请求 1 + 2 = 3）；文案以 `zh.ts` 当前定稿为准：再改文案只改 i18n 一处。
- **依据**：字面量断言让「改文案」变成「改用例」，于是有人去改断言而不是改文案，最后用例在断言一句
  界面上已经不存在的话；钉 key 之后，真正会红的只剩「串档」与「这一档没了」。
- **改动摘要**：7 行全部从 `expectText`（字面量）换成 `expectKey`（`zh` 表 + `render()` 插值）；
  重试次数拆成 `retries`（实测：429 / 502 → 2，断流 / 空闲超时 → 1，终态 → 0）并写成
  「首发 1 + 自动重试 N」；「文案告诉用户可以重试」改成钉**出口**（`zh.regenerate` 按钮在不在，
  与 `errorNotice` 的 `regenerate` 列同义）；行 6 等待上限 90s → 150s（首发 + 一次重试各占一个 60s 空闲窗口）。
- **落地后**：`PASS`（7 行；`--case tests/integration/domain02-reply-error-ui.test.mjs`）。

### 1.5 `tests/integration/chat-newline-enter-610.test.mjs` — 只钉「编辑操作完整可见」

- **根因**：真实布局问题（不是口径过时）。原断言要求 390 宽下输入区在视口内居中（`|offset| ≤ 2`），
  实测 `{offset:267, visible:false}`。
- **裁决**：**只钉「编辑操作完整可见」**。去掉「390 宽输入区域居中」这条实现细节要求；
  保留「编辑时提交 / 取消按钮都可见可点」。
- **依据**：用户的要求是「编辑时能把这次修改发出去 / 取消掉」，不是「输入框居中」；居中是实现细节，
  钉住它等于把一次版式调整变成一次门禁事故。
- **改动摘要**：移动端分支删除 offset ≤ 2 的居中判据，改为测量 `取消` / `发送` 两个按钮：
  矩形整个在视口内（看得见）**且** `document.elementFromPoint(中心点)` 命中的是它自己（没被遮住）；
  红时把「谁盖住了它」写进失败信息，并把截图落到 `/tmp/issue610-edit-blocked-<label>.png`。
  桌面端「进入编辑态不移动阅读位置」保持不动。
- **落地后**：**FAIL —— 红等于坏，这是真缺陷，不是断言过时**：390 宽进编辑态后，右下角
  「回到底部」浮标（`aria-label="回到底部"`）压在「发送」按钮上，`elementFromPoint` 命中浮标，
  点下去不会提交。360 宽与 1280 桌面端正常。按裁决这条必须留着红，**不许**把「可点」删掉换绿；
  等产品侧让位（编辑态隐藏浮标 / 挪开）后再转绿。用例头部已写明这段「已知红」。

### 1.6 `tests/integration/imported-attachment-source-379.test.mjs` — 判据过严，放宽到「非资源类 console error」

- **根因**：判据 `console error = 0` 过严。用例把所有非本机请求 `route.abort()` 掉，浏览器于是打
  `Failed to load resource: net::ERR_FAILED` —— 外部资源噪声，与被测行为无关，单跑常绿、整层批次里红
  （于是被误记成 flaky）。
- **裁决**：**放宽到「非资源类 console error」**。保留「不许有脚本异常 / 未捕获错误」；
  `net::ERR_FAILED` 这类外部资源噪声不算失败，并**要求把「被忽略的噪声类型」打印出来**（不许静默吞）。
- **依据**：红必须等于坏 —— 外部资源噪声既不是被测行为坏了，也不是用例写错了；
  但「安静地忽略」会让下一次真的出现同类错误时无人看见，所以忽略必须留痕。
- **改动摘要**：`pageerror` 单独成 `scriptErrors`（必须为 0）；console error 按
  `Failed to load resource: net::ERR_*` 归类为噪声并聚合（类型 × 次数 + 样例）打印，
  其余任何一条 console error 照样红。
- **落地后**：`PASS`，且输出 `已忽略的噪声类型（外部资源，不判失败）：net::ERR_FAILED × 2（样例：…）`。

---

## 2. 待决策：1 条

### 2.1 `tests/integration/provider-channels.test.mjs`

> **这条是留给产品的那一个问题，2026-11-26 明确不动**：「渠道选择」还算不算契约。

- **根因**：#807 `421a7dfa` / #800 `802ed299`。用例用 `selectProviderKind(page, /我们的渠道|Our Channel/)`
  找「渠道」下拉，而该触发器已不存在。实测红：等待
  `[data-testid="settings-source-accordion"] button[aria-expanded]:has([data-testid="settings-source-current"])`
  超过 30s（`locator.innerText: Timeout 30000ms exceeded`），渠道路径整段没跑起来。
- **归属**：O1 前端渲染（断言对象是 `src/components/settings/**` 渲染出的行与触发器）。
- **要谁拍板**：产品口径决策人 —— **「渠道选择」这块还要不要被测？要的话它现在落在哪个 testid（设置 → 模型来源 → 内置服务的哪一行）？**
- **复现**：`node tests/run-layer.mjs integration --case tests/integration/provider-channels.test.mjs`
- **复核期限**：`reviewAfter = 2026-12-10`

---

## 3. 与豁免的关系（一句话，防止混用）

台账里的条目**不是** `tests/integration-baseline.json` 的 `known-red`：豁免是「这条我认了、暂时不修」，
台账是「这条该不该存在，还没人回答」。**唯一合法出口是有人答那句话，然后要么改用例、要么改产品、
要么开 `[bug]` 单并进基线**；出口不写在聊天里，写进对应 issue。
