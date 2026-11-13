# AGENTS.md — venira-mcp (standalone MCP server)

Repo-specific notes for coding agents. `README.md` (user docs) and `CONTRIBUTING.md` (release
process) are loaded too; this file only holds what is slow to re-derive.

## Shape of the repo

- One npm package, no monorepo. `server.ts` = MCP entrypoint (stdio transport + the model-facing
  `INSTRUCTIONS` block). `lib/` = backend implementation. `tools/` = MCP tool layer.
  `scripts/` = test/bench/release scripts. `dist/` = build output (git-ignored).
- Request path: `tools/project.ts` wires everything; tool groups register in
  `tools/project-register-{files,shell,ops,codeintel,workflow,vcs}.ts` → cached executor
  (`tools/project-cache.ts`) → `lib/corehost*.ts`, a **pure-Node** implementation of the
  `project_tool.*` operations (no external binary — the old Rust corehost is gone).
- Envelopes (`ok/kind/data/hint`) are built only via `lib/output.ts` (`buildEnvelope`,
  `errorEnvelope`, `batchEnvelope`); never hand-roll one.
- Tool schemas: shared zod fragments + the `config()` helper live in `tools/project-schema.ts`.
  The model-facing wording for every tool lives in `tools/project-docs.ts` (`TOOL_DOCS`).
- Shell command classification (allow/ask/deny) lives in `lib/shell-policy*.ts` — many small
  modules, one per rule family.

## Commands

```
npm ci                     # better-sqlite3 is native: prebuild, else `npm rebuild better-sqlite3`
npm run build              # tsc -> dist/  (REQUIRED before verify/doctor; see below)
npx tsc --noEmit           # type-check only
npm run check:source-shape # no file in lib/scripts/tools may be a single line >2 KB
npm run check:docs         # README/tool-count/version/env-doc gate (first step of `verify`)
npm run verify             # behavioural suite (~20 focused scripts + scripts/verify.ts)
npm run smoke              # in-process sanity check
npm run doctor             # preflight: workspace, data dir, ripgrep, tool count, health, shell
npm run bench:mcp          # end-to-end numbers for PRs
```

- **`npm run build` first.** `scripts/verify.ts` and `scripts/doctor.ts` launch `node dist/server.js`,
  so they test the *build*, not your source. `npm run verify` does not build for you.
- Single suites: `npm run test:<name>` — `cache-layer`, `tool-schema`, `schema-budget`,
  `env-registry`, `edit-verify`, `edit-fuzzy-gate`, `tool-envelopes`, `audit-verify`,
  `snapshot-lifecycle`, `snapshot-mirror`, `workspace-switch`, `js-executor`,
  `approval-lifecycle`, `config-posture`, `protected-snapshot-paths`, `github-device-flow`,
  `provider-secret-guard`, `shell-unavailable`, `shell-elicitation`, `shell-repeat`,
  `git-url-fuzz`, `policy-corpus`, `move-copy`, `apply-patch`, `git-local`.
- **Not** in the `verify` chain (run them by hand when the area changes):
  `test:shell-security`, `test:shell-policy-fuzz`, `test:shell-policy-adversarial`,
  `test:shell-tokenizer-edges`, `test:shell-session-cache`, `test:shell-policy-file`,
  `test:balanced-read-only`, `test:restore-checkpoint`, `test:audit-fallback`.
- CI order (`.github/workflows/ci.yml`): build → `tsc --noEmit` → `check:source-shape` → smoke →
  doctor → verify → `test:policy-corpus` → `bench:mcp`. Matrix: ubuntu/windows/macOS × Node 20/22/24.
- `npm run coverage:shell` needs Node >= 22.8 (the coverage flags do not exist on Node 20);
  it skips the floors on older Node instead of failing.

## Contracts that break CI when broken

- **New or renamed tool** — four places, all enforced:
  1. register it in the right `tools/project-register-*.ts` using `config()` from
     `tools/project-schema.ts`;
  2. add a `TOOL_DOCS` entry in `tools/project-docs.ts` (`test:tool-schema` fails otherwise);
  3. record its `tools/list` size in `scripts/schema-budget.json`
     (`npm run test:schema-budget -- --update --allow-increase`; a tool with no recorded
     ceiling fails the check, and ceilings otherwise only ratchet **down**);
  4. tool counts changed → update the README count strings **and**
     `scripts/check-docs.ts` (`EXPECTED_DEFAULT_TOOLS` / `EXPECTED_EXPERT_TOOLS`) together.
     README says 36 default / 49 expert (+1 with `project_execute_js`); `schema-budget.json`
     records 37/50 because it registers the JS tool.
- **Version bump** — `package.json`, `package-lock.json` (both `version` and `packages[""].version`),
  `server.json` (both `version` and `packages[]`) and `lib/version.ts` must all agree;
  `check:docs` fails otherwise.
- **New `VENIRA_*` variable** — add it to `ENV_REGISTRY` in `lib/env-registry.ts`
  (`test:env-registry` compares the registry against the runtime source) *and* to the README
  env table (`check:docs` compares the docs against the source).
- Every boolean tool flag is the integer `0|1` (`flag01` in `tools/project-schema.ts`), every
  parameter needs a non-empty description, and `reason` (max 400 chars) is audit-logged on
  mutating calls.
- Shell policy changes need `npm run test:policy-corpus` (corpus: `scripts/policy-corpus.json`
  + `scripts/policy-corpus-extra.ts`) — the corpus pins tier **and** rule id per command.

## Quirks

- ESM + TypeScript strict: relative imports end in `.js` even though the source is `.ts`.
  `tsconfig` has `rootDir: "."`, so `dist/` mirrors the tree (`dist/lib/…`, `dist/scripts/…`).
- Any script under `scripts/` that touches `VENIRA_*` must `import "./clean-env.js"` **first** —
  inherited `VENIRA_*` vars from the launching agent session leak in and cause false failures.
- zod v4 (`z.looseObject`, `.meta()`); `tools/list` serves zod's JSON Schema, which is what
  the schema-budget script measures.
- `lib/output.ts` reads `VENIRA_OUTPUT_MODE` at module load — env changes need a restart.
- Node >= 20 (`engines`); CI covers 20/22/24.
- Git-ignored local-only files — do not treat as canonical and do not commit:
  `.mcp.json`, `mcp.json`, `Bug.txt`, `ROADMAP*.md`, `PUSH-NOTES.md`, `docs/`, `set-secret.js`,
  `wait-ci.js`.
- Commits follow conventional commits (`feat(scope):`, `fix(scope):`, `chore(release):`).
  A release = bump the version in the four places above, then
  `npm run build && npm run check:docs && npm run check:source-shape && npm run verify`,
  then tag `v<x.y.z>` (tag push triggers `.github/workflows/release.yml`).

## Working on this repo with the Venira MCP tools

The repo's own client config (`.mcp.json`, local only) runs `dist/server.js`, so **rebuild after
source edits** or the MCP tools serve the old build.

- Start with `project_recent_files` (limit 10–20) instead of guessing files; feed the paths
  into `project_read_batch` (max 8 items). `project_plan_read_batch` returns a ready batch call
  for an unfamiliar area.
- 2+ reads → one `project_read_batch`. One file → `project_read_file` with `start_line/end_line`
  or `ranges[]` (max 16); follow `next_start_line` when truncated.
- Prefer `project_edit_file` (exact `old_text`→`new_text`, `expected_sha256` for a verified
  re-read) over `project_write_file`; `project_edit_batch` for multi-file, all-or-nothing edits.
- Take a `project_snapshot` before multi-file/overwrite/delete work. Restore with
  `dry_run=1` first, then `verify=1, delete_extra=0`; never `delete_extra=1`.
- Pass `reason` ("why", <=400 chars) on every write/edit/delete/snapshot/PR/CI call — it lands in
  the audit trail.
- `project_shell_run` returns `run_id`; poll `project_shell_status` until `running=false`, or use
  `background: 0` for short commands whose output you need now. `ok=true` only means the call
  completed — read `command_status`/`exit_code`.
- `approval_required`: stop, show the user `approval_id` and `approve_command`, retry once after
  they confirm. Never approve it yourself and never loop.
- Treat `ok:false` + `retryable:false` as final; follow the envelope's `hint`/`next_actions`.
