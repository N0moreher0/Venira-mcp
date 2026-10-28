/**
 * Request tracing (VENIRA_TRACE=1).
 *
 *   VENIRA_TRACE=1                 log every tool call to stderr
 *   VENIRA_TRACE_FILE=<path>       also append to this file (rotates at 10 MB)
 *
 * The last MAX_TRACE_BUFFER entries are kept in memory so the
 * `project_trace_status` tool can report them without touching the disk.
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import path from "node:path";

const TRACE_ENABLED = ["1", "true", "on", "yes"].includes(
  (process.env.VENIRA_TRACE ?? "").toLowerCase(),
);
const TRACE_FILE_PATH = (process.env.VENIRA_TRACE_FILE ?? "").trim();
const TRACE_FILE_MAX_BYTES = 10 * 1024 * 1024;
const MAX_TRACE_BUFFER = 100;

export type TraceEntry = {
  timestamp: number;
  operation: string;
  duration_ms: number;
  ok: boolean;
  cached: boolean;
};

const entries: TraceEntry[] = [];

export function traceEnabled(): boolean {
  return TRACE_ENABLED;
}

export function traceFilePath(): string | null {
  return TRACE_FILE_PATH || null;
}

function writeTraceFile(line: string): void {
  if (!TRACE_FILE_PATH) return;
  try {
    const dir = path.dirname(TRACE_FILE_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    if (existsSync(TRACE_FILE_PATH) && statSync(TRACE_FILE_PATH).size > TRACE_FILE_MAX_BYTES) {
      let rotated = `${TRACE_FILE_PATH}.1`;
      let n = 1;
      while (existsSync(rotated)) rotated = `${TRACE_FILE_PATH}.${++n}`;
      renameSync(TRACE_FILE_PATH, rotated);
    }
    appendFileSync(TRACE_FILE_PATH, `${line}\n`);
  } catch (error) {
    process.stderr.write(
      `[venira-coding] trace file write failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}

/** Record one tool call. No-op unless VENIRA_TRACE is enabled. */
export function addTrace(entry: Omit<TraceEntry, "timestamp">): void {
  if (!TRACE_ENABLED) return;
  const record: TraceEntry = { timestamp: Date.now(), ...entry };
  entries.push(record);
  while (entries.length > MAX_TRACE_BUFFER) entries.shift();
  writeTraceFile(
    JSON.stringify({
      ts: new Date(record.timestamp).toISOString(),
      op: record.operation,
      ms: Math.round(record.duration_ms),
      ok: record.ok,
      cached: record.cached,
    }),
  );
}

/** Most recent traces, newest last (for project_trace_status). */
export function recentTraces(limit = 20): TraceEntry[] {
  const n = Math.max(1, Math.min(MAX_TRACE_BUFFER, limit));
  return entries.slice(-n);
}

export function traceSnapshot() {
  return {
    enabled: TRACE_ENABLED,
    file: TRACE_FILE_PATH || null,
    file_max_bytes: TRACE_FILE_MAX_BYTES,
    buffered: entries.length,
    buffer_max: MAX_TRACE_BUFFER,
  };
}
