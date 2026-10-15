/**
 * dsh-ote-brand — embed the brand mark into the browser bundle.
 *
 * The browser half is loaded by `dsh-client-modules`, which seeds a handful of
 * platform modules and nothing else: a client bundle cannot `require` a sibling
 * file or fetch a package asset. The mark is therefore inlined as a data URI
 * between the `@generated:ote-mark` markers in `lib/client.js`, and this script
 * is what writes those bytes. `npm run build` runs the raster step first.
 *
 * Usage: node tools/embed-mark.mjs [mark.png] [client.js]
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const markPath = resolve(process.argv[2] ?? join(root, 'assets', 'ote-work-mark.png'))
const clientPath = resolve(process.argv[3] ?? join(root, 'lib', 'client.js'))

const BEGIN = '/* @generated:ote-mark */'
const END = '/* @generated:end */'

const png = readFileSync(markPath)
const encoded = png.toString('base64')
if (/^[A-Za-z0-9+/=]+$/.test(encoded) !== true) throw new Error('the mark did not encode to plain base64')

const source = readFileSync(clientPath, 'utf8')
const beginAt = source.indexOf(BEGIN)
const endAt = source.indexOf(END, beginAt)
if (beginAt < 0 || endAt < 0) throw new Error(`missing the ${BEGIN} … ${END} block in ${clientPath}`)

const block = [
  BEGIN,
  `\t\tvar MARK_URL = 'data:image/png;base64,${encoded}';`,
  '\t\t',
].join('\n')

const next = source.slice(0, beginAt) + block + source.slice(endAt)
writeFileSync(clientPath, next)

/** Intrinsic size of the mark, straight from the PNG header. */
const width = png.readUInt32BE(16)
const height = png.readUInt32BE(20)
console.log(`mark      ${markPath} (${width}x${height}, ${png.length} bytes)`)
console.log(`embedded  ${clientPath} (+${encoded.length} base64 chars, file now ${next.length})`)
console.log(`ratio     ${(height / width).toFixed(6)}  (lib/client.js MARK_RATIO = ${(433 / 512).toFixed(6)})`)
if (Math.abs(height / width - 433 / 512) > 0.0005) {
  console.log('WARN      the embedded ratio differs from MARK_RATIO — update lib/client.js')
}
