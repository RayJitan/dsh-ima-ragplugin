/**
 * 发布产物边界测试。
 *
 * 历史：本文件原本断言「渲染验证台（tools/harness）齐备 + 截图证据存在」。
 * 打包时验证台、截图、缺陷报告、Chrome 用户数据等开发过程材料已整体移入
 * `dev-archive/`（不进 git、不进 npm 包），那些断言的对象在发布树里已不存在，
 * 因此改为断言**发布树不该包含什么**，防止过程材料被重新带回仓库根。
 *
 * 纯逻辑与 UI 逻辑的回归仍由 tests/ 下其余用例覆盖；侧边栏 order 这类
 * 与产物直接相关的 UI 不变量保留在本文件末尾。
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { describe, it } from 'node:test'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 开发过程材料：必须留在 dev-archive/，不得出现在仓库根。 */
const PROCESS_ARTIFACTS = [
  '.harness-profile',
  'shots',
  'acl-backups',
  'tools',
  'bugReport',
  'ENTRY.md',
  'ACCEPTANCE.md',
  'PLATFORM.md',
  'SPEC.md',
  'CHECKIN.md',
]

describe('发布产物边界', () => {
  it('仓库根不含开发过程材料', () => {
    for (const rel of PROCESS_ARTIFACTS) {
      assert.equal(existsSync(join(root, rel)), false, `仓库根不应出现 ${rel}（应留在 dev-archive/）`)
    }
  })

  it('package.json 的 files 白名单只含运行时产物', async () => {
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
    assert.ok(Array.isArray(pkg.files) && pkg.files.length > 0, 'files 必须是非空数组')
    for (const entry of pkg.files) {
      for (const artifact of PROCESS_ARTIFACTS) {
        assert.equal(
          entry === artifact || entry.startsWith(artifact + '/'),
          false,
          `files 不应包含过程材料 ${entry}`,
        )
      }
    }
    // 运行时必需项必须在白名单里
    for (const required of ['lib/host.js', 'lib/client.js', 'cordis.patch.yml', 'icon.svg', 'LICENSE', 'docs/CHECKIN.md']) {
      assert.ok(pkg.files.includes(required), `files 缺少运行时产物 ${required}`)
    }
  })

  it('.gitignore 覆盖依赖、归档与本地输出', async () => {
    const ignore = await readFile(join(root, '.gitignore'), 'utf8')
    for (const pattern of ['node_modules/', 'dev-archive/', '.audit/', '*.log']) {
      assert.ok(ignore.includes(pattern), `.gitignore 应包含 ${pattern}`)
    }
  })

  it('侧边栏图标排在 XD Pool 之后（order=30 > 20）', async () => {
    const source = await readFile(join(root, 'lib/client/20-sidebar.js'), 'utf8')
    const match = source.match(/order:\s*(\d+)/u)
    assert.ok(match !== null, '侧边栏注册必须显式给 order')
    assert.ok(Number(match[1]) > 20, `order 必须 > 20（XD Pool 的值），实际 ${match[1]}`)
  })
})
