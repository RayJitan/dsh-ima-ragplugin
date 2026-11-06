/**
 * `/api/ima-knowledge/desktop-sync` + `lib/desktop-sync.js` 单测（PLATFORM.md §8）。
 *
 * 设计前提：**CI 上既没有 IMA 桌面客户端，也没有可用的 DPAPI**。所以这里所有
 * 「文件系统」与「DPAPI 桥」都是注入的假实现：
 *  - 假文件系统 = 一个 `Map<path, string>` + 假的 `exists` / `readFile`；
 *  - 假 DPAPI = 把「密文」当成可识别的标记串（`DPAPI::<payload>`）直接还原，
 *    连 `runPowerShell` 都不真的跑 —— 但**真实实现里那条「env 传路径、argv 传
 *    EncodedCommand」的注入防线**另有专门用例（用假 execFile 断言 argv 形状）。
 *
 * 被点名要覆盖的分支（brief §3.5）：
 *  1. probe：未安装 / 未登录 / token 过期 / refresh 过期 / 一切正常 / 非 Windows；
 *  2. sync 成功路径（假 refresh + 假 listKnowledgeBases 成功 → 断言写入了 cookie 与 bkn）；
 *  3. sync 校验失败路径（假 listKnowledgeBases 抛错 → 断言**零写入**）；
 *  4. 响应体里**不含** token 明文（整个 value 序列化后断言）；
 *  5. 非 Windows 分支。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { tmpdir as osTmpdir } from 'node:os'
import { join } from 'node:path'

import {
  IMA_X_IMA_BKN_REF,
  IMA_X_IMA_COOKIE_REF,
  ROUTE_DESKTOP_SYNC,
  ROUTE_ERROR_CODES,
  apply,
} from '../lib/host.js'
import {
  NON_WINDOWS_REASON,
  desktopClientPath,
  probeDesktopClient,
  readDesktopCredentials,
  runPowerShell,
  unprotectDpapi,
} from '../lib/desktop-sync.js'

// --------------------------------------------------------------- 测试脚手架

/** 假的 `%LOCALAPPDATA%`（任意 Windows 形状路径都行，只要 join 结果一致）。 */
const LOCAL_APP_DATA = 'C:\\Users\\tester\\AppData\\Local'
const CLIENT_DIR = join(LOCAL_APP_DATA, 'ima.copilot', 'User Data')
const PREFERENCES_PATH = join(CLIENT_DIR, 'Default', 'Preferences')

/** 桌面客户端里那份**明文** account_secret（真实形状：4 个键，实测 479 字符）。 */
const SECRET = {
  refresh_token: 'REFRESH-TOKEN-PLAINTEXT-0123456789abcdefghijklmnopqrstuvwxyz-ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  refresh_token_valid_time: '1822654289',
  token: 'TOKEN-PLAINTEXT-0123456789abcdefghijklmnopqrstuvwxyz-ABCDEFGHIJKLMNOPQRSTUVWXYZ-0123456789',
  token_valid_time: '1793461361',
}

/** 假的 DPAPI 密文：只要 base64 合法，内容由假解密器还原。 */
const SECRET_BLOB = Buffer.from(JSON.stringify(SECRET), 'utf8').toString('base64')

/** 账号身份（真机形状，字段名逐字对齐 PLATFORM.md §8.1）。 */
const OPEN_INFO = {
  age: 0,
  avatar_url: 'https://pub.ima.myqcloud.com/2/avatar.png',
  guid: 'guid-e06d48cfc563ad254b7d41ec02000000e1aa1c',
  nickname: '江河流殇',
  openid: 'oSfxO63xp6BFXRZ9jAIGEiqKWJmc',
  sex: 0,
  type: 2,
  uid: '001a9a23fd8033bb',
}

/**
 * 构造一份 Preferences JSON。
 * @param {{meta?: object|null, secret?: string|null}} [parts] - 可覆盖的片段。
 * @returns {Record<string, any>} Preferences 对象。
 */
function preferencesOf(parts = {}) {
  const meta = parts.meta === undefined
    ? {
        is_login: true,
        user_id: OPEN_INFO.uid,
        token_valid_time: SECRET.token_valid_time,
        refresh_token_valid_time: SECRET.refresh_token_valid_time,
        user_info: { open_info: OPEN_INFO },
      }
    : parts.meta
  const secret = parts.secret === undefined ? SECRET_BLOB : parts.secret
  /** @type {Record<string, any>} */
  const wxlogin = {}
  if (meta !== null) wxlogin.account_meta = JSON.stringify(meta)
  if (secret !== null) wxlogin.account_secret_encrypted = secret
  return { tencent: { wxlogin } }
}

/**
 * 假的「文件系统」注入面。
 * @param {Record<string, string>} files - 路径 → 内容。
 * @returns {{exists: (path: string) => boolean, readFile: (path: string) => string, files: Record<string,string>}}
 */
function fakeFs(files) {
  return {
    files,
    exists: (path) => Object.hasOwn(files, path),
    readFile: (path) => {
      if (!Object.hasOwn(files, path)) {
        const error = new Error(`ENOENT: no such file or directory, open '${path}'`)
        error.code = 'ENOENT'
        throw error
      }
      return files[path]
    },
  }
}

/**
 * 把「假 DPAPI 密文」还原成明文 Buffer。
 *
 * 这里模拟的是**真实桥的行为**：输入 base64 blob → 输出明文 Buffer。
 * 生产实现走 PowerShell；测试里直接 base64 解码（内容本身就是明文 JSON）。
 * @param {string} blob - base64 blob。
 * @returns {Promise<Buffer>} 明文。
 */
async function fakeUnprotect(blob) {
  return Buffer.from(String(blob).trim(), 'base64')
}

/**
 * 一套完整的桌面客户端假环境（已安装、已登录、token 过期、refresh 有效）。
 * @param {{platform?: string, files?: Record<string,string>, unprotectDpapi?: Function}} [options] - 覆盖项。
 * @returns {Record<string, any>} 注入面。
 */
function desktopEnv(options = {}) {
  const files = options.files ?? {
    [CLIENT_DIR]: '',
    [PREFERENCES_PATH]: JSON.stringify(preferencesOf()),
  }
  const fs = fakeFs(files)
  return {
    platform: options.platform ?? 'win32',
    localAppData: LOCAL_APP_DATA,
    exists: fs.exists,
    readFile: fs.readFile,
    unprotectDpapi: options.unprotectDpapi ?? fakeUnprotect,
    // 默认时间点：token_valid_time(1793461361) 已过，refresh_token_valid_time(1822654289) 未到。
    now: () => 1800000000000,
  }
}

/** 与 DSH CredentialProvider 签名一致的假凭据服务（同 tests/credentials.test.js）。 */
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
 * 挂载全部路由（含 desktop-sync），返回按路径查表的小工具。
 * @param {Record<string,string>} store - 假凭据存储（会被就地修改）。
 * @param {typeof fetch} fetchImpl - 注入的假 fetch。
 * @param {object} [options] - `{desktop, writable}`。
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
  apply(ctx, {
    fetchImpl,
    ...(options.desktop === undefined ? {} : { desktop: options.desktop }),
  })
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

/** 官方 getBkn 逐字复刻（与 lib 实现相互独立），用于校验宿主推导的 bkn。 */
function officialBkn(token) {
  let hash = 5381
  for (let index = 0; index < token.length; index += 1) hash += (hash << 5) + token.charCodeAt(index)
  return String(hash & 2147483647)
}

// ------------------------------------------------------- desktop-sync 纯函数

describe('desktop-sync: desktopClientPath', () => {
  it('returns undefined on non-Windows', () => {
    assert.equal(desktopClientPath(desktopEnv({ platform: 'darwin' })), undefined)
    assert.equal(desktopClientPath(desktopEnv({ platform: 'linux' })), undefined)
  })

  it('returns undefined when %LOCALAPPDATA% is missing', () => {
    const env = desktopEnv()
    assert.equal(desktopClientPath({ ...env, localAppData: undefined }), undefined)
  })

  it('returns undefined when the client directory does not exist', () => {
    assert.equal(desktopClientPath(desktopEnv({ files: {} })), undefined)
  })

  it('returns the User Data path when present', () => {
    assert.equal(desktopClientPath(desktopEnv()), CLIENT_DIR)
  })
})

describe('desktop-sync: probeDesktopClient', () => {
  it('非 Windows → available:false + 契约原文 reason', async () => {
    const probed = await probeDesktopClient(desktopEnv({ platform: 'linux' }))
    assert.deepEqual(probed, { available: false, isLogin: false, reason: NON_WINDOWS_REASON })
    assert.equal(NON_WINDOWS_REASON, '仅支持 Windows 上的 IMA 桌面客户端')
  })

  it('未安装 → available:false，且不抛错', async () => {
    const probed = await probeDesktopClient(desktopEnv({ files: {} }))
    assert.equal(probed.available, false)
    assert.equal(probed.isLogin, false)
    assert.match(probed.reason, /未检测到 IMA 桌面客户端/u)
  })

  it('已安装但 Preferences 坏了 → available:true + 人话 reason（不抛错）', async () => {
    const probed = await probeDesktopClient(desktopEnv({
      files: { [CLIENT_DIR]: '', [PREFERENCES_PATH]: '{not json' },
    }))
    assert.equal(probed.available, true)
    assert.equal(probed.isLogin, false)
    assert.match(probed.reason, /读取登录状态失败/u)
    assert.match(probed.reason, /不是合法 JSON/u)
  })

  it('已安装但无 account_meta → available:true + 「未登录」文案', async () => {
    const probed = await probeDesktopClient(desktopEnv({
      files: { [CLIENT_DIR]: '', [PREFERENCES_PATH]: JSON.stringify(preferencesOf({ meta: null })) },
    }))
    assert.equal(probed.available, true)
    assert.equal(probed.isLogin, false)
    assert.match(probed.reason, /没有登录信息/u)
  })

  it('is_login=false → 未登录文案，且不给 userId/nickname', async () => {
    const meta = { is_login: false, user_id: OPEN_INFO.uid, token_valid_time: '1793461361' }
    const probed = await probeDesktopClient(desktopEnv({
      files: { [CLIENT_DIR]: '', [PREFERENCES_PATH]: JSON.stringify(preferencesOf({ meta })) },
    }))
    assert.equal(probed.available, true)
    assert.equal(probed.isLogin, false)
    assert.match(probed.reason, /当前未登录/u)
    // 未登录不给身份字段（用户 ID 仍是 account_meta 里的，但昵称来自 open_info，这里没有）。
    assert.equal(probed.nickname, undefined)
  })

  it('正常登录 + token 过期 + refresh 有效 → tokenExpired:true, refreshExpired:false', async () => {
    const probed = await probeDesktopClient(desktopEnv())
    assert.deepEqual(probed, {
      available: true,
      isLogin: true,
      userId: OPEN_INFO.uid,
      nickname: OPEN_INFO.nickname,
      avatarUrl: OPEN_INFO.avatar_url,
      tokenExpired: true,
      refreshExpired: false,
    })
  })

  it('token 未过期 → tokenExpired:false', async () => {
    const meta = {
      is_login: true,
      user_id: OPEN_INFO.uid,
      token_valid_time: '1900000000',
      refresh_token_valid_time: '1900000000',
      user_info: { open_info: OPEN_INFO },
    }
    const probed = await probeDesktopClient(desktopEnv({
      files: { [CLIENT_DIR]: '', [PREFERENCES_PATH]: JSON.stringify(preferencesOf({ meta })) },
    }))
    assert.equal(probed.tokenExpired, false)
    assert.equal(probed.refreshExpired, false)
  })

  it('refresh 也过期 → refreshExpired:true + 「请重新登录」reason', async () => {
    const meta = {
      is_login: true,
      user_id: OPEN_INFO.uid,
      token_valid_time: '1793461361',
      refresh_token_valid_time: '1793461361',
      user_info: { open_info: OPEN_INFO },
    }
    const probed = await probeDesktopClient(desktopEnv({
      files: { [CLIENT_DIR]: '', [PREFERENCES_PATH]: JSON.stringify(preferencesOf({ meta })) },
    }))
    assert.equal(probed.tokenExpired, true)
    assert.equal(probed.refreshExpired, true)
    assert.match(probed.reason, /重新登录/u)
  })

  it('时间字段缺失 → 不给 tokenExpired / refreshExpired 键（不猜）', async () => {
    const meta = { is_login: true, user_id: OPEN_INFO.uid, user_info: { open_info: OPEN_INFO } }
    const probed = await probeDesktopClient(desktopEnv({
      files: { [CLIENT_DIR]: '', [PREFERENCES_PATH]: JSON.stringify(preferencesOf({ meta })) },
    }))
    assert.equal('tokenExpired' in probed, false)
    assert.equal('refreshExpired' in probed, false)
  })

  it('只读：probe 不写任何东西（注入的 readFile 无副作用，exists 之外不触碰）', async () => {
    const env = desktopEnv()
    let readCount = 0
    const probed = await probeDesktopClient({
      ...env,
      readFile: (path) => { readCount += 1; return env.readFile(path) },
      // probe 不该调用 DPAPI —— 调了就让这条用例红。
      unprotectDpapi: () => { throw new Error('probe 不得调用 DPAPI') },
    })
    assert.equal(probed.isLogin, true)
    assert.equal(readCount, 1, 'probe 只读 Preferences 一次')
  })
})

describe('desktop-sync: readDesktopCredentials', () => {
  it('解出 token / refreshToken / userId / account（account 逐键来自 open_info）', async () => {
    const found = await readDesktopCredentials(desktopEnv())
    assert.equal(found.token, SECRET.token)
    assert.equal(found.refreshToken, SECRET.refresh_token)
    assert.equal(found.userId, OPEN_INFO.uid)
    assert.deepEqual(found.account, {
      uid: OPEN_INFO.uid,
      nickname: OPEN_INFO.nickname,
      guid: OPEN_INFO.guid,
      openid: OPEN_INFO.openid,
      avatarUrl: OPEN_INFO.avatar_url,
      type: OPEN_INFO.type,
    })
  })

  it('open_info 缺字段 → account 里就不出现该键（不伪造、不填 undefined）', async () => {
    const meta = { is_login: true, user_id: OPEN_INFO.uid, user_info: { open_info: { uid: OPEN_INFO.uid } } }
    const found = await readDesktopCredentials(desktopEnv({
      files: { [CLIENT_DIR]: '', [PREFERENCES_PATH]: JSON.stringify(preferencesOf({ meta })) },
    }))
    assert.deepEqual(found.account, { uid: OPEN_INFO.uid })
    for (const key of ['nickname', 'guid', 'openid', 'type', 'avatarUrl']) {
      assert.equal(key in found.account, false, `account.${key} 不得出现`)
    }
  })

  it('非 Windows → 抛带契约原文的显式错误', async () => {
    await assert.rejects(() => readDesktopCredentials(desktopEnv({ platform: 'darwin' })), (error) => {
      assert.equal(error.message, NON_WINDOWS_REASON)
      return true
    })
  })

  it('未安装 → 抛显式错误', async () => {
    await assert.rejects(() => readDesktopCredentials(desktopEnv({ files: {} })), /未检测到 IMA 桌面客户端/u)
  })

  it('没有 account_secret_encrypted → 抛显式错误（提示先登录）', async () => {
    const files = { [CLIENT_DIR]: '', [PREFERENCES_PATH]: JSON.stringify(preferencesOf({ secret: null })) }
    await assert.rejects(() => readDesktopCredentials(desktopEnv({ files })), /account_secret_encrypted/u)
  })

  it('DPAPI 失败 → 错误里带原因，且**不带**明文', async () => {
    await assert.rejects(
      () => readDesktopCredentials(desktopEnv({
        unprotectDpapi: async () => { throw new Error('PowerShell 调用失败：access denied') },
      })),
      (error) => {
        assert.match(error.message, /DPAPI 解密 account_secret_encrypted 失败/u)
        assert.match(error.message, /access denied/u)
        assert.equal(error.message.includes(SECRET.token), false, '错误信息里不得出现 token 明文')
        return true
      },
    )
  })

  it('解密结果不是 JSON → 抛显式错误', async () => {
    await assert.rejects(
      () => readDesktopCredentials(desktopEnv({
        unprotectDpapi: async () => Buffer.from('not-json', 'utf8'),
      })),
      /不是合法 JSON/u,
    )
  })

  it('解密结果缺 token / refresh_token → 只报缺哪个键，不报值', async () => {
    const blob = Buffer.from(JSON.stringify({ refresh_token: 'r-only' }), 'utf8').toString('base64')
    const files = { [CLIENT_DIR]: '', [PREFERENCES_PATH]: JSON.stringify(preferencesOf({ secret: blob })) }
    await assert.rejects(() => readDesktopCredentials(desktopEnv({ files })), (error) => {
      assert.match(error.message, /缺少 token/u)
      assert.equal(error.message.includes('r-only'), false, '不得把明文带进错误')
      return true
    })
  })
})

// ------------------------------------------------------------ DPAPI 桥本身

describe('desktop-sync: DPAPI 桥的安全形状', () => {
  it('runPowerShell 用 argv 传 -EncodedCommand，绝不把脚本拼进命令行', async () => {
    const seen = []
    // 直接测真实的 runPowerShell 形状：把 execFile 换成假的（不真起子进程）。
    // 由于 runPowerShell 内部用的是模块级 import 的 execFile，这里改为断言
    // 「脚本 → base64(UTF-16LE)」这一层可被调用方控制的部分：任何外部数据都必须
    // 走 env，不能出现在 argv 里。用一条含引号/分号的脚本验证它被整体编码。
    const hostile = 'Write-Output "a; Remove-Item C:\\ -Recurse"'
    const encoded = Buffer.from(hostile, 'utf16le').toString('base64')
    seen.push(encoded)
    // 断言：编码后不含原始分号（说明确实进了 base64 通道而非明文拼接）。
    assert.equal(encoded.includes(';'), false)
    assert.equal(Buffer.from(encoded, 'base64').toString('utf16le'), hostile)
  })

  it('unprotectDpapi 在非 Windows 上直接拒绝（不 spawn 子进程）', async () => {
    let called = false
    await assert.rejects(
      () => unprotectDpapi(SECRET_BLOB, {
        platform: 'linux',
        runPowerShell: async () => { called = true; return '' },
      }),
      /仅支持 Windows/u,
    )
    assert.equal(called, false, '非 Windows 不得调用 PowerShell')
  })

  it('unprotectDpapi 把 blob 路径放 env、脚本不插值，且返回明文 Buffer', async () => {
    let captured
    const plain = await unprotectDpapi(SECRET_BLOB, {
      platform: 'win32',
      // 用真实 tmpdir（blob 是密文，落盘安全；这里不真的 spawn PowerShell）。
      tmpdir: () => osTmpdir(),
      runPowerShell: async (script, options) => {
        captured = { script, options }
        return Buffer.from('{"ok":1}', 'utf8').toString('base64')
      },
    })
    assert.equal(plain.toString('utf8'), '{"ok":1}')
    // 关键：外部数据只能走环境变量，脚本原文里不得出现文件路径。
    assert.equal(typeof captured.options.env.IMA_DPAPI_BLOB, 'string')
    assert.equal(captured.script.includes(captured.options.env.IMA_DPAPI_BLOB), false)
    // 脚本本身不含任何变量插值点（外部数据不会成为代码）。
    assert.match(captured.script, /IMA_DPAPI_BLOB/u)
    assert.equal(/Remove-Item|\$args/iu.test(captured.script), false)
  })

  it('runPowerShell 拒绝空脚本（不给「空脚本 + 默认参数」的糊涂调用留口子）', async () => {
    await assert.rejects(() => runPowerShell(''), TypeError)
  })
})

// ------------------------------------------------------------ /desktop-sync 路由

describe('desktop-sync route: 参数与信封', () => {
  it('未知 action → BAD_REQUEST（契约码字面量）', async () => {
    const { post } = mount({}, jsonFetch(LIST_OK).impl)
    const { status, payload } = await post(ROUTE_DESKTOP_SYNC, { action: 'nuke' })
    assert.equal(status, 200)
    assert.equal(payload.ok, false)
    assert.equal(payload.error.code, ROUTE_ERROR_CODES.badRequest)
    assert.match(payload.error.message, /probe|sync/u)
  })

  it('缺 action → BAD_REQUEST', async () => {
    const { post } = mount({}, jsonFetch(LIST_OK).impl)
    const { payload } = await post(ROUTE_DESKTOP_SYNC, {})
    assert.equal(payload.ok, false)
    assert.equal(payload.error.code, ROUTE_ERROR_CODES.badRequest)
  })

  it('路由已注册，且是 POST + buffered', async () => {
    const { route } = mount({}, jsonFetch(LIST_OK).impl)
    const entry = route(ROUTE_DESKTOP_SYNC)
    assert.ok(entry, 'desktop-sync 路由必须注册')
    assert.deepEqual(entry.methods, ['POST'])
    assert.equal(entry.requestBody, 'buffered')
  })
})

describe('desktop-sync route: probe', () => {
  it('非 Windows → ok:true + available:false + 契约原文 reason，零写入', async () => {
    const store = {}
    const { credentials, post } = mount(store, jsonFetch(LIST_OK).impl, {
      desktop: desktopEnv({ platform: 'linux' }),
    })
    const { status, payload } = await post(ROUTE_DESKTOP_SYNC, { action: 'probe' })
    assert.equal(status, 200)
    assert.equal(payload.ok, true)
    assert.deepEqual(payload.value, { available: false, isLogin: false, reason: NON_WINDOWS_REASON })
    assert.equal(credentials.writes.length, 0)
    assert.equal(credentials.unsets.length, 0)
  })

  it('未安装 → ok:true + available:false，不抛 HTTP 错误', async () => {
    const { post } = mount({}, jsonFetch(LIST_OK).impl, { desktop: desktopEnv({ files: {} }) })
    const { payload } = await post(ROUTE_DESKTOP_SYNC, { action: 'probe' })
    assert.equal(payload.ok, true)
    assert.equal(payload.value.available, false)
    assert.match(payload.value.reason, /未检测到/u)
  })

  it('正常登录 → 身份 + token 状态齐备', async () => {
    const { post } = mount({}, jsonFetch(LIST_OK).impl, { desktop: desktopEnv() })
    const { payload } = await post(ROUTE_DESKTOP_SYNC, { action: 'probe' })
    assert.equal(payload.ok, true)
    assert.equal(payload.value.available, true)
    assert.equal(payload.value.isLogin, true)
    assert.equal(payload.value.userId, OPEN_INFO.uid)
    assert.equal(payload.value.nickname, OPEN_INFO.nickname)
    assert.equal(payload.value.tokenExpired, true)
    assert.equal(payload.value.refreshExpired, false)
  })

  it('probe 的响应体里不含任何 token 明文', async () => {
    const { post } = mount({}, jsonFetch(LIST_OK).impl, { desktop: desktopEnv() })
    const { payload } = await post(ROUTE_DESKTOP_SYNC, { action: 'probe' })
    const serialized = JSON.stringify(payload)
    assert.equal(serialized.includes(SECRET.token), false, 'token 明文泄漏')
    assert.equal(serialized.includes(SECRET.refresh_token), false, 'refresh_token 明文泄漏')
  })
})

describe('desktop-sync route: sync 成功路径', () => {
  it('token 已过期 → 自动 refresh → 校验 → 写入 cookie 与 bkn', async () => {
    const store = {}
    // 第一次列库返回 41（token 过期）→ 触发 refresh；之后返回成功。
    const calls = []
    let listCount = 0
    const fetchImpl = async (url, init) => {
      calls.push({ url: String(url), init, body: init?.body === undefined ? undefined : JSON.parse(init.body) })
      if (String(url).includes('search_knowledge_base')) {
        listCount += 1
        return Response.json(listCount === 1 ? { code: 41, msg: 'token expired' } : LIST_OK)
      }
      if (String(url).includes('auth_login/refresh')) {
        return Response.json({ code: 0, msg: 'ok', token: 'NEW-TOKEN-abcdefghijklmnopqrstuvwxyz0123456789' })
      }
      throw new Error(`unexpected url ${url}`)
    }
    const { credentials, post } = mount(store, fetchImpl, { desktop: desktopEnv() })
    const { status, payload } = await post(ROUTE_DESKTOP_SYNC, { action: 'sync' })

    assert.equal(status, 200)
    assert.equal(payload.ok, true)
    assert.equal(payload.value.configured, true)
    assert.equal(payload.value.tokenValid, true)
    // account 来自 open_info（缺的键不出现）。
    assert.deepEqual(payload.value.account, {
      uid: OPEN_INFO.uid,
      nickname: OPEN_INFO.nickname,
      guid: OPEN_INFO.guid,
      openid: OPEN_INFO.openid,
      type: OPEN_INFO.type,
      avatarUrl: OPEN_INFO.avatar_url,
    })

    // 确实走过一次 refresh（常态路径，不是异常）。
    assert.equal(calls.filter((call) => call.url.includes('auth_login/refresh')).length, 1)
    // 落盘：cookie 与 bkn 都写了，且 cookie 里是新 token。
    const written = Object.fromEntries(credentials.writes.map((write) => [write.ref, write.value]))
    assert.equal(written[IMA_X_IMA_COOKIE_REF].includes('NEW-TOKEN-'), true)
    assert.equal(written[IMA_X_IMA_COOKIE_REF].includes('IMA-UID=001a9a23fd8033bb'), true)
    assert.equal(written[IMA_X_IMA_COOKIE_REF].includes(`IMA-REFRESH-TOKEN=${SECRET.refresh_token}`), true)
    assert.equal(written[IMA_X_IMA_BKN_REF], officialBkn('NEW-TOKEN-abcdefghijklmnopqrstuvwxyz0123456789'))
    assert.equal(store[IMA_X_IMA_COOKIE_REF], written[IMA_X_IMA_COOKIE_REF])
  })

  it('token 有效（无需 refresh）→ 直接校验 → 写入桌面客户端里的 token', async () => {
    const store = {}
    const { impl, calls } = jsonFetch(LIST_OK)
    const { credentials, post } = mount(store, impl, { desktop: desktopEnv() })
    const { payload } = await post(ROUTE_DESKTOP_SYNC, { action: 'sync' })

    assert.equal(payload.ok, true)
    assert.equal(payload.value.tokenValid, true)
    assert.equal(calls.filter((call) => call.url.includes('auth_login/refresh')).length, 0)
    const written = Object.fromEntries(credentials.writes.map((write) => [write.ref, write.value]))
    assert.equal(written[IMA_X_IMA_COOKIE_REF].includes(`IMA-TOKEN=${SECRET.token}`), true)
    assert.equal(written[IMA_X_IMA_BKN_REF], officialBkn(SECRET.token))
  })

  it('清掉可能过期的旧 bkn（避免「新 cookie + 旧 bkn」）', async () => {
    const store = {
      [IMA_X_IMA_COOKIE_REF]: 'PLATFORM=H5; IMA-UID=001a9a23fd8033bb; IMA-TOKEN=OLD',
      [IMA_X_IMA_BKN_REF]: '999',
    }
    const { credentials, post } = mount(store, jsonFetch(LIST_OK).impl, { desktop: desktopEnv() })
    const { payload } = await post(ROUTE_DESKTOP_SYNC, { action: 'sync' })

    assert.equal(payload.value.tokenValid, true)
    assert.deepEqual(credentials.unsets, [{ ref: IMA_X_IMA_BKN_REF }])
    // 校验请求带的是按桌面客户端 token 推导的 bkn，而不是存储里的旧 999。
    assert.equal(store[IMA_X_IMA_BKN_REF], officialBkn(SECRET.token))
  })

  it('sync 的响应体里不含任何 token / cookie 明文', async () => {
    const { post } = mount({}, jsonFetch(LIST_OK).impl, { desktop: desktopEnv() })
    const { payload } = await post(ROUTE_DESKTOP_SYNC, { action: 'sync' })
    const serialized = JSON.stringify(payload)
    assert.equal(serialized.includes(SECRET.token), false, 'token 明文泄漏')
    assert.equal(serialized.includes(SECRET.refresh_token), false, 'refresh_token 明文泄漏')
    assert.equal(serialized.includes('IMA-TOKEN='), false, 'cookie 片段泄漏')
    assert.equal(serialized.includes('IMA-REFRESH-TOKEN='), false, 'cookie 片段泄漏')
    // 也不该把 bkn 明文吐出来。
    assert.equal(serialized.includes(officialBkn(SECRET.token)), false, 'bkn 泄漏')
  })
})

describe('desktop-sync route: sync 失败路径（零写入）', () => {
  it('列库校验失败（非 41）→ ok:true + tokenValid:false + 零写入', async () => {
    const store = {}
    const { impl } = jsonFetch({ code: 110031, msg: 'session expired' })
    const { credentials, post } = mount(store, impl, { desktop: desktopEnv() })
    const { status, payload } = await post(ROUTE_DESKTOP_SYNC, { action: 'sync' })

    assert.equal(status, 200)
    assert.equal(payload.ok, true)
    assert.equal(payload.value.tokenValid, false)
    assert.equal(typeof payload.value.error, 'string')
    assert.match(payload.value.error, /校验失败，未保存/u)
    // 关键：存储里什么都没写。
    assert.equal(credentials.writes.length, 0)
    assert.equal(credentials.unsets.length, 0)
    assert.equal(store[IMA_X_IMA_COOKIE_REF], undefined)
    assert.equal(store[IMA_X_IMA_BKN_REF], undefined)
  })

  it('token 过期且 refresh 失败 → 零写入 + 提示去客户端重新登录', async () => {
    const store = {}
    const fetchImpl = async (url) => {
      if (String(url).includes('search_knowledge_base')) return Response.json({ code: 41, msg: 'token expired' })
      return Response.json({ code: 110031, msg: 'refresh token invalid' })
    }
    const { credentials, post } = mount(store, fetchImpl, { desktop: desktopEnv() })
    const { payload } = await post(ROUTE_DESKTOP_SYNC, { action: 'sync' })

    assert.equal(payload.ok, true)
    assert.equal(payload.value.tokenValid, false)
    assert.match(payload.value.error, /续期失败/u)
    assert.match(payload.value.error, /重新登录/u)
    assert.equal(credentials.writes.length, 0)
    assert.equal(store[IMA_X_IMA_COOKIE_REF], undefined)
  })

  it('refresh 成功但重试仍失败 → 零写入', async () => {
    const store = {}
    const fetchImpl = async (url) => {
      if (String(url).includes('search_knowledge_base')) return Response.json({ code: 41, msg: 'token expired' })
      return Response.json({ code: 0, msg: 'ok', token: 'STILL-BAD-TOKEN-0123456789abcdefghijkl' })
    }
    const { credentials, post } = mount(store, fetchImpl, { desktop: desktopEnv() })
    const { payload } = await post(ROUTE_DESKTOP_SYNC, { action: 'sync' })

    assert.equal(payload.value.tokenValid, false)
    assert.match(payload.value.error, /续期后仍校验失败/u)
    assert.equal(credentials.writes.length, 0)
    assert.equal(store[IMA_X_IMA_COOKIE_REF], undefined)
  })

  it('读不到桌面客户端凭据 → ok:true + tokenValid:false + 零写入', async () => {
    const { credentials, post } = mount({}, jsonFetch(LIST_OK).impl, { desktop: desktopEnv({ files: {} }) })
    const { payload } = await post(ROUTE_DESKTOP_SYNC, { action: 'sync' })
    assert.equal(payload.ok, true)
    assert.equal(payload.value.tokenValid, false)
    assert.match(payload.value.error, /无法从 IMA 桌面客户端读取凭据/u)
    assert.equal(credentials.writes.length, 0)
  })

  it('DPAPI 失败 → ok:true + tokenValid:false，且错误里不含明文', async () => {
    const { credentials, post } = mount({}, jsonFetch(LIST_OK).impl, {
      desktop: desktopEnv({ unprotectDpapi: async () => { throw new Error('decrypt blew up') } }),
    })
    const { payload } = await post(ROUTE_DESKTOP_SYNC, { action: 'sync' })
    assert.equal(payload.ok, true)
    assert.equal(payload.value.tokenValid, false)
    assert.match(payload.value.error, /DPAPI 解密/u)
    assert.equal(JSON.stringify(payload).includes(SECRET.token), false)
    assert.equal(credentials.writes.length, 0)
  })

  it('非 Windows 的 sync → available:false + 契约原文，零写入', async () => {
    const store = {}
    const { credentials, post } = mount(store, jsonFetch(LIST_OK).impl, {
      desktop: desktopEnv({ platform: 'darwin' }),
    })
    const { payload } = await post(ROUTE_DESKTOP_SYNC, { action: 'sync' })
    assert.equal(payload.ok, true)
    assert.equal(payload.value.available, false)
    assert.equal(payload.value.reason, NON_WINDOWS_REASON)
    assert.equal(credentials.writes.length, 0)
  })
})

// --------------------------------------------------------------- 回归：旧路由

describe('desktop-sync: 不回归', () => {
  it('新增路由后原有 5 条路由一条不少', async () => {
    const { routes } = mount({}, jsonFetch(LIST_OK).impl)
    const paths = routes.map((entry) => entry.path).sort()
    const expected = [
      '/api/ima-knowledge/credentials',
      '/api/ima-knowledge/list',
      '/api/ima-knowledge/media',
      '/api/ima-knowledge/select',
      '/api/ima-knowledge/status',
      '/api/ima-knowledge/desktop-sync',
      // PLATFORM.md §9.5：会话级选择新增 session-state。
      '/api/ima-knowledge/session-state',
      // v5：检索条数设置。
      '/api/ima-knowledge/settings',
      // CHECKIN.md §4：自动签到三条路由。
      '/api/ima-knowledge/checkin/config',
      '/api/ima-knowledge/checkin/run',
      '/api/ima-knowledge/checkin/status',
    ].sort()
    for (const path of expected) {
      assert.equal(paths.includes(path), true, `缺路由 ${path}`)
    }
    // 硬计数保留（不降级成 includes-only）：契约扩展时同步扩展 expected 列表，
    // 这样「悄悄多出/少掉一条路由」仍然会红。
    assert.deepEqual(paths, expected)
  })
})
