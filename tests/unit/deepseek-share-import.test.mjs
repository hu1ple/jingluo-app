import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fixtureUrl, inlineModule, installTsResolve, loadTsModule } from '../helpers/dom-env.mjs'

const bridge = inlineModule(`
  export const Capacitor = { isNativePlatform: () => true }
  export const CapacitorHttp = { get: options => globalThis.shareHttpGet(options) }
`)
installTsResolve({
  stubs: {
    '@capacitor/core': bridge,
    './errors.js': fixtureUrl('url-import-stubs/errors.mjs'),
  },
})
const { shareIdOf, readDeepSeekShare } = await loadTsModule(
  'src/services/chat/history/deepseekShare.ts'
)
const link = 'https://chat.deepseek.com/share/example123'

test('classifies malformed and non-official links before fetching', () => {
  assert.equal(shareIdOf('  ' + link + '?source=mobile  '), 'example123')
  for (const invalid of ['', 'no url', link.replace('https:', 'http:'), link + '/extra']) {
    assert.throws(() => shareIdOf(invalid), { key: 'shareInvalid' })
  }
  for (const foreign of [
    link.replace('.com', '.com.example'),
    link.replace('chat.', 'name@chat.'),
  ]) {
    assert.throws(() => shareIdOf(foreign), { key: 'shareUnofficial' })
  }
})

test('native bridge requests the fixed public endpoint and restores the message tree', async (t) => {
  t.after(() => {
    delete globalThis.shareHttpGet
  })
  const messages = ['USER', 'ASSISTANT'].map((role, index) => ({
    role,
    message_id: index + 1,
    parent_id: index || null,
    inserted_at: 1785318372 + index,
    status: 'FINISHED',
    thinking_enabled: false,
    search_enabled: false,
    accumulated_token_usage: 12,
    fragments: [
      { type: index ? 'RESPONSE' : 'REQUEST', content: index ? '**answer**' : 'question' },
    ],
  }))
  globalThis.shareHttpGet = (options) => {
    assert.equal(options.url, 'https://chat.deepseek.com/api/v0/share/content?share_id=example123')
    assert.equal(options.disableRedirects, true)
    return {
      status: 200,
      data: { code: 0, data: { biz_code: 0, biz_data: { title: 'Topic', messages } } },
    }
  }
  const session = await readDeepSeekShare(link)
  assert.equal(session.title, 'Topic')
  assert.equal(session.rootMessageId, '1')
  assert.equal(session.messages[1].parentId, '1')
  assert.equal(session.messages[1].blocks[0].text, '**answer**')
  globalThis.shareHttpGet = () => ({
    status: 200,
    data: { code: 0, data: { biz_code: 1, biz_msg: 'share does not exist' } },
  })
  await assert.rejects(readDeepSeekShare(link), { key: 'shareUnavailable' })
})

// ---------------------------------------------------------------------------
// 带附件的分享导入（bug：整段会话 shareUnreadable）
//
// 根因 A：schema.ts 的 fileEntry 要求可空字段**显式 null**、inserted_at 是 ISO 字符串，
//         而 deepseekShare 把分享的 files[] 原样透传 → 整个 FILE 片段被 fragment() 吞成 null
//         → 「片段数量必须一致」的比对把整段会话判死。
// 根因 B：`local.skipped.length` 被当成致命，而 skipped 在 toLocal.ts 里本是降级语义（#49）。
//
// 下面的用例用**真实分享形状**（message_id / unix 秒 / 可空字段缺省）搭 body，
// 断言口径统一为：文字必须进来，坏附件只能降级。
// ---------------------------------------------------------------------------

/** 分享正文的一条消息：分享用 message_id、unix 秒，其余按官方接口形状给。 */
const shareMessage = (index, fragments, over = {}) => ({
  role: index % 2 ? 'ASSISTANT' : 'USER',
  message_id: index + 1,
  parent_id: index || null,
  inserted_at: 1785318372 + index,
  status: 'FINISHED',
  thinking_enabled: false,
  search_enabled: false,
  accumulated_token_usage: 12,
  fragments,
  ...over,
})

const shareBody = (messages, title = 'Topic') => ({
  code: 0,
  data: { biz_code: 0, biz_data: { title, messages } },
})

/** 跑一次导入并把 fetch 桩装好拆好。 */
const readShare = async (t, body) => {
  globalThis.shareHttpGet = () => ({ status: 200, data: body })
  t.after(() => {
    delete globalThis.shareHttpGet
  })
  return readDeepSeekShare(link)
}

/** 用户消息：文字在 content 上；助手消息：文字在 text 块里。 */
const textOf = (session, index) => {
  const message = session.messages[index]
  return message.role === 'user'
    ? message.content
    : message.blocks
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('')
}

test('带 FILE 片段且缺 token_usage / export_path / width,height 时导入成功，文字完整', async (t) => {
  const body = shareBody([
    shareMessage(0, [
      { type: 'REQUEST', content: '看看这份附件' },
      {
        type: 'FILE',
        files: [
          // 官方分享的 files[]：没有 token_usage / export_path / width / height
          { id: 'f1', file_name: 'report.pdf', file_size: 2048, is_image: false, inserted_at: 1785318372 },
        ],
      },
    ]),
    shareMessage(1, [{ type: 'RESPONSE', content: '收到，是 PDF。' }]),
  ])
  const session = await readShare(t, body)
  assert.equal(session.title, 'Topic')
  assert.equal(session.messages.length, 2)
  assert.equal(textOf(session, 0), '看看这份附件')
  assert.equal(textOf(session, 1), '收到，是 PDF。')
  // 附件仍然在（普通附件没有字节可迁移，但身份 / 名字 / 大小必须留着）
  assert.equal(session.messages[0].files.length, 1)
  assert.equal(session.messages[0].files[0].name, 'report.pdf')
  assert.equal(session.messages[0].files[0].size, 2048)
  assert.equal(session.messages[0].files[0].isImage, false)
})

test('FILE 片段里 inserted_at 是 unix 秒时导入成功（schema 要的是 ISO）', async (t) => {
  const body = shareBody([
    shareMessage(0, [
      { type: 'REQUEST', content: '时间戳是秒' },
      {
        type: 'FILE',
        files: [
          { id: 'f1', file_name: 'a.txt', file_size: 10, is_image: false, inserted_at: 1785318372 },
        ],
      },
    ]),
    shareMessage(1, [{ type: 'RESPONSE', content: 'ok' }]),
  ])
  const session = await readShare(t, body)
  assert.equal(textOf(session, 0), '时间戳是秒')
  assert.equal(session.messages[0].files.length, 1)
  assert.equal(session.messages[0].files[0].id, 'f1')
  assert.equal(session.messages[0].files[0].name, 'a.txt')
})

test('is_image: true 且 export_path 为 null 时导入成功，附件仍在（图片，无字节）', async (t) => {
  const body = shareBody([
    shareMessage(0, [
      { type: 'REQUEST', content: '这张图' },
      {
        type: 'FILE',
        files: [
          {
            id: 'img1',
            file_name: 'shot.png',
            file_size: 99,
            is_image: true,
            export_path: null,
            inserted_at: 1785318372,
          },
        ],
      },
    ]),
    shareMessage(1, [{ type: 'RESPONSE', content: '图片收到' }]),
  ])
  const session = await readShare(t, body)
  assert.equal(textOf(session, 0), '这张图')
  assert.equal(session.messages[0].files.length, 1)
  assert.equal(session.messages[0].files[0].isImage, true)
  // 没有 ZIP / 原件，字节必然为空 —— 但条目本身要保住
  assert.equal(session.messages[0].files[0].mimeType, '')
})

test('export_path 指向别的会话目录（真实导出形状）时导入成功，文字保住、附件降级', async (t) => {
  const body = shareBody([
    shareMessage(0, [
      { type: 'REQUEST', content: '对方设备里的图片' },
      {
        type: 'FILE',
        files: [
          {
            id: 'img1',
            file_name: 'shot.png',
            file_size: 99,
            is_image: true,
            // 分享带的是**对方会话目录**的路径，本机合成 id 不可能对上
            export_path: 'chat_sessions/original-session_files/img1_shot.png',
            inserted_at: 1785318372,
          },
        ],
      },
    ]),
    shareMessage(1, [{ type: 'RESPONSE', content: '正文不许丢' }]),
  ])
  const session = await readShare(t, body)
  assert.equal(textOf(session, 0), '对方设备里的图片')
  assert.equal(textOf(session, 1), '正文不许丢')
  assert.equal(session.messages.length, 2)
  // 附件降级：条目留着，字节没有
  assert.equal(session.messages[0].files.length, 1)
  assert.equal(session.messages[0].files[0].mimeType, '')
})

test('完全不含 FILE 的纯文本分享行为不变（回归）', async (t) => {
  const body = shareBody([
    shareMessage(0, [{ type: 'REQUEST', content: 'question' }]),
    shareMessage(1, [{ type: 'RESPONSE', content: '**answer**' }]),
  ])
  const session = await readShare(t, body)
  assert.equal(session.rootMessageId, '1')
  assert.equal(session.messages[1].parentId, '1')
  assert.equal(session.messages[1].blocks[0].text, '**answer**')
  assert.equal(session.messages[0].files.length, 0)
})

test('片段里出现未知类型（FOO）时文字保住，未知片段丢弃', async (t) => {
  const body = shareBody([
    shareMessage(0, [
      { type: 'REQUEST', content: '未来版本的片段' },
      { type: 'FOO', content: '本机不认识' },
    ]),
    shareMessage(1, [{ type: 'RESPONSE', content: '认得的照常显示' }]),
  ])
  const session = await readShare(t, body)
  assert.equal(session.messages.length, 2)
  assert.equal(textOf(session, 0), '未来版本的片段')
  assert.equal(textOf(session, 1), '认得的照常显示')
  // 未知片段不许以任何形式残留（用户消息没有 blocks，文字只可能出现在 content 上）
  const rendered = session.messages.flatMap((message) => [
    ...(message.content ? [message.content] : []),
    ...(message.blocks ?? []).map((block) => block.text ?? ''),
  ])
  assert.equal(rendered.some((text) => text.includes('本机不认识')), false)
})
