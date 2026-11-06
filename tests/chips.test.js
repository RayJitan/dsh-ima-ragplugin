/**
 * 输入框上方知识库 chip 栏的纯逻辑单测（席位 client-kb-chips 拥有）。
 *
 * `lib/client/40-chips.js` 是**片段**（会被拼进 lib/client.js 的 factory 函数体），
 * 不是模块，所以这里用 `new Function(src + 'return {...}')()` 在独立作用域里求值，
 * 只取出那些不依赖 React / DOM / 闭包状态的纯函数来断言；组件用最小伪 React 跑首帧。
 *
 * 覆盖范围：
 *  - 列表推导：`selected` 有值但库列表找不到 → 不产生 chip（不显示裸 id）
 *  - 移除：移除中间一个 → 新选中集正确、顺序保持
 *  - 名称截断纯函数
 *  - 空选中集 → 渲染 null
 *  - 注册面（`conversation.input.overlay` / id / order）与 locale key 完整性
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { describe, it } from 'node:test'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const FRAGMENT = join(root, 'lib', 'client', '40-chips.js')
const CORE = join(root, 'lib', 'client', '10-core.js')

/** 片段里全部纯函数名（Node 侧可求值、无闭包依赖）。 */
const PURE = [
  'kbChipRecord',
  'kbChipBases',
  'kbChipSelectedIds',
  'kbChipItems',
  'kbChipRemove',
  'kbChipTruncate',
  'kbChipApplyResult',
  'kbChipShouldPoll',
  'kbChipPollDelay',
  'kbChipTranslate',
]

/**
 * 在独立作用域里求值片段，取回纯函数。
 * @returns {Promise<object>} 纯函数集合。
 */
async function loadPure() {
  const source = await readFile(FRAGMENT, 'utf8')
  // eslint-disable-next-line no-new-func
  const factory = new Function(`${source}\nreturn { ${PURE.join(', ')} };`)
  return factory()
}

/**
 * 从 10-core 取真实的数据面（不是桩）——key 拼错、样式字段缺失都能在测试里暴露。
 * @returns {Promise<object>} 10-core 的数据面 + 错误工具。
 */
async function loadCore() {
  const core = await readFile(CORE, 'utf8')
  // eslint-disable-next-line no-new-func
  return new Function(`${core}\nreturn { zh, en, S, fallbackTranslate, failureOf, failureText, errorText, HostFailure };`)()
}

/**
 * 最小 React 兼容层：只实现片段用到的钩子。
 * `useState` 返回 `[initial, noop]`——测试只关心**首帧**。
 * @returns {object} 伪 React。
 */
function makeFakeReact() {
  const createElement = (type, props, ...children) => ({
    $$element: true,
    type,
    props: Object.assign({}, props, children.length === 0 ? {} : { children: children.length === 1 ? children[0] : children }),
  })
  return {
    createElement,
    Fragment: Symbol.for('react.fragment'),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useMemo: (factory) => factory(),
    useCallback: (fn) => fn,
    useEffect: () => {},
    useLayoutEffect: () => {},
    useRef: (initial) => ({ current: initial }),
  }
}

/**
 * 载入片段并注入伪 React / 闭包依赖，返回可渲染的组件与注册函数。
 * @param {object} [overrides] - 覆盖项（postJson / t / pickerShared / runEffects 等）。
 * @returns {Promise<object>} 组件集合。
 */
async function loadComponents(overrides = {}) {
  const fragment = await readFile(FRAGMENT, 'utf8')
  const core = await loadCore()
  const React = makeFakeReact()
  // `runEffects: true` 时同步跑一次 useEffect（用于断言「模态关闭 → 重新拉取」）。
  if (overrides.runEffects === true) React.useEffect = (fn) => { React.__cleanup = fn() }
  const h = React.createElement
  const t = overrides.t || ((key, params) => core.fallbackTranslate(key, params))

  // eslint-disable-next-line no-new-func
  const factory = new Function(
    'React',
    'h',
    'ReactDOM',
    'S',
    't',
    'ROUTES',
    'postJson',
    'HostFailure',
    'failureOf',
    'failureText',
    'errorText',
    'isId',
    'normalizeBase',
    'fallbackTranslate',
    'pickerShared',
    'setTimeout',
    'clearTimeout',
    'window',
    'document',
    'console',
    `${fragment}\nreturn {
      KbChipIcon, KbChip, KbChipBar, registerKbChips,
      notifyKbSelectionChanged, KB_CHIP_LOCALE
    };`,
  )
  const loaded = factory(
    React,
    h,
    // portal 桩：无浏览器时把 portal 内容原样返回，断言仍能遍历到 chip 树。
    { createPortal: (node) => node },
    core.S,
    t,
    {
      list: 'api/ima-knowledge/list',
      select: 'api/ima-knowledge/select',
      status: 'api/ima-knowledge/status',
      credentials: 'api/ima-knowledge/credentials',
      media: 'api/ima-knowledge/media',
    },
    overrides.postJson || (async () => ({})),
    (kind, message, code) => Object.assign(new Error(message), { kind, code }),
    (cause) => ({ kind: 'unknown', detail: String(cause && cause.message ? cause.message : cause) }),
    (tr, failure) => failure.detail,
    (error) => (typeof error === 'string' ? error : undefined),
    (value) => typeof value === 'string' && value.trim() !== '',
    (entry) => entry,
    core.fallbackTranslate,
    // picker 席位缺失时也必须是 undefined（片段用 try/catch 兜）——
    // 这里默认给一个「永远打不开」的空总线，测试可按需覆盖。
    overrides.pickerShared,
    // 轮询定时器在 Node 里必须是无副作用的桩，否则进程被 3 s 定时器拖住不退出。
    () => 0,
    () => {},
    { dispatchEvent: () => true, addEventListener: () => {}, removeEventListener: () => {} },
    { addEventListener: () => {}, removeEventListener: () => {}, visibilityState: 'visible' },
    { warn: () => {}, error: () => {} },
  )
  loaded.__React = React
  return loaded
}

// ── 元素树工具 ────────────────────────────────────────────────────

/**
 * 递归展开任意节点（函数组件真的调用一次，抓渲染期错误）。
 * @param {unknown} node - 节点。
 * @param {number} depth - 递归深度。
 * @returns {unknown} 展开结果。
 */
function expandNode(node, depth = 0) {
  if (depth > 24) return node
  if (node === null || node === undefined) return node
  if (Array.isArray(node)) return node.map((child) => expandNode(child, depth))
  if (node.$$element !== true) return node
  if (typeof node.type === 'function') return expandNode(node.type(node.props), depth + 1)
  return expandNode(node.props.children, depth + 1)
}

/**
 * 按宿主标签名递归收集元素。
 * @param {unknown} node - 元素树。
 * @param {string} type - 宿主标签名。
 * @param {Array<object>} out - 累加器。
 * @returns {Array<object>} 命中元素。
 */
function findByType(node, type, out = []) {
  const walk = (current) => {
    if (current === null || current === undefined || typeof current === 'string') return
    if (Array.isArray(current)) {
      for (const child of current) walk(child)
      return
    }
    if (current.$$element !== true) return
    if (current.type === type) out.push(current)
    if (typeof current.type === 'function') walk(current.type(current.props))
    else walk(current.props.children)
  }
  walk(node)
  return out
}

/** `/list` 的真实形状（含一个 selected 里有、库列表里没有的「幽灵 id」）。 */
const LIST_VALUE = {
  knowledgeBases: [
    { id: 'kb-net-002', name: '计算机网络(持续更新中)', group: 'personal' },
    { id: 'kb-huawei-003', name: '华为网络知识', group: 'joined' },
    { id: 'kb-arch-004', name: '高级系统架构师备考', group: 'joined' },
    { id: 'kb-embed-005', name: '嵌入式系统资料' },
  ],
  selected: ['kb-net-002', 'kb-huawei-003', 'kb-arch-004', 'kb-ghost-999'],
  status: { configured: true, tokenValid: true },
}

// ══════════════════════════════════════════════════════════════════
// 列表推导
// ══════════════════════════════════════════════════════════════════

describe('chips: 列表推导', () => {
  it('只渲染 selected 里的库，且按 selected 的顺序', async () => {
    const { kbChipItems } = await loadPure()
    const items = kbChipItems(LIST_VALUE)
    assert.deepEqual(items.map((i) => i.id), ['kb-net-002', 'kb-huawei-003', 'kb-arch-004'])
    assert.equal(items[0].name, '计算机网络(持续更新中)')
  })

  it('selected 有值但库列表找不到 → 不产生 chip（绝不显示裸 id）', async () => {
    const { kbChipItems } = await loadPure()
    const items = kbChipItems(LIST_VALUE)
    assert.equal(items.some((i) => i.id === 'kb-ghost-999'), false)
    assert.equal(items.some((i) => i.name === 'kb-ghost-999'), false)
  })

  it('selected 全是不存在的 id → 空数组（整栏 null）', async () => {
    const { kbChipItems } = await loadPure()
    assert.deepEqual(kbChipItems({ knowledgeBases: [], selected: ['ghost'] }), [])
  })

  it('未选中任何库 → 空数组', async () => {
    const { kbChipItems } = await loadPure()
    assert.deepEqual(kbChipItems(Object.assign({}, LIST_VALUE, { selected: [] })), [])
    assert.deepEqual(kbChipItems({}), [])
    assert.deepEqual(kbChipItems(null), [])
  })

  it('selected 重复 id 只产生一个 chip；缺 name 时退化为 id（由 kbChipBases 兜）', async () => {
    const { kbChipItems } = await loadPure()
    const items = kbChipItems({
      knowledgeBases: [{ id: 'a' }],
      selected: ['a', 'a'],
    })
    assert.deepEqual(items, [{ id: 'a', name: 'a' }])
  })

  it('任何垃圾输入都不抛错', async () => {
    const { kbChipItems } = await loadPure()
    for (const bogus of [null, undefined, 0, 'x', [], {}, true]) {
      assert.doesNotThrow(() => kbChipItems(bogus))
    }
  })
})

// ══════════════════════════════════════════════════════════════════
// 移除
// ══════════════════════════════════════════════════════════════════

describe('chips: 移除后的新选中集', () => {
  it('移除中间一个 → 新选中集正确、顺序保持', async () => {
    const { kbChipRemove } = await loadPure()
    const before = ['kb-net-002', 'kb-huawei-003', 'kb-arch-004']
    assert.deepEqual(kbChipRemove(before, 'kb-huawei-003'), ['kb-net-002', 'kb-arch-004'])
    // 顺序：原顺序，不重排
    assert.deepEqual(kbChipRemove(before, 'kb-net-002'), ['kb-huawei-003', 'kb-arch-004'])
    assert.deepEqual(kbChipRemove(before, 'kb-arch-004'), ['kb-net-002', 'kb-huawei-003'])
  })

  it('移除最后一个 → 空数组（整栏 null）', async () => {
    const { kbChipRemove } = await loadPure()
    assert.deepEqual(kbChipRemove(['only'], 'only'), [])
  })

  it('移除不存在的 id → 等值副本（不改原数组）', async () => {
    const { kbChipRemove } = await loadPure()
    const before = ['a', 'b']
    const after = kbChipRemove(before, 'zzz')
    assert.deepEqual(after, ['a', 'b'])
    assert.notEqual(after, before)
    assert.deepEqual(before, ['a', 'b'])
  })

  it('顺带清理重复与空串（保持首次出现顺序）', async () => {
    const { kbChipRemove } = await loadPure()
    assert.deepEqual(kbChipRemove(['a', '', 'b', 'a', '  ', 'c'], 'b'), ['a', 'c'])
  })

  it('垃圾输入不抛错', async () => {
    const { kbChipRemove } = await loadPure()
    assert.deepEqual(kbChipRemove(null, 'a'), [])
    assert.deepEqual(kbChipRemove('nope', 'a'), [])
    assert.deepEqual(kbChipRemove(['a'], null), ['a'])
  })
})

// ══════════════════════════════════════════════════════════════════
// 名称截断
// ══════════════════════════════════════════════════════════════════

describe('chips: 名称截断', () => {
  it('短名原样返回（含中文）', async () => {
    const { kbChipTruncate } = await loadPure()
    assert.equal(kbChipTruncate('华为网络知识', 48), '华为网络知识')
  })

  it('超长名截断并加 …，且不切坏代理对', async () => {
    const { kbChipTruncate } = await loadPure()
    const long = '嵌入式Linux驱动开发详解与内核调试实战手册第二版补充材料'
    const cut = kbChipTruncate(long, 10)
    assert.equal(cut, '嵌入式Linux驱动…')
    assert.equal(Array.from(cut).length, 11) // 10 + 省略号
    const emoji = '🐼'.repeat(10)
    assert.equal(kbChipTruncate(emoji, 3), '🐼🐼🐼…')
  })

  it('去首尾空白并折叠内部空白', async () => {
    const { kbChipTruncate } = await loadPure()
    assert.equal(kbChipTruncate('  华为\n  网络知识  ', 48), '华为 网络知识')
  })

  it('max ≤ 0 / 非数字表示不截断', async () => {
    const { kbChipTruncate } = await loadPure()
    const long = 'x'.repeat(100)
    assert.equal(kbChipTruncate(long, 0), long)
    assert.equal(kbChipTruncate(long, -1), long)
    assert.equal(kbChipTruncate(long, NaN), long)
  })

  it('非字符串输入不抛错', async () => {
    const { kbChipTruncate } = await loadPure()
    assert.equal(kbChipTruncate(null, 10), '')
    assert.equal(kbChipTruncate(undefined, 10), '')
    assert.equal(kbChipTruncate(42, 10), '42')
  })
})

// ══════════════════════════════════════════════════════════════════
// /select 写回后的 value 合并
// ══════════════════════════════════════════════════════════════════

describe('chips: /select 返回合并', () => {
  it('宿主回了 selected → 用它，并保留 knowledgeBases', async () => {
    const { kbChipApplyResult } = await loadPure()
    const next = kbChipApplyResult(LIST_VALUE, ['kb-net-002'], { selected: ['kb-net-002'] })
    assert.deepEqual(next.selected, ['kb-net-002'])
    assert.equal(next.knowledgeBases.length, 4)
  })

  it('宿主没回 selected → 沿用乐观写入值（不会把刚移除的库变回来）', async () => {
    const { kbChipApplyResult } = await loadPure()
    const next = kbChipApplyResult(LIST_VALUE, ['kb-arch-004'], {})
    assert.deepEqual(next.selected, ['kb-arch-004'])
  })
})

// ══════════════════════════════════════════════════════════════════
// 轮询策略
// ══════════════════════════════════════════════════════════════════

describe('chips: 轮询策略（低频 + 可见才拉）', () => {
  it('页面隐藏时不轮询', async () => {
    const { kbChipShouldPoll } = await loadPure()
    assert.equal(kbChipShouldPoll('hidden'), false)
    assert.equal(kbChipShouldPoll('visible'), true)
    assert.equal(kbChipShouldPoll(undefined), true)
  })

  it('正常 3 s，连续失败退避到 30 s', async () => {
    const { kbChipPollDelay } = await loadPure()
    assert.equal(kbChipPollDelay(0), 3000)
    assert.equal(kbChipPollDelay(1), 30000)
    assert.equal(kbChipPollDelay(9), 30000)
    assert.equal(kbChipPollDelay(null), 3000)
  })
})

// ══════════════════════════════════════════════════════════════════
// 渲染
// ══════════════════════════════════════════════════════════════════

describe('chips: 渲染（伪 React，无浏览器）', () => {
  it('空选中集 → 渲染 null（不留空白占位）', async () => {
    const { KbChipBar } = await loadComponents({
      postJson: async () => ({ knowledgeBases: [], selected: [] }),
    })
    // 首帧是 loading（异步结果还没回来）→ 也是 null
    assert.equal(KbChipBar({ t: (k) => k }), null)
  })

  it('首帧 loading 时返回 null（不闪空白胶囊）', async () => {
    const { KbChipBar } = await loadComponents()
    assert.equal(KbChipBar({ t: (k) => k }), null)
  })

  it('图标是 SVG 而不是 emoji 字符（跨平台一致性）', async () => {
    const { KbChipIcon } = await loadComponents()
    const el = KbChipIcon()
    assert.equal(el.type, 'svg')
    assert.equal(el.props.width, 14)
    assert.equal(el.props.height, 14)
    const flat = JSON.stringify(el)
    assert.equal(flat.includes('🐼'), false)
  })

  it('单个 chip 有名称、title、aria-label 与 × 按钮', async () => {
    const { KbChip } = await loadComponents()
    const el = KbChip({ id: 'kb-1', name: '华为网络知识', t: (k) => k })
    const buttons = findByType(el, 'button')
    assert.equal(buttons.length, 1)
    assert.equal(buttons[0].props['data-ima-kb-chip-remove'], 'kb-1')
    // 伪 t 未命中（返回 key）→ 走内嵌兜底，绝不露出裸 key
    assert.equal(buttons[0].props['aria-label'], '移除知识库：华为网络知识')
    const spans = findByType(el, 'span')
    assert.ok(spans.some((s) => s.props.children === '华为网络知识'))
    assert.equal(el.props.title, '华为网络知识')
  })

  it('aria-label 里嵌的是截断后的库名（不把整段长名塞进去）', async () => {
    const { KbChip } = await loadComponents({
      t: (key, params) => (key === 'kb.remove' ? '移除知识库：' + String(params.name) : key),
    })
    const long = 'x'.repeat(120)
    const el = KbChip({ id: 'kb-2', name: long, t: (key, params) => (key === 'kb.remove' ? '移除知识库：' + String(params.name) : key) })
    const label = findByType(el, 'button')[0].props['aria-label']
    assert.ok(label.startsWith('移除知识库：'))
    assert.equal(Array.from(label.slice('移除知识库：'.length)).length, 49) // 48 + …
  })

  it('点击 × 调 onRemove 并阻止冒泡到输入框', async () => {
    const { KbChip } = await loadComponents()
    const seen = []
    const el = KbChip({ id: 'kb-3', name: 'n', t: (k) => k, onRemove: (id) => seen.push(id) })
    const button = findByType(el, 'button')[0]
    let prevented = false
    let stopped = false
    button.props.onClick({
      preventDefault: () => { prevented = true },
      stopPropagation: () => { stopped = true },
    })
    assert.deepEqual(seen, ['kb-3'])
    assert.equal(prevented, true)
    assert.equal(stopped, true)
  })
})

describe('chips: 刷新触发（模态关闭 → 立刻重拉）', () => {
  /**
   * 造一个可手动开合的最小 picker 总线（与 30-picker 的 `createPickerBus` 同形）。
   * @returns {object} 总线 + 控制函数。
   */
  function makeBus() {
    let state = { open: false, sessionId: undefined, toast: null }
    const listeners = new Set()
    const emit = () => { for (const fn of [...listeners]) fn() }
    return {
      getSnapshot: () => state,
      subscribe: (fn) => { listeners.add(fn); return () => { listeners.delete(fn) } },
      open: (sessionId) => {
        state = { open: true, sessionId: sessionId === undefined ? 'session-A' : sessionId, toast: null }
        emit()
      },
      close: () => { state = { open: false, sessionId: undefined, toast: null }; emit() },
      listenerCount: () => listeners.size,
    }
  }

  it('模态 open→close 时补拉一次 /list；卸载后取消订阅', async () => {
    const bus = makeBus()
    const calls = []
    const { KbChipBar, __React } = await loadComponents({
      runEffects: true,
      pickerShared: () => bus,
      postJson: async (path, body) => { calls.push({ path, body }); return { knowledgeBases: [], selected: [] } },
    })
    assert.equal(KbChipBar({ t: (k) => k, kbSessionId: 'session-A' }), null)
    // 挂载即拉一次（带本会话 id）
    assert.equal(calls.length, 1)
    assert.equal(calls[0].path, 'api/ima-knowledge/list')
    assert.deepEqual(calls[0].body, { sessionId: 'session-A' })
    assert.equal(bus.listenerCount(), 1)

    // 等首轮请求落地（inFlight 释放），否则关闭信号会走 pendingReload 路径。
    await new Promise((resolve) => setImmediate(resolve))

    bus.open('session-A')
    // 只是打开模态，不该重复拉
    assert.equal(calls.length, 1)

    bus.close()
    // 「确定」→ 关闭 → 立刻重拉（用户感知「选完就在了」）
    assert.equal(calls.length, 2)

    __React.__cleanup()
    assert.equal(bus.listenerCount(), 0)
  })

  it('首轮请求未落地时关闭模态 → 本轮结束后补拉（不丢刷新）', async () => {
    const bus = makeBus()
    const calls = []
    const { KbChipBar } = await loadComponents({
      runEffects: true,
      pickerShared: () => bus,
      postJson: async (path) => { calls.push(path); return { knowledgeBases: [], selected: [] } },
    })
    assert.equal(KbChipBar({ t: (k) => k, kbSessionId: 'session-A' }), null)
    assert.equal(calls.length, 1)
    // 请求还在飞：打开再关闭，关闭信号被记成 pendingReload
    bus.open('session-A')
    bus.close()
    assert.equal(calls.length, 1)
    await new Promise((resolve) => setImmediate(resolve))
    // 本轮结束后自动补拉
    assert.equal(calls.length, 2)
  })

  it('picker 席位缺失（pickerShared 为 undefined）也不抛错，仍有轮询兜底', async () => {
    const calls = []
    const { KbChipBar, __React } = await loadComponents({
      runEffects: true,
      pickerShared: undefined,
      postJson: async (path) => { calls.push(path); return { knowledgeBases: [], selected: [] } },
    })
    assert.doesNotThrow(() => KbChipBar({ t: (k) => k, kbSessionId: 'session-A' }))
    assert.equal(calls.length, 1)
    assert.doesNotThrow(() => __React.__cleanup())
  })
})

// ══════════════════════════════════════════════════════════════════
// 注册面 / locale
// ══════════════════════════════════════════════════════════════════

describe('chips: 注册到 conversation.input.overlay（输入框卡片内部）', () => {
  /**
   * 造一个只记录注册参数的假 ctx。
   * @returns {{ctx:object, calls:Array<object>}} 假 ctx 与注册记录。
   */
  function makeCtx() {
    const calls = []
    return {
      calls,
      ctx: {
        slots: {
          inject: (name, cb) => cb(),
          register: (opts, Comp) => { calls.push({ opts, Comp }); return () => {} },
        },
      },
    }
  }

  it('注册名 / 唯一 id / order 60 / 组件正确', async () => {
    const { registerKbChips, KbChipBar } = await loadComponents()
    const { ctx, calls } = makeCtx()
    registerKbChips(ctx, { t: (k) => k, NS: 'imaKnowledge' })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].opts.name, 'conversation.input.overlay')
    assert.equal(calls[0].opts.id, 'ima-kb-chips')
    assert.equal(calls[0].opts.order, 60)
    assert.equal(calls[0].Comp, KbChipBar)
  })

  it('注册在输入框卡片内部，不是卡片上方的 dock，也不是底部工具行（用户第三轮要求）', async () => {
    const { registerKbChips } = await loadComponents()
    const { ctx, calls } = makeCtx()
    registerKbChips(ctx, { t: (k) => k })
    assert.notEqual(calls[0].opts.name, 'conversation.input.dock')
    assert.notEqual(calls[0].opts.name, 'conversation.composer.dock')
    // 旧位置：卡片底部工具行（`+` 右边）——用户明确否掉「显示在界面右下角」
    assert.notEqual(calls[0].opts.name, 'conversation.input.left')
  })

  it('slots 不可用时不抛错（chip 是辅助展示区，不能影响输入）', async () => {
    const { registerKbChips } = await loadComponents()
    assert.doesNotThrow(() => registerKbChips({ slots: null }, { t: (k) => k }))
  })
})

describe('chips: locale key', () => {
  it('zh / en 键集一致且都非空', async () => {
    const { KB_CHIP_LOCALE } = await loadComponents()
    const zhKeys = Object.keys(KB_CHIP_LOCALE.zh).sort()
    const enKeys = Object.keys(KB_CHIP_LOCALE.en).sort()
    assert.deepEqual(enKeys, zhKeys)
    for (const key of zhKeys) {
      assert.equal(typeof KB_CHIP_LOCALE.zh[key], 'string')
      assert.notEqual(KB_CHIP_LOCALE.zh[key], '')
      assert.notEqual(KB_CHIP_LOCALE.en[key], '')
    }
  })

  it('内嵌兜底在字典未落盘时也不露裸 key', async () => {
    const { kbChipTranslate } = await loadPure()
    const t = (key) => key // 未命中：10-core fallbackTranslate 的同语义
    assert.equal(kbChipTranslate(t, 'kb.barLabel'), '已接入的知识库')
    assert.equal(kbChipTranslate(t, 'kb.remove', { name: 'A' }), '移除知识库：A')
    assert.equal(kbChipTranslate(t, 'kb.removeFailed', { msg: 'boom' }), '移除失败：boom')
  })
  it('字典已落盘时优先用注入的 t（切语言生效）', async () => {
    const { kbChipTranslate } = await loadPure()
    const t = (key) => (key === 'kb.barLabel' ? 'Attached knowledge bases' : key)
    assert.equal(kbChipTranslate(t, 'kb.barLabel'), 'Attached knowledge bases')
  })
})

// ══════════════════════════════════════════════════════════════════
// 会话级（PLATFORM §9.6）——本轮缺陷修复的核心用例
// ══════════════════════════════════════════════════════════════════

/**
 * 带状态的迷你 React：只实现 chip 栏用到的 `useState` / `useEffect` / `useCallback`，
 * 但**真的会跑 effect、真的会重渲染**——「切换会话后旧 chip 不残留」这条必须靠它验证
 * （静态首帧渲染证明不了 useEffect 依赖数组里有没有 sessionId）。
 *
 * `rerender(nextProps)` 换 props 后按 React 的语义比对依赖数组：
 * 依赖没变 → effect 不重跑；依赖变了 → 先 cleanup 再重跑。
 * @returns {object} `{React, h, mount}`。
 */
function makeSessionReact() {
  let slots = []
  let cursor = 0
  let queue = []
  let dirty = false
  const holder = { Component: null, props: null }

  const createElement = (type, props, ...children) => ({
    $$element: true,
    type,
    props: Object.assign({}, props, children.length === 0 ? {} : { children: children.length === 1 ? children[0] : children }),
  })

  const useState = (initial) => {
    const index = cursor
    cursor += 1
    if (slots[index] === undefined) {
      slots[index] = { kind: 'state', value: typeof initial === 'function' ? initial() : initial }
    }
    const slot = slots[index]
    const set = (next) => {
      const value = typeof next === 'function' ? next(slot.value) : next
      if (Object.is(value, slot.value)) return
      slot.value = value
      dirty = true
    }
    return [slot.value, set]
  }

  const sameDeps = (a, b) => Array.isArray(a) && Array.isArray(b)
    && a.length === b.length
    && a.every((item, index) => Object.is(item, b[index]))

  const useEffect = (effect, deps) => {
    const index = cursor
    cursor += 1
    const previous = slots[index]
    if (previous !== undefined && sameDeps(previous.deps, deps)) return
    slots[index] = { kind: 'effect', deps: deps, dispose: previous === undefined ? undefined : previous.dispose }
    queue.push({ index, effect })
  }

  const useMemo = (factory, deps) => {
    const index = cursor
    cursor += 1
    const previous = slots[index]
    if (previous !== undefined && sameDeps(previous.deps, deps)) return previous.value
    const value = factory()
    slots[index] = { kind: 'memo', deps, value }
    return value
  }

  const React = {
    createElement,
    Fragment: Symbol.for('react.fragment'),
    useState,
    useEffect,
    // 无 DOM 的迷你运行时里 layout effect 与 effect 同语义（同步排进队列）。
    useLayoutEffect: useEffect,
    useMemo,
    useCallback: (fn, deps) => useMemo(() => fn, deps),
    useRef: (initial) => {
      const index = cursor
      cursor += 1
      if (slots[index] === undefined) slots[index] = { kind: 'ref', value: { current: initial } }
      return slots[index].value
    },
  }

  /**
   * 挂载组件并跑到稳定态（副作用执行 + 异步 setState 回填）。
   * @param {Function} Component - 组件函数。
   * @param {object} props - 初始 props。
   * @returns {Promise<object>} `{tree, text, rerender, dispose}`。
   */
  async function mount(Component, props) {
    holder.Component = Component
    holder.props = props
    let tree
    const render = () => {
      cursor = 0
      queue = []
      dirty = false
      return Component(holder.props)
    }
    const flush = () => {
      const pending = queue
      queue = []
      for (const entry of pending) {
        const slot = slots[entry.index]
        if (slot !== undefined && typeof slot.dispose === 'function') slot.dispose()
        const dispose = entry.effect()
        if (slot !== undefined) slot.dispose = typeof dispose === 'function' ? dispose : undefined
      }
      if (dirty) {
        tree = render()
        return true
      }
      return false
    }
    /** 跑到没有待执行副作用、没有 dirty、也没有新排队 effect。 */
    const settle = async () => {
      for (let round = 0; round < 40; round += 1) {
        const rendered = flush()
        if (!rendered && queue.length === 0) {
          await new Promise((resolve) => { setImmediate(resolve) })
          if (queue.length === 0 && dirty === false) break
        } else {
          await Promise.resolve()
        }
      }
    }
    tree = render()
    await settle()
    return {
      get tree() { return tree; },
      text: () => [...collectStrings(tree)].join(' | '),
      /** 换 props 重渲染（模拟「切到另一个会话」：同一实例、新 sessionId）。 */
      rerender: async (nextProps) => {
        holder.props = nextProps
        tree = render()
        await settle()
        return tree
      },
      dispose: () => {
        for (const slot of slots) {
          if (slot !== undefined && typeof slot.dispose === 'function') slot.dispose()
        }
        slots = []
      },
    }
  }

  return { React, h: createElement, mount }
}

/**
 * 递归收集元素树里的全部字符串（断言渲染结果用）。
 * @param {unknown} node - 元素树。
 * @param {string[]} out - 累加器。
 * @returns {string[]} 文本片段。
 */
function collectStrings(node, out = []) {
  if (node === null || node === undefined) return out
  if (typeof node === 'string') { out.push(node); return out }
  if (typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) {
    for (const child of node) collectStrings(child, out)
    return out
  }
  if (node.$$element !== true) return out
  if (typeof node.type === 'function') return collectStrings(node.type(node.props), out)
  return collectStrings(node.props.children, out)
}

/**
 * 用「带状态运行时」重新求值片段，返回可真正跑副作用的组件。
 * @param {object} [overrides] - `{postJson, pickerShared}`。
 * @returns {Promise<object>} 组件与观测面。
 */
async function loadSessionComponents(overrides = {}) {
  const fragment = await readFile(FRAGMENT, 'utf8')
  const core = await loadCore()
  const live = makeSessionReact()
  const listeners = { window: new Map(), document: new Map() }
  /** 所有被派发出去的事件（断言事件协议用）。 */
  const events = []
  const makeTarget = (bag) => ({
    addEventListener: (name, fn) => {
      const set = bag.get(name) || new Set()
      set.add(fn)
      bag.set(name, set)
    },
    removeEventListener: (name, fn) => {
      const set = bag.get(name)
      if (set !== undefined) set.delete(fn)
    },
    dispatchEvent: (event) => {
      events.push(event)
      const set = bag.get(event.type)
      if (set !== undefined) for (const fn of [...set]) fn(event)
      return true
    },
  })
  const windowStub = makeTarget(listeners.window)
  const documentStub = Object.assign(makeTarget(listeners.document), { visibilityState: 'visible' })
  const warns = []
  const consoleStub = { warn: (...args) => warns.push(args), error: () => {} }
  class CustomEventStub {
    constructor(type, init) {
      this.type = type
      this.detail = init === undefined ? undefined : init.detail
    }
  }

  // eslint-disable-next-line no-new-func
  const factory = new Function(
    'React', 'h', 'ReactDOM', 'S', 't', 'ROUTES', 'postJson', 'HostFailure', 'failureOf',
    'failureText', 'errorText', 'isId', 'normalizeBase', 'fallbackTranslate',
    'pickerShared', 'setTimeout', 'clearTimeout', 'window', 'document', 'console', 'CustomEvent',
    `${fragment}\nreturn {
      KbChipBar, registerKbChips, notifyKbSelectionChanged, kbChipItems,
      kbChipEventMatches, kbChipSessionId
    };`,
  )
  const loaded = factory(
    live.React,
    live.h,
    { createPortal: (node) => node },
    core.S,
    (key, params) => core.fallbackTranslate(key, params),
    {
      list: 'api/ima-knowledge/list',
      select: 'api/ima-knowledge/select',
      status: 'api/ima-knowledge/status',
      credentials: 'api/ima-knowledge/credentials',
      media: 'api/ima-knowledge/media',
    },
    overrides.postJson || (async () => ({ knowledgeBases: [], selected: [] })),
    (kind, message, code) => Object.assign(new Error(message), { kind, code }),
    (cause) => ({ kind: 'unknown', detail: String(cause && cause.message ? cause.message : cause) }),
    (tr, failure) => failure.detail,
    (error) => (typeof error === 'string' ? error : undefined),
    (value) => typeof value === 'string' && value.trim() !== '',
    (entry) => entry,
    core.fallbackTranslate,
    overrides.pickerShared,
    () => 0,
    () => {},
    windowStub,
    documentStub,
    consoleStub,
    CustomEventStub,
  )
  return Object.assign({ mount: live.mount, warns, listeners, events }, loaded)
}

describe('chips: 按会话取数（PLATFORM §9.6）', () => {
  it('注册时 inject 收到 sessionId 并注入成 kbSessionId（会话作用域槽）', async () => {
    const { registerKbChips } = await loadSessionComponents()
    const calls = []
    const ctx = {
      slots: {
        inject: (name, cb) => cb(),
        register: (opts, Comp) => { calls.push({ opts, Comp }); return () => {} },
      },
    }
    registerKbChips(ctx, { t: (k) => k, NS: 'imaKnowledge' })
    assert.equal(calls.length, 1)
    // 注册面：卡片内部 overlay 槽（第三轮改位置），id/order 固定
    assert.equal(calls[0].opts.name, 'conversation.input.overlay')
    assert.equal(calls[0].opts.id, 'ima-kb-chips')
    assert.equal(calls[0].opts.order, 60)
    // inject 是函数，且必须把框架给的 sessionId 带到 props 上
    assert.equal(typeof calls[0].opts.inject, 'function')
    const injected = calls[0].opts.inject('session-1')
    assert.equal(injected.kbSessionId, 'session-1')
    assert.equal(typeof injected.kbT, 'function')
    assert.equal(calls[0].opts.inject(undefined).kbSessionId, undefined)
  })

  it('POST /list 带 {sessionId}，不是空 body', async () => {
    const calls = []
    const { KbChipBar, mount } = await loadSessionComponents({
      postJson: async (path, body) => {
        calls.push({ path, body })
        return { knowledgeBases: [{ id: 'kb-a', name: 'A' }], selected: ['kb-a'] }
      },
    })
    const view = await mount(KbChipBar, { t: (k) => k, kbSessionId: 'session-1' })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].path, 'api/ima-knowledge/list')
    assert.deepEqual(calls[0].body, { sessionId: 'session-1' })
    assert.match(view.text(), /A/u)
    view.dispose()
  })

  it('【核心缺陷】切换会话后旧 chip 不残留：清空旧数据 + 用新 sessionId 重拉', async () => {
    const calls = []
    const bySession = {
      'session-1': { knowledgeBases: [{ id: 'kb-a', name: '会话1的库A' }], selected: ['kb-a'] },
      'session-2': { knowledgeBases: [{ id: 'kb-c', name: '会话2的库C' }], selected: ['kb-c'] },
    }
    const { KbChipBar, mount } = await loadSessionComponents({
      postJson: async (path, body) => {
        calls.push({ path, body })
        return bySession[body.sessionId] || { knowledgeBases: [], selected: [] }
      },
    })
    const view = await mount(KbChipBar, { t: (k) => k, kbSessionId: 'session-1' })
    assert.match(view.text(), /会话1的库A/u, '会话1 应显示自己的库')
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0].body, { sessionId: 'session-1' })

    // 切到会话2（同一实例、新 sessionId）
    await view.rerender({ t: (k) => k, kbSessionId: 'session-2' })

    // 必须用新会话重新拉取
    assert.equal(calls.length, 2, '换会话必须重新拉取')
    assert.deepEqual(calls[1].body, { sessionId: 'session-2' })

    const text = view.text()
    assert.match(text, /会话2的库C/u, '会话2 应显示自己的库')
    assert.equal(/会话1的库A/u.test(text), false, '旧会话的 chip 必须消失（本缺陷的核心）')
    view.dispose()
  })

  it('切到「什么都没选」的会话 → chip 栏渲染 null（合法空态）', async () => {
    const bySession = {
      'session-1': { knowledgeBases: [{ id: 'kb-a', name: 'A' }], selected: ['kb-a'] },
      'session-3': { knowledgeBases: [{ id: 'kb-a', name: 'A' }], selected: [] },
    }
    const { KbChipBar, mount } = await loadSessionComponents({
      postJson: async (path, body) => bySession[body.sessionId],
    })
    const view = await mount(KbChipBar, { t: (k) => k, kbSessionId: 'session-1' })
    assert.match(view.text(), /A/u)
    await view.rerender({ t: (k) => k, kbSessionId: 'session-3' })
    assert.equal(view.tree, null, '会话空选中集 → 整栏不渲染')
    view.dispose()
  })

  it('会话空选中集 → 渲染 null（不留空白占位）', async () => {
    const { KbChipBar, mount } = await loadSessionComponents({
      postJson: async () => ({ knowledgeBases: [{ id: 'kb-a', name: 'A' }], selected: [] }),
    })
    const view = await mount(KbChipBar, { t: (k) => k, kbSessionId: 'session-x' })
    assert.equal(view.tree, null)
    view.dispose()
  })

  it('拿不到 sessionId → 不渲染，也不回退全局（并 console.warn 留痕）', async () => {
    const calls = []
    const { KbChipBar, mount, warns } = await loadSessionComponents({
      postJson: async (path, body) => {
        calls.push({ path, body })
        return { knowledgeBases: [{ id: 'kb-a', name: 'A' }], selected: ['kb-a'] }
      },
    })
    const view = await mount(KbChipBar, { t: (k) => k })
    assert.equal(view.tree, null, '没有会话身份时宁可不显示，也不能显示错会话的库')
    assert.equal(calls.length, 0, '不该发一次不带 sessionId 的 /list（那就是全局回退）')
    assert.ok(warns.length > 0, '失败必须留痕，不能静默')
    view.dispose()
  })
})

describe('chips: 事件过滤（只响应本会话）', () => {
  it('kbChipEventMatches：同会话刷新，异会话 / 无会话不刷新', async () => {
    const { kbChipEventMatches } = await loadSessionComponents()
    assert.equal(kbChipEventMatches({ sessionId: 's1', selected: ['a'] }, 's1'), true)
    assert.equal(kbChipEventMatches({ sessionId: 's2', selected: ['a'] }, 's1'), false, '别的会话的选择与我无关')
    assert.equal(kbChipEventMatches({ sessionId: null, selected: ['a'] }, 's1'), false, '侧边栏写全局默认值 → 不响应')
    assert.equal(kbChipEventMatches({ selected: ['a'] }, 's1'), false, '旧协议（无 sessionId）→ 不响应')
    assert.equal(kbChipEventMatches(undefined, 's1'), false)
    assert.equal(kbChipEventMatches({ sessionId: 's1' }, undefined), false)
  })

  it('sessionId 不匹配的事件不触发刷新', async () => {
    const calls = []
    const { KbChipBar, mount, notifyKbSelectionChanged } = await loadSessionComponents({
      postJson: async (path, body) => {
        calls.push({ path, body })
        return { knowledgeBases: [{ id: 'kb-a', name: 'A' }], selected: ['kb-a'] }
      },
    })
    const view = await mount(KbChipBar, { t: (k) => k, kbSessionId: 'session-1' })
    assert.equal(calls.length, 1)

    // 别的会话的事件 → 不刷新
    notifyKbSelectionChanged('session-2', ['kb-z'])
    await new Promise((resolve) => { setImmediate(resolve) })
    assert.equal(calls.length, 1, '别的会话的事件不该触发本会话刷新')

    // 侧边栏的全局默认值事件（sessionId:null）→ 不刷新
    notifyKbSelectionChanged(null, ['kb-z'])
    await new Promise((resolve) => { setImmediate(resolve) })
    assert.equal(calls.length, 1, '全局默认值变更不该刷新会话 chip')

    // 本会话的事件 → 刷新
    notifyKbSelectionChanged('session-1', ['kb-a'])
    await new Promise((resolve) => { setImmediate(resolve) })
    assert.equal(calls.length, 2, '本会话的事件必须刷新')
    assert.deepEqual(calls[1].body, { sessionId: 'session-1' })
    view.dispose()
  })

  it('notifyKbSelectionChanged 派发的事件 detail 形状是 {sessionId, selected}', async () => {
    const { notifyKbSelectionChanged, events } = await loadSessionComponents()
    notifyKbSelectionChanged('session-9', ['kb-1', 'kb-2'])
    assert.equal(events.length, 1)
    assert.equal(events[0].type, 'ima-kb-selection-changed')
    assert.deepEqual(events[0].detail, { sessionId: 'session-9', selected: ['kb-1', 'kb-2'] })
    // 侧边栏语义：全局默认值 → sessionId 归一化为 null（chip 栏据此不响应）
    notifyKbSelectionChanged(null, [])
    assert.deepEqual(events[1].detail, { sessionId: null, selected: [] })
  })
})

describe('chips: 列表推导的会话参数', () => {
  it('kbChipItems(value, sessionId) 接受会话参数；数据不属于该会话 → 空数组', async () => {
    const { kbChipItems } = await loadSessionComponents()
    const mine = { sessionId: 's1', knowledgeBases: [{ id: 'kb-a', name: 'A' }], selected: ['kb-a'] }
    const theirs = { sessionId: 's2', knowledgeBases: [{ id: 'kb-b', name: 'B' }], selected: ['kb-b'] }
    assert.deepEqual(kbChipItems(mine, 's1').map((i) => i.id), ['kb-a'])
    assert.deepEqual(kbChipItems(theirs, 's1'), [], '别的会话的数据绝不渲染')
    // 数据不带 sessionId（旧宿主 / 兼容分支）→ 不做防串台校验，照常推导
    assert.deepEqual(
      kbChipItems({ knowledgeBases: [{ id: 'kb-a', name: 'A' }], selected: ['kb-a'] }, 's1').map((i) => i.id),
      ['kb-a'],
    )
    // 调用方没给 sessionId → 行为与旧签名一致
    assert.deepEqual(kbChipItems(mine).map((i) => i.id), ['kb-a'])
  })

  it('kbChipSessionId 只认非空字符串', async () => {
    const { kbChipSessionId } = await loadSessionComponents()
    assert.equal(kbChipSessionId({ sessionId: 's1' }), 's1')
    assert.equal(kbChipSessionId({ sessionId: '  s1  ' }), 's1')
    assert.equal(kbChipSessionId({ sessionId: '' }), undefined)
    assert.equal(kbChipSessionId({ sessionId: null }), undefined)
    assert.equal(kbChipSessionId({}), undefined)
    assert.equal(kbChipSessionId(null), undefined)
  })
})
