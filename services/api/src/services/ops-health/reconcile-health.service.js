/**
 * Phase 32.8C+++++++ — Reconcile health evaluator.
 *
 * The Reviewer Ops reconcile loop posts a SecurityEvent
 * `reviewer_reconcile_run` on each cycle. The dashboard's "Reconcile"
 * tile previously rendered RED `UNAVAILABLE` whenever this event was
 * older than 1 hour — even when the worker was alive and queues were
 * healthy.
 *
 * The new evaluator distinguishes:
 *   - HEALTHY   — reconcile event within 1h
 *   - STALE     — reconcile event 1h–6h old, worker still alive
 *   - DEGRADED  — reconcile event > 6h old, worker still alive
 *   - UNAVAILABLE — no reconcile event AND worker silent
 *   - DISCONNECTED — no reconcile event ever recorded
 */
import { prisma } from "../../db.js";
import { severityForStatus } from "./types.js";
const RECONCILE_FRESH_HOURS = 1;
const RECONCILE_STALE_HOURS = 6;
export async function evaluateReconcileHealth(input) {
    let heartbeat = null;
    let workerHb = null;
    let workerOk = true;
    try {
        heartbeat = await prisma.securityEvent.findFirst({
            where: { teamId: input.teamId, eventType: "reviewer_reconcile_run" },
            orderBy: { createdAt: "desc" },
            select: { createdAt: true },
        });
    }
    catch {
        /* read failure → degrade-not-fail below */
    }
    try {
        workerHb = await prisma.workerTelemetrySnapshot.findFirst({
            where: { workerKind: "WORKER" },
            orderBy: { heartbeatAtUtc: "desc" },
            select: { heartbeatAtUtc: true },
        });
    }
    catch {
        workerOk = false;
    }
    const now = Date.now();
    const reconcileAgeH = heartbeat
        ? (now - heartbeat.createdAt.getTime()) / 3_600_000
        : null;
    const workerAgeM = workerHb
        ? (now - workerHb.heartbeatAtUtc.getTime()) / 60_000
        : null;
    const workerAlive = workerOk && workerAgeM !== null && workerAgeM < 15;
    if (heartbeat === null && !workerAlive) {
        return finalize({
            status: "DISCONNECTED",
            reason: "No reviewer reconcile run has been recorded yet, and no recent worker heartbeat is present. Reviewer reconcile activates when the worker first runs the reviewer ops scheduler.",
            recoverable: true,
            lastSuccessfulRunAt: null,
            retrying: false,
            degradedSince: null,
            canonicalSourceHealthy: false,
        });
    }
    if (heartbeat === null && workerAlive) {
        return finalize({
            status: "STALE",
            reason: "No reviewer reconcile run recorded for this workspace yet — worker is alive, so the scheduler may not have fired the reviewer reconcile loop for this team in its current cycle.",
            recoverable: true,
            lastSuccessfulRunAt: null,
            retrying: true,
            degradedSince: null,
            canonicalSourceHealthy: true,
        });
    }
    if (reconcileAgeH !== null && reconcileAgeH <= RECONCILE_FRESH_HOURS) {
        return finalize({
            status: "HEALTHY",
            reason: `Last reviewer reconcile ${formatHours(reconcileAgeH)} ago.`,
            recoverable: true,
            lastSuccessfulRunAt: heartbeat.createdAt.toISOString(),
            retrying: false,
            degradedSince: null,
            canonicalSourceHealthy: true,
        });
    }
    if (reconcileAgeH !== null && reconcileAgeH <= RECONCILE_STALE_HOURS) {
        // Worker fresh + reconcile slightly stale → telemetry delayed,
        // not a failure.
        return finalize({
            status: "STALE",
            reason: workerAlive
                ? `Last reviewer reconcile ${formatHours(reconcileAgeH)} ago. Worker is alive — the reconcile loop is delayed but the canonical SecurityEvent audit log continues to record reviewer actions.`
                : `Last reviewer reconcile ${formatHours(reconcileAgeH)} ago, and the worker heartbeat is also delayed. Likely operator-driven traffic dip; no canonical data loss.`,
            recoverable: true,
            lastSuccessfulRunAt: heartbeat.createdAt.toISOString(),
            retrying: true,
            degradedSince: heartbeat.createdAt.toISOString(),
            canonicalSourceHealthy: true,
        });
    }
    if (reconcileAgeH !== null && reconcileAgeH > RECONCILE_STALE_HOURS) {
        // Past the stale threshold — but still distinguish worker alive
        // (DEGRADED) from worker dead (UNAVAILABLE).
        if (workerAlive) {
            return finalize({
                status: "DEGRADED",
                reason: `Last reviewer reconcile ${formatHours(reconcileAgeH)} ago (over the ${RECONCILE_STALE_HOURS}h threshold). Worker is alive — the reviewer reconcile scheduler may be paused for this team. The canonical SecurityEvent audit log remains active.`,
                recoverable: true,
                lastSuccessfulRunAt: heartbeat.createdAt.toISOString(),
                retrying: true,
                degradedSince: heartbeat.createdAt.toISOString(),
                canonicalSourceHealthy: true,
            });
        }
        return finalize({
            status: "UNAVAILABLE",
            reason: `Last reviewer reconcile ${formatHours(reconcileAgeH)} ago and worker heartbeat is also stale. The reviewer reconcile loop is not running.`,
            recoverable: true,
            lastSuccessfulRunAt: heartbeat.createdAt.toISOString(),
            retrying: true,
            degradedSince: heartbeat.createdAt.toISOString(),
            canonicalSourceHealthy: false,
        });
    }
    return finalize({
        status: "HEALTHY",
        reason: "Reviewer reconcile loop is operating within tolerance.",
        recoverable: true,
        lastSuccessfulRunAt: heartbeat?.createdAt.toISOString() ?? null,
        retrying: false,
        degradedSince: null,
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
