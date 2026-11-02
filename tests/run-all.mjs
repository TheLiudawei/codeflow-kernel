/**
 * 测试入口：逐个跑套件，汇总退出码。
 *
 * 每个套件导出 `run()`；抛错即失败。套件之间不共享 fixture——`cli`/`mcp`
 * 都自己起子进程，所以一次失败不会污染下一个。
 *
 * @module codeflow-kernel/tests/run-all
 */
const SUITES = [
  ['engine（扫描 / 图 / 耦合 / 功能）', './engine.mjs'],
  ['cli（子进程 + 退出码 + JSON 契约）', './cli.mjs'],
  ['mcp（stdio 协议 + 工具调用）', './mcp.mjs'],
]

let failed = 0
for (const [title, file] of SUITES) {
  const startedAt = Date.now()
  try {
    const module = await import(new URL(file, import.meta.url).href)
    await module.run()
    process.stdout.write(`✓ ${title}  ${Date.now() - startedAt}ms\n`)
  } catch (error) {
    failed += 1
    process.stdout.write(`✗ ${title}  ${Date.now() - startedAt}ms\n`)
    process.stdout.write(`  ${String(error?.stack ?? error).split('\n').join('\n  ')}\n`)
  }
}

process.stdout.write(failed === 0
  ? `\n全部通过（${SUITES.length} 套件）\n`
  : `\n${failed} 个套件失败\n`)
process.exitCode = failed === 0 ? 0 : 1
