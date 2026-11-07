type ShellRunState = {
  running: boolean;
  exit_code: number | null;
  updated_at: number;
};

export type ShellRegistrySnapshot = {
  active: Array<{ run_id: string; exit_code: number | null }>;
  tracked: number;
};

/** Owns the bounded in-memory shell-run view shared by execution and health. */
export function createShellRunRegistry(now: () => number = Date.now) {
  const runs = new Map<string, ShellRunState>();

  function track(operation: string, data: unknown): void {
    if (typeof data !== "object" || data === null) return;
    const payload = data as { run_id?: unknown; running?: unknown; exit_code?: unknown };
    if (typeof payload.run_id !== "string") return;
    const timestamp = now();
    if (operation === "shell_run" || operation === "shell_status") {
      runs.set(payload.run_id, {
        running: payload.running === true,
        exit_code: typeof payload.exit_code === "number" ? payload.exit_code : null,
        updated_at: timestamp,
      });
    } else if (operation === "cancel") {
      const previous = runs.get(payload.run_id);
      if (previous) {
        previous.running = false;
        previous.updated_at = timestamp;
      }
    }
    if (runs.size > 32) {
      for (const [runId, state] of runs) {
        if (!state.running && timestamp - state.updated_at > 10 * 60_000) runs.delete(runId);
      }
    }
  }

  function snapshot(): ShellRegistrySnapshot {
    return {
      active: [...runs.entries()]
        .filter(([, state]) => state.running)
        .map(([runId, state]) => ({ run_id: runId, exit_code: state.exit_code })),
      tracked: runs.size,
    };
  }

  return { track, snapshot };
}
