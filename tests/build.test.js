/**
 * 构建产物一致性测试（Lead 拥有）。
 *
 * 防的是最常见的协作事故：改了 lib/client/*.js 片段却忘了构建，
 * 或者直接手改 lib/client.js 导致下次构建被覆盖。
 *
 * 判据：`node scripts/build-client.mjs --check` 退出码为 0。
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { promisify } from 'node:util'

const run = promisify(execFile)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

describe('client bundle 构建一致性', () => {
  it('lib/client.js 与 lib/client/*.js 片段一致', async () => {
    const { stdout } = await run(process.execPath, [join(root, 'scripts', 'build-client.mjs'), '--check'], { cwd: root })
    assert.match(stdout, /一致/u)
  })

  it('片段目录包含地基三件套', async () => {
    const names = await readdir(join(root, 'lib', 'client'))
    for (const required of ['00-head.js', '10-core.js', '90-tail.js']) {
      assert.ok(names.includes(required), `缺少片段 ${required}`)
    }
  })

  it('bundle 可被 Function 构造（语法与闭包结构完整）', async () => {
    const source = await readFile(join(root, 'lib', 'client.js'), 'utf8')
    // bundle 顶层只调 window.__ModuleLoader__.load，不执行 factory 体，
    // 因此可以安全地做一次构造校验（不 run）。
    assert.doesNotThrow(() => {
      // eslint-disable-next-line no-new-func
      new Function(source)
    })
  })

  it('bundle 声明了四个注册位置', async () => {
    const source = await readFile(join(root, 'lib', 'client.js'), 'utf8')
    // 侧边栏（图标 + 整页）、插件设置卡是 Lead 侧收口；命令菜单与 overlay 由 picker 席位注册，
    // 因此这里只断言 Lead 必须保证的两处 + 席位注册函数被调用。
    assert.match(source, /registerSidebarPanel/u)
    assert.match(source, /registerPicker/u)
    assert.match(source, /plugins\.bundle\.config/u)
  })

  it('不静态依赖 Harness Client 包（官方守则）', async () => {
    const names = await readdir(join(root, 'lib', 'client'))
    for (const name of names) {
      const body = await readFile(join(root, 'lib', 'client', name), 'utf8')
      assert.doesNotMatch(body, /require\(\s*['"]@deepseek-ai\//u, `${name} 不得 require Harness Client 包`)
    }
  })
})
