/**
 * 内核的组合层：把四个纯本地分析器拼成一次调用。
 *
 * 四个分析器各自只做一件事（任务流水线 / 模块结构 / 耦合 / 功能归属），
 * 它们互不知道对方存在。本模块是唯一知道「一次仓库体检由哪几段组成」的
 * 地方——CLI、MCP 与库调用共享同一份编排，输出因此不会三处漂移。
 *
 * 全部确定性：不调用模型、不访问网络、同一次提交扫两次结果逐字节相同。
 *
 * @module codeflow-kernel/analysis
 */
import path from 'node:path'

import { analyzeModules } from './engine/analyst.js'
import { importProject } from './engine/importer.js'
import { importProjectDual } from './engine/duo.js'
import { analyzeCoupling, isFileModuleNode, overallOf, scanCouplingSources } from './engine/coupling.js'
import { buildFeatureIndex, summarize } from './engine/features.js'
import { LOW_CONFIDENCE } from './engine/features/constants.js'
import { resolveProjectRoot } from './engine/paths.js'

/** 报告格式标识：消费者据此判断字段契约。 */
export const FORMAT = 'codeflow-kernel/1'

/** 一次分析包含的段落；缺省全开。 */
export const SECTIONS = Object.freeze(['tasks', 'modules', 'coupling', 'features'])

/** 段名归一：`'tasks,modules'` / `['tasks']` / 缺省 → Set。 */
function sectionSet(input) {
  if (input === undefined || input === null) return new Set(SECTIONS)
  const values = Array.isArray(input) ? input : String(input).split(',')
  const wanted = new Set()
  for (const value of values) {
    const name = String(value).trim().toLowerCase()
    if (SECTIONS.includes(name)) wanted.add(name)
  }
  // 一个都不认识时退回全开：宁多算，不静默给空报告。
  return wanted.size > 0 ? wanted : new Set(SECTIONS)
}

/** 数值选项归一：缺省值、上下限都与引擎自身的硬上限一致。 */
function bounded(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(Math.max(Math.floor(number), min), max)
}

/**
 * 耦合报告：整个仓库的「屎山程度」+ 逐文件分数。
 *
 * 与画布无关——分数按项目相对路径给出，不依赖任何节点 id，所以 CI、CLI 与
 * 其他编辑器的 MCP 客户端拿到的数字完全一致。
 *
 * @param target - 项目目录（绝对或相对 `options.cwd`）。
 * @param options.cwd - 相对路径的解析基准。
 * @param options.maxFiles - 扫描文件预算（默认 1000，上限 1000）。
 * @param options.maxDepth - 目录深度上限（默认 6，上限 10）。
 * @param options.top - `external` 只保留前 N 个（默认 20）。
 * @param options.limit - `files` 只返回前 N 行（默认全部；项目级结论仍按全量算）。
 * @returns `{ format, root, overall, files, filesTotal, external, counts, durationMs }`。
 */
export async function couplingReport(target, options = {}) {
  const startedAt = Date.now()
  const root = await resolveProjectRoot(target, options.cwd)
  const { files } = await scanCouplingSources(root, {
    maxFiles: bounded(options.maxFiles, 1000, 1, 1000),
    maxDepth: bounded(options.maxDepth, 6, 1, 10),
  })
  const results = analyzeCoupling(files)

  // 逐文件行：按分数降序；同分按路径，保证两次运行顺序一致。
  const rows = []
  for (const [rel, result] of results) {
    rows.push({
      path: rel,
      score: result.score,
      level: result.level,
      intra: result.intra,
      inter: result.inter,
      metrics: result.metrics,
    })
  }
  rows.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))

  // 项目级结论复用引擎的加权口径（按行数加权 + 环惩罚），不另立一套阈值。
  const perNode = new Map(rows.map((row) => [row.path, row]))
  const overall = overallOf(
    rows.map((row) => ({ id: row.path })),
    perNode,
    rows.map((row) => ({ id: row.path, title: row.path, score: row.score, metrics: row.metrics })),
  )

  // 外部依赖热度：只数未解析到项目内的指示符（包名/URL/标准库）。
  // 注释里的示例代码（`from '…'`）也会被抽成指示符——非 ASCII/含空白的
  // 字符串不可能是一个真 import specifier，从热度榜里剔除，避免报告噪音。
  const externalCount = new Map()
  for (const file of files.values()) {
    for (const spec of file.external) {
      if (!/^[\x21-\x7e]+$/.test(spec)) continue
      externalCount.set(spec, (externalCount.get(spec) ?? 0) + 1)
    }
  }
  const top = bounded(options.top, 20, 1, 200)
  const external = [...externalCount.entries()]
    .map(([spec, count]) => ({ spec, count }))
    .sort((left, right) => right.count - left.count || left.spec.localeCompare(right.spec))
    .slice(0, top)

  return {
    format: FORMAT,
    root,
    overall,
    files: rows.slice(0, bounded(options.limit, rows.length, 1, Math.max(rows.length, 1))),
    filesTotal: rows.length,
    external,
    counts: {
      modules: rows.length,
      analyzed: overall?.analyzed ?? 0,
      cycles: overall?.cycles ?? 0,
      external: externalCount.size,
    },
    durationMs: Date.now() - startedAt,
  }
}

/**
 * 功能归属索引。
 *
 * @param target - 项目目录。
 * @param options.graph - 可选；已有模块图时复用它（避免二次扫描）。
 * @param options.designDoc - 可选；design 文档文本，缺省读 `<root>/docs/design.md`。
 * @param options.manual - 可选；保留的 manual 段。
 * @returns `{ root, summary, count, features, lowConfidence, designDoc }`。
 */
export async function featureIndex(target, options = {}) {
  const root = await resolveProjectRoot(target, options.cwd)
  const graph = options.graph ?? (await analyzeModules({ path: root, maxFiles: options.maxFiles, maxDepth: options.maxDepth })).graph
  const index = await buildFeatureIndex({ root, graph, designDoc: options.designDoc, manual: options.manual })
  const features = Array.isArray(index.features) ? index.features : []
  return {
    format: FORMAT,
    root,
    summary: summarize(index),
    count: features.length,
    lowConfidence: features.filter((feature) => (Number(feature?.confidence) || 0) < LOW_CONFIDENCE).length,
    features,
    unmapped: index.unmapped ?? [],
    unavailable: index.unavailable,
  }
}

/**
 * 一次完整仓库分析：任务流水线 + 模块结构 + 耦合 + 功能归属。
 *
 * @param options.path - 项目目录（缺省 `.`）。
 * @param options.cwd - 相对路径的解析基准。
 * @param options.include - 段落（`'tasks,modules'` 或数组），缺省全开。
 * @param options.maxFiles - 文件预算（默认 1000）。
 * @param options.maxDepth - 深度上限（任务默认 4 / 模块默认 6）。
 * @param options.fromComments - 从标记生成任务节点（默认 true）。
 * @param options.addTests - 缺测试时补 `testgen`（默认 true）。
 * @returns 报告对象；`tasks`/`modules` 是 `codeflow/1` 图，其余见上。
 */
export async function analyzeRepository(options = {}) {
  const startedAt = Date.now()
  const include = sectionSet(options.include)
  const cwd = options.cwd ?? process.cwd()
  const root = await resolveProjectRoot(options.path ?? '.', cwd)
  const maxFiles = bounded(options.maxFiles, 1000, 1, 1000)

  const wantTasks = include.has('tasks')
  const wantModules = include.has('modules')
  let dual
  if (wantTasks || wantModules) {
    dual = await importProjectDual({
      path: root,
      cwd,
      maxFiles,
      maxDepth: bounded(options.maxDepth, wantModules && !wantTasks ? 6 : 4, 1, 10),
      fromComments: options.fromComments,
      addTests: options.addTests,
    })
  }
  // 功能归属需要模块图做节点映射：模块段没要时也要图，但不对外声称「模块图可用」。
  const graph = dual?.modulesGraph
    ?? (include.has('features') ? (await analyzeModules({ path: root, maxFiles, maxDepth: 6 })).graph : undefined)

  const coupling = include.has('coupling')
    ? await couplingReport(root, { cwd, maxFiles })
    : null
  let features = null
  if (include.has('features')) {
    const index = await buildFeatureIndex(graph !== undefined ? { root, graph } : { root })
    features = {
      summary: summarize(index),
      count: Array.isArray(index.features) ? index.features.length : 0,
      features: index.features ?? [],
      unmapped: index.unmapped ?? [],
      unavailable: index.unavailable,
    }
  }

  const parts = []
  if (wantTasks) parts.push(`任务 ${dual.tasksGraph.nodes.length} 节点`)
  if (wantModules) {
    parts.push(dual.modulesGraph !== undefined
      ? `模块 ${dual.modulesGraph.nodes.filter(isFileModuleNode).length} 文件`
      : '模块图不可用')
  }
  if (coupling?.overall) parts.push(`耦合 ${coupling.overall.score}（${coupling.overall.level}）`)
  if (features) parts.push(features.summary)

  return {
    format: FORMAT,
    root,
    name: dual?.name ?? path.basename(root),
    language: dual?.tasksGraph?.project?.language ?? graph?.project?.language,
    summary: parts.join(' · '),
    tasks: wantTasks ? dual.tasksGraph : null,
    modules: wantModules ? (dual.modulesGraph ?? null) : null,
    modulesWarning: wantModules ? dual?.modulesWarning : undefined,
    tasksSummary: wantTasks ? dual?.tasksSummary : undefined,
    modulesSummary: wantModules ? dual?.modulesSummary : undefined,
    coupling,
    features,
    stats: {
      tasks: wantTasks ? dual.tasksGraph.nodes.length : 0,
      modules: wantModules ? (dual?.modulesGraph?.nodes ?? []).filter(isFileModuleNode).length : 0,
      couplingScore: coupling?.overall?.score ?? null,
      features: features?.count ?? 0,
      durationMs: Date.now() - startedAt,
    },
  }
}

/** 单个段落的薄封装，供 CLI/MCP 直接调用。 */
export async function tasksGraph(target, options = {}) {
  return importProject({ ...options, path: target, cwd: options.cwd ?? process.cwd() })
}

export async function modulesGraph(target, options = {}) {
  return analyzeModules({ ...options, path: target, cwd: options.cwd ?? process.cwd() })
}
