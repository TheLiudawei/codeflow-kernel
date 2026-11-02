/**
 * MCP stdio server——零依赖的 JSON-RPC 2.0 实现。
 *
 * 为什么手写而不是引官方 SDK：内核的卖点是零依赖、不联网、可审计。一个只为
 * 五个只读工具服务的 server 不值得拉进一棵依赖树，也不值得让它在启动时
 * 做任何网络行为。协议面很小：`initialize`、`tools/list`、`tools/call`、
 * `ping`，其余方法如实回 `-32601`。
 *
 * 传输：stdio，一行一条 JSON（换行分隔）；stdout 只允许 JSON-RPC 报文，
 * 一切诊断走 stderr。
 *
 * @module codeflow-kernel/mcp
 */
import { createInterface } from 'node:readline'

import { analyzeRepository, couplingReport, featureIndex, modulesGraph, tasksGraph } from '../analysis.js'

/** 会话协商的协议版本（按新→旧排列）；客户端请求哪个就回哪个。 */
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']
const LATEST_PROTOCOL = PROTOCOL_VERSIONS[0]

/** 工具共用参数：项目目录 + 扫描预算。 */
const PATH_SCHEMA = {
  type: 'object',
  properties: {
    path: {
      type: 'string',
      description: 'Repository directory to analyze. Absolute, or relative to the server process working directory. Defaults to ".".',
    },
    maxFiles: {
      type: 'integer',
      minimum: 1,
      maximum: 1000,
      description: 'Scan budget in files (default 1000, the engine hard cap).',
    },
    maxDepth: {
      type: 'integer',
      minimum: 1,
      maximum: 10,
      description: 'Directory depth limit (default 4 for tasks, 6 for modules and coupling).',
    },
  },
  required: [],
}

/** 五个工具的定义：名称、说明、入参 schema。 */
const TOOLS = [
  {
    name: 'codeflow_analyze',
    title: 'Analyze repository (all sections)',
    description:
      'Deterministic repository health check: task pipeline from TODO/FIXME markers, module graph, per-file coupling score (0-100, higher = more tangled) and feature index. No model call, no network, no writes. Returns the same numbers on every run for the same commit.',
    inputSchema: {
      type: 'object',
      properties: {
        ...PATH_SCHEMA.properties,
        include: {
          type: 'string',
          description: 'Comma-separated sections to compute: tasks,modules,coupling,features. Default all.',
        },
      },
      required: [],
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (args) => analyzeRepository({
      path: args.path ?? '.',
      include: args.include,
      maxFiles: args.maxFiles,
      maxDepth: args.maxDepth,
    }),
  },
  {
    name: 'codeflow_tasks',
    title: 'Task pipeline',
    description:
      'Turn a repository into a codeflow/1 task pipeline: a deterministic scan plus the TODO/FIXME/XXX markers found in comments, each promoted to a concrete pending task node. Use it to answer "what is left to do in this repo?".',
    inputSchema: PATH_SCHEMA,
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (args) => tasksGraph(args.path ?? '.', {
      maxFiles: args.maxFiles,
      maxDepth: args.maxDepth,
    }),
  },
  {
    name: 'codeflow_modules',
    title: 'Module structure graph',
    description:
      'Turn a repository into a codeflow/1 module graph: one node per source file with extracted symbols, resolved local imports and an inferred role (entry, route, model, UI, util, test, ...). Deterministic; no LLM involved.',
    inputSchema: PATH_SCHEMA,
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (args) => modulesGraph(args.path ?? '.', {
      maxFiles: args.maxFiles,
      maxDepth: args.maxDepth,
    }),
  },
  {
    name: 'codeflow_coupling',
    title: 'Coupling report',
    description:
      'Score a repository for tangled dependencies: an overall 0-100 score with a low/medium/high level, per-file scores (fan-in, fan-out, transitive closure, cycle membership, density), and the most frequent external import specifiers. Use it before a refactor to find the worst modules, or in CI to gate on a threshold.',
    inputSchema: {
      type: 'object',
      properties: {
        ...PATH_SCHEMA.properties,
        top: { type: 'integer', minimum: 1, maximum: 200, description: 'How many file rows and external deps to return (default 50).' },
      },
      required: [],
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (args) => couplingReport(args.path ?? '.', {
      maxFiles: args.maxFiles,
      maxDepth: args.maxDepth,
      top: args.top ?? 50,
      limit: args.top ?? 50,
    }),
  },
  {
    name: 'codeflow_features',
    title: 'Feature index',
    description:
      'Map a repository to product features: which files belong to which feature, inferred from docs/design.md, entry-point signals, top-level symbols and a domain dictionary. Every feature carries an evidence list and a confidence; low-confidence guesses are labelled, never silently asserted.',
    inputSchema: PATH_SCHEMA,
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (args) => featureIndex(args.path ?? '.', {
      maxFiles: args.maxFiles,
      maxDepth: args.maxDepth,
    }),
  },
]

/** 工具名 → 定义。 */
const TOOL_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]))

/** 读版本号（与 CLI 共用同一份 package.json 事实来源）。 */
async function packageVersion() {
  const { readFile } = await import('node:fs/promises')
  const { fileURLToPath } = await import('node:url')
  try {
    const file = fileURLToPath(new URL('../../package.json', import.meta.url))
    return JSON.parse(await readFile(file, 'utf8')).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/** JSON-RPC 错误对象。 */
function rpcError(message, code = -32603, data) {
  return { jsonrpc: '2.0', error: { code, message, ...(data !== undefined ? { data } : {}) }, id: null }
}

/** `tools/list` 的载荷：去掉内部 `run` 与 annotations 之外的实现细节。 */
function toolList() {
  return TOOLS.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: tool.annotations,
  }))
}

/**
 * 执行一个工具。
 * @returns MCP `CallToolResult`：`{ content, structuredContent, isError? }`。
 */
async function callTool(params = {}, version) {
  const name = params.name
  const tool = TOOL_BY_NAME.get(name)
  if (tool === undefined) {
    return {
      content: [{ type: 'text', text: `Unknown tool: ${String(name)}. Available: ${TOOLS.map((entry) => entry.name).join(', ')}` }],
      isError: true,
    }
  }
  const args = params.arguments !== null && typeof params.arguments === 'object' ? params.arguments : {}
  try {
    const result = await tool.run(args)
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      structuredContent: result,
    }
  } catch (error) {
    return {
      content: [{ type: 'text', text: `${tool.name} failed: ${error?.message ?? error}` }],
      isError: true,
    }
  }
}

/**
 * 处理一条 JSON-RPC 消息。
 * @returns 响应对象，或 `null`（通知 / 无需响应）。
 */
async function handleMessage(message, state) {
  const isNotification = message?.id === undefined || message?.id === null
  const id = message?.id
  const method = message?.method

  if (typeof method !== 'string') {
    return isNotification ? null : { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid Request: missing method' } }
  }

  // 通知一律无响应；`initialized` 是唯一的会话级通知，记下即可。
  if (isNotification) {
    if (method === 'notifications/initialized') state.initialized = true
    return null
  }

  switch (method) {
    case 'initialize': {
      const requested = message?.params?.protocolVersion
      const protocolVersion = PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL
      state.initialized = true
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'codeflow-kernel', version: state.version },
          instructions:
            'Deterministic, read-only code-structure analysis. Use codeflow_coupling to find the most tangled modules, '
            + 'codeflow_tasks to list leftover TODO/FIXME work, codeflow_modules to understand file structure, and '
            + 'codeflow_features to map files to product features. All tools are local, offline and free of model calls.',
        },
      }
    }
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} }
    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: toolList() } }
    case 'tools/call':
      return { jsonrpc: '2.0', id, result: await callTool(message.params, state.version) }
    case 'logging/setLevel':
      return { jsonrpc: '2.0', id, result: {} }
    default:
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } }
  }
}

/**
 * 在 stdio 上跑 server。stdin 结束时 resolve；收到 SIGINT/SIGTERM 时安静退出。
 *
 * @param options.input - 默认 `process.stdin`（测试可注入）。
 * @param options.output - 默认 `process.stdout`。
 * @param options.error - 默认 `process.stderr`（诊断专用）。
 */
export async function serveStdio({ input = process.stdin, output = process.stdout, error = process.stderr } = {}) {
  const state = { initialized: false, version: await packageVersion() }
  const send = (payload) => output.write(`${JSON.stringify(payload)}\n`)

  // 顺序处理：MCP 客户端期望响应与请求同序；并发分析会互相抢 CPU 也不划算。
  let chain = Promise.resolve()
  const handleLine = async (line) => {
    const text = line.trim()
    if (text.length === 0) return
    let message
    try {
      message = JSON.parse(text)
    } catch (parseError) {
      send(rpcError(`Parse error: ${String(parseError?.message ?? parseError)}`, -32700))
      return
    }
    try {
      if (Array.isArray(message)) {
        const responses = []
        for (const entry of message) {
          const response = await handleMessage(entry, state)
          if (response !== null) responses.push(response)
        }
        if (responses.length > 0) send(responses)
        return
      }
      const response = await handleMessage(message, state)
      if (response !== null) send(response)
    } catch (handlerError) {
      error.write(`codeflow-kernel mcp: ${String(handlerError?.stack ?? handlerError)}\n`)
      const id = Array.isArray(message) ? null : message?.id ?? null
      if (id !== null) send({ jsonrpc: '2.0', id, error: { code: -32603, message: 'Internal error' } })
    }
  }

  const rl = createInterface({ input, crlfDelay: Infinity })
  for await (const line of rl) {
    chain = chain.then(() => handleLine(line))
  }
  await chain
  return state
}

/**
 * 以子进程方式写一条消息并读取一条响应（测试与调试用）。
 * 生产路径永远是 {@link serveStdio}；这个 helper 让协议测试不需要 spawn。
 */
export const __internals = { TOOLS, handleMessage, toolList, PROTOCOL_VERSIONS }
