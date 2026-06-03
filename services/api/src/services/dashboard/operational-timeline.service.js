/**
 * Phase 32.8C+++++ — OperationalTimelineEvent projection writer + reader.
 *
 * Builds a normalized timeline projection from existing source tables:
 *   - CustodyEvent           (CUSTODY family)
 *   - EvidenceLifecycleEvent (GOVERNANCE family)
 *   - OperationalIncident    (OPS family)
 *
 * Projection is idempotent: the (source_table, source_id, event_type)
 * unique constraint folds repeat projections into a single row. Bounded
 * batch size keeps the writer cheap.
 *
 * Hard rules:
 *   - Writer failures NEVER block evidence/report/package/verify flows.
 *   - No raw payloads, signed URLs, storage keys, or sensitive content
 *     are projected — only bounded operator-safe summaries.
 *   - Dashboard reads from the projection first; falls back to a small
 *     live-aggregation slice when empty.
 */
import { prisma } from "../../db.js";
/** Bounded ingestion size — never project more than 200 rows per source per call. */
const INGEST_LIMIT_PER_SOURCE = 200;
/**
 * Project recent rows from source tables into operational_timeline_events.
 * Returns the count of rows that were either created or already existed
 * (idempotent). Never throws.
 */
export async function projectWorkspaceTimeline(input) {
    let projected = 0;
    let failed = 0;
    const minutes = Math.min(Math.max(input.sinceMinutes ?? 60 * 24 * 7, 1), 60 * 24 * 30);
    const since = new Date(Date.now() - minutes * 60 * 1000);
    // Custody events — restricted to evidence in this workspace.
    try {
        const custody = await prisma.custodyEvent.findMany({
            where: {
                atUtc: { gte: since },
                evidence: { teamId: input.teamId },
            },
            take: INGEST_LIMIT_PER_SOURCE,
            orderBy: { atUtc: "desc" },
            select: {
                id: true,
                evidenceId: true,
                eventType: true,
                atUtc: true,
            },
        });
        for (const e of custody) {
            try {
                await projectOne({
                    teamId: input.teamId,
                    evidenceId: e.evidenceId,
                    actorUserId: null,
                    eventFamily: "CUSTODY",
                    eventType: String(e.eventType).slice(0, 80),
                    severity: "INFO",
                    occurredAtUtc: e.atUtc,
                    sourceTable: "custody_events",
                    sourceId: e.id,
                    summary: `Custody event recorded: ${String(e.eventType)}`,
                });
                projected += 1;
            }
            catch {
                failed += 1;
            }
        }
    }
    catch {
        /* outer read failure — degrade gracefully. */
    }
    // Evidence lifecycle events — governance family.
    try {
        const lifecycle = await prisma.evidenceLifecycleEvent.findMany({
            where: {
                teamId: input.teamId,
                createdAt: { gte: since },
            },
            take: INGEST_LIMIT_PER_SOURCE,
            orderBy: { createdAt: "desc" },
            select: {
                id: true,
                evidenceId: true,
                eventType: true,
                summary: true,
                actorUserId: true,
                createdAt: true,
            },
        });
        for (const e of lifecycle) {
            try {
                await projectOne({
                    teamId: input.teamId,
                    evidenceId: e.evidenceId,
                    actorUserId: e.actorUserId,
                    eventFamily: "GOVERNANCE",
                    eventType: e.eventType.slice(0, 80),
                    severity: "INFO",
                    occurredAtUtc: e.createdAt,
                    sourceTable: "evidence_lifecycle_events",
                    sourceId: e.id,
                    summary: e.summary,
                });
                projected += 1;
            }
            catch {
                failed += 1;
            }
        }
    }
    catch {
        /* outer read failure — degrade gracefully. */
    }
    // Operational incidents — ops family.
    try {
        const incidents = await prisma.operationalIncident.findMany({
            where: {
                teamId: input.teamId,
                firstSeenAtUtc: { gte: since },
            },
            take: INGEST_LIMIT_PER_SOURCE,
            orderBy: { firstSeenAtUtc: "desc" },
            select: {
                id: true,
                category: true,
                severity: true,
                status: true,
                safeSummary: true,
                relatedEvidenceId: true,
                firstSeenAtUtc: true,
            },
        });
        for (const inc of incidents) {
            try {
                await projectOne({
                    teamId: input.teamId,
                    evidenceId: inc.relatedEvidenceId,
                    actorUserId: null,
                    eventFamily: "OPS",
                    eventType: `incident.${String(inc.category).toLowerCase()}`.slice(0, 80),
                    severity: String(inc.severity).slice(0, 24),
                    occurredAtUtc: inc.firstSeenAtUtc,
                    sourceTable: "operational_incidents",
                    sourceId: inc.id,
                    summary: inc.safeSummary,
                });
                projected += 1;
            }
            catch {
                failed += 1;
            }
        }
    }
    catch {
        /* outer read failure — degrade gracefully. */
    }
    return { projected, failed };
}
async function projectOne(input) {
    // Idempotent upsert keyed on (source_table, source_id, event_type).
    await prisma.operationalTimelineEvent.upsert({
        where: {
            operational_timeline_source_uniq: {
                sourceTable: input.sourceTable,
                sourceId: input.sourceId,
                eventType: input.eventType,
            },
        },
        create: {
            teamId: input.teamId,
            caseId: input.caseId ?? null,
            evidenceId: input.evidenceId,
            actorUserId: input.actorUserId,
            eventFamily: input.eventFamily,
            eventType: input.eventType,
            severity: input.severity,
            occurredAtUtc: input.occurredAtUtc,
            sourceTable: input.sourceTable,
            sourceId: input.sourceId,
            confidence: input.confidence ?? "DIRECT",
            safeToDisplay: true,
            summary: input.summary.slice(0, 400),
            route: input.route ? input.route.slice(0, 400) : null,
        },
        update: {
            // Mostly immutable — only the summary may be refreshed if classifier
            // wording evolves. Bounded re-write.
            summary: input.summary.slice(0, 400),
        },
    });
}
/**
 * Dashboard reader: returns the bounded most-recent slice of timeline
 * events for a workspace. Only safe-to-display rows are returned.
 */
export async function listWorkspaceTimelineEvents(input) {
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
    const rows = await prisma.operationalTimelineEvent.findMany({
        where: {
            teamId: input.teamId,
            safeToDisplay: true,
        },
        orderBy: { occurredAtUtc: "desc" },
        take: limit,
        select: {
            id: true,
            eventFamily: true,
            eventType: true,
            severity: true,
            occurredAtUtc: true,
            summary: true,
            evidenceId: true,
            caseId: true,
            route: true,
            confidence: true,
        },
    });
    return rows.map((r) => ({
        id: r.id,
        eventFamily: r.eventFamily,
        eventType: r.eventType,
        severity: r.severity,
        occurredAtUtc: r.occurredAtUtc.toISOString(),
        summary: r.summary,
        evidenceId: r.evidenceId,
        caseId: r.caseId,
        route: r.route,
        confidence: r.confidence,
    }));
}
