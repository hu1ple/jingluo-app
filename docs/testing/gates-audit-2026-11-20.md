# 门禁体检：28 道 `scripts/check-*.mjs` 的三态（2026-11-20，#487）

> 结论先写：**跑不起来的门禁比判红的门禁危险得多** —— 判红至少有人会去看，跑不起来的那道，
> 在 CI 里表现为「一条红」，但在人的印象里表现为「这道门禁一直都在」，实际上它什么都没查。
> 本次体检的起因是一份报告说 `check:dup-impl` 在 main 上崩溃（`MODULE_NOT_FOUND`），
> 实测那是**命令里的文件名写错**（见 §2）；真正的失效项是另外三个（见 §3）。

## 1. 方法与复现

三态定义（本文件全篇只用这三个词）：

| 状态 | 判据 | 含义 |
| --- | --- | --- |
| **OK** | `exit 0` | 门禁跑起来了，且当前仓库判定通过 |
| **FAIL** | `exit 1` | 门禁跑起来了，判定**红**（真缺陷，或设计上就该红的阶段） |
| **BROKEN** | `exit 2` / 抛异常 / `MODULE_NOT_FOUND` | 门禁**没跑起来**：用法错、环境缺、入口不存在 —— 这一格等于零覆盖 |

复现命令（与 CI 同环境：Node 24 / LANG=zh_CN）：

```
export PATH="/opt/node24/bin:$PATH" LANG=zh_CN.UTF-8
for f in scripts/check-*.mjs; do printf "%-42s " "$f"; timeout 120 node "$f" >/dev/null 2>&1 && echo OK || echo "FAIL/BROKEN($?)"; done
```

## 2. `check:dup-impl` 的「崩溃」根因：文件名，不是脚本

报告里的命令是 ~~`node scripts/check-dup-impl.mjs`~~，而仓库里**从来没有过**这个文件：

```
$ git log --all --oneline -- scripts/check-dup-impl.mjs
（空）
$ node scripts/check-dup-impl.mjs
Error: Cannot find module '/…/scripts/check-dup-impl.mjs'   code: 'MODULE_NOT_FOUND', requireStack: []
```

`package.json` 的别名指向的是另一个名字，CI 走的也是别名，所以流水线上这道门禁**一直是好的**：

```
"check:dup-impl": "node scripts/check-duplicate-impl.mjs"
$ pnpm run check:dup-impl
扫描 scripts / tests 下 424 个 .mjs/.js/.cjs 文件，字节重复 0 组（白名单放行 0 组）
OK：没有字节完全相同的两份实现        # exit 0
```

即：这是**一份「命令抄错了」的报告**，不是门禁坏了。但它暴露了两个真问题，本次都修了：

1. **没有任何东西会检查「别名 → 文件」还指得着**。谁把 `check:dup-impl` 写成
   ~~`scripts/check-dup-impl.mjs`~~（少 `duplicate`），CI 那一步就是 `MODULE_NOT_FOUND`，
   而 review 只会看到「门禁脚本还在仓库里」。 → `tests/unit/domain10-gate-wiring.test.mjs` 新增 W4。
2. **门禁口径与它的名字不符**：它叫「重复实现」，却只扫 `scripts/` 与 `tests/`。
   **复制一个 `src/` 文件改个名，全仓没有任何门禁会红** —— 而 #289 的原始事故正是「原样复制」。
   → 扫描范围扩到 `src/`（同时扩 `.ts` / `.tsx`）。

### 2.1 负向对照（证明它真会咬）

| 场景 | 期望 | 实测 |
| --- | --- | --- |
| 干净仓库 | exit 0 | ✅ exit 0 |
| 复制 `scripts/lib/endpoints.mjs` → `endpoints-copy-nc.mjs` | exit 1 | ✅ exit 1（打印 sha256 + 两个文件名） |
| 复制 ~~`src/services/invite/api.ts`~~（#590 已随旧设备码体系删除，本行是当日实验记录） → `api-copy-nc.ts` | exit 1 | ✅ exit 1（扩范围前是 **exit 0** —— 这就是漏洞） |
| 删掉副本 | exit 0 | ✅ exit 0 |

## 3. 真正的失效项（本次修掉 / 记录）

### 3.1 `check:doc-refs` 在 main 上已经红了，而且它把后面 20 步全吞掉了

main 最新的 push run（`44700028925`）实测：

```
✔ 仓库卫生（check:hygiene）   ✔ 重复实现（check:dup-impl）
✔ 测试布局（check:test-layout） ✔ 测试重复检测（check:test-duplication）
✖ 文档引用门禁（check:doc-refs）
- 负向对照 / Type check / Lint / Unit tests / Build / bundle-target / legacy / matrix /
  ip / manifest / dl-release / i18n / endpoints / capabilities / log-coverage / redact …
  → 全部 skipped（20 步）
```

根因是**两个 PR 的交叉**，不是谁写坏了脚本：

- #491 新增 `docs/testing/rebuild-plan.md`，里面有一张「删除清单」，逐条写着**要删的测试文件路径**；
  合并那一刻这些文件还在，所以它的 CI 绿。
- #492 真把那些测试删了，但它的 PR CI 跑在 #491 合并**之前**的树上（08:01 vs 08:06），
  于是「文档引用一个刚被删掉的文件」这件事没有在任何一次 CI 里被同时看到。
- 两个 PR 先后落 main，`check:doc-refs` 立刻红了 —— 而它排在紧前面，后面 20 步一个都没跑。

修法（`scripts/check-doc-refs.mjs` + `docs/testing/rebuild-plan.md`）：给门禁加一条**显式的
「已删除」标记** —— 文档里写成 `~~路径~~`（删除线）即表示「曾有、现已删除」，门禁计数但不判红：

```
  已删除（删除线 ~~…~~ 标记，视为「曾存在、现已删除」）8 处，不判定；改引用为真活路径时请去掉删除线
  合格（有 WARN）：没有硬错误
```

为什么不是「把清单里的路径删掉」：删除清单的价值就在于**写清删了什么**（`docs/testing/rebuild-plan.md`
是 #487 阶段③重建回归基准的输入，删了清单，重建时没人知道哪些已经不存在）。

顺带修掉的一个**隐形后门**：删除线里的路径此前被「`~` 开头的路径是家目录」那条规则**静默丢掉**，
也就是说任何文档只要给死引用套一层 `~~` 就能过门禁，而且没人知道发生过（`docs/capabilities/api.md`
的 V1 行早就在用这个写法，只是没人察觉）。现在这类引用**单独计数并打印**，放行是可见的。

### 3.2 13 道门禁没接线，其中 10 道连交代都没有

`scripts/check-*.mjs` 共 **28** 道，`ci.yml` / `release.yml` 实际跑到 **15** 道。剩下 13 道里，
`tests/unit/domain10-gate-wiring.test.mjs` 原来只登记了 3 道（`check:identity` / `check:apk` / `check:guard`），
另外 10 道**完全没人提**（`check:limits` / `check:icon` / `check:gap` / `check:focus` / `check:gutter` /
`check:container` / `check:compat-baseline` / `check:hardcoded-ports` / `check:keystore` / `check:refactor-direction`）。
这正是 #362 说的病：**脚本能判红 ≠ 有人在跑**。本次把这张账**补全并写清理由**（W4 + `KNOWN_UNWIRED`），
并把「纯文本、<1.1s、当前全绿」的那批的接线 diff 放在 PR 正文里（按约束不改 `ci.yml`）。

### 3.3 `check:keystore` 从未在任何流水线上跑过

它裸跑必然 `exit 2`（缺本机 `android/keystore/keystore.properties`，该文件不入库），
`ci.yml` / `release.yml` 都没有它的步骤 —— 也就是说「签名凭据形状」这道门禁**只存在于文档里**。
本次只登记（不接 CI：CI 无密钥，硬接就是恒红），接法建议写进 PR 正文。

## 4. 三态总表 —— **已下线，别在这里维护**

这份 28 行表在写下它的第二天就开始烂，所以它被删掉了，只留结论（这次删表本身是证据，不是偷懒）：

- 写下时 `scripts/check-*.mjs` **28 道**，现在 **40 道**（`ls scripts/check-*.mjs | wc -l`）——
  表里没有的 12 道是后来加的。
- 表里 §3.3 那条「`check:keystore` 从未在任何流水线上跑过」，**#697 起已接线**（ci.yml 跑 `--config-only`
  降级档，真签名比对在发布机）；§5 的旧条目因此也不再成立。
- 三态里真正值钱的是 **BROKEN 这一类**（判据：「门禁跑不起来」= 零覆盖，比判红更危险）。它现在不再靠
  人肉体检：`exit 2` 是仓里所有门禁脚本的公用约定（见 `scripts/check-bundle-target.mjs`、
  `scripts/check-bundle-syntax.mjs`），而「接了线就必须被跑」由
  `tests/unit/domain10-gate-wiring.test.mjs` 的 `REQUIRED_CI_GATES` 断言。

门禁现在只有两份活的口径，都尽量交给机器：**理由 / 归属 / 准入 / 豁免纪律** →
[`docs/testing/gates-ledger.md`](gates-ledger.md)；**有没有负向对照、接没接线** →
`docs/TESTING-POLICY.md` §9.4 与 `tests/unit/domain10-gate-wiring.test.mjs`（`REQUIRED_CI_GATES` / `KNOWN_UNWIRED`）。
本文件只保留一篇**带日期的体检记录**价值：方法（§1）、那个被误诊成「崩溃」的用例（§2）、
以及三处真实失效的根因（§3）。

## 5. 已知仍未覆盖的（写下来，别当成已验）

（2026-11-25 复看：下面第 1 条已关闭，第 2 条重写；留原文痕迹是为了记住「快照会烂」这件事。）

1. ~~`check:keystore` 没有任何自动入口~~ —— **#697 起已接线**：ci.yml 跑 `--config-only` 降级档
   （校验配置形状与来源一致性），真签名比对在发布机的全量档。
2. **未接线门禁**：`check:*` 别名里有 11 道登记在 `tests/unit/domain10-gate-wiring.test.mjs` 的
   `KNOWN_UNWIRED`（逐条带理由，且该用例会断言它们**确实没被接进 ci.yml**）；另有 3 道
   **既不接线、也不在那张登记表里**，它们现在只靠这段文字记账：
   `check:capabilities-docs`（替代判据 `tests/unit/capabilities-docs-sync.test.mjs`）、
   `check:public-artifact-redaction`（发布前手动，见 `docs/RELEASE-CHECKLIST.md`）、
   `check:retention`（需分发机，见 `docs/RELEASE-MANUAL.md`）。这三条正是
   [`docs/testing/gates-ledger.md`](gates-ledger.md) §3.2 第 4 条要治的形状。
3. 本次体检只验「脚本能不能跑、判得对不对」，**不验**每道门禁的判据是否还覆盖真实风险 —— 那是各门禁自己的 issue。
