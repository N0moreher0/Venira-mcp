# Contributing to venira-mcp-coding

Thanks for contributing. This is a small, fast-moving codebase — keep changes surgical and
add a `verify.ts` check for any new tool.

## Before you start

```bash
git clone <repo-url>
cd venira-mcp-coding
npm install
npm run build
npm run doctor          # preflight: workspace, corehost, data dir, audit DB, tools
```

You need a working `venira_corehost_rs` binary (see [README §2](./README.md#2-quick-start)).
If you don't have one, set `VENIRA_COREHOST_EXE` in your environment and re-run doctor.

## Development loop

```bash
npm run build        # type-check + emit dist/
npm run smoke        # 30 s: corehost reachable, path lock enforced
npm run verify       # 60 s: behavioural regression (cache, batch, shell, audit, output modes)
npm run bench:mcp    # numbers for PR descriptions
```

Run `verify` after **every** commit. It covers envelope shape, cache invalidation, batch budgets,
search-cache asymmetry, shell run/poll/cancel, audit rows (including `orphan_running` detection),
summary output mode, and tool annotations.

## Code conventions

- **TypeScript strict mode** (`tsconfig.json`). No `any` leaks; `skipLibCheck` is on for SDK types.
- **ESM** (`"type": "module"`). Imports end in `.js` even for `.ts` sources (standard ESM + TS).
- **Zod v3** for tool input schemas. Keep schemas declarative and small.
- **No new runtime dependencies.** The whole point is one `node` + one `zod` + one
  `@modelcontextprotocol/sdk`. A new dep needs a strong justification in the PR.
- **Cache invariants** (see [README §10](./README.md#10-interesting-details--things-you-should-know)):
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
4. `verify.ts`: add a `check("…", …)` block; update `expectedCount` (currently 16).
5. `server.ts` → `INSTRUCTIONS` decision tree: one line if it belongs in the flow.
6. `README.md` → tool table + §4 section for the family it belongs to.
7. `npm run build && npm run verify && npm run bench:mcp` — paste bench output in the PR.

## Release process

- Bump `package.json` version **and** `lib/version.ts` (they must match; `verify.ts` checks).
- `npm run build`, tag the commit, publish.
- Changelog lives in the PR / release notes; there is no separate `CHANGELOG.md` (yet).

## Security-sensitive changes

Anything that touches path resolution (`lib/workspace.ts`), the permission model, or shell
execution needs an extra review pass. In particular:

- Never widen `VENIRA_UNRESTRICTED` semantics without discussion.
- New shell options must document what they can do (tail size, timeout, cwd) in the description.
- Audit-row schema changes require a migration note in the PR.
