---
title: Getting started
description: Install venira-mcp, point your MCP client at it and verify the server is up.
order: 1
---

# Getting started

venira-mcp is one npm package that exposes workspace-scoped tools to your coding agent over the Model Context Protocol. It needs Node 20 or newer, has exactly one native dependency (`better-sqlite3`) and ships no external binary.

## Install

Run this once inside your project folder:

```bash
npx --yes venira-mcp@latest --install auto --workspace .
```

The installer detects your client (OpenCode, VS Code, Claude Desktop, Cursor, Codex), writes the MCP config entry and points it at the workspace you passed. Then restart your client so it picks up the new server.

## Manual setup

Prefer to edit the config yourself? Pick your client.

**OpenCode** - `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "mcp": {
    "venira": {
      "type": "local",
      "command": ["npx", "--yes", "--package=venira-mcp@latest", "venira-mcp"],
      "enabled": true,
      "environment": {
        "VENIRA_WORKSPACE": "/absolute/path/to/project",
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

**Claude Desktop / Cursor** - `claude_desktop_config.json` or `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "venira": {
      "command": "npx",
      "args": ["--yes", "--package=venira-mcp@latest", "venira-mcp"],
      "env": {
        "VENIRA_WORKSPACE": "/absolute/path/to/project",
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
VENIRA_WORKSPACE = "C:\\path\\to\\project"
VENIRA_TOOL_MODE = "expert"
```

## Environment variables worth knowing

- `VENIRA_WORKSPACE` - the workspace axis. Absolute paths separated by `,` or `;`; the **first** entry is the workspace root where every tool path resolves, and every entry is a root `switch_workspace` may move to under the `strict`/`balanced` profiles. (Before 6.0.0 this was split across `VENIRA_WORKSPACE` and `VENIRA_WORKSPACE_ROOTS`; the second variable is gone.)
- `VENIRA_TOOL_MODE` - `core` (18 tools), `default` (31) or `expert` (44). See [tool modes](/docs/tool-modes/).
- `VENIRA_SECURITY_PROFILE` - `balanced` (default), `strict`, `trusted` or `off`. See [security](/docs/security/).

## Verify it works

Restart your client and ask the agent to call `health`. It confirms the server is running, which workspace is locked and which tool mode is active.

As a first real call, make a checkpoint so everything the agent does from now on is undoable:

```text
snapshot action=create label="baseline before first task"
```

## Where things live

- The shared memory note the agent can read and write is `<workspace>/.venira/memory.md` (10,000 byte cap, with an optimistic lock - see [audit and snapshots](/docs/audit-and-snapshots/)).
- Every tool call is recorded in a SQLite audit trail, so you can always answer "what did the agent change and why".

## Next steps

- [Tool modes](/docs/tool-modes/) - decide how much surface your agent sees.
- [Security](/docs/security/) - profiles, shell rules and approvals.
- [Audit and snapshots](/docs/audit-and-snapshots/) - the paper trail and the undo button.
