/**
 * Phase X — Operational contracts.
 *
 * Typed payload + execution contracts that the api and worker runtimes
 * share. Pure types + helpers — no Prisma, no Node.
 *
 * Hard rules:
 *   - Every queue payload + reconciliation run + notification emission
 *     that crosses the api/worker boundary must be projectable into
 *     one of these typed contracts.
 *   - Correlation IDs are first-class: every contract carries a
 *     `correlationId` so an operator can stitch the chain together in
 *     logs and the (future) tracing pipeline.
 *   - These contracts NEVER reference Prisma models directly. The
 *     consumer maps Prisma rows into these contracts (and back) at the
 *     boundary.
 *
 * Why this exists:
 *   The platform now has 6+ queues / scheduler loops with subtly
 *   different retry / DLQ / idempotency contracts. This module names
 *   the canonical contract so the next worker added does not invent a
 *   seventh.
 */

// -----------------------------------------------------------------------------
// Correlation IDs
// -----------------------------------------------------------------------------

const HEX = "0123456789abcdef";

function randomHex(bytes: number): string {
  // Browser-safe randomness. The worker uses node:crypto via the
  // platform-audit chain helpers; this is the catch-all for shared
  // contexts.
  if (typeof globalThis !== "undefined" && globalThis.crypto?.getRandomValues) {
    const buf = new Uint8Array(bytes);
    globalThis.crypto.getRandomValues(buf);
    let out = "";
    for (const b of buf) {
      out += HEX[(b >> 4) & 0xf];
      out += HEX[b & 0xf];
    }
    return out;
  }
  // Last-resort fallback (test sandboxes without crypto).
  let out = "";
  for (let i = 0; i < bytes * 2; i++) {
    out += HEX[Math.floor(Math.random() * 16)];
  }
  return out;
}

/**
 * Generates a 16-byte hex correlation id (32 chars), suitable for
 * request / job / lifecycle-event tracing. Stable shape; routes pull
 * an inbound `x-request-id` when present and synthesize otherwise.
 */
export function newCorrelationId(): string {
  return randomHex(16);
}

const CORRELATION_ID_PATTERN = /^[a-f0-9]{8,128}$/i;

export function isValidCorrelationId(value: unknown): value is string {
  return typeof value === "string" && CORRELATION_ID_PATTERN.test(value);
}

/** Normalize an inbound correlation id (header) — accepts the bounded
 *  charset and length window, otherwise synthesizes a fresh one. */
export function ingestCorrelationId(input: unknown): string {
  if (isValidCorrelationId(input)) return input;
  return newCorrelationId();
}

// -----------------------------------------------------------------------------
// Worker execution contract
//
// Every worker invocation that touches authoritative state should
// thread one of these envelopes. The reconciliation-run helper in
// `packages/shared-runtime/src/reconciliation-run.ts` already
// records each invocation — this contract names the in-memory shape so
// future workers wire identically.
// -----------------------------------------------------------------------------

export const WORKER_EXECUTION_TRIGGERS = [
  "cron",
  "startup",
  "manual",
  "operator_replay",
  "interval",
  "queue",
  "test",
] as const;
export type WorkerExecutionTrigger = (typeof WORKER_EXECUTION_TRIGGERS)[number];

export type WorkerExecutionContext = {
  /** End-to-end correlation id. New for one invocation. */
  correlationId: string;
  /** Worker identifier — matches RuntimeOwner in canonical-decisions.ts. */
  workerId: string;
  trigger: WorkerExecutionTrigger;
  startedAtUtc: string;
  /** Optional workspace scope for multi-tenant workers. */
  teamId?: string | null;
};

export function newWorkerExecutionContext(input: {
  workerId: string;
  trigger: WorkerExecutionTrigger;
  teamId?: string | null;
  correlationId?: string;
}): WorkerExecutionContext {
  return {
    correlationId: input.correlationId ?? newCorrelationId(),
    workerId: input.workerId,
    trigger: input.trigger,
    startedAtUtc: new Date().toISOString(),
    teamId: input.teamId ?? null,
  };
}

// -----------------------------------------------------------------------------
// Queue payload contracts
//
// Every BullMQ queue payload in the platform must be expressible as a
// QueuePayloadEnvelope<...>. The envelope is the same shape regardless
// of the payload body so the worker dispatcher can extract correlation
// + idempotency without unpacking the body.
// -----------------------------------------------------------------------------

export type QueuePayloadEnvelope<TBody> = {
  /** Stable kind label — matches the canonical queue name. */
  kind: string;
  /** Carrier correlation id — the same id that lit the api request. */
  correlationId: string;
  /** Stable idempotency key. Re-enqueues with the same key collapse. */
  idempotencyKey: string;
  /** Enqueue timestamp (ISO). */
  enqueuedAtUtc: string;
  /** Optional workspace scope. */
  teamId?: string | null;
  /** Payload body — strongly typed by the queue's own service. */
  body: TBody;
};

export function newQueuePayloadEnvelope<TBody>(input: {
  kind: string;
  idempotencyKey: string;
  body: TBody;
  correlationId?: string;
  teamId?: string | null;
}): QueuePayloadEnvelope<TBody> {
  return {
    kind: input.kind,
    correlationId: input.correlationId ?? newCorrelationId(),
    idempotencyKey: input.idempotencyKey,
    enqueuedAtUtc: new Date().toISOString(),
    teamId: input.teamId ?? null,
    body: input.body,
  };
}

/**
 * Tolerant envelope parser — accepts either:
 *   1. A canonical `QueuePayloadEnvelope<TBody>` (post-Phase X.1 jobs)
 *   2. A raw `TBody` (legacy / in-flight jobs that were enqueued
 *      before the envelope was adopted).
 *
 * The return shape is uniform: always exposes `body` + metadata. When
 * the inbound is a raw legacy body, missing envelope fields are
 * synthesized so downstream code can assume the contract is present.
 *
 * Used by BullMQ job processors to decode `job.data` without breaking
 * back-compat. The processor calls this once at the top of the
 * handler and works from `body` onward.
 */
export function parseQueueEnvelope<TBody>(
  raw: unknown,
  options: {
    /** Expected `kind` for sanity checking. When provided and the
     *  inbound envelope's kind doesn't match, the parser warns via
     *  the returned `kindMismatch` flag but still returns the body. */
    expectedKind?: string;
    /** Validator for the body payload. Defaults to identity. */
    validateBody?: (candidate: unknown) => candidate is TBody;
  } = {},
): {
  body: TBody;
  correlationId: string;
  idempotencyKey: string | null;
  enqueuedAtUtc: string | null;
  teamId: string | null;
  legacy: boolean;
  kindMismatch: boolean;
} {
  const isEnvelope =
    raw !== null &&
    typeof raw === "object" &&
    typeof (raw as { kind?: unknown }).kind === "string" &&
    "body" in (raw as Record<string, unknown>) &&
    typeof (raw as { correlationId?: unknown }).correlationId === "string";

  if (!isEnvelope) {
    // Legacy raw payload — synthesize envelope fields.
    const body = raw as TBody;
    if (options.validateBody && !options.validateBody(body)) {
      throw new Error("parseQueueEnvelope: validateBody rejected the payload");
    }
    return {
      body,
      correlationId: newCorrelationId(),
      idempotencyKey: null,
      enqueuedAtUtc: null,
      teamId: null,
      legacy: true,
      kindMismatch: false,
    };
  }

  const env = raw as QueuePayloadEnvelope<TBody>;
  const kindMismatch = Boolean(
    options.expectedKind && env.kind !== options.expectedKind,
  );
  if (options.validateBody && !options.validateBody(env.body)) {
    throw new Error("parseQueueEnvelope: validateBody rejected the body");
  }
  return {
    body: env.body,
    correlationId: env.correlationId,
    idempotencyKey: env.idempotencyKey,
    enqueuedAtUtc: env.enqueuedAtUtc,
    teamId: env.teamId ?? null,
    legacy: false,
    kindMismatch,
  };
}

/** Type guard for an unknown payload claiming to be the canonical envelope. */
export function isQueuePayloadEnvelope(
  raw: unknown,
): raw is QueuePayloadEnvelope<unknown> {
  return (
    raw !== null &&
    typeof raw === "object" &&
    typeof (raw as { kind?: unknown }).kind === "string" &&
    typeof (raw as { correlationId?: unknown }).correlationId === "string" &&
    "body" in (raw as Record<string, unknown>)
  );
}

// -----------------------------------------------------------------------------
// Retry / DLQ contract — canonical defaults for any new queue.
// -----------------------------------------------------------------------------

export const QUEUE_RETRY_PROFILES = {
  /** Default profile — short backoff, modest attempt count. Used by
   *  report generation and other interactive jobs. */
  interactive: {
    attempts: 5,
    backoffType: "exponential" as const,
    backoffDelayMs: 1000,
    dlqRequired: true,
  },
  /** Long-running compliance jobs (Bitcoin anchoring, OTS upgrades).
   *  Many attempts at slow backoff are appropriate. */
  compliance: {
    attempts: 20,
    backoffType: "exponential" as const,
    backoffDelayMs: 60_000,
    dlqRequired: true,
  },
  /** Reconciliation sweeps (governance workers). Run from cron — no
   *  in-band retry, the next scheduler tick is the retry. */
  reconciliation: {
    attempts: 1,
    backoffType: "fixed" as const,
    backoffDelayMs: 0,
    dlqRequired: false,
  },
} as const;
export type QueueRetryProfile = keyof typeof QUEUE_RETRY_PROFILES;

export type QueueRetryConfig = (typeof QUEUE_RETRY_PROFILES)[QueueRetryProfile];

// -----------------------------------------------------------------------------
// Governance notification emission contract
//
// The canonical service (`api:governance-notification.service`) accepts
// this exact shape. The Phase 27.5 workers currently bypass the service
// and write rows directly; this contract is the migration target so
// they can re-route through the canonical service without changing
// callers' input shapes.
// -----------------------------------------------------------------------------

export type GovernanceNotificationEmission = {
  teamId: string;
  kind: string; // matches GovernanceNotificationKind
  severity: "INFO" | "WARNING" | "HIGH" | "CRITICAL";
  /** Bounded fingerprint (max 180 chars). Same key collapses. */
  dedupeKey: string;
  title: string;
  summary: string;
  relatedEvidenceId?: string | null;
  relatedReviewId?: string | null;
  relatedHoldId?: string | null;
  relatedPolicyId?: string | null;
  relatedIncidentId?: string | null;
  /** Correlation id from the calling worker / route. */
  correlationId?: string;
  /** Bounded operator metadata (will be scrubbed by the service). */
  metadata?: Record<string, unknown> | null;
};

// -----------------------------------------------------------------------------
// Lifecycle transition emission contract
// -----------------------------------------------------------------------------

export type LifecycleTransitionEmission = {
  teamId: string;
  evidenceId: string;
  toState: string;
  summary: string;
  eventType: string;
  actorUserId: string | null;
  correlationId?: string;
  metadata?: Record<string, unknown> | null;
};

// -----------------------------------------------------------------------------
// Audit event emission contract — canonical shape for the
// `appendPlatformAuditLog` boundary so workers + routes use the same
// envelope.
// -----------------------------------------------------------------------------

export type AuditEventEmission = {
  userId: string | null;
  action: string;
  category?: string | null;
  severity?: string | null;
  source?: string | null;
  outcome?: string | null;
  resourceType?: string | null;
  resourceId?: string | null;
  correlationId?: string;
  metadata: unknown;
};
