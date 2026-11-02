/**
 * MCP 协议测试：真实 stdio 子进程，按 JSON-RPC 报文收发。
 *
 * 覆盖会话协商、工具发现、真实分析调用、以及"调用错误要落在结果里、
 * 协议错误才走 -326xx"这条边界。
 *
 * @module codeflow-kernel/tests/mcp
 */
import { fileURLToPath } from 'node:url'

import { check, makeFixture, mcpSession } from './helpers.mjs'

const BIN = fileURLToPath(new URL('../bin/codeflow-kernel-mcp.js', import.meta.url))

export async function run() {
  const { root, cleanup } = await makeFixture()
  const session = await mcpSession(BIN, { cwd: root })
  try {
    // ---- initialize ---------------------------------------------------------
    const init = await session.request(1, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'codeflow-kernel-tests', version: '0.0.0' },
    })
    check(init.jsonrpc === '2.0' && init.id === 1, 'initialize 响应头不对')
    check(init.result.protocolVersion === '2025-06-18', `协议版本未回显: ${init.result.protocolVersion}`)
    check(init.result.capabilities?.tools !== undefined, '没有声明 tools 能力')
    check(init.result.serverInfo?.name === 'codeflow-kernel', 'serverInfo.name 不对')
    check(typeof init.result.instructions === 'string' && init.result.instructions.length > 0, '缺少 instructions')

    session.notify('notifications/initialized')

    // ---- ping ---------------------------------------------------------------
    const ping = await session.request(2, 'ping')
    check(ping.result !== undefined && ping.error === undefined, 'ping 应返回空结果')

    // ---- tools/list ---------------------------------------------------------
    const listed = await session.request(3, 'tools/list')
    const tools = listed.result.tools
    const names = tools.map((tool) => tool.name)
    check(tools.length === 5, `工具数 ${tools.length}，期望 5`)
    for (const expected of ['codeflow_analyze', 'codeflow_tasks', 'codeflow_modules', 'codeflow_coupling', 'codeflow_features']) {
      check(names.includes(expected), `缺少工具 ${expected}`)
    }
    for (const tool of tools) {
      check(tool.inputSchema?.type === 'object', `${tool.name} 的 inputSchema 不是 object`)
      check(typeof tool.description === 'string' && tool.description.length > 20, `${tool.name} 缺少可用描述`)
      check(tool.annotations?.readOnlyHint === true, `${tool.name} 未声明 readOnlyHint`)
    }

    // ---- tools/call: 真实分析 ------------------------------------------------
    const coupling = await session.request(4, 'tools/call', {
      name: 'codeflow_coupling',
      arguments: { path: '.', top: 3 },
    })
    check(coupling.error === undefined, `tools/call 返回协议错误: ${JSON.stringify(coupling.error)}`)
    check(coupling.result.isError !== true, 'codeflow_coupling 执行失败')
    check(typeof coupling.result.content?.[0]?.text === 'string', '缺少 text content')
    const scoring = coupling.result.structuredContent
    check(scoring.format === 'codeflow-kernel/1', 'structuredContent 不是报告')
    check(scoring.overall?.cycles >= 2, 'MCP 耦合结果没检出环')
    check(scoring.files.length === 3, `top 参数没有截断文件行: ${scoring.files.length}`)
    check(scoring.filesTotal >= scoring.files.length, 'filesTotal 不一致')

    const analyzed = await session.request(5, 'tools/call', {
      name: 'codeflow_analyze',
      arguments: { path: '.', include: 'tasks,modules', maxFiles: 100 },
    })
    check(analyzed.result.isError !== true, 'codeflow_analyze 执行失败')
    check(analyzed.result.structuredContent.tasks !== null, 'analyze 缺少任务图')
    check(analyzed.result.structuredContent.coupling === null, 'include 没有裁掉耦合段')

    // ---- 边界：工具不存在 / 方法不存在 / 参数错误 -----------------------------
    const unknownTool = await session.request(6, 'tools/call', { name: 'nope', arguments: {} })
    check(unknownTool.result?.isError === true, '未知工具应返回 isError 结果')

    const unknownMethod = await session.request(7, 'nothing/here')
    check(unknownMethod.error?.code === -32601, `未知方法应返回 -32601，实际 ${JSON.stringify(unknownMethod.error)}`)

    const badPath = await session.request(8, 'tools/call', {
      name: 'codeflow_tasks',
      arguments: { path: 'definitely-not-here' },
    })
    check(badPath.result?.isError === true, '不存在的路径应返回 isError 结果')
    check(/目录不存在/.test(badPath.result.content[0].text), '错误文本不够具体')

    // 通知不产生响应：紧接着的 ping 应当是下一条报文。
    session.notify('notifications/cancelled')
    const afterNotify = await session.request(9, 'ping')
    check(afterNotify.id === 9, `通知产生了多余响应: ${JSON.stringify(afterNotify)}`)
  } finally {
    await session.close()
    await cleanup()
  }
}
