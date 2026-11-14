/**
 * Phase 1 of ROADMAP_TOOLS.md: move_path and copy_path (corehost ops move_path / copy_path).
 *
 * Pins:
 *   1. move: rename, move into a new directory (create_dirs defaults to 1), directories keep their contents.
 *   2. move/copy refuse an existing target without overwrite=1, and leave both sides untouched.
 *   3. overwrite=1 replaces a file with a file, never a directory.
 *   4. A directory cannot be moved or copied into itself; the workspace root cannot be the source.
 *   5. Missing source -> [not_found]; from == to -> [invalid_request]; create_dirs=0 with a missing parent -> [invalid_request].
 *   6. copy: a directory needs recursive=1, the source stays, entries/bytes are reported, symbolic links are skipped.
 *
 * Run with: npm run test:move-copy
 */
import "./clean-env.js"; // must stay first: inherited VENIRA_* env would change behavior
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { opCopyPath, opMovePath } from "../lib/corehost-filewrite.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "venira-move-copy-"));
const at = (rel: string) => path.join(root, rel);
const write = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(at(rel)), { recursive: true });
  fs.writeFileSync(at(rel), text);
};
const read = (rel: string) => fs.readFileSync(at(rel), "utf8");
const data = (res: unknown) => (res as { result: { data: Record<string, unknown> } }).result.data;

let checks = 0;
async function check(name: string, fn: () => Promise<void>) {
  await fn();
  checks += 1;
  console.log(`ok - ${name}`);
}

try {
  await check("move renames a file", async () => {
    write("a.txt", "alpha");
    const d = data(await opMovePath({ from: "a.txt", to: "b.txt" }, root));
    assert.equal(d.from, "a.txt");
    assert.equal(d.to, "b.txt");
    assert.equal(d.kind, "file");
    assert.equal(d.overwritten, false);
    assert.equal(fs.existsSync(at("a.txt")), false);
    assert.equal(read("b.txt"), "alpha");
  });

  await check("move into a missing directory creates it by default", async () => {
    write("c.txt", "gamma");
    await opMovePath({ from: "c.txt", to: "deep/er/c.txt" }, root);
    assert.equal(read("deep/er/c.txt"), "gamma");
  });

  await check("create_dirs=false with a missing parent is invalid_request and changes nothing", async () => {
    write("d.txt", "delta");
    await assert.rejects(() => opMovePath({ from: "d.txt", to: "nope/d.txt", create_dirs: false }, root), /^Error: \[invalid_request\]/);
    assert.equal(read("d.txt"), "delta");
    assert.equal(fs.existsSync(at("nope")), false);
  });

  await check("existing target without overwrite is a conflict and both files stay", async () => {
    write("e1.txt", "one");
    write("e2.txt", "two");
    await assert.rejects(() => opMovePath({ from: "e1.txt", to: "e2.txt" }, root), /^Error: \[conflict\]/);
    await assert.rejects(() => opCopyPath({ from: "e1.txt", to: "e2.txt" }, root), /^Error: \[conflict\]/);
    assert.equal(read("e1.txt"), "one");
    assert.equal(read("e2.txt"), "two");
  });

  await check("overwrite=true replaces a file with a file", async () => {
    write("f1.txt", "new");
    write("f2.txt", "old");
    const d = data(await opMovePath({ from: "f1.txt", to: "f2.txt", overwrite: true }, root));
    assert.equal(d.overwritten, true);
    assert.equal(read("f2.txt"), "new");
    assert.equal(fs.existsSync(at("f1.txt")), false);
    write("g1.txt", "copied");
    const c = data(await opCopyPath({ from: "g1.txt", to: "f2.txt", overwrite: true }, root));
    assert.equal(c.overwritten, true);
    assert.equal(read("f2.txt"), "copied");
    assert.equal(read("g1.txt"), "copied");
  });

  await check("overwrite never replaces a directory", async () => {
    write("h.txt", "file");
    write("hdir/inner.txt", "keep");
    await assert.rejects(() => opMovePath({ from: "h.txt", to: "hdir", overwrite: true }, root), /^Error: \[conflict\]/);
    assert.equal(read("hdir/inner.txt"), "keep");
    assert.equal(read("h.txt"), "file");
  });

  await check("move keeps a directory's contents", async () => {
    write("src/one.txt", "1");
    write("src/sub/two.txt", "22");
    const d = data(await opMovePath({ from: "src", to: "moved" }, root));
    assert.equal(d.kind, "directory");
    assert.equal(d.bytes, 3);
    assert.equal(fs.existsSync(at("src")), false);
    assert.equal(read("moved/one.txt"), "1");
    assert.equal(read("moved/sub/two.txt"), "22");
  });

  await check("a directory cannot go into itself", async () => {
    write("self/x.txt", "x");
    await assert.rejects(() => opMovePath({ from: "self", to: "self/inner" }, root), /^Error: \[invalid_request\].*into itself/);
    await assert.rejects(
      () => opCopyPath({ from: "self", to: "self/inner", recursive: true }, root),
      /^Error: \[invalid_request\].*into itself/,
    );
    assert.equal(read("self/x.txt"), "x");
    assert.equal(fs.existsSync(at("self/inner")), false);
  });

  await check("the workspace root cannot be the source", async () => {
    await assert.rejects(() => opMovePath({ from: ".", to: "elsewhere" }, root), /^Error: \[invalid_request\].*workspace root/);
    await assert.rejects(() => opCopyPath({ from: ".", to: "elsewhere", recursive: true }, root), /^Error: \[invalid_request\].*workspace root/);
  });

  await check("paths outside the workspace are refused", async () => {
    write("in.txt", "in");
    await assert.rejects(() => opMovePath({ from: "in.txt", to: "../outside.txt" }, root));
    await assert.rejects(() => opCopyPath({ from: "../outside.txt", to: "in2.txt" }, root));
    assert.equal(read("in.txt"), "in");
  });

  await check("missing source is not_found; same path is invalid_request; missing arguments are invalid_request", async () => {
    await assert.rejects(() => opMovePath({ from: "ghost.txt", to: "x.txt" }, root), /^Error: \[not_found\]/);
    await assert.rejects(() => opCopyPath({ from: "ghost.txt", to: "x.txt" }, root), /^Error: \[not_found\]/);
    write("same.txt", "s");
    await assert.rejects(() => opMovePath({ from: "same.txt", to: "same.txt" }, root), /^Error: \[invalid_request\]/);
    await assert.rejects(() => opMovePath({ from: "same.txt" }, root), /^Error: \[invalid_request\]/);
    await assert.rejects(() => opCopyPath({ to: "x.txt" }, root), /^Error: \[invalid_request\]/);
  });

  await check("copy keeps the source and reports size", async () => {
    write("k.txt", "kappa");
    const d = data(await opCopyPath({ from: "k.txt", to: "out/k2.txt" }, root));
    assert.equal(d.kind, "file");
    assert.equal(d.bytes, 5);
    assert.equal(read("k.txt"), "kappa");
    assert.equal(read("out/k2.txt"), "kappa");
  });

  await check("copying a directory needs recursive=1", async () => {
    write("tree/a.txt", "a");
    write("tree/sub/b.txt", "bb");
    await assert.rejects(() => opCopyPath({ from: "tree", to: "tree2" }, root), /^Error: \[invalid_request\].*recursive/);
    assert.equal(fs.existsSync(at("tree2")), false);
    const d = data(await opCopyPath({ from: "tree", to: "tree2", recursive: true }, root));
    assert.equal(d.kind, "directory");
    assert.equal(d.bytes, 3);
    assert.equal(d.entries, 4, "two files, one sub directory and the directory itself");
    assert.equal(read("tree/sub/b.txt"), "bb");
    assert.equal(read("tree2/sub/b.txt"), "bb");
  });

  await check("copy skips symbolic links inside a directory", async () => {
    write("links/real.txt", "r");
    let linked = true;
    try {
      fs.symlinkSync(at("links/real.txt"), at("links/alias.txt"), "file");
    } catch {
      linked = false; // creating symlinks needs a privilege on some Windows setups
    }
    const d = data(await opCopyPath({ from: "links", to: "links2", recursive: true }, root));
    assert.equal(read("links2/real.txt"), "r");
    if (linked) {
      assert.equal(d.skipped_symlinks, 1);
      assert.equal(fs.existsSync(at("links2/alias.txt")), false);
    }
  });

  if (process.platform === "win32") {
    await check("move can change only the letter case of a name on a case-insensitive file system", async () => {
      write("CaseName.txt", "c");
      await opMovePath({ from: "CaseName.txt", to: "casename.txt" }, root);
      assert.ok(fs.readdirSync(root).includes("casename.txt"));
      await assert.rejects(() => opCopyPath({ from: "casename.txt", to: "CASENAME.txt" }, root), /^Error: \[invalid_request\]/);
    });
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`[test-move-copy] ${checks} checks passed.`);
