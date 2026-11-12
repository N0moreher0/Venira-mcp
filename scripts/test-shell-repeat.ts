/**
 * Roadmap item 17: the repeated-failure guard for shell runs.
 *
 * An agent that runs the same failing command again and again wastes time and
 * hides the real cause. This suite pins the other half of that bargain:
 *
 *   1. The identical invocation is not run twice - the second call fails with
 *      `repeated_failure` and carries the previous exit code and stderr tail.
 *   2. The refused command really did not run (its side effect is missing).
 *   3. A changed command, a changed cwd or another session runs normally.
 *   4. `retry_failed=1` is the deliberate way to run the identical command
 *      again, and it really runs.
 *   5. A success clears the memory, so a later failure is a new failure.
 *   6. The store keeps names and hashes only: no command text, no secret value.
 *
 * Run with: npm run test:shell-repeat
 */
import "./clean-env.js"; // must stay first: inherited VENIRA_* env would change behavior
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDir = await mkdtemp(path.join(os.tmpdir(), "venira-shell-repeat-"));
const workspaceDir = path.join(tempDir, "workspace");
await mkdir(workspaceDir, { recursive: true });
process.env.VENIRA_WORKSPACE = workspaceDir;
process.env.VENIRA_DATA_DIR = path.join(tempDir, "data");
process.env.VENIRA_SNAPSHOT_DIR = path.join(tempDir, "snapshots");
process.env.VENIRA_SECURITY_PROFILE = "balanced";
// The shell output cache would answer a repeated read-only command with the
// cached result instead of running it again; this suite needs the real runs.
process.env.VENIRA_SHELL_CACHE = "0";

const shellModule = (await import(
  pathToFileURL(path.join(repoRoot, "lib", "corehost-shell.ts")).href
)) as typeof import("../lib/corehost-shell.js");
const repeat = (await import(
  pathToFileURL(path.join(repoRoot, "lib", "shell-repeat.ts")).href
)) as typeof import("../lib/shell-repeat.js");

const shell = process.platform === "win32" ? "cmd" : "bash";
// Reads a file that does not exist: read-only (allowed in balanced), fails with
// a non-zero exit code and (through the redirect) leaves an observable trace.
const readMissing = process.platform === "win32" ? "type missing.txt" : "cat missing.txt";
const failing = `${readMissing} > marker.txt`;
const marker = path.join(workspaceDir, "marker.txt");
const SESSION = "repeat-session";

type RunData = { run_id: string; exit_code: number | null; policy: { rule: string } };
type Attempt =
  | { ok: true; data: RunData }
  | { ok: false; message: string; data: Record<string, unknown> | undefined };

const attempt = async (
  command: string,
  args: Record<string, unknown> = {},
  sessionId = SESSION,
): Promise<Attempt> => {
  try {
    const response = await shellModule.opShellRun(
      { command, shell, background: 0, ...args },
      workspaceDir,
      sessionId,
    );
    return { ok: true, data: (response.result?.data ?? {}) as RunData };
  } catch (error) {
    const err = error as Error & { data?: Record<string, unknown> };
    return { ok: false, message: err.message, data: err.data };
  }
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

const reset = async () => {
  repeat.clearShellRepeats();
  await rm(marker, { force: true });
};

// ---------------------------------------------------------------------------
// The guard
// ---------------------------------------------------------------------------
await check("a failing command runs and reports the exit code", async () => {
  await reset();
  const first = await attempt(failing);
  assert.equal(first.ok, true, "the first run must execute");
  assert.notEqual(first.ok && first.data.exit_code, 0, "the command must fail");
  assert.equal(first.ok && first.data.policy.rule, "balanced.workspace_write");
});

await check("the identical invocation is refused with the previous evidence", async () => {
  await reset();
  const first = await attempt(failing);
  assert.equal(first.ok, true);
  const exitCode = first.ok ? first.data.exit_code : null;
  const second = await attempt(failing);
  assert.equal(second.ok, false, "the repeat must not run");
  assert.match(second.ok ? "" : second.message, /^\[repeated_failure\]/);
  const data = second.ok ? undefined : second.data;
  assert.equal(data?.repeat_detected, true);
  assert.equal(data?.ran, false);
  assert.equal((data?.previous as { exit_code?: number } | undefined)?.exit_code, exitCode);
  assert.equal((data?.previous as { failures?: number } | undefined)?.failures, 1);
  assert.equal(typeof (data?.previous as { stderr_tail?: unknown } | undefined)?.stderr_tail, "string");
});

await check("the refused command did not run again", async () => {
  await reset();
  await attempt(failing);
  await writeFile(marker, "SENTINEL\n", "utf8");
  const second = await attempt(failing);
  assert.equal(second.ok, false);
  assert.equal(await readFile(marker, "utf8"), "SENTINEL\n", "the command must not have run");
});

await check("a changed command runs normally", async () => {
  await reset();
  await attempt(failing);
  const other = `${readMissing.replace("missing.txt", "other.txt")} > other-marker.txt`;
  const second = await attempt(other);
  assert.equal(second.ok, true, "a different command is a different invocation");
});

await check("retry_failed=1 runs the identical command again", async () => {
  await reset();
  await attempt(failing);
  await writeFile(marker, "SENTINEL\n", "utf8");
  const second = await attempt(failing, { retry_failed: 1 });
  assert.equal(second.ok, true, "an explicit retry must run");
  assert.notEqual(second.ok && second.data.exit_code, 0);
  assert.equal(await readFile(marker, "utf8"), "", "the command really ran again");
});

await check("the repeat counter grows with every failure", async () => {
  await reset();
  await attempt(failing);
  await attempt(failing, { retry_failed: 1 });
  const third = await attempt(failing);
  assert.equal(third.ok, false);
  assert.equal((third.ok ? undefined : third.data?.previous as { failures?: number })?.failures, 2);
});

await check("another session is not blocked", async () => {
  await reset();
  await attempt(failing);
  const other = await attempt(failing, {}, "another-session");
  assert.equal(other.ok, true, "the memory is per session");
});

await check("a success clears the memory, so a later failure is a new failure", async () => {
  await reset();
  await attempt(failing); // fails: remembered
  await writeFile(path.join(workspaceDir, "missing.txt"), "now here\n", "utf8");
  // The repeat guard blocks the identical text, so the deliberate retry runs it.
  const success = await attempt(failing, { retry_failed: 1 }); // same text, now succeeds
  assert.equal(success.ok, true);
  assert.equal(success.ok && success.data.exit_code, 0, "the command must succeed now");
  await rm(path.join(workspaceDir, "missing.txt"), { force: true });
  const again = await attempt(failing); // fails again: not blocked, the memory was cleared
  assert.equal(again.ok, true, "a success clears the memory");
  const blocked = await attempt(failing);
  assert.equal(blocked.ok, false, "the new failure is remembered");
  assert.equal(
    (blocked.ok ? undefined : blocked.data?.previous as { failures?: number })?.failures,
    1,
    "the counter starts over after a success",
  );
});

// ---------------------------------------------------------------------------
// The store itself
// ---------------------------------------------------------------------------
await check("the fingerprint covers command, shell, cwd and the inputs", async () => {
  const base = {
    command: "npm test",
    shell: "cmd",
    cwd: "C:\\repo",
    secretNames: [] as string[],
    timeoutMs: 600_000,
    background: false,
  };
  const hash = repeat.fingerprintShellInvocation(base);
  assert.equal(repeat.fingerprintShellInvocation({ ...base }), hash, "stable");
  assert.equal(
    repeat.fingerprintShellInvocation({ ...base, command: "npm test\n" }),
    hash,
    "the outer whitespace and the line endings are normalized",
  );
  assert.notEqual(repeat.fingerprintShellInvocation({ ...base, command: "npm test --watch" }), hash);
  assert.notEqual(repeat.fingerprintShellInvocation({ ...base, shell: "bash" }), hash);
  assert.notEqual(repeat.fingerprintShellInvocation({ ...base, cwd: "C:\\other" }), hash);
  assert.notEqual(repeat.fingerprintShellInvocation({ ...base, timeoutMs: 1 }), hash);
  assert.notEqual(repeat.fingerprintShellInvocation({ ...base, background: true }), hash);
  assert.notEqual(repeat.fingerprintShellInvocation({ ...base, secretNames: ["TOKEN"] }), hash);
  assert.equal(hash.length, 64, "a sha256 hex digest");
});

await check("the store keeps names and hashes only - no command text, no secret value", async () => {
  repeat.clearShellRepeats();
  const fingerprint = repeat.fingerprintShellInvocation({
    command: "deploy --token hunter2",
    shell: "cmd",
    cwd: "C:\\repo",
    secretNames: ["TOKEN"],
    timeoutMs: 1000,
    background: false,
  });
  repeat.recordShellFailure("s1", fingerprint, {
    exit_code: 2,
    timed_out: false,
    stderr_tail: "boom",
    secretNames: ["TOKEN"],
  });
  const record = repeat.findShellRepeat("s1", fingerprint);
  assert.ok(record);
  assert.deepEqual(record?.secret_env, ["TOKEN"]);
  const serialized = JSON.stringify(record);
  assert.equal(serialized.includes("hunter2"), false, "no secret value");
  assert.equal(serialized.includes("deploy"), false, "no command text");
});

await check("a failure outside the window is forgotten", async () => {
  repeat.clearShellRepeats();
  const fingerprint = "f".repeat(64);
  repeat.recordShellFailure(
    "s2",
    fingerprint,
    { exit_code: 1, timed_out: false, stderr_tail: "x" },
    Date.now() - repeat.REPEAT_WINDOW_MS - 1000,
  );
  assert.equal(repeat.findShellRepeat("s2", fingerprint), undefined);
});

await check("the store is bounded per session", async () => {
  repeat.clearShellRepeats();
  for (let i = 0; i < repeat.REPEAT_MAX_PER_SESSION + 8; i++) {
    repeat.recordShellFailure("s3", `fingerprint-${i}`, {
      exit_code: 1,
      timed_out: false,
      stderr_tail: "x",
    });
  }
  assert.equal(repeat.shellRepeatStats("s3").tracked, repeat.REPEAT_MAX_PER_SESSION);
  assert.equal(repeat.findShellRepeat("s3", "fingerprint-0"), undefined, "the oldest is evicted");
  repeat.clearShellRepeats("s3");
  assert.equal(repeat.shellRepeatStats("s3").tracked, 0, "one session can be dropped on its own");
});

await check("the remembered stderr tail is bounded", async () => {
  repeat.clearShellRepeats();
  const fingerprint = "g".repeat(64);
  repeat.recordShellFailure("s4", fingerprint, {
    exit_code: 1,
    timed_out: false,
    stderr_tail: "e".repeat(9000),
  });
  const record = repeat.findShellRepeat("s4", fingerprint);
  assert.ok((record?.stderr_tail.length ?? 0) <= repeat.REPEAT_STDERR_LIMIT);
});

if (failures.length > 0) {
  console.error(`\nShell repeat tests FAILED (${failures.length}/${checks}):`);
  for (const name of failures) console.error(`  - ${name}`);
  process.exitCode = 1;
} else {
  console.log(`\nShell repeat tests passed (${checks} checks).`);
}
