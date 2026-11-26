/**
 * 导入包大小上限（issue #34）：**一个数字，两条导入链路共用**。
 *
 * 之前这个上限只存在于 urlImport.ts 里（`200 * 1024 * 1024`），
 * 本地文件导入（backup.ts）完全没有 —— 同一个导出包换个入口进来，
 * 就会先流式写入暂存、再在里面把内存/磁盘吃穿，最后才失败。
 * 所以这里单独成一处：从链接导入、本地文件导入、导出上限（zipWriter.MAX_EXPORT_BYTES）都按它走。
 *
 * ## 2026-11-26：200MiB → 500MiB（先补短板，再提上限）
 *
 * 直接提上限的现场是「导到一半 QuotaExceeded / 长时间卡死」（用户看到的不是「太大不让导」，
 * 而是「导了一大半然后全没了」）。所以这次**先补两个短板，最后才动这个数**：
 *
 * 1. **入库前剩余空间预检**（[quotaPrecheck.ts](./quotaPrecheck.ts)）：解析中央目录拿到
 *    「解压后总量」，乘安全系数，与 `navigator.storage.estimate()` 的 `quota - usage` 比；
 *    不够就**在写第一条会话之前**拒绝，并说清还差多少。探测不到就放行（见那个文件的说明）。
 * 2. **导入进度与取消**（[importArchive.ts](./importArchive.ts)）：分阶段 + 真实条目/会话计数，
 *    取消后走既有 `clearStaging()` 清掉暂存，不留半截数据。
 *
 * 配套改动（改一个必须同步另一个，见 `tests/unit/contract-c3-import-limits.test.mjs`）：
 * - `zipReader.MAX_INFLATE_TOTAL_BYTES`：800MiB → 2GiB（仍是本上限的 4 倍）；
 *   `MAX_INFLATE_RATIO = 200`（zip bomb 比值闸）**没动**，它与上限无关；
 * - `LIMITS.importMaxTotalMs`（直链导入的防御性总预算）：30 分钟 → 60 分钟，
 *   按新上限重算（见 limits.ts 的推导）；
 * - 导出上限自动跟随：`zipWriter.MAX_EXPORT_BYTES = DEFAULT_MAX_IMPORT_BYTES`，别处不再写第二个数字。
 *
 * 官方导出包约 20MB（#34 的原始依据），500MiB 是它的 25 倍余量：正常用户不会碰到，
 * 碰到的是「带大量图片的长期用户」，而图片恰好是解压后总量里最占地方的那部分 ——
 * 这也正是①必须先做的原因。
 */
export const DEFAULT_MAX_IMPORT_BYTES = 500 * 1024 * 1024

/**
 * 剩余空间预检的**安全系数**：判定所需空间 = 解压后总量 × 它。
 *
 * 为什么不是 1.0：`estimate()` 的 `usage` 不含「本次写入还没提交的字节」，IndexedDB 自己还要
 * 留索引 / 事务日志 / 内部碎片的空间，再加上导入期间应用本身也在写诊断与设置。1.25 是「宁可
 * 早一点说空间不够，也不要在 90% 处炸掉」的折中；它只影响**拒绝**的门槛，
 * 不参与任何「能导多少」的计算（真空间不足时 `db.ts` 的 quota 档兜底仍然在）。
 */
export const IMPORT_QUOTA_SAFETY_FACTOR = 1.25

/** 上限对应的 MB 数，用于提示文案里的 {size}（向下取整：宁可提示小一点，也不要报未达的余量）。 */
export const maxImportMegabytes = (bytes: number = DEFAULT_MAX_IMPORT_BYTES): number =>
  Math.floor(bytes / 1024 / 1024)

/** 解析调用方传入的上限：没传或不合法（非有限数 / <=0）一律退回默认值，不接受「无上限」。 */
export const resolveMaxImportBytes = (value?: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : DEFAULT_MAX_IMPORT_BYTES

/**
 * 字节 → 人话（与界面 formatBytes 同档：KB 之前不换算成小数）。
 * 超限提示要把「实测体积」说出来（#195），本地文件与直链两条链路必须用同一把尺子。
 * 空间预检的「需要 / 可用 / 还差」三个数也用同一把尺子（`{need}` / `{free}` / `{short}`）。
 */
export const formatImportBytes = (bytes: number): string => {
  if (bytes < 1024) {
    return `${bytes}B`
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)}KB`
  }
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}
