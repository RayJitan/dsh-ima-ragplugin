/**
 * 「选库之后优先用 search 自己检索」的回归单测。
 *
 * 防的缺陷（用户原话）：选中知识库后，模型更倾向于调 `ima_kb_ask` —— 让 IMA 侧
 * 模型先检索再总结一遍，DSh 拿到的是二手摘要，原文措辞、细节、数字与逐条出处
 * 都有损失。本文件锁死三层防线：
 *  1. 工具描述（选工具前）：search = 默认路径，ask = 有损兜底；
 *  2. 工具结果提示（拿到结果后）：继续 search，别转 ask；
 *  3. 系统提示词段（每一步都在）：按会话选中集三态注入策略。
 *
 * 断言纪律（沿用 api.test.js / session-scope.test.js 的惯例）：期望值独立复算，
 * 不 import 被测实现来算期望。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  PROMPT_SECTION_NAME,
  PROMPT_SECTION_ORDER,
  apply,
  buildRetrievalPolicyText,
  createSelectionCache,
  hydrateSelectionCache,
  installPromptSection,
  __internals,
} from '../lib/host.js'
import { createMemorySessionStore } from '../lib/session-store.js'

// --------------------------------------------------------------- 脚手架

/** 一个可用的 cookie / bkn 组合（与 session-scope.test.js 同形，独立复写免耦合）。 */
const COOKIE = 'PLATFORM=H5; IMA-UID=user-1; IMA-TOKEN=tok-abc; IMA-REFRESH-TOKEN=ref-xyz; IMA-GUID=guid-9'
const BKN = '193485963'

/**
 * 假 credentials（与 DSH CredentialProvider 签名一致）。
 * @param {Record<string,string>} [store] - 假存储。
 * @returns {object} 假服务。
 */
function fakeCredentials(store = {}) {
  return {
    async resolve(ref) {
      const value = store[ref]
      return value === undefined ? undefined : { value, source: 'file' }
    },
    async describe(ref) {
      return { configured: store[ref] !== undefined, writable: true }
    },
    async set(ref, value) {
      store[ref] = value
    },
    async unset(ref) {
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

/** 造一个 `exec`（DSH 工具执行上下文的最小子集：agent.id 即 SessionId）。 */
function execOf(sessionId) {
  return { signal: new AbortController().signal, agent: { id: sessionId } }
}

/**
 * 组装一套带 systemPrompt 的假宿主。
 * @param {object} [options] - `{sessionStore, initial, withSystemPrompt, fetchImpl}`。
 * @returns {object} 句柄。
 */
function mount(options = {}) {
  const tools = []
  const routes = []
  const sections = []
  // 路由/工具都要真凭据才走得到写库那一步，这里给一套可用的。
  const credentials = fakeCredentials({ IMA_X_IMA_COOKIE: COOKIE, IMA_X_IMA_BKN: BKN })
  const systemPrompt = {
    section(definition) {
      sections.push(definition)
      return () => {}
    },
  }
  const ctx = {
    effect: (callback) => callback(),
    inject: (_services, callback) => callback(ctx),
    get: (service) => {
      if (service === 'tools') return { register: (tool) => { tools.push(tool); return () => {} } }
      if (service === 'credentials') return credentials
      if (service === 'connection') {
        return { fetch: { register: (route) => { routes.push(route); return async () => {} } } }
      }
      if (service === 'systemPrompt') return options.withSystemPrompt === false ? undefined : systemPrompt
      return undefined
    },
  }
  const sessionStore = options.sessionStore ?? createMemorySessionStore(options.initial)
  apply(ctx, { fetchImpl: options.fetchImpl ?? listFetch(), sessionStore })

  const tool = (name) => tools.find((entry) => entry.name === name)
  const route = (path) => routes.find((entry) => entry.path === path)
  const post = async (path, body) => {
    const response = await route(path).fetch(new Request('http://host/x', {
      method: 'POST',
      body: JSON.stringify(body),
    }))
    return { status: response.status, payload: await response.json() }
  }
  /** 让 apply 里 fire-and-forget 的 hydrate 跑完。 */
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
  return { tools, routes, sections, credentials, sessionStore, tool, route, post, flush }
}

// ------------------------------------------------------- 第 1 层：工具描述

describe('工具描述：search 是默认路径，ask 是有损兜底', () => {
  const tools = __internals.createTools(fakeCredentials(), {})
  const search = tools.find((entry) => entry.name === 'ima_kb_search')
  const ask = tools.find((entry) => entry.name === 'ima_kb_ask')

  it('ima_kb_search 自报 PREFERRED / RAW，并点名替代 ima_kb_ask', () => {
    assert.match(search.description, /PREFERRED/u)
    assert.match(search.description, /RAW/u)
    assert.match(search.description, /instead of ima_kb_ask/u)
  })

  it('ima_kb_ask 自报 LOSSY，并明确「不要当检索替代品」', () => {
    assert.match(ask.description, /LOSSY/u)
    assert.match(ask.description, /Do NOT use it as a substitute for retrieval/u)
    // 只在两种情形使用：用户点名要 IMA 的答案 / search 多次无命中。
    assert.match(ask.description, /only when/u)
    assert.match(ask.description, /ima_kb_search/u)
  })

  it('ima_kb_ask 不再被描述成中立的「问一句就有答案」', () => {
    assert.doesNotMatch(ask.description, /^Ask a question against/u)
    assert.match(ask.description, /IMA-SIDE MODEL/u)
  })
})

// ------------------------------------------------------- 第 2 层：结果提示

describe('工具结果提示：拿到结果后把模型按回 search', () => {
  const tools = __internals.createTools(fakeCredentials(), {})
  const search = tools.find((entry) => entry.name === 'ima_kb_search')
  const ask = tools.find((entry) => entry.name === 'ima_kb_ask')

  it('search 结果 = 结构化 json + 「继续检索、不要改用 ask」', () => {
    const parts = search.output.render({ query: 'x' }, { items: [] })
    // 单个 text 部件（与宿主第一方工具同一写法），json 在前、提示在后。
    assert.equal(parts.length, 1)
    assert.equal(parts[0].type, 'text')
    const [json, ...rest] = parts[0].text.split('\n\n')
    assert.deepEqual(JSON.parse(json), { items: [] })
    const hint = rest.join('\n\n')
    assert.match(hint, /不要改用 ima_kb_ask/u)
    assert.match(hint, /原文片段/u)
  })

  it('ask 结果 = 结构化 json + 「有损二次总结，要原文请回 search」', () => {
    const parts = ask.output.render({ question: 'x' }, { answer: 'a', references: [] })
    assert.equal(parts.length, 1)
    const [json, ...rest] = parts[0].text.split('\n\n')
    assert.deepEqual(JSON.parse(json), { answer: 'a', references: [] })
    const hint = rest.join('\n\n')
    assert.match(hint, /二次总结/u)
    assert.match(hint, /ima_kb_search/u)
  })
})

// ------------------------------------------------------- 第 3 层：策略正文

describe('buildRetrievalPolicyText：与会话选中集三态一一对应', () => {
  it('[] = 用户明确不查库 → 整段不注入', () => {
    assert.equal(buildRetrievalPolicyText([]), '')
  })

  it('非空 → 确定语气 + 已选中数量', () => {
    const text = buildRetrievalPolicyText(['kb-1', 'kb-2'])
    assert.match(text, /已选中 2 个 IMA 知识库/u)
    assert.match(text, /ima_kb_search/u)
    assert.match(text, /不要用 `ima_kb_ask` 代替检索/u)
  })

  it('硬规则：不确定 / 学术 / 世界知识先检索，禁止猜测与编造', () => {
    for (const ids of [['kb-1'], undefined]) {
      const text = buildRetrievalPolicyText(ids)
      assert.match(text, /\*\*Search before you assert\.\*\*/u)
      assert.match(text, /uncertain facts, academic or technical knowledge/u)
      assert.match(text, /world knowledge/u)
      assert.match(text, /call `ima_kb_search` first/u)
      assert.match(text, /Never guess, assume, or fabricate/u)
      // 检索不到时要说清检索了什么、还缺什么，而不是悄悄编一个答案。
      assert.match(text, /say what you searched for and what is still unknown/u)
    }
  })

  it('undefined = 不知道选了什么 → 通用策略，且不谎称已选中', () => {
    const text = buildRetrievalPolicyText(undefined)
    assert.match(text, /ima_kb_list/u)
    assert.doesNotMatch(text, /已选中 \d+ 个/u)
    // 通用版仍然是「search 优先」的同一套策略。
    assert.match(text, /不要用 `ima_kb_ask` 代替检索/u)
  })

  it('策略里写明了 ask 的两个合法使用场景', () => {
    const text = buildRetrievalPolicyText(['kb-1'])
    assert.match(text, /用户明确要求/u)
    assert.match(text, /仍检索不到相关内容/u)
  })
})

// ------------------------------------------------------- 选中集镜像

describe('createSelectionCache：同步镜像', () => {
  it('set / get 往返，未知会话返回 undefined（与 [] 严格区分）', () => {
    const cache = createSelectionCache()
    assert.equal(cache.get('s1'), undefined)
    cache.set('s1', ['kb-1'])
    cache.set('s2', [])
    assert.deepEqual(cache.get('s1'), ['kb-1'])
    assert.deepEqual(cache.get('s2'), [])
    assert.equal(cache.size(), 2)
  })

  it('get 返回副本：改返回值不会污染镜像', () => {
    const cache = createSelectionCache()
    cache.set('s1', ['kb-1'])
    const got = cache.get('s1')
    got.push('kb-9')
    assert.deepEqual(cache.get('s1'), ['kb-1'])
  })

  it('非法 sessionId / 非法 ids 一律忽略，不写脏数据', () => {
    const cache = createSelectionCache()
    cache.set(undefined, ['kb-1'])
    cache.set('', ['kb-1'])
    cache.set('s1', 'not-an-array')
    assert.equal(cache.size(), 0)
    assert.equal(cache.get('s1'), undefined)
  })
})

describe('hydrateSelectionCache：重启后从存储回灌', () => {
  it('把已落盘的会话选中集灌进镜像（含「明确不选」的 []）', async () => {
    const store = createMemorySessionStore({ s1: ['kb-1'], s2: [] })
    const cache = createSelectionCache()
    assert.equal(await hydrateSelectionCache(store, cache), 2)
    assert.deepEqual(cache.get('s1'), ['kb-1'])
    assert.deepEqual(cache.get('s2'), [])
  })

  it('存储没有 listSessions 时安全返回 0', async () => {
    const cache = createSelectionCache()
    assert.equal(await hydrateSelectionCache({ getSelected: async () => [] }, cache), 0)
    assert.equal(await hydrateSelectionCache(undefined, cache), 0)
  })
})

// ------------------------------------------------------- 提示词段注册

describe('installPromptSection：能力可选，缺了不影响插件', () => {
  it('没有 systemPrompt 能力时返回 false，不抛', () => {
    assert.equal(installPromptSection({}, createSelectionCache()), false)
    assert.equal(installPromptSection({ get: () => undefined }, createSelectionCache()), false)
    assert.equal(installPromptSection({ get: () => ({ section: 'not-a-function' }) }, createSelectionCache()), false)
  })

  it('注册的段名 / 顺序 / 关插值符合约定', () => {
    const sections = []
    const systemPrompt = { section: (definition) => { sections.push(definition); return () => {} } }
    const ok = installPromptSection({}, createSelectionCache(), { systemPrompt })
    assert.equal(ok, true)
    assert.equal(sections.length, 1)
    assert.equal(sections[0].name, PROMPT_SECTION_NAME)
    assert.equal(sections[0].order, PROMPT_SECTION_ORDER)
    assert.equal(sections[0].interpolate, false)
    assert.equal(typeof sections[0].text, 'function')
  })

  it('text(context) 按 context.agent.id 取镜像：已选中 / 明确不选 / 未知 三态', () => {
    const sections = []
    const systemPrompt = { section: (definition) => { sections.push(definition); return () => {} } }
    const cache = createSelectionCache()
    cache.set('sess-on', ['kb-1'])
    cache.set('sess-off', [])
    installPromptSection({}, cache, { systemPrompt })
    const text = sections[0].text

    assert.match(text({ agent: { id: 'sess-on' } }), /已选中 1 个 IMA 知识库/u)
    assert.equal(text({ agent: { id: 'sess-off' } }), '')
    assert.match(text({ agent: { id: 'sess-unknown' } }), /ima_kb_list/u)
    // context 缺失也不能炸（宿主/测试都可能不给 agent）。
    assert.match(text(undefined), /ima_kb_list/u)
  })

  it('镜像读抛错时返回空串：宁可少一段，也不让整次组装失败', () => {
    const sections = []
    const systemPrompt = { section: (definition) => { sections.push(definition); return () => {} } }
    const broken = { get() { throw new Error('boom') } }
    installPromptSection({}, broken, { systemPrompt })
    assert.equal(sections[0].text({ agent: { id: 's' } }), '')
  })
})

// ------------------------------------------------------- apply 集成

describe('apply：把策略段真的接到宿主上', () => {
  it('宿主有 systemPrompt 时注册一段，且只有一段', () => {
    const { sections, tools } = mount()
    assert.equal(tools.length, 3)
    assert.equal(sections.length, 1)
    assert.equal(sections[0].name, PROMPT_SECTION_NAME)
  })

  it('宿主没有 systemPrompt 时三个工具照常注册，不注册段、不抛', () => {
    const { sections, tools } = mount({ withSystemPrompt: false })
    assert.equal(tools.length, 3)
    assert.equal(sections.length, 0)
  })

  it('/select 选完库后，下一次组装立刻变成「已选中 N 个」', async () => {
    const { sections, post } = mount()
    const text = sections[0].text

    // 选之前：未知 → 通用策略。
    assert.match(text({ agent: { id: 'sess-a' } }), /ima_kb_list/u)

    const selected = await post('/api/ima-knowledge/select', { ids: ['kb-1', 'kb-2'], sessionId: 'sess-a' })
    assert.equal(selected.status, 200)
    assert.equal(selected.payload.ok, true, JSON.stringify(selected.payload))
    assert.match(text({ agent: { id: 'sess-a' } }), /已选中 2 个 IMA 知识库/u)
    // 别的会话不受影响（会话隔离）。
    assert.match(text({ agent: { id: 'sess-b' } }), /ima_kb_list/u)
  })

  it('/select 清空后策略段退出（明确不选 = 不注入）', async () => {
    const { sections, post } = mount({ initial: { 'sess-a': ['kb-1'] } })
    const text = sections[0].text
    const cleared = await post('/api/ima-knowledge/select', { ids: [], sessionId: 'sess-a' })
    assert.equal(cleared.status, 200)
    assert.equal(cleared.payload.ok, true, JSON.stringify(cleared.payload))
    assert.equal(text({ agent: { id: 'sess-a' } }), '')
  })

  it('启动 hydrate：上次已落盘的选中集，这次没动选择器也能拿到确定语气', async () => {
    const { sections, flush } = mount({ initial: { 'sess-old': ['kb-1', 'kb-2'] } })
    await flush()
    assert.match(sections[0].text({ agent: { id: 'sess-old' } }), /已选中 2 个 IMA 知识库/u)
  })

  it('ima_kb_list 跑一次也会把镜像刷到最新事实', async () => {
    const store = createMemorySessionStore()
    const { tool, sections } = mount({ sessionStore: store })
    await store.setSelected('sess-a', ['kb-1'])
    // 镜像此时还没更新（存储改了但没人通知镜像）。
    assert.match(sections[0].text({ agent: { id: 'sess-a' } }), /ima_kb_list/u)
    await tool('ima_kb_list').execute({}, execOf('sess-a'))
    assert.match(sections[0].text({ agent: { id: 'sess-a' } }), /已选中 1 个 IMA 知识库/u)
  })
})
