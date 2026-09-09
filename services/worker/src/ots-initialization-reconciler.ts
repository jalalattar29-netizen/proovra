/**
 * THE OTS INITIALIZATION RECONCILER — the durability net under the finalize
 * handoff.
 *
 * ===========================================================================
 * THE WINDOW THIS CLOSES
 * ===========================================================================
 * Evidence finalization commits its transaction — status SIGNED, signature,
 * TSA columns, the whole custody chain — and only THEN asks for OTS anchoring:
 *
 *     await requestEvidenceOtsAnchoring({ evidenceId, trigger: "evidence.completed" })
 *
 * That authority never throws, by design: refusing a completion because a queue
 * was briefly unreachable would trade a durable signature for a timestamp. It
 * returns `{ requested: false, reason: "queue_unavailable" }` and the completion
 * path discards the value.
 *
 * Which meant that if Redis was down for those few milliseconds, the record was
 * finalized, signed and durable — and nothing anywhere knew it still owed an
 * anchor. No outbox row was written. `otsStatus` stayed NULL, which is
 * indistinguishable from "the job is about to run". The canonical work registry
 * named `lifecycle-recovery.ts` as this queue's reconciler and that module
 * contains no OTS code at all. The only real repair was a human running a CLI
 * whose own header says it has never been run against Production.
 *
 * A second, larger population reaches the same state: a transient failure of the
 * stamping call itself. That now consumes the queue's retry budget
 * (`OtsInitializationTransientError`), but a budget can still be exhausted, and
 * an exhausted job leaves exactly this shape behind.
 *
 * ===========================================================================
 * WHAT THIS IS, AND WHAT IT IS DELIBERATELY NOT
 * ===========================================================================
 * It is a SCAN and an ENQUEUE. Nothing else.
 *
 *   * It writes NO OTS column. `ots-state.ts` remains the only writer, reached
 *     through `ots-lifecycle.ts`, reached through the `ots-upgrade` queue.
 *   * It touches NO TSA column. It cannot: nothing here reads or writes one,
 *     and there is no TSA queue in this product to reach.
 *   * It asks NOTHING commercial. Integrity is not sold, and this module has no
 *     plan, entitlement, funding or credit input — expressed as an absence in
 *     the query rather than as a rule in a comment.
 *   * It is not a second producer. It calls `enqueueOtsUpgradeJob`, the same
 *     canonical worker-side producer the upgrade ladder and the historical
 *     reconciliation script use, whose job id (`ots-upgrade-<evidenceId>`) is
 *     itself the dedupe.
 *
 * It shares its scan predicate with `scripts/reconcile-ots-never-attempted.ts`
 * — the manual, operator-gated, product/legal-reviewed backfill for records
 * that PREDATE the OTS decoupling. The two are deliberately separate: that one
 * anchors history and needs a human to decide it should happen at all; this one
 * repairs a handoff that was supposed to happen seconds ago and needs no
 * decision from anybody.
 *
 * ===========================================================================
 * WHY AN AGE THRESHOLD, AND NOT JUST "IS IT NULL"
 * ===========================================================================
 * NULL is the NORMAL state of a record between its finalize commit and its
 * first stamp. Treating that as broken would open a condition on every record
 * the instant it is captured. The threshold is what separates "the handoff is
 * in flight" from "the handoff did not happen", and it is generous on purpose:
 * the API enqueues immediately, the worker's own follow-ups use a five-minute
 * delay, and the queue can be backed up without anything being wrong.
 */

import type { Prisma } from "@prisma/client";
import { bump } from "@proovra/shared-runtime/ops";

import { prisma } from "./db.js";
import { logger } from "./logger.js";
import { enqueueOtsUpgradeJob } from "./queue.js";

export interface RunOtsInitializationReconcilerOptions {
  trigger?: string;
  /**
   * ms — a finalized record must have been waiting at least this long before it
   * counts as a failed handoff rather than an in-flight one. Default 30 minutes:
   * comfortably past the immediate enqueue, past the five-minute follow-up
   * delay, and past an ordinary queue backlog.
   */
  minAgeMs?: number;
  /**
   * ms — how far back to look. Records older than this are the HISTORICAL
   * population, and anchoring those is a product and legal decision that
   * belongs to the operator-gated script, not to an unattended sweep. Default
   * 30 days, which is also the OTS global anchoring budget.
   */
  maxAgeMs?: number;
  /** Max records enqueued per tick. Default 200, hard cap 1000. */
  batchSize?: number;
}

export interface OtsInitializationReconcilerResult {
  scanned: number;
  enqueued: number;
  /** The queue accepted nothing new because a job for it is already live. */
  collapsed: number;
  failed: number;
}

const DEFAULT_MIN_AGE_MS = 30 * 60 * 1000;
const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_BATCH_SIZE = 200;
const MAX_BATCH_SIZE = 1000;

/**
 * THE POPULATION, as a query.
 *
 * `fingerprintCanonicalJson` is the CONTENT that OTS stamps, and it is written
 * by the finalize transaction alongside the signature. Its presence is the
 * honest test for "the digest OTS needs is stable" — stronger than reading
 * `status`, because it is the actual input rather than a label describing it,
 * and it is the same predicate the initializer itself checks before stamping.
 *
 * The two OTS columns must BOTH be null. A record holding proof bytes has
 * entered the lifecycle whatever its status says, and re-enqueueing it would
 * ask the upgrade ladder to do work it is already doing.
 */
export function neverAttemptedOtsWhere(bounds: {
  notAfter: Date;
  notBefore: Date;
}): Prisma.EvidenceWhereInput {
  return {
    deletedAt: null,
    fingerprintCanonicalJson: { not: null },
    otsStatus: null,
    otsProofBase64: null,
    createdAt: { lte: bounds.notAfter, gte: bounds.notBefore },
  };
}

/**
 * One bounded sweep.
 *
 * IDEMPOTENT AND SAFE UNDER CONCURRENCY without a lock: the job id is
 * deterministic in the evidence id, so two reconcilers running at once collapse
 * onto one queued job rather than scheduling two, and a record that gains a
 * proof between the scan and the enqueue is rejected by the initializer's own
 * `otsProofBase64 IS NULL` guard.
 *
 * FAIL-ISOLATED: one record that cannot be enqueued is counted and stepped
 * over. A reconciler that throws stops reconciling, which is the failure mode
 * that lets a backlog build behind a single bad row.
 */
export async function runOtsInitializationReconciler(
  options: RunOtsInitializationReconcilerOptions = {},
): Promise<OtsInitializationReconcilerResult> {
  const trigger = options.trigger ?? "manual";
  const minAge = Math.max(0, options.minAgeMs ?? DEFAULT_MIN_AGE_MS);
  const maxAge = Math.max(minAge, options.maxAgeMs ?? DEFAULT_MAX_AGE_MS);
  const batchSize = Math.min(
    Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE),
    MAX_BATCH_SIZE,
  );

  const now = Date.now();
  const result: OtsInitializationReconcilerResult = {
    scanned: 0,
    enqueued: 0,
    collapsed: 0,
    failed: 0,
  };

  const candidates = await prisma.evidence.findMany({
    where: neverAttemptedOtsWhere({
      notAfter: new Date(now - minAge),
      notBefore: new Date(now - maxAge),
    }),
    // Oldest first: if a tick is cut short, the records that have waited
    // longest are the ones that got served.
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: batchSize,
    select: { id: true },
  });

  result.scanned = candidates.length;
  if (result.scanned > 0) bump("ots_initialization_scanned_total", result.scanned);

  for (const row of candidates) {
    try {
      const outcome = await enqueueOtsUpgradeJob(row.id, {
        traceId: "ots_initialization_reconciler",
        // No delay. This record has already waited past the threshold; the
        // whole point is that its handoff never happened.
        delayMs: 0,
      });
      if (outcome.enqueued) {
        result.enqueued += 1;
        bump("ots_initialization_reconciled_total");
        logger.warn(
          { evidenceId: row.id, trigger },
          "ots.initialization.reconciled",
        );
      } else {
        // A job for this record is already live. Nothing is wrong; the record
        // is simply already being served.
        result.collapsed += 1;
      }
    } catch (err) {
      result.failed += 1;
      logger.error(
        { err, evidenceId: row.id, trigger },
        "ots.initialization.reconcile_failed",
      );
    }
  }

  if (result.enqueued > 0 || result.failed > 0) {
    logger.info(
      { ...result, trigger },
      "ots.initialization.reconciler.completed",
    );
  }
  return result;
}
