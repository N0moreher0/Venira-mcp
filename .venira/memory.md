# venira-mcp - handoff note

## 2026-11-24 (buoi 4): PHASE 4 + PHASE 5 XONG - DA COMMIT (xem git log)

- Nhiem vu: dong Phase 4 (`parent_call_id` + hash chain) va Phase 5 (benchmark token) cua ROADMAP_MINIMAL_MODE.md. Roadmap local (gitignored) da cap nhat trang thai Phase 0-5 XONG.
- PHASE 4: cot additive `parent_call_id TEXT` trong project_tool_audit (lib/audit-store.ts; insert chi khi cot ton tai). ID truyen TUONG MINH: tools/project-jsexec.ts -> createSdkBridge(dispatch, { parentCallId: requestId }) -> bridge boc moi dispatch trong runWithAuditCallId (lib/audit-context.ts, AsyncLocalStorage) -> tools/project-backend.ts doc currentAuditCallId() dat vao envelope corehost -> lib/corehost.ts truyen vao auditStart. KHONG doc ngam trong corehost.
- HASH CHAIN VERSIONED (lib/audit-hash.ts): AUDIT_HASH_VERSION=3, payload v3 them parent_call_id; prefix h2:/s2: (v3) vs h1:/s1: (v2). verifyAuditRows doc version tu prefix va recompute bang dung payload cua row -> DB tron van verify. test-audit-verify co 11 case: chain tron v2+v3 verify, sua parent_call_id -> hash_mismatch, re-hash row v2 bang payload v3 -> broken_link o row ke tiep.
- read_audit (tools/project-audit.ts): loc `parent_call_id` (probe cot truoc; DB cu -> `0` = khong match, khong loi), select + tra field, dua vao danh sach field verify. Schema (tools/project-register-ops.ts) + docs (tools/project-docs.ts) + SDK help (lib/sdk-registry.ts) da cap nhat. LUU Y: phai TRIM mo ta cac field khac de read_audit 1767 B <= ceiling 1772 B (default 53221 / expert 72417 B, ceiling KHONG doi).
- Test: test:sdk-integration 6/6 (them check "sub-ops carry parent_call_id = execute_js request_id", dung file moi audit-seed.txt vi read cache khong tao audit row); test:audit-verify 11 case xanh; test:schema-budget xanh khong --update.
- PHASE 5: scripts/bench-modes.ts (npm run bench:modes; bench-mcp.ts import benchModes() -> key `modes`). Do 3 server MCP that tren cung fixture 5 file, task read -> edit -> shell: default ~22632 tok, core ~16500, minimal ~2893 (bytes/4; surface dominates: 84784 vs 60256 vs 10439 B; turns 3/3/1; ca 3 task_ok). Luu y shell_run phai `background: 0` moi co stdout.
- Docs: benchmarks.md §7 (+ lenh bench:modes), BENCHMARK-2026-11-24.md/.json (moi, da them package.json files[]), README §4 them so lieu, CHANGELOG Unreleased, AGENTS.md (dong open item + section Phase 4/5).
- VERIFY: `npm run verify` = 554 checks passed (2026-11-24). Temp debug scripts tmp-*.ts da xoa.
- Con lai (khong thuoc roadmap): publish npm (user tu chay, 2FA); README co the bo sung muc ve venira.* SDK; CHANGELOG ghi "khong push git" la ghi chu cu - thuc te van commit/push duoc.

## Bai hoc van hanh giu lai
- Server strip chuoi ANSI-pattern moi tang; file moi chua ESC chars se mat dau ngoac (TOML "[" "]" -> dung khoang trang).
- git tool: action=push chi 1 branch (khong force/delete/URL); repo venira-mcp la repo git rieng; `.venira/` + Update-venira-mcp.txt + Venira-mcp-upgrade.txt KHONG git add; ROADMAP_*.md bi gitignore.
- Shell may la cmd.exe (khong head/grep; dung findstr). TypeScript qua tsx; build = tsc. `npm run test:sdk-integration` can retry_failed=true neu da fail y het trong session.
- Shell policy: `sleep 30`, `git status`, `npm --version` = allow; `node -e`/`node <file>`, `ping` = ask; `rm -rf /` = deny. Child stdio la ["ignore","pipe","pipe"].
- read_file qua venira_read_file trong output mode compact hay tra preview rong voi ranges -> dung search/context hoac grep.
- Release cu: 6.1.0; site GitHub Pages song ngu EN/VI (node site/build.mjs, base /Venira-mcp); npm publish can 2FA -> user tu chay.
