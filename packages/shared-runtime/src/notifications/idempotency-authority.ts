/**
 * PHASE 12 — POINT 5: the dedicated email-idempotency authority.
 *
 * WHY THIS IS ITS OWN SECRET AND ITS OWN MODULE
 * ---------------------------------------------------------------------------
 * The previous key derivation reached for whichever secret happened to be
 * configured — the communications recipient-hash secret, then the identity
 * hash secret, then `AUTH_JWT_SECRET`, then an unkeyed digest. Every step of
 * that chain is wrong for a different reason:
 *
 *   * `AUTH_JWT_SECRET` signs SESSIONS. Deriving a value from it that is then
 *     transmitted to a third party in an HTTP header widens the blast radius
 *     of that secret to a vendor's log retention policy, for no benefit.
 *   * Borrowing another subsystem's secret couples two rotation schedules. The
 *     day communications rotates its hash secret, every in-flight email
 *     idempotency key silently changes — and a retry with a changed key is not
 *     a retry, it is a second email.
 *   * The unkeyed fallback made the key a confirmable guess: email addresses
 *     come from an enumerable space, so an unkeyed digest of one is a
 *     reversible identifier in practice.
 *
 * So there is one dedicated secret, `EMAIL_IDEMPOTENCY_SECRET`, used for
 * nothing else, and production fails closed without it.
 *
 * THE STORED KEY IS THE AUTHORITY
 * ---------------------------------------------------------------------------
 * Minting is not the guarantee — STORING is. A key derived fresh on every
 * attempt is stable only for as long as every one of its inputs is, and the
 * inputs (secret, version, attempt counter) are exactly the things that
 * change. So a durable intent MINTS its key once, at creation, and persists it
 * on its own row; every retry LOADS it.
 *
 * That makes secret rotation safe by construction: an intent created before a
 * rotation keeps the key it was sent with, because nothing re-derives it. New
 * intents pick up the new version. The version tag is carried in the key
 * itself so an operator reading a provider log can tell which generation a
 * message belongs to without holding either secret.
 */

import { createHmac } from "node:crypto";

// ===========================================================================
// Errors
// ===========================================================================

/**
 * Thrown when production has no dedicated secret configured.
 *
 * Failing closed is the correct behaviour: the alternative is sending mail
 * whose retries can duplicate, which is a user-visible defect that no log line
 * would explain.
 */
export class EmailIdempotencyNotConfiguredError extends Error {
  constructor() {
    super(
      "EMAIL_IDEMPOTENCY_SECRET is not configured. Provider idempotency keys " +
        "cannot be minted, so no email may be sent: a send without a stable " +
        "key cannot be retried safely.",
    );
    this.name = "EmailIdempotencyNotConfiguredError";
  }
}

// ===========================================================================
// Secret resolution
// ===========================================================================

type SecretResolver = () => string | undefined;

let secretResolver: SecretResolver | null = null;

/**
 * Register the host's source for `EMAIL_IDEMPOTENCY_SECRET`.
 *
 * `services/api` resolves secrets through its secret manager; the worker reads
 * the environment. Same split as the transport's API-key resolver, same
 * reason: the host knows WHERE, this module knows WHAT TO DO WITH IT.
 */
export function registerEmailIdempotencySecretResolver(
  resolver: SecretResolver,
): void {
  secretResolver = resolver;
}

/** Test seam: drop a registered resolver so a suite starts from the default. */
export function resetEmailIdempotencySecretResolver(): void {
  secretResolver = null;
}

/**
 * The key-generation version.
 *
 * Bumped by configuration when the secret rotates, so that keys minted before
 * and after a rotation are distinguishable in a provider's logs. It changes
 * nothing about ALREADY-STORED keys, which is the whole point.
 */
export function emailIdempotencyKeyVersion(): string {
  const raw = process.env["EMAIL_IDEMPOTENCY_KEY_VERSION"]?.trim();
  return raw && /^[a-z0-9]{1,8}$/i.test(raw) ? raw.toLowerCase() : "v1";
}

/**
 * The explicit, non-secret value used when no secret is configured OUTSIDE
 * production.
 *
 * Deliberately a visible constant rather than a random per-process value:
 * local development and the test suite need keys that are stable across
 * restarts, and a constant that announces itself cannot be mistaken for a
 * production secret in a log or a dump.
 */
export const NON_PRODUCTION_IDEMPOTENCY_SECRET =
  "proovra-non-production-email-idempotency-secret-not-for-deployment";

function isProduction(): boolean {
  return process.env["NODE_ENV"] === "production";
}

export function resolveEmailIdempotencySecret(): string {
  const fromHost = secretResolver?.();
  if (fromHost && fromHost.trim()) return fromHost.trim();
  const fromEnv = process.env["EMAIL_IDEMPOTENCY_SECRET"];
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  if (isProduction()) throw new EmailIdempotencyNotConfiguredError();
  return NON_PRODUCTION_IDEMPOTENCY_SECRET;
}

/** Is a real secret configured? Used by the startup readiness snapshot. */
export function isEmailIdempotencyConfigured(): boolean {
  const fromHost = secretResolver?.();
  if (fromHost && fromHost.trim()) return true;
  const fromEnv = process.env["EMAIL_IDEMPOTENCY_SECRET"];
  return Boolean(fromEnv && fromEnv.trim());
}

// ===========================================================================
// Minting
// ===========================================================================

/**
 * Mint the provider idempotency key for ONE durable delivery intent.
 *
 * Call this ONCE, when the intent is created, and persist the result. Do not
 * call it on a retry — call {@link readStoredIdempotencyKey} instead.
 *
 * `operation` is a bounded constant from the calling module (a template name,
 * a work name). It is the only cleartext in the result and must never be
 * derived from user input.
 *
 * `parts` are the identity of the intent. Prefer a durable row id; where none
 * exists, they may include values that must not be disclosed (a reset URL, an
 * invitation token) — the HMAC is what makes that safe. They must NOT include
 * an attempt counter or anything else that changes between attempts.
 */
export function mintEmailIdempotencyKey(
  operation: string,
  ...parts: ReadonlyArray<string>
): string {
  if (!/^[a-z0-9_]{1,48}$/.test(operation)) {
    throw new Error(`invalid idempotency operation discriminator: ${operation}`);
  }
  const version = emailIdempotencyKeyVersion();
  const digest = createHmac("sha256", resolveEmailIdempotencySecret())
    .update([version, operation, ...parts].join("\0"))
    .digest("hex");
  return `proovra-${operation}-${version}-${digest.slice(0, 40)}`;
}

/** Shape of a well-formed key. Used by callers and by the gates. */
export const EMAIL_IDEMPOTENCY_KEY_PATTERN =
  /^proovra-[a-z0-9_]{1,48}-[a-z0-9]{1,8}-[0-9a-f]{40}$/;

// ===========================================================================
// Persistence
// ===========================================================================

/**
 * The metadata field on `NotificationDelivery` that carries the minted key.
 *
 * A field on the existing durable authority rather than a new column: the row
 * already exists, is already written in the same transaction as the claim, and
 * already carries the attempt marker. Adding a column would buy nothing and
 * cost a migration.
 */
export const STORED_IDEMPOTENCY_KEY_FIELD = "idempotencyKey";

/** Read the persisted key from a durable row's metadata, if it has one. */
export function readStoredIdempotencyKey(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  const value = (metadata as Record<string, unknown>)[
    STORED_IDEMPOTENCY_KEY_FIELD
  ];
  return typeof value === "string" && value ? value : null;
}

/**
 * The key a durable row must use for its NEXT attempt.
 *
 * If the row already carries one, that one — always, and regardless of what
 * the current secret or version would mint. If it does not (a row written
 * before this authority existed), one is minted from the row's own id, which
 * is stable for the life of the row, and the caller persists it.
 */
export function resolveIntentIdempotencyKey(input: {
  metadata: unknown;
  operation: string;
  intentId: string;
}): { key: string; minted: boolean } {
  const stored = readStoredIdempotencyKey(input.metadata);
  if (stored) return { key: stored, minted: false };
  return {
    key: mintEmailIdempotencyKey(input.operation, input.intentId),
    minted: true,
  };
}
