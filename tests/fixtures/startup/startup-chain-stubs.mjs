/**
 * 产物的**「与用例无关的启动链路」替身清单**（黄金层与 L1 共用同一份）。
 *
 * ## 这个文件解决什么问题
 *
 * 产物冷启动时会自己发几条与本用例无关的请求。它们不是缺陷，也不是「断言过时」：
 * 界面上用户没点任何东西，请求就出去了。若不处理，只有两种结局，两种都是假红/假绿：
 *
 *   · 装了出站总闸的用例 → 记成「未登记出站」→ 红在一条与用例无关的链路上；
 *   · 断言 `console error = 0` 的用例 → 被 `Failed to load resource: 4xx` 带红。
 *
 * 所以它们在这里被登记成**外部服务的替身**（与 `chat-stubs` / `url-import-stubs` 同类），
 * 而不是加进白名单：**总闸的断言一个字都没放宽** —— `host + path` 仍要精确匹配，桩之外照样
 * 「未登记 → abort → 红」；哪天上游改了路径（或产物改成往别处发），请求立刻又变成未登记，
 * 当场红给你看。
 *
 * ## 清单（每条都注明「为什么和用例无关」）
 *
 * 1. `builtin-key-claim` —— #803 × `TEST_AUTH_SEAM=1`：接缝让产物以为「已登录」，
 *    于是未配置首屏会真的走「登录后自动领内置 Key」，冷启动 2 次 `GET apia.ecsafe.cn/api/v1/keys` → 401。
 *    实现**复用** `consume-gateway-stubs/builtin-key-claim.mjs`（不抄第二份）。
 * 2. `consume-profile` —— 2026-11-24 设置改版：一进「账户与消费」就拉一次 `/api/v1/user/profile`。
 *    实现**复用** `consume-gateway-stubs/account-consume-chain.mjs`。
 * 3. `startup-announcements` —— 公告清单：`<分发机>/announcements.json`（主备两台，`RELEASE_BASES`）。
 *    **接缝构建跳过它**（`src/utils/testSeam.ts` 的第 1 条启动副作用）；但发布形态产物
 *    （G16 用的 `dist-noseam`）会真拉，且拉不到还会主备各试一次。这里按「没有公告」应答。
 * 4. `startup-release-manifest` —— 启动检查更新：`<分发机>/releases.json`（同一套主备）。
 *    接缝构建同样跳过；发布形态会真拉。这里按「没有清单」应答（404 → `checkUpdateGate` 判 `none`，
 *    `src/services/updateGate.ts` 第 2 步写明「拉不到 / 超时 / 解析失败一律 none」）。
 *
 * 3、4 只对**发布形态**产物生效：接缝产物根本不发这两条请求，桩装着也不会被命中（无副作用）。
 *
 * ## 为什么 host 是字面量，不读 `config/endpoints.json`
 *
 * 分发机地址写死在这里是**故意的**：读配置会让「产物改成往另一台机器要清单」跟着桩一起漂移，
 * 于是改道永远抓不到 —— 那正是 #667 要守的那件事。地址真变了（换分发机）时，这里应当红一次、
 * 由人确认「是换机器，不是改道」，和 `consume-gateway-stubs/builtin-key-claim.mjs` 里
 * `CONSUME_GATEWAY_HOST` 的处理口径一致。
 */

import { BUILTIN_KEY_CLAIM_STUB } from '../consume-gateway-stubs/builtin-key-claim.mjs'
import { CONSUME_ACCOUNT_STUBS } from '../consume-gateway-stubs/account-consume-chain.mjs'

/** 分发机（`config/endpoints.json` 的 `download.primaryBase` / `fallbackBase`，录制时的值） */
export const RELEASE_HOSTS = ['jingluo.nekoai.com.cn', 'dl.rose7.cn']

/**
 * 网关侧的两条（领 Key / 账号资料）—— 就是 L1 `openApp()` 一直默认装的那两条，
 * 这里只做「同一份清单」的搬运，语义一个字没改。
 */
export const GATEWAY_STARTUP_STUBS = [BUILTIN_KEY_CLAIM_STUB, ...CONSUME_ACCOUNT_STUBS]

/** 公告清单：按「这台机器上没有任何公告」应答（空数组是合法清单，见 `parseAnnouncements`） */
export const ANNOUNCEMENTS_STUBS = RELEASE_HOSTS.map((host) => ({
  name: `startup-announcements@${host}`,
  host,
  path: /^\/announcements\.json$/u,
  respond: () => ({
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ announcements: [] }),
  }),
}))

/** 版本清单：按「没有发布清单」应答（404 → 启动检查更新判 `none`，fail-open 是产品既有口径） */
export const RELEASE_MANIFEST_STUBS = RELEASE_HOSTS.map((host) => ({
  name: `startup-release-manifest@${host}`,
  host,
  path: /^\/releases\.json$/u,
  respond: () => ({
    status: 404,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ error: 'no manifest' }),
  }),
}))

/** 发布形态产物（`dist-noseam`）冷启动会真发的两条 */
export const DIST_STARTUP_STUBS = [...ANNOUNCEMENTS_STUBS, ...RELEASE_MANIFEST_STUBS]

/** 黄金层的默认清单：网关两条 + 分发机两条（接缝产物只命中前两条，互不干扰） */
export const STARTUP_CHAIN_STUBS = [...GATEWAY_STARTUP_STUBS, ...DIST_STARTUP_STUBS]
