# ROADMAP_HARDENING — venira-mcp (bản cập nhật)

> Baseline hotfix v1.7.1 (2026-11-01); cập nhật các phần việc đang làm ngày 2026-11-02.
> Mức độ: **P0** sửa ngay · **P1** sửa sớm · **P2** cải thiện. Cỡ việc: **S** < 2h · **M** ~1 ngày · **L** nhiều ngày.
> Nhãn: ✅ đã chạy thử trên bản này · 📖 chỉ đọc code · ❓ chưa kiểm lại.

## 0. Đánh giá nhanh: project đã hợp lý chưa?

**Hợp lý ở phần lõi.** `tsc` sạch, server khởi động và trả `initialize` đúng, 40 tool, kiến trúc tách lớp rõ (`workspace` / `shell-policy` / `snapshots` / `secrets` / `git-*`), có audit SQLite, có mock GitHub/GitLab/Bitbucket để test offline. Nhiều lỗ P0 của audit trước **đã được sửa** (xem bảng 1).

**Còn lại 3 nhóm việc dài hạn:**
1. **Policy theo nền tảng**: parser riêng cho POSIX/PowerShell/cmd vẫn chưa tách.
2. **Test/CI mở rộng**: cần ma trận OS/Node, corpus lớn hơn và fixture JSONC/atomic-write chuyên biệt.
3. **Bảo trì**: hai file lớn (`tools/project.ts`, `lib/corehost.ts`) vẫn chưa được tách nhỏ.

---

## 1. Đã xong (không cần làm lại)

| ID | Nội dung | Bằng chứng |
|----|----------|-----------|
| S1 | `&&` không còn bị nuốt: `npm run build && curl …` → `ask.network_access`; `echo a && git push --force` → `ask.git_history_rewrite` | ✅ chạy `evaluateShellCommand` |
| S2 | `\n` / `\r\n` là dấu phân cách: `git status⏎curl x` → `ask.network_access` | ✅ |
| S4 | Allow-list host git (`api.github.com`, `gitlab.com`, `api.bitbucket.org`) + `VENIRA_GIT_ALLOWED_HOSTS`; config ưu tiên `VENIRA_CONFIG_FILE` | 📖 `lib/git-config.ts` L134–266 |
| S6 | `expected_sha256` được kiểm tra khi write/edit → `[conflict]` | 📖 `corehost.ts` L935, L1075 |
| S7 | `old_text` có `min(1)` | 📖 `tools/project.ts` L1476, L2478 |
| S10 | `echo $(curl …)` → `ask.command_substitution` | ✅ |
| S11 (một phần) | `cat ~/.ssh/id_rsa` → `deny.protected_file_access` | ✅ |
| S16 | `cat .env`/`cat < .env`/`.env` glob → `deny.protected_file_access`; `git push --no-verify` and `git -C/-c ... push` → `ask.git_history_rewrite` | ✅ isolated `test:shell-security` + policy corpus |
| S17 | GitHub Device Flow: người dùng authorize trực tiếp trên GitHub; access/refresh token lưu vault mã hóa, không trả về agent | ✅ mock trong `test:github-device-flow` |
| S18 | `--setup-github` nhập PAT trong terminal ẩn, xác nhận rồi lưu vault mã hóa dùng chung theo OS user | 📖 `scripts/setup-github.ts`; test thủ công cần terminal |
| S19 | Secretlint quét request/response Git provider, giá trị vault/env và biến thể mã hóa; chặn request hoặc giữ lại output; scanner lỗi thì fail-closed | ✅ `test:provider-secret-guard` |
| S20 | Bổ sung nhận diện credential env như `DATABASE_URL`, kiểm tra Base64/URL-encoded; xử lý Git global options và protected paths qua redirection/glob | ✅ provider guard tests + shell regressions/corpus |
| R1 | Ghi/sửa file atomic (temp + rename) | 📖 `corehost.ts` L977–987, L1139–1145 |
| R2 | `edit_file` nhận biết CRLF/BOM, trả `eol` | 📖 `corehost.ts` L1057–1066 |
| R4 | Dọn `shellRuns` (giữ ≤ 64 run đã xong, bỏ run > 30 phút) | 📖 `corehost.ts` L393–406 |
| S8 | Cờ viết tắt: `powershell -ec …`, `bash -lc 'curl x'`, `node -pe 'x'` → `ask` | ✅ |
| S9 | Wrapper: `command curl …`, `env curl …` → `ask` | ✅ |
| S15 | `find . -exec rm -rf {} +` → `ask` | ✅ |
| S14 | Deny nhầm: `git commit -m "mount point fix"` → `allow`; `echo format c: >> notes.txt` → `allow` | ✅ |
| S12 | Token duyệt bind `cwd`/`shell`/`secret_env` | 📖 `lib/shell-policy.ts` |
| S13 | Windows tokenizer giữ `\` | 📖 `lib/shell-policy.ts` |
| R5 | Timeout mặc định 10 phút + policy `hard` | 📖 `lib/corehost.ts` L1432 |
| R3 | Lockfile `secrets.json` (wx + stale-timeout) | 📖 `lib/secrets.ts` L309 |
| R6 | Cache cột audit (`auditColumns`) | 📖 `lib/corehost.ts` L81 |
| R7 | Cache tool-policy theo mtime/env/inline | 📖 `lib/tool-policy.ts` L22 |
| R8 (một phần) | Hash-chain `prev_hash`/`row_hash`, `verify=true` | 📖 `lib/corehost.ts` L189, L196 |
| R9 | `killTree` ghi thống kê đúng | 📖 `lib/corehost.ts` L512 |
| R10 | Redact secret variants (base64/URL-encoded) | 📖 `lib/secrets.ts` L454 |
| R11 | Recent-index cập nhật khi append | 📖 `lib/corehost.ts` L974 |
| S5 | Self-install: gate env, destructiveHint, atomic, manual default | 📖 `lib/self-install.ts` L161, L185 |
| S3 | Pending approval store + CLI `--approve` | 📖 `lib/approvals.ts`, `scripts/approve.ts` |

---

## 2. Còn mở

### P0 / P1 — bảo mật

| ID | Mức | Vấn đề | Bằng chứng |
|----|-----|--------|-----------|
| S3 (phần còn lại) | P0 | Elicitation channel mặc định; model không tự duyệt khi `VENIRA_SHELL_AUTO_APPROVE_TOKEN=0` | 📖 `tools/project.ts` L689–790 |
| S5 (JSONC parser) | P1 | Dùng `jsonc-parser` giữ comment, test fixture thật | ✅ `lib/self-install.ts`, verify fixture |

### P1 / P2 — độ tin cậy

| ID | Vấn đề | Trạng thái |
|----|--------|-----------|
| R8 (phần còn lại) | `VENIRA_AUDIT_STRICT=1` fail-closed, retention + VACUUM định kỳ | 📖 |
| R3 (retry rename) | Retry `rename` EPERM/EBUSY trên Windows | ❓ |

### P1 — kiểm thử, CI, vệ sinh

| ID | Vấn đề | Bằng chứng |
|----|--------|-----------|
| T2 | `verify` chạy > 250 s, workspace tạm | ✅ workspace tạm; verify xanh trên Windows/Node 24 (intermittent native cleanup đã được ghi nhận) |
| T3 | Thêm `.github/workflows/ci.yml` ma trận ubuntu/windows × Node 20/22 | ❓ |
| T4 | `scripts/policy-corpus.json` + runner, ≥ 250 ca | ✅ 255/255 deterministic cases |
| D4 | Refactor `tools/project.ts`, `corehost.ts`, `shell-policy.ts` tách file < 600 dòng | ✅ shell-policy đã tách; corehost đã tách helper file/search phase 1; project.ts còn giữ nguyên để tránh coupling |
| D1 | `TODO.md` cập nhật v1.7.0 status | ✅ |

---

## 3. Lộ trình

### Phase 0.1 — GitHub auth + provider secret guard (đang làm, chưa phát hành)
- [x] **S16** — hồi quy trực tiếp và qua MCP cho `cat .env` bị deny và `git push --no-verify` vẫn yêu cầu phê duyệt; test dùng data/vault tạm, không đọc vault thật; `npm run verify` trả exit code khác 0 khi assertion lỗi.
- [x] **S17** — GitHub Device Flow trong `project_github_connect`; token chỉ lưu local encrypted vault, không lộ cho model; có test mock cho pending/connected/refresh.
- [x] **S18** — CLI `--setup-github` nhập PAT với terminal echo tắt và xác nhận trước khi lưu.
- [x] **S19** — Secretlint quét request/response provider, kiểm tra giá trị secret đã biết, fail-closed; test `npm run test:provider-secret-guard`.
- [x] Gộp hồi quy OAuth + secret guard + shell-security vào `npm run verify`.
- [ ] Chạy build/verify xanh trên CI trước khi phát hành sau các pentest fixes.

### Phase 0 — Hotfix v1.7.1 (làm trước, phát hành riêng)
- [x] **S3** — mặc định trả `approval_id`; human chạy `npx venira-mcp --approve <id>` trong terminal tương tác. Giữ cờ `VENIRA_SHELL_AUTO_APPROVE_TOKEN=1` cho legacy (ghi rõ rủi ro). (S)
- [x] **S11 mở rộng** — shared path guard bảo vệ `.env*`, `*.pem`, `.npmrc`, `.git-credentials`, private keys, `VENIRA_DATA_DIR`; shell policy có `ask.read_outside_workspace`. (M)
- [x] **S5 JSONC** — dùng `jsonc-parser` giữ comment, `dry_run` mặc định, `destructiveHint:true`, và test fixture thật. (M)
- [x] **T5** — chuẩn hóa `scripts/git-mocks.ts` và thêm `check:source-shape` vào CI để file source > 2 KB không bị nén thành một dòng. (S)
- [x] **T1** — `verify` lấy tool count từ danh sách thực, bỏ qua test PowerShell ngoài Windows, dùng workspace tạm. (M)
- [x] **D1** — đồng bộ README/`TODO.md` về số tool, bản hiện tại và native dependency. (S)
- [x] Bump `1.7.1`, ghi mục **Security** trong changelog.

**Xong khi:** các ca ở Phụ lục A cho đúng tier; `npm run verify` xanh trên Linux (< 2 phút); model không tự duyệt được ở cấu hình mặc định.

### Phase 1 — Policy v2 + duyệt bởi người (v1.8.0)
- [ ] Parser riêng theo shell (`posix`, `powershell`, `cmd`), giữ `\` trong đường dẫn Windows (**S13**). (L)
- [x] **S12** — bind duyệt vào `hash(command + shell + cwd + sorted(secret_env))`; session grant TTL ngắn, không áp cho `network_access` / `git_history_rewrite`. (S)
- [x] Luồng **pending approval**: server trả `approval_id`; duyệt qua elicitation hoặc CLI `npx venira-mcp --approve <id>`; audit ghi `approver` thật. (L) — **đã có CLI --approve, pending store**
- [x] Thống nhất README ↔ code cho `docker rm/stop` và `git push`: `ask`. (S)

### Phase 2 — Toàn vẹn & độ tin cậy (v1.9.0)
- [x] **R8** — `VENIRA_AUDIT_STRICT=1` → fail-closed; retention (`VENIRA_AUDIT_KEEP_DAYS`, mặc định 90) + `VACUUM` định kỳ; cột `prev_hash`/`row_hash` (hash-chain) để phát hiện sửa dữ liệu, thêm `project_read_audit verify=true`. (M)
- [x] **R3** — khoá khi ghi `secrets.json` (lockfile `wx` + stale-timeout) + retry `rename` (EPERM/EBUSY trên Windows). (M)
- [x] **R5–R11** — đã kiểm tra và triển khai các mục R4–R11. (M mỗi mục)
- [x] Audit phần chưa xem: `opSearch` giới hạn glob/regex complexity; snapshot restore validates manifest header, paths, hashes and sizes before use. `project_execute_js` remains explicitly gated, uses Node filesystem permissions scoped to the workspace with child-process/worker permissions denied, and is documented as containment rather than a sandbox. (M)
- [x] Pentest sâu bổ sung: symlink alias không đọc được protected files; Node script executions và mọi `secret_env` injection cần human approval; output redaction được ghi rõ là best-effort. (M)

### Phase 3 — Refactor để dễ bảo trì (song song Phase 2)
- [ ] Tách `tools/project.ts` thành `tools/{fs,shell,git,secret,snapshot,diag}.ts` + `tools/index.ts` đăng ký; mỗi file < 600 dòng. (L)
- [ ] Tách `corehost.ts`: `audit.ts`, `shell-runner.ts`, `file-ops.ts`, `search.ts`. (L)
- [x] Tách `shell-policy.ts`: tokenizer, parser, rule data, và evaluator độc lập; facade giữ API tương thích. (M)
  - [x] `shell-tokenizer.ts` đã tách; `shell-policy.ts` vẫn re-export `tokenize` để giữ compatibility.
  - [x] `shell-parser.ts` chứa segment/redirect parsing.
  - [x] `shell-policy-rules.ts` chứa rule data và `shell-policy-evaluate.ts` chứa evaluator; các rule closure nhạy cảm vẫn được truyền từ facade để giữ nguyên dependency và thứ tự đánh giá.
- [x] Giữ test xanh sau mỗi lần tách; không đổi hành vi.

### Phase 4 — CI & phát hành
- [x] `.github/workflows/ci.yml`: ma trận `ubuntu-latest` + `windows-latest` + `macos-latest` × Node 20/22; chạy `build`, `verify`, `doctor`, `smoke`, policy corpus, `npm audit`. (S)
- [x] `scripts/policy-corpus.json` + runner; 255 deterministic cases pass, including platform-shaped variants and false-positive regressions. (M)
- [x] Test riêng: `expected_sha256`, write-result integrity, CRLF/BOM, self-install JSONC workspace/data-dir isolation, and approval binding for command/cwd/secret_env. (M)
- [x] Release workflow chạy `npm ci`, build, verify, package và `npm publish --provenance` qua OIDC khi push tag `v*`. (S)
- [x] **D3** — dọn gốc repo: xoá `*.tgz`, `*.log`, `*.err`; chuyển file nháp vào `docs/archive/`, script dev vào `scripts/dev/`; sửa `.gitignore` (`section*.txt`, bỏ `/` cuối). (S)
- [ ] Đồng bộ mirror Glama (đang hiện bản cũ). (S)

### Phase 5 — Tính năng mới (sau khi xong P0–P1)
1. `project_apply_patch` (unified diff nhiều file, atomic, `dry_run`, tự snapshot). (L)
2. `dry_run` cho write/edit/delete. (M)
3. `project_move` / `project_copy`. (S)
4. Shell streaming (`since_offset`, `stdin`). (M)
5. Tự snapshot trước chuỗi sửa lớn (`VENIRA_AUTO_SNAPSHOT=1`). (M)
6. Symbol bằng tree-sitter (WASM) thay regex. (L)
7. Search dùng `rg` nếu có. (M)
8. Mở rộng `project_explain_error` (tsc, eslint, vitest, cargo, dotnet, pwsh). (M)
9. MCP resources/prompts cho `audit` và `health`. (M)
10. Ảnh Docker "sandbox" không mạng. (M)
11. Cấu hình theo dự án an toàn: `.venira/project.json` chỉ được **thu hẹp** quyền (thêm deny/ask), không bao giờ nới. (M)
12. Telemetry cục bộ: báo cáo p50/p95 theo tool kèm tỉ lệ `ask/deny` để chỉnh policy. (S)

---

## 4. Kế hoạch phát hành

| Bản | Nội dung | Điều kiện |
|-----|----------|-----------|
| **1.7.1** | Phase 0 | verify xanh trên Linux, Phụ lục A đúng tier |
| **1.8.0** | Phase 1 | Corpus ≥ 250 ca xanh trên Windows + Linux |
| **1.9.0** | Phase 2 (+ Phase 3 dần) | Test atomic/CRLF/khoá secret xanh |
| **1.9.x** | Phase 4 | CI ma trận bắt buộc |
| **2.0.0** | Phase 5 chọn lọc | Có migration note |

---

## Phụ lục A — Corpus hồi quy (cột "Hiện tại" đo trên v1.7.0, `shell: bash`)

| Lệnh | Hiện tại | Mong đợi |
|------|----------|----------|
| `npm run build && curl http://x` | ask (network_access) ✅ | ask |
| `echo a && git push --force` | ask (git_history_rewrite) ✅ | ask |
| `git status && git reset --hard` | ask ✅ | ask |
| `git status⏎curl http://x` | ask ✅ | ask |
| `echo $(curl http://x)` | ask (command_substitution) ✅ | ask |
| `cat ~/.ssh/id_rsa` | deny (protected_file_access) ✅ | deny |
| `ls 2>&1` | allow ✅ | allow *(không chặn nhầm)* |
| `powershell -ec ZQBj` | ask ✅ | ask (`dynamic_execution`) |
| `bash -lc 'curl x'` | ask ✅ | ask |
| `node -pe 'x'` | ask ✅ | ask |
| `command curl http://x` / `env curl http://x` | ask ✅ | ask (`network_access`) |
| `find . -exec rm -rf {} +` | ask ✅ | ask |
| `git commit -m "mount point fix"` | allow ✅ | allow |
| `echo format c: >> notes.txt` | allow ✅ | allow |
| `xargs rm < list.txt` / `nohup curl x &` / `time curl x` / `find / -delete` | ❓ thử lại | ask |
| `Remove-Item -Recurse -Force C:\Users\x` *(win32)* | ❓ | ask |
| `edit_file {old_text:"", replace_all:true}` | invalid_request ✅ | invalid_request |
| `write_file {expected_sha256:"<sai>"}` | conflict ✅ | conflict |

## Phụ lục B — Giới hạn cần nói rõ với người dùng

- Policy phân tích chuỗi lệnh **không phải sandbox**: nó giảm rủi ro và tạo dấu vết; khi cần cách ly thật, dùng container / Windows Sandbox / VM.
- `project_execute_js` chạy ngoài policy shell và ngoài workspace lock — chỉ bật khi tin agent (đã tắt mặc định từ v1.7.0); khi bật, Node permission model giới hạn fs vào workspace và chặn child process/worker, nhưng đây vẫn không phải sandbox hoàn chỉnh.
- Redact secret chỉ khớp nguyên văn; không chống được lệnh biến đổi output (`| rev`, `| base64`).