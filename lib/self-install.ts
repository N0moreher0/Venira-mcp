/**
 * P2.5: self-install — add venira MCP config to multiple harness clients.
 *
 * Detects config paths for OpenCode / Claude Desktop / Cursor / Codex / Kimi / DeepSeek /
 * Antigravity, writes/merges the appropriate section (JSON or TOML), and reports whether
 * a client restart is needed.
 *
 * All writes are ATOMIC + reversible:
 * - Backup the original file to `<file>.venira-bak` before modifying
 * - JSON/JSONC: parse + edit the target key with jsonc-parser, preserving comments
 * - TOML: append a `[mcp_servers.venira]` section if not present
 */

import { existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import * as fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { applyEdits, modify, parse as parseJsonc, printParseErrorCode } from "jsonc-parser";
import { defaultDataDir } from "./workspace.js";

type HarnessName =
  | "opencode"
  | "claude_desktop"
  | "cursor"
  | "codex"
  | "kimi"
  | "deepseek"
  | "antigravity";

type InstallResult = {
  harness: HarnessName;
  config_path: string;
  status: "installed" | "already_present" | "config_missing" | "error";
  needs_restart: boolean;
  error?: string;
};

type DetectResult = {
  harness: HarnessName;
  detected: boolean;
  config_path?: string;
  format?: "json" | "jsonc" | "toml" | "unknown";
  note?: string;
};

// ---------------------------------------------------------------------------
// Config path detection (per-harness, cross-platform)
// ---------------------------------------------------------------------------

function homeDir(): string {
  return os.homedir();
}

function platformSpecificPaths(harness: HarnessName): string[] {
  const home = homeDir();
  const isWin = process.platform === "win32";
  const appdata = process.env.APPDATA ?? path.join(home, "AppData", "Roaming");
  const local = process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");

  switch (harness) {
    case "opencode":
      // OpenCode uses a single JSONC config
      return [
        path.join(home, ".config", "opencode", "opencode.jsonc"),
        path.join(home, ".config", "opencode", "opencode.json"),
      ];
    case "claude_desktop":
      // Claude Desktop: per-OS app data paths
      return [
        path.join(appdata, "Claude", "claude_desktop_config.json"),
        path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"), // macOS
        path.join(home, ".config", "Claude", "claude_desktop_config.json"), // Linux
      ];
    case "cursor":
      // Cursor IDE: per-OS app data paths
      return [
        path.join(appdata, "Cursor", "mcp.json"),
        path.join(local, "Cursor", "mcp.json"),
        path.join(home, "Library", "Application Support", "Cursor", "mcp.json"), // macOS
        path.join(home, ".config", "Cursor", "mcp.json"), // Linux
      ];
    case "codex":
      // Codex CLI (OpenAI): TOML config in $HOME/.codex
      return [
        path.join(home, ".codex", "config.toml"),
      ];
    case "kimi":
      // Kimi (Moonshot): JSON MCP config
      return [
        path.join(home, ".kimi", "mcp.json"),
        path.join(home, ".kimi", "config.json"),
        path.join(appdata, "Kimi", "mcp.json"),
      ];
    case "deepseek":
      // DeepSeek: JSON MCP config
      return [
        path.join(home, ".deepseek", "mcp.json"),
        path.join(home, ".deepseek", "config.json"),
        path.join(appdata, "DeepSeek", "mcp.json"),
      ];
    case "antigravity":
      // Antigravity (Google): JSON MCP config
      return [
        path.join(home, ".antigravity", "config.json"),
        path.join(home, ".antigravity", "mcp.json"),
        path.join(appdata, "Antigravity", "config.json"),
        path.join(appdata, "Antigravity", "mcp.json"),
      ];
    default:
      return [];
  }
}

function detectHarnessConfig(harness: HarnessName): DetectResult {
  const candidates = platformSpecificPaths(harness);
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      const ext = path.extname(candidate).toLowerCase();
      const format = ext === ".toml" ? "toml" : ext === ".jsonc" ? "jsonc" : "json";
      return {
        harness,
        detected: true,
        config_path: candidate,
        format,
        note: "Config file exists; will merge/append.",
      };
    }
  }
  // If no config file, report the most likely path for creation
  return {
    harness,
    detected: false,
    config_path: candidates[0],
    format: candidates[0]?.endsWith(".toml") ? "toml" : "json",
    note: "Config file not found; will create.",
  };
}

// ---------------------------------------------------------------------------
// Merge helpers
// ---------------------------------------------------------------------------

/**
 * Build the venira MCP entry appropriate for the target format.
 */
function veniraMcpEntry(opts: { workspace?: string; dataDir?: string }): {
  command: string[];
  args: string[];
  environment: Record<string, string>;
} {
  const workspace = opts.workspace ?? process.cwd();
  const dataDir = opts.dataDir ?? defaultDataDir();
  return {
    command: ["npx"],
    args: ["venira-mcp"],
    environment: {
      VENIRA_WORKSPACE: workspace,
      VENIRA_DATA_DIR: dataDir,
      VENIRA_UNRESTRICTED: "0",
      VENIRA_DEFAULT_SHELL: "powershell",
      VENIRA_SHELL_MODE: "balanced",
      VENIRA_PERMISSION_MODE: "manual",
      VENIRA_OUTPUT_MODE: "full",
      VENIRA_PRETTY: "0",
      VENIRA_ALLOW_JS_EXEC: "0",
      VENIRA_AUDIT_FAST: "1",
      VENIRA_READ_CACHE_BYTES: "67108864",
      VENIRA_CACHE_ALL: "1",
      VENIRA_TRACE: "0",
      VENIRA_SHELL_TAIL_MAX: "4000",
      VENIRA_SHELL_EXIT_EARLY: "0",
      VENIRA_SHELL_TIMEOUT_POLICY: "soft",
      VENIRA_EDIT_FUZZY: "0",
    },
  };
}

function backupFile(file: string): string {
  const bak = `${file}.venira-bak`;
  if (!existsSync(bak)) {
    copyFileSync(file, bak);
  }
  return bak;
}

function writeAtomicFileSync(file: string, content: string): void {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.venira-tmp-${process.pid}-${Date.now()}`);
  const delays = [20, 40, 80, 160, 200];
  let attempt = 0;
  while (true) {
    try {
      fsSync.writeFileSync(tmp, content, "utf8");
      try {
        const fd = fsSync.openSync(tmp, "r+");
        fsSync.fsyncSync(fd);
        fsSync.closeSync(fd);
      } catch { /* best-effort */ }
      fsSync.renameSync(tmp, file);
      return;
    } catch (err) {
      try { fsSync.unlinkSync(tmp); } catch { /* ignore */ }
      const code = (err as { code?: string })?.code;
      if ((code === "EPERM" || code === "EBUSY" || code === "EACCES") && attempt < delays.length) {
        const d = delays[attempt++];
        const end = Date.now() + d;
        while (Date.now() < end) { /* spin */ }
        continue;
      }
      throw err;
    }
  }
}

/** Parse and edit JSON/JSONC while preserving comments and existing formatting. */
export async function installJsonLike(
  file: string,
  mcpBlockName: "mcp" | "mcpServers",
  config: { workspace?: string; dataDir?: string },
): Promise<InstallResult> {
  const harness = "unknown" as HarnessName; // set by caller
  let existing = "";
  try {
    existing = readFileSync(file, "utf8");
  } catch {
    return {
      harness,
      config_path: file,
      status: "config_missing",
      needs_restart: true,
      error: "Could not read config file.",
    };
  }

  const errors: { error: number; offset: number; length: number }[] = [];
  const parsed = parseJsonc(existing, errors, { allowTrailingComma: true });
  if (errors.length > 0 || !parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    const detail = errors[0]
      ? `${printParseErrorCode(errors[0].error)} at offset ${errors[0].offset}`
      : "top-level value is not an object";
    return {
      harness,
      config_path: file,
      status: "error",
      needs_restart: true,
      error: `Could not parse config as JSONC (${detail}); manual merge required.`,
    };
  }

  const block = veniraMcpEntry(config);
  const entry = {
    type: "local",
    command: block.command,
    args: block.args,
    enabled: true,
    environment: block.environment,
  };
  const section = (parsed as Record<string, unknown>)[mcpBlockName];
  if (section && typeof section === "object" && !Array.isArray(section) &&
      Object.prototype.hasOwnProperty.call(section, "venira")) {
    return {
      harness,
      config_path: file,
      status: "already_present",
      needs_restart: false,
    };
  }
  const edits = modify(existing, [mcpBlockName, "venira"], entry, {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
  });
  if (edits.length === 0) {
    return { harness, config_path: file, status: "already_present", needs_restart: false };
  }
  backupFile(file);
  writeAtomicFileSync(file, applyEdits(existing, edits));
  return { harness, config_path: file, status: "installed", needs_restart: true };
}

/**
 * For TOML files (Codex): append a [mcp_servers.venira] section.
 */
async function installToml(file: string): Promise<InstallResult> {
  let existing = "";
  try {
    existing = readFileSync(file, "utf8");
  } catch {
    return {
      harness: "codex",
      config_path: file,
      status: "config_missing",
      needs_restart: true,
      error: "Could not read config file.",
    };
  }

  if (existing.includes("[mcp_servers.venira]")) {
    return {
      harness: "codex",
      config_path: file,
      status: "already_present",
      needs_restart: false,
    };
  }

  const block = veniraMcpEntry({});
  const envSection = Object.entries(block.environment)
    .map(([k, v]) => `${k} = "${v}"`)
    .join("\n");
  const tomlBlock = `[mcp_servers.venira]
command = "${block.command[0]}"
args = [${block.args.map((a) => `"${a}"`).join(", ")}]

[mcp_servers.venira.env]
${envSection}
startup_timeout_sec = 120
`;

  backupFile(file);
  writeAtomicFileSync(file, existing.trimEnd() + "\n\n" + tomlBlock);
  return {
    harness: "codex",
    config_path: file,
    status: "installed",
    needs_restart: true,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function detectAllHarnesses(): DetectResult[] {
  const harnesses: HarnessName[] = [
    "opencode",
    "claude_desktop",
    "cursor",
    "codex",
    "kimi",
    "deepseek",
    "antigravity",
  ];
  return harnesses.map((h) => detectHarnessConfig(h));
}

export async function installSelf(opts: {
  harness: HarnessName;
  workspace?: string;
  dataDir?: string;
  dryRun?: boolean;
}): Promise<InstallResult> {
  const started = performance.now();
  const det = detectHarnessConfig(opts.harness);
  const file = det.config_path;
  if (!file) {
    return {
      harness: opts.harness,
      config_path: "",
      status: "error",
      needs_restart: false,
      error: `No known config path for ${opts.harness}.`,
    };
  }

  // For a dry run: report what would happen without writing
  if (opts.dryRun) {
    const wouldBeExisting = existsSync(file) ? "exists" : "missing";
    return {
      harness: opts.harness,
      config_path: file,
      status: wouldBeExisting === "exists" ? "already_present" : "config_missing",
      needs_restart: true,
      error: `DRY RUN: ${file} ${wouldBeExisting}; no changes written.`,
    };
  }

  const result =
    det.format === "toml"
      ? await installToml(file)
      : await installJsonLike(
          file,
          opts.harness === "opencode" ? "mcp" : "mcpServers",
          { workspace: opts.workspace, dataDir: opts.dataDir },
        );

  result.harness = opts.harness;
  result.error = result.error ? `${result.error} (elapsed ${Math.round(performance.now() - started)}ms)` : undefined;
  return result;
}

export type { HarnessName, InstallResult, DetectResult };
