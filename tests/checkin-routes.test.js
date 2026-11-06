/**
 * `/api/ima-knowledge/checkin/{status,run,config}` 单测（CHECKIN.md §4 / §6.1）
 *
 * 覆盖三条路由的信封与语义：
 *  - `status`：未配置（ok:true + configured:false）/ 已配置（真打上游）/ token 失效 / 上游形状异常；
 *  - `run`：已签过（不报错）/ 新签到 / 未配置 / 真失败；
 *  - `config`：部分更新 / time 非法 BAD_REQUEST / 更新后立即重新 arm。
 *
 * 写法沿用 tests/credentials.test.js：真 `apply()` + 假 ctx + 假 fetch + 假定时器，
 * 签到存储用 `file:false`（纯内存），**不碰真实文件系统与网络**。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createCheckinStore } from '../lib/checkin-store.js'
import {
  ERROR_CODES,
  IMA_X_IMA_BKN_REF,
  IMA_X_IMA_COOKIE_REF,
  ROUTE_CHECKIN_CONFIG,
  ROUTE_CHECKIN_RUN,
  ROUTE_CHECKIN_STATUS,
  ROUTE_ERROR_CODES,
  apply,
} from '../lib/host.js'

// --------------------------------------------------------------- 测试脚手架

/** 2026-11-06（周五）08:00 本地时间：早于默认 09:00，启动时不会补跑。 */
const NOW = new Date(2026, 10, 6, 8, 0, 0).getTime()

const COOKIE = 'PLATFORM=H5; IMA-UID=user-1; IMA-TOKEN=tok-abc; IMA-REFRESH-TOKEN=ref-xyz; IMA-GUID=guid-9'
const BKN = '193485963'

/** CHECKIN.md §1.1 真机响应（已签到后）的最小复刻。 */
function activityInfo(overrides = {}) {
  return {
    code: 0,
    msg: 'ok',
    checkin_days: 1,
    total_reward_points: 50,
    infos: [
      { button: '已过期', reward: '50算力', status: 1, top: '周一' },
      { button: '已过期', reward: '50算力', status: 1, top: '周二' },
      { button: '已过期', reward: '50算力', status: 1, top: '周三' },
      { button: '已过期', reward: '50算力', status: 1, top: '周四' },
      { button: '已领取', reward: '50算力', status: 2, top: '今日' },
      { button: '待解锁', reward: '50算力', status: 4, top: '周六' },
      { button: '待解锁', reward: '50算力', status: 4, top: '周日' },
      { button: '连续7天签到解锁', reward: '额外随机奖励', status: 4, top: '满签奖励' },
    ],
    ...overrides,
  }
}

/** 今日可签的响应（status 3）。 */
function pendingInfo(overrides = {}) {
  const info = activityInfo(overrides)
  info.infos[4] = { button: '签到', reward: '50算力', status: 3, top: '今日' }
  return info
}

/** 与 DSH CredentialProvider 签名一致的假凭据服务。 */
function fakeCredentials(store) {
  return {
    async resolve(ref) {
      const value = store[ref]
      return value === undefined ? undefined : { value, source: 'file' }
    },
    async describe(ref) {
      return { configured: store[ref] !== undefined, source: store[ref] === undefined ? undefined : 'file', writable: true }
    },
    async set(ref, value) {
      store[ref] = value
    },
    async unset(ref) {
      delete store[ref]
    },
  }
}

/** 假定时器（只关心「有没有排、排多久」）。 */
function fakeTimers() {
  const scheduled = []
  return {
    scheduled,
    setTimeout(callback, ms) {
      const handle = { ms, callback, cleared: false, unref() {} }
      scheduled.push(handle)
      return handle
    },
    clearTimeout(handle) {
      if (handle !== undefined && handle !== null) handle.cleared = true
    },
    pending() {
      return scheduled.filter((handle) => !handle.cleared)
    },
  }
}

/** 只回固定 JSON 的假 fetch，并记录请求（含解析后的 body）。 */
function jsonFetch(payload) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url: String(url), init, body: init?.body === undefined ? undefined : JSON.parse(init.body) })
    return Response.json(payload)
  }
  return { impl, calls }
}

/** 按顺序回应的假 fetch。 */
function sequenceFetch(payloads) {
  const calls = []
  let index = 0
  const impl = async (url, init) => {
    calls.push({ url: String(url), init, body: init?.body === undefined ? undefined : JSON.parse(init.body) })
    const payload = payloads[Math.min(index, payloads.length - 1)]
    index += 1
    return Response.json(payload)
  }
  return { impl, calls }
}

/** 让 start()/runNow() 这类 fire-and-forget 的异步流程结算完。 */
async function settle() {
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
}

/**
 * 挂载插件并返回路由小工具。
 * @param {object} [options] - 选项。
 * @param {Record<string,string>} [options.credentials] - 假凭据存储。
 * @param {typeof fetch} [options.fetchImpl] - 假 fetch。
 * @param {object} [options.timers] - 假定时器。
 * @returns {Promise<{post: Function, route: Function, routes: object[], store: object, timers: object}>} 脚手架。
 */
async function mount(options = {}) {
  const credentials = fakeCredentials(options.credentials ?? {})
  const timers = options.timers ?? fakeTimers()
  const routes = []
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
  const store = createCheckinStore({ file: false, now: () => NOW })
  apply(ctx, {
    fetchImpl: options.fetchImpl,
    ...(options.desktop === undefined ? {} : { desktop: options.desktop }),
    checkinStore: store,
    checkinNow: () => NOW,
    checkinTimers: timers,
    // 测试进程里 apply 默认不启动后台调度器（避免污染真实数据）；
    // 这里要验证「启动即 arm / 配置变更重排」，显式打开。
    checkinAutoStart: true,
    sessionStoreFile: false,
  })
  // apply 里的 scheduler.start() 是 fire-and-forget：等它把定时器排好再返回，
  // 否则测试读 timers.pending() 会读到「还没 arm」的中间态。
  await settle()
  const route = (path) => routes.find((entry) => entry.path === path)
  const post = async (path, body) => {
    const response = await route(path).fetch(new Request('http://host/x', {
      method: 'POST',
      body: JSON.stringify(body),
    }))
    return { status: response.status, headers: response.headers, payload: await response.json() }
  }
  return { post, route, routes, store, timers }
}

const CONFIGURED = { [IMA_X_IMA_COOKIE_REF]: COOKIE, [IMA_X_IMA_BKN_REF]: BKN }

// ------------------------------------------------------------------ 路由形态

describe('checkin 路由：注册形态', () => {
  it('三条路由都是 POST + buffered，且响应 no-store', async () => {
    const { route, post } = await mount({ fetchImpl: jsonFetch(activityInfo()).impl })
    for (const path of [ROUTE_CHECKIN_STATUS, ROUTE_CHECKIN_RUN, ROUTE_CHECKIN_CONFIG]) {
      const entry = route(path)
      assert.ok(entry, `缺少路由 ${path}`)
      assert.deepEqual(entry.methods, ['POST'])
      assert.equal(entry.requestBody, 'buffered')
    }
    const { status, headers, payload } = await post(ROUTE_CHECKIN_STATUS, {})
    assert.equal(status, 200)
    assert.equal(headers.get('cache-control'), 'no-store')
    assert.equal(payload.ok, true)
  })
})

// --------------------------------------------------------------------- status

describe('checkin/status', () => {
  it('凭据未配置 → ok:true + configured:false（不是 HTTP 错误），且不打上游', async () => {
    const { impl, calls } = jsonFetch(activityInfo())
    const { post } = await mount({ fetchImpl: impl })
    const { status, payload } = await post(ROUTE_CHECKIN_STATUS, {})
    assert.equal(status, 200)
    assert.equal(payload.ok, true)
    const value = payload.value
    assert.equal(value.configured, false)
    assert.equal(value.tokenValid, false)
    assert.equal(value.enabled, true)
    assert.equal(value.time, '09:00')
    assert.deepEqual(value.history, [])
    assert.equal(value.lastRun, null)
    assert.equal(value.today, null)
    assert.equal(value.week, null)
    assert.equal(value.error.code, ERROR_CODES.notConfigured)
    assert.equal(calls.length, 0, '未配置时不该打上游')
  })

  it('已配置 → 真打一次上游并返回 today/week', async () => {
    const { impl, calls } = jsonFetch(activityInfo())
    const { post } = await mount({ credentials: CONFIGURED, fetchImpl: impl })
    const { payload } = await post(ROUTE_CHECKIN_STATUS, {})
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, 'https://ima.qq.com/cgi-bin/daily_login_activity/get_activity_info')
    const value = payload.value
    assert.equal(value.configured, true)
    assert.equal(value.tokenValid, true)
    assert.equal(value.today.checked, true)
    assert.equal(value.today.status, 2)
    assert.equal(value.today.reward, '50算力')
    assert.match(value.today.date, /^\d{4}-\d{2}-\d{2}$/u)
    assert.deepEqual(value.week, { checkinDays: 1, totalRewardPoints: 50, bonusAvailable: false })
    assert.equal('error' in value, false)
  })

  it('token 失效（110031）→ ok:true + tokenValid:false + error', async () => {
    const { impl } = jsonFetch({ code: 110031, msg: 'session expired' })
    const { post } = await mount({ credentials: CONFIGURED, fetchImpl: impl })
    const { payload } = await post(ROUTE_CHECKIN_STATUS, {})
    assert.equal(payload.ok, true)
    assert.equal(payload.value.configured, true)
    assert.equal(payload.value.tokenValid, false)
    assert.equal(payload.value.error.code, ERROR_CODES.sessionExpired)
    assert.equal(payload.value.today, null)
  })

  it('token 过期且自动续期 / 桌面同步都失败 → tokenValid:false（不是 unknown）', async () => {
    // 第一次 info 返回 41；第二次 refresh 也返回 41；桌面同步注入非 Windows 直接失败。
    const { impl } = sequenceFetch([
      { code: 41, msg: 'token expired' },
      { code: 41, msg: 'refresh failed' },
    ])
    const { post } = await mount({
      credentials: CONFIGURED,
      fetchImpl: impl,
      desktop: { platform: 'linux' },
    })
    const { payload } = await post(ROUTE_CHECKIN_STATUS, {})
    assert.equal(payload.ok, true)
    assert.equal(payload.value.tokenValid, false)
    assert.equal(payload.value.error.code, ERROR_CODES.tokenExpired)
    assert.match(payload.value.error.message, /自动续期/u)
  })

  it('网络失败 → tokenValid:unknown（不假报 true/false）+ error', async () => {
    const impl = async () => {
      throw new Error('boom')
    }
    const { post } = await mount({ credentials: CONFIGURED, fetchImpl: impl })
    const { payload } = await post(ROUTE_CHECKIN_STATUS, {})
    assert.equal(payload.ok, true)
    assert.equal(payload.value.tokenValid, 'unknown')
    assert.equal(payload.value.error.code, ERROR_CODES.upstream)
    assert.match(payload.value.error.message, /boom/u)
  })

  it('上游形状异常 → tokenValid:unknown + 人话原因', async () => {
    const { impl } = jsonFetch({ code: 0, msg: 'ok' })
    const { post } = await mount({ credentials: CONFIGURED, fetchImpl: impl })
    const { payload } = await post(ROUTE_CHECKIN_STATUS, {})
    assert.equal(payload.value.tokenValid, 'unknown')
    assert.match(payload.value.error.message, /形状不可识别/u)
  })

  it('返回 store 里的 history / lastRun（面板历史记录来源）', async () => {
    const { impl } = jsonFetch(activityInfo())
    const { post, store } = await mount({ credentials: CONFIGURED, fetchImpl: impl })
    await store.recordRun({ at: NOW, ok: true, reward: 50, total: 50 })
    const { payload } = await post(ROUTE_CHECKIN_STATUS, {})
    assert.equal(payload.value.history.length, 1)
    assert.equal(payload.value.history[0].reward, 50)
    assert.equal(payload.value.lastRun.ok, true)
  })
})

// ------------------------------------------------------------------------ run

describe('checkin/run', () => {
  it('今日已签过 → ok:true + alreadyChecked:true（不报错、不重复请求 check_in）', async () => {
    const { impl, calls } = jsonFetch(activityInfo())
    const { post, store } = await mount({ credentials: CONFIGURED, fetchImpl: impl })
    const { payload } = await post(ROUTE_CHECKIN_RUN, {})
    assert.equal(payload.ok, true)
    const value = payload.value
    assert.equal(value.checked, true)
    assert.equal(value.alreadyChecked, true)
    assert.deepEqual(value.claimed, { daily: false, bonus: false })
    assert.equal(value.reward, 0)
    assert.equal(value.total, 50)
    assert.equal(value.today.checked, true)
    assert.deepEqual(value.week, { checkinDays: 1, totalRewardPoints: 50, bonusAvailable: false })
    assert.equal(value.lastRun.ok, true)
    assert.equal(value.lastRun.alreadyChecked, true)
    assert.equal(calls.length, 1, '已签过时只查一次状态')
    // 结果已写进 store（面板历史记录）。
    const state = await store.read()
    assert.equal(state.history.length, 1)
    assert.equal(state.lastRun.ok, true)
  })

  it('今日可签 → 真签一次并返回奖励 / 周进度', async () => {
    const { impl, calls } = sequenceFetch([
      pendingInfo(),
      { code: 0, msg: 'ok', reward_received: 50, reward_total: 100, type: 1 },
    ])
    const { post } = await mount({ credentials: CONFIGURED, fetchImpl: impl })
    const { payload } = await post(ROUTE_CHECKIN_RUN, {})
    assert.equal(payload.ok, true)
    const value = payload.value
    assert.equal(value.checked, true)
    assert.equal(value.alreadyChecked, false)
    assert.deepEqual(value.claimed, { daily: true, bonus: false })
    assert.equal(value.reward, 50)
    assert.equal(value.total, 100)
    assert.equal(value.today.checked, true)
    assert.deepEqual(value.week, { checkinDays: 2, totalRewardPoints: 100, bonusAvailable: false })
    assert.equal(value.lastRun.reward, 50)
    assert.equal(calls.length, 2)
    assert.equal(calls[1].url, 'https://ima.qq.com/cgi-bin/daily_login_activity/check_in')
    assert.deepEqual(calls[1].body, { type: 1 })
  })

  it('凭据未配置 → ok:true + configured:false + error，且不写失败历史', async () => {
    const { impl, calls } = jsonFetch(activityInfo())
    const { post, store } = await mount({ fetchImpl: impl })
    const { payload } = await post(ROUTE_CHECKIN_RUN, {})
    assert.equal(payload.ok, true)
    assert.equal(payload.value.configured, false)
    assert.equal(payload.value.checked, false)
    assert.equal(payload.value.error.code, ERROR_CODES.notConfigured)
    assert.equal(calls.length, 0)
    const state = await store.read()
    assert.equal(state.lastRun, null, '未配置不该刷失败记录')
    assert.deepEqual(state.history, [])
  })

  it('真失败（check_in 返回 51）→ 失败信封 + lastRun.ok:false', async () => {
    const { impl } = sequenceFetch([
      pendingInfo(),
      { code: 51, msg: 'invalid params' },
    ])
    const { post, store } = await mount({ credentials: CONFIGURED, fetchImpl: impl })
    const { payload } = await post(ROUTE_CHECKIN_RUN, {})
    assert.equal(payload.ok, false)
    assert.equal(payload.error.code, ERROR_CODES.badRequest)
    assert.match(payload.error.message, /code 51/u)
    const state = await store.read()
    assert.equal(state.lastRun.ok, false)
    assert.match(state.lastRun.error, /code 51/u)
  })

  it('已签过时不会重复领奖（只发一次请求）', async () => {
    const { impl, calls } = jsonFetch(activityInfo())
    const { post } = await mount({ credentials: CONFIGURED, fetchImpl: impl })
    await post(ROUTE_CHECKIN_RUN, {})
    await post(ROUTE_CHECKIN_RUN, {})
    // 第二次仍是「查状态 → 已签过」，不会发 check_in。
    assert.equal(calls.length, 2)
    assert.equal(calls.some((call) => call.url.endsWith('/check_in')), false)
  })
})

// --------------------------------------------------------------------- config

describe('checkin/config', () => {
  it('关闭自动签到 → 落盘且清掉定时器', async () => {
    const { post, store, timers } = await mount({ fetchImpl: jsonFetch(activityInfo()).impl })
    assert.equal(timers.pending().length, 1, '启动时应已 arm')
    const { payload } = await post(ROUTE_CHECKIN_CONFIG, { enabled: false })
    await settle()
    assert.equal(payload.ok, true)
    assert.deepEqual(payload.value, { enabled: false, time: '09:00' })
    assert.deepEqual(await store.getConfig(), { enabled: false, time: '09:00' })
    assert.equal(timers.pending().length, 0, '关闭后不该再有定时器')
  })

  it('改时间 → 立即按新 HH:mm 重新 arm', async () => {
    const { post, timers } = await mount({ fetchImpl: jsonFetch(activityInfo()).impl })
    const { payload } = await post(ROUTE_CHECKIN_CONFIG, { time: '08:30' })
    await settle()
    assert.equal(payload.ok, true)
    assert.deepEqual(payload.value, { enabled: true, time: '08:30' })
    const pending = timers.pending()
    assert.equal(pending.length, 1)
    assert.equal(pending[0].ms, new Date(2026, 10, 6, 8, 30, 0).getTime() - NOW)
  })

  it('部分更新：只传 enabled 不动 time，反之亦然', async () => {
    const { post, store } = await mount({ fetchImpl: jsonFetch(activityInfo()).impl })
    await post(ROUTE_CHECKIN_CONFIG, { time: '07:15' })
    const { payload } = await post(ROUTE_CHECKIN_CONFIG, { enabled: false })
    assert.deepEqual(payload.value, { enabled: false, time: '07:15' })
    assert.deepEqual(await store.getConfig(), { enabled: false, time: '07:15' })
  })

  it('time 非法 → BAD_REQUEST + 契约文案，且不落盘', async () => {
    const { post, store } = await mount({ fetchImpl: jsonFetch(activityInfo()).impl })
    for (const time of ['9:00', '25:00', '09:60', '09:00:00', 900]) {
      const { payload } = await post(ROUTE_CHECKIN_CONFIG, { time })
      assert.equal(payload.ok, false)
      assert.equal(payload.error.code, ROUTE_ERROR_CODES.badRequest)
      assert.equal(payload.error.message, 'time 必须是 HH:mm')
    }
    assert.deepEqual(await store.getConfig(), { enabled: true, time: '09:00' })
  })

  it('enabled 非布尔 → BAD_REQUEST', async () => {
    const { post } = await mount({ fetchImpl: jsonFetch(activityInfo()).impl })
    const { payload } = await post(ROUTE_CHECKIN_CONFIG, { enabled: 'yes' })
    assert.equal(payload.ok, false)
    assert.equal(payload.error.code, ROUTE_ERROR_CODES.badRequest)
    assert.match(payload.error.message, /enabled 必须是布尔值/u)
  })

  it('空 body → 返回当前配置（幂等读取）', async () => {
    const { post } = await mount({ fetchImpl: jsonFetch(activityInfo()).impl })
    const { payload } = await post(ROUTE_CHECKIN_CONFIG, {})
    assert.equal(payload.ok, true)
    assert.deepEqual(payload.value, { enabled: true, time: '09:00' })
  })
})
