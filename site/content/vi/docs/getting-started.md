---
title: Bắt đầu
description: Cài venira-mcp, trỏ MCP client của bạn vào server và kiểm tra server đã chạy.
order: 1
---

# Bắt đầu

venira-mcp là một npm package duy nhất, phơi các tool có phạm vi workspace cho coding agent qua Model Context Protocol. Cần Node 20 trở lên, chỉ có một dependency native (`better-sqlite3`) và không kèm binary ngoài.

## Cài đặt

Chạy một lần trong thư mục dự án của bạn:

```bash
npx --yes venira-mcp@latest --install auto --workspace .
```

Trình cài đặt nhận diện client của bạn (OpenCode, VS Code, Claude Desktop, Cursor, Codex), ghi cấu hình MCP và trỏ tới workspace bạn đã truyền. Sau đó khởi động lại client để nó nhận server mới.

## Tự cấu hình tay

Muốn tự sửa cấu hình? Chọn client của bạn.

**OpenCode** - `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "mcp": {
    "venira": {
      "type": "local",
      "command": ["npx", "--yes", "--package=venira-mcp@latest", "venira-mcp"],
      "enabled": true,
      "environment": {
        "VENIRA_WORKSPACE": "/đường/dẫn/tuyệt/đối/đến/dự/án",
        "VENIRA_TOOL_MODE": "expert"
      }
    }
  }
}
```

**VS Code** - `<workspace>/.vscode/mcp.json`:

```json
{
  "servers": {
    "venira": {
      "type": "stdio",
      "command": "npx",
      "args": ["--yes", "--package=venira-mcp@latest", "venira-mcp"],
      "env": {
        "VENIRA_WORKSPACE": "${workspaceFolder}",
        "VENIRA_TOOL_MODE": "expert"
      }
    }
  }
}
```

**Claude Desktop / Cursor** - `claude_desktop_config.json` hoặc `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "venira": {
      "command": "npx",
      "args": ["--yes", "--package=venira-mcp@latest", "venira-mcp"],
      "env": {
        "VENIRA_WORKSPACE": "/đường/dẫn/tuyệt/đối/đến/dự/án",
        "VENIRA_TOOL_MODE": "expert"
      }
    }
  }
}
```

**Codex** - `~/.codex/config.toml`:

```toml
[m[ mcp_servers.venira ]
command = "npx"
args = ["--yes", "--package=venira-mcp@latest", "venira-mcp"]

[m[ mcp_servers.venira.env ]
VENIRA_WORKSPACE = "C:\\duong\\dan\\du\\an"
VENIRA_TOOL_MODE = "expert"
```

## Các biến môi trường nên biết

- `VENIRA_WORKSPACE` - trục workspace. Các đường dẫn tuyệt đối phân tách bằng `,` hoặc `;`; mục **đầu tiên** là workspace root nơi mọi đường dẫn của tool quy về, và mỗi mục đều là root mà `switch_workspace` được chuyển tới dưới profile `strict`/`balanced`. (Trước 6.0.0 tách thành `VENIRA_WORKSPACE` và `VENIRA_WORKSPACE_ROOTS`; biến thứ hai đã bị xoá.)
- `VENIRA_TOOL_MODE` - `core` (18 tool), `default` (31) hoặc `expert` (44). Xem [chế độ tool](/vi/docs/tool-modes/).
- `VENIRA_SECURITY_PROFILE` - `balanced` (mặc định), `strict`, `trusted` hoặc `off`. Xem [bảo mật](/vi/docs/security/).

## Kiểm tra đã chạy

Khởi động lại client rồi nhờ agent gọi `health`. Lệnh này xác nhận server đang chạy, workspace nào bị khoá và đang ở chế độ tool nào.

Là lệnh thật đầu tiên, hãy tạo một checkpoint để mọi thứ agent làm từ giờ đều hoàn tác được:

```text
snapshot action=create label="baseline trước nhiệm vụ đầu tiên"
```

## Các thứ nằm ở đâu

- Ghi chú memory dùng chung mà agent đọc và ghi là `<workspace>/.venira/memory.md` (giới hạn 10.000 byte, có khoá lạc quan - xem [audit và snapshot](/vi/docs/audit-and-snapshots/)).
- Mọi lệnh gọi tool được ghi vào nhật ký kiểm toán SQLite, nên bạn luôn trả lời được "agent đã đổi gì và vì sao".

## Bước tiếp theo

- [Chế độ tool](/vi/docs/tool-modes/) - quyết định agent nhìn thấy bao nhiêu tool.
- [Bảo mật](/vi/docs/security/) - profile, luật shell và duyệt lệnh.
- [Audit và snapshot](/vi/docs/audit-and-snapshots/) - dấu vết và nút hoàn tác.
