# 豁免登记契约（exemption contract）

> 一句话：**豁免不是「先这样」的收据，是一张有期限的欠条。** 它必须写清「为什么、凭据、谁承接、最晚哪天复审」，
> 并且条件一旦不成立就**自己红** —— 而不是靠人记得回来删。

门禁：`pnpm run check:exemptions`（`scripts/check-test-exemptions.mjs`）
判据实现：`scripts/lib/exemption-policy.mjs`（纯函数）｜ 钉住它的用例：`tests/unit/exemption-policy.test.mjs`

---

## 1. 为什么要专门一道门禁

本仓有六份「允许它先这样」的表，纪律早就写在各自的注释里，但**没有一处被机器强制**：

| 文件 | 之前的「不腐烂」靠什么 | 实际漏在哪 |
| --- | --- | --- |
| `tests/integration-baseline.json` | `run-layer --baseline` 把「基线记着红、这次跑绿」报成 `FIXED?` | `reason` 可以空；`followUp` 无人核对；**没有到期日**；环境问题能被写成 known-red |
| `tests/flaky-registry.json` | 跑绿自动解除隔离 + 每 7 天打印一次提醒 + 连续 3 次进隔离 | 隔离**没有期限**（提醒只是打印）；`reason` 是自动生成的原始堆栈；文件删了条目还在 |
| `tests/adversarial/baseline.json` | `known-defect` 变绿报 REGRESSION | `--record` 会把 known-defect 直接改回 green（**跑一遍就销账**）；没有承接单/到期日 |
| `tests/test-duplication-baseline.json` | 组不再重复 → stale 提示（`--strict` 红） | `issue` 可选、**没有到期日** |
| `tests/test-duplication-whitelist.json` | `reason` 必须写（<4 字报错） | `issue` 不强制、**没有到期日**、条目不再命中时无人管 |
| `tests/fast-subset.json` | 排除名单失效时打印一句「请删掉」 | **不阻塞**；没有到期日；没人重测 |

六套缺口 = 六种「反正没人查」。这份契约把它们收到一处：**加第七张表只需在 `KIND_SPECS` 里登记一格**，
就自动获得同一套判据 —— 而不是再写一遍「注释纪律」。

`tests/integration-shard-weights.json` 是第七份会被误认为是豁免的表，但它**不是**：没登记的文件按默认估重，
照样会被分进某个分片，没有任何红被放行、没有用例被跳过。所以它对「到期日」免疫，只做登记完整性检查。
**机制不该无差别套在不是豁免的东西上** —— 给分片权重加到期日只是纯摩擦。

---

## 2. 四条判据

| 判据 | 状态码 | 判的是什么 |
| --- | --- | --- |
| ① 元数据不全 | `missing-reason` / `placeholder-reason` / `missing-evidence` / `uncited-evidence` / `missing-followup` / `invalid-followup` / `missing-added-at` / `missing-review-after` / `invalid-review-after` / `window-too-long` | 缺字段，或写了「待补 / TODO / xxx」这种占位句。**缺一项就不合法，输出点名哪一项** |
| ② 过期 | `expired` | `今天 > reviewAfter`。到期当天仍有效（`reviewAfter` 是「最晚复审到哪一天」）。`reviewAfter` 远超该类最长窗口也算非法 |
| ③ 已经不成立 | `fixed-exemption` / `dead-entry` / `followup-closed` / `stale-observation` | 跑绿了 / 对象文件没了 / 承接单已关闭 / 声称还红但很久没人实跑 |
| ④ 拿环境问题顶包 | `env-as-exemption` | 缺产物 / 端口被占 / 机器慢 / 网络抖动 —— 这是「没测」，不是「已知红」 |

第 ④ 条以前只写在 `tests/integration-baseline.json` 的 note 里（「禁止把环境问题塞进 known-red」），
现在成了检查：命中的是**关键词**，而「这不是环境问题（同一步在标准产物下稳定复现）」这种带反驳词的归因不算命中
（否则真红的归因会被误杀）。

### 各类登记的字段要求

| 类别（`KIND_SPECS`） | 文件 | 必需字段 | 最长复核窗口 | 它怎么「自己烂掉」 |
| --- | --- | --- | --- | --- |
| `integration-known-red` | `tests/integration-baseline.json` | reason、evidence（带日期/提交号/工单号）、followUp、addedAt、reviewAfter、lastRedAt | 120 天 | 跑绿（`--baseline` 报 `FIXED?`，或条目记着 `lastObserved: "pass"`）；`lastRedAt` 超 60 天没人实跑 |
| `flaky-quarantine` | `tests/flaky-registry.json` | reason、followUp、quarantinedAt（=addedAt）、reviewAfter | 45 天 | `lastGreen` 晚于 `quarantinedAt`（机制会自动解除隔离，条目应删） |
| `flaky-infra-signature` | `tests/flaky-registry.json` | followUp（`issue`）、addedAt（`firstSeen`）、reviewAfter | 365 天 | 签名不再出现 → 删条目（**不算豁免**：命中只重跑一次，不放行任何文件） |
| `adversarial-known-defect` | `tests/adversarial/baseline.json` | reason、evidence、followUp、addedAt、reviewAfter | 180 天 | 变绿（runner 报 REGRESSION）或 `lastObserved: "pass"` |
| `duplication-baseline` | `tests/test-duplication-baseline.json` | reason、followUp、addedAt、reviewAfter | 365 天 | 那组已经不重复（`check-test-duplication` 报 stale） |
| `duplication-whitelist` | `tests/test-duplication-whitelist.json` | reason、followUp、addedAt、reviewAfter | 365 天 | 它放行的组/主题/标题不再命中 |
| `fast-subset-exclude` | `tests/fast-subset.json` | reason（`why`）、addedAt、reviewAfter | 400 天 | 文件不存在；或重测后已经不慢 |
| `shard-weight` | `tests/integration-shard-weights.json` | —（**不是豁免**） | — | 文件不存在 / `ms` 不是正数 |

两个字段的语义**故意不同**，别混：

- `followUp` = **承接单**：谁负责把这条豁免消掉。**必须未关闭** —— 关了就说明这件事该结案。
- `issue` = **出处 / 批次**：这条豁免是哪批工作留下的（`#408`、`#611`）。**可以是已关闭的批次单**。

> 2026-11-25 第一次跑这道门禁就抓到了 3 条：两处逐字重复与一条 runner 崩溃签名**都还在生效**，
> 但它们引用的承接单（`#408` / `#611`）在批次结案时被关掉了 —— 从那一刻起这三条豁免就没有承接人了，
> 而此前没有任何检查能发现。处置见 `#892`（抽掉 / 换承接人），处置完把 `followUp` 改指过去的单。

---

## 3. 「只增不减」：让它显形，**不设上限**

每次跑都会和 `tests/exemption-ledger.json` 的上一份快照比：

```
趋势（对比 2026-11-20 的快照）：豁免总数 22 → 26（+4）
  integration-known-red        0 →   4（+4）
      + 新增：zz-fake-already-green.test.mjs
      ...
  新增条目已经点名在上面 —— 加一条豁免是一次**决定**，不是一次编辑。
```

- **不设条数上限**：上限会逼人删掉真豁免来保绿，那就从「豁免会腐烂」退化成「红不等于坏」，比没有上限更糟。
- 快照靠 `--record` 追加（只追加、保留最近 60 份），review 时照着「新增」名单问一句「为什么它可以不修」。
- 趋势只统计**真的放行了某件事**的条目（红 / 跳过 / 少跑）；`shard-weight`、`infra-signature` 这类不进豁免总数。

---

## 4. 怎么办（三种角色）

**想加一条豁免**（谁都可能是那个人）：

1. 问自己「能不能现在修」—— 能就别加（基线的规矩是只减不增）；
2. 加条目时把 `reason`（为什么现在不修）、`evidence`（凭据：日期/提交号/工单号）、`followUp`（承接单）、
   `addedAt`、`reviewAfter` 一次写齐；`reviewAfter` 选**你能承诺复审的最近一个日期**，不是能写的最远日期；
3. 跑 `pnpm run check:exemptions`，绿了再提交。红的话输出会点名缺哪一项。

**到期了 / 被门禁点名**（复审）：三选一 —— 修掉它并删条目；换一个未关闭的承接单并写明复审结论后重设日期
（**续期是复审，不是免检**：只改日期不写结论，等于把豁免往后挪）；或者删掉用例（功能已下线时）。

**跑绿了**（两个方向都会喊）：`run-layer --baseline` 报 `FIXED?`；对抗基线报 `REGRESSION`；
`flaky` 登记簿自动解除隔离；`check:exemptions` 报 `fixed-exemption`。**跑绿 ⇒ 删条目**，不允许「留着当纪念」。

---

## 5. 这道门禁没做什么（别当成已验）

- **不重跑测试**。它只判「登记本身是否自洽、是否过期、是否指向已关闭的单」，跑绿仍然是各层 runner 的判据。
  `lastRedAt` 只是把「多久没人实跑过」变成一个能判的数字，不替代实测。
- **抓不到工单状态时不判红，但也不静默**：打印「未核实 N 条」；`--strict`（CI 用它）下改判**环境失败 exit 2**
  —— 分开「条目有问题」和「这道判据今天没在工作」，才分得清该改条目还是该修 CI 的 `GH_TOKEN`。
- **不改任何 runner 的行为**：`tests/run-layer.mjs` 的判红口径、`scripts/check-test-duplication.mjs` 的审计逻辑、
  `tests/integration-baseline.json` 的逐条登记内容都不由本门禁决定。它只**追加**一层「豁免会不会腐烂」的判据。
  runner 侧要配合的三件事写在 §6。
- `tests/adversarial/run-adversarial.mjs` 已改成：`--record` 只写观测（`lastObserved`），
  要删豁免必须显式 `--accept-fixed` 并打印删掉了哪些字段。

## 6. 需要 runner 侧配合的点（跨 lane）

| 谁 | 要做什么 | 为什么 |
| --- | --- | --- |
| `tests/run-layer.mjs`（`--baseline`） | 每轮把「这条 known-red 这次仍然是红」写回基线条目（`lastRedAt`），跑绿时除了 `FIXED?` 也写 `lastObserved: "pass"` | 本门禁判 `stale-observation` 靠 `lastRedAt`；不写就永远是过期红（宁可红也不要「猜」） |
| `tests/run-layer.mjs`（flaky 落盘） | 已在本单修好（改的是机制模块 `scripts/flaky-registry.mjs`，没动 runner）：`normalizeRegistry()` 透传 `followUp` / `reviewAfter`，顶层 `contracts` 也保留 | 实测代价：只保留 `note` 时，跑**一轮** `run-layer` 就把整块 `contracts` 与 `followUp` 洗掉了 —— 到期日与「必须带到期日」这句话一起消失，比没有到期日更坏 |
| `scripts/check-test-duplication.mjs` | 白名单/基线条目读取时同步校验 `followUp` / `reviewAfter`（或直接 `import` 本模块的 `validateEntry`） | 否则这两份文件的到期日只有本门禁在看，脚本自己的 `--update-baseline` 仍能生成缺字段的条目 |
| `scripts/test-fast.mjs` | 排除条目过期/文件不存在改成**提示 + 非 0**（现在是「过期条目不阻塞」） | 「不阻塞」等于承认它可以一直烂下去 |
| `.github/workflows/ci.yml` | 已接：`pnpm run check:exemptions` + `--selftest` 负向对照 | 脚本存在 ≠ 规则生效 |
