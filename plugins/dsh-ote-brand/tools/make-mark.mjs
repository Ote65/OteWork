/**
 * dsh-ote-brand — regenerate the transparent brand mark.
 *
 * The owner supplied the mark as flat black line art on paper white (a JPEG),
 * so the "remove the background" step is a coverage solve, not a guess: for a
 * black line drawn on a white page, a pixel's ink coverage *is* `(paper −
 * luminance) / (paper − ink)`. Storing that coverage as alpha (with black as
 * the colour) therefore reproduces the original anti-aliased edges exactly and
 * leaves no white box behind.
 *
 *   paper   the measured background level of the scan (250, not 255)
 *   floor   coverage below this is JPEG ringing around the strokes → dropped
 *
 * The result is trimmed to the ink bounding box (plus a small optical margin)
 * so the mark fills its seat instead of carrying the scan's own white padding.
 * The browser half renders it at `MARK_SCALE` over the size its seat requests.
 *
 * Requires `sharp`, which ships with the DSH profile rather than with this
 * package — see `tools/resolve.mjs` for how it is located.
 *
 * Usage: node tools/make-mark.mjs [input.jpg] [output.png] [--width 512] [--modules <dir>]
 */

import { existsSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { anchorFrom, loadBuildModule } from './resolve.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

/** Background level of the supplied scan. */
const PAPER = 250

/** Ink level of the supplied scan. */
const INK = 10

/** Coverage floor that removes JPEG ringing around the strokes. */
const FLOOR = 18

/** Output width in pixels; the height follows the trimmed aspect ratio. */
const DEFAULT_WIDTH = 512

/** Optical margin, as a fraction of the longer trimmed edge. */
const MARGIN = 0.03

/** Anchors named on the command line, tried before the shared defaults. */
const moduleAnchors = []

/**
 * Parse the command line.
 * @returns the resolved options.
 */
function parseArgs() {
  const argv = process.argv.slice(2)
  const options = {
    input: join(root, 'assets', 'ote-work-source.jpg'),
    output: join(root, 'assets', 'ote-work-mark.png'),
    width: DEFAULT_WIDTH,
  }
  const positionals = []
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--width') {
      options.width = Number(argv[index + 1])
      index += 1
      continue
    }
    if (argv[index] === '--sharp' || argv[index] === '--profile' || argv[index] === '--modules') {
      moduleAnchors.unshift(anchorFrom(argv[index + 1], 'sharp'))
      index += 1
      continue
    }
    positionals.push(argv[index])
  }
  if (positionals[0] !== undefined) options.input = resolve(positionals[0])
  if (positionals[1] !== undefined) options.output = resolve(positionals[1])
  return options
}

/**
 * Solve per-pixel ink coverage, producing a black RGBA buffer.
 * @param data - raw RGBA/RGB source pixels.
 * @param width - source width.
 * @param height - source height.
 * @param channels - source channel count.
 * @returns the coverage map plus the ink bounding box.
 */
function solveCoverage(data, width, height, channels) {
  const coverage = new Uint8Array(width * height)
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  const span = PAPER - INK
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * channels
      const luminance = 0.2126 * data[offset] + 0.7152 * data[offset + 1] + 0.0722 * data[offset + 2]
      const ink = PAPER - luminance
      const value = ink < FLOOR ? 0 : Math.min(255, Math.round((ink * 255) / span))
      coverage[y * width + x] = value
      if (value > 0) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  return { coverage, minX, minY, maxX, maxY }
}

const options = parseArgs()
if (existsSync(options.input) !== true) throw new Error(`missing source image: ${options.input}`)

const sharp = loadBuildModule('sharp', moduleAnchors)
const source = sharp(options.input)
const { data, info } = await source.raw().toBuffer({ resolveWithObject: true })
const { coverage, minX, minY, maxX, maxY } = solveCoverage(data, info.width, info.height, info.channels)
if (maxX < 0) throw new Error('the source image has no ink: every pixel solved to full transparency')

const pad = Math.round(Math.max(maxX - minX, maxY - minY) * MARGIN)
const left = Math.max(0, minX - pad)
const top = Math.max(0, minY - pad)
const right = Math.min(info.width - 1, maxX + pad)
const bottom = Math.min(info.height - 1, maxY + pad)
const trimmedWidth = right - left + 1
const trimmedHeight = bottom - top + 1

const rgba = Buffer.alloc(trimmedWidth * trimmedHeight * 4)
for (let y = 0; y < trimmedHeight; y += 1) {
  for (let x = 0; x < trimmedWidth; x += 1) {
    const target = (y * trimmedWidth + x) * 4
    const value = coverage[(y + top) * info.width + (x + left)]
    rgba[target] = 0
    rgba[target + 1] = 0
    rgba[target + 2] = 0
    rgba[target + 3] = value
  }
}

const png = await sharp(rgba, { raw: { width: trimmedWidth, height: trimmedHeight, channels: 4 } })
  .resize({ width: options.width, fit: 'inside', kernel: 'lanczos3' })
  .png({ compressionLevel: 9, effort: 10 })
  .toBuffer()

writeFileSync(options.output, png)
const meta = await sharp(options.output).metadata()
const ratio = meta.height / meta.width
console.log(`source    ${info.width}x${info.height}, ink box ${maxX - minX + 1}x${maxY - minY + 1}`)
console.log(`mark      ${options.output}`)
console.log(`size      ${meta.width}x${meta.height} px, ${png.length} bytes`)
console.log(`ratio     ${ratio.toFixed(6)}  (lib/client.js MARK_RATIO = ${(433 / 512).toFixed(6)})`)
if (Math.abs(ratio - 433 / 512) > 0.0005) {
  console.log('WARN      the trimmed ratio moved — update MARK_RATIO in lib/client.js')
}
