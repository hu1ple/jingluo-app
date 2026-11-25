// [layer: unit | 依赖: 无（纯 Node：读源码 + 形状断言，零浏览器、零真实网络） | 耗时: <1s] 说明见 tests/README.md
//
// 「不许自动打开设置层」的源码级门禁（产品决定 2026-11-25）。
//
// 产品原话：**不要**「没有 key 就自动弹设置」这个功能 —— 任何**非用户点击**就打开设置层的行为都要删掉。
// 没有 Key 时该出现的是**通知（toast / notice）**，用户可以自己点上面的按钮去选渠道，而不是被弹层打断。
//
// 四条门禁（前三条防回归到「自动弹」，第四条防过度删除 —— 用户点出来的入口必须还在）：
//   [1] `App.tsx` 里不存在启动期的 `ensureApiKey({ fromBoot ... })` 调用（连 import 一起清）
//   [2] `settingsDialogState.ts` 的 `ensureApiKey` 函数体内不出现 `openSettings(`
//   [3] 全仓 `ensureApiKey(` 的调用点都在**事件处理器 / 发送路径**里：没有一个落在 `useEffect` 块内
//   [4] 仍存在「用户点击才打开设置」的入口（侧栏按钮），防止把入口也删了
//
// 这是**源码级**门禁用例（本仓已有同类先例，见 tests/unit/managed-key-596.test.mjs 的 `codeOf()`）：
// `.tsx` 在纯 Node 里 import 不了，行为断言覆盖不到的正是「哪一行代码还在自动开弹层」这件事。
//
//   node --test tests/unit/no-auto-settings.test.mjs
//   node tests/run-layer.mjs unit --only no-auto-settings
import '../helpers/injected.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

/** 仓库内源码原文 */
const sourceOf = (file) => readFileSync(path.join(ROOT, file), 'utf8')

/**
 * 去掉注释再扫代码。
 *
 * 为什么必须去：注释里**故意**写着「启动那次 `ensureApiKey({ fromBoot: true })`」这类说明文字
 * （改前就写在 `AnnouncementPopup` / `App` 里），直接对原文匹配会把这些说明本身判成违规 ——
 * 假红比漏测更浪费后来人的时间。
 */
const codeOf = (file) =>
  sourceOf(file)
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/(^|[^:])\/\/[^\n]*/gu, '$1')

/** `src/` 下所有 .ts / .tsx 相对路径（`ensureApiKey(` 的调用点要从全仓里找，不许挑着看） */
const srcFiles = (dir = 'src') => {
  const out = []
  for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`
    if (entry.isDirectory()) {
      out.push(...srcFiles(rel))
    } else if (/\.tsx?$/u.test(entry.name)) {
      out.push(rel)
    }
  }
  return out
}

/**
 * `useEffect(` 块的字符区间：从 `useEffect(` 的括号起按深度配对到它的右括号。
 *
 * 跳过字符串字面量（含模板串）：这些文件里有 `'（）'` 或含括号的文案，按裸字符数深度会把区间算歪。
 * 注释在上面 `codeOf()` 已经去掉了，这里只需处理引号。
 */
const useEffectRanges = (code) => {
  const ranges = []
  const QUOTES = new Set(["'", '"', '`'])
  for (let at = code.indexOf('useEffect('); at >= 0; at = code.indexOf('useEffect(', at + 1)) {
    let depth = 0
    let quote = null
    for (let i = at + 'useEffect'.length; i < code.length; i += 1) {
      const ch = code[i]
      if (quote !== null) {
        if (ch === '\\') {
          i += 1
        } else if (ch === quote) {
          quote = null
        }
        continue
      }
      if (QUOTES.has(ch)) {
        quote = ch
        continue
      }
      if (ch === '(') {
        depth += 1
      } else if (ch === ')') {
        depth -= 1
        if (depth === 0) {
          ranges.push([at, i])
          break
        }
      }
    }
  }
  return ranges
}

/** 某段源码里 `ensureApiKey(` 的所有调用点位置（`const ensureApiKey =` 那个定义不算调用点） */
const ensureApiKeyCallSites = (code) => {
  const sites = []
  for (let at = code.indexOf('ensureApiKey('); at >= 0; at = code.indexOf('ensureApiKey(', at + 1)) {
    // 定义行：`export const ensureApiKey = (options...)` —— 名字后面不是 `(`，本就不会命中；
    // 但 `ensureApiKey = (options: ...) => {` 这种带括号默认值的写法会命中，显式排掉
    const before = code.slice(Math.max(0, at - 24), at)
    if (/const\s+$/u.test(before)) {
      continue
    }
    sites.push(at)
  }
  return sites
}

// ------------------------------------------------------------------ [1] 启动期不再自动调用

test('[1] App.tsx 没有启动期 ensureApiKey 调用（连 import 一起清掉）', () => {
  const code = codeOf('src/app/App.tsx')
  assert.equal(
    /ensureApiKey\s*\(\s*\{\s*fromBoot/u.test(code),
    false,
    'App.tsx 里不许再有 `ensureApiKey({ fromBoot... })`：那就是产品否掉的「启动即弹设置」'
  )
  assert.equal(
    code.includes('ensureApiKey'),
    false,
    'App.tsx 连 `ensureApiKey` 都不该再出现（启动 effect 是它唯一的用途，留着 import 就是死代码）'
  )
})

// ------------------------------------------------------------------ [2] ensureApiKey 不再开设置

test('[2] ensureApiKey 函数体内不出现 openSettings(', () => {
  const code = codeOf('src/components/settings/settingsDialogState.ts')
  const start = code.indexOf('export const ensureApiKey')
  assert.ok(start > -1, 'ensureApiKey 必须还在（发送前那道 Key 门不许被整段删掉）')
  // 函数体 = 到下一个顶层 `export ` 为止（本文件里紧跟其后的是 ensureSendPrerequisites 的注释块，
  // 注释已在 codeOf() 去掉，所以这个切法是稳的）
  const rest = code.slice(start)
  const next = rest.indexOf('\nexport ', 1)
  const body = next > -1 ? rest.slice(0, next) : rest
  assert.equal(
    body.includes('openSettings('),
    false,
    'ensureApiKey 是「发送时拦下 + 提示」，不许在函数体里 openSettings（那就是自动弹设置）'
  )
  // 拦下就必须有**可见**提示：toast 是被拦之后唯一的出口，删了它等于静默失败
  assert.match(body, /showToast\(/u, '三种拦下状态都必须走 showToast（否则用户点了发送什么都不发生）')
})

// ------------------------------------------------------------------ [3] 调用点都在事件处理器里

test('[3] 全仓 ensureApiKey( 的调用点都在事件处理器 / 发送路径，无一落在 useEffect 内', () => {
  const offenders = []
  const filesWithCalls = []
  for (const file of srcFiles()) {
    const code = codeOf(file)
    const sites = ensureApiKeyCallSites(code)
    if (sites.length === 0) {
      continue
    }
    filesWithCalls.push(file)
    const ranges = useEffectRanges(code)
    for (const at of sites) {
      const inEffect = ranges.some(([from, to]) => at > from && at < to)
      if (inEffect) {
        const line = code.slice(0, at).split('\n').length
        offenders.push(`${file}:${line}`)
      }
    }
  }
  assert.deepEqual(offenders, [], `这些调用点在 useEffect（启动 / 被动副作用）里，属于自动开弹层：${offenders}`)
  // 正向：调用点必须真的存在（否则这道门禁可以靠「全删掉」蒙过去 —— 发送路径确实需要它）
  assert.deepEqual(
    filesWithCalls.sort(),
    [
      'src/components/chatInput/ChatInput.tsx',
      'src/components/messages/AssistantMessage.tsx',
      'src/components/messages/UserMessage.tsx',
    ],
    '调用点只该在三个发送入口里（输入行 / 消息重建 / 重新生成）；多出来的就是新长出来的自动开弹层'
  )
})

// ------------------------------------------------------------------ [4] 用户点击的入口还在

test('[4] 仍存在「用户点击才打开设置」的入口（侧栏 / 消息 CTA）', () => {
  const sider = codeOf('src/components/sider/Sider.tsx')
  assert.match(
    sider,
    /onClick=\{\(\)\s*=>\s*openSettings\('general'\)\}/u,
    '侧栏的设置按钮必须还是「点了才开」：删自动弹不许误伤用户主动走的那条路'
  )
  // 消息流里的 CTA 同理（额度不足 / Key 失效）：它们是用户点的按钮，不是自动弹
  const assistant = codeOf('src/components/messages/AssistantMessage.tsx')
  assert.match(assistant, /onClick=\{\(\)\s*=>\s*openSettings\('data'\)\}/u, '消息流里的设置 CTA 要保留')
})

// ------------------------------------------------------------------ [5] 粘贴 / 拖拽附件也不许开设置

test('[5] ChatInput 的 acceptUploadFiles（粘贴 / 拖拽附件那条路）不出现 openSettings(', () => {
  const code = codeOf('src/components/chatInput/ChatInput.tsx')
  const start = code.indexOf('const acceptUploadFiles = (files: File[]) => {')
  assert.ok(start > -1, 'collectUploadFiles 必须还在（粘贴 / 拖拽这条入口不许被删）')
  const rest = code.slice(start)
  // 函数体到下一个顶层 `const ` 为止（`retryFile` 紧跟其后；注释已在 codeOf() 去掉）
  const next = rest.indexOf('\n  const ', 1)
  const body = next > -1 ? rest.slice(0, next) : rest.slice(0, 2000)
  assert.equal(
    body.includes('openSettings('),
    false,
    '粘贴 / 拖拽附件不许自动打开设置层（实测过：paste → acceptFiles ← onPaste → ensureApiKey 会弹设置）'
  )
  assert.match(body, /ensureApiKey\(\)/u, '这条路径仍然要过 Key 门（拦下 + 通知，不是静默丢弃）')
})
