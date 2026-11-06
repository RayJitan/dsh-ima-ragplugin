/**
 * 自动签到 UI 的纯逻辑单测（席位 client-checkin 拥有）。
 *
 * `lib/client/20-sidebar.js` 是**片段**（会被拼进 lib/client.js 的 factory 函数体），
 * 不是模块，所以这里用 `new Function(src + 'return {...}')()` 在独立作用域里求值，
 * 只取出不依赖 React / DOM / 闭包状态的纯函数来断言。
 *
 * 组件渲染无法在 Node 里验证（需要 React + 浏览器），因此本文件的覆盖范围是
 * 「状态整形 + 进度/状态文案 + 时间校验 + 历史裁剪 + 失败文案降级」这些真正会出错的地方，
 * 外加一条契约一致性断言（ROUTES / 双语 key / 区块位置）。
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { describe, it } from 'node:test'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const FRAGMENT = join(root, 'lib', 'client', '20-sidebar.js')
const CORE = join(root, 'lib', 'client', '10-core.js')

/** 本文件要断言的纯函数（全部来自 20-sidebar.js 的签到段）。 */
const PURE = [
  'sbCheckinTimeValid',
  'sbCheckinTime',
  'sbCheckinReward',
  'sbCheckinEntry',
  'sbCheckinHistory',
  'sbCheckinStatus',
  'sbCheckinStatusKind',
  'sbCheckinRunResult',
  'sbCheckinTodayText',
  'sbCheckinWeekText',
  'sbCheckinBonusText',
  'sbCheckinRunText',
  'sbCheckinCanRun',
  'sbCheckinApplyRun',
  'sbCheckinConfigBody',
]

/**
 * 在独立作用域里求值片段，取回纯函数。
 * 片段顶层只有函数声明与常量，求值不会触碰 DOM / React。
 * @returns {Promise<object>} 纯函数集合。
 */
async function loadPure() {
  const source = await readFile(FRAGMENT, 'utf8')
  // eslint-disable-next-line no-new-func
  const factory = new Function(`${source}\nreturn { ${PURE.join(', ')} };`)
  return factory()
}

/**
 * 从 10-core 取出真机字典（zh 是 key 集事实源）。
 * @returns {Promise<{zh:object, en:object}>} 双语文案。
 */
async function loadDicts() {
  const core = await readFile(CORE, 'utf8')
  // eslint-disable-next-line no-new-func
  const { zh, en } = new Function(`${core}\nreturn { zh, en };`)()
  return { zh, en }
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

/**
 * 真机 status 形状（CHECKIN.md §4 的 value；2026-11-06 已签到后）。
 * @param {object} [overrides] - 覆盖字段。
 * @returns {object} status value。
 */
function realStatus(overrides) {
  return Object.assign({
    configured: true,
    tokenValid: true,
    enabled: true,
    time: '09:00',
    today: { date: '2026-11-06', checked: true, status: 2, reward: 50 },
    week: { checkinDays: 1, totalRewardPoints: 50, bonusAvailable: false },
    history: [
      { date: '2026-11-06', at: 1793936700000, ok: true, reward: 50, total: 50, alreadyChecked: false, error: null },
      { date: '2026-11-05', at: 1793850300000, ok: true, reward: 50, total: 100, alreadyChecked: true, error: null },
    ],
    lastRun: { date: '2026-11-06', at: 1793936700000, ok: true, reward: 50, total: 50, alreadyChecked: false, error: null },
  }, overrides)
}

describe('checkin-ui: 时间校验（HH:mm）', () => {
  it('合法值：00:00 / 09:00 / 23:59，允许首尾空白', async () => {
    const { sbCheckinTimeValid } = await loadPure()
    for (const value of ['00:00', '09:00', '23:59', ' 07:30 ']) {
      assert.equal(sbCheckinTimeValid(value), true, `${value} 应合法`)
    }
  })

  it('非法值：越界 / 缺前导零 / 空串 / 非字符串', async () => {
    const { sbCheckinTimeValid } = await loadPure()
    for (const value of ['24:00', '23:60', '9:00', '09:0', '', '   ', 'abc', '09:00:00', null, undefined, 900]) {
      assert.equal(sbCheckinTimeValid(value), false, `${String(value)} 应非法`)
    }
  })

  it('归一化：非法/缺失回落默认 09:00，合法值去空白', async () => {
    const { sbCheckinTime } = await loadPure()
    assert.equal(sbCheckinTime(' 07:30 '), '07:30')
    assert.equal(sbCheckinTime('25:00'), '09:00')
    assert.equal(sbCheckinTime(undefined), '09:00')
    assert.equal(sbCheckinTime(null), '09:00')
    assert.equal(sbCheckinTime(930), '09:00')
  })
})

describe('checkin-ui: /checkin/status 状态整形', () => {
  it('真机形状：今日已签、本周 1/7、累计 50、历史与 lastRun 都取到', async () => {
    const { sbCheckinStatus } = await loadPure()
    const state = sbCheckinStatus(realStatus())
    assert.equal(state.configured, true)
    assert.equal(state.tokenValid, true)
    assert.equal(state.enabled, true)
    assert.equal(state.time, '09:00')
    assert.deepEqual(state.today, { date: '2026-11-06', checked: true, status: 2, reward: 50 })
    assert.equal(state.week.checkinDays, 1)
    assert.equal(state.week.totalRewardPoints, 50)
    assert.equal(state.week.bonusAvailable, false)
    assert.equal(state.history.length, 2)
    assert.equal(state.history[0].date, '2026-11-06')
    assert.equal(state.lastRun.date, '2026-11-06')
    assert.equal(state.error, undefined)
  })

  it('today.status===2 即已签（checked 字段缺失也能判定），status===3 是未签', async () => {
    const { sbCheckinStatus } = await loadPure()
    assert.equal(sbCheckinStatus({ today: { status: 2 } }).today.checked, true)
    assert.equal(sbCheckinStatus({ today: { status: 3 } }).today.checked, false)
    assert.equal(sbCheckinStatus({ today: { checked: true } }).today.checked, true)
  })

  it('缺字段给默认值：未配置、token 无效、开关默认开、时间 09:00、进度 0、历史空', async () => {
    const { sbCheckinStatus } = await loadPure()
    const state = sbCheckinStatus({})
    assert.equal(state.configured, false)
    assert.equal(state.tokenValid, false)
    assert.equal(state.enabled, true)
    assert.equal(state.time, '09:00')
    assert.equal(state.today.checked, false)
    assert.equal(state.week.checkinDays, 0)
    assert.equal(state.week.totalRewardPoints, 0)
    assert.deepEqual(state.history, [])
    assert.equal(state.lastRun, undefined)
  })

  it('enabled 只有显式 false 才算关闭（宿主默认 true）', async () => {
    const { sbCheckinStatus } = await loadPure()
    assert.equal(sbCheckinStatus({ enabled: false }).enabled, false)
    assert.equal(sbCheckinStatus({ enabled: true }).enabled, true)
    assert.equal(sbCheckinStatus({ enabled: 'false' }).enabled, true)
  })

  it('本周天数夹到 0–7；算力不为负；非法时间回落 09:00', async () => {
    const { sbCheckinStatus } = await loadPure()
    assert.equal(sbCheckinStatus({ week: { checkinDays: 9 } }).week.checkinDays, 7)
    assert.equal(sbCheckinStatus({ week: { checkinDays: -3 } }).week.checkinDays, 0)
    assert.equal(sbCheckinStatus({ week: { checkinDays: 3.7 } }).week.checkinDays, 3)
    assert.equal(sbCheckinStatus({ week: { totalRewardPoints: -50 } }).week.totalRewardPoints, 0)
    assert.equal(sbCheckinStatus({ time: '7:30' }).time, '09:00')
    assert.equal(sbCheckinStatus({ time: ' 07:30 ' }).time, '07:30')
  })

  it('error 两种形状都能取出可展示文案；空白串视为无错误', async () => {
    const { sbCheckinStatus } = await loadPure()
    assert.equal(sbCheckinStatus({ error: { code: 'X', message: 'boom' } }).error, 'boom')
    assert.equal(sbCheckinStatus({ error: ' 上游炸了 ' }).error, '上游炸了')
    assert.equal(sbCheckinStatus({ error: '   ' }).error, undefined)
    assert.equal(sbCheckinStatus({ error: {} }).error, undefined)
  })

  it('任何垃圾输入都不抛错（A10 不崩）', async () => {
    const { sbCheckinStatus, sbCheckinStatusKind } = await loadPure()
    for (const bogus of [null, undefined, 0, 'x', [], true, { today: 'x', week: 7, history: 'y' }]) {
      assert.doesNotThrow(() => sbCheckinStatus(bogus))
      assert.doesNotThrow(() => sbCheckinStatusKind(bogus))
    }
    assert.equal(sbCheckinStatus(null).configured, false)
  })
})

describe('checkin-ui: 状态行与进度文案', () => {
  it('今日状态行四态：未配置 / token 失效 / 已签到 +N / 未签到', async () => {
    const { zh } = await loadDicts()
    const t = makeT(zh)
    const { sbCheckinStatus, sbCheckinTodayText } = await loadPure()
    assert.equal(sbCheckinTodayText(t, sbCheckinStatus(realStatus())), '今日已签到 · +50 算力')
    assert.equal(sbCheckinTodayText(t, sbCheckinStatus(realStatus({
      today: { date: '2026-11-06', checked: false, status: 3, reward: 0 },
    }))), '今日未签到')
    assert.equal(sbCheckinTodayText(t, sbCheckinStatus(realStatus({ configured: false }))), '未配置凭据')
    assert.equal(sbCheckinTodayText(t, sbCheckinStatus(realStatus({ tokenValid: false }))), 'token 已失效')
  })

  it('状态种类：unconfigured / tokenInvalid / checked / pending', async () => {
    const { sbCheckinStatus, sbCheckinStatusKind } = await loadPure()
    assert.equal(sbCheckinStatusKind(sbCheckinStatus(realStatus({ configured: false }))), 'unconfigured')
    assert.equal(sbCheckinStatusKind(sbCheckinStatus(realStatus({ tokenValid: false }))), 'tokenInvalid')
    assert.equal(sbCheckinStatusKind(sbCheckinStatus(realStatus())), 'checked')
    assert.equal(sbCheckinStatusKind(sbCheckinStatus(realStatus({
      today: { date: '2026-11-06', checked: false, status: 3, reward: 0 },
    }))), 'pending')
  })

  it('本周进度：本周已签 N/7 天 · 累计 X 算力', async () => {
    const { zh } = await loadDicts()
    const t = makeT(zh)
    const { sbCheckinWeekText } = await loadPure()
    assert.equal(sbCheckinWeekText(t, { checkinDays: 3, totalRewardPoints: 150 }), '本周已签 3/7 天 · 累计 150 算力')
    assert.equal(sbCheckinWeekText(t, { checkinDays: 0, totalRewardPoints: 0 }), '本周已签 0/7 天 · 累计 0 算力')
    // 越界值也要夹住，不能渲染出 9/7
    assert.equal(sbCheckinWeekText(t, { checkinDays: 9, totalRewardPoints: 50 }), '本周已签 7/7 天 · 累计 50 算力')
  })

  it('满签奖励三态：可领 / 已领 / 未解锁（可领优先）', async () => {
    const { zh } = await loadDicts()
    const t = makeT(zh)
    const { sbCheckinBonusText } = await loadPure()
    assert.equal(sbCheckinBonusText(t, { bonusAvailable: true }), '满签奖励可领')
    assert.equal(sbCheckinBonusText(t, { bonusReceived: true }), '满签奖励已领')
    assert.equal(sbCheckinBonusText(t, { bonusAvailable: false, bonusReceived: false }), '满签奖励未解锁')
    assert.equal(sbCheckinBonusText(t, { bonusAvailable: true, bonusReceived: true }), '满签奖励可领')
    assert.equal(sbCheckinBonusText(t, null), '满签奖励未解锁')
  })

  it('英文文案同样齐全（切语言不露裸 key）', async () => {
    const { en } = await loadDicts()
    const t = makeT(en)
    const { sbCheckinStatus, sbCheckinTodayText, sbCheckinWeekText, sbCheckinBonusText } = await loadPure()
    const state = sbCheckinStatus(realStatus())
    assert.equal(sbCheckinTodayText(t, state), 'Checked in today · +50 credits')
    assert.equal(sbCheckinWeekText(t, state.week), '1/7 days this week · 50 credits total')
    assert.equal(sbCheckinBonusText(t, state.week), 'Weekly bonus locked')
    for (const text of [sbCheckinTodayText(t, state), sbCheckinWeekText(t, state.week), sbCheckinBonusText(t, state.week)]) {
      assert.equal(text.startsWith('sb.checkin.'), false, '不得漏出裸 key：' + text)
    }
  })
})

describe('checkin-ui: 历史裁剪与记录文案', () => {
  it('最多保留最近 7 条，保持宿主给的倒序', async () => {
    const { sbCheckinHistory } = await loadPure()
    const raw = Array.from({ length: 10 }, (unused, index) => ({
      date: `2026-11-${String(10 - index).padStart(2, '0')}`,
      at: 1793936700000 - index * 86400000,
      ok: true,
      reward: 50,
    }))
    const history = sbCheckinHistory(raw)
    assert.equal(history.length, 7)
    assert.equal(history[0].date, '2026-11-10')
    assert.equal(history[6].date, '2026-11-04')
  })

  it('丢弃无效条目（既无 date 也无 at），非数组输入返回空数组', async () => {
    const { sbCheckinHistory } = await loadPure()
    const history = sbCheckinHistory([null, {}, { date: '' }, { date: '2026-11-01', ok: true }, 'x', { at: 1 }])
    assert.deepEqual(history.map((entry) => entry.date), ['2026-11-01', undefined])
    assert.equal(sbCheckinHistory(undefined).length, 0)
    assert.equal(sbCheckinHistory('nope').length, 0)
    assert.equal(sbCheckinHistory({}).length, 0)
  })
})

describe('checkin-ui: 立即签到的状态机', () => {
  it('可点条件：凭据有效且今天未签', async () => {
    const { sbCheckinStatus, sbCheckinCanRun } = await loadPure()
    assert.equal(sbCheckinCanRun(sbCheckinStatus(realStatus())), false, '今日已签 → 不可点')
    assert.equal(sbCheckinCanRun(sbCheckinStatus(realStatus({
      today: { date: '2026-11-06', checked: false, status: 3, reward: 0 },
    }))), true)
    assert.equal(sbCheckinCanRun(sbCheckinStatus(realStatus({ configured: false }))), false)
    assert.equal(sbCheckinCanRun(sbCheckinStatus(realStatus({ tokenValid: false }))), false)
    assert.equal(sbCheckinCanRun(null), false)
  })

  it('/checkin/run 响应整形：alreadyChecked / claimed / today / week / lastRun', async () => {
    const { sbCheckinRunResult } = await loadPure()
    const result = sbCheckinRunResult({
      checked: false,
      alreadyChecked: true,
      claimed: { daily: false, bonus: false },
      reward: 0,
      total: 0,
      today: { date: '2026-11-06', checked: true, status: 2, reward: 50 },
      week: { checkinDays: 1, totalRewardPoints: 50, bonusAvailable: false },
      lastRun: { date: '2026-11-06', at: 1793936700000, ok: true, reward: 0, alreadyChecked: true },
    })
    assert.equal(result.alreadyChecked, true)
    assert.equal(result.checked, false)
    assert.deepEqual(result.claimed, { daily: false, bonus: false })
    assert.equal(result.today.checked, true)
    assert.equal(result.week.checkinDays, 1)
    assert.equal(result.lastRun.date, '2026-11-06')
  })

  it('结果文案：已签过 / 签到成功 +N / 签到成功（无奖励）', async () => {
    const { zh } = await loadDicts()
    const t = makeT(zh)
    const { sbCheckinRunText } = await loadPure()
    assert.equal(sbCheckinRunText(t, { alreadyChecked: true }), '今天已经签过了')
    assert.equal(sbCheckinRunText(t, { alreadyChecked: false, reward: 50 }), '签到成功 · +50 算力')
    assert.equal(sbCheckinRunText(t, { alreadyChecked: false, reward: 0 }), '签到成功')
  })

  it('把 run 结果并入状态：历史前插 + 按日期去重 + 裁到 7 条', async () => {
    const { sbCheckinStatus, sbCheckinRunResult, sbCheckinApplyRun } = await loadPure()
    const history = Array.from({ length: 7 }, (unused, index) => ({
      date: `2026-11-0${index + 1}`,
      ok: true,
      reward: 50,
    }))
    const state = sbCheckinStatus(realStatus({ history }))
    const result = sbCheckinRunResult({
      checked: true,
      alreadyChecked: false,
      reward: 50,
      total: 50,
      today: { date: '2026-11-07', checked: true, status: 2, reward: 50 },
      week: { checkinDays: 2, totalRewardPoints: 100, bonusAvailable: false },
      lastRun: { date: '2026-11-07', at: 1794023100000, ok: true, reward: 50 },
    })
    const next = sbCheckinApplyRun(state, result)
    assert.equal(next.history.length, 7)
    assert.equal(next.history[0].date, '2026-11-07')
    assert.equal(next.today.checked, true)
    assert.equal(next.week.checkinDays, 2)
    assert.equal(next.lastRun.date, '2026-11-07')
    // 不修改入参
    assert.equal(state.history[0].date, '2026-11-01')
  })

  it('同一天重复并入不会产生两条记录', async () => {
    const { sbCheckinStatus, sbCheckinRunResult, sbCheckinApplyRun } = await loadPure()
    const state = sbCheckinStatus(realStatus())
    const result = sbCheckinRunResult({
      alreadyChecked: true,
      lastRun: { date: '2026-11-06', at: 1793936700000, ok: true, alreadyChecked: true },
    })
    const next = sbCheckinApplyRun(state, result)
    assert.equal(next.history.filter((entry) => entry.date === '2026-11-06').length, 1)
  })

  it('响应缺 today/week 时保留本地状态（不拿默认值冲掉真实数据）', async () => {
    const { sbCheckinStatus, sbCheckinRunResult, sbCheckinApplyRun } = await loadPure()
    const state = sbCheckinStatus(realStatus())
    const next = sbCheckinApplyRun(state, sbCheckinRunResult({ alreadyChecked: true }))
    assert.equal(next.today.checked, true)
    assert.equal(next.week.checkinDays, 1)
  })
})

describe('checkin-ui: /checkin/config 请求体', () => {
  it('合法补丁原样带上；时间去空白', async () => {
    const { sbCheckinConfigBody } = await loadPure()
    assert.deepEqual(sbCheckinConfigBody({ enabled: true }), { enabled: true })
    assert.deepEqual(sbCheckinConfigBody({ enabled: false }), { enabled: false })
    assert.deepEqual(sbCheckinConfigBody({ time: '07:30' }), { time: '07:30' })
    assert.deepEqual(sbCheckinConfigBody({ time: ' 07:30 ' }), { time: '07:30' })
    assert.deepEqual(sbCheckinConfigBody({ enabled: true, time: '23:59' }), { enabled: true, time: '23:59' })
  })

  it('非法时间 / 空补丁 / 非布尔开关 → undefined（不发请求）', async () => {
    const { sbCheckinConfigBody } = await loadPure()
    assert.equal(sbCheckinConfigBody({ time: '25:00' }), undefined)
    assert.equal(sbCheckinConfigBody({ time: '7:30' }), undefined)
    assert.equal(sbCheckinConfigBody({ time: '' }), undefined)
    assert.equal(sbCheckinConfigBody({}), undefined)
    assert.equal(sbCheckinConfigBody(null), undefined)
    assert.equal(sbCheckinConfigBody({ enabled: 'yes' }), undefined)
    assert.equal(sbCheckinConfigBody({ enabled: 1 }), undefined)
  })
})

describe('checkin-ui: 契约一致性', () => {
  it('10-core 的 ROUTES 有 checkin 三条路由，且都是无前导 / 的相对路径', async () => {
    const core = await readFile(CORE, 'utf8')
    // eslint-disable-next-line no-new-func
    const { ROUTES } = new Function(`${core}\nreturn { ROUTES };`)()
    assert.equal(ROUTES.checkinStatus, 'api/ima-knowledge/checkin/status')
    assert.equal(ROUTES.checkinRun, 'api/ima-knowledge/checkin/run')
    assert.equal(ROUTES.checkinConfig, 'api/ima-knowledge/checkin/config')
    for (const key of ['checkinStatus', 'checkinRun', 'checkinConfig']) {
      assert.equal(ROUTES[key].startsWith('/'), false, `${key} 不能有前导 /`)
    }
  })

  it('zh / en 的 sb.checkin.* key 集完全一致（双语必须同步补齐）', async () => {
    const { zh, en } = await loadDicts()
    const zhKeys = Object.keys(zh).filter((key) => key.startsWith('sb.checkin.')).sort()
    const enKeys = Object.keys(en).filter((key) => key.startsWith('sb.checkin.')).sort()
    // 紧凑版区块只保留必要文案（标题/开关/时间/状态/进度/奖励/按钮/错误），
    // 门槛随 UI 精简下调；真正要守住的是「zh 与 en 键集完全一致」。
    assert.ok(zhKeys.length >= 20, `sb.checkin.* key 数量偏少：${zhKeys.length}`)
    assert.deepEqual(enKeys, zhKeys, 'zh / en 的 sb.checkin.* key 集必须一致')
  })

  it('片段里引用的每个 sb.checkin.* key 都在双语字典里（不漏裸 key）', async () => {
    const { zh, en } = await loadDicts()
    const source = await readFile(FRAGMENT, 'utf8')
    const used = new Set()
    for (const match of source.matchAll(/'sb\.checkin\.[a-zA-Z.]+'/gu)) {
      used.add(match[0].slice(1, -1))
    }
    assert.ok(used.size >= 15, `应解析出多个 key，实际 ${used.size}`)
    const missingZh = [...used].filter((key) => !(key in zh))
    const missingEn = [...used].filter((key) => !(key in en))
    assert.deepEqual(missingZh, [], 'zh 缺 key：' + missingZh.join(', '))
    assert.deepEqual(missingEn, [], 'en 缺 key：' + missingEn.join(', '))
  })

  it('区块挂在「知识库」之后，并带 data-ima-checkin 标记与三条路由调用', async () => {
    const source = await readFile(FRAGMENT, 'utf8')
    assert.ok(source.includes("'data-ima-checkin': ''"), '缺少 <section data-ima-checkin>')
    // 面板里的区块顺序：知识库区 → 自动签到区（组件定义在 ImaPanel 之前，不能按标记位置判）。
    const kbSection = source.indexOf('// ── 知识库区')
    const checkinSection = source.indexOf('// ── 自动签到区')
    assert.ok(kbSection > 0, '缺少知识库区块注释锚点')
    assert.ok(checkinSection > kbSection, '签到区块必须在知识库区块之后')
    for (const route of ['ROUTES.checkinStatus', 'ROUTES.checkinRun', 'ROUTES.checkinConfig']) {
      assert.ok(source.includes(route), `片段里必须调用 ${route}`)
    }
  })

  it('开关样式在 10-core 的 S 里（配色只用主题 token）', async () => {
    const core = await readFile(CORE, 'utf8')
    // eslint-disable-next-line no-new-func
    const { S } = new Function(`${core}\nreturn { S };`)()
    for (const key of ['switchRow', 'switch', 'switchOn', 'switchKnob', 'switchKnobOn']) {
      assert.ok(S[key] !== undefined, `S.${key} 缺失`)
    }
    // 布局样式（switchRow）可以没有颜色；带颜色的轨道/滑块必须走主题 token。
    for (const key of ['switch', 'switchOn', 'switchKnob', 'switchKnobOn']) {
      const serialized = JSON.stringify(S[key])
      assert.equal(serialized.includes('--dsw-alias-'), true, `S.${key} 必须用主题 token`)
    }
  })
})

/**
 * 算力数值整形：宿主 `today.reward` 是上游原文（`"50算力"`），历史记录里是数字。
 * 两种形状都必须读出 50，否则 UI 会显示「今日已签到 · +0 算力」（真机截图发现的缺陷）。
 */
describe('checkin: 算力数值整形（sbCheckinReward）', () => {
  it('上游原文 "50算力" → 50', async () => {
    const { sbCheckinReward } = await loadPure()
    assert.equal(sbCheckinReward('50算力'), 50)
    assert.equal(sbCheckinReward('额外随机奖励'), 0)
  })

  it('数字 / 数字字符串 / 缺省都能读', async () => {
    const { sbCheckinReward } = await loadPure()
    assert.equal(sbCheckinReward(50), 50)
    assert.equal(sbCheckinReward('50'), 50)
    assert.equal(sbCheckinReward(undefined), 0)
    assert.equal(sbCheckinReward(null), 0)
    assert.equal(sbCheckinReward(''), 0)
  })

  it('负数与小数被夹成非负整数', async () => {
    const { sbCheckinReward } = await loadPure()
    assert.equal(sbCheckinReward(-10), 0)
    assert.equal(sbCheckinReward(49.6), 50)
  })

  it('status 整形后 today.reward 是数字（真机形状 "50算力"）', async () => {
    const { sbCheckinStatus } = await loadPure()
    const state = sbCheckinStatus({
      configured: true,
      tokenValid: true,
      today: { date: '2026-11-06', checked: true, status: 2, reward: '50算力' },
      week: { checkinDays: 1, totalRewardPoints: 50, bonusAvailable: false },
    })
    assert.equal(state.today.reward, 50)
  })

  it('今日已签到文案带真实算力数（不是 +0）', async () => {
    const { sbCheckinStatus, sbCheckinTodayText } = await loadPure()
    const { zh } = await loadDicts()
    const state = sbCheckinStatus({
      configured: true,
      tokenValid: true,
      today: { date: '2026-11-06', checked: true, status: 2, reward: '50算力' },
      week: { checkinDays: 1, totalRewardPoints: 50, bonusAvailable: false },
    })
    const text = sbCheckinTodayText(makeT(zh), state)
    assert.equal(text.includes('50'), true, `文案应含 50，实际：${text}`)
    assert.equal(text.includes('+0'), false, `文案不应是 +0，实际：${text}`)
  })
})
