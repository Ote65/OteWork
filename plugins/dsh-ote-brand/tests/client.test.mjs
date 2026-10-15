/**
 * dsh-ote-brand browser-half checks.
 *
 * The bundle is a browser script, so it is loaded here through a `new Function`
 * with a stubbed `window`/`document`/`MutationObserver`. That covers what a
 * unit test honestly can: the bundle's shape, the three seat registrations and
 * their shadowing priority, the stylesheet and its reload lifecycle, the mark's
 * geometry, and the hero-copy rewrite (including the rerender path).
 *
 * What it does NOT cover is the rendered pixels — see README.md for the manual
 * check.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assert, createSuite, equal, includes } from './harness.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const clientPath = join(here, '..', 'lib', 'client.js')

/** Seeded modules the bundle may require. */
const TABLE = new Set(['react'])

/** The hero headline cell selector this half watches. */
const HERO_TITLE_SELECTOR = '[class*="_titleGroup"] > span:first-child'

/** The copy the skin installs. */
const HERO_COPY = '让构想皆成现实'

/** The wordmark the skin installs. */
const BRAND_NAME = 'OTE Work'

/** The style element marker. */
const STYLE_TAG = 'dsh-ote-brand/skin.css'

/** A DOM element stand-in with the surface the bundle touches. */
function makeElement(tag) {
  const node = {
    tag,
    parentNode: null,
    children: [],
    dataset: {},
    textContent: '',
    connected: false,
    get isConnected() {
      return node.connected
    },
    appendChild(child) {
      child.parentNode = node
      child.connected = true
      node.children.push(child)
      return child
    },
    removeChild(child) {
      const index = node.children.indexOf(child)
      if (index >= 0) node.children.splice(index, 1)
      child.parentNode = null
      child.connected = false
    },
    remove() {
      if (node.parentNode !== null) node.parentNode.removeChild(node)
    },
  }
  return node
}

/** A headline node whose first child is the text node React keeps. */
function makeHeadline(text) {
  const textNode = { nodeType: 3, nodeValue: text }
  return {
    nodeType: 1,
    isConnected: true,
    firstChild: textNode,
    get textContent() {
      return textNode.nodeValue
    },
  }
}

/** MutationObserver stand-in: records instances so a test can fire them. */
class MutationObserverStub {
  constructor(callback) {
    this.callback = callback
    this.target = null
    this.options = null
    this.disconnected = false
    MutationObserverStub.instances.push(this)
  }

  observe(target, options) {
    this.target = target
    this.options = options
  }

  disconnect() {
    this.disconnected = true
  }

  /** Fire the callback the way the browser would, as a microtask. */
  fire(records = []) {
    this.callback(records, this)
  }
}
MutationObserverStub.instances = []

/**
 * Load the bundle under controllable stubs.
 * @param options - the headline node, an existing document to reuse, and the
 *   React stand-in behaviour.
 */
function loadBundle(options = {}) {
  const source = readFileSync(clientPath, 'utf8')
  const specs = []
  const requires = []
  const injected = []
  const registrations = []
  const disposers = []

  const head = options.head ?? makeElement('head')
  const body = options.body ?? makeElement('body')
  const headline = options.headline ?? null

  const element = (tag) => makeElement(tag)
  const documentStub = {
    head,
    body,
    createElement: element,
    querySelector(selector) {
      const styleMatch = /^style\[data-plugin-css="([^"]+)"\]$/.exec(selector)
      if (styleMatch !== null) {
        return head.children.find((node) => node.dataset.pluginCss === styleMatch[1]) ?? null
      }
      if (selector === HERO_TITLE_SELECTOR) return headline
      return null
    },
  }

  const windowStub = {
    __ModuleLoader__: { load(spec) { specs.push(spec) } },
    setTimeout: () => 0,
    clearTimeout: () => {},
  }
  const reactStub = {
    createElement(type, props, ...children) {
      return { type, props: Object.assign({}, props ?? {}, { children: children.length <= 1 ? children[0] : children }) }
    },
  }

  // A controllable clock, so the headline-lookup backoff is testable.
  const clock = { value: options.now ?? 1_000_000 }
  const dateStub = { now: () => clock.value }

  // eslint-disable-next-line no-new-func -- the bundle is a browser script.
  const locationStub = { href: 'https://dsh.invalid/' }
  const fetchStub = () => Promise.resolve({ ok: true })
  // eslint-disable-next-line no-new-func -- the bundle is a browser script.
  const run = new Function('window', 'document', 'MutationObserver', 'Date', 'location', 'fetch', source)
  run(windowStub, documentStub, MutationObserverStub, dateStub, locationStub, fetchStub)

  const spec = specs[0]
  const exported = spec.factory((name) => {
    requires.push(name)
    if (TABLE.has(name) !== true) throw new Error(`module table miss: ${name}`)
    return reactStub
  })

  /**
   * Run a registration body, draining the EffectGenerator a nested `inject`
   * returns — the contract brand-official's own row relies on.
   */
  const drain = (value) => {
    if (value !== null && typeof value === 'object' && typeof value.next === 'function') {
      const collected = []
      for (let step = value.next(); step.done !== true; step = value.next()) collected.push(drain(step.value))
      return collected
    }
    return value
  }

  const ctx = {
    effect(body_, label) {
      void label
      const dispose = body_()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
    slots: {
      inject(name, body_) {
        injected.push(name)
        return drain(body_())
      },
      register(registration, Component) {
        registrations.push({ registration, Component })
        return () => {}
      },
    },
  }
  exported.apply(ctx)

  return { spec, exported, react: reactStub, requires, injected, registrations, head, body, disposers, documentStub, headline, clock }
}

/**
 * Run the browser suite.
 * @param report - the shared reporter.
 */
export async function run(report) {
  const suite = createSuite('client')

  suite.check('bundle loads under its own id and requires only seeded modules', () => {
    const bundle = loadBundle()
    equal(bundle.spec.id, 'dsh-ote-brand', 'bundle id')
    equal(bundle.requires.join(','), 'react', 'requires')
    for (const name of bundle.requires) assert(TABLE.has(name), `unexpected require: ${name}`)
  })

  suite.check('exports the Cordis plugin surface', () => {
    const { exported } = loadBundle()
    equal(typeof exported.apply, 'function', 'apply')
    equal(exported.inject.join(','), 'slots', 'inject')
  })

  suite.check('takes all three brand seats, at the shadowing priority', () => {
    const { injected, registrations } = loadBundle()
    equal(injected.join(','), 'sidebar.brand.mark,sidebar.brand.name,conversation.hero.brand.mark', 'injected seats')
    equal(registrations.length, 3, 'three registrations')
    const names = registrations.map((entry) => entry.registration.name)
    equal(names.join(','), 'sidebar.brand.mark,sidebar.brand.name,conversation.hero.brand.mark', 'seat names')
    for (const entry of registrations) {
      // A `single` seat rejects a same-priority duplicate of the official
      // occupant, and the registry renders the LOWEST priority — so shadowing
      // the shipped brand row needs a lower number, never a disable.
      equal(entry.registration.priority, -1, `${entry.registration.name} priority`)
    }
  })

  suite.check('installs one stylesheet and removes it on dispose', () => {
    const bundle = loadBundle()
    equal(bundle.head.children.length, 1, 'installed')
    equal(bundle.head.children[0].dataset.pluginCss, STYLE_TAG, 'tagged')
    includes(bundle.head.children[0].textContent, '--dsh-ote-mark:url("data:image/png;base64,', 'embeds the mark')
    includes(bundle.head.children[0].textContent, '_previewBadge"]{display:none !important;}', 'drops the preview pill')
    includes(bundle.head.children[0].textContent, 'background-color:currentColor', 'the mask paints in that colour')
    for (const dispose of bundle.disposers) dispose()
    equal(bundle.head.children.length, 0, 'removed')
  })

  suite.check('a stale generation cannot strip the live stylesheet', () => {
    const head = makeElement('head')
    const first = loadBundle({ head })
    equal(first.head.children.length, 1, 'first sheet installed')
    const second = loadBundle({ head })
    equal(second.head.children.length, 1, 'the reload replaced it, one sheet live')
    first.disposers[0]()
    equal(second.head.children.length, 1, 'the stale disposer left the live sheet alone')
    second.disposers[0]()
    equal(second.head.children.length, 0, 'the live disposer removed it')
  })

  suite.check('the embedded mark is a real PNG and MARK_RATIO matches it', () => {
    const source = readFileSync(clientPath, 'utf8')
    const match = /var MARK_URL = 'data:image\/png;base64,([A-Za-z0-9+/=]+)'/.exec(source)
    assert(match !== null, 'the generated block holds a base64 PNG')
    const png = Buffer.from(match[1], 'base64')
    equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'PNG signature')
    const width = png.readUInt32BE(16)
    const height = png.readUInt32BE(20)
    assert(width > 0 && height > 0, `decodable size ${width}x${height}`)
    const ratio = Number(/var MARK_RATIO = ([0-9.]+) \/ ([0-9.]+)/.exec(source)[1]) /
      Number(/var MARK_RATIO = ([0-9.]+) \/ ([0-9.]+)/.exec(source)[2])
    assert(Math.abs(ratio - height / width) < 0.0005, `MARK_RATIO ${ratio} vs artwork ${height / width}`)
  })

  suite.check('renders the mark 32% over the seat size, keeping the seat class', () => {
    const { registrations } = loadBundle()
    const Mark = registrations.find((entry) => entry.registration.name === 'sidebar.brand.mark').Component
    const small = Mark({ size: 24 })
    equal(small.props.className, 'dsh-ote-mark', 'class')
    equal(small.props.style.width, '31.68px', 'the owner asked for +10% then +20% more')
    equal(small.props.style.height, '26.79px', 'height follows the artwork ratio')
    equal(small.props['aria-label'], BRAND_NAME, 'accessible name')
    const hero = Mark({ size: 34, className: 'HeroShell_fish' })
    equal(hero.props.className, 'dsh-ote-mark HeroShell_fish', 'the seat class is preserved')
    equal(hero.props.style.width, '44.88px', 'hero width')
    equal(hero.props.style.height, '37.96px', 'hero height')
    equal(Mark({}).props.style.width, '31.68px', 'defaults to the sidebar size')
  })

  suite.check('unpins the brand row so the taller mark is not cropped', () => {
    const { head } = loadBundle()
    const css = head.children[0].textContent
    // The row pins a 24px identity and hides its overflow; a 26.79px mark would
    // lose the star's points without these. Each is scoped with :has() to a row
    // that actually holds this mark, so nothing else in the shell is touched.
    includes(css, '[class*="_logoRow"]:has(.dsh-ote-mark){overflow:visible;}', 'the row stops hiding overflow')
    includes(css, '[class*="_brand"]:has(.dsh-ote-mark){overflow:visible;}', 'the brand button stops cropping')
    includes(css, '[class*="_brandIdentity"]:has(.dsh-ote-mark){height:auto;}', 'the identity grows to the mark')
    equal(css.includes('_railMark'), false, 'the collapsed rail is left alone: its 28px button paints the mark uncropped')
  })

  suite.check('renders the OTE Work wordmark as outlined artwork', () => {
    const { registrations } = loadBundle()
    const Name = registrations.find((entry) => entry.registration.name === 'sidebar.brand.name').Component
    const element = Name()
    equal(element.type, 'svg', 'an svg')
    equal(element.props.className, 'dsh-ote-name', 'class')
    equal(element.props['aria-hidden'], 'true', 'decorative: the mark carries the name')
    equal(element.props.height, 13, 'ink height in the 24px brand row')
    // 13px ink over the outlined ink box (4264 x 677 font units).
    const ink = /var WORDMARK = \{ width: ([0-9.]+), height: ([0-9.]+),/.exec(readFileSync(clientPath, 'utf8'))
    assert(ink !== null, 'the generated wordmark block is present')
    const expected = Math.round((13 * Number(ink[1])) / Number(ink[2]) * 100) / 100
    equal(element.props.width, expected, 'width follows the outlined ink ratio')
    equal(element.props.viewBox, `0 0 ${ink[1]} ${ink[2]}`, 'viewBox is the ink box')
    const path = element.props.children
    equal(path.type, 'path', 'one path')
    equal(path.props.fill, 'currentColor', 'inherits the seat colour')
    assert(path.props.d.length > 500, `the outline is real artwork (${path.props.d.length} chars)`)
    assert(/^M[0-9. -]+[A-Z]/.test(path.props.d), 'the path starts a real subpath')
  })

  suite.check('the outlined wordmark is a self-contained path set', () => {
    const source = readFileSync(clientPath, 'utf8')
    const block = /var WORDMARK = \{ width: ([0-9.]+), height: ([0-9.]+), path: '([^']+)' \};/.exec(source)
    assert(block !== null, 'the generated block parses')
    // At least one subpath per inked glyph, and counters add more: "OTE Work"
    // has 7 inked glyphs, several of them with a counter.
    const subpaths = block[3].match(/M/g) ?? []
    assert(subpaths.length >= 7, `subpaths for every glyph (${subpaths.length})`)
    assert(/['"\\]/.test(block[3]) === false, 'the outline has no quote or backslash to escape')
    assert(/[^A-Za-z0-9 .,'-]/.test(block[3]) === false, 'the outline is only path syntax')
  })

  suite.check('paints the mark in the artwork colour, never a colour of its own', () => {
    const { head } = loadBundle()
    const css = head.children[0].textContent
    const rule = css.slice(css.indexOf('.dsh-ote-mark{'), css.indexOf('.dsh-ote-name{'))
    includes(rule, 'color:inherit;', 'the mark inherits the shell label colour')
    includes(rule, 'background-color:currentColor;', 'the mask paints in that colour')
    includes(rule, '-webkit-mask-size:contain;mask-size:contain;}', 'the mask properties end the rule')
    // The artwork is black line art and measures ~0.56 CSS px per stroke here, so a
    // white ink makes the mark vanish over a pale sidebar. Nothing may pin it.
    equal(/#fff|rgb\(255/.test(rule), false, 'no white ink')
    equal(/filter:/.test(rule), false, 'no filter bolted onto the mark either')
  })

  suite.check('styles the white wordmark with the gentle shadow in both themes', () => {
    const { head } = loadBundle()
    const css = head.children[0].textContent
    includes(css, '.dsh-ote-name{display:block;flex:none;overflow:visible;color:#fff;', 'the wordmark box, in white')
    // A drop-shadow follows the outlined letterforms; text-shadow would not.
    includes(css, 'filter:drop-shadow(0 1px 1.2px rgba(15,15,22,.5))', 'light: the tight edge')
    includes(css, 'drop-shadow(0 2px 5px rgba(15,15,22,.22))', 'light: the soft pass')
    includes(css, 'html[data-ds-dark-theme] .dsh-ote-name{', 'the dark theme gets its own shadow')
    includes(css, 'drop-shadow(0 1px 1.6px rgba(0,0,0,.6))', 'dark: the tight edge')
    includes(css, 'drop-shadow(0 0 6px rgba(255,255,255,.16))', 'dark: the faint rim')
    equal(css.includes('text-shadow'), false, 'no boxy text-shadow anywhere')
  })

  suite.check('rewrites the hero headline on apply', () => {
    const headline = makeHeadline('探索未至之境')
    loadBundle({ headline })
    equal(headline.firstChild.nodeValue, HERO_COPY, 'headline replaced')
  })

  suite.check('re-applies the headline after a locale switch', () => {
    const headline = makeHeadline('探索未至之境')
    const bundle = loadBundle({ headline })
    const observer = MutationObserverStub.instances.at(-1)
    assert(observer !== undefined, 'a headline observer was installed')
    equal(observer.target, bundle.body, 'watching the document body')
    equal(observer.options.subtree, true, 'subtree')
    equal(observer.options.characterData, true, 'characterData, so React text updates are seen')
    // React swaps the dictionary text; the skin has to put its copy back.
    headline.firstChild.nodeValue = 'Into the Unknown'
    observer.fire()
    equal(headline.firstChild.nodeValue, HERO_COPY, 'copy restored')
  })

  suite.check('a headline that leaves the document is re-resolved, then backed off', () => {
    const stale = makeHeadline('探索未至之境')
    stale.isConnected = false
    const live = makeHeadline('探索未至之境')
    let served = stale
    const bundle = loadBundle({ headline: stale })
    const observer = MutationObserverStub.instances.at(-1)
    // The cached node left the document; the next lookup finds the remounted one.
    bundle.documentStub.querySelector = (selector) => (selector === HERO_TITLE_SELECTOR ? served : null)
    served = live
    bundle.clock.value += 1000
    observer.fire()
    equal(live.firstChild.nodeValue, HERO_COPY, 'the remounted headline was rewritten')
    // A miss inside the backoff window must not scan the document again.
    let lookups = 0
    bundle.documentStub.querySelector = () => { lookups += 1; return null }
    live.isConnected = false
    observer.fire()
    observer.fire()
    equal(lookups, 0, 'lookups are rate limited')
    // …and a later batch scans again, so a hero that mounts during a burst of
    // transcript mutations is still picked up.
    bundle.clock.value += 1000
    observer.fire()
    equal(lookups, 1, 'the backoff expires')
  })

  suite.check('dispose stops watching', () => {
    const headline = makeHeadline('探索未至之境')
    const bundle = loadBundle({ headline })
    const observer = MutationObserverStub.instances.at(-1)
    for (const dispose of bundle.disposers) dispose()
    equal(observer.disconnected, true, 'observer disconnected')
  })

  suite.check('no hero copy is attempted while the hero is absent', () => {
    const bundle = loadBundle({ headline: null })
    // Nothing to assert in the DOM; the important part is that apply survives a
    // missing hero (the first screen of an empty profile) without throwing.
    equal(bundle.registrations.length, 3, 'seats still taken')
  })

  report(suite)
}
