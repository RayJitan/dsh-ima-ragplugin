/**
 * 检索条数设置（v5）单测。
 *
 * 覆盖三层：
 *  1. 宿主纯函数 `normalizeSearchLimit` / `readSearchLimit`（默认 10、范围 1-100）；
 *  2. `/api/ima-knowledge/settings` 路由（get / set / 严格校验 / 只读 provider）；
 *  3. `ima_kb_search` 未显式传 `limit` 时确实用设置值（显式 limit 仍优先）；
 *  4. 浏览器侧纯函数 `sbLimitOf` / `sbLimitDraft`（首帧容错 + 输入校验）。
 *
 * 断言纪律沿用 api.test.js：期望值独立复算，不 import 被测实现来算期望。
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { describe, it } from 'node:test'

import {
  DEFAULT_SEARCH_LIMIT,
  IMA_KNOWLEDGE_SEARCH_LIMIT_REF,
  MAX_SEARCH_LIMIT,
  MIN_SEARCH_LIMIT,
  ROUTE_SETTINGS,
  __internals,
  buildRetrievalPolicyText,
  normalizeSearchLimit,
  readSearchLimit,
} from '../lib/host.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SIDEBAR_FRAGMENT = join(root, 'lib', 'client', '20-sidebar.js')
const CORE_FRAGMENT = join(root, 'lib', 'client', '10-core.js')

/** 一个可用的 cookie / bkn 组合（与 api.test.js 同形，独立复写免耦合）。 */
const COOKIE = 'PLATFORM=H5; IMA-UID=user-1; IMA-TOKEN=tok-abc; IMA-REFRESH-TOKEN=ref-xyz; IMA-GUID=guid-9'
const BKN = '193485963'

/**
 * 与 DSH CredentialProvider 签名一致的假凭据服务。
 * @param {Record<string,string>} [store] - 假存储（会被就地修改）。
 * @param {{writable?: boolean}} [options] - provider 选项。
 * @returns {object} 假服务。
 */
function fakeCredentials(store = {}, options = {}) {
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
 * 挂载全部路由（直连 createRoutes，不经过 apply，避免签到调度器等无关副作用）。
 * @param {Record<string,string>} [store] - 假凭据存储。
 * @param {typeof fetch} [fetchImpl] - 注入的假 fetch。
 * @param {{writable?: boolean}} [options] - provider 选项。
 * @returns {object} `{credentials, routes, post}`。
 */
function mountRoutes(store = {}, fetchImpl, options = {}) {
  const credentials = fakeCredentials(store, options)
  const routes = __internals.createRoutes(credentials, fetchImpl === undefined ? {} : { fetchImpl })
  const post = async (path, body) => {
    const route = routes.find((entry) => entry.path === path)
    assert.ok(route !== undefined, '缺少路由 ' + path)
    const response = await route.fetch(new Request('http://host/x', {
      method: 'POST',
      body: JSON.stringify(body),
    }))
    return { status: response.status, headers: response.headers, payload: await response.json() }
  }
  return { credentials, routes, post }
}

/** 造 100 条命中（上游恒返回 100 条，工具侧负责按 limit 截断）。 */
function hits(count) {
  return Array.from({ length: count }, (_unused, index) => ({
    media_id: 'media-' + index,
    title: 'title-' + index,
    highlight: 'highlight-' + index,
  }))
}

/** 检索接口的假 fetch：记录请求体，返回 100 条命中。 */
function searchFetch(count = 100) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) })
    return Response.json({
      code: 0,
      msg: 'ok',
      is_end: true,
      next_cursor: '',
      searched_knowledge_list: hits(count),
    })
  }
  return { impl, calls }
}

/**
 * 建工具集（全局选中集 = kb-1，避免依赖会话存储）。
 * @param {Record<string,string>} store - 假凭据存储。
 * @param {typeof fetch} fetchImpl - 假 fetch。
 * @returns {{tools: Array<object>, credentials: object}} 工具集。
 */
function mountTools(store, fetchImpl) {
  const credentials = fakeCredentials(store)
  const tools = __internals.createTools(credentials, { fetchImpl })
  return { tools, credentials }
}

/** 工具执行上下文的最小子集。 */
function execOf() {
  return { signal: new AbortController().signal }
}

// ------------------------------------------------------- 纯函数：规范化

describe('normalizeSearchLimit：默认 10、范围 1-100', () => {
  it('缺失 / 非法值一律回落默认 10', () => {
    for (const bogus of [undefined, null, '', '   ', 'abc', Number.NaN, Infinity, -Infinity, {}, [], true]) {
      assert.equal(normalizeSearchLimit(bogus), 10, '输入 ' + JSON.stringify(bogus))
    }
  })

  it('合法值原样保留（数字与数字字符串都接受）', () => {
    assert.equal(normalizeSearchLimit(1), 1)
    assert.equal(normalizeSearchLimit(10), 10)
    assert.equal(normalizeSearchLimit(100), 100)
    assert.equal(normalizeSearchLimit('25'), 25)
    assert.equal(normalizeSearchLimit('  7  '), 7)
  })

  it('小数向下取整', () => {
    assert.equal(normalizeSearchLimit(10.9), 10)
    assert.equal(normalizeSearchLimit('3.7'), 3)
  })

  it('越界收敛到 1 / 100（读侧容错）', () => {
    assert.equal(normalizeSearchLimit(0), 1)
    assert.equal(normalizeSearchLimit(-5), 1)
    assert.equal(normalizeSearchLimit(101), 100)
    assert.equal(normalizeSearchLimit(99999), 100)
  })

  it('常量本身自洽：默认值落在范围内', () => {
    assert.equal(DEFAULT_SEARCH_LIMIT, 10)
    assert.equal(MIN_SEARCH_LIMIT, 1)
    assert.equal(MAX_SEARCH_LIMIT, 100)
    assert.ok(DEFAULT_SEARCH_LIMIT >= MIN_SEARCH_LIMIT && DEFAULT_SEARCH_LIMIT <= MAX_SEARCH_LIMIT)
  })
})

describe('readSearchLimit：未配置 = 默认 10', () => {
  it('ref 缺失时返回 10', async () => {
    assert.equal(await readSearchLimit(fakeCredentials({})), 10)
  })

  it('读到合法值就用它，脏值回落默认', async () => {
    assert.equal(await readSearchLimit(fakeCredentials({ [IMA_KNOWLEDGE_SEARCH_LIMIT_REF]: '42' })), 42)
    assert.equal(await readSearchLimit(fakeCredentials({ [IMA_KNOWLEDGE_SEARCH_LIMIT_REF]: 'oops' })), 10)
  })
})

// ------------------------------------------------------- 路由：/settings

describe('/settings：检索条数读写', () => {
  it('get 未配置时返回默认值 + 范围，且禁止缓存', async () => {
    const { post } = mountRoutes({}, searchFetch().impl)
    const { status, headers, payload } = await post(ROUTE_SETTINGS, { action: 'get' })
    assert.equal(status, 200)
    assert.equal(headers.get('cache-control'), 'no-store')
    assert.equal(payload.ok, true)
    assert.deepEqual(payload.value, { searchLimit: 10, min: 1, max: 100, default: 10 })
  })

  it('get 已配置时返回落盘值', async () => {
    const { post } = mountRoutes({ [IMA_KNOWLEDGE_SEARCH_LIMIT_REF]: '37' }, searchFetch().impl)
    const { payload } = await post(ROUTE_SETTINGS, { action: 'get' })
    assert.equal(payload.value.searchLimit, 37)
  })

  it('set 合法值 → 写 credential store 并回显', async () => {
    const store = {}
    const { post, credentials } = mountRoutes(store, searchFetch().impl)
    const { payload } = await post(ROUTE_SETTINGS, { action: 'set', searchLimit: 25 })
    assert.equal(payload.ok, true)
    assert.equal(payload.value.searchLimit, 25)
    assert.deepEqual(credentials.writes, [{ ref: IMA_KNOWLEDGE_SEARCH_LIMIT_REF, value: '25' }])
    // 再读一次，确认真的持久化了。
    assert.equal((await post(ROUTE_SETTINGS, { action: 'get' })).payload.value.searchLimit, 25)
  })

  it('set 接受边界值 1 与 100', async () => {
    const store = {}
    const { post } = mountRoutes(store, searchFetch().impl)
    assert.equal((await post(ROUTE_SETTINGS, { action: 'set', searchLimit: 1 })).payload.value.searchLimit, 1)
    assert.equal((await post(ROUTE_SETTINGS, { action: 'set', searchLimit: 100 })).payload.value.searchLimit, 100)
  })

  it('set 拒绝越界 / 小数 / 非数字，且零写入（严格校验，不静默收敛）', async () => {
    const store = {}
    const { post, credentials } = mountRoutes(store, searchFetch().impl)
    for (const bogus of [0, 101, -3, 1.5, 'abc', '', null, undefined, {}, []]) {
      const { payload } = await post(ROUTE_SETTINGS, { action: 'set', searchLimit: bogus })
      assert.equal(payload.ok, false, '输入 ' + JSON.stringify(bogus) + ' 必须被拒绝')
      assert.equal(payload.error.code, __internals.ROUTE_ERROR_CODES.badRequest)
    }
    assert.deepEqual(credentials.writes, [], '非法输入不得写库')
    assert.equal(IMA_KNOWLEDGE_SEARCH_LIMIT_REF in store, false)
  })

  it('action 非法时返回 BAD_REQUEST', async () => {
    const { post } = mountRoutes({}, searchFetch().impl)
    for (const action of [undefined, '', 'delete', 'SETTINGS']) {
      const { payload } = await post(ROUTE_SETTINGS, { action })
      assert.equal(payload.ok, false)
      assert.equal(payload.error.code, __internals.ROUTE_ERROR_CODES.badRequest)
    }
  })

  it('provider 只读时 set 返回 CREDENTIAL_READONLY', async () => {
    const { post } = mountRoutes({}, searchFetch().impl, { writable: false })
    const { payload } = await post(ROUTE_SETTINGS, { action: 'set', searchLimit: 30 })
    assert.equal(payload.ok, false)
    assert.equal(payload.error.code, __internals.ROUTE_ERROR_CODES.credentialReadonly)
  })
})

// ------------------------------------------------------- 工具：默认 limit

describe('ima_kb_search：未显式传 limit 时用设置值', () => {
  it('默认读设置：配置 25 → 请求 limit 25、返回 25 条', async () => {
    const fetch = searchFetch(100)
    const { tools } = mountTools({
      IMA_X_IMA_COOKIE: COOKIE,
      IMA_X_IMA_BKN: BKN,
      IMA_KNOWLEDGE_BASE_IDS: 'kb-1',
      [IMA_KNOWLEDGE_SEARCH_LIMIT_REF]: '25',
    }, fetch.impl)
    const search = tools.find((tool) => tool.name === 'ima_kb_search')
    const value = await search.execute({ query: '检索词' }, execOf())
    assert.equal(fetch.calls[0].body.limit, 25)
    assert.equal(value.items.length, 25)
  })

  it('未配置设置 → 默认 10', async () => {
    const fetch = searchFetch(100)
    const { tools } = mountTools({
      IMA_X_IMA_COOKIE: COOKIE,
      IMA_X_IMA_BKN: BKN,
      IMA_KNOWLEDGE_BASE_IDS: 'kb-1',
    }, fetch.impl)
    const search = tools.find((tool) => tool.name === 'ima_kb_search')
    const value = await search.execute({ query: '检索词' }, execOf())
    assert.equal(fetch.calls[0].body.limit, 10)
    assert.equal(value.items.length, 10)
  })

  it('显式 limit 优先于设置值', async () => {
    const fetch = searchFetch(100)
    const { tools } = mountTools({
      IMA_X_IMA_COOKIE: COOKIE,
      IMA_X_IMA_BKN: BKN,
      IMA_KNOWLEDGE_BASE_IDS: 'kb-1',
      [IMA_KNOWLEDGE_SEARCH_LIMIT_REF]: '25',
    }, fetch.impl)
    const search = tools.find((tool) => tool.name === 'ima_kb_search')
    const value = await search.execute({ query: '检索词', limit: 3 }, execOf())
    assert.equal(fetch.calls[0].body.limit, 3)
    assert.equal(value.items.length, 3)
  })

  it('显式 limit 超过 100 时收敛到 100（工具声明范围）', async () => {
    const fetch = searchFetch(100)
    const { tools } = mountTools({
      IMA_X_IMA_COOKIE: COOKIE,
      IMA_X_IMA_BKN: BKN,
      IMA_KNOWLEDGE_BASE_IDS: 'kb-1',
    }, fetch.impl)
    const search = tools.find((tool) => tool.name === 'ima_kb_search')
    await search.execute({ query: '检索词', limit: 500 }, execOf())
    assert.equal(fetch.calls[0].body.limit, 100)
  })

  it('设置值脏掉时回落 10，不影响检索本身', async () => {
    const fetch = searchFetch(100)
    const { tools } = mountTools({
      IMA_X_IMA_COOKIE: COOKIE,
      IMA_X_IMA_BKN: BKN,
      IMA_KNOWLEDGE_BASE_IDS: 'kb-1',
      [IMA_KNOWLEDGE_SEARCH_LIMIT_REF]: 'not-a-number',
    }, fetch.impl)
    const search = tools.find((tool) => tool.name === 'ima_kb_search')
    const value = await search.execute({ query: '检索词' }, execOf())
    assert.equal(fetch.calls[0].body.limit, 10)
    assert.equal(value.items.length, 10)
  })

  it('工具描述写明了 1-100 与「默认取插件设置」', () => {
    const { tools } = mountTools({}, searchFetch().impl)
    const search = tools.find((tool) => tool.name === 'ima_kb_search')
    const description = search.parameters.properties.limit.description
    assert.match(description, /1-100/u)
    assert.match(description, /plugin settings/u)
  })

  it('检索策略段提示「默认 10，可在插件设置里改」', () => {
    const text = buildRetrievalPolicyText(['kb-1'])
    assert.match(text, /默认 10/u)
    assert.match(text, /1-100/u)
  })
})

// ------------------------------------------------------- 浏览器侧纯函数

/**
 * 在独立作用域里求值侧边栏片段，取回检索条数相关纯函数。
 * @returns {Promise<object>} 纯函数集合。
 */
async function loadSidebarPure() {
  const source = await readFile(SIDEBAR_FRAGMENT, 'utf8')
  // eslint-disable-next-line no-new-func
  return new Function(`${source}\nreturn { sbLimitOf, sbLimitDraft, sbRecord };`)()
}

describe('浏览器侧：sbLimitOf（首帧容错）', () => {
  it('正常返回 → 原样使用', async () => {
    const { sbLimitOf } = await loadSidebarPure()
    assert.deepEqual(sbLimitOf({ searchLimit: 25, min: 1, max: 100 }), { limit: 25, min: 1, max: 100 })
  })

  it('空响应 / 老宿主（无 min/max）→ 默认 10 + 1-100', async () => {
    const { sbLimitOf } = await loadSidebarPure()
    assert.deepEqual(sbLimitOf({}), { limit: 10, min: 1, max: 100 })
    assert.deepEqual(sbLimitOf(undefined), { limit: 10, min: 1, max: 100 })
    assert.deepEqual(sbLimitOf({ searchLimit: 20 }), { limit: 20, min: 1, max: 100 })
  })

  it('脏值 / 越界 → 收敛，不渲染 NaN / 0', async () => {
    const { sbLimitOf } = await loadSidebarPure()
    assert.equal(sbLimitOf({ searchLimit: 'abc' }).limit, 10)
    assert.equal(sbLimitOf({ searchLimit: 0 }).limit, 1)
    assert.equal(sbLimitOf({ searchLimit: 999 }).limit, 100)
    assert.equal(sbLimitOf({ searchLimit: 12.8 }).limit, 12)
  })
})

describe('浏览器侧：sbLimitDraft（输入校验）', () => {
  it('1-100 的整数通过，并带出数值', async () => {
    const { sbLimitDraft } = await loadSidebarPure()
    assert.deepEqual(sbLimitDraft('1'), { ok: true, value: 1 })
    assert.deepEqual(sbLimitDraft('25'), { ok: true, value: 25 })
    assert.deepEqual(sbLimitDraft('100'), { ok: true, value: 100 })
    assert.deepEqual(sbLimitDraft('  42  '), { ok: true, value: 42 })
  })

  it('空 / 小数 / 越界 / 非数字一律非法（不静默取整）', async () => {
    const { sbLimitDraft } = await loadSidebarPure()
    for (const bogus of ['', '   ', '0', '101', '1.5', '1e3', '+5', 'abc', '-1', null, undefined, 25]) {
      assert.equal(sbLimitDraft(bogus).ok, false, '输入 ' + JSON.stringify(bogus))
    }
  })
})

describe('浏览器侧：路由与中英文案已落盘', () => {
  it('10-core 的 ROUTES 带 settings，且 zh / en 都有检索条数 key', async () => {
    const core = await readFile(CORE_FRAGMENT, 'utf8')
    // eslint-disable-next-line no-new-func
    const { ROUTES, zh, en } = new Function(`${core}\nreturn { ROUTES, zh, en };`)()
    assert.equal(ROUTES.settings, 'api/ima-knowledge/settings')
    const keys = [
      'sb.limitTitle', 'sb.limitHint', 'sb.limitLabel', 'sb.limitCurrent',
      'sb.limitInvalid', 'sb.limitSave', 'sb.limitSaved', 'sb.limitSaveFailed', 'sb.limitLoadFailed',
    ]
    for (const key of keys) {
      assert.equal(typeof zh[key], 'string', 'zh 缺 ' + key)
      assert.notEqual(zh[key].trim(), '', 'zh 的 ' + key + ' 为空')
      assert.equal(typeof en[key], 'string', 'en 缺 ' + key)
      assert.notEqual(en[key].trim(), '', 'en 的 ' + key + ' 为空')
    }
  })
})
