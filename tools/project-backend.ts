import { newRequestId } from "../lib/output.js";
import type { RustResponse } from "../lib/output.js";
import type { Args } from "./project-cache.js";
import type { createProjectSessionRuntime } from "./project-session-runtime.js";
import { prepareRequest, requestTimeout, UNQUEUED_OPERATIONS } from "./project-request.js";

type SessionRuntime = ReturnType<typeof createProjectSessionRuntime>;

type BackendExecutorDeps = {
  callHost: (method: string, params: unknown, timeoutMs: number) => Promise<unknown>;
  runtime: SessionRuntime;
  sessionId: string;
};

function isCapabilityError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("capability is expired or revoked") ||
    message.includes("capability does not match") ||
    message.includes("corehost exited")
  );
}

/** Creates the uncached executor that binds requests to the active capability. */
export function createBackendExecutor({ callHost, runtime, sessionId }: BackendExecutorDeps) {
  async function executeOnce(operation: string, args: Args): Promise<unknown> {
    const cap = await runtime.capabilityReady();
    const payload = prepareRequest(operation, args);
    // `reason` is copied into the envelope for the host audit row and stays in
    // operation arguments so the result can echo it as `data.reason`.
    const reason = typeof payload.reason === "string" ? payload.reason : undefined;
    const envelope = {
      contract_version: 1,
      request_id: newRequestId(),
      session_id: sessionId,
      project_id: cap.projectId,
      capability_id: cap.id,
      ...(reason !== undefined ? { reason } : {}),
      operation: { name: operation, arguments: payload },
    };
    const timeout = requestTimeout(operation, args);
    const call = () => runtime.trackInFlight(() =>
      callHost("project_tool.execute", envelope, timeout),
    );
    if (UNQUEUED_OPERATIONS.has(operation)) return call();
    return runtime.serial(call);
  }

  return async function execute(operation: string, args: Args): Promise<RustResponse> {
    try {
      return (await executeOnce(operation, args)) as RustResponse;
    } catch (error) {
      if (!isCapabilityError(error)) throw error;
      // The scope may have expired or the host restarted: reopen and retry once.
      runtime.resetCapability();
      return (await executeOnce(operation, args)) as RustResponse;
    }
  };
}
