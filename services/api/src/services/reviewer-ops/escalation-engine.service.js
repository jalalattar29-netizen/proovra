/**
 * Phase 25 — Reviewer escalation engine.
 *
 * The single writer of `review_escalations`. Every escalation lifecycle
 * mutation goes through this service so the catalog enforcement +
 * fingerprint deduplication + audit + metrics + operational-incident
 * fan-out happen in exactly one place.
 *
 * Hard invariants:
 *   - Reason / status strings are validated against the shared catalogs
 *     before they hit the DB; the schema column is VARCHAR so the
 *     service is the validator.
 *   - Idempotency: the fingerprint `${workflowId}:${reason}:${dayBucket}`
 *     is unique per (teamId, fingerprint). A duplicate insert bumps
 *     `reviewer_escalation_duplicate_blocked_total` and returns the
 *     existing row — no exception thrown to the caller.
 *   - `safeSummary` is bounded (400 chars) and scrubbed against the
 *     forbidden-overclaim phrase catalog.
 *   - Status transitions follow the shared
 *     `isAllowedEscalationStatusTransition` matrix; invalid transitions
 *     surface a `REVIEW_INVALID_TRANSITION` error code.
 *   - HIGH / CRITICAL escalations open a Phase 21 operational incident
 *     via the existing `recordIncident` helper. WARNING / INFO do not.
 */
import { createHash } from "node:crypto";
import { REVIEW_ESCALATION_REASONS, REVIEW_ESCALATION_STATUSES, isAllowedEscalationStatusTransition, isTerminalReviewEscalationStatus, stringContainsForbiddenOverclaim, } from "@proovra/shared";
import { prisma as defaultPrisma } from "../../db.js";
import { bump } from "../ops/metrics.service.js";
import { safeEmitSecurityEvent } from "../security/security-event.service.js";
import { recordIncident } from "../observability/incident.service.js";
import { appendPlatformAuditLog } from "../platform-audit-log.service.js";
// -----------------------------------------------------------------------------
// Error
// -----------------------------------------------------------------------------
export class EscalationEngineError extends Error {
    code;
    details;
    constructor(code, details) {
        super(code);
        this.code = code;
        this.details = details;
        this.name = "EscalationEngineError";
    }
}
export function projectEscalation(row) {
    return {
        id: row.id,
        teamId: row.teamId,
        workflowId: row.workflowId,
        workflowInstanceId: row.workflowInstanceId,
        evidenceId: row.evidenceId,
        reason: row.reason,
        severity: row.severity,
        status: row.status,
        safeSummary: row.safeSummary,
        createdByUserId: row.createdByUserId,
        assignedToUserId: row.assignedToUserId,
        acknowledgedAtUtc: row.acknowledgedAtUtc?.toISOString() ?? null,
        acknowledgedByUserId: row.acknowledgedByUserId,
        resolvedAtUtc: row.resolvedAtUtc?.toISOString() ?? null,
        resolvedByUserId: row.resolvedByUserId,
        resolutionNote: row.resolutionNote,
        suppressedAtUtc: row.suppressedAtUtc?.toISOString() ?? null,
        suppressionReason: row.suppressionReason,
        incidentId: row.incidentId,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
    };
}
// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------
const REASON_SET = new Set(REVIEW_ESCALATION_REASONS);
const STATUS_SET = new Set(REVIEW_ESCALATION_STATUSES);
const SEVERITY_SET = new Set(["INFO", "WARNING", "HIGH", "CRITICAL"]);
function dayBucket(now) {
    return now.toISOString().slice(0, 10); // YYYY-MM-DD
}
function buildFingerprint(input) {
    const raw = `${input.workflowId}:${input.reason}:${dayBucket(input.now)}`;
    return createHash("sha256").update(raw).digest("hex").slice(0, 64);
}
function sanitiseSummary(summary) {
    const trimmed = summary.trim().slice(0, 400);
    if (stringContainsForbiddenOverclaim(trimmed)) {
        // Strip the overclaim by replacing the string with a safe stub.
        // Operators see "[summary withheld — wording violation]" so the
        // escalation still surfaces but never carries the bad phrase.
        return "[summary withheld — wording violation]";
    }
    return trimmed.length > 0 ? trimmed : "Escalation raised by reviewer ops engine.";
}
function sanitiseNote(note) {
    const trimmed = note.trim().slice(0, 400);
    if (stringContainsForbiddenOverclaim(trimmed)) {
        return "[note withheld — wording violation]";
    }
    return trimmed;
}
export async function createEscalation(input, client = defaultPrisma) {
    // Catalog guards — the caller passed a typed value, but routes
    // ingest user JSON so we re-validate at the service boundary.
    if (!REASON_SET.has(input.reason)) {
        return { ok: false, code: "REVIEW_PERMISSION_DENIED" };
    }
    const severity = input.severity ?? "WARNING";
    if (!SEVERITY_SET.has(severity)) {
        return { ok: false, code: "REVIEW_PERMISSION_DENIED" };
    }
    // Confirm workflow belongs to the team.
    const workflow = await client.evidenceReviewWorkflow.findFirst({
        where: { id: input.workflowId, teamId: input.teamId },
        select: {
            id: true,
            evidenceId: true,
            assignedToUserId: true,
            escalationLevel: true,
        },
    });
    if (!workflow)
        return { ok: false, code: "REVIEW_WORKFLOW_NOT_FOUND" };
    const now = new Date();
    const summary = sanitiseSummary(input.safeSummary);
    const fingerprint = buildFingerprint({
        workflowId: input.workflowId,
        reason: input.reason,
        now,
    });
    // Try the dedup'd insert first.
    if (!input.bypassDedup) {
        const existing = await client.reviewEscalation.findUnique({
            where: { teamId_fingerprint: { teamId: input.teamId, fingerprint } },
        });
        if (existing) {
            bump("reviewer_escalation_duplicate_blocked_total");
            return {
                ok: true,
                created: false,
                escalation: projectEscalation(existing),
            };
        }
    }
    const created = await client.reviewEscalation.create({
        data: {
            teamId: input.teamId,
            workflowId: input.workflowId,
            workflowInstanceId: input.workflowInstanceId ?? null,
            evidenceId: input.evidenceId ?? workflow.evidenceId,
            reason: input.reason,
            severity,
            status: "OPEN",
            safeSummary: summary,
            createdByUserId: input.createdByUserId ?? null,
            assignedToUserId: input.assignedToUserId ?? workflow.assignedToUserId ?? null,
            fingerprint,
        },
    });
    bump("reviewer_escalation_created_total");
    // Update the workflow's denormalised pointer + escalation counters.
    await client.evidenceReviewWorkflow.update({
        where: { id: input.workflowId },
        data: {
            activeEscalationId: created.id,
            escalationLevel: workflow.escalationLevel + 1,
            escalatedAtUtc: now,
            escalationReason: input.reason,
        },
    });
    // HIGH / CRITICAL escalations open a Phase 21 incident.
    let linkedIncidentId = null;
    if (severity === "HIGH" || severity === "CRITICAL") {
        try {
            const inc = await recordIncident({
                teamId: input.teamId,
                category: "GOVERNANCE",
                severity: severity === "CRITICAL" ? "CRITICAL" : "HIGH",
                fingerprint: `review-escalation:${input.reason}:${input.workflowId}`,
                title: `Reviewer escalation — ${input.reason}`,
                safeSummary: summary,
                relatedEvidenceId: workflow.evidenceId,
                runbookSlug: input.reason === "REVIEW_OVERDUE" ||
                    input.reason === "FIRST_REVIEW_OVERDUE" ||
                    input.reason === "COMPLETION_OVERDUE"
                    ? "reviewer-sla-breach"
                    : "reviewer-escalation-backlog",
                metadata: {
                    workflowId: input.workflowId,
                    escalationId: created.id,
                    reason: input.reason,
                },
            });
            linkedIncidentId = inc.incident.id;
            await client.reviewEscalation.update({
                where: { id: created.id },
                data: { incidentId: linkedIncidentId },
            });
        }
        catch {
            /* incident creation is best-effort; never breaks escalation flow */
        }
    }
    safeEmitSecurityEvent({
        teamId: input.teamId,
        eventType: "reviewer_escalation_created",
        severity: severity === "CRITICAL" ? "HIGH" : severity === "HIGH" ? "HIGH" : severity === "WARNING" ? "WARNING" : "INFO",
        details: {
            escalationId: created.id,
            workflowId: input.workflowId,
            reason: input.reason,
            severity,
            actorUserId: input.createdByUserId ?? null,
            assignedToUserId: created.assignedToUserId,
            incidentId: linkedIncidentId,
        },
    });
    await appendPlatformAuditLog({
        userId: input.createdByUserId ?? null,
        action: "reviewer.escalation.create",
        category: "review",
        severity: severity === "CRITICAL" || severity === "HIGH" ? "warning" : "info",
        source: "reviewer_ops_engine",
        outcome: "success",
        resourceType: "review_escalation",
        resourceId: created.id,
        metadata: {
            teamId: input.teamId,
            workflowId: input.workflowId,
            reason: input.reason,
            severity,
            incidentId: linkedIncidentId,
        },
        db: client,
    });
    return {
        ok: true,
        created: true,
        escalation: projectEscalation({
            ...created,
            incidentId: linkedIncidentId,
        }),
    };
}
async function loadAndAssertOpen(ctx, client) {
    const row = await client.reviewEscalation.findFirst({
        where: { id: ctx.escalationId, teamId: ctx.teamId },
    });
    if (!row)
        throw new EscalationEngineError("REVIEW_ESCALATION_NOT_FOUND");
    if (isTerminalReviewEscalationStatus(row.status)) {
        throw new EscalationEngineError("REVIEW_ESCALATION_TERMINAL");
    }
    return row;
}
function assertTransition(from, to) {
    if (!isAllowedEscalationStatusTransition(from, to)) {
        throw new EscalationEngineError("REVIEW_INVALID_TRANSITION", { from, to });
    }
}
export async function acknowledgeEscalation(input, client = defaultPrisma) {
    const row = await loadAndAssertOpen(input, client);
    assertTransition(row.status, "ACKNOWLEDGED");
    const now = new Date();
    const updated = await client.reviewEscalation.update({
        where: { id: row.id },
        data: {
            status: "ACKNOWLEDGED",
            acknowledgedAtUtc: now,
            acknowledgedByUserId: input.actorUserId,
        },
    });
    bump("reviewer_escalation_acknowledged_total");
    safeEmitSecurityEvent({
        teamId: input.teamId,
        eventType: "reviewer_escalation_acknowledged",
        severity: "INFO",
        details: { escalationId: row.id, actorUserId: input.actorUserId },
    });
    return projectEscalation(updated);
}
export async function reassignEscalation(input, client = defaultPrisma) {
    const row = await loadAndAssertOpen(input, client);
    assertTransition(row.status, "REASSIGNED");
    const updated = await client.reviewEscalation.update({
        where: { id: row.id },
        data: {
            status: "REASSIGNED",
            assignedToUserId: input.newAssigneeUserId,
        },
    });
    safeEmitSecurityEvent({
        teamId: input.teamId,
        eventType: "reviewer_escalation_reassigned",
        severity: "INFO",
        details: {
            escalationId: row.id,
            newAssigneeUserId: input.newAssigneeUserId,
            actorUserId: input.actorUserId,
        },
    });
    return projectEscalation(updated);
}
export async function resolveEscalation(input, client = defaultPrisma) {
    if (input.resolutionNote.trim().length === 0) {
        throw new EscalationEngineError("REVIEW_NOTE_REQUIRED");
    }
    const row = await loadAndAssertOpen(input, client);
    assertTransition(row.status, "RESOLVED");
    const now = new Date();
    const updated = await client.reviewEscalation.update({
        where: { id: row.id },
        data: {
            status: "RESOLVED",
            resolvedAtUtc: now,
            resolvedByUserId: input.actorUserId,
            resolutionNote: sanitiseNote(input.resolutionNote),
        },
    });
    // Clear the workflow's active-escalation pointer if it still points
    // at this escalation.
    await client.evidenceReviewWorkflow.updateMany({
        where: { id: row.workflowId, activeEscalationId: row.id },
        data: { activeEscalationId: null },
    });
    bump("reviewer_escalation_resolved_total");
    safeEmitSecurityEvent({
        teamId: input.teamId,
        eventType: "reviewer_escalation_resolved",
        severity: "INFO",
        details: {
            escalationId: row.id,
            actorUserId: input.actorUserId,
        },
    });
    await appendPlatformAuditLog({
        userId: input.actorUserId,
        action: "reviewer.escalation.resolve",
        category: "review",
        severity: "info",
        source: "reviewer_ops_engine",
        outcome: "success",
        resourceType: "review_escalation",
        resourceId: row.id,
        metadata: { teamId: input.teamId, workflowId: row.workflowId },
        db: client,
    });
    return projectEscalation(updated);
}
export async function suppressEscalation(input, client = defaultPrisma) {
    if (input.suppressionReason.trim().length === 0) {
        throw new EscalationEngineError("REVIEW_NOTE_REQUIRED");
    }
    const row = await loadAndAssertOpen(input, client);
    assertTransition(row.status, "SUPPRESSED");
    const now = new Date();
    const updated = await client.reviewEscalation.update({
        where: { id: row.id },
        data: {
            status: "SUPPRESSED",
            suppressedAtUtc: now,
            suppressionReason: sanitiseNote(input.suppressionReason),
        },
    });
    await client.evidenceReviewWorkflow.updateMany({
        where: { id: row.workflowId, activeEscalationId: row.id },
        data: { activeEscalationId: null },
    });
    bump("reviewer_escalation_suppressed_total");
    safeEmitSecurityEvent({
        teamId: input.teamId,
        eventType: "reviewer_escalation_suppressed",
        severity: "INFO",
        details: { escalationId: row.id, actorUserId: input.actorUserId },
    });
    return projectEscalation(updated);
}
export async function listEscalations(input, client = defaultPrisma) {
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
    const rows = await client.reviewEscalation.findMany({
        where: {
            teamId: input.teamId,
            ...(input.status && input.status !== "ALL"
                ? { status: input.status }
                : {}),
            ...(input.severity ? { severity: input.severity } : {}),
            ...(input.reason ? { reason: input.reason } : {}),
            ...(input.assignedToUserId
                ? { assignedToUserId: input.assignedToUserId }
                : {}),
        },
        orderBy: [{ severity: "desc" }, { createdAt: "desc" }],
        take: limit,
    });
    return rows.map(projectEscalation);
}
// Convenience: pull the current OPEN escalation for a workflow (used
// by the engine + workspace UI). Returns null when none open.
export async function findOpenEscalationForWorkflow(input, client = defaultPrisma) {
    const row = await client.reviewEscalation.findFirst({
        where: {
            teamId: input.teamId,
            workflowId: input.workflowId,
            status: { in: ["OPEN", "ACKNOWLEDGED", "REASSIGNED"] },
        },
        orderBy: { createdAt: "desc" },
    });
    return row ? projectEscalation(row) : null;
}
