#!/usr/bin/env node
/**
 * MCP 入口：在 stdio 上说 JSON-RPC，给 Claude Code / ZCode / Cursor / CI 调用。
 *
 * 注册示例（Claude Code）：
 *   claude mcp add codeflow-kernel -- node /abs/path/bin/codeflow-kernel-mcp.js
 *
 * 也可以用 `codeflow-kernel mcp`——两条路径字节级等价。
 */
import { serveStdio } from '../lib/mcp/server.js'

serveStdio().catch((error) => {
  process.stderr.write(`codeflow-kernel mcp: ${error?.stack ?? error}\n`)
  process.exit(1)
})
