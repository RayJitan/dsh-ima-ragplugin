/**
 * lib/checkin-store.js 单测（CHECKIN.md §3.1 / §6.1）
 *
 * 覆盖：默认值 / 损坏回落 / 原子写 / history 截断 30 / time 校验 / 注入面（fs + now + home）。
 * 全部走注入的假 fs，**不碰真实文件系统**，也不依赖真机网络。
 */

import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'

import {
  CHECKIN_HISTORY_LIMIT,
  CHECKIN_STORE_VERSION,
  DEFAULT_CHECKIN_CONFIG,
  DEFAULT_CHECKIN_TIME,
  createCheckinStore,
  defaultCheckinState,
  defaultCheckinStorePath,
  formatLocalDate,
  isValidCheckinTime,
  normalizeCheckinState,
  normalizeCheckinTime,
  normalizeRunRecord,
  resolveDshHome,
} from '../lib/checkin-store.js'

// --------------------------------------------------------------- 测试脚手架

/** 假文件系统：内存 Map + 调用记录（readFile/writeFile/rename/mkdir）。 */
function fakeFs(initial = {}) {
  const files = new Map(Object.entries(initial))
  const calls = { reads: [], writes: [], renames: [], mkdirs: [] }
  return {
    files,
    calls,
    async readFile(path) {
      calls.reads.push(path)
      if (!files.has(path)) {
        const error = new Error(`ENOENT: no such file or directory, open '${path}'`)
        error.code = 'ENOENT'
        throw error
      }
      return files.get(path)
    },
    async writeFile(path, data) {
      calls.writes.push({ path, data })
      files.set(path, data)
    },
    async rename(from, to) {
      calls.renames.push({ from, to })
      if (!files.has(from)) throw new Error(`ENOENT: ${from}`)
      files.set(to, files.get(from))
      files.delete(from)
    },
    async mkdir(path) {
      calls.mkdirs.push(path)
    },
  }
}

const FILE = join('D:', 'dsh-home', 'ima-knowledge', 'checkin.json')

/** 一条合法的运行记录。 */
function runRecord(at, overrides = {}) {
  return {
    date: formatLocalDate(at),
    at,
    ok: true,
    reward: 50,
    total: 50,
    alreadyChecked: false,
    error: null,
    ...overrides,
  }
}

// ------------------------------------------------------------ 路径与纯函数

describe('checkin-store: 路径与纯函数', () => {
  it('resolveDshHome 优先 DSH_HOME，否则 ~/.dsh', () => {
    assert.equal(resolveDshHome({ DSH_HOME: 'D:/custom-home' }), 'D:/custom-home')
    assert.equal(resolveDshHome({ DSH_HOME: '  D:/trimmed  ' }), 'D:/trimmed')
    assert.equal(resolveDshHome({ DSH_HOME: '   ' }), join(homedir(), '.dsh'))
    assert.equal(resolveDshHome({}), join(homedir(), '.dsh'))
  })

  it('defaultCheckinStorePath 是 <home>/ima-knowledge/checkin.json', () => {
    assert.equal(defaultCheckinStorePath('D:/dsh-home'), join('D:/dsh-home', 'ima-knowledge', 'checkin.json'))
  })

  it('time 校验：只接受 HH:mm（00:00–23:59）', () => {
    for (const valid of ['00:00', '09:00', '12:34', '23:59']) {
      assert.equal(isValidCheckinTime(valid), true, `${valid} 应合法`)
      assert.equal(normalizeCheckinTime(valid), valid)
    }
    for (const invalid of ['24:00', '9:00', '09:60', '09:00:00', '', ' 09:00', null, undefined, 900]) {
      assert.equal(isValidCheckinTime(invalid), false, `${String(invalid)} 应非法`)
      assert.equal(normalizeCheckinTime(invalid), DEFAULT_CHECKIN_TIME)
    }
  })

  it('formatLocalDate 用本地时区（YYYY-MM-DD）', () => {
    const noon = new Date(2026, 10, 6, 12, 0, 0).getTime()
    assert.equal(formatLocalDate(noon), '2026-11-06')
    const midnight = new Date(2026, 0, 1, 0, 0, 0).getTime()
    assert.equal(formatLocalDate(midnight), '2026-01-01')
  })

  it('defaultCheckinState 是契约里的默认形状', () => {
    assert.deepEqual(defaultCheckinState(), {
      version: CHECKIN_STORE_VERSION,
      config: { enabled: true, time: '09:00' },
      lastRun: null,
      history: [],
    })
    assert.deepEqual(DEFAULT_CHECKIN_CONFIG, { enabled: true, time: DEFAULT_CHECKIN_TIME })
  })

  it('normalizeRunRecord：坏记录返回 undefined，date 可由 at 推导', () => {
    assert.equal(normalizeRunRecord(null), undefined)
    assert.equal(normalizeRunRecord('oops'), undefined)
    assert.equal(normalizeRunRecord({}), undefined)
    const at = new Date(2026, 10, 6, 9, 0, 0).getTime()
    assert.deepEqual(normalizeRunRecord({ at }), {
      date: '2026-11-06',
      at,
      ok: false,
      reward: 0,
      total: 0,
      alreadyChecked: false,
      error: null,
    })
    assert.deepEqual(normalizeRunRecord({ date: '2026-11-06', at }), {
      date: '2026-11-06',
      at,
      ok: false,
      reward: 0,
      total: 0,
      alreadyChecked: false,
      error: null,
    })
    assert.equal(normalizeRunRecord({ at: -1 }), undefined)
  })

  it('normalizeCheckinState：非对象 / 字段非法一律回落默认值', () => {
    assert.deepEqual(normalizeCheckinState(null), defaultCheckinState())
    assert.deepEqual(normalizeCheckinState([]), defaultCheckinState())
    const normalized = normalizeCheckinState({
      version: 99,
      config: { enabled: 'yes', time: '25:00' },
      lastRun: { date: 'x' },
      history: [{ at: 'nope' }, { date: '2026-11-05', at: 2, ok: true, reward: 50 }],
    })
    assert.equal(normalized.config.enabled, true)
    assert.equal(normalized.config.time, '09:00')
    assert.equal(normalized.lastRun, null)
    assert.equal(normalized.history.length, 1)
    assert.equal(normalized.history[0].date, '2026-11-05')
  })
})

// ---------------------------------------------------------------- 读取与回落

describe('checkin-store: 读取与回落', () => {
  it('文件不存在是正常初始态：返回默认值且不写盘', async () => {
    const fs = fakeFs()
    const store = createCheckinStore({ file: FILE, fs })
    const state = await store.read()
    assert.deepEqual(state, defaultCheckinState())
    assert.equal(fs.calls.writes.length, 0, '缺文件时不该写盘')
    assert.equal(fs.calls.reads.length, 1)
  })

  it('损坏 JSON → 回落默认值 + 写一次修复（不抛）', async () => {
    const fs = fakeFs({ [FILE]: '{ not json' })
    const store = createCheckinStore({ file: FILE, fs })
    const state = await store.read()
    assert.deepEqual(state, defaultCheckinState())
    assert.equal(fs.calls.writes.length, 1, '损坏文件应写一次修复')
    assert.deepEqual(JSON.parse(fs.files.get(FILE)), defaultCheckinState())
  })

  it('字段非法 → 逐字段回落 + 写一次修复', async () => {
    const fs = fakeFs({
      [FILE]: JSON.stringify({
        version: 1,
        config: { enabled: 'yes', time: '25:00' },
        lastRun: { date: 'nope' },
        history: 'oops',
      }),
    })
    const store = createCheckinStore({ file: FILE, fs })
    const state = await store.read()
    assert.equal(state.config.enabled, true)
    assert.equal(state.config.time, '09:00')
    assert.equal(state.lastRun, null)
    assert.deepEqual(state.history, [])
    assert.equal(fs.calls.writes.length, 1)
  })

  it('合法文件不写盘（避免每次启动都重写）', async () => {
    const at = new Date(2026, 10, 6, 9, 0, 0).getTime()
    const valid = {
      version: CHECKIN_STORE_VERSION,
      config: { enabled: false, time: '08:30' },
      lastRun: runRecord(at),
      history: [runRecord(at)],
    }
    const fs = fakeFs({ [FILE]: JSON.stringify(valid) })
    const store = createCheckinStore({ file: FILE, fs })
    const state = await store.read()
    assert.equal(state.config.enabled, false)
    assert.equal(state.config.time, '08:30')
    assert.equal(state.lastRun.at, at)
    assert.equal(fs.calls.writes.length, 0)
  })

  it('history 按时间倒序并截断到 30 条', async () => {
    const base = new Date(2026, 10, 1, 9, 0, 0).getTime()
    const history = Array.from({ length: 35 }, (_entry, index) => runRecord(base + index * 60_000))
    const fs = fakeFs({ [FILE]: JSON.stringify({ version: 1, config: DEFAULT_CHECKIN_CONFIG, lastRun: null, history }) })
    const store = createCheckinStore({ file: FILE, fs })
    const state = await store.read()
    assert.equal(state.history.length, CHECKIN_HISTORY_LIMIT)
    assert.equal(state.history[0].at, base + 34 * 60_000, '新记录必须在最前')
    for (let index = 1; index < state.history.length; index += 1) {
      assert.ok(state.history[index - 1].at > state.history[index].at, 'history 必须严格倒序')
    }
  })

  it('read 返回深拷贝（调用方改不穿缓存）', async () => {
    const fs = fakeFs()
    const store = createCheckinStore({ file: FILE, fs })
    const first = await store.read()
    first.config.time = '23:59'
    first.history.push(runRecord(Date.now()))
    const second = await store.read()
    assert.equal(second.config.time, '09:00')
    assert.deepEqual(second.history, [])
  })
})

// ---------------------------------------------------------------- 写入与原子性

describe('checkin-store: 写入与原子性', () => {
  it('recordRun 走 tmp + rename 原子写，并更新 lastRun/history', async () => {
    const at = new Date(2026, 10, 6, 9, 0, 0).getTime()
    const fs = fakeFs()
    const store = createCheckinStore({ file: FILE, fs, now: () => at })
    const state = await store.recordRun({ ok: true, reward: 50, total: 50 })
    assert.equal(fs.calls.writes.length, 1)
    assert.notEqual(fs.calls.writes[0].path, FILE, '必须先写 tmp 文件')
    assert.match(fs.calls.writes[0].path, /\.tmp$/u)
    assert.equal(fs.calls.renames.length, 1)
    assert.equal(fs.calls.renames[0].from, fs.calls.writes[0].path)
    assert.equal(fs.calls.renames[0].to, FILE)
    assert.deepEqual(fs.calls.mkdirs, [dirname(FILE)])
    // 落盘内容可被重新解析，且 lastRun 就是刚写的那条。
    const onDisk = JSON.parse(fs.files.get(FILE))
    assert.equal(onDisk.version, CHECKIN_STORE_VERSION)
    assert.equal(onDisk.lastRun.date, '2026-11-06')
    assert.equal(onDisk.lastRun.at, at)
    assert.equal(onDisk.lastRun.ok, true)
    assert.equal(onDisk.history.length, 1)
    assert.deepEqual(state.lastRun, onDisk.lastRun)
  })

  it('recordRun 把新记录插到 history 最前并截断 30 条', async () => {
    const base = new Date(2026, 10, 1, 9, 0, 0).getTime()
    const history = Array.from({ length: 30 }, (_entry, index) => runRecord(base + index * 60_000))
    const fs = fakeFs({ [FILE]: JSON.stringify({ version: 1, config: DEFAULT_CHECKIN_CONFIG, lastRun: null, history }) })
    const store = createCheckinStore({ file: FILE, fs })
    const at = base + 100 * 60_000
    const state = await store.recordRun({ at, ok: true, reward: 50, total: 100 })
    assert.equal(state.history.length, CHECKIN_HISTORY_LIMIT)
    assert.equal(state.history[0].at, at)
    assert.equal(state.lastRun.at, at)
  })

  it('recordRun 记录失败原因（ok:false + error）', async () => {
    const at = new Date(2026, 10, 6, 9, 0, 0).getTime()
    const fs = fakeFs()
    const store = createCheckinStore({ file: FILE, fs })
    const state = await store.recordRun({ at, ok: false, error: 'code 41: token expired' })
    assert.equal(state.lastRun.ok, false)
    assert.equal(state.lastRun.error, 'code 41: token expired')
    assert.equal(state.lastRun.reward, 0)
  })

  it('recordRun 缺 date/at 时抛错（不写坏记录）', async () => {
    const fs = fakeFs()
    const store = createCheckinStore({ file: FILE, fs, now: () => Number.NaN })
    await assert.rejects(store.recordRun({ ok: true }), /缺少合法的 date\/at/u)
  })

  it('setConfig 部分更新并落盘', async () => {
    const fs = fakeFs()
    const store = createCheckinStore({ file: FILE, fs })
    assert.deepEqual(await store.setConfig({ enabled: false }), { enabled: false, time: '09:00' })
    assert.deepEqual(await store.setConfig({ time: '08:30' }), { enabled: false, time: '08:30' })
    assert.deepEqual(JSON.parse(fs.files.get(FILE)).config, { enabled: false, time: '08:30' })
    // 空 patch 是合法调用：返回当前配置，不改值。
    assert.deepEqual(await store.setConfig({}), { enabled: false, time: '08:30' })
  })

  it('setConfig 严格校验：非法 time / 非布尔 enabled 抛错', async () => {
    const fs = fakeFs()
    const store = createCheckinStore({ file: FILE, fs })
    await assert.rejects(store.setConfig({ time: '25:00' }), /config\.time 必须是 HH:mm/u)
    await assert.rejects(store.setConfig({ time: '9:00' }), /config\.time 必须是 HH:mm/u)
    await assert.rejects(store.setConfig({ enabled: 'yes' }), /config\.enabled 必须是布尔值/u)
    await assert.rejects(store.setConfig(null), /setConfig 参数必须是对象/u)
    assert.equal(fs.calls.writes.length, 0, '校验失败不该落盘')
  })

  it('并发 recordRun 串行落盘，不丢记录', async () => {
    const at = new Date(2026, 10, 6, 9, 0, 0).getTime()
    const fs = fakeFs()
    const store = createCheckinStore({ file: FILE, fs })
    await Promise.all([
      store.recordRun({ at, ok: true }),
      store.recordRun({ at: at + 1000, ok: true }),
      store.recordRun({ at: at + 2000, ok: true }),
    ])
    const state = await store.read()
    assert.equal(state.history.length, 3)
    assert.equal(state.history[0].at, at + 2000)
  })
})

// ------------------------------------------------------------------ 注入面

describe('checkin-store: 注入面', () => {
  it('file:false → 纯内存介质，不碰 fs', async () => {
    const fs = fakeFs()
    const store = createCheckinStore({ file: false, fs })
    assert.deepEqual(store.describe(), { scope: 'memory' })
    const at = new Date(2026, 10, 6, 9, 0, 0).getTime()
    await store.recordRun({ at, ok: true, reward: 50 })
    const state = await store.read()
    assert.equal(state.lastRun.reward, 50)
    assert.equal(fs.calls.reads.length, 0)
    assert.equal(fs.calls.writes.length, 0)
  })

  it('describe 如实报告文件档路径', () => {
    const store = createCheckinStore({ file: FILE, fs: fakeFs() })
    assert.deepEqual(store.describe(), { scope: 'file', file: FILE })
  })

  it('home 注入用于拼默认路径', () => {
    const store = createCheckinStore({ home: 'D:/dsh-home', fs: fakeFs() })
    assert.deepEqual(store.describe(), { scope: 'file', file: FILE })
  })

  it('读取错误（权限等）也只回落默认值，不抛', async () => {
    const fs = fakeFs()
    fs.readFile = async () => {
      const error = new Error('EACCES: permission denied')
      error.code = 'EACCES'
      throw error
    }
    const store = createCheckinStore({ file: FILE, fs })
    assert.deepEqual(await store.read(), defaultCheckinState())
  })
})
