/**
 * 历史会话归档（ZIP）的**测试夹具生成器**：导入域那一族的用例共用这一份。
 *
 * 为什么要有它：`import-hardening` / `import-quota-progress` 两个文件原先各抄一遍
 * `message` / `sessionBytes` / `manifestBytes` / `indexBytes` / `archiveOf`，逐字 40 行 ——
 * `check:test-duplication` 的 R1（≥20 行逐字相同）当场判红。口径和 `installImportEnv`（#408）一样：
 * 同一段装配只留一份，各文件只保留自己**不同**的那个外层包装（一个按 `[名字, 字节][]` 拼包，
 * 一个按会话 id 列表拼包）。
 *
 * 条目物理顺序就是导入端看到的顺序（`readArchive` 按物理顺序单遍处理），所以这里不排序、不去重：
 * 这正是 `buildZip`（对抗层手写 ZIP）而不是 `fflate.zipSync` 的原因 —— 后者会规范化名字并去重。
 */
import { strToU8 } from 'fflate'

import { buildZip } from '../adversarial/lib/zip.mjs'

/** 归档里所有时间戳都用这一个值：用例断言的是顺序与结构，不是时钟。 */
export const ARCHIVE_TIME = '2026-11-01T00:00:00.000Z'

/** 归档格式里的一条消息（一问一答各一条，字段齐全但不是全部字段）。 */
export const message = (id, parentId, role, content) => ({
  id,
  parent_id: parentId,
  role,
  status: 'FINISHED',
  thinking_enabled: false,
  search_enabled: false,
  accumulated_token_usage: 0,
  inserted_at: ARCHIVE_TIME,
  fragments: [{ type: role === 'USER' ? 'REQUEST' : 'RESPONSE', content }],
})

/** 一个会话文件（`chat_sessions/{id}.json`）的字节：两轮消息，`content` 用来构造大正文 / 高压缩比。 */
export const sessionBytes = (id, content) =>
  strToU8(
    JSON.stringify({
      id,
      title: id,
      pinned: false,
      current_message_id: 2,
      inserted_at: ARCHIVE_TIME,
      updated_at: ARCHIVE_TIME,
      messages: [
        message(1, null, 'USER', `${id} 的问题`),
        message(2, 1, 'ASSISTANT', content ?? `${id} 的回答`),
      ],
    })
  )

/** `manifest.json` 的字节（必须是归档里的第一个条目）。 */
export const manifestBytes = () => strToU8(JSON.stringify({ export_format_version: 3 }))

/** `chat_session_index.json` 的字节：列出包里全部会话。 */
export const indexBytes = (ids) =>
  strToU8(
    JSON.stringify(
      ids.map((id) => ({
        id,
        title: id,
        pinned: false,
        message_count: 2,
        inserted_at: ARCHIVE_TIME,
        updated_at: ARCHIVE_TIME,
      }))
    )
  )

/**
 * `[名字, 字节]` 的有序数组 → 一个 `File`（直接当作用户选中的归档）。
 *
 * - 条目顺序即物理顺序，也即导入端看到的顺序；
 * - `compress = true` 时逐条目 deflate（用来构造高压缩比 / 声明尺寸撒谎的包）。
 */
export const zipFileOf = (entries, { compress = false, fileName = 'deepseek_data.zip' } = {}) =>
  new File(
    [buildZip(entries.map(([name, data]) => ({ name, data, compress })))],
    fileName,
    { type: 'application/zip' }
  )
