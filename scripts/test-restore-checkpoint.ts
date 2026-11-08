/**
 * Safety checkpoint before `git restore` (lib/restore-checkpoint.ts + opShellRun).
 *
 * balanced.local_dev lets `git restore <file>` run unattended; this suite pins the other half of that
 * bargain: the overwritten bytes are in a checkpoint the agent can restore, and the command does not
 * run when that checkpoint cannot be taken.
 */
import "./clean-env.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDir = await mkdtemp(path.join(os.tmpdir(), "venira-restore-ckpt-"));
const workspaceDir = path.join(tempDir, "workspace");
await mkdir(path.join(workspaceDir, "lib"), { recursive: true });
process.env.VENIRA_WORKSPACE = workspaceDir;
process.env.VENIRA_DATA_DIR = path.join(tempDir, "data");
// Checkpoints do not live under VENIRA_DATA_DIR (see lib/snapshot-paths.ts): pin the store to the temp dir
// so this suite never writes into the user's real per-user snapshot store.
const snapshotStoreDir = path.join(tempDir, "snapshots");
process.env.VENIRA_SNAPSHOT_DIR = snapshotStoreDir;
process.env.VENIRA_SECURITY_PROFILE = "balanced";

const git = (...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: workspaceDir, stdio: "pipe" });
git("init", "-q");
await writeFile(path.join(workspaceDir, "a.txt"), "committed a\n");
await writeFile(path.join(workspaceDir, "lib", "b.ts"), "committed b\n");
git("add", "-A");
git("commit", "-q", "-m", "init");

const shellModule = (await import(
  pathToFileURL(path.join(repoRoot, "lib", "corehost-shell.ts")).href
)) as typeof import("../lib/corehost-shell.js");
const policy = (await import(
  pathToFileURL(path.join(repoRoot, "lib", "shell-policy.ts")).href
)) as typeof import("../lib/shell-policy.js");
const checkpoint = (await import(
  pathToFileURL(path.join(repoRoot, "lib", "restore-checkpoint.ts")).href
)) as typeof import("../lib/restore-checkpoint.js");
const snapshots = (await import(
  pathToFileURL(path.join(repoRoot, "lib", "snapshots.ts")).href
)) as typeof import("../lib/snapshots.js");

const shell = process.platform === "win32" ? "powershell" : "bash";
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

const parse = (command: string) => policy.parseShellCommand(command, { shell });
const targets = (command: string) => checkpoint.restoreTargets(parse(command), workspaceDir, workspaceDir);
type RunData = { exit_code: number; policy: { rule: string }; checkpoint?: { id: string; paths: string[]; reused: boolean }; checkpoint_error?: string };
const run = async (command: string): Promise<RunData> => {
  const response = await shellModule.opShellRun({ command, shell, background: 0 }, workspaceDir, "test-session");
  return (response.result?.data ?? {}) as RunData;
};

await check("restoreTargets: explicit file is captured as a file", async () => {
  const t = await targets("git restore a.txt");
  assert.deepEqual(t?.paths, ["a.txt"]);
  assert.equal(t?.explicitFilesOnly, true);
});
await check("restoreTargets: staged-only restore overwrites nothing", async () => {
  assert.equal(await targets("git restore --staged a.txt"), null);
});
await check("restoreTargets: --staged --worktree, `.` and directories are captured conservatively", async () => {
  assert.deepEqual((await targets("git restore --staged --worktree a.txt"))?.paths, ["a.txt"]);
  const dot = await targets("git restore .");
  assert.deepEqual(dot?.paths, ["."]);
  assert.equal(dot?.explicitFilesOnly, false);
  assert.deepEqual((await targets("git restore lib"))?.paths, ["lib"]);
});
await check("restoreTargets: globs capture their directory; global git options and cd capture the workspace", async () => {
  assert.deepEqual((await targets("git restore lib/*.ts"))?.paths, ["lib"]);
  assert.deepEqual((await targets("git restore *.txt"))?.paths, ["."]);
  assert.deepEqual((await targets("git -C lib restore b.ts"))?.paths, ["."]);
  assert.deepEqual((await targets("cd lib && git restore b.ts"))?.paths, ["."]);
});
await check("restoreTargets: --source value is not a path; a deleted file needs no capture", async () => {
  assert.deepEqual((await targets("git restore --source HEAD~1 a.txt"))?.paths, ["a.txt"]);
  assert.equal(await targets("git restore gone.txt"), null);
});
await check("restoreTargets: other commands are ignored", async () => {
  assert.equal(await targets("git status"), null);
  assert.equal(await targets("echo restore a.txt"), null);
});

await check("restoring a modified file under balanced.local_dev checkpoints it first and recovery works", async () => {
  await writeFile(path.join(workspaceDir, "a.txt"), "UNCOMMITTED WORK\n");
  const data = await run("git restore a.txt");
  assert.equal(data.exit_code, 0);
  assert.equal(data.policy.rule, "balanced.local_dev");
  assert.ok(data.checkpoint?.id, "checkpoint id reported");
  assert.equal(data.checkpoint?.reused, false);
  assert.equal((await readFile(path.join(workspaceDir, "a.txt"), "utf8")).replace(/\r\n/g, "\n"), "committed a\n"); // git may apply autocrlf

  await snapshots.opSnapshotRestore({ id: data.checkpoint.id }, workspaceDir);
  assert.equal(await readFile(path.join(workspaceDir, "a.txt"), "utf8"), "UNCOMMITTED WORK\n");
});

await check("restoring bytes a checkpoint already holds reuses it instead of consuming a new slot", async () => {
  // The previous test left the working tree at the checkpointed UNCOMMITTED WORK content.
  const first = await run("git restore a.txt");
  assert.equal(first.exit_code, 0);
  assert.equal(first.checkpoint?.reused, true);
  await writeFile(path.join(workspaceDir, "a.txt"), "UNCOMMITTED WORK\n");
  const second = await run("git restore a.txt");
  assert.equal(second.checkpoint?.reused, true);
  await writeFile(path.join(workspaceDir, "a.txt"), "DIFFERENT WORK\n");
  const third = await run("git restore a.txt");
  assert.equal(third.checkpoint?.reused, false, "new bytes get a new checkpoint");
});

await check("a staged-only restore runs without a checkpoint", async () => {
  const data = await run("git restore --staged a.txt");
  assert.equal(data.exit_code, 0);
  assert.equal(data.checkpoint, undefined);
});

await check("balanced.local_dev restore does NOT run when its checkpoint cannot be stored", async () => {
  await writeFile(path.join(workspaceDir, "b-blocker"), "x");
  const savedStoreDir = process.env.VENIRA_SNAPSHOT_DIR;
  process.env.VENIRA_SNAPSHOT_DIR = path.join(workspaceDir, "b-blocker", "store"); // parent is a file: mkdir must fail
  await writeFile(path.join(workspaceDir, "lib", "b.ts"), "MODIFIED B\n");
  try {
    const outcome = await run("git restore lib/b.ts").then((d) => JSON.stringify(d), (e: Error) => `REJECTED:${e.message}`);
    assert.match(outcome, /^REJECTED:.*checkpoint_failed/, outcome);
    assert.equal(await readFile(path.join(workspaceDir, "lib", "b.ts"), "utf8"), "MODIFIED B\n", "file must be untouched");
  } finally {
    process.env.VENIRA_SNAPSHOT_DIR = savedStoreDir;
  }
});

if (failures.length > 0) {
  console.error(`\nRestore checkpoint tests FAILED (${failures.length}/${checks}):`);
  for (const name of failures) console.error(`  - ${name}`);
  process.exitCode = 1;
} else {
  console.log(`\nRestore checkpoint tests passed (${checks} checks).`);
}
