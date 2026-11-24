import { useEffect, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { Button } from '../base/Button.js'
import { IconWarningOutline16 } from '../base/icons.js'
import { Modal } from '../base/Modal.js'
import { useSettingsDialog } from '../settings/settingsDialogState.js'
import {
  announcementsPending,
  hasShownPopup,
  latestUnreadAnnouncement,
  markPopupShown,
  markRead,
} from '../../services/announcements/store.js'
import type { AnnouncementWithReadState } from '../../services/announcements/types.js'
import { MOTION_EXIT, usePresence } from '../../utils/usePresence.js'
import { relativeTime } from './relativeTime.js'
import { useAnnouncements } from './useAnnouncements.js'
import styles from './Announcements.module.css'

/**
 * 首次进入应用时的**公告弹窗（只弹最新的一条）**。
 *
 * 触发口径（与 `store.ts` 的标记一一对应）：
 *  · 本机没弹过（`chat-demo:announcements-popup-shown` 为空）**且**还有未读 → 弹；
 *  · 设置弹窗正开着 → **不弹**（两层 dialog 叠在一起，Esc 只能关最上面那层，产品方看到的
 *    就是「点了知道了没反应」）；等设置关掉后这一轮会再判一次；
 *  · 判定延迟到一个宏任务之后再做：`App` 启动那次 `ensureApiKey({ fromBoot: true })` 可能在
 *    子组件的 effect 之后才打开设置，同一帧里读 `open` 是读不到的。
 *
 * 关闭纪律：点「知道了」→ `markRead(id)` + 记「弹过了」；Esc / 点遮罩关掉 → 只记「弹过了」
 * （看过了，但没点确认就不替用户把红点抹掉）。两种关闭都不会让它在同一次运行里再弹。
 */
export const AnnouncementPopup = () => {
  const t = useTranslate()
  const list = useAnnouncements()
  const settingsOpen = useSettingsDialog((state) => state.open)
  /** 渲染用的公告：退出动画期间还要继续画，所以关闭时不清空它（只用 `open` 收起来） */
  const [current, setCurrent] = useState<AnnouncementWithReadState | null>(null)
  const [open, setOpen] = useState(false)
  /** 本轮运行只判定一次（判定完就 true）—— 判完不置位的话，关掉设置 / 切页都会重跑并重新弹 */
  const decided = useRef(false)
  const { mounted, visible } = usePresence(open, MOTION_EXIT.modal)

  useEffect(() => {
    if (decided.current || settingsOpen) {
      return
    }
    const timer = window.setTimeout(() => {
      if (decided.current) {
        return
      }
      // 定时器到期时再看一眼：这一宏任务里设置可能已经被打开（启动那次 Key 守卫）
      if (useSettingsDialog.getState().open) {
        return
      }
      if (hasShownPopup()) {
        decided.current = true
        return
      }
      const latest = latestUnreadAnnouncement(list)
      if (latest === null) {
        // 列表来源是远程（`store.ts`）：冷启动时「空列表」可能只是**还没拉到**，
        // 不是「没有未读公告」。这时候不判定、也不置 decided —— 数据落定后
        // `publish()` 会换掉快照引用，这个 effect 会再跑一次，那次才是真判定。
        // （不这么写的话，首屏 fetch 还没回来就把弹窗永久吞掉了。）
        if (announcementsPending()) {
          return
        }
        decided.current = true
        return
      }
      decided.current = true
      setCurrent(latest)
      setOpen(true)
    }, 0)
    return () => window.clearTimeout(timer)
  }, [settingsOpen, list])

  const close = (confirmRead: boolean) => {
    const id = current?.id
    if (confirmRead && id !== undefined) {
      markRead(id)
    }
    markPopupShown()
    setOpen(false)
  }

  if (!mounted || current === null) {
    return null
  }
  const time = relativeTime(current.publishedAt)
  return (
    <Modal
      visible={visible}
      title={
        <span className={styles.popupTitle}>
          {current.level === 'important' ? (
            <span className={styles.popupImportant} role="img" aria-label={t('settingsAnnouncementImportant')}>
              <IconWarningOutline16 />
            </span>
          ) : null}
          {current.title}
        </span>
      }
      onClose={() => close(false)}
      footer={
        <Button
          variant="primary"
          size="m"
          data-testid="settings-announcement-popup-dismiss"
          onClick={() => close(true)}
        >
          {t('settingsAnnouncementPopupDismiss')}
        </Button>
      }
    >
      <div data-testid="settings-announcement-popup" data-level={current.level}>
        <span className={styles.popupMeta}>{t(time.key, time.params)}</span>
        <div className={styles.popupBody}>{current.body}</div>
      </div>
    </Modal>
  )
}
