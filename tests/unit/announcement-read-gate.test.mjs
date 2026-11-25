// [layer: unit | dependencies: none | no build, browser, network or Android]
/**
 * 公告「首次强制阅读 5 秒」的门禁 —— **纯函数**单测（零 React / 零 localStorage / 零 DOM）。
 *
 * 被测物：`src/services/announcements/readGate.ts`
 *   · `createReadTimer` / `elapsedAt` / `remainingSeconds` / `isFinished`
 *   · `needsForcedRead` / `readTimerFor` / `withFinished` / `parseReadGate`
 *
 * 这一组用例守的是**产品原话**的两条行为：
 *   1. 首次展示时 5 秒内不能关（剩余秒数 > 0 → 「知道了」disabled）；
 *   2. 切后台**不重新计时**，而且**照常计时** —— 3s 时切出去 8s 再回来，剩余是 0（可直接关），
 *      既不是 5（重来了）也不是 2（把离屏时间扣掉了）。
 *
 * 时间一律由用例**显式喂进去**（墙钟读数在真实代码里由 hook 传），
 * 所以断言里没有任何 sleep：③「5s 后」就是 `t=5000` 这个数，不是「真的等 5 秒」。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

const {
  FORCE_READ_SECONDS,
  createReadTimer,
  elapsedAt,
  remainingSeconds,
  isFinished,
  needsForcedRead,
  readTimerFor,
  withFinished,
  parseReadGate,
} = await import('../../src/services/announcements/readGate.ts')

/** 墙钟上的一个读数（毫秒）。真实实现传的是 `Date.now()`，用例里就是普通数字 */
const at = (ms) => ms

test('① 展示后 0s：剩余 5s，不允许关闭', () => {
  const timer = createReadTimer(at(0))
  assert.equal(FORCE_READ_SECONDS, 5)
  assert.equal(remainingSeconds(timer, at(0)), 5)
  assert.equal(isFinished(timer, at(0)), false)
})

test('② 展示后 3s：剩余 2s', () => {
  const timer = createReadTimer(at(0))
  assert.equal(remainingSeconds(timer, at(3000)), 2)
  assert.equal(isFinished(timer, at(3000)), false)
})

test('③ 满 5s：剩余 0，可以关闭；再往后不出现负数', () => {
  const timer = createReadTimer(at(0))
  assert.equal(remainingSeconds(timer, at(5000)), 0)
  assert.equal(isFinished(timer, at(5000)), true)
  assert.equal(remainingSeconds(timer, at(5001)), 0)
  assert.equal(remainingSeconds(timer, at(60_000)), 0)
})

test('④ 3s 时切后台、离屏 8s 再回来：剩余 0、可直接关（不是 5，也不是 2）', () => {
  const timer = createReadTimer(at(0))
  // 读到 3s
  assert.equal(remainingSeconds(timer, at(3000)), 2)
  // 后台待了 8 秒 —— 回来后墙钟是 11s，计时照走：已展示 11s > 5s
  assert.equal(elapsedAt(timer, at(11_000)), 11_000)
  assert.equal(remainingSeconds(timer, at(11_000)), 0)
  assert.equal(isFinished(timer, at(11_000)), true)
})

test('⑤ 边界：3s 时离屏 2s 回来 → 剩余 0（刚好 3+2=5）；离屏不足则仍要等', () => {
  const timer = createReadTimer(at(0))
  // 3 + 2 = 5：正好在门槛上，可以关
  assert.equal(remainingSeconds(timer, at(5000)), 0)
  // 3 + 1 = 4：还差 1 秒（离屏时间既不白送也不扣掉，就是老老实实算进去）
  assert.equal(remainingSeconds(timer, at(4000)), 1)
  assert.equal(isFinished(timer, at(4000)), false)
})

test('⑥ 反复读同一时刻 / 反复触发 visibilitychange：结果不变，且计时器不被就地改', () => {
  const timer = createReadTimer(at(0))
  const snapshot = { ...timer }
  // 同一时刻取 5 次（界面每 200ms 重绘一次就是这种情形）：结果必须一致
  for (let index = 0; index < 5; index += 1) {
    assert.equal(remainingSeconds(timer, at(2000)), 3)
  }
  // 抖动（hidden/visible 反复触发）不改变任何状态：计时器仍是同一个对象、值也没被写脏
  assert.deepEqual(timer, snapshot)
  // 时间只往前走，剩余只减不增 —— 不存在「切一下回来又变回 5」的分支
  const series = [0, 1000, 2000, 3000, 4000, 5000].map((ms) => remainingSeconds(timer, at(ms)))
  assert.deepEqual(series, [5, 4, 3, 2, 1, 0])
  // 新建的计时器是**另一个基准点**（换公告 / 重新弹才这样），互不影响
  const other = createReadTimer(at(9000))
  assert.equal(remainingSeconds(other, at(9000)), 5)
  assert.equal(remainingSeconds(timer, at(9000)), 0)
})

test('⑦ 已读完的 id：再次展示不强制（remaining = 0）', () => {
  const gate = withFinished({}, 'ann-1', 1000)
  const input = { id: 'ann-1', gate, legacyShown: true, read: true }
  assert.equal(needsForcedRead(input), false)
  assert.equal(remainingSeconds(readTimerFor(input, at(5000)), at(5000)), 0)
  // 已读门禁（不是 read 标记）单独也能挡住强制
  assert.equal(needsForcedRead({ id: 'ann-1', gate, legacyShown: true }), false)
})

test('⑧ 新 id：重新强制 5s', () => {
  const gate = withFinished({}, 'ann-1', 1000)
  const input = { id: 'ann-2', gate, legacyShown: true, read: false }
  assert.equal(needsForcedRead(input), true)
  assert.equal(remainingSeconds(readTimerFor(input, at(9000)), at(9000)), 5)
  assert.equal(remainingSeconds(readTimerFor(input, at(9000)), at(10_000)), 4)
})

test('⑨ 老数据兼容：POPUP_SHOWN 有值但没有 read-gate → 视为已读、不强制', () => {
  // 门禁键**从来没写过**（`null`）就是老用户：不许因为新逻辑突然又强制一遍
  const legacy = { id: 'ann-1', gate: null, legacyShown: true, read: false }
  assert.equal(needsForcedRead(legacy), false)
  assert.equal(remainingSeconds(readTimerFor(legacy, at(0)), at(0)), 0)
  // 全新用户（没弹过也没门禁）照常强制
  assert.equal(needsForcedRead({ id: 'ann-1', gate: null, legacyShown: false, read: false }), true)
  // 新版本已经写过门禁键（哪怕是空表）：说明是新语义的用户，老标记不再豁免
  assert.equal(needsForcedRead({ id: 'ann-1', gate: {}, legacyShown: true, read: false }), true)
})

test('parseReadGate：只认普通对象 + 有限数值，脏数据一律当空表', () => {
  assert.deepEqual(parseReadGate({ 'a': 1, 'b': 2 }), { a: 1, b: 2 })
  assert.deepEqual(parseReadGate({ 'a': 'x', 'b': Number.NaN, 'c': 3 }), { c: 3 })
  assert.deepEqual(parseReadGate(null), {})
  assert.deepEqual(parseReadGate([]), {})
  assert.deepEqual(parseReadGate('nope'), {})
})

test('withFinished：不改原表（落盘前读快照的地方不该被就地改）', () => {
  const gate = {}
  const next = withFinished(gate, 'ann-1', 1234)
  assert.deepEqual(gate, {})
  assert.deepEqual(next, { 'ann-1': 1234 })
  // 同一条重复写：后写覆盖前写，条数不变
  assert.deepEqual(withFinished(next, 'ann-1', 9999), { 'ann-1': 9999 })
})
