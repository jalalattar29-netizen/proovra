/**
 * ONE AUTOMATIC REPORT VERSION WHEN A PROOF IS INDEPENDENTLY VERIFIED AGAINST
 * THE BITCOIN MAIN CHAIN.
 *
 * A report issued before the record's OpenTimestamps proof was chain-verified
 * says "Pending" or "Bitcoin attestation recorded — Not independently checked
 * against Bitcoin". When the independent chain check VERIFIES the proof,
 * exactly one new report + package version is requested through the existing
 * versioning (`createReportGenerationRequest`): the previous versions stay as
 * issued (byte for byte), nothing is charged (the worker never consumes
 * credits), and the request is idempotent per proof and block.
 *
 * An attestation the proof merely NAMES (ANCHORED, not chain-verified) is not
 * a reason for a new version: it is not a verification, and a version for it
 * would only restate the same unchecked claim.
 *
 *   not chain-verified              nothing
 *   no report yet                   nothing — v1 states the verification itself
 *   latest report stated this same  nothing (no ratchet)
 *     verification (proof + block)
 *   a report is being generated     nothing now — when it commits, the commit
 *                                   re-runs this decision against what it stated;
 *                                   every chain recheck and the reconciler re-run
 *                                   it too, so a failed in-flight report cannot
 *                                   lose it
 *   otherwise                       one request, key
 *                                   `ots-chain-verified:<proof sha head 30>:<block hash tail 30>`
 *                                   (exactly 80 characters: client_request_key is VARCHAR(80))
 */
import { createReportGenerationRequest } from "@proovra/shared-runtime/reports";
import {
  OTS_ANCHORING_RECORD_SELECT,
  isTerminalJobExecutionState,
  parseOtsVerificationKey,
  resolveRecordOtsAnchoring,
  type OtsAnchoring,
} from "@proovra/shared";

import { prisma } from "./db.js";
import { enqueueReportGenerationRequest } from "./queue.js";

export type OtsAnchoredVersionOutcome =
  | "not_chain_verified"
  | "no_report_yet"
  | "latest_report_chain_verified"
  | "report_in_flight"
  | "requested"
  | "already_requested"
  | "refused";

export const OTS_ANCHORED_MACHINE_ID = "worker.ots-chain-verified";

/**
 * The idempotency key: one automatic version per chain-verified proof and block.
 *
 * It must fit report_generation_requests.client_request_key (VARCHAR(80)) WHOLE,
 * or the block component is cut off on write and a reorg to another block for
 * the same proof would be deduplicated away. 19 + 30 + 1 + 30 = 80. The proof
 * sha's HEAD and the block hash's TAIL are taken because a Bitcoin block hash
 * (display order) begins with a long run of zeros; 120 bits of each, within one
 * evidence record, cannot collide in practice.
 */
export const OTS_CHAIN_VERIFIED_KEY_PART = 30;
export function otsChainVerifiedRequestKey(proofSha256: string, blockHash: string): string {
  const proof = proofSha256.trim().toLowerCase().slice(0, OTS_CHAIN_VERIFIED_KEY_PART);
  const block = blockHash.trim().toLowerCase().slice(-OTS_CHAIN_VERIFIED_KEY_PART);
  return `ots-chain-verified:${proof}:${block}`;
}

/** Did this report already state THIS chain verification (same proof, same block)? */
export function reportStatedChainVerification(
  anchorSnapshot: unknown,
  verification: { proofSha256: string; blockHash: string },
): boolean {
  if (!anchorSnapshot || typeof anchorSnapshot !== "object") return false;
  const a = anchorSnapshot as Record<string, unknown>;
  return (
    parseOtsVerificationKey(a.otsVerification) === "CHAIN_VERIFIED" &&
    String(a.otsProofSha256 ?? "").toLowerCase() === verification.proofSha256.toLowerCase() &&
    String(a.otsChainBlockHash ?? "").toLowerCase() === verification.blockHash.toLowerCase()
  );
}

export async function ensureOtsAnchoredReportVersion(input: {
  evidenceId: string;
  anchoring: Pick<OtsAnchoring, "state" | "verification" | "proofSha256" | "chain">;
  /** Dry run: decide, write nothing. */
  dryRun?: boolean;
}): Promise<{ outcome: OtsAnchoredVersionOutcome; requestId?: string; reason?: string }> {
  const { evidenceId, anchoring } = input;
  const blockHash = anchoring.chain?.blockHash ?? null;
  if (anchoring.state !== "ANCHORED" || anchoring.verification !== "CHAIN_VERIFIED" || !anchoring.proofSha256 || !blockHash) {
    return { outcome: "not_chain_verified" };
  }

  const latest = await prisma.report.findFirst({
    where: { evidenceId },
    orderBy: { version: "desc" },
    select: { version: true, anchorSnapshot: true },
  });
  if (!latest) return { outcome: "no_report_yet" };
  if (reportStatedChainVerification(latest.anchorSnapshot, { proofSha256: anchoring.proofSha256, blockHash })) {
    return { outcome: "latest_report_chain_verified" };
  }

  const key = otsChainVerifiedRequestKey(anchoring.proofSha256, blockHash);
  const prior = await prisma.reportGenerationRequest.findFirst({
    where: { evidenceId, clientRequestKey: key },
    select: { id: true },
  });
  if (prior) return { outcome: "already_requested", requestId: prior.id };

  // A report generation already running renders the current (verified) state;
  // its commit re-runs this decision. If it fails terminally, the next chain
  // recheck or the reconciler re-runs it.
  const inFlight = await prisma.reportGenerationRequest.findFirst({
    where: { evidenceId, artifactType: "REPORT", state: { in: ["QUEUED", "PROCESSING", "FAILED_RETRYABLE"] } },
    select: { id: true },
  });
  if (inFlight) return { outcome: "report_in_flight", requestId: inFlight.id };

  if (input.dryRun) return { outcome: "requested" };

  const persisted = await createReportGenerationRequest(prisma, {
    evidenceId,
    purpose: "ots_upgrade_completed",
    artifactType: "REPORT",
    intent: "NEW_VERSION",
    forceRegenerate: true,
    regenerateReason: "ots_chain_verified",
    clientRequestKey: key,
    requestedByMachineId: OTS_ANCHORED_MACHINE_ID,
  });
  if (!persisted.created) return { outcome: "refused", reason: persisted.reason };
  if (persisted.replayed) return { outcome: "already_requested", requestId: persisted.requestId };
  if (!isTerminalJobExecutionState(persisted.state)) {
    await enqueueReportGenerationRequest(persisted.requestId);
  }
  return { outcome: "requested", requestId: persisted.requestId };
}

/**
 * Re-run the decision from the record as stored — after a report commits, and
 * from the reconcile script. Idempotent.
 */
export async function reconcileOtsAnchoredReportVersion(evidenceId: string, opts: { dryRun?: boolean } = {}) {
  const row = await prisma.evidence.findUnique({ where: { id: evidenceId }, select: OTS_ANCHORING_RECORD_SELECT });
  if (!row) return { outcome: "not_chain_verified" as const };
  return ensureOtsAnchoredReportVersion({ evidenceId, anchoring: resolveRecordOtsAnchoring(row), dryRun: opts.dryRun });
}
