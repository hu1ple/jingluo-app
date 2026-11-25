import clsx from 'clsx'
import { memo, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  IconBranchOutline16,
  IconCheckOutline16,
  IconEditOutline16,
  IconEllipsisOutline16,
  IconPinOutline16,
  IconTrashOutline16,
} from '../base/icons.js'
import { pinSession, renameSession, selectSession } from '../../services/chat/store.js'
import type { SessionSummary } from '../../services/chat/types.js'
import { IconButton } from '../base/IconButton.js'
import { Menu } from '../base/Menu.js'
import { SessionBranchBadge } from '../session/SessionBranchBadge.js'
import { openSessionBranchDialog } from '../session/sessionBranchState.js'
import { closeMobileSider } from './mobileSiderState.js'
import styles from './SessionItem.module.css'

export const SessionItem = memo(function SessionItem({
  session,
  active,
  parentTitle,
  selecting = false,
  selected = false,
  onToggle,
  onDelete,
}: {
  session: SessionSummary
  active: boolean
  /**
   * #831：父会话标题（列表里的来源徽标用）。`null` / 缺省 = 父会话不在本机 → 徽标降级
   * 「来源已不在本机」。由 `Sider` 用当前列表算好传进来：每行自己去订阅整个列表会在
   * 「新建 / 改名」时把 N 行全部重渲染一遍。
   */
  parentTitle?: string | null
  /** #390：列表处于「选择」模式时，整条会话变成可勾选项，点击切换勾选而不是打开会话。 */
  selecting?: boolean
  selected?: boolean
  onToggle?: (id: string) => void
  onDelete: () => void
}) {
  const t = useTranslate()
  const [editing, setEditing] = useState(false)
  const displayTitle = session.title || t('untitledChat')

  if (editing) {
    const finish = (title: string) => {
      setEditing(false)
      if (title.trim() && title.trim() !== displayTitle) {
        renameSession(session.id, title.trim())
      }
    }
    return (
      <input
        className={styles.renameInput}
        defaultValue={displayTitle}
        autoFocus
        onFocus={(event) => event.target.select()}
        onBlur={(event) => finish(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            finish(event.currentTarget.value)
          } else if (event.key === 'Escape') {
            setEditing(false)
          }
        }}
      />
    )
  }

  if (selecting) {
    return (
      /*
       * 多选态的行（设计稿右图第 3 项）：
       * - 左侧圆形勾选控件：选中 = 蓝底 + 白色对勾，未选中 = 灰色实心圆（`.check` / `.checkOn`，纯 CSS 画的）
       * - 行内不再渲染 `…` 更多按钮（这条分支里根本没有 `.action` 节点）
       * - 行高与默认态完全一致（同一个 `.item`，height 固定），切进去列表不跳动
       * - 无障碍：真实可聚焦控件 = 行本身 `role="checkbox"` + `aria-checked` + tabIndex=0，
       *   空格 / 回车切换（`aria-label` 用会话标题）
       */
      <div
        role="checkbox"
        aria-checked={selected}
        aria-label={displayTitle}
        tabIndex={0}
        data-testid={`sider-session-check-${session.id}`}
        className={clsx(styles.item, styles.selectable, active && styles.active)}
        onClick={() => onToggle?.(session.id)}
        onKeyDown={(event) => {
          if (event.key === ' ' || event.key === 'Spacebar' || event.key === 'Enter') {
            event.preventDefault()
            onToggle?.(session.id)
          }
        }}
      >
        <span className={clsx(styles.check, selected && styles.checkOn)} aria-hidden="true">
          {selected ? <IconCheckOutline16 /> : null}
        </span>
        <div className={styles.title}>{displayTitle}</div>
      </div>
    )
  }

  return (
    <div
      className={clsx(styles.item, active && styles.active)}
      data-testid={`sider-session-${session.id}`}
      onClick={() => {
        selectSession(session.id)
        closeMobileSider()
      }}
    >
      <div className={styles.title}>{displayTitle}</div>
      {/* #831：来源徽标（普通会话不渲染）。降级态由 `parentTitle === null` 表达 */}
      <SessionBranchBadge origin={session.branchOf} parentTitle={parentTitle === undefined ? null : parentTitle} />
      {session.pinnedAt !== undefined ? <span className={styles.pin} title={t('sessionPinnedLabel')} aria-label={t('sessionPinnedLabel')}><IconPinOutline16 /></span> : null}
      <div className={styles.action} onClick={(event) => event.stopPropagation()}>
        <Menu
          options={[
            {
              key: 'pin',
              label: session.pinnedAt === undefined ? t('sessionItemMenuPinOption') : t('sessionItemMenuUnpinOption'),
              icon: <IconPinOutline16 />,
              onSelect: () => pinSession(session.id),
            },
            {
              key: 'rename',
              label: t('sessionItemMenuRenameOption'),
              icon: <IconEditOutline16 />,
              onSelect: () => setEditing(true),
            },
            {
              // #831：完整分支（整条会话复制成一条新会话）。节点分支的入口在回答下方
              key: 'branch',
              label: t('sessionBranchMenuOption'),
              icon: <IconBranchOutline16 />,
              onSelect: () => openSessionBranchDialog({ sessionId: session.id }),
            },
            {
              key: 'delete',
              label: t('delete'),
              icon: <IconTrashOutline16 />,
              danger: true,
              onSelect: onDelete,
            },
          ]}
        >
          {({ toggle }) => (
            <IconButton icon={<IconEllipsisOutline16 />} aria-label={t('more')} onClick={toggle} />
          )}
        </Menu>
      </div>
    </div>
  )
})
