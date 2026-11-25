// [layer: integration | 依赖: playwright + chromium + 本地静态服务/mock 上游 | 耗时: 1~3 分钟] 说明见 tests/README.md
// 回归防线：未填 API Key 时点「测试」不应该发出任何探测请求，而是给出明确提示
// （防止再次回到「发空 Bearer」的老 bug）。
//
// 跑法：cd /root/deepseek-app && node tests/integration/probe-nokey.test.mjs
import {
  captureProbeRequests,
  clickTest,
  fillApiKey,
  finish,
  openApp,
  openSettingsDataSection,
} from '../helpers/helpers.mjs'

const name = 'tests/integration/probe-nokey.test.mjs'
const { browser, page } = await openApp()
const failures = []
try {
  await openSettingsDataSection(page)

  // 输入框留空（store 里也没有已保存的 Key）。按「当前展开那一行」面板取，见 helpers.fillApiKey：
  // 来源页第三方/官方两份面板各有一个 `settings-source-draft-apiKey`，裸 `input[type="password"]`
  // 会先命中当前 `hidden` 的那一个（实测 30s `element is not visible`）。
  await fillApiKey(page, '')

  const captured = captureProbeRequests(page)
  await clickTest(page)
  await page.waitForTimeout(3000)

  if (captured.length > 0) {
    failures.push(`未填 Key 却发出了请求：${captured[0].url}（authorization=${JSON.stringify(captured[0].authorization)}）`)
  } else {
    console.log('ok: 未发请求')
  }

  const hint = page.getByText(/请先填写 API Key|Enter an API Key first/)
  if ((await hint.count()) === 0) {
    failures.push('界面没有给出「请先填写 API Key」提示')
  } else {
    console.log(`ok: 提示文案 = ${JSON.stringify((await hint.first().innerText()).trim())}`)
  }
} catch (error) {
  // 这个文件原来只有 try/finally：中途抛异常（选择器点不到、面板没展开）时 finally 会**先打印 PASS**
  // 再让异常冒泡，日志上像通过、runner 仍判 FAIL。补 catch，让失败如实落在断言列表里。
  failures.push(`用例异常：${error instanceof Error ? error.message : String(error)}`)
} finally {
  await finish(browser, name, failures)
}
