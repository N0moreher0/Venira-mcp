---
title: Chế độ tool
description: Phơi 2, 18, 31 hoặc 44 tool - mỗi byte schema đều nằm trong mọi prompt, nên bộ tool là một thiết lập.
order: 2
---

# Chế độ tool

Schema của mỗi tool được gửi cho model ở mọi prompt. Bốn mươi tư tool kèm mô tả đầy đủ có thể tốn nhiều context hơn cả đoạn code bạn đang sửa, nên bộ tool là một lựa chọn cấu hình, không phải danh sách cố định.

Đổi chế độ bằng biến môi trường `VENIRA_TOOL_MODE`:

| Chế độ | Số tool | Phù hợp với | Gồm |
|---|---|---|---|
| `minimal` | 2 | Context hẹp nhất; một cửa ngõ | `execute_js` (SDK JS nằm trong mô tả tool, tổng ~2 737 B) cộng `shell_status`, và chính tool này huỷ lệnh nền khi `action="cancel"` kèm `kill_key` |
| `core` | 18 | Model nhỏ, context hẹp | Shell, đọc, tìm kiếm, sửa, snapshot, git, memory |
| `default` | 31 | Lập trình hằng ngày | Core cộng phân tích code, không có CI/CD |
| `expert` | 44 | Quy trình đầy đủ | Default cộng pull request và CI |

Mỗi chế độ bớt một tool khi tắt `execute_js` (1 / 17 / 30 / 43). Nếu không đặt `VENIRA_JS_EXEC_MODE` thì `minimal` mặc định `semi-auto` (`ask` khi profile là `strict`) để cửa ngõ duy nhất vẫn mở; đặt tường minh `off` thì vẫn được tôn trọng. Đặt `VENIRA_JS_EXEC_MODE=off` nếu bạn không bao giờ muốn agent chạy JavaScript.

## Các chế độ liên quan thế nào

`minimal` là allowlist đúng hai tool. Mọi thao tác đọc, sửa, tìm, shell và git đi qua `execute_js`. `shell_status` đứng ngoài cửa đó vì lệnh chạy nền sống lâu hơn snippet đã khởi động nó, và ở mode này nó kiêm luôn việc huỷ (`shell_cancel` không được quảng bá).

`core` là một allowlist: là bộ nhỏ nhất vẫn cover đủ vòng đọc - tìm - sửa - kiểm tra - hoàn tác, gồm `snapshot` để rollback, tool `git` (status, diff, log, commit, push) và ghi chú `memory` dùng chung.

`default` thêm tầng hiểu code (`outline_symbol`, `symbol_references`, `dependency_graph`) cho agent phải di chuyển trong code lạ.

`expert` thêm tầng quy trình: pull request và các tích hợp CI (GitHub, GitLab, Bitbucket) với thời gian chờ có trần.

Các tool chỉ dùng khi setup (trợ lý cài lần đầu) tham gia bộ tool khi đặt `VENIRA_SETUP_TOOLS=1`.

## Chọn chế độ nào

- Muốn trả ít token schema nhất và chấp nhận gộp thao tác vào một lệnh JavaScript? Dùng `minimal`.
- Chạy model nhỏ local, hoặc client đặt schema vào system prompt rất hẹp? Dùng `core`.
- Lập trình hằng ngày với model cỡ vừa hoặc lớn? `default` là đủ; bạn không thiếu tự động hoá PR/CI trừ khi thật sự dùng tới.
- Làm release, quét PR hay xử lý CI qua agent? `expert`.

Chế độ được đọc lúc server khởi động; đổi biến rồi khởi động lại client để áp dụng.
