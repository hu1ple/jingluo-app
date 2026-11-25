// [layer: unit | 依赖: 无（纯 Node；直接 import 真代码，分享侧用内联 Capacitor 桩，不联网/不起浏览器） | 耗时: <1s]
//
// 「自定义系统提示词」上限 1000 字（#890）。
//
// 本文件的断言只钉三件口径，不抄实现输出：
//   ① **字 = Unicode 码点**，不是 UTF-16 单元。500 个 emoji 的 `.length` 是 1000，
//      按 UTF-16 算会被判超长（876 个 emoji 才 1752 单元却只占 876 字）—— 这条一定红在「按单元」上。
//   ② **截断只能按码点切**：`String.prototype.slice` 按单元切会把代理对劈成两半，产出一个孤立代理
//      （渲染成 � 、JSON 里变 U+FFFD、写库后永远修不回来）。所以截断后必须满足
//      `Array.from(text).length === 1000` 且不含孤立代理。
//   ③ **超长绝不静默截断**：存量历史数据 / 分享导入进来的超长文本，要么整体判「超长、禁保存」
//      （抽屉里由用户自己删），要么整段丢弃并打标（导入侧），不许砍成半句存下去。
//
// 桩/真代码的关系：`src/services/chat/promptLimit.ts` 是纯函数（零 import），
// 与 `PersonaDrawer.tsx` 的 textarea 共用同一组常量，所以「计数」和「maxLength」不可能各算一套。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fixtureUrl, inlineModule, installTsResolve, loadTsModule } from '../helpers/dom-env.mjs'

// 分享侧（`deepseekShare.ts`）只用到 Capacitor 的原生桥；`history/errors.ts` 用了 TS 参数属性，
// Node 的 strip-only 模式跑不了，沿用仓库既有替身（与 tests/unit/deepseek-share-import.test.mjs 同一套）。
// 注意 `./errors.js` 是**全局**说明符（`deepseekShare.ts` 与其依赖的 `schema.ts` 都 import 它），
// 所以按 parentURL 限定会漏掉 schema 那一路 —— 这里照仓库先例整体替换。
const bridge = inlineModule(`
  export const Capacitor = { isNativePlatform: () => true }
  export const CapacitorHttp = { get: options => globalThis.shareHttpGet(options) }
`)
installTsResolve({
  stubs: {
    '@capacitor/core': bridge,
    './errors.js': fixtureUrl('url-import-stubs/errors.mjs'),
  },
})

const limit = await loadTsModule('src/services/chat/promptLimit.ts')
const { PROMPT_MAX_CHARS, PROMPT_MAX_UTF16_UNITS, PROMPT_WARN_CHARS } = limit

/** 孤立代理：高代理后面没跟低代理、或低代理前面没有高代理 —— 一个合法字符串里永远不该出现 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

const emoji = (count) => '😀'.repeat(count)

test('① 1000 个中文字符合法，1001 个超长', () => {
  // 数字写死：红线是「1000」这个产品口径，不是实现里写的那个常量（常量另由 ⑦ 钉住）
  const ok = limit.inspectPrompt('字'.repeat(1000))
  assert.equal(ok.count, 1000)
  assert.equal(ok.oversized, false)
  assert.equal(ok.canSave, true)

  const over = limit.inspectPrompt('字'.repeat(1001))
  assert.equal(over.count, 1001)
  assert.equal(over.oversized, true)
  assert.equal(over.canSave, false)
})

test('② 500 个 emoji = 500 字（UTF-16 是 1000 单元）— 按字算必须合法', () => {
  const text = emoji(500)
  // 这条是整张单子的核心：同一个字符串，两种口径给出两个答案。
  assert.equal(text.length, 1000, '.length 是 1000 个 UTF-16 单元')
  assert.equal(limit.countPromptChars(text), 500, '按字（码点）只有 500')
  const state = limit.inspectPrompt(text)
  assert.equal(state.count, 500)
  assert.equal(state.oversized, false)
  assert.equal(state.canSave, true, '500 个 emoji 不该被判超长')

  // 边界另一侧：1001 个 emoji（=1001 字 / 2002 单元）才是超长
  assert.equal(limit.inspectPrompt(emoji(1001)).oversized, true)
  // 1000 个 emoji 正好在界上（2000 单元）—— 按单元算会被误判，按字算合法
  assert.equal(limit.inspectPrompt(emoji(1000)).canSave, true)
})

test('③ 粘贴超长：截断到正好 1000 码点，且不产生半个代理对', () => {
  const pasted = emoji(1200)
  const clipped = limit.truncatePromptChars(pasted)
  assert.equal(Array.from(clipped).length, 1000)
  assert.equal(clipped.length, 2000, '1000 个 emoji 是 2000 个 UTF-16 单元')
  assert.doesNotMatch(clipped, LONE_SURROGATE)

  // 切点落在代理对中间的那种输入：`'a' + 1200 个 emoji`（2401 单元 / 1201 字）。
  // 朴素 `slice(0, 1000)` 会正好劈开一个 emoji —— 这就是必须按码点切的反例。
  const mixed = 'a' + emoji(1200)
  const naive = mixed.slice(0, 1000)
  assert.match(naive, LONE_SURROGATE, '朴素 slice 会把代理对劈开（反例，证明这条断言不是白写的）')

  const safe = limit.truncatePromptChars(mixed)
  assert.equal(Array.from(safe).length, 1000)
  assert.doesNotMatch(safe, LONE_SURROGATE)
  assert.equal(safe, 'a' + emoji(999))

  // 不超长的原样返回（引用也不必变，但不能被改写）
  assert.equal(limit.truncatePromptChars('短提示词'), '短提示词')
  assert.equal(limit.truncatePromptChars(emoji(1000)), emoji(1000))
})

test('④ 首尾空白先 trim 再算长度（999 字 + 两侧空格 = 合法）', () => {
  const padded = '  \n' + '字'.repeat(999) + '  \t'
  assert.equal(padded.length, 1005)
  const state = limit.inspectPrompt(padded)
  assert.equal(state.count, 999)
  assert.equal(state.text, '字'.repeat(999), '保存的是 trim 后的正文')
  assert.equal(state.oversized, false)
  assert.equal(state.canSave, true)

  // trim 之后正好 1000 也算合法（边界不因空格偏移）
  assert.equal(limit.inspectPrompt(' ' + '字'.repeat(1000) + ' ').canSave, true)
  // 正文 1001 字，两侧补空格也救不回来
  assert.equal(limit.inspectPrompt('  ' + '字'.repeat(1001) + '  ').canSave, false)
})

test('⑤ 纯空白 = 空（允许保存，等于清空提示词）', () => {
  for (const blank of ['', '   ', '\n\n', ' \t \n ']) {
    const state = limit.inspectPrompt(blank)
    assert.equal(state.text, '')
    assert.equal(state.count, 0)
    assert.equal(state.empty, true)
    assert.equal(state.canSave, true, '全空白必须能存（存进去就是清空）')
  }
  // 未提供（老会话没有这个字段）也是空
  assert.equal(limit.inspectPrompt(undefined).empty, true)
  assert.equal(limit.inspectPrompt(null).canSave, true)
})

test('⑥ 存量超长文本：oversized=true、保存被禁、且**不被截断**', () => {
  // 历史数据 / 分享导入带进来的 1500 字
  const legacy = '字'.repeat(1500)
  const state = limit.inspectPrompt(legacy)
  assert.equal(state.oversized, true)
  assert.equal(state.canSave, false, '保存按钮必须禁用')
  assert.equal(state.count, 1500)
  // 关键：不许偷偷砍成 1000 字（用户会以为内容还在，实际已经丢了 500 字）
  assert.equal(state.text.length, 1500)
  assert.equal(state.text, legacy)

  // 用户删到 1000 就能存
  assert.equal(limit.inspectPrompt('字'.repeat(1000)).canSave, true)
  // 只删到 1001 还不行
  assert.equal(limit.inspectPrompt('字'.repeat(1001)).canSave, false)
})

test('⑦ 计数与 textarea maxLength 同源（同一模块的常量），且 maxLength 不会误伤合法值', () => {
  // `countPromptChars` 与上限来自同一个模块 —— 抽屉里不可能自己再写一个 1000
  assert.equal(PROMPT_MAX_CHARS, 1000)
  assert.equal(typeof limit.countPromptChars, 'function')
  assert.equal(PROMPT_WARN_CHARS < PROMPT_MAX_CHARS, true, '警示阈值必须在上限之内')

  // maxLength 是 **UTF-16 单元** 口径（HTML 规范如此），一个合法提示词最多 1000 字，
  // 全是星平面字符时是 2000 单元 —— 所以 maxLength 必须 ≥ 2000，否则原生截断会比业务上限更早生效，
  // 把「1000 个字」硬生生卡在 500 个 emoji 上（emoji 就被当成 2 个字了）。
  assert.equal(PROMPT_MAX_UTF16_UNITS, PROMPT_MAX_CHARS * 2)
  for (const legal of [emoji(1000), '字'.repeat(1000), 'a' + emoji(999)]) {
    assert.equal(Array.from(legal).length, 1000)
    assert.equal(legal.length <= PROMPT_MAX_UTF16_UNITS, true, '合法值必须能整段放进 textarea')
  }
  // 计数口径 = 截断口径：截断后再数一遍，正好等于上限
  assert.equal(limit.countPromptChars(limit.truncatePromptChars(emoji(5000))), PROMPT_MAX_CHARS)
})

test('⑧ 分享导入侧：超长 customSystemPrompt 整段丢弃 + 打标，不截断', async () => {
  // 纯函数口径
  assert.deepEqual(limit.importedPrompt('字'.repeat(1200)), { prompt: undefined, dropped: true })
  assert.deepEqual(limit.importedPrompt('  你好  '), { prompt: '你好', dropped: false })
  assert.deepEqual(limit.importedPrompt('字'.repeat(1000)), { prompt: '字'.repeat(1000), dropped: false })
  assert.deepEqual(limit.importedPrompt(undefined), { prompt: undefined, dropped: false })
  // 空白等于没有：不算「被丢弃」，也不写空串
  assert.deepEqual(limit.importedPrompt('   '), { prompt: undefined, dropped: false })

  // 真链路：分享 body 里带超长提示词 → 导入出来的会话没有提示词，且打了「已丢弃」标记
  const imported = [] // 记录 promptDropped，供断言
  const shareMessages = [
    {
      role: 'USER',
      message_id: 1,
      parent_id: null,
      inserted_at: 1785318372,
      status: 'FINISHED',
      thinking_enabled: false,
      search_enabled: false,
      accumulated_token_usage: 12,
      fragments: [{ type: 'REQUEST', content: '问题' }],
    },
  ]
  const readWith = async (prompt) => {
    globalThis.shareHttpGet = () => ({
      status: 200,
      data: {
        code: 0,
        data: { biz_code: 0, biz_data: { title: 'Topic', messages: shareMessages, custom_system_prompt: prompt } },
      },
    })
    const { readDeepSeekShare } = await loadTsModule('src/services/chat/history/deepseekShare.ts')
    return readDeepSeekShare('https://chat.deepseek.com/share/example123')
  }

  const dropped = await readWith('字'.repeat(1500))
  imported.push(dropped.promptDropped)
  assert.equal(dropped.customSystemPrompt, undefined, '超长提示词整段丢弃')
  assert.notEqual(dropped.customSystemPrompt, '字'.repeat(1000), '更不许截断成 1000 字存下去')
  assert.equal(dropped.promptDropped, true, '导入结果里必须标注「本该带着的提示词被丢弃」')

  const kept = await readWith('  保持简洁  ')
  assert.equal(kept.customSystemPrompt, '保持简洁')
  assert.notEqual(kept.promptDropped, true)

  delete globalThis.shareHttpGet
})
