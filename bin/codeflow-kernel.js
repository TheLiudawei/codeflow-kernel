#!/usr/bin/env node
/**
 * CLI 入口：`codeflow-kernel <命令>`。
 * 逻辑在 lib/cli/main.js——这里只负责把退出码交给 shell。
 */
import { main } from '../lib/cli/main.js'

try {
  process.exitCode = await main()
} catch (error) {
  process.stderr.write(`codeflow-kernel: ${error?.stack ?? error}\n`)
  process.exitCode = 1
}
