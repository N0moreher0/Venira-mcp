#!/usr/bin/env node
/**
 * npx entry point.
 *
 *   npx venira-mcp-coding            # run the MCP server in stdio mode
 *   npx venira-mcp-coding --doctor   # run the doctor preflight
 *   npx venira-mcp-coding --verify   # run the behavioural suite
 *
 * Resolves the compiled dist/ relative to this file so `npx` (which
 * installs the package to a temp dir) still works.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, "..", "dist", "server.js");

const args = process.argv.slice(2);
let target = dist;

if (args[0] === "--doctor") {
  target = path.join(here, "..", "dist", "scripts", "doctor.js");
  args.shift();
} else if (args[0] === "--verify") {
  target = path.join(here, "..", "dist", "scripts", "verify.js");
  args.shift();
}

const child = spawn(process.execPath, [target, ...args], {
  stdio: "inherit",
  env: { ...process.env },
});

child.on("close", (code) => process.exit(code ?? 0));
