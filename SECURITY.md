# Security Policy — venira-mcp-coding

## Supported versions

| Version | Supported | Notes |
|---|---|---|
| `latest` (GitHub `main`) | Yes | — |
| Last released `v*` tag | Yes | — |
| Anything older | No | Upgrade to the last release |

## Reporting a vulnerability

**Do not open a public issue or PR for a security vulnerability.**

- Use GitHub's private disclosure:
  **`N0moreher0/Venira-mcp` → Security → Advisories → New draft**.
- Or email the maintainer: `vominhtu156@gmail.com` (see commit history).
- Include: minimal repro, affected version, and any workaround you found.

We aim to **acknowledge within 72 hours** and **resolve within 14 days** for
critical issues. We will credit you in the advisory unless you ask otherwise.

## Threat model (what this project does and does not defend against)

This MCP server runs with the privileges of the user that started it and
is designed for **trusted, local use** (your own machine, your own agent).
It is *not* a network-facing service. Understand the boundaries before
deploying:

### What is defended

- **Workspace path lock.** Every path is resolved against `VENIRA_WORKSPACE`
  (or `process.cwd()`). `../` and absolute paths that escape it are rejected
  with `path_escape`. This is a *first-line* guard, not a sandbox.
- **Cache correctness.** Read/info caches are validated by `mtime + size`,
  so an external edit or delete can never silently serve stale content.
- **Audit integrity.** Every operation is written to a SQLite WAL table.
  `project_health` surfaces orphan `running` rows as a post-mortem signal.
- **Native module supply chain.** `better-sqlite3` is the only native
  dependency; its build scripts are allowlisted via `npm approve-scripts`
  so an npm v12 install can't be tricked into running an unapproved script.

### What is NOT defended (by design, in scope of a local tool)

- **Prompt injection / malicious commands.** A malicious model output or a
  poisoned file it reads can still steer the agent to run a destructive
  shell command (`rm -rf`, `format`, …). The workspace lock bounds
  *filesystem* paths, not shell *side effects*. The audit log makes this
  visible *after* the fact.
- **Running the server as root / in a shared environment.** If the MCP
  client (OpenCode, etc.) runs the server in a context that can reach other
  users' data, the workspace lock does not isolate you from them.
- **The MCP transport itself.** stdio transport is local; if you ever proxy
  it over a network, that layer's authn/z is out of scope for this project.

### Historical context

The broader MCP / agentic-coding ecosystem has seen several classes of
incident that are relevant here even though this project has not been
directly affected:

- **OpenCode "RCE flaw"** — an input-validation gap in an agentic coding
  harness that let a crafted workspace file steer the tool-execution
  pipeline into running attacker-chosen commands. The mitigation pattern:
  validate *and* log every tool argument at the boundary, and never trust
  content read from the workspace as a command. venira-mcp-coding keeps
  tool arguments schema-checked (zod) and the audit table as the
  post-hoc record.
- **Agent / sandbox escape (e.g. "harness"-style escapes)** — agents that
  can write files or run shell can, in an over-permissive sandbox,
  escalate. If you run this server inside a sandbox, treat
  `project_shell_run` as the highest-risk tool and consider dropping
  `VENIRA_DEFAULT_SHELL` to a restricted profile, or running the whole
  server in a container (see `DOCKER.md`).
- **npm supply-chain (install-time code execution)** — malicious or
  typosquatted dependencies running lifecycle scripts at install time.
  This is why the project pins its native dependency's script allowlist
  (`allowScripts`) and ships an `npm approve-scripts`-generated manifest.
  Renovate is configured to flag vulnerability advisories.

## Hardening checklist for operators

1. **Lock the workspace.** Leave `VENIRA_UNRESTRICTED` unset (or `0`).
   Only set it to `1` in a fully disposable environment.
2. **Contain the shell.** If you don't need arbitrary commands, set
   `VENIRA_DEFAULT_SHELL` to a restricted shell, or run the server in a
   container and accept that shell commands execute *inside* it.
3. **Review the audit trail.** Periodically query `project_tool_audit`
   (or run `project_health` with `include_audit`) to confirm what the
   agent actually did.
4. **Least-privilege user.** Run the MCP client (and thus this server)
   as a regular user, not root.
5. **Update dependencies.** Renovate auto-opens PRs for vulnerability
   advisories; keep them green.
6. **Verify checksums** when using the release bundles
   (`.zip` / `.tgz` / Docker image) — SHA-256 values are published in
   every GitHub Release body.

## Security-related environment variables

| Variable | Default | Security note |
|---|---|---|
| `VENIRA_UNRESTRICTED` | `"0"` | `"1"` removes the workspace lock. Highest-risk setting. |
| `VENIRA_DEFAULT_SHELL` | platform default | Pick the least-capable shell that meets your needs. |
| `VENIRA_DATA_DIR` | `<workspace>/data` | Must be writable by the server user; don't point it at a shared dir. |
| `VENIRA_SESSION_ID` | auto | Set it in tests so audit rows are separable. |
