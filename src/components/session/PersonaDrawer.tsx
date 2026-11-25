import { useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { setNewChatPrompt, useDrafts } from '../../services/chat/drafts.js'
import {
  PROMPT_MAX_CHARS,
  PROMPT_MAX_UTF16_UNITS,
  PROMPT_WARN_CHARS,
  inspectPrompt,
  normalizePrompt,
  truncatePromptChars,
} from '../../services/chat/promptLimit.js'
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

/**
 * 自定义提示词抽屉（#890：上限 1000 字）。
 *
 * 上限落在三处，缺一不可：
 *   1. `maxLength`（原生）挡「继续输入」，但它是 **UTF-16 单元**口径，所以取 2 倍上限
 *      （`PROMPT_MAX_UTF16_UNITS`），否则「1000 个 emoji」会被原生限制提前卡在 500 个；
 *   2. `onChange` 里按**码点**截断 —— 粘贴不受 maxLength 约束，粘贴超长只能在这儿挡，
 *      而且必须按码点切，`slice` 会把 emoji 劈成半个代理对；
 *   3. 保存前再 `inspectPrompt` 一次 —— 按钮禁用只是界面约定，绕过 UI 也不许写进库。
 *
 * 存量超长（历史数据 / 导入）**不静默截断**：打开抽屉时输入框里是完整原文、计数变警示色、
 * 行内提示「超过 1000 字」、保存按钮禁用，用户自己删到 ≤1000 才能存。
 */
export const PersonaDrawer = ({ session, onClose }: { session?: Session; onClose: () => void }) => {
  const t = useTranslate()
  const newPrompt = useDrafts(state => state.drafts.get(null)?.customSystemPrompt)
  const initial = session ? session.customSystemPrompt : newPrompt
  const [saved, setSaved] = useState(typeof initial === 'string' ? initial : '')
  const [draft, setDraft] = useState(saved)
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  /** 当前输入的口径：trim 后的正文、码点数、是否超长、能否保存（全部来自 promptLimit） */
  const prompt = inspectPrompt(draft)
  /** 脏判定也按 trim 后的正文比：只有首尾空格不同不算改动，免得「存了个寂寞」却提示未保存 */
  const dirty = prompt.text !== normalizePrompt(saved)
  const countTone = prompt.oversized ? styles.countOver : prompt.count >= PROMPT_WARN_CHARS ? styles.countWarn : undefined
  const save = async (exit: boolean) => {
    if (busy) {
      return
    }
    // 保存前最后一道校验：超长一律不写库，也不截断成 1000 字替用户做决定
    const current = inspectPrompt(draft)
    if (!current.canSave) {
      return
    }
    setBusy(true)
    const success = session ? await saveSessionPrompt(session.id, current.text) : true
    if (!session) {
      setNewChatPrompt(current.text)
    }
    setBusy(false)
    setConfirm(false)
    setFailed(!success)
    if (success) {
      // 存的是 trim 后的正文：把输入框也对齐过去，避免「界面还有空格、库里没有」的错觉
      setSaved(current.text)
      setDraft(current.text)
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
        <button className={styles.save} disabled={!dirty || busy || !prompt.canSave} onClick={() => void save(false)}>
          {t(dirty ? 'personaSave' : 'promptSaved')}
        </button>
      </span>}>
      <p>{t('promptDescription')}</p>
      <textarea className={styles.input} aria-label={t('promptTitle')} placeholder={t('promptPlaceholder')}
        maxLength={PROMPT_MAX_UTF16_UNITS} value={draft} disabled={busy || confirm}
        onChange={e => setDraft(truncatePromptChars(e.target.value))} />
      <div className={styles.meta}>
        <span>{t('promptScope')}</span>
        <span className={countTone}>{t('promptCount', { count: prompt.count, max: PROMPT_MAX_CHARS })}</span>
      </div>
      {prompt.oversized && <p className={styles.tooLong} role="alert">{t('promptTooLong', { max: PROMPT_MAX_CHARS })}</p>}
      {failed && <p role="alert">{t('personaSaveFailed')}</p>}
    </Modal>
    {confirm && <Modal title={t('promptConfirm')} className={styles.sheet} zIndex={1002}
      onClose={() => {
        if (!busy) {
          setConfirm(false)
        }
      }}>
      <Button block variant="outlined" disabled={busy || !prompt.canSave} onClick={() => void save(true)}>{t('personaSave')}</Button>
      <Button block variant="dangerOutlined" disabled={busy} onClick={onClose}>{t('personaDiscard')}</Button>
      <Button block variant="outlined" disabled={busy} onClick={() => setConfirm(false)}>{t('cancel')}</Button>
    </Modal>}
  </>
}
