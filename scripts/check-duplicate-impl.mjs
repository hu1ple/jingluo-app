#!/usr/bin/env node
/**
 * check-duplicate-impl.mjs —— `scripts/**`、`tests/**`、`src/**` 下不许再出现**字节完全相同**的
 * 两份实现（Issue #289；#487 体检扩到 src）。
 *
 * 为什么要有它：#289 的化石是 `scripts/compat/lib/zip.mjs` 与 `tests/adversarial/lib/zip.mjs`
 * 是同一个 blob（559e1523…，6550 B），注释自己写着「原样复制到 lib/zip.mjs」。同一条结论就能在
 * 红队用例和 P2 导入取证两边得出相反结果，而排查的人会先怀疑产品代码。人眼看不见「两个文件字节
 * 一样」，但 git 和 sha256 看得见 —— 所以把这件事变成一条命令：**再贴一份同样的 .mjs 就 exit 1**。
 *
 * 判据只有一条：**内容字节相同**（sha256 相同）。名字相同的两份不同工具不算重复，必须放行 ——
 * 否则这条门禁会逼着人为了过检查去改文件名，而不是去消除重复。
 *
 * 范围：`scripts/`、`tests/`（取证装置与夹具，复制粘贴的实际发生地）、`src/`（产品代码）。
 *
 * 为什么 #487 体检把 `src/` 也纳进来（原来不扫）：这条门禁的名字与 CI 步骤叫「重复实现」，
 * 但口径只覆盖脚本与用例 —— 于是**复制一个 src 文件改个名**（最典型的那次事故：#289 的
 * `zip.mjs` 就是「原样复制」）在整个仓库里没有任何门禁会红。改口径时实测 `src/` 下 223 个
 * 代码文件字节重复 **0 组**，所以扩范围当天不会凭空造红；`src/` 里确实需要长得一样的
 * （外观相似但语义独立的组件）照旧走下面的 allow-list，写理由即可。
 *
 * 不扫：`docs/`（历史实测记录与当时的脚本快照要保原样）、`node_modules` / `dist*` / `.git`
 * （依赖与产物）。
 *
 * 合法重复走 allow-list（必须写理由）：例如 `*.tsx` 组件、`ic_launcher*.xml` 这类「形状相同但
 * 语义各自独立」的文件。当前仓库 scripts/ 与 tests/ 下没有合法重复，所以清单是空的。
 *
 * 用法：
 *   node scripts/check-duplicate-impl.mjs
 *   pnpm run check:dup-impl
 *   node scripts/check-duplicate-impl.mjs --selftest   # 自带负向对照（6 拍，临时仓库，不碰本仓）
 *
 * 退出码：
 *   0  干净（没有字节相同的两份实现）
 *   1  发现重复，逐组打印 `sha256  文件A  文件B…`
 *   2  用法 / 环境错误
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { renderSelftest } from './lib/auditDebt.mjs'

/**
 * 仓库根。`CHECK_DUP_IMPL_ROOT` 只给 `--selftest` 用（它在一个临时仓库上跑），
 * 是测试注入口、不是运行开关：正常调用不设这个变量。
 */
const ROOT = path.resolve(process.env.CHECK_DUP_IMPL_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'))

/** 扫这些目录（相对仓库根） */
const SCAN_DIRS = ['scripts', 'tests', 'src']

/** 只看会「被执行」的代码文件；.json / 图片这类数据文件字节相同不代表实现重复 */
const EXTENSIONS = new Set(['.mjs', '.js', '.cjs', '.ts', '.tsx'])

/** 任意层级都不进的目录 */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-internal', '.git', 'coverage'])

/**
 * 合法重复白名单：每一项 { match: RegExp, reason }。
 * 判据是「组内**每一个**文件都被某条规则命中」才算合法，避免一条规则放行整组无关文件。
 */
const ALLOW = []

const rel = (file) => path.relative(ROOT, file).split(path.sep).join('/')

const walk = (dir, out) => {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') return out
    throw error
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      walk(path.join(dir, entry.name), out)
    } else if (entry.isFile() && EXTENSIONS.has(path.extname(entry.name))) {
      out.push(path.join(dir, entry.name))
    }
  }
  return out
}


/**
 * `--selftest`：**故意做错必须被拦**。临时仓库（`CHECK_DUP_IMPL_ROOT`）五拍：
 *   ① 两个内容不同的文件 → exit 0
 *   ② 把其中一个原样复制一份（**字节完全相同**）→ **必 exit 1**，印出 sha256 与两个路径，并给处理方式
 *   ③ 两个空文件（字节也相同）→ exit 0（空文件不构成「两份实现」）
 *   ④ 改掉副本里一个字节 → exit 0（证明「红来自字节相同」，不是「名字相同」）
 *   ⑤ 扫描范围为空 → exit 2（不谎报通过）
 */
const selftest = () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'check-dup-impl-selftest-'))
  const cases = []
  const gate = () => {
    const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
      encoding: 'utf8',
      env: { ...process.env, CHECK_DUP_IMPL_ROOT: tmp },
    })
    return { status: result.status, out: `${result.stdout ?? ''}${result.stderr ?? ''}` }
  }
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true })
    fs.writeFileSync(path.join(tmp, rel), text, 'utf8')
  }
  try {
    write('scripts/a.mjs', 'export const a = 1\n')
    write('tests/b.mjs', 'export const b = 2\n')
    cases.push({ name: '① 两份不同实现 → exit 0', ok: gate().status === 0 })

    write('tests/b-copy.mjs', 'export const a = 1\n')
    const dup = gate()
    cases.push({
      name: '② 原样复制一份 → exit 1',
      ok: dup.status === 1 && dup.out.includes('scripts/a.mjs') && dup.out.includes('tests/b-copy.mjs'),
      detail: `exit ${dup.status}`,
    })
    cases.push({
      name: '② 报错带 sha256 + 处理方式（删副本 / 抽共用模块）',
      ok: /sha256 [0-9a-f]{64}/.test(dup.out) && dup.out.includes('删掉副本'),
    })

    fs.rmSync(path.join(tmp, 'tests/b-copy.mjs'))
    write('scripts/empty1.mjs', '')
    write('tests/empty2.mjs', '')
    cases.push({ name: '③ 两个空文件 → exit 0（不算两份实现）', ok: gate().status === 0 })

    write('tests/b-copy.mjs', 'export const a = 1 \n')
    cases.push({ name: '④ 副本差一个字节 → exit 0（判据是字节相同，不是名字相同）', ok: gate().status === 0 })

    fs.rmSync(path.join(tmp, 'scripts'), { recursive: true })
    fs.rmSync(path.join(tmp, 'tests'), { recursive: true })
    fs.rmSync(path.join(tmp, 'src'), { recursive: true, force: true })
    cases.push({ name: '⑤ 三个扫描目录都不在 → exit 2（不谎报通过）', ok: gate().status === 2 })
  } catch (error) {
    cases.push({ name: 'selftest 自身抛错', ok: false, detail: error.message })
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
  return renderSelftest('check:dup-impl', cases)
}

if (process.argv.includes('--selftest')) process.exit(selftest() ? 0 : 1)

const files = []
for (const dir of SCAN_DIRS) walk(path.join(ROOT, dir), files)

if (files.length === 0) {
  console.error(`扫描范围为空（${SCAN_DIRS.join(' / ')}），按用法错误处理`)
  process.exit(2)
}

/** sha256 → 文件列表 */
const byHash = new Map()
let scanned = 0
for (const file of files) {
  const bytes = fs.readFileSync(file)
  // 空文件（或只有空白的文件）字节天然相同，不构成「两份实现」
  if (bytes.length === 0) continue
  scanned += 1
  const hash = createHash('sha256').update(bytes).digest('hex')
  const bucket = byHash.get(hash)
  if (bucket) bucket.push(file)
  else byHash.set(hash, [file])
}

const allowed = (group) =>
  group.every((file) => ALLOW.some((rule) => rule.match.test(rel(file))))

const duplicates = []
const tolerated = []
for (const [hash, group] of byHash) {
  if (group.length < 2) continue
  ;(allowed(group) ? tolerated : duplicates).push([hash, group])
}

console.log(
  `扫描 ${SCAN_DIRS.join(' / ')} 下 ${scanned} 个 ${[...EXTENSIONS].join('/')} 文件，` +
    `字节重复 ${duplicates.length} 组（白名单放行 ${tolerated.length} 组）`
)

for (const [hash, group] of tolerated) {
  console.log(`\n允许（白名单）：${hash}`)
  for (const file of group) console.log(`  ${rel(file)}`)
}

if (duplicates.length > 0) {
  console.error('\n发现字节完全相同的两份实现（同一件事写了两遍，改一处必忘另一处）：')
  for (const [hash, group] of duplicates.sort((a, b) => rel(a[1][0]).localeCompare(rel(b[1][0])))) {
    console.error(`\n  sha256 ${hash}`)
    for (const file of group) console.error(`    ${rel(file)}`)
  }
  console.error(
    '\n处理方式（二选一，不要改名绕过）：\n' +
      '  1. 只是同一份实现贴了两处 → 删掉副本，让另一方直接 import 保留的那份；\n' +
      '  2. 确实各有用途 → 把真正重复的部分抽成共用模块，各自的差异留在适配层。\n' +
      '实在属于合法重复（形状相同、语义各自独立），在 scripts/check-duplicate-impl.mjs 的 ALLOW 里\n' +
      '登记并写明理由。'
  )
  process.exit(1)
}

console.log('OK：没有字节完全相同的两份实现')
