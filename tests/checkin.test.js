/**
 * lib/checkin.js 单测（CHECKIN.md §6.1）
 *
 * 覆盖：
 *  - 状态归一化（含 CHECKIN.md §1.1 的真机样例与各类畸形输入）；
 *  - `check_in` 成功 / 1002 幂等 / 1004 跳过 / 其它码抛错 / HTTP 403；
 *  - `runCheckin` 的组合逻辑（可签 / 已签 / 满签 / 领取失败 / 状态失败）；
 *  - 请求头与 body **逐字**（路径、referer、cookie、bkn、authorization、type）。
 *
 * 写法沿用 tests/api.test.js：node:test + 注入假 fetch，**不依赖真机网络**；
 * 期望值独立复算（不 import 被测实现来算期望）。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  ALREADY_CHECKED_CODE,
  BONUS_NOT_READY_CODE,
  CHECKIN_BASE_URL,
  CHECKIN_PATHS,
  CHECKIN_REFERER,
  CHECKIN_STATUS,
  CHECKIN_TYPE,
  DEFAULT_CHECKIN_TIMEOUT_MS,
  checkIn,
  getActivityRules,
  getCheckinStatus,
  normalizeActivityInfo,
  runCheckin,
} from '../lib/checkin.js'
import { ImaApiError } from '../lib/ima-api.js'

// --------------------------------------------------------------- 测试脚手架

/** 一个可用的 cookie / bkn 组合（token 在 cookie 里，bkn 是显式值）。 */
const COOKIE = 'PLATFORM=H5; IMA-UID=user-1; IMA-TOKEN=tok-abc; IMA-REFRESH-TOKEN=ref-xyz; IMA-GUID=guid-9'
const BKN = '193485963'
const CREDENTIALS = { cookie: COOKIE, bkn: BKN }

/**
 * CHECKIN.md §1.1 的真机响应（2026-11-06，周五，已签到后）逐字复刻。
 * @param {object} [overrides] - 覆盖字段。
 * @returns {object} 上游 JSON。
 */
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

/**
 * 按顺序回应的假 fetch，并记录每次请求（含解析后的 body）。
 * @param {object[]} payloads - 依次返回的 JSON 载荷（用尽后重复最后一个）。
 * @returns {{impl: typeof fetch, calls: object[]}} 假 fetch 与调用记录。
 */
function sequenceFetch(payloads) {
  const calls = []
  let index = 0
  const impl = async (url, init) => {
    calls.push({
      url: String(url),
      init,
      headers: init?.headers,
      body: init?.body === undefined ? undefined : JSON.parse(init.body),
    })
    const payload = payloads[Math.min(index, payloads.length - 1)]
    index += 1
    return Response.json(payload)
  }
  return { impl, calls }
}

/**
 * 只回固定 HTTP 状态（无 JSON body）的假 fetch。
 * @param {number} status - HTTP 状态码。
 * @returns {{impl: typeof fetch, calls: object[]}} 假 fetch 与调用记录。
 */
function statusFetch(status) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url: String(url), init })
    return new Response('denied', { status, statusText: 'Forbidden' })
  }
  return { impl, calls }
}

// ------------------------------------------------------------ 常量与路径

describe('checkin: 常量', () => {
  it('上游路径与契约逐字一致', () => {
    assert.deepEqual(CHECKIN_PATHS, {
      info: '/cgi-bin/daily_login_activity/get_activity_info',
      checkIn: '/cgi-bin/daily_login_activity/check_in',
      rules: '/cgi-bin/daily_login_activity/get_activity_rules',
      shareInfo: '/cgi-bin/daily_login_activity/get_share_info',
    })
    assert.equal(CHECKIN_BASE_URL, 'https://ima.qq.com')
    assert.equal(CHECKIN_REFERER, 'https://ima.qq.com/copilot-token-daily-checkin')
  })

  it('类型 / 状态 / 业务码 / 超时默认值', () => {
    assert.deepEqual(CHECKIN_TYPE, { daily: 1, weeklyBonus: 2 })
    assert.deepEqual(CHECKIN_STATUS, { expired: 1, received: 2, available: 3, locked: 4 })
    assert.equal(ALREADY_CHECKED_CODE, 1002)
    assert.equal(BONUS_NOT_READY_CODE, 1004)
    assert.equal(DEFAULT_CHECKIN_TIMEOUT_MS, 15000)
  })
})

// -------------------------------------------------------- normalizeActivityInfo

describe('normalizeActivityInfo', () => {
  it('把真机样例归一化成 today/bonus/days 三个视图', () => {
    const normalized = normalizeActivityInfo(activityInfo())
    assert.notEqual(normalized, null)
    assert.equal(normalized.checkinDays, 1)
    assert.equal(normalized.totalRewardPoints, 50)
    assert.deepEqual(normalized.today, {
      label: '今日',
      reward: '50算力',
      status: 2,
      checked: true,
      available: false,
    })
    assert.deepEqual(normalized.bonus, {
      status: 4,
      available: false,
      received: false,
      label: '满签奖励',
      reward: '额外随机奖励',
    })
    assert.equal(normalized.days.length, 7)
    assert.deepEqual(normalized.days.map((day) => day.label), ['周一', '周二', '周三', '周四', '今日', '周六', '周日'])
    assert.deepEqual(normalized.days.filter((day) => day.isToday).map((day) => day.label), ['今日'])
  })

  it('今日 status === 3 表示可签（checked:false / available:true）', () => {
    const payload = activityInfo()
    payload.infos[4] = { button: '签到', reward: '50算力', status: 3, top: '今日' }
    const normalized = normalizeActivityInfo(payload)
    assert.equal(normalized.today.checked, false)
    assert.equal(normalized.today.available, true)
    assert.equal(normalized.today.status, 3)
  })

  it('满签奖励 status === 3 表示可领', () => {
    const payload = activityInfo()
    payload.infos[7] = { button: '领取', reward: '额外随机奖励', status: 3, top: '满签奖励' }
    const normalized = normalizeActivityInfo(payload)
    assert.equal(normalized.bonus.available, true)
    assert.equal(normalized.bonus.received, false)
  })

  it('未知 status 数值不崩、也不误判为已签/可签', () => {
    const payload = activityInfo()
    payload.infos[4] = { reward: '50算力', status: 9, top: '今日' }
    const normalized = normalizeActivityInfo(payload)
    assert.equal(normalized.today.status, 9)
    assert.equal(normalized.today.checked, false)
    assert.equal(normalized.today.available, false)
  })

  it('数字字段容忍字符串写法（checkin_days / total_reward_points）', () => {
    const normalized = normalizeActivityInfo(activityInfo({ checkin_days: '3', total_reward_points: '150' }))
    assert.equal(normalized.checkinDays, 3)
    assert.equal(normalized.totalRewardPoints, 150)
  })

  it('缺 checkin_days / total_reward_points 时回落 0（不猜）', () => {
    const payload = activityInfo()
    delete payload.checkin_days
    delete payload.total_reward_points
    const normalized = normalizeActivityInfo(payload)
    assert.equal(normalized.checkinDays, 0)
    assert.equal(normalized.totalRewardPoints, 0)
  })

  it('形状不可识别一律返回 null 并给出人话原因', () => {
    const cases = [
      [null, '响应不是 JSON 对象'],
      [[], '响应不是 JSON 对象'],
      ['oops', '响应不是 JSON 对象'],
      [{}, '缺少 infos 数组'],
      [{ infos: 'nope' }, '缺少 infos 数组'],
    ]
    for (const [raw, reason] of cases) {
      const problems = []
      assert.equal(normalizeActivityInfo(raw, problems), null)
      assert.ok(problems.some((entry) => entry.includes(reason)), `应说明「${reason}」，实际 ${problems.join('；')}`)
    }
  })

  it('星期项不足 7 个 / 缺今日 / 缺满签奖励 / 项形状坏 → null', () => {
    const short = activityInfo()
    short.infos = short.infos.slice(0, 6)
    assert.equal(normalizeActivityInfo(short), null)

    const noToday = activityInfo()
    noToday.infos[4] = { reward: '50算力', status: 2, top: '周五' }
    assert.equal(normalizeActivityInfo(noToday), null)

    const noBonus = activityInfo()
    noBonus.infos = noBonus.infos.slice(0, 7)
    assert.equal(normalizeActivityInfo(noBonus), null)

    const brokenDay = activityInfo()
    brokenDay.infos[0] = null
    assert.equal(normalizeActivityInfo(brokenDay), null)

    const noStatus = activityInfo()
    delete noStatus.infos[1].status
    assert.equal(normalizeActivityInfo(noStatus), null)
  })
})

// ------------------------------------------------------------ getCheckinStatus

describe('getCheckinStatus', () => {
  it('请求路径 / 方法 / body / 头逐字对齐契约', async () => {
    const { impl, calls } = sequenceFetch([activityInfo()])
    const status = await getCheckinStatus(CREDENTIALS, { fetchImpl: impl })
    assert.notEqual(status, null)
    assert.equal(calls.length, 1)
    const [call] = calls
    assert.equal(call.url, `https://ima.qq.com${CHECKIN_PATHS.info}`)
    assert.equal(call.init.method, 'POST')
    assert.equal(call.init.body, '{}')
    assert.deepEqual(call.body, {})
    assert.equal(call.headers['content-type'], 'application/json')
    assert.equal(call.headers.accept, 'application/json')
    assert.equal(call.headers.referer, CHECKIN_REFERER)
    assert.equal(call.headers['x-ima-cookie'], COOKIE)
    assert.equal(call.headers['x-ima-bkn'], BKN)
    assert.equal(call.headers.authorization, 'Bearer tok-abc')
    assert.equal(call.headers.from_browser_ima, '1')
    assert.equal(call.headers.extension_version, '999.999.999')
  })

  it('cookie 里没有 IMA-TOKEN 时不带 authorization（不伪造）', async () => {
    const { impl, calls } = sequenceFetch([activityInfo()])
    await getCheckinStatus({ cookie: 'PLATFORM=H5; IMA-UID=user-1', bkn: BKN }, { fetchImpl: impl })
    assert.equal('authorization' in calls[0].headers, false)
  })

  it('业务码非 0 → 抛 ImaApiError（带 code / kind）', async () => {
    const { impl } = sequenceFetch([{ code: 41, msg: 'token expired' }])
    await assert.rejects(getCheckinStatus(CREDENTIALS, { fetchImpl: impl }), (error) => {
      assert.ok(error instanceof ImaApiError)
      assert.equal(error.code, 41)
      assert.equal(error.kind, 'token-expired')
      assert.match(error.message, /code 41/u)
      return true
    })
  })

  it('形状不可识别 → 抛 ImaApiError 且 message 带原因', async () => {
    const { impl } = sequenceFetch([{ code: 0, msg: 'ok' }])
    await assert.rejects(getCheckinStatus(CREDENTIALS, { fetchImpl: impl }), (error) => {
      assert.ok(error instanceof ImaApiError)
      assert.match(error.message, /形状不可识别/u)
      assert.match(error.message, /缺少 infos 数组/u)
      return true
    })
  })

  it('缺 bkn → 抛 ImaApiError，且不发请求', async () => {
    const { impl, calls } = sequenceFetch([activityInfo()])
    await assert.rejects(getCheckinStatus({ cookie: COOKIE }, { fetchImpl: impl }), (error) => {
      assert.ok(error instanceof ImaApiError)
      assert.match(error.message, /x-ima-bkn is missing/u)
      return true
    })
    assert.equal(calls.length, 0)
  })

  it('HTTP 500 → 抛 ImaApiError（带 status）', async () => {
    const { impl } = statusFetch(500)
    await assert.rejects(getCheckinStatus(CREDENTIALS, { fetchImpl: impl }), (error) => {
      assert.ok(error instanceof ImaApiError)
      assert.equal(error.status, 500)
      return true
    })
  })

  it('超时 → 抛 ImaApiError（默认 15s，可被 timeoutMs 覆盖）', async () => {
    const impl = (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason))
    })
    await assert.rejects(getCheckinStatus(CREDENTIALS, { fetchImpl: impl, timeoutMs: 5 }), (error) => {
      assert.ok(error instanceof ImaApiError)
      assert.match(error.message, /超时或已取消/u)
      return true
    })
  })
})

// -------------------------------------------------------------------- checkIn

describe('checkIn', () => {
  it('成功：body 是 {"type":1}，返回奖励与 total', async () => {
    const { impl, calls } = sequenceFetch([
      { banner: '好运正在路上', code: 0, msg: 'ok', reward_received: 50, reward_total: 50, type: 1 },
    ])
    const result = await checkIn(CREDENTIALS, CHECKIN_TYPE.daily, { fetchImpl: impl })
    assert.deepEqual(result, {
      code: 0,
      rewardReceived: 50,
      rewardTotal: 50,
      type: 1,
      alreadyChecked: false,
      bonusNotReady: false,
    })
    assert.equal(calls[0].url, `https://ima.qq.com${CHECKIN_PATHS.checkIn}`)
    assert.deepEqual(calls[0].body, { type: 1 })
  })

  it('type=2 时 body 是 {"type":2}', async () => {
    const { impl, calls } = sequenceFetch([
      { code: 0, msg: 'ok', reward_received: 66, reward_total: 116, type: 2 },
    ])
    const result = await checkIn(CREDENTIALS, CHECKIN_TYPE.weeklyBonus, { fetchImpl: impl })
    assert.deepEqual(calls[0].body, { type: 2 })
    assert.equal(result.rewardReceived, 66)
    assert.equal(result.type, 2)
  })

  it('1002（今天已签过）→ 幂等成功，不抛错', async () => {
    const { impl } = sequenceFetch([{ code: 1002, msg: 'today already checked in' }])
    const result = await checkIn(CREDENTIALS, CHECKIN_TYPE.daily, { fetchImpl: impl })
    assert.equal(result.code, 1002)
    assert.equal(result.alreadyChecked, true)
    assert.equal(result.bonusNotReady, false)
    assert.equal(result.rewardReceived, 0)
  })

  it('1004（满签未解锁）→ bonusNotReady，不抛错', async () => {
    const { impl } = sequenceFetch([{ code: 1004, msg: 'week not fully claimed, day3 unclaimed' }])
    const result = await checkIn(CREDENTIALS, CHECKIN_TYPE.weeklyBonus, { fetchImpl: impl })
    assert.equal(result.code, 1004)
    assert.equal(result.bonusNotReady, true)
    assert.equal(result.alreadyChecked, false)
  })

  it('其它非 0 码 → 抛 ImaApiError（按码分支，不看 HTTP 状态）', async () => {
    const { impl } = sequenceFetch([{ code: 51, msg: 'invalid params' }])
    await assert.rejects(checkIn(CREDENTIALS, CHECKIN_TYPE.daily, { fetchImpl: impl }), (error) => {
      assert.ok(error instanceof ImaApiError)
      assert.equal(error.code, 51)
      assert.equal(error.kind, 'bad-request')
      return true
    })
  })

  it('type 非法 → 抛错且不发请求（代码里只用 1/2）', async () => {
    const { impl, calls } = sequenceFetch([{ code: 0 }])
    await assert.rejects(checkIn(CREDENTIALS, 9, { fetchImpl: impl }), (error) => {
      assert.ok(error instanceof ImaApiError)
      assert.equal(error.kind, 'bad-request')
      assert.match(error.message, /type 必须是 1/u)
      return true
    })
    assert.equal(calls.length, 0)
  })

  it('HTTP 403（非法 type 的上游表现）→ 抛错', async () => {
    const { impl } = statusFetch(403)
    await assert.rejects(checkIn(CREDENTIALS, CHECKIN_TYPE.daily, { fetchImpl: impl }), (error) => {
      assert.ok(error instanceof ImaApiError)
      assert.equal(error.status, 403)
      return true
    })
  })
})

// ----------------------------------------------------------------- runCheckin

describe('runCheckin', () => {
  it('今日可签 → 领每日奖励，状态本地回填', async () => {
    const info = activityInfo({ checkin_days: 1, total_reward_points: 50 })
    info.infos[4] = { button: '签到', reward: '50算力', status: 3, top: '今日' }
    const { impl, calls } = sequenceFetch([
      info,
      { code: 0, msg: 'ok', reward_received: 50, reward_total: 100, type: 1 },
    ])
    const result = await runCheckin(CREDENTIALS, { fetchImpl: impl })
    assert.equal(calls.length, 2)
    assert.equal(calls[1].url, `https://ima.qq.com${CHECKIN_PATHS.checkIn}`)
    assert.equal(result.checked, true)
    assert.equal(result.alreadyChecked, false)
    assert.deepEqual(result.claimed, { daily: true, bonus: false })
    assert.equal(result.reward, 50)
    assert.equal(result.total, 100)
    assert.deepEqual(result.errors, [])
    assert.equal(result.status.today.checked, true)
    assert.equal(result.status.today.available, false)
    assert.equal(result.status.checkinDays, 2)
    assert.equal(result.status.totalRewardPoints, 100)
    assert.equal(result.status.days[4].status, CHECKIN_STATUS.received)
  })

  it('今日已签 → 不再请求 check_in，alreadyChecked:true', async () => {
    const { impl, calls } = sequenceFetch([activityInfo()])
    const result = await runCheckin(CREDENTIALS, { fetchImpl: impl })
    assert.equal(calls.length, 1)
    assert.equal(result.checked, true)
    assert.equal(result.alreadyChecked, true)
    assert.deepEqual(result.claimed, { daily: false, bonus: false })
    assert.equal(result.reward, 0)
    assert.equal(result.total, 50)
    assert.deepEqual(result.errors, [])
  })

  it('满签奖励可领 → 同时领周奖励', async () => {
    const info = activityInfo()
    info.infos[7] = { button: '领取', reward: '额外随机奖励', status: 3, top: '满签奖励' }
    const { impl, calls } = sequenceFetch([
      info,
      { code: 0, msg: 'ok', reward_received: 66, reward_total: 116, type: 2 },
    ])
    const result = await runCheckin(CREDENTIALS, { fetchImpl: impl })
    assert.equal(calls.length, 2)
    assert.deepEqual(calls[1].body, { type: 2 })
    assert.deepEqual(result.claimed, { daily: false, bonus: true })
    assert.equal(result.reward, 66)
    assert.equal(result.total, 116)
    assert.equal(result.status.bonus.received, true)
    assert.equal(result.status.bonus.available, false)
  })

  it('1004 满签未解锁 → 静默跳过，不算 errors', async () => {
    const info = activityInfo()
    info.infos[4] = { button: '签到', reward: '50算力', status: 3, top: '今日' }
    info.infos[7] = { button: '领取', reward: '额外随机奖励', status: 3, top: '满签奖励' }
    const { impl, calls } = sequenceFetch([
      info,
      { code: 0, msg: 'ok', reward_received: 50, reward_total: 100, type: 1 },
      { code: 1004, msg: 'week not fully claimed, day3 unclaimed' },
    ])
    const result = await runCheckin(CREDENTIALS, { fetchImpl: impl })
    assert.equal(calls.length, 3)
    assert.deepEqual(result.claimed, { daily: true, bonus: false })
    assert.deepEqual(result.errors, [])
    assert.equal(result.status.bonus.received, false)
  })

  it('领取失败 → 收进 errors（不中断），checked 保持 false', async () => {
    const info = activityInfo()
    info.infos[4] = { button: '签到', reward: '50算力', status: 3, top: '今日' }
    const { impl } = sequenceFetch([
      info,
      { code: 51, msg: 'invalid params' },
    ])
    const result = await runCheckin(CREDENTIALS, { fetchImpl: impl })
    assert.equal(result.checked, false)
    assert.deepEqual(result.claimed, { daily: false, bonus: false })
    assert.equal(result.errors.length, 1)
    assert.match(result.errors[0], /code 51/u)
  })

  it('查状态失败 → 直接抛错（没有状态无法判断该不该签）', async () => {
    const { impl } = sequenceFetch([{ code: 110031, msg: 'session expired' }])
    await assert.rejects(runCheckin(CREDENTIALS, { fetchImpl: impl }), (error) => {
      assert.ok(error instanceof ImaApiError)
      assert.equal(error.kind, 'session-expired')
      return true
    })
  })
})

// -------------------------------------------------------------- getActivityRules

describe('getActivityRules', () => {
  it('返回规则 HTML 字符串', async () => {
    const { impl, calls } = sequenceFetch([{ code: 0, msg: 'ok', rules: '<h3>规则</h3>' }])
    const result = await getActivityRules(CREDENTIALS, { fetchImpl: impl })
    assert.deepEqual(result, { rules: '<h3>规则</h3>' })
    assert.equal(calls[0].url, `https://ima.qq.com${CHECKIN_PATHS.rules}`)
    assert.deepEqual(calls[0].body, {})
  })

  it('业务码非 0 → 抛 ImaApiError', async () => {
    const { impl } = sequenceFetch([{ code: 41, msg: 'token expired' }])
    await assert.rejects(getActivityRules(CREDENTIALS, { fetchImpl: impl }), (error) => {
      assert.ok(error instanceof ImaApiError)
      assert.equal(error.code, 41)
      return true
    })
  })
})
