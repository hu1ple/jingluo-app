// [layer: unit | 纯 Node，无浏览器无网络 | 耗时: <1s]
//
// Bug A（发送后列表往上跳）与 Bug B（长会话来回滚动 → `Maximum update depth exceeded`）
// 的判定方向。两条 bug 在仓库里各有一份浏览器复现（`/tmp/jump/repro3.mjs`、`repro9.mjs`），
// 但那段复现要 dev server + mock 流式上游 + 390×844 触屏，跑一次几十秒，进不了 CI；
// 所以判定本身抽成 `src/components/messages/scrollGuard.ts` 的纯函数，在这里钉死方向：
//
//   ① 反号 shift 被拒（不振荡）
//   ② 同向 shift 仍生效（收敛器不许收紧到把正常校正也吃掉）
//   ③ 居中位移 ≥1 才关贴底；<1 时保持贴底（Bug A-1）
//   ④ 已居中过就不再居中（同一轮只居中一次，Bug A-1）
//   ⑤ 陈旧 textarea（不在 editingIds / 未连接 / 没焦点）不触发滚动（Bug A-2）
//
// 断言的是**策略**，不是像素：纯函数只负责「这一帧要不要动、动多少、动完还贴不贴底」，
// 真正的 DOM 接线（layout effect / 滚动事件节流）由浏览器复现脚本验。
import '../helpers/injected.mjs'

import assert from 'node:assert/strict'
import { test } from 'node:test'

const {
  ANCHOR_SHIFT_MIN,
  ANCHOR_STREAK_MAX,
  decideAnchorCorrection,
  editorCenterPlan,
  isEditorTargetLive,
} = await import('../../src/components/messages/scrollGuard.ts')

/** 就绪态：不在贴底、没有平滑滚动在路上 */
const idle = { sticky: false, jump: false }

/* ------------------------------------------------------------------ Bug B */

test('① 反号 shift 被拒：撞上上一帧的反向位移就不再补（否则来回弹成自激）', () => {
  const flip = decideAnchorCorrection({ ...idle, shift: 168, previousShift: -168 })
  assert.equal(flip.apply, false, '上一帧补了 −168，这一帧又想补 +168 → 必须放弃')
  assert.equal(flip.shift, 0, '放弃时必须写 0，不许把 168 原样返回给调用方')
  assert.equal(flip.reason, 'sign-flip')

  // 量不同也照样判反号（168 / −170 这种非等幅振荡同样是自激）
  const flip2 = decideAnchorCorrection({ ...idle, shift: -170, previousShift: 168 })
  assert.equal(flip2.apply, false)
  assert.equal(flip2.reason, 'sign-flip')

  // 反号 = 位移方向相反且都不为零；一帧 0 之后再动不算反号
  const afterZero = decideAnchorCorrection({ ...idle, shift: 168, previousShift: 0 })
  assert.equal(afterZero.apply, true, '上一帧没补（0）→ 本帧正常校正')
  assert.equal(afterZero.reason, 'apply')

  // 真·自激序列：像 repro9 那样一帧 +168、一帧 −168 地喂 10 次，
  // 只有第一次允许落地，之后全被拒 —— 累计落地位移不许超过一个步长。
  let previousShift = 0
  let blocked = false
  let applied = 0
  let landings = 0
  for (let frame = 0; frame < 10; frame += 1) {
    const shift = frame % 2 === 0 ? 168 : -168
    const decision = decideAnchorCorrection({ ...idle, shift, previousShift, streak: frame, blocked })
    if (decision.apply) {
      applied += Math.abs(decision.shift)
      landings += 1
      previousShift = decision.shift
    } else if (decision.reason === 'sign-flip' || decision.reason === 'streak-limit') {
      // 调用方口径：一旦判自激就钉住，直到用户下一次手势（复现脚本里是 wheel / touchstart）
      blocked = true
    }
  }
  assert.equal(landings, 1, '振荡序列里只许落地 1 次（repro9 实测是 27 次，然后崩）')
  assert.equal(applied, 168, `累计落地位移应为 1 个步长，实际 ${applied}`)

  // 判过自激之后，链上后续请求（哪怕是同号）一律不补，直到用户手势重置
  const afterBlock = decideAnchorCorrection({ ...idle, shift: 168, previousShift: 168, blocked: true })
  assert.equal(afterBlock.apply, false)
  assert.equal(afterBlock.shift, 0)
  assert.equal(afterBlock.reason, 'blocked')
})

test('② 同向 shift 仍生效：收敛器不许把正常的连续校正一起吃掉', () => {
  const same = decideAnchorCorrection({ ...idle, shift: 168, previousShift: 120 })
  assert.equal(same.apply, true, '同向（都为正）必须照常校正')
  assert.equal(same.shift, 168, '生效时原样返回本帧的位移')
  assert.equal(same.reason, 'apply')

  const sameNegative = decideAnchorCorrection({ ...idle, shift: -64, previousShift: -40 })
  assert.equal(sameNegative.apply, true)
  assert.equal(sameNegative.shift, -64)

  // 首帧（还没有上一帧）也必须能校正
  const first = decideAnchorCorrection({ ...idle, shift: 12, previousShift: null })
  assert.equal(first.apply, true)
  assert.equal(first.shift, 12)
})

test('②b 反号之外的三道闸：贴底 / 平滑滚动路上 / 位移不到阈值', () => {
  assert.deepEqual(
    decideAnchorCorrection({ shift: 168, sticky: true, jump: false }),
    { apply: false, shift: 0, reason: 'sticky' }
  )
  assert.deepEqual(
    decideAnchorCorrection({ shift: 168, sticky: false, jump: true }),
    { apply: false, shift: 0, reason: 'jump' }
  )
  assert.deepEqual(
    decideAnchorCorrection({ ...idle, shift: ANCHOR_SHIFT_MIN / 2 }),
    { apply: false, shift: 0, reason: 'below-threshold' }
  )
  // 脏数据不许让调用方往 scrollTop 里写 NaN
  const dirty = decideAnchorCorrection({ ...idle, shift: Number.NaN })
  assert.equal(dirty.apply, false)
  assert.equal(dirty.shift, 0)
})

test('②c 连续校正到上限就停手（自激时写入本身会造出下一次提交，只能靠上限截断）', () => {
  const capped = decideAnchorCorrection({
    ...idle,
    shift: 168,
    previousShift: 120,
    streak: ANCHOR_STREAK_MAX,
  })
  assert.equal(capped.apply, false, `第 ${ANCHOR_STREAK_MAX + 1} 次连续校正必须停手`)
  assert.equal(capped.reason, 'streak-limit')
  assert.equal(capped.shift, 0)

  const justUnder = decideAnchorCorrection({
    ...idle,
    shift: 168,
    previousShift: 120,
    streak: ANCHOR_STREAK_MAX - 1,
  })
  assert.equal(justUnder.apply, true, '上限之内照常校正')
})

/* ------------------------------------------------------------------ Bug A */

test('③ 居中位移 ≥1 才关贴底，<1 保持贴底（Bug A-1）', () => {
  const moved = editorCenterPlan({ targetTop: 352, currentTop: 86, alreadyCentered: false })
  assert.equal(moved.shift, 266)
  assert.equal(moved.keepSticky, false, '真的要把列表挪 266px → 才允许关掉贴底')

  const tiny = editorCenterPlan({ targetTop: 100.4, currentTop: 100, alreadyCentered: false })
  assert.equal(tiny.keepSticky, true, '子像素级的位移不许把 stickyRef 打成 false')
  assert.equal(tiny.shift, 0, '不到 1px 不写 scrollTop')

  // 反方向（编辑框在上半屏，需要往下滚）同理
  const upward = editorCenterPlan({ targetTop: 300, currentTop: 700, alreadyCentered: false })
  assert.equal(upward.shift, -400)
  assert.equal(upward.keepSticky, false)

  assert.equal(
    editorCenterPlan({ targetTop: 300, currentTop: 700, alreadyCentered: true }).keepSticky,
    true
  )
})

test('④ 已居中过就不再居中：同一个编辑框只居中一次（Bug A-1 的后半句）', () => {
  const again = editorCenterPlan({ targetTop: 352, currentTop: 86, alreadyCentered: true })
  assert.equal(again.shift, 0, '这一轮已经居中过 → 不许再补一次')
  assert.equal(again.keepSticky, true, '没动列表就不许关贴底')

  // 已经在目标位置（第一次就对齐）同样是「不用动」
  const already = editorCenterPlan({ targetTop: 200, currentTop: 200, alreadyCentered: false })
  assert.equal(already.shift, 0)
  assert.equal(already.keepSticky, true)
})

test('⑤ 陈旧 textarea 不触发滚动：不在 editingIds / 未连接 / 没焦点，三条各自都要挡住', () => {
  const live = { messageId: 'u12', editingIds: ['u12'], isConnected: true, focused: true }
  assert.equal(isEditorTargetLive(live), true, '三个条件都成立才允许居中')

  // 发送后消息已退出编辑态（repro3 S4：编辑框还挂在 DOM 上，但已不是这一轮的目标）
  assert.equal(
    isEditorTargetLive({ ...live, editingIds: [] }),
    false,
    '消息已不在 editingIds 里 → 陈旧引用，不许再滚页面'
  )
  assert.equal(
    isEditorTargetLive({ ...live, editingIds: ['u8', 'u10'] }),
    false,
    'editingIds 里是别的消息 → 同样不许滚'
  )
  // 行被重挂载后旧 textarea 已脱离文档
  assert.equal(
    isEditorTargetLive({ ...live, isConnected: false }),
    false,
    'textarea 已 isConnected=false → 不许拿它的 rect 去定位'
  )
  // Android WebView「button 不抢焦点」路径的镜像：焦点跑掉了就不再居中
  assert.equal(
    isEditorTargetLive({ ...live, focused: false }),
    false,
    '焦点不在编辑框上 → 不许居中'
  )
  // Set 也接受（组件里 editingIds 是 Set）
  assert.equal(isEditorTargetLive({ ...live, editingIds: new Set(['u12']) }), true)

  // 接线口径：先判活，不活时一律「不动 + 保持贴底」
  const planFor = (target, center) =>
    isEditorTargetLive(target) ? editorCenterPlan(center) : { shift: 0, keepSticky: true }
  const stalePlan = planFor(
    { ...live, editingIds: [] },
    { targetTop: 352, currentTop: 86, alreadyCentered: false }
  )
  assert.deepEqual(stalePlan, { shift: 0, keepSticky: true }, '陈旧目标 → centerEditor 写入次数必须是 0')
})

/* ------------------------------------------------------- #610 钳位修复的收敛性 */
//
// 修复前（纯内容坐标）在钳位帧上算出来的量是这样的（390×844 实测，D=120）：
//   展开 → 补 +1850（写成功）；收起 → 浏览器先钳掉 1730，再按内容坐标补 −1850。
// 也就是说**同一对操作给出两个反号的量**，收敛器（反号即判自激）本来是拦它的；
// 但用户点标题这一下 pointerdown 会把收敛状态清账（`resetAnchorGuard`），于是没拦住，
// 而钳位损失就永久留在落点上（−1730px）。
//
// 修复后（视口坐标 + 记账）钳位帧给出的量是 −120 / +81 这类**已经把钳位算进去**的小量，
// 与前一帧不再构成「补了又弹回来」的反号序列 —— 所以收敛器**不需要放宽**（ANCHOR_SHIFT_MIN /
// ANCHOR_STREAK_MAX / 反号判据一个字都不改），钳位场景也不会被判成 sign-flip / blocked。
// 下面用真实几何把这条链走一遍，钉住「口径没被放宽、场景也不误判」。

const { anchorShiftViewport } = await import('../../src/utils/scrollAnchor.ts')

test('⑨ 钳位场景不被误判成 sign-flip / blocked，且收敛器口径没放宽', () => {
  // 390×844 / D=120 实测：收起时内容缩短 1850，浏览器把 st 9929 钳到 8199（吞 1730）
  const expandFrame = decideAnchorCorrection({ ...idle, shift: 1850, previousShift: 0, streak: 0 })
  assert.equal(expandFrame.apply, true, '展开补 +1850 照常落地')

  const clamped = anchorShiftViewport({
    // 记录时：行顶内容坐标 20000、scrollTop 9929 → 该行离视口顶 10071
    anchor: { id: 'a29', top: 20000, scrollTop: 9929, viewportTop: 10071 },
    rows: [{ id: 'a29', top: 20000 - 1850, height: 900 }],
    scrollTop: 8199,
    maxScrollTop: 8199,
  })
  assert.equal(clamped.clampLoss, 1730, '账上记着浏览器吞掉的 1730')
  assert.equal(clamped.shift, -120, '视口差 = 内容位移 + 钳位量，不再是 −1850')
  // 用户点标题 → pointerdown 清账（组件里 resetAnchorGuard），因此 previousShift 为 0
  const collapseFrame = decideAnchorCorrection({ ...idle, shift: clamped.shift, previousShift: 0, streak: 0 })
  assert.equal(collapseFrame.apply, true, '钳位帧必须放行')
  assert.notEqual(collapseFrame.reason, 'sign-flip')
  assert.notEqual(collapseFrame.reason, 'blocked')

  // 对照：旧口径（−1850）与钳位补偿（+1730）拼在一起才是真的反号自激，收敛器照旧拦
  const staleFlip = decideAnchorCorrection({ ...idle, shift: -1850, previousShift: 1730 })
  assert.equal(staleFlip.apply, false, '口径没被放宽：反号照样拒')
  assert.equal(staleFlip.reason, 'sign-flip')

  // 付欠账那一帧与它前面的位移同号 → 不触发反号
  assert.equal(decideAnchorCorrection({ ...idle, shift: 54, previousShift: 0 }).reason, 'apply')
  assert.equal(decideAnchorCorrection({ ...idle, shift: 54, previousShift: 81 }).apply, true)
})
