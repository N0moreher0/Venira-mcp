/**
 * Protected-path and checkpoint-store path regressions.
 *
 * Covers:
 *   - the data dir and snapshot store are protected from the file tools;
 *   - the protected-root cache invalidates when the store env changes;
 *   - symlink/junction paths resolve into protected roots;
 *   - the cache refreshes after the data dir link is retargeted (TTL);
 *   - snapshot path input cannot escape the workspace;
 *   - checkpoint ids cannot traverse out of the index folder;
 *   - a doctored manifest cannot restore `..`, another workspace, or the store;
 *   - a captured directory replaced by a link is refused on restore;
 *   - the checkpoint store inside a workspace is excluded from captures.
 *
 * Run with: npm run test:protected-snapshot-paths
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "venira-protected-snapshot-"));
const workspaceDir = path.join(tempRoot, "workspace");
const dataRealA = path.join(tempRoot, "data-a");
const dataRealB = path.join(tempRoot, "data-b");
const dataLink = path.join(tempRoot, "data-link");
const snapshotRoot = path.join(tempRoot, "snapshot-root");
const outsideStore = path.join(tempRoot, "store-outside");

for (const dir of [workspaceDir, dataRealA, dataRealB, snapshotRoot, outsideStore]) {
  mkdirSync(dir, { recursive: true });
}

const isWindows = process.platform === "win32";
const makeDirLink = (target: string, link: string) => symlinkSync(target, link, isWindows ? "junction" : "dir");
const removeDirLink = (link: string) => (isWindows ? rmdirSync(link) : unlinkSync(link));

makeDirLink(dataRealA, dataLink);

process.env.VENIRA_WORKSPACE = workspaceDir;
process.env.VENIRA_DATA_DIR = dataLink;
process.env.VENIRA_SNAPSHOT_ROOT = snapshotRoot;
delete process.env.VENIRA_SNAPSHOT_DIR;
delete process.env.VENIRA_UNRESTRICTED;

const workspace = await import(pathToFileURL(path.join(repoRoot, "lib", "workspace.ts")).href);
const snapshotPaths = await import(pathToFileURL(path.join(repoRoot, "lib", "snapshot-paths.ts")).href);
const snapshots = await import(pathToFileURL(path.join(repoRoot, "lib", "snapshots.ts")).href);
const { isProtectedPath } = workspace;
const { opSnapshotCreate, opSnapshotRestore } = snapshots;

let checks = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
  } catch (error) {
    if (error instanceof Error) error.message = `${name}: ${error.message}`;
    throw error;
  }
  checks += 1;
  console.log(`ok ${checks} - ${name}`);
}

function snapshotId(response: { result: { data: { id: string } } }): string {
  return response.result.data.id;
}

function manifestPath(store: string, id: string): string {
  return path.join(store, "index", `${id}.json.gz`);
}

function tamperManifest(store: string, id: string, mutate: (manifest: Record<string, any>) => void): void {
  const file = manifestPath(store, id);
  const manifest = JSON.parse(gunzipSync(readFileSync(file)).toString("utf8"));
  mutate(manifest);
  writeFileSync(file, gzipSync(Buffer.from(JSON.stringify(manifest), "utf8"), { level: 6 }));
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

try {
  await mkdir(path.join(workspaceDir, "src"), { recursive: true });
  await mkdir(path.join(workspaceDir, "docs"), { recursive: true });
  await writeFile(path.join(workspaceDir, "src", "a.txt"), "a\n");
  await writeFile(path.join(workspaceDir, "docs", "b.txt"), "b\n");
  await writeFile(path.join(dataRealA, "venira.db"), "audit\n");
  await writeFile(path.join(dataRealB, "venira.db"), "audit\n");
  await writeFile(path.join(tempRoot, "outside.txt"), "escape\n");

  await check("data dir and snapshot root are protected; workspace files are not", () => {
    assert.equal(isProtectedPath(path.join(dataLink, "venira.db")), true);
    assert.equal(isProtectedPath(path.join(snapshotRoot, "anything.json.gz")), true);
    assert.equal(isProtectedPath(path.join(workspaceDir, "src", "a.txt")), false);
  });

  await check("switching VENIRA_SNAPSHOT_DIR invalidates the protected-root cache", () => {
    const storeA = path.join(tempRoot, "store-a");
    const storeB = path.join(tempRoot, "store-b");
    mkdirSync(storeA, { recursive: true });
    mkdirSync(storeB, { recursive: true });

    process.env.VENIRA_SNAPSHOT_DIR = storeA;
    assert.equal(isProtectedPath(path.join(storeA, "index", "x.json.gz")), true);
    assert.equal(isProtectedPath(path.join(storeB, "index", "x.json.gz")), false);

    process.env.VENIRA_SNAPSHOT_DIR = storeB;
    assert.equal(isProtectedPath(path.join(storeB, "index", "x.json.gz")), true);
    assert.equal(isProtectedPath(path.join(storeA, "index", "x.json.gz")), false);
    delete process.env.VENIRA_SNAPSHOT_DIR;
  });

  await check("a workspace link into the data dir resolves to a protected path", () => {
    const link = path.join(workspaceDir, "data-link");
    makeDirLink(dataRealA, link);
    try {
      assert.equal(isProtectedPath(path.join(link, "secrets.json")), true);
    } finally {
      removeDirLink(link);
    }
  });

  await check("the protected-root cache refreshes after the data dir link is retargeted", async () => {
    removeDirLink(dataLink);
    makeDirLink(dataRealB, dataLink);
    // The cache deliberately keeps a short TTL to bound syscall cost.
    await wait(2300);
    assert.equal(isProtectedPath(path.join(dataRealB, "ordinary.txt")), true);
    assert.equal(isProtectedPath(path.join(dataRealA, "ordinary.txt")), false);
  });

  // Checkpoint behaviour with the store outside the workspace.
  process.env.VENIRA_SNAPSHOT_DIR = outsideStore;

  const capture = await opSnapshotCreate({ paths: ["."] }, workspaceDir);
  const captureId = snapshotId(capture);

  await check("snapshot captures workspace files", () => {
    assert.equal(capture.result.data.file_count, 2, JSON.stringify(capture.result.data.skipped));
    assert.ok(capture.result.data.id.startsWith("snap-"));
  });

  await check("a snapshot path cannot escape the workspace", async () => {
    await assert.rejects(
      () => opSnapshotCreate({ paths: ["../outside.txt"] }, workspaceDir),
      /scope_denied|path_escape/,
    );
  });

  await check("a checkpoint id cannot traverse out of the index folder", async () => {
    await assert.rejects(() => opSnapshotRestore({ id: "../../outside" }, workspaceDir), /invalid_request/);
    await assert.rejects(() => opSnapshotRestore({ id: "snap-../../escape" }, workspaceDir), /invalid_request/);
  });

  await check("a manifest file path with .. is rejected as corrupt", async () => {
    const id = snapshotId(await opSnapshotCreate({ paths: ["."] }, workspaceDir));
    tamperManifest(outsideStore, id, (manifest) => {
      manifest.files[0].path = "../escape.txt";
    });
    await assert.rejects(() => opSnapshotRestore({ id }, workspaceDir), /snapshot_corrupt/);
  });

  await check("a manifest from another workspace is refused", async () => {
    const id = snapshotId(await opSnapshotCreate({ paths: ["."] }, workspaceDir));
    tamperManifest(outsideStore, id, (manifest) => {
      manifest.workspace = path.join(tempRoot, "some-other-workspace");
    });
    await assert.rejects(() => opSnapshotRestore({ id }, workspaceDir), /scope_denied/);
  });

  await check("restore refuses a captured directory replaced by a link", async () => {
    const id = snapshotId(await opSnapshotCreate({ paths: ["docs"] }, workspaceDir));
    const docs = path.join(workspaceDir, "docs");
    const redirect = path.join(workspaceDir, "redirect-docs");
    await mkdir(redirect, { recursive: true });
    await writeFile(path.join(redirect, "b.txt"), "redirect\n");
    await rm(docs, { recursive: true, force: true });
    // Link stays inside the workspace, so resolveWithin succeeds and the
    // symlink-ancestor guard is what blocks the write.
    makeDirLink(redirect, docs);
    try {
      await assert.rejects(() => opSnapshotRestore({ id }, workspaceDir), /scope_denied|symlink_ancestor/);
      assert.equal(readFileSync(path.join(redirect, "b.txt"), "utf8"), "redirect\n");
    } finally {
      removeDirLink(docs);
      await mkdir(docs, { recursive: true });
      await writeFile(path.join(docs, "b.txt"), "b\n");
    }
  });

  // A store inside the workspace must be protected and excluded from captures.
  const insideStore = path.join(workspaceDir, ".store");
  process.env.VENIRA_SNAPSHOT_DIR = insideStore;
  mkdirSync(insideStore, { recursive: true });
  writeFileSync(path.join(insideStore, "secret.bin"), "store-only\n");

  await check("the store inside the workspace is protected from the file tools", () => {
    assert.equal(isProtectedPath(path.join(insideStore, "secret.bin")), true);
    assert.equal(snapshotPaths.snapshotStoreDir(workspaceDir, os.homedir()) === insideStore, true);
  });

  await check("the store inside the workspace is excluded from captures", async () => {
    const response = await opSnapshotCreate({ paths: ["."] }, workspaceDir);
    const skipped = response.result.data.skipped as Array<{ path: string; reason: string }>;
    assert.ok(
      skipped.some((entry) => entry.path === ".store" && entry.reason === "excluded:data_dir"),
      JSON.stringify(skipped),
    );
  });

  await check("a doctored manifest cannot restore into the store", async () => {
    const id = snapshotId(await opSnapshotCreate({ paths: ["src"] }, workspaceDir));
    tamperManifest(insideStore, id, (manifest) => {
      manifest.files[0].path = ".store/evil.bin";
    });
    await assert.rejects(() => opSnapshotRestore({ id }, workspaceDir), /scope_denied|excluded:data_dir/);
    assert.equal(existsSync(path.join(insideStore, "evil.bin")), false);
  });

  console.log(`\nProtected-path and snapshot-path tests passed (${checks} checks).`);
} finally {
  delete process.env.VENIRA_SNAPSHOT_DIR;
  await rm(tempRoot, { recursive: true, force: true });
}
