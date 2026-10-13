import type { Prisma } from "@prisma/client";
import {
  OTS_PERMANENT_PROOF_FAILURES,
  isPermanentOtsProofFailureReason,
  isValidOtsBitcoinTxid,
  resolveOtsAnchoring,
  type OtsAnchoring,
  type OtsPermanentProofFailure,
} from "@proovra/shared";

type OtsStatus = "DISABLED" | "PENDING" | "ANCHORED" | "FAILED";

/*
 * THE OTS WRITE PATH (2026-10-13).
 *
 * The stored columns are storage, not authority: the anchoring state is what
 * `resolveOtsAnchoring` reads from the stored proof bytes (packages/shared
 * ots-anchoring.ts). The worker writes `ots_status` to MATCH that resolution so
 * queries and Operations can filter on it, and never writes ANCHORED for a
 * proof that does not resolve to ANCHORED.
 *
 * DEPRECATED COLUMNS (expand/contract). The chain-verifier columns
 * (ots_chain_*), ots_attestation_recorded_at_utc / _block_height and
 * ots_anchor_check are no longer written or read as authority. They stay in
 * the schema until the contraction migration, which is safe once every
 * deployed API and worker image is at or after this change (no reader left)
 * and the reconcile-ots-state script has run --apply in each environment.
 */

type OtsStateInput = {
  status: OtsStatus;
  proofBase64?: string | null;
  hash?: string | null;
  calendar?: string | null;
  /** ANCHORED only: the txid the executed proof path derived. */
  bitcoinTxid?: string | null;
  /** ANCHORED only: when PROOVRA recorded the anchor. */
  anchoredAtUtc?: Date | string | null;
  upgradedAtUtc?: Date | string | null;
  failureReason?: string | null;
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
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  const trimmed = clean(value);
  if (!trimmed) return null;
  const parsed = new Date(trimmed);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

/** The column shape for one OTS status. Every writer builds its data here. */
export function buildOtsEvidenceUpdateData(input: OtsStateInput): Prisma.EvidenceUpdateInput {
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
      };
    case "PENDING":
      return {
        otsProofBase64: clean(input.proofBase64),
        otsHash: clean(input.hash),
        otsStatus: "PENDING",
        otsCalendar: clean(input.calendar),
        otsBitcoinTxid: null,
        otsAnchoredAtUtc: null,
        otsUpgradedAtUtc: upgradedAtUtc,
        otsFailureReason: null,
      };
    case "ANCHORED": {
      const anchoredAtUtc = toDate(input.anchoredAtUtc) ?? upgradedAtUtc;
      return {
        otsProofBase64: clean(input.proofBase64),
        otsHash: clean(input.hash),
        otsStatus: "ANCHORED",
        otsCalendar: clean(input.calendar),
        otsBitcoinTxid: cleanTxid(input.bitcoinTxid),
        otsAnchoredAtUtc: anchoredAtUtc,
        otsUpgradedAtUtc: upgradedAtUtc ?? anchoredAtUtc,
        otsFailureReason: null,
      };
    }
    case "FAILED":
      return {
        otsProofBase64: clean(input.proofBase64),
        otsHash: clean(input.hash),
        otsStatus: "FAILED",
        otsCalendar: clean(input.calendar),
        otsBitcoinTxid: null,
        otsAnchoredAtUtc: null,
        otsUpgradedAtUtc: upgradedAtUtc,
        otsFailureReason: clean(input.failureReason) ?? "OTS_PROCESSING_FAILED",
      };
  }
}

// ===========================================================================
// THE OTS TRANSITION RULE (2026-10-13)
// ===========================================================================
//
// A pure decision over (current row, typed observation). The row's state and
// the candidate proof's state are both resolved by the ONE authority.
//
//   PROOF             the bytes `ots upgrade` left behind. Resolved:
//                       ANCHORED  → write ANCHORED with those bytes (the txid
//                                   only when the executed path derives it);
//                       PENDING   → write PENDING when the bytes changed;
//                       FAILED    → a proof defect: FAILED with its bounded
//                                   code, the STORED proof preserved;
//                       anything else → no change.
//   TRANSIENT_ERROR   the attempt failed (calendar, network, binary). Nothing
//                     on the row changes; the attempt is recorded and retried.
//   BUDGET_EXHAUSTED  a PENDING proof never anchored within the global budget.
//
// ANCHORED IS TERMINAL PER PROOF: a row whose stored proof resolves to
// ANCHORED is never rewritten by an observation (no stale regression). Every
// write is COMPARE-AND-SET against the snapshot the decision was made from.

export type OtsRowSnapshot = {
  otsStatus: string | null;
  otsProofBase64: string | null;
  otsHash: string | null;
  otsCalendar: string | null;
  otsBitcoinTxid: string | null;
  otsAnchoredAtUtc: Date | null;
  otsUpgradedAtUtc: Date | null;
  otsFailureReason: string | null;
  fingerprintHash: string | null;
};

export { OTS_PERMANENT_PROOF_FAILURES, type OtsPermanentProofFailure };

export type OtsObservation =
  | { kind: "PROOF"; proofBase64: string }
  | { kind: "TRANSIENT_ERROR"; reason: string }
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
      /** The canonical resolution of what was written. */
      anchoring: OtsAnchoring;
    }
  | { kind: "RECORD_ATTEMPT_ERROR"; reason: string }
  | { kind: "NO_CHANGE"; reason: string };

export function isPermanentOtsProofFailure(reason: string | null | undefined): boolean {
  return isPermanentOtsProofFailureReason(reason);
}

/** The canonical state of a row as stored. */
export function resolveRowOtsAnchoring(row: OtsRowSnapshot): OtsAnchoring {
  return resolveOtsAnchoring({
    status: row.otsStatus,
    proofBase64: row.otsProofBase64,
    fingerprintHash: row.fingerprintHash,
    otsHash: row.otsHash,
    failureReason: row.otsFailureReason,
    calendar: row.otsCalendar,
    anchoredAtUtc: row.otsAnchoredAtUtc,
    upgradedAtUtc: row.otsUpgradedAtUtc,
  });
}

/** The proof the row stores resolves to ANCHORED: nothing may change it. */
export function isAnchoredOtsRow(row: OtsRowSnapshot): boolean {
  return resolveRowOtsAnchoring(row).state === "ANCHORED";
}

/**
 * The stored status disagrees with the stored proof (a legacy row, or one
 * written before this rule): the write that brings the status in line.
 * Returns null when they agree. Never invents a proof or a time.
 */
export function decideStoredStatusAlignment(row: OtsRowSnapshot, observedAt: Date): OtsTransition | null {
  const current = resolveRowOtsAnchoring(row);
  const stored = String(row.otsStatus ?? "").toUpperCase();
  if (current.state === "ANCHORED") {
    if (stored === "ANCHORED" && (row.otsBitcoinTxid ?? null) === (current.bitcoinTxid ?? null)) return null;
    return {
      kind: "WRITE",
      status: "ANCHORED",
      data: buildOtsEvidenceUpdateData({
        status: "ANCHORED",
        proofBase64: row.otsProofBase64,
        hash: row.otsHash,
        calendar: row.otsCalendar,
        bitcoinTxid: current.bitcoinTxid,
        anchoredAtUtc: stored === "ANCHORED" ? (row.otsAnchoredAtUtc ?? observedAt) : observedAt,
        upgradedAtUtc: row.otsUpgradedAtUtc ?? observedAt,
      }),
      phase: stored === "ANCHORED" ? "anchored_facts_aligned_with_proof" : "anchored_by_stored_proof",
      material: true,
      anchoring: resolveOtsAnchoring({
        status: "ANCHORED",
        proofBase64: row.otsProofBase64,
        fingerprintHash: row.fingerprintHash,
        otsHash: row.otsHash,
        anchoredAtUtc: stored === "ANCHORED" ? (row.otsAnchoredAtUtc ?? observedAt) : observedAt,
      }),
    };
  }
  if (current.state === "FAILED" && stored !== "FAILED" && isPermanentOtsProofFailure(current.failureCode)) {
    return proofDefect(row, current, observedAt);
  }
  if (current.state === "PENDING" && stored === "ANCHORED") {
    // A legacy ANCHORED label over a proof that carries no Bitcoin attestation.
    return {
      kind: "WRITE",
      status: "PENDING",
      data: buildOtsEvidenceUpdateData({
        status: "PENDING",
        proofBase64: row.otsProofBase64,
        hash: row.otsHash,
        calendar: row.otsCalendar,
        upgradedAtUtc: row.otsUpgradedAtUtc ?? observedAt,
      }),
      phase: "legacy_anchor_label_without_attestation",
      material: true,
      anchoring: current,
    };
  }
  return null;
}

function proofDefect(row: OtsRowSnapshot, defect: OtsAnchoring, observedAt: Date): OtsTransition {
  const code = defect.failureCode ?? "OTS_PROCESSING_FAILED";
  return {
    kind: "WRITE",
    status: "FAILED",
    data: buildOtsEvidenceUpdateData({
      status: "FAILED",
      // The stored proof is preserved as evidence of what was checked.
      proofBase64: row.otsProofBase64,
      hash: row.otsHash,
      calendar: row.otsCalendar,
      upgradedAtUtc: observedAt,
      failureReason: code,
    }),
    phase: code === "PROOF_HASH_MISMATCH" ? "proof_hash_mismatch" : code === "MALFORMED_PROOF" ? "malformed_proof" : "proof_invalid",
    material: true,
    anchoring: { ...defect, state: "FAILED", failureCode: code },
  };
}

export function decideOtsTransition(row: OtsRowSnapshot, observation: OtsObservation, observedAt: Date): OtsTransition {
  const current = resolveRowOtsAnchoring(row);
  if (current.state === "ANCHORED") {
    return { kind: "NO_CHANGE", reason: "the stored proof is anchored; ANCHORED is terminal for this proof" };
  }
  if (current.state === "FAILED" && isPermanentOtsProofFailure(current.failureCode)) {
    return { kind: "NO_CHANGE", reason: "the stored proof is established invalid" };
  }

  switch (observation.kind) {
    case "TRANSIENT_ERROR":
      return { kind: "RECORD_ATTEMPT_ERROR", reason: observation.reason };

    case "BUDGET_EXHAUSTED": {
      if (current.state !== "PENDING") {
        return { kind: "NO_CHANGE", reason: `budget exhaustion does not apply to ${current.state}` };
      }
      return {
        kind: "WRITE",
        status: "FAILED",
        data: buildOtsEvidenceUpdateData({
          status: "FAILED",
          proofBase64: row.otsProofBase64,
          hash: row.otsHash,
          calendar: row.otsCalendar,
          upgradedAtUtc: observedAt,
          failureReason: "OTS_GLOBAL_BUDGET_EXHAUSTED",
        }),
        phase: "global_budget_exhausted",
        material: true,
        anchoring: { ...current, state: "FAILED", failureCode: "OTS_GLOBAL_BUDGET_EXHAUSTED" },
      };
    }

    case "PROOF": {
      const candidate = resolveOtsAnchoring({
        status: "PENDING",
        proofBase64: observation.proofBase64,
        fingerprintHash: row.fingerprintHash,
        otsHash: row.otsHash,
        calendar: row.otsCalendar,
        anchoredAtUtc: observedAt,
      });
      if (candidate.state === "ANCHORED") {
        return {
          kind: "WRITE",
          status: "ANCHORED",
          data: buildOtsEvidenceUpdateData({
            status: "ANCHORED",
            proofBase64: observation.proofBase64,
            hash: row.otsHash,
            calendar: row.otsCalendar,
            bitcoinTxid: candidate.bitcoinTxid,
            anchoredAtUtc: observedAt,
            upgradedAtUtc: observedAt,
          }),
          phase: "anchored",
          material: true,
          anchoring: candidate,
        };
      }
      if (candidate.state === "FAILED") {
        // The upgraded bytes are defective; the STORED proof is kept.
        return proofDefect(row, candidate, observedAt);
      }
      if (candidate.state === "PENDING") {
        const proofChanged = row.otsProofBase64 !== observation.proofBase64;
        const statusChanged = String(row.otsStatus ?? "").toUpperCase() !== "PENDING";
        return {
          kind: "WRITE",
          status: "PENDING",
          data: buildOtsEvidenceUpdateData({
            status: "PENDING",
            proofBase64: observation.proofBase64,
            hash: row.otsHash,
            calendar: row.otsCalendar,
            upgradedAtUtc: observedAt,
          }),
          phase: statusChanged ? "recovered_to_pending" : proofChanged ? "proof_upgraded_pending" : "pending_confirmation",
          material: proofChanged || statusChanged,
          anchoring: candidate,
        };
      }
      return { kind: "NO_CHANGE", reason: `the upgraded proof resolves to ${candidate.state} (${candidate.failureCode ?? "no code"})` };
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
    otsProofBase64: row.otsProofBase64,
    otsBitcoinTxid: row.otsBitcoinTxid,
    otsAnchoredAtUtc: row.otsAnchoredAtUtc,
    otsUpgradedAtUtc: row.otsUpgradedAtUtc,
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

/** The columns a snapshot is read from. */
export const OTS_ROW_SNAPSHOT_SELECT = {
  otsStatus: true,
  otsProofBase64: true,
  otsHash: true,
  otsCalendar: true,
  otsBitcoinTxid: true,
  otsAnchoredAtUtc: true,
  otsUpgradedAtUtc: true,
  otsFailureReason: true,
  fingerprintHash: true,
} as const;

/** OpenTimestamps proof files begin with this magic header. */
const OTS_MAGIC = Buffer.from([
  0x00, 0x4f, 0x70, 0x65, 0x6e, 0x54, 0x69, 0x6d, 0x65, 0x73, 0x74, 0x61, 0x6d, 0x70, 0x73, 0x00, 0x00, 0x50,
  0x72, 0x6f, 0x6f, 0x66, 0x00, 0xbf, 0x89, 0xe2, 0xe8, 0x84, 0xe8, 0x92, 0x94,
]);

/** Structural check: is this an OpenTimestamps proof at all? Offline and deterministic. */
export function hasOtsProofMagic(proof: Buffer): boolean {
  return proof.length > OTS_MAGIC.length && proof.subarray(0, OTS_MAGIC.length).equals(OTS_MAGIC);
}
