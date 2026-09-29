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
  publicVerificationBaseUrl?: string | null;
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
  publicVerificationUrl: string | null;
};

function normalizeString(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeUrl(value: string | null | undefined): string | null {
  const url = normalizeString(value);
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.toString();
  } catch {
    return null;
  }
}

function buildPublicVerificationUrl(
  baseUrl: string | null | undefined,
  evidenceId: string | null | undefined
): string | null {
  const base = normalizeUrl(baseUrl);
  const id = normalizeString(evidenceId);
  if (!base || !id) return null;
  return `${base.replace(/\/+$/, "")}/verify/${encodeURIComponent(id)}`;
}

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
    publicVerificationUrl: buildPublicVerificationUrl(
      input.publicVerificationBaseUrl,
      input.evidenceId
    ),
  };
}
