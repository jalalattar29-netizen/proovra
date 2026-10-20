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
import { bump, setGauge } from "@proovra/shared-runtime/ops";
import { getOtsOperationsWarningMs } from "@proovra/shared-runtime";

import { prisma } from "./db.js";
import { logger } from "./logger.js";
import { enqueueOtsUpgradeJob, isOtsUpgradeScheduled } from "./queue.js";
import { resolveOtsBitcoinVerifierConfig } from "./ots-bitcoin-config.js";
import { OTS_CHAIN_FINAL_CONFIRMATIONS, OTS_NOT_IN_ACTIVE_CHAIN_GIVE_UP_MS } from "./ots-state.js";

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
  /** ET-OTS-03 — PENDING proofs examined for a lost upgrade ladder. */
  pendingScanned: number;
  /** ...of which a ladder step was still scheduled (left alone). */
  pendingAlreadyScheduled: number;
  /** ...of which the ladder was gone and an upgrade was re-scheduled. */
  pendingRescheduled: number;
  /** ANCHORED proofs whose chain check was due. */
  chainScanned: number;
  chainRescheduled: number;
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
 *
 * BOUNDED BY A LIMIT, NOT BY A CURSOR, AND DELIBERATELY SO. A cursor would have
 * to persist between ticks, which means a second piece of durable state that
 * can itself be wrong — parked past a row that was inserted behind it, or reset
 * by a redeploy — and it would buy nothing here, because this population is
 * SELF-DRAINING. A record leaves it only by acquiring an OTS status, so a row
 * that is not served this tick is still matched by the next one, and the
 * oldest-first ordering means the longest-waiting records are always the ones
 * a short tick serves. The backlog shrinks by the batch size per tick until it
 * is empty, and then every tick scans nothing.
 *
 * The one thing the limit does not give is fairness DURING a total outage: if
 * the oldest batch cannot be stamped at all, it is re-enqueued every tick and
 * newer records wait behind it. That is the correct behaviour rather than a
 * gap, because an outage that stops the oldest batch stops the newer ones too;
 * there is no ordering in which anybody is served.
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
    pendingScanned: 0,
    pendingAlreadyScheduled: 0,
    pendingRescheduled: 0,
    chainScanned: 0,
    chainRescheduled: 0,
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
      if (outcome.enqueued && !outcome.collapsed) {
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

  // ET-OTS-03 — THE OTHER STRANDED SHAPE: a proof that exists and is PENDING
  // but whose upgrade ladder is gone (a lost job, a redeploy that dropped a
  // delayed job, the pre-fix collapse). Nothing else ever revisits such a row,
  // so it would stay PENDING forever. Re-schedule an upgrade ONLY when no step of
  // the ladder is scheduled — never a second, parallel ladder. The processor's
  // own 30-day budget still decides when pending becomes terminal.
  const pending = await prisma.evidence.findMany({
    where: pendingWithoutProgressWhere({
      notAfter: new Date(now - PENDING_STALE_MS),
      // NO lower age bound: a ladder that died near (or past) the global
      // budget must still be revisited, so the processor's budget can give it
      // its truthful terminal state (FAILED OTS_GLOBAL_BUDGET_EXHAUSTED)
      // instead of leaving it PENDING forever. Oldest first, bounded batch.
      notBefore: new Date(0),
    }),
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: batchSize,
    select: { id: true },
  });
  for (const row of pending) {
    result.pendingScanned += 1;
    try {
      if (await isOtsUpgradeScheduled(row.id)) {
        result.pendingAlreadyScheduled += 1;
        continue;
      }
      const outcome = await enqueueOtsUpgradeJob(row.id, {
        traceId: "ots_pending_recovery",
        delayMs: 0,
      });
      if (outcome.enqueued && !outcome.collapsed) {
        result.pendingRescheduled += 1;
        bump("ots_pending_rescheduled_total");
        logger.warn({ evidenceId: row.id, trigger }, "ots.pending.rescheduled");
      } else if (outcome.enqueued) {
        result.pendingAlreadyScheduled += 1;
      } else {
        result.failed += 1;
      }
    } catch (err) {
      result.failed += 1;
      logger.error({ err, evidenceId: row.id, trigger }, "ots.pending.reschedule_failed");
    }
  }

  // INDEPENDENT BITCOIN-CHAIN VERIFICATION — the same ladder, the same job id.
  // An ANCHORED proof whose chain check is due (never checked, unavailable,
  // pending confirmations, not yet in / reorganized out of the active chain,
  // or a recent VERIFIED still inside its reorg recheck window) and whose job
  // is not scheduled is re-enqueued. A VERIFIED record re-asks the
  // (idempotent) derivative-version decision on that delivery, so a version
  // request lost to a failed in-flight report is recovered here.
  if (resolveOtsBitcoinVerifierConfig().kind !== "disabled") {
    const due = await prisma.evidence.findMany({
      where: chainCheckDueWhere({
        checkedBefore: new Date(now - CHAIN_RECHECK_STALE_MS),
        verifiedAfter: new Date(now - CHAIN_VERIFIED_RECHECK_WINDOW_MS),
        anchoredAfter: new Date(now - OTS_NOT_IN_ACTIVE_CHAIN_GIVE_UP_MS),
      }),
      // 2026-10-20 (AUD-10) — the longest-unchecked record first: a record
      // that waited is served before one checked recently, whatever its anchor
      // date, so a bounded batch cannot starve it behind old anchors.
      orderBy: CHAIN_CHECK_SWEEP_ORDER,
      take: batchSize,
      select: { id: true },
    });
    for (const row of due) {
      result.chainScanned += 1;
      try {
        if (await isOtsUpgradeScheduled(row.id)) continue;
        const outcome = await enqueueOtsUpgradeJob(row.id, { traceId: "ots_chain_check_recovery", delayMs: 0 });
        if (outcome.enqueued && !outcome.collapsed) result.chainRescheduled += 1;
      } catch (err) {
        result.failed += 1;
        logger.error({ err, evidenceId: row.id, trigger }, "ots.chain.reschedule_failed");
      }
    }
  }

  // (2026-10-13) Operations gauges: the PENDING backlog and the part of it
  // older than the Operations aging window (pending beyond SLA).
  try {
    const [backlog, beyondSla] = await Promise.all([
      prisma.evidence.count({ where: { deletedAt: null, otsStatus: "PENDING" } }),
      prisma.evidence.count({
        where: { deletedAt: null, otsStatus: "PENDING", createdAt: { lte: new Date(now - getOtsOperationsWarningMs()) } },
      }),
    ]);
    setGauge("ots_upgrade_backlog", backlog);
    setGauge("ots_pending_beyond_sla", beyondSla);
  } catch (err) {
    logger.warn({ err, trigger }, "ots.gauges.refresh_failed");
  }

  if (result.enqueued > 0 || result.failed > 0 || result.pendingRescheduled > 0) {
    logger.info(
      { ...result, trigger },
      "ots.initialization.reconciler.completed",
    );
  }
  return result;
}

/** A chain check older than any healthy recheck step (1-hour follow-ups plus retry backoff). */
const CHAIN_RECHECK_STALE_MS = 6 * 60 * 60 * 1000;
/** How long after a VERIFIED outcome the sweep still revisits it (the reorg recheck window). */
const CHAIN_VERIFIED_RECHECK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** ANCHORED proofs whose independent chain check is due (the queue check decides whether to enqueue). */
/** The chain sweep's order: least-recently checked first (never-checked first of all), id as the stable tie-break. */
export const CHAIN_CHECK_SWEEP_ORDER: Prisma.EvidenceOrderByWithRelationInput[] = [
  { otsChainCheckedAtUtc: { sort: "asc", nulls: "first" } },
  { id: "asc" },
];

export function chainCheckDueWhere(bounds: { checkedBefore: Date; verifiedAfter: Date; anchoredAfter?: Date }): Prisma.EvidenceWhereInput {
  return {
    deletedAt: null,
    otsStatus: "ANCHORED",
    otsProofBase64: { not: null },
    OR: [
      { otsChainVerificationStatus: null },
      {
        otsChainVerificationStatus: { in: ["NOT_CONFIGURED", "UNAVAILABLE", "INSUFFICIENT_CONFIRMATIONS"] },
        otsChainCheckedAtUtc: { lte: bounds.checkedBefore },
      },
      {
        otsChainVerificationStatus: "FAILED",
        otsChainFailureCode: "REORGED",
        otsChainCheckedAtUtc: { lte: bounds.checkedBefore },
      },
      {
        // 2026-10-20 (AUD-50) — a proof whose block never entered the active
        // chain is rechecked for a bounded time after anchoring, not forever.
        otsChainVerificationStatus: "FAILED",
        otsChainFailureCode: "NOT_IN_ACTIVE_CHAIN",
        otsChainCheckedAtUtc: { lte: bounds.checkedBefore },
        ...(bounds.anchoredAfter ? { otsAnchoredAtUtc: { gte: bounds.anchoredAfter } } : {}),
      },
      {
        // 2026-10-20 (AUD-10) — a VERIFIED outcome deep enough to be final
        // (>= OTS_CHAIN_FINAL_CONFIRMATIONS) is never due again. Production:
        // 163 / 163 verified records matched this branch on every 5-minute
        // tick because the final branch never re-stamps the checked time.
        otsChainVerificationStatus: "VERIFIED",
        otsChainVerifiedAtUtc: { gte: bounds.verifiedAfter },
        otsChainCheckedAtUtc: { lte: bounds.checkedBefore },
        OR: [{ otsChainConfirmations: null }, { otsChainConfirmations: { lt: OTS_CHAIN_FINAL_CONFIRMATIONS } }],
      },
    ],
  };
}

/** A PENDING proof older than any healthy ladder step (60-minute follow-ups plus retry backoff). */
const PENDING_STALE_MS = 6 * 60 * 60 * 1000;

/** ET-OTS-03 — PENDING proofs that may have lost their ladder (the queue check decides). */
export function pendingWithoutProgressWhere(bounds: {
  notAfter: Date;
  notBefore: Date;
}): Prisma.EvidenceWhereInput {
  return {
    deletedAt: null,
    otsStatus: "PENDING",
    otsProofBase64: { not: null },
    createdAt: { gte: bounds.notBefore },
    // "No progress" is measured from the last write to the row, not from
    // creation: an old record whose proof was stamped a minute ago has made
    // progress and its ladder has just been scheduled.
    OR: [
      { otsUpgradedAtUtc: null, updatedAt: { lte: bounds.notAfter } },
      { otsUpgradedAtUtc: { lte: bounds.notAfter } },
    ],
  };
}
