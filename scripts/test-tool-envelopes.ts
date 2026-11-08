/**
 * Regression test for what tools tell the model when something succeeds or fails.
 *
 * Pins:
 *   1. Search globs follow rg semantics: `tools/*.ts` matches inside that directory, `*.ts` at any depth.
 *   2. Failure envelopes carry the right recovery: a missing checkpoint or run id never points at
 *      project_list_files, an edit that did not match points at project_read_file, a bad regex says so.
 *   3. A shell command that exits non-zero stays ok=true but carries a "Command failed" hint.
 *   4. project_edit_batch reports a failed batch at the top level (ok=false, kind=edit_batch,
 *      error batch_failed) and says honestly whether the rollback happened.
 *
 * Run with: npm run test:tool-envelopes
 */
import "./clean-env.js"; // must stay first: inherited VENIRA_* env would change behavior
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const modeArg =
  process.argv
    .find((arg) => arg.startsWith("--mode="))
    ?.slice("--mode=".length) ?? "full";
assert.ok(
  modeArg === "full" || modeArg === "compact",
  `Unsupported output mode: ${modeArg}`,
);
process.env.VENIRA_OUTPUT_MODE = modeArg;
const tempDir = await mkdtemp(path.join(os.tmpdir(), "venira-tool-envelopes-"));
const workspaceDir = path.join(tempDir, "workspace");
await mkdir(path.join(workspaceDir, "tools"), { recursive: true });
await mkdir(path.join(workspaceDir, "lib", "deep"), { recursive: true });
await writeFile(path.join(workspaceDir, "tools", "a.ts"), "needle\n");
await writeFile(path.join(workspaceDir, "lib", "deep", "b.ts"), "needle\n");
await writeFile(path.join(workspaceDir, "notes.md"), "needle\n");
process.env.VENIRA_WORKSPACE = workspaceDir;
process.env.VENIRA_DATA_DIR = path.join(tempDir, "data");

const load = (rel: string) =>
  import(pathToFileURL(path.join(repoRoot, rel)).href);
const search = (await load(
  "lib/corehost-search.ts",
)) as typeof import("../lib/corehost-search.js");
const output = (await load(
  "lib/output.ts",
)) as typeof import("../lib/output.js");
const batch = (await load(
  "tools/project-batch.ts",
)) as typeof import("../tools/project-batch.js");
const operations = (await load(
  "tools/project-operations.ts",
)) as typeof import("../tools/project-operations.js");

let checks = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  await fn();
  checks += 1;
  console.log(`PASS ${name}`);
}

try {
  // ---- 1. glob semantics -------------------------------------------------
  async function globHits(glob: string): Promise<string[]> {
    const res = await search.opSearch(
      { query: "needle", kind: "literal_content", relative_path: ".", glob },
      workspaceDir,
    );
    const hits = (
      (res.result?.data as { hits?: { relative_path: string }[] } | undefined)
        ?.hits ?? []
    ).map((h) => h.relative_path.replace(/\\/g, "/"));
    return [...new Set(hits)].sort();
  }
  await check("glob_dir_star", async () =>
    assert.deepEqual(await globHits("tools/*.ts"), ["tools/a.ts"]),
  );
  await check("glob_basename_any_depth", async () =>
    assert.deepEqual(await globHits("*.ts"), ["lib/deep/b.ts", "tools/a.ts"]),
  );
  await check("glob_double_star", async () =>
    assert.deepEqual(await globHits("lib/**/*.ts"), ["lib/deep/b.ts"]),
  );
  await check("glob_ext", async () =>
    assert.deepEqual(await globHits("*.md"), ["notes.md"]),
  );

  // ---- 2. failure envelopes ----------------------------------------------
  const fail = (message: string) =>
    output.errorEnvelope("test", new Error(message)) as Record<string, any>;

  await check("checkpoint_not_found_no_list_files", () => {
    const env = fail(
      "[not_found] Checkpoint 'snap-x' does not exist. Hint: list them with project_snapshot action=list.",
    );
    assert.equal(env.error.code, "not_found");
    assert.equal(env.next_actions, undefined);
    assert.match(env.hint, /project_snapshot/);
  });
  await check("run_id_not_found_no_list_files", () => {
    const env = fail(
      "[not_found] Unknown run_id: abc. Hint: run ids only exist for the session that started them.",
    );
    assert.equal(env.next_actions, undefined);
    assert.doesNotMatch(env.hint, /project_list_files/);
  });
  await check("path_not_found_keeps_list_files", () => {
    const env = fail(
      "[not_found] Path does not exist: a/b.ts. Hint: check with project_list_files.",
    );
    assert.equal(env.next_actions?.[0]?.tool, "project_list_files");
  });
  await check("old_text_not_found_points_to_read_file", () => {
    const env = fail(
      "[old_text_not_found] old_text not found in tools/a.ts. Hint: re-read the file to confirm the exact text.",
    );
    assert.equal(env.error.code, "old_text_not_found");
    assert.equal(env.next_actions?.[0]?.tool, "project_read_file");
    assert.equal(env.next_actions?.[0]?.arguments?.relative_path, "tools/a.ts");
  });
  await check("old_text_ambiguous_points_to_read_file", () => {
    const env = fail(
      "[old_text_ambiguous] old_text matches 3 locations in lib/x.ts. Extend old_text or set replace_all=true.",
    );
    assert.equal(env.next_actions?.[0]?.arguments?.relative_path, "lib/x.ts");
  });
  await check("invalid_regex_hint", () => {
    const env = fail(
      "[invalid_request] Invalid regex: Unterminated character class",
    );
    assert.match(env.hint, /regex=0/);
  });
  await check("venira_error_preserves_code_data_and_actions", () => {
    const action = {
      tool: "project_health",
      arguments: {},
      why: "inspect the backend",
    };
    const env = output.errorEnvelope(
      "test",
      new output.VeniraError("custom_failure", "custom failure", {
        retryable: true,
        data: { details: "kept" },
        next_actions: [action],
      }),
    ) as Record<string, any>;
    assert.equal(env.error.code, "custom_failure");
    assert.equal(env.error.retryable, true);
    assert.deepEqual(env.data, { details: "kept" });
    assert.deepEqual(env.next_actions, [action]);
  });

  // ---- 3. shell success vs failed command --------------------------------
  const shellEnvelope = (exit_code: number | null, running = false) =>
    output.buildEnvelope(
      "shell_run",
      {
        status: "completed",
        result: {
          kind: "shell_run",
          data: {
            run_id: "r1",
            running,
            exit_code,
            stdout: "",
            stderr: "boom",
          },
        },
      },
      { requestId: "t", elapsedMs: 1 },
    ) as Record<string, any>;
  await check("shell_nonzero_exit_hint", () => {
    const env = shellEnvelope(3);
    assert.equal(env.ok, true, "the command ran, so ok stays true");
    assert.equal(env.command_status, "failed");
    assert.match(String(env.hint), /Command failed \(exit_code 3/);
  });
  await check("shell_zero_exit_no_failure_hint", () =>
    assert.doesNotMatch(String(shellEnvelope(0).hint ?? ""), /Command failed/),
  );
  await check("shell_timeout_and_cancel_statuses", () => {
    const timedOut = output.buildEnvelope("shell_run", {
      status: "completed",
      result: {
        kind: "shell_run",
        data: { running: false, exit_code: -1, timed_out: true },
      },
    }) as Record<string, any>;
    const cancelled = output.buildEnvelope("shell_run", {
      status: "completed",
      result: {
        kind: "shell_run",
        data: { running: false, exit_code: -1, cancelled: true },
      },
    }) as Record<string, any>;
    assert.equal(timedOut.command_status, "failed");
    assert.match(timedOut.hint, /timed out/);
    assert.equal(cancelled.command_status, "cancelled");
    assert.match(cancelled.hint, /cancelled/);
  });

  // ---- 3b. Full and compact output ---------------------------------------
  await check("compact_mode_only_marks_real_trimming", () => {
    const env = output.buildEnvelope("file_info", {
      status: "completed",
      result: {
        kind: "file_info",
        data: { relative_path: "a.ts", kind: "file" },
      },
    }) as Record<string, any>;
    assert.equal(env.trimmed, undefined);
    assert.equal(env.truncated, undefined);
  });
  await check("large_known_and_unknown_payloads_follow_output_mode", () => {
    const hits = Array.from({ length: 300 }, (_, index) => ({
      relative_path: `src/${index}.ts`,
      line_number: index + 1,
      snippet: `match ${index}`,
    }));
    const searchData = { hits, complete: true, diagnostics: [] };
    const searchEnv = output.buildEnvelope("search", {
      status: "completed",
      result: { kind: "search", data: searchData },
    }) as Record<string, any>;
    const unknownData = { provider: "ci", output: "long output ".repeat(3000) };
    const unknownEnv = output.buildEnvelope("ci_logs", {
      status: "completed",
      result: { kind: "ci_logs", data: unknownData },
    }) as Record<string, any>;

    if (modeArg === "compact") {
      assert.equal(searchEnv.trimmed, true);
      assert.equal(searchEnv.truncated, true);
      assert.equal(searchEnv.data.matches_preview.length, 20);
      assert.equal(searchEnv.data.matches_omitted, 280);
      assert.equal(unknownEnv.trimmed, true);
      assert.equal(unknownEnv.data.preview_truncated, true);
      assert.ok(
        JSON.stringify(unknownEnv).length < JSON.stringify(unknownData).length,
      );
    } else {
      assert.equal(searchEnv.trimmed, undefined);
      assert.deepEqual(searchEnv.data, searchData);
      assert.equal(unknownEnv.trimmed, undefined);
      assert.deepEqual(unknownEnv.data, unknownData);
    }
  });
  await check("compact_file_read_preserves_utf8_and_line_resume", () => {
    const text = `${Array.from({ length: 12000 }, (_, index) => `dòng🙂-${index}`).join("\n")}\n`;
    const env = output.buildEnvelope("read_file", {
      status: "completed",
      result: {
        kind: "file_read",
        data: {
          relative_path: "unicode.txt",
          first_line: 1,
          last_line: 12000,
          total_bytes: Buffer.byteLength(text),
          text,
        },
      },
    }) as Record<string, any>;
    if (modeArg === "compact") {
      assert.equal(env.trimmed, true);
      assert.equal(env.data.preview_truncated, true);
      assert.ok(Buffer.byteLength(env.data.preview, "utf8") <= 32 * 1024);
      assert.equal(env.data.next_start_line, env.data.last_line + 1);
      assert.equal(env.summary.next_start_line, env.data.next_start_line);
      assert.match(env.hint, /Next chunk/);
    } else {
      assert.equal(env.trimmed, undefined);
      assert.equal(env.data.text, text);
    }
  });
  await check("compact_single_long_line_does_not_skip_unread_content", () => {
    const text = "🙂".repeat(10000);
    const env = output.buildEnvelope("read_file", {
      status: "completed",
      result: {
        kind: "file_read",
        data: {
          relative_path: "long-line.txt",
          first_line: 4,
          last_line: 4,
          total_bytes: Buffer.byteLength(text),
          text,
        },
      },
    }) as Record<string, any>;
    if (modeArg === "compact") {
      assert.equal(env.data.next_start_line, undefined);
      assert.match(env.hint, /line exceeds the compact preview/);
    } else {
      assert.equal(env.data.text, text);
    }
  });
  await check("compact_error_message_is_explicit_when_trimmed", () => {
    const env = output.errorEnvelope(
      "test",
      new Error(`[internal] ${"detail ".repeat(3000)}`),
    ) as Record<string, any>;
    if (modeArg === "compact") {
      assert.equal(env.ok, false);
      assert.equal(env.status, "failed");
      assert.equal(env.trimmed, true);
      assert.match(env.error.message, /\[message trimmed\]$/);
      assert.match(env.hint, /VENIRA_OUTPUT_MODE=full/);
    } else {
      assert.equal(env.trimmed, undefined);
      assert.ok(env.error.message.length > 8 * 1024);
    }
  });
  await check("compact_error_data_is_previewed_without_losing_failure", () => {
    const data = { details: "x".repeat(12_000) };
    const env = output.errorEnvelope(
      "test",
      new output.VeniraError("custom_failure", "failed", { data }),
    ) as Record<string, any>;
    assert.equal(env.ok, false);
    if (modeArg === "compact") {
      assert.equal(env.trimmed, true);
      assert.equal(env.data.preview_truncated, true);
      assert.equal(
        env.summary.error_data.serialized_bytes,
        Buffer.byteLength(JSON.stringify(data)),
      );
    } else {
      assert.equal(env.data.details.length, 12_000);
    }
  });

  // ---- 4. edit_batch top-level reporting ---------------------------------
  type Call = { op: string; args: Record<string, unknown> };
  function makeDeps(opts: {
    snapshot: boolean;
    restoreFails?: boolean;
    restorePartial?: boolean;
    snapshotIncomplete?: boolean;
  }) {
    const calls: Call[] = [];
    const ok = (kind: string, data: unknown) => ({
      response: { status: "completed", result: { kind, data } },
      cached: false,
    });
    const deps = {
      maxBatchResponseBytes: 1_000_000,
      execute: async (op: string, args: Record<string, unknown>) => {
        calls.push({ op, args });
        if (op === "snapshot_create") {
          if (!opts.snapshot)
            throw new Error("[internal] snapshot unavailable");
          return ok("snapshot_create", {
            id: "snap-test",
            ...(opts.snapshotIncomplete
              ? { file_count: 2, truncated: true, skipped: [{ path: "b.ts" }] }
              : opts.restorePartial
                ? { file_count: 2 }
                : {}),
          });
        }
        if (op === "snapshot_restore") {
          if (opts.restoreFails) throw new Error("[io_error] restore failed");
          if (opts.restorePartial)
            return ok("snapshot_restore", {
              restored_count: 1,
              skipped: [{ path: "b.ts", reason: "blob_missing" }],
            });
          return ok("snapshot_restore", {});
        }
        if (op === "edit_file") {
          if (args.old_text === "BAD")
            throw new Error(
              "[old_text_not_found] old_text not found in a.ts. Hint: re-read.",
            );
          return ok("file_written", {
            relative_path: args.relative_path,
            replacements: 1,
            sha256_after: "x",
          });
        }
        throw new Error(`unexpected op ${op}`);
      },
    };
    return {
      deps: deps as unknown as Parameters<typeof batch.runEditBatch>[1],
      calls,
    };
  }
  const edits = (second: string) => ({
    edits: [
      { relative_path: "a.ts", old_text: "one", new_text: "1" },
      { relative_path: "a.ts", old_text: second, new_text: "2" },
    ],
  });
  const parse = (r: { content: { text: string }[]; isError?: boolean }) =>
    JSON.parse(r.content[0].text) as Record<string, any>;

  await check("edit_batch_success", async () => {
    const { deps } = makeDeps({ snapshot: true });
    const r = await batch.runEditBatch(edits("two"), deps);
    const env = parse(r);
    assert.equal(r.isError, undefined);
    assert.equal(env.ok, true);
    assert.equal(env.kind, "edit_batch");
    assert.equal(env.data.atomic, true);
  });
  await check("edit_batch_failure_rolled_back", async () => {
    const { deps, calls } = makeDeps({ snapshot: true });
    const r = await batch.runEditBatch(edits("BAD"), deps);
    const env = parse(r);
    assert.equal(r.isError, true);
    assert.equal(env.ok, false);
    assert.equal(env.status, "failed");
    assert.equal(env.kind, "edit_batch");
    assert.equal(env.error.code, "batch_failed");
    assert.equal(env.data.failed_index, 1);
    assert.equal(env.data.rollback_succeeded, true);
    assert.match(env.error.message, /Nothing changed/);
    assert.ok(
      calls.some(
        (c) => c.op === "snapshot_restore" && c.args.id === "snap-test",
      ),
    );
  });
  await check("edit_batch_failure_rollback_failed_says_so", async () => {
    const { deps } = makeDeps({ snapshot: true, restoreFails: true });
    const env = parse(await batch.runEditBatch(edits("BAD"), deps));
    assert.equal(env.ok, false);
    assert.equal(env.data.rollback_attempted, true);
    assert.equal(env.data.rollback_succeeded, false);
    assert.match(env.data.rollback_error, /restore failed/);
    assert.match(env.error.message, /rollback FAILED/);
    assert.match(env.hint, /project_snapshot action=restore id=snap-test/);
  });
  await check(
    "edit_batch_does_not_claim_partial_restore_succeeded",
    async () => {
      const { deps } = makeDeps({ snapshot: true, restorePartial: true });
      const env = parse(await batch.runEditBatch(edits("BAD"), deps));
      assert.equal(env.data.rollback_attempted, true);
      assert.equal(env.data.rollback_succeeded, false);
      assert.match(env.data.rollback_error, /skipped=1/);
      assert.match(env.error.message, /rollback FAILED/);
    },
  );
  await check(
    "edit_batch_does_not_claim_incomplete_snapshot_atomic",
    async () => {
      const { deps } = makeDeps({ snapshot: true, snapshotIncomplete: true });
      const env = parse(await batch.runEditBatch(edits("BAD"), deps));
      assert.equal(env.data.atomic, false);
      assert.equal(env.data.rollback_succeeded, false);
      assert.match(env.data.snapshot_error, /incomplete/);
    },
  );
  await check("edit_batch_failure_without_snapshot_is_not_atomic", async () => {
    const { deps, calls } = makeDeps({ snapshot: false });
    const env = parse(await batch.runEditBatch(edits("BAD"), deps));
    assert.equal(env.ok, false);
    assert.equal(env.data.atomic, false);
    assert.equal(env.data.rollback_attempted, false);
    assert.match(
      env.error.message,
      /rollback was not verified.*files may still contain edits/,
    );
    assert.match(env.data.snapshot_error, /snapshot unavailable/);
    assert.ok(!calls.some((c) => c.op === "snapshot_restore"));
  });

  await check(
    "edit_batch_response_limits_rollback_completed_edits",
    async () => {
      async function runWithLimits(
        maxItemBytes: number,
        maxBatchResponseBytes: number,
      ) {
        const calls: string[] = [];
        const deps = {
          maxBatchResponseBytes,
          execute: async (op: string) => {
            calls.push(op);
            if (op === "snapshot_create") {
              return {
                response: { result: { data: { id: "snap-limits" } } },
                cached: false,
              };
            }
            if (op === "snapshot_restore") {
              return { response: { result: { data: {} } }, cached: false };
            }
            if (op === "edit_file") {
              return {
                response: {
                  status: "completed",
                  result: {
                    kind: "file_written",
                    data: { payload: "x".repeat(9000) },
                  },
                },
                cached: false,
              };
            }
            throw new Error(`unexpected op ${op}`);
          },
        } as unknown as Parameters<typeof batch.runEditBatch>[1];
        const env = parse(
          await batch.runEditBatch(
            { ...edits("two"), max_response_bytes_per_item: maxItemBytes },
            deps,
          ),
        );
        return { env, calls };
      }

      for (const [label, result] of [
        ["item", await runWithLimits(300, 1_000_000)],
        ["batch", await runWithLimits(1_000_000, 300)],
      ] as const) {
        assert.equal(
          result.env.ok,
          false,
          `${label} limit must fail the batch`,
        );
        assert.equal(
          result.env.data.rollback_succeeded,
          true,
          `${label} limit must roll back`,
        );
        assert.deepEqual(result.env.data.executed, [0]);
        assert.deepEqual(result.env.data.skipped, [1]);
        assert.equal(result.calls.filter((op) => op === "edit_file").length, 1);
        assert.equal(
          result.calls.filter((op) => op === "snapshot_restore").length,
          1,
        );
      }
    },
  );

  await check("read_batch_surfaces_partial_failures_at_top_level", async () => {
    const deps = {
      maxBatchResponseBytes: 1_000_000,
      execute: async (op: string, args: Record<string, unknown>) => {
        if (args.relative_path === "missing.txt")
          throw new Error("[not_found] Path does not exist: missing.txt");
        if (args.relative_path === "large-error.txt")
          throw new output.VeniraError("io_error", "disk error", {
            data: { details: "x".repeat(12_000) },
          });
        return {
          response: {
            status: "completed",
            result: {
              kind: "file_info",
              data: { relative_path: "notes.md", kind: "file" },
            },
          },
          cached: false,
        };
      },
    } as unknown as Parameters<typeof batch.runReadBatch>[2];
    const r = await batch.runReadBatch(
      [
        { operation: "read_file", arguments: { relative_path: "missing.txt" } },
        {
          operation: "get_file_info",
          arguments: { relative_path: "notes.md" },
        },
        {
          operation: "read_file",
          arguments: { relative_path: "large-error.txt" },
        },
      ],
      1_000_000,
      deps,
    );
    const env = parse(r);
    assert.equal(r.isError, true);
    assert.equal(env.ok, false);
    assert.equal(env.status, "partial");
    assert.equal(env.error.code, "batch_partial_failure");
    assert.equal(env.data.failed_count, 2);
    assert.equal(env.data.responses[0].ok, false);
    assert.equal(
      env.data.responses[0].next_actions[0].tool,
      "project_list_files",
    );
    if (modeArg === "compact") {
      assert.equal(env.data.responses[2].trimmed, true);
      assert.equal(env.data.responses[2].data.preview_truncated, true);
    } else {
      assert.equal(env.data.responses[2].data.details.length, 12_000);
    }
  });

  await check(
    "create_backend_failures_return_structured_envelopes",
    async () => {
      const { runCreate } = operations.createOperationRunners({
        executeCached: async () => {
          throw new Error("[io_error] disk unavailable");
        },
      });
      const r = await runCreate({
        kind: "file",
        relative_path: "a.ts",
        content: "x",
      });
      const env = parse(r);
      assert.equal(r.isError, true);
      assert.equal(env.ok, false);
      assert.equal(env.status, "failed");
      assert.equal(env.kind, "create");
      assert.equal(env.error.code, "io_error");
    },
  );

  // ---- 5. every error code the code base can throw ends with a hint ------
  await check("every_thrown_error_code_has_a_hint", async () => {
    const { readdir, readFile } = await import("node:fs/promises");
    const codes = new Map<string, string>();
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(path.join(repoRoot, dir), {
        withFileTypes: true,
      })) {
        const rel = `${dir}/${entry.name}`;
        if (entry.isDirectory()) await walk(rel);
        else if (entry.name.endsWith(".ts")) {
          const src = await readFile(path.join(repoRoot, rel), "utf8");
          const patterns = [
            /new Error\(\s*[`"']\[([a-z][a-z0-9_]+)\]/g,
            /new VeniraError\(\s*[`"']([a-z][a-z0-9_]+)[`"']/g,
          ];
          for (const re of patterns)
            for (const m of src.matchAll(re)) codes.set(m[1], rel);
        }
      }
    };
    await walk("lib");
    await walk("tools");
    assert.ok(codes.size > 10, "the scan should find the thrown codes");
    const missing: string[] = [];
    for (const [code, file] of codes) {
      const env = output.errorEnvelope(
        "test",
        new Error(`[${code}] something went wrong`),
      ) as Record<string, any>;
      if (typeof env.hint !== "string" || env.hint.trim() === "")
        missing.push(`${code} (${file})`);
    }
    assert.deepEqual(missing, [], `error codes without a hint: ${missing.join(", ")}`);
  });
  await check("unknown_code_still_gets_a_generic_hint", () => {
    const env = fail("[totally_new_code] boom");
    assert.equal(typeof env.hint, "string");
    assert.ok(env.hint.length > 0);
  });
  await check("invalid_request_messages_get_specific_hints", () => {
    const samples: Array<[string, RegExp]> = [
      ["[invalid_request] symbol_name is required.", /symbol_name/],
      ["[invalid_request] queries[] is required.", /pattern/],
      ['[invalid_request] `kind` must be "file" or "directory". Received: "x".', /"directory"/],
      ["[invalid_request] kind=file requires `content` (a UTF-8 string).", /content/],
      ["[invalid_request] action must be create|list|restore|delete|mirror. Received: \"x\".", /project_snapshot/],
      ["[invalid_request] Invalid checkpoint id. Use the id returned.", /action=list/],
      ["[invalid_request] harness must be one of: a, b. Got: x", /project_detect_harnesses/],
      ["[invalid_request] No edits provided. Pass old_text/new_text or edits[].", /edits\[\]/],
      ["[invalid_request] Directory requires recursive=1: lib.", /project_snapshot/],
      ["[invalid_request] `command` must be a non-empty string.", /command/],
      ["[invalid_request] Missing or incorrect kill_key. Each shell process.", /project_shell_run/],
      ["[invalid_request] `secret_env` must be an array of secret names.", /project_secret/],
      ["[invalid_request] Pass exactly one selector: run_id, ref, pr or branch. x", /one selector/],
      ["[invalid_request] Pass either expires_in_days or expires_at, not both.", /expires_in_days/],
      ["[invalid_request] `pending_id` is required for action=poll.", /action=start/],
      ["[invalid_request] `side` must be RIGHT (new code) or LEFT (deleted code), got \"x\".", /RIGHT/],
      ["[invalid_request] `start_line` must be <= `line`.", /start_line/],
      ["[invalid_request] `method` must be merge|squash|rebase (got \"x\").", /squash/],
      ["[invalid_request] `state` must be open|closed|all (got \"x\").", /open, closed or all/],
      ["[invalid_request] `run_id` must be a numeric pipeline id.", /project_ci_status/],
      ["[invalid_request] Too many workflow `inputs` (max 10).", /inputs/],
      ['[invalid_request] `kind` must be "files", "symbols" or "both".', /schema/],
      ["[invalid_request] Seed path is not a file: x.", /project_list_files/],
    ];
    const genericInvalid = fail("[invalid_request] something unmapped").hint;
    for (const [message, expected] of samples) {
      const env = fail(message);
      assert.notEqual(env.hint, genericInvalid, `generic hint for: ${message}`);
      assert.match(env.hint, expected, `wrong hint for: ${message}`);
    }
    assert.match(
      fail("[invalid_request] Invalid regex: Unterminated character class").hint,
      /regex=0/,
    );
    assert.equal(
      fail("[invalid_request] x. Hint: keep this one.").hint,
      "keep this one.",
      "an inline Hint must win over the table",
    );
  });

} finally {
  await rm(tempDir, { recursive: true, force: true });
}
