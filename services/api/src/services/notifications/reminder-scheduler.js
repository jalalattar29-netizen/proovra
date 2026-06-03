/**
 * Phase 8.5 — Evidence Request reminder scheduler.
 *
 * Scans live evidence requests and sends one reminder email per request
 * within a configurable cooldown. Conservative by design:
 *   - only OPEN / SENT / VIEWED / IN_PROGRESS requests
 *   - dueAtUtc must be near or past
 *   - recipient must be external (EXTERNAL_CONTRIBUTOR — anonymous/
 *     pseudonymous have no destination address)
 *   - recipient email must be set
 *   - no reminder sent within the last NOTIFICATION_REMINDER_INTERVAL_HOURS
 *   - notifications feature must be enabled
 *   - reminder feature itself must be enabled (NOTIFICATION_REMINDERS_ENABLED)
 *
 * The scheduler is API-side. It can be invoked manually via an admin
 * route (Part F) or wired into a setInterval at process start. It never
 * blocks any business workflow; failures are absorbed.
 */
import { prisma as defaultPrisma } from "../../db.js";
import { isNotificationsFeatureEnabled, safeSendEmailNotification, } from "./index.js";
const REMINDERS_FLAG = "NOTIFICATION_REMINDERS_ENABLED";
const REMINDERS_INTERVAL_HOURS = "NOTIFICATION_REMINDER_INTERVAL_HOURS";
export function isReminderSchedulerEnabled() {
    return (process.env[REMINDERS_FLAG] === "true" && isNotificationsFeatureEnabled());
}
export function reminderCooldownMs() {
    const raw = process.env[REMINDERS_INTERVAL_HOURS];
    const hours = raw ? Number.parseInt(raw, 10) : 24;
    if (!Number.isFinite(hours) || hours <= 0)
        return 24 * 3600 * 1000;
    // Hard ceiling so a misconfigured env doesn't pin the cooldown to
    // months.
    return Math.min(hours, 24 * 30) * 3600 * 1000;
}
const ELIGIBLE_REQUEST_STATUSES = [
    "OPEN",
    "SENT",
    "VIEWED",
    "IN_PROGRESS",
];
export async function runReminderScheduler(input = {}, client = defaultPrisma) {
    const summary = {
        scanned: 0,
        reminded: 0,
        skippedRecent: 0,
        skippedNoEmail: 0,
        skippedFeatureDisabled: 0,
    };
    if (!isReminderSchedulerEnabled()) {
        summary.skippedFeatureDisabled = 1;
        return summary;
    }
    const now = input.now ?? new Date();
    const cooldownMs = reminderCooldownMs();
    const cooldownThreshold = new Date(now.getTime() - cooldownMs);
    const batchSize = Math.min(Math.max(input.batchSize ?? 100, 1), 500);
    const candidates = await client.evidenceRequest.findMany({
        where: {
            status: { in: ELIGIBLE_REQUEST_STATUSES },
            // Only nudge when there's a due date AND it's within a 7-day pre/post
            // window. Avoids spamming about distant future deadlines.
            dueAtUtc: {
                not: null,
                lte: new Date(now.getTime() + 7 * 24 * 3600 * 1000),
                gte: new Date(now.getTime() - 90 * 24 * 3600 * 1000),
            },
            recipientMode: "EXTERNAL_CONTRIBUTOR",
            recipientEmail: { not: null },
        },
        take: batchSize,
        orderBy: { dueAtUtc: "asc" },
        include: {
            deliverables: true,
            intakeLink: true,
        },
    });
    for (const req of candidates) {
        summary.scanned += 1;
        if (!req.recipientEmail) {
            summary.skippedNoEmail += 1;
            continue;
        }
        // Cooldown — has a reminder been sent recently for this request?
        const lastReminder = await client.notificationDelivery.findFirst({
            where: {
                evidenceRequestId: req.id,
                eventType: "EVIDENCE_REQUEST_REMINDER",
                createdAt: { gte: cooldownThreshold },
            },
            orderBy: { createdAt: "desc" },
        });
        if (lastReminder) {
            summary.skippedRecent += 1;
            continue;
        }
        const team = await client.team.findUnique({
            where: { id: req.teamId },
            select: { name: true, evidenceWorkspaceLabel: true },
        });
        // We deliberately do NOT include the raw intake URL because we don't
        // have the raw token (only the hash). The reminder uses the template
        // without a URL; the contributor can search their inbox for the
        // original link or contact the workspace.
        await safeSendEmailNotification({
            eventType: "EVIDENCE_REQUEST_REMINDER",
            teamId: req.teamId,
            recipientEmail: req.recipientEmail,
            recipientName: req.recipientLabel ?? null,
            evidenceRequestId: req.id,
            evidenceId: req.evidenceId ?? null,
            intakeLinkId: req.intakeLinkId ?? null,
            template: {
                kind: "EvidenceRequest",
                data: {
                    workspaceName: team?.evidenceWorkspaceLabel ?? team?.name ?? "Your workspace",
                    requestTitle: req.title,
                    requestInstructions: req.instructions || null,
                    dueAtUtcIso: req.dueAtUtc?.toISOString() ?? null,
                    intakeUrl: null,
                    deliverableSummaries: (req.deliverables ?? []).map((d) => ({
                        title: d.title,
                        required: d.required,
                    })),
                },
            },
        }, client);
        summary.reminded += 1;
    }
    return summary;
}
