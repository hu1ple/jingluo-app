/**
 * Tab 2「购买」（#482 三弹层合一 / #487 W1-C1）—— 数据来自 **apia**。
 *
 * 链路（#484 §3.5，一条都不能省，也都不能自己造）：
 *
 *   下单      `GET /api/v1/pay-link`（`fetchPayLink`，新网关，base = `consume.baseUrl`，**每次现取**；
 *             我们不建单、不读 302 Location；#861 起不再请求已下线的 `/api/plans`）
 *   收款页    原生：`openPayLinkInApp()`（App 内 popover 打开，关页 → `onClosed`）
 *             Web ：`openPayPlaceholder()`（点击的同步栈里占位）→ `navigatePayTab()`（拿到地址再导航）
 *   关页后    `onPurchased()`      → 回到 Tab 1 并重新拉订单（卡密由小铺直接发到订单上）
 *
 * ### Web 为什么是两段式（这一段是本文件最容易被「顺手简化」坏掉的地方）
 *
 * `window.open` 只要脱离用户点击的同步栈就会被浏览器当弹窗拦掉，而收款页地址要
 * `await fetchPayLink()` 才回来。所以顺序只能是：**先同步占位**（`openPayPlaceholder`，
 * 第一行就调），**再取地址**，**最后导航**（`navigatePayTab`）。任何一步失败都要把占位页关掉
 * （否则用户面前会挂一个只有加载提示的标签页）。
 *
 * 两条与旧版不同的文案口径：
 *  - Web 被拦截不再复用 `oursPayOpenFailed`（那句是「没能在 App 内打开收款页」）→ `oursPayPopupBlocked`；
 *  - `oursPayHint` 说的是「在 App 内打开」，Web 上换成 `oursPayHintWeb`（新标签页 + 回来自动查单）。
 *
 * 三条与旧弹层不同的地方（都是「砍掉」而不是「搬过来」）：
 *  1. **不建单、不轮询**（#331）：付款结果在小铺那边，客户端能做的只有「收款页回来后重拉订单」；
 *  2. 空态 / 失败态都给**可操作**的出口（空表 → 「前往购买」；失败 → 「重试」），不停在白屏；
 *  3. `POST /api/pay-link` 这类写接口**不自动重试**（会生成新单）—— 失败就只让用户手动再点。
 *
 * 金额口径：一律「元」（`¥`），不出现 `$` / USD / 积分。价格只经 `formatPlanPrice()` 渲染一次，
 * 界面里不写第二份 `toFixed`，也不硬编码符号。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { fetchPayLink } from '../../services/ours/api.js'
import {
  closePayPlaceholder,
  httpTransport,
  isNativePlatform,
  navigatePayTab,
  openPayLinkInApp,
  openPayPlaceholder,
} from '../../services/ours/transport.js'
import { Button } from '../base/Button.js'
import styles from './AccountConsume.module.css'
import { markWebPayOpened } from './webPayReturn.js'

type PayView =
  | { status: 'idle' }
  | { status: 'busy' }
  /** Web：收款页已在新标签页打开（本页不动），等用户付款后切回来 */
  | { status: 'opened' }
  | { status: 'error'; messageKey: TranslationKey }

export type BuyTabProps = {
  /**
   * 从收款页回到 App 之后调一次：外层据此切到 Tab 1 并重新拉订单。
   * **不代表付款成功**（小铺那边才有结果），所以文案只说「已回到 App」。
   *
   * 原生：`browserFinished` → `onClosed`；Web：`AccountConsumePage` 的
   * `visibilitychange` + 低频轮询兜底（两边调的都是同一个 `backToCards`）。
   */
  onPurchased?: () => void
}

export const BuyTab = ({ onPurchased }: BuyTabProps) => {
  const t = useTranslate()
  const [pay, setPay] = useState<PayView>({ status: 'idle' })
  // 收款页是外部浏览器视图：同一时刻只允许一条「取地址 + 打开」在飞，避免连点开出两个收款页
  const payBusyRef = useRef(false)
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  /**
   * 取地址 → 打开收款页（原生：App 内 popover；Web：新标签页两段式）。
   * 地址每次现取，不在客户端缓存（小铺随时换链接）。
   */
  const openCheckout = useCallback(async () => {
    if (payBusyRef.current) {
      return
    }
    payBusyRef.current = true
    setPay({ status: 'busy' })
    const native = isNativePlatform()
    /**
     * ① **同步**占位（必须是第一件要做的事）：Web 端在这里把标签页开出来，
     * 之后才允许出现第一个 `await`。原生端返回 `null`，走下面原来那条路。
     */
    const tab = native ? null : openPayPlaceholder(t('oursPayPlaceholder'))
    const link = await fetchPayLink(httpTransport)
    if (!aliveRef.current) {
      // 组件已经卸载（用户关了设置）：占位页没有意义，关掉；也不 mark（没有页面可以「回来」）
      closePayPlaceholder(tab)
      payBusyRef.current = false
      return
    }
    if (link.status === 'error') {
      closePayPlaceholder(tab)
      payBusyRef.current = false
      setPay({ status: 'error', messageKey: link.messageKey })
      return
    }
    if (!native) {
      // ② Web：把占位页导航到收款页（只放行 https，见 navigatePayTab）
      const navigated = tab !== null && navigatePayTab(tab, link.url)
      payBusyRef.current = false
      if (!navigated) {
        // `tab === null` = window.open 返回 null（被弹窗拦截）；`navigated === false` = 占位页已被关掉。
        // 两种情况都只给可读提示，**绝不**退回去做整页跳转（把本页换掉 = App 状态全丢）
        closePayPlaceholder(tab)
        setPay({ status: 'error', messageKey: 'oursPayPopupBlocked' })
        return
      }
      // 告诉页面「本次会话开过收款页」，并把回跳回调登记进去：`onPurchased` 就是原生
      // `onClosed` 里调的那一个（= 页面唯一的接线 `backToCards`），两条路共用同一份兑现逻辑。
      // Web 没有 browserFinished，回来靠页面的可见性监听 + 低频轮询兜底。
      markWebPayOpened(onPurchased)
      setPay({ status: 'opened' })
      return
    }
    // ③ 原生：一个字都没改（App 内打开 + browserFinished → onClosed）
    const opened = await openPayLinkInApp(link.url, () => {
      // 用户回来了：**不判断成败**，只把订单拉一遍（小铺付款后会把卡密挂到订单上）
      if (!aliveRef.current) {
        return
      }
      // 关页 = 只是「用户回来了」：把订单重拉一遍交给外层（切 Tab 1），这里不再多说一句
      setPay({ status: 'idle' })
      onPurchased?.()
    })
    payBusyRef.current = false
    if (!aliveRef.current) {
      return
    }
    if (!opened) {
      // 老 APK / 插件缺失：绝不整页跳走兜底，只给可读提示
      setPay({ status: 'error', messageKey: 'oursPayOpenFailed' })
      return
    }
    setPay({ status: 'idle' })
  }, [onPurchased, t])

  const payBusy = pay.status === 'busy'

  return (
    <div className={styles.body} data-testid="account-consume-buy">
      {/* 「在哪儿打开」是两端不同的事实：原生 = App 内；Web = 新标签页 + 回来自动查单 */}
      <p className={styles.hint}>{isNativePlatform() ? t('oursPayHint') : t('oursPayHintWeb')}</p>

      <div className={styles.state}>
        {/* 套餐全线下架是正常状态（#331）：只剩一个入口，说清「去哪儿买」 */}
        <p className={styles.stateText}>{t('oursPayEmpty')}</p>
        <div className={styles.stateActions}>
          <Button size="m" data-testid="account-consume-buy-open" disabled={payBusy} onClick={() => void openCheckout()}>
            {payBusy ? t('oursPayBusy') : t('oursPayAction')}
          </Button>
        </div>
      </div>

      {/* Web：收款页开在别的标签页里 —— 本页一句「去哪儿看」，否则用户会以为没反应 */}
      {pay.status === 'opened' ? (
        <div className={styles.feedback} data-testid="account-consume-buy-tab-opened">
          <span>{t('oursPayTabOpened')}</span>
        </div>
      ) : null}

      {pay.status === 'error' ? (
        <div className={`${styles.feedback} ${styles.feedbackError}`} role="alert" data-testid="account-consume-buy-status">
          <span>{t(pay.messageKey)}</span>
          {/* 收款页地址是只读接口，重开是安全的；但**不自动重试**，由用户点一下 */}
          <div className={styles.feedbackActions}>
            <Button variant="outlined" size="m" onClick={() => void openCheckout()}>
              {t('oursPurchasesRetry')}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
