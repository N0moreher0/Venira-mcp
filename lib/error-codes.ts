/**
 * Venira error codes: the one table the envelope and `explain_error` share.
 *
 * Why this file exists
 * --------------------
 * Two places have to know every code Venira can return:
 *   - the error envelope (`lib/output.ts`), which prints the code and a hint;
 *   - `explain_error` (`lib/diagnostics.ts`), which turns a pasted error into a
 *     diagnosis.
 * When the two tables live apart they drift, and the drift is invisible: the
 * envelope happily returns a code the diagnostics table never heard of, so an
 * agent that pasted Venira's own failure got "No known signature matched -
 * triage manually" and no next action. One table, imported by both, makes that
 * class of bug impossible.
 *
 * The split is deliberate:
 *   - ERROR_CODE_HINTS       - the envelope hint: what to do next (one line).
 *   - ERROR_CODE_GUIDES      - the diagnosis: what happened and why.
 *   - ERROR_CODE_NEXT_ACTIONS- the recovery call for the codes that have one.
 * A code with a hand-written rule in lib/diagnostics.ts (path_escape,
 * stale_content, repeated_failure, ...) is diagnosed there with a richer
 * cause; ERROR_CODE_GUIDES only covers the codes no rule describes.
 */

/** The envelope hint for a code: what the agent should do next. */
export const ERROR_CODE_HINTS: Record<string, string> = {
  invalid_request: "Check argument names, types and values against the tool schema; unknown fields are rejected.",
  not_found: "Check the path with list_files or search first; do not retry the same path.",
  conflict: "The file changed or the edit is ambiguous; re-read it and retry.",
  scope_denied: "Use a path inside the workspace (workspace-relative is safest).",
  path_escape: "Paths must stay inside the workspace. Use a relative path under it, or enable VENIRA_UNRESTRICTED=1.",
  resource_limit: "Narrow the request: smaller limit/max_bytes, line ranges, or read_file (multi-file).",
  audit_unavailable:
    "The host refused the operation because its audit row could not be written. Tell the user; do not retry in a loop.",
  capability_expired: "The scope is reopened automatically on the next call; retry once.",
  sensitive_result: "Content withheld for safety; do not retry or work around it.",
  unsupported: "The operation is unavailable in the current permission mode or for this file type.",
  io_error: "The file may be locked or the disk busy; retry once.",
  host_timeout: "The backend did not answer in time; check health, then retry once.",
  host_unavailable: "The backend is unavailable; it restarts on the next call. Retry once.",
  internal: "Unexpected error; check health and the server stderr log.",
  feature_disabled:
    "Switched off by the operator; no approval will enable it. Do not retry; tell the user the hint (VENIRA_* flag) or ask them to do it manually.",
  approval_required:
    "NOT run: a human must approve. Stop; tell the user the approval_id and data.approval.approve_command. After they confirm, retry the same call once with approval_id. Never invent or reuse an id.",
  approval_invalid:
    "approval_id is single-use, bound to the exact command/shell/cwd/secret_env, and expires. Call again without it for a fresh approval_required; a human must grant the new id.",
  command_denied:
    "Policy refuses this command in every mode. Do not retry or rephrase; ask the user to run it manually if needed.",
  old_text_not_found:
    "The text to replace is not in the file. data.mismatch says the line, the first differing character and how many characters are off; data.context.text is three lines around the wrong spot (no line numbers) - copy it into old_text. The file was not changed.",
  old_text_ambiguous:
    "old_text matches more than one place. Extend it with surrounding context, or set replace_all=true. The file was not changed.",
  stale_content:
    "The file changed since you read it. Read it again with read_file, rebuild the patch against the current content and send the new sha256 as expected_sha256. Never replay the same edit unchanged.",
  repeated_failure:
    "This exact invocation already failed in this session. Read data.previous.stderr_tail, fix the cause, then change the command or its inputs. Pass retry_failed=true only for a deliberate rerun of the identical command.",
  batch_failed: "Check data.atomic for rollback state, fix the failed item, resubmit the rest.",
  batch_partial_failure: "Fix or drop the failed items in data.responses, retry only those.",
  config_invalid: "Fix the named VENIRA_* setting or config value and restart; do not retry unchanged.",
  workspace_switch_denied: "Workspace switching is disabled; stay in the current workspace.",
  override_not_enabled: "Override not enabled by the operator; do not retry, ask the user to run it manually.",
  override_scope_mismatch: "Override does not cover this command; ask the user to run it manually.",
  checkpoint_failed: "Pre-command snapshot failed, command not run. Create a scoped snapshot, then retry.",
  shell_unavailable:
    "The shell binary is not installed or not on PATH; nothing ran. Follow error.message to install it or pick another shell; do not retry unchanged.",
  snapshot_corrupt: "Snapshot is damaged; pick another id from snapshot action=list.",
  snapshot_unsafe_path: "Snapshot lists a path outside the workspace and is not restored; pick another id, or snapshot action=delete removes it.",
  snapshot_version_unsupported: "Snapshot format not supported by this version; use a newer snapshot or upgrade.",
  mirror_conflict: "Snapshot mirror differs from primary; change nothing and check health.",
  secret_missing: "No such secret; see secret action=list or create it with action=set.",
  secret_expired: "Secret expired; ask the user for a new one (secret action=set).",
  secret_store_locked: "Secret store locked by another process; retry once.",
  secret_store_corrupt: "Secret store unreadable; do not delete it, tell the user.",
  lock_timeout: "Lock held by another process; retry once, do not loop.",
  secret_detected: "Content looks like a credential and was blocked; remove it and retry.",
  secret_output_blocked: "Output contained a secret and was withheld; tell the user.",
  secret_scan_failed: "Secret scan failed, nothing sent; retry once with a smaller body.",
  secret_scan_limit: "Content too large to scan; send a smaller body.",
  auth_missing: "No credential; run github_connect or store a token with secret.",
  auth_failed: "Provider rejected the credential; ask the user to reconnect or replace it.",
  forbidden: "Credential lacks permission for this repo/action; check token scopes with the user.",
  rate_limited: "Rate limited; wait until the reset time before retrying, do not loop.",
  network_blocked: "Network access is blocked by policy; tell the user, do not retry.",
  network_error: "Network failed; check connectivity, retry once.",
  timeout: "Timed out; retry once with a smaller scope.",
  provider_error: "Provider error; retry once, then check its status page.",
  repo_unresolved: 'Pass repo as "owner/name" or set VENIRA_GIT_REPO.',
  detached_head: "No current branch (detached HEAD); pass an explicit ref/head.",
  already_exists: "Already exists; update the existing one instead.",
  already_configured: "Credential already set; use replace_existing=true only if the user wants to replace it.",
};

/** The recovery call for the codes that have one (ready to send). */
export const ERROR_CODE_NEXT_ACTIONS: Record<string, unknown[]> = {
  not_found: [{ tool: "list_files", arguments: { relative_path: "." }, why: "locate the correct path" }],
  path_escape: [{ tool: "list_files", arguments: { relative_path: "." }, why: "stay inside the workspace" }],
  snapshot_corrupt: [{ tool: "snapshot", arguments: { action: "list" }, why: "pick another checkpoint" }],
  snapshot_unsafe_path: [{ tool: "snapshot", arguments: { action: "list" }, why: "pick another checkpoint" }],
  secret_missing: [{ tool: "secret", arguments: { action: "list" }, why: "see stored names" }],
};

/**
 * The diagnosis for a code: what happened, in one line.
 *
 * Only codes WITHOUT a hand-written rule in lib/diagnostics.ts are listed.
 */
export const ERROR_CODE_GUIDES: Record<string, { title: string; cause: string }> = {

  "already_configured": { title: "Credential is already configured", cause: "The provider credential is already stored, so the call would replace it; the user did not ask for that." },
  "already_exists": { title: "Target already exists", cause: "The path or the name is taken, so the create would overwrite something." },
  "approval_invalid": { title: "Approval id is invalid", cause: "The approval_id is unknown, already used or expired; a fresh approval is needed." },
  "auth_failed": { title: "Provider rejected the credential", cause: "The provider refused the token (invalid, revoked or expired)." },
  "auth_missing": { title: "No credential configured", cause: "The call needs a provider credential and none is stored." },
  "batch_failed": { title: "Batch failed", cause: "At least one item of the batch failed; the envelope names the failed index." },
  "batch_partial_failure": { title: "Batch partially failed", cause: "Some items of the batch succeeded and some failed; the successful ones are in data.responses." },
  "capability_expired": { title: "Capability scope expired", cause: "The capability window closed; the next call re-opens it." },
  "checkpoint_failed": { title: "Checkpoint failed", cause: "The pre-command snapshot could not be written, so the command did not run." },
  "config_invalid": { title: "Configuration is invalid", cause: "A VENIRA_* setting or a config value cannot be parsed or is out of range." },
  "conflict": { title: "File changed or edit is ambiguous", cause: "The file changed under the edit, or the text matched more than one place." },
  "detached_head": { title: "Detached HEAD", cause: "There is no current branch, so a relative ref has no target." },
  "feature_disabled": { title: "Feature disabled by the operator", cause: "The operator switched this capability off; no approval re-enables it." },
  "forbidden": { title: "Provider denied the request", cause: "The credential is valid but lacks permission for this repo, action or path." },
  "host_timeout": { title: "Backend timed out", cause: "The backend did not answer within the request budget." },
  "host_unavailable": { title: "Backend unavailable", cause: "The backend could not be reached; it restarts on the next call." },
  "internal": { title: "Unexpected internal error", cause: "The server reached a state it does not model; check health and the server log." },
  "io_error": { title: "Filesystem error", cause: "The file may be locked, the disk busy, or the path not readable." },
  "lock_timeout": { title: "Lock timeout", cause: "Another process holds the lock longer than the timeout allows." },
  "mirror_conflict": { title: "Snapshot mirror conflict", cause: "The mirrored checkpoint differs from the primary one." },
  "network_blocked": { title: "Network blocked", cause: "Policy blocks the network call; it will not run." },
  "network_error": { title: "Network failure", cause: "The request never completed (DNS, TLS, connection reset)." },
  "not_found": { title: "Path or object not found", cause: "The path, run id, secret name or checkpoint id does not exist in the current scope." },
  "old_text_ambiguous": { title: "old_text is ambiguous", cause: "old_text matches more than one place, so the edit was refused." },
  "override_not_enabled": { title: "Override not enabled", cause: "The operator has not enabled the override this command needs." },
  "override_scope_mismatch": { title: "Override does not cover this command", cause: "An override exists but it does not cover this command or path." },
  "provider_error": { title: "Provider error", cause: "The provider failed for a reason other than authentication or rate limiting." },
  "rate_limited": { title: "Rate limited", cause: "The provider is throttling; wait for the reset time instead of retrying." },
  "repo_unresolved": { title: "Repository not resolved", cause: "The call names no repo and VENIRA_GIT_REPO is not set." },
  "resource_limit": { title: "Request too large", cause: "The request exceeded a documented limit (size, count, regex complexity)." },
  "secret_detected": { title: "Secret detected and blocked", cause: "The content looked like a credential, so it was not sent." },
  "secret_output_blocked": { title: "Output withheld (secret)", cause: "The output contained a credential and was withheld." },
  "secret_scan_failed": { title: "Secret scan failed", cause: "The scanner could not read the body, so nothing was sent." },
  "secret_scan_limit": { title: "Body too large to scan", cause: "The body exceeds the size the secret scanner reads." },
  "secret_store_corrupt": { title: "Secret store unreadable", cause: "The encrypted store cannot be read; do not delete it." },
  "secret_store_locked": { title: "Secret store locked", cause: "Another process holds the store lock." },
  "snapshot_corrupt": { title: "Checkpoint damaged", cause: "The checkpoint index is broken; pick another id or delete this one." },
  "snapshot_unsafe_path": { title: "Checkpoint lists a path outside the workspace", cause: "The checkpoint manifest points outside the workspace, so it is not restored." },
  "snapshot_version_unsupported": { title: "Checkpoint written by a newer version", cause: "This build cannot read that manifest version." },
  "timeout": { title: "Operation timed out", cause: "The call exceeded its timeout; retry once with a smaller scope." },
  "unsupported": { title: "Operation unsupported", cause: "The current tool mode, permission profile or file type does not support this call." },
  "workspace_switch_denied": { title: "Workspace switch denied", cause: "The security profile limits which workspace the call may switch to." },
};

/**
 * Every code the envelope can return.
 *
 * Derived from the hint table so a new code cannot be added to one and
 * forgotten in the other. `explain_error` matches a pasted error against this
 * list; a code that is not here is a code the server cannot produce.
 */
export const ALL_ERROR_CODES: readonly string[] = Object.keys(ERROR_CODE_HINTS);
