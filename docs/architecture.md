# Architecture

CodeFlow Kernel is a pure function over a directory tree. Everything here follows from that one sentence: no global state, no caches keyed by time, no writes into the tree, no network.

## Layers

```
L0  engine/core      fs, path, text helpers                    (no domain knowledge)
L1  engine/scan      walk, symbols, comments                   (reads files, extracts facts)
L2  engine/*         importer, analyst, coupling, features     (facts → graphs / scores)
L3  analysis.js      one report from the L2 pieces             (new in this repository)
L4  cli/, mcp/       rendering, exit codes, JSON-RPC           (transport only)
```

Rules that hold across the repository:

1. **Dependencies point down.** L1 never imports L2; L2 never imports L3; L4 never re-implements L2 logic.
2. **`analysis.js` is the only place that knows a report has four sections.** Adding a fifth analysis means touching one file, not three call sites.
3. **Nothing above L1 knows what a canvas is.** `codeflow/1` is a graph format — nodes and links — not a UI contract.
4. **No L2 module knows a file path shape.** User input is normalised once, in `engine/paths.js`.

## Determinism

The contract is: for the same tree, the same commit, `nodes`, `links`, `coupling.files` and `features` are byte-identical across runs and machines.

How it is kept:

- All iteration over maps and sets happens in insertion order, and insertion order comes from a sorted or scan-ordered source.
- Every ordering that could be ambiguous is broken by a stable key: score desc → path asc; marker weight desc → file asc → line asc; fan-in desc → path asc.
- No `Math.random`, no `Date.now` in a value that feeds a comparison. Timestamps exist only in `meta.createdAt`, `meta.updatedAt`, `features.generatedAt`.
- File budgets are applied deterministically (walk order is sorted), so truncation is reproducible too.

`tests/engine.mjs` asserts this by running the import twice and comparing stripped graphs; `tests/bench.mjs` repeats the check on a 60-file fixture and exits non-zero if it breaks.

## Data flow

```
                       ┌──────────────────┐
        ┌─────────────→│  importProject   │→ tasks graph (codeflow/1)
        │              └──────────────────┘
 walk ──┤              ┌──────────────────┐
 (files)└─────────────→│  analyzeModules  │→ modules graph (codeflow/1)
                       └──────────────────┘
                       ┌──────────────────┐
   files ─────────────→│ scanCoupling     │→ analyzeCoupling → per-file metrics
                       └──────────────────┘         │
                                                    └→ overallOf → 0–100 + level
                       ┌──────────────────┐
   graph + tree ──────→│ buildFeatureIndex│→ features.json shape (in memory)
                       └──────────────────┘
```

`importProjectDual` runs the two graph generators under one project name and one root resolution, so a task pipeline and a module graph can never disagree about which directory was scanned. Module-graph failure is isolated: the task pipeline still returns, with `modulesWarning` set — never a fabricated empty graph.

## The four analyses

### Task pipeline (`engine/importer.js`)

- Walk the tree with `maxFiles` / `maxDepth`.
- Read the head of each source file (200 lines / 64 KB).
- Extract comments with the language's grammar, then markers (`TODO`, `FIXME`, `XXX`, `HACK`, …) with `MARKER_WEIGHT`.
- Emit `scan` and `comments` nodes as `done` (the import *is* the scan), promote markers to `edit` nodes, append `testgen` (when there are no tests) and `review`, then `deliver`.
- One to two markers collapse into a single aggregate task, so a small repository does not produce a fragmented graph.

### Module graph (`engine/analyst.js`)

- Per source file: top-level symbols (function / class / type) with line numbers, import specifiers resolved against the scanned tree, role inferred from framework signals, naming and header comments.
- One `module` node per file, capped at 36 files; up to 3 key files (entry points first, then hubs) expand into per-symbol `module` nodes carrying `params.symbol`.
- Links follow the strongest local dependency; the full dependency list lives in the node's `detail`, because a canvas input accepts one edge.

### Coupling (`engine/coupling.js`)

Per file:

- **intra**: symbol reference edges, density, max fan-out, inner cycles
- **inter**: fan-in, fan-out, transitive closure, dependency depth, SCC size
- **external**: distinct unresolved import specifiers

```
score = round(100 × clamp01(w_intra × intra + w_inter × inter))
level = score >= 60 ? high : score >= 30 ? medium : low
```

Project verdict: line-weighted mean of analysed modules plus `min(15, 3 × cycleFiles)`, mapped through the same thresholds. `analyzed < modules` sets `partial: true` — the report says it is incomplete instead of pretending otherwise.

Cycles: Tarjan strongly connected components over the resolved import graph (`stronglyConnected`, iterative, no recursion-depth surprise).

### Feature index (`engine/features/`)

Deterministic feature → files mapping from five signal families: `docs/design.md` headings, entry-point signals, top-level symbols, directory/file-name dictionary, and node labels. Each feature carries `evidence[]` and `confidence`; anything below `LOW_CONFIDENCE` (0.5) is labelled. No clustering fallback: no signal means no feature.

## Host extraction

The engine originally lived inside a desktop plugin. Four host-module imports were required to analyse a directory:

| Host module | What the engine used | Resolution |
| --- | --- | --- |
| `lib/workspace.js` | `cleanPathInput`, `resolveProjectRoot` | Moved to `engine/paths.js` (the rest of that module is session/agent wiring) |
| `lib/archive.js` | `stripArchiveExtension` | Dropped — only used by the drag-and-drop import pipeline, which is not part of the kernel |
| `lib/drop-import.js` | `resolveProjectName` | Dropped — it resolves name conflicts in the host's project store |
| `lib/cards/merge.js` | `mergeCards` | Dropped — it merges persisted canvas cards, which the kernel never has |

`lib/import/pipeline.js` (the import route orchestration) and `lib/duo.js#persistDualResult` (store writes) were removed for the same reason: they are host state machines, not analysis.

The `codeflow/1` graph format, symbol/comment grammars, coupling weights and thresholds are unchanged, so graphs produced here load in CodeFlow Canvas without conversion.

## Extension points

- **A new analysis** → write it under `lib/engine/`, expose it in `lib/index.js`, then add a section to `analyzeRepository` and a tool to `lib/mcp/server.js`. Two edits, no duplication.
- **A different report shape** → wrap `analyzeRepository`; do not fork the engine.
- **A new language** → add extensions to `LANG_EXTS` in `engine/scan/walk.js` and, if it has unusual comment syntax, a grammar to `familyOf` in `engine/scan/comments.js`.
- **Different thresholds** → do not tune per project. The 30/60 split is a contract shared with the canvas; changing it here would desynchronise the two.
