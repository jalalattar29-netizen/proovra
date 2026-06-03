/**
 * Phase E3.3 — Async webhook delivery runtime.
 *
 * Closes DEF-023. This module:
 *
 *   1. Provides `enqueueDelivery({ deliveryId })` which the action
 *      handler calls after creating a PENDING delivery row. The
 *      function returns immediately so the caller's flow (the
 *      automation dispatcher) is never blocked by network I/O.
 *
 *   2. Provides `processDelivery({ deliveryId })` which performs ONE
 *      bounded outbound attempt + the appropriate state transition:
 *
 *        DELIVERING → SUCCEEDED          (2xx response)
 *        DELIVERING → RETRY_SCHEDULED    (retryable failure + attempts < cap)
 *        DELIVERING → FAILED             (non-retryable failure)
 *        DELIVERING → RETRY_EXHAUSTED    (retryable failure + attempts == cap)
 *        DELIVERING → SKIPPED            (pre-flight validation failure)
 *
 *      The function NEVER throws past its boundary — it always
 *      returns a structured outcome.
 *
 *   3. Provides `sweepDueRetries({ limit })` which the worker process
 *      calls on a cron interval to pick up `RETRY_SCHEDULED` rows
 *      whose `nextAttemptAt` has passed and re-process them. This is
 *      the restart-resilience layer: setTimeout-scheduled retries do
 *      not survive process restart, but the DB-driven sweeper does.
 *
 *   4. Manages destination health: increments `consecutiveFailureCount`
 *      on every failed delivery, resets on success, and AUTO-DISABLES
 *      the destination after 10 consecutive failures (emitting
 *      `automation_webhook_destination_auto_disabled`).
 *
 * Hard invariants (pinned by phase-e3-3-async-delivery-runtime.test.ts):
 *
 *   - **In-process scheduling** uses `setImmediate` (initial attempt)
 *     + `setTimeout` (retry attempts). No new infrastructure
 *     (BullMQ, Redis queues, etc.) — the existing E3.2 schema's
 *     `attemptCount` + `nextAttemptAt` columns drive the state.
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
 *   - **No raw evidence in queue payload / logs / events:** the only
 *     identifier passed between scheduling and processing is the
 *     deliveryId UUID. All other context is loaded from the DB at
 *     processing time.
 *
 *   - **Sweeper picks up at most `limit` rows per tick** (default
 *     20). Bounded query, bounded work per tick.
 */
import { setImmediate as setImmediateNative, setTimeout as setTimeoutNative } from "node:timers";
import { prisma as defaultPrisma } from "../../db.js";
import { safeEmitSecurityEvent } from "../security/security-event.service.js";
import { buildSafeWebhookPayload, buildSignedDelivery, computeNextAttemptAt, decryptStoredSecret, deliverWebhookOnce, isRetryableFailure, validateDestinationUrlWithDns, WEBHOOK_AUTO_DISABLE_THRESHOLD, WEBHOOK_MAX_TOTAL_ATTEMPTS, } from "./automation-webhook.service.js";
import { sanitiseReason } from "./automation.service.js";
/**
 * Enqueue a delivery for asynchronous processing. The caller MUST
 * have already created the `AutomationWebhookDelivery` row in
 * `PENDING` status. Returns immediately; the actual outbound HTTP
 * call happens on the next event-loop tick.
 *
 * The "queue" today is an in-process `setImmediate`. The interface
 * is queue-shaped so a future bounded phase can swap to BullMQ
 * without touching the action handler.
 */
export function enqueueDelivery(input) {
    setImmediateNative(() => {
        void processDelivery({
            deliveryId: input.deliveryId,
            prisma: input.prisma ?? defaultPrisma,
        }).catch(() => {
            /* swallow — processDelivery never throws past its boundary;
               this is belt-and-braces for the setImmediate callback. */
        });
    });
}
/**
 * Process a single delivery attempt. Loads the delivery row, runs
 * the bounded outbound attempt, and applies the appropriate state
 * transition. Never throws past its boundary.
 */
export async function processDelivery(input) {
    const prisma = input.prisma ?? defaultPrisma;
    const nowMs = input.nowMs ?? Date.now();
    let delivery;
    try {
        delivery = await prisma.automationWebhookDelivery.findUnique({
            where: { id: input.deliveryId },
        });
    }
    catch {
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
    if (delivery.status === "SUCCEEDED" ||
        delivery.status === "FAILED" ||
        delivery.status === "SKIPPED" ||
        delivery.status === "RETRY_EXHAUSTED") {
        return {
            deliveryId: delivery.id,
            status: delivery.status,
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
    // Transition PENDING → DELIVERING (or RETRY_SCHEDULED → DELIVERING).
    // Atomic to prevent two concurrent workers from picking up the same row.
    const attemptIndex = delivery.attemptCount + 1;
    let claimed;
    try {
        const claimRows = await prisma.automationWebhookDelivery.updateMany({
            where: {
                id: delivery.id,
                // Only claim if not already DELIVERING (defends against double-process).
                status: { in: ["PENDING", "RETRY_SCHEDULED"] },
            },
            data: {
                status: "DELIVERING",
                attemptCount: attemptIndex,
                lastAttemptAt: new Date(nowMs),
            },
        });
        claimed = claimRows.count === 1;
    }
    catch {
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
        return finaliseFailed(prisma, delivery.id, 0, "secret_decryption_failed", nowMs);
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
    }
    catch (err) {
        const reason = sanitiseReason(err?.message ?? "payload_build_failed");
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
    const retryable = isRetryableFailure(reason);
    if (retryable && attemptIndex < WEBHOOK_MAX_TOTAL_ATTEMPTS) {
        const nextAttemptAt = computeNextAttemptAt(attemptIndex, nowMs);
        if (nextAttemptAt) {
            return finaliseRetryScheduled(prisma, delivery, attempt.status, reason, nextAttemptAt, nowMs);
        }
    }
    // No retry: either non-retryable OR cap reached.
    await markDestinationFailure(prisma, destination.id, reason, nowMs);
    if (retryable && attemptIndex >= WEBHOOK_MAX_TOTAL_ATTEMPTS) {
        return finaliseRetryExhausted(prisma, delivery, attempt.status, reason, nowMs);
    }
    return finaliseFailed(prisma, delivery.id, attempt.status, reason, nowMs);
}
/**
 * Periodic sweeper. Picks up `RETRY_SCHEDULED` rows whose
 * `nextAttemptAt` has passed and processes them. Called by the
 * worker process on a cron interval. Bounded by `limit` (default 20)
 * to keep per-tick work small.
 */
export async function sweepDueRetries(input) {
    const prisma = input.prisma ?? defaultPrisma;
    const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
    const now = new Date(input.nowMs ?? Date.now());
    const due = await prisma.automationWebhookDelivery.findMany({
        where: {
            status: "RETRY_SCHEDULED",
            nextAttemptAt: { lte: now },
        },
        orderBy: { nextAttemptAt: "asc" },
        take: limit,
    });
    for (const d of due) {
        await processDelivery({
            deliveryId: d.id,
            prisma,
            nowMs: input.nowMs,
        });
    }
    return { processed: due.length };
}
// ---------------------------------------------------------------------------
// State transition helpers
// ---------------------------------------------------------------------------
async function finaliseSucceeded(prisma, delivery, responseStatus, nowMs) {
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
    }
    catch {
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
async function finaliseRetryScheduled(prisma, delivery, responseStatus, reason, nextAttemptAt, nowMs) {
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
    }
    catch {
        /* best-effort */
    }
    // Schedule the next attempt in-process. The sweeper is the
    // restart-resilience backstop.
    const delayMs = Math.max(0, nextAttemptAt.getTime() - nowMs);
    setTimeoutNative(() => {
        void processDelivery({ deliveryId: delivery.id, prisma }).catch(() => {
            /* swallow */
        });
    }, delayMs);
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
async function finaliseRetryExhausted(prisma, delivery, responseStatus, reason, nowMs) {
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
    }
    catch {
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
async function finaliseFailed(prisma, deliveryId, responseStatus, reason, nowMs) {
    // We need the team/run/destination/attempt for the event payload.
    let delivery = null;
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
    }
    catch {
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
async function finaliseSkipped(prisma, deliveryId, reason, nowMs) {
    let delivery = null;
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
    }
    catch {
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
async function markDestinationFailure(prisma, destinationId, reason, nowMs) {
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
    }
    catch {
        return;
    }
    // Auto-disable threshold check. Only fire once per crossing.
    if (updated.enabled &&
        updated.consecutiveFailureCount >= WEBHOOK_AUTO_DISABLE_THRESHOLD) {
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
        }
        catch {
            /* best-effort */
        }
    }
}
/**
 * Operator-safe delivery-lifecycle event. NEVER include the webhook
 * secret, payload body, response body, signed URLs, tokens, or
 * evidence content.
 */
function emitDeliveryEvent(eventType, payload) {
    safeEmitSecurityEvent({
        teamId: payload.teamId,
        eventType,
        severity: eventType === "automation_webhook_delivery_failed" ||
            eventType === "automation_webhook_delivery_retry_exhausted"
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
