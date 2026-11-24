import { useEffect, type CSSProperties } from 'react'
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
import { ensureApiKey } from '../components/settings/settingsDialogState.js'
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
import { MobileSider, Sider } from '../components/sider/Sider.js'
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
    // 首次打开先在设置里输入 API Key（启动这一次只为「一个都没有」打开设置，见 #596）
    ensureApiKey({ fromBoot: true })
  }, [])

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
      {/* 首次进入的公告弹窗（只弹最新一条，本地 mock）：与设置弹窗互斥，见组件内注释 */}
      <AnnouncementPopup />
      {/* #831 会话级分支的确认弹层：两个入口（列表「更多」/ 回答下方）共用这一份 */}
      <SessionBranchDialog />
      <Toast />
    </>
  )
}
