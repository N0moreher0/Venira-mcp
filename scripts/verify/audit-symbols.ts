/** Verify section module: audit-symbols. Behaviour is unchanged from the original scripts/verify.ts. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { promises as fs } from "node:fs";
import Database from "better-sqlite3";
import type { Harness } from "./harness.js";
import type { runCore } from "./core.js";
import type { runShellPolicy } from "./shell-policy.js";
import type { runShellEnvAudit } from "./shell-env-audit.js";
import type { runCheckpointsErrors } from "./checkpoints-errors.js";
import type { runSecrets } from "./secrets.js";

export async function runAuditSymbols(
  $h: Harness,
  $prior: Awaited<ReturnType<typeof runCore>> &
    Awaited<ReturnType<typeof runShellPolicy>> &
    Awaited<ReturnType<typeof runShellEnvAudit>> &
    Awaited<ReturnType<typeof runCheckpointsErrors>> &
    Awaited<ReturnType<typeof runSecrets>>,
) {
  const { SESSION_ID, verifyEnv, results, textOf, call, check, dir, names } =
    $h;
  const {
    status,
    asEnvelope,
    ws,
    policyModule,
    symbolDiffModule,
    shellCacheModule,
    cli,
    auditDbPath,
    health,
    healthData,
    SECRET_VALUE,
  } = $prior;
  // 19. Compact output mode
  console.log("[verify] checking compact mode...");
  const compactFixture = `${dir}/compact-large.txt`;
  await fs.writeFile(compactFixture, "x".repeat(9_000));
  const clientCompact = await new Client(
    { name: "verify-compact", version: "0.0.0" },
    { capabilities: {} },
  );
  const compactTransport = new StdioClientTransport({
    command: "node",
    args: ["dist/server.js"],
    cwd: process.cwd(),
    env: verifyEnv({ VENIRA_SESSION_ID: `${SESSION_ID}-compact` }, "compact"),
    stderr: "pipe",
  });
  await clientCompact.connect(compactTransport);
  const compactTool = await clientCompact.callTool({
    name: "project_read_file",
    arguments: { relative_path: compactFixture },
  });
  const compactData = JSON.parse(textOf(compactTool));
  check(
    "compact_trimmed",
    compactData.trimmed === true && compactData.data?.preview != null,
    {
      has_preview: !!compactData.data?.preview,
      preview_truncated: compactData.data?.preview_truncated,
    },
  );
  await clientCompact.close();

  // 20. Metrics ops present (read_batch, recent_files, health, shell_run)
  const ops = Object.keys(healthData.data?.metrics?.operations ?? {});
  const requiredOps = ["read_file", "read_batch", "recent_files", "shell_run"];
  const hasRequired = requiredOps.every((op) => ops.includes(op));
  check("metrics_ops_present", hasRequired, ops);

  // 21. Audit (standalone: DB is in <workspace>/data or VENIRA_DATA_DIR)
  let db: InstanceType<typeof Database> | null = null;
  try {
    db = new Database(auditDbPath, { readonly: true, fileMustExist: true });
  } catch {
    results.audit_db_open = `FAIL ${auditDbPath}`;
  }
  let rows: Array<{
    operation?: string;
    outcome?: string;
    reason_code?: string;
    reason?: string | null;
    completed_at?: number | null;
    decision?: string | null;
    policy_rule?: string | null;
    command?: string | null;
    approver?: string | null;
  }> = [];
  if (db) {
    for (let i = 0; i < 50; i++) {
      rows = db
        .prepare(
          "SELECT operation, outcome, reason_code, reason, completed_at, decision, policy_rule, command, approver FROM project_tool_audit WHERE session_id = ? ORDER BY id",
        )
        .all(SESSION_ID) as typeof rows;
      if (rows.length > 0 && rows.every((row) => row.completed_at !== null))
        break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    db.close();
  }
  check("audit_rows_present", rows.length >= 10, rows.length);
  if (rows.length > 0) {
    check(
      "audit_no_orphan_running",
      rows.every((r) => (r.outcome ?? "") !== "running"),
      rows.filter((r) => (r.outcome ?? "") === "running"),
    );
    check(
      "audit_failed_recorded",
      rows.some((r) => r.operation === "read_file" && r.outcome === "failed"),
      rows.filter((r) => (r.operation ?? "") === "read_file"),
    );
    check(
      "audit_shell_run_completed",
      rows.some(
        (r) => r.operation === "shell_run" && r.outcome === "succeeded",
      ),
      rows.filter((r) => (r.operation ?? "") === "shell_run"),
    );
    results.audit_ops = [...new Set(rows.map((r) => r.operation ?? ""))].join(
      ",",
    );
    const shellRows = rows.filter((r) => r.operation === "shell_run");
    check(
      "audit_shell_decision_recorded",
      shellRows.some(
        (r) => r.decision === "deny" && r.policy_rule?.startsWith("deny."),
      ) &&
        shellRows.some(
          (r) =>
            r.decision === "ask" &&
            r.policy_rule === "ask.cd_outside_workspace",
        ) &&
        shellRows.some((r) => r.approver === "user:cli") &&
        shellRows.some((r) => r.approver === "user:session"),
      shellRows,
    );
    check(
      "audit_shell_approval_pending",
      shellRows.some(
        (r) => r.reason_code === "approval_required" && r.outcome === "failed",
      ),
      shellRows.filter((r) => r.reason_code === "approval_required"),
    );
    check(
      "audit_shell_command_redacted",
      shellRows.some(
        (r) => r.decision === "deny" && typeof r.command === "string",
      ) &&
        shellRows.every(
          (r) => !String(r.command ?? "").includes("sk-verify-secret"),
        ),
      shellRows.map((r) => r.command),
    );
    check(
      "audit_reason_recorded",
      rows.some(
        (r) =>
          r.operation === "write_file" && r.reason === "VERIFY_REASON_EDIT",
      ) &&
        rows.some(
          (r) =>
            r.operation === "snapshot_create" &&
            r.reason === "VERIFY_REASON_SNAPSHOT",
        ),
      rows
        .filter((r) => r.reason)
        .map((r) => ({ op: r.operation, reason: r.reason })),
    );
    check(
      "audit_snapshot_ops",
      [
        "snapshot_create",
        "snapshot_restore",
        "snapshot_list",
        "snapshot_delete",
      ].every((op) => rows.some((r) => r.operation === op)),
      rows
        .filter((r) => String(r.operation ?? "").startsWith("snapshot_"))
        .map((r) => r.operation),
    );
    check(
      "audit_provider_ops",
      [
        "pr_create",
        "pr_comment",
        "pr_merge",
        "ci_status",
        "ci_trigger",
        "ci_logs",
        "secret",
      ].every((op) => rows.some((r) => r.operation === op)),
      rows
        .filter((r) =>
          [
            "pr_create",
            "pr_comment",
            "pr_merge",
            "ci_status",
            "ci_trigger",
            "ci_logs",
            "secret",
          ].includes(String(r.operation ?? "")),
        )
        .map((r) => r.operation),
    );
    check(
      "audit_provider_command_summary",
      rows.some(
        (r) =>
          r.operation === "pr_merge" &&
          String(r.command ?? "").includes("PUT /pulls/7/merge"),
      ) &&
        rows.some(
          (r) =>
            r.operation === "secret" &&
            String(r.command ?? "").includes("secret_set name=VERIFY_TOKEN"),
        ),
      rows.filter((r) => r.command).map((r) => r.command),
    );
    check(
      "audit_secret_value_never_logged",
      rows.every(
        (r) =>
          !String(r.command ?? "").includes(SECRET_VALUE) &&
          !String(r.reason ?? "").includes(SECRET_VALUE),
      ),
      rows.map((r) => r.command).filter(Boolean),
    );
  }

  // 16. project_read_audit surfaces `reason` to the agent (not just SQLite).
  const auditRead = asEnvelope(
    await call("project_read_audit", {
      session_id: SESSION_ID,
      operation: "write_file",
      limit: 20,
    }),
  );
  check(
    "audit_tool_exposes_reason",
    (auditRead.data?.rows ?? []).some(
      (r: { reason?: string }) => r.reason === "VERIFY_REASON_EDIT",
    ),
    auditRead.data?.rows,
  );
  // Roadmap item 15 (P1): the rows also say *which* call they belong to -
  // the argument hash and the (redacted) command.
  const auditShellRead = asEnvelope(
    await call("project_read_audit", {
      session_id: SESSION_ID,
      operation: "shell_run",
      limit: 20,
    }),
  );
  check(
    "audit_tool_exposes_args_hash_and_command",
    (auditShellRead.data?.rows ?? []).some(
      (r: { args_hash?: string }) => typeof r.args_hash === "string" && r.args_hash.length > 0,
    ) &&
      (auditShellRead.data?.rows ?? []).some(
        (r: { command?: string }) => typeof r.command === "string" && r.command.length > 0,
      ),
    (auditShellRead.data?.rows ?? []).slice(0, 3),
  );

  // 16-ter. Every job keeps what it was asked and what it returned (lib/audit-detail.ts), redacted.
  const auditShellRows = (auditShellRead.data?.rows ?? []) as Array<{
    request_id?: string;
    args_summary?: string;
    result_summary?: string;
    args?: unknown;
    result?: unknown;
  }>;
  check(
    "audit_rows_carry_args_and_result_summary",
    auditShellRows.some((r) => typeof r.args_summary === "string" && r.args_summary.length > 0) &&
      auditShellRows.some((r) => typeof r.result_summary === "string" && r.result_summary.length > 0),
    auditShellRows.slice(0, 3),
  );
  check(
    "audit_detail_never_holds_secret_value",
    !JSON.stringify(auditShellRows).includes(SECRET_VALUE),
    auditShellRows.map((r) => r.args_summary),
  );
  const oneJobId = auditShellRows.find((r) => typeof r.request_id === "string")?.request_id;
  const oneJob = asEnvelope(await call("project_read_audit", { request_id: oneJobId ?? "missing", limit: 5 }));
  check(
    "audit_lookup_by_request_id",
    (oneJob.data?.rows ?? []).length === 1 && (oneJob.data?.rows?.[0] as { request_id?: string })?.request_id === oneJobId,
    oneJob.data?.rows,
  );
  check(
    "audit_outcome_accepts_documented_words",
    asEnvelope(await call("project_read_audit", { outcome: "success", limit: 3 })).data?.rows?.length > 0,
    null,
  );

  // 16-bis. Audit hash chain: keyed, actually recomputed, and tamper-evident.
  const auditVerify = asEnvelope(
    await call("project_read_audit", { limit: 5, verify: 1 }),
  );
  const auditVerifyDetail = (auditVerify.data?.verify_detail ?? {}) as {
    ok?: boolean;
    keyed?: boolean;
    verified_rows?: number;
    legacy_rows?: number;
    reason?: string;
  };
  check(
    "audit_chain_verified",
    auditVerify.ok === true &&
      auditVerify.data?.verified === true &&
      auditVerifyDetail.keyed === true &&
      (auditVerifyDetail.verified_rows ?? 0) > 0,
    auditVerify.data?.verify_detail,
  );
  check(
    "audit_shell_status_not_recorded",
    (auditVerify.data?.rows ?? []).every(
      (r: { operation?: string }) => r.operation !== "shell_status",
    ),
    (auditVerify.data?.rows ?? []).map(
      (r: { operation?: string }) => r.operation,
    ),
  );

  const tamperDb = new Database(auditDbPath);
  const tamperTarget = tamperDb
    .prepare(
      "SELECT id, reason FROM project_tool_audit ORDER BY id DESC LIMIT 1",
    )
    .get() as { id: number; reason: string | null } | undefined;
  tamperDb
    .prepare("UPDATE project_tool_audit SET reason = ? WHERE id = ?")
    .run("VERIFY_TAMPERED", tamperTarget?.id ?? -1);
  tamperDb.close();
  const tamperedAudit = asEnvelope(
    await call("project_read_audit", { limit: 1, verify: 1 }),
  );
  check(
    "audit_tamper_detected",
    tamperedAudit.data?.verified === false &&
      (tamperedAudit.data?.verify_detail as { reason?: string })?.reason ===
        "hash_mismatch",
    tamperedAudit.data?.verify_detail,
  );
  const restoreDb = new Database(auditDbPath);
  restoreDb
    .prepare("UPDATE project_tool_audit SET reason = ? WHERE id = ?")
    .run(tamperTarget?.reason ?? null, tamperTarget?.id ?? -1);
  restoreDb.close();
  const restoredAudit = asEnvelope(
    await call("project_read_audit", { limit: 1, verify: 1 }),
  );
  check(
    "audit_chain_recovers_after_restore",
    restoredAudit.data?.verified === true,
    restoredAudit.data?.verify_detail,
  );

  check(
    "policy_unit_git_push_ask",
    policyModule.evaluateShellCommand("git push --force origin main", ws, {
      mode: "balanced",
    }).tier === "ask",
    policyModule.evaluateShellCommand("git push --force origin main", ws, {
      mode: "balanced",
    }),
  );
  const dotEnvDecision = policyModule.evaluateShellCommand("cat .env", ws, {
    mode: "balanced",
  });
  check(
    "policy_unit_cat_dot_env_denied",
    dotEnvDecision.tier === "deny" &&
      dotEnvDecision.rule === "deny.protected_file_access",
    dotEnvDecision,
  );
  for (const command of ["cat < .env", "cat .e[n]v", "echo leaked > .env"]) {
    const decision = policyModule.evaluateShellCommand(command, ws, {
      mode: "balanced",
    });
    check(
      `policy_unit_protected_path_${command}`,
      decision.tier === "deny" &&
        decision.rule === "deny.protected_file_access",
      decision,
    );
  }
  const noVerifyPushDecision = policyModule.evaluateShellCommand(
    "git push --no-verify origin main",
    ws,
    { mode: "balanced" },
  );
  check(
    "policy_unit_git_push_no_verify_ask",
    noVerifyPushDecision.tier === "ask" &&
      noVerifyPushDecision.rule === "ask.git_history_rewrite",
    noVerifyPushDecision,
  );
  for (const command of [
    "git -C . push --no-verify origin main",
    "git -c core.hooksPath=/dev/null push origin main",
  ]) {
    const decision = policyModule.evaluateShellCommand(command, ws, {
      mode: "balanced",
    });
    check(
      `policy_unit_git_global_option_push_${command}`,
      decision.tier === "ask" && decision.rule === "ask.git_history_rewrite",
      decision,
    );
  }
  check(
    "policy_unit_node_eval_ask",
    policyModule.evaluateShellCommand('node -e "console.log(1)"', ws, {
      mode: "balanced",
    }).tier === "ask",
    policyModule.evaluateShellCommand('node -e "console.log(1)"', ws, {
      mode: "balanced",
    }),
  );
  check(
    "policy_unit_node_file_ask",
    policyModule.evaluateShellCommand("node scripts/untrusted.js", ws, {
      mode: "balanced",
    }).tier === "ask",
    policyModule.evaluateShellCommand("node scripts/untrusted.js", ws, {
      mode: "balanced",
    }),
  );
  check(
    "policy_unit_git_status_allow",
    policyModule.evaluateShellCommand("git status", ws, { mode: "balanced" })
      .tier === "allow",
    policyModule.evaluateShellCommand("git status", ws, { mode: "balanced" }),
  );

  // 12b. Shell cache read-only allowlist (Phase D): only genuinely read-only
  // commands may be cached — mutating, networked or shell-structured commands never.
  const readOnlyCases: Array<[string, boolean]> = [
    ["git status", true],
    ["git -C . status --short", true],
    ["git log --oneline -5", true],
    ["git diff HEAD~1", true],
    ["git -C repo rev-parse HEAD", true],
    ["git branch", true],
    ["git branch -a", true],
    ["git branch -d feature", false],
    ["git tag", true],
    ["git tag -l 'v*'", true],
    ["git tag -a v1.0 -m msg", false],
    ["git remote", true],
    ["git remote -v", true],
    ["git remote get-url origin", true],
    ["git remote set-url origin https://x", false],
    ["git stash list", true],
    ["git stash", false],
    ["git worktree list", true],
    ["git worktree add ../x", false],
    ["git submodule status", true],
    ["git submodule update --init", false],
    ["git push origin main", false],
    ["git commit -m msg", false],
    ["git status | findstr src", false],
    ["git diff > out.txt", false],
    ["rg foo src --no-heading", true],
    ["ripgrep --version", true],
    ['echo "$(date)"', false],
    ['echo "`date`"', false],
    ['echo "$HOME"', false],
    ["echo '$HOME'", true],
    ["rg 'x$' src", true],
    ["ls -la", true],
    ["cat package.json", true],
    ["head -5 README.md", true],
    ["tail -f server.log", false],
    ["Get-Content -Wait README.md", false],
    ["Get-Content README.md", true],
    ["echo hi", true],
    ["echo hi > out.txt", false],
    ["node --version", true],
    ["node ./scripts/build.js", false],
    ["npm --version", true],
    ["npm install", false],
    ["find . -name '*.ts'", true],
    ["find . -delete", false],
    ["wc -l README.md", true],
    ["git --version", true],
  ];
  const readOnlyFailures = readOnlyCases.filter(
    ([command, expected]) =>
      shellCacheModule.isReadOnlyCommand(command) !== expected,
  );
  check(
    "shell_cache_readonly_allowlist",
    readOnlyFailures.length === 0,
    readOnlyFailures,
  );

  // 12c. Symbol extraction regression (names are the final capture group; keyword
  // groups like "fn"/"const" must never be reported as the symbol name).
  const rustOutline = symbolDiffModule.extractSymbols(
    [
      "pub fn compute_stats(values: &[i64]) -> i64 {",
      "    values.iter().sum()",
      "}",
      "",
      "pub struct Stats { total: i64 }",
      "",
      "fn helper() {}",
    ].join("\n"),
  );
  check(
    "symbol_extract_rust_names",
    rustOutline.some(
      (s) => s.name === "compute_stats" && s.kind === "function",
    ) &&
      rustOutline.some((s) => s.name === "Stats" && s.kind === "struct") &&
      rustOutline.some((s) => s.name === "helper" && s.kind === "function"),
    rustOutline,
  );
  const tsOutline = symbolDiffModule.extractSymbols(
    [
      "export async function loadData() {",
      "  return 1;",
      "}",
      "export abstract class Base {}",
      "export interface Shape {}",
      "export const answer = 42;",
      "export type Pair<T> = [T, T];",
    ].join("\n"),
  );
  check(
    "symbol_extract_ts_names",
    tsOutline.some((s) => s.name === "loadData" && s.kind === "function") &&
      tsOutline.some((s) => s.name === "Base" && s.kind === "class") &&
      tsOutline.some((s) => s.name === "Shape" && s.kind === "interface") &&
      tsOutline.some((s) => s.name === "answer" && s.kind === "constant") &&
      tsOutline.some((s) => s.name === "Pair" && s.kind === "type"),
    tsOutline,
  );
  // 12d. Fixture matrix — the constructs agents actually navigate by, per language.
  const symbolMatrix: Array<[string, string, string]> = [
    // TypeScript / JavaScript
    ["export default async function boot() {}", "boot", "function"],
    ["export default class Widget {}", "Widget", "class"],
    ["export default interface Props {}", "Props", "interface"],
    ["export default type Pair = [number, number];", "Pair", "type"],
    ["export enum Direction { Up }", "Direction", "enum"],
    ["class Plain {}", "Plain", "class"],
    ["const answer = 42;", "answer", "constant"],
    ["export type Pair<T> = [T, T];", "Pair", "type"],
    // Rust
    ["pub(crate) fn helper() {}", "helper", "function"],
    ["pub(super) fn hidden() {}", "hidden", "function"],
    ["async fn load() {}", "load", "function"],
    ["unsafe fn raw() {}", "raw", "function"],
    ["fn plain() {}", "plain", "function"],
    ["pub struct Stats;", "Stats", "struct"],
    ["pub enum Mode { A }", "Mode", "enum"],
    ["pub trait Iface {}", "Iface", "interface"],
    ["type Alias = u64;", "Alias", "type"],
    ["pub const LIMIT: usize = 10;", "LIMIT", "constant"],
    ["pub static GLOBAL: u32 = 1;", "GLOBAL", "constant"],
    ["static mut STATE: u32 = 1;", "STATE", "constant"],
    ["impl Iface for Engine {}", "Engine", "class"],
    ["impl<T> Runner<T> {}", "Runner", "class"],
    ["impl Foo<T> {}", "Foo", "class"],
    ["impl std::io::Write for Buf {}", "Buf", "class"],
    ["async getToken(): Promise<string> {", "getToken", "method"],
    ["static create(): Widget {", "create", "method"],
    ["constructor(private readonly repo: Repo) {", "constructor", "method"],
    ["get size(): number {", "size", "method"],
    ["set size(v: number) {", "size", "method"],
    ["macro_rules! fancy_assert { () => {} }", "fancy_assert", "macro"],
    // Python
    ["async def fetch():", "fetch", "function"],
    ["def plain():", "plain", "function"],
    ["class Thing:", "Thing", "class"],
    ["class Thing(Base):", "Thing", "class"],
    // Go
    ["func (s *Service) Start() {}", "Start", "function"],
    ["func TopLevel() {}", "TopLevel", "function"],
    ["func Map[T any](s []T) {}", "Map", "function"],
    ["type Config struct{}", "Config", "type"],
    ["const MaxConn = 10", "MaxConn", "constant"],
  ];
  const symbolMatrixFailures = symbolMatrix.filter(([src, name, kind]) => {
    const found = symbolDiffModule
      .extractSymbols(src)
      .find((s) => s.name === name && String(s.kind) === kind);
    return !found;
  });
  check(
    "symbol_extract_fixture_matrix",
    symbolMatrixFailures.length === 0,
    symbolMatrixFailures.map(([src]) => src),
  );
  check(
    "symbol_extract_keyword_and_call_not_symbols",
    symbolDiffModule
      .extractSymbols("if (condition) {\n  doThing();\n}\n")
      .every((s) => s.name !== "if") &&
      symbolDiffModule.extractSymbols('fetch("/api");\n').length === 0,
  );
  return {};
}
