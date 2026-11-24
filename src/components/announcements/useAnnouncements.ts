import { useSyncExternalStore } from 'react'
import { listAnnouncements, subscribe } from '../../services/announcements/store.js'
import type { AnnouncementList } from '../../services/announcements/types.js'

/**
 * 订阅公告列表（含已读状态）。
 *
 * 写法与 `src/app/viewport.ts` 的 `useIsMobile` 同形：`useSyncExternalStore(subscribe, getSnapshot)`。
 * `listAnnouncements` 在两次写入之间返回**同一个对象**，所以不会出现
 * 「每次 render 都判成快照变了 → 无限重渲染」那类问题（`store.ts` 里已说明）。
 */
export const useAnnouncements = (): AnnouncementList =>
  useSyncExternalStore(subscribe, listAnnouncements, listAnnouncements)
