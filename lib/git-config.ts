/**
 * Git provider configuration: one context per call, resolved from
 * call args → environment → `venira.config.json` → inferred remote → default.
 *
 * The point is that nothing here is baked into the build: provider, API base,
 * token name, timeouts, byte caps, redirects, retries and proxy can all be set
 * per install, per repository, or for one call.
 *
 * Secrets never leave this module in plaintext except through `ctx.token`,
 * which the HTTP layer turns into a header immediately.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { WORKSPACE } from "./workspace.js";
import { getSecretMeta, getSecretValueSync, isValidSecretName, markSecretUsed } from "./secrets.js";
import { currentBranch, parsePrOrRepo, parseRepoRef, readOriginUrl, type RepoRef } from "./git-repo.js";

export type ProviderId = "github" | "gitlab" | "bitbucket";

export const PROVIDER_IDS: ProviderId[] = ["github", "gitlab", "bitbucket"];

type RepoOverride = {
  provider?: ProviderId;
  api_url?: string;
  secret?: string;
  token_env?: string;
  username?: string;
};

type GitFileConfig = {
  provider?: ProviderId;
  api_url?: string;
  secret?: string;
  token_env?: string;
  username?: string;
  repo?: string;
  timeout_ms?: number;
  log_timeout_ms?: number;
  max_bytes?: number;
  log_max_bytes?: number;
  log_zip_bytes?: number;
  log_entry_bytes?: number;
  log_text_bytes?: number;
  max_redirects?: number;
  retries?: number;
  proxy?: string;
  repos?: Record<string, RepoOverride>;
};

export type GitContext = {
  provider: ProviderId;
  provider_source: string;
  api_base: string;
  api_source: string;
  repo: RepoRef;
  repo_source: string;
  token: string | null;
  token_origin: string;
  secret_name: string;
  username: string | null;
  timeout_ms: number;
  log_timeout_ms: number;
  max_bytes: number;
  log_max_bytes: number;
  log_zip_bytes: number;
  log_entry_bytes: number;
  log_text_bytes: number;
  max_redirects: number;
  retries: number;
  proxy: string | null;
  proxy_source: string;
  config_path: string | null;
};

const DEFAULTS: Record<ProviderId, { api: string; secret: string; env: string[] }> = {
  github: {
    api: "https://api.github.com",
    secret: "GITHUB_TOKEN",
    env: ["VENIRA_GITHUB_TOKEN", "GITHUB_TOKEN", "GH_TOKEN"],
  },
  gitlab: {
    api: "https://gitlab.com/api/v4",
    secret: "GITLAB_TOKEN",
    env: ["VENIRA_GITLAB_TOKEN", "GITLAB_TOKEN", "GL_TOKEN"],
  },
  bitbucket: {
    api: "https://api.bitbucket.org/2.0",
    secret: "BITBUCKET_TOKEN",
    env: ["VENIRA_BITBUCKET_TOKEN", "BITBUCKET_TOKEN", "BB_TOKEN"],
  },
};

const ENV_SECRETS: Record<ProviderId, string> = {
  github: "GITHUB_TOKEN",
  gitlab: "GITLAB_TOKEN",
  bitbucket: "BITBUCKET_TOKEN",
};

// Hard ceilings: environment/config may lower a limit, never remove it.
const LIMITS = {
  timeout_ms: { min: 1_000, max: 600_000, default: 60_000 },
  log_timeout_ms: { min: 1_000, max: 900_000, default: 90_000 },
  max_bytes: { min: 1_024, max: 64 * 1024 * 1024, default: 8 * 1024 * 1024 },
  log_max_bytes: { min: 1_024, max: 4 * 1024 * 1024, default: 512 * 1024 },
  log_zip_bytes: { min: 1_024, max: 128 * 1024 * 1024, default: 32 * 1024 * 1024 },
  log_entry_bytes: { min: 1_024, max: 32 * 1024 * 1024, default: 4 * 1024 * 1024 },
  log_text_bytes: { min: 1_024, max: 32 * 1024 * 1024, default: 8 * 1024 * 1024 },
  max_redirects: { min: 0, max: 10, default: 5 },
  retries: { min: 0, max: 3, default: 1 },
} as const;



function envText(...names: string[]): string {
  for (const name of names) {
    const value = (process.env[name] ?? "").trim();
    if (value) return value;
  }
  return "";
}

/** Config file: explicit `VENIRA_CONFIG_FILE`, else `<workspace>/venira.config.json`. */
export function configPath(): string | null {
  const explicit = (process.env.VENIRA_CONFIG_FILE ?? "").trim();
  if (explicit) return path.resolve(WORKSPACE, explicit);
  const candidate = path.join(WORKSPACE, "venira.config.json");
  return existsSync(candidate) ? candidate : null;
}

let configCache: { file: string; mtimeMs: number; data: GitFileConfig } | null = null;

function loadConfigFile(): { data: GitFileConfig; file: string | null } {
  const file = configPath();
  if (!file) return { data: {}, file: null };
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(file).mtimeMs;
  } catch {
    return { data: {}, file: null };
  }
  if (configCache && configCache.file === file && configCache.mtimeMs === mtimeMs) {
    return { data: configCache.data, file };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(
      `[invalid_request] ${path.basename(file)} is not valid JSON (${error instanceof Error ? error.message : String(error)}). ` +
        `Hint: fix the file, or point VENIRA_CONFIG_FILE at another one.`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`[invalid_request] ${path.basename(file)} must contain a JSON object. Hint: see README §3.4.`);
  }
  const root = parsed as { git?: unknown };
  const git = root.git;
  if (git !== undefined && (git === null || typeof git !== "object" || Array.isArray(git))) {
    throw new Error(`[invalid_request] \`git\` in ${path.basename(file)} must be an object. Hint: see README §3.4.`);
  }
  const data = (git ?? {}) as GitFileConfig;
  if (data.repos !== undefined && (data.repos === null || typeof data.repos !== "object" || Array.isArray(data.repos))) {
    throw new Error(`[invalid_request] \`git.repos\` in ${path.basename(file)} must be an object keyed by "owner/name".`);
  }
  configCache = { file, mtimeMs, data };
  return { data, file };
}

function asProvider(value: unknown, source: string): ProviderId {
  const text = String(value ?? "").trim().toLowerCase();
  if (!PROVIDER_IDS.includes(text as ProviderId)) {
    throw new Error(
      `[invalid_request] Unknown git provider "${text}" from ${source}. Hint: use ${PROVIDER_IDS.join(" | ")}.`,
    );
  }
  return text as ProviderId;
}

function inferProvider(remote: string | null): ProviderId | null {
  const lower = (remote ?? "").toLowerCase();
  if (!lower) return null;
  if (lower.includes("github.") || lower.includes("github.com")) return "github";
  if (lower.includes("gitlab")) return "gitlab";
  if (lower.includes("bitbucket")) return "bitbucket";
  return null;
}

function hostOf(raw: string): string | null {
  const text = raw.trim();
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return new URL(text).hostname.toLowerCase();
    const scp = /^[\w.-]+@([\w.-]+):/.exec(text);
    if (scp) return scp[1].toLowerCase();
  } catch {
    /* not a URL: owner/name */
  }
  return null;
}

function allowHttp(): boolean {
  return (process.env.VENIRA_GIT_ALLOW_HTTP ?? process.env.VENIRA_GITHUB_ALLOW_HTTP ?? "") === "1";
}

function isLocalHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

/** Normalized API base: https (or localhost/allow-http), no trailing slash. */
export function normalizeApiBase(raw: string, source: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(
      `[invalid_request] ${source} is not a URL: "${raw}". Hint: https://api.github.com, https://<ghe-host>/api/v3, https://gitlab.com/api/v4, https://api.bitbucket.org/2.0.`,
    );
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocalHost(url.hostname)) && !allowHttp()) {
    throw new Error(
      `[invalid_request] ${source} must be https (got ${url.protocol}//${url.host}). ` +
        `Hint: tokens must never travel over plaintext; set VENIRA_GIT_ALLOW_HTTP=1 only for a local test server.`,
    );
  }
  if (!url.hostname) {
    throw new Error(`[invalid_request] ${source} has no host: "${raw}".`);
  }
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
}

function intFrom(
  key: keyof typeof LIMITS,
  envNames: string[],
  fileValue: unknown,
): { value: number; source: string } {
  const spec = LIMITS[key];
  const envName = envNames.find((name) => (process.env[name] ?? "").trim() !== "");
  const raw = envName ? (process.env[envName] as string).trim() : fileValue;
  if (raw === undefined || raw === null || raw === "") return { value: spec.default, source: "default" };
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < spec.min || n > spec.max) {
    throw new Error(
      `[invalid_request] ${key} must be an integer between ${spec.min} and ${spec.max} (got "${String(raw)}"). ` +
        `Hint: ${envName ?? key} in venira.config.json.`,
    );
  }
  return { value: n, source: envName ? `env:${envName}` : "config" };
}

function tokenFor(
  provider: ProviderId,
  secretName: string,
  tokenEnv: string,
): { token: string | null; origin: string } {
  const candidates: string[] = [];
  if (tokenEnv) candidates.push(tokenEnv);
  const envToken = envText("VENIRA_GIT_TOKEN");
  if (envToken) return { token: envToken, origin: "env:VENIRA_GIT_TOKEN" };

  if (isValidSecretName(secretName)) {
    // Rotation metadata is checked before decryption: an expired token must fail
    // with an actionable error, not reach the provider and come back as 401.
    let meta;
    try {
      meta = getSecretMeta(secretName);
    } catch {
      meta = undefined;
    }
    if (meta) {
      if (meta.expired) {
        const at = meta.expires_at === null ? "unknown" : new Date(meta.expires_at).toISOString();
        throw new Error(
          `[secret_expired] Secret "${secretName}" expired at ${at}. ` +
            `Hint: rotate it with project_secret action=set name=${secretName} value=<new token> (add expires_in_days).`,
        );
      }
      try {
        const secret = getSecretValueSync(secretName);
        if (secret && secret.trim()) {
          void markSecretUsed(secretName, "provider").catch(() => undefined);
          return { token: secret.trim(), origin: "secret" };
        }
      } catch {
        /* decryption failed: fall through to env */
      }
    }
  }

  for (const name of [...candidates, ...DEFAULTS[provider].env]) {
    const value = (process.env[name] ?? "").trim();
    if (value) return { token: value, origin: `env:${name}` };
  }
  return { token: null, origin: "missing" };
}

function proxyFor(fileValue: unknown): { proxy: string | null; source: string } {
  const explicit = envText("VENIRA_GIT_PROXY");
  if (explicit) return { proxy: explicit, source: "env:VENIRA_GIT_PROXY" };
  const shared = envText("HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy");
  if (shared) return { proxy: shared, source: "env:proxy" };
  if (typeof fileValue === "string" && fileValue.trim()) return { proxy: fileValue.trim(), source: "config" };
  return { proxy: null, source: "none" };
}

export function resolveRepo(
  args: Record<string, unknown> = {},
  file: GitFileConfig = {},
): RepoRef & { source: string } {
  const explicit = typeof args.repo === "string" ? args.repo.trim() : "";
  if (explicit) {
    const parsed = parsePrOrRepo(explicit);
    if (parsed) return { ...parsed, source: "arg" };
  }
  const env = envText(
    "VENIRA_GIT_REPO",
    "VENIRA_GITHUB_REPO",
    "VENIRA_GITLAB_REPO",
    "VENIRA_BITBUCKET_REPO",
  );
  if (env) {
    const parsed = parsePrOrRepo(env);
    if (parsed) return { ...parsed, source: "env" };
  }
  if (typeof file.repo === "string" && file.repo.trim()) {
    const parsed = parsePrOrRepo(file.repo.trim());
    if (parsed) return { ...parsed, source: "config" };
  }
  const origin = readOriginUrl(WORKSPACE);
  if (origin) return { ...parseRepoRef(origin, ".git/config origin"), source: "git" };
  throw new Error(
    "[repo_unresolved] No git repository found. " +
      'Hint: pass repo="owner/name", set VENIRA_GIT_REPO, add git.repo to venira.config.json, or add an `origin` remote.',
  );
}

/** Resolve everything a provider call needs. Throws `[invalid_request]` on bad config. */
export function gitContext(args: Record<string, unknown> = {}): GitContext {
  const { data: file, file: filePath } = loadConfigFile();
  const repo = resolveRepo(args, file);
  const repoKey = `${repo.owner}/${repo.name}`.toLowerCase();
  const repoOverride: RepoOverride | undefined = Object.entries(file.repos ?? {}).find(
    ([key]) => key.trim().toLowerCase() === repoKey,
  )?.[1];

  const remote = repo.source === "git" ? readOriginUrl(WORKSPACE) : null;
  const argRepoHost = typeof args.repo === "string" ? hostOf(args.repo) : null;
  const inferred = inferProvider(remote) ?? inferProvider(argRepoHost ?? "");

  const envProvider = envText("VENIRA_GIT_PROVIDER");
  const argProvider = typeof args.provider === "string" ? args.provider.trim() : "";
  let provider: ProviderId;
  let providerSource: string;
  if (argProvider) {
    provider = asProvider(argProvider, "the `provider` argument");
    providerSource = "arg";
  } else if (envProvider) {
    provider = asProvider(envProvider, "VENIRA_GIT_PROVIDER");
    providerSource = "env";
  } else if (repoOverride?.provider) {
    provider = asProvider(repoOverride.provider, `venira.config.json repos["${repoKey}"].provider`);
    providerSource = "config:repo";
  } else if (file.provider) {
    provider = asProvider(file.provider, "venira.config.json git.provider");
    providerSource = "config";
  } else if (inferred) {
    provider = inferred;
    providerSource = "remote";
  } else {
    provider = "github";
    providerSource = "default";
  }

  const apiRaw = envText("VENIRA_GIT_API_URL", "VENIRA_GITHUB_API_URL");
  let apiBase: string;
  let apiSource: string;
  if (apiRaw && apiRaw.trim()) {
    apiBase = normalizeApiBase(apiRaw, "VENIRA_GIT_API_URL");
    apiSource = "env";
  } else if (repoOverride?.api_url) {
    apiBase = normalizeApiBase(repoOverride.api_url, `venira.config.json repos["${repoKey}"].api_url`);
    apiSource = "config:repo";
  } else if (file.api_url) {
    apiBase = normalizeApiBase(file.api_url, "venira.config.json git.api_url");
    apiSource = "config";
  } else {
    apiBase = DEFAULTS[provider].api;
    apiSource = "default";
  }

  const secretName =
    envText("VENIRA_GIT_SECRET_NAME") ||
    repoOverride?.secret ||
    file.secret ||
    DEFAULTS[provider].secret ||
    ENV_SECRETS[provider];
  const tokenEnv = envText("VENIRA_GIT_TOKEN_ENV") || repoOverride?.token_env || file.token_env || "";
  const { token, origin: tokenOrigin } = tokenFor(provider, secretName, tokenEnv);
  const username = envText("VENIRA_GIT_USERNAME") || repoOverride?.username || file.username || null;

  const timeout = intFrom("timeout_ms", ["VENIRA_GIT_TIMEOUT_MS"], file.timeout_ms);
  const logTimeout = intFrom("log_timeout_ms", ["VENIRA_GIT_LOG_TIMEOUT_MS"], file.log_timeout_ms);
  const maxBytes = intFrom("max_bytes", ["VENIRA_GIT_MAX_BYTES"], file.max_bytes);
  const logMaxBytes = intFrom("log_max_bytes", ["VENIRA_GIT_LOG_MAX_BYTES"], file.log_max_bytes);
  const logZipBytes = intFrom("log_zip_bytes", ["VENIRA_GIT_LOG_ZIP_BYTES"], file.log_zip_bytes);
  const logEntryBytes = intFrom("log_entry_bytes", ["VENIRA_GIT_LOG_ENTRY_BYTES"], file.log_entry_bytes);
  const logTextBytes = intFrom("log_text_bytes", ["VENIRA_GIT_LOG_TEXT_BYTES"], file.log_text_bytes);
  const redirects = intFrom("max_redirects", ["VENIRA_GIT_MAX_REDIRECTS"], file.max_redirects);
  const retries = intFrom("retries", ["VENIRA_GIT_RETRIES"], file.retries);
  const { proxy, source: proxySource } = proxyFor(file.proxy);

  return {
    provider,
    provider_source: providerSource,
    api_base: apiBase,
    api_source: apiSource,
    repo,
    repo_source: repo.source,
    token,
    token_origin: tokenOrigin,
    secret_name: secretName,
    username,
    timeout_ms: timeout.value,
    log_timeout_ms: logTimeout.value,
    max_bytes: maxBytes.value,
    log_max_bytes: logMaxBytes.value,
    log_zip_bytes: logZipBytes.value,
    log_entry_bytes: logEntryBytes.value,
    log_text_bytes: logTextBytes.value,
    max_redirects: redirects.value,
    retries: retries.value,
    proxy,
    proxy_source: proxySource,
    config_path: filePath,
  };
}

export function requireToken(ctx: GitContext): string {
  if (!ctx.token) {
    throw new Error(
      `[auth_missing] No ${ctx.provider} token available (looked for secret "${ctx.secret_name}"). ` +
        `Hint: run project_secret action=set name=${ctx.secret_name} value=<token>, ` +
        `or export VENIRA_GIT_TOKEN${ctx.provider === "github" ? " / GITHUB_TOKEN" : ""}.`,
    );
  }
  return ctx.token;
}

/** Baseline ETA shown in `doctor`/`health`; never includes the token or proxy credentials. */
export function gitHealth(): {
  provider: ProviderId;
  provider_source: string;
  api: string;
  api_source: string;
  repo: string | null;
  repo_source: string | null;
  branch: string | null;
  auth: "present" | "missing";
  token_origin: string;
  secret: string;
  username: string | null;
  config: string | null;
  proxy: string | null;
  proxy_source: string;
  timeouts: { request_ms: number; log_ms: number };
  limits: {
    max_bytes: number;
    log_max_bytes: number;
    log_zip_bytes: number;
    log_entry_bytes: number;
    log_text_bytes: number;
    max_redirects: number;
    retries: number;
  };
} {
  let ctx: GitContext | null = null;
  let error: string | null = null;
  try {
    ctx = gitContext();
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  const safeProxy = (() => {
    if (!ctx?.proxy) return null;
    try {
      const url = new URL(ctx.proxy);
      return `${url.protocol}//${url.host}`;
    } catch {
      return "(configured)";
    }
  })();
  if (!ctx) {
    return {
      provider: "github",
      provider_source: "default",
      api: "https://api.github.com",
      api_source: "default",
      repo: null,
      repo_source: null,
      branch: currentBranch(),
      auth: "missing",
      token_origin: error ? "config_error" : "missing",
      secret: "GITHUB_TOKEN",
      username: null,
      config: configPath(),
      proxy: null,
      proxy_source: "none",
      timeouts: { request_ms: LIMITS.timeout_ms.default, log_ms: LIMITS.log_timeout_ms.default },
      limits: {
        max_bytes: LIMITS.max_bytes.default,
        log_max_bytes: LIMITS.log_max_bytes.default,
        log_zip_bytes: LIMITS.log_zip_bytes.default,
        log_entry_bytes: LIMITS.log_entry_bytes.default,
        log_text_bytes: LIMITS.log_text_bytes.default,
        max_redirects: LIMITS.max_redirects.default,
        retries: LIMITS.retries.default,
      },
    };
  }
  return {
    provider: ctx.provider,
    provider_source: ctx.provider_source,
    api: ctx.api_base,
    api_source: ctx.api_source,
    repo: `${ctx.repo.owner}/${ctx.repo.name}`,
    repo_source: ctx.repo_source,
    branch: currentBranch(),
    auth: ctx.token ? "present" : "missing",
    token_origin: ctx.token_origin,
    secret: ctx.secret_name,
    username: ctx.username,
    config: ctx.config_path,
    proxy: safeProxy,
    proxy_source: ctx.proxy_source,
    timeouts: { request_ms: ctx.timeout_ms, log_ms: ctx.log_timeout_ms },
    limits: {
      max_bytes: ctx.max_bytes,
      log_max_bytes: ctx.log_max_bytes,
      log_zip_bytes: ctx.log_zip_bytes,
      log_entry_bytes: ctx.log_entry_bytes,
      log_text_bytes: ctx.log_text_bytes,
      max_redirects: ctx.max_redirects,
      retries: ctx.retries,
    },
  };
}

export const GIT_LIMIT_CEILINGS = {
  max_bytes: LIMITS.max_bytes.max,
  log_max_bytes: LIMITS.log_max_bytes.max,
  log_zip_bytes: LIMITS.log_zip_bytes.max,
  log_entry_bytes: LIMITS.log_entry_bytes.max,
  log_text_bytes: LIMITS.log_text_bytes.max,
} as const;
