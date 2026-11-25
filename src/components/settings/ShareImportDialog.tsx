import { Capacitor } from '@capacitor/core'
import { useState } from 'react'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { BackupError } from '../../services/chat/history/errors.js'
import { readDeepSeekShare } from '../../services/chat/history/deepseekShare.js'
import { addStagingSession } from '../../services/chat/db.js'
import { importHistoryInto, selectSession, useChatStore } from '../../services/chat/store.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import styles from './Settings.module.css'

/**
 * DeepSeek 分享导入弹窗。
 *
 * 入口在「设置 → 数据管理」（`SettingsDialog` 里那一行「导入会话」），不再占侧栏位置
 * ——侧栏顶部只留「开启新对话」，导入属于低频数据操作，和数据管理里的导入/导出放一起更合理。
 *
 * **只在原生端可用**：网页端读 `chat.deepseek.com` 的分享接口会被 CORS 挡住，需要服务端代转；
 * 产品决定不为这个低保频功能加中转，所以网页端连入口那一行都不渲染，也不留"网页端不支持"的提示。
 */
export function ShareImportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useTranslate()
  // 必须放在所有 hooks 之后、JSX 之前：hook 顺序不能受平台影响
  const native = Capacitor.isNativePlatform()

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
      onClose()
    } catch (cause) {
      setError(cause instanceof BackupError ? cause.key : 'shareSaveFailed')
    } finally {
      setBusy(false)
    }
  }
  // 网页端：连入口那一行都不渲染（不留任何"网页不支持"的提示）
  if (!native) {
    return null
  }
  return (
    <>
      {open && (
        <Modal
          title={t('shareImport')}
          onClose={() => {
            if (!busy) {onClose()}
          }}
          footer={
            <>
              <Button variant="outlined" disabled={busy} onClick={onClose}>
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
