import clsx from 'clsx'
import { useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { IconWarningOutline16 } from '../base/icons.js'
import { relativeTime } from './relativeTime.js'
import { useAnnouncements } from './useAnnouncements.js'
import { markRead } from '../../services/announcements/store.js'
import type { AnnouncementWithReadState } from '../../services/announcements/types.js'
import styles from './Announcements.module.css'

/** 摘要超过这个字数才给「展开全文」——短公告两行就放得下，多一个开关只是噪音 */
const COLLAPSIBLE_MIN_LENGTH = 60

/**
 * 一条公告的正文摘要。
 *
 * 摘要整块是一个按钮（产品方要求「正文摘要可点击展开」）：默认 2 行截断，点一下展开全文，
 * 再点收起。太长的正文展开后自己滚（`.itemBodyExpanded` 的 40vh 上限），不把整页顶长。
 */
const AnnouncementBody = ({ body, collapsible }: { body: string; collapsible: boolean }) => {
  const t = useTranslate()
  const [expanded, setExpanded] = useState(false)
  if (!collapsible) {
    return <p className={styles.itemBody}>{body}</p>
  }
  return (
    <button
      type="button"
      className={styles.itemBodyButton}
      aria-expanded={expanded}
      onClick={() => setExpanded((prev) => !prev)}
    >
      <span className={clsx(styles.itemBody, expanded ? styles.itemBodyExpanded : styles.itemBodyClamped)}>
        {body}
      </span>
      <span className={styles.itemToggle}>
        {expanded ? t('settingsAnnouncementCollapse') : t('settingsAnnouncementExpand')}
      </span>
    </button>
  )
}

/**
 * 「公告栏」页的列表。
 *
 * 每条：**未读红点 + 标题（未读字重 600）+ 相对时间 + 正文摘要（2 行截断，可展开）**。
 * 数据与已读状态全部来自 `services/announcements/store.ts`（列表来自分发机的 `announcements.json`，
 * 冷启动先吃缓存、失败静默；`?ann-demo` 时才用本地 mock），这里只画，不改状态 ——
 * 唯一的交互是展开 / 收起，属于纯本地视图状态。
 */
export const AnnouncementList = () => {
  const t = useTranslate()
  const { items } = useAnnouncements()
  // 空态：远程列表「今天没有公告」是常态（首次拉取在飞 / 拉取失败且无缓存时也会短暂命中），
  // 所以这一支必须渲染「暂无公告」，而不是一张空卡片。
  if (items.length === 0) {
    return (
      <div className={styles.list} role="list" data-testid="settings-announcement-list">
        <div className={styles.empty} role="listitem" data-testid="settings-announcement-empty">
          {t('settingsAnnouncementEmpty')}
        </div>
      </div>
    )
  }
  return (
    <div className={styles.list} role="list" data-testid="settings-announcement-list">
      {items.map((item) => (
        <AnnouncementRow key={item.id} item={item} />
      ))}
    </div>
  )
}

/** 单条公告：标题行（红点 / 重要标记 / 标题 / 相对时间）+ 正文摘要 */
const AnnouncementRow = ({ item }: { item: AnnouncementWithReadState }) => {
  const t = useTranslate()
  const time = relativeTime(item.publishedAt)
  const collapsible = item.body.length > COLLAPSIBLE_MIN_LENGTH || item.body.includes('\n')
  return (
    <div
      className={styles.item}
      role="listitem"
      data-testid="settings-announcement-item"
      data-announcement-id={item.id}
      data-read={item.read ? 'true' : 'false'}
      data-level={item.level}
    >
      <div className={styles.itemHead}>
        {item.read ? null : (
          <span
            className={styles.unreadDot}
            data-testid="settings-announcement-unread-dot"
            role="img"
            aria-label={t('settingsAnnouncementUnread')}
          />
        )}
        {item.level === 'important' ? (
          <span className={styles.importantMark} role="img" aria-label={t('settingsAnnouncementImportant')}>
            <IconWarningOutline16 />
          </span>
        ) : null}
        <span className={clsx(styles.itemTitle, item.read ? undefined : styles.itemTitleUnread)}>
          {item.title}
        </span>
        <span className={styles.itemTime}>{t(time.key, time.params)}</span>
      </div>
      <AnnouncementBody body={item.body} collapsible={collapsible} />
      {/* 每条未读公告自己一个「已读」按钮：不必为了标一条而按「一键已读」把别的也标掉 */}
      {item.read ? null : (
        <div className={styles.itemActions}>
          <button
            type="button"
            className={styles.itemReadButton}
            data-testid="settings-announcement-mark-read"
            onClick={() => markRead(item.id)}
          >
            {t('settingsAnnouncementMarkRead')}
          </button>
        </div>
      )}
    </div>
  )
}
