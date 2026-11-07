# Venira MCP Roadmap

> Single source of truth for unfinished work. Completed features belong in the release changelog and are intentionally omitted here.
> Audited against code/docs on 2026-11-07. Current package: **1.17.2**. This roadmap is owner-maintained.

## Current state

- Released capabilities and past decisions: [README.md](README.md) changelog.
- Security claims and limits: [SECURITY.md](SECURITY.md).
- Default tool count: 32; Expert: 43 (44 with JS execution enabled).
- Phase E CI reliability and shared per-project snapshot storage are implemented.
- The security-limit notice is present in README, `doctor` and `project_health`.
- `VENIRA_NETWORK` application switch has been removed; isolation belongs to OS/container/VM policy.
- Related roadmap/TODO files are superseded by this file; do not add parallel backlogs.

## Active work

### P0 — Security evidence and correctness

1. **Shell policy adversarial coverage**
   - Add table-driven bypass cases for path and shell parsing, including PowerShell/cmd quoting and escape forms, alternate path spellings, and write-then-run sequences.
   - Track each confirmed gap with a stable case ID; separate observed behavior from enforced behavior.
   - Research whether commands targeting a just-written executable should require approval; measure false asks before changing policy.
2. **Approval lifecycle tests**
   - Verify expiry, cross-session isolation, replay prevention, and concurrent consumption. Decide and document TTL behavior.
3. **Protected-path and snapshot-path regression tests**
   - Cover protected-root cache invalidation and symlink/junction changes; add tests for snapshot path validation and store protection.
4. **Configuration posture**
   - Add a shared posture calculation and health reporting for risky flag combinations. Decide whether warnings alone are sufficient before adding any fail-closed behavior.
5. **Shell policy parsers**
   - Separate POSIX, PowerShell, and cmd parsing while preserving Windows backslashes and current safe behavior.

### P1 — Installation, context and policy controls

6. **Audit-store installation fallback**
   - Make native SQLite optional with a documented fallback, add a clean-install smoke job, and include Node 24 in CI after validating compatibility.
7. **Tool-schema budget**
   - Measure schemas by profile, set explicit size budgets, and add a check that fails on regressions.
8. **Risky configuration enforcement**
   - Decide the policy contract first; only then consider requiring an explicit acknowledgement for dangerous combinations.
9. **Environment registry and configuration matrix**
   - Maintain one source of truth for supported environment variables and test meaningful combinations rather than relying on scattered docs.
10. **Maintainability refactor**
   - Split the oversized `tools/project.ts`, `lib/corehost.ts`, and `scripts/verify.ts` along stable responsibilities, preserving public contracts and tests.

### P2 — Deeper assurance and operational improvements

11. **Property-based shell-policy fuzzing**
    - Add deterministic transformations/seeds first; every discovered issue becomes a regression case.
12. **Coverage reporting**
    - Measure relevant security modules repeatedly; report actual numbers before setting thresholds or making coverage claims.
13. **Isolation guides**
    - Document Docker, WSL, and Windows Sandbox setups, including mounts, network controls, and their limits.
14. **Snapshot lifecycle**
    - Resolve remaining open items: protection of the snapshot store from shell side effects, off-machine backup/mirroring, and migration guidance for older checkpoints.
15. **Glama catalog synchronization**
    - Refresh the public mirror and add a release checklist item so it does not drift again.

## Demand-gated provider work

16. **Azure DevOps CI provider**
    - Do not implement without a concrete user workflow. If demand exists, run a read-only spike first covering status, timeline-to-failure mapping, bounded logs, continuation tokens, partial success, and rate-limit headers. Only proceed if the spike validates API semantics and scope.
17. **GitLab OAuth**
    - Current decision: no OAuth until a real workflow makes PATs unacceptable and a maintainer accepts ownership of the OAuth app. If both gates pass, verify device-flow support against gitlab.com and one self-managed instance; design refresh rotation/concurrency before implementation.
    - Bitbucket OAuth remains deferred unless Atlassian adds device flow or a user accepts BYO-client/callback setup.

## Product capability candidates

These are not commitments; prioritize only with demonstrated demand:

- Atomic multi-file patch application with dry-run and snapshot integration.
- Dry-run support for write/edit/delete, plus safe move/copy operations.
- Shell output streaming/resume and stdin support.
- Optional automatic checkpoints for large edit workflows.
- Tree-sitter-backed symbol parsing and ripgrep-backed search when available.
- Broader compiler/test error explainers.
- MCP resources/prompts for health and audit workflows.
- Restrictive project-local policy that can only add ask/deny rules.
- Local aggregate latency and ask/deny telemetry with no raw arguments.
- Native integration only if a supported host/runtime requires it; the typed corehost adapter already exists.

## Decisions to resolve before implementation

- Should risky configuration only warn, or require explicit acknowledgement?
- What schema size budget is useful for Default/Core/Expert?
- Should the default profile change in a future major release? Require measured adoption and context data.
- Should approval grants have a user-visible TTL?
- Which provider/capability has real demand next?

## Release and status rules

- Update this file only for unfinished work; remove an item when code and verification prove it complete.
- Do not call research/spike work implemented.
- Record release facts and completed work in README changelog, not as permanent backlog entries.
- Run build, docs/source-shape checks, relevant verification, and cross-platform CI before claiming completion.
- Keep only this roadmap file as the ongoing roadmap/backlog.
