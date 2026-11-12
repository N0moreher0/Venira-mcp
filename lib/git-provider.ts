/**
 * Git provider router.
 *
 * The tools call these functions and stay provider-agnostic: the context
 * (provider, API base, token, limits, proxy) is resolved per call from
 * call args → environment → `venira.config.json` → inferred remote.
 *
 * Dialects:
 *   - `lib/git-github.ts`    GitHub / GitHub Enterprise REST
 *   - `lib/git-gitlab.ts`    GitLab `/api/v4`
 *   - `lib/git-bitbucket.ts` Bitbucket Cloud `/2.0`
 */
import { gitContext, gitHealth, normalizeApiBase, type GitContext } from "./git-config.js";
import type { GitDialect } from "./git-dialect.js";
import { githubDialect } from "./git-github.js";
import { gitlabDialect } from "./git-gitlab.js";
import { bitbucketDialect } from "./git-bitbucket.js";
import { selectorCount, type Resp } from "./git-common.js";
import { refreshGithubAccessTokenIfNeeded } from "./github-device-flow.js";
import { assertProviderPayloadSafe } from "./provider-secret-guard.js";

const DIALECTS: Record<string, GitDialect> = {
  github: githubDialect,
  gitlab: gitlabDialect,
  bitbucket: bitbucketDialect,
};

async function resolve(
  args: Record<string, unknown>,
  operation: string,
): Promise<{ ctx: GitContext; dialect: GitDialect }> {
  await assertProviderPayloadSafe(args, { operation, direction: "request" });
  let ctx: GitContext;
  try {
    ctx = gitContext(args);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith('[secret_expired] Secret "GITHUB_TOKEN"')) {
      throw error;
    }
    await refreshGithubAccessTokenIfNeeded();
    ctx = gitContext(args);
  }
  const dialect = DIALECTS[ctx.provider];
  if (!dialect) {
    throw new Error(`[invalid_request] No dialect for provider "${ctx.provider}". Hint: use github | gitlab | bitbucket.`);
  }
  return { ctx, dialect };
}

async function runProvider(
  args: Record<string, unknown>,
  operation: string,
  run: (ctx: GitContext, dialect: GitDialect) => Promise<Resp>,
): Promise<Resp> {
  const { ctx, dialect } = await resolve(args, operation);
  const response = await run(ctx, dialect);
  await assertProviderPayloadSafe(response, { operation, direction: "response" });
  return response;
}

export async function opPrCreate(args: Record<string, unknown>): Promise<Resp> {
  return runProvider(args, "pr_create", (ctx, dialect) => dialect.prCreate(ctx, args));
}

export async function opPrComment(args: Record<string, unknown>): Promise<Resp> {
  return runProvider(args, "pr_comment", (ctx, dialect) => dialect.prComment(ctx, args));
}

export async function opPrMerge(args: Record<string, unknown>): Promise<Resp> {
  return runProvider(args, "pr_merge", (ctx, dialect) => dialect.prMerge(ctx, args));
}

export async function opPrList(args: Record<string, unknown>): Promise<Resp> {
  return runProvider(args, "pr_list", (ctx, dialect) => dialect.prList(ctx, args));
}

export async function opPrClose(args: Record<string, unknown>): Promise<Resp> {
  return runProvider(args, "pr_close", (ctx, dialect) => dialect.prClose(ctx, args));
}

export async function opPrReopen(args: Record<string, unknown>): Promise<Resp> {
  return runProvider(args, "pr_reopen", (ctx, dialect) => dialect.prReopen(ctx, args));
}

export async function opCiStatus(args: Record<string, unknown>): Promise<Resp> {
  // 0 selectors = recent runs; 1 = that run/ref/PR/branch. 2+ used to be resolved
  // silently by a hidden precedence, so reject it like project_ci_wait does.
  if (selectorCount(args) > 1) {
    throw new Error(
      "[invalid_request] Pass at most one of run_id / ref / pr / branch (they select different CI surfaces). " +
        "Hint: add workflow= to narrow a branch selector.",
    );
  }
  return runProvider(args, "ci_status", (ctx, dialect) => dialect.ciStatus(ctx, args));
}

export async function opCiControl(args: Record<string, unknown>): Promise<Resp> {
  return runProvider(args, "ci_control", (ctx, dialect) => dialect.ciControl(ctx, args));
}

export async function opCiTrigger(args: Record<string, unknown>): Promise<Resp> {
  return runProvider(args, "ci_trigger", (ctx, dialect) => dialect.ciTrigger(ctx, args));
}

export async function opCiLogs(args: Record<string, unknown>): Promise<Resp> {
  return runProvider(args, "ci_logs", (ctx, dialect) => dialect.ciLogs(ctx, args));
}

export { gitHealth, gitHealth as githubHealth };
export { resolveRepo } from "./git-config.js";
export { parseRepoRef, parsePrOrRepo, currentBranch, type RepoRef } from "./git-repo.js";

/** Back-compat helper used by verify/doctor: validate the configured API base. */
export function apiBaseUrl(): string {
  const raw =
    (process.env.VENIRA_GIT_API_URL ?? process.env.VENIRA_GITHUB_API_URL ?? "https://api.github.com").trim();
  return normalizeApiBase(raw, "VENIRA_GIT_API_URL");
}
