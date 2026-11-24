import clsx from 'clsx'
import type { ReactNode } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { IconChevronRightOutline14 } from '../base/icons.js'
import styles from './Settings.module.css'

/**
 * 设置体系的四个「卡片视觉原件」：卡片 / 可点行 / 卡内块标题 / 二级页返回。
 *
 * 为什么抽出来：一级列表（`SettingsDialog`）和「账户与消费」那套子页面（`AccountConsumePage`）
 * 必须是**同一套视觉**（产品方 2026-11-24 第五轮口径：那边以前是裸行 + 细分割线 + 多栏色块按钮，
 * 和设置页完全不是一套）。视觉只有一个来源 —— `Settings.module.css` 的 `.card / .linkRow / …`；
 * 组件放在这里而不是 `SettingsDialog.tsx`，是为了避开
 * `SettingsDialog → AccountConsumePage → SettingsDialog` 的循环 import。
 *
 * 形状约定（与 `.card > * + *::before` 那条分隔线配套）：
 *  · 卡片自己带 `padding: 0 16px`，行**不再**各带左右内边距；
 *  · 行高 56px、左侧 20px 图标、右侧「值（灰）+ chevron」，整行可点；
 *  · 分隔线由 CSS 从「文字起始处」左内缩画出（有图标 32px，无图标 0），不贯穿到卡片边缘。
 */
export const SettingsCard = ({
  children,
  className,
}: {
  children?: ReactNode
  className?: string
}) => <div className={clsx(styles.card, className)}>{children}</div>

/**
 * 卡片里的一行：图标 + 文案 + 当前值（灰）+ chevron，整行可点。
 *
 * `value` 那一格**永远渲染**（没有值就是空串）：它负责吃掉剩余空间，chevron 才会贴在行尾，
 * 而不是紧跟文案。`valueTestId` 供「应用更新」那类需要按值取节点的用例使用。
 */
export const SettingsCardRow = ({
  testId,
  icon,
  label,
  value,
  valueTestId,
  onClick,
}: {
  testId: string
  icon: ReactNode
  label: string
  value?: string
  valueTestId?: string
  onClick: () => void
}) => (
  <button type="button" className={styles.linkRow} data-testid={testId} onClick={onClick}>
    <span className={styles.linkIcon} aria-hidden="true">
      {icon}
    </span>
    <span className={styles.linkLabel}>{label}</span>
    <span className={styles.linkValue} data-testid={valueTestId}>
      {value ?? ''}
    </span>
    <IconChevronRightOutline14 />
  </button>
)

/**
 * 带说明的一行：图标 / 标题 / 右侧值在同一行，说明文字单独占下面一整行（可以横跨到右值下方）。
 *
 * 为什么不用 `SettingsCardRow` + 把说明塞进右侧：说明要能横跨整行宽度（窄屏下才 2–3 行就放得下），
 * 而右值必须留在第一行；`grid-template-areas` 正好表达这个形状：
 *
 *   [图标] 标题                    右值
 *          说明文字（跨两列）
 *
 * 行高自适应（没有说明时 56px，有说明时约 72–84px），分隔线仍按 `--card-row-inset` 左内缩。
 */
export const SettingsCardInfoRow = ({
  testId,
  icon,
  label,
  description,
  value,
}: {
  testId?: string
  icon: ReactNode
  label: string
  description?: ReactNode
  value?: ReactNode
}) => (
  <div className={styles.infoRow} data-testid={testId}>
    <span className={styles.infoRowIcon} aria-hidden="true">
      {icon}
    </span>
    <span className={styles.infoRowLabel}>{label}</span>
    <span className={styles.infoRowValue}>{value}</span>
    {description ? <span className={styles.infoRowDesc}>{description}</span> : null}
  </div>
)

/** 卡片内的块标题（例如「语音」页里「朗读设置」那一组字号/字重/行高的抬头） */
export const SettingsCardLabel = ({ children }: { children: ReactNode }) => (
  <div className={styles.cardLabel}>{children}</div>
)

/**
 * 二级页左上角的「‹ 返回」：内容区整页换回上一级，弹层本身不关。
 *
 * `testId` 由调用方给 —— 设置页用它自己的 `settings-back`，「账户与消费」子页沿用既有的
 * `account-consume-back`（既有用例与验收脚本都按这个名字找）。
 */
export const SettingsBackButton = ({ testId, onClick }: { testId: string; onClick: () => void }) => {
  const t = useTranslate()
  return (
    <div className={styles.backRow}>
      <button type="button" className={styles.backButton} data-testid={testId} onClick={onClick}>
        <IconChevronRightOutline14 />
        {t('back')}
      </button>
    </div>
  )
}
