// [layer: unit | 依赖: 无（纯 Node；直接 import 真代码，不起浏览器、不连 IndexedDB） | 耗时: <1s]
//
// 每会话聊天背景（本单）：**纯判定层**的四条口径。
//
// 被测物是 `src/services/chat/sessionBackground.ts`（解析 / clamp / resolve / 渲染计划），
// 不掺存储与 UI：图片本体在 IndexedDB（`appAssets.ts` 按 sessionId 存 key），DOM 渲染在
// `App.tsx`。这里只钉「读到这些字段时到底该画什么」，因为这几条错了就是**串会话**与
// **老数据打不开**，而它们都能在没有浏览器的地方判出来。
//
// 六条用例对应任务书 ①②③④⑤⑥：
//   ① 会话未设置        → 用全局默认（老用户升级后一切照旧）
//   ② 会话设置了三项    → 覆盖全局默认（style / opacity / blur 各自生效）
//   ③ 脏值 clamp        → opacity 200→100、blur -5→0、style 未知→default
//   ④ 老数据（无字段）  → 能读、不抛、等价于 ①
//   ⑤ 「恢复默认」      → 清掉覆盖后回到全局默认
//   ⑥ 两边都没设置      → 什么都不加（`data-chat-background` 不出现）
//
// 负向对照（PR 正文有实测）：把 `resolveSessionBackground` 改成「永远取全局」→ ②⑤ 必红。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { installTsResolve, loadTsModule, ROOT } from '../helpers/dom-env.mjs'

installTsResolve()

const bg = await loadTsModule('src/services/chat/sessionBackground.ts')
const {
  DEFAULT_BACKGROUND_BLUR,
  DEFAULT_BACKGROUND_OPACITY,
  backgroundPlanOf,
  clampBackgroundBlur,
  clampBackgroundOpacity,
  parseSessionBackground,
  resolveSessionBackground,
} = bg

const GLOBAL = { url: 'blob:https://app.test/global-default' }
/** 老数据：一条会话记录上根本没有 `background` 字段（升级前写进 IndexedDB 的那些） */
const legacySession = { id: 's-legacy', title: '老会话' }

test('① 会话没有单独设置 → 用全局默认背景', () => {
  const resolved = resolveSessionBackground({ ...legacySession, background: undefined }, GLOBAL)
  assert.equal(resolved.kind, 'global', '没有会话级覆盖时必须回到全局默认，而不是把背景清空')
  assert.equal(resolved.url, GLOBAL.url)

  // 渲染计划：走全局图，遮罩沿用 CSS 里的默认值（不因为这次改动改变老用户看到的样子）
  const plan = backgroundPlanOf(resolved)
  assert.deepEqual(plan, { imageCss: `url("${GLOBAL.url}")`, maskAlpha: null, blurPx: 0 })
  assert.equal(plan.style, undefined, '全局默认没有预设样式')
})

test('② 会话设置 style / opacity / blur 三项 → 覆盖全局默认的三项', () => {
  const session = {
    id: 's-own',
    background: { style: 'mountain', opacity: 60, blur: 8 },
  }
  const resolved = resolveSessionBackground(session, GLOBAL)
  assert.equal(resolved.kind, 'preset')
  assert.equal(resolved.style, 'mountain', '会话选了远山，就不该再画全局那张图')
  assert.equal(resolved.opacity, 60)
  assert.equal(resolved.blur, 8)

  const plan = backgroundPlanOf(resolved)
  assert.equal(plan.style, 'mountain')
  assert.match(plan.imageCss, /^linear-gradient\(/u, '预设是 CSS 渐变近似（仓库里没有素材）')
  assert.notEqual(plan.imageCss, `url("${GLOBAL.url}")`, '预设不该复用全局图的 url（否则两层的图会串）')
  assert.equal(plan.blurPx, 8)
  // 不透明度 60% → 遮罩 40%（两者等价：图 60% + 底色 40%）
  assert.equal(plan.maskAlpha, 0.4)

  // 会话自定义图：style = custom 时用的是**本会话**的 object URL，而不是全局那张
  const custom = resolveSessionBackground({ id: 's-own', background: { style: 'custom', opacity: 35, blur: 2 } },
    GLOBAL, 'blob:https://app.test/session-own')
  assert.equal(custom.kind, 'custom')
  assert.equal(custom.url, 'blob:https://app.test/session-own')
  const customPlan = backgroundPlanOf(custom)
  assert.equal(customPlan.maskAlpha, 0.65)
  assert.equal(customPlan.imageCss, 'url("blob:https://app.test/session-own")', '自定义图走的是本会话的 object URL')
})

test('③ 脏值 clamp：opacity 200→100、blur -5→0、style 未知→default', () => {
  const parsed = parseSessionBackground({ style: 'neon', opacity: 200, blur: -5 })
  assert.equal(parsed.style, 'default', '不认识的 style 必须回落 default，不能当成某个预设去渲染')
  assert.equal(parsed.opacity, 100)
  assert.equal(parsed.blur, 0)

  // 字符串 / null / NaN / Infinity 都不是数字，一律回落默认值（`Number('')` 是 0 的坑不踩）
  for (const dirty of ['', null, NaN, Infinity, '60', {}, []]) {
    assert.equal(clampBackgroundOpacity(dirty), DEFAULT_BACKGROUND_OPACITY, `opacity 脏值 ${JSON.stringify(dirty)} 应回落默认`)
    assert.equal(clampBackgroundBlur(dirty), DEFAULT_BACKGROUND_BLUR, `blur 脏值 ${JSON.stringify(dirty)} 应回落默认`)
  }

  // 区间两端是闭区间
  assert.equal(clampBackgroundOpacity(0), 0)
  assert.equal(clampBackgroundOpacity(-3), 0)
  assert.equal(clampBackgroundOpacity(100), 100)
  assert.equal(clampBackgroundOpacity(1000), 100)
  assert.equal(clampBackgroundBlur(0), 0)
  assert.equal(clampBackgroundBlur(20), 20)
  assert.equal(clampBackgroundBlur(21), 20)

  // 未知 style + 合法数值 → style 回落 default，数值照 clamp（不整条丢弃）
  const mixed = resolveSessionBackground({ background: { style: 'mountain ', opacity: 200, blur: 99 } }, GLOBAL)
  assert.equal(mixed.kind, 'global', 'style 脏 = 没有有效的会话级选择 → 回落全局默认')
  const dirtyOpacity = resolveSessionBackground({ background: { style: 'forest', opacity: 200, blur: -5 } }, GLOBAL)
  assert.equal(dirtyOpacity.kind, 'preset')
  assert.equal(backgroundPlanOf(dirtyOpacity).maskAlpha, 0)
  assert.equal(backgroundPlanOf(dirtyOpacity).blurPx, 0)
})

test('④ 老数据（整条会话上没有 background 字段）能读，且等价于「没设置」', () => {
  assert.equal(parseSessionBackground(undefined), undefined)
  assert.equal(parseSessionBackground(null), undefined)
  assert.equal(parseSessionBackground('mountain'), undefined, '字符串形态的脏数据不许当成 style')
  // 老数据走同一条解析路径：不抛错、结果与 ① 一致
  assert.deepEqual(resolveSessionBackground(legacySession, GLOBAL), resolveSessionBackground({}, GLOBAL))
  // 连 globalDefault 都是老形态（undefined / 空 url）时也只是「没有背景」，不抛
  assert.deepEqual(resolveSessionBackground(legacySession, undefined), { kind: 'none' })
  assert.deepEqual(resolveSessionBackground(legacySession, { url: '' }), { kind: 'none' })
})

test('⑤ 「恢复默认」清掉会话覆盖后，回到全局默认', () => {
  const withOwn = { id: 's-own', background: { style: 'forest', opacity: 80, blur: 4 } }
  assert.equal(resolveSessionBackground(withOwn, GLOBAL).kind, 'preset')

  // 「恢复默认」= 把字段清成 undefined（不是写成 style:'default' 的另一个对象）
  const restored = { ...withOwn, background: undefined }
  const resolved = resolveSessionBackground(restored, GLOBAL)
  assert.equal(resolved.kind, 'global')
  assert.equal(resolved.url, GLOBAL.url)
  assert.equal(backgroundPlanOf(resolved).maskAlpha, null, '回到全局默认就不该再带会话级的遮罩 alpha')

  // 即便别处真的存了 style:'default'，语义同样是「跟随全局默认」，两者等价
  assert.deepEqual(
    resolveSessionBackground({ id: 's-own', background: { style: 'default', opacity: 80, blur: 4 } }, GLOBAL),
    resolved,
  )

  // 删除会话里的自定义图之后，会话仍停在 custom（但图读不回来）→ 回落全局默认，不是黑屏
  assert.deepEqual(
    resolveSessionBackground({ background: { style: 'custom', opacity: 50, blur: 0 } }, GLOBAL, null),
    { kind: 'global', url: GLOBAL.url },
  )
})

test('⑥ 全局背景未设置 + 会话未设置 → 什么背景都不加（data-chat-background 不出现）', () => {
  for (const globalDefault of [undefined, null, { url: null }, { url: '' }]) {
    const resolved = resolveSessionBackground(legacySession, globalDefault)
    assert.deepEqual(resolved, { kind: 'none' })
    assert.equal(backgroundPlanOf(resolved), null, 'plan 为 null 时 App 不写 data-chat-background')
  }

  // App.tsx 的渲染条件必须挂在 plan 上：挂回 backgroundUrl（全局图）会让「会话设置了背景、
  // 但全局没设置」这条最常见的新用户路径整个失效
  const appSource = readFileSync(path.join(ROOT, 'src/app/App.tsx'), 'utf8')
  assert.match(appSource, /data-chat-background=\{plan \? 'on' : undefined\}/u)
})

// ─────────────────────────────────────────────────────────────────────────────
// 回归：有会话背景时，输入区那条「遮住滚动内容」的渐变不能再铺不透明页底色
//
// 用户反馈「设置背景后底部有白块」——根因就是 `.inputContainer` 的
// `linear-gradient(... var(--dsw-alias-bg-base) 30% ...)` 在背景图上糊出一块白板。
// 改动只是 CSS，这里用源码文本钉住，删掉那条件覆盖就会红。
// ─────────────────────────────────────────────────────────────────────────────
test('输入区在背景开启时必须透明（否则背景图上会有白块）', async () => {
  const { readFile } = await import('node:fs/promises')
  const css = await readFile('src/components/session/SessionView.module.css', 'utf8')
  const rule = /:global\(main\[data-chat-background='on'\]\)\s*\.inputContainer\s*\{[^}]*background:\s*transparent/u
  assert.match(css, rule, '缺少 `main[data-chat-background="on"] .inputContainer { background: transparent }`')
  // 反向：默认（无背景）那条渐变要留着，别顺手把滚动遮挡也删了
  assert.match(css, /\.inputContainer\s*\{[^}]*linear-gradient/u, '无背景时的遮挡渐变不能一起删掉')
})
