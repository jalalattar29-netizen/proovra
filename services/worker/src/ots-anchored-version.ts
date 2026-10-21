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
 *                                   (exactly 80 characters: client_request_key is VARCHAR(80));
 *                                   a technical terminal failure of that request is
 *                                   retried under `ots-cv-r<n>:...` up to
 *                                   OTS_OWED_VERSION_MAX_RETRIES times (F-10)
 */
import { createReportGenerationRequest } from "@proovra/shared-runtime/reports";
import { workerOutputEntitlement } from "./output-issuance.js";
import {
  OTS_ANCHORING_RECORD_SELECT,
  classifyTerminalReason,
  isRecoverableBlockedTerminalReason,
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
/** F-10 — how many times a technically failed owed version is asked again. */
export const OTS_OWED_VERSION_MAX_RETRIES = 3;

/**
 * F-10 — the key of the n-th retry of an owed chain-verified version. Shorter
 * parts than the first key so the whole stays within the 80-character column.
 */
export function otsChainVerifiedRetryKey(proofSha256: string, blockHash: string, attempt: number): string {
  const proof = proofSha256.trim().toLowerCase().slice(0, 30);
  const block = blockHash.trim().toLowerCase().slice(-30);
  return `ots-cv-r${attempt}:${proof}:${block}`;
}

/**
 * F-10 (independent forward audit, closure) — may an owed version whose latest
 * request ended be asked again? A TECHNICAL terminal failure, yes (bounded);
 * a policy block whose blocker COULD end (a legal hold, a suspension) also —
 * the request writer itself decides whether the blocker has cleared. A
 * business, integrity or commercial terminal is a stable answer: never.
 */
export function owedVersionRetryable(prior: { state: string; terminalReasonCode: string | null }): boolean {
  if (prior.state === "FAILED_TERMINAL") return classifyTerminalReason(prior.terminalReasonCode) === "TECHNICAL";
  if (prior.state === "BLOCKED_POLICY" || prior.state === "BLOCKED_STALE") return isRecoverableBlockedTerminalReason(prior.terminalReasonCode);
  return false;
}

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
  // F-10 (independent forward audit) — THE OWED VERSION IS OWED UNTIL IT IS
  // ISSUED OR REFUSED. An earlier request for this proof and block used to
  // close the question whatever became of it, so one that failed TERMINALLY
  // for a technical reason (storage, a package gate) left the version owed
  // forever. A technical terminal failure is re-asked under the next retry key
  // (deterministic, so a repeat delivery collapses onto it), at most
  // OTS_OWED_VERSION_MAX_RETRIES times. A business refusal (NOT_APPLICABLE,
  // BLOCKED_*) is a stable answer and is never re-asked.
  const keys = [key, ...Array.from({ length: OTS_OWED_VERSION_MAX_RETRIES }, (_, i) => otsChainVerifiedRetryKey(anchoring.proofSha256!, blockHash, i + 1))];
  const priors = await prisma.reportGenerationRequest.findMany({
    where: { evidenceId, clientRequestKey: { in: keys } },
    select: { id: true, state: true, clientRequestKey: true, terminalReasonCode: true },
  });
  const latestPrior = priors.sort((a, b) => keys.indexOf(a.clientRequestKey!) - keys.indexOf(b.clientRequestKey!)).at(-1) ?? null;
  let requestKey = key;
  if (latestPrior) {
    const attempt = keys.indexOf(latestPrior.clientRequestKey!);
    if (!owedVersionRetryable(latestPrior) || attempt >= OTS_OWED_VERSION_MAX_RETRIES) {
      return { outcome: "already_requested", requestId: latestPrior.id };
    }
    requestKey = keys[attempt + 1]!;
  }

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
    clientRequestKey: requestKey,
    requestedByMachineId: OTS_ANCHORED_MACHINE_ID,
    // F-10 — a retry of an owed version whose request failed TECHNICALLY
    // supersedes that terminal (bounded twice: OTS_OWED_VERSION_MAX_RETRIES
    // here and the writer's own supersession budget). Never a business refusal.
    ...(requestKey !== key && latestPrior?.state === "FAILED_TERMINAL" ? { supersedeTechnicalTerminal: true } : {}),
    entitlement: workerOutputEntitlement,
  });
  if (!persisted.created) return { outcome: "refused", reason: persisted.reason };
  if (persisted.replayed) return { outcome: "already_requested", requestId: persisted.requestId };
  // F-10 (closure) — the writer COLLAPSED onto an existing row (the blocker has
  // not cleared, or the supersession budget is spent): nothing new was asked.
  if (priors.some((p) => p.id === persisted.requestId)) {
    return { outcome: "already_requested", requestId: persisted.requestId };
  }
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
