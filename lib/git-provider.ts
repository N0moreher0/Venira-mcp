/**
 * GitHub provider for the coding MCP:
 *   - pull requests  (`project_pr_create`, `project_pr_comment`, `project_pr_merge`)
 *   - CI / Actions   (`project_ci_status`, `project_ci_trigger`, `project_ci_logs`)
 *
 * Deliberate choices
 * ------------------
 * - **One provider, one REST dialect.** GitHub's REST API drives both pull
 *   requests and Actions, so a single HTTPS client covers the whole surface.
 *   Nothing here shells out to `gh` (that would drag in a separate binary and
 *   leak tokens through the process table / shell audit).
 * - **The token never travels in a command string.** It is read from the
 *   encrypted secret store (`project_secret set GITHUB_TOKEN`) or, failing
 *   that, from the process env. Requests always go through `ghFetch`, which
 *   attaches it as a header and strips it on cross-origin redirects (GitHub
 *   redirects log downloads to a pre-signed Azure blob: sending the token
 *   there would leak it into a third party's access log).
 * - **Repo is resolved, not guessed.** `repo` arg → `VENIRA_GITHUB_REPO` →
 *   `.git/config` `[remote "origin"]`. Owner/name are validated against
 *   `[A-Za-z0-9._-]` so a crafted value cannot inject a path or query.
 * - **Bounded I/O.** Every request has a timeout, redirects are capped at 5, log
 *   archives are capped while downloading and while unzipping (we parse the ZIP
 *   ourselves: no zip library, no extraction to disk, no zip-slip).
 * - **Errors are action shaped.** Each failure carries a code + a "what to do
 *   next" hint, so an agent can recover without reading GitHub docs.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import zlib from "node:zlib";
import { WORKSPACE } from "./workspace.js";
import { getSecretMeta, getSecretValueSync, markSecretUsed } from "./secrets.js";

type Resp = {
  status?: string;
  truncated?: boolean;
  hint?: string;
  result?: { kind?: string; data?: unknown };
};

const API_DEFAULT = "https://api.github.com";
const USER_AGENT = "venira-mcp-coding (+https://github.com/N0moreher0/Venira-mcp)";
const REQUEST_TIMEOUT_MS = 60_000;
const LOG_TIMEOUT_MS = 90_000;
const LOG_ZIP_MAX_BYTES = 32 * 1024 * 1024;
const LOG_ENTRY_MAX_BYTES = 4 * 1024 * 1024;
const LOG_TEXT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_BYTES = 512 * 1024;
const HARD_MAX_BYTES = 4 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const SEGMENT_RE = /^[A-Za-z0-9._-]{1,100}$/;

// ---------------------------------------------------------------------------
// Environment / token
// ---------------------------------------------------------------------------

/** `VENIRA_NETWORK=0` is a hard kill switch for every outbound call. */
export function networkEnabled(): boolean {
  const raw = (process.env.VENIRA_NETWORK ?? "1").trim().toLowerCase();
  return !["0", "false", "off", "no"].includes(raw);
}

function isLocalHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

/** API base URL; https only, except a localhost http URL (mock/test servers). */
export function apiBaseUrl(): string {
  const raw = (process.env.VENIRA_GITHUB_API_URL ?? API_DEFAULT).trim().replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(
      `[invalid_request] VENIRA_GITHUB_API_URL is not a URL: "${raw}". Hint: use https://api.github.com or https://<ghe-host>/api/v3.`,
    );
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocalHost(url.hostname)) && process.env.VENIRA_GITHUB_ALLOW_HTTP !== "1") {
    throw new Error(
      `[invalid_request] VENIRA_GITHUB_API_URL must be https (got ${url.protocol}//${url.host}). ` +
        `Hint: tokens must never travel over plaintext; use https.`,
    );
  }
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
}

type TokenOrigin = "secret" | "env:VENIRA_GITHUB_TOKEN" | "env:GITHUB_TOKEN" | "env:GH_TOKEN" | "missing";

function resolveToken(): { token: string | null; origin: TokenOrigin } {
  // Rotation metadata is checked *before* decryption: an expired token must
  // fail with an actionable error, not reach GitHub and come back as 401.
  let meta;
  try {
    meta = getSecretMeta("GITHUB_TOKEN");
  } catch {
    meta = undefined; // store locked/corrupt: fall through to env
  }
  if (meta) {
    if (meta.expired) {
      const at = meta.expires_at === null ? "unknown" : new Date(meta.expires_at).toISOString();
      throw new Error(
        `[secret_expired] Secret "GITHUB_TOKEN" expired at ${at}. ` +
          `Hint: rotate it with project_secret action=set name=GITHUB_TOKEN value=<new token> (add expires_in_days to track the next rotation).`,
      );
    }
    try {
      const secret = getSecretValueSync("GITHUB_TOKEN");
      if (secret && secret.trim()) {
        void markSecretUsed("GITHUB_TOKEN", "provider").catch(() => undefined);
        return { token: secret.trim(), origin: "secret" };
      }
    } catch {
      /* decryption failed: fall through to env */
    }
  }
  for (const [name, origin] of [
    ["VENIRA_GITHUB_TOKEN", "env:VENIRA_GITHUB_TOKEN"],
    ["GITHUB_TOKEN", "env:GITHUB_TOKEN"],
    ["GH_TOKEN", "env:GH_TOKEN"],
  ] as const) {
    const value = (process.env[name] ?? "").trim();
    if (value) return { token: value, origin };
  }
  return { token: null, origin: "missing" };
}

function requireToken(): string {
  const { token } = resolveToken();
  if (!token) {
    throw new Error(
      "[auth_missing] No GitHub token available. " +
        "Hint: run project_secret action=set name=GITHUB_TOKEN value=<token> (repository scope: repo), " +
        "or export VENIRA_GITHUB_TOKEN.",
    );
  }
  return token;
}

// ---------------------------------------------------------------------------
// Repo resolution (arg → env → .git/config origin)
// ---------------------------------------------------------------------------

export type RepoRef = { owner: string; name: string };

/** Accept `owner/name`, `https://github.com/owner/name(.git)`, `git@host:owner/name.git`. */
export function parseRepoRef(raw: string, source: string): RepoRef {
  const text = raw.trim().replace(/\.git$/i, "");
  if (!text) {
    throw new Error(`[repo_unresolved] Empty repo reference from ${source}.`);
  }
  let owner: string;
  let name: string;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      throw new Error(`[repo_unresolved] Cannot parse repo URL from ${source}: "${raw}".`);
    }
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 2) {
      throw new Error(
        `[repo_unresolved] URL from ${source} has no owner/name: "${raw}". Hint: pass repo="owner/name".`,
      );
    }
    owner = parts[parts.length - 2];
    name = parts[parts.length - 1];
  } else if (/^[\w.-]+@[\w.-]+:/.test(text)) {
    const tail = text.slice(text.indexOf(":") + 1);
    const parts = tail.split("/").filter(Boolean);
    if (parts.length < 2) {
      throw new Error(`[repo_unresolved] Cannot parse "${raw}" from ${source}. Hint: pass repo="owner/name".`);
    }
    owner = parts[parts.length - 2];
    name = parts[parts.length - 1];
  } else {
    const parts = text.split("/").filter(Boolean);
    if (parts.length !== 2) {
      throw new Error(
        `[repo_unresolved] Expected "owner/name" from ${source}, got "${raw}". Hint: repo="owner/name" (no URL path, no spaces).`,
      );
    }
    owner = parts[0];
    name = parts[1];
  }
  if (!SEGMENT_RE.test(owner) || !SEGMENT_RE.test(name)) {
    throw new Error(
      `[repo_unresolved] Invalid owner/name from ${source}: "${owner}/${name}". ` +
        `Hint: names may only contain letters, digits, dot, dash and underscore.`,
    );
  }
  return { owner, name };
}

/** Resolve `<root>/.git` (directory, or a `gitdir:` file for worktrees). */
function gitDirOf(root: string): string | null {
  const dotGit = path.join(root, ".git");
  try {
    if (!existsSync(dotGit)) return null;
    const stat = statSync(dotGit);
    if (stat.isDirectory()) return dotGit;
    if (stat.isFile()) {
      const text = readFileSync(dotGit, "utf8");
      const match = /^gitdir:\s*(.+)$/m.exec(text);
      if (match) return path.resolve(root, match[1].trim());
    }
  } catch {
    /* unreadable .git: treat as no repo */
  }
  return null;
}

/** Worktrees keep the shared config in `commondir` (usually `../..`). */
function gitConfigPath(gitDir: string): string | null {
  const own = path.join(gitDir, "config");
  if (existsSync(own)) return own;
  try {
    const common = readFileSync(path.join(gitDir, "commondir"), "utf8").trim();
    if (common) {
      const shared = path.resolve(gitDir, common, "config");
      if (existsSync(shared)) return shared;
    }
  } catch {
    /* no commondir: not a worktree */
  }
  return null;
}

/** Read `[remote "origin"] url` without shelling out to git. */
function readOriginUrl(root: string): string | null {
  const gitDir = gitDirOf(root);
  if (!gitDir) return null;
  const config = gitConfigPath(gitDir);
  if (!config) return null;
  try {
    let section = "";
    for (const line of readFileSync(config, "utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) continue;
      const header = /^\[([^\]]+)\]$/.exec(trimmed);
      if (header) {
        section = header[1].trim().toLowerCase().replace(/"/g, "");
        continue;
      }
      if (section !== "remote origin") continue;
      const eq = trimmed.indexOf("=");
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim().toLowerCase();
      const value = trimmed.slice(eq + 1).trim();
      if (key === "url" && value) return value;
    }
  } catch {
    /* malformed config */
  }
  return null;
}

export function resolveRepo(args: Record<string, unknown> = {}): RepoRef & { source: string } {
  const explicit = typeof args.repo === "string" ? args.repo.trim() : "";
  if (explicit) {
    const parsed = parsePrOrRepo(explicit);
    if (parsed) return { ...parsed, source: "arg" };
  }
  const env = (process.env.VENIRA_GITHUB_REPO ?? "").trim();
  if (env) {
    const parsed = parsePrOrRepo(env);
    if (parsed) return { ...parsed, source: "env" };
  }
  const origin = readOriginUrl(WORKSPACE);
  if (origin) return { ...parseRepoRef(origin, ".git/config origin"), source: "git" };
  throw new Error(
    "[repo_unresolved] No GitHub repository found. " +
      "Hint: pass repo=\"owner/name\", set VENIRA_GITHUB_REPO, or add an `origin` remote with a github.com URL.",
  );
}

/** `owner/name` or a pull/issue URL (`.../owner/name/pull/7`). */
function parsePrOrRepo(raw: string): RepoRef | null {
  const pull = /\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/(?:pull|issues)\/(\d+)(?:[/?#]|$)/i.exec(raw);
  if (pull && SEGMENT_RE.test(pull[1]) && SEGMENT_RE.test(pull[2])) {
    return { owner: pull[1], name: pull[2] };
  }
  return parseRepoRef(raw, "argument");
}

/** Current branch name from `HEAD` (works for worktrees too). */
export function currentBranch(root = WORKSPACE): string | null {
  const gitDir = gitDirOf(root);
  if (!gitDir) return null;
  try {
    const head = readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
    const match = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

const defaultBranchCache = new Map<string, { at: number; branch: string }>();
const DEFAULT_BRANCH_TTL_MS = 5 * 60 * 1000;

async function repoDefaultBranch(repo: RepoRef): Promise<string> {
  const key = `${repo.owner}/${repo.name}`.toLowerCase();
  const hit = defaultBranchCache.get(key);
  if (hit && Date.now() - hit.at < DEFAULT_BRANCH_TTL_MS) return hit.branch;
  try {
    const res = await ghJson("GET", `/repos/${repo.owner}/${repo.name}`, { allowAnonymous: true });
    const branch = typeof res.json?.default_branch === "string" ? res.json.default_branch : "";
    if (branch) {
      defaultBranchCache.set(key, { at: Date.now(), branch });
      return branch;
    }
  } catch {
    /* fall through to a conservative default */
  }
  return "main";
}

// ---------------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------------

type FetchOpts = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  timeoutMs?: number;
  accept?: string;
  /** GETs may run anonymously (public repos); mutations never do. */
  allowAnonymous?: boolean;
  headers?: Record<string, string>;
  /** Response cap in bytes (logs are larger than JSON). */
  maxBytes?: number;
};

type RawHeaders = Record<string, string | string[] | undefined>;

type RawResult = {
  status: number;
  headers: RawHeaders;
  url: string;
  buffer: Buffer;
};

const JSON_MAX_BYTES = 8 * 1024 * 1024;

function safeUrl(target: string): URL | null {
  try {
    const url = new URL(target);
    if (url.protocol === "https:") return url;
    if (url.protocol === "http:" && isLocalHost(url.hostname)) return url;
    return null;
  } catch {
    return null;
  }
}

function headerValue(headers: RawHeaders, name: string): string | null {
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

/**
 * One HTTP round trip via `node:http(s)` — deliberately not global `fetch`:
 * we need manual redirects (token hygiene), a hard response-size cap and
 * predictable socket timeouts, and the http module keeps the process free of
 * a large global dispatcher.
 */
function requestOnce(
  method: string,
  url: URL,
  headers: Record<string, string>,
  payload: string | undefined,
  timeoutMs: number,
  maxBytes: number,
): Promise<RawResult> {
  const transport = url.protocol === "https:" ? https : http;
  return new Promise<RawResult>((resolve, reject) => {
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    const request = transport.request(url, { method, headers }, (response: http.IncomingMessage) => {
      const chunks: Buffer[] = [];
      let total = 0;
      let overflow = false;
      response.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (total > maxBytes) {
          overflow = true;
          return;
        }
        chunks.push(chunk);
      });
      response.on("error", (error: Error) =>
        done(() => reject(new Error(`[network_error] Response failed: ${error.message}. Hint: retry.`))),
      );
      response.on("end", () =>
        done(() => {
          if (overflow) {
            reject(
              new Error(
                `[resource_limit] Response from ${url.pathname} exceeded ${Math.round(maxBytes / 1024 / 1024)}MB. ` +
                  `Hint: pass job_id to fetch a single job, or lower max_bytes.`,
              ),
            );
            return;
          }
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers as RawHeaders,
            url: url.toString(),
            buffer: Buffer.concat(chunks),
          });
        }),
      );
    });
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error("__venira_timeout__"));
    });
    request.on("error", (error: Error) => {
      const message = error instanceof Error ? error.message : String(error);
      done(() => {
        if (message === "__venira_timeout__") {
          reject(
            new Error(
              `[timeout] GitHub request timed out after ${Math.round(timeoutMs / 1000)}s (${url.pathname}). ` +
                `Hint: retry, or narrow the query.`,
            ),
          );
          return;
        }
        reject(new Error(`[network_error] Cannot reach ${url.host}: ${message}. Hint: check connectivity/proxy, then retry.`));
      });
    });
    if (payload !== undefined) request.write(payload);
    request.end();
  });
}

function apiError(status: number, body: string, headers: RawHeaders, target: string): Error {
  let message = "";
  let detail = "";
  try {
    const parsed = JSON.parse(body) as { message?: string; errors?: Array<{ message?: string; code?: string }> };
    message = typeof parsed.message === "string" ? parsed.message : "";
    detail = (parsed.errors ?? []).map((e) => e.message ?? e.code ?? "").filter(Boolean).join("; ");
  } catch {
    message = body.slice(0, 200);
  }
  const suffix = detail ? ` (${detail})` : "";

  if (status === 401) {
    return new Error(
      `[auth_failed] GitHub rejected the token (401)${suffix}. Hint: the token is invalid or expired; ` +
        `run project_secret action=set name=GITHUB_TOKEN value=<new token>.`,
    );
  }
  if (status === 403 || status === 429) {
    const remaining = headerValue(headers, "x-ratelimit-remaining");
    const reset = Number(headerValue(headers, "x-ratelimit-reset") ?? 0);
    const retry = Number(headerValue(headers, "retry-after") ?? 0);
    if ((remaining !== null && remaining === "0") || status === 429) {
      const when = reset ? new Date(reset * 1000).toISOString() : retry ? `in ${retry}s` : "later";
      return new Error(
        `[rate_limited] GitHub API rate limit reached (${target}). Hint: retry after ${when}, ` +
          `or use a token with a higher limit.`,
      );
    }
    return new Error(
      `[forbidden] GitHub refused the request (403)${suffix}. Hint: the token lacks the required scope ` +
        `(pull requests need \`repo\`; workflows need \`workflow\`).`,
    );
  }
  if (status === 404) {
    return new Error(
      `[not_found] GitHub returned 404 for ${target}${suffix}. Hint: check repo/branch/PR number; ` +
        `private repos need a token with \`repo\` scope.`,
    );
  }
  if (status === 409) {
    return new Error(
      `[conflict] Merge conflict (409)${suffix}. Hint: the base branch moved or the PR has conflicts; ` +
        `update the branch, then retry project_pr_merge.`,
    );
  }
  if (status === 405) {
    return new Error(`[conflict] Not mergeable (405)${suffix}. Hint: the PR may be draft, closed, or blocked by branch protection.`);
  }
  if (status === 422) {
    return new Error(`[invalid_request] GitHub rejected the request (422)${suffix}. Hint: ${message || "check the field values."}`);
  }
  if (status >= 500) {
    return new Error(
      `[provider_error] GitHub is unavailable (${status})${suffix}. Hint: transient; retry in a few seconds.`,
    );
  }
  return new Error(`[provider_error] GitHub returned ${status} for ${target}${suffix}. Hint: ${message || "unexpected response."}`);
}

/**
 * One request with manual redirect handling: the token is attached only while
 * the request still targets the API host, so GitHub's 302 to a pre-signed log
 * blob never carries our credentials to the storage host.
 */
async function ghFetch(apiPath: string, opts: FetchOpts = {}): Promise<RawResult> {
  if (!networkEnabled()) {
    throw new Error(
      "[network_disabled] Outbound network access is disabled (VENIRA_NETWORK=0). Hint: set VENIRA_NETWORK=1 to allow GitHub calls.",
    );
  }
  if (!apiPath.startsWith("/")) {
    throw new Error(`[invalid_request] GitHub path must start with "/" (got "${apiPath}").`);
  }
  const base = apiBaseUrl();
  const apiOrigin = new URL(base).origin;
  const { token } = resolveToken();
  if (!token && !opts.allowAnonymous) requireToken();

  const method = opts.method ?? (opts.body !== undefined ? "POST" : "GET");
  const payload = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
  const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? JSON_MAX_BYTES;

  let target = `${base}${apiPath}`;
  let sendAuth = true;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const url = safeUrl(target);
    if (!url) {
      throw new Error(
        `[network_blocked] Refusing a non-https request to ${target}. Hint: GitHub must be reached over https.`,
      );
    }
    const headers: Record<string, string> = {
      Accept: opts.accept ?? "application/vnd.github+json",
      "User-Agent": USER_AGENT,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(opts.headers ?? {}),
    };
    if (payload !== undefined) headers["Content-Type"] = "application/json";
    if (token && sendAuth && url.origin === apiOrigin) headers.Authorization = `Bearer ${token}`;

    const res = await requestOnce(method, url, headers, payload, timeoutMs, maxBytes);

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = headerValue(res.headers, "location");
      if (!location) {
        throw new Error(`[provider_error] GitHub redirect (${res.status}) without a Location header.`);
      }
      const next = new URL(location, url);
      if (next.origin !== apiOrigin) sendAuth = false;
      // GitHub only redirects downloads (GET); a redirected write is a bug.
      if (method !== "GET") {
        throw new Error(`[provider_error] Unexpected redirect for ${method} ${url.pathname} -> ${next.host}.`);
      }
      target = next.toString();
      continue;
    }

    if (res.status >= 400) throw apiError(res.status, res.buffer.toString("utf8"), res.headers, `${method} ${url.pathname}`);
    return res;
  }
  throw new Error("[provider_error] Too many GitHub redirects. Hint: check VENIRA_GITHUB_API_URL; retry later.");
}

async function ghJson(
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  apiPath: string,
  opts: FetchOpts = {},
): Promise<{ status: number; json: any }> {
  const res = await ghFetch(apiPath, { ...opts, method });
  const raw = res.buffer.toString("utf8");
  let json: any = null;
  if (raw.trim()) {
    try {
      json = JSON.parse(raw);
    } catch {
      json = null;
    }
  }
  return { status: res.status, json };
}

// ---------------------------------------------------------------------------
// Argument helpers
// ---------------------------------------------------------------------------

function text(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === "string" ? value.trim() : "";
}

function requireText(args: Record<string, unknown>, key: string, hint: string): string {
  const value = text(args, key);
  if (!value) throw new Error(`[invalid_request] \`${key}\` is required. Hint: ${hint}`);
  return value;
}

function prNumberFrom(args: Record<string, unknown>, key = "pr"): number {
  const raw = args[key];
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  if (typeof raw === "string") {
    const direct = Number(raw.trim());
    if (Number.isFinite(direct) && direct > 0) return Math.floor(direct);
    const match = /\/(?:pull|issues)\/(\d+)(?:[/?#]|$)/.exec(raw);
    if (match) return Number(match[1]);
  }
  throw new Error(
    `[invalid_request] \`${key}\` must be a PR number or a pull-request URL. Hint: e.g. pr=12 or pr="https://github.com/owner/name/pull/12".`,
  );
}

function ok(kind: string, data: unknown, extra: { hint?: string; truncated?: boolean } = {}): Resp {
  return {
    status: "completed",
    result: { kind, data },
    ...(extra.hint ? { hint: extra.hint } : {}),
    ...(extra.truncated ? { truncated: true } : {}),
  };
}

function positiveInt(value: unknown, fallback: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(max, Math.floor(n));
}

function tailLines(content: string, lines: number): { text: string; dropped: number } {
  // A trailing newline would otherwise make the "last line" empty.
  const body = content.replace(/\r?\n$/, "");
  const parts = body.split(/\r?\n/);
  if (parts.length <= lines) return { text: body, dropped: 0 };
  return { text: parts.slice(-lines).join("\n"), dropped: parts.length - lines };
}

function tailBytes(content: string, maxBytes: number): { text: string; dropped: number } {
  const buf = Buffer.from(content, "utf8");
  if (buf.length <= maxBytes) return { text: content, dropped: 0 };
  // Cut on a UTF-8 boundary: drop partial leading bytes.
  let start = buf.length - maxBytes;
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start += 1;
  return { text: buf.subarray(start).toString("utf8"), dropped: start };
}

function summarizeRun(run: any): Record<string, unknown> {
  return {
    id: run?.id ?? null,
    name: run?.name ?? run?.workflow_name ?? null,
    run_number: run?.run_number ?? null,
    status: run?.status ?? null,
    conclusion: run?.conclusion ?? null,
    event: run?.event ?? null,
    branch: run?.head_branch ?? null,
    sha: run?.head_sha ? String(run.head_sha).slice(0, 12) : null,
    created_at: run?.created_at ?? null,
    updated_at: run?.updated_at ?? null,
    url: run?.html_url ?? null,
    attempt: run?.run_attempt ?? null,
  };
}

function summarizeJob(job: any): Record<string, unknown> {
  return {
    id: job?.id ?? null,
    name: job?.name ?? null,
    status: job?.status ?? null,
    conclusion: job?.conclusion ?? null,
    started_at: job?.started_at ?? null,
    completed_at: job?.completed_at ?? null,
    url: job?.html_url ?? null,
    runner: job?.runner_name ?? null,
  };
}

function summarizeCheckRun(check: any): Record<string, unknown> {
  const output = check?.output ?? {};
  return {
    id: check?.id ?? null,
    name: check?.name ?? null,
    status: check?.status ?? null,
    conclusion: check?.conclusion ?? null,
    started_at: check?.started_at ?? null,
    completed_at: check?.completed_at ?? null,
    url: check?.html_url ?? check?.details_url ?? null,
    app: check?.app?.name ?? null,
    summary: typeof output.title === "string" ? output.title.slice(0, 160) : null,
  };
}

/** Branch-protection checks (check-runs API), not Actions workflow runs. */
function overallFromChecks(checks: Array<Record<string, unknown>>): string {
  if (checks.length === 0) return "no_checks";
  const active = checks.some((c) => ["queued", "in_progress", "requested", "waiting", "pending"].includes(String(c.status)));
  if (active) return "in_progress";
  const failed = checks.some((c) =>
    ["failure", "timed_out", "cancelled", "startup_failure", "action_required", "neutral"].includes(String(c.conclusion)),
  );
  return failed ? "failure" : "success";
}

function overallFrom(runs: Array<Record<string, unknown>>): string {
  if (runs.length === 0) return "no_runs";
  const active = runs.some((r) => r.status === "in_progress" || r.status === "queued" || r.status === "requested" || r.status === "waiting");
  if (active) return "in_progress";
  const failed = runs.some((r) => ["failure", "timed_out", "cancelled", "startup_failure", "action_required"].includes(String(r.conclusion)));
  return failed ? "failure" : "success";
}

/**
 * Resolve a PR's head sha. GitHub requires `commit_id` for review comments that
 * use `line` (a bare `line` is rejected with 422 "line is not a permitted
 * key"), and check-runs are addressed by sha, so both paths share this lookup.
 */
async function pullHeadSha(basePath: string, pr: number, hint: string): Promise<string> {
  const pull = await ghJson("GET", `${basePath}/pulls/${pr}`, { allowAnonymous: true });
  const sha = String(pull.json?.head?.sha ?? "");
  if (!sha) {
    throw new Error(`[not_found] PR ${pr} has no head sha (closed or fork-only?). Hint: ${hint}`);
  }
  return sha;
}

// ---------------------------------------------------------------------------
// Pull requests
// ---------------------------------------------------------------------------

export async function opPrCreate(args: Record<string, unknown>): Promise<Resp> {
  const repo = resolveRepo(args);
  const title = requireText(args, "title", "pass title=\"...\" (one line, imperative).");
  const head = text(args, "head") || currentBranch();
  if (!head) {
    throw new Error(
      "[detached_head] Cannot infer the PR head branch (detached HEAD). Hint: pass head=\"feature-branch\".",
    );
  }
  const base = text(args, "base") || (await repoDefaultBranch(repo));
  const body = typeof args.body === "string" ? args.body : "";
  const draft = args.draft === true;

  let json: any;
  try {
    ({ json } = await ghJson("POST", `/repos/${repo.owner}/${repo.name}/pulls`, {
      body: { title, head, base, body, draft },
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/already exists/i.test(message)) {
      throw new Error(
        `[already_exists] A pull request for ${head} -> ${base} already exists. ` +
          `Hint: use project_pr_comment with the existing PR number, or project_ci_status to inspect it.`,
      );
    }
    throw error;
  }
  return ok("pr_create", {
    repo: `${repo.owner}/${repo.name}`,
    number: json?.number ?? null,
    url: json?.html_url ?? null,
    title: json?.title ?? title,
    state: json?.state ?? "open",
    draft: json?.draft ?? draft,
    head: json?.head?.ref ?? head,
    base: json?.base?.ref ?? base,
    created: true,
  });
}

export async function opPrComment(args: Record<string, unknown>): Promise<Resp> {
  const repo = resolveRepo(args);
  const pr = prNumberFrom(args, "pr");
  const body = requireText(args, "body", "pass body=\"...\" (markdown is fine).");
  const repoLabel = `${repo.owner}/${repo.name}`;
  const base = `/repos/${repo.owner}/${repo.name}`;
  const filePath = text(args, "path");

  // Inline review comment: `path` + `line` switch to the review-comment API,
  // which pins the note to a file/line in the "Files changed" tab. A general
  // comment (no path) still uses the issue-comment API.
  if (!filePath) {
    if (args.line !== undefined || args.start_line !== undefined) {
      throw new Error(
        "[invalid_request] `line`/`start_line` need `path` (inline comments are anchored to a file). " +
          "Hint: pass path=\"src/app.ts\" and line=42, or drop line for a general PR comment.",
      );
    }
    const { json } = await ghJson("POST", `${base}/issues/${pr}/comments`, { body: { body } });
    return ok("pr_comment", {
      repo: repoLabel,
      pr,
      inline: false,
      comment_id: json?.id ?? null,
      url: json?.html_url ?? null,
      created_at: json?.created_at ?? null,
      body_chars: body.length,
    });
  }

  const line = Number(args.line);
  if (!Number.isFinite(line) || line <= 0) {
    throw new Error(
      "[invalid_request] `line` must be a positive line number when `path` is set. " +
        "Hint: use project_read_ranges to confirm the line, then comment on it.",
    );
  }
  const side = (text(args, "side") || "RIGHT").toUpperCase();
  if (!["RIGHT", "LEFT"].includes(side)) {
    throw new Error(
      `[invalid_request] \`side\` must be RIGHT (new code) or LEFT (deleted code), got "${side}".`,
    );
  }
  const startLine = Number(args.start_line ?? 0);
  if (startLine > 0 && startLine > line) {
    throw new Error("[invalid_request] `start_line` must be <= `line` (GitHub anchors the range as start_line..line).");
  }

  const payload: Record<string, unknown> = { body, path: filePath, line: Math.floor(line), side };
  if (startLine > 0) {
    payload.start_line = Math.floor(startLine);
    payload.start_side = side;
  }
  // GitHub requires `commit_id` whenever `line` is used (a bare `line` is
  // rejected with 422 "line is not a permitted key"), so default to the PR head
  // sha instead of making every caller look it up.
  const commitId =
    text(args, "commit_id") || (await pullHeadSha(base, pr, 'pass commit_id="<sha>" explicitly.'));
  payload.commit_id = commitId;
  const { json } = await ghJson("POST", `${base}/pulls/${pr}/comments`, { body: payload });
  return ok("pr_comment", {
    repo: repoLabel,
    pr,
    inline: true,
    path: filePath,
    line: Math.floor(line),
    ...(startLine > 0 ? { start_line: Math.floor(startLine) } : {}),
    side,
    commit_id: commitId,
    comment_id: json?.id ?? null,
    url: json?.html_url ?? null,
    created_at: json?.created_at ?? null,
    body_chars: body.length,
  });
}

export async function opPrMerge(args: Record<string, unknown>): Promise<Resp> {
  const repo = resolveRepo(args);
  const pr = prNumberFrom(args, "pr");
  const methodRaw = text(args, "method") || "merge";
  if (!["merge", "squash", "rebase"].includes(methodRaw)) {
    throw new Error(
      `[invalid_request] \`method\` must be merge|squash|rebase (got "${methodRaw}"). Hint: use method="squash" for one commit.`,
    );
  }
  const commitTitle = text(args, "commit_title");
  const commitMessage = typeof args.commit_message === "string" ? args.commit_message : "";

  const repoLabel = `${repo.owner}/${repo.name}`;
  const pull = await ghJson("GET", `/repos/${repo.owner}/${repo.name}/pulls/${pr}`, { allowAnonymous: true });
  const state = String(pull.json?.state ?? "");
  const alreadyMerged = pull.json?.merged === true;
  if (alreadyMerged || state === "closed") {
    return ok("pr_merge", {
      repo: repoLabel,
      pr,
      merged: alreadyMerged,
      already_merged: alreadyMerged,
      state,
      method: methodRaw,
      sha: pull.json?.merge_commit_sha ?? null,
      head: pull.json?.head?.ref ?? null,
      base: pull.json?.base?.ref ?? null,
    }, { hint: alreadyMerged ? "Already merged; nothing changed." : "The PR is closed, not merged." });
  }
  if (pull.json?.mergeable === false) {
    throw new Error(
      `[conflict] PR #${pr} is not mergeable. Hint: resolve conflicts locally, push, then retry project_pr_merge.`,
    );
  }

  const { json } = await ghJson("PUT", `/repos/${repo.owner}/${repo.name}/pulls/${pr}/merge`, {
    body: {
      merge_method: methodRaw,
      ...(commitTitle ? { commit_title: commitTitle } : {}),
      ...(commitMessage ? { commit_message: commitMessage } : {}),
    },
  });
  const merged = json?.merged === true;
  const headRef = typeof pull.json?.head?.ref === "string" ? pull.json.head.ref : "";
  const baseRef = typeof pull.json?.base?.ref === "string" ? pull.json.base.ref : "";
  const sameRepo = String(pull.json?.head?.repo?.full_name ?? "").toLowerCase() === repoLabel.toLowerCase();

  let branchDeleted = false;
  let branchNote: string | null = null;
  if (merged && args.delete_branch === true && headRef && sameRepo) {
    const defaultBranch = await repoDefaultBranch(repo);
    if (headRef === defaultBranch || headRef === baseRef) {
      branchNote = `kept ${headRef}: it is the base/default branch.`;
    } else {
      try {
        await ghJson("DELETE", `/repos/${repo.owner}/${repo.name}/git/refs/heads/${headRef}`);
        branchDeleted = true;
      } catch (error) {
        // Best effort: a branch protection rule or an auto-delete setting must
        // not turn a successful merge into an error.
        branchNote = `branch not deleted: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`;
      }
    }
  }

  return ok("pr_merge", {
    repo: repoLabel,
    pr,
    merged,
    method: methodRaw,
    sha: json?.sha ?? null,
    message: json?.message ?? null,
    head: headRef || null,
    base: baseRef || null,
    branch_deleted: branchDeleted,
    ...(branchNote ? { note: branchNote } : {}),
  });
}

// ---------------------------------------------------------------------------
// CI (GitHub Actions)
// ---------------------------------------------------------------------------

export async function opCiStatus(args: Record<string, unknown>): Promise<Resp> {
  const repo = resolveRepo(args);
  const base = `/repos/${repo.owner}/${repo.name}`;
  const runId = Number(args.run_id ?? 0);

  // Check-runs mode: `ref` (branch/sha) or `pr` (resolved to its head sha).
  // This is the branch-protection surface, separate from Actions workflow runs.
  const refText = text(args, "ref");
  if (refText || args.pr !== undefined) {
    let targetRef = refText;
    let prNumber: number | null = null;
    if (!targetRef) {
      prNumber = prNumberFrom(args, "pr");
      targetRef = await pullHeadSha(base, prNumber, 'pass ref="<sha>" instead.');
    }
    if (!/^[A-Za-z0-9._/-]{1,200}$/.test(targetRef) || targetRef.includes("..")) {
      throw new Error(
        `[invalid_request] \`ref\` must be a branch name or commit sha (letters, digits, . _ / -), got "${targetRef}".`,
      );
    }
    const perPage = positiveInt(args.limit, 20, 50);
    const { json } = await ghJson("GET", `${base}/commits/${targetRef}/check-runs?per_page=${perPage}`, {
      allowAnonymous: true,
    });
    const checkRuns = ((json?.check_runs ?? []) as any[]).map(summarizeCheckRun);
    const overall = overallFromChecks(checkRuns);
    return ok(
      "ci_status",
      {
        repo: `${repo.owner}/${repo.name}`,
        source: "check-runs",
        overall,
        ref: targetRef,
        pr: prNumber,
        check_runs: checkRuns,
        check_runs_total: json?.total_count ?? checkRuns.length,
      },
      {
        hint:
          checkRuns.length === 0
            ? "No check-runs for this ref (the repo may not use checks, or the ref has no pushed commit). Hint: use branch/workflow to read Actions runs instead."
            : undefined,
      },
    );
  }

  if (runId > 0) {
    if (!Number.isFinite(runId)) {
      throw new Error("[invalid_request] `run_id` must be a numeric workflow-run id.");
    }
    const { json } = await ghJson("GET", `${base}/actions/runs/${Math.floor(runId)}`, { allowAnonymous: true });
    const jobsRes = await ghJson("GET", `${base}/actions/runs/${Math.floor(runId)}/jobs?per_page=50`, {
      allowAnonymous: true,
    });
    const jobs = ((jobsRes.json?.jobs ?? []) as any[]).map(summarizeJob);
    return ok("ci_status", {
      repo: `${repo.owner}/${repo.name}`,
      overall: overallFrom([summarizeRun(json)]),
      run: summarizeRun(json),
      jobs,
      jobs_total: jobs.length,
    });
  }

  const limit = positiveInt(args.limit, 10, 50);
  const branch = text(args, "branch");
  const workflow = text(args, "workflow");
  const query = new URLSearchParams({ per_page: String(limit) });
  if (branch) query.set("branch", branch);
  const path = workflow
    ? `${base}/actions/workflows/${encodeURIComponent(workflow)}/runs?${query.toString()}`
    : `${base}/actions/runs?${query.toString()}`;

  const { json } = await ghJson("GET", path, { allowAnonymous: true });
  const runs = ((json?.workflow_runs ?? []) as any[]).map(summarizeRun);
  return ok(
    "ci_status",
    {
      repo: `${repo.owner}/${repo.name}`,
      overall: overallFrom(runs),
      branch: branch || null,
      workflow: workflow || null,
      total_count: json?.total_count ?? runs.length,
      runs,
    },
    { hint: runs.length === 0 ? "No runs matched. Hint: pass branch/workflow, or trigger one with project_ci_trigger." : undefined },
  );
}

export async function opCiTrigger(args: Record<string, unknown>): Promise<Resp> {
  const repo = resolveRepo(args);
  const workflow = requireText(
    args,
    "workflow",
    "pass the workflow file name or id, e.g. workflow=\"ci.yml\" (see .github/workflows/).",
  );
  const ref = text(args, "ref") || currentBranch() || (await repoDefaultBranch(repo));

  let inputs: Record<string, string> = {};
  if (args.inputs !== undefined && args.inputs !== null) {
    if (typeof args.inputs !== "object" || Array.isArray(args.inputs)) {
      throw new Error("[invalid_request] `inputs` must be an object of string values.");
    }
    const entries = Object.entries(args.inputs as Record<string, unknown>);
    if (entries.length > 10) {
      throw new Error("[invalid_request] Too many workflow `inputs` (max 10).");
    }
    for (const [key, value] of entries) {
      if (!/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(key)) {
        throw new Error(`[invalid_request] Workflow input name "${key}" is invalid.`);
      }
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        inputs[key] = String(value);
      } else {
        throw new Error(`[invalid_request] Workflow input "${key}" must be a string, number or boolean.`);
      }
    }
  }

  await ghJson("POST", `/repos/${repo.owner}/${repo.name}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, {
    body: { ref, inputs },
  });

  return ok("ci_trigger", {
    repo: `${repo.owner}/${repo.name}`,
    workflow,
    ref,
    inputs,
    triggered: true,
    dispatched_at: new Date().toISOString(),
  }, {
    hint: "Workflow dispatched. Poll project_ci_status (branch=<ref>, limit=3) for the new run; it usually appears within ~10s.",
  });
}

// --------------------------- CI log retrieval ------------------------------

type ZipEntry = { name: string; data: Buffer; method: number; skipped?: string };

function findZipEocd(buf: Buffer): number {
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

/**
 * Minimal ZIP reader: central directory → local header → raw/deflate payload.
 * Only what GitHub's log archives use; unsupported (zip64/encrypted) entries
 * are skipped rather than guessed.
 */
function readZipEntries(buf: Buffer): ZipEntry[] {
  const eocd = findZipEocd(buf);
  if (eocd < 0) throw new Error("[provider_error] Log archive is not a valid ZIP (no end-of-central-directory record).");
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset === 0xffffffff || count === 0xffff) {
    throw new Error("[provider_error] ZIP64 log archives are not supported.");
  }
  if (cdOffset > buf.length) throw new Error("[provider_error] Log archive central directory is out of range.");

  const entries: ZipEntry[] = [];
  let cursor = cdOffset;
  for (let i = 0; i < count; i += 1) {
    if (cursor + 46 > buf.length || buf.readUInt32LE(cursor) !== 0x02014b50) break;
    const flags = buf.readUInt16LE(cursor + 8);
    const method = buf.readUInt16LE(cursor + 10);
    const compSize = buf.readUInt32LE(cursor + 20);
    const uncompSize = buf.readUInt32LE(cursor + 24);
    const nameLen = buf.readUInt16LE(cursor + 28);
    const extraLen = buf.readUInt16LE(cursor + 30);
    const commentLen = buf.readUInt16LE(cursor + 32);
    const localOffset = buf.readUInt32LE(cursor + 42);
    const name = buf.subarray(cursor + 46, cursor + 46 + nameLen).toString("utf8");
    cursor += 46 + nameLen + extraLen + commentLen;

    const entry: ZipEntry = { name, data: Buffer.alloc(0), method };
    if (flags & 0x1) {
      entry.skipped = "encrypted";
      entries.push(entry);
      continue;
    }
    if (compSize === 0xffffffff || uncompSize === 0xffffffff || localOffset === 0xffffffff) {
      entry.skipped = "zip64";
      entries.push(entry);
      continue;
    }
    if (uncompSize > LOG_ENTRY_MAX_BYTES) {
      entry.skipped = `entry too large (${uncompSize} bytes)`;
      entries.push(entry);
      continue;
    }
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== 0x04034b50) {
      entry.skipped = "bad local header";
      entries.push(entry);
      continue;
    }
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + lNameLen + lExtraLen;
    if (start + compSize > buf.length) {
      entry.skipped = "truncated payload";
      entries.push(entry);
      continue;
    }
    const raw = buf.subarray(start, start + compSize);
    try {
      if (method === 0) entry.data = Buffer.from(raw);
      else if (method === 8) entry.data = zlib.inflateRawSync(raw, { maxOutputLength: LOG_ENTRY_MAX_BYTES });
      else entry.skipped = `unsupported compression (${method})`;
    } catch (error) {
      entry.skipped = `inflate failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    entries.push(entry);
  }
  return entries;
}

/** Download the run's log archive (302 → pre-signed blob, token dropped there). */
async function fetchRunLogZip(repo: RepoRef, runId: number): Promise<Buffer> {
  const res = await ghFetch(`/repos/${repo.owner}/${repo.name}/actions/runs/${runId}/logs`, {
    timeoutMs: LOG_TIMEOUT_MS,
    maxBytes: LOG_ZIP_MAX_BYTES,
    accept: "application/vnd.github+json",
  });
  if (res.buffer.length > LOG_ZIP_MAX_BYTES) {
    throw new Error(
      `[resource_limit] Log archive is ${Math.round(res.buffer.length / 1024 / 1024)}MB (limit ${LOG_ZIP_MAX_BYTES / 1024 / 1024}MB). ` +
        `Hint: pass job_id to fetch a single job instead.`,
    );
  }
  return res.buffer;
}

export async function opCiLogs(args: Record<string, unknown>): Promise<Resp> {
  const repo = resolveRepo(args);
  const base = `/repos/${repo.owner}/${repo.name}`;
  const runId = Number(args.run_id ?? 0);
  const jobId = Number(args.job_id ?? 0);
  if (!(runId > 0) && !(jobId > 0)) {
    throw new Error(
      "[invalid_request] Pass `run_id` (whole run) or `job_id` (one job). Hint: project_ci_status returns both ids.",
    );
  }
  const maxBytes = positiveInt(args.max_bytes, DEFAULT_MAX_BYTES, HARD_MAX_BYTES);
  const wantLines = positiveInt(args.tail_lines, 500, 5000);

  let text = "";
  let entries: Array<Record<string, unknown>> = [];
  let source: string;

  if (jobId > 0) {
    const res = await ghFetch(`${base}/actions/jobs/${Math.floor(jobId)}/logs`, {
      timeoutMs: LOG_TIMEOUT_MS,
      maxBytes: LOG_ZIP_MAX_BYTES,
    });
    source = `job:${Math.floor(jobId)}`;
    if (res.buffer.subarray(0, 2).toString("latin1") === "PK") {
      const parsed = readZipEntries(res.buffer);
      text = parsed
        .map((entry) => (entry.skipped ? "" : `##### ${entry.name} #####\n${entry.data.toString("utf8")}`))
        .filter(Boolean)
        .join("\n\n");
      entries = parsed.map((entry) => ({
        name: entry.name,
        bytes: entry.data.length,
        ...(entry.skipped ? { skipped: entry.skipped } : {}),
      }));
    } else {
      text = res.buffer.toString("utf8");
      entries = [{ name: `job-${Math.floor(jobId)}.log`, bytes: res.buffer.length }];
    }
  } else {
    const zip = await fetchRunLogZip(repo, Math.floor(runId));
    const parsed = readZipEntries(zip);
    source = `run:${Math.floor(runId)}`;
    const parts: string[] = [];
    for (const entry of parsed) {
      if (entry.skipped || entry.data.length === 0) {
        entries.push({ name: entry.name, bytes: entry.data.length, ...(entry.skipped ? { skipped: entry.skipped } : {}) });
        continue;
      }
      const chunk = `##### ${entry.name} #####\n${entry.data.toString("utf8")}`;
      // Stop adding once the assembled text would explode; keep metadata only.
      if (Buffer.byteLength(parts.join("\n\n"), "utf8") + Buffer.byteLength(chunk, "utf8") > LOG_TEXT_MAX_BYTES) {
        entries.push({ name: entry.name, bytes: entry.data.length, skipped: "output cap" });
        continue;
      }
      parts.push(chunk);
      entries.push({ name: entry.name, bytes: entry.data.length });
    }
    text = parts.join("\n\n");
  }

  const byBytes = tailBytes(text, maxBytes);
  const byLines = tailLines(byBytes.text, wantLines);
  const truncated = byBytes.dropped > 0 || byLines.dropped > 0;
  const keptLines = byLines.text ? byLines.text.split(/\r?\n/).length : 0;

  return ok(
    "ci_logs",
    {
      repo: `${repo.owner}/${repo.name}`,
      ...(jobId > 0 ? { job_id: Math.floor(jobId) } : { run_id: Math.floor(runId) }),
      source,
      entries,
      lines: keptLines,
      text: byLines.text,
      truncated,
      dropped_lines: byLines.dropped,
      dropped_bytes: byBytes.dropped,
      max_bytes: maxBytes,
      tail_lines: wantLines,
    },
    {
      truncated,
      hint: truncated
        ? "Output trimmed to the tail. Hint: pass job_id to isolate a failing job, or raise max_bytes (max 4MB)."
        : undefined,
    },
  );
}

// ---------------------------------------------------------------------------
// Health (never returns the token)
// ---------------------------------------------------------------------------

export function githubHealth(): {
  network: boolean;
  api: string | null;
  repo: string | null;
  repo_source: string | null;
  branch: string | null;
  auth: string;
  token_origin: TokenOrigin;
} {
  const { token, origin } = resolveToken();
  let api: string | null = null;
  try {
    api = apiBaseUrl();
  } catch {
    api = null;
  }
  let repo: string | null = null;
  let source: string | null = null;
  try {
    const resolved = resolveRepo();
    repo = `${resolved.owner}/${resolved.name}`;
    source = resolved.source;
  } catch {
    repo = null;
  }
  return {
    network: networkEnabled(),
    api,
    repo,
    repo_source: source,
    branch: currentBranch(),
    auth: token ? "present" : "missing",
    token_origin: origin,
  };
}
