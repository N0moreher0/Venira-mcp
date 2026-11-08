/**
 * A shell binary that is not installed (most often `pwsh`, which is not part of Windows) surfaces from
 * `spawn` as an asynchronous `ENOENT`. Without this module the caller saw `exit_code: -1` and an empty
 * stderr; with it the call fails with `[shell_unavailable]` and says how to fix it.
 */

export function isSpawnNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function installHint(shell: string, platform: string): string {
  const windows = platform === "win32";
  switch (shell) {
    case "pwsh":
      return (
        "PowerShell 7+ is not installed or not on the server's PATH. " +
        (windows
          ? "Install it with `winget install --id Microsoft.PowerShell`, then restart the MCP client so `pwsh` is on PATH. "
          : platform === "darwin"
            ? "Install it with `brew install --cask powershell`, then restart the MCP client so `pwsh` is on PATH. "
            : "Install it from https://learn.microsoft.com/powershell/scripting/install/installing-powershell, then restart the MCP client so `pwsh` is on PATH. ") +
        (windows
          ? 'Meanwhile use shell "powershell" (Windows PowerShell 5.1, no `&&` / `||`) or "cmd".'
          : 'Meanwhile use shell "bash".')
      );
    case "powershell":
      return windows
        ? 'powershell.exe was not found on PATH; use shell "cmd" or "pwsh" instead.'
        : 'Windows PowerShell exists only on Windows; use shell "pwsh" or "bash" instead.';
    case "cmd":
      return windows
        ? "cmd.exe was not found on PATH; check COMSPEC and the server's PATH."
        : 'cmd.exe exists only on Windows; use shell "bash" instead.';
    default:
      return `Install ${shell}, or choose another shell for this call (VENIRA_DEFAULT_SHELL sets the default).`;
  }
}

/** The `[shell_unavailable]` error text for a spawn that failed with ENOENT. */
export function shellUnavailableMessage(shell: string, file: string, platform: string): string {
  return (
    `[shell_unavailable] Shell "${shell}" (${file}) was not found, so the command did not run. ` +
    `Hint: ${installHint(shell, platform)} Do not retry unchanged.`
  );
}
