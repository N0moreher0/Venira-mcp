// Tests for the `memory` tool: one overwrite-only handoff note per workspace.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MEMORY_MAX_BYTES, memoryFilePath, runMemory } from "../tools/project-memory.js";

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

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "venira-memory-"));
process.env.VENIRA_DATA_DIR = dataDir;

try {
  const file = memoryFilePath();
  check("note lives under <data dir>/memory/", file.startsWith(path.join(dataDir, "memory") + path.sep) && file.endsWith(".md"), file);

  // read before any write
  const empty = await call({ action: "read" });
  check("read with no note: ok, exists=false, empty content", empty.env.ok === true && empty.env.data?.exists === false && empty.env.data?.content === "", empty.env);
  check("read with no note: hint tells the AI what to do", typeof empty.env.hint === "string" && empty.env.hint.length > 0, empty.env);

  // first write
  const first = "## Goal\nAdd the memory tool\n\n## Next\n- run test:memory\n";
  const w1 = await call({ action: "write", content: first });
  check("first write: ok, replaced=false", w1.env.ok === true && w1.env.data?.replaced === false && w1.env.data?.previous_bytes === 0, w1.env);
  check("first write: reports bytes and updated_at_ms", w1.env.data?.bytes === Buffer.byteLength(first) && Number(w1.env.data?.updated_at_ms) > 1_000_000_000_000, w1.env);

  const r1 = await call({ action: "read" });
  check("read returns exactly what was written", r1.env.ok === true && r1.env.data?.exists === true && r1.env.data?.content === first, r1.env);

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
  await call({ action: "write", content: second });

  const empties = [await call({ action: "write", content: "" }), await call({ action: "write", content: "  \n " }), await call({ action: "write" })];
  check("empty or missing content: error", empties.every((r) => r.isError && r.env.ok === false), empties.map((r) => r.env));

  const badAction = await call({ action: "append", content: "z" });
  check("unknown action: error", badAction.isError && badAction.env.ok === false, badAction.env);

  const still = await call({ action: "read" });
  check("refused writes left the previous note untouched", still.env.data?.content === second, still.env);

  // atomic write leaves nothing behind
  const leftovers = fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith(".tmp"));
  check("no .tmp files left behind", leftovers.length === 0, leftovers);
} finally {
  fs.rmSync(dataDir, { recursive: true, force: true });
}

console.log(`\n${n - failed}/${n} passed`);
process.exit(failed === 0 ? 0 : 1);
