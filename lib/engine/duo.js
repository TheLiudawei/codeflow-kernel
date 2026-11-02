/**
 * 双图导入：一次扫描一个项目目录，在同一个项目名下产出**两个**画布视图。
 *
 * v0.6.0 之前，导入对话框让用户在标记任务流水线（`lib/importer.js`）与代码
 * 结构模块图（`lib/analyst.js`）之间二选一。两次扫描读的是同一个目录、用的
 * 是同一套规则，那个选择是虚假的省钱：本模块以一个共享项目名跑两个生成器，
 * 一次返回两张图。
 *
 * 失败隔离是契约的一部分：模块分析产不出可用的图（目录里几乎没有源码，或
 * 意外解析错误）时，任务流水线照常导入——模块视图以可行动的警告上报为
 * 不可用，绝不伪造一张空的模块图。任务流水线失败则整个导入失败。
 *
 * @module dsh-codeflow-canvas/duo
 */
import path from 'node:path'

import { analyzeModules } from './analyst.js'
import { clip } from './core/text.js'
import { freeName, safeProjectName } from './core/path.js'
import { importProject } from './importer.js'
import { cleanPathInput, resolveProjectRoot } from './paths.js'

/**
 * 对一个目录跑两个导入生成器。
 *
 * @param options.path - 要导入的目录（绝对或相对 `cwd`）。
 * @param options.cwd - 解析相对路径用的工作区。
 * @param options.existingNames - 项目根下已被占用的项目名。
 * @param options.projectName - 强制项目名（两张图共用）。
 * @param options.maxFiles - 文件预算（默认 200，上限 1000）。
 * @param options.maxDepth - 目录深度上限（任务流水线默认 4 / 模块图默认 6）。
 * @param options.fromComments - 从标记生成任务节点（默认 true）。
 * @param options.addTests - 没有测试文件时补 `testgen`（默认 true）。
 * @returns `{ tasksGraph, modulesGraph?, tasksSummary, modulesSummary?, summary,
 *   modulesWarning?, name }`；模块分析失败时 `modulesGraph` 为 `undefined`
 *   （见 `modulesWarning`）。
 */
export async function importProjectDual(options = {}) {
  const cwd = cleanPathInput(options.cwd ?? process.cwd())
  // 目录只解析（并校验）一次：坏路径在任何一个生成器启动之前就大声失败。
  const root = await resolveProjectRoot(options.path, cwd)
  const existingNames = Array.from(options.existingNames ?? [])
  const name = typeof options.projectName === 'string' && options.projectName.length > 0
    ? safeProjectName(options.projectName)
    : freeName(safeProjectName(path.basename(root)), existingNames)
  const shared = {
    ...options,
    path: root,
    cwd,
    // 一个项目、一个名字：两个生成器必须落进同一个目录，空闲名解析因此
    // 恰好发生一次、就在这里。
    projectName: name,
    existingNames,
  }

  const tasks = await importProject(shared)

  let modules
  let modulesWarning
  try {
    modules = await analyzeModules(shared)
  } catch (error) {
    modulesWarning = String(error?.message ?? error)
  }
  // "几乎没有源码"也算失败：一张只有孤零零扫描节点的图是一个假装存在的空
  // 模块视图。至少要有一个 module 节点。
  if (modules !== undefined && !modules.graph?.nodes?.some((node) => node.type === 'module')) {
    modules = undefined
    modulesWarning ??= '目录中没有可识别的源码文件，无法构建模块结构图'
  }

  const summary = modules !== undefined
    ? clip(`已生成：任务流水线 ${tasks.graph.nodes.length} 节点 · 模块结构图 ${modules.graph.nodes.filter((node) => node.type === 'module').length} 节点（可切换）`, 120)
    : clip(`已生成：任务流水线 ${tasks.graph.nodes.length} 节点 · 模块结构图不可用（可切换控件隐藏）`, 120)

  return {
    tasksGraph: tasks.graph,
    modulesGraph: modules?.graph,
    tasksSummary: tasks.summary,
    modulesSummary: modules?.summary,
    modulesWarning,
    summary,
    name,
  }
}

