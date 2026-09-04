/**
 * THE WORKER LEASE — current state, written in place.
 *
 * =============================================================================
 * WHAT THIS REPLACES
 * =============================================================================
 * Liveness used to be read by scanning the append-only heartbeat table: take
 * the newest 200 rows, deduplicate by worker id in memory, and hope the fleet
 * fits. That has three problems, and only the first is about size.
 *
 *   1. The table grew forever. One row per worker per interval, nothing ever
 *      removed. At 60s that is 1,440 rows per worker per day.
 *
 *   2. `take: 200` is a correctness bound, not a performance one. A fleet
 *      large enough — or a worker chatty enough — pushes another instance's
 *      newest row past the window, and that instance silently disappears from
 *      the fleet view while running perfectly.
 *
 *   3. It could not express a clean shutdown AT ALL. A drained worker and a
 *      killed worker both look like "a last heartbeat, then silence", so a
 *      deliberate scale-down read as a crash for the whole stale window.
 *
 * One row per instance, updated in place, fixes all three: the table is the
 * size of the fleet, every instance is always present, and a clean shutdown
 * leaves a marker that a crash cannot forge.
 *
 * =============================================================================
 * WHY THE STOP MARKER IS THE LOAD-BEARING PART
 * =============================================================================
 * STALE is derived, never stored: a lease is stale when it is LIVE, its last
 * heartbeat is older than the threshold, and NO shutdown marker exists. The
 * marker is what separates "this worker went away on purpose" from "this
 * worker stopped answering". A crash cannot produce one, which is exactly the
 * property that makes its absence meaningful.
 */

import { prisma } from "./db.js";
import { logger } from "./logger.js";
import { resolveBuildRevision } from "./build-revision.js";

export type WorkerLeaseIdentity = {
  workerId: string;
  workerKind: "WORKER";
  queueSubscriptions: string[];
  heartbeatIntervalSeconds: number;
};

/**
 * Register this instance before it has proved anything.
 *
 * STARTING, deliberately: the reader must not count an instance as live
 * because a process began, only because a heartbeat landed. A worker that
 * boots and immediately fails its first cycle has never been live, and this
 * row says so rather than claiming a fleet member.
 */
export async function registerWorkerLease(
  id: WorkerLeaseIdentity,
): Promise<void> {
  const now = new Date();
  const data = {
    workerKind: id.workerKind,
    state: "STARTING" as const,
    lastSeenAtUtc: now,
    // A restarted instance re-uses its id. Clearing the previous shutdown
    // marker is what stops a fresh process inheriting the last one's grave.
    stoppedAtUtc: null,
    shutdownReason: null,
    buildRevision: resolveBuildRevision(),
    queueSubscriptions: id.queueSubscriptions,
    heartbeatIntervalSeconds: id.heartbeatIntervalSeconds,
  };
  await prisma.workerLease.upsert({
    where: { workerId: id.workerId },
    create: { workerId: id.workerId, startedAtUtc: now, ...data },
    update: { startedAtUtc: now, ...data },
  });
}

/**
 * A heartbeat landed: this instance is LIVE as of now.
 *
 * `upsert` rather than `update` so a lease deleted underneath a running
 * worker — by a careless operator, or a retention sweep that should never
 * touch this table — heals on the next cycle instead of throwing every 60s.
 */
export async function touchWorkerLease(
  id: WorkerLeaseIdentity,
  counts: { processedCount: number; failedCount: number },
): Promise<void> {
  const now = new Date();
  const data = {
    workerKind: id.workerKind,
    state: "LIVE" as const,
    lastSeenAtUtc: now,
    stoppedAtUtc: null,
    shutdownReason: null,
    buildRevision: resolveBuildRevision(),
    queueSubscriptions: id.queueSubscriptions,
    heartbeatIntervalSeconds: id.heartbeatIntervalSeconds,
    processedCount: counts.processedCount,
    failedCount: counts.failedCount,
  };
  await prisma.workerLease.upsert({
    where: { workerId: id.workerId },
    create: { workerId: id.workerId, startedAtUtc: now, ...data },
    update: data,
  });
}

/**
 * Shutdown began. Not live from this instant — no waiting out the threshold.
 *
 * `lastSeenAtUtc` is NOT advanced here. It is the last time this worker
 * actually did its job, and a shutdown is not a heartbeat; moving it would
 * make a draining worker look freshly healthy.
 */
export async function markWorkerDraining(
  workerId: string,
  reason: string,
): Promise<void> {
  await prisma.workerLease.updateMany({
    where: { workerId },
    data: { state: "DRAINING", shutdownReason: reason.slice(0, 80) },
  });
}

/**
 * Clean shutdown completed. This is the marker whose ABSENCE means a crash.
 *
 * Returns whether it was persisted. The caller must not report a clean stop
 * it could not record: if the store is unreachable here, the truthful outcome
 * is the crash reading — last heartbeat preserved, no marker, STALE once the
 * threshold passes — because from the reader's side that is exactly what
 * happened. Claiming a graceful stop we failed to write would be the one
 * fabrication this whole design exists to prevent.
 */
export async function markWorkerStopped(
  workerId: string,
  reason: string,
): Promise<boolean> {
  try {
    await prisma.workerLease.updateMany({
      where: { workerId },
      data: {
        state: "STOPPED",
        stoppedAtUtc: new Date(),
        shutdownReason: reason.slice(0, 80),
      },
    });
    return true;
  } catch (err) {
    logger.warn(
      { err, workerId },
      "worker.lease.shutdown_marker_failed — this instance will read as a crash, which is the truthful outcome",
    );
    return false;
  }
}
