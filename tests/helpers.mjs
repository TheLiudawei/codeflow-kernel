/**
 * 测试公用件：确定性 fixture、子进程 runner、MCP 会话客户端。
 *
 * fixture 由纯函数生成（固定文件名/固定内容），任何机器上生成的都是同一棵
 * 树——确定性断言因此不会因机器而漂移。
 *
 * @module codeflow-kernel/tests/helpers
 */
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

/** 子进程用它自己的运行时（真实 Node 或 Electron-as-Node 都能跑）。 */
const NODE_ENV = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }

const FIXTURE_FILES = {
  'package.json': JSON.stringify({
    name: 'demo-app',
    version: '1.0.0',
    main: 'src/index.js',
    scripts: { test: 'node test.js' },
  }, null, 2),
  'README.md': '# Demo App\n\nA deterministic fixture for codeflow-kernel tests.\n',
  'src/index.js': [
    "import { readFile } from 'node:fs/promises'",
    "import { add } from './core.js'",
    "import { helper } from './util.js'",
    '',
    'export function main() {',
    '  return add(helper(), 2)',
    '}',
    '',
    '// TODO: wire the CLI flag parsing',
  ].join('\n'),
  'src/core.js': [
    'export function add(a, b) {',
    '  return a + b',
    '}',
    '',
    'export class Counter {',
    '  constructor() { this.value = 0 }',
    '  tick() { this.value += 1; return this.value }',
    '}',
    '',
    '// FIXME: reject NaN inputs',
  ].join('\n'),
  'src/util.js': [
    'export function helper() {',
    '  return 1',
    '}',
  ].join('\n'),
  'src/a.js': [
    "import { b } from './b.js'",
    '',
    'export function a() {',
    '  return b()',
    '}',
  ].join('\n'),
  'src/b.js': [
    "import { a } from './a.js'",
    '',
    'export function b() {',
    "  return 'b'",
    '}',
  ].join('\n'),
  'src/app.py': [
    'from core import add',
    '',
    'def run():',
    '    return add(1, 2)',
    '',
    '# TODO: add input validation',
  ].join('\n'),
  'docs/design.md': [
    '# Design',
    '',
    '## Authentication',
    '',
    '- src/core.js',
    '',
    '## Data layer',
    '',
    '- src/a.js',
  ].join('\n'),
}

/**
 * 创建一个临时 fixture 仓库。
 * @returns `{ root, cleanup }`。
 */
export async function makeFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'codeflow-kernel-'))
  for (const [rel, content] of Object.entries(FIXTURE_FILES)) {
    const file = path.join(root, ...rel.split('/'))
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, content, 'utf8')
  }
  return {
    root,
    cleanup: () => rm(root, { recursive: true, force: true }),
  }
}

/** fixture 里的源码文件数（模块图节点的下限依据）。 */
export const FIXTURE_SOURCE_FILES = 6

/** 去掉只随时间变化的字段：确定性比较只比结构。 */
export function stripVolatile(graph) {
  return {
    format: graph.format,
    project: graph.project,
    nodes: graph.nodes,
    links: graph.links,
    meta: { importedFrom: graph.meta?.importedFrom, strategy: graph.meta?.strategy },
  }
}

/**
 * 跑一个 Node 脚本/CLI，收集输出。
 * @returns `{ code, stdout, stderr }`。
 */
export function runNode(args, { cwd, timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, env: NODE_ENV, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`timeout after ${timeoutMs}ms: ${args.join(' ')}`))
    }, timeoutMs)
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
  })
}

/**
 * 起一个 MCP server 子进程，按消息序号收发。
 * 返回 `{ request, notify, close }`。
 */
export async function mcpSession(binPath, { cwd } = {}) {
  const child = spawn(process.execPath, [binPath], { cwd, env: NODE_ENV, stdio: ['pipe', 'pipe', 'pipe'] })
  const queue = []
  const waiters = []
  let buffer = ''
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += chunk })
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (line.length === 0) continue
      const parsed = JSON.parse(line)
      const waiter = waiters.shift()
      if (waiter !== undefined) waiter.resolve(parsed)
      else queue.push(parsed)
    }
  })
  const next = (timeoutMs = 60_000) => new Promise((resolve, reject) => {
    if (queue.length > 0) { resolve(queue.shift()); return }
    const timer = setTimeout(() => {
      reject(new Error(`mcp timeout${stderr.length > 0 ? `; stderr: ${stderr.slice(0, 400)}` : ''}`))
    }, timeoutMs)
    waiters.push({
      resolve: (value) => { clearTimeout(timer); resolve(value) },
    })
  })
  const write = (payload) => child.stdin.write(`${JSON.stringify(payload)}\n`)
  return {
    stderrText: () => stderr,
    request: async (id, method, params) => {
      write({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) })
      return next()
    },
    notify: (method, params) => write({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) }),
    close: async () => {
      child.stdin.end()
      await new Promise((resolve) => child.on('close', resolve))
    },
  }
}

/** 断言助手：失败时把上下文一起打出来。 */
export function check(condition, message) {
  if (!condition) throw new Error(message)
}
