/**
 * `/api/ima-knowledge/media` 单测（PLATFORM.md §2.2）。
 *
 * 被验收点名的行为：
 * - 逐库检索、条目带 kbId/kbName；
 * - **单库失败不拖垮整体** → 部分成功 + `error` 字段；
 * - 无选中集时回落到全部可访问库，但只取前 3 个（避免 N 次请求打爆上游）；
 * - `query` 为空 → `BAD_REQUEST`。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  IMA_KNOWLEDGE_BASE_IDS_REF,
  IMA_X_IMA_BKN_REF,
  IMA_X_IMA_COOKIE_REF,
  MAX_MEDIA_KNOWLEDGE_BASES,
  ROUTE_ERROR_CODES,
  ROUTE_MEDIA,
  apply,
} from '../lib/host.js'

const COOKIE = 'PLATFORM=H5; IMA-UID=001a9a23fd8033bb; IMA-TOKEN=ABCDEFGHIJKLMNOP; IMA-REFRESH-TOKEN=ref-xyz'
const BKN = '193485963'

/** 与 DSH CredentialProvider 签名一致的假凭据服务。 */
function fakeCredentials(store) {
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
      return { configured: store[ref] !== undefined, source: store[ref] === undefined ? undefined : 'file', writable: true }
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

/** 挂载路由并暴露一个 POST 助手。 */
function mount(store, fetchImpl) {
  const credentials = fakeCredentials(store)
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
  const mediaRoute = routes.find((route) => route.path === ROUTE_MEDIA)
  const post = async (body) => {
    const response = await mediaRoute.fetch(new Request('http://host/x', {
      method: 'POST',
      body: JSON.stringify(body),
    }))
    return { status: response.status, headers: response.headers, payload: await response.json() }
  }
  return { credentials, post, mediaRoute }
}

/** 列库载荷。 */
function listPayload(entries) {
  return {
    code: 0,
    msg: 'ok',
    is_end: true,
    next_cursor: '',
    searched_knowledge_bases: entries.map((entry) => ({ id: entry.id, name: entry.name, type: 1, join_type: 0 })),
  }
}

/** 检索命中载荷（真机字段名：info_list + media_id/title/highlight_content）。 */
function hitsPayload(hits) {
  return {
    code: 0,
    msg: 'ok',
    is_end: true,
    next_cursor: '',
    info_list: hits.map((hit) => ({
      media_id: hit.mediaId,
      title: hit.title,
      highlight_content: hit.highlight,
    })),
  }
}

/**
 * 造一个按 URL 分流的假 fetch：列库与逐库检索各自可控。
 * @param {{knowledgeBases?: Array<{id:string,name:string}>, hits?: Record<string, any[]>,
 *   failKbs?: string[], listFails?: boolean}} plan - 行为计划。
 */
function plannedFetch(plan = {}) {
  const calls = []
  const impl = async (url, init) => {
    const path = String(url)
    const body = init?.body === undefined ? undefined : JSON.parse(init.body)
    calls.push({ path, body })
    if (path.endsWith('/search_knowledge_base')) {
      if (plan.listFails === true) return Response.json({ code: 51, msg: 'bad param' })
      return Response.json(listPayload(plan.knowledgeBases ?? []))
    }
    if (path.endsWith('/search_knowledge')) {
      const kbId = body.knowledge_base_id
      if ((plan.failKbs ?? []).includes(kbId)) return Response.json({ code: 51, msg: 'kb unavailable' })
      return Response.json(hitsPayload((plan.hits ?? {})[kbId] ?? []))
    }
    throw new Error(`unexpected path ${path}`)
  }
  return { impl, calls }
}

// --------------------------------------------------------------- 参数校验

describe('media: 参数校验', () => {
  it('rejects an empty query with BAD_REQUEST', async () => {
    const { post } = mount({}, plannedFetch().impl)
    for (const body of [{}, { query: '' }, { query: '   ' }, { query: 42 }]) {
      const { payload } = await post(body)
      assert.equal(payload.ok, false, `body=${JSON.stringify(body)} 应被拒`)
      assert.equal(payload.error.code, ROUTE_ERROR_CODES.badRequest)
      assert.match(payload.error.message, /query/u)
    }
  })

  it('rejects a non-array or malformed kbIds with BAD_REQUEST', async () => {
    const { post } = mount({}, plannedFetch().impl)
    for (const kbIds of ['kb-1', 5, ['kb-1', '']]) {
      const { payload } = await post({ query: '合同', kbIds })
      assert.equal(payload.ok, false, `kbIds=${JSON.stringify(kbIds)} 应被拒`)
      assert.equal(payload.error.code, ROUTE_ERROR_CODES.badRequest)
    }
  })
})

// --------------------------------------------------------------- 聚合行为

describe('media: 跨库聚合', () => {
  it('aggregates two knowledge bases, tagging each item with kbId and kbName', async () => {
    const plan = {
      knowledgeBases: [{ id: 'kb-1', name: '产品手册' }, { id: 'kb-2', name: '运维记录' }],
      hits: {
        'kb-1': [{ mediaId: 'm-1', title: '合同模板', highlight: '甲乙双方…' }],
        'kb-2': [{ mediaId: 'm-2', title: '值班表' }],
      },
    }
    const { impl, calls } = plannedFetch(plan)
    const { post } = mount({ [IMA_X_IMA_COOKIE_REF]: COOKIE, [IMA_X_IMA_BKN_REF]: BKN }, impl)
    const { status, headers, payload } = await post({ query: '合同', kbIds: ['kb-1', 'kb-2'] })

    assert.equal(status, 200)
    assert.equal(headers.get('cache-control'), 'no-store')
    assert.equal(payload.ok, true)
    assert.deepEqual(payload.value.items, [
      { mediaId: 'm-1', title: '合同模板', kbId: 'kb-1', kbName: '产品手册', highlight: '甲乙双方…' },
      { mediaId: 'm-2', title: '值班表', kbId: 'kb-2', kbName: '运维记录' },
    ])
    // 每个库各打了一次检索（不是只查第一个库）。
    const searchBodies = calls.filter((call) => call.path.endsWith('/search_knowledge')).map((call) => call.body)
    assert.deepEqual(searchBodies.map((body) => body.knowledge_base_id), ['kb-1', 'kb-2'])
    assert.equal(searchBodies[0].query, '合同')
  })

  it('returns partial results plus an error field when one knowledge base fails', async () => {
    const plan = {
      knowledgeBases: [{ id: 'kb-1', name: '产品手册' }, { id: 'kb-2', name: '运维记录' }],
      hits: { 'kb-1': [{ mediaId: 'm-1', title: '合同模板', highlight: '命中片段' }] },
      failKbs: ['kb-2'],
    }
    const { post } = mount({ [IMA_X_IMA_COOKIE_REF]: COOKIE, [IMA_X_IMA_BKN_REF]: BKN }, plannedFetch(plan).impl)
    const { payload } = await post({ query: '合同', kbIds: ['kb-1', 'kb-2'] })

    // 整体仍成功：好库的结果必须照返。
    assert.equal(payload.ok, true)
    assert.equal(payload.value.items.length, 1)
    assert.equal(payload.value.items[0].kbId, 'kb-1')
    // 坏库记进 error，且能定位到是哪个库。
    assert.equal(typeof payload.value.error, 'string')
    assert.match(payload.value.error, /部分知识库检索失败/u)
    assert.match(payload.value.error, /kb-2/u)
    assert.match(payload.value.error, /运维记录/u)
    assert.match(payload.value.error, /code 51|kb unavailable/u)
  })

  it('reports an error field without dropping items when ALL bases fail', async () => {
    const plan = {
      knowledgeBases: [{ id: 'kb-1', name: 'A' }],
      failKbs: ['kb-1'],
    }
    const { post } = mount({ [IMA_X_IMA_COOKIE_REF]: COOKIE, [IMA_X_IMA_BKN_REF]: BKN }, plannedFetch(plan).impl)
    const { payload } = await post({ query: 'x', kbIds: ['kb-1'] })
    assert.equal(payload.ok, true)
    assert.deepEqual(payload.value.items, [])
    assert.match(payload.value.error, /kb-1/u)
  })

  it('deduplicates repeated kbIds and repeated media ids', async () => {
    const plan = {
      knowledgeBases: [{ id: 'kb-1', name: 'A' }],
      hits: { 'kb-1': [{ mediaId: 'm-1', title: 'T', highlight: 'h' }, { mediaId: 'm-1', title: 'T', highlight: 'h' }] },
    }
    const { impl, calls } = plannedFetch(plan)
    const { post } = mount({ [IMA_X_IMA_COOKIE_REF]: COOKIE, [IMA_X_IMA_BKN_REF]: BKN }, impl)
    const { payload } = await post({ query: 'x', kbIds: ['kb-1', 'kb-1'] })

    assert.equal(payload.value.items.length, 1)
    assert.equal(calls.filter((call) => call.path.endsWith('/search_knowledge')).length, 1)
  })

  it('honours the limit and clamps a bogus one to the default', async () => {
    const plan = {
      knowledgeBases: [{ id: 'kb-1', name: 'A' }],
      hits: { 'kb-1': [{ mediaId: 'm-1', title: 'T', highlight: 'h' }] },
    }
    const { impl, calls } = plannedFetch(plan)
    const { post } = mount({ [IMA_X_IMA_COOKIE_REF]: COOKIE, [IMA_X_IMA_BKN_REF]: BKN }, impl)

    await post({ query: 'x', kbIds: ['kb-1'], limit: 3 })
    await post({ query: 'x', kbIds: ['kb-1'], limit: -5 })
    const limits = calls.filter((call) => call.path.endsWith('/search_knowledge')).map((call) => call.body.limit)
    assert.deepEqual(limits, [3, 10])
  })

  it('omits highlight when the upstream returns none', async () => {
    const plan = {
      knowledgeBases: [{ id: 'kb-1', name: 'A' }],
      hits: { 'kb-1': [{ mediaId: 'm-1', title: 'T' }] },
    }
    const { post } = mount({ [IMA_X_IMA_COOKIE_REF]: COOKIE, [IMA_X_IMA_BKN_REF]: BKN }, plannedFetch(plan).impl)
    const { payload } = await post({ query: 'x', kbIds: ['kb-1'] })
    assert.equal('highlight' in payload.value.items[0], false)
  })
})

// --------------------------------------------------- 库集合的取法（三级回落）

describe('media: 库集合的取法', () => {
  it('defaults to the current selection when kbIds is absent', async () => {
    const plan = {
      knowledgeBases: [{ id: 'kb-1', name: 'A' }, { id: 'kb-2', name: 'B' }],
      hits: { 'kb-2': [{ mediaId: 'm-2', title: 'B 命中', highlight: 'h' }] },
    }
    const { impl, calls } = plannedFetch(plan)
    const store = {
      [IMA_X_IMA_COOKIE_REF]: COOKIE,
      [IMA_X_IMA_BKN_REF]: BKN,
      [IMA_KNOWLEDGE_BASE_IDS_REF]: 'kb-2',
    }
    const { post } = mount(store, impl)
    const { payload } = await post({ query: 'x' })

    assert.equal(payload.ok, true)
    const searched = calls.filter((call) => call.path.endsWith('/search_knowledge')).map((call) => call.body.knowledge_base_id)
    assert.deepEqual(searched, ['kb-2'])
    assert.equal(payload.value.items[0].kbName, 'B')
  })

  it('falls back to ALL accessible bases but only the first 3 when nothing is selected', async () => {
    const all = Array.from({ length: 6 }, (_, index) => ({ id: `kb-${index + 1}`, name: `库${index + 1}` }))
    const { impl, calls } = plannedFetch({ knowledgeBases: all, hits: {} })
    const { post } = mount({ [IMA_X_IMA_COOKIE_REF]: COOKIE, [IMA_X_IMA_BKN_REF]: BKN }, impl)
    const { payload } = await post({ query: 'x' })

    assert.equal(payload.ok, true)
    const searched = calls.filter((call) => call.path.endsWith('/search_knowledge')).map((call) => call.body.knowledge_base_id)
    // 上游是逐库请求，必须截断，否则账号库多了会打出 N 次请求。
    assert.equal(searched.length, MAX_MEDIA_KNOWLEDGE_BASES)
    assert.equal(MAX_MEDIA_KNOWLEDGE_BASES, 3)
    assert.deepEqual(searched, ['kb-1', 'kb-2', 'kb-3'])
  })

  it('returns an empty list when nothing is selected and the account has no bases', async () => {
    const { impl, calls } = plannedFetch({ knowledgeBases: [], hits: {} })
    const { post } = mount({ [IMA_X_IMA_COOKIE_REF]: COOKIE, [IMA_X_IMA_BKN_REF]: BKN }, impl)
    const { payload } = await post({ query: 'x' })
    assert.equal(payload.ok, true)
    assert.deepEqual(payload.value.items, [])
    assert.equal(calls.filter((call) => call.path.endsWith('/search_knowledge')).length, 0)
  })

  it('still searches explicit kbIds when the library list fails, using the id as kbName', async () => {
    const { impl } = plannedFetch({ listFails: true, hits: { 'kb-9': [{ mediaId: 'm-9', title: 'T', highlight: 'h' }] } })
    const { post } = mount({ [IMA_X_IMA_COOKIE_REF]: COOKIE, [IMA_X_IMA_BKN_REF]: BKN }, impl)
    const { payload } = await post({ query: 'x', kbIds: ['kb-9'] })

    assert.equal(payload.ok, true)
    assert.equal(payload.value.items.length, 1)
    assert.equal(payload.value.items[0].kbId, 'kb-9')
    // 拿不到库名时回退成 id —— 不伪造、不中断。
    assert.equal(payload.value.items[0].kbName, 'kb-9')
    assert.match(payload.value.error, /无法读取知识库列表/u)
  })

  it('surfaces a missing credential as a failed envelope, not an empty success', async () => {
    const { post } = mount({}, plannedFetch().impl)
    const { status, payload } = await post({ query: 'x' })
    assert.equal(status, 200)
    assert.equal(payload.ok, false)
    assert.equal(payload.error.code, 'ima-knowledge/not-configured')
    assert.match(payload.error.message, /IMA_X_IMA_COOKIE/u)
    // 提示主入口改成侧边栏面板（设置页作为次入口保留）。
    assert.match(payload.error.message, /侧边栏/u)
  })
})
