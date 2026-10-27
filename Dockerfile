# syntax: Dockerfile (multi-arch)

# Build context: the venira-mcp repo root.
#
# Usage:
#   docker buildx build --platform linux/amd64,linux/arm64 \
#     -t ghcr.io/<org>/venira-mcp:latest --push .
#
# Run:
#   docker run --rm -it \
#     -v /path/to/project:/workspace \
#     -e VENIRA_WORKSPACE=/workspace \
#     -e VENIRA_DATA_DIR=/workspace/data \
#     ghcr.io/<org>/venira-mcp

FROM node:22-slim AS build

WORKDIR /app

# Install build tools for better-sqlite3 (native module).
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    build-essential python3 \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
# Install ALL dependencies in the build stage (including devDependencies for
# `tsc`). The runtime stage only copies the compiled `dist/` + the runtime
# `node_modules`, so dev tools never ship in the image.
#
# better-sqlite3's install script (prebuild-install || node-gyp rebuild) is
# allowed via the `allowScripts` allowlist in package.json, so the native
# .node binding is produced here.
RUN npm ci

COPY tsconfig.json ./
COPY lib ./lib
COPY tools ./tools
COPY server.ts ./server.ts
RUN npm run build

# Rebuild better-sqlite3 against the runtime image's Node version if the
# build and runtime images ever use different Node ABIs.
# (Here both are node:22-slim, so this is a no-op kept for safety.)
RUN npm rebuild better-sqlite3

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
