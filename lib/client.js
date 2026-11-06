
// ═══ fragment: lib/client/00-head.js ═══
/**
 * dsh-ima-ragplugin — 浏览器半侧 · 片段 00（生成物头部）
 *
 * ⚠ 本文件是 lib/client.js 的**片段**，不是独立模块。
 * 由 `node scripts/build-client.mjs` 按文件名排序拼接生成 lib/client.js。
 * 直接改 lib/client.js 会被下次构建覆盖；要改逻辑请改对应片段。
 *
 * 加载形态：`window.__ModuleLoader__.load({ id, factory })`，factory 只拿到一个
 * `require(name)`，可解析 'react' / 'react/jsx-runtime' / 'react-dom' 等基线模块。
 *
 * 不 require '@deepseek-ai/dsh-client-ui-primitives'：DSH 官方插件开发守则
 * 明确要求插件不要依赖 Harness Client 包——它们会随时改动，且纯 JS 插件没有类型
 * 检查，组件一旦抛错会让整个 slot 条目变成错误占位。所以自绘控件，只用
 * --dsw-alias-* 主题 token 保证跟随明暗主题。
 *
 * 注册位置（v3）：
 *  - `sidebar.panellist` + `main`  → 左侧边栏 IMA 图标与整页配置/授权面板
 *  - `/` 命令菜单（即输入框左下角「+」打开的菜单）→ 新增 ima 行
 *  - `conversation.input.overlay` → 知识库多选模态 + 已选 chip 栏
 *    （chip 栏由 `40-chips.js` portal 到输入框卡片第一个子节点，视觉上在文字上方）
 *  - `plugins.bundle.config`      → 插件设置页卡片（兼容保留）
 */

window.__ModuleLoader__.load({
	id: 'dsh-ima-ragplugin',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

		const React = require('react');
		const h = React.createElement;
		// portal 用（chip 栏要挂进输入框卡片内部）。宿主不给 react-dom 时降级为
		// 「不挂载」而不是抛错 —— chip 是辅助展示区，绝不能影响会话输入。
		let ReactDOM = null;
		try {
			ReactDOM = require('react-dom');
		} catch (_error) {
			ReactDOM = null;
		}

// ═══ fragment: lib/client/10-core.js ═══
/**
 * 浏览器侧 · 片段 10（共享地基，Lead 拥有）。
 *
 * 提供：常量 / 路由 / 双语文案 / 样式表 S / postJson / 错误工具 / 小原子函数。
 * 席位片段（20-sidebar、30-picker）通过 `env` 或闭包直接使用，不需要 import。
 *
 * 末尾的两个 `registerXxx` 是**占位桩**：席位片段用同名 function 声明覆盖
 * （函数声明提升，后声明的生效）。这样即使某个席位还没交付，构建产物依然可用。
 */

// ── 常量 ──────────────────────────────────────────────────────────
/** 包名：Loader id / slot key / package.json name 三者必须一致。 */
const PACKAGE_NAME = 'dsh-ima-ragplugin';
/** locale 命名空间（register 与 slot 的 locale 都用它）。 */
const NS = 'imaKnowledge';

/**
 * 宿主路由。相对路径而非 `/api/...`：DSH 客户端自身也是把
 * `${channel}/${endpoint}` 去掉前导斜杠后交给 fetch，页面挂在子路径下时相对形式才正确。
 */
const ROUTES = {
	list: 'api/ima-knowledge/list',
	select: 'api/ima-knowledge/select',
	status: 'api/ima-knowledge/status',
	credentials: 'api/ima-knowledge/credentials',
	media: 'api/ima-knowledge/media',
	// v5：检索条数设置的读写（宿主 `/api/ima-knowledge/settings`）。
	settings: 'api/ima-knowledge/settings',
	// 自动签到（CHECKIN.md §4 / §5.3）：三条都是相对路径，无前导 `/`。
	checkinStatus: 'api/ima-knowledge/checkin/status',
	checkinRun: 'api/ima-knowledge/checkin/run',
	checkinConfig: 'api/ima-knowledge/checkin/config'
};

// ── 文案 ──────────────────────────────────────────────────────────
/**
 * 简体中文（key 集的事实源）。
 * `sb.` = 侧边栏面板，`pk.` = 「+」菜单与多选模态。
 */
const zh = {
	// 基础（v1 设置卡 + 共用）
	title: 'IMA 知识库',
	subtitle: '从你的 IMA 账号读取可访问的知识库并选择接入。',
	sectionStatus: '凭据状态',
	sectionKnowledgeBases: '可访问的知识库',
	statusUnconfigured: '未配置凭据',
	statusUnconfiguredHint: '尚未配置 IMA 凭据。请先填写 cookie，然后点「保存并验证」。',
	statusValid: 'token 有效',
	statusExpired: 'token 已过期',
	statusExpiredHint: 'IMA token 已失效或即将失效。插件会在下次调用时自动刷新；若持续失败，请重新获取 cookie 并更新。',
	statusUnknown: '状态未知',
	loading: '加载中…',
	loadingStatus: '正在检查凭据状态…',
	empty: '没有可访问的知识库，请先在 IMA 中订阅。',
	emptyFiltered: '没有匹配的知识库。',
	searchPlaceholder: '搜索名称或 ID',
	searchLabel: '搜索知识库',
	selectAll: '全选',
	selectAllHint: '选中当前筛选结果中的全部知识库',
	clear: '清空',
	clearHint: '清空全部已选（含筛选范围之外）',
	refresh: '刷新',
	save: '保存',
	saving: '保存中…',
	saved: '已保存 {n} 个',
	selectedCount: '当前已接入 {n} 个',
	countOfTotal: '已选 {selected} / 共 {total} 个',
	retry: '重试',
	networkError: '网络异常，无法连接宿主路由。',
	unexpectedResponse: '宿主返回了无法识别的响应。',
	saveFailed: '保存失败，选择未被写入。',
	loadFailed: '读取知识库列表失败。',
	statusFailed: '读取凭据状态失败。',
	notConfiguredBanner: '未配置凭据时列表可能为空；配置后点「刷新」重试。',
	unsaved: '有未保存的修改',
	idLabel: 'ID',
	// 侧边栏（sb.）
	'navLabel': 'IMA 知识库',
	'sb.title': 'IMA 知识库',
	'sb.subtitle': '登录你的 IMA 账号，选择要接入会话的知识库。',
	'sb.authTitle': '登录授权',
	'sb.authHint': '粘贴从已登录的 ima.qq.com 复制的完整 x-ima-cookie。bkn 可留空，插件会按 token 自动推导。',
	'sb.cookieLabel': 'x-ima-cookie',
	'sb.cookiePlaceholder': 'IMA-TOKEN=…; IMA-REFRESH-TOKEN=…; …',
	'sb.bknLabel': 'x-ima-bkn（可选）',
	'sb.bknPlaceholder': '留空自动推导',
	'sb.verifyAndSave': '保存并验证',
	'sb.verifying': '正在验证…',
	'sb.clearCredentials': '清除凭据',
	'sb.clearing': '正在清除…',
	'sb.verifyOk': '凭据已保存，token 有效。',
	'sb.verifyFailed': '凭据已保存，但验证失败：{msg}',
	'sb.clearOk': '凭据已清除。',
	'sb.maskedHint': '当前已保存：{value}',
	'sb.credentialsFailed': '凭据操作失败。',
	'sb.kbTitle': '知识库',
	'sb.kbHint': '勾选要接入会话的知识库。',
	'sb.notConfiguredEmpty': '尚未配置凭据。请先在上方填写 cookie 并保存。',
	'sb.accountLine': '已登录：{name}（{uid}）',
	'sb.accountUidOnly': '已登录：{uid}',
	'sb.accountUnknown': '已登录',
	// 桌面客户端同步（§8.3）
	'sb.syncTitle': '从 IMA 桌面客户端同步',
	'sb.syncHint': '自动读取本机已登录的 IMA 客户端凭据',
	'sb.syncing': '正在同步…',
	'sb.syncOk': '已同步，token 有效',
	'sb.syncFailed': '同步失败：{msg}',
	'sb.syncNotLogin': 'IMA 桌面客户端未登录，请先登录客户端',
	'sb.manualToggle': '手动填写',
	'sb.probeFailed': '无法检测 IMA 桌面客户端：{msg}',
	// 检索条数设置（v5）：决定 ima_kb_search 未显式传 limit 时返回多少条。
	'sb.limitTitle': '检索设置',
	'sb.limitHint': '调用 ima_kb_search 时从知识库返回的条数（1-100，默认 10）。',
	'sb.limitLabel': '检索条数',
	'sb.limitCurrent': '当前生效：{n} 条',
	'sb.limitInvalid': '请输入 1-100 之间的整数。',
	'sb.limitSave': '保存条数',
	'sb.limitSaved': '已保存：{n} 条',
	'sb.limitSaveFailed': '保存检索条数失败：{msg}',
	'sb.limitLoadFailed': '读取检索条数失败：{msg}',
	// 会话级选择（§9.6）：`main` 槽是 root 作用域，保存的是默认值而非当前会话。
	'sb.kbHintDefault': '这里设置的是新会话的默认知识库；单个会话的接入范围在聊天框里调整（文字上方的 chip 栏或「+」菜单）。',
	// 输入框内 chip 栏（§9.6）
	'kb.barLabel': '已接入的知识库',
	'kb.remove': '移除知识库：{name}',
	'kb.removeFailed': '移除失败：{msg}',
	// 「+」菜单与多选模态（pk.）
	'pk.label': 'ima',
	'pk.description': '从 IMA 知识库中选择要引用的库',
	'pk.modalTitle': '从 ima 中选择',
	'pk.close': '关闭',
	'pk.tabKb': '选择知识库',
	'pk.tabFile': '选择文件',
	'pk.searchPlaceholder': '搜索知识库',
	'pk.groupPersonal': '个人知识库',
	'pk.groupJoined': '我加入的',
	'pk.selectedCount': '已选择 {n} 项',
	'pk.cancel': '取消',
	'pk.confirm': '确定',
	'pk.loading': '正在读取知识库…',
	'pk.empty': '没有可访问的知识库。',
	'pk.emptyFiltered': '没有匹配的知识库。',
	'pk.fileComingSoon': '文件选择将在后续版本提供。',
	'pk.saved': '已选择 {n} 个知识库',
	'pk.saveFailed': '保存失败：{msg}',
	'pk.loadFailed': '读取知识库失败：{msg}',
	// 侧边栏 · 自动签到（CHECKIN.md §5.4；zh 是 key 集事实源，en 必须同名同量）
	'sb.checkin.title': '自动签到',
	'sb.checkin.enable': '自动签到',
	'sb.checkin.timeLabel': '签到时间',
	'sb.checkin.timeInvalid': '时间格式应为 HH:mm',
	'sb.checkin.todayChecked': '今日已签到 · +{n} 算力',
	'sb.checkin.todayPending': '今日未签到',
	'sb.checkin.notConfigured': '未配置凭据',
	'sb.checkin.tokenInvalid': 'token 已失效',
	'sb.checkin.weekProgress': '本周已签 {days}/7 天 · 累计 {points} 算力',
	'sb.checkin.bonusAvailable': '满签奖励可领',
	'sb.checkin.bonusReceived': '满签奖励已领',
	'sb.checkin.bonusLocked': '满签奖励未解锁',
	'sb.checkin.runNow': '立即签到',
	'sb.checkin.checkedShort': '今日已签',
	'sb.checkin.running': '签到中…',
	'sb.checkin.alreadyChecked': '今天已经签过了',
	'sb.checkin.runOk': '签到成功 · +{n} 算力',
	'sb.checkin.runOkPlain': '签到成功',
	'sb.checkin.runFailed': '签到失败：{msg}',
	'sb.checkin.configFailed': '保存失败：{msg}',
	'sb.checkin.loadFailed': '读取签到状态失败：{msg}'
};

/** English，键集必须与 zh 完全一致。 */
const en = {
	title: 'IMA Knowledge Bases',
	subtitle: 'Read the knowledge bases your IMA account can access and choose which ones to attach.',
	sectionStatus: 'Credential status',
	sectionKnowledgeBases: 'Accessible knowledge bases',
	statusUnconfigured: 'Credentials not configured',
	statusUnconfiguredHint: 'IMA credentials are not configured yet. Paste the cookie, then press Save and verify.',
	statusValid: 'Token valid',
	statusExpired: 'Token expired',
	statusExpiredHint: 'The IMA token is invalid or about to expire. The plugin refreshes it on the next call; if that keeps failing, fetch the cookie again and update it.',
	statusUnknown: 'Status unknown',
	loading: 'Loading…',
	loadingStatus: 'Checking credential status…',
	empty: 'No accessible knowledge bases. Subscribe to some in IMA first.',
	emptyFiltered: 'No matching knowledge bases.',
	searchPlaceholder: 'Search by name or ID',
	searchLabel: 'Search knowledge bases',
	selectAll: 'Select all',
	selectAllHint: 'Select every knowledge base in the current filter',
	clear: 'Clear',
	clearHint: 'Clear every selection, including entries outside the filter',
	refresh: 'Refresh',
	save: 'Save',
	saving: 'Saving…',
	saved: 'Saved {n}',
	selectedCount: '{n} currently attached',
	countOfTotal: '{selected} of {total} selected',
	retry: 'Retry',
	networkError: 'Network error: the Host route is unreachable.',
	unexpectedResponse: 'The Host returned an unrecognized response.',
	saveFailed: 'Save failed; the selection was not written.',
	loadFailed: 'Failed to read the knowledge base list.',
	statusFailed: 'Failed to read the credential status.',
	notConfiguredBanner: 'The list may be empty while credentials are unconfigured; configure them and press Refresh.',
	unsaved: 'Unsaved changes',
	idLabel: 'ID',
	'navLabel': 'IMA Knowledge',
	'sb.title': 'IMA Knowledge Bases',
	'sb.subtitle': 'Sign in to your IMA account and choose the knowledge bases to attach to sessions.',
	'sb.authTitle': 'Sign in / authorization',
	'sb.authHint': 'Paste the full x-ima-cookie copied from a signed-in ima.qq.com. The bkn may be left empty; the plugin derives it from the token.',
	'sb.cookieLabel': 'x-ima-cookie',
	'sb.cookiePlaceholder': 'IMA-TOKEN=…; IMA-REFRESH-TOKEN=…; …',
	'sb.bknLabel': 'x-ima-bkn (optional)',
	'sb.bknPlaceholder': 'Left empty, derived automatically',
	'sb.verifyAndSave': 'Save and verify',
	'sb.verifying': 'Verifying…',
	'sb.clearCredentials': 'Clear credentials',
	'sb.clearing': 'Clearing…',
	'sb.verifyOk': 'Credentials saved; the token is valid.',
	'sb.verifyFailed': 'Credentials saved, but verification failed: {msg}',
	'sb.clearOk': 'Credentials cleared.',
	'sb.maskedHint': 'Currently saved: {value}',
	'sb.credentialsFailed': 'Credential operation failed.',
	'sb.kbTitle': 'Knowledge bases',
	'sb.kbHint': 'Tick the knowledge bases to attach to sessions.',
	'sb.notConfiguredEmpty': 'No credentials yet. Paste the cookie above and save.',
	'sb.accountLine': 'Signed in: {name} ({uid})',
	'sb.accountUidOnly': 'Signed in: {uid}',
	'sb.accountUnknown': 'Signed in',
	'sb.syncTitle': 'Sync from IMA desktop client',
	'sb.syncHint': 'Reads the credentials of your signed-in IMA desktop client',
	'sb.syncing': 'Syncing…',
	'sb.syncOk': 'Synced; the token is valid',
	'sb.syncFailed': 'Sync failed: {msg}',
	'sb.syncNotLogin': 'The IMA desktop client is not signed in; sign in there first',
	'sb.manualToggle': 'Enter manually',
	'sb.probeFailed': 'Cannot detect the IMA desktop client: {msg}',
	'sb.limitTitle': 'Retrieval settings',
	'sb.limitHint': 'Number of passages ima_kb_search returns from the knowledge base (1-100, default 10).',
	'sb.limitLabel': 'Results per search',
	'sb.limitCurrent': 'Currently in effect: {n}',
	'sb.limitInvalid': 'Enter an integer between 1 and 100.',
	'sb.limitSave': 'Save count',
	'sb.limitSaved': 'Saved: {n}',
	'sb.limitSaveFailed': 'Failed to save the retrieval count: {msg}',
	'sb.limitLoadFailed': 'Failed to read the retrieval count: {msg}',
	'sb.kbHintDefault': 'This sets the default knowledge bases for new sessions. Per-session scope is adjusted inside the chat box (chips above the text, or the "+" menu).',
	'kb.barLabel': 'Attached knowledge bases',
	'kb.remove': 'Remove knowledge base: {name}',
	'kb.removeFailed': 'Remove failed: {msg}',
	'sb.accountUidOnly': 'Signed in: {uid}',
	'sb.accountUnknown': 'Signed in',
	'pk.label': 'ima',
	'pk.description': 'Pick knowledge bases from IMA',
	'pk.modalTitle': 'Select from ima',
	'pk.close': 'Close',
	'pk.tabKb': 'Knowledge bases',
	'pk.tabFile': 'Files',
	'pk.searchPlaceholder': 'Search knowledge bases',
	'pk.groupPersonal': 'Personal knowledge bases',
	'pk.groupJoined': 'Joined',
	'pk.selectedCount': '{n} selected',
	'pk.cancel': 'Cancel',
	'pk.confirm': 'Confirm',
	'pk.loading': 'Loading knowledge bases…',
	'pk.empty': 'No accessible knowledge bases.',
	'pk.emptyFiltered': 'No matching knowledge bases.',
	'pk.fileComingSoon': 'File selection will arrive in a later version.',
	'pk.saved': '{n} knowledge bases selected',
	'pk.saveFailed': 'Save failed: {msg}',
	'pk.loadFailed': 'Failed to read knowledge bases: {msg}',
	// Sidebar · auto check-in (CHECKIN.md §5.4; key set must match zh exactly)
	'sb.checkin.title': 'Auto check-in',
	'sb.checkin.enable': 'Auto check-in',
	'sb.checkin.timeLabel': 'Check-in time',
	'sb.checkin.timeInvalid': 'Time must be in HH:mm format',
	'sb.checkin.todayChecked': 'Checked in today · +{n} credits',
	'sb.checkin.todayPending': 'Not checked in today',
	'sb.checkin.notConfigured': 'Credentials not configured',
	'sb.checkin.tokenInvalid': 'Token expired',
	'sb.checkin.weekProgress': '{days}/7 days this week · {points} credits total',
	'sb.checkin.bonusAvailable': 'Weekly bonus available',
	'sb.checkin.bonusReceived': 'Weekly bonus claimed',
	'sb.checkin.bonusLocked': 'Weekly bonus locked',
	'sb.checkin.runNow': 'Check in now',
	'sb.checkin.checkedShort': 'Checked in',
	'sb.checkin.running': 'Checking in…',
	'sb.checkin.alreadyChecked': 'Already checked in today',
	'sb.checkin.runOk': 'Checked in · +{n} credits',
	'sb.checkin.runOkPlain': 'Checked in',
	'sb.checkin.runFailed': 'Check-in failed: {msg}',
	'sb.checkin.configFailed': 'Save failed: {msg}',
	'sb.checkin.loadFailed': 'Failed to read check-in status: {msg}'
};

/** apply 里 bind 一次；组件优先用框架注入的 props.t（切语言会重渲染）。 */
let fallbackTranslate = (key, params) => {
	const template = zh[key] === undefined ? key : zh[key];
	if (params === undefined) return template;
	return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
};

// ── 样式（内联，仅用主题 token）────────────────────────────────────
const S = {
	root: { display: 'flex', flexDirection: 'column', gap: '14px', minWidth: 0, color: 'var(--dsw-alias-label-primary)', fontSize: '13px', lineHeight: '20px' },
	heading: { display: 'flex', flexDirection: 'column', gap: '3px', minWidth: 0 },
	title: { margin: 0, fontSize: '14px', fontWeight: 600, lineHeight: '20px' },
	subtitle: { margin: 0, color: 'var(--dsw-alias-label-secondary)', fontSize: '12.5px', lineHeight: '18px' },
	statusRow: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px', minWidth: 0 },
	statusLabel: { color: 'var(--dsw-alias-label-secondary)', fontSize: '12px' },
	badge: { flex: 'none', display: 'inline-flex', alignItems: 'center', gap: '5px', borderRadius: '999px', padding: '1px 9px', fontSize: '11px', lineHeight: '18px', whiteSpace: 'nowrap' },
	badgeDot: { flex: 'none', width: '6px', height: '6px', borderRadius: '50%', background: 'currentColor' },
	badgeNeutral: { color: 'var(--dsw-alias-label-secondary)', background: 'color-mix(in srgb, var(--dsw-alias-label-secondary) 14%, transparent)' },
	badgeOk: { color: 'var(--dsw-alias-state-success-primary)', background: 'color-mix(in srgb, var(--dsw-alias-state-success-primary) 14%, transparent)' },
	badgeWarn: { color: 'var(--dsw-alias-state-warn-primary)', background: 'color-mix(in srgb, var(--dsw-alias-state-warn-primary) 14%, transparent)' },
	badgeError: { color: 'var(--dsw-alias-state-error-primary)', background: 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 14%, transparent)' },
	hint: { margin: 0, color: 'var(--dsw-alias-label-secondary)', fontSize: '12px', lineHeight: '18px' },
	notice: { margin: 0, borderRadius: '6px', padding: '6px 10px', fontSize: '12px', lineHeight: '18px', overflowWrap: 'anywhere' },
	noticeOk: { color: 'var(--dsw-alias-state-success-primary)', background: 'color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent)' },
	noticeError: { color: 'var(--dsw-alias-state-error-primary)', background: 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent)' },
	toolbar: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px', minWidth: 0 },
	search: { flex: '1 1 180px', minWidth: '140px', height: '32px', boxSizing: 'border-box', border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', font: 'inherit', borderRadius: '6px', outline: 'none', padding: '0 10px', fontSize: '12.5px' },
	button: { flex: 'none', border: '1px solid var(--dsw-alias-border-l2)', background: 'transparent', color: 'var(--dsw-alias-label-primary)', font: 'inherit', fontSize: '12.5px', lineHeight: '18px', cursor: 'pointer', borderRadius: '6px', padding: '5px 11px' },
	buttonPrimary: { border: '1px solid var(--dsw-alias-brand-primary)', color: 'var(--dsw-alias-brand-primary)', background: 'transparent' },
	buttonDanger: { border: '1px solid var(--dsw-alias-state-error-primary)', color: 'var(--dsw-alias-state-error-primary)', background: 'transparent' },
	list: { display: 'flex', flexDirection: 'column', border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-2)', borderRadius: '8px', maxHeight: '320px', overflowY: 'auto', scrollbarWidth: 'thin' },
	row: { display: 'flex', alignItems: 'flex-start', gap: '8px', padding: '7px 10px', borderTop: '1px solid var(--dsw-alias-border-l1)', minWidth: 0 },
	rowFirst: { borderTop: 0 },
	checkbox: { flex: 'none', width: '14px', height: '14px', margin: '3px 0 0', accentColor: 'var(--dsw-alias-brand-primary)', cursor: 'pointer' },
	rowBody: { display: 'flex', flexDirection: 'column', gap: '1px', minWidth: 0, flex: 1 },
	rowName: { overflowWrap: 'anywhere', fontSize: '12.5px', lineHeight: '18px' },
	rowId: { color: 'var(--dsw-alias-label-secondary)', fontFamily: 'var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace)', fontSize: '11px', lineHeight: '16px', overflowWrap: 'anywhere' },
	placeholder: { padding: '14px 12px', color: 'var(--dsw-alias-label-secondary)', fontSize: '12.5px', lineHeight: '18px' },
	footer: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px', minWidth: 0 },
	counts: { display: 'flex', flexDirection: 'column', gap: '1px', minWidth: 0, marginRight: 'auto' },
	countMain: { fontVariantNumeric: 'tabular-nums', fontSize: '12.5px' },
	countSub: { color: 'var(--dsw-alias-label-secondary)', fontVariantNumeric: 'tabular-nums', fontSize: '11.5px' },
	pending: { color: 'var(--dsw-alias-state-warn-primary)', flex: 'none', fontSize: '11px', lineHeight: '18px' },
	// 表单（登录授权）
	field: { display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 },
	fieldLabel: { color: 'var(--dsw-alias-label-secondary)', fontSize: '12px', lineHeight: '18px' },
	input: { width: '100%', boxSizing: 'border-box', border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', font: 'inherit', borderRadius: '6px', outline: 'none', padding: '6px 10px', fontSize: '12.5px', lineHeight: '18px' },
	textarea: { width: '100%', boxSizing: 'border-box', border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', font: 'inherit', fontFamily: 'var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace)', borderRadius: '6px', outline: 'none', padding: '8px 10px', fontSize: '11.5px', lineHeight: '17px', minHeight: '64px', resize: 'vertical' },
	// 整页面板
	page: { display: 'flex', flexDirection: 'column', gap: '18px', minWidth: 0, maxWidth: '860px', margin: '0 auto', padding: '24px 28px 40px', boxSizing: 'border-box' },
	section: { display: 'flex', flexDirection: 'column', gap: '10px', border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-2)', borderRadius: '10px', padding: '14px 16px', minWidth: 0 },
	sectionTitle: { margin: 0, fontSize: '13px', fontWeight: 600, lineHeight: '20px' },
	// 模态（picker）
	modalMask: { position: 'fixed', inset: 0, background: 'rgba(0, 0, 0, 0.32)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2147483000, padding: '24px', boxSizing: 'border-box' },
	modalCard: { display: 'flex', flexDirection: 'column', width: '860px', maxWidth: '100%', maxHeight: '80vh', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', borderRadius: '12px', boxShadow: '0 18px 48px rgba(0, 0, 0, 0.28)', overflow: 'hidden' },
	modalHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', padding: '16px 20px 12px', minWidth: 0 },
	modalTitle: { margin: 0, fontSize: '15px', fontWeight: 600, lineHeight: '22px' },
	modalClose: { flex: 'none', border: 0, background: 'transparent', color: 'var(--dsw-alias-label-secondary)', font: 'inherit', fontSize: '18px', lineHeight: '22px', cursor: 'pointer', borderRadius: '6px', padding: '2px 8px' },
	modalToolbar: { display: 'flex', alignItems: 'center', gap: '10px', padding: '0 20px 10px', minWidth: 0 },
	tabGroup: { display: 'flex', alignItems: 'center', gap: '4px', flex: 'none' },
	tab: { border: 0, background: 'transparent', color: 'var(--dsw-alias-label-secondary)', font: 'inherit', fontSize: '13px', lineHeight: '20px', cursor: 'pointer', borderRadius: '6px', padding: '5px 12px' },
	tabActive: { color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-2)', fontWeight: 600 },
	modalSearch: { flex: '1 1 auto', minWidth: '160px', height: '32px', boxSizing: 'border-box', border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', font: 'inherit', borderRadius: '6px', outline: 'none', padding: '0 10px', fontSize: '12.5px' },
	modalBody: { flex: '1 1 auto', overflowY: 'auto', padding: '0 20px', minHeight: '160px', scrollbarWidth: 'thin' },
	modalGroup: { display: 'flex', flexDirection: 'column', gap: '2px', padding: '8px 0' },
	modalGroupTitle: { margin: 0, padding: '4px 2px', color: 'var(--dsw-alias-label-secondary)', fontSize: '11.5px', lineHeight: '18px' },
	modalRow: { display: 'flex', alignItems: 'center', gap: '10px', padding: '7px 8px', borderRadius: '6px', cursor: 'pointer', minWidth: 0 },
	modalRowName: { overflowWrap: 'anywhere', fontSize: '13px', lineHeight: '20px' },
	modalFooter: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', padding: '12px 20px 16px', borderTop: '1px solid var(--dsw-alias-border-l1)', minWidth: 0 },
	modalActions: { display: 'flex', alignItems: 'center', gap: '10px', flex: 'none' },
	buttonSolid: { border: '1px solid var(--dsw-alias-brand-primary)', background: 'var(--dsw-alias-brand-primary)', color: '#fff', font: 'inherit', fontSize: '12.5px', lineHeight: '18px', cursor: 'pointer', borderRadius: '6px', padding: '5px 14px' },
	buttonDisabled: { opacity: 0.45, cursor: 'not-allowed' },
	// 自动签到（CHECKIN.md §5）：开关轨道 + 滑块，纯 token，跟随明暗主题。
	switchRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', minWidth: 0 },
	switch: { flex: 'none', position: 'relative', width: '36px', height: '20px', boxSizing: 'border-box', border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-1)', borderRadius: '999px', cursor: 'pointer', padding: 0, transition: 'background 120ms ease, border-color 120ms ease' },
	switchOn: { border: '1px solid var(--dsw-alias-brand-primary)', background: 'var(--dsw-alias-brand-primary)' },
	switchKnob: { position: 'absolute', top: '2px', left: '2px', width: '14px', height: '14px', borderRadius: '50%', background: 'var(--dsw-alias-label-secondary)', transition: 'transform 120ms ease, background 120ms ease' },
	switchKnobOn: { transform: 'translateX(16px)', background: 'var(--dsw-alias-bg-layer-1)' }
};

// ── 宿主调用 ──────────────────────────────────────────────────────
/**
 * 统一 POST JSON 并拆信封。
 * @param {string} path - 相对路由路径。
 * @param {unknown} body - 请求体（会被 JSON.stringify）。
 * @returns {Promise<any>} `{ok:true}` 信封里的 value。
 * @throws HostFailure - 网络/HTTP/信封三类失败都抛，绝不静默。
 */
async function postJson(path, body) {
	let response;
	try {
		response = await fetch(path, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body === undefined ? {} : body),
			credentials: 'same-origin',
			cache: 'no-store'
		});
	} catch (cause) {
		throw new HostFailure('network', messageOf(cause) || 'fetch failed');
	}
	if (!response.ok) throw new HostFailure('http', 'HTTP ' + response.status + ' ' + response.statusText, String(response.status));
	let payload;
	try {
		payload = await response.json();
	} catch (cause) {
		throw new HostFailure('parse', messageOf(cause) || 'invalid JSON');
	}
	if (payload !== null && typeof payload === 'object' && payload.ok === true) return payload.value;
	const error = payload !== null && typeof payload === 'object' ? payload.error : undefined;
	const message = error !== null && typeof error === 'object' && typeof error.message === 'string' && error.message !== '' ? error.message : 'host rejected the request';
	const code = error !== null && typeof error === 'object' && error.code !== undefined ? String(error.code) : undefined;
	throw new HostFailure('host', message, code);
}

/** 宿主/网络失败：`kind` 决定文案前缀，`message` 一定是可展示的人话。 */
function HostFailure(kind, message, code) {
	const error = new Error(message);
	error.name = 'HostFailure';
	error.kind = kind;
	error.code = code;
	error.detail = message;
	return error;
}

/** 任意异常 → {kind, detail, code}，保证 UI 永远有字可显示。 */
function failureOf(cause) {
	if (cause !== null && typeof cause === 'object' && cause.kind !== undefined) {
		return { kind: cause.kind, detail: cause.detail || messageOf(cause), code: cause.code };
	}
	return { kind: 'unknown', detail: messageOf(cause) || 'unknown failure', code: undefined };
}

/** 文案替换：网络类失败加本地化前缀，宿主错误直接显示上游 message。 */
function failureText(t, failure) {
	const detail = failure.detail === undefined || failure.detail === '' ? t('unexpectedResponse') : failure.detail;
	if (failure.kind === 'network') return t('networkError') + ' ' + detail;
	return detail;
}

function messageOf(cause) {
	if (cause === null || cause === undefined) return '';
	if (typeof cause === 'string') return cause;
	if (typeof cause.message === 'string') return cause.message;
	return String(cause);
}

/**
 * 宿主 `/status` 的 `error` 有两种真实形状：字符串，或 `{code, message}` 对象。
 * 两种都必须显示出来——SPEC 要求「错误必须回显 error.message，不得静默」。
 * @param {unknown} error - 信封或 value 里的 error 字段。
 * @returns {string|undefined} 可展示文案，无可用文案时 undefined。
 */
function errorText(error) {
	if (typeof error === 'string') return error.trim() === '' ? undefined : error;
	if (error !== null && typeof error === 'object' && typeof error.message === 'string' && error.message.trim() !== '') return error.message;
	return undefined;
}

function isId(value) {
	return typeof value === 'string' && value.trim() !== '';
}

function normalizeBase(entry) {
	if (entry === null || typeof entry !== 'object') return undefined;
	if (!isId(entry.id)) return undefined;
	return { id: entry.id, name: isId(entry.name) ? entry.name : entry.id };
}

// ── 席位占位桩（被同名 function 声明覆盖）────────────────────────────
/**
 * 侧边栏面板注册桩。被 lib/client/20-sidebar.js 的同名声明覆盖。
 * @param {object} ctx - cordis 上下文。
 * @param {object} env - 共享环境。
 * @returns {void}
 */
function registerSidebarPanel(ctx, env) {
	void ctx; void env;
}

/**
 * 「+」菜单与多选模态注册桩。被 lib/client/30-picker.js 的同名声明覆盖。
 * @param {object} ctx - cordis 上下文。
 * @param {object} env - 共享环境。
 * @returns {void}
 */
function registerPicker(ctx, env) {
	void ctx; void env;
}

// ═══ fragment: lib/client/20-sidebar.js ═══
/**
 * 浏览器侧 · 片段 20 —— 左侧边栏面板（席位 client-sidebar 交付）。
 *
 * 注册两处：
 *  - `sidebar.panellist`：左侧边栏图标，`order: 30` > XD Pool 的 20 → 排在它下方。
 *  - `main`（keyed，`key: 'ima-knowledge'`）：整页「登录授权 + 知识库」面板。
 * 另导出 `ImaSettingsCard`：插件设置页卡片（v1 兼容），由 90-tail 注册到
 * `plugins.bundle.config`。
 *
 * 硬约束（本文件是片段，会被拼进 lib/client.js 的 factory 函数体内）：
 *  - 不写 import/export、不写顶层 'use strict'、不写 JSX、不 require 任何
 *    Harness Client 包（官方守则：插件不得依赖，随时会改）。
 *  - 只用 `h`（React.createElement）与 10-core 提供的 S / postJson /
 *    failureText / failureOf / errorText 等闭包能力。
 *  - 顶层 `sb*` 全是**纯函数**（无闭包依赖），因此可以脱离浏览器在 Node 里单测，
 *    见 `tests/sidebar.test.js`。
 *
 * 数据全部走宿主 HTTP 路由（PLATFORM §2 / §8.2）：
 *  - `ROUTES.credentials` `{action:'get'|'set'|'clear'}`
 *  - `ROUTES.status` / `ROUTES.list` / `ROUTES.select`
 *  - `ROUTE_DESKTOP_SYNC`（局部常量）`{action:'probe'|'sync'}`
 *
 * 登录授权区是**三段式**（PLATFORM §8.3）：
 *  1. 状态徽标 + 身份行（昵称 / uid / 可选 24px 圆头像）
 *  2. 主按钮「从 IMA 桌面客户端同步」→ 先 probe 再 sync；不可用时不显示按钮，
 *     直接展开手动填写区并给出 reason
 *  3. 「手动填写」折叠区（兜底，默认折叠）—— 保留 cookie / bkn 表单
 *
 * @module ima-knowledge/client/sidebar
 */

// ══════════════════════════════════════════════════════════════════
// 纯逻辑（Node 可测；不得引用闭包里的任何东西）
// ══════════════════════════════════════════════════════════════════

/**
 * 把任意值收成普通对象；null / 数组 / 标量一律视为空对象。
 * @param {unknown} value - 任意值。
 * @returns {object} 普通对象。
 */
function sbRecord(value) {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
	return value;
}

/**
 * 由 `/status`（或本地合成）的状态得出徽标四态。
 *
 * 输入形状：`{phase:'loading'|'ready'|'error', configured?:boolean, tokenValid?:boolean}`。
 * @param {unknown} status - 状态对象。
 * @returns {'loading'|'unconfigured'|'valid'|'expired'|'unknown'} 徽标态。
 */
function sbTokenPhase(status) {
	const value = sbRecord(status);
	if (value.phase === 'loading') return 'loading';
	if (value.phase === 'error') return 'unknown';
	if (value.phase !== 'ready') return 'loading';
	if (value.configured !== true) return 'unconfigured';
	if (value.tokenValid === true) return 'valid';
	if (value.tokenValid === false) return 'expired';
	return 'unknown';
}

/**
 * 从 `/credentials` `{action:'get'}` 的返回里取**掩码行**。
 *
 * 只读 `cookieMasked`：绝不把掩码回填进输入框，也绝不在本地拼出完整 cookie
 * （掩码由宿主按 PLATFORM §2.2 生成：`IMA-TOKEN=` 前 4 + `…` + 后 4）。
 * @param {unknown} info - credentials get 的 value。
 * @returns {string|undefined} 可展示的掩码文案，无则 undefined。
 */
function sbMaskedLine(info) {
	const value = sbRecord(info);
	if (value.phase !== 'ready') return undefined;
	if (typeof value.cookieMasked !== 'string') return undefined;
	const masked = value.cookieMasked.trim();
	return masked === '' ? undefined : masked;
}

/**
 * 从 `/credentials` 的 value 里取**账号身份**（PLATFORM §2.2 可选字段
 * `account = {uid, nickname?, guid?, openid?, type?}`）。
 *
 * 与「掩码」严格区分：`undefined` = 宿主根本没给 `account`（**不渲染身份行**，
 * 也绝不显示「未登录」这类误导文案）；对象 = 宿主给了，字段可能残缺，
 * 由 {@link sbAccountText} 走降级链。
 * @param {unknown} info - credentials get/set 的 value。
 * @returns {{uid?:string,nickname?:string,guid?:string,openid?:string,type?:number,avatarUrl?:string}|undefined} 账号身份。
 */
function sbAccountOf(info) {
	const value = sbRecord(info);
	const raw = value.account;
	if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
	const pick = (key) => {
		const field = raw[key];
		return typeof field === 'string' && field.trim() !== '' ? field.trim() : undefined;
	};
	const account = {
		uid: pick('uid'),
		nickname: pick('nickname'),
		guid: pick('guid'),
		openid: pick('openid'),
		// 头像 URL 只做展示用途；非法协议由 {@link sbAvatarUrl} 挡掉。
		avatarUrl: pick('avatarUrl')
	};
	if (typeof raw.type === 'number' && Number.isFinite(raw.type)) account.type = raw.type;
	return account;
}

/**
 * 取一条已解析的翻译；`t` 没命中 key 时返回 key 本身，这里视作「未解析」。
 *
 * 作用：字典若晚于本片段落盘，宁可降级也不要让用户看到 `sb.xxx` 裸 key。
 * @param {Function} t - 翻译函数。
 * @param {string} key - key。
 * @param {object} [params] - 插值参数。
 * @returns {string|undefined} 文案；未解析时 undefined。
 */
function sbTranslate(t, key, params) {
	if (typeof t !== 'function') return undefined;
	const text = params === undefined ? t(key) : t(key, params);
	if (typeof text !== 'string' || text === '' || text === key) return undefined;
	return text;
}

/**
 * 账号身份行的**降级链**（PLATFORM §6 A10：任何一级都不得空白或崩）。
 *
 * 顺序：`昵称 + uid` → `仅 uid` → `仅昵称` → `掩码 cookie` → 不渲染。
 * `account === undefined` 表示宿主没给身份，直接不渲染（**不是**「未登录」）。
 * @param {Function} t - 翻译函数。
 * @param {object|undefined} account - {@link sbAccountOf} 的结果。
 * @param {string|undefined} masked - 掩码 cookie（最后一级兜底）。
 * @returns {string|undefined} 身份文案；undefined 表示不渲染这一行。
 */
function sbAccountText(t, account, masked) {
	if (account === undefined) return undefined;
	const name = account.nickname;
	const uid = account.uid;
	if (name !== undefined && uid !== undefined) {
		const both = sbTranslate(t, 'sb.accountLine', { name: name, uid: uid });
		if (both !== undefined) return both;
	}
	if (uid !== undefined) {
		const uidOnly = sbTranslate(t, 'sb.accountUidOnly', { uid: uid });
		if (uidOnly !== undefined) return uidOnly;
	}
	// 只有昵称没有 uid：仍按「已登录：<值>」呈现，值取昵称（不伪造 uid）。
	if (name !== undefined) {
		const nameOnly = sbTranslate(t, 'sb.accountUidOnly', { uid: name });
		if (nameOnly !== undefined) return nameOnly;
	}
	// 身份字段全缺（或对应 key 尚未落盘）→ 退回掩码 cookie，再退回通用「已登录」。
	if (masked !== undefined) {
		const maskedText = sbTranslate(t, 'sb.maskedHint', { value: masked });
		if (maskedText !== undefined) return maskedText;
	}
	return sbTranslate(t, 'sb.accountUnknown');
}

/**
 * 从 `/list` 的 value 里取出规范化的知识库列表（去重、剔除无 id 项）。
 * @param {unknown} value - `/list` 的 value。
 * @returns {Array<{id:string,name:string}>} 知识库列表。
 */
function sbBases(value) {
	const record = sbRecord(value);
	const raw = Array.isArray(record.knowledgeBases) ? record.knowledgeBases : [];
	const out = [];
	const seen = new Set();
	for (const entry of raw) {
		const item = sbRecord(entry);
		if (typeof item.id !== 'string' || item.id.trim() === '') continue;
		if (seen.has(item.id)) continue;
		seen.add(item.id);
		out.push({
			id: item.id,
			name: typeof item.name === 'string' && item.name.trim() !== '' ? item.name : item.id
		});
	}
	return out;
}

/**
 * 从 `/list` 或 `/select` 的 value 里取出已选 id（去重、保序、剔除空串）。
 * @param {unknown} value - 含 `selected` 字段的 value。
 * @returns {string[]} id 列表。
 */
function sbSelectedIds(value) {
	const record = sbRecord(value);
	const raw = Array.isArray(record.selected) ? record.selected : [];
	const out = [];
	const seen = new Set();
	for (const id of raw) {
		if (typeof id !== 'string' || id.trim() === '') continue;
		if (seen.has(id)) continue;
		seen.add(id);
		out.push(id);
	}
	return out;
}

/**
 * 按名称或 ID 做大小写无关的模糊筛选（与 v1 设置卡行为一致）。
 * @param {Array<{id:string,name:string}>} bases - 知识库列表。
 * @param {string} query - 搜索词；空白表示不过滤。
 * @returns {Array<{id:string,name:string}>} 过滤后的**新**数组。
 */
function sbFilterBases(bases, query) {
	const list = Array.isArray(bases) ? bases : [];
	const needle = typeof query === 'string' ? query.trim().toLocaleLowerCase() : '';
	if (needle === '') return list.slice();
	return list.filter((item) => {
		const entry = sbRecord(item);
		const name = typeof entry.name === 'string' ? entry.name.toLocaleLowerCase() : '';
		const id = typeof entry.id === 'string' ? entry.id.toLocaleLowerCase() : '';
		return name.indexOf(needle) !== -1 || id.indexOf(needle) !== -1;
	});
}

/**
 * 「全选当前筛选结果」：并集，保留原有顺序（不重排、不丢筛选外的已选）。
 * @param {string[]} current - 当前草稿选择。
 * @param {string[]} ids - 要并入的 id。
 * @returns {string[]} 新数组。
 */
function sbMergeSelection(current, ids) {
	const out = Array.isArray(current) ? current.slice() : [];
	const seen = new Set(out);
	for (const id of Array.isArray(ids) ? ids : []) {
		if (typeof id !== 'string' || id === '' || seen.has(id)) continue;
		seen.add(id);
		out.push(id);
	}
	return out;
}

/**
 * 草稿 vs 已保存的差异（脏检查）。
 * @param {string[]} draft - 草稿选择。
 * @param {string[]} saved - 最近一次宿主持久化的选择。
 * @returns {{dirty:boolean, added:string[], removed:string[]}} 差异。
 */
function sbSelectionDiff(draft, saved) {
	const next = Array.isArray(draft) ? draft : [];
	const prev = Array.isArray(saved) ? saved : [];
	const prevSet = new Set(prev);
	const nextSet = new Set(next);
	const added = next.filter((id) => !prevSet.has(id));
	const removed = prev.filter((id) => !nextSet.has(id));
	return { dirty: added.length > 0 || removed.length > 0, added: added, removed: removed };
}

/**
 * cookie 是否可提交（去空白后非空）。
 * @param {string} cookie - 输入框内容。
 * @returns {boolean} 可提交。
 */
function sbCanSubmit(cookie) {
	return typeof cookie === 'string' && cookie.trim() !== '';
}

/**
 * 构造 `{action:'set'}` 请求体：cookie 必填并去外层空白；bkn 留空则**不带该字段**
 * （宿主按 `getBkn(IMA-TOKEN)` 自动推导，见 PLATFORM §2.2）。
 * @param {string} cookie - 输入框内容。
 * @param {string} bkn - 输入框内容（可空）。
 * @returns {{action:'set', cookie:string, bkn?:string}|undefined} 请求体；cookie 空则 undefined。
 */
function sbCredentialBody(cookie, bkn) {
	if (!sbCanSubmit(cookie)) return undefined;
	const body = { action: 'set', cookie: cookie.trim() };
	if (typeof bkn === 'string' && bkn.trim() !== '') body.bkn = bkn.trim();
	return body;
}

/**
 * 检索条数设置的默认值 / 范围（与宿主 `DEFAULT_SEARCH_LIMIT` / `MIN` / `MAX` 对齐）。
 *
 * 浏览器侧独立持有一份：宿主返回里也带 `min/max/default`，但首帧（设置还没读回来）
 * 必须有可渲染的合法值，不能等网络。三个数字改一处就必须改两处——测试锁住一致性。
 */
const SB_LIMIT_DEFAULT = 10;
const SB_LIMIT_MIN = 1;
const SB_LIMIT_MAX = 100;

/**
 * `/settings get` 的 value → 可渲染的检索条数状态。
 *
 * 容错口径与宿主 `normalizeSearchLimit` 一致：非法值回落默认、越界收敛到 1-100。
 * 这样即使宿主是老版本（不返回 min/max）或返回脏值，UI 也不会渲染出 0 / NaN。
 * @param {unknown} value - 宿主返回的 value。
 * @returns {{limit:number, min:number, max:number}} 规范化状态。
 */
function sbLimitOf(value) {
	const record = sbRecord(value);
	const numeric = Number(record.searchLimit);
	const min = Number(record.min);
	const max = Number(record.max);
	const limit = Number.isFinite(numeric)
		? Math.min(SB_LIMIT_MAX, Math.max(SB_LIMIT_MIN, Math.floor(numeric)))
		: SB_LIMIT_DEFAULT;
	return {
		limit: limit,
		min: Number.isFinite(min) && min >= SB_LIMIT_MIN ? Math.floor(min) : SB_LIMIT_MIN,
		max: Number.isFinite(max) && max >= SB_LIMIT_MIN ? Math.floor(max) : SB_LIMIT_MAX
	};
}

/**
 * 输入框文本 → 校验结果（`<input type=number>` 的 value 永远是字符串）。
 *
 * 只接受纯数字：`1.5` / `1e3` / `+5` / 空串一律判非法，交给 UI 显示错误，
 * **不**静默取整——用户看到的数字必须就是他保存下去的数字。
 * @param {unknown} text - 输入框内容。
 * @returns {{ok:boolean, value?:number}} 校验结果；`ok:true` 时带 `value`。
 */
function sbLimitDraft(text) {
	const trimmed = typeof text === 'string' ? text.trim() : '';
	if (!/^\d+$/u.test(trimmed)) return { ok: false };
	const value = Number(trimmed);
	if (!Number.isSafeInteger(value) || value < SB_LIMIT_MIN || value > SB_LIMIT_MAX) return { ok: false };
	return { ok: true, value: value };
}

/**
 * 桌面客户端同步路由（PLATFORM §8.2）。
 *
 * 局部常量而非 `ROUTES.desktopSync`：`ROUTES` 在 10-core（Lead 拥有），
 * 本席位不越界改它。**待 Lead 把它并进 10-core 的 `ROUTES` 后**，
 * 这里可以改成 `ROUTES.desktopSync` 并删掉本行（已写进 handback）。
 */
const ROUTE_DESKTOP_SYNC = 'api/ima-knowledge/desktop-sync';

/**
 * 本席位新增的 locale key（中文值即事实源）。
 *
 * 10-core 的 `zh` / `en` 由 Lead 维护，本席位不越界改字典；但 UI 不能因此
 * 露出裸 key，所以这里带一份**内嵌兜底表**：`sbT()` 先问注入的 `t`，
 * 未命中再查本表。Lead 把 key 并入 10-core 后，本表自动退居二线（值一致）。
 *
 * @type {Record<string, string>}
 */
const SB_LOCALE_FALLBACK = {
	'sb.syncTitle': '从 IMA 桌面客户端同步',
	'sb.syncHint': '自动读取本机已登录的 IMA 客户端凭据',
	'sb.syncing': '正在同步…',
	'sb.syncOk': '已同步，token 有效',
	'sb.syncFailed': '同步失败：{msg}',
	'sb.syncNotLogin': 'IMA 桌面客户端未登录，请先登录客户端',
	'sb.manualToggle': '手动填写',
	'sb.probeFailed': '无法检测 IMA 桌面客户端：{msg}',
	// PLATFORM §9.6：`main` 槽是 root 作用域，这里保存的是**新会话的默认知识库**。
	// 文案里不要写 Markdown 星号——它会被当字面量渲染出来。
	'sb.kbHintDefault': '这里设置的是新会话的默认知识库；单个会话的接入范围在聊天框里调整（文字上方的 chip 栏或「+」菜单）。',
	// 检索条数设置（v5）
	'sb.limitTitle': '检索设置',
	'sb.limitHint': '调用 ima_kb_search 时从知识库返回的条数（1-100，默认 10）。',
	'sb.limitLabel': '检索条数',
	'sb.limitCurrent': '当前生效：{n} 条',
	'sb.limitInvalid': '请输入 1-100 之间的整数。',
	'sb.limitSave': '保存条数',
	'sb.limitSaved': '已保存：{n} 条',
	'sb.limitSaveFailed': '保存检索条数失败：{msg}',
	'sb.limitLoadFailed': '读取检索条数失败：{msg}'
};

/**
 * 带内嵌兜底的翻译：注入的 `t` 命中就用它（切语言会重渲染），否则查本表。
 *
 * 与 {@link sbTranslate} 的区别：`sbTranslate` 在未命中时返回 undefined，
 * 用于「宁可降级也不显示裸 key」的降级链；这里用于**必须有字**的主界面文案。
 * @param {Function} t - 翻译函数。
 * @param {string} key - key。
 * @param {object} [params] - 插值参数。
 * @returns {string} 文案（保证非空且不是裸 key）。
 */
function sbT(t, key, params) {
	const resolved = sbTranslate(t, key, params);
	if (resolved !== undefined) return resolved;
	const template = SB_LOCALE_FALLBACK[key] === undefined ? key : SB_LOCALE_FALLBACK[key];
	if (params === undefined) return template;
	return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
}

/**
 * `probe` 返回的 value → 登录授权区可用的**探测态**（PLATFORM §8.2 / §8.3）。
 *
 * 四分支（顺序即优先级，先判「不可用」再判登录）：
 *  - 请求失败（`failure` 非空）→ `failed`：隐藏主按钮、展开手动区、文案用 failureText
 *  - `available !== true`       → `unavailable`：隐藏主按钮、展开手动区、显示 reason
 *  - `isLogin === true`         → `ready`：主按钮可点，副文案可显示 nickname
 *  - 其余（含 `isLogin:false`） → `notLogin`：主按钮可点，副文案提示先登录客户端
 *
 * @param {unknown} value - probe 的 value（`{available,isLogin,userId?,nickname?,...}`）。
 * @param {{kind?:string,detail?:string}|undefined} [failure] - 请求本身失败时的 failureOf 结果。
 * @returns {{mode:'loading'|'ready'|'notLogin'|'unavailable'|'failed', available:boolean,
 *   isLogin:boolean, nickname?:string, userId?:string, avatarUrl?:string,
 *   tokenExpired:boolean, refreshExpired:boolean, reason?:string, failure?:object}} 探测态。
 */
function sbProbeState(value, failure) {
	if (failure !== undefined && failure !== null) {
		return {
			mode: 'failed',
			available: false,
			isLogin: false,
			tokenExpired: false,
			refreshExpired: false,
			failure: failure
		};
	}
	const record = sbRecord(value);
	const text = (key) => {
		const field = record[key];
		return typeof field === 'string' && field.trim() !== '' ? field.trim() : undefined;
	};
	const available = record.available === true;
	const isLogin = available && record.isLogin === true;
	const state = {
		mode: !available ? 'unavailable' : (isLogin ? 'ready' : 'notLogin'),
		available: available,
		isLogin: isLogin,
		nickname: text('nickname'),
		userId: text('userId'),
		avatarUrl: text('avatarUrl'),
		tokenExpired: record.tokenExpired === true,
		refreshExpired: record.refreshExpired === true,
		reason: text('reason')
	};
	return state;
}

/**
 * 探测态 → 主按钮是否显示 / 是否可点。
 *
 * `unavailable` / `failed` 时**整块主路径隐藏**（PLATFORM §8.3 末句：probe 失败不显示
 * 主按钮的错误态，直接展开手动区），因此 `visible:false`。
 * @param {object} probe - {@link sbProbeState} 的结果。
 * @returns {{visible:boolean, enabled:boolean}} 主按钮可见性 / 可点性。
 */
function sbSyncButton(probe) {
	const state = sbRecord(probe);
	const mode = state.mode;
	if (mode === 'loading') return { visible: true, enabled: false };
	if (mode === 'ready' || mode === 'notLogin') return { visible: true, enabled: true };
	return { visible: false, enabled: false };
}

/**
 * 探测态 → 主按钮下方**副文案**的 key 与参数（null 表示不显示副文案）。
 *
 * 文案优先级：失败 > 不可用 > 未登录 > 已登录（有 nickname 才提示昵称）。
 * @param {object} probe - {@link sbProbeState} 的结果。
 * @returns {{key:string, params?:object}|null} 文案描述。
 */
function sbSyncHint(probe) {
	const state = sbRecord(probe);
	const mode = state.mode;
	if (mode === 'failed') return { key: 'sb.probeFailed' };
	if (mode === 'unavailable') return { key: 'sb.probeFailed' };
	if (mode === 'notLogin') return { key: 'sb.syncNotLogin' };
	if (mode === 'ready') {
		return typeof state.nickname === 'string' && state.nickname !== ''
			? { key: 'sb.syncHint', params: { name: state.nickname } }
			: { key: 'sb.syncHint' };
	}
	return null;
}

/**
 * 手动填写区**默认是否折叠**（PLATFORM §8.3 第 3 点）。
 *
 * 主路径不可用时（`unavailable` / `failed`）**直接展开**——用户没有别的手段，
 * 折叠起来等于把唯一的入口藏掉。其余情况默认折叠（主按钮是主路径）。
 * @param {object} probe - {@link sbProbeState} 的结果。
 * @returns {boolean} true = 默认展开。
 */
function sbManualOpen(probe) {
	const mode = sbRecord(probe).mode;
	return mode === 'unavailable' || mode === 'failed';
}

/**
 * 本地化的 error 取值（不依赖闭包 `errorText`，便于脱离浏览器单测）。
 *
 * 宿主 `error` 有两种真实形状：字符串，或 `{code,message}` 对象。
 * @param {unknown} error - value.error。
 * @returns {string|undefined} 可展示文案。
 */
function sbErrorText(error) {
	if (typeof error === 'string') return error.trim() === '' ? undefined : error.trim();
	if (error !== null && typeof error === 'object' && typeof error.message === 'string' && error.message.trim() !== '') {
		return error.message.trim();
	}
	return undefined;
}

/**
 * `sync` 返回的 value → 下一步动作（成功/失败的状态机）。
 *
 * 只有 `tokenValid === true` 才算成功；宿主在 `ok:true` 里带
 * `tokenValid:false` + `error` 表示「解出来了但校验没过」，**不得假装成功**。
 * @param {unknown} value - sync 的 value。
 * @returns {{ok:boolean, error?:string, account?:object}} 判定结果。
 */
function sbSyncResult(value) {
	const record = sbRecord(value);
	const error = sbErrorText(record.error);
	if (record.tokenValid === true) {
		return { ok: true, account: sbAccountOf(record) };
	}
	return { ok: false, error: error, account: sbAccountOf(record) };
}

/**
 * 身份行的**头像 URL 白名单**：只放行 http(s) / data:image。
 *
 * `avatarUrl` 来自桌面客户端本地文件，宿主应已转成可用 URL；这里再挡一层，
 * 避免 `javascript:` 之类的值被塞进 `<img src>`。
 * @param {unknown} value - 候选 URL。
 * @returns {string|undefined} 可用 URL。
 */
function sbAvatarUrl(value) {
	if (typeof value !== 'string') return undefined;
	const url = value.trim();
	if (url === '') return undefined;
	if (/^https?:\/\//iu.test(url)) return url;
	if (/^data:image\//iu.test(url)) return url;
	return undefined;
}

// ══════════════════════════════════════════════════════════════════
// 自动签到（CHECKIN.md §5）：纯逻辑，Node 可测
// ══════════════════════════════════════════════════════════════════

/** 合法签到时间：HH:mm（00:00–23:59），与宿主 checkin-store 的校验正则同源。 */
const SB_CHECKIN_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
/** 默认签到时间（宿主 store 的默认值，CHECKIN.md §3.1）。 */
const SB_CHECKIN_DEFAULT_TIME = '09:00';
/** 面板最多展示最近几条记录（CHECKIN.md §5.2）。 */
const SB_CHECKIN_HISTORY_LIMIT = 7;
/** 上游「今日已领取」的 status 值（CHECKIN.md §1.1：2=Received）。 */
const SB_CHECKIN_STATUS_RECEIVED = 2;

/**
 * 时间串是否合法（HH:mm，允许首尾空白）。
 * @param {unknown} value - 候选值。
 * @returns {boolean} 合法。
 */
function sbCheckinTimeValid(value) {
	if (typeof value !== 'string') return false;
	return SB_CHECKIN_TIME_RE.test(value.trim());
}

/**
 * 时间串归一化：非法/缺失一律回落默认 09:00（绝不把非法值写进输入框）。
 * @param {unknown} value - 候选值。
 * @returns {string} HH:mm。
 */
function sbCheckinTime(value) {
	return sbCheckinTimeValid(value) ? value.trim() : SB_CHECKIN_DEFAULT_TIME;
}

/**
 * 数字字段整形：数字或数字字符串 → 有限数；其余 → fallback。
 * @param {unknown} value - 候选值。
 * @param {number|undefined} fallback - 回落值。
 * @returns {number|undefined} 数值。
 */
function sbCheckinNumber(value, fallback) {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value === 'string' && value.trim() !== '') {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return fallback;
}

/**
 * 算力数值：宿主 `today.reward` 是上游原文（如 `"50算力"`），历史记录里是数字。
 * 两种形状都要能读出来，否则「今日已签到 · +0 算力」会误报 0。
 * @param {unknown} value - 候选值（number / `"50算力"` / `"50"`）。
 * @returns {number} 非负整数（读不出来按 0）。
 */
function sbCheckinReward(value) {
	const direct = sbCheckinNumber(value, undefined);
	if (direct !== undefined) return Math.max(0, Math.round(direct));
	if (typeof value === 'string') {
		const match = value.match(/\d+/);
		if (match !== null) return Number(match[0]);
	}
	return 0;
}

/**
 * 本周已签天数：夹到 0–7 的整数（上游异常值不得让进度越界）。
 * @param {unknown} value - 候选值。
 * @returns {number} 0–7。
 */
function sbCheckinDays(value) {
	const parsed = sbCheckinNumber(value, 0);
	if (parsed === undefined || !Number.isFinite(parsed)) return 0;
	return Math.min(7, Math.max(0, Math.trunc(parsed)));
}

/**
 * 单条签到记录整形（status / run / history 三处共用）。
 *
 * 既无 `date` 也无 `at` 的条目视为无效，返回 undefined 由调用方丢弃。
 * @param {unknown} raw - 原始条目。
 * @returns {{date?:string, at?:number, ok:boolean, reward:number, total:number,
 *   alreadyChecked:boolean, error?:string}|undefined} 记录。
 */
function sbCheckinEntry(raw) {
	const record = sbRecord(raw);
	const date = typeof record.date === 'string' && record.date.trim() !== '' ? record.date.trim() : undefined;
	const at = sbCheckinNumber(record.at, undefined);
	if (date === undefined && at === undefined) return undefined;
	return {
		date: date,
		at: at,
		ok: record.ok === true,
		reward: sbCheckinNumber(record.reward, 0),
		total: sbCheckinNumber(record.total, 0),
		alreadyChecked: record.alreadyChecked === true,
		error: sbErrorText(record.error)
	};
}

/**
 * 历史裁剪：整形 + 丢弃无效 + 只留最近 limit 条。
 *
 * 宿主已按时间倒序写入（CHECKIN.md §3.1），这里保持顺序，不重排。
 * @param {unknown} raw - 原始 history。
 * @param {number} [limit] - 条数上限，默认 7。
 * @returns {Array<object>} 记录列表。
 */
function sbCheckinHistory(raw, limit) {
	const list = Array.isArray(raw) ? raw : [];
	const max = typeof limit === 'number' && limit > 0 ? Math.trunc(limit) : SB_CHECKIN_HISTORY_LIMIT;
	const out = [];
	for (const item of list) {
		const entry = sbCheckinEntry(item);
		if (entry === undefined) continue;
		out.push(entry);
		if (out.length >= max) break;
	}
	return out;
}

/**
 * `/checkin/status` 的 value → 面板可直接消费的状态（**永不抛错**，缺字段给默认值）。
 *
 * 契约见 CHECKIN.md §4：`{configured, tokenValid, enabled, time,
 * today:{date,checked,status,reward}, week:{checkinDays,totalRewardPoints,bonusAvailable},
 * history, lastRun, error?}`。`bonusReceived` / `week.bonusStatus` 是契约外的可选字段，
 * 宿主若给就展示「已领」，不给则按未解锁处理。
 * @param {unknown} value - status 的 value。
 * @returns {object} 状态。
 */
function sbCheckinStatus(value) {
	const record = sbRecord(value);
	const todayRaw = sbRecord(record.today);
	const weekRaw = sbRecord(record.week);
	const todayStatus = sbCheckinNumber(todayRaw.status, undefined);
	const today = {
		date: typeof todayRaw.date === 'string' && todayRaw.date.trim() !== '' ? todayRaw.date.trim() : undefined,
		// status===2 即「今日已领取」；checked 字段优先，两者任一为真都算已签。
		checked: todayRaw.checked === true || todayStatus === SB_CHECKIN_STATUS_RECEIVED,
		status: todayStatus,
		reward: sbCheckinReward(todayRaw.reward)
	};
	const week = {
		checkinDays: sbCheckinDays(weekRaw.checkinDays),
		totalRewardPoints: Math.max(0, sbCheckinNumber(weekRaw.totalRewardPoints, 0)),
		bonusAvailable: weekRaw.bonusAvailable === true,
		bonusReceived: weekRaw.bonusReceived === true || weekRaw.bonusStatus === SB_CHECKIN_STATUS_RECEIVED
	};
	return {
		configured: record.configured === true,
		tokenValid: record.tokenValid === true,
		// 宿主 store 的默认值是 true（CHECKIN.md §3.1）：只有显式 false 才算关闭。
		enabled: record.enabled !== false,
		time: sbCheckinTime(record.time),
		today: today,
		week: week,
		history: sbCheckinHistory(record.history, SB_CHECKIN_HISTORY_LIMIT),
		lastRun: sbCheckinEntry(record.lastRun),
		error: sbErrorText(record.error)
	};
}

/**
 * 状态行四态（供 `data-ima-checkin-status` 与徽标配色使用）。
 * @param {object} state - {@link sbCheckinStatus} 的结果。
 * @returns {'unconfigured'|'tokenInvalid'|'checked'|'pending'} 状态种类。
 */
function sbCheckinStatusKind(state) {
	const record = sbRecord(state);
	if (record.configured !== true) return 'unconfigured';
	if (record.tokenValid !== true) return 'tokenInvalid';
	return sbRecord(record.today).checked === true ? 'checked' : 'pending';
}

/**
 * `/checkin/run` 的 value → 面板可消费的结果。
 *
 * 响应里 `today` / `week` 与 status 同形；缺字段时保留 undefined，
 * 由 {@link sbCheckinApplyRun} 决定是否覆盖本地状态（不拿默认值冲掉真实数据）。
 * @param {unknown} value - run 的 value。
 * @returns {object} 结果。
 */
function sbCheckinRunResult(value) {
	const record = sbRecord(value);
	const claimed = sbRecord(record.claimed);
	const status = sbCheckinStatus(record);
	return {
		checked: record.checked === true,
		alreadyChecked: record.alreadyChecked === true,
		claimed: { daily: claimed.daily === true, bonus: claimed.bonus === true },
		reward: sbCheckinNumber(record.reward, 0),
		total: sbCheckinNumber(record.total, 0),
		today: record.today === undefined ? undefined : status.today,
		week: record.week === undefined ? undefined : status.week,
		lastRun: status.lastRun
	};
}

/**
 * 今日状态行文案：未配置 / token 失效 / 今日已签到 · +N 算力 / 今日未签到。
 * @param {Function} t - 翻译函数。
 * @param {object} state - {@link sbCheckinStatus} 的结果。
 * @returns {string} 文案。
 */
function sbCheckinTodayText(t, state) {
	const record = sbRecord(state);
	if (record.configured !== true) return sbT(t, 'sb.checkin.notConfigured');
	if (record.tokenValid !== true) return sbT(t, 'sb.checkin.tokenInvalid');
	const today = sbRecord(record.today);
	if (today.checked === true) {
		return sbT(t, 'sb.checkin.todayChecked', { n: sbCheckinReward(today.reward) });
	}
	return sbT(t, 'sb.checkin.todayPending');
}

/**
 * 本周进度文案：「本周已签 N/7 天 · 累计 X 算力」。
 * @param {Function} t - 翻译函数。
 * @param {object} week - `state.week`。
 * @returns {string} 文案。
 */
function sbCheckinWeekText(t, week) {
	const record = sbRecord(week);
	return sbT(t, 'sb.checkin.weekProgress', {
		days: sbCheckinDays(record.checkinDays),
		points: Math.max(0, sbCheckinNumber(record.totalRewardPoints, 0))
	});
}

/**
 * 满签奖励状态：可领 / 已领 / 未解锁（可领优先，因为那是唯一可操作的态）。
 * @param {Function} t - 翻译函数。
 * @param {object} week - `state.week`。
 * @returns {string} 文案。
 */
function sbCheckinBonusText(t, week) {
	const record = sbRecord(week);
	if (record.bonusAvailable === true) return sbT(t, 'sb.checkin.bonusAvailable');
	if (record.bonusReceived === true) return sbT(t, 'sb.checkin.bonusReceived');
	return sbT(t, 'sb.checkin.bonusLocked');
}

/**
 * 立即签到的结果文案：已签过 → 「今天已经签过了」；否则「签到成功 · +N 算力」。
 * @param {Function} t - 翻译函数。
 * @param {object} result - {@link sbCheckinRunResult} 的结果。
 * @returns {string} 文案。
 */
function sbCheckinRunText(t, result) {
	const record = sbRecord(result);
	if (record.alreadyChecked === true) return sbT(t, 'sb.checkin.alreadyChecked');
	const reward = sbCheckinNumber(record.reward, 0);
	if (reward > 0) return sbT(t, 'sb.checkin.runOk', { n: reward });
	return sbT(t, 'sb.checkin.runOkPlain');
}

/**
 * 「立即签到」是否可点：凭据有效且今天还没签。
 * @param {object} state - {@link sbCheckinStatus} 的结果。
 * @returns {boolean} 可点。
 */
function sbCheckinCanRun(state) {
	const record = sbRecord(state);
	if (record.configured !== true || record.tokenValid !== true) return false;
	return sbRecord(record.today).checked !== true;
}

/**
 * 把 `/checkin/run` 的结果并入本地状态（刷新今日 / 本周 / 记录）。
 *
 * 只覆盖响应里真实存在的字段；`lastRun` 按日期去重后插到历史最前，再裁到 7 条。
 * @param {object} state - 当前状态。
 * @param {object} result - {@link sbCheckinRunResult} 的结果。
 * @returns {object} 新状态（不修改入参）。
 */
function sbCheckinApplyRun(state, result) {
	const current = sbRecord(state);
	const record = sbRecord(result);
	const lastRun = sbCheckinEntry(record.lastRun);
	let history = sbCheckinHistory(current.history, SB_CHECKIN_HISTORY_LIMIT);
	if (lastRun !== undefined) {
		const rest = history.filter((entry) => entry.date !== lastRun.date);
		history = [lastRun].concat(rest).slice(0, SB_CHECKIN_HISTORY_LIMIT);
	}
	return Object.assign({}, current, {
		today: record.today === undefined ? current.today : record.today,
		week: record.week === undefined ? current.week : record.week,
		lastRun: lastRun === undefined ? current.lastRun : lastRun,
		history: history
	});
}

/**
 * `/checkin/config` 的请求体：只带合法字段；非法时间 / 空补丁返回 undefined（不发送）。
 * @param {{enabled?:boolean, time?:string}} patch - 待保存字段。
 * @returns {{enabled?:boolean, time?:string}|undefined} 请求体。
 */
function sbCheckinConfigBody(patch) {
	const record = sbRecord(patch);
	const body = {};
	if (record.enabled === true || record.enabled === false) body.enabled = record.enabled;
	if (record.time !== undefined) {
		if (!sbCheckinTimeValid(record.time)) return undefined;
		body.time = record.time.trim();
	}
	return Object.keys(body).length === 0 ? undefined : body;
}

// ══════════════════════════════════════════════════════════════════
// 图标
// ══════════════════════════════════════════════════════════════════

/** 五角星（外径 4.2 / 内径 1.9，中心 12,12）—— 18px 下仍清晰。 */
const SB_ICON_STAR = 'M12 7.8 L13.12 10.46 L15.99 10.7 L13.81 12.59 L14.47 15.4 '
	+ 'L12 13.9 L9.53 15.4 L10.19 12.59 L8.01 10.7 L10.88 10.46 Z';

/** 同一面板在设置页与侧边栏可能同时挂载，行 id 必须互不冲突。 */
let sbScopeSeed = 0;

/**
 * 侧边栏图标：圆角方框 + 五角星，纯 SVG、`currentColor`。
 *
 * 选中态不用自己画：shell 通过 `color` 把选中色传进来，`currentColor` 自动跟随
 * 主题与选中态（这也是参考实现 dsh-xdpool 的做法）。
 * @param {{size?:number, active?:boolean}} props - 框架注入的图标呈现参数。
 * @returns {object} React 元素。
 */
function SbIcon(props) {
	const size = typeof props.size === 'number' && props.size > 0 ? props.size : 16;
	return h('svg', {
		xmlns: 'http://www.w3.org/2000/svg',
		viewBox: '0 0 24 24',
		width: size,
		height: size,
		'aria-hidden': 'true',
		focusable: 'false',
		style: { display: 'block' }
	},
		h('rect', {
			x: 3.6,
			y: 3.6,
			width: 16.8,
			height: 16.8,
			rx: 4.4,
			fill: 'none',
			stroke: 'currentColor',
			strokeWidth: 1.7
		}),
		h('path', { fill: 'currentColor', d: SB_ICON_STAR }));
}

// ══════════════════════════════════════════════════════════════════
// 子组件
// ══════════════════════════════════════════════════════════════════

/**
 * 凭据状态徽标：未配置 / 有效 / 过期 / 未知 / 加载中。
 * @param {{t:Function, phase:string, error?:string}} props - 组件参数。
 * @returns {object} React 元素。
 */
function SbStatusBadge(props) {
	const t = props.t;
	const phase = props.phase;
	const table = {
		loading: { tone: S.badgeNeutral, label: t('loadingStatus') },
		unconfigured: { tone: S.badgeWarn, label: t('statusUnconfigured') },
		valid: { tone: S.badgeOk, label: t('statusValid') },
		expired: { tone: S.badgeError, label: t('statusExpired') },
		unknown: { tone: S.badgeError, label: t('statusUnknown') }
	};
	const entry = table[phase] === undefined ? table.unknown : table[phase];
	const children = [
		h('span', { key: 'label', style: S.statusLabel }, t('sectionStatus')),
		h('span', {
			key: 'badge',
			style: Object.assign({}, S.badge, entry.tone),
			'data-ima-status': phase
		},
			h('span', { style: S.badgeDot, 'aria-hidden': 'true' }),
			entry.label)
	];
	return h('div', { style: S.statusRow, 'aria-live': 'polite' }, ...children);
}

/**
 * 单行知识库：复选框 + 名称 + 等宽 ID。
 * @param {object} props - 组件参数。
 * @returns {object} React 元素。
 */
function SbRow(props) {
	const t = props.t;
	const domId = props.scope + '-' + props.index;
	return h('label', {
		style: props.index === 0 ? Object.assign({}, S.row, S.rowFirst) : S.row,
		htmlFor: domId
	},
		h('input', {
			id: domId,
			type: 'checkbox',
			style: S.checkbox,
			checked: props.checked,
			disabled: props.disabled,
			onChange: () => { props.onToggle(props.item.id); }
		}),
		h('span', { style: S.rowBody },
			h('span', { style: S.rowName }, props.item.name),
			h('span', { style: S.rowId, title: props.item.id }, t('idLabel') + ': ' + props.item.id)));
}

/**
 * 搜索框 + 全选 / 清空 / 刷新。
 * @param {object} props - 组件参数。
 * @returns {object} React 元素。
 */
function SbToolbar(props) {
	const t = props.t;
	const busy = props.loading === true;
	const disabled = busy || props.saving === true;
	return h('div', { style: S.toolbar },
		h('input', {
			type: 'search',
			value: props.query,
			disabled: disabled,
			placeholder: t('searchPlaceholder'),
			'aria-label': t('searchLabel'),
			style: S.search,
			onChange: (event) => { props.onQuery(event.currentTarget.value); }
		}),
		h('button', {
			type: 'button',
			style: S.button,
			disabled: disabled || props.visibleCount === 0,
			title: t('selectAllHint'),
			onClick: props.onSelectAll
		}, t('selectAll')),
		h('button', {
			type: 'button',
			style: S.button,
			disabled: disabled || props.selectedCount === 0,
			title: t('clearHint'),
			onClick: props.onClear
		}, t('clear')),
		h('button', {
			type: 'button',
			style: S.button,
			disabled: props.saving === true,
			onClick: props.onRefresh
		}, t('refresh')));
}

/**
 * 列表主体：加载中 / 加载失败 / 未配置空态 / 空 / 筛选无结果 / 正常列表。
 *
 * 「未配置凭据」的空态是显式要求（PLATFORM §6 A10）：不能只给一个空列表。
 * @param {object} props - 组件参数。
 * @returns {object} React 元素。
 */
function SbListBody(props) {
	const t = props.t;
	const list = props.list;
	if (list.phase === 'loading') {
		return h('div', { style: S.list },
			h('p', { style: S.placeholder, 'aria-busy': 'true' }, t('loading')));
	}
	if (list.phase === 'error') {
		return h('div', { style: S.list },
			h('div', {
				style: Object.assign({}, S.placeholder, { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px' })
			},
				h('p', { role: 'alert', style: Object.assign({}, S.hint, { margin: 0 }) },
					t('loadFailed') + ' ' + failureText(t, list.failure)),
				h('button', { type: 'button', style: S.button, onClick: props.onRefresh }, t('retry'))));
	}
	if (props.configured === false && props.total === 0) {
		return h('div', { style: S.list },
			h('p', { style: S.placeholder }, t('sb.notConfiguredEmpty')));
	}
	if (props.total === 0) {
		return h('div', { style: S.list }, h('p', { style: S.placeholder }, t('empty')));
	}
	if (props.visible.length === 0) {
		return h('div', { style: S.list }, h('p', { style: S.placeholder }, t('emptyFiltered')));
	}
	return h('div', { style: S.list }, ...props.visible.map((item, index) => h(SbRow, {
		key: item.id,
		t: t,
		scope: props.scope,
		index: index,
		item: item,
		checked: props.draftSet.has(item.id),
		disabled: props.saving === true,
		onToggle: props.onToggle
	})));
}

/**
 * 本席位局部样式（10-core 的 `S` 由 Lead 拥有，新增视觉只在本文件内定义）。
 *
 * 只使用主题 token，与 `S` 保持同一套视觉语言；不写死颜色值。
 * @type {Record<string, object>}
 */
const SB_STYLE = {
	// 主路径卡片：比表单更醒目，一眼看出「先点这里」
	syncCard: {
		display: 'flex',
		flexDirection: 'column',
		gap: '8px',
		border: '1px solid color-mix(in srgb, var(--dsw-alias-brand-primary) 32%, var(--dsw-alias-border-l1))',
		background: 'color-mix(in srgb, var(--dsw-alias-brand-primary) 5%, transparent)',
		borderRadius: '8px',
		padding: '10px 12px',
		minWidth: 0
	},
	syncButton: {
		display: 'inline-flex',
		alignItems: 'center',
		justifyContent: 'center',
		gap: '7px',
		width: '100%',
		border: '1px solid var(--dsw-alias-brand-primary)',
		background: 'var(--dsw-alias-brand-primary)',
		color: '#fff',
		font: 'inherit',
		fontSize: '12.5px',
		fontWeight: 600,
		lineHeight: '18px',
		cursor: 'pointer',
		borderRadius: '6px',
		padding: '7px 12px'
	},
	syncButtonBusy: { opacity: 0.6, cursor: 'progress' },
	syncHint: {
		margin: 0,
		color: 'var(--dsw-alias-label-secondary)',
		fontSize: '11.5px',
		lineHeight: '17px',
		overflowWrap: 'anywhere'
	},
	syncHintWarn: { color: 'var(--dsw-alias-state-warn-primary)' },
	syncHintError: { color: 'var(--dsw-alias-state-error-primary)' },
	// 身份行：头像 + 文案
	identity: {
		display: 'flex',
		alignItems: 'center',
		gap: '8px',
		minWidth: 0,
		color: 'var(--dsw-alias-label-secondary)',
		fontSize: '12px',
		lineHeight: '18px'
	},
	avatar: {
		flex: 'none',
		width: '24px',
		height: '24px',
		borderRadius: '50%',
		objectFit: 'cover',
		background: 'var(--dsw-alias-bg-layer-2)'
	},
	identityText: { minWidth: 0, overflowWrap: 'anywhere' },
	// 手动填写折叠区
	manualWrap: { display: 'flex', flexDirection: 'column', gap: '8px', minWidth: 0 },
	manualToggle: {
		display: 'inline-flex',
		alignItems: 'center',
		gap: '6px',
		alignSelf: 'flex-start',
		border: 0,
		background: 'transparent',
		color: 'var(--dsw-alias-label-secondary)',
		font: 'inherit',
		fontSize: '12px',
		lineHeight: '18px',
		cursor: 'pointer',
		padding: '2px 0',
		borderRadius: '4px'
	},
	manualCaret: {
		display: 'inline-block',
		width: '8px',
		fontSize: '10px',
		lineHeight: '10px',
		transition: 'transform 120ms ease'
	},
	manualBody: {
		display: 'flex',
		flexDirection: 'column',
		gap: '10px',
		minWidth: 0,
		borderTop: '1px solid var(--dsw-alias-border-l1)',
		paddingTop: '10px'
	},
	// 检索条数（v5）：定宽输入框，避免撑满整行
	limitRow: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px', minWidth: 0 },
	limitLabel: { color: 'var(--dsw-alias-label-secondary)', fontSize: '12px', lineHeight: '18px' },
	limitInput: { width: '96px', flex: 'none', boxSizing: 'border-box', textAlign: 'center' }
};

/**
 * 自动签到区块的局部样式（CHECKIN.md §5.3：只用主题 token，不写 CSS 文件）。
 * @type {Record<string, object>}
 */
const SB_CHECKIN_STYLE = {
	// 头部：标题 + 开关同一行（开关靠右）
	headRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', minWidth: 0 },
	// 状态行：今日状态 + 本周进度 +（可操作时）满签奖励，放不下自然换行
	statusLine: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px', minWidth: 0 },
	// 控制行：时间输入 + 立即签到
	controlRow: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px', minWidth: 0 },
	// 时间输入：定宽，与检索条数输入框同一尺寸语言
	timeInput: { width: '84px', flex: 'none', boxSizing: 'border-box', textAlign: 'center' },
	timeInputInvalid: { borderColor: 'var(--dsw-alias-state-error-primary)' },
	// 时间非法提示：紧挨输入框，不另起一行
	timeError: { flex: 'none', color: 'var(--dsw-alias-state-error-primary)', fontSize: '12px', lineHeight: '18px' },
	// 读取失败：一行原因 + 重试按钮
	errorRow: { display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 },
	errorText: { flex: '1 1 auto', color: 'var(--dsw-alias-state-error-primary)', fontSize: '12px', lineHeight: '18px', overflowWrap: 'anywhere' }
};

/**
 * 身份行（升级版）：有 `avatarUrl` 时渲染 24px 圆头像，无则纯文字。
 *
 * 降级链本身由 {@link sbAccountText} 负责；本组件只管「有没有头像」。
 * @param {{t:Function, text:string, avatarUrl?:string}} props - 组件参数。
 * @returns {object} React 元素。
 */
function SbIdentityRow(props) {
	const avatar = sbAvatarUrl(props.avatarUrl);
	const children = [];
	if (avatar !== undefined) {
		children.push(h('img', {
			key: 'avatar',
			src: avatar,
			alt: '',
			'aria-hidden': 'true',
			loading: 'lazy',
			referrerPolicy: 'no-referrer',
			style: SB_STYLE.avatar
		}));
	}
	children.push(h('span', { key: 'text', style: SB_STYLE.identityText }, props.text));
	return h('div', {
		style: SB_STYLE.identity,
		'data-ima-identity': avatar === undefined ? 'text' : 'avatar'
	}, ...children);
}

/**
 * 主路径：`[从 IMA 桌面客户端同步]` 按钮 + 副文案。
 *
 * 按钮可见性由 {@link sbSyncButton} 决定；`visible:false` 时**整块不渲染**
 * （PLATFORM §8.3：probe 失败不显示主按钮的错误态）。
 * @param {object} props - 组件参数。
 * @returns {object|null} React 元素或 null。
 */
function SbSyncBlock(props) {
	const t = props.t;
	const probe = props.probe;
	const shape = sbSyncButton(probe);
	const hint = sbSyncHint(probe);
	// 副文案在 failed / unavailable 时由手动区上方的 reason 承担，避免同一句说两遍。
	const showHint = hint !== null && shape.visible;
	const busy = props.syncing === true;
	const enabled = shape.enabled && !busy;
	const hintStyle = probe.mode === 'failed'
		? Object.assign({}, SB_STYLE.syncHint, SB_STYLE.syncHintError)
		: (probe.mode === 'notLogin'
			? Object.assign({}, SB_STYLE.syncHint, SB_STYLE.syncHintWarn)
			: SB_STYLE.syncHint);
	const buttonStyle = enabled || busy
		? (busy ? Object.assign({}, SB_STYLE.syncButton, SB_STYLE.syncButtonBusy) : SB_STYLE.syncButton)
		: Object.assign({}, SB_STYLE.syncButton, { opacity: 0.45, cursor: 'not-allowed' });
	const children = [];
	if (shape.visible) {
		children.push(h('button', {
			key: 'sync',
			type: 'button',
			style: buttonStyle,
			disabled: !enabled,
			'aria-disabled': enabled ? undefined : 'true',
			'aria-busy': busy ? 'true' : undefined,
			'data-ima-sync': busy ? 'busy' : (enabled ? 'idle' : 'waiting'),
			onClick: props.onSync
		}, busy ? sbT(t, 'sb.syncing') : sbT(t, 'sb.syncTitle')));
	}
	if (showHint) {
		children.push(h('p', {
			key: 'hint',
			style: hintStyle,
			'data-ima-sync-hint': probe.mode
		}, sbT(t, hint.key, hint.params)));
	}
	if (children.length === 0) return null;
	return h('div', { style: SB_STYLE.syncCard, 'data-ima-sync-card': probe.mode }, ...children);
}

/**
 * 手动填写折叠区（兜底）。
 *
 * 自绘折叠而非 `<details>`：`<details>` 的 `open` 是**非受控** DOM 属性，
 * React 里要同步「同步成功后自动折叠」得直接操作 DOM 节点，不如自己管 state。
 *
 * 折叠实现：内容始终挂载、关闭时用 `hidden` 属性（浏览器原生 `display:none`）。
 * 视觉与交互上就是折叠（不占布局、不进无障碍树、不可聚焦），同时避免
 * 「展开才挂载」带来的表单值丢失——用户折叠一下不该丢掉已经粘好的 cookie。
 * @param {object} props - 组件参数。
 * @returns {object} React 元素。
 */
function SbManualSection(props) {
	const t = props.t;
	const open = props.open === true;
	return h('div', { style: SB_STYLE.manualWrap, 'data-ima-manual': open ? 'open' : 'closed' },
		h('button', {
			type: 'button',
			style: SB_STYLE.manualToggle,
			'aria-expanded': open ? 'true' : 'false',
			'aria-controls': props.scope + '-manual',
			'data-ima-manual-toggle': open ? 'open' : 'closed',
			onClick: props.onToggle
		},
		h('span', {
			style: Object.assign({}, SB_STYLE.manualCaret, { transform: open ? 'rotate(90deg)' : 'none' }),
			'aria-hidden': 'true'
		}, '▶'),
		sbT(t, 'sb.manualToggle')),
		h('div', {
			id: props.scope + '-manual',
			// ⚠ 折叠必须靠条件 style，不能只靠 `hidden` 属性：本节点自带
			// `display: 'flex'`，内联 display 会覆盖浏览器对 `hidden` 施加的
			// `display: none`，导致「箭头显示折叠态、内容却全部可见」。
			// 两者都保留：`hidden` 供无障碍与测试断言，`display` 保证视觉真的收起。
			style: open
				? SB_STYLE.manualBody
				: Object.assign({}, SB_STYLE.manualBody, { display: 'none' }),
			hidden: !open,
			'aria-hidden': open ? undefined : 'true'
		}, props.children));
}

/**
 * 手动填写区的失败/提示条（probe 失败或桌面客户端不可用时的人话 reason）。
 * @param {{t:Function, probe:object, reason?:string}} props - 组件参数。
 * @returns {object|null} React 元素或 null。
 */
function SbProbeReason(props) {
	const probe = props.probe;
	if (probe.mode === 'failed') {
		return h('p', { role: 'alert', 'data-ima-probe-reason': 'failed', style: Object.assign({}, SB_STYLE.syncHint, SB_STYLE.syncHintError) },
			sbT(props.t, 'sb.probeFailed', { msg: props.reason === undefined ? sbT(props.t, 'statusUnknown') : props.reason }));
	}
	if (probe.mode === 'unavailable') {
		return h('p', { role: 'alert', 'data-ima-probe-reason': 'unavailable', style: Object.assign({}, SB_STYLE.syncHint, SB_STYLE.syncHintWarn) },
			sbT(props.t, 'sb.probeFailed', { msg: props.reason === undefined ? sbT(props.t, 'statusUnknown') : props.reason }));
	}
	return null;
}

/**
 * 通知条：成功/失败都要有可见文案（禁止静默失败）。
 * @param {{notice:{tone:'ok'|'error', text:string}|null}} props - 组件参数。
 * @returns {object|null} React 元素或 null。
 */
function SbNotice(props) {
	const notice = props.notice;
	if (notice === null || notice === undefined) return null;
	return h('p', {
		role: notice.tone === 'error' ? 'alert' : 'status',
		style: Object.assign({}, S.notice, notice.tone === 'error' ? S.noticeError : S.noticeOk)
	}, notice.text);
}

/**
 * 检索条数设置区（v5）：决定 `ima_kb_search` 未显式传 `limit` 时返回多少条。
 *
 * 为什么单独一个 section 而不是塞进登录授权区：它跟凭据无关（清空凭据不影响它），
 * 混在一起会让「清除凭据」看起来像把检索条数也清了。放在授权区下方、知识库区上方，
 * 用户在同一屏就能改。
 * @param {object} props - 组件参数。
 * @returns {object} React 元素。
 */
function SbSearchLimitSection(props) {
	const t = props.t;
	const draft = props.draft;
	const state = sbLimitDraft(draft);
	const saved = props.saved;
	const dirty = state.ok && state.value !== saved;
	const saving = props.saving === true;
	const disabled = saving || props.loading === true;
	const inputStyle = disabled
		? Object.assign({}, S.input, SB_STYLE.limitInput, { opacity: 0.6 })
		: Object.assign({}, S.input, SB_STYLE.limitInput);
	const children = [
		h('h3', { key: 'title', style: S.sectionTitle }, sbT(t, 'sb.limitTitle')),
		h('p', { key: 'hint', style: S.hint }, sbT(t, 'sb.limitHint')),
		h('div', { key: 'row', style: SB_STYLE.limitRow },
			h('label', { key: 'label', style: SB_STYLE.limitRow, htmlFor: props.scope + '-limit' },
				h('span', { style: SB_STYLE.limitLabel }, sbT(t, 'sb.limitLabel')),
				h('input', {
					id: props.scope + '-limit',
					type: 'number',
					min: props.min === undefined ? SB_LIMIT_MIN : props.min,
					max: props.max === undefined ? SB_LIMIT_MAX : props.max,
					step: 1,
					value: draft,
					disabled: disabled,
					style: inputStyle,
					'aria-label': sbT(t, 'sb.limitLabel'),
					'aria-invalid': state.ok ? undefined : 'true',
					onChange: (event) => { props.onChange(event.currentTarget.value); },
					onKeyDown: (event) => {
						if (event.key !== 'Enter') return;
						event.preventDefault();
						if (dirty && !disabled) props.onSave();
					}
				})),
			h('button', {
				key: 'save',
				type: 'button',
				style: Object.assign({}, S.button, S.buttonPrimary),
				disabled: disabled || !dirty,
				'aria-disabled': disabled || !dirty ? 'true' : undefined,
				onClick: props.onSave
			}, saving ? t('saving') : sbT(t, 'sb.limitSave'))),
		h('p', { key: 'current', style: S.hint }, sbT(t, 'sb.limitCurrent', { n: saved }))
	];
	if (!state.ok) {
		children.push(h('p', {
			key: 'invalid',
			role: 'alert',
			style: Object.assign({}, S.hint, { color: 'var(--dsw-alias-state-error-primary)' })
		}, sbT(t, 'sb.limitInvalid')));
	}
	if (props.loadError !== undefined) {
		children.push(h('p', {
			key: 'load-error',
			role: 'alert',
			style: Object.assign({}, S.hint, { color: 'var(--dsw-alias-state-error-primary)' })
		}, sbT(t, 'sb.limitLoadFailed', { msg: props.loadError })));
	}
	children.push(h(SbNotice, { key: 'notice', notice: props.notice }));
	return h('section', { style: S.section, 'data-ima-search-limit': '' }, ...children);
}

/**
 * 「自动签到」区块（CHECKIN.md §5.2）。
 *
 * 关键约束：**凭据未配置时整块仍然渲染**（只把「立即签到」置灰并给引导文案），
 * 否则用户既看不到这个功能，也没法先把开关与时间配好。
 * @param {object} props - 组件参数。
 * @returns {object} React 元素。
 */
function SbCheckinSection(props) {
	const t = props.t;
	const state = props.state;
	const loading = state.phase === 'loading';
	const failed = state.phase === 'error';
	const ready = state.phase === 'ready';
	const enabled = ready ? state.enabled === true : true;
	const running = props.running === true;
	const saving = props.saving === true;
	const canRun = ready && sbCheckinCanRun(state) && !running;
	const timeInvalid = props.timeInvalid === true;

	const children = [];

	// 头部：标题 + 开关同一行（开关是这块唯一配置项，标题不需要副文案）。
	children.push(h('div', { key: 'head', style: SB_CHECKIN_STYLE.headRow },
		h('h3', { key: 'title', style: S.sectionTitle }, t('sb.checkin.title')),
		h('button', {
			type: 'button',
			role: 'switch',
			'aria-checked': enabled ? 'true' : 'false',
			'aria-label': t('sb.checkin.enable'),
			'data-ima-checkin-switch': enabled ? 'on' : 'off',
			disabled: !ready || saving,
			style: enabled ? Object.assign({}, S.switch, S.switchOn) : S.switch,
			onClick: props.onToggle
		}, h('span', {
			style: enabled ? Object.assign({}, S.switchKnob, S.switchKnobOn) : S.switchKnob,
			'aria-hidden': 'true'
		}))));

	// 读取失败：给出原因 + 重试，但区块本身不消失（CHECKIN.md §5.3）。
	if (failed) {
		children.push(h('p', {
			key: 'load-failed',
			role: 'alert',
			style: Object.assign({}, S.notice, S.noticeError)
		}, t('sb.checkin.loadFailed', { msg: failureText(t, state.failure) })));
		children.push(h('div', { key: 'retry', style: S.toolbar },
			h('button', { type: 'button', style: S.button, onClick: props.onRefresh }, t('retry'))));
	}

	// 状态行：今日状态 + 本周进度 +（可操作时）满签奖励，三件事一行说完。
	if (ready) {
		const kind = sbCheckinStatusKind(state);
		const tone = kind === 'unconfigured'
			? S.badgeWarn
			: (kind === 'tokenInvalid' ? S.badgeError : (kind === 'checked' ? S.badgeOk : S.badgeNeutral));
		const week = sbRecord(state.week);
		const showBonus = week.bonusAvailable === true || week.bonusReceived === true;
		children.push(h('div', { key: 'status', style: SB_CHECKIN_STYLE.statusLine, 'data-ima-checkin-status': kind },
			h('span', { style: Object.assign({}, S.badge, tone) },
				h('span', { style: S.badgeDot, 'aria-hidden': 'true' }),
				sbCheckinTodayText(t, state)),
			h('span', { style: S.countSub }, sbCheckinWeekText(t, state.week)),
			showBonus
				? h('span', { style: Object.assign({}, S.badge, week.bonusAvailable === true ? S.badgeOk : S.badgeNeutral) },
					sbCheckinBonusText(t, state.week))
				: null));
		if (state.error !== undefined) {
			children.push(h('p', { key: 'status-error', role: 'alert', style: S.hint }, state.error));
		}
	} else if (loading) {
		children.push(h('p', { key: 'loading', style: S.hint, 'aria-busy': 'true' }, t('loading')));
	}

	// 控制行：时间 + 立即签到同一行；已签过时按钮直接写「今日已签」并禁用，不另占一行提示。
	const runLabel = running
		? t('sb.checkin.running')
		: (ready && state.today.checked ? t('sb.checkin.checkedShort') : t('sb.checkin.runNow'));
	children.push(h('div', { key: 'controls', style: SB_CHECKIN_STYLE.controlRow },
		h('span', { key: 'time-label', style: S.fieldLabel }, t('sb.checkin.timeLabel')),
		h('input', {
			type: 'text',
			inputMode: 'numeric',
			value: props.timeDraft,
			placeholder: SB_CHECKIN_DEFAULT_TIME,
			disabled: !ready,
			spellCheck: false,
			autoComplete: 'off',
			'aria-label': t('sb.checkin.timeLabel'),
			'aria-invalid': timeInvalid ? 'true' : undefined,
			'data-ima-checkin-time': timeInvalid ? 'invalid' : 'ok',
			style: timeInvalid
				? Object.assign({}, S.input, SB_CHECKIN_STYLE.timeInput, SB_CHECKIN_STYLE.timeInputInvalid)
				: Object.assign({}, S.input, SB_CHECKIN_STYLE.timeInput),
			onChange: (event) => { props.onTimeChange(event.currentTarget.value); },
			onBlur: props.onTimeCommit,
			onKeyDown: (event) => {
				if (event.key !== 'Enter') return;
				event.preventDefault();
				props.onTimeCommit();
			}
		}),
		timeInvalid ? h('span', { style: SB_CHECKIN_STYLE.timeError }, t('sb.checkin.timeInvalid')) : null,
		h('button', {
			type: 'button',
			style: canRun
				? Object.assign({}, S.button, S.buttonPrimary)
				: Object.assign({}, S.button, S.buttonDisabled),
			disabled: !canRun,
			'aria-disabled': canRun ? undefined : 'true',
			'aria-busy': running ? 'true' : undefined,
			'data-ima-checkin-run': running ? 'busy' : (canRun ? 'idle' : 'disabled'),
			onClick: props.onRun
		}, runLabel)));

	children.push(h(SbNotice, { key: 'notice', notice: props.notice }));

	return h('section', { style: S.section, 'data-ima-checkin': '' }, ...children);
}

// ══════════════════════════════════════════════════════════════════
// 主面板
// ══════════════════════════════════════════════════════════════════

/**
 * IMA 知识库面板：页头 + 登录授权区 + 知识库区。
 *
 * 同一个组件服务两个挂载点：
 *  - `main` 键控面板（整页，自带滚动容器与内边距）；
 *  - `plugins.bundle.config` 设置卡（`variant:'settings'`，紧凑内边距 + 小一号标题）。
 * @param {{t?:Function, variant?:'page'|'settings'}} props - 框架注入的 t 与本地变体。
 * @returns {object} React 元素。
 */
function ImaPanel(props) {
	const t = typeof props.t === 'function' ? props.t : fallbackTranslate;
	const variant = props.variant === 'settings' ? 'settings' : 'page';

	const [scope] = React.useState(() => { sbScopeSeed += 1; return 'ima-sb-' + sbScopeSeed; });
	const [status, setStatus] = React.useState({ phase: 'loading' });
	const [creds, setCreds] = React.useState({ phase: 'loading' });
	const [list, setList] = React.useState({ phase: 'loading' });
	/** 草稿（未保存）选择；`saved` 是最近一次宿主持久化的选择。 */
	const [draft, setDraft] = React.useState([]);
	const [saved, setSaved] = React.useState([]);
	const [query, setQuery] = React.useState('');
	/** 授权表单：绝不从掩码回填，保存成功后立即清空（输入框里不留明文）。 */
	const [cookie, setCookie] = React.useState('');
	const [bkn, setBkn] = React.useState('');
	const [verifying, setVerifying] = React.useState(false);
	const [clearing, setClearing] = React.useState(false);
	const [saving, setSaving] = React.useState(false);
	const [authNotice, setAuthNotice] = React.useState(null);
	const [kbNotice, setKbNotice] = React.useState(null);
	const [request, setRequest] = React.useState(0);
	/**
	 * 桌面客户端探测态（PLATFORM §8.2 `probe`）。
	 * `loading` 是首帧占位；四分支见 {@link sbProbeState}。
	 */
	const [probe, setProbe] = React.useState({ mode: 'loading', available: false, isLogin: false, tokenExpired: false, refreshExpired: false });
	const [syncing, setSyncing] = React.useState(false);
	/** 手动填写区展开态：`null` = 跟随 {@link sbManualOpen} 的默认值（用户还没手动干预）。 */
	const [manualOpen, setManualOpen] = React.useState(null);
	/**
	 * 检索条数设置（v5）：`saved` 是宿主已持久化的值，`draft` 是输入框文本。
	 * 输入框用字符串保存，才能区分「用户清空了」与「值是 0」——直接存 number
	 * 会把空串变成 0，UI 上就再也删不干净。
	 */
	const [limitState, setLimitState] = React.useState({
		phase: 'loading',
		saved: SB_LIMIT_DEFAULT,
		min: SB_LIMIT_MIN,
		max: SB_LIMIT_MAX,
		error: undefined
	});
	const [limitDraft, setLimitDraft] = React.useState(String(SB_LIMIT_DEFAULT));
	const [limitSaving, setLimitSaving] = React.useState(false);
	const [limitNotice, setLimitNotice] = React.useState(null);
	/**
	 * 自动签到（CHECKIN.md §5）：`checkinState` 是 `/checkin/status` 的整形结果
	 * （phase 只有 loading / ready / error），`checkinTimeDraft` 是时间输入框文本。
	 * 时间用字符串保存，才能区分「用户清空了」与「值非法」。
	 */
	const [checkinState, setCheckinState] = React.useState({ phase: 'loading' });
	const [checkinTimeDraft, setCheckinTimeDraft] = React.useState('');
	const [checkinTimeInvalid, setCheckinTimeInvalid] = React.useState(false);
	const [checkinRunning, setCheckinRunning] = React.useState(false);
	const [checkinSaving, setCheckinSaving] = React.useState(false);
	const [checkinNotice, setCheckinNotice] = React.useState(null);

	const draftSet = React.useMemo(() => new Set(draft), [draft]);
	const refresh = React.useCallback(() => { setRequest((value) => value + 1); }, []);

	/**
	 * 探测桌面客户端（只读，不写凭据）。
	 *
	 * 与 list/status/credentials **并行**，且自成一个 effect：probe 失败不能
	 * 拖垮另外三条（PLATFORM §8.3）。失败时把 `failureOf` 结果塞进探测态，
	 * 由 UI 当作 `unavailable` 处理并给出可读文案。
	 */
	React.useEffect(() => {
		let live = true;
		setProbe((current) => (current.mode === 'loading' ? current : Object.assign({}, current, { mode: 'loading' })));
		(async () => {
			try {
				const value = await postJson(ROUTE_DESKTOP_SYNC, { action: 'probe' });
				if (!live) return;
				setProbe(sbProbeState(value, undefined));
			} catch (cause) {
				if (!live) return;
				setProbe(sbProbeState(undefined, failureOf(cause)));
			}
		})();
		return () => { live = false; };
	}, []);

	// 加载：credentials / status / list 并行，任一失败都不拖垮另一个。
	React.useEffect(() => {
		let live = true;
		setStatus({ phase: 'loading' });
		setCreds({ phase: 'loading' });
		setList({ phase: 'loading' });
		(async () => {
			const settled = await Promise.allSettled([
				postJson(ROUTES.credentials, { action: 'get' }),
				postJson(ROUTES.status, {}),
				postJson(ROUTES.list, {}),
				// v5：检索条数设置。老宿主没有这条路由时这里会 reject，
				// 只影响这一块（回落默认 10 并显示读取失败），不拖垮凭据/知识库两条。
				postJson(ROUTES.settings, { action: 'get' })
			]);
			if (!live) return;

			const credResult = settled[0];
			if (credResult.status === 'fulfilled') {
				const value = sbRecord(credResult.value);
				setCreds({
					phase: 'ready',
					configured: value.configured === true,
					hasCookie: value.hasCookie === true,
					hasBkn: value.hasBkn === true,
					cookieMasked: typeof value.cookieMasked === 'string' ? value.cookieMasked : undefined,
					source: typeof value.source === 'string' ? value.source : undefined,
					// 可选身份（PLATFORM §2.2）；宿主没给就是 undefined → 不渲染身份行。
					account: sbAccountOf(value)
				});
			} else {
				setCreds({ phase: 'error', failure: failureOf(credResult.reason) });
			}

			const statusResult = settled[1];
			if (statusResult.status === 'fulfilled') {
				const value = sbRecord(statusResult.value);
				setStatus({
					phase: 'ready',
					configured: value.configured === true,
					tokenValid: value.tokenValid === true,
					error: errorText(value.error)
				});
			} else {
				setStatus({ phase: 'error', failure: failureOf(statusResult.reason) });
			}

			const listResult = settled[2];
			if (listResult.status === 'fulfilled') {
				setList({ phase: 'ready', bases: sbBases(listResult.value) });
				const selected = sbSelectedIds(listResult.value);
				setDraft(selected);
				setSaved(selected);
			} else {
				setList({ phase: 'error', failure: failureOf(listResult.reason) });
			}

			const settingsResult = settled[3];
			if (settingsResult.status === 'fulfilled') {
				const parsed = sbLimitOf(settingsResult.value);
				setLimitState({ phase: 'ready', saved: parsed.limit, min: parsed.min, max: parsed.max, error: undefined });
				setLimitDraft(String(parsed.limit));
			} else {
				// 读取失败不隐藏这一块：仍渲染默认值 10，并把失败原因显示出来（禁止静默）。
				setLimitState({
					phase: 'error',
					saved: SB_LIMIT_DEFAULT,
					min: SB_LIMIT_MIN,
					max: SB_LIMIT_MAX,
					error: failureText(t, failureOf(settingsResult.reason))
				});
				setLimitDraft(String(SB_LIMIT_DEFAULT));
			}
		})();
		return () => { live = false; };
	}, [request]);

	/**
	 * 自动签到状态：独立 effect，与 credentials / status / list 并行。
	 *
	 * 失败只影响本区块（显示错误 + 重试），不拖垮授权区与知识库区；
	 * 刷新时保留上一份 ready 数据，避免整块闪成「加载中」。
	 */
	React.useEffect(() => {
		let live = true;
		setCheckinState((current) => (current.phase === 'ready' ? current : { phase: 'loading' }));
		(async () => {
			try {
				const value = await postJson(ROUTES.checkinStatus, {});
				if (!live) return;
				const next = sbCheckinStatus(value);
				setCheckinState(Object.assign({ phase: 'ready' }, next));
				// 只在输入框还是空的时候回填，避免刷新把用户正在编辑的时间冲掉。
				setCheckinTimeDraft((current) => (current === '' ? next.time : current));
			} catch (cause) {
				if (!live) return;
				setCheckinState({ phase: 'error', failure: failureOf(cause) });
			}
		})();
		return () => { live = false; };
	}, [request]);

	/**
	 * 一键同步：`{action:'sync'}` → 宿主解密 DPAPI → 校验 → 落盘（PLATFORM §8.2）。
	 *
	 * 状态机：
	 *  - 进行中：`syncing=true` → 按钮禁用 + 文案「正在同步…」
	 *  - 成功（`tokenValid:true`）：成功提示 + 刷新身份行/徽标 + **自动重拉 `/list`**
	 *    + 自动折叠手动区
	 *  - 失败（`tokenValid:false`）：显示 `error` 原文，**保持手动区可见**（不假装成功）
	 *  - 请求本身失败：同上，文案走 failureText
	 */
	const syncFromDesktop = React.useCallback(async () => {
		if (syncing === true) return;
		setSyncing(true);
		setAuthNotice(null);
		try {
			const result = sbSyncResult(await postJson(ROUTE_DESKTOP_SYNC, { action: 'sync' }));
			if (result.ok) {
				// 乐观更新身份与徽标，随后 refresh() 以 `/credentials` `get` 为准校正。
				if (result.account !== undefined) {
					setCreds((current) => Object.assign({}, current, {
						phase: 'ready',
						configured: true,
						account: result.account
					}));
				}
				setStatus({ phase: 'ready', configured: true, tokenValid: true });
				setProbe((current) => Object.assign({}, current, {
					mode: 'ready',
					available: true,
					isLogin: true,
					nickname: result.account === undefined ? current.nickname : result.account.nickname,
					avatarUrl: result.account === undefined ? current.avatarUrl : result.account.avatarUrl
				}));
				setAuthNotice({ tone: 'ok', text: sbT(t, 'sb.syncOk') });
				// 同步成功后自动折叠手动区（PLATFORM §8.3 第 2 点）。
				setManualOpen(false);
				setCookie('');
				setBkn('');
				// 自动重新拉 `/list`：凭据变了，知识库列表必须跟着刷新。
				refresh();
			} else {
				const message = result.error === undefined ? sbT(t, 'statusUnknown') : result.error;
				setAuthNotice({ tone: 'error', text: sbT(t, 'sb.syncFailed', { msg: message }) });
				// 失败时手动区必须可见——这是用户唯一的退路。
				setManualOpen(true);
			}
		} catch (cause) {
			setAuthNotice({
				tone: 'error',
				text: sbT(t, 'sb.syncFailed', { msg: failureText(t, failureOf(cause)) })
			});
			setManualOpen(true);
		} finally {
			setSyncing(false);
		}
	}, [syncing, t, refresh]);

	/** 保存并验证凭据（先校验再落盘由宿主保证，见 PLATFORM §2.2）。 */
	const verifyAndSave = React.useCallback(async () => {
		const body = sbCredentialBody(cookie, bkn);
		if (body === undefined) return;
		setVerifying(true);
		setAuthNotice(null);
		try {
			const value = sbRecord(await postJson(ROUTES.credentials, body));
			const ok = value.tokenValid === true;
			const hostError = errorText(value.error);
			setStatus({
				phase: 'ready',
				configured: value.configured !== false,
				tokenValid: ok,
				error: ok ? undefined : hostError
			});
			// `set` 也会带回账号身份与掩码（PLATFORM §2.2）：先乐观更新，
			// 随后 refresh() 再以 `get` 为准校正一次。
			const nextAccount = sbAccountOf(value);
			setCreds((current) => Object.assign({}, current, {
				phase: 'ready',
				configured: value.configured !== false,
				account: nextAccount === undefined ? current.account : nextAccount,
				cookieMasked: typeof value.cookieMasked === 'string' ? value.cookieMasked : current.cookieMasked
			}));
			setAuthNotice(ok
				? { tone: 'ok', text: t('sb.verifyOk') }
				: { tone: 'error', text: t('sb.verifyFailed', { msg: hostError === undefined ? t('statusUnknown') : hostError }) });
			// 明文不进 React state 常驻：成功与否都清空输入框。
			setCookie('');
			setBkn('');
			refresh();
		} catch (cause) {
			setAuthNotice({
				tone: 'error',
				text: t('sb.credentialsFailed') + ' ' + failureText(t, failureOf(cause))
			});
		} finally {
			setVerifying(false);
		}
	}, [cookie, bkn, t, refresh]);

	/** 清除凭据。 */
	const clearCredentials = React.useCallback(async () => {
		setClearing(true);
		setAuthNotice(null);
		try {
			await postJson(ROUTES.credentials, { action: 'clear' });
			setStatus({ phase: 'ready', configured: false, tokenValid: false });
			// 清除后身份行必须消失：连 account / 掩码一起清掉，不留残影。
			setCreds({ phase: 'ready', configured: false, hasCookie: false, hasBkn: false });
			setAuthNotice({ tone: 'ok', text: t('sb.clearOk') });
			setCookie('');
			setBkn('');
			refresh();
		} catch (cause) {
			setAuthNotice({
				tone: 'error',
				text: t('sb.credentialsFailed') + ' ' + failureText(t, failureOf(cause))
			});
		} finally {
			setClearing(false);
		}
	}, [t, refresh]);

	/**
	 * 保存知识库选择。
	 *
	 * **这里写的是全局默认值，不是当前会话**（PLATFORM §9.6）：`main` 槽是 root 作用域，
	 * 没有会话身份，所以**不带 sessionId** → 宿主按「新会话的初始默认值」落盘。
	 * 单个会话的接入范围在聊天框上方（chip 栏 / 「+」菜单）调整。
	 */
	const saveSelection = React.useCallback(async () => {
		setSaving(true);
		setKbNotice(null);
		try {
			// 不带 sessionId = 写全局默认值（宿主 §9.5 的兼容分支）。
			const value = await postJson(ROUTES.select, { ids: draft });
			const next = Array.isArray(sbRecord(value).selected) ? sbSelectedIds(value) : draft;
			setDraft(next);
			setSaved(next);
			// 通知 chip 栏（`40-chips.js` 监听此事件）。但这里是**全局默认值**，
			// 不是任何会话的选中集 → `sessionId: null`，chip 栏据此忽略它。
			// 若照旧不带会话，就等于「改默认值 = 改所有会话」，正是本轮的缺陷。
			try {
				window.dispatchEvent(new CustomEvent('ima-kb-selection-changed', {
					detail: { sessionId: null, selected: next }
				}));
			} catch (signalError) {
				console.warn('[dsh-ima-ragplugin] selection signal failed:', signalError);
			}
			setKbNotice({ tone: 'ok', text: t('saved', { n: next.length }) });
		} catch (cause) {
			setKbNotice({
				tone: 'error',
				text: t('saveFailed') + ' ' + failureText(t, failureOf(cause))
			});
		} finally {
			setSaving(false);
		}
	}, [draft, t]);

	/**
	 * 保存检索条数（v5）。
	 *
	 * 与「保存知识库选择」一样写**全局**设置（不分会话）：检索条数是账号级偏好，
	 * 每个会话都该用同一套默认值。写侧严格校验由宿主负责，这里先本地挡一次，
	 * 非法输入不发请求（避免用错误请求污染宿主日志）。
	 */
	const saveLimit = React.useCallback(async () => {
		const parsed = sbLimitDraft(limitDraft);
		if (!parsed.ok) return;
		setLimitSaving(true);
		setLimitNotice(null);
		try {
			const value = await postJson(ROUTES.settings, { action: 'set', searchLimit: parsed.value });
			const next = sbLimitOf(value);
			setLimitState((current) => Object.assign({}, current, {
				phase: 'ready',
				saved: next.limit,
				min: next.min,
				max: next.max,
				error: undefined
			}));
			setLimitDraft(String(next.limit));
			setLimitNotice({ tone: 'ok', text: sbT(t, 'sb.limitSaved', { n: next.limit }) });
		} catch (cause) {
			setLimitNotice({
				tone: 'error',
				text: sbT(t, 'sb.limitSaveFailed', { msg: failureText(t, failureOf(cause)) })
			});
		} finally {
			setLimitSaving(false);
		}
	}, [limitDraft, t]);

	/**
	 * 保存签到配置（开关 / 时间共用）：乐观更新由调用方先做，这里负责请求、
	 * 成功校正、失败回滚 + 错误回显（CHECKIN.md §5.3：宿主失败不得静默）。
	 * @param {{enabled?:boolean, time?:string}} patch - 待保存字段。
	 * @param {object} rollback - 失败时回滚的字段。
	 * @returns {Promise<boolean>} 是否保存成功。
	 */
	const saveCheckinConfig = React.useCallback(async (patch, rollback) => {
		const body = sbCheckinConfigBody(patch);
		if (body === undefined) return false;
		setCheckinSaving(true);
		setCheckinNotice(null);
		try {
			const value = sbRecord(await postJson(ROUTES.checkinConfig, body));
			setCheckinState((current) => (current.phase === 'ready'
				? Object.assign({}, current, {
					enabled: value.enabled === undefined ? current.enabled : value.enabled === true,
					time: value.time === undefined ? current.time : sbCheckinTime(value.time)
				})
				: current));
			return true;
		} catch (cause) {
			setCheckinState((current) => (current.phase === 'ready' ? Object.assign({}, current, rollback) : current));
			setCheckinNotice({
				tone: 'error',
				text: sbT(t, 'sb.checkin.configFailed', { msg: failureText(t, failureOf(cause)) })
			});
			return false;
		} finally {
			setCheckinSaving(false);
		}
	}, [t]);

	/** 开关「自动签到」：先乐观翻转，失败回滚。 */
	const toggleCheckin = React.useCallback(() => {
		if (checkinState.phase !== 'ready' || checkinSaving) return;
		const next = checkinState.enabled !== true;
		setCheckinState((current) => (current.phase === 'ready' ? Object.assign({}, current, { enabled: next }) : current));
		saveCheckinConfig({ enabled: next }, { enabled: !next });
	}, [checkinState, checkinSaving, saveCheckinConfig]);

	/** 时间输入失焦 / 回车：本地校验 → 保存；非法值只提示、不发请求。 */
	const commitCheckinTime = React.useCallback(() => {
		if (checkinState.phase !== 'ready') return;
		if (!sbCheckinTimeValid(checkinTimeDraft)) {
			setCheckinTimeInvalid(true);
			return;
		}
		setCheckinTimeInvalid(false);
		const next = checkinTimeDraft.trim();
		if (next === checkinState.time) return;
		const previous = checkinState.time;
		setCheckinState((current) => (current.phase === 'ready' ? Object.assign({}, current, { time: next }) : current));
		// 保存成功后把输入框归一化（去掉用户输入的首尾空白），失败时保留原文便于重试。
		saveCheckinConfig({ time: next }, { time: previous }).then((ok) => {
			if (ok) setCheckinTimeDraft(next);
		});
	}, [checkinState, checkinTimeDraft, saveCheckinConfig]);

	/** 立即签到：进行中禁用；已签过由宿主返回 alreadyChecked，不当作错误。 */
	const runCheckin = React.useCallback(async () => {
		if (checkinRunning) return;
		setCheckinRunning(true);
		setCheckinNotice(null);
		try {
			const result = sbCheckinRunResult(await postJson(ROUTES.checkinRun, {}));
			setCheckinState((current) => (current.phase === 'ready' ? sbCheckinApplyRun(current, result) : current));
			setCheckinNotice({ tone: 'ok', text: sbCheckinRunText(t, result) });
		} catch (cause) {
			setCheckinNotice({
				tone: 'error',
				text: sbT(t, 'sb.checkin.runFailed', { msg: failureText(t, failureOf(cause)) })
			});
		} finally {
			setCheckinRunning(false);
		}
	}, [checkinRunning, t]);

	const toggle = React.useCallback((id) => {
		setDraft((current) => (current.indexOf(id) === -1
			? current.concat([id])
			: current.filter((entry) => entry !== id)));
	}, []);

	const bases = list.phase === 'ready' ? list.bases : [];
	const visible = sbFilterBases(bases, query);

	const selectAllVisible = React.useCallback(() => {
		setDraft((current) => sbMergeSelection(current, visible.map((item) => item.id)));
	}, [visible]);
	const clearAll = React.useCallback(() => { setDraft([]); }, []);

	const phase = sbTokenPhase(status);
	// `configured` 以 `/credentials` 的 get 为准（它才是凭据本身的权威）；
	// 该路由失败时退回 `/status`；两者都还没回来就按「未配置」处理（按钮置灰，
	// 不会出现「能点但点了报错」）。绝不乐观地默认成 true。
	const configured = creds.phase === 'ready'
		? creds.configured === true
		: (status.phase === 'ready' ? status.configured === true : false);
	const masked = sbMaskedLine(creds);
	// 身份行：宿主没给 account 时 accountLine 为 undefined → 退回掩码，两者都无则不渲染。
	const accountLine = configured ? sbAccountText(t, creds.account, masked) : undefined;
	const diff = sbSelectionDiff(draft, saved);
	const canSave = list.phase === 'ready' && saving !== true;
	const canSubmit = sbCanSubmit(cookie) && verifying !== true;
	const canClear = configured && clearing !== true;

	const headingTag = variant === 'settings' ? 'h4' : 'h2';
	// 主列 `.centerCol` 是 `display:flex; flex-direction:column; overflow:hidden`
	// 且不提供滚动（参考实现 dsh-xdpool 的 page 包装同理）：滚动容器必须自己给，
	// 否则整页内容会被直接裁掉。设置页由插件详情对话框提供滚动与内边距，故不再套一层。
	const innerStyle = variant === 'settings'
		? Object.assign({}, S.page, { maxWidth: 'none', padding: '0', gap: '14px' })
		: S.page;
	const scrollStyle = {
		flex: '1 1 auto',
		height: '100%',
		minHeight: 0,
		overflowY: 'auto',
		overflowX: 'hidden',
		scrollbarWidth: 'thin',
		boxSizing: 'border-box'
	};

	// ── 页头 ──────────────────────────────────────────────────────
	const header = h('header', { style: S.heading },
		h(headingTag, { style: S.title }, t('sb.title')),
		h('p', { style: S.subtitle }, t('sb.subtitle')));

	// ── 登录授权区（三段式，PLATFORM §8.3）────────────────────────
	// 1) 徽标 + 身份行
	const authChildren = [
		h('h3', { key: 'title', style: S.sectionTitle }, t('sb.authTitle')),
		h(SbStatusBadge, { key: 'badge', t: t, phase: phase })
	];
	if (phase === 'unconfigured') {
		authChildren.push(h('p', { key: 'hint-unconfigured', style: S.hint }, t('statusUnconfiguredHint')));
	} else if (phase === 'expired') {
		authChildren.push(h('p', { key: 'hint-expired', style: S.hint }, t('statusExpiredHint')));
	}
	if (status.phase === 'ready' && status.error !== undefined) {
		authChildren.push(h('p', { key: 'status-error', role: 'alert', style: S.hint }, status.error));
	}
	if (status.phase === 'error') {
		authChildren.push(h('p', { key: 'status-failure', role: 'alert', style: S.hint },
			failureText(t, status.failure)));
	}
	// 身份行与掩码行只渲染**一条**（避免同一信息出现两次）：
	// 有账号身份用身份（可带头像），没有就退回掩码 cookie，两者都无则不渲染。
	const maskedLine = masked === undefined ? undefined : sbTranslate(t, 'sb.maskedHint', { value: masked });
	const showAccount = accountLine !== undefined;
	const identityLine = showAccount ? accountLine : maskedLine;
	// 头像优先取 probe（桌面客户端里是最新的），其次取 credentials 的 account。
	const avatarUrl = sbAvatarUrl(creds.account === undefined ? undefined : creds.account.avatarUrl)
		|| sbAvatarUrl(probe.avatarUrl);
	if (identityLine !== undefined) {
		authChildren.push(h(SbIdentityRow, {
			key: 'identity',
			t: t,
			text: identityLine,
			avatarUrl: showAccount ? avatarUrl : undefined
		}));
	}
	if (creds.phase === 'error') {
		authChildren.push(h('p', { key: 'creds-failure', role: 'alert', style: S.hint },
			t('sb.credentialsFailed') + ' ' + failureText(t, creds.failure)));
	}

	// 2) 主路径：从 IMA 桌面客户端同步（不可用/失败时整块隐藏，见 sbSyncButton）
	const syncBlock = h(SbSyncBlock, {
		key: 'sync',
		t: t,
		probe: probe,
		syncing: syncing,
		onSync: syncFromDesktop
	});
	if (syncBlock !== null) authChildren.push(syncBlock);

	// 2b) probe 失败 / 不可用的 reason（主按钮已隐藏，这里必须给出人话）
	const probeReason = probe.mode === 'failed'
		? failureText(t, probe.failure)
		: probe.reason;
	authChildren.push(h(SbProbeReason, {
		key: 'probe-reason',
		t: t,
		probe: probe,
		reason: probeReason
	}));

	// 3) 手动填写（折叠，兜底）：默认折叠；probe 不可用/失败时默认展开
	const manualExpanded = manualOpen === null ? sbManualOpen(probe) : manualOpen === true;
	const manualChildren = [
		h('label', { key: 'cookie', style: S.field },
			h('span', { style: S.fieldLabel }, t('sb.cookieLabel')),
			h('textarea', {
				style: S.textarea,
				value: cookie,
				rows: 3,
				spellCheck: false,
				autoComplete: 'off',
				'aria-label': t('sb.cookieLabel'),
				placeholder: t('sb.cookiePlaceholder'),
				disabled: verifying,
				onChange: (event) => { setCookie(event.currentTarget.value); }
			})),
		h('label', { key: 'bkn', style: S.field },
			h('span', { style: S.fieldLabel }, t('sb.bknLabel')),
			h('input', {
				type: 'text',
				style: S.input,
				value: bkn,
				spellCheck: false,
				autoComplete: 'off',
				'aria-label': t('sb.bknLabel'),
				placeholder: t('sb.bknPlaceholder'),
				disabled: verifying,
				onChange: (event) => { setBkn(event.currentTarget.value); },
				onKeyDown: (event) => {
					if (event.key !== 'Enter') return;
					event.preventDefault();
					if (canSubmit) verifyAndSave();
				}
			})),
		h('p', { key: 'manual-hint', style: S.hint }, t('sb.authHint')),
		h('div', { key: 'actions', style: S.toolbar },
			h('button', {
				type: 'button',
				style: Object.assign({}, S.button, canSubmit ? S.buttonPrimary : {}),
				disabled: !canSubmit,
				'aria-disabled': canSubmit ? undefined : 'true',
				onClick: verifyAndSave
			}, verifying ? t('sb.verifying') : t('sb.verifyAndSave')),
			h('button', {
				type: 'button',
				style: Object.assign({}, S.button, canClear ? S.buttonDanger : {}),
				disabled: !canClear,
				'aria-disabled': canClear ? undefined : 'true',
				onClick: clearCredentials
			}, clearing ? t('sb.clearing') : t('sb.clearCredentials')))
	];
	authChildren.push(h(SbManualSection, {
		key: 'manual',
		t: t,
		scope: scope,
		open: manualExpanded,
		onToggle: () => { setManualOpen(manualExpanded !== true); }
	}, ...manualChildren));
	authChildren.push(h(SbNotice, { key: 'notice', notice: authNotice }));

	const authSection = h('section', { style: S.section, 'data-ima-auth': '' }, ...authChildren);

	// ── 检索设置区（v5）───────────────────────────────────────────
	const limitSection = h(SbSearchLimitSection, {
		t: t,
		scope: scope,
		draft: limitDraft,
		saved: limitState.saved,
		min: limitState.min,
		max: limitState.max,
		loading: limitState.phase === 'loading',
		loadError: limitState.error,
		saving: limitSaving,
		notice: limitNotice,
		onChange: setLimitDraft,
		onSave: saveLimit
	});

	// ── 知识库区 ──────────────────────────────────────────────────
	// 文案必须是「默认值」语义（PLATFORM §9.6）：本面板不是会话作用域，
	// 它保存的是**新会话的默认知识库**，不是当前会话的接入范围。
	// `sb.kbHintDefault` 是本席位新增 key，`sbT` 带内嵌兜底（Lead 并入 10-core 后自动退居二线）。
	const kbSection = h('section', { style: S.section, 'data-ima-kb': '' },
		h('h3', { style: S.sectionTitle }, t('sb.kbTitle')),
		h('p', { style: S.hint }, sbT(t, 'sb.kbHintDefault')),
		h(SbToolbar, {
			t: t,
			query: query,
			onQuery: setQuery,
			loading: list.phase === 'loading',
			saving: saving,
			visibleCount: visible.length,
			selectedCount: draft.length,
			onSelectAll: selectAllVisible,
			onClear: clearAll,
			onRefresh: refresh
		}),
		h(SbListBody, {
			t: t,
			scope: scope,
			list: list,
			configured: configured,
			visible: visible,
			total: bases.length,
			draftSet: draftSet,
			saving: saving,
			onToggle: toggle,
			onRefresh: refresh
		}),
		h(SbNotice, { notice: kbNotice }),
		h('div', { style: S.footer },
			h('div', { style: S.counts },
				h('span', { style: S.countMain }, t('selectedCount', { n: saved.length })),
				h('span', { style: S.countSub }, t('countOfTotal', { selected: draft.length, total: bases.length }))),
			diff.dirty ? h('span', { style: Object.assign({}, S.countSub, S.pending) }, t('unsaved')) : null,
			h('button', {
				type: 'button',
				style: Object.assign({}, S.button, S.buttonPrimary),
				disabled: !canSave,
				'aria-disabled': canSave ? undefined : 'true',
				onClick: saveSelection
			}, saving ? t('saving') : t('save'))));

	// ── 自动签到区（CHECKIN.md §5：在「知识库」区块之后）──────────
	const checkinSection = h(SbCheckinSection, {
		t: t,
		state: checkinState,
		timeDraft: checkinTimeDraft,
		timeInvalid: checkinTimeInvalid,
		running: checkinRunning,
		saving: checkinSaving,
		notice: checkinNotice,
		onToggle: toggleCheckin,
		onTimeChange: (value) => {
			setCheckinTimeDraft(value);
			if (checkinTimeInvalid) setCheckinTimeInvalid(false);
		},
		onTimeCommit: commitCheckinTime,
		onRun: runCheckin,
		onRefresh: refresh
	});

	return h('div', {
		style: variant === 'settings' ? { minWidth: 0 } : scrollStyle,
		'data-ima-scroll': variant
	},
		h('div', {
			style: innerStyle,
			'data-ima-panel': variant,
			'aria-busy': list.phase === 'loading' || verifying || saving || limitSaving || checkinRunning
		}, header, authSection, limitSection, kbSection, checkinSection));
}

/**
 * 插件设置页卡片（v1 入口兼容）。
 *
 * 只是 `ImaPanel` 的紧凑薄包装：同一套数据流、同一套文案，避免两条路径漂移。
 * 由 90-tail 注册到 `plugins.bundle.config`（`key` 必须等于 npm 包名）。
 * @param {{t?:Function}} props - slot 框架注入的 t。
 * @returns {object} React 元素。
 */
function ImaSettingsCard(props) {
	return h(ImaPanel, { t: props.t, variant: 'settings' });
}

// ══════════════════════════════════════════════════════════════════
// 注册
// ══════════════════════════════════════════════════════════════════

/**
 * 注册侧边栏图标与整页面板。
 *
 * 只做注册，不渲染任何东西；任何一个 inject 抛错都不影响另一个（各自 try/catch）。
 * @param {object} ctx - cordis 上下文（提供 slots）。
 * @param {object} env - 10-core 注入的共享环境。
 * @returns {void}
 */
function registerSidebarPanel(ctx, env) {
	const t = typeof env.t === 'function' ? env.t : fallbackTranslate;

	try {
		// `order: 30` > XD Pool 的 20 → 排在它下方（PLATFORM §4）。
		ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
			name: 'sidebar.panellist',
			id: 'ima-knowledge',
			order: 30,
			label: () => t('navLabel')
		}, SbIcon));
	} catch (error) {
		console.error('[dsh-ima-ragplugin] sidebar.panellist unavailable:', error);
	}

	try {
		// `main` 是 keyed slot：点侧边栏图标 → selectPanel('ima-knowledge') → 渲染这里。
		ctx.slots.inject('main', () => ctx.slots.register({
			name: 'main',
			key: 'ima-knowledge',
			inject: () => ({ t: t })
		}, ImaPanel));
	} catch (error) {
		console.error('[dsh-ima-ragplugin] main panel unavailable:', error);
	}
}

// ═══ fragment: lib/client/30-picker.js ═══
/**
 * 浏览器侧 · 片段 30 —— 「+」菜单入口与知识库多选模态（席位 client-picker 交付）。
 *
 * 注册两处：
 *  - `/` 命令菜单（= 输入框左下角「+」打开的那个菜单）里新增一行 `ima`；
 *  - `conversation.input.overlay`（`kind:'list'`, `scope:'session'`）里的自绘多选模态。
 *
 * 硬约束（本文件是片段，会被拼进 lib/client.js 的 factory 函数体内）：
 *  - 不写 import/export、不写顶层 'use strict'、不写 JSX、不 require 任何
 *    Harness Client 包（官方守则：插件不得依赖，随时会改）。
 *  - 只用 `h`（React.createElement）与 10-core 提供的 S / postJson / ROUTES /
 *    failureOf / failureText / fallbackTranslate 等闭包能力。
 *  - 顶层 `pk*` 全是**纯函数**（无闭包依赖），因此可以脱离浏览器在 Node 里单测，
 *    见 `tests/picker.test.js`。
 *
 * 数据全部走宿主 HTTP 路由（PLATFORM §2 + §9.5，**按会话**）：
 *  - `ROUTES.list`   `{sessionId}`      → `{knowledgeBases, selected, status:{configured,tokenValid,error?}}`
 *  - `ROUTES.select` `{sessionId, ids}` → `{selected}`
 *  有 `sessionId` 时会话级写/读；缺省时退化为全局默认值（兼容旧宿主）。
 *
 * @module ima-knowledge/client/picker
 */

// ══════════════════════════════════════════════════════════════════
// 纯逻辑（Node 可测；不得引用闭包里的任何东西）
// ══════════════════════════════════════════════════════════════════

/**
 * 把任意值收成普通对象；null / 数组 / 标量一律视为空对象。
 * @param {unknown} value - 任意值。
 * @returns {object} 普通对象。
 */
function pkRecord(value) {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
	return value;
}

/**
 * 从 `/list` 的 value 里取出规范化的知识库列表（去重、剔除无 id 项）。
 *
 * 宿主保证 `{id, name}`，并可选给 `group: 'personal'|'joined'`（归属）。
 * 这里**原样带下去**，由 {@link pkGroups} 解释——本层不做任何猜测、不丢字段。
 * @param {unknown} value - `/list` 的 value（也接受裸数组）。
 * @returns {Array<{id:string,name:string,group?:string}>} 知识库列表。
 */
function pkBases(value) {
	const record = pkRecord(value);
	const raw = Array.isArray(record.knowledgeBases) ? record.knowledgeBases : (Array.isArray(value) ? value : []);
	const out = [];
	const seen = new Set();
	for (const entry of raw) {
		const item = pkRecord(entry);
		if (typeof item.id !== 'string' || item.id.trim() === '') continue;
		if (seen.has(item.id)) continue;
		seen.add(item.id);
		const base = {
			id: item.id,
			name: typeof item.name === 'string' && item.name.trim() !== '' ? item.name : item.id
		};
		if (typeof item.group === 'string' && item.group.trim() !== '') base.group = item.group.trim();
		out.push(base);
	}
	return out;
}

/**
 * 从 `/list` 或 `/select` 的 value 里取出已选 id（去重、保序、剔除空串）。
 * @param {unknown} value - 含 `selected` 字段的 value。
 * @returns {string[]} id 列表。
 */
function pkSelectedIds(value) {
	const record = pkRecord(value);
	const raw = Array.isArray(record.selected) ? record.selected : [];
	const out = [];
	const seen = new Set();
	for (const id of raw) {
		if (typeof id !== 'string' || id.trim() === '') continue;
		if (seen.has(id)) continue;
		seen.add(id);
		out.push(id);
	}
	return out;
}

/**
 * 把 `/list` 的 value 一次拆成模态需要的四个面（列表 / 已选 / 是否已配置 / 状态错误）。
 *
 * `configured` 只在宿主**明确**给出 `false` 时才为假：字段缺失（老宿主、mock）
 * 一律按「已配置」处理，避免把「拿不到状态」误报成「没登录」。
 * @param {unknown} value - `/list` 的 value。
 * @returns {{bases:Array, selected:string[], configured:boolean, tokenValid:boolean, statusError:(string|undefined)}} 拆解结果。
 */
function pkDraftFrom(value) {
	const record = pkRecord(value);
	const status = pkRecord(record.status);
	return {
		bases: pkBases(record),
		selected: pkSelectedIds(record),
		configured: status.configured !== false,
		tokenValid: status.tokenValid === true,
		statusError: typeof status.error === 'string' && status.error.trim() !== '' ? status.error.trim() : undefined
	};
}

/**
 * 按名称或 ID 做大小写无关的模糊筛选。
 * @param {Array<{id:string,name:string}>} bases - 知识库列表。
 * @param {string} query - 搜索词；空白表示不过滤。
 * @returns {Array<{id:string,name:string}>} 过滤后的**新**数组。
 */
function pkFilterBases(bases, query) {
	const list = Array.isArray(bases) ? bases : [];
	const needle = typeof query === 'string' ? query.trim().toLocaleLowerCase() : '';
	if (needle === '') return list.slice();
	return list.filter((item) => {
		const entry = pkRecord(item);
		const name = typeof entry.name === 'string' ? entry.name.toLocaleLowerCase() : '';
		const id = typeof entry.id === 'string' ? entry.id.toLocaleLowerCase() : '';
		return name.indexOf(needle) !== -1 || id.indexOf(needle) !== -1;
	});
}

/**
 * 勾选/取消一个 id（保持其余项顺序）。
 * @param {string[]} ids - 当前选择。
 * @param {string} id - 要切换的 id。
 * @returns {string[]} 新数组（空 id 原样复制，不抛错）。
 */
function pkToggleId(ids, id) {
	const list = Array.isArray(ids) ? ids.slice() : [];
	if (typeof id !== 'string' || id === '') return list;
	return list.indexOf(id) === -1
		? list.concat([id])
		: list.filter((entry) => entry !== id);
}

/**
 * 把一批 id 并进当前选择（并集、保序、去重）。
 *
 * 用于「重新拉列表时不丢用户已经点过的勾」：刷新只并集，不覆盖。
 * @param {string[]} current - 当前草稿选择。
 * @param {string[]} ids - 要并入的 id。
 * @returns {string[]} 新数组。
 */
function pkMergeSelected(current, ids) {
	const out = Array.isArray(current) ? current.slice() : [];
	const seen = new Set(out);
	for (const id of Array.isArray(ids) ? ids : []) {
		if (typeof id !== 'string' || id === '' || seen.has(id)) continue;
		seen.add(id);
		out.push(id);
	}
	return out;
}

/**
 * 草稿 vs 最近一次宿主返回的选择是否有差异（脏检查）。
 * @param {string[]} draft - 草稿选择。
 * @param {string[]} saved - 最近一次宿主持久化的选择。
 * @returns {boolean} 是否有改动。
 */
function pkDirty(draft, saved) {
	const next = Array.isArray(draft) ? draft : [];
	const prev = Array.isArray(saved) ? saved : [];
	if (next.length !== prev.length) return true;
	const prevSet = new Set(prev);
	for (const id of next) {
		if (!prevSet.has(id)) return true;
	}
	return false;
}

/**
 * 宿主 `/list` 的归属字段 → 两个固定分组（对齐截图「个人知识库 / 我加入的」）。
 *
 * 契约（PLATFORM 冻结 + host-auth 在 `/list` 每项上补的可选字段）：
 *  - `group === 'joined'` → 「我加入的」；
 *  - 其它一切（`'personal'`、缺字段、未知值）→ 「个人知识库」。
 *
 * 两条设计取舍：
 *  1. **顺序固定**（个人在前、我加入的在后），不按首次出现排——否则宿主换个
 *     返回顺序，截图里的版式就会上下颠倒。
 *  2. **空组整组不渲染**：只返回有内容的组，调用方不必再判空。
 *
 * 不做字符串猜测：只认契约里的 `'joined'`，不再把宿主的任意文本当标题渲染。
 * @param {Array<{id:string,name:string,group?:string}>} bases - 知识库列表。
 * @param {string} query - 搜索词（先过滤再分组）。
 * @param {object} [options] - `{groupField?}`，默认字段名 `group`。
 * @returns {Array<{key:string, titleKey:string, items:Array}>} 非空分组，固定顺序。
 */
function pkGroups(bases, query, options) {
	const config = pkRecord(options);
	const field = typeof config.groupField === 'string' && config.groupField !== '' ? config.groupField : 'group';
	const visible = pkFilterBases(bases, query);
	const personal = [];
	const joined = [];
	for (const item of visible) {
		const entry = pkRecord(item);
		const raw = typeof entry[field] === 'string' ? entry[field].trim() : '';
		if (raw === 'joined') joined.push(item);
		else personal.push(item);
	}
	const groups = [];
	if (personal.length > 0) groups.push({ key: 'group:personal', titleKey: 'pk.groupPersonal', items: personal });
	if (joined.length > 0) groups.push({ key: 'group:joined', titleKey: 'pk.groupJoined', items: joined });
	return groups;
}

/**
 * 列表区的最终态（三态 + 两种空态 + 正常）。
 *
 * 未配置凭据必须**先于**空列表判断：否则「没登录」会被误显示成「没有知识库」。
 * @param {{phase?:string, configured?:boolean, total?:number, visible?:number}} input - 组装好的计数。
 * @returns {'loading'|'error'|'unconfigured'|'empty'|'emptyFiltered'|'ready'} 视图态。
 */
function pkViewState(input) {
	const value = pkRecord(input);
	if (value.phase === 'loading') return 'loading';
	if (value.phase === 'error') return 'error';
	if (value.configured === false) return 'unconfigured';
	const total = typeof value.total === 'number' ? value.total : 0;
	if (total === 0) return 'empty';
	const visible = typeof value.visible === 'number' ? value.visible : 0;
	if (visible === 0) return 'emptyFiltered';
	return 'ready';
}

/**
 * 「确定」是否可点：必须有选中项，且不在保存中。
 * @param {string[]} draft - 草稿选择。
 * @param {boolean} saving - 是否正在保存。
 * @returns {boolean} 可点。
 */
function pkCanConfirm(draft, saving) {
	const list = Array.isArray(draft) ? draft : [];
	return list.length > 0 && saving !== true;
}

// ══════════════════════════════════════════════════════════════════
// 模态开关总线
// ══════════════════════════════════════════════════════════════════

/**
 * 「+」菜单的动作跑在命令服务里，模态组件挂在 slot 里，两者不共享 React 树，
 * 所以需要一个极小的可订阅开关把它们连起来。
 * @returns {{getSnapshot:Function, subscribe:Function, open:Function, close:Function, clearToast:Function}} 总线。
 */
function createPickerBus() {
	let state = { open: false, sessionId: undefined, toast: null };
	const listeners = new Set();
	const emit = () => {
		for (const listener of [...listeners]) {
			try {
				listener();
			} catch (error) {
				console.error('[dsh-ima-ragplugin] picker listener failed:', error);
			}
		}
	};
	return {
		getSnapshot: () => state,
		subscribe: (listener) => {
			listeners.add(listener);
			return () => { listeners.delete(listener); };
		},
		/**
		 * 打开模态。`sessionId` 只用于「哪个会话开的面板」，不做鉴权。
		 * @param {unknown} sessionId - 打开方会话 id。
		 * @returns {void}
		 */
		open: (sessionId) => {
			state = { open: true, sessionId: sessionId, toast: null };
			emit();
		},
		/**
		 * 关闭模态；可顺带留下一条 toast（「确定」成功后需要可见反馈）。
		 * @param {{tone:'ok'|'error', text:string}} [toast] - 关闭后显示的提示。
		 * @returns {void}
		 */
		close: (toast) => {
			state = { open: false, sessionId: undefined, toast: toast === undefined ? state.toast : toast };
			emit();
		},
		/** 清掉 toast（定时器到点）。 */
		clearToast: () => {
			if (state.toast === null) return;
			state = { open: state.open, sessionId: state.sessionId, toast: null };
			emit();
		}
	};
}

/** 插件内唯一一条总线（同一时刻只可能有一个会话在开模态）。 */
let pkBus = null;

/**
 * 取（必要时创建）共享总线。
 * @returns {object} 总线。
 */
function pickerShared() {
	if (pkBus === null) pkBus = createPickerBus();
	return pkBus;
}

/** 同一会话可能重复挂载 overlay，行 id 必须互不冲突。 */
let pkScopeSeed = 0;

// ══════════════════════════════════════════════════════════════════
// 图标
// ══════════════════════════════════════════════════════════════════

/**
 * 「+」菜单行图标：圆角方框 + 两点 + 一条下划线，纯 SVG、`currentColor`。
 * @param {{size?:number}} props - 菜单注入的图标参数。
 * @returns {object} React 元素。
 */
function PickerMenuIcon(props) {
	const size = typeof props.size === 'number' && props.size > 0 ? props.size : 16;
	return h('svg', {
		xmlns: 'http://www.w3.org/2000/svg',
		viewBox: '0 0 24 24',
		width: size,
		height: size,
		'aria-hidden': 'true',
		focusable: 'false',
		style: { display: 'block' }
	},
		h('rect', {
			x: 3.4,
			y: 3.4,
			width: 17.2,
			height: 17.2,
			rx: 4.6,
			fill: 'none',
			stroke: 'currentColor',
			strokeWidth: 1.6
		}),
		h('circle', { cx: 9, cy: 9.6, r: 1.5, fill: 'currentColor' }),
		h('circle', { cx: 15, cy: 9.6, r: 1.5, fill: 'currentColor' }),
		h('path', {
			d: 'M8.2 15.2 h7.6',
			fill: 'none',
			stroke: 'currentColor',
			strokeWidth: 1.6,
			strokeLinecap: 'round'
		}));
}

/**
 * 列表行的文件夹图标（截图里每行名字前那个）。
 * @returns {object} React 元素。
 */
function PickerFolderIcon() {
	return h('svg', {
		xmlns: 'http://www.w3.org/2000/svg',
		viewBox: '0 0 24 24',
		width: 16,
		height: 16,
		'aria-hidden': 'true',
		focusable: 'false',
		style: { flex: 'none', display: 'block', color: 'var(--dsw-alias-label-secondary)' }
	},
		h('path', {
			d: 'M3.4 7.4a2 2 0 0 1 2-2h4.3l2.1 2.4h6.8a2 2 0 0 1 2 2v7.4a2 2 0 0 1-2 2H5.4a2 2 0 0 1-2-2z',
			fill: 'none',
			stroke: 'currentColor',
			strokeWidth: 1.6,
			strokeLinejoin: 'round'
		}));
}

// ══════════════════════════════════════════════════════════════════
// 子组件
// ══════════════════════════════════════════════════════════════════

/**
 * 单行知识库：复选框 + 文件夹图标 + 名称（整行可点）。
 * @param {object} props - `{t, scope, index, item, checked, disabled, onToggle}`。
 * @returns {object} React 元素。
 */
function PickerRow(props) {
	const domId = props.scope + '-kb-' + props.index;
	const item = props.item;
	return h('label', { style: S.modalRow, htmlFor: domId },
		h('input', {
			id: domId,
			type: 'checkbox',
			style: Object.assign({}, S.checkbox, { margin: 0 }),
			checked: props.checked,
			disabled: props.disabled,
			onChange: () => { props.onToggle(item.id); }
		}),
		h(PickerFolderIcon, null),
		h('span', { style: S.modalRowName, title: item.id }, item.name));
}

/**
 * 一个分组：小标题 + 若干行。标题要么来自本地化 key，要么是宿主原样给的文本。
 * @param {{t:Function, scope:string, group:object, draftSet:Set<string>, disabled:boolean, onToggle:Function, offset:number}} props - 组件参数。
 * @returns {object} React 元素。
 */
function PickerGroup(props) {
	const group = props.group;
	// 契约里 titleKey 恒存在；`title` 兜底是为了将来宿主自带本地化标题时不必改这里。
	const title = group.titleKey === undefined ? group.title : props.t(group.titleKey);
	return h('div', { style: S.modalGroup, 'data-ima-group': group.key },
		h('h3', { style: S.modalGroupTitle }, title),
		...group.items.map((item, index) => h(PickerRow, {
			key: item.id,
			t: props.t,
			scope: props.scope,
			index: props.offset + index,
			item: item,
			checked: props.draftSet.has(item.id),
			disabled: props.disabled,
			onToggle: props.onToggle
		})));
}

/**
 * 模态主体：文件页签占位 / 加载中 / 加载失败 / 未配置 / 空 / 筛选无结果 / 正常分组列表。
 *
 * 三态都必须有明确文案 + 重试按钮（PLATFORM §6 A10：不崩、不空白）。
 * @param {object} props - `{t, tab, view, groups, scope, draftSet, disabled, errorText, onToggle, onRetry}`。
 * @returns {object} React 元素。
 */
function PickerBody(props) {
	const t = props.t;
	const retryButton = () => h('button', {
		type: 'button',
		style: S.button,
		onClick: props.onRetry
	}, t('retry'));

	if (props.tab === 'file') {
		return h('div', { style: S.modalBody, 'data-ima-picker': 'file' },
			h('p', { style: S.placeholder }, t('pk.fileComingSoon')));
	}
	if (props.view === 'loading') {
		return h('div', { style: S.modalBody },
			h('p', { style: S.placeholder, 'aria-busy': 'true' }, t('pk.loading')));
	}
	if (props.view === 'error') {
		return h('div', { style: S.modalBody },
			h('div', { style: Object.assign({}, S.placeholder, { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px' }) },
				h('p', { role: 'alert', style: Object.assign({}, S.hint, { margin: 0 }) },
					t('pk.loadFailed', { msg: props.errorText })),
				retryButton()));
	}
	if (props.view === 'unconfigured') {
		// 宿主若同时给了 status.error（例如 token 过期），一并回显——错误不得静默。
		const hostError = typeof props.errorText === 'string' && props.errorText.trim() !== '' ? props.errorText.trim() : undefined;
		const children = [
			h('p', { key: 'title', style: Object.assign({}, S.hint, { margin: 0 }) }, t('statusUnconfigured')),
			h('p', { key: 'hint', style: Object.assign({}, S.hint, { margin: 0 }) }, t('statusUnconfiguredHint'))
		];
		if (hostError !== undefined) {
			children.push(h('p', { key: 'error', role: 'alert', style: Object.assign({}, S.hint, { margin: 0 }) }, hostError));
		}
		children.push(retryButton());
		return h('div', { style: S.modalBody },
			h('div', { style: Object.assign({}, S.placeholder, { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px' }) },
				...children));
	}
	if (props.view === 'empty') {
		return h('div', { style: S.modalBody },
			h('div', { style: Object.assign({}, S.placeholder, { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px' }) },
				h('p', { style: Object.assign({}, S.hint, { margin: 0 }) }, t('pk.empty')),
				retryButton()));
	}
	if (props.view === 'emptyFiltered') {
		return h('div', { style: S.modalBody },
			h('p', { style: S.placeholder }, t('pk.emptyFiltered')));
	}
	let offset = 0;
	const groups = props.groups.map((group) => {
		const node = h(PickerGroup, {
			key: group.key,
			t: t,
			scope: props.scope,
			group: group,
			offset: offset,
			draftSet: props.draftSet,
			disabled: props.disabled,
			onToggle: props.onToggle
		});
		offset += group.items.length;
		return node;
	});
	return h('div', { style: S.modalBody, 'data-ima-picker': 'kb' }, ...groups);
}

/**
 * 工具栏：左侧两页签（知识库 / 文件）+ 右侧搜索框。
 *
 * 「选择文件」页签**必须可点**（切换后是占位空态），所以它是真按钮，不是死标签。
 * @param {object} props - `{t, tab, query, disabled, onTab, onQuery}`。
 * @returns {object} React 元素。
 */
function PickerToolbar(props) {
	const t = props.t;
	const tabButton = (value, label) => h('button', {
		key: value,
		type: 'button',
		style: value === props.tab ? Object.assign({}, S.tab, S.tabActive) : S.tab,
		'aria-selected': value === props.tab ? 'true' : 'false',
		role: 'tab',
		onClick: () => { props.onTab(value); }
	}, label);
	return h('div', { style: S.modalToolbar },
		h('div', { style: S.tabGroup, role: 'tablist' },
			tabButton('kb', t('pk.tabKb')),
			tabButton('file', t('pk.tabFile'))),
		h('input', {
			type: 'search',
			value: props.query,
			disabled: props.disabled === true,
			placeholder: t('pk.searchPlaceholder'),
			'aria-label': t('pk.searchPlaceholder'),
			style: S.modalSearch,
			onChange: (event) => { props.onQuery(event.currentTarget.value); }
		}));
}

/**
 * 底栏：左「已选择 N 项」，右「取消」+「确定」（N=0 或保存中置灰）。
 * @param {{t:Function, count:number, saving:boolean, onCancel:Function, onConfirm:Function}} props - 组件参数。
 * @returns {object} React 元素。
 */
function PickerFooter(props) {
	const t = props.t;
	// 与 {@link pkCanConfirm} 同一条判据：有选中项且不在保存中。
	const canConfirm = props.count > 0 && props.saving !== true;
	return h('div', { style: S.modalFooter },
		h('span', { style: S.countMain }, t('pk.selectedCount', { n: props.count })),
		h('div', { style: S.modalActions },
			h('button', { type: 'button', style: S.button, onClick: props.onCancel }, t('pk.cancel')),
			h('button', {
				type: 'button',
				style: canConfirm ? S.buttonSolid : Object.assign({}, S.buttonSolid, S.buttonDisabled),
				disabled: !canConfirm,
				'aria-disabled': canConfirm ? undefined : 'true',
				onClick: props.onConfirm
			}, t('pk.confirm'))));
}

/**
 * 模态本体：数据加载 + 页签/搜索/勾选状态 + 取消/确定。
 * @param {{t?:Function, bus:object, sessionId?:string}} props - 组件参数。
 * @returns {object} React 元素。
 */
function PickerModal(props) {
	const t = typeof props.t === 'function' ? props.t : fallbackTranslate;
	const bus = props.bus;
	// 当前会话（PLATFORM §9.5）：有它 → 读/写会话级选中集；没有 → 退化全局默认值。
	const sessionId = typeof props.sessionId === 'string' && props.sessionId.trim() !== ''
		? props.sessionId.trim()
		: undefined;

	const [scope] = React.useState(() => { pkScopeSeed += 1; return 'ima-pk-' + pkScopeSeed; });
	const [tab, setTab] = React.useState('kb');
	const [query, setQuery] = React.useState('');
	const [list, setList] = React.useState({ phase: 'loading' });
	const [draft, setDraft] = React.useState([]);
	const [saved, setSaved] = React.useState([]);
	const [saving, setSaving] = React.useState(false);
	const [notice, setNotice] = React.useState(null);
	const [request, setRequest] = React.useState(0);

	const cancel = React.useCallback(() => { bus.close(); }, [bus]);
	const retry = React.useCallback(() => { setRequest((value) => value + 1); }, []);

	// 打开即拉 `/list`（带本会话 id）；`request` 自增 = 重试。
	React.useEffect(() => {
		let live = true;
		setList({ phase: 'loading' });
		// 会话变了 → 旧草稿立刻作废，避免把上一个会话的勾选带进来。
		setDraft([]);
		setSaved([]);
		postJson(ROUTES.list, sessionId === undefined ? {} : { sessionId: sessionId }).then((value) => {
			if (!live) return;
			const next = pkDraftFrom(value);
			setList({
				phase: 'ready',
				bases: next.bases,
				configured: next.configured,
				statusError: next.statusError
			});
			// 重试时用户可能已经点过勾：有改动就并集，别把他的勾冲掉。
			setDraft((current) => (pkDirty(current, saved) ? pkMergeSelected(current, next.selected) : next.selected));
			setSaved(next.selected);
		}, (cause) => {
			if (!live) return;
			setList({ phase: 'error', failure: failureOf(cause) });
		});
		return () => { live = false; };
	}, [request, sessionId]);

	// Esc 关闭（捕获阶段：先于输入框自己的按键处理）。
	// `document` 判空：片段在 Node 单测里也会被执行，不能假定浏览器环境。
	React.useEffect(() => {
		if (typeof document === 'undefined') return undefined;
		const onKeyDown = (event) => {
			if (event.key !== 'Escape') return;
			event.stopPropagation();
			cancel();
		};
		document.addEventListener('keydown', onKeyDown, true);
		return () => { document.removeEventListener('keydown', onKeyDown, true); };
	}, [cancel]);

	const toggle = React.useCallback((id) => {
		setDraft((current) => pkToggleId(current, id));
	}, []);

	const confirm = React.useCallback(async () => {
		if (!pkCanConfirm(draft, saving)) return;
		setSaving(true);
		setNotice(null);
		try {
			const value = pkRecord(await postJson(
				ROUTES.select,
				sessionId === undefined ? { ids: draft } : { sessionId: sessionId, ids: draft }
			));
			const next = pkSelectedIds(value);
			const applied = next.length === 0 ? draft.slice() : next;
			// 通知 chip 栏立即刷新（`40-chips.js` 监听此事件）。
			// 不派发的话 chip 栏只能等 3s 轮询兜底，用户会看到「选完了但 chip 迟迟不变」。
			// **必须带 sessionId**（PLATFORM §9.6）：chip 栏只响应自己会话的事件，
			// 不带会话的旧事件正是「一个会话选完所有会话都变」的缺陷成因。
			// 派发失败不能影响确定流程：这是纯信号，事件没人听也无害。
			try {
				window.dispatchEvent(new CustomEvent('ima-kb-selection-changed', {
					detail: { sessionId: sessionId === undefined ? null : sessionId, selected: applied }
				}));
			} catch (signalError) {
				console.warn('[dsh-ima-ragplugin] selection signal failed:', signalError);
			}
			bus.close({ tone: 'ok', text: t('pk.saved', { n: applied.length }) });
		} catch (cause) {
			// 失败：模态**不关**，原文回显在底栏上方。
			setNotice({
				tone: 'error',
				text: t('pk.saveFailed', { msg: failureText(t, failureOf(cause)) })
			});
			setSaving(false);
		}
	}, [draft, saving, t, bus, sessionId]);

	const bases = list.phase === 'ready' ? list.bases : [];
	const visible = pkFilterBases(bases, query);
	const view = pkViewState({
		phase: list.phase,
		configured: list.configured,
		total: bases.length,
		visible: visible.length
	});
	const groups = pkGroups(bases, query);
	const draftSet = React.useMemo(() => new Set(draft), [draft]);
	const busy = saving === true;

	return h('div', {
		style: S.modalMask,
		role: 'presentation',
		onClick: cancel
	},
		h('div', {
			style: S.modalCard,
			role: 'dialog',
			'aria-modal': 'true',
			'aria-label': t('pk.modalTitle'),
			'data-ima-picker': 'modal',
			onClick: (event) => { event.stopPropagation(); }
		},
			h('div', { style: S.modalHeader },
				h('h2', { style: S.modalTitle }, t('pk.modalTitle')),
				h('button', {
					type: 'button',
					style: S.modalClose,
					'aria-label': t('pk.close'),
					onClick: cancel
				}, '×')),
			h(PickerToolbar, {
				t: t,
				tab: tab,
				query: query,
				disabled: tab !== 'kb' || busy,
				onTab: setTab,
				onQuery: setQuery
			}),
			h(PickerBody, {
				t: t,
				tab: tab,
				view: view,
				groups: groups,
				scope: scope,
				draftSet: draftSet,
				disabled: busy,
				errorText: list.phase === 'error' ? failureText(t, list.failure) : (list.statusError === undefined ? '' : list.statusError),
				onToggle: toggle,
				onRetry: retry
			}),
			notice === null
				? null
				: h('p', {
					role: 'alert',
					style: Object.assign({}, S.notice, S.noticeError, { margin: '0 20px 10px' })
				}, notice.text),
			h(PickerFooter, {
				t: t,
				count: draft.length,
				saving: busy,
				onCancel: cancel,
				onConfirm: confirm
			})));
}

/**
 * 关闭后的可见反馈（「确定」成功要看得见结果，而模态已经关掉了）。
 * @param {{notice:{tone:string,text:string}|null}} props - 组件参数。
 * @returns {object|null} React 元素或 null。
 */
function PickerToast(props) {
	const notice = props.notice;
	if (notice === null || notice === undefined) return null;
	return h('div', {
		style: {
			position: 'fixed',
			left: 0,
			right: 0,
			bottom: '32px',
			display: 'flex',
			justifyContent: 'center',
			zIndex: 2147483002,
			pointerEvents: 'none'
		}
	},
		h('span', {
			role: 'status',
			style: Object.assign(
				{},
				S.notice,
				notice.tone === 'error' ? S.noticeError : S.noticeOk,
				{ pointerEvents: 'auto', padding: '8px 14px', boxShadow: '0 8px 24px rgba(0, 0, 0, 0.18)' }
			)
		}, notice.text));
}

/**
 * `conversation.input.overlay` 里的挂载点：订阅总线，开的时候渲染模态，顺带渲染 toast。
 *
 * 该 slot 是 `position:absolute; inset:0 0 auto; height:0` 的锚点，所以模态自己
 * 用 `S.modalMask` 的 `position:fixed` 定位（与 dsh-context 的 `context-modal` 同法）。
 * @param {{picker?:object, pickerT?:Function, pickerSessionId?:string}} props - 注册时注入的面。
 * @returns {object} React 元素。
 */
function PickerOverlay(props) {
	const bus = props.picker === undefined || props.picker === null ? pickerShared() : props.picker;
	const t = typeof props.pickerT === 'function' ? props.pickerT : fallbackTranslate;
	const [snapshot, setSnapshot] = React.useState(bus.getSnapshot());

	React.useEffect(() => bus.subscribe(() => { setSnapshot(bus.getSnapshot()); }), [bus]);

	const toast = snapshot.toast;
	React.useEffect(() => {
		if (toast === null || toast === undefined) return undefined;
		const timer = setTimeout(() => { bus.clearToast(); }, 4000);
		return () => { clearTimeout(timer); };
	}, [toast, bus]);

	// 会话作用域 slot：只有开它的那个会话的实例渲染模态（拿不到 sessionId 时不设限）。
	const sameSession = snapshot.sessionId === undefined
		|| props.pickerSessionId === undefined
		|| snapshot.sessionId === props.pickerSessionId;
	// `sessionId` 优先用总线里「谁开的模态」，它才是这次交互真正作用的会话；
	// 总线没记（命令入口没带 session）时退回本实例的会话 id。
	const targetSession = snapshot.sessionId === undefined ? props.pickerSessionId : snapshot.sessionId;
	const modal = snapshot.open === true && sameSession
		? h(PickerModal, { t: t, bus: bus, sessionId: targetSession })
		: null;

	return h(React.Fragment, null, modal, h(PickerToast, { notice: toast }));
}

// ══════════════════════════════════════════════════════════════════
// 注册
// ══════════════════════════════════════════════════════════════════

/**
 * 注册「+」菜单里的 ima 行与知识库多选模态。
 *
 * 只做注册，不渲染任何东西；两处注册各自 try/catch，任一失败不影响另一处
 * （90-tail 已经包了一层，这里再包一层是为了「菜单没了但模态还在」这种半可用状态）。
 * @param {object} ctx - cordis 上下文（提供 slots / inject）。
 * @param {object} env - 10-core 注入的共享环境。
 * @returns {void}
 */
function registerPicker(ctx, env) {
	const t = typeof env.t === 'function' ? env.t : fallbackTranslate;
	const bus = pickerShared();

	try {
		// `kind:'list'`, `scope:'session'`：list 槽必须给唯一 id，session 槽的 inject 收到 sessionId。
		ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
			name: 'conversation.input.overlay',
			id: 'ima-picker',
			order: 20,
			inject: (sessionId) => ({ picker: bus, pickerT: t, pickerSessionId: sessionId })
		}, PickerOverlay));
	} catch (error) {
		console.error('[dsh-ima-ragplugin] conversation.input.overlay unavailable:', error);
	}

	try {
		// 命令贡献：进 `/` 源（= 「+」打开的那个菜单）。`kind:'action'` 表示
		// 「吃掉触发词 + 跑一个客户端回调」，不弹官方 popupSelect（那个壳是单选，见 spike Q1）。
		ctx.inject(['commandUi'], (scope) => {
			scope.effect(() => {
				const dispose = scope.commandUi.register({
					name: 'ima',
					label: () => t('pk.label'),
					description: () => t('pk.description'),
					icon: PickerMenuIcon,
					available: () => true,
					ui: {
						kind: 'action',
						run: (session) => {
							bus.open(session === null || session === undefined ? undefined : session.sessionId);
						}
					}
				});
				return () => { dispose(); };
			}, 'ima-knowledge: /ima contribution');
		});
	} catch (error) {
		console.error('[dsh-ima-ragplugin] commandUi unavailable:', error);
	}
}

// ═══ fragment: lib/client/40-chips.js ═══
/**
 * 浏览器侧 · 片段 40 —— 输入框**里面**的知识库 chip 栏（席位 client-kb-chips 交付）。
 *
 * 需求（用户原话，三轮）：
 *   「聊天框里选择知识库后应当在聊天框里显示对应知识库，类似图片」
 *   「chip 应该像选择 skill 和引用文件一样，显示在输入框里，而不是输入框上方」
 *   「选择 ima 的知识库的气泡不是显示在界面右下角，而是像引用文件或者选择技能后
 *     展示在聊天框里」
 * —— 即「+」菜单里选完知识库后，chip 要出现在**输入框卡片里面、文字上方**、可点 × 移除。
 *
 * 注册位置：`conversation.input.overlay`（`{ kind:'list'; scope:'session' }`）
 *   —— 该槽的挂载点 `input.overlayAnchor` 就在**输入框卡片内部**
 *   （`skeleton/InputBar.tsx`：`<div className={css.overlayAnchor} data-composer-overlay>`），
 *   但它是 `position:absolute; inset:0 0 auto; height:0` 的零高锚点，直接渲染会**盖住**
 *   编辑区第一行文字。
 *
 * 因此本片段用「卡片内 portal」：
 *   1. 组件在 overlay 锚点里只渲染一个隐藏的定位锚（`display:none`）；
 *   2. `useLayoutEffect` 里从锚点 `closest('[data-composer-card]')` 找到输入框卡片
 *      （`data-composer-card` 是 DSH 对第三方插件承诺的稳定钩子，见 `dsh-pocket` 同法）；
 *   3. 在卡片**第一个子节点**位置插一个容器，把 chip 栏 portal 进去。
 *   卡片是 `display:flex; flex-direction:column; gap:12px`，所以 chip 栏自然排在
 *   编辑区上方、把文字往下推 —— 视觉上就是「输入框里、文字上方」，和附件行同层。
 *
 * ⚠ 为什么不用别的槽：
 *   - `conversation.input.attachments`（附件行，位置最理想）是 `single` 槽且已被
 *     `dsh-client-ui-attachment` 占用；插件再注册会**顶掉**附件 UI（`shadows-shipped-ui`）。
 *   - 编辑器内部的 skill / 文件引用 chip 是 Lexical 装饰节点，没有插件 API。
 *   - `conversation.input.left`（旧位置）= 卡片底部工具行、`+` 右边，用户明确否掉。
 *   - `conversation.input.dock` = 卡片**上方**，用户第一轮就否掉。
 *
 * 降级：找不到卡片（DSH 改了 DOM）→ chip 栏渲染在隐藏容器里并 `console.warn` 一次，
 * 绝不覆盖编辑区、也绝不抛错影响会话输入。
 *
 * 数据源：宿主路由（PLATFORM §2.1 + §9.5，**按会话**）
 *   - `ROUTES.list`   `{sessionId}`    → `{knowledgeBases:[{id,name,group?}], selected:string[], status}`
 *   - `ROUTES.select` `{sessionId,ids}` → `{selected}`
 *   `selected` 是**当前会话**的选中集（§9.2/§9.3：会话级存储，缺 `sessionId` 时才退化全局默认值）。
 *   **只渲染 `selected` 里的库**；`selected` 里的 id 在库列表里找不到时**不渲染**
 *   （绝不显示裸 id —— 那是宿主数据不一致，不是可读的知识库名）。
 *
 * ⚠ 为什么不去订阅 picker 总线拿选中集：`30-picker.js` 的 `createPickerBus()` 只管理
 * `{open, sessionId, toast}` 三个字段，**不包含选中集**。选中集的事实源只有宿主路由。
 *
 * 刷新触发（三条都实现了，见 handback）：
 *   (a) **picker 模态关闭**：同一 factory 作用域里的 `pickerShared()` 总线只在
 *       `open` 从 true 变 false 时**当作刷新信号**（不从中读选中集 —— 它本来也没有），
 *       且只在「开模态的会话就是我」时响应，所以「确定」后 chip 立刻更新。
 *   (b) `window` 上的自定义事件 `ima-kb-selection-changed`（跨席位零成本信号；
 *       detail = `{ sessionId, selected }`，**只响应本会话**的事件；侧边栏写全局默认值，
 *       派发时 sessionId 为 `null`，chip 栏不响应）
 *   (c) `document` 的 `visibilitychange` + 低频轮询兜底（默认 3 s，仅在页面可见时；
 *       连续失败退避到 30 s，避免打爆上游 IMA 接口）
 *   (d) **会话切换**：`sessionId` 在 `useEffect` 依赖里；变化即清空旧数据并立即重拉
 *       （这是本席位修复的核心缺陷：旧实现依赖数组为空，chip 会跨会话残留）。
 *
 * 硬约束（本文件是片段，会被拼进 lib/client.js 的 factory 函数体内）：
 *  - 不写 import/export、不写顶层 'use strict'、不写 JSX、不 require 任何 Harness Client 包。
 *  - 只用 `h`（React.createElement）与 10-core 的闭包能力（postJson / ROUTES / failureOf / failureText）。
 *  - 顶层 `kbChip*` 全是**纯函数**（无闭包依赖），可脱离浏览器单测，见 `tests/chips.test.js`。
 *
 * @module ima-knowledge/client/chips
 */

// ══════════════════════════════════════════════════════════════════
// 常量
// ══════════════════════════════════════════════════════════════════

/** 轮询间隔（页面可见时）。低频兜底，主路径是 (a) 的自定义事件。 */
const KB_CHIP_POLL_MS = 3000;
/** 连续失败后的退避间隔：`/list` 每次都会打到上游 IMA，失败时不能继续 3 s 打一次。 */
const KB_CHIP_POLL_BACKOFF_MS = 30000;
/** chip 的 `aria-label` 里名字最多保留多少个码点（视觉仍由 CSS 省略号负责）。 */
const KB_CHIP_ARIA_MAX = 48;
/** 跨席位约定的刷新事件名（picker 的「确定」成功后派发它即可让 chip 立即更新）。 */
const KB_CHIP_EVENT = 'ima-kb-selection-changed';
/** 卡片内 portal 宿主容器的属性名（排障 / 验证台定位用）。 */
const KB_CHIP_HOST_ATTR = 'data-ima-kb-chips-host';
/** DSH 输入框卡片的稳定钩子（第三方插件共用，见 `dsh-pocket`）。 */
const KB_CHIP_CARD_SELECTOR = '[data-composer-card]';

/** 只告警一次：辅助展示区失败不该刷屏。 */
let kbChipWarned = false;
/** 只告警一次：找不到输入框卡片（DSH DOM 变了）时留痕，不静默消失。 */
let kbChipHostWarned = false;

// ══════════════════════════════════════════════════════════════════
// 纯逻辑（Node 可测；不得引用闭包里的任何东西）
// ══════════════════════════════════════════════════════════════════

/**
 * 把任意值收成普通对象；null / 数组 / 标量一律视为空对象。
 * @param {unknown} value - 任意值。
 * @returns {object} 普通对象。
 */
function kbChipRecord(value) {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
	return value;
}

/**
 * 从 `/list` 的 value 里取出规范化的知识库列表（去重、剔除无 id 项、保序）。
 * @param {unknown} value - `/list` 的 value。
 * @returns {Array<{id:string,name:string}>} 知识库列表。
 */
function kbChipBases(value) {
	const record = kbChipRecord(value);
	const raw = Array.isArray(record.knowledgeBases) ? record.knowledgeBases : [];
	const out = [];
	const seen = new Set();
	for (const entry of raw) {
		const item = kbChipRecord(entry);
		if (typeof item.id !== 'string' || item.id.trim() === '') continue;
		if (seen.has(item.id)) continue;
		seen.add(item.id);
		out.push({
			id: item.id,
			name: typeof item.name === 'string' && item.name.trim() !== '' ? item.name : item.id
		});
	}
	return out;
}

/**
 * 从 `/list` 或 `/select` 的 value 里取出已选 id（去重、保序、剔除空串）。
 * @param {unknown} value - 含 `selected` 字段的 value。
 * @returns {string[]} id 列表。
 */
function kbChipSelectedIds(value) {
	const record = kbChipRecord(value);
	const raw = Array.isArray(record.selected) ? record.selected : [];
	const out = [];
	const seen = new Set();
	for (const id of raw) {
		if (typeof id !== 'string' || id.trim() === '') continue;
		if (seen.has(id)) continue;
		seen.add(id);
		out.push(id);
	}
	return out;
}

/**
 * 从数据里读「这份数据属于哪个会话」（PLATFORM §9.5）。
 *
 * 宿主**不要求**在 `/list` 回显 `sessionId`；一旦回显了就说明这份 `selected`
 * 是按会话算出来的，chip 栏据此做一次防串台校验（见 {@link kbChipItems}）。
 * @param {unknown} value - `/list`（或 `/select`）的 value。
 * @returns {string|undefined} 非空 sessionId；没有该字段时 undefined。
 */
function kbChipSessionId(value) {
	const record = kbChipRecord(value);
	const raw = record.sessionId;
	if (typeof raw !== 'string' || raw.trim() === '') return undefined;
	return raw.trim();
}

/**
 * **chip 列表推导**（本席位核心纯函数）。
 *
 * 顺序 = `selected` 的顺序；只保留能在库列表里找到名字的项 —— 找不到就**不产生 chip**，
 * 绝不把裸 id 当名字显示（PLATFORM §2.1 的数据不一致分支）。
 *
 * 会话防串台（PLATFORM §9.2/§9.5）：`value` 里若带 `sessionId`，而调用方声明了
 * 自己属于另一个会话，说明拿到的不是本会话的数据 —— **返回空数组**，宁可整栏不显示，
 * 也绝不把别的会话的库渲染到当前输入框里。
 * @param {unknown} value - `/list` 的 value。
 * @param {string} [sessionId] - 调用方所属会话 id（可选）。
 * @returns {Array<{id:string,name:string}>} chip 项（可能为空数组）。
 */
function kbChipItems(value, sessionId) {
	const owner = kbChipSessionId(value);
	const mine = typeof sessionId === 'string' && sessionId.trim() !== '' ? sessionId.trim() : undefined;
	if (owner !== undefined && mine !== undefined && owner !== mine) return [];
	const byId = new Map();
	for (const base of kbChipBases(value)) byId.set(base.id, base);
	const out = [];
	for (const id of kbChipSelectedIds(value)) {
		const base = byId.get(id);
		if (base === undefined) continue;
		out.push({ id: base.id, name: base.name });
	}
	return out;
}

/**
 * **移除后的新选中集**：删掉指定 id，其余保持原有顺序（不重排、不丢项、不重复）。
 * @param {string[]} selected - 当前选中集。
 * @param {string} id - 要移除的 id。
 * @returns {string[]} 新数组（输入未命中时返回等值副本）。
 */
function kbChipRemove(selected, id) {
	const source = Array.isArray(selected) ? selected : [];
	const out = [];
	const seen = new Set();
	for (const entry of source) {
		if (typeof entry !== 'string' || entry.trim() === '') continue;
		if (entry === id) continue;
		if (seen.has(entry)) continue;
		seen.add(entry);
		out.push(entry);
	}
	return out;
}

/**
 * 名称截断（码点安全，超出加 `…`）。用于 `aria-label` 里嵌入的超长库名，
 * 避免屏幕阅读器念一大段；**视觉上的省略号仍由 CSS `text-overflow` 负责**。
 * @param {unknown} text - 原始名称。
 * @param {number} max - 最大码点数（≤0 表示不截断）。
 * @returns {string} 归一化（去首尾空白、折叠内部空白）后可能被截断的名称。
 */
function kbChipTruncate(text, max) {
	const raw = typeof text === 'string' ? text : (text === null || text === undefined ? '' : String(text));
	const trimmed = raw.trim().replace(/\s+/gu, ' ');
	const limit = typeof max === 'number' && Number.isFinite(max) && max > 0 ? Math.floor(max) : 0;
	if (limit === 0) return trimmed;
	const chars = Array.from(trimmed);
	if (chars.length <= limit) return trimmed;
	return chars.slice(0, limit).join('') + '…';
}

/**
 * `/select` 的返回 → 下一次渲染用的 value。
 *
 * 宿主**总是**回 `{selected}`，但写回失败/旧宿主可能不给该字段：那种情况下沿用
 * 本次乐观写入的 `fallbackSelected`，而不是把用户刚移除的库又变回来。
 * @param {unknown} previousValue - 上一次 `/list` 的 value（保留 knowledgeBases）。
 * @param {string[]} fallbackSelected - 乐观写入的选中集。
 * @param {unknown} value - `/select` 的 value。
 * @returns {object} 新 value。
 */
function kbChipApplyResult(previousValue, fallbackSelected, value) {
	const record = kbChipRecord(value);
	const selected = Array.isArray(record.selected)
		? kbChipSelectedIds(record)
		: kbChipRemove(Array.isArray(fallbackSelected) ? fallbackSelected : [], '');
	return Object.assign({}, kbChipRecord(previousValue), { selected: selected });
}

/**
 * 当前是否该轮询：只在页面可见时拉取（`document.hidden` 时省掉全部请求）。
 * @param {unknown} visibility - `document.visibilityState`。
 * @returns {boolean} 是否轮询。
 */
function kbChipShouldPoll(visibility) {
	return visibility !== 'hidden';
}

/**
 * 下一次轮询的延迟：正常 3 s，连续失败退避到 30 s。
 * @param {number} failures - 连续失败次数。
 * @returns {number} 毫秒。
 */
function kbChipPollDelay(failures) {
	const count = typeof failures === 'number' && Number.isFinite(failures) && failures > 0 ? Math.floor(failures) : 0;
	return count === 0 ? KB_CHIP_POLL_MS : KB_CHIP_POLL_BACKOFF_MS;
}

/**
 * 派发「选中集变了」的跨席位事件。
 *
 * picker 的「确定」成功后调它一次，chip 栏立刻刷新，无需等 3 s 轮询
 * （本片段自己也会监听同一事件，所以重复调用是安全的）。
 *
 * **必须带 sessionId**（PLATFORM §9.6）：选中集是会话级的，不带会话的事件
 * 无法判断该刷哪个会话的 chip 栏 —— 那正是「一个会话选完，所有会话都变」的旧缺陷。
 * 侧边栏写的是**全局默认值**，它派发时 sessionId 用 `null`，chip 栏不响应。
 * @param {string|null} [sessionId] - 事件所属会话；`null` = 非会话级（全局默认值）。
 * @param {string[]} [selected] - 新的选中集（可选，chip 栏以宿主路由为事实源）。
 * @returns {void}
 */
function notifyKbSelectionChanged(sessionId, selected) {
	if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
	const detail = {
		sessionId: typeof sessionId === 'string' && sessionId.trim() !== '' ? sessionId : null,
		selected: Array.isArray(selected) ? selected.slice() : []
	};
	if (typeof CustomEvent === 'function') {
		window.dispatchEvent(new CustomEvent(KB_CHIP_EVENT, { detail: detail }));
		return;
	}
	const event = new Event(KB_CHIP_EVENT);
	event.detail = detail;
	window.dispatchEvent(event);
}

/**
 * 事件 detail → 所属会话（PLATFORM §9.6 的事件协议 `{ sessionId, selected }`）。
 * @param {unknown} detail - 事件 detail。
 * @returns {string|null} 会话 id；`null` 表示「非会话级」（侧边栏写的全局默认值）。
 */
function kbChipEventSessionId(detail) {
	const record = kbChipRecord(detail);
	const raw = record.sessionId;
	if (typeof raw !== 'string' || raw.trim() === '') return null;
	return raw.trim();
}

/**
 * **事件过滤**（本席位核心纯函数）：这条事件该不该刷新「我」这个会话的 chip 栏。
 *
 * - `detail.sessionId` 为空（侧边栏的全局默认值）→ 不刷新；
 * - `detail.sessionId` 与本会话不一致 → 不刷新（别的会话的选择与我无关）；
 * - 一致 → 刷新。
 * @param {unknown} detail - 事件 detail。
 * @param {string} sessionId - 本 chip 栏所属会话。
 * @returns {boolean} 是否刷新。
 */
function kbChipEventMatches(detail, sessionId) {
	const owner = kbChipEventSessionId(detail);
	if (owner === null) return false;
	if (typeof sessionId !== 'string' || sessionId.trim() === '') return false;
	return owner === sessionId.trim();
}

// ══════════════════════════════════════════════════════════════════
// 文案（本席位新增 key 的内嵌兜底）
// ══════════════════════════════════════════════════════════════════

/**
 * 本席位新增的 locale key（中文值即事实源；`en` 供 Lead 并入 10-core，键集必须一致）。
 *
 * 10-core 的 `zh` / `en` 由 Lead 维护，本席位不越界改字典；但 UI 不能因此露出裸 key，
 * 所以带一份内嵌兜底表：`kbChipTranslate()` 先问注入的 `t`，未命中再查本表。
 * Lead 把 key 并入 10-core 后，本表自动退居二线（值一致）。
 *
 * @type {{zh:Record<string,string>, en:Record<string,string>}}
 */
const KB_CHIP_LOCALE = {
	zh: {
		'kb.barLabel': '已接入的知识库',
		'kb.remove': '移除知识库：{name}',
		'kb.removeFailed': '移除失败：{msg}'
	},
	en: {
		'kb.barLabel': 'Attached knowledge bases',
		'kb.remove': 'Remove knowledge base: {name}',
		'kb.removeFailed': 'Remove failed: {msg}'
	}
};

/**
 * 带内嵌兜底的翻译：注入的 `t` 命中就用它（切语言会重渲染），否则查中文兜底表。
 * @param {Function} t - 翻译函数。
 * @param {string} key - key。
 * @param {object} [params] - 插值参数。
 * @returns {string} 文案（保证非空且不是裸 key）。
 */
function kbChipTranslate(t, key, params) {
	if (typeof t === 'function') {
		const text = params === undefined ? t(key) : t(key, params);
		if (typeof text === 'string' && text !== '' && text !== key) return text;
	}
	const table = KB_CHIP_LOCALE.zh;
	const template = table[key] === undefined ? key : table[key];
	if (params === undefined) return template;
	return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
}

// ══════════════════════════════════════════════════════════════════
// 样式（内联，仅用 --dsw-alias-* 主题 token；对齐用户截图）
// ══════════════════════════════════════════════════════════════════

/**
 * 行容器：紧贴文字区上方的一行 chip，放不下才换行。
 *
 * 间距刻意对齐**原生附件行**（`dsh-client-ui-attachment` 的 rail：
 * `padding:2px 10px 0; margin-bottom:-6px`）—— 这样 chip 栏和输入框自带的
 * 附件行同层、左右与文字对齐、贴着文字区，视觉上属于输入框而不是浮在外面。
 */
const KB_CHIP_ROW_STYLE = {
	display: 'flex',
	flexWrap: 'wrap',
	alignItems: 'center',
	gap: '6px',
	padding: '2px 10px 0',
	marginBottom: '-6px',
	minWidth: 0,
	maxWidth: '100%'
};

/**
 * 单个 chip：细描边胶囊（对齐 DSH 原生附件 chip 的语言：`.5px` 描边 + 输入面底色），
 * 比纯灰底更像输入框自己的一部分。
 */
const KB_CHIP_STYLE = {
	display: 'inline-flex',
	alignItems: 'center',
	gap: '5px',
	maxWidth: '100%',
	minWidth: 0,
	boxSizing: 'border-box',
	height: '24px',
	border: '.5px solid var(--dsw-alias-border-l2)',
	borderRadius: '999px',
	padding: '0 6px 0 8px',
	fontSize: '12px',
	lineHeight: '18px',
	background: 'color-mix(in srgb, var(--dsw-alias-label-secondary) 8%, transparent)',
	color: 'var(--dsw-alias-label-primary)'
};

/** 名称：过长省略，宽度上限 200px（对齐截图）。 */
const KB_CHIP_NAME_STYLE = {
	maxWidth: '200px',
	overflow: 'hidden',
	textOverflow: 'ellipsis',
	whiteSpace: 'nowrap'
};

/** 右侧 `×` 移除按钮。 */
const KB_CHIP_CLOSE_STYLE = {
	flex: 'none',
	border: 0,
	background: 'transparent',
	color: 'var(--dsw-alias-label-secondary)',
	font: 'inherit',
	fontSize: '13px',
	lineHeight: '14px',
	cursor: 'pointer',
	borderRadius: '999px',
	padding: '0 2px',
	marginLeft: '1px'
};

/** 移除失败时的短状态文案（可见、不打断输入）。 */
const KB_CHIP_ERROR_STYLE = {
	flex: 'none',
	alignSelf: 'center',
	color: 'var(--dsw-alias-state-error-primary)',
	fontSize: '11.5px',
	lineHeight: '18px',
	overflowWrap: 'anywhere'
};

// ══════════════════════════════════════════════════════════════════
// 卡片内挂载点（portal）
// ══════════════════════════════════════════════════════════════════

/**
 * 在输入框卡片内部找一个「chip 栏宿主」容器。
 *
 * 落点：紧贴文字区**上方**、仍在输入框卡片里面（`[data-input-scroll]` 之前，
 * 也就是原生附件行 `conversation.input.attachments` 之后）。卡片是
 * `display:flex; flex-direction:column; gap:12px`，所以容器作为 flex 子节点会
 * 自然把文字往下推 —— 不改卡片样式、不改 padding。
 *
 * 为什么不是卡片第一个子节点：那样 chip 栏会跑到附件行/overlay 锚点之前，
 * 视觉上和文字区隔了一层「空条」，用户反馈「没有和聊天框融为一体」。
 * 贴在文字区正上方（与原生附件行同层）才像输入框自己的一部分。
 *
 * 生命周期：`active` 变 true → 建容器；`active` 变 false / 卸载 → 移除容器。
 * 容器是**外来节点**（React 不认识它），React 只相对自己的节点做 insertBefore，
 * 所以容器位置稳定。
 *
 * @param {boolean} active - 是否需要在卡片里挂 chip 栏。
 * @returns {{anchorRef: object, host: object|null}} 定位锚点的 ref 与宿主容器。
 */
function useKbChipHost(active) {
	const anchorRef = React.useRef(null);
	const [host, setHost] = React.useState(null);

	React.useLayoutEffect(() => {
		if (!active) return undefined;
		const anchor = anchorRef.current;
		if (anchor === null || anchor === undefined || typeof anchor.closest !== 'function') return undefined;
		const card = anchor.closest(KB_CHIP_CARD_SELECTOR);
		if (card === null || card === undefined) {
			if (!kbChipHostWarned) {
				kbChipHostWarned = true;
				console.warn('[dsh-ima-ragplugin] knowledge base chips: composer card not found; chips stay hidden.');
			}
			return undefined;
		}
		// 复用已存在的容器（同一张卡片上重复挂载时不叠容器）。
		let container = typeof card.querySelector === 'function'
			? card.querySelector(':scope > [' + KB_CHIP_HOST_ATTR + ']')
			: null;
		if (container === null || container === undefined) {
			container = document.createElement('div');
			container.setAttribute(KB_CHIP_HOST_ATTR, '');
			container.style.minWidth = '0';
			// 贴在文字区正上方（原生附件行之后）；找不到文字区才退回卡片第一位。
			const textArea = typeof card.querySelector === 'function' ? card.querySelector('[data-input-scroll]') : null;
			if (textArea !== null && textArea !== undefined && textArea.parentNode === card) {
				card.insertBefore(container, textArea);
			} else {
				card.insertBefore(container, card.firstChild);
			}
		}
		setHost(container);
		return () => {
			if (container !== null && container !== undefined && container.parentNode !== null) {
				container.parentNode.removeChild(container);
			}
		};
	}, [active]);

	return { anchorRef: anchorRef, host: host };
}

// ══════════════════════════════════════════════════════════════════
// 组件
// ══════════════════════════════════════════════════════════════════

/**
 * chip 左侧图标：自绘 14px「熊猫头」。
 *
 * **不用 emoji**（`🐼` 在 Windows/Android/各字体下形状与宽度都不一致，会破坏胶囊对齐）。
 * 用纯 SVG + `currentColor`，跟随主题前景色：两只黑耳朵 + 圆脸轮廓 + 两点眼睛。
 * @returns {object} React 元素。
 */
function KbChipIcon() {
	return h('svg', {
		xmlns: 'http://www.w3.org/2000/svg',
		viewBox: '0 0 16 16',
		width: 14,
		height: 14,
		'aria-hidden': 'true',
		focusable: 'false',
		style: { flex: 'none', display: 'block' }
	},
		// 两个黑耳朵（fill=currentColor，实心）
		h('circle', { cx: 4.6, cy: 3.2, r: 2.2, fill: 'currentColor' }),
		h('circle', { cx: 11.4, cy: 3.2, r: 2.2, fill: 'currentColor' }),
		// 圆脸
		h('circle', { cx: 8, cy: 9, r: 5.1, fill: 'none', stroke: 'currentColor', strokeWidth: 1.3 }),
		// 眼睛
		h('circle', { cx: 6.2, cy: 8.5, r: 0.95, fill: 'currentColor' }),
		h('circle', { cx: 9.8, cy: 8.5, r: 0.95, fill: 'currentColor' }));
}

/**
 * 单个知识库 chip：图标 + 名称 + `×` 移除按钮。
 * @param {{id:string, name:string, t?:Function, busy?:boolean, onRemove?:Function}} props - 属性。
 * @returns {object} React 元素。
 */
function KbChip(props) {
	const name = typeof props.name === 'string' ? props.name : '';
	const shortName = kbChipTruncate(name, KB_CHIP_ARIA_MAX);
	const removeLabel = kbChipTranslate(props.t, 'kb.remove', { name: shortName });
	const remove = () => {
		if (typeof props.onRemove === 'function') props.onRemove(props.id);
	};
	return h('span', {
		'data-ima-kb-chip': props.id,
		title: name,
		style: KB_CHIP_STYLE
	},
		h(KbChipIcon, null),
		h('span', { style: KB_CHIP_NAME_STYLE }, name),
		h('button', {
			type: 'button',
			'data-ima-kb-chip-remove': props.id,
			'aria-label': removeLabel,
			title: removeLabel,
			disabled: props.busy === true,
			style: Object.assign({}, KB_CHIP_CLOSE_STYLE, props.busy === true ? { opacity: 0.4, cursor: 'default' } : null),
			onClick: (event) => {
				// 只移除 chip，绝不冒泡到输入框（不触发发送/聚焦切换）。
				if (event !== null && event !== undefined && typeof event.stopPropagation === 'function') {
					event.preventDefault();
					event.stopPropagation();
				}
				remove();
			}
		}, '\u00d7'));
}

/**
 * 输入框**里面**的知识库 chip 栏（注册到 `conversation.input.overlay`）。
 *
 * 渲染落点：组件在 overlay 锚点里只放一个隐藏定位锚，真正的 chip 栏由
 * `useKbChipHost` portal 到输入框卡片第一个子节点（文字上方）—— 见文件头说明。
 *
 * **会话级**（PLATFORM §9.6）：数据源是本会话的选中集，`sessionId` 由注册时
 * `inject` 注入（slot 是 `scope:'session'`，框架给每个会话一份实例）。
 * 换会话 = 换实例 = 重新拉取，绝不沿用上一个会话的 chip。
 *
 * 空态 / 拿不到数据 → 返回 `null`（整栏消失，不留空白占位、不建卡片容器）。
 * 注意区分两种「没有」：**会话空选中集是合法空态**；**拿不到数据是失败**
 * （不渲染，但要 `console.warn` 一次 —— 绝不静默回退成全局显示）。
 * @param {{t?:Function, kbT?:Function, kbSessionId?:string}} props - slot 注入的属性。
 * @returns {object|null} React 元素或 null。
 */
function KbChipBar(props) {
	const t = typeof props.kbT === 'function'
		? props.kbT
		: (typeof props.t === 'function' ? props.t : fallbackTranslate);
	const sessionId = typeof props.kbSessionId === 'string' && props.kbSessionId.trim() !== ''
		? props.kbSessionId.trim()
		: undefined;

	// `{phase:'loading'|'ready'|'error', value}` —— 失败时保留上一次成功结果，避免闪没。
	const [snapshot, setSnapshot] = React.useState({ phase: 'loading', value: undefined });
	const [busyId, setBusyId] = React.useState(null);
	const [error, setError] = React.useState(null);

	React.useEffect(() => {
		if (typeof window === 'undefined') return undefined;
		// 没有会话 id → 拿不到会话级数据。不渲染、不回退全局，只告警一次。
		if (sessionId === undefined) {
			if (!kbChipWarned) {
				kbChipWarned = true;
				console.warn('[dsh-ima-ragplugin] knowledge base chips: no sessionId from slot inject; chips hidden (no global fallback).');
			}
			setSnapshot({ phase: 'error', value: undefined });
			return undefined;
		}
		let alive = true;
		let inFlight = false;
		// 拉取中又被要求刷新（模态刚好在首次加载期间关闭）→ 记一笔，本轮结束再补一次。
		let pendingReload = false;
		let failures = 0;
		let timer = null;

		// 会话换了：旧数据立刻作废（**不能沿用上一个会话的 chip**）。
		setSnapshot({ phase: 'loading', value: undefined });
		setError(null);

		const load = () => {
			if (!alive) return;
			if (inFlight) {
				pendingReload = true;
				return;
			}
			inFlight = true;
			postJson(ROUTES.list, { sessionId: sessionId }).then((value) => {
				if (!alive) return;
				failures = 0;
				setSnapshot({ phase: 'ready', value: value });
			}).catch((cause) => {
				if (!alive) return;
				failures += 1;
				// 静默：辅助展示区不该在输入框里报错打断用户，只 console.warn 一次。
				// 「拿不到会话级数据」= 失败，同样不渲染，但必须留痕（不静默）。
				if (!kbChipWarned) {
					kbChipWarned = true;
					console.warn('[dsh-ima-ragplugin] knowledge base chips: /list failed for session', sessionId, failureOf(cause));
				}
				// 已成功过 → 保留旧结果（别让 chip 突然消失）；从未成功 → error（渲染 null）。
				setSnapshot((current) => (current.phase === 'ready' ? current : { phase: 'error', value: undefined }));
			}).then(() => {
				inFlight = false;
				if (pendingReload && alive) {
					pendingReload = false;
					load();
				}
			});
		};

		const schedule = () => {
			if (!alive) return;
			if (timer !== null) clearTimeout(timer);
			timer = setTimeout(tick, kbChipPollDelay(failures));
		};

		const tick = () => {
			if (!alive) return;
			const visibility = typeof document === 'undefined' ? 'visible' : document.visibilityState;
			if (kbChipShouldPoll(visibility)) load();
			schedule();
		};

		// (a) picker 模态关闭 → 当作「本会话选中集可能变了」的信号，立刻拉一次。
		//     只订阅开关，不读选中集（总线里本来就没有选中集，事实源是宿主路由）。
		let bus = null;
		let unsubscribe = null;
		let wasOpen = false;
		try {
			if (typeof pickerShared === 'function') {
				bus = pickerShared();
				wasOpen = bus.getSnapshot().open === true;
				unsubscribe = bus.subscribe(() => {
					const current = bus.getSnapshot();
					const open = current.open === true;
					const closed = wasOpen && !open;
					wasOpen = open;
					// 总线记着是哪个会话开的模态：别的会话关模态不该刷我。
					const openedFor = typeof current.sessionId === 'string' ? current.sessionId : undefined;
					if (closed && (openedFor === undefined || openedFor === sessionId)) {
						failures = 0;
						load();
					}
				});
			}
		} catch (cause) {
			// picker 席位缺失/改名都不影响 chip 栏：还有 (b)(c) 两条触发。
			bus = null;
		}

		// (b) 跨席位事件：picker「确定」成功后派发，chip 立刻更新（零轮询成本）。
		//     事件带 sessionId（PLATFORM §9.6），**只响应本会话**的事件。
		const onSelectionChanged = (event) => {
			const detail = event === null || event === undefined ? undefined : event.detail;
			if (!kbChipEventMatches(detail, sessionId)) return;
			failures = 0;
			load();
		};
		// (c) 回到前台时补一次（切走期间的变更不会漏）。
		const onVisibility = () => {
			if (kbChipShouldPoll(document.visibilityState)) {
				failures = 0;
				load();
			}
		};

		window.addEventListener(KB_CHIP_EVENT, onSelectionChanged);
		document.addEventListener('visibilitychange', onVisibility);

		load();
		schedule();

		return () => {
			alive = false;
			if (timer !== null) clearTimeout(timer);
			if (typeof unsubscribe === 'function') unsubscribe();
			window.removeEventListener(KB_CHIP_EVENT, onSelectionChanged);
			document.removeEventListener('visibilitychange', onVisibility);
		};
	}, [sessionId]);

	/**
	 * 移除：先乐观更新，再 `POST /select` 写回；失败**回滚**并留下可见提示（不静默）。
	 * @param {string} id - 要移除的知识库 id。
	 * @returns {void}
	 */
	const removeChip = (id) => {
		if (sessionId === undefined) return;
		const current = kbChipSelectedIds(snapshot.value);
		const next = kbChipRemove(current, id);
		if (next.length === current.length) return;
		const previous = snapshot.value;
		setError(null);
		setBusyId(id);
		setSnapshot({ phase: 'ready', value: Object.assign({}, kbChipRecord(previous), { selected: next }) });
		postJson(ROUTES.select, { sessionId: sessionId, ids: next }).then((value) => {
			setSnapshot({ phase: 'ready', value: kbChipApplyResult(previous, next, value) });
		}).catch((cause) => {
			setSnapshot({ phase: 'ready', value: previous });
			setError(kbChipTranslate(t, 'kb.removeFailed', { msg: failureText(t, failureOf(cause)) }));
		}).then(() => {
			setBusyId(null);
		});
	};

	const items = kbChipItems(snapshot.value, sessionId);
	const active = items.length > 0;
	// ⚠ hooks 必须无条件调用（空态提前 return 会改变 hook 顺序）。
	const host = useKbChipHost(active);
	// 空态：没有已选库 → 整栏 null（不留空白占位，也不往卡片里插容器）。
	if (!active) return null;

	const children = items.map((item) => h(KbChip, {
		key: item.id,
		id: item.id,
		name: item.name,
		t: t,
		busy: busyId === item.id,
		onRemove: removeChip
	}));
	if (error !== null) {
		children.push(h('span', {
			key: '__kb-chip-error',
			role: 'status',
			title: error,
			style: KB_CHIP_ERROR_STYLE
		}, error));
	}

	const row = h('div', {
		'data-ima-kb-chips': '',
		role: 'group',
		'aria-label': kbChipTranslate(t, 'kb.barLabel'),
		style: KB_CHIP_ROW_STYLE
	}, children);

	// 定位锚：留在 overlay 锚点里的隐藏节点，`useKbChipHost` 靠它 `closest` 到卡片。
	const anchor = h('div', {
		ref: host.anchorRef,
		'data-ima-kb-chips-anchor': '',
		style: { display: 'none' }
	});

	if (ReactDOM !== null && ReactDOM !== undefined && typeof ReactDOM.createPortal === 'function' && host.host !== null) {
		// 正常路径：chip 栏 portal 进卡片内部的宿主容器（文字上方）。
		return h(React.Fragment, null, anchor, ReactDOM.createPortal(row, host.host));
	}
	// 首帧（宿主还没建好）与降级（找不到卡片 / 没有 react-dom）都渲染在隐藏容器里：
	// 前者在 layout effect 后立刻换成 portal（浏览器不会绘制这一帧），
	// 后者保证绝不覆盖编辑区文字。
	return h(React.Fragment, null, anchor, h('div', { style: { display: 'none' } }, row));
}

// ══════════════════════════════════════════════════════════════════
// 注册
// ══════════════════════════════════════════════════════════════════

/**
 * 把 chip 栏注册进 `conversation.input.overlay`（输入框卡片**内部**的 overlay 锚点）。
 *
 * 只做注册，不渲染任何东西；失败只记录（chip 栏是辅助展示区，不能影响会话输入）。
 *
 * 为什么不是 `conversation.input.left`（旧位置）：那是卡片**底部工具行**、`+` 右边，
 * 用户第三轮明确否掉（「不是显示在界面右下角」）。overlay 锚点在卡片内部，
 * 组件再用 portal 把 chip 栏挂到卡片第一个子节点 —— 视觉上在文字上方。
 *
 * **会话级取数**（PLATFORM §9.6）：slot 是 `scope:'session'`，注册时的 `inject`
 * 收到框架给的 `sessionId`，注入成 `kbSessionId`；组件据此 `POST /list {sessionId}`
 * 并把 sessionId 放进 `useEffect` 依赖 —— 换会话必然重新拉取。
 * 拿不到 sessionId 时组件不渲染（**不回退全局**，宁可空也不能显示错会话的库）。
 * @param {object} ctx - cordis 上下文（提供 slots）。
 * @param {object} env - 10-core 注入的共享环境。
 * @returns {void}
 */
function registerKbChips(ctx, env) {
	const t = typeof env.t === 'function' ? env.t : fallbackTranslate;
	const ns = env.NS === undefined ? 'imaKnowledge' : env.NS;
	try {
		// `kind:'list'` + `scope:'session'`：list 槽必须给唯一 id。
		// 与 picker 的 `ima-picker`（order 20）同槽不冲突：两个独立 id。
		ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
			name: 'conversation.input.overlay',
			id: 'ima-kb-chips',
			order: 60,
			locale: ns,
			// session 作用域槽的 inject 收到 sessionId（同 QueueDock 的 `inject: (sessionId) => ...`）。
			inject: (sessionId) => ({ kbT: t, kbSessionId: sessionId })
		}, KbChipBar));
	} catch (error) {
		console.error('[dsh-ima-ragplugin] conversation.input.overlay unavailable:', error);
	}
}

// ═══ fragment: lib/client/90-tail.js ═══
/**
 * 浏览器侧 · 片段 90（生成物尾部）：插件入口。
 *
 * 职责边界（Lead 拥有）：
 *  - 注册 locale 字典（合并 10-core 的基础字典 + 各席位追加的 key）
 *  - 依次调用各席位注册函数；**任一席位抛错不得影响其他席位**（逐个 try/catch）
 *  - 保留 `plugins.bundle.config` 设置页卡片（兼容 v1 入口）
 *  - 导出 { name, inject, apply }
 */

// ── 插件入口 ──────────────────────────────────────────────────────
/** 服务依赖：槽位、文案、会话（picker 需要）。缺失的服务由 cordis 延迟注入。 */
const inject = ['slots', 'locale'];

/**
 * 构造注册环境：把 10-core 的常量/工具收成一个对象交给席位，
 * 席位只依赖这个 env，不直接抓闭包，便于单测与后续替换。
 * @returns {object} env
 */
function createEnv() {
	return {
		React: React,
		h: h,
		ReactDOM: ReactDOM,
		PACKAGE_NAME: PACKAGE_NAME,
		NS: NS,
		ROUTES: ROUTES,
		S: S,
		zh: zh,
		en: en,
		postJson: postJson,
		HostFailure: HostFailure,
		failureOf: failureOf,
		failureText: failureText,
		errorText: errorText,
		isId: isId,
		normalizeBase: normalizeBase,
		// 组件里拿不到闭包 t 时用它；组件优先用 props.t（切语言会重渲染）
		t: (key, params) => fallbackTranslate(key, params)
	};
}

/**
 * 逐个执行席位注册，失败只记录不阻断。
 * @param {string} label - 席位名（诊断用）。
 * @param {Function} install - 注册函数。
 * @returns {void}
 */
function safeRegister(label, install) {
	try {
		install();
	} catch (error) {
		// 一个席位挂掉不能让整块 UI 消失：其余席位与设置卡照常。
		console.error('[dsh-ima-ragplugin] ' + label + ' registration failed:', error);
	}
}

function apply(ctx) {
	ctx.effect(() => ctx.locale.register(NS, { zh: zh, en: en }), 'dsh-ima-ragplugin: dictionaries');
	fallbackTranslate = ctx.locale.bind(NS);

	const env = createEnv();
	// 席位注册后可能追加 locale key，重新绑定一次翻译函数。
	const bindTranslate = () => { fallbackTranslate = ctx.locale.bind(NS); };

	safeRegister('sidebar', () => {
		registerSidebarPanel(ctx, env);
		bindTranslate();
	});
	safeRegister('picker', () => {
		registerPicker(ctx, env);
		bindTranslate();
	});
	// 输入框卡片内部的知识库 chip 栏（`40-chips.js`，portal 到卡片第一个子节点）。
	// 辅助展示区：注册失败不影响会话输入。
	safeRegister('chips', () => {
		registerKbChips(ctx, env);
		bindTranslate();
	});

	// v1 兼容：插件设置页卡片。主入口已迁到侧边栏，这里保留以免旧路径失效。
	if (typeof ImaSettingsCard === 'function') {
		safeRegister('settings-card', () => {
			ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
				name: 'plugins.bundle.config',
				key: PACKAGE_NAME,
				locale: NS
			}, ImaSettingsCard));
		});
	}
}

exports.name = PACKAGE_NAME;
exports.inject = inject;
exports.apply = apply;
return module.exports;
	}
});
