// English copy. Strings may contain `inline code` and [links](/path/); they go
// through the same inline renderer as the Markdown content.
export default {
  code: "en",
  htmlLang: "en",
  dateLocale: "en-US",
  name: "English",
  seo: {
    siteTitle: "venira-mcp: workspace tools for coding agents",
    siteDescription:
      "venira-mcp is an MCP server that lets coding agents read, edit and run commands in one project folder, with an audit trail and git-free rollback.",
  },
  ui: {
    skip: "Skip to content",
    docs: "Docs",
    blog: "Blog",
    github: "GitHub",
    npm: "npm",
    language: "Language",
    mainNav: "Main",
    copy: "Copy",
    copied: "Copied",
    docsMenu: "Documentation pages",
    published: "Published",
    allPosts: "All posts",
    latestPosts: "From the blog",
    notFoundTitle: "Page not found",
    notFoundText: "This page does not exist. It may have moved.",
    backHome: "Back to the home page",
    license: "Licensed under AGPL-3.0-only",
    source: "Source on GitHub",
    rss: "RSS feed",
    docsIndexTitle: "Documentation",
    docsIndexLead: "Set up venira-mcp, choose a tool mode and decide how much your agent may do.",
    blogIndexTitle: "Blog",
    blogIndexLead: "Release notes, benchmarks and design notes for venira-mcp.",
    noPosts: "No posts yet.",
    onThisPage: "On this page",
  },
  home: {
    heroTitle: "Give your coding agent a workspace. Keep the receipts.",
    heroLead:
      "venira-mcp is an MCP server for Claude Desktop, OpenCode, Cursor, VS Code and Codex. It reads, edits and runs commands inside one project folder, records every call in an audit trail, and rolls back with checkpoints, no git required.",
    installLabel: "Install in your project, then restart your client",
    worksWith: "Needs Node 20 or newer. One native dependency (better-sqlite3), no external binary.",
    ledgerCaption: "Example session",
    ledgerNote:
      "Illustrative. Verdicts follow the default `balanced` security profile.",
    ledgerCols: { n: "No.", tool: "Tool", detail: "What happened", verdict: "Verdict" },
    verdicts: { allowed: "allowed", ask: "needs approval", deny: "denied" },
    ledgerRows: [
      { tool: "read_file", text: "Eight files in one batch call", verdict: "allowed" },
      {
        tool: "snapshot",
        text: "Checkpoint `snap-20261113-001500-3f9ac2` before the refactor",
        verdict: "allowed",
      },
      {
        tool: "edit_file",
        text: "Rename `loadConfig` to `readConfig`. The reason is stored with the call",
        verdict: "allowed",
      },
      { tool: "shell_run", text: "`Remove-Item -Recurse -Force build`", verdict: "ask" },
      { tool: "shell_run", text: "`rm -rf /`", verdict: "deny" },
      {
        tool: "snapshot",
        text: "Restore the checkpoint, previewed with `dry_run` first",
        verdict: "allowed",
      },
    ],
    trustTitle: "Built to be checked",
    trustLead:
      "An agent with write access needs a paper trail. These are the parts venira-mcp gives you for that.",
    trustItems: [
      {
        title: "Every call is audited",
        text: "Each tool call lands in a SQLite audit trail. Mutations can carry a reason, so `read_audit` shows what the agent changed and why.",
      },
      {
        title: "Undo without git",
        text: "`snapshot` creates content-addressed checkpoints and restores them atomically, file by file. Preview a restore with `dry_run` before you commit to it.",
      },
      {
        title: "Rules run before the shell does",
        text: "Commands are classified as allow, ask or deny before they execute. In the default profile `rm -rf /` is denied and recursive force deletes need your approval.",
      },
      {
        title: "Stale edits are refused",
        text: "`write_file` and `edit_file` take `expected_sha256`. If the file changed in the meantime the call fails with `stale_content` instead of overwriting newer work.",
      },
    ],
    limitsTitle: "A guard rail, not a sandbox",
    limitsText:
      "venira-mcp runs with the privileges of the OS user that started it. The workspace lock limits which paths the file tools touch, not what an approved shell command does. For untrusted workspaces, or whenever you need real isolation, run it in a container or VM. Read the [security notes](/docs/security/).",
    modesTitle: "Choose how much to expose",
    modesLead:
      "Every tool schema costs tokens on every prompt, so the tool set is a setting. Switch it with `VENIRA_TOOL_MODE`.",
    modesCols: ["Mode", "Tools", "Good for", "Contents"],
    modesRows: [
      ["`core`", "18", "Small models and tight context", "Shell, read, search, edit, snapshot, git, memory"],
      ["`default`", "31", "Everyday coding", "Core plus code intelligence, no CI/CD"],
      ["`expert`", "44", "Full workflows", "Default plus pull requests and CI"],
    ],
    modesNote: "Each mode has one tool fewer when `execute_js` is switched off. Details in [tool modes](/docs/tool-modes/).",
    speedTitle: "Fewer round trips",
    speedLead:
      "Batch reads and a persistent connection beat starting a fresh shell for every lookup. Median times from one Windows 11 machine, compared with Codex `exec_command`, 20 paired samples per phase.",
    speedCols: ["Workload", "Cache", "venira-mcp", "exec_command", "Faster by"],
    speedRows: [
      ["First lines of 8 files, one batch", "miss", "53.5 ms", "962 ms", "18.0x"],
      ["First lines of 8 files, one batch", "warm", "39 ms", "1,103.5 ms", "28.3x"],
      ["Search the workspace, 49 hits", "miss", "118.5 ms", "1,034.5 ms", "8.7x"],
      ["Search the workspace, 49 hits", "warm", "34.5 ms", "1,018 ms", "29.5x"],
    ],
    speedNote:
      "One machine and a small sample, so read it as a direction and not a guarantee. Method and raw samples are published. See [the write-up](/blog/benchmark-agent-tool-path/).",
    setupTitle: "Connect it to your client",
    setupLead:
      "The installer finds your client and writes the config for you. To do it by hand, pick yours.",
    setupNote:
      "Replace the path with your project folder, restart the client, then call `health` to check the server.",
  },
};
