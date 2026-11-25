/**
 * 「账户与消费」页自己那条**与用例无关的出站链**：`GET /api/v1/user/profile`。
 *
 * ## 为什么 helper 层要它（替身，不是放宽）
 *
 * 2026-11-24 设置改版后，渠道 / Key / 连通性测试都不在「数据管理」页了，唯一真实路径是
 * **设置 → 账户与消费 → 模型来源**（见 `tests/helpers/helpers.mjs` 的文件头）。只要进了
 * 「账户与消费」这一眼，产物就会拉一次账号资料（`AccountConsumePage` 的 L1 要显示钱包/账号信息）：
 *
 *   实测（`TEST_AUTH_SEAM=1` 标准包）：每挂载一次发 1 次 `GET https://apia.ecsafe.cn/api/v1/user/profile`
 *
 * 接缝下没有真 JWT，于是拿到 401。后果与本目录 `builtin-key-claim.mjs` 一模一样，都不是被测物的错：
 *   · 装了出站总闸的用例把它记成「未登记出站」→ 红在一个与本用例无关的请求上；
 *   · 断言 `console error = 0` 的用例被 `Failed to load resource: 401` 带红。
 *
 * 所以它是**外部服务的替身**：按仓库里已录的真实应答（`tests/fixtures/consume/local-user-profile-200.json`，
 * 2026-11-20 从本地联调实例抓的，凭据已脱敏）回一份 200。**不另抄一份响应体**——直接读那份录包，
 * 录包变了这里跟着变，不会出现「第二份真理」。
 *
 * ## 总闸一个字没放宽
 *
 * 桩只是「本机应答这条 host+path」，host 仍在白名单里登记；请求要是跑到别处（或服务端把
 * `/user/profile` 改名了），照样记「未登记出站」→ 立刻红。
 *
 * ## 为什么 `settings/public` 不在默认清单里
 *
 * 它只在**未登录的账号卡**（`SettingsAuthCard`）与内置服务领取链上才会拉，而接缝构建启动时
 * 被 `__TEST_AUTH_STATE__` 守卫跳过（`src/main.tsx`）。给它装 200 会改变「注册/邀请入口显不显示」
 * 这类**会被断言**的界面，替身就变成改判据了。要测那条链的用例自己把它加进 `stubs`。
 */

import { readFileSync } from 'node:fs'

/** 领取 / 查重接口的 host（与 `config/endpoints.json` 的 consume base 同源） */
const CONSUME_GATEWAY_HOST = 'apia.ecsafe.cn'

/** 录包原文（`tests/fixtures/consume/` 是本仓既有的一份，别再拷一份） */
const recordedBody = (name) => readFileSync(new URL(`../consume/${name}`, import.meta.url), 'utf8')

/** `GET /api/v1/user/profile` 的桩：登录态查询（接缝下没有真 JWT，用它作答） */
export const CONSUME_PROFILE_STUB = {
  name: 'consume-profile',
  host: CONSUME_GATEWAY_HOST,
  path: /^\/api\/v1\/user\/profile$/,
  respond: () => ({
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: recordedBody('local-user-profile-200.json'),
  }),
}

/**
 * `GET /api/v1/settings/public` 的桩（**默认不装**，见文件头最后一段）。
 *
 * 装了它 = 告诉产物「注册开着、邀请码开着…」。只有当用例要断言的是「拿到开关之后长什么样」时才装；
 * 断言「拿不到开关就隐藏」的用例**不许**装。
 */
export const CONSUME_AUTH_FLAGS_STUB = {
  name: 'consume-auth-flags',
  host: CONSUME_GATEWAY_HOST,
  path: /^\/api\/v1\/settings\/public$/,
  respond: () => ({
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: recordedBody('local-settings-public-200.json'),
  }),
}

/** `openApp()` / `installEgressGate()` 默认装的那一组（目前只有账号资料一条） */
export const CONSUME_ACCOUNT_STUBS = [CONSUME_PROFILE_STUB]
