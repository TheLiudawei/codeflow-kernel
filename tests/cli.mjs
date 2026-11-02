/**
 * CLI 测试：真实子进程 + 真实退出码 + 可解析的 JSON 契约。
 *
 * @module codeflow-kernel/tests/cli
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { check, makeFixture, runNode } from './helpers.mjs'

const BIN = fileURLToPath(new URL('../bin/codeflow-kernel.js', import.meta.url))

/** 跑 CLI 并断言成功退出。 */
async function cli(args, options) {
  const result = await runNode([BIN, ...args], options)
  check(result.code === 0, `CLI 退出码 ${result.code}: ${result.stderr.trim().slice(0, 600)}`)
  return result
}

/** 解析成功退出的 `--json` 输出。 */
async function cliJson(args, options) {
  const result = await cli([...args, '--json'], options)
  try {
    return JSON.parse(result.stdout)
  } catch (error) {
    throw new Error(`CLI 输出不是合法 JSON: ${error.message}\n${result.stdout.slice(0, 400)}`)
  }
}

export async function run() {
  const { root, cleanup } = await makeFixture()
  const outDir = await mkdtemp(path.join(tmpdir(), 'codeflow-kernel-out-'))
  try {
    // ---- 帮助 / 版本 / 用法错误 ---------------------------------------------
    const help = await cli(['--help'])
    check(help.stdout.includes('codeflow-kernel analyze'), '--help 缺少用法')
    check(help.stdout.includes('退出码'), '--help 缺少退出码说明')

    const version = await cli(['--version'])
    check(/^\d+\.\d+\.\d+$/m.test(version.stdout.trim()), `--version 输出异常: ${version.stdout}`)

    const unknown = await runNode([BIN, 'nope'], { cwd: root })
    check(unknown.code === 2, `未知子命令应退出 2，实际 ${unknown.code}`)

    const badFlag = await runNode([BIN, 'analyze', root, '--max-files', 'abc'], { cwd: root })
    check(badFlag.code === 2, `非法 --max-files 应退出 2，实际 ${badFlag.code}`)

    // ---- analyze ------------------------------------------------------------
    const report = await cliJson(['analyze', root, '--max-files', '200'], { cwd: root })
    check(report.format === 'codeflow-kernel/1', `format: ${report.format}`)
    check(report.tasks !== null && report.modules !== null, 'analyze 缺少图段落')
    check(report.coupling?.overall?.score >= 0, 'analyze 缺少耦合分数')
    check(report.features?.count >= 1, 'analyze 缺少功能段')
    check(report.stats.durationMs >= 0, '缺少 stats.durationMs')

    // ---- 单段命令 -----------------------------------------------------------
    const coupling = await cliJson(['coupling', root], { cwd: root })
    check(coupling.overall?.cycles >= 2, 'coupling 没检出环')
    check(coupling.filesTotal === coupling.files.length, 'coupling 默认不应截断文件行')

    const features = await cliJson(['features', root], { cwd: root })
    check(features.count >= 1, 'features 没有结果')

    const tasks = await cliJson(['tasks', root], { cwd: root })
    check(tasks.graph.nodes.some((node) => node.type === 'edit'), 'tasks 没有生成待办节点')

    const modules = await cliJson(['modules', root], { cwd: root })
    check(modules.graph.nodes.some((node) => node.type === 'module'), 'modules 没有模块节点')

    // ---- 人类可读输出（无 ANSI，因为 stdout 不是 TTY） ------------------------
    const human = await cli(['coupling', root, '--top', '2'], { cwd: root })
    check(!human.stdout.includes('\u001b['), '非 TTY 输出不应带颜色')
    check(human.stdout.includes('耦合'), '人类可读输出缺少标题')

    // ---- --out 写文件 -------------------------------------------------------
    const outFile = path.join(outDir, 'report.json')
    await cli(['analyze', root, '--json', '--max-files', '200', '--out', outFile], { cwd: root })
    const written = JSON.parse(await readFile(outFile, 'utf8'))
    check(written.format === 'codeflow-kernel/1', '--out 写出的文件不是报告')

    // --out 隐含 --json：不应再往 stdout 打人类可读内容。
    const impliedFile = path.join(outDir, 'implied.json')
    const implied = await cli(['coupling', root, '--out', impliedFile], { cwd: root })
    check(implied.stdout.trim() === '', `--out 仍向 stdout 输出了内容: ${implied.stdout.slice(0, 200)}`)
    check(JSON.parse(await readFile(impliedFile, 'utf8')).overall !== null, '--out 没有隐含 --json')

    // ---- 失败路径 -----------------------------------------------------------
    const missing = await runNode([BIN, 'analyze', path.join(root, 'does-not-exist')], { cwd: root })
    check(missing.code === 1, `不存在的路径应退出 1，实际 ${missing.code}`)
    check(missing.stderr.includes('目录不存在'), `错误信息不够具体: ${missing.stderr.trim()}`)
  } finally {
    await cleanup()
    await rm(outDir, { recursive: true, force: true })
  }
}
