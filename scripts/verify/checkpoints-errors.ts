/** Verify section module: checkpoints-errors. Behaviour is unchanged from the original scripts/verify.ts. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Harness } from "./harness.js";
import type { runCore } from "./core.js";
import type { runShellPolicy } from "./shell-policy.js";
import type { runShellEnvAudit } from "./shell-env-audit.js";

export async function runCheckpointsErrors(
  $h: Harness,
  $prior: Awaited<ReturnType<typeof runCore>> &
    Awaited<ReturnType<typeof runShellPolicy>> &
    Awaited<ReturnType<typeof runShellEnvAudit>>,
) {
  const { SESSION_ID, verifyEnv, results, textOf, call, check, dir } = $h;
  const {
    missing,
    run,
    asEnvelope,
    approvals,
    writeApprovalGrant,
    redacted,
    token,
  } = $prior;
  // 11. list write invalidation (cache)
  await new Promise((resolve) => setTimeout(resolve, 1600)); // list cache 1.5s
  const list1 = await call("project_list_files", {
    relative_path: dir,
    depth: 1,
  });
  const list1Data = JSON.parse(
    (list1 as { content?: { text?: string }[] })?.content?.[0]?.text ?? "{}",
  );
  const list1Count = list1Data.data?.entries?.length ?? 0;
  await call("project_write_file", {
    relative_path: `${dir}/list-invalidate.txt`,
    content: "new\n",
  });
  await new Promise((resolve) => setTimeout(resolve, 200));
  const list2 = await call("project_list_files", {
    relative_path: dir,
    depth: 1,
  });
  const list2Data = JSON.parse(
    (list2 as { content?: { text?: string }[] })?.content?.[0]?.text ?? "{}",
  );
  const list2Count = list2Data.data?.entries?.length ?? 0;
  check("list_cache_invalidate_after_write", list2Count === list1Count + 1, {
    list1Count,
    list2Count,
  });

  // 11b. Checkpoints + edit reason: snapshot -> tamper -> restore -> delete.
  await fs.writeFile(`${dir}/snap-target.txt`, "snapshot original content\n");
  const snapCreate = asEnvelope(
    await call("project_snapshot", {
      action: "create",
      paths: [dir],
      label: "verify checkpoint",
      reason: "VERIFY_REASON_SNAPSHOT",
    }),
  );
  check(
    "snapshot_create",
    snapCreate.ok === true &&
      snapCreate.kind === "snapshot_create" &&
      (snapCreate.data?.file_count ?? 0) >= 8,
    snapCreate,
  );
  const removedScopeSnapshot = asEnvelope(
    await call("project_snapshot", {
      action: "create",
      scope: [".verify-definitely-missing-snapshot-scope"],
      label: "removed scope must fail closed",
    }),
  );
  check(
    "snapshot_scope_removed_fails_closed",
    removedScopeSnapshot.ok === false &&
      removedScopeSnapshot.error?.code === "unsupported" &&
      /paths/i.test(String(removedScopeSnapshot.hint ?? "")),
    removedScopeSnapshot,
  );
  const outlineDirectory = asEnvelope(
    await call("project_outline_symbol", { relative_path: ".", max_symbols: 5 }),
  );
  check(
    "outline_symbol_directory_has_actionable_error",
    outlineDirectory.ok === false &&
      outlineDirectory.error?.code === "invalid_request" &&
      /directories are not supported/i.test(String(outlineDirectory.error?.message ?? "")),
    outlineDirectory,
  );
  const sameFileDiff = asEnvelope(
    await call("project_diff_files", {
      relative_path_a: `${dir}/snap-target.txt`,
      relative_path_b: `${dir}/snap-target.txt`,
      context_lines: 3,
    }),
  );
  check(
    "diff_same_file_returns_empty_diff",
    sameFileDiff.ok === true &&
      sameFileDiff.data?.lines_added === 0 &&
      sameFileDiff.data?.lines_removed === 0 &&
      sameFileDiff.data?.unified_diff === "",
    sameFileDiff.data,
  );
  await fs.mkdir(`${dir}/target/debug`, { recursive: true });
  await fs.writeFile(`${dir}/target/debug/build-artifact`, "binary-bytes\n");
  const snapCreateRust = asEnvelope(
    await call("project_snapshot", {
      action: "create",
      paths: [dir],
      label: "verify checkpoint rust excludes",
    }),
  );
  const rustSkipped = (snapCreateRust.data?.skipped ?? []) as Array<{
    path?: string;
    reason?: string;
  }>;
  check(
    "snapshot_excludes_rust_artifacts",
    snapCreateRust.ok === true &&
      rustSkipped.some((entry) => String(entry?.path ?? "").includes("target")),
    rustSkipped,
  );
  // Roadmap item 15 (P2): this checkpoint was never deleted, so every verify
  // run left one behind and ate a VENIRA_SNAPSHOT_KEEP slot.
  const rustSnapshotId = String(snapCreateRust.data?.id ?? "");
  if (rustSnapshotId) {
    await call("project_snapshot", {
      action: "delete",
      id: rustSnapshotId,
      reason: "VERIFY_REASON_CLEANUP_RUST_SNAPSHOT",
    });
  }
  const snapId = String(snapCreate.data?.id ?? "");
  await call("project_write_file", {
    relative_path: `${dir}/snap-target.txt`,
    content: "tampered by verify\n",
    reason: "VERIFY_REASON_EDIT",
  });
  const snapDryRun = asEnvelope(
    await call("project_snapshot", {
      action: "restore",
      id: snapId,
      dry_run: 1,
      verify: 1,
      delete_extra: 0,
      reason: "VERIFY_REASON_DRY_RUN",
    }),
  );
  const dryRunRestored = (snapDryRun.data?.restored ?? []) as Array<{
    path?: string;
  }>;
  const dryRunCurrent = await fs.readFile(`${dir}/snap-target.txt`, "utf8");
  check(
    "snapshot_dry_run_is_preview_only",
    snapDryRun.ok === true &&
      snapDryRun.data?.dry_run === true &&
      String(snapDryRun.data?.dry_run_note ?? "").includes("size only") &&
      dryRunRestored.some((file) => file.path === `${dir}/snap-target.txt`) &&
      dryRunCurrent.includes("tampered by verify"),
    {
      note: snapDryRun.data?.dry_run_note,
      current_unchanged: dryRunCurrent.includes("tampered by verify"),
    },
  );
  const sameSizeDir = `${dir}/same-size-scope`;
  await fs.mkdir(sameSizeDir, { recursive: true });
  await fs.writeFile(`${sameSizeDir}/target.txt`, "AAAAAA");
  const sameSizeSnapshot = asEnvelope(
    await call("project_snapshot", {
      action: "create",
      paths: [sameSizeDir],
      label: "same-size dry-run fixture",
      reason: "VERIFY_REASON_SAME_SIZE_SNAPSHOT",
    }),
  );
  const sameSizeSnapshotId = String(sameSizeSnapshot.data?.id ?? "");
  await fs.writeFile(`${sameSizeDir}/target.txt`, "BBBBBB");
  const snapDryRunSameSize = asEnvelope(
    await call("project_snapshot", {
      action: "restore",
      id: sameSizeSnapshotId,
      dry_run: 1,
      verify: 1,
      delete_extra: 0,
      reason: "VERIFY_REASON_DRY_RUN_SAME_SIZE",
    }),
  );
  const sameSizeCurrent = await fs.readFile(
    `${sameSizeDir}/target.txt`,
    "utf8",
  );
  check(
    "snapshot_dry_run_documents_same_size_limit",
    sameSizeSnapshot.ok === true &&
      sameSizeSnapshot.data?.file_count === 1 &&
      snapDryRunSameSize.ok === true &&
      String(snapDryRunSameSize.data?.dry_run_note ?? "").includes(
        "size only",
      ) &&
      snapDryRunSameSize.data?.unchanged_count === 1 &&
      snapDryRunSameSize.data?.restored_count === 0 &&
      sameSizeCurrent === "BBBBBB",
    {
      note: snapDryRunSameSize.data?.dry_run_note,
      unchanged_count: snapDryRunSameSize.data?.unchanged_count,
      current_untouched: sameSizeCurrent === "BBBBBB",
    },
  );
  const sameSizeRestore = asEnvelope(
    await call("project_snapshot", {
      action: "restore",
      id: sameSizeSnapshotId,
      verify: 1,
      delete_extra: 0,
      reason: "VERIFY_REASON_SAME_SIZE_RESTORE",
    }),
  );
  const sameSizeRestored = await fs.readFile(
    `${sameSizeDir}/target.txt`,
    "utf8",
  );
  check(
    "snapshot_restore_same_size_content",
    sameSizeRestore.ok === true && sameSizeRestored === "AAAAAA",
    sameSizeRestore,
  );
  await call("project_snapshot", {
    action: "delete",
    id: sameSizeSnapshotId,
    reason: "VERIFY_REASON_SAME_SIZE_CLEANUP",
  });
  const snapRestore = asEnvelope(
    await call("project_snapshot", {
      action: "restore",
      id: snapId,
      verify: 1,
      delete_extra: 0,
      reason: "VERIFY_REASON_RESTORE",
    }),
  );
  check(
    "snapshot_restore",
    snapRestore.ok === true &&
      snapRestore.kind === "snapshot_restore" &&
      (snapRestore.data?.restored_count ?? 0) >= 8,
    snapRestore,
  );
  const targetRestored = textOf(
    await call("project_read_file", {
      relative_path: `${dir}/snap-target.txt`,
    }),
  );
  check(
    "snapshot_restore_content",
    targetRestored.includes("snapshot original content"),
    targetRestored.slice(0, 80),
  );
  const snapList = asEnvelope(
    await call("project_snapshot", { action: "list" }),
  );
  check(
    "snapshot_list",
    snapList.ok === true && (snapList.data?.total ?? 0) >= 1,
    snapList.data?.total,
  );
  const snapDelete = asEnvelope(
    await call("project_snapshot", { action: "delete", id: snapId }),
  );
  check(
    "snapshot_delete",
    snapDelete.ok === true && snapDelete.data?.deleted === true,
    snapDelete,
  );

  // 12. Compact JSON: text must be a single line
  results.compact_single_line = !textOf(
    await call("project_read_file", { relative_path: "package.json" }),
  ).includes("\n  ");

  // 13. search: a cached HIT after a mutation must reflect the NEW content (proof that
  // invalidateListCaches actually clears the search cache, not just waiting for TTL to expire).
  await call("project_search", {
    query: token,
    kind: "literal_content",
    relative_path: dir,
    glob: "*.txt",
  });
  await call("project_write_file", {
    relative_path: `${dir}/search-token.txt`,
    content: "NEW_TOKEN\n",
  });
  await call("project_write_file", {
    relative_path: `${dir}/cache-proof.txt`,
    content: "CACHE_PROOF_TOKEN_XYZ\n",
  });
  const search4 = (await call("project_search", {
    query: "CACHE_PROOF_TOKEN_XYZ",
    kind: "literal_content",
    relative_path: dir,
    glob: "*.txt",
  })) as { content?: { text?: string }[] };
  const search4Data = JSON.parse(search4.content?.[0]?.text ?? "{}");
  check("search_cache_invalidated", search4Data.data?.hits?.length === 1, {
    hits: search4Data.data?.hits?.length,
    complete: search4Data.data?.complete,
    diagnostics: search4Data.data?.diagnostics,
  });

  // 13. Read ranges (via project_read_file with ranges)
  const ranges = await call("project_read_file", {
    relative_path: "server.ts",
    ranges: [
      { start_line: 1, end_line: 3 },
      { start_line: 10, end_line: 12 },
    ],
  });
  const rangesData = JSON.parse(
    (ranges as { content: { text: string }[] })?.content[0].text,
  );
  const rS = rangesData.data?.ranges ?? [];
  check("read_ranges_count", rS.length === 2, rS);
  check("read_ranges_have_text", rS[0]?.text && rS[1]?.text, rS);

  // 14. Recent files: recently written file included in results
  await call("project_write_file", {
    relative_path: `${dir}/recent-test.txt`,
    content: "recent\n",
  });
  const recent = await call("project_recent_files", {
    relative_path: dir,
    limit: 10,
  });
  const recentData = JSON.parse(
    (recent as { content: { text: string }[] })?.content[0].text ?? "{}",
  );
  const recentFiles = recentData.data?.entries ?? [];
  const recentFileNames: string[] = recentFiles.map(
    (e: unknown) => (e as { relative_path?: string })?.relative_path ?? "",
  );
  check(
    "recent_files_includes_recent",
    recentFileNames.some((f) => f.endsWith("recent-test.txt")),
    recentFileNames,
  );

  // 15. Health: ok, corehost.exe, capability, caches, metrics
  await call("project_read_file", {
    relative_path: `${dir}/loop-metric-missing.txt`,
  });
  // The negative cache (500 ms) would answer the second read without a backend call, so no
  // second failed audit row would exist. Clear it so the repeat is really audited.
  await call("project_cache_clear", { type: "negative" });
  await call("project_read_file", {
    relative_path: `${dir}/loop-metric-missing.txt`,
  });
  await call("project_read_file", {
    relative_path: "server.ts",
    start_line: 1,
    end_line: 2,
  });
  await call("project_read_file", {
    relative_path: "server.ts",
    start_line: 3,
    end_line: 4,
  });
  await call("project_read_file", {
    relative_path: "server.ts",
    start_line: 5,
    end_line: 6,
  });
  const health = await call("project_health", { include_audit: 0 });
  const healthData = JSON.parse(
    (health as { content: { text: string }[] })?.content[0].text ?? "{}",
  );
  check("health_ok", healthData.ok === true, healthData);
  check(
    "health_backend_standalone",
    healthData.data?.corehost?.exe === null,
    healthData.data?.corehost,
  );
  check(
    "health_capability_open",
    healthData.data?.capability?.state === "open",
    healthData.data?.capability?.state,
  );
  check("health_caches_present", healthData.data?.caches != null, true);
  check(
    "health_metrics_present",
    healthData.data?.metrics?.operations != null,
    true,
  );

  // 16. Health audit (full)
  const healthFull = await call("project_health", { include_audit: 1 });
  const healthFullData = JSON.parse(
    (healthFull as { content: { text: string }[] })?.content[0].text ?? "{}",
  );
  check(
    "health_audit_present",
    !!healthFullData.data?.audit?.reachable,
    healthFullData.data?.audit,
  );
  check(
    "health_loop_metric_present",
    Array.isArray(healthFullData.data?.audit?.loop_failures),
    healthFullData.data?.audit,
  );
  check(
    "health_loop_metric_detects_repeat",
    (healthFullData.data?.audit?.loop_failures ?? []).some(
      (item: { operation?: string; reason_code?: string; count?: number }) =>
        item.operation === "read_file" &&
        item.reason_code === "not_found" &&
        Number(item.count) >= 2,
    ),
    healthFullData.data?.audit?.loop_failures,
  );
  check(
    "health_adoption_metric_present",
    Array.isArray(healthFullData.data?.audit?.adoption_runs),
    healthFullData.data?.audit,
  );
  check(
    "health_adoption_metric_detects_run",
    (healthFullData.data?.audit?.adoption_runs ?? []).some(
      (item: { operation?: string; count?: number; duration_ms?: number }) =>
        item.operation === "read_file" &&
        Number(item.count) >= 3 &&
        Number(item.duration_ms) <= 60_000,
    ),
    healthFullData.data?.audit?.adoption_runs,
  );

  // 17. Error envelope shape
  const errorEnvelopeCheck = (
    result: string,
    code: string,
    retryable: boolean,
  ) => {
    try {
      const obj = JSON.parse(result);
      const e = obj.error as { code?: string; retryable?: boolean };
      return e.code === code && e.retryable === retryable;
    } catch {
      return false;
    }
  };
  const missingRes = (await call("project_read_file", {
    relative_path: `${dir}/missing.txt`,
  })) as { content?: { text?: string }[] };
  check(
    "error_envelope_not_found_shape",
    errorEnvelopeCheck(
      missingRes?.content?.[0]?.text ?? "",
      "not_found",
      false,
    ),
  );

  // 17a. Structured recovery data is bounded and never exposes protected content.
  await call("project_write_file", {
    relative_path: `${dir}/structured-errors.txt`,
    content: "same line\nsame line\n",
  });
  const ambiguousEdit = asEnvelope(
    await call("project_edit_file", {
      relative_path: `${dir}/structured-errors.txt`,
      old_text: "same line",
      new_text: "changed",
    }),
  );
  const ambiguousData =
    ambiguousEdit.error?.code === "old_text_ambiguous"
      ? ambiguousEdit.data
      : undefined;
  check(
    "error_data_ambiguous_shape",
    ambiguousEdit.error?.code === "old_text_ambiguous" &&
      ambiguousData?.occurrences === 2 &&
      Array.isArray(ambiguousData?.matches) &&
      ambiguousData.matches.length <= 5 &&
      ambiguousData.matches.every(
        (match: { line?: unknown; context?: unknown }) =>
          Number.isInteger(match.line) &&
          Array.isArray(match.context) &&
          match.context.length <= 3,
      ),
    ambiguousEdit,
  );
  check(
    "error_data_ambiguous_bounded",
    JSON.stringify(ambiguousData ?? "").length <= 4096,
    ambiguousData,
  );

  const missingEdit = asEnvelope(
    await call("project_edit_file", {
      relative_path: `${dir}/structured-errors.txt`,
      old_text: "not present",
      new_text: "changed",
    }),
  );
  check(
    "error_data_not_found_shape",
    missingEdit.error?.code === "old_text_not_found" &&
      missingEdit.data?.occurrences === 0 &&
      typeof missingEdit.data?.suggestion === "string",
    missingEdit,
  );

  const staleEdit = asEnvelope(
    await call("project_edit_file", {
      relative_path: `${dir}/structured-errors.txt`,
      old_text: "same line",
      new_text: "changed",
      expected_sha256: "0".repeat(64),
    }),
  );
  check(
    "error_data_stale_shape",
    staleEdit.error?.code === "stale_content" &&
      typeof staleEdit.data?.sha256 === "string" &&
      staleEdit.data.sha256.length === 64 &&
      staleEdit.data.expected_sha256 === "0".repeat(64) &&
      Number.isFinite(staleEdit.data.mtime_ms),
    staleEdit,
  );

  const sensitiveMarker = "verify-sensitive-marker-should-never-leak";
  await fs.writeFile(`${dir}/.env.local`, `TOKEN=${sensitiveMarker}\n`);
  const sensitiveRead = asEnvelope(
    await call("project_read_file", { relative_path: `${dir}/.env.local` }),
  );
  check(
    "error_data_sensitive_path_excluded",
    sensitiveRead.error?.code === "sensitive_result" &&
      !JSON.stringify(sensitiveRead).includes(sensitiveMarker) &&
      sensitiveRead.data === undefined,
    sensitiveRead,
  );
  const protectedTargetDir = `${dir}/protected-target`;
  const protectedAliasDir = `${dir}/protected-alias`;
  await fs.mkdir(protectedTargetDir, { recursive: true });
  await fs.writeFile(
    `${protectedTargetDir}/.env.local`,
    `TOKEN=${sensitiveMarker}\n`,
  );
  try {
    await fs.symlink(
      path.resolve(protectedTargetDir),
      protectedAliasDir,
      process.platform === "win32" ? "junction" : "dir",
    );
    const protectedAliasRead = asEnvelope(
      await call("project_read_file", {
        relative_path: `${protectedAliasDir}/.env.local`,
      }),
    );
    check(
      "error_data_sensitive_symlink_alias_excluded",
      protectedAliasRead.error?.code === "sensitive_result" &&
        !JSON.stringify(protectedAliasRead).includes(sensitiveMarker),
      protectedAliasRead,
    );
  } catch (error) {
    check("error_data_sensitive_symlink_alias_excluded", false, error);
  }

  // 17b. Protected files stay protected through the code-intelligence readers and
  // through NTFS alternate-data-stream spellings. Both used to return plaintext.
  const symbolLeak = asEnvelope(
    await call("project_symbol_references", {
      symbol_name: "TOKEN",
      scope: "file",
      relative_path: `${dir}/.env.local`,
    }),
  );
  check(
    "sensitive_symbol_references_excluded",
    symbolLeak.error?.code === "sensitive_result" &&
      !JSON.stringify(symbolLeak).includes(sensitiveMarker),
    symbolLeak,
  );
  const multiQueryLeak = asEnvelope(
    await call("project_search", {
      queries: [{ pattern: "TOKEN" }],
      files_hint: [`${dir}/.env.local`],
    }),
  );
  check(
    "sensitive_multi_query_search_excluded",
    multiQueryLeak.error?.code === "sensitive_result" &&
      !JSON.stringify(multiQueryLeak).includes(sensitiveMarker),
    multiQueryLeak,
  );
  await fs.writeFile(`${dir}/.env::$DATA`, `TOKEN=${sensitiveMarker}\n`);
  const adsLeak = asEnvelope(
    await call("project_symbol_references", {
      symbol_name: "TOKEN",
      scope: "file",
      relative_path: `${dir}/.env::$DATA`,
    }),
  );
  check(
    "sensitive_alternate_data_stream_excluded",
    adsLeak.error?.code === "sensitive_result" &&
      !JSON.stringify(adsLeak).includes(sensitiveMarker),
    adsLeak,
  );

  // 17c. The workspace root itself cannot be deleted (there is no undo).
  const rootGuardDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "venira-root-guard-"),
  );
  await fs.writeFile(path.join(rootGuardDir, "keep.txt"), "keep\n");
  const rootGuardTransport = new StdioClientTransport({
    command: "node",
    args: ["dist/server.js"],
    cwd: process.cwd(),
    env: verifyEnv(
      {
        VENIRA_SESSION_ID: `${SESSION_ID}-root-guard`,
        VENIRA_WORKSPACE: rootGuardDir,
      },
      "full",
    ),
    stderr: "pipe",
  });
  const rootGuardClient = new Client(
    { name: "verify-root-guard", version: "0.0.0" },
    { capabilities: {} },
  );
  await rootGuardClient.connect(rootGuardTransport);
  const rootDelete = asEnvelope(
    await rootGuardClient.callTool({
      name: "project_delete_path",
      arguments: { relative_path: ".", recursive: 1 },
    }),
  );
  const rootSurvived = (await fs.readdir(rootGuardDir)).includes("keep.txt");
  check(
    "delete_workspace_root_refused",
    rootDelete.error?.code === "invalid_request" && rootSurvived,
    { rootDelete, rootSurvived },
  );
  await rootGuardClient.close();
  await fs.rm(rootGuardDir, { recursive: true, force: true });

  // 17d. execute_js (semi-auto) output is redacted and the network globals are removed.
  // Approval is switched off here so the redaction/network assertions run in one
  // call; 17e covers the approval gate separately.
  const jsTransport = new StdioClientTransport({
    command: "node",
    args: ["dist/server.js"],
    cwd: process.cwd(),
    env: verifyEnv(
      {
        VENIRA_SESSION_ID: `${SESSION_ID}-js-exec`,
        VENIRA_JS_EXEC_MODE: "semi-auto",
      },
      "full",
    ),
    stderr: "pipe",
  });
  const jsClient = new Client(
    { name: "verify-js-exec", version: "0.0.0" },
    { capabilities: {} },
  );
  await jsClient.connect(jsTransport);
  const jsLeak = asEnvelope(
    await jsClient.callTool({
      name: "project_execute_js",
      arguments: {
        code: 'console.log("TOP_SECRET=abc123"); console.log("fetch:" + typeof fetch);',
      },
    }),
  );
  check(
    "execute_js_output_redacted_and_network_off",
    !JSON.stringify(jsLeak).includes("abc123") &&
      String(jsLeak.data?.stdout_tail ?? "").includes("fetch:undefined"),
    jsLeak,
  );
  await jsClient.close();

  // 17d-2. Mode `auto` is the uncontained mode: no approval and no network guard,
  // so the globals that `semi-auto` removes are present. Output is still redacted.
  const jsOpenTransport = new StdioClientTransport({
    command: "node",
    args: ["dist/server.js"],
    cwd: process.cwd(),
    env: verifyEnv(
      {
        VENIRA_SESSION_ID: `${SESSION_ID}-js-exec-open`,
        VENIRA_JS_EXEC_MODE: "auto",
      },
      "full",
    ),
    stderr: "pipe",
  });
  const jsOpenClient = new Client(
    { name: "verify-js-exec-open", version: "0.0.0" },
    { capabilities: {} },
  );
  await jsOpenClient.connect(jsOpenTransport);
  const jsOpen = asEnvelope(
    await jsOpenClient.callTool({
      name: "project_execute_js",
      arguments: {
        code: 'console.log("TOP_SECRET=abc123"); console.log("fetch:" + typeof fetch);',
      },
    }),
  );
  check(
    "execute_js_auto_is_uncontained_but_redacted",
    !JSON.stringify(jsOpen).includes("abc123") &&
      String(jsOpen.data?.stdout_tail ?? "").includes("fetch:function"),
    jsOpen,
  );
  await jsOpenClient.close();

  // 17e. execute_js needs a per-call human grant by default, bound to the exact
  // code, single-use, and granted through the same CLI as shell approvals.
  const jsApprovalTransport = new StdioClientTransport({
    command: "node",
    args: ["dist/server.js"],
    cwd: process.cwd(),
    env: verifyEnv(
      {
        VENIRA_SESSION_ID: `${SESSION_ID}-js-approval`,
        VENIRA_JS_EXEC_MODE: "ask",
      },
      "full",
    ),
    stderr: "pipe",
  });
  const jsApprovalClient = new Client(
    { name: "verify-js-approval", version: "0.0.0" },
    { capabilities: {} },
  );
  await jsApprovalClient.connect(jsApprovalTransport);
  const jsApprovedCode = 'console.log("approval-ok");';
  const jsAsk = asEnvelope(
    await jsApprovalClient.callTool({
      name: "project_execute_js",
      arguments: { code: jsApprovedCode },
    }),
  );
  const jsApprovalId = String(jsAsk.data?.approval_id ?? "");
  check(
    "execute_js_approval_required",
    jsAsk.error?.code === "approval_required" &&
      !!jsApprovalId &&
      jsAsk.data?.rule === "ask.js_exec" &&
      String(jsAsk.data?.note ?? "").includes(
        String(jsAsk.data?.approval?.approve_command ?? ""),
      ),
    jsAsk,
  );
  const jsPayload = (jsAsk.data?.approval ?? {}) as Record<string, any>;
  check(
    "approval_payload_js_shape",
    jsPayload.approval_id === jsApprovalId &&
      jsPayload.gate === "js" &&
      jsPayload.rule === "ask.js_exec" &&
      String(jsPayload.approve_command ?? "").includes(jsApprovalId) &&
      jsPayload.retry_with?.tool === "project_execute_js" &&
      jsPayload.retry_with?.arguments?.approval_id === jsApprovalId,
    jsPayload,
  );
  writeApprovalGrant(jsApprovalId);
  const jsWrongCode = asEnvelope(
    await jsApprovalClient.callTool({
      name: "project_execute_js",
      arguments: {
        code: `${jsApprovedCode} console.log("different");`,
        approval_id: jsApprovalId,
      },
    }),
  );
  check(
    "execute_js_approval_bound_to_code",
    jsWrongCode.error?.code === "approval_invalid",
    jsWrongCode,
  );
  const jsApprovedRun = asEnvelope(
    await jsApprovalClient.callTool({
      name: "project_execute_js",
      arguments: { code: jsApprovedCode, approval_id: jsApprovalId },
    }),
  );
  check(
    "execute_js_approval_runs_once",
    jsApprovedRun.ok === true &&
      String(jsApprovedRun.data?.stdout_tail ?? "").includes("approval-ok"),
    jsApprovedRun,
  );
  const jsApprovalReuse = asEnvelope(
    await jsApprovalClient.callTool({
      name: "project_execute_js",
      arguments: { code: jsApprovedCode, approval_id: jsApprovalId },
    }),
  );
  check(
    "execute_js_approval_single_use",
    jsApprovalReuse.error?.code === "approval_invalid",
    jsApprovalReuse,
  );
  await jsApprovalClient.close();

  // 18. batch per-item budget
  const batchBudget = await call("project_read_batch", {
    requests: [
      { operation: "read_file", arguments: { relative_path: "server.ts" } },
    ],
    max_response_bytes_per_item: 1024,
  });
  const batchBudgetData = JSON.parse(
    (batchBudget as { content?: { text?: string }[] })?.content?.[0]?.text ??
      "{}",
  );
  const budgetErr = (batchBudgetData.data?.responses as unknown[])[0] as {
    ok?: boolean;
    error?: { code?: string };
  };
  check(
    "batch_item_budget_exceeded",
    budgetErr?.ok === false && budgetErr?.error?.code === "resource_limit",
    budgetErr?.error,
  );
  return { health, healthData };
}
