#!/usr/bin/env node
/**
 * OteWork 插件一键安装（离线，不需要网络与 pnpm）。
 *
 * 把包内 plugins/<name> 复制到 $DSH_HOME/local-plugins/<name>，再逐个 profile 补齐
 * 三处：package.json 的 dependencies、dsh.profile.bundles、node_modules/<name> 链接。
 * 三处缺一不生效（只建链接时 dump-config 里看不到插件）。
 *
 *   node install.mjs                 装进探到的所有 profile
 *   node install.mjs --profile web   只装 web
 *   node install.mjs --dry-run       只报告将要做什么
 *   node install.mjs --uninstall     反向操作：摘掉依赖 / bundle / 链接，删掉插件本体
 *   node install.mjs --root <目录>   插件来自指定目录（默认脚本所在目录，仓库内调试用）
 */

import {
  cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const argv = process.argv.slice(2)

function option(name) {
  const index = argv.indexOf('--' + name)
  return index === -1 ? null : argv[index + 1] ?? null
}

const dryRun = argv.includes('--dry-run')
const uninstall = argv.includes('--uninstall')
const onlyProfile = option('profile')
const here = resolve(option('root') ?? dirname(fileURLToPath(import.meta.url)))
const dshHome = process.env.DSH_HOME ? resolve(process.env.DSH_HOME) : join(homedir(), '.dsh')
const linkType = process.platform === 'win32' ? 'junction' : 'dir'

function fail(message) {
  console.error('\n安装中止：' + message)
  process.exit(1)
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

function isLink(path) {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch (error) {
    return false
  }
}

/** 插件：plugins/<name>/package.json。顺序 = 本机实测通过的 bundle 顺序，包外的新插件排在最后。 */
const ORDER = ['dsh-ote-brand', 'dsh-plus-menu', 'dsh-token-hud', 'dsh-session-bridge', 'dsh-element-picker', 'dsh-picker-probe', 'dsh-ote-skin', 'dsh-governor-mode']

function readPlugins() {
  const root = join(here, 'plugins')
  if (existsSync(root) === false) fail('这个位置没有 plugins 目录，请把压缩包完整解压后再运行本脚本')
  return readdirSync(root)
    .map((name) => ({ dir: join(root, name), name }))
    .filter((entry) => existsSync(join(entry.dir, 'package.json')))
    .map((entry) => ({ ...entry, pkg: readJson(join(entry.dir, 'package.json')) }))
    .sort((a, b) => {
      const rankA = ORDER.indexOf(a.name)
      const rankB = ORDER.indexOf(b.name)
      if (rankA !== -1 || rankB !== -1) return (rankA === -1 ? ORDER.length : rankA) - (rankB === -1 ? ORDER.length : rankB)
      return a.name < b.name ? -1 : 1
    })
}

/** profile：$DSH_HOME/profiles/<name>/package.json 存在才算。 */
function readProfiles() {
  const root = join(dshHome, 'profiles')
  if (existsSync(root) === false) {
    fail('没找到 DSH 的 ' + root + '，请先启动一次 DeepSeek Harness 让它生成 profile，再运行本脚本')
  }
  return readdirSync(root)
    .filter((name) => existsSync(join(root, name, 'package.json')) && (onlyProfile == null || name === onlyProfile))
    .map((name) => ({ name, file: join(root, name, 'package.json') }))
}

const plugins = readPlugins()
const profiles = readProfiles()
if (profiles.length === 0) fail(onlyProfile == null ? '没有找到任何 profile' : '没有名为 ' + onlyProfile + ' 的 profile')

const localPlugins = join(dshHome, 'local-plugins')
const report = []

if (uninstall) {
  /* ---- 卸载：逐个 profile 摘掉依赖 / bundle 顺序 / node_modules 链接 ---- */
  for (const profile of profiles) {
    const pkg = readJson(profile.file)
    const modules = join(dirname(profile.file), 'node_modules')
    const dropped = []
    for (const plugin of plugins) {
      if (pkg.dependencies != null && plugin.name in pkg.dependencies) {
        delete pkg.dependencies[plugin.name]
        dropped.push(plugin.name)
      }
      if (Array.isArray(pkg.dsh?.profile?.bundles)) {
        pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter((name) => name !== plugin.name)
      }
      if (dryRun) continue
      const entry = join(modules, plugin.name)
      if (isLink(entry)) unlinkSync(entry)
      else if (existsSync(entry)) report.push('  · ' + profile.name + ' 的 node_modules/' + plugin.name + ' 是实体目录，未删（请自行确认它是不是旧拷贝）')
    }
    if (dryRun === false && dropped.length > 0) writeFileSync(profile.file, JSON.stringify(pkg, null, 2) + '\n')
    report.push('  · ' + profile.name + '：' + (dropped.length === 0 ? '本来就没有这些依赖' : '摘掉 ' + dropped.join('、')))
  }

  /* ---- 删掉插件本体 ---- */
  for (const plugin of plugins) {
    if (dryRun) continue
    const target = join(localPlugins, plugin.name)
    if (existsSync(target) || isLink(target)) rmSync(target, { recursive: true, force: true })
  }

  console.log('\nOteWork 插件' + (dryRun ? '（演练，未改动任何文件）' : '已卸载'))
  console.log('  插件目录：' + localPlugins)
  console.log('  已处理 profile：')
  for (const line of report) console.log(line)
  console.log('\nDSH 的资料目录里可能还留着旧配置的痕迹，完全重启 DeepSeek Harness 后官方外观即恢复。')
  process.exit(0)
}

/* ---- 一、把插件本体放到 local-plugins（可重复运行，覆盖旧版本） ---- */
for (const plugin of plugins) {
  const target = join(localPlugins, plugin.name)
  if (dryRun) continue
  mkdirSync(localPlugins, { recursive: true })
  rmSync(target, { recursive: true, force: true })
  cpSync(plugin.dir, target, { recursive: true })
}

/* ---- 二、逐个 profile 补齐依赖、bundle 顺序与 node_modules 链接 ---- */
for (const profile of profiles) {
  const pkg = readJson(profile.file)
  const modules = join(dirname(profile.file), 'node_modules')
  pkg.dependencies = pkg.dependencies ?? {}
  pkg.dsh = pkg.dsh ?? {}
  pkg.dsh.profile = pkg.dsh.profile ?? {}
  const bundles = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : []
  const added = []

  for (const plugin of plugins) {
    const source = join(localPlugins, plugin.name)
    pkg.dependencies[plugin.name] = 'link:' + source.split('\\').join('/')
    if (bundles.includes(plugin.name) === false) {
      bundles.push(plugin.name)
      added.push(plugin.name)
    }
    if (dryRun) continue
    const entry = join(modules, plugin.name)
    const existing = existsSync(entry) || isLink(entry)
    if (existing && isLink(entry) === false) {
      report.push('  · ' + profile.name + ' 的 node_modules/' + plugin.name + ' 是实体目录，未改动（请自行确认它是不是旧拷贝）')
      continue
    }
    if (existing) rmSync(entry, { force: true })
    mkdirSync(modules, { recursive: true })
    symlinkSync(source, entry, linkType)
  }

  pkg.dsh.profile.bundles = bundles
  if (dryRun === false) writeFileSync(profile.file, JSON.stringify(pkg, null, 2) + '\n')
  report.push('  · ' + profile.name + '：' + plugins.length + ' 个依赖已就位' + (added.length === 0 ? '（bundle 顺序无变化）' : '，新增 bundle ' + added.join('、')))
}

/* ---- 三、报告 ---- */
console.log('\nOteWork 插件' + (dryRun ? '（演练，未改动任何文件）' : '安装完成'))
console.log('  插件目录：' + localPlugins)
console.log('  本次版本：')
for (const plugin of plugins) {
  console.log('    ' + plugin.name + ' ' + (plugin.pkg.version ?? '0.0.0'))
}
console.log('  已处理 profile：')
for (const line of report) console.log(line)
console.log('\n下一步：完全退出并重新启动 DeepSeek Harness（浏览器半只在启动时下发，不重启看不到插件）。')
