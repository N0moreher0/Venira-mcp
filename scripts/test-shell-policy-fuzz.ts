/**
 * Shell policy property-based fuzzing (roadmap P2 #7).
 *
 * Deterministic, seed-driven: a fixed corpus of canonical commands is re-spelled with the
 * variations real shells accept (case, quoting, whitespace, cmd command/switch glue, PowerShell
 * `-Name:value` and parameter prefixes, path spellings, interpreter shims). Every variant must keep
 * the verdict of its seed:
 *
 *   deny  -> balanced `deny`, permissive `ask.deny.*`
 *   ask   -> balanced `ask` (never allowed)
 *   safe  -> balanced not `deny` (false-positive guard)
 *
 * The generator is a small deterministic PRNG over a fixed seed list, so failures reproduce
 * exactly and every discovered spelling can be copied into the adversarial table as a stable case.
 *
 * Run with: npm run test:shell-policy-fuzz
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDir = await mkdtemp(path.join(os.tmpdir(), "venira-shell-fuzz-"));
const workspaceDir = path.join(tempDir, "workspace");
const dataDir = path.join(tempDir, "data");
await mkdir(workspaceDir);
await mkdir(dataDir);
process.env.VENIRA_WORKSPACE = workspaceDir;
process.env.VENIRA_DATA_DIR = dataDir;
delete process.env.VENIRA_SHELL_MODE;
delete process.env.VENIRA_SHELL_POLICY_FILE;
delete process.env.VENIRA_SHELL_OVERRIDES;
process.env.VENIRA_SECURITY_PROFILE = "balanced";

const policy = (await import(
  pathToFileURL(path.join(repoRoot, "lib", "shell-policy.ts")).href
)) as typeof import("../lib/shell-policy.js");

type Shell = "posix" | "powershell" | "cmd";
type Kind = "deny" | "ask" | "safe";
type Seed = { id: string; shell: Shell; kind: Kind; command: string };

const SEEDS: Seed[] = [
  // hard deny — root / home deletion
  { id: "root_slash", shell: "posix", kind: "deny", command: "rm -rf /" },
  { id: "root_double_slash", shell: "posix", kind: "deny", command: "rm -rf //" },
  { id: "home_tilde", shell: "posix", kind: "deny", command: "rm -rf ~" },
  { id: "home_dollar", shell: "posix", kind: "deny", command: "rm -rf $HOME" },
  // hard deny — privilege escalation
  { id: "sudo", shell: "posix", kind: "deny", command: "sudo id" },
  // hard deny — protected files
  { id: "env_posix", shell: "posix", kind: "deny", command: "cat .env" },
  { id: "env_powershell", shell: "powershell", kind: "deny", command: "Get-Content -Path .env" },
  { id: "env_powershell_prefix", shell: "powershell", kind: "deny", command: "Get-Content -LiteralPath .env" },
  { id: "env_cmd", shell: "cmd", kind: "deny", command: "type .env" },
  { id: "env_robocopy_log", shell: "cmd", kind: "deny", command: "robocopy src dst /log .env" },
  { id: "env_xcopy_exclude", shell: "cmd", kind: "deny", command: "xcopy a b /exclude .env" },
  // hard deny — Windows drive/home deletion
  { id: "drive_root_powershell", shell: "powershell", kind: "deny", command: "Remove-Item -Recurse -Force C:\\" },
  { id: "home_powershell", shell: "powershell", kind: "deny", command: "Remove-Item -Recurse -Force $HOME" },
  { id: "users_tree_powershell", shell: "powershell", kind: "deny", command: "Remove-Item -Recurse -Force C:\\Users" },
  { id: "users_tree_wildcard", shell: "powershell", kind: "deny", command: "Remove-Item -Recurse -Force C:\\Users\\*" },
  { id: "drive_tree_rd", shell: "cmd", kind: "deny", command: "rd /s /q C:\\Windows" },
  { id: "drive_wildcard_del", shell: "cmd", kind: "deny", command: "del /f /s /q C:\\*" },
  // ask — destructive but workspace-scoped
  { id: "recursive_rm", shell: "posix", kind: "ask", command: "rm -rf ./probe-dir" },
  { id: "recursive_powershell", shell: "powershell", kind: "ask", command: "Remove-Item -Recurse -Force ./probe-dir" },
  { id: "recursive_rd", shell: "cmd", kind: "ask", command: "rd /s /q ./probe-dir" },
  { id: "forced_del", shell: "cmd", kind: "ask", command: "del /f /q ./probe-file.txt" },
  // ask — git/provider and package/network actions that leave the workspace or run fetched code
  { id: "git_push", shell: "posix", kind: "ask", command: "git push origin main" },
  { id: "git_reset_hard", shell: "posix", kind: "ask", command: "git reset --hard HEAD~1" },
  { id: "git_clean", shell: "posix", kind: "ask", command: "git clean -fdx" },
  { id: "npm_publish", shell: "posix", kind: "ask", command: "npm publish" },
  { id: "curl", shell: "posix", kind: "ask", command: "curl https://example.com" },
  { id: "find_delete", shell: "posix", kind: "ask", command: "find . -delete" },
  { id: "docker_run", shell: "posix", kind: "ask", command: "docker run alpine" },
  { id: "network_powershell", shell: "powershell", kind: "ask", command: "Invoke-WebRequest https://example.com" },
  // ask — write tiers that must stay gated (build/config files, outside the workspace)
  { id: "chmod_file", shell: "posix", kind: "ask", command: "chmod 777 file.txt" },
  { id: "write_manifest", shell: "posix", kind: "ask", command: "echo hi > package.json" },
  { id: "write_manifest_powershell", shell: "powershell", kind: "ask", command: "Set-Content -Path package.json -Value x" },
  { id: "write_manifest_powershell_prefix", shell: "powershell", kind: "ask", command: "Set-Content -LiteralPath package.json -Value x" },
  { id: "copy_outside", shell: "cmd", kind: "ask", command: "copy a.txt ..\\outside.txt" },
  { id: "robocopy_log_outside", shell: "cmd", kind: "ask", command: "robocopy src dst /log ../outside.log" },
  // safe — the fuzzer must never turn these into denies
  { id: "git_status", shell: "posix", kind: "safe", command: "git status" },
  { id: "read_readme", shell: "posix", kind: "safe", command: "cat README.md" },
  { id: "typecheck", shell: "posix", kind: "safe", command: "tsc --noEmit" },
  { id: "git_status_cmd", shell: "cmd", kind: "safe", command: "git status" },
  { id: "read_readme_powershell", shell: "powershell", kind: "safe", command: "Get-Content README.md" },
  { id: "dir_cmd", shell: "cmd", kind: "safe", command: "dir" },
  { id: "list_powershell", shell: "powershell", kind: "safe", command: "Get-ChildItem" },
];

/** Commands whose `/switch` glue is accepted by cmd (see lib/shell-parser.ts). */
const CMD_GLUE_COMMANDS = new Set(["del", "erase", "rd", "rmdir", "move", "copy", "xcopy", "robocopy", "mklink", "attrib"]);

/** Unambiguous PowerShell delete-parameter prefixes used by the policy layer. */
const PS_PREFIXES: Record<string, string> = {
  recurse: "Rec",
  force: "Fo",
  path: "Pa",
  literalpath: "Lit",
  destination: "Des",
};

type Transform = {
  id: string;
  applies: (tokens: string[], shell: Shell) => boolean;
  apply: (tokens: string[], shell: Shell) => string[];
};

const isFlag = (token: string): boolean => token.startsWith("-") || (token.length > 1 && token.startsWith("/"));
const hasExpansion = (token: string): boolean => /[$%`]/.test(token);

function quoteToken(token: string): string {
  return `"${token}"`;
}

const TRANSFORMS: Transform[] = [
  {
    id: "upper-command",
    applies: () => true,
    apply: (tokens) => [tokens[0].toUpperCase(), ...tokens.slice(1)],
  },
  {
    id: "upper-flags",
    applies: (tokens) => tokens.slice(1).some((token) => isFlag(token) && !hasExpansion(token)),
    apply: (tokens) =>
      tokens.map((token, index) => (index > 0 && isFlag(token) && !hasExpansion(token) ? token.toUpperCase() : token)),
  },
  {
    id: "quote-command",
    applies: (tokens) => !hasExpansion(tokens[0]),
    apply: (tokens) => [quoteToken(tokens[0]), ...tokens.slice(1)],
  },
  {
    id: "quote-operands",
    applies: (tokens) => tokens.slice(1).some((token) => !isFlag(token) && /^[A-Za-z0-9_.:\\/-]+$/.test(token)),
    apply: (tokens) =>
      tokens.map((token, index) =>
        index > 0 && !isFlag(token) && !hasExpansion(token) && /^[A-Za-z0-9_.:\\/-]+$/.test(token) ? quoteToken(token) : token,
      ),
  },
  {
    id: "double-space",
    applies: (tokens) => tokens.length > 1,
    apply: (tokens) => tokens.map((token, index) => (index === 0 ? token : `  ${token}`)),
  },
  {
    id: "tab-separator",
    applies: (tokens) => tokens.length > 1,
    apply: (tokens) => tokens.map((token, index) => (index === 0 ? token : `\t${token}`)),
  },
  {
    id: "backslash-command",
    applies: (tokens, shell) => shell === "posix" && !hasExpansion(tokens[0]) && !/^["']/.test(tokens[0]),
    apply: (tokens) => [`\\${tokens[0]}`, ...tokens.slice(1)],
  },
  {
    id: "double-backslash-command",
    applies: (tokens, shell) => shell === "posix" && !hasExpansion(tokens[0]) && tokens[0].length > 1 && !/^["']/.test(tokens[0]),
    apply: (tokens) => [`${tokens[0].slice(0, 1)}\\${tokens[0].slice(1)}`, ...tokens.slice(1)],
  },
  {
    id: "cmd-switch-glue",
    applies: (tokens, shell) => shell === "cmd" && tokens.length > 1 && CMD_GLUE_COMMANDS.has(tokens[0].toLowerCase()) && tokens[1].startsWith("/"),
    apply: (tokens) => {
      const glue = [tokens[0] + tokens[1], ...tokens.slice(2)];
      // Also glue every following switch onto the first one (`rd /s /q` -> `rd/s/q`).
      while (glue.length > 1 && glue[1].startsWith("/")) glue.splice(0, 2, glue[0] + glue[1]);
      return glue;
    },
  },
  {
    id: "cmd-cluster-switches",
    applies: (tokens, shell) => {
      if (shell !== "cmd" || tokens.length < 3) return false;
      if (!["del", "erase", "rd", "rmdir"].includes(tokens[0].toLowerCase())) return false;
      let count = 0;
      for (let i = 1; i < tokens.length && /^\/(?:f|s|q|p)$/i.test(tokens[i]); i += 1) count += 1;
      return count >= 2;
    },
    apply: (tokens) => {
      let i = 1;
      const flags: string[] = [];
      while (i < tokens.length && /^\/(?:f|s|q|p)$/i.test(tokens[i])) {
        flags.push(tokens[i]);
        i += 1;
      }
      return [tokens[0], flags.join(""), ...tokens.slice(i)];
    },
  },
  {
    id: "cmd-attached-value",
    applies: (tokens, shell) => {
      if (shell !== "cmd") return false;
      const command = tokens[0].toLowerCase();
      if (!["robocopy", "xcopy", "attrib"].includes(command)) return false;
      return tokens.some((token, index) => {
        const next = tokens[index + 1];
        return ["/log", "/exclude", "/a"].includes(token.toLowerCase()) && next !== undefined && !next.startsWith("/");
      });
    },
    apply: (tokens) => {
      const out: string[] = [];
      for (let i = 0; i < tokens.length; i += 1) {
        const next = tokens[i + 1];
        if (
          ["/log", "/exclude", "/a"].includes(tokens[i].toLowerCase()) &&
          next !== undefined &&
          !next.startsWith("/")
        ) {
          out.push(`${tokens[i]}:${next}`);
          i += 1;
        } else {
          out.push(tokens[i]);
        }
      }
      return out;
    },
  },
  {
    id: "cmd-shell-shim",
    applies: (_tokens, shell) => shell === "cmd",
    apply: (tokens) => ["cmd", "/c", ...tokens],
  },
  {
    id: "cmd-shell-shim-glued",
    applies: (_tokens, shell) => shell === "cmd",
    apply: (tokens) => ["cmd/c", ...tokens],
  },
  {
    id: "powershell-colon",
    applies: (tokens, shell) => {
      if (shell !== "powershell") return false;
      return tokens.some((token, index) => index > 0 && /^-[A-Za-z][A-Za-z0-9]*$/.test(token) && index + 1 < tokens.length && !tokens[index + 1].startsWith("-"));
    },
    apply: (tokens) => {
      const out: string[] = [tokens[0]];
      for (let i = 1; i < tokens.length; i += 1) {
        const next = tokens[i + 1];
        if (/^-[A-Za-z][A-Za-z0-9]*$/.test(tokens[i]) && next !== undefined && !next.startsWith("-")) {
          out.push(`${tokens[i]}:${next}`);
          i += 1;
          continue;
        }
        out.push(tokens[i]);
      }
      return out;
    },
  },
  {
    id: "powershell-prefix",
    applies: (tokens, shell) => {
      if (shell !== "powershell") return false;
      return tokens.some((token) => {
        const name = /^-([A-Za-z][A-Za-z0-9]*)(?::|$)/.exec(token);
        return name !== null && PS_PREFIXES[name[1].toLowerCase()] !== undefined;
      });
    },
    apply: (tokens) =>
      tokens.map((token) => {
        const match = /^-([A-Za-z][A-Za-z0-9]*)(:?.*)$/.exec(token);
        if (!match) return token;
        const prefix = PS_PREFIXES[match[1].toLowerCase()];
        return prefix === undefined ? token : `-${prefix}${match[2]}`;
      }),
  },
  {
    id: "path-spelling",
    applies: (tokens) => tokens.some((token) => ["/", "//", "~", "$HOME", "C:\\", "C:\\*"].includes(token)),
    apply: (tokens) =>
      tokens.map((token) => {
        switch (token) {
          case "/":
            return "/./";
          case "//":
            return "///";
          case "~":
            return "~/";
          case "$HOME":
            return "${HOME}";
          case "C:\\":
            return "C:\\*";
          default:
            return token;
        }
      }),
  },
  {
    id: "operand-dot-slash",
    applies: (tokens) => tokens.slice(1).some((token) => !isFlag(token) && /^[A-Za-z0-9_.-]+$/.test(token)),
    apply: (tokens) =>
      tokens.map((token, index) =>
        index > 0 && !isFlag(token) && /^[A-Za-z0-9_.-]+$/.test(token) ? `./${token}` : token,
      ),
  },
];

function splitSeed(command: string): string[] {
  return command.split(/\s+/).filter(Boolean);
}

function joinTokens(tokens: string[]): string {
  let out = "";
  for (const token of tokens) {
    if (out !== "" && !token.startsWith("\t") && !token.startsWith("  ")) out += " ";
    out += token;
  }
  return out;
}

function applyTransforms(seed: Seed, transformIds: string[]): string | null {
  let tokens = splitSeed(seed.command);
  for (const id of transformIds) {
    const transform = TRANSFORMS.find((candidate) => candidate.id === id);
    if (!transform || !transform.applies(tokens, seed.shell)) return null;
    tokens = transform.apply(tokens, seed.shell);
  }
  return joinTokens(tokens);
}

/** `evaluateShellCommand` resolves shell names, not dialect ids; `posix` is spelled `bash` there. */
const shellName = (shell: Shell): string => (shell === "posix" ? "bash" : shell);

/** Deterministic variant list: same input always produces the same cases, so a failure is reproducible. */
const variants: Array<{ seed: Seed; transforms: string[]; command: string }> = [];
for (const seed of SEEDS) {
  for (const transform of TRANSFORMS) {
    const command = applyTransforms(seed, [transform.id]);
    if (command !== null) variants.push({ seed, transforms: [transform.id], command });
  }
}
// Every pair of transforms, applied in both orders, catches interactions (e.g. glued switches + case,
// colon form + prefix, shell shim + path spelling).
for (const seed of SEEDS) {
  for (let i = 0; i < TRANSFORMS.length; i += 1) {
    for (let j = 0; j < TRANSFORMS.length; j += 1) {
      if (i === j) continue;
      const command = applyTransforms(seed, [TRANSFORMS[i].id, TRANSFORMS[j].id]);
      if (command !== null) variants.push({ seed, transforms: [TRANSFORMS[i].id, TRANSFORMS[j].id], command });
    }
  }
}
// Consecutive triples catch chained interactions that only surface when two transforms compound
// (e.g. glued switch + attached value + quoted operand).
for (const seed of SEEDS) {
  for (let i = 0; i < TRANSFORMS.length - 1; i += 1) {
    for (let j = i + 1; j < TRANSFORMS.length - 1; j += 1) {
      const command = applyTransforms(seed, [TRANSFORMS[i].id, TRANSFORMS[j].id, TRANSFORMS[j + 1].id]);
      if (command !== null) variants.push({ seed, transforms: [TRANSFORMS[i].id, TRANSFORMS[j].id, TRANSFORMS[j + 1].id], command });
    }
  }
}

type Failure = { seed: Seed; transforms: string[]; command: string; decision: { tier: string; rule: string } };
const failures: Failure[] = [];
let checked = 0;

for (const { seed, transforms, command } of variants) {
  checked += 1;
  const balanced = policy.evaluateShellCommand(command, workspaceDir, { shell: shellName(seed.shell), mode: "balanced" });
  const permissive = policy.evaluateShellCommand(command, workspaceDir, { shell: shellName(seed.shell), mode: "permissive" });
  if (seed.kind === "deny") {
    if (balanced.tier !== "deny") failures.push({ seed, transforms, command, decision: balanced });
    else if (permissive.tier !== "ask" || !permissive.rule.startsWith("ask.deny.")) {
      failures.push({ seed, transforms, command, decision: permissive });
    }
  } else if (seed.kind === "ask") {
    if (balanced.tier !== "ask") failures.push({ seed, transforms, command, decision: balanced });
  } else if (balanced.tier === "deny" || permissive.tier === "deny") {
    failures.push({ seed, transforms, command, decision: balanced.tier === "deny" ? balanced : permissive });
  }
}

if (failures.length > 0) {
  for (const failure of failures.slice(0, 20)) {
    console.error(
      `fuzz mismatch: seed=${failure.seed.id} kind=${failure.seed.kind} transforms=[${failure.transforms.join(", ")}] ` +
        `command=${JSON.stringify(failure.command)} got=${failure.decision.tier}/${failure.decision.rule}`,
    );
  }
  assert.equal(failures.length, 0, `${failures.length}/${checked} fuzz variants changed verdict`);
}

console.log(`Shell policy fuzz passed (${checked} variants from ${SEEDS.length} seeds).`);
