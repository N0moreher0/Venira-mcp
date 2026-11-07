# ROADMAP_GIT_OAUTH.md — Phase G: OAuth sign-in for Git providers

> **Status: DESIGN ONLY — nothing is implemented.** Written 2026-11-07 against `main` @ `ed27cf9` (v1.17.0).
> Scope: GitLab (primary), Bitbucket Cloud (decision record), GitHub (reference implementation).
> Companion to `ROADMAP.md` Phase E (CI reliability) and Phase F (next CI provider). Same rules apply: research gate first, one provider at a time, no live credentials in the test suite.

Legend used below. **[repo]** verified in this repository on 2026-11-07. **[docs]** taken from official vendor documentation or vendor issue tracker found during research (links in §14). **[spike]** NOT confirmed — must be checked against a live instance in step G.1 before any code is written. Where two sources disagree, both are recorded.

---

## 1. TL;DR

1. **GitHub** already has OAuth (Device Flow, `project_github_connect`, S17 / v1.8.0). **GitLab and Bitbucket use pasted tokens only** (`project_secret` or env). No roadmap file mentions OAuth for them (checked `ROADMAP.md`, `ROADMAP_HARDENING.md`, `TOOL-ROADMAP.md`, `TODO.md`; no code, branch or stash either).
2. **GitLab is feasible and the best fit.** GitLab supports the OAuth 2.0 Device Authorization Grant (RFC 8628): introduced 17.2 behind a flag, on by default in 17.3, GA in 17.9 [docs]. It maps almost 1:1 onto the existing `GithubDeviceFlow` design. Public client, no secret, no callback server.
3. **Bitbucket Cloud has no device flow** [docs]. Its OAuth 2.0 needs a registered consumer with a callback URL and a client secret. A secret cannot be shipped in an npm package. **Recommendation: do not build Bitbucket OAuth.** Offer a hidden-prompt token CLI instead (§10).
4. **Four things in the current code block a naive port** (details §3.3): (a) GitLab requests always send `PRIVATE-TOKEN`, which is the wrong header for OAuth tokens; (b) the refresh hook is hard-wired to the string `Secret "GITHUB_TOKEN"`; (c) GitLab refresh tokens **rotate**, so refresh needs a cross-process lock; (d) hints and the tool name say "GitHub" everywhere.
5. **A cheaper alternative exists** that solves the actual UX problem ("never paste a token into chat") for both providers: generalize `scripts/setup-github.ts` into `--setup-git <provider>` (hidden prompt → vault). See §4 option A.
6. **Nothing starts before G.0 (demand gate).** Today there is no recorded workflow that PATs cannot serve.

---

## 2. Goals and non-goals

**Goals**
- A user can connect GitLab (gitlab.com and self-managed ≥ 17.9) without pasting a token into chat or editing files.
- Tokens live only in the encrypted local vault, never in tool output, audit rows or logs (same guarantees as GitHub S17).
- Access tokens refresh transparently; expired/invalid state produces one actionable error.
- Least-privilege: the user can pick read-only vs read/write.
- Zero change to behaviour for users who keep using PATs.

**Non-goals (explicitly out of scope for Phase G)**
- Authorization-code flow with a local callback server (loopback listener) for GitLab — device flow already covers headless and local use.
- Bitbucket OAuth app flow, Bitbucket Data Center / Server, GitLab Dedicated specifics.
- OAuth for Azure DevOps (already ruled out in Phase F: deprecated).
- Group/instance-level GitLab application management, SSO/SAML handling, token introspection UIs.
- Changing GitHub behaviour (only a possible internal refactor, §6.4).

---

## 3. Current state (verified in this repo)

### 3.1 What exists [repo]

| Piece | Where | Notes |
|---|---|---|
| GitHub Device Flow engine | `lib/github-device-flow.ts` (303 lines) | `GithubDeviceFlow.start/poll`, in-memory `pending` map (max 4, prune on expiry), `slow_down` back-off, response size cap 16 KB, `redirect: "error"`, 15 s timeouts, verification URL pinned to `https://github.com/login/device`. |
| Embedded client id | `GITHUB_OAUTH_CLIENT_ID` constant | Public, non-secret. Precedent for shipping a client id. |
| Token persistence | `saveToVault()` | `GITHUB_TOKEN` + `GITHUB_REFRESH_TOKEN` via `setSecret(..., { source: "provider", expiresAt })`. |
| Refresh | `refreshGithubAccessTokenIfNeeded()` | Single in-process `refreshInFlight` promise. On failure → `[secret_expired] … Reconnect GitHub with project_github_connect`. |
| Tool | `tools/project.ts` ~L4403 `project_github_connect` | `action: start | poll`, `replace_existing`, `pending_id`. Handler `opGithubConnect` in `lib/corehost.ts` ~L2738. |
| Refresh trigger | `lib/git-provider.ts` `resolve()` L28–45 | Catches the error string `[secret_expired] Secret "GITHUB_TOKEN"` from `gitContext()` then refreshes and retries. |
| Token resolution | `lib/git-config.ts` `tokenFor()` L299–343 | Order: `VENIRA_GIT_TOKEN` env → vault secret (`GITHUB_TOKEN` / `GITLAB_TOKEN` / `BITBUCKET_TOKEN`, expiry checked before decrypt) → provider env chain (`VENIRA_GITLAB_TOKEN`, `GITLAB_TOKEN`, `GL_TOKEN`, …). |
| Auth header | `lib/git-http.ts` `authHeaders()` L343 | **GitLab always `PRIVATE-TOKEN`**. Bitbucket: Basic if `username` configured, else Bearer. |
| Host policy | `lib/git-config.ts` | `DEFAULT_ALLOWED_HOSTS = api.github.com, gitlab.com, api.bitbucket.org`; extend with `VENIRA_GIT_ALLOWED_HOSTS`; https enforced (http only for localhost or `VENIRA_GIT_ALLOW_HTTP=1`). Repo-level config is honoured only when `isTrustedConfig()` (explicit `VENIRA_CONFIG_FILE` or user-level file). |
| Secret guard | `lib/provider-secret-guard.ts` | Secretlint scan on every provider request/response, fail-closed. |
| Tests | `scripts/test-github-device-flow.ts`, wired into `npm run verify` | Mock fetcher, pending/connected/refresh paths. |
| CLI fallback | `scripts/setup-github.ts`, `bin/venira-mcp.js --setup-github` | Hidden-terminal PAT prompt → vault. **No GitLab/Bitbucket equivalent.** |
| Agent rule | `server.ts` instruction #9 | "Never ask for a token in chat." Only GitHub has a compliant path today. |
| Docs that name the tool | README §4 (`project_github_connect — GitHub Device Flow`), `server.ts` L32/L52, hint strings in `lib/git-config.ts` L323/L491 and `lib/git-http.ts` L370 | All GitHub-specific wording. |

### 3.2 What the provider adapters assume [repo]

- GitLab dialect (`lib/git-gitlab.ts`, ~24.5 KB): MR create/note/merge/list/close/reopen, pipelines status/trigger/cancel/retry, job trace logs. API base default `https://gitlab.com/api/v4`.
- Capability matrix (`ROADMAP.md` Phase E.1) documents minimum **token** scopes: GitLab `read_api` (reads), `api` (trigger/cancel/retry and MR writes).
- CI verification relies on local mocks (`scripts/git-mocks.ts`, one-shot `state.fault` injection). Never live credentials.

### 3.3 Blockers for a naive port (must be designed around)

1. **Wrong auth header for OAuth.** `authHeaders()` returns `PRIVATE-TOKEN` for every GitLab call. GitLab's `PRIVATE-TOKEN` header is for personal/project/group access tokens; OAuth access tokens are sent as `Authorization: Bearer` [spike: confirm]. Also confirm that PATs are accepted as `Authorization: Bearer` so one header can serve both (§6.8).
2. **Brittle refresh hook.** `resolve()` string-matches the `GITHUB_TOKEN` error message. GitLab would need a second copy of the hack. Replace with a provider-keyed "ensure fresh token" step run *before* `gitContext()` (§6.9).
3. **Rotating refresh tokens.** GitLab refresh invalidates the old access *and* refresh token and returns new ones [docs]. Two Venira processes sharing one vault (the documented setup: "shared user vault") can race; the loser holds a dead refresh token. GitHub's current code has the same latent issue; Phase G must not copy it (§6.9).
4. **GitHub-flavoured naming/hints.** Tool name, schema text, error hints (`project_github_connect action=start`) and the server instruction need provider-neutral wording.

---

## 4. Options considered

| | Option | Solves "no token in chat" | Needs OAuth app registered | Refresh | Effort (estimate, not measured) | Verdict |
|---|---|---|---|---|---|---|
| **A** | `--setup-git <github\|gitlab\|bitbucket>` hidden-prompt CLI (generalize `setup-github.ts`) | Yes | No | No (PAT expiry managed via `project_secret` `expires_in_days`) | S | **Do first / independent of OAuth. Works for Bitbucket too.** |
| **B** | GitLab Device Flow (this document) | Yes | Yes (public client, owner decision D1) | Yes (rotating) | M–L | **Build only if G.0 passes** |
| C | GitLab authorization-code + loopback listener | Yes | Yes | Yes | L (+ listener attack surface) | Rejected: more code, no benefit over B |
| D | Bitbucket OAuth (auth-code, BYO consumer) | Yes | Yes, per user, with secret | Yes (rotating) | L | Rejected for now (§10) |
| E | Do nothing | No | – | – | – | Acceptable until demand is shown |

Recommendation: ship **A** if/when someone asks for a compliant GitLab/Bitbucket setup; ship **B** only with a concrete need for short-lived tokens or zero-copy onboarding.

---

## 5. Provider research

### 5.1 GitLab OAuth 2.0 Device Authorization Grant

| Fact | Value | Source |
|---|---|---|
| Availability | Introduced **17.2** behind flag `oauth2_device_grant_flow`; **enabled by default 17.3**; **GA 17.9**, flag removed | [docs] GitLab OAuth 2.0 IdP API version history (mirrors of the help page) |
| Docs disagreement | The current docs header lists "Device Authorization Grant (GitLab 17.1 and later)"; the version-history block and `glab` docs say 17.9 for GA/requirement | [docs] — **treat 17.9 as the supported floor; do not claim lower** |
| Tiers | Free, Premium, Ultimate; GitLab.com, Self-Managed, Dedicated | [docs] |
| Device authorization request | `POST {origin}/oauth/authorize_device`, `Content-Type: application/x-www-form-urlencoded`, params `client_id`, `scope` | [docs] MR !155622 and the vendor security report |
| Scope parameter encoding | Docs show `scope=api`; one vendor report sends the parameter twice (`scope=email&scope=api`). Space-separated vs repeated is **unconfirmed** | [spike] |
| Device authorization response | `device_code`, `user_code`, `verification_uri` (`{origin}/oauth/device`), `verification_uri_complete`, `expires_in` (example **300**), `interval` (example **5**) | [docs] example payloads; values are examples, not guarantees |
| Token request | `POST {origin}/oauth/token`, form body `client_id`, `device_code`, `grant_type=urn:ietf:params:oauth:grant-type:device_code`; **no client secret** | [docs] |
| Token response | `access_token`, `token_type: Bearer`, `expires_in` (example **7200**), `refresh_token`, `scope`, `created_at` | [docs] example |
| Polling errors | Standard RFC 8628: `authorization_pending` (keep polling), `slow_down` (reduce rate), `expired_token` (start over), `access_denied` | [docs] |
| Application requirements | OAuth application must be **non-confidential**; `device_code` must be in the application's allowed grant types (GitLab ≥ 17.9) | [docs] MR !155622, `glab` auth docs |
| Redirect URI | `glab` docs say a redirect URI is "not required if you only intend to use --device"; whether the GitLab application form still demands one is **unconfirmed** | [spike] |
| Refresh | `POST /oauth/token`, `grant_type=refresh_token`; **invalidates the existing access and refresh token and returns new ones**; usable after the access token expired | [docs] |
| Revoke / introspect | Tokens API lists "revoke" and "get token information" (scopes, expiry). Exact paths/behaviour (`/oauth/revoke`, `/oauth/token/info`) | [spike] |
| Registration | Application owned by a user, group or (self-managed) the instance admin; each self-managed instance needs its **own** application/client id | [docs] |
| Known risk | GitLab security issue #476670: device flow "cross window forgery" via the Authorize button id (labelled a regression). Fix status unknown | [docs] vendor issue tracker — see §8 |

### 5.2 Bitbucket Cloud OAuth 2.0

| Fact | Value | Source |
|---|---|---|
| Grants | Authorization code (RFC 6749 §4.1), implicit, client credentials (§4.4), custom JWT exchange. Password grant **no longer supported**. **No device flow.** | [docs] |
| Consumer | Key + **secret** required; **callback URL required** (one per consumer) | [docs] |
| Scopes | Defined on the consumer, **not** per request (the optional `scope` parameter is ignored) | [docs] |
| Token lifetime | Access token **2 hours** (Atlassian support site) or **1 hour** (developer.atlassian.com) — pages disagree; assume ≤ 1 h | [docs] |
| Refresh | New refresh token issued on every refresh; old one expires shortly after; unused refresh token expires after **3 months** | [docs] |
| CI scopes | `pipeline` (read), `pipeline:write` (trigger/stop); repository/project/workspace access tokens use the same scope names | `ROADMAP.md` E.1 + [docs] |

### 5.3 Comparison with the GitHub flow we already have

| | GitHub (existing) | GitLab (proposed) |
|---|---|---|
| Device endpoint | `https://github.com/login/device/code` | `{origin}/oauth/authorize_device` |
| Token endpoint | `https://github.com/login/oauth/access_token` | `{origin}/oauth/token` |
| Body encoding | JSON | **form-urlencoded** |
| Scopes | `repo offline_access` | `read_api` and/or `api` (no `offline_access` concept; refresh token is returned) |
| Refresh token | Optional (`refresh_token_expires_in` present) | Always (assumed) and **rotates** |
| Verification URL | pinned `github.com/login/device` | `{origin}/oauth/device`, origin = configured instance |
| Client id | embedded constant | embedded for gitlab.com **only if D1 accepted**; BYO for self-managed |
| Hosts | one fixed | gitlab.com + any self-managed host the user allow-lists |
| Auth header for API | `Authorization: token/Bearer` | **must become `Authorization: Bearer`** |

---

## 6. Design (GitLab Device Flow)

### 6.1 User flow

```
agent                      Venira                         GitLab                    user
 |  start (provider=gitlab) |                               |                         |
 |------------------------->| POST /oauth/authorize_device  |                         |
 |                          |------------------------------>|                         |
 |                          |<-- device_code, user_code ----|                         |
 |<- verification_uri,      |  (device_code stays in memory)|                         |
 |   user_code, pending_id  |                               |                         |
 |  tells the user the link + code ───────────────────────────────────────────────────>|
 |                          |                               |   opens link, checks that|
 |                          |                               |   the code matches,      |
 |                          |                               |   signs in, Authorizes   |
 |  poll (pending_id) ...   | POST /oauth/token (device)    |                         |
 |------------------------->|------------------------------>|                         |
 |<- pending | connected    |<-- access+refresh token ------|                         |
 |    (never a token)       |  save to vault, GET /user     |                         |
```

### 6.2 Tool surface (decision D2)

The Default/Expert tool counts (32 / 42, +1 with JS exec) are a documented contract checked by `scripts/check-docs.ts` and `scripts/doctor.ts` and listed in README §4. Options:

| Option | Change | Pros | Cons |
|---|---|---|---|
| **A (recommended)** | Add optional `provider: github \| gitlab` (default `github`) and `access: read \| write` to **`project_github_connect`** | No tool-count change; backward compatible; smallest diff | Name is misleading for GitLab |
| B | New `project_git_connect`, keep `project_github_connect` as deprecated alias | Clean naming | +1 tool: update README §4, `check-docs.ts`, `doctor.ts`, `VENIRA_PROFILE=core` list, verify |
| C | New `project_gitlab_connect` | Isolated | +1 tool; precedent for per-provider tools we do not want |

Start with A; rename to B when a third provider appears. Keep the schema description honest ("Connect a Git provider… GitHub or GitLab").

New/changed arguments (A):
- `provider`: `github` (default) | `gitlab`.
- `access`: `read` → scope `read_api`; `write` → scope `api` (default, decision D3 — mirrors GitHub's broad `repo`; offer `read` explicitly in the docs).
- `api_url` is **not** an argument. The instance comes from trusted config/env only (§6.6).

### 6.3 Module layout

- New `lib/gitlab-device-flow.ts` containing `GitlabDeviceFlow` (`start`, `poll`, `disconnect`) and `refreshGitlabAccessTokenIfNeeded()`.
- Shared helpers (`responseJson`, `requiredString`, `positiveSeconds`, `optionalPositiveSeconds`, pending-map handling, `slow_down` state machine) are currently private to `lib/github-device-flow.ts`. Extract them to `lib/oauth-device.ts` **after** GitLab works (D6), keeping GitHub behaviour byte-identical and `test:github-device-flow` green.
- `opGithubConnect` in `lib/corehost.ts` dispatches on `provider`; keep the handler thin.
- No changes to the policy/shell layers.

### 6.4 Endpoints and contracts

All requests: `POST`, `application/x-www-form-urlencoded`, `Accept: application/json`, `redirect: "error"`, 15 s timeout, response cap 16 KB, JSON object only (same hardening as GitHub).

| Step | URL | Body | Success | Errors → status |
|---|---|---|---|---|
| start | `{origin}/oauth/authorize_device` | `client_id`, `scope` | `device_code`, `user_code`, `verification_uri`, `expires_in`, `interval` | HTTP/JSON error or 404 → `provider_error` with "device flow unavailable: needs GitLab ≥ 17.9, a non-confidential app and `device_code` grant" |
| poll | `{origin}/oauth/token` | `client_id`, `device_code`, `grant_type=urn:ietf:params:oauth:grant-type:device_code` | token JSON | `authorization_pending` → pending; `slow_down` → +5 s (cap 60 s); `access_denied` → `denied`; `expired_token` → `expired`; `invalid_client`/`unauthorized_client` → `provider_error` naming the app configuration; anything else → `provider_error` |
| refresh | `{origin}/oauth/token` | `client_id`, `grant_type=refresh_token`, `refresh_token` (+ `redirect_uri` only if the spike shows it is mandatory) | token JSON | `invalid_grant` → `[secret_expired]` "reconnect GitLab" |

Validation (mirrors GitHub, stricter on origin):
- `verification_uri` and `verification_uri_complete`: `https:`, **same origin as `{origin}`**, path exactly `/oauth/device`.
- `expires_in` 1–3600 s for the device code; `interval` 1–60 s; token `expires_in` 1–3650 days.
- Strings capped (device_code ≤ 512, user_code ≤ 64, tokens ≤ 16 KB).

### 6.5 Client registration (decision D1)

- **gitlab.com:** one OAuth application, **non-confidential**, `device_code` grant enabled, scopes `read_api` + `api`, owned by an account the maintainer controls. Its client id would be an embedded constant like `GITHUB_OAUTH_CLIENT_ID`. Open questions: who owns it (personal vs a group), display name/homepage/avatar shown to every user on the consent page, who can rotate/disable it, what happens to existing connections if it is deleted.
- **Self-managed:** every instance needs its own application (admin or user owned). Client id comes from `VENIRA_GITLAB_OAUTH_CLIENT_ID` or `git.oauth_client_id` — **trusted config only**.
- If the owner decision is "no embedded client id", the feature becomes BYO-only; still valid, onboarding is heavier.

### 6.6 Instance and host handling

- `{origin}` = origin of the resolved GitLab `api_base` (strip `/api/v4`). Resolve with the same precedence as `gitContext()`; require **https** (existing http exceptions only for localhost/`VENIRA_GIT_ALLOW_HTTP=1`).
- The origin's host must already pass `allowedHosts()`; self-managed users add it via `VENIRA_GIT_ALLOWED_HOSTS` first. No new allow-list.
- Client id and API URL from an **untrusted** workspace `venira.config.json` are ignored (existing `isTrustedConfig()` rule) — otherwise a repo could point the flow at an attacker host and harvest a user's approval.

### 6.7 Scopes

| Venira capability | Minimum scope |
|---|---|
| `project_ci_status`, `project_ci_wait`, `project_ci_logs`, `project_pr_list` | `read_api` |
| `project_ci_trigger`, `project_ci_control`, `project_pr_create/comment/merge/close/reopen` | `api` |

`access=read` requests `read_api`; `access=write` requests `api`. Store the granted scope (from the token response / token info) in the connect result so the agent can explain a later 403 as "connected read-only; reconnect with access=write".

### 6.8 Token storage and the auth header

- Vault names: `GITLAB_TOKEN` (access, `expiresAt = created_at + expires_in`) and `GITLAB_REFRESH_TOKEN` (no expiry known), both `source: "provider"`. Matches `DEFAULTS.gitlab.secret` so `tokenFor()` already finds them — no resolver change for gitlab.com.
- Self-managed multi-instance (D4): proposal `GITLAB_TOKEN__<HOST_SLUG>` selected when the API host is not `gitlab.com` and no explicit `git.secret` is set. Confirm the slug satisfies `NAME_RE` in `lib/secrets.ts`.
- **Header (D5):** change GitLab to `Authorization: Bearer <token>` for all tokens **if** the spike confirms PATs are accepted that way; otherwise carry a `token_kind` (`pat` | `oauth`) on `GitContext` (derive from vault metadata) and choose the header per kind. Update `gitlab_redirect_strips_private_token` so cross-origin redirects drop `Authorization` as well.

### 6.9 Refresh (the hard part)

Behaviour:
1. Before `gitContext()` in `resolve()`, call a provider-keyed `ensureFreshToken(provider, secretName)`: if the access token is expired **or within 60 s of expiry**, refresh. This replaces the `GITHUB_TOKEN` string match for GitLab (GitHub can migrate later).
2. **Cross-process lock:** acquire the vault lock (v1.7.0 "secret lockfile"; confirm its API), **re-read** the secret after acquiring it (another process may have refreshed), and refresh only if still stale. Single in-process `refreshInFlight` promise stays.
3. **Persist the rotated refresh token before using the new access token**, atomically (the vault already writes temp+rename). If persistence fails after the exchange the old refresh token is dead → surface `[secret_expired]` with a reconnect hint; never retry the exchange with the old token.
4. Never log or return either token; errors carry codes only.
5. Outbound network restrictions are enforced by the OS/container/VM; the application-level `VENIRA_NETWORK` switch has been removed.

### 6.10 After connect

- `GET {origin}/api/v4/user` with the new token → return `username` and `id` in the result so the user can confirm the right account. Never return the token.
- Record granted scopes (token response `scope` or token-info endpoint [spike]).
- Run the provider secret guard over the connect response (existing behaviour for provider responses).

### 6.11 Disconnect (optional G.5)

`action: disconnect` → revoke access and refresh token at the provider [spike: endpoint], then delete both vault entries. Today GitHub has no equivalent; users revoke in the GitHub UI.

### 6.12 Error mapping

Reuse existing codes: `network_disabled`, `network_error`, `provider_error`, `already_configured`, `resource_limit`, `not_found`, `secret_expired`, `invalid_request`. Add provider-neutral hint text. Messages must never include `device_code`, `user_code` beyond the `start` result, or tokens.

### 6.13 GitLab version/capability handling

No pre-auth version endpoint is available (`/api/v4/version` needs auth), so detect by attempting `authorize_device` and mapping failure to: "Device flow unavailable. Needs GitLab 17.9 or later, a non-confidential application with the `device_code` grant. Alternative: `--setup-git gitlab` or `project_secret`." Never loop.

---

## 7. Security analysis

| Risk | Mitigation |
|---|---|
| **Device-code phishing** (user is tricked into authorizing an attacker's code) | `start` result tells the user to authorize **only a code they just saw from Venira**, to compare the `user_code` on the consent page, and to cancel otherwise. Do not auto-open `verification_uri_complete`. |
| **GitLab cross-window forgery (#476670)** | Vendor-side issue; fix status unknown [spike: check current state]. Keep the explicit code-compare instruction; do not claim the flow is immune. |
| Attacker-controlled instance (SSRF-like) | Origin must pass the allow-list and https rule; client id/API URL only from trusted config; verification URL must be same-origin and exact path. |
| Token disclosure | Tokens never in tool output, audit `command`, traces or errors; provider secret guard stays fail-closed; vault encryption unchanged. |
| Refresh-token loss/race | Cross-process lock + re-read + persist-before-use (§6.9). |
| Over-privileged token | `access=read` supported; documented default; scope echoed back. |
| Pending-state abuse | Max 4 pending (existing), expire on `expires_in`, state is in-memory only (lost on restart by design; user just starts again). |
| Polling abuse / rate limits | Honour `interval`, `slow_down` back-off, cap at 60 s; never poll faster than the server says. |
| Response tampering/huge bodies | 16 KB cap, JSON object only, `redirect: "error"`, timeouts. |
| Agent asks user to paste a token | Instruction #9 in `server.ts` already forbids it; update it to cover GitLab once the path exists. |
| Revocation after compromise | `disconnect` action (G.5) + documented manual revoke in GitLab profile → Applications. |

---

## 8. Test plan (no live credentials in the suite)

**Unit/integration — new `scripts/test-gitlab-device-flow.ts`** (mirror `scripts/test-github-device-flow.ts`; add to the `verify` chain in `package.json`):
- start: happy path; rejects wrong-origin / non-https / wrong-path `verification_uri`; rejects missing/oversized fields; rejects `expires_in` out of range; `already_configured` unless `replace_existing`; `resource_limit` at 4 pending.
- poll: `authorization_pending` → pending with `wait_seconds`; `slow_down` raises interval (+5 s, cap 60 s); `access_denied`; `expired_token`; unknown error → `provider_error`; unknown `pending_id` → `not_found`; poll before `nextPollAt` returns pending without a request.
- connected: both secrets stored with correct `expiresAt`; result contains no token; `GET /user` identity returned; granted scope returned.
- refresh: expired → new tokens saved, **rotated refresh token persisted before the access token is used**; `invalid_grant` → `[secret_expired]`; two concurrent callers → exactly one HTTP refresh; a second process (simulated by a second vault handle) re-reads and does **not** refresh again.
- encoding: request bodies are form-urlencoded (assert on the mock), scopes encoded per the spike result.
- auth header: GitLab requests carry `Authorization: Bearer` (and, if D5 keeps PAT behaviour, `PRIVATE-TOKEN` for PATs); cross-origin redirect drops the header.
- hardening: response >16 KB rejected; redirect rejected; outbound restrictions are handled by the OS/container/VM; untrusted workspace config cannot set client id / API URL.

**Mocks:** extend the GitLab mock (`scripts/git-mocks.ts`; confirm the exact file) with `/oauth/authorize_device`, `/oauth/token`, `/oauth/revoke`, `/api/v4/user` and reuse `state.fault` for 4xx/5xx/429 injection.

**Regression:** `test:github-device-flow`, `test:provider-secret-guard`, full `verify`, `check:docs`, `doctor` stay green. Remember `verify` runs `dist/`, so `npm run build` first. CI matrix (ubuntu/windows/macos × Node 20/22) must be green on the PR.

**Manual E2E checklist (once, against a real test app):** gitlab.com connect (read), connect (write), deny, let it expire, `slow_down` if reproducible, refresh after 2 h (or force expiry), revoke in GitLab UI → next call yields a reconnect hint, self-managed ≥ 17.9, self-managed < 17.9 (expect the clear unavailable message).

---

## 9. Documentation and contract updates (do in the same PR as the code)

- README: §4 tool table row; env table (`VENIRA_GITLAB_OAUTH_CLIENT_ID`, any new vars — `check:docs` verifies every documented `VENIRA_*` exists in source); GitLab onboarding section; capability matrix auth column; changelog.
- `server.ts`: instruction #9 and the connect note (L32, L52) made provider-neutral.
- Hints: `lib/git-config.ts` L323 and L491, `lib/git-http.ts` L370 — replace GitHub-only wording with provider-aware text.
- Tool description/schema in `tools/project.ts` (+ `use_when` / `avoid_when`, which `verify` checks).
- `ROADMAP.md`: Phase G status line; `TODO.md` current-state/changelog; `ROADMAP_HARDENING.md`: new S-item (e.g. S21 GitLab Device Flow) if it follows the S17 pattern.
- If D2 = B/C: update tool counts in README §4, `scripts/check-docs.ts`, `scripts/doctor.ts` together.

---

## 10. Bitbucket Cloud — decision record

**Decision: no OAuth in Phase G.**

Why: no device flow [docs]; every OAuth route needs a consumer with a client **secret** and a fixed callback URL; an npm package cannot keep a secret (RFC 8252 guidance for native apps); the alternative is bring-your-own consumer + callback handling, which is the heaviest onboarding of all and adds a listener to defend. Scopes are fixed on the consumer, refresh tokens rotate and expire after 3 months idle, and access-token lifetime documentation is inconsistent (1 h vs 2 h).

What to do instead:
1. Option A in §4: `--setup-git bitbucket` hidden prompt → vault (`BITBUCKET_TOKEN`, optional `username` for Basic as today).
2. Document the scope table already in `ROADMAP.md` E.1: repository/project/workspace access token with `pipeline` (read) and `pipeline:write` (trigger/stop).
3. Re-evaluate only if Atlassian ships a device flow, or if a real user needs BYO-consumer auth-code and accepts the callback requirement (then run a spike like §12 first).

---

## 11. Plan (each step is a gate)

| Step | Work | Output | Gate to continue |
|---|---|---|---|
| **G.0** | Demand gate: a real workflow where a GitLab PAT is not acceptable (short-lived tokens required, security policy, onboarding friction) **and** a maintainer owns/accepts the OAuth app (D1) | Written decision in this file | Both true. Without it, stop here (or do only Option A) |
| **G.1** | Spike on a live gitlab.com test app + one self-managed ≥ 17.9 instance, using the §12 checklist; **no code in `lib/`** | Findings appended to §5.1/§12; open decisions D1–D8 closed | All [spike] items resolved or consciously accepted |
| **G.2** | `lib/gitlab-device-flow.ts` + dispatch in `opGithubConnect` + tool schema (`provider`, `access`); mock endpoints; `test:gitlab-device-flow` | start/poll/connected working against mocks | Test suite green locally |
| **G.3** | Auth header change (D5), `ensureFreshToken` + lock + rotation handling, replace string-matched hook for GitLab, `GET /user` confirmation | Refresh proven by tests incl. concurrency | `verify` + CI matrix green |
| **G.4** | Docs/contracts (§9), hints, README/`check:docs`, capability matrix, changelog | Docs consistent | `check:docs`, `doctor` green |
| G.5 | Optional: `disconnect` (revoke + delete) | Action + tests | — |
| G.6 | Optional: extract shared core (`lib/oauth-device.ts`) and migrate GitHub; or independent `--setup-git` (Option A) | Less duplication | GitHub tests unchanged |

Estimates are rough sizing, not measured: G.1 S, G.2 M, G.3 M, G.4 S, G.5 S, G.6 S–M.

**Done when:** GitLab connect works end-to-end on gitlab.com and a ≥ 17.9 self-managed instance; no token ever appears in output, audit or logs; refresh survives expiry and two concurrent processes; PAT users see no behaviour change; unsupported/old instances get one clear message; full `verify`, `check:docs`, `doctor` and the cross-OS/Node CI matrix pass.

**Rollback:** the flow is additive. Remove the `provider=gitlab` branch (or ignore the new client id config); stored `GITLAB_TOKEN` entries keep working as ordinary tokens. If the Bearer-header change regresses PAT users, revert only that commit (§6.8 fallback with `token_kind`).

---

## 12. Spike checklist (G.1) — confirm each against a live instance

1. Register an application on gitlab.com: confirm **non-confidential** is selectable, the **`device_code` grant** option exists, which scopes appear, and whether a **redirect URI is still mandatory** for a device-only app.
2. `POST /oauth/authorize_device`: confirm form-urlencoded works, **space-separated vs repeated `scope`**, response fields, real `expires_in` / `interval`, and the exact `verification_uri` host/path (and `verification_uri_complete`).
3. Poll errors: HTTP status and JSON shape for `authorization_pending`, `slow_down`, `expired_token`, `access_denied`, and for a wrongly configured app (`invalid_client`/`unauthorized_client`).
4. Token response: `expires_in`, `created_at`, presence of `refresh_token`, `scope` string.
5. **Header test:** call `/api/v4/user` with an OAuth token via `Authorization: Bearer` (expect 200) and via `PRIVATE-TOKEN` (expect 401); call with a PAT via `Authorization: Bearer` (expect 200). Decides D5.
6. Refresh: confirm rotation (old refresh token rejected afterwards), whether `redirect_uri` is required, and refresh-token lifetime.
7. Revoke and token-info endpoints: exact paths, auth, responses.
8. Behaviour on self-managed 17.2–17.8 (flag state) and < 17.2 (expect 404/400) for the capability message.
9. Rate limits on `/oauth/authorize_device` and `/oauth/token`.
10. Current status of #476670 and what the consent page shows (does it display the `user_code`?).
11. Secret-name slug for self-managed hosts passes `NAME_RE`.
12. Vault lock API from `lib/secrets.ts` is usable for a cross-process refresh section.

---

## 13. Open decisions

| ID | Decision | Default proposal |
|---|---|---|
| D1 | Who owns the gitlab.com OAuth application; embed its client id in the npm package? | Maintainer-owned, embed (GitHub precedent); BYO for self-managed |
| D2 | Tool surface A / B / C (§6.2) | A, rename later |
| D3 | Default scope when `access` is omitted | `write` (`api`), `read` documented |
| D4 | Secret naming for multiple self-managed hosts | `GITLAB_TOKEN__<HOST_SLUG>` |
| D5 | `Authorization: Bearer` for all GitLab tokens vs per-kind header | All Bearer if the spike allows |
| D6 | Extract shared device-flow core now or after GitLab works | After |
| D7 | Bitbucket: build Option A (`--setup-git`) or nothing | Option A on demand |
| D8 | Minimum supported GitLab version in messages | 17.9 |

---

## 14. References

- GitLab, OAuth 2.0 identity provider API (device authorization grant, refresh, versions): https://docs.gitlab.com/api/oauth2/
- GitLab CLI authentication (device flow needs GitLab ≥ 17.9 and the `device_code` grant): https://docs.gitlab.com/cli/authentication/
- GitLab MR !155622, "Add Device Auth Support" (non-confidential app, `/oauth/authorize_device`, example payloads): https://gitlab.com/gitlab-org/gitlab/-/merge_requests/155622
- GitLab issue #476670, device flow "cross window forgery": https://gitlab.com/gitlab-org/gitlab/-/work_items/476670
- Bitbucket Cloud OAuth 2: https://developer.atlassian.com/cloud/bitbucket/oauth-2/ and https://support.atlassian.com/bitbucket-cloud/docs/use-oauth-on-bitbucket-cloud/
- Bitbucket Cloud REST API scopes: https://developer.atlassian.com/cloud/bitbucket/bitbucket-cloud-rest-api-scopes/
- RFC 8628 (OAuth 2.0 Device Authorization Grant): https://datatracker.ietf.org/doc/html/rfc8628
- RFC 8252 (OAuth 2.0 for Native Apps; secrets in distributed clients)
- In-repo: `lib/github-device-flow.ts`, `scripts/test-github-device-flow.ts`, `lib/git-config.ts`, `lib/git-http.ts`, `lib/git-provider.ts`, `ROADMAP.md` Phases E/F, `ROADMAP_HARDENING.md` S17–S19.
