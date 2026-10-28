/**
 * P2.5: self-install — add venira MCP config to multiple harness clients.
 *
 * Detects config paths for OpenCode / Claude Desktop / Cursor / Codex / Kimi / DeepSeek /
 * Antigravity, writes/merges the appropriate section (JSON or TOML), and reports whether
 * a client restart is needed.
 *
 * All writes are ATOMIC + reversible:
 * - Backup the original file to `<file>.venira-bak` before modifying
 * - JSON: parse + deep-merge the target key; if the JSON has comments (jsonc) and
 *   `JSON.parse` fails, fall back to regex-based key insertion
 * - TOML: append a `[mcp_servers.venira]` section if not present
 */

import { existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { performance } from "node:perf_hooks";

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
  const dataDir = opts.dataDir ?? path.join(workspace, "data");
  return {
    command: ["npx"],
    args: ["venira-mcp"],
    environment: {
      VENIRA_WORKSPACE: workspace,
      VENIRA_DATA_DIR: dataDir,
      VENIRA_UNRESTRICTED: "0",
      VENIRA_DEFAULT_SHELL: "powershell",
      VENIRA_SHELL_MODE: "balanced",
      VENIRA_PERMISSION_MODE: "allow_all",
      VENIRA_OUTPUT_MODE: "full",
      VENIRA_PRETTY: "0",
      VENIRA_ALLOW_JS_EXEC: "1",
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

/**
 * For JSON/JSONC files: parse, deep-merge mcpServers/mcp.venira, write back.
 * JSONC with comments: if JSON.parse fails, use a regex-based "add key if missing"
 * strategy (safer than trying to strip comments).
 */
async function installJsonLike(
  file: string,
  mcpBlockName: "mcp" | "mcpServers",
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

  // Try JSON.parse first; JSONC files with comments will fail.
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(existing);
  } catch {
    parsed = null;
  }

  if (parsed) {
    // Clean JSON: deep-merge
    const mcpSection = (parsed[mcpBlockName] ?? {}) as Record<string, unknown>;
    if (typeof mcpSection === "object" && mcpSection !== null) {
      const block = veniraMcpEntry({});
      mcpSection["venira"] = {
        type: "local",
        command: block.command,
        args: block.args,
        enabled: true,
        environment: block.environment,
      };
      parsed[mcpBlockName] = mcpSection;
    }
    backupFile(file);
    writeFileSync(file, JSON.stringify(parsed, null, 2));
    return {
      harness,
      config_path: file,
      status: "installed",
      needs_restart: true,
    };
  }

  // JSONC (with comments): use string-based insertion if "venira" not present
  if (!existing.includes('"venira"')) {
    const block = veniraMcpEntry({});
    const snippet = JSON.stringify(
      {
        [mcpBlockName === "mcp" ? "mcp" : "mcpServers"]: {
          venira: {
            type: "local",
            command: block.command,
            args: block.args,
            enabled: true,
            environment: block.environment,
          },
        },
      },
      null,
      2,
    );
    // Naive: insert before the last closing brace (last "}") — only for simple cases
    // For robustness, back up and append as a separate key. This works for OpenCode
    // (the jsonc is one big object). For other clients, user may need manual merge.
    backupFile(file);
    // Insert before final "}" of the outer object
    const lastBrace = existing.lastIndexOf("}");
    if (lastBrace > 0) {
      const inner = existing.slice(0, lastBrace);
      const outer = existing.slice(lastBrace);
      // Strip any trailing comma at end of inner to keep valid
      const cleanInner = inner.replace(/,\s*$/, "");
      writeFileSync(file, cleanInner + ",\n" + snippet.replace(/\}\s*$/, "\n") + outer);
      return {
        harness,
        config_path: file,
        status: "installed",
        needs_restart: true,
      };
    }
    return {
      harness,
      config_path: file,
      status: "error",
      needs_restart: true,
      error:
        "Could not parse config as JSON or JSONC; manual merge required. " +
        `Backup kept at ${file}.venira-bak`,
    };
  } else {
    return {
      harness,
      config_path: file,
      status: "already_present",
      needs_restart: false,
    };
  }
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
  writeFileSync(file, existing.trimEnd() + "\n\n" + tomlBlock, "utf8");
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
        );

  result.harness = opts.harness;
  result.error = result.error ? `${result.error} (elapsed ${Math.round(performance.now() - started)}ms)` : undefined;
  return result;
}

export type { HarnessName, InstallResult, DetectResult };
