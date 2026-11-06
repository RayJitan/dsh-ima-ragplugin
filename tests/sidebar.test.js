/**
 * 侧边栏面板的纯逻辑单测（席位 client-sidebar 拥有）。
 *
 * `lib/client/20-sidebar.js` 是**片段**（会被拼进 lib/client.js 的 factory 函数体），
 * 不是模块，所以这里用 `new Function(src + 'return {...}')()` 在独立作用域里求值，
 * 只取出那些不依赖 React / DOM / 闭包状态的纯函数来断言。
 *
 * 组件渲染无法在 Node 里验证（需要 React + 浏览器），因此本文件的覆盖范围是
 * 「数据整形 + 筛选/计数/脏检查 + 掩码/账号降级链」这些真正会出错的地方。
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { describe, it } from 'node:test'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const FRAGMENT = join(root, 'lib', 'client', '20-sidebar.js')

/**
 * 在独立作用域里求值片段，取回纯函数。
 * 片段顶层只有函数声明与两个标量常量，求值不会触碰 DOM / React。
 * @returns {Promise<object>} 纯函数集合。
 */
async function loadPure() {
  const source = await readFile(FRAGMENT, 'utf8')
  const names = [
    'sbRecord',
    'sbTokenPhase',
    'sbMaskedLine',
    'sbAccountOf',
    'sbAccountText',
    'sbTranslate',
    'sbBases',
    'sbSelectedIds',
    'sbFilterBases',
    'sbMergeSelection',
    'sbSelectionDiff',
    'sbCanSubmit',
    'sbCredentialBody',
  ]
  // eslint-disable-next-line no-new-func
  const factory = new Function(`${source}\nreturn { ${names.join(', ')} };`)
  return factory()
}

/** 片段的「真机」文案表子集：key 未落盘时 t 返回 key 本身（10-core 的行为）。 */
const ZH = {
  'sb.accountLine': '已登录：{name}（{uid}）',
  'sb.accountUidOnly': '已登录：{uid}',
  'sb.accountUnknown': '已登录',
  'sb.maskedHint': '当前已保存：{value}',
}

/**
 * 造一个与 10-core `fallbackTranslate` 同语义的 t：命中就插值，未命中返回 key。
 * @param {object} dict - 文案表。
 * @returns {Function} t。
 */
function makeT(dict) {
  return (key, params) => {
    const template = dict[key] === undefined ? key : dict[key]
    if (params === undefined) return template
    return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
  }
}

describe('sidebar: 凭据状态 → 徽标四态', () => {
  it('loading / error / ready 三种 phase 分别落到 loading / unknown / 具体态', async () => {
    const { sbTokenPhase } = await loadPure()
    assert.equal(sbTokenPhase({ phase: 'loading' }), 'loading')
    assert.equal(sbTokenPhase({ phase: 'error' }), 'unknown')
    assert.equal(sbTokenPhase({ phase: 'ready', configured: false }), 'unconfigured')
    assert.equal(sbTokenPhase({ phase: 'ready', configured: true, tokenValid: true }), 'valid')
    assert.equal(sbTokenPhase({ phase: 'ready', configured: true, tokenValid: false }), 'expired')
  })

  it('configured 为真但 tokenValid 缺字段时是 unknown，不是 expired', async () => {
    const { sbTokenPhase } = await loadPure()
    assert.equal(sbTokenPhase({ phase: 'ready', configured: true }), 'unknown')
  })

  it('任何垃圾输入都不抛错（A10 不崩）', async () => {
    const { sbTokenPhase } = await loadPure()
    for (const bogus of [null, undefined, 0, 'x', [], {}, true]) {
      assert.doesNotThrow(() => sbTokenPhase(bogus))
    }
    assert.equal(sbTokenPhase(null), 'loading')
  })
})

describe('sidebar: 掩码行', () => {
  it('ready 且有 cookieMasked 时返回去空白的掩码', async () => {
    const { sbMaskedLine } = await loadPure()
    assert.equal(sbMaskedLine({ phase: 'ready', cookieMasked: '  IMA-TOKEN=abcd…wxyz  ' }), 'IMA-TOKEN=abcd…wxyz')
  })

  it('非 ready / 空串 / 非字符串一律 undefined（不渲染空行）', async () => {
    const { sbMaskedLine } = await loadPure()
    assert.equal(sbMaskedLine({ phase: 'loading', cookieMasked: 'x' }), undefined)
    assert.equal(sbMaskedLine({ phase: 'ready', cookieMasked: '   ' }), undefined)
    assert.equal(sbMaskedLine({ phase: 'ready', cookieMasked: 42 }), undefined)
    assert.equal(sbMaskedLine(null), undefined)
  })

  it('绝不返回完整 cookie：输入里没有 masked 字段就不产出任何内容', async () => {
    const { sbMaskedLine } = await loadPure()
    // 宿主只给 cookie（不该给）时，前端也不该把明文拿来显示。
    assert.equal(sbMaskedLine({ phase: 'ready', cookie: 'IMA-TOKEN=SECRET' }), undefined)
  })
})

describe('sidebar: 账号身份解析与降级链', () => {
  /** 真机形状（用户提供的 /credentials 返回）。 */
  const REAL = {
    open_info: {
      guid: '7497848186762231',
      nickname: '江河流殇',
      openid: 'oSfxO63xp6BFXRZ9jAIGEiqKWJmc',
      type: 2,
      uid: '001a9a23fd8033bb',
    },
  }

  it('完整 account → 昵称 + uid', async () => {
    const { sbAccountOf, sbAccountText } = await loadPure()
    const account = sbAccountOf({ phase: 'ready', account: { uid: '001a9a23fd8033bb', nickname: '江河流殇', guid: '7497848186762231', type: 2 } })
    assert.equal(account.uid, '001a9a23fd8033bb')
    assert.equal(account.nickname, '江河流殇')
    assert.equal(account.type, 2)
    assert.equal(sbAccountText(makeT(ZH), account, undefined), '已登录：江河流殇（001a9a23fd8033bb）')
  })

  it('缺 nickname → 只显示 uid', async () => {
    const { sbAccountOf, sbAccountText } = await loadPure()
    const account = sbAccountOf({ phase: 'ready', account: { uid: 'u-1' } })
    assert.equal(sbAccountText(makeT(ZH), account, undefined), '已登录：u-1')
  })

  it('只有 nickname 没有 uid → 用昵称占位，不伪造 uid', async () => {
    const { sbAccountOf, sbAccountText } = await loadPure()
    const account = sbAccountOf({ phase: 'ready', account: { nickname: '江河流殇' } })
    assert.equal(account.uid, undefined)
    assert.equal(sbAccountText(makeT(ZH), account, undefined), '已登录：江河流殇')
  })

  it('account 字段全空 → 退回掩码 cookie', async () => {
    const { sbAccountOf, sbAccountText } = await loadPure()
    const account = sbAccountOf({ phase: 'ready', account: {} })
    assert.equal(sbAccountText(makeT(ZH), account, 'IMA-TOKEN=abcd…wxyz'), '当前已保存：IMA-TOKEN=abcd…wxyz')
  })

  it('宿主没给 account → undefined（整行不渲染，绝不显示「未登录」）', async () => {
    const { sbAccountOf, sbAccountText } = await loadPure()
    const account = sbAccountOf({ phase: 'ready', cookieMasked: 'IMA-TOKEN=abcd…wxyz' })
    assert.equal(account, undefined)
    assert.equal(sbAccountText(makeT(ZH), account, 'IMA-TOKEN=abcd…wxyz'), undefined)
  })

  it('三个 account key 都未落盘时，降级到掩码而不是露出 sb.xxx 裸 key', async () => {
    const { sbAccountOf, sbAccountText } = await loadPure()
    const account = sbAccountOf({ phase: 'ready', account: { uid: 'u-1', nickname: 'n' } })
    const emptyDict = { 'sb.maskedHint': '当前已保存：{value}' }
    assert.equal(sbAccountText(makeT(emptyDict), account, 'MASK'), '当前已保存：MASK')
    // 连掩码都没有 → 用 sb.accountUnknown；它也没落盘 → undefined（宁可不渲染）
    assert.equal(sbAccountText(makeT(emptyDict), account, undefined), undefined)
  })

  it('account 字段类型垃圾（数组 / 字符串 / null）一律当作「没给」', async () => {
    const { sbAccountOf } = await loadPure()
    for (const bogus of [[], 'x', 0, null, true]) {
      assert.equal(sbAccountOf({ phase: 'ready', account: bogus }), undefined)
    }
  })

  it('真机 open_info 载荷不直接当 account 用（形状不同，不能误读）', async () => {
    const { sbAccountOf } = await loadPure()
    // 宿主负责把 open_info 映射成 account；前端只认 account 字段。
    assert.equal(sbAccountOf({ phase: 'ready', open_info: REAL.open_info }), undefined)
  })
})

describe('sidebar: 列表整形', () => {
  it('去重、剔除无 id 项、name 缺失时回落 id', async () => {
    const { sbBases } = await loadPure()
    const bases = sbBases({
      knowledgeBases: [
        { id: 'a', name: 'A' },
        { id: 'a', name: 'A-dup' },
        { id: '', name: 'no-id' },
        { name: 'only-name' },
        { id: 'b' },
        { id: 'c', name: '   ' },
      ],
    })
    assert.deepEqual(bases, [
      { id: 'a', name: 'A' },
      { id: 'b', name: 'b' },
      { id: 'c', name: 'c' },
    ])
  })

  it('非数组 / 缺字段 → 空列表，不抛错', async () => {
    const { sbBases } = await loadPure()
    assert.deepEqual(sbBases(null), [])
    assert.deepEqual(sbBases({}), [])
    assert.deepEqual(sbBases({ knowledgeBases: 'nope' }), [])
  })

  it('selected 去重保序并剔除空串', async () => {
    const { sbSelectedIds } = await loadPure()
    assert.deepEqual(sbSelectedIds({ selected: ['b', 'a', 'b', '', '  ', 'c'] }), ['b', 'a', 'c'])
    assert.deepEqual(sbSelectedIds({}), [])
    assert.deepEqual(sbSelectedIds(undefined), [])
  })
})

describe('sidebar: 筛选', () => {
  const bases = [
    { id: 'kb-001', name: 'Alpha 资料库' },
    { id: 'kb-002', name: 'Beta Notes' },
    { id: 'zzz-999', name: 'Gamma' },
  ]

  it('空查询返回全部（且是新数组，不改原列表）', async () => {
    const { sbFilterBases } = await loadPure()
    const out = sbFilterBases(bases, '   ')
    assert.equal(out.length, 3)
    assert.notEqual(out, bases)
    out.push({ id: 'x', name: 'x' })
    assert.equal(bases.length, 3)
  })

  it('按名称大小写无关匹配', async () => {
    const { sbFilterBases } = await loadPure()
    assert.deepEqual(sbFilterBases(bases, 'beta').map((item) => item.id), ['kb-002'])
    assert.deepEqual(sbFilterBases(bases, 'ALPHA').map((item) => item.id), ['kb-001'])
  })

  it('按 ID 匹配（前缀/中段都行）', async () => {
    const { sbFilterBases } = await loadPure()
    assert.deepEqual(sbFilterBases(bases, 'zzz').map((item) => item.id), ['zzz-999'])
    assert.deepEqual(sbFilterBases(bases, '002').map((item) => item.id), ['kb-002'])
  })

  it('无匹配 → 空数组（由 UI 显示「没有匹配」而不是空白面板）', async () => {
    const { sbFilterBases } = await loadPure()
    assert.deepEqual(sbFilterBases(bases, '没有这个'), [])
  })

  it('脏输入不抛错', async () => {
    const { sbFilterBases } = await loadPure()
    assert.deepEqual(sbFilterBases(null, 'x'), [])
    assert.deepEqual(sbFilterBases(bases, null).length, 3)
    assert.deepEqual(sbFilterBases([null, { id: 'k' }, 'x'], 'k').map((item) => item.id), ['k'])
  })
})

describe('sidebar: 全选并集与脏检查', () => {
  it('全选只并入筛选结果，保留筛选外的已选与顺序', async () => {
    const { sbMergeSelection } = await loadPure()
    assert.deepEqual(sbMergeSelection(['outside'], ['a', 'b']), ['outside', 'a', 'b'])
  })

  it('全选不产生重复项（幂等）', async () => {
    const { sbMergeSelection } = await loadPure()
    const once = sbMergeSelection(['a'], ['a', 'b'])
    assert.deepEqual(sbMergeSelection(once, ['a', 'b']), ['a', 'b'])
  })

  it('不修改传入数组', async () => {
    const { sbMergeSelection } = await loadPure()
    const current = ['a']
    sbMergeSelection(current, ['b'])
    assert.deepEqual(current, ['a'])
  })

  it('脏检查：新增 / 删除 / 顺序变化', async () => {
    const { sbSelectionDiff } = await loadPure()
    assert.deepEqual(sbSelectionDiff(['a'], ['a']), { dirty: false, added: [], removed: [] })
    assert.deepEqual(sbSelectionDiff(['a', 'b'], ['a']), { dirty: true, added: ['b'], removed: [] })
    assert.deepEqual(sbSelectionDiff(['a'], ['a', 'b']), { dirty: true, added: [], removed: ['b'] })
    // 只是顺序不同 → 集合语义下不算脏（保存的是集合，不是序列）
    assert.deepEqual(sbSelectionDiff(['b', 'a'], ['a', 'b']), { dirty: false, added: [], removed: [] })
  })

  it('脏检查对垃圾输入安全', async () => {
    const { sbSelectionDiff } = await loadPure()
    assert.deepEqual(sbSelectionDiff(null, null), { dirty: false, added: [], removed: [] })
  })
})

describe('sidebar: 凭据请求体', () => {
  it('cookie 空白时不可提交', async () => {
    const { sbCanSubmit } = await loadPure()
    assert.equal(sbCanSubmit(''), false)
    assert.equal(sbCanSubmit('   \n\t '), false)
    assert.equal(sbCanSubmit(null), false)
    assert.equal(sbCanSubmit('IMA-TOKEN=x'), true)
  })

  it('bkn 留空则不带该字段（宿主自动推导）', async () => {
    const { sbCredentialBody } = await loadPure()
    assert.deepEqual(sbCredentialBody('  IMA-TOKEN=x  ', '  '), { action: 'set', cookie: 'IMA-TOKEN=x' })
    assert.deepEqual(sbCredentialBody('IMA-TOKEN=x', ''), { action: 'set', cookie: 'IMA-TOKEN=x' })
  })

  it('bkn 有值则去空白后带上', async () => {
    const { sbCredentialBody } = await loadPure()
    assert.deepEqual(sbCredentialBody('IMA-TOKEN=x', '  bkn-123  '), {
      action: 'set',
      cookie: 'IMA-TOKEN=x',
      bkn: 'bkn-123',
    })
  })

  it('cookie 为空时返回 undefined（按钮应已置灰，这里再兜一层）', async () => {
    const { sbCredentialBody } = await loadPure()
    assert.equal(sbCredentialBody('', 'bkn'), undefined)
    assert.equal(sbCredentialBody(undefined, undefined), undefined)
  })
})

/**
 * 去掉注释再断言：文档里会**提到** `import` / `export` / `'use strict'` 这些词
 * （解释「为什么不能写」），裸正则会被自己的注释误伤。
 * @param {string} source - 片段全文。
 * @returns {string} 去注释后的代码。
 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, ' ')
    .replace(/(^|[^:\\])\/\/[^\n]*/gu, '$1 ')
}

describe('sidebar: 片段形态约束', () => {
  it('片段顶层不写 import/export/JSX/顶层 use strict（会被拼进 factory）', async () => {
    const code = stripComments(await readFile(FRAGMENT, 'utf8'))
    assert.doesNotMatch(code, /^\s*import\s/mu, '片段不得写 import')
    assert.doesNotMatch(code, /^\s*export\s/mu, '片段不得写 export')
    assert.doesNotMatch(code, /['"]use strict['"]/u, '片段不得写顶层 use strict')
    assert.doesNotMatch(code, /require\(\s*['"]@deepseek-ai\//u, '不得依赖 Harness Client 包')
    // 没有编译步骤：出现 JSX 形态（`h('div', ...)` 之外的 `<Tag>`）就是缺陷。
    assert.doesNotMatch(code, /<\/?[A-Z][A-Za-z0-9]*\s*\/?>/u, '片段不得写 JSX')
  })

  it('声明了三个对外入口', async () => {
    const source = await readFile(FRAGMENT, 'utf8')
    for (const name of ['registerSidebarPanel', 'ImaPanel', 'ImaSettingsCard']) {
      assert.match(source, new RegExp(`function ${name}\\(`, 'u'), `缺少 ${name}`)
    }
  })

  it('侧边栏 order 为 30（排在 XD Pool 的 20 下方）', async () => {
    const source = await readFile(FRAGMENT, 'utf8')
    assert.match(source, /order:\s*30/u)
  })
})

// ══════════════════════════════════════════════════════════════════
// 渲染冒烟（无浏览器：用最小 hook 运行时 + 真实字典跑组件函数）
// ══════════════════════════════════════════════════════════════════

/**
 * 最小 React 兼容层。
 *
 * 只实现 `ImaPanel` 用到的 `createElement` / `useState` / `useMemo` /
 * `useCallback` / `useEffect`，让组件函数真的被执行一遍：这样能抓到
 * 「渲染期抛错」「未定义变量」「空面板」这类语法检查抓不到的问题。
 *
 * `useState` 返回 `[initial, noop]`：测试只关心**首帧**（loading 态），
 * 异步 setState 后的分支由纯函数单测覆盖。
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
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useMemo: (factory) => factory(),
    useCallback: (fn) => fn,
    useEffect: () => {},
  }
}

/**
 * 展开一个元素：字符串类型直接取 children，函数类型（自绘子组件）**真的调用一次**。
 *
 * 这一步很关键——它让 `SbStatusBadge` / `SbToolbar` / `SbListBody` 这些子组件
 * 也真的执行，从而抓到它们内部的渲染期错误。
 * @param {object} element - `$$element` 标记的元素。
 * @param {number} depth - 递归深度（防自引用死循环）。
 * @returns {unknown} 展开后的 children。
 */
function expand(element, depth = 0) {
  if (depth > 24) return ''
  const children = element.props.children
  if (typeof element.type === 'function') {
    // 函数组件：用同一套 props 调一次，取它的返回值继续展开。
    const rendered = element.type(element.props)
    return expandNode(rendered, depth + 1)
  }
  return expandNode(children, depth + 1)
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
 * 把「函数组件元素」解析到**宿主元素**（type 为字符串）为止，返回那个元素本身。
 *
 * 与 {@link expand} 的区别：`expand` 返回的是 children（用于取文本），
 * 这里要的是元素自己（用于断言它的 props/style）。
 * @param {object} element - `$$element` 标记的元素。
 * @param {number} [depth] - 递归深度。
 * @returns {object|undefined} 宿主元素。
 */
function renderRoot(element, depth = 0) {
  if (depth > 24 || element === null || element === undefined || element.$$element !== true) return undefined
  if (typeof element.type === 'string') return element
  return renderRoot(element.type(element.props), depth + 1)
}

/**
 * 把元素树拍平成纯文本（用于断言「面板不是空白」）。
 * @param {unknown} node - React 元素 / 数组 / 标量。
 * @returns {string} 文本。
 */
function textOf(node) {
  const walk = (current) => {
    if (current === null || current === undefined || typeof current === 'boolean') return ''
    if (typeof current === 'string' || typeof current === 'number') return String(current)
    if (Array.isArray(current)) return current.map(walk).join(' ')
    if (current.$$element === true) return walk(expand(current))
    return ''
  }
  return walk(node)
}

/**
 * 递归收集元素树里出现的全部字符串（含 props 里的 title / aria-label）。
 * 函数组件会被展开，因此子组件内部的文案也在收集范围内。
 * @param {unknown} node - React 元素。
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
 * 载入片段并注入伪 React / 闭包依赖，返回可渲染的组件集合。
 *
 * 这里刻意注入 **10-core 真实的 zh 字典与 S 样式对象**（不是桩），
 * 这样 key 拼错、样式字段缺失都能在测试里暴露。
 * @param {object} [overrides] - 覆盖项（例如 fake postJson）。
 * @returns {Promise<{ImaPanel:Function, ImaSettingsCard:Function, SbIcon:Function, registerSidebarPanel:Function, strings:Set<string>}>} 组件。
 */
async function loadComponents(overrides = {}) {
  const fragment = await readFile(FRAGMENT, 'utf8')
  const core = await readFile(join(root, 'lib', 'client', '10-core.js'), 'utf8')

  // 从 10-core 里取出真实的 zh / en / S / fallbackTranslate（只求值数据与纯函数部分）。
  // eslint-disable-next-line no-new-func
  const coreExports = new Function(`${core}\nreturn { zh, en, S, fallbackTranslate };`)()

  const React = makeFakeReact()
  const h = React.createElement
  const t = (key, params) => {
    const template = coreExports.zh[key] === undefined ? key : coreExports.zh[key]
    if (params === undefined) return template
    return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
  }
  const noop = () => {}
  const env = {
    React,
    h,
    t,
    S: coreExports.S,
    zh: coreExports.zh,
    en: coreExports.en,
    ROUTES: {
      list: 'api/ima-knowledge/list',
      select: 'api/ima-knowledge/select',
      status: 'api/ima-knowledge/status',
      credentials: 'api/ima-knowledge/credentials',
      media: 'api/ima-knowledge/media',
      // v5：检索条数设置（面板挂载时会读一次）。
      settings: 'api/ima-knowledge/settings',
    },
    postJson: overrides.postJson || (async () => ({})),
    HostFailure: (kind, message, code) => Object.assign(new Error(message), { kind, code }),
    failureOf: (cause) => ({ kind: 'unknown', detail: String(cause && cause.message ? cause.message : cause) }),
    failureText: (tr, failure) => failure.detail,
    errorText: (error) => (typeof error === 'string' ? error : undefined),
    isId: (value) => typeof value === 'string' && value.trim() !== '',
    normalizeBase: (entry) => entry,
    PACKAGE_NAME: 'dsh-ima-ragplugin',
    NS: 'imaKnowledge',
    fallbackTranslate: coreExports.fallbackTranslate,
  }

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
    `${fragment}\nreturn { ImaPanel, ImaSettingsCard, SbIcon, registerSidebarPanel };`,
  )
  const out = factory(
    React, h, env.S, env.t, env.ROUTES, env.postJson, env.HostFailure,
    env.failureOf, env.failureText, env.errorText, env.isId, env.normalizeBase,
    env.fallbackTranslate,
  )
  return out
}

describe('sidebar: 渲染冒烟（伪 React，无浏览器）', () => {
  it('ImaPanel 首帧渲染不抛错，且不是空白面板', async () => {
    const { ImaPanel } = await loadComponents()
    let tree
    assert.doesNotThrow(() => { tree = ImaPanel({ t: undefined, variant: 'page' }) })
    const strings = collectStrings(tree)
    const joined = [...strings].join(' | ')
    // 页头 + 两个分区标题必须出现（A10：未配置时也不能空白）。
    assert.match(joined, /IMA 知识库/u)
    assert.match(joined, /登录授权/u)
    assert.match(joined, /知识库/u)
    // 授权表单控件必须在
    assert.ok([...strings].some((text) => text.includes('x-ima-cookie')), '缺少 cookie 输入标签')
    // v5：检索条数设置区必须在（默认 10，范围 1-100）。
    assert.match(joined, /检索设置/u)
    assert.match(joined, /检索条数/u)
    assert.match(joined, /1-100/u)
  })

  it('variant=settings 与 page 都渲染同一个面板（薄包装不漂移）', async () => {
    const { ImaPanel, ImaSettingsCard } = await loadComponents()
    const page = renderRoot(ImaPanel({ t: undefined, variant: 'page' }))
    // ImaSettingsCard 返回 `h(ImaPanel, {...})`，要解析一层才是真正的根节点。
    const card = renderRoot(ImaSettingsCard({ t: undefined }))
    assert.ok(page !== undefined && card !== undefined, '两个变体都必须渲染出宿主元素')
    assert.equal(textOf(page), textOf(card))
    // 外层滚动容器不同：整页自带滚动，设置卡不套（对话框已提供滚动与内边距）。
    assert.equal(page.props.style.flex, '1 1 auto')
    assert.equal(page.props.style.overflowY, 'auto')
    assert.equal(card.props.style.flex, undefined)
    assert.equal(card.props.style.overflowY, undefined)
    // 内层内容容器一致（同一套间距语言，只是设置卡去掉外层 padding / 宽度上限）。
    const pageInner = page.props.children
    const cardInner = card.props.children
    assert.equal(pageInner.props['data-ima-panel'], 'page')
    assert.equal(cardInner.props['data-ima-panel'], 'settings')
    assert.equal(cardInner.props.style.maxWidth, 'none')
    assert.equal(cardInner.props.style.padding, '0')
    assert.equal(pageInner.props.style.maxWidth, '860px')
  })

  it('SbIcon 输出纯 SVG + currentColor，尺寸跟随 size', async () => {
    const { SbIcon } = await loadComponents()
    const icon = SbIcon({ size: 18, active: true })
    assert.equal(icon.type, 'svg')
    assert.equal(icon.props.width, 18)
    assert.equal(icon.props.height, 18)
    assert.equal(icon.props['aria-hidden'], 'true')
    const svgText = JSON.stringify(icon)
    assert.match(svgText, /currentColor/u)
    // 无 size / 非法 size → 回落 16，不抛错。
    assert.equal(SbIcon({}).props.width, 16)
    assert.equal(SbIcon({ size: -3 }).props.width, 16)
    assert.equal(SbIcon({ size: 'big' }).props.width, 16)
  })

  it('registerSidebarPanel 注册了 panellist(order 30) 与 main(key ima-knowledge)', async () => {
    const { registerSidebarPanel } = await loadComponents()
    const calls = []
    const ctx = {
      slots: {
        inject: (name, install) => { calls.push({ kind: 'inject', name }); install() },
        register: (options, component) => { calls.push({ kind: 'register', options, component }); return () => {} },
      },
    }
    assert.doesNotThrow(() => registerSidebarPanel(ctx, { t: (key) => key }))
    const injects = calls.filter((call) => call.kind === 'inject').map((call) => call.name)
    assert.deepEqual(injects, ['sidebar.panellist', 'main'])
    const registers = calls.filter((call) => call.kind === 'register')
    const panel = registers.find((call) => call.options.name === 'sidebar.panellist')
    assert.equal(panel.options.id, 'ima-knowledge')
    assert.equal(panel.options.order, 30)
    assert.equal(panel.options.label(), 'navLabel')
    const main = registers.find((call) => call.options.name === 'main')
    assert.equal(main.options.key, 'ima-knowledge')
  })

  it('slots 缺失时 registerSidebarPanel 不抛错（席位失败不拖垮插件）', async () => {
    const { registerSidebarPanel } = await loadComponents()
    assert.doesNotThrow(() => registerSidebarPanel({}, { t: (key) => key }))
    assert.doesNotThrow(() => registerSidebarPanel({ slots: {} }, { t: (key) => key }))
  })

  it('英文环境同样不空白（双语 key 集完整）', async () => {
    const { ImaPanel } = await loadComponents()
    const tree = ImaPanel({ t: (key) => `[${key}]`, variant: 'page' })
    const strings = collectStrings(tree)
    // 用 `t = key 包裹` 的形式能直接看出哪些 key 被用到、哪些没被解析。
    assert.ok([...strings].some((text) => text.includes('[sb.authTitle]')), '缺少授权区标题 key')
    assert.ok([...strings].some((text) => text.includes('[sb.verifyAndSave]')), '缺少保存按钮 key')
    assert.ok([...strings].some((text) => text.includes('[sb.clearCredentials]')), '缺少清除按钮 key')
  })
})

describe('sidebar: locale key 完整性', () => {
  /**
   * 已知「本席位已用、但 10-core 尚未落盘」的 key。
   *
   * Lead 已在 10-core 补上 `sb.accountLine` / `sb.accountUidOnly` /
   * `sb.accountUnknown`，因此白名单现在是**空**的：缺任何 key 都直接红。
   * 保留这个机制是为了下次「先写 UI、后补字典」时仍可登记待办，而不是
   * 把整条断言删掉。
   * 注意：代码里对这些 key 都做了降级（{@link sbTranslate} 未命中即回落），
   * 所以即使白名单里有待补项，UI 也不会露出裸 key。
   */
  const PENDING_KEYS = new Set([])

  it('片段里 t(...) 用到的每个 key 都在 zh / en 字典里（或已登记为待补）', async () => {
    const source = await readFile(FRAGMENT, 'utf8')
    const core = await readFile(join(root, 'lib', 'client', '10-core.js'), 'utf8')
    // eslint-disable-next-line no-new-func
    const { zh, en } = new Function(`${core}\nreturn { zh, en };`)()

    // 只取字符串字面量 key：动态拼接的 key 不在此列（本片段没有动态 key）。
    const used = new Set()
    for (const match of source.matchAll(/\bt\(\s*'([^']+)'/gu)) used.add(match[1])
    assert.ok(used.size > 10, `应解析出多个 key，实际 ${used.size}`)

    const missingZh = [...used].filter((key) => !(key in zh) && !PENDING_KEYS.has(key))
    const missingEn = [...used].filter((key) => !(key in en) && !PENDING_KEYS.has(key))
    assert.deepEqual(missingZh, [], 'zh 缺 key：' + missingZh.join(', '))
    assert.deepEqual(missingEn, [], 'en 缺 key：' + missingEn.join(', '))
  })

  it('zh / en 的 sb. 键集一致（新增 key 必须双语齐全）', async () => {
    const core = await readFile(join(root, 'lib', 'client', '10-core.js'), 'utf8')
    // eslint-disable-next-line no-new-func
    const { zh, en } = new Function(`${core}\nreturn { zh, en };`)()
    const sbZh = Object.keys(zh).filter((key) => key.startsWith('sb.')).sort()
    const sbEn = Object.keys(en).filter((key) => key.startsWith('sb.')).sort()
    assert.deepEqual(sbEn, sbZh, 'zh / en 的 sb. key 集必须一致')
  })

  it('降级链在 key 缺失时不会把裸 key 漏到 UI', async () => {
    const { sbAccountOf, sbAccountText } = await loadPure()
    const account = sbAccountOf({ account: { uid: 'u-1', nickname: 'n-1' } })
    // 完全空的字典：所有 sb.* key 都未命中。
    const missing = sbAccountText((key) => key, account, undefined)
    assert.equal(missing, undefined, '无任何可用 key 时应返回 undefined（不渲染），而不是裸 key')
  })
})

// ══════════════════════════════════════════════════════════════════
// PLATFORM.md §8.3：一键同步桌面客户端凭据（probe / sync / 折叠）
// ══════════════════════════════════════════════════════════════════

describe('sidebar: desktop-sync probe 四分支状态推导', () => {
  /**
   * 取本席位新增的同步纯函数。
   * @returns {Promise<object>} 纯函数集合。
   */
  async function loadSync() {
    const source = await readFile(FRAGMENT, 'utf8')
    const names = ['sbProbeState', 'sbSyncButton', 'sbSyncHint', 'sbManualOpen', 'sbSyncResult', 'sbAvatarUrl', 'sbT']
    // eslint-disable-next-line no-new-func
    return new Function(`${source}\nreturn { ${names.join(', ')} };`)()
  }

  it('分支一：available && isLogin → ready，主按钮可点，副文案带 nickname', async () => {
    const { sbProbeState, sbSyncButton, sbSyncHint } = await loadSync()
    const state = sbProbeState({
      available: true, isLogin: true, userId: '001a9a23fd8033bb',
      nickname: '江河流殇', avatarUrl: '', tokenExpired: false, refreshExpired: false,
    })
    assert.equal(state.mode, 'ready')
    assert.equal(state.available, true)
    assert.equal(state.isLogin, true)
    assert.equal(state.nickname, '江河流殇')
    assert.equal(state.userId, '001a9a23fd8033bb')
    // 空串 avatarUrl 视为「没有」
    assert.equal(state.avatarUrl, undefined)
    assert.deepEqual(sbSyncButton(state), { visible: true, enabled: true })
    assert.deepEqual(sbSyncHint(state), { key: 'sb.syncHint', params: { name: '江河流殇' } })
  })

  it('分支二：available && !isLogin → notLogin，主按钮可点，副文案提示先登录客户端', async () => {
    const { sbProbeState, sbSyncButton, sbSyncHint } = await loadSync()
    const state = sbProbeState({ available: true, isLogin: false, reason: '客户端未登录' })
    assert.equal(state.mode, 'notLogin')
    assert.equal(state.isLogin, false)
    assert.deepEqual(sbSyncButton(state), { visible: true, enabled: true })
    assert.deepEqual(sbSyncHint(state), { key: 'sb.syncNotLogin' })
  })

  it('分支三：!available → unavailable，主按钮隐藏，显示 reason', async () => {
    const { sbProbeState, sbSyncButton } = await loadSync()
    const state = sbProbeState({ available: false, isLogin: false, reason: '仅支持 Windows 上的 IMA 桌面客户端' })
    assert.equal(state.mode, 'unavailable')
    assert.equal(state.reason, '仅支持 Windows 上的 IMA 桌面客户端')
    assert.deepEqual(sbSyncButton(state), { visible: false, enabled: false })
  })

  it('分支四：probe 请求本身失败 → failed，与 unavailable 同样隐藏主按钮', async () => {
    const { sbProbeState, sbSyncButton } = await loadSync()
    const state = sbProbeState(undefined, { kind: 'network', detail: 'fetch failed' })
    assert.equal(state.mode, 'failed')
    assert.equal(state.available, false)
    assert.equal(state.failure.detail, 'fetch failed')
    assert.deepEqual(sbSyncButton(state), { visible: false, enabled: false })
  })

  it('available 缺字段 / 非布尔真值 → 一律按不可用处理（不乐观猜测）', async () => {
    const { sbProbeState } = await loadSync()
    for (const bogus of [null, undefined, {}, { available: 'yes' }, { available: 1, isLogin: true }]) {
      assert.equal(sbProbeState(bogus).mode, 'unavailable')
    }
    // available 为真但 isLogin 缺字段 → notLogin（不是 ready）
    assert.equal(sbProbeState({ available: true }).mode, 'notLogin')
  })

  it('loading 首帧：按钮可见但置灰（不显示「未安装」的错误态）', async () => {
    const { sbSyncButton, sbSyncHint } = await loadSync()
    assert.deepEqual(sbSyncButton({ mode: 'loading' }), { visible: true, enabled: false })
    assert.equal(sbSyncHint({ mode: 'loading' }), null)
  })
})

describe('sidebar: desktop-sync 手动填写区折叠默认值', () => {
  /**
   * 取折叠推导函数。
   * @returns {Promise<Function>} sbManualOpen。
   */
  async function loadOpen() {
    const source = await readFile(FRAGMENT, 'utf8')
    // eslint-disable-next-line no-new-func
    return new Function(`${source}\nreturn { sbManualOpen };`)().sbManualOpen
  }

  it('默认折叠：ready / notLogin / loading 都不展开手动区', async () => {
    const sbManualOpen = await loadOpen()
    assert.equal(sbManualOpen({ mode: 'ready' }), false)
    assert.equal(sbManualOpen({ mode: 'notLogin' }), false)
    assert.equal(sbManualOpen({ mode: 'loading' }), false)
  })

  it('主路径不可用时直接展开：unavailable / failed', async () => {
    const sbManualOpen = await loadOpen()
    assert.equal(sbManualOpen({ mode: 'unavailable' }), true)
    assert.equal(sbManualOpen({ mode: 'failed' }), true)
  })

  it('垃圾输入不抛错，且按「不展开」处理', async () => {
    const sbManualOpen = await loadOpen()
    for (const bogus of [null, undefined, 'x', 0, []]) {
      assert.doesNotThrow(() => sbManualOpen(bogus))
      assert.equal(sbManualOpen(bogus), false)
    }
  })
})

describe('sidebar: desktop-sync sync 成功/失败状态机', () => {
  /**
   * 取 sync 结果判定函数。
   * @returns {Promise<Function>} sbSyncResult。
   */
  async function loadResult() {
    const source = await readFile(FRAGMENT, 'utf8')
    // eslint-disable-next-line no-new-func
    return new Function(`${source}\nreturn { sbSyncResult };`)().sbSyncResult
  }

  it('tokenValid:true → ok，带回 account（身份行据此刷新）', async () => {
    const sbSyncResult = await loadResult()
    const result = sbSyncResult({
      configured: true, tokenValid: true,
      account: { uid: '001a9a23fd8033bb', nickname: '江河流殇' },
    })
    assert.equal(result.ok, true)
    assert.equal(result.error, undefined)
    assert.equal(result.account.uid, '001a9a23fd8033bb')
    assert.equal(result.account.nickname, '江河流殇')
  })

  it('tokenValid:false → 失败并原样带回 error（不假装成功）', async () => {
    const sbSyncResult = await loadResult()
    const result = sbSyncResult({ configured: true, tokenValid: false, error: 'token 已失效且无法刷新' })
    assert.equal(result.ok, false)
    assert.equal(result.error, 'token 已失效且无法刷新')
  })

  it('tokenValid 缺字段 / 非 true 一律不算成功', async () => {
    const sbSyncResult = await loadResult()
    assert.equal(sbSyncResult({}).ok, false)
    assert.equal(sbSyncResult({ tokenValid: 'true' }).ok, false)
    assert.equal(sbSyncResult({ tokenValid: 1 }).ok, false)
    assert.equal(sbSyncResult(null).ok, false)
    assert.equal(sbSyncResult(undefined).ok, false)
  })

  it('error 是 {code,message} 对象时也取出可展示文案', async () => {
    const sbSyncResult = await loadResult()
    const result = sbSyncResult({ tokenValid: false, error: { code: 'DPAPI', message: '解密失败' } })
    assert.equal(result.ok, false)
    assert.equal(result.error, '解密失败')
  })

  it('失败时仍解析 account（宿主可能解出了身份但校验没过）', async () => {
    const sbSyncResult = await loadResult()
    const result = sbSyncResult({ tokenValid: false, error: 'x', account: { uid: 'u-1' } })
    assert.equal(result.account.uid, 'u-1')
  })
})

describe('sidebar: 头像 URL 白名单', () => {
  /**
   * 取 sbAvatarUrl。
   * @returns {Promise<Function>} sbAvatarUrl。
   */
  async function loadAvatar() {
    const source = await readFile(FRAGMENT, 'utf8')
    // eslint-disable-next-line no-new-func
    return new Function(`${source}\nreturn { sbAvatarUrl };`)().sbAvatarUrl
  }

  it('放行 http(s) 与 data:image', async () => {
    const sbAvatarUrl = await loadAvatar()
    assert.equal(sbAvatarUrl('https://example.com/a.png'), 'https://example.com/a.png')
    assert.equal(sbAvatarUrl('  http://x/y.png  '), 'http://x/y.png')
    assert.equal(sbAvatarUrl('data:image/png;base64,AAA'), 'data:image/png;base64,AAA')
  })

  it('挡掉 javascript: / 空串 / 非字符串', async () => {
    const sbAvatarUrl = await loadAvatar()
    for (const bogus of ['javascript:alert(1)', 'file:///c:/x.png', '', '   ', null, 42, {}, []]) {
      assert.equal(sbAvatarUrl(bogus), undefined)
    }
  })
})

describe('sidebar: 新 locale key 的内嵌兜底', () => {
  const REQUIRED = [
    'sb.syncTitle', 'sb.syncHint', 'sb.syncing', 'sb.syncOk',
    'sb.syncFailed', 'sb.syncNotLogin', 'sb.manualToggle', 'sb.probeFailed',
    // v5：检索条数设置。
    'sb.limitTitle', 'sb.limitHint', 'sb.limitLabel', 'sb.limitCurrent',
    'sb.limitInvalid', 'sb.limitSave', 'sb.limitSaved', 'sb.limitSaveFailed', 'sb.limitLoadFailed',
  ]

  it('新增 key 都有内嵌兜底值（字典未落盘也不露裸 key）', async () => {
    const source = await readFile(FRAGMENT, 'utf8')
    // eslint-disable-next-line no-new-func
    const { SB_LOCALE_FALLBACK, sbT } = new Function(`${source}\nreturn { SB_LOCALE_FALLBACK, sbT };`)()
    for (const key of REQUIRED) {
      assert.equal(typeof SB_LOCALE_FALLBACK[key], 'string', '缺少兜底：' + key)
      assert.notEqual(SB_LOCALE_FALLBACK[key].trim(), '', '兜底为空：' + key)
      // t 完全未命中（返回 key 本身）时也要给出人话
      assert.notEqual(sbT((key2) => key2, key), key, key + ' 会漏裸 key')
    }
  })

  it('内嵌兜底支持 {msg} 插值', async () => {
    const source = await readFile(FRAGMENT, 'utf8')
    // eslint-disable-next-line no-new-func
    const { sbT } = new Function(`${source}\nreturn { sbT };`)()
    assert.equal(sbT((key) => key, 'sb.syncFailed', { msg: '解密失败' }), '同步失败：解密失败')
    assert.equal(sbT((key) => key, 'sb.probeFailed', { msg: '仅 Windows' }), '无法检测 IMA 桌面客户端：仅 Windows')
  })

  it('字典已落盘时优先用注入的 t（切语言能生效）', async () => {
    const source = await readFile(FRAGMENT, 'utf8')
    // eslint-disable-next-line no-new-func
    const { sbT } = new Function(`${source}\nreturn { sbT };`)()
    const t = (key) => (key === 'sb.syncTitle' ? 'Sync from IMA desktop' : key)
    assert.equal(sbT(t, 'sb.syncTitle'), 'Sync from IMA desktop')
  })
})

describe('sidebar: 同步路由与主路径渲染冒烟', () => {
  it('局部常量指向 PLATFORM §8.2 的 desktop-sync 路由', async () => {
    const source = await readFile(FRAGMENT, 'utf8')
    assert.match(source, /const ROUTE_DESKTOP_SYNC = 'api\/ima-knowledge\/desktop-sync'/u)
  })

  it('首帧渲染出「从 IMA 桌面客户端同步」主按钮与折叠的手动填写区', async () => {
    const { ImaPanel } = await loadComponents()
    const strings = collectStrings(ImaPanel({ t: undefined, variant: 'page' }))
    const joined = [...strings].join(' | ')
    assert.match(joined, /从 IMA 桌面客户端同步/u, '缺少主按钮文案')
    assert.match(joined, /手动填写/u, '缺少手动填写折叠开关')
  })

  it('手动填写区首帧为 closed（默认折叠）', async () => {
    const { ImaPanel } = await loadComponents()
    const tree = ImaPanel({ t: undefined, variant: 'page' })
    // 首帧 probe 是 loading → sbManualOpen 返回 false（默认折叠）。
    assert.match(JSON.stringify(tree), /"open":false/u, '首帧手动区必须是折叠态')
    // 真正渲染 SbManualSection 一次，确认折叠标记落到宿主 DOM 属性上。
    const find = (node) => {
      if (node === null || typeof node !== 'object') return undefined
      if (Array.isArray(node)) {
        for (const child of node) {
          const hit = find(child)
          if (hit !== undefined) return hit
        }
        return undefined
      }
      if (node.$$element !== true) return undefined
      if (node.props && node.props.key === 'manual') return node
      return find(node.props.children)
    }
    const manual = find(tree)
    assert.ok(manual !== undefined, '没有渲染出手动填写区')
    assert.equal(manual.props.open, false)
    // 只断言关键事实（折叠标记 + 折叠态），不绑定子节点下标顺序。
    const rendered = manual.type(manual.props)
    assert.equal(rendered.props['data-ima-manual'], 'closed')
    const flat = JSON.stringify(rendered)
    assert.match(flat, /"aria-expanded":"false"/u, '折叠开关必须报 aria-expanded=false')
    assert.match(flat, /"hidden":true/u, '折叠时内容容器必须 hidden')
  })
})

// ══════════════════════════════════════════════════════════════════
// 「默认值」语义（PLATFORM §9.6）——本轮新增
// ══════════════════════════════════════════════════════════════════

/**
 * 带状态运行时：让侧边栏面板真的跑 effect / 重渲染，才能断言「保存时发了什么请求」。
 * 只实现片段用到的钩子（useState / useEffect / useMemo / useCallback / useRef）。
 * @returns {object} `{React, h, mount}`。
 */
function makeLiveReact() {
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
    slots[index] = { kind: 'effect', deps, dispose: previous === undefined ? undefined : previous.dispose }
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
   * 挂载并跑到稳定态。
   * @param {Function} Component - 组件。
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
      if (dirty) { tree = render(); return true }
      return false
    }
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
      text: () => [...collectText(tree)].join(' | '),
      rerender: async () => { tree = render(); await settle(); return tree },
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

/** 递归收集文本。 */
function collectText(node, out = []) {
  if (node === null || node === undefined) return out
  if (typeof node === 'string') { out.push(node); return out }
  if (typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const child of node) collectText(child, out); return out }
  if (node.$$element !== true) return out
  if (typeof node.type === 'function') return collectText(node.type(node.props), out)
  return collectText(node.props.children, out)
}

/** 按标签名递归收集元素。 */
function findAll(node, type, out = []) {
  const walk = (current) => {
    if (current === null || current === undefined) return
    if (Array.isArray(current)) { for (const child of current) walk(child); return }
    if (current.$$element !== true) return
    if (current.type === type) { out.push(current); walk(current.props.children); return }
    if (typeof current.type === 'function') { walk(current.type(current.props)); return }
    walk(current.props.children)
  }
  walk(node)
  return out
}

/**
 * 用带状态运行时求值片段，返回能真跑副作用的面板。
 * @param {object} [overrides] - `{postJson}`。
 * @returns {Promise<object>} `{ImaPanel, mount, events, core}`。
 */
async function loadPanelLive(overrides = {}) {
  const fragment = await readFile(FRAGMENT, 'utf8')
  const core = await readFile(join(root, 'lib', 'client', '10-core.js'), 'utf8')
  // eslint-disable-next-line no-new-func
  const coreExports = new Function(`${core}\nreturn { zh, en, S, fallbackTranslate };`)()
  const live = makeLiveReact()
  const events = []
  const windowStub = {
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: (event) => { events.push(event); return true },
  }
  class CustomEventStub {
    constructor(type, init) {
      this.type = type
      this.detail = init === undefined ? undefined : init.detail
    }
  }
  const t = (key, params) => {
    const template = coreExports.zh[key] === undefined ? key : coreExports.zh[key]
    if (params === undefined) return template
    return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
  }
  // eslint-disable-next-line no-new-func
  const factory = new Function(
    'React', 'h', 'S', 't', 'ROUTES', 'postJson', 'HostFailure', 'failureOf',
    'failureText', 'errorText', 'isId', 'normalizeBase', 'fallbackTranslate',
    'window', 'document', 'console', 'CustomEvent',
    `${fragment}\nreturn { ImaPanel, ImaSettingsCard, SbIcon, registerSidebarPanel, SB_LOCALE_FALLBACK, sbT };`,
  )
  const out = factory(
    live.React,
    live.h,
    coreExports.S,
    t,
    {
      list: 'api/ima-knowledge/list',
      select: 'api/ima-knowledge/select',
      status: 'api/ima-knowledge/status',
      credentials: 'api/ima-knowledge/credentials',
      media: 'api/ima-knowledge/media',
      // v5：检索条数设置（面板挂载时会读一次）。
      settings: 'api/ima-knowledge/settings',
    },
    overrides.postJson || (async () => ({})),
    (kind, message, code) => Object.assign(new Error(message), { kind, code }),
    (cause) => ({ kind: 'unknown', detail: String(cause && cause.message ? cause.message : cause) }),
    (tr, failure) => failure.detail,
    (error) => (typeof error === 'string' ? error : undefined),
    (value) => typeof value === 'string' && value.trim() !== '',
    (entry) => entry,
    coreExports.fallbackTranslate,
    windowStub,
    { addEventListener: () => {}, removeEventListener: () => {}, visibilityState: 'visible' },
    { warn: () => {}, error: () => {} },
    CustomEventStub,
  )
  return Object.assign({ mount: live.mount, events, core: coreExports }, out)
}

describe('sidebar: 「默认值」语义（§9.6）', () => {
  /** `/list` 与 `/status` 的正常返回。 */
  const LIST = {
    knowledgeBases: [{ id: 'kb-a', name: '库A' }, { id: 'kb-b', name: '库B' }],
    selected: ['kb-a'],
    status: { configured: true, tokenValid: true },
  }
  const CREDS = { configured: true, hasCookie: true, hasBkn: true, cookieMasked: 'IMA-TOKEN=ab…yz' }

  /**
   * 跑一次「挂载 → 点保存」。
   * @returns {Promise<{calls:Array, events:Array, view:object}>} 观测结果。
   */
  async function mountAndSave() {
    const calls = []
    const loaded = await loadPanelLive({
      postJson: async (path, body) => {
        calls.push({ path, body })
        if (path === 'api/ima-knowledge/select') return { selected: body.ids }
        if (path === 'api/ima-knowledge/credentials') return CREDS
        if (path === 'api/ima-knowledge/desktop-sync') return { available: true, isLogin: true }
        return LIST
      },
    })
    const view = await loaded.mount(loaded.ImaPanel, { t: undefined })
    const save = findAll(view.tree, 'button').find((button) => [...collectText(button.props.children)].includes('保存'))
    assert.ok(save !== undefined, '面板必须有「保存」按钮')
    save.props.onClick()
    await new Promise((resolve) => { setImmediate(resolve) })
    return { calls, events: loaded.events, view, loaded }
  }

  it('保存不带 sessionId（写全局默认值）', async () => {
    const { calls, view } = await mountAndSave()
    const select = calls.find((call) => call.path === 'api/ima-knowledge/select')
    assert.ok(select !== undefined, '保存必须发 /select')
    assert.deepEqual(select.body, { ids: ['kb-a'] }, '侧边栏写默认值 → body 不得带 sessionId')
    assert.equal('sessionId' in select.body, false)
    view.dispose()
  })

  it('保存派发的事件 sessionId 为 null（chip 栏据此不响应）', async () => {
    const { events, view } = await mountAndSave()
    const signal = events.find((event) => event.type === 'ima-kb-selection-changed')
    assert.ok(signal !== undefined, '保存后必须派发事件')
    assert.equal(signal.detail.sessionId, null, '全局默认值 → sessionId 必须是 null')
    assert.deepEqual(signal.detail.selected, ['kb-a'])
    view.dispose()
  })

  it('面板文案说明「这是新会话的默认知识库」（不再是「勾选要接入会话的库」）', async () => {
    const { view } = await mountAndSave()
    const text = view.text()
    assert.match(text, /新会话的默认知识库/u, '必须说清是默认值语义')
    // 第三轮：chip 栏从「聊天框上方」挪进「聊天框里（文字上方）」，文案必须跟着改。
    assert.match(text, /聊天框里/u, '必须指向单会话的调整位置（聊天框里）')
    assert.match(text, /文字上方/u, '必须说清 chip 栏在文字上方')
    assert.equal(/勾选要接入会话的知识库/u.test(text), false, '旧文案（暗示直接作用于会话）必须消失')
    view.dispose()
  })

  it('sb.kbHintDefault 有内嵌兜底（字典未落盘也不露裸 key）', async () => {
    const { SB_LOCALE_FALLBACK, sbT } = await loadPanelLive()
    assert.equal(typeof SB_LOCALE_FALLBACK['sb.kbHintDefault'], 'string')
    assert.notEqual(SB_LOCALE_FALLBACK['sb.kbHintDefault'].trim(), '')
    assert.notEqual(sbT((key) => key, 'sb.kbHintDefault'), 'sb.kbHintDefault')
  })
})
