import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { recordMetric } from "../lib/metrics.js";
import { buildEnvelope, errorEnvelope, newRequestId, toolResult } from "../lib/output.js";
import type { RustResponse, ToolResult } from "../lib/output.js";
import { WORKSPACE, activeDataDir } from "../lib/workspace.js";
import type { Args } from "./project-cache.js";

// `memory` tool: one handoff note per workspace that outlives the chat. The AI that is about to run out of
// context (or finish) overwrites it; the next AI reads it first. Plain markdown on disk AT THE WORKSPACE
// ROOT (<workspace>/.venira/memory.md), so the note travels with the project — and a human can open or edit it too.
// Not audit-logged and not encrypted: never put secrets in it.

/**
 * Hard cap on the note, in bytes. Deliberately small: a handoff is a summary (goal, decisions, files, next
 * steps), and a read must come back whole even in VENIRA_OUTPUT_MODE=compact, which trims payloads over 8 KiB.
 */
export const MEMORY_MAX_BYTES = 6_000;

/** The note: `<workspace>/.venira/memory.md` (follows `switch_workspace`). */
export function memoryFilePath(): string {
  return path.join(path.resolve(WORKSPACE), ".venira", "memory.md");
}

/**
 * Legacy location (pre-4.4.0): `<data dir>/memory/<workspace name>-<hash of its absolute path>.md`.
 * Still read as a fallback so existing notes are not lost; never written anymore.
 */
export function legacyMemoryFilePath(): string {
  const root = path.resolve(WORKSPACE);
  const key = process.platform === "win32" ? root.toLowerCase() : root;
  const slug = path.basename(root).replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 40) || "workspace";
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 12);
  return path.join(activeDataDir(), "memory", `${slug}-${hash}.md`);
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

type Note = { content: string; bytes: number; updated_at_ms: number };

async function tryRead(file: string): Promise<Note | null> {
  try {
    const [content, stat] = await Promise.all([fs.readFile(file, "utf8"), fs.stat(file)]);
    return { content, bytes: Buffer.byteLength(content, "utf8"), updated_at_ms: Math.round(stat.mtimeMs) };
  } catch (error) {
    if (!isNotFound(error)) throw error;
    return null;
  }
}

async function readMemory(): Promise<{ data: Record<string, unknown>; hint?: string }> {
  const file = memoryFilePath();
  const local = await tryRead(file);
  if (local) {
    return { data: { exists: true, ...local, path: file } };
  }
  const legacy = await tryRead(legacyMemoryFilePath());
  if (legacy) {
    return {
      data: { exists: true, ...legacy, path: legacyMemoryFilePath(), legacy: true },
      hint: "This note lives in the legacy data-dir location. The next write moves it into <workspace>/.venira/memory.md.",
    };
  }
  return {
    data: { exists: false, content: "", bytes: 0, path: file },
    hint: "No saved context for this workspace yet. Start the task normally and write a note before you finish.",
  };
}

async function writeMemory(content: unknown): Promise<{ data: Record<string, unknown> }> {
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new Error(
      "[invalid_request] memory: action=write needs a non-empty `content`. " +
        "Hint: write the full note (goal, decisions, files touched, next steps); it replaces the previous one.",
    );
  }
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MEMORY_MAX_BYTES) {
    throw new Error(
      `[invalid_request] memory: content is ${bytes} bytes, over the ${MEMORY_MAX_BYTES} byte cap. ` +
        "Hint: condense it and drop what is stale; write replaces the whole note, so nothing is lost by cutting.",
    );
  }
  const file = memoryFilePath();
  let previousBytes = 0;
  let replaced = false;
  try {
    previousBytes = (await fs.stat(file)).size;
    replaced = true;
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  // Atomic replace: a reader never sees a half-written note, and a crash leaves the old one intact.
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(tmp, content, "utf8");
    await fs.rename(tmp, file);
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
  const stat = await fs.stat(file);
  return {
    data: { replaced, previous_bytes: previousBytes, bytes, updated_at_ms: Math.round(stat.mtimeMs), path: file },
  };
}

export async function runMemory(args: Args): Promise<ToolResult> {
  const started = performance.now();
  const requestId = newRequestId();
  const elapsed = () => performance.now() - started;
  try {
    let outcome: { data: Record<string, unknown>; hint?: string };
    if (args.action === "read") outcome = await readMemory();
    else if (args.action === "write") outcome = await writeMemory(args.content);
    else {
      throw new Error(
        '[invalid_request] memory: action must be "read" or "write". ' +
          "Hint: read at the start of a task, write (full overwrite) before you finish or run out of context.",
      );
    }
    const elapsedMs = elapsed();
    recordMetric("memory", elapsedMs, true);
    const response: RustResponse = {
      status: "completed",
      result: { kind: "memory", data: outcome.data },
      truncated: false,
      ...(outcome.hint ? { hint: outcome.hint } : {}),
    };
    return toolResult(
      buildEnvelope("memory", response, {
        requestId,
        elapsedMs,
        cached: false,
        ...(outcome.hint ? { hint: outcome.hint } : {}),
      }),
    );
  } catch (error) {
    const elapsedMs = elapsed();
    recordMetric("memory", elapsedMs, false);
    return toolResult(errorEnvelope("memory", error, { requestId, elapsedMs }), true);
  }
}
