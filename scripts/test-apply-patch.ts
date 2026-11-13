/**
 * Phase 2 of ROADMAP_TOOLS.md: project_apply_patch (corehost op apply_patch).
 *
 * Pins:
 *   1. A hunk applies; the file reports the action and the totals add up.
 *   2. CRLF files keep CRLF line endings; a CRLF patch applies to an LF file.
 *   3. dry_run=1 validates, reports the files and writes nothing (no files, no directories).
 *   4. Created files (incl. into missing parent dirs), deleted files, pure renames and renames with hunks.
 *   5. Multi-file patch: one failing hunk changes NOTHING (validation happens before any write).
 *   6. expected_sha256: correct hash applies, wrong hash is stale_content, unknown keys are invalid_request.
 *   7. Malformed patches and out-of-workspace paths are refused with nothing written.
 *
 * Run with: npm run test:apply-patch
 */
import "./clean-env.js"; // must stay first: inherited VENIRA_* env would point the checkpoint store at the real one
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempBase = process.platform === "win32" ? fs.realpathSync(os.tmpdir()) : os.tmpdir();
const tempDir = fs.mkdtempSync(path.join(tempBase, "venira-apply-patch-"));
const root = path.join(tempDir, "workspace");
fs.mkdirSync(root, { recursive: true });
process.env.VENIRA_DATA_DIR = path.join(tempDir, "data");
process.env.VENIRA_SNAPSHOT_DIR = path.join(tempDir, "snapshots");

const { opApplyPatch } = (await import(pathToFileURL(path.join(repoRoot, "lib", "corehost-patch.ts")).href)) as typeof import("../lib/corehost-patch.js");

const at = (rel: string) => path.join(root, rel);
const write = (rel: string, text: string | Buffer) => {
  fs.mkdirSync(path.dirname(at(rel)), { recursive: true });
  fs.writeFileSync(at(rel), text);
};
const read = (rel: string) => fs.readFileSync(at(rel), "utf8");
const readBuffer = (rel: string) => fs.readFileSync(at(rel));
const data = (res: unknown) => (res as { result: { data: Record<string, unknown> } }).result.data;
const sha256Of = (text: string) => crypto.createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
const patchLines = (lines: string[]) => lines.join("\n") + "\n";

const modifyHunk = (rel: string, oldLine: string, newLine: string) =>
  patchLines([
    `diff --git a/${rel} b/${rel}`,
    `--- a/${rel}`,
    `+++ b/${rel}`,
    `@@ -1,3 +1,3 @@`,
    ` one`,
    `-${oldLine}`,
    `+${newLine}`,
    ` three`,
  ]);

const createFile = (rel: string, contents: string[]) =>
  patchLines([
    `diff --git a/${rel} b/${rel}`,
    `new file mode 100644`,
    `--- /dev/null`,
    `+++ b/${rel}`,
    `@@ -0,0 +1,${contents.length} @@`,
    ...contents.map((line) => `+${line}`),
  ]);

let checks = 0;
async function check(name: string, fn: () => Promise<void>) {
  await fn();
  checks += 1;
  console.log(`ok - ${name}`);
}

try {
  await check("a hunk applies and reports added/modified/deleted/renamed counts", async () => {
    write("m/a.txt", "one\ntwo\nthree\n");
    const d = data(await opApplyPatch({ patch: modifyHunk("m/a.txt", "two", "TWO") }, root));
    assert.equal(read("m/a.txt"), "one\nTWO\nthree\n");
    assert.deepEqual([d.added, d.modified, d.deleted, d.renamed], [0, 1, 0, 0]);
    assert.equal(d.atomic, true);
    assert.equal((d.files as Array<Record<string, unknown>>)[0].action, "modified");
  });

  await check("CRLF files keep CRLF line endings", async () => {
    write("crlf/a.txt", "one\r\ntwo\r\nthree\r\n");
    await opApplyPatch({ patch: modifyHunk("crlf/a.txt", "two", "TWO") }, root);
    assert.equal(read("crlf/a.txt"), "one\r\nTWO\r\nthree\r\n");
  });

  await check("a CRLF patch applies to an LF file", async () => {
    write("crlf-patch/a.txt", "one\ntwo\nthree\n");
    const patch = modifyHunk("crlf-patch/a.txt", "two", "TWO").replace(/\n/g, "\r\n");
    await opApplyPatch({ patch }, root);
    assert.equal(read("crlf-patch/a.txt"), "one\nTWO\nthree\n");
  });

  await check("dry_run=1 writes nothing and creates no directories", async () => {
    write("dry/a.txt", "one\ntwo\nthree\n");
    const d = data(await opApplyPatch({ patch: createFile("dry/new-dir/out.txt", ["seed"]), dry_run: 1 }, root));
    assert.equal(d.dry_run, true);
    assert.equal((d.files as Array<Record<string, unknown>>)[0].action, "added");
    assert.equal(fs.existsSync(at("dry/new-dir")), false);
    assert.equal(fs.readFileSync(at("dry/a.txt"), "utf8"), "one\ntwo\nthree\n");
  });

  await check("a created file is written, parent directories are made", async () => {
    const d = data(await opApplyPatch({ patch: createFile("created/deep/new.txt", ["first", "second"]) }, root));
    assert.equal(read("created/deep/new.txt"), "first\nsecond\n");
    assert.deepEqual([d.added, d.modified, d.deleted, d.renamed], [1, 0, 0, 0]);
  });

  await check("creating a file that already exists is a conflict and writes nothing", async () => {
    write("clash/here.txt", "original");
    await assert.rejects(
      () => opApplyPatch({ patch: createFile("clash/here.txt", ["intruder"]) }, root),
      /^Error: \[conflict\]/,
    );
    assert.equal(read("clash/here.txt"), "original");
  });

  await check("a file is deleted", async () => {
    write("del/gone.txt", "bye\n");
    const d = data(await opApplyPatch({
      patch: patchLines([
        "diff --git a/del/gone.txt b/del/gone.txt",
        "deleted file mode 100644",
        "--- a/del/gone.txt",
        "+++ /dev/null",
        "@@ -1,1 +0,0 @@",
        "-bye",
      ]),
    }, root));
    assert.equal(fs.existsSync(at("del/gone.txt")), false);
    assert.deepEqual([d.added, d.modified, d.deleted, d.renamed], [0, 0, 1, 0]);
  });

  await check("a pure rename moves the file without touching content", async () => {
    write("mv/from.txt", "payload\n");
    const d = data(await opApplyPatch({
      patch: patchLines([
        "diff --git a/mv/from.txt b/mv/to.txt",
        "similarity index 100%",
        "rename from mv/from.txt",
        "rename to mv/to.txt",
      ]),
    }, root));
    assert.equal(fs.existsSync(at("mv/from.txt")), false);
    assert.equal(read("mv/to.txt"), "payload\n");
    assert.deepEqual([d.added, d.modified, d.deleted, d.renamed], [0, 0, 0, 1]);
  });

  await check("a rename with hunks writes the new file and removes the old one", async () => {
    write("mvh/old.txt", "hello\n");
    const d = data(await opApplyPatch({
      patch: patchLines([
        "diff --git a/mvh/old.txt b/mvh/new.txt",
        "similarity index 90%",
        "rename from mvh/old.txt",
        "rename to mvh/new.txt",
        "--- a/mvh/old.txt",
        "+++ b/mvh/new.txt",
        "@@ -1,1 +1,1 @@",
        "-hello",
        "+hello world",
      ]),
    }, root));
    assert.equal(read("mvh/new.txt"), "hello world\n");
    assert.equal(fs.existsSync(at("mvh/old.txt")), false);
    assert.deepEqual([d.added, d.modified, d.deleted, d.renamed], [0, 0, 0, 1]);
  });

  await check("one failing file changes nothing at all", async () => {
    write("atom/one.txt", "one\ntwo\nthree\n");
    write("atom/two.txt", "alpha\nbeta\ngamma\n");
    const patch = modifyHunk("atom/one.txt", "two", "TWO") + modifyHunk("atom/two.txt", "NOT THERE", "CHANGED");
    await assert.rejects(() => opApplyPatch({ patch }, root), /^Error: \[stale_content\]/);
    assert.equal(read("atom/one.txt"), "one\ntwo\nthree\n");
    assert.equal(read("atom/two.txt"), "alpha\nbeta\ngamma\n");
  });

  await check("a mismatching hunk reports nearest_context", async () => {
    write("ctx/a.txt", "aaa\nbbb\nccc\n");
    try {
      await opApplyPatch({ patch: modifyHunk("ctx/a.txt", "WRONG", "FIXED") }, root);
      assert.fail("expected the patch to be rejected");
    } catch (error) {
      const err = error as Error & { data?: { hunk_index?: number; nearest_context?: string[] } };
      assert.match(err.message, /^\[stale_content\]/);
      assert.equal(err.data?.hunk_index, 1);
      assert.ok(Array.isArray(err.data?.nearest_context));
    }
  });

  await check("expected_sha256 with the current hash applies; a wrong hash is stale_content", async () => {
    write("guard/a.txt", "one\ntwo\nthree\n");
    const good = sha256Of("one\ntwo\nthree\n");
    const d = data(await opApplyPatch({ patch: modifyHunk("guard/a.txt", "two", "TWO"), expected_sha256: { "guard/a.txt": good } }, root));
    assert.equal(read("guard/a.txt"), "one\nTWO\nthree\n");
    assert.equal(d.modified, 1);

    write("guard/b.txt", "one\ntwo\nthree\n");
    await assert.rejects(
      () => opApplyPatch({ patch: modifyHunk("guard/b.txt", "two", "TWO"), expected_sha256: { "guard/b.txt": "0".repeat(64) } }, root),
      /^Error: \[stale_content\]/,
    );
    assert.equal(read("guard/b.txt"), "one\ntwo\nthree\n");
  });

  await check("expected_sha256 with an untouched path is invalid_request", async () => {
    write("guard2/a.txt", "one\ntwo\nthree\n");
    await assert.rejects(
      () => opApplyPatch({ patch: modifyHunk("guard2/a.txt", "two", "TWO"), expected_sha256: { "elsewhere.txt": "0".repeat(64) } }, root),
      /^Error: \[invalid_request\]/,
    );
    assert.equal(read("guard2/a.txt"), "one\ntwo\nthree\n");
  });

  await check("a malformed patch line is invalid_request with nothing written", async () => {
    write("bad/a.txt", "one\ntwo\nthree\n");
    await assert.rejects(
      () => opApplyPatch({
        patch: patchLines([
          "diff --git a/bad/a.txt b/bad/a.txt",
          "--- a/bad/a.txt",
          "+++ b/bad/a.txt",
          "@@ -1,1 +1,1 @@",
          "?what",
        ]),
      }, root),
      /^Error: \[invalid_request\]/,
    );
    assert.equal(read("bad/a.txt"), "one\ntwo\nthree\n");
  });

  await check("a hunk whose declared counts are not satisfiable is invalid_request", async () => {
    write("bad2/a.txt", "one\ntwo\nthree\n");
    await assert.rejects(
      () => opApplyPatch({
        patch: patchLines([
          "diff --git a/bad2/a.txt b/bad2/a.txt",
          "--- a/bad2/a.txt",
          "+++ b/bad2/a.txt",
          "@@ -1,3 +1,3 @@",
          " one",
          "-two",
        ]),
      }, root),
      /^Error: \[invalid_request\]/,
    );
    assert.equal(read("bad2/a.txt"), "one\ntwo\nthree\n");
  });

  await check("paths outside the workspace are refused", async () => {
    await assert.rejects(
      () => opApplyPatch({
        patch: patchLines([
          "diff --git a/../evil.txt b/../evil.txt",
          "--- a/../evil.txt",
          "+++ b/../evil.txt",
          "@@ -1,1 +1,1 @@",
          "-x",
          "+y",
        ]),
      }, root),
      /^Error: \[invalid_request\]/,
    );
  });

  await check("an absolute patch path is invalid_request", async () => {
    await assert.rejects(
      () => opApplyPatch({
        patch: patchLines([
          "--- a/C:/evil.txt",
          "+++ b/C:/evil.txt",
          "@@ -1,1 +1,1 @@",
          "-x",
          "+y",
        ]),
      }, root),
      /^Error: \[invalid_request\]/,
    );
  });

  await check("deleting a patch targeting a directory is invalid_request", async () => {
    write("dirpatch/dir/inner.txt", "x");
    await assert.rejects(
      () => opApplyPatch({
        patch: patchLines([
          "diff --git a/dirpatch/dir b/dirpatch/dir",
          "--- a/dirpatch/dir",
          "+++ /dev/null",
          "@@ -1,1 +0,0 @@",
          "-x",
        ]),
      }, root),
      /^Error: \[invalid_request\]/,
    );
    assert.equal(read("dirpatch/dir/inner.txt"), "x");
  });

  await check("deleting a file that does not exist is not_found", async () => {
    await assert.rejects(
      () => opApplyPatch({
        patch: patchLines([
          "diff --git a/ghost.txt b/ghost.txt",
          "--- a/ghost.txt",
          "+++ /dev/null",
          "@@ -1,1 +0,0 @@",
          "-bye",
        ]),
      }, root),
      /^Error: \[not_found\]/,
    );
  });

  await check("the same path in two file sections is invalid_request", async () => {
    write("dup/a.txt", "one\n");
    const patch =
      patchLines([
        "diff --git a/dup/a.txt b/dup/a.txt",
        "--- a/dup/a.txt",
        "+++ b/dup/a.txt",
        "@@ -1,1 +1,1 @@",
        "-one",
        "+uno",
      ]) +
      patchLines([
        "diff --git a/dup/a.txt b/dup/a.txt",
        "--- a/dup/a.txt",
        "+++ b/dup/a.txt",
        "@@ -1,1 +1,1 @@",
        "-uno",
        "+dos",
      ]);
    await assert.rejects(() => opApplyPatch({ patch }, root), /^Error: \[invalid_request\]/);
    assert.equal(read("dup/a.txt"), "one\n");
  });

  await check("a binary (non-UTF-8) file is refused and left untouched", async () => {
    write("bin/blob.bin", Buffer.from([0xff, 0x00, 0xfe, 0x41, 0xff]));
    await assert.rejects(
      () => opApplyPatch({ patch: modifyHunk("bin/blob.bin", "A", "B") }, root),
      /^Error: \[unsupported\]/,
    );
    assert.deepEqual(readBuffer("bin/blob.bin"), Buffer.from([0xff, 0x00, 0xfe, 0x41, 0xff]));
  });

  await check("an empty patch is invalid_request", async () => {
    await assert.rejects(() => opApplyPatch({ patch: "" }, root), /^Error: \[invalid_request\]/);
  });

  await check("dry_run on a file to be created does not touch the disk", async () => {
    const d = data(await opApplyPatch({ patch: createFile("dry2/out.txt", ["x"]), dry_run: 1 }, root));
    assert.equal(d.dry_run, true);
    assert.equal((d.files as Array<Record<string, unknown>>)[0].action, "added");
    assert.equal(fs.existsSync(at("dry2")), false);
  });
} catch (error) {
  console.error("\n[test-apply-patch] FAILED:", error);
  process.exitCode = 1;
} finally {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch (error) {
    console.error("[test-apply-patch] cleanup failed:", error);
  }
}

console.log(`[test-apply-patch] ${checks} checks passed.`);
