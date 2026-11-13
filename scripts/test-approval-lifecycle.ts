/**
 * Approval lifecycle regressions.
 *
 * Covers the invariants the approval model promises:
 *   - pending approvals expire (fixed 5-minute pending TTL);
 *   - a grant is bound to one session;
 *   - a grant is bound to the exact call (binding hash);
 *   - a grant is single-use (replay is rejected);
 *   - two processes redeeming the same id concurrently produce exactly one run;
 *   - session scope is only allowed for allowlisted rules.
 *
 * Run with: npm run test:approval-lifecycle
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = await mkdtemp(path.join(os.tmpdir(), "venira-approval-lifecycle-"));
process.env.VENIRA_DATA_DIR = dataDir;
// Keep the test independent from the caller's profile/overrides.
process.env.VENIRA_SESSION_GRANT_RULES = "";

const approvals = await import(pathToFileURL(path.join(repoRoot, "lib", "approvals.ts")).href);
const gate = await import(pathToFileURL(path.join(repoRoot, "lib", "approval-gate.ts")).href);

type Subject = Parameters<typeof gate.requestApproval>[2];

const SESSION = "approval-lifecycle-session";
const command = "git push --force origin main";
const shell = "bash";
const cwd = repoRoot;
const secretEnv: string[] = [];

function bindingFor(
  rule: string,
  overrides: Partial<{ command: string; shell: string; cwd: string; secret_env: string[] }> = {},
) {
  return approvals.bindingHash({
    command: overrides.command ?? command,
    shell: overrides.shell ?? shell,
    cwd: overrides.cwd ?? cwd,
    secret_env: overrides.secret_env ?? secretEnv,
    rule,
  });
}

function subject(rule: string, binding: string): Subject {
  return {
    tool: "project_shell_run",
    command,
    shell,
    cwd,
    secretEnv,
    rule,
    reason: `approval lifecycle test: ${rule}`,
    binding,
  };
}

function request(rule = "ask.git_history_rewrite") {
  const binding = bindingFor(rule);
  return { binding, request: gate.requestApproval("shell", SESSION, subject(rule, binding)) };
}

let checks = 0;
function check(name: string, fn: () => void) {
  fn();
  checks += 1;
  console.log(`ok ${checks} - ${name}`);
}

function waitFor(predicate: () => boolean, label: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) return resolve();
      if (Date.now() > deadline) return reject(new Error(`timed out waiting for ${label}`));
      setTimeout(poll, 25);
    };
    poll();
  });
}

try {
  // TTL contract: the pending approval window is fixed, not caller-controlled.
  check("pending approval TTL is five minutes", () => {
    assert.equal(gate.APPROVAL_PENDING_TTL_MS, 5 * 60 * 1000);
  });

  check("a pending approval is not redeemable before a human grants it", () => {
    const { binding, request: req } = request();
    const verdict = approvals.verifyApprovalGrant(req.approval_id, SESSION, binding);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, "not_granted");
    assert.equal(req.expires_at - req.created_at, gate.APPROVAL_PENDING_TTL_MS);
  });

  check("a granted approval is single-use (replay is rejected)", () => {
    const { binding, request: req } = request();
    approvals.writeApprovalGrant(req.approval_id, "cli", "once");

    const first = gate.redeemApproval("shell", SESSION, req.approval_id, binding, "project_shell_run");
    assert.deepEqual(first, { ok: true, scope: "once" });

    const replay = gate.redeemApproval("shell", SESSION, req.approval_id, binding, "project_shell_run");
    assert.equal(replay.ok, false);
    if (!replay.ok) assert.equal(replay.reason, "already_used");
    assert.equal(approvals.consumeApproval(req.approval_id), false);
    assert.throws(() => approvals.writeApprovalGrant(req.approval_id, "cli", "once"), /already used/);
  });

  check("a grant is isolated to the session that created it", () => {
    const { binding, request: req } = request();
    approvals.writeApprovalGrant(req.approval_id, "cli", "once");

    const crossSession = approvals.verifyApprovalGrant(req.approval_id, "another-session", binding);
    assert.equal(crossSession.ok, false);
    assert.equal(crossSession.reason, "session_mismatch");

    const ownSession = gate.redeemApproval("shell", SESSION, req.approval_id, binding, "project_shell_run");
    assert.equal(ownSession.ok, true);
  });

  check("a grant is bound to the exact command/shell/cwd/secret_env", () => {
    const { binding, request: req } = request();
    approvals.writeApprovalGrant(req.approval_id, "cli", "once");

    const variants: Array<[string, string]> = [
      ["command", bindingFor("ask.git_history_rewrite", { command: "git push --force alpha origin main" })],
      ["shell", bindingFor("ask.git_history_rewrite", { shell: "powershell" })],
      ["cwd", bindingFor("ask.git_history_rewrite", { cwd: path.join(cwd, "sub") })],
      ["secret_env", bindingFor("ask.git_history_rewrite", { secret_env: ["GITHUB_TOKEN"] })],
    ];
    for (const [label, changed] of variants) {
      const verdict = approvals.verifyApprovalGrant(req.approval_id, SESSION, changed);
      assert.equal(verdict.ok, false, label);
      assert.equal(verdict.reason, "binding_mismatch", label);
    }

    assert.equal(gate.redeemApproval("shell", SESSION, req.approval_id, binding, "project_shell_run").ok, true);
  });

  check("an expired pending approval cannot be granted or redeemed", () => {
    const rule = "ask.network_access";
    const binding = bindingFor(rule);
    const now = Date.now();
    const id = "expired-approval-0001";
    approvals.createPendingApproval({
      approval_id: id,
      session_id: SESSION,
      command,
      shell,
      cwd,
      secret_env: [],
      rule,
      reason: "expired approval lifecycle test",
      tool: "project_shell_run",
      binding,
      expires_at: now - 1,
      status: "pending",
      created_at: now - gate.APPROVAL_PENDING_TTL_MS - 1,
    });

    const pending = approvals.readPendingApproval(id);
    assert.equal(pending?.status, "expired");
    const verdict = approvals.verifyApprovalGrant(id, SESSION, binding);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, "expired");
    assert.throws(() => approvals.writeApprovalGrant(id, "cli", "once"), /expired/);
  });

  check("a tampered pending record fails its MAC and is treated as unknown", () => {
    const { request: req } = request();
    const pendingPath = path.join(dataDir, "approvals", `${req.approval_id}.json`);
    const record = JSON.parse(readFileSync(pendingPath, "utf8"));
    record.command = "git push --force tampered origin main";
    writeFileSync(pendingPath, JSON.stringify(record));
    assert.equal(approvals.readPendingApproval(req.approval_id), null);
  });

  // Regression: JS records store the canonical binding string (`code\0argv`),
  // not a truncated display copy, so the binding recomputation in
  // readPendingApproval accepts a legitimate record and the human still sees
  // readable code.
  check("a JS pending record is grantable and renders readable code", () => {
    const code = 'console.log("js-approval-ok");';
    const argv = ["--flag", "value"];
    const jsCommand = `${code}\u0000${JSON.stringify(argv)}`;
    const rule = "ask.js_exec";
    const jsBinding = approvals.bindingHash({
      command: jsCommand,
      shell: "node",
      cwd,
      secret_env: [],
      rule,
    });
    const req = gate.requestApproval("js", SESSION, {
      tool: "project_execute_js",
      command: jsCommand,
      shell: "node",
      cwd,
      secretEnv: [],
      rule,
      reason: "js approval lifecycle test",
      binding: jsBinding,
    });

    const pending = approvals.readPendingApproval(req.approval_id);
    assert.equal(pending?.command, jsCommand);
    approvals.writeApprovalGrant(req.approval_id, "cli", "once");
    assert.equal(gate.redeemApproval("js", SESSION, req.approval_id, jsBinding, "project_execute_js").ok, true);

    const rendered = gate.formatPendingCommand(pending!);
    assert.ok(rendered.startsWith(code));
    assert.ok(!rendered.includes("\u0000"));
    assert.match(rendered, /argv:\s+\["--flag","value"\]/);
  });

  check("session scope is rejected for rules outside the allowlist", () => {
    const { request: req } = request("ask.network_access");
    assert.throws(() => approvals.writeApprovalGrant(req.approval_id, "cli", "session"), /session scope is not allowed/);
  });

  check("session scope is allowed for a built-in session rule", () => {
    const { binding, request: req } = request("cd_outside_workspace");
    approvals.writeApprovalGrant(req.approval_id, "cli", "session");
    const verdict = approvals.verifyApprovalGrant(req.approval_id, SESSION, binding);
    assert.equal(verdict.ok, true);
    assert.equal(verdict.scope, "session");
  });

  // Real cross-process race: both children verify while the grant still exists,
  // wait on a barrier, then both try to claim it. Exactly one may win.
  const worker = path.join(dataDir, "consume-worker.mts");
  writeFileSync(
    worker,
    `import { existsSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const env = process.env;
const approvals = await import(pathToFileURL(env.APPROVALS_MODULE!).href);
const verdict = approvals.verifyApprovalGrant(env.APPROVAL_ID!, env.APPROVAL_SESSION!, env.APPROVAL_BINDING!);
writeFileSync(env.READY_FILE!, verdict.ok ? "verified" : "failed:" + verdict.reason);
if (!verdict.ok) process.exit(12);
while (!existsSync(env.GO_FILE!)) await new Promise((resolve) => setTimeout(resolve, 5));
process.exit(approvals.consumeApproval(env.APPROVAL_ID!) ? 10 : 11);
`,
  );

  const { binding, request: req } = request();
  approvals.writeApprovalGrant(req.approval_id, "cli", "once");

  const runs = ["worker-a", "worker-b"].map((name) => {
    const readyFile = path.join(dataDir, `${name}.ready`);
    const child = spawn(process.execPath, ["--import", "tsx", worker], {
      cwd: repoRoot,
      env: {
        ...process.env,
        VENIRA_DATA_DIR: dataDir,
        APPROVALS_MODULE: path.join(repoRoot, "lib", "approvals.ts"),
        APPROVAL_ID: req.approval_id,
        APPROVAL_SESSION: SESSION,
        APPROVAL_BINDING: binding,
        READY_FILE: readyFile,
        GO_FILE: path.join(dataDir, "go"),
      },
      stdio: "ignore",
    });
    const done = new Promise<{ name: string; code: number | null }>((resolve) => {
      child.once("exit", (code) => resolve({ name, code }));
    });
    return { name, readyFile, done };
  });

  await waitFor(
    () => runs.every(({ readyFile }) => existsSync(readyFile) && readFileSync(readyFile, "utf8") === "verified"),
    "both workers to verify the grant",
  );
  writeFileSync(path.join(dataDir, "go"), "go");
  const outcomes = await Promise.all(runs.map(({ done }) => done));

  check("concurrent redemption has exactly one winner", () => {
    const winners = outcomes.filter(({ code }) => code === 10);
    const losers = outcomes.filter(({ code }) => code === 11);
    assert.equal(winners.length, 1, JSON.stringify(outcomes));
    assert.equal(losers.length, 1, JSON.stringify(outcomes));
    assert.equal(approvals.consumeApproval(req.approval_id), false);
  });

  console.log(`\nApproval lifecycle tests passed (${checks} checks).`);
} finally {
  await rm(dataDir, { recursive: true, force: true });
}
