/**
 * MCP stdio probe: spawn a server, do the JSON-RPC handshake, list its tools.
 * Proves the exact transport the dsh-mcp-client bridge will use.
 *
 * Usage: node tests/probe-mcp.mjs [command] [args...]
 * Defaults to the `everything` server this profile ships in its MCP config.
 */
import { spawn } from 'node:child_process'

const command = process.argv[2] ?? 'npx'
const args = process.argv.length > 2 ? process.argv.slice(3) : ['-y', '@modelcontextprotocol/server-everything']

console.log(`spawn: ${command} ${args.join(' ')}`)
const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], shell: process.platform === 'win32' })

let buffer = ''
const pending = new Map()
const stderr = []

child.stderr.on('data', (chunk) => stderr.push(String(chunk)))
child.on('error', (error) => { console.log(`spawn error: ${error.message}`); process.exit(2) })
child.on('exit', (code, signal) => { console.log(`child exited code=${code} signal=${signal}`) })

child.stdout.on('data', (chunk) => {
  buffer += String(chunk)
  let index
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (line === '') continue
    let message
    try { message = JSON.parse(line) } catch { console.log(`  (non-JSON line) ${line.slice(0, 120)}`); continue }
    const resolve = pending.get(message.id)
    if (resolve !== undefined) { pending.delete(message.id); resolve(message) }
    else console.log(`  (notification) ${JSON.stringify(message).slice(0, 120)}`)
  }
})

let nextId = 1
function send(method, params) {
  const id = nextId++
  const payload = { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout waiting for ${method}`)) }, 120_000)
    pending.set(id, (message) => { clearTimeout(timer); resolve(message) })
    child.stdin.write(`${JSON.stringify(payload)}\n`)
  })
}
function notify(method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) })}\n`)
}

try {
  const init = await send('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'plus-menu-probe', version: '0.0.1' },
  })
  if (init.error !== undefined) throw new Error(`initialize failed: ${JSON.stringify(init.error)}`)
  console.log(`server: ${init.result.serverInfo.name} ${init.result.serverInfo.version}`)
  console.log(`protocol: ${init.result.protocolVersion}`)
  console.log(`capabilities: ${Object.keys(init.result.capabilities ?? {}).join(', ')}`)

  notify('notifications/initialized')

  const tools = await send('tools/list', {})
  if (tools.error !== undefined) throw new Error(`tools/list failed: ${JSON.stringify(tools.error)}`)
  const list = tools.result.tools ?? []
  console.log(`\ntools (${list.length}):`)
  for (const tool of list) console.log(`  - ${tool.name}: ${String(tool.description ?? '').slice(0, 80)}`)

  const resources = await send('resources/list', {}).catch(() => ({ result: { resources: [] } }))
  const resourceList = resources.result?.resources ?? []
  console.log(`\nresources (${resourceList.length}):`)
  for (const resource of resourceList.slice(0, 10)) console.log(`  - ${resource.uri} (${resource.name ?? ''})`)

  const echo = list.find((tool) => tool.name === 'echo')
  if (echo !== undefined) {
    const called = await send('tools/call', { name: 'echo', arguments: { message: 'plus-menu probe' } })
    console.log(`\necho call -> ${JSON.stringify(called.result ?? called.error).slice(0, 200)}`)
  }

  console.log('\nPROBE OK')
  child.kill()
  process.exit(0)
} catch (error) {
  console.log(`\nPROBE FAILED: ${error.message}`)
  if (stderr.length > 0) console.log(`stderr:\n${stderr.join('').slice(-2000)}`)
  child.kill()
  process.exit(1)
}
