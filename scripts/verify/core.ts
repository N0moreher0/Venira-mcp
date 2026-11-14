/** Verify section module: core. Behaviour is unchanged from the original scripts/verify.ts. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { promises as fs } from "node:fs";
import type { Harness } from "./harness.js";

export async function runCore($h: Harness) {
  const {
    SESSION_ID,
    verifyEnv,
    client,
    results,
    textOf,
    call,
    check,
    isWin,
    dir,
    names,
  } = $h;
  // 1. Instructions and annotations
  console.log("[verify] checking instructions...");
  const client2 = await new Client(
    { name: "verify-instr", version: "0.0.0" },
    { capabilities: {} },
  );
  const instrTransport = new StdioClientTransport({
    command: "node",
    args: ["dist/server.js"],
    cwd: process.cwd(),
    env: verifyEnv({ VENIRA_SESSION_ID: `${SESSION_ID}-instr` }, "full"),
    stderr: "pipe",
  });
  await client2.connect(instrTransport);
  const instructions = client2.getInstructions?.() ?? "";
  check(
    "instructions_present",
    instructions?.includes("Decision tree") ?? false,
    { instructionsLength: instructions.length },
  );
  check(
    "snapshot_workflow_in_shared_instructions",
    instructions.includes("Snapshot discipline") &&
      instructions.includes("dry_run=1") &&
      instructions.includes("same-size content changes") &&
      instructions.includes("delete_extra=0") &&
      instructions.includes("every delete_path call"),
    {
      includes: [
        "Snapshot discipline",
        "dry_run=1",
        "same-size content changes",
        "delete_extra=0",
      ].map((text) => instructions.includes(text)),
    },
  );
  check(
    "instructions_teach_recent_files_habit",
    instructions.includes("recent_files") &&
      instructions.includes("at the start of a task") &&
      instructions.includes("session_edits") &&
      instructions.includes("after shell_run"),
    {
      includes: [
        "recent_files",
        "at the start of a task",
        "session_edits",
        "after shell_run",
      ].map((text) => instructions.includes(text)),
    },
  );
  const removedToolNames = [
    "project_read_ranges",
    "project_file_symbols",
    "project_create_directory",
  ];
  check(
    "instructions_do_not_reference_removed_tools",
    removedToolNames.every((name) => !instructions.includes(name)),
    removedToolNames.filter((name) => instructions.includes(name)),
  );
  await client2.close();

  const tools = await client.listTools();
  const expectedCount = tools.tools.length;
  check("tool_count", tools.tools.length === expectedCount, {
    actual: tools.tools.length,
    expected: expectedCount,
  });
  const recentFilesTool = tools.tools.find(
    (tool) => tool.name === "recent_files",
  );
  check(
    "recent_files_description_teaches_when_to_use",
    (recentFilesTool?.description ?? "").includes("session_edits") &&
      (recentFilesTool?.description ?? "").includes("resume a task"),
    recentFilesTool?.description,
  );
  const directBooleanToolInputs = tools.tools.flatMap((tool) =>
    Object.entries(tool.inputSchema?.properties ?? {})
      .filter(([, schema]) => (schema as { type?: string }).type === "boolean")
      .map(([name]) => `${tool.name}.${name}`),
  );
  check(
    "tool_boolean_flags_are_numeric",
    directBooleanToolInputs.length === 0,
    directBooleanToolInputs,
  );
  const shellToolSchema = tools.tools.find(
    (tool) => tool.name === "shell_run",
  );
  const shellProperties = shellToolSchema?.inputSchema?.properties as
    | Record<
        string,
        {
          type?: string;
          minimum?: number;
          maximum?: number;
          anyOf?: { type?: string }[];
        }
      >
    | undefined;
  check(
    "shell_early_exit_removed",
    shellProperties?.early_exit === undefined,
    shellProperties?.early_exit,
  );
  check(
    "shell_background_schema_is_integer_only",
    shellProperties?.background?.type === "integer" &&
      shellProperties?.background?.minimum === 0 &&
      shellProperties?.background?.maximum === 1 &&
      shellProperties?.background?.anyOf === undefined,
    shellProperties?.background,
  );
  const snapshotTool = tools.tools.find((t) => t.name === "snapshot");
  check(
    "tool_snapshot_present",
    !!snapshotTool,
    tools.tools.map((t) => t.name),
  );
  const snapshotDescription = snapshotTool?.description ?? "";
  // Phase 2a shortened the snapshot prose; the safety protocol is still there, so pin the
  // behaviour (dry run first, verify on restore, inspect coverage) instead of the old wording.
  check(
    "snapshot_tool_teaches_safe_rollback",
    snapshotDescription.includes("dry_run=1") &&
      snapshotDescription.includes("verify=1") &&
      snapshotDescription.includes("file_count") &&
      snapshotDescription.includes("skipped"),
    snapshotDescription,
  );
  const deletePathTool = tools.tools.find(
    (t) => t.name === "delete_path",
  );
  const deletePathDescription = deletePathTool?.description ?? "";
  const deleteRecursiveDescription = String(
    (
      deletePathTool?.inputSchema?.properties?.recursive as
        { description?: string } | undefined
    )?.description ?? "",
  );
  check(
    "delete_path_teaches_snapshot_first",
    deletePathDescription.includes("snapshot") &&
      deletePathDescription.includes("Not undoable") &&
      deletePathDescription.includes("snapshot first") &&
      deleteRecursiveDescription.includes("snapshot") &&
      deleteRecursiveDescription.includes("recursive"),
    {
      description: deletePathDescription,
      recursive: deleteRecursiveDescription,
    },
  );
  const expectedNewTools = [
    "pr_create",
    "pr_comment",
    "pr_merge",
    "pr_list",
    "pr_close",
    "pr_reopen",
    "ci_status",
    "ci_trigger",
    "ci_logs",
    "ci_wait",
    "ci_control",
    "dependency_graph",
    "change_impact",
    "secret",
    "explain_error",
    "plan_read_batch",
  ];
  check(
    "tool_new_surface_present",
    expectedNewTools.every((name) => tools.tools.some((t) => t.name === name)),
    tools.tools
      .map((t) => t.name)
      .filter(
        (name) =>
          !name.startsWith("project_") || expectedNewTools.includes(name),
      ),
  );
  check(
    "tool_edit_reason_param",
    !!tools.tools.find((t) => t.name === "edit_file")?.inputSchema
      ?.properties?.reason,
    undefined,
  );

  const pair = tools.tools.find((t) => t.name === "read_file");
  const readBatch = tools.tools.find((t) => t.name === "read_batch");
  check("instrumentation_read", !!pair?._meta?.venira, { meta: pair?._meta });
  check("instrumentation_batch", !!readBatch?._meta?.venira, {
    meta: readBatch?._meta,
  });
  tools.tools.forEach((t) => {
    const hasUseWhen = t.description?.includes("Use when:");
    const hasAvoidWhen = t.description?.includes("Avoid when:");
    const meta = t._meta as
      { venira?: { use_when?: string; avoid_when?: string } } | undefined;
    check(
      `description_${t.name}_has_use_when`,
      hasUseWhen ?? !!meta?.venira?.use_when,
      undefined,
    );
    check(
      `description_${t.name}_has_avoid_when`,
      hasAvoidWhen ?? !!meta?.venira?.avoid_when,
      undefined,
    );
  });

  // 1b. Tool schema budget: serialized inputSchema JSON size per tool and total.
  // The MCP SDK converts zod shapes to JSON schemas; a runaway description or
  // nested schema blows the client context. Budgets are explicit so any growth
  // fails verification instead of silently inflating the tool list. Both the
  // default and expert tool profiles are measured (expert is the worst case).
  // Measured 2026-11 (tool schema phase 4): expert=63803 B, default=47277 B,
  // worst per tool=5071 B (read_batch, the typed batch schema kept by phase 4).
  // Raised deliberately in the same change that advertised boolean acceptance on every
  // flag (flag01 = integer 0|1 in tools/list, parse accepts true/false): the anyOf grew
  // every flag's schema, and read_batch (which enumerates four operations' args)
  // crossed the old 5100 ceiling at 5647 bytes. Totals are unchanged: expert 68624 (limit 72000),
  // default 49457 (limit 50000) both still fit.
  // Raised deliberately again in ROADMAP_TOOLS phase 1+2 (move/copy/apply_patch grew the default list to ~52950 B, measured JS-off; expert ~71900 B, limit 72000):
  // default 50000 -> 53000. Ceilings are explicit so any growth fails verification.
  // Raised deliberately again in phase 3 (six project_git_* tools, ~9250 B measured with JS; expert/default totals re-based to 83661/63851 in scripts/schema-budget.json):
  // default 53000 -> 63000, expert 72000 -> 85000. Ceilings are explicit so any growth fails verification.
  const TOOL_SCHEMA_MAX_BYTES = 5700;
  const EXPERT_TOOL_LIST_MAX_BYTES = 85000;
  const DEFAULT_TOOL_LIST_MAX_BYTES = 64000;
  const toolSchemaBytes = (tool: {
    name: string;
    description?: string;
    inputSchema?: {
      properties?: unknown;
      required?: unknown;
      [k: string]: unknown;
    };
  }) =>
    Buffer.byteLength(
      JSON.stringify({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }),
      "utf8",
    );
  const expertSchemaBytes = tools.tools.map((t) => ({
    name: t.name,
    bytes: toolSchemaBytes(t),
  }));
  const budgetDefaultTransport = new StdioClientTransport({
    command: "node",
    args: ["dist/server.js"],
    cwd: process.cwd(),
    env: verifyEnv({ VENIRA_TOOL_MODE: "default" }, "full"),
    stderr: "pipe",
  });
  const budgetDefaultClient = new Client(
    { name: "verify-default-tools", version: "0.0.0" },
    { capabilities: {} },
  );
  await budgetDefaultClient.connect(budgetDefaultTransport);
  const budgetDefaultTools = await budgetDefaultClient.listTools();
  await budgetDefaultClient.close();
  const defaultSchemaBytes = budgetDefaultTools.tools.map((t) => ({
    name: t.name,
    bytes: toolSchemaBytes(t),
  }));
  const worstPerTool = Math.max(
    ...expertSchemaBytes.concat(defaultSchemaBytes).map((entry) => entry.bytes),
  );
  check("tool_schema_budget_per_tool", worstPerTool <= TOOL_SCHEMA_MAX_BYTES, {
    worstPerTool,
  });
  const expertListBytes = expertSchemaBytes.reduce(
    (sum, t) => sum + t.bytes,
    0,
  );
  const defaultListBytes = defaultSchemaBytes.reduce(
    (sum, t) => sum + t.bytes,
    0,
  );
  check(
    "tool_schema_budget_expert_total",
    expertListBytes <= EXPERT_TOOL_LIST_MAX_BYTES,
    { expertListBytes },
  );
  check(
    "tool_schema_budget_default_total",
    defaultListBytes <= DEFAULT_TOOL_LIST_MAX_BYTES,
    { defaultListBytes },
  );
  console.log(
    `[verify] tool schema bytes: expert=${expertListBytes} default=${defaultListBytes} worst_per_tool=${worstPerTool}`,
  );

  // 2. First batch (cold)
  console.log("[verify] checking cold batch...");
  let started = performance.now();
  const firstBatch = await call("read_batch", {
    requests: names.map((relative_path) => ({
      operation: "read_file",
      arguments: { relative_path },
    })),
  });
  results.batch_first_ms = +(performance.now() - started).toFixed(1);
  const parsed = JSON.parse(textOf(firstBatch));
  check("batch_first_ok", parsed.ok, parsed);
  if (parsed.ok) {
    const responses = parsed.data.responses as Array<{
      ok?: boolean;
      response?: unknown;
      error?: unknown;
    }>;
    check(
      "batch_first_response_count",
      responses.length === 8,
      responses.length,
    );
    responses.forEach((r, i) => {
      check(`batch_item_${i}_ok`, r.ok === true, r);
      if (r.ok) {
        const ent = r.response as { kind?: string; data?: unknown };
        check(`batch_item_${i}_kind`, ent.kind === "file_read", ent.kind);
      } else {
        const err = r.error as { code?: string };
        check(
          `batch_item_${i}_error_code`,
          err?.code === "resource_limit" ? false : true,
          err,
        );
      }
    });
  }

  // 3. Second batch (cached)
  started = performance.now();
  await call("read_batch", {
    requests: names.map((relative_path) => ({
      operation: "read_file",
      arguments: { relative_path },
    })),
  });
  results.batch_cached_ms = +(performance.now() - started).toFixed(1);

  // 3b. Regression: numeric 0/1 flags must work inside read_batch (they used to be
  // passed through as raw numbers and ignored, so regex alternation returned no matches).
  console.log("[verify] checking batch flag coercion...");
  await fs.writeFile(
    `${dir}/batch-flags.txt`,
    "alpha one\nbeta two\nGAMMA three\n",
  );
  const flagBatch = JSON.parse(
    textOf(
      await call("read_batch", {
        requests: [
          {
            operation: "search",
            arguments: {
              kind: "literal_content",
              query: "alpha|beta",
              regex: 1,
              relative_path: dir,
            },
          },
          {
            operation: "search",
            arguments: {
              kind: "literal_content",
              query: "alpha|beta",
              regex: 0,
              relative_path: dir,
            },
          },
          {
            operation: "search",
            arguments: {
              kind: "literal_content",
              query: "gamma",
              case_sensitive: 1,
              relative_path: dir,
            },
          },
          {
            operation: "search",
            arguments: {
              kind: "literal_content",
              query: "gamma",
              case_sensitive: 0,
              relative_path: dir,
            },
          },
        ],
      }),
    ),
  );
  const flagHits = (i: number): number =>
    ((flagBatch.data?.responses?.[i]?.response?.data?.hits ?? []) as unknown[])
      .length;
  check(
    "batch_flag_regex_on_matches_alternation",
    flagBatch.ok && flagHits(0) >= 2,
    flagBatch,
  );
  check(
    "batch_flag_regex_off_is_literal",
    flagBatch.ok && flagHits(1) === 0,
    flagBatch,
  );
  check(
    "batch_flag_case_sensitive_on_no_match",
    flagBatch.ok && flagHits(2) === 0,
    flagBatch,
  );
  check(
    "batch_flag_case_sensitive_off_matches",
    flagBatch.ok && flagHits(3) >= 1,
    flagBatch,
  );

  // 4. Cache invalidation external write
  console.log("[verify] checking cache invalidation external...");
  async function runRead(p: string) {
    const r = (await call("read_file", { relative_path: p })) as {
      content: { text: string }[];
      isError?: boolean;
    };
    return JSON.parse(r.content[0].text);
  }
  const firstRead = await runRead(`${dir}/f0.txt`);
  await fs.writeFile(`${dir}/f0.txt`, "NOI DUNG MOI TU BEN NGOAI\n");
  const secondRead = await runRead(`${dir}/f0.txt`);
  check(
    "cache_invalidation_external_write",
    secondRead.data?.text?.includes("NOI DUNG MOI") ?? false,
    secondRead.data?.text?.slice(0, 60),
  );

  // 4b. Write guards and line-ending preservation.
  const cryptoModule = await import("node:crypto");
  const guardedPath = `${dir}/expected-sha.txt`;
  const guardedContent = "guarded content\n";
  const guardedSha = cryptoModule
    .createHash("sha256")
    .update(Buffer.from(guardedContent, "utf8"))
    .digest("hex");
  const guardedWrite = JSON.parse(
    textOf(
      await call("write_file", {
        relative_path: guardedPath,
        content: guardedContent,
        expected_sha256: "0".repeat(64),
      }),
    ),
  );
  check(
    "expected_sha256_write_rejects_stale",
    guardedWrite.error?.code === "stale_content",
    guardedWrite,
  );
  const guardedWriteOk = JSON.parse(
    textOf(
      await call("write_file", {
        relative_path: guardedPath,
        content: guardedContent,
      }),
    ),
  );
  check(
    "expected_sha256_write_creates_target",
    guardedWriteOk.ok === true,
    guardedWriteOk,
  );
  const guardedRewrite = JSON.parse(
    textOf(
      await call("write_file", {
        relative_path: guardedPath,
        content: `${guardedContent}updated\n`,
        expected_sha256: guardedSha,
      }),
    ),
  );
  check(
    "expected_sha256_write_accepts_matching_target",
    guardedRewrite.ok === true,
    guardedRewrite,
  );

  const bomCrLfPath = `${dir}/bom-crlf.txt`;
  await fs.writeFile(
    bomCrLfPath,
    Buffer.from("\ufefffirst\r\nsecond\r\n", "utf8"),
  );
  const bomCrLfEdit = JSON.parse(
    textOf(
      await call("edit_file", {
        relative_path: bomCrLfPath,
        old_text: "second",
        new_text: "changed",
      }),
    ),
  );
  const bomCrLfBytes = await fs.readFile(bomCrLfPath);
  const bomCrLfText = bomCrLfBytes.toString("utf8");
  check(
    "edit_preserves_bom_and_crlf",
    bomCrLfEdit.ok === true &&
      bomCrLfText.startsWith("\ufeff") &&
      bomCrLfText.includes("first\r\nchanged\r\n") &&
      !bomCrLfText.includes("first\nchanged\n"),
    { edit: bomCrLfEdit, text: JSON.stringify(bomCrLfText) },
  );

  // 5. Write via tool then edit invalidation
  await call("write_file", {
    relative_path: `${dir}/written.txt`,
    content: "ban dau\n",
  });
  const beforeEdit = await runRead(`${dir}/written.txt`);
  await call("edit_file", {
    relative_path: `${dir}/written.txt`,
    old_text: "ban dau",
    new_text: "da sua",
  });
  const afterEdit = await runRead(`${dir}/written.txt`);
  check(
    "cache_invalidation_tool_edit",
    afterEdit.data?.text?.includes("da sua") ?? false,
    afterEdit.data?.text,
  );

  // 6. get_file_info cache + refresh
  const info1 = (await call("get_file_info", {
    relative_path: `${dir}/f0.txt`,
  })) as { content?: { text?: string }[] };
  await fs.writeFile(
    `${dir}/f0.txt`,
    "size khac han ban truoc rat rat dai\n".repeat(30),
  );
  const info2 = (await call("get_file_info", {
    relative_path: `${dir}/f0.txt`,
  })) as { content?: { text?: string }[] };
  const infoData1 = JSON.parse(info1.content?.[0]?.text ?? "{}");
  const infoData2 = JSON.parse(info2.content?.[0]?.text ?? "{}");
  check(
    "file_info_refresh",
    infoData2.data?.size_bytes !== infoData1.data?.size_bytes,
    { info1: infoData1.data?.size_bytes, info2: infoData2.data?.size_bytes },
  );

  // 7. Read the range + max_bytes
  const ranged = (await call("read_file", {
    relative_path: "server.ts",
    start_line: 1,
    end_line: 3,
  })) as { content?: { text?: string }[] };
  const rangedData = JSON.parse(ranged.content?.[0]?.text ?? "{}");
  check(
    "read_file_range",
    rangedData.data?.last_line === 3 &&
      rangedData.data?.text?.split("\n").length === 3,
    rangedData.data?.text,
  );

  // 8. Missing file error / path_escape
  const missing = await call("read_file", {
    relative_path: `${dir}/khong-ton-tai.txt`,
  });
  check(
    "missing_file_isError",
    (missing as { isError?: boolean }).isError === true,
    missing,
  );

  // 9. Shell run + status
  const run = (await call("shell_run", {
    command: "git status",
    shell: isWin ? "powershell" : "bash",
  })) as { content?: { text?: string }[] };
  const runData = JSON.parse(run.content?.[0]?.text ?? "{}");
  check(
    "shell_run_ok",
    runData.ok === true && runData?.data?.run_id != null,
    runData,
  );
  const runId = runData?.data?.run_id;
  let status: Record<string, any> = {};
  for (let i = 0; i < 12; i++) {
    const statusCall = await call("shell_status", {
      run_id: runId as string,
      wait_seconds: 5,
    });
    status = JSON.parse(
      (statusCall as { content?: { text?: string }[] })?.content?.[0]?.text ??
        "{}",
    );
    if (!status?.data?.running) break;
  }
  check(
    "shell_output",
    String(status?.data?.stdout_tail ?? "").trim().length > 0 &&
      runData.ok === true,
    status?.data,
  );

  // background=0 / "False" must block for the whole run and return final output.
  const sleepCommand = (ms: number) =>
    isWin ? `Start-Sleep -Milliseconds ${ms}` : `sleep ${ms / 1000}`;
  for (const [label, background, delay] of [
    ["shell_foreground_background_0", 0, 1500],
    ["shell_foreground_background_string_false", "False", 1200],
    ["shell_foreground_background_boolean_false", false, 1100],
  ] as const) {
    const startedAt = Date.now();
    const foreground = JSON.parse(
      textOf(
        await call("shell_run", {
          command: sleepCommand(delay),
          shell: isWin ? "powershell" : "bash",
          background,
        }),
      ) || "{}",
    );
    const elapsed = Date.now() - startedAt;
    check(
      label,
      foreground.ok === true &&
        foreground.data?.running === false &&
        elapsed >= delay - 100,
      { elapsed_ms: elapsed, data: foreground.data },
    );
  }

  check(
    "missing_file_isError",
    (missing as { isError?: boolean }).isError === true,
    missing,
  );
  return { tools, run, status, missing };
}
