/**
 * lib/checkin-scheduler.js 单测（CHECKIN.md §3.2 / §6.1）
 *
 * 覆盖：nextRunAt 边界（00:00 / 23:59 / 跨天 / 跨月）、单飞、每日去重、启动补跑、
 * fire 后重新 arm、stop 幂等与 stop 后不再触发、timer.unref。
 *
 * 全部用**假时钟 + 假定时器 + 假 store**，不依赖真实时间与网络。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  createCheckinScheduler,
  nextRunAt,
  parseCheckinTime,
  todayTargetAt,
} from '../lib/checkin-scheduler.js'

// --------------------------------------------------------------- 测试脚手架

/** 2026-11-06（周五）08:00 本地时间。 */
const NOW = new Date(2026, 10, 6, 8, 0, 0).getTime()

/** 本地时间构造器（避免用字符串解析，受时区影响）。 */
function local(year, month, day, hours = 0, minutes = 0, seconds = 0) {
  return new Date(year, month - 1, day, hours, minutes, seconds, 0).getTime()
}

/** 假定时器：记录 setTimeout 的 handle（带 unref 计数），可手动 fire。 */
function fakeTimers() {
  const scheduled = []
  let nextId = 1
  const timers = {
    scheduled,
    setTimeout(callback, ms) {
      const handle = {
        id: nextId,
        ms,
        callback,
        cleared: false,
        fired: false,
        unrefCalls: 0,
        unref() {
          this.unrefCalls += 1
        },
      }
      nextId += 1
      scheduled.push(handle)
      return handle
    },
    clearTimeout(handle) {
      if (handle !== undefined && handle !== null) handle.cleared = true
    },
    pending() {
      return scheduled.filter((handle) => !handle.cleared && !handle.fired)
    },
    fire(handle) {
      handle.fired = true
      handle.callback()
    },
    fireLast() {
      const list = timers.pending()
      const handle = list[list.length - 1]
      timers.fire(handle)
      return handle
    },
  }
  return timers
}

/** 假 store：内存状态 + 记录调用。 */
function fakeStore(initial = {}) {
  const store = {
    state: {
      version: 1,
      config: { enabled: true, time: '09:00' },
      lastRun: null,
      history: [],
      ...initial,
    },
    records: [],
    async read() {
      return structuredClone(store.state)
    },
    async recordRun(record) {
      store.records.push(record)
      store.state = {
        ...store.state,
        lastRun: record,
        history: [record, ...store.state.history].slice(0, 30),
      }
      return structuredClone(store.state)
    },
    async setConfig(patch) {
      store.state = { ...store.state, config: { ...store.state.config, ...patch } }
      return { ...store.state.config }
    },
  }
  return store
}

/** 一条「今天已成功」的 lastRun。 */
function successToday(nowMs = NOW) {
  const date = new Date(nowMs)
  const pad = (value) => String(value).padStart(2, '0')
  return {
    date: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    at: nowMs,
    ok: true,
    reward: 50,
    total: 50,
    alreadyChecked: false,
    error: null,
  }
}

/** 让所有微任务 / 一次宏任务结算完（start()/fire() 是 fire-and-forget 的异步流程）。 */
async function settle() {
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
}

/** 建一个「记录调用」的 run。 */
function recordingRun(result = { checked: true, reward: 50, total: 50 }) {
  const calls = []
  const run = async (reason) => {
    calls.push(reason)
    return result
  }
  return { run, calls }
}

// ---------------------------------------------------------------- nextRunAt

describe('nextRunAt', () => {
  it('今天还没到 → 今天 HH:mm', () => {
    assert.equal(nextRunAt(NOW, '09:00'), local(2026, 11, 6, 9, 0))
    assert.equal(nextRunAt(local(2026, 11, 6, 0, 0), '00:01'), local(2026, 11, 6, 0, 1))
  })

  it('今天已过 → 明天 HH:mm', () => {
    assert.equal(nextRunAt(local(2026, 11, 6, 10, 0), '09:00'), local(2026, 11, 7, 9, 0))
  })

  it('恰好等于今日 HH:mm → 明天（严格未来，避免 0ms 死循环）', () => {
    assert.equal(nextRunAt(local(2026, 11, 6, 9, 0), '09:00'), local(2026, 11, 7, 9, 0))
  })

  it('00:00 边界：00:00 整点 → 明天 00:00', () => {
    assert.equal(nextRunAt(local(2026, 11, 6, 0, 0), '00:00'), local(2026, 11, 7, 0, 0))
  })

  it('23:59 边界：23:58 → 今天 23:59；23:59:30 → 明天 23:59', () => {
    assert.equal(nextRunAt(local(2026, 11, 6, 23, 58), '23:59'), local(2026, 11, 6, 23, 59))
    assert.equal(nextRunAt(local(2026, 11, 6, 23, 59, 30), '23:59'), local(2026, 11, 7, 23, 59))
  })

  it('跨月 / 跨年正确进位', () => {
    assert.equal(nextRunAt(local(2026, 12, 31, 23, 0), '00:30'), local(2027, 1, 1, 0, 30))
    assert.equal(nextRunAt(local(2027, 1, 31, 23, 59), '09:00'), local(2027, 2, 1, 9, 0))
  })

  it('非法 time 回落 09:00', () => {
    assert.equal(nextRunAt(NOW, '25:00'), local(2026, 11, 6, 9, 0))
    assert.equal(nextRunAt(NOW, undefined), local(2026, 11, 6, 9, 0))
  })

  it('todayTargetAt 返回今日 HH:mm（即使已过）', () => {
    assert.equal(todayTargetAt(local(2026, 11, 6, 10, 0), '09:00'), local(2026, 11, 6, 9, 0))
  })

  it('parseCheckinTime 解析 / 拒绝', () => {
    assert.deepEqual(parseCheckinTime('08:05'), { hours: 8, minutes: 5 })
    assert.equal(parseCheckinTime('24:00'), null)
    assert.equal(parseCheckinTime('8:05'), null)
  })
})

// ------------------------------------------------------------ 生命周期与排定

describe('createCheckinScheduler: 生命周期', () => {
  it('store / run 缺失时显式抛错（不静默降级）', () => {
    assert.throws(() => createCheckinScheduler({ run: async () => ({}) }), /store 必须提供 read/u)
    assert.throws(() => createCheckinScheduler({ store: fakeStore() }), /run 必须是函数/u)
  })

  it('启动时今天还没到点 → 只 arm，不跑', async () => {
    const timers = fakeTimers()
    const store = fakeStore()
    const { run, calls } = recordingRun()
    const scheduler = createCheckinScheduler({ store, run, now: () => NOW, timers })
    scheduler.start()
    await settle()
    assert.deepEqual(calls, [])
    const pending = timers.pending()
    assert.equal(pending.length, 1)
    assert.equal(pending[0].ms, local(2026, 11, 6, 9, 0) - NOW)
    assert.equal(pending[0].unrefCalls, 1, '定时器必须 unref')
    scheduler.stop()
  })

  it('启动时已过点且今天未成功 → 立即补跑一次，然后 arm 到明天', async () => {
    const timers = fakeTimers()
    const store = fakeStore()
    const later = local(2026, 11, 6, 10, 0)
    const { run, calls } = recordingRun()
    const scheduler = createCheckinScheduler({ store, run, now: () => later, timers })
    scheduler.start()
    await settle()
    assert.deepEqual(calls, ['startup'])
    assert.equal(store.records.length, 1)
    assert.equal(store.records[0].ok, true)
    const pending = timers.pending()
    assert.equal(pending.length, 1)
    assert.equal(pending[0].ms, local(2026, 11, 7, 9, 0) - later, '补跑后应 arm 到明天')
    scheduler.stop()
  })

  it('启动时今天已成功 → 不补跑（每日去重）', async () => {
    const timers = fakeTimers()
    const later = local(2026, 11, 6, 10, 0)
    const store = fakeStore({ lastRun: successToday(later) })
    const { run, calls } = recordingRun()
    const scheduler = createCheckinScheduler({ store, run, now: () => later, timers })
    scheduler.start()
    await settle()
    assert.deepEqual(calls, [])
    assert.equal(timers.pending()[0].ms, local(2026, 11, 7, 9, 0) - later)
    scheduler.stop()
  })

  it('enabled:false → 不排定时器也不跑', async () => {
    const timers = fakeTimers()
    const store = fakeStore({ config: { enabled: false, time: '09:00' } })
    const { run, calls } = recordingRun()
    const scheduler = createCheckinScheduler({ store, run, now: () => local(2026, 11, 6, 10, 0), timers })
    scheduler.start()
    await settle()
    assert.deepEqual(calls, [])
    assert.equal(timers.pending().length, 0)
    scheduler.stop()
  })

  it('按 store 里的自定义时间排定，nextRunAt() 同步反映', async () => {
    const timers = fakeTimers()
    const store = fakeStore({ config: { enabled: true, time: '08:30' } })
    const { run } = recordingRun()
    const scheduler = createCheckinScheduler({ store, run, now: () => NOW, timers })
    scheduler.start()
    await settle()
    assert.equal(scheduler.nextRunAt(NOW), local(2026, 11, 6, 8, 30))
    assert.equal(timers.pending()[0].ms, local(2026, 11, 6, 8, 30) - NOW)
    scheduler.stop()
  })

  it('再次 start() 按最新配置重新排定（配置路由改时间后调用）', async () => {
    const timers = fakeTimers()
    const store = fakeStore()
    const { run } = recordingRun()
    const scheduler = createCheckinScheduler({ store, run, now: () => NOW, timers })
    scheduler.start()
    await settle()
    assert.equal(timers.pending().length, 1)
    // 改到「今天已经过了」的时间：重新 arm 应落到明天同一时刻。
    await store.setConfig({ time: '07:30' })
    scheduler.start()
    await settle()
    assert.equal(timers.pending().length, 1, '旧定时器必须被清掉')
    assert.equal(timers.pending()[0].ms, local(2026, 11, 7, 7, 30) - NOW)
    scheduler.stop()
  })
})

// ------------------------------------------------------------ 到点触发与去重

describe('createCheckinScheduler: 到点触发', () => {
  it('到点 fire → 跑一轮、写 lastRun、再 arm 到明天', async () => {
    const timers = fakeTimers()
    const store = fakeStore()
    const { run, calls } = recordingRun()
    let clock = NOW
    const scheduler = createCheckinScheduler({ store, run, now: () => clock, timers })
    scheduler.start()
    await settle()
    const [handle] = timers.pending()
    // 时间推进到触发点（真实时钟会自己走，假时钟要手动拨）。
    clock = local(2026, 11, 6, 9, 0)
    timers.fire(handle)
    await settle()
    assert.deepEqual(calls, ['schedule'])
    assert.equal(store.records.length, 1)
    assert.equal(store.records[0].ok, true)
    assert.equal(store.records[0].reward, 50)
    const pending = timers.pending()
    assert.equal(pending.length, 1)
    assert.equal(pending[0].ms, local(2026, 11, 7, 9, 0) - clock, '跨天自动重算到明天 HH:mm')
    scheduler.stop()
  })

  it('定时触发时今天已成功 → 跳过（不重复请求）', async () => {
    const timers = fakeTimers()
    const store = fakeStore({ lastRun: successToday(NOW) })
    const { run, calls } = recordingRun()
    let clock = NOW
    const scheduler = createCheckinScheduler({ store, run, now: () => clock, timers })
    scheduler.start()
    await settle()
    const [handle] = timers.pending()
    clock = local(2026, 11, 6, 9, 0)
    timers.fire(handle)
    await settle()
    assert.deepEqual(calls, [])
    assert.equal(store.records.length, 0)
    assert.equal(timers.pending().length, 1, '跳过后仍要 arm 下一次')
    assert.equal(timers.pending()[0].ms, local(2026, 11, 7, 9, 0) - clock)
    scheduler.stop()
  })

  it('run 抛错 → 写 lastRun.error 并继续 arm，runNow 原样 reject', async () => {
    const timers = fakeTimers()
    const store = fakeStore()
    const run = async () => {
      throw new Error('code 41: token expired')
    }
    const scheduler = createCheckinScheduler({ store, run, now: () => NOW, timers })
    scheduler.start()
    await settle()
    await assert.rejects(scheduler.runNow('manual'), /code 41: token expired/u)
    await settle()
    assert.equal(store.records.length, 1)
    assert.equal(store.records[0].ok, false)
    assert.match(store.records[0].error, /code 41/u)
    assert.equal(timers.pending().length, 1, '失败后也要继续 arm')
    scheduler.stop()
  })

  it('run 返回 {skipped:true}（凭据未配置）→ 不写失败历史', async () => {
    const timers = fakeTimers()
    const store = fakeStore()
    const run = async () => ({ skipped: true, reason: 'credentials-not-configured' })
    const scheduler = createCheckinScheduler({ store, run, now: () => NOW, timers })
    const result = await scheduler.runNow('manual')
    assert.equal(result.skipped, true)
    assert.equal(store.records.length, 0)
    scheduler.stop()
  })

  it('store.recordRun 失败只记日志，不影响 runNow 结果', async () => {
    const timers = fakeTimers()
    const store = fakeStore()
    store.recordRun = async () => {
      throw new Error('disk full')
    }
    const warnings = []
    const logger = { info() {}, warn: (message) => warnings.push(message), error() {} }
    const run = async () => ({ checked: true, reward: 50, total: 50 })
    const scheduler = createCheckinScheduler({ store, run, now: () => NOW, timers, logger })
    const result = await scheduler.runNow('manual')
    assert.equal(result.checked, true)
    assert.ok(warnings.some((message) => message.includes('disk full')))
    scheduler.stop()
  })
})

// -------------------------------------------------------------------- 单飞

describe('createCheckinScheduler: 单飞', () => {
  it('并发 runNow 只跑一次，后到者拿到同一个 Promise', async () => {
    const timers = fakeTimers()
    const store = fakeStore()
    let resolveRun
    let calls = 0
    const run = () => {
      calls += 1
      return new Promise((resolve) => {
        resolveRun = resolve
      })
    }
    const scheduler = createCheckinScheduler({ store, run, now: () => NOW, timers })
    const first = scheduler.runNow('manual')
    const second = scheduler.runNow('schedule')
    assert.equal(calls, 1, '并发调用只能触发一次 run')
    assert.equal(first, second, '后到者必须拿到同一个 Promise')
    resolveRun({ checked: true, reward: 50, total: 50 })
    const [left, right] = await Promise.all([first, second])
    assert.deepEqual(left, right)
    assert.equal(store.records.length, 1)
    scheduler.stop()
  })

  it('一轮结束后可以再跑（单飞只约束进行中）', async () => {
    const timers = fakeTimers()
    const store = fakeStore()
    const { run, calls } = recordingRun()
    const scheduler = createCheckinScheduler({ store, run, now: () => NOW, timers })
    await scheduler.runNow('manual')
    await scheduler.runNow('manual')
    assert.deepEqual(calls, ['manual', 'manual'])
    assert.equal(store.records.length, 2)
    scheduler.stop()
  })
})

// -------------------------------------------------------------------- stop

describe('createCheckinScheduler: stop', () => {
  it('stop 清定时器且幂等', async () => {
    const timers = fakeTimers()
    const store = fakeStore()
    const { run } = recordingRun()
    const scheduler = createCheckinScheduler({ store, run, now: () => NOW, timers })
    scheduler.start()
    await settle()
    const pending = timers.pending()
    assert.equal(pending.length, 1)
    scheduler.stop()
    assert.equal(timers.pending().length, 0)
    assert.doesNotThrow(() => scheduler.stop())
    assert.doesNotThrow(() => scheduler.stop())
  })

  it('stop 后即使旧回调被触发也不跑（守卫 started）', async () => {
    const timers = fakeTimers()
    const store = fakeStore()
    const { run, calls } = recordingRun()
    const scheduler = createCheckinScheduler({ store, run, now: () => NOW, timers })
    scheduler.start()
    await settle()
    const [handle] = timers.pending()
    scheduler.stop()
    timers.fire(handle)
    await settle()
    assert.deepEqual(calls, [])
  })

  it('stop 时有一轮在飞 → 该轮结束后不再 arm', async () => {
    const timers = fakeTimers()
    const store = fakeStore()
    let resolveRun
    const run = () => new Promise((resolve) => {
      resolveRun = resolve
    })
    const scheduler = createCheckinScheduler({ store, run, now: () => NOW, timers })
    const task = scheduler.runNow('manual')
    scheduler.stop()
    resolveRun({ checked: true })
    await task
    await settle()
    assert.equal(timers.pending().length, 0)
  })
})
