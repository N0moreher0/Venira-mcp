# Venira MCP Coding — Tool Roadmap

## 1) Overall goals
- Keep venira as an MCP layer decoupled from OpenCode.
- Improve tool-selection UX, output, workflow speed, and ease of testing.
- Do not natively integrate just yet; native integration is only a long-term option if it's OpenCode-only.

## 2) Tool design principles
- Native for single, simple ops where output doesn't matter much.
- Venira for read-heavy workloads, batches, async shell, and structured envelopes.
- OpenCode tools for metadata/session/worktree/MCP resources.
- Code Mode helpers are used only for exploring the catalog; they don't replace real tools.

## 3) Detailed roadmap

### Phase 1: Improve discoverability and tool selection
1. Rename the Code Mode helper from `search` to `findTools` or `listTools`.
2. Add metadata to each venira tool:
   - `use_when`
   - `avoid_when`
   - `speed_profile`
   - `output_kind`
   - `batch_safe`
3. Create a short policy file in the repo, e.g. `.opencode/tool-policy.md`:
   - Native-first for single small ops
   - Venira-first for read-heavy workflows
   - Batch-first for read-only
   - Async shell for build/test
4. Write tool-selection guidelines in decision-tree form for the model:
   - Reading multiple files? → `project_read_batch`
   - Long shell? → `project_shell_run` + `project_shell_status`
   - Need OpenCode metadata? → `opencode.*`
   - Unsure which tool? → `findTools`

### Phase 2: Upgrade output and UX
1. Standardize the response envelope on every tool:
   - `status`
   - `request_id`
   - `kind`
   - `data`
   - `truncated`
   - `hint`
2. Add `hint` for common errors:
   - Path outside the workspace
   - File not found
   - Batch hitting the limit
   - Search limit too small
3. Enable a more aggressive compact output mode:
   - Default is `VENIRA_PRETTY=0`
   - Add `VENIRA_OUTPUT_MODE=full|compact|summary`
4. Add a `summary` for long results:
   - `matches_preview`
   - `files_scanned`
   - `next_start_line`
   - `suggested_narrowing`
5. Standardize the error format:
   - `code`
   - `message`
   - `retryable`
   - `suggestion`

### Phase 3: Optimize workflow speed
1. Extend the read cache:
   - Currently `read_file`, `get_file_info`
   - Add a short-lived `list_files` cache if needed
2. Add a cache index for `project_search`:
   - Per-file + per-line index
   - Invalidation via mtime/size
3. Optimize `project_read_batch`:
   - Keep the batch but avoid parallelism at the Rust layer when the audit lock is the bottleneck
   - Add `max_response_bytes_per_item`
4. Add stronger prewarm:
   - Open the capability early
   - Prewarm the filesystem cache
   - Ping the host on startup
5. Standard benchmarks:
   - `bench.ts` for the corehost
   - `bench-mcp.ts` for end-to-end
   - Add test scenarios:
     - Batch 8 cold
     - Batch 8 cached
     - Shell async
     - Search wide vs. narrow

### Phase 4: Improve reliability and observability
1. Add request tracing:
   - Propagate `request_id` end-to-end
   - Structured log output
   - Track p50/p95 per operation
2. Add a health tool:
   - `project_health`
   - Report capability state, cache statistics, queue depth, active shell runs
3. Add a self-test mode:
   - `npm run verify` stays as-is
   - Add `npm run doctor` to check:
     - corehost path
     - data directory
     - workspace lock
     - permission mode
     - audit DB reachability
4. Add structured diagnostics in errors:
   - audit_unavailable
   - capability_expired
   - path_escape
   - batch_resource_limit
   - shell_timeout

### Phase 5: Expand capability tools
1. Add tools in the read-heavy group:
   - `project_diff_files` (if the backend supports it)
   - `project_outline_symbol`
   - `project_read_ranges`
2. Add tools in the code-context group:
   - `project_symbol_references`
   - `project_file_symbols`
   - `project_recent_files`
3. Add tools in the workflow group:
   - `project_plan_read_batch`
   - `project_selective_search`
   - `project_explain_error`
4. Add shell UX:
   - Tail output
   - Early exit codes
   - Clear timeout policy
   - Safe cancel

### Phase 6: Consider native integration
1. Only do native integration when:
   - OpenCode is the sole runtime
   - The measured MCP overhead is a real problem
   - The team accepts maintaining the tools inside OpenCode
2. When going native:
   - Keep the structured envelope
   - Keep batch + async shell
   - Add a native vs. MCP benchmark
   - Keep the option to port back to MCP if needed
3. When not going native:
   - Optimize the transport
   - Reduce serialization cost
   - Cache the catalog
   - Optimize startup/warmup

## 4) Priorities for immediate action
- P0: Rename the helper from `search` → `findTools`
- P0: Add `use_when`/`avoid_when` to every tool
- P1: Standardize `hint` in errors
- P1: Add caching for read-heavy workflows
- P2: Add `project_health`
- P2: Expand bench/verify scenarios

## 5) Definition of done
- The model picks the right tool per clear rules; no confusion between native/venira/opencode.
- Output is clear enough to debug without dumping long JSON.
- Multi-op workflows measurably reduce round-trips.
- Speed is acceptable, and the delta vs. native doesn't degrade the UX.
- There are tests/benchmarks that prove the improvements, not just vibes.
