# Project Instructions - Venira MCP Coding Workflow

Prior to use Venira-mcp for coding, use `mcp__venira__project_recent_files` for know the recently files edited, use `mcp__venira__project_snapshot` for saving files and restoring.

This is persistent pre-prompt / RAG-style instruction for OpenCode. It is loaded automatically at the start of every session alongside AGENTS.md files and the `instructions` array in `opencode.jsonc`.

## 1. Before any coding task - check recent files

Always start with `mcp__venira__project_recent_files` (limit 10-20) to know what was recently edited, or what the user / a command just touched.

- At start of task, when resuming, after context loss, before editing a file the user may have changed, and after build / formatter / git / shell run.
- Feed top paths straight into `mcp__venira__project_read_batch` (max 8 items).
- Use `session_edits` field to see what you already wrote in this session.
- Do NOT guess files or search blindly when recent_files can tell you.

Example call:
`mcp__venira__project_recent_files({ limit: 15 })`

## 2. Before risky edits - snapshot for saving and restoring

Use `mcp__venira__project_snapshot` BEFORE:
- multi-file edits, refactors / renames
- overwriting an existing file (`project_write_file mode=overwrite`)
- `project_edit_batch` on existing files
- hard-to-reverse shell / JS changes
- any `project_delete_path`

Snapshot rules:
- Create scoped checkpoint with descriptive label, keep returned id.
- Check file_count / truncated / skipped - confirm required files captured before mutating.
- Skip snapshot only for tiny, easy-to-recreate single-file edit or new-file creation.
- For rollback: run restore with `dry_run=1` first (preview only, does not detect same-size changes). Inspect newer user edits. Then restore exact id with `verify=1, delete_extra=0`. Never set `delete_extra=1` unless deletion is explicitly requested.

## 3. Read / Search / Edit patterns

- 2+ reads or mixed read-only steps -> `mcp__venira__project_read_batch` (max 8, sequential + cached)
- One file -> `mcp__venira__project_read_file` (use start_line/end_line or ranges for large files, follow next_start_line)
- Find code -> `mcp__venira__project_search` (kind=literal_content or definition), then read ranges around hits
- Directory tree -> `mcp__venira__project_list_files` (depth 1-3, limit <=200)
- One file change -> `mcp__venira__project_edit_file`
- Whole file -> `mcp__venira__project_write_file`
- Delete -> `mcp__venira__project_delete_path` (destructive, after snapshot)

Paths are workspace-relative. Always pass `reason` ("why"), audit-logged, <=400 chars.

## 4. Shell / Build / Test

- Build/test/long command -> `mcp__venira__project_shell_run` (returns run_id), then poll `mcp__venira__project_shell_status` with wait_seconds 5-30 until running=false.
- Need final output in-call? Use background=0, keep under request timeout or async + poll.
- After build / formatter / git -> call project_recent_files again to see real changes.

## 5. Order of operations (checklist)

1. project_recent_files
2. project_snapshot (if risky / multi-file)
3. project_read_batch / project_search
4. project_edit_file / project_write_file (with reason)
5. project_shell_run for build/test
6. project_recent_files again to verify changes
