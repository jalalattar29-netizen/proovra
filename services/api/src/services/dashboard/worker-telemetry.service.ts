/**
 * Phase 32.8C+++++ — WorkerTelemetrySnapshot READER.
 *
 * The dashboard reads the latest snapshot per workerKind. Rows are written by
 * the worker's own sampler (`services/worker/src/telemetry.ts`), which is armed
 * at boot by `startTelemetrySampler` and is the ONE writer of this table.
 *
 * PHASE 13 §4 — this module also carried a second writer,
 * `recordWorkerTelemetrySnapshot`, for "synthetic API-side stamps". Nothing in
 * the tree ever called it: it was a parallel authority over the same table with
 * no caller, and it was removed rather than wired, because the sampler already
 * records every field it wrote.
 *
 * Hard rules:
 *   - ADVISORY operational data. Reader failures NEVER block evidence /
 *     report / package / verify core flows.
 *   - Reader returns latest row per workerKind (bounded fan-out).
 */

import { prisma } from "../../db.js";

export type WorkerTelemetryKind =
  | "API"
  | "WORKER"
  | "REPORT"
  | "PACKAGE"
  | "REVIEWER_RECONCILE"
  | "OTS"
  | "TSA"
  | "OTHER";

export type WorkerTelemetryStatus =
  | "HEALTHY"
  | "DEGRADED"
  | "CRITICAL"
  | "UNKNOWN";

/**
 * Dashboard reader: returns one row per workerKind (latest heartbeat).
 * Bounded result, no raw payloads.
 */
export async function listLatestWorkerTelemetry(input: {
  withinMinutes?: number;
}): Promise<
  Array<{
    workerId: string;
    workerKind: WorkerTelemetryKind;
    status: WorkerTelemetryStatus;
    heartbeatAtUtc: string;
    lastSuccessfulRunAtUtc: string | null;
    lastFailedRunAtUtc: string | null;
    lastErrorCode: string | null;
    lastErrorMessage: string | null;
    processedCount: number | null;
    failedCount: number | null;
    durationMs: number | null;
    ageSeconds: number;
  }>
> {
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
  const seen = new Set<string>();
  const now = Date.now();
  const out: ReturnType<typeof mapWorkerRow>[] = [];
  for (const r of rows) {
    if (seen.has(r.workerKind)) continue;
    seen.add(r.workerKind);
    out.push(mapWorkerRow(r, now));
  }
  return out;
}

function mapWorkerRow(
  r: {
    workerId: string;
    workerKind: WorkerTelemetryKind;
    status: WorkerTelemetryStatus;
    heartbeatAtUtc: Date;
    lastSuccessfulRunAtUtc: Date | null;
    lastFailedRunAtUtc: Date | null;
    lastErrorCode: string | null;
    lastErrorMessage: string | null;
    processedCount: number | null;
    failedCount: number | null;
    durationMs: number | null;
  },
  now: number,
) {
  return {
    workerId: r.workerId,
    workerKind: r.workerKind as WorkerTelemetryKind,
    status: r.status as WorkerTelemetryStatus,
    heartbeatAtUtc: r.heartbeatAtUtc.toISOString(),
    lastSuccessfulRunAtUtc: r.lastSuccessfulRunAtUtc?.toISOString() ?? null,
    lastFailedRunAtUtc: r.lastFailedRunAtUtc?.toISOString() ?? null,
    lastErrorCode: r.lastErrorCode,
    lastErrorMessage: r.lastErrorMessage,
    processedCount: r.processedCount,
    failedCount: r.failedCount,
    durationMs: r.durationMs,
    ageSeconds: Math.max(
      0,
      Math.floor((now - r.heartbeatAtUtc.getTime()) / 1000),
    ),
  };
}
