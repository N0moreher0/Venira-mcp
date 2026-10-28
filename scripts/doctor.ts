/**
 * Doctor script: preflight checks for the standalone MCP server.
 * Runs: npm run doctor
 *
 * Checks:
 *   1. workspace exists
 *   2. data dir / audit DB reachable
 *   3. MCP server starts and exposes the expected tool count
 *   4. project_health is OK
 *   5. shell smoke
 *   6. version
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "../lib/version.js";

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
const DATA_DIR = process.env.VENIRA_DATA_DIR ?? path.join(WORKSPACE, "data");

type CheckResult = { status: "PASS" | "FAIL"; text?: string; args?: unknown };

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
    VENIRA_WORKSPACE: WORKSPACE,
    VENIRA_DATA_DIR: DATA_DIR,
    VENIRA_UNRESTRICTED: "0",
    VENIRA_SESSION_ID: SESSION_ID,
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

  // 3. MCP server: spawn + listTools + health
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
      const expectedTools = 25;
      results.push(await check("tools_count", tools.tools.length === expectedTools, { actual: tools.tools.length, expected: expectedTools }));

      const healthRes = await client.callTool({ name: "project_health", arguments: { include_audit: false } });
      const healthData = JSON.parse(
        ((healthRes as { content?: { text?: string }[] })?.content?.[0]?.text ?? "{}"),
      );
      results.push(await check("health_ok", healthData.ok === true, healthData));
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
      .callTool({ name: "project_shell_run", arguments: { command: "echo doctor-ok", shell: shellName } })
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

    const healthRes3 = await client3.callTool({ name: "project_health", arguments: { include_audit: false } });
    const hData = JSON.parse(((healthRes3 as { content?: { text?: string }[] })?.content?.[0]?.text ?? "{}"));
    results.push(await check("config_cache_reported", hData.data?.cache !== undefined, hData.data?.cache));
    results.push(await check("config_trace_reported", hData.data?.trace !== undefined, hData.data?.trace));
    results.push(await check("config_shell_reported", hData.data?.shell !== undefined, hData.data?.shell));

    // P1: read_audit tool reachable and returns an envelope (audit_unavailable is acceptable)
    const auditRes = await client3.callTool({ name: "project_read_audit", arguments: { limit: 1 } });
    const auditData = JSON.parse(((auditRes as { content?: { text?: string }[] })?.content?.[0]?.text ?? "{}"));
    const auditOk =
      auditData.ok === true ||
      auditData.error?.code === "audit_unavailable";
    results.push(await check("read_audit_reachable", auditOk, auditData));

    const traceRes = await client3.callTool({ name: "project_trace_status", arguments: {} });
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
  console.log(`\nDoctor: ${passes}/${results.length} checks passed`);
  if (failed.length > 0) {
    console.log("Failed checks:", JSON.stringify(failed, null, 2));
  }
  process.exit(passes === results.length ? 0 : 1);
}

main().catch((err) => {
  console.error("[doctor] fatal:", err);
  process.exit(1);
});
