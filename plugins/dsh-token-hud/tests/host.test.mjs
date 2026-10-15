/** Host-half checks: aggregation, caching, config normalization, HTTP shape. */

import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, close, createSuite, equal } from './harness.mjs'

/**
 * The projection's own local-date key.
 * @param date - the instant.
 * @returns `YYYY-MM-DD`.
 */
function localDateKey(date) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * Apply the host plugin with a capturing fake context.
 * @param config - the row config.
 * @returns the captured routes and the module.
 */
async function capture(config) {
  const module = await import('../lib/index.js')
  const routes = []
  const effects = []
  const ctx = {
    inject(services, body) {
      assert(Array.isArray(services) && services.includes('webServer'), 'injects webServer')
      body({
        effect(fn, label) {
          effects.push({ label, dispose: fn() })
        },
        webServer: {
          register(route) {
            routes.push(route)
            return () => {}
          },
        },
      })
    },
  }
  module.apply(ctx, config)
  assert(routes.length === 1, 'registers exactly one route')
  return { routes, effects, module }
}

/**
 * Drive a captured route once.
 * @param route - the registered route.
 * @param method - the HTTP method.
 * @returns the status and parsed body.
 */
function request(route, method = 'GET') {
  return new Promise((resolve) => {
    const res = {
      writeHead(status) {
        this.status = status
      },
      end(text) {
        resolve({ status: this.status, body: JSON.parse(text) })
      },
    }
    route.handler({ method }, res)
  })
}

/** One session document carrying the two projection rows the plugin reads. */
function documentFor(totals, day) {
  return JSON.stringify({
    record: {
      rows: {
        tokenUsage: { val: { totals } },
        contextActivity: { val: { days: day } },
      },
    },
  })
}

/**
 * Run the host suite.
 * @param report - the shared reporter.
 */
export async function run(report) {
  const suite = createSuite('host')
  const root = await mkdtemp(join(tmpdir(), 'token-hud-host-'))
  const dir = join(root, 'storages', 'session_projcache', 'sessions')
  await mkdir(dir, { recursive: true })
  process.env.DSH_HOME = root
  const today = localDateKey(new Date())
  const yesterday = localDateKey(new Date(Date.now() - 86_400_000))

  const bucket = (period) => ({
    [period]: { uncached: period === 'off' ? 100 : 200, cacheRead: period === 'off' ? 850 : 700, cacheWrite: 0, output: period === 'off' ? 50 : 100 },
  })

  await writeFile(join(dir, 'session-a.json'), documentFor(
    { uncachedInputTokens: 100, outputTokens: 50, cacheReadTokens: 850, cacheWriteTokens: 0 },
    {
      [today]: { tokens: 1000, requests: 3, cost: { deepseek: { flash: bucket('off') } } },
      // The previous day, so the trend chip has a baseline to compare against.
      [yesterday]: { tokens: 500, requests: 4 },
    },
  ))
  await writeFile(join(dir, 'session-b.json'), documentFor(
    { uncachedInputTokens: 200, outputTokens: 100, cacheReadTokens: 700, cacheWriteTokens: 0 },
    { [today]: { tokens: 1000, requests: 2, cost: { deepseek: { flash: bucket('peak') } } } },
  ))
  // A document with no usage rows at all.
  await writeFile(join(dir, 'session-c.json'), JSON.stringify({ record: { rows: { title: { val: 'x' } } } }))
  // A truncated document: mid-write, must be skipped rather than fatal.
  await writeFile(join(dir, 'session-d.json'), '{"record":{"rows":{"tokenUsage":{"val":')
  // A non-JSON neighbour.
  await writeFile(join(dir, 'notes.txt'), 'ignore me')

  const { routes, effects } = await capture({})
  const first = await request(routes[0])

  await suite.checkAsync('route answers ok with one route registered', async () => {
    equal(routes[0].path, '/api/token-hud/usage', 'route path')
    equal(routes[0].kind, 'exact', 'route kind')
    equal(first.status, 200, 'status')
    equal(first.body.ok, true, 'ok flag')
  })

  await suite.checkAsync('counts only documents that carry usage rows', async () => {
    equal(first.body.sessions, 2, 'sessions')
  })

  await suite.checkAsync('sums all-time totals across sessions', async () => {
    equal(first.body.total.uncachedInput, 300, 'uncachedInput')
    equal(first.body.total.output, 150, 'output')
    equal(first.body.total.cacheRead, 1550, 'cacheRead')
    equal(first.body.total.cacheWrite, 0, 'cacheWrite')
    equal(first.body.total.tokens, 2000, 'tokens')
  })

  await suite.checkAsync("aggregates today's bucket and its peak/off split", async () => {
    equal(first.body.today.date, today, 'date')
    equal(first.body.today.tokens, 2000, 'tokens')
    equal(first.body.today.requests, 5, 'requests')
    equal(first.body.today.peak, 1000, 'peak')
    equal(first.body.today.off, 1000, 'off')
    equal(first.body.today.uncachedInput, 300, 'uncachedInput')
    equal(first.body.today.cacheRead, 1550, 'cacheRead')
    equal(first.body.today.output, 150, 'output')
  })

  await suite.checkAsync('reports yesterday and the day-over-day trend', async () => {
    equal(first.body.yesterday.date, yesterday, 'yesterday date')
    equal(first.body.yesterday.tokens, 500, 'yesterday tokens')
    equal(first.body.yesterday.requests, 4, 'yesterday requests')
    // 2000 today against 500 yesterday.
    close(first.body.trendPercentage, 300, 1e-9, 'trend')
  })

  await suite.checkAsync('computes the cache hit rate over input tokens', async () => {
    close(first.body.cacheHitRate, 1550 / 1850, 1e-9, 'cacheHitRate')
    close(first.body.today.cacheHitRate, 1550 / 1850, 1e-9, 'today cacheHitRate')
  })

  await suite.checkAsync('exposes display defaults', async () => {
    equal(first.body.display.enabled, true, 'enabled')
    equal(first.body.display.intervalMs, 20000, 'intervalMs')
  })

  await suite.checkAsync('rejects a non-GET request', async () => {
    const response = await request(routes[0], 'POST')
    equal(response.status, 405, 'status')
    equal(response.body.ok, false, 'ok flag')
  })

  await suite.checkAsync('normalizes an out-of-range display config', async () => {
    const second = await capture({ enabled: false, intervalMs: 100 })
    const response = await request(second.routes[0])
    equal(response.body.display.enabled, false, 'enabled')
    equal(response.body.display.intervalMs, 2000, 'intervalMs floors at 2000')
  })

  await suite.checkAsync('registers a disposable effect', async () => {
    equal(effects.length, 1, 'one effect')
    equal(typeof effects[0].dispose, 'function', 'dispose is callable')
    effects[0].dispose()
  })

  await suite.checkAsync('serves an empty meter when the cache directory is absent', async () => {
    process.env.DSH_HOME = join(root, 'nowhere')
    const third = await capture({ cacheTtlMs: 0 })
    const response = await request(third.routes[0])
    equal(response.status, 200, 'status')
    equal(response.body.ok, true, 'ok flag')
    equal(response.body.sessions, 0, 'sessions')
    equal(response.body.total.tokens, 0, 'tokens')
    equal(response.body.cacheHitRate, 0, 'cacheHitRate')
    process.env.DSH_HOME = root
  })

  await suite.checkAsync('reuses one aggregate inside the cache TTL', async () => {
    const fourth = await capture({ cacheTtlMs: 60000 })
    const a = await request(fourth.routes[0])
    await rm(dir, { recursive: true, force: true })
    const b = await request(fourth.routes[0])
    equal(b.body.sessions, a.body.sessions, 'sessions still cached')
    equal(b.body.total.tokens, a.body.total.tokens, 'totals still cached')
    await mkdir(dir, { recursive: true })
  })

  await suite.checkAsync('re-scans once the TTL has elapsed', async () => {
    const fifth = await capture({ cacheTtlMs: 0 })
    const a = await request(fifth.routes[0])
    equal(a.body.sessions, 0, 'empty after deletion')
    await writeFile(join(dir, 'session-a.json'), documentFor(
      { uncachedInputTokens: 10, outputTokens: 5, cacheReadTokens: 85, cacheWriteTokens: 0 },
      { [today]: { tokens: 100, requests: 1, cost: { deepseek: { flash: { off: { uncached: 10, cacheRead: 85, cacheWrite: 0, output: 5 } } } } } },
    ))
    const b = await request(fifth.routes[0])
    equal(b.body.sessions, 1, 'picks the new document up')
    equal(b.body.total.tokens, 100, 'tokens')
  })

  await suite.checkAsync('re-reads a file whose mtime changed', async () => {
    const sixth = await capture({ cacheTtlMs: 0 })
    const path = join(dir, 'session-a.json')
    const a = await request(sixth.routes[0])
    equal(a.body.total.tokens, 100, 'first read')
    await writeFile(path, documentFor(
      { uncachedInputTokens: 20, outputTokens: 10, cacheReadTokens: 170, cacheWriteTokens: 0 },
      { [today]: { tokens: 200, requests: 2, cost: {} } },
    ))
    const future = new Date(Date.now() + 5000)
    await utimes(path, future, future)
    const b = await request(sixth.routes[0])
    equal(b.body.total.tokens, 200, 'second read')
    equal(b.body.today.tokens, 200, 'today')
    // The rewritten document carries no previous day, so the chip has no number
    // to show — `null`, never a fabricated one.
    equal(b.body.yesterday.tokens, 0, 'no previous day')
    equal(b.body.trendPercentage, null, 'no trend without a baseline')
  })

  await rm(root, { recursive: true, force: true })
  report(suite)
}
