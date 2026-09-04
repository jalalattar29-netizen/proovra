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
  otsUpgradeQueue,
  reportDlqQueue,
  reportQueue,
  searchIndexingQueue,
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

/**
 * THE HEARTBEAT IS THE ONLY EVIDENCE THAT THIS PROCESS EXISTS.
 *
 * Everything the platform says about worker liveness is derived from the rows
 * this function writes, so what goes in them matters:
 *
 *   workerId    identity. Two instances MUST NOT share one, or the fleet
 *               aggregates to a single row and losing one instance becomes
 *               invisible. It comes from WORKER_ID, else the hostname, else a
 *               per-process random suffix — never a bare constant.
 *   metadata    the build this heartbeat came from and the queues this
 *               instance actually subscribes to. Without the build, "the fleet
 *               is live" cannot distinguish a live NEW deployment from a live
 *               OLD one that never got replaced; without the subscriptions, a
 *               worker that is alive but listening to nothing looks identical
 *               to one doing the work.
 *
 * The interval is env-overridable so a lifecycle proof can run in seconds, and
 * bounded (15s–600s) so a mistyped value cannot silently stop the heartbeat or
 * hammer the database.
 */
function resolveWorkerId(explicit?: string): string {
  if (explicit) return explicit.slice(0, 120);
  const fromEnv = process.env.WORKER_ID?.trim();
  if (fromEnv) return fromEnv.slice(0, 120);
  const host = process.env.HOSTNAME?.trim() || "worker";
  // The pid keeps two instances on one host distinct, which is precisely the
  // case where a shared id would hide a dead one.
  return `${host}-${process.pid}`.slice(0, 120);
}

/** Build/revision, for telling a live new deployment from a live old one. */
function resolveBuildRevision(): string | null {
  const rev =
    process.env.GIT_SHA ??
    process.env.GIT_COMMIT ??
    process.env.SOURCE_VERSION ??
    process.env.BUILD_REVISION ??
    null;
  return rev ? rev.trim().slice(0, 64) : null;
}

export function startTelemetrySampler(opts?: {
  intervalMs?: number;
  workerId?: string;
}): TelemetrySampler {
  const envInterval = Number(process.env.WORKER_HEARTBEAT_INTERVAL_MS ?? "");
  const requested =
    opts?.intervalMs ?? (Number.isFinite(envInterval) && envInterval > 0
      ? envInterval
      : 60_000);
  const interval = Math.min(Math.max(requested, 15_000), 600_000);
  const workerId = resolveWorkerId(opts?.workerId);
  const queues = buildSampledQueues();
  const buildRevision = resolveBuildRevision();

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
            // Operator-safe and bounded: a revision string, an interval, and
            // queue NAMES. No payloads, no URLs, no credentials.
            metadataJson: {
              buildRevision,
              heartbeatIntervalMs: interval,
              queueSubscriptions: queues.map((q) => q.name),
              nodeVersion: process.version,
            },
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
