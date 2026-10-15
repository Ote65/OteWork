/**
 * dsh-ote-brand — outline the "OTE Work" wordmark.
 *
 * The shipped DeepSeek wordmark is SVG paths, not text, and this skin follows
 * that: the wordmark is the outlined artwork of a rounded bold face, so it is
 * identical on every machine and needs no font to be installed, no `@font-face`
 * request and no FOUT. It also means the gentle drop shadow can be a
 * `drop-shadow()` filter that follows the letterforms instead of a boxy
 * `text-shadow`.
 *
 * This tool lays the string out with fontkit (advances and kerning from
 * `layout()`), bakes every glyph into one SVG path in a tight ink box, and
 * writes it into the `@generated:ote-wordmark` block of `lib/client.js`.
 *
 * The vendored source face is `assets/baloo2-700-latin.woff2` (Baloo 2 Bold,
 * SIL OFL — see assets/FONT.md). To try another face, drop its Latin WOFF2 in
 * `assets/` and pass it as the first argument; nothing else has to change.
 *
 * Usage: node tools/make-wordmark.mjs [font.woff2] [client.js] [--modules <dir>]
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { anchorFrom, loadBuildModule } from './resolve.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const BEGIN = '/* @generated:ote-wordmark */'
const END = '/* @generated:end */'

/** Anchors named on the command line, tried before the defaults. */
const moduleAnchors = []

/**
 * Parse the command line.
 * @returns the resolved options.
 */
function parseArgs() {
  const argv = process.argv.slice(2)
  const options = {
    font: join(root, 'assets', 'baloo2-700-latin.woff2'),
    client: join(root, 'lib', 'client.js'),
    text: null,
  }
  const positionals = []
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--modules') {
      moduleAnchors.push(anchorFrom(argv[index + 1], 'fontkit'))
      index += 1
      continue
    }
    if (argv[index] === '--text') {
      options.text = argv[index + 1]
      index += 1
      continue
    }
    positionals.push(argv[index])
  }
  if (positionals[0] !== undefined) options.font = resolve(positionals[0])
  if (positionals[1] !== undefined) options.client = resolve(positionals[1])
  return options
}

/**
 * Read the wordmark string from the browser half, so the artwork and the
 * accessible name can never drift apart.
 * @param source - the browser-half source.
 * @returns the brand name literal.
 */
function brandNameFrom(source) {
  const match = /var BRAND_NAME = '((?:[^'\\]|\\.)*)'/.exec(source)
  if (match === null) throw new Error('could not read BRAND_NAME from the browser half')
  return match[1]
}

/**
 * Glyphs with pen positions, in font units and y-up.
 * @param font - a fontkit font.
 * @param text - the string to place.
 * @returns the placed glyphs.
 */
function placeGlyphs(font, text) {
  const run = font.layout(text)
  const placed = []
  let pen = 0
  for (let index = 0; index < run.glyphs.length; index += 1) {
    const position = run.positions[index]
    placed.push({ glyph: run.glyphs[index], x: pen + (position.xOffset ?? 0) })
    pen += position.xAdvance
  }
  return placed
}

/**
 * Outline the string into one path in a tight ink box (SVG space, y down).
 * @param font - a fontkit font.
 * @param text - the string to outline.
 * @returns the path data plus the ink box in font units.
 */
function outline(font, text) {
  const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
  for (const { glyph, x } of placeGlyphs(font, text)) {
    const bounds = glyph.path.transform(1, 0, 0, -1, x, 0).bbox
    if (Number.isFinite(bounds.minX) !== true) continue
    box.minX = Math.min(box.minX, bounds.minX)
    box.maxX = Math.max(box.maxX, bounds.maxX)
    box.minY = Math.min(box.minY, bounds.minY)
    box.maxY = Math.max(box.maxY, bounds.maxY)
  }
  if (Number.isFinite(box.minX) !== true) throw new Error('the face produced no outline for this string')

  const path = placeGlyphs(font, text)
    .map(({ glyph, x }) => glyph.path.transform(1, 0, 0, -1, x - box.minX, -box.minY).toSVG())
    .join(' ')
  return { path, width: box.maxX - box.minX, height: box.maxY - box.minY }
}

const options = parseArgs()
const source = readFileSync(options.client, 'utf8')
const text = options.text ?? brandNameFrom(source)
const fontkit = loadBuildModule('fontkit', moduleAnchors)
const font = fontkit.create(readFileSync(options.font))

for (const character of new Set(text)) {
  if (font.hasGlyphForCodePoint(character.codePointAt(0)) !== true) {
    throw new Error(`the face has no glyph for ${JSON.stringify(character)}; pick another face or adjust the text`)
  }
}

const ink = outline(font, text)
const beginAt = source.indexOf(BEGIN)
const endAt = source.indexOf(END, beginAt)
if (beginAt < 0 || endAt < 0) throw new Error(`missing the ${BEGIN} … ${END} block in ${options.client}`)

const block = [
  BEGIN,
  `\t\tvar WORDMARK = { width: ${ink.width}, height: ${ink.height}, path: '${ink.path}' };`,
  '\t\t',
].join('\n')
const next = source.slice(0, beginAt) + block + source.slice(endAt)
writeFileSync(options.client, next)

console.log(`face      ${options.font}`)
console.log(`family    ${font.familyName ?? font.postscriptName} (${font.unitsPerEm} upem, ${font.type})`)
console.log(`text      ${JSON.stringify(text)} — ${new Set(text).size} distinct glyphs`)
console.log(`ink box   ${Math.round(ink.width)}x${Math.round(ink.height)} units, ratio ${(ink.width / ink.height).toFixed(4)}`)
console.log(`embedded  ${options.client} (+${ink.path.length} path chars, file now ${next.length})`)
