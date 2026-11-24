/**
 * Audit attribution context (ROADMAP_MINIMAL_MODE.md, Phase 4).
 *
 * One `execute_js` call can run many tools (a snippet calls `venira.read`,
 * `venira.edit`, `venira.shell`, ...). Each of those sub-calls gets its own
 * audit row; `parent_call_id` on that row names the `execute_js` call (its
 * `request_id`, the one the tool envelope returns) so `read_audit
 * { parent_call_id }` can answer "what did this script actually do".
 *
 * The context is an AsyncLocalStorage rather than a mutable global: a tool call
 * is written by the backend executor deep in the stack (tools/project-backend
 * -> corehost -> audit-store), and the store must belong to THAT call, not to
 * whichever call happens to be running when the row is inserted. The bridge
 * establishes it explicitly around every dispatch, so nothing depends on how
 * Node happens to propagate context through an IPC message handler.
 */
import { AsyncLocalStorage } from "node:async_hooks";

type AuditContext = { callId: string };

const storage = new AsyncLocalStorage<AuditContext>();

/** Run `fn` with `callId` as the enclosing tool call. No id = no change. */
export function runWithAuditCallId<T>(callId: string | undefined | null, fn: () => T): T {
  if (typeof callId !== "string" || callId.length === 0) return fn();
  return storage.run({ callId }, fn);
}

/** The enclosing tool call id, or null at the top level. */
export function currentAuditCallId(): string | null {
  return storage.getStore()?.callId ?? null;
}
