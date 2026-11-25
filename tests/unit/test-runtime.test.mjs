// #507：`__ENDPOINTS__` 全局兜底 —— 装载即挂（幂等）。单跑本文件（不经 run-layer 的 `--import` 预加载）也不会
// `ReferenceError: __ENDPOINTS__ is not defined`；走门禁时与预加载是同一份模块，无副作用叠加。
import '../helpers/injected.mjs'

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, writeFile, rm, cp, readdir, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { runCase, serveDist, requireDist } from '../helpers/runtime.mjs'
import { FETCH_REFUSED_PORTS } from '../helpers/ports.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const privateRoot = async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'runtime-regression-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}
const execute = (file, args = []) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [file, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', (chunk) => { output += chunk })
  child.stderr.on('data', (chunk) => { output += chunk })
  child.on('error', reject)
  child.on('close', (code) => resolve({ code, output }))
})

/**
 * 沙箱镜像的**复制清单：只列目录，不列文件。**
 *
 * 沙箱不是「被测入口的最小可跑包」，而是「仓库的一份小型镜像」：入口会连带 import 共享 helper
 * （runtime / env / ports / merge-* 以及它们各自的依赖）、端点读取器（`scripts/lib/*`）、
 * 配置（`config/*`）与 fixture（`tests/fixtures/*`）。
 *
 * 逐文件点名的失败史 —— 每一次表现都是「入口断言没拿到预期输出」，真因都是「副本缺文件」：
 *   #366 缺 merged-entry.mjs（合并批次起不来）、#501 缺 tap.mjs、#487 缺 consumeEndpoints.mjs、
 *   #555 缺 helpers.mjs，以及本条：fixture 只点了 `domain03-04/ours-upstream.mjs` 一个，而
 *   `tests/integration/diagnostics-contract.test.mjs` 新增了
 *   `import … from '../fixtures/consume-gateway-stubs/builtin-key-claim.mjs'`
 *   → 副本里 ERR_MODULE_NOT_FOUND → `MOCK_LAUNCH_REACHED` 根本到不了。
 *
 * 所以这张表只允许写**目录**：目录里新增文件自动跟上。真需要新子树就把它加进来，
 * 不要在用例里补一行 `cp` —— 清单式镜像的失败是必然的，不是偶然的。
 */
const MIRRORED_DIRS = ['tests/helpers', 'tests/fixtures', 'scripts', 'config']

/** 镜像里可能带 import 的文件；fixture / helper 都可能是 `.js` / `.cjs` */
const CODE_FILE_RE = /\.(?:mjs|cjs|js)$/
/**
 * **静态**说明符：`import … from '…'` / `export … from '…'` / 副作用 `import '…'`。
 * 这些边一定会被 ESM 加载，所以「仓库里有、沙箱里没有」= 必崩。
 *
 * 动态 `import('…')` **不在此列**，这是刻意的：它是条件加载（`tests/helpers/ours-claim.mjs` 就是
 * 为了不炸这个沙箱才把 `src/services/invite/keyIdentity.ts` 改成懒加载的），把它当静态边会造出
 * 「文件不在沙箱里」的假红 —— 假红一多，红灯就不等于坏了。动态边的缺失在运行期会点名报错。
 */
const STATIC_SPECIFIER_RE = /(?:\bfrom\s*|\bimport\s+)["']([^"'\n]+)["']/g

/** 剥掉行注释与块注释。够用即可：这是「找相对 import」的自检，不是解析器。 */
const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/[^\n]*/g, '$1')

/** 递归列出 `base` 下所有文件的相对 posix 路径（不跟符号链接，跳过 node_modules） */
const listFiles = async (base, prefix = '') => {
  let entries
  try {
    entries = await readdir(path.join(base, prefix), { withFileTypes: true })
  } catch {
    return []
  }
  const out = []
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue
      out.push(...(await listFiles(base, rel)))
    } else if (entry.isFile()) {
      out.push(rel)
    }
  }
  return out
}

/**
 * 镜像自洽性自检 —— 本用例要守的**契约**，不是对现状的快照。两条：
 *
 * **1. `tests/fixtures` 必须整棵进来。** 比对仓库与沙箱的文件清单，缺一个就红并点名。这条防的是
 * 「以后有人把 MIRRORED_DIRS 改回清单式 / 只挑几个 fixture 复制」：只要镜像不是整棵复制，这里
 * 当场红，不依赖「恰好有没有用例 import 到缺的那个」——那是运气，不是契约。
 *
 * **2. 从入口出发的装载链，每一跳都必须落在沙箱里。** 从这次要跑的入口测试文件开始，沿相对
 * import 做广度优先，逐跳确认目标存在；缺一个就红并点名 `文件 → 说明符`，那张名单就是修法。
 *
 * 为什么只跟**装载链**而不是扫全部副本：镜像里躺着的文件不等于会被加载。例如
 * `tests/fixtures/domain05/archive.mjs` 引用 `tests/adversarial/lib/zip.mjs`，而这两个入口一个都
 * 不加载它 —— 扫全部副本会把它判红，那是**假红**（今天不坏的东西不该红）。装载链是有向的、
 * 从入口可达的，判据才和「跑起来会不会崩」同义。
 *
 * 判据是**仓库里存在、沙箱里没有**，不是「在不在 MIRRORED_DIRS 里」：装载链上的每一跳，只要仓库
 * 里真有这个文件、沙箱里没有，跑起来必崩，就该在这里红（而不是等运行期抛 ERR_MODULE_NOT_FOUND、
 * 让入口断言报成「没拿到 MOCK_LAUNCH_REACHED」那种隔了一层的样子）。
 * 仓库里**本来就没有**的相对目标直接放过：`.js` → `.ts` 的 ESM 映射（`src/utils/capabilities.js`
 * 实为 `.ts`）由打包器负责、沙箱也不镜像 `src/**`，硬判就是假红。
 */
const assertMirrorSelfContained = async (dir, testFiles) => {
  const inRepo = await listFiles(path.join(root, 'tests/fixtures'))
  const inSandbox = new Set(await listFiles(path.join(dir, 'tests/fixtures')))
  const missingFixtures = inRepo.filter((rel) => !inSandbox.has(rel))
  assert.deepEqual(
    missingFixtures,
    [],
    `沙箱没有整棵复制 tests/fixtures（缺 ${missingFixtures.length} 个文件）。` +
      '镜像必须按目录复制 `tests/fixtures`，不许退回逐个点名 —— 清单式镜像每加一个 fixture 就漏一次。',
  )

  const broken = []
  const queue = [...testFiles]
  const seen = new Set(queue)
  while (queue.length > 0) {
    const rel = queue.shift()
    if (!CODE_FILE_RE.test(rel)) continue
    const source = stripComments(await readFile(path.join(root, rel), 'utf8'))
    for (const [, specifier] of source.matchAll(STATIC_SPECIFIER_RE)) {
      if (!specifier.startsWith('.')) continue // 裸说明符走 node_modules，不归镜像管
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), specifier))
      if (!existsSync(path.join(root, target))) {
        continue // 仓库里就没这个相对目标（`.js` → `.ts` 映射 / 外部产物）：见上，不制造假红
      }
      if (!existsSync(path.join(dir, target))) {
        broken.push(`${rel} → ${specifier}`)
        continue
      }
      if (!seen.has(target)) {
        seen.add(target)
        queue.push(target)
      }
    }
  }
  assert.deepEqual(
    broken,
    [],
    `沙箱镜像缺文件（${broken.length} 处 import 指空）。镜像按目录复制时漏掉了一棵子树：` +
      '把缺的那棵加进 MIRRORED_DIRS，不要在用例里补一行 cp。',
  )
}

/**
 * 把仓库镜像进沙箱：按目录复制（MIRRORED_DIRS）+ 放入要跑的入口测试文件 + 验镜像自洽。
 *
 * 入口测试文件仍然逐个放 —— 那是「这次要跑哪两个入口」的**被测对象**，不是镜像清单；
 * 它们各自的 import 由 assertMirrorSelfContained 负责兜住。
 */
const mirrorRepo = async (dir, testFiles = []) => {
  for (const rel of MIRRORED_DIRS) {
    await cp(path.join(root, rel), path.join(dir, rel), { recursive: true })
  }
  for (const rel of testFiles) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true })
    await cp(path.join(root, rel), path.join(dir, rel))
  }
  await assertMirrorSelfContained(dir, testFiles)
}

test('case success, failure, independent temp roots and cleanup', async (t) => {
  const dir = await privateRoot(t)
  const file = path.join(dir, 'fixture.mjs')
  await writeFile(file, `console.log('LIVE', process.env.TEST_TMP_DIR); process.exit(Number(process.env.EXIT || 0))`)
  const [a, b] = await Promise.all([
    runCase(file, { cwd: dir, output: false }),
    runCase(file, { cwd: dir, output: false, env: { ...process.env, EXIT: '7' } }),
  ])
  assert.equal(a.ok, true)
  assert.equal(b.ok, false)
  assert.equal(b.code, 7)
  assert.match(a.tail.join(''), /LIVE/)
  assert.notEqual(a.tempDir, b.tempDir)
  await assert.rejects(access(a.tempDir))
  await assert.rejects(access(b.tempDir))
})

test('timeout kills owned descendants, releases listener, keeps unrelated process', { skip: process.platform === 'win32' ? 'POSIX process-group ownership regression' : false }, async (t) => {
  const dir = await privateRoot(t)
  const evidence = path.join(dir, 'ready.json')
  const fixture = path.join(dir, 'hang.mjs')
  await writeFile(fixture, `import { spawn } from 'node:child_process';
    const code = \`const http=require('node:http'); const fs=require('node:fs'); const server=http.createServer(); server.listen(0,'127.0.0.1',()=>fs.writeFileSync(process.argv[1],JSON.stringify({pid:process.pid,port:server.address().port}))); process.on('SIGTERM',()=>{});\`;
    spawn(process.execPath,['-e',code,${JSON.stringify(evidence)}],{stdio:'inherit'}); setInterval(()=>{},1000);`)
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'])
  t.after(() => new Promise((resolve) => { unrelated.once('close', resolve); unrelated.kill() }))
  const result = await runCase(fixture, { cwd: dir, timeoutMs: 1500, output: false })
  assert.equal(result.ok, false)
  assert.equal(result.timedOut, true)
  const { pid, port } = JSON.parse(await readFile(evidence, 'utf8'))
  // Rebinding the exact port is a stronger cleanup check than a killed-parent status.
  const dist = path.join(dir, 'dist'); await mkdir(dist); await writeFile(path.join(dist, 'index.html'), 'fixture')
  const server = await serveDist(dist, { port })
  await server.close()
  assert.equal(unrelated.exitCode, null)
  assert.equal(process.kill(unrelated.pid, 0), true)
  assert.ok(pid > 0)
  await assert.rejects(access(result.tempDir))
})

test('prebuilt dist reuse is read-only, concurrent ports differ and close is awaited', async (t) => {
  const dir = await privateRoot(t)
  const index = path.join(dir, 'index.html')
  await writeFile(index, 'private prebuilt')
  assert.equal(await requireDist(dir), dir)
  await assert.rejects(requireDist(path.join(dir, 'missing')), /Missing prebuilt/)
  const [a, b] = await Promise.all([serveDist(dir), serveDist(dir)])
  try {
    assert.notEqual(a.url, b.url)
    assert.equal(await (await fetch(a.url)).text(), 'private prebuilt')
    assert.equal(await (await fetch(b.url)).text(), 'private prebuilt')
    assert.equal(await readFile(index, 'utf8'), 'private prebuilt')
  } finally { await Promise.all([a.close(), b.close()]) }
  await assert.rejects(fetch(a.url))
})

test('two suite entrypoints reuse injected dist without build, and fail missing dist', async (t) => {
  const dir = await privateRoot(t)
  await mkdir(path.join(dir, 'tests/integration'), { recursive: true })
  await mkdir(path.join(dir, 'node_modules/playwright'), { recursive: true })
  await writeFile(path.join(dir, 'node_modules/playwright/package.json'), JSON.stringify({ type: 'module', exports: './index.mjs' }))
  await writeFile(path.join(dir, 'node_modules/playwright/index.mjs'), `export const chromium={launch:async()=>{throw new Error('MOCK_LAUNCH_REACHED')}}`)
  // 沙箱是「仓库的一份小型镜像」（不是入口的最小可跑包）—— 见 MIRRORED_DIRS 的失败史。
  // fixture 曾经只点名复制 `domain03-04/ours-upstream.mjs` 一个，于是 diagnostics-contract 新增
  // `consume-gateway-stubs/builtin-key-claim.mjs` 后副本里 ERR_MODULE_NOT_FOUND、
  // 断言要的 MOCK_LAUNCH_REACHED 永远到不了。现在整棵复制，并由 assertMirrorSelfContained 咬住。
  const entrypoints = ['auto-title', 'diagnostics-contract']
  await mirrorRepo(dir, entrypoints.map((name) => `tests/integration/${name}.test.mjs`))
  const dist = path.join(dir, 'prebuilt'); await mkdir(dist); await writeFile(path.join(dist, 'index.html'), 'immutable')
  for (const name of entrypoints) {
    const file = path.join(dir, `tests/integration/${name}.test.mjs`)
    const result = await runCase(file, { cwd: dir, output: false, env: { ...process.env, DIST_DIR: dist, STANDARD_DIST_DIR: dist, PORT: '0', STANDARD_PORT: '0' } })
    assert.equal(result.ok, false) // Intentional browser stop, never counted as suite PASS.
    assert.match(result.tail.join(''), /MOCK_LAUNCH_REACHED/)
    const missing = await runCase(file, { cwd: dir, output: false, env: { ...process.env, DIST_DIR: dist + '-missing', STANDARD_DIST_DIR: dist + '-missing' } })
    assert.equal(missing.ok, false)
    assert.match(missing.tail.join(''), /Missing prebuilt/)
  }
  assert.equal(await readFile(path.join(dist, 'index.html'), 'utf8'), 'immutable')
})

/** 「等第一行输出」的诊断上限：只用来区分「输出被缓冲」和「机器太慢」，不是通过判据（见用例内注释） */
const STREAM_WAIT_MS = 30_000

test('runner streams output before case exit (handshake, not buffered)', async (t) => {
  const dir = await privateRoot(t)
  const file = path.join(dir, 'live.mjs')
  const release = path.join(dir, 'release')
  /**
   * 探针：先 `console.log('READY')`，然后**阻塞到 release 文件出现**再退出。
   *
   * 等 release 用轮询而不是 `fs.watch`：inotify 实例是**每个用户 128 个**的全局稀缺资源
   * （`/proc/sys/fs/inotify/max_user_instances`），同机跑着构建 + 浏览器 + 其它 agent 时会被用完，
   * 于是 `watch()` 直接抛 `EMFILE: too many open files`，探针在打印 READY 之前就死了 ——
   * 本用例得到的却是一条「没有流式输出」的假红（实测过一次；真正的流式行为毫无问题）。
   * 探针要的只是「过一会儿再看一眼」，那个语义用定时轮询表达就够，不该占用一个全局名额。
   */
  await writeFile(
    file,
    `import { existsSync } from 'node:fs';
const timer = setInterval(() => { if (existsSync(${JSON.stringify(release)})) { clearInterval(timer); process.exit(0) } }, 25);
console.log('READY');`,
  )
  const driver = path.join(dir, 'driver.mjs')
  await writeFile(driver, `import {runCase} from ${JSON.stringify(new URL('../helpers/runtime.mjs', import.meta.url).href)}; const r=await runCase(${JSON.stringify(file)},{cwd:${JSON.stringify(dir)},timeoutMs:10000}); process.exitCode=r.ok?0:1;`)
  const child = spawn(process.execPath, [driver], { stdio: ['ignore', 'pipe', 'pipe'] })
  const closed = new Promise((resolve) => child.once('close', resolve))
  t.after(() => { if (child.exitCode === null) child.kill() })
  /**
   * 等待的判据是**终态**（收到 READY），不是「5 秒内必须收到」——后者是假红的来源：
   * 这里要跨三层进程（本文件 → driver → 被测用例）才可能看到第一行输出，而这台机器上
   * 同时跑着构建/浏览器时，三层 node 冷启动就能吃掉 5 秒（实测过一次 5.03s 的超时）。
   *
   * 上限仍然要有（缓冲型输出会一直等不到 READY，探针自己又不肯退出），但它只当**诊断上限**用：
   * 真超时要能一眼区分「输出被缓冲（缺陷）」和「机器太慢」。真正证明「流式」的断言是下面的
   * `child.exitCode === null`：READY 到达时用例**还没退出**。
   */
  const startedAt = Date.now()
  let readyMs = null
  const noise = []
  child.stdout.on('data', (chunk) => noise.push(String(chunk)))
  child.stderr.on('data', (chunk) => noise.push(String(chunk)))
  await new Promise((resolve, reject) => {
    const deadline = setTimeout(
      () => reject(new Error(`诊断上限 ${STREAM_WAIT_MS}ms 内没收到 READY：要么子进程输出被缓冲（这是要报的缺陷），要么机器太慢（三层 node 冷启动超过 ${STREAM_WAIT_MS}ms）\n${noise.join('')}`)),
      STREAM_WAIT_MS,
    )
    child.stdout.on('data', (chunk) => {
      if (!String(chunk).includes('READY')) return
      readyMs = Date.now() - startedAt
      clearTimeout(deadline)
      resolve()
    })
    // 子进程提前退出 = 探针自己崩了（装配/环境问题），不是「输出被缓冲」——
    // 这两种情况必须分得开，否则每次都是 30s 白等 + 一句误导的「没有流式输出」。
    child.once('close', (code, signal) => {
      clearTimeout(deadline)
      reject(new Error(`子进程在打印 READY 之前就退出了（code=${code} signal=${signal}）—— 这是探针/环境问题，不是「输出被缓冲」。输出：\n${noise.join('')}`))
    })
    child.once('error', reject)
  })
  assert.equal(child.exitCode, null, `READY 必须在用例退出**之前**到达（这就是「流式」的含义；实测 ${readyMs}ms）`)
  await writeFile(release, 'continue')
  assert.equal(await closed, 0)
})

test('CLI exact failure rerun, JSON, no-match, invalid arguments and node:test detection', async (t) => {
  const dir = await privateRoot(t)
  await mkdir(path.join(dir, 'tests/unit'), { recursive: true })
  // 同上一节：镜像按目录复制（MIRRORED_DIRS），不逐个列文件 —— run-layer 会连带 import
  // helpers/runtime + helpers/env，合并批次还会用到 merged-*，重跑登记用 scripts/flaky-registry.mjs。
  // 逐文件清单每加一条依赖就漏一次，红的是「沙箱缺文件」而不是「CLI 行为」（见 #366 / #501 / #487 / #555）。
  await mirrorRepo(dir, ['tests/run-layer.mjs'])
  await writeFile(path.join(dir, 'tests/unit/pass.test.mjs'), `import test from 'node:test'; test('pass',()=>{});`)
  await writeFile(path.join(dir, 'tests/unit/fail.test.mjs'), 'process.exit(9)')
  const runner = path.join(dir, 'tests/run-layer.mjs'), report = path.join(dir, 'report.json')
  const first = await execute(runner, ['unit', '--json', report])
  assert.equal(first.code, 1)
  const json = JSON.parse(await readFile(report, 'utf8'))
  assert.equal(json.passed, 1); assert.equal(json.failed, 1); assert.ok(json.totalMs >= 0)
  assert.match(first.output, /Rerun:.*--case tests\/unit\/fail.test.mjs/)
  const rerun = await execute(runner, ['unit', '--failed-from', report, '--json', report])
  assert.equal(rerun.code, 1)
  assert.equal(JSON.parse(await readFile(report, 'utf8')).executed, 1)
  assert.equal((await execute(runner, ['unit', '--case', 'pass.test.mjs'])).code, 0)
  assert.equal((await execute(runner, ['unit', '--only', 'absent'])).code, 1)
  assert.equal((await execute(runner, ['unit', '--only', 'absent', '--list'])).code, 1)
  assert.equal((await execute(runner, ['unit', '--only'])).code, 2)
  assert.equal((await execute(runner, ['unit', '--timeout-ms', 'NaN'])).code, 2)
})

// Windows 的 TCP 动态端口范围从 1024 起（netsh int ipv4 show dynamicport tcp → start=1024 num=64511），
// 所以 listen(0) 真会把 WHATWG/undici 的 “bad port”（1719 1720 1723 2049 3659 4045 4190 5060 5061 6000
// 6566 6665-6669 6679 6697 10080）当作空闲端口发给我们；而 node 的 fetch（undici）对这批端口
// 直接抛 TypeError: fetch failed（cause: bad port），一个 TCP 连接都不发。并发跑套件时分配落在这一段
// 就是「偶发假红」：单跑不复现，全量并发时随机一条。

test('port hygiene: dist ports stay fetchable, undici bad ports are never served', async (t) => {
  const dir = await privateRoot(t)
  await writeFile(path.join(dir, 'index.html'), 'private prebuilt')

  // 1) 原始假红形态：绑在 bad-port 上的 dist，fetch 一个连接都不发就失败（这里是可复现的确定性版本）
  await assert.rejects(
    (async () => {
      const served = await serveDist(dir, { port: 6566 })
      try {
        return await (await fetch(served.url)).text()
      } finally {
        await served.close()
      }
    })(),
    /fetch failed|bad port/
  )

  // 2) 显式要一个 fetch 永远连不上的端口时必须当场拒绝，不能静默交出一个连不上的地址
  const explicit = await serveDist(dir, { port: 6566 }).catch((error) => error)
  if (explicit instanceof Error) {
    assert.match(String(explicit.message), /bad port/)
  } else {
    await explicit.close()
    assert.fail('serveDist handed out a port undici refuses (6566) instead of rejecting it')
  }

  // 3) 自动选端口：连续分配不得落在 bad-port 名单上
  const picked = []
  for (let i = 0; i < 400; i += 1) {
    const served = await serveDist(dir)
    picked.push(Number(new URL(served.url).port))
    await served.close()
  }
  assert.deepEqual(
    picked.filter((port) => FETCH_REFUSED_PORTS.has(port)),
    []
  )

  // 4) 抽一个真实端口发请求：地址必须能连上并拿到内容
  const served = await serveDist(dir)
  try {
    assert.equal(await (await fetch(served.url)).text(), 'private prebuilt')
  } finally {
    await served.close()
  }
})

test('port helper discards bad ports handed out by the OS instead of serving them', async (t) => {
  const dir = await privateRoot(t)
  await writeFile(path.join(dir, 'index.html'), 'private prebuilt')
  // 模拟系统连发两个 bad port：helper 必须丢掉重绑，最后交出的端口 fetch 真能连上。
  const handed = [6566, 6668, 0]
  const served = await serveDist(dir, { choosePort: (attempt) => handed[attempt] ?? 0 })
  try {
    assert.equal(FETCH_REFUSED_PORTS.has(Number(new URL(served.url).port)), false)
    assert.equal(await (await fetch(served.url)).text(), 'private prebuilt')
  } finally {
    await served.close()
  }
})
