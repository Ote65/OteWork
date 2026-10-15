/**
 * Browser-half checks: bundle shape, the browser-title control's lifecycle, the
 * stay-armed pick loop, session-scoped preview resolution, and the injected
 * picker's contract.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assert, createSuite, equal, flush, includes } from './harness.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const clientPath = join(here, '..', 'lib', 'client.js')

/** Seeded modules this bundle may require. */
const TABLE = new Set(['react', 'react-dom'])

/** The browser type's key, i.e. the title chip this plugin takes over. */
const BROWSER_KEY = '@deepseek-ai/dsh-client-ui-sidebar-browser'

/** A descriptor shaped like the injected picker's resolve value. */
const INFO = {
  url: 'http://localhost:5173/',
  tag: 'button',
  id: 'submit',
  classes: ['primary', '_a1b2c3_x'],
  selector: '#app > form > button#submit',
  text: '提交订单',
  box: { x: 320, y: 180, width: 120, height: 36 },
  attrs: { role: 'button', 'aria-label': '提交订单' },
  react: { component: 'CheckoutButton', file: 'http://localhost:5173/src/components/Checkout.tsx', line: 42, column: 5 },
  styles: { display: 'inline-flex', fontSize: '14px' },
}

/**
 * A React stand-in that records effects, hook state and state updates.
 * @param stateQueue - values handed to successive `useState` calls.
 */
function makeReact(stateQueue) {
  const effects = []
  const setters = []
  return {
    effects,
    setters,
    Fragment: Symbol.for('react.fragment'),
    createElement(type, props, ...children) {
      const merged = Object.assign({}, props ?? {})
      merged.children = children.length === 0 ? undefined : children.length === 1 ? children[0] : children
      return { type, props: merged }
    },
    useState(initial) {
      const next = stateQueue.length > 0 ? stateQueue.shift() : initial
      return [next, (value) => { setters.push(value) }]
    },
    useEffect(body) {
      effects.push(body)
    },
    useRef(initial) {
      return { current: initial }
    },
  }
}

/** A react-dom stand-in that records portals. */
function makeReactDom() {
  const portals = []
  return {
    portals,
    createPortal(children, container) {
      const portal = { __portal: true, children, container }
      portals.push(portal)
      return portal
    },
  }
}

/**
 * Load the bundle with controllable fakes.
 * @param options - state seed, locale, preview frames, and per-session scopes.
 */
function loadBundle(options = {}) {
  const source = readFileSync(clientPath, 'utf8')
  const specs = []
  const requires = []
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
    querySelectorAll(selector) {
      return options.frames ?? []
    },
    // Session scoping: `[data-sidebar-right-session="X"]` resolves to that
    // session's right-bar scope, whose own query returns only its frames.
    // `[data-sidebar-right-tab="X"]` resolves to that tab's body, which holds
    // the browser's own `<form>` toolbar.
    querySelector(selector) {
      const sessionMatch = /^\[data-sidebar-right-session="(.+)"\]$/.exec(selector)
      if (sessionMatch !== null) {
        const scope = (options.sessions ?? {})[sessionMatch[1]]
        if (scope === undefined) return null
        return {
          open: scope.open !== false,
          querySelectorAll: () => scope.frames ?? [],
          hasAttribute: (name) => (name === 'data-sidebar-right-open' ? scope.open !== false : false),
        }
      }
      const tabMatch = /^\[data-sidebar-right-tab="(.+)"\]$/.exec(selector)
      if (tabMatch !== null) {
        if (options.toolbar === undefined) return null
        return { querySelector: (inner) => (inner === 'form' ? options.toolbar : null) }
      }
      return null
    },
  }
  const windowStub = { __ModuleLoader__: { load(spec) { specs.push(spec) } } }
  const reactDom = makeReactDom()

  // eslint-disable-next-line no-new-func -- the bundle is a browser script.
  const run = new Function('window', 'document', 'fetch', 'setTimeout', 'clearTimeout', source)
  run(windowStub, documentStub, () => Promise.resolve(null), setTimeout, clearTimeout)

  const spec = specs[0]
  const exported = spec.factory((name) => {
    requires.push(name)
    if (TABLE.has(name) === false) throw new Error(`module table miss: ${name}`)
    return name === 'react-dom' ? reactDom : react
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

  return { spec, exported, react, reactDom, requires, injected, registrations, head, disposers, documentStub }
}

/** A fake `<webview>` whose `executeJavaScript` answers with `answer`. */
function makeFrame(answer, options = {}) {
  const calls = []
  const listeners = new Map()
  return {
    calls,
    isConnected: options.connected ?? true,
    closest: () => options.closest ?? null,
    checkVisibility: () => options.visible !== false,
    getBoundingClientRect() {
      return options.rect ?? { width: 800, height: 600 }
    },
    getTitle: () => options.title ?? 'Example',
    addEventListener(type, handler) {
      listeners.set(type, handler)
    },
    removeEventListener(type) {
      listeners.delete(type)
    },
    executeJavaScript(script, userGesture) {
      calls.push({ script, userGesture })
      if (options.reject === true) return Promise.reject(new Error(options.message ?? 'boom'))
      if (typeof answer === 'function') return answer(script, calls.length)
      // The mode re-arms after every pick, so a fake that always answers would
      // loop forever: answer once, then report a cancel.
      return Promise.resolve(calls.length === 1 ? answer : null)
    },
  }
}

/** Render the control with seeded state and supplied actions. */
function render(options = {}) {
  // The component's last `useState` holds the resolved toolbar; seed it so the
  // portal renders without running effects.
  const seeded = (options.stateQueue ?? ['idle', null, null]).slice()
  const toolbar = options.toolbar === undefined ? { __toolbar: true } : options.toolbar
  const bundle = loadBundle({
    stateQueue: [seeded[0] ?? 'idle', seeded[1] ?? null, seeded[2] ?? null, toolbar],
    frames: options.frames,
    sessions: options.sessions,
    lang: options.lang,
    toolbar: toolbar === null ? undefined : toolbar,
  })
  const Component = bundle.registrations[0].Component
  const element = Component(Object.assign({
    inputActions: options.actions ?? { captureInsertion: () => ({ start: 0, end: 0, draftRev: 7 }), insertText: () => true },
    sessionId: options.sessionId,
    useTabInfo: () => ({ tab: { id: 'tab-1', title: 'localhost' } }),
    t: options.t,
  }, options.props))
  return { bundle, element, Component }
}

/** Collect every string in a rendered tree. */
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
  if (typeof node === 'object' && node.__portal === true) {
    textsOf(node.children, out)
    return out
  }
  if (typeof node === 'object' && node.props !== undefined) {
    textsOf(node.props.children, out)
    return out
  }
  return out
}

/** The portal the component rendered into the browser toolbar, if any. */
function portalOf(element) {
  const children = (element.props ?? {}).children
  if (Array.isArray(children) === false) return undefined
  return children.find((child) => child !== null && child !== undefined && child.__portal === true)
}

/** Find the toggle button inside the toolbar portal. */
function toggleOf(element) {
  const portal = portalOf(element)
  if (portal === undefined) return undefined
  const flat = []
  const walk = (node) => {
    if (node === null || node === undefined) return
    if (Array.isArray(node)) { for (const child of node) walk(child); return }
    if (typeof node !== 'object') return
    if (node.props !== undefined && node.type === 'button') { flat.push(node); return }
    if (node.props !== undefined) walk(node.props.children)
  }
  walk(portal.children)
  return flat.find((node) => (node.props.className ?? '').indexOf('dsh-ep-btn') === 0)
}

/**
 * Run the browser suite.
 * @param report - the shared reporter.
 */
export async function run(report) {
  const suite = createSuite('client')

  suite.check('bundle loads under its own id and requires only seeded modules', () => {
    const bundle = loadBundle()
    equal(bundle.spec.id, 'dsh-element-picker', 'bundle id')
    assert(bundle.requires.length > 0, 'requires react')
    for (const name of bundle.requires) assert(TABLE.has(name), `unexpected require: ${name}`)
  })

  suite.check('exports the Cordis plugin surface', () => {
    const { exported } = loadBundle()
    equal(exported.name, 'element-picker', 'name')
    equal(typeof exported.apply, 'function', 'apply')
    equal(exported.inject.join(','), 'slots', 'inject')
  })

  suite.check("takes over the built-in browser's title chip", () => {
    const { injected, registrations } = loadBundle()
    equal(injected.join(','), 'sidebar.right.pane.tab.title', 'injected slot')
    equal(registrations.length, 1, 'one registration')
    const spec = registrations[0].registration
    equal(spec.name, 'sidebar.right.pane.tab.title', 'slot name')
    equal(spec.key, BROWSER_KEY, 'the browser type key')
    // A keyed Slot rejects a same-priority duplicate of a taken key, so
    // shadowing the shipped title needs a lower priority number.
    equal(spec.priority, -1, 'shadowing priority')
  })

  suite.check('does NOT register anything in the composer toolbar', () => {
    const { injected } = loadBundle()
    for (const name of injected) assert(name.indexOf('conversation.') !== 0, `composer seat used: ${name}`)
  })

  suite.check('injects one stylesheet and removes it on dispose', () => {
    const bundle = loadBundle()
    equal(bundle.head.children.length, 1, 'installed')
    for (const dispose of bundle.disposers) dispose()
    equal(bundle.head.children.length, 0, 'removed')
  })

  suite.check('a reload takes ownership of the stylesheet', () => {
    const first = loadBundle()
    equal(first.head.children.length, 1, 'first sheet installed')
    const stale = first.disposers[0]
    const second = loadBundle()
    equal(second.head.children.length, 1, 'second sheet installed')
    stale()
    equal(second.head.children.length, 1, 'a stale disposer does not strip the live sheet')
  })

  suite.check('re-renders the shipped title so the tab label survives', () => {
    const { element } = render()
    equal(element.type, Symbol.for('react.fragment'), 'a fragment')
    const title = element.props.children[0]
    equal(title.props.className, 'dsh-ep-title', 'title wrapper')
    includes(textsOf(title).join(' '), 'localhost', 'the tab title is kept')
  })

  suite.check('portals the toggle into the browser toolbar, not the chip', () => {
    const { element, bundle } = render()
    const portal = portalOf(element)
    assert(portal !== undefined, 'a portal was rendered')
    equal(portal.container.__toolbar, true, 'into the browser toolbar form')
    equal(bundle.reactDom.portals.length, 1, 'one portal')
    // The chip itself must stay a plain title, with no control in it.
    const title = element.props.children[0]
    equal(toggleOf(element) === undefined, false, 'the toggle lives in the portal')
    const chipButtons = []
    const walk = (node) => {
      if (node === null || node === undefined || typeof node !== 'object') return
      if (node.type === 'button') chipButtons.push(node)
      if (node.props !== undefined) walk(node.props.children)
    }
    walk(title)
    equal(chipButtons.length, 0, 'no button inside the tab chip')
  })

  suite.check('idle toggle is an icon-only toolbar button', () => {
    const { element } = render()
    const toggle = toggleOf(element)
    assert(toggle !== undefined, 'toggle present')
    equal(toggle.props.className, 'dsh-ep-btn', 'class')
    equal(toggle.props['data-armed'], 'false', 'not armed')
    equal(toggle.props['aria-pressed'], false, 'not pressed')
    equal(toggle.props.title, '开启选择元素模式', 'the Trae-style tooltip')
    equal(textsOf(toggle).length, 0, 'icon only, no text label')
  })

  suite.check('armed toggle adds a hint pill beside it', () => {
    const { element } = render({ stateQueue: ['armed', null, null, null] })
    const toggle = toggleOf(element)
    equal(toggle.props['data-armed'], 'true', 'armed')
    equal(toggle.props['aria-pressed'], true, 'pressed')
    const text = textsOf(element).join(' ')
    includes(text, '点击预览中的元素', 'the hint')
    includes(text, 'Esc', 'the escape hint')
  })

  suite.check('a missing toolbar leaves the title intact and renders no portal', () => {
    const { element, bundle } = render({ toolbar: null })
    equal(portalOf(element), undefined, 'no portal yet')
    equal(bundle.reactDom.portals.length, 0, 'nothing portalled')
    includes(textsOf(element).join(' '), 'localhost', 'title still rendered')
  })

  await suite.checkAsync('one pick inserts a reference and keeps the mode armed', async () => {
    let call = 0
    const frame = makeFrame(() => {
      call += 1
      return Promise.resolve(call === 1 ? INFO : null)
    })
    let inserted = null
    const actions = {
      captureInsertion: () => ({ start: 0, end: 0, draftRev: 3 }),
      insertText: (text) => { inserted = text; return true },
    }
    const { element, bundle } = render({ stateQueue: ['idle', null, null], frames: [frame], actions })
    toggleOf(element).props.onClick()
    await flush()
    // The loop deliberately pauses between picks.
    await new Promise((resolve) => setTimeout(resolve, 140))
    await flush()

    includes(inserted, '[UI元素] button#submit.primary', 'head line')
    includes(inserted, 'CheckoutButton', 'react component')
    includes(inserted, 'src/components/Checkout.tsx:42', 'source location')
    equal(frame.calls.length, 2, 're-armed after the first pick')
    assert(bundle.react.setters.includes('armed'), 'the mode was armed')
  })

  await suite.checkAsync('the overlay is told the add button label', async () => {
    const frame = makeFrame(null)
    const { element } = render({ stateQueue: ['idle', null, null], frames: [frame] })
    toggleOf(element).props.onClick()
    await flush()
    includes(frame.calls[0].script, '"添加到对话"', 'add label injected')
    assert(frame.calls[0].script.indexOf('ADD_LABEL_TEXT') === -1, 'placeholder replaced')
  })

  await suite.checkAsync('turning the mode off cancels the guest picker', async () => {
    const frame = makeFrame(INFO)
    const { element } = render({ stateQueue: ['armed', null, null], frames: [frame] })
    toggleOf(element).props.onClick()
    await flush()
    assert(frame.calls.some((call) => call.script.includes('__dshElementPicker.cancel()')), 'guest cancel issued')
  })

  await suite.checkAsync('no visible preview is reported, not swallowed', async () => {
    const { element, bundle } = render({ stateQueue: ['idle', null, null], frames: [] })
    toggleOf(element).props.onClick()
    await flush()
    assert(bundle.react.setters.includes('本会话没有可见的预览'), `expected the no-preview notice, saw ${JSON.stringify(bundle.react.setters)}`)
  })

  await suite.checkAsync('a guest that cannot execute JavaScript is reported distinctly', async () => {
    const plainFrame = { isConnected: true, closest: () => null, checkVisibility: () => true, getBoundingClientRect: () => ({ width: 800, height: 600 }) }
    const { element, bundle } = render({ stateQueue: ['idle', null, null], frames: [plainFrame] })
    toggleOf(element).props.onClick()
    await flush()
    assert(bundle.react.setters.includes('当前预览不支持元素引用'), `expected the no-bridge notice, saw ${JSON.stringify(bundle.react.setters)}`)
  })

  await suite.checkAsync('a rejected injection is reported as a failure', async () => {
    const frame = makeFrame(null, { reject: true, message: 'guest gone' })
    const { element, bundle } = render({ stateQueue: ['idle', null, null], frames: [frame] })
    toggleOf(element).props.onClick()
    await flush()
    assert(bundle.react.setters.includes('引用失败'), `expected the failure notice, saw ${JSON.stringify(bundle.react.setters)}`)
  })

  await suite.checkAsync('a moved-on draft is reported as a conflict', async () => {
    const frame = makeFrame(INFO)
    const actions = { captureInsertion: () => ({ draftRev: 1 }), insertText: () => false }
    const { element, bundle } = render({ stateQueue: ['idle', null, null], frames: [frame], actions })
    toggleOf(element).props.onClick()
    await flush()
    assert(bundle.react.setters.includes('草稿已变更，请重试'), `expected the conflict notice, saw ${JSON.stringify(bundle.react.setters)}`)
  })

  await suite.checkAsync('a hidden frame is not treated as the preview', async () => {
    const hidden = makeFrame(INFO, { visible: false })
    const visible = makeFrame(INFO)
    const { element } = render({ stateQueue: ['idle', null, null], frames: [hidden, visible] })
    toggleOf(element).props.onClick()
    await flush()
    equal(hidden.calls.length, 0, 'hidden frame untouched')
    equal(visible.calls.length, 1, 'visible frame used')
  })

  await suite.checkAsync('a detached frame is skipped', async () => {
    const detached = makeFrame(INFO, { connected: false })
    const visible = makeFrame(INFO)
    const { element } = render({ stateQueue: ['idle', null, null], frames: [detached, visible] })
    toggleOf(element).props.onClick()
    await flush()
    equal(detached.calls.length, 0, 'detached frame untouched')
  })

  await suite.checkAsync("picks from THIS session's preview, never another session's", async () => {
    const mine = makeFrame(INFO)
    const other = makeFrame(INFO)
    const { element } = render({
      stateQueue: ['idle', null, null],
      sessionId: 'session-mine',
      frames: [other],
      sessions: {
        'session-mine': { frames: [mine], open: true },
        'session-other': { frames: [other], open: true },
      },
    })
    toggleOf(element).props.onClick()
    await flush()
    equal(mine.calls.length, 1, 'this session preview used')
    equal(other.calls.length, 0, "another session's preview untouched")
  })

  await suite.checkAsync('a closed right panel is not a usable preview', async () => {
    const closed = makeFrame(INFO)
    const { element, bundle } = render({
      stateQueue: ['idle', null, null],
      sessionId: 'session-mine',
      sessions: { 'session-mine': { frames: [closed], open: false } },
    })
    toggleOf(element).props.onClick()
    await flush()
    equal(closed.calls.length, 0, 'closed panel untouched')
    assert(bundle.react.setters.includes('本会话没有可见的预览'), `expected the no-preview notice, saw ${JSON.stringify(bundle.react.setters)}`)
  })

  suite.check('the injected picker is self-contained and non-intrusive', () => {
    const { exported } = loadBundle()
    const script = exported.__internals.PICKER_SOURCE
    includes(script, 'pointer-events:none', 'the overlay never steals a click')
    includes(script, 'data-dsh-picker="add"', 'has the add-to-chat button')
    includes(script, 'pointer-events:auto', 'only the button opts back into pointer events')
    includes(script, "event.key !== 'Escape'", 'escape cancels')
    includes(script, 'preventDefault()', 'clicks are consumed')
    includes(script, '__reactFiber$', 'reads React fiber for the component name')
    includes(script, '_debugSource', 'reads the React 18 source location')
    includes(script, '_debugStack', 'falls back to the React 19 stack frame')
    includes(script, 'elementFromPoint', 'hit-tests under the cursor')
    includes(script, 'ADD_LABEL_TEXT', 'carries a label placeholder')
    equal(script.includes('${'), false, 'no template interpolation in the injected string')
  })

  suite.check('english fallback for a non-Chinese document', () => {
    const { element } = render({ lang: 'en-US', stateQueue: ['armed', null, null, null] })
    const text = textsOf(element).join(' ')
    includes(text, 'Click an element', 'english hint')
    equal(toggleOf(element).props.title, 'Enable element selection', 'english tooltip')
  })

  suite.check('a supplied translator wins', () => {
    const { element } = render({ t: (key) => `«${key}»` })
    equal(toggleOf(element).props.title, '«title»', 'translator used')
  })

  report(suite)
}
