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
