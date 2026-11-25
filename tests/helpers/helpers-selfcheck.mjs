#!/usr/bin/env node
/**
 * 辅助层（`tests/helpers/helpers.mjs`）的**自我证伪**脚本：证明这一层坏了会红、而且红得可读。
 *
 * 为什么要有它：辅助层是「所有用例共用的那一截路」。它最危险的失效形态不是崩，而是
 * **静默把用例带到别处还能通过**（例如旧版按 `.last()` / `name: /渠道/` 取节点），
 * 或者**一次红变成 30s 超时堆栈**（读 30 秒栈才知道是哪个选择器过期了）。这两件事都不会被
 * 正常用例拦住 —— 用例只会「红成一片」或「绿得可疑」。所以这里用三条**故意破坏**的对照来守：
 *
 *   1. 指向**不存在的来源行** → 必须**几秒内**红，且报错点名那一行、列出真实的三行；
 *   2. 没有任何行展开时填字段 → 必须**几秒内**红，并说清「先展开哪一行」；
 *   3. 出站总闸**没有被桩放宽**：把默认桩的 path 写错（模拟服务端改了接口路径）→ 真请求必须
 *      被判成「未登记出站」→ 红。桩是替身，不是白名单。
 *
 * 跑法（缺产物会 SKIP(env)，不算失败）：
 *
 *   TEST_AUTH_SEAM=1 node tests/helpers/helpers-selfcheck.mjs
 *   APP_URL=http://127.0.0.1:<port> node tests/helpers/helpers-selfcheck.mjs   # 复用已在跑的服务
 */
import { serveDir, skipEnv } from './env.mjs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')
const DIST = process.env.DIST_DIR || process.env.STANDARD_DIST_DIR || path.join(ROOT, 'dist-standard')

/** 「几秒内」的硬上限：超时堆栈是 30s，这里必须远小于它才有诊断价值 */
const FAST_FAIL_MS = 8000

const failures = []
const ok = (label, detail = '') => console.log(`  ok  ${label}${detail ? `：${detail}` : ''}`)
const bad = (label, detail = '') => {
  failures.push(`${label}${detail ? `：${detail}` : ''}`)
  console.error(`  ✗ ${label}${detail ? `：${detail}` : ''}`)
}

/** 跑一段「应该抛错」的代码，返回 { ms, message } 或 null（没抛就是坏） */
const expectThrow = async (label, run) => {
  const started = Date.now()
  try {
    await run()
  } catch (error) {
    const ms = Date.now() - started
    if (ms > FAST_FAIL_MS) {
      bad(`${label} · 报错太慢`, `${ms}ms > ${FAST_FAIL_MS}ms（一次红不该让人读 30s 超时栈）`)
    } else {
      ok(`${label} · ${ms}ms 内红`)
    }
    return error instanceof Error ? error.message : String(error)
  }
  bad(`${label} · 居然没红`, '这一步必须失败，否则辅助层把「走错路」伪装成了通过')
  return null
}

if (!process.env.APP_URL) {
  const served = await serveDir(DIST, { port: 0, label: DIST }).catch(() => null)
  if (served === null) {
    skipEnv(`找不到可用产物：${DIST}`, '先构建：TEST_AUTH_SEAM=1 NODE_ENV=production DIST_OUT=dist-standard npx rspack build -c rspack.config.ts')
  }
  process.env.APP_URL = served.url
}
// APP_URL 在 helpers 模块初始化时读取，所以必须先设好再 import（静态 import 会被提升）
const {
  openApp,
  openSettingsDataSection,
  fillApiKey,
  closeSettings,
  CONSUME_GATEWAY_HOST,
  BUILTIN_KEY_CLAIM_STUB,
} = await (async () => {
  const mod = await import('./helpers.mjs')
  return { ...mod, ...(await import('../fixtures/consume-gateway-stubs/builtin-key-claim.mjs')) }
})()

const name = 'tests/helpers/helpers-selfcheck.mjs'

// ─────────────────────────────── 1) + 2)：走错行 / 没展开就填 → 必须快速红且点名
{
  const { browser, page } = await openApp()
  try {
    await openSettingsDataSection(page)

    const message = await expectThrow('指向不存在的来源行', () =>
      openSettingsDataSection(page, { row: 'no-such-row' })
    )
    if (message !== null) {
      const namesRow = message.includes('settings-source-no-such-row')
      const listsReal = ['settings-source-builtin', 'settings-source-third', 'settings-source-official'].every((id) =>
        message.includes(id)
      )
      const saysWhere = message.includes('卡在') && message.includes('期望')
      if (namesRow && listsReal && saysWhere) {
        ok('报错点名「哪一行找不到」并列出真实的三行', message.split('\n').slice(0, 3).join(' ｜ '))
      } else {
        bad(
          '报错没有说清是哪一行',
          `点名行=${namesRow} 列出真实三行=${listsReal} 有「卡在/期望」=${saysWhere}；原文=${JSON.stringify(message.slice(0, 200))}`
        )
      }
    }

    // 收起所有行（openSettingsDataSection 展开的那个也收掉）→ 填字段必须立刻说「先展开一行」
    for (const row of ['builtin', 'third', 'official']) {
      const header = page.getByTestId(`settings-source-${row}`)
      if ((await header.count()) > 0 && (await header.getAttribute('aria-expanded')) === 'true') {
        await header.click()
      }
    }
    const noPanel = await expectThrow('没有任何行展开时填 API Key', () => fillApiKey(page, 'sk-selfcheck'))
    if (noPanel !== null && !/展开/.test(noPanel)) {
      bad('「没有展开行」的报错没告诉用户先展开一行', noPanel.slice(0, 160))
    } else if (noPanel !== null) {
      ok('报错给出下一步（先展开一行）')
    }
    await closeSettings(page)
  } catch (error) {
    bad('自我证伪（来源行 / 展开态）跑挂', error instanceof Error ? error.message : String(error))
  } finally {
    // 这一段的浏览器自己收（不跑 finish：下面的总闸对照要独立装配）
    await browser.close()
  }
}

// ─────────────────────────────── 3) 总闸没有被默认桩放宽：桩的 path 写错照样红
{
  const { chromium } = await import('playwright')
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    // 只装一条**路径写错**的「领 Key」桩：真实请求打到 /api/v1/keys，桩登记的是 /api/v1/keys-TYPO
    const typo = { ...BUILTIN_KEY_CLAIM_STUB, name: 'builtin-key-claim-typo', path: /^\/api\/v1\/keys-TYPO$/ }
    const guardMod = await import('./golden.mjs')
    const guard = await guardMod.withStubbedBackends(page, {
      appUrl: process.env.APP_URL,
      stubs: [typo],
    })
    await page.goto(process.env.APP_URL, { waitUntil: 'domcontentloaded' })
    // 未配置首屏会真去领内置 Key（接缝下发 2 次）——桩路径不对，必须漏出去被记下来
    await page.waitForTimeout(2500)
    const leaked = guard.escaped.map((item) => `${item.method} ${item.host}${item.path}`)
    if (leaked.length > 0) {
      ok('桩路径写错 → 真请求被判「未登记出站」', leaked.slice(0, 2).join('、'))
      const host = CONSUME_GATEWAY_HOST
      if (leaked.some((line) => line.includes(host))) {
        ok(`漏出的 host 就是 ${host}（说明判据没被放宽）`)
      } else {
        bad('漏出的请求不是预期的 host', leaked.join('、'))
      }
    } else {
      bad(
        '桩路径写错居然没漏出',
        '默认桩把总闸放宽了：这条对照不红，就说明「未登记出站」已经形同虚设' +
          '（另一可能：产物不是 TEST_AUTH_SEAM=1 构建 → 首屏根本不去领 Key，见文件头的构建命令）'
      )
    }
  } catch (error) {
    bad(
      '自我证伪（总闸对照）跑挂',
      error instanceof Error ? `${error.message}\n${(error.stack ?? '').split('\n').slice(1, 4).join('\n')}` : String(error)
    )
  } finally {
    await browser.close()
  }
}

// ─────────────────────────────── 收尾
if (failures.length > 0) {
  console.error(`\nFAIL ${name}`)
  for (const failure of failures) {
    console.error(`  ✗ ${failure}`)
  }
  process.exit(1)
}
console.log(`\nPASS ${name}（3 条故意破坏都按预期红了，且红得可读）`)
