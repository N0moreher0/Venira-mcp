/**
 * C1 + C2 of ROADMAP_CACHE: sliding TTL with a hard ceiling, and the workspace epoch bumped by finished shell runs.
 *
 *   1. a hit renews the entry's age, so a repeated query keeps hitting past the absolute TTL (slided_hits counts it)
 *   2. the hard ceiling (VENIRA_CACHE_MAX_AGE_MS) still expires an entry that is hit continuously
 *   3. VENIRA_CACHE_MAX_AGE_MS=0 restores the absolute TTL (one-env rollback)
 *   4. bumpEpoch kills list/search entries at once; a search that started before the bump is not stored
 *   5. a finished shell_run bumps the epoch, a running one does not, repeated shell_status polls bump once
 *   6. VENIRA_SHELL_EPOCH=0 keeps the old shell behaviour (no bump)
 *
 * Run with: npm run test:cache-epoch
 */
import "./clean-env.js"; // must stay first: inherited VENIRA_* env would change cache limits
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { classifyWorkspaceEffect, createShellRunRegistry } from "../tools/project-shell-registry.js";

process.env.VENIRA_LIST_CACHE_MS = "200";
process.env.VENIRA_SEARCH_CACHE_MS = "200";

const { createCacheLayer } = await import("../tools/project-cache.js");
const { createCachedExecutor } = await import("../tools/project-executor.js");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "venira-cache-epoch-"));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let executeCalls = 0;
let searchDelayMs = 0;
const execute = async (operation: string, args: Record<string, unknown>): Promise<any> => {
  executeCalls += 1;
  if (operation === "list_files") return { status: "completed", truncated: false, result: { kind: "dir_listing", data: { entries: [], n: executeCalls } } };
  if (operation === "search") {
    if (searchDelayMs > 0) await sleep(searchDelayMs);
    return { status: "completed", truncated: false, result: { kind: "search", data: { complete: true, hits: [], n: executeCalls } } };
  }
  if (operation.startsWith("shell_")) return { status: "completed", truncated: false, result: { kind: "shell", data: args.__data } };
  throw new Error("unexpected operation " + operation);
};
const newLayer = () =>
  createCacheLayer({
    execute: (operation: string, args: Record<string, unknown>) => execute(operation, args),
    prepare: (_operation: string, args: Record<string, unknown>) => args,
    toHostPath: (relativePath: string | undefined) => path.resolve(dir, relativePath ?? "."),
  });

let passed = 0;
const failures: string[] = [];
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`ok ${passed} - ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`not ok - ${name}: ${(error as Error).message.split("\n")[0]}`);
  }
}

await check("a hit renews the age: repeated list keeps hitting past the absolute TTL", async () => {
  delete process.env.VENIRA_CACHE_MAX_AGE_MS; // default ceiling = 10 x TTL
  const cache = newLayer();
  assert.equal((await cache.listCached({ relative_path: "." })).cached, false);
  await sleep(120);
  assert.equal((await cache.listCached({ relative_path: "." })).cached, true); // 0.6 x TTL
  await sleep(120);
  assert.equal((await cache.listCached({ relative_path: "." })).cached, true); // 1.2 x TTL since store: only sliding keeps it
  assert.ok(((cache.report() as any).list.slided_hits ?? 0) >= 1, "slided_hits not counted");
});

await check("the hard ceiling expires an entry that is hit continuously", async () => {
  process.env.VENIRA_CACHE_MAX_AGE_MS = "450";
  const cache = newLayer();
  await cache.listCached({ relative_path: "." });
  let missedAt = -1;
  for (let i = 1; i <= 8; i += 1) {
    await sleep(100);
    if (!(await cache.listCached({ relative_path: "." })).cached) {
      missedAt = i * 100;
      break;
    }
  }
  assert.ok(missedAt >= 400, "ceiling did not expire the entry (missedAt=" + missedAt + ")");
  assert.ok(((cache.report() as any).list.ceiling_expired ?? 0) >= 1, "ceiling_expired not counted");
});

await check("VENIRA_CACHE_MAX_AGE_MS=0 keeps the absolute TTL", async () => {
  process.env.VENIRA_CACHE_MAX_AGE_MS = "0";
  const cache = newLayer();
  await cache.listCached({ relative_path: "." });
  await sleep(120);
  assert.equal((await cache.listCached({ relative_path: "." })).cached, true);
  await sleep(120);
  assert.equal((await cache.listCached({ relative_path: "." })).cached, false, "age was renewed although sliding is off");
});

await check("bumpEpoch drops list/search at once; a search in flight across the bump is not stored", async () => {
  delete process.env.VENIRA_CACHE_MAX_AGE_MS;
  const cache = newLayer();
  await cache.listCached({ relative_path: "." });
  assert.equal((await cache.listCached({ relative_path: "." })).cached, true);
  const before = cache.getEpoch();
  cache.bumpEpoch();
  assert.equal(cache.getEpoch(), before + 1);
  assert.equal((await cache.listCached({ relative_path: "." })).cached, false, "stale list served after the bump");

  searchDelayMs = 150;
  const inFlight = cache.searchCached({ query: "x" });
  await sleep(40);
  cache.bumpEpoch();
  await inFlight;
  searchDelayMs = 0;
  assert.equal((await cache.searchCached({ query: "x" })).cached, false, "a pre-bump search result was cached");
});

const makeExecutor = () => {
  const cache = newLayer();
  const registry = createShellRunRegistry();
  const run = createCachedExecutor({
    cache,
    execute: (operation: string, args: Record<string, unknown>) => execute(operation, args),
    rememberEdit: () => {},
    clearRecentEdits: () => {},
    trackShell: (operation, data, workspaceEffect) => registry.track(operation, data, workspaceEffect),
  });
  return { cache, run };
};

await check("workspace classifier is conservative and rejects shell composition", async () => {
  assert.equal(classifyWorkspaceEffect("dir"), "read_only");
  assert.equal(classifyWorkspaceEffect("git status"), "read_only");
  assert.equal(classifyWorkspaceEffect("git checkout main"), "mutating");
  assert.equal(classifyWorkspaceEffect("dir > out.txt"), "unknown");
  assert.equal(classifyWorkspaceEffect("node -e fs.writeFileSync('x','y')"), "unknown");
  assert.equal(classifyWorkspaceEffect(undefined), "unknown");
});

await check("auto mode keeps cache warm for synchronous read-only shell", async () => {
  process.env.VENIRA_SHELL_EPOCH = "auto";
  const { cache, run } = makeExecutor();
  const e0 = cache.getEpoch();
  await run("shell_run", { command: "dir", __data: { exit_code: 0 } });
  assert.equal(cache.getEpoch(), e0);
  delete process.env.VENIRA_SHELL_EPOCH;
});

await check("auto mode preserves effect metadata from background start to terminal poll", async () => {
  process.env.VENIRA_SHELL_EPOCH = "auto";
  const { cache, run } = makeExecutor();
  const e0 = cache.getEpoch();
  await run("shell_run", { command: "dir", __data: { running: true, run_id: "ro-bg" } });
  await run("shell_status", { __data: { running: false, exit_code: 0, run_id: "ro-bg" } });
  assert.equal(cache.getEpoch(), e0, "read-only metadata was lost before shell_status");
  await run("shell_status", { __data: { running: false, exit_code: 0, run_id: "ro-bg" } });
  assert.equal(cache.getEpoch(), e0, "duplicate terminal poll changed epoch");
  delete process.env.VENIRA_SHELL_EPOCH;
});

await check("auto mode bumps unknown background shells once on failure/cancel", async () => {
  process.env.VENIRA_SHELL_EPOCH = "auto";
  const { cache, run } = makeExecutor();
  const e0 = cache.getEpoch();
  await run("shell_run", { command: "node -e write", __data: { running: true, run_id: "mut-bg" } });
  await run("shell_status", { __data: { running: false, exit_code: 1, run_id: "mut-bg" } });
  assert.equal(cache.getEpoch(), e0 + 1);
  await run("shell_status", { __data: { running: false, exit_code: 1, run_id: "mut-bg" } });
  assert.equal(cache.getEpoch(), e0 + 1);
  delete process.env.VENIRA_SHELL_EPOCH;
});

await check("a finished shell_run bumps the epoch; a running one and repeat polls do not", async () => {
  delete process.env.VENIRA_SHELL_EPOCH;
  const { cache, run } = makeExecutor();
  const e0 = cache.getEpoch();
  await run("shell_run", { __data: { running: true, run_id: "r1" } });
  assert.equal(cache.getEpoch(), e0, "a running background run bumped the epoch");
  await run("shell_status", { __data: { running: false, exit_code: 0, run_id: "r1" } });
  assert.equal(cache.getEpoch(), e0 + 1, "the finished run did not bump");
  await run("shell_status", { __data: { running: false, exit_code: 0, run_id: "r1" } });
  assert.equal(cache.getEpoch(), e0 + 1, "a repeat poll bumped again");
  await run("shell_run", { __data: { exit_code: 0 } }); // foreground: no run_id, finished
  assert.equal(cache.getEpoch(), e0 + 2, "a foreground run did not bump");
});

await check("VENIRA_SHELL_EPOCH=0 keeps the old behaviour", async () => {
  process.env.VENIRA_SHELL_EPOCH = "0";
  const { cache, run } = makeExecutor();
  const e0 = cache.getEpoch();
  await run("shell_run", { __data: { exit_code: 0 } });
  assert.equal(cache.getEpoch(), e0);
  delete process.env.VENIRA_SHELL_EPOCH;
});

fs.rmSync(dir, { recursive: true, force: true });
if (failures.length > 0) {
  console.error(`\n${failures.length} failed: ${failures.join("; ")}`);
  process.exit(1);
}
console.log(`\n${passed} cache-epoch checks passed`);
