/**
 * Safety checkpoint before `git restore` and single-file deletes (lib/restore-checkpoint.ts + opShellRun).
 *
 * balanced.local_dev lets `git restore <file>` and balanced.workspace_delete lets `rm <file>` run
 * unattended; this suite pins the other half of that bargain: the overwritten or deleted bytes are in a
 * checkpoint the agent can restore, and the command does not run when that checkpoint cannot be taken.
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

// ---- balanced.workspace_delete -------------------------------------------------------------------------
const delTargets = (command: string) => checkpoint.deleteTargets(parse(command), workspaceDir, workspaceDir);

await check("deleteTargets: explicit existing files are captured; missing, recursive and cd-relative deletes are not", async () => {
  await writeFile(path.join(workspaceDir, "scratch.txt"), "scratch\n");
  const t = await delTargets("rm scratch.txt");
  assert.deepEqual(t?.paths, ["scratch.txt"]);
  assert.equal(t?.explicitFilesOnly, true);
  assert.equal(await delTargets("rm no-such-file.txt"), null);
  assert.equal(await delTargets("rm -rf lib"), null);
  assert.equal(await delTargets("cd lib && rm b.ts"), null);
  assert.equal(await delTargets("echo rm scratch.txt"), null);
});

await check("rm <file> under balanced.workspace_delete checkpoints first and recovery works", async () => {
  await writeFile(path.join(workspaceDir, "scratch.txt"), "PRECIOUS BYTES\n");
  const data = await run("rm scratch.txt");
  assert.equal(data.exit_code, 0);
  assert.equal(data.policy.rule, "balanced.workspace_delete");
  assert.ok(data.checkpoint?.id, "checkpoint id reported");
  assert.deepEqual(data.checkpoint?.paths, ["scratch.txt"]);
  await assert.rejects(readFile(path.join(workspaceDir, "scratch.txt"), "utf8"), "file must be gone");

  await snapshots.opSnapshotRestore({ id: data.checkpoint.id }, workspaceDir);
  assert.equal(await readFile(path.join(workspaceDir, "scratch.txt"), "utf8"), "PRECIOUS BYTES\n");
});

await check("deleting bytes a checkpoint already holds reuses it; deleting a missing file needs no checkpoint", async () => {
  // The previous test restored the file, so the covering checkpoint still matches byte-for-byte.
  const again = await run("rm scratch.txt");
  assert.equal(again.exit_code, 0);
  assert.equal(again.checkpoint?.reused, true);
  const missing = await run("rm scratch.txt");
  assert.equal(missing.policy.rule, "balanced.workspace_delete");
  assert.equal(missing.checkpoint, undefined);
});

await check("rm <file> does NOT run when its checkpoint cannot be stored", async () => {
  await writeFile(path.join(workspaceDir, "keep.txt"), "KEEP ME\n");
  await writeFile(path.join(workspaceDir, "c-blocker"), "x");
  const savedStoreDir = process.env.VENIRA_SNAPSHOT_DIR;
  process.env.VENIRA_SNAPSHOT_DIR = path.join(workspaceDir, "c-blocker", "store"); // parent is a file: mkdir must fail
  try {
    const outcome = await run("rm keep.txt").then((d) => JSON.stringify(d), (e: Error) => `REJECTED:${e.message}`);
    assert.match(outcome, /^REJECTED:.*checkpoint_failed/, outcome);
    assert.equal(await readFile(path.join(workspaceDir, "keep.txt"), "utf8"), "KEEP ME\n", "file must be untouched");
  } finally {
    process.env.VENIRA_SNAPSHOT_DIR = savedStoreDir;
  }
});

await check("PowerShell -Path:file is seen by the checkpoint exactly like -Path file (no unattended delete without a checkpoint)", async () => {
  await writeFile(path.join(workspaceDir, "colon.txt"), "COLON BYTES\n");
  const psTargets = (command: string) =>
    checkpoint.deleteTargets(policy.parseShellCommand(command, { shell: "powershell" }), workspaceDir, workspaceDir);
  for (const command of ["Remove-Item -Path:colon.txt", "Remove-Item -LiteralPath:colon.txt", "Remove-Item -Force:$true -Path:colon.txt"]) {
    const t = await psTargets(command);
    assert.deepEqual(t?.paths, ["colon.txt"], command);
  }
  assert.equal(await psTargets("Remove-Item -Recurse:$true -Path:colon.txt"), null, "recursive form is not a single-file delete");
  if (shell === "powershell") {
    const data = await run("Remove-Item -Path:colon.txt");
    assert.equal(data.exit_code, 0);
    assert.equal(data.policy.rule, "balanced.workspace_delete");
    assert.deepEqual(data.checkpoint?.paths, ["colon.txt"]);
    await assert.rejects(readFile(path.join(workspaceDir, "colon.txt"), "utf8"), "file must be gone");
    await snapshots.opSnapshotRestore({ id: data.checkpoint!.id }, workspaceDir);
    assert.equal(await readFile(path.join(workspaceDir, "colon.txt"), "utf8"), "COLON BYTES\n");
  }
});

await check("git restore and rm in one command share one checkpoint", async () => {
  await writeFile(path.join(workspaceDir, "a.txt"), "EDITED A\n");
  const data = await run("git restore a.txt; rm keep.txt");
  assert.equal(data.exit_code, 0);
  assert.equal(data.policy.rule, "balanced.workspace_delete");
  assert.deepEqual([...(data.checkpoint?.paths ?? [])].sort(), ["a.txt", "keep.txt"]);
  await snapshots.opSnapshotRestore({ id: data.checkpoint!.id }, workspaceDir);
  assert.equal(await readFile(path.join(workspaceDir, "keep.txt"), "utf8"), "KEEP ME\n");
  assert.equal(await readFile(path.join(workspaceDir, "a.txt"), "utf8"), "EDITED A\n");
});

if (failures.length > 0) {
  console.error(`\nRestore checkpoint tests FAILED (${failures.length}/${checks}):`);
  for (const name of failures) console.error(`  - ${name}`);
  process.exitCode = 1;
} else {
  console.log(`\nRestore checkpoint tests passed (${checks} checks).`);
}
