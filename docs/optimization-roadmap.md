# Venira MCP Optimization Roadmap (Security-first)

Plan grouped. Security invariants:
- default deny by default; no arbitrary path switch without allowlist
- no subprocess shell for external search (args array only)
- timeout/cap/output sanitization
- cache invalidation + no shared unsafe cached results across scope roots

## A. Dynamic workspace
- [x] Todo/design doc
- [ ] Core plumbing in corehost.ts: `WORKSPACE` public, mutable active root (env allowlist).
- [ ] `project_tool.workspace.switch` operation hard gate + validate path
- [ ] exposed tool `project_switch_workspace` in tools/project.ts + wrapper.
- [ ] `project_health` current root
- [ ] invalidate scope caches on switch
- [ ] tests + smoke update

## B. Index backend
- [x] Auto-detect rg
- [x] spawn ripgrep safe args
- [x] fallback scanner
- [x] regulated output sanitize (protected path skip)
- [ ] optional SQLite trigram inverted index
- [x] cache/inflight coalesce (existing + negative cache)

## C. Security/ops
- [x] shell cache scope correctness on overrides (done)
- [ ] workspace root validation tests
- [x] npm audit CI green
