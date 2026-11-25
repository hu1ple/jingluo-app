// 测试替身：diagnostics 依赖 DOM / IndexedDB，单测里只把写入口收进内存。
const store = () => globalThis.__log

export const record = (kind, level, message, fields = {}) => {
  store().records.push({ kind, level, message, fields })
}

export const recordEvent = (kind, message, fields = {}) => {
  store().events.push({ kind, message, fields })
}

export const recordAction = (kind, action, fields = {}) => {
  store().actions.push({ kind, action, fields })
}

export const errorMeta = (error) => ({
  'error.name': error instanceof Error ? error.name : typeof error,
  'error.msg': error instanceof Error ? error.message : String(error),
})

export const captureStateSnapshot = async () => ''

/**
 * P0「清后台后聊天记录不见了」：保存失败分类的上报入口。
 *
 * `chat/store.ts` 在落盘失败时调它（真实现见 `src/services/diagnostics/collector.ts`）。
 * 这里必须给同名导出 —— 否则任何 `export * from 'chat-stubs/collector.mjs'` 的替身
 * 都会让 `import { reportStorageSaveFailure } from '.../collector.js'` 在**模块求值**阶段炸掉，
 * 而不是在用例里报一条可读的断言失败。
 */
export const reportStorageSaveFailure = (report = {}, error) => {
  store().records.push({
    kind: 'error',
    level: 'error',
    message: `storage.saveFailure: ${report.kind} @ ${report.step}`,
    fields: { ...report, ...(error === undefined ? {} : errorMeta(error)) },
  })
}

export const flushLogs = async () => {}
