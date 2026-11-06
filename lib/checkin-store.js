/**
 * ima-knowledge · 自动签到持久化存储（docs/CHECKIN.md §3.1）
 *
 * 落盘路径：`<DSH_HOME>/ima-knowledge/checkin.json`（`DSH_HOME` 优先，否则 `~/.dsh`），
 * 与 `lib/session-store.js` 的 `resolveDshHome` **同源逻辑**。这里刻意复制那 10 行解析
 * 逻辑而不是 import session-store 的内部函数 —— 不改动 session-store 的对外行为。
 *
 * 三条硬约束：
 *  1. **原子写**：先写同目录 tmp 文件再 `rename`，避免半截文件；
 *  2. **永不抛**：文件缺失 / 损坏 / 字段非法一律回落默认值（损坏时顺手写一次修复），
 *     签到是非关键功能，不能因为它读不到文件就让插件加载失败；
 *  3. **版本化**：`{version:1, config, lastRun, history}`，向后兼容（未知字段忽略）。
 *
 * @module ima-knowledge/checkin-store
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 存储文件名。 */
export const CHECKIN_STORE_FILE_NAME = 'checkin.json'

/** 存储格式版本。 */
export const CHECKIN_STORE_VERSION = 1

/** `history` 只保留最近 30 条（新在前）。 */
export const CHECKIN_HISTORY_LIMIT = 30

/** `config.time` 的合法形状（CHECKIN.md §3.1 逐字）。 */
export const CHECKIN_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/

/** 默认签到时间。 */
export const DEFAULT_CHECKIN_TIME = '09:00'

/** 默认配置（用户要的就是自动化，默认开启；面板可关）。 */
export const DEFAULT_CHECKIN_CONFIG = Object.freeze({ enabled: true, time: DEFAULT_CHECKIN_TIME })

/** 本地日期字符串的形状（`YYYY-MM-DD`）。 */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * 解析 DSH home（`DSH_HOME` 优先，否则 `~/.dsh`）。
 *
 * 与 `lib/session-store.js` 的 `resolveDshHome` 逐字一致；复制而非 import 是为了
 * 不把签到功能绑到 session-store 的对外契约上。
 *
 * @param {NodeJS.ProcessEnv} [env] - 环境变量表。
 * @returns {string} home 绝对路径。
 */
export function resolveDshHome(env = process.env) {
  const configured = typeof env?.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  return configured.length > 0 ? configured : join(homedir(), '.dsh')
}

/**
 * 默认落盘路径。
 * @param {string} [home] - DSH home；省略时按 {@link resolveDshHome} 解析。
 * @returns {string} JSON 文件绝对路径。
 */
export function defaultCheckinStorePath(home) {
  return join(home ?? resolveDshHome(), 'ima-knowledge', CHECKIN_STORE_FILE_NAME)
}

/**
 * 是否合法的 `HH:mm`。
 * @param {unknown} value - 候选值。
 * @returns {boolean} 合法返回 true。
 */
export function isValidCheckinTime(value) {
  return typeof value === 'string' && CHECKIN_TIME_RE.test(value)
}

/**
 * 归一化签到时间：非法一律回落默认值（读侧容错）。
 * @param {unknown} value - 候选值。
 * @returns {string} 合法的 `HH:mm`。
 */
export function normalizeCheckinTime(value) {
  return isValidCheckinTime(value) ? value : DEFAULT_CHECKIN_TIME
}

/**
 * epoch 毫秒 → **本地**日期字符串（`YYYY-MM-DD`）。
 *
 * 必须用本地时区：签到按用户本地时间每天一次，用 UTC 会在东八区凌晨错位。
 * @param {number} ms - epoch 毫秒。
 * @returns {string} 本地日期。
 */
export function formatLocalDate(ms) {
  const date = new Date(ms)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * 默认状态（深拷贝，调用方可安全修改）。
 * @returns {{version: number, config: {enabled: boolean, time: string}, lastRun: null, history: []}}
 *   默认状态。
 */
export function defaultCheckinState() {
  return {
    version: CHECKIN_STORE_VERSION,
    config: { ...DEFAULT_CHECKIN_CONFIG },
    lastRun: null,
    history: [],
  }
}

/**
 * 归一化一条运行记录；形状坏掉返回 undefined（由调用方丢弃）。
 * @param {unknown} raw - 候选记录。
 * @returns {{date: string, at: number, ok: boolean, reward: number, total: number,
 *   alreadyChecked: boolean, error: string|null} | undefined} 归一化记录。
 */
export function normalizeRunRecord(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const at = typeof raw.at === 'number' && Number.isFinite(raw.at) && raw.at > 0
    ? raw.at
    : undefined
  const date = typeof raw.date === 'string' && DATE_RE.test(raw.date)
    ? raw.date
    : (at === undefined ? undefined : formatLocalDate(at))
  if (at === undefined || date === undefined) return undefined
  const reward = typeof raw.reward === 'number' && Number.isFinite(raw.reward) ? raw.reward : 0
  const total = typeof raw.total === 'number' && Number.isFinite(raw.total) ? raw.total : 0
  return {
    date,
    at,
    ok: raw.ok === true,
    reward,
    total,
    alreadyChecked: raw.alreadyChecked === true,
    error: typeof raw.error === 'string' && raw.error.length > 0 ? raw.error : null,
  }
}

/**
 * 归一化整份状态（**永不抛**）：逐字段回落默认值，history 去坏、按时间倒序、截 30 条。
 * @param {unknown} raw - 文件里的原始 JSON。
 * @returns {{version: number, config: {enabled: boolean, time: string}, lastRun: object|null,
 *   history: object[]}} 归一化状态。
 */
export function normalizeCheckinState(raw) {
  const state = defaultCheckinState()
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return state
  const config = raw.config !== null && typeof raw.config === 'object' && !Array.isArray(raw.config)
    ? raw.config
    : {}
  state.config = {
    enabled: typeof config.enabled === 'boolean' ? config.enabled : DEFAULT_CHECKIN_CONFIG.enabled,
    time: normalizeCheckinTime(config.time),
  }
  state.lastRun = normalizeRunRecord(raw.lastRun) ?? null
  if (Array.isArray(raw.history)) {
    state.history = raw.history
      .map((entry) => normalizeRunRecord(entry))
      .filter((entry) => entry !== undefined)
      .sort((left, right) => right.at - left.at)
      .slice(0, CHECKIN_HISTORY_LIMIT)
  }
  return state
}

/**
 * 深拷贝一份状态（避免调用方改穿缓存）。
 * @param {unknown} value - 任意可结构化克隆的值。
 * @returns {any} 副本。
 */
function clone(value) {
  if (value === null || value === undefined) return value
  return structuredClone(value)
}

/**
 * 建签到存储。
 *
 * 注入面（全部可选，便于单测）：
 *  - `file`：落盘路径；传 `false` = 纯内存（测试 / 极端兜底）；
 *  - `home`：拼默认路径用的 DSH home；
 *  - `fs`：`{readFile, writeFile, rename, mkdir}` 的替身；
 *  - `now`：`() => epoch ms`（`recordRun` 缺省 `at` 时用）。
 *
 * @param {object} [options] - 选项。
 * @returns {object} 存储句柄（`read` / `getConfig` / `setConfig` / `recordRun` / `describe` / `close`）。
 */
export function createCheckinStore(options = {}) {
  const file = options.file === false
    ? undefined
    : (options.file ?? defaultCheckinStorePath(options.home))
  const fsImpl = { readFile, writeFile, rename, mkdir, ...options.fs }
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  /** @type {object|undefined} 内存缓存。 */
  let state
  /** @type {Promise<object>|undefined} 加载中的 Promise（并发读只落一次盘）。 */
  let loading
  /** 写链：同一时刻只落一份快照，避免交错写坏文件。 */
  let chain = Promise.resolve()

  /**
   * 原子落盘：tmp + rename。
   * @param {object} value - 要写的状态。
   * @returns {Promise<void>} 写完成。
   */
  async function persist(value) {
    if (file === undefined) return
    const text = `${JSON.stringify(value, null, 2)}\n`
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`
    await fsImpl.mkdir(dirname(file), { recursive: true })
    await fsImpl.writeFile(tmp, text, 'utf8')
    await fsImpl.rename(tmp, file)
  }

  /**
   * 损坏时的修复写：失败只吞不抛（修复是尽力而为，不影响本次读取）。
   * @param {object} value - 修复目标状态。
   * @returns {Promise<void>} 完成。
   */
  async function repair(value) {
    try {
      await persist(value)
    } catch {
      // 读不到 / 写不了都不是致命错误：本次请求用默认值继续。
    }
  }

  /**
   * 从介质加载（永不抛）。
   * @returns {Promise<object>} 归一化状态。
   */
  async function load() {
    const fallback = defaultCheckinState()
    if (file === undefined) return fallback
    let raw
    try {
      raw = await fsImpl.readFile(file, 'utf8')
    } catch {
      // 文件不存在是正常初始态（首次使用）；其它读取错误（权限等）也只回落默认值 ——
      // 签到是非关键功能，绝不能因为它读不到文件就让插件加载失败。
      return fallback
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      await repair(fallback)
      return fallback
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      await repair(fallback)
      return fallback
    }
    const normalized = normalizeCheckinState(parsed)
    // 字段被纠正过（版本升级 / 手改坏）→ 写一次修复，避免每次启动都重新归一化。
    if (JSON.stringify(parsed) !== JSON.stringify(normalized)) await repair(normalized)
    return normalized
  }

  /**
   * 取内存状态（首次访问时加载）。
   * @returns {Promise<object>} 状态。
   */
  async function ensure() {
    if (state !== undefined) return state
    loading ??= load().then((value) => {
      state = value
      return value
    })
    return loading
  }

  /**
   * 串行化一次「读-改-写」。
   * @param {(current: object) => object} mutate - 纯函数式修改器。
   * @returns {Promise<object>} 落盘后的新状态。
   */
  function enqueue(mutate) {
    const task = chain.then(async () => {
      const current = await ensure()
      const next = mutate(clone(current))
      await persist(next)
      state = next
      return clone(next)
    })
    chain = task.then(() => undefined, () => undefined)
    return task
  }

  return {
    /**
     * 读整份状态（深拷贝）。
     * @returns {Promise<object>} 状态。
     */
    async read() {
      return clone(await ensure())
    },

    /**
     * 读配置。
     * @returns {Promise<{enabled: boolean, time: string}>} 配置。
     */
    async getConfig() {
      return clone((await ensure()).config)
    },

    /**
     * 部分更新配置（严格校验，非法抛错由路由映射成 BAD_REQUEST）。
     * @param {{enabled?: boolean, time?: string}} [patch] - 待更新字段。
     * @returns {Promise<{enabled: boolean, time: string}>} 更新后的配置。
     */
    async setConfig(patch = {}) {
      if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
        throw new Error('ima-knowledge: checkin setConfig 参数必须是对象')
      }
      /** @type {{enabled?: boolean, time?: string}} */
      const next = {}
      if (patch.enabled !== undefined) {
        if (typeof patch.enabled !== 'boolean') {
          throw new Error('ima-knowledge: config.enabled 必须是布尔值')
        }
        next.enabled = patch.enabled
      }
      if (patch.time !== undefined) {
        if (!isValidCheckinTime(patch.time)) {
          throw new Error('ima-knowledge: config.time 必须是 HH:mm')
        }
        next.time = patch.time
      }
      const saved = await enqueue((current) => ({
        ...current,
        config: { ...current.config, ...next },
      }))
      return clone(saved.config)
    },

    /**
     * 记一轮运行结果：写 `lastRun` 并把同一条记录插到 `history` 最前（截 30 条）。
     * @param {object} record - `{date?, at?, ok?, reward?, total?, alreadyChecked?, error?}`。
     * @returns {Promise<object>} 落盘后的整份状态。
     */
    async recordRun(record) {
      const normalized = normalizeRunRecord({ at: now(), ...record })
      if (normalized === undefined) {
        throw new Error('ima-knowledge: 签到记录缺少合法的 date/at')
      }
      const saved = await enqueue((current) => ({
        ...current,
        lastRun: normalized,
        history: [normalized, ...current.history].slice(0, CHECKIN_HISTORY_LIMIT),
      }))
      return clone(saved)
    },

    /**
     * 诊断信息：实际生效的介质。
     * @returns {{scope: 'file'|'memory', file?: string}} 介质描述。
     */
    describe() {
      return file === undefined ? { scope: 'memory' } : { scope: 'file', file }
    },

    /** 关闭（无持久资源，占位以便宿主统一 dispose）。 */
    async close() {},
  }
}
