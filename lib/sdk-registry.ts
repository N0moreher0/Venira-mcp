/**
 * The JS SDK contract for `VENIRA_TOOL_MODE=minimal` (ROADMAP_MINIMAL_MODE.md,
 * Phase 2 + 3).
 *
 * ONE registry below drives BOTH
 *   - the `.d.ts` block that the `execute_js` description ships (mode `minimal`
 *     only, so `default`/`expert`/`core` do not pay the tokens), and
 *   - `venira.help(topic?)` inside the snippet,
 *   - the child runtime pin test (scripts/test-sdk-bridge.ts).
 * No hand-maintained second copy (R5): edit the table, everything follows.
 *
 * The runtime side of this contract lives in lib/sdk-child-runtime.ts; the
 * parent side (the internal dispatcher the calls land on) lives in
 * lib/sdk-bridge.ts.
 */

export type SdkApiEntry = {
  /** Function name on the `venira` global. */
  name: string;
  /** Full TypeScript signature (without the `venira.` prefix). */
  signature: string;
  /** One-line JSDoc shown next to the signature. */
  doc: string;
};

/**
 * The core surface: every operation the model needs in normal work
 * (the CORE_TOOLS group minus `shell_run`/`switch_workspace`, which stay
 * outside: `shell_run` is reachable through `venira.shell()`, and
 * `switch_workspace` is a deliberate non-goal from inside a snippet).
 */
export const SDK_API_CORE: readonly SdkApiEntry[] = [
  {
    name: "read",
    signature: 'read(paths: string | (string | ReadItem)[], opts?: ReadOpts): Promise<Env>',
    doc: "One or many files in one call; opts merge into each item (start_line, end_line, ranges).",
  },
  {
    name: "search",
    signature: 'search(q: string | Queries, opts?: SearchOpts): Promise<Env>',
    doc: 'Literal content search covers ~80%: search("foo", { relative_path: "src" }).',
  },
  {
    name: "list",
    signature: "list(path?: string, opts?: ListOpts): Promise<Env>",
    doc: "Directory tree (depth 1..3, limit <=200).",
  },
  {
    name: "recent",
    signature: "recent(limit?: number): Promise<Env>",
    doc: "Recently touched files; make it a reflex before editing.",
  },
  {
    name: "info",
    signature: "info(path: string, opts?: { missing_ok?: boolean }): Promise<Env>",
    doc: "File metadata; missing_ok=true answers exists:false instead of failing.",
  },
  {
    name: "outline",
    signature: "outline(path: string, opts?: OutlineOpts): Promise<Env>",
    doc: "Symbols of one file (functions/classes).",
  },
  {
    name: "refs",
    signature: "refs(symbol: string, opts?: RefsOpts): Promise<Env>",
    doc: "Usages of one symbol (scope file|workspace).",
  },
  {
    name: "diff",
    signature: "diff(pathA: string, pathB: string, opts?: DiffOpts): Promise<Env>",
    doc: "LCS diff of two files.",
  },
  {
    name: "write",
    signature: 'write(path: string, content: string, reason: string, expectedSha256?: string): Promise<Env>',
    doc: "Whole-file overwrite (mode=create|append -> venira.raw). Returns sha256_after.",
  },
  {
    name: "edit",
    signature: 'edit(edits: Edit | Edit[], reason: string, expectedSha256?: string): Promise<Env>',
    doc: "Single {relative_path, old_text, new_text} or an array (multi-file, all-or-nothing).",
  },
  {
    name: "patch",
    signature: "patch(diff: string, opts?: { dry_run?: boolean; reason?: string }): Promise<Env>",
    doc: "Unified diff applied atomically (create/modify/delete/rename); dry_run validates first.",
  },
  {
    name: "mkdir",
    signature: 'mkdir(path: string, opts?: { create_dirs?: boolean; reason?: string }): Promise<Env>',
    doc: "Create a directory (parents by default).",
  },
  {
    name: "move",
    signature: 'move(from: string, to: string, reason?: string): Promise<Env>',
    doc: "Move/rename one path.",
  },
  {
    name: "copy",
    signature: 'copy(from: string, to: string, reason?: string): Promise<Env>',
    doc: "Duplicate one path.",
  },
  {
    name: "remove",
    signature: 'remove(path: string, reason: string): Promise<Env>',
    doc: "Delete one path (destructive, audited; snapshot first for hard-to-reverse work).",
  },
  {
    name: "shell",
    signature: 'shell(cmd: string | ShellReq | ShellReq[], opts?: ShellOpts): Promise<Env | Env[]>',
    doc: "Run through the FULL shell_run pipeline (policy, Secretlint, audit). Background by default.",
  },
  {
    name: "shellStatus",
    signature: 'shellStatus(runId: string, opts?: { wait_seconds?: number; action?: "status" | "cancel"; killKey?: string }): Promise<Env>',
    doc: "Poll a background run; action=cancel needs the killKey from venira.shell().",
  },
  {
    name: "snapshot",
    signature: 'snapshot(action: "create" | "list" | "restore" | "delete" | "mirror", opts?: SnapOpts): Promise<Env>',
    doc: "Checkpoint/rollback; create one before multi-file or hard-to-reverse edits.",
  },
  {
    name: "git",
    signature: 'git(action: "status" | "diff" | "log" | "branch" | "commit" | "stash" | "push", args?: GitOpts): Promise<Env>',
    doc: "Local git; branch/stash use args.sub; commit needs args.message; reason goes in args.reason.",
  },
  {
    name: "memory",
    signature: 'memory(action: "read" | "write", content?: string, ifVersion?: string): Promise<Env>',
    doc: "Handoff note that outlives the chat; read at start, write before you finish.",
  },
  {
    name: "graph",
    signature: "graph(opts?: GraphOpts): Promise<Env>",
    doc: "Import/dependency graph of the workspace.",
  },
  {
    name: "help",
    signature: 'help(topic?: "ci" | "pr" | "secret" | "audit" | "ops"): string',
    doc: "Signatures for the advanced groups (string; console.log it).",
  },
  {
    name: "raw",
    signature: "raw(op: string, args?: Record<string, unknown>): Promise<Env>",
    doc: "Escape hatch for advanced ops (venira.help lists them); same policy + audit as every call.",
  },
];

/**
 * Advanced groups: NOT in the `.d.ts` root (progressive discovery through
 * `venira.help`). Callable through the bridge - the owner decision recorded in
 * ROADMAP_MINIMAL_MODE.md: minimal is a token-budget preset, not a permission
 * downgrade; every call still runs the full policy + audit pipeline.
 */
export const SDK_HELP_GROUPS: readonly { topic: string; title: string; entries: readonly SdkApiEntry[] }[] = [
  {
    topic: "ci",
    title: "CI (GitHub Actions / GitLab / Bitbucket)",
    entries: [
      { name: "ci_status", signature: 'raw("ci_status", { repo?, ref?, pr?, run_id?, branch? })', doc: "Runs + jobs for a repo/branch/PR." },
      { name: "ci_trigger", signature: 'raw("ci_trigger", { repo, workflow, ref? })', doc: "workflow_dispatch." },
      { name: "ci_control", signature: 'raw("ci_control", { repo, action: "cancel"|"retry_failed", run_id, reason })', doc: "Explicit cancel/retry (reason required)." },
      { name: "ci_logs", signature: 'raw("ci_logs", { repo, run_id?, job_id? })', doc: "Bounded log tail." },
      { name: "ci_wait", signature: 'raw("ci_wait", { repo, ref? | pr? | run_id? | branch?, until?, timeout_s? })', doc: "Bounded long-poll; terminal=false means call again." },
    ],
  },
  {
    topic: "pr",
    title: "Pull requests",
    entries: [
      { name: "pr_create", signature: 'raw("pr_create", { repo, title, head, base?, body? })', doc: "Open a PR." },
      { name: "pr_comment", signature: 'raw("pr_comment", { repo, pr, body, path?, line? })', doc: "Thread reply or inline note." },
      { name: "pr_merge", signature: 'raw("pr_merge", { repo, pr, method?, delete_branch? })', doc: "Land a PR." },
      { name: "pr_list", signature: 'raw("pr_list", { repo, state?, head? })', doc: "List PRs." },
      { name: "pr_close", signature: 'raw("pr_close", { repo, pr })', doc: "Close a PR." },
      { name: "pr_reopen", signature: 'raw("pr_reopen", { repo, pr })', doc: "Reopen a PR." },
    ],
  },
  {
    topic: "secret",
    title: "Secrets (encrypted at rest, never logged)",
    entries: [
      { name: "secret_set", signature: 'raw("secret", { action: "set", name, value, expires_days? })', doc: "Store a secret; values never appear in output." },
      { name: "secret_get", signature: 'raw("secret", { action: "get", name })', doc: "Metadata only (length, sha256 prefix, expiry)." },
      { name: "secret_list", signature: 'raw("secret", { action: "list" })', doc: "Names only." },
      { name: "secret_delete", signature: 'raw("secret", { action: "delete", name })', doc: "Remove a secret." },
    ],
  },
  {
    topic: "audit",
    title: "Audit trail + session shell hygiene",
    entries: [
      { name: "read_audit", signature: 'raw("read_audit", { session_id?, operation?, outcome?, request_id?, parent_call_id?, limit?, verify? })', doc: "Read the SQLite audit trail (bounded, newest first); parent_call_id = the execute_js call whose snippet ran those ops." },
      { name: "shell_cancel_session", signature: 'raw("shell_cancel_session", {})', doc: "Kill every background shell of this session." },
    ],
  },
  {
    topic: "ops",
    title: "Server ops (health, caches, traces)",
    entries: [
      { name: "health", signature: 'raw("health", { include_audit?, sections? })', doc: "Server/capability/cache/shell state + warnings." },
      { name: "trace_status", signature: 'raw("trace_status", { limit? })', doc: "Recent in-memory operation traces." },
    ],
  },
];

/** The example that teaches batching (roadmap Phase 2: ~60 tokens well spent). */
const SDK_EXAMPLE = `Example - five operations in ONE execute_js turn:
  const snap = await venira.snapshot("create", { label: "before refactor" });
  const hits = await venira.search("fetchData", { relative_path: "src" });
  const paths = (hits.data.matches ?? []).map((m) => m.relative_path);
  const files = await venira.read(paths);                       // batch read
  const edit = await venira.edit([{ relative_path: paths[0], old_text: "fetchData()", new_text: "fetchRecords()" }], "rename API");
  console.log(snap.ok, hits.ok, files.ok, edit.ok);`;

/** Rendered `.d.ts` block injected into the `execute_js` description (minimal only). */
export function sdkContractDts(): string {
  const lines: string[] = [];
  lines.push("## JS SDK contract (mode minimal)");
  lines.push("");
  lines.push("Inside `execute_js` a frozen global `venira` is available. Batch many operations into ONE snippet");
  lines.push("and await them; every call returns the same JSON envelope tools return: { ok, status, kind, data, hint?, ... }.");
  lines.push("`ok:false` is a VALUE (inspect and continue); policy denials throw with the rule id. Wrong argument types throw");
  lines.push("an error that repeats the exact expected signature. Background shells keep `run_id` + `kill_key` alive across");
  lines.push("turns: poll/cancel them from the NEXT turn with the outer `shell_status` tool.");
  lines.push("");
  lines.push("```ts");
  lines.push("declare const venira: {");
  for (const e of SDK_API_CORE) {
    lines.push(`  /** ${e.doc} */`);
    lines.push(`  ${e.signature};`);
  }
  lines.push("}");
  lines.push("```");
  lines.push("");
  lines.push('Advanced groups are NOT listed here - venira.help("ci" | "pr" | "secret" | "audit" | "ops") returns their');
  lines.push("signatures as a string; they run through venira.raw(op, args) under the same policy + audit.");
  lines.push("");
  lines.push(SDK_EXAMPLE);
  return lines.join("\n");
}

/** `venira.help(topic?)` text, generated from the same registry (R5). */
export function sdkHelpText(topic?: string): string {
  const header = "venira SDK -- advanced groups (run through venira.raw(op, args); same policy + audit as every call)";
  if (!topic) {
    const lines = [header, "Topics: " + SDK_HELP_GROUPS.map((g) => `"${g.topic}"`).join(", "), 'Usage: console.log(venira.help("ci"))'];
    return lines.join("\n");
  }
  const group = SDK_HELP_GROUPS.find((g) => g.topic === topic.trim().toLowerCase());
  if (!group) {
    return `${header}\nUnknown topic: ${JSON.stringify(topic)}. Topics: ${SDK_HELP_GROUPS.map((g) => g.topic).join(", ")}`;
  }
  const lines = [`${header}\n${group.title}:`];
  for (const e of group.entries) lines.push(`  ${e.signature}  // ${e.doc}`);
  return lines.join("\n");
}

/**
 * INSTRUCTIONS replacement for mode `minimal` (R6): tools/list is nearly empty,
 * so the per-tool decision tree is replaced by the one-door guidance.
 */
export function minimalInstructions(workspace: string): string {
  return `Venira coding tools operate on the workspace ${workspace}. Mode minimal: you see TWO tools.
Every call returns a JSON envelope: { ok, status, request_id, kind, data, hint?, next_actions?, command_status?, elapsed_ms }. On failure: { ok:false, error:{ code, message } } and the MCP result has isError=true. Read "hint" and "next_actions" first.

How to work here
1. EVERYTHING goes through execute_js: read/search/edit/write/snapshot/git/memory/shell are functions on the frozen global venira. BATCH many operations into ONE execute_js call (a string of awaits) instead of one call per operation.
2. venira.* calls return envelopes as VALUES (ok:false = inspect and continue). Policy denials and approval gates THROW: an approval stop carries data.approval with approval_id + approve_command - surface it to the user, never retry-loop.
3. Background commands: venira.shell() starts them (default background; returns run_id + kill_key). Poll or cancel from the NEXT turn with the outer shell_status tool (action="cancel" + kill_key). Cancel in minimal does not ask again: kill_key is the proof the caller started the run.
4. Wrong argument types throw the exact expected signature in stderr - fix and rerun in the next turn. Advanced ops (ci/pr/secret/audit/ops) are not in the contract: console.log(venira.help("ci")) and call venira.raw(op, args) - same policy + audit as everything.
5. Discipline: recent_files (venira.recent()) at task start; snapshot (venira.snapshot("create")) before multi-file or hard-to-reverse edits; memory (venira.memory("read"|"write")) for anything that must outlive the chat; reason on every mutation so the audit trail is readable.
6. Paths are workspace-relative; caches invalidate automatically after mutations; edits verify expected_sha256 when given. approve/secret values never appear in output; do not paste credentials.

Full SDK contract: the description of execute_js ships a .d.ts of venira.* - read it once, then batch.`;
}
