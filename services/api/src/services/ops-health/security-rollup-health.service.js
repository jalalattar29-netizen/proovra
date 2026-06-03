/**
 * Phase 32.8C+++++++ — Security rollup health evaluator.
 *
 * The Access Anomaly classifier (Phase 32.8C++++) is a ROLLUP of the
 * canonical SecurityEvent log. A read failure on the rollup table
 * MUST NOT imply the security engine itself is down — the canonical
 * source is the SecurityEvent log.
 *
 * The evaluator returns:
 *   - HEALTHY    — classifier produced rows recently
 *   - DEGRADED   — classifier read failed but SecurityEvent reads work
 *   - STALE      — classifier rows older than the freshness threshold
 *   - DISCONNECTED — classifier never ran (no rows ever)
 *   - FAILED     — both rollup AND canonical SecurityEvent reads fail
 */
import { prisma } from "../../db.js";
import { severityForStatus } from "./types.js";
const CLASSIFIER_FRESH_HOURS = 24;
const CLASSIFIER_STALE_HOURS = 72;
export async function evaluateSecurityRollupHealth(input) {
    let latestAnomaly = null;
    let canonicalEventCount = 0;
    let rollupOk = true;
    let canonicalOk = true;
    try {
        latestAnomaly = await prisma.accessAnomaly.findFirst({
            where: { teamId: input.teamId },
            orderBy: { createdAt: "desc" },
            select: { createdAt: true },
        });
    }
    catch {
        rollupOk = false;
    }
    // Canonical source check: count recent SecurityEvent rows (last 7d).
    try {
        const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        canonicalEventCount = await prisma.securityEvent.count({
            where: { teamId: input.teamId, createdAt: { gte: since } },
        });
    }
    catch {
        canonicalOk = false;
    }
    // Both reads failed → only then UNAVAILABLE / FAILED.
    if (!rollupOk && !canonicalOk) {
        return finalize({
            status: "FAILED",
            reason: "Both the security anomaly classifier read AND the canonical SecurityEvent log read failed. Detection cannot be confirmed.",
            recoverable: false,
            lastSuccessfulRunAt: null,
            retrying: true,
            degradedSince: new Date().toISOString(),
            canonicalSourceHealthy: false,
        });
    }
    // Rollup failed but canonical fine → DEGRADED (security engine alive).
    if (!rollupOk && canonicalOk) {
        return finalize({
            status: "DEGRADED",
            reason: `Security anomaly classifier rollup read failed on this cycle. Detection remains operational via the canonical SecurityEvent log (${canonicalEventCount} events in the last 7d).`,
            recoverable: true,
            lastSuccessfulRunAt: null,
            retrying: true,
            degradedSince: new Date().toISOString(),
            canonicalSourceHealthy: true,
        });
    }
    // No anomalies ever recorded.
    if (latestAnomaly === null) {
        return finalize({
            status: canonicalEventCount === 0 ? "DISCONNECTED" : "HEALTHY",
            reason: canonicalEventCount === 0
                ? "No SecurityEvent rows have been recorded for this workspace yet. The classifier runs on first SecurityEvent ingestion."
                : `No anomalies classified yet — ${canonicalEventCount} canonical SecurityEvent rows in the last 7d. The classifier surfaces anomalies only when its burst thresholds are crossed.`,
            recoverable: true,
            lastSuccessfulRunAt: null,
            retrying: false,
            degradedSince: null,
            canonicalSourceHealthy: canonicalOk,
        });
    }
    const ageH = (Date.now() - latestAnomaly.createdAt.getTime()) / 3_600_000;
    if (ageH <= CLASSIFIER_FRESH_HOURS) {
        return finalize({
            status: "HEALTHY",
            reason: `Latest anomaly classified ${formatHours(ageH)} ago; canonical SecurityEvent log active (${canonicalEventCount} events / 7d).`,
            recoverable: true,
            lastSuccessfulRunAt: latestAnomaly.createdAt.toISOString(),
            retrying: false,
            degradedSince: null,
            canonicalSourceHealthy: true,
        });
    }
    if (ageH <= CLASSIFIER_STALE_HOURS) {
        return finalize({
            status: "STALE",
            reason: `Latest classified anomaly ${formatHours(ageH)} ago. The classifier runs on every dashboard load; this likely means no new suspicious activity has crossed the burst threshold. Canonical SecurityEvent log remains active.`,
            recoverable: true,
            lastSuccessfulRunAt: latestAnomaly.createdAt.toISOString(),
            retrying: true,
            degradedSince: latestAnomaly.createdAt.toISOString(),
            canonicalSourceHealthy: true,
        });
    }
    return finalize({
        status: "STALE",
        reason: `Latest classified anomaly ${formatHours(ageH)} ago (well past the freshness threshold). Canonical SecurityEvent log remains active; the workspace is likely quiet.`,
        recoverable: true,
        lastSuccessfulRunAt: latestAnomaly.createdAt.toISOString(),
        retrying: true,
        degradedSince: latestAnomaly.createdAt.toISOString(),
        canonicalSourceHealthy: true,
    });
}
function finalize(input) {
    return { ...input, severity: severityForStatus(input.status) };
}
function formatHours(hours) {
    if (hours < 1)
        return `${Math.floor(hours * 60)}m`;
    if (hours < 24)
        return `${hours.toFixed(1)}h`;
    return `${Math.floor(hours / 24)}d`;
}
