/**
 * Roadmap item 15 (P2): validation and field naming.
 *
 *   1. A search, a listing or a read of a path that does not exist used to
 *      answer "ok, nothing found" - indistinguishable from an empty folder.
 *   2. A read past the end of the file answered "ok, text: ''".
 *   3. `total_lines` counted the phantom line after a trailing newline.
 *   4. `scope=file` without a file answered `not_found "No such file: ."`.
 *   5. `outline_symbol` on a non-source file answered "0 symbols", silently.
 *   6. Code-intelligence tools reported absolute paths in `relative_path`.
 *   7. `install_self` dry_run claimed `needs_restart: true` and put its note
 *      in `error`.
 *   8. `truncated` meant three different things.
 *   9. `secret` reported `days_left: 0` for a one-day expiry, a `rotated_at`
 *      for a secret that was never rotated, and the *name* of the env var as
 *      the store; deleting a name that was not stored answered "ok".
 *  10. `edit_file` with several edits did not say which edit failed.
 *  11. `shell_status` claimed to be a `shell_run` and reported two
 *      `elapsed_ms` with different meanings.
 *  12. `dry_run` with the policy off said "allow" without saying that no
 *      check had run.
 *
 * Run with: npm run test:p2-clarity
 */
import "./clean-env.js"; // must stay first: inherited VENIRA_* env would change behavior
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "venira-p2-clarity-"));
const workspace = path.join(tempDir, "workspace");
fs.mkdirSync(workspace, { recursive: true });
process.env.VENIRA_WORKSPACE = workspace;
process.env.VENIRA_DATA_DIR = path.join(tempDir, "data");
process.env.VENIRA_SNAPSHOT_DIR = path.join(tempDir, "snapshots");
// The secret store keeps a lock file next to the store file.
fs.mkdirSync(process.env.VENIRA_DATA_DIR as string, { recursive: true });
process.env.VENIRA_SECURITY_PROFILE = "balanced";
process.env.VENIRA_SHELL_CACHE = "0";

const fileread = (await import("../lib/corehost-fileread.js")) as typeof import("../lib/corehost-fileread.js");
const filewrite = (await import("../lib/corehost-filewrite.js")) as typeof import("../lib/corehost-filewrite.js");
const search = (await import("../lib/corehost-search.js")) as typeof import("../lib/corehost-search.js");
const output = (await import("../lib/output.js")) as typeof import("../lib/output.js");
const secrets = (await import("../lib/secrets.js")) as typeof import("../lib/secrets.js");
const selfInstall = (await import("../lib/self-install.js")) as typeof import("../lib/self-install.js");
const shellModule = (await import("../lib/corehost-shell.js")) as typeof import("../lib/corehost-shell.js");
const shellPolicy = (await import("../lib/shell-policy.js")) as typeof import("../lib/shell-policy.js");

let checks = 0;
const failures: string[] = [];
async function check(name: string, fn: () => Promise<void> | void) {
  checks += 1;
  try {
    await fn();
    console.log(`ok ${checks} - ${name}`);
  } catch (error) {
    console.log(`not ok ${checks} - ${name} (${error instanceof Error ? error.message : String(error)})`);
    failures.push(name);
  }
}

const rejects = async (fn: () => Promise<unknown>): Promise<Error> => {
  try {
    await fn();
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error("the call was expected to fail");
};

// ---------------------------------------------------------------------------
// 1-3. A path that does not exist is an error, not an empty result
// ---------------------------------------------------------------------------
await check("search in a missing path is not_found", async () => {
  const error = await rejects(() => search.opSearch({ query: "x", relative_path: "no-such-dir" }, workspace));
  assert.match(error.message, /^\[not_found\]/);
  assert.match(error.message, /project_list_files/);
});

await check("listing a missing directory is not_found", async () => {
  const error = await rejects(() => fileread.opListFiles({ relative_path: "no-such-dir" }, workspace));
  assert.match(error.message, /^\[not_found\]/);
});

await check("listing a file is invalid_request", async () => {
  fs.writeFileSync(path.join(workspace, "a.txt"), "x\n");
  const error = await rejects(() => fileread.opListFiles({ relative_path: "a.txt" }, workspace));
  assert.match(error.message, /^\[invalid_request\]/);
});

await check("reading past the end of the file is invalid_request", async () => {
  fs.writeFileSync(path.join(workspace, "lines.txt"), "one\ntwo\nthree\n");
  const error = await rejects(() =>
    fileread.opReadFile({ relative_path: "lines.txt", start_line: 99 }, workspace),
  );
  assert.match(error.message, /^\[invalid_request\]/);
  assert.match(error.message, /past the end/);
});

await check("end_line before start_line is invalid_request", async () => {
  const error = await rejects(() =>
    fileread.opReadFile({ relative_path: "lines.txt", start_line: 3, end_line: 1 }, workspace),
  );
  assert.match(error.message, /^\[invalid_request\]/);
});

await check("total_lines does not count the phantom line after a trailing newline", async () => {
  const data = (await fileread.opReadFile({ relative_path: "lines.txt" }, workspace)).result?.data as Record<string, unknown>;
  assert.equal(data.total_lines, 3, "three lines, not four");
  assert.equal(data.last_line, 3);
});

await check("an empty file still answers a read of its first line", async () => {
  fs.writeFileSync(path.join(workspace, "empty.txt"), "");
  const data = (await fileread.opReadFile({ relative_path: "empty.txt" }, workspace)).result?.data as Record<string, unknown>;
  assert.equal(data.text, "");
  assert.equal(data.total_lines, 0);
});

// ---------------------------------------------------------------------------
// 4-6. Code intelligence
// ---------------------------------------------------------------------------
await check("scope=file without a file is invalid_request", async () => {
  const runners = (await import("../tools/project-codeintel-runners.js")) as typeof import("../tools/project-codeintel-runners.js");
  const codeintel = (await import("../tools/project-codeintel.js")) as typeof import("../tools/project-codeintel.js");
  const deps = {
    execute: async () => ({ response: {} as never, cached: false }),
    executeCached: async () => ({ response: {} as never, cached: false }),
    readTextFile: codeintel.readTextFile,
    toHostPath: (p: string | undefined) => path.join(workspace, p ?? "."),
    isProtectedPath: () => false,
    referenceCache: { lookup: () => null, store: () => undefined },
    stableKey: () => "k",
  };
  const run = runners.createCodeIntelRunners(deps as never);
  const result = await run.runSymbolReferences({ symbol_name: "x", scope: "file" });
  const text = JSON.stringify(result);
  assert.match(text, /invalid_request/);
  assert.match(text, /scope=file needs relative_path/);
});

await check("outline_symbol on a non-source file explains the empty result", async () => {
  const codeintel = (await import("../tools/project-codeintel.js")) as typeof import("../tools/project-codeintel.js");
  fs.writeFileSync(path.join(workspace, "notes.txt"), "just some notes\nnothing structured\n");
  const result = await codeintel.runOutlineSymbol({ relative_path: "notes.txt" });
  const text = JSON.stringify(result);
  assert.match(text, /No symbols found/);
});

await check("outline_symbol reports a workspace-relative path", async () => {
  const codeintel = (await import("../tools/project-codeintel.js")) as typeof import("../tools/project-codeintel.js");
  fs.writeFileSync(path.join(workspace, "code.ts"), "export function alpha() {}\n");
  const result = await codeintel.runOutlineSymbol({ relative_path: "code.ts" });
  const text = JSON.stringify(result);
  assert.match(text, /relative_path.{0,8}code\.ts/);
  assert.equal(/[A-Z]:\\\\/.test(text), false, "no absolute path");
});

// ---------------------------------------------------------------------------
// 7. install_self dry run
// ---------------------------------------------------------------------------
await check("a dry run writes nothing and says so", async () => {
  const result = await selfInstall.installSelf({
    harness: "opencode",
    workspace,
    dryRun: true,
  });
  assert.equal(result.dry_run, true);
  assert.equal(result.needs_restart, false, "nothing was written, so no restart is needed");
  assert.equal(result.error, undefined, "the note does not sit in `error`");
  assert.ok(result.note && result.note.includes("DRY RUN"), result.note ?? "");
  assert.ok(
    ["would_merge", "would_create", "already_present"].includes(result.status),
    result.status,
  );
});

// ---------------------------------------------------------------------------
// 8. truncated vs limited vs incomplete
// ---------------------------------------------------------------------------
await check("a limited list says limited, not only truncated", async () => {
  fs.mkdirSync(path.join(workspace, "many"), { recursive: true });
  for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(workspace, "many", `f${i}.txt`), "x\n");
  const data = (await fileread.opListFiles({ relative_path: "many", limit: 2 }, workspace)).result?.data as Record<string, unknown>;
  assert.equal(data.truncated, true);
  assert.equal(data.limited, true);
  const envelope = output.buildEnvelope("list_files", {
    status: "completed",
    result: { kind: "file_list", data },
  }) as Record<string, unknown>;
  assert.equal(envelope.limited, true);
});

await check("a cut file read says incomplete", async () => {
  fs.writeFileSync(path.join(workspace, "big.txt"), "x".repeat(4000) + "\n");
  const data = (await fileread.opReadFile({ relative_path: "big.txt", max_bytes: 100 }, workspace)).result?.data as Record<string, unknown>;
  assert.equal(data.truncated, true);
  assert.equal(data.incomplete, true);
  const envelope = output.buildEnvelope("read_file", {
    status: "completed",
    result: { kind: "file_read", data },
  }) as Record<string, unknown>;
  assert.equal(envelope.incomplete, true);
});

// ---------------------------------------------------------------------------
// 9. Secrets
// ---------------------------------------------------------------------------
await check("a one-day expiry reads as one day left", async () => {
  await secrets.setSecret("DAYS_LEFT_TEST", "value-for-days-left", {
    expiresAt: Date.now() + 24 * 60 * 60 * 1000,
  });
  const meta = secrets.getSecretMeta("DAYS_LEFT_TEST");
  assert.equal(meta?.days_left, 1, `days_left was ${String(meta?.days_left)}`);
});

await check("a fresh secret has no rotation timestamp", async () => {
  const meta = secrets.getSecretMeta("DAYS_LEFT_TEST");
  assert.equal(meta?.rotated_at, null, "a secret that was never rotated has no rotated_at");
});

await check("the store is reported as a path, not as an env var name", async () => {
  const health = secrets.secretsHealth();
  assert.ok((health.store as string).includes(path.sep), `store was ${String(health.store)}`);
});

await check("deleting a name that is not stored is not_found", async () => {
  const error = await rejects(() => secrets.deleteSecret("NOT_STORED_SECRET"));
  assert.match(error.message, /^\[not_found\]/);
});

// ---------------------------------------------------------------------------
// 10. edit_file with several edits
// ---------------------------------------------------------------------------
await check("the failing edit is named and the file is untouched", async () => {
  fs.writeFileSync(path.join(workspace, "multi.txt"), "alpha\nbeta\n");
  const error = await rejects(() =>
    filewrite.opEditFile(
      {
        relative_path: "multi.txt",
        edits: [
          { old_text: "alpha", new_text: "ALPHA" },
          { old_text: "missing", new_text: "X" },
        ],
      },
      workspace,
    ),
  );
  assert.match(error.message, /edit 2 of 2/);
  const data = (error as Error & { data?: Record<string, unknown> }).data;
  assert.equal(data?.edit_index, 1);
  assert.equal(data?.file_unchanged, true);
  assert.equal(fs.readFileSync(path.join(workspace, "multi.txt"), "utf8"), "alpha\nbeta\n");
});

// ---------------------------------------------------------------------------
// 11-12. Shell status and dry run
// ---------------------------------------------------------------------------
await check("shell_status is its own kind and reports the run duration", async () => {
  const response = await shellModule.opShellRun(
    { command: "echo hello", shell: process.platform === "win32" ? "cmd" : "bash", background: 0 },
    workspace,
    "p2-session",
  );
  const runId = (response.result?.data as { run_id?: string }).run_id ?? "";
  const status = await shellModule.opShellStatus({ run_id: runId });
  assert.equal(status.result?.kind, "shell_status");
  const data = status.result?.data as Record<string, unknown>;
  assert.equal(typeof data.run_elapsed_ms, "number");
  assert.equal(data.elapsed_ms, undefined, "the envelope carries the call duration");
});

await check("a dry run with the policy off shows what balanced would decide", async () => {
  const savedMode = process.env.VENIRA_SHELL_MODE;
  process.env.VENIRA_SHELL_MODE = "off";
  shellPolicy.resetShellPolicyCache();
  try {
    const response = await shellModule.opShellRun(
      {
        command: process.platform === "win32" ? "rm -rf C:\\" : "rm -rf /",
        shell: process.platform === "win32" ? "cmd" : "bash",
        dry_run: 1,
        background: 0,
      },
      workspace,
      "p2-dry-session",
    );
    const data = response.result?.data as Record<string, unknown>;
    assert.equal(data.policy_mode, "off");
    assert.ok(data.bypassed_verdict, "the balanced verdict is reported next to the bypass");
    const verdict = data.bypassed_verdict as { tier: string };
    assert.equal(verdict.tier, "deny", "the balanced policy would deny it");
  } finally {
    if (savedMode === undefined) delete process.env.VENIRA_SHELL_MODE;
    else process.env.VENIRA_SHELL_MODE = savedMode;
    shellPolicy.resetShellPolicyCache();
  }
});

// ---------------------------------------------------------------------------
// 10b. The three traps of a failed edit (roadmap item 15, P2)
// ---------------------------------------------------------------------------
await check("a failed edit hands back a copy-pasteable snippet (no line numbers)", async () => {
  const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
  fs.writeFileSync(path.join(workspace, "trap.txt"), `${lines.join("\n")}\n`);
  const error = await rejects(() =>
    filewrite.opEditFile(
      { relative_path: "trap.txt", old_text: "line  20", new_text: "X" },
      workspace,
    ),
  );
  const data = (error as Error & { data?: Record<string, unknown> }).data;
  const snippet = data?.nearest_match as {
    text: string;
    numbered: string;
    header: string;
    indentation: string;
    line_endings: string;
    first_line: number;
    last_line: number;
  };
  assert.ok(snippet, "the error carries the nearest region");
  // Trap 1: the snippet itself has no line-number prefixes.
  assert.equal(/^\s*\d+[|:]/.test(snippet.text), false, `the snippet still has numbers: ${snippet.text.slice(0, 60)}`);
  assert.match(snippet.numbered, /\d+\|/, "the numbered variant is there for orientation");
  assert.match(snippet.header, /^Lines \d+-\d+ of trap\.txt:$/);
  // Trap 3: the snippet has a buffer around the nearest line.
  assert.ok(snippet.first_line < 20 && snippet.last_line > 20, `range ${snippet.first_line}-${snippet.last_line}`);
  assert.ok(snippet.last_line - snippet.first_line >= 10, "at least a ten line buffer");
});

await check("a failed edit reports the indentation and the line endings", async () => {
  fs.writeFileSync(path.join(workspace, "tabs.txt"), "a\n\tindented\n\tmore\n");
  const error = await rejects(() =>
    filewrite.opEditFile({ relative_path: "tabs.txt", old_text: "nope", new_text: "X" }, workspace),
  );
  const data = (error as Error & { data?: Record<string, unknown> }).data;
  const snippet = data?.nearest_match as { indentation: string; line_endings: string };
  assert.equal(snippet.indentation, "tabs", `indentation was ${snippet.indentation}`);
  assert.ok(["LF", "CRLF", "mixed"].includes(snippet.line_endings), snippet.line_endings);

  fs.writeFileSync(path.join(workspace, "spaces.txt"), "a\n    four spaces\n");
  const error2 = await rejects(() =>
    filewrite.opEditFile({ relative_path: "spaces.txt", old_text: "nope", new_text: "X" }, workspace),
  );
  const snippet2 = ((error2 as Error & { data?: Record<string, unknown> }).data?.nearest_match as { indentation: string });
  assert.equal(snippet2.indentation, "4 spaces", `indentation was ${snippet2.indentation}`);
});

await check("the suggested old_text from the snippet actually applies", async () => {
  fs.writeFileSync(path.join(workspace, "apply.txt"), "alpha\nbeta\ngamma\n");
  const error = await rejects(() =>
    filewrite.opEditFile({ relative_path: "apply.txt", old_text: "bta", new_text: "BETA" }, workspace),
  );
  const data = (error as Error & { data?: Record<string, unknown> }).data;
  const snippet = data?.nearest_match as { text: string };
  // Copy the snippet region (the line that was meant) and retry with it.
  const line = snippet.text.split("\n").find((value) => value.includes("beta")) ?? "";
  const retry = await filewrite.opEditFile(
    { relative_path: "apply.txt", old_text: line, new_text: "BETA" },
    workspace,
  );
  assert.equal((retry.result?.data as { replacements?: number }).replacements, 1);
});

if (failures.length > 0) {
  console.error(`\nP2 clarity tests FAILED (${failures.length}/${checks}):`);
  for (const name of failures) console.error(`  - ${name}`);
  process.exitCode = 1;
} else {
  console.log(`\nP2 clarity tests passed (${checks} checks).`);
}
