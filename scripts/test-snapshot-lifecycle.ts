/**
 * Snapshot store lifecycle: manifest versioning/migration and blob-gc safety.
 *
 * Pins two promises that matter once the checkpoint layout changes or a store is shared between venira-mcp
 * versions:
 *   1. A manifest this build cannot read is reported (`snapshot_version_unsupported` for a newer/unmigratable
 *      layout, `snapshot_unsafe_path` for a file path that leaves the workspace, `snapshot_corrupt` for broken
 *      bytes) instead of silently disappearing from the list.
 *   2. Blob gc never runs while such a manifest exists, because that manifest still owns blobs we cannot
 *      enumerate; deleting "unreferenced" blobs would destroy its data.
 *
 * Run with: npm run test:snapshot-lifecycle
 */
import "./clean-env.js"; // must stay first: inherited VENIRA_* env would point the store at the real one
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDir = await mkdtemp(path.join(os.tmpdir(), "venira-snapshot-lifecycle-"));
const workspaceDir = path.join(tempDir, "workspace");
const storeDir = path.join(tempDir, "snapshots");
await mkdir(workspaceDir, { recursive: true });
process.env.VENIRA_WORKSPACE = workspaceDir;
process.env.VENIRA_DATA_DIR = path.join(tempDir, "data");
process.env.VENIRA_SNAPSHOT_DIR = storeDir; // never touch the user's real per-user store

const store = (await import(
  pathToFileURL(path.join(repoRoot, "lib", "snapshot-store.ts")).href
)) as typeof import("../lib/snapshot-store.js");
const snapshots = (await import(
  pathToFileURL(path.join(repoRoot, "lib", "snapshots.ts")).href
)) as typeof import("../lib/snapshots.js");

let checks = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  await fn();
  checks += 1;
  console.log(`ok ${checks} - ${name}`);
}

type Data = Record<string, unknown>;
const dataOf = (response: { result?: { data?: unknown } }): Data => (response.result?.data ?? {}) as Data;

const FUTURE_ID = "snap-20990101-000000-futr";
const BROKEN_ID = "snap-20990101-000001-brkn";

async function writeIndex(id: string, bytes: Buffer): Promise<void> {
  await mkdir(path.join(storeDir, "index"), { recursive: true });
  await writeFile(store.indexPath(id), bytes);
}
const writeManifestJson = (id: string, body: unknown) => writeIndex(id, gzipSync(Buffer.from(JSON.stringify(body), "utf8")));
const dropIndex = (id: string) => rm(store.indexPath(id), { force: true });

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

// ---------------------------------------------------------------------------
// migrateManifest (pure)
// ---------------------------------------------------------------------------

const base = { id: "snap-20260101-000000-abcd", workspace: "/w", created_at: 1, roots: [], files: [], dirs: [] };

await check("current_version_manifest_passes_through_unchanged", () => {
  const input = { ...base, version: store.MANIFEST_VERSION, marker: "x" };
  const out = store.migrateManifest(input);
  assert.equal(out.version, store.MANIFEST_VERSION);
  assert.equal(out.marker, "x");
});

await check("migration_chain_upgrades_one_version_at_a_time", () => {
  const calls: number[] = [];
  const out = store.migrateManifest(
    { ...base, version: 1 },
    {
      target: 3,
      migrations: {
        1: (m) => { calls.push(1); return { ...m, version: 2, skipped: [] }; },
        2: (m) => { calls.push(2); return { ...m, version: 3, truncated: false }; },
      },
    },
  );
  assert.deepEqual(calls, [1, 2]);
  assert.equal(out.version, 3);
  assert.deepEqual(out.skipped, []);
  assert.equal(out.truncated, false);
});

await check("migration_does_not_mutate_the_input_object", () => {
  const input = { ...base, version: 1 };
  store.migrateManifest(input, { target: 2, migrations: { 1: (m) => { m.touched = true; return { ...m, version: 2 }; } } });
  assert.equal(input.version, 1);
  assert.equal("touched" in input, false);
});

await check("newer_version_is_unsupported_not_corrupt", () => {
  const message = throwsWith(() => store.migrateManifest({ ...base, version: store.MANIFEST_VERSION + 1 }));
  assert.match(message, /^\[snapshot_version_unsupported\]/);
  assert.match(message, /upgrade venira-mcp/i);
  assert.match(message, /untouched/);
});

await check("older_version_without_a_migration_step_is_unsupported", () => {
  const message = throwsWith(() => store.migrateManifest({ ...base, version: 1 }, { target: 3, migrations: { 2: (m) => ({ ...m, version: 3 }) } }));
  assert.match(message, /^\[snapshot_version_unsupported\]/);
  assert.match(message, /no migration/);
});

await check("missing_or_invalid_version_is_corrupt", () => {
  for (const version of [undefined, 0, -1, 1.5, "1", null, Number.NaN]) {
    assert.match(throwsWith(() => store.migrateManifest({ ...base, version })), /^\[snapshot_corrupt\]/, `version=${String(version)}`);
  }
  for (const value of [null, undefined, "text", 5, []]) {
    assert.match(throwsWith(() => store.migrateManifest(value)), /^\[snapshot_corrupt\]/, `value=${String(value)}`);
  }
});

await check("a_migration_that_does_not_advance_the_version_is_corrupt", () => {
  const message = throwsWith(() => store.migrateManifest({ ...base, version: 1 }, { target: 2, migrations: { 1: (m) => ({ ...m }) } }));
  assert.match(message, /^\[snapshot_corrupt\]/);
});

// ---------------------------------------------------------------------------
// Real store
// ---------------------------------------------------------------------------

await writeFile(path.join(workspaceDir, "a.txt"), "alpha-unique-A\n");
await writeFile(path.join(workspaceDir, "b.txt"), "bravo-unique-B\n");
const idA = String(dataOf(await snapshots.opSnapshotCreate({ paths: ["a.txt"], label: "A" }, workspaceDir)).id);
const idB = String(dataOf(await snapshots.opSnapshotCreate({ paths: ["b.txt"], label: "B" }, workspaceDir)).id);
const manifestA = await store.readManifest(idA);
const manifestB = await store.readManifest(idB);
const shaA = manifestA.files[0].sha256;
const shaB = manifestB.files[0].sha256;

await check("a_fresh_store_has_no_unreadable_manifests", async () => {
  const listing = await store.listManifestsDetailed();
  assert.deepEqual(listing.unreadable, []);
  assert.deepEqual(listing.manifests.map((m) => m.id).sort(), [idA, idB].sort());
  assert.equal(manifestA.version, store.MANIFEST_VERSION);
});

// A copy of a real manifest written by a "newer" venira-mcp: it still owns blob A.
await writeManifestJson(FUTURE_ID, { ...manifestA, id: FUTURE_ID, version: store.MANIFEST_VERSION + 98 });
await writeIndex(BROKEN_ID, Buffer.from("this is not gzip", "utf8"));

await check("read_manifest_keeps_the_specific_error_code", async () => {
  assert.match(await errorMessage(store.readManifest(FUTURE_ID)), /^\[snapshot_version_unsupported\]/);
  assert.match(await errorMessage(store.readManifest(BROKEN_ID)), /^\[snapshot_corrupt\] Cannot read checkpoint/);
  assert.match(await errorMessage(store.readManifest("snap-20990101-000002-none")), /^\[not_found\]/);
});

await check("list_detailed_reports_unreadable_without_hiding_readable_ones", async () => {
  const listing = await store.listManifestsDetailed();
  assert.deepEqual(listing.manifests.map((m) => m.id).sort(), [idA, idB].sort());
  assert.deepEqual(
    listing.unreadable.map((u) => [u.id, u.code]),
    [[FUTURE_ID, "snapshot_version_unsupported"], [BROKEN_ID, "snapshot_corrupt"]].sort((x, y) => x[0].localeCompare(y[0])),
  );
  assert.deepEqual((await store.listManifests()).map((m) => m.id).sort(), [idA, idB].sort(), "listManifests keeps its old contract");
});

await check("snapshot_list_and_health_surface_unreadable_checkpoints", async () => {
  const list = dataOf(await snapshots.opSnapshotList({}));
  assert.equal(list.total, 2, "only readable checkpoints are counted");
  const unreadable = list.unreadable as Array<{ id: string; code: string }>;
  assert.equal(unreadable.length, 2);
  assert.ok(unreadable.some((u) => u.id === FUTURE_ID && u.code === "snapshot_version_unsupported"));
  assert.ok(unreadable.some((u) => u.id === BROKEN_ID && u.code === "snapshot_corrupt"));
  assert.match(String(list.hint), /upgrade venira-mcp/);
  const health = await snapshots.snapshotHealth();
  assert.equal(health.checkpoints, 2);
  assert.equal(health.unreadable, 2);
});

await check("gc_is_skipped_and_blobs_survive_while_a_manifest_is_unreadable", async () => {
  const deleted = dataOf(await snapshots.opSnapshotDelete({ id: idA }, workspaceDir));
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.gc_skipped, "unreadable_manifests");
  assert.equal(deleted.unreadable_manifests, 2);
  assert.equal(deleted.blobs_removed, 0);
  assert.ok(existsSync(store.blobPath(shaA)), "blob A is owned by the newer-version manifest and must stay");
  assert.ok(existsSync(store.blobPath(shaB)), "blob B belongs to a readable checkpoint and must stay");
});

await check("retention_after_create_also_leaves_blobs_alone_while_something_is_unreadable", async () => {
  await writeFile(path.join(workspaceDir, "c.txt"), "charlie-unique-C\n");
  const created = dataOf(await snapshots.opSnapshotCreate({ paths: ["c.txt"], label: "C" }, workspaceDir));
  assert.ok(existsSync(store.indexPath(String(created.id))));
  assert.ok(existsSync(store.blobPath(shaA)));
  assert.ok(existsSync(store.indexPath(FUTURE_ID)), "the unreadable index file itself is never removed by us");
  assert.ok(existsSync(store.indexPath(BROKEN_ID)));
  await snapshots.opSnapshotDelete({ id: String(created.id) }, workspaceDir);
});

await check("removed_scope_alias_is_refused_and_captures_nothing", async () => {
  const before = (await store.listManifestsDetailed()).manifests.length;
  await assert.rejects(
    () => snapshots.opSnapshotCreate({ scope: ["c.txt"], label: "scope" }, workspaceDir),
    /scope was removed|\[unsupported\]/,
    "scope is removed: it must never silently narrow (or widen) the capture",
  );
  const after = (await store.listManifestsDetailed()).manifests.length;
  assert.equal(after, before, "a refused call must not create a checkpoint");
  const viaPaths = dataOf(await snapshots.opSnapshotCreate({ paths: ["c.txt"], label: "paths" }, workspaceDir));
  assert.equal(viaPaths.file_count, 1);
  assert.equal(viaPaths.deprecated, undefined, "paths is the only spelling and is not flagged");
  await snapshots.opSnapshotDelete({ id: String(viaPaths.id) }, workspaceDir);
});

const ESCAPE_ID = "snap-20990101-000003-escp";
const OTHER_ID = "snap-20990101-000004-othr";

await check("path_escape_index_shows_its_cause_and_its_own_workspace_can_delete_it", async () => {
  // Same shape as a checkpoint written by an old build that allowed a root outside the workspace.
  await writeManifestJson(ESCAPE_ID, { ...manifestB, id: ESCAPE_ID, files: [{ ...manifestB.files[0], path: "../outside.txt" }] });
  const list = dataOf(await snapshots.opSnapshotList({}));
  const row = (list.unreadable as Array<{ id: string; code: string; message?: string }>).find((u) => u.id === ESCAPE_ID);
  assert.equal(row?.code, "snapshot_unsafe_path", "an escaping path is its own code, not generic corruption");
  assert.match(String(row?.message), /^\[snapshot_unsafe_path\].*outside the workspace.*\.\.\/outside\.txt/, "the list must say why the index is rejected");
  assert.match(String(list.hint), /snapshot_unsafe_path/);
  assert.match(await errorMessage(store.readManifest(ESCAPE_ID)), /^\[snapshot_unsafe_path\]/, "readManifest keeps the specific code");
  assert.match(
    await errorMessage(snapshots.opSnapshotRestore({ id: ESCAPE_ID }, workspaceDir)),
    /^\[snapshot_unsafe_path\]/,
    "an unsafe checkpoint is never restored",
  );
  const deleted = dataOf(await snapshots.opSnapshotDelete({ id: ESCAPE_ID }, workspaceDir));
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.was_unreadable, true);
  assert.equal(existsSync(store.indexPath(ESCAPE_ID)), false);
});

await check("an_absolute_path_entry_is_unsafe_and_a_malformed_entry_stays_corrupt", async () => {
  const ABS_ID = "snap-20990101-000005-abs0";
  const BAD_ID = "snap-20990101-000006-bad0";
  await writeManifestJson(ABS_ID, { ...manifestB, id: ABS_ID, files: [{ ...manifestB.files[0], path: path.resolve(tempDir, "abs.txt") }] });
  await writeManifestJson(BAD_ID, { ...manifestB, id: BAD_ID, files: [{ ...manifestB.files[0], sha256: "not-a-hash" }] });
  assert.match(await errorMessage(store.readManifest(ABS_ID)), /^\[snapshot_unsafe_path\]/);
  assert.match(await errorMessage(store.readManifest(BAD_ID)), /^\[snapshot_corrupt\].*invalid file entry/);
  const codes = new Map((await store.listManifestsDetailed()).unreadable.map((u) => [u.id, u.code]));
  assert.equal(codes.get(ABS_ID), "snapshot_unsafe_path");
  assert.equal(codes.get(BAD_ID), "snapshot_corrupt");
  assert.equal(dataOf(await snapshots.opSnapshotDelete({ id: ABS_ID }, workspaceDir)).was_unreadable, true);
  assert.equal(dataOf(await snapshots.opSnapshotDelete({ id: BAD_ID }, workspaceDir)).was_unreadable, true);
  assert.equal(existsSync(store.indexPath(ABS_ID)) || existsSync(store.indexPath(BAD_ID)), false);
});

await check("deleting_an_unreadable_checkpoint_is_refused_unless_ownership_is_shown", async () => {
  await writeManifestJson(OTHER_ID, { ...manifestB, id: OTHER_ID, workspace: path.join(tempDir, "another-workspace"), files: [{ ...manifestB.files[0], path: "../x.txt" }] });
  assert.match(await errorMessage(snapshots.opSnapshotDelete({ id: OTHER_ID }, workspaceDir)), /^\[scope_denied\]/);
  assert.ok(existsSync(store.indexPath(OTHER_ID)), "another workspace's index stays");
  assert.match(await errorMessage(snapshots.opSnapshotDelete({ id: BROKEN_ID }, workspaceDir)), /^\[snapshot_corrupt\].*cannot be parsed/);
  assert.ok(existsSync(store.indexPath(BROKEN_ID)), "unparseable bytes: ownership unknown, nothing is deleted");
  assert.match(await errorMessage(snapshots.opSnapshotDelete({ id: FUTURE_ID }, workspaceDir)), /^\[snapshot_version_unsupported\]/);
  assert.ok(existsSync(store.indexPath(FUTURE_ID)), "a newer build may still read it");
  await dropIndex(OTHER_ID);
});

await check("gc_resumes_and_sweeps_orphans_once_nothing_is_unreadable", async () => {
  await dropIndex(FUTURE_ID);
  await dropIndex(BROKEN_ID);
  assert.deepEqual((await store.listManifestsDetailed()).unreadable, []);
  const deleted = dataOf(await snapshots.opSnapshotDelete({ id: idB }, workspaceDir));
  assert.equal(deleted.gc_skipped, undefined);
  assert.equal(deleted.unreadable_manifests, undefined);
  assert.ok(Number(deleted.blobs_removed) >= 2, "orphan blob A (left behind earlier) and blob B are both swept");
  assert.equal(existsSync(store.blobPath(shaA)), false);
  assert.equal(existsSync(store.blobPath(shaB)), false);
  const health = await snapshots.snapshotHealth();
  assert.equal(health.checkpoints, 0);
  assert.equal(health.unreadable, 0);
});

await rm(tempDir, { recursive: true, force: true });
console.log(`Snapshot lifecycle tests passed (${checks} checks).`);
