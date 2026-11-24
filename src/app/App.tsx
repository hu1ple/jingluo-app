import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { useTranslate } from '../i18n/index.js'
import { useSettings } from '../services/settings.js'
import { useIsMobile, useMobileViewport, usePreventPageScroll } from './viewport.js'
import {
  bindChatPersistence,
  initChat,
  retrySaveSessions,
  selectSession,
  useChatStore,
} from '../services/chat/store.js'
import { SearchPanel } from '../components/search/SearchPanel.js'
import { closeSearchPanel } from '../components/search/searchPanelState.js'
import { SessionView } from '../components/session/SessionView.js'
import { SessionBranchDialog } from '../components/session/SessionBranchDialog.js'
import { MobileHeader } from '../components/session/MobileHeader.js'
import { Welcome } from '../components/session/Welcome.js'
import { ensureApiKey, openSettings, useSettingsDialog } from '../components/settings/settingsDialogState.js'
import { syncManagedKeyFromServer } from '../components/settings/managedKeyRuntime.js'
import { useAuthStatus } from '../services/auth/useAuthStatus.js'
import { useApiConfig } from '../services/api/apiConfig.js'
import { shouldSyncManagedKey } from '../services/api/managedKey.js'
import { SettingsDialog } from '../components/settings/SettingsDialog.js'
import { AnnouncementPopup } from '../components/announcements/AnnouncementPopup.js'
import { applyResetFromLocation } from '../services/announcements/store.js'
import { Toast } from '../components/base/Toast.js'
import { showToast } from '../components/base/toastState.js'
import { initChatBackground, useChatBackground } from '../services/chat/background.js'
import { onUploadNotice } from '../services/attachments.js'
import { onMemoryNotice } from '../services/memory/sessionMemory.js'
import { Button } from '../components/base/Button.js'
import { stopReadAloud } from '../services/speech/readAloud.js'
import { CollapsedSider } from '../components/sider/CollapsedSider.js'
import { closeMobileSider } from '../components/sider/mobileSiderState.js'
import { bindAndroidSiderSwipe } from '../components/sider/androidSiderSwipe.js'
import { MobileSider, Sider } from '../components/sider/Sider.js'
import { UpdateDialog } from '../components/update/UpdateDialog.js'
import { snoozeStartupUpdatePrompt, startUpdateGate, updateRequiredNow, useUpdateGate } from '../services/updateGateState.js'
import { bundledApp } from '../services/appUpdate.js'
import styles from './App.module.css'

/**
 * 公告的调试开关（产品方边看边提要求时反复看弹窗效果用）：
 * URL 带 `?ann-reset` 就清掉「已读 / 已弹过」两个标记，没带就什么都不做。
 *
 * 放在模块作用域、只跑一次：放进组件体里会跟着每次重渲染重复清空 ——
 * 用户刚点完「一键已读」，一个状态更新就把红点又还原回去。page load 一次正好。
 */
applyResetFromLocation(typeof window === 'undefined' ? '' : window.location.search)

export const App = () => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const locale = useSettings((state) => state.locale)
  // 移动端侧边栏以独立抽屉管理开合状态
  const siderCollapsed = useSettings((state) => state.siderCollapsed) && !isMobile
  const ready = useChatStore((state) => state.ready)
  const initError = useChatStore((state) => state.initError)
  const saveError = useChatStore((state) => Object.values(state.sessionSaveErrors).some(Boolean))
  const importingHistory = useChatStore((state) => state.importingHistory)
  const session = useChatStore((state) =>
    state.activeId !== null && Object.hasOwn(state.sessionCache, state.activeId)
      ? state.sessionCache[state.activeId]
      : undefined
  )
  const sessionLoadError = useChatStore((state) =>
    state.activeId === null ? false : state.sessionLoadErrors[state.activeId] === true
  )
  const frameRef = useMobileViewport(isMobile)
  const streaming = useChatStore((state) =>
    state.activeId === null ? false : Object.hasOwn(state.streaming, state.activeId)
  )
  const activeId = useChatStore((state) => state.activeId)
  // 聊天背景图存在 IndexedDB，刷新/重开后读回；只作用于聊天主区域
  const backgroundUrl = useChatBackground((state) => state.url)
  const needsBuiltinKey = useApiConfig((state) => shouldSyncManagedKey(state.kind, state.apiKey))
  // #800：对齐还需要登录态（领取链路要 JWT）；判断口径与账号面板一致（`authenticated`），不自己造一套
  const signedIn = useAuthStatus().authenticated

  usePreventPageScroll(isMobile)
  useEffect(() => {
    if (!isMobile || !frameRef.current) return
    return bindAndroidSiderSwipe(frameRef.current)
  }, [frameRef, isMobile, activeId])

  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])

  // 文件数、存储空间达到上限时，附件上只显示「上传失败」，原因用 toast 说明
  useEffect(() => onUploadNotice(showToast), [])
  // #399：记忆超出容量上限淘汰了条目 / 单条超上限被拒绝时，必须让用户看见（不许静默丢）
  useEffect(() => onMemoryNotice(showToast), [])
  useEffect(() => {
    void initChatBackground()
  }, [])
  useEffect(bindChatPersistence, [])

  // 搜索结果面板只属于当前会话
  useEffect(closeSearchPanel, [activeId])
  // 切换会话时停止朗读
  useEffect(stopReadAloud, [activeId])
  // 移动端选中会话、切换布局后收起抽屉
  useEffect(closeMobileSider, [activeId, isMobile])

  useEffect(() => {
    void initChat()
    /**
     * 首次打开先把 API Key 填了（启动这一次只为「一个都没有」打开设置，见 #596）。
     *
     * **但强制更新优先级更高**：判定结果出来之前不要抢屏，否则「无 Key 首启 + 服务端要求强制更新」
     * 会同时叠两层弹窗（实测：设置弹窗盖在强制更新上，用户既看不到原因也点不到「去更新」）。
     * 判定是 fail-open 的（拉不到＝不拦），所以正常情况下这只是把 Key 引导推迟到一次网络往返之后。
     */
    void startUpdateGate().then(() => {
      if (!updateRequiredNow()) {
        ensureApiKey({ fromBoot: true })
      }
    })
  }, [])

  /**
   * 启动检查更新（本单）。
   *
   * 为什么必须在这里、而不是只在「设置 → 关于 → 应用更新」里：那一页只有用户主动点进去才跑，
   * 于是服务端的 `minSupportedVersionCode`（强制更新）等于空转 —— 线上清单 12 条记录里
   * 一条 `updatePolicy` 都没下发过，就是这个机制从没真正生效过的旁证。
   *
   * 三条纪律：
   *  1. **不阻塞首屏**：`void` 掉它，没有 `await`、没有 `Suspense`；判定要一次网络往返（超时 2.5s）；
   *  2. **判不出就不拦**：拉不到清单 / 超时 / 脏 JSON / 版本号读不出来，一律当「没什么要说的」
   *     （逻辑在 `services/updateGate.ts`，本文件不做任何兜底判断）；
   *  3. **结果只落 store**：`StartupUpdatePrompt` 与 `ChatInput` 的发送门禁读的是同一份判据。
   */
  useEffect(() => {
    void startUpdateGate()
  }, [])

  /** 只为了让「公告弹窗是否让位」跟着判定结果重渲染；具体档位由下面两个组件自己读 */
  const updateGateKind = useUpdateGate((state) => state.gate.kind)

  /**
   * 恢复登录时也补领：旧版已登录但没有配置模型来源的人，重开 App 就能走到这里。
   * 已选内置服务时照常与服务端对齐（#596 / #800）。
   */
  useEffect(() => {
    if (!needsBuiltinKey || !signedIn) {
      return
    }
    void syncManagedKeyFromServer().catch(() => {})
  }, [needsBuiltinKey, signedIn])

  return (
    <>
      <div ref={frameRef} className={styles.frame}>
        {isMobile ? <MobileSider /> : siderCollapsed ? null : <Sider />}
        <main
          className={styles.main}
          data-chat-background={backgroundUrl ? 'on' : undefined}
          style={
            backgroundUrl
              ? ({ '--chat-background-image': `url("${backgroundUrl}")` } as CSSProperties)
              : undefined
          }
        >
          {saveError ? (
            <div className={styles.saveError} role="alert">
              <span>{t('sessionSaveFailed')}</span>
              <Button
                variant="outlined"
                size="s"
                disabled={importingHistory}
                onClick={retrySaveSessions}
              >
                {t('retry')}
              </Button>
            </div>
          ) : null}
          <div className={styles.content}>
            {siderCollapsed ? <CollapsedSider /> : null}
            {!ready || (activeId !== null && !session) ? (
              <div className={styles.loadingView}>
                {isMobile ? <MobileHeader /> : null}
                <div className={styles.loadingState} role="status" aria-live="polite">
                  <span>
                    {(!ready ? initError : sessionLoadError)
                      ? t(!ready ? 'sessionListLoadFailed' : 'sessionLoadFailed')
                      : t('sessionLoading')}
                  </span>
                  {(!ready ? initError : sessionLoadError) ? (
                    <Button
                      variant="outlined"
                      size="m"
                      onClick={() => {
                        if (!ready) {
                          void initChat()
                        } else if (activeId !== null) {
                          selectSession(activeId)
                        }
                      }}
                    >
                      {t('retry')}
                    </Button>
                  ) : null}
                </div>
              </div>
            ) : session ? (
              <SessionView
                session={session}
                streaming={streaming}
                siderCollapsed={siderCollapsed}
              />
            ) : (
              <Welcome />
            )}
          </div>
        </main>
        <SearchPanel />
      </div>
      <SettingsDialog />
      {/*
       * 首次进入的公告弹窗（只弹最新一条，本地 mock）：与设置弹窗互斥，见组件内注释。
       *
       * 与「启动更新提示」的互斥（本单）：
       *  · **强制更新优先** → 判出 `forced` 时公告弹窗整个不挂载（公告让位），
       *    否则两层 dialog 会叠在一起，Esc / 点遮罩都只落到最上面那层，用户看到的是「点了没反应」；
       *  · `soft` 定时相反：公告先弹出去了就**不再弹**更新提示（先到先得），
       *    判定在 `<StartupUpdatePrompt>` 里做（那里能看见「现在已经有 dialog 开着」）。
       * 公告组件本身一个字没改（它有自己的「不弹过 / 没有未读 / 设置开着」三条既定口径）。
       */}
      {updateGateKind === 'forced' ? null : <AnnouncementPopup />}
      {/* 启动更新提示：soft = 可关闭（「稍后提醒」走既有 snooze），forced = 关不掉（只有「去更新」一个出口） */}
      <StartupUpdatePrompt />
      {/* #831 会话级分支的确认弹层：两个入口（列表「更多」/ 回答下方）共用这一份 */}
      <SessionBranchDialog />
      <Toast />
    </>
  )
}

/**
 * 「现在已经有另一层 dialog 开着吗」——启动更新提示挂载**之前**问一次。
 *
 * 为什么用 DOM 判而不是状态：公告弹窗（`AnnouncementPopup`）的开关是它自己的组件内 state，
 * 没有对外暴露，而本单**不许改**它的文件。`Modal`（`components/base/Modal.tsx`）的卡片上
 * 恒有 `role="dialog"`，所以「文档里有没有 role=dialog」就是「屏幕上是不是已经有一层弹层」，
 * 这是能拿到的最直接的事实，也比推断「公告会不会弹」可靠（公告还有「已弹过 / 没有未读 /
 * 设置开着再判一次」三条口径）。
 */
const anotherDialogOpen = (): boolean => {
  try {
    return document.querySelector('[role="dialog"]') !== null
  } catch {
    return false
  }
}

/**
 * 启动更新提示（本单）。
 *
 * | 档位 | 弹不弹 | 关闭方式 |
 * | --- | --- | --- |
 * | `none` | 不弹 | —— |
 * | `soft` | 弹，**但已经有别的 dialog 开着就不弹**（先到先得） | 「稍后提醒」写 snooze / X / Esc / 遮罩 |
 * | `forced` | 一定弹，且公告弹窗已被让位 | 关不掉；只有「去更新」一个出口 |
 *
 * forced 的「去更新」为什么是「收起提示 + 打开设置」而不是在本层做下载：
 * 下载 / 安装 / 校验 / 失败分类那一整套状态机只长在 `AppUpdateField` 里（#373 / #310 的坑都补在那一处），
 * 在这里抄一份等于给它开第二个发作点。启动提示只负责**拦人 + 指路**，
 * 真正的只读约束由 `ChatInput` 的发送门禁承担 —— 用户就算关掉了设置，一样发不出消息。
 */
const StartupUpdatePrompt = () => {
  const t = useTranslate()
  const gate = useUpdateGate((state) => state.gate)
  const checked = useUpdateGate((state) => state.checked)
  /** 用户已经动过手（稍后提醒 / 去更新）：本次运行不再弹 */
  const [closed, setClosed] = useState(false)
  /** 判定只做一次：否则每次 store 更新都会重新问一次 `anotherDialogOpen()`，弹出时机漂移 */
  const decided = useRef(false)
  const [show, setShow] = useState(false)

  useEffect(() => {
    if (decided.current || !checked || gate.kind === 'none') {
      return
    }
    decided.current = true
    // forced 无视别的弹层（它优先级最高）
    if (gate.kind === 'forced') {
      setShow(true)
      return
    }
    /**
     * soft 让位给「先到先得」，但**必须等一个宏任务再判**：
     * 「无 Key 首启」那条路会在本次判定之后、同一个 tick 内把设置弹层打开（`ensureApiKey`），
     * 立刻问 `anotherDialogOpen()` 只会得到 false，于是两层弹窗叠在一起（实测）。
     */
    const timer = setTimeout(() => {
      // 设置弹层「已打开」以 store 为准（DOM 要等 React 提交，宏任务里可能还没落）；再兜一层 DOM 检查
      setShow(!useSettingsDialog.getState().open && !anotherDialogOpen())
    }, 0)
    return () => clearTimeout(timer)
  }, [checked, gate])

  if (!checked || gate.kind === 'none' || !show || closed) {
    return null
  }
  return (
    <UpdateDialog
      release={gate.release}
      /* 「当前版本」那一格：与设置页同一口径（构建期注入的版本名） */
      currentVersion={bundledApp().version}
      policy={gate.policy}
      primary={{
        label: t('updateGateActionUpdate'),
        onClick: () => {
          setClosed(true)
          // 设置首页的「关于」组里就是「应用更新」那一行（检查 / 下载 / 安装都在它里面）
          openSettings('general')
        },
      }}
      onSnooze={() => {
        snoozeStartupUpdatePrompt()
        setClosed(true)
      }}
      onClose={() => setClosed(true)}
    />
  )
}
