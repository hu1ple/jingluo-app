import clsx from 'clsx'
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import {
  applySessionBackgroundBlob,
  removeSessionBackground,
  useChatBackground,
  useSessionBackground,
} from '../../services/chat/background.js'
import { compressChatBackground } from '../../services/chat/appAssets.js'
import {
  DEFAULT_BACKGROUND_BLUR,
  DEFAULT_BACKGROUND_OPACITY,
  PRESET_BACKGROUND_GRADIENTS,
  PRESET_BACKGROUND_STYLES,
  backgroundPlanOf,
  clampBackgroundBlur,
  clampBackgroundOpacity,
  parseSessionBackground,
  resolveSessionBackground,
  type SessionBackgroundStyle,
} from '../../services/chat/sessionBackground.js'
import { saveSessionBackground } from '../../services/chat/store.js'
import type { Session } from '../../services/chat/types.js'
import { Button } from '../base/Button.js'
import { IconCheckOutline16, IconChevronRightOutline14, IconUploadOutline14 } from '../base/icons.js'
import { IconButton } from '../base/IconButton.js'
import { Modal } from '../base/Modal.js'
import { backgroundStyleLabelKey } from './ChatSettings.js'
import styles from './ChatSettings.module.css'

type Status = { key: TranslationKey; error?: boolean } | null

/** 返回箭头：与图标库里那套 16px 描边图标同一口径（`IconChevronRightOutline14` 转 180°） */
const BackIcon = () => (
  <span style={{ display: 'inline-flex', transform: 'rotate(180deg)' }}>
    <IconChevronRightOutline14 />
  </span>
)

/**
 * 聊天背景设置页（整页）：预览卡 + 四宫格 + 上传 + 两根滑杆 + 恢复默认 / 保存设置。
 *
 * 三条纪律（都会被验收检查）：
 *   1. **草稿态**：页面里改的一切（样式 / 淡化 / 模糊 / 新上传的图）都只在本组件的 state 里，
 *      点「保存设置」才落库（`saveSessionBackground` + `applySessionBackgroundBlob`）。
 *      新上传的图在上传时就压缩好（预览与落库是同一份字节），但**落库发生在保存那一刻**；
 *   2. **object URL 的 revoke 纪律**：草稿预览自己 create 一个 URL，页面卸载 / 换图 / 取消时
 *      `revokeObjectURL`；落库后由 `background.ts` 的 store 另建一个长期 URL（它自己负责 revoke）；
 *   3. **预览就是结果**：预览卡的三个 CSS 变量与真实聊天区由**同一个** `backgroundPlanOf`
 *      算出来，所以「预览看到的」与「保存后看到的」不可能不一致。
 *
 * 「恢复默认」是**直接生效**的破坏性动作（清掉本会话覆盖 + 删掉本会话存的图，回到全局默认），
 * 不参与草稿 —— 它的语义就是「把这条会话的设置拿掉」，没有「先预览再决定」这一步。
 */
export const ChatBackgroundPage = ({ session, onClose }: { session: Session; onClose: () => void }) => {
  const t = useTranslate()
  const own = parseSessionBackground(session.background)
  const [style, setStyle] = useState<SessionBackgroundStyle>(own?.style ?? 'default')
  const [opacity, setOpacity] = useState(own?.opacity ?? DEFAULT_BACKGROUND_OPACITY)
  const [blur, setBlur] = useState(own?.blur ?? DEFAULT_BACKGROUND_BLUR)
  /** 该会话**已经存过**的图（切到这个页面时 store 里读回来的那个 URL） */
  const storedUrl = useSessionBackground((state) => (state.sessionId === session.id ? state.url : null))
  /** 草稿：本次新上传的图（压缩后的 blob + 只给预览用的 object URL） */
  const [draft, setDraft] = useState<{ blob: Blob; url: string } | null>(null)
  const draftUrlRef = useRef<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<Status>(null)
  const globalUrl = useChatBackground((state) => state.url)

  // 卸载时把草稿 URL 还回去（换图时也走同一份逻辑，见 upload）
  useEffect(
    () => () => {
      if (draftUrlRef.current) {
        URL.revokeObjectURL(draftUrlRef.current)
        draftUrlRef.current = null
      }
    },
    [],
  )

  const customUrl = draft?.url ?? storedUrl
  const hasCustomImage = customUrl !== null

  /**
   * 预览计划：和 App.tsx 走**同一个**解析函数（会话设置优先、否则全局默认）。
   * `style === 'custom'` 但还没图时当成「跟随默认」预览，而不是给一张空白卡。
   */
  const preview = backgroundPlanOf(
    resolveSessionBackground(
      { background: { style, opacity, blur } },
      { url: globalUrl },
      customUrl,
    ),
  )

  const upload = async (file: File) => {
    setStatus(null)
    // 格式先判：与附件域同一口径（`imageSource.ts` 的 IMAGE_MEDIA_TYPES），别让用户等一次解码
    if (!file.type.startsWith('image/')) {
      setStatus({ key: 'imageUnsupportedFormat', error: true })
      return
    }
    setBusy(true)
    try {
      // 压缩口径复用全局背景那份实现（最长边 1600px / JPEG 0.85）
      const blob = await compressChatBackground(file)
      const url = URL.createObjectURL(blob)
      if (draftUrlRef.current) {
        URL.revokeObjectURL(draftUrlRef.current)
      }
      draftUrlRef.current = url
      setDraft({ blob, url })
      setStyle('custom')
      setStatus({ key: 'settingsChatBackgroundSaved' })
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('[background] compress failed', error)
      // 复用附件域的既有文案：解码失败 / 编码失败是同一类「这张图吃不了」
      setStatus({ key: 'imageDecodeFailed', error: true })
    } finally {
      setBusy(false)
    }
  }

  const save = async () => {
    if (busy) {
      return
    }
    const next = {
      style,
      opacity: clampBackgroundOpacity(opacity),
      blur: clampBackgroundBlur(blur),
    }
    if (next.style === 'custom' && !hasCustomImage) {
      setStatus({ key: 'chatBackgroundNeedImage', error: true })
      return
    }
    setBusy(true)
    setStatus(null)
    try {
      if (next.style === 'default') {
        // 「默认」= 没有会话级覆盖：连本会话存过的图一起清掉，不留孤儿 blob
        await removeSessionBackground(session.id)
      } else if (draft) {
        await applySessionBackgroundBlob(session.id, draft.blob)
      }
      const saved = await saveSessionBackground(session.id, next.style === 'default' ? undefined : next)
      if (!saved) {
        setStatus({ key: 'personaSaveFailed', error: true })
        return
      }
      onClose()
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('[background] save failed', error)
      setStatus({ key: 'settingsChatBackgroundFailed', error: true })
    } finally {
      setBusy(false)
    }
  }

  const reset = async () => {
    if (busy) {
      return
    }
    setBusy(true)
    setStatus(null)
    try {
      await removeSessionBackground(session.id)
      const saved = await saveSessionBackground(session.id, undefined)
      if (!saved) {
        setStatus({ key: 'personaSaveFailed', error: true })
        return
      }
      onClose()
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('[background] reset failed', error)
      setStatus({ key: 'settingsChatBackgroundFailed', error: true })
    } finally {
      setBusy(false)
    }
  }

  const previewStyle = preview
    ? ({
        '--chat-background-image': preview.imageCss,
        ...(preview.maskAlpha === null ? null : { '--chat-background-mask': String(preview.maskAlpha) }),
        ...(preview.blurPx > 0 ? { '--chat-background-blur': `${preview.blurPx}px` } : null),
      } as CSSProperties)
    : undefined

  return (
    <Modal
      className={styles.page}
      mainClassName={styles.pageBody}
      closable
      testId="chat-background-page"
      dismissDisabled={busy}
      onClose={onClose}
      title={
        <span className={styles.pageHead}>
          <IconButton
            size="m"
            tone="tertiary"
            tooltip={t('back')}
            data-testid="chat-background-back"
            onClick={onClose}
            icon={<BackIcon />}
          />
          <span className={styles.pageTitle}>{t('chatBackgroundPageTitle')}</span>
        </span>
      }
    >
      {/* 预览卡：背景层 / 遮罩层 / 正文层，三层与聊天区同一套变量 */}
      <div className={styles.preview} style={previewStyle} role="img" aria-label={t('chatBackgroundPreview')} data-testid="chat-background-preview">
        <div className={clsx(styles.previewLayer, preview === null && styles.previewEmpty)} aria-hidden="true" />
        {preview === null ? null : <div className={styles.previewMask} aria-hidden="true" />}
        <div className={styles.previewText}>
          {/* 气泡里放一句**真实界面文案**（内容由 AI 生成…）：预览要证明的是「正文在背景上读得清」，
              不是拿一个标签当样例 */}
          <span className={styles.previewBubble}>{t('contentCaveat')}</span>
          <span className={styles.previewCaption}>
            {preview === null ? t('chatBackgroundPreviewEmpty') : t(backgroundStyleLabelKey(style))}
          </span>
        </div>
      </div>

      <div className={styles.section}>
        <span className={styles.sectionTitle}>{t('chatBackgroundChoose')}</span>
        <div className={styles.grid}>
          <button
            type="button"
            className={clsx(styles.tile, style === 'default' && styles.tileActive)}
            data-testid="chat-background-style-default"
            aria-pressed={style === 'default'}
            onClick={() => setStyle('default')}
          >
            <span className={clsx(styles.tileArt, styles.tileArtEmpty)} aria-hidden="true" />
            <span className={styles.tileLabel}>{t('chatBackgroundStyleDefault')}</span>
            {style === 'default' ? <CheckBadge /> : null}
          </button>
          {PRESET_BACKGROUND_STYLES.map((preset) => (
            <button
              key={preset}
              type="button"
              className={clsx(styles.tile, style === preset && styles.tileActive)}
              data-testid={`chat-background-style-${preset}`}
              aria-pressed={style === preset}
              onClick={() => setStyle(preset)}
            >
              <span
                className={styles.tileArt}
                aria-hidden="true"
                style={{ backgroundImage: PRESET_BACKGROUND_GRADIENTS[preset] }}
              />
              <span className={styles.tileLabel}>{t(backgroundStyleLabelKey(preset))}</span>
              {style === preset ? <CheckBadge /> : null}
            </button>
          ))}
        </div>

        {/* 上传自定义图片：样式选中态与宫格一致（描边变实线 + 打勾） */}
        <button
          type="button"
          className={clsx(styles.upload, style === 'custom' && styles.tileActive, style === 'custom' && styles.uploadActive)}
          data-testid="chat-background-upload"
          aria-pressed={style === 'custom'}
          disabled={busy}
          onClick={() => inputRef.current?.click()}
        >
          {hasCustomImage ? (
            <span
              className={styles.uploadThumb}
              aria-hidden="true"
              style={{ backgroundImage: `url("${customUrl}")` }}
            />
          ) : (
            <span className={styles.uploadIcon} aria-hidden="true">
              <IconUploadOutline14 />
            </span>
          )}
          <span className={styles.uploadText}>
            <span className={styles.uploadLabel}>{t('chatBackgroundUpload')}</span>
            <span className={styles.uploadHint}>{t('chatBackgroundUploadHint')}</span>
          </span>
          {style === 'custom' && hasCustomImage ? <CheckBadge /> : null}
        </button>
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          aria-label={t('chatBackgroundUpload')}
          className={styles.fileInput}
          onChange={(event) => {
            const file = event.target.files?.[0]
            // 允许连续选同一张图
            event.target.value = ''
            if (file) {
              void upload(file)
            }
          }}
        />

        <div className={styles.slider}>
          <div className={styles.sliderHead}>
            <span className={styles.sliderLabel}>{t('chatBackgroundFade')}</span>
            <span className={styles.sliderValue}>{`${opacity}%`}</span>
          </div>
          <input
            className={styles.sliderInput}
            type="range"
            min={0}
            max={100}
            step={1}
            value={opacity}
            data-testid="chat-background-opacity"
            aria-label={t('chatBackgroundFade')}
            aria-valuetext={`${opacity}%`}
            disabled={busy}
            onChange={(event) => setOpacity(clampBackgroundOpacity(event.currentTarget.valueAsNumber))}
          />
        </div>

        <div className={styles.slider}>
          <div className={styles.sliderHead}>
            <span className={styles.sliderLabel}>{t('chatBackgroundBlur')}</span>
            <span className={styles.sliderValue}>{`${blur} px`}</span>
          </div>
          <input
            className={styles.sliderInput}
            type="range"
            min={0}
            max={20}
            step={1}
            value={blur}
            data-testid="chat-background-blur"
            aria-label={t('chatBackgroundBlur')}
            aria-valuetext={`${blur} px`}
            disabled={busy}
            onChange={(event) => setBlur(clampBackgroundBlur(event.currentTarget.valueAsNumber))}
          />
        </div>

        {status ? (
          <p className={clsx(styles.status, status.error && styles.statusError)} role={status.error ? 'alert' : 'status'}>
            {t(status.key)}
          </p>
        ) : null}
      </div>

      <div className={styles.pageFooter}>
        <p className={styles.footerScope}>{t('chatSettingsScope')}</p>
        <div className={styles.footerButtons}>
          <Button
            variant="outlined"
            size="m"
            data-testid="chat-background-reset"
            disabled={busy}
            onClick={() => void reset()}
          >
            {t('chatBackgroundReset')}
          </Button>
          <Button
            variant="primary"
            size="m"
            data-testid="chat-background-save"
            disabled={busy}
            onClick={() => void save()}
          >
            {t('chatBackgroundSave')}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

/** 宫格右上角的「选中打勾」 */
const CheckBadge = () => (
  <span className={styles.tileCheck} aria-hidden="true">
    <IconCheckOutline16 />
  </span>
)
