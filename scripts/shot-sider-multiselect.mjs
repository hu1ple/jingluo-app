#!/usr/bin/env node
/**
 * 侧栏「批量删除会话」多选 UI 的验收脚本（设计稿：默认态 / 多选态 / 空选择态 三张并排稿）。
 *
 *   node scripts/shot-sider-multiselect.mjs                    # 默认打 http://127.0.0.1:8120（dev server）
 *   node scripts/shot-sider-multiselect.mjs --base=http://127.0.0.1:8120
 *   node scripts/shot-sider-multiselect.mjs --out=docs/ui
 *
 * 一条命令同时做两件事，输出都可复核：
 *   ① 三张 390×844 截图（视口截图，不是真机截图）：
 *        docs/ui/multiselect-default-390.png  默认态：`历史对话 … 选择`、行尾 `…`、开启新对话可用
 *        docs/ui/multiselect-active-390.png   多选态：全选/取消、圆形勾选、无 `…`、开启新对话禁用、
 *                                             底部「已选 1 项」+ 红色删除
 *        docs/ui/multiselect-empty-390.png    空选择：`已选 0 项` + 删除禁用
 *   ② 一组 DOM / 计算样式 / 键盘 / 窄屏断言（stdout 逐条打印，末尾给 PASS/FAIL 汇总与退出码）。
 *
 * 会话数据是**种进 IndexedDB 的 3 条空会话**（与 scripts/shot-mobile.mjs 的 seedInPage 同一配方），
 * 同时把所有非本机 origin 的请求 abort 掉：本脚本**一条真实请求都不发**，不碰真实后端额度。
 *
 * 为什么不用 `scripts/shot-mobile.mjs`：那个脚本吃的是 `dist/` 构建产物 + 场景注册表，本单要对着
 * 8120 上的 dev server（改一行 CSS 就想复跑），且断言是这条 UI 专属的，独立成脚本更直白。
 */
import path from 'node:path'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const argOf = (name, fallback) => {
  const hit = process.argv.slice(2).find((item) => item.startsWith(`--${name}=`))
  return hit === undefined ? fallback : hit.slice(name.length + 3)
}

const BASE = argOf('base', 'http://127.0.0.1:8120')
const OUT_DIR = path.resolve(ROOT, argOf('out', 'docs/ui'))

/** 与 `src/services/chat/db.ts` 的 DB_VERSION 一致（库版本一变这里必须跟着改，否则 open 会 VersionError） */
const DB_VERSION = 15

/** 3 条会话：两条今天、一条昨天，够撑出分组标题，也让「全选 = 3」有区分度 */
const SESSIONS = [
  { id: 'ms-session-1', title: '帮我写一份季度复盘', createdAt: Date.now() - 1000 * 60 * 30, updatedAt: Date.now() - 1000 * 60 * 20 },
  { id: 'ms-session-2', title: '解释一下 React 并发渲染', createdAt: Date.now() - 1000 * 60 * 50, updatedAt: Date.now() - 1000 * 60 * 40 },
  { id: 'ms-session-3', title: '周报：接口联调进展', createdAt: Date.now() - 1000 * 60 * 60 * 20, updatedAt: Date.now() - 1000 * 60 * 60 * 12 },
]

/** 在页面里把会话写进 IndexedDB（app 自己已经把库开到 v15，这里只 put，不触发 upgrade） */
const seedInPage = async ({ sessions, version }) => {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('chat-demo', version)
    request.onupgradeneeded = () => {
      const opened = request.result
      for (const name of ['sessions', 'files', 'sessionsStaging', 'filesStaging']) {
        if (!opened.objectStoreNames.contains(name)) {
          opened.createObjectStore(name, { keyPath: 'id' })
        }
      }
      const summaries = opened.objectStoreNames.contains('sessionSummaries')
        ? request.transaction.objectStore('sessionSummaries')
        : opened.createObjectStore('sessionSummaries', { keyPath: 'id' })
      if (!summaries.indexNames.contains('fileIds')) {
        summaries.createIndex('fileIds', 'fileIds', { multiEntry: true })
      }
      if (!summaries.indexNames.contains('branchOf')) {
        summaries.createIndex('branchOf', 'branchOf.sessionId')
      }
      if (!opened.objectStoreNames.contains('appAssets')) {
        opened.createObjectStore('appAssets', { keyPath: 'key' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  await new Promise((resolve, reject) => {
    const tx = db.transaction(['sessions', 'sessionSummaries'], 'readwrite')
    for (const session of sessions) {
      tx.objectStore('sessions').put({ ...session, messages: [], rootMessageId: null })
      tx.objectStore('sessionSummaries').put({
        id: session.id,
        title: session.title,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        fileIds: [],
      })
    }
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
  db.close()
  return sessions.length
}

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  —— ${detail}`}`)
}

/** 页内量数：`.sider` 里 `…` 按钮数量、勾选控件形态与配色、底栏位置等 */
const measure = () => {
  const sider = document.querySelector('[data-testid="sider"]')
  const scene = sider ?? document
  const isEllipsisButton = (element) => {
    const label = (element.getAttribute('aria-label') ?? '').trim()
    return element.tagName === 'BUTTON' && (label === '更多' || label === 'More')
  }
  const ellipsisButtons = [...scene.querySelectorAll('button')].filter(isEllipsisButton)
  const boxes = [...scene.querySelectorAll('[role="checkbox"]')]
  const styleOf = (element) => {
    const computed = getComputedStyle(element)
    return {
      borderRadius: computed.borderRadius,
      backgroundColor: computed.backgroundColor,
      color: computed.color,
      width: computed.width,
      height: computed.height,
    }
  }
  const checkCircle = (box) => {
    const circle = box.querySelector('span')
    return circle === null ? null : { ...styleOf(circle), hasCheck: circle.querySelector('svg') !== null }
  }
  const unchecked = boxes.find((box) => box.getAttribute('aria-checked') === 'false') ?? null
  const checked = boxes.find((box) => box.getAttribute('aria-checked') === 'true') ?? null
  return {
    ellipsisCount: ellipsisButtons.length,
    checkboxCount: boxes.length,
    firstBox: boxes[0] === undefined ? null : styleOf(boxes[0]),
    checkedCircle: checked === null ? null : checkCircle(checked),
    uncheckedCircle: unchecked === null ? null : checkCircle(unchecked),
    rowHeights: boxes.map((box) => Math.round(box.getBoundingClientRect().height)),
    footer: document.querySelector('[data-testid="sider-selection-footer"]')?.getBoundingClientRect().toJSON() ?? null,
    footerInsideScroller: (() => {
      const footer = document.querySelector('[data-testid="sider-selection-footer"]')
      const scroller = document.querySelector('[data-testid="sider-list"]')
      return footer !== null && scroller !== null && scroller.contains(footer)
    })(),
    activeRowCount: [...scene.querySelectorAll('[data-testid^="sider-session-"]')].filter((row) =>
      [...row.classList].some((name) => name.startsWith('active-')),
    ).length,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    scrollWidth: document.documentElement.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
  }
}

const run = async () => {
  await mkdir(OUT_DIR, { recursive: true })
  const browser = await chromium.launch()
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    locale: 'zh-CN',
  })
  // 一条真实请求都不放出去（HMR 走同源 websocket，不经过这里）
  await context.route('**', (route) => {
    const url = new URL(route.request().url())
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') {
      return route.continue()
    }
    return route.abort()
  })

  try {
    const warmer = await context.newPage()
    await warmer.goto(BASE, { waitUntil: 'domcontentloaded' })
    await warmer.waitForTimeout(1200)
    const seeded = await warmer.evaluate(seedInPage, { sessions: SESSIONS, version: DB_VERSION })
    await warmer.close()
    console.log(`种子会话：${seeded} 条（IndexedDB，未发任何真实请求）`)

    const page = await context.newPage()
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    const sider = page.locator('[data-testid="sider"]')

    /**
     * 冷启动会自己弹「账户与消费」弹层（本机没登录），它会盖住头部按钮 → 所有点击都被 overlay 吃掉。
     * 用 Esc 关掉（`Modal` 支持 Esc），关不掉再点弹层右上角的关闭按钮。
     */
    const dismissDialogs = async () => {
      for (let i = 0; i < 3; i += 1) {
        if ((await page.locator('[role="dialog"]').count()) === 0) return
        await page.keyboard.press('Escape')
        await page.waitForTimeout(500)
      }
    }
    await dismissDialogs()

    /**
     * 390 视口下侧栏是抽屉（`translateX(-100%)` 时 Playwright 仍算 visible），所以按**包围盒 x** 判断
     * 是不是真的在屏幕里，而不是用 isVisible()。
     */
    const siderOnScreen = () =>
      page.evaluate(() => {
        const element = document.querySelector('[data-testid="sider"]')
        if (element === null) return false
        const rect = element.getBoundingClientRect()
        return rect.x >= -1 && rect.width > 0
      })
    const openSider = async () => {
      if (await siderOnScreen()) return
      await dismissDialogs()
      await page.getByRole('button', { name: /打开边栏|Open sidebar/ }).first().click()
      for (let i = 0; i < 30; i += 1) {
        if (await siderOnScreen()) break
        await page.waitForTimeout(100)
      }
      await page.waitForTimeout(400)
    }
    await openSider()
    await page.waitForTimeout(300)

    const sessionRows = page.locator('[data-testid^="sider-session-"]')
    console.log(`列表里的会话行：${await sessionRows.count()}`)

    // ---------------------------------------------------------------- 默认态
    const defaultShot = path.join(OUT_DIR, 'multiselect-default-390.png')
    await page.screenshot({ path: defaultShot })
    const defaultMeasure = await page.evaluate(measure)
    check('默认态：`.sider` 内 `…` 按钮数量 = 3', defaultMeasure.ellipsisCount === 3, `实测 ${defaultMeasure.ellipsisCount}`)
    check(
      '默认态：有「历史对话」标题行 + 右侧「选择」',
      (await page.getByText('历史对话', { exact: true }).count()) > 0 &&
        (await page.locator('[data-testid="sider-select-toggle"]').innerText()).trim() === '选择',
    )
    const newChat = page.locator('[data-testid="sider-new-chat"]')
    check('默认态：开启新对话可用（disabled=false）', (await newChat.isDisabled()) === false)

    // 让第 2 条成为「当前会话」（浅蓝底），这样多选态截图也带着这层底。
    // 移动端点会话会把抽屉关掉（closeMobileSider），所以点完要重新打开
    await sessionRows.nth(1).click()
    await page.waitForTimeout(300)
    await openSider()
    check('当前会话有浅蓝底（active 行 = 1）', (await page.evaluate(measure)).activeRowCount === 1)

    // ---------------------------------------------------------------- 进多选态
    await page.locator('[data-testid="sider-select-toggle"]').click()
    await page.waitForTimeout(300)
    const boxes = page.locator('[data-testid="sider"] [role="checkbox"]')
    const boxCount = await boxes.count()
    check('多选态：每条会话都有勾选控件（role=checkbox）', boxCount === 3, `实测 ${boxCount}`)

    // 勾第一条
    await boxes.first().click()
    await page.waitForTimeout(200)

    const activeShot = path.join(OUT_DIR, 'multiselect-active-390.png')
    // 截图前先把列表滚到底：底栏必须仍然可见（它不在滚动容器里）
    await page.evaluate(() => {
      const scroller = document.querySelector('[data-testid="sider-list"]')
      if (scroller !== null) scroller.scrollTop = scroller.scrollHeight
    })
    await page.waitForTimeout(200)
    await page.screenshot({ path: activeShot })
    const activeMeasure = await page.evaluate(measure)

    check('多选态：`.sider` 内 `…` 按钮数量 = 0', activeMeasure.ellipsisCount === 0, `实测 ${activeMeasure.ellipsisCount}`)
    check(
      '多选态：表头换成「全选」+「取消」',
      (await page.locator('[data-testid="sider-select-all"]').innerText()).trim() === '全选' &&
        (await page.locator('[data-testid="sider-selection-cancel"]').innerText()).trim() === '取消',
    )
    check(
      '勾选控件是圆形（border-radius 计算值 50%）',
      activeMeasure.uncheckedCircle?.borderRadius === '50%' && activeMeasure.checkedCircle?.borderRadius === '50%',
      `选中 ${activeMeasure.checkedCircle?.borderRadius} / 未选中 ${activeMeasure.uncheckedCircle?.borderRadius}`,
    )
    check(
      '选中 / 未选中背景色不同',
      activeMeasure.checkedCircle !== null &&
        activeMeasure.uncheckedCircle !== null &&
        activeMeasure.checkedCircle.backgroundColor !== activeMeasure.uncheckedCircle.backgroundColor,
      `选中 ${activeMeasure.checkedCircle?.backgroundColor} / 未选中 ${activeMeasure.uncheckedCircle?.backgroundColor}`,
    )
    check('选中项含白色对勾（内联 SVG）', activeMeasure.checkedCircle?.hasCheck === true && activeMeasure.checkedCircle?.color === 'rgb(255, 255, 255)', `color=${activeMeasure.checkedCircle?.color}`)
    check(
      '多选态行高与默认态一致（三条都是同一高度）',
      new Set(activeMeasure.rowHeights).size === 1,
      activeMeasure.rowHeights.join(' / '),
    )
    check('多选态：开启新对话 disabled=true', (await newChat.isDisabled()) === true)
    check(
      '多选态：开启新对话 aria-disabled=true',
      (await newChat.getAttribute('aria-disabled')) === 'true' ||
        (await newChat.evaluate((element) => element.matches(':disabled'))) === true,
    )
    check(
      '底栏「已选 1 项」',
      (await page.locator('[data-testid="sider-selection-count"]').innerText()).trim() === '已选 1 项',
      await page.locator('[data-testid="sider-selection-count"]').innerText(),
    )
    const deleteButton = page.locator('[data-testid="sider-delete-selected"]')
    const deleteColor = await deleteButton.evaluate((element) => getComputedStyle(element).color)
    check('删除按钮是红色且可用', (await deleteButton.isDisabled()) === false && /^rgb\(236, 19, 19\)$|^rgb\(242, 90, 90\)$/.test(deleteColor), `color=${deleteColor}`)
    check(
      '底栏在列表滚到底时仍完整可见，且不在滚动容器内',
      activeMeasure.footer !== null &&
        activeMeasure.footerInsideScroller === false &&
        activeMeasure.footer.top >= 0 &&
        activeMeasure.footer.bottom <= activeMeasure.viewport.height + 0.5,
      JSON.stringify({ top: activeMeasure.footer?.top, bottom: activeMeasure.footer?.bottom, viewportH: activeMeasure.viewport.height }),
    )

    // ---------------------------------------------------------------- 键盘：Tab 到勾选控件 + 空格
    await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur())
    const focusedIsSiderCheckbox = () =>
      page.evaluate(() => {
        const element = document.activeElement
        return (
          element !== null &&
          element.getAttribute('role') === 'checkbox' &&
          element.closest('[data-testid="sider"]') !== null
        )
      })
    let tabHits = 0
    let focusedOk = false
    for (let i = 0; i < 30; i += 1) {
      await page.keyboard.press('Tab')
      tabHits += 1
      focusedOk = await focusedIsSiderCheckbox()
      if (focusedOk) break
    }
    check(
      '键盘 Tab 能走到侧栏的勾选控件（role=checkbox 拿到焦点）',
      focusedOk,
      `Tab ${tabHits} 次后 activeElement=${await page.evaluate(() => document.activeElement?.getAttribute('role') ?? document.activeElement?.tagName ?? '(none)')}`,
    )
    /** 读「当前焦点那个控件」自己的 aria-checked（Tab 可能落在任意一条会话上，不能拿第 1 条冒充） */
    const focusedBox = () =>
      page.evaluate(() => {
        const element = document.activeElement
        return element === null
          ? null
          : { testid: element.getAttribute('data-testid'), checked: element.getAttribute('aria-checked') }
      })
    const before = await focusedBox()
    await page.keyboard.press('Space')
    await page.waitForTimeout(200)
    const after = await focusedBox()
    check(
      '空格切换勾选（同一控件 aria-checked 前后值相反）',
      before !== null && after !== null && before.testid === after.testid && before.checked !== after.checked,
      `${before?.testid}: ${before?.checked} → ${after?.checked}`,
    )
    // 复原：再按一次空格回到已选 1 项（截图顺序上不影响，但状态别留脏）
    await page.keyboard.press('Space')
    await page.waitForTimeout(150)

    // ---------------------------------------------------------------- 空选择态
    // 键盘走查刚把焦点留在某一行上（`:focus` 会在圆圈外画一圈蓝环，见 `.selectable:focus`），
    // 截图前先放开焦点：这张图要证明的是「未选中 = 灰色实心圆」，别让焦点环被误看成描边圆环
    await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur())
    await page.evaluate(() => {
      const first = document.querySelector('[data-testid="sider"] [role="checkbox"][aria-checked="true"]')
      if (first !== null) first.click()
    })
    await page.waitForTimeout(200)
    const emptyShot = path.join(OUT_DIR, 'multiselect-empty-390.png')
    await page.screenshot({ path: emptyShot })
    check(
      '空选择：底部「已选 0 项」',
      (await page.locator('[data-testid="sider-selection-count"]').innerText()).trim() === '已选 0 项',
      await page.locator('[data-testid="sider-selection-count"]').innerText(),
    )
    check('空选择：删除按钮禁用（灰）', (await deleteButton.isDisabled()) === true)
    check('空选择：「导出选中」仍可用（功能保留）', (await page.locator('[data-testid="sider-export-selected"]').isDisabled()) === false)

    // ---------------------------------------------------------------- 窄屏不横向溢出
    for (const width of [360, 320]) {
      await page.setViewportSize({ width, height: 800 })
      await page.waitForTimeout(250)
      const narrow = await page.evaluate(measure)
      check(
        `${width} 宽不横向溢出（document.scrollWidth ≤ 视口宽）`,
        narrow.scrollWidth <= narrow.viewport.width && narrow.bodyScrollWidth <= narrow.viewport.width,
        `scrollWidth=${narrow.scrollWidth} viewport=${narrow.viewport.width}`,
      )
    }
    // 默认态也量一次（切回默认态再量）
    await page.setViewportSize({ width: 390, height: 844 })
    await page.waitForTimeout(200)
    await page.locator('[data-testid="sider-selection-cancel"]').click()
    await page.waitForTimeout(250)
    const backToDefault = await page.evaluate(measure)
    check(
      '「取消」回到默认态：`…` 按钮回来（3 个）、勾选控件消失',
      backToDefault.ellipsisCount === 3 && backToDefault.checkboxCount === 0,
      `…=${backToDefault.ellipsisCount} checkbox=${backToDefault.checkboxCount}`,
    )
    check('默认态：开启新对话恢复可用', (await newChat.isDisabled()) === false)

    console.log(`\n截图：\n  ${path.relative(ROOT, defaultShot)}\n  ${path.relative(ROOT, activeShot)}\n  ${path.relative(ROOT, emptyShot)}`)
  } finally {
    await context.close()
    await browser.close()
  }

  const failed = results.filter((item) => !item.ok)
  console.log(`\nTotal ${results.length}: PASS ${results.length - failed.length}, FAIL ${failed.length}`)
  if (failed.length > 0) {
    for (const item of failed) console.log(`  ✗ ${item.name}${item.detail === '' ? '' : ` —— ${item.detail}`}`)
    process.exitCode = 1
  }
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
