import {
  ReportEvidence,
  ReportAnchorSummary,
  KeyValueRow,
  Tone,
  ReportEvidenceContentSummary,
} from "./types.js";
import {
  safe,
  buildPublicSigningKeyReference,
  redactIdentifier,
  maskEmail,
} from "./formatters.js";
import {
  mapAuthProviderLabel,
  mapCaptureMethodLabel,
  mapIdentityLevelLabel,
  mapAnchorModePublicLabel,
  mapOtsStatusPublicLabel,
  mapOtsStatusPublicLabelWithTxid,
  mapPublicAnchoringLabelFromOts,
  mapTimestampStatusPublicLabel,
} from "./normalizers.js";
import { deriveAnchorSemantics } from "@proovra/shared";

export function getTimestampDigestValueLabel(params: {
  structure?: string | null;
  itemCount?: number | null;
  tsaInputKind?: string | null;
}): string {
  const isMultipart =
    params.structure === "multipart" ||
    Number(params.itemCount ?? 0) > 1 ||
    String(params.tsaInputKind ?? "").toUpperCase() ===
      "CANONICAL_PACKAGE_SHA256";

  return isMultipart
    ? "Timestamped Digest / Canonical Package Digest"
    : "Timestamped Digest / Original File SHA-256";
}

function mapTimestampTone(status: string | null | undefined): Tone {
  const value = safe(status, "").toUpperCase();

  if (["STAMPED", "GRANTED", "VERIFIED", "SUCCEEDED"].includes(value)) {
    return "success";
  }
  if (["PENDING", "UNAVAILABLE"].includes(value)) {
    return "warning";
  }
  if (value === "FAILED") {
    return "danger";
  }
  return "neutral";
}

function mapOtsTone(status: string | null | undefined): Tone {
  const value = safe(status, "").toUpperCase();

  if (value === "ANCHORED") return "warning";
  if (value === "PENDING") return "warning";
  if (value === "FAILED") return "danger";
  return "neutral";
}

function isValidBitcoinTxid(value: string | null | undefined): boolean {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value.trim());
}

function isMeaningfulTechnicalRow(row: KeyValueRow): boolean {
  const value = safe(row.value, "");
  return value !== "" && value !== "N/A" && value !== "Not recorded";
}

export function resolveAnchorSummary(
  evidence: ReportEvidence
): ReportAnchorSummary | null {
  if (evidence.anchor) return evidence.anchor;

  const hasLegacyAnchor =
    Boolean(evidence.anchorMode) ||
    Boolean(evidence.anchorProvider) ||
    Boolean(evidence.anchorHash) ||
    Boolean(evidence.anchorPublicUrl) ||
    Boolean(evidence.anchorAnchoredAtUtc) ||
    Boolean(evidence.anchorTransactionId) ||
    Boolean(evidence.anchorReceiptId);

  if (!hasLegacyAnchor) return null;

  const semantics = deriveAnchorSemantics({
    transactionId: evidence.anchorTransactionId ?? null,
    receiptId: evidence.anchorReceiptId ?? null,
    publicUrl: evidence.anchorPublicUrl ?? null,
    anchoredAtUtc: evidence.anchorAnchoredAtUtc ?? null,
    otsStatus: evidence.otsStatus,
    otsProofPresent: Boolean(evidence.otsProofBase64),
  });

  return {
    mode: semantics.anchorMode,
    provider: evidence.anchorProvider ?? null,
    publicBaseUrl: null,
    configured: Boolean(evidence.anchorProvider),
    published: semantics.published,
    anchorHash: evidence.anchorHash ?? null,
    receiptId: semantics.receiptId,
    transactionId: semantics.transactionId,
    publicUrl: semantics.externalPublicationUrl,
    anchoredAtUtc: semantics.anchoredAtUtc,
  };
}

export function buildOrganizationDisplay(evidence: ReportEvidence): string {
  const org = safe(evidence.organizationNameSnapshot, "");
  const workspace = safe(evidence.workspaceNameSnapshot, "");

  if (org) {
    return evidence.organizationVerifiedSnapshot ? `${org} (verified)` : org;
  }

  if (workspace) return workspace;
  return "Not recorded";
}

export function buildOrganizationStatus(evidence: ReportEvidence): string {
  const hasOrg = safe(evidence.organizationNameSnapshot, "") !== "";
  const hasWorkspace = safe(evidence.workspaceNameSnapshot, "") !== "";

  if (evidence.organizationVerifiedSnapshot === true) {
    return "Verified organization";
  }
  if (hasOrg) return "Organization recorded";
  if (hasWorkspace) return "Workspace recorded";
  return "Not recorded";
}

export function buildTechnicalIdentityRows(
  evidence: ReportEvidence,
  externalMode: boolean
): KeyValueRow[] {
  return [
    {
      label: "Submitted By Email",
      value: externalMode
        ? maskEmail(evidence.submittedByEmail)
        : safe(evidence.submittedByEmail),
    },
    {
      label: "Submitted By Provider",
      value: mapAuthProviderLabel(evidence.submittedByAuthProvider),
    },
    {
      label: "Submitted By User Ref",
      value: redactIdentifier(evidence.submittedByUserId),
    },
    {
      label: "Created By User Ref",
      value: redactIdentifier(evidence.createdByUserId),
    },
    {
      label: "Uploaded By User Ref",
      value: redactIdentifier(evidence.uploadedByUserId),
    },
    {
      label: "Last Accessed By User Ref",
      value: redactIdentifier(evidence.lastAccessedByUserId),
    },
    {
      label: "Last Accessed At (UTC)",
      value: safe(evidence.lastAccessedAtUtc),
    },
    {
      label: "Capture Method",
      value: mapCaptureMethodLabel(evidence.captureMethod),
    },
    {
      label: "Identity Level",
      value: mapIdentityLevelLabel(evidence.identityLevelSnapshot),
    },
    {
      label: "Organization / Workspace",
      value: buildOrganizationDisplay(evidence),
    },
    {
      label: "Organization Status",
      value: buildOrganizationStatus(evidence),
    },
  ];
}

export function buildTimestampRows(
  evidence: ReportEvidence,
  contentSummary?: ReportEvidenceContentSummary
): KeyValueRow[] {
  const isMultipart =
    contentSummary?.structure === "multipart" ||
    Number(contentSummary?.itemCount ?? 0) > 1;

  const timestampDigestLabel = getTimestampDigestValueLabel({
    structure: contentSummary?.structure ?? null,
    itemCount: contentSummary?.itemCount ?? null,
    tsaInputKind: evidence.tsaInputKind,
  });

  return [
    { label: "Timestamp Provider", value: safe(evidence.tsaProvider) },
    { label: "Timestamp URL", value: safe(evidence.tsaUrl) },
    { label: "Serial Number", value: safe(evidence.tsaSerialNumber) },
    { label: "Generation Time (UTC)", value: safe(evidence.tsaGenTimeUtc) },
    { label: "Hash Algorithm", value: safe(evidence.tsaHashAlgorithm) },
    {
      label: "Timestamp Status",
      value: mapTimestampStatusPublicLabel(evidence.tsaStatus),
    },
    {
      label: "Timestamped Digest Type",
      value: timestampDigestLabel,
    },
  ];
}

export function buildOtsRows(evidence: ReportEvidence): KeyValueRow[] {
  return [
    {
      label: "OTS Status",
      value: mapOtsStatusPublicLabelWithTxid({
        status: evidence.otsStatus,
        bitcoinTxid: evidence.otsBitcoinTxid,
      }),
    },
    { label: "OTS Calendar", value: safe(evidence.otsCalendar) },
    { label: "OTS Anchored At (UTC)", value: safe(evidence.otsAnchoredAtUtc) },
    { label: "OTS Upgraded At (UTC)", value: safe(evidence.otsUpgradedAtUtc) },
    { label: "OTS Bitcoin TxID", value: safe(evidence.otsBitcoinTxid) },
  ].filter(isMeaningfulTechnicalRow);
}

export function buildAnchorRows(
  anchorSummary: ReportAnchorSummary | null,
  otsFacts?: {
    otsStatus?: string | null;
    otsBitcoinTxid?: string | null;
    otsAnchoredAtUtc?: string | null;
    otsProofPresent?: boolean | null;
  } | null
): KeyValueRow[] {
  if (!anchorSummary) return [];

  // The "Anchor Mode" row summarizes PUBLIC ANCHORING state (OTS /
  // Bitcoin), not the external publication pipeline. Drive the label
  // from canonical OTS facts when supplied; fall back to the
  // EvidenceAnchor-derived mode label only when OTS state is absent.
  const anchorModeLabel = otsFacts
    ? mapPublicAnchoringLabelFromOts({
        otsStatus: otsFacts.otsStatus ?? null,
        otsBitcoinTxid: otsFacts.otsBitcoinTxid ?? null,
        otsAnchoredAtUtc: otsFacts.otsAnchoredAtUtc ?? null,
        otsProofPresent: otsFacts.otsProofPresent ?? null,
        fallbackAnchorMode: anchorSummary.mode,
      })
    : mapAnchorModePublicLabel(anchorSummary.mode);

  return [
    { label: "Anchor Mode", value: anchorModeLabel },
    { label: "Anchor Provider", value: safe(anchorSummary.provider) },
    {
      label: "Anchor Anchored At (UTC)",
      value: safe(anchorSummary.anchoredAtUtc),
    },
    {
      label: "Anchor Public URL",
      value: safe(anchorSummary.publicUrl),
    },
    { label: "Anchor Receipt ID", value: safe(anchorSummary.receiptId) },
    {
      label: "Anchor Transaction ID",
      value: safe(anchorSummary.transactionId),
    },
  ].filter(isMeaningfulTechnicalRow);
}

export function buildTechnicalAppendixModel(
  evidence: ReportEvidence,
  externalMode: boolean,
  anchorSummary: ReportAnchorSummary | null,
  contentSummary: ReportEvidenceContentSummary
) {
    const signatureRows: KeyValueRow[] = [
    {
      label: "Signing Key Reference",
      value: buildPublicSigningKeyReference(
        evidence.signingKeyId,
        evidence.signingKeyVersion
      ),
    },
    {
      label: "Signature Material",
      value: evidence.signatureBase64
        ? "Recorded in verification package and verification workflow"
        : "Not recorded",
    },
    {
      label: "Public Key Material",
      value: evidence.publicKeyPem
        ? "Recorded in verification workflow"
        : "Not recorded",
    },
  ];

const usesCanonicalTimestampDigest =
  evidence.tsaInputKind != null && evidence.tsaInputKind !== "FILE_SHA256";

const isMultipart =
  contentSummary.structure === "multipart" || contentSummary.itemCount > 1;

const recordedDigestLabel =
  isMultipart
    ? "Canonical Package Digest (SHA-256)"
    : "Original File SHA-256";

const timestampDigestLabel = getTimestampDigestValueLabel({
  structure: contentSummary.structure,
  itemCount: contentSummary.itemCount,
  tsaInputKind: evidence.tsaInputKind,
});
    
const fingerprintRows: KeyValueRow[] = [
  {
    label: recordedDigestLabel,
    value: safe(evidence.fileSha256),
  },
    {
    label: "Canonical Fingerprint Hash",
    value: safe(evidence.fingerprintHash),
  },
      {
      label: "Canonical Fingerprint Record",
      value: evidence.fingerprintCanonicalJson
        ? "Recorded in verification package; omitted from PDF to keep the report readable and lightweight"
        : "Not recorded",
    },
  ];

  return {
    fileSha256: safe(evidence.fileSha256),
    fingerprintHash: safe(evidence.fingerprintHash),
    signingKeyReference: buildPublicSigningKeyReference(
      evidence.signingKeyId,
      evidence.signingKeyVersion
    ),
    signatureRows,
    fingerprintRows,
    timestampRows: buildTimestampRows(evidence, contentSummary),
    anchoringRows: buildOtsRows(evidence).concat(
      buildAnchorRows(anchorSummary, {
        otsStatus: evidence.otsStatus,
        otsBitcoinTxid: evidence.otsBitcoinTxid,
        otsAnchoredAtUtc: evidence.otsAnchoredAtUtc,
        otsProofPresent: Boolean(evidence.otsProofBase64),
      })
    ),
    timestampStatusLabel: mapTimestampStatusPublicLabel(evidence.tsaStatus),
    timestampStatusTone: mapTimestampTone(evidence.tsaStatus),
    otsStatusLabel: mapOtsStatusPublicLabelWithTxid({
      status: evidence.otsStatus,
      bitcoinTxid: evidence.otsBitcoinTxid,
    }),
    otsStatusTone:
      safe(evidence.otsStatus, "").toUpperCase() === "ANCHORED" &&
      isValidBitcoinTxid(evidence.otsBitcoinTxid)
        ? "success"
        : mapOtsTone(evidence.otsStatus),
    tsaMessageImprint: safe(evidence.tsaMessageImprint),
    tsaInputDigestHex: safe(evidence.tsaInputDigestHex),
    tsaInputKind: safe(evidence.tsaInputKind),
    otsHash: safe(evidence.otsHash),
    otsDetail: safe(evidence.otsFailureReason, ""),
    anchorHash: safe(anchorSummary?.anchorHash),
timestampReferenceNote:
  evidence.tsaTokenBase64 && !externalMode
    ? usesCanonicalTimestampDigest
      ? `Full RFC 3161 token remains available through the verification package and technical verification endpoint. This value may differ from the original file SHA-256 when the timestamp is applied to canonical evidence or fingerprint material.`
      : "Full RFC 3161 token remains available through the verification package and technical verification endpoint."
    : usesCanonicalTimestampDigest
      ? "RFC 3161 token bytes are intentionally excluded from the PDF body. This value may differ from the original file SHA-256 when the timestamp is applied to canonical evidence or fingerprint material."
      : "RFC 3161 token bytes are intentionally excluded from the PDF body.",
        signatureReferenceNote:
      evidence.signatureBase64 && !externalMode
        ? "Full signature and public-key materials remain available through the verification package and technical verification endpoint."
        : "Signature blobs are intentionally excluded from the PDF body.",
    anchoringReferenceNote:
      evidence.otsProofBase64 || anchorSummary?.publicUrl
        ? "Full anchoring proofs and publication materials remain available through the verification package and verification endpoint."
        : "No additional anchoring proof payload was recorded.",
    timestampDigestLabel,
  };
}
