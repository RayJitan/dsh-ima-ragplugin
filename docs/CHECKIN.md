# CHECKIN.md —— 「自动签到 IMA」契约（Lead 冻结版 1.0）

> 本文件是本轮唯一跨席位契约。席位只读本文件 + 自己那份 brief，不互相读实现。
> 任何与本文件冲突的实现都是缺陷。
>
> 上游 API 于 **2026-11-06 用真机凭据逐条实测**（不是推测），响应样例逐字保留在 §2。
> 参考项目：`XDTrees/dsh-workbuddy-xdpool` 的「积分自动化」面板（开关 + 定时任务 + 立即运行 +
> 当日收益账本 + 每任务上次执行时间）。本插件只做其中**一件事**：IMA 每日签到。

---

## 0 一句话

IMA 有官方「每日登录福利」活动：每天签到领 **50 算力**，同周连签 7 天再领一次随机算力。
入口在 IMA 客户端「我的 copilot → copilot 设置 → 用量统计 → 每日登录福利」。
本功能把它做成**后台自动执行 + 侧边栏面板可见可控**。

---

## 1 上游 API（已验证，勿改路径/字段）

Base：`https://ima.qq.com`，全部 `POST`，JSON body。
请求头与现有 `lib/ima-api.js` 的 `headers()` 一致，只有 `referer` 换成
`https://ima.qq.com/copilot-token-daily-checkin`（实测不影响鉴权，但保持一致更稳）。

| 用途 | 路径 |
|---|---|
| 查活动状态 | `/cgi-bin/daily_login_activity/get_activity_info` |
| 签到/领奖 | `/cgi-bin/daily_login_activity/check_in` |
| 活动规则 | `/cgi-bin/daily_login_activity/get_activity_rules` |
| 分享文案 | `/cgi-bin/daily_login_activity/get_share_info` |

### 1.1 查状态 `get_activity_info`

body `{}`，实测响应（2026-11-06，周五，已签到后）：

```json
{"code":0,"msg":"ok","checkin_days":1,"total_reward_points":50,
 "infos":[
   {"button":"已过期","reward":"50算力","status":1,"top":"周一"},
   {"button":"已过期","reward":"50算力","status":1,"top":"周二"},
   {"button":"已过期","reward":"50算力","status":1,"top":"周三"},
   {"button":"已过期","reward":"50算力","status":1,"top":"周四"},
   {"button":"已领取","reward":"50算力","status":2,"top":"今日"},
   {"button":"待解锁","reward":"50算力","status":4,"top":"周六"},
   {"button":"待解锁","reward":"50算力","status":4,"top":"周日"},
   {"button":"连续7天签到解锁","reward":"额外随机奖励","status":4,"top":"满签奖励"}
 ]}
```

**`status` 枚举（源码 `checkin-*.js` 实测）**：
`1=Expired（已过期）`、`2=Received（已领取）`、`3=Available（可领取）`、`4=Locked（未解锁）`。

**判定口径（必须照此实现，不要自己发明）**：
- `infos` 前 7 项是周一…周日；第 8 项（`top === '满签奖励'`）是周奖励，**不是一天**。
- 「今日是否已签到」= 7 天项里 `top === '今日'` 的那项的 `status === 2`；
  `status === 3` 表示今天可签。
- 「满签奖励可领」= 第 8 项 `status === 3`。
- `checkin_days` = 本周已签天数（0–7）；`total_reward_points` = 本周累计算力。
- 字段缺失/形状异常 → 归一化函数返回 `null` 并给出人话错误，**不得抛未捕获异常**。

### 1.2 签到 `check_in`

body `{"type":1}`（1=Daily 每日签到；2=WeeklyBonus 满签奖励）。

成功（实测）：
```json
{"banner":"好运正在路上","code":0,"msg":"ok","reward_received":50,"reward_total":50,"type":1}
```

失败码（实测，**必须按码分支，不要只看 HTTP 状态**）：
| code | msg | 语义 | 处理 |
|---|---|---|---|
| `1002` | `today already checked in` | 今天已签过 | **视为成功（幂等）**，`alreadyChecked:true`，不报错 |
| `1004` | `week not fully claimed, dayN unclaimed` | 满签奖励未解锁 | 视为「不可领」，静默跳过 |
| 其它非 0 | — | 真失败 | 抛 `ImaApiError`，消息带 `code` |
| HTTP 403 | — | 非法 type（如 9） | 抛错；代码里 type 只用 1/2 |

### 1.3 规则 `get_activity_rules`

body `{}` → `{"code":0,"msg":"ok","rules":"<h3>…</h3>"}`（HTML 字符串）。
实测规则要点（写进 UI 说明文案即可，不必渲染 HTML）：
- 活动时间 **2026-08-31 00:00 ～ 2026-12-31 23:59**
- 每天可领 1 次；同周满 7 次额外随机算力；每周日 23:59:59 后重置，进度不跨周累计
- 算力有效期 **7 天**（至到期当日 23:59:59），过期不补
- 领取入口：我的 copilot → copilot 设置 → 用量统计 → 每日登录福利

---

## 2 宿主模块 `lib/checkin.js`（席位 A 实现）

**纯模块，不碰 ctx**（便于单测）。所有网络调用走注入的 `fetchImpl`，默认 `globalThis.fetch`。

```js
export const CHECKIN_PATHS = {
  info: '/cgi-bin/daily_login_activity/get_activity_info',
  checkIn: '/cgi-bin/daily_login_activity/check_in',
  rules: '/cgi-bin/daily_login_activity/get_activity_rules',
  shareInfo: '/cgi-bin/daily_login_activity/get_share_info',
}
export const CHECKIN_REFERER = 'https://ima.qq.com/copilot-token-daily-checkin'
export const CHECKIN_TYPE = { daily: 1, weeklyBonus: 2 }
export const CHECKIN_STATUS = { expired: 1, received: 2, available: 3, locked: 4 }
export const ALREADY_CHECKED_CODE = 1002
export const BONUS_NOT_READY_CODE = 1004

/** 归一化活动状态。返回 null 表示形状不可识别（附 reason）。 */
export function normalizeActivityInfo(raw) => {
  checkinDays: number, totalRewardPoints: number,
  today: { label, reward, status, checked: boolean, available: boolean },
  bonus: { status, available: boolean, received: boolean, label, reward },
  days: [{ label, reward, status, isToday }],   // 只含 7 个星期项
} | null

/** 查状态。失败抛 ImaApiError（复用 lib/ima-api.js 的类与 classifyError）。 */
export async function getCheckinStatus(credentials, options = {}) => normalized | null

/** 原始签到。返回 { code, rewardReceived, rewardTotal, type, alreadyChecked, bonusNotReady } */
export async function checkIn(credentials, type, options = {}) => {...}

/**
 * 一轮完整签到（幂等）：
 *  1) 查状态；2) 今日 status===3 → check_in(1)；3) 满签 status===3 → check_in(2)。
 * 返回 { checked, alreadyChecked, claimed:{daily,bonus}, reward, total, status: normalized, errors:[] }
 * 已签过 / 不可领 都不算 errors。
 */
export async function runCheckin(credentials, options = {}) => {...}
```

约定：
- `credentials` 形状与 `lib/ima-api.js` 其它函数一致（`{cookie, bkn}`，由 host 的
  `readRuntimeCredentials` / `withTokenRefresh` 提供；**模块内不做刷新**，刷新由 host 层包）。
- 复用 `lib/ima-api.js` 导出的 `headers()`、`ImaApiError`、`classifyError`，不要另写一套。
- 网络超时默认 15s（`AbortSignal.timeout`），可被 `options.timeoutMs` 覆盖。

---

## 3 持久化与调度 `lib/checkin-store.js` + `lib/checkin-scheduler.js`（席位 A 实现）

### 3.1 存储

路径：`<DSH_HOME>/ima-knowledge/checkin.json`（`DSH_HOME` 优先，否则 `~/.dsh`，
与 `lib/session-store.js` 的 `resolveDshHome` 同源逻辑；**不要 import session-store 的内部函数**，
复制那段 10 行解析逻辑或抽到共享处均可，但不得改动 session-store 的对外行为）。

原子写（tmp + rename），目录 `mkdir -p`。

文件形状（版本化，向后兼容）：
```json
{
  "version": 1,
  "config": { "enabled": true, "time": "09:00" },
  "lastRun": { "date": "2026-11-06", "at": 1793936700000, "ok": true,
               "reward": 50, "total": 50, "alreadyChecked": false, "error": null },
  "history": [
    { "date": "2026-11-06", "at": 1793936700000, "ok": true,
      "reward": 50, "total": 50, "alreadyChecked": false, "error": null }
  ]
}
```
- `history` 只保留最近 **30** 条，按时间倒序（新在前）。
- 文件缺失/损坏/字段非法 → 回落默认值，**不抛**（写一次修复）。
- `config.time` 校验：`/^([01]\d|2[0-3]):[0-5]\d$/`；非法 → 回落 `'09:00'`。
- `config.enabled` 默认 **true**（用户要的就是自动化；面板可关）。

### 3.2 调度器

```js
export function createCheckinScheduler({ store, run, now = () => Date.now(), timers = { setTimeout, clearTimeout }, logger } = {}) => {
  start(): void      // 计算下一次 HH:mm，setTimeout；到点 run 一次后重新 arm
  stop(): void       // 清定时器（幂等）
  runNow(reason): Promise<result>  // 手动/定时共用；单飞（in-flight 去重）
  nextRunAt(nowMs): number         // 纯函数，便于单测
}
```
行为要求：
- **单飞**：`runNow` 并发调用只跑一次，后到者拿到同一个 Promise。
- **每日去重**：`lastRun.date === 今天 && lastRun.ok` → 定时触发时直接跳过（不重复请求）。
- **启动补跑**：`start()` 时若 `enabled && 今天未成功 && 现在 >= 今日 HH:mm` → 立即补跑一次；
  否则等到今日 HH:mm。跨天自动重算（每次 fire 后重新 arm 到明天 HH:mm）。
- `run` 是注入的异步函数（host 层注入「读凭据 + withTokenRefresh + runCheckin」）；
  调度器**不直接读凭据**，也不吞异常——异常写进 `lastRun.error` 并继续 arm。
- 定时器必须 `.unref?.()`（不阻止进程退出），`stop()` 后不得再触发。
- `nextRunAt(nowMs)`：返回下一个本地 HH:mm 的 epoch ms（今天还没到就是今天，否则明天）。

---

## 4 宿主路由（席位 A 实现，`lib/host.js`）

统一信封 `{ok:true,value}` / `{ok:false,error:{code,message}}`，`cache-control:no-store`，
`methods:['POST']`，`requestBody:'buffered'`。

| 路由 | 请求 | 返回 value |
|---|---|---|
| `/api/ima-knowledge/checkin/status` | `{}` | `{configured, tokenValid, enabled, time, today:{date, checked, status, reward}, week:{checkinDays, totalRewardPoints, bonusAvailable}, history:[...], lastRun, error?}` |
| `/api/ima-knowledge/checkin/run` | `{}` | `{checked, alreadyChecked, claimed:{daily,bonus}, reward, total, today, week, lastRun}` |
| `/api/ima-knowledge/checkin/config` | `{enabled?:boolean, time?:string}` | `{enabled, time}` |

语义：
- `status`：**必须真的请求一次上游**（面板打开时看到的是实时状态）；凭据未配置 →
  `ok:true` + `configured:false`（**不是** HTTP 错误）；token 失效 → `ok:true` + `tokenValid:false` + `error`。
- `run`：走 `withTokenRefresh`；返回后把结果写 `history`/`lastRun` 并重新 arm 调度器。
  已签过 → `ok:true, alreadyChecked:true`（不报错）。
- `config`：部分字段更新；`time` 非法 → `{ok:false,error:{code:'BAD_REQUEST',message:'time 必须是 HH:mm'}}`；
  更新后立即重新 arm。
- 新增错误码沿用 `ERROR_CODES` 既有值（`badRequest` 等），不新造。

`apply()` 里：
- 创建 store + scheduler（`options.checkinStore` / `options.checkinScheduler` 可注入，便于测试）；
- `ctx.effect(() => { scheduler.start(); return () => scheduler.stop() }, 'ima-knowledge: checkin scheduler')`；
- 调度器 `run` 注入函数内部用 `services.credentials` + `withTokenRefresh`，**凭据未配置时静默跳过**
  （不要每小时刷错误日志）。

---

## 5 客户端（席位 B 实现）

### 5.1 位置

侧边栏 IMA 面板（`ImaPanel`，`lib/client/20-sidebar.js`）里，**在「知识库」区块之后**新增
`<section data-ima-checkin>` 区块，标题「自动签到」。不新增 tab，不新增侧边栏图标。

### 5.2 必含元素（**2026-11-06 用户要求「紧凑 + 删无用信息」后的定稿**）

整块只占 **3 行**，从上到下：

| 行 | 元素 | 行为 |
|---|---|---|
| 1 | 标题「自动签到」+ 开关（同一行，开关靠右） | `POST /checkin/config {enabled}`；乐观更新 + 失败回滚 + 错误回显 |
| 2 | 状态徽标 + 本周进度（同一行） | 「今日已签到 · +50 算力」/「今日未签到」/「未配置凭据」/「token 已失效」；紧跟「本周已签 N/7 天 · 累计 X 算力」；满签奖励**仅在可领/已领时**追加小徽标 |
| 3 | 「签到时间」+ `HH:mm` 输入 + 「立即签到」按钮 | 失焦/回车保存；非法值就地提示「时间格式应为 HH:mm」；已签过时按钮文案变「今日已签」并禁用；进行中「签到中…」 |

**已删除（用户明确要求：对用户无用的信息）**：区块副标题、时间格式提示文案、独立的「今天已经签过了」提示行、
「最近记录」列表、活动规则说明段（活动期 / 7 天有效期 / 每周重置）。

保留的例外：读取失败时显示一行错误 + 「重试」按钮；运行结果用一行 notice（签到成功 +N / 今天已经签过了 / 失败原因）。

### 5.3 约束

- 只用 `S`（`lib/client/10-core.js` 的样式对象）与 `--dsw-alias-*` token，不引入新依赖、不写 CSS 文件。
- 所有文案走 `t('sb.checkin.xxx')`，**zh/en 两套 key 必须同时补齐**（在 `10-core.js` 的 `zh`/`en` 里加）。
- 宿主失败必须回显 `error.message`（复用 `sbErrorText`/`errorText`），不得静默。
- 区块在「凭据未配置」时仍要渲染（显示引导文案），不能整块消失。
- 新增路由常量进 `ROUTES`：`checkinStatus` / `checkinRun` / `checkinConfig`（相对路径，无前导 `/`）。
- 改完片段必须 `node scripts/build-client.mjs` 重建 `lib/client.js`（生成物，勿手改）。

### 5.4 i18n key（定稿：21 个，zh/en 同名同量）

```
sb.checkin.title / enable / timeLabel / timeInvalid
sb.checkin.todayChecked / todayPending / notConfigured / tokenInvalid
sb.checkin.weekProgress / bonusAvailable / bonusReceived / bonusLocked
sb.checkin.runNow / checkedShort / running / alreadyChecked
sb.checkin.runOk / runOkPlain / runFailed / configFailed / loadFailed
```

（`hint` / `timeHint` / `notConfiguredHint` / `history*` / `rulesNote` 已随紧凑化删除。）

---

## 6 测试与验收

### 6.1 单测（新增文件，不得减少既有 444 项）

| 文件 | 覆盖 |
|---|---|
| `tests/checkin.test.js` | 状态归一化（含畸形输入）/ check_in 成功 / 1002 幂等 / 1004 跳过 / 其它码抛错 / runCheckin 组合逻辑 / 请求头与 body 逐字 |
| `tests/checkin-store.test.js` | 默认值 / 损坏文件回落 / 原子写 / history 截断 30 / time 校验 |
| `tests/checkin-scheduler.test.js` | nextRunAt 边界（00:00、23:59、跨天）/ 单飞 / 每日去重 / 启动补跑 / stop 后不触发（假定时器） |
| `tests/checkin-routes.test.js` | 三条路由的信封与语义（未配置 / token 失效 / 已签过 / time 非法） |
| `tests/checkin-ui.test.js` | 客户端纯函数（状态整形、进度文案、时间校验、历史裁剪） |

### 6.2 基线

当前 `node --test --test-isolation=none "tests/*.test.js"` = **444 tests / 441 pass**，
唯一失败是 `tests/build.test.js` 的 `spawn EPERM`（本机沙箱禁止 node 子进程，**环境问题**，
不是代码问题；改完客户端片段后需手动跑 `node scripts/build-client.mjs` 并确认产物一致）。

### 6.3 真机验收（Lead 执行）

1. `POST /checkin/status` → `today.checked:true`（今天已由 Lead 实测签到，+50 算力）。
2. `POST /checkin/run` → `alreadyChecked:true`，不产生第二次奖励。
3. 面板显示「今日已签到 · +50 算力」「本周已签 1/7 天」。
4. 把时间改成 1 分钟后 → 到点自动跑一轮（日志/`lastRun` 可见），且不重复领。

---

## 7 边界（不做）

- 不做邀请奖励（1006）、双端激励（1009）、浏览器活动（1011）等其它活动类型。
- 不做算力消耗/余额查询（本功能只领不花）。
- 不伪造设备指纹、不绕过风控；只调用官方页面同款接口，频率=每天 1 次（满签日 2 次）。
- 不在插件目录存 cookie；一切凭据走 DSH credential store。
- 不做多账号（本插件单账号模型）。
