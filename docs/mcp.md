# MCP server

`codeflow-kernel mcp` (or `bin/codeflow-kernel-mcp.js`) exposes the analysis engine over the Model Context Protocol, stdio transport, JSON-RPC 2.0, one message per line.

- Protocol versions: `2025-06-18`, `2025-03-26`, `2024-11-05` (echoed back when requested).
- Capabilities: `tools` only. No resources, no prompts, no sampling.
- stdout carries JSON-RPC messages exclusively; diagnostics go to stderr.
- Every tool is read-only and offline. Nothing is written to the analysed tree.

## Session

```jsonc
→ {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"claude-code","version":"x"}}}
← {"jsonrpc":"2.0","id":1,"result":{
     "protocolVersion":"2025-06-18",
     "capabilities":{"tools":{"listChanged":false}},
     "serverInfo":{"name":"codeflow-kernel","version":"0.1.0"},
     "instructions":"Deterministic, read-only code-structure analysis. …"
   }}

→ {"jsonrpc":"2.0","method":"notifications/initialized"}
```

`ping` returns `{}`. Unknown methods return `-32601`; malformed JSON returns `-32700` with `id: null`.

## Tools

All tools accept `path` (default `"."`), `maxFiles` (1–1000, default 1000) and `maxDepth` (1–10; 4 for tasks, 6 for modules/coupling).

### `codeflow_analyze`

Full report. Optional `include` (`"tasks,modules,coupling,features"`) trims sections; excluded sections come back as `null`.

```jsonc
{"name":"codeflow_analyze","arguments":{"path":"/repo","include":"coupling,features"}}
```

Returns `{ format, root, name, language, summary, tasks, modules, coupling, features, stats }` — the same object as `codeflow-kernel analyze --json`.

### `codeflow_tasks`

Returns `{ graph, summary, stats }` where `graph` is a `codeflow/1` task pipeline: `scan` and `comments` nodes already `done`, marker-derived `edit` nodes `pending`, then `testgen` / `review` / `deliver`.

### `codeflow_modules`

Returns `{ graph, summary, stats }` where `graph` is a `codeflow/1` module graph. File-level module nodes have `params.symbol === ''`; symbol children carry the symbol name. Use that to distinguish 36 file nodes from their expansions.

### `codeflow_coupling`

Returns a coupling report:

```jsonc
{
  "format": "codeflow-kernel/1",
  "root": "/repo",
  "overall": { "level": "medium", "score": 44, "modules": 22, "analyzed": 22, "cycles": 1, "partial": false,
               "worst": { "id": "lib/store.js", "title": "lib/store.js", "score": 62 } },
  "files": [{ "path": "lib/store.js", "score": 62, "level": "high", "intra": 41, "inter": 78,
              "metrics": { "fanIn": 12, "fanOut": 4, "closure": 17, "depth": 5, "sccSize": 1,
                           "symbols": 9, "refs": 23, "density": 0.4, "maxFanOut": 5, "lines": 331, "parsed": true } }],
  "filesTotal": 22,
  "external": [{ "spec": "node:path", "count": 68 }],
  "counts": { "modules": 22, "analyzed": 22, "cycles": 1, "external": 12 },
  "durationMs": 61
}
```

`top` (default 50, max 200) caps both `files` and `external`. `filesTotal` is always the untruncated count, and the project verdict always uses every analysed file.

### `codeflow_features`

Returns `{ format, root, summary, count, lowConfidence, features, unmapped, unavailable }`. Each feature: `{ id, name, files[], nodes[], evidence[], confidence }`. `unavailable` is present when the root cannot be scanned; it is a report, not an error.

## Results and errors

A successful call:

```jsonc
← {"jsonrpc":"2.0","id":3,"result":{
     "content":[{"type":"text","text":"{ …pretty JSON… }"}],
     "structuredContent":{ …same object… }
   }}
```

A failed call — bad path, unreadable tree, unknown tool — is still a successful JSON-RPC response, with `isError: true` and a human-readable message:

```jsonc
← {"jsonrpc":"2.0","id":4,"result":{"content":[{"type":"text","text":"codeflow_tasks failed: 目录不存在：…"}],"isError":true}}
```

That boundary matters: an agent should see "the path was wrong" as a tool result it can reason about, not as a transport failure.

## Client setup

Claude Code:

```bash
claude mcp add codeflow-kernel -- node /abs/path/to/codeflow-kernel/bin/codeflow-kernel-mcp.js
```

ZCode / Cursor / any `mcpServers` JSON:

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

The server inherits the client's working directory, so `path: "."` means "the repository the client is working in".

## CI and scripting

The MCP server is for interactive clients. For pipelines, prefer the CLI, whose exit codes are part of the contract:

```bash
# Fail the build above a coupling threshold
codeflow-kernel coupling . --json > coupling.json
node -e "const r=require('./coupling.json'); process.exit(r.overall.score >= 60 ? 1 : 0)"

# Fail when new TODO markers appear
codeflow-kernel tasks . --json \
  | node -e "const r=JSON.parse(require('fs').readFileSync(0)); process.exit(r.stats.markers > 20 ? 1 : 0)"
```

Both call the same functions the tools call, so a threshold agreed in CI and a threshold used by an agent are the same number.
