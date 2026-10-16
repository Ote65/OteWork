/**
 * dsh-governor-mode —— 宿主半（/api/governor 控制平面）。
 *
 * 路由十二条：roster / transcript / questions / prompt / answer / command / settings /
 * git-state / bootstrap / bind（workspace→总督会话的最小映射），加 team（读官方
 * Agent Teams 投影）/ spawn（经官方 agentTeams 服务新建队友）。团队关系本身
 * （成员上限 8、信箱派发、任务板、中断）全部由官方 dsh-experimental-agent-team
 * 服务负责，本插件只读它的面、不另造一套。全部挂在 DSH web profile
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

/** 提示词里 URL 的默认基址（DSH Web GUI 的环回端口）。 */
const DEFAULT_BASE_URL = 'http://127.0.0.1:19387'

/** /settings 的默认值（内存态，无记录即默认）。reportMode：wake＝手下完工给总督发消息（官方默认，会唤醒总督）；quiet＝只记任务板，不打扰总督。 */
export const DEFAULT_SETTINGS = { autoAnswer: false, autostart: true, reportMode: 'wake' }

/** 官方团队层的成员上限（profile patch 里 maxMembers: 8），仅用于面板展示与提示词文案。 */
const MAX_WORKERS = 8

/** 本插件的路由表，供测试直接驱动（照 session-bridge）。 */
export const routes = []

/** 开关存储：workspace → { autoAnswer, autostart, reportMode }。内存态，卸载即失效。 */
const settingsStore = new Map()

/** 总督映射内存覆盖层：workspace → { governor, updatedAt }（落盘失败仍生效）。 */
const bindsOverlay = new Map()

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
 * 读一个工作区的总督会话映射：内存覆盖层优先于文件；形状不对视为无映射。
 * 手下（队友）关系不在这里——那是官方 agentTeams 花名册的唯一真源。
 * @param file - 绑定文件路径。
 * @param workspace - 工作区 id。
 * @returns `{ governor, updatedAt }` 或 null。
 */
function readBind(file, workspace) {
  const overlay = bindsOverlay.get(workspace)
  const raw = overlay !== undefined ? overlay : readBindsFile(file)[workspace]
  if (raw === null || typeof raw !== 'object') return null
  const governor = typeof raw.governor === 'string' && raw.governor !== '' ? raw.governor : (typeof raw === 'string' && raw !== '' ? raw : '')
  if (governor === '') return null
  return { governor, updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null }
}

/**
 * 写一个工作区的总督会话映射：先进内存覆盖层，再尽力落盘（落盘失败静默）。
 * @param file - 绑定文件路径。
 * @param workspace - 工作区 id。
 * @param governor - 总督会话 id。
 * @returns 写入的映射。
 */
function writeBind(file, workspace, governor) {
  const entry = { governor, updatedAt: new Date().toISOString() }
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
 * 把总督会话事件流里的官方 team/* 事件折叠成花名册与任务板（照
 * dsh-experimental-agent-team 投影的最小复制，只读不写）。形状不认识的事件
 * 一律跳过，绝不崩；成员上限的真相在官方服务里，这里只是展示用投影。
 * @param events - 总督会话的事件数组。
 * @returns `{ members, tasks, queued, delivered }`。
 */
export function foldTeamEvents(events) {
  const members = []
  const tasks = new Map()
  const queued = []
  const delivered = new Set()
  const list = Array.isArray(events) ? events : []
  for (const event of list) {
    const data = event?.data
    if (data === null || typeof data !== 'object') continue
    switch (event?.type) {
      case 'team/member': {
        const member = data.member
        if (member === null || typeof member !== 'object' || typeof member.id !== 'string') break
        const index = members.findIndex((candidate) => candidate.id === member.id)
        const row = {
          id: member.id,
          name: typeof member.name === 'string' ? member.name : '',
          phase: member.phase === 'active' || member.phase === 'failed' ? member.phase : 'provisioning',
          description: typeof member.description === 'string' ? member.description : '',
          context: member.context === 'fork' ? 'fork' : 'fresh',
        }
        if (index < 0) members.push(row)
        else members[index] = row
        break
      }
      case 'team/task': {
        const task = data.task
        if (task === null || typeof task !== 'object' || typeof task.id !== 'string') break
        tasks.set(task.id, {
          id: task.id,
          revision: Number.isFinite(task.revision) ? task.revision : 0,
          subject: typeof task.subject === 'string' ? task.subject : '',
          status: task.status === 'in_progress' || task.status === 'completed' || task.status === 'deleted' ? task.status : 'pending',
          ownerId: typeof task.ownerId === 'string' ? task.ownerId : null,
        })
        break
      }
      case 'team/message/queued': {
        const message = data.message
        if (message === null || typeof message !== 'object' || typeof message.id !== 'string') break
        queued.push({ id: message.id, senderName: typeof message.senderName === 'string' ? message.senderName : '', targetId: typeof message.targetId === 'string' ? message.targetId : '' })
        break
      }
      case 'team/message/delivered':
        if (typeof data.messageId === 'string') delivered.add(data.messageId)
        break
      default:
        break
    }
  }
  return {
    members,
    tasks: Array.from(tasks.values()).filter((task) => task.status !== 'deleted'),
    queued,
    delivered: Array.from(delivered),
  }
}

/**
 * 经面板 /spawn 新建队友时附加的一次性纪律文本（官方工具自带的身份提醒之外，
 * 补上欧创的 git 纪律与按 reportMode 的汇报方式）。
 * @param workspaceTitle - 工作区名。
 * @param reportMode - 'wake' | 'quiet'。
 * @returns 纪律文本。
 */
export function teammateBriefing(workspaceTitle, reportMode) {
  const lines = [
    `（欧创总督模式纪律，一次性告知）你在「${workspaceTitle}」工作区当队友，总督会话是你们的 Team Lead。`,
    '- 改动只在 `sub/<你的队友名>` 分支上做，不碰 dev、不碰 release；结论先行汇报，证据挂文件:行号。',
  ]
  if (reportMode === 'quiet') {
    lines.push('- 完工后把结果写进共享任务板（team_task_update complete，描述里写清用户输入了什么、你做了什么、结果如何），**不要**给 lead 发消息——总督只在用户问起时读任务板。')
  } else {
    lines.push('- 完工后用 send_message({ target: "lead" }) 交简报：用户输入了什么、你做了什么、结果与判据（100 字内）。')
  }
  return lines.join('\n')
}

/**
 * 经官方 agentTeams 信箱给队友/总督发消息（/prompt 的原生通路）。
 * 服务缺席或总督 agent 不在场时回 `{ ok:false, fatal:false }`（调用方退回老路）；
 * 服务在、调用抛错（如队友名不认识）回 fatal 409，如实回报。
 * @param ctx - 插件上下文。
 * @param leadId - 总督会话 id（作为 caller 的活 agent）。
 * @param targetName - 队友名或 "lead"。
 * @param text - 消息正文。
 * @returns `{ ok, via, status }` 或 `{ ok:false, fatal, status?, error? }`。
 */
async function teamSend(ctx, leadId, targetName, text) {
  const teams = ctx.get('agentTeams')
  if (teams === undefined || teams === null || typeof teams.sendMessage !== 'function') return { ok: false, fatal: false }
  const agents = ctx.get('agents')
  const caller = agents !== undefined && agents !== null && typeof agents.get === 'function' ? agents.get(leadId) : undefined
  if (caller === undefined || caller === null) return { ok: false, fatal: false }
  try {
    const result = await teams.sendMessage(caller, {
      target: targetName,
      content: [{ type: 'text', text }],
      signal: new AbortController().signal,
    })
    return { ok: true, via: 'agentTeams.sendMessage', status: result !== null && typeof result === 'object' ? result.status : undefined }
  } catch (error) {
    return { ok: false, fatal: true, status: 409, error: String(error && error.message) }
  }
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
  if (webServer === undefined || webServer === null || typeof webServer.register !== 'function') return null
  const attempts = [
    () => webServer.register({ kind: 'exact', path, handler }),
    () => webServer.register(path, handler),
    () => webServer.register({ path, handler }),
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

  /**
   * POST /prompt —— 给会话发提示词。带 {lead, target} 时优先走官方 agentTeams
   * 信箱（sendMessage）：在跑的队友在最近步骤边界收消息、不打断，不在跑的会被
   * 唤醒——这就是原生「待发区」。官方通路缺席时退回 subagents.prompt 老路。
   */
  servePost(`${ROUTE_PREFIX}/prompt`, async (req, res) => {
    const body = await readJson(req)
    const text = typeof body.text === 'string' ? body.text : ''
    if (text === '') {
      sendJson(res, 400, { ok: false, error: 'text is required' })
      return
    }
    const lead = typeof body.lead === 'string' ? body.lead.trim() : ''
    const target = typeof body.target === 'string' ? body.target.trim() : ''
    if (lead !== '' && target !== '') {
      const viaTeam = await teamSend(ctx, lead, target, text)
      if (viaTeam.ok === true) {
        sendJson(res, 200, { ok: true, lead, target, via: viaTeam.via, status: viaTeam.status ?? null })
        return
      }
      if (viaTeam.fatal === true) {
        sendJson(res, viaTeam.status, { ok: false, error: viaTeam.error })
        return
      }
    }
    const sessionId = typeof body.session === 'string' ? body.session.trim() : ''
    if (sessionId === '') {
      sendJson(res, 400, { ok: false, error: 'session is required when lead+target are absent' })
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
      if (incoming.reportMode !== undefined) {
        if (incoming.reportMode !== 'wake' && incoming.reportMode !== 'quiet') {
          sendJson(res, 400, { ok: false, error: 'settings.reportMode must be "wake" or "quiet"' })
          return
        }
        next.reportMode = incoming.reportMode
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

  /** GET/POST /bind —— workspace → 总督会话的最小映射（谁是总督）；手下关系在官方花名册里。 */
  route(`${ROUTE_PREFIX}/bind`, ['GET', 'HEAD', 'POST'], async (req, res) => {
    if (req.method === 'POST') {
      const body = await readJson(req)
      const workspace = typeof body.workspace === 'string' ? body.workspace.trim() : ''
      const governor = typeof body.governor === 'string' ? body.governor.trim() : ''
      if (workspace === '' || governor === '') {
        sendJson(res, 400, { ok: false, error: 'workspace and governor are required' })
        return
      }
      const entry = writeBind(resolved.bindsPath, workspace, governor)
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

  /** GET /team —— 从总督会话事件流折叠官方团队花名册与任务板（独立 fold，不依赖服务在场）。 */
  serve(`${ROUTE_PREFIX}/team`, async (req, res) => {
    const params = new URL(req.url, 'http://127.0.0.1').searchParams
    const sessionId = params.get('session')
    if (sessionId === null || sessionId === '') {
      sendJson(res, 400, { ok: false, error: 'session is required' })
      return
    }
    const session = liveSession(ctx, sessionId)
    if (session === undefined || session === null) {
      sendJson(res, 200, { ok: true, session: sessionId, live: false, members: [], tasks: [], queued: [], delivered: [], maxMembers: MAX_WORKERS })
      return
    }
    const events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents(0) : []
    const team = foldTeamEvents(events)
    sendJson(res, 200, {
      ok: true,
      session: sessionId,
      live: true,
      members: team.members,
      tasks: team.tasks,
      queued: team.queued,
      delivered: team.delivered,
      maxMembers: MAX_WORKERS,
    })
  })

  /** POST /spawn —— 经官方 agentTeams 服务新建队友（上限 8 由官方校验，超限如实回错）。 */
  servePost(`${ROUTE_PREFIX}/spawn`, async (req, res) => {
    const body = await readJson(req)
    const lead = typeof body.lead === 'string' ? body.lead.trim() : ''
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (lead === '' || name === '') {
      sendJson(res, 400, { ok: false, error: 'lead and name are required' })
      return
    }
    const teams = ctx.get('agentTeams')
    if (teams === undefined || teams === null || typeof teams.spawnTeammate !== 'function') {
      sendJson(res, 501, { ok: false, error: 'agentTeams service unavailable: the official Agent Teams layer is not enabled' })
      return
    }
    const agents = ctx.get('agents')
    const caller = agents !== undefined && agents !== null && typeof agents.get === 'function' ? agents.get(lead) : undefined
    if (caller === undefined || caller === null) {
      sendJson(res, 409, { ok: false, error: 'no live agent for the governor session: open it first, then spawn' })
      return
    }
    const workspace = typeof body.workspace === 'string' && body.workspace !== '' ? body.workspace : lead
    const title = typeof body.title === 'string' && body.title !== '' ? body.title : workspace
    const description = typeof body.description === 'string' && body.description !== '' ? body.description : name
    const prompt = typeof body.prompt === 'string' && body.prompt !== '' ? body.prompt : '待命：等待总督派发任务。'
    try {
      const result = await teams.spawnTeammate(caller, {
        name,
        description,
        prompt: [{ type: 'text', text: `${prompt}\n\n${teammateBriefing(title, settingsFor(workspace).reportMode)}` }],
        context: body.context === 'fork' ? 'fork' : 'fresh',
        signal: new AbortController().signal,
      })
      sendJson(res, 200, { ok: true, lead, member: result !== null && typeof result === 'object' && result.member !== undefined ? result.member : null })
    } catch (error) {
      sendJson(res, 409, { ok: false, error: String(error && error.message) })
    }
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
      if (typeof scope?.effect === 'function') {
        // 照 token-hud 已验证通路：注册本身在 effect 里执行，effect 收 dispose。
        scope.effect(() => mountRoutes(scope, webServer, safeConfig, connection), 'governor-mode: api routes')
      } else {
        mountRoutes(scope, webServer, safeConfig, connection)
      }
    })
    return
  }
  const webServer = serviceOf(ctx, 'webServer')
  if (webServer === undefined || webServer === null) return
  const connection = serviceOf(ctx, 'connection')
  if (typeof ctx?.effect === 'function') {
    ctx.effect(() => mountRoutes(ctx, webServer, safeConfig, connection), 'governor-mode: api routes')
  } else {
    mountRoutes(ctx, webServer, safeConfig, connection)
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
  bindsOverlay, readBind, writeBind, foldTeamEvents, teammateBriefing,
  teamSend, MAX_WORKERS,
}
