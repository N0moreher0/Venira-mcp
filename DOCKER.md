# venira-mcp-coding (standalone)

Multi-arch, multi-OS MCP server image. No external backend binary needed —
the backend is pure Node.

## Build

```bash
# Linux x86_64 + arm64
docker buildx build --platform linux/amd64,linux/arm64 \
  -t ghcr.io/your-org/venira-mcp-coding:latest --push .

# Local smoke test
docker build -t venira-mcp-coding . \
  && docker run --rm -it -v "$PWD:/workspace" venira-mcp-coding
```

## Run

```bash
# Mount your project as the workspace, audit DB is created inside it:
docker run --rm -it \
  -v /path/to/your/project:/workspace \
  -e VENIRA_WORKSPACE=/workspace \
  -e VENIRA_DATA_DIR=/workspace/data \
  venira-mcp-coding
```

## MCP client config (Docker transport)

OpenCode / Claude Desktop (stdio-over-docker requires the client's Docker
support; most use the "command" form that pipes stdio into the container):

```jsonc
{
  "mcp": {
    "venira": {
      "type": "local",
      "command": [
        "docker", "run", "--rm", "-i",
        "-v", "C:\\path\\to\\your-project:/workspace",
        "-e", "VENIRA_WORKSPACE=/workspace",
        "-e", "VENIRA_DATA_DIR=/workspace/data",
        "ghcr.io/your-org/venira-mcp-coding:latest"
      ],
      "enabled": true
    }
  }
}
```

## Notes

- The image runs as root by default (Node + better-sqlite3). To run unprivileged,
  use `--user 1000:1000` and make sure the mounted volume is readable/writable
  by that UID.
- Shell commands (`project_shell_run`) execute *inside the container*. To
  reach the host shell, mount the host binary and set `VENIRA_DEFAULT_SHELL`.
- The audit DB is written to `/workspace/data/venira.db` (or `VENIRA_DATA_DIR`).
  If the volume is read-only, set `VENIRA_DATA_DIR` to a writable path.
