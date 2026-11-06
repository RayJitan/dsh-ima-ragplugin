/**
 * ima-knowledge · DSH 宿主侧 Cordis 插件
 *
 * 形态：`export { name, inject, apply }`（与 dsh-ima-copilot 一致的宿主入口）。
 *
 * 用到的真实宿主 API（已在本机 DSH 源码 / 生产插件里核实，不是猜的）：
 *  - 工具注册：`ctx.tools.register(toolDefinition): () => void`
 *    源码：packages/core/tools/src/index.ts `class ToolRuntime { register(definition) }`
 *    toolDefinition 必须含 `{ name, description, parameters, output: { schema, render }, execute }`；
 *    `output` 缺失会直接抛 `must declare output { schema, render, presentationMeta? }`。
 *  - 凭据读：`ctx.credentials.resolve(ref): Promise<{value, source} | undefined>`
 *  - 凭据写：`ctx.credentials.set(ref, value): Promise<void>`
 *  - 凭据状态：`ctx.credentials.describe(ref): Promise<{configured, source?, writable}>`
 *    源码：packages/credentials/credentials/src/index.ts（CredentialProvider 抽象基类）
 *  - HTTP 路由：`ctx.get('connection').fetch.register({ path, methods, requestBody, fetch })`
 *    源码：packages/client/connection/src/rpc.ts `HostConnectionFetch.register`；
 *    路径必须以 `/api` 开头、methods 非空且不重复、requestBody 取 'buffered' | 'streaming'。
 *
 * 版本不确定性的退路：本文件不静态 import 任何宿主包，全部能力在 apply() 里做
 * **运行时能力探测**；任一能力缺失都抛出写明「缺什么 + 期望签名」的显式错误，
 * 而不是静默降级或半挂载。
 *
 * @module ima-knowledge/host
 */

import {
  ImaApiError,
  askQuestion,
  buildCookie,
  classifyError,
  getBkn,
  listKnowledgeBases,
  normalizeHeaderValue,
  parseCookie,
  refreshToken,
  searchKnowledge,
} from './ima-api.js'
import { getCheckinStatus, runCheckin } from './checkin.js'
import { createCheckinScheduler } from './checkin-scheduler.js'
import { createCheckinStore, formatLocalDate, isValidCheckinTime } from './checkin-store.js'
import { NON_WINDOWS_REASON, probeDesktopClient, readDesktopCredentials } from './desktop-sync.js'
import { createMemorySessionStore, createSessionStore, normalizeSelectedIds } from './session-store.js'

/** Cordis 插件名（宿主 loader 诊断用）。 */
export const name = 'ima-knowledge'

/** 宿主需要的服务。 */
export const inject = ['tools', 'credentials', 'connection']

/** 凭据 ref，与 dsh-ima-copilot 共用（SPEC §2）。 */
export const IMA_X_IMA_COOKIE_REF = 'IMA_X_IMA_COOKIE'
export const IMA_X_IMA_BKN_REF = 'IMA_X_IMA_BKN'
export const IMA_KNOWLEDGE_BASE_IDS_REF = 'IMA_KNOWLEDGE_BASE_IDS'
/**
 * IMA access token 的到期时间（epoch **毫秒** 的十进制字符串）。
 *
 * 为什么单独存一个 ref：IMA 的 access token 只有 **7200 秒（2 小时）** 寿命
 * （2026-11-01 真机实测 refresh 响应 `token_valid_time:"7200"`），而 refresh token
 * 有约 **337 天**。不记到期时间就只能「等请求撞 41 再续期」——面板每次打开都恰好
 * 看到过期，用户于是以为必须重新同步。记下来之后，请求前就能主动续期。
 *
 * 语义：**缺失 = 未知**（例如用户手填 cookie），此时退回「撞 41 再续期」的老路径。
 */
export const IMA_X_IMA_TOKEN_EXPIRES_AT_REF = 'IMA_X_IMA_TOKEN_EXPIRES_AT'

/**
 * 检索条数设置（v5）：`ima_kb_search` **未显式传 `limit`** 时，从知识库返回的条数。
 *
 * 为什么放在 credential store 而不是新增配置服务：本插件唯一的持久化面就是
 * credential store（选中集 `IMA_KNOWLEDGE_BASE_IDS` 也在这里），复用它可以
 * 零新增宿主能力、跨重启生效，且与 `dsh-ima-copilot` 的共存方式一致。
 * 值本身不是秘密，但 provider 对 ref 一视同仁（可写即可）。
 *
 * 语义：**缺失 / 非法 = 默认 10**；越界按 1-100 收敛（读侧容错，写侧严格校验）。
 */
export const IMA_KNOWLEDGE_SEARCH_LIMIT_REF = 'IMA_KNOWLEDGE_SEARCH_LIMIT'

/** 检索条数默认值（用户需求：默认 10）。 */
export const DEFAULT_SEARCH_LIMIT = 10

/** 检索条数下限（用户需求：范围 1-100）。 */
export const MIN_SEARCH_LIMIT = 1

/** 检索条数上限（用户需求：范围 1-100）。 */
export const MAX_SEARCH_LIMIT = 100

/**
 * 主动续期的提前量：剩余寿命 ≤ 5 分钟就先换 token，不等到请求失败。
 *
 * 取 5 分钟的理由：一次工具调用（检索/问答）可能跑几十秒到几分钟，留出这段余量
 * 才不会「请求发出时还有效、回来时已过期」。
 */
export const PROACTIVE_REFRESH_SKEW_MS = 5 * 60 * 1000

/** 路由前缀（SPEC §5）。 */
export const ROUTE_LIST = '/api/ima-knowledge/list'
export const ROUTE_SELECT = '/api/ima-knowledge/select'
export const ROUTE_STATUS = '/api/ima-knowledge/status'
/** 新增路由（PLATFORM.md §2.2：配置/登录授权 + 媒体检索）。 */
export const ROUTE_CREDENTIALS = '/api/ima-knowledge/credentials'
export const ROUTE_MEDIA = '/api/ima-knowledge/media'
/** 新增路由（PLATFORM.md §8.2：一键同步 IMA 桌面客户端凭据）。 */
export const ROUTE_DESKTOP_SYNC = '/api/ima-knowledge/desktop-sync'
/**
 * 新增路由（PLATFORM.md §9.5）：读某会话自己的选中集。
 *
 * `{sessionId}` → `{selected, inherited}`；`inherited:true` 表示该会话尚无自己的
 * 记录、当前值来自全局默认值 `IMA_KNOWLEDGE_BASE_IDS`。
 */
export const ROUTE_SESSION_STATE = '/api/ima-knowledge/session-state'

/**
 * 新增路由（v5）：检索条数设置的读写。
 *
 * `{action:'get'}` → `{searchLimit, min, max, default}`；
 * `{action:'set', searchLimit}` → 严格校验 1-100 的整数 → 写 credential store → 回同形。
 */
export const ROUTE_SETTINGS = '/api/ima-knowledge/settings'

/**
 * 自动签到（CHECKIN.md §4）三条路由：状态 / 立即签到 / 配置。
 *
 * 语义要点：
 *  - `status` **必须真的打一次上游**（面板打开时看到实时状态）；凭据未配置不是 HTTP 错误；
 *  - `run` 走 `withTokenRefresh`，已签过返回 `alreadyChecked:true`（不报错）；
 *  - `config` 部分字段更新，`time` 非法 → `BAD_REQUEST`，更新后立即重新 arm。
 */
export const ROUTE_CHECKIN_STATUS = '/api/ima-knowledge/checkin/status'
export const ROUTE_CHECKIN_RUN = '/api/ima-knowledge/checkin/run'
export const ROUTE_CHECKIN_CONFIG = '/api/ima-knowledge/checkin/config'

/**
 * 会话级选中集缺失时的指引（PLATFORM.md §9.4）。
 *
 * 与 {@link SELECT_HINT} 分开的原因：`SELECT_HINT` 是「全局一个默认值都没设」的
 * 老文案；会话级隔离后，最常见的情形是**别的会话选过、本会话没选**，提示必须
 * 说清「本会话」并指向输入框上方（chip 栏）+ 侧边栏两个入口。
 */
const SESSION_SELECT_HINT = '本会话未选择知识库，请在输入框上方（或左侧边栏 IMA 面板）选择本会话要查询的知识库'

/**
 * 系统提示词段名（`ctx.systemPrompt.section`）。
 *
 * 为什么需要这一段：`ima_kb_ask` 会把检索外包给 IMA 侧模型 —— 它先总结一遍再
 * 回来，原文措辞、细节、数字和逐条出处都会损失，模型拿二手摘要作答。工具描述
 * 只能「劝」，而系统提示词段是**每一步都在**的策略，才能把默认路径钉在
 * `ima_kb_search` 上。段名带命名空间，避免与宿主/其它插件撞名。
 */
export const PROMPT_SECTION_NAME = 'ima-knowledge:retrieval-policy'

/**
 * 段的排序值：落在工具指引区（`TOOL_REPORT`=2900 之后、`TOOL_COMPUTER_USE`=3000
 * 之前）。外部贡献可以用任意有限值，这里刻意贴着工具段，让「怎么用这个工具」
 * 和工具本身出现在同一片区域。
 */
export const PROMPT_SECTION_ORDER = 2950

/**
 * 新增两条路由的错误码。
 *
 * 为什么和 {@link ERROR_CODES} 分开：PLATFORM.md §2.2 对这两条路由**点名**了
 * `BAD_REQUEST` / `CREDENTIAL_READONLY` 两个字面量码，浏览器侧按契约消费；
 * 旧三条路由的码是本插件自定前缀且签名不许改，所以两套并存、互不覆盖。
 */
export const ROUTE_ERROR_CODES = {
  badRequest: 'BAD_REQUEST',
  credentialReadonly: 'CREDENTIAL_READONLY',
}

/**
 * media 聚合时最多打几个库。
 *
 * 无显式 kbIds 且没有选中集时回落到「全部可访问库」，但上游是逐库一次请求，
 * 账号库多了会瞬间打出 N 次请求 —— 按 PLATFORM.md §2.2 只取前 3 个。
 */
export const MAX_MEDIA_KNOWLEDGE_BASES = 3

/** 掩码里用的省略号（单字符，避免 UI 端宽度计算差异）。 */
const ELLIPSIS = '…'

/**
 * 把一段秘密值截成「前 head 位 + … + 后 tail 位」。
 *
 * 太短的值一律整体隐藏（否则「前 4 + 后 4」就等于原文），这条是掩码的底线。
 * @param {unknown} value - 原始值。
 * @param {number} head - 保留的开头字符数。
 * @param {number} tail - 保留的结尾字符数。
 * @returns {string|undefined} 掩码；无值返回 undefined。
 */
function maskSecret(value, head, tail) {
  const text = normalizeHeaderValue(typeof value === 'string' ? value : '')
  if (text.length === 0) return undefined
  if (text.length <= head + tail) return ELLIPSIS
  return `${text.slice(0, head)}${ELLIPSIS}${text.slice(-tail)}`
}

/**
 * 生成 `cookieMasked`：只暴露 `IMA-TOKEN=` 的前 4 位 + `…` + 后 4 位。
 *
 * 绝不返回完整 cookie（PLATFORM.md §2.2 掩码规则）。cookie 里没有 IMA-TOKEN 时
 * 退化成「整串头 4 位 + … + 尾 4 位」，仍然不是完整值。
 * @param {string|undefined} cookie - 完整 x-ima-cookie。
 * @returns {string|undefined} 掩码；未配置返回 undefined。
 */
export function maskCookie(cookie) {
  const text = normalizeHeaderValue(typeof cookie === 'string' ? cookie : '')
  if (text.length === 0) return undefined
  const token = parseCookie(text).token
  if (token !== undefined && token.length > 0) return `IMA-TOKEN=${maskSecret(token, 4, 4)}`
  return maskSecret(text, 4, 4)
}

/**
 * 生成 `bknMasked`：只暴露前 2 位 + `…` + 后 2 位。
 * @param {string|undefined} bkn - x-ima-bkn。
 * @returns {string|undefined} 掩码；未配置返回 undefined。
 */
export function maskBkn(bkn) {
  return maskSecret(bkn, 2, 2)
}

/**
 * 从 cookie 解析账号身份（PLATFORM.md §2.2「账号身份」）。
 *
 * **只有 `uid` 是权威且必定可得的**：它等于 cookie 里的 `IMA-UID`。
 * `nickname` / `guid` / `openid` / `type` 只能来自 IMA 侧接口（真机形状是 `open_info`），
 * 宿主侧当前没有这样的调用点，因此这里**不伪造**，拿不到就不给这个键；
 * 调用方（如 /credentials 的 set 校验）可以把已知的额外字段合并进来。
 *
 * @param {string|undefined} cookie - 完整 x-ima-cookie。
 * @param {object} [extra] - 来自 IMA 侧接口的补充字段（可缺）。
 * @returns {{uid: string, nickname?: string, guid?: string, openid?: string, type?: number}|undefined}
 *   cookie 里没有 IMA-UID 时返回 undefined（不编造 uid）。
 */
export function accountFromCookie(cookie, extra) {
  const text = normalizeHeaderValue(typeof cookie === 'string' ? cookie : '')
  if (text.length === 0) return undefined
  const uid = parseCookie(text).uid
  if (typeof uid !== 'string' || uid.length === 0) return undefined
  const account = { uid }
  const source = extra !== null && typeof extra === 'object' ? extra : {}
  for (const key of ['nickname', 'guid', 'openid']) {
    const value = source[key]
    if (typeof value === 'string' && value.length > 0) account[key] = value
  }
  if (Number.isFinite(source.type)) account.type = source.type
  // `avatarUrl` 只有桌面客户端（§8.1 `open_info.avatar_url`）能提供；§2.2 的
  // `/credentials get` 不带 extra，因此那里不会出现这个键（契约形状不变）。
  if (typeof source.avatarUrl === 'string' && source.avatarUrl.length > 0) account.avatarUrl = source.avatarUrl
  return account
}

/**
 * 没有选中库时给用户的明确指引（SPEC §4『禁止静默回退』）。
 *
 * 主入口是**左侧边栏的 IMA 图标面板**（PLATFORM §4）；设置页那张卡是次入口，
 * 文案里保留它，便于旧用户按原路径找到。
 */
const SELECT_HINT = '点左侧边栏的 IMA 图标打开面板，勾选要接入的知识库（次入口：设置→插件→IMA 知识库）'
/** 凭据缺失时的明确指引（同上：主入口侧边栏面板，设置页为次入口）。 */
const CONFIG_HINT = `点左侧边栏的 IMA 图标打开面板配置 ${IMA_X_IMA_COOKIE_REF}（从已登录的 ima.qq.com 复制完整 x-ima-cookie；次入口：设置→插件→IMA 知识库）`

/**
 * 判定宿主能力是否存在；缺什么就抛带期望签名的显式错误。
 * @param {object} ctx - Cordis 宿主上下文。
 * @param {string} path - 能力路径（例如 `ctx.tools.register`）。
 * @param {unknown} value - 实际拿到的值。
 * @param {string} expected - 期望签名的文字描述。
 * @returns {void}
 */
function assertCapability(path, value, expected) {
  if (typeof value !== 'function') {
    throw new Error(
      `ima-knowledge: 宿主缺少能力 ${path}（期望签名 ${expected}）。`
      + ' 该 DSH 版本的宿主 API 与本插件假设不一致：请报告 DSH 版本并暂停使用本插件。',
    )
  }
}

/**
 * 取宿主服务并把三个必需方法都校验一遍。
 * @param {object} ctx - Cordis 宿主上下文。
 * @returns {{tools: object, credentials: object, connection: object}} 校验过的服务。
 */
function resolveHostServices(ctx) {
  if (ctx === null || typeof ctx !== 'object') {
    throw new Error('ima-knowledge: apply(ctx) 收到的 ctx 不是对象')
  }
  const tools = typeof ctx.get === 'function' ? ctx.get('tools') : ctx.tools
  assertCapability('ctx.tools.register', tools?.register, '(definition) => () => void')
  const credentials = typeof ctx.get === 'function' ? ctx.get('credentials') : ctx.credentials
  assertCapability('ctx.credentials.resolve', credentials?.resolve, '(ref) => Promise<{value}|string|undefined>')
  assertCapability('ctx.credentials.set', credentials?.set, '(ref, value) => Promise<void>')
  assertCapability('ctx.credentials.describe', credentials?.describe, '(ref) => Promise<{configured,writable}>')
  const connection = typeof ctx.get === 'function' ? ctx.get('connection') : ctx.connection
  assertCapability('ctx.connection.fetch.register', connection?.fetch?.register, '({path,methods,requestBody,fetch}) => () => Promise<void>')
  return { tools, credentials, connection }
}

/** 注册一个 effect 并容忍异步 disposer（cordis effect 会等待其结算）。 */
function useEffect(ctx, install, label) {
  if (typeof ctx.effect === 'function') return ctx.effect(install, label)
  return install()
}

/**
 * 读一个凭据 ref，兼容 `{value}` 与裸字符串两种形状。
 * @param {object} credentials - ctx.credentials。
 * @param {string} ref - 凭据 ref。
 * @returns {Promise<string|undefined>} 去 BOM/空白的值，未配置或空串时 undefined。
 */
export async function readCredential(credentials, ref) {
  const resolved = await credentials.resolve(ref)
  if (resolved === undefined || resolved === null) return undefined
  const raw = typeof resolved === 'string' ? resolved : resolved.value
  if (typeof raw !== 'string') return undefined
  const value = raw.replace(/\uFEFF/gu, '').trim()
  return value.length === 0 ? undefined : value
}

/**
 * 解析 `IMA_KNOWLEDGE_BASE_IDS`（逗号/换行分隔）为去重 id 列表。
 * @param {string|undefined} value - 存储原文。
 * @returns {string[]} 去重后的 id。
 */
export function parseKnowledgeBaseIds(value) {
  if (typeof value !== 'string') return []
  return [...new Set(value.split(/[\r\n,]+/u).map((id) => id.trim()).filter(Boolean))]
}

/**
 * 写一个凭据 ref；不可写时抛显式错误（不静默跳过）。
 * @param {object} credentials - ctx.credentials。
 * @param {string} ref - 凭据 ref。
 * @param {string} value - 非空值。
 * @returns {Promise<void>} 写完成。
 */
export async function writeCredential(credentials, ref, value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`ima-knowledge: 拒绝把空值写入 ${ref}`)
  }
  const info = await credentials.describe(ref)
  if (info !== null && typeof info === 'object' && info.writable === false) {
    throw new Error(
      `ima-knowledge: 凭据 ${ref} 当前不可写（source=${info.source ?? 'unknown'}）：`
      + '当前 DSH 的凭据 provider 不允许插件写入该 ref，请手动在设置里填写。',
    )
  }
  await credentials.set(ref, value)
}

/**
 * 删除一个凭据 ref（用于「清空」这类合法业务状态）；不可删时抛显式错误。
 *
 * 为什么不是「写空字符串」：那会让 ref **存在但值为空**，下游 `resolve()` 会拿到空串，
 * 语义脏（分不清「从未配置」和「配置成空」）。`unset()` 让 ref 真正消失，
 * `readOptionalCredential()` 才会正常返回 undefined —— 闭环才正确。
 *
 * 真实签名：`ctx.credentials.unset(ref): Promise<void>`
 * （packages/credentials/credentials/src/index.ts）。
 *
 * @param {object} credentials - ctx.credentials。
 * @param {string} ref - 凭据 ref。
 * @returns {Promise<void>} 删除完成。
 */
export async function unsetCredential(credentials, ref) {
  assertCapability('ctx.credentials.unset', credentials?.unset, '(ref) => Promise<void>')
  const info = await credentials.describe(ref)
  if (info !== null && typeof info === 'object' && info.writable === false) {
    throw new Error(
      `ima-knowledge: 凭据 ${ref} 当前不可写（source=${info.source ?? 'unknown'}）：`
      + '当前 DSH 的凭据 provider 不允许插件删除该 ref，请手动在设置里清空。',
    )
  }
  await credentials.unset(ref)
}

/**
 * 读一个可选凭据 ref：未配置返回 undefined。
 *
 * 只有「选中集」这类可选 ref 用它 —— 缺选中集是合法状态（仅调用工具时才要求勾选）。
 * **必填** ref 一律走 {@link readCredential}，缺了就明确报错；真实故障不会被伪装成
 * 「未配置」：非「未配置」类错误会带 ref 名重新抛出。
 * @param {object} credentials - ctx.credentials。
 * @param {string} ref - 凭据 ref。
 * @returns {Promise<string|undefined>} 值或 undefined。
 */
export async function readOptionalCredential(credentials, ref) {
  let resolved
  try {
    resolved = await credentials.resolve(ref)
  } catch (error) {
    if (error instanceof Error && /not configured|unconfigured|unknown reference/iu.test(error.message)) return undefined
    throw new Error(`ima-knowledge: 读取凭据 ${ref} 失败：${error instanceof Error ? error.message : String(error)}`)
  }
  if (resolved === undefined || resolved === null) return undefined
  const raw = typeof resolved === 'string' ? resolved : resolved.value
  if (typeof raw !== 'string') return undefined
  const value = raw.replace(/\uFEFF/gu, '').trim()
  return value.length === 0 ? undefined : value
}

/**
 * 把任意存储值 / 入参规范成合法的检索条数。
 *
 * 三条规则（**读侧容错**；写侧由 `/settings` 路由严格校验，不静默收敛）：
 *  1. 非数字 / 非有限值 / 空值 → {@link DEFAULT_SEARCH_LIMIT}；
 *  2. 小数向下取整；
 *  3. 越界收敛到 [{@link MIN_SEARCH_LIMIT}, {@link MAX_SEARCH_LIMIT}]。
 *
 * @param {unknown} value - 原始值（数字或字符串）。
 * @returns {number} 1-100 之间的整数。
 */
export function normalizeSearchLimit(value) {
  const numeric = typeof value === 'number'
    ? value
    : (typeof value === 'string' && value.trim() !== '' ? Number(value.trim()) : Number.NaN)
  if (!Number.isFinite(numeric)) return DEFAULT_SEARCH_LIMIT
  const floored = Math.floor(numeric)
  if (floored < MIN_SEARCH_LIMIT) return MIN_SEARCH_LIMIT
  if (floored > MAX_SEARCH_LIMIT) return MAX_SEARCH_LIMIT
  return floored
}

/**
 * 读当前生效的检索条数（未配置 = 默认 10）。
 *
 * 用 {@link readOptionalCredential}：这个 ref 是**可选**的，缺失是合法状态
 * （用户从没改过设置），不能像 cookie 那样缺了就报错。
 *
 * @param {object} credentials - ctx.credentials。
 * @returns {Promise<number>} 1-100 的整数。
 */
export async function readSearchLimit(credentials) {
  const raw = await readOptionalCredential(credentials, IMA_KNOWLEDGE_SEARCH_LIMIT_REF)
  return normalizeSearchLimit(raw)
}

/**
 * 读运行时凭据：cookie 必填；bkn 优先用存储值，缺失时按 getBkn(IMA-TOKEN) 推导。
 * @param {object} credentials - ctx.credentials。
 * @param {string} operation - 操作名（错误信息用）。
 * @returns {Promise<{cookie: string, bkn: string, selected: string[], expiresAt?: number}>}
 *   凭据与选中集；`expiresAt` 是 token 到期时间（epoch 毫秒），未知时不出现该键。
 */
export async function readRuntimeCredentials(credentials, operation) {
  const [cookie, storedBkn, idsValue, expiresValue] = await Promise.all([
    readCredential(credentials, IMA_X_IMA_COOKIE_REF),
    readOptionalCredential(credentials, IMA_X_IMA_BKN_REF),
    readOptionalCredential(credentials, IMA_KNOWLEDGE_BASE_IDS_REF),
    readOptionalCredential(credentials, IMA_X_IMA_TOKEN_EXPIRES_AT_REF),
  ])
  if (cookie === undefined) {
    throw new Error(`${operation}: 未配置 ${IMA_X_IMA_COOKIE_REF}；${CONFIG_HINT}`)
  }
  let bkn = storedBkn
  if (bkn === undefined) {
    const parsed = parseCookie(cookie)
    if (parsed.token === undefined) {
      throw new Error(
        `${operation}: ${IMA_X_IMA_COOKIE_REF} 里没有 IMA-TOKEN，且未单独配置 ${IMA_X_IMA_BKN_REF}；`
        + `请重新复制完整 cookie，或手动填写 bkn。${CONFIG_HINT}`,
      )
    }
    bkn = getBkn(parsed.token)
  }
  const expiresAt = expiryOf(expiresValue)
  return {
    cookie,
    bkn,
    selected: parseKnowledgeBaseIds(idsValue),
    ...(expiresAt === undefined ? {} : { expiresAt }),
  }
}

/**
 * 到期时间（epoch 毫秒的字符串/数字）→ 数字；解析不出来返回 undefined（不猜）。
 * @param {unknown} value - 存储值。
 * @returns {number|undefined} epoch 毫秒。
 */
function expiryOf(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined
  const ms = typeof value === 'number' ? value : Number(value.trim())
  return Number.isFinite(ms) && ms > 0 ? ms : undefined
}

/**
 * 是否该提前续期：只知道「到期时间已进入提前量窗口」才返回 true。
 * 到期时间未知（用户手填 cookie / 旧版本落盘）时返回 false —— 退回撞 41 再续期的老路径。
 * @param {number|undefined} expiresAt - epoch 毫秒。
 * @param {number} [now] - 当前时间（测试注入）。
 * @returns {boolean} 是否需要提前续期。
 */
function needsProactiveRefresh(expiresAt, now = Date.now()) {
  return expiresAt !== undefined && expiresAt - now <= PROACTIVE_REFRESH_SKEW_MS
}

/**
 * 把一次续期的结果落盘：新 cookie + 新 bkn + 新到期时间。
 *
 * **bkn 必须跟着新 token 一起写**：bkn = getBkn(IMA-TOKEN)，token 换了 bkn 就变了。
 * 旧实现只回写 cookie，留下「新 cookie + 旧 bkn」；实测上游对 bkn 不匹配比较宽容，
 * 但那是上游的善意，不是契约 —— 这里一次写齐。
 *
 * @param {object} credentials - ctx.credentials。
 * @param {{cookie: string, bkn: string, tokenTtlSeconds?: number}} refreshed - refreshToken() 的结果。
 * @param {number} [now] - 当前时间（测试注入）。
 * @returns {Promise<{cookie: string, bkn: string, expiresAt?: number}>} 落盘后的运行时凭据。
 */
async function persistRefreshed(credentials, refreshed, now = Date.now()) {
  await writeCredential(credentials, IMA_X_IMA_COOKIE_REF, refreshed.cookie)
  if (typeof refreshed.bkn === 'string' && refreshed.bkn.length > 0) {
    await writeCredential(credentials, IMA_X_IMA_BKN_REF, refreshed.bkn)
  }
  const expiresAt = Number.isFinite(refreshed.tokenTtlSeconds) && refreshed.tokenTtlSeconds > 0
    ? now + refreshed.tokenTtlSeconds * 1000
    : undefined
  if (expiresAt !== undefined) {
    await writeCredential(credentials, IMA_X_IMA_TOKEN_EXPIRES_AT_REF, String(expiresAt))
  }
  return {
    cookie: refreshed.cookie,
    bkn: refreshed.bkn,
    ...(expiresAt === undefined ? {} : { expiresAt }),
  }
}

/**
 * 用 refresh token 换一次新 token 并落盘。
 * @param {object} credentials - ctx.credentials。
 * @param {{cookie: string, bkn: string}} runtime - 当前运行时凭据。
 * @param {{fetchImpl?: typeof fetch}} [options] - 仅测试注入。
 * @returns {Promise<{cookie: string, bkn: string, expiresAt?: number}>} 续期后的凭据。
 */
async function refreshRuntime(credentials, runtime, options = {}) {
  const refreshed = await refreshToken(
    { cookie: runtime.cookie, bkn: runtime.bkn },
    options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl },
  )
  try {
    return await persistRefreshed(credentials, refreshed)
  } catch (writeError) {
    // 续期本身成功、只是落盘失败：**不**再往「重读桌面客户端」兜底 —— 那条路同样要写库，
    // 只会把「凭据 provider 不可写」这个真实原因埋掉。直接报可定位的错误。
    const error = new Error(
      `token 已刷新但回写 ${IMA_X_IMA_COOKIE_REF} 失败：`
      + `${writeError instanceof Error ? writeError.message : String(writeError)}。`
      + '本次请求仍可用新 token 完成，但下次调用可能再次过期。',
    )
    error.refreshPersistFailed = true
    throw error
  }
}

/**
 * 从 IMA 桌面客户端重读凭据 → 校验 → 落盘（`/desktop-sync sync` 与自动兜底共用）。
 *
 * 抽出来的原因：自动兜底和手动同步必须是**同一条**逻辑，否则两条路会漂移
 * （一条先校验再落盘、另一条直接覆盖，坏凭据就会顶掉好凭据）。
 *
 * 契约：**校验不过零写入**。
 * @param {object} credentials - ctx.credentials。
 * @param {{fetchImpl?: typeof fetch, desktop?: object}} [options] - 仅测试注入。
 * @returns {Promise<{ok: true, cookie: string, bkn: string, expiresAt?: number, account?: object}
 *   | {ok: false, error: string, nonWindows?: boolean}>} 同步结果。
 */
async function syncDesktopCredentials(credentials, options = {}) {
  const desktop = options.desktop !== null && typeof options.desktop === 'object' ? options.desktop : {}
  const fetchOptions = options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }
  let found
  try {
    found = await readDesktopCredentials(desktop)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message === NON_WINDOWS_REASON) return { ok: false, error: NON_WINDOWS_REASON, nonWindows: true }
    return { ok: false, error: `无法从 IMA 桌面客户端读取凭据：${message}` }
  }

  // 注意：这里**不能**解构成 `refreshToken` —— 那会遮蔽同名的 `ima-api.js` 导入。
  const { token, refreshToken: refreshSecret, account } = found
  let cookie = normalizeHeaderValue(buildCookie({ uid: account.uid, token, refresh: refreshSecret }))
  let bkn = getBkn(token)
  let expiresAt = Number.isFinite(found.tokenValidTime) ? found.tokenValidTime * 1000 : undefined

  // ① 候选凭据先校验（最廉价：pageSize=1）；token 过期（code 41）则用 refresh token 续期后重试。
  try {
    await listKnowledgeBases({ cookie, bkn }, { pageSize: 1, ...fetchOptions })
  } catch (error) {
    const classified = classifyError(
      error instanceof ImaApiError ? error.code : undefined,
      error instanceof Error ? error.message : undefined,
    )
    if (!classified.needsRefresh) {
      return {
        ok: false,
        error: `桌面客户端凭据校验失败，未保存：${error instanceof Error ? error.message : String(error)}`,
      }
    }
    let refreshed
    try {
      refreshed = await refreshToken({ cookie, bkn }, fetchOptions)
    } catch (refreshError) {
      return {
        ok: false,
        error: '桌面客户端的 token 已过期，且续期失败（请在 IMA 桌面客户端重新登录后再同步）：'
          + `${refreshError instanceof Error ? refreshError.message : String(refreshError)}`,
      }
    }
    cookie = normalizeHeaderValue(refreshed.cookie)
    bkn = normalizeHeaderValue(refreshed.bkn)
    if (Number.isFinite(refreshed.tokenTtlSeconds) && refreshed.tokenTtlSeconds > 0) {
      expiresAt = Date.now() + refreshed.tokenTtlSeconds * 1000
    }
    try {
      await listKnowledgeBases({ cookie, bkn }, { pageSize: 1, ...fetchOptions })
    } catch (retryError) {
      return {
        ok: false,
        error: `桌面客户端凭据续期后仍校验失败，未保存：${retryError instanceof Error ? retryError.message : String(retryError)}`,
      }
    }
  }

  // ② 校验通过才落盘：先清旧 bkn（避免「新 cookie + 旧 bkn」），再写 cookie / bkn / 到期时间。
  try {
    const staleBkn = await readOptionalCredential(credentials, IMA_X_IMA_BKN_REF)
    if (staleBkn !== undefined) await unsetCredential(credentials, IMA_X_IMA_BKN_REF)
    await writeCredential(credentials, IMA_X_IMA_COOKIE_REF, cookie)
    await writeCredential(credentials, IMA_X_IMA_BKN_REF, bkn)
    if (expiresAt !== undefined) {
      await writeCredential(credentials, IMA_X_IMA_TOKEN_EXPIRES_AT_REF, String(expiresAt))
    }
  } catch (writeError) {
    return {
      ok: false,
      error: `凭据校验通过，但写入失败：${writeError instanceof Error ? writeError.message : String(writeError)}`,
    }
  }

  return {
    ok: true,
    cookie,
    bkn,
    ...(expiresAt === undefined ? {} : { expiresAt }),
    account: accountFromCookie(cookie, account) ?? account,
  }
}

/**
 * 兜底恢复：先续期；续期不行就重读 IMA 桌面客户端。
 *
 * 这是「同步一次、之后不用管」的核心：只要 IMA 桌面客户端还登着，插件就能自己接上。
 * @param {object} credentials - ctx.credentials。
 * @param {string} operation - 操作名。
 * @param {{fetchImpl?: typeof fetch, desktop?: object}} [options] - 仅测试注入。
 * @returns {Promise<{cookie: string, bkn: string, expiresAt?: number}>} 可用凭据。
 * @throws {Error} 两条路都失败时抛带人话指引的错误。
 */
async function recoverCredentials(credentials, operation, options = {}) {
  const runtime = await readRuntimeCredentials(credentials, operation)
  const reasons = []
  try {
    return await refreshRuntime(credentials, runtime, options)
  } catch (error) {
    // 续期成功但落盘失败：换一条路也一样写不进去，直接带着真实原因失败。
    if (error?.refreshPersistFailed === true) {
      throw new Error(`${operation}: ${error instanceof Error ? error.message : String(error)}`)
    }
    reasons.push(`自动续期失败（${error instanceof Error ? error.message : String(error)}）`)
  }
  const synced = await syncDesktopCredentials(credentials, options)
  if (synced.ok) {
    return {
      cookie: synced.cookie,
      bkn: synced.bkn,
      ...(synced.expiresAt === undefined ? {} : { expiresAt: synced.expiresAt }),
    }
  }
  reasons.push(synced.error)
  throw new Error(
    `${operation}: ${reasons.join('；')}。`
    + '请在 IMA 桌面客户端重新登录后，点左侧边栏 IMA 面板里的「从 IMA 桌面客户端同步」。',
  )
}

/**
 * 取一份「现在就能用」的凭据：到期时间进入提前量窗口就先续期。
 *
 * 主动续期失败**不阻断**：token 可能还没真的过期，让请求自己试一次；
 * 真过期了再由 {@link recoverCredentials} 兜底（续期 → 重同步）。
 * @param {object} credentials - ctx.credentials。
 * @param {string} operation - 操作名。
 * @param {{fetchImpl?: typeof fetch, desktop?: object}} [options] - 仅测试注入。
 * @returns {Promise<{cookie: string, bkn: string, expiresAt?: number}>} 可用凭据。
 */
async function ensureFreshCredentials(credentials, operation, options = {}) {
  const runtime = await readRuntimeCredentials(credentials, operation)
  if (!needsProactiveRefresh(runtime.expiresAt)) return runtime
  try {
    return await refreshRuntime(credentials, runtime, options)
  } catch {
    return runtime
  }
}

/**
 * 带授权保活的请求执行器：**到期前主动续期**，失败后**自动兜底恢复**。
 *
 * 三层，按代价从低到高：
 * 1. `ensureFreshCredentials`：记录的到期时间进入 5 分钟窗口 → 先续期（零失败、零日志噪音）；
 * 2. 请求撞 `code 41` → `recoverCredentials`：先用 refresh token 续期；
 * 3. 续期也失败 → 自动重读 IMA 桌面客户端（DPAPI）并重试 —— 用户零点击。
 *
 * 只有三层全失败才抛错，错误里带「去桌面客户端重新登录 + 点同步」的人话指引。
 * @param {object} credentials - ctx.credentials。
 * @param {string} operation - 操作名。
 * @param {(creds: {cookie: string, bkn: string}) => Promise<any>} run - 真正发起请求的函数。
 * @param {{fetchImpl?: typeof fetch, desktop?: object}} [options] - 仅测试注入。
 * @returns {Promise<any>} run 的返回值。
 */
async function withTokenRefresh(credentials, operation, run, options = {}) {
  const runtime = await ensureFreshCredentials(credentials, operation, options)
  try {
    return await run({ cookie: runtime.cookie, bkn: runtime.bkn })
  } catch (error) {
    const code = error instanceof ImaApiError ? error.code : undefined
    const classified = classifyError(code, error instanceof Error ? error.message : undefined)
    if (!classified.needsRefresh) throw error
    const recovered = await recoverCredentials(credentials, operation, options)
    return await run({ cookie: recovered.cookie, bkn: recovered.bkn })
  }
}

/**
 * 从「选中集 / 显式入参」里定一个库 id。
 * @param {string[]} selected - 已勾选的库 id。
 * @param {string|undefined} requested - 调用方显式指定的 id。
 * @param {string} operation - 操作名。
 * @returns {string} 库 id。
 */
export function selectKnowledgeBaseId(selected, requested, operation) {
  const explicit = typeof requested === 'string' ? requested.trim() : ''
  if (explicit.length > 0) return explicit
  if (selected.length > 0) return selected[0]
  throw new Error(`${operation}: 还没有选中任何知识库；${SELECT_HINT}`)
}

/** 统一响应：`{ok:true,value}` + 禁止缓存（SPEC §5）。 */
function okJson(value) {
  return Response.json({ ok: true, value }, { headers: { 'cache-control': 'no-store' } })
}

/** 统一响应：`{ok:false,error:{code,message}}` + 禁止缓存（SPEC §5）。 */
function failJson(code, message) {
  return Response.json({ ok: false, error: { code, message } }, { headers: { 'cache-control': 'no-store' } })
}

/** 把错误对象直接变成失败响应（避免依赖对象键顺序做展开）。 */
function failFromError(error) {
  const { code, message } = errorOf(error)
  return failJson(code, message)
}

/** 读 POST body（JSON 对象），失败返回 undefined。 */
async function readBody(request) {
  try {
    const body = await request.json()
    return body !== null && typeof body === 'object' && !Array.isArray(body) ? body : undefined
  } catch {
    return undefined
  }
}

/**
 * 路由错误码（实现与测试共用同一套常量，SPEC §5 只规定了统一响应形态，
 * 没有规定 code 命名，所以这套前缀由本插件自定并在这里集中声明）。
 *
 * 成功一律 HTTP 200 + `{ok:true,value}`；失败一律 HTTP 200 + `{ok:false,error:{code,message}}`
 * —— 宿主路由是给设置卡消费的，HTTP 层状态码只表达传输成功与否，业务失败不能和
 * 「路由不存在 / 网关故障」混在一起，否则前端只能靠猜。这在/select 与 /list 里统一。
 */
export const ERROR_CODES = {
  badRequest: 'ima-knowledge/bad-request',
  notConfigured: 'ima-knowledge/not-configured',
  tokenExpired: 'ima-knowledge/token-expired',
  sessionExpired: 'ima-knowledge/session-expired',
  noKnowledgeBaseSelected: 'ima-knowledge/no-knowledge-base-selected',
  unknownKnowledgeBase: 'ima-knowledge/unknown-knowledge-base',
  upstream: 'ima-knowledge/upstream',
  internal: 'ima-knowledge/internal',
}

/** 错误 → `{code, message}`；ImaApiError 按 classifyError 的 kind 映射到统一错误码。 */
function errorOf(error) {
  const message = error instanceof Error ? error.message : String(error)
  if (error instanceof ImaApiError) {
    const kind = error.kind ?? classifyError(error.code).kind
    const code = kind === 'token-expired'
      ? ERROR_CODES.tokenExpired
      : kind === 'session-expired'
        ? ERROR_CODES.sessionExpired
        : kind === 'bad-request'
          ? ERROR_CODES.badRequest
          : ERROR_CODES.upstream
    return { code, message }
  }
  // 非 ImaApiError 的本地错误里，凭据缺失与「未勾选库」是两条要给用户看的明确指引。
  if (/未配置 IMA_X_IMA_COOKIE|IMA-TOKEN,?且未|没有 IMA-TOKEN/u.test(message)) {
    return { code: ERROR_CODES.notConfigured, message }
  }
  // 会话级空选中集（§9.4）与老的全局空选中集走同一个错误码：前端只需一种处理。
  if (/还没有选中任何知识库|本会话未选择知识库/u.test(message)) {
    return { code: ERROR_CODES.noKnowledgeBaseSelected, message }
  }
  return { code: ERROR_CODES.internal, message }
}

/**
 * 当前选中集（未配置视为空集，不报错）。
 *
 * @param {object} credentials - ctx.credentials。
 * @param {object} [store] - 会话存储（{@link createSessionStore}）；省略时只看全局。
 * @param {string} [sessionId] - 当前会话 id；省略时只看全局。
 * @returns {Promise<string[]>} 选中集。
 */
async function readSelected(credentials, store, sessionId) {
  const resolved = await resolveSelected(credentials, store, sessionId)
  return resolved.selected
}

/**
 * 解析「当前生效的选中集」及其来源（PLATFORM.md §9.3 / §9.4）。
 *
 * 优先级：**会话级记录 → 全局默认值**。
 *  - 会话级 `{ids:[]}`（明确不选）直接返回 `[]`，`inherited:false`，**不回退全局**；
 *  - 会话级无记录 → 读全局 `IMA_KNOWLEDGE_BASE_IDS` 当默认值，`inherited:true`；
 *    继承**不写回**会话级（§9.3「一次性继承」的读侧语义：只读不落，等用户真的选了
 *    才产生会话级记录）。
 *
 * @param {object} credentials - ctx.credentials。
 * @param {object} [store] - 会话存储；省略 = 只走全局（老调用/老宿主）。
 * @param {string} [sessionId] - 会话 id；空串/非字符串视作「没有会话上下文」。
 * @returns {Promise<{selected: string[], inherited: boolean, scope: 'session'|'global', sessionId?: string}>}
 *   解析结果；`scope` 表示值实际来自哪一层。
 */
async function resolveSelected(credentials, store, sessionId) {
  const id = normalizeSessionId(sessionId)
  if (store !== undefined && store !== null && id !== undefined) {
    const sessionSelected = await store.getSelected(id)
    if (sessionSelected !== undefined) {
      // 会话级记录存在（含 `[]`）：这就是该会话的答案，绝不回退全局。
      return { selected: sessionSelected, inherited: false, scope: 'session', sessionId: id }
    }
    const fallback = parseKnowledgeBaseIds(await readOptionalCredential(credentials, IMA_KNOWLEDGE_BASE_IDS_REF))
    return { selected: fallback, inherited: true, scope: 'session', sessionId: id }
  }
  const globalSelected = parseKnowledgeBaseIds(await readOptionalCredential(credentials, IMA_KNOWLEDGE_BASE_IDS_REF))
  return { selected: globalSelected, inherited: true, scope: 'global' }
}

/**
 * 归一化会话 id：只有非空字符串才算「有会话上下文」。
 * @param {unknown} value - 候选值。
 * @returns {string|undefined} 归一化后的 id，或 undefined。
 */
function normalizeSessionId(value) {
  if (typeof value !== 'string') return undefined
  const id = value.trim()
  return id.length === 0 ? undefined : id
}

/**
 * 从工具调用的 `exec` 里取当前会话 id。
 *
 * 依据（已核实）：`dsh-agent` 的 `interface Agent { readonly id: SessionId }`，
 * 工具 `execute(args, exec)` 的 `exec.agent` 就是调用方 Agent。`exec` 可能整体缺失
 * （老版本宿主 / 测试直调）→ 返回 undefined，调用方退化为全局默认值。
 * @param {object} [exec] - 工具执行上下文。
 * @returns {string|undefined} 会话 id。
 */
function sessionIdOf(exec) {
  return normalizeSessionId(exec?.agent?.id)
}

/** 构造工具参数 schema：空对象（三工具共用形态）。 */
const EMPTY_PARAMETERS = { type: 'object', properties: {}, additionalProperties: false }

/** 三个工具的 output schema（DSH 强制要求，且只允许受支持的 JSON Schema 子集）。 */
const LIST_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['knowledgeBases', 'selected', 'selectedId'],
  properties: {
    knowledgeBases: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'name', 'selected'],
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          selected: { type: 'boolean' },
          // 归属分组（PLATFORM.md §2.1）：'personal' | 'joined'。
          // **不放进 required** —— 判定不出来时宿主整个键都不给（不是给 null/空串），
          // 消费方据此把该库落进「个人知识库」。
          group: { type: 'string' },
        },
      },
    },
    selected: { type: 'array', items: { type: 'string' } },
    // DSH 的 JSON Schema 子集不接受联合 type 数组，只接受单 type 或 oneOf。
    selectedId: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    // PLATFORM.md §9.4：`scope` / `sessionId` 是**诊断用可选字段**，
    // 刻意不进 required —— 老宿主（exec 缺失）时 scope 退化为 'global'、
    // sessionId 整个键不给，消费方不该因此认为契约破了。
    scope: { type: 'string' },
    sessionId: { type: 'string' },
  },
}

const ASK_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['answer', 'references'],
  properties: {
    answer: { type: 'string' },
    references: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'title'],
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          knowledgeBase: { type: 'string' },
          // 命中原文片段（referenceIndexes 的 content），便于模型判断引用是否相关。
          content: { type: 'string' },
          // 引用在源 PDF 中的页码（上游 0 基页号 +1）。
          page: { type: 'number' },
        },
      },
    },
  },
}

const SEARCH_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['media_id', 'title', 'highlight'],
        properties: {
          media_id: { type: 'string' },
          title: { type: 'string' },
          highlight: { type: 'string' },
        },
      },
    },
  },
}

/** 纯文本渲染器：把结构化成 json 文本给模型看（简单、无损、不臆造）。 */
function textRender(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

/**
 * 带「下一步」提示的渲染器：结构化 json + 一条固定的策略提醒。
 *
 * 为什么在**结果里**再提醒一次：模型是在拿到结果的那一刻决定「继续检索还是换个
 * 工具」的。工具描述只在选工具前出现一次，结果里的这句话正好压在那个决策点上。
 * @param {string} hint - 附在结构化结果之后的提醒文本。
 * @returns {(args: unknown, value: unknown) => Array<{type: string, text: string}>} 渲染器。
 */
function hintRender(hint) {
  // 刻意合成**单个** text 部件（与宿主第一方工具同一写法）：多部件虽然也是合法
  // content，但渲染/快照路径上少一种形状就少一种出错可能。
  return (_args, value) => [{ type: 'text', text: `${JSON.stringify(value, null, 2)}\n\n${hint}` }]
}

/** `ima_kb_search` 结果后的提醒：原文片段 → 继续检索，别转 ask。 */
const SEARCH_RESULT_HINT = '[ima] 以上是原文片段（未经 IMA 侧模型改写）。需要更多细节就继续用 ima_kb_search 换关键词 / 同义词 / 英文术语再检索，或调大 limit；不要改用 ima_kb_ask 代替检索。'

/** `ima_kb_ask` 结果后的提醒：这是有损的二次总结，需要原文请回到 search。 */
const ASK_RESULT_HINT = '[ima] 上面是 IMA 侧模型的二次总结：原文措辞、细节与逐条出处已经丢失。需要原文或需要核对细节时，请改用 ima_kb_search；引用该结论时请说明它来自 IMA 侧总结而非原文。'

/**
 * 生成 IMA 知识库检索策略（系统提示词段正文）。
 *
 * 三态（与会话选中集的三态严格对应）：
 *  - `undefined` = 不知道本会话选了什么 → 给通用策略（措辞自门控，不谎称已选中）；
 *  - `[]` = 用户明确不查库 → 返回空串，整段被丢弃（不污染提示词）；
 *  - 非空 → 策略 + 「已选中 N 个库」的确定语气。
 *
 * @param {string[]|undefined} selectedIds - 本会话选中集。
 * @returns {string} 段正文；空串表示不注入。
 */
export function buildRetrievalPolicyText(selectedIds) {
  if (Array.isArray(selectedIds) && selectedIds.length === 0) return ''
  const scopeLine = Array.isArray(selectedIds)
    ? `本会话已选中 ${selectedIds.length} 个 IMA 知识库，可直接检索。`
    : '本会话可能已选中 IMA 知识库（不确定时先调 `ima_kb_list` 确认）。'
  return [
    '## IMA 知识库使用策略',
    '',
    scopeLine,
    '',
    // 硬规则（英文，与 DSH 提示词同一语域）：把「什么时候必须检索」钉在提示词里，
    // 而不是只靠工具描述去劝。覆盖三类触发面 —— 不确定的事实、学术/技术知识、
    // 以及知识库可能覆盖的世界知识；后半句同时封死「猜」和「编」两条捷径。
    '**Search before you assert.** When a question turns on uncertain facts, academic or technical knowledge, or any world knowledge a selected knowledge base may cover, call `ima_kb_search` first, read the returned passages, and answer from them yourself. Never guess, assume, or fabricate; if nothing is found, say what you searched for and what is still unknown.',
    '',
    '**不要用 `ima_kb_ask` 代替检索。** 它会让 IMA 侧模型先把资料总结一遍再返回，原文措辞、细节、数字和逐条出处都会丢失 —— 那等于把检索外包给另一个模型，再拿二手摘要作答。',
    '',
    '`ima_kb_ask` 只在两种情况下使用：',
    '1. 用户明确要求「让 IMA 自己回答 / 给个结论」；',
    '2. 已用 `ima_kb_search` 换过多组关键词仍检索不到相关内容。',
    '',
    '一旦用了 `ima_kb_ask`，必须在回答里说明该结论来自 IMA 侧总结、而非原文，并给出可继续检索的方向。',
    '',
    '检索技巧：一次没命中不等于没有 —— 换同义词、上位词、英文术语、去掉限定词再试；`limit` 可以调大（默认 10，可在插件设置里改成 1-100）。',
  ].join('\n')
}

/**
 * 会话选中集的内存镜像（同步读）。
 *
 * 为什么需要镜像：`ctx.systemPrompt.section` 的 `text` 只能是同步函数（宿主在
 * 组装提示词时同步调用它），而会话存储的 `getSelected` 是异步的。于是把「已知
 * 的会话选中集」同步缓存一份：写路径（`/select` 路由、`ima_kb_list`）写入，
 * 启动时从存储 hydrate 一次；缓存没有的会话退回通用策略。
 *
 * @returns {{get: (sessionId: unknown) => string[]|undefined, set: (sessionId: unknown, ids: unknown) => void, size: () => number}} 镜像。
 */
export function createSelectionCache() {
  /** @type {Map<string, string[]>} */
  const records = new Map()
  return {
    get(sessionId) {
      const id = normalizeSessionId(sessionId)
      if (id === undefined) return undefined
      const ids = records.get(id)
      return ids === undefined ? undefined : [...ids]
    },
    set(sessionId, ids) {
      const id = normalizeSessionId(sessionId)
      if (id === undefined) return
      const normalized = normalizeSelectedIds(ids)
      if (normalized === undefined) return
      records.set(id, normalized)
    },
    size() {
      return records.size
    },
  }
}

/**
 * 启动时把存储里已有的会话选中集灌进镜像（跨进程重启后的常见情形：用户上次选过，
 * 这次没动过选择器）。失败一律吞掉 —— 镜像只是提示词优化，不能因为它挂掉插件。
 * @param {object} store - 会话存储。
 * @param {object} cache - {@link createSelectionCache} 的实例。
 * @returns {Promise<number>} 灌入的会话数。
 */
export async function hydrateSelectionCache(store, cache) {
  if (store === null || typeof store !== 'object' || typeof store.listSessions !== 'function') return 0
  const sessionIds = await store.listSessions()
  let filled = 0
  for (const sessionId of sessionIds) {
    const selected = await store.getSelected(sessionId)
    if (selected !== undefined) {
      cache.set(sessionId, selected)
      filled += 1
    }
  }
  return filled
}

/**
 * 注册「IMA 检索策略」系统提示词段（能力可选，缺了就不注册）。
 *
 * `systemPrompt` **刻意不进 `inject`**：它是锦上添花的通道，老宿主/精简 profile
 * 没有它时插件必须照常工作（工具描述与结果提示仍然生效）。所以这里做运行时探测，
 * 与 `storage` 的探测口径一致。
 *
 * @param {object} ctx - Cordis 宿主上下文。
 * @param {object} cache - {@link createSelectionCache} 的实例。
 * @param {object} [options] - 注入项（测试用）。
 * @param {object} [options.systemPrompt] - 显式传入的 `ctx.systemPrompt`。
 * @returns {boolean} 是否真的注册了。
 */
export function installPromptSection(ctx, cache, options = {}) {
  const systemPrompt = options.systemPrompt ?? (typeof ctx?.get === 'function' ? ctx.get('systemPrompt') : ctx?.systemPrompt)
  if (systemPrompt === null || typeof systemPrompt !== 'object' || typeof systemPrompt.section !== 'function') return false
  useEffect(ctx, () => {
    const dispose = systemPrompt.section({
      name: PROMPT_SECTION_NAME,
      order: PROMPT_SECTION_ORDER,
      // 段正文里没有 `{{...}}`，但知识库名之类的用户数据未来可能进来；关掉插值
      // 就不会因为一个 `{{` 让整次提示词组装失败。
      interpolate: false,
      text: (context) => {
        try {
          return buildRetrievalPolicyText(cache.get(context?.agent?.id))
        } catch {
          // 段正文抛错会让宿主整次组装失败 —— 宁可少一段，也不能让会话起不来。
          return ''
        }
      },
    })
    return typeof dispose === 'function' ? dispose : undefined
  }, 'ima-knowledge: prompt section')
  return true
}

/**
 * 建三个工具定义（SPEC §4）。`options.fetchImpl` 仅供测试注入。
 *
 * 会话级选中集（PLATFORM.md §9.4）：三个工具都用 `exec.agent.id` 定位当前会话。
 * `options.sessionStore` 由 {@link apply} 注入；测试可直连一个内存实现。
 * `exec` 缺失（老宿主/测试直调）时退化为全局默认值并在返回里标 `scope:'global'`。
 *
 * @param {object} credentials - ctx.credentials。
 * @param {object} [options] - 注入项（fetchImpl / sessionStore）。
 * @returns {Array<object>} 三个工具定义。
 */
function createTools(credentials, options = {}) {
  // 工具也要能走「自动重读桌面客户端」兜底，所以 desktop 注入面与路由保持一致。
  const io = {
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.desktop === undefined ? {} : { desktop: options.desktop }),
  }
  const sessionStore = options.sessionStore
  const selectionCache = options.selectionCache
  const imaKbList = {
    name: 'ima_kb_list',
    description: 'List every Tencent IMA knowledge base this account can access, marking which are currently selected in this session. Call it first when you are unsure whether a knowledge base is selected.',
    parameters: EMPTY_PARAMETERS,
    output: { schema: LIST_OUTPUT_SCHEMA, render: textRender },
    async execute(_args, exec) {
      const operation = 'ima_kb_list'
      const knowledgeBases = await withTokenRefresh(
        credentials,
        operation,
        (creds) => listKnowledgeBases(creds, io),
        io,
      )
      const resolved = await resolveSelected(credentials, sessionStore, sessionIdOf(exec))
      const selected = resolved.selected
      // 顺手把镜像刷新到最新事实：下一次提示词组装就能用上确定语气。
      if (resolved.scope === 'session') selectionCache?.set(resolved.sessionId, selected)
      const selectedSet = new Set(selected)
      return {
        knowledgeBases: knowledgeBases.map((kb) => ({
          id: kb.id,
          name: kb.name,
          selected: selectedSet.has(kb.id),
          // 分组是可选字段：判定不出来就整个键都不给（见 LIST_OUTPUT_SCHEMA 的注释）。
          ...(kb.group === undefined ? {} : { group: kb.group }),
        })),
        selected,
        selectedId: selected.length > 0 ? selected[0] : null,
        scope: resolved.scope,
        ...(resolved.sessionId === undefined ? {} : { sessionId: resolved.sessionId }),
      }
    },
  }

  const imaKbAsk = {
    name: 'ima_kb_ask',
    description: 'Ask the IMA-SIDE MODEL to answer a question from one knowledge base and return ITS summarized answer plus references. LOSSY: the sources are compressed by another model first, so original wording, detail, numbers and per-claim citations are lost. Do NOT use it as a substitute for retrieval. Use it only when (a) the user explicitly asks for IMA\'s own answer or conclusion, or (b) several ima_kb_search attempts found nothing. Default to ima_kb_search.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['question'],
      properties: {
        question: { type: 'string', description: 'The non-empty question to answer from the IMA knowledge base.' },
        knowledgeBaseId: { type: 'string', description: 'Knowledge-base ID; defaults to the first knowledge base selected in this session.' },
      },
    },
    output: { schema: ASK_OUTPUT_SCHEMA, render: hintRender(ASK_RESULT_HINT) },
    async execute(args, exec) {
      const operation = 'ima_kb_ask'
      const question = typeof args?.question === 'string' ? args.question.trim() : ''
      if (question.length === 0) throw new Error(`${operation}: question 不能为空`)
      const kbId = await selectKnowledgeBaseIdForSession(credentials, sessionStore, sessionIdOf(exec), args?.knowledgeBaseId, operation)
      const result = await withTokenRefresh(credentials, operation, (creds) =>
        askQuestion(creds, { kbId, question, signal: exec?.signal, ...io }), io)
      return { answer: result.answer, references: result.references }
    },
  }

  const imaKbSearch = {
    name: 'ima_kb_search',
    description: 'Search one connected Tencent IMA knowledge base and return RAW source passages (media id, title, highlighted snippet). PREFERRED and DEFAULT way to use IMA: you read the original passages and reason over them yourself. Use this instead of ima_kb_ask — ima_kb_ask makes the IMA-side model summarize first, which loses original wording, detail and citations. Call it repeatedly with different keywords rather than switching to ima_kb_ask.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'The non-empty search query.' },
        knowledgeBaseId: { type: 'string', description: 'Knowledge-base ID; defaults to the first knowledge base selected in this session.' },
        limit: { type: 'number', description: 'Number of passages to return (1-100). Defaults to the value configured in the plugin settings (10 unless the user changed it).' },
      },
    },
    output: { schema: SEARCH_OUTPUT_SCHEMA, render: hintRender(SEARCH_RESULT_HINT) },
    async execute(args, exec) {
      const operation = 'ima_kb_search'
      const query = typeof args?.query === 'string' ? args.query.trim() : ''
      if (query.length === 0) throw new Error(`${operation}: query 不能为空`)
      const kbId = await selectKnowledgeBaseIdForSession(credentials, sessionStore, sessionIdOf(exec), args?.knowledgeBaseId, operation)
      // 显式 limit 优先（收敛到 1-100）；缺省时用插件设置里的检索条数（默认 10）。
      const limit = typeof args?.limit === 'number' && Number.isFinite(args.limit) && args.limit > 0
        ? Math.min(MAX_SEARCH_LIMIT, Math.max(MIN_SEARCH_LIMIT, Math.floor(args.limit)))
        : await readSearchLimit(credentials)
      const items = await withTokenRefresh(credentials, operation, (creds) =>
        searchKnowledge(creds, { kbId, query, limit, signal: exec?.signal, ...io }), io)
      return { items }
    },
  }

  return [imaKbList, imaKbAsk, imaKbSearch]
}

/**
 * 工具侧的「定一个库 id」：显式入参 > 当前会话选中集 > 报错。
 *
 * 三条硬规则（PLATFORM.md §9.4）：
 *  1. 显式 `knowledgeBaseId` 照旧优先，**不受会话选中集影响**（连会话存储都不读）；
 *  2. 缺省时用**当前会话**的选中集；
 *  3. 会话选中集为空（含「明确不选」`[]`）→ **抛明确错误**，**禁止回退全局默认值**。
 *
 * 与 {@link selectKnowledgeBaseId} 的区别：那个是纯函数（给路由/单测复用），这个
 * 负责先解析会话作用域。空集时的错误文案里带 {@link SESSION_SELECT_HINT}。
 *
 * @param {object} credentials - ctx.credentials。
 * @param {object} [store] - 会话存储。
 * @param {string|undefined} sessionId - 当前会话 id。
 * @param {string|undefined} requested - 调用方显式指定的 id。
 * @param {string} operation - 操作名。
 * @returns {Promise<string>} 库 id。
 */
async function selectKnowledgeBaseIdForSession(credentials, store, sessionId, requested, operation) {
  const explicit = typeof requested === 'string' ? requested.trim() : ''
  if (explicit.length > 0) return explicit
  const resolved = await resolveSelected(credentials, store, sessionId)
  if (resolved.selected.length > 0) return resolved.selected[0]
  // 会话域有上下文（scope==='session'）时用「本会话未选择」文案；老宿主用老文案。
  if (resolved.scope === 'session') {
    throw new Error(`${operation}: ${SESSION_SELECT_HINT}；${SELECT_HINT}`)
  }
  throw new Error(`${operation}: 还没有选中任何知识库；${SELECT_HINT}`)
}

/**
 * 签到路由 / 调度器共用的 IO（只透传测试注入项，生产全部走默认实现）。
 * @param {object} [options] - apply 的配置。
 * @returns {object} 传给 lib/checkin.js 的 options。
 */
function checkinIo(options = {}) {
  return {
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.checkinTimeoutMs === undefined ? {} : { timeoutMs: options.checkinTimeoutMs }),
    // `desktop` 仅测试注入：token 过期时 recoverCredentials 会去读 IMA 桌面客户端。
    ...(options.desktop === undefined ? {} : { desktop: options.desktop }),
  }
}

/**
 * 归一化状态 → 路由 value 里的 `today` 视图（CHECKIN.md §4）。
 * @param {object} status - `runCheckin` / `getCheckinStatus` 的归一化状态。
 * @param {number} [nowMs] - 当前时间（测试注入）。
 * @returns {{date: string, checked: boolean, status: number|null, reward: string|null}} today 视图。
 */
function checkinTodayOf(status, nowMs = Date.now()) {
  return {
    date: formatLocalDate(nowMs),
    checked: status?.today?.checked === true,
    status: typeof status?.today?.status === 'number' ? status.today.status : null,
    reward: typeof status?.today?.reward === 'string' ? status.today.reward : null,
  }
}

/**
 * 归一化状态 → 路由 value 里的 `week` 视图（CHECKIN.md §4）。
 * @param {object} status - 归一化状态。
 * @returns {{checkinDays: number, totalRewardPoints: number, bonusAvailable: boolean}} week 视图。
 */
function checkinWeekOf(status) {
  return {
    checkinDays: typeof status?.checkinDays === 'number' ? status.checkinDays : 0,
    totalRewardPoints: typeof status?.totalRewardPoints === 'number' ? status.totalRewardPoints : 0,
    bonusAvailable: status?.bonus?.available === true,
  }
}

/**
 * 判断「查签到状态失败」时 `tokenValid` 该给什么值（CHECKIN.md §4）。
 *
 * 三种情况：
 *  - `ImaApiError` 且分类是 token-expired / session-expired → `false`（确实失效）；
 *  - `withTokenRefresh` 的兜底恢复也失败（抛的是普通 Error，message 里带
 *    「自动续期失败 / 请重新登录」）→ `false`（token 已无法自动续期，用户必须重新登录）；
 *  - 其它（网络 / 上游形状异常）→ `'unknown'`（不假报 true 也不假报 false）。
 *
 * @param {unknown} error - 查状态抛出的错误。
 * @returns {boolean|'unknown'} tokenValid 字段值。
 */
function checkinTokenValidOf(error) {
  if (error instanceof ImaApiError) {
    const classified = classifyError(error.code)
    return classified.needsRefresh || classified.needsRelogin ? false : 'unknown'
  }
  const message = error instanceof Error ? error.message : String(error)
  if (/自动续期失败|请在 IMA 桌面客户端重新登录/u.test(message)) return false
  return 'unknown'
}

/**
 * 跑一轮签到（宿主侧包装）。
 *
 * 三条约定：
 *  1. **凭据未配置 → 静默跳过**：返回 `{skipped:true}`，让调度器不写失败历史（否则每小时刷记录）；
 *  2. 网络/鉴权走 {@link withTokenRefresh}（到期前主动续期 + 撞 41 自动恢复）；
 *  3. `runCheckin` 把「领取失败」收进 `errors`（契约要求返回该数组），这里折叠成异常，
 *     让调度器把 `lastRun.ok` 记成 false —— 否则失败会被当成成功写进账本。
 *
 * @param {object} credentials - ctx.credentials。
 * @param {object} io - {@link checkinIo} 的结果。
 * @param {string} operation - 操作名（错误信息用）。
 * @returns {Promise<object>} `runCheckin` 的结果，或 `{skipped:true}`。
 */
async function performCheckin(credentials, io, operation) {
  const cookie = await readOptionalCredential(credentials, IMA_X_IMA_COOKIE_REF)
  if (cookie === undefined) return { skipped: true, reason: 'credentials-not-configured' }
  const result = await withTokenRefresh(credentials, operation, (creds) => runCheckin(creds, io), io)
  if (Array.isArray(result?.errors) && result.errors.length > 0) {
    // runCheckin 的 errors 按契约是数组（元素为字符串）；从首条里回捞上游 code，
    // 让宿主错误码仍能映射到 bad-request / token-expired 等既有分类。
    const matched = /\(code (\d+)\)/u.exec(result.errors[0])
    const code = matched === null ? undefined : Number(matched[1])
    throw new ImaApiError(`签到未完全成功：${result.errors.join('；')}`, {
      operation,
      ...(code === undefined ? {} : { code, kind: classifyError(code).kind }),
    })
  }
  return result
}

/**
 * 建三条自动签到路由（CHECKIN.md §4）。
 *
 * @param {object} credentials - ctx.credentials。
 * @param {object} options - 依赖。
 * @param {object} options.store - 签到存储（`read` / `setConfig`）。
 * @param {object} [options.scheduler] - 调度器（`runNow` / `start`）；缺省时 `/run` 返回内部错误。
 * @param {object} [options.io] - 签到 IO（fetchImpl / timeoutMs / desktop）。
 * @returns {Array<object>} 路由定义。
 */
function createCheckinRoutes(credentials, options = {}) {
  const store = options.store
  const scheduler = options.scheduler
  const io = options.io ?? {}
  const configBase = (state) => ({
    enabled: state.config.enabled,
    time: state.config.time,
    history: state.history,
    lastRun: state.lastRun,
  })

  const statusRoute = {
    path: ROUTE_CHECKIN_STATUS,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch() {
      try {
        const state = await store.read()
        const base = configBase(state)
        const info = await credentials.describe(IMA_X_IMA_COOKIE_REF)
        const configured = info !== null && typeof info === 'object' && info.configured === true
        if (!configured) {
          // 凭据未配置是**合法业务状态**，不是 HTTP 错误（契约 §4）。
          return okJson({
            configured: false,
            tokenValid: false,
            ...base,
            today: null,
            week: null,
            error: {
              code: ERROR_CODES.notConfigured,
              message: `未配置 ${IMA_X_IMA_COOKIE_REF}；${CONFIG_HINT}`,
            },
          })
        }
        try {
          // 必须真的打一次上游：面板打开时看到的是实时状态。
          const status = await withTokenRefresh(
            credentials,
            'ima_kb_checkin_status',
            (creds) => getCheckinStatus(creds, io),
            io,
          )
          return okJson({
            configured: true,
            tokenValid: true,
            ...base,
            today: checkinTodayOf(status),
            week: checkinWeekOf(status),
          })
        } catch (error) {
          // token 失效（续期 + 自动重读桌面客户端都失败）→ tokenValid:false + 人话 error；
          // 其它失败（网络 / 形状异常）→ tokenValid:'unknown'，不假报 true 也不假报 false。
          const tokenValid = checkinTokenValidOf(error)
          const detail = tokenValid === false && !(error instanceof ImaApiError)
            ? {
              code: ERROR_CODES.tokenExpired,
              message: 'IMA token 已失效，且自动续期与自动重读桌面客户端都没成功：'
                + `${error instanceof Error ? error.message : String(error)}`,
            }
            : errorOf(error)
          return okJson({
            configured: true,
            tokenValid,
            ...base,
            today: null,
            week: null,
            error: detail,
          })
        }
      } catch (error) {
        return failFromError(error)
      }
    },
  }

  const runRoute = {
    path: ROUTE_CHECKIN_RUN,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch() {
      try {
        if (scheduler === undefined || typeof scheduler.runNow !== 'function') {
          return failJson(ERROR_CODES.internal, '签到调度器未初始化')
        }
        // 走调度器：手动与定时共用单飞、结果落 lastRun/history、结束后重新 arm。
        const result = await scheduler.runNow('manual')
        const latest = await store.read()
        if (result !== null && typeof result === 'object' && result.skipped === true) {
          return okJson({
            configured: false,
            checked: false,
            alreadyChecked: false,
            claimed: { daily: false, bonus: false },
            reward: 0,
            total: 0,
            today: null,
            week: null,
            lastRun: latest.lastRun,
            error: {
              code: ERROR_CODES.notConfigured,
              message: `未配置 ${IMA_X_IMA_COOKIE_REF}；${CONFIG_HINT}`,
            },
          })
        }
        return okJson({
          checked: result?.checked === true,
          alreadyChecked: result?.alreadyChecked === true,
          claimed: {
            daily: result?.claimed?.daily === true,
            bonus: result?.claimed?.bonus === true,
          },
          reward: typeof result?.reward === 'number' && Number.isFinite(result.reward) ? result.reward : 0,
          total: typeof result?.total === 'number' && Number.isFinite(result.total) ? result.total : 0,
          today: checkinTodayOf(result?.status),
          week: checkinWeekOf(result?.status),
          lastRun: latest.lastRun,
        })
      } catch (error) {
        return failFromError(error)
      }
    },
  }

  const configRoute = {
    path: ROUTE_CHECKIN_CONFIG,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      const body = await readBody(request)
      /** @type {{enabled?: boolean, time?: string}} */
      const patch = {}
      if (body?.enabled !== undefined) {
        if (typeof body.enabled !== 'boolean') {
          return failJson(ROUTE_ERROR_CODES.badRequest, 'enabled 必须是布尔值')
        }
        patch.enabled = body.enabled
      }
      if (body?.time !== undefined) {
        if (!isValidCheckinTime(body.time)) {
          return failJson(ROUTE_ERROR_CODES.badRequest, 'time 必须是 HH:mm')
        }
        patch.time = body.time
      }
      try {
        const config = await store.setConfig(patch)
        // 配置一变立刻重排定时器：enabled=false 时 start() 会清掉定时器；
        // 改时间则按新 HH:mm 重新计算（今天还没到就今天，否则明天）。
        scheduler?.start?.()
        return okJson({ enabled: config.enabled, time: config.time })
      } catch (error) {
        return failFromError(error)
      }
    },
  }

  return [statusRoute, runRoute, configRoute]
}

/**
 * 建 HTTP 路由（SPEC §5 + PLATFORM §2.2/§8.2/§9.5），返回 disposer 数组。
 *
 * `options.sessionStore` 由 {@link apply} 注入；缺省时 `createRoutes` 自建一个
 * 纯内存实现 —— 只影响测试直调，生产永远走 apply 的注入实例。
 *
 * @param {object} credentials - ctx.credentials。
 * @param {object} [options] - 注入项（fetchImpl / desktop / sessionStore / checkinStore / checkinScheduler）。
 * @returns {Array<object>} 路由定义。
 */
function createRoutes(credentials, options = {}) {
  const io = {
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    // `desktop` 仅测试注入（假文件系统 / 假 DPAPI），生产不传 → handleDesktopSyncAction
    // 回落到 lib/desktop-sync.js 的真实默认依赖。
    ...(options.desktop === undefined ? {} : { desktop: options.desktop }),
  }
  const sessionStore = options.sessionStore ?? createMemorySessionStore()
  const selectionCache = options.selectionCache
  // 自动签到：apply 会注入 store / scheduler；直调 createRoutes（测试）时自建内存 store，
  // 调度器缺省 → `/checkin/run` 返回内部错误（生产永远由 apply 注入）。
  const checkinStore = options.checkinStore ?? createCheckinStore({ file: false })
  const checkinRoutes = createCheckinRoutes(credentials, {
    store: checkinStore,
    scheduler: options.checkinScheduler,
    io: checkinIo(options),
  })
  const listRoute = {
    path: ROUTE_LIST,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      try {
        // PLATFORM.md §9.5：请求体可选 `{sessionId}`；缺省退化为全局默认值（兼容旧调用）。
        const body = await readBody(request)
        const sessionId = normalizeSessionId(body?.sessionId)
        const resolved = await resolveSelected(credentials, sessionStore, sessionId)
        const selected = resolved.selected
        const knowledgeBases = await withTokenRefresh(
          credentials, 'ima_kb_list', (creds) => listKnowledgeBases(creds, io), io,
        )
        const selectedSet = new Set(selected)
        return okJson({
          knowledgeBases: knowledgeBases.map((kb) => ({
            id: kb.id,
            name: kb.name,
            selected: selectedSet.has(kb.id),
            // PLATFORM.md §2.1：`group?: 'personal' | 'joined'`，可选；
            // 判定不出来时**不给这个键**（前端据此全落「个人知识库」）。
            ...(kb.group === undefined ? {} : { group: kb.group }),
          })),
          selected,
          // §9.5 的可选诊断字段（只在真的有会话上下文时给，保持旧调用形状不变）。
          ...(resolved.sessionId === undefined ? {} : { sessionId: resolved.sessionId, inherited: resolved.inherited }),
          status: {
            configured: true,
            tokenValid: true,
          },
        })
      } catch (error) {
        return failFromError(error)
      }
    },
  }

  const selectRoute = {
    path: ROUTE_SELECT,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      try {
        const body = await readBody(request)
        const rawIds = body?.ids
        if (!Array.isArray(rawIds)) {
          return failJson(ERROR_CODES.badRequest, 'body 必须是 {"ids": string[]}')
        }
        if (rawIds.some((id) => typeof id !== 'string' || id.trim().length === 0)) {
          return failJson(ERROR_CODES.badRequest, 'ids 里每一项都必须是非空字符串')
        }
        if (body?.sessionId !== undefined && normalizeSessionId(body.sessionId) === undefined) {
          return failJson(ERROR_CODES.badRequest, 'body.sessionId 必须是非空字符串')
        }
        const sessionId = normalizeSessionId(body?.sessionId)
        const ids = [...new Set(rawIds.map((id) => id.trim()))]
        // 空数组是**合法业务状态**，语义 = 「该作用域明确不选」。
        // 会话级写 `{ids:[]}`（记录存在且为空）；全局级仍走 unset（ref 真正消失），
        // 两者都保证「之后读到的是空集」而不是「无记录」—— §9.3 的核心区分。
        if (ids.length === 0) {
          if (sessionId !== undefined) {
            await sessionStore.setSelected(sessionId, [])
            // 选择器一改就同步镜像：下一次模型步骤的提示词段立刻切到「已选中/未选中」。
            selectionCache?.set(sessionId, [])
            return okJson({ selected: [], sessionId })
          }
          await unsetCredential(credentials, IMA_KNOWLEDGE_BASE_IDS_REF)
          return okJson({ selected: [] })
        }
        // 非空时对照账号真实可访问的库校验 id，挡住手填/过期的 id（不静默接受未知 id）。
        const knowledgeBases = await withTokenRefresh(
          credentials, 'ima_kb_select', (creds) => listKnowledgeBases(creds, io), io,
        )
        const known = new Set(knowledgeBases.map((kb) => kb.id))
        const unknown = ids.filter((id) => !known.has(id))
        if (unknown.length > 0) {
          return failJson(
            ERROR_CODES.unknownKnowledgeBase,
            `这些知识库 id 不在当前账号可访问列表里：${unknown.join(', ')}。请刷新列表后重新勾选。`,
          )
        }
        if (sessionId !== undefined) {
          // §9.5：有 sessionId 写会话级，**不动**全局默认值（会话隔离的根）。
          const saved = await sessionStore.setSelected(sessionId, ids)
          selectionCache?.set(sessionId, saved)
          return okJson({ selected: saved, sessionId })
        }
        await writeCredential(credentials, IMA_KNOWLEDGE_BASE_IDS_REF, ids.join(', '))
        return okJson({ selected: ids })
      } catch (error) {
        return failFromError(error)
      }
    },
  }

  /**
   * `/session-state`（PLATFORM.md §9.5 新增）：
   * `{sessionId}` → `{selected, inherited}`。
   * `inherited:true` 表示该会话尚无自己的记录、当前值来自全局默认值。
   */
  const sessionStateRoute = {
    path: ROUTE_SESSION_STATE,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      try {
        const body = await readBody(request)
        const sessionId = normalizeSessionId(body?.sessionId)
        if (sessionId === undefined) {
          return failJson(ERROR_CODES.badRequest, 'body 必须是 {"sessionId": string}')
        }
        const resolved = await resolveSelected(credentials, sessionStore, sessionId)
        return okJson({
          selected: resolved.selected,
          inherited: resolved.inherited,
          sessionId,
        })
      } catch (error) {
        return failFromError(error)
      }
    },
  }

  /**
   * `/settings`（v5 新增）：检索条数的读写。
   *
   * 写侧**严格校验**（不静默收敛）：越界 / 小数 / 非数字一律 BAD_REQUEST，
   * 让 UI 的输入约束与宿主判定保持一致；读侧才容忍脏值（见 {@link normalizeSearchLimit}）。
   */
  const settingsRoute = {
    path: ROUTE_SETTINGS,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      const body = await readBody(request)
      const action = typeof body?.action === 'string' ? body.action.trim().toLowerCase() : ''
      if (action !== 'get' && action !== 'set') {
        return failJson(ROUTE_ERROR_CODES.badRequest, 'body.action 必须是 "get" | "set"')
      }
      const envelope = (searchLimit) => okJson({
        searchLimit,
        min: MIN_SEARCH_LIMIT,
        max: MAX_SEARCH_LIMIT,
        default: DEFAULT_SEARCH_LIMIT,
      })
      try {
        if (action === 'get') return envelope(await readSearchLimit(credentials))
        const raw = body?.searchLimit
        const numeric = typeof raw === 'number'
          ? raw
          : (typeof raw === 'string' && raw.trim() !== '' ? Number(raw.trim()) : Number.NaN)
        if (!Number.isInteger(numeric) || numeric < MIN_SEARCH_LIMIT || numeric > MAX_SEARCH_LIMIT) {
          return failJson(
            ROUTE_ERROR_CODES.badRequest,
            `body.searchLimit 必须是 ${MIN_SEARCH_LIMIT}-${MAX_SEARCH_LIMIT} 之间的整数`,
          )
        }
        await writeCredential(credentials, IMA_KNOWLEDGE_SEARCH_LIMIT_REF, String(numeric))
        return envelope(numeric)
      } catch (error) {
        // 与 /credentials 同一套只读判定：provider 不可写时给专门的码，
        // 前端据此提示「去设置里手改」而不是笼统的 internal。
        const message = error instanceof Error ? error.message : String(error)
        if (/不可写|不可删|read-?only|writable/iu.test(message)) {
          return failJson(ROUTE_ERROR_CODES.credentialReadonly, message)
        }
        return failFromError(error)
      }
    },
  }

  const statusRoute = {
    path: ROUTE_STATUS,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch() {
      try {
        const info = await credentials.describe(IMA_X_IMA_COOKIE_REF)
        const configured = info !== null && typeof info === 'object' ? info.configured === true : false
        if (!configured) {
          return okJson({
            configured: false,
            tokenValid: false,
            error: { code: ERROR_CODES.notConfigured, message: `未配置 ${IMA_X_IMA_COOKIE_REF}；${CONFIG_HINT}` },
          })
        }
        // tokenValid 用一次最廉价的列库调用实测：41 = 过期，其它网络错误 = unknown（不假报 true）。
        // 先走「到期前主动续期」，撞 41 再走「续期 → 自动重读桌面客户端」兜底 ——
        // 面板打开时看到的不再是「本可自愈的过期」。
        try {
          const creds = await ensureFreshCredentials(credentials, 'ima_kb_status', io)
          await listKnowledgeBases({ cookie: creds.cookie, bkn: creds.bkn }, { pageSize: 1, ...io })
          return okJson({ configured: true, tokenValid: true })
        } catch (error) {
          const code = error instanceof ImaApiError ? error.code : undefined
          const classified = classifyError(code)
          if (classified.needsRefresh) {
            try {
              const recovered = await recoverCredentials(credentials, 'ima_kb_status', io)
              await listKnowledgeBases({ cookie: recovered.cookie, bkn: recovered.bkn }, { pageSize: 1, ...io })
              return okJson({ configured: true, tokenValid: true })
            } catch (recoverError) {
              return okJson({
                configured: true,
                tokenValid: false,
                error: {
                  code: ERROR_CODES.tokenExpired,
                  message: 'IMA token 已过期，自动续期与自动重读桌面客户端都没成功：'
                    + `${recoverError instanceof Error ? recoverError.message : String(recoverError)}。`
                    + '请在 IMA 桌面客户端重新登录后，点面板里的「从 IMA 桌面客户端同步」。',
                },
              })
            }
          }
          if (classified.needsRelogin) {
            return okJson({
              configured: true,
              tokenValid: false,
              error: { code: ERROR_CODES.sessionExpired, message: 'IMA 会话已彻底过期（code 110031），请重新登录并更新 cookie。' },
            })
          }
          const detail = errorOf(error)
          return okJson({
            configured: true,
            tokenValid: 'unknown',
            error: { code: detail.code, message: `无法判定 token 状态：${detail.message}` },
          })
        }
      } catch (error) {
        return failFromError(error)
      }
    },
  }

  const credentialsRoute = {
    path: ROUTE_CREDENTIALS,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      const body = await readBody(request)
      const action = typeof body?.action === 'string' ? body.action.trim().toLowerCase() : ''
      if (action !== 'get' && action !== 'set' && action !== 'clear') {
        return failJson(ROUTE_ERROR_CODES.badRequest, 'body.action 必须是 "get" | "set" | "clear"')
      }
      try {
        return await handleCredentialsAction(credentials, action, body, io)
      } catch (error) {
        // 凭据 provider 不可写/不可删：契约要求专门的 CREDENTIAL_READONLY 码，
        // 不能混进 internal（前端要据此隐藏「保存」并提示去设置页手填）。
        const message = error instanceof Error ? error.message : String(error)
        if (/不可写|不可删|read-?only|writable/iu.test(message)) {
          return failJson(ROUTE_ERROR_CODES.credentialReadonly, message)
        }
        return failFromError(error)
      }
    },
  }

  const mediaRoute = {
    path: ROUTE_MEDIA,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      const body = await readBody(request)
      const query = typeof body?.query === 'string' ? body.query.trim() : ''
      if (query.length === 0) {
        return failJson(ROUTE_ERROR_CODES.badRequest, 'body.query 必须是非空字符串')
      }
      if (body?.kbIds !== undefined && !Array.isArray(body.kbIds)) {
        return failJson(ROUTE_ERROR_CODES.badRequest, 'body.kbIds 必须是 string[]')
      }
      if (Array.isArray(body?.kbIds) && body.kbIds.some((id) => typeof id !== 'string' || id.trim().length === 0)) {
        return failJson(ROUTE_ERROR_CODES.badRequest, 'kbIds 里每一项都必须是非空字符串')
      }
      try {
        // §9.6：媒体检索也必须按会话取选中集。否则会出现「chip 显示会话 A 的库、
        // 媒体检索却查会话 B」——与三个工具的行为不一致。
        return await handleMediaQuery(credentials, body, io, sessionStore)
      } catch (error) {
        return failFromError(error)
      }
    },
  }

  const desktopSyncRoute = {
    path: ROUTE_DESKTOP_SYNC,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      const body = await readBody(request)
      const action = typeof body?.action === 'string' ? body.action.trim().toLowerCase() : ''
      if (action !== 'probe' && action !== 'sync') {
        return failJson(ROUTE_ERROR_CODES.badRequest, 'body.action 必须是 "probe" | "sync"')
      }
      try {
        return await handleDesktopSyncAction(credentials, action, io)      } catch (error) {
        // 契约（PLATFORM.md §8.2）要求 probe/sync 一律 `ok:true` + 人话 error；
        // 走到这里是意料之外的本地错误，也按业务失败折叠，但绝不把明文带出去。
        return okJson({
          available: false,
          isLogin: false,
          reason: `同步桌面客户端凭据时发生未预期错误：${error instanceof Error ? error.message : String(error)}`,
        })
      }
    },
  }

  return [
    listRoute,
    selectRoute,
    sessionStateRoute,
    statusRoute,
    credentialsRoute,
    mediaRoute,
    desktopSyncRoute,
    settingsRoute,
    ...checkinRoutes,
  ]
}

/**
 * `/credentials` 的业务实现（三动作）。
 *
 * 三条硬约束（PLATFORM.md §2.2）：
 * 1. `get` **绝不**返回完整 cookie/bkn，只返回布尔 + 掩码；
 * 2. `set` 先校验再落盘 —— 用候选凭据真调一次 `listKnowledgeBases`，成功才写；
 *    失败是**业务失败**，HTTP 200 + `ok:true` + `tokenValid:false` + `error`；
 * 3. `clear` 只删 cookie/bkn 两个 ref，`IMA_KNOWLEDGE_BASE_IDS`（选择集）不动。
 *
 * @param {object} credentials - ctx.credentials。
 * @param {'get'|'set'|'clear'} action - 已校验的动作。
 * @param {object|undefined} body - 请求体。
 * @param {{fetchImpl?: typeof fetch}} io - 仅测试注入的 IO。
 * @returns {Promise<Response>} 统一信封响应。
 */
async function handleCredentialsAction(credentials, action, body, io) {
  if (action === 'get') {
    const [cookie, storedBkn, cookieInfo] = await Promise.all([
      readOptionalCredential(credentials, IMA_X_IMA_COOKIE_REF),
      readOptionalCredential(credentials, IMA_X_IMA_BKN_REF),
      credentials.describe(IMA_X_IMA_COOKIE_REF),
    ])
    const hasCookie = cookie !== undefined
    const hasBkn = storedBkn !== undefined
    const source = cookieInfo !== null && typeof cookieInfo === 'object' ? cookieInfo.source : undefined
    // account.uid 只从 cookie 的 IMA-UID 解析（唯一权威来源）；nickname/guid/openid/type
    // 需要 IMA 侧接口，拿不到就不给字段 —— 不伪造、也不因此让 get 失败。
    const account = hasCookie ? accountFromCookie(cookie) : undefined
    return okJson({
      configured: hasCookie,
      hasCookie,
      hasBkn,
      // 掩码字段只在「有值」时出现：空对象比 `cookieMasked: undefined` 更好消费。
      ...(hasCookie ? { cookieMasked: maskCookie(cookie) } : {}),
      ...(hasBkn ? { bknMasked: maskBkn(storedBkn) } : {}),
      ...(typeof source === 'string' && source.length > 0 ? { source } : {}),
      ...(account === undefined ? {} : { account }),
    })
  }

  if (action === 'clear') {
    // 只清 cookie/bkn/到期时间；选择集是另一个语义（「我接入了哪些库」），保留。
    for (const ref of [IMA_X_IMA_COOKIE_REF, IMA_X_IMA_BKN_REF, IMA_X_IMA_TOKEN_EXPIRES_AT_REF]) {
      const info = await credentials.describe(ref)
      const present = info !== null && typeof info === 'object' && info.configured === true
      if (!present) continue
      await unsetCredential(credentials, ref)
    }
    return okJson({ configured: false })
  }

  // action === 'set'：先规范化，再校验，最后落盘。
  const rawCookie = typeof body?.cookie === 'string' ? body.cookie : ''
  const cookie = normalizeHeaderValue(rawCookie)
  if (cookie.length === 0) {
    return failJson(ROUTE_ERROR_CODES.badRequest, 'body.cookie 必须是非空字符串（完整 x-ima-cookie 头值）')
  }
  const rawBkn = typeof body?.bkn === 'string' ? normalizeHeaderValue(body.bkn) : ''
  const explicitBkn = rawBkn.length === 0 ? undefined : rawBkn
  let candidateBkn = explicitBkn
  if (candidateBkn === undefined) {
    const token = parseCookie(cookie).token
    if (token === undefined || token.length === 0) {
      return okJson({
        configured: true,
        tokenValid: false,
        error: 'cookie 里没有 IMA-TOKEN，无法推导 x-ima-bkn；请重新复制完整 cookie，或单独填写 bkn。',
      })
    }
    candidateBkn = getBkn(token)
  }

  // ① 用候选凭据真打一次最廉价的列库请求（pageSize=1）。成功 = 凭据可用。
  try {
    await listKnowledgeBases({ cookie, bkn: candidateBkn }, { pageSize: 1, ...io })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // 契约（PLATFORM.md §2.2）把 `set` 的返回钉成 `{configured:true, tokenValid:false, error}`：
    // 「配置过账号」是这次操作的语境，`tokenValid` 才是校验结论。真实落盘状态由随后的
    // `get` 校正（浏览器侧保存后本来就会 refresh 一次），所以这里不改成 false 去猜。
    return okJson({
      configured: true,
      tokenValid: false,
      error: `凭据校验失败，未保存：${message}`,
    })
  }

  // ② 校验通过才写。显式 bkn 才写；否则清掉可能过期的旧 bkn，让运行时按新 token 推导
  //    （否则「换了 cookie 但 bkn 还是旧的」会让之后所有请求都 41/失败）。
  if (explicitBkn !== undefined) {
    await writeCredential(credentials, IMA_X_IMA_BKN_REF, explicitBkn)
  } else {
    const staleBkn = await readOptionalCredential(credentials, IMA_X_IMA_BKN_REF)
    if (staleBkn !== undefined) await unsetCredential(credentials, IMA_X_IMA_BKN_REF)
  }
  await writeCredential(credentials, IMA_X_IMA_COOKIE_REF, cookie)
  // 手填 cookie 的到期时间未知：清掉旧记录，避免「旧到期时间 + 新 cookie」触发一次无谓续期。
  const staleExpiry = await readOptionalCredential(credentials, IMA_X_IMA_TOKEN_EXPIRES_AT_REF)
  if (staleExpiry !== undefined) await unsetCredential(credentials, IMA_X_IMA_TOKEN_EXPIRES_AT_REF)
  // set 成功后同样回 account（uid 来自刚校验通过的这份 cookie）。
  const account = accountFromCookie(cookie)
  return okJson({ configured: true, tokenValid: true, ...(account === undefined ? {} : { account }) })
}

/**
 * `/desktop-sync` 的业务实现（PLATFORM.md §8.2）。
 *
 * 两个动作：
 * - `probe`：只读探测桌面客户端（安装 / 登录 / token 状态），**零写入**；
 * - `sync`：解密 → （token 过期则 `refreshToken` 续期）→ `listKnowledgeBases` 校验
 *   → **成功才** `credentials.set`（cookie + bkn）。
 *
 * 三条硬约束：
 * 1. 失败一律 `ok:true` + 人话 `error`/`reason`（凭据问题不是 HTTP 错误）；
 * 2. 校验不过 **零写入**（否则坏凭据会顶掉用户手上还能用的一份）；
 * 3. 解密出的 token / refresh token / cookie **绝不进响应体**（也不进日志）——
 *    本函数内没有一行 console，错误文案里只出现「缺哪个键」，不出现值。
 *
 * @param {object} credentials - ctx.credentials。
 * @param {'probe'|'sync'} action - 已校验的动作。
 * @param {{fetchImpl?: typeof fetch, desktop?: object}} io - 仅测试注入的 IO。
 * @returns {Promise<Response>} 统一信封响应。
 */
async function handleDesktopSyncAction(credentials, action, io) {
  const desktop = io?.desktop !== null && typeof io?.desktop === 'object' ? io.desktop : {}

  if (action === 'probe') {
    // probeDesktopClient 自身契约是「不抛错」，这里再兜一层：路由绝不因探测失败而失败。
    try {
      const probed = await probeDesktopClient(desktop)
      return okJson(probed)
    } catch (error) {
      return okJson({
        available: false,
        isLogin: false,
        reason: `探测 IMA 桌面客户端失败：${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }

  // action === 'sync'
  // 与自动兜底共用同一条逻辑（syncDesktopCredentials）：先校验再落盘、失败零写入。
  const synced = await syncDesktopCredentials(credentials, io)
  if (synced.nonWindows === true) {
    // 非 Windows 是平台限制，不是失败态：按契约原样给出 available:false。
    return okJson({ available: false, isLogin: false, reason: NON_WINDOWS_REASON })
  }
  if (!synced.ok) {
    return okJson({ configured: false, tokenValid: false, error: synced.error })
  }
  // account 直接取 open_info（字段缺失就不给，不伪造）；uid 已由 desktop-sync 保证。
  return okJson({ configured: true, tokenValid: true, account: synced.account })
}

/**
 * `/media` 的业务实现：跨库聚合检索。
 *
 * 库集合的取法：显式 `kbIds` > 当前选中集 > 全部可访问库（**最多前 3 个**）。
 * 逐库检索，单库失败只记进 `error` 字段，其余照返（PLATFORM.md §2.2）。
 *
 * @param {object} credentials - ctx.credentials。
 * @param {object} body - 已校验的请求体（`{query, kbIds?, limit?}`）。
 * @param {{fetchImpl?: typeof fetch}} io - 仅测试注入的 IO。
 * @returns {Promise<Response>} 统一信封响应。
 */
async function handleMediaQuery(credentials, body, io, sessionStore) {
  const query = body.query.trim()
  const limit = typeof body.limit === 'number' && Number.isFinite(body.limit) && body.limit > 0
    ? Math.floor(body.limit)
    : 10

  const runtime = await readRuntimeCredentials(credentials, 'ima_kb_media')
  const explicitIds = Array.isArray(body.kbIds)
    ? [...new Set(body.kbIds.map((id) => id.trim()))]
    : undefined
  // §9.6：显式 kbIds 优先；否则取**当前会话**的选中集（与三个工具一致）。
  // 会话显式空集（[]）在这里表现为 selected.length === 0 → 走下面的空集报错，
  // 不会回退到全局默认值——与 ima_kb_ask/search 的语义保持一致。
  let selected
  if (explicitIds !== undefined && explicitIds.length > 0) {
    selected = explicitIds
  } else if (sessionStore !== undefined && typeof body.sessionId === 'string' && body.sessionId.trim() !== '') {
    const resolved = await resolveSelected(credentials, sessionStore, body.sessionId)
    selected = resolved.selected
  } else {
    selected = runtime.selected
  }

  // 库名要靠列库接口解析；列库失败时，显式 kbIds 仍可降级检索（kbName 用 id 兜底）。
  /** @type {Map<string, string>} */
  let names = new Map()
  /** @type {string|undefined} */
  let listError
  try {
    const knowledgeBases = await withTokenRefresh(
      credentials, 'ima_kb_media', (creds) => listKnowledgeBases(creds, io), io,
    )
    names = new Map(knowledgeBases.map((kb) => [kb.id, kb.name]))
  } catch (error) {
    if (selected.length === 0) throw error
    listError = `无法读取知识库列表（库名回退为 id）：${error instanceof Error ? error.message : String(error)}`
  }

  let kbIds = selected
  if (kbIds.length === 0) {
    // 无选中集 → 全部可访问库，但按契约只取前 N 个，避免 N 次请求打爆上游。
    kbIds = [...names.keys()].slice(0, MAX_MEDIA_KNOWLEDGE_BASES)
    if (kbIds.length === 0) return okJson({ items: [] })
  }

  /** @type {Array<{mediaId: string, title: string, kbId: string, kbName: string, highlight?: string}>} */
  const items = []
  const seen = new Set()
  const failures = []
  for (const kbId of kbIds) {
    try {
      const hits = await withTokenRefresh(credentials, 'ima_kb_media', (creds) =>
        searchKnowledge(creds, { kbId, query, limit, ...io }), io)
      const kbName = names.get(kbId) ?? kbId
      for (const hit of hits) {
        const mediaId = hit.media_id
        if (typeof mediaId !== 'string' || mediaId.length === 0) continue
        const key = `${kbId}:${mediaId}`
        if (seen.has(key)) continue
        seen.add(key)
        items.push({
          mediaId,
          title: typeof hit.title === 'string' ? hit.title : '',
          kbId,
          kbName,
          ...(typeof hit.highlight === 'string' && hit.highlight.length > 0 ? { highlight: hit.highlight } : {}),
        })
      }
    } catch (error) {
      // 单库失败不拖垮整体：记下来，继续下一个库。
      const kbName = names.get(kbId) ?? kbId
      failures.push(`${kbName}(${kbId})：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const problems = [listError, failures.length > 0 ? `部分知识库检索失败：${failures.join('；')}` : undefined]
    .filter((entry) => typeof entry === 'string' && entry.length > 0)
  return okJson({
    items,
    ...(problems.length > 0 ? { error: problems.join('；') } : {}),
  })
}

/**
 * 建会话级选中集存储（PLATFORM.md §9.3），并按实际能力探测降级。
 *
 * 探测顺序：`ctx.get('storage')` → `%DSH_HOME%` 下的 JSON 文件 → 内存。
 * 降级是**显式**的：实际生效的介质由返回值的 `describe()` 如实报告，
 * 调用方（含 handback）可以据此判断「会话隔离真的落盘了吗」。
 *
 * 单独导出而不是藏在 apply 里，是因为 `apply` 的返回值被 cordis 当作 effect
 * 消费（返回非函数对象会 `TypeError: Invalid effect`），而测试需要能直接观察
 * 探测结果。
 *
 * @param {object} ctx - Cordis 宿主上下文。
 * @param {object} [config] - `{sessionStore?: object, sessionStoreFile?: string|false}`。
 * @returns {object} 会话存储（`getSelected` / `setSelected` / `describe` / `close`）。
 */
export function createHostSessionStore(ctx, config = {}) {
  if (config.sessionStore !== undefined) return config.sessionStore
  const storage = ctx !== null && typeof ctx === 'object' && typeof ctx.get === 'function'
    ? ctx.get('storage')
    : ctx?.storage
  return createSessionStore({
    ...(storage === undefined || storage === null ? {} : { storage }),
    ...(config.sessionStoreFile === undefined ? {} : { file: config.sessionStoreFile }),
  })
}

/**
 * 当前进程是否是 node:test 测试进程。
 *
 * 为什么需要这个判断：`apply()` 在几十个既有测试里被调用，而自动签到调度器的
 * 「启动补跑」会在后台真的打上游、写 `DSH_HOME` 下的账本 —— 测试进程里必须默认
 * 关掉，否则跑一次单测就会污染用户真实数据（并可能用假 cookie 打真实网络）。
 * 生产进程（DSH 宿主）不受影响；需要真调度器的测试显式传 `checkinAutoStart: true`。
 *
 * 判定三条（覆盖 `node --test`、默认隔离的子进程、直接 `node tests/x.test.js`）：
 *  1. `NODE_TEST_CONTEXT`：node:test 子进程会设置；
 *  2. `execArgv` 含 `--test`：`--test-isolation=none` 时测试跑在主进程；
 *  3. 入口文件名是 `*.test.js`：直接执行测试文件。
 *
 * @returns {boolean} 是测试进程返回 true。
 */
function isTestProcess() {
  if (typeof process === 'undefined') return false
  if (process.env?.NODE_TEST_CONTEXT !== undefined) return true
  if (Array.isArray(process.execArgv) && process.execArgv.includes('--test')) return true
  const entry = typeof process.argv?.[1] === 'string' ? process.argv[1] : ''
  return /\.test\.[cm]?js$/u.test(entry)
}

/**
 * 宿主入口。注册三个工具 + 全部 HTTP 路由（含设置、自动签到）。
 *
 * 会话级选中集（PLATFORM.md §9.3）的存储在 {@link createHostSessionStore} 里探测
 * 并注入：`ctx.get('storage')` 可用就用 DSH 存储枢纽，否则降级到 `%DSH_HOME%`
 * 下的 JSON 文件（再兜底内存）。
 *
 * **返回值必须是 void**：cordis 把插件回调的返回值当 effect 消费，返回非函数
 * 对象会 `TypeError: Invalid effect`。需要观察存储的调用方用
 * {@link createHostSessionStore}。
 *
 * @param {object} ctx - Cordis 宿主上下文。
 * @param {{fetchImpl?: typeof fetch, sessionStore?: object, sessionStoreFile?: string|false,
 *   checkinStore?: object, checkinScheduler?: object, checkinStoreFile?: string|false,
 *   checkinNow?: () => number, checkinTimers?: object, checkinLogger?: object,
 *   checkinTimeoutMs?: number, checkinAutoStart?: boolean, desktop?: object}} [config]
 *   可选配置；`fetchImpl` **仅测试使用**（生产走宿主默认的全局 fetch）；
 *   `sessionStore` 可整体替换会话存储（测试用），`sessionStoreFile` 可改文件档路径；
 *   `checkinStore` / `checkinScheduler` 可整体替换签到存储与调度器（测试用），
 *   `checkinNow` / `checkinTimers` / `checkinLogger` / `checkinTimeoutMs` 同为测试注入面；
 *   `checkinAutoStart` 覆盖「是否自动启动后台调度器」（默认 = 非测试进程）。
 * @returns {void}
 */
export function apply(ctx, config = {}) {
  const options = { ...config }
  const services = resolveHostServices(ctx)
  const sessionStore = createHostSessionStore(ctx, options)
  // 会话选中集的同步镜像：提示词段只能同步读，这里给它一份内存副本。
  const selectionCache = options.selectionCache ?? createSelectionCache()
  // 自动签到：存储 + 调度器（都可注入，便于单测）。
  // 调度器只排时间，真正的一轮签到由这里注入的 run 完成（读凭据 + withTokenRefresh + runCheckin）。
  const checkinStore = options.checkinStore ?? createCheckinStore({
    ...(options.checkinStoreFile === undefined ? {} : { file: options.checkinStoreFile }),
    ...(options.checkinNow === undefined ? {} : { now: options.checkinNow }),
  })
  const checkinScheduler = options.checkinScheduler ?? createCheckinScheduler({
    store: checkinStore,
    run: (reason) => performCheckin(
      services.credentials,
      checkinIo(options),
      reason === 'manual' ? 'ima_kb_checkin_manual' : 'ima_kb_checkin_schedule',
    ),
    ...(options.checkinNow === undefined ? {} : { now: options.checkinNow }),
    ...(options.checkinTimers === undefined ? {} : { timers: options.checkinTimers }),
    ...(options.checkinLogger === undefined ? {} : { logger: options.checkinLogger }),
  })
  const scopedOptions = { ...options, sessionStore, selectionCache, checkinStore, checkinScheduler }
  // 后台调度器只在真实宿主进程里自动启动（见 {@link isTestProcess} 的说明）。
  const autoStartCheckin = options.checkinAutoStart ?? !isTestProcess()
  // 跨进程重启后用户往往不会再动选择器 —— 启动时把已落盘的选中集灌进镜像。
  // 失败不影响任何功能（镜像只影响提示词措辞），所以只吞不抛。
  void Promise.resolve()
    .then(() => hydrateSelectionCache(sessionStore, selectionCache))
    .catch(() => undefined)
  // 「检索优先用 search」的策略段：能力可选，缺 systemPrompt 时静默跳过。
  // 走 ctx.inject 而不是直接 ctx.get：systemPrompt 由另一个插件注册，apply 那一刻
  // 可能还没就绪；inject 会在服务出现时回调，服务永远不出现就永远不注册（安全）。
  if (typeof ctx.inject === 'function') {
    ctx.inject(['systemPrompt'], () => { installPromptSection(ctx, selectionCache, options) })
  } else {
    installPromptSection(ctx, selectionCache, options)
  }
  useEffect(ctx, () => {
    const disposers = createTools(services.credentials, scopedOptions).map((tool) => services.tools.register(tool))
    return () => {
      for (const dispose of disposers) {
        if (typeof dispose === 'function') dispose()
      }
      // 会话存储随插件卸载一起关闭（disposer 允许返回 Promise，cordis 会等它结算）。
      if (options.sessionStore === undefined && typeof sessionStore.close === 'function') {
        return sessionStore.close()
      }
      return undefined
    }
  }, 'ima-knowledge: tools')

  // 自动签到调度器随插件启停：start() 内部会做「启动补跑」并排定下一次 HH:mm，
  // stop() 清定时器（幂等）。定时器已 unref，不会阻止进程退出。
  if (autoStartCheckin) {
    useEffect(ctx, () => {
      checkinScheduler.start()
      return () => checkinScheduler.stop()
    }, 'ima-knowledge: checkin scheduler')
  }

  // 路由要等 connection 就绪；ctx.inject 在宿主上同步派发，缺服务时不注册。
  const installRoutes = () => {
    const fetched = typeof ctx.get === 'function' ? ctx.get('connection') : ctx.connection
    assertCapability('ctx.connection.fetch.register', fetched?.fetch?.register, '({path,methods,requestBody,fetch}) => () => Promise<void>')
    useEffect(ctx, () => {
      const disposers = createRoutes(services.credentials, scopedOptions).map((route) => fetched.fetch.register(route))
      return () => {
        for (const dispose of disposers) {
          if (typeof dispose === 'function') void dispose()
        }
      }
    }, 'ima-knowledge: http routes')
  }
  if (typeof ctx.inject === 'function') {
    ctx.inject(['connection'], installRoutes)
  } else {
    installRoutes()
  }
  // 刻意不返回任何东西：cordis 把插件回调的返回值当 effect 消费。
}

/** 便于单测的导出（不改变插件契约）。 */
export const __internals = {
  CONFIG_HINT,
  DEFAULT_SEARCH_LIMIT,
  ERROR_CODES,
  MAX_MEDIA_KNOWLEDGE_BASES,
  MAX_SEARCH_LIMIT,
  MIN_SEARCH_LIMIT,
  ROUTE_ERROR_CODES,
  SELECT_HINT,
  SESSION_SELECT_HINT,
  accountFromCookie,
  buildRetrievalPolicyText,
  checkinIo,
  checkinTodayOf,
  checkinWeekOf,
  createCheckinRoutes,
  createCheckinScheduler,
  createCheckinStore,
  createHostSessionStore,
  createRoutes,
  createSelectionCache,
  createSessionStore,
  createTools,
  ensureFreshCredentials,
  errorOf,
  formatLocalDate,
  handleCredentialsAction,
  handleDesktopSyncAction,
  handleMediaQuery,
  hydrateSelectionCache,
  installPromptSection,
  isTestProcess,
  maskBkn,
  maskCookie,
  normalizeSearchLimit,
  normalizeSessionId,
  performCheckin,
  readSearchLimit,
  readSelected,
  recoverCredentials,
  resolveSelected,
  sessionIdOf,
  syncDesktopCredentials,
  withTokenRefresh,
}
