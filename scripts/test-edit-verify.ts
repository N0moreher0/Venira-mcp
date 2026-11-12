/**
 * Phase 1 of ROADMAP_TOOL_SCHEMA.md: edit verification is derived from expected_sha256.
 *
 * Pins the behavior that replaced the advertised `guard: "sha256"` flag:
 *   1. No expected_sha256            -> edit applies, no `verified` field.
 *   2. expected_sha256 matches       -> edit applies, result is re-read and `verified` is true.
 *   3. expected_sha256 is stale      -> refused with stale_content, file untouched.
 *   4. legacy `guard: "sha256"`      -> refused with [unsupported] (removed in phase 5), file untouched.
 *   5. legacy `old_text_fuzzy`       -> ignored, never changes the edit.
 *   6. roadmap item 17: the read -> edit round trip works. project_read_file
 *      reports the whole-file hash (never the hash of the returned slice), a
 *      range read reports it too, a BOM file round-trips, sha256_after can be
 *      fed back, and a stale hash is refused with an explicit fresh-read
 *      instruction while the file stays untouched.
 *
 * Run with: npm run test:edit-verify
 */
import "./clean-env.js"; // must stay first: inherited VENIRA_* env would change behavior
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { opEditFile, opWriteFile } from "../lib/corehost-filewrite.js";
import { opReadFile } from "../lib/corehost-fileread.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "venira-edit-verify-"));
const sha = (text: string) => crypto.createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
const data = (res: unknown) => (res as { result: { data: Record<string, unknown> } }).result.data;

let checks = 0;
async function check(name: string, fn: () => Promise<void>) {
  await fn();
  checks += 1;
  console.log(`ok - ${name}`);
}

try {
  await check("no expected_sha256: edit applies without verified", async () => {
    fs.writeFileSync(path.join(root, "a.txt"), "alpha beta\n");
    const d = data(await opEditFile({ relative_path: "a.txt", old_text: "alpha", new_text: "ALPHA" }, root));
    assert.equal(d.replacements, 1);
    assert.equal(d.verified, undefined);
    assert.equal(fs.readFileSync(path.join(root, "a.txt"), "utf8"), "ALPHA beta\n");
  });

  await check("matching expected_sha256: edit applies and is verified", async () => {
    const before = "one two\n";
    fs.writeFileSync(path.join(root, "b.txt"), before);
    const d = data(
      await opEditFile(
        { relative_path: "b.txt", old_text: "one", new_text: "1", expected_sha256: sha(before) },
        root,
      ),
    );
    assert.equal(d.verified, true);
    assert.equal(d.verified_sha256, d.sha256_after);
    assert.equal(d.sha256_after, sha("1 two\n"));
  });

  await check("stale expected_sha256: refused and file untouched", async () => {
    fs.writeFileSync(path.join(root, "c.txt"), "keep me\n");
    await assert.rejects(
      () =>
        opEditFile(
          { relative_path: "c.txt", old_text: "keep", new_text: "lose", expected_sha256: sha("something else") },
          root,
        ),
      /stale_content|expected_sha256/,
    );
    assert.equal(fs.readFileSync(path.join(root, "c.txt"), "utf8"), "keep me\n");
  });

  await check("removed guard=sha256 is refused and file untouched", async () => {
    fs.writeFileSync(path.join(root, "d.txt"), "x y\n");
    await assert.rejects(
      () => opEditFile({ relative_path: "d.txt", old_text: "x", new_text: "X", guard: "sha256" }, root),
      /guard was removed|\[unsupported\]/,
    );
    assert.equal(fs.readFileSync(path.join(root, "d.txt"), "utf8"), "x y\n");
  });

  await check("legacy old_text_fuzzy is ignored", async () => {
    fs.writeFileSync(path.join(root, "e.txt"), "real text\n");
    const d = data(
      await opEditFile(
        { relative_path: "e.txt", old_text: "real", new_text: "REAL", old_text_fuzzy: "completely different" },
        root,
      ),
    );
    assert.equal(d.replacements, 1);
    assert.equal(fs.readFileSync(path.join(root, "e.txt"), "utf8"), "REAL text\n");
  });

  // -------------------------------------------------------------------------
  // Roadmap item 17: the read -> edit round trip must not dead-lock.
  //
  // `expected_sha256` is only useful when the agent can get a hash it can
  // send back. project_read_file used to report the hash of the *returned
  // slice*, so a range read (or a truncated read) produced a hash that never
  // matched the file: every edit came back as stale_content and the agent
  // looped. The hash is now always the whole file.
  // -------------------------------------------------------------------------
  await check("read_file reports the whole-file hash and the edit accepts it", async () => {
    const content = "alpha\nbeta\ngamma\n";
    fs.writeFileSync(path.join(root, "round.txt"), content);
    const read = data(await opReadFile({ relative_path: "round.txt" }, root));
    assert.equal(read.sha256, sha(content), "sha256 is the hash of the whole file");
    assert.equal(read.sha256_scope, "file");
    assert.equal(read.text_sha256, sha(content), "text_sha256 covers the returned text");
    const d = data(
      await opEditFile(
        { relative_path: "round.txt", old_text: "beta", new_text: "BETA", expected_sha256: read.sha256 },
        root,
      ),
    );
    assert.equal(d.replacements, 1);
    assert.equal(d.verified, true);
  });

  await check("a range read still reports the whole-file hash", async () => {
    const content = "one\ntwo\nthree\nfour\n";
    fs.writeFileSync(path.join(root, "range.txt"), content);
    const read = data(
      await opReadFile({ relative_path: "range.txt", ranges: [{ start_line: 2, end_line: 3 }] }, root),
    );
    assert.equal(read.sha256, sha(content), "the hash is the file, not the slice");
    const ranges = read.ranges as Array<{ text: string; text_sha256: string }>;
    assert.equal(ranges[0].text_sha256, sha("two\nthree"));
    const d = data(
      await opEditFile(
        { relative_path: "range.txt", old_text: "three", new_text: "THREE", expected_sha256: read.sha256 },
        root,
      ),
    );
    assert.equal(d.replacements, 1);
  });

  await check("a file with a BOM round-trips (the hash covers the raw bytes)", async () => {
    const content = "\ufeffwith bom\n";
    fs.writeFileSync(path.join(root, "bom.txt"), content, "utf8");
    const read = data(await opReadFile({ relative_path: "bom.txt" }, root));
    assert.equal(read.sha256, sha(content));
    const d = data(
      await opEditFile(
        { relative_path: "bom.txt", old_text: "with bom", new_text: "with BOM", expected_sha256: read.sha256 },
        root,
      ),
    );
    assert.equal(d.replacements, 1);
    assert.equal(fs.readFileSync(path.join(root, "bom.txt"), "utf8"), "\ufeffwith BOM\n");
  });

  await check("sha256_after can be fed back into the next edit", async () => {
    fs.writeFileSync(path.join(root, "chain.txt"), "first\n");
    const first = data(await opEditFile({ relative_path: "chain.txt", old_text: "first", new_text: "second" }, root));
    const second = data(
      await opEditFile(
        { relative_path: "chain.txt", old_text: "second", new_text: "third", expected_sha256: first.sha256_after },
        root,
      ),
    );
    assert.equal(second.replacements, 1);
    assert.equal(second.verified, true);
    assert.equal(fs.readFileSync(path.join(root, "chain.txt"), "utf8"), "third\n");
  });

  await check("stale_content asks for a fresh read and leaves the file untouched", async () => {
    fs.writeFileSync(path.join(root, "fresh.txt"), "keep\n");
    const error = await opEditFile(
      { relative_path: "fresh.txt", old_text: "keep", new_text: "lose", expected_sha256: sha("something else") },
      root,
    ).then(
      () => null,
      (e: Error & { data?: Record<string, unknown> }) => e,
    );
    assert.ok(error, "the edit must be refused");
    assert.match(error?.message ?? "", /^\[stale_content\]/);
    assert.equal(
      /[^\x00-\x7F]/.test(error?.message ?? ""),
      false,
      "the message is English, like every other error",
    );
    assert.equal(error?.data?.fresh_read_required, true);
    assert.equal(error?.data?.next_action, "project_read_file");
    assert.equal(fs.readFileSync(path.join(root, "fresh.txt"), "utf8"), "keep\n", "the file must be untouched");
  });

  await check("write_file with a stale hash is refused the same way", async () => {
    fs.writeFileSync(path.join(root, "wf.txt"), "keep\n");
    const error = await opWriteFile(
      { relative_path: "wf.txt", content: "new\n", expected_sha256: sha("something else") },
      root,
    ).then(
      () => null,
      (e: Error & { data?: Record<string, unknown> }) => e,
    );
    assert.ok(error, "the write must be refused");
    assert.match(error?.message ?? "", /^\[stale_content\]/);
    assert.equal(error?.data?.fresh_read_required, true);
    assert.equal(fs.readFileSync(path.join(root, "wf.txt"), "utf8"), "keep\n", "the file must be untouched");
  });
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`[test-edit-verify] ${checks} checks passed.`);
