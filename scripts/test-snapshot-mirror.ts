/**
 * Snapshot mirror: optional append-only copy of the checkpoint store (VENIRA_SNAPSHOT_MIRROR_DIR).
 *
 * Pins the promises the mirror makes:
 *   - unconfigured -> nothing changes (no `mirror` field, manual action is a config error);
 *   - unsafe targets are refused (inside/containing the store, inside the workspace, relative, missing root);
 *   - blobs first, then indexes, then project.json; idempotent and additive across checkpoints;
 *   - append-only: deleting a local checkpoint never deletes anything at the mirror;
 *   - bad copies never get their final name; `verify=1` repairs corruption at the mirror;
 *   - a corrupt local blob blocks its index (the mirror never holds an index without its blobs) and the next
 *     run resumes; a time-budget stop is `partial`, not an error;
 *   - config problems after `snapshot_create` are reported in `mirror{}` without failing the checkpoint;
 *   - the mirror is a protected root; a store rebuilt by copying the mirror folder back restores files.
 *
 * Run with: npm run test:snapshot-mirror
 */
import "./clean-env.js"; // must stay first: inherited VENIRA_* env would point the store at the real one
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDir = await mkdtemp(path.join(os.tmpdir(), "venira-snapshot-mirror-"));
const workspaceDir = path.join(tempDir, "workspace");
const rootDir = path.join(tempDir, "store-root");
const mirrorDir = path.join(tempDir, "mirror");
await mkdir(workspaceDir, { recursive: true });
await mkdir(mirrorDir, { recursive: true });
process.env.VENIRA_WORKSPACE = workspaceDir;
process.env.VENIRA_DATA_DIR = path.join(tempDir, "data");
process.env.VENIRA_SNAPSHOT_ROOT = rootDir; // never touch the user's real per-user store

const load = async <T>(rel: string): Promise<T> => (await import(pathToFileURL(path.join(repoRoot, rel)).href)) as T;
const store = await load<typeof import("../lib/snapshot-store.js")>("lib/snapshot-store.ts");
const snapshots = await load<typeof import("../lib/snapshots.js")>("lib/snapshots.ts");
const mirror = await load<typeof import("../lib/snapshot-mirror.js")>("lib/snapshot-mirror.ts");
const paths = await load<typeof import("../lib/snapshot-paths.js")>("lib/snapshot-paths.ts");

let checks = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  await fn();
  checks += 1;
  console.log(`ok ${checks} - ${name}`);
}

type Data = Record<string, unknown>;
const dataOf = (response: { result?: { data?: unknown } }): Data => (response.result?.data ?? {}) as Data;
const sha256 = (value: Buffer | string): string => crypto.createHash("sha256").update(value).digest("hex");
const setMirror = (dir: string | undefined) => {
  if (dir === undefined) delete process.env.VENIRA_SNAPSHOT_MIRROR_DIR;
  else process.env.VENIRA_SNAPSHOT_MIRROR_DIR = dir;
};
const errorMessage = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected a rejection");
};
const throwsWith = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected a throw");
};

const mirrorProject = path.join(mirrorDir, "workspace"); // <mirror>/<store folder name>
const mirrorBlob = (sha: string) => path.join(mirrorProject, "blobs", sha.slice(0, 2), sha);
const mirrorIndex = (id: string) => path.join(mirrorProject, "index", `${id}.json.gz`);

async function walk(dir: string, base = dir): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(abs, base)));
    else out.push(path.relative(base, abs).replace(/\\/g, "/"));
  }
  return out.sort();
}

const create = async (files: string[], label: string): Promise<{ id: string; data: Data }> => {
  const data = dataOf(await snapshots.opSnapshotCreate({ paths: files, label }, workspaceDir));
  return { id: String(data.id), data };
};
const sync = (options: { verify?: boolean; timeoutMs?: number } = {}) => mirror.syncSnapshotMirror(workspaceDir, options);

// ---------------------------------------------------------------------------
// Not configured / unsafe targets
// ---------------------------------------------------------------------------

await writeFile(path.join(workspaceDir, "a.txt"), "alpha-unique-A\n");
await writeFile(path.join(workspaceDir, "b.txt"), "bravo-unique-B\n");

await check("unconfigured_mirror_is_silent_and_manual_action_is_a_config_error", async () => {
  setMirror(undefined);
  assert.equal(mirror.snapshotMirrorConfigured(), false);
  const first = await create(["a.txt"], "no mirror");
  assert.equal("mirror" in first.data, false, "create result is unchanged without a mirror");
  assert.match(await errorMessage(mirror.opSnapshotMirror({}, workspaceDir)), /^\[config_invalid\] VENIRA_SNAPSHOT_MIRROR_DIR is not set/);
  await snapshots.opSnapshotDelete({ id: first.id }, workspaceDir);
});

await check("unsafe_mirror_targets_are_refused", async () => {
  const storeDir = store.snapshotDataDir();
  const inStore = [storeDir, path.join(storeDir, "inner"), rootDir, tempDir];
  for (const target of inStore) {
    setMirror(target);
    assert.match(throwsWith(() => mirror.resolveMirrorTarget(workspaceDir)), /must not equal, contain or sit inside the local checkpoint store/, target);
  }
  setMirror(path.join(workspaceDir, "mirror-inside"));
  assert.match(throwsWith(() => mirror.resolveMirrorTarget(workspaceDir)), /must not sit inside the workspace/);
  setMirror("relative/mirror");
  assert.match(throwsWith(() => mirror.resolveMirrorTarget(workspaceDir)), /^\[config_invalid\] VENIRA_SNAPSHOT_MIRROR_DIR must be an absolute path/);
  setMirror(path.join(tempDir, "no-such-drive"));
  assert.match(await errorMessage(sync()), /^\[config_invalid\] .*does not exist or is not a folder/);
  assert.equal(existsSync(path.join(tempDir, "no-such-drive")), false, "venira never creates the mirror root");
});

await check("mirror_is_a_protected_root_for_file_tools_and_shell", () => {
  setMirror(mirrorDir);
  const roots = paths.snapshotProtectedRoots(process.env.VENIRA_DATA_DIR as string, workspaceDir).map((r) => path.resolve(r));
  assert.ok(roots.includes(path.resolve(mirrorDir)), "mirror dir joins the protected roots");
  assert.ok(roots.includes(path.resolve(store.snapshotDataDir())), "the store stays protected");
});

// ---------------------------------------------------------------------------
// Sync behaviour
// ---------------------------------------------------------------------------

setMirror(mirrorDir);
const first = await create(["a.txt", "b.txt"], "first");
const idA = first.id;
const manifestA = await store.readManifest(idA);
const shaOldA = sha256("alpha-unique-A\n");
const shaB = sha256("bravo-unique-B\n");

await check("create_mirrors_blobs_then_indexes_then_project_json", async () => {
  const result = first.data.mirror as Data;
  assert.equal(result.status, "ok");
  assert.equal(result.copied_blobs, 2);
  assert.equal(result.copied_indexes, 1);
  assert.equal(result.failed, undefined);
  const files = await walk(mirrorProject);
  assert.deepEqual(files, [`blobs/${shaOldA.slice(0, 2)}/${shaOldA}`, `blobs/${shaB.slice(0, 2)}/${shaB}`, `index/${idA}.json.gz`, "project.json"].sort());
  for (const file of manifestA.files) {
    assert.equal(sha256(await readFile(mirrorBlob(file.sha256))), file.sha256, "blob content equals its file name");
  }
  assert.ok((await readFile(mirrorIndex(idA))).equals(await readFile(store.indexPath(idA))), "index is a byte copy");
});

await check("a_second_run_is_idempotent", async () => {
  const result = dataOf(await mirror.opSnapshotMirror({}, workspaceDir));
  assert.equal(result.status, "ok");
  assert.equal(result.copied_blobs, 0);
  assert.equal(result.copied_indexes, 0);
  assert.equal(result.bytes, 0);
});

await writeFile(path.join(workspaceDir, "a.txt"), "alpha-v2\n");
const second = await create(["a.txt", "b.txt"], "second");
const idB = second.id;
const shaA2 = sha256("alpha-v2\n");

await check("a_new_checkpoint_copies_only_what_is_new", () => {
  const result = second.data.mirror as Data;
  assert.equal(result.status, "ok");
  assert.equal(result.copied_blobs, 1, "only the changed file's blob");
  assert.equal(result.copied_indexes, 1);
  assert.ok(existsSync(mirrorBlob(shaA2)) && existsSync(mirrorIndex(idB)));
});

await check("the_mirror_is_append_only_when_a_local_checkpoint_is_deleted", async () => {
  await snapshots.opSnapshotDelete({ id: idA }, workspaceDir);
  assert.equal(existsSync(store.indexPath(idA)), false);
  assert.equal(existsSync(store.blobPath(shaOldA)), false, "local gc freed the unreferenced blob");
  const result = dataOf(await mirror.opSnapshotMirror({}, workspaceDir));
  assert.equal(result.status, "ok");
  assert.ok(existsSync(mirrorIndex(idA)), "the deleted checkpoint's index is still at the mirror");
  assert.ok(existsSync(mirrorBlob(shaOldA)), "and so is its blob");
});

await check("missing_mirror_files_are_copied_back_on_a_normal_run", async () => {
  await rm(mirrorBlob(shaA2), { force: true });
  await rm(mirrorIndex(idB), { force: true });
  const result = await sync();
  assert.equal(result.status, "ok");
  assert.equal(result.copied_blobs, 1);
  assert.equal(result.copied_indexes, 1);
  assert.equal(sha256(await readFile(mirrorBlob(shaA2))), shaA2);
});

await check("verify_repairs_corrupt_mirror_files_that_a_normal_run_trusts", async () => {
  await writeFile(mirrorBlob(shaB), "junk");
  await writeFile(mirrorIndex(idB), "junk");
  const trusting = await sync();
  assert.equal(trusting.status, "ok");
  assert.equal(trusting.repaired_blobs, undefined, "existence is trusted without verify");
  assert.equal(await readFile(mirrorBlob(shaB), "utf8"), "junk");
  const verifying = await sync({ verify: true });
  assert.equal(verifying.status, "ok");
  assert.equal(verifying.repaired_blobs, 1);
  assert.equal(verifying.repaired_indexes, 1);
  assert.ok((verifying.verified_blobs ?? 0) >= 1, "intact blobs are counted as verified");
  assert.equal(sha256(await readFile(mirrorBlob(shaB))), shaB);
  assert.ok((await readFile(mirrorIndex(idB))).equals(await readFile(store.indexPath(idB))));
});

await check("a_corrupt_local_blob_blocks_its_index_and_the_next_run_resumes", async () => {
  setMirror(undefined);
  await writeFile(path.join(workspaceDir, "c.txt"), "charlie-unique-C\n");
  const third = await create(["c.txt"], "third (local only)");
  const shaC = sha256("charlie-unique-C\n");
  await writeFile(store.blobPath(shaC), "bit rot");
  setMirror(mirrorDir);
  const blocked = await sync();
  assert.equal(blocked.status, "partial");
  const failed = blocked.failed ?? [];
  assert.ok(failed.some((f) => f.kind === "blob" && f.id === shaC && f.reason === "local_blob_corrupt"), JSON.stringify(failed));
  assert.ok(failed.some((f) => f.kind === "index" && f.id === third.id && f.reason === "blobs_incomplete"), JSON.stringify(failed));
  assert.equal(existsSync(mirrorBlob(shaC)), false, "a bad copy never gets its final name");
  assert.equal(existsSync(mirrorIndex(third.id)), false, "no index without its blobs");
  assert.ok(existsSync(mirrorIndex(idB)), "other checkpoints are not blocked");
  await writeFile(store.blobPath(shaC), "charlie-unique-C\n");
  const resumed = await sync();
  assert.equal(resumed.status, "ok");
  assert.equal(resumed.copied_blobs, 1);
  assert.equal(resumed.copied_indexes, 1);
});

await check("a_time_budget_stop_is_partial_and_the_next_run_resumes", async () => {
  setMirror(undefined);
  await writeFile(path.join(workspaceDir, "d.txt"), "delta-unique-D\n");
  const fourth = await create(["d.txt"], "fourth (local only)");
  setMirror(mirrorDir);
  const stopped = await sync({ timeoutMs: -1 });
  assert.equal(stopped.status, "partial");
  assert.equal(stopped.timed_out, true);
  assert.equal(stopped.copied_blobs, 0);
  assert.equal(stopped.copied_indexes, 0);
  assert.equal(existsSync(mirrorIndex(fourth.id)), false);
  const resumed = await sync();
  assert.equal(resumed.status, "ok");
  assert.equal(resumed.copied_blobs, 1);
  assert.equal(resumed.copied_indexes, 1);
});

await check("a_mirror_folder_owned_by_another_workspace_is_a_conflict", async () => {
  const metaFile = path.join(mirrorProject, "project.json");
  const original = await readFile(metaFile, "utf8");
  await writeFile(metaFile, JSON.stringify({ workspace: path.join(tempDir, "some-other-workspace") }));
  assert.match(await errorMessage(sync()), /^\[mirror_conflict\]/);
  await writeFile(metaFile, original);
  assert.equal((await sync()).status, "ok");
});

await check("unreadable_local_indexes_are_not_mirrored_but_reported", async () => {
  const brokenId = "snap-20990101-000001-brkn";
  await writeFile(store.indexPath(brokenId), "this is not gzip");
  const result = await sync();
  assert.equal(result.status, "ok");
  assert.equal(result.skipped_unreadable, 1);
  assert.equal(existsSync(mirrorIndex(brokenId)), false);
  await rm(store.indexPath(brokenId), { force: true });
});

await check("a_config_problem_after_create_is_reported_without_failing_the_checkpoint", async () => {
  setMirror(path.join(tempDir, "unplugged-drive"));
  const result = await create(["a.txt"], "mirror target missing");
  const report = result.data.mirror as Data;
  assert.equal(report.status, "error");
  assert.match(String(report.error), /^\[config_invalid\] .*does not exist/);
  assert.ok((await store.listManifests()).some((m) => m.id === result.id), "the checkpoint itself was created");
  setMirror(mirrorDir);
});

await check("a_store_rebuilt_from_the_mirror_restores_files_even_for_pruned_checkpoints", async () => {
  const rebuilt = path.join(tempDir, "store-root-2");
  await cp(mirrorProject, path.join(rebuilt, "workspace"), { recursive: true });
  setMirror(undefined);
  process.env.VENIRA_SNAPSHOT_ROOT = rebuilt;
  const ids = (await store.listManifests()).map((m) => m.id);
  assert.ok(ids.includes(idA) && ids.includes(idB), "mirror holds the deleted checkpoint too");
  await rm(path.join(workspaceDir, "a.txt"), { force: true });
  const restored = dataOf(await snapshots.opSnapshotRestore({ id: idA, verify: true }, workspaceDir));
  assert.equal(restored.restored_count, 2);
  assert.equal(await readFile(path.join(workspaceDir, "a.txt"), "utf8"), "alpha-unique-A\n");
  process.env.VENIRA_SNAPSHOT_ROOT = rootDir;
});

await rm(tempDir, { recursive: true, force: true });
console.log(`snapshot-mirror: ${checks} checks passed`);
