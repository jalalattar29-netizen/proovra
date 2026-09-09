/**
 * PHASE 12 — POINT 5: stranded intelligence-run reconciler.
 *
 * `MediaIntelligenceRun` is the durable authority for the intelligence family.
 * Two states can strand:
 *
 *   * PENDING with no live job — the row was committed and the enqueue failed,
 *     or the job was dropped. The run never starts and nothing reports it.
 *
 *   * RUNNING past its lease — the worker that claimed it died. BullMQ will
 *     eventually retry the JOB, but the row stays RUNNING forever, so the
 *     claim can never be won again and the retry no-ops on arrival. That is the
 *     worse of the two: the queue looks healthy and the run is permanently
 *     wedged.
 *
 * This reconciler returns expired-lease rows to PENDING and re-enqueues
 * genuinely stranded work, both under bounded batches.
 *
 * What it deliberately does NOT do:
 *
 *   * It never marks a run SUCCEEDED or FAILED. Terminal state belongs to the
 *     processor; a reconciler that can write success can fabricate it.
 *   * It never re-runs a run that reached a terminal state. Re-running a
 *     completed AI extraction spends money and can produce a second set of
 *     observations for the same evidence.
 *   * It never widens scope. Candidates come from the run rows themselves, so
 *     the workspace is always database-derived.
 */

import {
  MEDIA_INTELLIGENCE_RUN_CLAIMED_STATUS as CLAIMED_STATUS,
  MEDIA_INTELLIGENCE_RUN_LEASE_MS,
} from "@proovra/shared-runtime";

import { logger } from "./logger.js";
import { prisma } from "./db.js";

/**
 * Lease beyond which a claimed row is assumed abandoned.
 *
 * PHASE 12 POINT 5 — this file used to select `status: "RUNNING"`, a value
 * NOTHING in the system writes: every claim goes through `markRunProcessing`,
 * which writes `PROCESSING`. So the expired-lease branch below could never
 * match a row, and a worker that died mid-run left its run claimed forever —
 * exactly the "permanently wedged" case the comment above calls the worse of
 * the two. The health snapshot had the same bug and therefore always reported
 * zero in-flight runs.
 *
 * Both the status and the lease duration are now imported from the tracker
 * that enforces them, so the claim and its recovery cannot drift apart again.
 */
const RUNNING_LEASE_MS = MEDIA_INTELLIGENCE_RUN_LEASE_MS;
/** How long a PENDING row may sit before it is considered stranded. */
const PENDING_STRANDED_MS = 15 * 60 * 1000;
/** A chunk written this recently may still have its original job in flight. */
const EMBED_OWED_MIN_AGE_MS = 30 * 60 * 1000;
/** Older than this and whatever produced it is long gone; not this sweep’s. */
const EMBED_OWED_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_BATCH = 50;

/**
 * Attempts beyond which a run is left alone for an operator.
 *
 * A run that has already been recovered this many times is not suffering from a
 * lost worker — something about the run itself is failing — and repeatedly
 * re-enqueuing it burns provider budget to reach the same outcome.
 */
const MAX_RECOVERY_ATTEMPTS = 5;

export type IntelligenceRunReconcileOptions = {
  trigger?: string;
  batchSize?: number;
};

export type IntelligenceRunReconcileResult = {
  ok: boolean;
  expiredLeasesReleased: number;
  strandedReEnqueued: number;
  abandonedForOperator: number;
  failed: number;
  /**
   * Chunks found still owing an embedding, and how many were re-enqueued.
   *
   * ---------------------------------------------------------------------------
   * GOVERNANCE CLOSURE (2026-09-09) — THE REGISTRY NAMED THIS MODULE AND THIS
   * MODULE COULD NOT SEE THE WORK.
   * ---------------------------------------------------------------------------
   * `EMBED_SEMANTIC_CHUNKS` declares `reconciler: intelligence-run-reconciler.ts`,
   * and until now that was false in the way that matters: every scan in this file
   * keys on `MediaIntelligenceRun`, and the embed producer writes no run row. It
   * enqueues with `commandId: anchorChunkId` against chunk rows that already
   * exist. So a lost embed enqueue left chunks unembedded forever, and the one
   * module the registry pointed an operator at could not have found them.
   *
   * The durable fact was already in the schema and needed no new column:
   * `EvidenceSemanticChunk.embedding` is nullable, so `embedding IS NULL` IS
   * "this chunk is owed an embedding". Scanning it makes the existing
   * declaration true rather than re-pointing the registry at something else,
   * and it creates no second embedding authority — recovery re-enqueues through
   * `enqueueMiEmbedJob`, the same canonical producer the live path uses.
   */
  embedChunksOwed: number;
  embedChunksReEnqueued: number;
  durationMs: number;
  error?: string;
};

export async function runIntelligenceRunReconciler(
  options: IntelligenceRunReconcileOptions = {},
): Promise<IntelligenceRunReconcileResult> {
  const startedAt = Date.now();
  const batchSize = Math.max(1, Math.min(options.batchSize ?? DEFAULT_BATCH, 500));
  const result: IntelligenceRunReconcileResult = {
    ok: true,
    expiredLeasesReleased: 0,
    strandedReEnqueued: 0,
    abandonedForOperator: 0,
    failed: 0,
    embedChunksOwed: 0,
    embedChunksReEnqueued: 0,
    durationMs: 0,
  };

  try {
    // ---- 1. Release expired RUNNING leases ------------------------------
    //
    // The update is CONDITIONAL on the row still being RUNNING with the same
    // stale claim, so two overlapping reconciler ticks cannot both "recover"
    // the same row, and a worker that comes back to life mid-sweep and writes a
    // terminal state wins — its write moves the row out of RUNNING, and this
    // update then matches zero rows.
    const leaseCutoff = new Date(Date.now() - RUNNING_LEASE_MS);
    const expired = await prisma.mediaIntelligenceRun.findMany({
      where: {
        status: CLAIMED_STATUS,
        startedAtUtc: { lt: leaseCutoff },
      },
      select: { id: true, attemptCount: true },
      orderBy: { startedAtUtc: "asc" },
      take: batchSize,
    });

    for (const run of expired) {
      if (run.attemptCount >= MAX_RECOVERY_ATTEMPTS) {
        const abandoned = await prisma.mediaIntelligenceRun.updateMany({
          where: { id: run.id, status: CLAIMED_STATUS, startedAtUtc: { lt: leaseCutoff } },
          data: {
            status: "FAILED",
            lastError: "recovery_attempts_exhausted",
            completedAtUtc: new Date(),
            updatedAtUtc: new Date(),
          },
        });
        if (abandoned.count === 1) result.abandonedForOperator += 1;
        continue;
      }
      const released = await prisma.mediaIntelligenceRun.updateMany({
        where: { id: run.id, status: CLAIMED_STATUS, startedAtUtc: { lt: leaseCutoff } },
        data: {
          status: "PENDING",
          startedAtUtc: null,
          lastError: "lease_expired_recovered",
          updatedAtUtc: new Date(),
        },
      });
      if (released.count === 1) result.expiredLeasesReleased += 1;
    }

    // ---- 2. Re-enqueue stranded PENDING runs -----------------------------
    const pendingCutoff = new Date(Date.now() - PENDING_STRANDED_MS);
    const stranded = await prisma.mediaIntelligenceRun.findMany({
      where: {
        status: "PENDING",
        updatedAtUtc: { lt: pendingCutoff },
      },
      select: { id: true, kind: true, evidenceId: true, attemptCount: true },
      orderBy: { updatedAtUtc: "asc" },
      take: batchSize,
    });

    if (stranded.length > 0) {
      const { enqueueMediaIntelligenceRunById } = await import("./queue.js");
      for (const run of stranded) {
        if (run.attemptCount >= MAX_RECOVERY_ATTEMPTS) {
          result.abandonedForOperator += 1;
          continue;
        }
        try {
          const outcome = await enqueueMediaIntelligenceRunById(run.id);
          if (outcome.enqueued) result.strandedReEnqueued += 1;
          else result.failed += 1;
        } catch {
          result.failed += 1;
        }
      }
    }

    // ---- 3. Chunks still owing an embedding ------------------------------
    //
    // The population is `embedding IS NULL` on a chunk old enough that the
    // original handoff cannot still be in flight. Both bounds matter: the floor
    // keeps a chunk written seconds ago out of the scan, and the ceiling keeps
    // the sweep off rows so old that whatever produced them is long gone.
    //
    // SELF-DRAINING, so a limit is the right bound rather than a cursor: a
    // chunk leaves this population by acquiring an embedding, so a row not
    // served this tick is matched by the next one, and oldest-first means the
    // longest-waiting chunks are the ones a short tick serves.
    //
    // Re-enqueue is IDEMPOTENT by the canonical job id, so a chunk whose job is
    // still queued collapses onto it rather than being scheduled twice.
    const embedFloor = new Date(Date.now() - EMBED_OWED_MIN_AGE_MS);
    const embedCeiling = new Date(Date.now() - EMBED_OWED_MAX_AGE_MS);
    const owed = await prisma.evidenceSemanticChunk.findMany({
      where: {
        embedding: null,
        createdAt: { lte: embedFloor, gte: embedCeiling },
      },
      select: { id: true },
      orderBy: { createdAt: "asc" },
      take: batchSize,
    });
    result.embedChunksOwed = owed.length;

    if (owed.length > 0) {
      const { enqueueMiEmbedJob } = await import("./queue.js");
      for (const chunk of owed) {
        try {
          const outcome = await enqueueMiEmbedJob(chunk.id, { reason: "reconciler" });
          if (outcome.enqueued) result.embedChunksReEnqueued += 1;
        } catch {
          // Fail-isolated: one chunk that cannot be enqueued is counted and
          // stepped over. A reconciler that throws stops reconciling.
          result.failed += 1;
        }
      }
    }

    logger.info(
      {
        reconciler: "intelligence-run",
        trigger: options.trigger ?? "scheduler",
        ...result,
        durationMs: Date.now() - startedAt,
      },
      "worker.intelligence_run.reconciled",
    );
  } catch (err) {
    result.ok = false;
    result.error = err instanceof Error ? err.message.slice(0, 200) : "unknown";
    logger.error(
      {
        reconciler: "intelligence-run",
        trigger: options.trigger ?? "scheduler",
        error: result.error,
      },
      "worker.intelligence_run.reconcile_failed",
    );
  }

  result.durationMs = Date.now() - startedAt;
  return result;
}

/**
 * Bounded operator projection of intelligence-run health.
 *
 * Counts only — no evidence ids, no run content, no provider detail.
 */
export async function getIntelligenceRunHealthSnapshot(): Promise<{
  pendingCount: number;
  runningCount: number;
  expiredLeaseCount: number;
  failedCount: number;
  oldestPendingAgeMs: number | null;
}> {
  const leaseCutoff = new Date(Date.now() - RUNNING_LEASE_MS);
  const [pendingCount, runningCount, expiredLeaseCount, failedCount, oldest] =
    await Promise.all([
      prisma.mediaIntelligenceRun.count({ where: { status: "PENDING" } }),
      prisma.mediaIntelligenceRun.count({ where: { status: CLAIMED_STATUS } }),
      prisma.mediaIntelligenceRun.count({
        where: { status: CLAIMED_STATUS, startedAtUtc: { lt: leaseCutoff } },
      }),
      prisma.mediaIntelligenceRun.count({ where: { status: "FAILED" } }),
      prisma.mediaIntelligenceRun.findFirst({
        where: { status: "PENDING" },
        select: { updatedAtUtc: true },
        orderBy: { updatedAtUtc: "asc" },
      }),
    ]);

  return {
    pendingCount,
    runningCount,
    expiredLeaseCount,
    failedCount,
    oldestPendingAgeMs: oldest
      ? Date.now() - oldest.updatedAtUtc.getTime()
      : null,
  };
}
