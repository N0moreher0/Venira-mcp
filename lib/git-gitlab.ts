/**
 * GitLab dialect (`/api/v4`).
 *
 * GitLab calls pull requests "merge requests" (iid), workflow runs "pipelines"
 * and jobs "jobs". The tool surface stays the same: `pr` = MR iid,
 * `run_id` = pipeline id, `job_id` = job id, `workflow` = trigger pattern
 * (ignored by GitLab, which triggers by ref).
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

function projectPath(ctx: GitContext): string {
  return `/projects/${encodeURIComponent(`${ctx.repo.owner}/${ctx.repo.name}`)}`;
}

const defaultBranchCache = new Map<string, { at: number; branch: string }>();
const DEFAULT_BRANCH_TTL_MS = 5 * 60 * 1000;

async function repoDefaultBranch(ctx: GitContext): Promise<string> {
  const key = `${ctx.repo.owner}/${ctx.repo.name}`.toLowerCase();
  const hit = defaultBranchCache.get(key);
  if (hit && Date.now() - hit.at < DEFAULT_BRANCH_TTL_MS) return hit.branch;
  try {
    const res = await gitJson(ctx, "GET", projectPath(ctx), { allowAnonymous: true });
    const branch = typeof res.json?.default_branch === "string" ? res.json.default_branch : "";
    if (branch) {
      defaultBranchCache.set(key, { at: Date.now(), branch });
      return branch;
    }
  } catch {
    /* fall through */
  }
  return "main";
}

function normalizeState(state: unknown): string {
  const value = String(state ?? "").toLowerCase();
  if (value === "opened") return "open";
  if (value === "merged") return "merged";
  if (value === "locked") return "closed";
  return value || "unknown";
}

function summarizeMr(mr: any): Record<string, unknown> {
  return {
    number: mr?.iid ?? mr?.id ?? null,
    title: mr?.title ?? null,
    state: normalizeState(mr?.state),
    draft: mr?.draft ?? mr?.work_in_progress ?? false,
    head: mr?.source_branch ?? null,
    base: mr?.target_branch ?? null,
    author: mr?.author?.username ?? null,
    created_at: mr?.created_at ?? null,
    updated_at: mr?.updated_at ?? null,
    merged: mr?.state === "merged" ? true : mr?.merged_at ? true : false,
    url: mr?.web_url ?? null,
  };
}

function pipelineStatus(status: string): { status: string; conclusion: string | null } {
  const value = status.toLowerCase();
  if (["running", "pending", "created", "preparing", "waiting_for_resource", "manual", "scheduled"].includes(value)) {
    return { status: value === "manual" ? "queued" : "in_progress", conclusion: null };
  }
  if (value === "success") return { status: "completed", conclusion: "success" };
  if (value === "failed") return { status: "completed", conclusion: "failure" };
  if (value === "canceled" || value === "cancelled") return { status: "completed", conclusion: "cancelled" };
  if (value === "skipped") return { status: "completed", conclusion: "neutral" };
  return { status: "completed", conclusion: value || null };
}

function summarizePipeline(p: any): Record<string, unknown> {
  const mapped = pipelineStatus(String(p?.status ?? ""));
  return {
    id: p?.id ?? null,
    name: p?.name ?? "pipeline",
    run_number: p?.id ?? null,
    status: mapped.status,
    conclusion: mapped.conclusion,
    event: p?.source ?? null,
    branch: p?.ref ?? null,
    sha: p?.sha ? String(p.sha).slice(0, 12) : null,
    created_at: p?.created_at ?? null,
    updated_at: p?.updated_at ?? null,
    url: p?.web_url ?? null,
  };
}

function summarizeJob(job: any): Record<string, unknown> {
  return {
    id: job?.id ?? null,
    name: job?.name ?? null,
    status: job?.status ?? null,
    conclusion: job?.status === "success" ? "success" : job?.status === "failed" ? "failure" : null,
    started_at: job?.started_at ?? null,
    completed_at: job?.finished_at ?? null,
    url: job?.web_url ?? null,
    runner: job?.runner?.description ?? null,
  };
}

async function getMr(ctx: GitContext, pr: number): Promise<any> {
  const res = await gitJson(ctx, "GET", `${projectPath(ctx)}/merge_requests/${pr}`, { allowAnonymous: true });
  return res.json;
}

export const gitlabDialect: GitDialect = {
  id: "gitlab",
  defaultBranch: repoDefaultBranch,

  async prCreate(ctx, args) {
    requireToken(ctx);
    const title = requireText(args, "title", 'pass title="..." (one line, imperative).');
    const head = text(args, "head") || currentBranch();
    if (!head) throw new Error('[detached_head] Cannot infer the MR source branch. Hint: pass head="feature-branch".');
    const base = text(args, "base") || (await repoDefaultBranch(ctx));
    const draft = args.draft === true;
    const { json } = await gitJson(ctx, "POST", `${projectPath(ctx)}/merge_requests`, {
      body: {
        source_branch: head,
        target_branch: base,
        title: draft && !/^draft:/i.test(title) ? `Draft: ${title}` : title,
        description: typeof args.body === "string" ? args.body : "",
      },
    });
    return ok("pr_create", {
      repo: `${ctx.repo.owner}/${ctx.repo.name}`,
      provider: ctx.provider,
      number: json?.iid ?? null,
      url: json?.web_url ?? null,
      title: json?.title ?? title,
      state: normalizeState(json?.state),
      draft: json?.draft ?? draft,
      head: json?.source_branch ?? head,
      base: json?.target_branch ?? base,
      created: true,
    });
  },

  async prComment(ctx, args) {
    requireToken(ctx);
    const pr = prNumberFrom(args, "pr");
    const body = requireText(args, "body", 'pass body="..." (markdown is fine).');
    const filePath = text(args, "path");
    if (!filePath) {
      if (args.line !== undefined || args.start_line !== undefined) {
        throw new Error(
          "[invalid_request] `line`/`start_line` need `path` (inline comments are anchored to a file). Hint: pass path and line, or drop line.",
        );
      }
      const { json } = await gitJson(ctx, "POST", `${projectPath(ctx)}/merge_requests/${pr}/notes`, { body: { body } });
      return ok("pr_comment", {
        repo: `${ctx.repo.owner}/${ctx.repo.name}`,
        provider: ctx.provider,
        pr,
        inline: false,
        comment_id: json?.id ?? null,
        url: json?.web_url ?? null,
        created_at: json?.created_at ?? null,
        body_chars: body.length,
      });
    }

    const line = Number(args.line);
    if (!Number.isFinite(line) || line <= 0) {
      throw new Error("[invalid_request] `line` must be a positive line number when `path` is set.");
    }
    const side = (text(args, "side") || "RIGHT").toUpperCase();
    if (!["RIGHT", "LEFT"].includes(side)) {
      throw new Error(`[invalid_request] \`side\` must be RIGHT (new code) or LEFT (deleted code), got "${side}".`);
    }
    const startLine = Number(args.start_line ?? 0);
    if (startLine > 0 && startLine > line) {
      throw new Error("[invalid_request] `start_line` must be <= `line`.");
    }
    const mr = await getMr(ctx, pr);
    const refs = mr?.diff_refs ?? {};
    const headSha = text(args, "commit_id") || refs.head_sha;
    if (!headSha) {
      throw new Error("[not_found] MR has no diff refs (no changes yet?). Hint: push a commit, then retry.");
    }
    const position: Record<string, unknown> = {
      base_sha: refs.base_sha,
      start_sha: refs.start_sha,
      head_sha: headSha,
      position_type: "text",
      new_path: filePath,
      old_path: filePath,
      ...(side === "RIGHT" ? { new_line: Math.floor(line) } : { old_line: Math.floor(line) }),
    };
    const { json } = await gitJson(ctx, "POST", `${projectPath(ctx)}/merge_requests/${pr}/discussions`, {
      body: { body, position },
    });
    const note = Array.isArray(json?.notes) ? json.notes[0] : null;
    return ok("pr_comment", {
      repo: `${ctx.repo.owner}/${ctx.repo.name}`,
      provider: ctx.provider,
      pr,
      inline: true,
      path: filePath,
      line: Math.floor(line),
      ...(startLine > 0 ? { start_line: Math.floor(startLine) } : {}),
      side,
      commit_id: headSha,
      comment_id: note?.id ?? json?.id ?? null,
      url: note?.web_url ?? json?.web_url ?? null,
      created_at: note?.created_at ?? null,
      body_chars: body.length,
    });
  },

  async prMerge(ctx, args) {
    requireToken(ctx);
    const pr = prNumberFrom(args, "pr");
    const methodRaw = text(args, "method") || "merge";
    if (!["merge", "squash", "rebase"].includes(methodRaw)) {
      throw new Error(`[invalid_request] \`method\` must be merge|squash|rebase (got "${methodRaw}").`);
    }
    const mr = await getMr(ctx, pr);
    if (mr?.state === "merged") {
      return ok(
        "pr_merge",
        {
          repo: `${ctx.repo.owner}/${ctx.repo.name}`,
          provider: ctx.provider,
          pr,
          merged: true,
          already_merged: true,
          state: "merged",
          method: methodRaw,
          sha: mr?.merge_commit_sha ?? mr?.squash_commit_sha ?? null,
          head: mr?.source_branch ?? null,
          base: mr?.target_branch ?? null,
        },
        { hint: "Already merged; nothing changed." },
      );
    }
    if (mr?.state !== "opened" && mr?.state !== "locked") {
      return ok(
        "pr_merge",
        {
          repo: `${ctx.repo.owner}/${ctx.repo.name}`,
          provider: ctx.provider,
          pr,
          merged: false,
          already_merged: false,
          state: normalizeState(mr?.state),
          method: methodRaw,
          sha: null,
          head: mr?.source_branch ?? null,
          base: mr?.target_branch ?? null,
        },
        { hint: "The MR is closed, not merged." },
      );
    }
    const mergeStatus = String(mr?.detailed_merge_status ?? mr?.merge_status ?? "");
    if (["conflict", "cannot_be_merged", "broken_status"].includes(mergeStatus)) {
      throw new Error(`[conflict] MR !${pr} is not mergeable (${mergeStatus}). Hint: resolve conflicts, push, then retry.`);
    }
    const { json } = await gitJson(ctx, "PUT", `${projectPath(ctx)}/merge_requests/${pr}/merge`, {
      body: {
        ...(methodRaw === "squash" ? { squash: true } : {}),
        ...(text(args, "commit_message") ? { merge_commit_message: text(args, "commit_message") } : {}),
        ...(args.delete_branch === true ? { should_remove_source_branch: true } : {}),
      },
    });
    const merged = String(json?.state ?? "") === "merged";
    return ok(
      "pr_merge",
      {
        repo: `${ctx.repo.owner}/${ctx.repo.name}`,
        provider: ctx.provider,
        pr,
        merged,
        method: methodRaw,
        method_applied: methodRaw === "squash" ? "squash" : "project_default",
        sha: json?.merge_commit_sha ?? json?.squash_commit_sha ?? null,
        message: json?.merge_error ?? null,
        head: mr?.source_branch ?? null,
        base: mr?.target_branch ?? null,
        branch_deleted: args.delete_branch === true ? null : false,
      },
      { hint: merged ? undefined : "GitLab did not merge the MR. Hint: check project merge settings and pipeline status." },
    );
  },

  async prList(ctx, args) {
    const state = text(args, "state") || "open";
    if (!["open", "closed", "all"].includes(state)) {
      throw new Error(`[invalid_request] \`state\` must be open|closed|all (got "${state}").`);
    }
    const limit = positiveInt(args.limit, 20, 100);
    const query = new URLSearchParams({ per_page: String(limit) });
    query.set("state", state === "open" ? "opened" : state === "closed" ? "closed" : "all");
    if (text(args, "head")) query.set("source_branch", text(args, "head"));
    if (text(args, "base")) query.set("target_branch", text(args, "base"));
    const { json } = await gitJson(ctx, "GET", `${projectPath(ctx)}/merge_requests?${query.toString()}`, {
      allowAnonymous: true,
    });
    const prs = (Array.isArray(json) ? json : []).map(summarizeMr);
    return ok(
      "pr_list",
      { repo: `${ctx.repo.owner}/${ctx.repo.name}`, provider: ctx.provider, state, total: prs.length, prs },
      { hint: prs.length === 0 ? "No merge requests matched. Hint: state=all lists closed and merged MRs too." : undefined },
    );
  },

  async prClose(ctx, args) {
    requireToken(ctx);
    const pr = prNumberFrom(args, "pr");
    const { json } = await gitJson(ctx, "PUT", `${projectPath(ctx)}/merge_requests/${pr}`, {
      body: { state_event: "close" },
    });
    return ok("pr_close", {
      repo: `${ctx.repo.owner}/${ctx.repo.name}`,
      provider: ctx.provider,
      pr,
      state: normalizeState(json?.state),
      closed: true,
      url: json?.web_url ?? null,
    });
  },

  async prReopen(ctx, args) {
    requireToken(ctx);
    const pr = prNumberFrom(args, "pr");
    const { json } = await gitJson(ctx, "PUT", `${projectPath(ctx)}/merge_requests/${pr}`, {
      body: { state_event: "reopen" },
    });
    return ok("pr_reopen", {
      repo: `${ctx.repo.owner}/${ctx.repo.name}`,
      provider: ctx.provider,
      pr,
      state: normalizeState(json?.state),
      reopened: true,
      url: json?.web_url ?? null,
    });
  },

  async ciStatus(ctx, args) {
    const base = projectPath(ctx);
    const runRaw = args.run_id;
    const runId = runRaw === undefined || runRaw === null || runRaw === "" ? 0 : Number(runRaw);

    if (runId > 0) {
      if (!Number.isFinite(runId)) throw new Error("[invalid_request] `run_id` must be a numeric pipeline id.");
      const { json } = await gitJson(ctx, "GET", `${base}/pipelines/${Math.floor(runId)}`, { allowAnonymous: true });
      const jobsRes = await gitJson(ctx, "GET", `${base}/pipelines/${Math.floor(runId)}/jobs?per_page=50`, {
        allowAnonymous: true,
      });
      const jobs = ((jobsRes.json ?? []) as any[]).map(summarizeJob);
      return ok("ci_status", {
        repo: `${ctx.repo.owner}/${ctx.repo.name}`,
        provider: ctx.provider,
        overall: overallFrom([summarizePipeline(json)]),
        run: summarizePipeline(json),
        jobs,
        jobs_total: jobs.length,
      });
    }

    // `ref` or `pr`: latest pipeline for that ref (GitLab has no check-runs).
    const limit = positiveInt(args.limit, 10, 50);
    const refText = text(args, "ref");
    let ref = refText;
    let prNumber: number | null = null;
    if (!ref && args.pr !== undefined) {
      prNumber = prNumberFrom(args, "pr");
      const mr = await getMr(ctx, prNumber);
      ref = String(mr?.source_branch ?? "");
      if (!ref) throw new Error("[not_found] MR has no source branch. Hint: pass ref=<branch> instead.");
    }
    const query = new URLSearchParams({ per_page: String(limit) });
    if (ref) query.set("ref", ref);
    if (text(args, "branch")) query.set("ref", text(args, "branch"));
    const { json } = await gitJson(ctx, "GET", `${base}/pipelines?${query.toString()}`, { allowAnonymous: true });
    const runs = (Array.isArray(json) ? json : []).map(summarizePipeline);
    return ok(
      "ci_status",
      {
        repo: `${ctx.repo.owner}/${ctx.repo.name}`,
        provider: ctx.provider,
        source: "pipelines",
        overall: overallFrom(runs),
        ref: ref || null,
        pr: prNumber,
        branch: text(args, "branch") || ref || null,
        total_count: runs.length,
        runs,
      },
      { hint: runs.length === 0 ? "No pipelines matched. Hint: pass ref=<branch>, or trigger one with project_ci_trigger." : undefined },
    );
  },

  async ciTrigger(ctx, args) {
    requireToken(ctx);
    const ref = text(args, "ref") || currentBranch() || (await repoDefaultBranch(ctx));
    const variables: Array<{ key: string; value: string }> = [];
    if (args.inputs !== undefined && args.inputs !== null) {
      if (typeof args.inputs !== "object" || Array.isArray(args.inputs)) {
        throw new Error("[invalid_request] `inputs` must be an object of string values.");
      }
      const entries = Object.entries(args.inputs as Record<string, unknown>);
      if (entries.length > 20) throw new Error("[invalid_request] Too many `inputs` (max 20 for GitLab).");
      for (const [key, value] of entries) {
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
    const { json } = await gitJson(ctx, "POST", `${projectPath(ctx)}/pipeline`, {
      body: { ref, ...(variables.length ? { variables } : {}) },
    });
    const workflow = text(args, "workflow");
    return ok(
      "ci_trigger",
      {
        repo: `${ctx.repo.owner}/${ctx.repo.name}`,
        provider: ctx.provider,
        workflow: workflow || "pipeline",
        ref,
        inputs: Object.fromEntries(variables.map((v) => [v.key, v.value])),
        triggered: true,
        pipeline_id: json?.id ?? null,
        dispatched_at: new Date().toISOString(),
      },
      { hint: "Pipeline created. Poll project_ci_status (ref=<ref>, limit=3) for its status." },
    );
  },

  async ciLogs(ctx, args) {
    requireToken(ctx);
    const runRaw = args.run_id;
    const runId = runRaw === undefined || runRaw === null || runRaw === "" ? 0 : Number(runRaw);
    const jobRaw = args.job_id;
    const jobId = jobRaw === undefined || jobRaw === null || jobRaw === "" ? 0 : Number(jobRaw);
    if (!(runId > 0) && !(jobId > 0)) {
      throw new Error("[invalid_request] Pass `run_id` (pipeline) or `job_id` (single job). Hint: project_ci_status returns both ids.");
    }
    const maxBytes = positiveInt(args.max_bytes, ctx.log_max_bytes, ctx.log_max_bytes);
    const wantLines = positiveInt(args.tail_lines, 500, 5000);
    const base = projectPath(ctx);

    let text = "";
    let entries: Array<Record<string, unknown>> = [];
    let source: string;

    const trace = async (id: number): Promise<{ text: string; entries: Array<Record<string, unknown>> }> => {
      const res = await gitFetch(ctx, `${base}/jobs/${id}/trace`, {
        timeoutMs: ctx.log_timeout_ms,
        maxBytes: ctx.log_zip_bytes,
        accept: "text/plain",
      });
      return logBufferToText(res.buffer, `job-${id}`, ctx.log_entry_bytes, ctx.log_text_bytes);
    };

    if (jobId > 0) {
      if (!Number.isFinite(jobId)) throw new Error("[invalid_request] `job_id` must be a numeric job id.");
      const parsed = await trace(Math.floor(jobId));
      source = `job:${Math.floor(jobId)}`;
      text = parsed.text;
      entries = parsed.entries;
    } else {
      if (!Number.isFinite(runId)) throw new Error("[invalid_request] `run_id` must be a numeric pipeline id.");
      const jobsRes = await gitJson(ctx, "GET", `${base}/pipelines/${Math.floor(runId)}/jobs?per_page=50`, {
        allowAnonymous: true,
      });
      const jobs = (Array.isArray(jobsRes.json) ? jobsRes.json : []) as any[];
      const failed = jobs.filter((job) => ["failed", "canceled", "cancelled"].includes(String(job?.status)));
      const chosen = (failed.length ? failed : jobs).slice(0, 3);
      source = `run:${Math.floor(runId)}`;
      const parts: string[] = [];
      for (const job of chosen) {
        const id = Number(job?.id ?? 0);
        if (!(id > 0)) continue;
        const parsed = await trace(id);
        parts.push(`##### ${job?.name ?? `job-${id}`} (${job?.status ?? "?"}) #####\n${parsed.text}`);
        entries.push(...parsed.entries);
      }
      text = parts.join("\n\n");
      if (jobs.length > chosen.length) {
        entries.push({ name: "(truncated)", bytes: 0, skipped: `${jobs.length - chosen.length} more jobs not downloaded` });
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
        ...(jobId > 0 ? { job_id: Math.floor(jobId) } : { run_id: Math.floor(runId) }),
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
      { truncated, hint: truncated ? "Output trimmed to the tail. Hint: pass job_id to isolate a failing job, or raise max_bytes." : undefined },
    );
  },
};
