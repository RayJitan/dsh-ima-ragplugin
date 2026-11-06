/**
 * ima-knowledge · IMA 桌面客户端凭据读取（Windows / DPAPI 桥）
 *
 * 契约来源：PLATFORM.md §8（v2.1）。本模块只做**读取与解密**，不写任何凭据、
 * 不发起任何 IMA 网络请求 —— 校验与落盘由 `lib/host.js` 的 `desktop-sync` 路由负责。
 * 这样拆分的理由是单测可复现：CI 上没有真实的 IMA 桌面客户端，也没有 DPAPI，
 * 但「路径解析 / Preferences 解析 / 过期判定 / 解密失败语义」全都能用注入的假
 * 文件系统与假 DPAPI 覆盖。
 *
 * ## 真机实测链路（2026-11-01，Windows）
 *
 * ```
 * %LOCALAPPDATA%\ima.copilot\User Data\
 *   ├─ Local State                     os_crypt.encrypted_key（base64，前缀 "DPAPI"）
 *   │     base64 解码 → 剥掉前 5 字节 "DPAPI" → DPAPI(CurrentUser) → 32 字节 AES key
 *   └─ Default\Preferences
 *        tencent.wxlogin.account_secret_encrypted（base64）
 *          base64 解码 → DPAPI(CurrentUser) → JSON
 *          {"refresh_token":"…","refresh_token_valid_time":"…","token":"…","token_valid_time":"…"}
 *        tencent.wxlogin.account_meta（JSON 字符串）
 *          {is_login, user_id, token_valid_time, refresh_token_valid_time, user_info.open_info{…}}
 * ```
 *
 * **为什么本模块不碰 Local State 里那把 AES key**：`account_secret_encrypted` 是
 * 被 DPAPI **直接**包裹的（实测解密即得明文 JSON），并不经过 AES-256-GCM 那一层；
 * 那把 key 是 Chromium 给 cookie 库用的。多解一次 key 只会多一次 PowerShell 往返、
 * 多一个失败点，对同步没有任何收益。所以这里只把 `Local State` 当作「这确实是
 * IMA 桌面客户端数据目录」的形状佐证（存在性检查），不参与解密。
 *
 * ## 注入面（**测试专用**，生产走默认值）
 *
 * 每个导出函数都接受一个可选的 `options`，其中可覆盖：
 * `platform` / `localAppData` / `exists` / `readFile` / `unprotectDpapi` /
 * `runPowerShell` / `tmpdir` / `now` / `timeoutMs`。
 * 单测据此注入假文件系统与假 DPAPI，**不依赖本机真实 DPAPI**（CI 不可复现）。
 *
 * @module ima-knowledge/desktop-sync
 */

import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, promises as fsp, readFileSync } from 'node:fs'
import { tmpdir as osTmpdir } from 'node:os'
import { join } from 'node:path'

/** 非 Windows 平台的统一人话原因（PLATFORM.md §8.2 逐字要求）。 */
export const NON_WINDOWS_REASON = '仅支持 Windows 上的 IMA 桌面客户端'

/** 桌面客户端数据目录相对 `%LOCALAPPDATA%` 的两段。 */
export const CLIENT_DIR_PARTS = ['ima.copilot', 'User Data']

/** DPAPI 子进程超时（毫秒）。PowerShell 冷启动实测 ~0.5s，15s 足够宽。 */
export const DPAPI_TIMEOUT_MS = 15000

/**
 * DPAPI 解密脚本（**常量**，绝不拼接任何外部字符串）。
 *
 * 待解密的 blob 路径通过**环境变量** `IMA_DPAPI_BLOB` 传入：
 *  - 不走 argv：`powershell -Command "<script> <arg>"` 会把后续参数拼进脚本文本，
 *    路径里出现引号/分号就会变成命令注入；
 *  - 不走脚本插值：同理。
 * 用 `-EncodedCommand`（UTF-16LE base64）执行，脚本原文不经过任何 shell 解析。
 */
const DPAPI_SCRIPT = [
  'Add-Type -AssemblyName System.Security',
  '$path = $env:IMA_DPAPI_BLOB',
  'if ([string]::IsNullOrEmpty($path)) { [Console]::Error.WriteLine("IMA_DPAPI_BLOB is missing"); exit 3 }',
  '$bytes = [IO.File]::ReadAllBytes($path)',
  '$scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser',
  '$plain = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, $scope)',
  '[Convert]::ToBase64String($plain)',
].join('\n')

/** 默认依赖（生产值）。 */
const DEFAULTS = {
  platform: process.platform,
  exists: existsSync,
  readFile: (path) => readFileSync(path, 'utf8'),
  unprotectDpapi,
  runPowerShell,
  tmpdir: osTmpdir,
  now: Date.now,
  timeoutMs: DPAPI_TIMEOUT_MS,
}

/**
 * 把调用方传入的覆盖项合并成一份完整依赖。
 *
 * 幂等：把**已解析的依赖对象**再传一次也安全（`unprotectDpapi` 内部会这样做），
 * 因为每个键都按 `source.x ?? 默认值` 取。
 * @param {object|undefined} options - 覆盖项。
 * @returns {object} 完整依赖。
 */
function resolveDeps(options) {
  const source = options !== null && typeof options === 'object' ? options : {}
  return {
    platform: typeof source.platform === 'string' ? source.platform : DEFAULTS.platform,
    localAppData: typeof source.localAppData === 'string' && source.localAppData.length > 0
      ? source.localAppData
      : process.env.LOCALAPPDATA,
    exists: typeof source.exists === 'function' ? source.exists : DEFAULTS.exists,
    readFile: typeof source.readFile === 'function' ? source.readFile : DEFAULTS.readFile,
    unprotectDpapi: typeof source.unprotectDpapi === 'function' ? source.unprotectDpapi : DEFAULTS.unprotectDpapi,
    runPowerShell: typeof source.runPowerShell === 'function' ? source.runPowerShell : DEFAULTS.runPowerShell,
    tmpdir: typeof source.tmpdir === 'function' ? source.tmpdir : DEFAULTS.tmpdir,
    now: typeof source.now === 'function' ? source.now : DEFAULTS.now,
    timeoutMs: Number.isFinite(source.timeoutMs) && source.timeoutMs > 0 ? source.timeoutMs : DEFAULTS.timeoutMs,
  }
}

/** 错误 → 单行人话（截断，避免把超长 stderr 塞进响应）。 */
function messageOf(error) {
  const text = error instanceof Error ? error.message : String(error)
  return text.replace(/\s+/gu, ' ').trim().slice(0, 300)
}

/** 非空字符串字段，否则 undefined。 */
function stringOf(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

/**
 * epoch **秒**字段（数字或数字字符串）→ 数字；解析不出来返回 undefined（不猜）。
 *
 * 桌面客户端的 `account_secret` 里 `token_valid_time` / `refresh_token_valid_time`
 * 都是**字符串**形式的 epoch 秒（真机：`"1793549726"`）。宿主据此记录「下一次该
 * 什么时候续期」，所以这里必须严格：非正数、NaN 一律 undefined。
 * @param {unknown} value - 原始字段。
 * @returns {number|undefined} epoch 秒。
 */
function secondsOf(value) {
  const seconds = typeof value === 'number' ? value : (typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN)
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined
}

/**
 * epoch **秒**（字符串或数字）→ 是否已过期。
 * @param {unknown} value - `token_valid_time` / `refresh_token_valid_time`。
 * @param {number} nowMs - 当前毫秒时间戳。
 * @returns {boolean|undefined} 解析不出来返回 undefined（不猜）。
 */
function expiredAt(value, nowMs) {
  const seconds = typeof value === 'number' ? value : (typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN)
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined
  return seconds * 1000 <= nowMs
}

/**
 * 运行一段 PowerShell 脚本并返回 stdout。
 *
 * **安全**：`execFile` 传参数数组，全程不经过 shell；脚本用 `-EncodedCommand`
 * 传入，外部数据（如 blob 路径）只能走环境变量，绝不拼进脚本文本。
 *
 * @param {string} script - PowerShell 脚本原文。
 * @param {{exe?: string, env?: Record<string, string>, timeoutMs?: number}} [options] - 选项。
 * @returns {Promise<string>} stdout 原文。
 */
export function runPowerShell(script, options = {}) {
  if (typeof script !== 'string' || script.trim().length === 0) {
    return Promise.reject(new TypeError('runPowerShell: script 必须是非空字符串'))
  }
  const source = options !== null && typeof options === 'object' ? options : {}
  const exe = stringOf(source.exe) ?? 'powershell.exe'
  const timeout = Number.isFinite(source.timeoutMs) && source.timeoutMs > 0 ? source.timeoutMs : DPAPI_TIMEOUT_MS
  const args = [
    '-NoProfile',
    '-NonInteractive',
    '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64'),
  ]
  const env = { ...process.env, ...(source.env === null || typeof source.env !== 'object' ? {} : source.env) }
  return new Promise((resolve, reject) => {
    execFile(exe, args, { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8', env }, (error, stdout, stderr) => {
      if (error) {
        const detail = typeof stderr === 'string' && stderr.trim().length > 0 ? stderr.trim() : error.message
        reject(new Error(`PowerShell 调用失败：${messageOf(detail)}`))
        return
      }
      resolve(typeof stdout === 'string' ? stdout : String(stdout ?? ''))
    })
  })
}

/**
 * 用 DPAPI(CurrentUser) 解一个 base64 blob，返回**明文**字节。
 *
 * 调用方负责剥掉 `"DPAPI"` 前缀（Local State 的 `encrypted_key` 有，Preferences 里的
 * `account_secret_encrypted` 没有）。本函数只做 base64 → 字节 → DPAPI → 字节。
 *
 * @param {string} base64Blob - base64 编码的 DPAPI blob。
 * @param {object} [options] - 注入面（见模块头）。
 * @returns {Promise<Buffer>} 解密后的明文。
 */
export async function unprotectDpapi(base64Blob, options = {}) {
  const deps = resolveDeps(options)
  if (typeof base64Blob !== 'string' || base64Blob.trim().length === 0) {
    throw new TypeError('unprotectDpapi: base64 blob 必须是非空字符串')
  }
  if (deps.platform !== 'win32') throw new Error(`${NON_WINDOWS_REASON}（DPAPI 只在 Windows 上可用）`)
  const bytes = Buffer.from(base64Blob.trim(), 'base64')
  if (bytes.length === 0) throw new Error('unprotectDpapi: blob 不是合法的 base64')
  // blob 是**密文**，落临时文件是安全的；明文只在内存与 stdout 里出现，不落盘。
  const file = join(deps.tmpdir(), `ima-dpapi-${randomBytes(8).toString('hex')}.bin`)
  await fsp.writeFile(file, bytes, { mode: 0o600 })
  try {
    const stdout = await deps.runPowerShell(DPAPI_SCRIPT, {
      env: { IMA_DPAPI_BLOB: file },
      timeoutMs: deps.timeoutMs,
    })
    const plain = Buffer.from(String(stdout ?? '').trim(), 'base64')
    if (plain.length === 0) throw new Error('unprotectDpapi: DPAPI 解密结果为空')
    return plain
  } finally {
    await fsp.rm(file, { force: true }).catch(() => {})
  }
}

/**
 * 桌面客户端数据目录 `%LOCALAPPDATA%\ima.copilot\User Data`。
 * @param {object} [options] - 注入面（见模块头）。
 * @returns {string|undefined} 存在的目录路径；非 Windows 或不存在返回 undefined。
 */
export function desktopClientPath(options = {}) {
  const deps = resolveDeps(options)
  if (deps.platform !== 'win32') return undefined
  if (typeof deps.localAppData !== 'string' || deps.localAppData.trim().length === 0) return undefined
  const base = join(deps.localAppData, ...CLIENT_DIR_PARTS)
  try {
    return deps.exists(base) === true ? base : undefined
  } catch {
    return undefined
  }
}

/**
 * 读并解析 `Default\Preferences`。
 * @param {object} deps - 已解析依赖。
 * @param {string} base - 数据目录。
 * @returns {Record<string, any>} 解析后的 Preferences 对象。
 */
function readPreferences(deps, base) {
  const raw = deps.readFile(join(base, 'Default', 'Preferences'))
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new Error('Default\\Preferences 为空或不可读')
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('Default\\Preferences 不是合法 JSON')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Default\\Preferences 不是 JSON 对象')
  }
  return parsed
}

/**
 * 从 Preferences 里取 `tencent.wxlogin.account_meta`（它本身是 JSON **字符串**）。
 * @param {Record<string, any>} preferences - Preferences 对象。
 * @returns {Record<string, any>|undefined} 账号元信息；缺失或解析失败返回 undefined。
 */
function accountMetaOf(preferences) {
  const raw = preferences?.tencent?.wxlogin?.account_meta
  if (raw === null || raw === undefined) return undefined
  const parsed = typeof raw === 'string' ? tryJson(raw) : raw
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined
}

/** 宽松 JSON 解析：失败返回 undefined（用于「解析不出来就不猜」的分支）。 */
function tryJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * `open_info` → 契约里的 `account`。
 *
 * PLATFORM.md §8.2「`account` 直接取 `open_info`，字段缺失就不给（不伪造）」：
 * 这里逐键判断，缺的键**不出现**（不是 `undefined`、不是空串）。
 *
 * @param {Record<string, any>|undefined} meta - account_meta。
 * @returns {{uid: string, nickname?: string, guid?: string, openid?: string, type?: number, avatarUrl?: string}|undefined}}
 *   uid 取不到时返回 undefined（调用方据此报错，绝不编造）。
 */
function accountOfMeta(meta) {
  const openInfo = meta?.user_info?.open_info
  const source = openInfo !== null && typeof openInfo === 'object' ? openInfo : {}
  const uid = stringOf(source.uid) ?? stringOf(meta?.user_id)
  if (uid === undefined) return undefined
  /** @type {{uid: string, nickname?: string, guid?: string, openid?: string, type?: number, avatarUrl?: string}} */
  const account = { uid }
  const nickname = stringOf(source.nickname)
  if (nickname !== undefined) account.nickname = nickname
  const guid = stringOf(source.guid)
  if (guid !== undefined) account.guid = guid
  const openid = stringOf(source.openid)
  if (openid !== undefined) account.openid = openid
  const avatarUrl = stringOf(source.avatar_url)
  if (avatarUrl !== undefined) account.avatarUrl = avatarUrl
  const type = typeof source.type === 'number' && Number.isFinite(source.type) ? source.type : undefined
  if (type !== undefined) account.type = type
  return account
}

/**
 * 只读探测 IMA 桌面客户端：是否安装、是否登录、token / refresh token 是否过期。
 *
 * **只读不写、不抛错**（PLATFORM.md §8.2）：任何一步失败都折叠成
 * `{available:false|true, isLogin:false, reason}`，绝不向上抛。
 *
 * @param {object} [options] - 注入面（见模块头）。
 * @returns {Promise<{available: boolean, isLogin: boolean, userId?: string, nickname?: string,
 *   avatarUrl?: string, tokenExpired?: boolean, refreshExpired?: boolean, reason?: string}>} 探测结果。
 */
export async function probeDesktopClient(options = {}) {
  const deps = resolveDeps(options)
  if (deps.platform !== 'win32') {
    return { available: false, isLogin: false, reason: NON_WINDOWS_REASON }
  }
  const base = desktopClientPath(deps)
  if (base === undefined) {
    return {
      available: false,
      isLogin: false,
      reason: '未检测到 IMA 桌面客户端（%LOCALAPPDATA%\\ima.copilot\\User Data 不存在）',
    }
  }
  let meta
  try {
    meta = accountMetaOf(readPreferences(deps, base))
  } catch (error) {
    return {
      available: true,
      isLogin: false,
      reason: `IMA 桌面客户端已安装，但读取登录状态失败：${messageOf(error)}`,
    }
  }
  if (meta === undefined) {
    return {
      available: true,
      isLogin: false,
      reason: 'IMA 桌面客户端已安装，但没有登录信息（请先在客户端里登录）',
    }
  }
  const isLogin = meta.is_login === true
  const account = accountOfMeta(meta)
  const tokenExpired = expiredAt(meta.token_valid_time, deps.now())
  const refreshExpired = expiredAt(meta.refresh_token_valid_time, deps.now())
  /** @type {Record<string, any>} */
  const result = { available: true, isLogin }
  if (account !== undefined) {
    result.userId = account.uid
    if (account.nickname !== undefined) result.nickname = account.nickname
    if (account.avatarUrl !== undefined) result.avatarUrl = account.avatarUrl
  }
  if (tokenExpired !== undefined) result.tokenExpired = tokenExpired
  if (refreshExpired !== undefined) result.refreshExpired = refreshExpired
  if (!isLogin) {
    result.reason = 'IMA 桌面客户端已安装，但当前未登录（请先在客户端里登录）'
  } else if (refreshExpired === true) {
    result.reason = 'IMA 桌面客户端登录已过期（refresh token 失效），请在客户端重新登录后再同步'
  }
  return result
}

/**
 * 读取并解密桌面客户端里的 IMA 凭据。
 *
 * 解密失败**抛带原因的显式错误**（契约要求：不能静默返回 undefined 让上层瞎猜）。
 * 返回体里的 `token` / `refreshToken` 是**明文**，只允许在宿主内存里流转，
 * **绝不进响应体、绝不进日志**。
 *
 * @param {object} [options] - 注入面（见模块头）。
 * @returns {Promise<{token: string, refreshToken: string, userId: string,
 *   account: {uid: string, nickname?: string, guid?: string, openid?: string, type?: number, avatarUrl?: string},
 *   tokenValidTime?: number, refreshTokenValidTime?: number}>}
 *   凭据与账号身份；`tokenValidTime` / `refreshTokenValidTime` 是 epoch **秒**
 *   （宿主据此记录续期时间点，拿不到就不给这个键）。
 */
export async function readDesktopCredentials(options = {}) {
  const deps = resolveDeps(options)
  if (deps.platform !== 'win32') throw new Error(NON_WINDOWS_REASON)
  const base = desktopClientPath(deps)
  if (base === undefined) {
    throw new Error('未检测到 IMA 桌面客户端（%LOCALAPPDATA%\\ima.copilot\\User Data 不存在）')
  }
  let preferences
  try {
    preferences = readPreferences(deps, base)
  } catch (error) {
    throw new Error(`读取 Default\\Preferences 失败：${messageOf(error)}`)
  }
  const meta = accountMetaOf(preferences)
  const account = accountOfMeta(meta)
  if (account === undefined) {
    throw new Error('account_meta 里没有 user_id / open_info.uid，无法确定账号身份（请先在客户端登录）')
  }
  const encrypted = preferences?.tencent?.wxlogin?.account_secret_encrypted
  if (typeof encrypted !== 'string' || encrypted.trim().length === 0) {
    throw new Error(
      'Preferences 里没有 tencent.wxlogin.account_secret_encrypted：'
      + 'IMA 桌面客户端可能未登录，或版本不同（请在客户端里重新登录后重试）',
    )
  }
  let plain
  try {
    plain = await deps.unprotectDpapi(encrypted.trim(), deps)
  } catch (error) {
    throw new Error(`DPAPI 解密 account_secret_encrypted 失败：${messageOf(error)}`)
  }
  const secret = tryJson(Buffer.isBuffer(plain) ? plain.toString('utf8') : String(plain))
  if (secret === null || typeof secret !== 'object' || Array.isArray(secret)) {
    throw new Error('解密后的 account_secret 不是合法 JSON')
  }
  const token = stringOf(secret.token)
  const refreshToken = stringOf(secret.refresh_token)
  if (token === undefined || refreshToken === undefined) {
    // 只报「缺哪个键」，绝不把明文内容带进错误信息。
    const missing = [token === undefined ? 'token' : undefined, refreshToken === undefined ? 'refresh_token' : undefined]
      .filter(Boolean)
      .join(' / ')
    throw new Error(`解密后的 account_secret 缺少 ${missing}`)
  }
  const tokenValidTime = secondsOf(secret.token_valid_time)
  const refreshTokenValidTime = secondsOf(secret.refresh_token_valid_time)
  return {
    token,
    refreshToken,
    userId: account.uid,
    account,
    ...(tokenValidTime === undefined ? {} : { tokenValidTime }),
    ...(refreshTokenValidTime === undefined ? {} : { refreshTokenValidTime }),
  }
}
