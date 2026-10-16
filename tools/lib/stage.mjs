/**
 * 打包共享：从 git 已提交内容导出一份干净的插件树。
 * 工作区未提交的改动不进包（皮肤插件那类半成品不会被发出去）。
 *
 *   const meta = await stageSource(stage)
 *   // meta: { sha, branch, stamp, dirty, plugins: [{name, version, description}] }
 */

import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** 安装器给用户看的版本号，改这里就同时改了两个安装包。 */
export const VERSION = '1.0.0'

export function gitInfo() {
  const git = (args) => execFileSync('git', args, { cwd: REPO, encoding: 'utf8' }).trim()
  return {
    sha: git(['rev-parse', '--short', 'HEAD']),
    branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
    dirty: git(['status', '--porcelain', '--untracked-files=no']) !== '',
    stamp: new Date().toISOString().slice(0, 10).replace(/-/g, ''),
  }
}

/** 把 plugins/ 与仓库说明导进 stage，并放好离线安装脚本。 */
export function stageSource(stage, options = {}) {
  mkdirSync(stage, { recursive: true })
  const files = ['plugins', 'LICENSE', 'NOTICE']
  if (options.withReadme !== false) files.push('README.md')
  const archive = join(stage, '.archive.tar')
  execFileSync('git', ['archive', '--format=tar', '--output=' + archive, 'HEAD', ...files], { cwd: REPO })
  execFileSync('tar', ['-xf', archive, '-C', stage])
  rmSync(archive)
  if (existsSync(join(stage, 'plugins')) === false) throw new Error('git archive 没导出 plugins 目录，打包中止')
  cpSync(join(REPO, 'tools', 'install.mjs'), join(stage, 'install.mjs'))
  return { ...gitInfo(), plugins: readPlugins(stage) }
}

export function readPlugins(stage) {
  return readdirSync(join(stage, 'plugins'))
    .sort()
    .map((name) => {
      const pkg = JSON.parse(readFileSync(join(stage, 'plugins', name, 'package.json'), 'utf8'))
      return { name, version: pkg.version ?? '0.0.0', description: firstSentence(pkg.description ?? '') }
    })
}

function firstSentence(text) {
  const first = text.split(/[。.]\s?/)[0]
  return first.length > 44 ? first.slice(0, 44) + '…' : first
}

export function pluginTable(plugins, options = {}) {
  const rows = plugins.map((plugin) => `| \`${plugin.name}\` | ${plugin.version} | ${plugin.description} |`)
  if (options.header !== false) rows.unshift('| --- | --- | --- |', '| 插件 | 版本 | 作用 |')
  return rows.join('\n')
}

/** 包内 / 安装器里共用的那面说明。 */
export function writeInstallDoc(stage, meta) {
  const shaLine = `从 \`${meta.branch}\` 分支的提交 \`${meta.sha}\` 打包${meta.dirty ? '（打包时工作区另有未提交改动，**未**进包）' : ''}。装完两台机器比对版本号即可确认是否同步。`
  writeFileSync(join(stage, 'INSTALL.md'), `# OteWork 插件集 ${VERSION}

${shaLine}

## 装了什么

${pluginTable(meta.plugins)}

安装脚本把插件复制到 \`$DSH_HOME/local-plugins/\`，把每个 profile 的依赖与 \`dsh.profile.bundles\` 补齐，刷新 \`node_modules\` 链接——三处缺一插件不生效。可重复运行，会用新版覆盖旧版。

## 前提

DeepSeek Harness 已装好并至少启动过一次（要它先建出 profile 目录），Node.js 在 PATH 里。

## 还原

删掉 profile \`package.json\` 里这些 \`dsh-*\` 依赖与 \`dsh.profile.bundles\` 里的对应项，删掉 \`node_modules\` 里的同名链接与 \`local-plugins\` 里的目录，重启 DSH 即回到官方外观。
`)
}

/** 手工包（zip）用的双击入口，文件名保持 ASCII 免在 Windows 上乱码。 */
export function writeLaunchers(stage) {
  writeFileSync(join(stage, 'install.command'), '#!/bin/sh\ncd "$(dirname "$0")" || exit 1\nnode install.mjs\nprintf "\\n按回车关闭窗口"\nread _\n')
  execFileSync('chmod', ['+x', join(stage, 'install.command')])
  writeFileSync(join(stage, 'install.cmd'), '@echo off\r\ncd /d "%~dp0"\r\nnode install.mjs\r\npause\r\n')
}
