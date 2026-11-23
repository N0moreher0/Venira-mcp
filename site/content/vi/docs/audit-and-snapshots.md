---
title: Audit và snapshot
description: Mọi lệnh gọi đều được audit, mọi lần refactor cách một checkpoint là hoàn tác được - không cần git.
order: 4
---

# Audit và snapshot

Hai cơ chế tạo nên dấu vết: nhật ký audit trả lời *đã xảy ra gì*, snapshot trả lời *hãy cho nó chưa từng xảy ra*.

## Nhật ký audit

Mọi lệnh gọi tool được ghi vào nhật ký audit SQLite (chế độ WAL) bên trong workspace. Các tool thay đổi dữ liệu nhận `reason` tuỳ chọn, được lưu cùng lệnh gọi - nên nhật ký đọc như một changelog, chứ không chỉ là danh sách tên tool.

`read_audit` trả về các mục trong một khung thời gian. Với trường reason, kết quả phân loại policy của lệnh shell và hash file được ghi lại khi ghi file, bạn dựng lại được agent đã đổi gì và vì sao mà không cần đọc transcript của nó.

## Checkpoint không cần git

`snapshot action=create` tạo checkpoint theo nội dung cho các đường dẫn bạn chỉ định. Khôi phục là nguyên tử, từng file một, và không quan tâm thư mục có phải git repo hay không - hữu ích cho thư mục vứt, code sinh tự động và máy chưa cấu hình git.

Quy trình đã được kiểm chứng:

1. `snapshot action=create paths=["lib/", "tests/"] label="trước khi refactor"`
2. Làm việc.
3. Nếu hỏng: `snapshot action=restore` với `dry_run=true` trước để xem trước chính xác file nào đổi và đổi thế nào, rồi khôi phục thật (`verify=true`).

Snapshot rất rẻ; tạo một cái trước mọi thay đổi nhiều file, nâng dependency hay thử nghiệm. Git là sàn - snapshot là trần.

## Từ chối sửa trên nội dung cũ

Người ghi đồng thời (bạn và agent, hoặc hai agent) được bảo vệ bằng `expected_sha256` trên `write_file` và `edit_file`: truyền hash bạn đã đọc, và lệnh trả `stale_content` nếu file đã đổi từ lúc đó. Không có ghi đè âm thầm.

## Ghi chú memory dùng chung

`<workspace>/.venira/memory.md` là ghi chú bàn giao nhỏ (giới hạn 10.000 byte) mà agent đọc đầu nhiệm vụ và cập nhật trước khi kết thúc. Nhiều agent có thể dùng chung một workspace, nên 6.0.0 thêm khoá lạc quan:

- `memory action=read` trả về `version` - 12 ký tự hex đầu của hash ghi chú, hoặc `"new"` khi chưa có ghi chú.
- `memory action=write` nhận `if_version`. Không khớp thì không ghi gì và lệnh trả `conflict`; đọc lại, gộp sửa đổi rồi ghi lại.
- Ghi không kèm `if_version` giữ hành vi ghi đè cũ (kèm hint), nên client cũ vẫn chạy được.
