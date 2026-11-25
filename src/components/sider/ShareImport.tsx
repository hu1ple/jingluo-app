import { Capacitor } from '@capacitor/core'
import { useState } from 'react'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { BackupError } from '../../services/chat/history/errors.js'
import { readDeepSeekShare } from '../../services/chat/history/deepseekShare.js'
import { addStagingSession } from '../../services/chat/db.js'
import { importHistoryInto, selectSession, useChatStore } from '../../services/chat/store.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { closeMobileSider } from './mobileSiderState.js'
import styles from './Sider.module.css'

/**
 * DeepSeek 分享导入入口。
 *
 * **只在原生端渲染**：网页端读 `chat.deepseek.com` 的分享接口会被 CORS 挡住，
 * 必须有一个服务端代转（= 多一个进程 + 一份运维）。产品决定不为这个功能加中转，
 * 所以网页端**连入口都不显示**——不是显示"网页端不支持"，而是这块 UI 根本不存在。
 */
export function ShareImport() {
  const t = useTranslate()
  // 必须放在所有 hooks 之后、JSX 之前：hook 顺序不能受平台影响
  const native = Capacitor.isNativePlatform()
  const [open, setOpen] = useState(false)
  const [link, setLink] = useState('')
  const [error, setError] = useState<TranslationKey | null>(null)
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    if (busy) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      const session = await readDeepSeekShare(link)
      const state = useChatStore.getState()
      if (state.importingHistory || Object.keys(state.streaming).length) {
        setError('shareBusy')
        return
      }
      await importHistoryInto(() => addStagingSession(session), 'skip')
      selectSession(session.id)
      setOpen(false)
      closeMobileSider()
    } catch (cause) {
      setError(cause instanceof BackupError ? cause.key : 'shareSaveFailed')
    } finally {
      setBusy(false)
    }
  }
  // 网页端：入口整体不渲染（不留任何"网页不支持"的提示）
  if (!native) {
    return null
  }
  return (
    <>
      <button
        type="button"
        className={styles.newChat}
        onClick={() => {
          setLink('')
          setError(null)
          setOpen(true)
        }}
      >
        {t('shareImport')}
      </button>
      {open && (
        <Modal
          title={t('shareImport')}
          onClose={() => {
            if (!busy) {setOpen(false)}
          }}
          footer={
            <>
              <Button variant="outlined" disabled={busy} onClick={() => setOpen(false)}>
                {t('cancel')}
              </Button>
              <Button disabled={busy} onClick={() => void submit()}>
                {t(busy ? 'shareLoading' : 'historyImportUrlStart')}
              </Button>
            </>
          }
        >
          <label>
            {t('shareLink')}
            <input
              type="url"
              className={styles.shareLinkInput}
              value={link}
              placeholder="https://chat.deepseek.com/share/…"
              disabled={busy}
              onChange={(e) => {
                setLink(e.target.value)
                setError(null)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {void submit()}
              }}
            />
          </label>
          {error && <p role="alert">{t(error)}</p>}
        </Modal>
      )}
    </>
  )
}
