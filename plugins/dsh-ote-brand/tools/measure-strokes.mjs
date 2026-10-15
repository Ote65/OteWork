/**
 * dsh-ote-brand — measure the mark's stroke thickness.
 *
 * The mark is line art, and what a stroke becomes once it is drawn at brand-row
 * size decides whether it is visible at all. This tool reports the horizontal
 * ink runs of the generated artwork and what they collapse to at each seat size,
 * which is the number behind the ink decision in `lib/client.js`: at 31.68 px a
 * stroke is about half a pixel, so the artwork's own (dark) ink reads where a
 * white one disappears over a pale sidebar.
 *
 * Requires `sharp`; see tools/resolve.mjs.
 *
 * Usage: node tools/measure-strokes.mjs [mark.png]
 */

import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadBuildModule } from './resolve.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

/** Sizes the skin actually draws the mark at: the brand row, and the hero. */
const SEATS = [
  ['brand row (24 x 1.32)', 24 * 1.32],
  ['hero (34 x 1.32)', 34 * 1.32],
]

const file = resolve(process.argv[2] ?? join(root, 'assets', 'ote-work-mark.png'))
const sharp = loadBuildModule('sharp', [])

const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
const { width, height, channels } = info

const runs = []
let ink = 0
for (let y = 0; y < height; y += 1) {
  let length = 0
  for (let x = 0; x < width; x += 1) {
    const on = data[(y * width + x) * channels + 3] > 127
    if (on) {
      length += 1
      ink += 1
    } else if (length > 0) {
      runs.push(length)
      length = 0
    }
  }
  if (length > 0) runs.push(length)
}
runs.sort((a, b) => a - b)
const quantile = (q) => runs[Math.min(runs.length - 1, Math.floor(runs.length * q))]

console.log(`artwork    ${file}`)
console.log(`size       ${width}x${height} px, ${(100 * ink / (width * height)).toFixed(1)}% of pixels are ink`)
console.log(`runs       ${String(runs.length)} horizontal ink runs`)
console.log(`stroke     min ${runs[0]} | p25 ${quantile(0.25)} | median ${quantile(0.5)} | p75 ${quantile(0.75)} | max ${runs[runs.length - 1]} px`)
for (const [label, display] of SEATS) {
  const scale = display / width
  console.log(`at ${label.padEnd(20)} ${display.toFixed(2)} px wide -> stroke ${(quantile(0.5) * scale).toFixed(2)}-${(quantile(0.75) * scale).toFixed(2)} CSS px`)
}
