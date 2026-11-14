# Security Policy — venira-mcp

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
- **Audit integrity.** Every operation is written to a SQLite WAL table with a
  keyed hash chain (`prev_hash`/`row_hash`, HMAC-SHA256 with `audit.key` in the
  data dir). `read_audit verify=1` recomputes the digest of the fields
  that are immutable after insert, so in-place edits or a rewritten chain fail
  verification unless the attacker also has the key file. Legacy databases with
  a required `created_at` column are supported in place; `health`
  surfaces orphan `running` rows as a post-mortem signal.
- **Secret store integrity.** Secret values are encrypted with AES-256-GCM and
  the secret name is bound in as AAD (swapping ciphertext between two names
  fails authentication). The metadata fingerprint is a keyed HMAC, not a plain
  SHA-256, so a leaked `secrets.json` cannot be brute-forced offline for
  low-entropy values. Read-modify-write operations run under a cross-process
  lock, so concurrent `set` calls cannot silently drop each other.
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
- **A local attacker with access to `VENIRA_DATA_DIR`.** The audit chain and
  approval grants are HMAC-signed with keys kept in that directory. This stops
  DB-only or file-store-only tampering, but the same OS user (or root) can read
  the keys and re-sign anything. Use a separate account/container if that
  matters.
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
  content read from the workspace as a command. venira-mcp keeps
  tool arguments schema-checked (zod) and the audit table as the
  post-hoc record.
- **Agent / sandbox escape (e.g. "harness"-style escapes)** — agents that
  can write files or run shell can, in an over-permissive sandbox,
  escalate. Treat `shell_run` as the highest-risk tool. Choose
  `VENIRA_SECURITY_PROFILE=strict` or `balanced` for a more restrictive
  approval posture, or run the whole server in a container (see `DOCKER.md`).
- **npm supply-chain (install-time code execution)** — malicious or
  typosquatted dependencies running lifecycle scripts at install time.
  This is why the project pins its native dependency's script allowlist
  (`allowScripts`) and ships an `npm approve-scripts`-generated manifest.
  Renovate is configured to flag vulnerability advisories.

## Hardening checklist for operators

1. **Lock the workspace.** Leave `VENIRA_UNRESTRICTED` unset (or `0`).
   Only set it to `1` in a fully disposable environment.
2. **Contain the shell.** Choose `VENIRA_SECURITY_PROFILE=strict` for the
   read-only allowlist, or `balanced` to require approval for ask-rule and
   unclassified commands. Use a container when you need an OS-level boundary.
3. **Keep shell overrides off by default.** If one is necessary, enable only the named
   exception and review its per-call reason and `policy_rule` in the audit trail.
4. **Review the audit trail.** Periodically query `project_tool_audit`
   (or run `health` with `include_audit=1`) to confirm what the
   agent actually did.
5. **Least-privilege user.** Run the MCP client (and thus this server)
   as a regular user, not root.
6. **Update dependencies.** Renovate auto-opens PRs for vulnerability
   advisories; keep them green.
7. **Verify checksums** when using the release bundles
   (`.zip` / `.tgz` / Docker image) — SHA-256 values are published in
   every GitHub Release body.

## Approval model

Shell and JavaScript approval requests return a common `data.approval` payload, including the pending `approval_id`, the reviewed subject, expiry, approve command, and retry arguments. Only a human can grant by running the exact `data.approval.approve_command` from the response in an interactive PowerShell terminal or through MCP client elicitation; grants are HMAC-verified, bound to the exact call, expire after five minutes, and are single-use. Consumption is an atomic claim: if two retries race with the same id, exactly one runs. The pending record's displayed command/shell/cwd/secret_env must match the signed binding, so tampering with the record invalidates it. A `--session` grant is in-memory, lasts 10 minutes by default (`VENIRA_SHELL_APPROVAL_TTL_MS`), and is cleared by a server restart. The removed `approval_token` and `VENIRA_SHELL_AUTO_APPROVE_TOKEN` paths cannot approve a request; the legacy environment variable is ignored with a warning.

## Configuration posture

`health` (and `doctor`) report a shared `posture` object with a `level` (`ok` / `info` / `warning` / `critical`), deterministic findings carrying stable ids such as `workspace.unrestricted`, `profile.off`, `shell.mode_off`, `shell.mode_permissive`, `js.exec_without_approval`, `combo.unrestricted_open_shell`, `combo.unrestricted_unapproved_js`, `approval.session_grant_risky_rule`, `self_install.enabled`, `secret.reveal_enabled` and `git.plain_http_allowed`. Findings are warnings only (`fail_closed: false`): an invalid profile/mode/boolean already fails closed at startup, while the combinations above are valid operator choices. Making them refusals would break existing trusted/off deployments; revisit only with measured demand for an acknowledgement gate.

## Security-related environment variables

| Variable | Default | Security note |
|---|---|---|
| `VENIRA_UNRESTRICTED` | `"0"` | `"1"` removes the workspace lock. Highest-risk setting. |
| `VENIRA_SECURITY_PROFILE` | `balanced` | `strict` is most restrictive; `balanced` is recommended; `trusted` lets ask-rule and unclassified commands run and turns hard-deny into approval; `off` disables shell checks and per-call JS approval. |
| `VENIRA_SHELL_MODE` | Profile mapping | Advanced override: `strict`, `balanced`, `permissive`, or `off`. |
| `VENIRA_JS_EXEC_MODE` | `"off"` | `execute_js` gate: `off` hides it, `ask` per-call approval (contained), `semi-auto` no approval (contained: network blocked, workspace-only fs, scrubbed env), `auto` no approval and no containment. |
| `VENIRA_SHELL_OVERRIDES` | unset | Operator allowlist for specific named shell exceptions. Each tool call must pass the exact name and a reason; the reason is redacted and audited, but is not proof of human identity. |
| `VENIRA_DATA_DIR` | Per-user OS data directory | Contains the audit DB, encrypted secrets, approval key and pending approvals. Keep it private and don't point it at a shared directory. |
| `VENIRA_SESSION_GRANT_RULES` | `cd_outside_workspace` | Additional rules eligible for human-approved session grants. Do not include network or history-rewrite rules unless the environment is disposable. |
| `VENIRA_SHELL_APPROVAL_TTL_MS` | `600000` (10 min) | Lifetime of an in-memory `--session` grant. Pending approvals are always fixed at 5 minutes. |
| `VENIRA_SESSION_ID` | auto | Set it in tests so audit rows are separable. |

Boolean environment flags and boolean-like MCP tool arguments accept only numeric `0` or `1`. Invalid legacy spellings fail explicitly; provider workflow input booleans are data and are not changed.
