/**
 * Phase 8 — Notification orchestration service.
 *
 * Single entry point for every operational notification PROOVRA sends.
 * Business code calls `notificationService.sendEvidenceRequestSent({...})`
 * and never touches the Resend SDK directly.
 *
 * Responsibilities:
 *   1. Feature-flag gate — if NOTIFICATIONS_ENABLED is not "true", every
 *      send is a no-op recorded as a SKIPPED NotificationDelivery row.
 *   2. Persist a NotificationDelivery row in PENDING before send (so a
 *      crash mid-send leaves a recoverable record).
 *   3. Dispatch through the provider abstraction (Resend today; SMS /
 *      webhook in future phases).
 *   4. Update the delivery row to SENT (with providerMessageId) or
 *      FAILED + RETRY_SCHEDULED (with errorCode/message + nextAttemptAtUtc).
 *   5. Never throw to the business caller — workflow lifecycle is
 *      decoupled from email delivery. The caller may inspect the returned
 *      result if they care.
 *
 * Privacy contract:
 *   - The renderer is the ONLY place that builds outgoing message bodies.
 *     It scrubs reviewer notes, hides token internals, and renders ONLY
 *     the safe-to-show fields documented in renderers below.
 *   - NotificationDelivery.metadata never contains tokens, hashes, IPs,
 *     reviewer notes, or workspace internals.
 *   - The `rendered_preview` column carries a short plaintext snippet
 *     bounded to 2000 chars — useful for support but never sufficient to
 *     reconstruct the full HTML.
 */
import { classifyNotificationProviderError, notificationRetryDelaySeconds, NOTIFICATION_RETRY_MAX_ATTEMPTS, } from "@proovra/shared";
import { prisma as defaultPrisma } from "../../db.js";
import { renderTransactionalTemplate } from "./templates.js";
import { sendViaResend } from "./resend-provider.js";
// -----------------------------------------------------------------------------
// Feature flag
// -----------------------------------------------------------------------------
const FLAG_ENV = "NOTIFICATIONS_ENABLED";
export function isNotificationsFeatureEnabled() {
    return process.env[FLAG_ENV] === "true";
}
// -----------------------------------------------------------------------------
// sendEmailNotification — the single dispatch entry point
// -----------------------------------------------------------------------------
export async function sendEmailNotification(input, client = defaultPrisma) {
    const recipientEmail = (input.recipientEmail ?? "").trim();
    if (!recipientEmail) {
        // We don't have anyone to send to. Record a SKIPPED row so the audit
        // trail explains the gap, but treat it as success from the caller's
        // perspective.
        const delivery = await client.notificationDelivery.create({
            data: {
                teamId: input.teamId ?? null,
                eventType: input.eventType,
                channel: "EMAIL",
                provider: "RESEND",
                recipient: "(missing)",
                recipientName: input.recipientName ?? null,
                recipientUserId: input.recipientUserId ?? null,
                evidenceRequestId: input.evidenceRequestId ?? null,
                evidenceId: input.evidenceId ?? null,
                intakeLinkId: input.intakeLinkId ?? null,
                status: "SKIPPED",
                templateKey: input.eventType,
                errorCode: "missing_recipient",
                initiatedByUserId: input.initiatedByUserId ?? null,
            },
        });
        return { delivery, status: "skipped_no_recipient" };
    }
    // Feature-flag short-circuit. The row is still persisted so admins see
    // the intent in the audit trail; production may have notifications off
    // intentionally during rollout.
    if (!isNotificationsFeatureEnabled()) {
        const delivery = await client.notificationDelivery.create({
            data: {
                teamId: input.teamId ?? null,
                eventType: input.eventType,
                channel: "EMAIL",
                provider: "RESEND",
                recipient: recipientEmail,
                recipientName: input.recipientName ?? null,
                recipientUserId: input.recipientUserId ?? null,
                evidenceRequestId: input.evidenceRequestId ?? null,
                evidenceId: input.evidenceId ?? null,
                intakeLinkId: input.intakeLinkId ?? null,
                status: "SKIPPED",
                templateKey: input.eventType,
                errorCode: "feature_flag_off",
                initiatedByUserId: input.initiatedByUserId ?? null,
            },
        });
        return { delivery, status: "skipped_feature_disabled" };
    }
    // Render the template before persisting. Rendering is pure — failure
    // here is a programming bug, not a transient runtime issue, so we let
    // it surface. The caller wraps the whole notification call in a
    // try/catch that does not abort the business workflow.
    const rendered = renderTransactionalTemplate(input.eventType, input.template);
    const delivery = await client.notificationDelivery.create({
        data: {
            teamId: input.teamId ?? null,
            eventType: input.eventType,
            channel: "EMAIL",
            provider: "RESEND",
            recipient: recipientEmail,
            recipientName: input.recipientName ?? null,
            recipientUserId: input.recipientUserId ?? null,
            evidenceRequestId: input.evidenceRequestId ?? null,
            evidenceId: input.evidenceId ?? null,
            intakeLinkId: input.intakeLinkId ?? null,
            status: "PENDING",
            subject: rendered.subject.slice(0, 400),
            templateKey: input.eventType,
            renderedPreview: rendered.plaintextPreview.slice(0, 2000),
            // Phase 8.5 — persist the exact context used to render this
            // notification so retries / manual resends can reproduce the
            // original message without re-reaching into workspace state.
            // The renderer's TemplateContext shape is the privacy boundary;
            // no reviewer note, no token hash, no IP/UA ever lands here.
            templateContextJson: input.template,
            initiatedByUserId: input.initiatedByUserId ?? null,
        },
    });
    // Provider call. Wrapped so any throw is captured as a delivery
    // failure rather than propagating to the business workflow.
    let providerResult;
    try {
        providerResult = await sendViaResend({
            to: recipientEmail,
            recipientName: input.recipientName ?? null,
            subject: rendered.subject,
            html: rendered.html,
            text: rendered.text,
        });
    }
    catch (err) {
        const errorMessage = err instanceof Error ? err.message : "unknown_error";
        const classification = classifyNotificationProviderError(null, errorMessage);
        const retriable = classification === "transient" &&
            delivery.retryCount + 1 < NOTIFICATION_RETRY_MAX_ATTEMPTS;
        const updated = await client.notificationDelivery.update({
            where: { id: delivery.id },
            data: retriable
                ? {
                    status: "RETRY_SCHEDULED",
                    retryCount: { increment: 1 },
                    nextAttemptAtUtc: new Date(Date.now() +
                        notificationRetryDelaySeconds(delivery.retryCount + 2) * 1000),
                    errorCode: "provider_threw",
                    errorMessage: errorMessage.slice(0, 2000),
                }
                : {
                    status: "FAILED",
                    failedAtUtc: new Date(),
                    errorCode: "provider_threw",
                    errorMessage: errorMessage.slice(0, 2000),
                },
        });
        return {
            delivery: updated,
            status: retriable ? "retry_scheduled" : "failed",
        };
    }
    if (providerResult.ok) {
        const updated = await client.notificationDelivery.update({
            where: { id: delivery.id },
            data: {
                status: "SENT",
                sentAtUtc: new Date(),
                providerMessageId: providerResult.providerMessageId ?? null,
            },
        });
        return { delivery: updated, status: "sent" };
    }
    // Provider returned a typed error.
    const classification = classifyNotificationProviderError(providerResult.errorCode, providerResult.errorMessage);
    const retriable = classification === "transient" &&
        delivery.retryCount + 1 < NOTIFICATION_RETRY_MAX_ATTEMPTS;
    const updated = await client.notificationDelivery.update({
        where: { id: delivery.id },
        data: retriable
            ? {
                status: "RETRY_SCHEDULED",
                retryCount: { increment: 1 },
                nextAttemptAtUtc: new Date(Date.now() +
                    notificationRetryDelaySeconds(delivery.retryCount + 2) * 1000),
                errorCode: providerResult.errorCode?.slice(0, 80) ?? null,
                errorMessage: providerResult.errorMessage?.slice(0, 2000) ?? null,
            }
            : {
                status: "FAILED",
                failedAtUtc: new Date(),
                errorCode: providerResult.errorCode?.slice(0, 80) ?? null,
                errorMessage: providerResult.errorMessage?.slice(0, 2000) ?? null,
            },
    });
    return {
        delivery: updated,
        status: retriable ? "retry_scheduled" : "failed",
    };
}
// -----------------------------------------------------------------------------
// safeSend — wrapper that NEVER throws.
//
// Business code calls this. Even if the entire notification stack is
// broken (DB unreachable, render throws), the caller's workflow continues
// unaffected; the failure is logged.
// -----------------------------------------------------------------------------
export async function safeSendEmailNotification(input, client = defaultPrisma) {
    try {
        return await sendEmailNotification(input, client);
    }
    catch {
        // Last-resort safety. The business flow MUST continue.
        return null;
    }
}
// -----------------------------------------------------------------------------
// dispatchDelivery — internal helper shared by send / retry / resend paths.
//
// Reads the stored templateContextJson, re-renders, calls the provider,
// updates the row. Pure of any business workflow side-effects.
// -----------------------------------------------------------------------------
async function dispatchDelivery(delivery, client) {
    if (!isNotificationsFeatureEnabled()) {
        const updated = await client.notificationDelivery.update({
            where: { id: delivery.id },
            data: {
                status: "SKIPPED",
                errorCode: "feature_flag_off",
            },
        });
        return { delivery: updated, status: "skipped_feature_disabled" };
    }
    if (!delivery.recipient || delivery.recipient === "(missing)") {
        return { delivery, status: "skipped_no_recipient" };
    }
    // Re-render from the stored context if available; otherwise we cannot
    // safely retry (we don't have the original payload) — mark FAILED so
    // operators see the gap rather than silently giving up.
    const ctx = delivery.templateContextJson;
    if (!ctx || typeof ctx !== "object") {
        const failed = await client.notificationDelivery.update({
            where: { id: delivery.id },
            data: {
                status: "FAILED",
                failedAtUtc: new Date(),
                errorCode: "missing_template_context",
                errorMessage: "Cannot retry: stored template context is missing. Re-issue the original notification through the business workflow.",
            },
        });
        return { delivery: failed, status: "failed" };
    }
    const rendered = renderTransactionalTemplate(delivery.eventType, ctx);
    let providerResult;
    try {
        providerResult = await sendViaResend({
            to: delivery.recipient,
            recipientName: delivery.recipientName,
            subject: rendered.subject,
            html: rendered.html,
            text: rendered.text,
        });
    }
    catch (err) {
        const errorMessage = err instanceof Error ? err.message : "unknown_error";
        const classification = classifyNotificationProviderError(null, errorMessage);
        const retriable = classification === "transient" &&
            delivery.retryCount + 1 < NOTIFICATION_RETRY_MAX_ATTEMPTS;
        const updated = await client.notificationDelivery.update({
            where: { id: delivery.id },
            data: retriable
                ? {
                    status: "RETRY_SCHEDULED",
                    retryCount: { increment: 1 },
                    nextAttemptAtUtc: new Date(Date.now() +
                        notificationRetryDelaySeconds(delivery.retryCount + 2) * 1000),
                    errorCode: "provider_threw",
                    errorMessage: errorMessage.slice(0, 2000),
                }
                : {
                    status: "FAILED",
                    failedAtUtc: new Date(),
                    errorCode: "provider_threw",
                    errorMessage: errorMessage.slice(0, 2000),
                },
        });
        return {
            delivery: updated,
            status: retriable ? "retry_scheduled" : "failed",
        };
    }
    if (providerResult.ok) {
        const updated = await client.notificationDelivery.update({
            where: { id: delivery.id },
            data: {
                status: "SENT",
                sentAtUtc: new Date(),
                providerMessageId: providerResult.providerMessageId ?? null,
                errorCode: null,
                errorMessage: null,
                nextAttemptAtUtc: null,
            },
        });
        return { delivery: updated, status: "sent" };
    }
    const classification = classifyNotificationProviderError(providerResult.errorCode, providerResult.errorMessage);
    const retriable = classification === "transient" &&
        delivery.retryCount + 1 < NOTIFICATION_RETRY_MAX_ATTEMPTS;
    const updated = await client.notificationDelivery.update({
        where: { id: delivery.id },
        data: retriable
            ? {
                status: "RETRY_SCHEDULED",
                retryCount: { increment: 1 },
                nextAttemptAtUtc: new Date(Date.now() +
                    notificationRetryDelaySeconds(delivery.retryCount + 2) * 1000),
                errorCode: providerResult.errorCode?.slice(0, 80) ?? null,
                errorMessage: providerResult.errorMessage?.slice(0, 2000) ?? null,
            }
            : {
                status: "FAILED",
                failedAtUtc: new Date(),
                errorCode: providerResult.errorCode?.slice(0, 80) ?? null,
                errorMessage: providerResult.errorMessage?.slice(0, 2000) ?? null,
            },
    });
    return {
        delivery: updated,
        status: retriable ? "retry_scheduled" : "failed",
    };
}
export async function resendNotificationDelivery(input, client = defaultPrisma) {
    const delivery = await client.notificationDelivery.findUnique({
        where: { id: input.id },
    });
    if (!delivery || delivery.teamId !== input.teamId) {
        return { delivery: null, outcome: "not_found" };
    }
    if (delivery.status === "CANCELLED") {
        return { delivery, outcome: "skipped_terminal" };
    }
    if ((delivery.status === "SENT" || delivery.status === "DELIVERED") &&
        !input.force) {
        return { delivery, outcome: "blocked_already_sent" };
    }
    // Reset the row to PENDING before dispatch so the lifecycle remains
    // observable to a concurrent reader.
    const refreshed = await client.notificationDelivery.update({
        where: { id: delivery.id },
        data: {
            status: "PENDING",
            errorCode: null,
            errorMessage: null,
            nextAttemptAtUtc: null,
            initiatedByUserId: input.actorUserId,
        },
    });
    try {
        const result = await dispatchDelivery(refreshed, client);
        return {
            delivery: result.delivery,
            outcome: result.status === "sent" ? "resent" : "failed_to_dispatch",
        };
    }
    catch {
        return { delivery: refreshed, outcome: "failed_to_dispatch" };
    }
}
export async function processDueNotificationRetries(input = {}, client = defaultPrisma) {
    const batchSize = Math.min(Math.max(input.batchSize ?? 50, 1), 500);
    const summary = {
        pickedUp: 0,
        resent: 0,
        rescheduled: 0,
        failed: 0,
    };
    if (!isNotificationsFeatureEnabled())
        return summary;
    const now = new Date();
    const candidates = await client.notificationDelivery.findMany({
        where: {
            status: "RETRY_SCHEDULED",
            channel: "EMAIL",
            provider: "RESEND",
            retryCount: { lt: NOTIFICATION_RETRY_MAX_ATTEMPTS },
            nextAttemptAtUtc: { lte: now },
        },
        orderBy: { nextAttemptAtUtc: "asc" },
        take: batchSize,
    });
    for (const row of candidates) {
        // Atomic claim: only proceed if the row is still RETRY_SCHEDULED. If a
        // concurrent sweeper picked it up first, updateMany returns count 0
        // and we skip it.
        const claim = await client.notificationDelivery.updateMany({
            where: { id: row.id, status: "RETRY_SCHEDULED" },
            data: { status: "PENDING" },
        });
        if (claim.count !== 1)
            continue;
        summary.pickedUp += 1;
        const refreshed = await client.notificationDelivery.findUnique({
            where: { id: row.id },
        });
        if (!refreshed)
            continue;
        try {
            const result = await dispatchDelivery(refreshed, client);
            if (result.status === "sent")
                summary.resent += 1;
            else if (result.status === "retry_scheduled")
                summary.rescheduled += 1;
            else
                summary.failed += 1;
        }
        catch {
            summary.failed += 1;
        }
    }
    return summary;
}
// -----------------------------------------------------------------------------
// listNotificationDeliveries — admin helper. The route layer applies the
// safe projection.
// -----------------------------------------------------------------------------
export async function listNotificationDeliveries(input, client = defaultPrisma) {
    const dateFilter = {};
    if (input.createdAfter)
        dateFilter.gte = input.createdAfter;
    if (input.createdBefore)
        dateFilter.lte = input.createdBefore;
    const hasDate = Object.keys(dateFilter).length > 0
        ? { createdAt: dateFilter }
        : {};
    return client.notificationDelivery.findMany({
        where: {
            teamId: input.teamId,
            ...(input.evidenceRequestId
                ? { evidenceRequestId: input.evidenceRequestId }
                : {}),
            ...(input.status
                ? { status: input.status }
                : {}),
            ...(input.eventType ? { eventType: input.eventType } : {}),
            ...(input.recipient ? { recipient: input.recipient } : {}),
            ...(input.channel
                ? { channel: input.channel }
                : {}),
            ...(input.provider
                ? { provider: input.provider }
                : {}),
            ...hasDate,
        },
        orderBy: { createdAt: "desc" },
        take: Math.min(Math.max(input.limit ?? 50, 1), 200),
    });
}
export async function getNotificationDelivery(id, teamId, client = defaultPrisma) {
    const row = await client.notificationDelivery.findUnique({
        where: { id },
    });
    if (!row || row.teamId !== teamId)
        return null;
    return row;
}
// -----------------------------------------------------------------------------
// Safe public projection — used by the route handlers. The renderedPreview
// is plaintext-only (bounded), templateContextJson is NEVER returned, and
// recipient is partially masked when it contains an email.
// -----------------------------------------------------------------------------
function maskEmail(value) {
    if (!value.includes("@"))
        return value;
    const [local, domain] = value.split("@");
    if (!local || !domain)
        return value;
    const head = local.slice(0, 2);
    return `${head}${"*".repeat(Math.max(0, local.length - 2))}@${domain}`;
}
export function projectNotificationDelivery(delivery, opts = {}) {
    const recipient = opts.maskRecipient && delivery.channel === "EMAIL"
        ? maskEmail(delivery.recipient)
        : delivery.recipient;
    return {
        id: delivery.id,
        eventType: delivery.eventType,
        channel: delivery.channel,
        provider: delivery.provider,
        recipient,
        recipientName: delivery.recipientName,
        status: delivery.status,
        subject: delivery.subject,
        templateKey: delivery.templateKey,
        // renderedPreview is plaintext (per Phase 8 schema). It is bounded
        // 2000 chars and the renderer never includes reviewer notes, token
        // hashes, or IP/UA — only safe message body fragments.
        renderedPreview: delivery.renderedPreview,
        providerMessageId: delivery.providerMessageId,
        errorCode: delivery.errorCode,
        errorMessage: delivery.errorMessage,
        retryCount: delivery.retryCount,
        nextAttemptAtUtc: delivery.nextAttemptAtUtc?.toISOString() ?? null,
        sentAtUtc: delivery.sentAtUtc?.toISOString() ?? null,
        deliveredAtUtc: delivery.deliveredAtUtc?.toISOString() ?? null,
        failedAtUtc: delivery.failedAtUtc?.toISOString() ?? null,
        evidenceRequestId: delivery.evidenceRequestId,
        evidenceId: delivery.evidenceId,
        intakeLinkId: delivery.intakeLinkId,
        initiatedByUserId: delivery.initiatedByUserId,
        createdAt: delivery.createdAt.toISOString(),
        updatedAt: delivery.updatedAt.toISOString(),
        // Intentionally NOT returned:
        //   - metadata (may contain operator-only context)
        //   - templateContextJson (renderer payload; never exposed)
    };
}
