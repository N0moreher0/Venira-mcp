# VENIRA MCP CODING — TODO LIST (standalone v1.0.0 → v1.3.0)

> Standalone: pure-Node backend, no external binary.
> Each item lists effort (low/med/high), priority (P0/P1/P2/P3), and status.

## 📊 Current state (standalone v1.0.0)

- ✅ 100% of the logic has been moved to Node (no more Rust corehost)
- ✅ Audit via SQLite WAL using `better-sqlite3` (replaces `node:sqlite`)
- ✅ Native shell via `child_process` (no Rust required)
- ✅ 25 tools working, verify 26/26 PASS, doctor 12/12 PASS
- ✅ `search_cache_invalidated` fix (0-hit results are no longer cached)
- ✅ Dual license: MIT + Apache-2.0
- ✅ CI/CD GitHub Actions (no more Rust build needed)
- ✅ `package.json`: added `better-sqlite3`, `@types/better-sqlite3`, `engines: node >=20`
- ✅ Cache control environment variables added
- ✅ Request tracing environment variables added
- ✅ Read audit log tool implemented
- ✅ Shell UX upgrade implemented
- ✅ P2 code intelligence: `project_outline_symbol` / `project_file_symbols`
- ✅ P3 code intelligence: `project_diff_files`, `project_symbol_references`, `project_selective_search`

## 🎯 Implementation Roadmap

### Phase 1: Cache Control (P1) ✅
- [x] VENIRA_CACHE_ALL=0 → disable every cache ("absolutely fresh" mode for strict users)
- [x] VENIRA_CACHE_LIST_ONLY=0, VENIRA_CACHE_SEARCH_ONLY=0 → per-type toggles
- [x] Update project_health → report cache_enabled (per type)
- [x] Test: verify with VENIRA_CACHE_ALL=0

### Phase 2: Request Tracing (P1) ✅
- [x] VENIRA_TRACE=1 → log every tool call (op, args, ms, cached, ok/fail) to stderr
- [x] VENIRA_TRACE_FILE=... → write logs to a file (rotating, max 10MB)
- [x] Add tool "project_trace_status" → view the last 5 traces (no file read)
- [x] Doctor: check trace config, file size

### Phase 3: Read Audit Log (P1) ✅
- [x] Tool "project_read_audit" → read the audit log (last 20 rows by default, filter by session/op)
- [x] Backend: query the DB with better-sqlite3 (like project_health does)
- [x] If the DB is locked (WAL write from another process): fall back to "audit_unavailable" (do not crash)
- [x] Verify: audit_rows_present, read_audit_returns_last_20
- [x] Doctor: add a check for "read_audit tool reachable"

### Phase 4: Shell UX Upgrade (P1) ✅
- [x] VENIRA_SHELL_TAIL_MAX=4096 (configurable, default 4000)
- [x] VENIRA_SHELL_EXIT_EARLY=1 (if exit_code is available, return early without waiting for wait_seconds)
- [x] VENIRA_SHELL_TIMEOUT_POLICY=soft|hard (soft: warn, hard: kill)
- [x] Tool "project_shell_cancel_session" → cancel ALL shell runs for the session
- [x] Cancel safety: verify that no "orphaned" runs are left in the DB

## 🚀 New Tools to Add (P2 - Aug 2025)

### P2: Fuzzy Edit (effort: high, 8-12h) ⚠️
- [ ] VENIRA_EDIT_FUZZY=1 → allow old_text_fuzzy (fuzzy match, Levenshtein/whitespace-tolerant)
- [ ] Algorithm:
    - Normalize whitespace (collapse spaces/tabs, ignore leading indent if ignore_indentation=true)
    - Fuzzy match (Levenshtein distance <= N, N = fuzzy_distance, default 3)
    - Return ALL matches (so the user can pick when there are several)
- [ ] New args: { old_text_fuzzy?, ignore_indentation?, fuzzy_distance?, case_insensitive? }
- [ ] Backend (lib/corehost.ts): add the fuzzy field to opEditFile
- [ ] Audit: record "fuzzy" in reason_code (so the user knows)
- [ ] Verify: test 3 cases (exact, fuzzy with indent, fuzzy with whitespace)

### P2: `project_recent_files` → index (effort: high, 8-12h) ⚠️
- [ ] Backend: index mtime per workspace (SQLite cache, updated on writes)
- [ ] Query: WHERE mtime DESC LIMIT N (no more 4000-file limit)
- [ ] Invalidated on write/edit/delete/create_directory (already done)
- [ ] Node-side fallback (if the index is not ready yet): keep the current behaviour
- [ ] Verify: recent_files on a workspace with >4000 files

### P2: `project_outline_symbol` (effort: medium, 5-6h) ✅
- [x] Backend: parse a file → outline (symbols + hierarchy, no cross-file needed)
- [x] Args: { relative_path, language? (rs/py/ts/js/go...), include_functions?, include_classes? }
- [x] Data: { symbols: [{ name, kind, line, signature, doc_comment? }] }
- [x] Cache: by mtime (Node-side)
- [x] Implementation in `lib/symbol-diff.ts` (extractSymbols, buildOutline)
- [x] Tool registration in `tools/project.ts` (runOutlineSymbol, runFileSymbols)

## 🚀 New Tools to Add (P3 - Oct 2025)

### P3: `project_diff_files` (effort: high, 10-15h) ✅
- [x] Backend (lib/corehost.ts): diff two files (unified diff, git style)
- [x] Args: { relative_path_a, relative_path_b, context_lines?, max_lines? }
- [x] Data: { lines_added, lines_removed, unified_diff, truncated }
- [x] Use case: "compare two versions", "review changes"
- [x] Implementation in `lib/symbol-diff.ts` (diffUnified function)
- [x] Tool registration in `tools/project.ts` (runDiffFiles)

### P3: `project_file_symbols` (effort: high, 10-15h) ✅
- [x] Backend: parse a file and extract symbols (fn/def/class/struct) by language
- [x] Args: { relative_path, language? (rs/py/ts/js/go...), include_functions?, include_classes? }
- [x] Data: { symbols: [{ name, kind, line, signature, doc_comment? }] }
- [x] Cache: by mtime (Node-side)
- [x] Implementation in `lib/symbol-diff.ts` (extractSymbols, buildOutline)
- [x] Tool registration in `tools/project.ts` (runFileSymbols)

### P3: `project_symbol_references` (effort: high, 15-20h) ✅
- [x] Backend: find all references to a symbol (based on file_symbols + cross-file)
- [x] Args: { symbol_name, language?, scope? (file/workspace), kind? }
- [x] Data: { references: [{ relative_path, line_number, context }] }
- [x] file scope: bounded regex search within the file
- [x] workspace scope: uses content search via "search" op
- [x] Tool registration in `tools/project.ts` (runSymbolReferences)

### P3: `project_explain_error` (effort: high, 10-15h) ⏸️
- [ ] LLM-based: error → explanation + how to fix it (uses the OpenCode model)
- [ ] Args: { error_message?, log_tail?, context_file? }
- [ ] Data: { explanation, suggested_fix, retry_hint }
- [ ] Status: DEFERRED — requires OpenCode model access, low priority

### P3: `project_plan_read_batch` (effort: medium, 4-6h) ⏸️
- [ ] A "planning" tool for reading files: suggests which batch/ranges/search to use
- [ ] Input: { task_description, files_hint? }
- [ ] Output: { recommended: [{ operation, args, why }], estimated_ms }
- [ ] Status: DEFERRED — requires OpenCode model access, low priority

### P3: `project_selective_search` (effort: high, 8-10h) ✅
- [ ] "Smart" search: combine multiple queries (AND/OR/NOT), fuzzy, scoring
- [x] Args: { queries: [{ pattern, must?, weight? }], limit }
- [x] Data: { hits, scores, matched_queries }
- [x] Implementation in `lib/symbol-diff.ts` (selectiveSearch function)
- [x] Tool registration in `tools/project.ts` (runSelectiveSearch)

## 📝 Notes for "strict" / "absolute" users

| Problem | Config to be "absolute" |
|---|---|
| Stale cache | `VENIRA_CACHE_ALL=0` |
| Blind-edit failure | Pipeline: read → edit (always) + `expected_sha256` |
| Fuzzy edit | `VENIRA_EDIT_FUZZY=1` (P2, not yet available) |
| Shell timeout | `VENIRA_SHELL_TIMEOUT_POLICY=hard` |

## 🧪 Test plan (next)
- `verify.ts`: add checks for audit mode, cache control, trace, read_audit
- `bench-mcp.ts`: add a "fresh mode" scenario (VENIRA_CACHE_ALL=0) vs "default"
- `doctor.ts`: add checks for the 4 new env vars

## 📅 Estimated timeline
- **v1.1.0** (P1, ~1 week): ✅ Cache control + Trace + read_audit + Shell UX (COMPLETED)
- **v1.1.2** (~2 days): Updated verify/doctor tool counts to 25
- **v1.2.0** (P2, ~2-3 weeks):
  - ~~Fuzzy edit + port recent_files to an index~~ (DEFERRED, depends on fuzzy edit + indexing)
  - project_outline_symbol (COMPLETED)
- **v1.3.0** (P3, ~1-2 months):
  - diff + symbols + references + selective_search (COMPLETED)
  - explain_error + plan_read_batch (DEFERRED, requires OpenCode model access)
- **v1.4.0** (bonus): chroma/supabase/db integration, pricing/debugging, metrics UI

## ✅ Success criteria
- [x] The model picks the right tool per the rules (each P0/P1 done)
- [x] Output is clear enough to debug (each P1 done)
- [x] Multi-op workflows reduce round-trips (each P1 done)
- [x] Speed is acceptable (proven by benchmarks)
- [x] "Absolute" users have config for 100% (P1 done, P2 in progress)

---

## 📝 Change Log

### v1.2.0 (2025-10-28) ✅
- **P1**: Cache control env vars (`CACHE_ALL_ENABLED`, `CACHE_LIST_ONLY_ENABLED`, `CACHE_SEARCH_ONLY_ENABLED`)
- **P1**: Request tracing (`lib/tracer.ts`, `project_trace_status` tool)
- **P1**: Read audit (`project_read_audit` tool)
- **P1**: Shell UX (`VENIRA_SHELL_TAIL_MAX`, `VENIRA_SHELL_EXIT_EARLY`, `VENIRA_SHELL_TIMEOUT_POLICY`, `project_shell_cancel_session`)
- **v1.1.2 (2025-10-28)**: Updated verify/doctor to expect 25 tools, added P1 config reporting to `project_health` (cache, trace, shell sections)
- **v1.3.0 (2025-10-28)**: Implemented P2/P3 code intelligence:
  - `project_outline_symbol` / `project_file_symbols` (P2) - symbol extraction via regex
  - `project_diff_files` (P3) - unified diff via LCS
  - `project_symbol_references` (P3) - file/workspace scope symbol lookup
  - `project_selective_search` (P3) - multi-query fuzzy scoring search
- **DEFERRED**: `project_explain_error` and `project_plan_read_batch` (requires OpenCode model access, lower priority)
- **TODO`: Pending P2 fuzzy edit + recent_files index

---

Next steps: Starting P2 implementation (Fuzzy Edit, recent_files Index, project_outline_symbol)