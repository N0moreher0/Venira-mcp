/**
 * How a shell command is handed to the OS (roadmap item 15, P0: "silently
 * wrong results in project_shell_run").
 *
 * Three problems are fixed here:
 *
 *   1. `cmd.exe` does not understand Node's argument escaping. A command with
 *      double quotes arrived as `\"a b\"`, and `node -e "console.log('x')"`
 *      printed nothing while the run reported exit code 0 - the agent saw a
 *      success that never happened. The command is now passed verbatim.
 *   2. PowerShell reports the exit code of the *script*, not of the last
 *      native command: every failing native command collapsed to exit code 1,
 *      so the agent could not tell a failing test run from a crash. The
 *      command is now wrapped so the native exit code survives while a
 *      failing cmdlet still reports 1.
 *   3. `bash` on Windows may be the WSL launcher (`C:\Windows\System32\
 *      bash.exe`), whose messages are UTF-16LE and arrived as
 *      `w\u0000s\u0000l\u0000...`. The resolved binary is now reported
 *      (`shell_path`, `shell_kind`) and UTF-16 output is decoded.
 *
 * The policy always sees the user's command: the PowerShell wrapper is added
 * at spawn time only, so the verdict, the audit row and the approval binding
 * stay exactly the ones the user asked about.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { PLATFORM } from "./workspace.js";

export type ShellKind = "native" | "wsl" | "git-bash" | "unknown";

export type ShellInvocation = {
  file: string;
  args: string[];
  /** Pass the arguments to the OS without Node's quoting/escaping. */
  verbatim?: boolean;
};

/**
 * The exit code the shell should report.
 *
 * `$LASTEXITCODE` is only meaningful after a native command, so it is reset
 * before the user's command runs. Afterwards a non-null `$LASTEXITCODE` means
 * the last native command failed with that code; a null one means the last
 * statement was a cmdlet, and `$?` decides between 0 and 1.
 *
 * The wrapper sits on its own line: a command that ends with a `#` comment
 * would otherwise swallow the whole wrapper and silently fall back to the old
 * behaviour.
 *
 * Known limit: a script that runs a failing native command and then a cmdlet
 * keeps the native exit code (`git status; Write-Host done` reports the exit
 * code of git). Distinguishing the two needs a statement-level model, which
 * the shell policy does not have.
 */
const POWERSHELL_EXIT_WRAPPER =
  "$global:LASTEXITCODE = $null; {command}\n" +
  "$ok = $?; $ec = $LASTEXITCODE; " +
  "if ($null -ne $ec) { exit $ec }; if ($ok) { exit 0 }; exit 1";

export function powershellCommand(command: string): string {
  return POWERSHELL_EXIT_WRAPPER.replace("{command}", command);
}

export function defaultShellForPlatform(): string {
  // cmd.exe starts ~99% faster than PowerShell on Windows (8ms vs 2300ms).
  if (PLATFORM === "win32") return "cmd";
  if (process.env.SHELL && process.env.SHELL !== "") {
    const base = process.env.SHELL.split("/").pop();
    if (base) return base;
  }
  return "bash";
}

/** The binary and the argument vector for one shell. */
export function buildShellInvocation(shell: string, command: string): ShellInvocation {
  switch (shell) {
    case "powershell":
      return {
        file: "powershell.exe",
        args: ["-NoProfile", "-NonInteractive", "-Command", powershellCommand(command)],
      };
    case "pwsh":
      // PowerShell 7+ (cross-platform): supports `&&` / `||` pipeline chains,
      // unlike Windows PowerShell 5.1.
      return {
        file: "pwsh",
        args: ["-NoProfile", "-NonInteractive", "-Command", powershellCommand(command)],
      };
    case "cmd":
      // `/d` skips AutoRun commands, `/s` strips the surrounding quotes of
      // the command string, and `verbatim` keeps Node from escaping the
      // double quotes inside the command (cmd does not understand `\"`).
      return { file: "cmd.exe", args: ["/d", "/s", "/c", command], verbatim: true };
    case "bash":
      return { file: "bash", args: ["-c", command] };
    case "sh":
      return { file: "sh", args: ["-c", command] };
    case "zsh":
      return { file: "zsh", args: ["-c", command] };
    case "fish":
      return { file: "fish", args: ["-c", command] };
    default:
      return buildShellInvocation(defaultShellForPlatform(), command);
  }
}

const WINDOWS_BINARY_NAMES: Record<string, string> = {
  cmd: "cmd.exe",
  powershell: "powershell.exe",
  pwsh: "pwsh.exe",
  bash: "bash.exe",
  sh: "sh.exe",
  zsh: "zsh.exe",
  fish: "fish.exe",
};

function pathEntries(raw: string, platform: NodeJS.Platform): string[] {
  const separator = platform === "win32" ? ";" : ":";
  return raw
    .split(separator)
    .map((entry) => entry.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
}

/** Pure resolver: given PATH entries and an existence check, pick the binary and its kind. */
function resolveOnWindows(
  binary: string,
  entries: string[],
  exists: (candidate: string) => boolean,
): { path: string | null; kind: ShellKind } {
  const pathImpl = path.win32;
  for (const entry of entries) {
    const candidate = pathImpl.join(entry, binary);
    if (!exists(candidate)) continue;
    const lower = candidate.toLowerCase();
    if (binary === "bash.exe") {
      if (lower.includes("\\system32\\")) return { path: candidate, kind: "wsl" };
      if (lower.includes("\\git\\")) return { path: candidate, kind: "git-bash" };
      return { path: candidate, kind: "unknown" };
    }
    return { path: candidate, kind: "native" };
  }
  return { path: null, kind: "unknown" };
}

/**
 * The binary the OS would run for this shell, and what kind of shell it is.
 *
 * On Windows `bash` is ambiguous: `C:\Windows\System32\bash.exe` is the WSL
 * launcher (it runs the command inside a Linux distro, in a different
 * filesystem view), while `C:\Program Files\Git\bin\bash.exe` is Git Bash.
 * The agent needs to know which one answered.
 */
export function resolveShellBinary(
  shell: string,
  platform: NodeJS.Platform = PLATFORM,
  pathEnv?: string,
  exists: (candidate: string) => boolean = existsSync,
): { path: string | null; kind: ShellKind } {
  if (platform !== "win32") return { path: null, kind: "native" };
  const binary = WINDOWS_BINARY_NAMES[shell];
  if (!binary) return { path: null, kind: "unknown" };
  const entries = pathEntries(pathEnv ?? process.env.PATH ?? "", platform);
  return resolveOnWindows(binary, entries, exists);
}

/**
 * Remove the ANSI escape sequences a shell writes around its error messages.
 *
 * PowerShell colours its errors (`\u001b[31;1mGet-Content: ...\u001b[0m`); the
 * agent reads that as noise around the real message.
 */
export function stripAnsi(text: string): string {
  if (!text.includes("\u001b")) return text;
  // CSI sequences (colour, cursor moves) and OSC sequences (window titles).
  return text.replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "").replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

/**
 * Decode a shell stream that came back as UTF-16LE (the WSL launcher's error
 * messages) and strip the NUL bytes of a partially decoded stream.
 *
 * The heuristic: in UTF-16LE ASCII text every second byte is 0x00. A stream
 * that is not UTF-16 only loses its NUL bytes.
 */
export function decodeShellOutput(text: string): { text: string; decoded: boolean } {
  if (!text.includes("\u0000")) return { text, decoded: false };
  // A UTF-16LE byte stream always has an even length; an odd one is a
  // partially decoded stream with stray NUL bytes.
  if (text.length % 2 !== 0) return { text: text.replace(/\u0000/g, ""), decoded: false };
  const sample = text.slice(0, 512);
  let oddZeros = 0;
  let pairs = 0;
  for (let i = 1; i < sample.length; i += 2) {
    pairs += 1;
    if (sample[i] === "\u0000") oddZeros += 1;
  }
  if (pairs > 0 && oddZeros / pairs > 0.8) {
    // The stream was decoded as UTF-8, so every byte became one character:
    // go back to the bytes with latin1 and read them as UTF-16LE.
    return { text: Buffer.from(text, "latin1").toString("utf16le"), decoded: true };
  }
  return { text: text.replace(/\u0000/g, ""), decoded: false };
}

/**
 * The hint for a shell that exists but cannot run the command: the WSL
 * launcher without an installed distribution is the common case.
 */
export function shellRuntimeHint(shell: string, kind: ShellKind, output: string): string | undefined {
  if (kind !== "wsl") return undefined;
  if (!/no installed distributions|Windows Subsystem for Linux|wsl\.exe/i.test(output)) return undefined;
  return (
    `The "${shell}" command ran through the WSL launcher, which has no usable distribution ` +
    "(the message above comes from wsl.exe, not from the command). Install a distribution " +
    "(`wsl --install -d Ubuntu`) or run the command with another shell (shell=powershell|pwsh|cmd)."
  );
}
