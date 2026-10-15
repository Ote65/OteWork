/**
 * dsh-token-hud — browser half.
 *
 * A token meter inside the **left sidebar**, in the shell's additive
 * `sidebar.footer.action` seat (directly above the Settings row).
 *
 * The layout is the supplied `TokenCard` design — header with an accent icon
 * tile and a unit switch, a dominant hero number with a quiet unit, a trend /
 * cumulative sub-line, an iOS hairline, then three rounded metric tiles, the
 * cache one carrying a miniature activity ring.
 *
 * Three things this file has to do that the original Tailwind component did not:
 *
 * 1. **No build step.** The bundle is a plain `window.__ModuleLoader__.load`
 *    script, so there is no Tailwind and no `lucide-react`: the utility classes
 *    are translated into inline styles plus one injected stylesheet, and the five
 *    icons are inlined as SVG children.
 * 2. **A 318px rail, not a 576px panel.** The design's `max-w-xl` is 1.8× the
 *    sidebar, so the type scale and paddings are tuned to the measured column
 *    width. The three-up tile grid still fits; only the input:output sub-label
 *    wraps to two lines, which is why the tiles lay out from the top instead of
 *    `justify-between` (that would misalign the three values).
 * 3. **Theme tokens, not hard-coded neutrals.** The design's `bg-white/90` /
 *    `dark:bg-[#1C1C1E]/90` pair assumes Tailwind's own light/dark switch; this
 *    app is themed (and wallpapered) by its own tokens, so surfaces, borders and
 *    text come from `--dsw-alias-*`. The four accents keep the design's literal
 *    Tailwind palette, since the app has no token for amber/indigo.
 *
 * The card material lives in the stylesheet rather than inline so `:hover` can
 * override it, and every colour is theme-derived so both app themes work.
 *
 * @module dsh-token-hud/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-token-hud',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var react = require('react')

    /** Host route backing the card. */
    var API = '/api/token-hud/usage'

    /** Fallback refresh cadence until the host reports its own. */
    var FALLBACK_INTERVAL_MS = 20000

    /** The one stylesheet this plugin injects. */
    var STYLE_ID = 'dsh-token-hud-style'

    /**
     * The design's font, with PingFang SC as the fallback: `-apple-system`
     * resolves to SF Pro on macOS (paired with PingFang for CJK), and on any
     * other platform PingFang SC is picked up directly.
     */
    var FONT = '-apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", "Microsoft YaHei", system-ui, sans-serif'

    /** The design's accent palette (Tailwind 500s), which has no theme token. */
    var BLUE = '#3b82f6'
    var EMERALD = '#10b981'
    var AMBER = '#f59e0b'
    var INDIGO = '#6366f1'
    var ROSE = '#f43f5e'

    /** Text ramp, all from theme tokens so light/dark and skins all work. */
    var L1 = 'var(--dsw-alias-label-primary, #e7ebf3)'
    var L2 = 'var(--dsw-alias-label-secondary, rgba(231,235,243,.72))'
    var L3 = 'var(--dsw-alias-label-tertiary, rgba(231,235,243,.46))'
    var TINT_8 = 'color-mix(in srgb, var(--dsw-alias-label-primary, #fff) 8%, transparent)'
    var TINT_14 = 'color-mix(in srgb, var(--dsw-alias-label-primary, #fff) 14%, transparent)'
    var SEPARATOR = 'color-mix(in srgb, var(--dsw-alias-label-primary, #e7ebf3) 26%, transparent)'

    /** Where the collapsed/expanded choice is remembered between reloads. */
    var COLLAPSE_KEY = 'dsh-token-hud:collapsed'

    /**
     * The injectable surface: the footer row's wrap rule, the card material, the
     * tile chips, the unit button's hover and the ring's easing.
     */
    var STYLESHEET = [
      ':has(> [data-dsh-token-hud="block"]){flex-wrap:wrap}',
      '[data-dsh-token-hud="card"]{',
      'border-radius:2em;',
      'background:color-mix(in srgb,var(--dsw-alias-bg-layer-1,#1c1c1e) 62%,transparent);',
      // The rim is derived from the text colour, not `--dsw-alias-border-l1`:
      // that token is faint enough to disappear when the panel sits on a
      // same-coloured sidebar — which is exactly what the light theme did.
      'border:1px solid color-mix(in srgb,var(--dsw-alias-label-primary,#e7ebf3) 13%,transparent);',
      'box-shadow:0 10px 30px -12px rgba(0,0,0,.32),0 1px 3px rgba(0,0,0,.08);',
      '-webkit-backdrop-filter:blur(24px) saturate(170%);',
      'backdrop-filter:blur(24px) saturate(170%);',
      'cursor:pointer;',
      'transition:box-shadow .3s ease,background-color .3s ease,transform .2s ease-out;',
      '}',
      '[data-dsh-token-hud="card"]:hover{',
      'box-shadow:0 14px 36px -12px rgba(0,0,0,.4),0 1px 3px rgba(0,0,0,.1);',
      '}',
      '[data-dsh-token-hud="card"]:active{transform:scale(.99)}',
      // The tiles are solid, not a tint: the raised surface the theme defines for
      // this level reads as white on the light theme and as a panel on the dark
      // one. The rim stays so they are still defined against the card fill.
      '[data-dsh-token-hud="tile"]{',
      'border-radius:1.1em;',
      'background:var(--dsw-alias-bg-layer-1,#fff);',
      'border:1px solid color-mix(in srgb,var(--dsw-alias-label-primary,#fff) 8%,transparent);',
      '}',
      '[data-dsh-token-hud="unit"]{',
      'background:none;border:0;padding:0.2em 0.5em;border-radius:0.7em;cursor:pointer;',
      'font:inherit;font-size:1.1em;font-weight:500;line-height:1;',
      'color:var(--dsw-alias-label-tertiary,rgba(231,235,243,.46));',
      'transition:color .2s ease,background-color .2s ease;',
      '}',
      '[data-dsh-token-hud="unit"]:hover{color:var(--dsw-alias-label-primary,#e7ebf3);background:color-mix(in srgb,var(--dsw-alias-label-primary,#fff) 8%,transparent)}',
      // The collapse affordance in the hero's label row. It reads as the hint
      // text it looks like, but it is a real control: the card is click-only, so
      // this is what a keyboard reaches and what announces the state.
      '[data-dsh-token-hud="hint"]{',
      'background:none;border:0;padding:0;cursor:pointer;flex:none;white-space:nowrap;',
      'font:inherit;font-size:0.9em;line-height:1;',
      'color:var(--dsw-alias-label-tertiary,rgba(231,235,243,.46));',
      'transition:color .2s ease;',
      '}',
      '[data-dsh-token-hud="hint"]:hover{color:var(--dsw-alias-label-secondary,rgba(231,235,243,.72))}',
      // Collapsing the detail block: `0fr` animates a grid row to zero height,
      // which is the one way to transition to an intrinsic height without
      // measuring it in JS.
      '[data-dsh-token-hud="details"]{display:grid;transition:grid-template-rows .3s ease-out,opacity .25s ease-out}',
      '[data-dsh-token-hud="details"]>div{overflow:hidden;min-height:0}',
      '[data-dsh-token-hud="ring"]{transition:stroke-dashoffset .5s ease-out}',
      '@media (prefers-reduced-motion:reduce){',
      '[data-dsh-token-hud="card"],[data-dsh-token-hud="unit"],[data-dsh-token-hud="hint"],',
      '[data-dsh-token-hud="details"],[data-dsh-token-hud="ring"]{transition:none}',
      '}',
    ].join('')

    /** Strings for the two locales the harness ships. */
    var DICTIONARIES = {
      zh: {
        title: 'Token 计量',
        totalUsage: '总用量',
        vsYesterday: '较昨日',
        cumulative: '累计',
        todayToken: '今日 Token',
        cacheHit: '缓存命中率',
        inputToken: '输入 Token',
        ioRatio: '输入/输出比',
        unitLabel: '单位',
        yi: '亿',
        million: '百万',
        wan: '万',
        unitHint: '点击切换单位（亿 / 百万）',
        trendHint: '今日为当日累计（尚未结束），昨日为整日',
        input: '输入',
        output: '输出',
        cacheRead: '缓存读',
        collapsedTag: '· 已收纳',
        hintCollapse: '轻点收纳',
        hintExpand: '轻点展开指标',
        collapseHint: '点击收纳卡片',
        expandHint: '点击展开卡片详情',
        summaryToday: '今日',
        summaryCache: '缓存率',
        saved: '节约',
      },
      en: {
        title: 'Token Usage',
        totalUsage: 'All time',
        vsYesterday: 'vs yesterday',
        cumulative: 'total',
        todayToken: 'Today',
        cacheHit: 'Cache hit rate',
        inputToken: 'Input',
        ioRatio: 'in:out',
        unitLabel: 'Unit',
        yi: '×10⁸',
        million: '×10⁶',
        wan: '×10⁴',
        unitHint: 'Switch units',
        trendHint: 'Today is still in progress; yesterday is a full day',
        input: 'In',
        output: 'Out',
        cacheRead: 'Cache read',
        collapsedTag: '· Collapsed',
        hintCollapse: 'tap to collapse',
        hintExpand: 'tap to expand',
        collapseHint: 'Click to collapse the card',
        expandHint: 'Click to expand the card',
        summaryToday: 'Today',
        summaryCache: 'Cache',
        saved: 'Saved',
      },
    }

    /**
     * Pick the dictionary for the active document language.
     * @returns one of `DICTIONARIES`.
     */
    function dictionary() {
      var lang = ''
      if (typeof document !== 'undefined' && document.documentElement !== undefined && document.documentElement !== null) {
        lang = String(document.documentElement.lang || '')
      }
      return lang.toLowerCase().indexOf('zh') === 0 ? DICTIONARIES.zh : DICTIONARIES.en
    }

    /**
     * Build a translator: the slot's own `t` when the shell supplies one, the
     * built-in dictionary otherwise.
     * @param props - the component props.
     * @returns `(key) => string`.
     */
    function translator(props) {
      var supplied = props === undefined || props === null ? undefined : props.t
      var dict = dictionary()
      var local = function (key) {
        return dict[key] === undefined ? key : dict[key]
      }
      if (typeof supplied !== 'function') return local
      return function (key) {
        var value = supplied(key)
        return typeof value === 'string' && value !== '' && value !== key ? value : local(key)
      }
    }

    /**
     * The design's token formatter. `yi` and `million` are the pinned modes the
     * header switch toggles; `auto` walks down the scales.
     * @param num - a token count.
     * @param unit - `'yi'`, `'million'` or `'auto'`.
     * @returns `{ value, unitKey }`, where `unitKey` is a dictionary key.
     */
    function formatTokens(num, unit) {
      var value = typeof num === 'number' && Number.isFinite(num) ? num : 0
      if (unit === 'yi' || (unit === 'auto' && value >= 100000000)) return { value: (value / 100000000).toFixed(2), unitKey: 'yi' }
      if (unit === 'million' || (unit === 'auto' && value >= 1000000)) return { value: (value / 1000000).toFixed(1), unitKey: 'million' }
      if (value >= 10000) return { value: (value / 10000).toFixed(1), unitKey: 'wan' }
      return { value: String(Math.round(value)), unitKey: '' }
    }

    /** Group a plain count with thousands separators, the way `toLocaleString` does. */
    function group(value) {
      var n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : 0
      return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    }

    /**
     * One inline SVG icon from the design's lucide set.
     * @param size - an `em` length, so the icon scales with the card.
     * @param accent - the stroke colour.
     * @param paths - `d` attribute strings.
     * @param extra - extra inline style, e.g. the chevron's rotation.
     * @returns a React element.
     */
    function icon(size, accent, paths, extra) {
      return react.createElement(
        'svg',
        {
          viewBox: '0 0 24 24', fill: 'none', stroke: accent,
          strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true',
          style: Object.assign({ flex: 'none', display: 'block', width: size, height: size }, extra),
        },
        paths.map((d) => react.createElement('path', { key: d, d })),
      )
    }

    /** The filled bolt of the header's accent tile. */
    function boltIcon(size) {
      return react.createElement(
        'svg',
        {
          viewBox: '0 0 24 24', fill: 'currentColor', stroke: 'currentColor',
          strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true',
          style: { display: 'block', width: size, height: size },
        },
        react.createElement('polygon', { points: '13 2 3 14 12 14 11 22 21 10 12 10 13 2' }),
      )
    }

    var ICON_SPARKLES = ['M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z']
    var ICON_DATABASE = ['M3 5v14a9 3 0 0 0 18 0V5', 'M3 12a9 3 0 0 0 18 0']
    var ICON_LAYERS = [
      'm12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z',
      'm22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65',
      'm22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65',
    ]
    var ICON_UP_RIGHT = ['M7 7h10v10', 'M7 17 17 7']
    var ICON_DOWN_RIGHT = ['m7 7 10 10', 'M17 7v10H7']

    /** The database glyph needs its lid ellipse as well as the two paths. */
    function databaseIcon(size, accent) {
      return react.createElement(
        'svg',
        {
          viewBox: '0 0 24 24', fill: 'none', stroke: accent,
          strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true',
          style: { flex: 'none', display: 'block', width: size, height: size },
        },
        react.createElement('ellipse', { key: 'lid', cx: 12, cy: 5, rx: 9, ry: 3 }),
        ICON_DATABASE.map((d) => react.createElement('path', { key: d, d })),
      )
    }

    /** The cache ring: a 5px-stroked 44-unit circle at 18px. */
    var RING_RADIUS = 18
    var RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS

    /**
     * The miniature activity ring.
     * @param ratio - 0..1 fill.
     * @returns a React element.
     */
    function ring(ratio) {
      return react.createElement(
        'svg',
        {
          'data-dsh-token-hud': 'ring', viewBox: '0 0 44 44',
          'aria-hidden': 'true',
          style: { flex: 'none', marginLeft: 'auto', transform: 'rotate(-90deg)', width: '1.4em', height: '1.4em' },
        },
        react.createElement('circle', {
          key: 'track', cx: 22, cy: 22, r: RING_RADIUS, fill: 'none',
          stroke: 'color-mix(in srgb, ' + L1 + ' 14%, transparent)', strokeWidth: 4,
        }),
        react.createElement('circle', {
          key: 'fill', cx: 22, cy: 22, r: RING_RADIUS, fill: 'none', stroke: EMERALD, strokeWidth: 4,
          strokeLinecap: 'round', strokeDasharray: RING_CIRCUMFERENCE,
          strokeDashoffset: RING_CIRCUMFERENCE * (1 - Math.max(0, Math.min(1, ratio))),
        }),
      )
    }

    /**
     * Full-bleed block box: spans the column, then insets the card by 8px so the
     * panel sits inside the rail rather than touching its edges.
     *
     * It is also the **query container** the card measures itself against, which
     * is why the inset stays a plain 8px while everything inside the card is
     * relative: `cqw` resolves against this box's content width, so a `cqw`
     * value on the block itself would be circular.
     */
    var BLOCK = {
      flex: '0 0 auto',
      boxSizing: 'border-box',
      // `- 1px` keeps the outer size just under the flex line, so sub-pixel
      // rounding can never push the block onto a line of its own.
      width: 'calc(100% + var(--dsh-sidebar-inline-padding, 12px) + var(--dsh-sidebar-inline-padding, 12px) - 1px)',
      marginLeft: 'calc(-1 * var(--dsh-sidebar-inline-padding, 12px))',
      marginRight: 'calc(-1 * var(--dsh-sidebar-inline-padding, 12px))',
      padding: '8px 8px 10px',
      containerType: 'inline-size',
      fontFamily: FONT,
      color: L1,
      userSelect: 'none',
      fontVariantNumeric: 'tabular-nums',
    }

    /**
     * The card's base type size — **the one number the whole layout scales with**.
     * Every other dimension inside the card is an `em` multiple of it, so
     * changing this scales the geometry, the type and the icons together and the
     * layout proportions never drift.
     *
     * - `3.15cqw` is the width budget: at the rail's 318px card the base is
     *   10px, which is the size the design was tuned to. Drag the rail wider and
     *   the card grows with it.
     * - `0.95vh` is the height budget: at a 1056px window it is also ~10px, and
     *   a shorter window shrinks the card proportionally instead of letting it
     *   crowd the session list.
     * - `min()` of the two means the card always fits *both* axes, so it can
     *   never overflow the rail; the outer `clamp()` keeps it legible and stops
     *   a very large display from producing an absurd card.
     */
    var BASE_FONT = 'clamp(7.5px, min(3.15cqw, 0.95vh), 12px)'

    var CARD = { boxSizing: 'border-box', fontSize: BASE_FONT, padding: '1.2em 1.2em 1.1em' }

    var HEAD = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.8em', gap: '0.6em' }
    var HEAD_LEFT = { display: 'flex', alignItems: 'center', gap: '0.7em', minWidth: 0 }
    /** The "· 已收纳" suffix, shown only while collapsed. */
    var TAG = { fontSize: '0.9em', color: L3, whiteSpace: 'nowrap' }
    var ICON_TILE = {
      width: '2.2em', height: '2.2em', borderRadius: '0.7em', flex: 'none',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'color-mix(in srgb, ' + BLUE + ' 14%, transparent)',
      color: BLUE,
    }
    var TITLE = {
      fontSize: '1.2em', fontWeight: 600, letterSpacing: '-0.01em', color: L1,
      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
    }

    var HERO = { marginBottom: '1em' }
    var HERO_LABEL_ROW = {
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      gap: '0.5em', marginBottom: '0.1em',
    }
    var HERO_LABEL = { fontSize: '1em', fontWeight: 500, color: L2 }
    var HERO_ROW = { display: 'flex', alignItems: 'baseline', gap: '0.5em' }
    var HERO_NUMBER = { fontSize: '3em', fontWeight: 600, letterSpacing: '-0.02em', lineHeight: 1.05, color: L1 }
    var HERO_UNIT = { fontSize: '1.4em', fontWeight: 500, color: L2 }
    var SUBS = {
      display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '0.3em 0.4em',
      marginTop: '0.2em', fontSize: '0.95em', color: L2,
    }
    var TREND = { display: 'inline-flex', alignItems: 'center', gap: '0.1em', fontWeight: 500 }
    var SEP = { color: SEPARATOR }

    /** The collapsed one-liner that replaces the detail block. */
    var SUMMARY = {
      display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.2em 0.5em',
      marginTop: '0.7em', paddingTop: '0.7em',
      borderTop: '1px solid color-mix(in srgb, ' + L1 + ' 10%, transparent)',
      fontSize: '0.95em', color: L2,
    }
    var SUMMARY_STRONG = { fontWeight: 600, color: L1 }
    /** The container the tiles collapse into; the row track animates 1fr → 0fr. */
    var DETAILS = { display: 'grid' }
    var DETAILS_INNER = { overflow: 'hidden', minHeight: 0 }

    var HAIRLINE = { height: 1, marginBottom: '0.9em', background: 'color-mix(in srgb, ' + L1 + ' 10%, transparent)' }

    var GRID = { display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '0.7em' }
    var TILE = { display: 'flex', flexDirection: 'column', padding: '0.6em 0.7em', minWidth: 0 }
    var TILE_HEAD = { display: 'flex', alignItems: 'center', gap: '0.3em', marginBottom: '0.2em', minWidth: 0, color: L2 }
    var TILE_LABEL = { fontSize: '0.95em', fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }
    var TILE_VALUE = { display: 'flex', alignItems: 'center', gap: '0.2em', minWidth: 0 }
    var TILE_NUMBER = { fontSize: '1.35em', fontWeight: 600, letterSpacing: '-0.02em', color: L1 }
    var TILE_UNIT = { fontSize: '0.9em', color: L2 }

    /**
     * One metric tile: an accent glyph, its label, and the value. No third line —
     * the card shows the headline numbers only, and the detail lives in the
     * block's native tooltip.
     * @param props - `{ glyph, label, value, unit, extra }`.
     * @returns a React element.
     */
    function tile(props) {
      return react.createElement(
        'div',
        { 'data-dsh-token-hud': 'tile', style: TILE },
        react.createElement(
          'div',
          { style: TILE_HEAD },
          props.glyph,
          react.createElement('span', { style: TILE_LABEL }, props.label),
        ),
        react.createElement(
          'div',
          { style: TILE_VALUE },
          react.createElement('span', { style: TILE_NUMBER }, props.value),
          props.unit === '' || props.unit === undefined ? null : react.createElement('span', { style: TILE_UNIT }, props.unit),
          props.extra === undefined ? null : props.extra,
        ),
      )
    }

    /**
     * Append this plugin's one stylesheet; returns a remover.
     * @returns the disposer.
     */
    function installStyles() {
      if (typeof document === 'undefined' || document.head === undefined || document.head === null) return function () {}
      if (typeof document.getElementById === 'function' && document.getElementById(STYLE_ID) !== null) return function () {}
      var style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = STYLESHEET
      document.head.appendChild(style)
      return function () {
        if (style.parentNode !== undefined && style.parentNode !== null) style.parentNode.removeChild(style)
      }
    }

    /**
     * The remembered collapse choice, or `null` when nothing is stored.
     * A blocked or absent store is not an error: the card just starts expanded.
     * @returns `true`, `false`, or `null`.
     */
    function readCollapsed() {
      try {
        if (typeof localStorage === 'undefined' || localStorage === null) return null
        var raw = localStorage.getItem(COLLAPSE_KEY)
        if (raw === '1') return true
        if (raw === '0') return false
        return null
      } catch (error) {
        return null
      }
    }

    /**
     * Remember the collapse choice, so a reload comes back the way it was left.
     * @param value - the new collapsed state.
     */
    function writeCollapsed(value) {
      try {
        if (typeof localStorage === 'undefined' || localStorage === null) return
        localStorage.setItem(COLLAPSE_KEY, value === true ? '1' : '0')
      } catch (error) {
        /* storage denied: the card still toggles for this session */
      }
    }

    /**
     * The sidebar token card.
     * @param props - slot props; `wide` is false in the collapsed rail.
     * @returns a React element, or null when there is nothing to show.
     */
    function TokenHud(props) {
      var t = translator(props)
      var pair = react.useState(null)
      var payload = pair[0]
      var setPayload = pair[1]
      var unitPair = react.useState('yi')
      var unit = unitPair[0]
      var setUnit = unitPair[1]
      // Read on every render rather than through a lazy initialiser, so the test
      // harness's plain `useState` stand-in keeps working.
      var collapsedPair = react.useState(readCollapsed() === true)
      var collapsed = collapsedPair[0]
      var setCollapsed = collapsedPair[1]

      react.useEffect(function () {
        var alive = true
        var intervalMs = FALLBACK_INTERVAL_MS
        var timer = null

        function load() {
          return fetch(API, { headers: { accept: 'application/json' } })
            .then(function (response) {
              return response.ok ? response.json() : Promise.reject(new Error(String(response.status)))
            })
            .then(function (body) {
              if (alive === false || body === null || typeof body !== 'object' || body.ok !== true) return
              // Keep the last good numbers on a later failure.
              setPayload(body)
              var next = body.display === undefined || body.display === null ? undefined : body.display.intervalMs
              if (typeof next === 'number' && next >= 2000) intervalMs = next
            })
            .catch(function () { /* the previous payload stays on screen */ })
        }

        // Re-arm rather than setInterval, so a configured interval takes effect
        // on the very next tick instead of only after a reload.
        function schedule() {
          if (alive === false) return
          timer = setTimeout(function () {
            load().then(schedule)
          }, intervalMs)
        }

        load().then(schedule)
        return function () {
          alive = false
          if (timer !== null) clearTimeout(timer)
        }
      }, [])

      // The collapsed rail is 56px wide: a card cannot live there.
      if (props !== null && props !== undefined && props.wide === false) return null
      if (payload === null) return null
      if (payload.display !== undefined && payload.display !== null && payload.display.enabled === false) return null

      var total = payload.total || {}
      var today = payload.today || {}

      // The design's TokenMetrics, mapped onto the host route — with one
      // deliberate deviation: the hero is the **grand total** (input + output +
      // cache read/write), not the design's `totalOutputTokens`. Output alone is
      // ~0.3% of this profile's usage, so a hero wired to it read as though the
      // history had been thrown away.
      var metrics = {
        heroTokens: numberOr(total.tokens, 0),
        todayTokens: numberOr(today.tokens, 0),
        outputTokens: numberOr(total.output, 0),
        cacheHitRate: numberOr(payload.cacheHitRate, 0),
        inputTokens: numberOr(total.uncachedInput, 0),
        cachedTokens: numberOr(total.cacheRead, 0),
        trendPercentage: typeof payload.trendPercentage === 'number' && Number.isFinite(payload.trendPercentage) ? payload.trendPercentage : null,
      }

      var hero = formatTokens(metrics.heroTokens, unit)
      var todayFormatted = formatTokens(metrics.todayTokens, 'auto')
      var input = formatTokens(metrics.inputTokens, unit === 'yi' ? 'yi' : 'million')
      var cached = formatTokens(metrics.cachedTokens, 'auto')
      var ioRatio = metrics.inputTokens > 0 ? (metrics.outputTokens / metrics.inputTokens).toFixed(1) : '0.0'
      var unitName = unit === 'yi' ? t('yi') : t('million')
      /**
       * Stop a click reaching the card, which toggles collapse on every click.
       * @param event - the React click event, absent in tests.
       */
      var swallow = function (event) {
        if (event !== undefined && event !== null && typeof event.stopPropagation === 'function') event.stopPropagation()
      }
      var toggleUnit = function (event) {
        swallow(event)
        setUnit(function (previous) { return previous === 'yi' ? 'million' : 'yi' })
      }
      var toggleCollapsed = function () {
        setCollapsed(function (previous) {
          var next = previous !== true
          writeCollapsed(next)
          return next
        })
      }
      var toggleFromHint = function (event) {
        swallow(event)
        toggleCollapsed()
      }

      var inputDetail = formatTokens(metrics.inputTokens, 'auto')
      var outputDetail = formatTokens(metrics.outputTokens, 'auto')
      var detail = [
        t('input') + ' ' + inputDetail.value + t(inputDetail.unitKey),
        t('output') + ' ' + outputDetail.value + t(outputDetail.unitKey),
        t('cacheRead') + ' ' + cached.value + t(cached.unitKey),
        t('ioRatio') + ' 1:' + ioRatio,
      ].join(' · ')

      var rising = metrics.trendPercentage !== null && metrics.trendPercentage >= 0
      var trend = metrics.trendPercentage === null ? null : react.createElement(
        'span',
        {
          key: 'trend',
          'data-dsh-token-hud': 'trend',
          style: Object.assign({}, TREND, { color: rising ? EMERALD : ROSE }),
          title: t('trendHint'),
        },
        icon('1.1em', 'currentColor', rising ? ICON_UP_RIGHT : ICON_DOWN_RIGHT),
        (rising ? '+' : '') + metrics.trendPercentage.toFixed(1) + '%',
      )

      // Built as a list so the trend chip and its separator drop out together:
      // a bare leading `·` when there is no previous day is worse than nothing.
      var subLine = []
      if (trend !== null) {
        subLine.push(trend)
        subLine.push(react.createElement('span', { key: 'sep-trend', style: SEP }, '·'))
        subLine.push(react.createElement('span', { key: 'vs' }, t('vsYesterday')))
        subLine.push(react.createElement('span', { key: 'sep-cum', style: SEP }, '·'))
      }
      subLine.push(react.createElement(
        'span',
        { key: 'cum' },
        t('cumulative') + ' ' + group(metrics.heroTokens) + ' tokens',
      ))

      // Collapsed, the detail block is replaced by one line of the numbers that
      // matter, so the card stays useful at a fraction of its height.
      var summary = react.createElement(
        'div',
        { 'data-dsh-token-hud': 'summary', style: SUMMARY },
        react.createElement(
          'span',
          null,
          t('summaryToday') + ': ',
          react.createElement('strong', { style: SUMMARY_STRONG }, todayFormatted.value + t(todayFormatted.unitKey)),
        ),
        react.createElement('span', { style: SEP }, '·'),
        react.createElement(
          'span',
          null,
          t('summaryCache') + ': ',
          react.createElement(
            'strong',
            { style: Object.assign({}, SUMMARY_STRONG, { color: EMERALD }) },
            (metrics.cacheHitRate * 100).toFixed(1) + '%',
          ),
        ),
        react.createElement('span', { style: SEP }, '·'),
        react.createElement('span', { style: { color: EMERALD } }, t('saved') + ' ' + cached.value + t(cached.unitKey)),
      )

      var detailsStyle = Object.assign({}, DETAILS, {
        gridTemplateRows: collapsed ? '0fr' : '1fr',
        opacity: collapsed ? 0 : 1,
        pointerEvents: collapsed ? 'none' : undefined,
      })

      return react.createElement(
        'div',
        {
          'data-dsh-token-hud': 'block',
          title: detail,
          style: BLOCK,
        },
        react.createElement(
          'div',
          { 'data-dsh-token-hud': 'card', style: CARD, onClick: toggleCollapsed },
          // Header: accent tile, title, the collapse tag, and the unit switch.
          react.createElement(
            'div',
            { style: HEAD },
            react.createElement(
              'div',
              { style: HEAD_LEFT },
              react.createElement('div', { style: ICON_TILE }, boltIcon('1.3em')),
              react.createElement('span', { style: TITLE }, t('title')),
              collapsed ? react.createElement('span', { style: TAG }, t('collapsedTag')) : null,
            ),
            react.createElement(
              'button',
              { 'data-dsh-token-hud': 'unit', type: 'button', onClick: toggleUnit, title: t('unitHint') },
              t('unitLabel') + '：' + unitName,
            ),
          ),
          // Hero: the grand total, the collapse control, and either the trend
          // line or the collapsed summary.
          react.createElement(
            'div',
            { style: HERO },
            react.createElement(
              'div',
              { style: HERO_LABEL_ROW },
              react.createElement('span', { style: HERO_LABEL }, t('totalUsage')),
              react.createElement(
                'button',
                {
                  'data-dsh-token-hud': 'hint',
                  type: 'button',
                  onClick: toggleFromHint,
                  title: collapsed ? t('expandHint') : t('collapseHint'),
                  'aria-expanded': collapsed ? 'false' : 'true',
                },
                collapsed ? t('hintExpand') : t('hintCollapse'),
              ),
            ),
            react.createElement(
              'div',
              { style: HERO_ROW },
              react.createElement('span', { style: HERO_NUMBER }, hero.value),
              hero.unitKey === '' ? null : react.createElement('span', { style: HERO_UNIT }, t(hero.unitKey)),
            ),
            collapsed ? summary : react.createElement('div', { style: SUBS }, subLine),
          ),
          // The detail block animates shut: the tiles stay mounted inside a grid
          // row that goes from `1fr` to `0fr`.
          react.createElement(
            'div',
            {
              'data-dsh-token-hud': 'details',
              'data-collapsed': collapsed ? 'true' : 'false',
              'aria-hidden': collapsed ? 'true' : undefined,
              style: detailsStyle,
            },
            react.createElement(
              'div',
              { style: DETAILS_INNER },
              react.createElement('div', { style: HAIRLINE }),
              react.createElement(
                'div',
                { style: GRID },
                tile({
                  glyph: icon('1em', AMBER, ICON_SPARKLES),
                  label: t('todayToken'),
                  value: todayFormatted.value,
                  unit: todayFormatted.unitKey === '' ? '' : t(todayFormatted.unitKey),
                }),
                tile({
                  glyph: databaseIcon('1em', EMERALD),
                  label: t('cacheHit'),
                  value: (metrics.cacheHitRate * 100).toFixed(1) + '%',
                  extra: ring(metrics.cacheHitRate),
                }),
                tile({
                  glyph: icon('1em', INDIGO, ICON_LAYERS),
                  label: t('inputToken'),
                  value: input.value,
                  unit: input.unitKey === '' ? '' : t(input.unitKey),
                }),
              ),
            ),
          ),
        ),
      )
    }

    /** A finite number, or the fallback. */
    function numberOr(value, fallback) {
      return typeof value === 'number' && Number.isFinite(value) ? value : fallback
    }

    /**
     * Register the card into the sidebar's additive footer seat.
     * @param ctx - the client plugin context.
     */
    function apply(ctx) {
      ctx.effect(() => installStyles(), 'token-hud: styles')
      ctx.effect(
        () => ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action',
          id: 'token-hud',
          order: 10,
        }, TokenHud)),
        'token-hud: sidebar block',
      )
    }

    exports.name = 'token-hud'
    exports.apply = apply
    exports.inject = ['slots']
    return module.exports
  },
})
