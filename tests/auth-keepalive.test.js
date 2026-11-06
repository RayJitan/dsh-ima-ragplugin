/**
 * 授权保活单测（本轮新增：主动续期 + 续期失败自动重同步）。
 *
 * 被验收的不变量（每条都能红能绿）：
 * 1. `refreshToken()` 把上游 `token_valid_time`（秒）暴露成 `tokenTtlSeconds`，
 *    并保留（若上游真的给了）新的 `refresh_token`；
 * 2. 凭据里记录的到期时间临近时，**请求前**先续期，而不是先失败一次；
 * 3. 续期成功后把「新 cookie + 新 bkn + 新到期时间」一起落盘；
 * 4. 续期失败时自动重读 IMA 桌面客户端（DPAPI）并重试，用户零点击；
 * 5. `/status` 也走同一条续期/重同步链，面板不再把「本可自愈」报成过期；
 * 6. 手动 `/desktop-sync` 落盘时把桌面客户端的 `token_valid_time` 记下来。
 *
 * 写法沿用 tests/credentials.test.js：node:test + 注入假 fetch / 假桌面客户端。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { refreshToken } from '../lib/ima-api.js'
import {
  IMA_X_IMA_BKN_REF,
  IMA_X_IMA_COOKIE_REF,
  IMA_X_IMA_TOKEN_EXPIRES_AT_REF,
  ROUTE_DESKTOP_SYNC,
  ROUTE_LIST,
  ROUTE_STATUS,
  apply,
} from '../lib/host.js'

// --------------------------------------------------------------- 测试脚手架

const UID = 'uid-1'
const OLD_COOKIE = `PLATFORM=H5; IMA-UID=${UID}; IMA-TOKEN=OLDTOKEN; IMA-REFRESH-TOKEN=REFRESH1; UID-TYPE=2; TOKEN-TYPE=14`
const DESKTOP_TOKEN = 'DESKTOPTOKEN'
const DESKTOP_REFRESH = 'DESKTOPREFRESH'

const LIST_OK = {
  code: 0,
  msg: 'ok',
  is_end: true,
  next_cursor: '',
  searched_knowledge_bases: [{ id: 'kb-1', name: '产品手册', type: 1, join_type: 0 }],
}
const LIST_EXPIRED = { code: 41, msg: 'token expired' }
const REFRESH_OK = { code: 0, msg: 'ok', token: 'NEWTOKEN', token_valid_time: '7200' }

/** 与 DSH CredentialProvider 签名一致的假凭据服务。 */
function fakeCredentials(store, options = {}) {
  const writes = []
  const unsets = []
  return {
    writes,
    unsets,
    async resolve(ref) {
      const value = store[ref]
      return value === undefined ? undefined : { value, source: 'file' }
    },
    async describe(ref) {
      return {
        configured: store[ref] !== undefined,
        source: store[ref] === undefined ? undefined : 'file',
        writable: options.writable ?? true,
      }
    },
    async set(ref, value) {
      writes.push({ ref, value })
      store[ref] = value
    },
    async unset(ref) {
      unsets.push({ ref })
      delete store[ref]
    },
  }
}

/**
 * 按 URL 分派的假 fetch。`reply` 可以是对象，也可以是 `(call) => object`。
 * @param {Array<{match: string, reply: object|Function}>} handlers - 匹配规则。
 */
function routedFetch(handlers) {
  const calls = []
  const impl = async (url, init) => {
    const text = String(url)
    const headers = init?.headers ?? {}
    const call = {
      url: text,
      headers,
      cookie: headers['x-ima-cookie'],
      body: init?.body === undefined ? undefined : JSON.parse(init.body),
    }
    calls.push(call)
    const handler = handlers.find((entry) => text.includes(entry.match))
    if (handler === undefined) throw new Error(`unexpected url: ${text}`)
    const payload = typeof handler.reply === 'function' ? handler.reply(call, calls) : handler.reply
    return Response.json(payload)
  }
  return { impl, calls }
}

/** 挂载全部路由，返回按路径查表的小工具。 */
function mount(store, fetchImpl, options = {}) {
  const credentials = fakeCredentials(store, options)
  const routes = []
  const ctx = {
    effect: (callback) => callback(),
    inject: (_services, callback) => callback(ctx),
    get: (service) => {
      if (service === 'tools') return { register: () => () => {} }
      if (service === 'credentials') return credentials
      if (service === 'connection') {
        return { fetch: { register: (route) => { routes.push(route); return async () => {} } } }
      }
      return undefined
    },
  }
  apply(ctx, {
    fetchImpl,
    ...(options.desktop === undefined ? {} : { desktop: options.desktop }),
  })
  const route = (path) => routes.find((entry) => entry.path === path)
  const post = async (path, body) => {
    const response = await route(path).fetch(new Request('http://host/x', {
      method: 'POST',
      body: JSON.stringify(body),
    }))
    return { status: response.status, payload: await response.json() }
  }
  return { credentials, post }
}

/** 桌面客户端 Preferences 的假内容（token 未过期、refresh 长期有效）。 */
function desktopPreferences() {
  const secret = {
    token: DESKTOP_TOKEN,
    refresh_token: DESKTOP_REFRESH,
    token_valid_time: '4102444800',
    refresh_token_valid_time: '4102444800',
  }
  return JSON.stringify({
    tencent: {
      wxlogin: {
        account_meta: JSON.stringify({
          is_login: true,
          user_id: UID,
          token_valid_time: '4102444800',
          refresh_token_valid_time: '4102444800',
          user_info: { open_info: { uid: UID, nickname: '测试账号' } },
        }),
        account_secret_encrypted: Buffer.from(JSON.stringify(secret), 'utf8').toString('base64'),
      },
    },
  })
}

/** 假桌面客户端注入面（假文件系统 + 假 DPAPI）。 */
function desktopEnv(overrides = {}) {
  const preferences = desktopPreferences()
  return {
    platform: 'win32',
    localAppData: 'C:\\LA',
    exists: () => true,
    readFile: (path) => {
      if (String(path).endsWith('Preferences')) return preferences
      throw new Error('ENOENT')
    },
    unprotectDpapi: async (blob) => Buffer.from(String(blob).trim(), 'base64'),
    now: () => 1_800_000_000_000,
    ...overrides,
  }
}

const pastExpiry = () => String(Date.now() - 60_000)

// ------------------------------------------------------- refreshToken 契约

describe('ima-api: refreshToken 暴露续期所需的元数据', () => {
  it('returns tokenTtlSeconds from the upstream token_valid_time', async () => {
    const { impl, calls } = routedFetch([{ match: '/auth_login/refresh', reply: REFRESH_OK }])
    const result = await refreshToken({ cookie: OLD_COOKIE }, { fetchImpl: impl })

    assert.equal(result.token, 'NEWTOKEN')
    assert.equal(result.tokenTtlSeconds, 7200)
    assert.equal(result.refreshToken, undefined, '上游没给新 refresh_token 时不得伪造')
    assert.match(result.cookie, /IMA-TOKEN=NEWTOKEN/u)
    assert.equal(calls.length, 1)
  })

  it('keeps a rotated refresh_token in both the result and the rebuilt cookie', async () => {
    const { impl } = routedFetch([{
      match: '/auth_login/refresh',
      reply: { code: 0, msg: 'ok', token: 'NEWTOKEN', token_valid_time: '7200', refresh_token: 'REFRESH2' },
    }])
    const result = await refreshToken({ cookie: OLD_COOKIE }, { fetchImpl: impl })

    assert.equal(result.refreshToken, 'REFRESH2')
    assert.match(result.cookie, /IMA-REFRESH-TOKEN=REFRESH2/u)
    assert.doesNotMatch(result.cookie, /IMA-REFRESH-TOKEN=REFRESH1/u)
  })
})

// ------------------------------------------------------------- 主动续期

describe('host: 到期前主动续期', () => {
  it('refreshes BEFORE the request when the recorded expiry is near', async () => {
    const store = {
      [IMA_X_IMA_COOKIE_REF]: OLD_COOKIE,
      [IMA_X_IMA_TOKEN_EXPIRES_AT_REF]: pastExpiry(),
    }
    const { impl, calls } = routedFetch([
      { match: '/auth_login/refresh', reply: REFRESH_OK },
      { match: '/search_knowledge_base', reply: LIST_OK },
    ])
    const { post } = mount(store, impl)
    const { payload } = await post(ROUTE_LIST, {})

    assert.equal(payload.ok, true)
    assert.match(calls[0].url, /auth_login\/refresh/u, '必须先续期再列库')
    assert.match(calls[1].url, /search_knowledge_base/u)
    // 新 cookie / 新 bkn / 新到期时间三样都要落盘。
    assert.match(store[IMA_X_IMA_COOKIE_REF], /IMA-TOKEN=NEWTOKEN/u)
    assert.equal(typeof store[IMA_X_IMA_BKN_REF], 'string')
    const expiresAt = Number(store[IMA_X_IMA_TOKEN_EXPIRES_AT_REF])
    assert.ok(expiresAt > Date.now() + 60 * 60 * 1000, `到期时间应被推进，实际 ${expiresAt}`)
  })

  it('does not refresh when the recorded expiry is far away', async () => {
    const store = {
      [IMA_X_IMA_COOKIE_REF]: OLD_COOKIE,
      [IMA_X_IMA_TOKEN_EXPIRES_AT_REF]: String(Date.now() + 60 * 60 * 1000),
    }
    const { impl, calls } = routedFetch([
      { match: '/auth_login/refresh', reply: REFRESH_OK },
      { match: '/search_knowledge_base', reply: LIST_OK },
    ])
    const { post } = mount(store, impl)
    const { payload } = await post(ROUTE_LIST, {})

    assert.equal(payload.ok, true)
    assert.equal(calls.length, 1, '到期还早就不该白打一次 refresh')
    assert.match(calls[0].url, /search_knowledge_base/u)
  })

  it('still self-heals on code 41 when no expiry was recorded', async () => {
    const store = { [IMA_X_IMA_COOKIE_REF]: OLD_COOKIE }
    const { impl, calls } = routedFetch([
      { match: '/auth_login/refresh', reply: REFRESH_OK },
      {
        match: '/search_knowledge_base',
        reply: (call) => (call.cookie.includes('IMA-TOKEN=NEWTOKEN') ? LIST_OK : LIST_EXPIRED),
      },
    ])
    const { post } = mount(store, impl)
    const { payload } = await post(ROUTE_LIST, {})

    assert.equal(payload.ok, true)
    assert.equal(calls.filter((call) => call.url.includes('/auth_login/refresh')).length, 1)
    assert.match(store[IMA_X_IMA_COOKIE_REF], /IMA-TOKEN=NEWTOKEN/u)
    assert.ok(Number(store[IMA_X_IMA_TOKEN_EXPIRES_AT_REF]) > Date.now())
  })
})

// -------------------------------------------------- 续期失败 → 自动重同步

describe('host: 续期失败时自动重读桌面客户端', () => {
  it('falls back to the desktop client when refresh is rejected', async () => {
    const store = {
      [IMA_X_IMA_COOKIE_REF]: OLD_COOKIE,
      [IMA_X_IMA_TOKEN_EXPIRES_AT_REF]: pastExpiry(),
    }
    const { impl, calls } = routedFetch([
      { match: '/auth_login/refresh', reply: { code: 41, msg: 'refresh token invalid' } },
      {
        match: '/search_knowledge_base',
        reply: (call) => (call.cookie.includes(`IMA-TOKEN=${DESKTOP_TOKEN}`) ? LIST_OK : LIST_EXPIRED),
      },
    ])
    const { post } = mount(store, impl, { desktop: desktopEnv() })
    const { payload } = await post(ROUTE_LIST, {})

    assert.equal(payload.ok, true)
    // 桌面客户端凭据被校验并落盘（bkn 也按新 token 重算）。
    assert.match(store[IMA_X_IMA_COOKIE_REF], new RegExp(`IMA-TOKEN=${DESKTOP_TOKEN}`, 'u'))
    assert.match(store[IMA_X_IMA_COOKIE_REF], new RegExp(`IMA-REFRESH-TOKEN=${DESKTOP_REFRESH}`, 'u'))
    assert.equal(typeof store[IMA_X_IMA_BKN_REF], 'string')
    // 最后一次列库用的是桌面客户端的 token。
    const last = calls[calls.length - 1]
    assert.match(last.cookie, new RegExp(`IMA-TOKEN=${DESKTOP_TOKEN}`, 'u'))
  })

  it('reports a human explanation when both refresh and desktop fallback fail', async () => {
    const store = {
      [IMA_X_IMA_COOKIE_REF]: OLD_COOKIE,
      [IMA_X_IMA_TOKEN_EXPIRES_AT_REF]: pastExpiry(),
    }
    const { impl } = routedFetch([
      { match: '/auth_login/refresh', reply: { code: 41, msg: 'refresh token invalid' } },
      { match: '/search_knowledge_base', reply: LIST_EXPIRED },
    ])
    const { post } = mount(store, impl, {
      desktop: desktopEnv({ exists: () => false }),
    })
    const { payload } = await post(ROUTE_LIST, {})

    assert.equal(payload.ok, false)
    assert.match(payload.error.message, /自动续期|桌面客户端|重新登录/u)
  })
})

// --------------------------------------------------------- /status 自愈

describe('host: /status 不再把可自愈的过期报成过期', () => {
  it('refreshes and reports tokenValid:true when the refresh token still works', async () => {
    const store = {
      [IMA_X_IMA_COOKIE_REF]: OLD_COOKIE,
      [IMA_X_IMA_TOKEN_EXPIRES_AT_REF]: pastExpiry(),
    }
    const { impl, calls } = routedFetch([
      { match: '/auth_login/refresh', reply: REFRESH_OK },
      {
        match: '/search_knowledge_base',
        reply: (call) => (call.cookie.includes('IMA-TOKEN=NEWTOKEN') ? LIST_OK : LIST_EXPIRED),
      },
    ])
    const { post } = mount(store, impl)
    const { payload } = await post(ROUTE_STATUS, {})

    assert.equal(payload.ok, true)
    assert.equal(payload.value.tokenValid, true)
    assert.equal(calls.some((call) => call.url.includes('/auth_login/refresh')), true)
  })

  it('re-syncs from the desktop client when refresh fails', async () => {
    const store = {
      [IMA_X_IMA_COOKIE_REF]: OLD_COOKIE,
      [IMA_X_IMA_TOKEN_EXPIRES_AT_REF]: pastExpiry(),
    }
    const { impl } = routedFetch([
      { match: '/auth_login/refresh', reply: { code: 41, msg: 'refresh token invalid' } },
      {
        match: '/search_knowledge_base',
        reply: (call) => (call.cookie.includes(`IMA-TOKEN=${DESKTOP_TOKEN}`) ? LIST_OK : LIST_EXPIRED),
      },
    ])
    const { post } = mount(store, impl, { desktop: desktopEnv() })
    const { payload } = await post(ROUTE_STATUS, {})

    assert.equal(payload.value.tokenValid, true)
    assert.match(store[IMA_X_IMA_COOKIE_REF], new RegExp(`IMA-TOKEN=${DESKTOP_TOKEN}`, 'u'))
  })

  it('still reports expired (with guidance) when nothing can revive it', async () => {
    const store = {
      [IMA_X_IMA_COOKIE_REF]: OLD_COOKIE,
      [IMA_X_IMA_TOKEN_EXPIRES_AT_REF]: pastExpiry(),
    }
    const { impl } = routedFetch([
      { match: '/auth_login/refresh', reply: { code: 41, msg: 'refresh token invalid' } },
      { match: '/search_knowledge_base', reply: LIST_EXPIRED },
    ])
    const { post } = mount(store, impl, { desktop: desktopEnv({ exists: () => false }) })
    const { payload } = await post(ROUTE_STATUS, {})

    assert.equal(payload.value.tokenValid, false)
    assert.match(payload.value.error.message, /重新登录|桌面客户端/u)
  })
})

// ------------------------------------------------- 手动同步落盘到期时间

describe('host: /desktop-sync 落盘时记录到期时间', () => {
  it('persists the desktop token_valid_time as the next refresh deadline', async () => {
    const store = {}
    const { impl } = routedFetch([
      { match: '/search_knowledge_base', reply: LIST_OK },
    ])
    const { post } = mount(store, impl, { desktop: desktopEnv() })
    const { payload } = await post(ROUTE_DESKTOP_SYNC, { action: 'sync' })

    assert.equal(payload.ok, true)
    assert.equal(payload.value.configured, true)
    assert.equal(payload.value.tokenValid, true)
    assert.match(store[IMA_X_IMA_COOKIE_REF], new RegExp(`IMA-TOKEN=${DESKTOP_TOKEN}`, 'u'))
    // 4102444800 秒 = 2100-01-01，落盘成毫秒。
    assert.equal(store[IMA_X_IMA_TOKEN_EXPIRES_AT_REF], '4102444800000')
  })
})
