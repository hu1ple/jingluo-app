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

export function ShareImport() {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const [link, setLink] = useState('')
  const [error, setError] = useState<TranslationKey | null>(null)
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    if (busy) return
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
            if (!busy) setOpen(false)
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
                if (e.key === 'Enter') void submit()
              }}
            />
          </label>
          {error && <p role="alert">{t(error)}</p>}
        </Modal>
      )}
    </>
  )
}
