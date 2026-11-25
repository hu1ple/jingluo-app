// [layer: unit | L1 流程级 | 依赖: 无（纯 Node + 假 source） | Issue: 连点注册 → 429 事故]
//
// **同步 in-flight 闩 + 429 冷却**（`settingsAuthCardModel.ts` 的 `submitAuthCard` + `auth/submitGuard.ts`）。
//
// 事故现场（生产，已核实）：同一 IP / 同一设备在 13:50–13:51 连点了几次注册 → 服务端 IP 限流
// 5/min（60s 冷却）→ 之后**填对验证码也被 429 挡住**。根因是提交守卫用了 React state
// （`ctx.submitting` / `busy`）：同一 tick 内连点两次，两次都读到旧值、两次都放行。
// 仓库里同一个坑有先例：`AppUpdateField` 的注释写着「`busy` 是 state：同一 tick 连点两次会都读到旧值」，
// 那次是用 ref 修的 —— 这里用同一套办法（`useRef` 闩 / 模块级闩）。
//
// 四条断言（都是纯逻辑，不需要浏览器、不需要 dev server）：
//   ① 同一 tick 连续两次调用提交入口 → **只发 1 次请求**（`calls.signUp.length === 1`）
//   ② 请求结束后再调用 → 又能发（闩会释放）
//   ③ source 抛错也要释放闩（`finally`）—— 否则一次异常就把注册按钮永久锁死
//   ④ 429 返回 → 产出「冷却」事件且**带秒数**（`Retry-After` 优先，没有就 60s），期间主按钮不可提交
//
//   node tests/unit/auth-inflight.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { setupAuthPanels } from '../helpers/auth-panels-env.mjs'

// 装 `.js → .ts` 解析 hook（必须在动态 import 被测源码之前）
const { translate } = await setupAuthPanels()

const { authCardCanSubmit, initialAuthCardState, reduceAuthCard, submitAuthCard } = await import(
  '../../src/components/consume/settingsAuthCardModel.ts'
)
const { RATE_LIMIT_FALLBACK_SECONDS, createInFlightLatch, rateLimitSecondsOf } = await import(
  '../../src/components/auth/submitGuard.ts'
)

/** 注册 tab 的一份合法输入（确认密码一致，本地校验全过 → 真会发请求） */
const registerState = () => ({
  ...initialAuthCardState('register'),
  email: 'double@click.test',
  password: 'secret123',
  confirmPassword: 'secret123',
  verifyCode: '123456',
})

/** 提交上下文：`submitting` 恒为 false —— 这正是事故里那一刻（state 还没变） */
const ctx = (over = {}) => ({
  submitting: false,
  registrationLoaded: true,
  registrationEnabled: true,
  ...over,
})

/**
 * 可控的假后端：请求挂在一个手动 resolve 的 promise 上，好让两次调用落在**同一个 tick** 里。
 *
 * `gate()` 返回 `{ reply, calls, release }`：`release(result)` 决定这一发请求的结局。
 */
const gatedSource = () => {
  const calls = { signIn: [], signUp: [], forgotPassword: [] }
  let release = () => {}
  const source = {
    signIn: async (input) => {
      calls.signIn.push(input)
      return { ok: true }
    },
    signUp: async (input) => {
      calls.signUp.push(input)
      return new Promise((resolve) => {
        release = (outcome) => resolve(outcome)
      })
    },
    forgotPassword: async (input) => {
      calls.forgotPassword.push(input)
      return { ok: true, data: undefined }
    },
  }
  return { calls, source, release: (outcome) => release(outcome) }
}

/** 立刻应答的假后端（第 ③④ 条用不到闸门） */
const instantSource = (signUpReply) => {
  const calls = { signIn: [], signUp: [], forgotPassword: [] }
  return {
    calls,
    source: {
      signIn: async (input) => {
        calls.signIn.push(input)
        return { ok: true }
      },
      signUp: async (input) => {
        calls.signUp.push(input)
        return signUpReply(input)
      },
      forgotPassword: async (input) => {
        calls.forgotPassword.push(input)
        return { ok: true, data: undefined }
      },
    },
  }
}

const applyEvents = (state, events) => events.reduce(reduceAuthCard, state)

test('① 同一 tick 连点两次（模拟双击）→ 只发出 1 次注册请求', async () => {
  const { calls, source, release } = gatedSource()
  const state = registerState()

  // 两次调用之间**没有 await**：这就是「同一 tick 内连点两次」的形态
  const first = submitAuthCard(source, state, ctx())
  const second = submitAuthCard(source, state, ctx())

  assert.equal(calls.signUp.length, 1, '同一 tick 的第二次点击必须被同步闩挡掉（只发 1 次请求）')
  assert.deepEqual(await second, [], '被挡下的那次「什么都不做」，不派任何事件')

  release({ ok: true })
  // 注册成功 → 回登录表单（产品口径 2026-11-25）；这条用例只关心「抢到闩的那一次照常提交」
  assert.deepEqual(
    await first,
    [{ type: 'back-to-login', notice: 'authRegisterDonePleaseLogin', email: 'double@click.test' }],
    '抢到闩的那一次照常提交'
  )
  assert.equal(calls.signUp.length, 1)
})

test('② 请求结束后再调用 → 又能发（闩会释放，不是一次性锁死）', async () => {
  const { calls, source, release } = gatedSource()
  const state = registerState()

  const first = submitAuthCard(source, state, ctx())
  assert.equal(calls.signUp.length, 1)
  release({ ok: true })
  await first

  const again = submitAuthCard(source, state, ctx())
  assert.equal(calls.signUp.length, 2, '第一次请求结束后，闩必须已经释放')
  release({ ok: true })
  assert.deepEqual(await again, [
    { type: 'back-to-login', notice: 'authRegisterDonePleaseLogin', email: 'double@click.test' },
  ])
})

test('③ source 抛错也释放闩（finally）——下一次点击照常能发', async () => {
  let attempts = 0
  const source = {
    signIn: async () => ({ ok: true }),
    signUp: async () => {
      attempts += 1
      throw new Error('boom')
    },
    forgotPassword: async () => ({ ok: true, data: undefined }),
  }
  const state = registerState()

  await assert.rejects(() => submitAuthCard(source, state, ctx()), /boom/, '错误不能在这里被吞掉')

  // 闩若没释放，这一次会被直接挡回 []、`attempts` 停在 1
  await assert.rejects(() => submitAuthCard(source, state, ctx()), /boom/)
  assert.equal(attempts, 2, '抛错之后闩必须已经释放（否则异常一次就永久锁死）')
})

test('④ 429 → 产出「冷却」状态且带秒数（Retry-After 优先，没有就 60s）', async () => {
  // 4a：服务端给了 `Retry-After: 30`
  const withHeader = instantSource(async () => ({
    ok: false,
    error: { status: 429, kind: 'rate_limit', retryAfterMs: 30_000 },
  }))
  const state = registerState()
  const events = await submitAuthCard(withHeader.source, state, ctx())

  assert.deepEqual(events, [{ type: 'cooldown', seconds: 30 }], '429 不是「失败」，是一条冷却事件')
  const cooling = applyEvents(state, events)
  assert.equal(cooling.submitCooldown, 30, '冷却秒数来自 Retry-After')
  assert.equal(authCardCanSubmit(cooling, false), false, '冷却期间主按钮必须不可提交')

  // 4b：没有 `Retry-After` 头 → 回落 60s（客户端不另算间隔，只是「最早可能恢复」的量级）
  const noHeader = instantSource(async () => ({ ok: false, error: { status: 429, kind: 'rate_limit' } }))
  const fallbackEvents = await submitAuthCard(noHeader.source, registerState(), ctx())
  assert.deepEqual(fallbackEvents, [{ type: 'cooldown', seconds: RATE_LIMIT_FALLBACK_SECONDS }])

  // 4c：倒计时逐秒归零后自动恢复可点（`cooldown-tick` 是容器每秒派的那一下）
  let ticking = cooling
  for (let i = 0; i < 30; i += 1) {
    ticking = reduceAuthCard(ticking, { type: 'cooldown-tick' })
  }
  assert.equal(ticking.submitCooldown, 0)
  assert.equal(authCardCanSubmit(ticking, false), true, '倒计时结束必须自动恢复')

  // 4d：冷却期间再点也不会发请求（第三层：状态层就挡住了）
  const during = instantSource(async () => ({ ok: true }))
  assert.deepEqual(await submitAuthCard(during.source, cooling, ctx()), [])
  assert.equal(during.calls.signUp.length, 0)

  // 4e：别的失败（非 429）照旧走 `form-submitted`，文案仍由 store 的 errorKey 负责
  const other = instantSource(async () => ({ ok: false, error: { status: 401, kind: 'auth' } }))
  assert.deepEqual(await submitAuthCard(other.source, registerState(), ctx()), [{ type: 'form-submitted' }])
})

test('429 秒数归一：Retry-After 向上取整、至少 1 秒；非 429 返回 null', () => {
  assert.equal(rateLimitSecondsOf({ status: 429, retryAfterMs: 30_500 }), 31)
  assert.equal(rateLimitSecondsOf({ status: 429, retryAfterMs: 1 }), 1)
  assert.equal(rateLimitSecondsOf({ kind: 'rate_limit' }), RATE_LIMIT_FALLBACK_SECONDS)
  assert.equal(rateLimitSecondsOf({ status: 401, kind: 'auth' }), null)
  assert.equal(rateLimitSecondsOf(null), null)
})

test('闩本身：同名入口并发只放行一次，exit 之后重新可抢', () => {
  const latch = createInFlightLatch()
  assert.equal(latch.enter(), true)
  assert.equal(latch.enter(), false, '第二只脚必须踩空')
  assert.equal(latch.active, true)
  latch.exit()
  assert.equal(latch.active, false)
  assert.equal(latch.enter(), true)
  latch.exit()
})
