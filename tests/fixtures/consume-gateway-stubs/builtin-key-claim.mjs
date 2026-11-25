/**
 * 内置服务（ours）Key 的**领取 / 查重**接口桩。
 *
 * ## 为什么 L1 需要它（这不是「为了变绿而放宽」）
 *
 * `TEST_AUTH_SEAM=1` 让产物以为「已登录」。而 #803 之后，**已登录 + 未配置**的首屏会真的走
 * 「登录后自动领内置 Key」这条链：先查重
 * `GET https://apia.ecsafe.cn/api/v1/keys?page=1&page_size=20&search=app-<设备前缀>`，
 * 实测**每次冷启动 2 次**（同一个 URL）。接缝下没有真 JWT，于是拿到 401。
 *
 * 后果有两层，都不是被测物本身的错：
 *   · 带出站总闸的用例（`installEgressGate`）把它记成「未登记出站」→ 红在一个与本用例无关的链路上；
 *   · 没装总闸但断言「console error 必须为 0」的用例，被那条 `Failed to load resource: 401` 带红。
 *
 * 所以它在 L1 里的正确定位是**外部服务的替身**（与 chat-stubs / url-import-stubs 同类）：就地按
 * 「这台设备还没有服务端下发的 Key」应答（空列表）。领取流程本身照旧在产物里跑，只是不出网、
 * 不打 console 错误 —— 总闸的断言**一个字没放宽**：真有人往别处发，照样红；桩的路径写错
 * （服务端把 `/keys` 改了）会立刻红，因为那时请求又会变成「未登记出站」。
 *
 * ## 两种用法
 *
 * 用 `installEgressGate` 的用例：把 {@link BUILTIN_KEY_CLAIM_STUB} 放进 `stubs` 数组
 * （总闸的白名单与「桩命中」记账都由它统一管）。
 *
 * 自己 `page.route` 的用例：调 {@link installBuiltinKeyClaimStub}（`scope` 可以是 page 或 context）。
 */

/** 领取接口的 host（付费网关；与 `config/endpoints.json` 的 consume base 同源） */
export const CONSUME_GATEWAY_HOST = 'apia.ecsafe.cn'

/** `installEgressGate({ stubs })` 用的桩描述 */
export const BUILTIN_KEY_CLAIM_STUB = {
  name: 'builtin-key-claim',
  host: CONSUME_GATEWAY_HOST,
  path: /^\/api\/v1\/keys$/,
  respond: () => ({
    status: 200,
    headers: { 'content-type': 'application/json' },
    // 空列表 = 「这台设备还没有服务端下发的 Key」。产物会据此判断「没领到」，与未配置首屏一致。
    body: JSON.stringify({ items: [], total: 0 }),
  }),
}

/**
 * 给没有装出站总闸的用例：直接在 page / context 上装同一条桩。
 * @param {import('playwright').Page | import('playwright').BrowserContext} scope
 */
export const installBuiltinKeyClaimStub = async (scope) => {
  await scope.route(`**/${CONSUME_GATEWAY_HOST}/api/v1/keys**`, (route) =>
    route.fulfill({
      status: 200,
      headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
      body: JSON.stringify({ items: [], total: 0 }),
    })
  )
}
