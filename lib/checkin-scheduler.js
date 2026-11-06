/**
 * ima-knowledge · 自动签到调度器（docs/CHECKIN.md §3.2）
 *
 * 职责边界：
 *  - **只排时间**：不读凭据、不发请求；真正的一轮签到由宿主注入的 `run(reason)` 完成
 *    （host 层注入「读凭据 + withTokenRefresh + runCheckin」）。
 *  - **只记结果**：`run` 的返回值 / 异常由本模块写进 store 的 `lastRun` / `history`
 *    （契约要求「异常写进 lastRun.error 并继续 arm」）。
 *
 * 四条行为要求（逐条对应契约）：
 *  1. **单飞**：`runNow` 并发调用只跑一次，后到者拿到同一个 Promise；
 *  2. **每日去重**：`lastRun.date === 今天 && lastRun.ok` → **定时触发**直接跳过；
 *  3. **启动补跑**：`start()` 时若 enabled && 今天未成功 && 现在 >= 今日 HH:mm → 立即补跑，
 *     否则排到今日 HH:mm；每次 fire 后重新 arm 到下一个 HH:mm（跨天自动重算）；
 *  4. **不阻止进程退出**：timer 必须 `.unref?.()`；`stop()` 幂等且之后不再触发。
 *
 * @module ima-knowledge/checkin-scheduler
 */

import {
  DEFAULT_CHECKIN_TIME,
  formatLocalDate,
  isValidCheckinTime,
} from './checkin-store.js'

/** 默认日志器：只输出带模块前缀的一行，便于宿主日志里检索。 */
const DEFAULT_LOGGER = {
  info(message) {
    console.info(`[ima-knowledge/checkin] ${message}`)
  },
  warn(message) {
    console.warn(`[ima-knowledge/checkin] ${message}`)
  },
  error(message) {
    console.error(`[ima-knowledge/checkin] ${message}`)
  },
}

/** 错误 → 一行文本。 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 解析 `HH:mm`。
 * @param {unknown} value - 候选值。
 * @returns {{hours: number, minutes: number} | null} 解析结果；非法为 null。
 */
export function parseCheckinTime(value) {
  if (!isValidCheckinTime(value)) return null
  const [hours, minutes] = value.split(':').map(Number)
  return { hours, minutes }
}

/**
 * 今日 `HH:mm` 的 epoch ms（**不管是否已过**）。
 * @param {number} nowMs - 当前时间。
 * @param {string} [time] - `HH:mm`。
 * @returns {number} 今日该时刻的 epoch ms。
 */
export function todayTargetAt(nowMs, time = DEFAULT_CHECKIN_TIME) {
  const parsed = parseCheckinTime(time) ?? parseCheckinTime(DEFAULT_CHECKIN_TIME)
  const date = new Date(nowMs)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), parsed.hours, parsed.minutes, 0, 0).getTime()
}

/**
 * 下一个本地 `HH:mm` 的 epoch ms：今天还没到就是今天，否则明天。
 *
 * 「还没到」取**严格大于**：`nowMs` 恰好等于今日 HH:mm 时返回明天 —— 否则
 * 「到点 fire → 重新 arm」会算出 0ms 延迟，变成死循环。
 *
 * @param {number} nowMs - 当前时间（epoch ms）。
 * @param {string} [time] - `HH:mm`（非法回落 09:00）。
 * @returns {number} 下一次执行时刻。
 */
export function nextRunAt(nowMs, time = DEFAULT_CHECKIN_TIME) {
  const current = Number.isFinite(nowMs) ? nowMs : Date.now()
  const parsed = parseCheckinTime(time) ?? parseCheckinTime(DEFAULT_CHECKIN_TIME)
  const date = new Date(current)
  const today = new Date(date.getFullYear(), date.getMonth(), date.getDate(), parsed.hours, parsed.minutes, 0, 0)
  if (today.getTime() > current) return today.getTime()
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1, parsed.hours, parsed.minutes, 0, 0).getTime()
}

/**
 * 建签到调度器。
 *
 * @param {object} options - 选项。
 * @param {object} options.store - 存储（需提供 `read()`；有 `recordRun()` 时记录结果）。
 * @param {(reason: string) => Promise<any>} options.run - 真正跑一轮签到的函数。
 * @param {() => number} [options.now] - 当前时间（测试注入假时钟）。
 * @param {{setTimeout: Function, clearTimeout: Function}} [options.timers] - 定时器（测试注入假定时器）。
 * @param {{info?: Function, warn?: Function, error?: Function}} [options.logger] - 日志器。
 * @returns {{start: () => void, stop: () => void,
 *   runNow: (reason?: string) => Promise<any>, nextRunAt: (nowMs?: number, time?: string) => number}}
 *   调度器句柄。
 */
export function createCheckinScheduler(options = {}) {
  const store = options.store
  if (store === null || typeof store !== 'object' || typeof store.read !== 'function') {
    throw new TypeError('createCheckinScheduler: store 必须提供 read()')
  }
  const run = options.run
  if (typeof run !== 'function') {
    throw new TypeError('createCheckinScheduler: run 必须是函数')
  }
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const timers = options.timers ?? {
    setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
    clearTimeout: (handle) => globalThis.clearTimeout(handle),
  }
  const logger = options.logger ?? DEFAULT_LOGGER

  /** 当前定时器句柄。 */
  let timer
  /** 是否已 start（stop 后为 false，异步流程据此放弃 arm）。 */
  let started = false
  /** 单飞：进行中的一轮。 */
  let inFlight
  /** 最近一次从 store 读到的签到时间（`nextRunAt()` 同步方法用）。 */
  let cachedTime = DEFAULT_CHECKIN_TIME
  /** 代次：start/stop 会 +1，用于丢弃过期的异步流程。 */
  let generation = 0

  /** 清掉当前定时器（幂等）。 */
  function clearTimer() {
    if (timer === undefined) return
    try {
      timers.clearTimeout(timer)
    } catch {
      // 定时器已触发 / 已被清理：忽略。
    }
    timer = undefined
  }

  /**
   * 排定一次触发。
   * @param {number} targetMs - 目标 epoch ms。
   * @param {number} gen - 发起时的代次。
   */
  function scheduleAt(targetMs, gen) {
    const delay = Math.max(0, targetMs - now())
    const handle = timers.setTimeout(() => {
      timer = undefined
      if (!started || gen !== generation) return
      void fire('schedule')
    }, delay)
    // 定时器不得阻止进程退出（Node 的 Timeout 才有 unref；假定时器可能是普通值）。
    handle?.unref?.()
    timer = handle
  }

  /**
   * 读 store（失败只记日志，返回 undefined）。
   * @returns {Promise<object|undefined>} 状态。
   */
  async function readState() {
    try {
      return await store.read()
    } catch (error) {
      logger.error?.(`读取签到配置失败：${messageOf(error)}`)
      return undefined
    }
  }

  /**
   * 按 store 里的配置重新排定下一次触发。
   * @param {number} gen - 发起时的代次。
   * @returns {Promise<void>} 完成。
   */
  async function arm(gen) {
    clearTimer()
    if (!started || gen !== generation) return
    const state = await readState()
    if (!started || gen !== generation) return
    if (state === undefined) return
    cachedTime = isValidCheckinTime(state.config?.time) ? state.config.time : DEFAULT_CHECKIN_TIME
    if (state.config?.enabled === false) return
    scheduleAt(nextRunAt(now(), cachedTime), gen)
  }

  /**
   * 启动流程：读配置 → 判断「启动补跑」→ 否则排到下一次。
   * @param {number} gen - 代次。
   * @returns {Promise<void>} 完成。
   */
  async function bootstrap(gen) {
    clearTimer()
    if (!started || gen !== generation) return
    const state = await readState()
    if (!started || gen !== generation) return
    if (state === undefined) return
    cachedTime = isValidCheckinTime(state.config?.time) ? state.config.time : DEFAULT_CHECKIN_TIME
    if (state.config?.enabled === false) {
      logger.info?.('自动签到已关闭，不排定定时器')
      return
    }
    const today = formatLocalDate(now())
    const lastRun = state.lastRun
    const succeededToday = lastRun !== null
      && typeof lastRun === 'object'
      && lastRun.date === today
      && lastRun.ok === true
    if (!succeededToday && now() >= todayTargetAt(now(), cachedTime)) {
      logger.info?.(`今天 ${cachedTime} 的签到还没做，启动时补跑一次`)
      try {
        await runNow('startup')
      } catch (error) {
        logger.warn?.(`启动补跑失败：${messageOf(error)}`)
      }
      return
    }
    await arm(gen)
  }

  /**
   * 定时到点：每日去重后跑一轮（失败只记日志，不冒泡）。
   * @param {string} reason - 触发原因。
   * @returns {Promise<void>} 完成。
   */
  async function fire(reason) {
    const gen = generation
    const state = await readState()
    if (!started || gen !== generation) return
    const today = formatLocalDate(now())
    if (state !== undefined && state.lastRun?.date === today && state.lastRun?.ok === true) {
      logger.info?.(`今天（${today}）已经签到成功，跳过本次定时触发`)
      await arm(gen)
      return
    }
    try {
      await runNow(reason)
    } catch (error) {
      logger.warn?.(`定时签到失败：${messageOf(error)}`)
    }
  }

  /**
   * 跑一轮（手动 / 定时共用）：单飞 + 落记录 + 重新 arm。
   * @param {string} reason - 触发原因（`manual` / `schedule` / `startup`）。
   * @returns {Promise<any>} `run` 的返回值；`run` 抛错时原样 reject。
   */
  function runNow(reason = 'manual') {
    if (inFlight !== undefined) return inFlight
    const task = execute(reason)
    inFlight = task
    return task
  }

  /**
   * 单飞的实际执行体。
   * @param {string} reason - 触发原因。
   * @returns {Promise<any>} 结果。
   */
  async function execute(reason) {
    const gen = generation
    const startedAt = now()
    let result
    let failure
    try {
      result = await run(reason)
    } catch (error) {
      failure = error
    }
    // 凭据未配置时宿主返回 `{skipped:true}`：静默跳过，不写失败历史（否则每小时刷记录）。
    const skipped = failure === undefined
      && result !== null
      && typeof result === 'object'
      && result.skipped === true
    if (skipped) {
      logger.info?.('凭据未配置，跳过本次自动签到')
    } else {
      const record = failure === undefined
        ? {
          date: formatLocalDate(startedAt),
          at: startedAt,
          ok: true,
          reward: typeof result?.reward === 'number' && Number.isFinite(result.reward) ? result.reward : 0,
          total: typeof result?.total === 'number' && Number.isFinite(result.total) ? result.total : 0,
          alreadyChecked: result?.alreadyChecked === true,
          error: null,
        }
        : {
          date: formatLocalDate(startedAt),
          at: startedAt,
          ok: false,
          reward: 0,
          total: 0,
          alreadyChecked: false,
          error: messageOf(failure),
        }
      try {
        if (typeof store.recordRun === 'function') await store.recordRun(record)
      } catch (error) {
        logger.warn?.(`写入签到记录失败：${messageOf(error)}`)
      }
    }
    try {
      await arm(gen)
    } catch (error) {
      logger.warn?.(`排定下一次签到失败：${messageOf(error)}`)
    }
    inFlight = undefined
    if (failure !== undefined) throw failure
    return result
  }

  return {
    /**
     * 启动（幂等：再次调用 = 按最新配置重新排定）。
     * @returns {void}
     */
    start() {
      started = true
      generation += 1
      const gen = generation
      void bootstrap(gen)
    },

    /**
     * 停止（幂等）：清定时器，之后不再触发；进行中的一轮不再重新 arm。
     * @returns {void}
     */
    stop() {
      started = false
      generation += 1
      clearTimer()
    },

    /**
     * 立即跑一轮（手动 / 定时共用，单飞）。
     * @param {string} [reason] - 触发原因。
     * @returns {Promise<any>} 结果。
     */
    runNow,

    /**
     * 下一次执行时刻（同步；时间取最近一次从 store 读到的配置）。
     * @param {number} [nowMs] - 基准时间。
     * @param {string} [time] - 覆盖签到时间（测试用）。
     * @returns {number} epoch ms。
     */
    nextRunAt(nowMs = now(), time = cachedTime) {
      return nextRunAt(nowMs, time)
    },
  }
}
