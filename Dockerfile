# syntax: Dockerfile (multi-arch)

# Build context: the venira-mcp-coding repo root.
#
# Usage:
#   docker buildx build --platform linux/amd64,linux/arm64 \
#     -t ghcr.io/<org>/venira-mcp-coding:latest --push .
#
# Run:
#   docker run --rm -it \
#     -v /path/to/project:/workspace \
#     -e VENIRA_WORKSPACE=/workspace \
#     -e VENIRA_DATA_DIR=/workspace/data \
#     ghcr.io/<org>/venira-mcp-coding

FROM node:22-slim AS build

WORKDIR /app

# Install build tools for better-sqlite3 (native module).
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    build-essential python3 \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
# npm ci with better-sqlite3's install script allowed (allowScripts in package.json)
RUN npm ci --omit=dev

COPY tsconfig.json ./
COPY lib ./lib
COPY tools ./tools
COPY server.ts ./server.ts
RUN npm run build

# ---------------------------------------------------------------------------
# Runtime image
# ---------------------------------------------------------------------------
FROM node:22-slim AS runtime

# Install git (for users who want project_diff_files / symbol tools later)
# and bash (default shell on Linux).
RUN apt-get update \
  && apt-get install -y --no-install-recommends bash git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy the compiled output + package.json so `npx`-style entry works.
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/bin ./bin

# Expose the MCP server as the default entrypoint.
# The server reads its config from environment variables:
#   VENIRA_WORKSPACE   (default /workspace)
#   VENIRA_DATA_DIR    (default /workspace/data)
#   VENIRA_UNRESTRICTED (default 0)
#   VENIRA_DEFAULT_SHELL (default bash)
ENV VENIRA_WORKSPACE=/workspace \
    VENIRA_DATA_DIR=/workspace/data \
    VENIRA_DEFAULT_SHELL=bash

# Create a default workspace dir so the image can run even without a volume.
RUN mkdir -p /workspace/data

EXPOSE 0

ENTRYPOINT ["node", "/app/dist/server.js"]
