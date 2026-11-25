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
