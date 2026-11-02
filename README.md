<p align="center"><img src="assets/branding/logo.svg" width="96" height="96" alt="CodeFlow Kernel logo"></p>

<h1 align="center">CodeFlow Kernel</h1>

<p align="center"><b>Deterministic code-structure analysis for any repository.<br/>A task pipeline, a module graph, a coupling score and a feature index — computed from the tree, not from a prompt.</b></p>

<p align="center">
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-3da639"></a>
  <a href="https://github.com/TheLiudawei/codeflow-kernel/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/TheLiudawei/codeflow-kernel/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="Version" src="https://img.shields.io/badge/version-0.1.0-4f46e5">
  <img alt="Node" src="https://img.shields.io/badge/node-%3E%3D18.17-2ea043">
  <img alt="Dependencies" src="https://img.shields.io/badge/npm%20dependencies-0-brightgreen">
  <img alt="MCP" src="https://img.shields.io/badge/MCP-stdio-4f46e5">
</p>

<p align="center">
  English | <a href="README.zh-CN.md">简体中文</a>
</p>

---

CodeFlow Kernel is the analysis engine inside [CodeFlow Canvas](https://github.com/TheLiudawei/dsh-codeflow-canvas), extracted so that anything can call it: a CLI, CI, Claude Code, ZCode, Cursor, or your own script. It turns a repository into four things a machine can act on — and it does so without a model call, without the network, and without dependencies.

```
$ codeflow-kernel analyze .

任务 5 节点 · 模块 22 文件 · 耦合 44（medium） · 识别 8 个功能 / 19 模块
```

> The engine was lifted from CodeFlow Canvas v1.4.2 and wired to a standalone CLI/MCP surface. The canvas stays in the parent repository; this one has no host SDK, no UI and no state.

## The problem

Ask a model "what is left to do in this repo?" or "how tangled is this codebase?" and you get prose. Prose is not a number, so it cannot gate a pull request, cannot be diffed against last week, and cannot be trusted twice — the same question asked tomorrow produces different words.

The structure of a repository is not a matter of opinion. Which files import which, which comments carry `TODO`, which module is depended on by thirty others, which cycle sits under the login flow — all of that is mechanically derivable. It only has to be derived the same way every time.

## What a kernel changes

| | Asking a model | CodeFlow Kernel |
| --- | --- | --- |
| Cost | Tokens per question, per file | Zero — a filesystem scan |
| Availability | Needs a provider, a key, a network | Offline, runs in CI and air-gapped machines |
| Reproducibility | Wording, and often conclusions, drift | Same commit → same graph, same scores |
| Auditability | "The model said so" | Every score has a formula and per-file metrics |
| Latency | Seconds to minutes | Tens of milliseconds for a few hundred files |
| Feedback loop | None | Exit codes, JSON, MCP tool results |

## Four analyses, one scan model

### 1 · Task pipeline — what is left to do

Comments are read with per-language grammars (`//`, `#`, `/* */`, docblocks), and `TODO` / `FIXME` / `XXX` / `HACK` markers are weighted and promoted to task nodes, chained in execution order.

```
$ codeflow-kernel tasks . --top 4
8 个节点 · 主语言 JS · 9 文件 · 3 条标记
  scan  项目扫描 · done
  comments  注释解析 · done
  edit  任务：reject NaN inputs · pending
  edit  任务：add input validati · pending
  …共 8 个节点（--top 调大）
```

### 2 · Module graph — how the code is organised

One node per source file, with extracted top-level symbols, resolved local imports and an inferred role (entry, route, model, UI, util, test, script, style). Key files expand into per-symbol nodes. Import specifiers are resolved against the scanned tree, so the graph reflects real edges rather than names.

```
$ codeflow-kernel modules . --json | jq '.stats'
{ "files": 22, "modules": 22, "symbols": 11, "omitted": 0, "primary": "javascript" }
```

### 3 · Coupling report — where the code is tangled

Every file gets a 0–100 score from intra-file structure (symbol references, density, fan-out, inner cycles) and inter-file position (fan-in, fan-out, transitive closure, dependency depth, SCC size), plus external import pressure. Cycles are found with Tarjan SCC over the resolved import graph. The project verdict is a line-weighted mean plus a cycle penalty, mapped through fixed 30/60 thresholds — the same thresholds in every run.

```
$ codeflow-kernel coupling . --top 3
耦合 44/100 · medium · 模块 124 · 已分析 124
  65 high   tools/port-canvas.mjs  in 0 / out 5 / 2448 行
  63 high   lib/undo.js            in 3 / out 4 / 801 行
  62 high   lib/workspace-binding.js in 2 / out 4 / 556 行
外部依赖：node:path×68  node:fs/promises×52  node:url×30
```

### 4 · Feature index — which files implement what

A deterministic index of feature → files, built from `docs/design.md` (if present), entry-point signals, top-level symbols, a domain dictionary and node labels. Every feature carries its evidence and a confidence; low-confidence guesses are labelled as such instead of being asserted.

```
$ codeflow-kernel features .
识别 3 个功能 / 10 个模块（2 个低置信）
  测试      0.80  package.json
  导入      0.35  src/a.js, src/app.py, src/b.js, src/core.js …+2
  文件      0.35  src/app.py, src/core.js, src/index.js
```

Feature names come from the domain dictionary plus `docs/design.md` headings. On a small repository without either, the index is coarse — and the confidence column says so instead of presenting a guess as a fact.

## Measured, not claimed

`npm run bench` generates a fixed 60-module fixture with a pure function (same files, same bytes on any machine), runs the real analysis three times, and **fails** if two runs disagree. Numbers from this repository's last run:

| Measurement | Value |
| --- | --- |
| Fixture | 60 source files, 36 graph nodes (node cap) |
| Task nodes | 10 |
| Coupling verdict | 19/100 (low) |
| Feature count | 3 |
| Median wall time | ~70 ms |
| Determinism | two runs byte-identical |

On a real repository — the parent project, 124 source modules — the same binary reports `44/100 (medium)`, and the worst module is `tools/port-canvas.mjs` at `65 (high)`. Same formula, same thresholds, no configuration.

## What's in 0.1.0

- Extracted the engine from CodeFlow Canvas v1.4.2: scanning, symbol/comment grammars, task pipeline, module graph, coupling and feature index.
- Replaced four host-module imports with one file (`engine/paths.js`); dropped the archive, drag-and-drop, card-merge, HTTP and store code paths.
- Added `analysis.js` (one report from four analyses), a zero-dependency CLI with JSON contracts and exit codes, and a zero-dependency MCP stdio server with five tools.
- Added three test suites that drive real subprocesses, a deterministic 60-file benchmark, and CI on Ubuntu, Windows and macOS.
- `codeflow/1`, the coupling weights and the 30/60 thresholds are unchanged, so graphs produced here still load in the canvas.

## Get started

No build step, no install step, no dependency.

```bash
git clone https://github.com/TheLiudawei/codeflow-kernel.git
cd codeflow-kernel

# run it against any directory
node bin/codeflow-kernel.js analyze /path/to/repo

# or install the two commands globally
npm install -g .
codeflow-kernel coupling /path/to/repo
```

Node 18.17+ is required. Nothing else is.

## Usage

```bash
codeflow-kernel analyze  [path]   # all four sections (default: .)
codeflow-kernel tasks    [path]   # TODO/FIXME → task pipeline
codeflow-kernel modules  [path]   # file/symbol module graph
codeflow-kernel coupling [path]   # 0–100 scores, cycles, external deps
codeflow-kernel features [path]   # feature → files index
codeflow-kernel mcp               # run the MCP stdio server
```

Useful flags:

| Flag | Meaning |
| --- | --- |
| `--json` | Machine-readable contract (see below) |
| `--out <file>` | Write the JSON report to a file |
| `--max-files <n>` | Scan budget, default and hard cap 1000 |
| `--depth <n>` | Directory depth: 4 for tasks, 6 for modules/coupling |
| `--top <n>` | Rows in human output (default 10) |
| `--include <list>` | `analyze` sections: `tasks,modules,coupling,features` |
| `--no-tasks`, `--no-tests` | Skip marker tasks / test generation node |

Exit codes: `0` success, `1` analysis failed (bad path, unreadable tree), `2` usage error. That makes it a CI gate in one line:

> Human-readable strings are Chinese, inherited from the parent project. Every structured field — `level`, `score`, `path`, `type`, `status` — is language-neutral, so JSON consumers and CI never depend on display text. `--json` is the supported interface; the table output is for humans.

```bash
codeflow-kernel coupling . --json \
  | node -e "const r=JSON.parse(require('fs').readFileSync(0)); process.exit(r.overall.score > 60 ? 1 : 0)"
```

## MCP server

`codeflow-kernel mcp` speaks JSON-RPC 2.0 over stdio, one message per line, and exposes five read-only tools:

| Tool | Answers |
| --- | --- |
| `codeflow_analyze` | Everything at once, with `include` to trim sections |
| `codeflow_tasks` | "What is left to do in this repository?" |
| `codeflow_modules` | "How is this code organised?" |
| `codeflow_coupling` | "Which modules are tangled, and where are the cycles?" |
| `codeflow_features` | "Which files implement this feature?" |

Claude Code:

```bash
claude mcp add codeflow-kernel -- node /abs/path/to/codeflow-kernel/bin/codeflow-kernel-mcp.js
```

ZCode / Cursor (`mcp.json` / `mcp_servers.json`):

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

Every tool returns `structuredContent` (the report object) plus a JSON `text` block. All tools declare `readOnlyHint: true` and `openWorldHint: false`; callers can rely on that. Tool failures come back as `isError: true` results, while protocol errors use standard codes (`-32700`, `-32601`, `-32603`).

## The JSON contract

`analyze --json` returns one object; every other command returns a subset of it.

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

Determinism is byte-level for `nodes`, `links`, `coupling` and `features`. The only volatile fields are timestamps (`meta.createdAt`, `meta.updatedAt`, `features.generatedAt`), which exist so a consumer can tell when a graph was produced.

## How it works

```
 repository tree
       │
       ├── scan/walk.js ──────── file discovery, language table, skip rules
       ├── scan/symbols.js ───── top-level symbols + import specifiers
       └── scan/comments.js ──── comment grammars + marker weights
       │
       ├── importer.js ─────────→ task pipeline graph   (codeflow/1)
       ├── analyst.js ──────────→ module graph          (codeflow/1)
       ├── coupling.js ─────────→ per-file score, SCCs, cycles
       └── features/ ───────────→ feature → files index
       │
   analysis.js ─────────────────→ one report (codeflow-kernel/1)
       │
       ├── cli/main.js ─────────→ human output / --json / exit codes
       └── mcp/server.js ───────→ JSON-RPC stdio, five tools
```

The layers only point one way: `scan` knows nothing about graphs, graphs know nothing about each other, and `analysis.js` is the only place that knows a report has four sections. `engine/` is a faithful port; `analysis.js`, `cli/` and `mcp/` are new.

## Project layout

```
bin/
  codeflow-kernel.js         CLI entry (shebang)
  codeflow-kernel-mcp.js     MCP stdio entry
lib/
  index.js                   public API
  analysis.js                report orchestration (new)
  cli/main.js                commands, rendering, exit codes (new)
  mcp/server.js              JSON-RPC + five tools (new)
  engine/
    core/                    fs, path, text helpers
    scan/                    walk, symbols, comments
    paths.js                 user-path → filesystem path (host shim)
    importer.js              task pipeline generator
    analyst.js               module graph generator
    coupling.js              coupling metrics
    features.js + features/  feature index
    duo.js                   one scan, two graphs
tests/
  engine.mjs                 graphs, determinism, thresholds
  cli.mjs                    real subprocesses, exit codes, JSON
  mcp.mjs                    stdio handshake, tool calls, error boundary
  bench.mjs                  fixed fixture, reproducible numbers
docs/
  architecture.md            layer rules and data flow
  mcp.md                     full tool contracts and client setup
```

## Development

Plain Node — the test runner is a Node script, not a framework.

```bash
npm test          # three suites, real subprocesses
npm run bench     # fixed fixture, fails if determinism breaks
```

CI runs the same commands on Ubuntu, Windows and macOS with Node 20, plus Node 18 and 22 on Ubuntu. There is no lint step, no bundler and no lockfile beyond `package.json`.

## Relationship to CodeFlow Canvas

This repository is a **derivative work**, not a fork of the product:

- **Lifted verbatim** — `lib/scan/*`, `lib/core/*`, `lib/coupling.js`, `lib/analyst.js`, `lib/importer.js`, `lib/features/*`, `lib/duo.js`.
- **Rewritten** — host wiring. The engine imported four host modules (`lib/workspace.js`, `lib/archive.js`, `lib/drop-import.js`, `lib/cards/merge.js`). Only two functions from those are needed to analyse a directory (`cleanPathInput`, `resolveProjectRoot`); they now live in `engine/paths.js`. The archive/drop/card code paths, the HTTP routes, the canvas store and `persistDualResult` were dropped entirely.
- **Added** — `analysis.js`, the CLI, the MCP server, this test suite and the bench.
- **Unchanged** — the `codeflow/1` graph format, symbol/comment grammars, coupling weights and the 30/60 level thresholds. Graphs produced here load in the canvas.

The canvas ships the same engine with sessions, persistence, undo and the node editor on top. If you want the visual workflow, use [CodeFlow Canvas](https://github.com/TheLiudawei/dsh-codeflow-canvas); if you want the numbers, use this.

## Known limitations

- **Heuristic, not a compiler.** Symbols and imports are extracted with per-language regex grammars. Dynamic imports, re-exports and TypeScript path aliases are not resolved.
- **Language table, not a detector.** Languages are decided by extension (plus a small set of entry-point signals). A `.h` file may be C or C++.
- **Bounded scan.** Default and maximum budget is 1000 files; the module graph shows at most 36 file nodes and 60 nodes total. `stats.truncated` and `omitted` say when that happened.
- **Coupling is a smell detector, not a verdict.** A high score means "this file is expensive to change", not "this file is wrong". Thresholds are fixed by contract rather than tuned per project.
- **Features need vocabulary.** The dictionary is general-purpose. A domain with unusual naming will produce fewer features; low-confidence entries are labelled, never hidden.
- **No writes.** Nothing is written into the analysed tree. `--out` writes wherever you point it.

## License

MIT — see [LICENSE](LICENSE). The engine is derived from CodeFlow Canvas (MIT, same author).
