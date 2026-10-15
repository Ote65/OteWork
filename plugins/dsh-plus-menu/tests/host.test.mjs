/**
 * Offline harness for dsh-plus-menu's host half.
 *
 * Imports the real lib/index.js, mounts it against a fake Cordis context, then
 * drives the registered route the way the webserver does.
 */
import { fileURLToPath } from 'node:url'

const HOST = process.argv[2] ?? fileURLToPath(new URL('../lib/index.js', import.meta.url))
let failures = 0
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) { console.log(`  ok   ${label}`) } else { failures++; console.log(`  FAIL ${label}\n       expected ${e}\n       actual   ${a}`) }
}

const plugin = await import(`file:///${HOST.replace(/\\/g, '/')}`)
console.log(`name = ${plugin.name}`)

/** Build a fake context whose tool registry answers like the real one. */
function makeCtx({ scopedSchemas, globalSchemas, agent = { id: 'agent-1' } }) {
  const routes = []
  const effects = []
  const scope = {
    effect(fn) { effects.push(fn()); return () => {} },
    webServer: {
      register(route) { routes.push(route); return () => { routes.splice(routes.indexOf(route), 1) } },
    },
    tools: {
      schemas: (key) => (key === undefined ? globalSchemas : scopedSchemas),
    },
    get: (key) => (key === 'agents' ? { get: (id) => (id === 's1' ? agent : undefined) } : undefined),
  }
  const ctx = {
    inject(deps, callback) { callback(scope); return () => {} },
    effect(fn) { effects.push(fn()); return () => {} },
  }
  return { ctx, routes, effects }
}

/** Drive one request through a route handler. */
function call(routes, path, method = 'GET') {
  return new Promise((resolve) => {
    const route = routes.find((r) => r.path === path.split('?')[0])
    if (route === undefined) { resolve({ status: 404, body: undefined }); return }
    const req = { method, url: path + (path.includes('?') ? '' : '') }
    const res = {
      status: undefined, body: undefined, headers: undefined,
      writeHead(status, headers) { this.status = status; this.headers = headers },
      end(text) { this.body = JSON.parse(text); resolve({ status: this.status, body: this.body }) },
    }
    route.handler(req, res)
  })
}

const scoped = [
  { name: 'read', description: 'Read a file' },
  { name: 'mcp__everything__echo', description: 'Echoes back   the  input' },
  { name: 'mcp__everything__add', description: 'Adds two numbers' },
  { name: 'mcp__filesystem__read_file', description: 'Read a workspace file' },
]

// ── the scoped read wins, and only MCP tools are reported ───────────────────
console.log('\nroute: scoped session read')
{
  const world = makeCtx({ scopedSchemas: scoped, globalSchemas: [{ name: 'mcp__global__x', description: 'global' }] })
  plugin.apply(world.ctx, { sections: ['mcp', 'skills', 'commands'] })
  check('one route is mounted', world.routes.map((r) => `${r.kind} ${r.path}`), ['exact /api/plus-menu/mcp'])
  const { status, body } = await call(world.routes, '/api/plus-menu/mcp?session=s1')
  check('status', status, 200)
  check('ok', body.ok, true)
  check('configured order is echoed', body.sections, ['mcp', 'skills', 'commands'])
  check('only mcp tools are listed', body.tools.map((t) => t.name), ['mcp__everything__add', 'mcp__everything__echo', 'mcp__filesystem__read_file'])
  check('server and raw tool are split', [body.tools[0].server, body.tools[0].tool], ['everything', 'add'])
  check('descriptions are whitespace-collapsed', body.tools[1].description, 'Echoes back the input')
  check('per-server counts', body.servers, [{ server: 'everything', tools: 2 }, { server: 'filesystem', tools: 1 }])
}

// ── a bad section list is normalized, never silently dropped ────────────────
console.log('\nconfig: section normalization')
{
  const world = makeCtx({ scopedSchemas: scoped, globalSchemas: [] })
  plugin.apply(world.ctx, { sections: ['mcp', 'bogus', 'mcp'] })
  const { body } = await call(world.routes, '/api/plus-menu/mcp?session=s1')
  check('unknown and duplicate names are dropped, the rest appended', body.sections, ['mcp', 'skills', 'commands'])
}
{
  const world = makeCtx({ scopedSchemas: scoped, globalSchemas: [] })
  plugin.apply(world.ctx, {})
  const { body } = await call(world.routes, '/api/plus-menu/mcp?session=s1')
  check('an absent config uses the default order', body.sections, ['skills', 'mcp', 'commands'])
}

// ── an unknown session falls back to the global layer ───────────────────────
console.log('\nroute: unknown session')
{
  const world = makeCtx({
    scopedSchemas: scoped,
    globalSchemas: [{ name: 'mcp__fallback__ping', description: 'Ping' }],
  })
  plugin.apply(world.ctx, {})
  const { body } = await call(world.routes, '/api/plus-menu/mcp?session=nope')
  check('the global layer answers', body.tools.map((t) => t.name), ['mcp__fallback__ping'])
}

// ── a scoped read that returns nothing falls back too ───────────────────────
console.log('\nroute: empty scoped read')
{
  const world = makeCtx({
    scopedSchemas: [],
    globalSchemas: [{ name: 'mcp__fallback__ping', description: 'Ping' }],
  })
  plugin.apply(world.ctx, {})
  const { body } = await call(world.routes, '/api/plus-menu/mcp?session=s1')
  check('the global layer answers', body.tools.map((t) => t.name), ['mcp__fallback__ping'])
}

// ── no session parameter at all ─────────────────────────────────────────────
console.log('\nroute: no session parameter')
{
  const world = makeCtx({ scopedSchemas: [], globalSchemas: [{ name: 'mcp__fallback__ping', description: 'Ping' }] })
  plugin.apply(world.ctx, {})
  const { body } = await call(world.routes, '/api/plus-menu/mcp')
  check('answers from the global layer', body.tools.length, 1)
}

// ── method and empty-roster behaviour ──────────────────────────────────────
console.log('\nroute: method guard and empty roster')
{
  const world = makeCtx({ scopedSchemas: [], globalSchemas: [] })
  plugin.apply(world.ctx, {})
  const post = await call(world.routes, '/api/plus-menu/mcp?session=s1', 'POST')
  check('non-GET is refused', [post.status, post.body.error], [405, 'method-not-allowed'])
  const { body } = await call(world.routes, '/api/plus-menu/mcp?session=s1')
  check('an empty roster is an empty list, not an error', [body.ok, body.tools, body.servers], [true, [], []])
}

// ── a throwing tool registry must not 500 the panel ────────────────────────
console.log('\nroute: throwing registry')
{
  const routes = []
  const ctx = {
    inject: (deps, cb) => cb({
      effect: (fn) => { fn(); return () => {} },
      webServer: { register: (route) => { routes.push(route); return () => {} } },
      tools: { schemas: () => { throw new Error('registry offline') } },
      get: () => undefined,
    }),
    effect: () => () => {},
  }
  plugin.apply(ctx, {})
  check('route still mounts', routes.length, 1)
  const { status, body } = await call(routes, '/api/plus-menu/mcp?session=s1')
  check('degrades to an empty answer', [status, body.ok, body.tools], [200, true, []])
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
