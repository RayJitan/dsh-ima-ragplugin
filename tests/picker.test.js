/**
 * 「+」菜单入口与知识库多选模态的纯逻辑 + 渲染冒烟单测（席位 client-picker 拥有）。
 *
 * `lib/client/30-picker.js` 是**片段**（会被拼进 lib/client.js 的 factory 函数体），
 * 不是模块，所以这里用 `new Function(src + 'return {...}')()` 在独立作用域里求值，
 * 只取出那些不依赖 React / DOM 的纯函数来断言；组件则用最小伪 React 真跑一遍。
 *
 * 覆盖范围（UI 无法在 Node 真渲染，故只到「渲染期不抛错 + 文案/结构对」为止）：
 *  - 数据整形：`/list` 的 value → 列表 / 已选 / configured / statusError
 *  - 筛选、勾选、并集、脏检查
 *  - 分组启发式（宿主无分组字段时的默认行为 + 宿主给字段时的原样透传）
 *  - 三态（loading / error / unconfigured）+ 两种空态
 *  - 总线（菜单 → 模态）与「确定」可点判据
 *  - 注册面（overlay + commandUi）与 locale key 完整性
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { describe, it } from 'node:test'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const FRAGMENT = join(root, 'lib', 'client', '30-picker.js')
const CORE = join(root, 'lib', 'client', '10-core.js')

/** 片段里全部纯函数名（Node 侧可求值、无闭包依赖）。 */
const PURE = [
  'pkRecord',
  'pkBases',
  'pkSelectedIds',
  'pkDraftFrom',
  'pkFilterBases',
  'pkToggleId',
  'pkMergeSelected',
  'pkDirty',
  'pkGroups',
  'pkViewState',
  'pkCanConfirm',
  'createPickerBus',
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
 * 从 10-core 取真实的数据面（不是桩）——key 拼错、样式字段缺失、
 * 错误文案格式漂移都能在测试里暴露。
 * @returns {Promise<object>} 10-core 的数据面 + 错误工具。
 */
async function loadCore() {
  const core = await readFile(CORE, 'utf8')
  // eslint-disable-next-line no-new-func
  return new Function(`${core}\nreturn { zh, en, S, fallbackTranslate, failureOf, failureText, errorText, HostFailure };`)()
}

/**
 * 最小 React 兼容层：只实现片段用到的钩子。
 *
 * `useState` 返回 `[initial, noop]`——测试只关心**首帧**，异步 setState 之后
 * 的分支由纯函数单测覆盖。
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
    useRef: (initial) => ({ current: initial }),
  }
}

/**
 * 载入片段并注入伪 React / 闭包依赖，返回可渲染的组件与注册函数。
 * @param {object} [overrides] - 覆盖项（postJson / t / commandUi 等）。
 * @returns {Promise<object>} 组件集合。
 */
async function loadComponents(overrides = {}) {
  const fragment = await readFile(FRAGMENT, 'utf8')
  const core = await loadCore()
  const React = makeFakeReact()
  const h = React.createElement
  const t = overrides.t || ((key, params) => core.fallbackTranslate(key, params))

  // eslint-disable-next-line no-new-func
  const factory = new Function(
    'React',
    'h',
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
    `${fragment}\nreturn {
      PickerMenuIcon, PickerFolderIcon, PickerRow, PickerGroup, PickerBody,
      PickerToolbar, PickerFooter, PickerModal, PickerToast, PickerOverlay,
      registerPicker, pickerShared
    };`,
  )
  return factory(
    React,
    h,
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
  )
}

// ── 元素树工具 ────────────────────────────────────────────────────

/**
 * 展开一个元素：函数组件**真的调用一次**，从而抓到子组件里的渲染期错误。
 * @param {object} element - `$$element` 标记的元素。
 * @param {number} depth - 递归深度。
 * @returns {unknown} 展开后的 children。
 */
function expand(element, depth = 0) {
  if (depth > 24) return ''
  if (typeof element.type === 'function') return expandNode(element.type(element.props), depth + 1)
  return expandNode(element.props.children, depth + 1)
}

/**
 * 递归展开任意节点。
 * @param {unknown} node - 节点。
 * @param {number} depth - 深度。
 * @returns {unknown} 展开结果。
 */
function expandNode(node, depth) {
  if (node === null || node === undefined) return node
  if (Array.isArray(node)) return node.map((child) => expandNode(child, depth))
  if (node.$$element === true) return expand(node, depth)
  return node
}

/**
 * 把函数组件元素解析到宿主元素（type 为字符串）为止。
 * @param {object} element - 元素。
 * @param {number} [depth] - 深度。
 * @returns {object|undefined} 宿主元素。
 */
function renderRoot(element, depth = 0) {
  if (depth > 24 || element === null || element === undefined || element.$$element !== true) return undefined
  if (typeof element.type === 'string') return element
  return renderRoot(element.type(element.props), depth + 1)
}

/**
 * 递归收集元素树里出现的全部字符串（含 props 里的 title / aria-label）。
 * @param {unknown} node - 元素树。
 * @param {Set<string>} out - 累加器。
 * @returns {Set<string>} 文本集合。
 */
function collectStrings(node, out = new Set()) {
  const walk = (current) => {
    if (current === null || current === undefined) return
    if (typeof current === 'string' || typeof current === 'number') {
      out.add(String(current))
      return
    }
    if (Array.isArray(current)) {
      for (const child of current) walk(child)
      return
    }
    if (current.$$element === true) {
      for (const value of Object.values(current.props)) {
        if (typeof value === 'string') out.add(value)
      }
      walk(expand(current))
    }
  }
  walk(node)
  return out
}

/**
 * 按宿主元素类型递归收集元素（用于数行数、找按钮）。
 * @param {unknown} node - 元素树。
 * @param {string} type - 宿主标签名。
 * @param {Array<object>} out - 累加器。
 * @returns {Array<object>} 命中元素。
 */
function findByType(node, type, out = []) {
  const walk = (current) => {
    if (current === null || current === undefined) return
    if (Array.isArray(current)) {
      for (const child of current) walk(child)
      return
    }
    if (current.$$element !== true) return
    if (current.type === type) {
      out.push(current)
      walk(current.props.children)
      return
    }
    if (typeof current.type === 'function') {
      walk(current.type(current.props))
      return
    }
    walk(current.props.children)
  }
  walk(node)
  return out
}

/**
 * 只取复选框（列表行里的 `input[type=checkbox]`）。
 *
 * 搜索框也是 `<input>`，所以按 type 过滤，避免把搜索框当成第一行。
 * @param {unknown} node - 元素树。
 * @returns {Array<object>} 复选框元素。
 */
function findCheckboxes(node) {
  return findByType(node, 'input').filter((input) => input.props.type === 'checkbox')
}

// ══════════════════════════════════════════════════════════════════
// 数据整形
// ══════════════════════════════════════════════════════════════════

describe('picker: /list 的 value → 列表 / 已选 / 配置态', () => {
  it('规范化列表：剔除无 id、按 id 去重、name 缺失回落 id', async () => {
    const { pkBases } = await loadPure()
    const bases = pkBases({
      knowledgeBases: [
        { id: 'kb-1', name: '产品文档' },
        { id: 'kb-1', name: '重复项应被丢掉' },
        { id: 'kb-2' },
        { name: '没有 id 应被丢掉' },
        { id: '   ', name: '空白 id 应被丢掉' },
        null,
      ],
    })
    assert.deepEqual(bases, [
      { id: 'kb-1', name: '产品文档' },
      { id: 'kb-2', name: 'kb-2' },
    ])
  })

  it('宿主若给出 group 字段则原样带下去（本层不解释语义）', async () => {
    const { pkBases } = await loadPure()
    assert.deepEqual(pkBases({ knowledgeBases: [{ id: 'a', name: 'A', group: '我加入的' }] }), [
      { id: 'a', name: 'A', group: '我加入的' },
    ])
  })

  it('任何垃圾输入都不抛错且返回空数组', async () => {
    const { pkBases } = await loadPure()
    for (const bogus of [null, undefined, 0, 'x', {}, [], { knowledgeBases: 'nope' }]) {
      assert.doesNotThrow(() => pkBases(bogus))
      assert.deepEqual(pkBases(bogus), [])
    }
  })

  it('裸数组也接受（mock / 未来签名）', async () => {
    const { pkBases } = await loadPure()
    assert.deepEqual(pkBases([{ id: 'a', name: 'A' }]), [{ id: 'a', name: 'A' }])
  })

  it('已选 id：去重保序、剔除空串', async () => {
    const { pkSelectedIds } = await loadPure()
    assert.deepEqual(pkSelectedIds({ selected: ['b', 'a', 'b', '', '  ', 7, 'c'] }), ['b', 'a', 'c'])
    assert.deepEqual(pkSelectedIds(null), [])
  })

  it('一次拆出四个面；configured 只在明确 false 时为假（不把缺字段误报成未登录）', async () => {
    const { pkDraftFrom } = await loadPure()
    const full = pkDraftFrom({
      knowledgeBases: [{ id: 'a', name: 'A' }],
      selected: ['a'],
      status: { configured: true, tokenValid: true },
    })
    assert.deepEqual(full.bases, [{ id: 'a', name: 'A' }])
    assert.deepEqual(full.selected, ['a'])
    assert.equal(full.configured, true)
    assert.equal(full.tokenValid, true)
    assert.equal(full.statusError, undefined)

    const missing = pkDraftFrom({ knowledgeBases: [] })
    assert.equal(missing.configured, true, 'status 缺失时不得当成未配置')

    const off = pkDraftFrom({ status: { configured: false, error: '  未登录  ' } })
    assert.equal(off.configured, false)
    assert.equal(off.statusError, '未登录')
  })
})

// ══════════════════════════════════════════════════════════════════
// 筛选 / 勾选 / 脏检查
// ══════════════════════════════════════════════════════════════════

describe('picker: 搜索过滤', () => {
  const BASES = [
    { id: 'kb-100', name: '产品需求文档' },
    { id: 'kb-200', name: 'Engineering Wiki' },
    { id: 'kb-300', name: '设计规范' },
  ]

  it('按名称 / ID 大小写无关匹配', async () => {
    const { pkFilterBases } = await loadPure()
    assert.deepEqual(pkFilterBases(BASES, 'wiki').map((item) => item.id), ['kb-200'])
    assert.deepEqual(pkFilterBases(BASES, 'KB-300').map((item) => item.id), ['kb-300'])
    assert.deepEqual(pkFilterBases(BASES, '产品').map((item) => item.id), ['kb-100'])
  })

  it('空白搜索词返回全部（且是新数组，调用方改它不影响原列表）', async () => {
    const { pkFilterBases } = await loadPure()
    const all = pkFilterBases(BASES, '   ')
    assert.equal(all.length, 3)
    assert.notEqual(all, BASES)
    all.pop()
    assert.equal(BASES.length, 3)
  })

  it('无匹配返回空数组；垃圾输入不抛错', async () => {
    const { pkFilterBases } = await loadPure()
    assert.deepEqual(pkFilterBases(BASES, 'zzz'), [])
    assert.deepEqual(pkFilterBases(null, 'x'), [])
    assert.deepEqual(pkFilterBases(BASES, null).length, 3)
  })
})

describe('picker: 勾选 / 并集 / 脏检查', () => {
  it('toggle 加入与移除，保持其余顺序', async () => {
    const { pkToggleId } = await loadPure()
    assert.deepEqual(pkToggleId(['a'], 'b'), ['a', 'b'])
    assert.deepEqual(pkToggleId(['a', 'b', 'c'], 'b'), ['a', 'c'])
    // 空 id / 非字符串不改变选择
    assert.deepEqual(pkToggleId(['a'], ''), ['a'])
    assert.deepEqual(pkToggleId(['a'], undefined), ['a'])
    assert.deepEqual(pkToggleId(null, 'a'), ['a'])
  })

  it('并集：不重复、保序、不丢原有项', async () => {
    const { pkMergeSelected } = await loadPure()
    assert.deepEqual(pkMergeSelected(['a', 'b'], ['b', 'c']), ['a', 'b', 'c'])
    assert.deepEqual(pkMergeSelected([], ['x']), ['x'])
    assert.deepEqual(pkMergeSelected(['a'], []), ['a'])
  })

  it('脏检查：集合语义（顺序不同不算脏）', async () => {
    const { pkDirty } = await loadPure()
    assert.equal(pkDirty(['a', 'b'], ['b', 'a']), false)
    assert.equal(pkDirty(['a'], ['a', 'b']), true)
    assert.equal(pkDirty([], []), false)
    assert.equal(pkDirty(['a'], []), true)
    assert.equal(pkDirty(null, null), false)
  })

  it('刷新时若用户已有改动 → 并集；无改动 → 用宿主的已选覆盖', async () => {
    const { pkDirty, pkMergeSelected } = await loadPure()
    const saved = ['a']
    // 用户点了 b（脏）→ 并集，b 不丢
    assert.deepEqual(pkMergeSelected(['a', 'b'], saved), ['a', 'b'])
    assert.equal(pkDirty(['a', 'b'], saved), true)
    // 未改动 → 直接用宿主返回
    assert.equal(pkDirty(['a'], saved), false)
  })
})

// ══════════════════════════════════════════════════════════════════
// 分组启发式
// ══════════════════════════════════════════════════════════════════

describe('picker: 分组（group: personal | joined 契约）', () => {
  const BASES = [
    { id: 'kb-1', name: '产品文档' },
    { id: 'kb-2', name: '技术文档' },
  ]

  it('无 group 字段 → 全部落「个人知识库」，第二组不渲染', async () => {
    const { pkGroups } = await loadPure()
    const groups = pkGroups(BASES, '')
    assert.equal(groups.length, 1)
    assert.equal(groups[0].titleKey, 'pk.groupPersonal')
    assert.deepEqual(groups[0].items.map((item) => item.id), ['kb-1', 'kb-2'])
  })

  it('group="joined" → 进「我加入的」；group="personal" 与缺字段 → 「个人知识库」', async () => {
    const { pkGroups } = await loadPure()
    const groups = pkGroups([
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B', group: 'personal' },
      { id: 'c', name: 'C', group: 'joined' },
      { id: 'd', name: 'D', group: 'joined' },
    ], '')
    assert.deepEqual(groups.map((group) => group.titleKey), ['pk.groupPersonal', 'pk.groupJoined'])
    assert.deepEqual(groups[0].items.map((item) => item.id), ['a', 'b'], '缺字段与 personal 同组')
    assert.deepEqual(groups[1].items.map((item) => item.id), ['c', 'd'])
  })

  it('未知 group 值不猜语义，归入「个人知识库」（只认契约里的 joined）', async () => {
    const { pkGroups } = await loadPure()
    const groups = pkGroups([
      { id: 'a', name: 'A', group: 'something-else' },
      { id: 'b', name: 'B', group: 'JOINED' },
    ], '')
    assert.equal(groups.length, 1)
    assert.equal(groups[0].titleKey, 'pk.groupPersonal')
    assert.deepEqual(groups[0].items.map((item) => item.id), ['a', 'b'])
  })

  it('顺序固定：个人在前、我加入的在后（不按首次出现排）', async () => {
    const { pkGroups } = await loadPure()
    // 宿主先返回 joined，顺序仍必须是 个人 → 我加入的，否则版式会上下颠倒。
    const groups = pkGroups([
      { id: 'j1', name: 'J1', group: 'joined' },
      { id: 'p1', name: 'P1', group: 'personal' },
    ], '')
    assert.deepEqual(groups.map((group) => group.titleKey), ['pk.groupPersonal', 'pk.groupJoined'])
  })

  it('空组整组不渲染（只有 joined 时，个人组消失）', async () => {
    const { pkGroups } = await loadPure()
    const groups = pkGroups([{ id: 'j', name: 'J', group: 'joined' }], '')
    assert.equal(groups.length, 1)
    assert.equal(groups[0].titleKey, 'pk.groupJoined')
    assert.ok(groups.every((group) => group.items.length > 0), '不得出现空组')
  })

  it('分组前先过滤：搜索结果里只剩某组时，另一组自动消失', async () => {
    const { pkGroups } = await loadPure()
    const groups = pkGroups([
      { id: 'a', name: '产品', group: 'joined' },
      { id: 'b', name: '设计' },
    ], '产品')
    assert.equal(groups.length, 1)
    assert.equal(groups[0].titleKey, 'pk.groupJoined')
    assert.deepEqual(groups[0].items.map((item) => item.id), ['a'])
  })

  it('空列表 → 零个分组', async () => {
    const { pkGroups } = await loadPure()
    assert.deepEqual(pkGroups([], ''), [])
    assert.deepEqual(pkGroups(null, ''), [])
  })

  it('group 值带空白也能识别（trim 后比较）', async () => {
    const { pkGroups } = await loadPure()
    const groups = pkGroups([{ id: 'a', name: 'A', group: '  joined  ' }], '')
    assert.equal(groups[0].titleKey, 'pk.groupJoined')
  })
})

// ══════════════════════════════════════════════════════════════════
// 视图态 / 确定可点
// ══════════════════════════════════════════════════════════════════

describe('picker: 列表三态 + 两种空态', () => {
  it('loading / error 优先于一切', async () => {
    const { pkViewState } = await loadPure()
    assert.equal(pkViewState({ phase: 'loading' }), 'loading')
    assert.equal(pkViewState({ phase: 'error' }), 'error')
    // 即使 configured=false，加载中也不该先报未配置
    assert.equal(pkViewState({ phase: 'loading', configured: false }), 'loading')
  })

  it('未配置凭据必须先于「空列表」判断（A10：不把没登录说成没有知识库）', async () => {
    const { pkViewState } = await loadPure()
    assert.equal(pkViewState({ phase: 'ready', configured: false, total: 0, visible: 0 }), 'unconfigured')
  })

  it('已配置但列表为空 → empty；有列表但筛选无结果 → emptyFiltered', async () => {
    const { pkViewState } = await loadPure()
    assert.equal(pkViewState({ phase: 'ready', configured: true, total: 0, visible: 0 }), 'empty')
    assert.equal(pkViewState({ phase: 'ready', configured: true, total: 3, visible: 0 }), 'emptyFiltered')
    assert.equal(pkViewState({ phase: 'ready', configured: true, total: 3, visible: 2 }), 'ready')
  })

  it('垃圾输入落到 empty 而不是抛错', async () => {
    const { pkViewState } = await loadPure()
    assert.equal(pkViewState(null), 'empty')
    assert.equal(pkViewState({ phase: 'ready' }), 'empty')
  })
})

describe('picker: 「确定」可点判据', () => {
  it('N=0 置灰；N>0 可点；保存中一律置灰', async () => {
    const { pkCanConfirm } = await loadPure()
    assert.equal(pkCanConfirm([], false), false)
    assert.equal(pkCanConfirm(['a'], false), true)
    assert.equal(pkCanConfirm(['a'], true), false)
    assert.equal(pkCanConfirm(null, false), false)
  })
})

// ══════════════════════════════════════════════════════════════════
// 总线（菜单 → 模态）
// ══════════════════════════════════════════════════════════════════

describe('picker: 菜单与模态之间的开关总线', () => {
  it('open / close 会通知订阅者，close 可带 toast', async () => {
    const { createPickerBus } = await loadPure()
    const bus = createPickerBus()
    let calls = 0
    const unsubscribe = bus.subscribe(() => { calls += 1; })

    assert.equal(bus.getSnapshot().open, false)
    bus.open('session-1')
    assert.equal(bus.getSnapshot().open, true)
    assert.equal(bus.getSnapshot().sessionId, 'session-1')
    assert.equal(calls, 1)

    bus.close({ tone: 'ok', text: '已选择 2 个知识库' })
    assert.equal(bus.getSnapshot().open, false)
    assert.equal(bus.getSnapshot().sessionId, undefined)
    assert.deepEqual(bus.getSnapshot().toast, { tone: 'ok', text: '已选择 2 个知识库' })
    assert.equal(calls, 2)

    bus.clearToast()
    assert.equal(bus.getSnapshot().toast, null)

    unsubscribe()
    const before = calls
    bus.open(undefined)
    assert.equal(calls, before, '退订后不再收到通知')
  })

  it('订阅者抛错不会打断其余订阅者（一个坏监听不能锁死菜单）', async () => {
    const { createPickerBus } = await loadPure()
    const bus = createPickerBus()
    let reached = 0
    bus.subscribe(() => { throw new Error('boom'); })
    bus.subscribe(() => { reached += 1; })
    const original = console.error;
    console.error = () => {}
    try {
      assert.doesNotThrow(() => bus.open('s'))
    } finally {
      console.error = original
    }
    assert.equal(reached, 1)
  })
})

// ══════════════════════════════════════════════════════════════════
// 交互闭环（带状态的最小 React 运行时：真的跑 useState / useEffect）
// ══════════════════════════════════════════════════════════════════

/**
 * 一个能真正跑「渲染 → 提交 → 副作用 → setState → 重渲染」的最小运行时。
 *
 * 冒烟测试里的 `makeFakeReact` 只跑首帧，覆盖不到「点确定 → POST → 关闭」
 * 这类异步路径；这里补上它。只实现片段用到的钩子，语义按 React 简化：
 *  - hook 按调用序号定位（片段里没有条件调用 hook，顺序稳定）；
 *  - `useEffect` 的依赖数组浅比较；
 *  - `setState` 立即标记 dirty，flush 时重渲染。
 * @returns {object} `{React, h, mount}`。
 */
function makeLiveReact() {
  let slots = []
  let cursor = 0
  let dirty = false
  let current = null

  const createElement = (type, props, ...children) => ({
    $$element: true,
    type,
    props: Object.assign({}, props, children.length === 0 ? {} : { children: children.length === 1 ? children[0] : children }),
  })

  const useState = (initial) => {
    const index = cursor
    cursor += 1
    if (slots[index] === undefined) slots[index] = { kind: 'state', value: typeof initial === 'function' ? initial() : initial }
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
    queue.push({ index: index, effect: effect })
  }

  const useMemo = (factory, deps) => {
    const index = cursor
    cursor += 1
    const previous = slots[index]
    if (previous !== undefined && sameDeps(previous.deps, deps)) return previous.value
    const value = factory()
    slots[index] = { kind: 'memo', deps: deps, value: value }
    return value
  }

  const useCallback = (fn, deps) => useMemo(() => fn, deps)
  const useRef = (initial) => {
    const index = cursor
    cursor += 1
    if (slots[index] === undefined) slots[index] = { kind: 'ref', value: { current: initial } }
    return slots[index].value
  }

  let queue = []

  const React = {
    createElement,
    Fragment: Symbol.for('react.fragment'),
    useState,
    useEffect,
    useMemo,
    useCallback,
    useRef,
  }

  /**
   * 挂载一个组件并把它跑到稳定态（副作用 + 异步 setState 全部落地）。
   *
   * 关键点：`postJson` 是 Promise，副作用里发起的请求要等微任务/宏任务回填后
   * 才会 setState，所以这里用 `setImmediate` 让出事件循环，直到「没有待执行
   * 副作用、没有 dirty、也没有新排队的 effect」才算稳定。
   * @param {Function} Component - 组件函数。
   * @param {object} props - 初始 props。
   * @param {number} [maxRounds] - 最大重渲染轮数（防死循环）。
   * @returns {Promise<object>} `{tree, rerender, text, dispose}`。
   */
  async function mount(Component, props, maxRounds = 40) {
    current = { Component: Component, props: props }
    let tree
    const render = () => {
      cursor = 0
      queue = []
      dirty = false
      return Component(props)
    }
    /** 执行排队的副作用；有 setState 时重渲染。 */
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
    tree = render()
    for (let round = 0; round < maxRounds; round += 1) {
      const rendered = flush()
      if (!rendered && queue.length === 0) {
        // 让出事件循环，等异步请求回填；再确认一次是否真的稳定了。
        await new Promise((resolve) => { setImmediate(resolve) })
        if (queue.length === 0 && dirty === false) break
      } else {
        await Promise.resolve()
      }
    }
    const view = {
      // getter 而不是快照：`rerender()` 会换掉当前树，读到的必须是最新那棵。
      get tree() { return tree; },
      /** 同步重渲染（测试里手动触发 onChange 后用）。 */
      rerender: () => { tree = render(); flush(); return tree; },
      text: () => [...collectStrings(tree)].join(' | '),
      dispose: () => {
        for (const slot of slots) {
          if (slot !== undefined && typeof slot.dispose === 'function') slot.dispose()
        }
      },
    }
    return view
  }

  return { React: React, h: createElement, mount: mount }
}

/**
 * 用「带状态运行时」重新求值片段，返回组件。
 * @param {object} [overrides] - `{postJson}`。
 * @returns {Promise<object>} `{PickerModal, PickerOverlay, pickerShared, mount, core}`。
 */
async function loadLive(overrides = {}) {
  const fragment = await readFile(FRAGMENT, 'utf8')
  const core = await loadCore()
  const live = makeLiveReact()
  // eslint-disable-next-line no-new-func
  const factory = new Function(
    'React',
    'h',
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
    `${fragment}\nreturn { PickerModal, PickerOverlay, PickerFooter, pickerShared };`,
  )
  const out = factory(
    live.React,
    live.h,
    core.S,
    core.fallbackTranslate,
    {
      list: 'api/ima-knowledge/list',
      select: 'api/ima-knowledge/select',
      status: 'api/ima-knowledge/status',
      credentials: 'api/ima-knowledge/credentials',
      media: 'api/ima-knowledge/media',
    },
    overrides.postJson || (async () => ({})),
    core.HostFailure,
    core.failureOf,
    core.failureText,
    core.errorText,
    (value) => typeof value === 'string' && value.trim() !== '',
    (entry) => entry,
    core.fallbackTranslate,
  )
  return Object.assign({ mount: live.mount, core: core }, out)
}

describe('picker: 打开 → 拉列表 → 勾选 → 确定（真跑副作用）', () => {
  /** `/list` 的正常返回。 */
  const LIST_VALUE = {
    knowledgeBases: [
      { id: 'kb-1', name: '产品文档' },
      { id: 'kb-2', name: '技术文档' },
    ],
    selected: ['kb-1'],
    status: { configured: true, tokenValid: true },
  }

  it('打开即 POST /list，并把 selected 作为初始勾选', async () => {
    const calls = []
    const { PickerModal, pickerShared, mount } = await loadLive({
      postJson: async (path, body) => {
        calls.push({ path: path, body: body })
        return LIST_VALUE
      },
    })
    const bus = pickerShared()
    bus.open('s')
    const view = await mount(PickerModal, { t: undefined, bus: bus })
    view.dispose()

    assert.equal(calls.length, 1, '打开应只拉一次列表')
    assert.equal(calls[0].path, 'api/ima-knowledge/list')
    assert.deepEqual(calls[0].body, {})

    const text = view.text()
    assert.match(text, /产品文档/u)
    assert.match(text, /技术文档/u)
    assert.match(text, /已选择 1 项/u, 'selected 应作为初始勾选')

    const checkboxes = findCheckboxes(view.tree)
    assert.equal(checkboxes[0].props.checked, true, 'kb-1 初始勾选')
    assert.equal(checkboxes[1].props.checked, false)
  })

  it('勾选一行后计数与「确定」可点状态同步变化', async () => {
    const { PickerModal, pickerShared, mount } = await loadLive({
      postJson: async () => ({ knowledgeBases: [{ id: 'kb-1', name: 'A' }], selected: [] }),
    })
    const bus = pickerShared()
    bus.open('s')
    const view = await mount(PickerModal, { t: undefined, bus: bus })
    assert.match(view.text(), /已选择 0 项/u)

    const checkbox = findCheckboxes(view.tree)[0]
    checkbox.props.onChange({ currentTarget: { checked: true } })
    view.rerender()
    assert.match(view.text(), /已选择 1 项/u, '勾选后计数要变')
    view.dispose()
  })

  it('确定成功 → POST /select 带 ids，关闭模态并留下可见 toast', async () => {
    const calls = []
    const { PickerModal, pickerShared, mount } = await loadLive({
      postJson: async (path, body) => {
        calls.push({ path: path, body: body })
        if (path === 'api/ima-knowledge/select') return { selected: body.ids }
        return LIST_VALUE
      },
    })
    const bus = pickerShared()
    bus.open('s')
    const view = await mount(PickerModal, { t: undefined, bus: bus })

    // 勾上第二个，然后点「确定」（底栏最后一个按钮）。
    findCheckboxes(view.tree)[1].props.onChange({ currentTarget: { checked: true } })
    view.rerender()
    const buttons = findByType(view.tree, 'button')
    const confirm = buttons[buttons.length - 1]
    assert.equal(confirm.props.disabled, false)
    await confirm.props.onClick()

    const selectCall = calls.find((call) => call.path === 'api/ima-knowledge/select')
    assert.ok(selectCall !== undefined, '必须 POST /select')
    assert.deepEqual(selectCall.body, { ids: ['kb-1', 'kb-2'] })

    const snapshot = bus.getSnapshot()
    assert.equal(snapshot.open, false, '成功后应关闭')
    assert.equal(snapshot.toast.tone, 'ok')
    assert.match(snapshot.toast.text, /已选择 2 个知识库/u)
    view.dispose()
    bus.clearToast()
  })

  it('确定失败 → 回显 error 原文，且模态不关闭', async () => {
    const { PickerModal, pickerShared, mount, core } = await loadLive({
      postJson: async (path) => {
        if (path === 'api/ima-knowledge/select') {
          throw core.HostFailure('host', 'IMA 服务返回 500：upstream timeout', 'IMA_UPSTREAM')
        }
        return LIST_VALUE
      },
    })
    const bus = pickerShared()
    bus.open('s')
    const view = await mount(PickerModal, { t: undefined, bus: bus })

    const buttons = findByType(view.tree, 'button')
    await buttons[buttons.length - 1].props.onClick()
    view.rerender()

    assert.equal(bus.getSnapshot().open, true, '失败时模态不能关（用户要能重试）')
    const text = view.text()
    assert.match(text, /保存失败/u, '要有「保存失败」前缀')
    assert.match(text, /IMA 服务返回 500：upstream timeout/u, '必须回显宿主 error 原文')
    view.dispose()
  })

  it('N=0 时点「确定」不发请求（置灰之外再兜一层）', async () => {
    const calls = []
    const { PickerModal, pickerShared, mount } = await loadLive({
      postJson: async (path) => {
        calls.push(path)
        return { knowledgeBases: [{ id: 'kb-1', name: 'A' }], selected: [] }
      },
    })
    const bus = pickerShared()
    bus.open('s')
    const view = await mount(PickerModal, { t: undefined, bus: bus })
    const buttons = findByType(view.tree, 'button')
    await buttons[buttons.length - 1].props.onClick()
    assert.equal(calls.filter((path) => path.endsWith('/select')).length, 0)
    assert.equal(bus.getSnapshot().open, true)
    view.dispose()
  })

  it('加载失败 → 文案含宿主 message + 重试按钮重新拉列表', async () => {
    let attempt = 0
    const { PickerModal, pickerShared, mount, core } = await loadLive({
      postJson: async () => {
        attempt += 1
        if (attempt === 1) throw core.HostFailure('host', 'CREDENTIAL_READONLY: no store', 'CREDENTIAL_READONLY')
        return LIST_VALUE
      },
    })
    const bus = pickerShared()
    bus.open('s')
    const view = await mount(PickerModal, { t: undefined, bus: bus })

    assert.match(view.text(), /读取知识库失败/u)
    assert.match(view.text(), /CREDENTIAL_READONLY: no store/u, '错误必须回显原文')

    const retry = findByType(view.tree, 'button').find((button) => button.props.children === '重试')
    assert.ok(retry !== undefined, '加载失败必须有重试按钮')
    retry.props.onClick()
    view.rerender()
    assert.equal(attempt, 2, '重试应重新 POST /list')
    view.dispose()
  })

  it('未配置凭据 → 明确文案，不是空列表', async () => {
    const { PickerModal, pickerShared, mount } = await loadLive({
      postJson: async () => ({
        knowledgeBases: [],
        selected: [],
        status: { configured: false, tokenValid: false },
      }),
    })
    const bus = pickerShared()
    bus.open('s')
    const view = await mount(PickerModal, { t: undefined, bus: bus })
    const text = view.text()
    assert.match(text, /未配置凭据/u)
    assert.match(text, /尚未配置 IMA 凭据/u)
    assert.equal(text.includes('没有可访问的知识库'), false, '不能把没登录说成没有知识库')
    view.dispose()
  })

  it('Esc 关闭模态（document 监听装/卸对称）', async () => {
    const listeners = new Set()
    const originalDocument = globalThis.document
    globalThis.document = {
      addEventListener: (type, handler) => { if (type === 'keydown') listeners.add(handler) },
      removeEventListener: (type, handler) => { if (type === 'keydown') listeners.delete(handler) },
    }
    try {
      const { PickerModal, pickerShared, mount } = await loadLive({ postJson: async () => LIST_VALUE })
      const bus = pickerShared()
      bus.open('s')
      const view = await mount(PickerModal, { t: undefined, bus: bus })
      assert.equal(listeners.size, 1, 'Esc 监听应装上')

      const handler = [...listeners][0]
      let stopped = false
      handler({ key: 'Escape', stopPropagation: () => { stopped = true } })
      assert.equal(bus.getSnapshot().open, false, 'Esc 应关闭')
      assert.equal(stopped, true, 'Esc 不应继续冒泡到输入框')
      // 非 Esc 键不关闭
      bus.open('s')
      handler({ key: 'a', stopPropagation: () => {} })
      assert.equal(bus.getSnapshot().open, true)

      view.dispose()
      assert.equal(listeners.size, 0, '卸载后必须移除监听（否则切会话会泄漏）')
      bus.close()
    } finally {
      globalThis.document = originalDocument
    }
  })

  it('未配置 + 宿主带 status.error → 错误原文也要回显（不静默）', async () => {
    const { PickerModal, pickerShared, mount } = await loadLive({
      postJson: async () => ({
        knowledgeBases: [],
        selected: [],
        status: { configured: false, tokenValid: false, error: 'IMA-TOKEN 已过期' },
      }),
    })
    const bus = pickerShared()
    bus.open('s')
    const view = await mount(PickerModal, { t: undefined, bus: bus })
    const text = view.text()
    assert.match(text, /未配置凭据/u)
    assert.match(text, /IMA-TOKEN 已过期/u, '宿主 error 必须回显')
    view.dispose()
  })

  it('搜索框过滤后，勾选状态保留（筛掉的已选项不丢）', async () => {
    const { PickerModal, pickerShared, mount } = await loadLive({
      postJson: async () => LIST_VALUE,
    })
    const bus = pickerShared()
    bus.open('s')
    const view = await mount(PickerModal, { t: undefined, bus: bus })

    const search = findByType(view.tree, 'input').find((input) => input.props.type === 'search')
    search.props.onChange({ currentTarget: { value: '技术' } })
    view.rerender()
    const text = view.text()
    assert.match(text, /技术文档/u)
    assert.equal(text.includes('产品文档'), false, '不匹配的行应被筛掉')
    assert.match(text, /已选择 1 项/u, '筛选不影响已选计数')
    view.dispose()
  })
})


describe('picker: 渲染冒烟（伪 React，无浏览器）', () => {
  it('模态首帧（加载中）不抛错，且标题 / 页签 / 底栏文案齐全', async () => {
    const { PickerModal, pickerShared } = await loadComponents()
    const bus = pickerShared()
    let tree
    assert.doesNotThrow(() => { tree = PickerModal({ t: undefined, bus: bus }) })
    const strings = [...collectStrings(tree)].join(' | ')
    assert.match(strings, /从 ima 中选择/u, '缺少模态标题')
    assert.match(strings, /选择知识库/u, '缺少知识库页签')
    assert.match(strings, /选择文件/u, '缺少文件页签')
    assert.match(strings, /正在读取知识库/u, '加载中必须给文案，不能空白')
    assert.match(strings, /已选择 0 项/u, '缺少已选计数')
    assert.match(strings, /取消/u, '缺少取消按钮')
    assert.match(strings, /确定/u, '缺少确定按钮')
  })

  it('两个页签都是真按钮（文件页签可点，不是死标签）', async () => {
    const { PickerToolbar } = await loadComponents()
    const buttons = findByType(PickerToolbar({
      t: (key) => key,
      tab: 'kb',
      query: '',
      disabled: false,
      onTab: () => {},
      onQuery: () => {},
    }), 'button')
    assert.equal(buttons.length, 2, '应有「选择知识库」「选择文件」两个页签按钮')
    for (const button of buttons) {
      assert.equal(typeof button.props.onClick, 'function', '页签必须可点击')
    }
    // 当前页签有 aria-selected，非当前页签没有
    assert.equal(buttons[0].props['aria-selected'], 'true')
    assert.equal(buttons[1].props['aria-selected'], 'false')
  })

  it('搜索框存在且受控', async () => {
    const { PickerToolbar } = await loadComponents()
    const inputs = findByType(PickerToolbar({
      t: (key) => key,
      tab: 'kb',
      query: 'abc',
      disabled: false,
      onTab: () => {},
      onQuery: () => {},
    }), 'input')
    assert.equal(inputs.length, 1)
    assert.equal(inputs[0].props.value, 'abc')
    assert.equal(typeof inputs[0].props.onChange, 'function')
  })

  it('文件页签内容是占位空态（可切换，不是空白）', async () => {
    const { PickerBody } = await loadComponents()
    const tree = PickerBody({
      t: (key) => key,
      tab: 'file',
      view: 'ready',
      groups: [],
      scope: 's',
      draftSet: new Set(),
      disabled: false,
      errorText: '',
      onToggle: () => {},
      onRetry: () => {},
    })
    const strings = [...collectStrings(tree)].join(' | ')
    assert.match(strings, /pk\.fileComingSoon/u, '文件页签必须给占位文案')
  })

  it('三态 + 两种空态都渲染出明确文案（禁止空白）', async () => {
    const { PickerBody } = await loadComponents()
    const cases = [
      ['loading', {}, /pk\.loading/u],
      ['error', { errorText: 'host down' }, /pk\.loadFailed/u],
      ['unconfigured', {}, /statusUnconfigured/u],
      ['empty', {}, /pk\.empty/u],
      ['emptyFiltered', {}, /pk\.emptyFiltered/u],
    ]
    for (const [view, extra, pattern] of cases) {
      const tree = PickerBody(Object.assign({
        t: (key) => key,
        tab: 'kb',
        view: view,
        groups: [],
        scope: 's',
        draftSet: new Set(),
        disabled: false,
        errorText: '',
        onToggle: () => {},
        onRetry: () => {},
      }, extra))
      const strings = [...collectStrings(tree)].join(' | ')
      assert.match(strings, pattern, `${view} 态缺少文案`)
    }
  })

  it('加载失败 / 未配置 / 空列表都带重试按钮', async () => {
    const { PickerBody } = await loadComponents()
    for (const view of ['error', 'unconfigured', 'empty']) {
      const buttons = findByType(PickerBody({
        t: (key) => key,
        tab: 'kb',
        view: view,
        groups: [],
        scope: 's',
        draftSet: new Set(),
        disabled: false,
        errorText: 'boom',
        onToggle: () => {},
        onRetry: () => {},
      }), 'button')
      assert.ok(buttons.length >= 1, `${view} 态缺少重试按钮`)
    }
  })

  it('正常态：分组标题 + 每行 = 复选框 + 文件夹图标 + 名称', async () => {
    const { PickerBody } = await loadComponents()
    const groups = [{
      key: 'group:pk.groupPersonal',
      titleKey: 'pk.groupPersonal',
      title: undefined,
      items: [{ id: 'kb-1', name: '产品文档' }, { id: 'kb-2', name: '技术文档' }],
    }]
    const tree = PickerBody({
      t: (key) => key,
      tab: 'kb',
      view: 'ready',
      groups: groups,
      scope: 's',
      draftSet: new Set(['kb-2']),
      disabled: false,
      errorText: '',
      onToggle: () => {},
      onRetry: () => {},
    })
    const strings = [...collectStrings(tree)].join(' | ')
    assert.match(strings, /pk\.groupPersonal/u, '缺少分组标题')
    assert.match(strings, /产品文档/u)
    assert.match(strings, /技术文档/u)

    const checkboxes = findByType(tree, 'input')
    assert.equal(checkboxes.length, 2, '每个知识库一行复选框')
    assert.equal(checkboxes[0].props.checked, false)
    assert.equal(checkboxes[1].props.checked, true, '已选项必须回显为勾选')

    const labels = findByType(tree, 'label')
    assert.equal(labels.length, 2, '整行可点（label 包住复选框与名称）')
    // 文件夹图标：label 的第一个子元素之后应有 svg
    const svgs = findByType(tree, 'svg')
    assert.equal(svgs.length, 2, '每行一个文件夹图标')
  })

  it('底栏：N=0 时「确定」置灰，N>0 时可点', async () => {
    const { PickerFooter } = await loadComponents()
    const zero = findByType(PickerFooter({ t: (key) => key, count: 0, saving: false, onCancel: () => {}, onConfirm: () => {} }), 'button')
    const confirmZero = zero[zero.length - 1]
    assert.equal(confirmZero.props.disabled, true)
    assert.equal(confirmZero.props['aria-disabled'], 'true')

    const some = findByType(PickerFooter({ t: (key) => key, count: 2, saving: false, onCancel: () => {}, onConfirm: () => {} }), 'button')
    const confirmSome = some[some.length - 1]
    assert.equal(confirmSome.props.disabled, false)
    assert.equal(confirmSome.props['aria-disabled'], undefined)
  })

  it('遮罩用 S.modalMask（fixed 定位），卡片用 S.modalCard（860px / 80vh）', async () => {
    const { PickerModal, pickerShared } = await loadComponents()
    // 注意：不能跨 `loadComponents` / `loadCore` 比引用——两次求值各有自己的 S 对象。
    // 这里断言「用的是 10-core 预置样式的那几个关键字段」，而不是另造一套 inline style。
    const rootElement = renderRoot(PickerModal({ t: undefined, bus: pickerShared() }))
    const mask = rootElement.props.style
    assert.equal(mask.position, 'fixed', '锚点是 height:0，模态必须自己 fixed')
    assert.equal(mask.inset, 0)
    assert.equal(mask.zIndex, 2147483000)
    const card = renderRoot(rootElement.props.children)
    const cardStyle = card.props.style
    assert.equal(cardStyle.width, '860px')
    assert.equal(cardStyle.maxHeight, '80vh')
    assert.equal(cardStyle.borderRadius, '12px')
    assert.equal(card.props.role, 'dialog')
    assert.equal(card.props['aria-modal'], 'true')
  })

  it('点遮罩会关闭（点卡片内部不关闭）', async () => {
    const { PickerModal, pickerShared } = await loadComponents()
    const bus = pickerShared()
    bus.open('s')
    const rootElement = renderRoot(PickerModal({ t: undefined, bus: bus }))
    assert.equal(typeof rootElement.props.onClick, 'function')
    rootElement.props.onClick()
    assert.equal(bus.getSnapshot().open, false, '点遮罩应取消')
  })

  it('关闭按钮与取消按钮都能关闭', async () => {
    const { PickerModal, pickerShared } = await loadComponents()
    const bus = pickerShared()
    bus.open('s')
    const buttons = findByType(PickerModal({ t: undefined, bus: bus }), 'button')
    const close = buttons.find((button) => button.props['aria-label'] === '关闭')
    assert.ok(close !== undefined, '缺少关闭按钮（×）')
    close.props.onClick()
    assert.equal(bus.getSnapshot().open, false)
  })

  it('PickerOverlay 关闭时返回空（不占位、不空白报错）', async () => {
    const { PickerOverlay, pickerShared } = await loadComponents()
    const bus = pickerShared()
    bus.close()
    bus.clearToast()
    const tree = PickerOverlay({ picker: bus, pickerT: undefined, pickerSessionId: 's' })
    const strings = [...collectStrings(tree)]
    assert.deepEqual(strings, [], '关闭态不应渲染任何文本')
  })

  it('PickerOverlay 打开时渲染模态，且只在该会话的实例里渲染', async () => {
    const { PickerOverlay, pickerShared } = await loadComponents()
    const bus = pickerShared()
    bus.open('session-A')
    const mine = [...collectStrings(PickerOverlay({ picker: bus, pickerT: undefined, pickerSessionId: 'session-A' }))].join(' | ')
    assert.match(mine, /从 ima 中选择/u)
    const other = [...collectStrings(PickerOverlay({ picker: bus, pickerT: undefined, pickerSessionId: 'session-B' }))]
    assert.equal(other.includes('从 ima 中选择'), false, '别的会话的 overlay 实例不应抢渲染')
    bus.close()
    bus.clearToast()
  })

  it('两个图标都是纯 SVG + currentColor', async () => {
    const { PickerMenuIcon, PickerFolderIcon } = await loadComponents()
    for (const icon of [PickerMenuIcon({ size: 18 }), PickerFolderIcon()]) {
      assert.equal(icon.type, 'svg')
      assert.equal(icon.props['aria-hidden'], 'true')
      assert.match(JSON.stringify(icon), /currentColor/u)
    }
    assert.equal(PickerMenuIcon({}).props.width, 16)
    assert.equal(PickerMenuIcon({ size: -1 }).props.width, 16)
  })
})

// ══════════════════════════════════════════════════════════════════
// 注册面
// ══════════════════════════════════════════════════════════════════

describe('picker: 注册面', () => {
  /**
   * 造一个记录调用的假 ctx。
   * @param {object} [options] - `{commandUi:boolean}`。
   * @returns {object} 假 ctx 与调用记录。
   */
  function makeCtx(options = {}) {
    const calls = []
    const ctx = {
      slots: {
        inject: (name, install) => { calls.push({ kind: 'slot-inject', name: name }); install() },
        register: (opts, component) => {
          calls.push({ kind: 'slot-register', options: opts, component: component })
          return () => {}
        },
      },
      effect: (factory) => {
        calls.push({ kind: 'effect' })
        const dispose = factory()
        return () => { if (typeof dispose === 'function') dispose() }
      },
      inject: (deps, callback) => {
        calls.push({ kind: 'ctx-inject', deps: deps })
        if (options.commandUi === false) return
        const scope = {
          effect: ctx.effect,
          commandUi: {
            register: (contribution) => {
              calls.push({ kind: 'command-register', contribution: contribution })
              return () => {}
            },
          },
        }
        callback(scope)
      },
    }
    return { ctx: ctx, calls: calls }
  }

  it('注册 conversation.input.overlay（list 槽必须给唯一 id）', async () => {
    const { registerPicker } = await loadComponents()
    const { ctx, calls } = makeCtx()
    assert.doesNotThrow(() => registerPicker(ctx, { t: (key) => key }))
    const injects = calls.filter((call) => call.kind === 'slot-inject').map((call) => call.name)
    assert.ok(injects.includes('conversation.input.overlay'), '必须注册到 conversation.input.overlay')
    const register = calls.find((call) => call.kind === 'slot-register')
    assert.equal(register.options.name, 'conversation.input.overlay')
    assert.equal(register.options.id, 'ima-picker')
    assert.equal(typeof register.options.inject, 'function')
    // session 作用域：inject 收到 sessionId 并原样带到组件 props 上
    const injected = register.options.inject('session-X')
    assert.equal(injected.pickerSessionId, 'session-X')
    assert.ok(injected.picker !== undefined)
  })

  it('注册 /ima 命令贡献：label / description / icon / available / action', async () => {
    const { registerPicker } = await loadComponents()
    const { ctx, calls } = makeCtx()
    registerPicker(ctx, { t: (key) => key })
    const contribution = calls.find((call) => call.kind === 'command-register').contribution
    assert.equal(contribution.name, 'ima')
    assert.equal(contribution.label(), 'pk.label')
    assert.equal(contribution.description(), 'pk.description')
    assert.equal(typeof contribution.icon, 'function')
    assert.equal(contribution.available({ sessionId: 's' }), true)
    assert.equal(contribution.ui.kind, 'action', '用 action 而不是 popupSelect（后者是单选壳）')
    assert.equal(typeof contribution.ui.run, 'function')
  })

  it('点 /ima 行 → 打开模态（总线 open，带 sessionId）', async () => {
    const { registerPicker, pickerShared } = await loadComponents()
    const { ctx, calls } = makeCtx()
    registerPicker(ctx, { t: (key) => key })
    const bus = pickerShared()
    bus.close()
    const contribution = calls.find((call) => call.kind === 'command-register').contribution
    contribution.ui.run({ sessionId: 'session-Z' })
    assert.equal(bus.getSnapshot().open, true)
    assert.equal(bus.getSnapshot().sessionId, 'session-Z')
    bus.close()
    bus.clearToast()
  })

  it('commandUi 缺失时不影响 overlay 注册（半可用不崩）', async () => {
    const { registerPicker } = await loadComponents()
    const { ctx, calls } = makeCtx({ commandUi: false })
    const original = console.error
    console.error = () => {}
    try {
      assert.doesNotThrow(() => registerPicker(ctx, { t: (key) => key }))
    } finally {
      console.error = original
    }
    assert.ok(calls.some((call) => call.kind === 'slot-register'), 'overlay 仍应注册成功')
  })

  it('slots 缺失时 registerPicker 不抛错（席位失败不拖垮插件）', async () => {
    const { registerPicker } = await loadComponents()
    const original = console.error
    console.error = () => {}
    try {
      assert.doesNotThrow(() => registerPicker({}, { t: (key) => key }))
      assert.doesNotThrow(() => registerPicker({ slots: {} }, { t: (key) => key }))
    } finally {
      console.error = original
    }
  })
})

// ══════════════════════════════════════════════════════════════════
// locale key 完整性
// ══════════════════════════════════════════════════════════════════

describe('picker: locale key 完整性', () => {
  /** 本席位已用、但 10-core 尚未落盘的 key（当前为空：缺任何 key 都直接红）。 */
  const PENDING_KEYS = new Set([])

  it('片段里 t(...) 用到的每个 key 都在 zh / en 字典里', async () => {
    const source = await readFile(FRAGMENT, 'utf8')
    const core = await loadCore()
    const used = new Set()
    for (const match of source.matchAll(/\bt\(\s*'([^']+)'/gu)) used.add(match[1])
    assert.ok(used.size > 10, `应解析出多个 key，实际 ${used.size}`)
    const missingZh = [...used].filter((key) => !(key in core.zh) && !PENDING_KEYS.has(key))
    const missingEn = [...used].filter((key) => !(key in core.en) && !PENDING_KEYS.has(key))
    assert.deepEqual(missingZh, [], 'zh 缺 key：' + missingZh.join(', '))
    assert.deepEqual(missingEn, [], 'en 缺 key：' + missingEn.join(', '))
  })

  it('pk.* 键集双语齐全（新增 key 必须两边都加）', async () => {
    const core = await loadCore()
    const pkZh = Object.keys(core.zh).filter((key) => key.startsWith('pk.')).sort()
    const pkEn = Object.keys(core.en).filter((key) => key.startsWith('pk.')).sort()
    assert.deepEqual(pkEn, pkZh, 'zh / en 的 pk. key 集必须一致')
  })

  it('英文环境同样不空白', async () => {
    const { PickerModal, pickerShared } = await loadComponents()
    const core = await loadCore()
    const en = (key, params) => {
      const template = core.en[key] === undefined ? key : core.en[key]
      if (params === undefined) return template
      return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
    }
    const tree = PickerModal({ t: en, bus: pickerShared() })
    const strings = [...collectStrings(tree)].join(' | ')
    assert.match(strings, /Select from ima/u)
    assert.match(strings, /Knowledge bases/u)
    assert.match(strings, /Files/u)
  })
})

// ══════════════════════════════════════════════════════════════════
// 会话级选中集（PLATFORM §9.6）——本轮新增
// ══════════════════════════════════════════════════════════════════

/**
 * 按文本找按钮（「确定」「取消」等；树里按钮的文字在 children 上）。
 * @param {unknown} node - 元素树。
 * @param {string} label - 目标文案。
 * @returns {object|undefined} 命中的按钮元素。
 */
function findButtonByText(node, label) {
  const buttons = findByType(node, 'button')
  return buttons.find((button) => [...collectStrings(button.props.children)].includes(label))
}

describe('picker: 按会话读写选中集（§9.5 / §9.6）', () => {
  /** `/list` 按会话返回不同选中集（模拟宿主 §9.5 的会话级存储）。 */
  const BY_SESSION = {
    'session-1': {
      knowledgeBases: [{ id: 'kb-a', name: '库A' }, { id: 'kb-b', name: '库B' }],
      selected: ['kb-a'],
      status: { configured: true, tokenValid: true },
    },
    'session-2': {
      knowledgeBases: [{ id: 'kb-a', name: '库A' }, { id: 'kb-b', name: '库B' }],
      selected: ['kb-b'],
      status: { configured: true, tokenValid: true },
    },
  }

  it('打开模态 → POST /list 带 {sessionId}，初始勾选是该会话的选中集', async () => {
    const calls = []
    const { PickerModal, pickerShared, mount } = await loadLive({
      postJson: async (path, body) => {
        calls.push({ path, body })
        return BY_SESSION[body.sessionId] || BY_SESSION['session-1']
      },
    })
    const bus = pickerShared()
    bus.open('session-2')
    const view = await mount(PickerModal, { t: undefined, bus: bus, sessionId: 'session-2' })
    view.dispose()
    bus.close()

    assert.equal(calls.length, 1)
    assert.equal(calls[0].path, 'api/ima-knowledge/list')
    assert.deepEqual(calls[0].body, { sessionId: 'session-2' }, '/list 必须带本会话 id')

    const boxes = findCheckboxes(view.tree)
    assert.equal(boxes[0].props.checked, false, 'kb-a 不在 session-2 的选中集里')
    assert.equal(boxes[1].props.checked, true, 'kb-b 是 session-2 的选中集')
    assert.match(view.text(), /已选择 1 项/u)
  })

  it('确定 → POST /select 带 {sessionId, ids}，事件 detail 带 sessionId', async () => {
    const calls = []
    const events = []
    const originalWindow = globalThis.window
    globalThis.window = { dispatchEvent: (event) => { events.push(event); return true } }
    try {
      const { PickerModal, pickerShared, mount } = await loadLive({
        postJson: async (path, body) => {
          calls.push({ path, body })
          if (path === 'api/ima-knowledge/select') return { selected: body.ids, sessionId: body.sessionId }
          return BY_SESSION['session-1']
        },
      })
      const bus = pickerShared()
      bus.open('session-1')
      const view = await mount(PickerModal, { t: undefined, bus: bus, sessionId: 'session-1' })
      const confirm = findButtonByText(view.tree, '确定')
      assert.ok(confirm !== undefined, '必须有「确定」按钮')
      confirm.props.onClick()
      await new Promise((resolve) => { setImmediate(resolve) })
      view.dispose()
      bus.close()
      bus.clearToast()

      const select = calls.find((call) => call.path === 'api/ima-knowledge/select')
      assert.ok(select !== undefined, '必须发 /select')
      assert.deepEqual(select.body, { sessionId: 'session-1', ids: ['kb-a'] }, '/select 必须带 sessionId')

      const signal = events.find((event) => event.type === 'ima-kb-selection-changed')
      assert.ok(signal !== undefined, '必须派发刷新事件')
      assert.equal(signal.detail.sessionId, 'session-1', '事件必须带会话 id（否则所有会话一起刷）')
      assert.deepEqual(signal.detail.selected, ['kb-a'])
    } finally {
      if (originalWindow === undefined) delete globalThis.window
      else globalThis.window = originalWindow
    }
  })

  it('没有 sessionId 时退化为全局默认值（旧宿主兼容分支，body 不带该键）', async () => {
    const calls = []
    const { PickerModal, pickerShared, mount } = await loadLive({
      postJson: async (path, body) => {
        calls.push({ path, body })
        return BY_SESSION['session-1']
      },
    })
    const bus = pickerShared()
    bus.open(undefined)
    const view = await mount(PickerModal, { t: undefined, bus: bus })
    view.dispose()
    bus.close()

    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0].body, {}, '无会话时退化为全局默认值（兼容旧宿主）')
  })

  it('PickerOverlay 把会话 id 传给模态（总线记录的会话优先）', async () => {
    const { PickerOverlay, PickerModal, pickerShared } = await loadLive()
    const bus = pickerShared()
    bus.open('session-2')
    // overlay 只负责把会话身份传下去；模态自己的取数在上一组用例里已覆盖。
    const tree = PickerOverlay({ picker: bus, pickerT: undefined, pickerSessionId: 'session-2' })
    const children = tree.props.children
    const modal = (Array.isArray(children) ? children : [children])
      .find((node) => node !== null && node !== undefined && node.$$element === true && node.type === PickerModal)
    assert.ok(modal !== undefined, '打开态必须渲染 PickerModal')
    assert.equal(modal.props.sessionId, 'session-2', '会话 id 必须传到模态上')
    bus.close()
    bus.clearToast()
  })
})
