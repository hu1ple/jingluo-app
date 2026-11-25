import { useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { setNewChatPrompt, useDrafts } from '../../services/chat/drafts.js'
import { saveSessionPrompt } from '../../services/chat/store.js'
import type { Session } from '../../services/chat/types.js'
import { Button } from '../base/Button.js'
import { IconButton } from '../base/IconButton.js'
import { Modal } from '../base/Modal.js'
import styles from './PersonaDrawer.module.css'

export const PersonaButton = ({ onClick }: { onClick: () => void }) => {
  const t = useTranslate()
  return <IconButton size="xl" tone="primary" tooltip={t('promptTitle')} onClick={onClick} icon={<IdentityIcon />} />
}

const IdentityIcon = () => (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
      <rect x="1.5" y="3.5" width="17" height="13" rx="3" />
      <circle cx="7" cy="8.2" r="1.7" />
      <path d="M3.9 13.3c.6-2.7 5.6-2.7 6.2 0M12.5 8h3M12.5 11.5h2" />
    </svg>
)

export const PersonaDrawer = ({ session, onClose }: { session?: Session; onClose: () => void }) => {
  const t = useTranslate()
  const newPrompt = useDrafts(state => state.drafts.get(null)?.customSystemPrompt)
  const initial = session ? session.customSystemPrompt : newPrompt
  const [saved, setSaved] = useState(typeof initial === 'string' ? initial : '')
  const [draft, setDraft] = useState(saved)
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const dirty = draft !== saved
  const save = async (exit: boolean) => {
    if (busy) {
      return
    }
    setBusy(true)
    const success = session ? await saveSessionPrompt(session.id, draft) : true
    if (!session) {
      setNewChatPrompt(draft)
    }
    setBusy(false)
    setConfirm(false)
    setFailed(!success)
    if (success) {
      setSaved(draft)
      if (exit) {
        onClose()
      }
    }
  }
  const requestClose = () => {
    if (busy) {
      return
    }
    if (dirty) {
      setConfirm(true)
    } else {
      onClose()
    }
  }
  return <>
    <Modal className={styles.page} mainClassName={styles.editor} onClose={requestClose} dismissDisabled={busy || confirm}
      title={<span className={styles.bar}>
        <IconButton size="xl" aria-label={t('back')} disabled={busy} onClick={requestClose}
          icon={<svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m13 3-7 7 7 7" stroke="currentColor" strokeWidth="2" /></svg>} />
        <strong>{t('promptTitle')}</strong>
        <button className={styles.save} disabled={!dirty || busy} onClick={() => void save(false)}>
          {t(dirty ? 'personaSave' : 'promptSaved')}
        </button>
      </span>}>
      <p>{t('promptDescription')}</p>
      <textarea className={styles.input} aria-label={t('promptTitle')} placeholder={t('promptPlaceholder')}
        value={draft} disabled={busy || confirm} onChange={e => setDraft(e.target.value)} />
      <div className={styles.meta}><span>{t('promptScope')}</span><span>{t('promptCount', { count: [...draft].length })}</span>
      </div>
      {failed && <p role="alert">{t('personaSaveFailed')}</p>}
    </Modal>
    {confirm && <Modal title={t('promptConfirm')} className={styles.sheet} zIndex={1002}
      onClose={() => {
        if (!busy) {
          setConfirm(false)
        }
      }}>
      <Button block variant="outlined" disabled={busy} onClick={() => void save(true)}>{t('personaSave')}</Button>
      <Button block variant="dangerOutlined" disabled={busy} onClick={onClose}>{t('personaDiscard')}</Button>
      <Button block variant="outlined" disabled={busy} onClick={() => setConfirm(false)}>{t('cancel')}</Button>
    </Modal>}
  </>
}
