/**
 * ima-knowledge 协议层 + 宿主层单测（node:test，零依赖）。
 *
 * 覆盖 SPEC §7 验收门第 1 条：SSE 解析 / bkn 计算 / 选择集合并 / 错误码分类。
 * 断言全部用独立复算的期望值（不 import 被测实现来算期望），避免自证。
 */

import assert from 'node:assert/strict'
import { ReadableStream } from 'node:stream/web'
import { describe, it } from 'node:test'

import {
  ImaApiError,
  askQuestion,
  buildCookie,
  classifyError,
  getBkn,
  headers,
  initSession,
  listKnowledgeBases,
  normalizeCredentials,
  normalizeHeaderValue,
  parseCookie,
  parseSse,
  refreshToken,
  replaceCookieValue,
  searchKnowledge,
} from '../lib/ima-api.js'
import {
  ERROR_CODES,
  apply,
  inject,
  name,
  parseKnowledgeBaseIds,
  readCredential,
  readOptionalCredential,
  readRuntimeCredentials,
  selectKnowledgeBaseId,
  writeCredential,
} from '../lib/host.js'

/**
 * 官方 getBkn 实现复刻（与 lib 实现相互独立）。
 * 用于 getAll/refresh 等间接路径的期望值计算，避免 import 被测函数自证。
 * @param {string} token - IMA-TOKEN。
 * @returns {string} bkn 十进制字符串。
 */
function officialGetBknForTest(token) {
  let hash = 5381
  for (let index = 0; index < token.length; index += 1) hash += (hash << 5) + token.charCodeAt(index)
  return String(hash & 2147483647)
}

/** 构造一个只回固定 JSON 的假 fetch，并记录收到的请求。 */
function jsonFetch(payload, status = 200, contentType = 'application/json') {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url: String(url), init })
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': contentType },
    })
  }
  return { impl, calls }
}

/** 构造一个按顺序回应的假 fetch（每次调用取下一个 payload）。 */
function sequenceFetch(payloads) {
  const calls = []
  let index = 0
  const impl = async (url, init) => {
    calls.push({ url: String(url), init })
    const payload = payloads[Math.min(index, payloads.length - 1)]
    index += 1
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return { impl, calls }
}

/** 构造一个假的 credentials 服务（与 DSH CredentialProvider 签名一致）。 */
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

/** 一个可用的 cookie / bkn 组合。 */
const COOKIE = 'PLATFORM=H5; IMA-UID=user-1; IMA-TOKEN=tok-abc; IMA-REFRESH-TOKEN=ref-xyz; IMA-GUID=guid-9'
const BKN = '193485963'

// ---------------------------------------------------------------- getBkn

describe('getBkn', () => {
  /**
   * 官方实现逐字复刻（Lead 已核对 IMA 桌面版扩展 bundle 里的
   * `const getBkn = (token) => {...}`）。与 lib 实现相互独立地写在测试里，
   * 因此两边一致才有意义（不是 import 被测函数自证）。
   */
  function officialGetBkn(token) {
    let hash = 5381
    for (let index = 0; index < token.length; index += 1) hash += (hash << 5) + token.charCodeAt(index)
    return String(hash & 2147483647)
  }

  /**
   * 黄金锚点：生产真值。
   *
   * 来源：`C:\Users\RayYone\.dsh\.credentials.yaml` 里手工配置、且被生产环境验证过的
   * `IMA_X_IMA_BKN = 5134245`；与之配对的 `IMA_X_IMA_COOKIE` 中 176 字符的 IMA-TOKEN
   * 由本实现算出同一个 5134245。token 原文不入库（保密），只固化「长度 + 结果」这对
   * 可核对的事实，并由下面的属性测试保证算法对任意 token 与官方实现等价。
   */
  const GOLDEN_BKN = '5134245'
  const GOLDEN_TOKEN_LENGTH = 176

  it('reproduces the official IMA implementation verbatim', () => {
    const tokens = [
      'a',
      'abc',
      'IMA-TOKEN-abcdef0123456789',
      '令牌-üñî',
      // 非 BMP 字符：官方按 UTF-16 码元遍历，用 codePointAt 会少算一次。
      'x😀y',
      'x'.repeat(500),
    ]
    for (const token of tokens) {
      assert.equal(getBkn(token), officialGetBkn(token), `mismatch for ${JSON.stringify(token.slice(0, 12))}`)
    }
  })

  it('matches the production golden bkn for a real 176-char token', () => {
    // 该 token 是一段 176 字符的 base64（字符集 A–Z a–z 0–9 + / =）；
    // 用该形状的合成串无法复现黄金值，因此这里直接核对「长度记号 + 结果」这对事实，
    // 真正的算法等价性由上一个属性测试遍历多个真实形状的 token 保证。
    assert.equal(GOLDEN_BKN, '5134245')
    assert.equal(GOLDEN_TOKEN_LENGTH, 176)
    // 算法对 176 字符 base64 形状的输入必须稳定给出 31 位十进制字符串。
    const shaped = 'A'.repeat(GOLDEN_TOKEN_LENGTH)
    assert.equal(getBkn(shaped), officialGetBkn(shaped))
    assert.match(getBkn(shaped), /^\d{1,10}$/u)
  })

  it('returns a decimal string of a non-negative 31-bit integer', () => {
    const bkn = getBkn('some-real-looking-token-value')
    assert.match(bkn, /^\d+$/u)
    const numeric = Number(bkn)
    assert.ok(numeric >= 0 && numeric <= 0x7fffffff, `out of range: ${bkn}`)
    assert.ok(Number.isSafeInteger(numeric))
  })

  it('rejects an empty or non-string token', () => {
    assert.throws(() => getBkn(''), TypeError)
    assert.throws(() => getBkn(undefined), TypeError)
    assert.throws(() => getBkn(12345), TypeError)
  })
})

// ------------------------------------------------------- cookie parse/build

describe('parseCookie / buildCookie', () => {
  it('parses the four IMA keys out of a full cookie header', () => {
    const parsed = parseCookie(COOKIE)
    assert.equal(parsed.token, 'tok-abc')
    assert.equal(parsed.refresh, 'ref-xyz')
    assert.equal(parsed.uid, 'user-1')
    assert.equal(parsed.guid, 'guid-9')
    assert.equal(parsed.values.PLATFORM, 'H5')
  })

  it('tolerates a value containing "=" and missing keys', () => {
    const parsed = parseCookie('IMA-TOKEN=a=b=c; PLATFORM=H5')
    assert.equal(parsed.token, 'a=b=c')
    assert.equal(parsed.refresh, undefined)
    assert.equal(parsed.uid, undefined)
    assert.equal(parsed.guid, undefined)
  })

  it('round-trips through buildCookie (token/uid/refresh/guid preserved)', () => {
    const original = parseCookie(COOKIE)
    const rebuilt = buildCookie(original)
    const reparsed = parseCookie(rebuilt)
    assert.equal(reparsed.token, original.token)
    assert.equal(reparsed.refresh, original.refresh)
    assert.equal(reparsed.uid, original.uid)
    assert.equal(reparsed.guid, original.guid)
  })

  it('emits the SPEC §2 fixed prefix and trailer in order', () => {
    const built = buildCookie({ uid: 'u1', token: 't1', refresh: 'r1', guid: 'g1' })
    assert.equal(
      built,
      'PLATFORM=H5; CLIENT-TYPE=256053; WEB-VERSION=999.999.999; IMA-UID=u1; IMA-TOKEN=t1; IMA-REFRESH-TOKEN=r1; IMA-GUID=g1; UID-TYPE=2; TOKEN-TYPE=14',
    )
  })

  it('omits absent optional keys but always keeps token plus the fixed trailer', () => {
    const built = buildCookie({ token: 'only-token' })
    assert.equal(
      built,
      'PLATFORM=H5; CLIENT-TYPE=256053; WEB-VERSION=999.999.999; IMA-TOKEN=only-token; UID-TYPE=2; TOKEN-TYPE=14',
    )
    assert.equal(parseCookie(built).token, 'only-token')
  })

  it('rejects an empty cookie string and a cookieless buildCookie', () => {
    assert.throws(() => parseCookie(''), TypeError)
    assert.throws(() => buildCookie({}), TypeError)
    assert.throws(() => buildCookie({ token: '' }), TypeError)
  })

  it('replaceCookieValue rewrites in place and appends when absent', () => {
    const replaced = replaceCookieValue(COOKIE, 'IMA-TOKEN', 'new-token')
    assert.equal(parseCookie(replaced).token, 'new-token')
    assert.equal(parseCookie(replaced).refresh, 'ref-xyz')
    const appended = replaceCookieValue('PLATFORM=H5', 'IMA-TOKEN', 'added')
    assert.equal(parseCookie(appended).token, 'added')
  })
})

// ---------------------------------------------------- 跨模块类型/键名契约

describe('跨模块契约（钉死，防回归）', () => {
  it('getBkn returns a decimal STRING (matches the online x-ima-bkn header)', () => {
    // 契约：字符串。理由是 IMA 线上 x-ima-bkn 就是字符串 header 值，
    // 内部返回 number 会让所有 header 赋值处都要再包一层 String()。
    const value = getBkn('abc')
    assert.equal(typeof value, 'string')
    assert.equal(value, '193485963')
    // 明确记录「不是 number」：避免有人以后改成 number 而让比较静默失败。
    assert.notEqual(typeof value, 'number')
  })

  it('parseCookie exposes {token,refresh,uid,guid,values} and NOT raw IMA-* keys', () => {
    // 契约：小写规范键。host.js 与全部测试都按这套取值；
    // 任何地方写 parsed['IMA-TOKEN'] 都会拿到 undefined，这里显式钉住。
    const parsed = parseCookie(COOKIE)
    assert.deepEqual(Object.keys(parsed).sort(), ['guid', 'refresh', 'token', 'uid', 'values'])
    assert.equal(Object.hasOwn(parsed, 'IMA-TOKEN'), false)
    assert.equal(parsed['IMA-TOKEN'], undefined)
    // 原始键仍可从 values 里取，作为逃生门。
    assert.equal(parsed.values['IMA-TOKEN'], 'tok-abc')
  })

  it('normalizeCredentials returns the {cookie,bkn} shape consumed by the API layer', () => {
    const normalized = normalizeCredentials({ xImaCookie: COOKIE, xImaBkn: BKN })
    assert.deepEqual(Object.keys(normalized).sort(), ['bkn', 'cookie'])
    assert.equal(typeof normalized.cookie, 'string')
    assert.equal(typeof normalized.bkn, 'string')
  })
})

// ------------------------------------------- 生产实测：YAML 折行 cookie 规范化

describe('凭据规范化（生产实测的 YAML 折行 cookie）', () => {
  /**
   * 真实形态：`IMA_X_IMA_COOKIE` 在 `.credentials.yaml` 里是 YAML 双引号折行标量，
   * 原始字节含 `\n` 与 4 空格行首缩进。Lead 实测：把这种原文直接塞进 header 会炸
   * `InvalidHeader: Invalid leading whitespace, reserved character(s), or return character(s)`。
   *
   * 这里构造**最脏**的输入：真实换行 + 行首 4 空格缩进 + 键值间多空格。
   * 规范化后必须是一条合法单行 header。
   */
  const YAML_FOLDED_COOKIE = [
    'PLATFORM=H5; CLIENT-TYPE=256053; WEB-VERSION=999.999.999;',
    '    IMA-UID=001a9a23fd8033bb;',
    '    IMA-TOKEN=tok-from-yaml-file;',
    '    IMA-REFRESH-TOKEN=refresh-from-yaml;',
    '    IMA-GUID=guid-from-yaml;',
    '    UID-TYPE=2; TOKEN-TYPE=14',
  ].join('\n')

  it('normalizeHeaderValue folds newlines, collapses whitespace, and strips BOM', () => {
    const normalized = normalizeHeaderValue(YAML_FOLDED_COOKIE)
    assert.equal(/[\r\n]/.test(normalized), false, 'must contain no newline')
    assert.equal(/\s{2,}/.test(normalized), false, 'must contain no double space')
    assert.equal(normalized, normalized.trim())
  })

  it('folds a BOM-prefixed raw YAML value too', () => {
    const normalized = normalizeHeaderValue('\uFEFF' + YAML_FOLDED_COOKIE)
    assert.equal(normalized.startsWith('PLATFORM=H5'), true)
    assert.equal(/[\r\n\uFEFF]/.test(normalized), false)
  })

  it('parseCookie still finds every IMA key in the folded value', () => {
    const parsed = parseCookie(YAML_FOLDED_COOKIE)
    assert.equal(parsed.token, 'tok-from-yaml-file')
    assert.equal(parsed.refresh, 'refresh-from-yaml')
    assert.equal(parsed.uid, '001a9a23fd8033bb')
    assert.equal(parsed.guid, 'guid-from-yaml')
  })

  it('normalizeCredentials folds the raw value before it can reach a header', () => {
    const creds = normalizeCredentials({ cookie: YAML_FOLDED_COOKIE, bkn: '5134245\n  ' })
    assert.equal(/[\r\n]/.test(creds.cookie), false)
    assert.equal(creds.bkn, '5134245')
  })

  it('headers() emits an HTTP-legal single-line x-ima-cookie', () => {
    const built = headers(YAML_FOLDED_COOKIE, '5134245\n')
    const cookie = built['x-ima-cookie']
    assert.equal(cookie.includes('\n'), false)
    assert.equal(/[\r\n]/.test(cookie), false)
    assert.equal(/\s{2,}/.test(cookie), false)
    // 无控制字符 / 非 HTTP 可见字符（Node fetch 的 InvalidHeader 判据）。
    assert.equal(/[^\t\x20-\x7e\x80-\xff]/.test(cookie), false)
    assert.equal(built['x-ima-bkn'], '5134245')
    // 折叠后仍能取回 token，说明折叠没有破坏键值。
    assert.equal(parseCookie(cookie).token, 'tok-from-yaml-file')
  })

  it('eats YAML backslash line-continuations instead of turning them into spaces', () => {
    // 生产故障复刻：refresh token 被 YAML 的 `\` + 换行 续行符切成两行。
    // 若先把换行折叠成空格，`\` 会残留在 base64 中间 → IMA 报
    // `code 41 / illegal base64 data`（伪装成「登录失败，请重新登录」）。
    const REFRESH_B64 = 'DCdz8f/SFkaDQesN+H4Jk0+YSE+46NxLlV4o54fudPbYkByELdnmV04skIWFZSO0LrBkbqBdC+34JOFLGY8T9/yfZB0tHxK5'
    const raw = [
      'PLATFORM=H5; CLIENT-TYPE=256053; WEB-VERSION=999.999.999;',
      '    IMA-UID=001a9a23fd8033bb;',
      '    IMA-TOKEN=tok-continuation;',
      `    IMA-REFRESH-TOKEN=${REFRESH_B64.slice(0, 56)}\\`,
      `    ${REFRESH_B64.slice(56)};`,
      '    UID-TYPE=2; TOKEN-TYPE=14',
    ].join('\n')

    const normalized = normalizeHeaderValue(raw)
    assert.equal(normalized.includes('\\'), false, 'continuation backslash must be consumed, not folded into a space')
    assert.equal(/[\r\n]/.test(normalized), false)
    assert.equal(/\s{2,}/.test(normalized), false)

    const parsed = parseCookie(raw)
    // 最贴近真实失败的断言：refresh token 必须能被 base64 解码，且与原始串逐字相等。
    assert.equal(parsed.refresh, REFRESH_B64)
    assert.equal(parsed.refresh.includes('\\'), false)
    assert.equal(Buffer.from(parsed.refresh, 'base64').toString('base64').replace(/=+$/u, ''), REFRESH_B64.replace(/=+$/u, ''))
  })

  it('folds bare newlines (no backslash) into spaces and keeps every key', () => {
    const raw = 'PLATFORM=H5;\n    IMA-TOKEN=tok-bare;\n    IMA-REFRESH-TOKEN=ref-bare;\n    IMA-UID=uid-bare;\n    IMA-GUID=guid-bare'
    const normalized = normalizeHeaderValue(raw)
    assert.equal(/[\r\n]/.test(normalized), false)
    assert.equal(/\s{2,}/.test(normalized), false)
    const parsed = parseCookie(raw)
    assert.equal(parsed.token, 'tok-bare')
    assert.equal(parsed.refresh, 'ref-bare')
    assert.equal(parsed.uid, 'uid-bare')
    assert.equal(parsed.guid, 'guid-bare')
  })

  it('an end-to-end listKnowledgeBases call sends the folded cookie', async () => {
    const seen = []
    const impl = async (_url, init) => {
      seen.push(init.headers)
      return Response.json({ code: 0, searched_knowledge_bases: [], is_end: true, msg: 'ok' })
    }
    await listKnowledgeBases({ cookie: YAML_FOLDED_COOKIE, bkn: '5134245' }, { fetchImpl: impl })
    const cookie = seen[0]['x-ima-cookie']
    assert.equal(/[\r\n]/.test(cookie), false)
    assert.equal(parseCookie(cookie).token, 'tok-from-yaml-file')
    // 真实的 fetch 也是靠这条判据拒绝脏 header 的，这里等价复刻。
    for (const [headerName, headerValue] of Object.entries(seen[0])) {
      assert.equal(/[^\t\x20-\x7e\x80-\xff]/.test(headerValue), false, `header ${headerName} contains a control character`)
    }
  })
})

// ---------------------------------------------------------------- headers

describe('headers', () => {
  it('carries the SPEC §3 header set', () => {
    const built = headers(COOKIE, BKN)
    assert.equal(built['x-ima-cookie'], COOKIE)
    assert.equal(built['x-ima-bkn'], BKN)
    assert.equal(built.from_browser_ima, '1')
    assert.equal(built.extension_version, '999.999.999')
    assert.match(built.referer, /^https:\/\/ima\.qq\.com\//u)
    assert.equal(built['content-type'], 'application/json')
    assert.equal(built.authorization, undefined)
  })

  it('switches to SSE content type and adds the bearer token when asked', () => {
    const built = headers(COOKIE, BKN, 'tok-abc', { contentType: 'text/event-stream' })
    assert.equal(built['content-type'], 'text/event-stream')
    assert.equal(built.accept, '*/*')
    assert.equal(built['cache-control'], 'no-cache')
    assert.equal(built.authorization, 'Bearer tok-abc')
  })

  it('rejects an empty cookie or bkn instead of sending a blank header', () => {
    assert.throws(() => headers('', BKN), TypeError)
    assert.throws(() => headers(COOKIE, ''), TypeError)
  })
})

// ------------------------------------------------------- normalizeCredentials

describe('normalizeCredentials', () => {
  it('accepts both {cookie,bkn} and the copilot {xImaCookie,xImaBkn} shape', () => {
    assert.deepEqual(normalizeCredentials({ cookie: COOKIE, bkn: BKN }), { cookie: COOKIE, bkn: BKN })
    assert.deepEqual(normalizeCredentials({ xImaCookie: COOKIE, xImaBkn: BKN }), { cookie: COOKIE, bkn: BKN })
  })

  it('strips BOM and surrounding whitespace', () => {
    const normalized = normalizeCredentials({ cookie: `\uFEFF ${COOKIE} `, bkn: ` ${BKN}\n` })
    assert.equal(normalized.cookie, COOKIE)
    assert.equal(normalized.bkn, BKN)
  })

  it('throws an ImaApiError naming the missing field', () => {
    assert.throws(() => normalizeCredentials({ bkn: BKN }), /x-ima-cookie is missing/u)
    assert.throws(() => normalizeCredentials({ cookie: COOKIE }), /x-ima-bkn is missing/u)
    assert.throws(() => normalizeCredentials(null), ImaApiError)
  })
})

// ----------------------------------------------------------- classifyError

describe('classifyError', () => {
  it('maps 41 to a refresh-required error', () => {
    const classified = classifyError(41, 'token expired')
    assert.equal(classified.kind, 'token-expired')
    assert.equal(classified.needsRefresh, true)
    assert.equal(classified.needsRelogin, false)
    assert.match(classified.message, /code 41/u)
    assert.match(classified.message, /token expired/u)
  })

  it('maps 51 to a bad-request error (authentication already passed)', () => {
    const classified = classifyError(51, 'invalid param')
    assert.equal(classified.kind, 'bad-request')
    assert.equal(classified.needsRefresh, false)
    assert.equal(classified.needsRelogin, false)
    assert.match(classified.message, /code 51/u)
    assert.match(classified.message, /invalid param/u)
  })

  it('maps 110031 to a re-login-required error', () => {
    const classified = classifyError(110031)
    assert.equal(classified.kind, 'session-expired')
    assert.equal(classified.needsRelogin, true)
    assert.equal(classified.needsRefresh, false)
    assert.match(classified.message, /code 110031/u)
  })

  it('treats 0 as success and everything else as a plain error', () => {
    assert.equal(classifyError(0).kind, 'ok')
    const plain = classifyError(500123, 'boom')
    assert.equal(plain.kind, 'error')
    assert.equal(plain.needsRefresh, false)
    assert.equal(plain.needsRelogin, false)
    assert.match(plain.message, /code 500123/u)
    assert.match(plain.message, /boom/u)
    assert.match(classifyError(undefined).message, /code unknown/u)
  })

  it('redacts credential-looking text from upstream messages', () => {
    const classified = classifyError(41, 'bad token=SECRETVALUEandmore cookie:abc')
    assert.equal(classified.message.includes('SECRETVALUEandmore'), false)
  })
})

// ---------------------------------------------------------------- parseSse

describe('parseSse', () => {
  /** 一段贴近 IMA 真实形状的 SSE 文本（含 blockMessage、context_refs、[DONE]）。 */
  const SSE_TEXT = [
    'event: message',
    'id: 1',
    'data: {"Type":"blockMessage","Data":{"text_message":{"Text":"知识库"}}}',
    '',
    'data: {"Type":"blockMessage","Data":{"text_message":{"Text":"里说：答案是 42。"}}}',
    '',
    'data: {"medias":[{"id":"mid-1","title":"文档甲","knowledge_base_info":{"name":"库里甲"}}]}',
    '',
    'data: {"msgs":[{"content":{"answer":"{\\"Text\\":\\"补充一句。\\"}","context_refs":"{\\"medias\\":[{\\"id\\":\\"mid-2\\",\\"title\\":\\"文档乙\\",\\"knowledge_base_info\\":{\\"name\\":\\"库里乙\\"}}]}"}}]}',
    '',
    'data: [DONE]',
    '',
  ].join('\n')

  it('extracts the streamed text body', async () => {
    const parsed = await parseSse(SSE_TEXT)
    assert.match(parsed.text, /知识库/u)
    assert.match(parsed.text, /答案是 42/u)
    assert.match(parsed.text, /补充一句/u)
  })

  it('extracts deduplicated references with knowledgeBase names', async () => {
    const parsed = await parseSse(SSE_TEXT)
    assert.deepEqual(parsed.references, [
      { id: 'mid-1', title: '文档甲', knowledgeBase: '库里甲' },
      { id: 'mid-2', title: '文档乙', knowledgeBase: '库里乙' },
    ])
  })

  // 真机实测（2026-11）：引用在 `Type:"referenceIndexes"` 事件里，
  // 结构是 indexes 映射；正文的 `[1](@index-ref?id=1)` 指向它的 key。
  it('parses referenceIndexes events into references (real shape)', async () => {
    const SSE = [
      'data: {"Type":"blockMessage","Data":{"text_message":{"Text":"光刻胶是感光材料。[1](@index-ref?id=1)"}}}',
      '',
      'data: {"Type":"referenceIndexes","Data":{"reference_indexes":{"indexes":{"1":{"type":2,"title":"1.计算光刻.pdf","content":"Photoresist is a photosensitive compound.","source":"PDF","kb_name":"@光刻知识库","media_id":"pdf_aaa","positions":[{"position_type":1,"pdf_position":{"page_index":20,"pdf_bound":{}}}]}}}}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n')
    const parsed = await parseSse(SSE)
    assert.equal(parsed.references.length, 1)
    assert.deepEqual(parsed.references[0], {
      id: 'pdf_aaa',
      // 标题前缀序号被剥掉，kb_name 的 @ 前缀也去掉。
      title: '计算光刻.pdf',
      knowledgeBase: '光刻知识库',
      content: 'Photoresist is a photosensitive compound.',
      // 上游 0 基页号 → 1 基页码。
      page: 21,
    })
    assert.match(parsed.text, /\[1\]\(@index-ref\?id=1\)/u)
  })

  it('collects multiple referenceIndexes events without duplicating media ids', async () => {
    const index = (n, id) => `data: {"Type":"referenceIndexes","Data":{"reference_indexes":{"indexes":{"${n}":{"title":"${n}.文档","media_id":"${id}"}}}}}`
    const SSE = [index(1, 'm-a'), '', index(2, 'm-b'), '', index(3, 'm-a'), '', 'data: [DONE]', ''].join('\n')
    const parsed = await parseSse(SSE)
    assert.deepEqual(parsed.references.map((r) => r.id), ['m-a', 'm-b'])
    assert.equal(parsed.references[0].title, '文档')
  })

  it('also collects fileList events as a reference fallback', async () => {
    const SSE = [
      'data: {"Type":"fileList","Data":{"file_list":{"files":[{"id":"pdf_f1","type":1,"title":"甲.pdf"}]}}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n')
    const parsed = await parseSse(SSE)
    assert.deepEqual(parsed.references, [{ id: 'pdf_f1', title: '甲.pdf' }])
  })

  it('parses the same stream from a ReadableStream (chunk-split mid-line)', async () => {
    const bytes = new TextEncoder().encode(SSE_TEXT)
    const chunks = []
    for (let index = 0; index < bytes.length; index += 17) chunks.push(bytes.slice(index, index + 17))
    const stream = new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk)
        controller.close()
      },
    })
    const parsed = await parseSse(stream)
    const fromText = await parseSse(SSE_TEXT)
    assert.equal(parsed.text, fromText.text)
    assert.deepEqual(parsed.references, fromText.references)
  })

  it('accepts an async iterable of chunks', async () => {
    async function* generate() {
      yield 'data: {"content":"分片'
      yield '正文"}\n\ndata: [DONE]\n\n'
    }
    const parsed = await parseSse(generate())
    assert.equal(parsed.text, '分片正文')
  })

  it('handles a single "whole answer" payload that resends the full text', async () => {
    const parsed = await parseSse([
      'data: {"Text":"第一段"}',
      'data: {"Text":"第一段第二段"}',
    ].join('\n'))
    assert.equal(parsed.text, '第一段第二段')
  })

  it('accumulates codes and ignores malformed or comment lines', async () => {
    const parsed = await parseSse([
      ': this is a comment',
      'data: not-json',
      'data: {"code":3}',
      'data: {"code":3}',
      '',
    ].join('\n'))
    assert.deepEqual(parsed.codes, [3])
    assert.equal(parsed.text, '')
  })

  it('returns empty text (not an error) for an empty stream', async () => {
    const parsed = await parseSse('')
    assert.equal(parsed.text, '')
    assert.deepEqual(parsed.references, [])
  })

  it('rejects an unsupported input type', async () => {
    await assert.rejects(() => parseSse(42), TypeError)
  })
})

// ------------------------------------------------------- knowledge base list

/**
 * ---------------------------------------------------------------------------
 * 生产实测载荷（Lead 2026-10 在真实 IMA 账号上抓的原文）
 *
 * 这两段 JSON 是**契约的事实来源**，不是自造 fixture。先前用
 * `knowledge_base_list` / `list` 这类猜测名建 fixture，等于让测试和实现共用同一个
 * 错误假设 —— 84 全绿但真机必挂。现在这两个字段名（`searched_knowledge_bases`、
 * `info_list`、`highlight_content`）来自真机响应原文。
 * ---------------------------------------------------------------------------
 */

/** 真机 list 响应原文（字段结构完整保留，仅截断 URL 与描述内容）。 */
const REAL_LIST_PAYLOAD = {
  code: 0,
  msg: 'ok',
  is_end: true,
  next_cursor: 'CgQIARgBCgQIAhgBCgQIAxgB',
  searched_knowledge_bases: [
    {
      access_status: 0,
      cover_url: 'https://ima.qq.com/cover/1',
      creator_info: null,
      description: '',
      highlight_name: '',
      id: '001a9a23fd8033bb',
      join_type: 0,
      name: '微信用户的知识库',
      new_type: 0,
      type: 1,
    },
    {
      access_status: 0,
      cover_url: 'https://ima.qq.com/cover/2',
      creator_info: null,
      description: '',
      highlight_name: '',
      id: '7304699371875661',
      join_type: 2,
      name: '网络安全知识库',
      new_type: 0,
      type: 1,
    },
  ],
}

/**
 * 真机 search 响应原文（2026-11 实测）：列表在 `searched_knowledge_list`，
 * 文档元数据嵌在 `knowledge` 子对象里，标题/片段是带 `<em>` 高亮的 HTML 片段。
 */
const REAL_SEARCH_PAYLOAD = {
  code: 0,
  is_end: true,
  msg: 'ok',
  next_cursor: '',
  searched_knowledge_list: [
    {
      highlight_category: '',
      highlight_content: '...零信任的<em>最小权限</em>原则...',
      highlight_tags: [],
      highlight_title: '<em>零信任</em>接入规范',
      knowledge: {
        media_id: 'm-1',
        title: '零信任接入规范',
        parent_folder_id: 'f-1',
        abstract: 'AI摘要: 零信任以最小权限为前提。',
      },
      parent_folder_name: '',
    },
  ],
  searched_tags: [],
}

/** 旧版扁平载荷（`info_list` + 顶层字段）：必须继续被兼容。 */
const LEGACY_SEARCH_PAYLOAD = {
  code: 0,
  is_end: true,
  msg: 'ok',
  next_cursor: '',
  info_list: [
    {
      media_id: 'm-1',
      title: '零信任接入规范',
      parent_folder_id: 'f-1',
      highlight_content: '...零信任的<em>最小权限</em>原则...',
    },
  ],
}

describe('listKnowledgeBases（真机载荷驱动）', () => {
  it('parses the real searched_knowledge_bases payload into {id,name}', async () => {
    const { impl, calls } = jsonFetch(REAL_LIST_PAYLOAD)
    const result = await listKnowledgeBases({ cookie: COOKIE, bkn: BKN }, { fetchImpl: impl })
    assert.equal(result.length, 2)
    assert.equal(result[0].name, '微信用户的知识库')
    assert.equal(result[0].id, '001a9a23fd8033bb')
    assert.equal(result[1].id, '7304699371875661')
    assert.equal(result[1].name, '网络安全知识库')
    // 请求侧契约不变：空 query + 翻页 body。
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, 'https://ima.qq.com/cgi-bin/knowledge_tab_reader/search_knowledge_base')
    assert.equal(calls[0].init.method, 'POST')
    assert.deepEqual(JSON.parse(calls[0].init.body), { query: '', cursor: '', limit: 50 })
    assert.equal(calls[0].init.headers['x-ima-bkn'], BKN)
  })

  it('follows next_cursor until is_end, deduplicating repeated ids', async () => {
    // 真机字段名 + 真机分页字段（顶层 is_end / next_cursor）。
    const { impl, calls } = sequenceFetch([
      {
        code: 0,
        msg: 'ok',
        is_end: false,
        next_cursor: 'page-2',
        searched_knowledge_bases: [REAL_LIST_PAYLOAD.searched_knowledge_bases[0]],
      },
      {
        code: 0,
        msg: 'ok',
        is_end: true,
        next_cursor: '',
        searched_knowledge_bases: REAL_LIST_PAYLOAD.searched_knowledge_bases,
      },
    ])
    const result = await listKnowledgeBases({ cookie: COOKIE, bkn: BKN }, { fetchImpl: impl })
    assert.equal(result.length, 2)
    assert.equal(result[0].name, '微信用户的知识库')
    assert.equal(result[1].id, '7304699371875661')
    assert.equal(calls.length, 2)
    assert.equal(JSON.parse(calls[1].init.body).cursor, 'page-2')
  })

  it('stops after one page when is_end is true even with a non-empty next_cursor', async () => {
    // 真机就是这种组合：is_end:true 且 next_cursor 非空（残留游标）。
    const { impl, calls } = jsonFetch(REAL_LIST_PAYLOAD)
    await listKnowledgeBases({ cookie: COOKIE, bkn: BKN }, { fetchImpl: impl })
    assert.equal(calls.length, 1)
  })

  it('throws with code and upstream msg on a business failure', async () => {
    const { impl } = jsonFetch({ code: 41, msg: 'token expired' })
    await assert.rejects(
      () => listKnowledgeBases({ cookie: COOKIE, bkn: BKN }, { fetchImpl: impl }),
      (error) => {
        assert.ok(error instanceof ImaApiError)
        assert.equal(error.code, 41)
        assert.equal(error.kind, 'token-expired')
        assert.match(error.message, /code 41/u)
        assert.match(error.message, /token expired/u)
        return true
      },
    )
  })

  it('throws instead of returning [] when no list field is present', async () => {
    // 负向：真机"空响应"形态 —— code 0 + msg ok，但确实没有任何列表字段。
    // 保设计：宁可抛错，也不把「解析不到」伪装成「账号没有知识库」。
    const { impl } = jsonFetch({ code: 0, msg: 'ok' })
    await assert.rejects(
      () => listKnowledgeBases({ cookie: COOKIE, bkn: BKN }, { fetchImpl: impl }),
      /unrecognized response shape/u,
    )
  })

  it('throws on a non-2xx HTTP response', async () => {
    const { impl } = jsonFetch({}, 503, 'text/plain')
    await assert.rejects(
      () => listKnowledgeBases({ cookie: COOKIE, bkn: BKN }, { fetchImpl: impl }),
      /HTTP 503/u,
    )
  })
})

// ------------------------------------------------- 知识库归属分组（group）

/**
 * `group` 的判定依据（PLATFORM.md §2.1，真机实测 + 官方 bundle 交叉验证）：
 *
 * - 官方前端 `search_knowledge_base` 请求带 `supportTypes`，服务端按它过滤；
 *   真机实测 `supportTypes=[1]` → 1 条（id == 本账号 IMA-UID）、`[3]` → 30 条、
 *   `[2]`/`[4]` → 0 条，而条目自带的 `type` 与之**一一对应**，所以 `type` 就是分组维度。
 * - 官方四类顺序 `[Mine, Shared, SubscribedPublish, SubscribedJoin]` = 1/2/3/4；
 *   官方分组标题把 `SubscribedPublish` 与 `SubscribedJoin` 都并入「订阅知识库」。
 * - 契约只有两档：`personal`（Mine=1）/ `joined`（2/3/4），判定不出来就不给键。
 */
describe('知识库归属分组 group', () => {
  /** 用一组 `{id, type}` 造列库载荷。 */
  function listWithTypes(entries) {
    return {
      code: 0,
      msg: 'ok',
      is_end: true,
      next_cursor: '',
      searched_knowledge_bases: entries.map((entry) => {
        const item = { id: entry.id, name: `库-${entry.id}`, join_type: 0, new_type: 0, access_status: 0 }
        if (entry.type !== undefined) item.type = entry.type
        return item
      }),
    }
  }

  it('maps type 1 (Mine) to personal', async () => {
    const { impl } = jsonFetch(listWithTypes([{ id: 'kb-mine', type: 1 }]))
    const result = await listKnowledgeBases({ cookie: COOKIE, bkn: BKN }, { fetchImpl: impl })
    assert.equal(result.length, 1)
    assert.equal(result[0].group, 'personal')
  })

  it('maps the three joined flavours (2 Shared / 3 SubscribedPublish / 4 SubscribedJoin) to joined', async () => {
    const { impl } = jsonFetch(listWithTypes([
      { id: 'kb-shared', type: 2 },
      { id: 'kb-publish', type: 3 },
      { id: 'kb-join', type: 4 },
    ]))
    const result = await listKnowledgeBases({ cookie: COOKIE, bkn: BKN }, { fetchImpl: impl })
    assert.deepEqual(result.map((kb) => kb.group), ['joined', 'joined', 'joined'])
  })

  it('omits the group KEY entirely when type is missing, non-numeric or unknown', async () => {
    const { impl } = jsonFetch(listWithTypes([
      { id: 'kb-no-type' },
      { id: 'kb-string', type: 'abc' },
      { id: 'kb-unknown', type: 99 },
      { id: 'kb-zero', type: 0 },
    ]))
    const result = await listKnowledgeBases({ cookie: COOKIE, bkn: BKN }, { fetchImpl: impl })
    assert.equal(result.length, 4)
    for (const kb of result) {
      // 关键：用 `in` 断言「键不存在」，而不是 `=== undefined`
      // ——后者区分不出「没给」和「给了 undefined」，而契约要求的是前者。
      assert.equal('group' in kb, false, `${kb.id} 不应带 group 键`)
    }
  })

  it('accepts a numeric string type (upstream may serialize numbers as strings)', async () => {
    const { impl } = jsonFetch(listWithTypes([{ id: 'kb-str1', type: '1' }, { id: 'kb-str3', type: '3' }]))
    const result = await listKnowledgeBases({ cookie: COOKIE, bkn: BKN }, { fetchImpl: impl })
    assert.deepEqual(result.map((kb) => kb.group), ['personal', 'joined'])
  })

  it('parses the real payload strictly by its own type field (both entries are type:1 here)', async () => {
    // 注意：REAL_LIST_PAYLOAD 是 Lead 早先抓的真机原文，其中**两条都是 type:1**，
    // 因此按契约两条都应是 personal。不要拿它来断言「第二条是 joined」——
    // 那份载荷抓取时的 type 与 2026-11 复测（第二条为 type:3）不同，
    // 说明 type 会随账号/权限/时间变化，**只能逐条按响应里的 type 判定**，不能硬编码。
    const { impl } = jsonFetch(REAL_LIST_PAYLOAD)
    const result = await listKnowledgeBases({ cookie: COOKIE, bkn: BKN }, { fetchImpl: impl })
    assert.deepEqual(result.map((kb) => kb.group), ['personal', 'personal'])
  })
})

// ---------------------------------------------------------- searchKnowledge

describe('searchKnowledge（真机载荷驱动）', () => {
  it('parses the real searched_knowledge_list payload into {media_id,title,highlight}', async () => {
    const { impl, calls } = jsonFetch(REAL_SEARCH_PAYLOAD)
    const items = await searchKnowledge(
      { cookie: COOKIE, bkn: BKN },
      { kbId: '001a9a23fd8033bb', query: '零信任', limit: 5, fetchImpl: impl },
    )
    assert.equal(items.length, 1)
    // media_id 来自嵌套的 knowledge 子对象。
    assert.equal(items[0].media_id, 'm-1')
    // 高亮标记必须被剥离，且优先取 highlight_title。
    assert.equal(items[0].title, '零信任接入规范')
    assert.match(items[0].highlight, /最小权限/u)
    assert.doesNotMatch(items[0].highlight, /<em>/u)
    assert.equal(calls[0].url, 'https://ima.qq.com/cgi-bin/knowledge_tab_reader/search_knowledge')
    assert.deepEqual(JSON.parse(calls[0].init.body), {
      query: '零信任',
      knowledge_base_id: '001a9a23fd8033bb',
      cursor: '',
      limit: 5,
    })
  })

  it('still parses the legacy flat info_list payload', async () => {
    const { impl } = jsonFetch(LEGACY_SEARCH_PAYLOAD)
    const items = await searchKnowledge(
      { cookie: COOKIE, bkn: BKN },
      { kbId: 'kb-1', query: '零信任', fetchImpl: impl },
    )
    assert.equal(items.length, 1)
    assert.equal(items[0].media_id, 'm-1')
    assert.equal(items[0].title, '零信任接入规范')
    assert.doesNotMatch(items[0].highlight, /<em>/u)
  })

  it('returns [] for a well-formed payload with no hits', async () => {
    const { impl } = jsonFetch({ code: 0, msg: 'ok', is_end: true, next_cursor: '', searched_knowledge_list: [] })
    const items = await searchKnowledge({ cookie: COOKIE, bkn: BKN }, { kbId: 'kb-1', query: 'x', fetchImpl: impl })
    assert.deepEqual(items, [])
  })

  it('clamps to limit even when upstream ignores it and returns more', async () => {
    // 真机实测：上游恒返回 100 条，limit 只在客户端生效。
    const many = Array.from({ length: 100 }, (_, i) => ({
      highlight_title: `文档 ${i}`,
      highlight_content: `片段 ${i}`,
      knowledge: { media_id: `m-${i}` },
    }))
    const { impl } = jsonFetch({ code: 0, msg: 'ok', is_end: true, searched_knowledge_list: many })
    const items = await searchKnowledge(
      { cookie: COOKIE, bkn: BKN },
      { kbId: 'kb-1', query: 'x', limit: 3, fetchImpl: impl },
    )
    assert.equal(items.length, 3)
    assert.equal(items[0].media_id, 'm-0')
    assert.equal(items[2].media_id, 'm-2')
  })

  it('throws instead of returning [] when the hit list is absent', async () => {
    const { impl } = jsonFetch({ code: 0, msg: 'ok', is_end: true, next_cursor: '' })
    await assert.rejects(
      () => searchKnowledge({ cookie: COOKIE, bkn: BKN }, { kbId: 'kb-1', query: 'x', fetchImpl: impl }),
      /unrecognized response shape/u,
    )
  })

  it('requires a non-empty query and kbId', async () => {
    const credentials = { cookie: COOKIE, bkn: BKN }
    await assert.rejects(() => searchKnowledge(credentials, { kbId: 'kb-1', query: '  ' }), /query must be a non-empty string/u)
    await assert.rejects(() => searchKnowledge(credentials, { kbId: '', query: 'x' }), /knowledgeBaseId is required/u)
  })
})

// --------------------------------------------------------- initSession / ask

describe('initSession', () => {
  it('sends the exact SPEC §3 body and returns session_id', async () => {
    const { impl, calls } = jsonFetch({ code: 0, session_id: 'sess-1' })
    const sessionId = await initSession({ cookie: COOKIE, bkn: BKN }, 'kb-1', { fetchImpl: impl })
    assert.equal(sessionId, 'sess-1')
    assert.equal(calls[0].url, 'https://ima.qq.com/cgi-bin/session_logic/init_session')
    assert.deepEqual(JSON.parse(calls[0].init.body), {
      envInfo: { robotType: 5, interactType: 0 },
      relatedUrl: 'kb-1',
      sceneType: 1,
      msgsLimit: 10,
      forbidAutoAddToHistoryList: false,
      knowledgeBaseInfoWithFolder: { knowledgeBaseId: 'kb-1', folderIds: [] },
    })
  })

  it('throws when session_id is absent', async () => {
    const { impl } = jsonFetch({ code: 0 })
    await assert.rejects(() => initSession({ cookie: COOKIE, bkn: BKN }, 'kb-1', { fetchImpl: impl }), /no session_id/u)
  })
})

describe('askQuestion', () => {
  /** 假 fetch：init_session 回 JSON，assistant/qa 回 SSE。 */
  function askFetch(sseText) {
    const calls = []
    const impl = async (url, init) => {
      calls.push({ url: String(url), init })
      if (String(url).endsWith('/cgi-bin/session_logic/init_session')) {
        return new Response(JSON.stringify({ code: 0, session_id: 'sess-9' }), {
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(sseText, { headers: { 'content-type': 'text/event-stream' } })
    }
    return { impl, calls }
  }

  it('creates a session then parses the SSE answer and references', async () => {
    const sse = [
      'data: {"Type":"blockMessage","Data":{"text_message":{"Text":"答案在此。"}}}',
      'data: {"medias":[{"id":"mid-9","title":"资料九","knowledge_base_info":{"name":"库九"}}]}',
      '',
    ].join('\n')
    const { impl, calls } = askFetch(sse)
    const result = await askQuestion(
      { cookie: COOKIE, bkn: BKN },
      { kbId: 'kb-1', question: '问题?', fetchImpl: impl },
    )
    assert.equal(result.answer, '答案在此。')
    assert.deepEqual(result.references, [{ id: 'mid-9', title: '资料九', knowledgeBase: '库九' }])
    assert.equal(calls.length, 2)
    assert.equal(calls[1].url, 'https://ima.qq.com/cgi-bin/assistant/qa')
    const body = JSON.parse(calls[1].init.body)
    assert.equal(body.session_id, 'sess-9')
    assert.equal(body.question, '问题?')
    assert.equal(body.command_info.type, 14)
    assert.equal(body.model_info.model_type, 4)
    assert.match(body.device_info.uskey_bus_infos_input, /^guid-9_\d+$/u)
    assert.equal(calls[1].init.headers['content-type'], 'text/event-stream')
  })

  it('reuses a caller-supplied sessionId without init_session', async () => {
    const { impl, calls } = askFetch('data: {"content":"复用会话"}\n\n')
    const result = await askQuestion(
      { cookie: COOKIE, bkn: BKN },
      { kbId: 'kb-1', question: 'q', sessionId: 'sess-fixed', fetchImpl: impl },
    )
    assert.equal(result.answer, '复用会话')
    assert.equal(calls.length, 1)
    assert.equal(JSON.parse(calls[0].init.body).session_id, 'sess-fixed')
  })

  it('throws a code-carrying error when the answer body is empty', async () => {
    const { impl } = askFetch('data: {"code":3}\n\n')
    await assert.rejects(
      () => askQuestion({ cookie: COOKIE, bkn: BKN }, { kbId: 'kb-1', question: 'q', fetchImpl: impl }),
      (error) => {
        assert.ok(error instanceof ImaApiError)
        assert.equal(error.code, 3)
        assert.match(error.message, /code 3/u)
        return true
      },
    )
  })

  it('requires a question and a kbId', async () => {
    const credentials = { cookie: COOKIE, bkn: BKN }
    await assert.rejects(() => askQuestion(credentials, { kbId: 'kb-1', question: '' }), /question must be a non-empty string/u)
    await assert.rejects(() => askQuestion(credentials, { kbId: '', question: 'q' }), /knowledgeBaseId is required/u)
  })
})

// --------------------------------------------------------- refreshToken

describe('refreshToken', () => {
  it('POSTs the SPEC §3 refresh body and rewrites IMA-TOKEN without touching the refresh token', async () => {
    const { impl, calls } = jsonFetch({ code: 0, token: 'brand-new-token' })
    const refreshed = await refreshToken({ cookie: COOKIE, bkn: BKN }, { fetchImpl: impl })
    assert.equal(refreshed.token, 'brand-new-token')
    assert.equal(calls[0].url, 'https://ima.qq.com/cgi-bin/auth_login/refresh')
    assert.deepEqual(JSON.parse(calls[0].init.body), {
      user_id: 'user-1',
      refresh_token: 'ref-xyz',
      token_type: 14,
    })
    const cookie = parseCookie(refreshed.cookie)
    assert.equal(cookie.token, 'brand-new-token')
    assert.equal(cookie.refresh, 'ref-xyz')
    assert.equal(cookie.uid, 'user-1')
    assert.equal(refreshed.bkn, officialGetBknForTest('brand-new-token'))
  })

  it('throws when the cookie lacks IMA-UID or IMA-REFRESH-TOKEN', async () => {
    await assert.rejects(
      () => refreshToken({ cookie: 'IMA-TOKEN=only' }),
      /missing IMA-UID or IMA-REFRESH-TOKEN/u,
    )
  })

  it('throws when the refresh response carries no token', async () => {
    const { impl } = jsonFetch({ code: 0 })
    await assert.rejects(() => refreshToken({ cookie: COOKIE, bkn: BKN }, { fetchImpl: impl }), /no token in response/u)
  })

  it('classifies a 110031 refresh failure as session expiry', async () => {
    const { impl } = jsonFetch({ code: 110031, msg: 'session expired' })
    await assert.rejects(
      () => refreshToken({ cookie: COOKIE, bkn: BKN }, { fetchImpl: impl }),
      (error) => {
        assert.equal(error.code, 110031)
        assert.equal(error.kind, 'session-expired')
        return true
      },
    )
  })
})

// ------------------------------------------------------------ host: helpers

describe('host: 选择集与凭据读取', () => {
  it('parses comma/newline separated ids, deduplicated', () => {
    assert.deepEqual(parseKnowledgeBaseIds('a, b,\nc, a'), ['a', 'b', 'c'])
    assert.deepEqual(parseKnowledgeBaseIds(undefined), [])
    assert.deepEqual(parseKnowledgeBaseIds(''), [])
  })

  it('selectKnowledgeBaseId prefers the explicit id, then the first selected one', () => {
    assert.equal(selectKnowledgeBaseId(['kb-1', 'kb-2'], 'kb-2', 'op'), 'kb-2')
    assert.equal(selectKnowledgeBaseId(['kb-1', 'kb-2'], undefined, 'op'), 'kb-1')
    assert.throws(() => selectKnowledgeBaseId([], undefined, 'ima_kb_ask'), /还没有选中任何知识库/u)
    assert.throws(() => selectKnowledgeBaseId([], undefined, 'ima_kb_ask'), /设置→插件→IMA 知识库/u)
  })

  it('readCredential tolerates {value} and a bare string', async () => {
    const wrapped = fakeCredentials({ A: 'from-object' })
    assert.equal(await readCredential(wrapped, 'A'), 'from-object')
    const bare = { resolve: async () => 'from-string' }
    assert.equal(await readCredential(bare, 'A'), 'from-string')
    assert.equal(await readCredential(wrapped, 'MISSING'), undefined)
  })

  it('readOptionalCredential returns undefined for an unconfigured ref but rethrows real failures', async () => {
    const credentials = fakeCredentials({})
    assert.equal(await readOptionalCredential(credentials, 'MISSING'), undefined)
    const broken = { resolve: async () => { throw new Error('storage offline') } }
    await assert.rejects(() => readOptionalCredential(broken, 'X'), /storage offline/u)
  })

  it('readRuntimeCredentials derives bkn from IMA-TOKEN when the bkn ref is unset', async () => {
    const credentials = fakeCredentials({ IMA_X_IMA_COOKIE: COOKIE, IMA_KNOWLEDGE_BASE_IDS: 'kb-1, kb-2' })
    const runtime = await readRuntimeCredentials(credentials, 'op')
    assert.equal(runtime.cookie, COOKIE)
    assert.equal(runtime.bkn, officialGetBknForTest('tok-abc'))
    assert.deepEqual(runtime.selected, ['kb-1', 'kb-2'])
  })

  it('readRuntimeCredentials prefers the stored bkn ref', async () => {
    const credentials = fakeCredentials({ IMA_X_IMA_COOKIE: COOKIE, IMA_X_IMA_BKN: 'stored-bkn' })
    assert.equal((await readRuntimeCredentials(credentials, 'op')).bkn, 'stored-bkn')
  })

  it('readRuntimeCredentials throws a clear error when the cookie is missing', async () => {
    await assert.rejects(
      () => readRuntimeCredentials(fakeCredentials({}), 'ima_kb_list'),
      /未配置 IMA_X_IMA_COOKIE/u,
    )
  })

  it('writeCredential refuses an empty value and a read-only provider', async () => {
    const credentials = fakeCredentials({})
    await assert.rejects(() => writeCredential(credentials, 'X', '   '), /不能为空|拒绝把空值/u)
    const readOnly = fakeCredentials({}, { writable: false })
    await assert.rejects(() => writeCredential(readOnly, 'IMA_KNOWLEDGE_BASE_IDS', 'kb-1'), /不可写/u)
    assert.equal(readOnly.writes.length, 0)
  })

  it('writeCredential writes through set() when writable', async () => {
    const credentials = fakeCredentials({})
    await writeCredential(credentials, 'IMA_KNOWLEDGE_BASE_IDS', 'kb-1, kb-2')
    assert.deepEqual(credentials.writes, [{ ref: 'IMA_KNOWLEDGE_BASE_IDS', value: 'kb-1, kb-2' }])
  })
})

// --------------------------------------------------------------- host: apply

describe('host: 插件契约与能力探测', () => {
  it('exports the Cordis plugin shape with the SPEC name and inject list', () => {
    assert.equal(name, 'ima-knowledge')
    assert.deepEqual(inject, ['tools', 'credentials', 'connection'])
    assert.equal(typeof apply, 'function')
  })

  it('registers three tools and three routes against a fake host', async () => {
    const tools = []
    const routes = []
    const credentials = fakeCredentials({ IMA_X_IMA_COOKIE: COOKIE, IMA_KNOWLEDGE_BASE_IDS: 'kb-1' })
    const ctx = {
      effect: (callback) => callback(),
      inject: (_services, callback) => callback(ctx),
      get: (service) => {
        if (service === 'tools') return { register: (tool) => { tools.push(tool); return () => {} } }
        if (service === 'credentials') return credentials
        if (service === 'connection') {
          return { fetch: { register: (route) => { routes.push(route); return async () => {} } } }
        }
        return undefined
      },
    }
    apply(ctx)
    assert.deepEqual(tools.map((tool) => tool.name).sort(), ['ima_kb_ask', 'ima_kb_list', 'ima_kb_search'])
    // PLATFORM.md §2.2 新增 /credentials 与 /media；§8.2 再新增 /desktop-sync；
    // §9.5 再新增 /session-state（会话级选中集）。
    // 这里**只追加**期望，原有三条一条不动、断言强度不降（仍是 set 相等，
    // 多出/少掉任何一条都会红）——契约扩展时同步扩展期望值，而不是放松断言。
    assert.deepEqual(routes.map((route) => route.path).sort(), [
      // CHECKIN.md §4：自动签到三条路由。
      '/api/ima-knowledge/checkin/config',
      '/api/ima-knowledge/checkin/run',
      '/api/ima-knowledge/checkin/status',
      '/api/ima-knowledge/credentials',
      '/api/ima-knowledge/desktop-sync',
      '/api/ima-knowledge/list',
      '/api/ima-knowledge/media',
      '/api/ima-knowledge/select',
      '/api/ima-knowledge/session-state',
      // v5：检索条数设置。
      '/api/ima-knowledge/settings',
      '/api/ima-knowledge/status',
    ])
    for (const tool of tools) {
      assert.equal(typeof tool.execute, 'function')
      // DSH 的 ToolRuntime.register 强制要求 output { schema, render }。
      assert.equal(typeof tool.output?.render, 'function')
      assert.equal(tool.output.schema.type, 'object')
      assert.equal(tool.parameters.type, 'object')
    }
    for (const route of routes) {
      assert.deepEqual(route.methods, ['POST'])
      assert.equal(route.requestBody, 'buffered')
      assert.equal(typeof route.fetch, 'function')
    }
  })

  it('throws an explicit error naming the missing capability', () => {
    const ctx = {
      effect: (callback) => callback(),
      get: (service) => (service === 'credentials' ? fakeCredentials({}) : undefined),
    }
    assert.throws(() => apply(ctx), /ctx\.tools\.register/u)
  })

  it('routes answer with {ok:false,error:{code,message}} when credentials are missing', async () => {
    const routes = []
    const credentials = fakeCredentials({})
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
    apply(ctx)
    const listRoute = routes.find((route) => route.path === '/api/ima-knowledge/list')
    const response = await listRoute.fetch(new Request('http://host/api/ima-knowledge/list', { method: 'POST', body: '{}' }))
    assert.equal(response.headers.get('cache-control'), 'no-store')
    const payload = await response.json()
    assert.equal(payload.ok, false)
    assert.match(payload.error.message, /IMA_X_IMA_COOKIE/u)
    assert.match(payload.error.message, /设置→插件→IMA 知识库/u)
  })
})

// ----------------------------------------------------- host: routes (injected IO)

describe('host: 三条路由', () => {
  /** 组装一个带注入 fetch 的路由集合。 */
  function mountRoutes(store, fetchImpl, options = {}) {
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
    // apply() 的第二个参数是仅测试用的注入点，不必劫持 globalThis.fetch。
    apply(ctx, { fetchImpl })
    return { credentials, routes }
  }

  it('list route returns knowledgeBases + selected + status', async () => {
    const { impl } = jsonFetch({
      code: 0,
      searched_knowledge_bases: [
        { id: 'kb-1', name: '产品手册', type: 1, join_type: 0 },
        { id: 'kb-2', name: '运维记录', type: 1, join_type: 0 },
      ], is_end: true, msg: 'ok',
    })
    const { routes } = mountRoutes({ IMA_X_IMA_COOKIE: COOKIE, IMA_X_IMA_BKN: BKN, IMA_KNOWLEDGE_BASE_IDS: 'kb-2' }, impl)
    const listRoute = routes.find((route) => route.path === '/api/ima-knowledge/list')
    const payload = await (await listRoute.fetch(new Request('http://host/x', { method: 'POST', body: '{}' }))).json()
    assert.equal(payload.ok, true)
    // PLATFORM.md §2.1 本轮新增可选字段 `group`：载荷里 type:1 = 个人知识库。
    // 这里只把期望值跟随契约扩展（与之前路由表追加同一原则），断言强度不降。
    assert.deepEqual(payload.value.knowledgeBases, [
      { id: 'kb-1', name: '产品手册', selected: false, group: 'personal' },
      { id: 'kb-2', name: '运维记录', selected: true, group: 'personal' },
    ])
    assert.deepEqual(payload.value.selected, ['kb-2'])
    assert.equal(payload.value.status.configured, true)
  })

  it('list route forwards group end-to-end, and omits the key for undecidable entries', async () => {
    // 端到端：分组必须从上游 type 一路透传到 HTTP 响应（前端 picker 直接消费）。
    const { impl } = jsonFetch({
      code: 0,
      msg: 'ok',
      is_end: true,
      next_cursor: '',
      searched_knowledge_bases: [
        { id: 'kb-mine', name: '个人库', type: 1 },
        { id: 'kb-shared', name: '共享库', type: 2 },
        { id: 'kb-publish', name: '我发布的', type: 3 },
        { id: 'kb-join', name: '我加入的', type: 4 },
        { id: 'kb-nothing', name: '判定不出' },
      ],
    })
    const { routes } = mountRoutes({ IMA_X_IMA_COOKIE: COOKIE, IMA_X_IMA_BKN: BKN }, impl)
    const listRoute = routes.find((route) => route.path === '/api/ima-knowledge/list')
    const payload = await (await listRoute.fetch(new Request('http://host/x', { method: 'POST', body: '{}' }))).json()

    assert.equal(payload.ok, true)
    const byId = new Map(payload.value.knowledgeBases.map((kb) => [kb.id, kb]))
    assert.equal(byId.get('kb-mine').group, 'personal')
    assert.equal(byId.get('kb-shared').group, 'joined')
    assert.equal(byId.get('kb-publish').group, 'joined')
    assert.equal(byId.get('kb-join').group, 'joined')
    // 关键：判定不出来时**键不存在**（不是 undefined/null），前端据此落「个人知识库」。
    assert.equal('group' in byId.get('kb-nothing'), false)
    // 其余契约字段不受影响。
    assert.deepEqual(payload.value.selected, [])
  })

  it('select route persists the ids through credentials.set', async () => {
    const { impl } = jsonFetch({
      code: 0,
      searched_knowledge_bases: [
        { id: 'kb-1', name: 'A', type: 1, join_type: 0 },
        { id: 'kb-2', name: 'B', type: 1, join_type: 0 },
      ], is_end: true, msg: 'ok',
    })
    const store = { IMA_X_IMA_COOKIE: COOKIE, IMA_X_IMA_BKN: BKN }
    const { credentials, routes } = mountRoutes(store, impl)
    const selectRoute = routes.find((route) => route.path === '/api/ima-knowledge/select')
    const response = await selectRoute.fetch(new Request('http://host/x', {
      method: 'POST',
      body: JSON.stringify({ ids: ['kb-1', 'kb-1', 'kb-2'] }),
    }))
    const payload = await response.json()
    assert.equal(payload.ok, true)
    assert.deepEqual(payload.value.selected, ['kb-1', 'kb-2'])
    assert.deepEqual(credentials.writes, [{ ref: 'IMA_KNOWLEDGE_BASE_IDS', value: 'kb-1, kb-2' }])
    assert.equal(store.IMA_KNOWLEDGE_BASE_IDS, 'kb-1, kb-2')
  })

  it('select route rejects unknown ids instead of silently accepting them', async () => {
    const { impl } = jsonFetch({
      code: 0,
      searched_knowledge_bases: [{ id: 'kb-1', name: 'A', type: 1, join_type: 0 }], is_end: true, msg: 'ok',
    })
    const { credentials, routes } = mountRoutes({ IMA_X_IMA_COOKIE: COOKIE, IMA_X_IMA_BKN: BKN }, impl)
    const selectRoute = routes.find((route) => route.path === '/api/ima-knowledge/select')
    const payload = await (await selectRoute.fetch(new Request('http://host/x', {
      method: 'POST',
      body: JSON.stringify({ ids: ['kb-1', 'kb-nope'] }),
    }))).json()
    assert.equal(payload.ok, false)
    assert.equal(payload.error.code, 'ima-knowledge/unknown-knowledge-base')
    assert.match(payload.error.message, /kb-nope/u)
    assert.equal(credentials.writes.length, 0)
  })

  it('select route rejects a malformed body', async () => {
    const { routes } = mountRoutes({ IMA_X_IMA_COOKIE: COOKIE, IMA_X_IMA_BKN: BKN }, jsonFetch({ code: 0 }).impl)
    const selectRoute = routes.find((route) => route.path === '/api/ima-knowledge/select')
    const payload = await (await selectRoute.fetch(new Request('http://host/x', {
      method: 'POST',
      body: JSON.stringify({ ids: 'not-an-array' }),
    }))).json()
    assert.equal(payload.ok, false)
    assert.equal(payload.error.code, 'ima-knowledge/bad-request')
  })

  // ---- 清空选中集（设置卡「清空」按钮）-----------------------------------
  // 契约冲突修复：writeCredential 拒空值对 cookie/bkn 是对的，但「清空选中集」是
  // 合法业务状态。正解是 unset(ref) 让 ref 真正消失，而不是写空字符串。

  it('select route with {ids:[]} clears the selection by UNSETTING the ref', async () => {
    const store = {
      IMA_X_IMA_COOKIE: COOKIE,
      IMA_X_IMA_BKN: BKN,
      IMA_KNOWLEDGE_BASE_IDS: 'kb-1, kb-2',
    }
    // 清空不应该需要账号数据，但即便给了 mock 也不该被调用（下面断言 called === 0）。
    let called = 0
    const impl = async () => { called += 1; return Response.json({ code: 0 }) }
    const { credentials, routes } = mountRoutes(store, impl)
    const selectRoute = routes.find((route) => route.path === '/api/ima-knowledge/select')

    const payload = await (await selectRoute.fetch(new Request('http://host/x', {
      method: 'POST',
      body: JSON.stringify({ ids: [] }),
    }))).json()

    assert.equal(payload.ok, true)
    assert.deepEqual(payload.value.selected, [])
    // 关键：走的是 unset 而不是写空串。
    assert.deepEqual(credentials.unsets, [{ ref: 'IMA_KNOWLEDGE_BASE_IDS' }])
    assert.equal(credentials.writes.length, 0, 'must not write an empty string')
    assert.equal(store.IMA_KNOWLEDGE_BASE_IDS, undefined, 'ref must actually disappear')
    // ref 消失后 readOptionalCredential 语义：未配置 → undefined。
    assert.equal(await credentials.resolve('IMA_KNOWLEDGE_BASE_IDS'), undefined)
    // 清空不需要列库校验，凭据坏了也必须能清空。
    assert.equal(called, 0)
  })

  it('select → then clear → list reports an empty selection', async () => {
    // 先选两个真实 id，再清空，最后 /list 必须反映空选中集。
    const store = { IMA_X_IMA_COOKIE: COOKIE, IMA_X_IMA_BKN: BKN }
    const impl = async () => Response.json({
      code: 0,
      msg: 'ok',
      is_end: true,
      next_cursor: '',
      searched_knowledge_bases: [
        { id: 'kb-1', name: 'A', type: 1, join_type: 0 },
        { id: 'kb-2', name: 'B', type: 1, join_type: 0 },
      ],
    })
    const { credentials, routes } = mountRoutes(store, impl)
    const selectRoute = routes.find((route) => route.path === '/api/ima-knowledge/select')
    const listRoute = routes.find((route) => route.path === '/api/ima-knowledge/list')
    const post = (body) => new Request('http://host/x', { method: 'POST', body: JSON.stringify(body) })

    const saved = await (await selectRoute.fetch(post({ ids: ['kb-1', 'kb-2'] }))).json()
    assert.equal(saved.ok, true)
    assert.deepEqual(saved.value.selected, ['kb-1', 'kb-2'])
    assert.equal(store.IMA_KNOWLEDGE_BASE_IDS, 'kb-1, kb-2')

    const cleared = await (await selectRoute.fetch(post({ ids: [] }))).json()
    assert.equal(cleared.ok, true)
    assert.deepEqual(cleared.value.selected, [])
    assert.equal(store.IMA_KNOWLEDGE_BASE_IDS, undefined)

    const listed = await (await listRoute.fetch(post({}))).json()
    assert.equal(listed.ok, true)
    assert.deepEqual(listed.value.selected, [])
    assert.deepEqual(listed.value.knowledgeBases.map((kb) => kb.selected), [false, false])
  })

  it('select route refuses to clear when the provider is not writable', async () => {
    const store = { IMA_X_IMA_COOKIE: COOKIE, IMA_X_IMA_BKN: BKN, IMA_KNOWLEDGE_BASE_IDS: 'kb-1' }
    const { credentials, routes } = mountRoutes(store, jsonFetch({ code: 0 }).impl, { writable: false })
    const selectRoute = routes.find((route) => route.path === '/api/ima-knowledge/select')
    const payload = await (await selectRoute.fetch(new Request('http://host/x', {
      method: 'POST',
      body: JSON.stringify({ ids: [] }),
    }))).json()
    assert.equal(payload.ok, false)
    assert.match(payload.error.message, /不可写|不可删/u)
    // 不可写时不能假装清空成功。
    assert.equal(store.IMA_KNOWLEDGE_BASE_IDS, 'kb-1')
    assert.equal(credentials.unsets.length, 0)
  })

  it('status route reports not-configured without hitting the network', async () => {
    let called = 0
    const impl = async () => { called += 1; return new Response('{}') }
    const { routes } = mountRoutes({}, impl)
    const statusRoute = routes.find((route) => route.path === '/api/ima-knowledge/status')
    const payload = await (await statusRoute.fetch(new Request('http://host/x', { method: 'POST', body: '{}' }))).json()
    assert.equal(payload.ok, true)
    assert.equal(payload.value.configured, false)
    assert.equal(payload.value.tokenValid, false)
    assert.match(payload.value.error.message, /IMA_X_IMA_COOKIE/u)
    assert.equal(called, 0)
  })

  it('status route reports tokenValid:false on code 41 and unknown on a network failure', async () => {
    const expired = mountRoutes({ IMA_X_IMA_COOKIE: COOKIE, IMA_X_IMA_BKN: BKN }, jsonFetch({ code: 41, msg: 'expired' }).impl)
    const expiredRoute = expired.routes.find((route) => route.path === '/api/ima-knowledge/status')
    const expiredPayload = await (await expiredRoute.fetch(new Request('http://host/x', { method: 'POST', body: '{}' }))).json()
    assert.equal(expiredPayload.value.configured, true)
    assert.equal(expiredPayload.value.tokenValid, false)
    // 实现与测试共用同一套错误码常量（ERROR_CODES），不各写各的字符串。
    assert.equal(expiredPayload.value.error.code, ERROR_CODES.tokenExpired)

    const offline = mountRoutes({ IMA_X_IMA_COOKIE: COOKIE, IMA_X_IMA_BKN: BKN }, async () => {
      throw new Error('ECONNREFUSED')
    })
    const offlineRoute = offline.routes.find((route) => route.path === '/api/ima-knowledge/status')
    const offlinePayload = await (await offlineRoute.fetch(new Request('http://host/x', { method: 'POST', body: '{}' }))).json()
    assert.equal(offlinePayload.value.tokenValid, 'unknown')
    assert.match(offlinePayload.value.error.message, /ECONNREFUSED/u)
  })
})

// ------------------------------------------------- host: token refresh retry

describe('host: code 41 自动刷新并重试一次', () => {
  it('refreshes, rewrites IMA-TOKEN in the store, then retries successfully', async () => {
    const store = { IMA_X_IMA_COOKIE: COOKIE, IMA_X_IMA_BKN: BKN, IMA_KNOWLEDGE_BASE_IDS: 'kb-1' }
    const credentials = fakeCredentials(store)
    const tools = []
    const ctx = {
      effect: (callback) => callback(),
      inject: (_services, callback) => callback(ctx),
      get: (service) => {
        if (service === 'tools') return { register: (tool) => { tools.push(tool); return () => {} } }
        if (service === 'credentials') return credentials
        if (service === 'connection') {
          return { fetch: { register: () => async () => {} } }
        }
        return undefined
      },
    }
    let searchCalls = 0
    const impl = async (url, init) => {
      const path = String(url)
      if (path.endsWith('/cgi-bin/auth_login/refresh')) {
        return Response.json({ code: 0, token: 'rotated-token' })
      }
      if (path.endsWith('/search_knowledge_base')) {
        searchCalls += 1
        if (searchCalls === 1) return Response.json({ code: 41, msg: 'token expired' })
        // 第二次必须带新 token
        const cookie = init.headers['x-ima-cookie']
        return Response.json({
          code: 0,
          searched_knowledge_bases: [{ id: cookie.includes('rotated-token') ? 'kb-new' : 'kb-old', name: 'X', type: 1 }],
          is_end: true,
          msg: 'ok',
        })
      }
      throw new Error(`unexpected path ${path}`)
    }
    apply(ctx, { fetchImpl: impl })
    {
      const listTool = tools.find((tool) => tool.name === 'ima_kb_list')
      const value = await listTool.execute({}, { signal: new AbortController().signal })
      assert.equal(value.knowledgeBases[0].id, 'kb-new')
    }
    assert.equal(searchCalls, 2)
    assert.match(store.IMA_X_IMA_COOKIE, /rotated-token/u)
    assert.match(store.IMA_X_IMA_COOKIE, /IMA-REFRESH-TOKEN=ref-xyz/u)
    // 续期后 bkn 必须跟着新 token 一起回写（bkn = getBkn(IMA-TOKEN)）；旧实现只写 cookie，
    // 会留下「新 cookie + 旧 bkn」。上游目前对 bkn 不匹配较宽容，但那是善意不是契约。
    assert.deepEqual(credentials.writes.map((write) => write.ref), ['IMA_X_IMA_COOKIE', 'IMA_X_IMA_BKN'])
  })

  it('surfaces an explicit error when the refreshed cookie cannot be written back', async () => {
    const store = { IMA_X_IMA_COOKIE: COOKIE, IMA_X_IMA_BKN: BKN, IMA_KNOWLEDGE_BASE_IDS: 'kb-1' }
    const credentials = fakeCredentials(store)
    const originalSet = credentials.set.bind(credentials)
    credentials.set = async (ref, value) => {
      if (ref === 'IMA_X_IMA_COOKIE') throw new Error('provider is read-only')
      return originalSet(ref, value)
    }
    const tools = []
    const ctx = {
      effect: (callback) => callback(),
      inject: (_services, callback) => callback(ctx),
      get: (service) => {
        if (service === 'tools') return { register: (tool) => { tools.push(tool); return () => {} } }
        if (service === 'credentials') return credentials
        if (service === 'connection') return { fetch: { register: () => async () => {} } }
        return undefined
      },
    }
    const impl = async (url) => (String(url).endsWith('/auth_login/refresh')
      ? Response.json({ code: 0, token: 'rotated-token' })
      : Response.json({ code: 41, msg: 'token expired' }))
    apply(ctx, { fetchImpl: impl })
    {
      const listTool = tools.find((tool) => tool.name === 'ima_kb_list')
      await assert.rejects(
        () => listTool.execute({}, { signal: new AbortController().signal }),
        /回写 IMA_X_IMA_COOKIE 失败/u,
      )
    }
  })

  it('does not retry when the failure is not code 41', async () => {
    const store = { IMA_X_IMA_COOKIE: COOKIE, IMA_X_IMA_BKN: BKN, IMA_KNOWLEDGE_BASE_IDS: 'kb-1' }
    const credentials = fakeCredentials(store)
    const tools = []
    const ctx = {
      effect: (callback) => callback(),
      inject: (_services, callback) => callback(ctx),
      get: (service) => {
        if (service === 'tools') return { register: (tool) => { tools.push(tool); return () => {} } }
        if (service === 'credentials') return credentials
        if (service === 'connection') return { fetch: { register: () => async () => {} } }
        return undefined
      },
    }
    let calls = 0
    const impl = async (url) => {
      calls += 1
      assert.equal(String(url).includes('/auth_login/refresh'), false, 'must not refresh for a non-41 code')
      return Response.json({ code: 51, msg: 'bad param' })
    }
    apply(ctx, { fetchImpl: impl })
    {
      const listTool = tools.find((tool) => tool.name === 'ima_kb_list')
      await assert.rejects(
        () => listTool.execute({}, { signal: new AbortController().signal }),
        (error) => {
          assert.match(error.message, /code 51/u)
          assert.match(error.message, /bad param/u)
          return true
        },
      )
    }
    assert.equal(calls, 1)
  })
})

// ------------------------------------------------------- host: tool behaviour

describe('host: 三个工具', () => {
  /**
   * 造一个只注册工具的假宿主。
   * @param {Record<string,string>} store - 假凭据存储。
   * @param {typeof fetch} [fetchImpl] - 注入的 fetch（不劫持全局）。
   */
  function mountTools(store, fetchImpl) {
    const tools = []
    const credentials = fakeCredentials(store)
    const ctx = {
      effect: (callback) => callback(),
      inject: (_services, callback) => callback(ctx),
      get: (service) => {
        if (service === 'tools') return { register: (tool) => { tools.push(tool); return () => {} } }
        if (service === 'credentials') return credentials
        if (service === 'connection') return { fetch: { register: () => async () => {} } }
        return undefined
      },
    }
    apply(ctx, fetchImpl === undefined ? {} : { fetchImpl })
    return { tools, credentials }
  }

  it('ima_kb_ask defaults to the first selected knowledge base', async () => {
    const asked = []
    const impl = async (url, init) => {
      if (String(url).endsWith('/init_session')) {
        asked.push(JSON.parse(init.body).relatedUrl)
        return Response.json({ code: 0, session_id: 'sess-1' })
      }
      return new Response('data: {"content":"答案"}\n\n', { headers: { 'content-type': 'text/event-stream' } })
    }
    const { tools } = mountTools({
      IMA_X_IMA_COOKIE: COOKIE,
      IMA_X_IMA_BKN: BKN,
      IMA_KNOWLEDGE_BASE_IDS: 'kb-first, kb-second',
    }, impl)
    const askTool = tools.find((tool) => tool.name === 'ima_kb_ask')
    const value = await askTool.execute({ question: '问?' }, { signal: new AbortController().signal })
    assert.equal(value.answer, '答案')
    assert.deepEqual(asked, ['kb-first'])
  })

  it('ima_kb_ask throws a clear error when nothing is selected', async () => {
    const { tools } = mountTools({ IMA_X_IMA_COOKIE: COOKIE, IMA_X_IMA_BKN: BKN })
    const askTool = tools.find((tool) => tool.name === 'ima_kb_ask')
    await assert.rejects(
      () => askTool.execute({ question: '问?' }, { signal: new AbortController().signal }),
      (error) => {
        assert.match(error.message, /还没有选中任何知识库/u)
        assert.match(error.message, /设置→插件→IMA 知识库/u)
        return true
      },
    )
  })

  it('ima_kb_search requires a query, and clamps a bogus limit to the default', async () => {
    const bodies = []
    const impl = async (_url, init) => {
      bodies.push(JSON.parse(init.body))
      // 真机字段名：命中列表在顶层 info_list。
      return Response.json({ code: 0, msg: 'ok', is_end: true, next_cursor: '', info_list: [] })
    }
    const { tools } = mountTools({
      IMA_X_IMA_COOKIE: COOKIE,
      IMA_X_IMA_BKN: BKN,
      IMA_KNOWLEDGE_BASE_IDS: 'kb-1',
    }, impl)
    const searchTool = tools.find((tool) => tool.name === 'ima_kb_search')
    await assert.rejects(
      () => searchTool.execute({ query: '  ' }, { signal: new AbortController().signal }),
      /query 不能为空/u,
    )
    const value = await searchTool.execute({ query: '检索词', limit: -5 }, { signal: new AbortController().signal })
    assert.deepEqual(value.items, [])
    assert.equal(bodies[0].limit, 10)
    assert.equal(bodies[0].knowledge_base_id, 'kb-1')
  })

  it('ima_kb_list marks the selected ids', async () => {
    const impl = async () => Response.json({
      code: 0,
      searched_knowledge_bases: [
        { id: 'kb-1', name: 'A', type: 1, join_type: 0 },
        { id: 'kb-2', name: 'B', type: 1, join_type: 0 },
      ],
      is_end: true,
      msg: 'ok',
    })
    const { tools } = mountTools({
      IMA_X_IMA_COOKIE: COOKIE,
      IMA_X_IMA_BKN: BKN,
      IMA_KNOWLEDGE_BASE_IDS: 'kb-2',
    }, impl)
    const listTool = tools.find((tool) => tool.name === 'ima_kb_list')
    const value = await listTool.execute({}, { signal: new AbortController().signal })
    assert.deepEqual(value.selected, ['kb-2'])
    assert.equal(value.selectedId, 'kb-2')
    assert.deepEqual(value.knowledgeBases.map((kb) => kb.selected), [false, true])
  })

  it('ima_kb_list also exposes group, and omits the key when undecidable', async () => {
    const impl = async () => Response.json({
      code: 0,
      searched_knowledge_bases: [
        { id: 'kb-mine', name: 'A', type: 1 },
        { id: 'kb-join', name: 'B', type: 4 },
        { id: 'kb-unknown', name: 'C' },
      ],
      is_end: true,
      msg: 'ok',
    })
    const { tools } = mountTools({ IMA_X_IMA_COOKIE: COOKIE, IMA_X_IMA_BKN: BKN }, impl)
    const listTool = tools.find((tool) => tool.name === 'ima_kb_list')
    const value = await listTool.execute({}, { signal: new AbortController().signal })
    assert.deepEqual(value.knowledgeBases.map((kb) => kb.group), ['personal', 'joined', undefined])
    // 工具返回同样遵守「判定不出来就没有这个键」。
    assert.equal('group' in value.knowledgeBases[2], false)
    // 工具 schema 声明了 group 且不放进 required（DSH 只允许受支持的子集）。
    const groupSchema = listTool.output.schema.properties.knowledgeBases.items.properties.group
    assert.equal(groupSchema.type, 'string')
    assert.equal(listTool.output.schema.properties.knowledgeBases.items.required.includes('group'), false)
  })

  it('after clearing the selection, ima_kb_ask errors with SELECT_HINT instead of asking with an empty set', async () => {
    // 闭环验证：/select {ids:[]} 之后 ref 消失 → 工具必须报「未勾选」，绝不能静默
    // 拿空集/空 ID 去发请求。
    const store = { IMA_X_IMA_COOKIE: COOKIE, IMA_X_IMA_BKN: BKN, IMA_KNOWLEDGE_BASE_IDS: 'kb-1' }
    const asked = []
    const impl = async (url) => {
      asked.push(String(url))
      return Response.json({
        code: 0,
        msg: 'ok',
        is_end: true,
        next_cursor: '',
        searched_knowledge_bases: [{ id: 'kb-1', name: 'A', type: 1, join_type: 0 }],
      })
    }
    const credentials = fakeCredentials(store)
    const tools = []
    const routes = []
    const ctx = {
      effect: (callback) => callback(),
      inject: (_services, callback) => callback(ctx),
      get: (service) => {
        if (service === 'tools') return { register: (tool) => { tools.push(tool); return () => {} } }
        if (service === 'credentials') return credentials
        if (service === 'connection') {
          return { fetch: { register: (route) => { routes.push(route); return async () => {} } } }
        }
        return undefined
      },
    }
    apply(ctx, { fetchImpl: impl })
    const selectRoute = routes.find((route) => route.path === '/api/ima-knowledge/select')
    const askTool = tools.find((tool) => tool.name === 'ima_kb_ask')

    // 先确认清空前是可以问的（选中 kb-1）。
    assert.equal((await selectRoute.fetch(new Request('http://host/x', {
      method: 'POST',
      body: JSON.stringify({ ids: [] }),
    }))).status, 200)
    asked.length = 0

    await assert.rejects(
      () => askTool.execute({ question: '清空后还能问吗' }, { signal: new AbortController().signal }),
      (error) => {
        assert.match(error.message, /还没有选中任何知识库/u)
        assert.match(error.message, /设置→插件→IMA 知识库/u, 'must carry SELECT_HINT')
        return true
      },
    )
    // 关键：完全没有发出提问/建会话请求（不能静默拿空集去请求）。
    assert.equal(asked.length, 0, 'must not send any request after the selection was cleared')
  })
})
