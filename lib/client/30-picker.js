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
