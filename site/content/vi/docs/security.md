---
title: Bảo mật
description: Profile bảo mật, bộ luật shell và duyệt lệnh - là hàng rào bảo vệ, không phải sandbox.
order: 3
---

# Bảo mật

venira-mcp được thiết kế để bạn kiểm tra lại việc agent đã làm sau khi nó làm, và để các lệnh nguy hiểm bị chặn trước khi chạy. Nó là hàng rào bảo vệ, không phải sandbox: nó chạy với quyền của user hệ điều hành đã khởi động nó. Với workspace không tin cậy, hoặc khi cần cô lập thật sự, hãy chạy trong container hoặc VM.

## Profile bảo mật

`VENIRA_SECURITY_PROFILE` chọn tư thế:

| Profile | Tool file | `switch_workspace` | Phù hợp |
|---|---|---|---|
| `balanced` (mặc định) | Khoá trong workspace | Chỉ trong các root liệt kê trong `VENIRA_WORKSPACE` | Công việc hằng ngày |
| `strict` | Khoá trong workspace | Chỉ trong các root liệt kê trong `VENIRA_WORKSPACE` | Repo cần review kỹ; push thường cũng bị từ chối và cần duyệt |
| `trusted` | Khoá trong workspace | Bất kỳ thư mục nào đang tồn tại | Máy cá nhân, nhảy giữa nhiều dự án |
| `off` | Không chặn đường dẫn | Bất kỳ thư mục nào đang tồn tại | VM và container dùng một lần |

Khoá workspace giới hạn đường dẫn mà *tool file* chạm tới. Nó không giới hạn việc một lệnh shell đã được duyệt làm - việc đó thuộc về bộ luật shell.

## Bộ luật shell

Trước khi một lệnh `shell_run` thực thi, nó được phân loại `allow`, `ask` hoặc `deny`. Kết quả trả về cùng lệnh gọi (`policy: {decision, rule, mode}`) và được audit như mọi thứ khác.

- `rm -rf /` bị từ chối thẳng ở profile mặc định.
- Lệnh xoá đệ quy kèm force và các lệnh phá hoại tương tự cần bạn duyệt.
- Lệnh mức `ask` mang theo `approval_id` và `approval_wait_s`: gọi lại kèm approval id để cho qua, hoặc chạy với `dry_run` trước để xem lệnh sẽ đụng vào đâu.

## Git cũng có phạm vi

Tool `git` cover status, diff, log, commit và push. Push thường chạy không cần duyệt; force push, xoá branch và đổi URL remote thì không - và dưới `strict`, push bị từ chối và cần duyệt. Credential push chỉ lấy từ git config của bạn; tool không bao giờ hỏi mật khẩu và che credential trong output.

## Kiểm tra lại agent sau đó

- Mọi lệnh gọi tool ghi vào nhật ký kiểm toán SQLite; thao tác thay đổi có thể kèm `reason`.
- `read_audit` trả lời "đổi gì và vì sao" cho mọi khung thời gian.
- `write_file` và `edit_file` nhận `expected_sha256`. Nếu file đã đổi từ lúc bạn đọc, lệnh trả `stale_content` thay vì ghi đè công việc mới hơn.

Xem [audit và snapshot](/vi/docs/audit-and-snapshots/) cho phần hoàn tác.
