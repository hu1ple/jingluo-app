#!/usr/bin/env node
/**
 * 文档引用门禁（GitHub issue #290）。
 *
 *   node scripts/check-doc-refs.mjs           # 或 pnpm check:doc-refs
 *   node scripts/check-doc-refs.mjs --json
 *   node scripts/check-doc-refs.mjs --audit-skipped   # 把「被跳过的引用」按原因分组摊开（#678）
 *   node scripts/check-doc-refs.mjs --selftest        # 自带负向对照（6 拍，临时仓库，不碰本仓）
 *
 * 回答一个问题：**文档里那些 `文件:行号`，还指得着吗？**
 *
 * 背景：#240 手修过一轮「docs 行号漂移」，因为没有门禁，又漂了一遍 —— 至少 33 处指到空行
 * 或孤立的 `}`，10 处指向仓库里根本不存在的文件（`tests/run-acceptance.mjs`、
 * `src/services/diagnostics/updateManifest.ts`）。靠手修治不了，只能让漂移变成红灯。
 *
 * ## 判定口径
 *
 * 一处引用 = 一个 token `路径[:起行[-止行]]`。
 *
 * 1 **带行号的引用**（`文件:行`）要过四关：
 *    - 文件要存在：有 `/` 的按仓库根相对路径解析；裸名先按**文档所在目录**解析，再按全仓
 *      basename 唯一匹配，同名多于一个就 FAIL（补成仓库相对路径）；
 *    - 起行要在文件行数内 —— 越界 = **漂移**（见下面分级）；
 *    - 起行不许是空行 —— 空行 = **漂移**（这正是本单的根因）；
 *    - 起行不许是孤立的 `}`、注释结束符、`);` 这类结构行 —— WARN。**止行不受这条约束**：
 *      区间本来就常常收在函数体最后一个 `}` 上，那不是漂移。
 *
 * ### 分级：什么拦、什么只提示（2026-11 起）
 *
 * 判据是**读者会付出多少**，不是实现成本：
 *
 * | 情形 | 档位 | 依据 |
 * | --- | --- | --- |
 * | 文件不存在 / 同名多份（**死引用**） | **红，永远拦** | 读者按它去找，找不到（或不知道该看哪份）＝这条结论等于没写。修法一分钟 |
 * | 行号漂到空行 / 越界（**漂移**），且没记账 | **红** | 新的漂移当场暴露 |
 * | 漂移，记了账且未到期 | 提示 | 文件还在、结论还有价值，只是定位失效，见 `scripts/audit-debt/check-doc-refs.json` |
 * | 漂移，记了账但已到期 | **红** | 豁免会过期 |
 *
 * 为什么漂移不判死红：它是「钉死行号」最典型的现场 —— main 上曾长期挂着 18 处空行 + 2 处越界，
 * 门禁常年红、真正的死引用反而被淹没，维护者于是学会「改文档凑数」而不是「修结论」。
 * 现在把 20 处收进账本（每笔带到期日），新漂的一律红、到期的一律红。
 * 2 **只给路径的引用**（`src/services/chat/store.ts`）：存在即合格，只检查「带 `/` 且首段
 *    是仓库根下真实目录」的那种；裸文件名（`releases.json`、`metrics.json` 这类远端清单 /
 *    采集产物）不判定 —— 它们不是仓库里的文件，硬判只会逼人写假路径。
 * 3 **省略前缀的引用**（`components/settings/Settings.module.css:804`、裸 `collector.ts:723`，
 *    即首段不是仓库根下的真实条目）：**#678 之前这一类根本进不了判定** —— 提取阶段
 *    `if (!existsSync(ROOT/segs[0])) continue` 一句话就把它丢了，不判存在性、不判行号。
 *    后果是 `docs/capabilities/css.md` §2 整张表（全是 `components/…` 写法）连「文件还在不在」
 *    都没人验过，行号漂到 `}` 上也永远绿（实测这类引用全仓 189 处，css.md 独占 13 处）。
 *    现在按三段解析：
 *      a. 相对**文档自己所在目录**（`docs/ui/x/README.md` 里的 `390/metrics.json`）；
 *      b. 全仓**路径后缀唯一匹配**（`components/a/b.css` → `src/components/a/b.css`）；
 *      c. 唯一匹配就按它判存在性与行号（行号错照样红）；**多匹配 / 零匹配 → WARN 点名**
 *         （绝不静默放过 —— 这正是本单要堵的那个洞）。
 *
 * ## 相对路径引用（`./x`、`../x`）解析成哪个文件（2026-11 定死，别再猜）
 *
 * 以前这一整类**不受管辖**：正则从 `b` / `s` 开始匹配，token 前面是 `/`，于是被
 * `not-standalone` 当成「URL / 绝对路径的一部分」丢掉。闸打开后第一件事就是把基准写死：
 *
 *   ① **文档所在目录**（markdown 链接的语义：`docs/x.md` 里 `../shared/y.mjs` 就是仓库根的 `shared/y.mjs`）；
 *   ② 解析不到再按**仓库根**（`./build-apk.sh` 这类「在仓库根执行」的写法）。
 *
 * 两段都在同一个文件 → 通过；落在**两个不同**文件 → WARN `relative-ambiguous`（补成仓库相对路径）；
 * 两段都不中 → FAIL `missing-file`（报文里把试过的两段基址逐条印出来）；
 * `../../x` 在 `docs/` 下**越出仓库根** → FAIL `relative-escape`（刻意不支持，所以**显式报错**，
 * 不许静默跳过 —— 静默跳过就是又开一个盲区）。
 * 实现：`resolveRelative()`；反例见 `--selftest` ⑧⑨。
 *
 * ## `.github/**` 的引用（2026-11 打开的盲区）
 *
 * 引用 token 以前不允许以 `.` 开头，而 `before === '.'` 又被一刀切成「名字的一部分」，
 * 于是 `.github/workflows/ci.yml:945` 这类引用**连存在性都不验**。实测后果：
 * `docs/ci-self-hosted-runner.md` 里 12 处 `ci.yml:行号` 锚点早就全错（指到空行 / 别的注释 /
 * 孤立 `#`），门禁一次都没报过。现在 `REF_RE` 允许前导点（`.github/…` 是一个完整路径），
 * `before === '.'` 只在这个点**确实在名字内部**时才算跳过（`dotInsideName()`）。
 * 反例见 `--selftest` ⑦（指对 → 绿，行号改错 → 红且点名）。
 *
 * ## 不按仓库路径判的一类：import 说明符
 *
 * 文档引用源码片段时会带出 `import … from './client.js'`。这个 `./client.js` 的解析基准是
 * **导入它的那个模块**，不是仓库根也不是文档目录 —— 拿仓库路径去判它，唯一的修法是删掉代码引文。
 * 所以紧跟 `from '…'` / `import('…')` 的引用**不判定**，但记入 `module-specifier` 账
 * （`--audit-skipped` 能数出来）。这是「不判定」而不是「没看见」。
 *
 * ## 跳过必须记账（#678）
 *
 * 「不判定」和「没看见」是两件事。所有被跳过的引用都按原因记账，`--audit-skipped` 打印
 * 分组计数与逐条清单：`not-standalone` / `module-specifier` / `artifact-hash` / `placeholder` /
 * `skip-dir` / `first-segment-not-root` / `other-ext` / `bare-artifact` / `ambiguous-bare`。
 * 加这个开关的理由和 #661 一样：门禁「看起来在守」，底下却有一整类引用从没被看过，
 * 而没人能从输出里看出来 —— 那就只能让它自己把账本摊开。
 * 顺带量了第二类：`REF_EXT` 白名单之外的扩展名（`--audit-skipped` 里的 `other-ext`）也按同样口径
 * 量了一遍；图片类归 `check:ui-shots`（#661）管，本门禁不重复判。
 *
 * ## 不算引用的东西
 *
 * - 绝对路径与 URL（`/data/user_de/...`、`//localhost/static/...`）；
 * - 通配 / 模板（`*.module.css`、`scripts/lib/*AssumptionAudit.mjs`、`xxxAssumptionAudit.mjs`）——
 *   它们是「命名约定」，不是「某个文件」；
 * - 依赖与产物目录（`node_modules/**` 等）；
 * - `fenced code block` 里的命令与输出；
 * - **import 说明符**（`from './client.js'`）：基准是「导入它的那个模块」，不是仓库路径（见上节）。
 * - **删除线里的路径**（`~~tests/golden/g07-xxx.test.mjs~~`）：这是「曾有、现已删除」的记录，
 *   迁移 / 删除清单必须写得清删了什么，硬判「文件不存在」会逼人把删除记录也删掉。
 *   这类引用**单独计数并打印**（`已删除（删除线…）N 处`），不是静默放行 ——
 *   此前它被「`~` 开头的路径是家目录」那条规则顺手丢掉，等于一个谁都能用、且谁也看不见的后门。
 *
 * ## 豁免
 *
 * 历史取证目录 `docs/repro/**`、`docs/redteam/**`、`docs/compat/compat-old/**` **只读不改**：
 * 里面的 `文件:行号` 记的是当次取证那一刻的仓库状态，事后「修」它等于篡改证据。
 * 这些引用只计数、不判定、不影响退出码。
 *
 * ## 账本：只许等于现状（账实不符 = 红）
 *
 * 「行号漂移」这一档走账本（每笔带到期日）。但账本**还能反过来骗人**：引用早就改对了、账没销，
 * 账面上就永远躺着一笔不存在的债 —— 人照着它以为这里还没修（白跑一趟），也会因此高估账本的
 * 可信度。所以口径是：**账面比实际多也判红**（与 `check-ui-shots` 统一），修法只有「把这条删掉」。
 * 死引用（文件不存在 / 相对路径越界）、到期、新增漂移、账实不符，四者都红。
 *
 * 退出码：0 合格（可能有「账期内的漂移」提示）/ 1 有死引用，或有未记账·已到期的漂移，
 * 或账实不符，或账本形状不合规 / 2 环境不具备（找不到 docs 目录）。
 *
 * 维护提示：这个门禁验的是「引用还指得着」，**不验**「文档描述的行为是否还对」。后者只能读代码
 * 复核；别把这里变绿当成文档正确。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadDebt, renderSelftest, settleDebt, todayStr } from './lib/auditDebt.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/**
 * 仓库根目录。`CHECK_DOC_REFS_ROOT` 只给 `--selftest` 用（它起一个临时仓库当输入），
 * 是测试注入口、不是运行开关：正常调用不设这个变量。
 */
export const ROOT = path.resolve(process.env.CHECK_DOC_REFS_ROOT ?? path.resolve(HERE, '..'))

/** 扫这些路径（目录递归 .md，文件按原样） */
export const SCAN_TARGETS = ['docs', 'CHANGELOG.md']

/** 历史取证归档：只读，不做判定 */
export const EXEMPT_PREFIXES = ['docs/repro/', 'docs/redteam/', 'docs/compat/compat-old/']

/**
 * 索引 / 解析时跳过的目录**名**（依赖、产物、缓存 —— 都不算「仓库里的文件」）
 *
 * `capacitor-cordova-android-plugins`（#563）：cap 的生成物，android/.gitignore 里明确忽略，
 * 干净 checkout 上没有。但只要本机按 docs/TESTING-POLICY.md 第 8/9.6 节跑过一次
 * `pnpm exec cap sync android`（gradle 配置校验的前置），它就会出现在盘上，于是
 * `docs/capabilities/behavior.md` 里那句裸文件名引用 `AndroidManifest.xml:19` 立刻变成
 * 「2 个同名文件，无法定位」的假红 —— 门禁自己制造的噪音，和 #461 是同一类病。
 */
const SKIP_DIR_NAMES = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.gradle',
  '.work-compat',
  'coverage',
  '__pycache__',
  'capacitor-cordova-android-plugins',
])

/**
 * 只是**名字撞上**产物目录的文档目录（假红修复；根因见 #461 的实测与 PR 说明）
 *
 * `docs/testing/coverage/` 存的是测试覆盖状态的**文档**，不是 jest / vitest 吐出来的
 * `coverage/` 产物。旧实现只看目录**名**就跳过，于是这批 md 连索引都进不去 —— 后果是
 * `docs/testing/report.md` / `docs/TESTING-POLICY.md` 里 15 处指向它们的引用全被判
 * 「文件不存在」，门禁自己制造了 15 条噪音红（#461 实测：main 上 23 FAIL，其中 15 条是这个）。
 *
 * 现在把两件事分开：
 *   - **索引**（别的文档引用它时能不能判定「文件存在」）：照常走进去 → 15 条噪音消失；
 *   - **扫正文**（校验这些 md 自己写的引用）：仍然不扫。实测把它们放进扫描范围会多出 28 条红
 *     —— 21 条 `missing-file`（指向 `update-matrix` / `release-gate-matrix` / `email-421-*` /
 *     `server-contract` / `release-mirror.mjs` 这些已改名或已删除的东西，另有 1 条是
 *     `android/…/MainActivity.java` 这种省略写法）+ 6 条 `out-of-range` + 1 条 `blank-line`。
 *     这些是**真的**文档腐烂，但那是另一件事 —— 混进这一单只会把「15 条噪音」换成「28 条真红」，
 *     谁也说不清哪条是哪个病。拆开做：先让门禁对它们的**引用方**不作假，再单开一单修它们自己的正文。
 */
const INDEX_ALWAYS_DIRS = new Set(['docs/testing/coverage'])

/**
 * 「前缀式」产物目录名（`dist-standard/`、`dist-baseline/`、`.gitignore` 里的 `dist-` + 通配 —— 第 6/49 行）。
 * 它们和 `dist/` 是一回事：本机构建产物，干净 checkout 上没有，不是仓库文件（#678 记账时归 skip-dir）。
 */
const ARTIFACT_DIR_PREFIX_RE = /^(?:dist|build|coverage)-/

/** 建索引时是否跳过该目录：名字是产物名、且不是上面那个「撞名文档目录」 */
const skipForIndex = (rel, name) => SKIP_DIR_NAMES.has(name) && !INDEX_ALWAYS_DIRS.has(rel)

/** 扫正文时是否跳过该目录：只看名字（撞名文档目录的正文这一单不扫，见 INDEX_ALWAYS_DIRS） */
const skipForScan = (_rel, name) => SKIP_DIR_NAMES.has(name)

/** 认作「文件引用」的扩展名（长的排前面，别让 `ts` 吃掉 `tsx`） */
const REF_EXT =
  'tsx|jsx|mts|cts|ts|mjs|cjs|json|js|css|scss|md|html|py|gradle|java|kt|yaml|yml|sh|txt|xml|toml|service|conf'

/**
 * 一处引用 = 一个 token `路径[:起行[-止行]]`。
 *
 * 开头的 `(?:\\.\\.?/)*` 与 `\\.?` 不是装饰，是 2026-11 这次「打开 `.github/**` 盲区」的核心：
 *   - `(?:\\.\\.?/)*` 吃掉 `./` `../` `../../` 前缀 → `./build-apk.sh`、`../shared/x.mjs`
 *     才是一个**完整的** token（以前正则从 `b` / `s` 开始匹配，token 前是 `/`，整条被
 *     `not-standalone` 当「URL / 绝对路径的一部分」丢掉：文档里所有相对写法都不受管辖）；
 *   - `\\.?` 允许**前导点**：`.github/workflows/ci.yml` 是一个文件路径，不是「某个更长名字的尾巴」。
 *     以前它以 `github/...` 入列、前面是 `.`，被 `before === '.'` 一刀切成「名字的一部分」→
 *     `.github/**` 整类引用**连存在性都不验**（实测：`docs/ci-self-hosted-runner.md` 里 12 处
 *     `ci.yml:行号` 锚点全错，门禁一次都没报过）。
 */
const REF_RE = new RegExp(
  `((?:\\.\\.?/)*\\.?[A-Za-z0-9_@][\\w.@/+-]*\\.(?:${REF_EXT}))(?::(\\d+)(?:[-–](\\d+))?)?(?![\\w.-])`,
  'g',
)

/** 构建产物的哈希文件名（`main.030dd2a6.js`）从来不是仓库路径 */
const ARTIFACT_RE = /(?:^|\/)[\w-]+\.[0-9a-f]{8}\.(?:js|css)$/

/** 模板占位符（`xxxAssumptionAudit.mjs`、`docs/capabilities/xxx.md`）不是具体文件 */
const PLACEHOLDER_RE = /(?:^|[/.])x{3,}|x{3,}[A-Za-z]/i

/** 起行指向「结构行」：孤立的闭括号 / 注释结束符 / 单行闭合 JSX 标签 */
const structuralLine = (text) => {
  const t = text.trim()
  if (!t) return false
  return (
    /^[}\])\];,]+;?$/.test(t) ||
    t === '})' ||
    t === '});' ||
    /^<\/?[A-Za-z][\w.:-]*>$/.test(t)
  )
}

const toPosix = (p) => p.split(path.sep).join('/')

/** 递归收集 .md */
const collectDocs = (dir, out) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (skipForScan(toPosix(path.relative(ROOT, full)), entry.name)) continue
      collectDocs(full, out)
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push(full)
    }
  }
  return out
}

/** 全仓索引：仓库相对路径集合 + basename → 路径列表 */
const buildIndex = () => {
  const paths = new Set()
  const byBasename = new Map()
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      const rel = toPosix(path.relative(ROOT, full))
      if (entry.isDirectory()) {
        if (skipForIndex(rel, entry.name)) continue
        paths.add(`${rel}/`)
        walk(full)
      } else if (entry.isFile()) {
        paths.add(rel)
        const list = byBasename.get(entry.name)
        if (list) list.push(rel)
        else byBasename.set(entry.name, [rel])
      }
    }
  }
  walk(ROOT)
  return { paths, byBasename }
}

const linesCache = new Map()
const linesOf = (rel) => {
  const cached = linesCache.get(rel)
  if (cached) return cached
  const lines = readFileSync(path.join(ROOT, rel), 'utf8').split(/\r?\n/)
  linesCache.set(rel, lines)
  return lines
}

const isExempt = (rel) => EXEMPT_PREFIXES.some((p) => rel.startsWith(p))

/**
 * 「省略前缀」类引用的解析：把引用当**路径后缀**在仓库里找（段边界对齐，`/` 前必须是分隔符）。
 * 返回匹配到的仓库相对路径列表（0 / 1 / n）。结果按查询缓存，`index.paths` 有上万条。
 */
const suffixCache = new Map()
const suffixHits = (index, file) => {
  const cached = suffixCache.get(file)
  if (cached) return cached
  const needle = `/${file}`
  const out = []
  for (const p of index.paths) {
    if (p.length > needle.length && p.endsWith(needle) && !p.endsWith('/')) out.push(p)
  }
  suffixCache.set(file, out)
  return out
}

/**
 * 判定一处引用：
 * { verdict: 'ok' | 'warn' | 'fail', kind, target?, message? }
 */
const judgeRef = (index, ref, docDir) => {
  const { file, start, end } = ref
  const hasLine = start !== null
  /** 是否靠「后缀唯一匹配」才定位到的目标（#678：这类引用以前根本不进判定） */
  let suffixResolved = false

  // 删除线里的引用：文档明说「这个对象已经删了」，不该再要求它指得着（但会计数打印）
  if (ref.deleted) return { verdict: 'ok', kind: 'deleted-marker' }

  // ---- 解析目标文件 ----
  let target = null
  if (/^\.\.?\//.test(file)) {
    // `./x`、`../x`：两段基址解析（文档所在目录 → 仓库根），规则见 resolveRelative
    const rel = resolveRelative(index, file, docDir)
    if (rel.verdict) return rel
    target = rel.target
  } else if (file.includes('/')) {
    if (index.paths.has(file)) target = file
    else if (index.paths.has(`${file}/`)) target = `${file}/`
    else if (!existsSync(path.join(ROOT, file.split('/')[0]))) {
      // #678：首段不是仓库根下的真实条目 —— 典型是省略了 `src/` 的写法
      // （`components/chatInput/ChatInput.module.tsx`、`components/markdown/markdown.css:67`）。
      // 以前这类引用在 extractRefs 里被 `continue` 静默丢掉：不判存在性、不判行号，
      // 于是 `docs/capabilities/css.md` 的整张 §2 表连「文件还在不在」都没人验过。
      // 现在按**路径后缀在仓库里找唯一匹配**：唯一 → 就按它判存在性与行号（该文件的
      // 行号错了照样红）；多匹配 / 零匹配 → WARN 点名（要人补全路径或改成函数名定位），
      // 绝不静默放行。
      // 先看「相对于引用它的那份文档」能不能解析（`docs/ui/xxx/README.md` 里的
      // `390/metrics.json` 就是这种写法：路径是相对文档自己的）。这一档比全仓后缀匹配更具体。
      const local = docDir === '.' ? file : `${docDir}/${file}`
      const hits = index.paths.has(local) ? [local] : suffixHits(index, file)
      if (hits.length === 1) {
        target = hits[0]
        suffixResolved = true
      } else {
        return {
          verdict: 'warn',
          kind: hits.length === 0 ? 'suffix-unmatched' : 'suffix-ambiguous',
          message:
            hits.length === 0
              ? `省略了前缀，且按「文档所在目录」「全仓后缀」都找不到：${file}` +
                '（缩写记法，或文件已删除/改名 —— 补全路径、改函数名定位，或用删除线标注「曾存在」）'
              : `省略了前缀，后缀匹配到 ${hits.length} 个文件，无法定位（补成仓库相对路径）：${hits
                  .slice(0, 3)
                  .join(' / ')}`,
        }
      }
    }
  } else {
    // 裸名：先看文档自己所在目录（`cdp.mjs` 这类和 README 放一起的采集脚本）
    const local = docDir === '.' ? file : `${docDir}/${file}`
    if (index.paths.has(local)) target = local
    else {
      const hits = index.byBasename.get(file) ?? []
      if (hits.length === 1) target = hits[0]
      else if (hits.length > 1) {
        // 只有「要拿它定位某一行」时，唯一性才是必须的
        if (hasLine) {
          return {
            verdict: 'fail',
            kind: 'ambiguous',
            message: `裸文件名在仓库里有 ${hits.length} 个同名文件，无法定位（补成仓库相对路径）：${hits
              .slice(0, 3)
              .join(' / ')}`,
          }
        }
        return { verdict: 'ok', kind: 'ambiguous-bare' }
      }
    }
  }

  if (target === null) {
    // 只给路径的裸名（`releases.json`、`metrics.json`）：不是仓库文件，不判定
    if (!hasLine && !file.includes('/')) return { verdict: 'ok', kind: 'bare-artifact' }
    return { verdict: 'fail', kind: 'missing-file', message: `文件不存在：${file}` }
  }
  if (target.endsWith('/'))
    return { verdict: 'ok', kind: 'dir', target, suffix: suffixResolved }
  if (!hasLine) return { verdict: 'ok', kind: 'path', target, suffix: suffixResolved }

  // ---- 行号 ----
  const lines = linesOf(target)
  const last = end === null ? start : Math.max(start, end)
  if (start < 1 || last > lines.length) {
    return {
      verdict: 'fail',
      kind: 'out-of-range',
      target,
      suffix: suffixResolved,
      message: `行号越界：${start}${end === null ? '' : `-${end}`} > 文件行数 ${lines.length}`,
    }
  }
  if ((lines[start - 1] ?? '').trim() === '') {
    return {
      verdict: 'fail',
      kind: 'blank-line',
      target,
      suffix: suffixResolved,
      message: `起行 ${start} 是空行（文件 ${lines.length} 行）`,
    }
  }
  if (end !== null && (lines[last - 1] ?? '').trim() === '') {
    return {
      verdict: 'warn',
      kind: 'blank-end',
      target,
      suffix: suffixResolved,
      message: `止行 ${last} 是空行，区间收在空行上没有意义`,
    }
  }
  if (structuralLine(lines[start - 1] ?? '')) {
    return {
      verdict: 'warn',
      kind: 'structural-line',
      target,
      suffix: suffixResolved,
      message: `起行 ${start} 是结构行（${JSON.stringify(
        (lines[start - 1] ?? '').trim(),
      )}），改用函数名/常量名定位更稳`,
    }
  }
  return { verdict: 'ok', kind: 'line', target, suffix: suffixResolved }
}

/**
 * 相对路径引用（`./build-apk.sh`、`../shared/build-types.mjs`、`./src/main.tsx`）解析成哪个文件？
 *
 * **定死这条规则的理由**：文档里两种写法都有，而且都对 ——
 *   - markdown 链接 `[..](../shared/build-types.mjs)` 的 `../` **只能**按文档所在目录解，
 *     改成仓库根相对会让 GitHub 上的链接点不开；
 *   - 命令与「在仓库根跑这个脚本」的口径（`./build-apk.sh release`）按文档目录解就必然落空。
 * 所以按**两段基址、顺序固定**解析，不让人猜：
 *   ① 文档所在目录（markdown 链接语义）；
 *   ② 仓库根（本门禁其余路径引用的基准）。
 * 两段都落在同一个文件 → 通过；落在**两个不同**文件 → WARN 点名（引用必须补成仓库相对路径）；
 * 两段都不中 → FAIL，并把**试过的两个基址**逐条印出来（读者/修的人不用再猜）。
 * `../../x` 在 `docs/` 下会**越出仓库根** —— 那是显式 FAIL（`relative-escape`），不是「不判定」：
 * 「刻意不支持」必须报错，静默跳过就是又开一个盲区。
 *
 * 返回 `{ target }` 或 `{ verdict, kind, message }`。
 */
const resolveRelative = (index, file, docDir) => {
  const tries = []
  const hits = []
  const bases = docDir === '.' ? [['.', '仓库根（文档就在根上）']] : [[docDir, `文档所在目录 ${docDir}`], ['.', '仓库根']]
  for (const [base, label] of bases) {
    const norm = path.posix.normalize(base === '.' ? file : `${base}/${file}`)
    if (norm === '..' || norm.startsWith('../')) {
      tries.push(`${label} → ${norm}（**越出仓库根**，这一档刻意不支持）`)
      continue
    }
    tries.push(`${label} → ${norm}`)
    if ((index.paths.has(norm) || index.paths.has(`${norm}/`)) && !hits.includes(norm)) hits.push(norm)
  }
  if (hits.length === 1) return { target: hits[0] }
  if (hits.length > 1) {
    return {
      verdict: 'warn',
      kind: 'relative-ambiguous',
      message:
        `相对路径在两段基址上都解析到了文件，无法定位（补成仓库相对路径）：${hits.join(' / ')}`,
    }
  }
  const escaped = tries.every((t) => t.includes('越出仓库根'))
  return {
    verdict: 'fail',
    kind: escaped ? 'relative-escape' : 'missing-file',
    message:
      (escaped
        ? '相对路径越出仓库根（`../` 写多了一层）：'
        : '文件不存在（相对路径两段基址都没命中）：') +
      `${file}；试过：${tries.join('；')}。` +
      '解析基准见脚本头「相对路径引用」一节（① 文档所在目录 → ② 仓库根）',
  }
}

/** 从 md 文本抽引用（fenced code block 里的命令/输出不算） */
/** `~~…~~` 删除线区间（`~~` 与 `**` 一样是「这里的东西已经不在了」的通用标记） */
const STRIKE_RE = /~~.+?~~/g

const strikeSpans = (line) => {
  const spans = []
  STRIKE_RE.lastIndex = 0
  let s
  while ((s = STRIKE_RE.exec(line)) !== null) spans.push([s.index, s.index + s[0].length])
  return spans
}

/**
 * 匹配点前面那个 `.` 是「名字内部的分隔」还是「token 的开头」？
 *
 * - `v1.2.3/x.ts`、`…/a.b/` 这类：点前面还是名字字符 → 是名字的一部分（跳过）；
 * - `.github/workflows/ci.yml`：点前面是空格 / 反引号 / 括号 / 行首 → 点就是路径的第一个字符，
 *   这**必须**判（本次要打开的正是这个盲区）；
 * - `./x`、`../x` 由 `REF_RE` 的前缀一起吃掉，不会走到这里。
 */
const dotInsideName = (line, index) => {
  if (index === 0 || line[index - 1] !== '.') return false
  return index >= 2 && /[\w.@+~*-]/.test(line[index - 2])
}

/**
 * 被跳过（不判定）的引用，按原因归档的名字 + 人话说明。
 *
 * 为什么要能把它们**数出来**（#678）：`check-doc-refs` 曾有整整一类引用被 `continue`
 * 静默丢掉 —— 判不了就直接不看，于是 `docs/capabilities/css.md` 里 `components/…:228`
 * 这种省略了 `src/` 前缀的写法全部不受门禁管辖，行号漂到别处也没人知道。
 * 这和 #661「`REF_EXT` 不含 png → 删掉被引用的截图零覆盖」是同一种病：
 * **门禁看起来在守，实际有一整类引用被静默跳过**。规矩改成：跳过可以，但必须**记账**，
 * 且 `--audit-skipped` 能把账本打出来。
 */
const SKIP_REASONS = {
  'not-standalone':
    '不是独立引用（前面紧贴 `/` `~` `*`，或点是名字内部的分隔：URL / 绝对路径 / 通配符 / 名字的一部分）' +
    '—— 注意 `.github/**`、`./x`、`../x` **不再**落进这一档（前导点与相对前缀已算 token 的一部分）',
  'module-specifier':
    '模块说明符（`from \'./x.js\'`）：解析基准是**导入它的那个模块**，不是仓库根也不是文档目录，' +
    '按仓库路径判只会逼人删掉代码引文 —— 不判定，但记账',
  'artifact-hash': '构建产物哈希名（`main.030dd2a6.js`），不是仓库路径',
  placeholder: '模板占位符（`xxx.md`）',
  'skip-dir': '依赖 / 产物目录（`node_modules/**` 等）',
  'first-segment-not-root':
    '首段不是仓库根下的真实条目（省略了 `src/` 之类的写法）—— #678 起这类**不再跳过**，' +
    '改由「文档所在目录 / 全仓后缀唯一匹配」判定；这里记的是「曾经整类被静默丢掉」的规模',
  'other-ext': `扩展名不在 REF_EXT 白名单（图片类由 check:ui-shots 管，不在此列）`,
  'bare-artifact': '裸文件名且无行号，仓库里找不到（远端清单 / 采集产物，不是仓库文件）',
  'ambiguous-bare': '裸文件名无行号，仓库里同名多个（不定位行号，只放行）',
}

const extractRefs = (text, skipped) => {
  const refs = []
  const lines = text.split(/\r?\n/)
  let inFence = false
  const skip = (reason, m, i, file, detail) => {
    if (skipped) skipped.push({ raw: m[0], file, line: i + 1, reason, detail })
  }
  lines.forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence
      return
    }
    if (inFence) return
    const strikes = strikeSpans(line)
    REF_RE.lastIndex = 0
    let m
    while ((m = REF_RE.exec(line)) !== null) {
      const file = m[1]
      const before = m.index === 0 ? '' : line[m.index - 1]
      /** 引用前面紧邻的 40 个字符（判 `from './x.js'` 这类模块说明符用） */
      const prefix = line.slice(Math.max(0, m.index - 40), m.index)
      // 删除线里的路径 = 「曾有、现已删除」的记录（迁移/删除清单要写清删了什么）。
      // 以前这类引用被下面 `before === '~'` 那条规则**静默丢掉**（一个看不见的后门：
      // 任何文档只要给死引用套一层 `~~` 就能过门禁，且没人知道发生过）。
      // 现在单独计数并打印 —— 放行是**显式**的，能数出来，也能被 review 看到。
      if (strikes.some(([start, end]) => m.index >= start && m.index + m[0].length <= end)) {
        refs.push({
          file,
          start: m[2] === undefined ? null : Number(m[2]),
          end: m[3] === undefined ? null : Number(m[3]),
          line: i + 1,
          raw: m[0],
          deleted: true,
        })
        continue
      }
      // 绝对路径 / URL / 通配 / 名字的一部分，都不是独立引用。
      // 前导点这一档从「before === '.' 一律跳过」收窄成「这个点确实在名字内部」：
      // `.github/…` 的点是 **token 开头**（前面是空格 / 反引号 / 括号），它是路径，必须判。
      if (before === '/' || before === '~' || before === '*' || dotInsideName(line, m.index)) {
        skip('not-standalone', m, i, file)
        continue
      }
      // 模块说明符（`import … from './client.js'`）：解析基准是「导入它的那个模块」，
      // 不是仓库根、也不是文档目录 —— 拿仓库路径去判它，唯一的修法是删掉代码引文。
      // 所以不判定，但记账（`--audit-skipped` 能数出来）。
      if (/(?:^|[^\w])(?:from|import)\s*\(?\s*['"]$/.test(prefix)) {
        skip('module-specifier', m, i, file)
        continue
      }
      if (ARTIFACT_RE.test(file)) {
        skip('artifact-hash', m, i, file)
        continue
      }
      if (PLACEHOLDER_RE.test(file)) {
        skip('placeholder', m, i, file)
        continue
      }
      const segs = file.split('/')
      if (segs.length > 1) {
        if (SKIP_DIR_NAMES.has(segs[0]) || ARTIFACT_DIR_PREFIX_RE.test(segs[0])) {
          skip('skip-dir', m, i, file)
          continue
        }
        // 首段必须是仓库根下真实存在的条目。#678 之前这里直接 `continue` —— 静默跳过，
        // 于是 `components/…`（省略 `src/`）整类引用不受管辖。现在交给 judgeRef 里的
        // 后缀唯一匹配去判；判不了的会报 WARN 点名，而不是无声放行。
        if (!existsSync(path.join(ROOT, segs[0]))) {
          skip('first-segment-not-root', m, i, file)
          // 仍然入列：judgeRef 会尝试后缀唯一匹配
        }
      }
      refs.push({
        file,
        start: m[2] === undefined ? null : Number(m[2]),
        end: m[3] === undefined ? null : Number(m[3]),
        line: i + 1,
        raw: m[0],
      })
    }
  })
  return refs
}

const REF_EXT_SET = new Set(REF_EXT.split('|'))

/** 图片类扩展名：由 `check:ui-shots`（#661）管，**不**在本门禁里重复判定（#678 不重叠要求） */
const SHOT_EXT_SET = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'])

/** 比 REF_RE 更宽：任何 `名字.扩展名` 的候选（用来量出「扩展名不在白名单」那一类） */
const ANY_EXT_RE = /([A-Za-z0-9_@][\w.@/+-]*\.[A-Za-z][A-Za-z0-9]{0,7})(?![ \w.-])/g

/**
 * 量「扩展名不在 REF_EXT 白名单」这一类引用（#678 第 ② 类）。
 *
 * REF_RE 根本不匹配它们，所以它们连 skip 记录都不会产生 —— 是比「首段不是仓库根」更彻底的
 * 隐身。这里用更宽的 `ANY_EXT_RE` 重扫一遍，只保留**真能落到仓库某个文件上**的候选
 * （有 `/` 的按仓库路径 / 后缀匹配，裸名按 basename 索引），这样统计的是「引用了一个真实文件、
 * 但门禁从没看过它」，而不是文档里随手写的 `1.4.0` / `e.g.` 之类噪音。
 *
 * 图片类（png/jpg/… ）由 check:ui-shots 管，单独标注、不计入「本门禁该管」的统计。
 */
const auditOtherExt = (text, index, docRel, out) => {
  const lines = text.split(/\r?\n/)
  let inFence = false
  lines.forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence
      return
    }
    if (inFence) return
    const strikes = strikeSpans(line)
    ANY_EXT_RE.lastIndex = 0
    let m
    while ((m = ANY_EXT_RE.exec(line)) !== null) {
      const file = m[1]
      const ext = (file.match(/\.([A-Za-z][A-Za-z0-9]{0,7})$/) ?? [, ''])[1].toLowerCase()
      if (REF_EXT_SET.has(ext)) continue // 白名单内：REF_RE 已管
      const before = m.index === 0 ? '' : line[m.index - 1]
      if (before === '/' || before === '~' || before === '*' || before === '.') continue
      if (strikes.some(([a, b]) => m.index >= a && m.index + m[0].length <= b)) continue
      if (PLACEHOLDER_RE.test(file)) continue
      const segs = file.split('/')
      let hits = []
      if (segs.length > 1) {
        if (SKIP_DIR_NAMES.has(segs[0])) continue
        if (index.paths.has(file)) hits = [file]
        else hits = suffixHits(index, file)
      } else {
        hits = index.byBasename.get(file) ?? []
      }
      if (hits.length === 0) continue // 落不到仓库文件上：不是「被跳过的仓库引用」
      out.push({
        doc: docRel,
        docLine: i + 1,
        raw: m[0],
        file,
        ext,
        shots: SHOT_EXT_SET.has(ext),
        hits,
      })
    }
  })
}

/**
 * 分级：什么拦、什么只提示。判据是**改错之后有多难挽回**，不是实现成本。
 *
 * - `missing-file` / `ambiguous` → **死引用**，永远拦：读者按它去找，找不到（或不知道该看哪一份），
 *   这条结论就等于没写。修法只有两种（改路径 / 删或划线），一分钟的事。
 * - `out-of-range` / `blank-line` → **行号漂移**，可按账期容忍：读者仍能找到这个文件，只是多翻两下。
 *   这一档是这一族「钉死行号 → 正确改动也红」的现场：main 上曾存在 18 处空行 + 2 处越界，
 *   长期把门禁挂在红上，真问题（死引用）反而被淹掉。现在改记账制：每笔带到期日，
 *   新的漂移立刻红，到期的也红。
 */
const DEAD_KINDS = new Set(['missing-file', 'ambiguous', 'relative-escape'])
const DRIFT_KINDS = new Set(['blank-line', 'out-of-range'])

/** 一句话事故：这条不修，读者会遇到什么 */
const ACCIDENT = {
  'missing-file': '读者按这条引用去翻文件，翻不到 —— 要么这条结论早就不存在（该删），要么路径写错了（该改）。两种情况都让人白跑一趟，而且他不会知道是哪一种。',
  ambiguous: '同名文件不止一个，读者不知道该看哪一份 —— 引用等于没写。',
  'blank-line': '引用指到空行：读者跳过去只看到空白，这条引用就失去了定位能力，只能整篇翻。',
  'out-of-range': '行号越界：文件比引用短，读者翻到底也找不到 —— 要么结论漂走了，要么文件被删改过。',
  'relative-escape':
    '相对路径越出仓库根（`../` 写多了一层）：这条引用指向仓库外面，读者按它永远找不到 —— 而且门禁要是把它当「不判定」，它就是又一个看不见的盲区。',
}

/** 一条能直接敲的修复入口（不是「请修正」这种空话） */
const fixOf = (item) => {
  const target = item.target ?? item.file ?? '<路径>'
  if (item.kind === 'missing-file')
    return `git log --diff-filter=D --oneline -- ${target}   # 看它何时被删；换路径或把引用改成 ~~${target}~~（删除线=曾存在）`
  if (item.kind === 'ambiguous')
    return `rg --files | grep -E '/${target.split('/').pop()}$'   # 看是哪几份同名，引用补成仓库相对路径`
  if (item.kind === 'relative-escape')
    return (
      '少写一层 ../：docs/x.md 里指仓库根下的文件用 ../<名字>，指同目录用 ./<名字>；' +
      '或者直接写仓库相对路径（不带 ./ ../ 前缀）'
    )
  if (item.kind === 'out-of-range')
    return `wc -l ${target}   # 把行号收进文件内，或改成「函数名/常量名」定位`
  return `grep -n "<你引用的那个符号>" ${target}   # 拿到真实行号改对；符号改名了就改引用`
}

/** 账目 id：`文档::引用原文`。**不含行号**（文档里的行号本身就是被引用的字符串，已经够了） */
const debtKeyOf = (item) => `${item.doc}::${item.raw}`

/**
 * `--selftest`：**故意做错必须被拦**。十一拍，全在一个临时仓库里跑（`CHECK_DOC_REFS_ROOT`），
 * 不碰真仓库的任何文件：
 *   ① 干净 → exit 0
 *   ② 写一个不存在的路径（死引用）→ **必 exit 1**，且印「事故 + 修法」
 *   ③ 行号落到空行（漂移、没记账）→ **必 exit 1**
 *   ④ 同一处漂移记进账（未到期）→ **必 exit 0**（容忍在账期内的漂移）
 *   ⑤ 同一本账改成已过期 → **必 exit 1**
 *   ⑥ 账本条目没有到期日 → **必 exit 1**（永久豁免不存在）
 *   ⑦ **`.github/…` 前导点必须被看见**：指对了 → exit 0；行号改错 → **必 exit 1 且点名**
 *      （这一拍是这次开闸的反例：`before === '.'` 一刀切时，⑦的两条都会 exit 0 —— 门禁看不见 `.github/**`）
 *   ⑧ **相对路径两段基址**：`./build-apk.sh`（仓库根解析）→ exit 0；`./gone.sh` → **必 exit 1**，
 *      且把「试过文档所在目录 / 仓库根」逐条印出来（不让人猜）
 *   ⑨ **越出仓库根必须显式报错**：`../../x.md` → **必 exit 1**（`relative-escape`），不许静默跳过
 *   ⑩ **模块说明符不按仓库路径判**：`import x from './ghost.js'` → exit 0（记账为 module-specifier）
 *   ⑪ **账实不符 = 红**：账上登记 1 处、实际 0 处 → **必 exit 1**
 */
const selftest = () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'check-doc-refs-selftest-'))
  const cases = []
  const gate = (root) => {
    const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
      encoding: 'utf8',
      env: { ...process.env, CHECK_DOC_REFS_ROOT: root },
    })
    return { status: result.status, out: `${result.stdout ?? ''}${result.stderr ?? ''}` }
  }
  try {
    mkdirSync(path.join(tmp, 'docs'), { recursive: true })
    mkdirSync(path.join(tmp, 'src'), { recursive: true })
    writeFileSync(path.join(tmp, 'src', 'thing.ts'), 'export const a = 1\n\nexport const b = 2\n', 'utf8')
    writeFileSync(path.join(tmp, 'docs', 'README.md'), '# 干净\n\n看 `src/thing.ts:1`。\n', 'utf8')
    const doc = path.join(tmp, 'docs', 'probe.md')

    cases.push({ name: '① 干净文档 → exit 0', ok: gate(tmp).status === 0 })

    writeFileSync(doc, '不存在的路径：`src/services/gone.ts:12`\n', 'utf8')
    const dead = gate(tmp)
    cases.push({
      name: '② 死引用 → exit 1',
      ok: dead.status === 1 && dead.out.includes('死引用'),
      detail: `exit ${dead.status}`,
    })
    cases.push({
      name: '② 报错自带「事故 + 修法」',
      ok: dead.out.includes('事故：') && dead.out.includes('修法：git log --diff-filter=D'),
    })

    writeFileSync(doc, '行号落在空行：`src/thing.ts:2`\n', 'utf8')
    const drift = gate(tmp)
    cases.push({
      name: '③ 行号漂到空行且没记账 → exit 1',
      ok: drift.status === 1 && drift.out.includes('起行 2 是空行'),
      detail: `exit ${drift.status}`,
    })

    const debtDir = path.join(tmp, 'scripts', 'audit-debt')
    mkdirSync(debtDir, { recursive: true })
    const ledger = path.join(debtDir, 'check-doc-refs.json')
    const key = 'docs/probe.md::src/thing.ts:2'
    const soon = todayStr(new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10))
    writeFileSync(
      ledger,
      JSON.stringify({ gate: 'check-doc-refs', entries: { [key]: { count: 1, why: 'selftest', issue: '#0', expires: soon } } }),
      'utf8',
    )
    const booked = gate(tmp)
    cases.push({ name: '④ 记账未到期 → exit 0', ok: booked.status === 0, detail: `exit ${booked.status}` })

    writeFileSync(
      ledger,
      JSON.stringify({
        gate: 'check-doc-refs',
        entries: { [key]: { count: 1, why: 'selftest', issue: '#0', expires: todayStr('2020-01-01') } },
      }),
      'utf8',
    )
    const expired = gate(tmp)
    cases.push({
      name: '⑤ 账到期 → exit 1 且报「已到期」',
      ok: expired.status === 1 && expired.out.includes('已到期'),
      detail: `exit ${expired.status}`,
    })

    writeFileSync(ledger, JSON.stringify({ gate: 'check-doc-refs', entries: { [key]: { why: '无期限' } } }), 'utf8')
    const shapeless = gate(tmp)
    cases.push({
      name: '⑥ 账本没有到期日 → exit 1',
      ok: shapeless.status === 1 && shapeless.out.includes('expires'),
      detail: `exit ${shapeless.status}`,
    })
    // ⑥ 收尾：账本现在是坏的，先清掉，后面几拍不该被它影响
    rmSync(ledger, { force: true })

    // ---------- ⑦ `.github/**` 前导点必须被看见（本次开闸的核心反例） ----------
    mkdirSync(path.join(tmp, '.github', 'workflows'), { recursive: true })
    writeFileSync(
      path.join(tmp, '.github', 'workflows', 'ci.yml'),
      '# ci\nrun: pnpm test\n# tail\n',
      'utf8',
    )
    writeFileSync(doc, '看 `.github/workflows/ci.yml:2`。\n', 'utf8')
    const dotOk = gate(tmp)
    cases.push({
      name: '⑦ `.github/workflows/ci.yml:2` 指对了 → exit 0（证明前导点不再是「名字的一部分」）',
      ok: dotOk.status === 0,
      detail: `exit ${dotOk.status}`,
    })
    writeFileSync(doc, '看 `.github/workflows/ci.yml:99`。\n', 'utf8')
    const dotBad = gate(tmp)
    cases.push({
      name: '⑦ `.github/…` 的行号改错 → 必 exit 1 且点名该文件',
      ok: dotBad.status === 1 && dotBad.out.includes('.github/workflows/ci.yml:99'),
      detail: `exit ${dotBad.status}`,
    })

    // ---------- ⑧ 相对路径：两段基址（文档所在目录 → 仓库根） ----------
    writeFileSync(path.join(tmp, 'build-apk.sh'), '#!/bin/sh\necho ok\n', 'utf8')
    writeFileSync(doc, '在仓库根跑 `./build-apk.sh`。\n', 'utf8')
    const relOk = gate(tmp)
    cases.push({
      name: '⑧ `./build-apk.sh`（仓库根那段基址解析到）→ exit 0',
      ok: relOk.status === 0,
      detail: `exit ${relOk.status}`,
    })
    writeFileSync(doc, '跑 `./gone.sh`。\n', 'utf8')
    const relBad = gate(tmp)
    cases.push({
      name: '⑧ `./gone.sh` 两段基址都不中 → exit 1 且印出试过的基址',
      ok: relBad.status === 1 && relBad.out.includes('试过：') && relBad.out.includes('仓库根'),
      detail: `exit ${relBad.status}`,
    })

    // ---------- ⑨ 越出仓库根：显式报错，不静默跳过 ----------
    writeFileSync(doc, '看 `../../outside.md:1`。\n', 'utf8')
    const escape = gate(tmp)
    cases.push({
      name: '⑨ `../../outside.md` 越出仓库根 → exit 1 且报 relative-escape',
      ok: escape.status === 1 && escape.out.includes('越出仓库根'),
      detail: `exit ${escape.status}`,
    })

    // ---------- ⑩ 模块说明符：不按仓库路径判（记账，不判红） ----------
    writeFileSync(doc, "例：`import x from './ghost.js'`\n", 'utf8')
    const specifier = gate(tmp)
    cases.push({
      name: "⑩ `import x from './ghost.js'`（模块说明符）→ exit 0，不判红",
      ok: specifier.status === 0,
      detail: `exit ${specifier.status}`,
    })

    // ---------- ⑪ 账实不符 = 红 ----------
    writeFileSync(doc, '看 `src/thing.ts:2`。\n', 'utf8')
    mkdirSync(debtDir, { recursive: true })
    writeFileSync(
      ledger,
      JSON.stringify({
        gate: 'check-doc-refs',
        entries: {
          // 这笔登记了，但现实里一处漂移都没有（行 2 是空行……不，2 行确实是空行 → 会真的红，
          // 所以这里用「文件里根本不存在的那条引用」来造「账多出实际」）
          'docs/probe.md::src/nothing.ts:3': { count: 2, why: 'selftest', issue: '#0', expires: soon },
        },
      }),
      'utf8',
    )
    const shrink = gate(tmp)
    cases.push({
      name: '⑪ 账面比实际多（登记 2 处、实际 0 处）→ exit 1 且报「账实不符」',
      ok: shrink.status === 1 && shrink.out.includes('账实不符'),
      detail: `exit ${shrink.status}`,
    })
  } catch (error) {
    cases.push({ name: 'selftest 自身抛错', ok: false, detail: error.message })
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
  return renderSelftest('check:doc-refs', cases)
}

const main = () => {
  if (process.argv.includes('--selftest')) process.exit(selftest() ? 0 : 1)
  const json = process.argv.includes('--json')
  const audit = process.argv.includes('--audit-skipped')
  const docsDir = path.join(ROOT, 'docs')
  if (!existsSync(docsDir)) {
    console.error(`找不到 docs 目录：${docsDir}`)
    process.exit(2)
  }

  const index = buildIndex()
  const files = []
  for (const target of SCAN_TARGETS) {
    const full = path.join(ROOT, target)
    if (!existsSync(full)) continue
    if (statSync(full).isDirectory()) collectDocs(full, files)
    else files.push(full)
  }

  const withLine = []
  const pathOnly = []
  const exempt = []
  const deleted = []
  const findings = []
  /** 被跳过的引用（只做记账，`--audit-skipped` 时打印；不影响退出码） */
  const skipped = []
  /** 扩展名不在白名单、但确实落到了仓库某个文件上的引用 */
  const otherExt = []
  /** 靠后缀唯一匹配才定位到的引用（#678 新纳入判定） */
  const suffixJudged = []

  for (const full of files) {
    const rel = toPosix(path.relative(ROOT, full))
    const docDir = toPosix(path.relative(ROOT, path.dirname(full))) || '.'
    const text = readFileSync(full, 'utf8')
    const localSkips = []
    for (const ref of extractRefs(text, localSkips)) {
      const result = judgeRef(index, ref, docDir)
      const record = { doc: rel, docLine: ref.line, raw: ref.raw, ...result }
      if (isExempt(rel)) {
        exempt.push(record)
        continue
      }
      if (result.suffix) suffixJudged.push(record)
      if (result.kind === 'deleted-marker') deleted.push(record)
      // judgeRef 层面的「不判定」也记账（裸名找不到 / 裸名多匹配且不定位行号）
      if (result.kind === 'bare-artifact' || result.kind === 'ambiguous-bare') {
        localSkips.push({ raw: ref.raw, file: ref.file, line: ref.line, reason: result.kind })
      }
      if (ref.start === null) pathOnly.push(record)
      else withLine.push(record)
      if (result.verdict !== 'ok') findings.push(record)
    }
    if (audit && !isExempt(rel)) {
      for (const sk of localSkips) skipped.push({ doc: rel, ...sk })
      auditOtherExt(text, index, rel, otherExt)
    }
  }

  const fails = findings.filter((f) => f.verdict === 'fail')
  const warns = findings.filter((f) => f.verdict === 'warn')

  // 分级：死引用永远拦；行号漂移走账本（有到期日）。
  // 兜底（fail-closed）：**没有归类的 fail 不许放行** —— 新增一种 kind 却忘了分类，
  // 结果就是「报了但不算红」，和静默跳过只差一个打印。
  for (const f of fails) {
    if (!DEAD_KINDS.has(f.kind) && !DRIFT_KINDS.has(f.kind))
      console.error(`内部错误：未分类的 fail kind=${f.kind}（${f.doc}:${f.docLine} ${f.raw}）→ 按死引用处理`)
  }
  const deadRefs = fails.filter((f) => DEAD_KINDS.has(f.kind) || (!DRIFT_KINDS.has(f.kind) && f.kind !== ''))
  const drift = fails.filter((f) => DRIFT_KINDS.has(f.kind))
  const actualDrift = new Map()
  for (const item of drift) {
    const key = debtKeyOf(item)
    const entry = actualDrift.get(key) ?? { count: 0, sample: `${item.doc}:${item.docLine}  ${item.raw}` }
    entry.count += 1
    actualDrift.set(key, entry)
  }
  const debt = loadDebt({ root: ROOT, gate: 'check-doc-refs' })
  const settled = settleDebt({ actual: actualDrift, debt })
  const driftByKey = new Map()
  for (const item of drift) {
    if (!driftByKey.has(debtKeyOf(item))) driftByKey.set(debtKeyOf(item), item)
  }
  // 逐条展开（同一处引用可能在文档里出现多次），别在显示层去重 —— 去重会让条数比实际少
  const redReason = new Map()
  for (const item of settled.unregistered) redReason.set(item.key, item.why)
  for (const item of settled.expired) redReason.set(item.key, `已到期 ${item.entry.expires}（逾期 ${item.overdueDays} 天）`)
  const redDrift = drift
    .filter((item) => redReason.has(debtKeyOf(item)))
    .map((item) => ({ ...item, why: redReason.get(debtKeyOf(item)) }))
  // **账实不符 = 红**（本次裁决，与 `check-ui-shots` 统一口径）：账面登记 N 处、实际一处都没有，
  // 说明这笔豁免早就不对应任何真实缺陷 —— 留着它就是一张「看起来还欠着一笔」的假账。
  // 账本的作用是「让该红的红、该忍的忍」，一旦它可以比现实多，它就同时骗了两个方向：
  // 人会照着它以为某处还没修（白干一趟），也会因此相信「账本可信」（下次真有人拿它当依据）。
  // 修法只有一条：把这条从账本里删掉（或把 count 改成实际的数）。
  const shrinkRed = settled.shrink
  const hardRed = deadRefs.length + redDrift.length + shrinkRed.length

  if (json) {
    console.log(
      JSON.stringify(
        {
          docsScanned: files.length,
          withLine: withLine.length,
          pathOnly: pathOnly.length,
          exempt: exempt.length,
          deletedMarkers: deleted.length,
          fails,
          warns,
          debt: {
            file: debt.shown,
            entries: debt.entries.size,
            settled: settled.settled.length,
            redDrift: redDrift.map(({ key, why }) => ({ key, why })),
            shrinkRed: shrinkRed.length,
            shrink: shrinkRed.map(({ key, registered, found }) => ({ key, registered, actual: found?.count ?? 0 })),
            problems: debt.problems,
          },
        },
        null,
        2,
      ),
    )
    process.exit(hardRed > 0 || debt.problems.length > 0 ? 1 : 0)
  }

  console.log('文档引用门禁（GitHub issue #290）')
  console.log(
    `  扫描 ${files.length} 个文档：带行号引用 ${withLine.length} 处 / 纯路径引用 ${pathOnly.length} 处`,
  )
  console.log(`  豁免（历史取证只读）${exempt.length} 处，不判定、不影响退出码`)
  console.log(
    `  已删除（删除线 ~~…~~ 标记，视为「曾存在、现已删除」）${deleted.length} 处，不判定；改引用为真活路径时请去掉删除线`,
  )
  console.log('')

  if (audit) {
    console.log('—— 跳过 / 曾被跳过的引用（--audit-skipped，仅盘点，不影响退出码）——')
    const byReason = new Map()
    for (const sk of skipped) {
      if (!byReason.has(sk.reason)) byReason.set(sk.reason, [])
      byReason.get(sk.reason).push(sk)
    }
    const reasonRows = [...byReason.entries()].sort((a, b) => b[1].length - a[1].length)
    console.log(`  REF_EXT 白名单内的引用里被跳过 ${skipped.length} 处：`)
    for (const [reason, list] of reasonRows) {
      console.log(`    ${reason}  ${list.length} 处 — ${SKIP_REASONS[reason] ?? ''}`)
    }
    const shots = otherExt.filter((o) => o.shots)
    const nonShots = otherExt.filter((o) => !o.shots)
    console.log(
      `  REF_EXT 白名单**外**、但确实落到仓库文件上的引用 ${otherExt.length} 处` +
        `（其中图片类 ${shots.length} 处由 check:ui-shots 管，本门禁该管 ${nonShots.length} 处）：`,
    )
    const byExt = new Map()
    for (const o of nonShots) {
      const key = `${o.shots ? 'img:' : ''}${o.ext}`
      if (!byExt.has(key)) byExt.set(key, [])
      byExt.get(key).push(o)
    }
    for (const [ext, list] of [...byExt.entries()].sort((a, b) => b[1].length - a[1].length)) {
      console.log(`    .${ext}  ${list.length} 处`)
    }
    console.log('')
    for (const [reason, list] of reasonRows) {
      console.log(`  [${reason}] ${list.length} 处`)
      for (const sk of list) {
        console.log(`    ${sk.doc}:${sk.line}  ${sk.raw}${sk.detail ? `  (${sk.detail})` : ''}`)
      }
      console.log('')
    }
    console.log('  非图片扩展（本门禁该管，但从未判定过）：')
    for (const [ext, list] of [...byExt.entries()].sort((a, b) => b[1].length - a[1].length)) {
      console.log(`    [.${ext}] ${list.length} 处`)
      for (const o of list) {
        console.log(`      ${o.doc}:${o.docLine}  ${o.raw}  → ${o.hits.slice(0, 2).join(' / ')}`)
      }
    }
    console.log('')
    // suffix 唯一匹配到底救回来多少条 —— 这是 #678 选 A 不选 B 的依据
    console.log(
      `  首段不是仓库根的引用中，按后缀唯一匹配认定成功 ${suffixJudged.length} 处（以前 0 处受判定）；` +
        `后缀多匹配/零匹配 → WARN ${warns.filter((w) => w.kind.startsWith('suffix-')).length} 处`,
    )
    console.log('')
  }

  /**
   * `full`：只有「要有人动手」的两档（死引用 / 未记账·到期的漂移）才逐条印「事故 + 修法」；
   * 已经是提示档的（WARN、账期内）只印两行 —— 否则真正要修的那几条会被自己的噪音埋掉。
   */
  const printGroup = (title, list, { full = false } = {}) => {
    if (list.length === 0) return
    console.log(`${title} ${list.length}`)
    for (const f of list) {
      console.log(`  ${f.doc}:${f.docLine}  ${f.raw}`)
      console.log(`      ${f.message}`)
      if (!full) continue
      if (ACCIDENT[f.kind]) console.log(`      事故：${ACCIDENT[f.kind]}`)
      console.log(`      修法：${fixOf(f)}`)
      const entry = debt.entries.get(debtKeyOf(f))
      if (entry) console.log(`      账上：${entry.issue} 到期 ${entry.expires}（剩 ${entry.left} 天）—— ${entry.why}`)
    }
    console.log('')
  }

  printGroup('❌ 死引用（指向的文件不存在 / 同名多份，永远拦）', deadRefs, { full: true })
  printGroup('❌ 行号漂移 · 未记账 / 已到期（新漂的一律红；到期即红）', redDrift, { full: true })
  printGroup(
    '⚠ 行号漂移 · 已记账在账期内（不拦，但每跑一次都会提醒）',
    drift.filter((item) => settled.settled.some((entry) => entry.key === debtKeyOf(item))),
  )
  printGroup('WARN', warns)

  if (shrinkRed.length) {
    console.log(`❌ 账实不符 ${shrinkRed.length} 笔（引用早就改对了，账没销 —— 账本在骗人，判红）：`)
    for (const item of shrinkRed) {
      const actual = item.found?.count ?? item.count ?? 0
      console.log(`  ${item.key}  登记 ${item.registered} 处，实际 ${actual} 处`)
      console.log(
        '      事故：这笔豁免已经不对应任何真实缺陷。账留着它，人就会照着它以为这里还没修（白跑一趟），' +
          '下一次也没人敢信这本账。',
      )
      console.log(
        '      修法：从 scripts/audit-debt/check-doc-refs.json 删掉这一条（登记数大于实际但都不是 0 时：把 count 改成实际的数）',
      )
    }
    console.log('')
  }

  if (debt.problems.length) {
    console.log('❌ 账本形状不合规（形状不合规的账本就是白名单）：')
    for (const problem of debt.problems) console.log(`  ${problem}`)
    console.log('')
  }

  if (debt.exists && debt.entries.size) {
    const nearest = [...debt.entries.entries()]
      .filter(([key]) => actualDrift.has(key))
      .sort((a, b) => a[1].left - b[1].left)[0]
    console.log(
      `账本 ${debt.shown}：${debt.entries.size} 笔 / 共 ${[...debt.entries.values()].reduce((sum, e) => sum + e.count, 0)} 处` +
        (nearest ? `；最近到期 ${nearest[0]} → ${nearest[1].expires}（剩 ${nearest[1].left} 天，到期即红）` : ''),
    )
  }

  if (hardRed === 0 && debt.problems.length === 0) {
    console.log(
      warns.length === 0
        ? '合格：所有引用都指得着（文件存在、行号在文件内、不落在空行）。'
        : '合格（有 WARN）：没有硬错误；WARN 项建议改用函数名/常量名定位。',
    )
    process.exit(0)
  }
  console.log('不合格：先修 ❌ 项。别用「换成章节标题」绕过 —— 那样可核对性就没了。')
  process.exit(1)
}

main()
