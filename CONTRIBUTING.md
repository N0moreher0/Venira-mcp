# Contributing to venira-mcp

Thanks for contributing. This is a small, fast-moving codebase — keep changes surgical and
add a `verify.ts` check for any new tool.

## Before you start

```bash
git clone <repo-url>
cd venira-mcp
npm install
npm run build
npm run doctor          # preflight: workspace, data dir, audit DB, tools
```

The standalone build is pure Node: no external binary or Rust toolchain is
required. `better-sqlite3` is the only native dependency and ships prebuilt
binaries for the supported Node × OS combinations.

## Development loop

```bash
npm run build        # type-check + emit dist/
npm run smoke        # 30 s: corehost reachable, path lock enforced
npm run verify       # 60 s: behavioural regression (cache, batch, shell, audit, output modes)
npm run bench:mcp    # numbers for PR descriptions
```

Run `verify` after **every** commit. It covers envelope shape, cache invalidation, batch budgets,
search-cache asymmetry, shell run/poll/cancel, audit rows (including `orphan_running` detection),
compact output mode, and tool annotations.

## Code conventions

- **TypeScript strict mode** (`tsconfig.json`). No `any` leaks; `skipLibCheck` is on for SDK types.
- **ESM** (`"type": "module"`). Imports end in `.js` even for `.ts` sources (standard ESM + TS).
- **Zod v3** for tool input schemas. Keep schemas declarative and small.
- **No new runtime dependencies.** The whole point is one `node` + one `zod` + one
  `@modelcontextprotocol/sdk`. A new dep needs a strong justification in the PR.
- **Cache invariants** (see [README §7](./README.md#7-security-model) and the cache notes in `lib/`):
  - Reads/info: mtime+size validated.
  - List/search/recent: short TTL, wiped on any mutation.
  - Search with 0 hits: **never cached**.
  - `execute` is serial; `shell_status` and `cancel` are unqueued.
- **Tool descriptions** always go through the `config()` helper in `tools/project.ts` so the
  `Use when` / `Avoid when` / `Speed` / `Output` / `Batch-safe` fields land in both the
  description and `_meta.venira`.

## Adding a tool

1. Add the registration in `tools/project.ts` → `registerProjectTools`.
2. Route it through `executeCached` if it's read-only; add it to `MUTATING` if it writes.
3. Envelope + hint: use `buildEnvelope` / `errorEnvelope` from `lib/output.ts` — never hand-roll.
4. `scripts/verify/`: add a `check("…", …)` block in the matching section module; update `expectedCount` in that section module (section modules own their counts; `scripts/verify.ts` only orchestrates).
5. `server.ts` → `INSTRUCTIONS` decision tree: one line if it belongs in the flow.
6. `README.md` → tool table + §4 section for the family it belongs to.
7. `npm run build && npm run verify && npm run bench:mcp` — paste bench output in the PR.

## Release process

Checklist, in order. Do not skip the verification steps; they are what keeps the
published artifacts and the public listings honest.

- [ ] Bump `package.json` version **and** `lib/version.ts` (they must match; `verify.ts` checks).
- [ ] `npm run build && npm run check:docs && npm run check:source-shape && npm run verify`.
- [ ] `npm run bench:mcp` and paste the numbers into the release notes.
- [ ] Update `README.md` where behaviour changed (tool counts, env defaults, security
      notes). The README is the source of truth for catalogs that scrape this repo.
- [ ] Commit, tag `v<version>`, push the tag. `release.yml` builds the npm package,
      the standalone zip and the multi-arch GHCR image, then publishes to npm.
- [ ] Verify the published artifacts: `npm view venira-mcp@<version> version`,
      `docker pull ghcr.io/<owner>/<repo>:<version>`.
- [ ] **Public catalog sync** (the step that used to drift):
  1. **Glama** (`glama.ai/mcp/servers`) — the listing is built from the GitHub repo.
     After the tag is public, open the server page and use its refresh action; confirm
     name, description, version, tool list and required env vars match this repo.
     Claim the listing if it is still unowned, so future updates can be pushed.
  2. **Official MCP registry / Smithery** — if the project is listed there, refresh the
     entry from the same release and re-check the install command.
  3. Record the catalog check in the release notes (`Glama: refreshed <date>`), so the
     next release has a visible baseline.
- [ ] Post-release: `project_health` and `project_read_audit verify=1` on a fresh
      install; confirm the shell policy profile and protected paths behave as documented.

Changelog lives in the PR / release notes; there is no separate `CHANGELOG.md` (yet).

## Security-sensitive changes

Anything that touches path resolution (`lib/workspace.ts`), the permission model, or shell
execution needs an extra review pass. In particular:

- Never widen `VENIRA_UNRESTRICTED` semantics without discussion.
- New shell options must document what they can do (tail size, timeout, cwd) in the description.
- Audit-row schema changes require a migration note in the PR.
