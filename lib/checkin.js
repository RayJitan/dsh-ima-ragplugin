/**
 * ima-knowledge · IMA「每日登录福利」签到协议层（纯 ESM，零第三方依赖）
 *
 * 契约来源：CHECKIN.md §1–§2。上游路径 / body / 业务码全部来自 **2026-11-06 真机实测**
 * （响应样例逐字保留在 CHECKIN.md §1），本文件只做「按码分支 + 形状归一化」，不发明字段。
 *
 * 设计约束（与 lib/ima-api.js 保持一致）：
 *  - 只依赖 Node 内置与全局 fetch；网络调用一律走注入的 `options.fetchImpl`（默认
 *    `globalThis.fetch`），便于单测完全离线；
 *  - 请求头**复用** `lib/ima-api.js` 的 `headers()`，错误**复用** `ImaApiError` 与
 *    `classifyError`，不另写一套 HTTP / 错误层；
 *  - 本模块**不做 token 刷新**：`credentials` 形状是 `{cookie, bkn}`，刷新由宿主层
 *    `withTokenRefresh` 包一层（CHECKIN.md §2 末段）。
 *
 * 幂等口径（CHECKIN.md §1.2，必须照此实现）：
 *  - `1002 today already checked in` → **视为成功**（`alreadyChecked:true`），不报错；
 *  - `1004 week not fully claimed`   → 满签奖励未解锁，**静默跳过**（`bonusNotReady:true`）；
 *  - 其它非 0 业务码 / HTTP 失败     → 抛 `ImaApiError`，message 带 code。
 *
 * @module ima-knowledge/checkin
 */

import {
  ImaApiError,
  classifyError,
  headers,
  normalizeCredentials,
  parseCookie,
} from './ima-api.js'

/** IMA 站点根（与 lib/ima-api.js 的 IMA_BASE_URL 同源；单独导出便于测试覆盖 baseUrl）。 */
export const CHECKIN_BASE_URL = 'https://ima.qq.com'

/** 签到相关上游路径（CHECKIN.md §1，已验证，勿改）。 */
export const CHECKIN_PATHS = {
  info: '/cgi-bin/daily_login_activity/get_activity_info',
  checkIn: '/cgi-bin/daily_login_activity/check_in',
  rules: '/cgi-bin/daily_login_activity/get_activity_rules',
  shareInfo: '/cgi-bin/daily_login_activity/get_share_info',
}

/**
 * 签到页 referer。
 *
 * CHECKIN.md §1 实测结论：referer 换成签到页不影响鉴权，但保持与官方页面一致更稳。
 */
export const CHECKIN_REFERER = 'https://ima.qq.com/copilot-token-daily-checkin'

/** 签到类型（body `{type}`）：1 = 每日签到，2 = 满签奖励。 */
export const CHECKIN_TYPE = { daily: 1, weeklyBonus: 2 }

/**
 * 活动格子状态枚举（官方前端 `checkin-*.js` 实测）：
 * 1 = Expired（已过期）、2 = Received（已领取）、3 = Available（可领取）、4 = Locked（未解锁）。
 */
export const CHECKIN_STATUS = { expired: 1, received: 2, available: 3, locked: 4 }

/** 今天已签过（幂等成功）。 */
export const ALREADY_CHECKED_CODE = 1002

/** 满签奖励未解锁（静默跳过）。 */
export const BONUS_NOT_READY_CODE = 1004

/** 网络超时默认值（CHECKIN.md §2：默认 15s，可被 `options.timeoutMs` 覆盖）。 */
export const DEFAULT_CHECKIN_TIMEOUT_MS = 15000

/** 第 8 项（周奖励）的 `top` 文案。 */
export const BONUS_LABEL = '满签奖励'

/** 「今天」那一格的 `top` 文案。 */
export const TODAY_LABEL = '今日'

/** 一周的天数（`infos` 前 7 项）。 */
const DAYS_PER_WEEK = 7

/**
 * 取号码字段（同时容忍 camelCase / snake_case）。
 * @param {unknown} value - 任意对象。
 * @param {...string} keys - 候选键。
 * @returns {number|undefined} 有限数字。
 */
function numberField(value, ...keys) {
  for (const key of keys) {
    const candidate = value?.[key]
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate
    if (typeof candidate === 'string' && candidate.trim() !== '' && Number.isFinite(Number(candidate))) {
      return Number(candidate)
    }
  }
  return undefined
}

/**
 * 取字符串字段（空串不算命中）。
 * @param {unknown} value - 任意对象。
 * @param {...string} keys - 候选键。
 * @returns {string|undefined} 非空字符串。
 */
function stringField(value, ...keys) {
  for (const key of keys) {
    const candidate = value?.[key]
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
  }
  return undefined
}

/**
 * 上游 msg → 可放进错误信息的一行文本（脱敏 + 截断）。
 * @param {unknown} payload - 上游 JSON。
 * @returns {string|undefined} 处理后的 msg。
 */
function safeMessage(payload) {
  const raw = typeof payload?.msg === 'string'
    ? payload.msg
    : (typeof payload?.message === 'string' ? payload.message : undefined)
  if (raw === undefined) return undefined
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f]+/gu, ' ')
    .replace(/\b(token|cookie|authorization)\s*[:=]\s*\S+/giu, '$1=[redacted]')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 300)
  return cleaned.length === 0 ? undefined : cleaned
}

/**
 * 把上游非 0 业务码变成 ImaApiError（code / kind 都带出去，宿主据此映射统一错误码）。
 * @param {unknown} payload - 上游 JSON。
 * @param {number|undefined} code - 上游业务码。
 * @param {string} operation - 操作名（错误信息用）。
 * @returns {ImaApiError} 错误对象。
 */
function upstreamError(payload, code, operation) {
  const classified = classifyError(code, safeMessage(payload))
  const message = safeMessage(payload)
  return new ImaApiError(
    `${operation} failed (code ${code === undefined || code === null ? 'unknown' : code})${message === undefined ? '' : `: ${message}`}`,
    { operation, code, kind: classified.kind },
  )
}

/**
 * 发一个 JSON POST 并返回解析后的对象（不做业务码判断）。
 *
 * 与 lib/ima-api.js 内部的 `post()` 行为对齐：HTTP 非 2xx、非 JSON、非对象一律抛
 * `ImaApiError`；超时走 `AbortSignal.timeout`（默认 15s）。
 *
 * @param {string} path - 站点内绝对路径。
 * @param {unknown} credentials - `{cookie, bkn}`。
 * @param {unknown} body - 请求体（会被 JSON.stringify）。
 * @param {object} [options] - 选项。
 * @param {typeof fetch} [options.fetchImpl] - 测试注入的 fetch。
 * @param {number} [options.timeoutMs] - 超时毫秒（默认 {@link DEFAULT_CHECKIN_TIMEOUT_MS}）。
 * @param {AbortSignal} [options.signal] - 外部取消信号（优先于 timeout）。
 * @param {string} [options.baseUrl] - 覆盖站点根。
 * @param {string} [options.operation] - 操作名。
 * @returns {Promise<Record<string, any>>} 上游 JSON 对象。
 */
async function postJson(path, credentials, body, options = {}) {
  const operation = options.operation ?? `IMA checkin ${path}`
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') {
    throw new ImaApiError(`${operation}: global fetch is unavailable in this runtime`, { operation })
  }
  const creds = normalizeCredentials(credentials, operation)
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? Math.floor(options.timeoutMs)
    : DEFAULT_CHECKIN_TIMEOUT_MS
  // 外部 signal 优先；否则用 AbortSignal.timeout 兜住「上游不响应」。
  const signal = options.signal ?? AbortSignal.timeout(timeoutMs)
  // token 从 cookie 里取：官方页面的签到请求带 authorization，这里保持一致；
  // cookie 里没有 IMA-TOKEN 时不带（headers() 会跳过）。
  const token = parseCookie(creds.cookie).token
  const requestHeaders = headers(creds.cookie, creds.bkn, token, {
    contentType: 'application/json',
    referer: CHECKIN_REFERER,
  })
  let response
  try {
    response = await fetchImpl(`${options.baseUrl ?? CHECKIN_BASE_URL}${path}`, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify(body),
      signal,
    })
  } catch (error) {
    if (signal.aborted) {
      throw new ImaApiError(`${operation}: 请求超时或已取消（${timeoutMs}ms）`, { operation, kind: 'timeout' })
    }
    throw new ImaApiError(
      `${operation}: network request failed: ${error instanceof Error ? error.message : String(error)}`,
      { operation },
    )
  }
  if (!response.ok) {
    throw new ImaApiError(`${operation}: HTTP ${response.status} ${response.statusText}`.trim(), {
      operation,
      status: response.status,
    })
  }
  let payload
  try {
    payload = await response.json()
  } catch {
    throw new ImaApiError(`${operation}: response is not valid JSON`, { operation })
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ImaApiError(`${operation}: response is not a JSON object`, { operation })
  }
  return payload
}

/**
 * 归一化 `get_activity_info` 的响应（CHECKIN.md §1.1 / §2）。
 *
 * 判定口径（照契约实现，不自己发明）：
 *  - `infos` 前 7 项是周一…周日；`top === '满签奖励'` 的那项是周奖励，**不是一天**；
 *  - 「今日是否已签到」= 7 天项里 `top === '今日'` 那项 `status === 2`；`status === 3` 表示可签；
 *  - 「满签奖励可领」= 周奖励项 `status === 3`。
 *
 * 形状不可识别时返回 `null`，并把**人话原因**追加到 `problems`（可选出参）——
 * 调用方据此抛带原因的 ImaApiError，而不是抛未捕获异常。
 *
 * @param {unknown} raw - 上游 JSON。
 * @param {string[]} [problems] - 可选出参：形状问题描述。
 * @returns {{checkinDays: number, totalRewardPoints: number,
 *   today: {label: string, reward: string, status: number, checked: boolean, available: boolean},
 *   bonus: {status: number, available: boolean, received: boolean, label: string, reward: string},
 *   days: Array<{label: string, reward: string, status: number, isToday: boolean}>} | null}
 *   归一化结果；形状不可识别时为 null。
 */
export function normalizeActivityInfo(raw, problems = []) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    problems.push('响应不是 JSON 对象')
    return null
  }
  const infos = raw.infos
  if (!Array.isArray(infos)) {
    problems.push('缺少 infos 数组')
    return null
  }
  // 周奖励项：优先按 top 文案定位；上游若只给 8 项而没写文案，退回第 8 项。
  const bonusRaw = infos.find((entry) => entry !== null && typeof entry === 'object' && entry.top === BONUS_LABEL)
    ?? infos[DAYS_PER_WEEK]
  const dayRaws = infos.filter((entry) => entry !== bonusRaw).slice(0, DAYS_PER_WEEK)
  if (dayRaws.length !== DAYS_PER_WEEK) {
    problems.push(`infos 里应有 ${DAYS_PER_WEEK} 个星期项，实际 ${dayRaws.length} 个`)
    return null
  }
  const days = []
  for (const entry of dayRaws) {
    if (entry === null || typeof entry !== 'object') {
      problems.push('星期项不是对象')
      return null
    }
    const label = stringField(entry, 'top', 'label')
    const status = numberField(entry, 'status')
    if (label === undefined || status === undefined) {
      problems.push('星期项缺少 top/status')
      return null
    }
    days.push({
      label,
      reward: stringField(entry, 'reward') ?? '',
      status,
      isToday: label === TODAY_LABEL,
    })
  }
  const today = days.find((day) => day.isToday)
  if (today === undefined) {
    problems.push(`7 个星期项里没有 top === '${TODAY_LABEL}' 的那项`)
    return null
  }
  if (bonusRaw === null || typeof bonusRaw !== 'object') {
    problems.push(`缺少「${BONUS_LABEL}」项`)
    return null
  }
  const bonusStatus = numberField(bonusRaw, 'status')
  if (bonusStatus === undefined) {
    problems.push(`「${BONUS_LABEL}」项缺少 status`)
    return null
  }
  return {
    checkinDays: numberField(raw, 'checkin_days', 'checkinDays') ?? 0,
    totalRewardPoints: numberField(raw, 'total_reward_points', 'totalRewardPoints') ?? 0,
    today: {
      label: today.label,
      reward: today.reward,
      status: today.status,
      checked: today.status === CHECKIN_STATUS.received,
      available: today.status === CHECKIN_STATUS.available,
    },
    bonus: {
      status: bonusStatus,
      available: bonusStatus === CHECKIN_STATUS.available,
      received: bonusStatus === CHECKIN_STATUS.received,
      label: stringField(bonusRaw, 'top', 'label') ?? BONUS_LABEL,
      reward: stringField(bonusRaw, 'reward') ?? '',
    },
    days,
  }
}

/**
 * 查活动状态（`get_activity_info`）。
 *
 * @param {{cookie: string, bkn: string}} credentials - 凭据（刷新由宿主层包）。
 * @param {object} [options] - 透传给 {@link postJson}（fetchImpl / timeoutMs / signal / baseUrl）。
 * @returns {Promise<NonNullable<ReturnType<typeof normalizeActivityInfo>>>} 归一化状态。
 * @throws {ImaApiError} 网络失败、业务码非 0、或形状不可识别。
 */
export async function getCheckinStatus(credentials, options = {}) {
  const operation = options.operation ?? 'IMA getCheckinStatus'
  const payload = await postJson(CHECKIN_PATHS.info, credentials, {}, { ...options, operation })
  const code = numberField(payload, 'code', 'Code')
  if (code !== 0) throw upstreamError(payload, code, operation)
  const problems = []
  const normalized = normalizeActivityInfo(payload, problems)
  if (normalized === null) {
    throw new ImaApiError(
      `${operation} failed: 上游活动状态形状不可识别（${problems.join('；')}）`,
      { operation, code },
    )
  }
  return normalized
}

/**
 * 原始签到（`check_in`）。
 *
 * @param {{cookie: string, bkn: string}} credentials - 凭据。
 * @param {1|2} type - 1 = 每日签到，2 = 满签奖励。
 * @param {object} [options] - 透传给 {@link postJson}。
 * @returns {Promise<{code: number, rewardReceived: number, rewardTotal: number, type: number,
 *   alreadyChecked: boolean, bonusNotReady: boolean}>} 签到结果（1002/1004 不抛错）。
 * @throws {ImaApiError} type 非法、HTTP 失败、或其它非 0 业务码。
 */
export async function checkIn(credentials, type, options = {}) {
  const operation = options.operation ?? 'IMA checkIn'
  if (type !== CHECKIN_TYPE.daily && type !== CHECKIN_TYPE.weeklyBonus) {
    throw new ImaApiError(`${operation}: type 必须是 1（每日签到）或 2（满签奖励）`, {
      operation,
      kind: 'bad-request',
    })
  }
  const payload = await postJson(CHECKIN_PATHS.checkIn, credentials, { type }, { ...options, operation })
  const code = numberField(payload, 'code', 'Code')
  const rewardReceived = numberField(payload, 'reward_received', 'rewardReceived') ?? 0
  const rewardTotal = numberField(payload, 'reward_total', 'rewardTotal') ?? 0
  const resultType = numberField(payload, 'type') ?? type
  if (code === 0) {
    return { code: 0, rewardReceived, rewardTotal, type: resultType, alreadyChecked: false, bonusNotReady: false }
  }
  if (code === ALREADY_CHECKED_CODE) {
    // 幂等：今天已经签过 = 成功，不产生第二次奖励。
    return { code, rewardReceived: 0, rewardTotal: 0, type, alreadyChecked: true, bonusNotReady: false }
  }
  if (code === BONUS_NOT_READY_CODE) {
    // 满签奖励未解锁：静默跳过，不算失败。
    return { code, rewardReceived: 0, rewardTotal: 0, type, alreadyChecked: false, bonusNotReady: true }
  }
  throw upstreamError(payload, code, operation)
}

/**
 * 查活动规则（`get_activity_rules`）。
 *
 * 契约只要求路径存在（CHECKIN.md §1.3），规则文案写进 UI 说明即可；这里返回原始 HTML
 * 字符串，不做渲染（不引入 HTML 解析依赖）。
 *
 * @param {{cookie: string, bkn: string}} credentials - 凭据。
 * @param {object} [options] - 透传给 {@link postJson}。
 * @returns {Promise<{rules: string}>} 规则 HTML。
 * @throws {ImaApiError} 网络失败或业务码非 0。
 */
export async function getActivityRules(credentials, options = {}) {
  const operation = options.operation ?? 'IMA getActivityRules'
  const payload = await postJson(CHECKIN_PATHS.rules, credentials, {}, { ...options, operation })
  const code = numberField(payload, 'code', 'Code')
  if (code !== 0) throw upstreamError(payload, code, operation)
  return { rules: stringField(payload, 'rules') ?? '' }
}

/**
 * 把本次领取结果回填进归一化状态（**本地合成**，不再多打一次上游）。
 *
 * 为什么不重新查一次状态：领取成功后若再查状态失败，会把「已经领到」的成功结果变成
 * 一次失败记录；面板下次打开时 `/checkin/status` 本来就会拿真实状态，这里只需保证
 * 返回值自洽。
 *
 * @param {NonNullable<ReturnType<typeof normalizeActivityInfo>>} status - 领取前状态。
 * @param {{claimed: {daily: boolean, bonus: boolean}, alreadyChecked: boolean, total: number}} update - 领取结果。
 * @returns {NonNullable<ReturnType<typeof normalizeActivityInfo>>} 领取后的状态。
 */
function applyClaimToStatus(status, update) {
  const { claimed, alreadyChecked, total } = update
  const todayReceived = claimed.daily || alreadyChecked || status.today.checked
  const today = {
    ...status.today,
    status: todayReceived ? CHECKIN_STATUS.received : status.today.status,
    checked: todayReceived,
    available: todayReceived ? false : status.today.available,
  }
  const days = status.days.map((day) => (
    day.isToday && (claimed.daily || alreadyChecked)
      ? { ...day, status: CHECKIN_STATUS.received }
      : day
  ))
  const bonus = claimed.bonus
    ? { ...status.bonus, status: CHECKIN_STATUS.received, received: true, available: false }
    : status.bonus
  return {
    ...status,
    checkinDays: claimed.daily ? Math.min(DAYS_PER_WEEK, status.checkinDays + 1) : status.checkinDays,
    totalRewardPoints: total,
    today,
    bonus,
    days,
  }
}

/**
 * 一轮完整签到（幂等）：
 *  1) 查状态；2) 今日 `status === 3` → `check_in(1)`；3) 满签 `status === 3` → `check_in(2)`。
 *
 * 「已签过 / 不可领」都不算 errors；其它领取失败进 `errors`（不中断后续步骤）。
 * 查状态失败直接抛错 —— 没有状态就无法判断该不该签。
 *
 * @param {{cookie: string, bkn: string}} credentials - 凭据。
 * @param {object} [options] - 透传给 {@link postJson}。
 * @returns {Promise<{checked: boolean, alreadyChecked: boolean,
 *   claimed: {daily: boolean, bonus: boolean}, reward: number, total: number,
 *   status: NonNullable<ReturnType<typeof normalizeActivityInfo>>, errors: string[]}>} 一轮结果。
 * @throws {ImaApiError} 查状态失败时。
 */
export async function runCheckin(credentials, options = {}) {
  const operation = options.operation ?? 'IMA runCheckin'
  const status = await getCheckinStatus(credentials, { ...options, operation: `${operation}:info` })
  const claimed = { daily: false, bonus: false }
  const errors = []
  let reward = 0
  let total = status.totalRewardPoints
  let alreadyChecked = status.today.checked
  let checked = status.today.checked

  if (status.today.available) {
    try {
      const result = await checkIn(credentials, CHECKIN_TYPE.daily, { ...options, operation: `${operation}:checkIn` })
      if (result.alreadyChecked) {
        // 与另一路客户端竞态：上游说今天已经签过 → 幂等成功。
        alreadyChecked = true
        checked = true
      } else {
        claimed.daily = true
        checked = true
        reward += result.rewardReceived
        if (result.rewardTotal > 0) total = result.rewardTotal
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error))
    }
  }

  if (status.bonus.available) {
    try {
      const result = await checkIn(credentials, CHECKIN_TYPE.weeklyBonus, { ...options, operation: `${operation}:checkInBonus` })
      if (result.bonusNotReady) {
        // 1004：满签奖励未解锁，静默跳过（契约要求不报错）。
      } else if (result.alreadyChecked) {
        // 周奖励的 1002 同样按幂等处理：不重复领，也不报错。
      } else {
        claimed.bonus = true
        reward += result.rewardReceived
        if (result.rewardTotal > 0) total = result.rewardTotal
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error))
    }
  }

  return {
    checked,
    alreadyChecked,
    claimed,
    reward,
    total,
    status: applyClaimToStatus(status, { claimed, alreadyChecked, total }),
    errors,
  }
}
