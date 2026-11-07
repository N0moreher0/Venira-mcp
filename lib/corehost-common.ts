/**
 * Shared helpers for the corehost op modules (search, file ops, ...).
 * Extracted from corehost.ts so op modules can import them without
 * creating an import cycle back into corehost.ts.
 */
import { resolveWithin } from "./workspace.js";

export type RustResponse = {
  status?: string;
  truncated?: boolean;
  hint?: string;
  result?: { kind?: string; data?: unknown };
};

export function resolveInWorkspace(input: string | undefined, root: string): string {
  return resolveWithin(root, input);
}

export type ErrorWithData = Error & { data?: unknown };

export function errorWithData(code: string, message: string, data: unknown): ErrorWithData {
  const error = new Error(`[${code}] ${message}`) as ErrorWithData;
  error.data = data;
  return error;
}
