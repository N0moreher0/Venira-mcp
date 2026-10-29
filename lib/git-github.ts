/**
 * GitHub REST dialect (github.com and GitHub Enterprise).
 *
 * The shape is unchanged from v1.5: PRs live under `/repos/{owner}/{name}`,
 * Actions runs under `/actions`, branch-protection checks under
 * `/commits/{ref}/check-runs`.
 */
import { gitFetch, gitJson } from "./git-http.js";
import { requireToken, type GitContext } from "./git-config.js";
import {
  logBufferToText,
  ok,
  overallFrom,
  overallFromChecks,
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

const defaultBranchCache = new Map<string, { at: number; branch: string }>();
const DEFAULT_BRANCH_TTL_MS = 5 * 60 * 1000;

async function repoDefaultBranch(ctx: GitContext): Promise<string> {
  const key = `${ctx.repo.owner}/${ctx.repo.name}`.toLowerCase();
  const hit = defaultBranchCache.get(key);
  if (hit && Date.now() - hit.at < DEFAULT_BRANCH_TTL_MS) return hit.branch;
  try {
    const res = await gitJson(ctx, "GET", `/repos/${ctx.repo.owner}/${ctx.repo.name}`, { allowAnonymous: true });
    const branch = typeof res.json?.default_branch === "string" ? res.json.default_branch : "";
    if (branch) {
      defaultBranchCache.set(key, { at: Date.now(), branch });
      return branch;
    }
  } catch {
    /* fall through to a conservative default */
  }
  return "main";
}

function summarizeRun(run: any): Record<string, unknown> {
  return {
    id: run?.id ?? null,
    name: run?.name ?? run?.workflow_name ?? null,
    run_number: run?.run_number ?? null,
    status: run?.status ?? null,
    conclusion: run?.conclusion ?? null,
    event: run?.event ?? null,
    branch: run?.head_branch ?? null,
    sha: run?.head_sha ? String(run.head_sha).slice(0, 12) : null,
    created_at: run?.created_at ?? null,
    updated_at: run?.updated_at ?? null,
    url: run?.html_url ?? null,
    attempt: run?.run_attempt ?? null,
  };
}

function summarizeJob(job: any): Record<string, unknown> {
  return {
    id: job?.id ?? null,
    name: job?.name ?? null,
    status: job?.status ?? null,
    conclusion: job?.conclusion ?? null,
    started_at: job?.started_at ?? null,
    completed_at: job?.completed_at ?? null,
    url: job?.html_url ?? null,
    runner: job?.runner_name ?? null,
  };
}

function summarizeCheckRun(check: any): Record<string, unknown> {
  const output = check?.output ?? {};
  return {
    id: check?.id ?? null,
    name: check?.name ?? null,
    status: check?.status ?? null,
    conclusion: check?.conclusion ?? null,
    started_at: check?.started_at ?? null,
    completed_at: check?.completed_at ?? null,
    url: check?.html_url ?? check?.details_url ?? null,
    app: check?.app?.name ?? null,
    summary: typeof output.title === "string" ? output.title.slice(0, 160) : null,
  };
}

function summarizePull(pr: any): Record<string, unknown> {
  return {
    number: pr?.number ?? null,
    title: pr?.title ?? null,
    state: pr?.state ?? null,
    draft: pr?.draft ?? false,
    head: pr?.head?.ref ?? null,
    base: pr?.base?.ref ?? null,
    author: pr?.user?.login ?? null,
    created_at: pr?.created_at ?? null,
    updated_at: pr?.updated_at ?? null,
    merged: pr?.merged ?? null,
    url: pr?.html_url ?? null,
  };
}

/** GitHub requires `commit_id` with `line`; resolve it from the PR head sha. */
async function pullHeadSha(ctx: GitContext, pr: number, hint: string): Promise<string> {
  const pull = await gitJson(ctx, "GET", `/repos/${ctx.repo.owner}/${ctx.repo.name}/pulls/${pr}`, { allowAnonymous: true });
  const sha = String(pull.json?.head?.sha ?? "");
  if (!sha) {
    throw new Error(`[not_found] PR ${pr} has no head sha (closed or fork-only?). Hint: ${hint}`);
  }
  return sha;
}

function basePath(ctx: GitContext): string {
  return `/repos/${ctx.repo.owner}/${ctx.repo.name}`;
}

export const githubDialect: GitDialect = {
  id: "github",
  defaultBranch: repoDefaultBranch,

  async prCreate(ctx, args) {
    const repoLabel = `${ctx.repo.owner}/${ctx.repo.name}`;
    requireToken(ctx);
    const title = requireText(args, "title", 'pass title="..." (one line, imperative).');
    const head = text(args, "head") || currentBranch();
    if (!head) {
      throw new Error("[detached_head] Cannot infer the PR head branch (detached HEAD). Hint: pass head=\"feature-branch\".");
    }
    const base = text(args, "base") || (await repoDefaultBranch(ctx));
    const body = typeof args.body === "string" ? args.body : "";
    const draft = args.draft === true;

    let json: any;
    try {
      ({ json } = await gitJson(ctx, "POST", `${basePath(ctx)}/pulls`, { body: { title, head, base, body, draft } }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/already exists/i.test(message)) {
        throw new Error(
          `[already_exists] A pull request for ${head} -> ${base} already exists. ` +
            `Hint: use project_pr_comment with the existing PR number, or project_pr_list to find it.`,
        );
      }
      throw error;
    }
    return ok("pr_create", {
      repo: repoLabel,
      provider: ctx.provider,
      number: json?.number ?? null,
      url: json?.html_url ?? null,
      title: json?.title ?? title,
      state: json?.state ?? "open",
      draft: json?.draft ?? draft,
      head: json?.head?.ref ?? head,
      base: json?.base?.ref ?? base,
      created: true,
    });
  },

  async prComment(ctx, args) {
    const repoLabel = `${ctx.repo.owner}/${ctx.repo.name}`;
    requireToken(ctx);
    const pr = prNumberFrom(args, "pr");
    const body = requireText(args, "body", 'pass body="..." (markdown is fine).');
    const base = basePath(ctx);
    const filePath = text(args, "path");

    if (!filePath) {
      if (args.line !== undefined || args.start_line !== undefined) {
        throw new Error(
          "[invalid_request] `line`/`start_line` need `path` (inline comments are anchored to a file). " +
            "Hint: pass path=\"src/app.ts\" and line=42, or drop line for a general PR comment.",
        );
      }
      const { json } = await gitJson(ctx, "POST", `${base}/issues/${pr}/comments`, { body: { body } });
      return ok("pr_comment", {
        repo: repoLabel,
        provider: ctx.provider,
        pr,
        inline: false,
        comment_id: json?.id ?? null,
        url: json?.html_url ?? null,
        created_at: json?.created_at ?? null,
        body_chars: body.length,
      });
    }

    const line = Number(args.line);
    if (!Number.isFinite(line) || line <= 0) {
      throw new Error(
        "[invalid_request] `line` must be a positive line number when `path` is set. Hint: use project_read_ranges to confirm the line.",
      );
    }
    const side = (text(args, "side") || "RIGHT").toUpperCase();
    if (!["RIGHT", "LEFT"].includes(side)) {
      throw new Error(`[invalid_request] \`side\` must be RIGHT (new code) or LEFT (deleted code), got "${side}".`);
    }
    const startLine = Number(args.start_line ?? 0);
    if (startLine > 0 && startLine > line) {
      throw new Error("[invalid_request] `start_line` must be <= `line` (GitHub anchors the range as start_line..line).");
    }

    const payload: Record<string, unknown> = { body, path: filePath, line: Math.floor(line), side };
    if (startLine > 0) {
      payload.start_line = Math.floor(startLine);
      payload.start_side = side;
    }
    const commitId = text(args, "commit_id") || (await pullHeadSha(ctx, pr, 'pass commit_id="<sha>" explicitly.'));
    payload.commit_id = commitId;
    const { json } = await gitJson(ctx, "POST", `${base}/pulls/${pr}/comments`, { body: payload });
    return ok("pr_comment", {
      repo: repoLabel,
      provider: ctx.provider,
      pr,
      inline: true,
      path: filePath,
      line: Math.floor(line),
      ...(startLine > 0 ? { start_line: Math.floor(startLine) } : {}),
      side,
      commit_id: commitId,
      comment_id: json?.id ?? null,
      url: json?.html_url ?? null,
      created_at: json?.created_at ?? null,
      body_chars: body.length,
    });
  },

  async prMerge(ctx, args) {
    const repoLabel = `${ctx.repo.owner}/${ctx.repo.name}`;
    requireToken(ctx);
    const pr = prNumberFrom(args, "pr");
    const methodRaw = text(args, "method") || "merge";
    if (!["merge", "squash", "rebase"].includes(methodRaw)) {
      throw new Error(
        `[invalid_request] \`method\` must be merge|squash|rebase (got "${methodRaw}"). Hint: use method="squash" for one commit.`,
      );
    }
    const commitTitle = text(args, "commit_title");
    const commitMessage = typeof args.commit_message === "string" ? args.commit_message : "";

    const base = basePath(ctx);
    const pull = await gitJson(ctx, "GET", `${base}/pulls/${pr}`, { allowAnonymous: true });
    const state = String(pull.json?.state ?? "");
    const alreadyMerged = pull.json?.merged === true;
    if (alreadyMerged || state === "closed") {
      return ok(
        "pr_merge",
        {
          repo: repoLabel,
          provider: ctx.provider,
          pr,
          merged: alreadyMerged,
          already_merged: alreadyMerged,
          state,
          method: methodRaw,
          sha: pull.json?.merge_commit_sha ?? null,
          head: pull.json?.head?.ref ?? null,
          base: pull.json?.base?.ref ?? null,
        },
        { hint: alreadyMerged ? "Already merged; nothing changed." : "The PR is closed, not merged." },
      );
    }
    if (pull.json?.mergeable === false) {
      throw new Error(`[conflict] PR #${pr} is not mergeable. Hint: resolve conflicts locally, push, then retry project_pr_merge.`);
    }

    const { json } = await gitJson(ctx, "PUT", `${base}/pulls/${pr}/merge`, {
      body: {
        merge_method: methodRaw,
        ...(commitTitle ? { commit_title: commitTitle } : {}),
        ...(commitMessage ? { commit_message: commitMessage } : {}),
      },
    });
    const merged = json?.merged === true;
    const headRef = typeof pull.json?.head?.ref === "string" ? pull.json.head.ref : "";
    const baseRef = typeof pull.json?.base?.ref === "string" ? pull.json.base.ref : "";
    const sameRepo = String(pull.json?.head?.repo?.full_name ?? "").toLowerCase() === repoLabel.toLowerCase();

    let branchDeleted = false;
    let branchNote: string | null = null;
    if (merged && args.delete_branch === true && headRef && sameRepo) {
      const defaultBranch = await repoDefaultBranch(ctx);
      if (headRef === defaultBranch || headRef === baseRef) {
        branchNote = `kept ${headRef}: it is the base/default branch.`;
      } else {
        try {
          await gitJson(ctx, "DELETE", `${base}/git/refs/heads/${headRef}`);
          branchDeleted = true;
        } catch (error) {
          branchNote = `branch not deleted: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`;
        }
      }
    }

    return ok("pr_merge", {
      repo: repoLabel,
      provider: ctx.provider,
      pr,
      merged,
      method: methodRaw,
      sha: json?.sha ?? null,
      message: json?.message ?? null,
      head: headRef || null,
      base: baseRef || null,
      branch_deleted: branchDeleted,
      ...(branchNote ? { note: branchNote } : {}),
    });
  },

  async prList(ctx, args) {
    const state = text(args, "state") || "open";
    if (!["open", "closed", "all"].includes(state)) {
      throw new Error(`[invalid_request] \`state\` must be open|closed|all (got "${state}").`);
    }
    const limit = positiveInt(args.limit, 20, 100);
    const query = new URLSearchParams({ state, per_page: String(limit) });
    const head = text(args, "head");
    const base = text(args, "base");
    if (head) query.set("head", head.includes(":") ? head : `${ctx.repo.owner}:${head}`);
    if (base) query.set("base", base);
    const { json } = await gitJson(ctx, "GET", `${basePath(ctx)}/pulls?${query.toString()}`, { allowAnonymous: true });
    const prs = (Array.isArray(json) ? json : []).map(summarizePull);
    return ok(
      "pr_list",
      { repo: `${ctx.repo.owner}/${ctx.repo.name}`, provider: ctx.provider, state, total: prs.length, prs },
      { hint: prs.length === 0 ? "No PRs matched. Hint: state=all also lists closed/merged PRs." : undefined },
    );
  },

  async prClose(ctx, args) {
    requireToken(ctx);
    const pr = prNumberFrom(args, "pr");
    const { json } = await gitJson(ctx, "PATCH", `${basePath(ctx)}/pulls/${pr}`, { body: { state: "closed" } });
    return ok("pr_close", {
      repo: `${ctx.repo.owner}/${ctx.repo.name}`,
      provider: ctx.provider,
      pr,
      state: json?.state ?? "closed",
      closed: true,
      url: json?.html_url ?? null,
    });
  },

  async prReopen(ctx, args) {
    requireToken(ctx);
    const pr = prNumberFrom(args, "pr");
    const { json } = await gitJson(ctx, "PATCH", `${basePath(ctx)}/pulls/${pr}`, { body: { state: "open" } });
    return ok("pr_reopen", {
      repo: `${ctx.repo.owner}/${ctx.repo.name}`,
      provider: ctx.provider,
      pr,
      state: json?.state ?? "open",
      reopened: true,
      url: json?.html_url ?? null,
    });
  },

  async ciStatus(ctx, args) {
    const base = basePath(ctx);
    const runId = Number(args.run_id ?? 0);

    // Check-runs mode: `ref` (branch/sha) or `pr` (resolved to its head sha).
    const refText = text(args, "ref");
    if (refText || args.pr !== undefined) {
      let targetRef = refText;
      let prNumber: number | null = null;
      if (!targetRef) {
        prNumber = prNumberFrom(args, "pr");
        targetRef = await pullHeadSha(ctx, prNumber, 'pass ref="<sha>" instead.');
      }
      if (!/^[A-Za-z0-9._/-]{1,200}$/.test(targetRef) || targetRef.includes("..")) {
        throw new Error(
          `[invalid_request] \`ref\` must be a branch name or commit sha (letters, digits, . _ / -), got "${targetRef}".`,
        );
      }
      const perPage = positiveInt(args.limit, 20, 50);
      const { json } = await gitJson(ctx, "GET", `${base}/commits/${targetRef}/check-runs?per_page=${perPage}`, {
        allowAnonymous: true,
      });
      const checkRuns = ((json?.check_runs ?? []) as any[]).map(summarizeCheckRun);
      const overall = overallFromChecks(checkRuns);
      return ok(
        "ci_status",
        {
          repo: `${ctx.repo.owner}/${ctx.repo.name}`,
          provider: ctx.provider,
          source: "check-runs",
          overall,
          ref: targetRef,
          pr: prNumber,
          check_runs: checkRuns,
          check_runs_total: json?.total_count ?? checkRuns.length,
        },
        {
          hint:
            checkRuns.length === 0
              ? "No check-runs for this ref (the repo may not use checks, or the ref has no pushed commit). Hint: use branch/workflow to read Actions runs instead."
              : undefined,
        },
      );
    }

    if (runId > 0) {
      const { json } = await gitJson(ctx, "GET", `${base}/actions/runs/${Math.floor(runId)}`, { allowAnonymous: true });
      const jobsRes = await gitJson(ctx, "GET", `${base}/actions/runs/${Math.floor(runId)}/jobs?per_page=50`, {
        allowAnonymous: true,
      });
      const jobs = ((jobsRes.json?.jobs ?? []) as any[]).map(summarizeJob);
      return ok("ci_status", {
        repo: `${ctx.repo.owner}/${ctx.repo.name}`,
        provider: ctx.provider,
        overall: overallFrom([summarizeRun(json)]),
        run: summarizeRun(json),
        jobs,
        jobs_total: jobs.length,
      });
    }

    const limit = positiveInt(args.limit, 10, 50);
    const branch = text(args, "branch");
    const workflow = text(args, "workflow");
    const query = new URLSearchParams({ per_page: String(limit) });
    if (branch) query.set("branch", branch);
    const path = workflow
      ? `${base}/actions/workflows/${encodeURIComponent(workflow)}/runs?${query.toString()}`
      : `${base}/actions/runs?${query.toString()}`;

    const { json } = await gitJson(ctx, "GET", path, { allowAnonymous: true });
    const runs = ((json?.workflow_runs ?? []) as any[]).map(summarizeRun);
    return ok(
      "ci_status",
      {
        repo: `${ctx.repo.owner}/${ctx.repo.name}`,
        provider: ctx.provider,
        overall: overallFrom(runs),
        branch: branch || null,
        workflow: workflow || null,
        total_count: json?.total_count ?? runs.length,
        runs,
      },
      { hint: runs.length === 0 ? "No runs matched. Hint: pass branch/workflow, or trigger one with project_ci_trigger." : undefined },
    );
  },

  async ciTrigger(ctx, args) {
    requireToken(ctx);
    const workflow = requireText(
      args,
      "workflow",
      'pass the workflow file name or id, e.g. workflow="ci.yml" (see .github/workflows/).',
    );
    const ref = text(args, "ref") || currentBranch() || (await repoDefaultBranch(ctx));

    let inputs: Record<string, string> = {};
    if (args.inputs !== undefined && args.inputs !== null) {
      if (typeof args.inputs !== "object" || Array.isArray(args.inputs)) {
        throw new Error("[invalid_request] `inputs` must be an object of string values.");
      }
      const entries = Object.entries(args.inputs as Record<string, unknown>);
      if (entries.length > 10) {
        throw new Error("[invalid_request] Too many workflow `inputs` (max 10).");
      }
      for (const [key, value] of entries) {
        if (!/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(key)) {
          throw new Error(`[invalid_request] Workflow input name "${key}" is invalid.`);
        }
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
          inputs[key] = String(value);
        } else {
          throw new Error(`[invalid_request] Workflow input "${key}" must be a string, number or boolean.`);
        }
      }
    }

    await gitJson(ctx, "POST", `${basePath(ctx)}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, {
      body: { ref, inputs },
    });

    return ok(
      "ci_trigger",
      {
        repo: `${ctx.repo.owner}/${ctx.repo.name}`,
        provider: ctx.provider,
        workflow,
        ref,
        inputs,
        triggered: true,
        dispatched_at: new Date().toISOString(),
      },
      { hint: "Workflow dispatched. Poll project_ci_status (branch=<ref>, limit=3) for the new run; it usually appears within ~10s." },
    );
  },

  async ciLogs(ctx, args) {
    requireToken(ctx);
    const base = basePath(ctx);
    const runId = Number(args.run_id ?? 0);
    const jobId = Number(args.job_id ?? 0);
    if (!(runId > 0) && !(jobId > 0)) {
      throw new Error("[invalid_request] Pass `run_id` (whole run) or `job_id` (one job). Hint: project_ci_status returns both ids.");
    }
    const maxBytes = positiveInt(args.max_bytes, ctx.log_max_bytes, ctx.log_max_bytes);
    const wantLines = positiveInt(args.tail_lines, 500, 5000);

    let text = "";
    let entries: Array<Record<string, unknown>> = [];
    let source: string;

    if (jobId > 0) {
      const res = await gitFetch(ctx, `${base}/actions/jobs/${Math.floor(jobId)}/logs`, {
        timeoutMs: ctx.log_timeout_ms,
        maxBytes: ctx.log_zip_bytes,
      });
      source = `job:${Math.floor(jobId)}`;
      const parsed = logBufferToText(res.buffer, `job-${Math.floor(jobId)}`, ctx.log_entry_bytes, ctx.log_text_bytes);
      text = parsed.text;
      entries = parsed.entries;
    } else {
      const res = await gitFetch(ctx, `${base}/actions/runs/${Math.floor(runId)}/logs`, {
        timeoutMs: ctx.log_timeout_ms,
        maxBytes: ctx.log_zip_bytes,
        accept: "application/vnd.github+json",
      });
      source = `run:${Math.floor(runId)}`;
      const parsed = logBufferToText(res.buffer, `run-${Math.floor(runId)}`, ctx.log_entry_bytes, ctx.log_text_bytes);
      text = parsed.text;
      entries = parsed.entries;
    }

    const byBytes = tailBytes(text, maxBytes);
    const byLines = tailLines(byBytes.text, wantLines);
    const truncated = byBytes.dropped > 0 || byLines.dropped > 0;
    const keptLines = byLines.text ? byLines.text.split(/\r?\n/).length : 0;

    return ok(
      "ci_logs",
      {
        repo: `${ctx.repo.owner}/${ctx.repo.name}`,
        provider: ctx.provider,
        ...(jobId > 0 ? { job_id: Math.floor(jobId) } : { run_id: Math.floor(runId) }),
        source,
        entries,
        lines: keptLines,
        text: byLines.text,
        truncated,
        dropped_lines: byLines.dropped,
        dropped_bytes: byBytes.dropped,
        max_bytes: maxBytes,
        tail_lines: wantLines,
      },
      {
        truncated,
        hint: truncated ? "Output trimmed to the tail. Hint: pass job_id to isolate a failing job, or raise max_bytes." : undefined,
      },
    );
  },
};
