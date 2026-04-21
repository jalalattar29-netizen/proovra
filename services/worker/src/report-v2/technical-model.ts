import {
  ReportEvidence,
  ReportAnchorSummary,
  KeyValueRow,
  Tone,
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
  mapTimestampStatusPublicLabel,
} from "./normalizers.js";

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

  if (value === "ANCHORED") return "success";
  if (value === "PENDING") return "warning";
  if (value === "FAILED") return "danger";
  return "neutral";
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
    Boolean(evidence.anchorAnchoredAtUtc);

  if (!hasLegacyAnchor) return null;

  const modeText = safe(evidence.anchorMode, "").toLowerCase();
  let normalizedMode: "off" | "ready" | "active" = "ready";
  if (modeText === "off") normalizedMode = "off";
  if (modeText === "active") normalizedMode = "active";

  return {
    mode: normalizedMode,
    provider: evidence.anchorProvider ?? null,
    publicBaseUrl: null,
    configured: Boolean(evidence.anchorProvider),
    published: Boolean(evidence.anchorPublicUrl || evidence.anchorAnchoredAtUtc),
    anchorHash: evidence.anchorHash ?? null,
    receiptId: evidence.anchorReceiptId ?? null,
    transactionId: evidence.anchorTransactionId ?? null,
    publicUrl: evidence.anchorPublicUrl ?? null,
    anchoredAtUtc: evidence.anchorAnchoredAtUtc ?? null,
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

export function buildTimestampRows(evidence: ReportEvidence): KeyValueRow[] {
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
  ];
}

export function buildOtsRows(evidence: ReportEvidence): KeyValueRow[] {
  return [
    { label: "OTS Status", value: mapOtsStatusPublicLabel(evidence.otsStatus) },
    { label: "OTS Calendar", value: safe(evidence.otsCalendar) },
    { label: "OTS Anchored At (UTC)", value: safe(evidence.otsAnchoredAtUtc) },
    { label: "OTS Upgraded At (UTC)", value: safe(evidence.otsUpgradedAtUtc) },
    { label: "OTS Bitcoin TxID", value: safe(evidence.otsBitcoinTxid) },
  ].filter(isMeaningfulTechnicalRow);
}

export function buildAnchorRows(
  anchorSummary: ReportAnchorSummary | null
): KeyValueRow[] {
  if (!anchorSummary) return [];

  return [
    { label: "Anchor Mode", value: mapAnchorModePublicLabel(anchorSummary.mode) },
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
  anchorSummary: ReportAnchorSummary | null
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

  const fingerprintRows: KeyValueRow[] = [
    { label: "File SHA-256", value: safe(evidence.fileSha256) },
    { label: "Fingerprint Hash", value: safe(evidence.fingerprintHash) },
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
    timestampRows: buildTimestampRows(evidence),
    anchoringRows: buildOtsRows(evidence).concat(buildAnchorRows(anchorSummary)),
    timestampStatusLabel: mapTimestampStatusPublicLabel(evidence.tsaStatus),
    timestampStatusTone: mapTimestampTone(evidence.tsaStatus),
    otsStatusLabel: mapOtsStatusPublicLabel(evidence.otsStatus),
    otsStatusTone: mapOtsTone(evidence.otsStatus),
    tsaMessageImprint: safe(evidence.tsaMessageImprint),
    otsHash: safe(evidence.otsHash),
    otsDetail: safe(evidence.otsFailureReason, ""),
    anchorHash: safe(anchorSummary?.anchorHash),
    timestampReferenceNote:
      evidence.tsaTokenBase64 && !externalMode
        ? "Full RFC 3161 token remains available through the verification package and technical verification endpoint."
        : "RFC 3161 token bytes are intentionally excluded from the PDF body.",
    signatureReferenceNote:
      evidence.signatureBase64 && !externalMode
        ? "Full signature and public-key materials remain available through the verification package and technical verification endpoint."
        : "Signature blobs are intentionally excluded from the PDF body.",
    anchoringReferenceNote:
      evidence.otsProofBase64 || anchorSummary?.publicUrl
        ? "Full anchoring proofs and publication materials remain available through the verification package and verification endpoint."
        : "No additional anchoring proof payload was recorded.",
  };
}
