// [layer: unit | dependencies: none | no build, browser, network or Android]
//
// Issue #324（重新定位后）：官方渠道「回复中断 / 未知错误」的真实来源不是错误分类，
// 而是**请求体不合规** —— `role: 'latest_reminder'` 的快照必须是 5 段
// `<date>,<weekday>,<location>,<platform>,<language>`，修复前的实现把空的「所在地」段
// 整个 filter 掉，发出 4 段，官方端点直接 400：
//   latest_reminder must have at least 5 comma-separated fields, got 4
// 该 400 落在 kind: 'http' 上，界面只有一句「回答没有完成，出现了未知错误」。
//
// 这里锁两件事：
// [1] createLatestReminder 不论有没有位置，**恒定 5 段**（缺项留空段，上游明确允许空 location）；
// [2] 修复前存进历史里的 4 段快照，重发时必须被 normalizeReminder 补成 5 段。
// #507：`__ENDPOINTS__` 全局兜底 —— 装载即挂（幂等）。单跑本文件（不经 run-layer 的 `--import` 预加载）也不会
// `ReferenceError: __ENDPOINTS__ is not defined`；走门禁时与预加载是同一份模块，无副作用叠加。
import '../helpers/injected.mjs'

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      // 与打包器一致：源码内部用 .js 说明符指向 .ts 文件
      if (specifier.startsWith('.') && specifier.endsWith('.js')) {
        return nextResolve(`${specifier.slice(0, -3)}.ts`, context)
      }
      throw error
    }
  },
})

const { createLatestReminder, normalizeReminder } = await import(
  '../../src/services/chat/latestReminder.ts'
)

const NOW = new Date('2026-11-19T10:00:00+08:00')
const fields = (reminder) => reminder.split(',')

/**
 * 日期段的期望值**按同一进程的本机时区**算，不写字面量。
 *
 * 实现口径（`latestReminder.ts` 注释）就是「日期与星期使用浏览器本地时区，避免 UTC 日期跨日」，
 * 所以 `NOW` 这个瞬间在 Asia/Shanghai 是 11-19、在 UTC 也是 11-19、在 America/New_York 是 11-18。
 * 原文写死 `'2026-11-19'` 等于要求跑用例的机器在 +08:00 一侧 —— 本机（CST）一直绿，CI 的 TZ=UTC
 * 恰好也落在同一天才没暴露，纽约就必红。这里守的是「日期段取自 `NOW`、形状是 YYYY-MM-DD」，
 * **不守时区偏移**（那属于本机时区口径，不是这条用例的守护对象）。
 */
const localDateOf = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

test('无位置信息时 latest_reminder 仍是 5 段（缺项留空段，不是删段）', () => {
  const reminder = createLatestReminder({ locale: 'en-US', location: null }, NOW)
  const parts = fields(reminder)
  assert.equal(parts.length, 5, `段数必须是 5，实际 ${parts.length}：${reminder}`)
  // 日期段：形状是 YYYY-MM-DD，且是 `NOW` 在**本机时区**的那一天（不写死哪一天，见 localDateOf）
  assert.match(parts[0], /^\d{4}-\d{2}-\d{2}$/u, `日期段形状必须是 YYYY-MM-DD，实际 ${JSON.stringify(parts[0])}`)
  assert.equal(parts[0], localDateOf(NOW), `日期段要取自 NOW（本机时区 ${Intl.DateTimeFormat().resolvedOptions().timeZone}）`)
  assert.equal(parts[2], '', '所在地缺失必须是空段')
  assert.equal(parts[3], 'Web')
  // 语言段取自应用语言（i18n），这里只要求非空，不钉具体文案
  assert.ok(parts[4].trim() !== '', '语言段不能为空')
})

test('有位置信息时也是 5 段，所在地在第 3 位', () => {
  const reminder = createLatestReminder(
    { locale: 'en-US', location: { region: 'SG', province: null, city: null } },
    NOW
  )
  const parts = fields(reminder)
  assert.equal(parts.length, 5, `段数必须是 5，实际 ${parts.length}：${reminder}`)
  assert.equal(parts[2], 'Singapore')
})

test('历史里的 4 段快照重发前被补成 5 段（缺的是所在地）', () => {
  assert.equal(
    normalizeReminder('2026-11-09,Monday,Web,English'),
    '2026-11-09,Monday,,Web,English'
  )
})

test('已经是 5 段的历史快照原样返回（改动前存下的也不会被改坏）', () => {
  for (const reminder of [
    '2026-11-09,Monday,Singapore,Web,English',
    '2026-11-09,Monday,,Web,English',
    '2026-11-09,星期一,北京,Web,中文',
  ]) {
    assert.equal(normalizeReminder(reminder), reminder)
  }
})
