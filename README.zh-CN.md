<p align="center"><img src="assets/branding/logo.svg" width="96" height="96" alt="CodeFlow Kernel logo"></p>

<h1 align="center">CodeFlow Kernel</h1>

<p align="center"><b>面向任意仓库的确定性代码结构分析。<br/>任务流水线、模块结构图、耦合评分、功能索引——全部由代码树算出，不是由提示词生成。</b></p>

<p align="center">
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-3da639"></a>
  <a href="https://github.com/TheLiudawei/codeflow-kernel/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/TheLiudawei/codeflow-kernel/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="Version" src="https://img.shields.io/badge/version-0.1.0-4f46e5">
  <img alt="Node" src="https://img.shields.io/badge/node-%3E%3D18.17-2ea043">
  <img alt="Dependencies" src="https://img.shields.io/badge/npm%20dependencies-0-brightgreen">
  <img alt="MCP" src="https://img.shields.io/badge/MCP-stdio-4f46e5">
</p>

<p align="center">
  <a href="README.md">English</a> | 简体中文
</p>

---

CodeFlow Kernel 是 [CodeFlow Canvas](https://github.com/TheLiudawei/dsh-codeflow-canvas) 里的分析内核，被单独剥出来，好让任何东西都能调用它：命令行、CI、Claude Code、ZCode、Cursor，或者你自己的脚本。它把仓库变成四样机器能直接用的东西——不调用模型、不访问网络、没有依赖。

```
$ codeflow-kernel analyze .

任务 5 节点 · 模块 22 文件 · 耦合 44（medium） · 识别 8 个功能 / 19 模块
```

> 引擎取自 CodeFlow Canvas v1.4.2，外面重新包了独立的 CLI 与 MCP 接口。画布留在父仓库；这里没有宿主 SDK、没有 UI、没有状态。

## 要解决的问题

你问模型「这个仓库还剩哪些没做完」「这套代码缠得有多厉害」，得到的是散文。散文不是数字，所以它没法卡住一个 PR，没法和上周对比，也没法被信任两次——同一个问题明天再问，措辞（有时连结论）就变了。

仓库的结构不是意见问题。谁 import 谁、哪些注释带着 `TODO`、哪个模块被三十个文件依赖、登录流程底下藏着哪个环——这些都是机械可推导的。唯一的要求是：每次用同一种方式推。

## 内核改变了什么

| | 直接问模型 | CodeFlow Kernel |
| --- | --- | --- |
| 成本 | 每个问题、每个文件都烧 token | 零——一次文件系统扫描 |
| 可用性 | 需要 provider、key、网络 | 离线，CI 与内网机器上照跑 |
| 可复现 | 措辞会漂，结论也常漂 | 同一个提交 → 同一张图、同一组分数 |
| 可审计 | 「模型说的」 | 每个分数都有公式和逐文件度量 |
| 延迟 | 数秒到数分钟 | 几百个文件几十毫秒 |
| 反馈回路 | 没有 | 退出码、JSON、MCP 工具结果 |

## 四类分析，同一套扫描

### 1 · 任务流水线——还剩什么没做

注释按语言文法解析（`//`、`#`、`/* */`、docblock），`TODO` / `FIXME` / `XXX` / `HACK` 按权重排序后提升为任务节点，再按执行顺序串成链。

```
$ codeflow-kernel tasks . --top 4
8 个节点 · 主语言 JS · 9 文件 · 3 条标记
  scan  项目扫描 · done
  comments  注释解析 · done
  edit  任务：reject NaN inputs · pending
  edit  任务：add input validati · pending
  …共 8 个节点（--top 调大）
```

### 2 · 模块结构图——代码怎么组织

每个源码文件一个节点，带抽取出的顶层符号、解析后的本地 import，以及推断出的角色（入口 / 路由 / 数据模型 / UI / 工具 / 测试 / 脚本 / 样式）。关键文件会展开成逐符号子节点。import 指示符会对扫描树做解析，所以图上画的是真实边，不是名字巧合。

```
$ codeflow-kernel modules . --json | jq '.stats'
{ "files": 22, "modules": 22, "symbols": 11, "omitted": 0, "primary": "javascript" }
```

### 3 · 耦合报告——哪里缠死了

每个文件一个 0–100 分，来自文件内结构（符号引用、密度、扇出、内部环）与文件间位置（扇入、扇出、传递闭包、依赖深度、SCC 大小），再加上外部 import 压力。环用 Tarjan SCC 在解析后的 import 图上求。项目级结论按行数加权并加环惩罚，映射到固定的 30/60 阈值——每次运行都是同一套阈值。

```
$ codeflow-kernel coupling . --top 3
耦合 44/100 · medium · 模块 124 · 已分析 124
  65 high   tools/port-canvas.mjs  in 0 / out 5 / 2448 行
  63 high   lib/undo.js            in 3 / out 4 / 801 行
  62 high   lib/workspace-binding.js in 2 / out 4 / 556 行
外部依赖：node:path×68  node:fs/promises×52  node:url×30
```

### 4 · 功能索引——哪些文件实现了什么

功能 → 文件的确定性索引，信号来自 `docs/design.md`（有的话）、入口信号、顶层符号、领域词典与节点文字。每个功能都带证据列表与置信度；低置信的猜测会被标注出来，而不是当成事实陈述。

```
$ codeflow-kernel features .
识别 3 个功能 / 10 个模块（2 个低置信）
  测试      0.80  package.json
  导入      0.35  src/a.js, src/app.py, src/b.js, src/core.js …+2
  文件      0.35  src/app.py, src/core.js, src/index.js
```

功能名来自领域词典与 `docs/design.md` 的标题。仓库很小、两样都没有时，索引会比较粗——置信度那一列会如实说明，而不是把猜测包装成结论。

## 是量出来的，不是声称的

`npm run bench` 用一个纯函数生成固定 fixture（60 个模块，任何机器上内容一致），把真实分析跑三次，并且**两次结果不一致就失败**。本仓库最近一次运行的数字：

| 度量 | 数值 |
| --- | --- |
| fixture | 60 个源码文件，36 个图节点（节点上限） |
| 任务节点 | 10 |
| 耦合结论 | 19/100（low） |
| 功能数 | 3 |
| 耗时中位数 | 约 70ms |
| 确定性 | 两次运行逐字节一致 |

在真实仓库上——父项目，124 个源码模块——同一个二进制给出 `44/100（medium）`，最差的模块是 `tools/port-canvas.mjs`，`65（high）`。同一套公式、同一套阈值，没有任何配置。

## 0.1.0 包含什么

- 从 CodeFlow Canvas v1.4.2 剥出引擎：扫描、符号/注释文法、任务流水线、模块图、耦合、功能索引。
- 把四个宿主模块依赖收敛成一个文件（`engine/paths.js`）；移除压缩包、拖拽导入、卡片合并、HTTP 与 store 相关代码路径。
- 新增 `analysis.js`（四段分析合成一份报告）、零依赖 CLI（JSON 契约 + 退出码）、零依赖 MCP stdio server（五个工具）。
- 新增三套驱动真实子进程的测试、可复现的 60 文件基准，以及 Ubuntu / Windows / macOS 三平台 CI。
- `codeflow/1` 图格式、耦合权重与 30/60 阈值一律未改，这里产出的图仍可直接在画布打开。

## 开始使用

没有构建步骤，没有安装步骤，没有依赖。

```bash
git clone https://github.com/TheLiudawei/codeflow-kernel.git
cd codeflow-kernel

# 直接对任意目录跑
node bin/codeflow-kernel.js analyze /path/to/repo

# 或者全局装上两个命令
npm install -g .
codeflow-kernel coupling /path/to/repo
```

需要 Node 18.17+，别的什么都不用。

## 用法

```bash
codeflow-kernel analyze  [path]   # 四段全量报告（缺省 .）
codeflow-kernel tasks    [path]   # TODO/FIXME → 任务流水线
codeflow-kernel modules  [path]   # 文件 / 符号模块图
codeflow-kernel coupling [path]   # 0–100 分、环、外部依赖
codeflow-kernel features [path]   # 功能 → 文件索引
codeflow-kernel mcp               # 启动 MCP stdio server
```

常用选项：

| 选项 | 含义 |
| --- | --- |
| `--json` | 机读契约（见下） |
| `--out <文件>` | 把 JSON 报告写入文件 |
| `--max-files <n>` | 扫描预算，默认与硬上限都是 1000 |
| `--depth <n>` | 目录深度：任务 4，模块/耦合 6 |
| `--top <n>` | 人类可读输出行数（默认 10） |
| `--include <列表>` | `analyze` 的段落：`tasks,modules,coupling,features` |
| `--no-tasks`、`--no-tests` | 跳过标记任务 / 测试生成节点 |

退出码：`0` 成功，`1` 分析失败（路径不存在、树不可读），`2` 用法错误。所以它天生就是一个 CI 关卡：

```bash
codeflow-kernel coupling . --json \
  | node -e "const r=JSON.parse(require('fs').readFileSync(0)); process.exit(r.overall.score > 60 ? 1 : 0)"
```

## MCP server

`codeflow-kernel mcp` 在 stdio 上说 JSON-RPC 2.0，一行一条消息，暴露五个只读工具：

| 工具 | 回答什么 |
| --- | --- |
| `codeflow_analyze` | 一次给全，`include` 可裁剪段落 |
| `codeflow_tasks` | 「这个仓库还剩什么没做？」 |
| `codeflow_modules` | 「这份代码怎么组织的？」 |
| `codeflow_coupling` | 「哪些模块缠死了，环在哪？」 |
| `codeflow_features` | 「这个功能由哪些文件实现？」 |

Claude Code：

```bash
claude mcp add codeflow-kernel -- node /abs/path/to/codeflow-kernel/bin/codeflow-kernel-mcp.js
```

ZCode / Cursor（`mcp.json` / `mcp_servers.json`）：

```json
{
  "mcpServers": {
    "codeflow-kernel": {
      "command": "node",
      "args": ["/abs/path/to/codeflow-kernel/bin/codeflow-kernel-mcp.js"]
    }
  }
}
```

每个工具都返回 `structuredContent`（报告对象）与一段 JSON `text`。全部声明了 `readOnlyHint: true` 与 `openWorldHint: false`，客户端可以放心依赖。工具执行失败返回 `isError: true` 的结果，协议层错误才走标准错误码（`-32700`、`-32601`、`-32603`）。

## JSON 契约

`analyze --json` 返回一个对象，其他命令返回它的子集。

```jsonc
{
  "format": "codeflow-kernel/1",
  "root": "/abs/project",
  "name": "project",
  "language": "javascript",
  "summary": "任务 5 节点 · 模块 22 文件 · 耦合 44（medium） · 识别 8 个功能 / 19 模块",
  "tasks":   { "format": "codeflow/1", "nodes": [], "links": [], "meta": { "strategy": "tasks" } },
  "modules": { "format": "codeflow/1", "nodes": [], "links": [], "meta": { "strategy": "modules" } },
  "coupling": {
    "format": "codeflow-kernel/1",
    "overall": { "level": "medium", "score": 44, "modules": 22, "analyzed": 22, "cycles": 1, "partial": false, "worst": {} },
    "files": [{ "path": "lib/store.js", "score": 62, "level": "high", "intra": 41, "inter": 78, "metrics": {} }],
    "filesTotal": 22,
    "external": [{ "spec": "node:path", "count": 68 }],
    "counts": { "modules": 22, "analyzed": 22, "cycles": 1, "external": 12 }
  },
  "features": { "summary": "识别 8 个功能 / 19 模块", "count": 8, "features": [], "unmapped": [] },
  "stats": { "tasks": 5, "modules": 22, "couplingScore": 44, "features": 8, "durationMs": 58 }
}
```

`nodes`、`links`、`coupling`、`features` 是逐字节确定的。唯一会变的字段是时间戳（`meta.createdAt`、`meta.updatedAt`、`features.generatedAt`）——它们存在只是为了让消费者知道图是什么时候生成的。

## 实现结构

```
 仓库目录树
       │
       ├── scan/walk.js ──────── 文件发现、语言表、跳过规则
       ├── scan/symbols.js ───── 顶层符号 + import 指示符
       └── scan/comments.js ──── 注释文法 + 标记权重
       │
       ├── importer.js ─────────→ 任务流水线图   （codeflow/1）
       ├── analyst.js ──────────→ 模块结构图     （codeflow/1）
       ├── coupling.js ─────────→ 逐文件分数、SCC、环
       └── features/ ───────────→ 功能 → 文件索引
       │
   analysis.js ─────────────────→ 一份报告（codeflow-kernel/1）
       │
       ├── cli/main.js ─────────→ 人类可读 / --json / 退出码
       └── mcp/server.js ───────→ JSON-RPC stdio，五个工具
```

依赖方向只有一个：`scan` 不知道图的存在，各张图互相不知道，只有 `analysis.js` 知道「一份报告有四个段落」。`engine/` 是忠实移植；`analysis.js`、`cli/`、`mcp/` 是新写的。

## 目录结构

```
bin/
  codeflow-kernel.js         CLI 入口（shebang）
  codeflow-kernel-mcp.js     MCP stdio 入口
lib/
  index.js                   公共 API
  analysis.js                报告编排（新增）
  cli/main.js                命令、渲染、退出码（新增）
  mcp/server.js              JSON-RPC + 五个工具（新增）
  engine/
    core/                    fs、path、text 助手
    scan/                    walk、symbols、comments
    paths.js                 用户路径 → 文件系统路径（宿主适配）
    importer.js              任务流水线生成器
    analyst.js               模块图生成器
    coupling.js              耦合度量
    features.js + features/  功能索引
    duo.js                   一次扫描，两张图
tests/
  engine.mjs                 图、确定性、阈值
  cli.mjs                    真实子进程、退出码、JSON
  mcp.mjs                    stdio 握手、工具调用、错误边界
  bench.mjs                  固定 fixture、可复现数字
docs/
  architecture.md            分层规则与数据流
  mcp.md                     完整工具契约与客户端配置
```

## 开发

纯 Node——测试运行器是一个 Node 脚本，不是框架。

```bash
npm test          # 三个套件，真实子进程
npm run bench     # 固定 fixture，确定性破坏即失败
```

CI 在 Ubuntu、Windows、macOS 上跑同样的命令（Node 20），并在 Ubuntu 上补 Node 18 与 22。没有 lint 步骤、没有打包器，`package.json` 之外没有锁文件。

## 与 CodeFlow Canvas 的关系

本仓库是**衍生作品**，不是产品的 fork：

- **原样搬过来**——`lib/scan/*`、`lib/core/*`、`lib/coupling.js`、`lib/analyst.js`、`lib/importer.js`、`lib/features/*`、`lib/duo.js`。
- **重写**——宿主接线。引擎原本 import 四个宿主模块（`lib/workspace.js`、`lib/archive.js`、`lib/drop-import.js`、`lib/cards/merge.js`）。分析一个目录其实只需要其中两个函数（`cleanPathInput`、`resolveProjectRoot`），它们现在位于 `engine/paths.js`。压缩包 / 拖拽 / 卡片相关路径、HTTP 路由、画布 store 与 `persistDualResult` 全部移除。
- **新增**——`analysis.js`、CLI、MCP server、本仓库的测试与基准。
- **未改**——`codeflow/1` 图格式、符号/注释文法、耦合权重、30/60 等级阈值。这里产出的图可以直接在画布里打开。

画布在同一套引擎之上叠加了会话、持久化、撤销与节点编辑器。想要可视化工作流，用 [CodeFlow Canvas](https://github.com/TheLiudawei/dsh-codeflow-canvas)；想要数字，用这里。

## 已知限制

- **是启发式，不是编译器。** 符号与 import 用逐语言正则文法抽取。动态 import、re-export、TypeScript 路径别名不会被解析。
- **靠扩展名，不靠检测。** 语言由扩展名（加少量入口信号）决定。`.h` 既可能是 C 也可能是 C++。
- **扫描有预算。** 默认与上限都是 1000 个文件；模块图最多 36 个文件节点、总计 60 个节点。`stats.truncated` 与 `omitted` 会如实说明何时触顶。
- **耦合是味道探测器，不是判决。** 高分意味着「改这个文件很贵」，不意味着「这个文件是错的」。阈值是契约的一部分，不按项目调参。
- **功能识别需要词汇。** 词典是通用词典。命名风格特别的项目识别出的功能会少一些；低置信条目会被标注，不会被藏起来。
- **不写盘。** 不会向被分析的目录写入任何东西。`--out` 写到你指定的位置。

## 许可

MIT——见 [LICENSE](LICENSE)。引擎衍生自 CodeFlow Canvas（MIT，同一作者）。
