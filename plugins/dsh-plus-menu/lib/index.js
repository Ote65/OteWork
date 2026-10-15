/**
 * dsh-plus-menu — host half.
 *
 * One read-only JSON route backs the browser half's MCP section:
 * `GET /api/plus-menu/mcp?session=<id>` answers the MCP tools the given
 * session's agent can actually call, read from the live tool registry.
 *
 * Why a route and not a Remote: the client-side trigger pipeline needs this
 * data inside a synchronous-ish candidate fetch, and the shipped Remotes
 * expose commands / skills / references / settings but no tool catalog. The
 * route is same-origin, read-only, and touches nothing.
 *
 * No imports on purpose. This package declares no `@deepseek-ai/dsh-*` peer,
 * so it stays installable on any 0.2.x runtime, and a host bundle with no
 * bare imports cannot drift against a renamed package.
 *
 * @module dsh-plus-menu
 */

/** The one route this plugin serves. */
const ROUTE = '/api/plus-menu/mcp'

/** Section order the browser half renders when the config is absent. */
const DEFAULT_SECTIONS = ['skills', 'mcp', 'commands']

/** Every section name the menu understands. */
const KNOWN_SECTIONS = new Set(DEFAULT_SECTIONS)

/** Server-qualified MCP tool name prefix, the same shape Claude Code and Codex use. */
const MCP_PREFIX = 'mcp__'

/** Longest tool description forwarded to the menu row (the row truncates visually anyway). */
const MAX_DESCRIPTION = 200

/** Cordis plugin name. */
export const name = 'plus-menu'

/**
 * Host plugin body: serve the MCP read route once the webserver and the tool
 * registry are both up. Both are optional capabilities — a headless or CLI
 * composition simply never mounts the route, and the browser half then shows
 * its Commands section alone.
 *
 * @param ctx - owning Cordis context.
 * @param config - this row's config from the profile patch.
 */
export function apply(ctx, config = {}) {
  const sections = normalizeSections(config === null || typeof config !== 'object' ? undefined : config.sections)

  ctx.inject(['webServer', 'tools'], (scope) => {
    scope.effect(
      () => scope.webServer.register({
        kind: 'exact',
        path: ROUTE,
        handler: (req, res) => {
          handleRequest(scope, req, res, sections)
        },
      }),
      'plus-menu: MCP read route',
    )
  })
}

/**
 * Read the configured section order, dropping unknown names and appending any
 * known section the config forgot, so a hand-edited patch can never hide a
 * section by typo.
 *
 * @param value - raw `sections` config value.
 * @returns the normalized order.
 */
function normalizeSections(value) {
  const requested = []
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item !== 'string' || !KNOWN_SECTIONS.has(item) || requested.includes(item)) continue
      requested.push(item)
    }
  }
  return [...requested, ...DEFAULT_SECTIONS.filter((item) => !requested.includes(item))]
}

/**
 * Answer one `GET /api/plus-menu/mcp` request.
 *
 * @param scope - the context that injected `webServer` and `tools`.
 * @param req - Node request.
 * @param res - Node response.
 * @param sections - the configured section order.
 */
function handleRequest(scope, req, res, sections) {
  if (req.method !== 'GET') {
    sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
    return
  }
  try {
    const sessionId = readQueryParam(req.url ?? '', 'session')
    const tools = readMcpTools(scope, sessionId)
    sendJson(res, 200, {
      ok: true,
      sections,
      tools,
      servers: summarizeServers(tools),
    })
  } catch (error) {
    sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}

/**
 * Collect every `mcp__<server>__<tool>` schema visible to one session's agent.
 *
 * MCP tools register inside the calling agent's scope, so a root-context read
 * sees none of them; the agent object is the scope key the tool registry
 * expects (the same reading `dsh-tool-skill` and `context_audit` use).
 *
 * @param scope - the injecting context.
 * @param sessionId - the browser's session, when it sent one.
 * @returns one entry per MCP tool, sorted by server then tool.
 */
function readMcpTools(scope, sessionId) {
  const tools = []
  for (const schema of readSchemas(scope, sessionId)) {
    if (schema === null || typeof schema !== 'object') continue
    const wireName = typeof schema.name === 'string' ? schema.name : undefined
    if (wireName === undefined || !wireName.startsWith(MCP_PREFIX)) continue
    const rest = wireName.slice(MCP_PREFIX.length)
    const split = rest.indexOf('__')
    const server = split < 0 ? rest : rest.slice(0, split)
    const tool = split < 0 ? rest : rest.slice(split + 2)
    const description = typeof schema.description === 'string' ? schema.description.replace(/\s+/g, ' ').trim() : ''
    tools.push({
      name: wireName,
      server,
      tool,
      description: description.length > MAX_DESCRIPTION ? `${description.slice(0, MAX_DESCRIPTION - 1)}…` : description,
    })
  }
  tools.sort((a, b) => (a.server === b.server ? a.tool.localeCompare(b.tool) : a.server.localeCompare(b.server)))
  return tools
}

/**
 * Read the tool schemas for one session, falling back through the scoped read
 * to the unscoped one so a stale session id degrades to the global layer
 * instead of answering nothing.
 *
 * @param scope - the injecting context.
 * @param sessionId - the browser's session id, or undefined.
 * @returns the schemas the registry answered with, or an empty list.
 */
function readSchemas(scope, sessionId) {
  const agents = scope.get('agents')
  if (sessionId !== undefined && agents !== undefined && typeof agents.get === 'function') {
    try {
      const agent = agents.get(sessionId)
      if (agent !== undefined && agent !== null) {
        const scoped = scope.tools.schemas(agent)
        if (Array.isArray(scoped) && scoped.length > 0) return scoped
      }
    } catch {
      // A session that is not agent-backed simply has no scoped tools.
    }
  }
  try {
    const global = scope.tools.schemas()
    return Array.isArray(global) ? global : []
  } catch {
    return []
  }
}

/**
 * Fold the tool list into one row per server, for a compact "N servers / M tools" reading.
 *
 * @param tools - the collected MCP tools.
 * @returns per-server counts, sorted by name.
 */
function summarizeServers(tools) {
  const counts = new Map()
  for (const tool of tools) counts.set(tool.server, (counts.get(tool.server) ?? 0) + 1)
  return [...counts.entries()]
    .map(([server, count]) => ({ server, tools: count }))
    .sort((a, b) => a.server.localeCompare(b.server))
}

/**
 * Read one query parameter from a request URL.
 *
 * @param url - the raw request URL.
 * @param key - the parameter name.
 * @returns the decoded value, or undefined.
 */
function readQueryParam(url, key) {
  const at = url.indexOf('?')
  if (at < 0) return undefined
  for (const part of url.slice(at + 1).split('&')) {
    if (!part.startsWith(`${key}=`)) continue
    try {
      return decodeURIComponent(part.slice(key.length + 1))
    } catch {
      return undefined
    }
  }
  return undefined
}

/**
 * Write one JSON response.
 *
 * @param res - Node response.
 * @param status - HTTP status.
 * @param body - JSON-serializable body.
 */
function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}
