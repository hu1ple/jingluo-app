import { useRef, useState } from 'react'
import clsx from 'clsx'
import { Button } from '../base/Button.js'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import {
  applyChatBackground,
  removeChatBackground,
  useChatBackground,
} from '../../services/chat/background.js'
import styles from './Settings.module.css'

type Status = { key: TranslationKey; error?: boolean } | null

/**
 * **默认背景**（本单改名，原来是「聊天背景」）：与上方三字段（API Key / 服务地址 / 模型）同一行样式。
 *
 * 语义从「所有会话都用这张图」收窄成「**新会话 / 没有单独设置过的会话**用它」：
 * 单独设置过的会话（`Session.background` 有覆盖）不受这里影响，改这里也不会把它们改掉。
 * 存储、压缩口径、清除确认一个字没动 —— 只是显示名与描述跟着新语义改了，
 * 否则用户会以为「在设置里换图 = 把所有会话的背景都换了」。
 */

export const ChatBackgroundField = () => {
  const t = useTranslate()
  const url = useChatBackground((state) => state.url)
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<Status>(null)
  const [confirming, setConfirming] = useState(false)

  const upload = async (file: File) => {
    setBusy(true)
    setStatus(null)
    setConfirming(false)
    try {
      await applyChatBackground(file)
      setStatus({ key: 'settingsChatBackgroundSaved' })
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('[background] upload failed', error)
      setStatus({ key: 'settingsChatBackgroundFailed', error: true })
    } finally {
      setBusy(false)
    }
  }

  const clear = async () => {
    setBusy(true)
    try {
      await removeChatBackground()
      setStatus({ key: 'settingsChatBackgroundCleared' })
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('[background] clear failed', error)
      setStatus({ key: 'settingsChatBackgroundFailed', error: true })
    } finally {
      setBusy(false)
      setConfirming(false)
    }
  }

  const hint = confirming
    ? t('settingsChatBackgroundClearConfirm')
    : status
      ? t(status.key)
      : t('settingsChatBackgroundDescription')

  return (
    <div className={clsx(styles.cell, styles.backgroundRow)}>
      <div className={styles.backgroundText}>
        <div className={styles.label}>{t('settingsChatBackground')}</div>
        <div className={clsx(styles.description, status?.error && styles.error)}>{hint}</div>
      </div>
      <div className={styles.backgroundAction}>
        {/* 没有背景图时**不渲染空缩略图**：一个只有破折号的空框在窄屏上既占位又像坏掉的控件，
            真正要点的只有「上传」。有图时才显示缩略图。 */}
        {url ? (
          <span
            className={styles.backgroundPreview}
            role="img"
            aria-label={t('settingsChatBackground')}
            style={{ backgroundImage: `url("${url}")` }}
          />
        ) : null}
        {confirming ? (
          <>
            <Button variant="outlined" size="m" disabled={busy} onClick={() => setConfirming(false)}>
              {t('cancel')}
            </Button>
            <Button variant="danger" size="m" disabled={busy} onClick={() => void clear()}>
              {t('confirm')}
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="outlined"
              size="m"
              className={styles.uploadButton}
              disabled={busy}
              onClick={() => inputRef.current?.click()}
            >
              {t('settingsChatBackgroundUpload')}
            </Button>
            <Button
              variant="outlined"
              size="m"
              disabled={busy || !url}
              onClick={() => {
                setStatus(null)
                setConfirming(true)
              }}
            >
              {t('settingsChatBackgroundClear')}
            </Button>
          </>
        )}
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          aria-label={t('settingsChatBackgroundUpload')}
          className={styles.backgroundFile}
          onChange={(event) => {
            const file = event.target.files?.[0]
            // 允许连续选同一张图
            event.target.value = ''
            if (file) {
              void upload(file)
            }
          }}
        />
      </div>
    </div>
  )
}
