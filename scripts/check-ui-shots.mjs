#!/usr/bin/env node
/**
 * 截图引用门禁（GitHub issue #661）。
 *
 *   node scripts/check-ui-shots.mjs            # 或 pnpm check:ui-shots
 *   node scripts/check-ui-shots.mjs --json     # 机器可读
 *   node scripts/check-ui-shots.mjs --list     # 逐条打印孤儿/悬空引用
 *   node scripts/check-ui-shots.mjs --selftest # 自带负向对照（8 拍，临时 git 仓库，不碰本仓）
 *
 * 回答两个问题：
 *   ① **孤儿**：`docs/ui/**` 下的每张截图，还有没有任何文档 / 测试 / 脚本指向它？
 *   ② **悬空**：文档里写的那些截图路径，文件还在不在？
 *
 * ## 为什么需要它（#661 实测）
 *
 * `docs/ui` 曾经是「整目录不动」的取证区，于是只进不出：553 张截图里 **155 张（18.2 MB /
 * 17.4 MiB）** 在仓库任何 tracked 文本里都查不到一处引用 —— 既不是关单证据，也不在任何
 * 子目录 README 的结论表里。它们不是磁盘问题，是**搜索噪音**：`git grep zip|import|toast`
 * 会被这些图的路径刷屏，而谁的结论都不依赖它们。
 *
 * 已有的两道门禁都看不见这件事：
 *   - `check:doc-refs` 只认代码类扩展名（`REF_EXT` 里没有 png/jpg），图片引用它根本不扫；
 *   - `check:hygiene` 管的是「本机绝对路径」与「大文本文件」。
 * 所以误删一张**被引用**的截图，CI 会全绿（PR 里留了这条负向对照的实测）。
 *
 * ## 判定口径
 *
 * 「被引用」= 命中下列任一条（都要求**落到具体文件**，不是按 basename 一刀切 ——
 * `docs/ui` 下有 21 个重复 basename，光按名字判会把「有人引用了 360 那张」算成「390 那张也有人要」）：
 *
 *   L0 字面名：任何 tracked 文本文件里出现该文件名（= issue #661 正文给的两条判据：
 *      `grep -rl "<文件名>" docs/ tests/ scripts/ *.md` 与 `git grep -l "<文件名>"`）
 *   A  显式路径：token 按「文档所在目录相对」/「仓库根相对」解析后等于该图片路径（含 `..`）
 *   B  glob：`360/*.png` 这类以图片扩展名收尾的通配（`docs/ui/**` 这种整目录通配**不**算，
 *      它只是「这个目录存在」的说法，不能证明某张图有人要）
 *   C  brace：`quota-{390,360}.png` 展开后匹配
 *   D  祖先裸名：文档位于图片的祖先目录、token 是裸文件名，且该 basename 的同名图**全部**在该
 *      文档子树内（`docs/ui/auth-pages/README.md` 的 `login.png` 就属于这种：360/ 与 390/ 各一张）
 *   E  续写简写：`-s1-hold-long-360dp.png` —— 接在同文件里上一条已解析路径的目录后，按后缀匹配
 *   F  目录级：`.md` 把 `docs/ui/<子目录>/` 当一个整体引用（含裸相对目录名如 `screens/`、
 *      省略号形态 `360/…`）→ 该目录下全部图片连带算引用
 *   H  stem 前缀：`metrics.json` 的 key 形如 `390/01-失败-有缓存兜底`（不带扩展名、不带视口后缀）
 *      → 该目录下以此开头的图片算引用。删掉图就删掉了这条量数的出处
 *
 * 「悬空」= 文档里的引用解析到的 `docs/ui/**` 图片不存在（父目录还在 → 不是历史记录，是死链）。
 * 代码块（```）与删除线（`~~…~~`）里的路径不算：前者是命令示例，后者是「曾有、现已删除」的记录。
 *
 * ## 豁免
 *
 * `EXEMPT` 逐条给理由，只有 2 条（#213 的那两张）。**不要**加「目录里有 README 就整目录放行」
 * 那种通用规则 —— 那样等于把这份名单变成后门。
 *
 * ## 分级（2026-11 起）：账期内的历史孤儿 vs 新孤儿
 *
 * 判据：**这张图以后还会不会被人需要**。新孤儿（没登记的）＝**红**，因为它是这一轮采集忘了
 * 写进结论表的图，越晚发现越难找回上下文；历史孤儿（账本里的）＝**提示**，它们要按 #661 的流程
 * 「先归档到仓库外再 git rm」，不是这道门禁该替人拍的事。每笔债都有到期日，到期即红。
 *
 * 这条改动之前，main 上常年挂着 160 张孤儿 + 8 条（假）悬空，门禁永远红 —— 真问题进不来。
 * 那 8 条悬空还是门禁自己造的假红：`830-01-flash-frame-390.png` / `-360.png` 是**续写简写**，
 * 图全都在，却被判成「同目录裸名不存在」。两个病一起治：假红修掉，真孤儿进账（带到期日）。
 *
 * 退出码：0 合格（可能有「账期内的历史孤儿」提示）/ 1 有新孤儿、悬空引用，或账本形状不合规 /
 * 2 环境不具备（不是 git 仓库）。
 */
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadDebt, renderSelftest, settleDebt, todayStr } from './lib/auditDebt.mjs'

/**
 * 仓库根。`CHECK_UI_SHOTS_ROOT` 只给 `--selftest` 用（它在一个临时 git 仓库上跑），
 * 是测试注入口、不是运行开关：正常调用不设这个变量。
 */
const ROOT = path.resolve(process.env.CHECK_UI_SHOTS_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'))
let ARGS = new Set(process.argv.slice(2))
const JSON_OUT = ARGS.has('--json')
const LIST = ARGS.has('--list')

/**
 * 账本（`scripts/audit-debt/check-ui-shots.json`）：只登记**历史孤儿**，每笔带到期日。
 *
 * 为什么不是直接 `git rm` 那 160 张：它们是 #661 那一轮之前的取证产物，删不删要问归档口径
 * （#661 的流程是「先归档到仓库外再 git rm」），不是这道门禁该替人决定的事。门禁的职责是
 * **让新增的孤儿当场红、让历史孤儿不再把真问题淹掉**，并且给这笔账一个到期日 —— 否则
 * 「160 张孤儿常年红」就等于把这道门禁关掉。
 */
const DEBT_GATE = 'check-ui-shots'

if (ARGS.has('--selftest')) process.exit(selftest() ? 0 : 1)

/** 图片扩展名（`docs/ui` 目前只有 png，留全是为了别人挪进来时不会漏判） */
const IMG_RE = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i

/** 逐条豁免（带理由；只有这里能「留一张没人引用的图」） */
const EXEMPT = new Map([
  [
    'docs/ui/213-has-fallback/360/markdown-before-list.png',
    '#213：该目录只有这一张 360 + 一张 390 图，README 正文（「看什么」表 + 期望 margin）逐条描述的就是它们，' +
      '只是没写文件名；删了 README 就指向不存在的证据',
  ],
  ['docs/ui/213-has-fallback/390/markdown-before-list.png', '同上（390 档）'],
])

const git = (args) => execFileSync('git', args, { cwd: ROOT, maxBuffer: 1 << 28 }).toString()

let tracked
try {
  tracked = git(['ls-files', '-z']).split('\0').filter(Boolean)
} catch {
  console.error('check:ui-shots —— 这不是一个 git 仓库（退出码 2）')
  process.exit(2)
}

const norm = (p) => path.posix.normalize(p).replace(/^\.\//, '').replace(/(.)\/+$/, '$1')
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** glob → 正则（`*` 只跨一层目录；先按 `*` 切段再逐段转义，避免 `\*` 被二次转义） */
const globToRe = (g) => new RegExp('^' + g.split('*').map(esc).join('[^/]*') + '$')

/** 去掉 token 前面粘着的 markdown 标记；但**不**吞掉 glob 的 `*` */
const stripLead = (t) => t.replace(/^[#[_[\]()`"']+/, '')

/** 本脚本自己不算「引用出处」：`EXEMPT` 里那两条豁免理由中写着文件名，不能因此把图算成被引用 */
const SELF = 'scripts/check-ui-shots.mjs'

/**
 * 同样不算出处的还有**账本自己**（`scripts/audit-debt/check-ui-shots.json`）——
 * 它逐条写着那 160 张历史孤儿的文件名，要是被当成「引用」，账本就会把自己登记成出处，
 * 于是所有孤儿一夜之间「有人引用了」，这门禁就自己把自己关掉了。
 */
const NOT_A_SOURCE = new Set([SELF, 'scripts/audit-debt/check-ui-shots.json'])

const images = tracked.filter((f) => f.startsWith('docs/ui/') && IMG_RE.test(f))
const imageSet = new Set(images)
/** 存在性缓存（图片都在 git 索引里，直接查集合即可，免 次次 stat） */
const imgOK = imageSet

/** 读所有 tracked 文本文件（图片跳过；>4 MiB 的跳过 —— docs/ui 下最大约 300 KB） */
const texts = new Map()
for (const f of tracked) {
  if (IMG_RE.test(f) || NOT_A_SOURCE.has(f)) continue
  try {
    const abs = path.join(ROOT, f)
    if (fs.statSync(abs).size > 4 * 1024 * 1024) continue
    texts.set(f, fs.readFileSync(abs, 'utf8'))
  } catch {
    /* 二进制 / 不可读：跳过 */
  }
}

/** 去掉 fenced code block 与 `~~删除线~~`（两者都不是「现在指得着的引用」） */
const stripNonRefs = (t) =>
  t.replace(/^[ \t]*(```|~~~)[\s\S]*?^[ \t]*\1/gm, '').replace(/~~[^~\n]*~~/g, '')

const base = path.posix.basename
const byBase = new Map()
for (const img of images) {
  const b = base(img)
  if (!byBase.has(b)) byBase.set(b, [])
  byBase.get(b).push(img)
}

// ─────────────────────────── 引用收集 ───────────────────────────
/** img -> [{ how, file, token }] */
const refs = new Map()
const addRef = (img, rec) => {
  if (!refs.has(img)) refs.set(img, [])
  refs.get(img).push(rec)
}

/** 目录级引用：目录 -> Set(出处) */
const dirCite = new Map()
const citeDir = (dir, why) => {
  if (!dirCite.has(dir)) dirCite.set(dir, new Set())
  dirCite.get(dir).add(why)
}

/** 递归展开花括号：`a-{1,2}-{x,y}.png` → 4 条。展开不干净（还有 `{`）就返回空（不当引用判） */
const expandBraces = (token, depth = 0) => {
  if (depth > 4) return []
  const m = token.match(/^(.*?)\{([^{}]*)\}(.*)$/)
  if (!m) return token.includes('{') || token.includes('}') ? [] : [token]
  return m[2].split(',').flatMap((alt) => expandBraces(m[1] + alt + m[3], depth + 1))
}

const TOKEN_RE = /[^\s'"`()[\]<>|;、，。]+/g
const DIR_RE = /(?:^|[\s`'"([|])((?:[\w.@+-]+\/)*docs\/ui\/[\w.@+\-\u4e00-\u9fff/]*\/)(?![\w.@+-]*\.)/gm
const BARE_DIR_RE = /(?:^|[\s`'"([|])((?:[\w.@+\-\u4e00-\u9fff]+\/)+)(?=[\s`'")|,，。]|$)/gm
const ELLIPSIS_DIR_RE = /(?:^|[\s`'"([|])([\w.@+\-\u4e00-\u9fff]+)\/[\u2026.。]{1,3}(?=[\s`'")\]|,，。]|$)/gm

for (const [file, raw] of texts) {
  const text = stripNonRefs(raw).replace(/\\/g, '/')
  const docDir = path.posix.dirname(file)
  const isMd = file.endsWith('.md')

  // F：目录级引用（只认文档；测试/脚本里的输出目录是「生产方」自我声明，不是谁在引用这些图）
  if (isMd) {
    for (const m of text.matchAll(DIR_RE)) {
      const d = norm(m[1])
      if (d.startsWith('docs/ui/') && d !== 'docs/ui') citeDir(d, file)
    }
    for (const m of text.matchAll(BARE_DIR_RE)) {
      const d = norm(path.posix.join(docDir, m[1]))
      if (!d.startsWith('docs/ui/') || d === 'docs/ui') continue
      try {
        if (fs.statSync(path.join(ROOT, d)).isDirectory()) citeDir(d, `${file} (裸目录名)`)
      } catch {
        /* 目录不存在：不是引用 */
      }
    }
    for (const m of text.matchAll(ELLIPSIS_DIR_RE)) {
      const d = norm(path.posix.join(docDir, m[1]))
      if (d.startsWith('docs/ui/') && d !== 'docs/ui') citeDir(d, `${file} (省略号)`)
    }
  }

  // A/B/C/E/H：逐 token
  const resolvedInFile = []
  for (const m of text.matchAll(TOKEN_RE)) {
    const token = stripLead(m[0])
    const variants = expandBraces(token)

    for (const v of variants) {
      if (!IMG_RE.test(v)) continue
      const hasGlob = v.includes('*') && !v.includes('**')
      for (const cand of [norm(path.posix.join(docDir, v)), norm(v)]) {
        if (!hasGlob) {
          if (imageSet.has(cand)) {
            addRef(cand, { how: 'path', file, token })
            resolvedInFile.push(cand)
          }
          continue
        }
        const re = globToRe(cand)
        for (const img of images) {
          if (re.test(img)) {
            addRef(img, { how: 'glob', file, token })
            resolvedInFile.push(img)
          }
        }
      }
    }

    // D：祖先裸名（`quota-{390,360}.png` 展开出来的裸名同样适用）
    for (const v of variants) {
      if (v.includes('/') || !IMG_RE.test(v)) continue
      const same = byBase.get(v)
      if (same && docDir !== '.' && same.every((p) => p.startsWith(docDir + '/')))
        for (const p of same) addRef(p, { how: 'ancestor-bare', file, token })
    }

    // E：续写简写 `-s1-hold-long-360dp.png`
    if (/^-[^/]+\.(png|jpe?g|gif|webp|svg)$/i.test(token) && token.length >= 10 && resolvedInFile.length) {
      const dirs = new Set(resolvedInFile.map((p) => path.posix.dirname(p)))
      for (const img of images)
        if (dirs.has(path.posix.dirname(img)) && base(img).endsWith(token))
          addRef(img, { how: 'shorthand', file, token })
    }

    // H：stem 前缀（`390/01-失败-有缓存兜底`）
    if (!IMG_RE.test(token) && !token.includes('*') && token.includes('/')) {
      const seg = token.split('/').pop()
      if (seg.length >= 6) {
        for (const cand of [norm(path.posix.join(docDir, token)), norm(token)]) {
          const dir = path.posix.dirname(cand)
          let entries
          try {
            entries = fs.readdirSync(path.join(ROOT, dir))
          } catch {
            continue
          }
          for (const e of entries) {
            const p = path.posix.join(dir, e)
            if (imageSet.has(p) && base(p).startsWith(seg)) addRef(p, { how: 'stem', file, token })
          }
        }
      }
    }
  }
}

// L0：字面文件名（双判据里的那两条 grep 的并集）
for (const img of images) {
  const b = base(img)
  for (const [file, text] of texts) if (text.includes(b)) addRef(img, { how: 'literal', file })
}

// ─────────────────────────── ① 孤儿 ───────────────────────────
const orphans = []
const keptByHow = {}
for (const img of images) {
  const r = refs.get(img) || []
  if (r.length) {
    keptByHow[r[0].how] = (keptByHow[r[0].how] || 0) + 1
    continue
  }
  let d = path.posix.dirname(img)
  let cited = null
  while (d.startsWith('docs/ui')) {
    if (dirCite.has(d)) {
      cited = d
      break
    }
    if (d === 'docs/ui') break
    d = path.posix.dirname(d)
  }
  if (cited) {
    keptByHow.dir = (keptByHow.dir || 0) + 1
    continue
  }
  if (EXEMPT.has(img)) {
    keptByHow.exempt = (keptByHow.exempt || 0) + 1
    continue
  }
  orphans.push(img)
}

// ─────────────────────────── ② 悬空引用 ───────────────────────────
/**
 * 只判**文档**（`*.md`）：`metrics.json` / `result-*.json` 这类机器记录里的历史路径是
 * 「当时采集了什么」的档案，不是「现在指得着吗」的断言（#133/#180 几处就属于这种）；
 * 生成脚本里的 `${base}.png` 模板同理。
 *
 * 只判两种能**确定**指向某张图的写法：
 *   - 带 `/` 的路径：解析到 `docs/ui/**` 且父目录还在 → 文件必须存在；
 *   - 裸文件名：只在「文档就躺在那批图中间」时判（该目录直接有图片、且没有图片子目录）。
 *     `docs/ui/README.md`（整目录索引）、`auth-pages/README.md`（图在 360/390 子目录）都不满足，不判。
 *
 * 续写简写（`830-01-flash-frame-390.png` / `-360.png`）**不算悬空**：`-360.png` 本身不是文件名，
 * 它是「上一条已解析到的那批图的 360 档」。判它「同目录裸名不存在」是门禁自己在造红 ——
 * 实测 `docs/ui/819-invite-flash/README.md` 有 4 行这么写，图全都在，门禁却报了 8 条悬空
 * （#761 里 5 条「真红」里有 8 条是这一条假红贡献的）。现在按「同目录里有没有以这个后缀收尾的图」判，
 * 一条都不许静默放过：找不到匹配照样红，理由改成「续写简写无匹配」。
 */
/** 工作树上真实存在的图（`git ls-files` 是「提交里有什么」，删了工作树副本它还在索引里） */
const liveImages = images.filter((f) => fs.existsSync(path.join(ROOT, f)))
const liveSet = new Set(liveImages)

const hasImageSubdir = (dir) =>
  liveImages.some((img) => {
    const parent = path.posix.dirname(img)
    return parent !== dir && parent.startsWith(dir + '/')
  })
const PLACEHOLDER = /[…]{1,}|[.]{3,}|\$\{|\}|[*]$/

const dead = []
for (const [file, raw] of texts) {
  if (!file.endsWith('.md')) continue
  const text = stripNonRefs(raw).replace(/\\/g, '/')
  const docDir = path.posix.dirname(file)
  const leafDirWithImages = liveImages.some((img) => path.posix.dirname(img) === docDir) && !hasImageSubdir(docDir)
  /** 本文件里上一条**已解析成功**的引用落在哪些目录（续写简写 `-360.png` 靠它定位） */
  let lastDirs = new Set([docDir])

  for (const m of text.matchAll(TOKEN_RE)) {
    const token = stripLead(m[0])
    if (!IMG_RE.test(token)) continue
    if (token.includes('**') || token.includes('…') || token.includes('${')) continue
    if (/^(https?:|\/|~)/.test(token) || token.includes('://')) continue

    const variants = expandBraces(token)
    if (!variants.length) continue

    for (const v of variants) {
      if (!IMG_RE.test(v) || PLACEHOLDER.test(v)) continue
      if (v.includes('/')) {
        for (const cand of [norm(path.posix.join(docDir, v)), norm(v)]) {
          if (!cand.startsWith('docs/ui/')) continue
          if (!fs.existsSync(path.join(ROOT, path.posix.dirname(cand)))) continue // 目录都不在：历史口述，不判
          if (v.includes('*')) {
            const re = globToRe(cand)
            if (!liveImages.some((img) => re.test(img))) dead.push({ file, token, why: 'glob 无匹配' })
            continue
          }
          if (liveSet.has(cand)) {
            lastDirs = new Set([path.posix.dirname(cand)])
            continue
          }
          dead.push({ file, token, why: '文件不存在' })
        }
        continue
      }
      if (!leafDirWithImages) continue
      // 续写简写：`-360.png` / `-390-full.png` 指向上一条已解析到的那批图的同名档位
      if (/^-[^/]{2,}\.(png|jpe?g|gif|webp|svg)$/i.test(v)) {
        const dirs = new Set([...lastDirs, docDir])
        const hit = [...dirs].some((dir) => liveImages.some((img) => path.posix.dirname(img) === dir && base(img).endsWith(v)))
        if (!hit) dead.push({ file, token: v, why: '续写简写无匹配（上一条引用所在目录里没有这个档位）' })
        continue
      }
      if (v.includes('*')) {
        const re = globToRe(v)
        const hit = liveImages.some((img) => path.posix.dirname(img) === docDir && re.test(base(img)))
        if (hit) lastDirs = new Set([docDir])
        if (!hit) dead.push({ file, token, why: '同目录 glob 无匹配' })
        continue
      }
      if (liveSet.has(norm(path.posix.join(docDir, v)))) {
        lastDirs = new Set([docDir])
        continue
      }
      if (!leafDirWithImages) continue
      dead.push({ file, token: v, why: '同目录裸名不存在' })
    }
  }
}

// ─────────────────────────── 输出 ───────────────────────────
const orphanBytes = orphans.reduce((a, p) => {
  try {
    return a + fs.statSync(path.join(ROOT, p)).size
  } catch {
    return a
  }
}, 0)
const totalBytes = images.reduce((a, p) => {
  try {
    return a + fs.statSync(path.join(ROOT, p)).size
  } catch {
    return a
  }
}, 0)

// ─────────────────────────── 分级：账期内的历史孤儿 vs 新孤儿 ───────────────────────────
const debt = loadDebt({ root: ROOT, gate: DEBT_GATE })
const actualOrphans = new Map(orphans.map((p) => [p, { count: 1, sample: p }]))
const settled = settleDebt({ actual: actualOrphans, debt })
const settledKeys = new Set(settled.settled.map((item) => item.key))
const redReason = new Map()
for (const item of settled.unregistered) redReason.set(item.key, item.why)
for (const item of settled.expired) redReason.set(item.key, `已到期 ${item.entry.expires}（逾期 ${item.overdueDays} 天）`)
const redOrphans = orphans.filter((p) => redReason.has(p))
const bookedOrphans = orphans.filter((p) => settledKeys.has(p))

const ORPHAN_FIX =
  '给这张图补一份文档引用（子目录 README 的表格里写全文件名即可），' +
  '或按 #661 的流程先归档到仓库外再 `git rm`（别只删工作树副本 —— 门禁看的是 git 索引）'
const DEAD_FIX = (d) =>
  `git log --diff-filter=D --oneline -- ${d.token}   # 文件被删/改名了就把引用改对或换成 ~~删除线~~；` +
  '或把这张图补回来（它是某条结论的证据，删引用等于删证据）'

const report = {
  images: images.length,
  totalBytes,
  referenced: images.length - orphans.length,
  keptByHow,
  orphans: orphans.length,
  orphanBytes,
  orphansRed: redOrphans.length,
  orphansBooked: bookedOrphans.length,
  dead: dead.length,
  dirCited: dirCite.size,
  debt: {
    file: debt.shown,
    entries: debt.entries.size,
    settled: settled.settled.length,
    shrink: settled.shrink.length,
    problems: debt.problems,
  },
}

if (JSON_OUT) {
  console.log(
    JSON.stringify(
      {
        ...report,
        orphanList: orphans,
        redOrphanList: redOrphans,
        deadList: dead,
        debt: {
          ...report.debt,
          red: redOrphans.map((p) => ({ key: p, why: redReason.get(p) })),
          shrink: settled.shrink.map(({ key, registered, found }) => ({ key, registered, actual: found.count })),
        },
      },
      null,
      2,
    ),
  )
} else {
  if (LIST) {
    for (const p of orphans) console.log(`孤儿    ${p}${redReason.has(p) ? '（未记账/到期）' : '（已记账）'}`)
    for (const d of dead) console.log(`悬空    ${d.file} → ${d.token}（${d.why}）`)
  }
  console.log(
    `截图 ${report.images} 张 / ${(totalBytes / 1048576).toFixed(2)} MiB；` +
      `被引用 ${report.referenced}（${Object.entries(keptByHow)
        .map(([k, v]) => `${k}:${v}`)
        .join(' ')}）；目录级引用 ${report.dirCited} 个目录`,
  )
  if (redOrphans.length) {
    console.log(
      `\n❌ 未记账 / 已到期的孤儿截图 ${redOrphans.length} 张（这一档是本门禁真正的红：新图没人引用，或记账到期了）：`,
    )
    for (const p of redOrphans.slice(0, 40)) {
      console.log(`  ${p}`)
      console.log(`      事故：这张图没有任何文档 / 测试 / 脚本指向它 —— 它既不是关单证据也不在哪张表里，${redReason.get(p)}。`)
      console.log(`      修法：${ORPHAN_FIX}`)
    }
    if (redOrphans.length > 40) console.log(`  …另 ${redOrphans.length - 40} 条（--list 看全部）`)
  }
  if (bookedOrphans.length) {
    console.log(
      `\n⚠ 已记账在账期内的历史孤儿 ${bookedOrphans.length} 张 / ${orphanBytes} B（不拦，但每跑一次都会提醒）：`,
    )
    for (const p of bookedOrphans.slice(0, 40)) {
      const entry = debt.entries.get(p)
      console.log(`  ${p}  ← ${entry.issue} 到期 ${entry.expires}（剩 ${entry.left} 天）`)
    }
    if (bookedOrphans.length > 40) console.log(`  …另 ${bookedOrphans.length - 40} 条（--list 看全部）`)
  }
  if (settled.shrink.length) {
    console.log(`\nℹ 账面比实际多 ${settled.shrink.length} 笔（图已删或已补上引用，但账没销 —— 提示，不判红）：`)
    for (const item of settled.shrink.slice(0, 20)) {
      console.log(`  ${item.key}  → 从 scripts/audit-debt/check-ui-shots.json 删掉这一条`)
    }
    if (settled.shrink.length > 20) console.log(`  …另 ${settled.shrink.length - 20} 条`)
  }
  if (dead.length) {
    console.log(`\n❌ 悬空引用 ${dead.length} 条（文档写了、文件不在）：`)
    for (const d of dead.slice(0, 40)) {
      console.log(`  ${d.file} → ${d.token}（${d.why}）`)
      console.log('      事故：读者按这条引用去翻截图，翻不到 —— 结论的证据链在这里断了，而文档本身看起来是完整的。')
      console.log(`      修法：${DEAD_FIX(d)}`)
    }
    if (dead.length > 40) console.log(`  …另 ${dead.length - 40} 条（--list 看全部）`)
  }
  if (debt.problems.length) {
    console.log('\n❌ 账本形状不合规（形状不合规的账本就是白名单）：')
    for (const problem of debt.problems) console.log(`  ${problem}`)
  }
  if (debt.exists) {
    console.log(
      `\n账本 ${debt.shown}：${debt.entries.size} 笔 / 共 ${[...debt.entries.values()].reduce((sum, e) => sum + e.count, 0)} 张` +
        (debt.entries.size ? '（到期即红；新增孤儿不记账就红）' : ''),
    )
  }
  const green = redOrphans.length === 0 && dead.length === 0 && debt.problems.length === 0
  console.log(
    green
      ? bookedOrphans.length
        ? `\ncheck:ui-shots OK —— 没有新孤儿、没有悬空引用（${bookedOrphans.length} 张历史孤儿在账期内）。`
        : '\ncheck:ui-shots OK —— 每张截图都有出处，每处引用都指得着 ✅'
      : '\ncheck:ui-shots 不合格：先修 ❌ 项。',
  )
}

process.exit(redOrphans.length || dead.length || debt.problems.length ? 1 : 0)


/**
 * `--selftest`：**故意做错必须被拦**。全部在临时 git 仓库里跑（`CHECK_UI_SHOTS_ROOT`），
 * 一秒级、不碰真仓库：
 *   ① 一张图 + 一处好引用 → exit 0
 *   ② 塞一张没人引用的图（孤儿，没记账）→ **必 exit 1**
 *   ③ 把这笔孤儿记进账（未到期）→ **必 exit 0**
 *   ④ 同一本账改成已过期 → **必 exit 1**
 *   ⑤ 删掉一张被引用的图（悬空引用）→ **必 exit 1**，且印「事故 + 修法」
 *   ⑥ 账本条目没有到期日 → **必 exit 1**（永久豁免不存在）
 */
function selftest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'check-ui-shots-selftest-'))
  const cases = []
  const runGit = (args) => execFileSync('git', args, { cwd: tmp, stdio: 'pipe', maxBuffer: 1 << 26 })
  const gate = () => {
    const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
      encoding: 'utf8',
      env: { ...process.env, CHECK_UI_SHOTS_ROOT: tmp },
    })
    return { status: result.status, out: `${result.stdout ?? ''}${result.stderr ?? ''}` }
  }
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01])
  try {
    const dir = path.join(tmp, 'docs', 'ui', 'probe')
    fs.mkdirSync(path.join(dir, '360'), { recursive: true })
    fs.writeFileSync(path.join(dir, '360', 'a.png'), PNG)
    fs.writeFileSync(path.join(dir, 'README.md'), '# probe\n\n| 图 | 结论 |\n| --- | --- |\n| 360/a.png | 首屏正常 |\n')
    runGit(['init', '-q'])
    runGit(['add', '-A'])

    const clean = gate()
    cases.push({ name: '① 图与引用都在 → exit 0', ok: clean.status === 0, detail: `exit ${clean.status}` })

    fs.writeFileSync(path.join(dir, '360', 'b.png'), PNG)
    runGit(['add', '-A'])
    const orphan = gate()
    cases.push({
      name: '② 塞一张没人引用的图 → exit 1',
      ok: orphan.status === 1 && orphan.out.includes('未记账'),
      detail: `exit ${orphan.status}`,
    })
    cases.push({
      name: '② 报错自带「事故 + 修法」',
      ok: orphan.out.includes('事故：') && orphan.out.includes('修法：给这张图补一份文档引用'),
    })

    const debtDir = path.join(tmp, 'scripts', 'audit-debt')
    fs.mkdirSync(debtDir, { recursive: true })
    const ledger = path.join(debtDir, 'check-ui-shots.json')
    const key = 'docs/ui/probe/360/b.png'
    const soon = todayStr(new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10))
    fs.writeFileSync(
      ledger,
      JSON.stringify({ gate: 'check-ui-shots', entries: { [key]: { count: 1, why: 'selftest', issue: '#0', expires: soon } } }),
    )
    runGit(['add', '-A'])
    const booked = gate()
    cases.push({ name: '③ 记账未到期 → exit 0', ok: booked.status === 0, detail: `exit ${booked.status}` })
    cases.push({
      name: '③ 账本自己不算「引用出处」（否则它把孤儿登记成有引用）',
      ok: booked.out.includes('已记账在账期内'),
    })

    fs.writeFileSync(
      ledger,
      JSON.stringify({
        gate: 'check-ui-shots',
        entries: { [key]: { count: 1, why: 'selftest', issue: '#0', expires: todayStr('2020-01-01') } },
      }),
    )
    runGit(['add', '-A'])
    const expired = gate()
    cases.push({
      name: '④ 账到期 → exit 1 且报「已到期」',
      ok: expired.status === 1 && expired.out.includes('已到期'),
      detail: `exit ${expired.status}`,
    })

    // ⑤ 悬空：工作树上删掉被引用的图（索引里还在 = 「文档写了、文件不在」）
    fs.writeFileSync(
      ledger,
      JSON.stringify({ gate: 'check-ui-shots', entries: { [key]: { count: 1, why: 'selftest', issue: '#0', expires: soon } } }),
    )
    fs.rmSync(path.join(dir, '360', 'a.png'))
    const dead = gate()
    cases.push({
      name: '⑤ 删掉被引用的图 → exit 1（悬空引用）',
      ok: dead.status === 1 && dead.out.includes('悬空引用') && dead.out.includes('事故：'),
      detail: `exit ${dead.status}`,
    })

    // ⑥ 账本形状
    fs.writeFileSync(ledger, JSON.stringify({ gate: 'check-ui-shots', entries: { [key]: { why: '无期限' } } }))
    const shapeless = gate()
    cases.push({
      name: '⑥ 账本没有到期日 → exit 1',
      ok: shapeless.status === 1 && shapeless.out.includes('expires'),
      detail: `exit ${shapeless.status}`,
    })
  } catch (error) {
    cases.push({ name: 'selftest 自身抛错', ok: false, detail: error.message })
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
  return renderSelftest('check:ui-shots', cases)
}
