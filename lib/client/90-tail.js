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
