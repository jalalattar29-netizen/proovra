/**
 * Phase 32.8C+++++ — Worker-side telemetry sampler.
 *
 * Periodically samples BullMQ queue counts and writes a bounded
 * QueueTelemetrySnapshot row per queue, plus a WorkerTelemetrySnapshot
 * heartbeat. All writes go through `prisma` from db.ts.
 *
 * Hard rules:
 *   - Telemetry write failures NEVER block worker processing — the
 *     sampler swallows errors and reschedules.
 *   - No raw job payloads, signed URLs, or secrets are projected; only
 *     bounded count/age/status data.
 *   - Sampling interval is bounded (default 60s; min 15s; max 600s).
 */

import type { Queue } from "bullmq";
import { prisma } from "./db.js";
import { logger } from "./logger.js";
import {
  derivedAssetsQueue,
  evidencePurgeQueue,
  exifQueue,
  graphDomainSyncQueue,
  graphReconcileQueue,
  graphSearchProjectionQueue,
  graphTimelineSyncQueue,
  mediaIntelligenceQueue,
  miSearchIndexQueue,
  ocrQueue,
  otsUpgradeQueue,
  reportDlqQueue,
  reportQueue,
  searchIndexingQueue,
  transcriptQueue,
} from "./queue.js";

type QueueDomain =
  | "REPORT"
  | "PACKAGE"
  | "REVIEW"
  | "GOVERNANCE"
  | "INTAKE"
  | "WORKER"
  | "OTHER";

type SampledQueue = {
  queue: Queue;
  name: string;
  domain: QueueDomain;
};

function buildSampledQueues(): SampledQueue[] {
  return [
    { queue: reportQueue, name: "report", domain: "REPORT" },
    { queue: reportDlqQueue, name: "report.dlq", domain: "REPORT" },
    { queue: otsUpgradeQueue, name: "ots.upgrade", domain: "WORKER" },
    { queue: evidencePurgeQueue, name: "evidence.purge", domain: "GOVERNANCE" },
    { queue: searchIndexingQueue, name: "search.indexing", domain: "WORKER" },
    { queue: mediaIntelligenceQueue, name: "media.intelligence", domain: "WORKER" },
    { queue: derivedAssetsQueue, name: "derived.assets", domain: "WORKER" },
    { queue: exifQueue, name: "exif", domain: "WORKER" },
    { queue: ocrQueue, name: "ocr", domain: "WORKER" },
    { queue: transcriptQueue, name: "transcript", domain: "WORKER" },
    { queue: miSearchIndexQueue, name: "mi.search.index", domain: "WORKER" },
    { queue: graphReconcileQueue, name: "graph.reconcile", domain: "WORKER" },
    { queue: graphDomainSyncQueue, name: "graph.domain.sync", domain: "WORKER" },
    { queue: graphTimelineSyncQueue, name: "graph.timeline.sync", domain: "WORKER" },
    { queue: graphSearchProjectionQueue, name: "graph.search.projection", domain: "WORKER" },
  ];
}

export type TelemetrySampler = {
  stop: () => void;
};

export function startTelemetrySampler(opts?: {
  intervalMs?: number;
  workerId?: string;
}): TelemetrySampler {
  const interval = Math.min(Math.max(opts?.intervalMs ?? 60_000, 15_000), 600_000);
  const workerId = (opts?.workerId ?? "worker-default").slice(0, 120);
  const queues = buildSampledQueues();

  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  async function sampleOnce(): Promise<void> {
    let processedCount = 0;
    let failedCount = 0;
    const startedAt = Date.now();
    try {
      for (const q of queues) {
        try {
          const counts = await q.queue.getJobCounts(
            "waiting",
            "active",
            "delayed",
            "failed",
            "completed",
          );
          await prisma.queueTelemetrySnapshot.create({
            data: {
              teamId: null,
              queueName: q.name,
              queueDomain: q.domain,
              waitingCount: counts.waiting ?? 0,
              activeCount: counts.active ?? 0,
              delayedCount: counts.delayed ?? 0,
              failedCount: counts.failed ?? 0,
              completedCount: counts.completed ?? null,
              retryCount: 0,
              stalledCount: 0,
              source: "BULLMQ",
            },
          });
          processedCount += 1;
        } catch {
          failedCount += 1;
        }
      }
    } finally {
      const duration = Date.now() - startedAt;
      try {
        await prisma.workerTelemetrySnapshot.create({
          data: {
            workerId,
            workerKind: "WORKER",
            status: failedCount === 0 ? "HEALTHY" : failedCount < queues.length ? "DEGRADED" : "CRITICAL",
            lastSuccessfulRunAtUtc: failedCount === 0 ? new Date() : null,
            lastFailedRunAtUtc: failedCount > 0 ? new Date() : null,
            processedCount,
            failedCount,
            durationMs: duration,
          },
        });
      } catch (err) {
        logger.warn({ err }, "telemetry heartbeat failed");
      }
    }
  }

  function schedule(): void {
    if (stopped) return;
    timer = setTimeout(() => {
      sampleOnce()
        .catch((err) => {
          logger.warn({ err }, "telemetry sampleOnce failed");
        })
        .finally(schedule);
    }, interval);
  }

  // Kick off an immediate sample, then schedule the loop.
  sampleOnce()
    .catch((err) => {
      logger.warn({ err }, "telemetry initial sample failed");
    })
    .finally(schedule);

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
