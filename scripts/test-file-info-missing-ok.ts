/**
 * Phase 12 of ROADMAP_TOOLS.md: `get_file_info` `missing_ok` flag.
 *
 * Pins:
 *   1. Default (no flag): a missing path rejects with [not_found] (unchanged behavior).
 *   2. missing_ok=1: missing path answers ok with data.exists:false; existing path answers as before plus exists:true.
 *   3. A directory answers like a file (exists:true, kind=directory).
 *   4. Errors other than [not_found] (e.g. path_escape) are NOT swallowed by the flag.
 *   5. read_batch: an item with missing_ok=1 on a missing path is ok; a mixed batch (exists + missing) answers ok:true.
 *   6. The cache does not leak: after a missing_ok=1 probe, a default call on the same path still rejects with [not_found].
 *
 * Run with: npm run test:file-info-missing-ok
 */
import "./clean-env.js"; // must stay first: inherited VENIRA_* env would change behavior
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "venira-file-info-missing-ok-"));
fs.writeFileSync(path.join(dir, "present.txt"), "hello");
fs.mkdirSync(path.join(dir, "subdir"));

// Stub backend that mirrors lib/corehost-fileread.ts opGetFileInfo.
const execute = async (operation: string, args: Record<string, unknown>): Promise<any> => {
  if (operation !== "get_file_info") throw new Error(`unexpected operation ${operation}`);
  const rel = String(args.relative_path ?? ".");
  if (!("missing_ok" in args)) {
    // sanity: the executor must strip the flag before the backend sees it
  }
  const abs = path.resolve(dir, rel);
  try {
    const stat = fs.statSync(abs);
    return {
      status: "completed",
      result: {
        kind: "file_info",
        data: {
          relative_path: rel,
          kind: stat.isDirectory() ? "directory" : "file",
          size_bytes: stat.size,
          modified_unix_seconds: Math.floor(stat.mtimeMs / 1000),
        },
      },
    };
  } catch {
    throw new Error(`[not_found] Path does not exist: ${rel}. Hint: check with list_files.`);
  }
};

const { createCacheLayer } = await import("../tools/project-cache.js");
const { createCachedExecutor } = await import("../tools/project-executor.js");
const { runReadBatch } = await import("../tools/project-batch.js");

const toHostPath = (relativePath: string | undefined): string => {
  const rel = relativePath ?? ".";
  if (rel.split(/[\\/]/).includes("..")) {
    throw new Error(`[path_escape] Path resolves outside the workspace: ${rel}.`);
  }
  return path.resolve(dir, rel);
};
const prepare = (_operation: string, args: Record<string, unknown>) => args;

const cache = createCacheLayer({ execute, prepare, toHostPath });
const executeCached = createCachedExecutor({
  cache,
  execute,
  rememberEdit: () => {},
  clearRecentEdits: () => {},
  trackShell: () => {},
});

let checks = 0;
async function check(name: string, fn: () => Promise<void>) {
  await fn();
  checks += 1;
  console.log(`ok - ${name}`);
}

try {
  await check("default call on a missing path rejects with [not_found]", async () => {
    await assert.rejects(() => executeCached("get_file_info", { relative_path: "nope.txt" }), /^Error: \[not_found\]/);
  });

  await check("missing_ok=1 on a missing path answers ok with exists:false", async () => {
    const { response } = await executeCached("get_file_info", { relative_path: "nope.txt", missing_ok: 1 });
    const data = (response.result as any).data;
    assert.equal(data.exists, false);
    assert.equal(data.relative_path, "nope.txt");
  });

  await check("missing_ok=1 on an existing file answers like before plus exists:true", async () => {
    const { response } = await executeCached("get_file_info", { relative_path: "present.txt", missing_ok: true });
    const data = (response.result as any).data;
    assert.equal(data.exists, true);
    assert.equal(data.kind, "file");
    assert.equal(typeof data.size_bytes, "number");
  });

  await check("missing_ok=1 on a directory answers kind=directory with exists:true", async () => {
    const { response } = await executeCached("get_file_info", { relative_path: "subdir", missing_ok: 1 });
    const data = (response.result as any).data;
    assert.equal(data.exists, true);
    assert.equal(data.kind, "directory");
  });

  await check("missing_ok=1 does not swallow non-[not_found] errors", async () => {
    await assert.rejects(
      () => executeCached("get_file_info", { relative_path: "../outside.txt", missing_ok: 1 }),
      /^Error: \[path_escape\]/,
    );
  });

  await check("read_batch: missing item with missing_ok=1 is ok and a mixed batch answers ok:true", async () => {
    const batchDeps = { execute: (op: string, args: any) => executeCached(op, args), maxBatchResponseBytes: 2 * 1024 * 1024 };
    const result: any = await runReadBatch(
      [
        { operation: "get_file_info", arguments: { relative_path: "present.txt" } },
        { operation: "get_file_info", arguments: { relative_path: "nope.txt", missing_ok: 1 } },
      ],
      524288,
      batchDeps as any,
    );
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.ok, true);
    assert.equal(payload.data.responses[0].ok, true);
    assert.equal(payload.data.responses[0].response.data.exists, undefined);
    assert.equal(payload.data.responses[1].ok, true);
    assert.equal(payload.data.responses[1].response.data.exists, false);
  });

  await check("read_batch: missing item WITHOUT missing_ok still fails the batch (default unchanged)", async () => {
    const batchDeps = { execute: (op: string, args: any) => executeCached(op, args), maxBatchResponseBytes: 2 * 1024 * 1024 };
    const result: any = await runReadBatch(
      [
        { operation: "get_file_info", arguments: { relative_path: "present.txt" } },
        { operation: "get_file_info", arguments: { relative_path: "nope.txt" } },
      ],
      524288,
      batchDeps as any,
    );
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.ok, false);
    assert.equal(payload.data.responses[1].ok, false);
    assert.equal(payload.data.responses[1].error.code, "not_found");
  });

  await check("cache does not leak: default call after a missing_ok=1 probe still rejects with [not_found]", async () => {
    // Fresh cache state for this path: the probe stores nothing, so the default call hits the backend again.
    const { response } = await executeCached("get_file_info", { relative_path: "nope.txt", missing_ok: 1 });
    assert.equal((response.result as any).data.exists, false);
    await assert.rejects(() => executeCached("get_file_info", { relative_path: "nope.txt" }), /^Error: \[not_found\]/);
  });
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${checks} checks passed`);
