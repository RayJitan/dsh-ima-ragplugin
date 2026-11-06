/**
 * 生成 DSH 插件市场索引（format 1）—— `docs/index.json`。
 *
 * 为什么要有这个脚本：市场索引里的 `source.commit` 必须是**精确的 40 位 commit SHA**，
 * 而每次发版 SHA 都会变。手写索引极易忘记同步，导致「市场里显示的版本」与
 * 「实际安装的代码」不一致。这个脚本把版本号、commit、engines 全部从事实源
 * （package.json + git HEAD）推导出来，发版时跑一次即可。
 *
 * 用法：
 *   node scripts/build-market-index.mjs            # 用当前 HEAD 生成
 *   node scripts/build-market-index.mjs --commit <sha>   # 指定要钉住的提交
 *
 * 产物：
 *   docs/index.json
 *   docs/icons/icon.svg   （从包根 icon.svg 复制，相对索引 URL 解析）
 */

import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const outDir = join(root, 'docs')
const iconsDir = join(outDir, 'icons')

/** 仓库的网页地址（不是 git+ 协议形式）。 */
const REPO_URL = 'https://github.com/RayJitan/dsh-ima-ragplugin'

/**
 * 读取要钉住的 commit：命令行优先，否则用 HEAD。
 * @returns {string} 40 位小写十六进制 SHA。
 */
function resolveCommit() {
  const at = process.argv.indexOf('--commit')
  const value = at === -1 ? undefined : process.argv[at + 1]
  const sha = value ?? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  if (!/^[0-9a-f]{40}$/u.test(sha)) throw new Error(`commit 必须是 40 位小写十六进制 SHA，实际：${sha}`)
  return sha
}

const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const commit = resolveCommit()

const index = {
  format: 1,
  title: { en: 'RayJitan DSH plugins', zh: 'RayJitan DSH 插件' },
  description: {
    en: 'Plugins for DeepSeek Harness published by RayJitan.',
    zh: 'RayJitan 发布给 DeepSeek Harness 的插件。',
  },
  plugins: [
    {
      name: pkg.name,
      title: { en: 'IMA Knowledge Base (RAG)', zh: 'IMA 知识库（RAG）' },
      description: {
        en: 'Attach the knowledge bases your IMA account can access to DeepSeek Harness and let the model search them with native tools.',
        zh: '把 IMA 账号里可访问/已订阅的知识库接入 DeepSeek Harness，让模型用原生工具检索原文。',
      },
      icon: 'icons/icon.svg',
      author: 'RayJitan',
      homepage: `${REPO_URL}#readme`,
      repository: { url: REPO_URL },
      versions: [
        {
          version: pkg.version,
          publishTimestamp: Math.floor(Date.now() / 1000),
          source: { type: 'git', url: REPO_URL, commit },
          engines: { dsh: pkg.engines?.dsh ?? '>=0.2.0 <0.3.0' },
        },
      ],
    },
  ],
}

await mkdir(iconsDir, { recursive: true })
await copyFile(join(root, 'icon.svg'), join(iconsDir, 'icon.svg'))
await writeFile(join(outDir, 'index.json'), `${JSON.stringify(index, null, 2)}\n`, 'utf8')

console.log(`✓ docs/index.json：${pkg.name}@${pkg.version} → ${commit}`)
console.log(`✓ docs/icons/icon.svg`)
