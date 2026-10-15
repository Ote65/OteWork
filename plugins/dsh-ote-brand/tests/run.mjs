/** Runs the dsh-ote-brand suites and exits non-zero on any failure. */

import { run as runClient } from './client.test.mjs'

let failures = 0
const report = (suite) => {
  failures += suite.report()
}

await runClient(report)

console.log(failures === 0 ? '\nall suites passed' : `\n${failures} failing check(s)`)
process.exit(failures === 0 ? 0 : 1)
