import { create } from 'zustand'
import {
  clearChatBackground,
  clearSessionBackground,
  readChatBackground,
  readSessionBackground,
  saveSessionBackgroundAsset,
  writeChatBackground,
} from './appAssets.js'
import { reportStorageError } from './db.js'

type ChatBackgroundState = {
  /** 当前背景图的 object URL；null 表示未设置 */
  url: string | null
  /** 首次读取是否完成，用于区分「还没读」与「确实没有」 */
  ready: boolean
}

/** 聊天背景的全局状态：只有聊天主区域订阅，设置页读取缩略图。 */
export const useChatBackground = create<ChatBackgroundState>(() => ({ url: null, ready: false }))

let objectUrl: string | null = null

const publish = (blob: Blob | null) => {
  if (objectUrl) {
    URL.revokeObjectURL(objectUrl)
    objectUrl = null
  }
  if (blob) {
    objectUrl = URL.createObjectURL(blob)
  }
  useChatBackground.setState({ url: objectUrl, ready: true })
}

/** 启动时读一次：IndexedDB 里的图在刷新、重开应用后仍然生效。 */
export const initChatBackground = async (): Promise<void> => {
  try {
    publish(await readChatBackground())
  } catch (error) {
    reportStorageError('load chat background')(error)
    useChatBackground.setState({ ready: true })
  }
}

/** 选图后立即压缩入库并生效。 */
export const applyChatBackground = async (file: File): Promise<void> => {
  publish(await writeChatBackground(file))
}

/** 清除背景：先删库再撤掉界面上的图。 */
export const removeChatBackground = async (): Promise<void> => {
  await clearChatBackground()
  publish(null)
}

/**
 * 每会话自定义背景图的运行时状态（本单）。
 *
 * **为什么要有 object URL 这一层**：图片本体是 IndexedDB 里的 Blob，不能直接塞进
 * `background-image`；每次 create 出来一个 `blob:` URL 就必须有人负责 revoke，
 * 否则切十次会话就漏十份原图（一张 1600px JPEG 约 200~500 KB，切几轮就是几十 MB）。
 * 所以这里只有**一个** `objectUrl` 槽位：换会话、换图、清空都会先把旧的 revoke 掉。
 *
 * `sessionId` 与 `url` 一起发布：调用方（App.tsx）只在 `sessionId === 当前会话` 时才用 `url`，
 * 于是「A 会话的图闪到 B 会话上」在状态层面就不可能 —— 异步读图返回时会话早切走了。
 */
type SessionBackgroundState = {
  /** url 属于哪条会话；null = 没有会话（欢迎页 / 已清空） */
  sessionId: string | null
  /** 该会话自定义图的 object URL；null = 没有设置或还没读回来 */
  url: string | null
}

export const useSessionBackground = create<SessionBackgroundState>(() => ({ sessionId: null, url: null }))

let sessionObjectUrl: string | null = null

const publishSession = (sessionId: string | null, blob: Blob | null) => {
  if (sessionObjectUrl) {
    URL.revokeObjectURL(sessionObjectUrl)
    sessionObjectUrl = null
  }
  if (blob && sessionId !== null) {
    sessionObjectUrl = URL.createObjectURL(blob)
  }
  useSessionBackground.setState({ sessionId: blob && sessionId !== null ? sessionId : null, url: sessionObjectUrl })
}

/**
 * 读到某条会话的自定义图（切会话时调）。同一会话重复调用不会重复建 URL：
 * App 在同一会话里多次渲染 / 重连都会打到这里，每次都 create 一遍就是每帧漏一份。
 */
export const loadSessionBackground = async (sessionId: string | null): Promise<void> => {
  if (sessionId === null) {
    publishSession(null, null)
    return
  }
  const state = useSessionBackground.getState()
  if (state.sessionId === sessionId) {
    return
  }
  try {
    publishSession(sessionId, await readSessionBackground(sessionId))
  } catch (error) {
    reportStorageError('load session background')(error)
    publishSession(sessionId, null)
  }
}

/**
 * 保存会话自定义图（已经压缩好的 blob）并立即生效。
 *
 * URL 由这里统一 create / revoke，调用方（背景设置页）**不要**自己 create 一个长期 URL ——
 * 页面里的那个只用于草稿预览，页面卸载时必须 revoke（见 `ChatBackgroundPage.tsx`）。
 */
export const applySessionBackgroundBlob = async (sessionId: string, blob: Blob): Promise<void> => {
  await saveSessionBackgroundAsset(sessionId, blob)
  publishSession(sessionId, blob)
}

/** 清掉会话的自定义图（「恢复默认」）：先删库再撤掉界面上的 URL。 */
export const removeSessionBackground = async (sessionId: string): Promise<void> => {
  await clearSessionBackground(sessionId)
  const state = useSessionBackground.getState()
  if (state.sessionId === sessionId) {
    publishSession(sessionId, null)
  }
}
