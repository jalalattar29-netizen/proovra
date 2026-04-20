import {
  ReportEvidence,
  ReportAnchorSummary,
  KeyValueRow,
  Tone,
} from "./types.js";
import {
  safe,
  shortHash,
  buildPublicSigningKeyReference,
  redactIdentifier,
  maskEmail,
  summarizeText,
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
    { label: "Timestamp URL", value: summarizeText(safe(evidence.tsaUrl), 84) },
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
    { label: "OTS Bitcoin TxID", value: shortHash(evidence.otsBitcoinTxid) },
  ];
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
      value: summarizeText(safe(anchorSummary.publicUrl), 84),
    },
    { label: "Anchor Receipt ID", value: shortHash(anchorSummary.receiptId) },
    {
      label: "Anchor Transaction ID",
      value: shortHash(anchorSummary.transactionId),
    },
  ];
}

export function buildTechnicalAppendixModel(
  evidence: ReportEvidence,
  externalMode: boolean,
  anchorSummary: ReportAnchorSummary | null
) {
  return {
    fileSha256: safe(evidence.fileSha256),
    fingerprintHash: safe(evidence.fingerprintHash),
    fingerprintCanonicalJsonExcerpt: externalMode
      ? null
      : evidence.fingerprintCanonicalJson
        ? summarizeText(evidence.fingerprintCanonicalJson, 1600)
        : null,
    signingKeyReference: buildPublicSigningKeyReference(
      evidence.signingKeyId,
      evidence.signingKeyVersion
    ),
    signatureExcerpt: externalMode ? null : safe(evidence.signatureBase64),
    publicKeyExcerpt: externalMode ? null : safe(evidence.publicKeyPem),
    timestampRows: buildTimestampRows(evidence),
    otsRows: buildOtsRows(evidence),
    anchorRows: buildAnchorRows(anchorSummary),
    timestampStatusLabel: mapTimestampStatusPublicLabel(evidence.tsaStatus),
    timestampStatusTone: mapTimestampTone(evidence.tsaStatus),
    otsStatusLabel: mapOtsStatusPublicLabel(evidence.otsStatus),
    otsStatusTone: mapOtsTone(evidence.otsStatus),
    tsaMessageImprint: externalMode ? null : safe(evidence.tsaMessageImprint),
    tsaTokenExcerpt: externalMode ? null : safe(evidence.tsaTokenBase64),
    otsHash: externalMode ? null : safe(evidence.otsHash),
    otsProofExcerpt: externalMode ? null : safe(evidence.otsProofBase64),
    otsDetail: safe(evidence.otsFailureReason, ""),
    anchorHash: externalMode ? null : safe(anchorSummary?.anchorHash),
  };
}