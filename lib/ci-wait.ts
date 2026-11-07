/**
 * `project_ci_wait`: one bounded long-poll instead of a polling loop.
 *
 * MCP over stdio cannot push a notification that wakes the model, so this is
 * deliberately a *long-poll*: the tool blocks until the run reaches a terminal
 * state, the state changes (`until: "any_change"`), or `timeout_ms` elapses.
 * No background timer, no standing network traffic.
 */
import { opCiLogs, opCiStatus } from "./git-provider.js";
import type { Resp } from "./git-common.js";

const TERMINAL = new Set(["success", "failure", "cancelled", "skipped", "timed_out"]);
const DEFAULT_TIMEOUT_MS = 45_000;
const MAX_TIMEOUT_MS = 110_000;
const DEFAULT_INTERVAL_MS = 5_000;
const MIN_INTERVAL_MS = 2_000;
const MAX_INTERVAL_MS = 15_000;
const DEFAULT_TAIL_LINES = 80;
const FAILURE_CONCLUSIONS = new Set([
  "failure",
  "failed",
  "timed_out",
  "cancelled",
  "canceled",
  "startup_failure",
  "action_required",
  "error",
]);

/** Concurrent waiters on the same selector share one in-flight API read. */
const inflight = new Map<string, Promise<Resp>>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function stableKey(value: Record<string, unknown>): string {
  return JSON.stringify(
    Object.keys(value)
      .sort()
      .map((key) => [key, value[key]]),
  );
}

function selectorArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ["repo", "provider", "run_id", "ref", "pr", "branch", "workflow"]) {
    const value = args[key];
    if (value === undefined || value === null) continue;
    if (typeof value === "string" && value.trim() === "") continue;
    out[key] = value;
  }
  return out;
}

function selectorCount(args: Record<string, unknown>): number {
  let count = 0;
  if (args.run_id !== undefined && args.run_id !== null && String(args.run_id).trim() !== "") count += 1;
  if (typeof args.ref === "string" && args.ref.trim() !== "") count += 1;
  if (args.pr !== undefined && args.pr !== null && String(args.pr).trim() !== "") count += 1;
  if (typeof args.branch === "string" && args.branch.trim() !== "") count += 1;
  return count;
}

async function pollStatus(args: Record<string, unknown>): Promise<{ response: Resp; data: Record<string, any> }> {
  const key = stableKey(args);
  let promise = inflight.get(key);
  if (!promise) {
    promise = opCiStatus(args).finally(() => {
      inflight.delete(key);
    });
    inflight.set(key, promise);
  }
  const response = await promise;
  const data = (response.result?.data ?? {}) as Record<string, any>;
  return { response, data };
}

function overallOf(data: Record<string, any>): string {
  return typeof data.overall === "string" ? data.overall : "unknown";
}

function summarizeRun(data: Record<string, any>): Record<string, unknown> | null {
  if (data.run && typeof data.run === "object") return data.run as Record<string, unknown>;
  if (Array.isArray(data.runs) && data.runs.length > 0) return data.runs[0] as Record<string, unknown>;
  if (Array.isArray(data.check_runs) && data.check_runs.length > 0) {
    const check = data.check_runs[0] as Record<string, unknown>;
    return {
      id: check.id ?? null,
      name: check.name ?? null,
      status: check.status ?? null,
      conclusion: check.conclusion ?? null,
      url: check.url ?? null,
    };
  }
  return null;
}

/** Numeric job ids (GitHub/GitLab) stay numbers; Bitbucket step UUIDs ("{...}") stay strings. */
function normalizeJobId(value: unknown): number | string | undefined {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
  if (typeof value !== "string") return undefined;
  const raw = value.trim();
  if (!raw) return undefined;
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    return Number.isSafeInteger(n) && n > 0 ? n : undefined;
  }
  return raw;
}

function failingJobs(data: Record<string, any>): Array<{ id: number | string; name: string | null }> {
  if (!Array.isArray(data.jobs)) return [];
  const out: Array<{ id: number | string; name: string | null }> = [];
  for (const job of data.jobs as Array<Record<string, unknown>>) {
    if (!FAILURE_CONCLUSIONS.has(String(job.conclusion))) continue;
    const id = normalizeJobId(job.id);
    if (id === undefined) continue;
    out.push({ id, name: typeof job.name === "string" ? job.name : null });
  }
  return out;
}

function failingJobId(data: Record<string, any>): number | string | undefined {
  return failingJobs(data)[0]?.id;
}

/** One concise line an agent can act on without reading the full status payload. */
function buildSummary(input: {
  overall: string;
  terminal: boolean;
  run: Record<string, unknown> | null;
  failed: Array<{ id: number | string; name: string | null }>;
  jobsTotal?: number;
  waitedMs: number;
  hasTail: boolean;
}): string {
  const label = input.run?.name ? String(input.run.name) : "CI";
  const branch = input.run?.branch ? ` on ${String(input.run.branch)}` : "";
  const secs = Math.round(input.waitedMs / 1000);
  if (!input.terminal) return `${label}${branch} is ${input.overall} after ${secs}s.`;
  if (input.overall === "success") return `${label}${branch} passed${input.jobsTotal ? ` (${input.jobsTotal} jobs)` : ""}.`;
  if (input.overall === "failure") {
    const names = input.failed
      .slice(0, 3)
      .map((job) => job.name ?? String(job.id))
      .join(", ");
    const more = input.failed.length > 3 ? ` +${input.failed.length - 3} more` : "";
    const where = names ? ` Failing: ${names}${more}.` : "";
    return `${label}${branch} failed.${where}${input.hasTail ? " Log tail attached." : ""}`;
  }
  return `${label}${branch} ended as ${input.overall}.`;
}

async function failureTail(
  data: Record<string, any>,
  args: Record<string, unknown>,
  tailLines: number,
): Promise<{ tail?: Record<string, unknown>; error?: string; note?: string }> {
  const rawRunId = data.run?.id ?? args.run_id;
  const numericRunId = Number(rawRunId);
  const runId = rawRunId !== undefined && rawRunId !== null && String(rawRunId).trim() !== "" ? rawRunId : undefined;
  if (runId === undefined) {
    return {
      note: "check-runs do not expose a single log archive. Hint: pass run_id (or job_id to project_ci_logs) to fetch the failing step.",
    };
  }
  const jobId = failingJobId(data);
  try {
    const response = await opCiLogs({
      run_id: /^\d+$/.test(String(runId)) && Number.isFinite(numericRunId) && numericRunId > 0 ? Math.floor(numericRunId) : runId,
      ...(jobId !== undefined ? { job_id: jobId } : {}),
      tail_lines: tailLines,
      max_bytes: 256 * 1024,
      ...(typeof args.repo === "string" ? { repo: args.repo } : {}),
      ...(typeof args.provider === "string" ? { provider: args.provider } : {}),
    });
    const logData = (response.result?.data ?? {}) as Record<string, any>;
    return {
      tail: {
        ...(jobId !== undefined ? { job_id: jobId } : { run_id: runId }),
        ...(typeof logData.source === "string" ? { source: logData.source } : {}),
        lines: logData.lines ?? 0,
        text: typeof logData.text === "string" ? logData.text : "",
        truncated: logData.truncated === true,
        dropped_lines: logData.dropped_lines ?? 0,
        dropped_bytes: logData.dropped_bytes ?? 0,
        ...(Array.isArray(logData.entries) ? { entries: logData.entries } : {}),
      },
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export async function opCiWait(args: Record<string, unknown>): Promise<Resp> {
  const untilRaw = String(args.until ?? "terminal").toLowerCase();
  if (!["terminal", "any_change"].includes(untilRaw)) {
    throw new Error('[invalid_request] `until` must be "terminal" or "any_change".');
  }
  const until = untilRaw as "terminal" | "any_change";
  const selectors = selectorCount(args);
  if (selectors === 0) {
    throw new Error(
      "[invalid_request] Pass exactly one selector: run_id, ref, pr or branch. " +
        "Hint: project_ci_status uses the same selectors; run_id waits on one run, ref/pr waits on check-runs.",
    );
  }
  if (selectors > 1) {
    throw new Error(
      "[invalid_request] Pass exactly one of run_id / ref / pr / branch (they select different CI surfaces). " +
        "Hint: add workflow= to narrow a branch selector.",
    );
  }

  const timeoutMs = clampInt(args.timeout_ms, DEFAULT_TIMEOUT_MS, 1_000, MAX_TIMEOUT_MS);
  const intervalMs = clampInt(args.interval_ms, DEFAULT_INTERVAL_MS, MIN_INTERVAL_MS, MAX_INTERVAL_MS);
  const tailLines = clampInt(args.tail_lines, DEFAULT_TAIL_LINES, 1, 1_000);
  const includeTail = !(args.include_failure_tail === false || args.include_failure_tail === 0);

  const statusArgs = selectorArgs(args);
  const started = Date.now();

  const first = await pollStatus(statusArgs);
  let data = first.data;
  let overall = overallOf(data);
  const previous = overall;
  let polls = 1;
  let changed = false;

  while (true) {
    if (TERMINAL.has(overall)) break;
    if (until === "any_change" && changed) break;
    const elapsed = Date.now() - started;
    const remaining = timeoutMs - elapsed;
    if (remaining <= 0) break;
    await sleep(Math.min(intervalMs, remaining));
    const next = await pollStatus(statusArgs);
    data = next.data;
    overall = overallOf(data);
    polls += 1;
    if (overall !== previous) changed = true;
  }

  const waitedMs = Date.now() - started;
  const terminal = TERMINAL.has(overall);
  const run = summarizeRun(data);
  const repo = typeof data.repo === "string" ? data.repo : typeof args.repo === "string" ? args.repo : "(resolved)";
  const provider = typeof data.provider === "string" ? data.provider : typeof args.provider === "string" ? args.provider : undefined;
  const source = typeof data.source === "string" ? data.source : undefined;

  let tail: Record<string, unknown> | undefined;
  let tailError: string | undefined;
  let tailNote: string | undefined;
  if (overall === "failure" && includeTail) {
    const result = await failureTail(data, args, tailLines);
    tail = result.tail;
    tailError = result.error;
    tailNote = result.note;
  }

  const selector: Record<string, unknown> = {};
  for (const key of ["run_id", "ref", "pr", "branch", "workflow"]) {
    if (statusArgs[key] !== undefined) selector[key] = statusArgs[key];
  }

  const failed = overall === "failure" ? failingJobs(data) : [];
  const jobsTotal = Array.isArray(data.jobs) ? Number(data.jobs_total ?? data.jobs.length) : undefined;
  const summary = buildSummary({
    overall,
    terminal,
    run,
    failed,
    jobsTotal,
    waitedMs,
    hasTail: Boolean(tail),
  });
  const nextStep = !terminal
    ? "wait_again"
    : overall === "success"
      ? "merge_or_continue"
      : overall === "failure"
        ? tail
          ? "fix_failing_step_then_push"
          : "read_logs"
        : "inspect_status";

  const resultData: Record<string, unknown> = {
    summary,
    next_step: nextStep,
    ...(failed.length > 0 ? { failing_jobs: failed.slice(0, 5), failing_jobs_total: failed.length } : {}),
    repo,
    ...(provider ? { provider } : {}),
    ...(source ? { source } : {}),
    overall,
    previous,
    changed,
    terminal,
    until,
    timeout_ms: timeoutMs,
    interval_ms: intervalMs,
    waited_ms: waitedMs,
    polls,
    selector,
    run,
    ...(Array.isArray(data.jobs) ? { jobs_total: data.jobs_total ?? data.jobs.length } : {}),
    ...(Array.isArray(data.check_runs) ? { check_runs_total: data.check_runs_total ?? data.check_runs.length } : {}),
    ci_status: data,
    ...(tail ? { failure_tail: tail } : {}),
    ...(tailError ? { failure_tail_error: tailError } : {}),
    ...(tailNote ? { failure_tail_note: tailNote } : {}),
  };

  let hint: string;
  if (terminal && overall === "success") {
    hint = "CI passed. Hint: merge with project_pr_merge when the review is ready.";
  } else if (terminal && overall === "failure") {
    hint = tail
      ? "CI failed; the failure_tail contains the bounded log tail. Fix the failing step, then push and call project_ci_wait again."
      : "CI failed. Hint: use project_ci_logs (run_id/job_id) for the failure detail, then fix and push.";
  } else if (until === "any_change" && changed) {
    hint = `CI state changed: ${previous} -> ${overall}. Hint: call project_ci_wait again to wait for the next transition.`;
  } else {
    hint =
      `Still ${overall} after ${Math.round(waitedMs / 1000)}s (${polls} poll${polls === 1 ? "" : "s"}). ` +
      "Call project_ci_wait again with the same selector; keep timeout_ms below the client's ~60s request timeout when chaining.";
  }

  return {
    status: "completed",
    result: { kind: "ci_wait", data: resultData },
    hint,
    ...(terminal ? {} : { truncated: false }),
  };
}
