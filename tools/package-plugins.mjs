#!/usr/bin/env node
/**
 * 打 OteWork 插件安装包：从 git 已提交内容导出 plugins/ 与仓库说明，配上一键安装脚本，
 * 压成 dist/OteWork-插件包-<sha>-<日期>.zip。工作区未提交的改动不进包。
 *
 *   node tools/package-plugins.mjs
 */

import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, rmSync, statSync, writeFileSync, mkdirSync, readdirSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()

const sha = git(['rev-parse', '--short', 'HEAD'])
const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'])
const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '')
const dirty = git(['status', '--porcelain', '--untracked-files=no']) !== ''

const stage = mkdtempSync(join(tmpdir(), 'ote-pkg-'))
const zipName = `OteWork-plugins-${sha}-${stamp}.zip`
const zipPath = join(root, 'dist', zipName)

/* ---- 一、导出已提交内容 ---- */
const archive = join(stage, '.archive.tar')
execFileSync('git', ['archive', '--format=tar', '--output=' + archive, 'HEAD', 'plugins', 'README.md', 'LICENSE', 'NOTICE'], { cwd: root })
execFileSync('tar', ['-xf', archive, '-C', stage])
rmSync(archive)
if (existsSync(join(stage, 'plugins')) === false) throw new Error('git archive 没导出 plugins 目录，打包中止')

/* ---- 二、放安装脚本与两个双击入口（文件名保持 ASCII，避免 zip 在 Windows 上乱码） ---- */
cpSync(join(root, 'tools', 'install.mjs'), join(stage, 'install.mjs'))
writeFileSync(join(stage, 'install.command'), '#!/bin/sh\ncd "$(dirname "$0")" || exit 1\nnode install.mjs\nprintf "\\n按回车关闭窗口"\nread _\n')
execFileSync('chmod', ['+x', join(stage, 'install.command')])
writeFileSync(join(stage, 'install.cmd'), '@echo off\r\ncd /d "%~dp0"\r\nnode install.mjs\r\npause\r\n')

/* ---- 三、包内版本说明 ---- */
const plugins = readdirSync(join(stage, 'plugins')).sort()
const oneLine = (text) => {
  const first = text.split(/[。.]\s?/)[0]
  return first.length > 44 ? first.slice(0, 44) + '…' : first
}
const rows = plugins.map((name) => {
  const pkg = JSON.parse(readFileSync(join(stage, 'plugins', name, 'package.json'), 'utf8'))
  return `| \`${name}\` | ${pkg.version} | ${oneLine(pkg.description)} |`
})
writeFileSync(join(stage, 'INSTALL.md'), `# OteWork 插件包 ${sha}-${stamp}

从 \`${branch}\` 分支的提交 \`${sha}\` 打包${dirty ? '（打包时工作区另有未提交改动，**未**进包）' : ''}。装完两台机器比对版本号即可确认是否同步。

## 怎么装

1. 把本压缩包**完整解压**到一个不会被删掉的位置（装完插件会链接到这里）。
2. 双击 \`install.command\`（macOS）或 \`install.cmd\`（Windows）；也可以在解压目录里跑 \`node install.mjs\`。
   想先看会改什么就加 \`--dry-run\`，只装某一个 profile 就加 \`--profile web\`。
3. 完全退出并重启 DeepSeek Harness。

脚本做三件事：把插件复制到 \`$DSH_HOME/local-plugins/\`，把每个 profile 的依赖与 \`dsh.profile.bundles\` 补齐，刷新 \`node_modules\` 链接。可重复运行，会用新包覆盖旧版本。

## 包含的插件

| 插件 | 版本 | 作用 |
| --- | --- | --- |
${rows.join('\n')}

## 还原

删掉 profile 的 \`package.json\` 里这些 \`dsh-*\` 依赖与 \`dsh.profile.bundles\` 里的对应项，删掉 \`node_modules\` 里的同名链接与 \`local-plugins\` 里的目录，重启 DSH 即回到官方外观。
`)

/* ---- 四、压包 ---- */
mkdirSync(join(root, 'dist'), { recursive: true })
rmSync(zipPath, { force: true })
execFileSync('zip', ['-r', '-q', '-X', zipPath, '.'], { cwd: stage })
rmSync(stage, { recursive: true, force: true })

console.log(`\n已打包  ${zipPath}  ${(statSync(zipPath).size / 1024).toFixed(0)} KB`)
console.log(`  提交   ${branch}@${sha}${dirty ? '  （工作区另有未提交改动，未进包）' : ''}`)
console.log(`  插件   ${plugins.length} 个：${plugins.join('、')}`)
