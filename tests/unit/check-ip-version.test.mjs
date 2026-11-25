// [layer: unit | dependencies: none | no build, browser, network or Android]
//
// `pnpm run check:ip` 的判定规则自测（scripts/check-hardcoded-ip.mjs + scripts/lib/hardcodedIpAudit.mjs）。
//
// 背景：四段点分十进制的**版本号**（模拟器 35.1.2.0、Chrome 120.0.6099.230）和 IPv4 语法上完全一样，
// 段范围校验也救不了，所以门禁加了一条「版本语境豁免」。这条豁免最容易走宽成漏报，所以这里两头都钉：
//   1. 版本号不该报（注释 / 字符串 / 文档风格三种位置）；
//   2. 真写死的公网地址必须照报 —— 包括写在注释里的，以及「版本号 + 真地址」混写在一行的。
//
// #274 收窄了「线上地址白名单」的豁免范围：白名单主机（config/endpoints.json 的 allowedHosts）
// 只在**注释行**里放过；代码行里再写一次地址照样报（地址只能来自配置）。豁免的另一半边界 ——
// 「注释里提到白名单**外**的地址仍然必须判」—— 单独一条用例，见文件末尾那条 #875 之后的用例。
// #507：`__ENDPOINTS__` 全局兜底 —— 装载即挂（幂等）。单跑本文件（不经 run-layer 的 `--import` 预加载）也不会
// `ReferenceError: __ENDPOINTS__ is not defined`；走门禁时与预加载是同一份模块，无副作用叠加。
import '../helpers/injected.mjs'

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ALLOWED_HOSTS, isCommentOnlyLine, isVersionContext, scanText } from '../../scripts/lib/hardcodedIpAudit.mjs'
import { consumeBaseUrl } from '../../scripts/lib/endpoints.mjs'

const ips = (text) => scanText(text).map((hit) => `${hit.line}:${hit.ip}`)

test('check:ip 版本号不算写死 IP：模拟器版本号写在注释里', () => {
  // 这一行就是当初把门禁打红的原文（scripts/compat/lib/device.mjs 第 7 行）
  const line =
    '//   - 模拟器固定用 SDK 里现有的 35.1.2.0（不要升级，`emulator-37.2.13.bak` 是留给别人的备份）；'
  assert.deepEqual(ips(line), [])
})

test('check:ip 版本号不算写死 IP：字符串字面量与模板串', () => {
  assert.deepEqual(ips("export const EMULATOR_VERSION = '35.1.2.0'"), [])
  assert.deepEqual(ips('const CHROME_VERSION = "120.0.6099.230"'), [])
  assert.deepEqual(ips('const label = `WebView version ${WEBVIEW_VERSION ?? "35.1.2.0"}`'), [])
})

test('check:ip 版本号不算写死 IP：README 风格的注释与 AVD 名', () => {
  assert.deepEqual(ips('<!-- 模拟器版本 35.1.2.0，取证矩阵见下 -->'), [])
  // AVD 名（compat-api26 …）不是四段点分十进制，本来就不该进候选
  assert.deepEqual(ips('SERIAL=emulator-5554 AVD=compat-api26/28/29/30/31'), [])
})

test('check:ip 版本语境有主机/地址语义词时作废：注释里的真 IP 照报', () => {
  assert.deepEqual(ips('// 生产环境 62.106.70.167'), ['1:62.106.70.167'])
  assert.deepEqual(ips('// 服务器版本 1.2.3.4'), ['1:1.2.3.4'])
  assert.deepEqual(ips('// host: 62.106.70.167'), ['1:62.106.70.167'])
  // 「A → B 迁移」这种写法两个地址都要报。历史：这行原文的 B 是 `140.210.13.146`（旧邀请服务），
  // 它当年在 `config/endpoints.json` 的 `allowedHosts` 里，于是靠「白名单主机写在注释里算说明文字」
  // 这条豁免只报了前一个；#745 / #869 把网关收敛到 `apia.ecsafe.cn` 之后它不再是白名单主机。
  // 这里刻意换成两段**都不在**白名单的地址：本行判的是「地址语义词一票否决版本语境豁免」，
  // 与当前白名单内容无关，不该随着配置里有没有那个 IP 忽红忽绿。
  assert.deepEqual(ips('// 62.106.70.167 -> 8.8.8.8 迁移'), ['1:62.106.70.167', '1:8.8.8.8'])
  // check-endpoints-allow：规则自测必须喂地址字面量，才能证明「写进去会红」
  assert.deepEqual(ips('// 旧机 8.8.8.8 已下线，webview 版本另说'), ['1:8.8.8.8'])
  // 代价（明知并接受）：「迁移 + 版本号」混写的行，版本号也会被一并报出来，用 check-ip-allow 拆开
  assert.deepEqual(ips('// 迁移：模拟器版本 35.1.2.0'), ['1:35.1.2.0'])
})

test('check:ip 代码里写死的地址照报（版本语境豁免不能放过它）', () => {
  assert.deepEqual(ips("const HOST = '1.2.3.4'"), ['1:1.2.3.4'])
  assert.deepEqual(ips("const API = '62.106.70.167'"), ['1:62.106.70.167'])
  assert.deepEqual(ips('fetch("http://62.106.70.167/v1/chat")'), ['1:62.106.70.167'])
  assert.deepEqual(ips("export const BASE_URL = '8.8.8.8'"), ['1:8.8.8.8'])
})

test('check:ip 一行里列两个版本号不误报（版本区间 / 差分）', () => {
  assert.deepEqual(ips('// build 35.1.2.0 → 37.2.13.0 的差分只看渲染'), [])
  assert.deepEqual(ips('// 模拟器版本 35.1.2.0 / 37.2.13.0 两档'), [])
})

test('check:ip 白名单主机：注释行放过、代码行照报（#274 收窄），保留段豁免不变', () => {
  /**
   * #274 的「白名单主机」豁免只对**注释行**生效；同一串地址写进代码行照样报，并在
   * `reason` 上标成 `allowed-host-in-code`（CLI 据此给出「走 __ENDPOINTS__」的建议）。
   *
   * 这条机制现在**没有生效对象**：白名单唯一来源是 `config/endpoints.json` 的 `allowedHosts`，
   * 而它从 #869 起是域名 `apia.ecsafe.cn`（不是 IP 字面量），扫描器只认四段点分十进制，
   * 永远不会命中。以前这里拿 `140.210.13.146`（旧邀请服务）当样本，那台机器已从白名单删除，
   * 于是同样的写法现在按「普通写死地址」判红 —— 断言红在了样本过期上，而不是机制坏了。
   *
   * 所以改成**按配置数据驱动**：白名单里有 IP 字面量就照机制两头钉（注释放过 / 代码照报）；
   * 没有就显式记下「这条分支暂时没有生效对象」，而不是把断言删掉假装它被验过。
   * 一旦有人把某个 IP 加回 `allowedHosts`（本地联调实例那类），这些断言立刻重新咬住。
   */
  const whitelistedIps = [...ALLOWED_HOSTS].filter((host) => /^\d{1,3}(\.\d{1,3}){3}$/.test(host))

  // 白名单这条路必须还挂着：它非空，且装着**当前 consume 网关**的主机。
  // 这一条与有没有 IP 无关，所以不管上面那个分支今天是否有效都能验 —— 白名单被清空 / 改名成
  // 别的主机时，`check:ip` 会把所有线上地址一起判成「写死地址」，那是另一种事故。
  const gatewayHost = new URL(consumeBaseUrl).hostname
  assert.ok(ALLOWED_HOSTS.has(gatewayHost), `allowedHosts 必须含当前 consume 网关 ${gatewayHost}（实际：${[...ALLOWED_HOSTS].join(', ')}）`)
  if (whitelistedIps.length === 0) {
    // 显式记下「这条分支今天没有生效对象」，而不是把断言删掉假装它被验过。
    assert.equal(
      [...ALLOWED_HOSTS].filter((host) => /^\d{1,3}(\.\d{1,3}){3}$/.test(host)).length,
      0,
      '当前白名单里没有 IP 字面量 → 「注释放过」分支无生效对象（加回一个 IP 即重新咬住）',
    )
  }

  for (const host of whitelistedIps) {
    // 注释行里的白名单地址是说明文字（不参与运行）—— 放过
    assert.deepEqual(ips(`// 对话上游在 ${host}:60010`), [], `${host} 在注释里应放过（白名单主机）`) // check-endpoints-allow：规则自测输入
    // 代码行里再写一次 = 违规：地址只能来自 config/endpoints.json（#274 之前这里是整行放过，
    // 于是「再写死一次」永远绿，门禁的保护方向是反的）。
    const hostLiteral = `const host = '${host}'` // check-endpoints-allow：规则自测输入
    assert.deepEqual(ips(hostLiteral), [`1:${host}`], `${host} 写进代码行必须报`)
    assert.equal(
      scanText(hostLiteral)[0].reason,
      'allowed-host-in-code',
      '命中原因标成「白名单主机写进了代码」，CLI 据此给出「走 __ENDPOINTS__」的建议',
    )
  }

  // 非白名单地址写在注释里照报：注释里的死地址会把人带沟里（旧池 IP 就是这一类）
  const retired = '140.210.13.146' // check-endpoints-allow：规则自测输入
  assert.deepEqual(ips(`// 对话上游在 ${retired}:60010`), [`1:${retired}`], '已下线的主机写进注释也要报')
  assert.equal(scanText(`const host = '${retired}'`)[0].reason, 'hardcoded', '非白名单地址的原因是 hardcoded')

  // 保留段 / 回环与之前一致
  assert.deepEqual(ips("const HOST = '127.0.0.1'"), [])
  assert.deepEqual(ips("const HOST = '192.168.1.10'"), [])
  assert.deepEqual(ips("const HOST = '169.254.1.1'"), [])
  assert.deepEqual(ips("const HOST = '100.64.0.1'"), [])
  assert.deepEqual(ips("const HOST = '203.0.113.9'"), []) // RFC 5737 TEST-NET-3：保留测试段
  assert.deepEqual(ips("const HOST = '198.51.100.7'"), []) // RFC 5737 TEST-NET-2
})

/**
 * 豁免的**另一半边界**（#875 之后补）：注释行放过的只是「白名单主机」，不是「整行 / 整段注释」。
 *
 * 为什么单独钉：`allowedHosts` 从 #875 起只剩域名 `apia.ecsafe.cn`，扫描器只认四段点分十进制 ——
 * 上一条用例里「注释放过白名单主机」那个分支**今天没有生效对象**。于是「这条豁免有没有宽成
 * 什么都放过」就没有正向样本可验了；答案只能从反面钉：把白名单**外**的地址放进同一批注释形态里，
 * 每一条都必须照报。判据一旦退化成「注释行整行跳过」，下面每一条都会掉成空数组 → 当场红。
 */
test('check:ip 白名单外地址写在注释里仍然必须判（豁免只放过白名单主机，不放过整行注释）', () => {
  // 样本先自证**不在**白名单。#875 之前那两条断言坏掉的方式正是「样本过期」：`140.210.13.146`
  // 被移出 allowedHosts 之后，断言红在了样本上，看起来却像门禁坏了。把前提写成断言，红了能归因。
  const outside = '62.106.70.167' // check-endpoints-allow：规则自测输入
  assert.equal(
    ALLOWED_HOSTS.has(outside),
    false,
    `样本 ${outside} 不该在 allowedHosts 里（实际：${[...ALLOWED_HOSTS].join(', ')}）——若它被加回白名单，换一个白名单外的样本再来验`,
  )

  // 四种注释前缀（`//` `/*` ` * ` `#`）：判据里有、断言里也得有，否则删掉哪一种前缀都不会红。
  assert.deepEqual(ips(`// 对话上游在 ${outside}:60010`), [`1:${outside}`], '`//` 注释里的白名单外地址照报') // check-endpoints-allow：规则自测输入
  assert.deepEqual(ips(`/* 上游 ${outside} */`), [`1:${outside}`], '`/* … */` 单行块注释里的白名单外地址照报') // check-endpoints-allow：规则自测输入
  assert.deepEqual(ips(` * 邀请服务 http://${outside}:60013`), [`1:${outside}`], '` * ` 块注释续行里的白名单外地址照报') // check-endpoints-allow：规则自测输入
  assert.deepEqual(ips(`# 上游 ${outside}`), [`1:${outside}`], '`#` 注释里的白名单外地址照报') // check-endpoints-allow：规则自测输入
  // 同一行两段都在白名单外的地址：一个都不许少（豁免是逐地址判，不是「这行有白名单主机就整行放过」）
  assert.deepEqual(ips(`// 旧机 ${outside} 换到 8.8.8.8`), [`1:${outside}`, '1:8.8.8.8'], '一行两个白名单外地址都报') // check-endpoints-allow：规则自测输入

  // 反向：行尾注释**不是**注释行。否则豁免会宽成「这一行里出现过 `//` 就整行放过」——
  // 而「代码行 + 行尾注释」正是写死地址最常见的形状，#274 那条收窄就跟着作废了。
  assert.equal(isCommentOnlyLine(`const host = 'x' // 上游 ${outside}`), false, '行尾注释不算注释行')
  assert.deepEqual(ips(`const host = '${outside}' // 上游`), [`1:${outside}`], '代码行 + 行尾注释：照报') // check-endpoints-allow：规则自测输入
  for (const line of ['// 注释', ' * 注释', '/* 注释 */', '# 注释']) {
    assert.equal(isCommentOnlyLine(line), true, `「${line}」应判为注释行（判据与上面四条断言同源）`)
  }
})

test('check:ip 行内 check-ip-allow 豁免仍然生效（本行与上一行）', () => {
  assert.deepEqual(ips("const OLD = '62.106.70.167' // check-ip-allow：已下线主机名单"), [])
  assert.deepEqual(ips('// check-ip-allow：下面是下线主机名单\n  "62.106.70.167",'), [])
})

test('check:ip 行号从 1 起、按出现顺序', () => {
  const text = ['export const A = 1', "const x = '8.8.8.8'", '', "const y = '9.9.9.9'"].join('\n')
  assert.deepEqual(ips(text), ['2:8.8.8.8', '4:9.9.9.9'])
})

test('check:ip 二进制（含 NUL）与空文本不产生命中', () => {
  assert.deepEqual(ips("const x = '8.8.8.8'\u0000"), [])
  assert.deepEqual(ips(''), [])
})

test('check:ip 版本语境判定：版本词有、主机词无', () => {
  assert.equal(isVersionContext('// 模拟器版本 35.1.2.0'), true)
  assert.equal(isVersionContext('const EMULATOR_VERSION = "35.1.2.0"'), true)
  assert.equal(isVersionContext('// 生产环境 62.106.70.167'), false)
  assert.equal(isVersionContext('// version 62.106.70.167 (server)'), false)
  // 上一行是版本行、本行只有一个候选时也算版本语境
  assert.equal(isVersionContext('  35.1.2.0', '// 模拟器版本：'), true)
})
