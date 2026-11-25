# 产品债台账：L1 仍红里「等一句话」的那些

> **这不是「已知红的豁免表」，是未完成决定的清单。** 每条都必须有人答一句话才能继续；
> 到期未答 → 该用例按红处理，不许静默挂着。

## 0. 这份台账管什么

L1（`tests/run-layer.mjs integration`）现在有一批红，它们的共同点是**红得没有争议，但「该断言什么」没有结论**：
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

## 1. 待产品拍板：断言对象已被有意删除（4 条）

根因同一族：**#807**（`421a7dfa` 模型来源单层手风琴 + 行内领取/确认使用/打勾）与
**#800**（`802ed299` 内置服务不渲染 Key 区）。改版后来源页 `hideProviderKind`，
全仓已不存在「渠道」下拉这个触发器；「我们的渠道」的只读 Key 行 + 「重新领取」也搬进了
「模型来源 → 内置服务」的行内形态。用例仍在按改版前的形状找元素。

### 1.1 `tests/integration/provider-channels.test.mjs`

- **根因**：#807 `421a7dfa` / #800 `802ed299`。用例用 `selectProviderKind(page, /我们的渠道|Our Channel/)`
  找「渠道」下拉，而该触发器已不存在。实测红：等待
  `[data-testid="settings-source-accordion"] button[aria-expanded]:has([data-testid="settings-source-current"])`
  超过 30s（`locator.innerText: Timeout 30000ms exceeded`），渠道路径整段没跑起来。
- **归属**：O1 前端渲染（断言对象是 `src/components/settings/**` 渲染出的行与触发器）。
- **要谁拍板**：产品口径决策人 —— **「渠道选择」这块还要不要被测？要的话它现在落在哪个 testid（设置 → 模型来源 → 内置服务的哪一行）？**
- **复现**：`node tests/run-layer.mjs integration --case tests/integration/provider-channels.test.mjs`
- **复核期限**：`2026-12-10`

### 1.2 `tests/integration/internal-build.test.mjs`

- **根因**：同上（#807 / #800）。实测红三条：`设置页没有「渠道」下拉`、
  `ours 渠道 缺只读行或「重新领取」按钮（value=0, claim=0）`、连带 `ours 渠道把内置值露在界面上`。
- **归属**：O1 前端渲染。
- **要谁拍板**：产品口径决策人 —— **内置服务「只读 Key 行 + 重新领取」这条路径还要不要作为契约被测？**
- **复现**：`node tests/run-layer.mjs integration --case tests/integration/internal-build.test.mjs`
- **复核期限**：`2026-12-10`

### 1.3 `tests/integration/domain09-settings-reload.test.mjs`

- **根因**：同上（#807 / #800）。用例按 `getByRole('button', { name: '渠道', exact: true })` 进渠道页，
  实测红即停在这一步（等待超时），后面「重载后凭证隔离」的断言一条都没执行到。
- **归属**：O1 前端渲染。
- **要谁拍板**：产品口径决策人 —— **「设置重载后渠道凭证隔离」这条守护，改成按新 IA（模型来源 → 内置服务）重写，还是这条用例退役？**
- **复现**：`node tests/run-layer.mjs integration --case tests/integration/domain09-settings-reload.test.mjs`
- **复核期限**：`2026-12-10`

### 1.4 `tests/integration/domain03-settings-probe-model.test.mjs`

- **根因**：#807 `421a7dfa`（模型不再用「下拉 + 打开即探测」呈现，也不再有打开即拉列表的行为）。
  实测红：`模型下拉没有渲染出接口返回的列表：[]`、`空地址没有提示必填`、`空列表没有给出提示` ——
  断言的对象（模型下拉）整个不存在了。
- **归属**：O2 业务与数据（模型列表 / 探测契约在 `src/services/api/**`），实现侧联同 O1。
- **要谁拍板**：产品口径决策人 —— **模型列表现在还由谁触发探测（是「连通性测试」吗）？确认后按新入口重写哪几条断言？**
- **复现**：`node tests/run-layer.mjs integration --case tests/integration/domain03-settings-probe-model.test.mjs`
- **复核期限**：`2026-12-10`

---

## 2. 待产品拍板：错误文案定稿后口径变了（1 条）

### 2.1 `tests/integration/domain02-reply-error-ui.test.mjs`

- **根因**：`1e687929`（`feat(i18n): 错误提示改用产品定稿文案`，2026-11-24）把
  `replyRateLimited` 从「请求过于频繁」换成定稿语气（`src/i18n/zh.ts` 现值为「你发得太快啦…」）；
  同期 `src/services/api/errors.ts` 的 429 / 额度分类口径也改过（该文件注释明确写着
  「改前 429 会落到『请求过于频繁』」）。实测红：`F2-07 界面出现这一档文案 "请求过于频繁"`、
  `F2-07 文案告诉用户可以重试`、`F2-09 回答请求次数 = 1（实际 2）`、`F2-09 界面出现这一档文案 "怎么卡住了喵"`、
  `F2-09 失败收口后回到可发送态`。
- **归属**：O2 业务与数据（文案在 `src/i18n/**`，429 分类在 `src/services/api/errors.ts`）。
- **要谁拍板**：产品口径决策人（O2 执行）—— **429 这一档的定稿文案与「允许重试几次」以哪版为准：按新文案 + 实际次数改用例，还是这套旧口径要保留？**
- **复现**：`node tests/run-layer.mjs integration --case tests/integration/domain02-reply-error-ui.test.mjs`
- **复核期限**：`2026-12-10`

---

## 3. 已定性的真红：不是断言过时（1 条）

### 3.1 `tests/integration/chat-newline-enter-610.test.mjs`

- **根因**：真实布局问题，**不是**口径过时。断言要求输入区在视口内居中（`|offset| ≤ 2`）且完整可见，
  实测 390 宽 `{offset:267, visible:false}`（既没居中、也不完整可见），360 宽 `{offset:65, visible:true}`
  （可见但偏了 65px）。与 #610 走的是同一条窄屏输入区路径（同族改动可参考 `65b4e3ca`，
  但定位到具体 commit 需要前端认领后确认）。
- **归属**：O1 前端渲染（`src/components/**` 输入区布局 / 滚动钳位）。
- **要谁拍板**：产品口径决策人 + O1 —— **390 宽下「输入区域居中」是产品要求吗？不是就只钉「编辑操作完整可见」；是就按缺陷修。**
- **复现**：`node tests/run-layer.mjs integration --case tests/integration/chat-newline-enter-610.test.mjs`
- **复核期限**：`2026-12-10`

---

## 4. 偶发（flaky）：按 flaky 流程处置，**不许**直接登记豁免（1 条）

### 4.1 `tests/integration/imported-attachment-source-379.test.mjs`

- **根因**：不稳定，不是口径问题。实测：首跑红在 `console error = 0` ——
  两条 `Failed to load resource: net::ERR_FAILED`；按 flaky 判据重跑即绿，记为 `PASS(flaky)`。
  整层批次里红、单跑绿，是同一形状。
- **归属**：O6 测试基建（用例自身的控制台错误口径 / 桩的完整性）。
- **要谁拍板**：O6 —— **这条按 flaky 登记（`tests/flaky-registry.json`，写清谁在什么时候修），还是承认「console error = 0」这条断言过严、要放宽到「非资源类错误」？**
- **复现**：`node tests/run-layer.mjs integration --case tests/integration/imported-attachment-source-379.test.mjs`
  （单跑常绿；要观察到抖，跑整层或多次单跑）
- **复核期限**：`2026-12-10`

---

## 5. 与豁免的关系（一句话，防止混用）

台账里的条目**不是** `tests/integration-baseline.json` 的 `known-red`：豁免是「这条我认了、暂时不修」，
台账是「这条该不该存在，还没人回答」。**唯一合法出口是有人答那句话，然后要么改用例、要么改产品、
要么开 `[bug]` 单并进基线**；出口不写在聊天里，写进对应 issue。
