/**
 * PHASE 12 — POINT 5: retry, backoff, lease and recovery policy.
 *
 * Every registered unit of work declares a BOUNDED recovery contract. "Bounded"
 * is the operative word: an unbounded retry is not resilience, it is an
 * amplifier — it turns one bad job into sustained load against whatever is
 * already failing, and it hides the failure from anyone watching attempt
 * counts.
 */

export type BackoffKind = "exponential" | "fixed";

export type RetryPolicy = {
  /** Maximum delivery attempts before the work is terminally failed. */
  attempts: number;
  backoff: BackoffKind;
  /** Base delay; exponential policies double from here. */
  backoffDelayMs: number;
  /** Wall-clock ceiling for a single attempt. */
  timeoutMs: number;
};

export type RecoveryPolicy = {
  /**
   * A durable row sitting in QUEUED longer than this was almost certainly
   * stranded by a producer that committed and then failed to enqueue. The
   * reconciler re-enqueues it.
   */
  strandedQueuedThresholdMs: number;
  /**
   * A row in PROCESSING whose claim is older than this has lost its worker —
   * the process died, or the lock expired. The reconciler returns it to QUEUED
   * exactly once.
   */
  processingLeaseTimeoutMs: number;
  /** Rows a single reconciliation tick may touch. Bounds the blast radius. */
  reconcileBatchSize: number;
  /** How the reconciler prevents two replicas working the same scope. */
  lock:
    | "conditional_state_claim"
    | "advisory_lock"
    | "unique_running_row"
    | "none_single_writer";
  /** Whether an operator may retry a terminally-failed row from the console. */
  operatorRetryable: boolean;
};

/**
 * Standard policies. Named rather than inlined so two jobs with the same risk
 * profile cannot drift apart by a stray edit.
 */
export const RETRY_POLICIES = {
  /** Fast, cheap, idempotent projection work. */
  PROJECTION: {
    attempts: 5,
    backoff: "exponential",
    backoffDelayMs: 5_000,
    timeoutMs: 10 * 60 * 1000,
  },
  /** Heavy rendering or extraction with a real per-attempt cost. */
  HEAVY_RENDER: {
    attempts: 3,
    backoff: "exponential",
    backoffDelayMs: 10_000,
    timeoutMs: 20 * 60 * 1000,
  },
  /** Artifact generation on the product's critical path. */
  ARTIFACT: {
    attempts: 5,
    backoff: "exponential",
    backoffDelayMs: 1_000,
    timeoutMs: 10 * 60 * 1000,
  },
  /** Destructive work: few attempts, long gaps, long ceiling. */
  DESTRUCTIVE: {
    attempts: 3,
    backoff: "exponential",
    backoffDelayMs: 5 * 60 * 1000,
    timeoutMs: 30 * 60 * 1000,
  },
  /** An external recipient is watching; retry patiently but finitely. */
  EXTERNAL_DELIVERY: {
    attempts: 8,
    backoff: "exponential",
    backoffDelayMs: 30_000,
    timeoutMs: 30_000,
  },
  /** Email delivery through the provider wrapper. */
  EMAIL_DELIVERY: {
    attempts: 5,
    backoff: "exponential",
    backoffDelayMs: 60_000,
    timeoutMs: 60_000,
  },
  /**
   * Timestamp-authority upgrade. Many attempts over a long horizon because the
   * upstream authority publishes on its own schedule and there is nothing to
   * gain by failing early — the global budget is anchored on evidence age, not
   * on this ladder.
   */
  TIMESTAMP_AUTHORITY: {
    attempts: 20,
    backoff: "exponential",
    backoffDelayMs: 60_000,
    timeoutMs: 5 * 60 * 1000,
  },
  /** Periodic reconciliation sweeps. */
  SWEEP: {
    attempts: 3,
    backoff: "exponential",
    backoffDelayMs: 30_000,
    timeoutMs: 20 * 60 * 1000,
  },
} as const satisfies Record<string, RetryPolicy>;

export const RECOVERY_POLICIES = {
  PROJECTION: {
    strandedQueuedThresholdMs: 15 * 60 * 1000,
    processingLeaseTimeoutMs: 10 * 60 * 1000,
    reconcileBatchSize: 200,
    lock: "conditional_state_claim",
    operatorRetryable: true,
  },
  HEAVY_RENDER: {
    strandedQueuedThresholdMs: 15 * 60 * 1000,
    processingLeaseTimeoutMs: 20 * 60 * 1000,
    reconcileBatchSize: 50,
    lock: "conditional_state_claim",
    operatorRetryable: true,
  },
  ARTIFACT: {
    strandedQueuedThresholdMs: 10 * 60 * 1000,
    processingLeaseTimeoutMs: 15 * 60 * 1000,
    reconcileBatchSize: 100,
    lock: "conditional_state_claim",
    operatorRetryable: true,
  },
  /**
   * Destruction is never auto-retried by a reconciler into a fresh delete. The
   * reconciler's only job is to move a stranded execution back to a state an
   * OPERATOR can act on, because an unattended retry of a partially-completed
   * deletion is exactly the scenario that produces an unexplainable gap in a
   * custody record.
   */
  DESTRUCTIVE: {
    strandedQueuedThresholdMs: 30 * 60 * 1000,
    processingLeaseTimeoutMs: 30 * 60 * 1000,
    reconcileBatchSize: 25,
    lock: "unique_running_row",
    operatorRetryable: false,
  },
  EXTERNAL_DELIVERY: {
    strandedQueuedThresholdMs: 10 * 60 * 1000,
    processingLeaseTimeoutMs: 5 * 60 * 1000,
    reconcileBatchSize: 50,
    lock: "conditional_state_claim",
    operatorRetryable: true,
  },
  SWEEP: {
    strandedQueuedThresholdMs: 60 * 60 * 1000,
    processingLeaseTimeoutMs: 30 * 60 * 1000,
    reconcileBatchSize: 100,
    lock: "unique_running_row",
    operatorRetryable: true,
  },
} as const satisfies Record<string, RecoveryPolicy>;

export type RetryPolicyName = keyof typeof RETRY_POLICIES;
export type RecoveryPolicyName = keyof typeof RECOVERY_POLICIES;
