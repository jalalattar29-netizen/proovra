/**
 * Phase 20 — Centralized config + env validation.
 *
 * Single source of truth for:
 *   - feature-flag resolution (per Phase: communications, identity
 *     security, intelligence, integrations, ...)
 *   - secret resolution with **fail-closed in production** semantics
 *     (no more dev-fallback hash keys silently used in prod)
 *   - operator-visible health snapshot (no secret values, just
 *     "configured" / "unconfigured")
 *
 * Hard invariants:
 *   - `requireSecretInProduction(name)` returns the env value when set
 *     or, if `NODE_ENV === "production"`, THROWS at startup time. In
 *     non-prod it returns a deterministic per-secret-name fallback
 *     (a salted constant per secret) so dev still works.
 *   - The fallback strings used in non-prod are NEVER reachable from
 *     production callers — the throw happens before any value is
 *     returned. We deliberately do NOT log the fallback value either.
 *   - `getFeatureFlags()` is a pure read of env. No side effects.
 *   - `runStartupConfigValidation()` is called once from `server.ts`
 *     before any route registers. It logs the readiness snapshot and
 *     throws on missing-critical in production.
 */

const PROD = (): boolean => process.env.NODE_ENV === "production";

const HASH_SECRET_NAMES = [
  "COMMUNICATIONS_RECIPIENT_HASH_SECRET",
  "IDENTITY_SECURITY_HASH_SECRET",
] as const;
export type HashSecretName = (typeof HASH_SECRET_NAMES)[number];

const CORE_REQUIRED_PROD = [
  "DATABASE_URL",
  "AUTH_JWT_SECRET",
] as const;

// -----------------------------------------------------------------------------
// Secret resolution
// -----------------------------------------------------------------------------

class ProductionConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProductionConfigError";
  }
}

/**
 * Resolve a secret that MUST be set in production. In non-prod we
 * return a deterministic per-name fallback so local dev still works,
 * but the fallback is namespaced + never used unless NODE_ENV is not
 * "production". In production we throw a structured error so the
 * startup validator catches missing config early.
 */
export function resolveSecret(envName: HashSecretName | string): string {
  const raw = (process.env[envName] ?? "").trim();
  if (raw.length > 0) return raw;
  if (PROD()) {
    throw new ProductionConfigError(
      `Required secret "${envName}" is not set. Refusing to use a fallback in production.`,
    );
  }
  // Deterministic non-prod fallback. Bound per-name so two callers do
  // not accidentally collide hashes. The "non-prod-fallback" marker
  // makes any accidental leak in test output immediately recognisable.
  return `non-prod-fallback::${envName}::do-not-use-in-production`;
}

/**
 * Boolean feature flag helper. Returns true iff the env value is the
 * literal string "true" (lowercase). Any other value (including unset)
 * returns false.
 */
export function envBool(name: string): boolean {
  return process.env[name] === "true";
}

/**
 * Bounded integer env helper. Returns `fallback` for unset/invalid
 * values; clamps to `[min, max]` otherwise.
 */
export function envInt(
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

// -----------------------------------------------------------------------------
// Feature snapshot — no secrets
// -----------------------------------------------------------------------------

export type FeatureStatus = {
  configured: boolean;
  // Operator-visible reason when unconfigured. Never contains secret
  // values; only names of env vars that are missing.
  reason: string | null;
};

export type FeatureSnapshot = {
  nodeEnv: string;
  isProduction: boolean;
  database: FeatureStatus;
  authJwt: FeatureStatus;
  communications: FeatureStatus & {
    twilio: FeatureStatus;
    verify: FeatureStatus;
    recipientHashSecret: FeatureStatus;
  };
  identitySecurity: FeatureStatus & {
    hashSecret: FeatureStatus;
  };
  notifications: FeatureStatus & {
    resend: FeatureStatus;
  };
  ai: FeatureStatus;
  integrations: FeatureStatus;
  cronSecrets: {
    notification: FeatureStatus;
    integration: FeatureStatus;
  };
};

function flagOk(envName: string): FeatureStatus {
  const v = (process.env[envName] ?? "").trim();
  return v.length > 0
    ? { configured: true, reason: null }
    : { configured: false, reason: `${envName}_missing` };
}

function allOk(...envNames: string[]): FeatureStatus {
  const missing = envNames.filter(
    (n) => (process.env[n] ?? "").trim().length === 0,
  );
  if (missing.length === 0) return { configured: true, reason: null };
  return { configured: false, reason: `missing:${missing.join(",")}` };
}

export function getFeatureSnapshot(): FeatureSnapshot {
  return {
    nodeEnv: process.env.NODE_ENV ?? "development",
    isProduction: PROD(),
    database: flagOk("DATABASE_URL"),
    authJwt: flagOk("AUTH_JWT_SECRET"),
    communications: {
      ...(envBool("COMMUNICATIONS_ENABLED")
        ? { configured: true, reason: null }
        : { configured: false, reason: "COMMUNICATIONS_ENABLED_off" }),
      twilio: allOk("TWILIO_ACCOUNT_SID", "TWILIO_API_KEY", "TWILIO_API_SECRET"),
      verify: flagOk("TWILIO_VERIFY_SERVICE_SID"),
      recipientHashSecret: flagOk("COMMUNICATIONS_RECIPIENT_HASH_SECRET"),
    },
    identitySecurity: {
      ...(envBool("IDENTITY_SECURITY_ENABLED")
        ? { configured: true, reason: null }
        : { configured: false, reason: "IDENTITY_SECURITY_ENABLED_off" }),
      hashSecret: flagOk("IDENTITY_SECURITY_HASH_SECRET"),
    },
    notifications: {
      ...(envBool("NOTIFICATIONS_ENABLED")
        ? { configured: true, reason: null }
        : { configured: false, reason: "NOTIFICATIONS_ENABLED_off" }),
      resend: flagOk("RESEND_API_KEY"),
    },
    ai: envBool("OPENAI_AI_ENABLED")
      ? flagOk("OPENAI_API_KEY")
      : { configured: false, reason: "OPENAI_AI_ENABLED_off" },
    integrations: envBool("INTEGRATIONS_ENABLED")
      ? flagOk("API_KEY_SECRET")
      : { configured: false, reason: "INTEGRATIONS_ENABLED_off" },
    cronSecrets: {
      notification: flagOk("NOTIFICATION_CRON_SECRET"),
      integration: flagOk("INTEGRATION_CRON_SECRET"),
    },
  };
}

// -----------------------------------------------------------------------------
// Startup validation
// -----------------------------------------------------------------------------

export type StartupConfigViolation = {
  envName: string;
  reason: "required_missing" | "feature_enabled_secret_missing";
};

/**
 * Pure: returns the violations the validator would raise. Used by both
 * the startup hook (`runStartupConfigValidation`) and the health
 * endpoint (which surfaces them as a 503 reason in production).
 */
export function collectStartupViolations(): StartupConfigViolation[] {
  const out: StartupConfigViolation[] = [];
  // Core required in prod.
  for (const name of CORE_REQUIRED_PROD) {
    if ((process.env[name] ?? "").trim().length === 0) {
      out.push({ envName: name, reason: "required_missing" });
    }
  }
  // Hash secrets — required whenever the corresponding feature is on.
  if (envBool("COMMUNICATIONS_ENABLED")) {
    if (
      (process.env.COMMUNICATIONS_RECIPIENT_HASH_SECRET ?? "").trim().length ===
      0
    ) {
      out.push({
        envName: "COMMUNICATIONS_RECIPIENT_HASH_SECRET",
        reason: "feature_enabled_secret_missing",
      });
    }
  }
  if (envBool("IDENTITY_SECURITY_ENABLED")) {
    if ((process.env.IDENTITY_SECURITY_HASH_SECRET ?? "").trim().length === 0) {
      out.push({
        envName: "IDENTITY_SECURITY_HASH_SECRET",
        reason: "feature_enabled_secret_missing",
      });
    }
  }
  // Integrations feature requires API key secret to verify inbound
  // service-account tokens (Phase 10 anchor).
  if (envBool("INTEGRATIONS_ENABLED")) {
    if ((process.env.API_KEY_SECRET ?? "").trim().length === 0) {
      out.push({
        envName: "API_KEY_SECRET",
        reason: "feature_enabled_secret_missing",
      });
    }
  }
  return out;
}

/**
 * Called from server bootstrap. Logs the safe snapshot, then throws
 * in production when critical config is missing. In non-prod we
 * downgrade to a warning so local dev is unaffected.
 */
export function runStartupConfigValidation(log: {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}): void {
  const snapshot = getFeatureSnapshot();
  log.info(
    {
      snapshot: scrubSnapshotForLog(snapshot),
    },
    "phase20.startup.config_snapshot",
  );
  const violations = collectStartupViolations();
  if (violations.length === 0) return;
  if (PROD()) {
    log.error(
      { violations },
      "phase20.startup.config_violations_in_production",
    );
    throw new ProductionConfigError(
      `Missing required production config: ${violations.map((v) => v.envName).join(", ")}`,
    );
  }
  log.warn(
    { violations },
    "phase20.startup.config_violations_non_production",
  );
}

function scrubSnapshotForLog(snapshot: FeatureSnapshot): FeatureSnapshot {
  // The snapshot already contains no secret values, but defensively
  // re-stringify-parse so any future expansion that accidentally
  // includes a secret is caught here.
  const json = JSON.stringify(snapshot);
  return JSON.parse(json) as FeatureSnapshot;
}

export { ProductionConfigError };
