# Isolation guides — Docker, WSL, Windows Sandbox

Venira is a **guard rail with an audit trail, not a sandbox**. The workspace lock,
shell policy and protected paths reduce mistakes and make them visible, but they run
with the privileges of the OS user that started the server. When you need a real
isolation boundary — untrusted repository, generated code, an agent you do not fully
trust — run the whole server inside a container or VM, not just the shell commands.

This page covers the three practical options on Windows/Linux, with the mounts,
network controls and limits of each. [`SECURITY.md`](./SECURITY.md) describes the
threat model; [`DOCKER.md`](./DOCKER.md) has the image build details.

## Choosing a boundary

| Option | Isolation strength | Persistence | Best for |
|---|---|---|---|
| Docker container | Strong (namespaces, seccomp, no host FS by default) | Named volumes / bind mounts you choose | Day-to-day untrusted repos; CI-like reproducibility |
| WSL 2 distro | Weak boundary vs. Windows (interop can reach `C:\`, shares the same user) | Full (normal Linux FS) | Linux toolchains; cheap separation, not hostile code |
| Windows Sandbox | Strong (disposable VM, no host FS except mapped folders) | None (destroyed on close) | One-off review of a suspicious repo; demos |
| Full VM | Strongest | Full | Long-running work on untrusted code, kernel-level isolation |

Rule of thumb: **Docker or a VM for code you would not run directly; WSL for
convenience; Windows Sandbox for a single disposable session.**

## Docker

The server and every `project_shell_run` command execute **inside the container**.
The host is reachable only through what you mount.

```bash
# Workspace: read-write bind mount. Data + checkpoints: named volumes, never the
# host's real %LOCALAPPDATA%\venira (a bind mount would expose the host store).
docker run --rm -i \
  --network none \
  --read-only --tmpfs /tmp \
  -v /path/to/project:/workspace \
  -v venira-data:/data \
  -v venira-snapshots:/snapshots \
  -e VENIRA_WORKSPACE=/workspace \
  -e VENIRA_DATA_DIR=/data \
  -e VENIRA_SNAPSHOT_DIR=/snapshots/my-project \
  -e VENIRA_SECURITY_PROFILE=balanced \
  --user 1000:1000 \
  ghcr.io/your-org/venira-mcp:latest
```

MCP client config (stdio piped into the container):

```jsonc
{
  "mcp": {
    "venira": {
      "type": "local",
      "command": [
        "docker", "run", "--rm", "-i",
        "--network", "none",
        "-v", "C:\\src\\my-app:/workspace",
        "-v", "venira-data:/data",
        "-v", "venira-snapshots:/snapshots",
        "-e", "VENIRA_WORKSPACE=/workspace",
        "-e", "VENIRA_DATA_DIR=/data",
        "-e", "VENIRA_SNAPSHOT_DIR=/snapshots/my-app",
        "ghcr.io/your-org/venira-mcp:latest"
      ],
      "enabled": true
    }
  }
}
```

**Mounts**

- Mount only the project. Do not mount the repo root above it, the user profile,
  or the host data directory.
- Keep `VENIRA_DATA_DIR` and the checkpoint store on volumes owned by the container
  user. The data dir holds the audit chain, approval key and encrypted secrets.
- Never mount `/var/run/docker.sock`: it is root-equivalent on the host and defeats
  the boundary.
- `--read-only` with a writable `VENIRA_DATA_DIR` is a useful hardening default;
  the workspace bind mount stays writable where the agent must edit.

**Network**

- `--network none` is the strongest option. Everything still works except
  `project_shell_run` commands that need the network, git fetch/push, package
  installs, and the Git provider/CI tools.
- To keep provider/CI tools working, use a user-defined network with egress
  filtering, or an allowlist proxy. Do not use `--network host`.
- A container with network access can still exfiltrate the workspace. Treat
  "network on" as a deliberate trust decision.

**Limits**

- Shell commands run inside the container, so host binaries and host credentials
  are unavailable — unless you mounted them. `VENIRA_DEFAULT_SHELL` must name a
  shell that exists in the image.
- The image runs as root by default. Use `--user 1000:1000` and make the mounted
  volumes writable by that UID, or the audit DB and checkpoints fail to write.
- The MCP client itself runs on the host and owns the stdio pipe; the client's own
  file tools and extensions are outside this boundary.
- Docker Desktop on Windows/macOS adds a VM layer, but bind mounts still expose
  the mounted folder with the host user's permissions.
- Approvals need a human with a TTY. In a headless container, either use
  `VENIRA_SHELL_ELICIT=1` with an elicitation-capable client, or grant approvals
  from a terminal that can see the same data dir.

## WSL 2

Run the server **inside the distro** and keep the workspace on the Linux filesystem.

```bash
# Inside WSL
npm --prefix /home/me/venira-mcp install
VENIRA_WORKSPACE=/home/me/src/my-app \
VENIRA_DATA_DIR=/home/me/.local/share/venira \
VENIRA_SNAPSHOT_ROOT=/home/me/.local/share/venira/snapshots \
  node /home/me/venira-mcp/dist/server.js
```

MCP client config on Windows:

```jsonc
{
  "mcp": {
    "venira": {
      "type": "local",
      "command": ["wsl", "-d", "Ubuntu", "--", "node", "/home/me/venira-mcp/dist/server.js"],
      "environment": {
        "VENIRA_WORKSPACE": "/home/me/src/my-app",
        "VENIRA_DATA_DIR": "/home/me/.local/share/venira"
      }
    }
  }
}
```

**Mounts and paths**

- Keep the project under `/home/...` (ext4). `/mnt/c/...` is slow, case-insensitive
  and reports Windows permissions; file mtimes and the workspace lock behave
  better on the native filesystem.
- `VENIRA_WORKSPACE` and the data/snapshot paths must be Linux paths. Windows paths
  are not translated.
- Shell commands run in the distro; `bash`/`sh` are available, PowerShell is not
  (unless you installed it inside WSL).

**Interop and network**

WSL 2 is **not** a security boundary against Windows: by default a process can run
`/mnt/c/Windows/System32/cmd.exe` and reach the whole `C:` drive. If you want some
separation, disable interop and Windows path injection in `/etc/wsl.conf`:

```ini
[interop]
enabled = false
appendWindowsPath = false
```

Then `wsl --shutdown`. This stops accidental host execution, but the same Windows
user can still read the distro's files and vice versa; it does not contain a
determined attacker.

WSL 2 shares the host network stack (NAT or mirrored mode). There is no
container-style `--network none`; restrict egress with Windows Firewall rules or
run Docker inside WSL when you need real network isolation. Set memory/CPU caps in
`%UserProfile%\.wslconfig` (`[wsl2] memory=8GB processors=4`) so a runaway build
cannot starve Windows.

**Limits**

- Same-user access from Windows via `\\wsl$\...`, and root inside the distro, are
  outside the guard.
- The data dir on ext4 is not encrypted unless the distro/disk is.
- A compromised Windows process can still start commands in the distro.

## Windows Sandbox

Windows Sandbox is a disposable VM. Use it to open a suspicious repository once,
with no lasting state on the host.

Requires Windows 10/11 **Pro, Enterprise or Education**, virtualization enabled in
firmware, and the "Windows Sandbox" optional feature installed.

`venira.wsb`:

```xml
<Configuration>
  <Networking>Disable</Networking>
  <MappedFolders>
    <MappedFolder>
      <HostFolder>C:\src\my-app</HostFolder>
      <SandboxFolder>C:\workspace</SandboxFolder>
      <ReadOnly>false</ReadOnly>
    </MappedFolder>
    <MappedFolder>
      <HostFolder>C:\src\venira-mcp</HostFolder>
      <SandboxFolder>C:\venira-mcp</SandboxFolder>
      <ReadOnly>true</ReadOnly>
    </MappedFolder>
  </MappedFolders>
  <LogonCommand>
    <Command>powershell -ExecutionPolicy Bypass -NoProfile -Command "cd C:\venira-mcp; npm ci --omit=dev; node dist\server.js"</Command>
  </LogonCommand>
</Configuration>
```

Launch with `WindowsSandbox.exe C:\src\venira.wsb` (or double-click the file), then
point the MCP client at the sandbox process. Most clients cannot attach to a process
inside the sandbox; a practical pattern is to run the agent **inside** the sandbox
too, with the project mapped in.

**Mounts**

- Only mapped folders cross the boundary. The rest of the host is invisible.
- Map the project read-write only when the agent must edit it; prefer a copy.
- The sandbox's data dir and checkpoints are ephemeral. Map a separate writable
  folder if you need the audit trail or checkpoints after the session, and treat
  that folder as untrusted output.
- Mapped folders are shared with the host; a process in the sandbox can modify them
  with your host permissions.

**Network**

`<Networking>Disable</Networking>` removes network access entirely. Omit it (or use
`Enable`) when the toolchain needs package installs or the Git provider/CI tools;
then set up the image or a proxy beforehand. Windows Sandbox has no port-forwarding
configuration; use mapped folders for data exchange.

**Limits**

- Everything is destroyed when the sandbox closes: no audit history, no checkpoints,
  no installed packages.
- GPU, some USB devices and nested virtualization are unavailable by default.
- The host must run the sandbox; it is not a server deployment target.
- If you map a host folder read-write, a command can still damage that folder. Keep
  a backup or map a copy.
- Sandbox escape vulnerabilities exist; it is much stronger than nothing, not
  equivalent to a hardened VM with a separate kernel.

## Checklist before trusting a boundary

- [ ] Workspace is the only writable host path (or a copy).
- [ ] `VENIRA_DATA_DIR` and the checkpoint store are on container/VM storage, not
      the host profile.
- [ ] No Docker socket, home directory, SSH keys or cloud credential mounts.
- [ ] Network is `none` unless git/provider/CI/package installs are required.
- [ ] Shell commands execute inside the boundary (no host shell mounted).
- [ ] You can see and approve `ask` commands (TTY or elicitation).
- [ ] You know where the audit DB lives and how to read it after the session.
