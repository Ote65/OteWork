/**
 * dsh-ote-brand — render docs/brand-preview.png.
 *
 * Reads the *shipped* artwork straight out of the browser half — the embedded
 * mark data URI and the outlined wordmark path — and composes it at the real
 * seat metrics on both theme backgrounds. The picture therefore checks the
 * final bytes rather than a re-run of the generators, which is what makes it
 * worth keeping beside the README.
 *
 * Requires `sharp`; see tools/resolve.mjs.
 *
 * Usage: node tools/preview.mjs [output.png]
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadBuildModule } from './resolve.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

/** Device pixels per CSS pixel, so the preview survives being looked at. */
const SCALE = 3

/** Sidebar brand row: the seat's mark size, and the row the shell gives it. */
const BRAND_MARK_SIZE = 24
const BRAND_ROW_HEIGHT = 24

/** Hero: the seat's mark size; the labelled sample beside the wordmark. */
const HERO_MARK_SIZE = 34

/** Sidebar fills and label inks, light then dark — the shell's own two themes. */
const THEMES = [
  { name: 'light · sidebar brand row', fill: '#f7f7f8', label: '#8a8a93', markShadow: '#0f0f16', shadow: 'rgba(15,15,22,.5)' },
  { name: 'dark · sidebar brand row', fill: '#17171a', label: '#8a8a93', markShadow: '#000000', shadow: 'rgba(0,0,0,.6)' },
]

/** Both brand pieces are painted white by the skin, on either theme. */
const BRAND_INK = '#ffffff'

const sharp = loadBuildModule('sharp', [])
const source = readFileSync(join(root, 'lib', 'client.js'), 'utf8')

const markBase64 = /var MARK_URL = 'data:image\/png;base64,([A-Za-z0-9+/=]+)'/.exec(source)?.[1]
const wordmark = /var WORDMARK = \{ width: ([0-9.]+), height: ([0-9.]+), path: '([^']+)' \}/.exec(source)
const markScale = Number(/var MARK_SCALE = ([0-9.]+)/.exec(source)?.[1])
const wordmarkInk = Number(/var WORDMARK_INK = ([0-9.]+)/.exec(source)?.[1])
if (markBase64 === undefined || wordmark === null) throw new Error('the browser half has no generated artwork to render')

const markPng = Buffer.from(markBase64, 'base64')
const ink = { width: Number(wordmark[1]), height: Number(wordmark[2]), path: wordmark[3] }
const markRatio = 433 / 512

/**
 * Recolour the mark (black on alpha), keeping its coverage.
 * @param hex - the target fill.
 * @param width - rendered width in device pixels.
 * @returns the PNG buffer.
 */
async function recolourMark(hex, width) {
  const meta = await sharp(markPng).metadata()
  const height = Math.round((width * meta.height) / meta.width)
  const color = {
    r: Number.parseInt(hex.slice(1, 3), 16),
    g: Number.parseInt(hex.slice(3, 5), 16),
    b: Number.parseInt(hex.slice(5, 7), 16),
  }
  return sharp({ create: { width, height, channels: 4, background: { ...color, alpha: 1 } } })
    .composite([{ input: await sharp(markPng).resize({ width }).toBuffer(), blend: 'dest-in' }])
    .png()
    .toBuffer()
}

const brandMarkW = BRAND_MARK_SIZE * markScale * SCALE
const brandMarkH = brandMarkW * markRatio
const heroMarkW = HERO_MARK_SIZE * markScale * SCALE
const heroMarkH = heroMarkW * markRatio

// The row the skin actually produces: the shell pins a 24px brand identity, and
// the skin unpins it for the scaled mark, so the band here is whichever is
// taller. Drawing the pinned 24px would misrepresent the shipped result.
const rowH = Math.max(BRAND_ROW_HEIGHT * SCALE, brandMarkH)
const gap = 10 * SCALE
const padX = 22 * SCALE
const padY = 14 * SCALE
const labelW = 180 * SCALE
const wordH = wordmarkInk * SCALE
const wordW = (wordH * ink.width) / ink.height

const W = Math.round(padX * 2 + labelW + brandMarkW + gap + wordW + gap * 4 + heroMarkW + 68 * SCALE)
const H = Math.round(padY * 2 + rowH * THEMES.length + gap * (THEMES.length - 1))

/** The device-pixel x of each column, shared by the SVG and the composites. */
const columnX = {
  brandMark: padX + labelW,
  wordmark: padX + labelW + brandMarkW + gap,
  heroMark: padX + labelW + brandMarkW + gap + wordW + gap * 4,
}

const svgParts = [`<rect width="${W}" height="${H}" fill="#ffffff"/>`]
const composites = []

THEMES.forEach((theme, index) => {
  const top = padY + index * (rowH + gap)
  svgParts.push(`<rect x="0" y="${top}" width="${W}" height="${rowH}" fill="${theme.fill}"/>`)
  svgParts.push(`<text x="${padX}" y="${Math.round(top + rowH / 2 + 3.5 * SCALE)}" font-family="Segoe UI, Arial" font-size="${11 * SCALE}" fill="${theme.label}">${theme.name}</text>`)

  // White wordmark, with the skin's gentle shadow: a blurred dark copy behind it.
  const wordScale = wordH / ink.height
  const offset = `${(1.2 * SCALE / wordScale).toFixed(2)} ${(1.8 * SCALE / wordScale).toFixed(2)}`
  const blur = (1.25 * SCALE) / wordScale
  svgParts.push(
    `<g transform="translate(${columnX.wordmark.toFixed(1)}, ${(top + (rowH - wordH) / 2).toFixed(1)}) scale(${wordScale.toFixed(6)})">` +
      `<g transform="translate(${offset})" opacity="0.55">` +
      `<path d="${ink.path}" fill="${theme.shadow}" filter="url(#soft-${index})"/></g>` +
      `<path d="${ink.path}" fill="#ffffff"/></g>`,
  )
  svgParts.push(`<text x="${(columnX.heroMark + heroMarkW + 8 * SCALE).toFixed(1)}" y="${Math.round(top + rowH / 2 + 3.5 * SCALE)}" font-family="Segoe UI, Arial" font-size="${10 * SCALE}" fill="${theme.label}">hero ${(HERO_MARK_SIZE * markScale).toFixed(1)}px</text>`)

  // Both brand pieces are white; each is composited over a blurred dark copy of
  // itself, which is what the skin's `drop-shadow()` pair does in the browser.
  composites.push({
    left: Math.round(columnX.brandMark),
    top: Math.round(top + (rowH - brandMarkH) / 2),
    width: brandMarkW,
    shadow: theme.markShadow,
    shadowOffset: Math.max(1, Math.round(1 * SCALE)),
    shadowBlur: 1.4 * SCALE * 0.5,
  })
  composites.push({
    left: Math.round(columnX.heroMark),
    top: Math.round(top + (rowH - heroMarkH) / 2),
    width: heroMarkW,
    shadow: theme.markShadow,
    shadowOffset: Math.max(1, Math.round(1 * SCALE)),
    shadowBlur: 1.4 * SCALE * 0.5,
  })
})

const filters = THEMES.map((_, index) => {
  const wordScale = wordH / ink.height
  return `<filter id="soft-${index}" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="${((1.25 * SCALE) / wordScale).toFixed(3)}"/></filter>`
}).join('')

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>${filters}</defs>
  ${svgParts.join('\n  ')}
</svg>`

/** The white ink, plus a blurred dark copy of it for the shadow underneath. */
const layers = await Promise.all(
  composites.map(async (entry) => ({
    ink: await recolourMark(BRAND_INK, Math.round(entry.width)),
    shadow: await sharp(await recolourMark(entry.shadow, Math.round(entry.width)))
      .blur(Math.max(0.4, entry.shadowBlur))
      .toBuffer(),
  })),
)

const out = resolve(process.argv[2] ?? join(root, 'docs', 'brand-preview.png'))
await sharp(Buffer.from(svg))
  .composite(
    composites.flatMap((entry, index) => [
      { input: layers[index].shadow, left: entry.left, top: entry.top + entry.shadowOffset },
      { input: layers[index].ink, left: entry.left, top: entry.top },
    ]),
  )
  .png()
  .toFile(out)

console.log(`wrote     ${out} (${W}x${H})`)
console.log(`mark      ${(BRAND_MARK_SIZE * markScale).toFixed(1)} px in the brand row, ${(HERO_MARK_SIZE * markScale).toFixed(1)} px in the hero (x${markScale} of the seat size)`)
console.log(`wordmark  ${wordmarkInk} px ink, ${(wordW / SCALE).toFixed(2)} px wide, white with a gentle drop shadow`)

// The transparency check: the mark alone over a checkerboard, so the removed
// background is visible as the board showing through the artwork.
const meta = await sharp(markPng).metadata()
const cell = 24
const boardW = meta.width
const boardH = meta.height
const board = Buffer.alloc(boardW * boardH * 3)
for (let y = 0; y < boardH; y += 1) {
  for (let x = 0; x < boardW; x += 1) {
    const light = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0
    const value = light ? 214 : 166
    const at = (y * boardW + x) * 3
    board[at] = value
    board[at + 1] = value
    board[at + 2] = value
  }
}
const transparency = resolve(join(root, 'docs', 'mark-transparency.png'))
await sharp(board, { raw: { width: boardW, height: boardH, channels: 3 } })
  .composite([{ input: markPng }])
  .png()
  .toFile(transparency)
console.log(`wrote     ${transparency} (${boardW}x${boardH})`)
