/** One interface, three dialects: every provider returns the same envelope. */
import type { GitContext, ProviderId } from "./git-config.js";
import type { Resp } from "./git-common.js";

export interface GitDialect {
  id: ProviderId;
  defaultBranch(ctx: GitContext): Promise<string>;
  prCreate(ctx: GitContext, args: Record<string, unknown>): Promise<Resp>;
  prComment(ctx: GitContext, args: Record<string, unknown>): Promise<Resp>;
  prMerge(ctx: GitContext, args: Record<string, unknown>): Promise<Resp>;
  prList(ctx: GitContext, args: Record<string, unknown>): Promise<Resp>;
  prClose(ctx: GitContext, args: Record<string, unknown>): Promise<Resp>;
  prReopen(ctx: GitContext, args: Record<string, unknown>): Promise<Resp>;
  ciStatus(ctx: GitContext, args: Record<string, unknown>): Promise<Resp>;
  ciTrigger(ctx: GitContext, args: Record<string, unknown>): Promise<Resp>;
  ciLogs(ctx: GitContext, args: Record<string, unknown>): Promise<Resp>;
}

export const PR_STATES = ["open", "closed", "all"] as const;
