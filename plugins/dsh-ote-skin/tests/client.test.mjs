/**
 * Loads the real lib/client.js against a fake cordis/`window`/`document`
 * environment and asserts the skin's contract:
 *
 *  - the bundle identity and the cordis surface it exports;
 *  - the token layer goes through the host (`ctx.theme.overrideTokens`), so the
 *    host — not this plugin — owns the <body> custom properties;
 *  - the fallback path is taken when that API is missing;
 *  - every component rule is scoped under our root attribute and carries no
 *    layout or typography property (the two things this skin promises not to
 *    touch);
 *  - disposing one generation cannot disarm a newer one.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { createSuite, assert, equal, includes } from './harness.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT = join(HERE, '..', 'lib', 'client.js')

const SKIN_ATTR = 'data-dsh-ote-skin'
const STYLE_ID = 'dsh-ote-skin/css'
const PLUGIN_STYLE_ID = 'dsh-ote-skin/plugins'
const TOKEN_SOURCE = 'dsh-ote-skin:oltra'

/** Text of the sheet this plugin owns under the given id. */
function sheetById(bundle, id) {
  const sheet = bundle.head.find((node) => node.tagName === 'STYLE' && node.id === id)
  assert(sheet !== undefined && sheet !== null, `sheet ${id} is installed`)
  return sheet.textContent
}

/** A minimal element good enough for the skin's head half. */
function makeElement(tagName) {
  const element = {
    tagName: String(tagName).toUpperCase(),
    id: '',
    dataset: {},
    textContent: '',
    attributes: {},
    children: [],
    parentNode: null,
    isConnected: false,
    appendChild(child) {
      child.parentNode = element
      child.isConnected = true
      element.children.push(child)
      return child
    },
    remove() {
      const parent = element.parentNode
      if (parent !== null) {
        const at = parent.children.indexOf(element)
        if (at !== -1) parent.children.splice(at, 1)
      }
      element.parentNode = null
      element.isConnected = false
    },
    setAttribute(name, value) {
      element.attributes[name] = value
    },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(element.attributes, name) ? element.attributes[name] : null
    },
    removeAttribute(name) {
      delete element.attributes[name]
    },
  }
  return element
}

let documentStub = null

/** Build a fresh host environment and run the bundle inside it. */
function loadBundle({ withTheme = true, source } = {}) {
  const specs = []
  const sheets = []
  const tokenCalls = []
  const tokenDisposals = []
  const disposers = []
  const warnings = []

  documentStub = {
    documentElement: makeElement('html'),
    head: makeElement('head'),
    body: makeElement('body'),
    createElement: (tagName) => makeElement(tagName),
    getElementById: (id) => documentStub.head.children.find((node) => node.id === id) ?? null,
  }

  const windowStub = {
    __ModuleLoader__: {
      load(spec) {
        specs.push(spec)
      },
    },
  }

  const theme = {
    overrideTokens(source_, overrides) {
      tokenCalls.push({ source: source_, overrides })
      return () => tokenDisposals.push(source_)
    },
  }

  const ctx = {
    effect(body, label) {
      void label
      const dispose = body()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
  }
  if (withTheme === true) ctx.theme = theme

  const text = source ?? readFileSync(CLIENT, 'utf8')
  const run = new Function('window', 'document', 'console', text)
  run(windowStub, documentStub, { warn: (...args) => warnings.push(args) })

  equal(specs.length, 1, 'one bundle registration')
  const spec = specs[0]
  const exported = spec.factory()

  return {
    spec,
    exported,
    ctx,
    sheets,
    tokenCalls,
    tokenDisposals,
    disposers,
    warnings,
    get head() {
      return documentStub.head.children
    },
    get html() {
      return documentStub.documentElement
    },
  }
}

export async function run(report) {
  const suite = createSuite('dsh-ote-skin/client')

  suite.check('bundle identity is the package name', () => {
    const bundle = loadBundle()
    equal(bundle.spec.id, 'dsh-ote-skin', 'bundle id')
  })

  suite.check('exports apply/inject and needs no module from the table', () => {
    const bundle = loadBundle()
    equal(typeof bundle.exported.apply, 'function', 'apply')
    equal(bundle.exported.inject.join(','), 'theme', 'inject')
  })

  suite.check('tokens go through the host, not the DOM', () => {
    const bundle = loadBundle()
    bundle.exported.apply(bundle.ctx)

    equal(bundle.tokenCalls.length, 1, 'overrideTokens calls')
    equal(bundle.tokenCalls[0].source, TOKEN_SOURCE, 'override source')
    const tokens = bundle.tokenCalls[0].overrides
    equal(tokens['--dsw-alias-bg-base'], '#161719', 'canvas colour')
    equal(tokens['--dsw-specific-sidebar-fill'], '#121315', 'chrome colour')
    equal(tokens['--dsw-alias-bg-layer-1'], '#222427', 'panel colour')
    equal(tokens['--dsw-specific-input-major'], '#0a0b0c', 'input well')
    equal(tokens['--dsw-alias-markdown-code-block'], '#0e0e0e', 'code block')
    equal(tokens['--dsw-alias-brand-primary'], '#ff5a1f', 'single accent')
    equal(tokens['--dsw-radius-md'], '5px', 'radius scale')
    equal(tokens['--dsw-elevation-soft'], 'none', 'cards carry no shadow')
  })

  suite.check('the token layer never touches typography', () => {
    const bundle = loadBundle()
    bundle.exported.apply(bundle.ctx)
    const tokens = bundle.tokenCalls[0].overrides
    const forbidden = ['--dsw-font-family', '--dsw-font-markdown-base', '--dsh-content-font-size']
    for (const name of Object.keys(tokens)) {
      for (const banned of forbidden) {
        assert(name.startsWith(banned) !== true, `typography token leaked: ${name}`)
      }
    }
  })

  suite.check('the root marker is set for the component layer', () => {
    const bundle = loadBundle()
    bundle.exported.apply(bundle.ctx)
    equal(typeof bundle.html.attributes[SKIN_ATTR], 'string', 'root attribute')
  })

  suite.check('two sheets, both owned by this plugin: shell + third-party alignment', () => {
    const bundle = loadBundle()
    bundle.exported.apply(bundle.ctx)

    const sheets = bundle.head.filter((node) => node.tagName === 'STYLE')
    equal(sheets.length, 2, 'style elements')
    for (const sheet of sheets) equal(sheet.dataset.plugin, 'dsh-ote-skin', 'style marker')
    equal(sheets[0].id, STYLE_ID, 'component sheet id')
    equal(sheets[1].id, PLUGIN_STYLE_ID, 'plugin sheet id')
  })

  suite.check('the component sheet carries the shell rules', () => {
    const bundle = loadBundle()
    bundle.exported.apply(bundle.ctx)
    const css = sheetById(bundle, STYLE_ID)

    includes(css, '[class*="_button"][class*="_primary"]', 'outline primary button')
    includes(css, '[class*="_composerStack"] [class*="_card"]:focus-within', 'composer focus ring')
    includes(css, '[class*="_sessionRow"][class*="_selected"]', 'selected row marker')
    includes(css, '[class*="_ioCard"]', 'tool card fill')
    includes(css, '[class*="_triggerLabel"]', 'model/permission chip ellipsis')
    includes(css, 'text-overflow: ellipsis', 'ellipsis is armed')
    includes(css, 'li::marker', 'list marker colour')
    includes(css, '[class*="_sidebarCol"] [class*="_fade"]', 'sidebar list fade killed')
    includes(css, '[data-composer-card="true"]', 'composer card fill rule')
    includes(css, 'background-color: #212121;', 'composer card fill is the owner colour')
    includes(css, '[class*="_sidebarCol"] > div > [class*="_root"]', 'sidebar root rule')
    includes(css, 'background-color: #292929;', 'sidebar root fill')
    includes(css, 'color: #ffffff;', 'sidebar root text')
  })

  suite.check('the plugin sheet covers the audited third-party hooks', () => {
    const bundle = loadBundle()
    bundle.exported.apply(bundle.ctx)
    const css = sheetById(bundle, PLUGIN_STYLE_ID)

    includes(css, '[data-dsh-picker="box"]', 'element picker highlight box')
    includes(css, '[data-dsh-picker="add"]', 'element picker add button')
    /* 主人明令：token 计量卡片不套皮 —— 四个它消费的别名必须钉回出厂值。 */
    includes(css, '[data-dsh-token-hud]{', 'token hud pinned')
    includes(css, '--dsw-alias-bg-layer-1: #1c1c1e;', 'token hud pinned bg')
    assert(css.includes('[data-dsh-token-hud="card"]') !== true, 'token hud card must not be restyled')
    assert(css.includes('#3b82f6') !== true, 'token hud inline colors must not be touched')
    includes(css, '[data-tag-tone="0"]', 'task board tag tones')
    includes(css, '[data-tag-tone="5"]', 'task board last tone')
    includes(css, '--dsh-task-tag-fill', 'task board tag variables')
    includes(css, '[style*="#4d9de0"]', 'at-file icon colour')
    includes(css, '[style*="18, 45, 72"]', 'agent-teams avatar shadow')
    /* 白圈必须被换掉，蓝框必须变橙 —— 这两条是用户抱怨的"露白/蓝"。 */
    assert(css.includes('rgba(255, 255, 255, 0.9)') !== true, 'the white picker ring must be gone')
    includes(css, 'rgba(255, 90, 31, 0.55)', 'the ring is orange now')
  })

  suite.check('every rule in both sheets is scoped to our root attribute', () => {
    const bundle = loadBundle()
    bundle.exported.apply(bundle.ctx)
    for (const id of [STYLE_ID, PLUGIN_STYLE_ID]) {
      const css = sheetById(bundle, id)
      const selectors = css
        .split('\n')
        .filter((line) => line.includes('{'))
        .map((line) => line.slice(0, line.indexOf('{')).trim())
      assert(selectors.length > 0, `${id}: some rules exist`)
      for (const selector of selectors) {
        assert(selector.startsWith(`html[${SKIN_ATTR}]`), `${id}: unscoped selector: ${selector}`)
      }
    }
  })

  suite.check('all rules: no size, spacing or typography property', () => {
    const bundle = loadBundle()
    bundle.exported.apply(bundle.ctx)
    const banned = [
      'padding:',
      'padding-',
      'margin:',
      'margin-',
      'gap:',
      'width:',
      'height:',
      'max-width:',
      'max-height:',
      'font-size:',
      'font-family:',
      'font-weight:',
      'line-height:',
      'letter-spacing:',
      'display:',
      'position:',
      'flex:',
      'grid-',
    ]
    for (const id of [STYLE_ID, PLUGIN_STYLE_ID]) {
      const css = sheetById(bundle, id).replace(/\s+/g, '')
      /* Drop the one allowed intrinsic-size relaxation before the scan, so
       * `min-width:0` cannot masquerade as a `width:` declaration. */
      const probe = css.replace(/min-width:0/g, '')
      for (const property of banned) {
        assert(probe.includes(property) !== true, `${id}: layout/typography property in the skin: ${property}`)
      }
      /* `min-width: 0` is the one intrinsic-size declaration the skin needs: it
       * removes a flex item's automatic minimum so an ellipsis can kick in
       * (《规范》§3.7). Any other value would be a real size, so it is refused. */
      const minWidths = [...css.matchAll(/min-width:([^;}]+)/g)].map((match) => match[1].trim())
      for (const value of minWidths) {
        assert(value === '0', `${id}: min-width must only relax an intrinsic minimum, got ${value}`)
      }
    }
  })

  suite.check('the shell layer needs no !important; the plugin layer is allowed to shout', () => {
    const bundle = loadBundle()
    bundle.exported.apply(bundle.ctx)
    /* Our own rules outrank the shipped ones by the attribute prefix alone. */
    assert(
      sheetById(bundle, STYLE_ID).includes('!important') !== true,
      'the component sheet must not shout'
    )
    /* The plugins write colours into `style=""`, which outranks any stylesheet:
     * `!important` is the only lever there, so this sheet uses it deliberately. */
    assert(
      sheetById(bundle, PLUGIN_STYLE_ID).includes('!important') === true,
      'the plugin sheet must outrank inline styles'
    )
  })

  suite.check('a reload adopts its own node instead of stacking sheets', () => {
    const bundle = loadBundle()
    bundle.exported.apply(bundle.ctx)
    bundle.exported.apply(bundle.ctx)
    equal(bundle.head.filter((node) => node.tagName === 'STYLE').length, 2, 'still two sheets')
  })

  suite.check('disposing the layer restores the stock shell', () => {
    const bundle = loadBundle()
    bundle.exported.apply(bundle.ctx)
    for (const dispose of bundle.disposers) dispose()

    equal(bundle.head.length, 0, 'style removed')
    equal(SKIN_ATTR in bundle.html.attributes, false, 'root attribute removed')
    equal(bundle.tokenDisposals.length, 1, 'token layer disposed')
  })

  suite.check('a stale generation cannot disarm the live one', () => {
    const bundle = loadBundle()
    bundle.exported.apply(bundle.ctx)
    const stale = bundle.disposers.slice()
    bundle.exported.apply(bundle.ctx)

    for (const dispose of stale) dispose()
    const sheets = bundle.head.filter((node) => node.tagName === 'STYLE')
    equal(sheets.length, 2, 'the new generation survives')
    equal(typeof bundle.html.attributes[SKIN_ATTR], 'string', 'marker survives')
  })

  suite.check('without the theme service the palette is installed as CSS', () => {
    const bundle = loadBundle({ withTheme: false })
    bundle.exported.apply(bundle.ctx)
    equal(bundle.tokenCalls.length, 0, 'no host call')
    const sheet = bundle.head.find((node) => node.tagName === 'STYLE' && node.textContent.includes('--dsw-alias-bg-base'))
    assert(sheet !== undefined && sheet !== null, 'fallback sheet installed')
    includes(sheet.textContent, '--dsw-alias-bg-base:#161719 !important', 'fallback needs !important to beat <body> inline')
  })

  suite.check('a throwing host API degrades to the stylesheet', () => {
    const bundle = loadBundle()
    bundle.ctx.theme.overrideTokens = () => {
      throw new Error('theme runtime unavailable')
    }
    bundle.exported.apply(bundle.ctx)
    assert(bundle.warnings.length === 1, 'one warning')
    assert(
      bundle.head.some((node) => node.tagName === 'STYLE' && node.textContent.includes('--dsw-alias-bg-base')),
      'fallback sheet installed'
    )
  })

  report(suite)
}
