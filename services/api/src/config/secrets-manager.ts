/**
 * Phase P2.0 — AWS Secrets Manager loader.
 *
 * Production-safe secret hydration with **env fallback always
 * preserved**. The contract:
 *
 *   * If `AWS_SECRETS_ENABLED` is not "true" → loader is a no-op.
 *     `getCachedSecret()` returns null. Callers fall back to
 *     `process.env`. Local dev + Docker keep working.
 *
 *   * If `AWS_SECRETS_ENABLED=true` → at boot we attempt ONE fetch
 *     of `AWS_SECRET_NAME` (default `proovra/prod/app-secrets`).
 *     On success, the result is parsed as a JSON object of
 *     name→value strings and cached. On failure, we log a single
 *     bounded warning and leave the cache empty (callers fall
 *     back to env). The app NEVER crashes from a failed AWS fetch.
 *
 *   * The cache is in-memory only. A periodic background refresh
 *     runs every `SECRETS_REFRESH_TTL_MS` (default 1 hour). The
 *     refresh is best-effort — a failure does NOT invalidate the
 *     previous cache.
 *
 *   * No secret values are ever logged. We log only:
 *       * `aws_secrets.hydration_started` (no body)
 *       * `aws_secrets.hydration_succeeded` (count of keys, no names)
 *       * `aws_secrets.hydration_failed` (bounded error code only)
 *       * `aws_secrets.refresh_*` (counters only)
 *
 *   * The loader exposes ONLY:
 *       * `initSecretsManager()` — call once at boot.
 *       * `getCachedSecret(name)` — synchronous, in-memory lookup.
 *       * `getSecretsHealth()` — operator status, NEVER values.
 *
 *   * Operators with the `runtime.read` permission may hit
 *     `GET /v1/runtime/secrets-health` to inspect cache state.
 *     That route uses `getSecretsHealth()` and is the ONLY external
 *     surface.
 *
 * Security posture:
 *   * No `console.log(secret)` anywhere.
 *   * No secret values ever appear in error messages thrown out of
 *     this module.
 *   * AWS errors are mapped to bounded codes
 *     (`access_denied` / `not_found` / `network` / `unknown`) so
 *     IAM ARNs / endpoint URLs cannot leak to operators.
 */

import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";

import { bump } from "../services/ops/metrics.service.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEFAULT_REFRESH_TTL_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_SECRET_NAME = "proovra/prod/app-secrets";

function isEnabled(): boolean {
  return (process.env.AWS_SECRETS_ENABLED ?? "").trim().toLowerCase() === "true";
}

function configuredSecretName(): string {
  return (process.env.AWS_SECRET_NAME ?? "").trim() || DEFAULT_SECRET_NAME;
}

function configuredRegion(): string {
  // P2.0B — region precedence:
  //   1. AWS_SECRETS_REGION  (Secrets Manager-specific override)
  //   2. AWS_REGION          (existing app-wide region — used by KMS today)
  //   3. "us-east-1"         (the secret is hosted there)
  //
  // The KMS signer continues to read AWS_REGION itself; we never
  // mutate that. This split lets us host Secrets Manager in us-east-1
  // while keeping KMS signing on eu-north-1.
  const specific = (process.env.AWS_SECRETS_REGION ?? "").trim();
  if (specific.length > 0) return specific;
  const generic = (process.env.AWS_REGION ?? "").trim();
  if (generic.length > 0) return generic;
  return "us-east-1";
}

function refreshTtlMs(): number {
  // P2.0B — accept the AWS_SECRETS_REFRESH_TTL_MS name as the canonical
  // env (matches the spec). The pre-existing SECRETS_REFRESH_TTL_MS is
  // still honoured for backward-compat with deployments that already
  // set it.
  const raw = Number.parseInt(
    (process.env.AWS_SECRETS_REFRESH_TTL_MS ??
      process.env.SECRETS_REFRESH_TTL_MS ??
      "") as string,
    10,
  );
  if (!Number.isFinite(raw) || raw < 60_000) return DEFAULT_REFRESH_TTL_MS;
  // Hard upper bound of 24h to prevent stale-secret pinning.
  return Math.min(raw, 24 * 60 * 60 * 1000);
}

// ---------------------------------------------------------------------------
// Internal state — bounded, never exported as a mutable reference
// ---------------------------------------------------------------------------

type CacheState = {
  /** Plain object of name→string. NEVER a Map (so destructive
   *  serialisation can't accidentally include this state). */
  values: Record<string, string>;
  lastRefreshAtUtc: string;
  source: "aws_secrets_manager";
};

type LoaderState = {
  awsEnabled: boolean;
  awsConnected: boolean;
  cacheLoaded: boolean;
  fallbackMode: "aws_primary" | "env_only" | "env_fallback_after_failure";
  cache: CacheState | null;
  lastError: {
    code: "access_denied" | "not_found" | "network" | "unknown" | "decode";
    occurredAtUtc: string;
  } | null;
  refreshTimer: NodeJS.Timeout | null;
};

const state: LoaderState = {
  awsEnabled: false,
  awsConnected: false,
  cacheLoaded: false,
  fallbackMode: "env_only",
  cache: null,
  lastError: null,
  refreshTimer: null,
};

// ---------------------------------------------------------------------------
// Client (lazy)
// ---------------------------------------------------------------------------

let _client: SecretsManagerClient | null = null;
function getClient(): SecretsManagerClient {
  if (_client) return _client;
  _client = new SecretsManagerClient({
    region: configuredRegion(),
    maxAttempts: 2,
    // Credentials resolved automatically from the standard chain
    // (env vars → shared config → IAM role). We do not read
    // AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY ourselves so the
    // SDK chain stays canonical.
  });
  return _client;
}

// ---------------------------------------------------------------------------
// Error classification — bounded enum
// ---------------------------------------------------------------------------

function classifyAwsError(
  err: unknown,
): "access_denied" | "not_found" | "network" | "unknown" | "decode" {
  const e = err as { name?: unknown; Code?: unknown; code?: unknown };
  const name = String(e?.name ?? e?.Code ?? e?.code ?? "").toLowerCase();
  if (name.includes("accessdenied") || name.includes("unauthorized")) {
    return "access_denied";
  }
  if (name.includes("resourcenotfound") || name.includes("notfound")) {
    return "not_found";
  }
  if (
    name.includes("network") ||
    name.includes("timeout") ||
    name.includes("econn") ||
    name.includes("enotfound")
  ) {
    return "network";
  }
  return "unknown";
}

// ---------------------------------------------------------------------------
// Hydration
// ---------------------------------------------------------------------------

type LogShape = {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
};

async function hydrateOnce(log: LogShape): Promise<void> {
  if (!state.awsEnabled) return;
  log.info(
    { secretName: configuredSecretName(), region: configuredRegion() },
    "aws_secrets.hydration_started",
  );
  try {
    const res = await getClient().send(
      new GetSecretValueCommand({ SecretId: configuredSecretName() }),
    );
    const raw = res.SecretString ?? null;
    if (!raw) {
      // Binary secrets are not supported; we expect JSON.
      state.lastError = {
        code: "decode",
        occurredAtUtc: new Date().toISOString(),
      };
      state.awsConnected = false;
      state.fallbackMode = state.cacheLoaded
        ? "env_fallback_after_failure"
        : "env_only";
      bump("secrets_fetch_failure_total");
      log.warn(
        { reason: "empty_secret_string" },
        "aws_secrets.hydration_failed",
      );
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      state.lastError = {
        code: "decode",
        occurredAtUtc: new Date().toISOString(),
      };
      state.awsConnected = false;
      bump("secrets_fetch_failure_total");
      log.warn(
        { reason: "json_parse_failed" },
        "aws_secrets.hydration_failed",
      );
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      state.lastError = {
        code: "decode",
        occurredAtUtc: new Date().toISOString(),
      };
      state.awsConnected = false;
      bump("secrets_fetch_failure_total");
      log.warn(
        { reason: "not_a_json_object" },
        "aws_secrets.hydration_failed",
      );
      return;
    }
    const values: Record<string, string> = {};
    let keyCount = 0;
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string") {
        values[k] = v;
        keyCount++;
      }
    }
    state.cache = {
      values,
      lastRefreshAtUtc: new Date().toISOString(),
      source: "aws_secrets_manager",
    };
    state.cacheLoaded = true;
    state.awsConnected = true;
    state.fallbackMode = "aws_primary";
    state.lastError = null;
    bump("secrets_fetch_success_total");
    log.info(
      { keyCount },
      "aws_secrets.hydration_succeeded",
    );
  } catch (err) {
    const code = classifyAwsError(err);
    state.lastError = { code, occurredAtUtc: new Date().toISOString() };
    state.awsConnected = false;
    state.fallbackMode = state.cacheLoaded
      ? "env_fallback_after_failure"
      : "env_only";
    bump("secrets_fetch_failure_total");
    bump("secrets_fallback_total");
    log.warn(
      { code },
      "aws_secrets.hydration_failed",
    );
  }
}

async function refreshLoop(log: LogShape): Promise<void> {
  if (!state.awsEnabled) return;
  bump("secrets_cache_refresh_total");
  await hydrateOnce(log);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Called once from the API server bootstrap. ALWAYS safe to call —
 * if AWS is not enabled, this is a no-op. If hydration fails, the
 * function returns normally; callers will simply fall back to env.
 */
export async function initSecretsManager(log: LogShape): Promise<void> {
  state.awsEnabled = isEnabled();
  if (!state.awsEnabled) {
    state.fallbackMode = "env_only";
    log.info(
      { reason: "AWS_SECRETS_ENABLED not true" },
      "aws_secrets.disabled",
    );
    return;
  }
  await hydrateOnce(log);
  // Schedule periodic refresh — best-effort, non-blocking.
  if (state.refreshTimer) clearInterval(state.refreshTimer);
  const ttl = refreshTtlMs();
  state.refreshTimer = setInterval(() => {
    void refreshLoop(log);
  }, ttl);
  // Allow process exit even when the timer is pending.
  if (state.refreshTimer.unref) state.refreshTimer.unref();
}

/**
 * Synchronous in-memory lookup. Returns null when the secret is not
 * cached (either AWS disabled, hydration failed, or the key is
 * simply not present in the secret bundle). Callers MUST fall back
 * to `process.env[name]` themselves — see `runtime-secrets.ts`.
 *
 * This function NEVER throws and NEVER does I/O.
 */
export function getCachedSecret(name: string): string | null {
  if (!state.cache) return null;
  const v = state.cache.values[name];
  return typeof v === "string" && v.length > 0 ? v : null;
}

export type SecretsHealth = {
  awsEnabled: boolean;
  awsConnected: boolean;
  cacheLoaded: boolean;
  fallbackMode: "aws_primary" | "env_only" | "env_fallback_after_failure";
  lastRefreshAtUtc: string | null;
  lastErrorCode:
    | "access_denied"
    | "not_found"
    | "network"
    | "unknown"
    | "decode"
    | null;
  /** Bounded count of keys hydrated. NEVER the names. NEVER the values. */
  cachedKeyCount: number;
  /** Configured secret name. Operator-visible; no secret values. */
  secretName: string | null;
  region: string;
  degraded: boolean;
};

export function getSecretsHealth(): SecretsHealth {
  const cachedKeyCount = state.cache
    ? Object.keys(state.cache.values).length
    : 0;
  const degraded =
    state.awsEnabled &&
    (state.fallbackMode === "env_only" ||
      state.fallbackMode === "env_fallback_after_failure");
  return {
    awsEnabled: state.awsEnabled,
    awsConnected: state.awsConnected,
    cacheLoaded: state.cacheLoaded,
    fallbackMode: state.fallbackMode,
    lastRefreshAtUtc: state.cache?.lastRefreshAtUtc ?? null,
    lastErrorCode: state.lastError?.code ?? null,
    cachedKeyCount,
    secretName: state.awsEnabled ? configuredSecretName() : null,
    region: configuredRegion(),
    degraded,
  };
}

/**
 * Test-only utility. Clears the in-memory state so the next test
 * suite's `initSecretsManager` call starts from zero. NOT exported
 * from the package index — only reachable by deep import from
 * test files.
 */
export function __resetSecretsManagerForTests(): void {
  if (state.refreshTimer) clearInterval(state.refreshTimer);
  state.awsEnabled = false;
  state.awsConnected = false;
  state.cacheLoaded = false;
  state.fallbackMode = "env_only";
  state.cache = null;
  state.lastError = null;
  state.refreshTimer = null;
  _client = null;
}
