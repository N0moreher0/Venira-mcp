/**
 * Bitbucket Cloud dialect (`/2.0`).
 *
 * Notes that leak into the tool surface:
 * - `pr` is the pull-request id; `run_id` is a pipeline UUID (string);
 * - a step UUID is only addressable together with its pipeline, so
 *   `project_ci_logs` accepts `run_id` + `job_id`, or `job_id` as
 *   `"<pipeline-uuid>:<step-uuid>"`;
 * - Bitbucket has no reopen endpoint: `project_pr_reopen` returns `unsupported`
 *   with the fix (open a new PR).
 */
import { gitFetch, gitJson } from "./git-http.js";
import { requireToken, type GitContext } from "./git-config.js";
import {
  logBufferToText,
  ok,
  overallFrom,
  positiveInt,
  prNumberFrom,
  requireText,
  tailBytes,
  tailLines,
  text,
  type Resp,
} from "./git-common.js";
import { currentBranch } from "./git-repo.js";
import type { GitDialect } from "./git-dialect.js";

function repoPath(ctx: GitContext): string {
  return `/repositories/${ctx.repo.owner}/${ctx.repo.name}`;
}

const defaultBranchCache = new Map<string, { at: number; branch: string }>();
const DEFAULT_BRANCH_TTL_MS = 5 * 60 * 1000;

async function repoDefaultBranch(ctx: GitContext): Promise<string> {
  const key = `${ctx.repo.owner}/${ctx.repo.name}`.toLowerCase();
  const hit = defaultBranchCache.get(key);
  if (hit && Date.now() - hit.at < DEFAULT_BRANCH_TTL_MS) return hit.branch;
  try {
    const res = await gitJson(ctx, "GET", repoPath(ctx), { allowAnonymous: true });
    const branch = typeof res.json?.mainbranch?.name === "string" ? res.json.mainbranch.name : "";
    if (branch) {
      defaultBranchCache.set(key, { at: Date.now(), branch });
      return branch;
    }
  } catch {
    /* fall through */
  }
  return "main";
}

const PR_STATE: Record<string, string> = {
  OPEN: "open",
  MERGED: "merged",
  DECLINED: "closed",
  SUPERSEDED: "closed",
};

function normalizeState(state: unknown): string {
  return PR_STATE[String(state ?? "").toUpperCase()] ?? String(state ?? "").toLowerCase();
}

function summarizePr(pr: any): Record<string, unknown> {
  const href = pr?.links?.html?.href ?? null;
  return {
    number: pr?.id ?? null,
    title: pr?.title ?? null,
    state: normalizeState(pr?.state),
    draft: pr?.draft ?? false,
    head: pr?.source?.branch?.name ?? null,
    base: pr?.destination?.branch?.name ?? null,
    author: pr?.author?.display_name ?? pr?.author?.nickname ?? null,
    created_at: pr?.created_on ?? null,
    updated_at: pr?.updated_on ?? null,
    merged: String(pr?.state ?? "").toUpperCase() === "MERGED",
    url: href,
  };
}

const PIPELINE_STATE: Record<string, { status: string; conclusion: string | null }> = {
  SUCCESSFUL: { status: "completed", conclusion: "success" },
  FAILED: { status: "completed", conclusion: "failure" },
  ERROR: { status: "completed", conclusion: "failure" },
  STOPPED: { status: "completed", conclusion: "cancelled" },
  HALTED: { status: "completed", conclusion: "cancelled" },
  RUNNING: { status: "in_progress", conclusion: null },
  PENDING: { status: "in_progress", conclusion: null },
  PAUSED: { status: "in_progress", conclusion: null },
};

function summarizePipeline(p: any): Record<string, unknown> {
  const state = String(p?.state?.name ?? p?.state ?? "").toUpperCase();
  const mapped = PIPELINE_STATE[state] ?? { status: "completed", conclusion: state.toLowerCase() || null };
  const target = p?.target ?? {};
  return {
    id: p?.uuid ?? null,
    name: target?.selector?.pattern ?? target?.type ?? "pipeline",
    run_number: p?.build_number ?? null,
    status: mapped.status,
    conclusion: mapped.conclusion,
    event: target?.type ?? null,
    branch: target?.ref_name ?? null,
    sha: target?.commit?.hash ? String(target.commit.hash).slice(0, 12) : null,
    created_at: p?.created_on ?? null,
    updated_at: p?.completed_on ?? null,
    url: p?.links?.html?.href ?? null,
  };
}

function summaryStep(step: any): Record<string, unknown> {
  const state = String(step?.state?.name ?? step?.state ?? "").toUpperCase();
  const mapped = PIPELINE_STATE[state] ?? { status: "completed", conclusion: null };
  return {
    id: step?.uuid ?? null,
    name: step?.name ?? null,
    status: mapped.status,
    conclusion: mapped.conclusion,
    started_at: step?.started_on ?? null,
    completed_at: step?.completed_on ?? null,
    url: null,
    runner: null,
  };
}

const UUID_RE = /^[A-Za-z0-9{}_-]{8,80}$/;

function pipelineUuid(value: unknown, label: string): string {
  const raw = String(value ?? "").trim();
  const bare = raw.replace(/^\{?/, "").replace(/\}?$/, "");
  if (!UUID_RE.test(raw) || !UUID_RE.test(bare)) {
    throw new Error(`[invalid_request] \`${label}\` must be a Bitbucket pipeline/step UUID (got "${raw}").`);
  }
  return raw;
}

async function pipelineSteps(ctx: GitContext, uuid: string): Promise<any[]> {
  const res = await gitJson(ctx, "GET", `${repoPath(ctx)}/pipelines/${encodeURIComponent(uuid)}/steps/?pagelen=50`, {
    allowAnonymous: true,
  });
  return (Array.isArray(res.json?.values) ? res.json.values : []) as any[];
}

async function fetchStepLog(ctx: GitContext, pipeline: string, step: string): Promise<Buffer> {
  const res = await gitFetch(
    ctx,
    `${repoPath(ctx)}/pipelines/${encodeURIComponent(pipeline)}/steps/${encodeURIComponent(step)}/log`,
    { timeoutMs: ctx.log_timeout_ms, maxBytes: ctx.log_zip_bytes, accept: "text/plain" },
  );
  return res.buffer;
}

export const bitbucketDialect: GitDialect = {
  id: "bitbucket",
  defaultBranch: repoDefaultBranch,

  async prCreate(ctx, args) {
    requireToken(ctx);
    const title = requireText(args, "title", 'pass title="..." (one line, imperative).');
    const head = text(args, "head") || currentBranch();
    if (!head) throw new Error('[detached_head] Cannot infer the PR source branch. Hint: pass head="feature-branch".');
    const base = text(args, "base") || (await repoDefaultBranch(ctx));
    const { json } = await gitJson(ctx, "POST", `${repoPath(ctx)}/pullrequests`, {
      body: {
        title,
        description: typeof args.body === "string" ? args.body : "",
        source: { branch: { name: head } },
        destination: { branch: { name: base } },
        ...(args.draft === true ? { draft: true } : {}),
      },
    });
    return ok("pr_create", {
      repo: `${ctx.repo.owner}/${ctx.repo.name}`,
      provider: ctx.provider,
      number: json?.id ?? null,
      url: json?.links?.html?.href ?? null,
      title: json?.title ?? title,
      state: normalizeState(json?.state),
      draft: json?.draft ?? args.draft === true,
      head: json?.source?.branch?.name ?? head,
      base: json?.destination?.branch?.name ?? base,
      created: true,
    });
  },

  async prComment(ctx, args) {
    requireToken(ctx);
    const pr = prNumberFrom(args, "pr");
    const body = requireText(args, "body", 'pass body="..." (markdown is fine).');
    const filePath = text(args, "path");
    const payload: Record<string, unknown> = { content: { raw: body } };
    let inline = false;
    if (filePath) {
      const line = Number(args.line);
      if (!Number.isFinite(line) || line <= 0) {
        throw new Error("[invalid_request] `line` must be a positive line number when `path` is set.");
      }
      const side = (text(args, "side") || "RIGHT").toUpperCase();
      if (!["RIGHT", "LEFT"].includes(side)) {
        throw new Error(`[invalid_request] \`side\` must be RIGHT (new code) or LEFT (deleted code), got "${side}".`);
      }
      payload.inline = { path: filePath, ...(side === "RIGHT" ? { to: Math.floor(line) } : { from: Math.floor(line) }) };
      inline = true;
    } else if (args.line !== undefined || args.start_line !== undefined) {
      throw new Error("[invalid_request] `line`/`start_line` need `path` (inline comments are anchored to a file).");
    }
    const { json } = await gitJson(ctx, "POST", `${repoPath(ctx)}/pullrequests/${pr}/comments`, { body: payload });
    return ok("pr_comment", {
      repo: `${ctx.repo.owner}/${ctx.repo.name}`,
      provider: ctx.provider,
      pr,
      inline,
      ...(filePath ? { path: filePath, line: Number(args.line), side: (text(args, "side") || "RIGHT").toUpperCase() } : {}),
      comment_id: json?.id ?? null,
      url: json?.links?.html?.href ?? null,
      created_at: json?.created_on ?? null,
      body_chars: body.length,
      ...(args.start_line !== undefined ? { note: "Bitbucket inline comments do not support start_line; the single line was used." } : {}),
    });
  },

  async prMerge(ctx, args) {
    requireToken(ctx);
    const pr = prNumberFrom(args, "pr");
    const methodRaw = text(args, "method") || "merge";
    if (!["merge", "squash", "rebase"].includes(methodRaw)) {
      throw new Error(`[invalid_request] \`method\` must be merge|squash|rebase (got "${methodRaw}").`);
    }
    const pull = await gitJson(ctx, "GET", `${repoPath(ctx)}/pullrequests/${pr}`, { allowAnonymous: true });
    const state = normalizeState(pull.json?.state);
    if (state === "merged") {
      return ok(
        "pr_merge",
        {
          repo: `${ctx.repo.owner}/${ctx.repo.name}`,
          provider: ctx.provider,
          pr,
          merged: true,
          already_merged: true,
          state,
          method: methodRaw,
          sha: pull.json?.merge_commit?.hash ?? null,
          head: pull.json?.source?.branch?.name ?? null,
          base: pull.json?.destination?.branch?.name ?? null,
        },
        { hint: "Already merged; nothing changed." },
      );
    }
    if (state === "closed") {
      return ok(
        "pr_merge",
        {
          repo: `${ctx.repo.owner}/${ctx.repo.name}`,
          provider: ctx.provider,
          pr,
          merged: false,
          already_merged: false,
          state,
          method: methodRaw,
          sha: null,
          head: pull.json?.source?.branch?.name ?? null,
          base: pull.json?.destination?.branch?.name ?? null,
        },
        { hint: "The PR is declined, not merged." },
      );
    }
    const strategy = methodRaw === "squash" ? "squash" : methodRaw === "rebase" ? "fast_forward" : "merge_commit";
    const { json } = await gitJson(ctx, "POST", `${repoPath(ctx)}/pullrequests/${pr}/merge`, {
      body: {
        merge_strategy: strategy,
        ...(text(args, "commit_message") ? { message: text(args, "commit_message") } : {}),
        ...(args.delete_branch === true ? { close_source_branch: true } : {}),
      },
    });
    const merged = String(json?.state ?? "").toUpperCase() === "MERGED";
    return ok("pr_merge", {
      repo: `${ctx.repo.owner}/${ctx.repo.name}`,
      provider: ctx.provider,
      pr,
      merged,
      method: methodRaw,
      method_applied: strategy,
      sha: json?.merge_commit?.hash ?? null,
      message: json?.merge_commit?.message ?? null,
      head: json?.source?.branch?.name ?? pull.json?.source?.branch?.name ?? null,
      base: json?.destination?.branch?.name ?? pull.json?.destination?.branch?.name ?? null,
      branch_deleted: args.delete_branch === true ? true : false,
    });
  },

  async prList(ctx, args) {
    const state = text(args, "state") || "open";
    if (!["open", "closed", "all"].includes(state)) {
      throw new Error(`[invalid_request] \`state\` must be open|closed|all (got "${state}").`);
    }
    const limit = positiveInt(args.limit, 20, 100);
    const query = new URLSearchParams({ pagelen: String(limit), sort: "-updated_on" });
    query.set("state", state === "open" ? "OPEN" : state === "closed" ? "ALL" : "ALL");
    const head = text(args, "head");
    const base = text(args, "base");
    const clauses: string[] = [];
    if (head) clauses.push(`source.branch.name="${head}"`);
    if (base) clauses.push(`destination.branch.name="${base}"`);
    if (clauses.length) query.set("q", clauses.join(" AND "));
    const { json } = await gitJson(ctx, "GET", `${repoPath(ctx)}/pullrequests?${query.toString()}`, { allowAnonymous: true });
    let prs = ((Array.isArray(json?.values) ? json.values : []) as any[]).map(summarizePr);
    if (state === "closed") prs = prs.filter((pr) => pr.state === "closed" || pr.state === "merged");
    prs = prs.slice(0, limit);
    return ok(
      "pr_list",
      { repo: `${ctx.repo.owner}/${ctx.repo.name}`, provider: ctx.provider, state, total: prs.length, prs },
      { hint: prs.length === 0 ? "No pull requests matched. Hint: state=all lists declined and merged PRs too." : undefined },
    );
  },

  async prClose(ctx, args) {
    requireToken(ctx);
    const pr = prNumberFrom(args, "pr");
    const { json } = await gitJson(ctx, "POST", `${repoPath(ctx)}/pullrequests/${pr}/decline`, { body: {} });
    return ok("pr_close", {
      repo: `${ctx.repo.owner}/${ctx.repo.name}`,
      provider: ctx.provider,
      pr,
      state: normalizeState(json?.state ?? "DECLINED"),
      closed: true,
      url: json?.links?.html?.href ?? null,
    });
  },

  async prReopen() {
    throw new Error(
      "[unsupported] Bitbucket Cloud cannot reopen a declined pull request. " +
        "Hint: open a new PR from the same branch with project_pr_create (the branch is still there).",
    );
  },

  async ciStatus(ctx, args) {
    const runRaw = args.run_id;
    const uuid = runRaw === undefined || runRaw === null || runRaw === "" ? "" : String(runRaw);

    if (uuid) {
      const pipeline = pipelineUuid(uuid, "run_id");
      const { json } = await gitJson(ctx, "GET", `${repoPath(ctx)}/pipelines/${encodeURIComponent(pipeline)}`, {
        allowAnonymous: true,
      });
      const steps = (await pipelineSteps(ctx, pipeline)).map(summaryStep);
      return ok("ci_status", {
        repo: `${ctx.repo.owner}/${ctx.repo.name}`,
        provider: ctx.provider,
        overall: overallFrom([summarizePipeline(json)]),
        run: summarizePipeline(json),
        jobs: steps,
        jobs_total: steps.length,
      });
    }

    const limit = positiveInt(args.limit, 10, 50);
    const ref = text(args, "ref") || text(args, "branch");
    let prNumber: number | null = null;
    let targetRef = ref;
    if (!targetRef && args.pr !== undefined) {
      prNumber = prNumberFrom(args, "pr");
      const pull = await gitJson(ctx, "GET", `${repoPath(ctx)}/pullrequests/${prNumber}`, { allowAnonymous: true });
      targetRef = String(pull.json?.source?.branch?.name ?? "");
    }
    const query = new URLSearchParams({ pagelen: String(limit), sort: "-created_on" });
    if (targetRef) query.set("q", `target.ref_name="${targetRef}"`);
    const { json } = await gitJson(ctx, "GET", `${repoPath(ctx)}/pipelines/?${query.toString()}`, { allowAnonymous: true });
    const runs = ((Array.isArray(json?.values) ? json.values : []) as any[]).map(summarizePipeline);
    return ok(
      "ci_status",
      {
        repo: `${ctx.repo.owner}/${ctx.repo.name}`,
        provider: ctx.provider,
        source: "pipelines",
        overall: overallFrom(runs),
        ref: targetRef || null,
        pr: prNumber,
        branch: targetRef || null,
        total_count: runs.length,
        runs,
      },
      { hint: runs.length === 0 ? "No pipelines matched. Hint: pass ref=<branch>, or trigger one with project_ci_trigger." : undefined },
    );
  },

  async ciTrigger(ctx, args) {
    requireToken(ctx);
    const ref = text(args, "ref") || currentBranch() || (await repoDefaultBranch(ctx));
    const pattern = text(args, "workflow") || "default";
    const variables: Array<{ key: string; value: string }> = [];
    if (args.inputs !== undefined && args.inputs !== null) {
      if (typeof args.inputs !== "object" || Array.isArray(args.inputs)) {
        throw new Error("[invalid_request] `inputs` must be an object of string values.");
      }
      for (const [key, value] of Object.entries(args.inputs as Record<string, unknown>)) {
        if (!/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(key)) {
          throw new Error(`[invalid_request] Variable name "${key}" is invalid.`);
        }
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
          variables.push({ key, value: String(value) });
        } else {
          throw new Error(`[invalid_request] Variable "${key}" must be a string, number or boolean.`);
        }
      }
    }
    const { json } = await gitJson(ctx, "POST", `${repoPath(ctx)}/pipelines/`, {
      body: {
        target: {
          ref_type: "branch",
          type: "pipeline",
          ref_name: ref,
          selector: { type: /^[a-z0-9_-]+$/i.test(pattern) ? "custom" : "branches", pattern },
        },
        ...(variables.length ? { variables } : {}),
      },
    });
    return ok(
      "ci_trigger",
      {
        repo: `${ctx.repo.owner}/${ctx.repo.name}`,
        provider: ctx.provider,
        workflow: pattern,
        ref,
        inputs: Object.fromEntries(variables.map((v) => [v.key, v.value])),
        triggered: true,
        pipeline_id: json?.uuid ?? null,
        dispatched_at: new Date().toISOString(),
      },
      { hint: "Pipeline created. Poll project_ci_status (ref=<ref>) for its status; logs need run_id + step id." },
    );
  },

  async ciLogs(ctx, args) {
    requireToken(ctx);
    const runRaw = args.run_id;
    const runUuidRaw = runRaw === undefined || runRaw === null || runRaw === "" ? "" : String(runRaw);
    const jobRaw = args.job_id;
    const jobText = jobRaw === undefined || jobRaw === null || jobRaw === "" ? "" : String(jobRaw);

    const [embeddedPipeline, embeddedStep] = jobText.includes(":") ? jobText.split(/:(.+)/) : ["", ""];
    const pipeline = runUuidRaw || embeddedPipeline;
    const step = embeddedStep || (jobText && !embeddedPipeline ? jobText : "");
    if (!pipeline) {
      throw new Error(
        "[invalid_request] Bitbucket needs the pipeline UUID. Hint: pass run_id=<pipeline-uuid>, " +
          'optionally with job_id=<step-uuid>, or job_id="<pipeline-uuid>:<step-uuid>".',
      );
    }
    const maxBytes = positiveInt(args.max_bytes, ctx.log_max_bytes, ctx.log_max_bytes);
    const wantLines = positiveInt(args.tail_lines, 500, 5000);
    const pipelineId = pipelineUuid(pipeline, "run_id");

    let text = "";
    let entries: Array<Record<string, unknown>> = [];
    let source: string;

    if (step) {
      const stepId = pipelineUuid(step, "job_id");
      const buffer = await fetchStepLog(ctx, pipelineId, stepId);
      const parsed = logBufferToText(buffer, `step-${stepId}`, ctx.log_entry_bytes, ctx.log_text_bytes);
      text = parsed.text;
      entries = parsed.entries;
      source = `step:${stepId}`;
    } else {
      const steps = await pipelineSteps(ctx, pipelineId);
      const chosen = steps.slice(0, 3);
      const parts: string[] = [];
      for (const item of chosen) {
        const id = String(item?.uuid ?? "");
        if (!id) continue;
        const buffer = await fetchStepLog(ctx, pipelineId, id);
        const parsed = logBufferToText(buffer, `step-${id}`, ctx.log_entry_bytes, ctx.log_text_bytes);
        parts.push(`##### ${item?.name ?? id} (${item?.state?.name ?? "?"}) #####\n${parsed.text}`);
        entries.push(...parsed.entries);
      }
      text = parts.join("\n\n");
      source = `pipeline:${pipelineId}`;
      if (steps.length > chosen.length) {
        entries.push({ name: "(truncated)", bytes: 0, skipped: `${steps.length - chosen.length} more steps not downloaded` });
      }
    }

    const byBytes = tailBytes(text, maxBytes);
    const byLines = tailLines(byBytes.text, wantLines);
    const truncated = byBytes.dropped > 0 || byLines.dropped > 0;
    return ok(
      "ci_logs",
      {
        repo: `${ctx.repo.owner}/${ctx.repo.name}`,
        provider: ctx.provider,
        ...(step ? { job_id: step } : { run_id: pipelineId }),
        source,
        entries,
        lines: byLines.text ? byLines.text.split(/\r?\n/).length : 0,
        text: byLines.text,
        truncated,
        dropped_lines: byLines.dropped,
        dropped_bytes: byBytes.dropped,
        max_bytes: maxBytes,
        tail_lines: wantLines,
      },
      { truncated, hint: truncated ? "Output trimmed to the tail. Hint: raise max_bytes or fetch one step." : undefined },
    );
  },
};
