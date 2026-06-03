/**
 * Phase 25.5 — Reviewer-ops reminder engine.
 *
 * Single writer of `reviewer_ops_reminders`. Owns:
 *   - DUE_SOON reminders for upcoming workflow deadlines
 *   - ESCALATION_WARNING reminders for open escalations approaching SLA
 *   - REVIEWER_INACTIVE reminders for stalled assignees
 *   - REASSIGNMENT_SUGGESTION reminders surfaced to admins
 *
 * Hard rules:
 *   - Idempotency via the unique `(teamId, kind, dedup_key)` constraint.
 *     The service catches the duplicate-row error and treats it as
 *     "already scheduled" — bumping `reviewer_reminder_duplicate_blocked_total`.
 *   - `safeSummary` is bounded (400 chars) and scrubbed against the
 *     forbidden-overclaim phrase catalog.
 *   - Notification dispatch is best-effort; failure marks the row
 *     FAILED but does NOT throw.
 *   - No private reviewer note text in any field. No legal-hold
 *     reason. No raw evidence content.
 */
import { createHash } from "node:crypto";
import { REVIEWER_OPS_REMINDER_KINDS, stringContainsForbiddenOverclaim, } from "@proovra/shared";
import { prisma as defaultPrisma } from "../../db.js";
import { bump } from "../ops/metrics.service.js";
import { safeEmitSecurityEvent } from "../security/security-event.service.js";
function projectReminder(row) {
    return {
        id: row.id,
        kind: row.kind,
        status: row.status,
        workflowId: row.workflowId,
        escalationId: row.escalationId,
        reviewerUserId: row.reviewerUserId,
        safeSummary: row.safeSummary,
        dayBucket: row.dayBucket,
        createdAt: row.createdAt.toISOString(),
    };
}
// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------
const KIND_SET = new Set(REVIEWER_OPS_REMINDER_KINDS);
function dayBucket(now) {
    return now.toISOString().slice(0, 10);
}
function buildDedupKey(input) {
    // dedup_key = SHA-256(`${workflowId|reviewerUserId|escalationId}:${kind}:${dayBucket}`).slice(0, 64)
    const anchor = input.workflowId ?? input.escalationId ?? input.reviewerUserId ?? "global";
    const raw = `${anchor}:${input.kind}:${dayBucket(input.now)}`;
    return createHash("sha256").update(raw).digest("hex").slice(0, 64);
}
function scrubSummary(summary) {
    const trimmed = summary.trim().slice(0, 400);
    if (stringContainsForbiddenOverclaim(trimmed)) {
        return "[summary withheld — wording violation]";
    }
    return trimmed.length > 0 ? trimmed : "Reviewer-ops reminder.";
}
export async function scheduleReminder(input, client = defaultPrisma) {
    if (!KIND_SET.has(input.kind)) {
        return { ok: false, reason: "invalid_kind" };
    }
    const now = new Date();
    const dedupKey = buildDedupKey({
        workflowId: input.workflowId ?? null,
        reviewerUserId: input.reviewerUserId ?? null,
        escalationId: input.escalationId ?? null,
        kind: input.kind,
        now,
    });
    const summary = scrubSummary(input.safeSummary);
    // Pre-check the unique key. If the row exists, return it without
    // attempting an insert (cheaper than catching the unique-violation).
    const existing = await client.reviewerOpsReminder.findUnique({
        where: {
            teamId_kind_dedupKey: {
                teamId: input.teamId,
                kind: input.kind,
                dedupKey,
            },
        },
    });
    if (existing) {
        bump("reviewer_reminder_duplicate_blocked_total");
        return {
            ok: true,
            created: false,
            reminder: projectReminder(existing),
        };
    }
    try {
        const created = await client.reviewerOpsReminder.create({
            data: {
                teamId: input.teamId,
                kind: input.kind,
                dedupKey,
                workflowId: input.workflowId ?? null,
                escalationId: input.escalationId ?? null,
                reviewerUserId: input.reviewerUserId ?? null,
                safeSummary: summary,
                status: "SCHEDULED",
                dayBucket: dayBucket(now),
            },
        });
        bump("reviewer_reminder_scheduled_total");
        safeEmitSecurityEvent({
            teamId: input.teamId,
            eventType: "reviewer_reminder_scheduled",
            severity: "INFO",
            details: {
                reminderId: created.id,
                kind: input.kind,
                workflowId: input.workflowId ?? null,
                reviewerUserId: input.reviewerUserId ?? null,
            },
        });
        return { ok: true, created: true, reminder: projectReminder(created) };
    }
    catch (err) {
        // Race: another sweep won the insert. Re-read.
        const racer = await client.reviewerOpsReminder.findUnique({
            where: {
                teamId_kind_dedupKey: {
                    teamId: input.teamId,
                    kind: input.kind,
                    dedupKey,
                },
            },
        });
        if (racer) {
            bump("reviewer_reminder_duplicate_blocked_total");
            return { ok: true, created: false, reminder: projectReminder(racer) };
        }
        // Unknown failure — bump + return safely.
        bump("reviewer_reminder_failed_total");
        return {
            ok: false,
            reason: err instanceof Error ? "unknown" : "unknown",
        };
    }
}
// -----------------------------------------------------------------------------
// Public — markReminderDelivered / markReminderFailed
// -----------------------------------------------------------------------------
export async function markReminderDelivered(input, client = defaultPrisma) {
    await client.reviewerOpsReminder.updateMany({
        where: { id: input.reminderId, teamId: input.teamId },
        data: {
            status: "DELIVERED",
            communicationMessageId: input.communicationMessageId ?? null,
        },
    });
    bump("reviewer_reminder_delivered_total");
    safeEmitSecurityEvent({
        teamId: input.teamId,
        eventType: "reviewer_reminder_delivered",
        severity: "INFO",
        details: {
            reminderId: input.reminderId,
            communicationMessageId: input.communicationMessageId ?? null,
        },
    });
}
export async function markReminderFailed(input, client = defaultPrisma) {
    await client.reviewerOpsReminder.updateMany({
        where: { id: input.reminderId, teamId: input.teamId },
        data: { status: "FAILED" },
    });
    bump("reviewer_reminder_failed_total");
    safeEmitSecurityEvent({
        teamId: input.teamId,
        eventType: "reviewer_reminder_failed",
        severity: "WARNING",
        details: {
            reminderId: input.reminderId,
            reason: input.reason.slice(0, 160),
        },
    });
}
export async function sweepDueSoonReminders(input, client = defaultPrisma) {
    const batchSize = Math.min(Math.max(input.batchSize ?? 200, 1), 1000);
    const rows = await client.evidenceReviewWorkflow.findMany({
        where: {
            teamId: input.teamId,
            slaStatus: "DUE_SOON",
            assignedToUserId: { not: null },
            status: {
                notIn: ["CLOSED", "REJECTED_INSUFFICIENT", "APPROVED_INTERNAL"],
            },
        },
        take: batchSize,
        select: {
            id: true,
            assignedToUserId: true,
            priority: true,
            dueAt: true,
        },
    });
    let scheduled = 0;
    let duplicates = 0;
    for (const r of rows) {
        const res = await scheduleReminder({
            teamId: input.teamId,
            kind: "DUE_SOON",
            workflowId: r.id,
            reviewerUserId: r.assignedToUserId,
            safeSummary: `Review due soon — priority ${r.priority.toLowerCase()}.`,
        }, client);
        if (res.ok && res.created)
            scheduled += 1;
        else if (res.ok)
            duplicates += 1;
    }
    return { scanned: rows.length, scheduled, duplicates };
}
export async function sweepInactivityReminders(input, client = defaultPrisma) {
    const batchSize = Math.min(Math.max(input.batchSize ?? 200, 1), 1000);
    const cutoff = new Date(Date.now() - input.thresholdHours * 3600_000);
    const rows = await client.evidenceReviewWorkflow.findMany({
        where: {
            teamId: input.teamId,
            assignedToUserId: { not: null },
            status: {
                notIn: ["CLOSED", "REJECTED_INSUFFICIENT", "APPROVED_INTERNAL"],
            },
            OR: [
                { lastReviewedAt: { lte: cutoff } },
                { lastReviewedAt: null, assignedAtUtc: { lte: cutoff } },
            ],
        },
        take: batchSize,
        select: {
            id: true,
            assignedToUserId: true,
            assignedAtUtc: true,
            lastReviewedAt: true,
        },
    });
    let scheduled = 0;
    let duplicates = 0;
    for (const r of rows) {
        const res = await scheduleReminder({
            teamId: input.teamId,
            kind: "REVIEWER_INACTIVE",
            workflowId: r.id,
            reviewerUserId: r.assignedToUserId,
            safeSummary: `Reviewer inactive on this assignment for over ${input.thresholdHours}h.`,
        }, client);
        if (res.ok && res.created) {
            scheduled += 1;
            bump("reviewer_inactivity_detected_total");
        }
        else if (res.ok) {
            duplicates += 1;
        }
    }
    return { scanned: rows.length, scheduled, duplicates };
}
// -----------------------------------------------------------------------------
// List — used by the UI to surface a reviewer's open reminders.
// -----------------------------------------------------------------------------
export async function listReminders(input, client = defaultPrisma) {
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 500);
    const rows = await client.reviewerOpsReminder.findMany({
        where: {
            teamId: input.teamId,
            ...(input.kind ? { kind: input.kind } : {}),
            ...(input.workflowId ? { workflowId: input.workflowId } : {}),
            ...(input.reviewerUserId
                ? { reviewerUserId: input.reviewerUserId }
                : {}),
        },
        orderBy: { createdAt: "desc" },
        take: limit,
    });
    return rows.map(projectReminder);
}
