# dsh-ima-ragplugin

DeepSeek Harness（DSH）插件：把 IMA 账号里**可访问 / 已订阅的知识库**读出来，在侧边栏里勾选要接入的库，
再让模型通过原生工具直接检索这些知识库的原文。

它解决三件事：

- 不用手填知识库 ID —— 插件自己列出你有权访问的库；
- 不用每次调用都传 ID —— 选中的库会成为会话默认检索范围；
- 检索走**原文**而不是二手摘要 —— 默认路径是 `ima_kb_search`，`ima_kb_ask` 只作有损兜底。

## 能力

插件向 DSH 注册 3 个原生工具：

| 工具 | 参数 | 说明 |
|---|---|---|
| `ima_kb_list` | 无 | 列出所有可访问知识库，以及当前已选中的库 |
| `ima_kb_search` | `query`；`knowledgeBaseId?`、`limit?` | **默认检索路径**：返回原文片段（`media_id` / 标题 / 高亮）。不传 `limit` 时使用设置里的「检索条数」 |
| `ima_kb_ask` | `question`；`knowledgeBaseId?` | **有损兜底**：让 IMA 侧模型先总结再返回。只在用户明确要求「给个结论」或检索确实无结果时使用 |

### 界面入口

| 入口 | 位置 | 用途 |
|---|---|---|
| 侧边栏 IMA 图标 | 左侧边栏面板列表 | 凭据授权 + 知识库勾选（主入口） |
| 输入框「+」菜单 → `ima` | 会话输入框左下角 `/` 命令菜单 | 打开知识库多选弹窗，快速切换本会话接入的库 |
| 已选知识库 chip 栏 | 输入框卡片内部、文字区上方 | 显示本会话已接入的库，点 `×` 移除 |
| 插件设置页卡片 | 插件管理 → 本插件详情 | 兼容保留的旧入口，功能与侧边栏一致 |

## 安装

### 桌面端：在 DSH 插件页里安装

打开 DSH → **插件**，两种方式任选其一：

**① 「添加插件」直接粘贴仓库地址（最快）**

在插件页点「添加插件」，粘贴：

```
https://github.com/RayJitan/dsh-ima-ragplugin
```

确认框会显示来源（Git 仓库 + commit），确认后安装。

**② 从「发现」市场安装**

「发现」标签页默认没有任何索引源，需要先添加一次：

1. 插件页 → **发现** → **添加索引源**
2. 填入市场索引地址：

   ```
   https://rayjitan.github.io/dsh-ima-ragplugin/index.json
   ```

3. 搜索 `dsh-ima-ragplugin` → 安装。

安装完成后**重启 DSH 桌面应用**，左侧边栏会出现 IMA 图标。

### 命令行：安装到非 desktop 的 profile

```powershell
dsh plugin --profile <profile-name> add dsh-ima-ragplugin
```

> `--profile desktop` 由 DSH 桌面应用独占管理，独立 CLI 会直接拒绝（`profile "desktop" is managed exclusively by the Electron application`）。
> 桌面端请用上面的插件页路径；命令行只适用于自建 profile（如 `dsh --profile demo`）。

### 从旧版 `dsh-ima-knowledge` 迁移

旧包与本包注册同一批工具和同一组 `/api/ima-knowledge/*` 路由，**不能同时启用**。切换顺序：

1. 插件页 → 已安装 → `dsh-ima-knowledge` → **卸载**
2. 按上面的方式安装 `dsh-ima-ragplugin`
3. 重启 DSH

凭据（`IMA_X_IMA_COOKIE` / `IMA_X_IMA_BKN`）、已选知识库、签到配置都在 credential store 与 `~/.dsh/ima-knowledge/` 里，迁移后自动沿用，无需重新配置。

> 本插件没有第三方运行时依赖（纯 ESM），也没有 `prepare`/`build` 脚本，从 Git 安装不需要 pnpm 的构建授权。

## 凭据配置

插件不保存密码，也不把 cookie 落到自己的目录，全部走 DSH 的 credential store。

### 方式一：从 IMA 桌面客户端同步（推荐）

侧边栏 → IMA 面板 → 「从 IMA 桌面客户端同步」。

插件会读取本机已登录的 IMA 客户端凭据（Windows 下走 DPAPI 解密 `%LOCALAPPDATA%\ima.copilot\User Data`），
无需手动复制 cookie。前提是本机 IMA 客户端处于已登录状态。

### 方式二：手动填写 cookie

在 IMA 面板展开「手动填写」，粘贴 `x-ima-cookie`；`bkn` 可以留空，插件会按 token 自动推导。

### 用到的凭据项

| ref | 说明 |
|---|---|
| `IMA_X_IMA_COOKIE` | 完整的 `x-ima-cookie` |
| `IMA_X_IMA_BKN` | `x-ima-bkn`（= `getBkn(IMA-TOKEN)`），留空时自动推导 |
| `IMA_KNOWLEDGE_BASE_IDS` | 已勾选的知识库 ID，逗号分隔（插件写入） |
| `IMA_KNOWLEDGE_SEARCH_LIMIT` | 检索条数，1-100 的十进制字符串；缺失即默认 10（插件写入） |

这四项与 `dsh-ima-copilot` 兼容，两个插件可以共存。

token 过期时（上游 `code 41`），插件会用 `IMA-REFRESH-TOKEN` 自动刷新一次并回写；刷新不轮换 refresh token。

## 检索策略：优先 `ima_kb_search`

`ima_kb_ask` 是把检索**外包给 IMA 侧模型**：它先把资料总结一遍再返回，原文措辞、细节、数字和逐条出处都会损失，
模型等于拿二手摘要作答。因此插件用三层把默认路径固定在 `ima_kb_search` 上：

| 层 | 位置 | 作用 |
|---|---|---|
| 选工具前 | 工具 `description` | `ima_kb_search` 自报 PREFERRED / RAW；`ima_kb_ask` 自报 LOSSY，只保留两个合法场景 |
| 拿到结果后 | `output.render` 追加提示 | search 结果提示「换关键词继续检索」；ask 结果提示「这是有损总结，要原文请回 search」 |
| 每一步 | `ctx.systemPrompt.section` | 按会话选中集三态注入策略段（已选中 N 个 / 未知 / 明确不选则不注入） |

策略段名 `ima-knowledge:retrieval-policy`，order `2950`（工具指引区），`interpolate: false`。
`systemPrompt` 是**可选宿主能力**：宿主不提供时插件照常工作，前两层仍然生效。

## 检索条数设置

侧边栏 IMA 面板 → 「检索设置」区块（设置页卡片里同一组件也有），配置**调用 `ima_kb_search` 时返回的条数**：

| 项 | 说明 |
|---|---|
| 默认 | **10** |
| 范围 | **1-100**（整数；越界或小数在 UI 与宿主两侧都会被挡下） |
| 生效点 | `ima_kb_search` **未显式传 `limit`** 时使用；显式 `limit` 优先 |
| 持久化 | credential store 的 `IMA_KNOWLEDGE_SEARCH_LIMIT`，跨重启生效 |
| 宿主路由 | `POST /api/ima-knowledge/settings`：`{action:'get'}` / `{action:'set', searchLimit}` |

写入是严格校验（越界 / 小数 / 非数字返回 `BAD_REQUEST`，零写入），读取是容错的（脏值回落默认、越界收敛到 1-100），
所以手改 credential store 也不会把检索搞坏。上游实测会忽略请求体里的 `limit` 恒返回 100 条，插件按生效条数截断后再交给模型。

## 自动签到（每日登录福利）

IMA 官方活动「每日登录福利」：每天签到领 **50 算力**，同一自然周连签 7 天再领一次随机算力。
插件把它做成后台自动执行：

| 项 | 说明 |
|---|---|
| 入口 | 侧边栏 IMA 面板 → 「自动签到」区块（开关 / 时间 / 立即签到 / 本周进度 / 最近记录） |
| 默认 | **启用**，每天 **09:00**（本机时区） |
| 补跑 | DSH 启动时若当天还没签且已过设定时间，立即补跑一次 |
| 幂等 | 今天已签（上游 `code 1002`）视为成功，不重复请求；满签奖励未解锁（`code 1004`）静默跳过 |
| 落盘 | `~/.dsh/ima-knowledge/checkin.json`（配置 + 最近 30 条记录，原子写） |
| 凭据 | 复用 `IMA_X_IMA_COOKIE` / `IMA_X_IMA_BKN`，token 过期自动刷新 |

**边界**：只领取、不消耗算力；每天最多 2 次请求（满签日）；不伪造设备指纹、不绕过风控。

接口契约、状态码与实测响应见 [docs/CHECKIN.md](docs/CHECKIN.md)。

## 兼容性

| 项 | 要求 |
|---|---|
| DSH | `>=0.2.0 <0.3.0`（范围含预发布版；已在 `0.2.1-rc.2` 与 `0.2.1-rc.5` 上验证） |
| Node.js | `^22.19.0 || >=24.0.0` |
| 平台 | DSH Web 与桌面端（浏览器半侧声明 `platform: web`） |

> 兼容性判定读的是 `package.json` 的 `engines.dsh`：DSH 用 `semver.satisfies(version, range, { includePrerelease: true })` 比较，
> 因此 `0.2.1-rc.x` 这类预发布版本也能命中 `>=0.2.0 <0.3.0`。范围外的 DSH 会**静默跳过**本插件（装上了但不生效），
> 若你自行修改版本范围，请确认上下界。

## 已知约束

- **只读**：不提供上传、删除、建库等写操作。
- 列库只能用 IMA 的 `search_knowledge_base`（空 query + 翻页）；`get_knowledge_base_list` 恒返回空。
- 依赖 IMA 内部 Web API，非公开稳定接口，上游变更可能需要跟进。
- 错误码：`code 51` 是参数错误（说明鉴权已通过）；`code 110031` 是会话彻底过期，需要重新登录 IMA 客户端。
- 自动签到依赖 IMA 活动本身，活动结束后该功能会自然失效。

## 开发

```powershell
# 浏览器半侧：片段 → 产物
node scripts/build-client.mjs           # 生成 lib/client.js
node scripts/build-client.mjs --check   # 校验产物与片段一致（CI / 单测用）

# 语法检查
node --check lib/host.js
node --check lib/client.js
node --check lib/ima-api.js

# 全量单测（必须带 glob）
node --test --experimental-test-isolation=none "tests/*.test.js"
```

浏览器半侧源码是**片段**（`lib/client/*.js`），`lib/client.js` 是构建产物，**不要手改**：
改片段后重新构建，否则 `--check` 与 `tests/build.test.js` 会失败。

## License

[MIT](LICENSE) © 2026 RayJitan
