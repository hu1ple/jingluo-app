import { Capacitor } from '@capacitor/core'
import { bundledApp } from '../appUpdate.js'
import { RELEASE_BASES } from '../updateManifest.js'
import type { Announcement, AnnouncementLevel } from './types.js'

/**
 * 公告清单的**抓取层**（`<分发机>/announcements.json`）。
 *
 * 三条纪律，与更新清单（`services/updateManifest.ts`）**共用地址、共用主备，但不共用解析口径**：
 *
 *  1. **地址唯一来源**：只从 `RELEASE_BASES` 拼（= `__ENDPOINTS__.dlPrimaryBase` / `dlFallbackBase`，
 *     构建期由 rspack 注入）。这里**不写任何地址字面量** —— 公告和版本清单必须落在同一台机上、
 *     走同样的「先新机后旧机」顺序，否则会出现「更新能查、公告 404」这种半边可用（`check:endpoints`
 *     的第 4 条就是守这个）。
 *  2. **宽松解析**（与 `parseManifest` 的整份拒收相反）：清单是运营手工/脚本发布的，
 *     一条写坏了不该拖垮整份 —— **单条非法只丢这一条**；只有「顶层不是对象」或
 *     `announcements` 不是数组这种**整份无法理解**的情形才当失败。公告是锦上添花的内容，
 *     宁可少显示一条，也不要因为一条脏数据让用户一条都看不到。
 *  3. **失败就是 `null`**：网络错 / 非 2xx / 超时 / 全份解析失败，一律返回 `null`，
 *     **不抛、不弹错误**。调用方（`store.ts`）拿 `null` 就知道「这次没新数据」，继续用缓存。
 *
 * 与 `fetchManifest` 的另一个差别：这里没有私有清单、没有令牌、没有原生 bridge —— 公告是公开内容。
 */

/** 公告清单相对 base 的路径（与 `releases.json` 同一台机、同一套主备） */
export const ANNOUNCEMENTS_FILE = '/announcements.json'

/**
 * 单次尝试的超时（2.5s）。
 * 为什么是这个量级：公告在**冷启动**的同一个窗口里拉，晚到 5 秒就等于让首屏陪着等；
 * 而「这次没拉到」的代价只是「下次可见时再拉」（`store.ts` 的 1 小时 TTL），
 * 所以宁可早断。两台机最坏 5s 出结果，且全程不阻塞渲染（`store.ts` 是异步替换快照）。
 */
const FETCH_TIMEOUT_MS = 2500

/** 单份响应体上限（512 KiB）：公告正文再长也用不到，超了当脏数据（避免一次读爆内存） */
const MAX_BODY_CHARS = 512 * 1024

/** 单条字段上限：标题 200 字、正文 20000 字。超了当这条非法，不影响别的条 */
const MAX_TITLE_CHARS = 200
const MAX_BODY_CHARS_ITEM = 20_000
const MAX_ID_CHARS = 200

/** 一份清单最多认多少条：再多的公告是「清单被写坏了」，整份当失败（与 `parseManifest` 同一档） */
const MAX_DOC_ITEMS = 2000

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * `target` 的最小过滤条件。
 *
 * 本轮**只做两维**：`platform`（当前平台不在列表里 → 丢弃）与 `minVersionCode`
 * （本机 `bundledApp().versionCode` 低于它 → 丢弃）。变体 / 语言 / 渠道等维度**没做**，
 * 服务端即便下发了也不认（字段留着不解析，比猜错口径更安全）—— 见 Issue 的「遗留」一节。
 */
export interface TargetFilter {
  /** 当前平台名，与 `target.platform` 同一套写法（`android` / `ios` / `web`） */
  platform: string
  /** 本机已装包的 versionCode（取不到时为 0：不做版本过滤） */
  versionCode: number
}

/**
 * 当前平台名。`Capacitor.getPlatform()` 在纯浏览器里是 `'web'`，原生壳里是 `android` / `ios`。
 * 取不到（非 Capacitor 环境 / 裁剪构建）一律当 `web`：网页预览就是 web，这个默认不会误伤原生。
 */
const currentPlatform = (): string => {
  try {
    const platform = Capacitor.getPlatform()
    return typeof platform === 'string' && platform !== '' ? platform.toLowerCase() : 'web'
  } catch {
    return 'web'
  }
}

/** 本机已装包的 versionCode（与设置页「当前版本」同一口径，见 `appUpdate.bundledApp`） */
const currentVersionCode = (): number => {
  try {
    const code = bundledApp().versionCode
    return Number.isSafeInteger(code) && code > 0 ? code : 0
  } catch {
    return 0
  }
}

/** 本机的过滤条件（`parseAnnouncements` 的默认值；单测可直接传假的） */
export const deviceTargetFilter = (): TargetFilter => ({
  platform: currentPlatform(),
  versionCode: currentVersionCode(),
})

/**
 * `target` 是否放行这一条。
 *
 * **缺省即全量**：没有 `target`、或 `target` 不是对象、或字段形状读不懂 → 放行。
 * 为什么不做 fail-closed：公告是通知，读不懂投放条件时「多显示一条」的代价远小于
 * 「公告被静默吞掉、用户根本不知道自己该做什么」。唯一会真丢弃的是**读得懂且明确不匹配**：
 *  · `platform` 是非空字符串数组，且**没有任何一项**等于当前平台；
 *  · `minVersionCode` 是有限数，且**大于**本机 versionCode。
 */
const targetAllows = (raw: unknown, filter: TargetFilter): boolean => {
  if (!object(raw)) {
    return true
  }
  const platform = raw['platform']
  if (Array.isArray(platform) && platform.length > 0) {
    const wanted: string[] = []
    for (const item of platform) {
      if (typeof item === 'string' && item.trim() !== '') {
        wanted.push(item.trim().toLowerCase())
      }
    }
    // 列表里全是脏值（读不懂投放口径）→ 不当过滤条件，放行
    if (wanted.length > 0 && !wanted.includes(filter.platform)) {
      return false
    }
  }
  const minVersionCode = raw['minVersionCode']
  if (typeof minVersionCode === 'number' && Number.isFinite(minVersionCode)) {
    if (minVersionCode > filter.versionCode) {
      return false
    }
  }
  return true
}

/**
 * 解析**单条**公告：形状不合格返回 `null`（调用方丢掉这条，继续下一条）。
 *
 * 必需字段：`id` / `title` / `body` / `publishedAt`（且 `publishedAt` 必须能被 `Date.parse` 解析成
 * 真时间 —— 解析不出来的时间会让列表排序与「N 天前」一起失真，宁可不要这一条）。
 * `level` 只认 `'important'`，其它（含大小写写错、拼错、缺省）一律 `'normal'`：
 * 级别只影响「加个醒目图标」，认错方向时少标记比误标记更安全。
 *
 * 这里**不做** `target` 过滤（那是 `parseAnnouncements` 的事）：缓存回读也要用这个函数，
 * 而缓存里的条目在写入前已经过 `target` 过滤，回读时再过滤一遍等于让「版本升级后公告消失」。
 */
export const parseAnnouncementItem = (value: unknown): Announcement | null => {
  if (!object(value)) {
    return null
  }
  const id = value['id']
  const title = value['title']
  const body = value['body']
  const publishedAt = value['publishedAt']
  if (typeof id !== 'string' || id.trim() === '' || id.length > MAX_ID_CHARS) {
    return null
  }
  if (typeof title !== 'string' || title.trim() === '' || title.length > MAX_TITLE_CHARS) {
    return null
  }
  if (typeof body !== 'string' || body.trim() === '' || body.length > MAX_BODY_CHARS_ITEM) {
    return null
  }
  if (typeof publishedAt !== 'string' || Number.isNaN(Date.parse(publishedAt))) {
    return null
  }
  const level: AnnouncementLevel = value['level'] === 'important' ? 'important' : 'normal'
  return { id, title, body, publishedAt, level }
}

/**
 * 解析整份清单：**顶层不合格才整份失败**，单条不合格只丢这一条。
 *
 * 去重口径：同一个 `id` 只留**先出现的那一条**（数组顺序 + 时间戳倒序由 `store.ts` 统一排序，
 * 这里不排序 —— 解析层只管「哪些条成立」）。重复 id 必须去掉，否则已读表按 id 存，
 * 两条同 id 的公告会一起变已读、一起变未读，红点数也会翻倍。
 */
export const parseAnnouncements = (
  input: unknown,
  filter: TargetFilter = deviceTargetFilter()
): Announcement[] => {
  if (!object(input) || !Array.isArray(input['announcements'])) {
    throw new Error('INVALID_ANNOUNCEMENTS')
  }
  const rows: unknown[] = input['announcements']
  if (rows.length > MAX_DOC_ITEMS) {
    throw new Error('INVALID_ANNOUNCEMENTS')
  }
  const out: Announcement[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    const item = parseAnnouncementItem(row)
    if (item === null) {
      // 单条非法（缺字段 / 时间解析不出 / 超长）：只丢这一条
      continue
    }
    if (!targetAllows(object(row) ? row['target'] : undefined, filter)) {
      // 投放条件明确不匹配（平台不符 / 版本太低）：只丢这一条
      continue
    }
    if (seen.has(item.id)) {
      continue
    }
    seen.add(item.id)
    out.push(item)
  }
  return out
}

/**
 * 取一份文本（带超时 + 外部取消）。所有失败都**抛**，由 `fetchAnnouncements` 收成「试下一台」。
 *
 * 超时用 `AbortController`：`fetch` 本身没有超时语义，不主动 abort 的话，一台机上的黑洞连接
 * 会把公告拉到跟浏览器默认的 300s 一样久 —— 那期间列表一直是空的。
 * `credentials: 'omit'` / `cache: 'no-store'` / `redirect: 'error'` 与更新清单同档：
 * 公告是公开内容，不需要任何凭据，也不许被中间层缓存成旧的。
 */
const fetchText = async (url: string, signal?: AbortSignal): Promise<string> => {
  const controller = new AbortController()
  const forwardAbort = (): void => controller.abort()
  if (signal !== undefined) {
    if (signal.aborted) {
      controller.abort()
    } else {
      signal.addEventListener('abort', forwardAbort, { once: true })
    }
  }
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
    })
    if (!response.ok) {
      throw new Error(`ANNOUNCEMENTS_HTTP_${response.status}`)
    }
    const body = await response.text()
    if (body.length > MAX_BODY_CHARS) {
      throw new Error('ANNOUNCEMENTS_TOO_LARGE')
    }
    return body
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', forwardAbort)
  }
}

/**
 * 按 `RELEASE_BASES` 顺序拉公告：**第一个成功的 base 即生效**，全失败返回 `null`。
 *
 * 「成功」= 能取到字节 **且** 整份能理解（顶层是对象、`announcements` 是数组）。
 * 所以解析失败也要继续试下一台：新机清单被写脏、旧机还干净的情形现实存在
 * （2026-11-19 的 P0 事故正是「拿到 200 就不换」把可用清单丢了），公告沿用同一条经验。
 *
 * `signal` 被调用方取消时立刻返回 `null`（不发第二轮、不抛 AbortError）：
 * 公告的调用方是 store，没有任何「取消」的业务语义，抛出去只会多一个要处理的异常分支。
 */
export const fetchAnnouncements = async (signal?: AbortSignal): Promise<Announcement[] | null> => {
  if (typeof fetch === 'undefined') {
    return null
  }
  const filter = deviceTargetFilter()
  // 主备可能配成同一个地址：去重，不要对同一台机打两次
  const bases = [...new Set<string>(RELEASE_BASES)]
  for (const base of bases) {
    const url = `${base}${ANNOUNCEMENTS_FILE}`
    let body: string
    try {
      body = await fetchText(url, signal)
    } catch {
      if (signal?.aborted === true) {
        return null
      }
      continue
    }
    try {
      return parseAnnouncements(JSON.parse(body), filter)
    } catch {
      // JSON 坏了 / 顶层形状不认识：当这一台失败，试下一台
      if (signal?.aborted === true) {
        return null
      }
      continue
    }
  }
  return null
}
