---
title: Benchmark: đường gọi tool của agent trên Windows
description: Kết nối MCP bền vững đấu với PowerShell mới cho mỗi lệnh - 20 mẫu ghép cặp cho mỗi giai đoạn, khớp output tuyệt đối.
date: 2026-11-07
---

# Benchmark: đường gọi tool của agent trên Windows

Khi agent đọc một file hay tìm trong workspace, cái đáng chú ý không phải tốc độ đĩa - mà là *đường gọi tool*: mọi thứ giữa quyết định của model và các byte quay về. Benchmark này đo đường đó cho venira-mcp so với phương án hiển nhiên: cho agent chạy lệnh shell rồi tự parse output.

## Thiết lập

Đo ngày 2026-11-07 (Asia/Bangkok) trên Windows 11 build 26200, Intel Core i5-1035G1 (8 luồng, 11,8 GiB RAM), Node v24.20.0, PowerShell 5.1. Venira 1.15.1 cho phần so với Codex trực tiếp và 1.17.0 cho benchmark thành phần.

Phương pháp: **hai mươi mẫu ghép cặp cho mỗi giai đoạn**, mỗi cặp đổi thứ tự gọi. Các lệnh Venira chạy trên kết nối MCP bền vững đã mở sẵn trong phiên Codex; mỗi lệnh `exec_command` thuần mở một tiến trình PowerShell mới. Giai đoạn cold xoá cache trong tiến trình trước mỗi mẫu, giai đoạn warm tạo sẵn và tái dùng. Cache filesystem của Windows giữ warm ở cả hai giai đoạn. Cả hai workload đều được đối chiếu khớp output tuyệt đối trên từng cặp.

## So trực tiếp với `exec_command` của Codex

| Workload | Giai đoạn | Venira p50 / p95 | `exec_command` p50 / p95 | Tỉ lệ theo p50 | Khớp |
|---|---|---:|---:|---:|---|
| Đọc đầu 8 file trong một batch | Cache miss | 53,5 / 72 ms | 962 / 1.121 ms | 17,98 lần | 20/20 |
| Đọc đầu 8 file trong một batch | Warm | 39 / 60 ms | 1.103,5 / 1.549 ms | 28,29 lần | 20/20 |
| Tìm trong workspace (49 kết quả) | Cache miss | 118,5 / 188 ms | 1.034,5 / 1.507 ms | 8,73 lần | 20/20 |
| Tìm trong workspace (49 kết quả) | Warm | 34,5 / 152 ms | 1.018 / 1.383 ms | 29,51 lần | 20/20 |

So đọc đối chiếu văn bản đã chuẩn hoá của tám file chỉ định; so tìm đối chiếu chính xác các cặp file / số dòng đã sắp. Không lệch cặp nào trong cả 40 cặp của hai workload.

Mẫu hình nhất quán: một tiến trình PowerShell mới tốn gần một giây trước khi làm việc gì, trong khi kết nối bền vững làm cùng việc trong vài chục mili giây - và gộp tám lệnh đọc thành một lại cắt thêm bảy vòng chờ.

## Benchmark thành phần

Riêng ra, `npm run bench:tools -- --runs=100` (100 mẫu mỗi giai đoạn) so từng lệnh gọi tool qua client MCP stdio local bền vững với các thao tác PowerShell thuần đo *bên trong* một tiến trình PowerShell - tức loại trừ chi phí khởi động, so sánh chỉ còn phần việc của tool:

| Workload | Giai đoạn | MCP p50 | PowerShell p50 |
|---|---|---:|---:|
| Đọc 25 dòng từ `package.json` | Cache miss | 4,89 ms | 1,57 ms |
| Đọc batch 3 file | Warm | 2,31 ms | 3,61 ms |
| Liệt kê `lib/` | Cache miss | 1,97 ms | 3,76 ms |
| Tìm literal trong một file | Warm | 0,66 ms | 41,35 ms |

Bảng này thẳng thắn hơn về đánh đổi: với lệnh đọc đơn chưa cache và metadata, PowerShell thuần nhanh hơn - tầng MCP cộng thêm vài mili giây, đó là giá của nhật ký audit, hàng rào đường dẫn và envelope ổn định. Với lệnh đọc warm, liệt kê và đặc biệt là tìm kiếm, venira-mcp thắng dù không có lợi thế khởi động tiến trình, vì cache trong tiến trình giữ sẵn kết quả mà shell mới phải tính lại mỗi lần.

Một lần chạy sớm hơn trong ngày cho thấy chậm ở cache-miss do canonicalise đường dẫn lặp lại trong `isProtectedPath`; đã sửa trước khi lấy các số trên.

## Đọc phần in nhỏ

Đây là một máy Windows, một lần chạy, và p95 trực tiếp chỉ đứng trên 20 mẫu - xem các số này là xu hướng, không phải cam kết. Phương pháp, bảng thành phần đầy đủ và mẫu thô đều công bố trong repo: [BENCHMARK-2026-11-07.md](https://github.com/N0moreher0/Venira-mcp/blob/main/BENCHMARK-2026-11-07.md) và [BENCHMARK-2026-11-07.json](https://github.com/N0moreher0/Venira-mcp/blob/main/BENCHMARK-2026-11-07.json).

Tự chạy lại benchmark thành phần:

```bash
npm run bench:tools -- --runs=100
```
