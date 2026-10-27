# CI/CD

This project has two GitHub Actions workflows under [`.github/workflows/`](./.github/workflows/).
Because the standalone build is **pure Node** (no Rust binary), the pipeline is much
simpler than the original Venira monorepo pipeline.

## 1. `ci.yml` — runs on every push / PR

| Job | Matrix | What it does |
|---|---|---|
| `test` | **Ubuntu, Windows, macOS** × Node 20 & 22 | `npm ci` → `npm run build` → strict type-check → `smoke` → `doctor` → `verify` → `bench:mcp` (recorded) |
| `package` | Node 20 | `npm pack --dry-run` — verifies the published tarball is well-formed and shows its size |

Everything runs in standard GitHub runners. No self-hosted runner, no repo
variables, no external binary needed — the whole suite is self-contained.

> `better-sqlite3` ships prebuilt binaries for the supported
> Node × platform × arch combinations; if a new combo lacks a prebuild, the
> `npm ci` step in that matrix cell will compile from source (needs
> `python3` + build tools, which all three runners already have).

## 2. `release.yml` — runs on tag push (`v*`) or manual dispatch

Three jobs:

1. **`build`**
   - `npm ci` → `npm run build` → `npm run verify`
   - Produces two artifacts:
     - `venira-mcp-coding-*.tgz` — the npm package (for `npm install`)
     - `venira-mcp-coding-*-standalone.zip` — a drop-in bundle with `dist/`,
       `node_modules/`, docs, and `opencode.example.json` (no `npm install`
       needed)

2. **`docker`** (needs `build`)
   - Builds a multi-arch image (`linux/amd64` + `linux/arm64`) via
     `docker/build-push-action`
   - Pushes to **GitHub Container Registry** at
     `ghcr.io/<owner>/<repo>` with these tags:
     - the release tag (e.g. `v1.0.0`)
     - the commit SHA
     - `latest` (only on the default branch `main`)
   - Uses `gha` cache for faster rebuilds

3. **`release`** (needs `build` + `docker`)
   - Resolves the tag (`v*` from the push event, or the `tag` input on manual
     dispatch)
   - Creates a GitHub Release via `softprops/action-gh-release` with both
     bundles attached
   - Appends SHA-256 checksums **and the `docker pull` command** to the release body

### Prerequisites

- The repository must exist on GitHub (for `ghcr.io` push). For private
  repos, the GHCR image is also private — use `docker login` with a PAT that
  has `packages:read` to pull.
- The `docker` job requires the `packages: write` permission, which is
  already declared in the workflow.

### Manual trigger

From the GitHub UI: **Actions → Release → Run workflow → main**, optionally
passing a `tag` input (e.g. `v1.0.0`). When omitted, the workflow picks the
latest `v*` tag.

## 3. Publishing to npm (optional)

The `package` job already validates the tarball. To publish:

```bash
npm login
npm publish --access public
```

After publishing, users can run the MCP server without cloning or installing:

```bash
npx -y venira-mcp-coding              # stdio server
npx -y venira-mcp-coding --doctor     # preflight
npx -y venira-mcp-coding --verify     # behavioural suite
```
