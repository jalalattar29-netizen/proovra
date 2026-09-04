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
import { resolveBuildRevision } from "./build-revision.js";
import {
  markWorkerDraining,
  markWorkerStopped,
  registerWorkerLease,
  touchWorkerLease,
  type WorkerLeaseIdentity,
} from "./worker-lease.js";
import { sweepHeartbeatHistory } from "./heartbeat-retention.js";
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

/**
 * How often the retention sweep is attempted. Retention is an age predicate,
 * so attempting it on every 60s heartbeat would be the same DELETE over and
 * over; hourly drains a backlog quickly enough while costing almost nothing.
 */
const RETENTION_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

export type TelemetrySampler = {
  /** Stop the timer. Leaves no shutdown marker — use for abrupt teardown. */
  stop: () => void;
  /**
   * Graceful shutdown: DRAINING, then STOPPED.
   * Resolves to whether the STOPPED marker was persisted; false means this
   * instance will correctly read as a crash rather than a clean stop.
   */
  shutdown: (reason?: string) => Promise<boolean>;
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

  /** One identity object, so the lease and the history cannot disagree. */
  const identity: WorkerLeaseIdentity = {
    workerId,
    workerKind: "WORKER",
    queueSubscriptions: queues.map((q) => q.name),
    heartbeatIntervalSeconds: Math.round(interval / 1000),
  };

  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  // Sweep far less often than we heartbeat: retention is an age predicate,
  // so running it every minute would be the same delete over and over.
  let lastSweepAt = 0;

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

      /*
       * THE LEASE IS THE LIVENESS AUTHORITY, SO IT IS WRITTEN SEPARATELY.
       *
       * A failed history write must not stop the lease being touched: the
       * history is a nice-to-have and the lease is what decides whether this
       * fleet reads as alive. Its own failure is logged and swallowed for the
       * same reason every other write here is — telemetry never takes a
       * worker down — and the consequence is honest: no touch, so the lease
       * ages, and the reader eventually says STALE. Which is true.
       */
      try {
        await touchWorkerLease(identity, { processedCount, failedCount });
      } catch (err) {
        logger.warn({ err }, "worker.lease.touch_failed");
      }
    }
  }

  /**
   * Retention runs on the heartbeat tick rather than on a timer of its own,
   * so there is one scheduler to reason about and one thing to stop. Only the
   * advisory-lock holder actually sweeps; everyone else returns immediately.
   */
  async function sweepIfDue(): Promise<void> {
    const now = Date.now();
    if (now - lastSweepAt < RETENTION_SWEEP_INTERVAL_MS) return;
    lastSweepAt = now;
    await sweepHeartbeatHistory().catch((err) => {
      logger.warn({ err }, "worker.heartbeat_retention.unexpected");
    });
  }

  function schedule(): void {
    if (stopped) return;
    timer = setTimeout(() => {
      sampleOnce()
        .then(sweepIfDue)
        .catch((err) => {
          logger.warn({ err }, "telemetry sampleOnce failed");
        })
        .finally(schedule);
    }, interval);
  }

  // Register BEFORE the first sample, as STARTING. A reader must never count
  // this instance as live because a process began — only because a heartbeat
  // landed, which `sampleOnce` records by promoting the lease to LIVE.
  const bootstrap = registerWorkerLease(identity).catch((err) => {
    logger.warn({ err }, "worker.lease.register_failed");
  });

  void bootstrap
    .then(() => sampleOnce())
    .catch((err) => {
      logger.warn({ err }, "telemetry initial sample failed");
    })
    .finally(schedule);

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
    /**
     * The graceful path. DRAINING first so a reader stops counting this
     * instance the moment shutdown begins, then STOPPED once it is done.
     *
     * Returns whether the marker was actually persisted, because a caller
     * must not report a clean stop it failed to record.
     */
    shutdown: async (reason = "SIGTERM") => {
      stopped = true;
      if (timer) clearTimeout(timer);
      try {
        await markWorkerDraining(workerId, reason);
      } catch (err) {
        logger.warn({ err }, "worker.lease.draining_failed");
      }
      return markWorkerStopped(workerId, reason);
    },
  };
}
