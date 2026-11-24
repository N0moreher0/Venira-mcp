export type WorkspaceEffect = "read_only" | "mutating" | "unknown";

const READ_ONLY_COMMANDS = new Set(["dir", "ls", "pwd", "cd", "type", "cat", "where", "ver", "echo"]);
const MUTATING_COMMANDS = new Set(["del", "erase", "rm", "rmdir", "mkdir", "md", "copy", "move", "ren", "mv", "cp", "touch", "npm", "yarn", "pnpm", "make", "cargo"]);
const MUTATING_GIT = new Set(["checkout", "switch", "pull", "reset", "merge", "rebase", "cherry-pick", "clean"]);

/** Conservative shell classifier: only a narrow allowlist is read-only; unknown is unsafe. */
export function classifyWorkspaceEffect(command: unknown, _shell?: unknown): WorkspaceEffect {
  if (typeof command !== "string") return "unknown";
  const text = command.trim().replace(/\s+/g, " ");
  if (!text) return "unknown";
  if (/[|&;<>`$]/.test(text) || /\b(?:cmd|powershell|pwsh|bash|sh)\s+(?:\/c|-c)\b/i.test(text)) return "unknown";
  const tokens = text.toLowerCase().split(" ");
  const first = tokens[0];
  if (first === "git") {
    const sub = tokens[1];
    if (["status", "diff", "log", "show"].includes(sub)) return "read_only";
    if (sub === "branch" && (tokens.includes("--list") || tokens.includes("--show-current"))) return "read_only";
    if (MUTATING_GIT.has(sub)) return "mutating";
    return "unknown";
  }
  if (READ_ONLY_COMMANDS.has(first)) return "read_only";
  if ((first === "node" || first === "nodejs") && tokens[1] === "--version") return "read_only";
  if ((first === "npm" || first === "pnpm" || first === "yarn") && tokens[1] === "--version") return "read_only";
  if ((first === "python" || first === "python3") && ["--version", "-V"].includes(tokens[1])) return "read_only";
  if (MUTATING_COMMANDS.has(first)) return "mutating";
  if ((first === "node" && tokens.includes("-e")) || ((first === "python" || first === "python3") && tokens.includes("-c"))) return "unknown";
  return "unknown";
}

export type ShellRunState = {
  running: boolean;
  exit_code: number | null;
  updated_at: number;
  workspace_effect: WorkspaceEffect;
  epoch_bumped: boolean;
};

export type ShellTrackResult = {
  finished: boolean;
  workspace_effect: WorkspaceEffect;
  run_id?: string;
};

export type ShellRegistrySnapshot = {
  active: Array<{ run_id: string; exit_code: number | null }>;
  tracked: number;
};

/** Owns shell lifecycle state and preserves workspace metadata across background polls. */
export function createShellRunRegistry(now: () => number = Date.now) {
  const runs = new Map<string, ShellRunState>();

  function terminal(operation: string, payload: { running?: unknown; exit_code?: unknown }): boolean {
    return operation === "cancel" || operation === "shell_cancel" || payload.running === false ||
      (typeof payload.exit_code === "number" && payload.running !== true);
  }

  function track(operation: string, data: unknown, workspaceEffect?: WorkspaceEffect): ShellTrackResult {
    const payload = (data && typeof data === "object" ? data : {}) as {
      run_id?: unknown; running?: unknown; exit_code?: unknown;
    };
    const runId = typeof payload.run_id === "string" && payload.run_id ? payload.run_id : undefined;
    const finished = terminal(operation, payload);

    if (!runId) return { finished, workspace_effect: workspaceEffect ?? "unknown" };

    const state: ShellRunState = runs.get(runId) ?? {
      running: true, exit_code: null, updated_at: now(), workspace_effect: "unknown", epoch_bumped: false,
    };
    if (workspaceEffect !== undefined && operation === "shell_run") state.workspace_effect = workspaceEffect;
    state.running = operation === "cancel" || operation === "shell_cancel" ? false : payload.running === true;
    state.exit_code = typeof payload.exit_code === "number" ? payload.exit_code : state.exit_code;
    state.updated_at = now();
    runs.set(runId, state);
    const shouldBump = finished && !state.epoch_bumped;
    if (shouldBump) state.epoch_bumped = true;
    return { finished: shouldBump, workspace_effect: state.workspace_effect, run_id: runId };
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
