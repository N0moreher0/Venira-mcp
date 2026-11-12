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

import { existsSync, readFileSync, copyFileSync, mkdirSync } from "node:fs";
import * as fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { applyEdits, modify, parse as parseJsonc, printParseErrorCode } from "jsonc-parser";

type HarnessName =
  | "opencode"
  | "claude_desktop"
  | "cursor"
  | "codex"
  | "kimi"
  | "deepseek"
  | "antigravity";

type PrintableClient = "vscode" | HarnessName;
type InstallTarget = HarnessName | "vscode";

type InstallResult = {
  harness: InstallTarget;
  config_path: string;
  status: "installed" | "already_present" | "config_missing" | "error" | "would_merge" | "would_create";
  needs_restart: boolean;
  error?: string;
  /** A dry run writes nothing: it reports what would happen. */
  dry_run?: boolean;
  note?: string;
};

type DetectResult = {
  harness: HarnessName;
  detected: boolean;
  config_path?: string;
  format?: "json" | "jsonc" | "toml" | "unknown";
  note?: string;
};

const HARNESS_NAMES: HarnessName[] = [
  "opencode",
  "claude_desktop",
  "cursor",
  "codex",
  "kimi",
  "deepseek",
  "antigravity",
];

const PRINTABLE_CLIENTS: PrintableClient[] = ["vscode", ...HARNESS_NAMES];

// `--package` avoids npx picking a different bin when a package exposes two.
const NPX_ARGS = ["--yes", "--package=venira-mcp@latest", "venira-mcp"] as const;

// ---------------------------------------------------------------------------
// Config path detection (per-harness, cross-platform)
// ---------------------------------------------------------------------------

function homeDir(): string {
  return os.homedir();
}

function platformSpecificPaths(harness: HarnessName): string[] {
  const home = homeDir();
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
 *
 * Keep the defaults cross-platform: do not pin a shell or a data directory.
 * The server resolves both from the host OS when they are unset, and the CLI
 * and MCP client then share the same per-user vault.
 */
function veniraMcpEntry(opts: { workspace?: string; dataDir?: string }): {
  executable: string;
  args: string[];
  command: string[];
  environment: Record<string, string>;
} {
  const workspace = opts.workspace ?? process.cwd();
  const environment: Record<string, string> = {
    VENIRA_WORKSPACE: workspace,
    VENIRA_UNRESTRICTED: "0",
    VENIRA_SECURITY_PROFILE: "balanced",
    VENIRA_PERMISSION_MODE: "allow_all",
    VENIRA_OUTPUT_MODE: "full",
  };
  if (opts.dataDir) environment.VENIRA_DATA_DIR = opts.dataDir;
  return {
    executable: "npx",
    args: [...NPX_ARGS],
    command: ["npx", ...NPX_ARGS],
    environment,
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
  mkdirSync(dir, { recursive: true });
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

/** True when the file already contains a Venira entry (never throws). */
function veniraPresentInFile(
  file: string,
  format: "json" | "jsonc" | "toml" | "unknown",
  mcpBlockName: JsonBlockName,
): boolean {
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return false;
  }
  if (format === "toml") return text.includes("[mcp_servers.venira]");
  const errors: { error: number; offset: number; length: number }[] = [];
  const parsed = parseJsonc(text, errors, { allowTrailingComma: true });
  if (errors.length > 0 || !parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return false;
  }
  const section = (parsed as Record<string, unknown>)[mcpBlockName];
  return Boolean(
    section && typeof section === "object" && !Array.isArray(section) &&
    Object.prototype.hasOwnProperty.call(section, "venira"),
  );
}

type JsonBlockName = "mcp" | "mcpServers" | "servers";

function newJsonConfig(mcpBlockName: JsonBlockName): string {
  const base = mcpBlockName === "mcp"
    ? { $schema: "https://opencode.ai/config.json", mcp: {} }
    : mcpBlockName === "servers"
      ? { servers: {} }
      : { mcpServers: {} };
  return `${JSON.stringify(base, null, 2)}\n`;
}

/** Parse and edit JSON/JSONC while preserving comments and existing formatting. */
export async function installJsonLike(
  file: string,
  mcpBlockName: JsonBlockName,
  config: {
    workspace?: string;
    workspaceOverride?: string;
    dataDir?: string;
    harness?: InstallTarget;
    create?: boolean;
  },
): Promise<InstallResult> {
  const harness = config.harness ??
    (mcpBlockName === "mcp" ? "opencode" : mcpBlockName === "servers" ? "vscode" : "claude_desktop");
  let existing = "";
  let created = false;
  try {
    existing = readFileSync(file, "utf8");
  } catch {
    // Never overwrite a file that exists but cannot be read (e.g. permissions).
    if (!config.create || existsSync(file)) {
      return {
        harness,
        config_path: file,
        status: "config_missing",
        needs_restart: true,
        error: existsSync(file)
          ? "Config file exists but could not be read; manual merge required."
          : "Could not read config file. Re-run with --create to create it.",
      };
    }
    existing = newJsonConfig(mcpBlockName);
    created = true;
  }

  if (!existing.trim()) {
    if (!config.create) {
      return {
        harness,
        config_path: file,
        status: "config_missing",
        needs_restart: true,
        error: "Config file is empty. Re-run with --create to initialize it.",
      };
    }
    existing = newJsonConfig(mcpBlockName);
    created = true;
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

  const block = veniraMcpEntry({
    workspace: config.workspaceOverride ?? config.workspace,
    dataDir: config.dataDir,
  });
  const entry = mcpBlockName === "mcp"
    ? {
        type: "local",
        command: block.command,
        enabled: true,
        environment: block.environment,
      }
    : mcpBlockName === "servers"
      ? {
          type: "stdio",
          command: block.executable,
          args: block.args,
          env: block.environment,
        }
      : {
          command: block.executable,
          args: block.args,
          env: block.environment,
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
  if (!created) backupFile(file);
  writeAtomicFileSync(file, applyEdits(existing, edits));
  return { harness, config_path: file, status: "installed", needs_restart: true };
}

function tomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function tomlBlock(block: ReturnType<typeof veniraMcpEntry>): string {
  const envSection = Object.entries(block.environment)
    .map(([k, v]) => `${k} = ${tomlString(v)}`)
    .join("\n");
  return `[mcp_servers.venira]
command = ${tomlString(block.executable)}
args = [${block.args.map(tomlString).join(", ")}]
startup_timeout_sec = 120

[mcp_servers.venira.env]
${envSection}
`;
}

/**
 * For TOML files (Codex): append a [mcp_servers.venira] section.
 */
async function installToml(
  file: string,
  config: { workspace?: string; dataDir?: string; create?: boolean },
): Promise<InstallResult> {
  let existing = "";
  let created = false;
  try {
    existing = readFileSync(file, "utf8");
  } catch {
    if (!config.create) {
      return {
        harness: "codex",
        config_path: file,
        status: "config_missing",
        needs_restart: true,
        error: "Could not read config file. Re-run with --create to create it.",
      };
    }
    created = true;
  }

  if (existing.includes("[mcp_servers.venira]")) {
    return {
      harness: "codex",
      config_path: file,
      status: "already_present",
      needs_restart: false,
    };
  }

  const block = veniraMcpEntry(config);
  const content = `${existing.trimEnd()}${existing.trim() ? "\n\n" : ""}${tomlBlock(block)}`;
  if (!created) backupFile(file);
  writeAtomicFileSync(file, content);
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
  return HARNESS_NAMES.map((h) => detectHarnessConfig(h));
}

export async function installSelf(opts: {
  harness: HarnessName;
  workspace?: string;
  dataDir?: string;
  dryRun?: boolean;
  create?: boolean;
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

  // For a dry run: report what would happen without writing.
  // Roadmap item 15 (P2): the note used to sit in `error` and the result
  // claimed `needs_restart: true` although nothing was written. A dry run
  // writes nothing, so it needs no restart and reports its own status.
  if (opts.dryRun) {
    const present = veniraPresentInFile(file, det.format ?? "json",
      opts.harness === "opencode" ? "mcp" : "mcpServers");
    const exists = existsSync(file);
    return {
      harness: opts.harness,
      config_path: file,
      status: present ? "already_present" : exists ? "would_merge" : "would_create",
      needs_restart: false,
      dry_run: true,
      note: `DRY RUN: ${present ? "Venira is already present" : exists ? "would merge" : "would create"} in ${file}; no changes written.`,
    };
  }

  const result =
    det.format === "toml"
      ? await installToml(file, opts)
      : await installJsonLike(
          file,
          opts.harness === "opencode" ? "mcp" : "mcpServers",
          {
            workspace: opts.workspace,
            dataDir: opts.dataDir,
            harness: opts.harness,
            create: opts.create,
          },
        );

  result.harness = opts.harness;
  result.error = result.error ? `${result.error} (elapsed ${Math.round(performance.now() - started)}ms)` : undefined;
  return result;
}

/** VS Code keeps its MCP config inside the workspace (`.vscode/mcp.json`). */
export async function installVscodeConfig(opts: {
  workspace?: string;
  dataDir?: string;
  dryRun?: boolean;
  create?: boolean;
}): Promise<InstallResult> {
  const workspace = opts.workspace ?? process.cwd();
  const file = path.join(workspace, ".vscode", "mcp.json");
  if (opts.dryRun) {
    const present = veniraPresentInFile(file, "json", "servers");
    const exists = existsSync(file);
    return {
      harness: "vscode",
      config_path: file,
      status: present ? "already_present" : exists ? "would_merge" : "would_create",
      needs_restart: false,
      dry_run: true,
      note: `DRY RUN: ${present ? "Venira is already present" : exists ? "would merge" : "would create"} in ${file}; no changes written.`,
    };
  }
  return installJsonLike(file, "servers", {
    workspace,
    workspaceOverride: "${workspaceFolder}",
    dataDir: opts.dataDir,
    harness: "vscode",
    create: opts.create ?? true,
  });
}

export function normalizeClient(value: string): PrintableClient | undefined {
  const key = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  const aliases: Record<string, PrintableClient> = {
    vscode: "vscode",
    vs_code: "vscode",
    code: "vscode",
    opencode: "opencode",
    open_code: "opencode",
    claude: "claude_desktop",
    claude_desktop: "claude_desktop",
    cursor: "cursor",
    codex: "codex",
    kimi: "kimi",
    deepseek: "deepseek",
    antigravity: "antigravity",
  };
  return aliases[key];
}

export function clientConfigPath(client: PrintableClient, workspace = process.cwd()): string {
  if (client === "vscode") return path.join(workspace, ".vscode", "mcp.json");
  return detectHarnessConfig(client).config_path ?? "";
}

export function renderClientConfig(
  client: PrintableClient,
  opts: { workspace?: string; dataDir?: string } = {},
): { client: PrintableClient; config_path: string; format: "json" | "toml"; content: string } {
  const workspace = opts.workspace ?? process.cwd();
  const configPath = clientConfigPath(client, workspace);
  const block = veniraMcpEntry({ workspace, dataDir: opts.dataDir });

  if (client === "vscode") {
    const { VENIRA_WORKSPACE: _workspace, ...rest } = block.environment;
    const content = `${JSON.stringify({
      servers: {
        venira: {
          type: "stdio",
          command: block.executable,
          args: block.args,
          env: {
            VENIRA_WORKSPACE: "${workspaceFolder}",
            ...rest,
          },
        },
      },
    }, null, 2)}\n`;
    return { client, config_path: configPath, format: "json", content };
  }

  if (client === "opencode") {
    const content = `${JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      mcp: {
        venira: {
          type: "local",
          command: block.command,
          enabled: true,
          environment: block.environment,
        },
      },
    }, null, 2)}\n`;
    return { client, config_path: configPath, format: "json", content };
  }

  if (client === "codex") {
    return { client, config_path: configPath, format: "toml", content: tomlBlock(block) };
  }

  const content = `${JSON.stringify({
    mcpServers: {
      venira: {
        command: block.executable,
        args: block.args,
        env: block.environment,
      },
    },
  }, null, 2)}\n`;
  return { client, config_path: configPath, format: "json", content };
}

export { HARNESS_NAMES, PRINTABLE_CLIENTS };
export type { HarnessName, PrintableClient, InstallResult, DetectResult };
