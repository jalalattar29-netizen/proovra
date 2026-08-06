/**
 * PHASE 12 — POINT 5: the durable delivery-attempt state machine.
 *
 * THE PROBLEM THIS SOLVES
 * ---------------------------------------------------------------------------
 * The MFA recovery digest's durable authority was `MfaRecoveryAdminDigestLog`,
 * a row with `UNIQUE (userId, sentDate)` and a `sentAtUtc` column defaulting to
 * `now()`. That row is an excellent CLAIM — the unique constraint is a real
 * atomic one-winner primitive — and a dishonest DELIVERY RECORD, because a row
 * created as a claim is byte-identical to a row that represents a delivered
 * message.
 *
 * The consequence was a lost-message window, not a theoretical one: the sweep
 * inserted the claim, then called the provider. A crash in between left a row
 * that every later tick reads as "today is done". The digest for that admin was
 * silently skipped for the rest of the UTC day, and nothing anywhere recorded
 * that a message had been intended and never sent.
 *
 * WHY `NotificationDelivery` AND NOT A NEW TABLE
 * ---------------------------------------------------------------------------
 * The repository already has a durable delivery-attempt authority with exactly
 * the lifecycle this needs — `NotificationDelivery`, the Phase 8 model that
 * records one row per channel attempt with `status`, `providerMessageId`,
 * `retryCount`, `nextAttemptAtUtc`, `sentAtUtc` and `errorCode`. Adding a
 * second table alongside it would have produced two authorities for the same
 * question, which is the defect this phase exists to remove.
 *
 * THE STATES
 * ---------------------------------------------------------------------------
 * `NotificationDeliveryStatus` has seven values and this state machine needs
 * eight distinctions, because "the request left the process and no answer came
 * back" is not any of them. The missing two are carried on columns that already
 * exist rather than by widening the enum:
 *
 *   claimed       PENDING, no attempt recorded in metadata
 *   in_flight     PENDING, an attempt is recorded and the lease
 *                 (`nextAttemptAtUtc`) has not expired
 *   acknowledged  SENT, `providerMessageId` set, `sentAtUtc` set
 *   retryable     RETRY_SCHEDULED with an ordinary `errorCode`
 *   ambiguous     RETRY_SCHEDULED with `errorCode = provider_ack_unknown`
 *   delivered     DELIVERED — reserved for a provider webhook confirmation,
 *                 which this deployment does not yet receive; the sweep never
 *                 writes it, and does not pretend to
 *   failed        FAILED — permanent, will not be retried
 *   skipped       SKIPPED / CANCELLED — suppressed by preference or policy
 *
 * `expired` is not a stored state but a DERIVED one: an `in_flight` row whose
 * lease has run out is recoverable by another worker. Deriving it rather than
 * storing it means no writer has to remember to expire anything, and a crashed
 * process cannot leave a stale "not expired" marker.
 *
 * THE LEASE IS A COLUMN, NOT A JSON FIELD
 * ---------------------------------------------------------------------------
 * `nextAttemptAtUtc` carries the lease, because a lease that lives in a JSON
 * blob cannot appear in the `WHERE` clause of the conditional update that
 * takes it. The takeover is
 *
 *     UPDATE ... WHERE id = $1
 *                  AND status IN ('PENDING','RETRY_SCHEDULED')
 *                  AND next_attempt_at_utc <= now()
 *
 * and its affected-row count IS the winner election. `metadata.attempt` then
 * carries only the one thing a column cannot: the idempotency key that every
 * retry of this delivery must reuse verbatim.
 */

// ===========================================================================
// Phases
// ===========================================================================

export const DELIVERY_PHASES = [
  "claimed",
  "in_flight",
  "expired",
  "acknowledged",
  "retryable",
  "ambiguous",
  "delivered",
  "failed",
  "skipped",
] as const;

export type DeliveryPhase = (typeof DELIVERY_PHASES)[number];

/**
 * Phases from which no further send is attempted.
 *
 * `acknowledged` is terminal for the SWEEP even though `delivered` exists: the
 * provider has durably accepted the message, and nothing the sweep can do
 * afterwards changes that. `delivered` is terminal for the SYSTEM and only a
 * provider webhook may write it.
 */
export const TERMINAL_DELIVERY_PHASES: ReadonlyArray<DeliveryPhase> = [
  "acknowledged",
  "delivered",
  "failed",
  "skipped",
];

/** The error code that marks an outcome the provider never confirmed. */
export const AMBIGUOUS_ERROR_CODE = "provider_ack_unknown";

/**
 * How long one in-flight attempt may remain unresolved before another worker
 * may take it over.
 *
 * Longer than the transport timeout by a wide margin: the lease exists to
 * recover from a DEAD PROCESS, not from a slow one, and expiring it while the
 * original attempt is still running would produce exactly the concurrent
 * double-send it is meant to prevent. The provider idempotency key makes even
 * that case safe, but a lease that routinely fires is a lease that hides bugs.
 */
export const ATTEMPT_LEASE_MS = 5 * 60 * 1000;

/**
 * How long an ambiguous outcome waits before it is retried.
 *
 * An ambiguous outcome means the provider MAY hold the message. Retrying
 * instantly is safe — the idempotency key collapses it — but pointless, and it
 * turns one dropped socket into a tight loop. The backoff gives the provider
 * time to finish whatever it was doing and gives an operator a window in which
 * the row is visibly ambiguous rather than already re-sent.
 */
export const AMBIGUOUS_RETRY_BACKOFF_MS = 10 * 60 * 1000;

/** `eventType` under which MFA recovery digests are recorded. */
export const MFA_DIGEST_EVENT_TYPE = "mfa_recovery_admin_digest";

/** `templateKey` for the same. */
export const MFA_DIGEST_TEMPLATE_KEY = "mfa_recovery_admin_digest";

// ===========================================================================
// Derivation
// ===========================================================================

/**
 * The subset of a `NotificationDelivery` row this derivation reads.
 *
 * Structural rather than imported from Prisma so the same function can be
 * applied to a row selected with `select`, to a row from a raw query, and to
 * a fixture in a test — without any of them needing the full model type.
 */
export type DeliveryStateRow = {
  status: string;
  providerMessageId?: string | null;
  errorCode?: string | null;
  sentAtUtc?: Date | null;
  deliveredAtUtc?: Date | null;
  /** The lease / next-eligible instant. Null means "not eligible, not leased". */
  nextAttemptAtUtc?: Date | null;
  metadata?: unknown;
};

export type AttemptMarker = {
  /** ISO timestamp at which the outstanding provider call was started. */
  startedAtUtc: string;
  /** The key that call carried, reused verbatim by every retry. */
  idempotencyKey: string;
};

/** Read the attempt marker out of a row's metadata, if it has one. */
export function readAttemptMarker(metadata: unknown): AttemptMarker | null {
  if (!metadata || typeof metadata !== "object") return null;
  const attempt = (metadata as { attempt?: unknown }).attempt;
  if (!attempt || typeof attempt !== "object") return null;
  const startedAtUtc = (attempt as { startedAtUtc?: unknown }).startedAtUtc;
  const idempotencyKey = (attempt as { idempotencyKey?: unknown }).idempotencyKey;
  if (typeof startedAtUtc !== "string" || typeof idempotencyKey !== "string") {
    return null;
  }
  return { startedAtUtc, idempotencyKey };
}

/**
 * Derive the honest phase of a delivery row.
 *
 * `now` is a parameter, not `Date.now()`, so `expired` is testable without
 * clock manipulation and so a projection can derive a whole page of rows
 * against one consistent instant.
 */
export function deriveDeliveryPhase(row: DeliveryStateRow, now: Date): DeliveryPhase {
  switch (row.status) {
    case "DELIVERED":
      return "delivered";
    case "SENT":
      return "acknowledged";
    case "FAILED":
      return "failed";
    case "CANCELLED":
    case "SKIPPED":
      return "skipped";
    case "RETRY_SCHEDULED":
      return row.errorCode === AMBIGUOUS_ERROR_CODE ? "ambiguous" : "retryable";
    case "PENDING": {
      if (!readAttemptMarker(row.metadata)) return "claimed";
      const lease = row.nextAttemptAtUtc;
      // No lease on an attempted row is itself an expiry: whatever set the
      // marker did not set a deadline, so it cannot hold the row forever.
      if (!lease) return "expired";
      return lease.getTime() <= now.getTime() ? "expired" : "in_flight";
    }
    default:
      // An unknown status is not quietly mapped onto a benign phase: it is
      // reported as in_flight, the one phase that neither claims delivery nor
      // permits a blind resend, so a schema change cannot silently create a
      // false terminal state.
      return "in_flight";
  }
}

/**
 * Phases another worker may take over.
 *
 * `claimed` is included: a claim with no attempt is a row whose creator died
 * between the insert and the first send, and it is exactly the lost-message
 * window this state machine exists to close.
 */
export const RECOVERABLE_DELIVERY_PHASES: ReadonlyArray<DeliveryPhase> = [
  "claimed",
  "expired",
  "retryable",
  "ambiguous",
];

export function isRecoverableDeliveryPhase(phase: DeliveryPhase): boolean {
  return RECOVERABLE_DELIVERY_PHASES.includes(phase);
}

/** Is this row done, as far as the producing sweep is concerned? */
export function isTerminalDeliveryPhase(phase: DeliveryPhase): boolean {
  return TERMINAL_DELIVERY_PHASES.includes(phase);
}

/**
 * The operation discriminator every `NotificationDelivery`-backed send uses
 * when it MINTS its key.
 *
 * PHASE 12 POINT 5 — this file used to export `deliveryIdempotencyKey`, which
 * returned `proovra-delivery-<row id>`: opaque, stable, and derived fresh on
 * every attempt from an immutable id, which is almost right. What it could not
 * do is survive a key-generation change, because nothing persisted it. Minting
 * now lives in `idempotency-authority.ts` and the result is STORED on the row,
 * so a rotation cannot alter a key an in-flight message was already sent with.
 */
export const DELIVERY_IDEMPOTENCY_OPERATION = "delivery";
