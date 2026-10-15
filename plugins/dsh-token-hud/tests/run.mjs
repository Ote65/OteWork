/** Runs every dsh-token-hud suite and exits non-zero on any failure. */

import { run as runClient } from './client.test.mjs'
import { run as runHost } from './host.test.mjs'

let failures = 0
const report = (suite) => {
  failures += suite.report()
}

await runHost(report)
await runClient(report)

console.log(failures === 0 ? '\nall suites passed' : `\n${failures} failing check(s)`)
process.exit(failures === 0 ? 0 : 1)
