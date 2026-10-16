#!/usr/bin/env node
/**
 * 出正式安装包。
 *
 *   node tools/build-installers.mjs                      macOS 整机安装包（.pkg）：应用本体 + OteWork 插件
 *   node tools/build-installers.mjs --app-path <路径>    指定应用本体来源
 *   node tools/build-installers.mjs --plugins            只出插件包（macOS .pkg，几百 KB）
 *   node tools/build-installers.mjs --win                出 Windows 插件包（NSIS .exe）
 *
 * 整机包的载荷：/Applications/DeepSeek Harness.app（官方成品，签名与公证原样保留）
 *              /usr/local/share/OteWork（OteWork 插件集 + 离线安装脚本）
 * 应用来源优先级：--app-path → 本机 /Applications → 官方发布通道下载（进 ~/.ote-build/cache）。
 *
 * 安装界面：macOS 侧不做任何自定义皮肤，交给系统默认安装器（介绍 / 目的宗卷 / 安装 / 摘要）。
 * 组件包默认带 <relocate>（Installer 会去找同 bundle id 的旧拷贝装到那儿去），
 * 这里把它摘掉，保证一定落在 /Applications。
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { REPO, VERSION, stageSource, writeInstallDoc } from './lib/stage.mjs'

const argv = process.argv.slice(2)

function option(name) {
  const index = argv.indexOf('--' + name)
  return index === -1 ? null : argv[index + 1] ?? null
}

const mode = argv.includes('--win') ? 'win' : argv.includes('--plugins') ? 'plugins' : 'app'
const wantMac = mode !== 'win'
const wantWin = mode === 'win'
const wantApp = mode === 'app'
const appPath = option('app-path')

const INSTALLER = join(REPO, 'tools', 'installer')
const ASSETS = join(INSTALLER, 'branding', 'assets')
const DIST = join(REPO, 'dist')
const IDENTIFIER = wantApp ? 'com.otework.app' : 'com.otework.plugins'
const INSTALL_PATH = 'usr/local/share/OteWork'
const SLUG = 'OteWork'
const APP_BUNDLE = 'DeepSeek Harness.app'
const APP_FEED = 'https://download.deepseek.com/dsh-desk/feeds/mac-arm64/nightly-mac.yml'

function run(command, args, options = {}) {
  return execFileSync(command, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', ...options }).trim()
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function plistString(info, key) {
  return new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`).exec(info)?.[1]
}

function fail(message) {
  console.error('\n打包中止：' + message)
  process.exit(1)
}

/** 应用本体来源：命令行覆盖 → 本机 /Applications → 官方发布通道（下载后进缓存）。 */
async function resolveApp() {
  for (const candidate of [appPath, join('/Applications', APP_BUNDLE)]) {
    if (candidate != null && existsSync(join(candidate, 'Contents', 'Info.plist'))) return candidate
  }

  console.log('  本机没有应用本体，改从官方发布通道取')
  const feed = await (await fetch(APP_FEED)).text()
  const url = (feed.match(/https:\/\/\S+\.zip/) ?? [])[0]
  if (url === undefined) fail('读不到官方 mac 发布清单 ' + APP_FEED)

  const cache = join(homedir(), '.ote-build', 'cache')
  mkdirSync(cache, { recursive: true })
  const zip = join(cache, url.split('/').pop())
  if (existsSync(zip) === false) {
    console.log('  下载 ' + url)
    const response = await fetch(url)
    if (response.ok === false) fail(`下载应用本体失败：HTTP ${response.status}`)
    writeFileSync(zip, Buffer.from(await response.arrayBuffer()))
  }
  const unpacked = join(cache, 'app')
  rmSync(unpacked, { recursive: true, force: true })
  mkdirSync(unpacked, { recursive: true })
  run('ditto', ['-x', '-k', zip, unpacked])
  return join(unpacked, APP_BUNDLE)
}

/** 摘掉组件包的 <relocate>：让 Installer 一定装进载荷里那个路径。 */
function stripRelocate(raw, work, target) {
  const dir = join(work, 'relocate')
  rmSync(dir, { recursive: true, force: true })
  run('pkgutil', ['--expand', raw, dir])
  const info = join(dir, 'PackageInfo')
  const text = readFileSync(info, 'utf8')
  if (text.includes('<relocate>') === false) {
    renameSync(raw, target)
    return false
  }
  writeFileSync(info, text.replace(/\s*<relocate>[\s\S]*?<\/relocate>/, ''))
  run('pkgutil', ['--flatten', dir, target])
  return true
}

const work = mkdtempSync(join(tmpdir(), 'ote-installer-'))
mkdirSync(DIST, { recursive: true })

const stage = join(work, 'payload')
const meta = stageSource(stage)
writeInstallDoc(stage, meta)

console.log(`\nOteWork ${VERSION}   来源 ${meta.branch}@${meta.sha}${meta.dirty ? '（工作区另有未提交改动，未进包）' : ''}`)
console.log(`载荷 ${meta.plugins.length} 个插件${wantApp ? ' + 应用本体' : '（不含应用本体）'}`)

const out = []

/* ---------- macOS：pkgbuild（出裸组件包，界面走系统默认） ---------- */
if (wantMac) {
  if (process.platform !== 'darwin') fail('mac 安装包只能在 macOS 上打')

  const root = join(work, 'mac-root')
  cpSync(stage, join(root, INSTALL_PATH), { recursive: true })

  if (wantApp) {
    const source = await resolveApp()
    const info = readFileSync(join(source, 'Contents', 'Info.plist'), 'utf8')
    const executable = plistString(info, 'CFBundleExecutable')
    const archs = executable === undefined ? '' : run('lipo', ['-archs', join(source, 'Contents', 'MacOS', executable)])
    console.log(`  应用本体 ${source}  ${plistString(info, 'CFBundleShortVersionString') ?? '?'} ${archs}`)
    mkdirSync(join(root, 'Applications'), { recursive: true })
    /* ditto 原样搬运：符号链接、扩展属性、权限、签名密封都不动 */
    run('ditto', [source, join(root, 'Applications', APP_BUNDLE)])
  }

  const scripts = join(work, 'mac-scripts')
  mkdirSync(scripts, { recursive: true })
  cpSync(join(INSTALLER, 'mac', 'scripts', 'postinstall'), join(scripts, 'postinstall'))
  chmodSync(join(scripts, 'postinstall'), 0o755)

  const rawComponent = join(work, 'component.pkg')
  run('pkgbuild', [
    '--root', root,
    '--identifier', IDENTIFIER,
    '--version', VERSION,
    '--scripts', scripts,
    '--install-location', '/',
    rawComponent,
  ])

  const suffix = wantApp ? '-macOS' : '-macOS-plugins'
  const pkg = join(DIST, `${SLUG}-${VERSION}${suffix}.pkg`)
  rmSync(pkg, { force: true })
  const stripped = stripRelocate(rawComponent, work, pkg)
  console.log(`  组件包 ${stripped ? '已摘掉 relocation' : '无需改'}`)
  out.push(pkg)
}

/* ---------- Windows：makensis ---------- */
if (wantWin) {
  if (wantApp) fail('整机安装包的 Windows 版还没做，本轮只出 macOS')

  const makensis = process.env.OTE_MAKENSIS ?? 'makensis'
  const nsisDir = process.env.NSISDIR

  let version
  try {
    version = run(makensis, ['-VERSION'], { env: process.env })
  } catch (error) {
    fail(
      `跑不了 makensis（${makensis}）。\n` +
        '  macOS 上取交叉编译器：下载 electron-builder-binaries 的 nsis-3.0.4.1.7z，解压后设\n' +
        '    NSISDIR=<解压目录> OTE_MAKENSIS=<解压目录>/mac/makensis node tools/build-installers.mjs --win',
    )
  }

  const exe = join(DIST, `${SLUG}-Setup-${VERSION}.exe`)
  rmSync(exe, { force: true })
  run(
    makensis,
    [
      '-DSOURCE=' + stage,
      '-DOUTFILE=' + exe,
      '-DASSETS=' + ASSETS,
      '-DAPP_VERSION=' + VERSION,
      join(INSTALLER, 'nsis', 'OteWork.nsi'),
    ],
    { env: nsisDir ? { ...process.env, NSISDIR: nsisDir } : process.env, stdio: ['ignore', 'pipe', 'inherit'] },
  )
  console.log(`  makensis ${version}`)
  out.push(exe)
}

rmSync(work, { recursive: true, force: true })

for (const file of out) {
  const size = statSync(file).size
  console.log(`\n已生成  ${file}`)
  console.log(`        ${(size / 1024 / 1024).toFixed(1)} MB   sha256 ${sha256(file).slice(0, 16)}…`)
}
console.log(`\n安装包本身没做代码签名：双击会被 Gatekeeper 拦一次（右键「打开」即可）。${
  wantApp ? '装进去的应用本体保持官方签名与公证，装完首次打开不会被拦。' : ''}`)
