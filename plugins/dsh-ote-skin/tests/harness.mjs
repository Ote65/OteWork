/** Tiny zero-dependency test harness: no framework, no config, exit code only. */

/**
 * Start a named suite of checks.
 * @param name - the suite label.
 * @returns an object with `check`/`checkAsync`/`report`.
 */
export function createSuite(name) {
  const results = []
  return {
    name,
    check(label, body) {
      try {
        body()
        results.push({ label, ok: true })
      } catch (error) {
        results.push({ label, ok: false, error })
      }
    },
    async checkAsync(label, body) {
      try {
        await body()
        results.push({ label, ok: true })
      } catch (error) {
        results.push({ label, ok: false, error })
      }
    },
    report() {
      const failed = results.filter((entry) => entry.ok === false)
      for (const entry of failed) {
        console.log(`  FAIL  ${entry.label}`)
        console.log(`        ${entry.error instanceof Error ? entry.error.message : String(entry.error)}`)
      }
      console.log(`${name}: ${results.length - failed.length}/${results.length} passed`)
      return failed.length
    },
  }
}

export function assert(condition, message) {
  if (condition !== true) throw new Error(message ?? 'assertion failed')
}

export function equal(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message ?? 'not equal'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

export function includes(haystack, needle, message) {
  if (String(haystack).includes(needle) !== true) {
    throw new Error(`${message ?? 'missing'}: ${JSON.stringify(needle)} not in ${JSON.stringify(String(haystack).slice(0, 400))}`)
  }
}

/** Wait for microtasks to settle. */
export function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}
