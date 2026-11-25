/**
 * 「自定义系统提示词」的字数上限口径（#890：上限 1000 字）。
 *
 * 为什么单独一个文件：**计数口径只能有一处**。抽屉里显示「已用 x / 1000」、textarea 的 maxLength、
 * 粘贴截断、保存校验、分享导入校验，全都从这里的常量与函数出去 —— 各写一套的结果就是
 * 「显示 998 / 1000 却存不进去」或者「emoji 被算成 2 个字」这类互相矛盾的界面。
 *
 * 这里**零 import**：纯函数，`node --test` 直接 import 真代码就能测（不需要桩 / 打包器）。
 *
 * 三个口径，别混：
 *   1. **字 = Unicode 码点**（`[...text].length`）。`'😀'.length === 2` 是 UTF-16 单元的账，
 *      拿它当字数会让「500 个 emoji」被数成 1000 字、正好卡在边界上被误判超长。
 *   2. **textarea 的 `maxLength` 是按 UTF-16 单元算的**（HTML 规范定死，改不了）。一个合法的
 *      1000 字提示词，全是星平面字符时要占 2000 单元，所以 maxLength 只能设成
 *      `PROMPT_MAX_CHARS * 2`（见 `PROMPT_MAX_UTF16_UNITS`）—— 设成 1000 的话，原生截断会比
 *      业务上限**更早**生效，等于把「1000 个字」偷偷改成「500 个 emoji」。
 *      maxLength 只负责挡住「继续输入」，真正的上限由 `truncatePromptChars` 与
 *      `inspectPrompt` 守着（粘贴不受 maxLength 约束）。
 *   3. **超长不许静默截断**。存量数据（历史版本 / 分享导入带进来的）超长时，抽屉里给提示、
 *      按钮禁用、等用户自己删；导入侧则**整段丢弃并打标** —— 砍成半句话比报错更难查。
 */

/** 提示词上限：1000 字（码点） */
export const PROMPT_MAX_CHARS = 1000

/** 计数进入警示色的门槛（接近上限）。比上限小，具体位置是产品口径，不是实现细节 */
export const PROMPT_WARN_CHARS = 900

/**
 * `textarea[ maxLength ]` 用的值（**UTF-16 单元**口径）。
 * 取 2 倍上限：任何合法的 1000 字提示词（最多 2000 单元）都能整段放进输入框，
 * 原生限制不会先于业务上限生效。
 */
export const PROMPT_MAX_UTF16_UNITS = PROMPT_MAX_CHARS * 2

/** 字数 = Unicode 码点个数。**不是** `text.length`（那是 UTF-16 单元） */
export const countPromptChars = (text: string): number => [...text].length

/**
 * 按**码点**截断到 `max` 个字；不超长原样返回（同一个字符串引用，省一次分配）。
 *
 * 用 `[...text]` / `Array.from(text)` 切分：它按码点走，天然不会把代理对（emoji、生僻字）
 * 劈成两半。反例：`'a' + '😀'.repeat(600)` 共 1201 单元，`slice(0, 1000)` 会切出
 * 一个孤立的高代理（渲染成 �、写进 JSON 变 U+FFFD，且永远修不回来），而这里给出
 * `'a' + '😀'.repeat(999)`，正好 1000 字。
 */
export const truncatePromptChars = (text: string, max: number = PROMPT_MAX_CHARS): string => {
  const chars = [...text]
  return chars.length <= max ? text : chars.slice(0, max).join('')
}

/** 保存口径：首尾空白不算内容（纯空白 = 空 = 清空提示词） */
export const normalizePrompt = (text: string): string => text.trim()

export type PromptState = {
  /** trim 之后真正要保存/上报的正文 */
  text: string
  /** `text` 的码点数 */
  count: number
  /** 超长：按钮禁用 + 行内提示，**不截断** */
  oversized: boolean
  /** 空（纯空白也算空）：允许保存，等于清空 */
  empty: boolean
  /** 能不能保存（`!oversized`） */
  canSave: boolean
}

/**
 * 一次算清「当前输入该显示什么、能不能存」。
 *
 * 长度按 **trim 之后**的正文算：两侧空格的多少不该决定「超没超长」，
 * 否则用户会看到「1001 字 → 删掉两个结尾空格 → 1001 字还是超长」这种莫名其妙的界面。
 * `text` 也**不做任何截断**：超长时原样返回 `text`，由界面禁用保存、由用户自己删。
 */
export const inspectPrompt = (
  raw: string | undefined | null,
  max: number = PROMPT_MAX_CHARS
): PromptState => {
  const text = normalizePrompt(typeof raw === 'string' ? raw : '')
  const count = countPromptChars(text)
  const oversized = count > max
  return { text, count, oversized, empty: count === 0, canSave: !oversized }
}

export type ImportedPrompt = {
  /** 可以落库的正文（超长 / 空白时为 undefined） */
  prompt: string | undefined
  /** 原来是超长文本、被**整段丢弃**（不是截断）：导入结果需要标注这一条 */
  dropped: boolean
}

/**
 * 导入侧（分享 / 归档）校验：超长 → 整段丢弃并打标，**绝不截断**。
 *
 * 为什么不截断：导入进来的提示词是别人写的，砍成 1000 字往往停在一句话中间，
 * 用户看到的是一段语义残缺还说不出哪里不对的内容 —— 丢弃 + 标注「该字段未导入」
 * 至少是诚实的。空白同样视作没有（不写空串，免得库里多一条 `''`）。
 */
export const importedPrompt = (
  value: unknown,
  max: number = PROMPT_MAX_CHARS
): ImportedPrompt => {
  if (typeof value !== 'string') {
    return { prompt: undefined, dropped: false }
  }
  const text = normalizePrompt(value)
  if (text === '') {
    return { prompt: undefined, dropped: false }
  }
  return countPromptChars(text) > max
    ? { prompt: undefined, dropped: true }
    : { prompt: text, dropped: false }
}
