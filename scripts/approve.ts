import readline from "node:readline";
import { readPendingApproval, writeApprovalGrant, sessionScopeAllowed } from "../lib/approvals.js";

const args = process.argv.slice(2);
const wantSession = args.includes("--session");
const assumeYes = args.includes("--yes") || args.includes("-y");
const id = args.find((a) => !a.startsWith("-"));

if (!id) {
  console.error("Usage: npx venira-mcp --approve <approval_id> [--session] [--yes]");
  process.exit(2);
}

// Approving is a human decision. Refuse when stdin/stdout are not a terminal so
// an agent cannot approve its own request by running this CLI through a tool.
if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error("Refusing to approve: this command must be run by a person in an interactive terminal.");
  process.exit(3);
}

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => { rl.close(); resolve(answer); }));
}

try {
  const p = readPendingApproval(id);
  if (!p) {
    console.error(`Unknown approval_id: ${id}`);
    process.exit(1);
  }
  if (p.expires_at <= Date.now()) {
    console.error(`Approval ${id} expired.`);
    process.exit(1);
  }
  if (wantSession && !sessionScopeAllowed(p.rule)) {
    console.error(`Session scope is not allowed for rule ${p.rule}. Approve it once (omit --session).`);
    process.exit(1);
  }
  console.log(`Rule:    ${p.rule}`);
  console.log(`Reason:  ${p.reason}`);
  console.log(`Shell:   ${p.shell}`);
  console.log(`Cwd:     ${p.cwd}`);
  if (p.secret_env.length > 0) console.log(`Secrets: ${p.secret_env.join(", ")}`);
  const tool = p.tool ?? "project_shell_run";
  console.log(`${tool === "project_execute_js" ? "Code:    " : "Command: "}${p.command}`);
  console.log(`Scope:   ${wantSession ? "session (same command group until it expires)" : "once"}`);
  if (!assumeYes) {
    const answer = (await ask("Approve this call? [y/N] ")).trim().toLowerCase();
    if (answer !== "y" && answer !== "yes") {
      console.log("Not approved.");
      process.exit(1);
    }
  }
  writeApprovalGrant(id, "cli", wantSession ? "session" : "once");
  console.log(`Approved ${id}. Retry the original ${tool} with approval_id="${id}".`);
  process.exit(0);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
