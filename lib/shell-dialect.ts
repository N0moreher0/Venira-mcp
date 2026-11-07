/**
 * Shell dialect classification for policy evaluation.
 *
 * The shell policy treats POSIX shells (`bash`, `sh`, …), PowerShell
 * (`powershell`, `pwsh`) and cmd.exe (`cmd`) as different dialects: the same
 * destructive flags mean different things (`rm -rf` vs `Remove-Item
 * -Recurse -Force` vs `rd /s /q`), and the interpreter invocations are spelled
 * differently (`bash -c`, `pwsh -Command`, `cmd /c`).
 *
 * Keep this module dependency-free: it is imported by the parser and the policy
 * layers that must stay cycle-free and fast to import.
 */

export type ShellDialect = "posix" | "powershell" | "cmd";

export const POSIX_SHELLS: ReadonlySet<string> = new Set([
  "bash",
  "sh",
  "zsh",
  "ksh",
  "dash",
  "fish",
]);

export const POWERSHELL_SHELLS: ReadonlySet<string> = new Set(["powershell", "pwsh"]);

export const CMD_SHELLS: ReadonlySet<string> = new Set(["cmd", "cmd.exe", "bat", "batch"]);

export function isPosixShell(shell: string): boolean {
  return POSIX_SHELLS.has(shell.trim().toLowerCase());
}

export function isPowerShellShell(shell: string): boolean {
  return POWERSHELL_SHELLS.has(shell.trim().toLowerCase());
}

export function isCmdShell(shell: string): boolean {
  return CMD_SHELLS.has(shell.trim().toLowerCase());
}

/** Resolve a shell name to a policy dialect; default follows the host platform. */
export function resolveShellDialect(shell: string | undefined): ShellDialect {
  const value = (shell ?? "").trim().toLowerCase();
  if (value) {
    if (isPowerShellShell(value)) return "powershell";
    if (isCmdShell(value)) return "cmd";
    if (isPosixShell(value)) return "posix";
  }
  return process.platform === "win32" ? "powershell" : "posix";
}
