# ROADMAP_APPROVAL — Tầng approval gọn, tường minh, an toàn

Trạng thái: 2026-11-06 · base v1.14.5 · mục tiêu v1.15.0 (có thay đổi phá vỡ tương thích, xem §7)

## 1. Mục tiêu

Ba trục, mỗi trục có tiêu chí kiểm được:

| Trục | Tiêu chí |
|---|---|
| **Gọn cho user** | Config mẫu ≤ 5 biến. Một biến `VENIRA_SECURITY_PROFILE` quyết định mức an toàn; biến lẻ chỉ là override nâng cao. |
| **An toàn** | Không đường nào để agent tự duyệt. Không mode nào bỏ hard-deny âm thầm (trừ `off`, phải bật có chủ đích, có cảnh báo + audit). |
| **Thuận tay cho agent** | Mọi yêu cầu duyệt trả cùng một payload; ≤ 1 round-trip sau khi người duyệt; biết trước lệnh nào sẽ bị hỏi. |

## 2. Hiện trạng (đã đối chiếu code v1.14.5)

Năm đường "duyệt" chồng nhau cho `project_shell_run`:

| # | Đường | Nơi code | Ghi chú |
|---|---|---|---|
| 1 | `approval_id` + CLI `--approve` | `lib/approvals.ts`, `scripts/approve.ts` | HMAC, một lần, gắn binding, cần TTY |
| 2 | Elicitation (`VENIRA_SHELL_ELICIT`) | `tools/project.ts` ~L903-1030 | Client UI, ghi grant hộ người dùng |
| 3 | `approval_token` legacy (`VENIRA_SHELL_AUTO_APPROVE_TOKEN`) | `lib/shell-policy.ts` L857-900, `corehost.ts` L2090-2175 | Agent tự redeem → bỏ người khỏi vòng lặp |
| 4 | Session approval trong RAM | `shell-policy.ts` `grantSessionApproval` | Nuôi bởi cả token lẫn grant |
| 5 | Override có allowlist | `VENIRA_SHELL_OVERRIDES` | `ALLOW_GIT_PUSH`, `ALLOW_ENV_READ` |

Vấn đề:

- **P1 (bảo mật)** `permissive` bỏ qua toàn bộ policy từ `a28dc7a` (v1.14.4): hard-deny (`sudo`, `self_approval`, `protected_file_access`…) không còn chạy. Code deny→ask ở `shell-policy-evaluate.ts` L93-128 thành code chết; README, test và commit `fafff27` mô tả hành vi khác.
- **P2** Năm cơ chế duyệt, hai cơ chế có thể bị agent dùng một mình (token, session từ token).
- **P3** Logic approval shell (`corehost.ts` L2089-2183) và JS (`tools/project.ts` L1991-2060) copy riêng, giống ~80%.
- **P4** Cờ rải rác: `SHELL_MODE`, `ALLOW_JS_EXEC`, `JS_EXEC_APPROVAL`, `SHELL_AUTO_APPROVE_TOKEN`, `SHELL_ELICIT`, `SESSION_GRANT_RULES`, `SHELL_OVERRIDES`, `ALLOW_SELF_INSTALL`, `SECRET_ALLOW_REVEAL`; README từng ghi sai mặc định.
- **P5** Hướng dẫn cho agent mâu thuẫn: `lib/output.ts` L340 và `lib/diagnostics.ts` L136 vẫn bảo dùng `approval_token`.
- **P6** `project_install_self` dùng nhãn `[approval_required]` nhưng chỉ là cờ operator, không có `approval_id` → agent chờ một thứ không bao giờ tới.

## 3. Bất biến (không phase nào được phá)

- **I1** Agent không tự cấp grant: grant chỉ do CLI (có TTY) hoặc elicitation (UI của client) ghi.
- **I2** Grant ký HMAC, một lần, gắn session + binding đúng lệnh/code. Scope `session` do người quyết, chỉ áp cho rule trong `VENIRA_SESSION_GRANT_RULES`.
- **I3** Deny là deny. Chỉ mode `off` được bỏ hard-deny; `off` phải ghi audit, in cảnh báo stderr lúc khởi động và hiện trong `project_health.warnings`.
- **I4** `secret_env` luôn hỏi, mọi mode kể cả `off`.
- **I5** Thiếu config = `balanced` + JS tắt + JS có duyệt.
- **I6** Một mô hình duy nhất: Gate → Request → Grant → Redeem, mọi tool dùng chung.

## 4. Thiết kế đích

### 4.1 Mode shell

| Mode | Hành vi |
|---|---|
| `strict` | Chỉ allowlist read-only/workspace-local chạy tự do; còn lại hỏi; hard-deny từ chối |
| `balanced` (mặc định) | Lệnh an toàn chạy; ask rule và lệnh chưa phân loại hỏi; hard-deny từ chối |
| `permissive` | Như `fafff27`: hard-deny → **hỏi**; ask rule → cho chạy; không có gì chạy âm thầm qua hard-deny |
| `off` (mới) | Không kiểm tra gì. Cảnh báo + audit, chỉ cho môi trường tin cậy |

### 4.2 Một lõi approval

`lib/approval-gate.ts` với `requestApproval(gate, subject)` và `redeemApproval(gate, id, subject)`. Shell, JS dùng chung; binding khác nhau theo `gate`. `install_self` và `reveal` là cờ operator, không phải approval từng lần: đổi mã lỗi thành `[feature_disabled]` + hint "operator cần đặt VENIRA_…=1".

### 4.3 Một nguồn grant

Chỉ grant đã verify (CLI hoặc elicitation) mới nuôi session-allow trong RAM. Bỏ `approval_token`, `VENIRA_SHELL_AUTO_APPROVE_TOKEN`, và đường nạp session từ token.

### 4.4 Payload chuẩn cho agent

Mọi `[approval_required]` trả `data.approval`:

```jsonc
{ "approval_id": "…", "gate": "shell|js", "rule": "ask.network_access",
  "reason": "…", "subject_preview": "…", "expires_at": 0,
  "approve_command": "npx venira-mcp --approve <id>",
  "retry_with": { "tool": "…", "arguments": { "…": "…", "approval_id": "<id>" } } }
```

### 4.5 Cấu hình gọn: `VENIRA_SECURITY_PROFILE`

| Profile | Shell mode | JS approval | Ghi chú |
|---|---|---|---|
| `strict` | `strict` | bật | |
| `balanced` (mặc định) | `balanced` | bật | |
| `trusted` | `permissive` | bật | máy cá nhân |
| `off` | `off` | tắt | cảnh báo to |

`VENIRA_ALLOW_JS_EXEC` vẫn tách riêng (quyền có tool hay không). Biến lẻ (`SHELL_MODE`, `JS_EXEC_APPROVAL`…) vẫn ghi đè profile; gộp mọi biến lẻ vào một bảng "Advanced" trong README.

### 4.6 Workflow cho agent

- (a) Payload chuẩn §4.4.
- (b) `approval_wait_ms` (≤ 45 000) trên `project_shell_run` / `project_execute_js`: tạo pending, chờ grant, chạy luôn trong cùng call → bỏ một round-trip.
- (c) `dry_run: 1` trên `project_shell_run`: trả tier + rule, không chạy → agent biết trước lệnh nào sẽ bị hỏi.
- (d) `project_health.approvals`: profile, mode, elicit, session rules, warnings.
- (e) Luật cho agent (README §9, `server.ts` INSTRUCTIONS): khi gặp `approval_required` → dừng, báo người dùng `approval_id` + lệnh, không lặp, chỉ retry một lần sau khi người xác nhận.

## 5. Lộ trình

### Phase 0 — Đối chiếu README ✅
- [x] Sửa mặc định/số tool/danh sách luật, thêm mục Approvals (§7 README), `check:docs` pass

### Phase 1 — Vá hồi quy mode (xử lý P1) ✅ (2026-11-06)
- [x] `ShellMode` thêm `off`; `normaliseMode` + thông báo lỗi + `native-adapter-types.ts` nhận `off`
- [x] `shell-policy-evaluate.ts`: `off` → allow sớm; `permissive` bỏ early-return, dùng lại nhánh deny→ask / ask rule→allow
- [x] `off`: cảnh báo stderr lúc khởi động (`loadShellPolicy`). Audit: mỗi lệnh ghi rule `off.pass` trong decision; `project_health.warnings` làm ở Phase 3
- [x] Test (`scripts/verify.ts`): `permissive`+`sudo` → ask; `permissive`+`approval.key` (self_approval) → ask; `off`+`sudo` → allow; `balanced`/`strict`+`sudo` → deny; `off` hợp lệ, giá trị lạ bị từ chối
- [x] README: mô tả `permissive` và `off` đúng (config mẫu để Phase 4)
- Ghi chú: `verify` từng phụ thuộc env shell cha (`VENIRA_SHELL_MODE`, `VENIRA_UNRESTRICTED=1` làm 1–3 check unit sai). Đã ghim mode trong verify.ts; `UNRESTRICTED` vẫn đọc lúc import → chạy verify với `VENIRA_UNRESTRICTED=0`.

### Phase 2 — Gom code approval (P2, P3, P5, P6) ✅ (2026-11-06)
- [x] 2a Tách `lib/approval-gate.ts`, shell + JS gọi chung (refactor thuần; `requestApproval`/`redeemApproval` dùng ở `corehost.ts` và `tools/project.ts`, build + verify 430 xanh)
- [x] 2b Bỏ `approval_token`, `AUTO_APPROVE_TOKEN`, đường session từ token; param cũ trả lỗi hướng dẫn (shell: `corehost.ts`, `shell-policy.ts`, schema `tools/project.ts`; env cũ → cảnh báo + bỏ qua)
- [x] 2c Sửa `output.ts` (hint `approval_required`/`approval_invalid`), `diagnostics.ts`, `shell-policy.ts` header comment
- [x] 2d `install_self` / `reveal`: mã lỗi `[feature_disabled]` (code + hint mặc định + test `install_self_feature_disabled`, `secret_reveal_gated`)

### Phase 3 — Payload và workflow agent (§4.4, §4.6) ✅ (2026-11-06)
- [x] `data.approval` chuẩn cho shell + JS (`buildApprovalPayload` trong `lib/approval-gate.ts`; test `approval_payload_shell_shape`, `approval_payload_js_shape`)
- [x] `project_health.approvals` + `warnings` (`approvalsHealth()` trong `tools/project.ts`; test `health_approvals_section`)
- [x] `dry_run` cho `project_shell_run` (không chạy, không tạo pending; test `shell_dry_run_*`)
- [x] `approval_wait_ms` cho shell + JS, kẹp ≤ 45 000 ms (test: grant trong lúc chờ chạy cùng call, single-use, timeout trả pending, clamp)
- [x] Luật agent trong README §9 (rule 9) và `server.ts` INSTRUCTIONS
- Kết quả: build + `verify` 440 check + `test:shell-security` + `check:docs` đều xanh.

### Phase 4 — Cấu hình gọn (P4) ✅ (2026-11-06)
- [x] `VENIRA_SECURITY_PROFILE` + bảng mapping, biến lẻ ghi đè (`lib/security-profile.ts`, `shell-policy.ts`, `workspace.ts`)
- [x] `self-install.ts` ghi profile thay vì nhiều biến; `doctor` kiểm profile + cảnh báo `off`
- [x] README: config mẫu 4 biến, bảng profile và `Advanced` overrides

### Phase 5 — Docs, test, release
- [x] Sync `SECURITY.md`, `shell-security.md`, `TODO.md`, and README changelog with profile and approval behavior
- [x] Local `npm run build`, `npm run verify` (445 checks, including `test:shell-security`), `npm run test:policy-corpus` (270/270), `npm run check:docs`, and `npm run doctor` (14/14) pass
- [x] Prepare v1.15.0 and synchronize `package.json`, `package-lock.json`, and `lib/version.ts`
- [x] Remote CI passed on Linux/Windows/macOS with Node 20/22; release workflow #63 succeeded for commit `ff744f0`
- [x] Publish tag `v1.15.0`, GitHub Release, npm package `venira-mcp@1.15.0` (registry HTTP 200), and Docker release

## 6. Ma trận test tối thiểu

| Chủ đề | Kỳ vọng |
|---|---|
| Hard-deny theo mode | `strict`/`balanced` deny · `permissive` ask · `off` allow |
| Self-approval | `--approve` từ shell agent bị chặn ở mọi mode trừ `off`; CLI vẫn từ chối khi không có TTY |
| Binding | Đổi lệnh/shell/cwd/`secret_env` → `binding_mismatch` |
| Một lần | Dùng lại `approval_id` → `already_used` |
| Hết hạn | Quá TTL → `expired` |
| Scope | `session` chỉ cho rule trong danh sách; tham số của model không mở rộng grant |
| Legacy | Không còn `approval_token` trong response; param cũ báo lỗi rõ |
| `secret_env` | Luôn hỏi, kể cả `off` |
| JS exec | Cần `ALLOW_JS_EXEC=1`; duyệt từng call; binding theo code + argv |
| Payload | Shell và JS cùng shape `data.approval` |
| Profile | Mỗi profile → đúng mode + JS approval; biến lẻ ghi đè |

## 7. Rủi ro và migration

- Bỏ `approval_token` là thay đổi phá vỡ: client dùng token sẽ nhận lỗi hướng dẫn chuyển sang `approval_id`. `VENIRA_SHELL_AUTO_APPROVE_TOKEN` còn đặt thì **cảnh báo và bỏ qua** (hướng an toàn hơn), không làm server hỏng khi khởi động.
- Config đang dùng `permissive` sẽ bắt đầu bị hỏi với lệnh hard-deny; ai muốn hành vi cũ đặt `off` (hoặc `VENIRA_SECURITY_PROFILE=off`).
- Repo release dày (v1.14.2 → v1.14.5 trong vài phút): mỗi phase là một commit riêng, trước mỗi phase `project_snapshot`; sửa file bằng `guard=sha256`.

## 8. Quyết định

Đã chốt (2026-11-06): `permissive` trở về deny→ask · `off` là mode riêng · bỏ token legacy · một lõi approval dùng chung · tên profile là `trusted`.

Còn mở: `VENIRA_SHELL_ELICIT` tự bật khi client hỗ trợ elicitation · giới hạn `approval_wait_ms` theo timeout của từng client.
