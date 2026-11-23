---
title: venira-mcp 5.1.0: git push đã vào bộ tool
description: Một branch, một remote đã cấu hình, không force - cộng switch_workspace vào allowlist core.
date: 2026-11-22
---

# venira-mcp 5.1.0: git push đã vào bộ tool

5.1.0 khép lại vòng lặp mà 5.0.0 mở ra: tới giờ agent có thể commit local nhưng phải đưa cho shell một `git push` thô - đúng kiểu lệnh ngỏ mà bạn không muốn agent tự gõ. Tool `git` giờ có `action=push`, và nó được cố ý làm hẹp.

## `git action=push` làm gì

Nó push **một** branch local (`ref`, mặc định là branch đang checkout) tới một **tên** remote đã cấu hình (`remote`, mặc định là remote riêng của branch, không có thì `origin`, không có thì remote duy nhất). Các tuỳ chọn: `set_upstream` (`-u`), `tags` (`--tags`) và `dry_run`.

Những điều nó không làm:

- Không nhận URL và giá trị giống tuỳ chọn ở trường remote - chỉ nhận tên.
- Không force push dưới mọi hình thức, không xoá branch, không `--all` / `--mirror`. Những việc đó nằm ở `shell_run`, nơi policy shell sẽ yêu cầu duyệt.
- Bị từ chối thẳng dưới `VENIRA_SECURITY_PROFILE=strict` - push cần duyệt ở đó.
- Credential chỉ lấy từ git config của bạn; tool không bao giờ hỏi (`GIT_TERMINAL_PROMPT=0`, ssh `BatchMode=yes` trừ khi bạn đặt `GIT_SSH_COMMAND`), hết giờ sau 120 giây và che credential trong output.

Kết quả được parse từ `git push --porcelain`: `{remote, branch, pushed, up_to_date, dry_run, set_upstream, tags, updates[]}`. Bị từ chối hiện về dạng lỗi `conflict` thay vì một bức tường stderr.

## switch_workspace vào allowlist core

Các client chỉ spawn server một lần - Claude Desktop, Cowork - trước đây bị khoá ở thư mục khởi động. `switch_workspace` giờ nằm trong allowlist `core`, nên cả chế độ tool nhỏ nhất cũng đi theo bạn sang thư mục dự án khác mà không cần khởi động lại. Core giờ là **18** tool (17 với `VENIRA_JS_EXEC_MODE=off`); `default` và `expert` giữ nguyên 31 / 44 vì tool này đã có sẵn từ trước. Hành vi vẫn bị giới hạn bởi profile bảo mật.

## Chi tiết nhỏ

- Schema `git` tăng từ 6.154 lên 7.189 byte cho các tuỳ chọn push; schema budget được nâng một cách có chủ đích.
- `test:git-local` thêm 10 kiểm tra trên một bare remote local: dry run, `-u`, up-to-date, từ chối URL, non-fast-forward, cấm force, từ chối dưới strict, detached HEAD, parse porcelain và che credential.

Nâng cấp bằng `npx --yes venira-mcp@latest --install auto --workspace .` rồi khởi động lại client.
