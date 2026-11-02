/**
 * codeflow-kernel 的公共 API。
 *
 * 两层：
 *
 *   - **组合层**（本仓库新增）——`analyzeRepository` 一次给出任务流水线、模块
 *     结构、耦合报告与功能归属；`couplingReport` / `featureIndex` 是单段入口。
 *   - **引擎层**（从 dsh-codeflow-canvas 剥离）——扫描、符号提取、图装配、
 *     耦合度量、功能识别。全部纯本地、零依赖，不依赖任何宿主 SDK。
 *
 * 库调用、CLI 与 MCP server 共用这一份导出，三处行为因此不会漂移。
 *
 * @module codeflow-kernel
 */

/* ------------------------------------------------------- 组合层（新增） --- */
export {
  FORMAT,
  SECTIONS,
  analyzeRepository,
  couplingReport,
  featureIndex,
  tasksGraph,
  modulesGraph,
} from './analysis.js'

/* ------------------------------------------------------- 引擎层（剥离） --- */
export { importProject, MAX_FILES_CAP } from './engine/importer.js'
export { analyzeModules } from './engine/analyst.js'
export { importProjectDual } from './engine/duo.js'
export {
  COUPLING_SCAN_DEPTH,
  COUPLING_SCAN_FILES,
  COUPLING_WEIGHTS,
  LEVEL_HIGH,
  LEVEL_MEDIUM,
  analyzeCoupling,
  clamp01,
  intraMetrics,
  isFileModuleNode,
  levelOf,
  overallOf,
  runCoupling,
  sat,
  scanCouplingSources,
  stronglyConnected,
} from './engine/coupling.js'
export {
  FEATURES_FILE,
  MAX_FEATURES,
  applyManual,
  buildDictionary,
  buildFeatureIndex,
  computeStale,
  effectiveFeatures,
  featureOp,
  graphRootOf,
  mapNodes,
  parseDesignDoc,
  readFeatureIndex,
  sanitizeIndex,
  summarize,
  writeFeatureIndex,
} from './engine/features.js'
export { cleanPathInput, findDirectory, isDirectory, resolveProjectRoot } from './engine/paths.js'
