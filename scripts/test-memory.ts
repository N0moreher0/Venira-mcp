// Tests for the `memory` tool: one overwrite-only handoff note per workspace.
import "./clean-env.js"; // must stay first: inherited VENIRA_* env would change the roots under test
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "venira-memory-ws-"));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "venira-memory-data-"));
process.env.VENIRA_WORKSPACE = workspaceDir;
process.env.VENIRA_DATA_DIR = dataDir;
// Compact mode trims payloads over 8 KiB for most tools; the memory note (cap 10 KB) must still read back whole.
process.env.VENIRA_OUTPUT_MODE = "compact";

const { MEMORY_MAX_BYTES, memoryFilePath, legacyMemoryFilePath, runMemory } = await import("../tools/project-memory.js");

let n = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  n += 1;
  if (ok) {
    console.log(`ok ${n} - ${name}`);
  } else {
    failed += 1;
    console.log(`not ok ${n} - ${name}`);
    if (detail !== undefined) console.log(`  detail: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
  }
}

type Envelope = { ok?: boolean; data?: Record<string, unknown>; error?: { code?: string; message?: string }; hint?: string };
async function call(args: Record<string, unknown>): Promise<{ env: Envelope; isError: boolean }> {
  const result = await runMemory(args);
  return { env: JSON.parse(result.content[0]?.text ?? "{}") as Envelope, isError: result.isError === true };
}

try {
  const file = memoryFilePath();
  check("note lives at <workspace>/.venira/memory.md", file === path.join(workspaceDir, ".venira", "memory.md"), file);

  // read before any write
  const empty = await call({ action: "read" });
  check("read with no note: ok, exists=false, empty content", empty.env.ok === true && empty.env.data?.exists === false && empty.env.data?.content === "", empty.env);
  check("read with no note: hint tells the AI what to do", typeof empty.env.hint === "string" && empty.env.hint.length > 0, empty.env);
  check("read with no note: version is \"new\"", empty.env.data?.version === "new", empty.env);

  // first write
  const first = "## Goal\nMove the memory note into the workspace\n\n## Next\n- run test:memory\n";
  const w1 = await call({ action: "write", content: first });
  check("first write: ok, replaced=false", w1.env.ok === true && w1.env.data?.replaced === false && w1.env.data?.previous_bytes === 0, w1.env);
  check("first write: reports bytes, updated_at_ms and path", w1.env.data?.bytes === Buffer.byteLength(first) && Number(w1.env.data?.updated_at_ms) > 1_000_000_000_000 && w1.env.data?.path === file, w1.env);
  check("first write: the file is on disk in the workspace", fs.readFileSync(file, "utf8") === first, file);

  const legacyFile = legacyMemoryFilePath();
  check("a workspace write never creates the legacy data-dir note", !fs.existsSync(legacyFile), legacyFile);

  const r1 = await call({ action: "read" });
  check("read returns exactly what was written", r1.env.ok === true && r1.env.data?.exists === true && r1.env.data?.content === first && r1.env.data?.path === file, r1.env);

  // overwrite (not append), multi-byte text survives
  const second = "## Mục tiêu\nĐã xong tool memory — còn viết test.\n";
  const w2 = await call({ action: "write", content: second });
  check("second write: replaced=true with previous_bytes", w2.env.ok === true && w2.env.data?.replaced === true && w2.env.data?.previous_bytes === Buffer.byteLength(first), w2.env);
  const r2 = await call({ action: "read" });
  check("overwrite: only the new note remains (no append)", r2.env.data?.content === second, r2.env);
  check("overwrite: bytes counts UTF-8 bytes, not characters", r2.env.data?.bytes === Buffer.byteLength(second) && Buffer.byteLength(second) > second.length, r2.env);

  // refused writes keep the old note
  const tooBig = await call({ action: "write", content: "x".repeat(MEMORY_MAX_BYTES + 1) });
  check("over the cap: error, isError set", tooBig.isError && tooBig.env.ok === false, tooBig.env);
  const atCap = await call({ action: "write", content: "y".repeat(MEMORY_MAX_BYTES) });
  check("exactly at the cap is accepted", atCap.env.ok === true && atCap.env.data?.bytes === MEMORY_MAX_BYTES, atCap.env);
  check("cap is 10000 bytes", MEMORY_MAX_BYTES === 10_000, MEMORY_MAX_BYTES);
  const readCap = await call({ action: "read" });
  check(
    "compact mode: a note at the cap (above 8 KiB) reads back whole, not trimmed",
    readCap.env.ok === true &&
      readCap.env.data?.content === "y".repeat(MEMORY_MAX_BYTES) &&
      (readCap.env as { trimmed?: boolean }).trimmed !== true,
    { trimmed: (readCap.env as { trimmed?: boolean }).trimmed, length: String(readCap.env.data?.content ?? "").length },
  );
  await call({ action: "write", content: second });

  const empties = [await call({ action: "write", content: "" }), await call({ action: "write", content: "  \n " }), await call({ action: "write" })];
  check("empty or missing content: error", empties.every((r) => r.isError && r.env.ok === false), empties.map((r) => r.env));

  const badAction = await call({ action: "append", content: "z" });
  check("unknown action: error", badAction.isError && badAction.env.ok === false, badAction.env);

  const still = await call({ action: "read" });
  check("refused writes left the previous note untouched", still.env.data?.content === second, still.env);

  // optimistic lock: if_version
  const vRead = await call({ action: "read" });
  const v0 = String(vRead.env.data?.version ?? "");
  check("read returns a 12-hex version", /^[0-9a-f]{12}$/.test(v0), vRead.env);
  check("version is stable for the same content", String((await call({ action: "read" })).env.data?.version) === v0, v0);
  const third = "## Third\nwritten with the right version\n";
  const wv = await call({ action: "write", content: third, if_version: v0 });
  check(
    "write with the current if_version: ok, returns a new version, no hint",
    wv.env.ok === true && wv.env.data?.replaced === true && typeof wv.env.data?.version === "string" && wv.env.data.version !== v0 && wv.env.hint === undefined,
    wv.env,
  );
  const vAfter = String((await call({ action: "read" })).env.data?.version);
  check("the version a write returns equals the next read's version", wv.env.data?.version === vAfter, { returned: wv.env.data?.version, read: vAfter });
  const stale = await call({ action: "write", content: "stale overwrite\n", if_version: v0 });
  check(
    "stale if_version: conflict, isError, current version named",
    stale.isError && stale.env.ok === false && stale.env.error?.code === "conflict" && String(stale.env.error?.message).includes(vAfter),
    stale.env,
  );
  check("stale if_version: nothing was written", (await call({ action: "read" })).env.data?.content === third);
  const chained = await call({ action: "write", content: second, if_version: String(wv.env.data?.version) });
  check("chained write with the version the last write returned: ok", chained.env.ok === true, chained.env);
  const plain = await call({ action: "write", content: second });
  check(
    "no if_version on an existing note: still overwrites, with a hint",
    plain.env.ok === true && typeof plain.env.hint === "string" && plain.env.hint.includes("if_version"),
    plain.env,
  );
  const badType = await call({ action: "write", content: "x", if_version: 5 });
  check("if_version of the wrong type: error", badType.isError && badType.env.ok === false, badType.env);
  check("a refused if_version write left the note untouched", (await call({ action: "read" })).env.data?.content === second);

  // legacy note is honoured as a fallback and survives a workspace write
  fs.rmSync(path.join(workspaceDir, ".venira"), { recursive: true, force: true });
  fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
  const legacyNote = "legacy note from the data dir\n";
  fs.writeFileSync(legacyFile, legacyNote);
  const r3 = await call({ action: "read" });
  check("legacy fallback: read returns the legacy note, flagged as legacy", r3.env.ok === true && r3.env.data?.exists === true && r3.env.data?.content === legacyNote && r3.env.data?.legacy === true && r3.env.data?.path === legacyFile, r3.env);
  check("legacy fallback: hint says where the note will go", typeof r3.env.hint === "string" && r3.env.hint.includes("<workspace>/.venira/memory.md"), r3.env);
  const w3 = await call({ action: "write", content: "fresh workspace note\n" });
  check("write moves the note into the workspace path", w3.env.data?.path === path.join(workspaceDir, ".venira", "memory.md") && fs.readFileSync(w3.env.data?.path as string, "utf8") === "fresh workspace note\n", w3.env);
  check("a workspace write never deletes the legacy note", fs.readFileSync(legacyFile, "utf8") === legacyNote, legacyFile);
  const r4 = await call({ action: "read" });
  check("after the move, read serves the workspace note, not the legacy one", r4.env.data?.content === "fresh workspace note\n" && r4.env.data?.legacy === undefined, r4.env);

  // if_version="new" is only valid while no note exists
  fs.rmSync(path.join(workspaceDir, ".venira"), { recursive: true, force: true });
  fs.rmSync(legacyFile, { force: true });
  const wNew = await call({ action: "write", content: "created with new\n", if_version: "new" });
  check("if_version=new with no note: ok, replaced=false, no hint", wNew.env.ok === true && wNew.env.data?.replaced === false && wNew.env.hint === undefined, wNew.env);
  const wNew2 = await call({ action: "write", content: "again\n", if_version: "new" });
  check("if_version=new on an existing note: conflict", wNew2.isError && wNew2.env.error?.code === "conflict", wNew2.env);

  // atomic write leaves nothing behind
  const leftovers = fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith(".tmp"));
  check("no .tmp files left behind", leftovers.length === 0, leftovers);

  assert.ok(fs.existsSync(workspaceDir));
} finally {
  fs.rmSync(workspaceDir, { recursive: true, force: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
}

console.log(`\n${n - failed}/${n} passed`);
process.exit(failed === 0 ? 0 : 1);
