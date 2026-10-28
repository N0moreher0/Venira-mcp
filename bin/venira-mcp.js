#!/usr/bin/env node
/**
 * npx entry point.
 *
 *   npx venira-mcp                 # run the MCP server in stdio mode
 *   npx venira-mcp --doctor        # run the doctor preflight
 *   npx venira-mcp --verify        # run the behavioural suite
 *   (also aliased as `venira` via the package.json `bin` entry)
 *
 * Resolves the compiled dist/ relative to this file so `npx` (which
 * installs the package to a temp dir) still works.
 *
 * Native module safety: better-sqlite3 ships a prebuilt .node binary for
 * most platforms. If it's missing or built for a different Node ABI, this
 * entry point runs `npm rebuild better-sqlite3` once before launching so
 * that `npx` users on unusual platforms (musl, ARM, a new Node major)
 * don't hit "NODE_MODULE_VERSION mismatch" errors. The rebuild is
 * idempotent and only touches the better-sqlite3 package.
 */
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, "..", "dist", "server.js");
const rawArgs = process.argv.slice(2);
const env = { ...process.env };
const restArgs = [];

for (let i = 0; i < rawArgs.length; i++) {
  const arg = rawArgs[i];
  if (arg === "--workspace" || arg === "-w") {
    env.VENIRA_WORKSPACE = rawArgs[++i] || env.VENIRA_WORKSPACE;
  } else if (arg.startsWith("--workspace=")) {
    env.VENIRA_WORKSPACE = arg.slice("--workspace=".length);
  } else if (arg === "--data-dir") {
    env.VENIRA_DATA_DIR = rawArgs[++i] || env.VENIRA_DATA_DIR;
  } else if (arg.startsWith("--data-dir=")) {
    env.VENIRA_DATA_DIR = arg.slice("--data-dir=".length);
  } else if (arg === "--env") {
    // e.g. --env VENIRA_TOOL_POLICY_JSON='{...}' ; simple variant
    const [k, v] = (rawArgs[++i] || "").split("=");
    if (k) env[k] = v;
  } else {
    restArgs.push(arg);
  }
}

// Positional shorthand: `npx venira-mcp <project-path>`
if (!env.VENIRA_WORKSPACE && restArgs.length && !restArgs[0].startsWith("--")) {
  // Only treat as workspace if it isn't a CLI flag and a real directory exists
  const candidate = restArgs[0];
  if (candidate && existsSync(candidate)) {
    env.VENIRA_WORKSPACE = candidate;
    restArgs.shift();
  }
}
const args = restArgs;

const USAGE = `venira-mcp — MCP server for coding agents

Usage:
  npx venira-mcp                 Start the MCP server (stdio transport)
  npx venira-mcp --doctor        Run the preflight diagnostics
  npx venira-mcp --verify        Run the behavioural test suite
  npx venira-mcp --version, -v   Print the version
  npx venira-mcp --help, -h      Show this help

Environment:
  VENIRA_WORKSPACE    Project root the tools are locked to (default: cwd)
  VENIRA_DATA_DIR     Audit DB + runtime data (default: <workspace>/data)
  VENIRA_UNRESTRICTED 1 to allow paths outside the workspace (default: 0)

  --workspace, -w <path>  Project root instead of editing env
  --data-dir <path>       Audit DB + data dir

Docs: https://github.com/N0moreher0/Venira-mcp`;

// `--version` / `--help` are CLI-level flags: handle them here instead of
// handing them to the server (which would just start and wait on stdio).
if (args[0] === "--version" || args[0] === "-v") {
  const pkg = JSON.parse(readFileSync(path.join(here, "..", "package.json"), "utf8"));
  process.stdout.write(`venira-mcp ${pkg.version}\n`);
  process.exit(0);
}
if (args[0] === "--help" || args[0] === "-h") {
  process.stdout.write(`${USAGE}\n`);
  process.exit(0);
}

const target = (() => {
  if (args[0] === "--doctor") return { file: path.join(here, "..", "dist", "scripts", "doctor.js"), rest: args.slice(1) };
  if (args[0] === "--verify") return { file: path.join(here, "..", "dist", "scripts", "verify.js"), rest: args.slice(1) };
  return { file: dist, rest: args };
})();

// Check that the native binding is present. If not, try a rebuild.
const nativeBinding = path.join(
  here, "..", "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node",
);
if (!existsSync(nativeBinding)) {
  const pkgJson = path.join(here, "..", "package.json");
  if (existsSync(pkgJson)) {
    process.stderr.write(
      "[venira-mcp] native binding missing or stale; running `npm rebuild better-sqlite3`...\n",
    );
    try {
      const shell = process.platform === "win32" ? "cmd" : "sh";
      const flag = process.platform === "win32" ? "/c" : "-c";
      execFileSync(shell, [flag, "npm rebuild better-sqlite3"], {
        cwd: path.join(here, ".."),
        stdio: "inherit",
      });
    } catch (error) {
      process.stderr.write(
        `[venira-mcp] rebuild failed (${error instanceof Error ? error.message : String(error)}). ` +
          "Continuing anyway; the server may fail to start if better-sqlite3 is unusable.\n",
      );
    }
  }
}

const child = spawn(process.execPath, [target.file, ...target.rest], {
  stdio: "inherit",
  env,
});

child.on("close", (code) => process.exit(code ?? 0));
