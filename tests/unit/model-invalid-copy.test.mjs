// [layer: unit | 依赖: 无（纯 Node，零浏览器，不发网络请求） | 耗时: <1s]
//
// `modelInvalid` 这一档的**行为口径**（Issue #339 → #324 → 2026-11-24 产品定稿）。
//
// 沿革（为什么这里的断言改过两次，而不是「原来写了什么就一直钉什么」）：
//   · #339：原来的文案只说「请在设置里换一个模型」，而官方渠道的模型是内置的、设置页连模型行都没有
//     （fields: ['apiKey']，setModel 拒写）—— 用户被指去做一件做不到的事。当时的修法是把
//     「实际发出的模型名 + 上游可用列表」摆进文案，于是本文件钉了「文案里必须有模型名」。
//   · 2026-11-24 产品定调（`fix(copy): 模型不可用的提示里不再显示模型名` / 随后的 revert 保住了文案、
//     但把断言回退了）：**界面不暴露模型名** —— 内部模型号对用户没有意义，还会造成
//     「我根本没选过这个模型」的困惑。`replyModelInvalid` 现在一个占位符都没有。
//   · 所以「可诊断」这条意图改由**行为**承担，本文件现在钉的是那三件事：
//       ① 出路：`action === 'settings'`（换模型只能去设置）；
//       ② 不泄漏：不出现模型名、不出现 `{model}` / `{models}` 这类没被替换的占位符；
//       ③ 解析能力不丢：上游原文里的可用模型列表仍被 `parseSupportedModels` 解出来（诊断侧在用）。
//     不再是「文案里必须有某个词」—— 文案是产品口径，改了文案不该红，行为变了才该红。
//
//   node tests/run-layer.mjs unit --only model-invalid-copy
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { chatStub, installTsResolve } from '../helpers/dom-env.mjs'

// 装配走公共入口（#366 / #408）：原生桥 + 诊断写入口两个替身 + `.js→.ts` 解析。
// 以前每个 chat-stubs 文件各抄一份 registerHooks + 本地 `.js→.ts` 兜底（#408 已把同族 5 个文件迁走，
// 这几个文件是同族剩下的手抄件，一起收掉）。
installTsResolve({
  stubs: [
    [/^@capacitor\/core$/, chatStub('capacitor.mjs')],
    [/diagnostics\/collector\.js$/, chatStub('collector.mjs')],
  ],
})

globalThis.__API_ORIGIN__ = 'https://api.test.invalid'
globalThis.INTERNAL_BUILD = false
globalThis.__log = { records: [], events: [], actions: [] }

const { ApiError } = await import('../../src/services/api/client.ts')
const { parseSupportedModels, isRetryableApiError } =
  await import('../../src/services/api/errors.ts')
const { describeReply } = await import('../../src/services/chat/describe.ts')
const { translate } = await import('../../src/i18n/index.ts')
const { useSettings } = await import('../../src/services/settings.ts')
const { zh } = await import('../../src/i18n/zh.ts')
const { en } = await import('../../src/i18n/en.ts')
const { pinLocale } = await import('../helpers/locale.mjs')

assert.equal(pinLocale(useSettings), 'zh-CN', '界面语言钉在中文，断言才不受 shell 的 LANG 影响')

/** 官方端点 400 原文（只截掉 request_id） */
const UPSTREAM_TEXT =
  'The supported API model names are deepseek-flash, deepseek-v4-pro, but you passed deepseek-v4.1-flash.'

const replyOf = ({
  model,
  message = UPSTREAM_TEXT,
  status = 400,
  upstreamCode = 'invalid_request_error',
}) => ({
  id: 'reply-339',
  role: 'assistant',
  createdAt: 0,
  model,
  prefix: false,
  status: 'error',
  blocks: [],
  error: { kind: 'http', message, status, upstreamCode },
})

test('parseSupportedModels：从上游原文里取出可用模型列表', () => {
  assert.deepEqual(parseSupportedModels(UPSTREAM_TEXT), ['deepseek-flash', 'deepseek-v4-pro'])
  // 结尾没有句号 / 没有「but you passed」那半句
  assert.deepEqual(
    parseSupportedModels('The supported API model names are deepseek-flash, deepseek-v4-pro'),
    ['deepseek-flash', 'deepseek-v4-pro']
  )
  // 模型名本身带点（deepseek-v4.1-flash）：句子里的句点不能把名字切坏
  assert.deepEqual(
    parseSupportedModels('supported API model names are deepseek-v4.1-flash, deepseek-flash.'),
    ['deepseek-v4.1-flash', 'deepseek-flash']
  )
  // 用 and 连接的写法
  assert.deepEqual(parseSupportedModels('The supported API model names are a-model and b-model.'), [
    'a-model',
    'b-model',
  ])
  // 脏文本 / 没有这句话 / 空值：返回空数组，界面退回「上游未提供列表」
  for (const dirty of [
    '',
    undefined,
    'model not found',
    '哼哼，我已经把「gpt-nope」赶走啦！你只许找我！(*¯︶¯*)',
    'supported API model names are',
  ]) {
    assert.deepEqual(parseSupportedModels(dirty), [], `脏文本要返回空数组：${String(dirty)}`)
  }
})

test('modelInvalid 提示：界面不显示模型名，但「出路」不丢（定稿口径）', () => {
  const notice = describeReply(replyOf({ model: 'deepseek-v4.1-flash' }))
  assert.ok(notice, 'modelInvalid 必须给出一条提示')
  /**
   * 2026-11-24 产品定调：界面**不暴露模型名**（内部模型号对用户没有意义，还会造成
   * 「我根本没选过这个模型」的困惑）。#339 的「必须可诊断」没丢，只是换了载体：
   *   · 出路 → `action: 'settings'`（换模型只能去设置；这一条就是 #339 要堵的「让他去做做不到的事」）
   *   · 诊断 → 「复制诊断信息」里的上游原文仍带实际模型名（`parseSupportedModels` 用例兜着解析能力）
   *
   * 所以这里**不钉文案里必须有某个词**：文案随产品口径改，行为变了才该红。
   */
  assert.doesNotMatch(notice.text, /deepseek-v4\.1-flash/, '界面不许显示模型名')
  assert.equal(notice.action, 'settings', '出路必须是「去设置里换模型」（#339 要堵的就是没出路）')
  assert.equal(notice.regenerate, false, '模型不存在不是「点重新生成就好」的故障')
  assert.doesNotMatch(notice.text, /\{model\}|\{models\}/, '占位符必须都被替换掉（没传参就会漏出 {model} 字样）')
  assert.equal(notice.diagnostics, undefined, '已识别的场景不需要额外诊断文本')
})

test('modelInvalid 提示：有没有模型快照，界面都一模一样（占位符真的不再参与渲染）', () => {
  // 导入的历史回复可能没有模型快照。定稿文案没有 {model} 位，所以两种情况必须给出同一句话 ——
  // 一旦有人把 {model} 加回文案却忘了传参，这里会立刻看见「未记录」或字面 `{model}` 混进界面。
  const withModel = describeReply(replyOf({ model: 'deepseek-v4.1-flash' }))
  const withoutModel = describeReply(replyOf({ model: null }))
  assert.ok(withoutModel, '没有模型快照也要有提示')
  assert.equal(withoutModel.text, withModel.text, '有没有模型快照，界面都不变')
  assert.doesNotMatch(withoutModel.text, /null|undefined/, '不许把 null / undefined 端给用户')
  assert.doesNotMatch(withoutModel.text, /\{model\}|\{models\}/, '占位符不许漏到界面')
})

test('modelInvalid 提示：上游没给可用列表时也不显示模型名（两条路径同文案）', () => {
  const notice = describeReply(
    replyOf({
      model: 'no-such-model',
      message: 'unknown model: no-such-model',
      upstreamCode: undefined,
    })
  )
  assert.ok(notice, '上游只说「unknown model」时也要有提示')
  assert.doesNotMatch(notice.text, /no-such-model/, '界面不许显示模型名')
  // `replyModelInvalidNoModels` 现在只留在参数与日志侧（key 仍在用，不删）；这里只钉「不许把占位符端给用户」。
  assert.doesNotMatch(notice.text, /\{model\}|\{models\}/, '占位符不许漏到界面')
  assert.equal(notice.action, 'settings', '出路仍必须是「去设置里换模型」')
})

test('模型不存在仍然不可重试（自动重试不会白等几轮）', () => {
  const error = new ApiError(
    'http',
    UPSTREAM_TEXT,
    400,
    undefined,
    undefined,
    'invalid_request_error'
  )
  assert.equal(isRetryableApiError(error), false)
})

test('zh / en 两份文案成对：占位符一致、真翻译了，且多传的模型参数不进句子', () => {
  const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort()
  // 2026-11-24 产品定调：界面不显示模型名 → 这条文案没有任何占位符。
  // 钉的是**两份文案的占位符必须完全一致**（少一边就会出现「中文带名字、英文漏 {model}」这种半成品），
  // 而不是钉它们必须等于某个具体列表 —— 产品要给这档加参数时，两边一起加就仍然绿。
  assert.deepEqual(placeholders(zh.replyModelInvalid), placeholders(en.replyModelInvalid), 'zh / en 的占位符必须一一对应')
  assert.deepEqual(placeholders(zh.replyModelInvalid), [], '定稿口径：这一档没有占位符（改回去要连这里一起改）')
  assert.notEqual(zh.replyModelInvalid, en.replyModelInvalid, '英文必须是另一份文案')
  for (const key of ['replyModelInvalidNoModels', 'replyModelUnknownName']) {
    assert.equal(typeof zh[key], 'string', `${key} 有中文文案`)
    assert.equal(typeof en[key], 'string', `${key} 有英文文案`)
    assert.notEqual(zh[key], en[key], `${key} 真的翻译了`)
  }
  // 渲染路径用真实 translate()，不是手写字符串：多传了参数也不许把模型名漏进句子
  // （`describeReply` 现在仍然传 model / models —— 防的是「文案改了、调用点没改」时把值漏上屏）
  const rendered = translate('replyModelInvalid', { model: 'm-1', models: 'm-2' })
  assert.equal(rendered, zh.replyModelInvalid, '多传的 model / models 参数不进句子')
  assert.doesNotMatch(rendered, /m-1|m-2/)
})
