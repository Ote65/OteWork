/**
 * dsh-token-hud — host half.
 *
 * One read-only route backs the browser half's token box:
 * `GET /api/token-hud/usage` answers all-time usage, today's usage and the
 * cache hit rate, aggregated from the Session projection cache the harness
 * already maintains for its own usage meters.
 *
 * Why the projection cache and not a live replay: every Session's projection
 * carries `tokenUsage` (its own totals) and `contextActivity` (per-day tokens,
 * requests, and per-provider/model/period token buckets). Reading those is the
 * same numbers the UI's own meters show, costs no log replay, and covers
 * sessions that are not live. Each file is cached by (mtime, size), so a poll
 * only re-reads what actually changed.
 *
 * Only node builtins are imported: the package declares no `@deepseek-ai/dsh-*`
 * peer, so it stays installable on any 0.2.x runtime.
 *
 * @module dsh-token-hud
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** The one route this plugin serves. */
const ROUTE = '/api/token-hud/usage'

/** Cordis plugin name. */
export const name = 'token-hud'

/** Browser display defaults; a profile patch may override them. */
const DISPLAY_DEFAULTS = { enabled: true, intervalMs: 20_000 }

/** Default lifetime of one aggregate before the directory is re-scanned. */
const DEFAULT_CACHE_TTL_MS = 15_000

/** One day, for resolving the "yesterday" day key. */
const DAY_MS = 86_400_000

/**
 * Host plugin body: serve the usage route once the webserver is up.
 * @param ctx - owning Cordis context.
 * @param config - this row's config from the profile patch.
 */
export function apply(ctx, config = {}) {
  const display = normalizeDisplay(config)
  const cacheTtlMs = Math.max(0, finiteOr(config?.cacheTtlMs, DEFAULT_CACHE_TTL_MS))

  ctx.inject(['webServer'], (scope) => {
    scope.effect(
      () => scope.webServer.register({
        kind: 'exact',
        path: ROUTE,
        handler: (req, res) => {
          if (req.method !== 'GET') {
            sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
            return
          }
          snapshot(cacheTtlMs)
            .then((value) => sendJson(res, 200, { ok: true, display, ...value }))
            .catch((error) => sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) }))
        },
      }),
      'token-hud: usage route',
    )
  })
}

/**
 * Read the display config, coercing every field and falling back per field.
 * @param config - the raw row config.
 * @returns the display block the browser half renders with.
 */
function normalizeDisplay(config) {
  const source = config === null || typeof config !== 'object' ? {} : config
  return {
    enabled: source.enabled !== false,
    intervalMs: Math.max(2_000, finiteOr(source.intervalMs, DISPLAY_DEFAULTS.intervalMs)),
  }
}

/** A finite number, or the fallback. */
function finiteOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** The directory holding one projection document per Session. */
function projectionDir() {
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(home, 'storages', 'session_projcache', 'sessions')
}

/** Per-file extraction cache, keyed by file name. */
const fileCache = new Map()

/** The last aggregate, with its timestamp. */
let cached = undefined

/**
 * Aggregate every Session projection into the numbers the box shows.
 * @param cacheTtlMs - how long one aggregate is reused.
 * @returns the snapshot payload (without `ok`).
 */
async function snapshot(cacheTtlMs) {
  if (cacheTtlMs > 0 && cached !== undefined && Date.now() - cached.at < cacheTtlMs) return cached.value

  const dir = projectionDir()
  let names
  try {
    names = await readdir(dir)
  } catch {
    // A profile with no projection cache yet is an empty meter, not an error.
    return emptySnapshot()
  }

  const todayKey = localDateKey(new Date())
  const yesterdayKey = localDateKey(new Date(Date.now() - DAY_MS))
  const totals = { uncachedInput: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  const today = { tokens: 0, requests: 0, peak: 0, off: 0, uncachedInput: 0, cacheRead: 0, output: 0 }
  const yesterday = { tokens: 0, requests: 0 }
  let sessions = 0

  for (const fileName of names) {
    if (!fileName.endsWith('.json')) continue
    const path = join(dir, fileName)
    let info
    try {
      info = await stat(path)
    } catch {
      continue
    }
    let entry = fileCache.get(fileName)
    if (entry === undefined || entry.mtimeMs !== info.mtimeMs || entry.size !== info.size) {
      entry = await extract(path, info)
      fileCache.set(fileName, entry)
    }
    if (entry.totals === undefined) continue
    sessions++

    totals.uncachedInput += entry.totals.uncachedInputTokens ?? 0
    totals.output += entry.totals.outputTokens ?? 0
    totals.cacheRead += entry.totals.cacheReadTokens ?? 0
    totals.cacheWrite += entry.totals.cacheWriteTokens ?? 0

    // Both days are read before the `continue`, so a Session that has no bucket
    // for today still contributes to yesterday's total.
    const days = entry.days
    const previous = days === undefined ? undefined : days[yesterdayKey]
    if (previous !== undefined) {
      yesterday.tokens += numberOr(previous.tokens, 0)
      yesterday.requests += numberOr(previous.requests, 0)
    }

    const day = days === undefined ? undefined : days[todayKey]
    if (day === undefined) continue
    today.tokens += numberOr(day.tokens, 0)
    today.requests += numberOr(day.requests, 0)
    for (const providers of Object.values(day.cost ?? {})) {
      for (const models of Object.values(providers ?? {})) {
        for (const [period, bucket] of Object.entries(models ?? {})) {
          const sum = numberOr(bucket?.uncached, 0) + numberOr(bucket?.cacheRead, 0)
            + numberOr(bucket?.cacheWrite, 0) + numberOr(bucket?.output, 0)
          if (period === 'peak') today.peak += sum
          else today.off += sum
          today.uncachedInput += numberOr(bucket?.uncached, 0)
          today.cacheRead += numberOr(bucket?.cacheRead, 0)
          today.output += numberOr(bucket?.output, 0)
        }
      }
    }
  }

  const value = {
    generatedAt: Date.now(),
    sessions,
    total: { ...totals, tokens: totals.uncachedInput + totals.output + totals.cacheRead + totals.cacheWrite },
    today: {
      ...today,
      date: todayKey,
      cacheHitRate: hitRate(today.cacheRead, today.uncachedInput),
    },
    yesterday: { ...yesterday, date: yesterdayKey },
    // Day-over-day movement, for the card's trend chip. `null` when there is no
    // previous day to compare against — the browser half hides the chip rather
    // than inventing a number.
    trendPercentage: yesterday.tokens === 0
      ? null
      : ((today.tokens - yesterday.tokens) / yesterday.tokens) * 100,
    cacheHitRate: hitRate(totals.cacheRead, totals.uncachedInput),
  }
  cached = { at: Date.now(), value }
  return value
}

/**
 * Extract the two projection rows this plugin needs from one document.
 * A file that is mid-write or carries no usage rows yields an empty entry, so
 * the aggregate simply skips it instead of failing the whole request.
 * @param path - absolute document path.
 * @param info - its stat result.
 * @returns the cache entry.
 */
async function extract(path, info) {
  const base = { mtimeMs: info.mtimeMs, size: info.size }
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return base
  }
  let document
  try {
    document = JSON.parse(text)
  } catch {
    return base
  }
  const rows = document?.record?.rows
  return {
    ...base,
    totals: rows?.tokenUsage?.val?.totals,
    days: rows?.contextActivity?.val?.days,
  }
}

/** The payload for a profile whose projection cache is absent or empty. */
function emptySnapshot() {
  return {
    generatedAt: Date.now(),
    sessions: 0,
    total: { uncachedInput: 0, output: 0, cacheRead: 0, cacheWrite: 0, tokens: 0 },
    today: { tokens: 0, requests: 0, peak: 0, off: 0, uncachedInput: 0, cacheRead: 0, output: 0, date: localDateKey(new Date()), cacheHitRate: 0 },
    yesterday: { tokens: 0, requests: 0, date: localDateKey(new Date(Date.now() - DAY_MS)) },
    trendPercentage: null,
    cacheHitRate: 0,
  }
}

/**
 * Cache hit rate over input tokens: the share of prompt tokens served from
 * cache rather than sent uncached.
 * @param cacheRead - cached prompt tokens.
 * @param uncachedInput - prompt tokens sent uncached.
 * @returns a 0..1 ratio, or 0 when no input was measured.
 */
function hitRate(cacheRead, uncachedInput) {
  const denominator = cacheRead + uncachedInput
  return denominator === 0 ? 0 : cacheRead / denominator
}

/** A finite number, or the fallback. */
function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * The projection's day key, in the same local-date form it writes.
 * @param date - the instant to key.
 * @returns `YYYY-MM-DD` in local time.
 */
function localDateKey(date) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * Write one JSON response.
 * @param res - Node response.
 * @param status - HTTP status.
 * @param body - JSON-serializable body.
 */
function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}
