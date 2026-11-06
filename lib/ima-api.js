/**
 * ima-knowledge · IMA 协议层（纯 ESM，零第三方依赖）
 *
 * 端点 / 头 / body 严格对齐 SPEC.md §3（已在生产验证的部分不改）。
 * 设计约束：
 *  - 只依赖 Node 内置（node:crypto）与全局 fetch；
 *  - 所有网络/解析失败一律 throw，message 必含 `code` 与上游 `msg`，不吞错、不静默回退；
 *  - 纯函数（getBkn / parseCookie / buildCookie / headers / parseSse / classifyError）
 *    与 IO 函数（listKnowledgeBases / searchKnowledge / initSession / askQuestion /
 *    refreshToken）分开，前者可单测。
 *
 * @module ima-knowledge/ima-api
 */

import { randomBytes, randomUUID } from 'node:crypto'

/** IMA 站点根（SPEC §3）。 */
export const IMA_BASE_URL = 'https://ima.qq.com'

/**
 * 默认 referer。
 *
 * 注意：任务卡写的是 `https://ima.qq.com/wikis/content-type`，而冻结的 SPEC §3 与生产
 * 已验证的 dsh-ima-copilot 都用 `https://ima.qq.com/wikis`。默认取后者（低风险），
 * 需要时可通过 headers()/选项覆盖。
 */
export const DEFAULT_REFERER = 'https://ima.qq.com/wikis'

/** 列库（唯一可用面；get_knowledge_base_list 恒返回空，禁止使用）。 */
export const LIST_PATH = '/cgi-bin/knowledge_tab_reader/search_knowledge_base'
/** 原文检索。 */
export const SEARCH_PATH = '/cgi-bin/knowledge_tab_reader/search_knowledge'
/** 建会话。 */
export const INIT_SESSION_PATH = '/cgi-bin/session_logic/init_session'
/** 问答（SSE）。 */
export const QA_PATH = '/cgi-bin/assistant/qa'
/** token 刷新。 */
export const REFRESH_PATH = '/cgi-bin/auth_login/refresh'

/** cookie 里本插件关心的键。 */
const COOKIE_KEYS = ['IMA-TOKEN', 'IMA-REFRESH-TOKEN', 'IMA-UID', 'IMA-GUID']

/** 一次列库翻页的默认页大小（SPEC §3 给的是 50）。 */
const DEFAULT_PAGE_SIZE = 50
/** 翻页上限，防上游 cursor 不前进导致死循环。 */
const MAX_PAGES = 20

/**
 * IMA 协议错误。
 *
 * `code` 是上游业务码（可为 undefined，例如 HTTP 层失败），`kind` 来自 classifyError，
 * `message` 里一定同时带 code 与上游 msg，便于用户/模型定位。
 */
export class ImaApiError extends Error {
  /**
   * @param {string} message - 已格式化的错误信息（含 code 与上游 msg）。
   * @param {object} [detail] - 结构化细节。
   * @param {number} [detail.code] - 上游业务码。
   * @param {string} [detail.kind] - classifyError 的分类结果。
   * @param {number} [detail.status] - HTTP 状态码。
   * @param {string} [detail.operation] - 出错的操作名。
   */
  constructor(message, detail = {}) {
    super(message)
    this.name = 'ImaApiError'
    if (detail.code !== undefined) this.code = detail.code
    if (detail.kind !== undefined) this.kind = detail.kind
    if (detail.status !== undefined) this.status = detail.status
    if (detail.operation !== undefined) this.operation = detail.operation
  }
}

/** 上游 msg 里可能夹带 token/cookie，输出前脱敏并截断。 */
function safeServerMessage(message) {
  if (typeof message !== 'string') return undefined
  const cleaned = message
    .replace(/[\u0000-\u001f\u007f]+/gu, ' ')
    .replace(/\b(token|cookie|authorization)\s*[:=]\s*\S+/giu, '$1=[redacted]')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 300)
  return cleaned.length === 0 ? undefined : cleaned
}

/** 统一失败信息：`<prefix> (code <code>): <上游 msg>`；code 缺失时写 unknown。 */
function failureMessage(prefix, code, payload) {
  const msg = safeServerMessage(
    payload !== null && typeof payload === 'object'
      ? (typeof payload.msg === 'string' ? payload.msg : payload.message)
      : undefined,
  )
  return `${prefix} (code ${code === undefined || code === null ? 'unknown' : code})${msg === undefined ? '' : `: ${msg}`}`
}

/** 取号码字段（同时容忍 Code / code）。 */
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

/** 取字符串字段。 */
function stringField(value, ...keys) {
  for (const key of keys) {
    const candidate = value?.[key]
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
  }
  return undefined
}

/** 取第一个非空数组字段。 */
function arrayField(value, ...keys) {
  for (const key of keys) {
    const candidate = value?.[key]
    if (Array.isArray(candidate)) return candidate
  }
  return undefined
}

/**
 * 把可能来自 YAML 折行/剪贴板的凭据值规范化成合法的 HTTP header 值。
 *
 * 这里踩过两个**已在生产环境造成真实故障**的坑，处理顺序不能反：
 *
 * 1. **YAML 反斜杠续行**：YAML 双引号标量里 `\` + 换行表示「续行且不插入换行」，
 *    那个 `\` 本身必须被**吃掉**。若先把换行折叠成空格，`\` 就会留在 base64 中间，
 *    IMA 服务端报 `code 41 / illegal base64 data`（被伪装成「登录失败，请重新登录」，
 *    极难排查）。所以**第 2 步必须先把 `\`+换行整段删除，第 3 步才折叠剩余裸换行**。
 * 2. **裸换行 + 行首缩进**：YAML 折叠标量的原始字节含 `\n` 与 4 空格缩进，直接作为
 *    header 值会让 fetch 抛 `InvalidHeader: Invalid leading whitespace, reserved
 *    character(s), or return character(s) in header value`。
 *
 * 处理顺序（固定）：
 *  ① 去 BOM / 零宽字符 → ② 删除 `\`+换行（含其后的缩进）→ ③ 裸换行/制表折叠为空格
 *  → ④ 连续空白压成一个空格 → ⑤ trim。
 *
 * @param {string} value - 原始值。
 * @returns {string} 规范化后的单行值。
 */
export function normalizeHeaderValue(value) {
  if (typeof value !== 'string') return ''
  return value
    // ① BOM 与零宽字符
    .replace(/[\uFEFF\u200B-\u200D\u2060]/gu, '')
    // ② YAML 反斜杠续行：`\` + 换行 + 可能的缩进 → 整段删除（不能变成空格！）
    .replace(/\\[ \t]*\r?\n[ \t]*/gu, '')
    // ③ 剩余的裸换行 / 制表 / 其它空白折叠成单个空格
    .replace(/[\r\n\t\v\f]+/gu, ' ')
    // ④ 连续空白压成一个空格
    .replace(/\s{2,}/gu, ' ')
    // ⑤ 去首尾空白
    .trim()
}

/**
 * 计算 IMA 的 `x-ima-bkn`（SPEC §2：`getBkn(IMA-TOKEN)`）。
 *
 * **逐字复刻 IMA 官方前端的实现**（Lead 已核对官方桌面版扩展 bundle 里的
 * `const getBkn = (token) => {...}`）：
 *
 * ```js
 * let hash = 5381
 * for (let i = 0; i < token.length; i++) hash += (hash << 5) + token.charCodeAt(i)
 * return hash & 2147483647
 * ```
 *
 * 三点保真细节，改任何一处都会算出不同的 bkn：
 *  1. `hash << 5` 是 32 位按位运算 —— 每轮都会把累加器截成 int32，这本身提供了回绕；
 *  2. 按 **UTF-16 码元**（`charCodeAt`）遍历，不是码点（`codePointAt`）：非 BMP 字符
 *     会贡献两个码元，用 codePointAt 会少算一次；
 *  3. 返回**十进制字符串**（调用方要把它当 header 值）。
 *
 * 黄金锚点（生产真值，测试里做了交叉验证）：真实 176 字符 base64 token 算出 `5134245`，
 * 与 `.credentials.yaml` 里手工配置并被生产验证过的 `IMA_X_IMA_BKN` 完全一致。
 *
 * 遗留风险：宿主侧仍**优先使用 credential store 里的 IMA_X_IMA_BKN**，仅在缺失时回退到
 * 本函数 —— 让用户显式填写的值永远优先于推导值。
 *
 * @param {string} token - IMA-TOKEN 原文。
 * @returns {string} 十进制 bkn 字符串（非负、≤ 0x7fffffff）。
 */
export function getBkn(token) {
  if (typeof token !== 'string' || token.length === 0) {
    throw new TypeError('getBkn: token must be a non-empty string')
  }
  let hash = 5381
  for (let index = 0; index < token.length; index += 1) {
    hash += (hash << 5) + token.charCodeAt(index)
  }
  return String(hash & 2147483647)
}

/**
 * 解析 `x-ima-cookie` 头值，取本插件关心的四个键。
 * @param {string} cookie - 完整 cookie 头值（`a=1; b=2`）。
 * @returns {{token?: string, refresh?: string, uid?: string, guid?: string, values: Record<string, string>}}
 *   `token`/`refresh`/`uid`/`guid` 缺失时为 undefined；`values` 是全量键值（保持首次出现的值）。
 */
export function parseCookie(cookie) {
  if (typeof cookie !== 'string' || normalizeHeaderValue(cookie).length === 0) {
    throw new TypeError('parseCookie: cookie must be a non-empty string')
  }
  // 先折叠折行/缩进：生产上可能拿到 YAML 多行标量原文，未折叠时按 ';' 切分会把
  // 换行与 4 空格缩进留在键名上（`\n    IMA-TOKEN`），导致所有键都取不到。
  const normalized = normalizeHeaderValue(cookie)
  /** @type {Record<string, string>} */
  const values = {}
  for (const part of normalized.split(';')) {
    const trimmed = part.trim()
    if (trimmed.length === 0) continue
    const index = trimmed.indexOf('=')
    if (index <= 0) continue
    const key = trimmed.slice(0, index)
    if (Object.hasOwn(values, key)) continue
    values[key] = trimmed.slice(index + 1)
  }
  return {
    ...(values['IMA-TOKEN'] === undefined ? {} : { token: values['IMA-TOKEN'] }),
    ...(values['IMA-REFRESH-TOKEN'] === undefined ? {} : { refresh: values['IMA-REFRESH-TOKEN'] }),
    ...(values['IMA-UID'] === undefined ? {} : { uid: values['IMA-UID'] }),
    ...(values['IMA-GUID'] === undefined ? {} : { guid: values['IMA-GUID'] }),
    values,
  }
}

/**
 * 用结构化字段拼回 `x-ima-cookie` 头值（SPEC §2 的固定前缀 + UID-TYPE/TOKEN-TYPE）。
 *
 * 未提供的可选键会被跳过；`token` 必填（没有 token 的 cookie 不可用）。
 * @param {{uid?: string, token: string, refresh?: string, guid?: string}} input - 字段。
 * @returns {string} cookie 头值。
 */
export function buildCookie(input) {
  if (input === null || typeof input !== 'object') {
    throw new TypeError('buildCookie: expect { uid, token, refresh, guid }')
  }
  const { uid, token, refresh, guid } = input
  if (typeof token !== 'string' || token.trim().length === 0) {
    throw new TypeError('buildCookie: token must be a non-empty string')
  }
  /** @type {string[]} */
  const parts = ['PLATFORM=H5', 'CLIENT-TYPE=256053', 'WEB-VERSION=999.999.999']
  if (typeof uid === 'string' && uid.length > 0) parts.push(`IMA-UID=${uid}`)
  parts.push(`IMA-TOKEN=${token}`)
  if (typeof refresh === 'string' && refresh.length > 0) parts.push(`IMA-REFRESH-TOKEN=${refresh}`)
  if (typeof guid === 'string' && guid.length > 0) parts.push(`IMA-GUID=${guid}`)
  parts.push('UID-TYPE=2', 'TOKEN-TYPE=14')
  return parts.join('; ')
}

/**
 * 替换 cookie 里的某个键（不存在则追加到末尾）。
 * @param {string} cookie - 原 cookie。
 * @param {string} key - 键名。
 * @param {string} value - 新值。
 * @returns {string} 新 cookie。
 */
export function replaceCookieValue(cookie, key, value) {
  if (typeof cookie !== 'string' || normalizeHeaderValue(cookie).length === 0) {
    throw new TypeError('replaceCookieValue: cookie must be a non-empty string')
  }
  const parts = normalizeHeaderValue(cookie).split(';').map((part) => part.trim()).filter(Boolean)
  const index = parts.findIndex((part) => part.startsWith(`${key}=`))
  if (index >= 0) parts[index] = `${key}=${value}`
  else parts.push(`${key}=${value}`)
  return parts.join('; ')
}

/** 从 cookie 里取一个键（不存在返回 undefined）。 */
function cookieValue(cookie, key) {
  if (typeof cookie !== 'string') return undefined
  for (const part of cookie.split(';')) {
    const trimmed = part.trim()
    if (trimmed.startsWith(`${key}=`)) return trimmed.slice(key.length + 1)
  }
  return undefined
}

/**
 * 构造请求头（SPEC §3：全部 POST）。
 *
 * @param {string} cookie - `x-ima-cookie`。
 * @param {string} bkn - `x-ima-bkn`。
 * @param {string} [token] - 提供时追加 `authorization: Bearer <token>`。
 * @param {{contentType?: string, accept?: string, referer?: string, userAgent?: string}} [options]
 *   - `contentType`：默认 `application/json`，SSE 用 `text/event-stream`；
 *   - `accept`：默认跟随 content-type；
 *   - `referer`：默认 {@link DEFAULT_REFERER}；
 *   - `userAgent`：默认取 cookie 里的 IMA-IUA，否则内置 UA。
 * @returns {Record<string, string>} 可直接作为 fetch headers 的普通对象。
 */
export function headers(cookie, bkn, token, options = {}) {
  if (typeof cookie !== 'string' || normalizeHeaderValue(cookie).length === 0) {
    throw new TypeError('headers: cookie must be a non-empty string')
  }
  if (typeof bkn !== 'string' || normalizeHeaderValue(bkn).length === 0) {
    throw new TypeError('headers: bkn must be a non-empty string')
  }
  // 生产实测：credential 里可能拿到 YAML 折行原文（含 \n + 缩进），不经规范化直接
  // 作为 header 值会让 fetch 抛 InvalidHeader。所有 header 值在这里统一过一遍。
  const safeCookie = normalizeHeaderValue(cookie)
  const safeBkn = normalizeHeaderValue(bkn)
  const contentType = options.contentType ?? 'application/json'
  const result = {
    accept: options.accept ?? (contentType === 'text/event-stream' ? '*/*' : 'application/json'),
    'accept-language': 'zh-CN,zh;q=0.9',
    'content-type': contentType,
    extension_version: '999.999.999',
    from_browser_ima: '1',
    referer: options.referer ?? DEFAULT_REFERER,
    'user-agent': options.userAgent ?? (normalizeHeaderValue(cookieValue(safeCookie, 'IMA-IUA') ?? '')
      || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/144.0.0.0 Safari/537.36'),
    'x-ima-bkn': safeBkn,
    'x-ima-cookie': safeCookie,
  }
  if (contentType === 'text/event-stream') result['cache-control'] = 'no-cache'
  if (typeof token === 'string' && normalizeHeaderValue(token).length > 0) {
    result.authorization = `Bearer ${normalizeHeaderValue(token)}`
  }
  return result
}

/**
 * 把凭据对象规整成 `{ cookie, bkn }`，并校验非空。
 *
 * 规范化是**必需**而非礼貌：生产实测 `IMA_X_IMA_COOKIE` 在 `.credentials.yaml` 里是
 * YAML 双引号折行标量（含 `\n` 与行首缩进），未折叠的原文作为 header 值会被 fetch 拒绝
 * （`InvalidHeader: Invalid leading whitespace, reserved character(s), or return
 * character(s) in header value`）。这里靠 {@link normalizeHeaderValue} 折叠成单行。
 *
 * @param {unknown} credentials - `{cookie,bkn}` 或兼容的 `{xImaCookie,xImaBkn}`。
 * @param {string} operation - 出错时写进 message 的操作名。
 * @returns {{cookie: string, bkn: string}} 规整后的凭据。
 */
export function normalizeCredentials(credentials, operation = 'IMA request') {
  if (credentials === null || typeof credentials !== 'object') {
    throw new ImaApiError(`${operation}: credentials must be an object { cookie, bkn }`, { operation })
  }
  const raw = /** @type {Record<string, unknown>} */ (credentials)
  const cookie = normalizeHeaderValue(typeof raw.cookie === 'string' ? raw.cookie : raw.xImaCookie)
  const bkn = normalizeHeaderValue(typeof raw.bkn === 'string' ? raw.bkn : raw.xImaBkn)
  if (cookie.length === 0) {
    throw new ImaApiError(`${operation}: x-ima-cookie is missing`, { operation })
  }
  if (bkn.length === 0) {
    throw new ImaApiError(`${operation}: x-ima-bkn is missing`, { operation })
  }
  return { cookie, bkn }
}

/**
 * 发一个 POST 并返回 Response（不做业务码判断）。
 * @param {string} path - 站点内绝对路径。
 * @param {object} init - fetch 参数。
 * @param {object} init.credentials - 凭据。
 * @param {unknown} init.body - 请求体（会被 JSON.stringify）。
 * @param {Record<string, string>} init.headers - 请求头。
 * @param {AbortSignal} [init.signal] - 取消信号。
 * @param {typeof fetch} [init.fetchImpl] - 测试注入。
 * @param {string} [init.operation] - 操作名（错误信息用）。
 * @param {string} [init.baseUrl] - 覆盖站点根。
 * @returns {Promise<Response>} 原始响应。
 */
async function post(path, init) {
  const operation = init.operation ?? path
  const fetchImpl = init.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') {
    throw new ImaApiError(`${operation}: global fetch is unavailable in this runtime`, { operation })
  }
  const url = `${init.baseUrl ?? IMA_BASE_URL}${path}`
  let response
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: init.headers,
      body: JSON.stringify(init.body),
      ...(init.signal === undefined ? {} : { signal: init.signal }),
    })
  } catch (error) {
    if (init.signal?.aborted) throw init.signal.reason
    throw new ImaApiError(`${operation}: network request failed: ${error instanceof Error ? error.message : String(error)}`, { operation })
  }
  if (!response.ok) {
    throw new ImaApiError(`${operation}: HTTP ${response.status} ${response.statusText}`.trim(), {
      operation,
      status: response.status,
    })
  }
  return response
}

/** 读 JSON body，失败时抛带操作名的 ImaApiError。 */
async function readJson(response, operation) {
  let value
  try {
    value = await response.json()
  } catch {
    throw new ImaApiError(`${operation}: response is not valid JSON`, { operation })
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ImaApiError(`${operation}: response is not a JSON object`, { operation })
  }
  return value
}

/**
 * 校验业务码：`code === 0` 通过；否则按 classifyError 分类抛 ImaApiError。
 * @param {Record<string, any>} payload - 上游 JSON。
 * @param {string} operation - 操作名。
 * @returns {Record<string, any>} 原 payload。
 */
function assertOk(payload, operation) {
  const code = numberField(payload, 'code', 'Code')
  if (code === 0) return payload
  const classified = classifyError(code, typeof payload.msg === 'string' ? payload.msg : payload.message)
  throw new ImaApiError(failureMessage(`${operation} failed`, code, payload), {
    operation,
    code,
    kind: classified.kind,
  })
}

/** 上游业务码 → 语义分类（SPEC §3 已知坑）。 */
/**
 * 把上游业务码分类成插件要做的动作。
 *
 * - `41` → 需刷新 token；
 * - `51` → 参数错误（鉴权已过）；
 * - `110031` → 会话彻底过期，需重新登录；
 * - `0` → 成功；
 * - 其它 → 普通错误。
 *
 * @param {number|undefined} code - 上游业务码。
 * @param {string} [msg] - 上游 msg（会脱敏后放进 message）。
 * @returns {{code: number|undefined, kind: 'ok'|'token-expired'|'bad-request'|'session-expired'|'error',
 *   needsRefresh: boolean, needsRelogin: boolean, retryable: boolean, message: string}}
 */
export function classifyError(code, msg) {
  const codeText = code === undefined || code === null ? 'unknown' : String(code)
  const message = safeServerMessage(msg)
  const suffix = message === undefined ? '' : `: ${message}`
  if (code === 0) {
    return { code, kind: 'ok', needsRefresh: false, needsRelogin: false, retryable: false, message: `code 0${suffix}` }
  }
  if (code === 41) {
    return {
      code,
      kind: 'token-expired',
      needsRefresh: true,
      needsRelogin: false,
      retryable: true,
      message: `code 41: IMA token expired, refresh required${suffix}`,
    }
  }
  if (code === 51) {
    return {
      code,
      kind: 'bad-request',
      needsRefresh: false,
      needsRelogin: false,
      retryable: false,
      message: `code 51: invalid request parameters (authentication passed)${suffix}`,
    }
  }
  if (code === 110031) {
    return {
      code,
      kind: 'session-expired',
      needsRefresh: false,
      needsRelogin: true,
      retryable: false,
      message: `code 110031: IMA session has expired, sign in again${suffix}`,
    }
  }
  return {
    code,
    kind: 'error',
    needsRefresh: false,
    needsRelogin: false,
    retryable: false,
    message: `code ${codeText}${suffix}`,
  }
}

/**
 * 从列库响应里挖出列表数组。
 *
 * **真机实测字段名是 `searched_knowledge_bases`（顶层）**，不是任何 `knowledge_base_list`
 * 之类的猜测名 —— 2026-10 生产账号实测 `search_knowledge_base` 返回形如：
 * ```
 * {"code":0,"msg":"ok","is_end":true,"next_cursor":"CgQIARgB...",
 *  "searched_knowledge_bases":[{"id":"001a9a...","name":"微信用户的知识库",...}]}
 * ```
 * 候选顺序把实测字段放第一位；其余候选仅作向前兼容的兜底（且不改变「取不到就抛错」的
 * 语义 —— 见调用方）。
 *
 * @param {Record<string, any>} payload - 上游 JSON。
 * @returns {{list: unknown[]|undefined, scope: any}} 列表与其所在作用域（翻页游标可能在同一层）。
 */
function pickKnowledgeBaseList(payload) {
  const scopes = [payload?.data, payload?.result, payload]
  for (const scope of scopes) {
    if (scope === null || typeof scope !== 'object') continue
    const list = arrayField(
      scope,
      'searched_knowledge_bases',
      'searchedKnowledgeBases',
      'knowledge_base_list',
      'knowledgeBaseList',
      'list',
      'items',
      'records',
    )
    if (list !== undefined) return { list, scope }
  }
  return { list: undefined, scope: payload?.data ?? payload }
}

/**
 * IMA 知识库的**归属分组**（PLATFORM.md §2.1 `group` 字段的唯一事实来源）。
 *
 * 判定依据来自真机实测 + 官方前端 bundle 交叉验证（不是猜的）：
 *
 * 1. 官方前端 `search_knowledge_base` 请求带 `supportTypes` 参数，取值是
 *    `[Mine, Shared, SubscribedPublish, SubscribedJoin]` 四类，服务端**按它过滤**；
 *    本机真机实测 `supportTypes=[1]` → 1 条（id == 本账号 IMA-UID）、
 *    `[3]` → 30 条、`[2]`/`[4]` → 0 条，而条目自带的 `type` 与之一一对应。
 *    即**条目上的 `type` 就是 supportTypes 的同一套枚举**，可直接用于分组。
 * 2. 官方分组标题表 `[{mine:个人知识库},{shared:共享知识库},{subscribed:订阅知识库}]`，
 *    其中 `SubscribedPublish` 与 `SubscribedJoin` 都归入 `subscribed`。
 *
 * 因此映射（type 数值 → 契约里的两档）：
 * - `1` (Mine)                → `personal`（自己创建的个人知识库）
 * - `2` (Shared)              → `joined`（共享知识库：别人建、我被拉进去）
 * - `3` (SubscribedPublish)   → `joined`（我发布的订阅知识库：我的内容但走订阅体系）
 * - `4` (SubscribedJoin)      → `joined`（我加入的订阅知识库）
 * - 其它 / 缺失 / 非数字      → **不给 group**（判定不出来就不猜，前端全部落「个人知识库」）
 */
const PERSONAL_KNOWLEDGE_BASE_TYPES = new Set([1])
const JOINED_KNOWLEDGE_BASE_TYPES = new Set([2, 3, 4])

/**
 * 把条目的 `type` 数值映射成契约分组。
 * @param {unknown} type - 条目上的 type 字段。
 * @returns {'personal'|'joined'|undefined} 分组；判定不出来返回 undefined。
 */
export function knowledgeBaseGroupOf(type) {
  const numeric = typeof type === 'number' ? type : (typeof type === 'string' && type.trim() !== '' ? Number(type) : NaN)
  if (!Number.isInteger(numeric)) return undefined
  if (PERSONAL_KNOWLEDGE_BASE_TYPES.has(numeric)) return 'personal'
  if (JOINED_KNOWLEDGE_BASE_TYPES.has(numeric)) return 'joined'
  return undefined
}

/**
 * 列库条目 → `{id, name, group?}`；无法识别的条目返回 undefined（不猜 id）。
 *
 * `group` 是**可选**字段：判定不出来就不出现在对象上（而不是给 null/''），
 * 这样消费方用 `'group' in kb` 或 `kb.group === undefined` 都能正确区分「没判定」。
 */
function knowledgeBaseOf(entry) {
  if (entry === null || typeof entry !== 'object') return undefined
  const id = stringField(entry, 'knowledge_base_id', 'knowledgeBaseId', 'kb_id', 'id')
  if (id === undefined) return undefined
  const name = stringField(entry, 'knowledge_base_name', 'knowledgeBaseName', 'name', 'title') ?? id
  const group = knowledgeBaseGroupOf(entry.type)
  return group === undefined ? { id, name } : { id, name, group }
}

/**
 * 列出账号可访问的全部知识库（唯一可用面：search_knowledge_base + 空 query 翻页）。
 *
 * @param {{cookie: string, bkn: string}} credentials - 凭据。
 * @param {{signal?: AbortSignal, fetchImpl?: typeof fetch, baseUrl?: string, pageSize?: number}} [options]
 * @returns {Promise<Array<{id: string, name: string}>>} 去重后的知识库列表。
 */
export async function listKnowledgeBases(credentials, options = {}) {
  const operation = 'IMA listKnowledgeBases'
  const creds = normalizeCredentials(credentials, operation)
  const pageSize = Number.isFinite(options.pageSize) && options.pageSize > 0
    ? Math.floor(options.pageSize)
    : DEFAULT_PAGE_SIZE
  // 严格照 SPEC §3 的头集合：search_knowledge_base 不带 authorization。
  const requestHeaders = headers(creds.cookie, creds.bkn, undefined, { contentType: 'application/json' })
  /** @type {Map<string, {id: string, name: string}>} */
  const found = new Map()
  let cursor = ''
  const seenCursors = new Set()
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const payload = assertOk(await readJson(await post(LIST_PATH, {
      operation,
      credentials: creds,
      headers: requestHeaders,
      body: { query: '', cursor, limit: pageSize },
      signal: options.signal,
      fetchImpl: options.fetchImpl,
      baseUrl: options.baseUrl,
    }), operation), operation)
    const { list, scope } = pickKnowledgeBaseList(payload)
    if (list === undefined) {
      throw new ImaApiError(failureMessage(`${operation} failed: unrecognized response shape`, numberField(payload, 'code', 'Code'), payload), {
        operation,
        code: numberField(payload, 'code', 'Code'),
      })
    }
    for (const entry of list) {
      const knowledgeBase = knowledgeBaseOf(entry)
      if (knowledgeBase === undefined) continue
      if (!found.has(knowledgeBase.id)) found.set(knowledgeBase.id, knowledgeBase)
    }
    const isEnd = scope?.is_end === true || scope?.has_more === false || scope?.isEnd === true
    const next = stringField(scope, 'next_cursor', 'nextCursor', 'cursor') ?? ''
    if (isEnd || next.length === 0 || next === cursor || seenCursors.has(next)) break
    seenCursors.add(cursor)
    cursor = next
  }
  return [...found.values()]
}

/**
 * 去掉检索结果里的高亮标记与实体。
 *
 * 真机实测 `highlight_content` / `highlight_title` 是 HTML 片段（`ASML<em>浸没</em><em>式</em>`），
 * 直接把标记透给模型会污染上下文，因此这里统一剥离 `<em>` 之类标签并还原常见实体。
 */
function stripHighlight(value) {
  if (typeof value !== 'string' || value.length === 0) return ''
  return value
    .replace(/<\/?[a-zA-Z][^>]*>/gu, '')
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&#39;/gu, "'")
    .replace(/&nbsp;/gu, ' ')
    .replace(/&amp;/gu, '&')
    .trim()
}

/**
 * 检索条目 → `{media_id, title, highlight}`。
 *
 * 真机实测（2026-11）结构：命中条目把文档元数据嵌在 `knowledge` 子对象里，
 * 标题与片段在高亮字段上：
 *
 * ```json
 * { "highlight_title": "<em>光刻</em>机行业深度研究报告",
 *   "highlight_content": "图表4 ASML<em>浸没</em><em>式</em>扫描",
 *   "knowledge": { "media_id": "pdf_...", "title": "光刻机行业深度研究报告", ... } }
 * ```
 *
 * 顶层扁平写法（旧载荷）仍然兼容，`knowledge` 只是优先来源。
 */
function searchItemOf(entry) {
  if (entry === null || typeof entry !== 'object') return undefined
  const nested = entry.knowledge !== null && typeof entry.knowledge === 'object' ? entry.knowledge : undefined
  const mediaId = stringField(entry, 'media_id', 'mediaId', 'id')
    ?? stringField(nested, 'media_id', 'mediaId', 'id')
  if (mediaId === undefined) return undefined
  const title = stripHighlight(
    stringField(entry, 'highlight_title', 'title', 'media_title', 'mediaTitle', 'name')
      ?? stringField(nested, 'title', 'name', 'media_title')
      ?? '',
  )
  // 真机实测命中片段的字段名是 `highlight_content`（不是 highlight / snippet）。
  const highlight = stripHighlight(
    stringField(
      entry,
      'highlight_content',
      'highlightContent',
      'highlight',
      'highlight_text',
      'snippet',
      'content',
    )
      ?? stringField(nested, 'abstract', 'introduction')
      ?? '',
  )
  return { media_id: mediaId, title, highlight }
}

/**
 * 在指定知识库做原文检索。
 *
 * @param {{cookie: string, bkn: string}} credentials - 凭据。
 * @param {{kbId: string, query: string, limit?: number, signal?: AbortSignal,
 *   fetchImpl?: typeof fetch, baseUrl?: string}} input - 检索参数。
 * @returns {Promise<Array<{media_id: string, title: string, highlight: string}>>} 命中条目。
 */
export async function searchKnowledge(credentials, input) {
  const operation = 'IMA searchKnowledge'
  if (input === null || typeof input !== 'object') {
    throw new ImaApiError(`${operation}: input must be { kbId, query }`, { operation })
  }
  const { kbId, query } = input
  if (typeof kbId !== 'string' || kbId.trim().length === 0) {
    throw new ImaApiError(`${operation}: knowledgeBaseId is required`, { operation })
  }
  if (typeof query !== 'string' || query.trim().length === 0) {
    throw new ImaApiError(`${operation}: query must be a non-empty string`, { operation })
  }
  const limit = Number.isFinite(input.limit) && input.limit > 0 ? Math.floor(input.limit) : 10
  const creds = normalizeCredentials(credentials, operation)
  const payload = assertOk(await readJson(await post(SEARCH_PATH, {
    operation,
    credentials: creds,
    headers: headers(creds.cookie, creds.bkn, undefined, { contentType: 'application/json' }),
    body: { query, knowledge_base_id: kbId, cursor: '', limit },
    signal: input.signal,
    fetchImpl: input.fetchImpl,
    baseUrl: input.baseUrl,
  }), operation), operation)
  const scopes = [payload?.data, payload?.result, payload]
  /** @type {unknown[]|undefined} */
  let list
  for (const scope of scopes) {
    if (scope === null || typeof scope !== 'object') continue
    // 真机实测（2026-11）：命中列表在顶层 `searched_knowledge_list`。
    // `info_list` 是旧版载荷，保留兜底；其余候选仅为向前兼容。
    list = arrayField(
      scope,
      'searched_knowledge_list',
      'searchedKnowledgeList',
      'info_list',
      'infoList',
      'list',
      'items',
      'media_list',
      'mediaList',
      'records',
      'results',
    )
    if (list !== undefined) break
  }
  if (list === undefined) {
    throw new ImaApiError(failureMessage(`${operation} failed: unrecognized response shape`, numberField(payload, 'code', 'Code'), payload), {
      operation,
      code: numberField(payload, 'code', 'Code'),
    })
  }
  const items = []
  for (const entry of list) {
    const item = searchItemOf(entry)
    if (item !== undefined) items.push(item)
    // 真机实测（2026-11）：上游**忽略** body 里的 limit，恒返回 100 条。
    // 工具声明的 limit 语义由这里兜底兑现，避免把上百条塞进模型上下文。
    if (items.length >= limit) break
  }
  return items
}

/**
 * 建会话（SPEC §3 init_session body，原样对齐）。
 *
 * @param {{cookie: string, bkn: string}} credentials - 凭据。
 * @param {string} kbId - 知识库 id。
 * @param {{signal?: AbortSignal, fetchImpl?: typeof fetch, baseUrl?: string}} [options] - 选项。
 * @returns {Promise<string>} `session_id`。
 */
export async function initSession(credentials, kbId, options = {}) {
  const operation = 'IMA initSession'
  if (typeof kbId !== 'string' || kbId.trim().length === 0) {
    throw new ImaApiError(`${operation}: knowledgeBaseId is required`, { operation })
  }
  const creds = normalizeCredentials(credentials, operation)
  const payload = assertOk(await readJson(await post(INIT_SESSION_PATH, {
    operation,
    credentials: creds,
    headers: headers(creds.cookie, creds.bkn, cookieValue(creds.cookie, 'IMA-TOKEN'), {
      contentType: 'application/json',
    }),
    body: {
      envInfo: { robotType: 5, interactType: 0 },
      relatedUrl: kbId,
      sceneType: 1,
      msgsLimit: 10,
      forbidAutoAddToHistoryList: false,
      knowledgeBaseInfoWithFolder: { knowledgeBaseId: kbId, folderIds: [] },
    },
    signal: options.signal,
    fetchImpl: options.fetchImpl,
    baseUrl: options.baseUrl,
  }), operation), operation)
  const sessionId = stringField(payload, 'session_id', 'sessionId')
  if (sessionId === undefined) {
    throw new ImaApiError(failureMessage(`${operation} failed: no session_id in response`, numberField(payload, 'code', 'Code'), payload), {
      operation,
      code: numberField(payload, 'code', 'Code'),
    })
  }
  return sessionId
}

/** 消费一行 SSE。 */
function consumeSseLine(line, state) {
  const trimmed = line.trim()
  if (trimmed.length === 0) return
  if (trimmed.startsWith(':') || trimmed.startsWith('event:') || trimmed.startsWith('id:')) return
  if (trimmed.startsWith('retry:')) return
  const data = trimmed.startsWith('data:') ? trimmed.slice(5).trimStart() : trimmed
  if (data.length === 0 || data === '[DONE]') return
  let payload
  try {
    payload = JSON.parse(data)
  } catch {
    return
  }
  consumeSsePayload(payload, state)
}

/** 追加正文（兼容「整段重发」与「增量」两种上游行为）。 */
function appendAnswer(state, text) {
  if (typeof text !== 'string' || text.length === 0) return
  if (text.startsWith(state.text)) state.text = text
  else if (!state.text.endsWith(text)) state.text += text
}

/** 从 media 结构里抽出引用 `{id,title,knowledgeBase}`。 */
function referenceOf(value) {
  if (value === null || typeof value !== 'object') return undefined
  const id = stringField(value, 'id', 'media_id', 'mediaId')
  if (id === undefined) return undefined
  const title = stringField(value, 'title', 'media_title', 'mediaTitle', 'name') ?? id
  /** @type {{id: string, title: string, knowledgeBase?: string}} */
  const reference = { id, title }
  const kb = value.knowledge_base_info ?? value.knowledgeBaseInfo
  const kbName = kb !== null && typeof kb === 'object'
    ? stringField(kb, 'name', 'knowledge_base_name', 'knowledgeBaseName')
    : undefined
  if (kbName !== undefined) reference.knowledgeBase = kbName
  else {
    const flat = stringField(value, 'knowledgeBase', 'knowledge_base_name', 'knowledgeBaseName')
    if (flat !== undefined) reference.knowledgeBase = flat
  }
  return reference
}

/** 消费一条 SSE JSON 负载。 */
function consumeSsePayload(payload, state) {
  if (payload === null || typeof payload !== 'object') return
  const code = numberField(payload, 'code', 'Code')
  if (code !== undefined) state.codes.push(code)
  const blockType = stringField(payload, 'Type', 'type')
  const blockData = payload.Data ?? payload.data
  if (blockType === 'blockMessage' && blockData !== null && typeof blockData === 'object') {
    const textMessage = blockData.text_message ?? blockData.textMessage
    if (textMessage !== null && typeof textMessage === 'object') {
      appendAnswer(state, stringField(textMessage, 'Text', 'text'))
    }
  }
  // 真机实测（2026-11）：引用走 `Type: "referenceIndexes"` 事件，结构是
  // `Data.reference_indexes.indexes` 这个「序号 → 引用对象」的映射，
  // 正文里的 `[1](@index-ref?id=1)` 就指向它的 key。旧解析器不认这个事件，
  // 导致 references 恒为空。此外 `fileList` 事件携带同一批文件，作为兜底来源。
  if (blockType === 'referenceIndexes') {
    const referenceIndexes = blockData?.reference_indexes ?? blockData?.referenceIndexes
    const indexes = referenceIndexes?.indexes
    if (indexes !== null && typeof indexes === 'object') {
      for (const [key, value] of Object.entries(indexes)) {
        const reference = referenceIndexOf(value, key)
        if (reference !== undefined) state.references.push(reference)
      }
    }
  }
  if (blockType === 'fileList') {
    const fileList = blockData?.file_list ?? blockData?.fileList
    for (const file of Array.isArray(fileList?.files) ? fileList.files : []) {
      const reference = referenceOf(file)
      if (reference !== undefined) state.references.push(reference)
    }
  }
  for (const media of Array.isArray(payload.medias) ? payload.medias : []) {
    const reference = referenceOf(media)
    if (reference !== undefined) state.references.push(reference)
  }
  if (Array.isArray(payload.msgs)) for (const message of payload.msgs) consumeSseMessage(message, state)
  for (const candidate of [payload.content, payload.Text, payload.answer, payload.text]) {
    if (typeof candidate === 'string') appendAnswer(state, candidate)
  }
}

/**
 * `referenceIndexes.indexes[序号]` → 引用。
 *
 * 真机形状：`{title, content, source, kb_name, media_id, positions:[{pdf_position:{page_index}}]}`。
 * 标题自带 `1.` 这类序号前缀，这里剥掉；`kb_name` 常带 `@` 前缀，也一并去掉。
 */
function referenceIndexOf(value, fallbackId) {
  if (value === null || typeof value !== 'object') return undefined
  const mediaId = stringField(value, 'media_id', 'mediaId', 'id') ?? fallbackId
  if (mediaId === undefined) return undefined
  const rawTitle = stringField(value, 'title', 'media_title', 'mediaTitle', 'name')
  const title = rawTitle === undefined ? mediaId : rawTitle.replace(/^\s*\d+[.、]\s*/u, '').trim() || mediaId
  /** @type {{id: string, title: string, knowledgeBase?: string, content?: string, page?: number}} */
  const reference = { id: mediaId, title }
  const kbName = stringField(value, 'kb_name', 'kbName', 'knowledge_base_name', 'knowledgeBaseName')
  if (kbName !== undefined) reference.knowledgeBase = kbName.replace(/^@/u, '')
  const content = stringField(value, 'content', 'highlight_content', 'highlightContent')
  if (content !== undefined) reference.content = stripHighlight(content)
  const positions = Array.isArray(value.positions) ? value.positions : []
  for (const position of positions) {
    const pageIndex = position?.pdf_position?.page_index ?? position?.pdfPosition?.pageIndex
    if (Number.isFinite(pageIndex)) {
      // 上游是 0 基页号，转成读者可见的 1 基页码。
      reference.page = pageIndex + 1
      break
    }
  }
  return reference
}

/** 消费 `msgs[]` 里的正文与 context_refs。 */
function consumeSseMessage(message, state) {
  if (message === null || typeof message !== 'object') return
  const content = message.content
  if (typeof content === 'string') {
    appendAnswer(state, content)
    return
  }
  if (content === null || typeof content !== 'object') return
  const answer = content.answer ?? content.text
  if (typeof answer === 'string' && answer.length > 0) {
    try {
      const decoded = JSON.parse(answer)
      if (decoded !== null && typeof decoded === 'object' && typeof decoded.Text === 'string') {
        appendAnswer(state, decoded.Text)
      } else appendAnswer(state, answer)
    } catch {
      appendAnswer(state, answer)
    }
  }
  const contextRefs = content.context_refs ?? content.contextRefs
  if (typeof contextRefs !== 'string') return
  try {
    const decoded = JSON.parse(contextRefs)
    const medias = decoded !== null && typeof decoded === 'object' ? decoded.medias : undefined
    if (!Array.isArray(medias)) return
    for (const media of medias) {
      const reference = referenceOf(media)
      if (reference !== undefined) state.references.push(reference)
    }
  } catch {
    return
  }
}

/**
 * 引用去重（按 id，保持首次出现顺序）。
 *
 * 同一篇文档可能先后由 `fileList`（只有 id/title）和 `referenceIndexes`
 * （带 content / kb_name / 页码）报出来。这里按「信息量更大者胜」合并，
 * 否则先到的简版会把后面的详细版挡掉。
 */
function deduplicateReferences(references) {
  /** @type {Map<string, object>} */
  const byId = new Map()
  for (const reference of references) {
    const existing = byId.get(reference.id)
    if (existing === undefined) {
      byId.set(reference.id, reference)
      continue
    }
    for (const [key, value] of Object.entries(reference)) {
      if (value !== undefined && existing[key] === undefined) existing[key] = value
    }
  }
  return [...byId.values()]
}

/**
 * 解析 SSE（`text/event-stream`）。
 *
 * 接受整段字符串、ReadableStream（`response.body`）或任意字节/字符串 async iterable。
 * 提取正文 `text` 与引用 `references`（形如 `{id,title,knowledgeBase}`）。
 *
 * @param {string|ReadableStream|AsyncIterable<Uint8Array|string>|Response} input - SSE 源。
 * @returns {Promise<{text: string, references: Array<{id: string, title: string, knowledgeBase?: string, content?: string, page?: number}>, codes: number[]}>}
 */
export async function parseSse(input) {
  const state = { text: '', references: [], codes: [] }
  const buffer = { current: '' }
  const feed = (chunk) => {
    buffer.current += chunk
    const lines = buffer.current.split(/\r?\n/)
    buffer.current = lines.pop() ?? ''
    for (const line of lines) consumeSseLine(line, state)
  }
  if (typeof input === 'string') {
    feed(input)
  } else if (input !== null && typeof input === 'object' && typeof input.getReader === 'function') {
    const reader = input.getReader()
    const decoder = new TextDecoder()
    try {
      while (true) {
        const { done, value } = await reader.read()
        feed(decoder.decode(value, { stream: !done }))
        if (done) break
      }
    } finally {
      try {
        reader.releaseLock()
      } catch {
        // releaseLock 在已 release 的 reader 上会抛；此处不影响结果。
      }
    }
  } else if (input !== null && typeof input === 'object' && typeof input[Symbol.asyncIterator] === 'function') {
    const decoder = new TextDecoder()
    for await (const chunk of input) {
      feed(typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true }))
    }
  } else if (input instanceof Response) {
    return parseSse(await input.text())
  } else {
    throw new TypeError('parseSse: expect a string, a ReadableStream, an async iterable, or a Response')
  }
  if (buffer.current.length > 0) consumeSseLine(buffer.current, state)
  return {
    text: state.text,
    references: deduplicateReferences(state.references),
    codes: [...new Set(state.codes)],
  }
}

/**
 * 问答：建会话 + 提问，解析 SSE 取正文与引用。
 *
 * @param {{cookie: string, bkn: string}} credentials - 凭据。
 * @param {{kbId: string, question: string, signal?: AbortSignal, fetchImpl?: typeof fetch,
 *   baseUrl?: string, sessionId?: string}} input - 参数；给了 `sessionId` 时复用，不再建会话。
 * @returns {Promise<{answer: string, references: Array<{id: string, title: string, knowledgeBase?: string}>}>}
 */
export async function askQuestion(credentials, input) {
  const operation = 'IMA askQuestion'
  if (input === null || typeof input !== 'object') {
    throw new ImaApiError(`${operation}: input must be { kbId, question }`, { operation })
  }
  const { kbId, question } = input
  if (typeof kbId !== 'string' || kbId.trim().length === 0) {
    throw new ImaApiError(`${operation}: knowledgeBaseId is required`, { operation })
  }
  if (typeof question !== 'string' || question.trim().length === 0) {
    throw new ImaApiError(`${operation}: question must be a non-empty string`, { operation })
  }
  const creds = normalizeCredentials(credentials, operation)
  const guid = cookieValue(creds.cookie, 'IMA-GUID') ?? 'default_guid'
  const sessionId = typeof input.sessionId === 'string' && input.sessionId.length > 0
    ? input.sessionId
    : await initSession(creds, kbId, optionsOf(input))
  const requestHeaders = headers(creds.cookie, creds.bkn, cookieValue(creds.cookie, 'IMA-TOKEN'), {
    contentType: 'text/event-stream',
  })
  const response = await post(QA_PATH, {
    operation,
    credentials: creds,
    headers: requestHeaders,
    body: {
      session_id: sessionId,
      robot_type: 5,
      question,
      question_type: 2,
      client_id: randomUUID(),
      command_info: {
        type: 14,
        knowledge_qa_info: { tags: [], knowledge_ids: [], media_id_infos: [] },
      },
      model_info: { model_type: 4, enable_enhancement: false },
      history_info: {},
      device_info: {
        uskey: randomBytes(32).toString('base64'),
        uskey_bus_infos_input: `${guid}_${Math.floor(Date.now() / 1000)}`,
      },
      client_tools: [],
    },
    signal: input.signal,
    fetchImpl: input.fetchImpl,
    baseUrl: input.baseUrl,
  })
  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.includes('text/event-stream')) {
    const payload = await readJson(response, operation)
    assertOk(payload, operation)
    throw new ImaApiError(failureMessage(`${operation} failed: response is not an event stream`, numberField(payload, 'code', 'Code'), payload), {
      operation,
      code: numberField(payload, 'code', 'Code'),
    })
  }
  const parsed = await parseSse(response)
  if (parsed.text.trim().length === 0) {
    const code = parsed.codes.length > 0 ? parsed.codes[0] : undefined
    throw new ImaApiError(failureMessage(`${operation} failed: empty answer`, code, undefined), { operation, code })
  }
  return { answer: parsed.text.trim(), references: parsed.references }
}

/** 从输入里挑出 IO 选项。 */
function optionsOf(input) {
  return {
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
    ...(input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl }),
  }
}

/**
 * 刷新 token（SPEC §3：body `{user_id, refresh_token, token_type:14}`）。
 *
 * **续期元数据（2026-11-01 真机实测）**：上游响应形如
 * `{code:0, msg:"ok", token:"…", token_valid_time:"7200", user_id:"…"}`——
 * `token_valid_time` 是**相对秒数（TTL=7200）**，不是绝对时间戳。把它原样暴露成
 * `tokenTtlSeconds`，宿主才能算出「下一次该在什么时候续期」，而不是等请求撞 41。
 *
 * **refresh token 轮换**：实测当前**不轮换**（续期前后 refresh_token 不变），所以
 * 绝大多数情况下 `refreshToken` 字段不出现。但上游一旦开始下发新的 `refresh_token`，
 * 必须把它写回 cookie —— 否则旧 refresh token 失效后整条链就断了。这里做防御性支持：
 * 响应里有 `refresh_token` 就替换进 cookie，并作为 `refreshToken` 返回。
 *
 * @param {{cookie: string, bkn?: string}} credentials - 至少要有 cookie（含 IMA-UID / IMA-REFRESH-TOKEN）。
 * @param {{signal?: AbortSignal, fetchImpl?: typeof fetch, baseUrl?: string}} [options] - 选项。
 * @returns {Promise<{token: string, cookie: string, bkn: string, tokenTtlSeconds?: number, refreshToken?: string}>}
 *   新 token、重写 IMA-TOKEN（以及轮换后的 refresh token）的 cookie、按新 token 推导的 bkn，
 *   以及可选的 TTL / 新 refresh token。
 */
export async function refreshToken(credentials, options = {}) {
  const operation = 'IMA refreshToken'
  if (credentials === null || typeof credentials !== 'object') {
    throw new ImaApiError(`${operation}: credentials must be an object { cookie }`, { operation })
  }
  const rawCookie = typeof credentials.cookie === 'string' ? credentials.cookie : credentials.xImaCookie
  if (typeof rawCookie !== 'string' || rawCookie.trim().length === 0) {
    throw new ImaApiError(`${operation}: x-ima-cookie is missing`, { operation })
  }
  const cookie = normalizeHeaderValue(rawCookie)
  const userId = cookieValue(cookie, 'IMA-UID')
  const refresh = cookieValue(cookie, 'IMA-REFRESH-TOKEN')
  if (userId === undefined || refresh === undefined) {
    throw new ImaApiError(`${operation}: cookie is missing IMA-UID or IMA-REFRESH-TOKEN`, { operation })
  }
  const bkn = typeof credentials.bkn === 'string' && credentials.bkn.length > 0
    ? credentials.bkn
    : getBkn(cookieValue(cookie, 'IMA-TOKEN') ?? '')
  const payload = assertOk(await readJson(await post(REFRESH_PATH, {
    operation,
    credentials: { cookie, bkn },
    headers: headers(cookie, bkn, cookieValue(cookie, 'IMA-TOKEN'), { contentType: 'application/json' }),
    body: { user_id: userId, refresh_token: refresh, token_type: 14 },
    signal: options.signal,
    fetchImpl: options.fetchImpl,
    baseUrl: options.baseUrl,
  }), operation), operation)
  const token = stringField(payload, 'token', 'access_token', 'accessToken') ?? stringField(payload.data, 'token', 'access_token', 'accessToken')
  if (token === undefined) {
    throw new ImaApiError(failureMessage(`${operation} failed: no token in response`, numberField(payload, 'code', 'Code'), payload), {
      operation,
      code: numberField(payload, 'code', 'Code'),
    })
  }
  // TTL：真机是字符串 "7200"（秒）；同时容忍 expires_in 这类 OAuth 风格字段。
  const tokenTtlSeconds = numberField(payload, 'token_valid_time', 'expires_in', 'expiresIn')
    ?? numberField(payload.data, 'token_valid_time', 'expires_in', 'expiresIn')
  // 防御性：上游若开始轮换 refresh token，必须一并写回，否则续期链会断。
  const rotatedRefresh = stringField(payload, 'refresh_token', 'refreshToken')
    ?? stringField(payload.data, 'refresh_token', 'refreshToken')
  let nextCookie = replaceCookieValue(cookie, 'IMA-TOKEN', token)
  if (rotatedRefresh !== undefined) nextCookie = replaceCookieValue(nextCookie, 'IMA-REFRESH-TOKEN', rotatedRefresh)
  return {
    token,
    cookie: nextCookie,
    bkn: getBkn(token),
    ...(tokenTtlSeconds === undefined ? {} : { tokenTtlSeconds }),
    ...(rotatedRefresh === undefined ? {} : { refreshToken: rotatedRefresh }),
  }
}
