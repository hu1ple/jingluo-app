// [layer: unit | 纯 Node，无浏览器无网络 | 耗时: <1s]
// GitHub issue #610（症状二）：长会话上滑后，内容/行高变化不许把阅读位置弹走。
//
// 这里只测纯计算（`src/utils/scrollAnchor.ts`）：拿「上一次提交时第一条可见行」当锚点，
// 看它在最新布局里移动了多少，再把同样的量补进 scrollTop。真实浏览器里的接线
// （layout effect / overflow-anchor / 编辑态聚焦）由 L1 用例
// `tests/integration/chat-newline-enter-610.test.mjs` 覆盖。
//
// 断言方向：
//   A 首条可见行 = 第一条「底部越过视口顶」的行（露出一像素也算）
//   B 列表为空 / 全部滚到视口上方：不取锚点（返回 null）
//   C 内容在锚点上方长高 → 需要向下补（正数）；缩短 → 向上补（负数）
//   D 锚点行自己不动 → 补 0（不许因为别人的变化乱动）
//   E 锚点行已经不在列表里（编辑截断 / 滚出挂载窗口）→ 补 0，宁可不挪
//   F 脏数据（NaN / Infinity / 缺行）→ 补 0，不抛错
import '../helpers/injected.mjs'

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('.js') && context.parentURL?.includes('/src/')) {
      const url = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
      if (existsSync(fileURLToPath(url))) return nextResolve(url.href, context)
    }
    return nextResolve(specifier, context)
  },
})

const { anchorShift, pickAnchor } = await import('../../src/utils/scrollAnchor.ts')

const row = (id, top, height) => ({ id, top, height })

test('[A] 首条可见行 = 第一条底部越过视口顶的行', () => {
  const rows = [row('a', 0, 100), row('b', 100, 100), row('c', 200, 100)]
  assert.deepEqual(pickAnchor(rows, 0), { id: 'a', top: 0 })
  assert.deepEqual(pickAnchor(rows, 150), { id: 'b', top: 100 })
  // 只剩 1px 露在视口里也算「正在看这一行」
  assert.deepEqual(pickAnchor(rows, 199), { id: 'b', top: 100 })
  // 视口正好落在下一行顶上
  assert.deepEqual(pickAnchor(rows, 200), { id: 'c', top: 200 })
})

test('[B] 空列表 / 全部滚过头 → 不取锚点', () => {
  assert.equal(pickAnchor([], 0), null)
  assert.equal(pickAnchor([row('a', 0, 100)], 100), null)
  assert.equal(pickAnchor([row('a', 0, 100)], 5000), null)
  // scrollTop 是负数（iOS 橡皮筋）时按 0 算
  assert.deepEqual(pickAnchor([row('a', 0, 100)], -40), { id: 'a', top: 0 })
})

test('[C] 锚点上方内容长高 / 缩短 → 给出对应的补偿量', () => {
  const before = [row('a', 0, 100), row('b', 100, 100)]
  const anchor = pickAnchor(before, 100)
  assert.deepEqual(anchor, { id: 'b', top: 100 })
  // a 变成 160（上方长高 60）：b 被顶下去 60 → scrollTop 要 +60
  assert.equal(anchorShift(anchor, [row('a', 0, 160), row('b', 160, 100)]), 60)
  // a 变成 40（上方缩短 60）：b 上移 60 → scrollTop 要 -60
  assert.equal(anchorShift(anchor, [row('a', 0, 40), row('b', 40, 100)]), -60)
})

test('[D] 锚点行自己没动 → 不补偿（别人的变化不许引起跳动）', () => {
  const before = [row('a', 0, 100), row('b', 100, 100), row('c', 200, 300)]
  const anchor = pickAnchor(before, 100)
  // 只有下面的 c 长高：b 的位置没变
  assert.equal(anchorShift(anchor, [row('a', 0, 100), row('b', 100, 100), row('c', 200, 900)]), 0)
})

test('[E] 锚点行不在了（编辑截断 / 滚出挂载窗口）→ 不补偿', () => {
  const anchor = { id: 'gone', top: 100 }
  assert.equal(anchorShift(anchor, [row('a', 0, 100), row('b', 100, 100)]), 0)
  assert.equal(anchorShift(null, [row('a', 0, 100)]), 0)
})

test('[F] 脏数据不抛错也不乱挪', () => {
  assert.equal(anchorShift({ id: 'a', top: 0 }, [row('a', Number.NaN, 100)]), 0)
  assert.equal(anchorShift({ id: 'a', top: 0 }, [row('a', Number.POSITIVE_INFINITY, 100)]), 0)
  assert.equal(pickAnchor([row('a', Number.NaN, 100), row('b', 100, 100)], 0)?.id, 'b')
  assert.equal(pickAnchor([row('a', 0, Number.NaN)], 0), null)
  assert.equal(pickAnchor([row('a', 0, 100)], Number.NaN)?.id, 'a')
})

/* ------------------------------------------------------------------ 钳位修复（A 视口坐标 + B 记账） */
//
// 病根（#610 症状二的第二层）：收起思考块让 scrollHeight 变短，浏览器把 scrollTop **静默**
// 钳到新的 maxScrollTop，被吞掉的位移（下面记作 clampLoss）没有任何 setter 调用、也没有人记账。
// 而锚点校正是「在当前 scrollTop 上叠加内容坐标增量」，对钳位完全无感 —— 钳位丢多少，
// 落点就永久错多少（390×844 实测：D=1000 → −225、D=400 → −825、D=120 → −1730）。
//
// 修法：
//   A 锚点除了内容坐标，再记一行**视口坐标**（该行顶部相对滚动视口顶的偏移）。校正时用
//     「现在这一行的视口 top − 当时记下的视口 top」，钳位已经把这一行在视口里挪走了，
//     差值天然包含它 → 落点自动正确；没有钳位时该式恒等于内容坐标增量（现值不变）。
//   B 记账兜底：算得出 clampLoss 时把它记在账上（量不到锚点行时直接当 shift 用），
//     目标值夹到 [0, maxScrollTop]；夹不掉的那一截（欠账 owed）留到后面有内容了再付。
//
// 「不许重复补偿」的判据：A 与 B 是**互斥**的两条路 —— 量到锚点行就用 A（此时 clampLoss
// 只记录不叠加，因为视口差里已经含了它），量不到才用 B。下面的 [K] 钉住这条。

const { anchorShiftViewport } = await import('../../src/utils/scrollAnchor.ts')

/** 视口快照：行顶相对滚动视口顶的偏移 + 记录时的 scrollTop */
const vAnchor = (id, top, scrollTop, viewportTop) => ({ id, top, scrollTop, viewportTop })

test('[G] 没有钳位时视口公式退化成内容坐标（现值不许变）', () => {
  // b 的内容 top 从 100 变成 160（上方 a 长高 60），scrollTop 没动、max 也没顶到
  const anchor = vAnchor('b', 100, 100, 0)
  const plan = anchorShiftViewport({
    anchor,
    rows: [row('a', 0, 160), row('b', 160, 100)],
    scrollTop: 100,
    maxScrollTop: 5000,
  })
  assert.equal(plan.shift, anchorShift(anchor, [row('a', 0, 160), row('b', 160, 100)]))
  assert.equal(plan.shift, 60, '无钳位时 A 与内容坐标逐位相同')
  assert.equal(plan.target, 160)
  assert.equal(plan.clampLoss, 0)
  assert.equal(plan.owed, 0)
  assert.equal(plan.source, 'viewport')
})

test('[H] 钳位：被浏览器吞掉的位移由视口差自动补回（不是叠加，是包含）', () => {
  // 390×844 实测形状（D=400 那档）：展开后 st=2000，收起时内容缩短 1225，
  // 新的 max 只有 1500 → 浏览器静默把 st 从 2000 钳到 1500（吞掉 500）。
  const contentShift = -1225
  const anchor = vAnchor('x', 2300 + contentShift + 1225, 2000, 300) // top=2300 时 vtop=300
  const rows = [row('x', 2300 + contentShift, 700)]
  const plan = anchorShiftViewport({ anchor, rows, scrollTop: 1500, maxScrollTop: 1500 })
  assert.equal(plan.clampLoss, 500, '记账：上一帧 2000 − 现在 1500')
  assert.equal(plan.shift, contentShift + 500, '视口差 = 内容位移 + 钳位量（−725）')
  assert.equal(plan.target, 775, '落点 = 记录时 st + 内容位移，钳位那段不再白丢')
  // 旧实现（纯内容坐标）会写成 −1225 → 落点 275，正好丢掉一个钳位量
  assert.equal(anchorShift(anchor, rows), contentShift)
  assert.equal(1500 + anchorShift(anchor, rows), 275, '这就是修复前 −500 的来源')
  assert.equal(plan.source, 'viewport')
  assert.equal(plan.owed, 0)
})

test('[I] 目标超出新 max 时夹到 max，并把夹掉的差额记成欠账', () => {
  // 流式自动收起实测形状（390×844 发一条新消息、思考块自动收起那一帧）：
  // 记录时 st=1000、锚点行顶在视口顶（vtop=0）；内容缩短后该行内容位移 −765，
  // 浏览器把 st 钳到新 max=181 —— 想去的 235 在内容之外 → 先记欠账，等正文长出来再付。
  const anchor = vAnchor('x', 1000, 1000, 0)
  const plan = anchorShiftViewport({
    anchor,
    rows: [row('x', 235, 700)],
    scrollTop: 181,
    maxScrollTop: 181,
  })
  assert.equal(plan.clampLoss, 819, '账单：1000 − 181')
  assert.equal(plan.shift, 0, '目标 235 被 max=181 夹住 → 这一帧写不动，但差额不许丢')
  assert.equal(plan.target, 181)
  assert.equal(plan.owed, 54, '夹掉的 54px 记账，等有内容再付')
})

test('[M] 欠账在后续帧付清（内容长出来才付，付清即归零）', () => {
  const paid = anchorShiftViewport({
    anchor: null,
    rows: [],
    scrollTop: 181,
    maxScrollTop: 340,
    owed: 54,
  })
  assert.equal(paid.shift, 54, '有空间就把欠账补上')
  assert.equal(paid.target, 235)
  assert.equal(paid.owed, 0, '付清归零，不许无限期拖着')

  const notYet = anchorShiftViewport({
    anchor: null,
    rows: [],
    scrollTop: 181,
    maxScrollTop: 190,
    owed: 54,
  })
  assert.equal(notYet.shift, 9, '空间只有 9px 就先付 9px')
  assert.equal(notYet.owed, 45, '剩下的继续欠着')
})

test('[J] 用户自己滚动（位置变化无法归因钳位）→ 退回内容坐标，不许把用户拽回去', () => {
  // 上一帧 st=2000，用户滚到了 1600，max 一直是 5000（内容没缩短）→ 这不是钳位
  const anchor = vAnchor('x', 2300, 2000, 300)
  const rows = [row('x', 2175, 700)]
  const plan = anchorShiftViewport({ anchor, rows, scrollTop: 1600, maxScrollTop: 5000 })
  assert.equal(plan.source, 'content', '不能归因于钳位就退回内容坐标')
  assert.equal(plan.shift, -125, '只补内容位移，绝不补那 400px 的用户滚动')
  assert.equal(plan.clampLoss, 0)
})

test('[K] 有用户手势 / 量不到锚点行时才走记账兜底，两条路不叠加（不许 double-count）', () => {
  const rows = [row('x', 235, 700)]
  const anchor = vAnchor('x', 1000, 1000, 0)
  // ① A 生效时：clampLoss 只记录；若再把它加进 shift 就等于补偿两次
  const viewport = anchorShiftViewport({ anchor, rows, scrollTop: 181, maxScrollTop: 181 })
  assert.equal(viewport.source, 'viewport')
  assert.notEqual(
    viewport.shift,
    anchorShift(anchor, rows) + viewport.clampLoss,
    'A 的 shift 里已经含了钳位量，不许再加一次'
  )
  // ② 有手势 → 不用视口快照（旧锚点可能已被用户滚动作废），退内容坐标，clampLoss 也不计
  const gesture = anchorShiftViewport({ anchor, rows, scrollTop: 100, maxScrollTop: 181, userMoved: true })
  assert.equal(gesture.source, 'content')
  assert.equal(gesture.clampLoss, 0)
  assert.equal(gesture.owed, 0)
  // ③ 量不到锚点行（滚出挂载窗口）→ 只有记账可用：补回被吞掉的量
  const gone = anchorShiftViewport({ anchor, rows: [], scrollTop: 100, maxScrollTop: 181 })
  assert.equal(gone.source, 'clamp')
  assert.equal(gone.shift, 81, '兜底：上一帧 1000 现在只有 100 → 补 900，但被 max 夹到 181')
  assert.equal(gone.owed, 819, '夹不掉的部分继续记着')
})

test('[N] 缺视口快照（老锚点）/ 脏数据：不许乱挪，也不许抛错', () => {
  const rows = [row('x', 235, 700)]
  // 老形状 {id, top}：没有 viewportTop/scrollTop → 只能退回内容坐标
  const legacy = anchorShiftViewport({ anchor: { id: 'x', top: 1000 }, rows, scrollTop: 1000, maxScrollTop: 5000 })
  assert.equal(legacy.source, 'content')
  assert.equal(legacy.shift, -765)
  assert.equal(legacy.clampLoss, 0)

  const dirty = anchorShiftViewport({
    anchor: vAnchor('x', Number.NaN, Number.NaN, Number.NaN),
    rows,
    scrollTop: Number.NaN,
    maxScrollTop: Number.NaN,
  })
  assert.equal(dirty.shift, 0, '脏数据不补偿')
  assert.equal(dirty.target, 0)

  // 负 max（内容比视口还短）时按 0 处理，不许出现负坐标
  const short = anchorShiftViewport({ anchor: vAnchor('x', 100, 100, 0), rows: [row('x', 50, 700)], scrollTop: 0, maxScrollTop: -20 })
  assert.equal(short.target, 0)
})
