import { SCOPE_TTL_MS } from "../lib/corehost.js";

export type Capability = { id: string; projectId: string; openedAt: number };
type ScopeOpenResponse = { capability_id: string; project_id: string };

type ProjectSessionRuntimeDeps = {
  callHost: (method: string, params: unknown, timeoutMs: number) => Promise<unknown>;
  sessionId: string;
  permissionMode: string;
};

/** Owns the per-session capability and serialized CoreHost request queue. */
export function createProjectSessionRuntime({
  callHost,
  sessionId,
  permissionMode,
}: ProjectSessionRuntimeDeps) {
  const refreshAfterMs = SCOPE_TTL_MS / 2;
  let queueTail: Promise<unknown> = Promise.resolve();
  let queueDepth = 0;
  let peakQueueDepth = 0;
  let inFlight = 0;
  let capability: Capability | null = null;
  let opening: Promise<Capability> | null = null;

  function serial<T>(task: () => Promise<T>): Promise<T> {
    queueDepth += 1;
    peakQueueDepth = Math.max(peakQueueDepth, queueDepth);
    const run = queueTail.then(() => runQueued(task), () => runQueued(task));
    queueTail = run.catch(() => undefined);
    return run;
  }

  async function runQueued<T>(task: () => Promise<T>): Promise<T> {
    queueDepth = Math.max(0, queueDepth - 1);
    return task();
  }

  function openCapability(): Promise<Capability> {
    return serial(async () => {
      const opened = (await callHost(
        "project_tool.scope.open",
        { session_id: sessionId, project_id: null, permission_mode: permissionMode },
        15_000,
      )) as ScopeOpenResponse;
      return { id: opened.capability_id, projectId: opened.project_id, openedAt: Date.now() };
    });
  }

  function capabilityReady(): Promise<Capability> {
    // Refresh at half the host TTL so ordinary calls never use an expired scope.
    if (capability && Date.now() - capability.openedAt < refreshAfterMs) {
      return Promise.resolve(capability);
    }
    if (!opening) {
      opening = openCapability().then(
        (value) => {
          capability = value;
          opening = null;
          return value;
        },
        (error) => {
          opening = null;
          throw error;
        },
      );
    }
    return opening;
  }

  function capabilityState(value: Capability): "open" | "refreshing" | "expired" {
    const age = Date.now() - value.openedAt;
    if (age >= SCOPE_TTL_MS) return "expired";
    if (age >= refreshAfterMs) return "refreshing";
    return "open";
  }

  function queue() {
    return { depth: queueDepth, in_flight: inFlight, peak_depth: peakQueueDepth };
  }

  function trackInFlight<T>(task: () => Promise<T>): Promise<T> {
    inFlight += 1;
    return task().finally(() => {
      inFlight = Math.max(0, inFlight - 1);
    });
  }

  function resetCapability(): void {
    capability = null;
  }

  async function closeScope(): Promise<void> {
    const current = capability;
    capability = null;
    if (!current) return;
    try {
      await callHost(
        "project_tool.scope.close",
        { session_id: sessionId, project_id: current.projectId, capability_id: current.id },
        5_000,
      );
    } catch {
      /* host already dead or scope already expired */
    }
  }

  return {
    serial,
    capabilityReady,
    capabilityState,
    capabilitySnapshot: () => ({ value: capability, opening: opening !== null }),
    queue,
    trackInFlight,
    resetCapability,
    closeScope,
  };
}
