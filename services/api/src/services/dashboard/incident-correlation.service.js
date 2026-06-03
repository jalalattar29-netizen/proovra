/**
 * Phase 32.8C — Operations Control Plane: Cross-System Correlation Engine.
 *
 * Scans recently active `OperationalIncident` rows and detects known
 * multi-incident patterns. When a pattern matches, persists an
 * `OperationalCorrelation` row so the dashboard can surface the root
 * cause — not the individual symptoms.
 *
 * Hard rules:
 *   - Generator never throws — correlation failures NEVER block
 *     evidence / report / package / verify core flows.
 *   - Patterns are deterministic: each pattern requires N >= 2 OPEN /
 *     ACKNOWLEDGED incidents in defined categories within a bounded
 *     time window. No statistical scoring, no ML.
 *   - Output is bounded operator-safe summaries + recommended actions.
 *     No raw payloads, no signed URLs, no secrets.
 *   - Correlations are idempotent: keyed on (teamId, correlationKey),
 *     so repeated detection collapses into one row with
 *     `lastDetectedAtUtc` ticked.
 *   - Stale correlations auto-expire via `expiresAtUtc` (read filter
 *     drops rows past that timestamp).
 */
import { prisma } from "../../db.js";
const CORRELATION_WINDOW_HOURS = 2;
const CORRELATION_EXPIRY_HOURS = 24;
/**
 * Run the correlation scan for one workspace. Never throws. Returns the
 * number of correlations persisted.
 */
export async function correlateWorkspaceIncidents(input) {
    let persisted = 0;
    let failed = 0;
    const patterns = [];
    let incidents = [];
    try {
        const since = new Date(Date.now() - CORRELATION_WINDOW_HOURS * 60 * 60 * 1000);
        incidents = (await prisma.operationalIncident.findMany({
            where: {
                OR: [{ teamId: input.teamId }, { teamId: null }],
                status: { in: ["OPEN", "ACKNOWLEDGED"] },
                lastSeenAtUtc: { gte: since },
            },
            orderBy: { lastSeenAtUtc: "desc" },
            take: 200,
            select: {
                id: true,
                category: true,
                severity: true,
                status: true,
                fingerprint: true,
                lastSeenAtUtc: true,
            },
        }));
    }
    catch {
        // Read failure — return zero. Never block.
        return { persisted: 0, failed: 0, patterns: [] };
    }
    if (incidents.length === 0)
        return { persisted: 0, failed: 0, patterns: [] };
    for (const candidate of detectPatterns(incidents, input.teamId)) {
        try {
            await persistCorrelation(input.teamId, candidate);
            persisted += 1;
            patterns.push(candidate.correlationType);
        }
        catch {
            failed += 1;
        }
    }
    return { persisted, failed, patterns };
}
function detectPatterns(incidents, teamId) {
    const candidates = [];
    const reportIncidents = incidents.filter((i) => i.category === "REPORT");
    const packageIncidents = incidents.filter((i) => i.category === "PACKAGE");
    const workerIncidents = incidents.filter((i) => i.category === "WORKER");
    const governanceIncidents = incidents.filter((i) => i.category === "GOVERNANCE");
    const storageIncidents = incidents.filter((i) => i.category === "STORAGE");
    const databaseIncidents = incidents.filter((i) => i.category === "DATABASE");
    const integrationIncidents = incidents.filter((i) => i.category === "INTEGRATION");
    // 1. Pipeline degradation: report + package incidents in the same window.
    if (reportIncidents.length >= 1 && packageIncidents.length >= 1) {
        candidates.push({
            correlationKey: `pipeline_degradation:${teamId}`,
            correlationType: "PIPELINE_DEGRADATION",
            severity: maxSeverity([...reportIncidents, ...packageIncidents]),
            rootOperationalCause: "Report and verification package pipelines are both degraded.",
            operationalSummary: `${reportIncidents.length} report + ${packageIncidents.length} package incidents active in the last ${CORRELATION_WINDOW_HOURS}h.`,
            recommendedAction: "Investigate the upstream generator (worker queue or storage backend); the two pipelines share infrastructure.",
            linkedIncidents: [...reportIncidents, ...packageIncidents],
            confidence: "high",
        });
    }
    // 2. Retry storm chain: 2+ WORKER incidents in the window.
    if (workerIncidents.length >= 2 &&
        workerIncidents.some((i) => severityRank(i.severity) >= 2)) {
        candidates.push({
            correlationKey: `retry_storm_chain:${teamId}`,
            correlationType: "RETRY_STORM_CHAIN",
            severity: maxSeverity(workerIncidents),
            rootOperationalCause: "Multiple worker incidents firing concurrently — likely cascading retries.",
            operationalSummary: `${workerIncidents.length} worker incidents active in the last ${CORRELATION_WINDOW_HOURS}h.`,
            recommendedAction: "Open the retry-storm runbook; consider pausing the noisiest queue to break the cascade.",
            linkedIncidents: workerIncidents,
            confidence: "medium",
        });
    }
    // 3. Infrastructure pressure: 2+ incidents across STORAGE/DATABASE.
    const infra = [...storageIncidents, ...databaseIncidents];
    if (infra.length >= 2) {
        candidates.push({
            correlationKey: `infrastructure_pressure:${teamId}`,
            correlationType: "INFRASTRUCTURE_PRESSURE",
            severity: maxSeverity(infra),
            rootOperationalCause: "Storage and/or database subsystem under pressure.",
            operationalSummary: `${storageIncidents.length} storage + ${databaseIncidents.length} database incidents active in the last ${CORRELATION_WINDOW_HOURS}h.`,
            recommendedAction: "Check storage backend capacity + DB connection pool saturation. Other pipelines depend on these.",
            linkedIncidents: infra,
            confidence: "high",
        });
    }
    // 4. Governance escalation: 2+ GOVERNANCE incidents.
    if (governanceIncidents.length >= 2) {
        candidates.push({
            correlationKey: `governance_escalation:${teamId}`,
            correlationType: "GOVERNANCE_ESCALATION",
            severity: maxSeverity(governanceIncidents),
            rootOperationalCause: "Multiple governance incidents firing concurrently — policy or hold conflicts may be blocking exports.",
            operationalSummary: `${governanceIncidents.length} governance incidents active in the last ${CORRELATION_WINDOW_HOURS}h.`,
            recommendedAction: "Open the governance dashboard; check active legal holds + retention policy versions.",
            linkedIncidents: governanceIncidents,
            confidence: "medium",
        });
    }
    // 5. Audit readiness gap: governance + package backlog co-occurring.
    if (governanceIncidents.length >= 1 && packageIncidents.length >= 1) {
        candidates.push({
            correlationKey: `audit_readiness_gap:${teamId}`,
            correlationType: "AUDIT_READINESS_GAP",
            severity: maxSeverity([...governanceIncidents, ...packageIncidents]),
            rootOperationalCause: "Audit readiness degraded — governance incidents are blocking package generation.",
            operationalSummary: `${governanceIncidents.length} governance + ${packageIncidents.length} package incidents active in the last ${CORRELATION_WINDOW_HOURS}h.`,
            recommendedAction: "Resolve the governance incident first; the package backlog will clear automatically once the blocker is removed.",
            linkedIncidents: [...governanceIncidents, ...packageIncidents],
            confidence: "medium",
        });
    }
    // 6. Queue saturation chain: 2+ INTEGRATION incidents.
    if (integrationIncidents.length >= 2) {
        candidates.push({
            correlationKey: `queue_saturation_chain:${teamId}`,
            correlationType: "QUEUE_SATURATION_CHAIN",
            severity: maxSeverity(integrationIncidents),
            rootOperationalCause: "Multiple integration incidents firing concurrently — upstream connector congestion is propagating.",
            operationalSummary: `${integrationIncidents.length} integration incidents active in the last ${CORRELATION_WINDOW_HOURS}h.`,
            recommendedAction: "Check the integration health page; consider throttling the noisiest connector temporarily.",
            linkedIncidents: integrationIncidents,
            confidence: "medium",
        });
    }
    return candidates;
}
function severityRank(s) {
    switch (s) {
        case "CRITICAL":
            return 3;
        case "HIGH":
            return 2;
        case "WARNING":
            return 1;
        default:
            return 0;
    }
}
function maxSeverity(rows) {
    let max = "INFO";
    let maxRank = 0;
    for (const r of rows) {
        const rank = severityRank(r.severity);
        if (rank > maxRank) {
            maxRank = rank;
            max = r.severity;
        }
    }
    return max;
}
async function persistCorrelation(teamId, candidate) {
    const linkedIncidentIds = candidate.linkedIncidents.map((i) => i.id).slice(0, 50);
    const expiresAtUtc = new Date(Date.now() + CORRELATION_EXPIRY_HOURS * 60 * 60 * 1000);
    await prisma.operationalCorrelation.upsert({
        where: {
            teamId_correlationKey: {
                teamId,
                correlationKey: candidate.correlationKey,
            },
        },
        create: {
            teamId,
            correlationKey: candidate.correlationKey,
            correlationType: candidate.correlationType,
            severity: candidate.severity,
            linkedIncidentIds,
            rootOperationalCause: candidate.rootOperationalCause.slice(0, 400),
            operationalSummary: candidate.operationalSummary.slice(0, 400),
            recommendedAction: candidate.recommendedAction.slice(0, 400),
            confidence: candidate.confidence,
            expiresAtUtc,
        },
        update: {
            severity: candidate.severity,
            linkedIncidentIds,
            operationalSummary: candidate.operationalSummary.slice(0, 400),
            recommendedAction: candidate.recommendedAction.slice(0, 400),
            confidence: candidate.confidence,
            lastDetectedAtUtc: new Date(),
            expiresAtUtc,
        },
    });
}
/**
 * Dashboard reader: bounded, fresh-only correlations for the workspace.
 */
export async function listWorkspaceCorrelations(input) {
    const limit = Math.min(Math.max(input.limit ?? 12, 1), 50);
    try {
        const now = new Date();
        const rows = await prisma.operationalCorrelation.findMany({
            where: {
                teamId: input.teamId,
                expiresAtUtc: { gt: now },
            },
            orderBy: [
                { severity: "desc" },
                { lastDetectedAtUtc: "desc" },
            ],
            take: limit,
        });
        return rows.map((r) => ({
            id: r.id,
            correlationType: r.correlationType,
            severity: r.severity,
            rootOperationalCause: r.rootOperationalCause,
            operationalSummary: r.operationalSummary,
            recommendedAction: r.recommendedAction,
            confidence: r.confidence,
            linkedIncidentIds: Array.isArray(r.linkedIncidentIds)
                ? r.linkedIncidentIds.slice(0, 50)
                : [],
            firstDetectedAtUtc: r.firstDetectedAtUtc.toISOString(),
            lastDetectedAtUtc: r.lastDetectedAtUtc.toISOString(),
        }));
    }
    catch {
        return [];
    }
}
