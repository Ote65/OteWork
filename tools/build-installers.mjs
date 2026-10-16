#!/usr/bin/env node
/**
 * 出正式安装包：macOS 的 .pkg（Apple 安装器界面）与 Windows 的 .exe（NSIS 向导界面）。
 *
 *   node tools/build-installers.mjs             两个平台都出
 *   node tools/build-installers.mjs --mac      只出 .pkg（需要 macOS）
 *   node tools/build-installers.mjs --win      只出 .exe
 *
 * 两个安装包的载荷同源：都从 tools/lib/stage.mjs 从 git 已提交内容导出（工作区未提交的
 * 改动不进包），装进 DSH 的动作都交给同一份 tools/install.mjs——三边行为一致。
 *
 * Windows 侧需要 makensis；macOS 上可从 electron-builder-binaries 取交叉编译器：
 *   https://github.com/electron-userland/electron-builder-binaries/releases (nsis-3.0.4.1.7z)
 * 解压后把目录给 NSISDIR，或用 OTE_MAKENSIS 指定 makensis 可执行文件。
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { REPO, VERSION, stageSource, writeInstallDoc } from './lib/stage.mjs'

const argv = process.argv.slice(2)
const only = argv.includes('--mac') ? 'mac' : argv.includes('--win') ? 'win' : null
const wantMac = only !== 'win'
const wantWin = only !== 'mac'

const INSTALLER = join(REPO, 'tools', 'installer')
const ASSETS = join(INSTALLER, 'branding', 'assets')
const DIST = join(REPO, 'dist')
const IDENTIFIER = 'com.otework.plugins'
const INSTALL_PATH = 'usr/local/share/OteWork'
const SLUG = 'OteWork'

function run(command, args, options = {}) {
  return execFileSync(command, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', ...options }).trim()
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** mac 安装器的说明页是 HTML，插件表要出成行而不是 markdown。 */
function pluginRowsHtml(plugins) {
  const rows = ['<tr><th>插件</th><th>版本</th><th>作用</th></tr>']
  for (const plugin of plugins) {
    rows.push(
      `<tr><td class="name">${escapeHtml(plugin.name)}</td><td>${escapeHtml(plugin.version)}</td><td>${escapeHtml(plugin.description)}</td></tr>`,
    )
  }
  return rows.join('\n')
}

function requireAsset(name) {
  const file = join(ASSETS, name)
  if (existsSync(file) === false) {
    fail(`缺少安装界面素材 ${name}，先跑：python3 tools/installer/branding/make.py`)
  }
  return file
}

function fail(message) {
  console.error('\n打包中止：' + message)
  process.exit(1)
}

const work = mkdtempSync(join(tmpdir(), 'ote-installer-'))
mkdirSync(DIST, { recursive: true })

const stage = join(work, 'payload')
const meta = stageSource(stage)
writeInstallDoc(stage, meta)

console.log(`\nOteWork ${VERSION}   来源 ${meta.branch}@${meta.sha}${meta.dirty ? '（工作区另有未提交改动，未进包）' : ''}`)
console.log(`载荷 ${meta.plugins.length} 个插件`)

const out = []

/* ---------- macOS：pkgbuild + productbuild ---------- */
if (wantMac) {
  if (process.platform !== 'darwin') fail('mac 安装包只能在 macOS 上打')

  const root = join(work, 'mac-root')
  cpSync(stage, join(root, INSTALL_PATH), { recursive: true })

  const scripts = join(work, 'mac-scripts')
  mkdirSync(scripts, { recursive: true })
  cpSync(join(INSTALLER, 'mac', 'scripts', 'postinstall'), join(scripts, 'postinstall'))
  chmodSync(join(scripts, 'postinstall'), 0o755)

  /* 安装器页面资源：Apple 只认这些固定文件名 */
  const resources = join(work, 'mac-resources')
  mkdirSync(resources, { recursive: true })
  cpSync(requireAsset('pkg-background.png'), join(resources, 'background.png'))
  cpSync(join(INSTALLER, 'mac', 'resources', 'welcome.html'), join(resources, 'welcome.html'))
  cpSync(join(stage, 'LICENSE'), join(resources, 'license.txt'))
  writeFileSync(
    join(resources, 'readme.html'),
    readFileSync(join(INSTALLER, 'mac', 'resources', 'readme.html'), 'utf8')
      .replace('<!--PLUGINS-->', pluginRowsHtml(meta.plugins)),
  )

  const component = join(work, 'pkgs', `${SLUG}-${VERSION}.pkg`)
  mkdirSync(join(work, 'pkgs'), { recursive: true })
  run('pkgbuild', [
    '--root', root,
    '--identifier', IDENTIFIER,
    '--version', VERSION,
    '--scripts', scripts,
    '--install-location', '/',
    component,
  ])

  const distribution = join(work, 'distribution.xml')
  writeFileSync(
    distribution,
    readFileSync(join(INSTALLER, 'mac', 'distribution.xml'), 'utf8')
      .replaceAll('@@TITLE@@', `${SLUG} ${VERSION}`)
      .replaceAll('@@VERSION@@', VERSION)
      .replaceAll('@@COMPONENT@@', `${SLUG}-${VERSION}.pkg`)
      .replaceAll('@@IDENTIFIER@@', IDENTIFIER),
  )

  const pkg = join(DIST, `${SLUG}-${VERSION}-macOS.pkg`)
  rmSync(pkg, { force: true })
  run('productbuild', [
    '--distribution', distribution,
    '--resources', resources,
    '--package-path', join(work, 'pkgs'),
    pkg,
  ])
  out.push(pkg)
}

/* ---------- Windows：makensis ---------- */
if (wantWin) {
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
console.log('\n两个安装包都未做代码签名：macOS 首次打开会被 Gatekeeper 拦（右键「打开」），Windows 会弹 SmartScreen（「更多信息」→「仍要运行」）。')
