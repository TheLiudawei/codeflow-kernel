/**
 * 引擎层测试：两个生成器、耦合度量、功能归属、以及「同一次提交扫两次，
 * 结构逐字节相同」这条核心承诺。
 *
 * @module codeflow-kernel/tests/engine
 */
import {
  FIXTURE_SOURCE_FILES,
  check,
  makeFixture,
  stripVolatile,
} from './helpers.mjs'
import {
  analyzeRepository,
  couplingReport,
  featureIndex,
  importProjectDual,
  levelOf,
} from '../lib/index.js'

/** 任务流水线：链式结构合法、标记变成了待办节点。 */
function assertTasksGraph(graph) {
  check(graph.format === 'codeflow/1', `tasks format: ${graph.format}`)
  const types = graph.nodes.map((node) => node.type)
  check(types.includes('scan'), '任务图缺少 scan 节点')
  check(types.includes('comments'), '任务图缺少 comments 节点')
  const edits = graph.nodes.filter((node) => node.type === 'edit')
  check(edits.length >= 1, `TODO/FIXME 没有生成任务节点（edit=${edits.length}）`)
  const ids = new Set(graph.nodes.map((node) => node.id))
  for (const [from, , to] of graph.links) {
    check(ids.has(from) && ids.has(to), `悬空连线: ${from} → ${to}`)
  }
  // scan → comments 是固定起点。
  check(graph.links.some(([, , to]) => to === 't2'), 'scan 没有连到 comments')
}

/** 模块图：每个源码文件一个文件级 module 节点（带 symbol 的是符号子节点）。 */
function assertModulesGraph(graph, root) {
  const fileNodes = graph.nodes.filter((node) => node.type === 'module'
    && (node.params?.symbol === undefined || node.params.symbol === ''))
  check(fileNodes.length === FIXTURE_SOURCE_FILES, `文件级模块节点 ${fileNodes.length}，期望 ${FIXTURE_SOURCE_FILES}`)
  for (const node of fileNodes) {
    check(typeof node.params?.path === 'string' && node.params.path.startsWith(root), `模块节点路径越界: ${node.params?.path}`)
  }
  // 关键文件会展开出符号子节点（同 type，靠 params.symbol 区分）。
  const symbolNodes = graph.nodes.filter((node) => node.type === 'module' && node.params?.symbol !== undefined && node.params.symbol !== '')
  check(symbolNodes.length > 0, '关键文件没有展开成符号子节点')
}

export async function run() {
  const { root, cleanup } = await makeFixture()
  try {
    const first = await importProjectDual({ path: root, maxFiles: 200, maxDepth: 6 })
    assertTasksGraph(first.tasksGraph)
    check(first.modulesGraph !== undefined, `模块图缺失: ${first.modulesWarning}`)
    assertModulesGraph(first.modulesGraph, root)

    // ---- 确定性 -------------------------------------------------------------
    const second = await importProjectDual({ path: root, maxFiles: 200, maxDepth: 6 })
    const left = JSON.stringify(stripVolatile(first.tasksGraph))
    const right = JSON.stringify(stripVolatile(second.tasksGraph))
    check(left === right, '任务流水线不是确定性的：两次扫描结构不同')
    const modulesLeft = JSON.stringify(stripVolatile(first.modulesGraph))
    const modulesRight = JSON.stringify(stripVolatile(second.modulesGraph))
    check(modulesLeft === modulesRight, '模块图不是确定性的：两次扫描结构不同')

    // ---- 耦合 ---------------------------------------------------------------
    const report = await couplingReport(root)
    check(report.format === 'codeflow-kernel/1', `coupling format: ${report.format}`)
    check(report.overall !== null, '耦合报告缺少项目级结论')
    check(report.overall.score >= 0 && report.overall.score <= 100, `分数越界: ${report.overall.score}`)
    check(['low', 'medium', 'high'].includes(report.overall.level), `非法等级: ${report.overall.level}`)
    check(report.overall.cycles >= 2, `a.js ↔ b.js 的环没有被检出（cycles=${report.overall.cycles}）`)
    check(report.overall.modules >= FIXTURE_SOURCE_FILES, `模块数 ${report.overall.modules} 小于源码文件数`)
    for (let i = 1; i < report.files.length; i += 1) {
      check(report.files[i - 1].score >= report.files[i].score, '逐文件行没有按分数降序')
    }
    check(report.files.every((row) => row.level === levelOf(row.score)), '逐文件等级与分数阈值不一致')
    check(report.external.some((entry) => entry.spec === 'node:fs/promises'), 'node: 内建依赖没有进外部依赖榜')
    check(report.external.every((entry) => /^[\x21-\x7e]+$/.test(entry.spec)), '外部依赖榜混入了非 import 字符串')

    // 阈值是契约：30/60 两档。
    check(levelOf(0) === 'low' && levelOf(29) === 'low', 'levelOf 低档阈值漂移')
    check(levelOf(30) === 'medium' && levelOf(59) === 'medium', 'levelOf 中档阈值漂移')
    check(levelOf(60) === 'high' && levelOf(100) === 'high', 'levelOf 高档阈值漂移')

    // ---- 功能归属 -----------------------------------------------------------
    const features = await featureIndex(root)
    check(features.count >= 1, '没有识别出任何功能')
    check(features.summary.includes('功能'), `功能汇总格式异常: ${features.summary}`)
    for (const feature of features.features) {
      check(Array.isArray(feature.files) && feature.files.length > 0, `功能 ${feature.name} 没有归属文件`)
      check(Array.isArray(feature.evidence), `功能 ${feature.name} 缺少证据列表`)
    }

    // ---- 组合报告 -----------------------------------------------------------
    const all = await analyzeRepository({ path: root, maxFiles: 200 })
    check(all.tasks !== null && all.modules !== null && all.coupling !== null && all.features !== null, '默认报告缺少段落')
    check(all.stats.couplingScore === all.coupling.overall.score, 'stats.couplingScore 与耦合报告不一致')

    const onlyCoupling = await analyzeRepository({ path: root, include: 'coupling', maxFiles: 200 })
    check(onlyCoupling.tasks === null && onlyCoupling.modules === null && onlyCoupling.features === null, '--include 没有裁掉未请求的段落')
    check(onlyCoupling.coupling !== null, '--include coupling 缺了耦合段')

    // 报告不因重复调用而漂移（耦合没有时间戳字段）。
    const again = await couplingReport(root)
    check(JSON.stringify(report.files) === JSON.stringify(again.files), '耦合报告不是确定性的')
  } finally {
    await cleanup()
  }
}
