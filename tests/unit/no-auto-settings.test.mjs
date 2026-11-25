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

// ================================================================== [6]-[8] 最后一条自动打开
//
// 上一轮（0b22d4fa）删掉的是 `ensureApiKey` 那条（Key 缺 / 格式错 / 未领取）。
// 产品原话（2026-11-25）：「地址/模型填错也没有必要自动打开设置，**压根不需要什么自动打开设置的操作**」
// 于是 `ensureSendConfig`（#490）里最后一处 `openSettings('account')` 同样删掉：
// 拦截仍然发生（toast 点名是哪一项 + 请求数 0 + `sendConfigBlocked` 红字），但**进设置是用户点按钮**。
//
// [6] 只管那一个函数；[7] 把口径放大到全仓每一条 `openSettings(`（防「换个地方又长出一条自动弹」）；
// [8] 是本文件的负向对照 —— 把 `openSettings(` 移到 toast 外，判定逻辑必须变红（否则 [6][7] 是空断言）。

/** 花括号配对（跳过字符串字面量）：返回与 `from` 处那个 `{` 配对的 `}` 下标，找不到返回 -1 */
const matchBrace = (code, from) => {
  let depth = 0
  let quote = null
  for (let i = from; i < code.length; i += 1) {
    const ch = code[i]
    if (quote !== null) {
      if (ch === '\\') {
        i += 1
      } else if (ch === quote) {
        quote = null
      }
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
      continue
    }
    if (ch === '{') {
      depth += 1
    } else if (ch === '}') {
      depth -= 1
      if (depth === 0) {
        return i
      }
    }
  }
  return -1
}

/** 所有 `const NAME = (...) => { ... }` 的具名箭头函数体区间（name + 花括号下标） */
const namedArrowBodies = (code) => {
  const out = []
  const re = /const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:\([^()]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{/gu
  let match = re.exec(code)
  while (match !== null) {
    const braceAt = match.index + match[0].length - 1
    const end = matchBrace(code, braceAt)
    if (end > braceAt) {
      out.push({ name: match[1], from: braceAt, to: end })
    }
    match = re.exec(code)
  }
  return out
}

/**
 * 某个标识符除了定义之外，是否**只**以 `run: 名字` 的形式出现。
 *
 * 这就是「这个 helper 只会被用户点一次」的机械判据：一旦有人在别处 `someHelper(...)` 直接调用，
 * 或者 `const alias = openSettingsFromHint` 另存一份，这里立刻返回 false，[7] 跟着红。
 */
const onlyUsedAsToastAction = (code, name) => {
  const re = new RegExp(`(?<![\\w$.])${name.replace(/\$/gu, '\\$')}(?![\\w$])`, 'gu')
  let total = 0
  let asAction = 0
  let match = re.exec(code)
  while (match !== null) {
    total += 1
    const before = code.slice(0, match.index)
    if (!/const\s+$/u.test(before)) {
      // 不是定义行：必须紧跟在 `run:` 后面（`run: openSettingsFromHint`）
      if (!/run:\s*$/u.test(before)) {
        return false
      }
      asAction += 1
    }
    match = re.exec(code)
  }
  return total > 0 && asAction > 0
}

/**
 * 一处 `openSettings(` 的形态分类（`codeOf()` 去掉注释后的代码上跑）：
 *
 *  · `run-arrow`：`{ action: { key: '…', run: () => openSettings('account') } }` —— 内联箭头；
 *  · `helper:名字`：调用点落在某个具名 helper 里，而那个 helper **只在 `run:` 位置出现**
 *    （`openSettingsFromHint` 就是这个 helper；测试自己算出来，不写死名字）；
 *  · `onclick`：组件的 `onClick={() => …}` / 更新弹层的 `onClick: () => { … }`；
 *  · `none`：以上都不是 —— 也就是「没人点它，它自己开」= 违规。
 *
 * 三种合法形态都用**锚定式**正则（`^\s*…$`）卡住「调用点与触发点之间不许隔着别的语句」：
 * 一行注释绕不过去（注释在 `codeOf()` 里已经被删掉），`run: x; openSettings(…)` 这种拼接也绕不过去
 * （中间那段不是纯箭头开头，正则不匹配）。
 */
const classifyOpenSettingsSite = (code, at) => {
  const before = code.slice(Math.max(0, at - 600), at)
  const runAt = before.lastIndexOf('run:')
  if (runAt > -1 && /^\s*(\([^()]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{?\s*$/u.test(before.slice(runAt + 4))) {
    return 'run-arrow'
  }
  for (const body of namedArrowBodies(code)) {
    if (at > body.from && at < body.to && onlyUsedAsToastAction(code, body.name)) {
      return `helper:${body.name}`
    }
  }
  const label = [...before.matchAll(/onClick\s*[:=]/gu)].pop()
  if (label !== undefined) {
    const between = before.slice((label.index ?? 0) + label[0].length)
    // `{ () => openSettings(…) }` / `: () => { …; openSettings(…) }`：箭头到调用点之间不许出现 `}`
    if (/^\s*\{?\s*\(\)\s*=>\s*\{?[^}]*$/u.test(between)) {
      return 'onclick'
    }
  }
  return 'none'
}

/** 代码里每一处 `openSettings(` 的位置（`export const openSettings = (` 不含 `(` 紧跟，不会被误捕） */
const openSettingsSites = (code) => {
  const sites = []
  for (let at = code.indexOf('openSettings('); at >= 0; at = code.indexOf('openSettings(', at + 1)) {
    sites.push({ at, line: code.slice(0, at).split('\n').length, kind: classifyOpenSettingsSite(code, at) })
  }
  return sites
}

const DIALOG_STATE = 'src/components/settings/settingsDialogState.ts'

// ------------------------------------------------------------------ [6] ensureSendConfig 不再开设置

test('[6] ensureSendConfig 函数体内不出现 openSettings(（#490 那条也改成「用户点按钮」）', () => {
  const code = codeOf(DIALOG_STATE)
  const start = code.indexOf('export const ensureSendConfig')
  assert.ok(start > -1, 'ensureSendConfig 必须还在（地址 / 模型那道门不许被整段删掉）')
  const rest = code.slice(start)
  const next = rest.indexOf('\nexport ', 1)
  const body = next > -1 ? rest.slice(0, next) : rest
  assert.equal(
    body.includes('openSettings('),
    false,
    'ensureSendConfig 是「发送时拦下 + 提示」，函数体里不许 openSettings（那就是地址/模型填错也自动弹设置）'
  )
  // 拦下就必须有**可见**入口：toast 上挂「打开设置」，点了才进 —— key 与 helper 都复用既有那两个
  assert.match(body, /showToast\(/u, '拦下必须走 showToast（否则用户点了发送什么都不发生）')
  assert.match(
    body,
    /action:\s*\{\s*key:\s*'openSettingsEntry',\s*run:\s*openSettingsFromHint\s*\}/u,
    'toast 上要挂「打开设置」（复用 `openSettingsEntry` + `openSettingsFromHint`，不许新造一套）'
  )
  // marker 留着：设置页那一行的红字靠它，与「设置是怎么被打开的」无关
  assert.match(
    body,
    /setState\(\{\s*sendConfigBlocked:/u,
    'sendConfigBlocked 仍要被设置（ApiConfigFields 的地址 / 模型行红字读它）'
  )
  assert.match(body, /recordConfigRejection\(/u, '留痕保留：recordConfigRejection')
  assert.match(body, /recordAction\('nav', 'block-send-invalid-config'/u, '留痕保留：recordAction')
})

// ------------------------------------------------------------------ [7] 全仓：只许「点了才开」

test('[7] 全仓 openSettings( 只出现在 run: 回调 / onClick 里（含 settingsDialogState.ts 的 helper）', () => {
  const offenders = []
  const classified = []
  for (const file of srcFiles()) {
    const code = codeOf(file)
    for (const site of openSettingsSites(code)) {
      classified.push(`${file}:${site.line} → ${site.kind}`)
      if (site.kind === 'none') {
        offenders.push(`${file}:${site.line}`)
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `这些 openSettings( 既不在 toast 的 run: 回调里、也不在组件 onClick 里（= 没人点也会自动开设置）：${offenders}`
  )
  // 正向：真的扫到了东西（否则「全删光」也能让上面那行绿），且 settingsDialogState.ts 里至少一处
  assert.ok(classified.length >= 4, `全仓至少这几处该存在，实际只扫到 ${classified.length} 处`)
  assert.ok(
    classified.some((entry) => entry.startsWith(DIALOG_STATE)),
    'settingsDialogState.ts 里必须还有「用户点了才开」的那条路径'
  )
  // 别名绕过（`const alias = openSettings` / `openSettings.call(...)`）在这里被单独堵住：
  // 标识符 `openSettings` 只允许两种出现 —— 定义行与调用（后面紧跟 `(`）
  const bare = [...codeOf(DIALOG_STATE).matchAll(/\bopenSettings\b(?!\s*\()/gu)]
    .filter((match) => !/const\s+$/u.test(codeOf(DIALOG_STATE).slice(0, match.index)))
    .map((match) => codeOf(DIALOG_STATE).slice(0, match.index).split('\n').length)
  assert.deepEqual(bare, [], `settingsDialogState.ts 里不许把 openSettings 另存别名再调（行号：${bare}）`)
})

// ------------------------------------------------------------------ [8] 负向对照：判定器真的会红

test('[8] 负向对照：把 openSettings( 挪到 toast 外 / 塞进注释以外的别处，判定器必须判红', () => {
  /**
   * 这一段是本文件的**自检**：判定器（`classifyOpenSettingsSite`）不是在「只要有 openSettings( 就放行」。
   * 每条反例都必须落到 `none`；正向样例必须落到 `run-arrow` / `helper:` / `onclick`。
   * 没有这一段，[6][7] 可能哪天被改成一个永远为真的匹配，而没人发现。
   */
  const SELF_CASES = [
    {
      label: '反例：自动打开（toast 之后单独一行裸调用）',
      code: `showToast({ key: 'sendBlockedModelEmpty' })\nopenSettings('account')\n`,
      want: 'none',
    },
    {
      label: '反例：写成 sendConfigBlocked 那一行的前面也一样（裸语句）',
      code: `useSettingsDialog.setState({ sendConfigBlocked: 'model_empty' })\nopenSettings('account')\n`,
      want: 'none',
    },
    {
      label: '反例：假 helper（两处引用，其中一处不是 run:）',
      code: `const helper = () => {\n  openSettings('account')\n}\nhelper()\n`,
      want: 'none',
    },
    {
      label: '反例：run: 之外拼接调用（`run: f; openSettings(…)` 这种两段式）',
      code: `showToast({ key: 'x' }, { action: { key: 'openSettingsEntry', run: f } })\nopenSettings('account')\n`,
      want: 'none',
    },
    {
      label: '反例：onClick 已经闭合，再裸调用',
      code: `const view = () => <button onClick={() => {}}>x</button>\nopenSettings('account')\n`,
      want: 'none',
    },
    {
      label: '正例：toast 的内联 run: 箭头',
      code: `showToast({ key: 'x' }, { action: { key: 'openSettingsEntry', run: () => openSettings('account') } })\n`,
      want: 'run-arrow',
    },
    {
      label: '正例：只在 run: 位置出现的具名 helper',
      code: `const helper = () => {\n  openSettings('account')\n}\nshowToast({ key: 'x' }, { action: { key: 'openSettingsEntry', run: helper } })\n`,
      want: 'helper:helper',
    },
    {
      label: '正例：组件 onClick',
      code: `const view = () => <button onClick={() => openSettings('general')}>设置</button>\n`,
      want: 'onclick',
    },
  ]
  for (const item of SELF_CASES) {
    const sites = openSettingsSites(item.code)
    assert.equal(sites.length, 1, `${item.label}：样例里应当只有一处 openSettings(`)
    assert.equal(sites[0].kind, item.want, `${item.label}：判定结果`)
  }
  // 与真实源码对账：`ensureSendConfig` 里那处（改前存在的自动打开）被判 `none` —— 这是 [6] 会红的同一个判据。
  // 用「改前的样子」做一次回归样例，保证判据没有随着时间漂移。
  const OLD_ENSURE_SEND_CONFIG = `export const ensureSendConfig = () => {\n  const verdict = checkCurrentSendConfig()\n  if (verdict.ok) return true\n  showToast({ key: verdict.messageKey })\n  openSettings('account')\n  useSettingsDialog.setState({ sendConfigBlocked: verdict.code })\n  return false\n}\n`
  assert.deepEqual(
    openSettingsSites(OLD_ENSURE_SEND_CONFIG).map((site) => site.kind),
    ['none'],
    '改前那种写法（showToast 之后裸调 openSettings）必须被判 none —— 否则 [6]/[7] 抓不到回归'
  )
})
