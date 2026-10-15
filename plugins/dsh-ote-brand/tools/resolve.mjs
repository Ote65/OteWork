/**
 * Resolve the optional build-time modules the tools need.
 *
 * Neither `sharp` (rasterising the mark) nor `fontkit` (outlining the wordmark)
 * is a dependency of this plugin: both already ship with the DSH desktop
 * install, and pinning a second copy would be a build-time dependency this
 * package does not otherwise have. They are CommonJS, and they live in two
 * different places on disk:
 *
 *   sharp    the DSH profile's own `node_modules` (the skin tools' host)
 *   fontkit  the runtime bundle at
 *            `<install>/resources/app.asar.unpacked/dsh/node_modules`
 *
 * So resolution walks a list of anchors — a `--modules <dir>` flag first, then
 * the environment, then the standard Windows desktop install path — and reports
 * every attempt when none of them answers.
 *
 * @module tools/resolve
 */

import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * The runtime's unpacked `node_modules`, discovered from the environment.
 *
 * A DSH-launched shell carries a few absolute paths into the install (sharp's
 * own `VIPSHOME` is the one that is reliably present, because the Harness loads
 * sharp for image work). Rather than depend on any single variable's name, this
 * scans for a value that points inside `app.asar.unpacked` and takes the
 * `…/dsh/node_modules` directory above it. That is also what makes the tools
 * work on an install outside `%LOCALAPPDATA%`, which is exactly the case when
 * the app lives on another drive.
 *
 * @returns the directory, or undefined when nothing in the environment points
 *   into an install.
 */
function runtimeModulesFromEnvironment() {
  const marker = 'app.asar.unpacked'
  for (const value of Object.values(process.env)) {
    if (typeof value !== 'string' || value.includes(marker) !== true) continue
    const at = value.indexOf(marker)
    return join(value.slice(0, at), marker, 'dsh', 'node_modules')
  }
  return undefined
}

/** Anchors used when the caller names none. */
function defaultAnchors() {
  const anchors = []
  if (typeof process.env.DSH_PLUGIN_MODULES === 'string' && process.env.DSH_PLUGIN_MODULES.length > 0) {
    anchors.push(process.env.DSH_PLUGIN_MODULES)
  }
  if (typeof process.env.DSH_PROFILE_DIR === 'string' && process.env.DSH_PROFILE_DIR.length > 0) {
    anchors.push(join(process.env.DSH_PROFILE_DIR, 'node_modules'))
  }
  const discovered = runtimeModulesFromEnvironment()
  if (discovered !== undefined) anchors.push(discovered)
  for (const base of [process.env.LOCALAPPDATA, process.env.USERPROFILE === undefined ? undefined : join(process.env.USERPROFILE, 'AppData', 'Local')]) {
    if (typeof base === 'string' && base.length > 0) {
      anchors.push(join(base, 'Programs', 'DeepSeek Harness', 'resources', 'app.asar.unpacked', 'dsh', 'node_modules'))
    }
  }
  return anchors
}

/**
 * Normalize a user-supplied location into a directory Node can resolve from.
 * @param dir - a profile directory, a `node_modules` directory, or the package
 *   directory itself.
 * @param name - the package name being resolved, so a path that already ends
 *   with it is not nested twice.
 * @returns the directory to resolve from.
 */
export function anchorFrom(dir, name) {
  const absolute = resolve(dir).replace(/[\\/]+$/, '')
  if (absolute.endsWith(name)) return join(absolute, '..')
  if (absolute.endsWith('node_modules')) return absolute
  const nested = join(absolute, 'node_modules')
  return existsSync(nested) ? nested : absolute
}

/**
 * Require one package from one anchor.
 * @param name - the package name.
 * @param anchor - the directory to resolve from.
 * @returns the module export.
 */
function requireFrom(name, anchor) {
  return createRequire(join(anchor, 'dsh-ote-brand-build.cjs'))(name)
}

/**
 * Load a build-time module from the first anchor that has it.
 * @param name - the package name (`sharp`, `fontkit`).
 * @param extraAnchors - anchors to try before the defaults.
 * @returns the module export.
 */
export function loadBuildModule(name, extraAnchors = []) {
  const anchors = [...extraAnchors, ...defaultAnchors()]
  const failures = []
  for (const anchor of anchors) {
    if (existsSync(anchor) !== true) {
      failures.push(`${anchor}: (no such directory)`)
      continue
    }
    try {
      return requireFrom(name, anchor)
    } catch (error) {
      failures.push(`${anchor}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new Error(
    `${name} is unavailable. Tried:\n  ${failures.join('\n  ')}\n` +
      `Pass --modules <dir> to name a directory that has it.`,
  )
}
