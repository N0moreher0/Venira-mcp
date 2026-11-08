import { buildEnvelope, errorEnvelope, newRequestId, toolResult } from "../lib/output.js";
import type { RustResponse, ToolResult } from "../lib/output.js";
import { recordMetric } from "../lib/metrics.js";
import type { Args, Execution } from "./project-cache.js";

export type OperationRunnerDeps = {
  executeCached: (operation: string, args: Args) => Promise<Execution>;
};

export function createOperationRunners({ executeCached }: OperationRunnerDeps) {
  async function runOne(
    operation: string,
    args: Args,
    options?: { line_numbers?: boolean },
  ): Promise<ToolResult> {
    const started = performance.now();
    const requestId = newRequestId();
    try {
      const { response, cached } = await executeCached(operation, args);
      const result = response;
      if (options?.line_numbers && result?.result?.kind === "file_read") {
        const data = result.result.data as { text?: string; first_line?: number; line_numbers?: boolean } | undefined;
        if (data && typeof data.text === "string" && typeof data.first_line === "number" && data.first_line >= 1 && data.text) {
          const lines = data.text.split("\n");
          const trailingNewline = lines[lines.length - 1] === "";
          if (trailingNewline) lines.pop();
          const firstLine = data.first_line;
          const lastNumber = firstLine + lines.length - 1;
          const width = Math.max(4, String(lastNumber).length);
          const numbered = lines
            .map((line, index) => `${(firstLine + index).toString().padStart(width, " ")}| ${line}`)
            .join("\n");
          data.text = numbered + (trailingNewline ? "\n" : "");
          data.line_numbers = true;
        }
      }
      const elapsedMs = performance.now() - started;
      recordMetric(operation, elapsedMs, true);
      return toolResult(
        buildEnvelope(operation, result, {
          requestId,
          elapsedMs,
          cached,
          ...(result?.hint ? { hint: result.hint } : {}),
        }),
      );
    } catch (error) {
      const elapsedMs = performance.now() - started;
      recordMetric(operation, elapsedMs, false);
      return toolResult(errorEnvelope(operation, error, { requestId, elapsedMs }), true);
    }
  }

  async function runCreate(args: Args): Promise<ToolResult> {
    const started = performance.now();
    const requestId = newRequestId();
    const elapsed = () => performance.now() - started;
    const kind = args.kind;
    if (kind === "directory") {
      if (args.content) {
        const fail = errorEnvelope(
          "create",
          new Error("[invalid_request] kind=directory does not accept `content`. Drop content or use kind=file. Hint: use write_file for files, create_directory for directories."),
          { requestId, elapsedMs: elapsed() },
        );
        recordMetric("create", elapsed(), false);
        return toolResult(fail, true);
      }
      const dirParams: Args = {
        relative_path: args.relative_path,
        create_parents: args.create_dirs ?? true,
      };
      if (typeof args.reason === "string") dirParams.reason = args.reason;
      let dirResponse: RustResponse;
      try {
        ({ response: dirResponse } = await executeCached("create_directory", dirParams));
      } catch (error) {
        const elapsedMs = elapsed();
        recordMetric("create", elapsedMs, false);
        return toolResult(errorEnvelope("create", error, { requestId, elapsedMs }), true);
      }
      recordMetric("create", elapsed(), true);
      return toolResult(buildEnvelope("create", dirResponse, { requestId, elapsedMs: elapsed() }));
    }
    if (kind !== "file") {
      recordMetric("create", elapsed(), false);
      return toolResult(
        errorEnvelope(
          "create",
          new Error(`[invalid_request] \`kind\` must be "file" or "directory". Received: ${JSON.stringify(kind)}.`),
          { requestId, elapsedMs: elapsed() },
        ),
        true,
      );
    }
    if (typeof args.content !== "string") {
      recordMetric("create", elapsed(), false);
      return toolResult(
        errorEnvelope(
          "create",
          new Error('[invalid_request] kind=file requires `content` (a UTF-8 string; use an empty string "" for an empty file).'),
          { requestId, elapsedMs: elapsed() },
        ),
        true,
      );
    }
    const fileParams: Args = {
      relative_path: args.relative_path,
      content: args.content,
      create_dirs: args.create_dirs ?? true,
    };
    if (args.mode !== undefined) fileParams.mode = args.mode;
    if (args.expected_sha256 !== undefined) fileParams.expected_sha256 = args.expected_sha256;
    if (typeof args.reason === "string") fileParams.reason = args.reason;
    let result: RustResponse;
    try {
      result = (await executeCached("write_file", fileParams)).response as RustResponse;
    } catch (error) {
      const elapsedMs = elapsed();
      recordMetric("create", elapsedMs, false);
      return toolResult(errorEnvelope("create", error, { requestId, elapsedMs }), true);
    }
    recordMetric("create", elapsed(), true);
    return toolResult(buildEnvelope("create", result, { requestId, elapsedMs: elapsed() }));
  }

  return { runOne, runCreate };
}
