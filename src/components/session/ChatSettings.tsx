import { useState } from 'react'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import {
  parseSessionBackground,
  type SessionBackgroundStyle,
} from '../../services/chat/sessionBackground.js'
import type { Session } from '../../services/chat/types.js'
import { IconChevronRightOutline14 } from '../base/icons.js'
import { IconButton } from '../base/IconButton.js'
import { Modal } from '../base/Modal.js'
import { ChatBackgroundPage } from './ChatBackgroundPage.js'
import { PersonaDrawer } from './PersonaDrawer.js'
import styles from './ChatSettings.module.css'

/**
 * 背景样式的文案 key（抽屉里的「当前值」与背景页的宫格标签共用一份）。
 *
 * 放在这里而不是 i18n 里做前缀拼接：`t()` 只认字面量 key（`check:i18n` 的 R3 也只扫字面量），
 * 动态拼出来的 key 既过不了类型也进不了门禁。
 */
export const backgroundStyleLabelKey = (style: SessionBackgroundStyle): TranslationKey =>
  style === 'mountain'
    ? 'chatBackgroundStyleMountain'
    : style === 'sunset'
      ? 'chatBackgroundStyleSunset'
      : style === 'forest'
        ? 'chatBackgroundStyleForest'
        : style === 'custom'
          ? 'chatBackgroundStyleCustom'
          : 'chatBackgroundStyleDefault'

/** 「聊天设置」按钮（滑杆图标）：替换原来那个「人设/提示词」按钮 */
export const ChatSettingsButton = ({ onClick }: { onClick: () => void }) => {
  const t = useTranslate()
  return (
    <IconButton
      size="xl"
      tone="primary"
      tooltip={t('chatSettings')}
      data-testid="chat-settings-open"
      onClick={onClick}
      icon={<SlidersIcon />}
    />
  )
}

/** 滑杆图标：两条轨道 + 两个旋钮，全部直线与圆，Chromium 83 只靠 `currentColor` 换色 */
const SlidersIcon = () => (
  <svg
    width="20"
    height="20"
    viewBox="0 0 20 20"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    aria-hidden="true"
  >
    <path d="M2.6 6.2h5.1M12.3 6.2h5.1M2.6 13.8h3.4M10.4 13.8h7" />
    <circle cx="10" cy="6.2" r="2.1" />
    <circle cx="8.1" cy="13.8" r="2.1" />
  </svg>
)

/** 底部一行左侧的 ⓘ：只说明「适用范围」，与报错图标刻意区分（与提示词抽屉同一个形状） */
const InfoIcon = () => (
  <svg className={styles.scopeIcon} width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <circle cx="8" cy="8" r="6.3" stroke="currentColor" strokeWidth="1.4" />
    <path d="M8 7.1v3.7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    <circle cx="8" cy="4.9" r=".9" fill="currentColor" />
  </svg>
)

/**
 * 聊天设置抽屉：两行功能列表 + 底部「设置仅对当前聊天生效」。
 *
 * 只做导航，不碰数据：点「自定义提示词」走既有的 `PersonaDrawer`（每会话 `customSystemPrompt`），
 * 点「聊天背景」走新的整页（每会话 `background` 字段 + 按 sessionId 存的图）。
 *
 * 新会话（`session` 缺省，Welcome 那一处）里「聊天背景」是**禁用**的：那时候还没有会话 id，
 * 这张图按 `chat-background:session:<id>` 存，没有 id 就没有地方存 —— 与其假装能设，
 * 不如明说「发出第一条消息后可用」（禁止静默丢弃用户的选择）。
 */
const ChatSettingsSheet = ({
  session,
  onOpenPrompt,
  onOpenBackground,
  onClose,
}: {
  session?: Session
  onOpenPrompt: () => void
  onOpenBackground: () => void
  onClose: () => void
}) => {
  const t = useTranslate()
  const own = parseSessionBackground(session?.background)
  // 先算成变量再交给 t()：`check:i18n` 的 R3 会把翻译调用的实参里**所有**字符串字面量当 key，
  // 把兜底值直接内联进实参，会被它读成一个叫 `default` 的 i18n key（真实的假红）。
  const valueLabel = backgroundStyleLabelKey(own?.style ?? 'default')
  return (
    <Modal
      className={styles.drawer}
      closable
      testId="chat-settings-sheet"
      onClose={onClose}
      title={
        <>
          <span className={styles.grabber} aria-hidden="true" />
          <span className={styles.head}>
            <span className={styles.headText}>
              <strong className={styles.heading}>{t('chatSettings')}</strong>
            </span>
          </span>
        </>
      }
    >
      <div className={styles.list}>
        <button
          type="button"
          className={styles.row}
          data-testid="chat-settings-prompt"
          onClick={onOpenPrompt}
        >
          <span className={styles.rowText}>
            <span className={styles.rowLabel}>{t('chatSettingsPrompt')}</span>
            <span className={styles.rowSubtitle}>{t('chatSettingsPromptSubtitle')}</span>
          </span>
          <span className={styles.rowChevron} aria-hidden="true">
            <IconChevronRightOutline14 />
          </span>
        </button>
        <button
          type="button"
          className={styles.row}
          data-testid="chat-settings-background"
          disabled={session === undefined}
          onClick={onOpenBackground}
        >
          <span className={styles.rowText}>
            <span className={styles.rowLabel}>{t('chatSettingsBackground')}</span>
            <span className={styles.rowSubtitle}>
              {session === undefined
                ? t('chatSettingsBackgroundNeedsSession')
                : t('chatSettingsBackgroundSubtitle')}
            </span>
          </span>
          <span className={styles.rowValue}>{t(valueLabel)}</span>
          <span className={styles.rowChevron} aria-hidden="true">
            <IconChevronRightOutline14 />
          </span>
        </button>
      </div>
      <p className={styles.scope}>
        <InfoIcon />
        <span>{t('chatSettingsScope')}</span>
      </p>
    </Modal>
  )
}

/**
 * 聊天设置的三层导航（抽屉 → 提示词抽屉 / 背景整页）。
 *
 * 为什么不是「三层同时挂着」：`Modal` 的 Esc / 点遮罩只关最上层，两层抽屉叠着时
 * 用户按 Esc 看到的是「下面那层还在、上面那层没了」，很容易以为卡住。所以同一时刻只挂一层，
 * 子页面关闭后回到列表（而不是直接关掉全部）—— 用户改完背景常常还要改提示词。
 */
export const ChatSettings = ({ session, onClose }: { session?: Session; onClose: () => void }) => {
  const [view, setView] = useState<'menu' | 'prompt' | 'background'>('menu')
  if (view === 'prompt') {
    return <PersonaDrawer key={session?.id} session={session} onClose={() => setView('menu')} />
  }
  if (view === 'background' && session !== undefined) {
    return <ChatBackgroundPage key={session.id} session={session} onClose={() => setView('menu')} />
  }
  return (
    <ChatSettingsSheet
      session={session}
      onOpenPrompt={() => setView('prompt')}
      onOpenBackground={() => setView('background')}
      onClose={onClose}
    />
  )
}
