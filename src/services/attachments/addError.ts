import type { Stage } from '../diagnostics/fields.js'

export type AttachmentAddStage = Extract<Stage, `attachment.${string}`>

/** 本地文档添加失败，保留步骤与宿主异常，便于界面给出对应的提示。 */
export class AttachmentAddError extends Error {
  readonly stage: AttachmentAddStage
  readonly causeName: string
  override readonly cause: unknown

  constructor(stage: AttachmentAddStage, cause: unknown) {
    super(`Document attachment failed at ${stage}`)
    this.name = 'AttachmentAddError'
    this.stage = stage
    this.cause = cause
    const name = (cause as { name?: unknown } | null)?.name
    this.causeName = typeof name === 'string' && name !== '' ? name : 'UnknownError'
  }
}
