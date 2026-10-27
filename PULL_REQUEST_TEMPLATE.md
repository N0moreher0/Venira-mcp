# PR — venira-mcp-coding

## What changes and why
<!-- 1-3 sentences. Link the issue: fixes #123 -->

## Type
- [ ] New tool
- [ ] Bug fix
- [ ] Performance / cache
- [ ] Docs
- [ ] CI / release
- [ ] Dependency bump
- [ ] Other: 

## Tools affected
<!-- list the `project_*` tools you touched, or "none" -->

## How it was tested
<!-- paste the relevant output. CI already runs these on the PR: -->
- [ ] `npm run build`
- [ ] `npm run smoke`
- [ ] `npm run doctor` (7/7)
- [ ] `npm run verify` (0 FAIL)
- [ ] `npm run bench:mcp` (numbers pasted below if performance-sensitive)

```
# bench:mcp output (only if you changed tools/project.ts or lib/corehost.ts)
```

## Invariants preserved
Confirm the following are still true after your change (see README §10):
- [ ] Serial `execute` queue kept (mutations don't race the audit WAL)
- [ ] `shell_status` / `cancel` remain unqueued
- [ ] Asymmetric search cache (0-hit results are never cached)
- [ ] Read/info cache still mtime+size validated
- [ ] Workspace lock (`lib/workspace.ts`) unchanged unless intended

## Checklist
- [ ] No new runtime dependencies added (or justified in the description)
- [ ] `verify.ts` has a check for the new behaviour (if applicable)
- [ ] Decision tree in `server.ts` (`INSTRUCTIONS`) updated if a new tool was added
- [ ] `README.md` tool table + env-var table updated if applicable
- [ ] `TODO.md` / `TOOL-ROADMAP.md` updated if a roadmap item was closed
