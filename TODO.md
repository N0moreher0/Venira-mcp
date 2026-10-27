# VENIRA MCP CODING — TODO LIST (standalone v1.0.0 → next)

> Standalone: pure-Node backend, no external binary.
> Mỗi item ghi: effort (thấp/trung/cao), loại (P0/P1/P2), trạng thái.

## 📊 Trạng thái hiện tại (standalone v1.0.0)

- ✅ Tách 100% logic sang Node (không còn Rust corehost)
- ✅ Audit qua SQLite WAL bằng `better-sqlite3` (đổi từ `node:sqlite`)
- ✅ Shell native qua `child_process` (không cần Rust)
- ✅ 16 tools hoạt động, verify 100% PASS, doctor 7/7
- ✅ `search_cache_invalidated` fix (không cache kết quả 0-hit)
- ✅ License dual: MIT + Apache-2.0
- ✅ CI/CD GitHub Actions (không cần build Rust nữa)
- ✅ `package.json`: thêm `better-sqlite3`, `@types/better-sqlite3`, `engines: node >=20`
- ✅ `opencode.example.json`: dùng `VENIRA_WORKSPACE` + `VENIRA_DATA_DIR` thay vì `VENIRA_COREHOST_EXE`

## 🔧 TODO (làm dần, theo priority)

### P1: Cache control (effort: thấp, 1-2h)
```
[ ] VENIRA_CACHE_ALL=0 → tắt mọi cache (fresh mode cho user "tuyệt đối")
[ ] VENIRA_CACHE_LIST_ONLY=0, VENIRA_CACHE_SEARCH_ONLY=0 → toggle từng loại
[ ] Update project_health → báo cache_enabled (per-type)
[ ] Test: verify với VENIRA_CACHE_ALL=0
```

### P1: Request tracing (effort: trung, 3-4h)
```
[ ] VENIRA_TRACE=1 → log mọi tool call (op, args, ms, cached, ok/fail) ra stderr
[ ] VENIRA_TRACE_FILE=... → ghi log vào file (rotating, max 10MB)
[ ] Thêm tool `project_trace_status` → xem trace cuối cùng (5 calls)
[ ] Doctor: check trace config, file size
```

### P1: Read audit log (effort: thấp, 2h)
```
[ ] Tool `project_read_audit` → đọc audit log (mặc định 20 dòng cuối, có filter session/op)
    Args: { session_id?, operation?, outcome?, limit? (1-100), since_unix? }
    Data: { operation, outcome, reason_code, started_at, completed_at, request_id, ... }
[ ] Backend: query DB bằng better-sqlite3 (như project_health đang làm)
[ ] Nếu DB bị lock: fallback "audit_unavailable" (không crash)
[ ] Verify: audit_rows_present, read_audit_returns_last_20
[ ] Doctor: thêm check "read_audit tool reachable"
```

### P1: Shell UX nâng cấp (effort: trung, 3-4h)
```
[ ] VENIRA_SHELL_TAIL_MAX=4096 (configurable, default 4000)
[ ] VENIRA_SHELL_EXIT_EARLY=1 (if exit_code available, trả early không chờ wait_seconds)
[ ] VENIRA_SHELL_TIMEOUT_POLICY=soft|hard (soft: warn, hard: kill)
[ ] Tool `project_shell_cancel_session` → huỷ TẤT CẢ shell runs của session
[ ] Cancel safety: verify không "mồ côi" run trong DB
```

### P2: Fuzzy edit (effort: cao, 8-12h) ⚠️
```
[ ] VENIRA_EDIT_FUZZY=1 → cho phép old_text_fuzzy (match gần, Levenshtein/whitespace-tolerant)
[ ] Algorithm:
    - Normalize whitespace (collapse spaces/tabs, ignore leading indent nếu ignore_indentation=true)
    - Fuzzy match (Levenshtein distance <= N, N = fuzzy_distance, default 3)
    - Trả về MỌI match (để user chọn nếu nhiều)
[ ] Args mới: { old_text_fuzzy?, ignore_indentation?, fuzzy_distance?, case_insensitive? }
[ ] Backend (lib/corehost.ts): thêm trường fuzzy vào opEditFile
[ ] Audit: ghi "fuzzy" vào reason_code (để user biết)
[ ] Verify: test 3 ca (exact, fuzzy with indent, fuzzy with whitespace)
```

### P2: `project_recent_files` port sang index (effort: cao, 8-12h) ⚠️
```
[ ] Backend: index mtime theo workspace (SQLite cache, update khi có write)
[ ] Query: WHERE mtime DESC LIMIT N (không giới hạn 4000 file)
[ ] Invalidates khi write/edit/delete/create_directory (đã có)
[ ] Node-side fallback (nếu chưa có): giữ nguyên hiện tại
[ ] Verify: recent_files trong workspace >4000 file
```

### P3: `project_diff_files` (effort: cao, 10-15h) ⚠️
```
[ ] Backend (lib/corehost.ts): diff 2 file (unified diff, git style)
[ ] Args: { relative_path_a, relative_path_b, context_lines?, max_lines? }
[ ] Data: { lines_added, lines_removed, unified_diff, truncated }
[ ] Use: "so sánh 2 phiên bản", "review changes"
```

### P3: `project_file_symbols` (effort: cao, 10-15h) ⚠️
```
[ ] Backend: parse file, extract symbol (fn/def/class/struct) theo ngôn ngữ
[ ] Args: { relative_path, language? (rs/py/ts/js/go...), include_functions?, include_classes? }
[ ] Data: { symbols: [{ name, kind, line, signature, doc_comment? }] }
[ ] Cache: theo mtime (Node-side)
```

### P3: `project_symbol_references` (effort: cao, 15-20h) ⚠️
```
[ ] Backend: find all references to a symbol (dựa trên file_symbols + cross-file)
[ ] Args: { symbol_name, language?, scope? (file/workspace), kind? }
[ ] Data: { references: [{ relative_path, line_number, context }] }
```

### P3: `project_outline_symbol` (effort: trung, 5-6h)
```
[ ] Backend: parse file → outline (symbol + hierarchy, không cần cross-file)
[ ] Use: "xem cấu trúc file" trước khi đọc/fix
```

### P3: `project_explain_error` (effort: cao, 10-15h)
```
[ ] LLM-based: error → giải thích + cách fix (dùng model OpenCode)
[ ] Args: { error_message?, log_tail?, context_file? }
[ ] Data: { explanation, suggested_fix, retry_hint }
```

### P3: `project_plan_read_batch` (effort: trung, 4-6h)
```
[ ] Tool "lập kế hoạch" đọc file: gợi ý nên dùng batch/ranges/search nào
[ ] Input: { task_description, files_hint? }
[ ] Output: { recommended: [{ operation, args, why }], estimated_ms }
```

### P3: `project_selective_search` (effort: cao, 8-10h)
```
[ ] Search "thông minh": kết hợp nhiều query (AND/OR/NOT), fuzzy, score
[ ] Args: { queries: [{ pattern, must?, weight? }], limit }
[ ] Data: { hits, scores, matched_queries }
```

## 📝 Ghi chú cho user "khó tính" / "tuyệt đối"

| Vấn đề | Config để "tuyệt đối" hơn |
|---|---|
| Cache stale | `VENIRA_CACHE_ALL=0` |
| Blind-edit fail | Pipeline: read → edit (luôn) + `expected_sha256` |
| Fuzzy edit | `VENIRA_EDIT_FUZZY=1` (P2, chưa có) |
| Shell timeout | `VENIRA_SHELL_TIMEOUT_POLICY=hard` |

## 🧪 Test plan (next)
- `verify.ts`: thêm checks cho audit mode, cache control, trace, read_audit
- `bench-mcp.ts`: thêm scenario "fresh mode" (VENIRA_CACHE_ALL=0) vs "default"
- `doctor.ts`: thêm check cho 4 biến mới

## 📅 Ước lượng timeline
- **v1.1.0** (P1, ~1 tuần): Cache control + Trace + read_audit + Shell UX
- **v1.2.0** (P2, ~2-3 tuần): Fuzzy edit + port recent_files sang index
- **v1.3.0** (P3, ~1-2 tháng): diff + symbols + references + explain_error + plan_batch + selective_search

## ✅ Success criteria
- [ ] Model chọn đúng tool theo quy tắc (mỗi P0/P1 done)
- [ ] Output đủ rõ để debug (mỗi P1 done)
- [ ] Workflow multi-op giảm round-trip (mỗi P1 done)
- [ ] Tốc độ chấp nhận được (bench chứng minh)
- [ ] User "tuyệt đối" có config để 100% (P1/P2 done)
