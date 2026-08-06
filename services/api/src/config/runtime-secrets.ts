/**
 * Phase P2.0 — Typed runtime secret accessor.
 *
 * Synchronous, in-process secret resolver. Order of precedence:
 *
 *   1. AWS Secrets Manager cache (when AWS_SECRETS_ENABLED=true and
 *      hydration succeeded).
 *   2. `process.env[name]`.
 *   3. (Optional) caller-provided default.
 *
 * Used by call-sites that previously read `process.env.X` directly.
 * Replacement is INCREMENTAL — we migrate the high-risk set first
 * (OPENAI_API_KEY, AUTH_JWT_SECRET, STRIPE_SECRET_KEY, PAYPAL_SECRET,
 * RESEND_API_KEY). Other secrets keep reading env until they're
 * deliberately migrated.
 *
 * `MIGRATED_SECRETS` is the bounded allowlist — adding a new secret
 * to this list is the explicit "this secret is now sourced from
 * Secrets Manager too" signal. Adding a name that isn't in the list
 * STILL works (falls back to env), but the audit pattern is to add
 * the name here.
 *
 * Hard rules:
 *   * NEVER log the resolved value.
 *   * NEVER include the value in thrown errors.
 *   * NEVER return a default unless the caller explicitly opted in.
 *   * NEVER memoise across requests at this layer — the secrets
 *     manager cache is the only memoisation; this function is
 *     stateless beyond that.
 */

import { getCachedSecret } from "./secrets-manager.js";
import { bump } from "../services/ops/metrics.service.js";

// ---------------------------------------------------------------------------
// Bounded migration allowlist — the "moved to Secrets Manager" set
// ---------------------------------------------------------------------------

export const MIGRATED_SECRETS = [
  // Phase P2.0 — first migration wave.
  "OPENAI_API_KEY",
  "AUTH_JWT_SECRET",
  "STRIPE_SECRET_KEY",
  "PAYPAL_SECRET",
  "RESEND_API_KEY",
  // PHASE 12 POINT 5 — dedicated provider idempotency secret. Used for nothing
  // else, rotated on its own schedule, never substituted by another secret.
  "EMAIL_IDEMPOTENCY_SECRET",
  // Phase P2.0B — second migration wave. These names exist in
  // runtime code today (webhook signature verification, Twilio +
  // PayPal client config, cron secret tokens, internal API key).
  // Adding to this list is safe: env fallback is preserved, no
  // call-site change is required for these to be RESOLVED from AWS
  // first if present — the existing call-sites that read
  // `process.env.X` continue to work, but new call-sites that go
  // through `getSecret()` (and the audit surface) will now report
  // these names too. Individual call-sites can be flipped to
  // `getSecret()` opportunistically.
  "STRIPE_WEBHOOK_SECRET",
  "PAYPAL_CLIENT_ID",
  "PAYPAL_WEBHOOK_ID",
  "TWILIO_API_KEY",
  "TWILIO_API_SECRET",
  "TWILIO_AUTH_TOKEN",
  "API_KEY_SECRET",
  "NOTIFICATION_CRON_SECRET",
  "INTEGRATION_CRON_SECRET",
  "REVIEWER_OPS_CRON_SECRET",
] as const;

export type MigratedSecretName = (typeof MIGRATED_SECRETS)[number];

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export type SecretSource = "aws" | "env" | "missing";

export type SecretResolution =
  | { source: "aws"; value: string }
  | { source: "env"; value: string }
  | { source: "missing"; value: null };

/**
 * Resolve a named secret. Returns the value + a bounded source label
 * the operator can audit. NEVER throws on a missing secret; the
 * caller decides whether absence is an error.
 */
export function resolveRuntimeSecret(name: string): SecretResolution {
  const fromAws = getCachedSecret(name);
  if (fromAws !== null) {
    return { source: "aws", value: fromAws };
  }
  const fromEnv = (process.env[name] ?? "").trim();
  if (fromEnv.length > 0) {
    // Bump the fallback metric ONLY when AWS is enabled — if AWS is
    // off entirely, env is the canonical source and the "fallback"
    // label would be misleading.
    if ((process.env.AWS_SECRETS_ENABLED ?? "").toLowerCase() === "true") {
      bump("secrets_fallback_total");
    }
    return { source: "env", value: fromEnv };
  }
  return { source: "missing", value: null };
}

/**
 * Convenience getter — returns the string when present, null when
 * absent. Callers must NEVER pass the returned value to a log.
 */
export function getSecret(name: string): string | null {
  const r = resolveRuntimeSecret(name);
  return r.source === "missing" ? null : r.value;
}

/**
 * Required-secret variant. Throws when missing. The error message
 * carries ONLY the secret name (never the value, never any AWS
 * error chain). This is the right call when the route layer would
 * otherwise produce a 5xx anyway.
 */
export function requireSecret(name: string): string {
  const v = getSecret(name);
  if (v === null) {
    throw new Error(`Required secret "${name}" is not configured.`);
  }
  return v;
}

/**
 * Resolution audit — used by the secrets-health route. Surfaces the
 * per-secret resolution source WITHOUT exposing values.
 */
export function getMigratedSecretsAudit(): ReadonlyArray<{
  name: MigratedSecretName;
  source: SecretSource;
  present: boolean;
}> {
  return MIGRATED_SECRETS.map((name) => {
    const r = resolveRuntimeSecret(name);
    return {
      name,
      source: r.source,
      present: r.source !== "missing",
    };
  });
}
