/**
 * One-command MCP client setup.
 *
 *   npx venira-mcp --install [auto|vscode|opencode|claude_desktop|cursor|codex|kimi|deepseek|antigravity]
 *   npx venira-mcp --print-config [client] [--json]
 *
 * `--install auto` only merges into configs that already exist. Naming a client
 * explicitly creates its config file when missing (including `.vscode/mcp.json`).
 * `--print-config` never writes anything, so it is safe for an agent to use
 * before Venira itself is connected.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import {
  PRINTABLE_CLIENTS,
  detectAllHarnesses,
  installSelf,
  installVscodeConfig,
  normalizeClient,
  renderClientConfig,
  type PrintableClient,
} from "../lib/self-install.js";

const argv = process.argv.slice(2);
const modeArg = argv[0] ?? "";
const mode = modeArg.split("=")[0];
const inlineTarget = modeArg.includes("=") ? modeArg.slice(modeArg.indexOf("=") + 1) : "";
const positionalTarget = !inlineTarget && argv[1] && !argv[1].startsWith("--") ? argv[1] : "";
const targetArg = inlineTarget || positionalTarget || "auto";
const flags = new Set(argv.filter((arg) => arg.startsWith("--")));
const dryRun = flags.has("--dry-run");
const forceCreate = flags.has("--create");
const asJson = flags.has("--json");

function flagValue(name: string): string | undefined {
  const prefix = `${name}=`;
  const inline = argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = argv.indexOf(name);
  if (index >= 0 && argv[index + 1] && !argv[index + 1].startsWith("--")) return argv[index + 1];
  return undefined;
}

const workspace = path.resolve(
  flagValue("--workspace") || process.env.VENIRA_WORKSPACE || process.cwd(),
);
const dataDirRaw = flagValue("--data-dir") || process.env.VENIRA_DATA_DIR;
const dataDir = dataDirRaw ? path.resolve(dataDirRaw) : undefined;

function usage(): void {
  console.error(`venira-mcp setup

Usage:
  npx venira-mcp --install [auto|${PRINTABLE_CLIENTS.join("|")}]
  npx venira-mcp --print-config [auto|${PRINTABLE_CLIENTS.join("|")}] [--json]

Options:
  --workspace <path>   Workspace root (default: $VENIRA_WORKSPACE or cwd)
  --data-dir <path>    Optional custom data dir; omit to use the OS default
  --dry-run            Show what would change without writing
  --create             Create a missing config (explicit clients already do this)
  --json               Print a machine-readable result for --print-config

Examples:
  npx --yes venira-mcp@latest --install auto --workspace .
  npx --yes venira-mcp@latest --install vscode --workspace .
  npx --yes venira-mcp@latest --print-config claude_desktop > claude_desktop_config.json`);
}

function printInstallResult(
  client: PrintableClient,
  result: Awaited<ReturnType<typeof installSelf>>,
  dryRun: boolean,
): void {
  if (dryRun) {
    const state = result.status === "already_present"
      ? "already present"
      : result.status === "installed"
        ? "would merge"
        : result.status === "config_missing"
          ? "would create"
          : "error";
    console.log(`[dry] ${client.padEnd(15)} ${state.padEnd(15)} ${result.config_path || "(no path)"}`);
    return;
  }
  const symbol = result.status === "installed"
    ? "+"
    : result.status === "already_present"
      ? "="
      : "!";
  console.log(`[${symbol}] ${client.padEnd(15)} ${result.status.padEnd(15)} ${result.config_path || "(no path)"}`);
  if (result.error && result.status !== "installed" && result.status !== "already_present") {
    console.log(`    ${result.error}`);
  }
}

async function runInstall(): Promise<number> {
  const explicit = targetArg === "auto" ? undefined : normalizeClient(targetArg);
  if (targetArg !== "auto" && !explicit) {
    console.error(`Unknown client "${targetArg}". Choose one of: auto, ${PRINTABLE_CLIENTS.join(", ")}`);
    return 2;
  }

  const clients: PrintableClient[] = [];
  if (explicit) {
    clients.push(explicit);
  } else {
    for (const detected of detectAllHarnesses()) {
      if (detected.detected) clients.push(detected.harness);
    }
    if (existsSync(path.join(workspace, ".vscode", "mcp.json"))) clients.push("vscode");
  }

  if (clients.length === 0) {
    console.log("No existing MCP client config was detected.");
    console.log("Print one you can paste instead:");
    console.log(`  npx --yes venira-mcp@latest --print-config vscode --workspace "${workspace}"`);
    console.log(`  npx --yes venira-mcp@latest --install <client> --workspace "${workspace}"`);
    return 0;
  }

  let failures = 0;
  let changed = 0;
  for (const client of clients) {
    // `auto` only merges existing files; naming a client is an explicit request to create.
    const create = Boolean(explicit) || forceCreate;
    const result = client === "vscode"
      ? await installVscodeConfig({ workspace, dataDir, dryRun, create })
      : await installSelf({
          harness: client,
          workspace,
          dataDir,
          dryRun,
          create,
        });
    printInstallResult(client, result, dryRun);
    if (!dryRun && result.status === "installed") changed += 1;
    if (!dryRun && (result.status === "error" || result.status === "config_missing")) failures += 1;
  }

  if (failures > 0) {
    console.error(`\n${failures} client(s) failed. Fix the error above, or use --print-config and paste manually.`);
    return 1;
  }

  if (dryRun) {
    console.log("\nDry run: no files were written. Re-run without --dry-run to apply.");
    return 0;
  }

  if (changed > 0) {
    console.log("\nRestart the client you just configured, then ask the agent to call `project_health`.");
    console.log("The agent cannot verify the connection before that restart.");
  } else {
    console.log("\nNothing to change: Venira is already present in the detected config(s).");
  }
  return 0;
}

function runPrintConfig(): number {
  let client: PrintableClient | undefined = targetArg === "auto" ? undefined : normalizeClient(targetArg);
  if (targetArg !== "auto" && !client) {
    console.error(`Unknown client "${targetArg}". Choose one of: auto, ${PRINTABLE_CLIENTS.join(", ")}`);
    return 2;
  }
  if (!client) {
    const detected = detectAllHarnesses().find((entry) => entry.detected);
    client = detected?.harness ?? "vscode";
  }

  const rendered = renderClientConfig(client, { workspace, dataDir });
  if (asJson) {
    console.log(JSON.stringify(rendered, null, 2));
    return 0;
  }
  console.error(`# Write this to: ${rendered.config_path}`);
  console.error(`# Client: ${rendered.client} (${rendered.format}); restart it after saving.`);
  console.log(rendered.content);
  return 0;
}

async function main(): Promise<number> {
  if (mode === "--install") return runInstall();
  if (mode === "--print-config") return runPrintConfig();
  if (mode === "--help" || mode === "-h" || !mode) {
    usage();
    return mode ? 0 : 2;
  }
  console.error(`Unknown setup option: ${modeArg}`);
  usage();
  return 2;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error("[venira-mcp setup] fatal:", error);
    process.exitCode = 1;
  });
