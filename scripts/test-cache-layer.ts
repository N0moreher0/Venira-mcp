/**
 * Unit tests for the file/info/TTL caches in tools/project-cache.ts.
 *
 * Covers three weaknesses found in review:
 *   1. enforceLimits evicted by entry count, so a few big info entries could outlive many small read entries.
 *   2. The list/search/recent/references TTL caches were capped by entries (64) but not by bytes.
 *   3. stat (mtime + size) cannot see a same-size rewrite inside one timestamp tick ("racy" entries).
 *
 * Run with: npm run test:cache-layer
 */
import "./clean-env.js"; // must stay first: inherited VENIRA_* env would change cache limits
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.VENIRA_READ_CACHE_BYTES = "4000";
process.env.VENIRA_TTL_CACHE_BYTES = "3000";
process.env.VENIRA_CACHE_RACY_MS = "40";
process.env.VENIRA_RECENT_CACHE_MS = "60000";

const { createCacheLayer } = await import("../tools/project-cache.js");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "venira-cache-layer-"));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let executeCalls = 0;
const execute = async (operation: string, args: Record<string, unknown>): Promise<any> => {
  executeCalls += 1;
  const abs = path.resolve(dir, String(args.relative_path ?? "."));
  if (operation === "read_file") {
    return { status: "completed", truncated: false, result: { kind: "file_read", data: { text: fs.readFileSync(abs, "utf8") } } };
  }
  if (operation === "get_file_info") {
    // Deliberately large so a handful of entries pushes the shared byte budget over its cap.
    return { status: "completed", truncated: false, result: { kind: "file_info", data: { pad: "x".repeat(1500) } } };
  }
  throw new Error(`unexpected operation ${operation}`);
};

const newLayer = () =>
  createCacheLayer({
    execute: (operation: string, args: Record<string, unknown>) => execute(operation, args),
    prepare: (_operation: string, args: Record<string, unknown>) => args,
    toHostPath: (relativePath: string | undefined) => path.resolve(dir, relativePath ?? "."),
  });

const textOf = (response: any): string => response.result.data.text;
const makeOld = (file: string) => {
  const hourAgo = Date.now() / 1000 - 3600;
  fs.utimesSync(file, hourAgo, hourAgo);
};

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

await check("an old, unchanged file is served from the cache", async () => {
  const cache = newLayer();
  const file = path.join(dir, "old.txt");
  fs.writeFileSync(file, "hello");
  makeOld(file);
  assert.equal((await cache.readFileCached({ relative_path: "old.txt" })).cached, false);
  assert.equal((await cache.readFileCached({ relative_path: "old.txt" })).cached, true);
});

await check("a same-size rewrite that keeps the same mtime is not served stale (racy entry)", async () => {
  const cache = newLayer();
  const file = path.join(dir, "racy.txt");
  fs.writeFileSync(file, "aaaa");
  // Date objects keep whole milliseconds, so the same stamp applied twice gives a bit-identical mtimeMs.
  const stamp = new Date(Date.now());
  fs.utimesSync(file, stamp, stamp);
  const first = fs.statSync(file);
  assert.equal(textOf((await cache.readFileCached({ relative_path: "racy.txt" })).response), "aaaa");
  fs.writeFileSync(file, "bbbb");
  fs.utimesSync(file, stamp, stamp); // same size, same mtime: stat alone sees no change
  assert.equal(fs.statSync(file).mtimeMs, first.mtimeMs, "test setup: mtime and size are indistinguishable");
  assert.equal(fs.statSync(file).size, first.size);
  const second = await cache.readFileCached({ relative_path: "racy.txt" });
  assert.equal(textOf(second.response), "bbbb", "must re-read, not return the cached aaaa");
  assert.equal(second.cached, false);
});

await check("a racy entry settles into a normal cache hit once the window has passed", async () => {
  const cache = newLayer();
  const file = path.join(dir, "settle.txt");
  fs.writeFileSync(file, "settle");
  assert.equal((await cache.readFileCached({ relative_path: "settle.txt" })).cached, false);
  assert.equal((await cache.readFileCached({ relative_path: "settle.txt" })).cached, false, "still inside the racy window");
  await sleep(80);
  assert.equal((await cache.readFileCached({ relative_path: "settle.txt" })).cached, false, "stored without the racy flag");
  assert.equal((await cache.readFileCached({ relative_path: "settle.txt" })).cached, true);
});

await check("a file rewritten while it is being read is not cached under the new mtime", async () => {
  const file = path.join(dir, "midread.txt");
  fs.writeFileSync(file, "v1");
  makeOld(file);
  let swapped = false;
  const cache = createCacheLayer({
    execute: async (operation: string, args: Record<string, unknown>) => {
      const response = await execute(operation, args);
      if (!swapped) {
        swapped = true;
        fs.writeFileSync(file, "v2-longer"); // changes mtime and size after the read finished
        const future = Date.now() / 1000 + 100;
        fs.utimesSync(file, future, future);
      }
      return response;
    },
    prepare: (_operation: string, args: Record<string, unknown>) => args,
    toHostPath: (relativePath: string | undefined) => path.resolve(dir, relativePath ?? "."),
  });
  assert.equal(textOf((await cache.readFileCached({ relative_path: "midread.txt" })).response), "v1");
  const again = await cache.readFileCached({ relative_path: "midread.txt" });
  assert.equal(again.cached, false);
  assert.equal(textOf(again.response), "v2-longer");
});

await check("the byte budget evicts the cache that holds the bytes, not the one with more entries", async () => {
  const cache = newLayer();
  for (let i = 0; i < 6; i += 1) {
    const file = path.join(dir, `small-${i}.txt`);
    fs.writeFileSync(file, "s");
    makeOld(file);
    await cache.readFileCached({ relative_path: `small-${i}.txt` });
  }
  for (let i = 0; i < 3; i += 1) {
    const file = path.join(dir, `big-${i}.txt`);
    fs.writeFileSync(file, "b");
    makeOld(file);
    await cache.fileInfoCached({ relative_path: `big-${i}.txt` });
  }
  const report = cache.report();
  assert.equal(report.read.entries, 6, "the small read entries survive");
  assert.ok(report.info.entries < 3, "the big info entries were evicted first");
  assert.ok(report.read.bytes + report.info.bytes <= 4000, "total stays inside the cap");
});

await check("TTL caches are capped by bytes as well as by entry count", async () => {
  const cache = newLayer();
  const response = (n: number) => ({ status: "completed", truncated: false, result: { kind: "recent", data: { n, pad: "y".repeat(1000) } } });
  for (let i = 0; i < 10; i += 1) cache.recent.store(`k${i}`, response(i) as any);
  const report = cache.report();
  assert.ok(report.recent.entries >= 1 && report.recent.entries <= 3, `kept ${report.recent.entries} entries under a 3000 byte cap`);
  assert.equal(cache.recent.lookup("k0"), null, "the oldest entry was evicted");
  assert.ok(cache.recent.lookup("k9"), "the newest entry is kept");
});

await check("invalidatePath drops a racy-or-not entry so the next read goes to the backend", async () => {
  const cache = newLayer();
  const file = path.join(dir, "inval.txt");
  fs.writeFileSync(file, "one");
  makeOld(file);
  await cache.readFileCached({ relative_path: "inval.txt" });
  const before = executeCalls;
  cache.invalidatePath(path.resolve(dir, "inval.txt"));
  await cache.readFileCached({ relative_path: "inval.txt" });
  assert.equal(executeCalls, before + 1);
});

fs.rmSync(dir, { recursive: true, force: true });
if (failures.length > 0) {
  console.error(`Cache layer tests FAILED (${failures.length}): ${failures.join("; ")}`);
  process.exit(1);
}
console.log(`Cache layer tests passed (${passed} checks).`);
