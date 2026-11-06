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
