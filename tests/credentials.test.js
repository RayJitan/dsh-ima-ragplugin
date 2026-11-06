/**
 * `/api/ima-knowledge/credentials` 单测（PLATFORM.md §2.2）。
 *
 * 三条被验收点名的不变量：
 * 1. `get` **绝不**泄漏完整 cookie / bkn（只给布尔 + 掩码）；
 * 2. `set` 先校验再落盘：错误 cookie → `ok:true` + `tokenValid:false` + error，且不写存储；
 * 3. `clear` 只删 cookie/bkn，不动选择集；清完 `get` 不再给 `account`。
 *
 * 写法沿用 tests/api.test.js 的惯例：node:test + 注入假 fetch + 期望值独立复算
 * （bkn 期望值用测试内自带的官方算法复刻，不 import 被测实现自证）。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { getBkn } from '../lib/ima-api.js'
import {
  IMA_KNOWLEDGE_BASE_IDS_REF,
  IMA_X_IMA_BKN_REF,
  IMA_X_IMA_COOKIE_REF,
  ROUTE_CREDENTIALS,
  ROUTE_ERROR_CODES,
  apply,
} from '../lib/host.js'

// --------------------------------------------------------------- 测试脚手架

/**
 * 官方 getBkn 逐字复刻（与 lib 实现相互独立），用于校验宿主自己推导的 bkn。
 * @param {string} token - IMA-TOKEN。
 * @returns {string} 十进制 bkn。
 */
function officialBkn(token) {
  let hash = 5381
  for (let index = 0; index < token.length; index += 1) hash += (hash << 5) + token.charCodeAt(index)
  return String(hash & 2147483647)
}

/** 足够长的 token，才能验证「前 4 + … + 后 4」的掩码规则。 */
const LONG_TOKEN = 'ABCDEFGHIJKLMNOP'
const LONG_COOKIE = `PLATFORM=H5; IMA-UID=001a9a23fd8033bb; IMA-TOKEN=${LONG_TOKEN}; IMA-REFRESH-TOKEN=ref-xyz; IMA-GUID=guid-9`
const LONG_BKN = '193485963'

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
 * 挂载全部路由，返回按路径查表的小工具。
 * @param {Record<string,string>} store - 假凭据存储（会被就地修改）。
 * @param {typeof fetch} fetchImpl - 注入的假 fetch。
 * @param {{writable?: boolean}} [options] - 假 provider 选项。
 */
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
  apply(ctx, { fetchImpl })
  const route = (path) => routes.find((entry) => entry.path === path)
  const post = async (path, body) => {
    const response = await route(path).fetch(new Request('http://host/x', {
      method: 'POST',
      body: JSON.stringify(body),
    }))
    return { status: response.status, headers: response.headers, payload: await response.json() }
  }
  return { credentials, routes, route, post }
}

/** 只回固定 JSON 的假 fetch，并记录请求。 */
function jsonFetch(payload) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url: String(url), init, body: init?.body === undefined ? undefined : JSON.parse(init.body) })
    return Response.json(payload)
  }
  return { impl, calls }
}

/** 一个「列库成功」的最小载荷。 */
const LIST_OK = {
  code: 0,
  msg: 'ok',
  is_end: true,
  next_cursor: '',
  searched_knowledge_bases: [{ id: 'kb-1', name: '产品手册', type: 1, join_type: 0 }],
}

// ------------------------------------------------------------------- get

describe('credentials: get', () => {
  it('reports an unconfigured store without inventing fields', async () => {
    const { post } = mount({}, jsonFetch(LIST_OK).impl)
    const { status, headers, payload } = await post(ROUTE_CREDENTIALS, { action: 'get' })
    assert.equal(status, 200)
    assert.equal(headers.get('cache-control'), 'no-store')
    assert.equal(payload.ok, true)
    assert.equal(payload.value.configured, false)
    assert.equal(payload.value.hasCookie, false)
    assert.equal(payload.value.hasBkn, false)
    // 没有值就不该有掩码字段，也不该有 account。
    assert.equal('cookieMasked' in payload.value, false)
    assert.equal('bknMasked' in payload.value, false)
    assert.equal('account' in payload.value, false)
  })

  it('returns only masks plus the cookie-derived account.uid', async () => {
    const store = { [IMA_X_IMA_COOKIE_REF]: LONG_COOKIE, [IMA_X_IMA_BKN_REF]: LONG_BKN }
    const { post } = mount(store, jsonFetch(LIST_OK).impl)
    const { payload } = await post(ROUTE_CREDENTIALS, { action: 'get' })

    assert.equal(payload.ok, true)
    assert.equal(payload.value.configured, true)
    assert.equal(payload.value.hasCookie, true)
    assert.equal(payload.value.hasBkn, true)
    assert.equal(payload.value.source, 'file')
    // 掩码规则：IMA-TOKEN= 前 4 位 + … + 后 4 位。
    assert.equal(payload.value.cookieMasked, `IMA-TOKEN=${LONG_TOKEN.slice(0, 4)}…${LONG_TOKEN.slice(-4)}`)
    assert.equal(payload.value.bknMasked, `${LONG_BKN.slice(0, 2)}…${LONG_BKN.slice(-2)}`)
    // uid 是唯一权威来源：cookie 里的 IMA-UID。
    assert.equal(payload.value.account.uid, '001a9a23fd8033bb')
    // 没有 IMA 侧接口时不得伪造这些字段。
    for (const key of ['nickname', 'guid', 'openid', 'type']) {
      assert.equal(key in payload.value.account, false, `account.${key} 不得伪造`)
    }
  })

  it('never leaks the full cookie or bkn anywhere in the response body', async () => {
    const store = { [IMA_X_IMA_COOKIE_REF]: LONG_COOKIE, [IMA_X_IMA_BKN_REF]: LONG_BKN }
    const { post } = mount(store, jsonFetch(LIST_OK).impl)
    const { payload } = await post(ROUTE_CREDENTIALS, { action: 'get' })
    const serialized = JSON.stringify(payload)
    assert.equal(serialized.includes(LONG_TOKEN), false, '完整 IMA-TOKEN 泄漏')
    assert.equal(serialized.includes(LONG_COOKIE), false, '完整 cookie 泄漏')
    assert.equal(serialized.includes('IMA-REFRESH-TOKEN=ref-xyz'), false, 'refresh token 泄漏')
    assert.equal(serialized.includes(LONG_BKN), false, '完整 bkn 泄漏')
  })

  it('omits account when the cookie has no IMA-UID', async () => {
    const store = { [IMA_X_IMA_COOKIE_REF]: 'PLATFORM=H5; IMA-TOKEN=ABCDEFGHIJKLMNOP' }
    const { post } = mount(store, jsonFetch(LIST_OK).impl)
    const { payload } = await post(ROUTE_CREDENTIALS, { action: 'get' })
    assert.equal(payload.ok, true)
    assert.equal(payload.value.hasCookie, true)
    assert.equal('account' in payload.value, false)
  })

  it('rejects an unknown action with BAD_REQUEST', async () => {
    const { post } = mount({}, jsonFetch(LIST_OK).impl)
    const { payload } = await post(ROUTE_CREDENTIALS, { action: 'delete' })
    assert.equal(payload.ok, false)
    assert.equal(payload.error.code, ROUTE_ERROR_CODES.badRequest)
  })
})

// ------------------------------------------------------------------- set

describe('credentials: set', () => {
  it('validates with a real list call, then persists, and returns account', async () => {
    const store = {}
    const { impl, calls } = jsonFetch(LIST_OK)
    const { credentials, post } = mount(store, impl)
    const { status, payload } = await post(ROUTE_CREDENTIALS, { action: 'set', cookie: LONG_COOKIE })

    assert.equal(status, 200)
    assert.equal(payload.ok, true)
    assert.equal(payload.value.configured, true)
    assert.equal(payload.value.tokenValid, true)
    assert.equal(payload.value.account.uid, '001a9a23fd8033bb')
    // 校验确实打了一次列库接口（不是空转就落盘）。
    assert.equal(calls.length, 1)
    assert.match(calls[0].url, /search_knowledge_base/u)
    assert.equal(calls[0].body.limit, 1, '校验应该用最廉价的 pageSize=1')
    // 落盘的是规范化后的 cookie。
    assert.deepEqual(credentials.writes, [{ ref: IMA_X_IMA_COOKIE_REF, value: LONG_COOKIE }])
    assert.equal(store[IMA_X_IMA_COOKIE_REF], LONG_COOKIE)
  })

  it('does NOT persist an invalid cookie, but still answers ok:true + tokenValid:false', async () => {
    const store = {}
    const { impl } = jsonFetch({ code: 41, msg: 'token expired' })
    const { credentials, post } = mount(store, impl)
    const { status, payload } = await post(ROUTE_CREDENTIALS, { action: 'set', cookie: LONG_COOKIE })

    // 契约：凭据错是业务失败，不是 HTTP 错误。
    assert.equal(status, 200)
    assert.equal(payload.ok, true)
    assert.equal(payload.value.tokenValid, false)
    // PLATFORM.md §2.2 把 set 的返回钉成 `configured:true`：语境是「配置动作」，
    // 校验结论由 tokenValid 表达；真实落盘状态由随后的 get 校正。
    assert.equal(payload.value.configured, true)
    assert.equal(typeof payload.value.error, 'string')
    assert.match(payload.value.error, /未保存/u)
    assert.match(payload.value.error, /code 41|token expired/u)
    // 关键：存储里什么都没写。
    assert.equal(credentials.writes.length, 0)
    assert.equal(store[IMA_X_IMA_COOKIE_REF], undefined)
    // 失败时也不该回 account（没落盘就没有账号）。
    assert.equal('account' in payload.value, false)
    // 失败之后 get 必须如实报「未配置」——不让上面的 configured:true 变成谎话。
    const after = (await post(ROUTE_CREDENTIALS, { action: 'get' })).payload
    assert.equal(after.value.configured, false)
  })

  it('derives bkn from IMA-TOKEN when bkn is omitted, and drops a stale stored bkn', async () => {
    const store = {
      [IMA_X_IMA_COOKIE_REF]: 'PLATFORM=H5; IMA-UID=001a9a23fd8033bb; IMA-TOKEN=OLD',
      [IMA_X_IMA_BKN_REF]: '999',
    }
    const { impl, calls } = jsonFetch(LIST_OK)
    const { credentials, post } = mount(store, impl)
    const payload = (await post(ROUTE_CREDENTIALS, { action: 'set', cookie: LONG_COOKIE })).payload

    assert.equal(payload.value.tokenValid, true)
    // 校验请求带的是「按新 token 推导」的 bkn，而不是存储里的旧 999。
    assert.equal(calls[0].init.headers['x-ima-bkn'], officialBkn(LONG_TOKEN))
    // 旧 bkn 已过期 → 必须删掉，否则之后所有请求都会用错 bkn。
    assert.deepEqual(credentials.unsets, [{ ref: IMA_X_IMA_BKN_REF }])
    assert.equal(store[IMA_X_IMA_BKN_REF], undefined)
    assert.deepEqual(credentials.writes.map((write) => write.ref), [IMA_X_IMA_COOKIE_REF])
  })

  it('persists an explicit bkn verbatim and uses it for validation', async () => {
    const store = {}
    const { impl, calls } = jsonFetch(LIST_OK)
    const { credentials, post } = mount(store, impl)
    const payload = (await post(ROUTE_CREDENTIALS, {
      action: 'set', cookie: LONG_COOKIE, bkn: LONG_BKN,
    })).payload

    assert.equal(payload.value.tokenValid, true)
    assert.equal(calls[0].init.headers['x-ima-bkn'], LONG_BKN)
    assert.deepEqual(credentials.writes, [
      { ref: IMA_X_IMA_BKN_REF, value: LONG_BKN },
      { ref: IMA_X_IMA_COOKIE_REF, value: LONG_COOKIE },
    ])
  })

  it('normalizes a YAML-folded cookie before validating and storing', async () => {
    // 生产实测：credential 里可能是带 \n + 缩进的 YAML 折行原文。
    const folded = 'PLATFORM=H5;\n    IMA-UID=001a9a23fd8033bb;\n    IMA-TOKEN=ABCDEFGHIJKLMNOP'
    const store = {}
    const { impl, calls } = jsonFetch(LIST_OK)
    const { credentials, post } = mount(store, impl)
    const payload = (await post(ROUTE_CREDENTIALS, { action: 'set', cookie: folded })).payload

    assert.equal(payload.value.tokenValid, true)
    assert.equal(calls[0].init.headers['x-ima-cookie'].includes('\n'), false, 'header 里不能有裸换行')
    const stored = credentials.writes[0].value
    assert.equal(stored, 'PLATFORM=H5; IMA-UID=001a9a23fd8033bb; IMA-TOKEN=ABCDEFGHIJKLMNOP')
  })

  it('rejects an empty cookie with BAD_REQUEST and writes nothing', async () => {
    const { credentials, post } = mount({}, jsonFetch(LIST_OK).impl)
    const { payload } = await post(ROUTE_CREDENTIALS, { action: 'set', cookie: '   ' })
    assert.equal(payload.ok, false)
    assert.equal(payload.error.code, ROUTE_ERROR_CODES.badRequest)
    assert.equal(credentials.writes.length, 0)
  })

  it('refuses to persist when the cookie carries no IMA-TOKEN and no bkn is given', async () => {
    const store = {}
    const { credentials, post } = mount(store, jsonFetch(LIST_OK).impl)
    const { payload } = await post(ROUTE_CREDENTIALS, { action: 'set', cookie: 'PLATFORM=H5' })
    assert.equal(payload.ok, true)
    assert.equal(payload.value.tokenValid, false)
    assert.match(payload.value.error, /IMA-TOKEN/u)
    assert.equal(credentials.writes.length, 0)
  })

  it('maps a read-only credential provider to CREDENTIAL_READONLY', async () => {
    const store = {}
    const { post } = mount(store, jsonFetch(LIST_OK).impl, { writable: false })
    const { payload } = await post(ROUTE_CREDENTIALS, { action: 'set', cookie: LONG_COOKIE })
    assert.equal(payload.ok, false)
    assert.equal(payload.error.code, ROUTE_ERROR_CODES.credentialReadonly)
    assert.match(payload.error.message, /不可写/u)
    assert.equal(store[IMA_X_IMA_COOKIE_REF], undefined)
  })
})

// ----------------------------------------------------------------- clear

describe('credentials: clear', () => {
  it('unsets cookie and bkn but keeps the knowledge-base selection', async () => {
    const store = {
      [IMA_X_IMA_COOKIE_REF]: LONG_COOKIE,
      [IMA_X_IMA_BKN_REF]: LONG_BKN,
      [IMA_KNOWLEDGE_BASE_IDS_REF]: 'kb-1, kb-2',
    }
    const { credentials, post } = mount(store, jsonFetch(LIST_OK).impl)
    const { payload } = await post(ROUTE_CREDENTIALS, { action: 'clear' })

    assert.equal(payload.ok, true)
    assert.deepEqual(payload.value, { configured: false })
    assert.deepEqual(credentials.unsets.map((entry) => entry.ref).sort(), [
      IMA_X_IMA_BKN_REF,
      IMA_X_IMA_COOKIE_REF,
    ])
    // 选择集是另一套语义（「接入了哪些库」），clear 凭据不该动它。
    assert.equal(store[IMA_KNOWLEDGE_BASE_IDS_REF], 'kb-1, kb-2')
  })

  it('is idempotent and leaves no account behind after clearing', async () => {
    const store = { [IMA_X_IMA_COOKIE_REF]: LONG_COOKIE, [IMA_X_IMA_BKN_REF]: LONG_BKN }
    const { credentials, post } = mount(store, jsonFetch(LIST_OK).impl)

    assert.equal((await post(ROUTE_CREDENTIALS, { action: 'clear' })).payload.value.configured, false)
    // 第二次清空：ref 已经不在，不该再产生 unset 调用。
    const before = credentials.unsets.length
    assert.equal((await post(ROUTE_CREDENTIALS, { action: 'clear' })).payload.value.configured, false)
    assert.equal(credentials.unsets.length, before)

    const after = (await post(ROUTE_CREDENTIALS, { action: 'get' })).payload
    assert.equal(after.value.configured, false)
    assert.equal('account' in after.value, false)
    assert.equal('cookieMasked' in after.value, false)
  })

  it('maps a read-only provider to CREDENTIAL_READONLY instead of faking success', async () => {
    const store = { [IMA_X_IMA_COOKIE_REF]: LONG_COOKIE }
    const { post } = mount(store, jsonFetch(LIST_OK).impl, { writable: false })
    const { payload } = await post(ROUTE_CREDENTIALS, { action: 'clear' })
    assert.equal(payload.ok, false)
    assert.equal(payload.error.code, ROUTE_ERROR_CODES.credentialReadonly)
    assert.equal(store[IMA_X_IMA_COOKIE_REF], LONG_COOKIE)
  })
})

// ------------------------------------------------------- 端到端闭环

describe('credentials: 完整闭环', () => {
  it('set → get shows masks → clear → get shows unconfigured', async () => {
    const store = {}
    const { impl } = jsonFetch(LIST_OK)
    const { post } = mount(store, impl)

    const saved = (await post(ROUTE_CREDENTIALS, { action: 'set', cookie: LONG_COOKIE, bkn: LONG_BKN })).payload
    assert.equal(saved.value.tokenValid, true)

    const shown = (await post(ROUTE_CREDENTIALS, { action: 'get' })).payload
    assert.equal(shown.value.configured, true)
    assert.equal(shown.value.cookieMasked.includes(LONG_TOKEN), false)
    assert.equal(shown.value.account.uid, '001a9a23fd8033bb')

    await post(ROUTE_CREDENTIALS, { action: 'clear' })
    const cleared = (await post(ROUTE_CREDENTIALS, { action: 'get' })).payload
    assert.equal(cleared.value.configured, false)
    assert.equal(cleared.value.hasCookie, false)
    assert.equal(cleared.value.hasBkn, false)
  })

  it('keeps the derived bkn consistent with the library helper for the same token', async () => {
    // 宿主自己推导的 bkn 必须与 lib 的 getBkn 一致（防止两处算法漂移）。
    assert.equal(officialBkn(LONG_TOKEN), getBkn(LONG_TOKEN))
  })
})
