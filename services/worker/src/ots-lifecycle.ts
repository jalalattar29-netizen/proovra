/**
 * THE OTS INITIALIZATION AUTHORITY.
 *
 * ===========================================================================
 * WHAT THIS REPLACES, AND WHY IT HAD TO MOVE
 * ===========================================================================
 * OpenTimestamps was stamped inside `processGenerateReportJob`. There was one
 * call site, and it sat in the middle of a COMMERCIAL pipeline: the report job
 * created the proof at the top, and a few lines later
 * `prepareReportArtifacts` threw `REPORT_NOT_INCLUDED_IN_PLAN` for any record
 * whose plan does not include reports. The stamp was computed and discarded.
 *
 * The consequence was a published promise the product could not keep. Pricing
 * lists OpenTimestamps in "Every plan includes", beside hashing, RFC 3161
 * timestamps, signatures and custody — the integrity layer, the part no tier
 * weakens. A FREE record has no report, therefore had no report job, therefore
 * never obtained an anchor. Not because anyone decided FREE should not have
 * one, but because the only door to OTS was behind a paywall for a different
 * product.
 *
 * OTS is integrity. Report and Verification Package are commercial outputs.
 * They now run on separate lifecycles, and this module owns the first half.
 *
 * ===========================================================================
 * ONE WRITER, AND WHERE THE OTHER HALF LIVES
 * ===========================================================================
 * Initialization (this module) and upgrade (`ots-upgrade.processor.ts`) are
 * two phases of ONE lifecycle, and they share everything that matters:
 *
 *   * one queue — `ots-upgrade`, whose job id is `ots-upgrade-<evidenceId>`,
 *     so the id IS the dedupe and a second request collapses onto the first;
 *   * one state machine — `buildOtsEvidenceUpdateData` in `ots-state.ts`,
 *     which is the only thing that decides what the OTS columns may say;
 *   * one processor entry point, which initializes when there is no proof and
 *     upgrades when there is.
 *
 * This module is deliberately NOT a second processor and NOT a second queue.
 * It is the initialization step the upgrade processor calls when it finds a
 * finalized record that has never been stamped.
 *
 * ===========================================================================
 * THE TRANSACTION BOUNDARY
 * ===========================================================================
 * Stamping contacts an external calendar over the network. That call is made
 * OUTSIDE any database transaction, and evidence finalization does not wait
 * for it: finalize commits, then the job is enqueued, then this runs. A
 * calendar outage leaves a finalized record with no anchor yet — which is the
 * truth, and which the upgrade budget already knows how to keep retrying — and
 * never rolls back a signature.
 *
 * Only the persistence is transactional, and it is guarded: the write is a
 * conditional `updateMany` that matches ONLY a row still holding no proof. Two
 * concurrent initializations therefore produce one stored proof and one
 * custody event, and the loser discards its own stamp rather than overwriting
 * a proof that may already have been upgraded.
 */

import * as prismaPkg from "@prisma/client";
import type { Prisma } from "@prisma/client";

import { appendCustodyEventTx } from "./custody-events.js";
import { prisma } from "./db.js";
import { logger, withJobContext } from "./logger.js";
import { buildOtsEvidenceUpdateData } from "./ots-state.js";
import { createOpenTimestamp, type OtsStampResult } from "./ots.service.js";

/**
 * Why an initialization attempt did or did not produce a new proof.
 *
 * Every one of these is a normal outcome. None is an error: the caller logs
 * the reason and moves on, because a record that cannot be stamped yet is not
 * a record that has failed.
 */
export type OtsInitializationOutcome =
  | {
      initialized: true;
      status: OtsStampResult["status"];
      /**
       * Whether the anchoring ladder still has work to do.
       *
       * Decided HERE, where the whole stamp is in scope, rather than left to
       * the caller. The caller holds only the outcome, so a caller-side
       * decision would have to guess at the txid — and guessing `null`
       * schedules a follow-up for a proof that is already complete, which
       * spends a calendar round trip to learn nothing.
       */
      needsUpgrade: boolean;
    }
  | {
      initialized: false;
      reason:
        | "evidence_not_found"
        | "already_initialized"
        | "not_finalized"
        | "raced";
    };

/**
 * The columns that decide whether initialization is possible and needed.
 *
 * `fingerprintCanonicalJson` is the CONTENT that gets stamped, and it is
 * written by the finalize transaction alongside the signature. Its presence is
 * therefore the honest test for "the digest OTS needs is stable" — stronger
 * than reading `status`, because it is the actual input rather than a label
 * describing it.
 */
const INIT_SELECT = {
  id: true,
  teamId: true,
  status: true,
  fingerprintCanonicalJson: true,
  otsProofBase64: true,
  otsStatus: true,
  otsBitcoinTxid: true,
} as const;

/**
 * Ensure ONE evidence record has entered the OTS lifecycle.
 *
 * Idempotent by the stored proof: a record that already holds one is left
 * exactly as it is, whatever its status. That includes a record whose earlier
 * attempt FAILED — a failed stamp with proof bytes is the upgrade path's
 * problem, and re-stamping it here would replace a proof the calendar may
 * already be tracking with a newer one, resetting its anchoring clock.
 *
 * NOTHING COMMERCIAL REACHES THIS FUNCTION. It takes an evidence id. It reads
 * no plan, no entitlement, no credit ledger and no funding, and there is no
 * parameter through which a caller could supply one. That is the guarantee the
 * whole change exists to make, so it is expressed as an absence in the
 * signature rather than as a rule in a comment.
 */
export async function ensureEvidenceOtsInitialized(params: {
  evidenceId: string;
  /** Correlates the stamp with the job that asked for it. */
  requestId?: string | null;
  jobId?: string | number | null;
  /** What caused this attempt — recorded on the custody event. */
  trigger?: string;
}): Promise<OtsInitializationOutcome> {
  const { evidenceId } = params;
  const ctx = withJobContext({
    jobId: params.jobId ?? null,
    requestId: params.requestId ?? undefined,
    evidenceId,
  });

  const evidence = await prisma.evidence.findFirst({
    where: { id: evidenceId, deletedAt: null },
    select: INIT_SELECT,
  });

  if (!evidence) return { initialized: false, reason: "evidence_not_found" };

  if (evidence.otsProofBase64) {
    return { initialized: false, reason: "already_initialized" };
  }

  if (!evidence.fingerprintCanonicalJson) {
    // Not an error, and not a condition. The record has not reached the state
    // where a stable digest exists, so there is nothing truthful to stamp yet.
    // Finalization enqueues this job itself, so nothing is lost by declining.
    logger.info({ ...ctx, status: "not_finalized" }, "ots.init.skipped");
    return { initialized: false, reason: "not_finalized" };
  }

  // ------------------------------------------------------------------
  // The external call. No transaction is open across it.
  // ------------------------------------------------------------------
  let stamp: OtsStampResult;
  try {
    stamp = await createOpenTimestamp({
      content: Buffer.from(evidence.fingerprintCanonicalJson, "utf8"),
      filenameStem: `fingerprint-${evidenceId}`,
    });
  } catch (error) {
    /*
     * A THROWN STAMP IS A TRANSIENT FAILURE, AND IS LEFT UNRECORDED.
     *
     * `createOpenTimestamp` returns a structured FAILED result for the
     * failures it can describe. A throw is something else — the binary is
     * missing, the host has no network, the call timed out — and writing
     * `otsStatus = FAILED` for it would turn an outage into a per-record
     * integrity condition on every record captured during it, each needing an
     * operator to clear it afterwards.
     *
     * Leaving the columns NULL keeps the record in "never attempted", which is
     * what actually happened, and the job's own retry budget brings it back.
     */
    logger.warn({ ...ctx, err: error }, "ots.init.attempt_failed");
    return { initialized: false, reason: "not_finalized" };
  }

  // ------------------------------------------------------------------
  // Persistence — short, transactional, and conditional on still being unset.
  // ------------------------------------------------------------------
  const applied = await prisma.$transaction(async (tx) => {
    const claimed = await tx.evidence.updateMany({
      // THE RACE GUARD. Only a row that still has no proof is written, so a
      // concurrent initializer — or an upgrade that has already replaced the
      // proof with an anchored one — cannot be overwritten by this older
      // stamp. `updateMany` returns a count rather than throwing, which is
      // what makes the loser's path ordinary rather than exceptional.
      where: { id: evidenceId, otsProofBase64: null, deletedAt: null },
      data: buildOtsEvidenceUpdateData({
        ...stamp,
        existingBitcoinTxid: evidence.otsBitcoinTxid ?? null,
      }) as Prisma.EvidenceUpdateManyMutationInput,
    });

    if (claimed.count === 0) return false;

    await appendCustodyEventTx(tx, {
      evidenceId,
      eventType:
        stamp.status === "FAILED"
          ? prismaPkg.CustodyEventType.OTS_FAILED
          : prismaPkg.CustodyEventType.OTS_APPLIED,
      atUtc: new Date(),
      payload: {
        phase: "ots_initialized",
        trigger: params.trigger ?? "ots_lifecycle",
        otsStatus: stamp.status,
        otsPhase:
          stamp.status === "ANCHORED"
            ? "anchored"
            : stamp.status === "FAILED"
              ? "stamp_failed"
              : "proof_created",
        hash: stamp.hash,
        calendar: stamp.calendar,
        bitcoinTxid: stamp.bitcoinTxid,
        anchoredAtUtc: stamp.anchoredAtUtc,
        upgradedAtUtc: stamp.upgradedAtUtc,
        failureReason: stamp.status === "FAILED" ? stamp.failureReason : null,
      } as Prisma.InputJsonValue,
    });

    return true;
  });

  if (!applied) {
    logger.info({ ...ctx, status: "raced" }, "ots.init.skipped");
    return { initialized: false, reason: "raced" };
  }

  logger.info({ ...ctx, otsStatus: stamp.status }, "ots.init.completed");
  return {
    initialized: true,
    status: stamp.status,
    needsUpgrade: otsInitializationNeedsUpgrade(stamp),
  };
}

/**
 * Does a freshly-initialized proof still need the upgrade ladder?
 *
 * A PENDING proof always does. An ANCHORED one does too when it arrived
 * without a Bitcoin txid, because `resolveEffectiveOtsStatus` degrades exactly
 * that shape back to PENDING for display — so the ladder must keep running
 * until the anchor is one the product is willing to show.
 *
 * FAILED and DISABLED need nothing: one has no proof worth upgrading, the
 * other means the feature is off on this deployment.
 */
export function otsInitializationNeedsUpgrade(
  stamp: Pick<OtsStampResult, "status" | "bitcoinTxid">,
): boolean {
  if (stamp.status === "PENDING") return true;
  return stamp.status === "ANCHORED" && !stamp.bitcoinTxid;
}
