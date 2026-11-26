/**
 * 外部应用文件导入的**接线层**（React 侧）。
 *
 * 三件事，各归各位：
 *
 * 1. `useExternalImportBridge()` —— 在 `App` 里挂一次：订阅原生桥，把拒绝项逐条提示，
 *    把成功项送进「新建对话」。**不发送、不上传**（需求第 7 条）。
 * 2. `useExternalImportInbox()` —— 在输入区里挂：只在 `sessionId === null`（新对话）时注册
 *    接货口，把文件交给既有的 `useAttachmentDrafts().addFiles()`。
 * 3. `externalImportRejectMessage()` —— 拒绝码 → **既有文案 key** 的映射（一条都不新造，见下）。
 *
 * 为什么「先 newChat() 再入队」而不是直接往当前会话里塞：需求第 5/6 条要求导入后进**新建对话页**，
 * 用户当前若在别的会话，直接 `addFiles` 会污染那条会话的草稿（附件跟着会话走）。所以：
 * `newChat()` → 输入区以 `sessionId=null` 重挂载 → `takeExternalImport()` 取货 → `addFiles()`。
 * 入队/取货在 `services/externalImport.ts` 里，两侧不会互相等（谁后到都能对上）。
 */
import { useEffect } from 'react'
import type { LinkedMessage } from '../../i18n/index.js'
import { formatSize } from '../../services/attachments.js'
import { newChat } from '../../services/chat/store.js'
import {
  enqueueExternalImport,
  subscribeExternalImport,
  takeExternalImport,
  type ExternalImportRejected,
} from '../../services/externalImport.js'
import { showToast } from '../base/toastState.js'

/**
 * 拒绝码 → 提示文案。**全部是既有 key**：
 *
 * | 码 | key | 为什么是它 |
 * | --- | --- | --- |
 * | `unsupported` | `attachPickUnsupported` | 与「选文件时选了不支持的格式」同一句话，用户不需要学第二套说法 |
 * | `empty` | `attachPickEmpty` | 同上 |
 * | `tooLarge` | `attachPickTooLarge` | 同上，带 `size` / `limit` |
 * | `noPermission` | `attachAddReadFailed` | 原文就是「无法读取…请重新选择；网盘文件先下载到本机」—— 正是内容提供器不给读权限时的正确指引 |
 * | `readFailed` | `attachAddReadFailed` | 同上 |
 *
 * 一条新文案都不加：外部导入和「从输入区选文件」对用户是同一件事，拒绝理由也该用同一套说法。
 */
export const externalImportRejectMessage = (item: ExternalImportRejected): LinkedMessage => {
  if (item.reason === 'unsupported') {
    return { key: 'attachPickUnsupported', params: { name: item.name } }
  }
  if (item.reason === 'empty') {
    return { key: 'attachPickEmpty', params: { name: item.name } }
  }
  if (item.reason === 'tooLarge') {
    const size = item.size ?? 0
    return {
      key: 'attachPickTooLarge',
      params: { name: item.name, size: formatSize(size), limit: formatSize(item.limitBytes ?? size) },
    }
  }
  return { key: 'attachAddReadFailed', params: { name: item.name } }
}

/**
 * App 级：订阅「外部应用分享进来」。
 *
 * Web 端 / iOS 端：`subscribeExternalImport()` 在 `getPlatform() !== 'android'` 时直接返回空退订
 * 函数，这里什么都不做 —— **不渲染入口、不弹提示、不打日志**，行为与没有这个功能时完全一致。
 */
export const useExternalImportBridge = (): void => {
  useEffect(() => {
    let stop: (() => void) | undefined
    let cancelled = false
    void subscribeExternalImport((batch) => {
      for (const item of batch.rejected) {
        showToast(externalImportRejectMessage(item))
      }
      if (batch.files.length === 0) {
        return
      }
      // 需求第 5/6 条：一律进「新建对话」，不污染当前会话；草稿里展示，**不自动发送**
      newChat()
      enqueueExternalImport(batch.files)
    }).then((unsubscribe) => {
      // 订阅是异步的（先 consumePending 再挂监听），期间组件可能已经卸载
      if (cancelled) {
        unsubscribe()
        return
      }
      stop = unsubscribe
    })
    return () => {
      cancelled = true
      stop?.()
    }
  }, [])
}

/**
 * 输入区级：只有「新建对话」那一版接货。
 *
 * `sessionId !== null` 时**不注册**：用户在别的会话里时，文件必须等新对话框挂上来才落地，
 * 否则会把附件塞进当前会话的草稿（需求第 5 条明确要求「新建而不是污染当前会话」）。
 */
export const useExternalImportInbox = (
  sessionId: string | null,
  addFiles: (files: File[]) => void
): void => {
  useEffect(() => {
    if (sessionId !== null) {
      return
    }
    return takeExternalImport(addFiles)
  }, [sessionId, addFiles])
}
