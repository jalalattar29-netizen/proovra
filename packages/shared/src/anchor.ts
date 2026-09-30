import {
  isValidOtsBitcoinTxid,
  OTS_ANCHOR_CLAIM_LABELS,
  resolveOtsAnchorClaim,
} from "./ots.js";

export type AnchorSemanticsInput = {
  transactionId?: string | null;
  anchoredAtUtc?: string | null;
  otsStatus?: string | null;
  otsProofPresent?: boolean | null;
  /** How the anchor was established: BITCOIN_VERIFIED | PROOF_STRUCTURE | null (not recorded). */
  otsAnchorCheck?: string | null;
  evidenceId?: string | null;
};

export type AnchorSemantics = {
  transactionId: string | null;
  hasTransactionId: boolean;
  hasAnchoredAt: boolean;
  anchoredAtUtc: string | null;
  bitcoinTxid: string | null;
  publicAnchoringVerified: boolean;
  anchoringStatus: "verified" | "anchored_not_checked" | "pending" | "failed" | "unavailable";
  anchoringLabel: string;
  anchorMode: "anchored" | "bitcoin_anchoring_pending" | "failed" | "not_configured";
};

function normalizeString(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

// ET-PKG-07 (2026-09-30) — `buildPublicVerificationUrl(base, evidenceId)` and
// the `publicVerificationUrl` field it fed were DELETED. No caller supplied the
// base and nothing read the result; what it built was /verify/<evidence id>, a
// record id presented as a public link. A public link is a share token, minted
// by the verification-share authority.

export function deriveAnchorSemantics(
  input: AnchorSemanticsInput
): AnchorSemantics {
  const transactionId = normalizeString(input.transactionId);
  const anchoredAtUtc = normalizeString(input.anchoredAtUtc);
  const bitcoinTxid = isValidOtsBitcoinTxid(transactionId) ? transactionId : null;
  const hasTransactionId = Boolean(transactionId);
  const hasAnchoredAt = Boolean(anchoredAtUtc);
  // OpenTimestamps → Bitcoin anchoring material. This is the ONLY
  // anchoring concept PROOVRA models; there is no separate public
  // publication / receipt layer.
  const hasAnchorMaterial = Boolean(transactionId || anchoredAtUtc);
  /*
   * ONE PREDICATE (2026-09-29). This was `Boolean(bitcoinTxid || anchoredAtUtc)`
   * — a txid or a timestamp on the row, which says the proof was upgraded, not
   * that anyone checked its Bitcoin attestation. The claim now comes from the
   * shared OTS claim: VERIFIED only when the anchor was verified against the
   * Bitcoin chain. Legacy anchor material with no OTS status reads as anchored,
   * not checked.
   */
  const claim =
    input.otsStatus == null && hasAnchorMaterial
      ? // Legacy anchor material with no OTS state: recorded, never checked.
        "ANCHORED_NOT_CHECKED"
      : resolveOtsAnchorClaim({
          status: input.otsStatus,
          anchoredAtUtc,
          anchorCheck: input.otsAnchorCheck ?? null,
          proofPresent: input.otsProofPresent ?? null,
          bitcoinTxid,
        });
  const publicAnchoringVerified = claim === "VERIFIED";
  const anchorMode: AnchorSemantics["anchorMode"] =
    claim === "FAILED"
      ? "failed"
      : claim === "VERIFIED" || claim === "ANCHORED_NOT_CHECKED"
        ? "anchored"
        : claim === "PENDING" || hasAnchorMaterial
          ? "bitcoin_anchoring_pending"
          : "not_configured";

  const anchoringStatus: AnchorSemantics["anchoringStatus"] =
    claim === "VERIFIED"
      ? "verified"
      : claim === "ANCHORED_NOT_CHECKED"
        ? "anchored_not_checked"
        : claim === "PENDING"
          ? "pending"
          : claim === "FAILED"
            ? "failed"
            : "unavailable";

  const anchoringLabel =
    claim === "NOT_CONFIGURED" ? OTS_ANCHOR_CLAIM_LABELS.UNAVAILABLE : OTS_ANCHOR_CLAIM_LABELS[claim];

  return {
    transactionId,
    hasTransactionId,
    hasAnchoredAt,
    anchoredAtUtc,
    bitcoinTxid,
    publicAnchoringVerified,
    anchoringStatus,
    anchoringLabel,
    anchorMode,
  };
}
