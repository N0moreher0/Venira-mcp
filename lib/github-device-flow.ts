import { randomBytes } from "node:crypto";
import {
  deleteSecret,
  getSecretMeta,
  getSecretValueSync,
  setSecret,
} from "./secrets.js";
import { networkEnabled } from "./git-http.js";

export const GITHUB_OAUTH_CLIENT_ID = "Ov23li4y56kYerOV6eo5";

type JsonRecord = Record<string, unknown>;

type TokenSave = {
  accessToken: string;
  accessExpiresIn?: number;
  refreshToken?: string;
  refreshExpiresIn?: number;
};

type PendingDevice = {
  deviceCode: string;
  expiresAt: number;
  intervalMs: number;
  nextPollAt: number;
};

type FlowDependencies = {
  fetcher?: typeof fetch;
  hasToken?: () => boolean;
  saveTokens?: (tokens: TokenSave) => Promise<void>;
};

async function responseJson(response: Response): Promise<JsonRecord> {
  const text = await response.text();
  if (text.length > 16 * 1024) throw new Error("[provider_error] GitHub authorization response exceeded the size limit.");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("[provider_error] GitHub returned an invalid authorization response.");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("[provider_error] GitHub returned an invalid authorization response.");
  }
  return value as JsonRecord;
}

function requiredString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new Error(`[provider_error] GitHub authorization response is missing ${label}.`);
  }
  return value;
}

function positiveSeconds(value: unknown, label: string, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0 || value > max) {
    throw new Error(`[provider_error] GitHub authorization response contains an invalid ${label}.`);
  }
  return value;
}

function optionalPositiveSeconds(value: unknown, label: string, max: number): number | undefined {
  return value === undefined ? undefined : positiveSeconds(value, label, max);
}

async function saveToVault(tokens: TokenSave): Promise<void> {
  const accessExpiresAt =
    tokens.accessExpiresIn === undefined ? null : Date.now() + tokens.accessExpiresIn * 1000;
  if (tokens.refreshToken) {
    const refreshExpiresAt =
      tokens.refreshExpiresIn === undefined ? null : Date.now() + tokens.refreshExpiresIn * 1000;
    await setSecret("GITHUB_REFRESH_TOKEN", tokens.refreshToken, {
      source: "provider",
      expiresAt: refreshExpiresAt,
    });
  } else {
    await deleteSecret("GITHUB_REFRESH_TOKEN");
  }
  await setSecret("GITHUB_TOKEN", tokens.accessToken, {
    source: "provider",
    expiresAt: accessExpiresAt,
  });
}

export class GithubDeviceFlow {
  private readonly pending = new Map<string, PendingDevice>();
  private readonly fetcher: typeof fetch;
  private readonly hasToken: () => boolean;
  private readonly saveTokens: (tokens: TokenSave) => Promise<void>;

  constructor(
    private readonly clientId = GITHUB_OAUTH_CLIENT_ID,
    dependencies: FlowDependencies = {},
  ) {
    this.fetcher = dependencies.fetcher ?? fetch;
    this.hasToken = dependencies.hasToken ?? (() => Boolean(getSecretMeta("GITHUB_TOKEN")));
    this.saveTokens = dependencies.saveTokens ?? saveToVault;
  }

  async start(replaceExisting = false): Promise<{
    pending_id: string;
    verification_uri: string;
    user_code: string;
    expires_in_seconds: number;
    poll_interval_seconds: number;
  }> {
    if (!networkEnabled()) {
      throw new Error("[network_disabled] Outbound network access is disabled (VENIRA_NETWORK=0).");
    }
    if (this.hasToken() && !replaceExisting) {
      throw new Error("[already_configured] A GitHub credential is already stored. Set replace_existing=true to connect another account.");
    }
    this.pruneExpired();
    if (this.pending.size >= 4) {
      throw new Error("[resource_limit] Too many GitHub authorization flows are pending. Complete one or wait for it to expire.");
    }

    const response = await this.fetcher("https://github.com/login/device/code", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: this.clientId, scope: "repo offline_access" }),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    }).catch(() => {
      throw new Error("[network_error] Could not reach GitHub to start authorization. Check the connection and retry.");
    });
    const body = await responseJson(response);
    if (!response.ok || typeof body.error === "string") {
      throw new Error("[provider_error] GitHub could not start device authorization. Check that Device Flow is enabled for the OAuth App.");
    }

    const deviceCode = requiredString(body.device_code, "device_code", 512);
    const userCode = requiredString(body.user_code, "user_code", 64);
    const verificationUri = requiredString(body.verification_uri, "verification_uri", 512);
    const parsedUri = new URL(verificationUri);
    if (parsedUri.protocol !== "https:" || parsedUri.hostname !== "github.com" || parsedUri.pathname !== "/login/device") {
      throw new Error("[provider_error] GitHub returned an unexpected device verification URL.");
    }
    const expiresIn = positiveSeconds(body.expires_in, "expires_in", 3600);
    const intervalSeconds = positiveSeconds(body.interval, "interval", 60);
    const pendingId = randomBytes(24).toString("hex");
    const expiresAt = Date.now() + expiresIn * 1000;
    this.pending.set(pendingId, {
      deviceCode,
      expiresAt,
      intervalMs: intervalSeconds * 1000,
      nextPollAt: Date.now() + intervalSeconds * 1000,
    });

    return {
      pending_id: pendingId,
      verification_uri: verificationUri,
      user_code: userCode,
      expires_in_seconds: expiresIn,
      poll_interval_seconds: intervalSeconds,
    };
  }

  async poll(pendingId: string): Promise<Record<string, unknown>> {
    if (!networkEnabled()) {
      throw new Error("[network_disabled] Outbound network access is disabled (VENIRA_NETWORK=0).");
    }
    this.pruneExpired();
    const pending = this.pending.get(pendingId);
    if (!pending) {
      throw new Error("[not_found] This GitHub authorization request is missing or expired. Start a new connection.");
    }
    const now = Date.now();
    if (now < pending.nextPollAt) {
      return {
        status: "pending",
        wait_seconds: Math.max(1, Math.ceil((pending.nextPollAt - now) / 1000)),
      };
    }
    pending.nextPollAt = now + pending.intervalMs;

    const response = await this.fetcher("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: this.clientId,
        device_code: pending.deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    }).catch(() => {
      throw new Error("[network_error] Could not reach GitHub to check authorization. Retry after a short wait.");
    });
    const body = await responseJson(response);
    const error = typeof body.error === "string" ? body.error : "";

    if (error === "authorization_pending") {
      return { status: "pending", wait_seconds: Math.ceil(pending.intervalMs / 1000) };
    }
    if (error === "slow_down") {
      pending.intervalMs = Math.min(60_000, pending.intervalMs + 5_000);
      pending.nextPollAt = Date.now() + pending.intervalMs;
      return { status: "pending", wait_seconds: Math.ceil(pending.intervalMs / 1000) };
    }
    if (error === "access_denied") {
      this.pending.delete(pendingId);
      return { status: "denied", message: "GitHub authorization was declined." };
    }
    if (error === "expired_token") {
      this.pending.delete(pendingId);
      return { status: "expired", message: "The GitHub authorization code expired. Start a new connection." };
    }
    if (!response.ok || error) {
      this.pending.delete(pendingId);
      throw new Error("[provider_error] GitHub could not complete authorization. Start a new connection and try again.");
    }

    const accessToken = requiredString(body.access_token, "access_token", 16 * 1024);
    const refreshToken =
      typeof body.refresh_token === "string" && body.refresh_token.length <= 16 * 1024
        ? body.refresh_token
        : undefined;
    const accessExpiresIn = optionalPositiveSeconds(body.expires_in, "expires_in", 3650 * 24 * 60 * 60);
    const refreshExpiresIn = optionalPositiveSeconds(
      body.refresh_token_expires_in,
      "refresh_token_expires_in",
      3650 * 24 * 60 * 60,
    );
    await this.saveTokens({ accessToken, accessExpiresIn, refreshToken, refreshExpiresIn });
    this.pending.delete(pendingId);

    return {
      status: "connected",
      credential: "GITHUB_TOKEN",
      expires_in_seconds: accessExpiresIn ?? null,
      refresh_token_saved: Boolean(refreshToken),
      message: "GitHub access is saved in the encrypted local Venira vault. The token value was not returned.",
    };
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [id, flow] of this.pending) {
      if (flow.expiresAt <= now) this.pending.delete(id);
    }
  }
}

let refreshInFlight: Promise<void> | null = null;

/** Refresh an expired device-flow access token without exposing either token to tool output. */
export async function refreshGithubAccessTokenIfNeeded(fetcher: typeof fetch = fetch): Promise<void> {
  const accessMeta = getSecretMeta("GITHUB_TOKEN");
  if (!accessMeta?.expired) return;
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    const refreshMeta = getSecretMeta("GITHUB_REFRESH_TOKEN");
    if (!refreshMeta || refreshMeta.expired) return;
    const refreshToken = getSecretValueSync("GITHUB_REFRESH_TOKEN");
    if (!refreshToken) return;
    if (!networkEnabled()) {
      throw new Error("[network_disabled] The GitHub access token expired while outbound network access is disabled.");
    }

    const response = await fetcher("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: GITHUB_OAUTH_CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    }).catch(() => {
      throw new Error("[network_error] Could not refresh the GitHub credential. Check the connection and retry.");
    });
    const body = await responseJson(response);
    if (!response.ok || typeof body.error === "string") {
      throw new Error("[secret_expired] GitHub credential could not be refreshed. Reconnect GitHub with project_github_connect.");
    }
    const accessToken = requiredString(body.access_token, "access_token", 16 * 1024);
    const nextRefresh =
      typeof body.refresh_token === "string" && body.refresh_token.length <= 16 * 1024
        ? body.refresh_token
        : refreshToken;
    const accessExpiresIn = optionalPositiveSeconds(body.expires_in, "expires_in", 3650 * 24 * 60 * 60);
    const refreshExpiresIn = optionalPositiveSeconds(
      body.refresh_token_expires_in,
      "refresh_token_expires_in",
      3650 * 24 * 60 * 60,
    );
    await saveToVault({
      accessToken,
      accessExpiresIn,
      refreshToken: nextRefresh,
      refreshExpiresIn,
    });
  })().finally(() => {
    refreshInFlight = null;
  });

  return refreshInFlight;
}
