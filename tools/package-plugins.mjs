#!/usr/bin/env node
/**
 * 打 OteWork 手工安装包（zip）：从 git 已提交内容导出 plugins/ 与仓库说明，配离线安装脚本
 * 与双击入口，压成 dist/OteWork-plugins-<sha>-<日期>.zip。工作区未提交的改动不进包。
 *
 * 面向「不想用安装器」的场合；正式发布用 tools/build-installers.mjs 出的 .pkg / .exe。
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { REPO, VERSION, stageSource, writeInstallDoc, writeLaunchers } from './lib/stage.mjs'

const stage = mkdtempSync(join(tmpdir(), 'ote-zip-'))
const meta = stageSource(stage)
writeInstallDoc(stage, meta)
writeLaunchers(stage)

mkdirSync(join(REPO, 'dist'), { recursive: true })
const zipPath = join(REPO, 'dist', `OteWork-plugins-${meta.sha}-${meta.stamp}.zip`)
rmSync(zipPath, { force: true })
execFileSync('zip', ['-r', '-q', '-X', zipPath, '.'], { cwd: stage })
rmSync(stage, { recursive: true, force: true })

console.log(`\n已打包  ${zipPath}  ${(statSync(zipPath).size / 1024).toFixed(0)} KB`)
console.log(`  版本   ${VERSION}   提交 ${meta.branch}@${meta.sha}${meta.dirty ? '  （工作区另有未提交改动，未进包）' : ''}`)
console.log(`  插件   ${meta.plugins.length} 个`)
