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
- [ ] Auto-detect rg
- [ ] spawn ripgrep safe args
- [ ] fallback scanner
- [ ] regulated output sanitize
- [ ] optional SQLite trigram inverted index
- [ ] cache/inflight coalesce

## C. Security/ops
- [ ] shell cache scope correctness on overrides (done)
- [ ] workspace root validation tests
- [ ] npm audit CI green
