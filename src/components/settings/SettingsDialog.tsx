import clsx from 'clsx'
import { useRef, useState, type ReactNode } from 'react'
import {
  IconAnnounceOutline16,
  IconChevronRightOutline14,
  IconCopyOutline16,
  IconDarkOutline16,
  IconDataOutline16,
  IconDownloadOutline16,
  IconFollowsystemOutline16,
  IconHelpOutline16,
  IconLightOutline16,
  IconMicOutline16,
  IconRefreshOutline16,
  IconSettingsOutline16,
  IconSocialOutline16,
  IconUploadOutline14,
  IconUserOutline16,
  IconWalletOutline16,
} from '../base/icons.js'
import {
  BackupError,
  clearHistory,
  exportHistory,
  importHistory,
  type ExportProgress,
} from '../../services/chat/backup.js'
import type { ImportMode } from '../../services/chat/history/mergeSessions.js'
import type { ImportSkip } from '../../services/chat/history/toLocal.js'
import {
  canImportFromUrl,
  importHistoryFromUrl,
  UrlImportCancelled,
  type ImportTraceEntry,
  type UrlImportProgress,
} from '../../services/chat/history/urlImport.js'
import { copyText } from '../../utils/clipboard.js'
import { saveHistoryArchive } from '../../services/chat/history/saveArchive.js'
import { bundledApp, isAndroidUpdate } from '../../services/appUpdate.js'
import { ImportSkippedDetails, importedMessage, summaryFromCount } from './importSkipped.js'
import { useChatStore, type HistoryImportSummary } from '../../services/chat/store.js'
import {
  setLocale,
  setEnterKeyMode,
  setReadingFontSize,
  setReadingFontWeight,
  setReadingLineHeight,
  setThemePreference,
  setThinkingDisplay,
  setTtsVoice,
  useSettings,
  type EnterKeyMode,
  type ReadingFontSize,
  type ReadingFontWeight,
  type ReadingLineHeight,
  type ThemePreference,
  type ThinkingDisplay,
} from '../../services/settings.js'
import { useTranslate, type TranslationKey, type TranslationMessage } from '../../i18n/index.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { Select } from '../base/Select.js'
import { showToast } from '../base/toastState.js'
import { AppUpdateField, AppVersionField } from './AppUpdateField.js'
import { ChatBackgroundField } from './ChatBackgroundField.js'
import { DOUYIN_ACCOUNT_ID, douyinCopyToast } from './douyinAccount.js'
import { FeedbackDialog } from './FeedbackDialog.js'
import {
  closeSettings,
  normalizeSettingsSection,
  useSettingsDialog,
  type SettingsSection,
} from './settingsDialogState.js'
import {
  ACCOUNT_SUB_PAGE_TITLES,
  AccountConsumePage,
  type AccountSubPage,
} from '../consume/AccountConsumePage.js'
import { MOTION_EXIT, usePresence } from '../../utils/usePresence.js'
import styles from './Settings.module.css'
import {
  SettingsBackButton,
  SettingsCard,
  SettingsCardInfoRow,
  SettingsCardRow,
} from './CardRow.js'
import { AnnouncementBadge } from '../announcements/AnnouncementBadge.js'
import { AnnouncementList } from '../announcements/AnnouncementList.js'
import { useAnnouncements } from '../announcements/useAnnouncements.js'
import { markAllRead } from '../../services/announcements/store.js'

/**
 * 设置弹窗：iOS 风格「分组列表（一级） + 二级页」。
 *
 * · 一级：灰色分组标题 + 卡片；行是「图标 + 文案 + 当前值（灰） + chevron」，整行可点；
 * · 二级：点行后**内容区整页替换**（左上角「‹ 返回」，标题换成该页名字）——
 *   不是叠新弹层、不是叠遮罩，仍然只有一个容器、一个 X（#727 的口径继续成立）；
 * · 对外 API 一字不变：`openSettings(section)` 的 `section` 仍是「打开时落在哪个分组」，
 *   `general` = 一级列表本身，`data` / `account` = 直接落到对应的二级页；
 * · 公告栏的**数据是本地 mock**（`src/services/announcements/**`，已读状态存 localStorage），
 *   不连后端：列表 / 未读红点 / 一键已读都在这一层之内，首次进入的公告弹窗挂在 `App` 上。
 */
export const SettingsDialog = () => {
  const open = useSettingsDialog((state) => state.open)
  // 关闭时先留 DOM 播完退出动画（移动端底部滑落 / 桌面端缩小淡出）再卸载
  const { mounted, visible } = usePresence(open, MOTION_EXIT.modal)
  return mounted ? <SettingsContent visible={visible} /> : null
}

/** 二级页 id（`null` = 一级分组列表本身） */
type SettingsPage =
  | 'consume'
  | 'appearance'
  | 'general'
  | 'voice'
  | 'data'
  | 'announcement'
  | 'update'

/** 二级页标题：与一级行文案同一批词条，不新写中文 */
const PAGE_TITLES: Record<SettingsPage, TranslationKey> = {
  consume: 'accountConsumeTitle',
  appearance: 'settingsRowAppearance',
  general: 'settingsRowGeneral',
  voice: 'settingsRowVoice',
  data: 'settingDialogAsideDataOptionLabel',
  announcement: 'settingsRowAnnouncement',
  update: 'settingDialogAppUpdate',
}

/**
 * 旧的三个 tab（#711 / #727 阶段 1）与新 IA 的对应关系。
 *
 * 现在没有顶栏 tab 了，这个数组只剩一件事：把 `openSettings(section)` / `useSettingsDialog.section`
 * 的语义接到新落点上 —— `general` = 一级列表本身（`page: null`），`data` / `account` = 直接进对应二级页。
 *
 * **形状别动**：`tests/unit/settings-memory-section-off-711.test.mjs` 按「值 / 文案 key / 图标」
 * 逐位核这三项（它会从 `const sections:` 抠到第一个 `\n]`），改成 Record / 对象都会让那条门禁读不到。
 */
const sections: {
  value: SettingsSection
  label: TranslationKey
  icon: ReactNode
  page: SettingsPage | null
}[] = [
  {
    value: 'general',
    label: 'settingDialogAsideGeneralOptionLabel',
    icon: <IconSettingsOutline16 />,
    page: null,
  },
  {
    value: 'data',
    label: 'settingDialogAsideDataOptionLabel',
    icon: <IconDataOutline16 />,
    page: 'data',
  },
  { value: 'account', label: 'accountConsumeTitle', icon: <IconUserOutline16 />, page: 'consume' },
]

/** 打开设置时落在哪一页：只认 `data` / `account`，其余（含 `general`）都落在一级列表 */
const landingPageOf = (section: SettingsSection): SettingsPage | null =>
  sections.find((item) => item.value === section)?.page ?? null

/** 一组：灰色小字标题在**卡片外面**，卡片里是若干行（组内分隔线由 CSS 的 ::before 画） */
const SettingsGroup = ({ titleKey, children }: { titleKey: TranslationKey; children: ReactNode }) => {
  const t = useTranslate()
  return (
    <section className={styles.group}>
      <h2 className={styles.groupTitle}>{t(titleKey)}</h2>
      <SettingsCard>{children}</SettingsCard>
    </section>
  )
}

/**
 * 「公告栏」这一行：与 `SettingsCardRow` 同一套视觉（复用同一批 `Settings.module.css` class），
 * 唯一的差别是右侧那一格不是字符串，而是「红点 + 未读数」。
 *
 * 为什么没有直接给 `SettingsCardRow` 传节点：它的 `value` 类型是 `string`（那是给一级列表**全部**行
 * 定的形状，值那一格还要按字符串做省略号截断）。公告这行的右侧是结构化徽标，就地按同一批 class
 * 画一行，既不牵动别处，也不会把「值 = 一段当前值文案」的语义弄混。
 */
const AnnouncementRow = ({ onClick }: { onClick: () => void }) => {
  const t = useTranslate()
  const { unreadCount } = useAnnouncements()
  return (
    <button
      type="button"
      className={styles.linkRow}
      data-testid="settings-row-announcement"
      data-unread-count={unreadCount}
      onClick={onClick}
    >
      <span className={styles.linkIcon} aria-hidden="true">
        <IconAnnounceOutline16 />
      </span>
      <span className={styles.linkLabel}>{t('settingsRowAnnouncement')}</span>
      {/* 值那一格永远渲染（没有未读就是空的）：它负责吃掉剩余空间，chevron 才会贴在行尾 */}
      <span className={styles.linkValue}>
        {unreadCount > 0 ? <AnnouncementBadge count={unreadCount} /> : null}
      </span>
      <IconChevronRightOutline14 />
    </button>
  )
}

/**
 * 一级分组列表。
 *
 * 分组的归属与顺序由产品方定（2026-11-24 版）：账户 / 数据 / 应用 / 语音 / 公告 / 关于。
 * 「账户与消费」那一行保留老 testid `account-consume-open`（付款回跳、消息流 CTA 与既有用例都靠它）。
 */
const RootList = ({
  onOpen,
  onFeedback,
}: {
  onOpen: (page: SettingsPage) => void
  onFeedback: () => void
}) => {
  const t = useTranslate()
  const themePreference = useSettings((state) => state.themePreference)
  /** 右侧「当前值」：与二级页里那组选项共用同一批词条，不另写一份文案 */
  const labelOf = <T extends string,>(options: { value: T; label: TranslationKey }[], value: T) =>
    t((options.find((option) => option.value === value) ?? options[0]).label)

  return (
    <div className={styles.rootList} data-testid="settings-list">
      {/* 账户组只剩「账户与消费」一行：登录 / 退出 / 当前邮箱在那页里已有同等区块，
          一级再放一行「账号管理」就是重复。分组标题保留 —— 后面还可能有别的东西进来。 */}
      <SettingsGroup titleKey="settingsGroupAccount">
        <SettingsCardRow
          testId="account-consume-open"
          icon={<IconWalletOutline16 />}
          label={t('accountConsumeTitle')}
          onClick={() => onOpen('consume')}
        />
      </SettingsGroup>

      <SettingsGroup titleKey="settingsGroupApp">
        {/* 产品方口径：应用组三行 —— 外观（右侧显示当前主题）/ 通用 / 语音。
            语言已收进「通用」页，不再单独占一行。 */}
        <SettingsCardRow
          testId="settings-row-appearance"
          icon={<IconLightOutline16 />}
          label={t('settingsRowAppearance')}
          value={labelOf(themeOptions, themePreference)}
          onClick={() => onOpen('appearance')}
        />
        <SettingsCardRow
          testId="settings-row-general"
          icon={<IconSettingsOutline16 />}
          label={t('settingsRowGeneral')}
          onClick={() => onOpen('general')}
        />
        <SettingsCardRow
          testId="settings-row-voice"
          icon={<IconMicOutline16 />}
          label={t('settingsRowVoice')}
          onClick={() => onOpen('voice')}
        />
      </SettingsGroup>

      <SettingsGroup titleKey="settingsGroupData">
        <SettingsCardRow
          testId="settings-row-data"
          icon={<IconDataOutline16 />}
          label={t('settingDialogAsideDataOptionLabel')}
          onClick={() => onOpen('data')}
        />
      </SettingsGroup>

      {/* 位置靠下、在「关于」之上（用户指定）；有未读时这一行右侧带「红点 + 未读数」 */}
      <SettingsGroup titleKey="settingsGroupAnnouncement">
        <AnnouncementRow onClick={() => onOpen('announcement')} />
      </SettingsGroup>

      <SettingsGroup titleKey="settingsGroupAbout">
        {/* 开发团队社媒（抖音号）+「完全免费」声明：产品方第六轮口径，放在「关于」组第一行 */}
        <DouyinSetting />
        <SettingsCardRow
          testId="settings-row-update"
          icon={<IconRefreshOutline16 />}
          label={t('settingDialogAppUpdate')}
          value={bundledApp().version}
          valueTestId="app-version"
          onClick={() => onOpen('update')}
        />
        {/* 反馈走既有的 `FeedbackDialog`（写反馈 / 日志自检两个出口都在那一层），不新写第二套 */}
        <SettingsCardRow
          testId="settings-row-help"
          icon={<IconHelpOutline16 />}
          label={t('settingsRowHelpFeedback')}
          onClick={onFeedback}
        />
      </SettingsGroup>
    </div>
  )
}

/**
 * 「公告栏」二级页：列表 + 一键已读。
 *
 * 数据是**本地 mock**（`src/services/announcements/**`）：4 条公告、已读状态存 localStorage、
 * 不连后端、不发任何请求。列表本身（红点 / 标题 / 相对时间 / 2 行摘要可展开）在
 * `components/announcements/AnnouncementList.tsx` 里，这里只负责「卡片 + 一键已读」这层外壳。
 *
 * 「一键已读」的可用性直接看 `unreadCount`：没有未读时置灰（点了也没意义），
 * 文案与词条保持产品方口径（`settingsAnnouncementMarkAllRead` = 「一键已读」）。
 */
const AnnouncementSettings = () => {
  const t = useTranslate()
  const { unreadCount } = useAnnouncements()
  return (
    <>
      <SettingsCard>
        <AnnouncementList />
      </SettingsCard>
      <SettingsCard>
        <div className={styles.announcementActions}>
          <Button
            variant="outlined"
            size="m"
            disabled={unreadCount === 0}
            data-testid="settings-announcement-read"
            onClick={markAllRead}
          >
            {t('settingsAnnouncementMarkAllRead')}
          </Button>
        </div>
      </SettingsCard>
    </>
  )
}

const SettingsContent = ({ visible }: { visible: boolean }) => {
  const t = useTranslate()
  /**
   * 这次打开落在哪一页。
   *
   * 初值来自 `useSettingsDialog.getState()`（只在挂载时读一次）：`SettingsContent` 每次开合都会
   * 重新挂载（`SettingsDialog` 不在 `mounted` 时返回 null），所以「打开设置落在请求的那一页」
   * 与「弹层内自己换页」两件事互不干扰。
   */
  // #711 兜底：旧版本可能留下 `'memory'` 这类脏值，先收敛成合法分组，再映射成落点页
  const [section] = useState(() =>
    normalizeSettingsSection(useSettingsDialog.getState().section)
  )
  const [page, setPage] = useState<SettingsPage | null>(() => landingPageOf(section))
  /**
   * 账户与消费里当前打开的下级页面（`null` = L1 列表页，见 `AccountConsumePage`）。
   * 初值来自 `openAccountConsume(tab)`（#817）：付款回跳 / 消息流 CTA 靠它直接落到某一页。
   */
  const [accountPage, setAccountPage] = useState<AccountSubPage | null>(
    () => useSettingsDialog.getState().accountConsumeTab
  )
  const historyImport = useHistoryImport()
  const historyDelete = useHistoryDelete()
  // 反馈弹窗：integrity=true 表示从「检查日志完整性」进入，自检面板默认展开
  const [feedback, setFeedback] = useState({ open: false, integrity: false })
  const replacingHistory = useChatStore((state) => state.importingHistory)
  const historyBusy = historyImport.busy || historyDelete.busy || replacingHistory
  // 覆盖确认 / 删除确认叠在设置之上时，设置层的 X 与点击遮罩一律不可用：
  // 那层遮罩是全屏的，第一次点击只会落到上层的「取消」上，用户会以为 X 坏了、
  // 必须点两次才能退出设置（issue #28 缺陷 2）。确认框关掉后自动恢复。
  const confirmOpen = historyImport.source !== null || historyDelete.opened

  /** 点一级行：进目标二级页；「账户与消费」一律从它自己的 L1 起步（与老的「切 tab 回 L1」同一口径） */
  const openPage = (next: SettingsPage) => {
    if (next === 'consume') {
      setAccountPage(null)
    }
    setPage(next)
  }

  /** 左上角「‹ 返回」：内容区整页换回一级列表，弹层本身不关 */
  const back = () => {
    setPage(null)
    setAccountPage(null)
  }

  /** 二级页内容（每页只有一屏，没有第三层） */
  const renderPage = (): ReactNode => {
    if (page === 'consume') {
      // 自带页内行与二级头的组件，不套卡片外壳（它不是「一行一卡」的列表）
      return <AccountConsumePage page={accountPage} onNavigate={setAccountPage} />
    }
    if (page === 'data') {
      return (
        <SettingsCard>
          <ImportHistory historyImport={historyImport} disabled={historyBusy} />
          <ExportHistory disabled={historyBusy} />
          <SettingCell
            label={t('feedbackCellLabel')}
            description={t('feedbackCellDescription')}
            status={null}
            className={styles.wrapActionsCell}
            action={
              <>
                <Button
                  variant="outlined"
                  size="m"
                  className={styles.cellButton}
                  onClick={() => setFeedback({ open: true, integrity: false })}
                >
                  {t('feedbackCellAction')}
                </Button>
                {/* 用户反馈前可先自检：条数 / 时间跨度 / 事件类型覆盖 / 缺失项 */}
                <Button
                  variant="outlined"
                  size="m"
                  className={styles.cellButton}
                  onClick={() => setFeedback({ open: true, integrity: true })}
                >
                  {t('feedbackIntegrityCheck')}
                </Button>
              </>
            }
          />
          <SettingCell
            label={t('deleteAllSessions')}
            status={null}
            action={
              <Button
                variant="dangerOutlined"
                size="m"
                className={styles.cellButton}
                disabled={historyBusy}
                onClick={historyDelete.open}
              >
                {t('delete')}
              </Button>
            }
          />
        </SettingsCard>
      )
    }
    if (page === 'appearance') {
      // 主题三个选块（原「通用设置」里的 ThemeSetting）+ 聊天背景（原「数据管理」里的 ChatBackgroundField）
      return (
        <SettingsCard>
          <ThemeSetting />
          <ChatBackgroundField />
        </SettingsCard>
      )
    }
    if (page === 'general') {
      // 通用：语言 / 思考过程 / 回车键行为三行**平铺在同一页**，右侧各自直接是 Select，不再往下钻一层
      return (
        <SettingsCard>
          <LocaleSetting />
          <ThinkingDisplaySetting />
          <EnterKeySettings />
        </SettingsCard>
      )
    }
    if (page === 'voice') {
      // 语音：朗读音色 + 朗读设置（字号 / 字重 / 行高）平铺在同一页。
      // 「朗读设置」这行小标题是卡片内的块标题：字号/字重/行高是**三项**，没有它就看不出这组是「朗读」的。
      return (
        <SettingsCard>
          <TtsVoiceSetting />
          <div className={styles.cardLabel}>{t('settingsRowReading')}</div>
          <ReadingSettings />
        </SettingsCard>
      )
    }
    if (page === 'announcement') {
      return <AnnouncementSettings />
    }
    if (page === 'update') {
      // 内置更新只在 APK 里有落地：Web 端只显示版本，不渲染检查更新（见 AppVersionField 注释）
      return (
        <SettingsCard>{isAndroidUpdate() ? <AppUpdateField /> : <AppVersionField />}</SettingsCard>
      )
    }
    return null
  }

  /**
   * 标题栏（居中标题 + 右上圆形 X）是设置容器的，账户与消费的下级页也从这里取名字 ——
   * 那套子页面第五轮起不再自己画页头（视觉统一，避免一屏两个标题两条返回）。
   */
  const consumeSubPage = page === 'consume' ? accountPage : null
  const title =
    page === null
      ? t('settings')
      : consumeSubPage !== null
        ? t(ACCOUNT_SUB_PAGE_TITLES[consumeSubPage])
        : t(PAGE_TITLES[page])
  /** 消费子页的「返回」由那页自己给（回消费入口页）；其余二级页回一级列表 */
  const showSettingsBack = page !== null && consumeSubPage === null

  return (
    <>
      <Modal
        title={title}
        closable
        dismissDisabled={confirmOpen}
        visible={visible}
        className={styles.dialog}
        mainClassName={styles.dialogMain}
        onClose={() => {
          if (!historyDelete.busy && !confirmOpen) {
            closeSettings()
          }
        }}
      >
        <div className={styles.content}>
          {page === null ? (
            <RootList
              onOpen={openPage}
              onFeedback={() => setFeedback({ open: true, integrity: false })}
            />
          ) : (
            <div className={styles.pageBody} data-testid={`settings-page-${page}`}>
              {showSettingsBack ? <SettingsBackButton testId="settings-back" onClick={back} /> : null}
              {renderPage()}
            </div>
          )}
        </div>
      </Modal>
      {historyImport.source ? <ImportConfirm historyImport={historyImport} /> : null}
      {historyDelete.opened ? <DeleteAllConfirm historyDelete={historyDelete} /> : null}
      <FeedbackDialog
        open={feedback.open}
        integrity={feedback.integrity}
        onClose={() => setFeedback((current) => ({ ...current, open: false }))}
      />
    </>
  )
}

/** 删除确认保留在设置之上；失败可重试，成功只关闭确认弹窗。 */
const DeleteAllConfirm = ({
  historyDelete,
}: {
  historyDelete: ReturnType<typeof useHistoryDelete>
}) => {
  const t = useTranslate()
  return (
    <Modal
      title={t('deleteAllSessionsModalTitle')}
      className={styles.deleteConfirm}
      onClose={historyDelete.cancel}
      footer={
        <div className={styles.deleteActions} aria-busy={historyDelete.busy}>
          <Button
            variant="outlined"
            autoFocus
            disabled={historyDelete.busy}
            onClick={historyDelete.cancel}
          >
            {t('cancel')}
          </Button>
          <Button
            variant="danger"
            disabled={historyDelete.busy}
            onClick={() => void historyDelete.confirm()}
          >
            {t(historyDelete.busy ? 'historyDeleting' : 'deleteAllSessions')}
          </Button>
        </div>
      }
    >
      {t('deleteAllSessionsModalDescription')}
    </Modal>
  )
}

const useHistoryDelete = () => {
  const [opened, setOpened] = useState(false)
  const [busy, setBusy] = useState(false)
  const deleting = useRef(false)

  const confirm = async () => {
    if (deleting.current) {
      return
    }
    deleting.current = true
    setBusy(true)
    try {
      await clearHistory()
      setOpened(false)
      showToast({ key: 'historyDeleted' })
    } catch {
      showToast({ key: 'historyDeleteFailed', type: 'error' })
    } finally {
      deleting.current = false
      setBusy(false)
    }
  }

  return {
    opened,
    busy,
    open: () => setOpened(true),
    cancel: () => {
      if (!deleting.current) {
        setOpened(false)
      }
    },
    confirm,
  }
}

const LocaleSetting = () => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  return (
    <SettingCell
      label={t('settingsLocalePreference')}
      status={null}
      action={
        <Select
          ariaLabel={t('settingsLocalePreference')}
          value={locale}
          options={[
            { value: 'zh-CN', label: t('settingsLocaleZhCN'), lang: 'zh-CN' },
            { value: 'en-US', label: t('settingsLocaleEnUS'), lang: 'en' },
          ]}
          onChange={setLocale}
        />
      }
    />
  )
}

/**
 * 思考过程显示方式：折叠（默认）/ 展开 / 不显示。
 * 与输入框上的「深度思考」开关是两件事——那个决定要不要思考，这里决定思考内容怎么呈现。
 */
const thinkingDisplayOptions: { value: ThinkingDisplay; label: TranslationKey }[] = [
  { value: 'collapsed', label: 'settingDialogThinkingDisplayCollapsed' },
  { value: 'expanded', label: 'settingDialogThinkingDisplayExpanded' },
  { value: 'hidden', label: 'settingDialogThinkingDisplayHidden' },
]

const ThinkingDisplaySetting = () => {
  const t = useTranslate()
  const thinkingDisplay = useSettings((state) => state.thinkingDisplay)
  return (
    <SettingCell
      label={t('settingDialogThinkingDisplayLabel')}
      description={t('settingDialogThinkingDisplayDescription')}
      status={null}
      className={styles.stackedCell}
      action={
        <Select
          ariaLabel={t('settingDialogThinkingDisplayLabel')}
          value={thinkingDisplay}
          options={thinkingDisplayOptions.map((option) => ({
            value: option.value,
            label: t(option.label),
          }))}
          onChange={setThinkingDisplay}
        />
      }
    />
  )
}

/** 朗读音色：stella（海星，女声）/ tide（暗潮，男声） */
const TtsVoiceSetting = () => {
  const t = useTranslate()
  const ttsVoice = useSettings((state) => state.ttsVoice)
  return (
    <SettingCell
      label={t('settingsTtsVoice')}
      status={null}
      action={
        <Select
          ariaLabel={t('settingsTtsVoice')}
          value={ttsVoice}
          options={[
            { value: 'stella', label: t('settingsTtsVoiceStella') },
            { value: 'tide', label: t('settingsTtsVoiceTide') },
          ]}
          onChange={setTtsVoice}
        />
      }
    />
  )
}

/** 导入方式三选一（#390）：默认合并，整包覆盖是破坏性的那一项。 */
const importModeOptions: { value: ImportMode; label: TranslationKey; hint: TranslationKey }[] = [
  { value: 'merge', label: 'historyImportModeMerge', hint: 'historyImportModeMergeHint' },
  { value: 'skip', label: 'historyImportModeSkip', hint: 'historyImportModeSkipHint' },
  { value: 'overwrite', label: 'historyImportModeOverwrite', hint: 'historyImportModeOverwriteHint' },
]

/**
 * 导入确认，叠在设置弹窗上：**先选导入方式**（合并 / 跳过已存在 / 整包覆盖），再确认。
 *
 * 整包覆盖要保持「二次确认」：选中它之后主按钮换成「确认覆盖导入」，且必须再勾一次
 * 「本地现有 N 条会话将被清除」才可点 —— 一次点击走不到清空数据那一步。
 * 链接导入在这一步之后还要下载 → 解析 → 导入，全程不关闭弹窗：
 * 逐阶段显示「已下载 8.4MB/20.2MB（42%）」这类真实进度，任何时候都能取消。
 */
const ImportConfirm = ({
  historyImport,
}: {
  historyImport: ReturnType<typeof useHistoryImport>
}) => {
  const t = useTranslate()
  const progress = historyImport.progress
  const percent = progressPercent(progress)
  const localSessions = useChatStore((state) => state.sessions.length)
  const overwrite = historyImport.mode === 'overwrite'
  // 整包覆盖：本地确实有会话时必须显式勾选，勾选前主按钮不可点（二次确认）。
  const needsAcknowledgement = overwrite && localSessions > 0
  const canConfirm = progress === null && (!needsAcknowledgement || historyImport.acknowledged)
  return (
    <Modal
      title={t('historyImportConfirmTitle')}
      className={styles.importConfirm}
      onClose={historyImport.cancel}
      footer={
        <>
          <Button variant="outlined" size="m" autoFocus onClick={historyImport.cancel}>
            {t('cancel')}
          </Button>
          <Button
            variant={overwrite ? 'danger' : 'dangerOutlined'}
            size="m"
            disabled={!canConfirm}
            onClick={() => void historyImport.confirm()}
          >
            {t(
              progress !== null
                ? 'historyImportUrlDownloading'
                : overwrite
                  ? 'historyImportConfirmOverwrite'
                  : 'historyImportConfirm'
            )}
          </Button>
        </>
      }
    >
      <div className={styles.importConfirmText}>
        {progress === null ? (
          <>
            <div className={styles.description}>{t('historyImportConfirmDescription')}</div>
            <div
              role="radiogroup"
              aria-label={t('historyImportModeLabel')}
              className={styles.importModeGroup}
            >
              {importModeOptions.map((option) => {
                const selected = historyImport.mode === option.value
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    data-import-mode={option.value}
                    className={clsx(styles.importMode, selected && styles.importModeSelected)}
                    onClick={() => historyImport.setMode(option.value)}
                  >
                    <span
                      className={clsx(
                        styles.importModeRadio,
                        selected && styles.importModeRadioOn
                      )}
                      aria-hidden="true"
                    />
                    <span className={styles.importModeText}>
                      <span
                        className={clsx(
                          styles.importModeTitle,
                          option.value === 'overwrite' && styles.importModeDanger
                        )}
                      >
                        {t(option.label)}
                      </span>
                      <span className={styles.importModeHint}>
                        {t(option.hint, { count: localSessions })}
                      </span>
                    </span>
                  </button>
                )
              })}
            </div>
            {needsAcknowledgement ? (
              <label className={styles.importModeAcknowledgement}>
                <input
                  type="checkbox"
                  checked={historyImport.acknowledged}
                  onChange={(event) => historyImport.setAcknowledged(event.currentTarget.checked)}
                />
                <span className={styles.importModeDanger}>
                  {t('historyImportOverwriteAcknowledge', { count: localSessions })}
                </span>
              </label>
            ) : null}
            <div className={clsx(styles.description, styles.importModeConflictRule)}>
              {t('historyImportConflictRule')}
            </div>
          </>
        ) : (
          <div className={styles.progressBlock}>
            <div className={styles.progressLabel}>{progressLabel(t, progress)}</div>
            {percent === null ? null : (
              <div className={styles.progressTrack}>
                <div
                  className={styles.progressFill}
                  style={{ transform: `scaleX(${percent / 100})` }}
                />
              </div>
            )}
            <div className={styles.description}>{t('historyImportUrlDownloadingHint')}</div>
          </div>
        )}
      </div>
    </Modal>
  )
}

const themeOptions: { value: ThemePreference; label: TranslationKey; icon: ReactNode }[] = [
  {
    value: 'light',
    label: 'avatarMenuSettingsDialogThemeSelectLightOption',
    icon: <IconLightOutline16 />,
  },
  {
    value: 'dark',
    label: 'avatarMenuSettingsDialogThemeSelectDarkOption',
    icon: <IconDarkOutline16 />,
  },
  {
    value: 'system',
    label: 'avatarMenuSettingsDialogThemeSelectSystemOption',
    icon: <IconFollowsystemOutline16 />,
  },
]

/**
 * 主题项：标题下方浅色 / 深色 / 跟随系统三个选块。
 * 与下方语言选项连续排列。
 */
const ThemeSetting = () => {
  const t = useTranslate()
  const themePreference = useSettings((state) => state.themePreference)
  const label = t('avatarMenuSettingsDialogThemeItemLabel')
  return (
    <div className={styles.theme}>
      {label}
      <div role="radiogroup" aria-label={label} className={styles.themeOptions}>
        {themeOptions.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={themePreference === option.value}
            className={clsx(
              styles.themeOption,
              themePreference === option.value && styles.themeOptionSelected
            )}
            onClick={() => setThemePreference(option.value)}
          >
            {option.icon}
            {t(option.label)}
          </button>
        ))}
      </div>
    </div>
  )
}

/**
 * `reason` 为失败原因的文案 key，展示时按当前语言翻译后填入 `message` 参数；
 * `detail` 是紧跟在主文案后面的补充（#390：增量导入的「新增 / 覆盖 / 跳过」明细）。
 */
type Status =
  | (TranslationMessage & { error?: boolean; reason?: TranslationKey; detail?: TranslationMessage })
  | null

/** 导入状态带来源：文件导入的提示只显示在「导入历史对话」行，链接导入只显示在「从链接导入」行。 */
type ImportStatus = { target: 'file' | 'url'; message: Status }

/** 失败附带原因：预期的错误用对应文案（连同其占位符参数）作原因，其他错误用错误信息。 */
const errorStatus = (key: TranslationKey, error: unknown): Status => ({
  key,
  ...(error instanceof BackupError
    ? { reason: error.key, params: error.params }
    : { params: { message: error instanceof Error ? error.message : String(error) } }),
  error: true,
})

/** 状态的最终文案（含失败原因），供显示与复制共用。 */
const statusText = (t: ReturnType<typeof useTranslate>, status: Status): string =>
  status === null
    ? ''
    : `${t(status.key, {
        ...status.params,
        ...(status.reason ? { message: t(status.reason, status.params) } : {}),
      })}${status.detail ? t(status.detail.key, status.detail.params) : ''}`

/** 说明文字：有状态就显示状态（失败标红），否则显示静态说明。 */
const CellText = ({ status, description }: { status: Status; description?: string }) => {
  const t = useTranslate()
  if (!status && !description) {
    return null
  }
  return (
    <div className={clsx(styles.description, status?.error && styles.error)}>
      {status ? statusText(t, status) : description}
    </div>
  )
}

/** 失败原因一眼能看完的字符数；更长的（带服务端原文）折叠到 4 行，可展开、可复制。 */
const DETAIL_CLAMP_CHARS = 60

/**
 * 失败提示：默认最多 4 行（360dp 宽也不会被裁切），可展开看全文，
 * 并可一键复制（长按选中复制同样可用）——用户反馈问题时要能把原文贴出来。
 */
const ErrorNotice = ({ text }: { text: string }) => {
  const t = useTranslate()
  const [expanded, setExpanded] = useState(false)
  const long = text.length > DETAIL_CLAMP_CHARS
  return (
    <div className={styles.errorBox}>
      <div className={clsx(styles.error, long && !expanded && styles.errorClamped)}>{text}</div>
      {long || text.includes('403') ? (
        <div className={styles.errorActions}>
          {long ? (
            <button
              type="button"
              className={styles.errorAction}
              onClick={() => setExpanded((value) => !value)}
            >
              {t(expanded ? 'detailsCollapse' : 'detailsExpand')}
            </button>
          ) : null}
          <button
            type="button"
            className={styles.errorAction}
            onClick={() => void copyText(text).then((ok) => !ok && showToast(t('copyFailed')))}
          >
            {t('copy')}
          </button>
        </div>
      ) : null}
    </div>
  )
}

/** 详情条数上限：再多也没人看，且避免长会话把内存撑大。 */
const MAX_TRACE_ENTRIES = 100

/** 相对时间：mm:ss.S（少数几十秒的导入够用，也方便用户对着截图说“卡在这里”）。 */
const traceTime = (ms: number): string => {
  const total = Math.max(0, ms)
  const minutes = Math.floor(total / 60_000)
  const seconds = Math.floor((total % 60_000) / 1000)
  const tenth = Math.floor((total % 1000) / 100)
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${tenth}`
}

/**
 * 复制到剪贴板前的兜底脱敏：
 * 详情里本来就不存完整导URL（只有 redactUrl 后的路径），这里再把可能漏进来的
 * 签名/密钥/查询串与超链接抹掉，避免用户把私密导出链接贴到反馈里。
 */
const redactTraceText = (text: string): string =>
  text
    .replace(/\b(Signature|AccessKeyId|Expires|X-Amz-[A-Za-z-]+)=[^&\s)]*/gi, '$1=***')
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
    .replace(/https?:\/\/[^\s)]+/gi, (match) => {
      try {
        const url = new URL(match)
        return `${url.protocol}//${url.host}/***`
      } catch {
        return '***'
      }
    })

/** 一条详情的人话文案；拿不到总数/字节时不编数字。 */
const traceLine = (t: ReturnType<typeof useTranslate>, entry: ImportTraceEntry): string => {
  switch (entry.kind) {
    case 'start':
      return t('importTraceStart')
    case 'download':
      return entry.totalBytes === undefined
        ? t('importTraceDownload', { done: formatBytes(entry.bytes ?? 0) })
        : t('importTraceDownloadTotal', {
            done: formatBytes(entry.bytes ?? 0),
            total: formatBytes(entry.totalBytes),
          })
    case 'heartbeat':
      // 心跳：这一段没有任何新字节，用来证明「最后活着的时刻」+ 已下载多少 + 停滞了多久
      return entry.totalBytes === undefined
        ? t('importTraceHeartbeatUnknown', {
            done: formatBytes(entry.bytes ?? 0),
            idle: Math.round((entry.idleMs ?? 0) / 1000),
          })
        : t('importTraceHeartbeat', {
            done: formatBytes(entry.bytes ?? 0),
            total: formatBytes(entry.totalBytes),
            idle: Math.round((entry.idleMs ?? 0) / 1000),
          })
    case 'resume':
      // 续传：重试不再从 0 开始（#38）
      return t('importTraceResume', { done: formatBytes(entry.bytes ?? 0) })
    case 'restart':
      // 服务端忽略 Range：已丢弃本地字节、从头重下，必须让用户看到
      return t('importTraceRestart')
    case 'check':
      return entry.totalSessions === undefined
        ? t('importTraceCheckUnknown')
        : t('importTraceCheck', { total: entry.totalSessions })
    case 'session':
      return entry.totalSessions === undefined
        ? t('importTraceSessionUnknown', { done: entry.sessions ?? 0 })
        : t('importTraceSession', { done: entry.sessions ?? 0, total: entry.totalSessions })
    case 'image':
      return t('importTraceImage', { count: entry.images ?? 0 })
    case 'done':
      return t('importTraceDone', { count: entry.sessions ?? 0 })
    case 'cancel':
      return t('importTraceCancel')
    case 'error':
    default: {
      const reason =
        entry.message === 'unreachable'
          ? t('importTraceReasonUnreachable')
          : entry.message === 'interrupted'
            ? t('importTraceReasonInterrupted')
            : entry.message === 'timeout'
              ? t('importTraceReasonTimeout')
              : entry.message === 'expired'
                ? t('importTraceReasonExpired')
                : entry.message === 'signature'
                  ? t('importTraceReasonSignature')
                  : entry.message === 'forbidden'
                    ? t('importTraceReasonForbidden')
                    : entry.message === 'stalled'
                      ? t('importTraceReasonStalled', {
                          done: formatBytes(entry.bytes ?? 0),
                          seconds: Math.round((entry.idleMs ?? 0) / 1000),
                        })
                      : entry.message === 'deadline'
                        ? t('importTraceReasonDeadline', {
                            minutes: Math.max(1, Math.round(entry.at / 60_000)),
                          })
                        : entry.status !== undefined && entry.status > 0
                        ? t('importTraceReasonHttp', { status: entry.status })
                        : t('importTraceReasonNetwork')
      const stage =
        entry.status === undefined || entry.status === 0
          ? t('importTraceStageDownload')
          : t('importTraceStageDownload')
      return t('importTraceError', { stage, reason })
    }
  }
}

/**
 * 「导入详情」：默认折叠，展开后是带时间的少量人话事件（下载真实字节/校验/会话/图片/完成/取消/失败）。
 * 事实来自 urlImport 的 onTrace（与 diagnostics 同一处产生），最多 100 条，复制时再脱敏一遍。
 */
const ImportTraceDetails = ({ entries }: { entries: ImportTraceEntry[] }) => {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  if (entries.length === 0) {
    return null
  }
  const last = entries[entries.length - 1]
  const copy = async () => {
    const body = entries
      .map((entry) => `${traceTime(entry.at)}  ${traceLine(t, entry)}`)
      .join('\n')
    const ok = await copyText(redactTraceText(`DeepSeek import details\n${body}`))
    if (!ok) {
      showToast(t('copyFailed'))
    }
  }
  return (
    <div className={styles.traceBox}>
      <div className={styles.traceHeader}>
        <button type="button" className={styles.errorAction} onClick={() => setOpen((value) => !value)}>
          {open ? t('detailsCollapse') : t('detailsExpand')}
        </button>
        <span className={styles.traceTitle}>{t('importTraceTitle', { count: entries.length })}</span>
        <span className={styles.traceElapsed}>{t('importTraceElapsed', { time: traceTime(last.at) })}</span>
        <button type="button" className={styles.errorAction} onClick={() => void copy()}>
          {t('importTraceCopy')}
        </button>
      </div>
      {open ? (
        <ol className={styles.traceList}>
          {entries.map((entry, index) => (
            <li key={`${entry.at}-${index}`} className={styles.traceRow}>
              <span className={styles.traceTime}>{traceTime(entry.at)}</span>
              <span className={styles.traceText}>{traceLine(t, entry)}</span>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  )
}

/** 字节数：弱网下「已下载 16KB」这种小数值也要看得见，所以 KB 之前不换算成小数。 */
const formatBytes = (bytes: number): string => {
  if (bytes < 1024) {
    return `${bytes}B`
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)}KB`
  }
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

/** 分阶段文案：下载（字节/百分比）→ 解析 → 导入（n/总数），取代原来恒定的「下载中...」。 */
const progressLabel = (
  t: ReturnType<typeof useTranslate>,
  progress: UrlImportProgress
): string => {
  if (progress.phase === 'downloading') {
    const done = formatBytes(progress.downloadedBytes)
    if (progress.totalBytes === undefined || progress.totalBytes === 0) {
      return t('historyImportUrlDownloadingBytes', { done })
    }
    const percent = Math.min(99, Math.round((progress.downloadedBytes / progress.totalBytes) * 100))
    return t('historyImportUrlDownloadingProgress', {
      done,
      total: formatBytes(progress.totalBytes),
      percent,
    })
  }
  if (progress.phase === 'decoding') {
    return t('historyImportUrlDecoding')
  }
  return progress.totalSessions === undefined
    ? t('historyImportUrlImportingCount', { processed: progress.processed })
    : t('historyImportUrlImporting', {
        processed: progress.processed,
        total: progress.totalSessions,
      })
}

/** 进度条百分比：只在能算出比例时显示（下载有总大小 / 导入有会话总数）。 */
const progressPercent = (progress: UrlImportProgress | null): number | null => {
  if (!progress) {
    return null
  }
  if (progress.phase === 'downloading') {
    if (!progress.totalBytes) {
      return null
    }
    return Math.min(100, Math.round((progress.downloadedBytes / progress.totalBytes) * 100))
  }
  if (progress.phase === 'importing' && progress.totalSessions) {
    return Math.min(100, Math.round((progress.processed / progress.totalSessions) * 100))
  }
  return null
}

const SettingCell = ({
  label,
  description,
  status,
  action,
  extra,
  className,
}: {
  label: string
  description?: string
  status: Status
  action: ReactNode
  /** 说明位下方的附加内容（导出进度条，见 #336 §1）。 */
  extra?: ReactNode
  className?: string
}) => (
  <div className={clsx(styles.cell, styles.row, className)}>
    <div className={styles.text}>
      <div className={styles.label}>{label}</div>
      <CellText status={status} description={description} />
      {extra}
    </div>
    <div className={styles.cellActions}>{action}</div>
  </div>
)

/**
 * 抖音号：值做成可点的胶囊（等宽 + 强调色），点一下复制。
 * 整行用 .wrapActionsCell——窄屏下文本列独占一行、胶囊整行下移，
 * 不让右侧动作区把「抖音号」这个 label 挤成窄条（#57 的坑：.text 的 flex-basis:0 会塌陷）。
 */
const DouyinSetting = () => {
  const t = useTranslate()
  const copy = async () => {
    const copied = await copyText(DOUYIN_ACCOUNT_ID)
    showToast(douyinCopyToast(copied))
  }
  return (
    <SettingsCardInfoRow
      icon={<IconSocialOutline16 />}
      label={t('settingsSocialLabel')}
      // 免费声明（限定「软件本体」）：这一行的说明位，正文式换行、不截断
      description={t('settingsSocialFreeNotice')}
      value={
        <button
          type="button"
          className={styles.douyinValue}
          data-testid="douyin-id-copy"
          aria-label={t('settingDouyinCopyAria')}
          onClick={() => void copy()}
        >
          <span className={styles.douyinValueText}>{DOUYIN_ACCOUNT_ID}</span>
          <IconCopyOutline16 />
        </button>
      }
    />
  )
}

/** 导入源：本地文件，或原生端的直链（先下载再走同一条导入链路）。 */
type ImportSource = { kind: 'file'; file: File } | { kind: 'url'; url: string }

/** 进度刷新的最小间隔：块之间本来就有 ~1s，这层节流保证不会每条进度都 setState。 */
const PROGRESS_MIN_INTERVAL_MS = 100

/** 链接导入的失败原因：直接展示原因本身（不再套「从链接导入失败：」前缀），关键信息在前半句。 */
const urlErrorStatus = (error: unknown): Status =>
  error instanceof BackupError
    ? { key: error.key, params: error.params, error: true }
    : {
        key: 'historyImportFromUrlFailed',
        params: { message: error instanceof Error ? error.message : String(error) },
        error: true,
      }

/**
 * 导入状态：选中来源后先选导入方式（默认合并），确认后才真正导入。
 * 链接导入多一段「分阶段进度」：下载（字节/百分比）→ 解析 → 导入 n/总数；
 * 进度节流 100ms，取消后界面上立刻回到可重试状态（下载结果被丢弃，不写任何数据）。
 */
const useHistoryImport = () => {
  const [source, setSource] = useState<ImportSource | null>(null)
  /** #390：导入方式三选一，默认 merge（保留本地会话，最安全）；整包覆盖必须再勾一次确认。 */
  const [mode, setMode] = useState<ImportMode>('merge')
  const [acknowledged, setAcknowledged] = useState(false)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<UrlImportProgress | null>(null)
  const [trace, setTrace] = useState<ImportTraceEntry[]>([])
  const [status, setStatus] = useState<ImportStatus | null>(null)
  // #49：这一次导入里被丢掉的条目（损坏的消息 / 整会话）。成功提示要带上条数，明细列在下面。
  const [skipped, setSkipped] = useState<ImportSkip[]>([])
  // #390：这一次导入的结果摘要（模式 + 新增/覆盖/跳过 + 被跳过的会话标题），用于结果明细。
  const [summary, setSummary] = useState<HistoryImportSummary | null>(null)
  const [url, setUrl] = useState('')
  const importing = useRef(false)
  // 取消后仍可能有已发出的下载在跑：用自增的 run 标记作废旧结果，不影响新的一轮导入。
  const run = useRef(0)
  const abort = useRef<AbortController | null>(null)
  const latest = useRef<UrlImportProgress | null>(null)
  const lastEmit = useRef(0)

  /** 节流后的进度写入：阶段变化立即生效，同一阶段最多 100ms 一次。 */
  const emitProgress = (next: UrlImportProgress) => {
    const previous = latest.current
    const phaseChanged = previous === null || previous.phase !== next.phase
    const now = Date.now()
    if (!phaseChanged && now - lastEmit.current < PROGRESS_MIN_INTERVAL_MS) {
      return
    }
    lastEmit.current = now
    latest.current = next
    setProgress(next)
  }

  const resetProgress = () => {
    latest.current = null
    lastEmit.current = 0
    setProgress(null)
  }

  /** 详情只保留最近 100 条；节流在上游（urlImport）做过，这里只做上限与顺序。 */
  const pushTrace = (entry: ImportTraceEntry) => {
    setTrace((previous) => {
      const next = [...previous, entry]
      return next.length > MAX_TRACE_ENTRIES ? next.slice(next.length - MAX_TRACE_ENTRIES) : next
    })
  }

  const finish = (id: number) => {
    if (run.current === id) {
      importing.current = false
      setBusy(false)
      resetProgress()
    }
  }

  const importFile = async (file: File, mode: ImportMode) => {
    try {
      const result = await importHistory(file, { mode })
      // 条数与明细都取自 store：importArchive 把跳过条目交回 store.importSkipped，这里只负责显示。
      const dropped = useChatStore.getState().importSkipped
      setSkipped(dropped)
      setSummary(result)
      setStatus({ target: 'file', message: importedMessage(result, dropped.length) })
    } catch {
      setStatus({ target: 'file', message: { key: 'historyImportFailed', error: true } })
    }
  }

  /** 下载 + 解析 + 导入；取消后 (signal.aborted) 不提示、不写入。 */
  const importLink = async (link: string, mode: ImportMode) => {
    const controller = new AbortController()
    abort.current = controller
    setTrace([])
    emitProgress({ phase: 'downloading', downloadedBytes: 0 })
    try {
      const count = await importHistoryFromUrl(link, {
        signal: controller.signal,
        mode,
        onProgress: emitProgress,
        onTrace: pushTrace,
      })
      const dropped = useChatStore.getState().importSkipped
      setSource(null)
      setSkipped(dropped)
      // 结果摘要（含合并明细）由 store 带出来；链接导入返回的仍然只是写入条数，作为兜底。
      const result = useChatStore.getState().importSummary ?? summaryFromCount(count)
      setSummary(result)
      setStatus({ target: 'url', message: importedMessage(result, dropped.length) })
    } catch (error) {
      if (controller.signal.aborted || error instanceof UrlImportCancelled) {
        // 取消：不提示失败，界面上什么错误都不留。
        setSource(null)
        resetProgress()
        return
      }
      setSource(null)
      setStatus({ target: 'url', message: urlErrorStatus(error) })
    }
  }

  const confirm = async () => {
    if (!source || importing.current) {
      return
    }
    importing.current = true
    const id = run.current
    setBusy(true)
    setStatus(null)
    setSkipped([])
    setSummary(null)
    try {
      if (source.kind === 'file') {
        setSource(null)
        await importFile(source.file, mode)
      } else {
        await importLink(source.url, mode)
      }
    } finally {
      abort.current = null
      finish(id)
    }
  }

  /** 换一个来源就回到默认方式：上一次勾的「整包覆盖」不该带到下一次导入上。 */
  const chooseSource = (next: ImportSource) => {
    setMode('merge')
    setAcknowledged(false)
    setSource(next)
  }

  /** 取消：关闭弹窗并丢弃结果（CapacitorHttp 不能 abort，只能不发新块、不再采用它的返回值）。 */
  const cancel = () => {
    run.current += 1
    importing.current = false
    abort.current?.abort()
    abort.current = null
    resetProgress()
    setBusy(false)
    setSource(null)
    setAcknowledged(false)
  }

  /** 重试：从当前链接重新走一遍完整流程（下载 → 解析 → 导入）。 */
  const retry = () => {
    if (importing.current || url.trim() === '') {
      return
    }
    setStatus(null)
    setSource({ kind: 'url', url })
  }

  return {
    source,
    busy,
    progress,
    trace,
    status,
    skipped,
    summary,
    url,
    setUrl,
    mode,
    setMode,
    acknowledged,
    setAcknowledged,
    selectFile: (file: File) => chooseSource({ kind: 'file', file }),
    selectUrl: () => chooseSource({ kind: 'url', url }),
    cancel,
    retry,
    confirm,
  }
}

/** 跳过明细的样式注入：组件自己不 import CSS，才能在裸 Node 单测里真渲染（tests/unit/import-skipped-ui.test.mjs）。 */
const skippedClassNames = {
  box: styles.traceBox,
  header: styles.traceHeader,
  title: styles.traceTitle,
  list: styles.traceList,
  row: styles.traceRow,
  scope: styles.traceTime,
  text: styles.traceText,
}

/** 导入 = 覆盖：用选中文件或链接替换本地全部会话与附件。 */
const ImportHistory = ({
  historyImport,
  disabled,
}: {
  historyImport: ReturnType<typeof useHistoryImport>
  disabled: boolean
}) => {
  const t = useTranslate()
  const inputRef = useRef<HTMLInputElement>(null)
  // 网页端没有原生 HTTP（导出桶无 CORS），不渲染链接入口，只在说明里给出替代做法。
  const native = canImportFromUrl()

  return (
    <>
      <SettingCell
        label={t('historyImport')}
        description={
          native
            ? t('historyImportDescription')
            : `${t('historyImportDescription')} ${t('historyImportUrlWebHint')}`
        }
        status={historyImport.status?.target === 'file' ? historyImport.status.message : null}
        action={
          <>
            <Button
              variant="outlined"
              size="m"
              className={clsx(styles.cellButton, styles.uploadButton)}
              disabled={disabled}
              onClick={() => inputRef.current?.click()}
            >
              <IconUploadOutline14 />
              {t('upload')}
            </Button>
            <input
              ref={inputRef}
              type="file"
              accept=".zip,application/zip,application/x-zip-compressed"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0]
                event.target.value = ''
                if (file) {
                  historyImport.selectFile(file)
                }
              }}
            />
          </>
        }
      />
      {historyImport.status?.target === 'file' &&
      historyImport.summary !== null &&
      historyImport.summary.skippedTitles.length > 0 ? (
        // #390：增量导入里被「保留本地版本」的会话，逐条列出来，别让用户以为它们没进包。
        <div className={clsx(styles.cell, styles.row)}>
          <div className={styles.text}>
            <div className={styles.importConflictSkipped}>
              {t('historyImportConflictSkippedTitle')}：{historyImport.summary.skippedTitles.join('、')}
            </div>
          </div>
        </div>
      ) : null}
      {historyImport.status?.target === 'file' && historyImport.skipped.length > 0 ? (
        // #49：跳过了什么、为什么，摊开在导入这一项下面，不藏在折叠里
        <div className={clsx(styles.cell, styles.row)}>
          <div className={styles.text}>
            <ImportSkippedDetails
              skipped={historyImport.skipped}
              t={t}
              classNames={skippedClassNames}
            />
          </div>
        </div>
      ) : null}
      {native ? <ImportHistoryUrl historyImport={historyImport} disabled={disabled} /> : null}
    </>
  )
}

/** 原生专享：粘贴导出链接，由 App 下载 ZIP 后导入。 */
const ImportHistoryUrl = ({
  historyImport,
  disabled,
}: {
  historyImport: ReturnType<typeof useHistoryImport>
  disabled: boolean
}) => {
  const t = useTranslate()
  const blocked = disabled || historyImport.url.trim() === ''
  const status = historyImport.status?.target === 'url' ? historyImport.status.message : null
  const running = historyImport.progress !== null
  return (
    <div className={clsx(styles.cell, styles.row, styles.linkCell)}>
      <div className={styles.text}>
        <div className={styles.label}>{t('historyImportFromUrl')}</div>
        {status?.error ? (
          // 失败原因可能很长（带服务端原文）：换行 + 最多 4 行 + 可展开、可复制。
          <ErrorNotice text={statusText(t, status)} />
        ) : (
          <CellText status={status} description={t('historyImportUrlDescription')} />
        )}
        <ImportTraceDetails entries={historyImport.trace} />
        {historyImport.status?.target === 'url' && historyImport.skipped.length > 0 ? (
          <ImportSkippedDetails
            skipped={historyImport.skipped}
            t={t}
            classNames={skippedClassNames}
          />
        ) : null}
      </div>
      <div className={styles.linkActions}>
        <div className={clsx(styles.apiKeyInput, styles.linkInput)}>
          <input
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            aria-label={t('historyImportFromUrl')}
            placeholder={t('historyImportUrlPlaceholder')}
            value={historyImport.url}
            disabled={disabled}
            onChange={(event) => historyImport.setUrl(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !blocked) {
                historyImport.selectUrl()
              }
            }}
          />
        </div>
        {status?.error ? (
          // 失败后不必回设置页重来：点一下就从这个链接重走完整流程。
          <Button
            variant="outlined"
            size="m"
            className={clsx(styles.cellButton, styles.retryButton)}
            disabled={blocked || running}
            onClick={() => historyImport.retry()}
          >
            {t('retry')}
          </Button>
        ) : null}
        <Button
          variant="outlined"
          size="m"
          className={clsx(styles.cellButton, styles.uploadButton)}
          disabled={blocked || running}
          onClick={() => historyImport.selectUrl()}
        >
          {t(running ? 'historyImportUrlDownloading' : 'historyImportUrlStart')}
        </Button>
      </div>
    </div>
  )
}

/** 空历史时的说明（#336 §2）：按钮灰着不说原因，用户分不清「点不动」和「点了没产出」。 */
const emptyExportStatus: Status = { key: 'historyExportEmptyNoSessions' }

/**
 * 将全部会话及图片导出为 ZIP 文件。
 *
 * 落盘走 `saveHistoryArchive`（#536）：与侧栏「导出选中」**同一个出口** —— Android 走 ExportText
 * 原生桥（SAF 面板选位置，可取消），Web 走 Blob 下载（WebView 里 `<a download>` 对 blob URL
 * 不会产生文件，#307）。失败码 → 文案的映射也在那个出口里，这里不再自己认 code。
 */
const ExportHistory = ({ disabled }: { disabled: boolean }) => {
  const t = useTranslate()
  const total = useChatStore((state) => state.sessions.length)
  const empty = total === 0
  // 导出中 = 有进度对象；用它代替原来的 busy 布尔，省掉两个状态可能打架的一格。
  const [progress, setProgress] = useState<ExportProgress | null>(null)
  const [status, setStatus] = useState<Status>(null)
  // 进度节流：打包回调是每条会话一次，500 条会话就 500 次 setState，没必要。
  const lastPaint = useRef(0)
  const onProgress = (next: ExportProgress) => {
    const now = Date.now()
    if (next.exported < next.total && now - lastPaint.current < PROGRESS_MIN_INTERVAL_MS) {
      return
    }
    lastPaint.current = now
    setProgress(next)
  }

  const onExport = async () => {
    setStatus(null)
    lastPaint.current = 0
    // 先立起 0/N：按钮立刻变成「导出中…」，而不是等第一条会话打完才有反馈。
    setProgress({ exported: 0, total })
    try {
      const { name, blob } = await exportHistory({ onProgress })
      // 打包完成（进度已到 N/N），剩下的就是一次落盘：交给原生 SAF / Web 下载出口。
      setProgress(null)
      const outcome = await saveHistoryArchive({ filename: name, blob })
      // 用户在选择位置的面板上点了取消：既不是成功也不是失败，界面回到「可以再点一次」的状态。
      setStatus(
        outcome.kind === 'saved'
          ? { key: 'historyExportSaved', params: { name: outcome.name } }
          : outcome.kind === 'failed'
            ? {
                key: outcome.key,
                ...(outcome.params === undefined ? {} : { params: outcome.params }),
                error: true,
              }
            : null
      )
    } catch (error) {
      // 打包阶段的失败（`exportHistory` 抛的）：落盘失败已经在出口里归一成了 `{kind:'failed'}`。
      // 导出上限走 `BackupError('historyExportTooLarge')`，由 errorStatus 的 reason 位带出。
      setStatus(errorStatus('historyExportFailed', error))
    } finally {
      setProgress(null)
    }
  }

  return (
    <SettingCell
      label={t('exportAllLabel')}
      description={t('historyExportDescription')}
      status={progress ? null : (status ?? (empty ? emptyExportStatus : null))}
      extra={
        progress ? (
          <div className={styles.progressBlock}>
            <div className={styles.progressLabel}>
              {t('historyExportProgress', {
                exported: progress.exported,
                total: progress.total,
              })}
            </div>
            <div className={styles.progressTrack}>
              <div
                className={styles.progressFill}
                style={{
                  transform: `scaleX(${
                    progress.total > 0 ? Math.min(1, progress.exported / progress.total) : 0
                  })`,
                }}
              />
            </div>
          </div>
        ) : null
      }
      action={
        <Button
          variant="outlined"
          size="m"
          className={styles.cellButton}
          disabled={disabled || progress !== null || empty}
          onClick={() => void onExport()}
        >
          <IconDownloadOutline16 />
          {t(progress ? 'historyExporting' : 'exportAllDownload')}
        </Button>
      }
    />
  )
}
/**
 * 消息区阅读设置（issue #102）：字号 / 字重 / 行高。
 * 只作用于消息区（聊天正文、思考正文、用户气泡）；设置面板自身与输入框不跟着变。
 * 三项默认档等于改造前的固定字号字重行高，没动过设置的人看到的观感不变。
 */
const readingFontSizeOptions: { value: ReadingFontSize; label: TranslationKey }[] = [
  { value: 'small', label: 'settingDialogReadingSizeSmall' },
  { value: 'standard', label: 'settingDialogReadingSizeStandard' },
  { value: 'large', label: 'settingDialogReadingSizeLarge' },
  { value: 'xlarge', label: 'settingDialogReadingSizeXLarge' },
]

const readingFontWeightOptions: { value: ReadingFontWeight; label: TranslationKey }[] = [
  { value: 'regular', label: 'settingDialogReadingWeightRegular' },
  { value: 'medium', label: 'settingDialogReadingWeightMedium' },
  { value: 'bold', label: 'settingDialogReadingWeightBold' },
]

const readingLineHeightOptions: { value: ReadingLineHeight; label: TranslationKey }[] = [
  { value: 'compact', label: 'settingDialogReadingLineCompact' },
  { value: 'standard', label: 'settingDialogReadingLineStandard' },
  { value: 'relaxed', label: 'settingDialogReadingLineRelaxed' },
]

const ReadingSettings = () => {
  const t = useTranslate()
  const readingFontSize = useSettings((state) => state.readingFontSize)
  const readingFontWeight = useSettings((state) => state.readingFontWeight)
  const readingLineHeight = useSettings((state) => state.readingLineHeight)
  return (
    <>
      <SettingCell
        label={t('settingDialogReadingFontSize')}
        description={t('settingDialogReadingGroupLabel')}
        status={null}
        action={
          <Select
            ariaLabel={t('settingDialogReadingFontSize')}
            value={readingFontSize}
            options={readingFontSizeOptions.map((option) => ({
              value: option.value,
              label: t(option.label),
            }))}
            onChange={setReadingFontSize}
          />
        }
      />
      <SettingCell
        label={t('settingDialogReadingFontWeight')}
        status={null}
        action={
          <Select
            ariaLabel={t('settingDialogReadingFontWeight')}
            value={readingFontWeight}
            options={readingFontWeightOptions.map((option) => ({
              value: option.value,
              label: t(option.label),
            }))}
            onChange={setReadingFontWeight}
          />
        }
      />
      <SettingCell
        label={t('settingDialogReadingLineHeight')}
        status={null}
        action={
          <Select
            ariaLabel={t('settingDialogReadingLineHeight')}
            value={readingLineHeight}
            options={readingLineHeightOptions.map((option) => ({
              value: option.value,
              label: t(option.label),
            }))}
            onChange={setReadingLineHeight}
          />
        }
      />
    </>
  )
}

/**
 * 回车键行为（issue #108）：发送 / Ctrl-Cmd 发送 / 只换行。默认「发送」= 改造前的现状，
 * 没动过设置的用户手感完全不变（两条用户反馈分别来自 iOS 与 Android 习惯，所以做成可配置而不是翻转默认）。
 * 判定逻辑在 components/chatInput/enterKey.ts，这里只提供选择入口。
 */
const enterKeyModeOptions: { value: EnterKeyMode; label: TranslationKey }[] = [
  { value: 'enter-send', label: 'settingDialogEnterKeySend' },
  { value: 'modifier-send', label: 'settingDialogEnterKeyModifierSend' },
  { value: 'button-only', label: 'settingDialogEnterKeyButtonOnly' },
]

const EnterKeySettings = () => {
  const t = useTranslate()
  const enterKeyMode = useSettings((state) => state.enterKeyMode)
  return (
    <SettingCell
      label={t('settingDialogEnterKeyMode')}
      description={t('settingDialogEnterKeyModeDescription')}
      status={null}
      className={styles.stackedCell}
      action={
        <Select
          ariaLabel={t('settingDialogEnterKeyMode')}
          value={enterKeyMode}
          options={enterKeyModeOptions.map((option) => ({
            value: option.value,
            label: t(option.label),
          }))}
          onChange={setEnterKeyMode}
        />
      }
    />
  )
}
