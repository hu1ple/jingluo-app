// [layer: unit | 依赖: 无（纯 Node，零浏览器，不发网络请求） | 耗时: <1s]
//
// Issue #339 的第三次修复：`modelInvalid` 文案必须**可诊断**。
//
// 原来的文案只说「请在设置里换一个模型」——而官方渠道的模型是内置的，设置页连模型行都没有
// （fields: ['apiKey']，setModel 拒写）。于是用户看到一句让他去做做不到的事的话，唯一出路
// 是手工改 localStorage。现在文案里带上：
//   ① 实际发出的模型名（reply.model 快照，正是诊断里一直记着、但界面没摆出来的那个值）
//   ② 上游自己给的可用模型列表（parseSupportedModels 从原文解析，不硬编码白名单）
//   ③ 内置渠道「设置里没有这一行，升级到已修复版本即可」的出路说明
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

test('modelInvalid 文案：**不显示模型名**，但出路与可诊断性都不丢', () => {
  const notice = describeReply(replyOf({ model: 'deepseek-v4.1-flash' }))
  assert.ok(notice, 'modelInvalid 必须给出一条提示')
  /**
   * 2026-11-24 产品再次定调：**界面不暴露模型名**（内部模型号对用户没有意义，还会造成
   * 「我根本没选过这个模型」的困惑）。所以 `replyModelInvalid` 现在一个占位符都没有，
   * 原来 #339 的「必须可诊断」改由两处保证，**不是丢掉**：
   *   · 出路 → `action: 'settings'`（换模型只能去设置）
   *   · 诊断 → 「复制诊断信息」里的上游原文仍带实际模型名
   */
  assert.doesNotMatch(notice.text, /deepseek-v4\.1-flash/, '界面不许显示模型名')
  assert.equal(notice.action, 'settings', '出路是去设置里换模型')
  /**
   * 2026-11-24 文案定稿：这一档换成「哼哼，我已经把「{model}」赶走啦！你只许找我！(*¯︶¯*)」，
   * 只保留 {model} 这一个占位符 —— 定稿句子不再列「上游可用模型：{models}」、也不再写
   * 「内置模型 / 不要重试」。**行为口径没变**，且各有独立断言兜着：
   *   · 不可重试 → 下面的「模型不存在仍然不可重试」用例（`isRetryableApiError === false`）；
   *   · 档位归属 → `chat/errorNotice.ts` 表 + 本文件顶部的分类用例；
   *   · 上游原文里的可用列表仍被解析（`parseSupportedModels` 用例）。
   */
  assert.doesNotMatch(notice.text, /\{model\}|\{models\}/, '占位符必须都被替换掉')
  assert.equal(notice.diagnostics, undefined, '已识别的场景不需要额外诊断文本')
})

test('modelInvalid 文案：回复里没有模型快照时文案也不受影响', () => {
  const notice = describeReply(replyOf({ model: null }))
  assert.equal(notice.text, describeReply(replyOf({ model: 'deepseek-v4.1-flash' })).text, '有没有模型快照，界面都不变')
  assert.doesNotMatch(notice.text, /null|undefined/)
  assert.doesNotMatch(notice.text, /\{model\}/, '占位符不许漏到界面')
})

test('modelInvalid 文案：上游没给可用列表时也不显示模型名', () => {
  const notice = describeReply(
    replyOf({
      model: 'no-such-model',
      message: 'unknown model: no-such-model',
      upstreamCode: undefined,
    })
  )
  assert.doesNotMatch(notice.text, /no-such-model/, '界面不许显示模型名')
  // 2026-11-24 文案定稿后主文案里不再有 {models} 位置，`replyModelInvalidNoModels`
  // 只保留在参数与日志侧（key 仍在用，不删）；这里只钉「不许把占位符端给用户」。
  assert.doesNotMatch(notice.text, /\{model\}|\{models\}/, '占位符不许漏到界面')
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

test('zh / en 两份文案成对：占位符一一对应，且真的翻译了', () => {
  const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort()
  // 2026-11-24 产品定调：界面**不显示模型名** → 这条文案现在没有任何占位符
  assert.deepEqual(placeholders(zh.replyModelInvalid), [])
  assert.deepEqual(placeholders(en.replyModelInvalid), [])
  assert.notEqual(zh.replyModelInvalid, en.replyModelInvalid, '英文必须是另一份文案')
  for (const key of ['replyModelInvalidNoModels', 'replyModelUnknownName']) {
    assert.equal(typeof zh[key], 'string', `${key} 有中文文案`)
    assert.equal(typeof en[key], 'string', `${key} 有英文文案`)
    assert.notEqual(zh[key], en[key], `${key} 真的翻译了`)
  }
  // 渲染路径用真实 translate()，不是手写字符串：即使多传了参数也不许把模型名漏到句子里
  const rendered = translate('replyModelInvalid', { model: 'm-1', models: 'm-2' })
  assert.equal(rendered, zh.replyModelInvalid, '多传的 model/models 参数不进句子')
  assert.doesNotMatch(rendered, /m-1|m-2/)
})
