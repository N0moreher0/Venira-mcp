/**
 * Venira Native Adapter Types
 * Type-safe API for embedding Venira corehost directly (no MCP protocol).
 * Import from 'venira-mcp/native' or 'venira-mcp/corehost'.
 */

import type { HostSnapshot } from "./types.js";

/** Result envelope for all operations (mirrors MCP envelope but without request_id) */
export interface NativeResult<T = unknown> {
  ok: true;
  data: T;
  hint?: string;
  cached?: boolean;
  elapsed_ms?: number;
}

export interface NativeError {
  ok: false;
  error: {
    code: string;
    message: string;
    retryable: boolean;
    data?: Record<string, unknown>;
    next_actions?: Array<{
      tool: string;
      arguments: Record<string, unknown>;
      why: string;
    }>;
  };
  hint: string;
}

export type NativeResponse<T = unknown> = NativeResult<T> | NativeError;

/** Workspace configuration */
export interface WorkspaceConfig {
  workspace?: string;
  dataDir?: string;
  unrestricted?: boolean;
  permissionMode?: "manual" | "best_effort" | "allow_all";
  shellMode?: "balanced" | "strict" | "permissive" | "off";
  outputMode?: "full" | "compact";
  /** `execute_js` gate: off hides the tool, ask requires per-call approval, semi-auto runs without approval but contained, auto runs without approval and without containment. */
  jsExecMode?: "off" | "ask" | "semi-auto" | "auto";
  allowSelfInstall?: boolean;

  cacheListOnly?: boolean;
  cacheSearchOnly?: boolean;
}

/** File operations */
export interface ReadFileArgs {
  relative_path: string;
  start_line?: number;
  end_line?: number;
}

export interface ReadFileResult {
  relative_path: string;
  text: string;
  lines: number;
  start_line: number;
  end_line: number;
  encoding: "utf-8";
}

export interface ReadBatchArgs {
  requests: Array<{
    operation: "read_file" | "get_file_info" | "list_files" | "search";
    arguments: Record<string, unknown>;
  }>;
  max_response_bytes_per_item?: number;
}

export interface ReadBatchItemResult<T = unknown> {
  operation: string;
  ok: boolean;
  data?: T;
  error?: { code: string; message: string; hint: string };
}

export interface WriteFileArgs {
  relative_path: string;
  content: string;
  reason?: string;
}

export interface WriteFileResult {
  relative_path: string;
  bytes: number;
  sha256: string;
}

export interface EditFileArgs {
  relative_path: string;
  edits: Array<{
    old_text: string;
    new_text: string;
    replace_all?: boolean;
  }>;
  reason?: string;
}

export interface EditFileResult {
  relative_path: string;
  edits_applied: number;
  sha256: string;
}

export interface DeletePathArgs {
  relative_path: string;
  reason?: string;
}

export interface CreateDirectoryArgs {
  relative_path: string;
  reason?: string;
}

export interface ListFilesArgs {
  relative_path?: string;
  depth?: number;
  limit?: number;
}

export interface GetFileInfoArgs {
  relative_path: string;
}

/** Search operations */
export interface SearchArgs {
  query: string;
  kind?: "literal_content" | "file_name" | "directory_name" | "definition";
  limit?: number;
  offset?: number;
  relative_path?: string;
}

export interface SearchHit {
  relative_path: string;
  line_number: number;
  line: string;
  kind: "literal_content" | "file_name" | "directory_name" | "definition";
}

export interface SearchResult {
  hits: SearchHit[];
  complete: boolean;
  total_match_lines: number;
  files_matched: number;
}

/** Shell operations */
export interface ShellRunArgs {
  command: string | string[];
  shell?: string;
  cwd?: string;
  env?: Record<string, string>;
  timeout_ms?: number;
  background?: boolean;
  wait_seconds?: number;
  secret_env?: string[];
  override?: string;
  reason?: string;
  early_exit?: boolean;
}

export interface ShellRunResult {
  run_id: string;
  shell_id: number;
  running: boolean;
  exit_code?: number;
  stdout?: string;
  stderr?: string;
  timed_out?: boolean;
  approval_required?: boolean;
  approval_id?: string;
  approval_tool?: string;
  policy?: Record<string, unknown>;
  dropped_bytes?: { stdout?: number; stderr?: number };
}

export interface ShellStatusArgs {
  run_id: string;
  wait_seconds?: number;
}

export interface ShellCancelArgs {
  run_id: string;
}

export interface ShellCancelSessionResult {
  cancelled: number;
}

/** Code intelligence */
export interface OutlineSymbolArgs {
  relative_path: string;
  language?: string;
  include_functions?: boolean;
  include_classes?: boolean;
}

export interface SymbolInfo {
  name: string;
  kind: string;
  line: number;
  signature?: string;
  doc_comment?: string;
}

export interface OutlineResult {
  relative_path: string;
  symbols: SymbolInfo[];
}

export interface FileSymbolsArgs {
  relative_path: string;
  language?: string;
  include_functions?: boolean;
  include_classes?: boolean;
}

export interface FileSymbolsResult {
  relative_path: string;
  symbols: SymbolInfo[];
}

export interface SymbolReferencesArgs {
  symbol_name: string;
  scope?: "file" | "workspace";
  relative_path?: string;
  language?: string;
  limit?: number;
  max_references?: number;
}

export interface SymbolReference {
  relative_path: string;
  line_number: number;
  context: string;
}

export interface SymbolReferencesResult {
  references: SymbolReference[];
}

export interface DiffFilesArgs {
  relative_path_a: string;
  relative_path_b: string;
  context_lines?: number;
  max_lines?: number;
}

export interface DiffFilesResult {
  relative_path_a: string;
  relative_path_b: string;
  lines_added: number;
  lines_removed: number;
  unified_diff: string;
  truncated: boolean;
}

export interface SelectiveSearchArgs {
  queries: Array<{
    pattern: string;
    must?: boolean;
    weight?: number;
  }>;
  limit?: number;
}

export interface SelectiveSearchHit {
  relative_path: string;
  line_number: number;
  line: string;
  score: number;
  matched_queries: string[];
}

export interface SelectiveSearchResult {
  hits: SelectiveSearchHit[];
}

/** Recent files */
export interface RecentFilesArgs {
  limit?: number;
  include_dirs?: boolean;
}

export interface RecentFileInfo {
  relative_path: string;
  mtime_ms: number;
  size: number;
  kind: string;
  updated_at: number;
  source: "index" | "fallback_scan";
}

export interface RecentFilesResult {
  files: RecentFileInfo[];
}

/** Snapshots / Checkpoints */
export interface SnapshotCreateArgs {
  paths?: string[];
  label?: string;
  reason?: string;
}

export interface SnapshotInfo {
  id: string;
  label?: string;
  created_at: number;
  file_count: number;
  total_bytes: number;
  paths: string[];
}

export interface SnapshotCreateResult {
  snapshot_id: string;
  file_count: number;
  total_bytes: number;
  skipped?: Array<{ relative_path: string; reason: string }>;
}

export interface SnapshotListResult {
  snapshots: SnapshotInfo[];
}

export interface SnapshotRestoreArgs {
  id: string;
  dry_run?: boolean;
  delete_extra?: boolean;
}

export interface SnapshotRestoreResult {
  restored: number;
  deleted?: number;
  skipped?: Array<{ relative_path: string; reason: string }>;
}

export interface SnapshotDeleteArgs {
  id: string;
}

/** Git / PR operations */
export interface PrCreateArgs {
  title: string;
  head?: string;
  base?: string;
  body?: string;
  draft?: boolean;
  repo?: string;
}

export interface PrCreateResult {
  number: number;
  url: string;
  head: string;
  base: string;
}

export interface PrCommentArgs {
  pr: number | string;
  body: string;
  path?: string;
  line?: number;
  start_line?: number;
  side?: "RIGHT" | "LEFT";
  commit_id?: string;
}

export interface PrCommentResult {
  id: number;
  url: string;
  inline: boolean;
}

export interface PrMergeArgs {
  pr: number | string;
  method?: "merge" | "squash" | "rebase";
  commit_title?: string;
  commit_message?: string;
  delete_branch?: boolean;
}

export interface PrMergeResult {
  merged: boolean;
  sha?: string;
  method: string;
  delete_branch: boolean;
}

export interface PrListArgs {
  state?: "open" | "closed" | "all";
  head?: string;
  base?: string;
  limit?: number;
  repo?: string;
}

export interface PrInfo {
  number: number;
  title: string;
  state: string;
  head: string;
  base: string;
  url: string;
  author: string;
  created_at: string;
  updated_at: string;
}

export interface PrListResult {
  pull_requests: PrInfo[];
}

export interface PrCloseArgs {
  pr: number | string;
}

export interface PrReopenArgs {
  pr: number | string;
}

/** CI operations */
export interface CiStatusArgs {
  branch?: string;
  workflow?: string;
  run_id?: number;
  limit?: number;
  ref?: string;
  pr?: number;
}

export interface CiRunInfo {
  id: number;
  name: string;
  status: string;
  conclusion?: string;
  head_branch: string;
  head_sha: string;
  created_at: string;
  updated_at: string;
  html_url: string;
  jobs?: CiJobInfo[];
}

export interface CiJobInfo {
  id: number;
  name: string;
  status: string;
  conclusion?: string;
  started_at?: string;
  completed_at?: string;
  steps?: Array<{ name: string; status: string; conclusion?: string }>;
}

export interface CiStatusResult {
  overall: "success" | "failure" | "in_progress" | "no_checks";
  runs: CiRunInfo[];
  check_runs?: Array<{
    name: string;
    status: string;
    conclusion?: string;
    app: string;
    url: string;
    summary?: string;
  }>;
}

export interface CiTriggerArgs {
  workflow: string;
  ref?: string;
  inputs?: Record<string, string>;
}

export interface CiLogsArgs {
  run_id: number;
  job_id?: number;
  tail_lines?: number;
  max_bytes?: number;
}

export interface CiLogsResult {
  logs: string;
  truncated: boolean;
}

export interface CiWaitArgs {
  run_id: number;
  timeout_ms?: number;
  poll_interval_ms?: number;
}

export interface CiWaitResult {
  run_id: number;
  status: string;
  conclusion?: string;
  timed_out: boolean;
}

/** Secrets */
export interface SecretSetArgs {
  name: string;
  value: string;
  expires_in_days?: number;
  expires_at?: number | string;
}

export interface SecretGetArgs {
  name: string;
  reveal?: boolean;
}

export interface SecretMeta {
  name: string;
  length: number;
  sha256_12: string;
  updated_at: number;
  expires_at?: number;
  expired?: boolean;
  days_left?: number;
  last_used_at?: number;
  use_count?: number;
  rotated_at?: number;
}

export interface SecretGetResult {
  name: string;
  value?: string;
  meta: SecretMeta;
}

export interface SecretListResult {
  secrets: SecretMeta[];
}

export interface SecretDeleteArgs {
  name: string;
}

/** GitHub Connect */
export interface GithubConnectStartResult {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export interface GithubConnectPollResult {
  access_token?: string;
  token_type?: string;
  scope?: string;
  expires_in?: number;
  refresh_token?: string;
  pending?: boolean;
  error?: string;
}

export interface GithubConnectStatusResult {
  connected: boolean;
  scopes?: string[];
  expires_at?: number;
}

/** Health / Diagnostics */
export interface HealthResult {
  version: string;
  session_id: string;
  workspace: string;
  data_dir: string;
  audit_db: string;
  capability_id: string;
  shell: {
    running: number;
    completed: number;
    cancelled: number;
    max_output_bytes: number;
    max_timeout_ms: number;
  };
  cache: {
    read_enabled: boolean;
    list_enabled: boolean;
    search_enabled: boolean;
    read_bytes: number;
    list_entries: number;
    search_entries: number;
  };
  audit: {
    fast_mode: boolean;
    rows: number;
    loop_failures: number;
    adoption_runs: number;
  };
  secrets: {
    total: number;
    expired: number;
    with_expiry: number;
  };
  trace?: {
    enabled: boolean;
    file?: string;
    recent: number;
  };
}

export interface ExplainErrorArgs {
  error_text?: string;
  log_tail?: string;
  language?: string;
}

export interface ExplainErrorResult {
  matched: boolean;
  summary: string;
  error_line?: string;
  language?: string;
  diagnoses: Array<{
    rule_id: string;
    likely_cause: string;
    suggested_fix: string;
    retry_hint: string;
    next_actions: Array<{
      tool: string;
      arguments: Record<string, unknown>;
      why: string;
    }>;
  }>;
  next_actions: Array<{
    tool: string;
    arguments: Record<string, unknown>;
    why: string;
  }>;
}

export interface PlanReadBatchArgs {
  task_description: string;
  files_hint?: string[];
  max_files?: number;
  include_search?: boolean;
}

export interface PlanReadBatchResult {
  task: string;
  keywords: string[];
  searched: string[];
  candidates: Array<{
    relative_path: string;
    score: number;
    reason: string;
  }>;
  steps: Array<{
    tool: string;
    arguments: Record<string, unknown>;
    why: string;
  }>;
  estimated_ms: number;
  notes?: string;
}

/** Trace */
export interface TraceStatusArgs {
  limit?: number;
}

export interface TraceEntry {
  timestamp: number;
  operation: string;
  arguments: Record<string, unknown>;
  ms: number;
  cached: boolean;
  ok: boolean;
}

export interface TraceStatusResult {
  traces: TraceEntry[];
  config: {
    enabled: boolean;
    file?: string;
  };
}

/** Scope management */
export interface ScopeOpenArgs {
  session_id: string;
  project_id?: string;
  permission_mode?: "manual" | "best_effort" | "allow_all";
}

export interface ScopeOpenResult {
  capability_id: string;
  project_id: string;
}

export interface ScopeCloseArgs {
  capability_id: string;
}

/** CoreHost API */
export interface VeniraCorehost {
  // Configuration
  configure(config: WorkspaceConfig): void;
  
  // Lifecycle
  warmUp(): Promise<void>;
  snapshot(): HostSnapshot;
  shutdown(): Promise<void>;
  
  // Scope
  openScope(args: ScopeOpenArgs): Promise<ScopeOpenResult>;
  closeScope(args: ScopeCloseArgs): Promise<{ closed: boolean }>;
  
  // File operations
  readFile(args: ReadFileArgs): Promise<NativeResponse<ReadFileResult>>;
  readBatch(args: ReadBatchArgs): Promise<NativeResponse<ReadBatchItemResult[]>>;
  writeFile(args: WriteFileArgs): Promise<NativeResponse<WriteFileResult>>;
  editFile(args: EditFileArgs): Promise<NativeResponse<EditFileResult>>;
  deletePath(args: DeletePathArgs): Promise<NativeResponse<{ deleted: boolean }>>;
  createDirectory(args: CreateDirectoryArgs): Promise<NativeResponse<{ created: boolean }>>;
  listFiles(args: ListFilesArgs): Promise<NativeResponse<{ entries: Array<{ relative_path: string; kind: string; size?: number; mtime_ms?: number }> }>>;
  getFileInfo(args: GetFileInfoArgs): Promise<NativeResponse<{ relative_path: string; kind: string; size: number; mtime_ms: number }>>;
  
  // Search
  search(args: SearchArgs): Promise<NativeResponse<SearchResult>>;
  
  // Shell
  shellRun(args: ShellRunArgs): Promise<NativeResponse<ShellRunResult>>;
  shellStatus(args: ShellStatusArgs): Promise<NativeResponse<ShellRunResult>>;
  shellCancel(args: ShellCancelArgs): Promise<NativeResponse<{ cancelled: boolean }>>;
  shellCancelSession(): Promise<NativeResponse<ShellCancelSessionResult>>;
  
  // Code intelligence
  outlineSymbol(args: OutlineSymbolArgs): Promise<NativeResponse<OutlineResult>>;
  fileSymbols(args: FileSymbolsArgs): Promise<NativeResponse<FileSymbolsResult>>;
  symbolReferences(args: SymbolReferencesArgs): Promise<NativeResponse<SymbolReferencesResult>>;
  diffFiles(args: DiffFilesArgs): Promise<NativeResponse<DiffFilesResult>>;
  selectiveSearch(args: SelectiveSearchArgs): Promise<NativeResponse<SelectiveSearchResult>>;
  
  // Recent files
  recentFiles(args: RecentFilesArgs): Promise<NativeResponse<RecentFilesResult>>;
  
  // Snapshots
  snapshotCreate(args: SnapshotCreateArgs): Promise<NativeResponse<SnapshotCreateResult>>;
  snapshotList(): Promise<NativeResponse<SnapshotListResult>>;
  snapshotRestore(args: SnapshotRestoreArgs): Promise<NativeResponse<SnapshotRestoreResult>>;
  snapshotDelete(args: SnapshotDeleteArgs): Promise<NativeResponse<{ deleted: boolean }>>;
  
  // Git/PR
  prCreate(args: PrCreateArgs): Promise<NativeResponse<PrCreateResult>>;
  prComment(args: PrCommentArgs): Promise<NativeResponse<PrCommentResult>>;
  prMerge(args: PrMergeArgs): Promise<NativeResponse<PrMergeResult>>;
  prList(args: PrListArgs): Promise<NativeResponse<PrListResult>>;
  prClose(args: PrCloseArgs): Promise<NativeResponse<{ closed: boolean }>>;
  prReopen(args: PrReopenArgs): Promise<NativeResponse<{ reopened: boolean }>>;
  
  // CI
  ciStatus(args: CiStatusArgs): Promise<NativeResponse<CiStatusResult>>;
  ciTrigger(args: CiTriggerArgs): Promise<NativeResponse<{ triggered: boolean; run_id: number }>>;
  ciLogs(args: CiLogsArgs): Promise<NativeResponse<CiLogsResult>>;
  ciWait(args: CiWaitArgs): Promise<NativeResponse<CiWaitResult>>;
  
  // Secrets
  secretSet(args: SecretSetArgs): Promise<NativeResponse<{ set: boolean }>>;
  secretGet(args: SecretGetArgs): Promise<NativeResponse<SecretGetResult>>;
  secretList(): Promise<NativeResponse<SecretListResult>>;
  secretDelete(args: SecretDeleteArgs): Promise<NativeResponse<{ deleted: boolean }>>;
  
  // GitHub Connect
  githubConnectStart(): Promise<NativeResponse<GithubConnectStartResult>>;
  githubConnectPoll(device_code: string): Promise<NativeResponse<GithubConnectPollResult>>;
  githubConnectStatus(): Promise<NativeResponse<GithubConnectStatusResult>>;
  
  // Health / Diagnostics
  health(): Promise<NativeResponse<HealthResult>>;
  explainError(args: ExplainErrorArgs): Promise<NativeResponse<ExplainErrorResult>>;
  planReadBatch(args: PlanReadBatchArgs): Promise<NativeResponse<PlanReadBatchResult>>;
  
  // Trace
  traceStatus(args?: TraceStatusArgs): Promise<NativeResponse<TraceStatusResult>>;
  
  // Self-install
  detectHarnesses(): Promise<NativeResponse<Record<string, { config_path: string; exists: boolean }>>>;
  installSelf(client: string, config?: Record<string, unknown>): Promise<NativeResponse<{ status: string }>>;
}