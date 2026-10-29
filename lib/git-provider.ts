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
import type { Resp } from "./git-common.js";

const DIALECTS: Record<string, GitDialect> = {
  github: githubDialect,
  gitlab: gitlabDialect,
  bitbucket: bitbucketDialect,
};

function resolve(args: Record<string, unknown>): { ctx: GitContext; dialect: GitDialect } {
  const ctx = gitContext(args);
  const dialect = DIALECTS[ctx.provider];
  if (!dialect) {
    throw new Error(`[invalid_request] No dialect for provider "${ctx.provider}". Hint: use github | gitlab | bitbucket.`);
  }
  return { ctx, dialect };
}

export async function opPrCreate(args: Record<string, unknown>): Promise<Resp> {
  const { ctx, dialect } = resolve(args);
  return dialect.prCreate(ctx, args);
}

export async function opPrComment(args: Record<string, unknown>): Promise<Resp> {
  const { ctx, dialect } = resolve(args);
  return dialect.prComment(ctx, args);
}

export async function opPrMerge(args: Record<string, unknown>): Promise<Resp> {
  const { ctx, dialect } = resolve(args);
  return dialect.prMerge(ctx, args);
}

export async function opPrList(args: Record<string, unknown>): Promise<Resp> {
  const { ctx, dialect } = resolve(args);
  return dialect.prList(ctx, args);
}

export async function opPrClose(args: Record<string, unknown>): Promise<Resp> {
  const { ctx, dialect } = resolve(args);
  return dialect.prClose(ctx, args);
}

export async function opPrReopen(args: Record<string, unknown>): Promise<Resp> {
  const { ctx, dialect } = resolve(args);
  return dialect.prReopen(ctx, args);
}

export async function opCiStatus(args: Record<string, unknown>): Promise<Resp> {
  const { ctx, dialect } = resolve(args);
  return dialect.ciStatus(ctx, args);
}

export async function opCiTrigger(args: Record<string, unknown>): Promise<Resp> {
  const { ctx, dialect } = resolve(args);
  return dialect.ciTrigger(ctx, args);
}

export async function opCiLogs(args: Record<string, unknown>): Promise<Resp> {
  const { ctx, dialect } = resolve(args);
  return dialect.ciLogs(ctx, args);
}

export { gitHealth, gitHealth as githubHealth };
export { networkEnabled } from "./git-http.js";
export { resolveRepo } from "./git-config.js";
export { parseRepoRef, parsePrOrRepo, currentBranch, type RepoRef } from "./git-repo.js";

/** Back-compat helper used by verify/doctor: validate the configured API base. */
export function apiBaseUrl(): string {
  const raw =
    (process.env.VENIRA_GIT_API_URL ?? process.env.VENIRA_GITHUB_API_URL ?? "https://api.github.com").trim();
  return normalizeApiBase(raw, "VENIRA_GIT_API_URL");
}
