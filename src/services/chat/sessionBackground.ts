/**
 * 每会话聊天背景（本单）的**纯判定层**：字段形状、宽容解析、clamp，以及
 * 「会话设置优先、否则全局默认」的解析。
 *
 * 为什么单独一个文件、且不 import zustand / IndexedDB / DOM：
 *   1. 这四条判定（解析、两个 clamp、resolve）是**产品语义**，出错的形态是「某条会话的背景
 *      串到别的会话上」「老数据一打开就白屏」——这类 bug 不该只有真机点一遍才发现，
 *      所以要能被 L0（纯 Node、import 真代码）直接钉住，见 `tests/unit/session-settings.test.mjs`；
 *   2. 存储（`appAssets.ts` 按 `sessionId` 存图片）、运行时（`background.ts` 的 object URL
 *      生命周期）都依赖它，谁也不该为了拿一个 clamp 去拖进 IndexedDB 或 React。
 *
 * 三层口径（与任务书 A 节一致）：
 *   - **会话级**：`Session.background`（`style` + `opacity` + `blur`），只作用于这一条会话；
 *   - **全局默认**：设置页那张图（`ChatBackgroundField`，IndexedDB 固定 key `chat-background`），
 *     老数据没有会话级字段时**继续用它**，不许因为这次改动被清掉；
 *   - **兜底**：两者都没有 → 什么都不加（`data-chat-background` 不出现，见 App.tsx）。
 */

/** 预设背景：视觉是 CSS 近似（仓库里没有对应素材），取名与设计稿一致 */
export type PresetBackgroundStyle = 'mountain' | 'sunset' | 'forest'

/**
 * 会话背景的来源。
 *
 * `default` 不是一个「背景」，而是**「跟随全局默认」**：选择「默认」/点「恢复默认」都落到它，
 * 语义上等于没有会话级覆盖。因此 `default` 时 `opacity` / `blur` 不起作用 ——
 * 全局默认图沿用原来的固定遮罩（见 `App.module.css` 的 `--chat-background-mask`）。
 */
export type SessionBackgroundStyle = 'default' | PresetBackgroundStyle | 'custom'

/** 存在 `Session.background` 上的形状；`custom` 的图片本体不在 JSON 里（按 sessionId 存 IndexedDB） */
export type SessionBackground = {
  style: SessionBackgroundStyle
  /** 背景图不透明度（0..100，百分比）：越小越淡。40 = 图只留四成 */
  opacity: number
  /** 背景模糊半径（0..20，px）；只加在固定背景层上，不加在消息列表上（性能） */
  blur: number
}

/** 默认不透明度：20% 是一个「看得见背景、又不影响正文对比度」的起点（设计稿同值） */
export const DEFAULT_BACKGROUND_OPACITY = 20
/** 默认不模糊：模糊是给「自定义大图」用的，预设渐变本来就糊 */
export const DEFAULT_BACKGROUND_BLUR = 0
/** clamp 上界：100% = 原图，再高没有意义（贴纸式图片不属于这个功能） */
export const BACKGROUND_OPACITY_MAX = 100
/** clamp 上界：20px 已经足够糊掉任何一张 1600px 的压缩图，再大只是白烧 GPU */
export const BACKGROUND_BLUR_MAX = 20

export const PRESET_BACKGROUND_STYLES: readonly PresetBackgroundStyle[] = ['mountain', 'sunset', 'forest']

/**
 * 三个预设背景的**视觉本体**：CSS 渐变近似（本单如实交代 —— 仓库里没有任何背景素材，
 * `src/` 下一张图片都没有，`appAssets.ts` 只存用户自己上传的那张）。
 *
 * 为什么写在 TS 里而不是各写一份 CSS：预设要出现在三个地方（设置页四宫格缩略图、
 * 背景页顶部预览卡、真正的聊天背景层），三处必须**逐字节一样**，否则「预览看到的」和
 * 「保存后的」不是一个东西。CSS Module 之间没法共享声明，所以这里当唯一来源，
 * 三处都把它塞进 `background-image`（或 `--chat-background-image`）。
 *
 * **需要产品提供正式图片**：换成 `url("…")` 即可，判定与存储都不用动。
 */
export const PRESET_BACKGROUND_GRADIENTS: Record<PresetBackgroundStyle, string> = {
  // 远山：雾蓝到灰蓝的层叠，模拟远山与天色
  mountain:
    'linear-gradient(180deg, #dce8f4 0%, #eef4fa 34%, #cddcea 55%, #a8bed2 78%, #8ba5bd 100%)',
  // 渐变：暖橘到柔粉，设计稿里那张「渐变」就是这条
  sunset:
    'linear-gradient(160deg, #fdf1e7 0%, #fadfd0 28%, #f5c4ab 52%, #eda9a4 76%, #d98fa0 100%)',
  // 森林：浅苔绿到深林的层层压深
  forest:
    'linear-gradient(180deg, #eef4e9 0%, #dbe8d3 30%, #bcd3b1 58%, #9cbb90 80%, #7f9f73 100%)',
}

export const SESSION_BACKGROUND_STYLES: readonly SessionBackgroundStyle[] = [
  'default',
  ...PRESET_BACKGROUND_STYLES,
  'custom',
]

/**
 * 宽容 clamp：非数字 / NaN / Infinity / 字符串数字以外的脏值一律回落 `fallback`，数值按区间截断。
 *
 * 为什么不做 `Number(value)` 强转：`Number('')` 是 0、`Number(null)` 也是 0，
 * 于是「字段是空串」会被读成「用户把不透明度拖到了 0」——一条**看起来正常**的脏数据。
 * 这里只接受真正的有限数字，其余一律当成「没设置过」。
 */
const clampNumber = (value: unknown, min: number, max: number, fallback: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback
  }
  return Math.min(max, Math.max(min, value))
}

/** 背景淡化（不透明度）：`0..100`，脏值 → 默认 20 */
export const clampBackgroundOpacity = (value: unknown): number =>
  clampNumber(value, 0, BACKGROUND_OPACITY_MAX, DEFAULT_BACKGROUND_OPACITY)

/** 背景模糊：`0..20` px，脏值 → 默认 0 */
export const clampBackgroundBlur = (value: unknown): number =>
  clampNumber(value, 0, BACKGROUND_BLUR_MAX, DEFAULT_BACKGROUND_BLUR)

export const isPresetBackgroundStyle = (value: unknown): value is PresetBackgroundStyle =>
  typeof value === 'string' && (PRESET_BACKGROUND_STYLES as readonly string[]).includes(value)

export const isSessionBackgroundStyle = (value: unknown): value is SessionBackgroundStyle =>
  value === 'default' || value === 'custom' || isPresetBackgroundStyle(value)

/**
 * 解析会话上的 `background` 字段（**宽容**，永不抛错）。
 *
 * | 输入 | 输出 |
 * | --- | --- |
 * | `undefined` / `null` / 非对象（老数据、导入的脏 JSON） | `undefined`（= 没有会话级覆盖） |
 * | 对象但 `style` 不认识 | `{ style: 'default', … }`（= 回落全局默认） |
 * | 对象、`opacity` / `blur` 脏 | 各自 clamp 到区间 / 回落默认值 |
 *
 * 注意「对象但空」的情形：`{}` 会被解析成 `{ style: 'default', opacity: 20, blur: 0 }` ——
 * 结果等价于没有覆盖，但**不返回 `undefined`**，因为「有一个形状合法但值为默认的对象」与
 * 「根本没有这个字段」是两件事，调用方（保存 / 恢复默认）需要能区分。
 */
export const parseSessionBackground = (value: unknown): SessionBackground | undefined => {
  if (!value || typeof value !== 'object') {
    return undefined
  }
  const record = value as Record<string, unknown>
  return {
    style: isSessionBackgroundStyle(record.style) ? record.style : 'default',
    opacity: clampBackgroundOpacity(record.opacity),
    blur: clampBackgroundBlur(record.blur),
  }
}

/** 全局默认背景：设置页那张图（`useChatBackground().url`，object URL 或 null） */
export type GlobalBackgroundDefault = { url?: string | null } | null | undefined

/**
 * 解析结果：真正要画什么。
 *
 *   - `none`   —— 什么都不加（`data-chat-background` 不出现）
 *   - `global` —— 全局默认图（沿用原有遮罩，不受会话级淡化/模糊影响）
 *   - `preset` —— 预设（远山 / 渐变 / 森林），CSS 渐变近似
 *   - `custom` —— 本会话上传的图片（`url` 是本次运行里 createObjectURL 出来的）
 */
export type ResolvedBackground =
  | { kind: 'none' }
  | { kind: 'global'; url: string }
  | { kind: 'preset'; style: PresetBackgroundStyle; opacity: number; blur: number }
  | { kind: 'custom'; url: string; opacity: number; blur: number }

const globalOf = (globalDefault: GlobalBackgroundDefault): ResolvedBackground => {
  const url = typeof globalDefault?.url === 'string' && globalDefault.url ? globalDefault.url : null
  return url ? { kind: 'global', url } : { kind: 'none' }
}

/**
 * **会话设置优先，否则全局默认**（任务书 A 节要求的那个纯函数）。
 *
 * `sessionImageUrl` 是「本会话那张自定义图」的 object URL（异步从 IndexedDB 读出来的，
 * 所以由调用方注入）。会话选了 `custom` 但图还没读回来 / 已被删掉时，**回落到全局默认**：
 * 用户看到的是「背景没变过」，而不是一片空白，也不会因为一次读库失败把会话搞成没有背景。
 */
export const resolveSessionBackground = (
  session: { background?: unknown } | null | undefined,
  globalDefault: GlobalBackgroundDefault,
  sessionImageUrl?: string | null,
): ResolvedBackground => {
  const own = parseSessionBackground(session?.background)
  if (!own || own.style === 'default') {
    return globalOf(globalDefault)
  }
  if (own.style === 'custom') {
    return typeof sessionImageUrl === 'string' && sessionImageUrl
      ? { kind: 'custom', url: sessionImageUrl, opacity: own.opacity, blur: own.blur }
      : globalOf(globalDefault)
  }
  return { kind: 'preset', style: own.style, opacity: own.opacity, blur: own.blur }
}

/**
 * 渲染计划：App.tsx 只认这一份，把 CSS 变量 / `data-*` 直接铺出来。
 *
 *   - `style`     → `data-chat-background-style`（只作可观测性/验收断言用，不参与样式 CSS 选择器）
 *   - `imageCss`  → `--chat-background-image`（全局图与会话自定义图是 `url("…")`，
 *     预设是 `PRESET_BACKGROUND_GRADIENTS` 里的渐变串 —— 三种来源共用一条渲染通路）
 *   - `maskAlpha` → 遮罩不透明度；`null` 表示「沿用 CSS 里的全局默认遮罩」（0.75 白 / 0.6 黑）
 *   - `blurPx`    → `--chat-background-blur: Npx`（`filter: blur()` 只加在固定背景层）
 *
 * 为什么不把 `opacity` 直接铺成 `opacity` 而折成遮罩 alpha：图片层与底色之间必须留一层遮罩，
 * 否则一张白底照片在亮色主题下会把正文压得看不见（现有的 0.75 白遮罩就是干这个的）。
 * 两者在视觉上等价（图 20% + 无遮罩 ≈ 图 100% + 80% 遮罩），但后者不影响图片自身的锐度。
 */
export type BackgroundPlan = {
  style?: PresetBackgroundStyle
  /** 直接写进 `--chat-background-image` 的 CSS 值：图片是 `url("…")`，预设是渐变串 */
  imageCss: string
  /** 遮罩不透明度；`null` = 沿用 CSS 里的全局默认遮罩（0.75 白 / 0.6 黑） */
  maskAlpha: number | null
  blurPx: number
}

/** `url("…")` 包装：object URL 里不会有引号，这里仍按 CSS 字符串转义一遍（防御脏数据） */
const imageUrlCss = (url: string): string => `url("${url.replace(/["\\\n]/gu, '')}")`

/** 遮罩 alpha 保留三位小数：`1 - 30/100` 在浮点里是 0.7000000000000001，写进 CSS 变量会很难看 */
const maskAlphaOf = (opacity: number): number => Math.round((1 - clampBackgroundOpacity(opacity) / 100) * 1000) / 1000

export const backgroundPlanOf = (resolved: ResolvedBackground): BackgroundPlan | null => {
  switch (resolved.kind) {
    case 'none':
      return null
    case 'global':
      return { imageCss: imageUrlCss(resolved.url), maskAlpha: null, blurPx: 0 }
    case 'preset':
      return {
        style: resolved.style,
        imageCss: PRESET_BACKGROUND_GRADIENTS[resolved.style],
        maskAlpha: maskAlphaOf(resolved.opacity),
        blurPx: clampBackgroundBlur(resolved.blur),
      }
    case 'custom':
      return {
        imageCss: imageUrlCss(resolved.url),
        maskAlpha: maskAlphaOf(resolved.opacity),
        blurPx: clampBackgroundBlur(resolved.blur),
      }
  }
}
