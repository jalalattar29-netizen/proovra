/**
 * Phase 32.8C+++++ — WorkerTelemetrySnapshot writer + reader.
 *
 * Persists durable worker heartbeat/status samples. Writers may live
 * either in the worker package (real heartbeat) or in the API (synthetic
 * "we just ran a reconcile" stamps). The dashboard reads the latest
 * snapshot per workerKind.
 *
 * Hard rules:
 *   - ADVISORY operational data. Writer failures NEVER block evidence /
 *     report / package / verify core flows.
 *   - Bounded lastErrorMessage (≤ 400 chars). No raw stack traces.
 *   - No raw payloads, signed URLs, or storage keys.
 *   - Reader returns latest row per workerKind (bounded fan-out).
 */
import { prisma } from "../../db.js";
/**
 * Persist a worker heartbeat snapshot. Never throws. Failures swallowed
 * so a telemetry hiccup never blocks the worker itself.
 */
export async function recordWorkerTelemetrySnapshot(sample) {
    try {
        await prisma.workerTelemetrySnapshot.create({
            data: {
                workerId: sample.workerId.slice(0, 120),
                workerKind: sample.workerKind,
                status: sample.status,
                lastSuccessfulRunAtUtc: sample.lastSuccessfulRunAtUtc ?? null,
                lastFailedRunAtUtc: sample.lastFailedRunAtUtc ?? null,
                lastErrorCode: sample.lastErrorCode
                    ? sample.lastErrorCode.slice(0, 80)
                    : null,
                lastErrorMessage: sample.lastErrorMessage
                    ? sample.lastErrorMessage.slice(0, 400)
                    : null,
                processedCount: sample.processedCount ?? null,
                failedCount: sample.failedCount ?? null,
                durationMs: sample.durationMs ?? null,
            },
        });
    }
    catch {
        /* Advisory write — never throws. */
    }
}
/**
 * Dashboard reader: returns one row per workerKind (latest heartbeat).
 * Bounded result, no raw payloads.
 */
export async function listLatestWorkerTelemetry(input) {
    const minutes = Math.min(Math.max(input.withinMinutes ?? 1440, 1), 10080);
    const since = new Date(Date.now() - minutes * 60 * 1000);
    const rows = await prisma.workerTelemetrySnapshot.findMany({
        where: { heartbeatAtUtc: { gte: since } },
        orderBy: { heartbeatAtUtc: "desc" },
        take: 200,
        select: {
            workerId: true,
            workerKind: true,
            status: true,
            heartbeatAtUtc: true,
            lastSuccessfulRunAtUtc: true,
            lastFailedRunAtUtc: true,
            lastErrorCode: true,
            lastErrorMessage: true,
            processedCount: true,
            failedCount: true,
            durationMs: true,
        },
    });
    // Keep first occurrence per workerKind (most recent first).
    const seen = new Set();
    const now = Date.now();
    const out = [];
    for (const r of rows) {
        if (seen.has(r.workerKind))
            continue;
        seen.add(r.workerKind);
        out.push(mapWorkerRow(r, now));
    }
    return out;
}
function mapWorkerRow(r, now) {
    return {
        workerId: r.workerId,
        workerKind: r.workerKind,
        status: r.status,
        heartbeatAtUtc: r.heartbeatAtUtc.toISOString(),
        lastSuccessfulRunAtUtc: r.lastSuccessfulRunAtUtc?.toISOString() ?? null,
        lastFailedRunAtUtc: r.lastFailedRunAtUtc?.toISOString() ?? null,
        lastErrorCode: r.lastErrorCode,
        lastErrorMessage: r.lastErrorMessage,
        processedCount: r.processedCount,
        failedCount: r.failedCount,
        durationMs: r.durationMs,
        ageSeconds: Math.max(0, Math.floor((now - r.heartbeatAtUtc.getTime()) / 1000)),
    };
}
