import { testSeamEnabled } from '../../utils/testSeam.js'
import { useEffect, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { Button } from '../base/Button.js'
import { IconWarningOutline16 } from '../base/icons.js'
import { Modal } from '../base/Modal.js'
import { useSettingsDialog } from '../settings/settingsDialogState.js'
import { needsForcedRead } from '../../services/announcements/readGate.js'
import {
  announcementsPending,
  hasShownPopup,
  initReadGate,
  latestAnnouncement,
  markPopupShown,
  markRead,
  markReadGate,
  readReadGate,
} from '../../services/announcements/store.js'
import type { AnnouncementWithReadState } from '../../services/announcements/types.js'
import { MOTION_EXIT, usePresence } from '../../utils/usePresence.js'
import { relativeTime } from './relativeTime.js'
import { useAnnouncements } from './useAnnouncements.js'
import { useForcedReadTimer } from './useForcedReadTimer.js'
import styles from './Announcements.module.css'

/**
 * 首次进入应用时的**公告弹窗（最新的一条）**，带「强制阅读 5 秒」。
 *
 * 弹出判定（与 `store.ts` 的标记一一对应）：
 *  · 候选 = **列表里最新的一条**（不是「最新的未读」）—— 读完之后列表里往往还留着更老的未读，
 *    按未读取候选会让用户在下次启动被更老的公告再强制一遍。同一条永远只强制一次，靠下面的门禁；
 *  · 门禁说了算（`needsForcedRead`）：这条的 id 已经读过 5 秒 / 已读 / 老用户兼容 → **不弹**；
 *    换新 id（运营发了新公告）→ 重新强制 5 秒；
 *  · 设置弹窗正开着 → **不弹**（两层 dialog 叠在一起，Esc 只能关最上面那层，产品方看到的就是
 *    「点了知道了没反应」）；等设置关掉后这一轮会再判一次；
 *  · 判定延迟到一个宏任务之后再做：`App` 启动那次 `ensureApiKey({ fromBoot: true })` 可能在
 *    子组件的 effect 之后才打开设置，同一帧里读 `open` 是读不到的。
 *
 * 强制阅读纪律（产品原话：首次强制 5s，但别因为切出程序就重新计时一遍）：
 *  · 5 秒内「知道了」**禁用**并显示剩余秒数；Esc / 点遮罩 / 关闭按钮同样无效（`close()` 里兜住，
 *    遮罩另由 `Modal` 的 `dismissDisabled` 挡住）；
 *  · 计时基准是**弹窗出现那一刻的墙钟**，剩余 = `5s - (now - shownAt)`：切出去 8 秒再回来
 *    直接就算满了（**不是**暂停、也不是重来）—— 用户切出去本来就不想看，回来不该再等一遍；
 *  · 满 5 秒 → 写**读出门禁**（按 id）→ 这条以后永远不再弹、也不再强制；换新 id 才重新强制；
 *  · 「弹过了」（`POPUP_SHOWN`）在**弹窗出现的那一刻**就写，不是等关闭 —— 否则用户切后台被系统
 *    杀掉时 `dismiss` 没机会执行，下次启动又弹一遍。
 *
 * 关闭纪律：点「知道了」→ `markRead(id)` + 写门禁；Esc / 点遮罩（5s 后）→ 只写门禁
 * （看过了，但没点确认就不替用户把红点抹掉）。
 */
export const AnnouncementPopup = () => {
  // 测试接缝：黄金/L1 是「启动即操作界面」，弹窗的遮罩会把输入框点击全堵死（实测 30s 超时）
  if (testSeamEnabled()) {
    return null
  }
  const t = useTranslate()
  const list = useAnnouncements()
  const settingsOpen = useSettingsDialog((state) => state.open)
  /** 渲染用的公告：退出动画期间还要继续画，所以关闭时不清空它（只用 `open` 收起来） */
  const [current, setCurrent] = useState<AnnouncementWithReadState | null>(null)
  const [open, setOpen] = useState(false)
  /** 本轮运行只判定一次（判定完就 true）—— 判完不置位的话，关掉设置 / 切页都会重跑并重新弹 */
  const decided = useRef(false)
  const { mounted, visible } = usePresence(open, MOTION_EXIT.modal)

  /**
   * 强制阅读倒计时：以「弹窗出现那一刻」为基准按**墙钟差**算剩余，切后台照常计时（不重来）。
   * 读满 5 秒 → 写门禁（按 id），**不必等用户点「知道了」**：用户读完就切后台、
   * 进程被杀，也一样不会被再强制第二次。
   */
  const { remainingSeconds: remaining, ready } = useForcedReadTimer({
    id: open ? (current?.id ?? null) : null,
    active: open,
    onFinished: () => {
      const id = current?.id
      if (id !== undefined) {
        markReadGate(id)
      }
    },
  })

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
      // 首屏数据还没落定：此刻的列表可能只是**上次的缓存**（里面是最旧的那条公告，甚至已经被
      // 读过），拿它判定就会「把新公告挡在门外」—— 判完 `decided` 一置位，新数据回来也不再看。
      // 所以这里不判定、也不置 decided：`publish()` 换掉快照引用后这个 effect 会再跑一次。
      // （不这么写的话，冷启动带缓存时永远看不到「换新公告 → 重新强制」。）
      if (announcementsPending()) {
        return
      }
      const candidate = latestAnnouncement(list)
      decided.current = true
      if (candidate === null) {
        return
      }
      // 门禁：读完过 / 已读 / 老用户（门禁键从没写过 + 弹过）→ 不弹，也不再强制
      const forced = needsForcedRead({
        id: candidate.id,
        gate: readReadGate(),
        legacyShown: hasShownPopup(),
        read: candidate.read,
      })
      if (!forced) {
        return
      }
      setCurrent(candidate)
      setOpen(true)
      // **展示即写**：切后台被杀进程时下面这些「关闭时才会执行」的代码根本没机会跑
      markPopupShown()
      // 门禁键落盘（空表）：标记「这台机器由新语义接管」，老标记从此不再豁免强制
      initReadGate()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [settingsOpen, list])

  /**
   * 关闭。`ready` 为假时**一律无效** —— Esc（`Modal` 的 keydown）与点遮罩都走这里，
   * 这样「5 秒内不能关」就不依赖某一个入口是否记得禁用。
   */
  const close = (confirmRead: boolean) => {
    if (!ready) {
      return
    }
    const id = current?.id
    if (id !== undefined) {
      markReadGate(id)
      if (confirmRead) {
        markRead(id)
      }
    }
    // 展示时已写过，这里再写一次是幂等的兜底（写盘失败 / 配额满的极端情况）
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
      // 5 秒没读满：点遮罩无效（`close()` 里还有一道，两条路径都堵上）
      dismissDisabled={!ready}
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
          // 倒计时期间禁用：按钮上直接显示剩余秒数（中英各一条成对文案，见 i18n）
          disabled={!ready}
          data-testid="settings-announcement-popup-dismiss"
          data-remaining-seconds={remaining}
          onClick={() => close(true)}
        >
          {ready
            ? t('settingsAnnouncementPopupDismiss')
            : t('settingsAnnouncementPopupDismissCount', { seconds: remaining })}
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
