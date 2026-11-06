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
