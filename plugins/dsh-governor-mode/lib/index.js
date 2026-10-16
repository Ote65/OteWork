/**
 * dsh-governor-mode —— 宿主半（/api/governor 控制平面）。
 *
 * 路由十三条：roster / transcript / questions / prompt / answer / command / settings /
 * git-state / bootstrap，加插件内部的 bind（总督绑定持久化）/ takeover（老工作区接管）/
 * report / reports（手下简报收件箱）。全部挂在 DSH web profile
 * 的 webServer 通道上（plus-menu 的 /api/plus-menu/mcp 与 token-hud 的
 * /api/token-hud/usage 同款已验证通路），提示词里的 URL 尽力经
 * connection.authenticatedUrl 折凭据；没有 webServer 载体时保持惰性，
 * 什么都不注册。
 *
 * 游标契约、事件摘要、pendingQuestion 提取、answer/command 的服务调用手法
 * 均照 dsh-session-bridge（本仓各插件独立复制适配的既定模式）。
 *
 * @module dsh-governor-mode
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { buildGovernorPrompt } from './prompt.js'

/** 全部路由的前缀。 */
export const ROUTE_PREFIX = '/api/governor'

/** 单次 transcript 响应最多携带的事件数。 */
const MAX_TRANSCRIPT_EVENTS = 400

/** 单条消息文本摘要的截断长度。 */
const MAX_TEXT = 4000

/** 待答问题扫描回看的窗口大小。 */
const PENDING_SCAN_EVENTS = 400

/** /settings 的默认值（内存态，无记录即默认）。 */
export const DEFAULT_SETTINGS = { autoAnswer: false, autostart: true }

/** 提示词里 URL 的默认基址（DSH Web GUI 的环回端口）。 */
const DEFAULT_BASE_URL = 'http://127.0.0.1:19387'

/** 一个总督最多带 8 个手下（与浏览器半 MAX_SUB、提示词 MAX_WORKERS 一致）。 */
const MAX_WORKERS = 8

/** 每个工作区的简报收件箱封顶条数（超出丢最旧）。 */
const MAX_REPORTS = 50

/** 本插件的路由表，供测试直接驱动（照 session-bridge）。 */
export const routes = []

/** 开关存储：workspace → { autoAnswer, autostart }。内存态，卸载即失效。 */
const settingsStore = new Map()

/** 总督绑定内存覆盖层：workspace → { governor, workers, updatedAt }（落盘失败仍生效）。 */
const bindsOverlay = new Map()

/** 手下简报收件箱：workspace → [{ session, text, time }]（内存态，封顶 MAX_REPORTS）。 */
const reportInbox = new Map()

/**
 * 以 JSON 应答。
 * @param res - Node 响应。
 * @param status - HTTP 状态码。
 * @param body - 载荷。
 */
function sendJson(res, status, body) {
  const text = JSON.stringify(body, null, 2)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

/**
 * 把请求体读成 JSON；读不出来时给空对象，绝不让坏 body 炸路由。
 * @param req - Node 请求。
 * @returns 解析结果。
 */
function readJson(req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve(text === '' ? {} : JSON.parse(text))
      } catch (error) {
        resolve({})
      }
    })
    req.on('error', () => resolve({}))
  })
}

/**
 * 逗号 id 列表 → 数组。
 * @param raw - 形如 "id1,id2" 的查询参数。
 * @returns 去空后的 id 数组。
 */
function parseIdList(raw) {
  if (typeof raw !== 'string') return []
  return raw.split(',').map((id) => id.trim()).filter((id) => id !== '')
}

/**
 * 从消息形状里取文本，容忍 harness 的各种块形状。
 * @param value - 消息、块数组或任意值。
 * @returns 提取出的文本（可能为空）。
 */
export function extractText(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(extractText).filter(Boolean).join('\n')
  if (typeof value !== 'object') return ''
  if (typeof value.text === 'string') return value.text
  if (typeof value.content === 'string') return value.content
  if (Array.isArray(value.content)) return extractText(value.content)
  if (value.message !== undefined) return extractText(value.message)
  return ''
}

/**
 * 把一条会话事件压缩成总督需要的样子（照 session-bridge）。
 * @param event - SessionEvent。
 * @returns 摘要。
 */
export function summariseEvent(event) {
  const data = event?.data ?? {}
  const summary = { seq: event?.seq, time: event?.time, type: event?.type }
  switch (event?.type) {
    case 'user/message':
      summary.role = 'user'
      summary.text = extractText(data).slice(0, MAX_TEXT)
      break
    case 'assistant/message':
      summary.role = 'assistant'
      summary.text = extractText(data.message ?? data).slice(0, MAX_TEXT)
      if (data.usage !== undefined) summary.usage = data.usage
      break
    case 'tool/call':
      summary.role = 'tool-call'
      summary.tool = data.name
      summary.callId = data.callId
      summary.arguments = typeof data.arguments === 'string' ? data.arguments.slice(0, 2000) : undefined
      break
    case 'tool/result':
      summary.role = 'tool-result'
      summary.callId = data.message?.toolCallId ?? data.callId
      summary.isError = data.message?.isError === true || data.error !== undefined
      summary.text = extractText(data.message ?? data).slice(0, MAX_TEXT)
      break
    case 'turn/start':
      summary.turn = data.turn
      break
    case 'turn/end':
      summary.turn = data.turn
      summary.reason = data.reason?.kind ?? data.reason
      break
    default:
      break
  }
  return summary
}

/**
 * 会话当前卡住的待答题（照 session-bridge /answer 的提取手法，附上调用事件的 seq）。
 * @param events - 要扫描的会话事件。
 * @returns `{ callId, seq, questions }`，无待答为 null。
 */
export function pendingQuestion(events) {
  const calls = new Map()
  const answered = new Set()
  for (const event of events) {
    if (event?.type === 'tool/call') calls.set(String(event.data?.callId), event)
    if (event?.type === 'tool/result') {
      answered.add(String(event.data?.message?.toolCallId ?? event.data?.callId))
    }
  }
  const entries = Array.from(calls.entries()).reverse()
  for (const [callId, call] of entries) {
    if (answered.has(callId)) continue
    if (call.data?.name !== 'ask_user_question') continue
    let parsed = null
    try { parsed = JSON.parse(call.data.arguments ?? '') } catch (error) { parsed = null }
    return { callId, seq: call.seq ?? null, questions: parsed?.questions ?? [] }
  }
  return null
}

/**
 * 会话标题，读投影缓存（照 session-bridge）。
 * @param sessionId - 会话 id。
 * @param dir - 配置的投影目录，'' 用默认。
 * @returns 标题或 null。
 */
function readTitle(sessionId, dir) {
  try {
    const base = dir === '' || dir === undefined
      ? join(homedir(), '.dsh', 'storages', 'session_projcache', 'sessions')
      : dir
    const name = String(sessionId).replace(/^session-/, '')
    const parsed = JSON.parse(readFileSync(join(base, `${name}.json`), 'utf8'))
    const title = parsed?.record?.rows?.title?.val
    return typeof title === 'string' && title !== '' ? title.slice(0, 200) : null
  } catch (error) {
    return null
  }
}

/**
 * 活的会话对象，或 undefined。
 * @param ctx - 插件上下文。
 * @param sessionId - 会话 id。
 * @returns Session 或 undefined。
 */
function liveSession(ctx, sessionId) {
  const sessions = ctx.get('sessions')
  if (sessions === undefined || sessions === null || typeof sessions.get !== 'function') return undefined
  return sessions.get(sessionId)
}

/**
 * 会话的运行态（照 session-bridge）。
 * @param ctx - 插件上下文。
 * @param sessionId - 会话 id。
 * @returns true/false，未知为 null。
 */
function runningState(ctx, sessionId) {
  const agents = ctx.get('agents')
  if (agents === undefined || agents === null || typeof agents.get !== 'function') return null
  try {
    const agent = agents.get(sessionId)
    if (agent === undefined || agent === null) return false
    if (typeof agent.status === 'string') return agent.status === 'running'
    if (typeof agent.running === 'boolean') return agent.running
    return null
  } catch (error) {
    return null
  }
}

/**
 * roster 的一行：标题读投影缓存，pendingInteraction 由待答扫描推出。
 * @param ctx - 插件上下文。
 * @param sessionId - 会话 id。
 * @param projectionDir - 投影目录配置。
 * @returns `{ id, title, live, running, pendingInteraction, seq, cwd }`。
 */
export function rosterEntry(ctx, sessionId, projectionDir) {
  const session = liveSession(ctx, sessionId)
  const live = session !== undefined && session !== null
  let pendingInteraction = false
  let seq = null
  let cwd = null
  if (live === true) {
    seq = session.seq ?? null
    cwd = session.header?.cwd ?? null
    const from = Math.max(0, (session.seq ?? 0) - PENDING_SCAN_EVENTS)
    const events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents(from) : []
    pendingInteraction = pendingQuestion(events) !== null
  }
  return {
    id: sessionId,
    title: readTitle(sessionId, projectionDir),
    live,
    running: runningState(ctx, sessionId),
    pendingInteraction,
    seq,
    cwd,
  }
}

/**
 * 一道待答题的题面文本，容忍未知形状。
 * @param question - ask_user_question 的一道题。
 * @returns 文本（可能为空串）。
 */
function questionText(question) {
  if (question === null || typeof question !== 'object') return ''
  const text = question.question ?? question.text ?? question.header ?? question.title ?? question.id
  return text === undefined || text === null ? '' : String(text)
}

/**
 * 一道题的选项列表；提取不到形状时如实返回空数组而不是崩。
 * @param question - ask_user_question 的一道题。
 * @returns `[{ label }]`。
 */
export function questionOptions(question) {
  const options = question?.options
  if (Array.isArray(options) !== true) return []
  return options.map((option) => {
    if (typeof option === 'string') return { label: option }
    if (option !== null && typeof option === 'object') {
      const label = option.label ?? option.text ?? option.value ?? option.name
      return { label: label === undefined || label === null ? '' : String(label) }
    }
    return { label: String(option) }
  })
}

/**
 * 把 /answer 的 choice 归一成 userQuestions.answer 要的 answers 形状。
 * @param choice - 选项 label 字符串，或 { id, selected, custom }，或 { answers: [...] }，或裸数组。
 * @param pending - pendingQuestion 的结果。
 * @returns answers 数组，形状不认识为 null。
 */
export function answersFromChoice(choice, pending) {
  const fallbackId = () => {
    const first = pending?.questions?.[0]
    return typeof first?.id === 'string' && first.id !== '' ? first.id : '0'
  }
  if (typeof choice === 'string' && choice !== '') {
    return [{ id: fallbackId(), selected: [choice] }]
  }
  if (Array.isArray(choice) === true && choice.length > 0) return choice
  if (choice !== null && typeof choice === 'object') {
    if (Array.isArray(choice.answers) === true && choice.answers.length > 0) return choice.answers
    if (Array.isArray(choice.selected) === true && choice.selected.length > 0) {
      const answer = { id: typeof choice.id === 'string' && choice.id !== '' ? choice.id : fallbackId(), selected: choice.selected }
      if (choice.custom !== undefined) answer.custom = choice.custom
      return [answer]
    }
  }
  return null
}

/**
 * 读一个 workspace 的开关；无记录给默认值的副本。
 * @param workspace - 工作区 id。
 * @returns `{ autoAnswer, autostart }`。
 */
export function settingsFor(workspace) {
  const stored = settingsStore.get(workspace)
  return stored === undefined ? { ...DEFAULT_SETTINGS } : { ...stored }
}

/**
 * 绑定文件路径：config.bindsPath 覆盖（测试用），默认 ~/.dsh/governor-binds.json。
 * @param config - 插件配置。
 * @returns 文件绝对路径。
 */
function bindsFile(config) {
  return typeof config.bindsPath === 'string' && config.bindsPath !== ''
    ? config.bindsPath
    : join(homedir(), '.dsh', 'governor-binds.json')
}

/**
 * 读绑定文件；不存在/坏 JSON 一律回空对象。
 * @param file - 绑定文件路径。
 * @returns workspace → bind 的对象。
 */
function readBindsFile(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch (error) {
    return {}
  }
}

/**
 * 读一个工作区的总督绑定：内存覆盖层优先于文件；形状不对视为无绑定。
 * @param file - 绑定文件路径。
 * @param workspace - 工作区 id。
 * @returns `{ governor, workers, updatedAt }` 或 null。
 */
function readBind(file, workspace) {
  const overlay = bindsOverlay.get(workspace)
  const raw = overlay !== undefined ? overlay : readBindsFile(file)[workspace]
  if (raw === null || typeof raw !== 'object' || typeof raw.governor !== 'string' || raw.governor === '') return null
  const workers = Array.isArray(raw.workers)
    ? raw.workers.filter((id) => typeof id === 'string' && id !== '' && id !== raw.governor).slice(0, MAX_WORKERS)
    : []
  return { governor: raw.governor, workers, updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null }
}

/**
 * 写一个工作区的总督绑定：先进内存覆盖层，再尽力落盘（落盘失败静默）。
 * @param file - 绑定文件路径。
 * @param workspace - 工作区 id。
 * @param governor - 总督会话 id。
 * @param workers - 手下会话 id 列表。
 * @returns 写入的绑定。
 */
function writeBind(file, workspace, governor, workers) {
  const entry = {
    governor,
    workers: workers.filter((id) => id !== governor).slice(0, MAX_WORKERS),
    updatedAt: new Date().toISOString(),
  }
  bindsOverlay.set(workspace, entry)
  try {
    const all = readBindsFile(file)
    all[workspace] = entry
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(all, null, 2))
  } catch (error) { /* 落盘失败：内存覆盖层仍生效 */ }
  return entry
}

/**
 * 防御式停止一个会话：agent/session 上的 stop/kill/abort/close 等候选方法逐一尝试，
 * 第一个成功的赢；全部失败如实回报，绝不假装停掉了。
 * @param ctx - 插件上下文。
 * @param sessionId - 会话 id。
 * @returns `{ ok, via }` 或 `{ ok: false, error }`。
 */
export async function stopSession(ctx, sessionId) {
  const candidates = []
  const agents = ctx.get('agents')
  const agent = agents !== undefined && agents !== null && typeof agents.get === 'function' ? agents.get(sessionId) : undefined
  if (agent !== undefined && agent !== null) {
    for (const method of ['stop', 'kill', 'abort', 'cancel', 'interrupt', 'close']) {
      if (typeof agent[method] === 'function') candidates.push({ via: 'agent.' + method, run: () => agent[method]() })
    }
  }
  const session = liveSession(ctx, sessionId)
  if (session !== undefined && session !== null) {
    for (const method of ['stop', 'abort', 'cancel', 'interrupt', 'close']) {
      if (typeof session[method] === 'function') candidates.push({ via: 'session.' + method, run: () => session[method]() })
    }
  }
  const errors = []
  for (const candidate of candidates) {
    try {
      await candidate.run()
      return { ok: true, via: candidate.via }
    } catch (error) {
      errors.push(candidate.via + ' → ' + String(error && error.message).slice(0, 120))
    }
  }
  if (candidates.length === 0) return { ok: false, error: 'no stop method on agent/session for ' + sessionId }
  return { ok: false, error: errors.join(' | ') }
}

/**
 * 手下简报纪律的一次性注入文本（接管老工作区时逐会话发一份）。
 * @param base - 已折凭据的 API 基址。
 * @param workspaceId - 工作区 id。
 * @param sessionId - 手下会话 id。
 * @param workspaceTitle - 工作区名。
 * @returns 提示词文本。
 */
export function workerBriefingPrompt(base, workspaceId, sessionId, workspaceTitle) {
  const url = String(base).replace(/\/+$/, '') + ROUTE_PREFIX + '/report'
  return [
    `你是「${workspaceTitle}」工作区的一名手下会话（本插件的简报纪律，一次性告知）。`,
    '每当用户直接在你这个会话里下达任务、你完成之后，向总督提交一份简报（只是留言进收件箱，不会唤醒总督）：',
    `curl -X POST "${url}" -H "content-type: application/json" -d '{"workspace":"${workspaceId}","session":"${sessionId}","text":"用户输入了什么＋你做了什么＋结果与判据（100字内）"}'`,
  ].join('\n')
}

/**
 * 把一条路由挂上 webServer 通道（plus-menu 的 /api/plus-menu/mcp 与 token-hud
 * 的 /api/token-hud/usage 走的同一条已验证通路）。
 *
 * `register` 的调用形状按插件家族已知形状逐一尝试，全部失败返回 null——
 * 调用方据此知道这条路由没有挂上，绝不假装注册成功。
 *
 * @param webServer - webServer 载体。
 * @param path - 完整路径（/api/governor/…）。
 * @param handler - Node 风格 (req, res) 处理器。
 * @returns 注销函数，或 null。
 */
export function registerOn(webServer, path, handler) {
  const register = webServer?.register
  if (typeof register !== 'function') return null
  const attempts = [
    () => register({ kind: 'exact', path, handler }),
    () => register(path, handler),
    () => register({ path, handler }),
  ]
  for (const attempt of attempts) {
    try {
      const dispose = attempt()
      return typeof dispose === 'function' ? dispose : () => {}
    } catch (error) { /* 试下一种调用形状 */ }
  }
  return null
}

/**
 * 给会话发提示词（/prompt 与 /bootstrap 共用的派发通路）。
 *
 * 底层是 DSH 的 `subagents.prompt`（@Remote），签名未经实测验证，防御式探测：
 * 服务缺失、方法缺失各回明确的 501；方法在则按候选调用形状依次尝试，第一个
 * 不抛错的赢，全失败回 501 并附每个形状的错误——绝不假装成功。
 *
 * @param ctx - 插件上下文。
 * @param sessionId - 目标会话 id。
 * @param text - 提示词全文。
 * @returns `{ ok, via }` 或 `{ ok: false, status, error }`。
 */
export async function promptSession(ctx, sessionId, text) {
  const subagents = ctx.get('subagents')
  if (subagents === undefined || subagents === null) {
    return {
      ok: false,
      status: 501,
      error: "subagents service unavailable: ctx.get('subagents') returned nothing; the DSH profile must expose the subagents @Remote service before prompts can be delivered",
    }
  }
  if (typeof subagents.prompt !== 'function') {
    const visible = Object.keys(subagents).filter((key) => typeof subagents[key] === 'function')
    return {
      ok: false,
      status: 501,
      error: `subagents service has no prompt() method; visible methods: [${visible.join(', ') || 'none'}] — cannot deliver prompts`,
    }
  }
  const attempts = [
    { via: 'prompt(sessionId, text)', run: () => subagents.prompt(sessionId, text) },
    { via: 'prompt({ sessionId, text })', run: () => subagents.prompt({ sessionId, text }) },
    { via: 'prompt({ session, text })', run: () => subagents.prompt({ session: sessionId, text }) },
  ]
  const agents = ctx.get('agents')
  const agent = agents !== undefined && agents !== null && typeof agents.get === 'function' ? agents.get(sessionId) : undefined
  if (agent !== undefined && agent !== null) {
    attempts.push({ via: 'prompt(agent, text)', run: () => subagents.prompt(agent, text) })
  }
  const session = liveSession(ctx, sessionId)
  if (session !== undefined && session !== null) {
    attempts.push({ via: 'prompt(session, text)', run: () => subagents.prompt(session, text) })
  }
  const errors = []
  for (const attempt of attempts) {
    try {
      await attempt.run()
      return { ok: true, via: attempt.via }
    } catch (error) {
      errors.push(`${attempt.via} → ${String(error && error.message).slice(0, 200)}`)
    }
  }
  return {
    ok: false,
    status: 501,
    error: `subagents.prompt exists but every call shape failed: ${errors.join(' | ')}`,
  }
}

/**
 * 把全部路由定义出来并挂上 connection.fetch 通道。
 *
 * 路由处理器全是 Node (req, res) 风格并压进模块级 `routes`，测试可以脱离
 * 真实宿主直接驱动；挂载只是把同一些处理器再注册到通道上。
 *
 * @param ctx - 拥有各服务的上下文（Cordis scope）。
 * @param webServer - webServer 载体（路由注册口）。
 * @param config - 已解析的插件配置。
 * @param connection - 可选的 connection 载体（只用来折提示词里的凭据 URL）。
 * @returns 注销函数。
 */
function mountRoutes(ctx, webServer, config, connection) {
  routes.length = 0
  const resolved = {
    base: String(config.baseUrl === undefined || config.baseUrl === '' ? DEFAULT_BASE_URL : config.baseUrl).replace(/\/+$/, ''),
    sessionProjectionDir: config.sessionProjectionDir ?? '',
    bindsPath: bindsFile(config),
  }
  // 提示词里的 URL 要折进凭据总督会话的 curl 才不吃 401；折不了就原样给。
  try {
    if (connection != null && typeof connection.authenticatedUrl === 'function') {
      resolved.base = String(connection.authenticatedUrl(resolved.base)).replace(/\/+$/, '')
    }
  } catch (error) { /* authenticatedUrl 不可用时退回裸基址 */ }

  const route = (path, methods, handler) => {
    const wrapped = (req, res) => {
      if (methods.includes(req.method) === false) {
        sendJson(res, 405, { ok: false, error: `method-not-allowed: use ${methods.join('/')}` })
        return undefined
      }
      return Promise.resolve(handler(req, res)).catch((error) => {
        sendJson(res, 500, { ok: false, error: String(error && error.message) })
      })
    }
    routes.push({ path, methods, handler: wrapped })
  }
  const serve = (path, handler) => route(path, ['GET', 'HEAD'], handler)
  const servePost = (path, handler) => route(path, ['POST'], handler)

  /** GET /roster —— 会话清单（sessions 为主输入，workspace 仅回显）。 */
  serve(`${ROUTE_PREFIX}/roster`, async (req, res) => {
    const params = new URL(req.url, 'http://127.0.0.1').searchParams
    const ids = parseIdList(params.get('sessions'))
    if (ids.length === 0) {
      sendJson(res, 400, { ok: false, error: 'sessions is required: comma-separated session ids' })
      return
    }
    sendJson(res, 200, {
      ok: true,
      workspace: params.get('workspace') ?? null,
      sessions: ids.map((id) => rosterEntry(ctx, id, resolved.sessionProjectionDir)),
    })
  })

  /** GET /transcript —— 增量事件，游标契约照 session-bridge（seq 即下次 since）。 */
  serve(`${ROUTE_PREFIX}/transcript`, async (req, res) => {
    const params = new URL(req.url, 'http://127.0.0.1').searchParams
    const sessionId = params.get('session')
    if (sessionId === null || sessionId === '') {
      sendJson(res, 400, { ok: false, error: 'session is required' })
      return
    }
    const session = liveSession(ctx, sessionId)
    if (session === undefined || session === null) {
      sendJson(res, 200, { ok: true, session: sessionId, live: false, events: [], seq: null })
      return
    }
    const sinceRaw = Number(params.get('since') ?? '0')
    const since = Number.isFinite(sinceRaw) && sinceRaw > 0 ? sinceRaw : 0
    const events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents(since) : []
    const slice = events.length > MAX_TRANSCRIPT_EVENTS ? events.slice(events.length - MAX_TRANSCRIPT_EVENTS) : events
    sendJson(res, 200, {
      ok: true,
      session: sessionId,
      live: true,
      from: since,
      seq: session.seq ?? null,
      truncated: slice.length !== events.length,
      events: slice.map(summariseEvent),
    })
  })

  /** GET /questions —— 全部待答选择题；提取不到选项形状给空 options 而不是崩。 */
  serve(`${ROUTE_PREFIX}/questions`, async (req, res) => {
    const params = new URL(req.url, 'http://127.0.0.1').searchParams
    const ids = parseIdList(params.get('sessions'))
    if (ids.length === 0) {
      sendJson(res, 400, { ok: false, error: 'sessions is required: comma-separated session ids' })
      return
    }
    const found = []
    for (const id of ids) {
      const session = liveSession(ctx, id)
      if (session === undefined || session === null) continue
      const from = Math.max(0, (session.seq ?? 0) - PENDING_SCAN_EVENTS)
      const events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents(from) : []
      const pending = pendingQuestion(events)
      if (pending === null) continue
      const questions = Array.isArray(pending.questions) ? pending.questions : []
      questions.forEach((question, index) => {
        found.push({
          session: id,
          callId: pending.callId,
          seq: pending.seq,
          id: typeof question?.id === 'string' && question.id !== '' ? question.id : String(index),
          question: questionText(question),
          options: questionOptions(question),
        })
      })
    }
    sendJson(res, 200, { ok: true, questions: found })
  })

  /** POST /prompt —— 给会话发提示词（subagents.prompt，防御式探测）。 */
  servePost(`${ROUTE_PREFIX}/prompt`, async (req, res) => {
    const body = await readJson(req)
    const sessionId = typeof body.session === 'string' ? body.session.trim() : ''
    const text = typeof body.text === 'string' ? body.text : ''
    if (sessionId === '' || text === '') {
      sendJson(res, 400, { ok: false, error: 'session and text are required' })
      return
    }
    const outcome = await promptSession(ctx, sessionId, text)
    if (outcome.ok !== true) {
      sendJson(res, outcome.status, { ok: false, error: outcome.error })
      return
    }
    sendJson(res, 200, { ok: true, session: sessionId, via: outcome.via })
  })

  /** POST /answer —— 替会话答选择题（先 transcript 找 pending，再 userQuestions.answer）。 */
  servePost(`${ROUTE_PREFIX}/answer`, async (req, res) => {
    const body = await readJson(req)
    const sessionId = typeof body.session === 'string' ? body.session.trim() : ''
    if (sessionId === '') {
      sendJson(res, 400, { ok: false, error: 'session is required' })
      return
    }
    const session = liveSession(ctx, sessionId)
    if (session === undefined || session === null) {
      sendJson(res, 409, { ok: false, error: 'session is not live' })
      return
    }
    const from = Math.max(0, (session.seq ?? 0) - PENDING_SCAN_EVENTS)
    const pending = pendingQuestion(typeof session.snapshotEvents === 'function' ? session.snapshotEvents(from) : [])
    if (pending === null) {
      sendJson(res, 409, { ok: false, error: 'nothing is pending' })
      return
    }
    const answers = answersFromChoice(body.choice, pending)
    if (answers === null) {
      sendJson(res, 400, { ok: false, error: 'choice is required: an option label string, { id, selected: [label] }, or { answers: [...] }' })
      return
    }
    const questions = ctx.get('userQuestions')
    const agents = ctx.get('agents')
    if (questions === undefined || questions === null || agents === undefined || agents === null) {
      sendJson(res, 501, { ok: false, error: 'userQuestions/agents service unavailable' })
      return
    }
    const agent = agents.get(sessionId)
    if (agent === undefined || agent === null) {
      sendJson(res, 409, { ok: false, error: 'no live agent for this session' })
      return
    }
    const callId = typeof body.callId === 'string' && body.callId !== '' ? body.callId : pending.callId
    try {
      const still = questions.answer(agent, callId, { answers })
      sendJson(res, 200, { ok: true, session: sessionId, callId, stillContinued: still === true })
    } catch (error) {
      sendJson(res, 409, { ok: false, error: String(error && error.message) })
    }
  })

  /** POST /command —— 在会话内跑斜杠命令（commands.execute）。 */
  servePost(`${ROUTE_PREFIX}/command`, async (req, res) => {
    const body = await readJson(req)
    const sessionId = typeof body.session === 'string' ? body.session.trim() : ''
    const line = typeof body.line === 'string' ? body.line.trim() : ''
    if (sessionId === '' || line === '') {
      sendJson(res, 400, { ok: false, error: 'session and line are required, e.g. "/compact"' })
      return
    }
    const commands = ctx.get('commands')
    const agents = ctx.get('agents')
    if (commands === undefined || commands === null || agents === undefined || agents === null) {
      sendJson(res, 501, { ok: false, error: 'commands/agents service unavailable' })
      return
    }
    const agent = agents.get(sessionId)
    if (agent === undefined || agent === null) {
      sendJson(res, 409, { ok: false, error: 'no live agent for this session' })
      return
    }
    try {
      const controller = new AbortController()
      const result = await commands.execute(agent, line, [], controller.signal)
      sendJson(res, 200, { ok: result !== undefined, ran: result !== undefined })
    } catch (error) {
      sendJson(res, 409, { ok: false, error: String(error && error.message) })
    }
  })

  /** GET/PUT /settings —— 内存态开关，按 workspace 键存取。 */
  route(`${ROUTE_PREFIX}/settings`, ['GET', 'HEAD', 'PUT'], async (req, res) => {
    if (req.method === 'PUT') {
      const body = await readJson(req)
      const workspace = typeof body.workspace === 'string' && body.workspace !== '' ? body.workspace : null
      if (workspace === null) {
        sendJson(res, 400, { ok: false, error: 'workspace is required' })
        return
      }
      const incoming = body.settings
      if (incoming === null || typeof incoming !== 'object' || Array.isArray(incoming)) {
        sendJson(res, 400, { ok: false, error: 'settings must be an object' })
        return
      }
      const next = {}
      for (const key of ['autoAnswer', 'autostart']) {
        if (incoming[key] === undefined) continue
        if (typeof incoming[key] !== 'boolean') {
          sendJson(res, 400, { ok: false, error: `settings.${key} must be a boolean` })
          return
        }
        next[key] = incoming[key]
      }
      const merged = { ...settingsFor(workspace), ...next }
      settingsStore.set(workspace, merged)
      sendJson(res, 200, { ok: true, workspace, settings: merged })
      return
    }
    const params = new URL(req.url, 'http://127.0.0.1').searchParams
    const workspace = params.get('workspace')
    if (workspace === null || workspace === '') {
      sendJson(res, 400, { ok: false, error: 'workspace is required' })
      return
    }
    sendJson(res, 200, { ok: true, workspace, settings: settingsFor(workspace) })
  })

  /** GET /git-state —— 纯读工作区根的 .governor/state.json，绝不执行 git。 */
  serve(`${ROUTE_PREFIX}/git-state`, async (req, res) => {
    const params = new URL(req.url, 'http://127.0.0.1').searchParams
    const sessionId = params.get('session')
    if (sessionId === null || sessionId === '') {
      sendJson(res, 400, { ok: false, error: 'session is required' })
      return
    }
    const session = liveSession(ctx, sessionId)
    const cwd = session?.header?.cwd
    if (typeof cwd !== 'string' || cwd === '') {
      sendJson(res, 200, { ok: true, available: false, reason: 'session has no cwd' })
      return
    }
    try {
      const state = JSON.parse(readFileSync(join(cwd, '.governor', 'state.json'), 'utf8'))
      sendJson(res, 200, { ok: true, available: true, state })
    } catch (error) {
      sendJson(res, 200, { ok: true, available: false, reason: 'no readable .governor/state.json at the workspace root' })
    }
  })

  /** POST /bootstrap —— 生成总督提示词并走 /prompt 同一通路发给会话。 */
  servePost(`${ROUTE_PREFIX}/bootstrap`, async (req, res) => {
    const body = await readJson(req)
    const sessionId = typeof body.session === 'string' ? body.session.trim() : ''
    if (sessionId === '') {
      sendJson(res, 400, { ok: false, error: 'session is required' })
      return
    }
    const workspace = typeof body.workspace === 'string' && body.workspace !== '' ? body.workspace : sessionId
    const title = typeof body.title === 'string' && body.title !== '' ? body.title : workspace
    const sessions = Array.isArray(body.sessions) ? body.sessions : []
    const prompt = buildGovernorPrompt({
      baseUrl: resolved.base,
      workspaceId: workspace,
      workspaceTitle: title,
      sessions,
      settings: settingsFor(workspace),
    })
    const outcome = await promptSession(ctx, sessionId, prompt)
    if (outcome.ok !== true) {
      sendJson(res, outcome.status, { ok: false, error: outcome.error })
      return
    }
    sendJson(res, 200, { ok: true, session: sessionId, length: prompt.length, via: outcome.via })
  })

  /** GET/POST /bind —— 总督绑定：workspace → { governor, workers }，文件持久化。 */
  route(`${ROUTE_PREFIX}/bind`, ['GET', 'HEAD', 'POST'], async (req, res) => {
    if (req.method === 'POST') {
      const body = await readJson(req)
      const workspace = typeof body.workspace === 'string' ? body.workspace.trim() : ''
      const governor = typeof body.governor === 'string' ? body.governor.trim() : ''
      if (workspace === '' || governor === '') {
        sendJson(res, 400, { ok: false, error: 'workspace and governor are required' })
        return
      }
      const workers = Array.isArray(body.workers)
        ? body.workers.filter((id) => typeof id === 'string' && id !== '' && id !== governor).slice(0, MAX_WORKERS)
        : []
      const entry = writeBind(resolved.bindsPath, workspace, governor, workers)
      sendJson(res, 200, { ok: true, workspace, bind: entry })
      return
    }
    const params = new URL(req.url, 'http://127.0.0.1').searchParams
    const workspace = params.get('workspace')
    if (workspace === null || workspace === '') {
      sendJson(res, 400, { ok: false, error: 'workspace is required' })
      return
    }
    sendJson(res, 200, { ok: true, workspace, bind: readBind(resolved.bindsPath, workspace) })
  })

  /**
   * POST /takeover —— 老工作区接管（原子）：新建的总督会话 + 已有会话收编为手下
   * （封顶 8，超出的最旧会话逐个防御式停止），写绑定，注入总督提示词，
   * 并给每个手下一次性注入简报纪律。
   */
  servePost(`${ROUTE_PREFIX}/takeover`, async (req, res) => {
    const body = await readJson(req)
    const workspace = typeof body.workspace === 'string' ? body.workspace.trim() : ''
    const governor = typeof body.governor === 'string' ? body.governor.trim() : ''
    if (workspace === '' || governor === '') {
      sendJson(res, 400, { ok: false, error: 'workspace and governor are required' })
      return
    }
    const title = typeof body.title === 'string' && body.title !== '' ? body.title : workspace
    const sessions = (Array.isArray(body.sessions) ? body.sessions : [])
      .filter((id) => typeof id === 'string' && id !== '' && id !== governor)
    const workers = sessions.slice(Math.max(0, sessions.length - MAX_WORKERS))
    const stale = sessions.slice(0, Math.max(0, sessions.length - MAX_WORKERS))
    const stopped = []
    for (const id of stale) {
      const outcome = await stopSession(ctx, id)
      stopped.push({ session: id, ok: outcome.ok === true, via: outcome.via, error: outcome.error })
    }
    writeBind(resolved.bindsPath, workspace, governor, workers)
    const prompt = buildGovernorPrompt({
      baseUrl: resolved.base,
      workspaceId: workspace,
      workspaceTitle: title,
      sessions: workers,
      settings: settingsFor(workspace),
    })
    const delivered = await promptSession(ctx, governor, prompt)
    let briefed = 0
    for (const id of workers) {
      const outcome = await promptSession(ctx, id, workerBriefingPrompt(resolved.base, workspace, id, title))
      if (outcome.ok === true) briefed += 1
    }
    sendJson(res, 200, {
      ok: true,
      workspace,
      governor,
      workers,
      stopped,
      delivered: delivered.ok === true,
      briefed,
    })
  })

  /** POST /report —— 手下简报收件箱（不唤醒总督，只留言；每工作区封顶 50）。 */
  servePost(`${ROUTE_PREFIX}/report`, async (req, res) => {
    const body = await readJson(req)
    const workspace = typeof body.workspace === 'string' ? body.workspace.trim() : ''
    const session = typeof body.session === 'string' ? body.session.trim() : ''
    const text = typeof body.text === 'string' ? body.text.trim().slice(0, 2000) : ''
    if (workspace === '' || session === '' || text === '') {
      sendJson(res, 400, { ok: false, error: 'workspace, session and text are required' })
      return
    }
    const inbox = reportInbox.get(workspace) ?? []
    inbox.push({ session, text, time: Date.now() })
    while (inbox.length > MAX_REPORTS) inbox.shift()
    reportInbox.set(workspace, inbox)
    sendJson(res, 200, { ok: true, workspace, count: inbox.length })
  })

  /** GET /reports —— 读某工作区的简报收件箱（总督被用户问起时查阅）。 */
  serve(`${ROUTE_PREFIX}/reports`, async (req, res) => {
    const params = new URL(req.url, 'http://127.0.0.1').searchParams
    const workspace = params.get('workspace')
    if (workspace === null || workspace === '') {
      sendJson(res, 400, { ok: false, error: 'workspace is required' })
      return
    }
    sendJson(res, 200, { ok: true, workspace, reports: reportInbox.get(workspace) ?? [] })
  })

  const disposes = []
  for (const entry of routes) {
    const dispose = registerOn(webServer, entry.path, entry.handler)
    if (dispose !== null) disposes.push(dispose)
  }
  return () => {
    for (const dispose of disposes) {
      try { dispose() } catch (error) { /* 注销不许炸 */ }
    }
  }
}

/**
 * 读一个可能不存在的服务。Cordis 的 ctx 是 Proxy：对未注册/未注入的服务名做
 * 裸属性访问会抛 `cannot get property "x" without inject`，所以一律 ctx.get
 * 优先、裸访问只作兜底并全程 try/catch。
 * @param ctx - Cordis 上下文。
 * @param name - 服务名。
 * @returns 服务对象，或 undefined。
 */
function serviceOf(ctx, name) {
  if (ctx === undefined || ctx === null) return undefined
  try {
    if (typeof ctx.get === 'function') {
      const viaGet = ctx.get(name)
      if (viaGet !== undefined && viaGet !== null) return viaGet
    }
  } catch (error) { /* get 不可用时试属性 */ }
  try { return ctx[name] } catch (error) { return undefined }
}

/**
 * 宿主插件体：webServer 载体就绪时挂载全部路由，否则保持惰性。
 * webServer 是 DSH web profile 的真实服务名（plus-menu 同款注入写法）；
 * connection 不是服务名，只作为可选载体防御式尝试，用来折凭据 URL。
 *
 * @param ctx - Cordis 上下文。
 * @param config - profile patch 里的行配置（不导出 Config：resolveConfig 坑）。
 */
export function apply(ctx, config = {}) {
  const safeConfig = config === null || typeof config !== 'object' ? {} : config
  if (typeof ctx?.inject === 'function') {
    // 动态注入：没有 webServer 载体时回调不跑，路由一条都不注册。
    ctx.inject(['webServer'], (scope) => {
      const webServer = serviceOf(scope, 'webServer')
      if (webServer === undefined || webServer === null) return
      const connection = serviceOf(scope, 'connection')
      const dispose = mountRoutes(scope, webServer, safeConfig, connection)
      if (typeof scope?.effect === 'function') {
        scope.effect(() => dispose, 'governor-mode: api routes')
      }
    })
    return
  }
  const webServer = serviceOf(ctx, 'webServer')
  if (webServer === undefined || webServer === null) return
  const connection = serviceOf(ctx, 'connection')
  const dispose = mountRoutes(ctx, webServer, safeConfig, connection)
  if (typeof ctx?.effect === 'function') {
    ctx.effect(() => dispose, 'governor-mode: api routes')
  }
}

/** Cordis 插件名（loader 行 id）。 */
export const name = 'governor-mode'

/**
 * 不声明静态 inject：Cordis 把它当必需服务依赖，DSH web profile 里没有
 * 名为 'connection' 的全局服务，声明即整条目激活失败（全仓其他插件均不声明）。
 * 真正的惰性由 apply 内的动态注入与防御读取保证，服务缺席时静默不注册。
 */

/** 供离线测试用的内部面（照 v1 client.js 的做法）。 */
export const __internals = {
  sendJson, readJson, parseIdList, extractText, summariseEvent, pendingQuestion,
  rosterEntry, questionText, questionOptions, answersFromChoice, settingsFor,
  promptSession, registerOn, DEFAULT_SETTINGS, settingsStore, ROUTE_PREFIX,
  bindsOverlay, readBind, writeBind, stopSession, workerBriefingPrompt,
  reportInbox, MAX_WORKERS, MAX_REPORTS,
}
