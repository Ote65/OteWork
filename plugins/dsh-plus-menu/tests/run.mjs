/**
 * Run both offline harnesses against the built halves in ../lib.
 *
 * These load the real artifacts — not copies, not stubs of the plugin — so a
 * green run means the shipped lib/ files still behave as documented.
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const suites = ['client.test.mjs', 'host.test.mjs']

let failed = 0
for (const suite of suites) {
  console.log(`\n=== ${suite} ===`)
  const result = spawnSync(process.execPath, [`${here}${suite}`], { stdio: 'inherit' })
  if (result.status !== 0) failed++
}

console.log(failed === 0 ? '\nboth suites passed' : `\n${failed} suite(s) failed`)
process.exit(failed === 0 ? 0 : 1)
