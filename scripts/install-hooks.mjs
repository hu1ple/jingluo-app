#!/usr/bin/env node
/**
 * install-hooks.mjs —— 把 `.githooks/` 接成这个 clone 的 git 钩子目录（一次性，零依赖）
 *
 * ## 为什么不用 husky
 *
 * 本仓 `package.json` 没有 `husky` 依赖，也没有 `.husky/`。为了两个 shell 脚本引入一个 npm 依赖 +
 * `prepare` 生命周期（= 每次 `pnpm install` 都可能改写你本机的 git 配置），成本大于收益。
 * `core.hooksPath` 是 git 自带的能力：钩子文件是**仓库里的普通文件**（`.githooks/pre-commit`），
 * 版本化、可 review、可 diff，装与不装只差一条 `git config`。
 *
 * ## 它做什么
 *
 *   git config --local core.hooksPath .githooks
 *
 * 并当场验证三件事（任一条不成立就 exit 1，别让人以为「装好了」）：
 *   1. 钩子文件在、**有可执行位**（git 直接 exec 它，没有 +x 就是静默不跑）；
 *   2. `core.hooksPath` 读回来确实是 `.githooks`；
 *   3. 钩子里引用的 `scripts/dev-check.mjs` 真的在。
 *
 * ## 一个必须知道的副作用
 *
 * `core.hooksPath` 写在 **clone 级**配置（`.git/config`）里 —— 对这个 clone 的**所有 worktree**
 * 同时生效。多 lane 并行开 worktree 时，装一次＝每个 lane 的 `git commit` 都会跑提交档门禁（~4s）。
 * 不想跑了：`pnpm hooks:uninstall`（`--no-verify` 只跳过一次，卸载是永久的）。
 *
 * 用法：
 *   pnpm hooks:install
 *   pnpm hooks:uninstall
 */
import { spawnSync } from 'node:child_process'
import { access, constants } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const HOOKS_DIR = '.githooks'
const HOOKS = ['pre-commit', 'pre-push']
const DEV_CHECK = path.join(ROOT, 'scripts', 'dev-check.mjs')

const git = (args) => spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' })

const main = async () => {
  const uninstall = process.argv.includes('--uninstall')

  if (uninstall) {
    const current = git(['config', '--get', 'core.hooksPath']).stdout.trim()
    if (current !== HOOKS_DIR) {
      console.log(`没装（core.hooksPath=${current || '未设置'}），不需要卸载。`)
      return 0
    }
    const removed = git(['config', '--local', '--unset', 'core.hooksPath'])
    if (removed.status !== 0) {
      console.error(`卸载失败：${removed.stderr.trim()}`)
      return 1
    }
    console.log('已卸载：core.hooksPath 恢复默认（.git/hooks/）。本仓库的钩子不再拦任何提交。')
    return 0
  }

  const problems = []
  try {
    await access(DEV_CHECK, constants.R_OK)
  } catch {
    problems.push(`scripts/dev-check.mjs 不存在（钩子跑起来会直接 exit 127）`)
  }
  for (const hook of HOOKS) {
    const file = path.join(ROOT, HOOKS_DIR, hook)
    try {
      await access(file, constants.R_OK | constants.X_OK)
    } catch {
      problems.push(
        `${HOOKS_DIR}/${hook} 不存在或没有可执行位（修：chmod +x ${HOOKS_DIR}/${hook}）—— 没有 +x 时 git 会**静默地不跑**它`
      )
    }
  }
  if (problems.length > 0) {
    console.error('装不了（这些不是「警告」，钩子会静默失效）：')
    for (const problem of problems) console.error(`  · ${problem}`)
    return 1
  }

  // --local：只写这个 clone，不动全局配置；用 --local 而不是裸 `git config` 是避免意外写到 ~/.gitconfig
  const set = git(['config', '--local', 'core.hooksPath', HOOKS_DIR])
  if (set.status !== 0) {
    console.error(`设置 core.hooksPath 失败：${set.stderr.trim()}`)
    return 1
  }
  const readBack = git(['config', '--get', 'core.hooksPath']).stdout.trim()
  if (readBack !== HOOKS_DIR) {
    console.error(
      `读回来是 core.hooksPath=${readBack || '(空)'}，不是 ${HOOKS_DIR} —— 可能有更高优先级的配置（--global / 环境变量）在覆盖它`
    )
    return 1
  }

  console.log(
    `已装：core.hooksPath=${HOOKS_DIR}（这个 clone 的所有 worktree 共用，含你在开的其它 lane）`
  )
  console.log('  pre-commit → node scripts/dev-check.mjs --content --brief（纯内容门禁，~4s）')
  console.log('  pre-push   → node scripts/dev-check.mjs --brief（内容门禁 + 类型门 + lint，~13s）')
  console.log('\n验证它会真的跑（不改任何东西）：')
  console.log(
    '  git commit --allow-empty -m "probe" --dry-run   # 不会触发钩子（--dry-run 不跑 hook）'
  )
  console.log(
    '  git commit --allow-empty -m "probe"             # 触发了：先看到 dev-check 的输出再决定要不要提交'
  )
  console.log('  跳过一次：git commit --no-verify；永久关掉：pnpm hooks:uninstall')
  return 0
}

process.exitCode = await main()
