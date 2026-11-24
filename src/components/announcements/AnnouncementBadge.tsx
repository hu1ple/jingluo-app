import { useTranslate } from '../../i18n/index.js'
import styles from './Announcements.module.css'

/**
 * 一级列表「公告栏」这一行右侧挂的**未读徽标**：一个红点 + 未读条数。
 *
 * 只有 `unreadCount > 0` 时调用方才渲染它（没有未读就不渲染，自然也就没有红点）；
 * 无障碍语义给在整块上（`role="img"` + 一句「有 N 条未读公告」），里面的圆点和数字对读屏是装饰。
 */
export const AnnouncementBadge = ({ count }: { count: number }) => {
  const t = useTranslate()
  return (
    <span
      className={styles.badge}
      data-testid="settings-announcement-badge"
      role="img"
      aria-label={t('settingsAnnouncementUnreadCount', { count })}
    >
      <span className={styles.badgeDot} aria-hidden="true" />
      <span className={styles.badgeCount} aria-hidden="true">
        {count}
      </span>
    </span>
  )
}
