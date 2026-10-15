/** Tiny zero-dependency test harness: no framework, no config, exit code only. */

/**
 * Start a named suite of checks.
 * @param name - the suite label.
 * @returns an object with `check` and `report`.
 */
export function createSuite(name) {
  const results = []
  return {
    name,
    /**
     * Run one check.
     * @param label - what is being verified.
     * @param body - the check body; throw to fail.
     */
    check(label, body) {
      try {
        body()
        results.push({ label, ok: true })
      } catch (error) {
        results.push({ label, ok: false, error })
      }
    },
    /**
     * Run one asynchronous check.
     * @param label - what is being verified.
     * @param body - the async check body; throw to fail.
     */
    async checkAsync(label, body) {
      try {
        await body()
        results.push({ label, ok: true })
      } catch (error) {
        results.push({ label, ok: false, error })
      }
    },
    /**
     * Print the suite result.
     * @returns the number of failures.
     */
    report() {
      const failed = results.filter((entry) => entry.ok === false)
      for (const entry of results) {
        if (entry.ok) continue
        console.log(`  FAIL  ${entry.label}`)
        console.log(`        ${entry.error instanceof Error ? entry.error.message : String(entry.error)}`)
      }
      console.log(`${name}: ${results.length - failed.length}/${results.length} passed`)
      return failed.length
    },
  }
}

/**
 * Assert a truthy condition.
 * @param condition - the condition.
 * @param message - failure message.
 */
export function assert(condition, message) {
  if (condition !== true) throw new Error(message ?? 'assertion failed')
}

/**
 * Assert strict equality.
 * @param actual - the observed value.
 * @param expected - the expected value.
 * @param message - failure message prefix.
 */
export function equal(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message ?? 'not equal'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

/**
 * Assert approximate numeric equality.
 * @param actual - the observed value.
 * @param expected - the expected value.
 * @param tolerance - allowed absolute difference.
 * @param message - failure message prefix.
 */
export function close(actual, expected, tolerance, message) {
  if (typeof actual !== 'number' || Math.abs(actual - expected) > tolerance) {
    throw new Error(`${message ?? 'not close'}: expected ~${expected}, got ${JSON.stringify(actual)}`)
  }
}
