/**
 * Shell policy adversarial coverage.
 *
 * The policy is a guard rail, not a sandbox, but a hard-deny rule that a plain
 * re-spelling bypasses is worse than no rule: it advertises protection it does
 * not provide. These cases are table-driven so every confirmed bypass keeps a
 * stable case id. Each hard-deny case is checked twice:
 *
 *   balanced    -> deny   (never run)
 *   permissive  -> ask    (hard-deny degrades to a human approval)
 *
 * Run with: npm run test:shell-policy-adversarial
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDir = await mkdtemp(path.join(os.tmpdir(), "venira-shell-adversarial-"));
const workspaceDir = path.join(tempDir, "workspace");
await mkdir(workspaceDir);
process.env.VENIRA_WORKSPACE = workspaceDir;
process.env.VENIRA_DATA_DIR = tempDir;
// Keep the suite independent from the caller's profile/overrides.
delete process.env.VENIRA_SHELL_MODE;
delete process.env.VENIRA_SHELL_POLICY_FILE;
delete process.env.VENIRA_SHELL_OVERRIDES;
process.env.VENIRA_SECURITY_PROFILE = "balanced";

const policy = (await import(
  pathToFileURL(path.join(repoRoot, "lib", "shell-policy.ts")).href
)) as typeof import("../lib/shell-policy.js");

const evaluate = (command: string, mode: "balanced" | "permissive") =>
  policy.evaluateShellCommand(command, workspaceDir, { mode });

let checks = 0;
function check(name: string, fn: () => void) {
  fn();
  checks += 1;
  console.log(`ok ${checks} - ${name}`);
}

type HardDenyCase = { id: string; command: string; rule: string };

/** Root/home deletion: path parsing, quoting, flag spelling and command paths. */
const ROOT_DELETE_CASES: HardDenyCase[] = [
  { id: "root_slash", command: "rm -rf /", rule: "deny.root_delete" },
  { id: "root_double_slash", command: "rm -rf //", rule: "deny.root_delete" },
  { id: "root_dot_slash", command: "rm -rf /./", rule: "deny.root_delete" },
  { id: "root_wildcard", command: "rm -rf /*", rule: "deny.root_delete" },
  { id: "home_bare", command: "rm -rf ~", rule: "deny.root_delete" },
  { id: "home_trailing_slash", command: "rm -rf ~/", rule: "deny.root_delete" },
  { id: "home_dollar", command: "rm -rf $HOME", rule: "deny.root_delete" },
  { id: "home_dollar_quoted", command: 'rm -rf "$HOME"', rule: "deny.root_delete" },
  { id: "home_braced", command: "rm -rf ${HOME}", rule: "deny.root_delete" },
  { id: "home_wildcard", command: "rm -rf ~/*", rule: "deny.root_delete" },
  { id: "flag_fr", command: "rm -fr /", rule: "deny.root_delete" },
  { id: "flag_split", command: "rm -r -f /", rule: "deny.root_delete" },
  { id: "flag_long", command: "rm --recursive --force /", rule: "deny.root_delete" },
  { id: "quoted_command", command: "r''m -rf /", rule: "deny.root_delete" },
  { id: "double_quoted_command", command: 'r"m" -rf /', rule: "deny.root_delete" },
  { id: "escaped_command", command: "\\rm -rf /", rule: "deny.root_delete" },
  { id: "command_path", command: "/bin/rm -rf /", rule: "deny.root_delete" },
];

/** Privilege escalation: quoting, aliases and command paths. */
const PRIVILEGE_CASES: HardDenyCase[] = [
  { id: "sudo_bare", command: "sudo id", rule: "deny.privilege_escalation" },
  { id: "sudo_quoted", command: '"sudo" id', rule: "deny.privilege_escalation" },
  { id: "sudo_joined_quotes", command: "su''do id", rule: "deny.privilege_escalation" },
  { id: "sudo_command_path", command: "/usr/bin/sudo id", rule: "deny.privilege_escalation" },
  { id: "sudo_env_wrapper", command: "env sudo id", rule: "deny.privilege_escalation" },
  { id: "sudo_command_wrapper", command: "command sudo id", rule: "deny.privilege_escalation" },
  {
    id: "powershell_start_process_runas",
    command: "Start-Process powershell -Verb RunAs",
    rule: "deny.privilege_escalation",
  },
];

/** Destructive deletes of filesystem roots / drive roots / the whole home. */
const ROOT_DELETE_WINDOWS_CASES: HardDenyCase[] = [
  { id: "filesystem_drive_root_remove_item", command: "Remove-Item -Recurse -Force C:\\", rule: "deny.filesystem_root_delete" },
  { id: "filesystem_home_remove_item", command: "Remove-Item -Recurse -Force $HOME", rule: "deny.filesystem_root_delete" },
  { id: "filesystem_users_tree_remove_item", command: "Remove-Item -Recurse -Force C:\\Users", rule: "deny.filesystem_root_delete" },
  { id: "filesystem_users_tree_wildcard", command: "Remove-Item -Recurse -Force C:\\Users\\*", rule: "deny.filesystem_root_delete" },
  { id: "filesystem_users_tree_prefixes", command: "ri -Rec -Fo C:\\Users", rule: "deny.filesystem_root_delete" },
  { id: "filesystem_drive_root_rm", command: "rm -rf C:\\", rule: "deny.root_delete" },
];

/** Protected secret files: alternate spellings and globs. */
const PROTECTED_CASES: HardDenyCase[] = [
  { id: "env_bare", command: "cat .env", rule: "deny.protected_file_access" },
  { id: "env_dot_slash", command: "cat ./.env", rule: "deny.protected_file_access" },
  { id: "env_parent_segment", command: "cat ./sub/../.env", rule: "deny.protected_file_access" },
  { id: "env_quoting", command: "cat .e''nv", rule: "deny.protected_file_access" },
  { id: "env_double_quotes", command: 'cat ".env"', rule: "deny.protected_file_access" },
  { id: "env_glob_prefix", command: "cat *.env", rule: "deny.protected_file_access" },
  { id: "env_glob_suffix", command: "cat *env", rule: "deny.protected_file_access" },
  { id: "env_trailing_glob", command: "cat .env*", rule: "deny.protected_file_access" },
  { id: "env_char_class", command: "cat .e[n]v", rule: "deny.protected_file_access" },
  { id: "env_char_class_leading", command: "cat [.]env", rule: "deny.protected_file_access" },
  { id: "env_type", command: "type .env", rule: "deny.protected_file_access" },
  { id: "env_powershell", command: "Get-Content './.env'", rule: "deny.protected_file_access" },
  { id: "env_grep", command: "grep x .env", rule: "deny.protected_file_access" },
  { id: "env_select_string", command: "Select-String -Path .env x", rule: "deny.protected_file_access" },
  { id: "ssh_key_glob", command: "cat id_*", rule: "deny.protected_file_access" },
];

try {
  for (const testCase of [...ROOT_DELETE_CASES, ...PRIVILEGE_CASES, ...PROTECTED_CASES, ...ROOT_DELETE_WINDOWS_CASES]) {
    check(`policy_adv_${testCase.id}_balanced_denies`, () => {
      const decision = evaluate(testCase.command, "balanced");
      assert.equal(decision.tier, "deny", `${testCase.command}: ${JSON.stringify(decision)}`);
      assert.equal(decision.rule, testCase.rule, testCase.command);
    });

    check(`policy_adv_${testCase.id}_permissive_asks`, () => {
      const decision = evaluate(testCase.command, "permissive");
      assert.equal(decision.tier, "ask", `${testCase.command}: ${JSON.stringify(decision)}`);
      assert.equal(decision.rule, `ask.${testCase.rule}`, testCase.command);
    });
  }

  check("policy_adv_workspace_rm_stays_ask_not_deny", () => {
    for (const flag of ["-rf", "-fr", "-r -f", "--recursive --force"]) {
      const command = `rm ${flag} ./probe-file.txt`;
      const decision = evaluate(command, "balanced");
      assert.equal(decision.tier, "ask", `${command}: ${JSON.stringify(decision)}`);
      assert.notEqual(decision.rule, "deny.root_delete", command);
    }
  });

  check("policy_adv_broad_globs_do_not_become_hard_deny", () => {
    for (const command of ["cat *", "cat *.*", "cat *.json"]) {
      const decision = evaluate(command, "balanced");
      assert.notEqual(decision.tier, "deny", `${command}: ${JSON.stringify(decision)}`);
      assert.notEqual(decision.rule, "deny.protected_file_access", command);
    }
  });

  check("policy_adv_tsx_needs_approval_like_node", () => {
    for (const command of [
      "tsx probe.ts",
      "tsx malicious.ts",
      "./node_modules/.bin/tsx probe.ts",
      "ts-node probe.ts",
      "tsx --eval console.log(1)",
    ]) {
      const decision = evaluate(command, "balanced");
      assert.equal(decision.tier, "ask", `${command}: ${JSON.stringify(decision)}`);
      assert.equal(decision.rule, "ask.dynamic_execution", command);
    }
    assert.equal(evaluate("tsx --version", "balanced").tier, "allow");
    assert.equal(evaluate("node -e \"console.log(1)\"", "balanced").rule, "ask.dynamic_execution");
  });

  check("policy_adv_write_then_run_requires_approval", () => {
    const commands = [
      "printf 'x' > probe.sh; bash probe.sh",
      "printf 'x' > probe.ps1; powershell -File ./probe.ps1",
      "printf 'x' > probe.js; node probe.js",
      "printf 'x' > probe.ts; tsx probe.ts",
    ];
    for (const command of commands) {
      const decision = evaluate(command, "balanced");
      assert.equal(decision.tier, "ask", `${command}: ${JSON.stringify(decision)}`);
    }
  });

  check("policy_adv_safe_commands_are_unchanged", () => {
    assert.equal(evaluate("git status", "balanced").tier, "allow");
    assert.equal(evaluate("git diff --stat", "balanced").tier, "allow");
    assert.equal(evaluate("tsc --noEmit", "balanced").tier, "allow");
    assert.equal(evaluate("npx --no-install tsc --noEmit", "balanced").tier, "allow");
  });

  check("policy_adv_dialect_bash", () => {
    assert.equal(
      policy.evaluateShellCommand("bash -c 'rm -rf /'", workspaceDir, { shell: "bash", mode: "balanced" }).rule,
      "ask.dynamic_execution",
    );
    assert.equal(
      policy.evaluateShellCommand("rm -rf /", workspaceDir, { shell: "bash", mode: "balanced" }).tier,
      "deny",
    );
    assert.equal(
      policy.evaluateShellCommand("bash -c 'cat .env'", workspaceDir, { shell: "bash", mode: "balanced" }).rule,
      "ask.dynamic_execution",
    );
  });

  check("policy_adv_dialect_powershell", () => {
    assert.equal(
      policy.evaluateShellCommand("Remove-Item -Recurse -Force C:\\", workspaceDir, { shell: "powershell", mode: "balanced" }).tier,
      "deny",
    );
    assert.equal(
      policy.evaluateShellCommand("Remove-Item -Recurse -Force $HOME", workspaceDir, { shell: "powershell", mode: "balanced" }).tier,
      "deny",
    );
    assert.equal(
      policy.evaluateShellCommand("Get-Content .env", workspaceDir, { shell: "powershell", mode: "balanced" }).rule,
      "deny.protected_file_access",
    );
    for (const command of ["Get-Content .e`nv", 'Get-Content ".e`nv"']) {
      const decision = policy.evaluateShellCommand(command, workspaceDir, { shell: "powershell", mode: "balanced" });
      assert.equal(decision.rule, "deny.protected_file_access", `${command}: ${JSON.stringify(decision)}`);
    }
  });

  check("policy_adv_dialect_powershell_colon_params", () => {
    const ps = (command: string, mode: "balanced" | "permissive") =>
      policy.evaluateShellCommand(command, workspaceDir, { shell: "powershell", mode });
    // `-Name:value` is the same parameter as `-Name value`: the operand must stay visible to hard-deny rules.
    const denied: Array<[string, string]> = [
      ["Get-Content -Path:.env", "deny.protected_file_access"],
      ["Get-Content -LiteralPath:.env", "deny.protected_file_access"],
      ["Select-String -Path:.env -Pattern x", "deny.protected_file_access"],
      ["Remove-Item -Path:.env", "deny.protected_file_access"],
      ["Remove-Item -Path:C:\\ -Recurse -Force", "deny.filesystem_root_delete"],
      ["Remove-Item -LiteralPath:C:\\ -Rec -Fo", "deny.filesystem_root_delete"],
      ["Remove-Item -Recurse -Force -Path:$HOME", "deny.filesystem_root_delete"],
      ["Remove-Item -Recurse:$true -Force:$true C:\\", "deny.filesystem_root_delete"],
    ];
    for (const [command, rule] of denied) {
      const balanced = ps(command, "balanced");
      assert.equal(balanced.rule, rule, `${command}: ${JSON.stringify(balanced)}`);
      const permissive = ps(command, "permissive");
      assert.equal(permissive.rule, `ask.${rule}`, `${command}: ${JSON.stringify(permissive)}`);
    }
    // Writes outside the workspace stay on approval in the colon spelling.
    for (const command of ["Out-File -FilePath:../x.txt", "Set-Content -Path:../x.txt -Value 1", "Copy-Item a.txt -Destination:../b.txt"]) {
      const decision = ps(command, "balanced");
      assert.equal(decision.tier, "ask", `${command}: ${JSON.stringify(decision)}`);
    }
    // External programs keep their own `-name:value` convention: only cmdlets and known aliases are split.
    assert.equal(ps("dotnet build -p:Configuration=Release", "balanced").rule, "balanced.local_dev");
  });

  check("policy_adv_dialect_cmd", () => {
    assert.equal(
      policy.evaluateShellCommand("cmd /c type .env", workspaceDir, { shell: "cmd", mode: "balanced" }).rule,
      "deny.protected_file_access",
    );
    assert.equal(
      policy.evaluateShellCommand("cmd /c del /f /s /q .", workspaceDir, { shell: "cmd", mode: "balanced" }).rule,
      "ask.destructive_delete",
    );
    assert.equal(
      policy.evaluateShellCommand("cmd /c git push origin main", workspaceDir, { shell: "cmd", mode: "balanced" }).rule,
      "ask.git_history_rewrite",
    );
    assert.equal(
      policy.evaluateShellCommand("cmd /c npm publish", workspaceDir, { shell: "cmd", mode: "balanced" }).rule,
      "ask.package_mutation",
    );
    assert.equal(
      policy.evaluateShellCommand("cmd /c powershell -enc dABpc19fXw==", workspaceDir, { shell: "cmd", mode: "balanced" }).rule,
      "deny.powershell_encoded_command",
    );
    assert.equal(
      policy.evaluateShellCommand("cmd /c C:\\batch\\destroy.bat", workspaceDir, { shell: "cmd", mode: "balanced" }).rule,
      "ask.dynamic_execution",
    );
  });

  check("policy_adv_dialect_cmd_glued_switches", () => {
    const cmd = (command: string, mode: "balanced" | "permissive") =>
      policy.evaluateShellCommand(command, workspaceDir, { shell: "cmd", mode });
    // cmd accepts `rd/s/q` and `del/f/s/q`: the parser normalizes them before the rules run.
    const denied: Array<[string, string]> = [
      ["rd/s/q C:\\Windows", "deny.windows_mass_delete"],
      ["rd /s/q C:\\Windows", "deny.windows_mass_delete"],
      ["rmdir/s/q C:\\Users", "deny.windows_mass_delete"],
      ["cmd /c rd/s/q C:\\Users", "deny.windows_mass_delete"],
      ["cmd/c rd/s/q C:\\", "deny.windows_mass_delete"],
    ];
    for (const [command, rule] of denied) {
      const balanced = cmd(command, "balanced");
      assert.equal(balanced.rule, rule, `${command}: ${JSON.stringify(balanced)}`);
      const permissive = cmd(command, "permissive");
      assert.equal(permissive.rule, `ask.${rule}`, `${command}: ${JSON.stringify(permissive)}`);
    }
    // Workspace-scoped cluster spellings keep asking instead of becoming hard denies.
    for (const command of ["rd /s/q ./dist", "del/f/q ./probe-missing.txt"]) {
      const decision = cmd(command, "balanced");
      assert.equal(decision.tier, "ask", `${command}: ${JSON.stringify(decision)}`);
    }
  });

  check("policy_adv_dialect_cmd_glued_write_switches", () => {
    const cmd = (command: string, mode: "balanced" | "permissive") =>
      policy.evaluateShellCommand(command, workspaceDir, { shell: "cmd", mode });
    // `move/y`, `xcopy/e/h`, `mklink/j` are valid cmd spellings for `move /y`, `xcopy /e /h`, `mklink /j`.
    const outside: string[] = [
      "move/y a.txt C:\\Windows\\a.txt",
      "copy/y a.txt C:\\Windows\\a.txt",
      "xcopy/e/h C:\\ws C:\\Windows\\Backup",
      "robocopy/e C:\\ws C:\\Windows\\Backup",
      "mklink/j link C:\\Windows",
      "cmd /c xcopy/e/h C:\\ws C:\\Windows\\Backup",
    ];
    for (const command of outside) {
      const decision = cmd(command, "balanced");
      assert.equal(decision.rule, "ask.writes_outside_workspace", `${command}: ${JSON.stringify(decision)}`);
    }
    // In-workspace spellings must not be mistaken for outside writes.
    for (const command of ["move/y a.txt b.txt", "copy/y a.txt b.txt"]) {
      const decision = cmd(command, "balanced");
      assert.notEqual(decision.rule, "ask.writes_outside_workspace", `${command}: ${JSON.stringify(decision)}`);
    }
  });

  check("policy_adv_dialect_powershell_parameter_abbreviations", () => {
    const ps = (command: string, mode: "balanced" | "permissive") =>
      policy.evaluateShellCommand(command, workspaceDir, { shell: "powershell", mode });
    const denied: Array<[string, string]> = [
      ["Remove-Item -Rec -Fo C:\\", "deny.filesystem_root_delete"],
      ["Remove-Item -Pa:C:\\ -Rec -Fo", "deny.filesystem_root_delete"],
      ["ri -rec -fo $HOME", "deny.filesystem_root_delete"],
      ["rm -r -fo C:\\", "deny.root_delete"],
    ];
    for (const [command, rule] of denied) {
      const balanced = ps(command, "balanced");
      assert.equal(balanced.rule, rule, `${command}: ${JSON.stringify(balanced)}`);
      const permissive = ps(command, "permissive");
      assert.equal(permissive.rule, `ask.${rule}`, `${command}: ${JSON.stringify(permissive)}`);
    }
    // `-Rec`/`-Fo` are the same parameters as `-Recurse`/`-Force`, so the destructive-delete rule sees them.
    assert.equal(ps("Remove-Item -Rec -Fo ./dist", "balanced").rule, "ask.destructive_delete");
    // Ambiguous prefixes are rejected by PowerShell itself and stay unclassified (approval required).
    assert.equal(ps("Remove-Item -F ./probe-missing.txt", "balanced").tier, "ask");
  });

  check("policy_adv_snapshot_store_is_protected", () => {
    const store = path.join(tempDir, "snapstore");
    const previous = process.env.VENIRA_SNAPSHOT_DIR;
    process.env.VENIRA_SNAPSHOT_DIR = store;
    const posixStore = store.replace(/\\/g, "/");
    try {
      const cases: Array<[string, string]> = [
        ["bash", `rm -rf ${posixStore}/proj`],
        ["bash", `cat ${posixStore}/project.json`],
        ["bash", `echo x > ${posixStore}/index.json`],
        ["bash", "rm -rf ../snapstore/proj"],
        ["powershell", `Remove-Item -Recurse -Force ${store}`],
        ["powershell", `Get-Content ${store}\\project.json`],
        ["powershell", `Set-Content ${store}\\index.json x`],
        ["cmd", `type ${store}\\project.json`],
        ["cmd", `del /f /q ${store}\\project.json`],
      ];
      for (const [shell, command] of cases) {
        const balanced = policy.evaluateShellCommand(command, workspaceDir, { shell, mode: "balanced" });
        assert.equal(balanced.rule, "deny.protected_file_access", `${command}: ${JSON.stringify(balanced)}`);
        const permissive = policy.evaluateShellCommand(command, workspaceDir, { shell, mode: "permissive" });
        assert.equal(permissive.rule, "ask.deny.protected_file_access", `${command}: ${JSON.stringify(permissive)}`);
      }
      // Workspace paths keep their old verdicts: the store check must not become a broad deny.
      assert.equal(policy.evaluateShellCommand("cat README.md", workspaceDir, { shell: "bash", mode: "balanced" }).tier, "allow");
      assert.equal(policy.evaluateShellCommand("rm -rf ./dist", workspaceDir, { shell: "bash", mode: "balanced" }).rule, "ask.destructive_delete");
    } finally {
      if (previous === undefined) delete process.env.VENIRA_SNAPSHOT_DIR;
      else process.env.VENIRA_SNAPSHOT_DIR = previous;
    }
  });

  check("policy_adv_dialect_protected_across_shells", () => {
    for (const shell of ["bash", "powershell", "cmd"]) {
      const decision = policy.evaluateShellCommand("cat .e[n]v", workspaceDir, { shell, mode: "balanced" });
      assert.equal(decision.tier, "deny", `${shell}: ${JSON.stringify(decision)}`);
      assert.equal(decision.rule, "deny.protected_file_access");
    }
  });

  // Just-written executables: writing a script and running it later (or in the
  // same line) must still require approval — the run itself is classified as
  // dynamic execution / unclassified, never silently allowed in balanced.
  check("policy_adv_just_written_executable_asks", () => {
    const justWritten: Array<{ command: string; shell: string; rule?: string }> = [
      { command: "bash ./probe.sh", shell: "bash", rule: "ask.dynamic_execution" },
      { command: "pwsh -File ./probe.ps1", shell: "pwsh", rule: "ask.dynamic_execution" },
      { command: "node ./probe.js", shell: "node", rule: "ask.dynamic_execution" },
      { command: "cmd /c C:\\batch\\destroy.bat", shell: "cmd", rule: "ask.dynamic_execution" },
      { command: "tsx ./probe.ts", shell: "tsx", rule: "ask.dynamic_execution" },
      { command: "python3 ./probe.py", shell: "python3", rule: "ask.dynamic_execution" },
      { command: "perl ./probe.pl", shell: "perl", rule: "ask.dynamic_execution" },
    ];
    for (const { command, shell, rule } of justWritten) {
      const decision = policy.evaluateShellCommand(command, workspaceDir, { shell, mode: "balanced" });
      assert.equal(decision.tier, "ask", `${command}: ${JSON.stringify(decision)}`);
      if (rule) assert.equal(decision.rule, rule, command);
    }
  });

  // Dev tools on the routine path: write flags and config/output paths that leave the
  // workspace (or are not provably plain paths) must ask in balanced; ordinary runs stay allowed.
  // Each case runs under an explicit dialect (never the host default), so the result is the same on
  // Linux, macOS and Windows runners. `shells` narrows a case whose spelling only means something in
  // one family: `..\x` is a parent escape for cmd/PowerShell, but bash reads `\x` as an escape.
  const DEV_TOOL_SHELLS = ["bash", "powershell"];
  const DEV_TOOL_ASK_CASES: Array<{ id: string; command: string; shells?: string[] }> = [
    { id: "eslint_fix", command: "eslint --fix src" },
    { id: "eslint_fix_type", command: "eslint --fix-type problem ." },
    { id: "eslint_config_absolute", command: "eslint -c /tmp/evil.js ." },
    { id: "eslint_output_file_escape", command: "eslint --output-file ../out.txt ." },
    { id: "eslint_short_flag_glued", command: "eslint -c../evil.js ." },
    { id: "npx_eslint_fix", command: "npx --no-install eslint --fix ." },
    { id: "prettier_write", command: "prettier --write ." },
    { id: "prettier_write_short", command: "prettier -w src" },
    { id: "prettier_write_cluster", command: "prettier -lw src" },
    { id: "prettier_write_equals", command: "prettier --write=true src" },
    { id: "prettier_config_home", command: "prettier --config ~/.prettierrc ." },
    { id: "jest_config_absolute", command: "jest --config /etc/evil.config.js" },
    { id: "jest_config_dotdot_equals", command: "jest --config=../other/jest.config.js" },
    { id: "jest_config_short_windows", command: "jest -c ..\\evil.js", shells: ["powershell", "cmd"] },
    { id: "jest_config_inline_json", command: `jest --config '{"setupFiles":["/tmp/x.js"]}'` },
    { id: "jest_config_missing_value", command: "jest --config" },
    { id: "jest_rootdir_escape", command: "jest --rootDir ../sibling" },
    { id: "vitest_config_dotdot", command: "vitest --config ../x.ts" },
    { id: "vitest_root_absolute", command: "vitest --root /tmp/other" },
  ];
  for (const { id, command, shells } of DEV_TOOL_ASK_CASES) {
    check(`policy_adv_dev_tool_${id}_asks`, () => {
      for (const shell of shells ?? DEV_TOOL_SHELLS) {
        const decision = policy.evaluateShellCommand(command, workspaceDir, { shell, mode: "balanced" });
        assert.equal(decision.tier, "ask", `${shell}: ${command}: ${JSON.stringify(decision)}`);
      }
    });
  }
  check("policy_adv_dev_tool_plain_runs_stay_allowed", () => {
    for (const command of [
      "eslint .",
      "eslint src --max-warnings 0",
      "eslint -c eslint.config.js src",
      "prettier --check .",
      "prettier src/index.ts",
      "jest",
      "jest --config jest.config.js",
      "jest --config=config/jest.config.js",
      "jest -c jest.config.js",
      "vitest run",
      "vitest --config vitest.config.ts",
    ]) {
      for (const shell of DEV_TOOL_SHELLS) {
        const decision = policy.evaluateShellCommand(command, workspaceDir, { shell, mode: "balanced" });
        assert.equal(decision.tier, "allow", `${shell}: ${command}: ${JSON.stringify(decision)}`);
      }
    }
  });

  console.log(`\nShell policy adversarial tests passed (${checks} checks).`);
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
