import type { Prisma } from "@prisma/client";
import {
  isCompleteOtsAnchor,
  isValidOtsBitcoinTxid,
  normalizeOtsAnchorCheck,
  resolveEffectiveOtsStatus,
  type OtsAnchorCheck,
} from "@proovra/shared";

type OtsStatus = "DISABLED" | "PENDING" | "ANCHORED" | "FAILED";

type OtsStateInput = {
  status: OtsStatus;
  proofBase64?: string | null;
  hash?: string | null;
  calendar?: string | null;
  bitcoinTxid?: string | null;
  existingBitcoinTxid?: string | null;
  anchoredAtUtc?: Date | string | null;
  upgradedAtUtc?: Date | string | null;
  failureReason?: string | null;
  /** ANCHORED only: how the anchor was established. Cleared for every other status. */
  anchorCheck?: OtsAnchorCheck | null;
};

function clean(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function cleanTxid(value: string | null | undefined): string | null {
  const trimmed = clean(value);
  return trimmed && isValidOtsBitcoinTxid(trimmed) ? trimmed.toLowerCase() : null;
}

function toDate(value: Date | string | null | undefined): Date | null {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value : null;
  }

  const trimmed = clean(value);
  if (!trimmed) return null;

  const parsed = new Date(trimmed);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function failureReason(value: string | null | undefined): string {
  return clean(value) ?? "OTS operation failed without a structured reason.";
}

/** The column shape for one OTS status. Every writer builds its data here. */
export function buildOtsEvidenceUpdateData(
  input: OtsStateInput
): Prisma.EvidenceUpdateInput {
  const bitcoinTxid =
    cleanTxid(input.bitcoinTxid) ?? cleanTxid(input.existingBitcoinTxid);
  const anchoredAtUtc = toDate(input.anchoredAtUtc);
  const upgradedAtUtc = toDate(input.upgradedAtUtc);

  switch (input.status) {
    case "DISABLED":
      return {
        otsProofBase64: null,
        otsHash: null,
        otsStatus: "DISABLED",
        otsCalendar: null,
        otsBitcoinTxid: null,
        otsAnchoredAtUtc: null,
        otsUpgradedAtUtc: null,
        otsFailureReason: null,
        otsAnchorCheck: null,
      };

    case "PENDING":
      return {
        otsProofBase64: clean(input.proofBase64),
        otsHash: clean(input.hash),
        otsStatus: "PENDING",
        otsCalendar: clean(input.calendar),
        otsBitcoinTxid: bitcoinTxid,
        otsAnchoredAtUtc: null,
        otsUpgradedAtUtc: upgradedAtUtc,
        otsFailureReason: null,
        otsAnchorCheck: null,
      };

    case "ANCHORED": {
      if (
        !isCompleteOtsAnchor({
          status: input.status,
          anchoredAtUtc,
        })
      ) {
        return {
          otsProofBase64: clean(input.proofBase64),
          otsHash: clean(input.hash),
          otsStatus: "PENDING",
          otsCalendar: clean(input.calendar),
          otsBitcoinTxid: bitcoinTxid,
          otsAnchoredAtUtc: null,
          otsUpgradedAtUtc: upgradedAtUtc,
          otsFailureReason: null,
          otsAnchorCheck: null,
        };
      }

      return {
        otsProofBase64: clean(input.proofBase64),
        otsHash: clean(input.hash),
        otsStatus: "ANCHORED",
        otsCalendar: clean(input.calendar),
        otsBitcoinTxid: bitcoinTxid,
        otsAnchoredAtUtc: anchoredAtUtc,
        otsUpgradedAtUtc: upgradedAtUtc ?? anchoredAtUtc,
        otsFailureReason: null,
        otsAnchorCheck: input.anchorCheck ?? null,
      };
    }

    case "FAILED":
      return {
        otsProofBase64: clean(input.proofBase64),
        otsHash: clean(input.hash),
        otsStatus: "FAILED",
        otsCalendar: clean(input.calendar),
        otsBitcoinTxid: bitcoinTxid,
        otsAnchoredAtUtc: null,
        otsUpgradedAtUtc: upgradedAtUtc,
        otsFailureReason: failureReason(input.failureReason),
        otsAnchorCheck: null,
      };
  }
}

// ===========================================================================
// THE OTS TRANSITION RULE (2026-09-29)
// ===========================================================================
//
// Before this, the upgrade processor wrote whatever its current run concluded,
// unconditionally: a transient calendar/network error wrote FAILED (clearing
// the anchor time) and then retried; a re-check that could not confirm an
// ANCHORED row kept the ANCHORED label and invented `anchoredAt = now`; and a
// delayed or duplicate job could overwrite a newer anchor with an older
// observation.
//
// The rule is now a pure decision over (current row, typed observation):
//
//   ANCHOR_PROVEN     the proof demonstrably carries a Bitcoin attestation for
//                     THIS record's hash (`ots verify` against the chain, or
//                     `ots info` offline). Always accepted; a stronger check
//                     replaces a weaker one, never the reverse. The anchor time
//                     is the block time when known, else the existing anchor
//                     time, else the observation time.
//   PENDING           the proof is valid but not (yet) anchored — incomplete or
//                     unknown. It never demotes a CHECKED anchor. An anchored
//                     row whose anchor was never checked (legacy) and which the
//                     re-check could not confirm is honestly demoted to PENDING:
//                     an ANCHORED label is not kept just to avoid a downgrade.
//   TRANSIENT_ERROR   the attempt itself failed (network, timeout, calendar or
//                     binary unavailable). NOTHING on the row changes; the
//                     attempt is recorded and retried.
//   PROOF_INVALID     the proof is established to be unusable — it commits to a
//                     different hash, or it is not an OpenTimestamps proof.
//                     FAILED, with the proof bytes preserved as evidence.
//   BUDGET_EXHAUSTED  a PENDING proof never anchored within the global budget.
//                     FAILED; never applied to an anchored row.
//
// Every write the processor makes is COMPARE-AND-SET against the snapshot the
// decision was made from (`applyOtsTransition`), so a delayed job, a duplicate
// delivery or a concurrent worker cannot overwrite newer OTS facts.

export type OtsRowSnapshot = {
  otsStatus: string | null;
  otsProofBase64: string | null;
  otsHash: string | null;
  otsCalendar: string | null;
  otsBitcoinTxid: string | null;
  otsAnchoredAtUtc: Date | null;
  otsUpgradedAtUtc: Date | null;
  otsFailureReason: string | null;
  otsAnchorCheck: string | null;
};

// ET-REC-06 — THE list lives in @proovra/shared (the executor and the
// remediation registry read it too); re-exported for this module's callers.
import { OTS_PERMANENT_PROOF_FAILURES, type OtsPermanentProofFailure } from "@proovra/shared";
export { OTS_PERMANENT_PROOF_FAILURES, type OtsPermanentProofFailure };

export type OtsObservation =
  | {
      kind: "ANCHOR_PROVEN";
      proofBase64: string;
      check: OtsAnchorCheck;
      txid: string | null;
      /** The Bitcoin block time, when the check reported it. Never invented. */
      blockTimeUtc: Date | null;
      blockHeight: number | null;
    }
  | { kind: "PENDING"; proofBase64: string; txid: string | null }
  | { kind: "TRANSIENT_ERROR"; reason: string }
  | { kind: "PROOF_INVALID"; code: OtsPermanentProofFailure; reason: string }
  | { kind: "BUDGET_EXHAUSTED" };

export type OtsTransition =
  | {
      kind: "WRITE";
      status: OtsStatus;
      data: Prisma.EvidenceUpdateInput;
      /** Why, for the custody event and the log. */
      phase: string;
      /** False when the write only refreshes an unchanged fact (no custody event). */
      material: boolean;
    }
  | { kind: "RECORD_ATTEMPT_ERROR"; reason: string }
  | { kind: "NO_CHANGE"; reason: string };

const CHECK_STRENGTH: Record<OtsAnchorCheck, number> = {
  PROOF_STRUCTURE: 1,
  BITCOIN_VERIFIED: 2,
};

export function isPermanentOtsProofFailure(reason: string | null | undefined): boolean {
  return (OTS_PERMANENT_PROOF_FAILURES as readonly string[]).includes(String(reason ?? ""));
}

/** An anchor established by this rule (its check is recorded). */
export function isCheckedOtsAnchor(row: Pick<OtsRowSnapshot, "otsStatus" | "otsAnchoredAtUtc" | "otsAnchorCheck">): boolean {
  return (
    resolveEffectiveOtsStatus({ status: row.otsStatus, anchoredAtUtc: row.otsAnchoredAtUtc }) === "ANCHORED" &&
    normalizeOtsAnchorCheck(row.otsAnchorCheck) !== null
  );
}

export function decideOtsTransition(
  row: OtsRowSnapshot,
  observation: OtsObservation,
  observedAt: Date,
): OtsTransition {
  const effective = resolveEffectiveOtsStatus({
    status: row.otsStatus,
    anchoredAtUtc: row.otsAnchoredAtUtc,
  });
  const currentCheck = normalizeOtsAnchorCheck(row.otsAnchorCheck);
  const rowTxid = isValidOtsBitcoinTxid(row.otsBitcoinTxid) ? row.otsBitcoinTxid!.toLowerCase() : null;

  switch (observation.kind) {
    case "ANCHOR_PROVEN": {
      const check =
        currentCheck && effective === "ANCHORED" && CHECK_STRENGTH[currentCheck] > CHECK_STRENGTH[observation.check]
          ? currentCheck
          : observation.check;
      const txid = (isValidOtsBitcoinTxid(observation.txid) ? observation.txid!.toLowerCase() : null) ?? rowTxid;
      const anchoredAtUtc =
        observation.blockTimeUtc ??
        (effective === "ANCHORED" ? row.otsAnchoredAtUtc : null) ??
        observedAt;
      const unchanged =
        effective === "ANCHORED" &&
        currentCheck === check &&
        rowTxid === txid &&
        row.otsProofBase64 === observation.proofBase64 &&
        row.otsAnchoredAtUtc?.getTime() === anchoredAtUtc.getTime();
      if (unchanged) return { kind: "NO_CHANGE", reason: "anchor already recorded with this proof and check" };
      return {
        kind: "WRITE",
        status: "ANCHORED",
        data: buildOtsEvidenceUpdateData({
          status: "ANCHORED",
          proofBase64: observation.proofBase64,
          hash: row.otsHash,
          calendar: row.otsCalendar,
          bitcoinTxid: txid,
          anchoredAtUtc,
          upgradedAtUtc: observedAt,
          anchorCheck: check,
        }),
        phase:
          effective !== "ANCHORED"
            ? check === "BITCOIN_VERIFIED"
              ? "anchored_verified"
              : "anchored_by_proof_structure"
            : currentCheck !== check
              ? "anchor_check_recorded"
              : txid !== rowTxid
                ? "anchor_material_recovered"
                : "anchored_proof_refreshed",
        material: true,
      };
    }

    case "PENDING": {
      if (effective === "ANCHORED" && currentCheck !== null) {
        // A CHECKED anchor is never demoted by an inconclusive re-check.
        return { kind: "NO_CHANGE", reason: "checked anchor kept; the re-check was inconclusive" };
      }
      if (effective === "FAILED" && isPermanentOtsProofFailure(row.otsFailureReason)) {
        return { kind: "NO_CHANGE", reason: "proof already established invalid" };
      }
      const txid = (isValidOtsBitcoinTxid(observation.txid) ? observation.txid!.toLowerCase() : null) ?? rowTxid;
      const demoting = effective === "ANCHORED";
      const material =
        demoting ||
        effective !== "PENDING" ||
        txid !== rowTxid ||
        row.otsProofBase64 !== observation.proofBase64;
      return {
        kind: "WRITE",
        status: "PENDING",
        data: buildOtsEvidenceUpdateData({
          status: "PENDING",
          proofBase64: observation.proofBase64,
          hash: row.otsHash,
          calendar: row.otsCalendar,
          bitcoinTxid: txid,
          upgradedAtUtc: observedAt,
        }),
        phase: demoting
          ? "anchor_not_confirmed_on_recheck"
          : effective === "FAILED"
            ? "recovered_from_failed_attempt"
            : txid !== rowTxid
              ? "txid_detected_pending_confirmation"
              : "pending_confirmation",
        material,
      };
    }

    case "TRANSIENT_ERROR":
      return { kind: "RECORD_ATTEMPT_ERROR", reason: observation.reason };

    case "PROOF_INVALID": {
      if (effective === "FAILED" && row.otsFailureReason === observation.code) {
        return { kind: "NO_CHANGE", reason: "proof already recorded invalid for this reason" };
      }
      return {
        kind: "WRITE",
        status: "FAILED",
        data: buildOtsEvidenceUpdateData({
          status: "FAILED",
          // The stored proof is preserved as evidence of what was checked.
          proofBase64: row.otsProofBase64,
          hash: row.otsHash,
          calendar: row.otsCalendar,
          existingBitcoinTxid: row.otsBitcoinTxid,
          upgradedAtUtc: observedAt,
          failureReason: observation.code,
        }),
        phase: observation.code === "PROOF_HASH_MISMATCH" ? "proof_hash_mismatch" : "malformed_proof",
        material: true,
      };
    }

    case "BUDGET_EXHAUSTED": {
      if (effective !== "PENDING") {
        return { kind: "NO_CHANGE", reason: `budget exhaustion does not apply to ${effective ?? "no"} state` };
      }
      return {
        kind: "WRITE",
        status: "FAILED",
        data: buildOtsEvidenceUpdateData({
          status: "FAILED",
          proofBase64: row.otsProofBase64,
          hash: row.otsHash,
          calendar: row.otsCalendar,
          existingBitcoinTxid: row.otsBitcoinTxid,
          upgradedAtUtc: observedAt,
          failureReason: "OTS_GLOBAL_BUDGET_EXHAUSTED",
        }),
        phase: "global_budget_exhausted",
        material: true,
      };
    }
  }
}

/**
 * The compare-and-set predicate: the row must still hold exactly the OTS facts
 * the decision was made from. Nullable columns compare as IS NULL.
 */
export function otsSnapshotWhere(evidenceId: string, row: OtsRowSnapshot): Prisma.EvidenceWhereInput {
  return {
    id: evidenceId,
    otsStatus: row.otsStatus,
    otsBitcoinTxid: row.otsBitcoinTxid,
    otsAnchoredAtUtc: row.otsAnchoredAtUtc,
    otsUpgradedAtUtc: row.otsUpgradedAtUtc,
    otsAnchorCheck: row.otsAnchorCheck,
    otsFailureReason: row.otsFailureReason,
  };
}

/**
 * Apply a WRITE decision compare-and-set. Returns false when the row moved on
 * since `row` was read (the caller then records nothing: a newer fact won).
 */
export async function applyOtsTransition(
  tx: Prisma.TransactionClient,
  evidenceId: string,
  row: OtsRowSnapshot,
  transition: Extract<OtsTransition, { kind: "WRITE" }>,
): Promise<boolean> {
  const res = await tx.evidence.updateMany({
    where: otsSnapshotWhere(evidenceId, row),
    data: transition.data as Prisma.EvidenceUpdateManyMutationInput,
  });
  return res.count === 1;
}

/** OpenTimestamps proof files begin with this magic header. */
const OTS_MAGIC = Buffer.from([
  0x00, 0x4f, 0x70, 0x65, 0x6e, 0x54, 0x69, 0x6d, 0x65, 0x73, 0x74, 0x61, 0x6d, 0x70, 0x73, 0x00, 0x00, 0x50,
  0x72, 0x6f, 0x6f, 0x66, 0x00, 0xbf, 0x89, 0xe2, 0xe8, 0x84, 0xe8, 0x92, 0x94,
]);

/** Structural check: is this an OpenTimestamps proof at all? Offline and deterministic. */
export function hasOtsProofMagic(proof: Buffer): boolean {
  return proof.length > OTS_MAGIC.length && proof.subarray(0, OTS_MAGIC.length).equals(OTS_MAGIC);
}
