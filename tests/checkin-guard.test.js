/**
 * 测试进程守卫单测（`lib/host.js` 的 `isTestProcess` / `apply({checkinAutoStart})`）
 *
 * 为什么单独一个文件：`apply()` 在几十个既有测试里被调用，自动签到调度器的
 * 「启动补跑」会真的打上游、写 `DSH_HOME` 下的账本。守卫必须默认生效，
 * 否则跑一次单测就会污染用户真实数据 —— 这里把这条不变量钉死。
 *
 * 文件名里的 probe 指「探测测试进程」：本文件是当初定位该问题的探针，
 * 现在保留为守卫的回归测试（沙箱不允许删除文件）。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { __internals, apply } from '../lib/host.js'

/** 与 DSH 宿主签名一致的最小假 ctx。 */
function fakeCtx() {
  const routes = []
  const credentials = {
    async resolve() {
      return undefined
    },
    async describe() {
      return { configured: false, writable: true }
    },
    async set() {},
    async unset() {},
  }
  const ctx = {
    effect: (callback) => callback(),
    inject: (_services, callback) => callback(ctx),
    get: (service) => {
      if (service === 'tools') return { register: () => () => {} }
      if (service === 'credentials') return credentials
      if (service === 'connection') {
        return {
          fetch: {
            register: (route) => {
              routes.push(route)
              return async () => {}
            },
          },
        }
      }
      return undefined
    },
  }
  return { ctx, routes }
}

/** 只记录 start/stop 的假调度器。 */
function fakeScheduler() {
  const calls = { start: 0, stop: 0 }
  return {
    calls,
    start() {
      calls.start += 1
    },
    stop() {
      calls.stop += 1
    },
    async runNow() {
      return {}
    },
  }
}

/** 内存假 store（apply 只透传，不读）。 */
function fakeStore() {
  return {
    async read() {
      return { version: 1, config: { enabled: true, time: '09:00' }, lastRun: null, history: [] }
    },
    async recordRun(record) {
      return record
    },
    async setConfig(patch) {
      return { enabled: true, time: '09:00', ...patch }
    },
  }
}

describe('apply: 测试进程守卫', () => {
  it('node --test 进程里 isTestProcess() 为 true', () => {
    assert.equal(__internals.isTestProcess(), true)
  })

  it('测试进程里 apply 默认不启动后台调度器', () => {
    const { ctx } = fakeCtx()
    const scheduler = fakeScheduler()
    apply(ctx, { checkinStore: fakeStore(), checkinScheduler: scheduler, sessionStoreFile: false })
    assert.equal(scheduler.calls.start, 0, '测试进程默认不得自动启动后台调度器')
  })

  it('显式 checkinAutoStart:true 时仍会启动（供需要真调度器的测试使用）', () => {
    const { ctx } = fakeCtx()
    const scheduler = fakeScheduler()
    apply(ctx, {
      checkinStore: fakeStore(),
      checkinScheduler: scheduler,
      checkinAutoStart: true,
      sessionStoreFile: false,
    })
    assert.equal(scheduler.calls.start, 1)
  })

  it('生产语义不受影响：checkinAutoStart:false 可显式关闭', () => {
    const { ctx } = fakeCtx()
    const scheduler = fakeScheduler()
    apply(ctx, {
      checkinStore: fakeStore(),
      checkinScheduler: scheduler,
      checkinAutoStart: false,
      sessionStoreFile: false,
    })
    assert.equal(scheduler.calls.start, 0)
  })
})
