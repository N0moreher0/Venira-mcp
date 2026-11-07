/** Verify section module: shell-env-audit. Behaviour is unchanged from the original scripts/verify.ts. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Harness } from "./harness.js";
import type { runCore } from "./core.js";
import type { runShellPolicy } from "./shell-policy.js";

export async function runShellEnvAudit(
  $h: Harness,
  $prior: Awaited<ReturnType<typeof runCore>> &
    Awaited<ReturnType<typeof runShellPolicy>>,
) {
  const { SESSION_ID, verifyEnv, call, check, dir, names } = $h;
  const {
    tools,
    missing,
    run,
    shellFor,
    asEnvelope,
    policyModule,
    runWithCliApproval,
  } = $prior;
  // 11. Shell env scrub: agent secrets must not reach the child process.
  const scrubTransport = new StdioClientTransport({
    command: "node",
    args: ["dist/server.js"],
    cwd: process.cwd(),
    env: verifyEnv(
      {
        VENIRA_SESSION_ID: `${SESSION_ID}-scrub`,
        VENIRA_TEST_SECRET: "verify-secret",
      },
      "full",
    ),
    stderr: "pipe",
  });
  const scrubClient = new Client(
    { name: "verify-scrub", version: "0.0.0" },
    { capabilities: {} },
  );
  await scrubClient.connect(scrubTransport);
  await fs.writeFile(
    `${dir}/scrub-check.js`,
    "console.log('SCRUB:' + (process.env.VENIRA_TEST_SECRET || 'missing') + ':' + (process.env.PATH ? 'path-ok' : 'no-path'));\n",
  );
  const scrubRun = await runWithCliApproval(
    (args) =>
      scrubClient.callTool({ name: "project_shell_run", arguments: args }),
    { command: `node ${dir}/scrub-check.js`, shell: shellFor },
  );
  const scrubRunId = String(asEnvelope(scrubRun).data?.run_id ?? "");
  let scrubStatus: Record<string, any> = {};
  for (let i = 0; i < 20; i++) {
    scrubStatus = asEnvelope(
      await scrubClient.callTool({
        name: "project_shell_status",
        arguments: { run_id: scrubRunId, wait_seconds: 1 },
      }),
    );
    if (!scrubStatus?.data?.running) break;
  }
  check(
    "policy_env_scrubbed",
    String(scrubStatus?.data?.stdout_tail ?? "").includes(
      "SCRUB:missing:path-ok",
    ),
    scrubStatus?.data,
  );
  await scrubClient.close();

  // 12. Redaction + decision unit checks (pure functions, no server needed)
  const redacted = policyModule.redactSecrets(
    "curl -H 'Authorization: Bearer abc123secret' https://user:passw0rd@example.com --token=deadbeefvalue",
  );
  check(
    "policy_redaction",
    !redacted.includes("abc123secret") &&
      !redacted.includes("passw0rd") &&
      !redacted.includes("deadbeefvalue") &&
      (redacted.match(/\[REDACTED\]/g)?.length ?? 0) >= 3,
    redacted,
  );
  const redactedEnv = policyModule.redactSecrets(
    "cargo run: DATABASE_URL=postgres://user:supersecret@db.internal:5432/app GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz1234567890",
  );
  check(
    "policy_redaction_env_var",
    !redactedEnv.includes("supersecret") &&
      !redactedEnv.includes("ghp_abcdefghijklmnopqrstuvwxyz1234567890") &&
      redactedEnv.includes("[REDACTED]"),
    redactedEnv,
  );

  // 13. Health exposes the policy snapshot and counters.
  const healthPolicy = asEnvelope(
    await call("project_health", { include_audit: 0 }),
  );
  check(
    "health_shell_policy",
    healthPolicy.data?.shells?.policy?.policy?.mode === "balanced" &&
      Number(healthPolicy.data?.shells?.policy?.stats?.evaluated ?? 0) > 0 &&
      Number(healthPolicy.data?.shells?.policy?.stats?.denied ?? 0) > 0,
    healthPolicy.data?.shells?.policy,
  );

  // 14. VENIRA_DISABLE_TOOLS removes a tool from tools/list entirely.
  const disabledTransport = new StdioClientTransport({
    command: "node",
    args: ["dist/server.js"],
    cwd: process.cwd(),
    env: verifyEnv(
      {
        VENIRA_SESSION_ID: `${SESSION_ID}-disabled`,
        VENIRA_DISABLE_TOOLS: "project_shell_run",
      },
      "full",
    ),
    stderr: "pipe",
  });
  const disabledClient = new Client(
    { name: "verify-disabled", version: "0.0.0" },
    { capabilities: {} },
  );
  await disabledClient.connect(disabledTransport);
  const disabledList = await disabledClient.listTools();
  // Compare against the full tool list's own count instead of a hardcoded
  // number -- the hardcoded 40 was stale (off by one: it didn't account for
  // disabling exactly 1 tool) and silently went wrong again every time a tool
  // got added or removed.
  check(
    "disable_tools_hidden",
    !disabledList.tools.some((t) => t.name === "project_shell_run") &&
      disabledList.tools.length === tools.tools.length - 1,
    {
      disabledCount: disabledList.tools.length,
      fullCount: tools.tools.length,
      names: disabledList.tools.map((t) => t.name),
    },
  );
  await disabledClient.close();

  // 14b. Tool modes: `VENIRA_TOOL_MODE=expert` keeps the full set; `default` is
  // the coding-focused lean set (no CI/CD shipping; shell + JS exec + `project_delete_path` included).
  const expertTransport = new StdioClientTransport({
    command: "node",
    args: ["dist/server.js"],
    cwd: process.cwd(),
    env: verifyEnv(
      {
        VENIRA_SESSION_ID: `${SESSION_ID}-mode-expert`,
        VENIRA_ALLOW_JS_EXEC: "1",
      },
      "full",
    ),
    stderr: "pipe",
  });
  const expertClient = new Client(
    { name: "verify-expert", version: "0.0.0" },
    { capabilities: {} },
  );
  await expertClient.connect(expertTransport);
  const expertList = await expertClient.listTools();
  check(
    "tool_mode_expert_full",
    expertList.tools.length === tools.tools.length + 1 &&
      expertList.tools.some((t) => t.name === "project_ci_wait") &&
      expertList.tools.some((t) => t.name === "project_ci_control") &&
      expertList.tools.some((t) => t.name === "project_shell_run") &&
      expertList.tools.some((t) => t.name === "project_execute_js") &&
      expertList.tools.some((t) => t.name === "project_dependency_graph"),
    {
      expertCount: expertList.tools.length,
      fullCount: tools.tools.length,
      names: expertList.tools.map((t) => t.name),
    },
  );
  await expertClient.close();

  const defaultTransport = new StdioClientTransport({
    command: "node",
    args: ["dist/server.js"],
    cwd: process.cwd(),
    env: verifyEnv(
      {
        VENIRA_SESSION_ID: `${SESSION_ID}-mode-default`,
        VENIRA_TOOL_MODE: "default",
        VENIRA_ALLOW_JS_EXEC: "1",
      },
      "full",
    ),
    stderr: "pipe",
  });
  const defaultClient = new Client(
    { name: "verify-default", version: "0.0.0" },
    { capabilities: {} },
  );
  await defaultClient.connect(defaultTransport);
  const defaultList = await defaultClient.listTools();
  check(
    "tool_mode_default_coding_focused",
    !defaultList.tools.some((t) => t.name === "project_ci_wait") &&
      !defaultList.tools.some((t) => t.name === "project_ci_control") &&
      !defaultList.tools.some((t) => t.name === "project_pr_create") &&
      defaultList.tools.some((t) => t.name === "project_delete_path") &&
      defaultList.tools.some((t) => t.name === "project_shell_run") &&
      defaultList.tools.some((t) => t.name === "project_execute_js") &&
      defaultList.tools.some((t) => t.name === "project_read_file") &&
      defaultList.tools.some((t) => t.name === "project_write_file") &&
      defaultList.tools.some((t) => t.name === "project_dependency_graph") &&
      defaultList.tools.some((t) => t.name === "project_change_impact") &&
      defaultList.tools.some((t) => t.name === "project_snapshot"),
    {
      defaultCount: defaultList.tools.length,
      fullCount: tools.tools.length,
      names: defaultList.tools.map((t) => t.name),
    },
  );
  await defaultClient.close();

  // 15. Audit (standalone: DB is in <workspace>/data or VENIRA_DATA_DIR)
  function defaultDataDir(): string {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
    if (process.platform === "win32")
      return path.join(
        process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"),
        "venira",
      );
    if (process.platform === "darwin")
      return path.join(home, "Library", "Application Support", "venira");
    return path.join(home, ".local", "share", "venira");
  }
  const auditDbPath = path.resolve(
    process.env.VENIRA_DATA_DIR ?? defaultDataDir(),
    "venira.db",
  );

  const token = `VERIFY_SEARCH_TOKEN_${Date.now()}`;
  await fs.writeFile(`${dir}/search-token.txt`, `${token}\n`);
  const search1 = await call("project_search", {
    query: token,
    kind: "literal_content",
    relative_path: dir,
    glob: "*.txt",
  });
  const search1Data = JSON.parse(
    (search1 as { content?: { text?: string }[] })?.content?.[0]?.text ?? "{}",
  );
  check(
    "search_hits",
    Array.isArray(search1Data.data?.hits),
    Object.keys(search1Data.data ?? {}),
  );
  await call("project_write_file", {
    relative_path: `${dir}/search-token.txt`,
    content: `${token}\n`,
  });
  await new Promise((resolve) => setTimeout(resolve, 3200)); // wait for search cache TTL to expire
  const search2 = await call("project_search", {
    query: token,
    kind: "literal_content",
    relative_path: dir,
    glob: "*.txt",
  });
  const search2Data = JSON.parse(
    (search2 as { content?: { text?: string }[] })?.content?.[0]?.text ?? "{}",
  );
  check(
    "search_hits_invalidate_after_write",
    search2Data.data?.hits?.length >= 1,
    search2Data.data?.hits?.length,
  );
  return { token, redacted, auditDbPath };
}
