/**
 * Phase R4 — SIGNED-without-report lifecycle recovery reconciler.
 *
 * Closes the commit-to-enqueue crash window (remediation finding F4).
 *
 * Evidence completion (`services/api/src/services/evidence-complete.service.ts`)
 * commits its transaction — status → SIGNED plus the full custody-event
 * chain — and only THEN enqueues the report job, AFTER the commit
 * (`enqueueGenerateReportJob(...)` outside `$transaction`). If the API
 * process crashes or Redis is unavailable in that gap, the evidence is
 * durably SIGNED but no report job was ever queued. It then hangs at
 * SIGNED forever — the exact "stuck at SIGNED" failure the root
 * `package.json` warns about, and which no other job recovers.
 *
 * This reconciler detects that state deterministically and re-enqueues the
 * report job. Design properties:
 *
 *   - Idempotent: `enqueueReportJob` dedupes by the deterministic report
 *     job id, so overlapping ticks / multiple replicas are safe (no
 *     distributed lock required for correctness).
 *   - Churn-free: plan eligibility is re-derived with the SAME helpers the
 *     report processor uses (`resolveEffectivePlanForEvidence` +
 *     `canPlanGenerateReports`), so evidence whose plan should never have a
 *     report is skipped rather than re-enqueued every tick. (The processor
 *     re-validates plan eligibility again anyway, so this is defence in
 *     depth, not the sole guard.)
 *   - Bounded: an age window (min/max) plus a batch cap. Evidence younger
 *     than `minSignedAgeMs` is left alone so we never race normal in-flight
 *     report generation; evidence older than `maxSignedAgeMs` is left for
 *     manual operator triage rather than retried indefinitely.
 *   - Non-destructive: it only ENQUEUES. It never mutates evidence,
 *     custody, reports, or storage.
 */
import * as prismaPkg from "@prisma/client";
import { resolveEvidenceOutputEntitlements } from "@proovra/shared-billing";

import { prisma } from "./db.js";
import { logger } from "./logger.js";
// PHASE 12 — POINT 5. The recovery calls the report AUTHORITY directly rather
// than the queue: it persists a durable `ReportGenerationRequest` and then
// enqueues that row's id. Importing the authority (which needs only `./db.js`)
// instead of `./processor.js` also keeps this module free of the report
// generator's whole dependency graph.
import { enqueueReportGenerationRequest } from "./queue.js";
import {
  reconcileStrandedReportRequests,
  requestReportGenerationFromWorker,
} from "./report-generation-authority.js";
import {
  resolveEffectivePlanForEvidence,
  resolveEvidenceFundingSource,
} from "./workspace-billing.js";

export interface RunLifecycleRecoveryOptions {
  trigger?: string;
  /**
   * ms — evidence must have been SIGNED at least this long ago before we
   * treat it as "stuck". Avoids racing normal in-flight report generation.
   * Default 15 minutes.
   */
  minSignedAgeMs?: number;
  /**
   * ms — only look back this far. Older stuck rows are left for manual
   * operator triage rather than retried forever. Default 7 days.
   */
  maxSignedAgeMs?: number;
  /** Max evidence rows processed per sweep. Default 200 (hard cap 1000). */
  batchSize?: number;
}

export interface LifecycleRecoveryResult {
  scanned: number;
  reenqueued: number;
  skippedIneligiblePlan: number;
  skippedExistingJob: number;
  failed: number;
  /**
   * RELIABILITY CLOSURE (2026-09-09) — the request-shaped half of the same
   * recovery. See `runLifecycleRecovery` for why it lives here.
   */
  requestsReenqueued: number;
  requestLeasesReleased: number;
  requestsRetired: number;
}

const DEFAULT_MIN_SIGNED_AGE_MS = 15 * 60 * 1000;
const DEFAULT_MAX_SIGNED_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_BATCH_SIZE = 200;
const MAX_BATCH_SIZE = 1000;

export async function runLifecycleRecovery(
  options: RunLifecycleRecoveryOptions = {},
): Promise<LifecycleRecoveryResult> {
  const trigger = options.trigger ?? "manual";
  const minAge = Math.max(0, options.minSignedAgeMs ?? DEFAULT_MIN_SIGNED_AGE_MS);
  const maxAge = Math.max(minAge, options.maxSignedAgeMs ?? DEFAULT_MAX_SIGNED_AGE_MS);
  const batchSize = Math.min(
    Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE),
    MAX_BATCH_SIZE,
  );

  const now = Date.now();
  const upperBound = new Date(now - minAge); // signed at least minAge ago
  const lowerBound = new Date(now - maxAge); // but not older than maxAge

  // Detect: SIGNED, not deleted, within the age window, with NO Report row.
  // `reports: { none: {} }` is the authoritative "no report was ever
  // generated" predicate (a successful report generation writes a Report
  // row AND flips status → REPORTED, so a SIGNED row with no Report row is
  // precisely the stuck-at-SIGNED case).
  const candidates = await prisma.evidence.findMany({
    where: {
      status: prismaPkg.EvidenceStatus.SIGNED,
      deletedAt: null,
      signedAtUtc: { gte: lowerBound, lte: upperBound },
      reports: { none: {} },
    },
    select: { id: true, ownerUserId: true, teamId: true },
    orderBy: { signedAtUtc: "asc" },
    take: batchSize,
  });

  let reenqueued = 0;
  let skippedIneligiblePlan = 0;
  let skippedExistingJob = 0;
  let failed = 0;

  for (const ev of candidates) {
    try {
      const plan = await resolveEffectivePlanForEvidence({
        ownerUserId: ev.ownerUserId,
        teamId: ev.teamId ?? null,
      });
      // BILLING COMMERCIAL CORRECTNESS (2026-08-27) — recovery must not skip a
      // record whose report was PAID FOR with an evidence credit. Asking the
      // plan alone treated every credit-funded record on a FREE account as
      // "ineligible" and quietly abandoned an artifact the customer had bought.
      const outputs = resolveEvidenceOutputEntitlements({
        plan,
        funding: await resolveEvidenceFundingSource(ev.id),
      });
      if (!outputs.reportsIncluded) {
        skippedIneligiblePlan++;
        continue;
      }
      const res = await requestReportGenerationFromWorker({
        evidenceId: ev.id,
        purpose: "lifecycle_recovery",
        machineId: "worker.lifecycle-recovery",
        enqueue: (requestId) => enqueueReportGenerationRequest(requestId),
      });
      if (res.enqueued) {
        reenqueued++;
        logger.warn(
          { evidenceId: ev.id, trigger },
          "lifecycle.recovery.report_reenqueued",
        );
      } else {
        skippedExistingJob++;
      }
    } catch (err) {
      failed++;
      logger.error(
        { err, evidenceId: ev.id, trigger },
        "lifecycle.recovery.evidence.failed",
      );
    }
  }

  /*
   * ===========================================================================
   * THE REQUEST-SHAPED HALF OF THIS SWEEP.
   * ===========================================================================
   * RELIABILITY CLOSURE (2026-09-09). `reconcileStrandedReportRequests` was
   * written, correct, and had NO production caller — its only reference was a
   * test that invoked it directly, which is exactly why nobody noticed. Three
   * guarantees the architecture states in prose therefore did not hold at
   * runtime: expired PROCESSING leases were never released, the attempt ceiling
   * never retired a request to a truthful terminal state, and a stranded
   * REGENERATION was recovered by nothing at all.
   *
   * IT RUNS HERE RATHER THAN IN A SWEEP OF ITS OWN, AND THAT IS THE POINT.
   * This module's stated purpose is closing the commit-to-enqueue window for
   * report generation. It does that by scanning EVIDENCE — records SIGNED with
   * no Report row — which finds a lost FIRST generation and nothing else. The
   * reconciler closes the same window by scanning the REQUEST row, which finds
   * the rest of it. Two sweeps for one responsibility would be two authorities
   * over "does every record owed a report have scheduled work", and they would
   * be free to disagree about it.
   *
   * They cannot collide. Where both would re-enqueue one request they converge
   * instead: the job id is deterministic in the request id, so the second
   * enqueue collapses onto the first.
   *
   * FAIL-ISOLATED. A failure here must not lose the evidence-shaped recovery
   * that has already completed, so it is counted and reported rather than
   * thrown.
   */
  let requestSummary = {
    reenqueued: 0,
    leasesReleased: 0,
    terminalRepaired: 0,
  };
  try {
    const summary = await reconcileStrandedReportRequests({
      enqueue: (requestId) => enqueueReportGenerationRequest(requestId),
    });
    requestSummary = {
      reenqueued: summary.reenqueued,
      leasesReleased: summary.leasesReleased,
      terminalRepaired: summary.terminalRepaired,
    };
  } catch (err) {
    logger.error({ err, trigger }, "lifecycle.recovery.request_sweep_failed");
  }

  const result: LifecycleRecoveryResult = {
    scanned: candidates.length,
    reenqueued,
    skippedIneligiblePlan,
    skippedExistingJob,
    failed,
    requestsReenqueued: requestSummary.reenqueued,
    requestLeasesReleased: requestSummary.leasesReleased,
    requestsRetired: requestSummary.terminalRepaired,
  };
  logger.info({ ...result, trigger }, "lifecycle.recovery.completed");
  return result;
}
