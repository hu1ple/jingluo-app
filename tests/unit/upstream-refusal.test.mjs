// [layer: unit | 依赖: 无（纯 Node，零浏览器，不发网络请求） | 耗时: <2s]
//
// 上游**内容层拒答**的界面口径（400 + 拒答原文 → 「与你的设置无关」）。
//
// 线上现象（真实日志重放过）：一条回复显示成顶部「已停止」，下面一段**红色**提示
// 「抱歉，我无法提供关于您提问内容的建议。作为 AI 编程助手…」+「打开设置」+「复制诊断信息」。
// 根因是这段文字来自上游 newcode.work 的 **HTTP 400 拒答原文**，而 `errors.ts` 把 400 判成
// `badRequest` → `describeReply` 输出 `{action:'settings', text:<上游原文>}`：
// 一次「上游不愿回答这条内容」被我们说成「你的设置有问题」。
//
// 本用例钉住四件事：
//   ① 400 / 422 + 拒答原文（或后端给的 `upstream_refusal` code）→ `upstreamRefusal`；
//   ② 这一档的文案是**我们自己的**（不含上游原文）、**不给「打开设置」**、**给「重新生成」**
//      并保留「复制诊断信息」；
//   ③ `badRequest` 收紧：只有**真拿到字段证据**（`parseErrorField` 或点名参数层的 code）
//      才给「打开设置」，没有证据时只留诊断；
//   ④ 两处负向对照不许回归：`connection reset` 仍归 `other`、200 + 正文自己拒答仍是正文样式。
//
//   node --test tests/unit/upstream-refusal.test.mjs
//   node tests/run-layer.mjs unit --only upstream-refusal
import '../helpers/injected.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { chatStub, installTsResolve } from '../helpers/dom-env.mjs'

// 装配走公共入口（#366 / #408）：原生桥 + 诊断写入口两个替身 + `.js→.ts` 解析
installTsResolve({
  stubs: [
    [/^@capacitor\/core$/, chatStub('capacitor.mjs')],
    [/diagnostics\/collector\.js$/, chatStub('collector.mjs')],
  ],
})

globalThis.__API_ORIGIN__ = 'https://api.test.invalid'
globalThis.INTERNAL_BUILD = false
globalThis.__log = { records: [], events: [], actions: [] }

const { classifyErrorSignature, parseErrorField, UPSTREAM_REFUSAL_PATTERNS } = await import(
  '../../src/services/api/errors.ts'
)
const { describeReply } = await import('../../src/services/chat/describe.ts')
const { errorNoticeAction } = await import('../../src/services/chat/errorNotice.ts')
const { translate } = await import('../../src/i18n/index.ts')
const { useSettings } = await import('../../src/services/settings.ts')
const { pinLocale } = await import('../helpers/locale.mjs')

assert.equal(pinLocale(useSettings), 'zh-CN', '界面语言钉在中文，断言才不受 shell 的 LANG 影响')

/**
 * 把「上游回了什么」按 store 的存法落成一条 error 回复，再问界面会显示什么。
 * `localMessage` 一律不给：这里测的正是「上游报错 + 没有本地文案」那条路径。
 */
const noticeOf = ({ status, code, message }) =>
  describeReply({
    id: 'reply-refusal',
    role: 'assistant',
    createdAt: 0,
    model: null,
    prefix: false,
    status: 'error',
    blocks: [],
    error: {
      kind: 'http',
      message,
      ...(typeof status === 'number' ? { status } : {}),
      ...(code ? { upstreamCode: code } : {}),
    },
  })

/** 线上那条拒答原文（只截短，措辞照抄） */
const UPSTREAM_CN_REFUSAL =
  '抱歉，我无法提供关于您提问内容的建议。作为 AI 编程助手，我不能帮助编写这类功能。'

test('判据常量：UPSTREAM_REFUSAL_PATTERNS 覆盖线上样本，且大小写不敏感', () => {
  assert.ok(Array.isArray(UPSTREAM_REFUSAL_PATTERNS) && UPSTREAM_REFUSAL_PATTERNS.length >= 6)
  for (const sample of [
    '抱歉，我无法提供关于您提问内容的建议',
    '作为 AI 编程助手，我不能……',
    'SENSITIVE_WORDS_DETECTED',
    'User sensitive words detected',
    "I can't respond to this question right now",
    'We cannot respond to this question',
    "I'm unable to provide that",
    'unable to help with that',
  ]) {
    assert.ok(
      UPSTREAM_REFUSAL_PATTERNS.some((pattern) => pattern.test(sample)),
      `没命中：${sample}`
    )
  }
})

test('① 400 + 中文拒答原文：判 upstreamRefusal，界面换成我们自己的文案，不给「打开设置」', () => {
  const upstream = { status: 400, code: 'upstream_error', message: UPSTREAM_CN_REFUSAL }
  assert.equal(classifyErrorSignature(upstream), 'upstreamRefusal', '400 + 拒答原文必须判 upstreamRefusal')

  const notice = noticeOf(upstream)
  assert.ok(notice, '必须给出一条提示')
  // 文案是我们自己的那一句（不是上游原文）
  assert.equal(notice.text, translate('replyUpstreamRefusal'))
  assert.doesNotMatch(notice.text, /作为 AI 编程助手/, '上游原文不许进主文案')
  assert.doesNotMatch(notice.text, /无法提供关于您提问内容/, '上游原文不许进主文案')
  // 关键：不给「打开设置」（这条是内容拒绝，不是配置问题）
  assert.equal(notice.action, undefined, '不许给 action:settings')
  // 「重新生成」有意义：换个说法 / 换条池子再试
  assert.equal(notice.regenerate, true)
  // 「复制诊断信息」保留：排查仍然需要
  assert.ok(notice.diagnostics, '要保留「复制诊断信息」')
  // 上游拒答原文也不进折叠区（它是内容态度，不是可排查的配置线索）
  assert.equal(notice.upstream, undefined, '不把拒答原文再糊回界面')
})

test('② 400 + code=upstream_refusal（后端同批改动给的机器可读码）：不依赖正则也判得上', () => {
  for (const code of ['upstream_refusal', 'UPSTREAM_REFUSAL', 'Upstream-Refusal']) {
    const upstream = { status: 400, code, message: 'upstream_error' }
    assert.equal(
      classifyErrorSignature(upstream),
      'upstreamRefusal',
      `code=${code} 必须直接判 upstreamRefusal（不必等方法命中正则）`
    )
    const notice = noticeOf(upstream)
    assert.equal(notice?.text, translate('replyUpstreamRefusal'))
    assert.equal(notice?.action, undefined, '不许给 action:settings')
    assert.equal(notice?.regenerate, true)
    assert.ok(notice?.diagnostics, '要保留「复制诊断信息」')
  }
})

test('③ 400 参数错但**没有任何**参数证据：仍 badRequest，且不给「打开设置」', () => {
  // 上游只说了「这个请求不行」，既没点名字段，code 也不是参数层的
  const upstream = {
    status: 400,
    code: 'invalid_request_error',
    message: 'invalid request: unsupported file type',
  }
  assert.equal(parseErrorField(upstream.message), '', '前提：这条原文解析不出字段')
  assert.equal(classifyErrorSignature(upstream), 'badRequest', '没有拒答特征，仍是参数档')

  const notice = noticeOf(upstream)
  assert.ok(notice)
  assert.equal(notice.text, translate('replyBadRequest', { status: 'HTTP 400' }))
  assert.equal(notice.action, undefined, '没有参数证据就不许给「打开设置」')
  assert.equal(notice.regenerate, false, '参数错重发不会有变化')
  assert.ok(notice.diagnostics, '「复制诊断信息」照给')
  // 中性措辞：不许替上游断言「是你的配置有问题」
  assert.doesNotMatch(notice.text, /请检查设置/, '文案不许断言用户配置有问题')
})

test('③b 上游样例「max_tokens must be > 0」其实**带**字段证据：仍给「打开设置」', () => {
  // 需求里举的这个例子 parseErrorField 会解析出 `max_tokens` —— 它有字段名，
  // 属于「指到了具体设置项」，所以按设计仍然给入口（④ 是同一件事的「引号字段」写法）。
  const message = 'max_tokens must be > 0'
  assert.equal(parseErrorField(message), 'max_tokens', '前提：这条原文确实点出了字段')
  assert.equal(classifyErrorSignature({ status: 400, code: 'invalid_parameter', message }), 'badRequest')
  assert.equal(noticeOf({ status: 400, code: 'invalid_parameter', message })?.action, 'settings')
})

test('④ 400 + invalid_parameter + 引号里的字段：仍是 badRequest，且保留「打开设置」', () => {
  const upstream = {
    status: 400,
    code: 'invalid_parameter',
    message: "Invalid 'max_tokens': must be a positive integer",
  }
  assert.equal(classifyErrorSignature(upstream), 'badRequest', '正常参数错不许被误判成拒答')
  assert.equal(parseErrorField(upstream.message), 'max_tokens')

  const notice = noticeOf(upstream)
  assert.ok(notice)
  assert.equal(notice.text, translate('replyParamInvalid', { status: 'HTTP 400', field: 'max_tokens' }))
  assert.equal(notice.action, 'settings', '有字段证据时保留原有能力')
  assert.equal(notice.regenerate, false)
  assert.ok(notice.diagnostics)
})

test('⑤ 负向对照：connection reset 仍归 other，不被误判成拒答', () => {
  assert.equal(classifyErrorSignature({ message: 'connection reset' }), 'other')
  const notice = noticeOf({ message: 'connection reset' })
  assert.ok(notice)
  assert.notEqual(notice.text, translate('replyUpstreamRefusal'), '不许拿拒答文案套网络故障')
  assert.equal(notice.action, undefined)
  assert.notEqual(notice.regenerate, false, '网络类故障要给「重新生成」')
})

test('⑥ 负向对照：200 + 正文自己拒答，仍是正文样式（不走红色错误提示）', () => {
  const notice = describeReply({
    id: 'reply-body-refusal',
    role: 'assistant',
    createdAt: 0,
    model: null,
    prefix: false,
    status: 'done',
    stopReason: 'refusal',
    blocks: [],
  })
  assert.ok(notice)
  assert.equal(notice.presentation, 'response', '正文拒答用正文样式')
  assert.equal(notice.text, translate('replyRefused'))
  assert.equal(notice.action, undefined)
})

test('⑦ 落盘了本地文案再渲染（真实界面的第二遍）：分类仍看上游原文，不退回参数档', () => {
  // 第一遍由 store 落盘 `localMessage`（我们自己的那句），第二遍 describeReply 才渲染。
  // 改前 `describeReply` 拿 `localized` 去分类 —— 上游的拒答特征已经不在了，于是退回
  // 「参数错 + 上游写了中文就照抄」那条路：文案对、但 **regenerate 变成 false**（界面上少了
  // 「重新生成」）。这条就是那个回归的护栏。
  const notice = describeReply({
    id: 'reply-refusal-second-pass',
    role: 'assistant',
    createdAt: 0,
    model: null,
    prefix: false,
    status: 'error',
    blocks: [],
    error: {
      kind: 'http',
      status: 400,
      message: UPSTREAM_CN_REFUSAL,
      upstreamCode: 'upstream_error',
      localMessage: { key: 'replyUpstreamRefusal' },
    },
  })
  assert.ok(notice)
  assert.equal(notice.text, translate('replyUpstreamRefusal'))
  assert.equal(notice.action, undefined, '第二遍渲染也不许长出「打开设置」')
  assert.equal(notice.regenerate, true, '「重新生成」不许因为第二遍渲染而消失')
  assert.ok(notice.diagnostics)
})

test('表驱动：upstreamRefusal 那一行就是「无入口 + 可重新生成 + 有诊断」', () => {
  assert.equal(
    errorNoticeAction({ condition: 'upstreamRefusal', status: 400 }),
    undefined,
    '表格里这一行不许带任何操作入口'
  )
  // 对照：有字段证据的 badRequest 仍然有入口（收紧不等于砍掉能力）
  assert.equal(
    errorNoticeAction({ condition: 'badRequest', status: 400, field: 'max_tokens' }),
    'settings'
  )
  assert.equal(
    errorNoticeAction({ condition: 'badRequest', status: 400, upstreamCode: 'missing_required_parameter' }),
    'settings',
    '点名参数层的 code 也算证据'
  )
  assert.equal(
    errorNoticeAction({ condition: 'badRequest', status: 400, upstreamCode: 'invalid_request_error' }),
    undefined,
    'invalid_request_error 是官方端点所有 400 的通用 type，不算证据'
  )
})
