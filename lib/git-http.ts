/**
 * Shared HTTP client for every git dialect.
 *
 * - manual redirects so credentials are dropped on a cross-origin hop
 *   (GitHub redirects log downloads to a pre-signed blob host);
 * - hard response-size cap and socket timeout, both configurable per install;
 * - bounded retries, GET only (a retried POST could open two PRs);
 * - optional HTTPS proxy via CONNECT, with `NO_PROXY` matching.
 */
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import type { GitContext, ProviderId } from "./git-config.js";

export type RawHeaders = Record<string, string | string[] | undefined>;
export type RawResult = { status: number; headers: RawHeaders; url: string; buffer: Buffer };

export type FetchOpts = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  timeoutMs?: number;
  accept?: string;
  /** GETs may run anonymously (public repos); mutations never do. */
  allowAnonymous?: boolean;
  headers?: Record<string, string>;
  maxBytes?: number;
};

const USER_AGENT = "venira-mcp-coding (+https://github.com/N0moreher0/Venira-mcp)";
const JSON_MAX_BYTES = 8 * 1024 * 1024;

export function networkEnabled(): boolean {
  const raw = (process.env.VENIRA_NETWORK ?? "1").trim().toLowerCase();
  return !["0", "false", "off", "no"].includes(raw);
}

function isLocalHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

export function providerLabel(provider: ProviderId): string {
  if (provider === "gitlab") return "GitLab";
  if (provider === "bitbucket") return "Bitbucket";
  return "GitHub";
}

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

// ---------------------------------------------------------------------------
// Proxy support (HTTPS targets only: CONNECT + TLS over the tunnel)
// ---------------------------------------------------------------------------

function bypassProxy(hostname: string): boolean {
  const raw = process.env.NO_PROXY ?? process.env.no_proxy ?? "";
  const entries = raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  const host = hostname.toLowerCase();
  return entries.some((entry) => {
    if (entry === "*") return true;
    const bare = entry.replace(/:\d+$/, "");
    if (bare.startsWith("*.")) return host === bare.slice(2) || host.endsWith(bare.slice(1));
    if (bare.startsWith(".")) return host === bare.slice(1) || host.endsWith(bare);
    return host === bare;
  });
}

/** Exported for verify: proxy bypass is pure string logic and worth testing. */
export function shouldBypassProxy(hostname: string): boolean {
  return bypassProxy(hostname);
}

class ConnectProxyAgent extends https.Agent {
  private readonly proxy: URL;

  constructor(proxy: string) {
    super({ keepAlive: false, maxSockets: 4 });
    this.proxy = new URL(proxy);
  }

  override createConnection(
    options: import("node:https").RequestOptions,
    callback?: (error: Error | null, stream: import("node:stream").Duplex) => void,
  ): undefined {
    const done = callback ?? (() => undefined);
    const host = String(options.host ?? options.hostname ?? "");
    const port = Number(options.port ?? 443);
    const headers: Record<string, string> = { Host: `${host}:${port}` };
    if (this.proxy.username) {
      const login = `${decodeURIComponent(this.proxy.username)}:${decodeURIComponent(this.proxy.password)}`;
      headers["Proxy-Authorization"] = `Basic ${Buffer.from(login, "utf8").toString("base64")}`;
    }
    const request = http.request({
      host: this.proxy.hostname,
      port: Number(this.proxy.port || (this.proxy.protocol === "https:" ? 443 : 80)),
      method: "CONNECT",
      path: `${host}:${port}`,
      headers,
    });
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      done(error, undefined as unknown as import("node:stream").Duplex);
    };
    request.once("connect", (response, socket) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        return fail(new Error(`proxy CONNECT returned ${response.statusCode}`));
      }
      const secure = tls.connect({ socket, servername: host });
      secure.once("secureConnect", () => {
        if (settled) return;
        settled = true;
        done(null, secure);
      });
      secure.once("error", fail);
    });
    request.once("error", fail);
    request.end();
  }
}

const agentCache = new Map<string, ConnectProxyAgent>();

function agentFor(ctx: GitContext, url: URL): https.Agent | undefined {
  if (!ctx.proxy || bypassProxy(url.hostname)) return undefined;
  const cached = agentCache.get(ctx.proxy);
  if (cached) return cached;
  const agent = new ConnectProxyAgent(ctx.proxy);
  agentCache.set(ctx.proxy, agent);
  return agent;
}

// ---------------------------------------------------------------------------
// One request (no redirect handling)
// ---------------------------------------------------------------------------

function requestOnce(
  ctx: GitContext,
  method: string,
  url: URL,
  headers: Record<string, string>,
  payload: string | undefined,
  timeoutMs: number,
  maxBytes: number,
): Promise<RawResult> {
  const secure = url.protocol === "https:";
  const transport = secure ? https : http;
  const agent = secure ? agentFor(ctx, url) : undefined;
  return new Promise<RawResult>((resolve, reject) => {
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    const request = transport.request(
      url,
      { method, headers, ...(agent ? { agent } : {}) },
      (response: http.IncomingMessage) => {
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
      },
    );
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error("__venira_timeout__"));
    });
    request.on("error", (error: Error) => {
      const message = error instanceof Error ? error.message : String(error);
      done(() => {
        if (message === "__venira_timeout__") {
          reject(
            new Error(
              `[timeout] ${providerLabel(ctx.provider)} request timed out after ${Math.round(timeoutMs / 1000)}s (${url.pathname}). ` +
                `Hint: retry, or raise VENIRA_GIT_TIMEOUT_MS.`,
            ),
          );
          return;
        }
        reject(
          new Error(
            `[network_error] Cannot reach ${url.host}: ${message}. ` +
              `Hint: check connectivity/proxy (VENIRA_GIT_PROXY), then retry.`,
          ),
        );
      });
    });
    if (payload !== undefined) request.write(payload);
    request.end();
  });
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

export function apiError(ctx: GitContext, status: number, body: string, headers: RawHeaders, target: string): Error {
  const provider = providerLabel(ctx.provider);
  let message = "";
  let detail = "";
  try {
    const parsed = JSON.parse(body) as {
      message?: string;
      error?: string;
      error_description?: string;
      errors?: Array<{ message?: string; code?: string }>;
    };
    message =
      (typeof parsed.message === "string" && parsed.message) ||
      (typeof parsed.error_description === "string" && parsed.error_description) ||
      (typeof parsed.error === "string" && parsed.error) ||
      "";
    detail = (parsed.errors ?? []).map((e) => e.message ?? e.code ?? "").filter(Boolean).join("; ");
  } catch {
    message = body.slice(0, 200);
  }
  const suffix = detail ? ` (${detail})` : "";

  if (status === 401) {
    return new Error(
      `[auth_failed] ${provider} rejected the token (401)${suffix}. Hint: the token is invalid or expired; ` +
        `run project_secret action=set name=${ctx.secret_name} value=<new token>.`,
    );
  }
  if (status === 403 || status === 429) {
    const remaining = headerValue(headers, "x-ratelimit-remaining") ?? headerValue(headers, "ratelimit-remaining");
    const reset = Number(headerValue(headers, "x-ratelimit-reset") ?? headerValue(headers, "ratelimit-reset") ?? 0);
    const retry = Number(headerValue(headers, "retry-after") ?? 0);
    if ((remaining !== null && remaining === "0") || status === 429) {
      const when = reset ? new Date(reset * 1000).toISOString() : retry ? `in ${retry}s` : "later";
      return new Error(
        `[rate_limited] ${provider} API rate limit reached (${target}). Hint: retry after ${when}, or use a token with a higher limit.`,
      );
    }
    const scopeHint =
      ctx.provider === "github"
        ? "pull requests need `repo`; workflow dispatch needs `workflow`"
        : ctx.provider === "gitlab"
          ? "the token needs `api` scope"
          : "the token needs `pullrequest:write` and `pipeline` scopes";
    return new Error(`[forbidden] ${provider} refused the request (403)${suffix}. Hint: the token lacks the required scope (${scopeHint}).`);
  }
  if (status === 404) {
    return new Error(
      `[not_found] ${provider} returned 404 for ${target}${suffix}. Hint: check repo/branch/PR number; private repos need a token with read access.`,
    );
  }
  if (status === 409) {
    return new Error(`[conflict] ${provider} reported a conflict (409)${suffix}. Hint: update the branch, then retry the merge.`);
  }
  if (status === 405) {
    return new Error(`[conflict] Not mergeable (405)${suffix}. Hint: the PR may be draft, closed, or blocked by branch protection.`);
  }
  if (status === 400 || status === 422) {
    return new Error(`[invalid_request] ${provider} rejected the request (${status})${suffix}. Hint: ${message || "check the field values."}`);
  }
  if (status >= 500) {
    return new Error(`[provider_error] ${provider} is unavailable (${status})${suffix}. Hint: transient; retry in a few seconds.`);
  }
  return new Error(`[provider_error] ${provider} returned ${status} for ${target}${suffix}. Hint: ${message || "unexpected response."}`);
}

// ---------------------------------------------------------------------------
// Authorized request with redirects + retries
// ---------------------------------------------------------------------------

function authHeaders(ctx: GitContext, token: string): Record<string, string> {
  if (ctx.provider === "gitlab") return { "PRIVATE-TOKEN": token };
  if (ctx.provider === "bitbucket" && ctx.username) {
    return { Authorization: `Basic ${Buffer.from(`${ctx.username}:${token}`, "utf8").toString("base64")}` };
  }
  return { Authorization: `Bearer ${token}` };
}

function defaultAccept(provider: ProviderId): string {
  if (provider === "github") return "application/vnd.github+json";
  return "application/json";
}

export async function gitFetch(ctx: GitContext, apiPath: string, opts: FetchOpts = {}): Promise<RawResult> {
  if (!networkEnabled()) {
    throw new Error(
      "[network_disabled] Outbound network access is disabled (VENIRA_NETWORK=0). Hint: set VENIRA_NETWORK=1 to allow provider calls.",
    );
  }
  if (!apiPath.startsWith("/")) {
    throw new Error(`[invalid_request] Provider path must start with "/" (got "${apiPath}").`);
  }
  const apiOrigin = new URL(ctx.api_base).origin;
  const token = ctx.token;
  if (!token && !opts.allowAnonymous) {
    throw new Error(
      `[auth_missing] No ${ctx.provider} token available (looked for secret "${ctx.secret_name}"). ` +
        `Hint: run project_secret action=set name=${ctx.secret_name} value=<token>.`,
    );
  }

  const method = opts.method ?? (opts.body !== undefined ? "POST" : "GET");
  const payload = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
  const timeoutMs = opts.timeoutMs ?? ctx.timeout_ms;
  const maxBytes = opts.maxBytes ?? ctx.max_bytes;
  const canRetry = method === "GET";
  const attempts = canRetry ? ctx.retries + 1 : 1;

  let lastError: Error | null = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await sendWithRedirects(ctx, apiPath, apiOrigin, token, method, payload, opts, timeoutMs, maxBytes);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      lastError = err;
      const retryable = /^\[(network_error|timeout|provider_error)\]/.test(err.message) || /is unavailable \(5\d\d\)/.test(err.message);
      if (!canRetry || attempt + 1 >= attempts || !retryable) throw err;
      await new Promise((resolve) => setTimeout(resolve, Math.min(2_000, 250 * (attempt + 1))));
    }
  }
  throw lastError ?? new Error("[provider_error] request failed");
}

async function sendWithRedirects(
  ctx: GitContext,
  apiPath: string,
  apiOrigin: string,
  token: string | null,
  method: string,
  payload: string | undefined,
  opts: FetchOpts,
  timeoutMs: number,
  maxBytes: number,
): Promise<RawResult> {
  let target = `${ctx.api_base}${apiPath}`;
  let sendAuth = true;

  for (let hop = 0; hop <= ctx.max_redirects; hop += 1) {
    const url = safeUrl(target);
    if (!url) {
      throw new Error(`[network_blocked] Refusing a non-https request to ${target}. Hint: provider calls must use https.`);
    }
    const headers: Record<string, string> = {
      Accept: opts.accept ?? defaultAccept(ctx.provider),
      "User-Agent": USER_AGENT,
      ...(ctx.provider === "github" ? { "X-GitHub-Api-Version": "2022-11-28" } : {}),
      ...(opts.headers ?? {}),
    };
    if (payload !== undefined) headers["Content-Type"] = "application/json";
    if (token && sendAuth && url.origin === apiOrigin) Object.assign(headers, authHeaders(ctx, token));

    const res = await requestOnce(ctx, method, url, headers, payload, timeoutMs, maxBytes);

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = headerValue(res.headers, "location");
      if (!location) {
        throw new Error(`[provider_error] ${providerLabel(ctx.provider)} redirect (${res.status}) without a Location header.`);
      }
      const next = new URL(location, url);
      if (next.origin !== apiOrigin) sendAuth = false;
      if (method !== "GET") {
        throw new Error(`[provider_error] Unexpected redirect for ${method} ${url.pathname} -> ${next.host}.`);
      }
      target = next.toString();
      continue;
    }

    if (res.status >= 400) {
      throw apiError(ctx, res.status, res.buffer.toString("utf8"), res.headers, `${method} ${url.pathname}`);
    }
    return res;
  }
  throw new Error("[provider_error] Too many redirects. Hint: check the API base URL (VENIRA_GIT_API_URL); retry later.");
}

export async function gitJson(
  ctx: GitContext,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  apiPath: string,
  opts: FetchOpts = {},
): Promise<{ status: number; json: any }> {
  const res = await gitFetch(ctx, apiPath, { ...opts, method });
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
