/**
 * Internal dispatcher + bridge channel (ROADMAP_MINIMAL_MODE.md, Phase 0 + 3,
 * architecture (A): the `execute_js` child process gets a `venira` proxy that
 * calls back into the parent; the parent runs the REAL tool pipeline (cached
 * executor -> policy -> corehost -> audit) and answers with the same JSON
 * envelope the MCP tools serve.
 *
 * Channel: the Node IPC entry of the child (stdio "ipc"). The fd-3 pipe variant
 * was tried first and rejected: on Windows a pending overlapped read on the
 * pipe blocks the child's teardown -- even `process.exit(0)` never completed.
 * The IPC channel tears down cleanly (the child exits by itself when its
 * script ends) and serializes plain JSON objects in both directions.
 *   child -> parent  { id, op, args }
 *   parent -> child  { id, ok: true, envelope } | { id, ok: false, error, fatal?, envelope? }
 *
 * The dispatcher (`createSdkDispatch`) maps ops to the runners project.ts
 * already owns: shell_run keeps the approval + elicitation flow, memory/create/
 * snapshot/outline/diff/refs keep their tool-level runners, everything else
 * goes through runOne (tool policy + cache + audit). `execute_js` and
 * `workspace_switch` are refused: no recursion, no re-rooting from a snippet.
 */
import type { ChildProcess } from "node:child_process";
import type { ToolResult } from "./output.js";

/** The parent-side runner map: op -> ToolResult. Built in tools/project.ts. */
export type SdkDispatch = (operation: string, args: Record<string, unknown>) => Promise<ToolResult>;

/**
 * Ops callable from inside a snippet. Anything else answers `[invalid_request]`.
 * `workspace_switch` is excluded on purpose (re-rooting a live workspace from a
 * child is not a snippet's business); `execute_js` would recurse.
 */
export const SDK_BRIDGE_OPS: ReadonlySet<string> = new Set([
  // read / search / list / code intel
  "read_file",
  "get_file_info",
  "list_files",
  "search",
  "recent_files",
  "outline_symbol",
  "symbol_references",
  "diff_files",
  "dependency_graph",
  // write side
  "write_file",
  "edit_file",
  "apply_patch",
  "delete_path",
  "move_path",
  "copy_path",
  "create",
  // shell trio (shell_run through runShell; status through runOne; cancel needs kill_key)
  "shell_run",
  "shell_status",
  "cancel",
  // checkpoint + git + memory
  "snapshot",
  "git_status",
  "git_diff",
  "git_log",
  "git_branch",
  "git_commit",
  "git_stash",
  "git_push",
  "memory",
  // advanced groups (venira.help lists the signatures; same policy + audit)
  "pr_create",
  "pr_comment",
  "pr_merge",
  "pr_list",
  "pr_close",
  "pr_reopen",
  "ci_status",
  "ci_trigger",
  "ci_control",
  "ci_logs",
  "ci_wait",
  "secret",
  "read_audit",
  "health",
  "trace_status",
  "shell_cancel_session",
]);

/** Envelopes whose error means the snippet must STOP (roadmap Phase 4). */
const FATAL_ERROR_CODES = new Set(["approval_required", "approval_invalid", "command_denied"]);

/** Extract the `[code]` prefix an error message carries ("[approval_required] ..."). */
function errorCode(message: string): string | null {
  const m = /^\[([a-z0-9_]+)\]/i.exec(message);
  return m ? (m[1] ?? null) : null;
}

/**
 * Pull the JSON envelope out of a ToolResult. Runners serialize exactly one
 * envelope as content[0].text; a malformed response becomes a transport error.
 */
export function envelopeOf(result: ToolResult): Record<string, unknown> {
  const text = result.content?.[0]?.text;
  if (typeof text !== "string" || text.length === 0) {
    throw new Error("[sdk_bridge] the runner returned no envelope text");
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
    throw new Error("not an object");
  } catch (error) {
    throw new Error(
      `[sdk_bridge] the runner returned a malformed envelope: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export type SdkBridge = {
  /** Start serving bridge requests for this child (idempotent per child). */
  attach(child: ChildProcess): void;
  /** Detach so late messages cannot reach a dead child. Safe to call twice. */
  close(): void;
  /** Number of requests served (metrics/tests). */
  served(): number;
};

type BridgeRequest = { id: number; op: string; args: Record<string, unknown> };

/** Parent side of the bridge: serve one child over its IPC channel. */
export function createSdkBridge(dispatch: SdkDispatch): SdkBridge {
  let attached: ChildProcess | null = null;
  let nextId = 0;
  let servedCount = 0;
  const queue: BridgeRequest[] = [];

  const respond = (payload: Record<string, unknown>): void => {
    const child = attached;
    if (!child || child.exitCode !== null || child.killed) return;
    try {
      child.send(payload);
    } catch {
      /* the child is going away; its pending promise dies with it */
    }
  };

  const runOne = async (id: number, op: string, args: Record<string, unknown>): Promise<void> => {
    if (!SDK_BRIDGE_OPS.has(op)) {
      respond({
        id,
        ok: false,
        error: `[invalid_request] venira bridge: unknown or blocked operation "${op}". Hint: SDK_BRIDGE_OPS lists what a snippet may call; execute_js and workspace_switch are never allowed.`,
        fatal: false,
      });
      return;
    }
    let envelope: Record<string, unknown>;
    try {
      envelope = envelopeOf(await dispatch(op, args ?? {}));
    } catch (error) {
      // Policy tiers throw before an envelope exists (tool-policy, dispatcher).
      const message = error instanceof Error ? error.message : String(error);
      const code = errorCode(message);
      respond({ id, ok: false, error: message, fatal: code !== null && FATAL_ERROR_CODES.has(code) });
      return;
    }
    // An envelope can also carry a policy stop (runOne converts throws into
    // ok:false envelopes); those must halt the snippet too (Phase 4). The
    // envelope carries the code in error.code (errorEnvelope strips the
    // "[code]" prefix from the message), a raw throw keeps it in the message.
    const err = envelope && typeof envelope.error === "object" && envelope.error !== null
      ? (envelope.error as Record<string, unknown>)
      : undefined;
    const fieldCode = typeof err?.code === "string" && err.code ? err.code : null;
    const messageCode = errorCode(typeof err?.message === "string" ? err.message : "");
    const code = fieldCode ?? messageCode;
    const errorMessage = typeof err?.message === "string" ? err.message : JSON.stringify(err ?? envelope).slice(0, 400);
    if (code !== null && FATAL_ERROR_CODES.has(code)) {
      respond({ id, ok: false, error: errorMessage, fatal: true, envelope });
      return;
    }
    respond({ id, ok: true, envelope });
  };

  // One dispatch at a time, FIFO: the audit trail keeps script order.
  let pumping = false;
  const pump = async (): Promise<void> => {
    if (pumping) return;
    pumping = true;
    try {
      while (queue.length > 0) {
        const request = queue.shift();
        if (!request) break;
        await runOne(request.id, request.op, request.args);
      }
    } finally {
      pumping = false;
    }
  };

  return {
    attach(child: ChildProcess): void {
      attached = child;
      child.on("message", (raw: unknown) => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
        const msg = raw as { id?: unknown; op?: unknown; args?: unknown };
        if (typeof msg.op !== "string") return;
        const id = typeof msg.id === "number" ? msg.id : ++nextId;
        servedCount += 1;
        queue.push({
          id,
          op: msg.op,
          args: msg.args && typeof msg.args === "object" && !Array.isArray(msg.args) ? (msg.args as Record<string, unknown>) : {},
        });
        void pump().catch(() => undefined);
      });
    },
    close(): void {
      attached = null;
      queue.length = 0;
    },
    served(): number {
      return servedCount;
    },
  };
}
