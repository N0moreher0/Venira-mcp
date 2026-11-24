/**
 * P1 (minimal-mode roadmap): fast background commands must report their
 * output on the first envelope.
 *
 * A background shell_run returns almost immediately. When the child exits
 * within the async wait window, 'exit' fires (running=false, exit_code=0)
 * before 'close' flushed stdio, and the envelope used to carry empty
 * stdout_tail/stderr_tail - while the very same command with background:0
 * always returned full output. This suite pins the fix: whenever the
 * returned envelope says running:false, the tails must already be final.
 *
 * Run with: npm run test:shell-background-tail
 */
import "./clean-env.js"; // must stay first: inherited VENIRA_* env would change behavior
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDir = await mkdtemp(path.join(os.tmpdir(), "venira-shell-bg-tail-"));
const workspaceDir = path.join(tempDir, "workspace");
await mkdir(workspaceDir, { recursive: true });
// A slow job the balanced policy can follow: `npm run` of a workspace script
// whose body passes the safety scan, with a plain file redirect (allowed).
await writeFile(
  path.join(workspaceDir, "package.json"),
  JSON.stringify({
    // SCRIPT_NAME_OK only accepts conventional names (build/test/lint/check...).
    scripts: { test: "node -e \"setTimeout(function(){console.log('slow-done');},4000);\"" },
  }),
);
process.env.VENIRA_WORKSPACE = workspaceDir;
process.env.VENIRA_DATA_DIR = path.join(tempDir, "data");
process.env.VENIRA_SNAPSHOT_DIR = path.join(tempDir, "snapshots");
process.env.VENIRA_SECURITY_PROFILE = "balanced";
process.env.VENIRA_SHELL_CACHE = "0";

const shellModule = (await import(
  pathToFileURL(path.join(repoRoot, "lib", "corehost-shell.ts")).href
)) as typeof import("../lib/corehost-shell.js");

const shell = process.platform === "win32" ? "cmd" : "bash";
const SESSION = "bg-tail-session";

type RunData = {
  run_id: string;
  running: boolean | null;
  exit_code: number | null;
  stdout_tail?: string;
  stderr_tail?: string;
};

const attempt = async (command: string, args: Record<string, unknown> = {}): Promise<RunData> => {
  const response = await shellModule.opShellRun({ command, shell, ...args }, workspaceDir, SESSION);
  return (response.result?.data ?? {}) as RunData;
};

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

await check("a fast background command reports its stdout on the first envelope", async () => {
  // Several consecutive runs: the race showed up on repeated fast calls.
  for (let i = 0; i < 6; i += 1) {
    const data = await attempt("echo bg-tail-marker");
    assert.equal(data.running, false, `run ${i}: the fast command must already be done`);
    assert.equal(data.exit_code, 0, `run ${i}: exit code must be 0`);
    assert.match(
      data.stdout_tail ?? "",
      /bg-tail-marker/,
      `run ${i}: stdout_tail must carry the echo output once running:false`,
    );
  }
});

await check("a fast background failure reports its stderr on the first envelope", async () => {
  const missing = process.platform === "win32" ? "type missing-bg.txt" : "cat missing-bg.txt";
  const data = await attempt(missing);
  assert.equal(data.running, false);
  assert.notEqual(data.exit_code, 0);
  // The message text is locale-dependent (and on Windows it does not name
  // the file), so pin the contract, not the wording: non-empty stderr.
  assert.ok(
    (data.stderr_tail ?? "").length > 0,
    "stderr_tail must carry the error once running:false",
  );
});

await check("a slow background command still returns running:true without waiting", async () => {
  // npm startup + a 4 s sleep: well past the 2 s async wait cap.
  const waitCmd = "npm test > slow-out.txt";
  const started = Date.now();
  const data = await attempt(waitCmd);
  const elapsed = Date.now() - started;
  assert.equal(
    data.running,
    true,
    `the slow command must still be running in the envelope; got ${JSON.stringify(data).slice(0, 500)}`,
  );
  assert.ok(elapsed < 4000, `the async path must return fast, took ${elapsed}ms`);
  // Poll once: by now 'close' has fired and the tail must be readable.
  const status = await shellModule.opShellStatus({ run_id: data.run_id, wait_seconds: 8 });
  const sdata = (status.result?.data ?? {}) as { running: boolean | null; stdout_tail?: string };
  assert.equal(sdata.running, false, "the slow command must finish within the poll wait");
  assert.ok(typeof sdata.stdout_tail === "string", "poll must expose stdout_tail");
});

console.log(`\n${failures.length === 0 ? "PASS" : "FAIL"}: ${checks - failures.length}/${checks} checks`);
if (failures.length > 0) {
  for (const name of failures) console.log(`  failed: ${name}`);
  process.exit(1);
}
