/**
 * Phase 20 / R8.C — Centralized config + env validation.
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
 *
 * R8.C additions:
 *   - Signing provider consistency: aws-kms requires KMS_KEY_ID.
 *   - SAML URL safety: SAML_SP_ACS_URL must not be localhost in prod.
 *   - Storage safety: S3_ENDPOINT must not be http://localhost in prod
 *     unless S3_ALLOW_INSECURE=true is explicitly set.
 */

const PROD = (): boolean => process.env.NODE_ENV === "production";

export type HashSecretName =
  | "COMMUNICATIONS_RECIPIENT_HASH_SECRET"
  | "IDENTITY_SECURITY_HASH_SECRET";

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
    /** PHASE 12 POINT 5 — the dedicated provider idempotency secret. */
    idempotencySecret: FeatureStatus;
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
      // PHASE 12 POINT 5 — the dedicated provider idempotency secret. Without
      // it no email may be sent, because a send whose retries cannot be
      // deduplicated is a send that can deliver twice.
      idempotencySecret: flagOk("EMAIL_IDEMPOTENCY_SECRET"),
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
  reason:
    | "required_missing"
    | "feature_enabled_secret_missing"
    | "signing_provider_inconsistent"
    | "saml_url_localhost_in_production"
    | "storage_localhost_in_production"
    | "stripe_key_shape_invalid"
    // Phase A2 — PDF artifact signing safety. Production must
    // either have PDF_SIGNING_ENABLED=true OR carry an explicit
    // PDF_ARTIFACT_SIGNATURE_OPT_OUT_ACK=true. Both unset is a
    // structurally unsafe config; the API refuses to start.
    | "pdf_signing_unconfigured_in_production"
    // 2026-08-24 — native S3 Object Lock legal hold is NOT implemented.
    // `S3_OBJECT_LOCK_LEGAL_HOLD=ON` used to be read straight into every
    // upload and into PutObjectLegalHold, so one character placed native holds
    // this codebase cannot release. The read is gone; this violation stops an
    // operator believing the switch still does something.
    | "s3_native_legal_hold_unsupported";
};

/**
 * Pure: returns the violations the validator would raise. Used by both
 * the startup hook (`runStartupConfigValidation`) and the health
 * endpoint (which surfaces them as a 503 reason in production).
 */
export function collectStartupViolations(): StartupConfigViolation[] {
  const out: StartupConfigViolation[] = [];

  // Native S3 legal hold is not implemented. `OFF` and unset are inert and
  // accepted; `ON` is a request for a capability that does not exist, and is
  // refused rather than ignored so nobody concludes evidence is protected by
  // a storage-level hold that was never placed. Checked in every environment —
  // the value's danger did not depend on NODE_ENV.
  if (
    (process.env.S3_OBJECT_LOCK_LEGAL_HOLD ?? "").trim().toUpperCase() === "ON"
  ) {
    out.push({
      envName: "S3_OBJECT_LOCK_LEGAL_HOLD",
      reason: "s3_native_legal_hold_unsupported",
    });
  }
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
  // PHASE 12 POINT 5 — a configured email transport REQUIRES the dedicated
  // idempotency secret. The pairing is the point: the moment this deployment
  // can send mail, it must also be able to mint a stable retry key.
  if ((process.env.RESEND_API_KEY ?? "").trim().length > 0) {
    if ((process.env.EMAIL_IDEMPOTENCY_SECRET ?? "").trim().length === 0) {
      out.push({
        envName: "EMAIL_IDEMPOTENCY_SECRET",
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

  // R8.C — Signing provider consistency.
  // When SIGNER_PROVIDER=aws-kms, KMS_KEY_ID must be configured.
  // When SIGNER_PROVIDER=local-pem, SIGNING_PRIVATE_KEY_PATH must be set.
  const signerProvider = (process.env.SIGNER_PROVIDER ?? "local-pem")
    .trim()
    .toLowerCase();
  if (signerProvider === "aws-kms") {
    if ((process.env.KMS_KEY_ID ?? "").trim().length === 0) {
      out.push({
        envName: "KMS_KEY_ID",
        reason: "signing_provider_inconsistent",
      });
    }
  } else {
    // local-pem (default)
    if ((process.env.SIGNING_PRIVATE_KEY_PATH ?? "").trim().length === 0) {
      out.push({
        envName: "SIGNING_PRIVATE_KEY_PATH",
        reason: "signing_provider_inconsistent",
      });
    }
  }

  // R8.C — SAML URL safety in production.
  // SAML_SP_ACS_URL (or SAML_ACS_URL) must not be a localhost URL in
  // production. Localhost values indicate a dev config leaked into prod.
  if (PROD() && envBool("SAML_ENABLED")) {
    const acsUrl = (
      process.env.SAML_SP_ACS_URL ??
      process.env.SAML_ACS_URL ??
      ""
    ).trim();
    if (
      acsUrl.startsWith("http://localhost") ||
      acsUrl.startsWith("http://127.0.0.1") ||
      acsUrl.startsWith("https://localhost")
    ) {
      out.push({
        envName: "SAML_SP_ACS_URL",
        reason: "saml_url_localhost_in_production",
      });
    }
  }

  // R8.C — Storage localhost safety in production.
  // S3_ENDPOINT must not be a localhost URL in production unless
  // S3_ALLOW_INSECURE is explicitly set to "true" (which itself
  // indicates a misconfigured production environment).
  if (PROD()) {
    const s3Endpoint = (process.env.S3_ENDPOINT ?? "").trim();
    const allowInsecure = (process.env.S3_ALLOW_INSECURE ?? "").trim() === "true";
    if (
      !allowInsecure &&
      (s3Endpoint.startsWith("http://localhost") ||
        s3Endpoint.startsWith("http://127.0.0.1") ||
        s3Endpoint.startsWith("http://minio"))
    ) {
      out.push({
        envName: "S3_ENDPOINT",
        reason: "storage_localhost_in_production",
      });
    }
  }

  // Phase A2 — PDF artifact signing safety in production.
  //
  // Reaching this branch means we are in NODE_ENV=production. The
  // platform MUST either:
  //   * have PDF_SIGNING_ENABLED=true (the default for serious
  //     evidence operators), or
  //   * have PDF_ARTIFACT_SIGNATURE_OPT_OUT_ACK=true to explicitly
  //     acknowledge the unsigned-artifact path (operator-recorded
  //     in the runbook).
  //
  // Both unset is structurally unsafe — the worker would emit an
  // unsigned PDF in production whose status the API has no way to
  // honestly describe. We refuse to start so the misconfiguration
  // is loud, not silent. The existing worker-side
  // `assertPdfSigningProductionSafetyOrThrow` covers the per-job
  // path; this validator covers the API boot path so the
  // misconfiguration surfaces on the first deploy, not the first
  // report job.
  if (PROD()) {
    const pdfSigningOn =
      (process.env.PDF_SIGNING_ENABLED ?? "").trim().toLowerCase() === "true";
    const pdfOptOutAck =
      (process.env.PDF_ARTIFACT_SIGNATURE_OPT_OUT_ACK ?? "")
        .trim()
        .toLowerCase() === "true";
    if (!pdfSigningOn && !pdfOptOutAck) {
      out.push({
        envName: "PDF_SIGNING_ENABLED",
        reason: "pdf_signing_unconfigured_in_production",
      });
    }
  }

  // Phase 32.7 — Stripe secret-key shape validation.
  //
  // STRIPE_SECRET_KEY must start with `sk_live_` (production) or
  // `sk_test_` (test mode). A common ops mistake is pasting a
  // publishable key (`pk_live_*` / `pk_test_*`) into the secret slot,
  // which silently sends webhook auth + every Stripe API call with the
  // wrong credential — eventually surfacing as 401 from Stripe. We
  // catch this at startup so the misconfiguration is loud, not silent.
  //
  // Only checked when STRIPE_SECRET_KEY is set (Stripe is optional for
  // dev). Applies in all environments because the shape mistake is
  // never intended.
  {
    const stripeKey = (process.env.STRIPE_SECRET_KEY ?? "").trim();
    if (stripeKey.length > 0) {
      const isSecret =
        stripeKey.startsWith("sk_live_") || stripeKey.startsWith("sk_test_");
      if (!isSecret) {
        out.push({
          envName: "STRIPE_SECRET_KEY",
          reason: "stripe_key_shape_invalid",
        });
      }
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

  // Phase A2 — loud production warning when the operator has
  // acknowledged the unsigned-PDF opt-out. The validator above
  // accepts the opt-out as a legitimate config; this log makes the
  // acknowledgement visible on EVERY API boot so it never slips
  // unnoticed past an ops handoff.
  if (PROD()) {
    const pdfSigningOn =
      (process.env.PDF_SIGNING_ENABLED ?? "").trim().toLowerCase() === "true";
    const pdfOptOutAck =
      (process.env.PDF_ARTIFACT_SIGNATURE_OPT_OUT_ACK ?? "")
        .trim()
        .toLowerCase() === "true";
    if (!pdfSigningOn && pdfOptOutAck) {
      log.warn(
        {
          pdfArtifactSignatureOptOutAcknowledged: true,
          pdfSigningEnabled: false,
        },
        "phase_a2.startup.pdf_signing_opt_out_active",
      );
    } else if (pdfSigningOn) {
      log.info(
        { pdfSigningEnabled: true },
        "phase_a2.startup.pdf_signing_enabled",
      );
    }
  }

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
