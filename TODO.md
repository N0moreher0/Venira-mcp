# VENIRA MCP CODING — TODO LIST (standalone v1.0.0 → v1.5.0)

> Standalone: pure-Node backend, no external binary.
> Each item lists effort (low/med/high), priority (P0/P1/P2/P3), and status.

## 📊 Current state (standalone v1.5.0)

- ✅ 100% of the logic has been moved to Node (no more Rust corehost)
- ✅ Audit via SQLite WAL using `better-sqlite3` (replaces `node:sqlite`)
- ✅ Native shell via `child_process` (no Rust required)
- ✅ 37 tools working, verify 218/218 PASS, doctor 12/12 PASS
- ✅ Checkpoints (`project_snapshot`: create/list/restore/delete, content-addressed, git-free rollback)
- ✅ Audit reasons: mutating tools accept `reason` ("why"), stored in `project_tool_audit.reason` and returned by `project_read_audit`
- ✅ Git provider (`project_pr_create` / `project_pr_comment` / `project_pr_merge`) over GitHub REST — no `gh` binary
- ✅ CI provider (`project_ci_status` / `project_ci_trigger` / `project_ci_logs`) over GitHub Actions — ZIP logs parsed in memory
- ✅ Secrets (`project_secret`: get/set/list/delete) — AES-256-GCM at rest, metadata-only reads, `secret_env` injection, value redaction
- ✅ Secret rotation metadata — `expires_at`/`expires_in_days`, `days_left`, `last_used_at`, `use_count`, `rotated_at`; expired secrets refused (`secret_expired`) before a child starts or a provider call
- ✅ Inline PR review comments — `project_pr_comment` with `path` + `line` (+ `start_line`, `side`, `commit_id`)
- ✅ Branch-protection check-runs — `project_ci_status` with `ref` / `pr` → `GET /commits/{ref}/check-runs`
- ✅ `search_cache_invalidated` fix (0-hit results are no longer cached)
- ✅ Dual license: MIT + Apache-2.0
- ✅ CI/CD GitHub Actions (no more Rust build needed)
- ✅ `package.json`: added `better-sqlite3`, `@types/better-sqlite3`, `engines: node >=20`
- ✅ Cache control environment variables added
- ✅ Request tracing environment variables added
- ✅ Read audit log tool implemented
- ✅ Shell UX upgrade implemented
- ✅ P2 code intelligence: `project_outline_symbol` / `project_file_symbols`
- ✅ P2 fuzzy edit + SQLite recent files index
- ✅ P3 code intelligence: `project_diff_files`, `project_symbol_references`, `project_selective_search`
- ✅ P3 diagnostics + planning: `project_explain_error` (deterministic rule table → next actions) and `project_plan_read_batch` (task → ready read batch) — no model call needed

## 🕒 Full timeline (v1.0.0 → v1.5.0)

The whole history in order — what shipped, when, and why.

| Date | Version | Milestone |
|---|---|---|
| 2026-10-27 | **v1.0.0** | **Standalone rewrite.** The Rust `corehost` binary + JSON-Lines IPC replaced by an in-process pure-Node backend (`lib/corehost.ts`): SQLite WAL audit (`better-sqlite3`), native shell via `child_process` with process-tree kill, async shell runs, capability scope, structured envelopes with hints, validated read caches, batch reads. Ships as `npm i venira-mcp` — no binary, no GUI. |
| 2026-10-27 | v1.0.0 | Repo translated to English (code comments, tool descriptions, TODO, roadmap docs). |
| 2026-10-28 | v1.0.1–v1.0.7 | Release plumbing: npm metadata + OIDC trusted publishing, Docker multi-stage image, `--version`/`--help`, doctor works from any directory, zod 4 + MCP SDK 1.32 (security advisory), standard `LICENSE-MIT`/`LICENSE-APACHE`, `scripts/` shipped in the image, package renamed to `venira-mcp` (bins `venira` + `venira-mcp`). |
| 2026-10-28 | v1.1.0 | Shell policy hardening: `balanced`/`strict`/`permissive`/`off`, HMAC-signed single-use approval tokens, session grants, policy file only from an explicit env path (never the workspace). |
| 2026-10-28 | v1.1.3 | `project_execute_js` — sandboxed synchronous JS inside the workspace (whitelisted env, output caps). |
| 2026-10-28 | v1.1.7 | Audit writer compatible with legacy DB schemas (in-place migration instead of failed writes). |
| 2026-10-28 | v1.1.9 | CLI `--workspace/-w` + `--data-dir` (no config switching between projects), `VENIRA_PERMISSION_MODE`. |
| 2026-10-28 | **v1.2.0** | P1: cache controls (`VENIRA_CACHE_ALL`, `VENIRA_CACHE_LIST_ONLY`, `VENIRA_CACHE_SEARCH_ONLY`), request tracing (`VENIRA_TRACE` / `VENIRA_TRACE_FILE` / `project_trace_status`), `project_read_audit`, shell UX (`VENIRA_SHELL_TAIL_MAX`, `VENIRA_SHELL_EXIT_EARLY`, `VENIRA_SHELL_TIMEOUT_POLICY`, `project_shell_cancel_session`). Verify/doctor raised to 25 tools. |
| 2026-10-28 | **v1.3.0** | P2/P3 code intelligence: `project_outline_symbol`, `project_file_symbols`, `project_diff_files`, `project_symbol_references`, `project_selective_search`; fuzzy edit (`VENIRA_EDIT_FUZZY`); SQLite recent-files index (`project_file_index`, index-first + bounded fallback). |
| 2026-10-29 | (post-1.3.0) | P2.5 self-install: `project_detect_harnesses` + `project_install_self` (OpenCode / Claude / Cursor / Codex / Kimi / DeepSeek / Antigravity) with atomic config merge + backup. |
| 2026-10-29 | **v1.4.0** | **Checkpoints + audit reasons + Git/PR + CI + encrypted secrets.** `project_snapshot` (content-addressed, deduplicated, sha256-verified rollback), `reason` on every mutation stored in the audit trail, GitHub pull-request + Actions tools, AES-256-GCM secret store with `secret_env` injection, network safety layer. **35 tools**, verify **186/186**. |
| 2026-10-29 | **v1.5.0** | **Inline review comments + check-runs + secret rotation + deterministic diagnostics.** `project_pr_comment` pins notes to a file/line; `project_ci_status` reads branch-protection check-runs (`ref`/`pr`); secret rotation metadata with expiry enforcement; `project_explain_error` (rule table → next actions) and `project_plan_read_batch` (task → ready batch). **37 tools**, verify **211/211**. |
| 2026-10-29 | **v1.5.1** | **Inline review-comment fix (found by live E2E).** GitHub requires `commit_id` with `line` (bare `line` → 422 "line is not a permitted key"); `project_pr_comment` resolves the PR head sha automatically and honours an explicit `commit_id`. Verify **212/212**. |
| 2026-10-29 | **v1.5.2** | **Read-planner artifact filter (found by the E2E re-run).** The audit DB (`data/venira.db`, 36 hits) outranked source in `project_plan_read_batch`; candidates now exclude build/vendor dirs and DB/log/binary extensions. Verify **214/214**. |
| 2026-10-29 | **v1.5.3** | **Read-planner ranking (found by the post-restart bench).** File-name search per keyword (+ snake→kebab retry) so a task naming a file finds that file; scoring = hits + path/name match; prose demoted unless the task asks for docs; lockfiles dropped; calibrated `estimated_ms`. Verify **217/217**. |
| 2026-10-29 | **v1.5.4** | **Planner never proposes secrets (found by the v1.5.3 E2E loop).** A secret task ranked `data/secrets.json` + `data/secrets.key` into the top 6; candidates now exclude `.env*`, `secrets.*`, `*.key/.pem/.p12/.pfx/.jks/.keystore`, `id_rsa`, `.npmrc/.netrc`, `credentials.json`. Verify **218/218**. |

## 🎯 Implementation Roadmap

### Phase 1: Cache Control (P1) ✅
- [x] VENIRA_CACHE_ALL=0 → disable every cache ("absolutely fresh" mode for strict users)
- [x] VENIRA_CACHE_LIST_ONLY=0, VENIRA_CACHE_SEARCH_ONLY=0 → per-type toggles
- [x] Update project_health → report cache_enabled (per type)
- [x] Test: verify with VENIRA_CACHE_ALL=0

### Phase 2: Request Tracing (P1) ✅
- [x] VENIRA_TRACE=1 → log every tool call (op, args, ms, cached, ok/fail) to stderr
- [x] VENIRA_TRACE_FILE=... → write logs to a file (rotating, max 10MB)
- [x] Add tool "project_trace_status" → view the last 5 traces (no file read)
- [x] Doctor: check trace config, file size

### Phase 3: Read Audit Log (P1) ✅
- [x] Tool "project_read_audit" → read the audit log (last 20 rows by default, filter by session/op)
- [x] Backend: query the DB with better-sqlite3 (like project_health does)
- [x] If the DB is locked (WAL write from another process): fall back to "audit_unavailable" (do not crash)
- [x] Verify: audit_rows_present, read_audit_returns_last_20
- [x] Doctor: add a check for "read_audit tool reachable"

### Phase 4: Shell UX Upgrade (P1) ✅
- [x] VENIRA_SHELL_TAIL_MAX=4096 (configurable, default 4000)
- [x] VENIRA_SHELL_EXIT_EARLY=1 (if exit_code is available, return early without waiting for wait_seconds)
- [x] VENIRA_SHELL_TIMEOUT_POLICY=soft|hard (soft: warn, hard: kill)
- [x] Tool "project_shell_cancel_session" → cancel ALL shell runs for the session
- [x] Cancel safety: verify that no "orphaned" runs are left in the DB

## 🚀 New Tools to Add (P2 - Aug 2025)

### P2: Fuzzy Edit (effort: high, 8-12h) ✅
- [x] VENIRA_EDIT_FUZZY=1 → allow old_text_fuzzy (fuzzy match, Levenshtein/whitespace-tolerant)
- [x] Algorithm:
    - Normalize whitespace (collapse spaces/tabs, ignore leading indent if ignore_indentation=true)
    - Fuzzy match (Levenshtein distance <= N, N = fuzzy_distance, default 3)
    - Return best match (when several exist, the lowest-distance one wins)
- [x] New args: { old_text_fuzzy?, ignore_indentation?, fuzzy_distance?, case_insensitive? }
- [x] Backend (lib/corehost.ts): opEditFile fuzzy fallback + findFuzzyMatch + levenshtein
- [x] Audit: records "fuzzy" in reason_code when a fuzzy match was used
- [x] Tool schema: fuzzy args added to project_edit_file in tools/project.ts

### P2: `project_recent_files` → index (effort: high, 8-12h) ✅
- [x] Backend: SQLite `project_file_index` table (path, kind, mtime_ms, size, updated_at)
- [x] Index updated on write_file, edit_file; removed on delete_path
- [x] Query: `WHERE kind='file' ORDER BY updated_at DESC LIMIT N` (no more 4000-file limit)
- [x] Node-side fallback (if the index is empty/unavailable): keep the current bounded scan
- [x] `queryRecentFiles()` exported from lib/corehost.ts
- [x] `runRecentFiles` in tools/project.ts: SQLite index first, fallback scan second
- [x] Response `source` field: `"index"` | `"fallback_scan"`

### P2: `project_outline_symbol` (effort: medium, 5-6h) ✅
- [x] Backend: parse a file → outline (symbols + hierarchy, no cross-file needed)
- [x] Args: { relative_path, language? (rs/py/ts/js/go...), include_functions?, include_classes? }
- [x] Data: { symbols: [{ name, kind, line, signature, doc_comment? }] }
- [x] Cache: by mtime (Node-side)
- [x] Implementation in `lib/symbol-diff.ts` (extractSymbols, buildOutline)
- [x] Tool registration in `tools/project.ts` (runOutlineSymbol, runFileSymbols)

## 🚀 New Tools to Add (P3 - Oct 2025)

### P3: `project_diff_files` (effort: high, 10-15h) ✅
- [x] Backend (lib/corehost.ts): diff two files (unified diff, git style)
- [x] Args: { relative_path_a, relative_path_b, context_lines?, max_lines? }
- [x] Data: { lines_added, lines_removed, unified_diff, truncated }
- [x] Use case: "compare two versions", "review changes"
- [x] Implementation in `lib/symbol-diff.ts` (diffUnified function)
- [x] Tool registration in `tools/project.ts` (runDiffFiles)

### P3: `project_file_symbols` (effort: high, 10-15h) ✅
- [x] Backend: parse a file and extract symbols (fn/def/class/struct) by language
- [x] Args: { relative_path, language? (rs/py/ts/js/go...), include_functions?, include_classes? }
- [x] Data: { symbols: [{ name, kind, line, signature, doc_comment? }] }
- [x] Cache: by mtime (Node-side)
- [x] Implementation in `lib/symbol-diff.ts` (extractSymbols, buildOutline)
- [x] Tool registration in `tools/project.ts` (runFileSymbols)

### P3: `project_symbol_references` (effort: high, 15-20h) ✅
- [x] Backend: find all references to a symbol (based on file_symbols + cross-file)
- [x] Args: { symbol_name, language?, scope? (file/workspace), kind? }
- [x] Data: { references: [{ relative_path, line_number, context }] }
- [x] file scope: bounded regex search within the file
- [x] workspace scope: uses content search via "search" op
- [x] Tool registration in `tools/project.ts` (runSymbolReferences)

### P3: `project_explain_error` (effort: high, 10-15h) ✅
- [x] Rule-based (no model call): error block / log tail → cause + fixes + ready next tool calls
- [x] Args: { error_text?, log_tail?, language? }
- [x] Data: { matched, summary, error_line, language, diagnoses[] {rule_id, likely_cause, suggested_fix, retry_hint, next_actions}, next_actions }
- [x] Implementation in `lib/diagnostics.ts` (~28 signatures: errno, TS/JS, Python/pytest, git, npm, GitHub 401/403/429, SQLite, venira codes)
- [x] Tool registration in `tools/project.ts` (runExplainError); unknown input returns `matched: false` (never an error)

### P3: `project_plan_read_batch` (effort: medium, 4-6h) ✅
- [x] Deterministic planner: keywords → bounded content searches → ranked candidates → a ready `project_read_batch` request
- [x] Input: { task_description, files_hint?, max_files?, include_search? }
- [x] Output: { task, keywords, searched, candidates, steps[{tool, arguments, why}], estimated_ms, notes }
- [x] Implementation in `lib/read-plan.ts`; falls back to the recent-files index / tree map when keywords are thin
- [x] Artifact filter: build/vendor dirs + DB/log/binary extensions never rank as read targets
- [x] Secret filter: credentials/key material (`.env*`, `secrets.*`, `*.key/.pem`, `id_rsa`, …) never rank as read targets
- [x] Ranking: file-name search per keyword (+ snake→kebab retry), score = hits + path/name match, prose weight 0.3 unless the task mentions docs, lockfiles excluded
- [x] `estimated_ms` calibrated from the bench (6-file batch ≈ 62 ms)
- [x] Tool registration in `tools/project.ts` (runPlanReadBatch); outline step for files > 256 KB

### P3: `project_selective_search` (effort: high, 8-10h) ✅
- [x] "Smart" search: combine multiple queries (AND/OR/NOT), fuzzy, scoring
- [x] Args: { queries: [{ pattern, must?, weight? }], limit }
- [x] Data: { hits, scores, matched_queries }
- [x] Implementation in `lib/symbol-diff.ts` (selectiveSearch function)
- [x] Tool registration in `tools/project.ts` (runSelectiveSearch)

## 🚀 Provider Tools (Oct 2026) ✅

### Git / PR provider (`lib/git-provider.ts`) ✅
- [x] `project_pr_create` — `title`, `head` (default: current branch), `base` (default: repo default branch, cached 5 min), `body`, `draft`, `repo`
- [x] `project_pr_comment` — `pr` accepts a number or a PR URL; `body` markdown
- [x] `project_pr_merge` — `method: merge|squash|rebase`, `commit_title`, `commit_message`, `delete_branch`
- [x] Repo resolution: `repo` arg → `VENIRA_GITHUB_REPO` → `.git/config` origin (worktrees via `commondir`)
- [x] Token resolution: secret `GITHUB_TOKEN` → `VENIRA_GITHUB_TOKEN` → `GITHUB_TOKEN` → `GH_TOKEN`
- [x] Error mapping: `auth_missing`, `auth_failed`, `not_found`, `conflict`, `rate_limited`, `forbidden`, `timeout`
- [x] Already-merged/closed PR returns `already_merged` (not an error); branch delete is best-effort

### CI provider (GitHub Actions) ✅
- [x] `project_ci_status` — runs for branch/workflow (`limit` ≤ 50) or one run + its jobs; `overall` summary
- [x] `project_ci_trigger` — `workflow_dispatch` with `ref` + ≤ 10 validated `inputs`
- [x] `project_ci_logs` — whole run (in-memory ZIP: EOCD + central dir, stored/deflate) or one job; `tail_lines`/`max_bytes` caps
- [x] Archive caps: 32 MB archive, 4 MB/entry, 8 MB text, default `tail_lines=500` / `max_bytes=512KB` (cap 4MB)
- [x] Redirect handling drops `Authorization` when the origin changes (pre-signed blob URL)

### Secrets (`lib/secrets.ts`) ✅
- [x] `project_secret` — one tool, `action: get|set|list|delete` (same action pattern as `project_snapshot`)
- [x] AES-256-GCM at rest (`<data>/secrets.json` + `<data>/secrets.key`, 0600, atomic temp+rename)
- [x] `get`/`list` metadata only (`length`, `sha256_12`, `updated_at`); plaintext requires `reveal=true` **and** `VENIRA_SECRET_ALLOW_REVEAL=1`
- [x] `value_env` alternative keeps the value out of tool arguments entirely
- [x] `project_shell_run secret_env: string[]` (≤ 16) — decrypted **after** approval, injected into the child env
- [x] Loader-hijack denylist (`NODE_OPTIONS`, `LD_PRELOAD`, `DYLD_*`, `PYTHONSTARTUP`, `PYTHONPATH`, `BASH_ENV`, `ENV`, `PROMPT_COMMAND`, `GIT_SSH_COMMAND`)
- [x] `redactSecretValues` scrubs values (≥ 8 chars) from shell tails + audit `command`/`reason`
- [x] Secret store excluded from checkpoints/restore/`delete_extra`

### Network safety ✅
- [x] `VENIRA_NETWORK=0` kill switch → `network_disabled` before a socket is opened
- [x] `VENIRA_GITHUB_API_URL` must be https (http only for localhost / `VENIRA_GITHUB_ALLOW_HTTP=1`)
- [x] `node:http(s)` client with timeouts, response caps, manual redirects (no global `fetch`)
- [x] e2e mock (`scripts/github-mock.ts`): API origin + second-origin blob server, records auth headers

## 🚀 v1.5.0 Additions (Oct 2026) ✅

### Inline PR review comments ✅
- [x] `project_pr_comment` + `path` + `line` → `POST /repos/{o}/{r}/pulls/{n}/comments` (pins the note to the diff)
- [x] Optional `start_line` (multi-line range), `side: RIGHT|LEFT`, `commit_id` (defaults to the PR head)
- [x] `commit_id` is resolved from the PR head sha when omitted (GitHub requires it with `line`; bare `line` → 422)
- [x] Validation: `line`/`start_line` without `path` (and `path` without `line`) → `invalid_request`; `start_line <= line`
- [x] Result carries `inline: true`, `path`, `line`, `start_line`, `side`, `commit_id`

### Branch-protection check-runs ✅
- [x] `project_ci_status` + `ref` (sha/branch) or `pr` (resolved to the head sha) → `GET /commits/{ref}/check-runs`
- [x] `overall`: `success | failure | in_progress | no_checks`; `check_runs[]`: name, status, conclusion, app, url, summary
- [x] Ref validation (`[A-Za-z0-9._/-]`, max 200, rejects `..`) before the URL is built
- [x] Actions mode (`branch` / `workflow` / `run_id`) unchanged

### Secret rotation metadata ✅
- [x] `SecretMeta`: `expires_at`, `expired`, `days_left`, `last_used_at`, `use_count`, `rotated_at`
- [x] `action=set` accepts `expires_in_days` (1..3650) or `expires_at` (epoch ms / ISO-8601); both → `invalid_request`
- [x] A re-`set` is a rotation: overwrite, reset the use counter, keep the previous expiry unless a new one is given
- [x] Expiry enforced at injection (`secret_env` + provider token) before decryption → `secret_expired` + rotate hint
- [x] Use tracking is fire-and-forget (1 s debounce per name); a metadata write failure never fails the call

### Deterministic diagnostics + planning ✅
- [x] `lib/diagnostics.ts` — ~28 rule signatures → cause, fixes, retry hint, deduped `next_actions`
- [x] `lib/read-plan.ts` — quoted phrases/identifiers/words → up to 3 bounded searches → ranked candidates → ready batch
- [x] Both are pure local logic: no model call, no network, no file contents in the response

## 📝 Notes for "strict" / "absolute" users

| Problem | Config to be "absolute" |
|---|---|
| Stale cache | `VENIRA_CACHE_ALL=0` |
| Blind-edit failure | Pipeline: read → edit (always) + `expected_sha256` |
| Fuzzy edit | `VENIRA_EDIT_FUZZY=1` (P2) |
| Shell timeout | `VENIRA_SHELL_TIMEOUT_POLICY=hard` |

## 🧪 Test plan (next)
- ✅ `verify.ts`: audit mode, cache control, trace, read_audit, checkpoints, PR/CI/check-runs, inline comments, secrets/rotation, diagnostics + planning, network (218 checks)
- `bench-mcp.ts`: add a "fresh mode" scenario (VENIRA_CACHE_ALL=0) vs "default"
- ✅ `doctor.ts`: checks for the P1 env vars + provider/secret config surface

## 🚧 v1.6.0 — configurable git layer (plan) ✅

Goal: the git tools stop being GitHub-only and stop baking constants into the binary.

- [x] **Config precedence** — call args → `venira.config.json` → `VENIRA_GIT_*` env → default; one resolver (`lib/git-config.ts`)
- [x] **Provider selection** — `VENIRA_GIT_PROVIDER` / `git.provider` / inferred from the `origin` host (`github.com`, `gitlab.*`, `bitbucket.*`)
- [x] **Tokens** — `git.secret` / `git.repos[repo].secret` / `VENIRA_GIT_SECRET_NAME`, env chain per provider, optional `username` (Bitbucket Basic)
- [x] **HTTP knobs** — `timeout_ms`, `log_timeout_ms`, `max_bytes`, `max_redirects`, `retries` (GET only), hard safety ceilings
- [x] **Proxy** — `VENIRA_GIT_PROXY` > `HTTPS_PROXY` > config, `NO_PROXY` matching, CONNECT tunnel for https
- [x] **GitLab dialect** — MR create/comment/merge/list/close/reopen; pipelines status/trigger; job trace logs
- [x] **Bitbucket Cloud dialect** — PR create/comment/merge/list/decline/reopen; pipelines status/trigger; step logs
- [x] **New tools** — `project_pr_list`, `project_pr_close`, `project_pr_reopen` (40 tools)
- [x] **Tests** — mocks per dialect, config precedence, proxy/NO_PROXY, retries, cap ceilings
- [x] **Docs** — README env table + §4.6/§4.7/§4.9, roadmap rows, changelog, tag `v1.6.0`

## 🚧 v1.7.0 — safety gaps & actionable errors (plan)

Goal: close the gaps found in a source review of v1.6.0 (the safety promises in README §6 must hold in code) and make every failure tell the agent exactly what to do next. Nothing here is implemented yet; each item lists priority and rough effort.

### A. Safety gaps (P0)
- [ ] **Enforce `VENIRA_ALLOW_JS_EXEC`** (P0, low). The README documents it, but no code reads it (only `lib/self-install.ts` writes `"1"` into harness configs). Check it at the top of `runExecuteJs`, skip registering the tool when it is `0`, and **change the default to `0`**. Add a verify check: with `0`, `project_execute_js` is absent from `tools/list` and a direct call returns `unsupported`.
- [ ] **Put `project_execute_js` behind the same policy gate as `project_shell_run`** (P0, med), or document loudly that it sits outside shell policy and the workspace lock (the spawned `node` can use `fs`/`child_process` anywhere). Until then it undermines every `ask`/`deny` rule.
- [ ] **Shared `isProtectedPath()` guard** (P0, med). `secrets.json`, `secrets.key`, `venira.db` (+ `-wal`/`-shm`) must be refused by *every* path-taking op (`read_file`, `read_ranges`, `read_batch`, `search`, `selective_search`, `list_files` content views, `write`/`edit`/`create`/`delete`, `diff_files`, `symbol_references`) with `sensitive_result`. Today only `read-plan.ts` (ranking) and `snapshots.ts` (skip list) know about them, so `project_read_file({ relative_path: "data/secrets.key" })` works.
- [ ] **Default data dir outside the workspace** (P0, med). Use the OS user-data dir (`%LOCALAPPDATA%\venira`, `~/.local/share/venira`, `~/Library/Application Support/venira`); keep `VENIRA_DATA_DIR` / `--data-dir` as overrides; migrate an existing `<workspace>/data` on first start with a notice. Keeps the key and ciphertext away from anything an agent can read and out of `git add .`.
- [ ] **Docs honesty pass on defaults** (P1, low). README §6 says "conservative by default" while `VENIRA_PERMISSION_MODE` defaults to `allow_all` and `execute_js` defaults to on; state defaults next to the controls and say plainly that the shell policy is a guardrail against mistakes, not a sandbox (it matches command text; `bash -c`, encodings and indirection can evade it).
- [ ] **Optional OS keychain backend for the secret key** (P2, high) instead of `secrets.key` on disk.

### A2. Second-pass findings (P0 unless noted)
Found by reading `lib/shell-policy.ts`, `lib/workspace.ts`, `lib/corehost.ts`, `lib/self-install.ts`.
- [ ] **Shell policy: the safe-command exemption runs before the ask rules** (P0, low). In `evaluate()` step 3, `allSafe` returns `allow` before `ASK_RULES` are consulted, and `SAFE_COMMANDS` contains `git`, `node` and `npx`. So in `balanced` *and* `strict`, a command made only of those heads (no pipe/redirect/background) is auto-allowed: `git push --force`, `git reset --hard`, `git clean -fdx`, `git branch -D` (the `git_history_rewrite` rule is unreachable for them), `node -e "..."` and `npx <any package>` (network + code execution, bypassing `network_access` / `package_mutation`). This contradicts README §6.1 and `shell-security.md`. Fix: evaluate `ASK_RULES` first, or narrow the exemption to specific subcommands (`git status|diff|log|show|add|commit|branch` without `-D`, `node <workspace file>` without `-e/--eval/-p/--print`, no bare `npx` unless `--no-install` on a workspace-local bin).
- [ ] **Policy test matrix** (P0, med). Table-driven verify check that runs the real `evaluate()` for every `HARD_DENY` and `ASK_RULES` id and for the safe-command combinations (`git push --force` -> `approval_required`, `node -e` -> `approval_required`, `git status` -> `allow`), in `balanced` and `strict`. The current 218 checks did not catch the ordering bug above.
- [ ] **Inline-code interpreters** (P1, low): extend `dynamic_execution` to `node -e/--eval/-p`, `python -c`, `bash|sh|zsh -c`, `powershell -Command/-EncodedCommand`, `cmd /c`, `deno eval`, `perl -e`, `ruby -e` -> `ask` (best effort; say so in the docs).
- [ ] **Symlink / junction containment** (P0, med). `resolveWithin` / `resolveInWorkspace` only compare normalized strings (`path.relative`); there is no `realpath` anywhere in the read/write path. A symlink (or Windows junction) inside the workspace that points outside is followed by `read_file`, `write_file`, `edit_file`, `delete_path` (listing/search skip symlinks, direct ops do not). Resolve `realpath` of the target (or of the nearest existing ancestor for creates), re-check containment, refuse writes through a symlinked parent; add verify cases for a symlink and a junction.
- [ ] **`project_install_self` has no approval or dry-run** (P0, med). It merges Venira into other harnesses' config files (OpenCode, Claude, Cursor, ...) and writes `VENIRA_PERMISSION_MODE=allow_all` and `VENIRA_ALLOW_JS_EXEC=1` (`lib/self-install.ts`), and nothing in the module or handler asks for confirmation. An agent that can call it can change the permission posture for the *next* start. Make `dry_run` the default, require the same signed approval token as `project_shell_run`, never alter security-relevant keys (`VENIRA_UNRESTRICTED`, `VENIRA_PERMISSION_MODE`, `VENIRA_SHELL_MODE`, `VENIRA_ALLOW_JS_EXEC`) on an existing entry, and write conservative values (`0`) for new installs.
- [ ] **Document approval lifetime** (P2, low): the HMAC key (`APPROVAL_SECRET`) is random per process start, so approval tokens and session grants do not survive a restart; state this in README §6.1.

### B. Edit correctness (P0)
- [ ] **No silent first-match edits** (P0, low). In `opEditFile`, when `old_text` occurs more than once and `replace_all` is not set, the code currently uses `indexOf` and edits the first match without telling the caller. Count matches first; if > 1, fail with `old_text_ambiguous` (see C) and write nothing.
- [ ] Multi-edit atomicity: all `edits[]` validated against the in-memory content before any write; on failure report the failing `index` and that nothing was written.

### C. Error clarity — structured, recoverable errors (P0/P1)
Today failures are thrown as `Error("[code] message Hint: ...")` and re-parsed in `lib/output.ts`; `[conflict]` covers both "text not found" and "file changed", and `invalid_request` rarely names the field.
- [ ] **Typed error object** (P0, med): replace string-prefixed throws with `VeniraError { code, message, retryable, data?, next_actions? }`; `errorEnvelope` serializes it as-is (keep parsing the legacy prefix as a fallback).
- [ ] **Split `conflict`** (P0, low): `old_text_not_found`, `old_text_ambiguous`, `stale_content` (keep `conflict` as an alias for one release).
- [ ] **Recovery data in `error.data`** (P1, med; hard size caps, never include content of `sensitive_result` paths):
  - `old_text_not_found`: up to 3 nearest candidates (reuse `findFuzzyMatch`/LCS) with line numbers and a short note on the difference (indentation, trailing whitespace, line endings, case).
  - `old_text_ambiguous`: up to 5 match locations (line + 2 lines of context) and a hint to extend `old_text` or set `replace_all`.
  - `stale_content`: current `sha256` + `mtime` (+ optional short diff since the agent's last read).
  - `not_found`: closest existing paths ("did you mean ...").
  - `path_escape`: normalized path and workspace root (common on Windows drive letters and `..`).
  - `invalid_request`: offending field path and expected type (`edits[2].new_text: expected string`).
  - `scope_denied` / `internal`: name the missing capability or a stable `error_id` plus the next action; no bare "check stderr".
- [ ] **`next_actions[]` on every error** (P1, med): ready-to-send tool calls in the same shape `project_explain_error` returns, so the agent does not need an extra `explain_error` round-trip for errors the server already understands.
- [ ] **Batch error semantics** (P1, med): per-item `index`, `executed[]` / `skipped[]`, and for write batches whether a rollback happened and the `snapshot_id`; read batches default to per-item results, with optional `stop_on_error`.
- [ ] **Loop metric** (P2, low): count identical-tool failures with near-identical arguments in `project_tool_audit` and surface it in `project_health`; use it to confirm the new messages reduce retry loops.
- [ ] Tests: one verify check per new code (shape of `error.data`, size caps, sensitive paths excluded).

### D. Batch + single tool design (P1)
- [ ] **Single tools are thin wrappers over the batch core** (P1, med): one code path for cache, audit, `reason`, `expected_sha256`, envelope and errors; tests written once cover both.
- [ ] **`project_edit_batch` — transactional write batch** (P1, high): optional auto-snapshot (`project_snapshot`), validate all edits first, apply, verify (`expected_sha256` per file), roll back everything on any failure; `reason` recorded once for the batch plus per item; `stop_on_error` semantics documented.
- [ ] **Selection rule in the first sentence of each description** (P1, low): "one file -> `project_read_file`; two or more reads, or search -> read -> read -> `project_read_batch`", same for edits.
- [ ] **Adoption metric** (P2, low): from the audit log, count runs of >= 3 consecutive single reads/edits within a short window that should have been a batch; tune descriptions before changing code.

### E. Tool surface and integration (P2)
- [ ] **`VENIRA_PROFILE=core|full`** (P2, low): `core` registers only what built-in agent tools lack (snapshot, audit/health, secret, shell policy/async shell, diagnostics, batch, PR/CI); `full` = current 40 tools. `VENIRA_DISABLE_TOOLS` stays for fine-tuning. Reduces schema/context cost and tool-choice confusion.
- [ ] **Keep `lib/corehost.ts` as a library with two thin adapters** (P2, med): MCP server (today) and a native tool adapter for a fork/embedded agent. A native integration lets Venira *replace* the host's own bash/edit/write tools, so shell policy and the workspace lock cannot be bypassed (with MCP alongside native tools they can). This supersedes the "do not natively integrate yet" note in `TOOL-ROADMAP.md`; revisit once A and C are done.
- [ ] **Docs consistency** (P1, low) — verified in README v1.6.0: tool count (37 in the intro/diagram vs 40 in §4 and the changelog), `verify` (~30 checks in the scripts list vs 218 in the architecture tree), `doctor` (7 vs 12), a reference to a non-existent "§3.4", the decision-tree anchor `#410-...` pointing at the shell section (the tree is §4.11), and the claim that Node >= 20 "ships `node:sqlite`" (it appeared later; audit uses `better-sqlite3` anyway). Add a CI check that fails when the tool count in README disagrees with `tools/list`.
- [ ] **Stop shipping build artifacts in the repo/package** (P2, low): `*.log`, `server.err`, `venira-mcp-*.tgz`, `check-*.js` / `poll-ci.js` / `create-pr.js` scratch scripts and `*-new.txt` / `section*.txt` drafts are in the project root; move to `scripts/dev/` or `.gitignore`, and keep `.npmignore` strict.

## 📅 Estimated timeline (delivered)
- **v1.1.0** (P1, ~1 week): ✅ Cache control + Trace + read_audit + Shell UX
- **v1.1.2** (~2 days): ✅ verify/doctor tool counts raised to 25
- **v1.1.9**: ✅ CLI `--workspace` / `--data-dir`, `VENIRA_PERMISSION_MODE`
- **v1.2.0** (P2, ~2-3 weeks): ✅ Fuzzy edit + recent-files index + outline_symbol
- **v1.3.0** (P3, ~1-2 months): ✅ diff + symbols + references + selective_search
- **v1.3.0+** (P2.5): ✅ self-install (`project_detect_harnesses` / `project_install_self`)
- **v1.4.0**: ✅ checkpoints + audit reasons + Git/PR + CI + secrets (35 tools, verify 186/186)
- **v1.5.0**: ✅ inline PR review comments + check-runs + secret rotation + deterministic `explain_error` / `plan_read_batch` (37 tools, verify 211/211)
- **v1.5.1 → v1.5.4**: ✅ hardening found by live E2E + bench — inline `commit_id`, planner artifact/lockfile/credential filters, name/path ranking + calibrated estimate (verify 218/218)
- **v1.6.0** ✅: configurable git layer — config file, provider dialects (GitLab/Bitbucket), proxy, retries, PR list/close/reopen (40 tools)
- **v1.7.0** (planned): safety gaps (shell-policy ordering, `execute_js` gate, protected paths, symlink containment, `install_self` approval, data dir), typed actionable errors, transactional `project_edit_batch`, `VENIRA_PROFILE`
- **Backlog**: chroma/supabase integration, metrics UI, native-tool adapter (see v1.7.0 §E)

## ✅ Success criteria
- [x] The model picks the right tool per the rules (each P0/P1 done)
- [x] Output is clear enough to debug (each P1 done)
- [x] Multi-op workflows reduce round-trips (each P1 done)
- [x] Speed is acceptable (proven by benchmarks)
- [x] "Absolute" users have config for 100% (P1 done, P2 in progress)

---

## 📝 Change Log

### v1.5.3 (2026-10-29) ✅
- **Fix (post-restart bench find)**: a task naming a file ranked docs instead of the file. `git-provider` never occurs inside `lib/git-provider.ts`, so content search could not find it. Plans now also run a bounded **file-name search** per keyword (one retry with the other separator: `user_profile` ↔ `user-profile`), and candidates are scored as `hits + 4 × path/name match`.
- **Ranking**: prose (`*.md`, README/LICENSE/CHANGELOG, `docs/`) keeps only 0.3 of its hits (minus 2) unless the task mentions documentation; generated lockfiles (`package-lock.json`, `yarn.lock`, …) are excluded like other artifacts.
- **Estimate**: `estimated_ms` calibrated from the bench (6-file batch ≈ 62 ms) instead of a flat 6 ms.
- **Tests**: verify 217/217 (named-file ranking, docs-when-asked, calibrated estimate); version 1.5.3.

### v1.6.0 (2026-10-29) ✅
- **Configurable git layer**: provider selection (GitHub/GitLab/Bitbucket), per-call config precedence (args → config file → env → default), `venira.config.json` with `git.provider`, `api_url`, `secret`, `username`, `timeout_ms`, `log_timeout_ms`, `max_bytes`, `log_max_bytes`, `log_zip_bytes`, `log_entry_bytes`, `log_text_bytes`, `max_redirects`, `retries`, `proxy`, `repos{}`; matching `VENIRA_GIT_*` env vars.
- **Provider dialects**: GitHub (REST), GitLab (`/api/v4`), Bitbucket Cloud (`/2.0`); unified tool surface with `provider` arg; `project_pr_list`, `project_pr_close`, `project_pr_reopen` (40 tools).
- **HTTP layer**: manual redirects with auth drop on cross-origin, response caps, GET retries (0-3), CONNECT proxy with `NO_PROXY` matching.
- **Hard safety ceilings** on all limits; invalid values fail with `invalid_request` + hint; secrets never echoed.
- **GitLab**: MR create/note/merge/list/close/reopen; pipelines status/trigger; job trace logs (up to 3 failing jobs).
- **Bitbucket**: PR create/comment/merge/list/decline/reopen; pipelines status/trigger; step logs (pipeline UUID + step UUID).
- **Tests**: GitHub/GitLab/Bitbucket mocks, config precedence, proxy/NO_PROXY, retries, cap ceilings.
- **Docs**: README env table, §4.6/§4.7 provider-agnostic, roadmap shipped.

### v1.5.4 (2026-10-29) ✅
- **Fix (E2E v1.5.3 loop find)**: `project_plan_read_batch` proposed reading credentials — a secret-related task ranked `data/secrets.json` (encrypted store) and `data/secrets.key` into the top 6.
- **Filter**: `isPlannablePath()` drops `.env*`, `secrets.{json,key,yaml,yml}`, `*.key/.pem/.p12/.pfx/.jks/.keystore/.crt/.cer/.der`, `id_(rsa|dsa|ecdsa|ed25519)`, `.npmrc/.netrc/.pgpass`, `credentials.json`.
- **Tests**: verify 218/218 (secret-store exclusion); version 1.5.4.

### v1.5.2 (2026-10-29) ✅
- **Fix (E2E re-run find)**: `project_plan_read_batch` ranked `data/venira.db` above source (36 hits) — the audit DB contains every command, so its bytes match keyword searches. Candidates now exclude build/vendor directories (`node_modules`, `dist`, `.git`, `__pycache__`, …) and DB/log/binary extensions (`.db`, `.sqlite`, `.log`, `.map`, images, …), both when collecting hits and in `buildReadPlan`.
- **Tests**: verify 214/214 (artifact exclusion + source ranking); version 1.5.2.

### v1.5.1 (2026-10-29) ✅
- **Fix (live E2E find)**: GitHub requires `commit_id` whenever `line` is used in the pull review-comment API (a bare `line` returns 422 "line is not a permitted key"). `project_pr_comment` now resolves the PR head sha automatically (one extra API call, inline notes only), honours an explicit `commit_id`, and echoes it in the response.
- **Tests**: verify 212/212 (inline payload asserts the resolved sha + an explicit override); version 1.5.1.

### v1.5.0 (2026-10-29) ✅
- **Inline PR review comments**: `project_pr_comment` accepts `path` + `line` (+ `start_line`, `side`, `commit_id`) and posts through the pull review-comment API; general comments unchanged
- **Branch-protection check-runs**: `project_ci_status` adds `ref` / `pr` → `GET /commits/{ref}/check-runs`, `overall` gains `no_checks`, `check_runs[]` summarised; Actions mode unchanged
- **Secret rotation metadata**: `expires_at` / `expires_in_days`, `expired`, `days_left`, `last_used_at`, `use_count`, `rotated_at`; re-`set` rotates (counter reset, previous expiry kept unless replaced); expired secrets refused at injection (`secret_expired`)
- **Diagnostics**: `project_explain_error` — deterministic rule table (~28 signatures) → cause + fixes + ready `next_actions`, no model call
- **Read planning**: `project_plan_read_batch` — keywords → bounded searches → ranked candidates → ready `project_read_batch` call + estimate, no model call
- **Secrets health**: `project_health` reports `expired` / `with_expiry`
- **Tests**: 37 tools, verify 211/211 PASS (mock GitHub API + check-runs + inline comments), doctor expects 37

### v1.4.0 (2026-10-29) ✅
- **Git / PR provider**: `project_pr_create`, `project_pr_comment`, `project_pr_merge` (GitHub REST, repo/token auto-resolution)
- **CI provider**: `project_ci_status`, `project_ci_trigger`, `project_ci_logs` (Actions; in-memory ZIP logs with tail caps)
- **Secrets**: `project_secret` (get/set/list/delete), AES-256-GCM at rest, metadata-only reads, `reveal` env gate
- **Shell**: `project_shell_run secret_env` injection + redaction of values in output and audit
- **Network**: `VENIRA_NETWORK` kill switch, https-only API base, redirect token hygiene, `node:http(s)` client
- **Checkpoints**: secret store (`secrets.json` / `secrets.key`) excluded from capture/restore/`delete_extra`
- **Audit**: external ops log a secret-free summary in `command` (e.g. `PUT /pulls/7/merge repo=… method=squash`)
- **Tests**: 35 tools, verify 186/186 PASS (mock GitHub API + blob server), doctor expects 35

### v1.0.0 (2026-10-27) ✅
- **Standalone rewrite**: Rust `corehost` + JSON-Lines IPC → in-process pure-Node backend (`lib/corehost.ts`), no external binary
- SQLite WAL audit via `better-sqlite3` (replaces `node:sqlite`), native shell via `child_process` (async runs, process-tree kill)
- Capability scope, structured envelopes + hints, validated read caches, `project_read_batch`
- Dual license (MIT + Apache-2.0), CI/CD GitHub Actions without a Rust toolchain

### v1.0.1–v1.0.7 (2026-10-28) ✅
- npm metadata + OIDC trusted publishing, Docker multi-stage image, `--version` / `--help`
- Doctor works from any directory; zod 4 + MCP SDK 1.32 (security advisory fix)
- `LICENSE-MIT` / `LICENSE-APACHE` filenames, `scripts/` shipped in the image
- Package renamed to `venira-mcp`, bins `venira` + `venira-mcp`

### v1.1.0 (2026-10-28) ✅
- Shell policy levels `balanced` / `strict` / `permissive` / `off`
- HMAC-signed single-use approval tokens + session grants
- Policy file loaded only from an explicit env path (never from the workspace)

### v1.1.3 (2026-10-28) ✅
- `project_execute_js`: sandboxed synchronous JS inside the workspace (whitelisted env, output caps)

### v1.1.7 (2026-10-28) ✅
- Audit writer migrates legacy DB schemas in place instead of failing writes

### v1.1.9 (2026-10-28) ✅
- CLI `--workspace` / `-w` and `--data-dir` flags (no config switching)
- `VENIRA_PERMISSION_MODE` surface

### v1.2.0 (2026-10-28) ✅
- **P1**: Cache control env vars (`CACHE_ALL_ENABLED`, `CACHE_LIST_ONLY_ENABLED`, `CACHE_SEARCH_ONLY_ENABLED`)
- **P1**: Request tracing (`lib/tracer.ts`, `project_trace_status` tool)
- **P1**: Read audit (`project_read_audit` tool)
- **P1**: Shell UX (`VENIRA_SHELL_TAIL_MAX`, `VENIRA_SHELL_EXIT_EARLY`, `VENIRA_SHELL_TIMEOUT_POLICY`, `project_shell_cancel_session`)
- **v1.1.2 (2025-10-28)**: Updated verify/doctor to expect 25 tools, added P1 config reporting to `project_health` (cache, trace, shell sections)
- **v1.3.0 (2025-10-28)**: Implemented P2/P3 code intelligence:
  - `project_outline_symbol` / `project_file_symbols` (P2) - symbol extraction via regex
  - `project_diff_files` (P3) - unified diff via LCS
  - `project_symbol_references` (P3) - file/workspace scope symbol lookup
  - `project_selective_search` (P3) - multi-query fuzzy scoring search
- **P2 fuzzy edit** (2025-10-28):
  - `VENIRA_EDIT_FUZZY=1` + Levenshtein fuzzy match in opEditFile
  - Args: old_text_fuzzy, fuzzy_distance, ignore_indentation, case_insensitive
  - Returns fuzzy_used flag in envelope
- **P2 recent files index** (2025-10-28):
  - SQLite `project_file_index` table, updated on write/edit, removed on delete
  - `queryRecentFiles()` exported from corehost.ts
  - runRecentFiles uses index first, falls back to bounded scan
  - Response source: "index" | "fallback_scan"
- **DEFERRED**: `project_explain_error` and `project_plan_read_batch` (requires OpenCode model access, lower priority)

---

Next steps: v1.6 candidates are the GitLab/Bitbucket provider dialect and multi-repo workspaces. All P0/P1/P2/P3 roadmap items (including `project_explain_error` and `project_plan_read_batch`), plus the Git/PR, CI, check-run, secrets/rotation and diagnostics surfaces, are complete.