/**
 * Phase 1 of ROADMAP_TOOL_SCHEMA.md: edit verification is derived from expected_sha256.
 *
 * Pins the behavior that replaced the advertised `guard: "sha256"` flag:
 *   1. No expected_sha256            -> edit applies, no `verified` field.
 *   2. expected_sha256 matches       -> edit applies, result is re-read and `verified` is true.
 *   3. expected_sha256 is stale      -> refused with stale_content, file untouched.
 *   4. legacy `guard: "sha256"`      -> refused with [unsupported] (removed in phase 5), file untouched.
 *   5. legacy `old_text_fuzzy`       -> ignored, never changes the edit.
 *
 * Run with: npm run test:edit-verify
 */
import "./clean-env.js"; // must stay first: inherited VENIRA_* env would change behavior
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { opEditFile } from "../lib/corehost-filewrite.js";

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
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`[test-edit-verify] ${checks} checks passed.`);
