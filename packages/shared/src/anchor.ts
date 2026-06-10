import {
  normalizeOtsStatusValue,
  isValidOtsBitcoinTxid,
  resolveEffectiveOtsStatus,
} from "./ots.js";

export type AnchorSemanticsInput = {
  transactionId?: string | null;
  receiptId?: string | null;
  publicUrl?: string | null;
  anchoredAtUtc?: string | null;
  otsStatus?: string | null;
  otsProofPresent?: boolean | null;
  publicVerificationBaseUrl?: string | null;
  evidenceId?: string | null;
};

export type AnchorSemantics = {
  transactionId: string | null;
  receiptId: string | null;
  publicUrl: string | null;
  hasTransactionId: boolean;
  hasAnchoredAt: boolean;
  hasPublicUrl: boolean;
  externalPublicationUrl: string | null;
  externalPublicationPresent: boolean;
  externalPublicationAttached: boolean;
  anchoredAtUtc: string | null;
  bitcoinTxid: string | null;
  publicAnchoringVerified: boolean;
  published: boolean;
  anchorPublished: boolean;
  anchoringStatus: "verified" | "pending" | "failed" | "unavailable";
  anchoringLabel: string;
  anchorMode: "anchored" | "pending_public_anchor" | "failed" | "not_configured";
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
  const receiptId = normalizeString(input.receiptId);
  const publicUrl = normalizeUrl(input.publicUrl);
  const anchoredAtUtc = normalizeString(input.anchoredAtUtc);
  const bitcoinTxid = isValidOtsBitcoinTxid(transactionId) ? transactionId : null;
  const externalPublicationUrl = publicUrl;
  const hasTransactionId = Boolean(transactionId);
  const hasAnchoredAt = Boolean(anchoredAtUtc);
  const hasPublicUrl = Boolean(externalPublicationUrl);
  const externalPublicationAttached = hasPublicUrl;
  const hasAnchorMaterial = Boolean(
    transactionId ||
      receiptId ||
      externalPublicationUrl ||
      anchoredAtUtc
  );
  const externalPublicationPresent = hasAnchorMaterial;
  const publicAnchoringVerified = Boolean(bitcoinTxid || anchoredAtUtc);
  const normalizedOtsStatus = normalizeOtsStatusValue(input.otsStatus);
  const effectiveOtsStatus = resolveEffectiveOtsStatus({
    status: normalizedOtsStatus,
    bitcoinTxid,
    anchoredAtUtc,
  });
  const published = hasAnchorMaterial;
  const anchorMode: AnchorSemantics["anchorMode"] =
    normalizedOtsStatus === "FAILED"
      ? "failed"
      : publicAnchoringVerified
        ? "anchored"
        : hasAnchorMaterial ||
          effectiveOtsStatus === "ANCHORED" ||
          effectiveOtsStatus === "PENDING"
          ? "pending_public_anchor"
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
      ? "Bitcoin anchoring verified"
      : anchoringStatus === "pending"
        ? "OpenTimestamps proof present; public anchoring pending"
        : anchoringStatus === "failed"
          ? "OpenTimestamps anchoring failed"
          : "OpenTimestamps unavailable";

  return {
    transactionId,
    receiptId,
    publicUrl,
    hasTransactionId,
    hasAnchoredAt,
    hasPublicUrl,
    externalPublicationUrl,
    externalPublicationPresent,
    externalPublicationAttached,
    anchoredAtUtc,
    bitcoinTxid,
    publicAnchoringVerified,
    published,
    anchorPublished: published,
    anchoringStatus,
    anchoringLabel,
    anchorMode,
    publicVerificationUrl: buildPublicVerificationUrl(
      input.publicVerificationBaseUrl,
      input.evidenceId
    ),
  };
}
