/**
 * Phase 32.8C+++++++ — Telemetry health evaluator.
 *
 * Reads the freshest WorkerTelemetrySnapshot + QueueTelemetrySnapshot
 * rows and returns a deterministic OpsHealthState — distinguishing
 * "worker silent for 12 min" (STALE) from "worker process dead"
 * (UNAVAILABLE) from "no rows ever written" (DISCONNECTED).
 *
 * Hard rules:
 *   - Never throws. A read failure returns `UNAVAILABLE` with
 *     `recoverable: true`, NOT a thrown exception.
 *   - Bounded reads.
 *   - The canonical source check (worker process via heartbeat row)
 *     is what lets us tell STALE apart from FAILED.
 */
import { prisma } from "../../db.js";
import { severityForStatus } from "./types.js";
const WORKER_FRESH_SECONDS = 120;
const WORKER_STALE_SECONDS = 600; // 10m
const QUEUE_FRESH_SECONDS = 240;
const QUEUE_STALE_SECONDS = 900; // 15m
export async function evaluateTelemetryHealth(input) {
    let workerHb = null;
    let queueSample = null;
    let workerReadOk = true;
    let queueReadOk = true;
    try {
        workerHb = await prisma.workerTelemetrySnapshot.findFirst({
            where: { workerKind: "WORKER" },
            orderBy: { heartbeatAtUtc: "desc" },
            select: { heartbeatAtUtc: true, status: true },
        });
    }
    catch {
        workerReadOk = false;
    }
    try {
        queueSample = await prisma.queueTelemetrySnapshot.findFirst({
            where: { teamId: input.teamId },
            orderBy: { sampledAtUtc: "desc" },
            select: { sampledAtUtc: true },
        });
    }
    catch {
        queueReadOk = false;
    }
    const now = Date.now();
    const workerAgeS = workerHb
        ? Math.floor((now - workerHb.heartbeatAtUtc.getTime()) / 1000)
        : null;
    const queueAgeS = queueSample
        ? Math.floor((now - queueSample.sampledAtUtc.getTime()) / 1000)
        : null;
    // True hard-failure paths first.
    if (!workerReadOk && !queueReadOk) {
        return finalize({
            status: "UNAVAILABLE",
            reason: "Both worker and queue telemetry reads failed on this cycle. The dashboard will reattempt; canonical job processing remains independent of the rollup.",
            recoverable: true,
            lastSuccessfulRunAt: null,
            retrying: true,
            degradedSince: new Date().toISOString(),
            canonicalSourceHealthy: false,
        });
    }
    // No data yet — distinguish from failure.
    if (!workerHb && !queueSample) {
        return finalize({
            status: "DISCONNECTED",
            reason: "No telemetry samples have been recorded yet. The worker sampler writes its first sample on startup; if the worker has not started since the last deploy, this is the expected state.",
            recoverable: true,
            lastSuccessfulRunAt: null,
            retrying: false,
            degradedSince: null,
            canonicalSourceHealthy: true,
        });
    }
    // Worker process is the canonical source. If its heartbeat is way
    // out of tolerance, the worker is the problem.
    if (workerAgeS !== null && workerAgeS > WORKER_STALE_SECONDS * 4) {
        return finalize({
            status: "FAILED",
            reason: `Worker heartbeat last recorded ${formatAge(workerAgeS)} ago — beyond the failure threshold (${Math.floor(WORKER_STALE_SECONDS * 4 / 60)}m). The worker process is likely down.`,
            recoverable: false,
            lastSuccessfulRunAt: workerHb.heartbeatAtUtc.toISOString(),
            retrying: false,
            degradedSince: workerHb.heartbeatAtUtc.toISOString(),
            canonicalSourceHealthy: false,
        });
    }
    if (workerAgeS !== null && workerAgeS > WORKER_STALE_SECONDS) {
        return finalize({
            status: "STALE",
            reason: `Worker heartbeat last recorded ${formatAge(workerAgeS)} ago — past the freshness threshold (${Math.floor(WORKER_STALE_SECONDS / 60)}m) but within the failure window. The worker is likely overloaded; canonical job processing continues.`,
            recoverable: true,
            lastSuccessfulRunAt: workerHb.heartbeatAtUtc.toISOString(),
            retrying: true,
            degradedSince: workerHb.heartbeatAtUtc.toISOString(),
            canonicalSourceHealthy: true,
        });
    }
    // Worker fresh — check queue sampler freshness.
    if (queueAgeS !== null && queueAgeS > QUEUE_STALE_SECONDS) {
        return finalize({
            status: "STALE",
            reason: `Queue telemetry last sampled ${formatAge(queueAgeS)} ago (worker heartbeat fresh). Sampler is delayed; queues themselves remain reachable.`,
            recoverable: true,
            lastSuccessfulRunAt: queueSample.sampledAtUtc.toISOString(),
            retrying: true,
            degradedSince: queueSample.sampledAtUtc.toISOString(),
            canonicalSourceHealthy: true,
        });
    }
    if (queueAgeS !== null && queueAgeS > QUEUE_FRESH_SECONDS) {
        return finalize({
            status: "DEGRADED",
            reason: `Queue telemetry last sampled ${formatAge(queueAgeS)} ago (over the fresh threshold of ${Math.floor(QUEUE_FRESH_SECONDS / 60)}m). Worker remains operational.`,
            recoverable: true,
            lastSuccessfulRunAt: queueSample.sampledAtUtc.toISOString(),
            retrying: true,
            degradedSince: queueSample.sampledAtUtc.toISOString(),
            canonicalSourceHealthy: true,
        });
    }
    // Worker fresh + queue fresh — healthy.
    return finalize({
        status: "HEALTHY",
        reason: `Worker heartbeat ${workerAgeS !== null ? formatAge(workerAgeS) : "—"} old; queue sample ${queueAgeS !== null ? formatAge(queueAgeS) : "—"} old.`,
        recoverable: true,
        lastSuccessfulRunAt: (workerHb?.heartbeatAtUtc ?? queueSample?.sampledAtUtc)?.toISOString() ?? null,
        retrying: false,
        degradedSince: null,
        canonicalSourceHealthy: true,
    });
}
function finalize(input) {
    return {
        ...input,
        severity: severityForStatus(input.status),
    };
}
function formatAge(seconds) {
    if (seconds < 60)
        return `${seconds}s`;
    const m = Math.floor(seconds / 60);
    if (m < 60)
        return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24)
        return `${h}h`;
    return `${Math.floor(h / 24)}d`;
}
