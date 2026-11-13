/**
 * project_shell_run MCP elicitation regressions (elicitation is part of VENIRA_SHELL_MODE).
 *
 * The elicitation path lives in tools/project-shell.ts. scripts/verify/harness pins the
 * default `balanced` mode, so this dedicated script covers it with a fake MCP server and a fake
 * backend executor that redeems real approvals (real data dir, real HMAC grants):
 *   - client without the `elicitation` capability: no prompt, approval_required envelope;
 *   - accept + approve (remember off): grant recorded as `once`, command retried and runs;
 *   - accept + approve + remember: `session` scope only for allowlisted rules, else falls back to `once`;
 *   - accept without approve, decline, cancel, elicitation error, non-boolean approve: nothing is granted;
 *   - the retry never carries model-supplied approval_token / approval_scope.
 *
 * Run with: npm run test:shell-elicitation
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = await mkdtemp(path.join(os.tmpdir(), "venira-shell-elicitation-"));
process.env.VENIRA_DATA_DIR = dataDir;
// Elicitation is selected by the shell mode; `balanced` prompts for every ask-rule command.
process.env.VENIRA_SHELL_MODE = "balanced";
// Only `git_push` may be approved for the whole session in this test.
process.env.VENIRA_SESSION_GRANT_RULES = "git_push";

const load = (rel: string) => import(pathToFileURL(path.join(repoRoot, rel)).href);
const shellMod = await load("tools/project-shell.ts");
const approvals = await load("lib/approvals.ts");
const gate = await load("lib/approval-gate.ts");
const { SESSION_ID } = await load("lib/session.ts");

type Args = Record<string, unknown>;
type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const COMMAND = "git push --force origin main";
const SHELL = "bash";
const CWD = repoRoot;
const RULE_SESSION_OK = "ask.git_push";
const RULE_ONCE_ONLY = "ask.git_history_rewrite";

type Harness = {
  calls: Args[];
  redeemed: Array<{ ok: boolean; scope?: string; reason?: string }>;
  deps: unknown;
  approvalId: () => string;
  binding: () => string;
};

/** Fake backend: first call creates a real pending approval, a retry redeems the real grant. */
function makeHarness(rule: string): Harness {
  const calls: Args[] = [];
  const redeemed: Harness["redeemed"] = [];
  let pendingId = "";
  let pendingBinding = "";
  const approvalResponse = () => ({
    status: "completed",
    result: {
      kind: "shell_approval",
      data: {
        approval_id: pendingId,
        command: COMMAND,
        rule,
        reason: "elicitation test",
        approval: { approve_command: gate.approveCommand(pendingId) },
      },
    },
  });
  const deps = {
    callHost: async () => ({}),
    execute: async (operation: string, args: Args) => {
      assert.equal(operation, "shell_run");
      calls.push(args);
      if (typeof args.approval_id !== "string") {
        pendingBinding = approvals.bindingHash({ command: COMMAND, shell: SHELL, cwd: CWD, secret_env: [], rule });
        const req = gate.requestApproval("shell", SESSION_ID, {
          tool: "project_shell_run",
          command: COMMAND,
          shell: SHELL,
          cwd: CWD,
          secretEnv: [],
          rule,
          reason: "elicitation test",
          binding: pendingBinding,
        });
        pendingId = req.approval_id;
        return { response: approvalResponse(), cached: false };
      }
      const verdict = gate.redeemApproval("shell", SESSION_ID, args.approval_id, pendingBinding, "project_shell_run");
      redeemed.push(verdict);
      if (!verdict.ok) return { response: approvalResponse(), cached: false };
      return {
        response: { status: "completed", result: { kind: "shell_run", data: { run_id: "run-1", running: false, exit_code: 0 } } },
        cached: false,
      };
    },
  };
  return { calls, redeemed, deps, approvalId: () => pendingId, binding: () => pendingBinding };
}

type Reply = () => Promise<unknown>;

function fakeServer(options: { capable: boolean; reply?: Reply }) {
  const asked: Array<{ params: { message?: string; requestedSchema?: { required?: string[] } }; opts: unknown }> = [];
  const server = {
    server: {
      getClientCapabilities: () => (options.capable ? { elicitation: {} } : {}),
      elicitInput: async (params: never, opts: unknown) => {
        asked.push({ params, opts });
        if (!options.reply) throw new Error("elicitInput must not be called");
        return options.reply();
      },
    },
  } as unknown as McpServer;
  return { server, asked };
}

const accept = (content: Record<string, unknown>): Reply => async () => ({ action: "accept", content });

async function run(h: Harness, server: McpServer, args: Args = { command: COMMAND }): Promise<ToolResult> {
  return (await shellMod.runShell(args, server, h.deps)) as ToolResult;
}

const textOf = (r: ToolResult) => r.content.map((c) => c.text).join("\n");

function assertApprovalRequired(result: ToolResult, h: Harness) {
  assert.equal(result.isError, true, textOf(result));
  assert.match(textOf(result), /approval_required/);
  assert.equal(h.calls.length, 1, "the command must not be retried");
  assert.equal(h.redeemed.length, 0);
  // Nothing was granted: the pending approval is still not redeemable.
  const verdict = approvals.verifyApprovalGrant(h.approvalId(), SESSION_ID, h.binding());
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "not_granted");
}

let checks = 0;
async function check(name: string, fn: () => Promise<void>) {
  await fn();
  checks += 1;
  console.log(`ok ${checks} - ${name}`);
}

try {
  await check("SHELL_ELICIT is on in balanced mode", async () => {
    assert.equal(shellMod.SHELL_ELICIT, true);
  });

  await check("elicitation matrix across modes", async () => {
    assert.equal(shellMod.shellElicitForMode("balanced", undefined), true, "balanced asks always");
    assert.equal(shellMod.shellElicitForMode("balanced", "ask.git_push"), true, "balanced: ordinary ask prompts");
    assert.equal(shellMod.shellElicitForMode("balanced", "ask.network_access"), true, "balanced: high-risk ask prompts");
    assert.equal(shellMod.shellElicitForMode("permissive", "ask.network_access"), true, "permissive: high-risk prompts");
    assert.equal(shellMod.shellElicitForMode("permissive", "ask.command_substitution"), true, "permissive: command substitution prompts");
    assert.equal(shellMod.shellElicitForMode("permissive", "ask.git_push"), false, "permissive: ordinary ask does not prompt");
    assert.equal(shellMod.shellElicitForMode("strict", "ask.network_access"), false, "strict: CLI grant path only");
    assert.equal(shellMod.shellElicitForMode("off", "ask.network_access"), false, "off: bypass");
  });

  await check("client without elicitation capability is never prompted", async () => {
    const h = makeHarness(RULE_SESSION_OK);
    const { server, asked } = fakeServer({ capable: false });
    const result = await run(h, server);
    assert.equal(asked.length, 0);
    assertApprovalRequired(result, h);
    assert.match(textOf(result), new RegExp(h.approvalId()));
  });

  await check("accept + approve (remember off) grants once and runs the command", async () => {
    const h = makeHarness(RULE_SESSION_OK);
    const { server, asked } = fakeServer({ capable: true, reply: accept({ approve: true, remember: false }) });
    const result = await run(h, server);
    assert.equal(asked.length, 1);
    assert.ok(asked[0].params.message?.includes(COMMAND), "prompt shows the exact command");
    assert.deepEqual(asked[0].params.requestedSchema?.required, ["approve"]);
    assert.notEqual(result.isError, true, textOf(result));
    assert.equal(h.calls.length, 2);
    assert.equal(h.calls[1].approval_id, h.approvalId());
    assert.deepEqual(h.redeemed, [{ ok: true, scope: "once" }]);
    assert.match(textOf(result), /run-1/);
  });

  await check("accept + approve + remember grants session scope for an allowlisted rule", async () => {
    const h = makeHarness(RULE_SESSION_OK);
    const { server } = fakeServer({ capable: true, reply: accept({ approve: true, remember: true }) });
    const result = await run(h, server);
    assert.notEqual(result.isError, true, textOf(result));
    assert.deepEqual(h.redeemed, [{ ok: true, scope: "session" }]);
  });

  await check("remember falls back to once when the rule is not allowed session-wide", async () => {
    const h = makeHarness(RULE_ONCE_ONLY);
    const { server } = fakeServer({ capable: true, reply: accept({ approve: true, remember: true }) });
    const result = await run(h, server);
    assert.notEqual(result.isError, true, textOf(result));
    assert.deepEqual(h.redeemed, [{ ok: true, scope: "once" }]);
  });

  await check("retry drops model-supplied approval_token and approval_scope", async () => {
    const h = makeHarness(RULE_SESSION_OK);
    const { server } = fakeServer({ capable: true, reply: accept({ approve: true }) });
    const result = await run(h, server, {
      command: COMMAND,
      approval_token: "forged",
      approval_scope: "session",
      approval_id: undefined,
    });
    assert.notEqual(result.isError, true, textOf(result));
    assert.equal(h.calls.length, 2);
    assert.equal("approval_token" in h.calls[1], false);
    assert.equal("approval_scope" in h.calls[1], false);
    assert.deepEqual(h.redeemed, [{ ok: true, scope: "once" }]);
  });

  await check("accept without approve grants nothing", async () => {
    const h = makeHarness(RULE_SESSION_OK);
    const { server, asked } = fakeServer({ capable: true, reply: accept({ approve: false, remember: true }) });
    const result = await run(h, server);
    assert.equal(asked.length, 1);
    assertApprovalRequired(result, h);
  });

  await check("a non-boolean approve value is not treated as approval", async () => {
    const h = makeHarness(RULE_SESSION_OK);
    const { server } = fakeServer({ capable: true, reply: accept({ approve: "true", remember: "true" }) });
    assertApprovalRequired(await run(h, server), h);
  });

  await check("accept with no content grants nothing", async () => {
    const h = makeHarness(RULE_SESSION_OK);
    const { server } = fakeServer({ capable: true, reply: async () => ({ action: "accept" }) });
    assertApprovalRequired(await run(h, server), h);
  });

  for (const action of ["decline", "cancel"]) {
    await check(`${action} grants nothing`, async () => {
      const h = makeHarness(RULE_SESSION_OK);
      const { server } = fakeServer({
        capable: true,
        reply: async () => ({ action, content: { approve: true, remember: true } }),
      });
      assertApprovalRequired(await run(h, server), h);
    });
  }

  await check("an elicitation error fails closed", async () => {
    const h = makeHarness(RULE_SESSION_OK);
    const { server } = fakeServer({
      capable: true,
      reply: async () => {
        throw new Error("client went away");
      },
    });
    assertApprovalRequired(await run(h, server), h);
  });

  console.log(`\nShell elicitation tests passed (${checks} checks).`);
} finally {
  await rm(dataDir, { recursive: true, force: true });
}
