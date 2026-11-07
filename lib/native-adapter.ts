/**
 * Venira Native Adapter
 * Direct TypeScript API for embedding Venira corehost without MCP protocol.
 * 
 * Usage:
 * ```ts
 * import { createCorehost } from 'venira-mcp/native';
 * 
 * const corehost = createCorehost({
 *   workspace: '/path/to/project',
 *   shellMode: 'balanced',
 * });
 * 
 * await corehost.warmUp();
 * const result = await corehost.readFile({ relative_path: 'src/main.ts' });
 * if (result.ok) console.log(result.data.text);
 * ```
 */

import { CoreHost } from "./corehost.js";
import { WORKSPACE, migrateLegacyDataDirIfNeeded } from "./workspace.js";
import { loadShellPolicy, enabledShellOverrides } from "./shell-policy.js";
import { validateBooleanEnvironment } from "./env.js";
import type {
  VeniraCorehost,
  WorkspaceConfig,
  NativeResponse,
  ReadFileArgs,
  ReadFileResult,
  ReadBatchArgs,
  ReadBatchItemResult,
  WriteFileArgs,
  WriteFileResult,
  EditFileArgs,
  EditFileResult,
  DeletePathArgs,
  CreateDirectoryArgs,
  ListFilesArgs,
  GetFileInfoArgs,
  SearchArgs,
  SearchResult,
  ShellRunArgs,
  ShellRunResult,
  ShellStatusArgs,
  ShellCancelArgs,
  ShellCancelSessionResult,
  OutlineSymbolArgs,
  OutlineResult,
  FileSymbolsArgs,
  FileSymbolsResult,
  SymbolReferencesArgs,
  SymbolReferencesResult,
  DiffFilesArgs,
  DiffFilesResult,
  SelectiveSearchArgs,
  SelectiveSearchResult,
  RecentFilesArgs,
  RecentFilesResult,
  SnapshotCreateArgs,
  SnapshotCreateResult,
  SnapshotListResult,
  SnapshotRestoreArgs,
  SnapshotRestoreResult,
  SnapshotDeleteArgs,
  PrCreateArgs,
  PrCreateResult,
  PrCommentArgs,
  PrCommentResult,
  PrMergeArgs,
  PrMergeResult,
  PrListArgs,
  PrListResult,
  PrCloseArgs,
  PrReopenArgs,
  CiStatusArgs,
  CiStatusResult,
  CiTriggerArgs,
  CiLogsArgs,
  CiLogsResult,
  CiWaitArgs,
  CiWaitResult,
  SecretSetArgs,
  SecretGetArgs,
  SecretGetResult,
  SecretListResult,
  SecretDeleteArgs,
  GithubConnectStartResult,
  GithubConnectPollResult,
  GithubConnectStatusResult,
  HealthResult,
  ExplainErrorArgs,
  ExplainErrorResult,
  PlanReadBatchArgs,
  PlanReadBatchResult,
  TraceStatusArgs,
  TraceStatusResult,
  ScopeOpenArgs,
  ScopeOpenResult,
  ScopeCloseArgs,
} from "./native-adapter-types.js";

// Re-export types for consumers
export type {
  VeniraCorehost,
  WorkspaceConfig,
  NativeResponse,
  ReadFileArgs,
  ReadFileResult,
  ReadBatchArgs,
  ReadBatchItemResult,
  WriteFileArgs,
  WriteFileResult,
  EditFileArgs,
  EditFileResult,
  DeletePathArgs,
  CreateDirectoryArgs,
  ListFilesArgs,
  GetFileInfoArgs,
  SearchArgs,
  SearchResult,
  ShellRunArgs,
  ShellRunResult,
  ShellStatusArgs,
  ShellCancelArgs,
  ShellCancelSessionResult,
  OutlineSymbolArgs,
  OutlineResult,
  FileSymbolsArgs,
  FileSymbolsResult,
  SymbolReferencesArgs,
  SymbolReferencesResult,
  DiffFilesArgs,
  DiffFilesResult,
  SelectiveSearchArgs,
  SelectiveSearchResult,
  RecentFilesArgs,
  RecentFilesResult,
  SnapshotCreateArgs,
  SnapshotCreateResult,
  SnapshotListResult,
  SnapshotRestoreArgs,
  SnapshotRestoreResult,
  SnapshotDeleteArgs,
  PrCreateArgs,
  PrCreateResult,
  PrCommentArgs,
  PrCommentResult,
  PrMergeArgs,
  PrMergeResult,
  PrListArgs,
  PrListResult,
  PrCloseArgs,
  PrReopenArgs,
  CiStatusArgs,
  CiStatusResult,
  CiTriggerArgs,
  CiLogsArgs,
  CiLogsResult,
  CiWaitArgs,
  CiWaitResult,
  SecretSetArgs,
  SecretGetArgs,
  SecretGetResult,
  SecretListResult,
  SecretDeleteArgs,
  GithubConnectStartResult,
  GithubConnectPollResult,
  GithubConnectStatusResult,
  HealthResult,
  ExplainErrorArgs,
  ExplainErrorResult,
  PlanReadBatchArgs,
  PlanReadBatchResult,
  TraceStatusArgs,
  TraceStatusResult,
  ScopeOpenArgs,
  ScopeOpenResult,
};

// Internal type for CoreHost.call parameters
interface CallParams {
  session_id: string;
  project_id?: string | null;
  capability_id?: string;
  permission_mode?: string;
  operation: {
    name: string;
    arguments: Record<string, unknown>;
  };
  request_id: string;
  reason?: string;
}

/**
 * Creates a Venira Corehost instance with native TypeScript API.
 * This bypasses the MCP protocol entirely — direct function calls.
 */
export function createCorehost(config: WorkspaceConfig = {}): VeniraCorehost {
  // Apply environment configuration
  if (config.workspace) {
    process.env.VENIRA_WORKSPACE = config.workspace;
  }
  if (config.dataDir) {
    process.env.VENIRA_DATA_DIR = config.dataDir;
  }
  if (config.unrestricted !== undefined) {
    process.env.VENIRA_UNRESTRICTED = config.unrestricted ? "1" : "0";
  }
  if (config.permissionMode) {
    process.env.VENIRA_PERMISSION_MODE = config.permissionMode;
  }
  if (config.shellMode) {
    process.env.VENIRA_SHELL_MODE = config.shellMode;
  }
  if (config.outputMode) {
    process.env.VENIRA_OUTPUT_MODE = config.outputMode;
  }
  if (config.shellExitEarly !== undefined) {
    process.env.VENIRA_SHELL_EXIT_EARLY = config.shellExitEarly ? "1" : "0";
  }
  if (config.allowJsExec !== undefined) {
    process.env.VENIRA_ALLOW_JS_EXEC = config.allowJsExec ? "1" : "0";
  }
  if (config.jsExecApproval !== undefined) {
    process.env.VENIRA_JS_EXEC_APPROVAL = config.jsExecApproval ? "1" : "0";
  }
  if (config.allowSelfInstall !== undefined) {
    process.env.VENIRA_ALLOW_SELF_INSTALL = config.allowSelfInstall ? "1" : "0";
  }
  if (config.auditFast !== undefined) {
    process.env.VENIRA_AUDIT_FAST = config.auditFast ? "1" : "0";
  }
  if (config.cacheAll !== undefined) {
    process.env.VENIRA_CACHE_ALL = config.cacheAll ? "1" : "0";
  }
  if (config.cacheListOnly !== undefined) {
    process.env.VENIRA_CACHE_LIST_ONLY = config.cacheListOnly ? "1" : "0";
  }
  if (config.cacheSearchOnly !== undefined) {
    process.env.VENIRA_CACHE_SEARCH_ONLY = config.cacheSearchOnly ? "1" : "0";
  }

  // Initialize environment validation and shell policy
  validateBooleanEnvironment();
  migrateLegacyDataDirIfNeeded();
  loadShellPolicy();
  enabledShellOverrides();

  const corehost = new CoreHost();
  const sessionId = `native-${process.pid}-${Date.now()}`;
  let capabilityId: string | null = null;

  // Helper to call CoreHost operations
  async function call<T>(
    operation: string,
    args: unknown,
    options: {
      reason?: string;
      background?: boolean;
      early_exit?: boolean;
    } = {}
  ): Promise<NativeResponse<T>> {
    // Auto-open scope if needed
    if (!capabilityId) {
      const scopeResult = await corehost.call<{ capability_id: string; project_id: string }>(
        "project_tool.scope.open",
        { session_id: sessionId, project_id: "native", permission_mode: "allow_all" }
      );
      capabilityId = scopeResult.capability_id;
    }

    const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

    try {
      const envelope = await corehost.call<{
        status: string;
        result?: { kind: string; data: T };
        truncated?: boolean;
        hint?: string;
        cached?: boolean;
        elapsed_ms?: number;
      }>(
        "project_tool.execute",
        {
          session_id: sessionId,
          project_id: "native",
          capability_id: capabilityId,
          operation: { name: operation, arguments: args },
          request_id: requestId,
          reason: options.reason,
          background: options.background,
          early_exit: options.early_exit,
        },
        300000 // 5 min timeout
      );
      // Unwrap the envelope: CoreHost returns { status, result: { kind, data } }
      const data = envelope.result?.data as T;
      return { ok: true, data, hint: envelope.hint, cached: envelope.cached, elapsed_ms: envelope.elapsed_ms };
    } catch (error) {
      // Parse error envelope from CoreHost
      const message = error instanceof Error ? error.message : String(error);
      let code = "internal";
      let retryable = false;
      let hint = message;
      let data: Record<string, unknown> | undefined;
      let next_actions: Array<{ tool: string; arguments: Record<string, unknown>; why: string }> | undefined;

      // Try to extract structured error from message
      const codeMatch = message.match(/^\[([a-z_]+)\]/);
      if (codeMatch) {
        code = codeMatch[1];
        hint = message.slice(codeMatch[0].length).trim();
      }

      // Determine retryable
      const nonRetryable = [
        "not_found",
        "scope_denied",
        "invalid_request",
        "sensitive_result",
        "audit_unavailable",
        "path_escape",
        "old_text_not_found",
        "old_text_ambiguous",
        "stale_content",
        "conflict",
        "unsupported",
        "approval_required",
        "approval_invalid",
        "feature_disabled",
        "auth_missing",
        "auth_failed",
        "forbidden",
        "rate_limited",
      ];
      retryable = !nonRetryable.includes(code);

      // Generate next_actions for common errors
      const argsRecord = args as Record<string, unknown>;
      if (code === "old_text_not_found" || code === "old_text_ambiguous") {
        next_actions = [
          {
            tool: "read_file",
            arguments: { relative_path: argsRecord.relative_path as string },
            why: "Read the file first to get exact content for editing",
          },
        ];
      } else if (code === "not_found") {
        next_actions = [
          {
            tool: "list_files",
            arguments: { relative_path: "." },
            why: "List files to find the correct path",
          },
        ];
      } else if (code === "approval_required") {
        hint = `${hint} Stop here. A human must run data.approval.approve_command from the approval response in an interactive PowerShell terminal; do not call shell_run to approve it.`;
      }

      return {
        ok: false,
        error: { code, message: hint, retryable, data, next_actions },
        hint,
      };
    }
  }

  // Wrap result to match NativeResponse
  function wrapResult<T>(result: T): NativeResponse<T> {
    return { ok: true, data: result };
  }

  return {
    // Configuration
    configure(newConfig: WorkspaceConfig) {
      Object.assign(config, newConfig);
      // Re-apply env vars
      if (newConfig.workspace) process.env.VENIRA_WORKSPACE = newConfig.workspace;
      if (newConfig.dataDir) process.env.VENIRA_DATA_DIR = newConfig.dataDir;
      if (newConfig.unrestricted !== undefined) process.env.VENIRA_UNRESTRICTED = newConfig.unrestricted ? "1" : "0";
      if (newConfig.permissionMode) process.env.VENIRA_PERMISSION_MODE = newConfig.permissionMode;
      if (newConfig.shellMode) process.env.VENIRA_SHELL_MODE = newConfig.shellMode;
      if (newConfig.outputMode) process.env.VENIRA_OUTPUT_MODE = newConfig.outputMode;
      if (newConfig.shellExitEarly !== undefined) process.env.VENIRA_SHELL_EXIT_EARLY = newConfig.shellExitEarly ? "1" : "0";
      if (newConfig.allowJsExec !== undefined) process.env.VENIRA_ALLOW_JS_EXEC = newConfig.allowJsExec ? "1" : "0";
      if (newConfig.jsExecApproval !== undefined) process.env.VENIRA_JS_EXEC_APPROVAL = newConfig.jsExecApproval ? "1" : "0";
      if (newConfig.allowSelfInstall !== undefined) process.env.VENIRA_ALLOW_SELF_INSTALL = newConfig.allowSelfInstall ? "1" : "0";
      if (newConfig.auditFast !== undefined) process.env.VENIRA_AUDIT_FAST = newConfig.auditFast ? "1" : "0";
      if (newConfig.cacheAll !== undefined) process.env.VENIRA_CACHE_ALL = newConfig.cacheAll ? "1" : "0";
      if (newConfig.cacheListOnly !== undefined) process.env.VENIRA_CACHE_LIST_ONLY = newConfig.cacheListOnly ? "1" : "0";
      if (newConfig.cacheSearchOnly !== undefined) process.env.VENIRA_CACHE_SEARCH_ONLY = newConfig.cacheSearchOnly ? "1" : "0";
    },

    // Lifecycle
    async warmUp() {
      // Open scope upfront
      const scopeResult = await corehost.call<{ capability_id: string; project_id: string }>(
        "project_tool.scope.open",
        { session_id: sessionId, project_id: "native", permission_mode: "allow_all" }
      );
      capabilityId = scopeResult.capability_id;
    },

    snapshot() {
      return corehost.snapshot();
    },

    async shutdown() {
      if (capabilityId) {
        await corehost.call("project_tool.scope.close", { capability_id: capabilityId });
        capabilityId = null;
      }
      // Cancel any running shells
      await corehost.call("project_tool.shell.cancel_session", {});
    },

    // Scope
    async openScope(args: ScopeOpenArgs): Promise<ScopeOpenResult> {
      const result = await corehost.call<{ capability_id: string; project_id: string }>(
        "project_tool.scope.open",
        {
          session_id: args.session_id,
          project_id: args.project_id ?? null,
          permission_mode: args.permission_mode ?? "allow_all",
        }
      );
      return result;
    },

    async closeScope(args: ScopeCloseArgs): Promise<{ closed: boolean }> {
      const result = await corehost.call<{ closed: boolean }>(
        "project_tool.scope.close",
        { capability_id: args.capability_id }
      );
      return result;
    },

    // File operations
    async readFile(args: ReadFileArgs) {
      return call<ReadFileResult>("read_file", args);
    },

    async readBatch(args: ReadBatchArgs) {
      return call<ReadBatchItemResult[]>("read_batch", args);
    },

    async writeFile(args: WriteFileArgs) {
      return call<WriteFileResult>("write_file", args, { reason: args.reason });
    },

    async editFile(args: EditFileArgs) {
      return call<EditFileResult>("edit_file", args, { reason: args.reason });
    },

    async deletePath(args: DeletePathArgs) {
      return call<{ deleted: boolean }>("delete_path", args, { reason: args.reason });
    },

    async createDirectory(args: CreateDirectoryArgs) {
      return call<{ created: boolean }>("create_directory", args, { reason: args.reason });
    },

    async listFiles(args: ListFilesArgs) {
      return call<{ entries: Array<{ relative_path: string; kind: string; size?: number; mtime_ms?: number }> }>("list_files", args);
    },

    async getFileInfo(args: GetFileInfoArgs) {
      return call<{ relative_path: string; kind: string; size: number; mtime_ms: number }>("get_file_info", args);
    },

    // Search
    async search(args: SearchArgs) {
      return call<SearchResult>("search", args);
    },

    // Shell
    async shellRun(args: ShellRunArgs) {
      return call<ShellRunResult>("shell_run", args, {
        reason: args.reason,
        background: args.background,
        early_exit: args.early_exit,
      });
    },

    async shellStatus(args: ShellStatusArgs) {
      return call<ShellRunResult>("shell_status", args);
    },

    async shellCancel(args: ShellCancelArgs) {
      return call<{ cancelled: boolean }>("shell_cancel", args);
    },

    async shellCancelSession() {
      return call<ShellCancelSessionResult>("shell_cancel_session", {});
    },

    // Code intelligence
    async outlineSymbol(args: OutlineSymbolArgs) {
      return call<OutlineResult>("outline_symbol", args);
    },

    async fileSymbols(args: FileSymbolsArgs) {
      return call<FileSymbolsResult>("file_symbols", args);
    },

    async symbolReferences(args: SymbolReferencesArgs) {
      return call<SymbolReferencesResult>("symbol_references", args);
    },

    async diffFiles(args: DiffFilesArgs) {
      return call<DiffFilesResult>("diff_files", args);
    },

    async selectiveSearch(args: SelectiveSearchArgs) {
      return call<SelectiveSearchResult>("selective_search", args);
    },

    // Recent files
    async recentFiles(args: RecentFilesArgs) {
      const response = await call<{ source: string; entries: Array<{ relative_path: string; mtime_ms: number; size: number; kind: string; updated_at: number }> }>("recent_files", args);
      if (response.ok) {
        // Transform CoreHost response to expected format
        const files = response.data.entries.map((e) => ({
          ...e,
          source: response.data.source as "index" | "fallback_scan",
        }));
        return { ok: true, data: { files } };
      }
      return response;
    },

    // Snapshots
    async snapshotCreate(args: SnapshotCreateArgs) {
      return call<SnapshotCreateResult>("snapshot", { action: "create", ...args }, { reason: args.reason });
    },

    async snapshotList() {
      return call<SnapshotListResult>("snapshot", { action: "list" });
    },

    async snapshotRestore(args: SnapshotRestoreArgs) {
      return call<SnapshotRestoreResult>("snapshot", { action: "restore", ...args });
    },

    async snapshotDelete(args: SnapshotDeleteArgs) {
      return call<{ deleted: boolean }>("snapshot", { action: "delete", ...args });
    },

    // Git/PR
    async prCreate(args: PrCreateArgs) {
      return call<PrCreateResult>("pr_create", args);
    },

    async prComment(args: PrCommentArgs) {
      return call<PrCommentResult>("pr_comment", args);
    },

    async prMerge(args: PrMergeArgs) {
      return call<PrMergeResult>("pr_merge", args);
    },

    async prList(args: PrListArgs) {
      return call<PrListResult>("pr_list", args);
    },

    async prClose(args: PrCloseArgs) {
      return call<{ closed: boolean }>("pr_close", args);
    },

    async prReopen(args: PrReopenArgs) {
      return call<{ reopened: boolean }>("pr_reopen", args);
    },

    // CI
    async ciStatus(args: CiStatusArgs) {
      return call<CiStatusResult>("ci_status", args);
    },

    async ciTrigger(args: CiTriggerArgs) {
      return call<{ triggered: boolean; run_id: number }>("ci_trigger", args);
    },

    async ciLogs(args: CiLogsArgs) {
      return call<CiLogsResult>("ci_logs", args);
    },

    async ciWait(args: CiWaitArgs) {
      return call<CiWaitResult>("ci_wait", args);
    },

    // Secrets
    async secretSet(args: SecretSetArgs) {
      return call<{ set: boolean }>("secret", { action: "set", ...args });
    },

    async secretGet(args: SecretGetArgs) {
      return call<SecretGetResult>("secret", { action: "get", ...args });
    },

    async secretList() {
      return call<SecretListResult>("secret", { action: "list" });
    },

    async secretDelete(args: SecretDeleteArgs) {
      return call<{ deleted: boolean }>("secret", { action: "delete", ...args });
    },

    // GitHub Connect
    async githubConnectStart() {
      return call<GithubConnectStartResult>("github_connect", { action: "start" });
    },

    async githubConnectPoll(device_code: string) {
      return call<GithubConnectPollResult>("github_connect", { action: "poll", device_code });
    },

    async githubConnectStatus() {
      return call<GithubConnectStatusResult>("github_connect", { action: "status" });
    },

    // Health / Diagnostics
    // Note: health, explain_error, plan_read_batch are not yet implemented in CoreHost; use MCP server for these operations.
    async health(): Promise<NativeResponse<HealthResult>> {
      return {
        ok: false,
        error: {
          code: "unsupported",
          message: "health is not available in native adapter; use MCP server",
          retryable: false,
        },
        hint: "Use MCP server for health",
      };
    },

    async explainError(args: ExplainErrorArgs): Promise<NativeResponse<ExplainErrorResult>> {
      return {
        ok: false,
        error: {
          code: "unsupported",
          message: "explain_error is not available in native adapter; use MCP server",
          retryable: false,
        },
        hint: "Use MCP server for explain_error",
      };
    },

    async planReadBatch(args: PlanReadBatchArgs): Promise<NativeResponse<PlanReadBatchResult>> {
      return {
        ok: false,
        error: {
          code: "unsupported",
          message: "plan_read_batch is not available in native adapter; use MCP server",
          retryable: false,
        },
        hint: "Use MCP server for plan_read_batch",
      };
    },

    // Trace
    // Note: trace_status is not yet implemented in CoreHost; use MCP server for this operation.
    async traceStatus(args?: TraceStatusArgs): Promise<NativeResponse<TraceStatusResult>> {
      return {
        ok: false,
        error: {
          code: "unsupported",
          message: "trace_status is not available in native adapter; use MCP server",
          retryable: false,
        },
        hint: "Use MCP server for trace_status",
      };
    },

    // Self-install
    // Note: detect_harnesses and install_self are not yet implemented in CoreHost; use MCP server for these operations.
    async detectHarnesses(): Promise<NativeResponse<Record<string, { config_path: string; exists: boolean }>>> {
      return {
        ok: false,
        error: {
          code: "unsupported",
          message: "detect_harnesses is not available in native adapter; use MCP server",
          retryable: false,
        },
        hint: "Use MCP server for detect_harnesses",
      };
    },

    async installSelf(client: string, config?: Record<string, unknown>): Promise<NativeResponse<{ status: string }>> {
      return {
        ok: false,
        error: {
          code: "unsupported",
          message: "install_self is not available in native adapter; use MCP server",
          retryable: false,
        },
        hint: "Use MCP server for install_self",
      };
    },
  };
}

/**
 * Default instance for simple usage
 */
let defaultInstance: VeniraCorehost | null = null;

export function getDefaultCorehost(config?: WorkspaceConfig): VeniraCorehost {
  if (!defaultInstance) {
    defaultInstance = createCorehost(config);
  } else if (config) {
    defaultInstance.configure(config);
  }
  return defaultInstance;
}