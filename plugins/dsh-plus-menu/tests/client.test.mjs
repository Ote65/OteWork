/**
 * Offline harness for dsh-plus-menu's browser half.
 *
 * Loads the real lib/client.js through a fake `window.__ModuleLoader__`, wires a
 * fake client context (locale + inputTriggers + a stubbed fetch), then drives
 * the decorated `command` source exactly the way ui-input-trigger drives it:
 * `candidates(session, {query})` for a level, `onPick({candidate, position})`
 * for a pick, and the namespace token that pick writes back into the draft.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CLIENT = process.argv[2] ?? fileURLToPath(new URL('../lib/client.js', import.meta.url))
let failures = 0
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) { console.log(`  ok   ${label}`) } else { failures++; console.log(`  FAIL ${label}\n       expected ${e}\n       actual   ${a}`) }
}

/** Load a fresh copy of the bundle and return its plugin exports. */
function loadPlugin() {
  let registration
  globalThis.window = { __ModuleLoader__: { load: (value) => { registration = value } } }
  new Function(readFileSync(CLIENT, 'utf8'))()
  return registration.factory()
}

const ALL_SKILLS = [
  { name: 'jest', description: 'Jest testing' },
  { name: 'mermaid', description: 'Diagrams', label: 'Mermaid' },
  { name: 'vitest', description: 'Vitest testing' },
]

/** Build the fake service set one scenario runs against. */
function makeWorld() {
  const dictionaries = new Map()
  const locale = {
    register: (ns, dicts) => { dictionaries.set(ns, dicts); return () => dictionaries.delete(ns) },
    bind: (ns) => (key, params) => {
      const raw = dictionaries.get(ns)?.en?.[key] ?? key
      return params === undefined ? raw : raw.replace(/\{(\w+)\}/g, (_, name) => String(params[name]))
    },
  }
  const commandSource = {
    trigger: '/', name: 'command', order: 0,
    candidates: async (_session, req) => [
      { name: 'compact', description: 'Compact the session' },
      { name: 'plan', description: 'Toggle plan mode' },
    ].filter((row) => req.query === '' || row.name.includes(req.query)),
    onPick: ({ candidate }) => ({ claim: { name: candidate.name } }),
  }
  const skillSource = {
    trigger: '/', name: 'skill', order: 2,
    // Stands in for the shipped ranker: it must see the live query, because the
    // decorator forwards a per-level query into it.
    candidates: async (_session, req) => ALL_SKILLS.filter((skill) => req.query === '' || skill.name.includes(req.query)),
    onPick: ({ candidate }) => ({ text: `/${candidate.name} ` }),
  }
  const controllerMap = new Map()
  const live = {
    sources: [],
    // Mirrors the shipped WeakMapWithValues: `.values` is an iterable of controllers.
    controllers: { get values() { return [...controllerMap.values()] } },
  }
  const inputTriggers = {
    live,
    registerSource(src) {
      if (live.sources.some((s) => s.trigger === src.trigger && s.name === src.name)) throw new Error('duplicate')
      live.sources.push(src)
      return () => { const at = live.sources.indexOf(src); if (at >= 0) live.sources.splice(at, 1) }
    },
    sessionOf(actx) {
      const key = actx?.id ?? 'default'
      let controller = controllerMap.get(key)
      if (controller === undefined) {
        controller = makeController(live)
        controllerMap.set(key, controller)
      }
      return controller
    },
  }
  const effects = []
  const ctx = {
    locale,
    inputTriggers,
    effect: (fn) => { effects.push(fn()); return () => {} },
    get: (key) => (key === 'inputTriggers' ? inputTriggers : undefined),
  }
  return { ctx, inputTriggers, controllerMap, commandSource, skillSource, effects }
}

/**
 * A stand-in for InputTriggerController that reproduces the two behaviours the
 * plugin's `track` wrapper depends on: a launcher menu bails out without a hit
 * when the typed text carries no trigger, and a real token produces one.
 */
function makeController(live) {
  return {
    launcher: { value: null, getSnapshot() { return this.value }, set(value) { this.value = value } },
    menu: {
      state: { open: false, hit: null, generation: 0, groups: [{ source: 'command', status: 'ready', items: [] }] },
      getSnapshot() { return this.state },
      set(state) { this.state = state },
    },
    hit: null,
    deps: { roster: { sources: (trigger) => live.sources.filter((s) => s.trigger === trigger) } },
    fetches: [],
    stopFetch() { this.stops = (this.stops ?? 0) + 1 },
    reduce(event) {
      if (event.type !== 'hit') return
      this.menu.set({ ...this.menu.getSnapshot(), open: true, hit: event.hit, generation: this.menu.getSnapshot().generation + 1 })
    },
    refreshHeaders() { this.headerPolls = (this.headerPolls ?? 0) + 1 },
    fetchCandidates(hit, roster) { this.fetches.push({ hit, sources: roster.map((s) => s.name) }) },
    /** The shipped `track`: no trigger token + a live launcher = early return. */
    track(draft, caret) {
      const launched = this.launcher.getSnapshot() !== null
      this.launcher.set(null)
      const slash = draft.lastIndexOf('/')
      if (slash < 0) {
        if (launched) return
        this.hit = null
        this.menu.set({ ...this.menu.getSnapshot(), open: false })
        return
      }
      this.hit = { trigger: '/', query: draft.slice(slash + 1, caret), quoted: false, span: { start: slash, end: caret } }
      this.menu.set({ ...this.menu.getSnapshot(), open: true, hit: this.hit })
    },
  }
}

const mcpBody = {
  ok: true,
  sections: ['skills', 'mcp', 'commands'],
  servers: [{ server: 'everything', tools: 2 }],
  tools: [
    { name: 'mcp__everything__echo', server: 'everything', tool: 'echo', description: 'Echoes back' },
    { name: 'mcp__everything__add', server: 'everything', tool: 'add', description: 'Adds numbers' },
  ],
}

let fetchCount = 0
let fetchImpl = async () => ({ ok: true, json: async () => mcpBody })
globalThis.fetch = async (url) => { fetchCount++; return await fetchImpl(String(url)) }

const REQ = { query: '', quoted: false, position: 'leading', signal: new AbortController().signal }
const at = (query) => ({ ...REQ, query })

/** Boot a world with both shipped sources registered, and apply the plugin. */
function boot() {
  const world = makeWorld()
  world.inputTriggers.registerSource(world.commandSource)
  world.inputTriggers.registerSource(world.skillSource)
  const plugin = loadPlugin()
  const before = {
    commandCandidates: world.commandSource.candidates,
    commandOnPick: world.commandSource.onPick,
    skillCandidates: world.skillSource.candidates,
  }
  plugin.apply(world.ctx)
  return { ...world, plugin, before }
}

const names = (rows) => rows.map((r) => r.name)
const sections = (rows) => rows.map((r) => r.section ?? null)

// ── level 0: the category list ──────────────────────────────────────────────
console.log('\nlevel 0 — categories, not a flat dump')
{
  const world = boot()
  console.log(`  inject = ${JSON.stringify(world.plugin.inject)}`)
  check('the shipped candidates hook was replaced', world.commandSource.candidates !== world.before.commandCandidates, true)
  check('the stock skill group is suppressed', await world.skillSource.candidates({ sessionId: 's1' }, REQ), [])
  check('the group title is suppressed on the command source', world.commandSource.showGroupTitle, false)

  const rows = await world.commandSource.candidates({ sessionId: 's1' }, REQ)
  check('one row per category', names(rows), ['Skills', 'MCP', 'Commands'])
  check('categories carry no section heading', sections(rows), [null, null, null])
  check('categories are drillable', rows.map((r) => r.drill), [true, true, true])
  check('the skill count is the real catalog size', rows[0].description, '3 items')
  check('the MCP count names servers and tools', rows[1].description, '1 servers · 2 tools')
  check('the command count', rows[2].description, '2 items')

  check('drilling skills writes the namespace token', world.commandSource.onPick({ candidate: rows[0], position: 'leading' }), { text: '/skills/', continue: true })
  check('drilling mcp writes its token', world.commandSource.onPick({ candidate: rows[1], position: 'leading' }), { text: '/mcp/', continue: true })
  check('an inline drill is rescued with a leading space', world.commandSource.onPick({ candidate: rows[0], position: 'inline' }), { text: ' /skills/', continue: true })

  const before = fetchCount
  await world.commandSource.candidates({ sessionId: 's1' }, REQ)
  check('the host roster is cached within the TTL', fetchCount, before)
}

// ── level 1: a category, filtered by what follows the token ─────────────────
console.log('\nlevel 1 — skills/')
{
  const world = boot()
  const rows = await world.commandSource.candidates({ sessionId: 's1' }, at('skills/'))
  check('a back row comes first', rows[0].name, '← Back')
  check('the back row writes a bare trigger', world.commandSource.onPick({ candidate: rows[0], position: 'leading' }), { text: '/', continue: true })
  check('every skill is listed, uncapped', names(rows).slice(1), ['jest', 'mermaid', 'vitest'])
  check('the list sits under one heading', sections(rows), [null, 'Skills', 'Skills', 'Skills'])
  check('a skill keeps its shipped label', rows[2].label, 'Mermaid')
  check('picking a skill writes the literal token', world.commandSource.onPick({ candidate: rows[1], position: 'leading' }), { text: '/jest ' })

  const filtered = await world.commandSource.candidates({ sessionId: 's1' }, at('skills/me'))
  check('typing inside the level filters it', names(filtered).slice(1), ['mermaid'])
}

console.log('\nlevel 1 — commands/')
{
  const world = boot()
  const rows = await world.commandSource.candidates({ sessionId: 's1' }, at('commands/'))
  check('a back row comes first', rows[0].name, '← Back')
  check('the shipped command rows follow', names(rows).slice(1), ['compact', 'plan'])
  check('the list sits under one heading', sections(rows), [null, 'Commands', 'Commands'])
  check('a command pick still delegates', world.commandSource.onPick({ candidate: rows[1], position: 'leading' }), { claim: { name: 'compact' } })
  const filtered = await world.commandSource.candidates({ sessionId: 's1' }, at('commands/pl'))
  check('typing inside the level filters it', names(filtered).slice(1), ['plan'])
}

console.log('\nlevel 1 — mcp/')
{
  const world = boot()
  const rows = await world.commandSource.candidates({ sessionId: 's1' }, at('mcp/'))
  check('a back row comes first', rows[0].name, '← Back')
  check('tools follow, named by their raw tool name', names(rows).slice(1), ['echo', 'add'])
  check('the server name is the second-level heading', sections(rows), [null, 'everything', 'everything'])
  check('the description carries the server', rows[1].description, 'everything · Echoes back')
  check('picking a tool writes the exact wire name', world.commandSource.onPick({ candidate: rows[1], position: 'leading' }), { text: 'mcp__everything__echo ' })
  const filtered = await world.commandSource.candidates({ sessionId: 's1' }, at('mcp/add'))
  check('typing inside the level filters it', names(filtered).slice(1), ['add'])
}

// ── free text: the flat search the menu always had ─────────────────────────
console.log('\nfree text — a flat search across categories')
{
  const world = boot()
  const rows = await world.commandSource.candidates({ sessionId: 's1' }, at('a'))
  check('sections are grouped in the configured order', sections(rows), ['Skills', 'MCP', 'MCP', 'Commands', 'Commands'])
  check('every category contributes', [...new Set(sections(rows))], ['Skills', 'MCP', 'Commands'])
  check('a prefix match on a tool name ranks first', names(rows).slice(1, 3), ['add', 'echo'])

  const none = await world.commandSource.candidates({ sessionId: 's1' }, at('zzz'))
  check('an unmatched query returns nothing, so the menu closes', none, [])
}

// ── the host route failing must not take the menu down ─────────────────────
console.log('\ndegraded — no host route')
{
  const world = boot()
  fetchImpl = async () => ({ ok: false, status: 500, json: async () => ({}) })
  const rows = await world.commandSource.candidates({ sessionId: 's1' }, REQ)
  check('the MCP category disappears', names(rows), ['Skills', 'Commands'])
  const mcp = await world.commandSource.candidates({ sessionId: 's1' }, at('mcp/'))
  check('opening it anyway explains itself', [mcp[0].name, mcp[1].name], ['← Back', 'No MCP server configured'])
  check('the explanation row is not pickable', world.commandSource.onPick({ candidate: mcp[1], position: 'leading' }), 'handled')
  fetchImpl = async () => ({ ok: true, json: async () => mcpBody })
}

// ── an empty roster is a state, not an error ───────────────────────────────
console.log('\ndegraded — no MCP server configured')
{
  const world = boot()
  fetchImpl = async () => ({ ok: true, json: async () => ({ ok: true, sections: ['skills', 'mcp', 'commands'], servers: [], tools: [] }) })
  const rows = await world.commandSource.candidates({ sessionId: 's1' }, REQ)
  check('the MCP category still lists, with the gap stated', rows[1].description, 'No MCP server configured')
  fetchImpl = async () => ({ ok: true, json: async () => mcpBody })
}

// ── the configured order drives both levels ───────────────────────────────
console.log('\nconfig — category order')
{
  const world = boot()
  fetchImpl = async () => ({ ok: true, json: async () => ({ ...mcpBody, sections: ['commands', 'mcp', 'skills'] }) })
  const rows = await world.commandSource.candidates({ sessionId: 's1' }, REQ)
  check('level 0 follows the configured order', names(rows), ['Commands', 'MCP', 'Skills'])
  const search = await world.commandSource.candidates({ sessionId: 's1' }, at('a'))
  check('the search sections follow it too', [...new Set(sections(search))], ['Commands', 'MCP', 'Skills'])
  fetchImpl = async () => ({ ok: true, json: async () => mcpBody })
}

// ── late registration and disposal ────────────────────────────────────────
console.log('\nlifecycle')
{
  const world = makeWorld()
  const plugin = loadPlugin()
  // Captured before registration: these are the shipped hooks the plugin wraps.
  const shippedCommand = world.commandSource.candidates
  const shippedSkill = world.skillSource.candidates
  plugin.apply(world.ctx)
  world.inputTriggers.registerSource(world.commandSource)
  world.inputTriggers.registerSource(world.skillSource)
  const rows = await world.commandSource.candidates({ sessionId: 's1' }, REQ)
  check('late-registered sources are decorated too', names(rows), ['Skills', 'MCP', 'Commands'])
  check('the late source was wrapped', world.commandSource.candidates !== shippedCommand, true)

  for (const dispose of world.effects) if (typeof dispose === 'function') dispose()
  check('disposal restores the shipped command hook', world.commandSource.candidates === shippedCommand, true)
  check('disposal restores the shipped skill hook', world.skillSource.candidates === shippedSkill, true)
  const restored = await world.skillSource.candidates({ sessionId: 's1' }, REQ)
  check('the stock skill group works again', restored.length, 3)
  check('the suppressed group title is cleared', world.commandSource.showGroupTitle, undefined)
}

// ── typing while the + launcher menu is open filters it ────────────────────
console.log('\nlauncher search — typing inside the + menu')
{
  const world = boot()
  const controller = world.inputTriggers.sessionOf({ id: 's1' })
  check('sessionOf returns a wrapped controller', controller.track !== makeController(world.inputTriggers.live).track, true)

  // Click "+": the shipped launcher sets the source and opens the menu.
  controller.launcher.set('command')
  controller.menu.set({ ...controller.menu.getSnapshot(), open: true })
  controller.fetches.length = 0

  controller.track('jest', 4, { tier: 'plain' }, 7)
  check('typing re-runs the candidate fetch', controller.fetches.length, 1)
  check('the typed word becomes the query', controller.fetches[0].hit.query, 'jest')
  check('the pick span covers the typed word', [controller.fetches[0].hit.span.start, controller.fetches[0].hit.span.end], [0, 4])
  check('the span carries the draft revision', controller.fetches[0].hit.span.draftRev, 7)
  check('a word at the start of the draft reads as leading', controller.fetches[0].hit.position, 'leading')
  check('the full roster is asked', controller.fetches[0].sources, ['command', 'skill'])
  check('in-flight work was superseded first', controller.stops, 1)
  check('the menu stays open on the search hit', controller.menu.getSnapshot().open, true)

  // Deleting the text must fall back to the category list, not keep stale rows.
  controller.launcher.set('command')
  controller.fetches.length = 0
  controller.track('', 0, { tier: 'plain' }, 8)
  check('an emptied draft searches for the empty query', controller.fetches[0].hit.query, '')

  // An inline word keeps the inline position so command claims still see it.
  controller.launcher.set('command')
  controller.fetches.length = 0
  controller.track('see jest', 8, { tier: 'plain' }, 9)
  check('an inline word is filtered by its own text', controller.fetches[0].hit.query, 'jest')
  check('and is marked inline', controller.fetches[0].hit.position, 'inline')
  check('its span starts at the word', controller.fetches[0].hit.span.start, 4)

  // The stock path already handled a real token: no second fetch.
  controller.fetches.length = 0
  controller.track('/je', 3, { tier: 'plain' }, 10)
  check('a real / token is left entirely to the shipped path', controller.fetches.length, 0)
  check('the shipped hit survives', controller.hit.query, 'je')

  // Not launched: the shipped path owns everything.
  controller.fetches.length = 0
  controller.track('plain text', 10, { tier: 'plain' }, 11)
  check('typing outside the launcher fetches nothing', controller.fetches.length, 0)

  const wrapped = controller.track
  for (const dispose of world.effects) if (typeof dispose === 'function') dispose()
  check('disposal restores the shipped track', controller.track !== wrapped, true)
  check('disposal restores the shipped sessionOf', world.inputTriggers.sessionOf === Object.getPrototypeOf(world.inputTriggers).sessionOf, false)
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
