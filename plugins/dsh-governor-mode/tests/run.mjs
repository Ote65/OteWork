/**
 * dsh-governor-mode 离线自测台（不需要运行中的 DSH）：
 *
 *   node tests/run.mjs
 *
 * 三个套件：host（宿主半十三条路由）、client（浏览器半总督面板）、prompt（总督提示词）。
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
/* host 套件：宿主半十三条路由                                                 */
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
  const registered = []
  const ctx = {
    registered,
    effect(body) { return body() },
    inject(names, body) {
      body(Object.assign({}, ctx, {
        webServer: {
          // 真实宿主的 register 是依赖 this 的方法（token-hud 用
          // webServer.register(...) 带接收者调用才成功）；未绑定调用必须炸，
          // 以此抓住「摘出方法裸调」的回归。
          mounted: [],
          register(route) {
            this.mounted.push(route)
            registered.push(route)
            return () => {}
          },
        },
        connection: {
          authenticatedUrl: (base) => base,
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

  suite.check('registers all thirteen routes under /api/governor', () => {
    const made = boot()
    equal(routes.length, 13, 'route count')
    const paths = routes.map((route) => route.path).join(' ')
    for (const name of ['/roster', '/transcript', '/questions', '/prompt', '/answer', '/command', '/settings', '/git-state', '/bootstrap', '/bind', '/takeover', '/report', '/reports']) {
      includes(paths, name, 'route present')
      includes(paths, ROUTE_PREFIX, 'under the governor prefix')
    }
    // 挂载：十三条全部注册到 webServer（plus-menu 同款通路），首选 kind:'exact' 形状。
    equal(made.ctx.registered.length, 13, 'all routes mounted on the web server')
    equal(made.ctx.registered[0].kind, 'exact', 'exact-kind registration shape')
    includes(made.ctx.registered[0].path, '/api/governor/roster', 'mounted path')
  })

  await suite.checkAsync('no static inject export: dynamic webServer injection only', async () => {
    // 静态 inject 是 Cordis 必需服务依赖，DSH web profile 没有 'connection'
    // 服务名——声明即整条目激活失败（本插件在真机上踩过）。
    const source = readFileSync(join(here, '..', 'lib', 'index.js'), 'utf8')
    equal(/export const inject/.test(source), false, 'no static inject export')
    const module = await import('../lib/index.js')
    const names = []
    const ctx = {
      inject(list, body) { names.push(...list); body({ webServer: { register: () => () => {} } }) },
    }
    module.apply(ctx)
    equal(names.join(','), 'webServer', 'dynamic injection targets webServer')
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

  await suite.checkAsync('bind round-trips through the file and the overlay', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'governor-binds-'))
    const file = join(dir, 'binds.json')
    try {
      boot({}, { bindsPath: file })
      const missing = await call('/bind', { query: '' })
      equal(missing.status, 400, 'workspace is required')
      const empty = await call('/bind', { query: '?workspace=w-bind-1' })
      equal(empty.body.bind, null, 'unknown workspace has no bind')
      const post = await call('/bind', {
        method: 'POST',
        body: { workspace: 'w-bind-1', governor: 's-gov', workers: ['s-a', 's-gov', 's-b'] },
      })
      equal(post.status, 200, 'post status')
      equal(post.body.bind.governor, 's-gov', 'governor stored')
      equal(post.body.bind.workers.join(','), 's-a,s-b', 'governor filtered out of workers')
      const read = await call('/bind', { query: '?workspace=w-bind-1' })
      equal(read.body.bind.governor, 's-gov', 'read back')
      const onDisk = JSON.parse(readFileSync(file, 'utf8'))
      equal(onDisk['w-bind-1'].governor, 's-gov', 'persisted to the binds file')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await suite.checkAsync('takeover caps workers at 8, stops the stale ones, binds and injects', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'governor-takeover-'))
    const file = join(dir, 'binds.json')
    try {
      const stopped = []
      const prompted = []
      const sessions = []
      for (let i = 0; i < 10; i += 1) sessions.push('s-old-' + i)
      boot({
        agents: { get: (id) => ({ stop: () => { stopped.push(id) } }) },
        subagents: { prompt: async (sessionId, text) => { prompted.push({ sessionId, text }) } },
      }, { bindsPath: file })
      const missing = await call('/takeover', { method: 'POST', body: { workspace: 'w-t1' } })
      equal(missing.status, 400, 'workspace and governor are required')
      const { status, body } = await call('/takeover', {
        method: 'POST',
        body: { workspace: 'w-t1', title: '老阿尔法', governor: 's-gov-new', sessions },
      })
      equal(status, 200, 'status')
      equal(body.ok, true, 'ok')
      equal(body.workers.join(','), 's-old-2,s-old-3,s-old-4,s-old-5,s-old-6,s-old-7,s-old-8,s-old-9', 'keeps the newest 8')
      equal(stopped.join(','), 's-old-0,s-old-1', 'stops the stale head of the list')
      equal(body.delivered, true, 'the governor prompt was delivered')
      const gov = prompted.find((entry) => entry.sessionId === 's-gov-new')
      assert(gov !== undefined, 'governor got a prompt')
      includes(gov.text, '老阿尔法', 'governor prompt names the workspace')
      includes(gov.text, 's-old-9', 'governor prompt lists the workers')
      equal(prompted.filter((entry) => entry.sessionId !== 's-gov-new').length, 8, 'every worker got the briefing')
      const brief = prompted.find((entry) => entry.sessionId === 's-old-5')
      includes(brief.text, '/api/governor/report', 'briefing carries the report curl')
      includes(brief.text, 's-old-5', 'briefing names its own session')
      const read = await call('/bind', { query: '?workspace=w-t1' })
      equal(read.body.bind.governor, 's-gov-new', 'bind written by the takeover')
      equal(read.body.bind.workers.length, 8, 'workers bound')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await suite.checkAsync('report inbox collects briefings and caps at 50', async () => {
    boot()
    const missing = await call('/report', { method: 'POST', body: { workspace: 'w-rep', session: 's-a' } })
    equal(missing.status, 400, 'workspace, session and text are required')
    for (let i = 0; i < 52; i += 1) {
      await call('/report', { method: 'POST', body: { workspace: 'w-rep', session: 's-a', text: '简报' + i } })
    }
    const { body } = await call('/reports', { query: '?workspace=w-rep' })
    equal(body.ok, true, 'ok')
    equal(body.reports.length, 50, 'capped at 50')
    equal(body.reports[0].text, '简报2', 'oldest dropped')
    equal(body.reports[49].text, '简报51', 'newest kept')
    const empty = await call('/reports', { query: '?workspace=w-rep-none' })
    equal(empty.body.reports.length, 0, 'unknown workspace reads empty')
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

/** 极小假 DOM 元素：行装饰与像素头像用到的 DOM 面（属性 / 子节点 / querySelector）。 */
function fakeEl(tag) {
  return {
    nodeType: 1,
    tagName: tag,
    id: '',
    textContent: '',
    dataset: {},
    attrs: {},
    children: [],
    parentNode: null,
    firstElementChild: null,
    setAttribute(name, value) { this.attrs[name] = String(value) },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null
    },
    appendChild(node) {
      node.parentNode = this
      this.children.push(node)
      if (this.firstElementChild == null && node.nodeType === 1) this.firstElementChild = node
      return node
    },
    replaceChild(next, old) {
      const index = this.children.indexOf(old)
      if (index >= 0) this.children[index] = next
      next.parentNode = this
      old.parentNode = null
      this.firstElementChild = this.children.find((node) => node.nodeType === 1) ?? null
      return old
    },
    removeChild(node) {
      const index = this.children.indexOf(node)
      if (index >= 0) this.children.splice(index, 1)
      node.parentNode = null
      return node
    },
    querySelector(selector) { return queryIn(this, selector)[0] ?? null },
    querySelectorAll(selector) { return queryIn(this, selector) },
  }
}

/** 深度匹配子元素：'.cls' 走 class、'[attr]' / '[attr^="v"]' 走属性、其余按标签名。 */
function queryIn(root, selector) {
  const out = []
  const attrBody = /^\[([^\]]+)\]$/.exec(selector)?.[1] ?? null
  const wantClass = attrBody == null && selector.startsWith('.')
  const want = wantClass ? selector.slice(1) : selector
  const attrHit = attrBody == null ? null : makeAttrHit(attrBody)
  for (const child of root.children) {
    if (child.nodeType !== 1) continue
    const hit = attrHit != null
      ? attrHit(child)
      : wantClass
        ? String(child.attrs.class ?? '').split(/\s+/).includes(want)
        : child.tagName === want
    if (hit) out.push(child)
    out.push(...queryIn(child, selector))
  }
  return out
}

/** '[data-x]' 命中存在；'[data-x^="前缀"]' 命中前缀。 */
function makeAttrHit(body) {
  const prefixAt = body.indexOf('^=')
  if (prefixAt < 0) return (el) => el.getAttribute(body) != null
  const name = body.slice(0, prefixAt)
  const value = body.slice(prefixAt + 2).replace(/^["']|["']$/g, '')
  return (el) => {
    const actual = el.getAttribute(name)
    return actual != null && actual.startsWith(value)
  }
}

/**
 * 加载浏览器 bundle：可配置 fetch stub、ctx 形状。
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
    createElement(tag) { return fakeEl(tag) },
    createElementNS(namespace, tag) { return fakeEl(tag) },
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
  const createCalls = []
  const tabTypeCalls = []
  const tabOpenCalls = []
  const baseCtx = {
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
    sidebarRightTabs: options.withoutTabs === true ? undefined : {
      register(definition) {
        tabTypeCalls.push(definition)
        return () => {}
      },
    },
    sidebarRight: {
      openTab: (kind, opts) => { tabOpenCalls.push({ kind, opts }) },
    },
    uiWorkspace: {
      startSession: (wid) => { startCalls.push(wid) },
      openSession: (id) => { openCalls.push(id) },
      pickDirectory: () => Promise.resolve(options.pickPath ?? '/tmp/governor-panel'),
    },
    workspaces: {
      create: (input) => {
        createCalls.push(input)
        return Promise.resolve({ workspaceId: options.newWorkspaceId ?? 'w-new-panel' })
      },
    },
  }
  // cordisProxy: wrap the context in a Proxy that mimics Cordis 4's context —
  // a bare property read of a name that is neither on the context nor a known
  // service THROWS (`cannot get property "x" without inject`), which is exactly
  // the real-machine failure that once failed this plugin's activation.
  const ctx = options.cordisProxy === true
    ? new Proxy(baseCtx, {
      get(target, prop, receiver) {
        if (Reflect.has(target, prop)) return Reflect.get(target, prop, receiver)
        if (prop === 'get') return (name) => (Reflect.has(target, name) ? Reflect.get(target, name) : undefined)
        throw new Error(`cannot get property "${String(prop)}" without inject`)
      },
      has(target, prop) { return Reflect.has(target, prop) },
    })
    : baseCtx
  exported.apply(ctx)

  return {
    spec, exported, react, attrs, listeners, head, disposers,
    injected, registrations, startCalls, openCalls, createCalls, tabTypeCalls, tabOpenCalls, ctx,
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
    equal(bundle.exported.inject.join(','), 'slots', 'inject list (slots only, like element-picker)')
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

  suite.check('the governor registers as an official right-sidebar tab type', () => {
    const bundle = loadBundle()
    equal(bundle.internals.currentStrategy(), 'tab', 'strategy')
    equal(bundle.attrs['data-dsh-governor-mount'], 'tab', 'strategy recorded on the root')
    // 阶段一：标签类型注册进官方 sidebarRightTabs 服务（与 shipped guide 同一条路）
    equal(bundle.tabTypeCalls.length, 1, 'one tab type registered')
    equal(bundle.tabTypeCalls[0].id, 'dsh-governor', 'tab type id')
    equal(bundle.tabTypeCalls[0].kind, 'governor', 'tab kind')
    equal(bundle.tabTypeCalls[0].title(), '总督', 'tab title')
    // 阶段二：body / title 进官方 keyed 槽，key = 类型 id
    const body = bundle.registrations.find((entry) => entry.registration.name === 'sidebar.right.pane.tab')
    const title = bundle.registrations.find((entry) => entry.registration.name === 'sidebar.right.pane.tab.title')
    assert(body !== undefined, 'tab body registered')
    assert(title !== undefined, 'tab title registered')
    equal(body.registration.key, 'dsh-governor', 'body keyed by type id')
    equal(title.registration.key, 'dsh-governor', 'title keyed by type id')
    // 常挂看护仍在 shell.overlay（渲染 null：现场缓存 + 新工作区建总督）
    const watch = bundle.registrations.find((entry) => entry.registration.name === 'shell.overlay')
    assert(watch !== undefined, 'watcher registered on the overlay slot')
    // 旧路线彻底移除：不开官方右栏、不猜 pane、不做覆盖界面的浮层抽屉。
    const source = readFileSync(clientPath, 'utf8')
    equal(source.includes('openRightbar('), false, 'official rightbar is never force-opened')
    equal(source.includes('registerPane'), false, 'no pane registration guesswork')
    equal(source.includes('dsh-gov-drawer'), false, 'no overlay drawer left behind')
  })

  suite.check('the tab body renders the panel and the watcher caches the scene', () => {
    const bundle = loadBundle()
    const internals = bundle.internals
    const body = bundle.registrations.find((entry) => entry.registration.name === 'sidebar.right.pane.tab')
    const title = bundle.registrations.find((entry) => entry.registration.name === 'sidebar.right.pane.tab.title')
    const hooks = {
      useTabInfo: () => ({ tab: { visible: true } }),
      useWorkspaces: (pick) => pick({ items: [{ workspaceId: 'w1', sessionIds: ['s-gov'], title: '面板一' }] }),
      useSessions: (pick) => pick({ byId: {} }),
      useSessionStatus: (pick) => pick(new Map()),
    }
    const rendered = body.Component(hooks)
    assert(rendered != null && rendered.props != null, 'tab body renders the panel tree')
    const chip = title.Component({})
    equal(textsOf(chip).join(''), '总督', 'chip title text')
    includes(internals.STYLESHEET, '.dsh-gov-tab-title', 'chip style present')
    // 看护组件：填 latest 现场缓存、渲染 null
    const watch = bundle.registrations.find((entry) => entry.registration.name === 'shell.overlay')
    equal(watch.Component(hooks), null, 'watcher renders nothing')
    equal(internals.latest.wsSessions.w1.join(','), 's-gov', 'watcher cached the workspace session table')
    // 标签不可见时面板仍在（active=false 只关网络，由 usePoll 保证）
    const hidden = body.Component({ ...hooks, useTabInfo: () => ({ tab: { visible: false } }) })
    assert(hidden != null, 'panel still mounted while the tab is hidden')
  })

  suite.check('apply survives a Cordis-style proxy ctx (bare unknown-service reads throw)', () => {
    // 真机事故的离线复现：Cordis 4 的 ctx 是 Proxy，对未注册服务名的裸属性
    // 访问抛 `cannot get property "x" without inject`。本插件曾在挂载期的
    // sidebarRight 探测里裸访问而整条目激活失败——这里确保永不复发。
    const bundle = loadBundle({ cordisProxy: true })
    equal(bundle.internals.currentStrategy(), 'tab', 'activation completed, strategy chosen')
    equal(bundle.disposers.length, 6, 'all six effects registered and disposed cleanly')
    includes(bundle.injected.join(','), 'conversation.input.left', 'draft bridge still injected')
    equal(bundle.attrs['data-dsh-governor-mode'], '', 'root marker set')
    // 拦截器也照常装上（点工作区行依赖它）
    equal(bundle.listeners.click.length, 1, 'interceptor installed')
  })

  suite.check('activation degrades quietly when the tab services are absent', () => {
    const bundle = loadBundle({ withoutTabs: true, cordisProxy: true })
    equal(bundle.internals.currentStrategy(), 'tab', 'activation still completes')
    equal(bundle.tabTypeCalls.length, 0, 'no tab type without the registry service')
    bundle.internals.openGovernorTab()
    equal(bundle.tabOpenCalls.length, 1, 'openTab goes through the public face when present')
    equal(bundle.tabOpenCalls[0].kind, 'governor', 'opens the governor kind')
  })

  suite.check('sidebar interceptor passes inline controls and captures workspace rows', () => {
    const bundle = loadBundle()
    const { PASS_SELECTOR, NEW_SESSION_SELECTOR } = bundle.internals
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
    // 工作区行拦截：打开该工作区的总督会话 + 右侧栏总督标签页（一级栏是总督入口）
    const row = { getAttribute: () => 'workspace:w9' }
    bundle.internals.latest.wsSessions = { w9: ['s-gov', 's-a'] }
    bundle.internals.govBinds.w9 = { governor: 's-gov', workers: ['s-a'] }
    handler(makeEvent({ closest: (selector) => (selector.startsWith('[data-row-key') ? row : null) }))
    equal(prevented.value, true, 'workspace row is intercepted')
    equal(bundle.internals.state.workspaceId, 'w9', 'the workspace is selected')
    equal(bundle.openCalls.join(','), 's-gov', 'the bound governor session is opened')
    equal(bundle.tabOpenCalls.length, 1, 'the governor tab is opened in the right sidebar')
    equal(bundle.tabOpenCalls[0].kind, 'governor', 'opened by kind')
    // 原生新建会话控件按 aria-label 定位（走下一个用例的分支，不落到行点击上）
    includes(NEW_SESSION_SELECTOR, 'aria-label="新建会话"', 'native new-session control is matched by aria-label')
  })

  await suite.checkAsync('the native new-session control means new workspace panel', async () => {
    const bundle = loadBundle()
    const handler = bundle.listeners.click[0]
    const event = {
      target: { closest: (selector) => (selector.startsWith('button[aria-label') ? {} : null) },
      prevented: false,
      preventDefault() { this.prevented = true },
      stopPropagation() {},
      stopImmediatePropagation() {},
    }
    handler(event)
    equal(event.prevented, true, 'native new-session click is hijacked')
    await new Promise((resolve) => setTimeout(resolve, 0))
    equal(bundle.createCalls.length, 1, 'one workspace created from the picked directory')
    equal(bundle.createCalls[0].path, '/tmp/governor-panel', 'the picked path is adopted')
    equal(bundle.internals.state.workspaceId, 'w-new-panel', 'the new panel becomes the selected workspace')
  })

  suite.check('avatar seeds are stable and pixel faces are generated', () => {
    const internals = I()
    equal(internals.hashId('session-a'), internals.hashId('session-a'), 'same id same face')
    assert(internals.hashId('session-a') !== internals.hashId('session-b'), 'different ids differ')
    const gov = internals.pixelGrid('gov', 42)
    const sub = internals.pixelGrid('sub', 42)
    equal(gov.length, 12, 'grid height')
    equal(gov[0].length, 12, 'grid width')
    assert(gov.join('').includes('O'), 'governor wears an orange badge')
    assert(gov === internals.PIXEL_GOVERNOR, 'governor grid is fixed')
    equal(internals.PIXEL_WORKERS.length, 16, 'sixteen hand-drawn workers')
    assert(sub === internals.PIXEL_WORKERS[internals.hashId(42) % 16], 'worker grid is seeded')
    equal(sub.length, 12, 'worker grid height')
    equal(internals.PIXEL_PALETTE.O, '#ff5500', 'design-draft orange')
    const svg = internals.pixelAvatar('gov', 42)
    equal(svg.type, 'svg', 'avatar is an svg')
    equal(svg.props.viewBox, '0 0 12 12', 'pixel viewbox')
    assert(svg.props.children.length > 40, 'avatar has pixels')
  })

  suite.check('the DOM avatar builder produces a 12x12 pixel svg', () => {
    const internals = I()
    const svg = internals.pixelAvatarElement('gov', 42)
    equal(svg.tagName, 'svg', 'svg element')
    equal(svg.getAttribute('viewBox'), '0 0 12 12', 'pixel viewbox')
    assert(svg.children.length > 40, 'one rect per painted pixel')
    equal(svg.children[0].tagName, 'rect', 'pixels are rects')
    const fills = svg.children.map((node) => String(node.getAttribute('fill')))
    equal(fills.filter((fill) => fill.startsWith('#') !== true).length, 0, 'every pixel carries a palette fill')
    includes(fills.join(','), '#ff5500', 'governor orange present')
  })

  /** 一级栏工作区行：官方「文件夹 + 名称」两截的假树。 */
  function fakeWorkspaceRow(workspaceId, title) {
    const row = fakeEl('div')
    const folder = fakeEl('span')
    const icon = fakeEl('svg')
    folder.appendChild(icon)
    const chevron = fakeEl('span')
    const text = fakeEl('span')
    const label = fakeEl('span')
    label.textContent = title
    text.appendChild(label)
    row.appendChild(folder)
    row.appendChild(chevron)
    row.appendChild(text)
    row.setAttribute('data-row-key', 'workspace:' + workspaceId)
    return { row, folder, icon, label }
  }

  suite.check('workspace rows swap the folder icon for the governor face + crown', () => {
    const internals = I()
    const { row, folder, icon, label } = fakeWorkspaceRow('w1', '阿尔法')
    internals.decorateWorkspaceRow(row)
    const avatar = folder.querySelector('.dsh-gov-avatar')
    assert(avatar != null, 'the folder icon became the governor avatar')
    equal(icon.parentNode, null, 'the folder svg was replaced out')
    equal(avatar.getAttribute('width'), '100%', 'avatar fills the icon slot')
    equal(folder.querySelectorAll('svg').length, 1, 'exactly one icon in the folder')
    equal(label.querySelector('.dsh-gov-crown').textContent, internals.CROWN, 'crown after the name')
    equal(row.getAttribute('data-dsh-gov-row'), 'true', 'row marked decorated')
    // 幂等：官方重渲染后再装饰一次不会堆叠头像或徽记
    internals.decorateWorkspaceRow(row)
    equal(folder.children.length, 1, 'still one icon child')
    equal(label.querySelectorAll('.dsh-gov-crown').length, 1, 'still one crown')
    // 子树批量装饰
    const root = fakeEl('div')
    root.appendChild(fakeWorkspaceRow('w2', '贝塔').row)
    root.appendChild(row)
    internals.decorateWorkspaceRows(root)
    equal(root.querySelectorAll('[data-dsh-gov-row]').length, 2, 'both rows decorated')
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

  suite.check('stylesheet carries the design draft palette and motion', () => {
    const internals = I()
    includes(internals.STYLESHEET, 'background:#101614', 'matte panel base')
    includes(internals.STYLESHEET, 'background:#0b100e', 'card base')
    includes(internals.STYLESHEET, 'border:1px solid #23342b', 'hairline border')
    includes(internals.STYLESHEET, 'color:#e2e8e5', 'body text')
    includes(internals.STYLESHEET, '#ff5500', 'orange accent')
    includes(internals.STYLESHEET, '#ff7700', 'amber warning')
    includes(internals.STYLESHEET, '@keyframes dsh-gov-breathe', 'ongoing breathing glow')
    includes(internals.STYLESHEET, '@keyframes dsh-gov-flow', 'wire packet flow')
    includes(internals.STYLESHEET, 'stroke-dasharray:6 14', 'dashed flow line')
    includes(internals.STYLESHEET, 'prefers-reduced-motion', 'motion respects user preference')
    equal(/dsh-gov-tap/.test(internals.STYLESHEET), false, 'dead demo controls removed')
    equal(internals.MAX_SUB, 8, 'worker cap')
  })

  suite.check('second row parents map back to the first row', () => {
    const internals = I()
    equal(JSON.stringify(internals.layoutOf(0)), JSON.stringify({ row1: [], row2: [], parentMap: {} }), 'zero')
    equal(JSON.stringify(internals.layoutOf(3).parentMap), '{}', 'single row has no parents')
    const five = internals.layoutOf(5)
    equal(JSON.stringify(five.row1), '[0,1,2]', 'five: first row of three')
    equal(JSON.stringify(five.row2), '[3,4]', 'five: second row of two')
    equal(JSON.stringify(five.parentMap), '{"3":0,"4":2}', 'five: second row spans the ends')
    const eight = internals.layoutOf(8)
    equal(JSON.stringify(eight.parentMap), '{"4":0,"5":1,"6":2,"7":3}', 'eight: aligned column parents')
    equal(internals.layoutOf(99).row1.length, 4, 'capped at MAX_SUB')
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
    // 注入成功后绑定持久化到宿主（下次进面板直接认这个总督）
    const bindPost = calls.find((entry) => entry.url.includes('/api/governor/bind'))
    assert(bindPost !== undefined, 'bind was posted after bootstrap')
    const bindBody = JSON.parse(bindPost.init.body)
    equal(bindBody.governor, 's-gov', 'bind governor')
    equal(bindBody.workers.join(','), 's-a', 'bind workers')
    equal(bundle.internals.govBinds['w-new'].governor, 's-gov', 'bind cached immediately')
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
    const panel = registrations.find((entry) => entry.registration.name === 'sidebar.right.pane.tab')
    assert(panel !== undefined, 'the panel component is registered as the tab body')
    bundle.internals.govBinds.w1 = { governor: 's-gov', workers: ['s-a', 's-b'] }
    const element = panel.Component({
      useTabInfo: () => ({ tab: { visible: true } }),
      useWorkspaces: (pick) => pick({ items: [{ workspaceId: 'w1', title: '阿尔法', sessionIds: ['s-gov', 's-a', 's-b'] }] }),
      useSessions: (pick) => pick({ byId: { 's-gov': { title: '总督' }, 's-a': { title: '甲' }, 's-b': { title: '乙' } } }),
      useSessionStatus: (pick) => pick(new Map()),
    })
    const texts = textsOf(element).join(' | ')
    includes(texts, '阿尔法', 'workspace title')
    includes(texts, '2 / 8', 'worker count')
    includes(texts, '总督会话', 'governor button')
    includes(texts, '甲', 'worker label')
    // 加号在总督栏右侧，是新增手下子会话的唯一入口；网格里的加卡片已删
    equal(texts.includes('新建手下'), false, 'the grid add card is gone')
    const add = findByClass(element, 'dsh-gov-add')
    equal(add.length, 1, 'one head add button')
    equal(add[0].props.children, '+', 'plus glyph')
    equal(add[0].props.disabled, false, 'enabled while there is room for another worker')
    add[0].props.onClick()
    equal(bundle.startCalls.join(','), 'w1', 'the plus starts a worker session in this workspace')
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

  await suite.checkAsync('an old workspace row click takes its sessions over a new governor', async () => {
    const calls = []
    const bundle = loadBundle({
      fetch: (url, init) => {
        calls.push({ url, init })
        if (url.includes('/api/governor/takeover')) {
          return Promise.resolve({ ok: true, json: async () => ({ ok: true, workers: ['s-old-1', 's-old-2'], delivered: true }) })
        }
        if (url.includes('/api/governor/bind')) {
          return Promise.resolve({ ok: true, json: async () => ({ ok: true, bind: null }) })
        }
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) })
      },
    })
    const { setWorkspace, ensureGovernor, govBinds, pendingTakeover, latest } = bundle.internals
    latest.wsList = [{ workspaceId: 'w-old', title: '老工作区', sessionIds: ['s-old-1', 's-old-2'] }]
    latest.wsSessions = { 'w-old': ['s-old-1', 's-old-2'] }
    setWorkspace('w-old')
    await new Promise((resolve) => setTimeout(resolve, 0))
    equal(bundle.tabOpenCalls.length, 1, 'the governor tab opens right away')
    equal(bundle.startCalls.join(','), 'w-old', 'a new governor session is started')
    equal(pendingTakeover.has('w-old'), true, 'the takeover is pending')
    equal(bundle.openCalls.length, 0, 'no old session is opened as if it were the governor')
    // 看护轮询 diff 出新会话 → POST /takeover 收编手下
    ensureGovernor([{ workspaceId: 'w-old', title: '老工作区', sessionIds: ['s-old-1', 's-old-2', 's-gov-new'] }], true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const takeover = calls.find((entry) => entry.url.includes('/api/governor/takeover'))
    assert(takeover !== undefined, 'takeover was posted')
    const payload = JSON.parse(takeover.init.body)
    equal(payload.workspace, 'w-old', 'workspace id')
    equal(payload.governor, 's-gov-new', 'the fresh session is the governor')
    equal(payload.sessions.join(','), 's-old-1,s-old-2', 'the old sessions are handed over')
    equal(payload.title, '老工作区', 'the workspace title travels')
    equal(govBinds['w-old'].governor, 's-gov-new', 'the bind is cached')
    equal(govBinds['w-old'].workers.join(','), 's-old-1,s-old-2', 'the workers are cached')
    equal(pendingTakeover.has('w-old'), false, 'pending is cleared')
    equal(bundle.openCalls.includes('s-gov-new'), true, 'the governor session opens')
    // 再点行：直接开总督会话，不再新建
    setWorkspace('w-old')
    equal(bundle.startCalls.length, 1, 'a bound workspace never starts another session')
    equal(bundle.openCalls.filter((id) => id === 's-gov-new').length, 2, 'the governor opens again directly')
  })

  suite.check('the panel resolves the governor from the bind, not the first session', () => {
    const bundle = loadBundle()
    bundle.internals.govBinds.w1 = { governor: 's-gov', workers: ['s-a', 's-b'] }
    const panel = bundle.registrations.find((entry) => entry.registration.name === 'sidebar.right.pane.tab')
    const element = panel.Component({
      useTabInfo: () => ({ tab: { visible: true } }),
      useWorkspaces: (pick) => pick({ items: [{ workspaceId: 'w1', title: '阿尔法', sessionIds: ['s-a', 's-gov', 's-b'] }] }),
      useSessions: (pick) => pick({ byId: {} }),
      useSessionStatus: (pick) => pick(new Map()),
    })
    const texts = textsOf(element).join(' | ')
    includes(texts, '阿尔法 总督', 'the top node is named workspace + governor')
    includes(texts, '2 / 8', 'workers come from the bind')
    equal(bundle.internals.latest.governorId, 's-gov', 'the cached scene names the bound governor')
  })

  suite.check('an unbound workspace with sessions shows the takeover empty state', () => {
    const bundle = loadBundle()
    const panel = bundle.registrations.find((entry) => entry.registration.name === 'sidebar.right.pane.tab')
    const element = panel.Component({
      useTabInfo: () => ({ tab: { visible: true } }),
      useWorkspaces: (pick) => pick({ items: [{ workspaceId: 'w-cold', title: '老贝塔', sessionIds: ['s-a', 's-b'] }] }),
      useSessions: (pick) => pick({ byId: {} }),
      useSessionStatus: (pick) => pick(new Map()),
    })
    const texts = textsOf(element).join(' | ')
    includes(texts, '正在接管工作区…', 'the stage waits for the takeover')
    equal(bundle.internals.latest.governorId, null, 'no session is mistaken for the governor')
    const govNodes = findByClass(element, 'dsh-gov-node').filter((node) => node.props['data-gov-node'] === 'gov')
    equal(govNodes.length, 0, 'no governor node without a bind')
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
    includes(prompt, '/api/governor/report', 'report endpoint')
    includes(prompt, '/api/governor/reports', 'reports endpoint')
    includes(prompt, '阿尔法', 'workspace title')
    includes(prompt, 's-a、s-b', 'worker sessions listed')
  })

  suite.check('briefing and pending-queue discipline is spelled out', () => {
    includes(prompt, '简报', 'the briefing section exists')
    includes(prompt, '不会唤醒', 'briefings never wake the governor')
    includes(prompt, '待发区', 'busy workers get queued, not interrupted')
    includes(prompt, 'running=true', 'the busy signal is named')
    includes(prompt, '用户明确要求停止', 'only the user may interrupt')
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
