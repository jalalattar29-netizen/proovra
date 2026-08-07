/**
 * Automation webhook delivery — the DURABLE runtime.
 *
 * PHASE 12 CORRECTIVE PASS §2 CONTINUATION (ARCH-005, 2026-08-07) removed the
 * in-process half of this module. It was E3.3's "async delivery runtime", and
 * the asynchrony was `setImmediate` for the first attempt and `setTimeout` for
 * the retries — this process's event loop, and nothing else. A restart lost
 * every pending and every scheduled attempt, with a durable row left behind
 * claiming work that nobody would ever do, and a second API instance had no
 * way to find it.
 *
 * What this module is now:
 *
 *   1. `processDelivery({ deliveryId })` — ONE bounded outbound attempt under
 *      a LEASE and a FENCE, plus the state transition it earns:
 *
 *        DELIVERING → SUCCEEDED          the receiver answered 2xx
 *        DELIVERING → RETRY_SCHEDULED    the transport PROVES no commit
 *                                        (connection refused, DNS failure, a
 *                                        503) and attempts remain
 *        DELIVERING → FAILED             the receiver answered and refused
 *        DELIVERING → RETRY_EXHAUSTED    proven-no-commit, cap reached
 *        DELIVERING → SKIPPED            pre-flight validation failure
 *        DELIVERING → AMBIGUOUS          the request was WRITTEN and the answer
 *                                        was lost. NOT a failure, NOT a
 *                                        success, and NOT resent.
 *        AMBIGUOUS  → SUCCEEDED          a provider lookup confirms the commit
 *        AMBIGUOUS  → RETRY_SCHEDULED    a provider lookup confirms NO commit
 *        AMBIGUOUS  → DEAD_LETTERED_UNKNOWN
 *                                        bounded reconciliation is exhausted
 *                                        and the outcome is STILL unknown
 *
 *      It NEVER throws past its boundary.
 *
 *      PHASE 12 CORRECTIVE PASS §1 CONTINUATION (2026-08-07) added the last
 *      four. Before it, a timeout was classified "retryable" and resent — and
 *      a timeout is precisely the case in which the receiver may already have
 *      acted, so the resend was a DUPLICATE external side effect dressed as a
 *      retry. AMBIGUOUS now has its own state, its own bounded reconciliation
 *      policy, and its own terminal, so an unknown outcome is never projected
 *      to an operator as a refusal.
 *
 *   2. `sweepDueDeliveries({ limit })` — the ONLY thing that attempts a
 *      delivery, on any process. It reconciles rows whose lease expired while
 *      DELIVERING, then claims every PENDING or RETRY_SCHEDULED row that is
 *      due. It is scheduled by the worker through the canonical
 *      `AutomationDispatchSweep`.
 *
 *   3. Destination health: increments `consecutiveFailureCount` on every
 *      failed delivery, resets on success, and AUTO-DISABLES the destination
 *      after 10 consecutive failures (emitting
 *      `automation_webhook_destination_auto_disabled`).
 *
 * Hard invariants (pinned by `phase-e3-3-async-delivery-runtime.test.ts` and
 * the ARCH-005 gate):
 *
 *   - **NO in-process scheduling.** No `setImmediate`, no `setTimeout`, no
 *     `node:timers` import. The durable row's `nextAttemptAt` IS the schedule.
 *
 *   - **Bounded total attempts:** WEBHOOK_MAX_TOTAL_ATTEMPTS = 4.
 *     There is no retry path beyond attempt 4. Pinned at source.
 *
 *   - **Bounded total wall-clock:** 0 + 5 + 30 + 300 = 335 seconds.
 *     The bounded retry schedule is `WEBHOOK_RETRY_BACKOFF_SECONDS`
 *     (constant). No exponential explosion.
 *
 *   - **Idempotency preserved:** the existing
 *     `automation_webhook_deliveries_team_run_dest_uniq` index from
 *     E3.2 still prevents duplicate delivery rows for the same
 *     (run, destination). Retry scheduling updates the existing row;
 *     it does not insert new rows.
 *
 *   - **SSRF protection preserved:** every attempt revalidates the
 *     destination URL via DNS (DNS-rebinding defence), via the same
 *     `validateDestinationUrlWithDns` from E3.2.
 *
 *   - **HMAC signing preserved:** each attempt re-signs the payload
 *     with the current destination secret. A rotated secret takes
 *     effect on the next attempt.
 *
 *   - **No raw evidence in any payload / log / event:** the only identifier
 *     that travels is the deliveryId UUID. All other context is loaded from
 *     the database at processing time.
 *
 *   - **Sweeper picks up at most `limit` rows per tick** (default
 *     20). Bounded query, bounded work per tick.
 */

// ARCH-005 (2026-08-07) — NO TIMER IMPORTS. This module used to import
// `setImmediate` and `setTimeout` from `node:timers` and schedule attempts on
// the local event loop. Both are gone; the durable row and its `nextAttemptAt`
// are the whole schedule. The absence of this import is pinned by the
// ARCH-005 gate, because re-adding it is exactly how the defect returns.

import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";
import { safeEmitSecurityEvent } from "../security/security-event.service.js";
import {
  buildSafeWebhookPayload,
  buildSignedDelivery,
  computeNextAttemptAt,
  decryptStoredSecret,
  deliverWebhookOnce,
  classifyTransportOutcome,
  validateDestinationUrlWithDns,
  WEBHOOK_AUTO_DISABLE_THRESHOLD,
  WEBHOOK_MAX_TOTAL_ATTEMPTS,
} from "./automation-webhook.service.js";
import { sanitiseReason } from "./automation.service.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type ProcessDeliveryOutcome = {
  deliveryId: string;
  status:
    | "SUCCEEDED"
    | "RETRY_SCHEDULED"
    | "RETRY_EXHAUSTED"
    | "FAILED"
    | "SKIPPED"
    // ARCH-005 (2026-08-07) — the two states that carry "we do not know".
    | "AMBIGUOUS"
    | "DEAD_LETTERED_UNKNOWN";
  attemptCount: number;
  reason?: string;
};

/**
 * WHERE `enqueueDelivery` WENT.
 *
 * PHASE 12 CORRECTIVE PASS §2 CONTINUATION (ARCH-005, 2026-08-07).
 *
 * It was a `setImmediate`. The action handler created a PENDING row and then
 * scheduled the attempt on THIS PROCESS'S event loop — so a restart between
 * the insert and the tick left a delivery nobody would ever attempt, and a
 * second API instance had no idea the work existed. The comment above it said
 * the interface was "queue-shaped so a future bounded phase can swap to
 * BullMQ"; the swap never came, and in the meantime the shape hid the fact
 * that there was no queue at all.
 *
 * There is no enqueue function any more, because there is nothing to enqueue
 * TO: the durable row IS the work, `nextAttemptAt` IS the schedule, and
 * `sweepDueDeliveries` — scheduled by the worker through the canonical
 * `AutomationDispatchSweep` — is the only thing that attempts it.
 */

/** How long a delivery claim is good for. */
export const DELIVERY_LEASE_MS = 5 * 60 * 1000;

/**
 * ARCH-005 (2026-08-07) — THE AMBIGUITY RECONCILIATION POLICY.
 *
 * How many times an AMBIGUOUS delivery is revisited before it is declared
 * unknown-for-good, and how long the wait is between visits. Bounded and
 * stated: an unknown outcome cannot sit in reconciliation forever, because an
 * operator who is never told cannot resolve it.
 */
export const AMBIGUITY_MAX_RECONCILIATIONS = 3;
export const AMBIGUITY_BACKOFF_SECONDS: ReadonlyArray<number> = [60, 300, 900];

/**
 * What a provider lookup can tell us about an ambiguous attempt.
 *
 *   COMMITTED    the provider confirms it processed the event — ACKNOWLEDGED.
 *   NOT_COMMITTED the provider confirms it never saw it — safe to resend.
 *   UNSUPPORTED  the provider offers no way to ask. This is the honest answer
 *                for outbound webhooks: HTTP POST has no receipt lookup, and
 *                no destination in this platform declares one. It is a real
 *                branch rather than a hypothetical, because the reconciler
 *                must behave differently when it CANNOT know.
 *   UNKNOWN      the lookup itself failed. Treated exactly like UNSUPPORTED.
 */
export type AmbiguityLookupResult =
  | "COMMITTED"
  | "NOT_COMMITTED"
  | "UNSUPPORTED"
  | "UNKNOWN";

export type AmbiguityLookup = (input: {
  deliveryId: string;
  destinationId: string;
  teamId: string;
}) => Promise<AmbiguityLookupResult>;

/**
 * The production lookup.
 *
 * It returns UNSUPPORTED for every destination, and that is not a stub — it is
 * the truth about outbound webhooks. A receiver that wants delivery to be
 * verifiable must expose a receipt endpoint, and none does; the signature and
 * the `X-Proovra-Delivery` id already give the RECEIVER everything it needs to
 * dedupe on its own side, which is where that responsibility belongs.
 *
 * It is a named function rather than an inline `false` so the reconciler has
 * one seam to widen when a destination type that DOES support lookup arrives,
 * and so the tests can drive COMMITTED / NOT_COMMITTED through the same code
 * path production uses.
 */
export const defaultAmbiguityLookup: AmbiguityLookup = async () => "UNSUPPORTED";

/**
 * Process a single delivery attempt. Loads the delivery row, runs
 * the bounded outbound attempt, and applies the appropriate state
 * transition. Never throws past its boundary.
 */
export async function processDelivery(input: {
  deliveryId: string;
  prisma?: PrismaClient;
  /** Optional fixed `nowMs` for tests. */
  nowMs?: number;
}): Promise<ProcessDeliveryOutcome> {
  const prisma = input.prisma ?? defaultPrisma;
  const nowMs = input.nowMs ?? Date.now();

  let delivery;
  try {
    delivery = await prisma.automationWebhookDelivery.findUnique({
      where: { id: input.deliveryId },
    });
  } catch {
    return {
      deliveryId: input.deliveryId,
      status: "FAILED",
      attemptCount: 0,
      reason: "delivery_lookup_failed",
    };
  }
  if (!delivery) {
    return {
      deliveryId: input.deliveryId,
      status: "FAILED",
      attemptCount: 0,
      reason: "delivery_not_found",
    };
  }

  // Terminal-state guard: never re-process a delivery that's already
  // in a terminal state.
  if (
    delivery.status === "SUCCEEDED" ||
    delivery.status === "FAILED" ||
    delivery.status === "SKIPPED" ||
    delivery.status === "RETRY_EXHAUSTED" ||
    // ARCH-005 — DEAD_LETTERED_UNKNOWN is terminal. AMBIGUOUS deliberately is
    // NOT in this list and is deliberately NOT claimable by the retry pass
    // either: it belongs to `reconcileAmbiguousDeliveries` and to nothing else.
    delivery.status === "DEAD_LETTERED_UNKNOWN"
  ) {
    return {
      deliveryId: delivery.id,
      status: delivery.status as ProcessDeliveryOutcome["status"],
      attemptCount: delivery.attemptCount,
      reason: "already_terminal",
    };
  }

  // Load destination + run for context.
  const destination = await prisma.automationWebhookDestination.findUnique({
    where: { id: delivery.destinationId },
  });
  if (!destination || destination.teamId !== delivery.teamId) {
    return finaliseFailed(prisma, delivery.id, 0, "destination_not_in_team", nowMs);
  }
  if (!destination.enabled) {
    return finaliseSkipped(prisma, delivery.id, "destination_disabled", nowMs);
  }
  // Load the originating run for payload context (trigger / target).
  const run = await prisma.automationRun.findUnique({
    where: { id: delivery.runId },
    select: {
      ruleId: true,
      triggerType: true,
      targetType: true,
      targetId: true,
    },
  });
  if (!run) {
    return finaliseFailed(prisma, delivery.id, 0, "run_not_found", nowMs);
  }

  // SSRF rebinding defence: revalidate URL on every attempt.
  const urlCheck = await validateDestinationUrlWithDns(destination.url);
  if (!urlCheck.ok) {
    const reason = `ssrf_blocked:${urlCheck.reason}`;
    await markDestinationFailure(prisma, destination.id, reason, nowMs);
    return finaliseSkipped(prisma, delivery.id, reason, nowMs);
  }

  // -------------------------------------------------------------------------
  // CLAIM: PENDING | RETRY_SCHEDULED → DELIVERING, under a LEASE and a FENCE.
  //
  // ARCH-005 (2026-08-07) — this used to be a status-only precondition. That
  // is enough to stop two claimers at the same instant and says nothing about
  // a process that DIED holding the row: a DELIVERING delivery abandoned by a
  // dead worker was indistinguishable from one in flight, so it stayed
  // DELIVERING forever and the sweep (which looks for RETRY_SCHEDULED) never
  // saw it again.
  //
  // The generation is part of the precondition and is incremented by the
  // claim, so a stale holder that wakes up later writes ZERO rows instead of
  // overwriting a newer attempt's outcome.
  // -------------------------------------------------------------------------
  const attemptIndex = delivery.attemptCount + 1;
  const generation = (delivery as { claimGeneration?: number }).claimGeneration ?? 0;
  const nextGeneration = generation + 1;
  let claimed;
  try {
    const claimRows = await prisma.automationWebhookDelivery.updateMany({
      where: {
        id: delivery.id,
        status: { in: ["PENDING", "RETRY_SCHEDULED"] },
        claimGeneration: generation,
      },
      data: {
        status: "DELIVERING",
        attemptCount: attemptIndex,
        claimGeneration: nextGeneration,
        lastAttemptAt: new Date(nowMs),
        leaseExpiresAtUtc: new Date(nowMs + DELIVERY_LEASE_MS),
      },
    });
    claimed = claimRows.count === 1;
  } catch {
    claimed = false;
  }
  if (!claimed) {
    // Another worker claimed it (or the row left the eligible state).
    return {
      deliveryId: delivery.id,
      status: "SKIPPED",
      attemptCount: delivery.attemptCount,
      reason: "delivery_already_claimed",
    };
  }

  // Decrypt + sign payload. Failures here are NOT retryable (key
  // material / signing config is a configuration problem).
  const secretPlaintext = decryptStoredSecret(destination.encryptedSecret);
  if (!secretPlaintext) {
    await markDestinationFailure(prisma, destination.id, "secret_decryption_failed", nowMs);
    return finaliseFailed(
      prisma,
      delivery.id,
      0,
      "secret_decryption_failed",
      nowMs,
    );
  }

  const eventType = `automation.${run.triggerType.toLowerCase()}`;
  const payload = buildSafeWebhookPayload({
    eventType,
    deliveryId: delivery.id,
    teamId: delivery.teamId,
    automationRunId: delivery.runId,
    ruleId: run.ruleId,
    triggerType: run.triggerType,
    actionType: "WEBHOOK_DELIVERY_INTERNAL_ONLY",
    targetType: run.targetType,
    targetId: run.targetId,
  });

  let signed;
  try {
    signed = buildSignedDelivery({
      eventType,
      deliveryId: delivery.id,
      teamId: delivery.teamId,
      payload,
      secretPlaintext,
      nowMs,
    });
  } catch (err) {
    const reason = sanitiseReason(
      (err as { message?: string })?.message ?? "payload_build_failed",
    );
    await markDestinationFailure(prisma, destination.id, reason, nowMs);
    return finaliseFailed(prisma, delivery.id, 0, reason, nowMs);
  }

  // The outbound attempt.
  const attempt = await deliverWebhookOnce({
    url: destination.url,
    body: signed.body,
    headers: signed.headers,
  });

  if (attempt.ok) {
    return finaliseSucceeded(prisma, delivery, attempt.status, nowMs);
  }

  const reason = sanitiseReason(attempt.reason);
  const outcome = classifyTransportOutcome(reason);

  /**
   * ARCH-005 (2026-08-07) — AMBIGUOUS IS ITS OWN STATE, AND IT DOES NOT
   * RESEND.
   *
   * The receiver was reached and the answer was lost. Sending again would be
   * a SECOND delivery of an event the receiver may already have acted on, and
   * for a webhook whose whole purpose is to trigger downstream work that is a
   * real duplicate side effect — not a harmless retry.
   *
   * So the row moves to AMBIGUOUS and enters bounded reconciliation. It keeps
   * its idempotency key, so if reconciliation ever resolves to "not committed"
   * the resend is the SAME intent rather than a new one. Destination health is
   * NOT incremented here: an unknown outcome is not evidence that the
   * destination is unhealthy, and counting it would auto-disable a perfectly
   * good endpoint after ten slow responses.
   */
  if (outcome === "AMBIGUOUS") {
    return finaliseAmbiguous(prisma, delivery, attempt.status, reason, nowMs);
  }

  if (outcome === "NO_COMMIT" && attemptIndex < WEBHOOK_MAX_TOTAL_ATTEMPTS) {
    const nextAttemptAt = computeNextAttemptAt(attemptIndex, nowMs);
    if (nextAttemptAt) {
      return finaliseRetryScheduled(
        prisma,
        delivery,
        attempt.status,
        reason,
        nextAttemptAt,
        nowMs,
      );
    }
  }

  // No retry: either PERMANENT, or NO_COMMIT with the cap reached.
  await markDestinationFailure(prisma, destination.id, reason, nowMs);
  if (outcome === "NO_COMMIT" && attemptIndex >= WEBHOOK_MAX_TOTAL_ATTEMPTS) {
    return finaliseRetryExhausted(prisma, delivery, attempt.status, reason, nowMs);
  }
  return finaliseFailed(prisma, delivery.id, attempt.status, reason, nowMs);
}

/**
 * THE ONLY THING THAT ATTEMPTS A DELIVERY.
 *
 * ARCH-005 (2026-08-07) — this was `sweepDueRetries`, and the name told the
 * truth about the defect: it swept RETRIES only. A FIRST attempt was never its
 * business, because `enqueueDelivery`'s `setImmediate` was supposed to have
 * made it, and nothing checked whether it had. A PENDING delivery abandoned by
 * a restart was therefore invisible to the one component built to rescue it.
 *
 * It now claims PENDING and RETRY_SCHEDULED alike, and it reconciles the rows
 * whose lease expired while DELIVERING — the shape a dead worker leaves
 * behind. Bounded by `limit`; never throws.
 */
export async function sweepDueDeliveries(input: {
  prisma?: PrismaClient;
  limit?: number;
  nowMs?: number;
  /** Overridable so the ambiguity branches can be driven through THIS path. */
  lookup?: AmbiguityLookup;
}): Promise<{
  processed: number;
  reclaimed: number;
  ambiguityResolved: number;
  ambiguityDeadLettered: number;
}> {
  const prisma = input.prisma ?? defaultPrisma;
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
  const nowMs = input.nowMs ?? Date.now();
  const now = new Date(nowMs);

  // AMBIGUITY RECONCILIATION runs first, and separately from the retry pass.
  // Keeping it separate is the point: the retry pass claims and RESENDS, and
  // an ambiguous row must never reach it.
  const ambiguity = await reconcileAmbiguousDeliveries({
    prisma,
    nowMs,
    limit,
    lookup: input.lookup,
  });

  // RECONCILE FIRST. A delivery whose holder died is returned to the pool with
  // its generation bumped, so the dead holder's eventual write lands nowhere,
  // and it becomes due in THIS tick rather than the next one.
  let reclaimed = 0;
  try {
    const stranded = await prisma.automationWebhookDelivery.findMany({
      where: { status: "DELIVERING", leaseExpiresAtUtc: { lte: now } },
      select: { id: true, claimGeneration: true, attemptCount: true },
      orderBy: { leaseExpiresAtUtc: "asc" },
      take: limit,
    });
    for (const s of stranded) {
      const beyondRetry = s.attemptCount >= WEBHOOK_MAX_TOTAL_ATTEMPTS;
      const res = await prisma.automationWebhookDelivery.updateMany({
        where: {
          id: s.id,
          status: "DELIVERING",
          claimGeneration: s.claimGeneration,
        },
        data: beyondRetry
          ? {
              // Retries are spent and the outcome was never observed. This is
              // RETRY_EXHAUSTED — the state that means "we do not know" — and
              // deliberately not FAILED, which would assert a refusal nobody
              // saw.
              status: "RETRY_EXHAUSTED",
              claimGeneration: s.claimGeneration + 1,
              failureReason: "lease_expired_after_max_attempts",
              leaseExpiresAtUtc: null,
              nextAttemptAt: null,
            }
          : {
              status: "RETRY_SCHEDULED",
              claimGeneration: s.claimGeneration + 1,
              failureReason: "lease_expired_reclaimed",
              leaseExpiresAtUtc: null,
              nextAttemptAt: now,
            },
      });
      if (res.count === 1) reclaimed += 1;
    }
  } catch {
    /* the next tick sees them again — convergence, not a lost row */
  }

  let due: Array<{ id: string }> = [];
  try {
    due = await prisma.automationWebhookDelivery.findMany({
      where: {
        status: { in: ["PENDING", "RETRY_SCHEDULED"] },
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
      },
      select: { id: true },
      orderBy: [{ nextAttemptAt: "asc" }, { createdAt: "asc" }],
      take: limit,
    });
  } catch {
    return {
      processed: 0,
      reclaimed,
      ambiguityResolved: ambiguity.resolved,
      ambiguityDeadLettered: ambiguity.deadLetteredUnknown,
    };
  }

  for (const d of due) {
    await processDelivery({ deliveryId: d.id, prisma, nowMs: input.nowMs });
  }
  return {
    processed: due.length,
    reclaimed,
    ambiguityResolved: ambiguity.resolved,
    ambiguityDeadLettered: ambiguity.deadLetteredUnknown,
  };
}

// ---------------------------------------------------------------------------
// State transition helpers
// ---------------------------------------------------------------------------

async function finaliseSucceeded(
  prisma: PrismaClient,
  delivery: { id: string; teamId: string; runId: string; destinationId: string; attemptCount: number },
  responseStatus: number,
  nowMs: number,
): Promise<ProcessDeliveryOutcome> {
  try {
    await prisma.automationWebhookDelivery.update({
      where: { id: delivery.id },
      data: {
        status: "SUCCEEDED",
        responseStatus,
        nextAttemptAt: null,
        lastAttemptAt: new Date(nowMs),
      },
    });
    await prisma.automationWebhookDestination.update({
      where: { id: delivery.destinationId },
      data: {
        lastSuccessAt: new Date(nowMs),
        consecutiveFailureCount: 0,
        failureCount: 0,
      },
    });
  } catch {
    /* best-effort */
  }
  emitDeliveryEvent("automation_webhook_delivery_succeeded", {
    teamId: delivery.teamId,
    runId: delivery.runId,
    deliveryId: delivery.id,
    destinationId: delivery.destinationId,
    attemptCount: delivery.attemptCount + 1,
    responseStatus,
  });
  return {
    deliveryId: delivery.id,
    status: "SUCCEEDED",
    attemptCount: delivery.attemptCount + 1,
  };
}

async function finaliseRetryScheduled(
  prisma: PrismaClient,
  delivery: { id: string; teamId: string; runId: string; destinationId: string; attemptCount: number },
  responseStatus: number,
  reason: string,
  nextAttemptAt: Date,
  nowMs: number,
): Promise<ProcessDeliveryOutcome> {
  try {
    await prisma.automationWebhookDelivery.update({
      where: { id: delivery.id },
      data: {
        status: "RETRY_SCHEDULED",
        responseStatus,
        failureReason: reason.slice(0, 400),
        nextAttemptAt,
        lastAttemptAt: new Date(nowMs),
      },
    });
  } catch {
    /* best-effort */
  }
  // ARCH-005 (2026-08-07) — the in-process `setTimeout` that used to sit here
  // is gone. It scheduled the next attempt on THIS process's event loop, which
  // meant a retry survived only as long as the process did, and a second
  // instance would happily attempt the same row at the same moment. The
  // durable `nextAttemptAt` above IS the schedule, and the sweep is the only
  // thing that reads it.
  emitDeliveryEvent("automation_webhook_delivery_retry_scheduled", {
    teamId: delivery.teamId,
    runId: delivery.runId,
    deliveryId: delivery.id,
    destinationId: delivery.destinationId,
    attemptCount: delivery.attemptCount + 1,
    reason,
    responseStatus,
  });
  return {
    deliveryId: delivery.id,
    status: "RETRY_SCHEDULED",
    attemptCount: delivery.attemptCount + 1,
    reason,
  };
}

/**
 * ARCH-005 (2026-08-07) — BOUNDED AMBIGUITY RECONCILIATION.
 *
 * For every AMBIGUOUS delivery whose reconciliation time has arrived:
 *
 *   1. ASK the provider, if it supports being asked. A COMMITTED answer
 *      resolves to SUCCEEDED — the event WAS delivered and we simply lost the
 *      acknowledgement. A NOT_COMMITTED answer is the only thing that makes a
 *      resend safe, and it goes back to RETRY_SCHEDULED with the SAME
 *      idempotency key, so it is the same intent rather than a second one.
 *   2. If the provider cannot be asked (the honest case for webhooks), WAIT —
 *      bounded, with a backoff, and counted.
 *   3. When the count is exhausted, DEAD_LETTER AS UNKNOWN. Not failed.
 *
 * Fenced on `claimGeneration` like every other transition here, so a worker
 * holding a stale view cannot overwrite a reconciled outcome.
 *
 * Never throws.
 */
export async function reconcileAmbiguousDeliveries(input: {
  prisma?: PrismaClient;
  nowMs?: number;
  limit?: number;
  lookup?: AmbiguityLookup;
}): Promise<{ examined: number; resolved: number; deadLetteredUnknown: number }> {
  const prisma = input.prisma ?? defaultPrisma;
  const nowMs = input.nowMs ?? Date.now();
  const now = new Date(nowMs);
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
  const lookup = input.lookup ?? defaultAmbiguityLookup;

  let due: Array<{
    id: string;
    teamId: string;
    destinationId: string;
    reconciliationAttempts: number;
    claimGeneration: number;
    failureReason: string | null;
  }>;
  try {
    due = await prisma.automationWebhookDelivery.findMany({
      where: {
        status: "AMBIGUOUS",
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
      },
      select: {
        id: true,
        teamId: true,
        destinationId: true,
        reconciliationAttempts: true,
        claimGeneration: true,
        failureReason: true,
      },
      orderBy: { nextAttemptAt: "asc" },
      take: limit,
    });
  } catch {
    return { examined: 0, resolved: 0, deadLetteredUnknown: 0 };
  }

  let resolved = 0;
  let deadLetteredUnknown = 0;

  for (const d of due) {
    let answer: AmbiguityLookupResult;
    try {
      answer = await lookup({
        deliveryId: d.id,
        destinationId: d.destinationId,
        teamId: d.teamId,
      });
    } catch {
      answer = "UNKNOWN";
    }

    const generation = d.claimGeneration;
    const nextGeneration = generation + 1;

    if (answer === "COMMITTED") {
      // The provider says it processed the event. The delivery DID happen; we
      // only lost the acknowledgement. This is the one path on which an
      // ambiguous attempt becomes a success, and it requires the provider to
      // have said so — never an inference from silence.
      const res = await fencedDeliveryUpdate(prisma, d.id, generation, {
        status: "SUCCEEDED",
        claimGeneration: nextGeneration,
        failureReason: "reconciled_provider_confirmed_commit",
        nextAttemptAt: null,
        leaseExpiresAtUtc: null,
      });
      if (res) {
        resolved += 1;
        emitDeliveryEvent("automation_webhook_delivery_ambiguity_resolved", {
          teamId: d.teamId,
          runId: "",
          deliveryId: d.id,
          destinationId: d.destinationId,
          attemptCount: d.reconciliationAttempts,
          reason: "provider_confirmed_commit",
        });
      }
      continue;
    }

    if (answer === "NOT_COMMITTED") {
      // The ONLY safe resend. Same row, same idempotency key, back on the
      // ordinary retry ladder.
      const res = await fencedDeliveryUpdate(prisma, d.id, generation, {
        status: "RETRY_SCHEDULED",
        claimGeneration: nextGeneration,
        failureReason: "reconciled_provider_confirmed_no_commit",
        nextAttemptAt: now,
        leaseExpiresAtUtc: null,
      });
      if (res) {
        resolved += 1;
        emitDeliveryEvent("automation_webhook_delivery_ambiguity_resolved", {
          teamId: d.teamId,
          runId: "",
          deliveryId: d.id,
          destinationId: d.destinationId,
          attemptCount: d.reconciliationAttempts,
          reason: "provider_confirmed_no_commit",
        });
      }
      continue;
    }

    // UNSUPPORTED or UNKNOWN — we cannot find out. Wait, bounded, or stop.
    const nextCount = d.reconciliationAttempts + 1;
    if (nextCount >= AMBIGUITY_MAX_RECONCILIATIONS) {
      const res = await fencedDeliveryUpdate(prisma, d.id, generation, {
        status: "DEAD_LETTERED_UNKNOWN",
        claimGeneration: nextGeneration,
        reconciliationAttempts: nextCount,
        failureReason: (d.failureReason ?? "ambiguous").slice(0, 400),
        nextAttemptAt: null,
        leaseExpiresAtUtc: null,
      });
      if (res) {
        deadLetteredUnknown += 1;
        emitDeliveryEvent("automation_webhook_delivery_dead_lettered_unknown", {
          teamId: d.teamId,
          runId: "",
          deliveryId: d.id,
          destinationId: d.destinationId,
          attemptCount: nextCount,
          reason: "reconciliation_exhausted_outcome_unknown",
        });
      }
      continue;
    }

    const backoff =
      AMBIGUITY_BACKOFF_SECONDS[Math.min(nextCount, AMBIGUITY_BACKOFF_SECONDS.length - 1)]!;
    await fencedDeliveryUpdate(prisma, d.id, generation, {
      status: "AMBIGUOUS",
      claimGeneration: nextGeneration,
      reconciliationAttempts: nextCount,
      nextAttemptAt: new Date(nowMs + backoff * 1000),
    });
  }

  return { examined: due.length, resolved, deadLetteredUnknown };
}

/**
 * Every ambiguity transition is fenced on the generation it observed.
 *
 * A THROW and a ZERO-ROW MATCH are not the same thing and must not be reported
 * as the same thing. Zero rows means another worker got there first — normal,
 * expected, and exactly what the fence is for. A throw means the write was
 * REJECTED (a constraint, a type, a dead connection), and returning a quiet
 * `false` for that makes a broken deployment look like healthy contention:
 * the reconciler would count the row as "someone else handled it" forever
 * while it silently never moved.
 *
 * So a throw is surfaced as an operator-visible event before the `false`.
 */
async function fencedDeliveryUpdate(
  prisma: PrismaClient,
  deliveryId: string,
  generation: number,
  data: Record<string, unknown>,
): Promise<boolean> {
  try {
    const res = await prisma.automationWebhookDelivery.updateMany({
      where: { id: deliveryId, status: "AMBIGUOUS", claimGeneration: generation },
      data: data as never,
    });
    return res.count === 1;
  } catch (err) {
    safeEmitSecurityEvent({
      eventType: "automation_webhook_delivery_ambiguous",
      severity: "WARNING",
      details: {
        deliveryId,
        claimGeneration: generation,
        reason: "reconciliation_write_rejected",
        // Bounded: the error NAME only. Never the message, which can carry a
        // row's contents, and never the parameters.
        errorName: err instanceof Error ? err.name.slice(0, 60) : "unknown",
      },
    });
    return false;
  }
}

/**
 * ARCH-005 (2026-08-07) — the ambiguous terminal-of-the-moment.
 *
 * Not success, not failure, and NOT a resend. `nextAttemptAt` is a
 * RECONCILIATION time, not a retry time — the sweep's ambiguity pass reads it,
 * and the delivery pass deliberately does not.
 */
async function finaliseAmbiguous(
  prisma: PrismaClient,
  delivery: {
    id: string;
    teamId: string;
    runId: string;
    destinationId: string;
    attemptCount: number;
  },
  responseStatus: number,
  reason: string,
  nowMs: number,
): Promise<ProcessDeliveryOutcome> {
  const backoff = AMBIGUITY_BACKOFF_SECONDS[0]!;
  try {
    await prisma.automationWebhookDelivery.update({
      where: { id: delivery.id },
      data: {
        status: "AMBIGUOUS",
        responseStatus,
        failureReason: reason.slice(0, 400),
        ambiguousAtUtc: new Date(nowMs),
        reconciliationAttempts: 0,
        nextAttemptAt: new Date(nowMs + backoff * 1000),
        leaseExpiresAtUtc: null,
        lastAttemptAt: new Date(nowMs),
      },
    });
  } catch {
    /* best-effort */
  }
  emitDeliveryEvent("automation_webhook_delivery_ambiguous", {
    teamId: delivery.teamId,
    runId: delivery.runId,
    deliveryId: delivery.id,
    destinationId: delivery.destinationId,
    attemptCount: delivery.attemptCount + 1,
    reason,
    responseStatus,
  });
  return {
    deliveryId: delivery.id,
    status: "AMBIGUOUS",
    attemptCount: delivery.attemptCount + 1,
    reason,
  };
}

/**
 * ARCH-005 (2026-08-07) — reconciliation is exhausted and the outcome is
 * STILL unknown.
 *
 * Deliberately NOT `FAILED`. Projecting an unknown as a refusal would tell an
 * operator the receiver rejected the event, and they would resend it — which
 * is exactly the duplicate this whole branch exists to prevent. The row says
 * "we do not know", carries how many times we asked, and waits for a human.
 */
async function finaliseDeadLetteredUnknown(
  prisma: PrismaClient,
  deliveryId: string,
  reason: string,
  nowMs: number,
): Promise<ProcessDeliveryOutcome> {
  let row: {
    teamId: string;
    runId: string;
    destinationId: string;
    attemptCount: number;
  } | null = null;
  try {
    row = await prisma.automationWebhookDelivery.update({
      where: { id: deliveryId },
      data: {
        status: "DEAD_LETTERED_UNKNOWN",
        failureReason: reason.slice(0, 400),
        nextAttemptAt: null,
        leaseExpiresAtUtc: null,
      },
      select: { teamId: true, runId: true, destinationId: true, attemptCount: true },
    });
  } catch {
    /* best-effort */
  }
  if (row) {
    emitDeliveryEvent("automation_webhook_delivery_dead_lettered_unknown", {
      teamId: row.teamId,
      runId: row.runId,
      deliveryId,
      destinationId: row.destinationId,
      attemptCount: row.attemptCount,
      reason,
    });
  }
  return {
    deliveryId,
    status: "DEAD_LETTERED_UNKNOWN",
    attemptCount: row?.attemptCount ?? 0,
    reason,
  };
}

async function finaliseRetryExhausted(
  prisma: PrismaClient,
  delivery: { id: string; teamId: string; runId: string; destinationId: string; attemptCount: number },
  responseStatus: number,
  reason: string,
  nowMs: number,
): Promise<ProcessDeliveryOutcome> {
  try {
    await prisma.automationWebhookDelivery.update({
      where: { id: delivery.id },
      data: {
        status: "RETRY_EXHAUSTED",
        responseStatus,
        failureReason: reason.slice(0, 400),
        nextAttemptAt: null,
        lastAttemptAt: new Date(nowMs),
      },
    });
  } catch {
    /* best-effort */
  }
  emitDeliveryEvent("automation_webhook_delivery_retry_exhausted", {
    teamId: delivery.teamId,
    runId: delivery.runId,
    deliveryId: delivery.id,
    destinationId: delivery.destinationId,
    attemptCount: delivery.attemptCount + 1,
    reason,
    responseStatus,
  });
  return {
    deliveryId: delivery.id,
    status: "RETRY_EXHAUSTED",
    attemptCount: delivery.attemptCount + 1,
    reason,
  };
}

async function finaliseFailed(
  prisma: PrismaClient,
  deliveryId: string,
  responseStatus: number,
  reason: string,
  nowMs: number,
): Promise<ProcessDeliveryOutcome> {
  // We need the team/run/destination/attempt for the event payload.
  let delivery: { teamId: string; runId: string; destinationId: string; attemptCount: number } | null = null;
  try {
    delivery = await prisma.automationWebhookDelivery.update({
      where: { id: deliveryId },
      data: {
        status: "FAILED",
        responseStatus,
        failureReason: reason.slice(0, 400),
        nextAttemptAt: null,
        lastAttemptAt: new Date(nowMs),
      },
      select: { teamId: true, runId: true, destinationId: true, attemptCount: true },
    });
  } catch {
    /* best-effort */
  }
  if (delivery) {
    emitDeliveryEvent("automation_webhook_delivery_failed", {
      teamId: delivery.teamId,
      runId: delivery.runId,
      deliveryId,
      destinationId: delivery.destinationId,
      attemptCount: delivery.attemptCount,
      reason,
      responseStatus,
    });
  }
  return {
    deliveryId,
    status: "FAILED",
    attemptCount: delivery?.attemptCount ?? 0,
    reason,
  };
}

async function finaliseSkipped(
  prisma: PrismaClient,
  deliveryId: string,
  reason: string,
  nowMs: number,
): Promise<ProcessDeliveryOutcome> {
  let delivery: { teamId: string; runId: string; destinationId: string; attemptCount: number } | null = null;
  try {
    delivery = await prisma.automationWebhookDelivery.update({
      where: { id: deliveryId },
      data: {
        status: "SKIPPED",
        failureReason: reason.slice(0, 400),
        nextAttemptAt: null,
        lastAttemptAt: new Date(nowMs),
      },
      select: { teamId: true, runId: true, destinationId: true, attemptCount: true },
    });
  } catch {
    /* best-effort */
  }
  if (delivery) {
    emitDeliveryEvent("automation_webhook_delivery_skipped", {
      teamId: delivery.teamId,
      runId: delivery.runId,
      deliveryId,
      destinationId: delivery.destinationId,
      attemptCount: delivery.attemptCount,
      reason,
    });
  }
  return {
    deliveryId,
    status: "SKIPPED",
    attemptCount: delivery?.attemptCount ?? 0,
    reason,
  };
}

/**
 * Mark a destination failure: bump `consecutiveFailureCount`, set
 * `lastFailureAt`, and auto-disable when the threshold is reached.
 */
async function markDestinationFailure(
  prisma: PrismaClient,
  destinationId: string,
  reason: string,
  nowMs: number,
): Promise<void> {
  let updated;
  try {
    updated = await prisma.automationWebhookDestination.update({
      where: { id: destinationId },
      data: {
        lastFailureAt: new Date(nowMs),
        failureCount: { increment: 1 },
        consecutiveFailureCount: { increment: 1 },
      },
      select: {
        id: true,
        teamId: true,
        enabled: true,
        consecutiveFailureCount: true,
      },
    });
  } catch {
    return;
  }
  // Auto-disable threshold check. Only fire once per crossing.
  if (
    updated.enabled &&
    updated.consecutiveFailureCount >= WEBHOOK_AUTO_DISABLE_THRESHOLD
  ) {
    try {
      await prisma.automationWebhookDestination.update({
        where: { id: destinationId },
        data: {
          enabled: false,
          autoDisabledAt: new Date(nowMs),
          disabledReason: `auto_disabled:consecutive_failures:${updated.consecutiveFailureCount}`,
        },
      });
      safeEmitSecurityEvent({
        teamId: updated.teamId,
        eventType: "automation_webhook_destination_auto_disabled",
        severity: "WARNING",
        details: {
          destinationId,
          consecutiveFailureCount: updated.consecutiveFailureCount,
          lastFailureReason: reason,
          threshold: WEBHOOK_AUTO_DISABLE_THRESHOLD,
        },
      });
    } catch {
      /* best-effort */
    }
  }
}

/**
 * Operator-safe delivery-lifecycle event. NEVER include the webhook
 * secret, payload body, response body, signed URLs, tokens, or
 * evidence content.
 */
function emitDeliveryEvent(
  eventType:
    | "automation_webhook_delivery_succeeded"
    | "automation_webhook_delivery_failed"
    | "automation_webhook_delivery_skipped"
    | "automation_webhook_delivery_retry_scheduled"
    | "automation_webhook_delivery_retry_exhausted"
    // ARCH-005 §1 — ambiguity is audited AS ambiguity.
    | "automation_webhook_delivery_ambiguous"
    | "automation_webhook_delivery_ambiguity_resolved"
    | "automation_webhook_delivery_dead_lettered_unknown",
  payload: {
    teamId: string;
    runId: string;
    deliveryId: string;
    destinationId: string;
    attemptCount: number;
    reason?: string;
    responseStatus?: number;
  },
): void {
  safeEmitSecurityEvent({
    teamId: payload.teamId,
    eventType,
    severity:
      eventType === "automation_webhook_delivery_failed" ||
      eventType === "automation_webhook_delivery_retry_exhausted" ||
      // An unknown outcome needs an operator, so it is a WARNING — but it is
      // its own event type, never folded into "failed".
      eventType === "automation_webhook_delivery_dead_lettered_unknown"
        ? "WARNING"
        : "INFO",
    details: {
      runId: payload.runId,
      deliveryId: payload.deliveryId,
      destinationId: payload.destinationId,
      attemptCount: payload.attemptCount,
      ...(payload.reason ? { reason: payload.reason } : {}),
      ...(typeof payload.responseStatus === "number" && payload.responseStatus > 0
        ? { responseStatus: payload.responseStatus }
        : {}),
    },
  });
}
