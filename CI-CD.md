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

> **`better-sqlite3` + npm v12.** The native module ships prebuilt binaries
> for the supported Node × platform × arch combinations. `package.json`
> carries an `allowScripts` allowlist (`better-sqlite3`, `esbuild`) that was
> generated with `npm approve-scripts`, so on npm v12 (where dependency
> install scripts are off by default) the `install` script still runs and
> the prebuild downloads. If a combo lacks a prebuild, the `npm ci` step
> compiles from source (needs `python3` + build tools, which all three
> runners already have). The `bin/venira-mcp-coding.js` npx entry also
> self-heals: if the `.node` binding is missing, it runs `npm rebuild
> better-sqlite3` before launching.

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
   - Pushes to **GitHub Container Registry** at `ghcr.io/<owner>/<repo>`
     with tags: the release tag (e.g. `v1.0.0`), the commit SHA, and
     `latest` (only on the default branch `main`)
   - Uses `gha` cache for faster rebuilds

3. **`release`** (needs `build` + `docker`)
   - Resolves the tag (`v*` from the push event, or the `tag` input on
     manual dispatch)
   - Creates a GitHub Release via `softprops/action-gh-release` with both
     bundles attached
   - **Publishes to npm via OIDC trusted publishing** (see §3)
   - Appends SHA-256 checksums **and the `docker pull` command** to the
     release body

### Prerequisites

- The repository must exist on GitHub (for `ghcr.io` push). For private
  repos, the GHCR image is also private — use `docker login` with a PAT that
  has `packages:read` to pull.
- The `docker` job requires the `packages: write` permission, which is
  already declared in the workflow.
- The `release` job requires `contents: write` + `id-token: write`
  (declared in the workflow). `id-token: write` is what npm's OIDC flow
  exchanges for a short-lived publish credential.

### Manual trigger

From the GitHub UI: **Actions → Release → Run workflow → main**, optionally
passing a `tag` input (e.g. `v1.0.0`). When omitted, the workflow picks the
latest `v*` tag.

## 3. Publishing to npm — OIDC trusted publishing (no long-lived token)

Since 2026-07, npm is deprecating 2FA-bypass granular access tokens (GATs)
for publishing (effective ~2027-01). The recommended replacement is **OIDC
trusted publishing**: the GitHub Actions workflow requests a short-lived JWT
from the `GITHUB_TOKEN`/`id-token: write` permission, npm exchanges it for a
scoped, single-use publish credential. Nothing long-lived is stored in the
repo.

**One-time setup (on the npm side):**

```bash
# As a maintainer of the venira-mcp-coding package:
npm login
npm pkg trust add N0moreher0/Venira-mcp   # register the repo as a trusted publisher
```

Or via the web UI: npmjs.com → your package → **Trusted Publishers** →
*Add publisher* → npm → GitHub → `N0moreher0/Venira-mcp`.

**On the GitHub side:** enable Actions (Settings → Actions → General) and
make sure the repo is not restricted to fork-only.

After that, every successful `v*` tag push auto-publishes — the `release`
job's `npm publish` step picks up the OIDC token automatically. No `NPM_TOKEN`
secret, no 2FA-bypass GAT.

> **First publish** (creating the package on npm) still requires a human
> `npm publish` from a logged-in machine — trusted publishing can only
> publish *existing* packages. So:
>
> ```bash
> cd venira-mcp-coding-standalone
> npm login
> npm publish --access public
> ```
>
> Subsequent releases can all go through the workflow.

After publishing, users can run the MCP server without cloning or installing:

```bash
npx -y venira-mcp-coding              # stdio server
npx -y venira-mcp-coding --doctor     # preflight
npx -y venira-mcp-coding --verify     # behavioural suite
```

## 4. npm v12 notes (install-time security)

As of npm v12 (2026-07), dependency lifecycle scripts are off by default.
This project opts back in for the two packages that need it:

- `better-sqlite3` — its `install` script (`prebuild-install || node-gyp
  rebuild`) must run or the native binding is missing.
- `esbuild` (transitive dep of `tsx`, dev-only) — its `postinstall` picks
  the platform binary.

The allowlist lives in `package.json` under `allowScripts`. To regenerate
after a dependency update:

```bash
npm install
npm approve-scripts --allow-scripts-pending   # review what would be blocked
# approve the packages you trust, deny the rest, then commit package.json
```
