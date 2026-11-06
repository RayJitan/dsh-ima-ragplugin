/**
 * 构建 lib/client.js —— 把 lib/client/*.js 片段按文件名排序拼成单文件 bundle。
 *
 * 为什么要拼：DSH 的 client-modules loader 只认「一个包一个 client.js」，
 * 而并行开发需要文件级写作用域隔离。片段是开发形态，bundle 是交付形态。
 *
 * 用法：
 *   node scripts/build-client.mjs           # 生成 lib/client.js
 *   node scripts/build-client.mjs --check   # 只校验 lib/client.js 是否与片段一致（CI/单测用）
 *
 * 退出码：0 成功 / 1 不一致（--check）或片段缺失
 */

import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const fragmentDir = join(root, 'lib', 'client')
const outFile = join(root, 'lib', 'client.js')

/** 片段必须齐全的最小集合（缺任何一个都说明有人删了地基）。 */
const REQUIRED = ['00-head.js', '10-core.js', '90-tail.js']

/** 按文件名排序；只收 .js，忽略下划线/点开头的草稿文件。 */
async function collectFragments() {
  const { readdir } = await import('node:fs/promises')
  const names = (await readdir(fragmentDir))
    .filter((name) => name.endsWith('.js') && !name.startsWith('_') && !name.startsWith('.'))
    .sort()
  for (const required of REQUIRED) {
    if (!names.includes(required)) {
      throw new Error(`缺少必需片段 lib/client/${required}`)
    }
  }
  return names
}

/**
 * 拼接片段。
 * 每个片段之间插一条注释分隔，便于在产物里定位来源行。
 *
 * 换行统一：片段可能来自不同编辑器（本仓库里 `30-picker.js` 是 CRLF，其余是 LF），
 * 产物固定输出 LF，这样 `--check` 在任何平台上比对结果都一致，也不会出现
 * 「片段没改、产物却因换行不同被判为不一致」的假告警。
 * @param {string[]} names - 片段文件名（已排序）。
 * @returns {Promise<string>} bundle 全文。
 */
async function compose(names) {
  const parts = []
  for (const name of names) {
    const body = await readFile(join(fragmentDir, name), 'utf8')
    parts.push(`\n// ═══ fragment: lib/client/${name} ═══\n`)
    // 去掉片段尾部多余换行，保证片段间恰好一个空行
    parts.push(body.replace(/\r\n?/gu, '\n').replace(/\s+$/u, '') + '\n')
  }
  return parts.join('')
}

const names = await collectFragments()
const bundle = await compose(names)

if (process.argv.includes('--check')) {
  let current = ''
  try {
    current = await readFile(outFile, 'utf8')
  } catch {
    console.error('✗ lib/client.js 不存在；请先运行 node scripts/build-client.mjs')
    process.exit(1)
  }
  if (current !== bundle) {
    console.error('✗ lib/client.js 与片段不一致（有人手改了产物，或改片段后忘了构建）')
    console.error('  修复：node scripts/build-client.mjs')
    process.exit(1)
  }
  console.log(`✓ lib/client.js 与 ${names.length} 个片段一致（${bundle.length} 字节）`)
  process.exit(0)
}

await writeFile(outFile, bundle, 'utf8')
console.log(`✓ 已生成 lib/client.js：${names.length} 个片段 → ${bundle.length} 字节`)
for (const name of names) console.log(`  · ${name}`)
