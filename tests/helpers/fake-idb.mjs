// L0（单元层）里「被测物就是 IndexedDB 存储语义」那一族用例的公共装配。
//
// 为什么要有它（Issue #399 / #831 收尾）：`memory-session-scope-399` 与 `session-branch-831` 原来
// 各自抄了一份同样的三段 —— 「fake-indexeddb 全局幂等重装」「最小 localStorage」「整库快照」，共 28 行
// 逐字相同（`check:test-duplication` 的 R1，两处注释还互相写着「与 XXX 同做法」，等于承认是副本）。
// 这三段都是**纯装配**，不含任何断言：断言留在各文件里（一处守会话隔离与容量淘汰，一处守分支复制语义）。
//
// 三段各自的理由：
//
//   1. `installFakeIdbGlobals()` —— `fake-indexeddb/auto` 的副作用只在模块首次求值时装一次；run-layer
//      合并批次跑完一个文件会把该文件新增的全局抹掉（#513）。所以每个文件自己幂等装一遍：
//      只补 `undefined` 的那些名字，不覆盖别人已经装好的实现。
//   2. `installMinimalLocalStorage()` —— `settings.ts` / `apiConfig.ts` 只做 get / set / remove / clear。
//   3. `snapshotDatabase(name)` —— **不经被测模块**直接读整库：`{ version, stores, data, indexes }`，
//      记录里的 `Blob` 折成 `{ __blob, type, size }` 才能深比较。迁移用例靠它钉「一条不丢」。
//      库名由调用方给（各文件用各自隔离的 `chat-demo-migration-probe-*`），本函数不猜。
//
// 用法：
//
//   import 'fake-indexeddb/auto'
//   import { installFakeIdbGlobals, installMinimalLocalStorage, snapshotDatabase } from '../helpers/fake-idb.mjs'
//
//   installFakeIdbGlobals()
//   installMinimalLocalStorage()
//   const before = await snapshotDatabase(PROBE_DB)
//
// 注意顺序：`installFakeIdbGlobals()` 要在任何 `src/**` 的动态 import 之前调（被测的 `chat/db.ts`
// 在模块求值时就会摸 `indexedDB`）。
import * as fakeIdb from 'fake-indexeddb'
import { openDB } from 'idb'

/**
 * `fake-indexeddb/auto` 会挂到 `globalThis` 上的名字（12 个）。
 * 只列「被测代码真的会用」的这一套，与原来两份文件里的清单逐字相同。
 */
const IDB_GLOBALS = [
  'indexedDB',
  'IDBCursor',
  'IDBCursorWithValue',
  'IDBDatabase',
  'IDBFactory',
  'IDBIndex',
  'IDBKeyRange',
  'IDBObjectStore',
  'IDBOpenDBRequest',
  'IDBRequest',
  'IDBTransaction',
  'IDBVersionChangeEvent',
]

/**
 * 幂等装一遍 fake-indexeddb 的全局：**只补 `undefined` 的**，不覆盖同批别的文件已装好的实现
 * （覆盖会让「谁把 `indexedDB` 换掉了」这种串扰更难查，也违反 #513 的复位口径）。
 *
 * @param {{ fake?: object }} options 仅测试替身注入用；默认就是 `fake-indexeddb` 本身。
 * @returns {string[]} 这次真的装上去的名字（空数组 = 原来就都在）
 */
export const installFakeIdbGlobals = ({ fake = fakeIdb } = {}) => {
  const installed = []
  for (const name of IDB_GLOBALS) {
    if (globalThis[name] === undefined && fake[name] !== undefined) {
      globalThis[name] = fake[name]
      installed.push(name)
    }
  }
  return installed
}

/** 最小 localStorage：`settings.ts` / `apiConfig.ts` 只做 get / set / remove（外加 clear） */
export const installMinimalLocalStorage = () => {
  const storage = new Map()
  globalThis.localStorage = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
    clear: () => storage.clear(),
  }
}

/**
 * 整库快照（store → 记录）：用来深比较「迁移前 / 迁移后」。
 *
 * `data[store]` 是按主键序的 `getAll()` 结果，每行做浅拷贝后再把 `Blob` 折成
 * `{ __blob: true, type, size }` —— 直接 `deepEqual` 两个 `Blob` 比的是对象身份，永远不相等。
 * `indexes[store]` 是排过序的索引名，`stores` 是排过序的 store 名。
 *
 * @param {string} dbName 库名（各用例用自己隔离的探测库，不碰应用的 `chat-demo`）
 * @returns {Promise<{ version: number, stores: string[], data: Record<string, object[]>, indexes: Record<string, string[]> }>}
 */
export const snapshotDatabase = async (dbName) => {
  const handle = await openDB(dbName)
  try {
    const stores = [...handle.objectStoreNames].sort()
    const data = {}
    const indexes = {}
    for (const store of stores) {
      const tx = handle.transaction(store, 'readonly')
      indexes[store] = [...tx.store.indexNames].sort()
      const rows = await tx.store.getAll()
      data[store] = rows.map((row) => {
        const copy = { ...row }
        for (const [key, value] of Object.entries(copy)) {
          if (value instanceof Blob) {
            copy[key] = { __blob: true, type: value.type, size: value.size }
          }
        }
        return copy
      })
    }
    return { version: handle.version, stores, data, indexes }
  } finally {
    handle.close()
  }
}
