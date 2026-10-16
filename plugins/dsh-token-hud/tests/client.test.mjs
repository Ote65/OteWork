/** Browser-half checks: bundle shape, sidebar registration, rendering, units. */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assert, close, createSuite, equal } from './harness.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const clientPath = join(here, '..', 'lib', 'client.js')

/** The browser module table's seeds this bundle is allowed to require. */
const TABLE = new Set(['react', 'react/jsx-runtime'])

/** A payload shaped exactly like the host route's answer. */
const PAYLOAD = {
  ok: true,
  display: { enabled: true, intervalMs: 5000 },
  sessions: 3,
  total: { tokens: 5_338_602_801, uncachedInput: 72_124_530, output: 14_077_631, cacheRead: 5_252_400_640, cacheWrite: 0 },
  today: { tokens: 451_244_949, requests: 1394, peak: 0, off: 0, uncachedInput: 4_531_641, cacheRead: 445_580_416, output: 1_132_892, date: '2026-10-14', cacheHitRate: 0.989 },
  yesterday: { tokens: 1_030_645_331, requests: 4324, date: '2026-10-13' },
  trendPercentage: -56.2,
  cacheHitRate: 0.986,
}

/**
 * A React stand-in that records effects and lets a test seed hook state.
 * The setters really update their cell, so a test can drive a handler and read
 * the state it produced without needing a renderer.
 * @param stateQueue - values handed to successive `useState` calls; `undefined`
 * means "use that hook's own initial value".
 * @returns the fake React module.
 */
function makeReact(stateQueue) {
  const effects = []
  const states = []
  return {
    effects,
    states,
    createElement(type, props, ...children) {
      const merged = Object.assign({}, props ?? {})
      merged.children = children.length === 0 ? undefined : children.length === 1 ? children[0] : children
      return { type, props: merged }
    },
    useState(initial) {
      const seeded = stateQueue.length > 0 ? stateQueue.shift() : undefined
      const cell = { value: seeded === undefined ? initial : seeded }
      states.push(cell)
      return [
        cell.value,
        (next) => {
          cell.value = typeof next === 'function' ? next(cell.value) : next
        },
      ]
    },
    useEffect(body) {
      effects.push(body)
    },
    useRef(initial) {
      return { current: initial }
    },
  }
}

/**
 * Execute the bundle and return everything a check needs.
 * @param options - state seed, locale and fetch stand-in.
 * @returns the loaded bundle's spec, exports, registrations and fakes.
 */
function loadBundle(options = {}) {
  const source = readFileSync(clientPath, 'utf8')
  const specs = []
  const requires = []
  const timeouts = []
  const injected = []
  const registrations = []
  const react = makeReact(options.stateQueue ?? [])
  const head = {
    children: [],
    appendChild(node) {
      this.children.push(node)
      node.parentNode = this
    },
    removeChild(node) {
      const index = this.children.indexOf(node)
      if (index >= 0) this.children.splice(index, 1)
      node.parentNode = null
    },
  }
  const documentStub = {
    documentElement: { lang: options.lang ?? 'zh-CN' },
    head,
    createElement(tag) {
      return { tag, id: '', textContent: '', parentNode: null }
    },
    getElementById(id) {
      return head.children.find((node) => node.id === id) ?? null
    },
  }
  const windowStub = { __ModuleLoader__: { load(spec) { specs.push(spec) } } }
  const fetchStub = options.fetch ?? (() => Promise.resolve({ ok: true, json: () => Promise.resolve(null) }))
  const setTimeoutStub = (body, ms) => {
    timeouts.push(ms)
    return timeouts.length
  }
  const store = options.store ?? new Map()
  const localStorageStub = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, String(value)) },
  }

  // eslint-disable-next-line no-new-func -- the bundle is a browser script.
  const run = new Function('window', 'document', 'fetch', 'setTimeout', 'clearTimeout', 'localStorage', source)
  run(windowStub, documentStub, fetchStub, setTimeoutStub, () => {}, localStorageStub)

  const spec = specs[0]
  const exported = spec.factory((name) => {
    requires.push(name)
    if (TABLE.has(name) === false) throw new Error(`module table miss: ${name}`)
    return react
  })

  const disposers = []
  const ctx = {
    effect(body) {
      const dispose = body()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
    slots: {
      inject(name, body) {
        injected.push(name)
        return body()
      },
      register(registration, Component) {
        registrations.push({ registration, Component })
        return () => {}
      },
    },
  }
  exported.apply(ctx)

  return { source, spec, exported, react, requires, timeouts, injected, registrations, head, disposers, store }
}

/**
 * Find the first node carrying one `data-dsh-token-hud` marker.
 * @param node - the rendered node.
 * @param marker - the marker value to match.
 * @returns the node, or null.
 */
function findByMarker(node, marker) {
  if (node === null || node === undefined || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findByMarker(child, marker)
      if (found !== null) return found
    }
    return null
  }
  if (node.props?.['data-dsh-token-hud'] === marker) return node
  return findByMarker(node.props?.children, marker)
}

/**
 * Every string in a rendered tree, in order.
 * @param node - the rendered node.
 * @param out - accumulator.
 * @returns the strings.
 */
function textsOf(node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) textsOf(child, out)
    return out
  }
  if (typeof node === 'object' && node.props !== undefined) {
    textsOf(node.props.children, out)
    return out
  }
  return out
}

/**
 * Collect `data-dsh-token-hud` markers in render order.
 * @param node - the rendered node.
 * @param out - accumulator.
 * @returns the marker list.
 */
function markersOf(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) markersOf(child, out)
    return out
  }
  const marker = node.props?.['data-dsh-token-hud']
  if (typeof marker === 'string') out.push(marker)
  markersOf(node.props?.children, out)
  return out
}

/**
 * Render the card with one seeded payload.
 * @param options - payload, locale, translator, unit, collapsed and slot props.
 * @returns the bundle and the rendered element.
 */
function render(options = {}) {
  const queue = [
    options.payload === undefined ? PAYLOAD : options.payload,
    options.collapsed,
  ]
  const bundle = loadBundle({ stateQueue: queue, lang: options.lang, store: options.store })
  const Component = bundle.registrations[0].Component
  const element = Component(Object.assign({ t: options.t }, options.props))
  return { bundle, element }
}

/**
 * Run the browser suite.
 * @param report - the shared reporter.
 */
export async function run(report) {
  const suite = createSuite('client')

  suite.check('bundle loads through the module loader under its own id', () => {
    const { spec } = loadBundle()
    equal(spec.id, 'dsh-token-hud', 'bundle id')
    equal(typeof spec.factory, 'function', 'factory')
  })

  suite.check('requires nothing outside the seeded module table', () => {
    const { requires } = loadBundle()
    assert(requires.length > 0, 'requires react')
    for (const name of requires) assert(TABLE.has(name), `unexpected require: ${name}`)
  })

  suite.check('exports the Cordis plugin surface', () => {
    const { exported } = loadBundle()
    equal(exported.name, 'token-hud', 'name')
    equal(typeof exported.apply, 'function', 'apply')
    equal(exported.inject.join(','), 'slots', 'inject')
  })

  suite.check('registers into the sidebar footer seat, not a floating layer', () => {
    const { injected, registrations } = loadBundle()
    equal(injected.join(','), 'sidebar.footer.action', 'injected slot')
    equal(registrations.length, 1, 'one registration')
    const spec = registrations[0].registration
    equal(spec.name, 'sidebar.footer.action', 'slot name')
    equal(spec.id, 'token-hud', 'cell id')
    equal(spec.order, 10, 'order')
  })

  suite.check('is an in-flow sidebar block, not a fixed-position popup', () => {
    const { element } = render()
    equal(element.props['data-dsh-token-hud'], 'block', 'marker attribute')
    equal(element.props.style.position, undefined, 'no fixed positioning')
    equal(element.props.style.top, undefined, 'no top offset')
    equal(element.props.style.left, undefined, 'no left offset')
    const card = findByMarker(element, 'card')
    assert(card !== null, 'the card child is rendered')
    equal(card.props.style.position, undefined, 'card is in flow')
    equal(card.props.style.background, undefined, 'card fill lives in the stylesheet')
    equal(card.props.style.border, undefined, 'card rim lives in the stylesheet')
  })

  suite.check('spans the full sidebar width, like the session rows above it', () => {
    const { element } = render()
    const style = element.props.style
    equal(style.boxSizing, 'border-box', 'border-box sizing')
    assert(String(style.flex).startsWith('0 0'), `must not shrink: ${style.flex}`)
    // The column pads by --dsh-sidebar-inline-padding; the block cancels that on
    // both sides and insets its card by 8px inside the rail.
    assert(String(style.width).includes('100%'), `width grows past the padded row: ${style.width}`)
    equal((String(style.width).match(/--dsh-sidebar-inline-padding/g) ?? []).length, 2, 'both paddings added back')
    equal(String(style.marginLeft), 'calc(-1 * var(--dsh-sidebar-inline-padding, 12px))', 'left bleed')
    equal(String(style.marginRight), 'calc(-1 * var(--dsh-sidebar-inline-padding, 12px))', 'right bleed')
    equal(String(style.padding), '8px 8px 10px', 'card inset')
  })

  suite.check('the card wears an orange rim over a layered shadow', () => {
    const { head } = loadBundle()
    const css = head.children[0].textContent
    const card = css.slice(css.indexOf('[data-dsh-token-hud="card"]'))
    // The rim is the owner's Oltra orange; the shadow stacks a contact layer,
    // a deep drop and an orange bloom for depth.
    assert(card.includes('border:1px solid color-mix(in srgb,#ff5a1f 55%,transparent);'), `rim must be orange: ${card}`)
    assert(card.includes('box-shadow:0 1px 2px rgba(0,0,0,.18),0 12px 28px -14px rgba(0,0,0,.5),0 0 22px -10px rgba(255,90,31,.45);'), `shadow must layer three levels: ${card}`)
    assert(card.includes('border-radius:2em'), 'corner radius scales with the base')
    assert(css.includes('[data-dsh-token-hud="tile"]{'), 'tiles carry their own rim too')
  })

  suite.check('scales as one layout: a single em base drives every dimension', () => {
    const { element } = render()
    equal(element.props.style.containerType, 'inline-size', 'block is the query container')
    const base = String(findByMarker(element, 'card').props.style.fontSize)
    assert(base.startsWith('clamp('), `legibility clamp: ${base}`)
    assert(base.includes('cqw'), `width budget from the rail: ${base}`)
    assert(base.includes('vh'), `height budget from the window: ${base}`)

    const card = findByMarker(element, 'card')
    equal(card.props.style.padding, '1.2em 1.2em 1.1em', 'card padding is relative')
    const [hero, details] = card.props.children
    equal(hero.props.style.marginBottom, '1em', 'hero gap')
    const [hairline, grid] = details.props.children.props.children
    equal(hairline.props.style.height, 1, 'the hairline stays a real pixel')
    equal(grid.props.style.gap, '0.7em', 'tile gap')
    equal(findByMarker(element, 'tile').props.style.padding, '0.6em 0.7em', 'tile padding')

    // Anything pinned to a raw pixel inside the card would not scale with the
    // base; only the 1px divider is allowed to be absolute.
    const prefixes = ['fontSize', 'gap', 'margin', 'padding', 'width', 'height']
    const pinned = []
    const walk = (node) => {
      if (node === null || node === undefined || typeof node !== 'object') return
      if (Array.isArray(node)) {
        for (const child of node) walk(child)
        return
      }
      for (const [key, value] of Object.entries(node.props?.style ?? {})) {
        if (prefixes.some((prefix) => key.startsWith(prefix)) === false) continue
        if (typeof value === 'number' || /^\d+(\.\d+)?px$/.test(String(value))) pinned.push(`${key}:${value}`)
      }
      walk(node.props?.children)
    }
    walk(card)
    equal(pinned.join(','), 'height:1', `only the hairline is absolute: ${pinned.join(',')}`)
  })

  suite.check('keeps a strict hierarchy: hero > unit > value > label', () => {
    const { element } = render()
    const sizes = new Map()
    const walk = (node) => {
      if (node === null || node === undefined || typeof node !== 'object') return
      if (Array.isArray(node)) {
        for (const child of node) walk(child)
        return
      }
      const style = node.props?.style
      const text = node.props?.children
      if (style !== undefined && typeof style.fontSize === 'string' && typeof text === 'string') {
        sizes.set(text, Number.parseFloat(style.fontSize))
      }
      walk(node.props?.children)
    }
    walk(element)
    const hero = sizes.get('53.39')
    const value = sizes.get('4.51')
    const label = sizes.get('今日 Token')
    // '亿' appears on both the hero and the input tile, so read the hero's own
    // unit off the tree rather than out of the text-keyed map.
    const card = findByMarker(element, 'card')
    const heroRow = card.props.children[0].props.children[1]
    const unit = Number.parseFloat(heroRow.props.children[1].props.style.fontSize)
    equal(hero, 3, 'hero number')
    equal(unit, 1.4, 'hero unit')
    equal(value, 1.35, 'tile value')
    equal(label, 0.95, 'tile label')
    assert(hero > unit && unit > value && value > label, `strict hierarchy: ${hero} > ${unit} > ${value} > ${label}`)
  })

  suite.check('injects one stylesheet with the scoped wrap rule and the card material', () => {
    const { head } = loadBundle()
    equal(head.children.length, 1, 'one stylesheet')
    const style = head.children[0]
    equal(style.id, 'dsh-token-hud-style', 'style id')
    assert(style.textContent.includes(':has(> [data-dsh-token-hud="block"])'), `scoped to this block: ${style.textContent}`)
    assert(style.textContent.includes('flex-wrap:wrap'), `wraps the row: ${style.textContent}`)
    assert(style.textContent.includes('color-mix('), 'theme-derived translucent fill')
    assert(style.textContent.includes('backdrop-filter'), 'frosted material')
    assert(style.textContent.includes(':hover'), 'hover raises the surface')
    assert(style.textContent.includes('prefers-reduced-motion'), 'motion is opt-out')
  })

  suite.check('lays out the design: hero, collapsible detail block', () => {
    const { element } = render()
    equal(
      markersOf(element).join(' > '),
      'block > card > trend > details > tile > tile > ring > tile',
      'marker order',
    )
    const card = findByMarker(element, 'card')
    const [hero, details] = card.props.children
    equal(hero.props.children.length, 3, 'hero: label row, number row, sub-line')
    const [hairline, grid] = details.props.children.props.children
    equal(hairline.props.style.height, 1, 'hairline divider, inside the collapsible block')
    equal(grid.props.children.length, 3, 'three metric tiles')
    equal(grid.props.style.gridTemplateColumns, 'repeat(3, minmax(0, 1fr))', 'three-up grid')
  })

  suite.check('tiles are label + value only, on the theme raised surface', () => {
    const { element, bundle } = render()
    const grid = findByMarker(element, 'details').props.children.props.children[1]
    for (const tile of grid.props.children) {
      const row = tile.props.children
      equal(row.props.style.alignItems, 'center', 'the text column and the ring share one row')
      const body = row.props.children[0]
      equal(body.props.style.flexDirection, 'column', 'label and value stack in a column')
      const rows = body.props.children.filter((child) => child !== null && child !== undefined)
      equal(rows.length, 2, 'label row + value row, no caption line')
      equal(rows[0].props.style.marginBottom, '0.2em', 'label sits tight above the value')
    }
    const cacheRow = grid.props.children[1].props.children
    const ring = cacheRow.props.children[1]
    equal(ring.props['data-dsh-token-hud'], 'ring', 'the ring sits beside the text column')
    equal(ring.props.style.width, '3.4em', 'the ring is a fixed square beside the text')
    equal(ring.props.style.height, '3.4em', 'it matches the text column height without feeding back')
    const css = bundle.head.children[0].textContent
    const tile = css.slice(css.indexOf('[data-dsh-token-hud="tile"]{'))
    assert(tile.includes('background:var(--dsw-alias-bg-layer-1'), `solid raised fill, not a tint: ${tile}`)
    assert(tile.includes('border:1px solid'), 'the tiles keep their rim')
    assert(tile.includes('border-radius:1.1em'), 'radius scales with the card')
  })

  suite.check('collapses into one summary line, keeping the totals in view', () => {
    const { element } = render({ collapsed: true })
    const card = findByMarker(element, 'card')
    const details = card.props.children[1]
    equal(details.props['data-collapsed'], 'true', 'details marked collapsed')
    equal(details.props.style.gridTemplateRows, '0fr', 'the grid row animates shut')
    equal(details.props.style.opacity, 0, 'and fades out')
    equal(details.props.style.pointerEvents, 'none', 'and stops taking clicks')
    equal(details.props['aria-hidden'], 'true', 'and leaves the a11y tree')

    const text = textsOf(element).join(' | ')
    assert(text.includes('今日: '), `today label in the summary: ${text}`)
    assert(text.includes('4.51亿'), `today value in the summary: ${text}`)
    assert(text.includes('缓存率: '), `cache label in the summary: ${text}`)
    assert(text.includes('98.6%'), `cache value in the summary: ${text}`)
    assert(text.includes('节约 52.52亿'), `saved tokens in the summary: ${text}`)
    assert(text.includes('累计') === false, `the trend line is replaced: ${text}`)
    equal(findByMarker(element, 'trend'), null, 'no trend chip while collapsed')
  })

  suite.check('expands back to the trend line and the detail block', () => {
    const { element } = render()
    const details = findByMarker(element, 'card').props.children[1]
    equal(details.props['data-collapsed'], 'false', 'details expanded')
    equal(details.props.style.gridTemplateRows, '1fr', 'row track open')
    equal(details.props.style.pointerEvents, undefined, 'interactive')
    equal(details.props['aria-hidden'], undefined, 'in the a11y tree')
    const text = textsOf(element).join(' | ')
    assert(text.includes('-56.2%'), `trend chip back: ${text}`)
    equal(findByMarker(element, 'summary'), null, 'no summary while expanded')
  })

  suite.check('the card itself is the only control; header and unit switch are gone', () => {
    const { element, bundle } = render()
    equal(findByMarker(element, 'unit'), null, 'the unit switch is gone')
    equal(findByMarker(element, 'hint'), null, 'the hint button is gone')
    assert(typeof findByMarker(element, 'card').props.onClick === 'function', 'the card toggles')
    const text = textsOf(element).join(' ')
    assert(text.includes('单位') === false, `no unit label remains: ${text}`)
    assert(text.includes('轻点') === false, `no hint strings remain: ${text}`)
    const css = bundle.head.children[0].textContent
    assert(css.includes('[data-dsh-token-hud="unit"]') === false, 'no unit rules left in the sheet')
  })

  suite.check('remembers the collapse choice in local storage', () => {
    const bundle = loadBundle({ stateQueue: [PAYLOAD] })
    const element = bundle.registrations[0].Component({ wide: true })
    equal(bundle.react.states[1].value, false, 'starts expanded')
    findByMarker(element, 'card').props.onClick()
    equal(bundle.react.states[1].value, true, 'the card collapsed it')
    equal(bundle.store.get('dsh-token-hud:collapsed'), '1', 'and remembered it')
    findByMarker(element, 'card').props.onClick()
    equal(bundle.react.states[1].value, false, 'and opens again')
    equal(bundle.store.get('dsh-token-hud:collapsed'), '0', 'and remembered that too')
  })

  suite.check('removes its stylesheet on dispose', () => {
    const bundle = loadBundle()
    equal(bundle.head.children.length, 1, 'installed')
    const disposers = bundle.disposers ?? []
    for (const dispose of disposers) dispose()
    equal(bundle.head.children.length, 0, 'removed')
  })

  suite.check('renders nothing in the collapsed rail', () => {
    const { element } = render({ props: { wide: false } })
    equal(element, null, 'rail renders nothing')
  })

  suite.check('renders in the expanded column', () => {
    const { element } = render({ props: { wide: true } })
    assert(element !== null, 'wide renders the card')
  })

  suite.check('renders nothing before the first payload arrives', () => {
    const bundle = loadBundle({ stateQueue: [null] })
    equal(bundle.registrations[0].Component({ wide: true }), null, 'no payload, no card')
  })

  suite.check('honours a disabled display block', () => {
    const payload = Object.assign({}, PAYLOAD, { display: { enabled: false, intervalMs: 20000 } })
    const { element } = render({ payload })
    equal(element, null, 'disabled renders nothing')
  })

  suite.check('formats the hero on the pinned 亿 scale', () => {
    const yi = textsOf(render().element).join(' | ')
    assert(yi.includes('53.39'), `亿 value: ${yi}`)
    assert(yi.includes('亿'), `亿 unit: ${yi}`)
    assert(yi.includes('5338.6') === false, `no million hero without a switch: ${yi}`)
  })

  suite.check('never reaches for a B or T unit', () => {
    const text = textsOf(render().element).join(' | ')
    assert(text.includes('B') === false, `no B unit anywhere: ${text}`)
    assert(text.includes('T') === false || text.includes('Token') || text.includes('TOKEN'), `no T unit: ${text}`)
  })

  suite.check('walks the design scales down to 万 and to a plain count', () => {
    // The today tile and the tooltip both use the `auto` formatter.
    const auto = (todayTokens) => {
      const payload = Object.assign({}, PAYLOAD, {
        today: Object.assign({}, PAYLOAD.today, { tokens: todayTokens }),
        trendPercentage: null,
      })
      return textsOf(render({ payload }).element).join(' | ')
    }
    assert(auto(2_400_000).includes('2.4'), `百万 scale: ${auto(2_400_000)}`)
    assert(auto(2_400_000).includes('百万'), `百万 unit: ${auto(2_400_000)}`)
    const wan = auto(24_000)
    assert(wan.includes('2.4') && wan.includes('万') && wan.includes('百万') === false, `万 scale: ${wan}`)
    assert(auto(9_100).includes('9100'), `plain count below 万: ${auto(9_100)}`)

    const tooltip = render({
      payload: Object.assign({}, PAYLOAD, {
        total: Object.assign({}, PAYLOAD.total, { cacheRead: 24_000 }),
        trendPercentage: null,
      }),
    }).element.props.title
    assert(tooltip.includes('缓存读 2.4万'), `tooltip walks the same scales: ${tooltip}`)

    // A pinned 亿 hero always divides by 10^8, even well below that magnitude.
    const small = Object.assign({}, PAYLOAD, {
      total: Object.assign({}, PAYLOAD.total, { tokens: 2_400_000 }),
      trendPercentage: null,
    })
    assert(textsOf(render({ payload: small }).element).join(' | ').includes('0.02'), 'hero stays on the pinned scale')
  })

  suite.check('shows the labels the design calls for', () => {
    const text = textsOf(render().element).join(' | ')
    assert(text.includes('总消耗'), `hero label: ${text}`)
    assert(text.includes('今日 Token'), `today tile: ${text}`)
    assert(text.includes('命中率'), `cache tile: ${text}`)
    assert(text.includes('输入 Token'), `input tile: ${text}`)
    assert(text.includes('Token 计量') === false, `the title is gone: ${text}`)
  })

  suite.check('maps the host payload onto the design TokenMetrics', () => {
    const text = textsOf(render().element).join(' | ')
    // The hero is the grand total (5,338,602,801 across 222 sessions), not the
    // design's output-only field, so the headline never reads as lost history.
    assert(text.includes('53.39'), `hero total: ${text}`)
    assert(text.includes('累计 5,338,602,801 tokens'), `exact total: ${text}`)
    assert(text.includes('4.51'), `today total tokens: ${text}`)
    assert(text.includes('98.6%'), `cache hit rate: ${text}`)
    assert(text.includes('0.72'), `uncached input tokens: ${text}`)
    // The derived captions are gone from the tiles; they live in the tooltip.
    assert(text.includes('今日占比') === false, `no share caption: ${text}`)
    assert(text.includes('节约') === false, `no saved caption: ${text}`)
    assert(text.includes('输入/输出比') === false, `no io caption: ${text}`)
  })

  suite.check('puts the input/output/cache-read detail in the native tooltip', () => {
    const { element } = render()
    const title = element.props.title
    assert(typeof title === 'string', 'tooltip present')
    assert(title.includes('输入 72.1百万'), `input detail: ${title}`)
    assert(title.includes('输出 14.1百万'), `output detail: ${title}`)
    assert(title.includes('缓存读 52.52亿'), `cache-read detail: ${title}`)
    assert(title.includes('输入/输出比 1:0.2'), `io ratio detail: ${title}`)
  })

  suite.check('renders the trend chip with its direction', () => {
    const down = findByMarker(render().element, 'trend')
    assert(down !== null, 'a falling day still renders a chip')
    assert(textsOf(down).join('').includes('-56.2%'), 'signed value')
    equal(down.props.style.color, '#f43f5e', 'falling uses the rose tone')

    const up = findByMarker(render({ payload: Object.assign({}, PAYLOAD, { trendPercentage: 14.8 }) }).element, 'trend')
    assert(textsOf(up).join('').includes('+14.8%'), 'positive keeps its sign')
    equal(up.props.style.color, '#10b981', 'rising uses the emerald tone')
  })

  suite.check('drops the trend chip and its separator when there is no previous day', () => {
    const { element } = render({ payload: Object.assign({}, PAYLOAD, { trendPercentage: null }) })
    equal(findByMarker(element, 'trend'), null, 'no chip')
    const text = textsOf(element).join(' | ')
    assert(text.includes('累计 5,338,602,801 tokens'), `cumulative still shown: ${text}`)
    assert(text.includes('较昨日') === false, `no orphan label: ${text}`)
    assert((text.match(/·/g) ?? []).length === 0, `no leading separator: ${text}`)
  })

  suite.check('draws the cache ring at the measured ratio', () => {
    const { element } = render()
    const ring = findByMarker(element, 'ring')
    assert(ring !== null, 'ring rendered')
    equal(ring.props.style.width, '3.4em', 'fixed square width')
    equal(ring.props.style.height, '3.4em', 'fixed square height')
    equal(ring.props.style.flex, 'none', 'the ring cannot be squeezed')
    const fill = ring.props.children[1]
    const circumference = 2 * Math.PI * 18
    close(fill.props.strokeDashoffset, circumference * (1 - 0.986), 0.05, 'ring offset')
    equal(fill.props.stroke, '#10b981', 'emerald stroke')
  })

  suite.check('renders a zero hit rate without dividing by zero', () => {
    const payload = Object.assign({}, PAYLOAD, { cacheHitRate: 0, today: Object.assign({}, PAYLOAD.today, { cacheHitRate: 0 }) })
    const { element } = render({ payload })
    const text = textsOf(element).join(' | ')
    assert(text.includes('0.0%'), `zero rate missing: ${text}`)
    equal(findByMarker(element, 'ring').props.children[1].props.strokeDashoffset, 2 * Math.PI * 18, 'empty ring')
  })

  suite.check('survives a payload with missing blocks', () => {
    const { element } = render({ payload: { ok: true } })
    const text = textsOf(element).join(' | ')
    assert(text.includes('0.00'), `zero fallback missing: ${text}`)
    assert(text.includes('0.0%'), `zero rate missing: ${text}`)
  })

  suite.check('falls back to English for a non-Chinese document', () => {
    const { element } = render({ lang: 'en-US' })
    const text = textsOf(element).join(' | ')
    assert(text.includes('All time'), `english hero label missing: ${text}`)
    assert(text.includes('Cache hit rate'), `english tile missing: ${text}`)
  })

  suite.check('prefers the shell translator when one is supplied', () => {
    const { element } = render({ t: (key) => `«${key}»` })
    const text = textsOf(element).join(' | ')
    assert(text.includes('«totalUsage»'), `translator unused: ${text}`)
  })

  await suite.checkAsync('schedules a refresh with the configured interval', async () => {
    const payload = Object.assign({}, PAYLOAD, { display: { enabled: true, intervalMs: 7000 } })
    const bundle = loadBundle({
      stateQueue: [payload],
      fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve(payload) }),
    })
    // The effect only registers once the component renders.
    bundle.registrations[0].Component({ wide: true })
    equal(typeof bundle.react.effects[0], 'function', 'effect registered')
    const cleanup = bundle.react.effects[0]()
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert(bundle.timeouts.includes(7000), `expected a 7000ms timer, got ${JSON.stringify(bundle.timeouts)}`)
    equal(typeof cleanup, 'function', 'effect returns a cleanup')
  })

  report(suite)
}
