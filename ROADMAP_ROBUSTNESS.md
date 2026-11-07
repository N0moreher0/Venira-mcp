# ROADMAP_ROBUSTNESS — venira-mcp (độ bền, bề mặt cấu hình, bằng chứng bảo mật)

> Tạo 2026-11-07, nền là v1.17.0 (commit `3285016`); **rev 2–5** cùng ngày (rev 5: hoàn tất RB5 trong `doctor`/`project_health`, xóa `VENIRA_NETWORK` khỏi README vì cấu hình đã bị loại; rev 4: chốt Expert = 43 và đồng bộ README/`check-docs.ts`, bỏ biến khỏi RB12; rev 3: thông báo giới hạn đã vào README; rev 2: sửa theo review: thống nhất số tool, ánh xạ profile → shell mode, bổ sung ca bypass, làm rõ RB6/RB8, sửa chú thích `.gitignore`). Nguồn: một bản nhận xét kỹ thuật bên ngoài (meta.ai) được **đối chiếu lại với code, test và số đo thật** trước khi đưa vào đây. Mục nào ngoài nhận xét mà tìm thấy khi đối chiếu cũng được ghi lại.
> Mức độ: **P0** làm ngay · **P1** làm sớm · **P2** cải thiện. Cỡ việc: **S** < 2h · **M** ~1 ngày · **L** nhiều ngày.
> Nhãn: ✅ đã đo/chạy trên bản này · 📖 chỉ đọc code · ❓ chưa kiểm.
> File này bổ sung cho `ROADMAP.md` (Phase A–G) và `ROADMAP_HARDENING.md` (Phase 0–5); không lặp lại việc đã xong ở đó. Ghi chú: `ROADMAP.md` và `ROADMAP_HARDENING.md` nằm trong `.gitignore` (ghi chú riêng của chủ dự án); file này mặc định chưa bị ignore, xem câu hỏi O6.

---

## 0. Kết quả đối chiếu nhận xét bên ngoài

| # | Nhận xét | Đối chiếu (✅/📖) | Kết luận |
|---|---|---|---|
| 1 | Quá nhiều biến cấu hình (~60), dễ ra tổ hợp nguy hiểm như `UNRESTRICTED=1` + profile `off` + `ALLOW_JS_EXEC=1` | ✅ Có **91** tên `VENIRA_*` khác nhau trong source (`lib/`, `tools/`, `server.ts`); `check:docs` chỉ theo dõi 40 biến có tài liệu. 📖 Profile `strict/balanced/trusted/off` đã có; gõ sai profile thì `[config_invalid]`; override `VENIRA_SHELL_MODE` / `VENIRA_JS_EXEC_APPROVAL` thắng profile. Shell mode `off` có cảnh báo khi chạy, `doctor` có `warn` cho profile `off`, `project_health` có cảnh báo khi JS exec bật mà không cần duyệt. | **Đúng, và số biến còn nhiều hơn họ nói.** Chưa có chỗ nào đánh giá **tổ hợp** các cờ; mỗi cờ chỉ cảnh báo riêng lẻ. |
| 2 | Không có sandbox thật | 📖 `README.md` §approvals, `SECURITY.md`, `ROADMAP_HARDENING.md` Phụ lục B đã ghi "guard rail, not a sandbox", khuyên dùng container/VM. | **Đúng về kiến trúc, nhưng repo đã thừa nhận.** Điểm yếu là lời cảnh báo nằm sâu trong tài liệu, không ở màn hình đầu hay trong output của `doctor`/`health`. |
| 3 | `better-sqlite3` native dễ lỗi cài | 📖 `better-sqlite3@12.4.1` là dependency **cứng**, `import Database from "better-sqlite3"` tĩnh ở đầu `lib/corehost.ts`; `try/catch` trong `ensureAuditDb()` chỉ bắt lỗi **mở DB**, không bắt lỗi **load module**. CI có bước "Ensure better-sqlite3 native binding" cho Node 20/22. `engines`: Node ≥ 20. Máy dev chạy Node 24 nhưng **CI không có Node 24**. | **Đúng, là điểm đau DX lớn nhất.** |
| 4 | 42 tool, mặc định "full 42" | ✅ Mặc định là **32 tool**, Expert **43** (= 32 + 11 tool PR/CI trong `TOOL_MODE_EXCLUDES`; +1 với `VENIRA_ALLOW_JS_EXEC=1`), khớp lần đo ở Phụ lục A; README và `check-docs.ts` từng ghi 42 (sửa ở rev 4, xem F4); có `VENIRA_PROFILE=core`. Số đo `tools/list` ở Phụ lục A: Default ≈ **68.6 KB ≈ 17k token**, core ≈ 13.4k, Expert ≈ 24k. | **Số "42 mặc định" sai, nhưng vấn đề context có thật:** chi phí cố định ~17k token mỗi phiên ở mặc định. |
| 5 | Thiếu bằng chứng độ bền (bypass, replay, fuzz) | ✅ `npm run verify` = 507 check; `policy-corpus` = **271 ca**; `test:shell-security` (đọc `.env`, protected path, bypass hook `git push`, override sai phạm vi kể cả qua symlink); test approval dùng một lần (shell, wait-grant, JS exec) và test sửa pending approval làm MAC sai (`scripts/verify.ts`). CI ma trận 3 OS × Node 20/22. | **Phần lớn nhận xét này sai: bằng chứng đã khá nhiều.** Nhưng còn **lỗ hổng cụ thể** (Phụ lục B): corpus 271 ca có 0 ca cho `iex`/`Invoke-Expression`, `FromBase64String`, tên 8.3, `\\?\`, ADS (`::$DATA`), ký tự không-ASCII, escape `^` của cmd, here-string, `Start-Process`; chỉ 3 ca cho `-EncodedCommand`. Chưa có fuzz, chưa có số coverage, chưa thấy test approval hết hạn / khác phiên / đua hai lần tiêu thụ. |

Phát hiện thêm khi đối chiếu (không có trong nhận xét):

- **F1 ✅** Instance Venira đang dùng để phát triển chạy với `VENIRA_UNRESTRICTED=1`, `VENIRA_SHELL_MODE=off`, `VENIRA_ALLOW_JS_EXEC=1`, `VENIRA_JS_EXEC_APPROVAL=0` (và vài cờ phụ khác) — chính là tổ hợp mà nhận xét #1 cảnh báo. Đây là môi trường tin cậy của chủ dự án nên chấp nhận được, nhưng nó cho thấy tổ hợp này **xảy ra thật** và hiện không có gì phân biệt "cố ý" với "copy cấu hình".
- **F2 📖** `ci.yml` không có Node 24 và không có job mô phỏng "cài mới trên máy không build được native".
- **F3 📖** Fix `isProtectedPath` của v1.17.0 (cache 2 s) **chưa có test riêng** (đổi env có hiệu lực ngay, hết TTL, symlink hoán đổi trong TTL).
- **F4 ✅📖 (đã giải quyết ở rev 4)** Số tool Expert không nhất quán giữa các nguồn: `scripts/check-docs.ts` đặt `EXPECTED_EXPERT_TOOLS = 42` (README: 42, hoặc 43 với JS exec); `scripts/doctor.ts` đặt `expectedTools = 43` kèm ghi chú "expert mode exposes 43 tools"; đo `tools/list` với env sạch (Phụ lục A) ra Expert = 43 và 44 khi bật JS exec. README §5 cũng liệt kê `project_ci_*` mà thiếu `project_ci_control` (thêm ở v1.16.0; đã bổ sung vào README §5 ở rev 2). ✅ Kết luận: `TOOL_MODE_EXCLUDES.default` trong `tools/project.ts` loại đúng 11 tool (5 `project_ci_*` gồm `project_ci_control`, và 6 `project_pr_*`), `expert` không loại tool nào, nên Expert = 32 + 11 = 43 (44 với JS exec), khớp lần đo và `doctor.ts`. Con số 42 trong README và `check-docs.ts` là cũ, nhiều khả năng do chưa tính `project_ci_control` (thêm ở v1.16.0); đã sửa thành 43/44 ở rev 4.

---

## 1. Nguyên tắc

1. **Test trước, sửa sau.** Mỗi mục bảo mật bắt đầu bằng test ghi lại hành vi hiện tại; chỉ sau khi chủ dự án chọn tier/kết quả mong muốn mới sửa code.
2. **Không đổi hành vi mặc định (`balanced`, `UNRESTRICTED=0`)** trừ khi mục đó ghi rõ và có ghi chú migration.
3. **Không thêm/bớt/đổi tên tool** trong các mục này; số tool là hợp đồng (Default 32 / Expert 43, +1 với JS exec; xem `check-docs.ts`, `doctor.ts`, README §4.0).
4. **Khẳng định phải có số.** Không ghi "đã bền/đã an toàn" nếu chưa có test hoặc số đo đi kèm.
5. **Thay đổi hành vi bảo mật đi từ cảnh báo → từ chối**, ở hai bản phát hành khác nhau, để người dùng có thời gian sửa cấu hình.

---

## 2. Phase 1 — Bằng chứng trước (P0, không đổi hành vi người dùng)

### RB1 — Bộ test bypass có bảng dữ liệu (`test:bypass`) · P0 · L

**Vấn đề.** Corpus hiện tại tốt cho hồi quy đã biết nhưng thiếu cả họ kỹ thuật (xem Phụ lục B). Reviewer kỹ thuật sẽ soi phần này đầu tiên.

**Mục tiêu.** Một harness table-driven chạy < 60 s, mỗi ca có `id`, `category`, `input`, `expected`, `status`, `note`. `status`:
- `enforced`: hành vi hiện tại đúng mong muốn; test fail nếu hành vi lỏng đi.
- `known_gap`: hành vi hiện tại **chưa** đúng mong muốn; test ghi lại hành vi hiện tại và fail khi nó **thay đổi** (để khi sửa, ca được đẩy lên `enforced` có chủ ý).

**Thiết kế.** `scripts/test-bypass.ts` + dữ liệu `scripts/bypass-cases/{paths,shell,two-step}.json` (+ `.ts` cho ca cần sinh động, vd symlink). Thêm `npm run test:bypass`, đưa vào chuỗi `verify` và `ci.yml`. Ca riêng cho từng nền tảng gắn `platform: win32|posix`; symlink dùng junction (`mklink /J`) trên Windows vì không cần đặc quyền.

**Bước 0 (đo trước).** Chạy toàn bộ ca ứng viên trên bản hiện tại, sinh báo cáo "hành vi thật". Chủ dự án duyệt tier mong muốn cho từng ca rồi mới khóa `expected`.

**Nhóm ca (ứng viên, chưa phải danh sách cuối):**

*A. Đường dẫn (file tools, `UNRESTRICTED=0`; mỗi ca chạy qua `read_file`, `write_file`, `edit_file`, `delete_path`, `search`, `list_files`, `read_batch`, `diff_files`, `get_file_info`, `recent_files`)*
- A1 traversal: `../x`, `..\x`, `a/../../x`, phân tách lẫn lộn, `./../`.
- A2 tuyệt đối ngoài workspace; UNC `\\server\share\x`; `\\?\C:\...`; `\\.\` device.
- A3 riêng Windows: dấu chấm/khoảng trắng cuối tên, ADS (`.env::$DATA`), tên dành riêng (`CON`, `NUL`), tên 8.3 (`PROGRA~1`, thư mục data dir ngắn), hoa/thường (`.ENV`, `Approval.KEY`).
- A4 symlink/junction trong workspace trỏ ra ngoài; trỏ vào data dir hoặc kho snapshot; ghi xuyên qua thư mục symlink; **hard link** trong workspace tới file được bảo vệ (`.env`, `approval.key`): kiểm tra theo tên sẽ lọt, cần kiểm theo inode/file id (Windows: `mklink /H`).
- A5 mục tiêu được bảo vệ: `.env`, `.env.*`, `id_rsa*`, đuôi trong `PROTECTED_EXTENSIONS`, `approval.key`, `secrets.json`, `venira.db-*`, data dir, kho snapshot.
- A6 TOCTOU kiểm tra rồi hoán đổi: chỉ **ghi nhận** (`known_gap`, tài liệu hóa giới hạn).
- A7 riêng Linux/WSL: `/proc/self/root/...`, `/proc/self/cwd/...`, `/dev/fd/N`; đường dẫn WSL `\\wsl$\...` từ Windows.
- A8 riêng macOS (`platform: darwin`): APFS mặc định không phân biệt hoa/thường (`.ENV`, `Approval.KEY`) và chuẩn hóa Unicode NFD/NFC (cùng một tên ghi bằng hai dạng Unicode khác nhau).

*B. Shell (`evaluateShellCommand`, 3 mode × 3 shell)*
- B1 dấu phân cách: `;`, `&&`, `||`, `|`, xuống dòng/CRLF, backtick, `$()`, `<()`, `&`.
- B2 che chắn chuỗi: `c"u"rl`, `cu''rl`, `c\url`, `$u`/`${IFS}`, `%COMSPEC%`, escape `^` của cmd, wildcard `/???/c?rl`, hoa/thường trên Windows.
- B3 PowerShell: `-EncodedCommand`/`-enc`/`-ec` (mã hóa lệnh lành và lệnh nguy hiểm), `iex`/`Invoke-Expression`, `[Convert]::FromBase64String`, `Start-Process`, toán tử `&` và `.`, here-string, `Add-Type`, `-Command` lồng nhau, `-File`.
- B4 bọc lệnh: `cmd /c`, `bash -c`, `sh -c`, `env`, `command`, `sudo`, `xargs`, `find -exec`, `nohup`, `timeout`, `start /b`.
- B5 truy cập file được bảo vệ: `type`, `Get-Content`/`gc`, `cat`, `more`, redirect `<`, glob `.e?v`/`.en[v]`, tên 8.3, `copy .env x`, `Compress-Archive`.
- B6 mạng/tải về thay thế: `wget`, `iwr`, `Invoke-WebRequest`, `certutil -urlcache`, `bitsadmin`, `ncat`.
- B7 git: `push --force`, `-C`, `-c core.hooksPath`, `-c alias.x=!cmd`, `--exec-path`, ghi `git config`.
- B8 lộ biến môi trường: `printenv`, `set`, `Get-ChildItem env:`, `echo $env:X` (kèm giới hạn đã biết: redact không chống `| rev`, `| base64`).

*C. Hai bước "ghi rồi chạy" (`two-step`)*: ghi script bằng `write_file` rồi chạy `node x.js` / `powershell -File x.ps1` / `npm run <script>`; sửa `scripts` trong `package.json` rồi `npm run`. Policy chỉ thấy lệnh chạy, không thấy nội dung vừa ghi. Thêm các biến thể kinh điển: ghi `.git/hooks/pre-commit` rồi chạy `git commit`; ghi `.npmrc` hoặc `.vscode/tasks.json`. Hầu chắc chắn là `known_gap` ở lần đo đầu; xem RB13.

**Nghiệm thu.** (1) `npm run test:bypass` xanh trên Windows/Linux/macOS × Node 20/22/24; (2) báo cáo "hành vi thật" của bước 0 được lưu vào Phụ lục B của file này; (3) mọi `known_gap` có ID theo dõi (RBx hoặc mục trong `ROADMAP_HARDENING.md`); (4) không ca nào `enforced` mà để lọt đường dẫn/ lệnh chạm mục tiêu được bảo vệ.

**Rủi ro.** Một số ca sẽ lộ lỗ hổng thật → sửa là việc riêng (RB1b, tạo theo từng phát hiện), không gộp vào mục này. Ca symlink/junction có thể flaky khi dọn thư mục trên Windows (đã có tiền lệ ở `verify`), cần dọn thư mục tạm tách riêng.

---

### RB2 — Test approval: replay, hết hạn, khác phiên, đua · P0 · M

**Hiện có ✅:** approval dùng một lần (shell, wait-grant, JS exec), pending record có MAC (sửa `binding` làm MAC sai), binding gồm command/cwd/shell/secret_env.

**Cần thêm (mỗi ca là `check()` trong `verify.ts` hoặc file `scripts/test-approvals.ts`):**
1. Approval của lệnh A dùng cho lệnh B (cùng cwd/shell) → `approval_invalid`.
2. Cùng lệnh nhưng khác `cwd`, khác `shell`, khác `secret_env` → `approval_invalid`.
3. Khác phiên (`session_id` khác) → `approval_invalid`; kể cả với scope `session` đã được duyệt cho rule khác.
4. Nâng quyền scope: sửa bản ghi từ `once` sang `session` (và ngược lại) → MAC sai.
5. Hết hạn: ❓ **trước hết xác định** `approvals.ts` có TTL không. Nếu có → test hết hạn; nếu không → ghi nhận là quyết định thiết kế (O7) và test hành vi hiện tại.
6. Đua: hai tiến trình/hai lời gọi cùng tiêu thụ một `approval_id` → đúng một thành công (tính nguyên tử của "dùng một lần").
7. Lệnh bị `hard deny` không thể được duyệt dù có `approval_id` hợp lệ.
8. Khóa duyệt (`approval.key`) và kho pending nằm trong `isProtectedPath` qua mọi file tool.
9. Định dạng/entropy `approval_id` (không đoán được, không tái sử dụng sau khi tiêu thụ).

**Nghiệm thu.** Mỗi ca có tên check riêng, xuất hiện trong số check của `verify`; ca 5 hoặc có TTL + test, hoặc có quyết định O7 được ghi vào `SECURITY.md`.

---

### RB3 — Test cho cache protected roots (và SN6) · P0 · S

**Vấn đề (F3).** `canonicalProtectedRoots()` (v1.17.0, cache 2 s) chưa có test riêng; `ROADMAP_HARDENING.md` SN6 cũng đòi test cho `snapshot-paths`.

**Việc làm:**
- Đổi `VENIRA_DATA_DIR`, `VENIRA_SNAPSHOT_DIR`, `VENIRA_SNAPSHOT_ROOT` hoặc `WORKSPACE` giữa hai lần gọi → kết quả `isProtectedPath` phản ánh **ngay** (không chờ TTL).
- Sau TTL, root mới được tính lại; trong TTL, hoán đổi symlink dưới root là **giới hạn có chủ đích** (ghi `known_gap` + tài liệu).
- Hồi quy hiệu năng: 2000 lần `isProtectedPath` ≤ ngưỡng (đo 2026-11-07: 0.10 ms/lần; đặt ngưỡng rộng, ví dụ 1 ms/lần, để tránh flaky) — đưa vào `bench` hoặc `verify` ở dạng cảnh báo, không fail cứng.
- SN6: trùng tên workspace → hậu tố `-<hash8>`; cùng workspace viết khác kiểu đường dẫn (`C:\A`, `c:/a`, 8.3) → cùng một thư mục; env tương đối → `[config_invalid]`; snapshot root luôn là protected path.

**Nghiệm thu.** Test xanh; SN6 được đánh dấu xong trong `ROADMAP_HARDENING.md`.

---

### RB4 — Mô-đun "tư thế cấu hình" + cảnh báo tổ hợp (giai đoạn A, không chặn) · P0 · M

**Vấn đề.** Cờ rủi ro được đánh giá riêng lẻ ở nhiều file (`workspace.ts`, `shell-policy.ts`, `project.ts`, `doctor.ts`); không ai nhìn tổng.

**Thiết kế.**
- `lib/config-posture.ts` (không import từ `workspace.ts`/`shell-policy.ts` để tránh vòng, như `security-profile.ts`): hàm thuần `computePosture(env)` trả về:
  - `flags`: `unrestricted`, `shell_mode` (`strict|balanced|permissive|off`), `js_exec` (`disabled|approval|no_approval`), `env_pass_all`, `secret_reveal`, `overrides` (danh sách), `permission_mode`.
  - `level`: `normal` | `elevated` | `dangerous`.
  - `reasons[]`: mô tả ngắn từng yếu tố.
- Ánh xạ profile → shell mode (README §2): `strict→strict`, `balanced→balanced`, `trusted→permissive`, `off→off`; `VENIRA_SHELL_MODE` ghi đè profile. `computePosture` làm việc trên **shell mode đã giải**, không trên tên profile.
- Quy tắc ban đầu (chủ dự án duyệt, O1):
  - `dangerous` nếu `unrestricted` **và** `shell_mode=off`; hoặc `js_exec=no_approval` **và** (`unrestricted` **hoặc** `shell_mode=off`).
  - `elevated` nếu đúng một trong: `unrestricted`, `shell_mode ∈ {permissive, off}`, `js_exec=no_approval`, `env_pass_all`, `secret_reveal`, có override.
  - còn lại `normal`.
- Nơi dùng (giai đoạn A, **không chặn**): in một dòng banner ra stderr lúc khởi động khi `level != normal`; thêm `approvals.posture` vào `project_health`; `doctor` báo `warn` cho `elevated`, `fail` chỉ khi có cờ `--strict`; `self-install` ghi `balanced`/`UNRESTRICTED=0` như hiện nay.
- Cùng một hàm này được RB9 dùng để viết test ma trận và RB8 dùng để chặn ở giai đoạn B.

**Nghiệm thu.** Test thuần cho `computePosture` (bảng tổ hợp); `project_health` có trường mới; không đổi hành vi của bất kỳ tool nào; tool count không đổi.

---

### RB5 — Tuyên bố giới hạn ở màn hình đầu · P0 · S

**Việc làm:**
- 3–4 dòng ở **đầu** `README.md` — ✅ đã thêm ở rev 3. Mọi câu chỉ lấy từ điều `SECURITY.md` và README §7 đã nêu: chạy bằng quyền OS user; workspace lock giới hạn đường dẫn của file tool chứ không giới hạn tác dụng phụ của shell; prompt injection vẫn có thể điều khiển agent chạy lệnh mà profile cho qua; cùng OS user đọc được khóa trong `VENIRA_DATA_DIR`; cần cách ly thật thì dùng container/VM. Không viết "giảm rủi ro" hay "chống bypass" cho tới khi RB1 có số liệu.
- ✅ Cùng nội dung giới hạn xuất hiện trong output `doctor` và output `project_health` (trường `notice`).
- ✅ `check:docs` bắt buộc README có đoạn này và không còn liệt kê `VENIRA_NETWORK`.
- Liên kết sang `SECURITY.md`/`ROADMAP_HARDENING.md` Phụ lục B cho phần chi tiết.
- Số tool (F4): ✅ đã chốt ở rev 4 (Default 32 / Expert 43, +1 với JS exec) và đồng bộ README, `scripts/check-docs.ts`, `scripts/doctor.ts`. Không thêm/bớt/đổi tên tool nào.

**Nghiệm thu.** `check:docs` xanh; `doctor` in thông báo; không đổi số tool.

---

## 3. Phase 2 — Giảm điểm đau cài đặt và context (P1)

### RB6 — Audit store có fallback, bỏ phụ thuộc cứng vào native · P1 · L

**Vấn đề.** Nếu `better-sqlite3` không cài/load được, server không khởi động (import tĩnh). `npx` thất bại ở bước này là người dùng bỏ.

**Bước 0 — kiểm kê.** Liệt kê mọi chỗ dùng `auditDb`/`Database` trong `lib/corehost.ts` và nơi khác (insert, đọc `project_read_audit`, `verify=1` hash-chain, cache cột `auditColumns`, `UNIQUE(request_id)`, WAL, `VENIRA_AUDIT_FAST`). Kết quả kiểm kê quyết định độ lớn của interface.

**Thiết kế.**
- `lib/audit-store.ts`: interface nhỏ (`open`, `append(row)`, `query(filter)`, `verifyChain()`, `close`, `backend`), ba adapter:
  1. `better-sqlite3` (hiện tại, ưu tiên khi load được);
  2. `node:sqlite` (khi `process.versions.node` đủ mới; **kiểm trạng thái ổn định** trên từng phiên bản: module có từ Node 22.5, các bản 22.x đầu cần cờ `--experimental-sqlite` và Node 20 không có, nên thực tế chỉ dùng được trên Node mới; chốt phiên bản tối thiểu bằng test chứ không bằng trí nhớ; cảnh báo thử nghiệm của Node chỉ được in ra stderr, không bao giờ ra stdout của giao thức MCP);
  3. file JSONL có hash-chain (tận dụng `lib/audit-hash.ts`), chậm hơn nhưng không cần native. Việc ghi phải tuần tự hóa giữa các tiến trình (khóa file, tiền lệ: khóa `secrets.json`); nếu không, hai tiến trình cùng đọc hash cuối rồi cùng append sẽ làm gãy chuỗi (v1.16.2 và v1.17.0 đã phải sửa đúng loại lỗi fork này).
- Nạp bằng `import()` động trong `try/catch`, theo thứ tự trên; ghi backend đang dùng vào `project_health.audit.backend` và `doctor`.
- `package.json`: chuyển `better-sqlite3` sang `optionalDependencies` (giống `keytar`) để `npm install` không thất bại khi build native lỗi. **Đây là thay đổi hành vi cài đặt** → ghi vào changelog.
- Khi chỉ còn adapter JSONL: `doctor` báo `warn` (không `fail`), tool `project_read_audit` vẫn hoạt động.
- Hợp đồng chung: cùng một bộ test (`scripts/test-audit-store.ts`) chạy lần lượt trên **từng adapter** (chèn, `request_id` trùng bị từ chối, đọc có lọc, chuỗi hash đúng, phát hiện sửa/xóa hàng, hai tiến trình ghi đồng thời).

**CI.**
- Thêm Node 24 vào ma trận (ubuntu/windows/macos × 20/22/24).
- Job mới `install-smoke`: `npm pack` → cài tarball vào thư mục sạch với `--ignore-scripts` (mô phỏng native lỗi) → server phải khởi động, `doctor` phải xanh kèm cảnh báo backend, `project_read_audit` phải trả dữ liệu.

**Nghiệm thu.** Server khởi động và ghi audit trên cả ba backend; test hợp đồng xanh; job `install-smoke` xanh; README ghi rõ backend nào dùng khi nào.

**Rủi ro.** Ngữ nghĩa `UNIQUE`/WAL khác nhau giữa các backend → test hợp đồng là hàng rào chính; JSONL cần khóa file khi nhiều tiến trình ghi (đã có tiền lệ khóa `secrets.json`).

---

### RB7 — Ngân sách schema tool (context) · P1 · M

**Số đo ✅ (Phụ lục A):** Default 32 tool ≈ 68.6 KB ≈ **17.2k token**; Default+core 25 tool ≈ 13.4k; Expert 43 tool ≈ 24.2k. Nặng nhất: `project_shell_run` 5.6 KB, `project_snapshot` 5.1 KB, `project_ci_wait` 3.8 KB, `project_secret` 3.6 KB, `project_edit_file` 3.5 KB.

**Việc làm:**
1. Thêm `scripts/check-schema-size.ts` (`npm run check:schema-size`): khởi động server ở từng chế độ (Default, Default+core, Expert, Expert+core), xuất bảng byte/token ước tính (byte/4, ước lượng thô để so sánh tương đối, không phải tokenizer thật) và so với ngân sách. Môi trường chạy phải **xóa mọi biến `VENIRA_*`** (bài học: shell của máy dev có `VENIRA_TOOL_MODE=expert` nên suýt đo sai).
2. Đặt ngân sách (O4). Đề xuất khởi điểm: Default ≤ 60 KB (−12%), không có tool nào > 5 KB; sau đó siết dần.
3. Rút gọn mô tả: chuyển phần giải thích dài ra `server.ts` instructions **chỉ khi** đo thấy tổng không tăng (instructions cũng tốn context) hoặc ra tài liệu; giữ ví dụ ngắn; không đổi tên/tham số/số tool.
4. README quick start nêu `VENIRA_PROFILE=core` cho client context nhỏ, kèm số token đo được.
5. Quyết định riêng (O5): có nên đổi **mặc định** sang `core` ở bản major. Chưa làm trong mục này.

**Nghiệm thu.** `check:schema-size` có trong `verify` hoặc CI (cảnh báo → fail sau khi chốt ngân sách); tổng byte Default giảm đo được; test `verify` xanh (hợp đồng tool không đổi).

---

### RB8 — Tư thế cấu hình, giai đoạn B: từ chối tổ hợp nguy hiểm · P1 · S (sau RB4, cần quyết định O1)

**Thiết kế.** Khi `computePosture(...).level === "dangerous"`, server từ chối khởi động với `[config_dangerous]` trừ khi có xác nhận tường minh `VENIRA_ACCEPT_RISK=<mã>`, với `<mã>` là danh sách yếu tố nối bằng `+` (vd `unrestricted+shell_off`); cân nhắc dùng một giá trị cố định thay cho mã ghép (mã ghép dễ gõ sai và không thêm an toàn). Thông báo lỗi in sẵn đúng giá trị cần đặt, ghi ra **stderr** (không bao giờ stdout của giao thức MCP) rồi thoát với mã khác 0. Mục đích: cấu hình copy từ Discord không tự chạy ở mức nguy hiểm; người cố ý vẫn chạy được bằng một dòng.

**Giới hạn cần ghi rõ.** Đây chỉ là rào chắn làm chậm, không phải biện pháp bảo mật: ai copy nguyên khối env sẽ copy luôn `VENIRA_ACCEPT_RISK`. Và vì server chạy qua stdio, lỗi khởi động thường chỉ hiện trong log của client MCP, người dùng có thể chỉ thấy "server không lên"; vì vậy `doctor` phải in đúng thông báo này và README phải nói rõ.

**Ghi chú migration.** Cấu hình dev hiện tại của chủ dự án (F1) sẽ cần thêm đúng một biến này. `doctor` và `project_health` hiển thị trạng thái xác nhận.

**Nghiệm thu.** Test: tổ hợp nguy hiểm không có xác nhận → exit khác 0 với `[config_dangerous]`; có xác nhận đúng mã → chạy; mã sai/thiếu yếu tố → vẫn từ chối; tổ hợp `normal`/`elevated` không bị ảnh hưởng.

---

## 4. Phase 3 — Bề mặt cấu hình và kiểm chứng sâu (P2)

### RB9 — Sổ đăng ký biến môi trường + ma trận cờ bảo mật · P2 · M

**Việc làm:**
1. Kiểm kê 91 tên `VENIRA_*` thành `lib/env-registry.ts`: mỗi biến có `class` = `public` (có trong README, ~40) · `advanced` · `internal/test` · `deprecated`, kèm mặc định và mô tả một dòng.
2. `check:docs` thất bại nếu có biến trong source mà không có trong sổ đăng ký, hoặc biến `public` thiếu trong README.
3. Hàm thuần `resolveEffectiveConfig(env)` (dùng chung với `computePosture`) để test ma trận **không cần khởi động tiến trình**: `UNRESTRICTED{0,1}` × `PROFILE{strict,balanced,trusted,off}` × `ALLOW_JS_EXEC{0,1}` × `JS_EXEC_APPROVAL{unset,0,1}` × `SHELL_MODE{unset,strict,off}` = 144 tổ hợp.
4. Bất biến kiểm tra ở mọi tổ hợp:
   - I1 `approval.key`, data dir, kho snapshot luôn là protected path (`isProtectedPath`).
   - I2 profile gõ sai luôn throw `[config_invalid]`.
   - I3 thứ tự ưu tiên "override > profile" khớp tài liệu.
   - I4 `shell_mode=off` luôn kéo theo cảnh báo.
   - I5 JS exec không bao giờ bật nếu không có `ALLOW_JS_EXEC=1`.
   - I6 `computePosture` cho đúng `level` theo bảng quy tắc ở RB4.

**Nghiệm thu.** Sổ đăng ký đầy đủ (0 biến chưa phân loại); ma trận xanh; README tách rõ "biến được hỗ trợ" và "nâng cao".

---

### RB10 — Fuzz theo tính chất cho shell policy · P2 · M

**Thiết kế.** Lấy 271 ca corpus làm hạt giống; biến đổi bảo toàn ngữ nghĩa (hoa/thường, khoảng trắng và tab, thêm dấu nháy trong tên lệnh, thay `&&`/`;`/xuống dòng, bọc `cmd /c`/`bash -c`, mở rộng biến, thêm `env`/`command`/`nohup`, đổi dấu `\`↔`/` trong đường dẫn). **Bất biến đơn điệu:** tier sau biến đổi **không thấp hơn** tier gốc (`deny` ≥ `ask` ≥ `allow`); ca `deny` luôn giữ `deny`.

- Chạy cố định seed trong CI (xác định, nhanh); job đêm dùng seed ngẫu nhiên, lưu seed lỗi vào `scripts/fuzz-findings/`.
- Cài đặt bằng bộ biến đổi tự viết (không thêm dependency); cân nhắc `fast-check` chỉ nếu bộ tự viết không đủ (O3).
- Mỗi phát hiện thành một ca `known_gap`/`enforced` trong RB1.

**Nghiệm thu.** Chạy cố định xanh; có báo cáo số ca đã sinh/số vi phạm bất biến; vi phạm nào cũng có ca hồi quy.

---

### RB11 — Số coverage thật · P2 · S

Chạy `c8` quanh `verify` (tiến trình con `dist/server.js` cần `NODE_V8_COVERAGE` được truyền xuống). Giai đoạn đầu **chỉ báo cáo**, chưa đặt ngưỡng; công bố số trong README sau khi đo ổn định ≥ 3 lần liên tiếp. Ưu tiên đọc coverage của `shell-policy*.ts`, `approvals.ts`, `workspace.ts`, `corehost.ts` (đường dẫn bảo vệ).

---

### RB12 — Tài liệu cách ly thật (Docker / WSL / Windows Sandbox) · P2 · S

Không tự xây sandbox. Viết hướng dẫn chạy Venira trong container không mạng (liên kết Phase 5 #10 của `ROADMAP_HARDENING.md`), WSL và Windows Sandbox: lệnh mẫu, thư mục gắn (mount), cách cắt mạng ở tầng container/VM, giới hạn đã biết. Không có `VENIRA_NETWORK` kill switch ở cấp ứng dụng; dùng network policy của OS/container/VM khi cần hạn chế mạng. Thêm liên kết từ phần tuyên bố giới hạn (RB5).

---

### RB13 — Nghiên cứu: "ghi rồi chạy" (two-step execution) · P2 · M (chỉ nghiên cứu)

Nhóm ca C của RB1 cho thấy policy chỉ thấy lệnh chạy chứ không thấy nội dung vừa ghi. Hướng cần cân nhắc: khi một file thực thi được (`.ps1`, `.sh`, `.bat`, `.js`, `package.json`) vừa bị file tool ghi trong **phiên này**, lệnh chạy tới file đó chuyển từ `allow` sang `ask`. Cần đo tỉ lệ ask giả trên luồng làm việc bình thường (chạy `npm run build` sau khi sửa code là rất thường gặp) trước khi quyết định. Đầu ra của mục này là một đề xuất kèm số đo, chưa phải code.

---

## 5. Bảng tổng hợp và phụ thuộc

| ID | Việc | Ưu tiên | Cỡ | Phụ thuộc | Đổi hành vi? |
|---|---|---|---|---|---|
| RB1 | Bộ test bypass (path / shell / two-step) | P0 | L | — | Không (chỉ test; phát hiện lỗ hổng → RB1b) |
| RB2 | Test approval: replay/hết hạn/khác phiên/đua | P0 | M | — | Không |
| RB3 | Test cache protected roots + SN6 | P0 | S | — | Không |
| RB4 | `computePosture` + cảnh báo (giai đoạn A) | P0 | M | — | Thêm trường `health`, banner stderr |
| RB5 | Tuyên bố giới hạn ở README/doctor/health | P0 | S | — | Không |
| RB6 | Audit store fallback + Node 24 + `install-smoke` | P1 | L | kiểm kê auditDb | `better-sqlite3` → optional |
| RB7 | Ngân sách schema tool | P1 | M | — | Mô tả tool ngắn hơn |
| RB8 | Từ chối tổ hợp nguy hiểm (giai đoạn B) | P1 | S | RB4, O1 | **Có** (cần xác nhận rủi ro) |
| RB9 | Sổ đăng ký env + ma trận cờ | P2 | M | RB4 | Không |
| RB10 | Fuzz theo tính chất | P2 | M | RB1 | Không |
| RB11 | Coverage | P2 | S | — | Không |
| RB12 | Tài liệu cách ly thật | P2 | S | RB5 | Không |
| RB13 | Nghiên cứu "ghi rồi chạy" | P2 | M | RB1 (nhóm C) | Chưa |

Liên hệ với roadmap có sẵn: RB3 ⊃ SN6; RB6 mở rộng CI Phase 4 (thêm Node 24); RB12 ↔ Phase 5 #10; RB1/RB13 liên quan "per-shell policy parsers" (Phase 1, còn mở) và SN3.

## 6. Đề xuất phát hành

| Bản | Nội dung | Điều kiện |
|---|---|---|
| **1.17.x** (patch) | RB1 (test), RB2, RB3, RB4 (giai đoạn A), RB5 (gồm chốt số tool, F4) | `verify` + `test:bypass` xanh 3 OS; mọi `known_gap` có ID; không đổi hành vi người dùng |
| **1.18.0** | RB6, RB7, RB8 (nếu O1 chọn "từ chối") | `install-smoke` xanh; Node 24 trong ma trận; changelog nêu `better-sqlite3` optional và `VENIRA_ACCEPT_RISK` |
| **1.19.x** | RB9, RB10, RB11, RB12 | sổ đăng ký đầy đủ; fuzz cố định xanh; số coverage đã đo |
| **sau đó** | RB13, O5 (mặc định `core`) | có số đo ủng hộ |

## 7. Câu hỏi mở cho chủ dự án

- **O1** Tổ hợp nguy hiểm: chỉ cảnh báo vĩnh viễn, hay từ chối khi thiếu `VENIRA_ACCEPT_RISK` từ 1.18.0? (Đề xuất: từ chối.) Định nghĩa `dangerous` ở RB4 có đúng ý chưa?
- **O2** `node:sqlite` chỉ làm fallback, hay cũng cho dùng làm backend ưu tiên trên Node mới? (Đề xuất: chỉ fallback cho đến khi có số đo.)
- **O3** Fuzz bằng bộ biến đổi tự viết (không thêm dependency) hay `fast-check`? (Đề xuất: tự viết.)
- **O4** Ngân sách schema: Default ≤ 60 KB có hợp lý không, hay muốn mục tiêu token cụ thể?
- **O5** Có muốn đổi mặc định sang `VENIRA_PROFILE=core` ở bản major không?
- **O6** `ROADMAP.md`, `ROADMAP_HARDENING.md` và `TOOL-ROADMAP.md` đang bị `.gitignore` (đã kiểm); `ROADMAP_GIT_OAUTH.md` và file này thì không. File này có nên commit công khai không? Nếu có, Phụ lục B và F1 cho người ngoài thấy máy dev chạy tổ hợp nguy hiểm và danh sách họ kỹ thuật corpus còn trống; cân nhắc giữ file ngoài git tới khi các `known_gap` được xử lý.
- **O7** Approval có nên có hạn sử dụng (TTL) không? (Kết quả kiểm RB2 ca 5 sẽ chỉ ra hiện trạng.)
- **O8** Đã giải quyết ở rev 4: Expert = 43 (F4). Còn mở: có nên cho `check-docs.ts` tự tính số tool từ `TOOL_MODE_EXCLUDES` thay vì hằng số không?

## 8. Định nghĩa "xong" chung

`npx tsc --noEmit`, `npm run verify`, `npm run test:policy-corpus`, `npm run test:bypass` (từ RB1), `npm run check:docs`, `npm run check:source-shape` xanh; CI ma trận xanh (từ RB6 gồm Node 24); README, `SECURITY.md` và roadmap cập nhật cùng commit; không đổi tool count; hành vi mặc định của `balanced` + `UNRESTRICTED=0` không đổi trừ khi mục ghi rõ.

---

## Phụ lục A — Số đo ngày 2026-11-07

**Biến môi trường.** 91 tên `VENIRA_*` duy nhất trong `lib/*.ts`, `tools/*.ts`, `server.ts`; 40 biến có trong bảng README (`check:docs`).

**Kích thước `tools/list`** (khởi động `dist/server.js` với mọi biến `VENIRA_*` đã xóa; ước tính token = byte/4):

| Chế độ | Số tool | Byte | ≈ token |
|---|---:|---:|---:|
| Default | 32 | 68,638 | 17,160 |
| Default + `VENIRA_PROFILE=core` | 25 | 53,677 | 13,419 |
| Expert (`VENIRA_TOOL_MODE=expert`) | 43 | 96,627 | 24,157 |
| Expert + core | 36 | 81,666 | 20,417 |
| Expert + `VENIRA_ALLOW_JS_EXEC=1` | 44 | 99,116 | 24,779 |

Tool nặng nhất: `project_shell_run` 5,587 B · `project_snapshot` 5,106 B · `project_ci_wait` 3,767 B · `project_secret` 3,585 B · `project_edit_file` 3,525 B.

**Lệch hợp đồng (F4).** Hàng Expert đo được 43 (44 khi bật JS exec) trong khi `check-docs.ts` đặt 42 (43 với JS exec). Đã giải quyết ở rev 4: số đo đúng (xem F4); README và `check-docs.ts` đã sửa thành 43/44.

**Lưu ý đo.** Shell của máy dev mang sẵn `VENIRA_TOOL_MODE=expert` và nhiều biến khác; lần đo đầu không xóa chúng cho ra 44 tool ở "Default". Mọi script đo phải xóa `VENIRA_*` trước (RB7 bước 1).

**Cấu hình instance dev (F1):** xem F1 ở §0; danh sách đầy đủ không lặp lại ở đây để file này có thể commit mà không công bố toàn bộ cấu hình máy dev (O6).

**CI.** `ci.yml`: ubuntu/windows/macos × Node 20, 22; bước build, tsc, source-shape, smoke, doctor, verify, policy corpus, bench, `npm audit` (không chặn); job `package`. Không có Node 24, không có job cài mới mô phỏng native lỗi.

**Test hiện có.** `verify` 507 check (gồm approval dùng một lần, MAC pending); `test:shell-security`, `test:audit-verify`, `test:provider-secret-guard`, `test:github-device-flow`; policy corpus 271 ca.

## Phụ lục B — Độ phủ corpus theo họ kỹ thuật (grep thô trên `policy-corpus.json` + `policy-corpus-extra.ts`)

| Họ kỹ thuật | Số lần xuất hiện |
|---|---:|
| `-EncodedCommand` / `-enc` / `-ec` | 3 |
| `$(...)` | 12 |
| backtick | 8 |
| `%VAR%` (cmd) | 1 |
| pipe vào `sh`/`bash`/`iex` | 1 |
| `curl ... \|` | 1 |
| `iex` / `Invoke-Expression` | **0** |
| `[Convert]::FromBase64String` | **0** |
| tên 8.3 (`~1`) | **0** |
| tiền tố `\\?\` | **0** |
| ADS (`::$DATA`, `:stream`) | **0** |
| ký tự không-ASCII | **0** |
| escape `^` (cmd) | **0** |
| here-string | **0** |
| `Start-Process` | **0** |

Đây là số lần chuỗi xuất hiện, **không** phải kết luận rằng policy bỏ lọt: policy có thể vẫn xử lý đúng nhờ quy tắc tổng quát. Việc của RB1 bước 0 là đo hành vi thật và điền kết quả vào bảng này.

## Phụ lục C — Lệnh tái tạo số đo

```powershell
# đếm biến VENIRA_* trong source
(Select-String -Path lib\*.ts,tools\*.ts,server.ts -Pattern 'VENIRA_[A-Z0-9_]+' -AllMatches | % { $_.Matches.Value } | Sort-Object -Unique).Count

# kích thước tools/list theo chế độ: xóa mọi VENIRA_* khỏi env của tiến trình con,
# rồi connect bằng @modelcontextprotocol/sdk (StdioClientTransport) và đo JSON.stringify(listTools().tools)
```
