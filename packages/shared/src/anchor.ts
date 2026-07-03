import {
  normalizeOtsStatusValue,
  isValidOtsBitcoinTxid,
  resolveEffectiveOtsStatus,
} from "./ots.js";

export type AnchorSemanticsInput = {
  transactionId?: string | null;
  anchoredAtUtc?: string | null;
  otsStatus?: string | null;
  otsProofPresent?: boolean | null;
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
  anchoringStatus: "verified" | "pending" | "failed" | "unavailable";
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
  const publicAnchoringVerified = Boolean(bitcoinTxid || anchoredAtUtc);
  const normalizedOtsStatus = normalizeOtsStatusValue(input.otsStatus);
  const effectiveOtsStatus = resolveEffectiveOtsStatus({
    status: normalizedOtsStatus,
    bitcoinTxid,
    anchoredAtUtc,
  });
  const anchorMode: AnchorSemantics["anchorMode"] =
    normalizedOtsStatus === "FAILED"
      ? "failed"
      : publicAnchoringVerified
        ? "anchored"
        : hasAnchorMaterial ||
          effectiveOtsStatus === "ANCHORED" ||
          effectiveOtsStatus === "PENDING"
          ? "bitcoin_anchoring_pending"
          : "not_configured";

  let anchoringStatus: AnchorSemantics["anchoringStatus"] = "unavailable";

  if (normalizedOtsStatus === "FAILED") {
    anchoringStatus = "failed";
  } else if (publicAnchoringVerified) {
    anchoringStatus = "verified";
  } else if (
    Boolean(input.otsProofPresent) ||
    effectiveOtsStatus === "ANCHORED" ||
    effectiveOtsStatus === "PENDING" ||
    hasAnchorMaterial
  ) {
    anchoringStatus = "pending";
  }

  // Phase IA-OTS-hybrid-fix (UX correction) — visible callers keep the
  // existing short-form anchor labels. Detailed PENDING+txid
  // explanation is provided to technical-appendix surfaces via the
  // worker's `mapOtsStatusTechnicalDetail` helper, not here.
  const anchoringLabel =
    anchoringStatus === "verified"
      ? "OpenTimestamps Bitcoin anchoring verified"
      : anchoringStatus === "pending"
        ? "OpenTimestamps proof present; Bitcoin anchoring pending"
        : anchoringStatus === "failed"
          ? "OpenTimestamps anchoring failed"
          : "OpenTimestamps unavailable";

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
