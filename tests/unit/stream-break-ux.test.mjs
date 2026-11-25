// [layer: unit | dependencies: none | no build, browser, network or Android]
//
// 断流体验（stream break UX）：**「中断」不是「报错」** —— 判定口径收成一个纯函数。
//
//   node tests/unit/stream-break-ux.test.mjs
//
// 背景：用户报「流式传输中断时前端会报错」。复现（docs/ui/streambreak-before-*.png）看到的是
// 三种断流形态**全都**渲染成红色错误条（rgb(236,19,19) + ⚠ 图标），而已收到的内容其实还在。
// 产品口径（本文件的唯一判据来源）：
//
//   1. 首字节前断开（一个字都没收到）→ **静默自动重试 1 次**，重试仍失败才给软提示 + 重新生成；
//   2. 首字节后断开（已经收到内容）→ **绝不自动重试**（会重复输出 / 重复计费），
//      内容照常保留，提示换成中性/警示色的**状态行**，不是红色报错；
//   3. idle 超时（连上了、只是不动）→ **不计入**「首字节前重试」，软提示 + 可重试；
//   4. 其余错误（鉴权 / 额度 / 参数 / 网关…）的分类与视觉**一律不变**（仍是红色报错）。
//
// 覆盖（对应任务书红绿要求 ①~⑤）：
//   ① 首字节前中断 + 未重试 → retry = true（且上限就是 1 次）
//   ② 已经重试过 → retry = false（不会无限重发）
//   ③ 首字节后已有内容 → retry = false，且模拟整轮下来不会产生第二份内容
//   ④ idle 超时 → 不计入首字节前重试（有内容 / 没内容都不自动重发）
//   ⑤ 软提示不落到红色 error 档（断流的四种组合 tone 都不是 'error'）
//   ⑥ 非断流错误口径不变（retry = false、tone 仍是 'error'）
//   ⑦ 挂载点契约：store 用本函数决定重试，describe 落 tone，AssistantMessage 按 tone 选样式
//
// 负向对照（改坏实现必须让本文件变红，实测见 PR）：
//   把 `decideStreamBreakout` 里「已收到内容不重试」那条判断删掉 → ③ 立刻红（会重发、内容重复）。
import '../helpers/injected.mjs'

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')

const {
  decideStreamBreakout,
  isStreamBreakoutKind,
  receivedCharsOf,
  streamBreakoutTone,
  STREAM_BREAK_RETRY_LIMIT,
} = await import('../../src/services/chat/streamBreakout.ts')

/**
 * 极简「整轮」模拟：用真实判定函数驱动一个只发一次的假请求循环，
 * 返回实际发了几次请求、以及这一轮最终向用户展示的正文。
 *
 * 为什么需要它：`retry = false` 只说明「不该再发」，但产品要的是
 * 「已经收到的内容不会变成两份」——那要看**整轮**跑下来正文有没有被追加第二遍。
 */
const simulateRound = ({ attempts, kind }) => {
  const shown = []
  for (let attempt = 0; ; attempt += 1) {
    if (attempt > 5) {
      throw new Error('模拟轮次失控：判定函数没有收敛（重试上限失效）')
    }
    const chunk = attempts[attempt] ?? ''
    shown.push(chunk)
    const decision = decideStreamBreakout({
      receivedChars: chunk.length,
      retried: attempt > 0,
      kind,
    })
    if (!decision.retry) {
      return { requests: shown.length, text: shown.join(''), decision }
    }
  }
}

// ---------------------------------------------------------------------------
// ① 首字节前断开 + 未重试 → 静默重试一次
// ---------------------------------------------------------------------------
test('① 首字节前断开且还没重试过 → 自动重试一次（软色调，不吓人）', () => {
  const decision = decideStreamBreakout({ receivedChars: 0, retried: false, kind: 'interrupted' })
  assert.equal(decision.retry, true, '一个字都没收到时重发是安全的，应当自动重试')
  assert.equal(decision.maxRetries, STREAM_BREAK_RETRY_LIMIT, '重试预算由常量给，不在调用点写死')
  assert.equal(STREAM_BREAK_RETRY_LIMIT, 1, '产品口径是「静默重试 1 次」：网络面板应当只有 2 次请求')
  assert.equal(decision.tone, 'soft', '这时候用户什么都没看到，提示也不该是红色报错')
})

test('① 首次断开 + 第二次成功 → 整轮只有 2 次请求，正文只有一份', () => {
  const round = simulateRound({ attempts: ['', '第一次重试就成功啦'], kind: 'interrupted' })
  assert.equal(round.requests, 2, '首发 1 次 + 静默重试 1 次')
  assert.equal(round.text, '第一次重试就成功啦', '重试成功后只展示第二份正文，不叠加')
})

// ---------------------------------------------------------------------------
// ② 已经重试过 → 不再重试
// ---------------------------------------------------------------------------
test('② 已经重试过仍失败 → 不再重发（收敛到软提示 + 重新生成）', () => {
  const decision = decideStreamBreakout({ receivedChars: 0, retried: true, kind: 'interrupted' })
  assert.equal(decision.retry, false, '重试预算用完了，必须收敛，不能无限重发')
  assert.equal(decision.tone, 'soft', '首字节前失败的终态是软提示，不是红色报错')
})

test('② 重试两次仍失败 → 整轮恰好 2 次请求（不会因为「还没内容」就一直试）', () => {
  const round = simulateRound({ attempts: ['', '', ''], kind: 'interrupted' })
  assert.equal(round.requests, 2, '首发 + 1 次重试，第三次不再发')
})

// ---------------------------------------------------------------------------
// ③ 首字节后断开（已经收到内容）→ 不重试、内容不重复
// ---------------------------------------------------------------------------
test('③ 首字节后断开 → 不自动重试（重发会答两遍、重复计费）', () => {
  const decision = decideStreamBreakout({ receivedChars: 42, retried: false, kind: 'interrupted' })
  assert.equal(decision.retry, false, '已经有内容了，绝不重发')
  assert.equal(decision.maxRetries, 0, '这一档的自动重试预算是 0')
  assert.equal(decision.tone, 'warn', '提示是中性/警示色，不是红色报错')
})

test('③ 首字节后断开 → 整轮只有 1 次请求，正文就是已经收到的那一段（不产生重复内容）', () => {
  const round = simulateRound({ attempts: ['这是已经收到的半句'], kind: 'interrupted' })
  assert.equal(round.requests, 1, '不许再发第二次')
  assert.equal(round.text, '这是已经收到的半句', '展示的正文必须只有一份')
  assert.equal(
    round.text.split('这是已经收到的半句').length - 1,
    1,
    '同一段内容不许出现两遍（重发的典型症状）'
  )
})

test('③ 任何「收到的字符数 > 0」的组合都不许重试（四种 kind 全覆盖）', () => {
  for (const kind of ['interrupted', 'idle', 'stream', 'http', 'timeout', undefined]) {
    for (const retried of [false, true]) {
      const decision = decideStreamBreakout({ receivedChars: 1, retried, kind })
      assert.equal(decision.retry, false, `kind=${kind} retried=${retried} 时不许重试`)
    }
  }
})

// ---------------------------------------------------------------------------
// ④ idle 超时不计入「首字节前重试」
// ---------------------------------------------------------------------------
test('④ idle 超时（即使一个字符都没收到）也不自动重试', () => {
  for (const receivedChars of [0, 12]) {
    const decision = decideStreamBreakout({ receivedChars, retried: false, kind: 'idle' })
    assert.equal(decision.retry, false, `receivedChars=${receivedChars}：空闲超时不是「连接断掉」`)
    assert.equal(decision.maxRetries, 0, 'idle 这一档没有自动重试预算')
  }
})

test('④ idle 超时的整轮只有 1 次请求，已收到的内容保留', () => {
  const round = simulateRound({ attempts: ['第一块'], kind: 'idle' })
  assert.equal(round.requests, 1)
  assert.equal(round.text, '第一块')
})

// ---------------------------------------------------------------------------
// ⑤ 软提示不落到红色 error 档
// ---------------------------------------------------------------------------
test('⑤ 断流四种组合的 tone 都不是 error（红色只留给真错误）', () => {
  for (const kind of ['interrupted', 'idle']) {
    for (const receivedChars of [0, 30]) {
      for (const retried of [false, true]) {
        const { tone } = decideStreamBreakout({ receivedChars, retried, kind })
        assert.notEqual(tone, 'error', `kind=${kind} 收到 ${receivedChars} 字 retried=${retried} 不该是红色报错`)
        assert.ok(tone === 'soft' || tone === 'warn', `tone 只能是 soft / warn，实际 ${tone}`)
      }
    }
  }
})

test('⑤ 「一个字都没收到」一律比「已经收到内容」更软（status 行 vs 警示行）', () => {
  const before = decideStreamBreakout({ receivedChars: 0, retried: true, kind: 'interrupted' })
  const after = decideStreamBreakout({ receivedChars: 99, retried: true, kind: 'interrupted' })
  assert.equal(before.tone, 'soft')
  assert.equal(after.tone, 'warn')
})

// ---------------------------------------------------------------------------
// ⑥ 非断流错误的口径完全不变
// ---------------------------------------------------------------------------
test('⑤ 渲染入口 streamBreakoutTone 永远不吐 error（写错 kind 也兜成 warn，绝不染红）', () => {
  for (const kind of ['interrupted', 'idle', 'http', 'network', undefined]) {
    for (const receivedChars of [0, 10]) {
      const tone = streamBreakoutTone({ receivedChars, retried: true, kind })
      assert.notEqual(tone, 'error', `kind=${kind} 不该被渲染成红色报错`)
    }
  }
})

test('⑥ 鉴权 / 额度 / 参数 / 网关这类错误仍按真错误处理（不改分类）', () => {
  for (const kind of ['http', 'network', 'timeout', 'protocol', 'stream', 'upload', undefined]) {
    const decision = decideStreamBreakout({ receivedChars: 0, retried: false, kind })
    assert.equal(decision.retry, false, `kind=${kind} 的自动重试口径不由本函数决定，不能被改写`)
    assert.equal(decision.tone, 'error', `kind=${kind} 仍是红色报错`)
    assert.equal(isStreamBreakoutKind(kind), false, `kind=${kind} 不属于断流`)
  }
  for (const kind of ['interrupted', 'idle']) {
    assert.equal(isStreamBreakoutKind(kind), true, `kind=${kind} 属于断流`)
  }
})

// ---------------------------------------------------------------------------
// ⑦ 已收内容怎么数：正文 + 思考（用户看见了），工具块不算
// ---------------------------------------------------------------------------
test('⑦ receivedCharsOf 只数用户看得见的正文与思考字符', () => {
  const reply = {
    blocks: [
      { type: 'thinking', thinking: '先拆规则' },
      { type: 'text', text: '第一段' },
      { type: 'server_tool_use', id: 't1', name: 'read_url' },
    ],
  }
  assert.equal(receivedCharsOf(reply), '先拆规则'.length + '第一段'.length)
  assert.equal(receivedCharsOf({ blocks: [] }), 0)
  assert.equal(receivedCharsOf(null), 0)
  assert.equal(receivedCharsOf(undefined), 0)
})

// ---------------------------------------------------------------------------
// ⑧ 挂载点契约：三个接线点必须真的用这份判定
// ---------------------------------------------------------------------------
test('⑧ store 用本函数决定断流是否重发，并把重试预算用在提示文案上', () => {
  const store = read('../../src/services/chat/store.ts')
  assert.match(store, /decideStreamBreakout/, 'store 必须问这份判定，而不是自己再写一遍 if')
  assert.match(store, /isStreamBreakoutKind/, '断流两档的收口要有明确判据，不能靠 if 顺序碰运气')
  assert.match(store, /breakout\.maxRetries/, '「共 N 次」要用这一档自己的预算，不能照抄 #105 的 2 次')
})

test('⑧ describe 为断流两档落 tone，AssistantMessage 按 tone 选样式而不是一律红色', () => {
  const describe = read('../../src/services/chat/describe.ts')
  assert.match(describe, /tone: breakout\('/, 'describe 要把判定结果落到 Notice.tone')
  assert.match(describe, /streamBreakoutTone/, '渲染层的语气只接 soft / warn 两档，红色留给真错误')
  const view = read('../../src/components/messages/AssistantMessage.tsx')
  assert.match(view, /styles\.noticeSoft/, '软提示要有独立样式，不能再穿红色错误条')
  assert.match(view, /styles\.noticeWarn/, '警示状态行要有独立样式')
  const css = read('../../src/components/messages/AssistantMessage.module.css')
  assert.match(css, /\.noticeSoft/, '样式表里必须有 .noticeSoft')
  assert.match(css, /\.noticeWarn/, '样式表里必须有 .noticeWarn')
})
