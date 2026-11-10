/**
 * Phase 3 of ROADMAP_TOOL_SCHEMA.md: the fuzzy edit options depend on VENIRA_EDIT_FUZZY.
 *
 * The schema half (options advertised only when the variable is 1) is pinned in test-tool-schema.ts.
 * This test pins the handler half:
 *   1. fuzzy off + fuzzy option sent   -> refused with [unsupported] naming VENIRA_EDIT_FUZZY=1; file untouched.
 *   2. every offending option is named (not just the first).
 *   3. explicit 0/false asks for nothing -> plain exact edit, no error.
 *   4. fuzzy on                        -> exact edits unchanged, a fuzzy edit with case_insensitive applies.
 *   5. fuzzyEditArgsUsed()             -> truthiness rules (true, 1, "1"; fuzzy_distance whenever present).
 *
 * Run with: npm run test:edit-fuzzy-gate
 */
import "./clean-env.js"; // must stay first: inherited VENIRA_* env would change behavior
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fuzzyEditArgsUsed } from "../lib/arg-hints.js";
import { opEditFile } from "../lib/corehost-filewrite.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "venira-edit-fuzzy-gate-"));
const read = (name: string) => fs.readFileSync(path.join(root, name), "utf8");
const data = (res: unknown) => (res as { result: { data: Record<string, unknown> } }).result.data;

/** Run `fn` with VENIRA_EDIT_FUZZY set to `value` (undefined = unset), then restore it. */
async function withFuzzy(value: "0" | "1" | undefined, fn: () => Promise<void>) {
  const saved = process.env.VENIRA_EDIT_FUZZY;
  if (value === undefined) delete process.env.VENIRA_EDIT_FUZZY;
  else process.env.VENIRA_EDIT_FUZZY = value;
  try {
    await fn();
  } finally {
    if (saved === undefined) delete process.env.VENIRA_EDIT_FUZZY;
    else process.env.VENIRA_EDIT_FUZZY = saved;
  }
}

let checks = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  await fn();
  checks += 1;
  console.log(`ok - ${name}`);
}

try {
  await check("fuzzy off: case_insensitive is refused and names VENIRA_EDIT_FUZZY=1", () =>
    withFuzzy(undefined, async () => {
      fs.writeFileSync(path.join(root, "a.txt"), "hello world\n");
      await assert.rejects(
        () => opEditFile({ relative_path: "a.txt", old_text: "HELLO", new_text: "HOWDY", case_insensitive: true }, root),
        /\[unsupported\].*case_insensitive.*VENIRA_EDIT_FUZZY=1/,
      );
      assert.equal(read("a.txt"), "hello world\n");
    }),
  );

  await check("fuzzy off: fuzzy_distance and a raw 1 (edit_batch item) are refused too", () =>
    withFuzzy("0", async () => {
      fs.writeFileSync(path.join(root, "b.txt"), "alpha\n");
      await assert.rejects(
        () => opEditFile({ relative_path: "b.txt", old_text: "alpha", new_text: "A", fuzzy_distance: 2 }, root),
        /fuzzy_distance.*VENIRA_EDIT_FUZZY=1/,
      );
      await assert.rejects(
        () => opEditFile({ relative_path: "b.txt", old_text: "alpha", new_text: "A", ignore_indentation: 1 }, root),
        /ignore_indentation.*VENIRA_EDIT_FUZZY=1/,
      );
      assert.equal(read("b.txt"), "alpha\n");
    }),
  );

  await check("fuzzy off: every offending option is named", () =>
    withFuzzy("0", async () => {
      fs.writeFileSync(path.join(root, "c.txt"), "x\n");
      await assert.rejects(
        () =>
          opEditFile(
            { relative_path: "c.txt", old_text: "x", new_text: "y", fuzzy_distance: 1, ignore_indentation: true, case_insensitive: true },
            root,
          ),
        (error: unknown) => {
          const message = String((error as Error).message);
          return ["fuzzy_distance", "ignore_indentation", "case_insensitive"].every((key) => message.includes(key));
        },
      );
    }),
  );

  await check("fuzzy off: explicit 0/false asks for nothing, exact edit applies", () =>
    withFuzzy(undefined, async () => {
      fs.writeFileSync(path.join(root, "d.txt"), "keep me\n");
      const d = data(
        await opEditFile(
          { relative_path: "d.txt", old_text: "keep", new_text: "KEEP", ignore_indentation: false, case_insensitive: 0 },
          root,
        ),
      );
      assert.equal(d.replacements, 1);
      assert.equal(read("d.txt"), "KEEP me\n");
    }),
  );

  await check("fuzzy on: an exact edit with fuzzy options present is unchanged", () =>
    withFuzzy("1", async () => {
      fs.writeFileSync(path.join(root, "e.txt"), "one two\n");
      const d = data(
        await opEditFile(
          { relative_path: "e.txt", old_text: "one", new_text: "1", case_insensitive: true, fuzzy_distance: 2 },
          root,
        ),
      );
      assert.equal(d.replacements, 1);
      assert.equal(read("e.txt"), "1 two\n");
    }),
  );

  await check("fuzzy on: case_insensitive finds the near match and applies the edit", () =>
    withFuzzy("1", async () => {
      fs.writeFileSync(path.join(root, "f.txt"), "hello world\n");
      const d = data(
        await opEditFile({ relative_path: "f.txt", old_text: "HELLO", new_text: "HOWDY", case_insensitive: true }, root),
      );
      assert.equal(d.replacements, 1);
      assert.equal(read("f.txt"), "HOWDY world\n");
    }),
  );

  await check("fuzzy on: without the option the same edit still fails as not found", () =>
    withFuzzy("1", async () => {
      fs.writeFileSync(path.join(root, "g.txt"), "hello world\n");
      await assert.rejects(
        () => opEditFile({ relative_path: "g.txt", old_text: "HELLO", new_text: "HOWDY", fuzzy_distance: 0 }, root),
        /old_text_not_found|old_text not found/,
      );
      assert.equal(read("g.txt"), "hello world\n");
    }),
  );

  await check("fuzzyEditArgsUsed: truthiness rules", () => {
    assert.deepEqual(fuzzyEditArgsUsed({}), []);
    assert.deepEqual(fuzzyEditArgsUsed({ fuzzy_distance: 3 }), ["fuzzy_distance"]);
    assert.deepEqual(fuzzyEditArgsUsed({ fuzzy_distance: 0 }), ["fuzzy_distance"]);
    assert.deepEqual(fuzzyEditArgsUsed({ fuzzy_distance: null }), []);
    assert.deepEqual(fuzzyEditArgsUsed({ ignore_indentation: 0, case_insensitive: false }), []);
    assert.deepEqual(fuzzyEditArgsUsed({ ignore_indentation: 1, case_insensitive: true }), ["ignore_indentation", "case_insensitive"]);
    assert.deepEqual(fuzzyEditArgsUsed({ ignore_indentation: "1" }), ["ignore_indentation"]);
  });
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`[test-edit-fuzzy-gate] ${checks} checks passed.`);
