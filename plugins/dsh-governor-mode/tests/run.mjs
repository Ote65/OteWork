/**
 * dsh-governor-mode 离线自测台（不需要运行中的 DSH）：
 *
 *   node tests/run.mjs
 *
 * 三个套件：host（宿主半九条路由）、client（浏览器半总督面板）、prompt（总督提示词）。
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { __internals as hostInternals, apply, routes, ROUTE_PREFIX } from '../lib/index.js'
import { __internals as promptInternals, buildGovernorPrompt } from '../lib/prompt.js'

const here = dirname(fileURLToPath(import.meta.url))

/* ---------------------------------------------------------------------- */
/* 微型断言 + 报告 harness（照 dsh-session-bridge/tests 的形状）            */
/* ---------------------------------------------------------------------- */

function assert(condition, message) {
  if (condition !== true) throw new Error(message ?? 'assertion failed')
}

function equal(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message ?? 'not equal'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

function includes(haystack, needle, message) {
  if (typeof haystack !== 'string' || haystack.includes(needle) === false) {
    throw new Error(`${message ?? 'missing substring'}: ${JSON.stringify(needle)} in ${JSON.stringify(String(haystack).slice(0, 300))}`)
  }
}

function createSuite(name) {
  const results = []
  return {
    name,
    results,
    check(label, body) {
      try {
        body()
        results.push({ ok: true, label })
      } catch (error) {
        results.push({ ok: false, label, detail: String(error && error.message) })
      }
    },
    async checkAsync(label, body) {
      try {
        await body()
        results.push({ ok: true, label })
      } catch (error) {
        results.push({ ok: false, label, detail: String(error && error.message) })
      }
    },
  }
}

function report(suite) {
  const pass = suite.results.filter((item) => item.ok).length
  const fail = suite.results.length - pass
  console.log(`\n${suite.name}: ${pass}/${suite.results.length} passed`)
  for (const item of suite.results) {
    if (item.ok) continue
    console.log(`  FAIL  ${item.label}\n        ${item.detail}`)
  }
  return { pass, fail }
}

/* ---------------------------------------------------------------------- */
/* host 套件：宿主半九条路由                                                  */
/* ---------------------------------------------------------------------- */

/** 会话替身：宿主半读到的面（snapshotEvents(from) 半开区间，seq 是下一偏移）。 */
function fakeSession(events, options = {}) {
  const next = options.seq ?? (events.length === 0 ? 0 : events[events.length - 1].seq + 1)
  return {
    header: { cwd: options.cwd },
    seq: next,
    snapshotEvents: (from = 0) => events.filter((event) => event.seq >= from),
  }
}

function makeCtx(options = {}) {
  const sessions = new Map(options.sessions ?? [])
  const ctx = {
    effect(body) { return body() },
    inject(names, body) {
      body(Object.assign({}, ctx, {
        connection: {
          authenticatedUrl: (base) => base,
          fetch: { register: () => () => {} },
        },
      }))
    },
    get(name) {
      if (name === 'sessions') return { get: (id) => sessions.get(id) }
      if (name === 'agents') return options.agents
      if (name === 'userQuestions') return options.userQuestions
      if (name === 'commands') return options.commands
      if (name === 'subagents') return options.subagents
      return undefined
    },
  }
  return { ctx, sessions }
}

function boot(options = {}, config = {}) {
  routes.length = 0
  const made = makeCtx(options)
  apply(made.ctx, Object.assign({ baseUrl: 'http://127.0.0.1:19387' }, config))
  return made
}

function makeReq(route, options = {}) {
  const listeners = new Map()
  const req = {
    method: options.method ?? 'GET',
    url: route.path + (options.query ?? ''),
    on(event, handler) {
      listeners.set(event, handler)
      return req
    },
  }
  setTimeout(() => {
    if (options.body !== undefined) {
      const handler = listeners.get('data')
      if (handler !== undefined) handler(Buffer.from(JSON.stringify(options.body), 'utf8'))
    }
    const end = listeners.get('end')
    if (end !== undefined) end()
  }, 0)
  return req
}

function makeRes() {
  return {
    statusCode: 0,
    headers: {},
    text: '',
    writeHead(status, headers) { this.statusCode = status; this.headers = headers ?? {}; return this },
    end(text) { this.text = text ?? ''; return this },
  }
}

async function call(path, options = {}) {
  const route = routes.filter((candidate) => candidate.path === `${ROUTE_PREFIX}${path}`).pop()
  assert(route !== undefined, `no route for ${path}`)
  const req = makeReq(route, Object.assign({}, options, { method: options.method ?? 'GET' }))
  const res = makeRes()
  await route.handler(req, res)
  return { status: res.statusCode, body: res.text === '' ? null : JSON.parse(res.text) }
}

/** ask_user_question 待答事件（未收到 tool/result 即待答）。 */
function askEvents(callId = 'c1') {
  return [
    { seq: 1, time: 10, type: 'user/message', data: { content: [{ type: 'text', text: '开工' }] } },
    {
      seq: 2, time: 11, type: 'tool/call',
      data: {
        callId,
        name: 'ask_user_question',
        arguments: JSON.stringify({ questions: [{ id: 'q1', question: '用哪个方案？', options: ['方案A', '方案B'] }] }),
      },
    },
  ]
}

async function runHost(reportFn) {
  const suite = createSuite('host')

  suite.check('registers all nine routes under /api/governor', () => {
    boot()
    equal(routes.length, 9, 'route count')
    const paths = routes.map((route) => route.path).join(' ')
    for (const name of ['/roster', '/transcript', '/questions', '/prompt', '/answer', '/command', '/settings', '/git-state', '/bootstrap']) {
      includes(paths, name, 'route present')
      includes(paths, ROUTE_PREFIX, 'under the governor prefix')
    }
  })

  suite.check('a wrong method is a 405', async () => {
    boot()
    const { status, body } = await call('/settings', { method: 'POST', query: '?workspace=w' })
    equal(status, 405, 'method not allowed')
    equal(body.ok, false, 'not ok')
  })

  await suite.checkAsync('roster aggregates per-session state and rejects an empty sessions list', async () => {
    boot({
      sessions: [
        ['session-gov', fakeSession([])],
        ['session-a', fakeSession(askEvents(), { seq: 3 })],
      ],
      agents: { get: (id) => (id === 'session-a' ? { status: 'running' } : undefined) },
    })
    const missing = await call('/roster', { query: '' })
    equal(missing.status, 400, 'sessions is required')
    const { status, body } = await call('/roster', { query: '?sessions=session-gov,session-a&workspace=w1' })
    equal(status, 200, 'status')
    equal(body.workspace, 'w1', 'workspace echoed')
    equal(body.sessions.length, 2, 'two rows')
    equal(body.sessions[0].id, 'session-gov', 'first row id')
    equal(body.sessions[0].live, true, 'live')
    equal(body.sessions[1].running, true, 'running from agents')
    equal(body.sessions[1].pendingInteraction, true, 'pending from ask_user_question')
    equal(body.sessions[1].seq, 3, 'head seq')
    equal(body.sessions[0].cwd, null, 'missing cwd reads as null')
  })

  await suite.checkAsync('transcript keeps the cursor contract: seq is the next since', async () => {
    const events = [
      { seq: 1, time: 10, type: 'user/message', data: { content: [{ type: 'text', text: '你好' }] } },
      { seq: 2, time: 11, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '在的' }] } } },
      { seq: 3, time: 12, type: 'tool/call', data: { callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' } },
      { seq: 4, time: 13, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    boot({ sessions: [['session-abc', fakeSession(events)]] })
    const missing = await call('/transcript', { query: '' })
    equal(missing.status, 400, 'session is required')
    const dead = await call('/transcript', { query: '?session=session-none' })
    equal(dead.body.live, false, 'not live answers empty')
    const full = await call('/transcript', { query: '?session=session-abc&since=0' })
    equal(full.body.events.length, 4, 'all events')
    equal(full.body.events[0].role, 'user', 'user role')
    equal(full.body.events[0].text, '你好', 'user text')
    equal(full.body.events[1].text, '在的', 'assistant text')
    equal(full.body.events[2].tool, 'bash', 'tool name')
    equal(full.body.events[3].reason, 'completed', 'turn end reason')
    equal(full.body.seq, 5, 'seq is the NEXT offset')
    const caughtUp = await call('/transcript', { query: `?session=session-abc&since=${full.body.seq}` })
    equal(caughtUp.body.events.length, 0, 'nothing new when caught up')
    const incremental = await call('/transcript', { query: '?session=session-abc&since=4' })
    equal(incremental.body.events.length, 1, 'only the new event')
    equal(incremental.body.events[0].seq, 4, 'the new event seq')
  })

  await suite.checkAsync('questions extracts pending options and survives unknown shapes', async () => {
    boot({
      sessions: [
        ['session-a', fakeSession(askEvents())],
        ['session-b', fakeSession([{ seq: 1, time: 1, type: 'tool/call', data: { callId: 'c9', name: 'ask_user_question', arguments: '{bad json' } }])],
      ],
    })
    const missing = await call('/questions', { query: '' })
    equal(missing.status, 400, 'sessions is required')
    const { status, body } = await call('/questions', { query: '?sessions=session-a,session-b' })
    equal(status, 200, 'status')
    equal(body.questions.length, 1, 'one parsed question')
    equal(body.questions[0].session, 'session-a', 'from session-a')
    equal(body.questions[0].question, '用哪个方案？', 'question text')
    equal(body.questions[0].options.length, 2, 'two options')
    equal(body.questions[0].options[0].label, '方案A', 'option label')
  })

  await suite.checkAsync('prompt validates input and degrades to 501 without subagents', async () => {
    boot()
    const missing = await call('/prompt', { method: 'POST', body: {} })
    equal(missing.status, 400, 'session and text are required')
    const noService = await call('/prompt', { method: 'POST', body: { session: 'session-x', text: '干活' } })
    equal(noService.status, 501, '501 when subagents is unavailable')
    includes(noService.body.error, 'subagents', 'the reason names the missing service')
  })

  await suite.checkAsync('prompt succeeds through the first working call shape', async () => {
    const prompted = []
    boot({
      subagents: { prompt: async (sessionId, text) => { prompted.push({ sessionId, text }) } },
    })
    const { status, body } = await call('/prompt', { method: 'POST', body: { session: 'session-x', text: '干活' } })
    equal(status, 200, 'status')
    equal(body.ok, true, 'ok')
    equal(body.via, 'prompt(sessionId, text)', 'the winning shape is reported')
    equal(prompted.length, 1, 'delivered once')
    equal(prompted[0].text, '干活', 'text delivered')
  })

  await suite.checkAsync('answer replays the choice through userQuestions', async () => {
    const answered = []
    boot({
      sessions: [['session-a', fakeSession(askEvents())]],
      agents: { get: () => ({ id: 'agent-1' }) },
      userQuestions: { answer: (agent, callId, payload) => { answered.push({ agent, callId, payload }); return true } },
    })
    const missing = await call('/answer', { method: 'POST', body: {} })
    equal(missing.status, 400, 'session is required')
    const dead = await call('/answer', { method: 'POST', body: { session: 'session-none', choice: 'x' } })
    equal(dead.status, 409, 'not live is a 409')
    const idle = await call('/answer', { method: 'POST', body: { session: 'session-a', choice: 123 } })
    equal(idle.status, 400, 'unrecognised choice is a 400')
    const { status, body } = await call('/answer', { method: 'POST', body: { session: 'session-a', choice: '方案B' } })
    equal(status, 200, 'status')
    equal(body.ok, true, 'ok')
    equal(answered.length, 1, 'answered once')
    equal(answered[0].callId, 'c1', 'callId from the pending scan')
    equal(answered[0].payload.answers[0].id, 'q1', 'question id from the parsed arguments')
    equal(answered[0].payload.answers[0].selected[0], '方案B', 'the chosen label')
  })

  await suite.checkAsync('command runs through commands.execute', async () => {
    const executed = []
    boot({
      sessions: [['session-a', fakeSession([])]],
      agents: { get: () => ({ id: 'agent-1' }) },
    })
    const missing = await call('/command', { method: 'POST', body: {} })
    equal(missing.status, 400, 'session and line are required')
    const noService = await call('/command', { method: 'POST', body: { session: 'session-a', line: '/compact' } })
    equal(noService.status, 501, '501 when commands is unavailable')
    boot({
      sessions: [['session-a', fakeSession([])]],
      agents: { get: () => ({ id: 'agent-1' }) },
      commands: { execute: async (agent, line) => { executed.push({ agent, line }); return {} } },
    })
    const { status } = await call('/command', { method: 'POST', body: { session: 'session-a', line: '/compact' } })
    equal(status, 200, 'status')
    equal(executed.length, 1, 'executed once')
    equal(executed[0].line, '/compact', 'the command line')
  })

  await suite.checkAsync('settings defaults, validates, and round-trips', async () => {
    boot()
    const missing = await call('/settings', { query: '' })
    equal(missing.status, 400, 'workspace is required')
    const initial = await call('/settings', { query: '?workspace=w-set' })
    equal(initial.status, 200, 'status')
    equal(initial.body.settings.autoAnswer, false, 'autoAnswer defaults off')
    equal(initial.body.settings.autostart, true, 'autostart defaults on')
    const bad = await call('/settings', { method: 'PUT', body: { workspace: 'w-set', settings: { autoAnswer: 'yes' } } })
    equal(bad.status, 400, 'non-boolean is rejected')
    const put = await call('/settings', { method: 'PUT', body: { workspace: 'w-set', settings: { autoAnswer: true } } })
    equal(put.status, 200, 'put status')
    const readBack = await call('/settings', { query: '?workspace=w-set' })
    equal(readBack.body.settings.autoAnswer, true, 'autoAnswer persisted')
    equal(readBack.body.settings.autostart, true, 'untouched key keeps its value')
  })

  await suite.checkAsync('git-state is a pure file read, never a git run', async () => {
    boot({
      sessions: [
        ['session-nocwd', fakeSession([], { cwd: undefined })],
        ['session-nofile', fakeSession([], { cwd: join(tmpdir(), 'governor-no-such-dir') })],
      ],
    })
    const missing = await call('/git-state', { query: '' })
    equal(missing.status, 400, 'session is required')
    const noCwd = await call('/git-state', { query: '?session=session-nocwd' })
    equal(noCwd.status, 200, 'status')
    equal(noCwd.body.available, false, 'no cwd is unavailable, not an error')
    const noFile = await call('/git-state', { query: '?session=session-nofile' })
    equal(noFile.body.available, false, 'missing state.json is unavailable')

    const dir = mkdtempSync(join(tmpdir(), 'governor-state-'))
    try {
      mkdirSync(join(dir, '.governor'), { recursive: true })
      writeFileSync(join(dir, '.governor', 'state.json'), JSON.stringify({ devSynced: true, ahead: 0, behind: 0 }))
      boot({ sessions: [['session-ok', fakeSession([], { cwd: dir })]] })
      const hit = await call('/git-state', { query: '?session=session-ok' })
      equal(hit.status, 200, 'status')
      equal(hit.body.available, true, 'available')
      equal(hit.body.state.devSynced, true, 'state round-trips')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await suite.checkAsync('bootstrap builds the prompt and delivers it via the prompt path', async () => {
    const prompted = []
    boot({
      subagents: { prompt: async (sessionId, text) => { prompted.push({ sessionId, text }) } },
    })
    const missing = await call('/bootstrap', { method: 'POST', body: {} })
    equal(missing.status, 400, 'session is required')
    const { status, body } = await call('/bootstrap', {
      method: 'POST',
      body: { session: 'session-gov', workspace: 'w1', title: '阿尔法', sessions: ['session-a', 'session-b'] },
    })
    equal(status, 200, 'status')
    equal(body.ok, true, 'ok')
    assert(body.length > 1000, 'the governor prompt is substantial')
    equal(prompted.length, 1, 'delivered once')
    includes(prompted[0].text, '阿尔法', 'prompt names the workspace')
    includes(prompted[0].text, 'session-a', 'prompt lists the workers')
  })

  suite.check('pure helpers tolerate hostile shapes', () => {
    const { extractText, summariseEvent, answersFromChoice, parseIdList } = hostInternals
    equal(extractText('plain'), 'plain', 'string passthrough')
    equal(extractText(null), '', 'null is empty')
    equal(extractText({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }), 'a\nb', 'block array joined')
    equal(summariseEvent(undefined).type, undefined, 'undefined event tolerated')
    equal(parseIdList('a, b,,c').join('|'), 'a|b|c', 'id list parsed')
    equal(answersFromChoice('', null), null, 'empty choice is null')
  })

  return reportFn(suite)
}

/* ---------------------------------------------------------------------- */
/* client 套件：浏览器半总督面板                                              */
/* ---------------------------------------------------------------------- */

const clientPath = join(here, '..', 'lib', 'client.js')

/** React 替身：收集 effects，useState 用初始值。 */
function makeReact() {
  return {
    Fragment: Symbol.for('react.fragment'),
    createElement(type, props, ...children) {
      const merged = Object.assign({}, props ?? {})
      merged.children = children.length === 0 ? undefined : children.length === 1 ? children[0] : children
      return { type, props: merged }
    },
    useState(initial) { return [initial, () => {}] },
    useEffect() { return () => {} },
    useRef(initial) { return { current: initial } },
  }
}

/**
 * 加载浏览器 bundle：可配置 fetch stub、ctx 形状、sidebarRight。
 * 每次调用都重新执行源码，模块级状态天然隔离。
 */
function loadBundle(options = {}) {
  const source = readFileSync(clientPath, 'utf8')
  const specs = []
  const react = makeReact()
  const attrs = {}
  const listeners = {}
  const head = {
    children: [],
    appendChild(node) { this.children.push(node); node.parentNode = this },
    removeChild(node) {
      const index = this.children.indexOf(node)
      if (index >= 0) this.children.splice(index, 1)
    },
  }
  const documentStub = {
    hidden: options.hidden === true,
    documentElement: {
      setAttribute(name, value) { attrs[name] = value },
      getAttribute(name) { return attrs[name] },
      removeAttribute(name) { delete attrs[name] },
    },
    head,
    createElement() { return { id: '', textContent: '', dataset: {}, parentNode: null } },
    getElementById(id) { return head.children.find((node) => node.id === id) ?? null },
    addEventListener(type, handler) { (listeners[type] ??= []).push(handler) },
    removeEventListener(type, handler) {
      const arr = listeners[type]
      if (arr) {
        const index = arr.indexOf(handler)
        if (index >= 0) arr.splice(index, 1)
      }
    },
  }
  const windowStub = { __ModuleLoader__: { load(spec) { specs.push(spec) } } }
  const fetchStub = options.fetch ?? (() => Promise.resolve(null))

  // eslint-disable-next-line no-new-func -- the bundle is a browser script.
  const run = new Function('window', 'document', 'fetch', source)
  run(windowStub, documentStub, fetchStub)

  const spec = specs[0]
  const exported = spec.factory((name) => {
    if (name !== 'react') throw new Error(`module table miss: ${name}`)
    return react
  })

  const injected = []
  const registrations = []
  const disposers = []
  const startCalls = []
  const openCalls = []
  const paneCalls = []
  const rightbarCalls = []
  const ctx = {
    effect(body) {
      const dispose = body()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
    slots: {
      inject(name, body) {
        if (options.rejectSlots && options.rejectSlots.includes(name)) {
          throw new Error(`no such slot: ${name}`)
        }
        injected.push(name)
        return body()
      },
      register(registration, Component) {
        registrations.push({ registration, Component })
        return () => {}
      },
    },
    layout: {
      selectPanel: (id) => { /* 记录由用例自行断言，不抛错 */ },
      openRightbar: () => { rightbarCalls.push(Date.now()) },
    },
    uiWorkspace: {
      startSession: (wid) => { startCalls.push(wid) },
      openSession: (id) => { openCalls.push(id) },
    },
  }
  if (options.paneRegister === true) {
    ctx.sidebarRight = {
      registerPane: (key, Component) => { paneCalls.push({ key, Component }); return () => {} },
    }
  }
  exported.apply(ctx)

  return {
    spec, exported, react, attrs, listeners, head, disposers,
    injected, registrations, startCalls, openCalls, paneCalls, rightbarCalls, ctx,
    internals: exported.__internals,
  }
}

/** 收集渲染树里的全部文本。 */
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

/** 找渲染树里第一个 className 含 needle 的元素。 */
function findByClass(node, needle, out = []) {
  if (node === null || node === undefined || typeof node !== 'object' || Array.isArray(node)) {
    if (Array.isArray(node)) { for (const child of node) findByClass(child, needle, out) }
    return out
  }
  if (node.props !== undefined) {
    if (typeof node.props.className === 'string' && node.props.className.includes(needle)) out.push(node)
    findByClass(node.props.children, needle, out)
  }
  return out
}

async function runClient(reportFn) {
  const suite = createSuite('client')
  const I = () => loadBundle().internals

  suite.check('bundle loads under its own id and requires only react', () => {
    const bundle = loadBundle()
    equal(bundle.spec.id, 'dsh-governor-mode', 'bundle id')
    equal(bundle.exported.name, 'governor-mode', 'plugin name')
    equal(bundle.exported.inject.join(','), 'slots,layout,uiWorkspace', 'inject list')
    equal(typeof bundle.exported.apply, 'function', 'apply is a function')
  })

  suite.check('the mode switch is gone and the root marker is always on', () => {
    const bundle = loadBundle()
    equal(bundle.attrs['data-dsh-governor-mode'], '', 'ROOT_ATTR is always set')
    includes(bundle.injected.join(','), 'conversation.input.left', 'draft bridge still injected')
    const source = readFileSync(clientPath, 'utf8')
    equal(source.includes('ModeSwitch'), false, 'ModeSwitch is deleted')
    equal(source.includes("state.mode = 'classic'"), false, 'state.mode is deleted')
    equal(source.includes('conversation.header.leading'), false, 'header slot is gone')
  })

  suite.check('mount strategy one: sidebarRight pane registration wins', () => {
    const bundle = loadBundle({ paneRegister: true })
    equal(bundle.internals.currentStrategy(), 'pane', 'strategy')
    equal(bundle.paneCalls.length, 1, 'registered once')
    equal(bundle.paneCalls[0].key, 'governor', 'pane key')
    equal(bundle.attrs['data-dsh-governor-mount'], 'pane', 'strategy recorded on the root')
  })

  suite.check('mount strategy two: right content slot shadowing when no pane api', () => {
    const bundle = loadBundle()
    equal(bundle.internals.currentStrategy(), 'slot:sidebar.right.pane', 'strategy')
    const reg = bundle.registrations.find((entry) => entry.registration.name === 'sidebar.right.pane')
    assert(reg !== undefined, 'shadowing registration present')
    equal(reg.registration.priority, -1, 'shadowing priority -1')
    equal(bundle.attrs['data-dsh-governor-mount'], 'slot:sidebar.right.pane', 'strategy recorded')
  })

  suite.check('mount strategy three: main keyed panel as the fallback', () => {
    const bundle = loadBundle({ rejectSlots: ['sidebar.right.pane', 'sidebar.right.pane.content'] })
    equal(bundle.internals.currentStrategy(), 'main', 'strategy')
    const reg = bundle.registrations.find((entry) => entry.registration.name === 'main')
    assert(reg !== undefined, 'main registration present')
    equal(reg.registration.key, 'governor', 'main panel key')
    equal(bundle.attrs['data-dsh-governor-mount'], 'main', 'strategy recorded')
  })

  suite.check('sidebar interceptor passes inline controls and captures workspace rows', () => {
    const bundle = loadBundle()
    const { PASS_SELECTOR } = bundle.internals
    equal(bundle.listeners.click.length, 1, 'one capturing click listener')
    const handler = bundle.listeners.click[0]
    const prevented = { value: false }
    function makeEvent(target) {
      return {
        target,
        preventDefault() { prevented.value = true },
        stopPropagation() {},
        stopImmediatePropagation() {},
      }
    }
    // 行内按钮放行
    handler(makeEvent({ closest: (selector) => (selector === PASS_SELECTOR ? {} : null) }))
    equal(prevented.value, false, 'inline button passes through')
    // 工作区行拦截并选中该工作区
    const row = { getAttribute: () => 'workspace:w9' }
    handler(makeEvent({ closest: (selector) => (selector.startsWith('[data-row-key') ? row : null) }))
    equal(prevented.value, true, 'workspace row is intercepted')
    equal(bundle.internals.state.workspaceId, 'w9', 'the workspace is selected')
  })

  suite.check('avatar seeds are stable and faces are generated', () => {
    const internals = I()
    equal(internals.hashId('session-a'), internals.hashId('session-a'), 'same id same face')
    assert(internals.hashId('session-a') !== internals.hashId('session-b'), 'different ids differ')
    const gov = internals.faceCells('gov', 42)
    const sub = internals.faceCells('sub', 42)
    equal(gov.length, 12, 'grid height')
    equal(gov[0].length, 12, 'grid width')
    const flat = gov.flat().filter(Boolean)
    assert(flat.includes('accent'), 'governor has an antenna accent')
    assert(sub.flat().filter(Boolean).length > 0, 'worker face is generated')
    const svg = internals.pixelAvatar('gov', 42)
    equal(svg.type, 'svg', 'avatar is an svg')
    assert(svg.props.children.length > 40, 'avatar has pixels')
  })

  suite.check('worker rows are laid out 1..4 centered, 5+ split', () => {
    const internals = I()
    equal(JSON.stringify(internals.rowsOf(1)), '[1]', 'one')
    equal(JSON.stringify(internals.rowsOf(4)), '[4]', 'four')
    equal(JSON.stringify(internals.rowsOf(5)), '[3,2]', 'five')
    equal(JSON.stringify(internals.rowsOf(6)), '[3,3]', 'six')
    equal(JSON.stringify(internals.rowsOf(7)), '[4,3]', 'seven')
    equal(JSON.stringify(internals.rowsOf(8)), '[4,4]', 'eight')
  })

  suite.check('status mapping prefers warning, then running, then local state', () => {
    const internals = I()
    equal(internals.fusedState(null, { pendingInteraction: true }, null), 'warning', 'api pending wins')
    equal(internals.fusedState(null, null, { pendingInteraction: true }), 'warning', 'local pending wins')
    equal(internals.fusedState(null, { running: true }, { state: 'done' }), 'ongoing', 'running beats done')
    equal(internals.fusedState(null, null, { state: 'done' }), 'done', 'local done')
    equal(internals.fusedState(null, null, null), 'idle', 'idle')
    equal(internals.stateOf(null, { pendingInteraction: true }), 'warning', 'v1 mapping kept')
    equal(internals.stateOf({ completed: true }, null), 'done', 'summary completed')
  })

  suite.check('polling backs off to 15s while hidden', () => {
    const internals = I()
    equal(internals.pollDelayMs(2000, true), 15000, 'roster hidden')
    equal(internals.pollDelayMs(10000, true), 15000, 'git hidden')
    equal(internals.pollDelayMs(2000, false), 2000, 'roster active')
    equal(internals.pollDelayMs(10000, false), 10000, 'git active')
  })

  suite.check('input well targets: governor, workers, everyone', () => {
    const internals = I()
    const targets = internals.targetsOf('g', ['a', 'b'], (id) => 'T-' + id)
    equal(JSON.stringify(targets), JSON.stringify([
      { id: 'g', label: '总督' },
      { id: 'a', label: 'T-a' },
      { id: 'b', label: 'T-b' },
      { id: '__all__', label: '全体' },
    ]), 'full list')
    equal(JSON.stringify(internals.targetsOf('g', [], () => '')), JSON.stringify([{ id: 'g', label: '总督' }]), 'no workers means no everyone')
  })

  suite.check('worker branch labels come from git-state workers', () => {
    const internals = I()
    equal(internals.branchForSession('painter', { 'sub/painter': { task: 'x' } }), 'sub/painter', 'exact title match')
    equal(internals.branchForSession('painter-2', { 'sub/painter': {} }), 'sub/painter', 'prefix match')
    equal(internals.branchForSession('other', { 'sub/painter': {} }), null, 'no match')
    equal(internals.branchForSession('any', { dev: {} }), null, 'non-sub branches ignored')
    equal(internals.branchForSession('any', null), null, 'no workers is null')
  })

  suite.check('preview url only accepts http(s)', () => {
    const internals = I()
    equal(internals.previewUrlOf({ previewUrl: 'http://localhost:5173/' }), 'http://localhost:5173/', 'http ok')
    equal(internals.previewUrlOf({ preview: 'https://a.b/c' }), 'https://a.b/c', 'preview field ok')
    equal(internals.previewUrlOf({ previewUrl: 'localhost:5173' }), null, 'no scheme is rejected')
    equal(internals.previewUrlOf(null), null, 'null state')
  })

  suite.check('stylesheet uses only --dsw-* tokens, no raw colours', () => {
    const internals = I()
    assert(/#[0-9a-fA-F]{3,8}\b/.test(internals.STYLESHEET) === false, 'no hex colours')
    assert(/rgb\(|rgba\(/.test(internals.STYLESHEET) === false, 'no rgb literals')
    includes(internals.STYLESHEET, '--dsw-alias-bg-layer-2', 'semantic tokens in use')
    equal(internals.MAX_SUB, 8, 'worker cap')
  })

  await suite.checkAsync('new workspaces are lazily seeded and bootstrapped', async () => {
    const calls = []
    const bundle = loadBundle({
      fetch: (url, init) => {
        calls.push({ url, init })
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) })
      },
    })
    const { ensureGovernor } = bundle.internals
    // 已有会话的旧工作区：不打扰（不建会话、不注入）
    ensureGovernor([{ workspaceId: 'w-old', title: '旧', sessionIds: ['s-old'] }], true)
    equal(bundle.startCalls.length, 0, 'existing sessions are left alone')
    // 新工作区无会话：懒建总督
    ensureGovernor([{ workspaceId: 'w-new', title: '新', sessionIds: [] }], true)
    equal(bundle.startCalls.join(','), 'w-new', 'startSession called for the new workspace')
    // 会话就位：注入总督提示词
    ensureGovernor([{ workspaceId: 'w-new', title: '新', sessionIds: ['s-gov', 's-a'] }], true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const bootstrap = calls.find((entry) => entry.url.includes('/api/governor/bootstrap'))
    assert(bootstrap !== undefined, 'bootstrap was posted')
    const payload = JSON.parse(bootstrap.init.body)
    equal(payload.session, 's-gov', 'prompt goes to the first session')
    equal(payload.workspace, 'w-new', 'workspace id')
    equal(payload.sessions.join(','), 's-a', 'workers listed')
  })

  await suite.checkAsync('autostart off leaves new workspaces untouched', async () => {
    const calls = []
    const bundle = loadBundle({
      fetch: (url, init) => {
        calls.push({ url, init })
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) })
      },
    })
    bundle.internals.ensureGovernor([{ workspaceId: 'w-quiet', sessionIds: [] }], false)
    equal(bundle.startCalls.length, 0, 'no session created')
    bundle.internals.ensureGovernor([{ workspaceId: 'w-quiet', sessionIds: ['s1'] }], false)
    await new Promise((resolve) => setTimeout(resolve, 0))
    equal(calls.filter((entry) => entry.url.includes('/bootstrap')).length, 0, 'no bootstrap either')
  })

  await suite.checkAsync('deliver posts to /prompt and falls back to the draft bridge', async () => {
    const calls = []
    const bundle = loadBundle({
      fetch: (url, init) => {
        calls.push({ url, init })
        if (url.includes('/api/governor/prompt')) {
          const body = JSON.parse(init.body)
          return body.text === 'fail'
            ? Promise.resolve({ ok: false, json: async () => null })
            : Promise.resolve({ ok: true, json: async () => ({ ok: true }) })
        }
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) })
      },
    })
    const { deliver, state } = bundle.internals
    deliver('s-a', 'good')
    await new Promise((resolve) => setTimeout(resolve, 0))
    equal(state.draft, null, 'no fallback when the api path works')
    deliver('s-a', 'fail')
    await new Promise((resolve) => setTimeout(resolve, 0))
    equal(state.draft.sessionId, 's-a', 'failed delivery becomes a draft')
    equal(state.draft.text, 'fail', 'draft carries the text')
    equal(bundle.openCalls.join(','), 's-a', 'the target session was opened')
  })

  suite.check('the panel renders all four sections', () => {
    const bundle = loadBundle()
    const registrations = bundle.registrations
    const panel = registrations.find((entry) => {
      const reg = entry.registration
      return (reg.key === 'governor' || reg.name === 'sidebar.right.pane')
    })
    assert(panel !== undefined, 'the panel component is registered')
    const element = panel.Component({
      useWorkspaces: (pick) => pick({ items: [{ workspaceId: 'w1', title: '阿尔法', sessionIds: ['s-gov', 's-a', 's-b'] }] }),
      useSessions: (pick) => pick({ byId: { 's-gov': { title: '总督' }, 's-a': { title: '甲' }, 's-b': { title: '乙' } } }),
      useSessionStatus: (pick) => pick(new Map()),
    })
    const texts = textsOf(element).join(' | ')
    includes(texts, '阿尔法', 'workspace title')
    includes(texts, '2 / 8', 'worker count')
    includes(texts, '总督会话', 'governor button')
    includes(texts, '甲', 'worker label')
    includes(texts, '新建手下', 'add button')
    includes(texts, '自动作答', 'autoAnswer toggle')
    includes(texts, '暂无待答', 'questions empty state')
    includes(texts, '待总督汇报', 'git state')
    includes(texts, '同步 GitHub', 'sync button')
    includes(texts, '预览', 'preview button')
    // 输入井：目标下拉 + 文本框
    const select = findByClass(element, 'dsh-gov-target')
    equal(select.length, 1, 'one target select')
    const options = textsOf(select[0])
    includes(options.join(','), '总督', 'governor target option')
    includes(options.join(','), '全体', 'everyone target option')
    // gitState 为空 → 预览置灰
    const preview = findByClass(element, 'dsh-gov-gitbtn').find((node) => node.props.children === '预览')
    assert(preview !== undefined, 'preview button present')
    equal(preview.props.disabled, true, 'preview is disabled without a url')
  })

  return reportFn(suite)
}

/* ---------------------------------------------------------------------- */
/* prompt 套件：总督提示词自包含性                                             */
/* ---------------------------------------------------------------------- */

function runPrompt(reportFn) {
  const suite = createSuite('prompt')
  const base = 'http://127.0.0.1:19387'

  const prompt = buildGovernorPrompt({
    baseUrl: base,
    workspaceId: 'w1',
    workspaceTitle: '阿尔法',
    sessions: ['s-a', 's-b'],
    settings: { autoAnswer: false, autostart: true },
  })

  suite.check('the prompt is self-contained', () => {
    includes(prompt, `${base}/api/governor`, 'api base')
    includes(prompt, '/api/governor/roster', 'roster endpoint')
    includes(prompt, '/api/governor/transcript', 'transcript endpoint')
    includes(prompt, '/api/governor/questions', 'questions endpoint')
    includes(prompt, '/api/governor/prompt', 'prompt endpoint')
    includes(prompt, '/api/governor/answer', 'answer endpoint')
    includes(prompt, '/api/governor/command', 'command endpoint')
    includes(prompt, '/api/governor/settings', 'settings endpoint')
    includes(prompt, '/api/governor/git-state', 'git-state endpoint')
    includes(prompt, '/api/governor/bootstrap', 'bootstrap endpoint')
    includes(prompt, '阿尔法', 'workspace title')
    includes(prompt, 's-a、s-b', 'worker sessions listed')
  })

  suite.check('the cursor contract is spelled out', () => {
    includes(prompt, 'seq', 'seq is mentioned')
    includes(prompt, 'since', 'since is mentioned')
    includes(prompt, '原样', 'pass it back verbatim')
    includes(prompt, '400 条', 'the event cap')
  })

  suite.check('git discipline covers release/dev/sub and the state snapshot', () => {
    includes(prompt, 'release', 'release branch')
    includes(prompt, 'dev', 'dev branch')
    includes(prompt, 'sub/<名>', 'worker branches')
    includes(prompt, '.governor/state.json', 'the state file')
    includes(prompt, 'devSynced', 'the sync flag')
    includes(prompt, '同步 GitHub 只归你', 'only the governor syncs')
  })

  suite.check('the autoAnswer switch semantics are explained', () => {
    includes(prompt, 'autoAnswer', 'the switch is named')
    includes(prompt, '当前 autoAnswer＝关', 'current state is stated')
    includes(prompt, '主观', 'subjective questions go to the user')
  })

  suite.check('normalisers tolerate hostile shapes', () => {
    const { normaliseSessions, normaliseSettings, MAX_WORKERS } = promptInternals
    equal(MAX_WORKERS, 8, 'worker cap matches the client')
    equal(JSON.stringify(normaliseSessions(['a', { id: 'b' }, '', null, 42])), JSON.stringify(['a', 'b']), 'mixed shapes')
    const many = normaliseSessions(Array.from({ length: 20 }, (_, i) => 's' + i))
    equal(many.length, 8, 'capped at 8')
    equal(JSON.stringify(normaliseSettings(null)), JSON.stringify({ autoAnswer: false, autostart: true }), 'defaults')
    equal(JSON.stringify(normaliseSettings({ autoAnswer: true })), JSON.stringify({ autoAnswer: true, autostart: true }), 'partial input')
  })

  return reportFn(suite)
}

/* ---------------------------------------------------------------------- */

let failed = 0
for (const suite of [await runHost(report), await runClient(report), await runPrompt(report)]) {
  failed += suite.fail
}

console.log('')
if (failed === 0) {
  console.log('all suites passed')
  process.exit(0)
}
console.log(`${failed} failing check(s)`)
process.exit(1)
