/**
 * Phase 28-D — Operational Activity Timeline.
 *
 * Merges three real event streams into one chronological view:
 *
 *   1. EvidenceLifecycleEvent — lifecycle transitions, hold placed/
 *      released, retention applied, destruction-review milestones.
 *   2. EvidenceReviewWorkflowEvent — reviewer-ops actions (assignment,
 *      decision, SLA flips, escalation lifecycle).
 *   3. OperationalIncident — open / acknowledged / resolved incidents
 *      tied to the evidence (storm, immutable drift, ...).
 *
 * The brief explicitly forbids inventing events. This service only
 * projects what the writers already recorded. It never derives an
 * event from a state value; every entry is sourced from a real row.
 *
 * Privacy:
 *   - Returns operator-safe summaries only. Private reviewer notes,
 *     decision-note bodies, and legal-note bodies are NEVER included.
 *   - Metadata objects are filtered through a safe-key allow list.
 *   - External-reviewer consumers should call the variant that
 *     applies workflow-visibility decisions; that's a planned
 *     follow-up but the projection here is already PII-free.
 */
import { prisma as defaultPrisma } from "../../db.js";
import { bump } from "../ops/metrics.service.js";
// -----------------------------------------------------------------------------
// Lifecycle event projection
// -----------------------------------------------------------------------------
function lifecycleLabel(eventType, toState) {
    switch (eventType) {
        case "lifecycle_transition":
            return `Lifecycle: ${toState ?? "transition"}`;
        case "retention_applied":
            return "Retention policy applied";
        case "retention_recomputed":
            return "Retention recomputed";
        case "hold_placed":
            return "Legal hold placed";
        case "hold_released":
            return "Legal hold released";
        case "destruction_review_created":
            return "Destruction review opened";
        case "destruction_review_approved":
            return "Destruction review approved";
        case "destruction_review_denied":
            return "Destruction review denied";
        case "destruction_review_restored":
            return "Destruction review restored";
        case "destruction_review_deferred":
            return "Destruction review deferred";
        case "destruction_executed":
            return "Destruction executed";
        case "policy_attached":
            return "Retention policy attached";
        case "policy_superseded":
            return "Retention policy superseded";
        case "archive_requested":
            return "Archive requested";
        case "restore_requested":
            return "Restore requested";
        default:
            return `Lifecycle event: ${eventType}`;
    }
}
function lifecycleSeverity(eventType) {
    switch (eventType) {
        case "destruction_executed":
            return "HIGH";
        case "hold_placed":
        case "destruction_review_created":
            return "WARNING";
        default:
            return "INFO";
    }
}
// -----------------------------------------------------------------------------
// Review event projection
// -----------------------------------------------------------------------------
function reviewLabel(eventType, toStatus) {
    switch (eventType) {
        case "ASSIGNED":
            return "Reviewer assigned";
        case "REASSIGNED":
            return "Reviewer reassigned";
        case "STARTED":
            return "Review started";
        case "PAUSED":
            return "Review paused";
        case "RESUMED":
            return "Review resumed";
        case "INFO_REQUESTED":
            return "More information requested";
        case "INFO_PROVIDED":
            return "Information provided";
        case "APPROVED":
            return "Review approved";
        case "REJECTED":
            return "Review rejected";
        case "REOPENED":
            return "Review reopened";
        case "SLA_UPDATED":
            return "SLA updated";
        case "SLA_DUE_SOON":
            return "SLA due soon";
        case "SLA_BREACHED":
            return "SLA breached";
        case "ESCALATED":
            return "Escalated";
        case "ESCALATION_ACKNOWLEDGED":
            return "Escalation acknowledged";
        case "ESCALATION_RESOLVED":
            return "Escalation resolved";
        case "DECISION_RECORDED":
            return `Review decision: ${toStatus ?? "recorded"}`;
        default:
            return `Review event: ${eventType}`;
    }
}
function reviewSeverity(eventType) {
    switch (eventType) {
        case "SLA_BREACHED":
        case "ESCALATED":
        case "REJECTED":
            return "HIGH";
        case "SLA_DUE_SOON":
        case "PAUSED":
        case "INFO_REQUESTED":
            return "WARNING";
        default:
            return "INFO";
    }
}
// -----------------------------------------------------------------------------
// Incident projection
// -----------------------------------------------------------------------------
function incidentSeverity(severity) {
    if (severity === "CRITICAL")
        return "CRITICAL";
    if (severity === "HIGH")
        return "HIGH";
    if (severity === "WARNING")
        return "WARNING";
    return "INFO";
}
// -----------------------------------------------------------------------------
// Service entry
// -----------------------------------------------------------------------------
export async function buildOperationalTimeline(input, client = defaultPrisma) {
    bump("operational_timeline_loaded_total");
    const cap = Math.min(input.limit ?? 100, 500);
    const evidence = await client.evidence.findFirst({
        where: { id: input.evidenceId, teamId: input.teamId },
        select: { id: true, teamId: true },
    });
    if (!evidence) {
        return {
            evidenceId: input.evidenceId,
            teamId: input.teamId,
            generatedAtUtc: new Date().toISOString(),
            entries: [],
        };
    }
    const [lifecycleEvents, reviewEvents, incidents] = await Promise.all([
        client.evidenceLifecycleEvent.findMany({
            where: { evidenceId: input.evidenceId },
            orderBy: { createdAt: "desc" },
            take: cap,
            select: {
                id: true,
                eventType: true,
                toState: true,
                summary: true,
                actorUserId: true,
                createdAt: true,
            },
        }),
        client.evidenceReviewWorkflowEvent.findMany({
            where: { evidenceId: input.evidenceId },
            orderBy: { createdAt: "desc" },
            take: cap,
            select: {
                id: true,
                eventType: true,
                nextValue: true,
                actorUserId: true,
                createdAt: true,
            },
        }),
        client.operationalIncident.findMany({
            where: {
                teamId: input.teamId,
                relatedEvidenceId: input.evidenceId,
            },
            orderBy: { firstSeenAtUtc: "desc" },
            take: cap,
            select: {
                id: true,
                severity: true,
                status: true,
                category: true,
                title: true,
                safeSummary: true,
                firstSeenAtUtc: true,
            },
        }),
    ]);
    const entries = [];
    for (const evt of lifecycleEvents) {
        entries.push({
            id: evt.id,
            kind: "lifecycle",
            eventType: evt.eventType,
            label: lifecycleLabel(evt.eventType, evt.toState ?? null),
            severity: lifecycleSeverity(evt.eventType),
            occurredAtUtc: evt.createdAt.toISOString(),
            actorUserId: evt.actorUserId,
            // summary is a short, operator-readable string written by the
            // lifecycle orchestrator. It carries no private content (the
            // orchestrator's scrubMetadata is the writer).
            safeSummary: evt.summary ?? null,
        });
    }
    for (const evt of reviewEvents) {
        // nextValue is JSONB and may contain a `status` field on
        // DECISION_RECORDED rows. We pluck only the bounded label hint;
        // private review notes live in EvidenceReviewWorkflowEvent.note
        // which is intentionally NEVER read here.
        const nextValueStatus = evt.nextValue &&
            typeof evt.nextValue === "object" &&
            !Array.isArray(evt.nextValue) &&
            typeof evt.nextValue.status === "string"
            ? evt.nextValue.status
            : null;
        entries.push({
            id: evt.id,
            kind: "review",
            eventType: evt.eventType,
            label: reviewLabel(evt.eventType, nextValueStatus),
            severity: reviewSeverity(evt.eventType),
            occurredAtUtc: evt.createdAt.toISOString(),
            actorUserId: evt.actorUserId ?? null,
            // review events' note field may carry private content; we
            // intentionally never surface it through this projection.
            safeSummary: null,
        });
    }
    for (const incident of incidents) {
        entries.push({
            id: incident.id,
            kind: "incident",
            eventType: `operational_incident_${incident.status.toLowerCase()}`,
            label: incident.title,
            severity: incidentSeverity(incident.severity),
            occurredAtUtc: incident.firstSeenAtUtc.toISOString(),
            actorUserId: null,
            safeSummary: incident.safeSummary,
        });
    }
    entries.sort((a, b) => a.occurredAtUtc < b.occurredAtUtc ? 1 : a.occurredAtUtc > b.occurredAtUtc ? -1 : 0);
    return {
        evidenceId: input.evidenceId,
        teamId: input.teamId,
        generatedAtUtc: new Date().toISOString(),
        entries: entries.slice(0, cap),
    };
}
