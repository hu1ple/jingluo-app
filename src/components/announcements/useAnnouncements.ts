import { useSyncExternalStore } from 'react'
import {
  ensureLoaded,
  listAnnouncements,
  subscribe,
} from '../../services/announcements/store.js'
import type { AnnouncementList } from '../../services/announcements/types.js'

/**
 * 订阅公告列表（含已读状态）。
 *
 * 写法与 `src/app/viewport.ts` 的 `useIsMobile` 同形：`useSyncExternalStore(subscribe, getSnapshot)`。
 * `listAnnouncements` 在两次写入之间返回**同一个对象**，所以不会出现
 * 「每次 render 都判成快照变了 → 无限重渲染」那类问题（`store.ts` 里已说明）。
 *
 * 加载时机**不在组件里**（不写 `useEffect`）：`ensureLoaded()` 是 store 的幂等总闸，
 * 第一次「读」或「订阅」时自己起一轮远程拉取 —— 冷启动读缓存同步、拉新异步替换。
 * 这样四个调用方（设置一级列表的红点、公告栏列表、首次弹窗、侧栏未读角标）**一行都不用改**，
 * 也不会各自发一遍请求。
 */
export const useAnnouncements = (): AnnouncementList => {
  ensureLoaded()
  return useSyncExternalStore(subscribe, listAnnouncements, listAnnouncements)
}
