/**
 * Verify section module: consistency (roadmap item 15, P2 - the rest).
 *
 * The small items that made an agent work harder than it had to:
 *
 *   1. `change_impact`: `unresolved[]` mixed the caller's own seed problems
 *      with graph-wide unresolved imports (noise). Now: the seeds only, plus
 *      a count for the graph noise.
 *   2. `symbol_references`: `limit` and `max_references` overlapped and the
 *      schema did not say which was which. Now: the scan and the returned
 *      list have separate names, and the result says what was cut.
 *   3. Timestamps: the audit rows were in seconds, the snapshots and traces
 *      in milliseconds. Now everything is epoch milliseconds with the unit
 *      in the field name, and every "recent list" reads newest-first.
 *   4. `shell_run`: `status: "completed"` next to `command_status: "running"`
 *      was a contradiction. Now `status` names what happened to the command.
 *   5. `project_health`: `capability.project_id: "chat-terminal"` was the
 *      fallback id and did not say so.
 *   6. `snapshot`: a failed `edit_batch` left its internal checkpoint behind
 *      and ate a VENIRA_SNAPSHOT_KEEP slot per attempt.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Harness } from "./harness.js";
import type { runCore } from "./core.js";
import type { runShellPolicy } from "./shell-policy.js";
import type { runShellEnvAudit } from "./shell-env-audit.js";

export async function runConsistency(
  $h: Harness,
  $prior: Awaited<ReturnType<typeof runCore>> &
    Awaited<ReturnType<typeof runShellPolicy>> &
    Awaited<ReturnType<typeof runShellEnvAudit>>,
) {
  const { call, check, textOf, dir } = $h;
  const { asEnvelope, shellFor, runWithCliApproval } = $prior;

  // -------------------------------------------------------------------------
  // 1. change_impact: the seeds' problems, not the graph's noise
  // -------------------------------------------------------------------------
  await fs.mkdir(path.join(dir, "impact"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "impact", "alpha.ts"),
    "export function alphaSymbol(): number {\n  return 1;\n}\n",
  );
  await fs.writeFile(
    path.join(dir, "impact", "beta.ts"),
    'import { alphaSymbol } from "./missing-module";\nexport const beta = alphaSymbol;\n',
  );
  const impactOk = asEnvelope(
    await call("project_change_impact", {
      symbols: ["alphaSymbol"],
      direction: "dependents",
    }),
  );
  const impactUnresolved = (impactOk.data?.unresolved ?? []) as Array<
    Record<string, unknown>
  >;
  check(
    "change_impact_unresolved_holds_the_seed_problems_only",
    impactOk.ok === true &&
      Array.isArray(impactOk.data?.unresolved) &&
      impactUnresolved.length === 0 &&
      Number(impactOk.data?.stats?.unresolved_imports ?? 0) >= 1,
    { unresolved: impactUnresolved, stats: impactOk.data?.stats },
  );
  const impactGhost = asEnvelope(
    await call("project_change_impact", { symbols: ["ghostSymbolNobodyDeclared"] }),
  );
  const ghostUnresolved = (impactGhost.data?.unresolved ?? []) as Array<
    Record<string, unknown>
  >;
  check(
    "change_impact_names_the_seed_that_did_not_resolve",
    ghostUnresolved.length === 1 &&
      ghostUnresolved[0]?.symbol === "ghostSymbolNobodyDeclared" &&
      typeof ghostUnresolved[0]?.next_step === "string" &&
      !JSON.stringify(ghostUnresolved).includes("specifier"),
    { unresolved: ghostUnresolved },
  );

  // -------------------------------------------------------------------------
  // 1b. dependency_graph: the side lists are capped and counted
  // -------------------------------------------------------------------------
  await fs.mkdir(path.join(dir, "many-externals"), { recursive: true });
  await Promise.all(
    Array.from({ length: 60 }, (_, i) =>
      fs.writeFile(
        path.join(dir, "many-externals", `pkg-${i}.ts`),
        `import "venira-verify-pkg-${i}";\nexport const v${i} = ${i};\n`,
      ),
    ),
  );
  const manyGraph = asEnvelope(
    await call("project_dependency_graph", {
      kind: "files",
      relative_path: `${dir}/many-externals`,
      depth: 3,
      include_external: 1,
      max_nodes: 200,
      max_edges: 500,
    }),
  );
  const graphExternals = (manyGraph.data?.external ?? []) as unknown[];
  const graphUnresolved = (manyGraph.data?.unresolved ?? []) as unknown[];
  check(
    "dependency_graph_caps_its_side_lists_and_counts_them",
    manyGraph.ok === true &&
      graphExternals.length === 50 &&
      Number(manyGraph.data?.stats?.externals ?? 0) >= 60 &&
      graphUnresolved.length <= 10 &&
      Number(manyGraph.data?.stats?.unresolved_imports ?? 0) >=
        graphUnresolved.length &&
      manyGraph.data?.limited === true &&
      manyGraph.limited === true,
    {
      externals: graphExternals.length,
      stats_externals: manyGraph.data?.stats?.externals,
      unresolved: graphUnresolved.length,
      stats_unresolved: manyGraph.data?.stats?.unresolved_imports,
      limited: manyGraph.data?.limited,
    },
  );

  // -------------------------------------------------------------------------
  // 2. symbol_references: the scan cap and the returned cap are different
  // -------------------------------------------------------------------------
  await fs.writeFile(
    path.join(dir, "refs.txt"),
    Array.from({ length: 5 }, (_, i) => `alphaSymbol ${i}`).join("\n") + "\n",
  );
  const refsCapped = asEnvelope(
    await call("project_symbol_references", {
      symbol_name: "alphaSymbol",
      scope: "file",
      relative_path: `${dir}/refs.txt`,
      max_references: 2,
    }),
  );
  check(
    "symbol_references_separates_the_cap_from_the_count",
    refsCapped.ok === true &&
      refsCapped.data?.count === 5 &&
      refsCapped.data?.returned === 2 &&
      refsCapped.data?.omitted === 3 &&
      refsCapped.data?.limited === true &&
      (refsCapped.data?.references ?? []).length === 2 &&
      refsCapped.truncated === true,
    refsCapped.data,
  );
  const refsScan = asEnvelope(
    await call("project_symbol_references", {
      symbol_name: "alphaSymbol",
      scope: "workspace",
      limit: 1,
      max_references: 10,
    }),
  );
  check(
    "symbol_references_reports_the_scan_cap",
    refsScan.ok === true && refsScan.data?.scan_limit === 1,
    refsScan.data,
  );
  const refsDefaultScan = asEnvelope(
    await call("project_symbol_references", {
      symbol_name: "alphaSymbol",
      scope: "workspace",
      max_references: 7,
    }),
  );
  check(
    "symbol_references_scan_follows_max_references_by_default",
    refsDefaultScan.ok === true && refsDefaultScan.data?.scan_limit === 7,
    refsDefaultScan.data,
  );

  // -------------------------------------------------------------------------
  // 2b. A failed edit points at the right file (the message carries the
  //     diagnosis now, so parsing the path out of it broke).
  // -------------------------------------------------------------------------
  await fs.writeFile(path.join(dir, "recovery.txt"), "alpha\n");
  const recoveryEdit = asEnvelope(
    await call("project_edit_file", {
      relative_path: `${dir}/recovery.txt`,
      old_text: "not in the file",
      new_text: "X",
    }),
  );
  const recoveryFile = String(
    (recoveryEdit.data as { file?: unknown } | undefined)?.file ?? "",
  );
  const recoveryAction = (recoveryEdit.next_actions ?? []) as Array<{
    tool?: string;
    arguments?: { relative_path?: string };
  }>;
  check(
    "a_failed_edit_points_at_the_edited_file",
    recoveryEdit.error?.code === "old_text_not_found" &&
      recoveryFile === `${dir}/recovery.txt` &&
      recoveryAction.some(
        (action) =>
          action.tool === "project_read_file" &&
          action.arguments?.relative_path === `${dir}/recovery.txt`,
      ),
    {
      file: recoveryFile,
      next_actions: recoveryAction,
      message: recoveryEdit.error?.message,
    },
  );

  // -------------------------------------------------------------------------
  // 2c. The read cache must not confuse two shapes of the same file
  // -------------------------------------------------------------------------
  await fs.writeFile(path.join(dir, "shapes.txt"), "one\ntwo\nthree\n");
  const plain = asEnvelope(await call("project_read_file", { relative_path: `${dir}/shapes.txt` }));
  const ranged = asEnvelope(
    await call("project_read_file", {
      relative_path: `${dir}/shapes.txt`,
      ranges: [{ start_line: 1, end_line: 2 }],
    }),
  );
  check(
    "a ranged read does not return the cached plain read",
    plain.data?.text === "one\ntwo\nthree\n" &&
      Array.isArray(ranged.data?.ranges) &&
      ranged.data.ranges.length === 1 &&
      ranged.data.ranges[0].text === "one\ntwo",
    { plain_text: plain.data?.text, ranged_keys: Object.keys(ranged.data ?? {}) },
  );
  const numbered = asEnvelope(
    await call("project_read_file", { relative_path: `${dir}/shapes.txt`, line_numbers: 1 }),
  );
  const numberedAgain = asEnvelope(
    await call("project_read_file", { relative_path: `${dir}/shapes.txt`, line_numbers: 1 }),
  );
  check(
    "a numbered read numbers once (the cache must not re-number)",
    /^\s*1\| one/m.test(String(numbered.data?.text ?? "")) &&
      /^\s*1\| one/m.test(String(numberedAgain.data?.text ?? "")) &&
      !/1\| +\d+\|/.test(String(numberedAgain.data?.text ?? "")),
    { first: numbered.data?.text, second: numberedAgain.data?.text },
  );

  // -------------------------------------------------------------------------
  // 2d. recent_files: a workspace-relative root, and the index serves a subtree
  // -------------------------------------------------------------------------
  const recentRoot = asEnvelope(await call("project_recent_files", { relative_path: ".", limit: 5 }));
  check(
    "recent_files reports a workspace-relative root",
    recentRoot.ok === true && recentRoot.data?.relative_path === "",
    { relative_path: recentRoot.data?.relative_path },
  );
  const recentSub = asEnvelope(
    await call("project_recent_files", { relative_path: dir, limit: 10 }),
  );
  const subEntries = (recentSub.data?.entries ?? []) as Array<{
    relative_path?: string;
  }>;
  check(
    "recent_files serves a subtree query from the index",
    recentSub.ok === true &&
      recentSub.data?.relative_path === dir &&
      subEntries.length > 0 &&
      subEntries.every((entry) => String(entry.relative_path ?? "").startsWith(`${dir}/`)),
    { relative_path: recentSub.data?.relative_path, entries: subEntries.slice(0, 4) },
  );

  // -------------------------------------------------------------------------
  // 3. Timestamps: epoch milliseconds, everywhere, newest first
  // -------------------------------------------------------------------------
  const auditRows = asEnvelope(await call("project_read_audit", { limit: 5 }));
  const firstRow = (auditRows.data?.rows ?? [])[0] as
    | Record<string, unknown>
    | undefined;
  check(
    "audit_rows_report_epoch_milliseconds",
    auditRows.ok === true &&
      !!firstRow &&
      typeof firstRow.started_at_ms === "number" &&
      Number(firstRow.started_at_ms) > 1_000_000_000_000 &&
      firstRow.started_at === undefined,
    { row: firstRow },
  );
  const snapForTime = asEnvelope(
    await call("project_snapshot", {
      action: "create",
      paths: [dir],
      label: "consistency timestamps",
      reason: "VERIFY_REASON_TIMESTAMP_SNAPSHOT",
    }),
  );
  const snapList = asEnvelope(await call("project_snapshot", { action: "list" }));
  const newestCheckpoint = (snapList.data?.checkpoints ?? [])[0] as
    | Record<string, unknown>
    | undefined;
  check(
    "snapshot_rows_report_epoch_milliseconds",
    snapForTime.ok === true &&
      typeof snapForTime.data?.created_at_ms === "number" &&
      Number(snapForTime.data?.created_at_ms) > 1_000_000_000_000 &&
      typeof newestCheckpoint?.created_at_ms === "number" &&
      newestCheckpoint?.created_at === undefined,
    { created_at_ms: snapForTime.data?.created_at_ms, newest: newestCheckpoint },
  );
  if (snapForTime.data?.id) {
    await call("project_snapshot", {
      action: "delete",
      id: String(snapForTime.data.id),
      reason: "VERIFY_REASON_TIMESTAMP_CLEANUP",
    });
  }
  // The trace buffer needs VENIRA_TRACE=1, so it gets its own client.
  const traceTransport = new StdioClientTransport({
    command: "node",
    args: ["dist/server.js"],
    cwd: process.cwd(),
    env: $h.verifyEnv({ VENIRA_TRACE: "1" }, "full"),
    stderr: "pipe",
  });
  const traceClient = new Client(
    { name: "verify-consistency-trace", version: "0.0.0" },
    { capabilities: {} },
  );
  await traceClient.connect(traceTransport);
  // The buffer only fills with calls that went through the executor.
  await traceClient.callTool({
    name: "project_read_file",
    arguments: { relative_path: "package.json", start_line: 1, end_line: 2 },
  });
  const traceStatus = JSON.parse(
    (
      (await traceClient.callTool({
        name: "project_trace_status",
        arguments: {},
      })) as { content?: { text?: string }[] }
    ).content?.[0]?.text ?? "{}",
  );
  const recent = (traceStatus.data?.recent ?? []) as Array<
    Record<string, unknown>
  >;
  const timestamps = recent.map((entry) => Number(entry.timestamp_ms ?? 0));
  check(
    "trace_rows_report_epoch_milliseconds_and_read_newest_first",
    traceStatus.ok === true &&
      recent.length >= 1 &&
      timestamps.every((value) => value > 1_000_000_000_000) &&
      recent.every((entry) => entry.timestamp === undefined) &&
      timestamps.every((value, index) => index === 0 || timestamps[index - 1] >= value),
    { recent: recent.slice(0, 3) },
  );
  await traceClient.close();

  // -------------------------------------------------------------------------
  // 4. shell_run: `status` names what happened to the command
  // -------------------------------------------------------------------------
  const failing = asEnvelope(
    await call("project_shell_run", {
      // A file no other section touches: the repeat-guard refuses the second
      // run of the *same* command (roadmap item 17), and this section needs
      // a real non-zero exit code.
      command:
        shellFor === "powershell"
          ? "Get-Content consistency-missing.txt"
          : "cat consistency-missing.txt",
      shell: shellFor,
      background: 0,
    }),
  );
  check(
    "shell_run_status_reports_a_failed_command",
    failing.ok === true &&
      failing.status === "failed" &&
      failing.command_status === "failed" &&
      typeof failing.data?.exit_code === "number",
    { status: failing.status, command_status: failing.command_status },
  );
  const passing = asEnvelope(
    await call("project_shell_run", {
      command: shellFor === "powershell" ? "Get-Content package.json" : "cat package.json",
      shell: shellFor,
      background: 0,
    }),
  );
  check(
    "shell_run_status_reports_a_finished_command",
    passing.ok === true && passing.status === "completed",
    { status: passing.status, command_status: passing.command_status },
  );
  await fs.writeFile(
    path.join(dir, "consistency-loop.js"),
    "setInterval(() => {}, 1000);\n",
  );
  const running = asEnvelope(
    await runWithCliApproval(
      (args) => call("project_shell_run", args),
      {
        command: `node ${dir}/consistency-loop.js`,
        shell: shellFor,
        timeout_ms: 5000,
        background: 1,
      },
    ),
  );
  check(
    "shell_run_status_reports_a_running_command",
    running.ok === true && running.status === "running",
    { status: running.status, command_status: running.command_status, data: running.data },
  );
  const runningRunId = String(running.data?.run_id ?? "");
  if (runningRunId) {
    await call("project_shell_cancel", { run_id: runningRunId });
  }

  // -------------------------------------------------------------------------
  // 5. project_health: the fallback project id says so
  // -------------------------------------------------------------------------
  const health = asEnvelope(await call("project_health", { include_audit: 0 }));
  check(
    "health_names_the_fallback_project_id",
    health.ok === true &&
      health.data?.capability?.project_id === "chat-terminal" &&
      health.data?.capability?.project_id_kind === "fallback",
    { capability: health.data?.capability },
  );

  // -------------------------------------------------------------------------
  // 6. A failed edit_batch does not leave its checkpoint behind
  // -------------------------------------------------------------------------
  await fs.writeFile(path.join(dir, "batch-a.txt"), "alpha\n");
  await fs.writeFile(path.join(dir, "batch-b.txt"), "beta\n");
  const beforeList = asEnvelope(await call("project_snapshot", { action: "list" }));
  const beforeCount = Number(beforeList.data?.total ?? 0);
  const batch = asEnvelope(
    await call("project_edit_batch", {
      edits: [
        {
          relative_path: `${dir}/batch-a.txt`,
          old_text: "alpha",
          new_text: "ALPHA",
        },
        {
          relative_path: `${dir}/batch-b.txt`,
          old_text: "this text is not in the file",
          new_text: "X",
        },
      ],
      reason: "VERIFY_REASON_EDIT_BATCH_ROLLBACK",
    }),
  );
  const afterList = asEnvelope(await call("project_snapshot", { action: "list" }));
  const afterCount = Number(afterList.data?.total ?? 0);
  const batchA = await fs.readFile(path.join(dir, "batch-a.txt"), "utf8");
  check(
    "a_failed_edit_batch_removes_its_own_checkpoint",
    batch.ok === false &&
      batch.data?.rollback_succeeded === true &&
      batch.data?.checkpoint_deleted === true &&
      batch.data?.snapshot_id === undefined &&
      afterCount <= beforeCount &&
      batchA === "alpha\n",
    {
      rollback_succeeded: batch.data?.rollback_succeeded,
      checkpoint_deleted: batch.data?.checkpoint_deleted,
      beforeCount,
      afterCount,
      batchA,
    },
  );

  return { textOf };
}
