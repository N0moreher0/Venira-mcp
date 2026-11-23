---
title: venira-mcp 6.0.0: một biến workspace, một khoá cho memory
description: Dọn dẹp breaking trục biến môi trường workspace, cộng khoá lạc quan cho ghi chú memory dùng chung.
date: 2026-11-23
---

# venira-mcp 6.0.0: một biến workspace, một khoá cho memory

6.0.0 là bản major cho một lần break có chủ đích, cộng phần sửa một lỗi trúng ngay trong ngày ra mắt.

## Breaking: `VENIRA_WORKSPACE_ROOTS` bị xoá

Trục workspace từng dùng hai biến - `VENIRA_WORKSPACE` cho root, `VENIRA_WORKSPACE_ROOTS` cho các root phụ mà `switch_workspace` được tới. Hai biến cho một khái niệm dễ lệch nhau, nên giờ chỉ còn một `VENIRA_WORKSPACE`: các đường dẫn tuyệt đối phân tách bằng `,` hoặc `;`, trong đó mục **đầu tiên** là workspace root và mọi mục đều là root mà `switch_workspace` được chuyển tới dưới `strict` / `balanced`.

Chuyển đổi:

```text
VENIRA_WORKSPACE_ROOTS="C:\a;D:\b"   ->   VENIRA_WORKSPACE="C:\a;D:\b"
```

Không có alias. Nếu còn đặt biến cũ, server sẽ bỏ qua và cảnh báo lúc khởi động kèm đúng cách thay thế. Một lưu ý hành vi: khi `VENIRA_WORKSPACE` được đặt, chuyển workspace giờ được *bật* dưới `strict` / `balanced` và giới hạn trong các root liệt kê; trước đây nó bị khoá ở workspace khởi động trừ khi đặt biến phụ.

## Ghi chú memory có khoá lạc quan

`memory` là ghi chú bàn giao mà agent đọc đầu nhiệm vụ và cập nhật trước khi kết thúc. Vì mỗi lần ghi thay toàn bộ ghi chú, hai agent dùng chung một workspace có thể xoá sạch sửa đổi của nhau mà không hay biết - và chuyện đó đã xảy ra tại đây vào 2026-11-23, nên mới có bản phát hành này.

- `memory action=read` giờ trả về `version`: 12 ký tự hex đầu của hash ghi chú, hoặc `"new"` khi chưa có ghi chú.
- `memory action=write` nhận `if_version`. Không khớp thì không ghi gì và lệnh trả `conflict`; đọc lại, gộp, ghi lại. Ghi thành công trả về version mới, nên các lần ghi liền nhau không cần đọc lại.
- Ghi không kèm `if_version` giữ hành vi ghi đè cũ (kèm hint trong response), nên client cũ vẫn chạy được.

Cùng phần này: trần ghi chú tăng từ 6.000 lên 10.000 byte - nhiều agent dùng chung nhiều context hơn cho mỗi workspace - và envelope của `memory` không bao giờ bị cắt preview ở chế độ output compact, nên ghi chú đầy đủ đọc về nguyên vẹn.

## Còn trong 6.0.0

- Sửa dấu ngoặc kép chưa escape trong thông báo `workspace_switch_denied`: đoạn ví dụ chứa dấu ngoặc kép lồng trong chuỗi có dấu ngoặc kép, làm nạp `dist/lib/corehost.js` thất bại với `SyntaxError` trên các máy gặp phải.
- Verify budget: `TOOL_SCHEMA_MAX_BYTES` 6.200 -> 7.116 byte - các tuỳ chọn `git push` của 5.1.0 làm schema `git` vượt trần cũ.
- `test:memory` tăng từ 24 lên 37 kiểm tra.

Nâng cấp bằng `npx --yes venira-mcp@latest --install auto --workspace .`, thay mọi `VENIRA_WORKSPACE_ROOTS` trong cấu hình client, rồi khởi động lại.
