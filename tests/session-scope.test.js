/**
 * 会话级知识库选择单测（PLATFORM.md §9）。
 *
 * 防的缺陷（用户原话，§9.1）：选中集存在 credential store 的
 * `IMA_KNOWLEDGE_BASE_IDS`，是**账号级全局** —— 会话1 选过的库，会话2 也看得见。
 * 本文件锁死 §9.2 的四条冻结行为 + §9.3 的 `undefined` vs `[]` 区分 + §9.5 的路由。
 *
 * 断言纪律（沿用 api.test.js 的惯例）：期望值独立复算，不 import 被测实现来算期望。
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import {
  IMA_KNOWLEDGE_BASE_IDS_REF,
  IMA_X_IMA_BKN_REF,
  IMA_X_IMA_COOKIE_REF,
  ROUTE_SESSION_STATE,
  apply,
  createHostSessionStore,
  __internals,
} from '../lib/host.js'
import {
  createFileSessionStore,
  createMemorySessionStore,
  createSessionStore,
  createStorageSessionStore,
  decodeSessionRecord,
  encodeSessionRecord,
  normalizeSelectedIds,
} from '../lib/session-store.js'

// --------------------------------------------------------------- 脚手架

/** 一个可用的 cookie / bkn 组合（与 api.test.js 同形，不复用其变量以免耦合）。 */
const COOKIE = 'PLATFORM=H5; IMA-UID=user-1; IMA-TOKEN=tok-abc; IMA-REFRESH-TOKEN=ref-xyz; IMA-GUID=guid-9'
const BKN = '193485963'

/**
 * 假 credentials（与 DSH CredentialProvider 签名一致）。
 * @param {Record<string,string>} store - 假存储。
 * @returns {object} 假服务。
 */
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

/** 列库固定返回 kb-1 / kb-2 的假 fetch（只用于 /select 的 id 校验）。 */
function listFetch() {
  return async () => Response.json({
    code: 0,
    msg: 'ok',
    is_end: true,
    next_cursor: '',
    searched_knowledge_bases: [
      { id: 'kb-1', name: 'A', type: 1, join_type: 0 },
      { id: 'kb-2', name: 'B', type: 1, join_type: 0 },
    ],
  })
}

/**
 * 组装一套带会话存储的假宿主。
 * @param {Record<string,string>} store - 假凭据存储。
 * @param {object} [options] - `{fetchImpl, sessionStore, storage}`。
 * @returns {{tools: object[], routes: object[], credentials: object, sessionStore: object, applyResult: object}} 句柄。
 */
function mount(store, options = {}) {
  const tools = []
  const routes = []
  const credentials = fakeCredentials(store)
  const ctx = {
    effect: (callback) => callback(),
    inject: (_services, callback) => callback(ctx),
    get: (service) => {
      if (service === 'tools') return { register: (tool) => { tools.push(tool); return () => {} } }
      if (service === 'credentials') return credentials
      if (service === 'storage') return options.storage
      if (service === 'connection') {
        return { fetch: { register: (route) => { routes.push(route); return async () => {} } } }
      }
      return undefined
    },
  }
  // apply 的返回值必须是 void（cordis 把插件回调返回值当 effect 消费），
  // 所以存储要从 createHostSessionStore 单独取 —— 与 apply 内部走同一条探测路径。
  const sessionStore = options.sessionStore ?? createHostSessionStore(ctx, {
    ...(options.sessionStoreFile === undefined ? {} : { sessionStoreFile: options.sessionStoreFile }),
  })
  apply(ctx, { fetchImpl: options.fetchImpl ?? listFetch(), sessionStore })
  const route = (path) => routes.find((entry) => entry.path === path)
  const tool = (name) => tools.find((entry) => entry.name === name)
  const post = async (path, body) => {
    const response = await route(path).fetch(new Request('http://host/x', {
      method: 'POST',
      body: JSON.stringify(body),
    }))
    return { status: response.status, payload: await response.json() }
  }
  return { tools, routes, credentials, route, tool, post, sessionStore }
}

/** 造一个 `exec`（DSH 工具执行上下文的最小子集：agent.id 即 SessionId）。 */
function execOf(sessionId) {
  return { signal: new AbortController().signal, agent: { id: sessionId } }
}

/** 造一个「问一句就回固定答案」的 fetch，并记录每次问的库 id。 */
function askFetch() {
  const asked = []
  const impl = async (url, init) => {
    if (String(url).endsWith('/init_session')) {
      asked.push(JSON.parse(init.body).relatedUrl)
      return Response.json({ code: 0, session_id: 'sess-1' })
    }
    return new Response('data: {"content":"答案"}\n\n', { headers: { 'content-type': 'text/event-stream' } })
  }
  return { impl, asked }
}

/** 造一个「检索就回空列表」的 fetch，并记录请求体里的 knowledge_base_id。 */
function searchFetch() {
  const used = []
  const impl = async (_url, init) => {
    used.push(JSON.parse(init.body).knowledge_base_id)
    return Response.json({ code: 0, msg: 'ok', is_end: true, next_cursor: '', info_list: [] })
  }
  return { impl, used }
}

// ------------------------------------------------- session-store 单元层

describe('session-store: undefined 与 [] 的严格区分', () => {
  it('memory: 无记录 = undefined；显式 [] = 空数组（两者不同）', async () => {
    const store = createMemorySessionStore()
    assert.equal(await store.getSelected('sess-a'), undefined, '无记录必须是 undefined，不能是 []')
    await store.setSelected('sess-a', [])
    const cleared = await store.getSelected('sess-a')
    assert.deepEqual(cleared, [], '显式不选必须是 []')
    assert.notEqual(cleared, undefined, '[] 绝不能与 undefined 混淆')
    // 两者在真值判断上也必须可分（`undefined == null` 但 `[]` 是 truthy）。
    assert.equal(cleared === undefined, false)
  })

  it('memory: setSelected 归一化（去空白/去重/保序），空串项被丢掉', async () => {
    const store = createMemorySessionStore()
    await store.setSelected('s', [' kb-1 ', 'kb-1', '', 'kb-2'])
    assert.deepEqual(await store.getSelected('s'), ['kb-1', 'kb-2'])
  })

  it('memory: 会话之间互不可见（隔离）', async () => {
    const store = createMemorySessionStore()
    await store.setSelected('sess-a', ['kb-x'])
    assert.deepEqual(await store.getSelected('sess-a'), ['kb-x'])
    assert.equal(await store.getSelected('sess-b'), undefined)
  })

  it('memory: getSelected 返回副本，调用方改数组不会污染存储', async () => {
    const store = createMemorySessionStore({ s: ['kb-1'] })
    const first = await store.getSelected('s')
    first.push('kb-injected')
    assert.deepEqual(await store.getSelected('s'), ['kb-1'])
  })

  it('decodeSessionRecord: 只有 ids 是数组才算「有记录」，损坏记录当无记录', () => {
    assert.deepEqual(decodeSessionRecord({ ids: ['kb-1'] }), ['kb-1'])
    // 空数组是**有效记录**（明确不选），不是损坏。
    assert.deepEqual(decodeSessionRecord({ ids: [] }), [])
    // 以下都是「无记录」，绝不能读成 []（否则用户会莫名失去知识库）。
    assert.equal(decodeSessionRecord({}), undefined)
    assert.equal(decodeSessionRecord({ ids: 'kb-1' }), undefined)
    assert.equal(decodeSessionRecord(null), undefined)
    assert.equal(decodeSessionRecord(undefined), undefined)
    assert.equal(decodeSessionRecord('kb-1'), undefined)
  })

  it('encodeSessionRecord: 恒定产出 {ids: string[]}，[] 照存', () => {
    assert.deepEqual(encodeSessionRecord(['kb-1']), { ids: ['kb-1'] })
    assert.deepEqual(encodeSessionRecord([]), { ids: [] })
    assert.deepEqual(encodeSessionRecord(undefined), { ids: [] })
  })

  it('normalizeSelectedIds: 非数组返回 undefined（与空数组区分）', () => {
    assert.equal(normalizeSelectedIds(undefined), undefined)
    assert.equal(normalizeSelectedIds('kb-1'), undefined)
    assert.deepEqual(normalizeSelectedIds([]), [])
  })
})

describe('session-store: 文件档（降级方案）', () => {
  it('落盘后重新打开仍是同一份记录，且 [] 与无记录仍可分', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ima-sess-'))
    const file = join(dir, 'session-selections.json')
    try {
      const first = createFileSessionStore({ file })
      await first.setSelected('sess-a', ['kb-1'])
      await first.setSelected('sess-c', [])
      await first.close()

      const reopened = createFileSessionStore({ file })
      assert.deepEqual(await reopened.getSelected('sess-a'), ['kb-1'])
      assert.deepEqual(await reopened.getSelected('sess-c'), [], '显式 [] 必须跨进程存活')
      assert.equal(await reopened.getSelected('sess-b'), undefined, '从未写过的会话必须仍是 undefined')
      await reopened.close()

      // 介质形状：键存在 vs 键缺失。
      const raw = JSON.parse(await readFile(file, 'utf8'))
      assert.deepEqual(raw.sessions['sess-a'], ['kb-1'])
      assert.deepEqual(raw.sessions['sess-c'], [])
      assert.equal('sess-b' in raw.sessions, false, '无记录的会话不能落成空数组')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('文件不存在是正常初始态（全部 undefined），不是错误', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ima-sess-'))
    try {
      const store = createFileSessionStore({ file: join(dir, 'nope.json') })
      assert.equal(await store.getSelected('any'), undefined)
      await store.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('session-store: storage 档（ctx.storage）', () => {
  /**
   * 造一个最小可用的假 `ctx.storage`：只有 `backend.get(name).kv.open(descriptor)`。
   * 形状取自 `packages/storage/storage/src/backend.ts` 的 KvFacet / KvUnit。
   * @returns {object} 假 storage。
   */
  function fakeStorage() {
    /** @type {Map<string, unknown>} */
    const rows = new Map()
    const opened = []
    return {
      rows,
      opened,
      backend: {
        get(name) {
          assert.equal(name, 'json')
          return {
            kv: {
              async open(descriptor) {
                opened.push(descriptor)
                return {
                  async loadAll() {
                    return { tables: { [descriptor.tables[0]]: Object.fromEntries(rows) }, global: null }
                  },
                  async putRecord(table, key, value) {
                    assert.equal(table, descriptor.tables[0])
                    rows.set(key, value)
                  },
                  async deleteRecord(table, key) {
                    rows.delete(key)
                  },
                  async close() {},
                }
              },
            },
          }
        },
      },
    }
  }

  it('用 KvFacet 打开单元，按会话存 {ids}', async () => {
    const storage = fakeStorage()
    const store = createStorageSessionStore(storage)
    assert.equal(await store.getSelected('sess-a'), undefined)
    await store.setSelected('sess-a', ['kb-1'])
    await store.setSelected('sess-c', [])
    assert.deepEqual(await store.getSelected('sess-a'), ['kb-1'])
    assert.deepEqual(await store.getSelected('sess-c'), [])
    assert.equal(await store.getSelected('sess-b'), undefined)
    // 介质形状就是 §9.3 说的「键 = SessionId，值 = {ids}」。
    assert.deepEqual(storage.rows.get('sess-a'), { ids: ['kb-1'] })
    assert.deepEqual(storage.rows.get('sess-c'), { ids: [] })
    // 单元描述符必须匹配 UNIT_NAME_RE 且声明表。
    assert.equal(storage.opened.length, 1)
    assert.equal(storage.opened[0].name, 'ima_knowledge_sessions')
    assert.match(storage.opened[0].name, /^[a-z][a-z0-9_]*$/u)
    await store.close()
  })

  it('storage 不可用时报错，让 createSessionStore 能显式降级（不静默假装成功）', async () => {
    const store = createStorageSessionStore({ backend: { get: () => undefined } })
    await assert.rejects(() => store.ready(), /backend 'json' 未注册/u)
  })
})

describe('session-store: 探测与降级顺序', () => {
  it('有 storage 就走 storage', async () => {
    const storage = {
      backend: {
        get: () => ({
          kv: {
            async open() {
              return {
                async loadAll() { return { tables: { sessions: {} }, global: null } },
                async putRecord() {},
                async deleteRecord() {},
                async close() {},
              }
            },
          },
        }),
      },
    }
    const store = createSessionStore({ storage, file: false })
    assert.equal(await store.ready(), 'storage')
    assert.equal(store.describe().scope, 'storage')
    await store.close()
  })

  it('storage 打开失败 → 降级到文件档，并在 describe 里如实记录失败原因', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ima-sess-'))
    try {
      const store = createSessionStore({
        // 有 storage 但 backend 未注册 → storage 档 ready() 抛错。
        storage: { backend: { get: () => undefined } },
        file: join(dir, 's.json'),
      })
      assert.equal(await store.ready(), 'file')
      const described = store.describe()
      assert.equal(described.scope, 'file')
      assert.equal(described.attempts[0].scope, 'storage')
      assert.match(described.attempts[0].error, /未注册/u, '降级必须留下可诊断的失败原因')
      await store.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('无 storage 且禁用文件档 → 内存档兜底', async () => {
    const store = createSessionStore({ file: false })
    assert.equal(await store.ready(), 'memory')
    await store.close()
  })
})

// ------------------------------------------------------ 工具层：会话隔离

describe('工具: 会话级选中集', () => {
  it('会话 A 选 [kb-x] → A 查到 [kb-x]；会话 B 查不到（隔离）', async () => {
    const store = createMemorySessionStore()
    await store.setSelected('sess-a', ['kb-x'])
    const { tool } = mount(
      { [IMA_X_IMA_COOKIE_REF]: COOKIE, [IMA_X_IMA_BKN_REF]: BKN },
      { sessionStore: store },
    )
    const listTool = tool('ima_kb_list')

    const a = await listTool.execute({}, execOf('sess-a'))
    assert.deepEqual(a.selected, ['kb-x'], '会话 A 必须看到自己选的库')
    assert.equal(a.scope, 'session')
    assert.equal(a.sessionId, 'sess-a')

    const b = await listTool.execute({}, execOf('sess-b'))
    assert.deepEqual(b.selected, [], '会话 B 没选过，必须看不到 A 的选择')
    assert.equal(b.sessionId, 'sess-b')
  })

  it('会话 B 无记录 → 继承全局默认值，且 inherited:true', async () => {
    const store = createMemorySessionStore()
    const { tool, post } = mount(
      { [IMA_X_IMA_COOKIE_REF]: COOKIE, [IMA_X_IMA_BKN_REF]: BKN, [IMA_KNOWLEDGE_BASE_IDS_REF]: 'kb-default' },
      { sessionStore: store },
    )
    const listed = await tool('ima_kb_list').execute({}, execOf('sess-b'))
    assert.deepEqual(listed.selected, ['kb-default'], '无会话记录时回落到全局默认值')
    assert.equal(listed.sessionId, 'sess-b')

    const state = await post(ROUTE_SESSION_STATE, { sessionId: 'sess-b' })
    assert.equal(state.payload.ok, true)
    assert.deepEqual(state.payload.value.selected, ['kb-default'])
    assert.equal(state.payload.value.inherited, true, '继承来的值必须标 inherited:true')
  })

  it('继承**不写回**会话级：查一次之后仍然 inherited:true', async () => {
    const store = createMemorySessionStore()
    const { post } = mount(
      { [IMA_X_IMA_COOKIE_REF]: COOKIE, [IMA_X_IMA_BKN_REF]: BKN, [IMA_KNOWLEDGE_BASE_IDS_REF]: 'kb-default' },
      { sessionStore: store },
    )
    await post(ROUTE_SESSION_STATE, { sessionId: 'sess-b' })
    const again = await post(ROUTE_SESSION_STATE, { sessionId: 'sess-b' })
    assert.equal(again.payload.value.inherited, true, '继承是只读的，不得悄悄写会话记录')
    assert.equal(await store.getSelected('sess-b'), undefined, '读侧不得产生会话级记录')
  })

  it('会话 C 显式选 [] → 工具抛错（不回退默认值）', async () => {
    const store = createMemorySessionStore()
    await store.setSelected('sess-c', [])
    const { tool } = mount(
      { [IMA_X_IMA_COOKIE_REF]: COOKIE, [IMA_X_IMA_BKN_REF]: BKN, [IMA_KNOWLEDGE_BASE_IDS_REF]: 'kb-default' },
      { sessionStore: store },
    )
    await assert.rejects(
      () => tool('ima_kb_ask').execute({ question: '问?' }, execOf('sess-c')),
      (error) => {
        // 关键：**不能**回退到全局默认值 kb-default，必须明确拒绝。
        assert.match(error.message, /本会话未选择知识库/u)
        assert.doesNotMatch(error.message, /kb-default/u)
        return true
      },
    )
    await assert.rejects(
      () => tool('ima_kb_search').execute({ query: '词' }, execOf('sess-c')),
      /本会话未选择知识库/u,
    )
  })

  it('显式 [] 与「无记录」在工具层行为不同（这是最容易写错的地方）', async () => {
    const store = createMemorySessionStore()
    await store.setSelected('sess-cleared', [])
    const globalDefault = 'kb-default'
    const { tool } = mount(
      { [IMA_X_IMA_COOKIE_REF]: COOKIE, [IMA_X_IMA_BKN_REF]: BKN, [IMA_KNOWLEDGE_BASE_IDS_REF]: globalDefault },
      { sessionStore: store },
    )
    const { impl, asked } = askFetch()
    void impl
    // 无记录 → 继承默认值 → 能问（用 kb-default）。
    const asked2 = []
    const askImpl = async (url, init) => {
      if (String(url).endsWith('/init_session')) {
        asked2.push(JSON.parse(init.body).relatedUrl)
        return Response.json({ code: 0, session_id: 'sess-1' })
      }
      return new Response('data: {"content":"答案"}\n\n', { headers: { 'content-type': 'text/event-stream' } })
    }
    const mounted = mount(
      { [IMA_X_IMA_COOKIE_REF]: COOKIE, [IMA_X_IMA_BKN_REF]: BKN, [IMA_KNOWLEDGE_BASE_IDS_REF]: globalDefault },
      { sessionStore: store, fetchImpl: askImpl },
    )
    void tool
    const answered = await mounted.tool('ima_kb_ask').execute({ question: '问?' }, execOf('sess-untouched'))
    assert.equal(answered.answer, '答案')
    assert.deepEqual(asked2, [globalDefault], '无记录 → 继承默认值 kb-default')

    // 显式 [] → 拒绝（同一套凭据、同一个全局默认值，行为必须不同）。
    await assert.rejects(
      () => mounted.tool('ima_kb_ask').execute({ question: '问?' }, execOf('sess-cleared')),
      /本会话未选择知识库/u,
    )
    assert.equal(asked2.length, 1, '显式 [] 时绝不能发出提问请求')
    assert.equal(asked.length, 0)
  })

  it('会话 A 写入选中集后，全局默认值不被修改', async () => {
    const store = createMemorySessionStore()
    const credStore = {
      [IMA_X_IMA_COOKIE_REF]: COOKIE,
      [IMA_X_IMA_BKN_REF]: BKN,
      [IMA_KNOWLEDGE_BASE_IDS_REF]: 'kb-global',
    }
    const { post, credentials } = mount(credStore, { sessionStore: store })
    const saved = await post('/api/ima-knowledge/select', { sessionId: 'sess-a', ids: ['kb-1'] })
    assert.equal(saved.payload.ok, true)
    assert.deepEqual(saved.payload.value.selected, ['kb-1'])
    assert.deepEqual(await store.getSelected('sess-a'), ['kb-1'])
    // 全局默认值一个字节都不许动。
    assert.equal(credStore[IMA_KNOWLEDGE_BASE_IDS_REF], 'kb-global', '会话级写入绝不能改全局默认值')
    assert.equal(credentials.writes.length, 0, '会话级写入不得产生任何 credential 写')
  })

  it('显式传 knowledgeBaseId 时不受会话选中集影响', async () => {
    const store = createMemorySessionStore()
    await store.setSelected('sess-a', ['kb-selected'])
    const { impl, asked } = askFetch()
    const { tool } = mount(
      { [IMA_X_IMA_COOKIE_REF]: COOKIE, [IMA_X_IMA_BKN_REF]: BKN },
      { sessionStore: store, fetchImpl: impl },
    )
    await tool('ima_kb_ask').execute({ question: '问?', knowledgeBaseId: 'kb-explicit' }, execOf('sess-a'))
    assert.deepEqual(asked, ['kb-explicit'], '显式 id 必须压过会话选中集')

    // 会话一个都没选（显式 []）时，显式 id 依然可用。
    const cleared = createMemorySessionStore()
    await cleared.setSelected('sess-c', [])
    const { impl: impl2, asked: asked2 } = askFetch()
    const second = mount(
      { [IMA_X_IMA_COOKIE_REF]: COOKIE, [IMA_X_IMA_BKN_REF]: BKN },
      { sessionStore: cleared, fetchImpl: impl2 },
    )
    await second.tool('ima_kb_ask').execute({ question: '问?', knowledgeBaseId: 'kb-explicit' }, execOf('sess-c'))
    assert.deepEqual(asked2, ['kb-explicit'], '显式 id 在「本会话未选」时也必须能问')

    // search 同理。
    const { impl: searchImpl, used } = searchFetch()
    const third = mount(
      { [IMA_X_IMA_COOKIE_REF]: COOKIE, [IMA_X_IMA_BKN_REF]: BKN },
      { sessionStore: store, fetchImpl: searchImpl },
    )
    await third.tool('ima_kb_search').execute({ query: '词', knowledgeBaseId: 'kb-explicit' }, execOf('sess-a'))
    assert.deepEqual(used, ['kb-explicit'])
  })

  it('会话选中集有多个库时，缺省取第一个（与全局语义一致）', async () => {
    const store = createMemorySessionStore()
    await store.setSelected('sess-a', ['kb-first', 'kb-second'])
    const { impl, asked } = askFetch()
    const { tool } = mount(
      { [IMA_X_IMA_COOKIE_REF]: COOKIE, [IMA_X_IMA_BKN_REF]: BKN },
      { sessionStore: store, fetchImpl: impl },
    )
    await tool('ima_kb_ask').execute({ question: '问?' }, execOf('sess-a'))
    assert.deepEqual(asked, ['kb-first'])
  })

  it('exec 缺失（老宿主/测试直调）→ 退化为全局默认值并标 scope:global', async () => {
    const { tool } = mount(
      { [IMA_X_IMA_COOKIE_REF]: COOKIE, [IMA_X_IMA_BKN_REF]: BKN, [IMA_KNOWLEDGE_BASE_IDS_REF]: 'kb-global' },
      { sessionStore: createMemorySessionStore() },
    )
    const listed = await tool('ima_kb_list').execute({})
    assert.deepEqual(listed.selected, ['kb-global'])
    assert.equal(listed.scope, 'global')
    assert.equal('sessionId' in listed, false, '没有会话上下文时不给 sessionId')
  })

  it('LIST_OUTPUT_SCHEMA 声明 scope / sessionId 且都不进 required', () => {
    const { tool } = mount({ [IMA_X_IMA_COOKIE_REF]: COOKIE, [IMA_X_IMA_BKN_REF]: BKN })
    const schema = tool('ima_kb_list').output.schema
    assert.equal(schema.properties.scope.type, 'string')
    assert.equal(schema.properties.sessionId.type, 'string')
    assert.equal(schema.required.includes('scope'), false)
    assert.equal(schema.required.includes('sessionId'), false)
    // 原三个必填字段一个不少（不放松既有契约）。
    assert.deepEqual([...schema.required].sort(), ['knowledgeBases', 'selected', 'selectedId'])
  })
})

// ------------------------------------------------------ 路由层：§9.5 契约

describe('路由: /list 与 /select 的会话化', () => {
  it('/list 带 sessionId 返回该会话的 selected；不带则退化为全局默认值', async () => {
    const store = createMemorySessionStore()
    await store.setSelected('sess-a', ['kb-1'])
    const { post } = mount(
      { [IMA_X_IMA_COOKIE_REF]: COOKIE, [IMA_X_IMA_BKN_REF]: BKN, [IMA_KNOWLEDGE_BASE_IDS_REF]: 'kb-2' },
      { sessionStore: store },
    )
    const scoped = await post('/api/ima-knowledge/list', { sessionId: 'sess-a' })
    assert.deepEqual(scoped.payload.value.selected, ['kb-1'])
    assert.equal(scoped.payload.value.sessionId, 'sess-a')

    const globalCall = await post('/api/ima-knowledge/list', {})
    assert.deepEqual(globalCall.payload.value.selected, ['kb-2'], '缺 sessionId 时退化全局（兼容旧调用）')
    assert.equal('sessionId' in globalCall.payload.value, false)
    // 旧字段照旧在。
    assert.equal(globalCall.payload.value.status.configured, true)
  })

  it('/select 带 sessionId 写会话级；不带写全局默认值', async () => {
    const store = createMemorySessionStore()
    const credStore = { [IMA_X_IMA_COOKIE_REF]: COOKIE, [IMA_X_IMA_BKN_REF]: BKN }
    const { post, credentials } = mount(credStore, { sessionStore: store })

    const scoped = await post('/api/ima-knowledge/select', { sessionId: 'sess-a', ids: ['kb-1'] })
    assert.deepEqual(scoped.payload.value.selected, ['kb-1'])
    assert.equal(scoped.payload.value.sessionId, 'sess-a')
    assert.deepEqual(await store.getSelected('sess-a'), ['kb-1'])
    assert.equal(credentials.writes.length, 0, '会话级写入不该碰 credential store')

    const global = await post('/api/ima-knowledge/select', { ids: ['kb-2'] })
    assert.deepEqual(global.payload.value.selected, ['kb-2'])
    assert.equal(credStore[IMA_KNOWLEDGE_BASE_IDS_REF], 'kb-2', '无 sessionId 时写全局默认值')
    assert.deepEqual(credentials.writes, [{ ref: IMA_KNOWLEDGE_BASE_IDS_REF, value: 'kb-2' }])
  })

  it('/select 带 sessionId + [] → 写会话级空记录，不 unset 全局', async () => {
    const store = createMemorySessionStore()
    const credStore = {
      [IMA_X_IMA_COOKIE_REF]: COOKIE,
      [IMA_X_IMA_BKN_REF]: BKN,
      [IMA_KNOWLEDGE_BASE_IDS_REF]: 'kb-global',
    }
    const { post, credentials } = mount(credStore, { sessionStore: store })
    const cleared = await post('/api/ima-knowledge/select', { sessionId: 'sess-c', ids: [] })
    assert.equal(cleared.payload.ok, true)
    assert.deepEqual(cleared.payload.value.selected, [])
    // 会话级是「存在但为空」，不是「无记录」。
    assert.deepEqual(await store.getSelected('sess-c'), [])
    // 全局默认值保持不动，也没有 unset。
    assert.equal(credStore[IMA_KNOWLEDGE_BASE_IDS_REF], 'kb-global')
    assert.equal(credentials.unsets.length, 0)
  })

  it('/select 拒绝非字符串的 sessionId', async () => {
    const { post } = mount({ [IMA_X_IMA_COOKIE_REF]: COOKIE, [IMA_X_IMA_BKN_REF]: BKN })
    const payload = (await post('/api/ima-knowledge/select', { sessionId: '   ', ids: ['kb-1'] })).payload
    assert.equal(payload.ok, false)
    assert.equal(payload.error.code, 'ima-knowledge/bad-request')
  })
})

describe('路由: /session-state（§9.5 新增）', () => {
  it('无记录 → {selected: 默认值, inherited:true}', async () => {
    const { post } = mount(
      { [IMA_X_IMA_COOKIE_REF]: COOKIE, [IMA_X_IMA_BKN_REF]: BKN, [IMA_KNOWLEDGE_BASE_IDS_REF]: 'kb-default' },
      { sessionStore: createMemorySessionStore() },
    )
    const { payload } = await post(ROUTE_SESSION_STATE, { sessionId: 'sess-new' })
    assert.equal(payload.ok, true)
    assert.deepEqual(payload.value.selected, ['kb-default'])
    assert.equal(payload.value.inherited, true)
    assert.equal(payload.value.sessionId, 'sess-new')
  })

  it('有记录 → {selected: 会话值, inherited:false}', async () => {
    const store = createMemorySessionStore()
    await store.setSelected('sess-a', ['kb-x'])
    const { post } = mount(
      { [IMA_X_IMA_COOKIE_REF]: COOKIE, [IMA_X_IMA_BKN_REF]: BKN, [IMA_KNOWLEDGE_BASE_IDS_REF]: 'kb-default' },
      { sessionStore: store },
    )
    const { payload } = await post(ROUTE_SESSION_STATE, { sessionId: 'sess-a' })
    assert.deepEqual(payload.value.selected, ['kb-x'])
    assert.equal(payload.value.inherited, false)
  })

  it('显式 [] → {selected: [], inherited:false}（不是继承）', async () => {
    const store = createMemorySessionStore()
    await store.setSelected('sess-c', [])
    const { post } = mount(
      { [IMA_X_IMA_COOKIE_REF]: COOKIE, [IMA_X_IMA_BKN_REF]: BKN, [IMA_KNOWLEDGE_BASE_IDS_REF]: 'kb-default' },
      { sessionStore: store },
    )
    const { payload } = await post(ROUTE_SESSION_STATE, { sessionId: 'sess-c' })
    assert.deepEqual(payload.value.selected, [], '明确不选 = 空集，不得回退默认值')
    assert.equal(payload.value.inherited, false, '明确不选不是继承')
  })

  it('缺 sessionId → BAD_REQUEST', async () => {
    const { post } = mount({ [IMA_X_IMA_COOKIE_REF]: COOKIE, [IMA_X_IMA_BKN_REF]: BKN })
    const { payload } = await post(ROUTE_SESSION_STATE, {})
    assert.equal(payload.ok, false)
    assert.equal(payload.error.code, 'ima-knowledge/bad-request')
  })

  it('路由形状与既有路由一致（POST + buffered + no-store）', async () => {
    const { route } = mount({ [IMA_X_IMA_COOKIE_REF]: COOKIE, [IMA_X_IMA_BKN_REF]: BKN })
    const sessionState = route(ROUTE_SESSION_STATE)
    assert.deepEqual(sessionState.methods, ['POST'])
    assert.equal(sessionState.requestBody, 'buffered')
    const response = await sessionState.fetch(new Request('http://host/x', {
      method: 'POST',
      body: JSON.stringify({ sessionId: 's' }),
    }))
    assert.equal(response.headers.get('cache-control'), 'no-store')
  })
})

// ------------------------------------------------------------- 存储探测

describe('apply: 会话存储探测', () => {
  it('无 ctx.storage 时降级（默认禁用文件档 → 内存），且不静默假装是 storage', async () => {
    const { sessionStore } = mount(
      { [IMA_X_IMA_COOKIE_REF]: COOKIE, [IMA_X_IMA_BKN_REF]: BKN },
      { sessionStoreFile: false },
    )
    assert.equal(await sessionStore.ready(), 'memory')
    assert.equal(sessionStore.describe().scope, 'memory')
  })

  it('有 ctx.storage 时优先走 storage', async () => {
    const storage = {
      backend: {
        get: () => ({
          kv: {
            async open() {
              return {
                async loadAll() { return { tables: { sessions: {} }, global: null } },
                async putRecord() {},
                async deleteRecord() {},
                async close() {},
              }
            },
          },
        }),
      },
    }
    const { sessionStore } = mount(
      { [IMA_X_IMA_COOKIE_REF]: COOKIE, [IMA_X_IMA_BKN_REF]: BKN },
      { storage },
    )
    assert.equal(await sessionStore.ready(), 'storage')
  })

  it('createHostSessionStore 返回可观察句柄（getSelected/setSelected/describe）', () => {
    const ctx = { get: () => undefined }
    const store = createHostSessionStore(ctx, { sessionStoreFile: false })
    assert.equal(typeof store.getSelected, 'function')
    assert.equal(typeof store.setSelected, 'function')
    assert.equal(typeof store.describe, 'function')
  })

  it('apply 的返回值必须是 void（cordis 会把非函数返回值当非法 effect）', () => {
    const { routes, tools } = mount({ [IMA_X_IMA_COOKIE_REF]: COOKIE, [IMA_X_IMA_BKN_REF]: BKN })
    // 用同一套假宿主再跑一次，直接看返回值。
    const ctx = {
      effect: (callback) => callback(),
      inject: (_services, callback) => callback(ctx),
      get: (service) => {
        if (service === 'tools') return { register: () => () => {} }
        if (service === 'credentials') return fakeCredentials({})
        if (service === 'connection') return { fetch: { register: () => async () => {} } }
        return undefined
      },
    }
    assert.equal(apply(ctx, { sessionStoreFile: false }), undefined)
    assert.ok(routes.length > 0 && tools.length > 0)
  })
})

// ------------------------------------------------------------ 纯函数复用

describe('host: 作用域解析纯函数', () => {
  it('resolveSelected: 会话级优先、无记录回落全局、[] 不回退', async () => {
    const credentials = fakeCredentials({ [IMA_KNOWLEDGE_BASE_IDS_REF]: 'kb-global' })
    const store = createMemorySessionStore()
    await store.setSelected('a', ['kb-a'])
    await store.setSelected('c', [])

    const a = await __internals.resolveSelected(credentials, store, 'a')
    assert.deepEqual(a, { selected: ['kb-a'], inherited: false, scope: 'session', sessionId: 'a' })

    const b = await __internals.resolveSelected(credentials, store, 'b')
    assert.deepEqual(b, { selected: ['kb-global'], inherited: true, scope: 'session', sessionId: 'b' })

    const c = await __internals.resolveSelected(credentials, store, 'c')
    assert.deepEqual(c, { selected: [], inherited: false, scope: 'session', sessionId: 'c' })

    const global = await __internals.resolveSelected(credentials, store, undefined)
    assert.deepEqual(global, { selected: ['kb-global'], inherited: true, scope: 'global' })
  })

  it('sessionIdOf: 只认非空字符串的 exec.agent.id', () => {
    assert.equal(__internals.sessionIdOf({ agent: { id: 'sess-1' } }), 'sess-1')
    assert.equal(__internals.sessionIdOf({ agent: { id: '  sess-1  ' } }), 'sess-1')
    assert.equal(__internals.sessionIdOf({ agent: { id: '' } }), undefined)
    assert.equal(__internals.sessionIdOf({ agent: {} }), undefined)
    assert.equal(__internals.sessionIdOf({}), undefined)
    assert.equal(__internals.sessionIdOf(undefined), undefined)
    assert.equal(__internals.sessionIdOf(null), undefined)
  })

  it('readSelected 兼容老签名（无 store / 无 sessionId）', async () => {
    const credentials = fakeCredentials({ [IMA_KNOWLEDGE_BASE_IDS_REF]: 'kb-1, kb-2' })
    assert.deepEqual(await __internals.readSelected(credentials), ['kb-1', 'kb-2'])
  })
})

// --------------------------------------------------------------- /media 会话化（§9.6）

describe('media: 按会话取选中集（§9.6）', () => {
  it('同一请求体在不同 sessionId 下检索不同的库', async () => {
    const { apply } = await import('../lib/host.js')
    const { ROUTE_MEDIA } = await import('../lib/host.js')
    const { createMemorySessionStore } = await import('../lib/session-store.js')

    // 会话 A 选 kb-a，会话 B 选 kb-b。
    const sessionStore = createMemorySessionStore()
    await sessionStore.setSelected('sess-a', ['kb-a'])
    await sessionStore.setSelected('sess-b', ['kb-b'])

    /** 记录每次 search_knowledge 打到的 knowledge_base_id。 */
    const hitKbIds = []
    const fetchImpl = async (url, init) => {
      const body = JSON.parse(init.body)
      if (String(url).includes('search_knowledge_base')) {
        return new Response(JSON.stringify({
          code: 0, msg: 'ok', is_end: true, next_cursor: '',
          searched_knowledge_bases: [
            { id: 'kb-a', name: '库A', type: 1 },
            { id: 'kb-b', name: '库B', type: 1 },
          ],
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (String(url).includes('search_knowledge')) {
        hitKbIds.push(body.knowledge_base_id)
        return new Response(JSON.stringify({
          code: 0, msg: 'ok', is_end: true,
          info_list: [{ media_id: 'm-' + body.knowledge_base_id, title: 'T', highlight_content: 'H' }],
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({ code: 0, msg: 'ok' }), { status: 200 })
    }

    const routes = []
    const credentials = {
      async resolve() { return { value: 'x' } },
      async set() {},
      async unset() {},
      async describe() { return { configured: true, writable: true } },
    }
    const ctx = {
      effect: (cb) => cb(),
      inject: (_s, cb) => cb(ctx),
      get: (service) => {
        if (service === 'tools') return { register: () => () => {} }
        if (service === 'credentials') return credentials
        if (service === 'connection') {
          return { fetch: { register: (route) => { routes.push(route); return async () => {} } } }
        }
        return undefined
      },
    }
    apply(ctx, { fetchImpl, sessionStore })
    const mediaRoute = routes.find((route) => route.path === ROUTE_MEDIA)

    const ask = async (sessionId) => {
      const response = await mediaRoute.fetch(new Request('http://host/x', {
        method: 'POST',
        body: JSON.stringify({ query: '合同', sessionId }),
      }))
      return response.json()
    }

    hitKbIds.length = 0
    await ask('sess-a')
    assert.deepEqual(hitKbIds, ['kb-a'], '会话 A 只应检索 kb-a')

    hitKbIds.length = 0
    await ask('sess-b')
    assert.deepEqual(hitKbIds, ['kb-b'], '会话 B 只应检索 kb-b')
  })

  it('显式 kbIds 优先于会话选中集', async () => {
    const { apply, ROUTE_MEDIA } = await import('../lib/host.js')
    const { createMemorySessionStore } = await import('../lib/session-store.js')

    const sessionStore = createMemorySessionStore()
    await sessionStore.setSelected('sess-a', ['kb-a'])

    const hitKbIds = []
    const fetchImpl = async (url, init) => {
      const body = JSON.parse(init.body)
      if (String(url).includes('search_knowledge_base')) {
        return new Response(JSON.stringify({
          code: 0, msg: 'ok', is_end: true, next_cursor: '',
          searched_knowledge_bases: [{ id: 'kb-a', name: 'A', type: 1 }, { id: 'kb-z', name: 'Z', type: 1 }],
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (String(url).includes('search_knowledge')) {
        hitKbIds.push(body.knowledge_base_id)
        return new Response(JSON.stringify({ code: 0, msg: 'ok', is_end: true, info_list: [] }), { status: 200 })
      }
      return new Response(JSON.stringify({ code: 0 }), { status: 200 })
    }

    const routes = []
    const credentials = {
      async resolve() { return { value: 'x' } },
      async set() {}, async unset() {},
      async describe() { return { configured: true, writable: true } },
    }
    const ctx = {
      effect: (cb) => cb(),
      inject: (_s, cb) => cb(ctx),
      get: (service) => {
        if (service === 'tools') return { register: () => () => {} }
        if (service === 'credentials') return credentials
        if (service === 'connection') return { fetch: { register: (r) => { routes.push(r); return async () => {} } } }
        return undefined
      },
    }
    apply(ctx, { fetchImpl, sessionStore })
    const mediaRoute = routes.find((route) => route.path === ROUTE_MEDIA)

    await mediaRoute.fetch(new Request('http://host/x', {
      method: 'POST',
      body: JSON.stringify({ query: '合同', sessionId: 'sess-a', kbIds: ['kb-z'] }),
    }))
    assert.deepEqual(hitKbIds, ['kb-z'], '显式 kbIds 应覆盖会话选中集')
  })
})
