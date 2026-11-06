# venira-mcp — Shell Security

Status: implementation complete for the v1.15.0 approval/profile work. Local validation last run 2026-11-06; see the commands and results below. Shell policy is a guard rail, not an OS sandbox.

## Security profiles

`VENIRA_SECURITY_PROFILE` selects the baseline. Unset means `balanced`; unknown values fail startup validation.

| Profile | Shell mode | JavaScript approval | Behavior |
|---|---|---|---|
| `strict` | `strict` | on | Safe workspace commands and the read-only allowlist run; other commands ask; hard-deny rules deny |
| `balanced` (default) | `balanced` | on | Routine safe commands run; ask rules and unclassified commands ask; hard-deny rules deny |
| `trusted` | `permissive` | on | Ask-rule and unclassified commands run; hard-deny commands ask for approval |
| `off` | `off` | off | Shell checks are bypassed with a startup warning and audit record; use only in a trusted environment |

`VENIRA_SHELL_MODE` and `VENIRA_JS_EXEC_APPROVAL` are advanced overrides. `VENIRA_ALLOW_JS_EXEC=1` is still required to register the JavaScript tool. The `secret_env` injection gate always requires approval, including in `off`.

## Approval lifecycle

All gated shell and JavaScript calls use the same approval core:

1. The server creates a pending `approval_id` bound to the exact command or code, shell, cwd, rule, and secret environment names.
2. A human grants it through the interactive `npx venira-mcp --approve <id>` CLI or client elicitation. The CLI requires a TTY.
3. The agent retries once with that `approval_id`. Grants are HMAC-verified, expire after five minutes, and are single-use.

There is no agent-redeemable `approval_token` or `VENIRA_SHELL_AUTO_APPROVE_TOKEN`; the legacy environment variable is warned about and ignored. Responses include a shared `data.approval` payload with a ready-to-use retry shape. `approval_wait_ms` can keep a call open for up to 45 seconds while the human grants it.

`project_shell_run.dry_run=1` reports the policy result without running the command or creating an approval. Hard-deny behavior is: `strict` and `balanced` deny; `trusted` asks; `off` bypasses shell policy. Deny always wins over ask rules except in the explicitly permissive `trusted` posture, where a hard-deny match requires a grant.

## Implementation milestones

- [x] Parse shell commands and inspect compound commands, operators, and paths conservatively.
- [x] Apply built-in and explicitly selected policy-file allow/ask/deny rules.
- [x] Preserve hard-deny behavior in `strict` and `balanced`; make `permissive` request approval for hard-deny matches.
- [x] Use one approval core for shell and JavaScript execution; remove the legacy auto-approval token path.
- [x] Add profile mapping, env overrides, health reporting, warnings, dry-run, and bounded approval wait.
- [x] Bound process runtime/output, kill process trees, scrub environment, and pin cwd to the workspace.
- [x] Cover security regressions and approval/profile behavior in the verification suite.

## Local validation

Run from the repository root:

```powershell
npm run build
npm run verify
npm run check:docs
npm run doctor
```

Validation results (2026-11-06): build passed; verify passed 445 checks, including provider-secret guard, GitHub Device Flow, and shell-security regressions; policy corpus passed 270/270; docs check passed; doctor passed 14/14. Remote CI passed on Linux, Windows, and macOS with Node 20/22 for the release candidate (run #179) and final roadmap revision (run #180, attempt 2); release workflow #64 published tag `v1.15.1`, GitHub Release, Docker image, and `venira-mcp@1.15.1`. The original feature release `v1.15.0` is also available. CI for a newly committed revision still requires that revision to be pushed and run by the configured provider.

## Limits

Shell policy is not a sandbox. A process running as the same OS user can still affect anything that user can access. Use a separate account, container, or VM for untrusted workspaces. Keep `VENIRA_UNRESTRICTED` unset, keep named shell overrides disabled unless needed, and review the audit trail.
