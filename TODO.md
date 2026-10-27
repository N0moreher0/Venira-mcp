# VENIRA MCP CODING — TODO LIST (standalone v1.0.0 → next)

> Standalone: pure-Node backend, no external binary.
> Each item lists effort (low/med/high), priority (P0/P1/P2), and status.

## 📊 Current state (standalone v1.0.0)

- ✅ 100% of the logic has been moved to Node (no more Rust corehost)
- ✅ Audit via SQLite WAL using `better-sqlite3` (replaces `node:sqlite`)
- ✅ Native shell via `child_process` (no Rust required)
- ✅ 16 tools working, verify 100% PASS, doctor 7/7
- ✅ `search_cache_invalidated` fix (0-hit results are no longer cached)
- ✅ Dual license: MIT + Apache-2.0
- ✅ CI/CD GitHub Actions (no more Rust build needed)
- ✅ `package.json`: added `better-sqlite3`, `@types/better-sqlite3`, `engines: node >=20`

## 🔧 TODO (work through, by priority)

### P1: Cache control (effort: low, 1-2h)
```
[ ] VENIRA_CACHE_ALL=0 → disable every cache ("absolutely fresh" mode for strict users)
[ ] VENIRA_CACHE_LIST_ONLY=0, VENIRA_CACHE_SEARCH_ONLY=0 → per-type toggles
[ ] Update project_health → report cache_enabled (per type)
[ ] Test: verify with VENIRA_CACHE_ALL=0
```

### P1: Request tracing (effort: med, 3-4h)
```
[ ] VENIRA_TRACE=1 → log every tool call (op, args, ms, cached, ok/fail) to stderr
[ ] VENIRA_TRACE_FILE=... → write logs to a file (rotating, max 10MB)
[ ] Add tool `project_trace_status` → view the last 5 traces (no file read)
[ ] Doctor: check trace config, file size
```

### P1: Read audit log (effort: low, 2h)
```
[ ] Tool `project_read_audit` → read the audit log (last 20 rows by default, filter by session/op)
    Args: { session_id?, operation?, outcome?, limit? (1-100), since_unix? }
    Data: { operation, outcome, reason_code, started_at, completed_at, request_id, ... }
[ ] Backend: query the DB with better-sqlite3 (like project_health does)
[ ] If the DB is locked (WAL write from another process): fall back to "audit_unavailable" (do not crash)
[ ] Verify: audit_rows_present, read_audit_returns_last_20
[ ] Doctor: add a check for "read_audit tool reachable"
```

### P1: Shell UX upgrade (effort: med, 3-4h)
```
[ ] VENIRA_SHELL_TAIL_MAX=4096 (configurable, default 4000)
[ ] VENIRA_SHELL_EXIT_EARLY=1 (if exit_code is available, return early without waiting for wait_seconds)
[ ] VENIRA_SHELL_TIMEOUT_POLICY=soft|hard (soft: warn, hard: kill)
[ ] Tool `project_shell_cancel_session` → cancel ALL shell runs for the session
[ ] Cancel safety: verify that no "orphaned" runs are left in the DB
```

### P2: Fuzzy edit (effort: high, 8-12h) ⚠️
```
[ ] VENIRA_EDIT_FUZZY=1 → allow old_text_fuzzy (fuzzy match, Levenshtein/whitespace-tolerant)
[ ] Algorithm:
    - Normalize whitespace (collapse spaces/tabs, ignore leading indent if ignore_indentation=true)
    - Fuzzy match (Levenshtein distance <= N, N = fuzzy_distance, default 3)
    - Return ALL matches (so the user can pick when there are several)
[ ] New args: { old_text_fuzzy?, ignore_indentation?, fuzzy_distance?, case_insensitive? }
[ ] Backend (lib/corehost.ts): add the fuzzy field to opEditFile
[ ] Audit: record "fuzzy" in reason_code (so the user knows)
[ ] Verify: test 3 cases (exact, fuzzy with indent, fuzzy with whitespace)
```

### P2: `project_recent_files` → index (effort: high, 8-12h) ⚠️
```
[ ] Backend: index mtime per workspace (SQLite cache, updated on writes)
[ ] Query: WHERE mtime DESC LIMIT N (no more 4000-file limit)
[ ] Invalidated on write/edit/delete/create_directory (already done)
[ ] Node-side fallback (if the index is not ready yet): keep the current behaviour
[ ] Verify: recent_files on a workspace with >4000 files
```

### P3: `project_diff_files` (effort: high, 10-15h) ⚠️
```
[ ] Backend (lib/corehost.ts): diff two files (unified diff, git style)
[ ] Args: { relative_path_a, relative_path_b, context_lines?, max_lines? }
[ ] Data: { lines_added, lines_removed, unified_diff, truncated }
[ ] Use case: "compare two versions", "review changes"
```

### P3: `project_file_symbols` (effort: high, 10-15h) ⚠️
```
[ ] Backend: parse a file and extract symbols (fn/def/class/struct) by language
[ ] Args: { relative_path, language? (rs/py/ts/js/go...), include_functions?, include_classes? }
[ ] Data: { symbols: [{ name, kind, line, signature, doc_comment? }] }
[ ] Cache: by mtime (Node-side)
```

### P3: `project_symbol_references` (effort: high, 15-20h) ⚠️
```
[ ] Backend: find all references to a symbol (based on file_symbols + cross-file)
[ ] Args: { symbol_name, language?, scope? (file/workspace), kind? }
[ ] Data: { references: [{ relative_path, line_number, context }] }
```

### P3: `project_outline_symbol` (effort: med, 5-6h)
```
[ ] Backend: parse a file → outline (symbols + hierarchy, no cross-file needed)
[ ] Use case: "view the structure of a file" before reading/fixing
```

### P3: `project_explain_error` (effort: high, 10-15h)
```
[ ] LLM-based: error → explanation + how to fix it (uses the OpenCode model)
[ ] Args: { error_message?, log_tail?, context_file? }
[ ] Data: { explanation, suggested_fix, retry_hint }
```

### P3: `project_plan_read_batch` (effort: med, 4-6h)
```
[ ] A "planning" tool for reading files: suggests which batch/ranges/search to use
[ ] Input: { task_description, files_hint? }
[ ] Output: { recommended: [{ operation, args, why }], estimated_ms }
```

### P3: `project_selective_search` (effort: high, 8-10h)
```
[ ] "Smart" search: combine multiple queries (AND/OR/NOT), fuzzy, scoring
[ ] Args: { queries: [{ pattern, must?, weight? }], limit }
[ ] Data: { hits, scores, matched_queries }
```

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
- **v1.1.0** (P1, ~1 week): Cache control + Trace + read_audit + Shell UX
- **v1.2.0** (P2, ~2-3 weeks): Fuzzy edit + port recent_files to an index
- **v1.3.0** (P3, ~1-2 months): diff + symbols + references + explain_error + plan_batch + selective_search

## ✅ Success criteria
- [ ] The model picks the right tool per the rules (each P0/P1 done)
- [ ] Output is clear enough to debug (each P1 done)
- [ ] Multi-op workflows reduce round-trips (each P1 done)
- [ ] Speed is acceptable (proven by benchmarks)
- [ ] "Absolute" users have config for 100% (P1/P2 done)
