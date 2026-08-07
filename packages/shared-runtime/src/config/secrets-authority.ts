/**
 * PHASE 12 CORRECTIVE PASS §4 (SEC-004) — THE ONE SECRETS AUTHORITY.
 *
 * The finding
 * ---------------------------------------------------------------------------
 * The loader lived in `services/api/src/config/secrets-manager.ts`. The API
 * initialised it at boot; the Worker did not, and could not — a service cannot
 * import another service's private module. So the two processes of one
 * deployment could resolve their secrets from DIFFERENT authorities: the API
 * from Secrets Manager, the Worker from whatever `process.env` happened to
 * hold. A deployment that declares `required` was therefore only half
 * required, and the half that was not is the half that signs PDFs and sends
 * mail.
 *
 * This module is the relocation of that loader into the shared runtime, which
 * both services already depend on. There is ONE implementation. The API's
 * former module is now a re-export of this one and contains no logic; the
 * Worker calls the same `initSecretsAuthority`.
 *
 * The declared mode, and what each one promises
 * ---------------------------------------------------------------------------
 *   disabled  Environment variables ARE the authority. The provider is never
 *             consulted and the AWS SDK is never even loaded. Local
 *             development, tests, and any deployment that injects secrets at
 *             the orchestrator.
 *   optional  The secret store is PREFERRED and the environment is a DECLARED,
 *             acceptable fallback. Boot proceeds on failure, and readiness
 *             says `degraded` rather than pretending. An `access_denied`
 *             suspends the refresh loop: an IAM decision does not become a
 *             different decision because we ask again in an hour, and an
 *             hourly unauthorized call is both noise and a finding.
 *   required  The secret store IS the authority. A failed hydration fails
 *             startup CLOSED, before anything consumes a secret, because
 *             there is nothing to fall back to.
 *
 * `AWS_SECRETS_ENABLED` keeps its meaning so no deployment changes behaviour on
 * upgrade: `true` maps to `optional`, which is exactly what it did before. The
 * mapping is explicit and temporary — `AWS_SECRETS_MODE` is the forward name,
 * and `describeLegacyModeMapping()` reports when a process is running on the
 * legacy variable so the migration is visible rather than assumed.
 *
 * Ordering
 * ---------------------------------------------------------------------------
 * `initSecretsAuthority` RESOLVES before any caller may read a secret, and in
 * `required` mode it throws before returning. `assertSecretsAuthorityReady()`
 * makes that ordering checkable rather than conventional: a consumer that runs
 * before hydration gets an explicit error instead of an empty cache that looks
 * like "the key is not configured".
 *
 * Security posture (unchanged, and now shared rather than duplicated)
 * ---------------------------------------------------------------------------
 *   * No secret value is logged, thrown, or serialised.
 *   * Secret NAMES inside the bundle are never logged — only a count.
 *   * Provider errors are mapped to a bounded code so IAM ARNs and endpoint
 *     URLs cannot reach an operator surface.
 */

import { bump } from "../ops/metrics.service.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEFAULT_REFRESH_TTL_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_SECRET_NAME = "proovra/prod/app-secrets";
const MAX_REFRESH_TTL_MS = 24 * 60 * 60 * 1000;

export type SecretsAuthorityMode = "disabled" | "optional" | "required";

export type SecretsErrorCode =
  | "access_denied"
  | "not_found"
  | "network"
  | "unknown"
  | "decode";

export type SecretsFallbackMode =
  | "aws_primary"
  | "env_only"
  | "env_fallback_after_failure";

export function declaredSecretsMode(): SecretsAuthorityMode {
  const explicit = (process.env["AWS_SECRETS_MODE"] ?? "").trim().toLowerCase();
  if (
    explicit === "required" ||
    explicit === "optional" ||
    explicit === "disabled"
  ) {
    return explicit;
  }
  if (explicit.length > 0) {
    // Guessing which mode was meant is how a `required` deployment silently
    // becomes `optional`.
    throw new Error(`aws_secrets.invalid_mode:${explicit.slice(0, 32)}`);
  }
  return legacyEnabled() ? "optional" : "disabled";
}

function legacyEnabled(): boolean {
  return (
    (process.env["AWS_SECRETS_ENABLED"] ?? "").trim().toLowerCase() === "true"
  );
}

/**
 * Whether this process's mode came from the LEGACY variable rather than the
 * forward one. Reported in readiness so "we are still on the old switch" is a
 * fact an operator can see, not something a migration has to remember.
 */
export function describeLegacyModeMapping(): {
  usingLegacyVariable: boolean;
  legacyValue: string | null;
  mappedTo: SecretsAuthorityMode | null;
} {
  const explicit = (process.env["AWS_SECRETS_MODE"] ?? "").trim();
  if (explicit.length > 0) {
    return { usingLegacyVariable: false, legacyValue: null, mappedTo: null };
  }
  const raw = process.env["AWS_SECRETS_ENABLED"];
  if (raw === undefined) {
    return { usingLegacyVariable: false, legacyValue: null, mappedTo: null };
  }
  return {
    usingLegacyVariable: true,
    legacyValue: raw.trim().slice(0, 16),
    mappedTo: legacyEnabled() ? "optional" : "disabled",
  };
}

export function configuredSecretName(): string {
  return (process.env["AWS_SECRET_NAME"] ?? "").trim() || DEFAULT_SECRET_NAME;
}

export function configuredSecretsRegion(): string {
  // Precedence: Secrets-Manager-specific override → app-wide region → the
  // region the secret is hosted in. The KMS signer reads AWS_REGION itself and
  // is never mutated here, so Secrets Manager can live in one region while
  // signing lives in another.
  const specific = (process.env["AWS_SECRETS_REGION"] ?? "").trim();
  if (specific.length > 0) return specific;
  const generic = (process.env["AWS_REGION"] ?? "").trim();
  if (generic.length > 0) return generic;
  return "us-east-1";
}

function refreshTtlMs(): number {
  const raw = Number.parseInt(
    (process.env["AWS_SECRETS_REFRESH_TTL_MS"] ??
      process.env["SECRETS_REFRESH_TTL_MS"] ??
      "") as string,
    10,
  );
  if (!Number.isFinite(raw) || raw < 60_000) return DEFAULT_REFRESH_TTL_MS;
  // Upper bound so a typo cannot pin a stale secret indefinitely.
  return Math.min(raw, MAX_REFRESH_TTL_MS);
}

// ---------------------------------------------------------------------------
// The provider seam
// ---------------------------------------------------------------------------

export type SecretsFetchResult = { secretString: string | null };

/**
 * How a secret bundle is obtained. A seam, not an abstraction for its own
 * sake: it is what lets the harness prove all nine bootstrap outcomes —
 * including `access_denied` and a malformed payload — against a RECORDING
 * provider, with no AWS account, no credentials and no network.
 */
export type SecretsProvider = (input: {
  secretName: string;
  region: string;
}) => Promise<SecretsFetchResult>;

let providerOverride: SecretsProvider | null = null;

/**
 * Install a provider for this process.
 *
 * Deliberately NOT named `…ForTests`: the local/disposable rehearsal harness is
 * a legitimate caller, and a name that says "tests only" invites a second,
 * unnamed seam for the harness. What makes it safe is that it is never called
 * from service bootstrap code — enforced by `phase-12-secrets-authority.test.ts`,
 * which parses both services and fails if either references it.
 */
export function setSecretsProvider(provider: SecretsProvider | null): void {
  providerOverride = provider;
}

/**
 * The default provider: AWS Secrets Manager, imported LAZILY.
 *
 * Lazy because `disabled` — which is every test process and every local
 * developer — must never load the SDK, never construct a client, and never
 * touch the credential chain. An eager module-level import would do all three
 * before anyone declared a mode.
 */
const awsProvider: SecretsProvider = async ({ secretName, region }) => {
  const { GetSecretValueCommand, SecretsManagerClient } = await import(
    "@aws-sdk/client-secrets-manager"
  );
  // Credentials come from the standard SDK chain (env → shared config → IAM
  // role); this module never reads AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY
  // itself, so the chain stays canonical and nothing here can log a key.
  let client = awsClient as InstanceType<typeof SecretsManagerClient> | null;
  if (!client || awsClientRegion !== region) {
    client = new SecretsManagerClient({ region, maxAttempts: 2 });
    awsClient = client;
    awsClientRegion = region;
  }
  const res = await client.send(
    new GetSecretValueCommand({ SecretId: secretName }),
  );
  return { secretString: res.SecretString ?? null };
};

/**
 * Typed `unknown` so this module holds no eager type reference to the AWS SDK
 * — the whole point of the lazy import is that a `disabled` process never
 * loads it. The one place the concrete type is needed is inside the provider
 * above, after the dynamic import has already happened.
 */
let awsClient: unknown = null;
let awsClientRegion: string | null = null;

function activeProvider(): SecretsProvider {
  return providerOverride ?? awsProvider;
}

// ---------------------------------------------------------------------------
// Error classification — bounded vocabulary
// ---------------------------------------------------------------------------

export function classifySecretsError(err: unknown): SecretsErrorCode {
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
// State
// ---------------------------------------------------------------------------

type CacheState = {
  values: Record<string, string>;
  lastRefreshAtUtc: string;
  source: "aws_secrets_manager";
};

type LoaderState = {
  initialised: boolean;
  declaredMode: SecretsAuthorityMode;
  suspendedReason: "access_denied" | null;
  awsEnabled: boolean;
  awsConnected: boolean;
  cacheLoaded: boolean;
  fallbackMode: SecretsFallbackMode;
  cache: CacheState | null;
  lastError: { code: SecretsErrorCode; occurredAtUtc: string } | null;
  refreshTimer: ReturnType<typeof setInterval> | null;
  /** Consecutive transient failures, for the bounded backoff. */
  transientFailures: number;
};

const state: LoaderState = {
  initialised: false,
  declaredMode: "disabled",
  suspendedReason: null,
  awsEnabled: false,
  awsConnected: false,
  cacheLoaded: false,
  fallbackMode: "env_only",
  cache: null,
  lastError: null,
  refreshTimer: null,
  transientFailures: 0,
};

export type SecretsLogShape = {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
};

// ---------------------------------------------------------------------------
// Hydration
// ---------------------------------------------------------------------------

function recordFailure(code: SecretsErrorCode): void {
  state.lastError = { code, occurredAtUtc: new Date().toISOString() };
  state.awsConnected = false;
  // A previously-successful hydration is NOT discarded on a later failure:
  // the values in hand are still the ones the authority gave us.
  state.fallbackMode = state.cacheLoaded
    ? "env_fallback_after_failure"
    : "env_only";
  bump("secrets_fetch_failure_total");
}

async function hydrateOnce(log: SecretsLogShape): Promise<void> {
  if (!state.awsEnabled) return;
  const secretName = configuredSecretName();
  const region = configuredSecretsRegion();
  log.info({ secretName, region }, "aws_secrets.hydration_started");
  try {
    const { secretString } = await activeProvider()({ secretName, region });
    if (!secretString) {
      // Binary secrets are not supported; the contract is a JSON object.
      recordFailure("decode");
      log.warn({ reason: "empty_secret_string" }, "aws_secrets.hydration_failed");
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(secretString);
    } catch {
      recordFailure("decode");
      log.warn({ reason: "json_parse_failed" }, "aws_secrets.hydration_failed");
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      recordFailure("decode");
      log.warn({ reason: "not_a_json_object" }, "aws_secrets.hydration_failed");
      return;
    }
    const values: Record<string, string> = {};
    let keyCount = 0;
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string") {
        values[k] = v;
        keyCount += 1;
      }
    }
    // PARTIAL HYDRATION CANNOT LEAVE A MISMATCHED AUTHORITY.
    //
    // The bundle is swapped in as ONE value. A per-key merge would let a
    // truncated payload leave half the process on the store's values and half
    // on the environment's, which is the exact split SEC-004 is about — only
    // inside a single process instead of between two.
    state.cache = {
      values,
      lastRefreshAtUtc: new Date().toISOString(),
      source: "aws_secrets_manager",
    };
    state.cacheLoaded = true;
    state.awsConnected = true;
    state.fallbackMode = "aws_primary";
    state.lastError = null;
    state.transientFailures = 0;
    bump("secrets_fetch_success_total");
    log.info({ keyCount }, "aws_secrets.hydration_succeeded");
  } catch (err) {
    const code = classifySecretsError(err);
    recordFailure(code);
    bump("secrets_fallback_total");
    log.warn({ code }, "aws_secrets.hydration_failed");
  }
}

/**
 * Bounded backoff for TRANSIENT failures only.
 *
 * `network` and `unknown` are retried with a growing delay, capped, so a
 * store that is briefly unreachable recovers without a tight loop.
 * `access_denied` is not transient and suspends instead. `not_found` and
 * `decode` keep the normal cadence deliberately: an operator can create the
 * secret or fix its body without a redeploy, and the call is authorized.
 */
function nextRefreshDelayMs(): number {
  const base = refreshTtlMs();
  if (state.transientFailures === 0) return base;
  const factor = Math.min(2 ** state.transientFailures, 8);
  return Math.min(base * factor, MAX_REFRESH_TTL_MS);
}

async function refreshOnce(log: SecretsLogShape): Promise<void> {
  if (!state.awsEnabled) return;
  if (state.suspendedReason) {
    bump("secrets_refresh_suspended_total");
    return;
  }
  bump("secrets_cache_refresh_total");
  await hydrateOnce(log);
  const code = state.lastError?.code ?? null;
  if (code === "access_denied") {
    state.suspendedReason = "access_denied";
    log.warn({ code: "access_denied" }, "aws_secrets.refresh_suspended_until_restart");
    return;
  }
  if (code === "network" || code === "unknown") {
    state.transientFailures = Math.min(state.transientFailures + 1, 8);
  }
}

function scheduleRefresh(log: SecretsLogShape): void {
  if (state.refreshTimer) clearInterval(state.refreshTimer);
  state.refreshTimer = setInterval(() => {
    void refreshOnce(log).then(() => {
      // Re-arm at the backoff-adjusted cadence when the delay changed.
      const desired = nextRefreshDelayMs();
      if (desired !== refreshTtlMs() && state.refreshTimer) {
        clearInterval(state.refreshTimer);
        state.refreshTimer = setInterval(() => void refreshOnce(log), desired);
        state.refreshTimer.unref?.();
      }
    });
  }, refreshTtlMs());
  // The timer must never be the reason a process cannot exit.
  state.refreshTimer.unref?.();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Hydrate this process's secret authority. Call ONCE, from bootstrap, and
 * AWAIT it before anything reads a secret.
 *
 * In `required` mode this THROWS when the authority is unavailable — that is
 * the point of the mode, and it happens before the caller can start serving.
 */
export async function initSecretsAuthority(log: SecretsLogShape): Promise<void> {
  state.declaredMode = declaredSecretsMode();
  state.awsEnabled = state.declaredMode !== "disabled";
  state.initialised = true;
  if (!state.awsEnabled) {
    state.fallbackMode = "env_only";
    log.info({ mode: state.declaredMode }, "aws_secrets.disabled");
    return;
  }
  await hydrateOnce(log);

  if (state.declaredMode === "required" && !state.awsConnected) {
    // Fail CLOSED, before the caller serves anything. The bounded code is
    // included so an operator knows whether to fix IAM, the secret name, or
    // the payload — and no ARN, endpoint or value is in the message.
    throw new Error(
      `aws_secrets.required_authority_unavailable:${state.lastError?.code ?? "unknown"}`,
    );
  }

  if (state.lastError?.code === "access_denied") {
    // An optional deployment that was refused does not spend the rest of its
    // life asking again.
    state.suspendedReason = "access_denied";
    log.warn({ code: "access_denied" }, "aws_secrets.refresh_suspended_until_restart");
    return;
  }
  scheduleRefresh(log);
}

/**
 * Force a refresh now. Exposed so an operator action and the rehearsal harness
 * exercise the SAME path the timer does, rather than a parallel one.
 */
export async function refreshSecretsAuthority(log: SecretsLogShape): Promise<void> {
  await refreshOnce(log);
}

/** Stop the refresh timer. Idempotent; safe to call during shutdown. */
export function stopSecretsAuthority(): void {
  if (state.refreshTimer) clearInterval(state.refreshTimer);
  state.refreshTimer = null;
}

/**
 * Synchronous, in-memory lookup. Returns null when the name is not in the
 * hydrated bundle; the caller falls back to `process.env`. Never throws,
 * never does I/O.
 */
export function getCachedSecret(name: string): string | null {
  if (!state.cache) return null;
  const v = state.cache.values[name];
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Refuse to answer before hydration has been established.
 *
 * Without this, a consumer that runs before `initSecretsAuthority` sees an
 * empty cache and silently falls back to the environment — indistinguishable
 * from "this deployment declares env as its authority". Ordering becomes a
 * checkable fact instead of a convention.
 */
export function assertSecretsAuthorityReady(): void {
  if (!state.initialised) {
    throw new Error("aws_secrets.read_before_hydration");
  }
}

export type SecretsHealth = {
  mode: SecretsAuthorityMode;
  refreshSuspended: boolean;
  awsEnabled: boolean;
  awsConnected: boolean;
  cacheLoaded: boolean;
  fallbackMode: SecretsFallbackMode;
  lastRefreshAtUtc: string | null;
  lastErrorCode: SecretsErrorCode | null;
  /** Bounded count of keys hydrated. NEVER the names. NEVER the values. */
  cachedKeyCount: number;
  secretName: string | null;
  region: string;
  degraded: boolean;
  /** True once `initSecretsAuthority` has resolved in this process. */
  initialised: boolean;
  usingLegacyEnabledVariable: boolean;
};

/**
 * The readiness contract BOTH services report. Identical shape, identical
 * derivation — so "API and Worker agree" is something an operator can check by
 * comparing two documents rather than by reading two codebases.
 */
export function getSecretsHealth(): SecretsHealth {
  const cachedKeyCount = state.cache ? Object.keys(state.cache.values).length : 0;
  const degraded =
    state.awsEnabled &&
    (state.fallbackMode === "env_only" ||
      state.fallbackMode === "env_fallback_after_failure");
  return {
    mode: state.declaredMode,
    refreshSuspended: state.suspendedReason !== null,
    awsEnabled: state.awsEnabled,
    awsConnected: state.awsConnected,
    cacheLoaded: state.cacheLoaded,
    fallbackMode: state.fallbackMode,
    lastRefreshAtUtc: state.cache?.lastRefreshAtUtc ?? null,
    lastErrorCode: state.lastError?.code ?? null,
    cachedKeyCount,
    secretName: state.awsEnabled ? configuredSecretName() : null,
    region: configuredSecretsRegion(),
    degraded,
    initialised: state.initialised,
    usingLegacyEnabledVariable: describeLegacyModeMapping().usingLegacyVariable,
  };
}

/** Clears in-process state so a harness can drive a fresh bootstrap. */
export function resetSecretsAuthority(): void {
  if (state.refreshTimer) clearInterval(state.refreshTimer);
  state.initialised = false;
  state.declaredMode = "disabled";
  state.suspendedReason = null;
  state.awsEnabled = false;
  state.awsConnected = false;
  state.cacheLoaded = false;
  state.fallbackMode = "env_only";
  state.cache = null;
  state.lastError = null;
  state.refreshTimer = null;
  state.transientFailures = 0;
  awsClient = null;
  awsClientRegion = null;
  providerOverride = null;
}
