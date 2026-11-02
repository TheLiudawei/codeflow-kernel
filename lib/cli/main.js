/**
 * CLI：给人、给 CI 用的那半边。
 *
 * 五个子命令对应五个问题：
 *
 *   analyze  这个仓库长什么样？（四段合一的体检报告）
 *   tasks    我的 TODO 注释能变成哪些任务？
 *   modules  代码块是怎么组织的？
 *   coupling 哪里缠得最死、哪里成环？
 *   features 这个项目有哪些功能、各占哪些文件？
 *
 * 所有子命令都支持 `--json`（机读，稳定契约）与人类可读的紧凑表格两种输出。
 * 退出码：0 成功 / 1 分析失败 / 2 用法错误。
 *
 * @module codeflow-kernel/cli
 */
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { analyzeRepository, couplingReport, featureIndex, modulesGraph, tasksGraph } from '../analysis.js'

/** 用法文本（`--help` 与用法错误共用）。 */
const USAGE = `codeflow-kernel — 确定性代码结构分析（零依赖）

用法:
  codeflow-kernel analyze  [路径] [选项]   完整报告：任务 + 模块 + 耦合 + 功能
  codeflow-kernel tasks    [路径] [选项]   任务流水线（标记 → 待办任务）
  codeflow-kernel modules  [路径] [选项]   模块结构图
  codeflow-kernel coupling [路径] [选项]   耦合评分（0–100）与成环
  codeflow-kernel features [路径] [选项]   功能归属索引
  codeflow-kernel mcp                      以 MCP stdio server 运行

选项:
  --json              输出 JSON（机读契约，字段见 README）
  --out <文件>        把 JSON 写入文件而不是 stdout
  --max-files <n>     扫描文件预算（默认 1000，上限 1000）
  --depth <n>         目录深度（任务默认 4 / 模块与耦合默认 6）
  --top <n>           人类可读输出列出的行数（默认 10）
  --include <列表>    analyze 的段落，逗号分隔：tasks,modules,coupling,features
  --no-tasks          不把待办注释生成为任务节点
  --no-tests          缺测试时不补 testgen 节点
  -h, --help          显示本帮助
  -v, --version       显示版本

示例:
  codeflow-kernel analyze . --json
  codeflow-kernel coupling ~/proj --top 5
  codeflow-kernel analyze . --include coupling,features --out report.json

退出码: 0 成功 · 1 分析失败 · 2 用法错误`

/** 认识所有子命令；`mcp` 由 bin 入口分发，这里保留名称用于帮助文本。 */
const COMMANDS = new Set(['analyze', 'tasks', 'modules', 'coupling', 'features'])

/** 仅 TTY 才上颜色——重定向到文件时输出保持干净。 */
const tty = process.stdout.isTTY === true
const dim = (text) => (tty ? `\u001b[2m${text}\u001b[0m` : String(text))
const bold = (text) => (tty ? `\u001b[1m${text}\u001b[0m` : String(text))
const levelColor = (level) => {
  if (!tty) return level
  const code = level === 'high' ? 31 : level === 'medium' ? 33 : 32
  return `\u001b[${code}m${level}\u001b[0m`
}

/** `--key value` / `--key=value` 两种写法都收。 */
function readOption(argv, index, name) {
  const arg = argv[index]
  if (arg === name) return { value: argv[index + 1], consumed: 2 }
  if (arg.startsWith(`${name}=`)) return { value: arg.slice(name.length + 1), consumed: 1 }
  return undefined
}

/**
 * 解析 argv。返回 `{ command, path, flags }`；`help`/`version` 由调用方短路。
 * @throws 缺少选项值或出现未知选项时（用法错误）。
 */
export function parseArgs(argv) {
  const flags = {
    json: false, out: undefined, maxFiles: undefined, depth: undefined,
    top: undefined, include: undefined, fromComments: true, addTests: true,
  }
  let command
  let target
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '-h' || arg === '--help') return { help: true }
    if (arg === '-v' || arg === '--version') return { version: true }
    if (arg === '--json') { flags.json = true; continue }
    if (arg === '--no-tasks') { flags.fromComments = false; continue }
    if (arg === '--no-tests') { flags.addTests = false; continue }
    const options = [
      ['--out', 'out'], ['--max-files', 'maxFiles'], ['--depth', 'depth'],
      ['--top', 'top'], ['--include', 'include'],
    ]
    const hit = options.find(([name]) => arg === name || arg.startsWith(`${name}=`))
    if (hit !== undefined) {
      const parsed = readOption(argv, i, hit[0])
      if (parsed.value === undefined) throw new UsageError(`选项 ${hit[0]} 缺少取值`)
      flags[hit[1]] = parsed.value
      i += parsed.consumed - 1
      continue
    }
    if (arg.startsWith('-')) throw new UsageError(`未知选项：${arg}`)
    if (command === undefined) command = arg
    else if (target === undefined) target = arg
    else throw new UsageError(`多余的参数：${arg}`)
  }
  return { command, target: target ?? '.', flags }
}

/** 用法错误：调用方据此返回 2。 */
export class UsageError extends Error {}

/** 数字选项校验：非法值直接报用法错误，绝不静默用默认值。 */
function numberFlag(flags, name, fallback) {
  const raw = flags[name]
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) throw new UsageError(`选项 --${name} 需要正整数，收到：${raw}`)
  return Math.floor(value)
}

/** 缩到指定显示宽度（不切 UTF-8 半个字符）。 */
function fit(text, width) {
  const value = String(text ?? '')
  return value.length <= width ? value : `${value.slice(0, Math.max(1, width - 1))}…`
}

/** 人类可读的耦合小节。 */
function renderCoupling(report, top) {
  const overall = report.overall
  const lines = []
  if (overall === null) {
    lines.push('无可分析的源码模块')
    return lines.join('\n')
  }
  lines.push(`${bold(`耦合 ${overall.score}/100`)} · ${levelColor(overall.level)} · 模块 ${overall.modules} · 已分析 ${overall.analyzed}${overall.cycles > 0 ? ` · ${overall.cycles} 个文件在环里` : ''}`)
  if (overall.partial) lines.push(dim('（部分文件超出扫描预算，结论按已分析部分给出）'))
  for (const row of report.files.slice(0, top)) {
    lines.push(`  ${String(row.score).padStart(3)} ${levelColor(row.level).padEnd(tty ? 14 : 6)} ${row.path}  ${dim(`in ${row.metrics.fanIn} / out ${row.metrics.fanOut} / ${row.metrics.lines} 行`)}`)
  }
  if (report.files.length > top) lines.push(dim(`  …共 ${report.files.length} 个文件`))
  if (report.external.length > 0) {
    lines.push(dim(`外部依赖：${report.external.slice(0, top).map((entry) => `${entry.spec}×${entry.count}`).join('  ')}`))
  }
  return lines.join('\n')
}

/** 人类可读的任务/模块图小节。 */
function renderGraph(graph, { top, kind }) {
  if (graph === null || graph === undefined) return '不可用'
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : []
  const shown = nodes.slice(0, top)
  const lines = []
  for (const node of shown) {
    const label = node.type === 'module' ? `${node.title}` : `${node.type}  ${node.title}`
    const extra = node.type === 'module'
      ? dim(node.params?.role ? ` · ${node.params.role}` : '')
      : dim(` · ${node.status}`)
    lines.push(`  ${fit(label, 44)}${extra}`)
  }
  if (nodes.length > top) lines.push(dim(`  …共 ${nodes.length} 个节点（--top 调大）`))
  if (kind === 'tasks' && !nodes.some((node) => node.type === 'edit')) {
    lines.push(dim('没有待办标记：仓库里没有 TODO/FIXME 之类可转成任务的注释。'))
  }
  return lines.join('\n')
}

/** 人类可读的功能小节。 */
function renderFeatures(report, top) {
  if (report.count === 0) {
    return report.unavailable !== undefined
      ? `功能归属不可用：${report.unavailable}`
      : '没有识别到功能（仓库里没有足够信号）'
  }
  const lines = [bold(report.summary)]
  for (const feature of report.features.slice(0, top)) {
    const confidence = Number(feature.confidence) || 0
    const files = (feature.files ?? []).slice(0, 4).join(', ')
    const more = (feature.files ?? []).length > 4 ? ` …+${feature.files.length - 4}` : ''
    lines.push(`  ${fit(feature.name ?? feature.id, 28)} ${dim(`${confidence.toFixed(2)}`)}  ${fit(files, 60)}${dim(more)}`)
  }
  if (report.features.length > top) lines.push(dim(`  …共 ${report.features.length} 个功能`))
  return lines.join('\n')
}

/** 写 JSON：`--out` 指定文件时写文件，否则 stdout。 */
async function emitJson(payload, outFile) {
  const text = `${JSON.stringify(payload, null, 2)}\n`
  if (outFile === undefined) {
    process.stdout.write(text)
    return
  }
  const absolute = path.resolve(outFile)
  await mkdir(path.dirname(absolute), { recursive: true })
  await writeFile(absolute, text, 'utf8')
  process.stderr.write(`已写入 ${absolute}\n`)
}

/**
 * CLI 主入口。
 * @param argv - 默认 `process.argv.slice(2)`。
 * @returns 退出码。
 */
export async function main(argv = process.argv.slice(2)) {
  let parsed
  try {
    parsed = parseArgs(argv)
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`错误: ${error.message}\n\n${USAGE}\n`)
      return 2
    }
    throw error
  }
  if (parsed.help === true) { process.stdout.write(`${USAGE}\n`); return 0 }
  if (parsed.version === true) { process.stdout.write(`${await version()}\n`); return 0 }

  if (parsed.command === 'mcp') {
    const { serveStdio } = await import('../mcp/server.js')
    await serveStdio()
    return 0
  }
  if (parsed.command === undefined) {
    process.stdout.write(`${USAGE}\n`)
    return 2
  }
  if (!COMMANDS.has(parsed.command)) {
    process.stderr.write(`错误: 未知子命令 ${parsed.command}\n\n${USAGE}\n`)
    return 2
  }

  const flags = parsed.flags
  let top
  let maxFiles
  let depth
  try {
    top = numberFlag(flags, 'top', 10)
    maxFiles = numberFlag(flags, 'maxFiles', 1000)
    depth = flags.depth === undefined ? undefined : numberFlag(flags, 'depth', 6)
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`错误: ${error.message}\n\n${USAGE}\n`)
      return 2
    }
    throw error
  }
  const target = parsed.target

  try {
    if (parsed.command === 'analyze') {
      const report = await analyzeRepository({
        path: target,
        include: flags.include,
        maxFiles,
        maxDepth: depth,
        fromComments: flags.fromComments,
        addTests: flags.addTests,
      })
      if (flags.json) {
        await emitJson(report, flags.out)
        return 0
      }
      const lines = [
        `${bold('codeflow-kernel')} ${dim(await version())} · ${report.root}`,
        bold(report.summary),
      ]
      if (report.tasks !== null) {
        lines.push('', bold('任务流水线'), renderGraph(report.tasks, { top, kind: 'tasks' }))
      }
      if (report.modules !== null) {
        lines.push('', bold('模块结构'), renderGraph(report.modules, { top, kind: 'modules' }))
      }
      if (report.coupling !== null) lines.push('', bold('耦合'), renderCoupling(report.coupling, top))
      if (report.features !== null) lines.push('', bold('功能'), renderFeatures(report.features, top))
      process.stdout.write(`${lines.join('\n')}\n`)
      return 0
    }

    if (parsed.command === 'tasks') {
      const result = await tasksGraph(target, {
        maxFiles, maxDepth: depth ?? 4,
        fromComments: flags.fromComments, addTests: flags.addTests,
      })
      if (flags.json) { await emitJson(result, flags.out); return 0 }
      process.stdout.write(`${bold(result.summary)}\n${renderGraph(result.graph, { top, kind: 'tasks' })}\n`)
      return 0
    }

    if (parsed.command === 'modules') {
      const result = await modulesGraph(target, { maxFiles, maxDepth: depth ?? 6 })
      if (flags.json) { await emitJson(result, flags.out); return 0 }
      process.stdout.write(`${bold(result.summary)}\n${renderGraph(result.graph, { top, kind: 'modules' })}\n`)
      return 0
    }

    if (parsed.command === 'coupling') {
      const report = await couplingReport(target, { maxFiles, maxDepth: depth ?? 6, top })
      if (flags.json) { await emitJson(report, flags.out); return 0 }
      process.stdout.write(`${renderCoupling(report, top)}\n`)
      return 0
    }

    // features
    const report = await featureIndex(target, { maxFiles, maxDepth: depth ?? 6 })
    if (flags.json) { await emitJson(report, flags.out); return 0 }
    process.stdout.write(`${renderFeatures(report, top)}\n`)
    return 0
  } catch (error) {
    process.stderr.write(`分析失败: ${error?.message ?? error}\n`)
    return 1
  }
}

/** 版本号从 package.json 读（只读一次，不引入构建步骤）。 */
async function version() {
  if (version.cache !== undefined) return version.cache
  const { readFile } = await import('node:fs/promises')
  const { fileURLToPath } = await import('node:url')
  try {
    const file = fileURLToPath(new URL('../../package.json', import.meta.url))
    version.cache = JSON.parse(await readFile(file, 'utf8')).version ?? '0.0.0'
  } catch {
    version.cache = '0.0.0'
  }
  return version.cache
}
