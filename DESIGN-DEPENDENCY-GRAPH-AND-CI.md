# Design: dependency graph + impact analysis, and CI waiting

Status: **proposal for review** (no code yet)
Target release: **v1.9.0** (minor)
Scope: two new read-only tools, one CI waiting tool, one optional CI watcher

---

## 1. Problem statement

### 1.1 Visualization / impact analysis

Today the only cross-file code intelligence is:

| Tool | What it actually does |
|---|---|
| `project_search` | literal/regex text search |
| `project_symbol_references` | **word-boundary regex** over one file or a bounded literal-content search (`tools/project.ts:2046-2063`) |
| `project_outline_symbol` / `project_file_symbols` | regex-based symbol extraction (`lib/symbol-diff.ts`) |
| `project_symbol_references` (workspace) | no declaration/usage distinction, no import graph |

Consequences:

- `Foo` in a comment, a string, and a class declaration are indistinguishable.
- No file → file edges, no transitive closure, no "if I edit this, what breaks?".
- Refactors rely on the agent mentally reconstructing the graph.

### 1.2 CI observability

`project_ci_status` / `project_ci_logs` are pull-only. The current workaround is a
30-second polling loop in user scripts (`wait-ci.js`), which burns requests and
keeps the agent passive.

**Hard constraint:** MCP over stdio lets a server emit notifications
(`notifications/message`, `resources/updated`), but **clients do not wake the
model** when one arrives. There is no server→model push in OpenCode, Claude
Desktop, or the MCP SDK. Any design that promises "the agent fixes CI while you
drink coffee" is not implementable inside this server.

What *is* implementable:

1. **Long-poll**: one tool call blocks until a state change or a bounded
   timeout, instead of N polling calls.
2. **Event cursor**: a background watcher records transitions locally; a later
   call returns everything that happened while the agent was idle.
3. **External daemon** (out of scope here): GitHub webhook → local daemon →
   OS/Telegram notification. That is the only true push path.

---

## 2. Goals / non-goals

### Goals

- Answer "what depends on this file/symbol, transitively?" deterministically.
- Produce a graph the user can render (JSON, DOT, Mermaid).
- Replace CI polling loops with one bounded call that returns the transition and
  the failure tail.
- Keep the server dependency-light: **no new runtime/native dependencies**.
- Respect workspace lock, read caches, audit, `VENIRA_NETWORK`, and
  `VENIRA_PROFILE`.

### Non-goals

- Full language-server-grade resolution (type inference, generics, macros,
  conditional compilation).
- Package-manager resolution (`node_modules`, `site-packages`) beyond an
  aggregated `external` node.
- True push notifications to the model.
- Editing code automatically.

---

## 3. Constraints from the current architecture

| Constraint | Where | Impact on design |
|---|---|---|
| Operation timeouts | `timeoutFor()` in `tools/project.ts:249-259`: default 30 s, external 60 s, `ci_logs` 90 s, snapshots 120 s | `ci_wait` needs its own budget = `timeout_ms + 10 s` |
| Serial queue | `UNQUEUED = { shell_status, cancel }` (`tools/project.ts:262`) | `ci_wait` must be unqueued or it blocks every other tool |
| Client request timeout | MCP SDK default 60 s (observed in CI as `-32001 ... {timeout: 60000}`) | default `timeout_ms` 45 s; document the ceiling |
| Tool count asserted | `scripts/doctor.ts:97` expects **41**; README says 41 | adding 3 tools → update doctor + README + `server.ts` guidance |
| Audit op list | `scripts/verify.ts` checks audit `ops` | new ops must be added to the expected list |
| `core` profile | `tools/project.ts:1663` explicitly disables 7 tools | keep new tools out of `core` (they are optional intelligence) |
| Read caches | mtime+size validated; invalidated on write/edit/delete | graph cache must hook the same invalidation |
| Workspace lock | all paths validated, `../` rejected | graph walk stays inside the workspace |
| Protected paths | `.env*`, keys, `secrets.*` are denied to reads | **indexer must skip them**, never leak their content into nodes/edges |
| No new deps | package has 1 native dep (`better-sqlite3`) | parser-lite, not a full AST library |

---

## 4. Feature A — `project_dependency_graph`

### 4.1 API

```ts
project_dependency_graph({
  kind: "files" | "symbols" | "both",     // default "files"
  format: "json" | "dot" | "mermaid",     // default "json"
  relative_path?: string,                  // limit the walk to a subtree
  depth?: number,                          // 1..10, default 3
  include_external?: boolean,              // default false; aggregate npm/pip/crate nodes
  include_tests?: boolean,                 // default true
  languages?: string[],                    // e.g. ["ts","py"]; default: all supported
  max_nodes?: number,                      // 1..2000, default 500
  max_edges?: number                       // 1..5000, default 2000
})
```

Result (`kind: dependency_graph`):

```jsonc
{
  "root": ".",
  "kind": "files",
  "generated_at": "2026-11-02T12:00:00.000Z",
  "nodes": [
    { "id": "src/app.ts", "type": "file", "language": "ts", "loc": 120 },
    { "id": "src/lib/util.ts", "type": "file", "language": "ts", "loc": 64 }
  ],
  "edges": [
    {
      "from": "src/app.ts",
      "to": "src/lib/util.ts",
      "type": "import",          // import | extends | implements | calls | references
      "confidence": "exact",      // exact | likely | possible
      "line": 3,
      "via": "import { x } from './lib/util'"
    }
  ],
  "external": [{ "id": "npm:zod", "used_by": 12 }],
  "stats": {
    "files_scanned": 812,
    "files_skipped": 34,
    "edges": 1903,
    "duration_ms": 420,
    "cache": "hit"              // hit | miss
  },
  "truncated": false,
  "next_cursor": null
}
```

`format: "dot"` / `"mermaid"` returns a string in `data.graph` with the same
node/edge set, capped by `max_nodes`/`max_edges`.

### 4.2 Algorithm (deterministic, no LLM)

**Pass 1 — file discovery**

- Walk from `root` (workspace or `relative_path`) using the existing bounded
  walk helpers.
- Ignore: `.git`, `node_modules`, `dist`, `build`, `out`, `.venv`, `vendor`,
  `target`, `coverage`, `.next`, `__pycache__`, plus `.gitignore` entries when
  cheap to parse (best-effort).
- Skip protected paths and files above `max_file_bytes` (default 1 MiB).
- Caps: 5,000 files / 64 MB total scanned. Over cap → `truncated: true` and a
  hint, never silent partial data.

**Pass 2 — per-language import extraction** (line-oriented, comment/string aware
where cheap):

| Language | Patterns |
|---|---|
| TS/JS | `import ... from "x"`, `export ... from "x"`, `require("x")`, `import("x")` (string literal only) |
| Python | `import a.b`, `from .x import y`, `from a.b import y` |
| Go | `import "pkg"`, `import ( ... )` blocks |
| Rust | `mod x;`, `use crate::x`, `pub use` |
| Java/Kotlin | `import a.b.C;`, `extends`, `implements` |
| C# | `using A.B;`, `: BaseClass` |
| Ruby/PHP (P2) | `require`/`require_relative`, `use` |

**Pass 3 — resolution**

- Relative specifiers (`./`, `../`) → normalized path inside the workspace.
- Workspace-absolute aliases are **not** resolved in v1 (no `tsconfig` paths,
  no Go modules); they become `external` or `unresolved` entries.
- Extension probing: `.ts`, `.tsx`, `.js`, `.jsx`, `.py`, `/index.ts`, etc.
- `confidence`:
  - `exact` — specifier resolved to a file that exists;
  - `likely` — symbol declared in exactly one workspace file and referenced by
    name;
  - `possible` — dynamic import, reflection, re-export ambiguity, or multiple
    declarations.

**Pass 4 — symbol edges** (`kind: symbols|both`)

- Declarations: reuse `extractSymbols()` from `lib/symbol-diff.ts`, extended to
  record `{file, name, kind, line}`.
- Usages: word-boundary identifier scan per file, skipping comments/strings
  best-effort; only emit an edge when the identifier matches a known
  declaration.
- `extends`/`implements` edges come from the class/interface declaration line.

**Pass 5 — closure + serialization**

- BFS with `depth` cap, stable ordering (`from`, then `to`, then `line`) so
  output is reproducible across runs.
- Cycles are allowed (they are real); no infinite traversal.
- Response budget: if the serialized payload exceeds the envelope budget,
  return `truncated: true`, `next_cursor` (deterministic offset token), and a
  hint to narrow with `relative_path`/`depth`.

**Cache**

- Key: `root + sorted(enabled options)`.
- Fingerprint: file count + max mtime + total bytes (same cheap style as the
  read cache).
- Invalidate on `write_file`, `edit_file`, `edit_batch`, `delete_path`,
  `create_directory`, snapshot restore, and `VENIRA_CACHE_ALL=0`.
- TTL safety net: 5 s.

### 4.3 Error codes

| Case | Envelope |
|---|---|
| bad `kind`/`format`/`depth` | `invalid_request` + hint listing valid values |
| `relative_path` missing | `not_found` |
| `relative_path` outside workspace | `path_escape` |
| walk over cap | success + `truncated: true` + hint |
| no supported files | success with empty nodes/edges + hint |

---

## 5. Feature B — `project_change_impact`

### 5.1 API

```ts
project_change_impact({
  files?: string[],       // workspace paths you plan to edit
  symbols?: string[],     // names you plan to rename/change
  direction?: "dependents" | "dependencies" | "both",  // default "dependents"
  depth?: number,         // 1..10, default 5
  include_tests?: boolean,// default true
  max_nodes?: number,     // default 300
  format?: "json" | "mermaid" // default "json"
})
```

Requires at least one of `files`/`symbols`, otherwise `invalid_request`.

### 5.2 Result (`kind: change_impact`)

```jsonc
{
  "seed": { "files": ["src/lib/util.ts"], "symbols": ["parseConfig"] },
  "direction": "dependents",
  "affected": [
    {
      "id": "src/app.ts",
      "type": "file",
      "distance": 1,
      "path": ["src/lib/util.ts", "src/app.ts"],
      "reason": "imports parseConfig",
      "confidence": "exact"
    }
  ],
  "unresolved": [
    { "from": "src/plugin.ts", "specifier": "./plugins/*", "reason": "dynamic import" }
  ],
  "summary": {
    "affected_files": 3,
    "affected_symbols": 5,
    "max_distance": 2,
    "tests_affected": 1
  },
  "truncated": false
}
```

This is the tool that answers the user's sentence: *"sửa hàm X ở file A ảnh
hưởng 5 hàm ở 3 file B, C, D"* — with the affected symbols listed, not just
files.

### 5.3 Notes

- Files are validated through the workspace lock; `not_found` if a seed is
  missing.
- `symbols` resolves against the declaration index; unknown symbol →
  `unresolved` entry, not an error (it may be external).
- The result is advisory: `confidence: possible` means "could be affected, not
  proven".

---

## 6. Feature C — `project_ci_wait`

### 6.1 API

```ts
project_ci_wait({
  run_id?: number | string,
  ref?: string,
  pr?: number | string,
  branch?: string,
  workflow?: string,
  repo?: string,
  until?: "terminal" | "any_change",   // default "terminal"
  timeout_ms?: number,                 // 1000..110000, default 45000
  interval_ms?: number,                // 2000..15000, default 5000 (internal)
  include_failure_tail?: boolean,      // default true
  tail_lines?: number,                 // 1..1000, default 80
  provider?: "github" | "gitlab" | "bitbucket"
})
```

### 6.2 Semantics

- Takes the same selectors as `project_ci_status`; exactly one of
  `run_id`/`ref`/`pr`/`branch` is required.
- Polls the provider with backoff (`interval_ms`, capped) until:
  - state is **terminal**: `success | failure | cancelled | skipped` (provider
    mapping normalized to these values), or
  - `until: "any_change"` and `overall` differs from the first observed value, or
  - `timeout_ms` elapses.
- On failure with `include_failure_tail: true`, appends the same bounded tail
  that `project_ci_logs` produces (reuses the log reader; no duplicate code).
- Returns `waited_ms`, `polls`, `previous`, `overall`, `changed`, and the
  `ci_status` payload.

```jsonc
{
  "overall": "failure",
  "previous": "in_progress",
  "changed": true,
  "terminal": true,
  "waited_ms": 41230,
  "polls": 6,
  "run": { "id": 123, "name": "CI", "conclusion": "failure", "url": "..." },
  "failure_tail": { "entries": [...], "lines": 80, "text": "..." }
}
```

### 6.3 Implementation constraints

- **Unqueued**: add `ci_wait` to `UNQUEUED` so a waiting call never serializes
  behind reads/edits.
- **Timeout budget**: `timeoutFor("ci_wait") = timeout_ms + 10_000`; document
  that values above ~55 s require a client request timeout > 60 s.
- **Network**: respects `VENIRA_NETWORK=0` (returns `network_disabled`
  immediately, no socket).
- **Rate limits**: minimum interval 2 s, exponential backoff up to 15 s;
  `polls` is capped by `timeout_ms / interval_ms`.
- **Audit**: one audit row per wait (`command: "ci_wait run=<id> until=terminal
  timeout=45000"`), not one per poll.
- **Cancellation**: a second concurrent wait for the same `(repo, run)` reuses
  the same in-process poller (ref-counted) to avoid double API traffic.

### 6.4 Explicit limitations (documented in README)

- This is still the agent calling a tool. It does **not** wake the model.
- The practical workflow becomes: agent calls `project_ci_wait` once, gets the
  failure + tail in the same response, and starts fixing immediately.
- If the client has a 60 s request timeout, the default 45 s fits; longer waits
  should be chained (the tool returns `terminal: false` with the current state).

---

## 7. Optional Feature D — `project_ci_events` (Phase 3)

Only if Phase 2 proves insufficient.

- Opt-in: `VENIRA_CI_WATCH=1` plus `VENIRA_CI_WATCH_REPOS="owner/name"`.
- Background timer (30 s) polls the provider and appends transitions to a
  SQLite table `ci_events` (`repo`, `run_id`, `from`, `to`, `at`, `sha`).
- `project_ci_events({ since?: string, repo?, limit? })` reads locally (no
  network) and returns `events[]` + `next_since`.
- Retention: 1,000 rows per repo, pruned hourly.
- Cost: background network traffic while enabled — therefore **off by default**
  and never enabled by the agent.

---

## 8. Security and privacy

- Both graph tools are **read-only** (`readOnlyHint: true`, `openWorldHint:
  false`) and never touch the network.
- Indexer must skip protected paths (`.env*`, `*.key`, `secrets.*`,
  `id_rsa*`, `.npmrc`, `.netrc`) and must not emit their contents in nodes,
  edges or errors.
- Symlinks: resolve and refuse targets outside the workspace (same rule as
  `read_file`).
- `ci_wait` uses the existing provider credential chain and secret guard; log
  tails pass through the response-side secret scan before being returned.
- Graph output is data, not instructions; no code execution.

---

## 9. Observability

- Metrics: `dependency_graph`, `change_impact`, `ci_wait` recorded via
  `recordMetric()` with ok/fail and duration.
- Trace: `VENIRA_TRACE=1` logs them like every other op.
- Audit ops: add `dependency_graph`, `change_impact`, `ci_wait` to
  `scripts/verify.ts` expected ops.
- Health: `project_health` unchanged; graph cache stats can be added to
  `cache` in a follow-up.

---

## 10. Test plan

### Graph / impact

Fixtures under a temp workspace:

1. TS relative imports, `index.ts` re-export, dynamic `import()` → `possible`.
2. Python package-relative imports (`from .x import y`).
3. Go module imports; Rust `mod`/`use`; Java/C# imports and `extends`.
4. Cycle A→B→A: no hang, both edges present.
5. Symbol declared twice (ambiguity) → `possible`, not `exact`.
6. Comment/string containing an import-looking line → ignored.
7. Protected file (`.env`) present in tree → no node, no content leak.
8. 5,001 files → `truncated: true` with hint (not an error).
9. Windows backslash paths and case differences resolve correctly.
10. Cache: hit on second call, invalidated after `edit_file`.
11. `project_change_impact` on a leaf → empty affected list + summary zeros.

### CI wait

Use the existing mock-provider HTTP harness (same style as
`scripts/test-provider-secret-guard.ts`):

1. in_progress → success returns terminal in one call, `changed: true`.
2. in_progress → failure includes `failure_tail` and its text.
3. timeout returns `terminal: false`, `overall: in_progress`, no error.
4. `VENIRA_NETWORK=0` → `network_disabled`, zero requests.
5. Rate-limit/5xx retry respects backoff; no infinite loop.
6. Audit has one row per wait, not per poll.

### Verify additions

- `tool_dependency_graph_present`, `tool_change_impact_present`,
  `tool_ci_wait_present`.
- `dependency_graph_ts_fixture`, `dependency_graph_cycle`,
  `dependency_graph_protected_paths`.
- `change_impact_reverse_closure`.
- `ci_wait_transition`, `ci_wait_timeout`, `ci_wait_network_disabled`.
- Doctor expected tool count 41 → 44 (or 43 if `ci_events` is deferred).

---

## 11. Rollout

| Step | Change |
|---|---|
| 1 | `lib/dependency-graph.ts` (index, resolve, closure, DOT/Mermaid) |
| 2 | `tools/project.ts`: register `project_dependency_graph`, `project_change_impact`; wire cache invalidation |
| 3 | `lib/ci-wait.ts` + `ci_wait` op in `lib/corehost.ts`, `UNQUEUED`, timeout budget |
| 4 | README: §4 tool table + "how to use impact analysis" example; update tool count |
| 5 | `server.ts` usage guidance + `scripts/doctor.ts` expected count |
| 6 | `scripts/verify.ts` checks; CI matrix green |
| 7 | Version 1.9.0 + changelog |

`VENIRA_PROFILE=core` keeps disabling the code-intelligence tools, so core users
see no change.

---

## 12. Open questions (need a decision before coding)

1. **Languages**: ship TS/JS + Python + Go + Rust in v1, or TS/JS only and add
   the rest later? (Recommendation: TS/JS + Python first; Go/Rust/Java in
   v1.9.1.)
2. **Output default**: JSON only, or make Mermaid the default for
   `project_dependency_graph` since it renders in many clients? (Recommendation:
   JSON default; Mermaid via `format`.)
3. **Impact seed**: accept symbols only by name, or require
   `{symbol, file}` pairs to avoid ambiguity? (Recommendation: allow both;
   name-only returns `confidence: possible` when ambiguous.)
4. **`ci_wait` ceiling**: 110 s max with documented client-timeout caveat, or
   strict 55 s? (Recommendation: 110 s max, default 45 s.)
5. **Watcher (Phase 3)**: do you actually want background polling
   (`VENIRA_CI_WATCH=1`), or is long-poll enough? (Recommendation: skip until
   requested; it adds standing network traffic.)
6. **Test files**: include by default in impact analysis? (Recommendation: yes,
   flagged separately in `summary.tests_affected`.)
