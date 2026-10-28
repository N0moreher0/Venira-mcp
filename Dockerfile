# syntax: Dockerfile (multi-arch)

# Build context: the venira-mcp repo root.
#
# Usage:
#   docker buildx build --platform linux/amd64,linux/arm64 \
#     -t ghcr.io/<org>/venira-mcp:latest --push .
#
# Run:
#   docker run --rm -it \
#     -v /path/to/your/project:/workspace \
#     -e VENIRA_WORKSPACE=/workspace \
#     -e VENIRA_DATA_DIR=/workspace/data \
#     ghcr.io/<org>/venira-mcp

FROM node:22-slim AS build

WORKDIR /app

# Build tools: better-sqlite3 ships prebuilt .node binaries for linux-x64
# (node 22 ABI). If a prebuild exists, `npm rebuild` just downloads it
# (needs curl + ca-certificates). build-essential + python3 are the
# fallback path (compile from source) when no prebuild matches.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    build-essential python3 curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# 1. Install the full dependency tree (dev deps included — tsc needs them).
#    Lifecycle scripts of dependencies are NOT run (npm v12 security
#    defaults; they also don't matter — we rebuild the native module below).
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# 2. Copy sources and compile.
COPY tsconfig.json ./
COPY lib ./lib
COPY tools ./tools
COPY scripts ./scripts
COPY server.ts ./server.ts
COPY bin ./bin
RUN npm run build

# 3. Produce the better-sqlite3 native binding for THIS platform/Node ABI
#    (prebuild download, falls back to node-gyp source build).
RUN npm rebuild better-sqlite3

# ---------------------------------------------------------------------------
# Runtime image
# ---------------------------------------------------------------------------
FROM node:22-slim AS runtime

# bash (default shell for project_shell_run), git (future diff tooling),
# curl + ca-certificates (prebuild downloads / TLS).
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash git curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Runtime-only dependency tree (no typescript/tsx/@types).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

# Carry the compiled output, the npx entry, and the native binding that was
# built in the build stage (same base image + same Node ABI, so the .node
# binary loads directly; a fallback rebuild below covers edge cases).
COPY --from=build /app/dist ./dist
COPY --from=build /app/bin ./bin
COPY --from=build /app/node_modules/better-sqlite3 ./node_modules/better-sqlite3
RUN npm rebuild better-sqlite3 || true

# Docs for users running the image.
COPY README.md ./

# Expose the MCP server as the default entrypoint.
# The server reads its config from environment variables:
#   VENIRA_WORKSPACE     (default /workspace)
#   VENIRA_DATA_DIR      (default /workspace/data)
#   VENIRA_UNRESTRICTED  (default 0)
#   VENIRA_DEFAULT_SHELL  (default bash)
ENV VENIRA_WORKSPACE=/workspace \
    VENIRA_DATA_DIR=/workspace/data \
    VENIRA_DEFAULT_SHELL=bash

# Default workspace dir so the image can start even without a volume.
RUN mkdir -p /workspace/data

# Entrypoint is the npx wrapper, so the CLI flags work inside the container:
#   docker run --rm -i -v $PWD:/workspace ghcr.io/.../venira-mcp            # server
#   docker run --rm    -v $PWD:/workspace ghcr.io/.../venira-mcp --doctor   # preflight
#   docker run --rm ghcr.io/.../venira-mcp --version
ENTRYPOINT ["node", "/app/bin/venira-mcp.js"]
