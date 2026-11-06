/**
 * ima-knowledge · 会话级知识库选择存储（PLATFORM.md §9.3）
 *
 * 为什么单开一个模块：选中集原本存在 credential store 的
 * `IMA_KNOWLEDGE_BASE_IDS`（账号级凭据位），所有会话共享一份。§9.3 要求
 * 「键 = SessionId，值 = `{ids: string[]}`」的**会话域**存储 —— 凭据位语义上
 * 不是会话数据，继续共用会让「会话隔离」名不副实。
 *
 * 三条实现路径（按优先级探测，探测不到就显式降级，不静默假装成功）：
 *  1. `storage` —— DSH 的存储枢纽（`ctx.get('storage')`）。走
 *     `storage.backend.get('json').kv.open({name,version,tables,hasGlobal})`
 *     （`@deepseek-ai/dsh-storage` 的 KvFacet，源码
 *     `packages/storage/storage/src/backend.ts`）。
 *     **刻意不走 `storage.domain`**：domain 形态要求 zod 记录 schema
 *     （`defineDomain` / `domainTable`），本插件零依赖、不静态 import 任何宿主包，
 *     引入 zod 会把「可选能力探测」变成硬依赖。KV 层已足够表达
 *     「键 = SessionId，值 = {ids}」。
 *  2. `file` —— `%DSH_HOME%/ima-knowledge/session-selections.json`
 *     （`DSH_HOME` 环境变量优先，否则 `~/.dsh`）。原子写（tmp + rename）。
 *  3. `memory` —— 进程内 Map，最后兜底（测试与极端环境）。
 *
 * **`undefined` 与 `[]` 必须严格区分**（§9.3 末段）：
 *  - `getSelected()` 返回 `undefined` = 该会话**无记录** → 继承全局默认值；
 *  - 返回 `[]` = 该会话**明确不查库** → 工具必须拒绝查询，不许回退默认值。
 * 落到介质上就是「键不存在」vs「键存在但 ids 为空数组」。
 *
 * @module ima-knowledge/session-store
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** KV 单元名（必须匹配 `UNIT_NAME_RE`：`^[a-z][a-z0-9_]*$`）。 */
export const SESSION_STORE_UNIT = 'ima_knowledge_sessions'
/** KV 表名：一行一个会话。 */
export const SESSION_STORE_TABLE = 'sessions'
/** 单元格式版本。 */
export const SESSION_STORE_VERSION = 1
/** 文件降级方案的默认文件名。 */
export const SESSION_STORE_FILE_NAME = 'session-selections.json'
/** 存储枢纽里默认的 backend 名（bundle base 用 `json`，见 cordis.patch.yml）。 */
export const SESSION_STORE_BACKEND = 'json'

/**
 * 归一化一份选中集：只留非空字符串、去空白、去重、保序。
 * @param {unknown} value - 任意候选值。
 * @returns {string[]|undefined} 数组输入 → 归一化数组；非数组 → undefined。
 */
export function normalizeSelectedIds(value) {
  if (!Array.isArray(value)) return undefined
  const ids = []
  const seen = new Set()
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const id = entry.trim()
    if (id.length === 0 || seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  return ids
}

/**
 * 把一条存储记录解成选中集。
 *
 * 记录形状契约是 `{ids: string[]}`。**只有 `ids` 是数组时才认为记录存在**
 * （返回数组，空数组也照返）；形状坏掉（缺 `ids` / `ids` 不是数组）当作
 * 「无记录」，由调用方回退全局默认值 —— 绝不把损坏的记录读成「明确不选」，
 * 那会让用户莫名失去知识库。
 * @param {unknown} record - 介质里的原始记录。
 * @returns {string[]|undefined} 选中集，或 undefined（无记录/记录损坏）。
 */
export function decodeSessionRecord(record) {
  if (record === null || typeof record !== 'object') return undefined
  return normalizeSelectedIds(record.ids)
}

/**
 * 把选中集编成存储记录（§9.3：`{ids: string[]}`）。
 * @param {string[]} ids - 归一化后的 id 列表（`[]` 合法）。
 * @returns {{ids: string[]}} 记录。
 */
export function encodeSessionRecord(ids) {
  return { ids: normalizeSelectedIds(ids) ?? [] }
}

/**
 * 解析 DSH home（`DSH_HOME` 优先，否则 `~/.dsh`）。
 * @param {NodeJS.ProcessEnv} [env] - 环境变量表。
 * @returns {string} home 绝对路径。
 */
export function resolveDshHome(env = process.env) {
  const configured = typeof env?.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  return configured.length > 0 ? configured : join(homedir(), '.dsh')
}

/**
 * 文件降级方案的默认落盘路径。
 * @param {string} [home] - DSH home；省略时按 {@link resolveDshHome} 解析。
 * @returns {string} JSON 文件绝对路径。
 */
export function defaultSessionStorePath(home) {
  return join(home ?? resolveDshHome(), 'ima-knowledge', SESSION_STORE_FILE_NAME)
}

/**
 * 纯内存存储（测试 / 极端兜底）。语义与另外两个实现完全一致。
 * @param {Record<string, string[]>} [initial] - 预置记录（`[]` 表示明确不选）。
 * @returns {object} 会话存储。
 */
export function createMemorySessionStore(initial) {
  /** @type {Map<string, string[]>} */
  const records = new Map()
  for (const [sessionId, ids] of Object.entries(initial ?? {})) {
    const normalized = normalizeSelectedIds(ids)
    if (normalized !== undefined) records.set(sessionId, normalized)
  }
  return {
    scope: 'memory',
    async ready() {},
    /**
     * @param {string} sessionId - 会话 id。
     * @returns {Promise<string[]|undefined>} 选中集；无记录 = undefined。
     */
    async getSelected(sessionId) {
      const record = records.get(sessionId)
      // 必须复制：`undefined` 与 `[]` 的区别是语义核心，不能被调用方改穿。
      return record === undefined ? undefined : [...record]
    },
    /**
     * @param {string} sessionId - 会话 id。
     * @param {string[]} ids - 选中集；`[]` = 明确不选。
     * @returns {Promise<string[]>} 落库后的归一化选中集。
     */
    async setSelected(sessionId, ids) {
      const normalized = normalizeSelectedIds(ids) ?? []
      records.set(sessionId, normalized)
      return [...normalized]
    },
    /** @returns {Promise<string[]>} 已知会话 id（诊断用）。 */
    async listSessions() {
      return [...records.keys()]
    },
    async close() {},
    /** @returns {{scope: string}} 诊断信息。 */
    describe() {
      return { scope: 'memory', sessions: records.size }
    },
  }
}

/**
 * 文件存储（降级方案）：整份 JSON 读进内存，写时原子落盘。
 * @param {object} [options] - 选项。
 * @param {string} [options.file] - 目标文件；省略时用 {@link defaultSessionStorePath}。
 * @param {string} [options.home] - DSH home（拼默认路径用）。
 * @param {object} [options.fs] - 注入的 fs 实现（测试用，需含 readFile/writeFile/rename/mkdir）。
 * @returns {object} 会话存储。
 */
export function createFileSessionStore(options = {}) {
  const file = options.file ?? defaultSessionStorePath(options.home)
  const fsImpl = { readFile, writeFile, rename, mkdir, ...options.fs }
  /** @type {Map<string, string[]>|undefined} */
  let cache
  /** @type {Promise<Map<string, string[]>>|undefined} */
  let loading
  /** 写链：同一时刻只落一份快照，避免交错写坏文件。 */
  let chain = Promise.resolve()

  async function readAll() {
    let raw
    try {
      raw = await fsImpl.readFile(file, 'utf8')
    } catch (error) {
      // 文件不存在是正常初始态（首次使用）；其它错误必须显式抛，不能吞。
      if (error?.code === 'ENOENT') return new Map()
      throw new Error(`ima-knowledge: 读取会话级选择文件 ${file} 失败：${error instanceof Error ? error.message : String(error)}`)
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      throw new Error(`ima-knowledge: 会话级选择文件 ${file} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`)
    }
    const sessions = parsed !== null && typeof parsed === 'object' && typeof parsed.sessions === 'object' && parsed.sessions !== null
      ? parsed.sessions
      : {}
    const map = new Map()
    for (const [sessionId, value] of Object.entries(sessions)) {
      const normalized = normalizeSelectedIds(value)
      if (normalized !== undefined) map.set(sessionId, normalized)
    }
    return map
  }

  async function ensure() {
    if (cache !== undefined) return cache
    loading ??= readAll().then((map) => {
      cache = map
      return map
    })
    return loading
  }

  async function flush(map) {
    await fsImpl.mkdir(dirname(file), { recursive: true })
    const payload = JSON.stringify({
      version: SESSION_STORE_VERSION,
      sessions: Object.fromEntries(map),
    }, null, 2)
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
    await fsImpl.writeFile(tmp, payload, 'utf8')
    await fsImpl.rename(tmp, file)
  }

  return {
    scope: 'file',
    async ready() {
      await ensure()
    },
    async getSelected(sessionId) {
      const map = await ensure()
      const record = map.get(sessionId)
      return record === undefined ? undefined : [...record]
    },
    async setSelected(sessionId, ids) {
      const map = await ensure()
      const normalized = normalizeSelectedIds(ids) ?? []
      map.set(sessionId, normalized)
      // 排队落盘：前一次写完才写下一次，落盘失败会沿链抛给调用方。
      chain = chain.then(() => flush(map), () => flush(map))
      await chain
      return [...normalized]
    },
    async listSessions() {
      return [...(await ensure()).keys()]
    },
    async close() {
      await chain.catch(() => undefined)
    },
    describe() {
      return { scope: 'file', file }
    },
  }
}

/**
 * 存储枢纽（`ctx.storage`）实现：一个 KV 单元、一张表、一行一个会话。
 * @param {object} storage - `ctx.storage`（Storage 服务实例）。
 * @param {object} [options] - 选项。
 * @param {string} [options.backend] - backend 名，默认 `json`。
 * @returns {object} 会话存储。
 */
export function createStorageSessionStore(storage, options = {}) {
  const backendName = options.backend ?? SESSION_STORE_BACKEND
  /** @type {Map<string, string[]>|undefined} */
  let cache
  /** @type {Promise<{unit: object, table: string}>|undefined} */
  let opening

  async function openUnit() {
    if (storage === null || typeof storage !== 'object') {
      throw new Error('ima-knowledge: ctx.storage 不可用')
    }
    const backend = storage.backend?.get?.(backendName)
    if (backend === undefined || backend === null) {
      throw new Error(`ima-knowledge: 存储 backend '${backendName}' 未注册`)
    }
    if (backend.kv === undefined || typeof backend.kv.open !== 'function') {
      throw new Error(`ima-knowledge: 存储 backend '${backendName}' 没有 kv facet`)
    }
    const unit = await backend.kv.open({
      name: SESSION_STORE_UNIT,
      version: SESSION_STORE_VERSION,
      tables: [SESSION_STORE_TABLE],
      hasGlobal: false,
    })
    return { unit, table: SESSION_STORE_TABLE }
  }

  async function ensure() {
    if (cache !== undefined) return { cache, handle: await opening }
    opening ??= openUnit()
    const handle = await opening
    if (cache === undefined) {
      const snapshot = await handle.unit.loadAll()
      const map = new Map()
      const rows = snapshot?.tables?.[handle.table] ?? {}
      for (const [sessionId, record] of Object.entries(rows)) {
        const decoded = decodeSessionRecord(record)
        if (decoded !== undefined) map.set(sessionId, decoded)
      }
      cache = map
    }
    return { cache, handle }
  }

  return {
    scope: 'storage',
    async ready() {
      await ensure()
    },
    async getSelected(sessionId) {
      const { cache: map } = await ensure()
      const record = map.get(sessionId)
      return record === undefined ? undefined : [...record]
    },
    async setSelected(sessionId, ids) {
      const { cache: map, handle } = await ensure()
      const normalized = normalizeSelectedIds(ids) ?? []
      // 先落盘再改内存：写失败时内存不前进，读到的仍是介质上的事实。
      await handle.unit.putRecord(handle.table, sessionId, encodeSessionRecord(normalized))
      map.set(sessionId, normalized)
      return [...normalized]
    },
    async listSessions() {
      const { cache: map } = await ensure()
      return [...map.keys()]
    },
    async close() {
      if (opening === undefined) return
      try {
        const handle = await opening
        await handle.unit.close()
      } catch {
        // 打开失败/已关闭：没有需要释放的单元。
      }
    },
    describe() {
      return { scope: 'storage', unit: SESSION_STORE_UNIT, table: SESSION_STORE_TABLE, backend: backendName }
    },
  }
}

/**
 * 建会话存储：按 `storage → file → memory` 探测，实际落在哪个介质由
 * {@link describe} 如实报告（**不静默假装成功**）。
 *
 * @param {object} [options] - 选项。
 * @param {object} [options.storage] - `ctx.get('storage')` 的结果；缺失即跳过该档。
 * @param {string} [options.backend] - storage backend 名。
 * @param {string} [options.file] - 文件档路径；`false` 表示禁用文件档。
 * @param {string} [options.home] - DSH home。
 * @param {object} [options.fs] - 注入的 fs（文件档用）。
 * @returns {object} 会话存储（`getSelected` / `setSelected` / `describe` / `close`）。
 */
export function createSessionStore(options = {}) {
  const attempts = []
  if (options.storage !== undefined && options.storage !== null) {
    attempts.push(() => createStorageSessionStore(options.storage, options))
  }
  if (options.file !== false) {
    attempts.push(() => createFileSessionStore(options))
  }
  attempts.push(() => createMemorySessionStore())

  /** @type {{store?: object, scope: string, attempts: Array<{scope: string, error?: string}>}} */
  const state = { scope: 'pending', attempts: [] }
  /** @type {Promise<object>|undefined} */
  let active

  async function activate() {
    for (const make of attempts) {
      let candidate
      try {
        candidate = make()
        if (typeof candidate.ready === 'function') await candidate.ready()
        state.store = candidate
        state.scope = candidate.scope
        state.attempts.push({ scope: candidate.scope })
        return candidate
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        state.attempts.push({ scope: candidate?.scope ?? 'unknown', error: reason })
        if (candidate !== undefined && typeof candidate.close === 'function') {
          try { await candidate.close() } catch { /* 已经失败，忽略清理错误 */ }
        }
      }
    }
    // 最后一档是内存，理论上不可达；真到了就是实现 bug，显式抛。
    throw new Error('ima-knowledge: 没有任何可用的会话级存储后端')
  }

  function ensureActive() {
    active ??= activate()
    return active
  }

  return {
    /** @returns {string} 当前实际生效的介质（`storage` | `file` | `memory` | `pending`）。 */
    get scope() {
      return state.scope
    },
    async ready() {
      await ensureActive()
      return state.scope
    },
    async getSelected(sessionId) {
      const store = await ensureActive()
      return store.getSelected(sessionId)
    },
    async setSelected(sessionId, ids) {
      const store = await ensureActive()
      return store.setSelected(sessionId, ids)
    },
    async listSessions() {
      const store = await ensureActive()
      return typeof store.listSessions === 'function' ? store.listSessions() : []
    },
    async close() {
      if (active === undefined) return
      const store = await active.catch(() => undefined)
      if (store !== undefined && typeof store.close === 'function') await store.close()
    },
    /** @returns {{scope: string, attempts: Array<{scope: string, error?: string}>}} 诊断信息。 */
    describe() {
      return { scope: state.scope, attempts: [...state.attempts] }
    },
  }
}
