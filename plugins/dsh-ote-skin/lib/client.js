/**
 * dsh-ote-skin — browser half.
 *
 * Repaints the DSH Web shell in the Oltra graphite language (《欧创 Oltra ·
 * UI/UX 设计规范》): one orange accent, a four-step graphite ladder, depth by
 * fill difference instead of borders and shadows, and small radii.
 *
 * Two layers, both reversible:
 *
 *  1. TOKENS — the host's own semantic tokens (`--dsw-alias-*`) plus the radius
 *     and elevation tokens, handed to `ctx.theme.overrideTokens()`. The host
 *     owns the <body> custom properties, so disposing our layer restores the
 *     stock theme exactly; we never write to the DOM ourselves.
 *     If that API is missing (older or newer host), we fall back to a
 *     stylesheet with `!important` — a stylesheet rule needs `!important` to
 *     beat the inline properties ThemePresenter stamps on <body>.
 *
 *  2. COMPONENT RULES — the handful of looks the token layer cannot express
 *     (outline buttons, the near-black composer well, the selected-row marker).
 *     They match CSS-module class *suffixes* (`[class*="_primary"]`), because
 *     the hashed prefix changes on every DSH build while the exported name does
 *     not. Every rule is scoped under `html[data-dsh-ote-skin]`, which both
 *     raises specificity above the shipped 0,1,0–0,2,0 rules and makes the
 *     whole layer removable by dropping one attribute.
 *
 * Deliberately NOT changed: layout, spacing, and every typography property
 * (font family/size/line-height/letter-spacing) — including inside the AI
 * transcript. The only markdown properties this skin touches are colours
 * (code block, inline code) and the list-marker colour.
 *
 * Loaded by dsh-client-modules and executed through the vendored cordis
 * Loader's lazy-CJS module table (`window.__ModuleLoader__.load`). The factory
 * body is plain CJS; this half needs no module from the table.
 */

window.__ModuleLoader__.load({
	id: 'dsh-ote-skin',
	factory: () => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

		/** Root marker: every component rule is scoped under this attribute. */
		var SKIN_ATTR = 'data-dsh-ote-skin';
		/** id of the component sheet this plugin owns. */
		var STYLE_ID = 'dsh-ote-skin/css';
		/** id of the third-party plugin alignment sheet. */
		var PLUGIN_STYLE_ID = 'dsh-ote-skin/plugins';
		/** id of the fallback token sheet (only used when the host API is absent). */
		var TOKEN_STYLE_ID = 'dsh-ote-skin/tokens';
		/** Name of this token layer, as the host records it. */
		var TOKEN_SOURCE = 'dsh-ote-skin:oltra';
		/** Generation counter: lets the live layer tell itself from a stale one. */
		var generation = 0;
		/** Ordered radius scale (《规范》§4.3): 3 / 4 / 5 / 6 / 8 / 8. */
		var RADIUS = {
			'--dsw-radius-xs': '3px',
			'--dsw-radius-sm': '4px',
			'--dsw-radius-md': '5px',
			'--dsw-radius-lg': '6px',
			'--dsw-radius-xl': '8px',
			'--dsw-radius-panel': '8px'
		};

		/**
		 * The Oltra token table, dark scheme (《规范》§2 + §5.1).
		 *
		 * Values are concrete colours, matching the contract of
		 * ThemeRuntime.register / overrideTokens (no `var()` indirection).
		 * The greys are the four-step ladder: #121315 chrome → #161719 canvas →
		 * #222427 panel → #303132 control → #0a0b0c input well / #0e0e0e code.
		 */
		var TOKENS = Object.assign(RADIUS, {
			/* ---- 面：石墨阶梯 ---- */
			'--dsw-alias-bg-base': '#161719',
			'--dsw-alias-bg-layer-1': '#222427',
			'--dsw-alias-bg-layer-2': '#1c1d1f',
			'--dsw-alias-bg-layer-3': '#303132',
			'--dsw-alias-bg-module-platform': '#121315',
			'--dsw-alias-bg-overlay': '#1c1d1f',
			'--dsw-alias-bg-multi-select': '#303132',
			'--dsw-alias-bg-skeleton': 'rgba(255, 255, 255, 0.06)',
			'--dsw-alias-bg-mask-1': 'rgba(0, 0, 0, 0.5)',
			'--dsw-alias-bg-mask-2': 'rgba(0, 0, 0, 0.3)',
			'--dsw-alias-bg-mask-3': 'rgba(0, 0, 0, 0.6)',
			'--dsw-alias-bg-mask-drop': 'rgba(18, 19, 21, 0.7)',
			'--dsw-alias-bg-document-preview': '#161719',

			/* ---- 线：发丝线三档（§2.3） ---- */
			'--dsw-alias-border-l1': 'rgba(255, 255, 255, 0.08)',
			'--dsw-alias-border-l2': 'rgba(255, 255, 255, 0.13)',
			'--dsw-alias-border-l3': 'rgba(255, 255, 255, 0.18)',
			'--dsw-alias-border-l4': 'rgba(255, 255, 255, 0.24)',
			'--dsw-alias-border-l2-darkmode-thin': 'rgba(255, 255, 255, 0.08)',
			'--dsw-alias-border-inverted': 'rgba(0, 0, 0, 0.06)',
			'--dsw-alias-border-inverted2': 'rgba(0, 0, 0, 0.08)',

			/* ---- 文字：四档（§2.4） ---- */
			'--dsw-alias-label-primary': '#f1f5f9',
			'--dsw-alias-label-secondary': '#cbd5e1',
			'--dsw-alias-label-tertiary': '#94a3b8',
			'--dsw-alias-label-caption': '#94a3b8',
			'--dsw-alias-label-dimmed': '#475569',
			'--dsw-alias-label-primary-dimmed': '#cbd5e1',
			'--dsw-alias-label-primary-inverted': '#64748b',
			'--dsw-alias-label-primary-foreground': '#ffffff',
			'--dsw-alias-label-primary-bluish': '#f1f5f9',
			'--dsw-alias-label-document-preview': '#cbd5e1',
			'--dsw-alias-menu-icon': '#64748b',
			'--dsw-alias-label-shimmer': 'rgba(255, 255, 255, 0.35)',
			'--dsw-alias-label-deep-diving': '#ffb18a',
			'--dsw-alias-label-deep-diving-shimmer': 'rgba(255, 138, 92, 0.45)',

			/* ---- 品牌：唯一强调色（§2.1，禁蓝） ---- */
			'--dsw-alias-brand-primary': '#ff5a1f',
			'--dsw-alias-brand-primary-invert': '#ff5a1f',
			'--dsw-alias-brand-primary-new-colorprimary-new-color': '#ff5a1f',
			'--dsw-alias-brand-text': '#f1f5f9',
			'--dsw-alias-link': '#ff8a5c',
			'--dsw-alias-bg-document-selection': 'rgba(255, 90, 31, 0.32)',

			/* ---- 交互面 ---- */
			'--dsw-alias-interactive-bg-hover': '#222427',
			'--dsw-alias-interactive-bg-hover-solid': '#282828',
			'--dsw-alias-interactive-bg-active': '#282828',
			'--dsw-alias-interactive-bg-hover-accent': 'rgba(255, 90, 31, 0.14)',
			'--dsw-alias-interactive-bg-hover-danger': 'rgba(255, 95, 86, 0.15)',

			/* ---- 按钮族（描边形态见组件层） ---- */
			'--dsw-alias-button-primary-fill': '#ff5a1f',
			'--dsw-alias-button-primary-hover': '#ff7a3d',
			'--dsw-alias-button-primary-dimmed': '#303132',
			'--dsw-alias-button-info-fill': '#ff5a1f',
			'--dsw-alias-button-info-hover': '#ff7a3d',
			'--dsw-alias-button-elevated-fill': '#303132',
			'--dsw-alias-button-floating-fill': '#303132',
			'--dsw-alias-button-floating-hover': '#282828',
			'--dsw-alias-button-ghost-active-fill': '#222222',
			'--dsw-alias-button-ghost-active-hover': '#282828',
			'--dsw-alias-button-ghost-active-border': '#464646',
			'--dsw-alias-button-contrast-fill': '#303132',
			'--dsw-alias-button-tool-bar-fill': 'rgba(255, 255, 255, 0.10)',
			'--dsw-alias-button-tool-bar-hover': 'rgba(255, 255, 255, 0.16)',
			'--dsw-alias-button-tool-bar-fill-invisible': 'rgba(18, 19, 21, 0.36)',

			/* ---- 具体面：侧栏 / 输入井 / 气泡 / 弹层 ---- */
			'--dsw-specific-sidebar-fill': '#121315',
			'--dsw-specific-sidebar-nav-item-active': '#222427',
			'--dsw-specific-sidebar-nav-item-hover': '#1c1d1f',
			'--dsw-specific-sidebar-nav-item-active-accent': 'rgba(255, 90, 31, 0.10)',
			'--dsw-specific-input-major': '#0a0b0c',
			'--dsw-specific-login-input': '#0a0b0c',
			'--dsw-specific-bubble': '#222427',
			'--dsw-specific-bubble-highlight': '#303132',
			'--dsw-specific-selector': '#222222',
			'--dsw-specific-tip': '#222427',
			'--dsw-specific-menu': 'rgba(18, 19, 21, 0.96)',
			'--dsw-menu-surface-fill': 'rgba(18, 19, 21, 0.96)',
			'--dsw-alias-menu-group-header-fill': 'rgba(18, 19, 21, 0.94)',

			/* ---- markdown：只改配色，不动排版 ---- */
			'--dsw-alias-markdown-code-block': '#0e0e0e',
			'--dsw-alias-markdown-code-block-banner': '#222427',
			'--dsw-alias-markdown-inline-code': '#0e0e0e',
			'--dsw-alias-markdown-tag': '#222427',
			'--dsw-alias-markdown-citation': '#222427',
			'--dsw-alias-markdown-placeholder': '#222427',
			'--dsw-alias-markdown-code-segment-selected': '#303132',
			'--dsw-alias-markdown-code-segment-unselected': '#121315',

			/* ---- 语义状态色（§2.5） ---- */
			'--dsw-alias-state-success-primary': '#10b981',
			'--dsw-alias-state-success-secondary': '#34c759',
			'--dsw-alias-state-success-tertiary': 'rgba(16, 185, 129, 0.16)',
			'--dsw-alias-state-warn-primary': '#f59e0b',
			'--dsw-alias-state-warn-secondary': '#ff9f0a',
			'--dsw-alias-state-warn-tertiary': 'rgba(245, 158, 11, 0.16)',
			'--dsw-alias-state-warn-label': '#ffc46b',
			'--dsw-alias-state-error-primary': '#ff5f56',
			'--dsw-alias-state-error-secondary': '#ff453a',
			'--dsw-alias-state-business-primary': '#ff5a1f',
			'--dsw-alias-state-business-tertiary': 'rgba(255, 90, 31, 0.16)',
			'--dsw-alias-state-idle-primary': '#64748b',

			/* ---- 代码 diff ---- */
			'--dsw-alias-code-diff-added': 'rgba(16, 185, 129, 0.12)',
			'--dsw-alias-code-diff-deleted': 'rgba(255, 95, 86, 0.12)',
			'--dsw-alias-file-diff-added-bg': '#12201a',
			'--dsw-alias-file-diff-added-gutter': '#0e1a15',
			'--dsw-alias-file-diff-added-marker': '#10b981',
			'--dsw-alias-file-diff-deleted-bg': '#241513',
			'--dsw-alias-file-diff-deleted-gutter': '#1a0f0e',
			'--dsw-alias-file-diff-deleted-marker': '#ff5f56',

			/* ---- 浮层小件 ---- */
			'--dsw-alias-toast-bg': '#303132',
			'--dsw-alias-toast-label': '#f1f5f9',
			'--dsw-alias-tooltip-bg': '#222222',
			'--dsw-alias-tooltip-key-bg': '#303132',
			'--dsw-alias-switch-thumb': '#ffffff',
			'--dsw-alias-turn-trigger-bg': '#222427',
			'--dsw-alias-turn-trigger-bg-hover': '#282828',

			/* ---- 滚动条：工业风 8px（§9） ---- */
			'--dsw-alias-scrollbar-bg-l1': 'rgba(255, 255, 255, 0.16)',
			'--dsw-alias-scrollbar-bg-l2': 'rgba(255, 255, 255, 0.16)',
			'--dsw-alias-scrollbar-hover-l1': 'rgba(255, 255, 255, 0.28)',
			'--dsw-alias-scrollbar-hover-l2': 'rgba(255, 255, 255, 0.28)',
			'--dsh-scrollbar-width': '8px',
			'--dsh-scrollbar-thumb-border': '2px',
			'--dsh-scrollbar-thumb': 'rgba(255, 255, 255, 0.16)',
			'--dsh-scrollbar-thumb-hover': 'rgba(255, 255, 255, 0.28)',

			/* ---- 层级：面板与卡片不再自带阴影，浮层保留（§5.1） ---- */
			'--dsw-elevation-soft': 'none',
			'--dsw-elevation-stroke-color': 'rgba(255, 255, 255, 0.07)',
			'--dsw-elevation-panel': '0 0 0 1px rgba(255, 255, 255, 0.07), 0 12px 28px rgba(0, 0, 0, 0.55)',
			'--dsw-elevation-prominent': '0 0 0 1px rgba(255, 255, 255, 0.06), 0 24px 60px rgba(0, 0, 0, 0.8)',
			'--dsw-shadow-lv3': '0 0 1px 0 rgba(0, 0, 0, 0.2), 0 12px 32px 0 rgba(0, 0, 0, 0.55)'
		});

		/**
		 * Component rules the token layer cannot express.
		 *
		 * Every selector is prefixed with `html[data-dsh-ote-skin]`:
		 *  - specificity: beats the shipped rules (0,1,0–0,2,0) without
		 *    `!important`, so nothing here fights the host with a hammer;
		 *  - removability: dropping the attribute disarms the whole block.
		 *
		 * Class matching uses the CSS-module *exported name* only
		 * (`[class*="_primary"]`): the hash in front of it is re-rolled on every
		 * DSH build, the exported name is not.
		 *
		 * No rule here sets a layout or typography property; the test suite
		 * enforces that.
		 */
		var COMPONENT_CSS = [
			/* Our own scale, so the rules below read as the spec reads. */
			'html[' + SKIN_ATTR + ']{',
			'  --dsh-ote-accent: #ff5a1f;',
			'  --dsh-ote-accent-hover: #ff7a3d;',
			'  --dsh-ote-accent-press: rgba(255, 90, 31, 0.16);',
			'  --dsh-ote-glow-ring: 0 0 0 2px rgba(255, 90, 31, 0.32), 0 0 14px -4px rgba(255, 90, 31, 0.5);',
			'}',

			/* §7.1 主按钮 = 透明底 + 1px 橙描边 + 橙字；不加投影、不加辉光。 */
			'html[' + SKIN_ATTR + '] [class*="_button"][class*="_primary"]{',
			'  background: transparent;',
			'  color: #ff8a5c;',
			'  box-shadow: inset 0 0 0 1px var(--dsh-ote-accent);',
			'}',
			'html[' + SKIN_ATTR + '] [class*="_button"][class*="_primary"]:hover:not(:disabled){',
			'  background: transparent;',
			'  color: #ffb18a;',
			'  box-shadow: inset 0 0 0 1px var(--dsh-ote-accent-hover);',
			'}',
			'html[' + SKIN_ATTR + '] [class*="_button"][class*="_primary"]:active:not(:disabled){',
			'  background: var(--dsh-ote-accent-press);',
			'}',
			/* 禁用态照实压暗，不给假可点感（§0 第 10 条）。 */
			'html[' + SKIN_ATTR + '] [class*="_button"][class*="_primary"]:disabled{',
			'  opacity: 0.45;',
			'}',

			/* §7.14 输入区：发送钮与加号钮从胶囊改成 5px 小圆角。 */
			'html[' + SKIN_ATTR + '] [class*="_composerStack"] [class*="_primary"],',
			'html[' + SKIN_ATTR + '] [class*="_composerStack"] [class*="_add"]{',
			'  border-radius: 5px;',
			'}',
			'html[' + SKIN_ATTR + '] [class*="_composerStack"] [class*="_primary"]{',
			'  background: transparent;',
			'  color: #ff8a5c;',
			'  box-shadow: inset 0 0 0 1px var(--dsh-ote-accent);',
			'}',
			'html[' + SKIN_ATTR + '] [class*="_composerStack"] [class*="_primary"]:hover{',
			'  background: transparent;',
			'  color: #ffb18a;',
			'  box-shadow: inset 0 0 0 1px var(--dsh-ote-accent-hover);',
			'}',
			'html[' + SKIN_ATTR + '] [class*="_composerStack"] [class*="_primary"]:active{',
			'  background: var(--dsh-ote-accent-press);',
			'}',
			'html[' + SKIN_ATTR + '] [class*="_composerStack"] [class*="_add"]{',
			'  background: transparent;',
			'  color: #94a3b8;',
			'}',
			'html[' + SKIN_ATTR + '] [class*="_composerStack"] [class*="_add"]:hover{',
			'  background: rgba(255, 255, 255, 0.06);',
			'  color: #f1f5f9;',
			'}',
			/* §7.3 辉光只属于聚焦（§5.1 纪律）。 */
			'html[' + SKIN_ATTR + '] [class*="_composerStack"] [class*="_card"]:focus-within{',
			'  box-shadow: var(--dsh-ote-glow-ring);',
			'}',
			/* 输入卡底色：主人钦定 #212121（2026-10-16）。data 属性是宿主自带的
			 * 稳定钩子，不用赌 CSS-module 的名字。 */
			'html[' + SKIN_ATTR + '] [data-composer-card="true"]{',
			'  background-color: #212121;',
			'}',

			/* 侧栏根：实底 #292929、文字纯白 —— 主人钦定（2026-10-16）。
			 * 只打 sidebarCol 的直接孙级 root，不波及其他 _root。 */
			'html[' + SKIN_ATTR + '] [class*="_sidebarCol"] > div > [class*="_root"]{',
			'  color: #ffffff;',
			'  background-color: #292929;',
			'}',

			/* §6.4 选中态用左缘 2px 橙竖条；inset 阴影不动盒模型，不碰布局。 */
			'html[' + SKIN_ATTR + '] [class*="_sessionRow"][class*="_selected"],',
			'html[' + SKIN_ATTR + '] [class*="_projectRow"][class*="_selected"],',
			'html[' + SKIN_ATTR + '] [class*="_panelRow"][class*="_panelActive"]{',
			'  box-shadow: inset 2px 0 0 var(--dsh-ote-accent);',
			'}',

			/* §7.14 步骤行与工具卡：面板底色分层，不再画描边。 */
			'html[' + SKIN_ATTR + '] [class*="_ioCard"]{',
			'  background: var(--dsw-alias-bg-layer-1);',
			'  border-color: transparent;',
			'}',

			/* 列表左侧圆点改品牌橙；只动颜色，不动行高与缩进。 */
			'html[' + SKIN_ATTR + '] [class*="_markdown"] li::marker{',
			'  color: var(--dsh-ote-accent);',
			'}',

			/* 代码块圆角收到 §4.3 的阶梯（令牌管不到这个 inner 变量）。 */
			'html[' + SKIN_ATTR + '] [class*="_block"][class*="_block"]{',
			'  --dsl-code-block-border-radius: 4px;',
			'}',

			/* §3.7 模型档 / 权限档的 chip：单行、放不下就省略号、绝不允许溢出容器。
			 * 这里只做「允许收缩」与「截断」两件事 —— min-width:0 是解除 flex 子项的
			 * 固有最小宽度（不改尺寸），width/height/padding/margin 一个都不动，
			 * 所以布局与间距不受影响。 */
			'html[' + SKIN_ATTR + '] [class*="_trigger"]{',
			'  min-width: 0;',
			'  overflow: hidden;',
			'}',
			'html[' + SKIN_ATTR + '] [class*="_triggerLabel"]{',
			'  min-width: 0;',
			'  white-space: nowrap;',
			'  overflow: hidden;',
			'  text-overflow: ellipsis;',
			'}'
		].join('\n');

		/**
		 * Third-party plugin UI, brought back onto the palette.
		 *
		 * These packages paint with their own colours, and several of them write
		 * those colours into `style=""` (React inline styles) — which outranks a
		 * stylesheet. So unlike the component layer above, this one is allowed
		 * (and needs) `!important`. Every selector is still scoped to a hook the
		 * plugin itself publishes — `[data-dsh-picker]`, `[data-dsh-token-hud]`,
		 * `[data-tag-tone]`, or the exact colour it writes — never a bare `*`.
		 *
		 * Rule of thumb applied here: 语义状态色（成功绿 / 警告琥珀 / 错误红）保留，
		 * 非语义的蓝与紫一律收成唯一强调橙（《规范》§2.1 只有一个强调色）。
		 */
		var PLUGIN_CSS = [
			/* ---- dsh-element-picker：蓝框 + 白色高光圈 → 橙描边（§7.11 合法落点） ---- */
			'html[' + SKIN_ATTR + '] [data-dsh-picker="box"]{',
			'  border-color: var(--dsh-ote-accent) !important;',
			'  box-shadow: 0 0 0 1px rgba(255, 90, 31, 0.55), 0 0 0 3px rgba(255, 90, 31, 0.22) !important;',
			'}',
			'html[' + SKIN_ATTR + '] [data-dsh-picker="tag"]{',
			'  background: var(--dsw-alias-bg-layer-3) !important;',
			'  color: var(--dsw-alias-label-primary) !important;',
			'  border-radius: 3px !important;',
			'}',
			'html[' + SKIN_ATTR + '] [data-dsh-picker="add"]{',
			'  background: var(--dsh-ote-accent) !important;',
			'  color: #ffffff !important;',
			'  border-radius: 3px !important;',
			'}',
			'html[' + SKIN_ATTR + '] [data-dsh-picker="add"]:hover{',
			'  background: var(--dsh-ote-accent-hover) !important;',
			'}',
			'html[' + SKIN_ATTR + '] [data-dsh-picker="bar"]{',
			'  border-radius: 4px !important;',
			'}',

			/* ---- dsh-token-hud：主人明令不套皮（2026-10-16）。 ----
			 * 它只消费四个语义别名（其余全是自带颜色），把这四个在卡片自己的
			 * 元素上钉回出厂值即可完全免疫 token 层——元素自身的声明永远赢过
			 * 从 body 继承来的值，无需 !important。 */
			'html[' + SKIN_ATTR + '] [data-dsh-token-hud]{',
			'  --dsw-alias-bg-layer-1: #1c1c1e;',
			'  --dsw-alias-label-primary: #e7ebf3;',
			'  --dsw-alias-label-secondary: rgba(231, 235, 243, 0.72);',
			'  --dsw-alias-label-tertiary: rgba(231, 235, 243, 0.46);',
			'}',

			/* ---- @linxin666/task-board：六组写死的标签色 → 橙色阶梯 + 一档中性 ---- */
			'html[' + SKIN_ATTR + '] [data-tag-tone="0"]{',
			'  --dsh-task-tag-fill: rgba(255, 90, 31, 0.18) !important;',
			'  --dsh-task-tag-border: rgba(255, 90, 31, 0.42) !important;',
			'}',
			'html[' + SKIN_ATTR + '] [data-tag-tone="1"]{',
			'  --dsh-task-tag-fill: rgba(255, 90, 31, 0.14) !important;',
			'  --dsh-task-tag-border: rgba(255, 90, 31, 0.34) !important;',
			'}',
			'html[' + SKIN_ATTR + '] [data-tag-tone="2"]{',
			'  --dsh-task-tag-fill: rgba(255, 90, 31, 0.11) !important;',
			'  --dsh-task-tag-border: rgba(255, 90, 31, 0.28) !important;',
			'}',
			'html[' + SKIN_ATTR + '] [data-tag-tone="3"]{',
			'  --dsh-task-tag-fill: rgba(255, 90, 31, 0.08) !important;',
			'  --dsh-task-tag-border: rgba(255, 90, 31, 0.22) !important;',
			'}',
			'html[' + SKIN_ATTR + '] [data-tag-tone="4"]{',
			'  --dsh-task-tag-fill: rgba(255, 90, 31, 0.06) !important;',
			'  --dsh-task-tag-border: rgba(255, 90, 31, 0.18) !important;',
			'}',
			'html[' + SKIN_ATTR + '] [data-tag-tone="5"]{',
			'  --dsh-task-tag-fill: rgba(255, 255, 255, 0.07) !important;',
			'  --dsh-task-tag-border: rgba(255, 255, 255, 0.18) !important;',
			'}',

			/* ---- dsh-at-file：文件类型图标里的蓝与紫收成橙；蓝灰收成弱文字色 ---- */
			'html[' + SKIN_ATTR + '] [style*="#4d9de0"],',
			'html[' + SKIN_ATTR + '] [style*="rgb(77, 157, 224)"]{',
			'  color: var(--dsh-ote-accent) !important;',
			'}',
			'html[' + SKIN_ATTR + '] [style*="#9a78d1"],',
			'html[' + SKIN_ATTR + '] [style*="rgb(154, 120, 209)"]{',
			'  color: var(--dsh-ote-accent) !important;',
			'}',
			'html[' + SKIN_ATTR + '] [style*="#8c98a5"],',
			'html[' + SKIN_ATTR + '] [style*="rgb(140, 152, 165)"]{',
			'  color: var(--dsw-alias-label-tertiary) !important;',
			'}',

			/* ---- @nanmicoder/dsh-agent-teams：头像投影写死的深海军蓝 → 中性黑 ---- */
			'html[' + SKIN_ATTR + '] [style*="18, 45, 72"]{',
			'  filter: drop-shadow(0 1px 1px rgba(0, 0, 0, 0.35)) !important;',
			'}'
		].join('\n');

		/** A stylesheet rule needs `!important` to outrank the inline <body> properties. */
		function fallbackTokenCss() {
			var parts = [];
			for (var name in TOKENS) {
				if (Object.prototype.hasOwnProperty.call(TOKENS, name) === false) continue;
				parts.push(name + ':' + TOKENS[name] + ' !important');
			}
			return 'body{' + parts.join(';') + '}';
		}

		/**
		 * Stamp the root marker. The value is this generation's number, so a stale
		 * generation's disposer can tell that the attribute now belongs to a newer
		 * one and leave it alone — the marker is a singleton, unlike our sheets.
		 */
		function installMarker() {
			var root = document.documentElement;
			generation += 1;
			var mine = String(generation);
			root.setAttribute(SKIN_ATTR, mine);
			return function () {
				if (root.getAttribute(SKIN_ATTR) !== mine) return;
				root.removeAttribute(SKIN_ATTR);
			};
		}

		/**
		 * Install our stylesheet under a known id.
		 *
		 * A reload of this plugin can install a fresh generation before the stale
		 * one is disposed, so each generation owns its own element: the previous
		 * one is disconnected here, and the stale disposer then sees
		 * `isConnected === false` and leaves the live sheet alone.
		 *
		 * @param css - the sheet text.
		 * @param styleId - id of the element this layer owns.
		 * @returns a disposer that removes the element only while it is connected.
		 */
		function installSheet(css, styleId) {
			var previous = null;
			try {
				previous = document.getElementById(styleId);
			} catch (_error) {
				previous = null;
			}
			/* Adopt a <style> and nothing else: a non-style node wearing our id
			 * belongs to somebody else, so we leave it where it is. */
			var foreignHolder = false;
			if (previous !== null) {
				if (String(previous.tagName || 'STYLE').toUpperCase() === 'STYLE') previous.remove();
				else foreignHolder = true;
			}

			var tag = document.createElement('style');
			if (foreignHolder === false) tag.id = styleId;
			tag.dataset.plugin = 'dsh-ote-skin';
			tag.textContent = css;
			(document.head || document.body).appendChild(tag);

			return function () {
				if (tag.isConnected === false) return;
				tag.remove();
			};
		}

		/**
		 * Hand the palette to the host's theme runtime. The host owns the <body>
		 * custom properties, so this is the reversible path; when the API is
		 * absent we install the same table as a stylesheet instead.
		 * @param ctx - cordis client context.
		 */
		function installTokens(ctx) {
			var theme = ctx && ctx.theme;
			if (theme && typeof theme.overrideTokens === 'function') {
				try {
					var dispose = theme.overrideTokens(TOKEN_SOURCE, TOKENS);
					return function () {
						if (typeof dispose === 'function') dispose();
					};
				} catch (error) {
					try {
						console.warn('[dsh-ote-skin] theme.overrideTokens threw, falling back to a stylesheet', error);
					} catch (_error) {}
				}
			}
			return installSheet(fallbackTokenCss(), TOKEN_STYLE_ID);
		}

		/**
		 * Browser-half entry point.
		 * @param ctx - cordis client context (needs `effect`; `theme` optional).
		 */
		function apply(ctx) {
			ctx.effect(installMarker, 'ote-skin: root marker');
			ctx.effect(
				function () {
					return installTokens(ctx);
				},
				'ote-skin: oltra tokens'
			);
			ctx.effect(
				function () {
					return installSheet(COMPONENT_CSS, STYLE_ID);
				},
				'ote-skin: component rules'
			);
			ctx.effect(
				function () {
					return installSheet(PLUGIN_CSS, PLUGIN_STYLE_ID);
				},
				'ote-skin: third-party plugin alignment'
			);
		}

		exports.apply = apply;
		exports.inject = ['theme'];
		return module.exports;
	}
});
