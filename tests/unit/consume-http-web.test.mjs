// [layer: unit | 依赖: 无（纯 Node：stub `globalThis.fetch`，零网络） | 耗时: <1s]
//
// 消费侧通道从「只支持原生」放开到「原生 + Web 浏览器 fetch」的接缝用例。
//
// 为什么这条接缝要单独钉住：`src/services/consume/http.ts` 的文件头原来写着
// 「sub2api 的 CORS `allowed_origins` 默认是空数组，所以没有 fetch 兜底」。**那个前提在生产网关上
// 不成立**（2026-11-23 实测 `https://apia.ecsafe.cn`：预检 `OPTIONS /api/v1/payment/orders/my`
// → 204 + `access-control-allow-origin: *` + `allow-headers` 含 `Authorization`；
// `GET /api/v1/pay-link` → 200 带 `*`；无 token 的 `GET /api/v1/payment/orders/my` → 401 仍带 `*`；
// 后端 `cors: { allowed_origins: ["*"], allow_credentials: false }`）。所以浏览器能直接 fetch，
// **但 `*` 不带凭据**：身份只能走 `Authorization` 头，绝不进 query。
//
// 这里钉的是「分派之后那条 Web 实现与原生同形同语义」，不是「fetch 能不能通」——
// 网络与 CORS 是部署侧的事，单元层不测；所以 `globalThis.fetch` 一律换成替身，零网络。
//
// 断言清单（逐条对应任务 §3）：
//   W1 非原生 + fetch 可用 → `response`，`status` / `text` / `location` 都对（`Location` 大小写不敏感）；
//   W2 fetch 抛 AbortError / 超时到期被 abort → `timeout`（两条路径都走同一个 `failureOf`）；
//   W3 fetch 抛普通网络错误 → `network`（不许被误折成 timeout）；
//   W4 `typeof fetch !== 'function'` → `unsupported`（这是「跑不了」，不是「网络不好」）；
//   W5 请求头原样带出（`Authorization` 逐字比对），且 `credentials: 'omit'`（凭据只进 header）；
//   W6 **重定向有意与原生不同**：`init.redirect === 'follow'`（跨域 `manual` 只会给 opaque-redirect，
//      既读不到 Location、又把本该自动过去的 3xx 变成「连不上」，见 webRequest 注释）。
//
//   node --test tests/unit/consume-http-web.test.mjs

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { installResolveHooks } from '../helpers/contract.mjs'

installResolveHooks()

const { Capacitor } = await import('@capacitor/core')
// 静态 import 也可，但这里跟同层其它用例一致用动态 import：解析钩子（`.js → .ts`）先装好
const { capacitorTransport } = await import('../../src/services/consume/http.ts')

/** 一次典型的面板请求（GET，JWT 走 Authorization 头 —— 与 `createConsumeHttp` 拼出来的形状一致） */
const request = (overrides = {}) => ({
  method: 'GET',
  url: 'https://consume.test/api/v1/payment/orders/my',
  headers: { accept: 'application/json', authorization: 'Bearer jwt-abc' },
  timeoutMs: 5000,
  ...overrides,
})

/** 假的 `Response`（只实现这条实现真正用到的两样：`status` / `headers` / `text()`） */
const fakeResponse = (status, body, headerPairs) => ({
  status,
  headers: new Headers(headerPairs),
  text: async () => body,
})

/** 把 `globalThis.fetch` 换成替身，跑完无论如何还原（不留脏全局给后面的用例） */
const withFetch = async (impl, run) => {
  const calls = []
  const original = globalThis.fetch
  const had = 'fetch' in globalThis
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    return impl(url, init)
  }
  try {
    return await run(calls)
  } finally {
    if (had) {globalThis.fetch = original}
    else {delete globalThis.fetch}
  }
}

const abortError = () => Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })

test('[W1] 非原生 + fetch 可用：返回 response，status / text / location 都对', async (t) => {
  // 前提：Node 里 `Capacitor.isNativePlatform()` 就是 false —— 被测的正是非原生那条分支
  assert.equal(Capacitor.isNativePlatform(), false, 'Node 里不是原生平台（这条用例的前提）')
  assert.equal(typeof capacitorTransport, 'function', '传输层是函数')

  const body = JSON.stringify({ code: 0, message: 'success', data: { items: [], total: 0 } })
  await withFetch(
    () =>
      fakeResponse(302, body, [
        // 故意用大写 `Location`：断言的是「大小写都兼容」
        ['Location', 'https://consume.test/login?next=/orders'],
        ['Content-Type', 'application/json'],
      ]),
    async (calls) => {
      const result = await capacitorTransport(request())
      assert.equal(calls.length, 1, '真发了一次（不是 unsupported 直接返回）')
      assert.equal(result.kind, 'response', '拿到了响应')
      assert.equal(result.status, 302, '状态码原样透出（不跟随重定向，所以就是 3xx 本身）')
      assert.equal(result.text, body, 'body 原样透出（responseType: text 的等价物）')
      assert.equal(
        result.location,
        'https://consume.test/login?next=/orders',
        'location 从响应头读到（大写 Location 也认）'
      )
      assert.equal(result.headers['content-type'], 'application/json', '响应头 key 小写化')
      assert.equal(result.headers.location, result.location, 'headers 与 location 是同一份值')
    }
  )

  // 没有 Location 头时不能凭空造一个空串（上层拿它拼跳转就会拼出空 URL）
  await withFetch(
    () => fakeResponse(200, '{"code":0}', [['Content-Type', 'application/json']]),
    async () => {
      const result = await capacitorTransport(request())
      assert.equal(result.kind, 'response')
      assert.equal(result.location, undefined, '没有 Location 头 → undefined，不是空串')
    }
  )

  t.diagnostic('W1 ok：非原生走 fetch，response/status/text/location 均正确')
})

test('[W2] 被 abort（空闲即超时）→ timeout', async () => {
  // (a) 替身直接抛 AbortError（等价于 fetch 被 signal 打断）
  await withFetch(
    () => Promise.reject(abortError()),
    async () => {
      const result = await capacitorTransport(request({ timeoutMs: 50 }))
      assert.equal(result.kind, 'timeout', 'AbortError 折成 timeout')
    }
  )

  // (b) 真让 `request.timeoutMs` 到期：替身只在 signal 上等，超时由被测实现自己触发
  const started = Date.now()
  await withFetch(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(abortError()), { once: true })
      }),
    async () => {
      const result = await capacitorTransport(request({ timeoutMs: 20 }))
      assert.equal(result.kind, 'timeout', 'timeoutMs 到期被 abort → timeout')
    }
  )
  const elapsed = Date.now() - started
  assert.ok(elapsed >= 15, `确实等到了超时（elapsed=${elapsed}ms）`)
  assert.ok(elapsed < 2000, `没有把 timer 拖长（elapsed=${elapsed}ms，timeoutMs=20）`)
})

test('[W3] 普通网络错误 → network（不许被误折成 timeout）', async () => {
  await withFetch(
    () => Promise.reject(new TypeError('fetch failed')),
    async () => {
      const result = await capacitorTransport(request())
      assert.equal(result.kind, 'network', 'TypeError: fetch failed 是 network，不是 timeout')
    }
  )

  // 大小写 / 文案都不该影响判定：不含 abort / timeout 字样就一定不是 timeout
  await withFetch(
    () => Promise.reject(new Error('ECONNREFUSED')),
    async () => {
      const result = await capacitorTransport(request())
      assert.equal(result.kind, 'network', 'ECONNREFUSED → network')
    }
  )
})

test('[W4] 没有 fetch（更老的运行环境）→ unsupported', async () => {
  const original = globalThis.fetch
  const had = 'fetch' in globalThis
  // 直接删掉全局 fetch：`typeof fetch !== 'function'` 才是 unsupported 的**唯一**判据
  delete globalThis.fetch
  try {
    assert.equal(typeof fetch, 'undefined', '前提：全局没有 fetch')
    const result = await capacitorTransport(request())
    assert.equal(result.kind, 'unsupported', '没有 fetch 才是 unsupported（跑不了 ≠ 网络不好）')
  } finally {
    if (had) {globalThis.fetch = original}
  }
})

test('[W5] 请求头原样带出：Authorization 只进 header，credentials 为 omit', async () => {
  await withFetch(
    () => fakeResponse(200, '{}', [['Content-Type', 'application/json']]),
    async (calls) => {
      const req = request({ headers: { accept: 'application/json', authorization: 'Bearer sk-live-abc123' } })
      await capacitorTransport(req)
      const init = calls[0].init
      assert.equal(init.headers.authorization, 'Bearer sk-live-abc123', 'Authorization 逐字带出')
      assert.deepEqual(init.headers, req.headers, 'headers 原样透传（不增不减）')
      assert.ok(!calls[0].url.includes('sk-live-abc123'), '凭据绝不进 URL')
      assert.equal(init.credentials, 'omit', '凭据只走 header：CORS 是 *，不带 cookie')
    }
  )
})

test('[W6] 重定向与原生有意不同：redirect 固定为 follow', async () => {
  await withFetch(
    // 跟随之后浏览器给的是「最终那一跳」的响应；这里用 200 + Location 模拟替身的最终结果
    () => fakeResponse(200, 'ok', [['Location', 'https://consume.test/moved']]),
    async (calls) => {
      const result = await capacitorTransport(request())
      assert.equal(
        calls[0].init.redirect,
        'follow',
        "redirect: 'follow'（原生 disableRedirects 是刻意的差异，理由见 webRequest 注释）"
      )
      assert.equal(result.status, 200, '跟随后的最终状态码')
      // location 是原样透传的响应头，消费侧没有调用方读它
      assert.equal(result.location, 'https://consume.test/moved')
    }
  )
})
