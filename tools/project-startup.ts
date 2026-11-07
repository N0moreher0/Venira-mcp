import { promises as fs } from "node:fs";
import path from "node:path";
import type { Args } from "./project-cache.js";

type ProjectStartupDeps = {
  capabilityReady: () => Promise<unknown>;
  readFileCached: (args: Args) => Promise<unknown>;
  searchCached: (args: Args) => Promise<unknown>;
  workspace: string;
};

/** Creates the best-effort startup warm-up without blocking server startup on cache I/O. */
export function createProjectWarmUp({
  capabilityReady,
  readFileCached,
  searchCached,
  workspace,
}: ProjectStartupDeps): () => Promise<void> {
  return async function warmUp(): Promise<void> {
    try {
      await capabilityReady();
      // Avoid auditing missing files on every startup; only warm files that exist.
      const candidates = ["README.md", "AGENTS.md", "CLAUDE.md", "package.json", ".env.example"];
      // Fire-and-forget: do not block server start on file and search warm-up.
      void Promise.allSettled(
        candidates.map(async (name) => {
          try {
            await fs.access(path.join(workspace, name));
          } catch {
            return;
          }
          try {
            await readFileCached({ relative_path: name });
          } catch {
            /* raced with a delete or unreadable: best-effort only */
          }
        }),
      ).catch(() => {});
      void searchCached({ query: "project_read_file", kind: "literal_content", limit: 50 }).catch(() => {});
    } catch (error) {
      console.error(
        "[venira-coding] warmup failed:",
        error instanceof Error ? error.message : String(error),
      );
    }
  };
}
