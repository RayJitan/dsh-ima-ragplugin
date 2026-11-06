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
