/**
 * Doctor script: preflight checks for the standalone MCP server.
 * Runs: npm run doctor
 *
 * Checks:
 *   1. workspace exists
 *   2. data dir / audit DB reachable
 *   3. ripgrep availability + workspace scale (warn-only: a missing `rg` on a
 *      multi-thousand-file workspace forces the JS line scanner)
 *   4. MCP server starts and exposes the expected tool count
 *   5. health is OK
 *   6. shell smoke
 *   7. audit/trace reachability
 *   8. version
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync, promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "../lib/version.js";
import { activeDataDir } from "../lib/workspace.js";
import { detectAllHarnesses } from "../lib/self-install.js";

const SESSION_ID = `doctor-${Date.now()}`;

/**
 * Nearest ancestor directory that contains a package.json. Walking up (rather
 * than hard-coding `../..`) makes this work both when the doctor runs from
 * source (`scripts/doctor.ts`) and from the published build
 * (`dist/scripts/doctor.js`), and keeps `npx venira-mcp --doctor` usable in
 * any project directory.
 */
function findPackageRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}

const PKG_ROOT = findPackageRoot(path.dirname(fileURLToPath(import.meta.url)));
const SERVER_ENTRY = path.join(PKG_ROOT, "dist", "server.js");
const WORKSPACE = process.env.VENIRA_WORKSPACE ?? process.cwd();
const DATA_DIR = process.env.VENIRA_DATA_DIR ? path.resolve(process.env.VENIRA_DATA_DIR) : activeDataDir();

type CheckResult = { status: "PASS" | "FAIL" | "WARN"; text?: string; args?: unknown };

const warn = (text: string, args: Record<string, unknown> = {}): CheckResult => ({
  status: "WARN",
  text,
  args,
});

async function check(text: string, result: unknown, args: Record<string, unknown> = {}): Promise<CheckResult> {
  const ok = Boolean(result);
  return {
    status: ok ? "PASS" : "FAIL",
    ...(ok ? {} : { text }),
    args,
  };
}

function mcpEnv(extra: Record<string, string> = {}) {
  return {
    ...process.env,
    // The health payload is trimmed in compact mode (dropped sections are named there);
    // doctor must see the whole report, so pin the full output mode.
    VENIRA_OUTPUT_MODE: "full",
    VENIRA_WORKSPACE: WORKSPACE,
    VENIRA_DATA_DIR: DATA_DIR,
    VENIRA_UNRESTRICTED: "0",
    VENIRA_SESSION_ID: SESSION_ID,
    VENIRA_TOOL_MODE: "expert",
    VENIRA_JS_EXEC_MODE: "off",
    ...extra,
  };
}

async function main() {
  console.log(`[doctor] checking ${WORKSPACE} with SESSION_ID ${SESSION_ID}...\n`);

  const results: unknown[] = [];

  // 1. workspace exists
  const rootStat = await fs.access(WORKSPACE).then(() => true).catch(() => false);
  results.push(await check("workspace_exists", rootStat, { path: WORKSPACE }));

  // 2. data dir
  const dataDirOk = await fs.access(DATA_DIR).then(() => true).catch(() => false);
  results.push(await check("data_dir_exists", dataDirOk, { dataDir: DATA_DIR }));

  // 3. ripgrep availability + workspace scale — both are only decisive on big
  // workspaces, but a missing `rg` there is the #1 performance foot-gun.
  const rgOk = await new Promise<boolean>((resolve) => {
    const child = spawn("rg", ["--version"], { timeout: 5000 });
    child.stdout?.resume();
    child.stderr?.resume();
    child.on("exit", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
  let fileCount = 0;
  {
    const IGNORED = new Set([".git", "node_modules", "target", "dist", "build", ".next", ".venv", "__pycache__", ".cache", ".turbo", "coverage"]);
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (fileCount >= 6000 || depth > 12) return;
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (fileCount >= 6000) return;
        if (entry.isDirectory()) {
          if (!IGNORED.has(entry.name) && !entry.name.startsWith(".")) {
            await walk(path.join(dir, entry.name), depth + 1);
          }
        } else {
          fileCount += 1;
        }
      }
    };
    await walk(WORKSPACE, 0);
  }
  if (rgOk) {
    results.push({ status: "PASS", text: "ripgrep available", args: { file_count: fileCount } });
  } else if (fileCount > 5000) {
    results.push(warn("ripgrep (rg) not found and the workspace has thousands of files — searches will use the JS line scanner; install ripgrep", { file_count: fileCount }));
  } else {
    results.push({ status: "PASS", text: "ripgrep not found (fine for small workspaces)", args: { file_count: fileCount } });
  }

  // 4. MCP server: spawn + listTools + health
  try {
    const client = new Client({ name: "doctor", version: "0.0.0" }, { capabilities: {} });
    const transport = new StdioClientTransport({
      command: "node",
      args: [SERVER_ENTRY],
      cwd: WORKSPACE,
      env: mcpEnv(),
      stderr: "pipe",
    });
    try {
      await client.connect(transport);
      await new Promise((r) => setTimeout(r, 500)); // let warm-up finish

      const tools = await client.listTools();
      // Doctor pins VENIRA_JS_EXEC_MODE="off", which hides execute_js: expert = 52 - 1 = 51.
      const expectedTools = 51; // expert minus the off-gated execute_js (52 with JS exec on; same as schema-budget's 52)
      results.push(await check("tools_count", tools.tools.length === expectedTools, { actual: tools.tools.length, expected: expectedTools }));

      const healthRes = await client.callTool({ name: "health", arguments: { include_audit: 0 } });
      const healthData = JSON.parse(
        ((healthRes as { content?: { text?: string }[] })?.content?.[0]?.text ?? "{}"),
      );
      results.push(await check("health_ok", healthData.ok === true, healthData));
      // 4.0.0 removed the safety notice from health (token diet); the contract is now: no notice key.
      results.push(await check("health_no_notice", healthData.data?.notice === undefined, { notice: healthData.data?.notice ?? null }));
      results.push(await check("health_capability_open", healthData.data?.capability?.state === "open", healthData.data?.capability));

      await client.close();
    } catch (err) {
      results.push({
        status: "FAIL",
        text: `MCP server connection failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      await client.close().catch(() => {});
    }
  } catch (err) {
    results.push({
      status: "FAIL",
      text: `MCP server connection failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // 4. shell smoke (separate client so we can pick the right shell per platform)
  try {
    const client2 = new Client({ name: "doctor-shell", version: "0.0.0" }, { capabilities: {} });
    const transport2 = new StdioClientTransport({
      command: "node",
      args: [SERVER_ENTRY],
      cwd: WORKSPACE,
      env: mcpEnv({ VENIRA_SESSION_ID: `doctor-shell-${Date.now()}` }),
      stderr: "pipe",
    });
    await client2.connect(transport2);
    await new Promise((r) => setTimeout(r, 300));
    const shellName = process.platform === "win32" ? "powershell" : "bash";
    const shellOk = await client2
      .callTool({ name: "shell_run", arguments: { command: "git status", shell: shellName } })
      .then((res) => {
        const data = JSON.parse(((res as { content?: { text?: string }[] })?.content?.[0]?.text ?? "{}"));
        return data.ok === true && typeof data.data?.run_id === "string";
      })
      .catch(() => false);
    results.push(await check("shell_run_smoke", shellOk));
    await client2.close();
  } catch (err) {
    results.push({
      status: "FAIL",
      text: `Shell smoke failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // 4b. P1 config surfacing: cache control, tracing, shell UX, audit reachability
  try {
    const client3 = new Client({ name: "doctor-config", version: "0.0.0" }, { capabilities: {} });
    const transport3 = new StdioClientTransport({
      command: "node",
      args: [SERVER_ENTRY],
      cwd: WORKSPACE,
      env: mcpEnv({ VENIRA_SESSION_ID: `doctor-config-${Date.now()}` }),
      stderr: "pipe",
    });
    await client3.connect(transport3);
    await new Promise((r) => setTimeout(r, 300));

    const healthRes3 = await client3.callTool({ name: "health", arguments: { include_audit: 0 } });
    const hData = JSON.parse(((healthRes3 as { content?: { text?: string }[] })?.content?.[0]?.text ?? "{}"));
    results.push(await check("config_cache_reported", hData.data?.cache !== undefined, hData.data?.cache));
    results.push(await check("config_trace_reported", hData.data?.trace !== undefined, hData.data?.trace));
    results.push(await check("config_shell_reported", hData.data?.shell !== undefined, hData.data?.shell));
    const approvalsInfo = hData.data?.approvals as { security_profile?: string; shell_mode?: string } | undefined;
    results.push(await check("config_security_profile_reported", typeof approvalsInfo?.security_profile === "string", approvalsInfo));
    const posture = hData.data?.posture as
      | { level?: string; findings?: Array<{ id?: string; severity?: string; summary?: string }>; summary?: string }
      | undefined;
    results.push(
      await check(
        "config_posture_reported",
        typeof posture?.level === "string" && Array.isArray(posture?.findings),
        posture,
      ),
    );
    const actionable = (posture?.findings ?? []).filter((finding) => finding.severity !== "info");
    if (actionable.length > 0) {
      results.push(
        warn(
          `configuration posture: ${posture?.summary ?? "risky settings detected"} (${actionable.map((f) => f.id).join(", ")})`,
          { findings: actionable },
        ),
      );
    }

    // P1: read_audit tool reachable and returns an envelope (audit_unavailable is acceptable)
    const auditRes = await client3.callTool({ name: "read_audit", arguments: { limit: 1 } });
    const auditData = JSON.parse(((auditRes as { content?: { text?: string }[] })?.content?.[0]?.text ?? "{}"));
    const auditOk =
      auditData.ok === true ||
      auditData.error?.code === "audit_unavailable";
    results.push(await check("read_audit_reachable", auditOk, auditData));

    const traceRes = await client3.callTool({ name: "trace_status", arguments: {} });
    const traceData = JSON.parse(((traceRes as { content?: { text?: string }[] })?.content?.[0]?.text ?? "{}"));
    results.push(await check("trace_status_reachable", traceData.ok === true, traceData));

    await client3.close();
  } catch (err) {
    results.push({
      status: "FAIL",
      text: `P1 config/audit/trace checks failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // 5. version (compare the running server against the installed package.json)
  const pkgRaw = await fs.readFile(path.join(PKG_ROOT, "package.json"), "utf8").catch(() => null);
  if (pkgRaw === null) {
    results.push({ status: "FAIL", text: `cannot read ${path.join(PKG_ROOT, "package.json")} to verify the version` });
  } else {
    const expected = JSON.parse(pkgRaw) as { version: string };
    results.push(
      VERSION === expected.version
        ? { status: "PASS", text: `server version ${VERSION}` }
        : { status: "FAIL", text: `server version mismatch: ${VERSION} (expected ${expected.version})` },
    );
  }

  const passes = results.filter((r) => (r as CheckResult).status === "PASS").length;
  const failed = results.filter((r) => (r as CheckResult).status === "FAIL");
  const warnings = results.filter((r) => (r as CheckResult).status === "WARN");
  console.log(`\nDoctor: ${passes}/${results.length} checks passed${warnings.length > 0 ? ` (${warnings.length} warning(s))` : ""}`);
  console.log("[doctor] Security limits: Venira runs with the OS user’s privileges. The workspace lock limits file-tool paths, not shell effects; prompt injection can still steer commands allowed by the active profile. Same-user processes can read keys in VENIRA_DATA_DIR. Use a container or VM for real isolation. See SECURITY.md.");
  if (failed.length > 0) {
    console.log("Failed checks:", JSON.stringify(failed, null, 2));
  }
  if (warnings.length > 0) {
    console.log("Warnings:", JSON.stringify(warnings, null, 2));
  }

  // 6. client setup hints (does not affect the pass/fail result)
  const detected = detectAllHarnesses().filter((entry) => entry.detected);
  console.log("\n[doctor] MCP client configs:");
  if (detected.length === 0) {
    console.log("  (none detected)");
  } else {
    for (const entry of detected) {
      console.log(`  - ${entry.harness}: ${entry.config_path}`);
    }
  }
  if (existsSync(path.join(WORKSPACE, ".vscode", "mcp.json"))) {
    console.log(`  - vscode: ${path.join(WORKSPACE, ".vscode", "mcp.json")}`);
  }
  console.log(`[doctor] install: npx --yes venira-mcp@latest --install auto --workspace "${WORKSPACE}"`);
  console.log("[doctor] print a config instead: npx --yes venira-mcp@latest --print-config vscode");

  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("[doctor] fatal:", err);
  process.exit(1);
});
