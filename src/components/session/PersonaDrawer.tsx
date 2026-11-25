import clsx from 'clsx'
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
 * 标题区的圆角方块图标（设计稿：浅蓝底 + 蓝色「铅笔 + 星光」）。
 *
 * 只用 path / 直线，不用 mask 与外部 symbol：Chromium 83 与深色主题换色都只靠 `currentColor`。
 */
const PencilSparkIcon = () => (
  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <g stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3.2 20.8 4 17.4 13 8.4l2.6 2.6L6.6 20l-3.4.8Z" />
      <path d="m12.2 9.2 2.6 2.6" />
    </g>
    <path
      d="M19.2 2.3l1 2.3 2.3 1-2.3 1-1 2.3-1-2.3-2.3-1 2.3-1 1-2.3Z"
      fill="currentColor"
    />
  </svg>
)

/** 底部一行左侧的 ⓘ：只说明「适用范围」，与报错图标（三角）刻意区分 */
const InfoIcon = () => (
  <svg className={styles.scopeIcon} width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <circle cx="8" cy="8" r="6.3" stroke="currentColor" strokeWidth="1.4" />
    <path d="M8 7.1v3.7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    <circle cx="8" cy="4.9" r=".9" fill="currentColor" />
  </svg>
)

/**
 * 自定义提示词抽屉（#890：上限 1000 字）。
 *
 * 外观按设计稿重做成**底部抽屉**（顶部圆角 + 拖拽把手 + 右上角 X），标题区「图标块 + 标题 + 副标题」，
 * 输入区是一张带描边的卡片（计数在卡片内左下角，格式 `0 / 1000`），底部一行「ⓘ 适用范围 + 取消 / 保存」。
 * **只有外观变了**：下面的字数上限、脏检查、确认流程一行代码都没动。
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
  const countTone = prompt.oversized ? styles.countOver : prompt.count >= PROMPT_WARN_CHARS ? styles.countWarn : ''
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
    <Modal className={styles.drawer} mainClassName={styles.body} closable
      dismissDisabled={busy || confirm} onClose={requestClose}
      title={<>
        <span className={styles.grabber} aria-hidden="true" />
        <span className={styles.head}>
          <span className={styles.iconBlock} aria-hidden="true"><PencilSparkIcon /></span>
          <span className={styles.headText}>
            <strong className={styles.heading}>{t('promptTitle')}</strong>
            <span className={styles.subtitle}>{t('promptDescription')}</span>
          </span>
        </span>
      </>}>
      <div className={styles.card}>
        <textarea className={styles.input} aria-label={t('promptTitle')} placeholder={t('promptPlaceholder')}
          maxLength={PROMPT_MAX_UTF16_UNITS} value={draft} disabled={busy || confirm}
          onChange={e => setDraft(truncatePromptChars(e.target.value))} />
        <div className={styles.cardFooter}>
          <span className={clsx(styles.count, countTone)}>{t('promptCount', { count: prompt.count, max: PROMPT_MAX_CHARS })}</span>
          {prompt.oversized && <span className={styles.tooLong} role="alert">{t('promptTooLong', { max: PROMPT_MAX_CHARS })}</span>}
        </div>
      </div>
      {failed && <p className={styles.failed} role="alert">{t('personaSaveFailed')}</p>}
      <div className={styles.actions}>
        <p className={styles.scope}><InfoIcon /><span>{t('promptScope')}</span></p>
        <div className={styles.buttons}>
          <Button variant="outlined" className={styles.cancel} disabled={busy} onClick={requestClose}>{t('cancel')}</Button>
          <Button variant="primary" className={styles.save} disabled={!dirty || busy || !prompt.canSave}
            onClick={() => void save(false)}>
            {t(dirty ? 'personaSave' : 'promptSaved')}
          </Button>
        </div>
      </div>
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
