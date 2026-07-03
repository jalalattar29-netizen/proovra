import type {
  CanonicalEvidenceMaterials,
  CanonicalOtsStateMaterial,
  CanonicalTimestampStateMaterial,
} from "@proovra/shared";
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
import { deriveAnchorSemantics, formatTimestampForReportUtc } from "@proovra/shared";
import { captureMethodDisplayLabel } from "@proovra/shared-runtime/technical-metadata";

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
    Boolean(evidence.anchorAnchoredAtUtc) ||
    Boolean(evidence.anchorTransactionId);

  if (!hasLegacyAnchor) return null;

  const semantics = deriveAnchorSemantics({
    transactionId: evidence.anchorTransactionId ?? null,
    anchoredAtUtc: evidence.anchorAnchoredAtUtc ?? null,
    otsStatus: evidence.otsStatus,
    otsProofPresent: Boolean(evidence.otsProofBase64),
  });

  return {
    mode: semantics.anchorMode,
    provider: evidence.anchorProvider ?? null,
    configured: Boolean(evidence.anchorProvider),
    anchorHash: evidence.anchorHash ?? null,
    transactionId: semantics.transactionId,
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

/** Role label shown for intake evidence instead of the contributor's email.
 *  Kept identical to the Executive Summary "Submitted By" wording so the PDF
 *  is internally consistent across surfaces. */
export const INTAKE_SUBMITTED_BY_ROLE_LABEL =
  "Remote Contributor via Secure Intake Link";

/** Intake Contributor Identity — the remote contributor is never independently
 *  verified by an intake link, so the Technical Appendix states this plainly,
 *  matching the Chain of Custody. (The requester's verification level is shown
 *  separately under "Requester Identity".) */
export const INTAKE_CONTRIBUTOR_IDENTITY_LABEL = "Not independently verified";

export function buildTechnicalIdentityRows(
  evidence: ReportEvidence,
  externalMode: boolean,
  // Intake-only role modeling. For remote intake the authenticated workspace
  // account is the link creator / requester — NOT the person who captured the
  // evidence. The Technical Appendix must never expose the contributor's (or
  // workspace's) email as "Submitted By Email"; it shows a role label instead.
  // Web/mobile capture is UNCHANGED (isIntake defaults to false).
  isIntake = false,
  contributorIdentity: string | null = null,
  // Capture-environment uploadSource (e.g. WEB_APP). Used ONLY to give Web
  // Capture / Browser Upload the same acquisition label the Executive Summary
  // shows ("PROOVRA Web Upload") instead of the structure enum
  // ("Multipart package"). Mobile / API / unknown are untouched.
  uploadSource: string | null = null
): KeyValueRow[] {
  const lastAccessedRows: KeyValueRow[] = [
    {
      label: "Last Accessed By User Ref",
      value: redactIdentifier(evidence.lastAccessedByUserId),
    },
    { label: "Last Accessed At (UTC)", value: formatTimestampForReportUtc(evidence.lastAccessedAtUtc) },
  ];
  const orgRows: KeyValueRow[] = [
    { label: "Organization / Workspace", value: buildOrganizationDisplay(evidence) },
    { label: "Organization Status", value: buildOrganizationStatus(evidence) },
  ];

  if (isIntake) {
    // Remote-contributor role model. The authenticated workspace account is the
    // LINK CREATOR / requester — NOT the person who captured the evidence — so
    // owner-scoped identity fields (auth provider, submitter/uploader user refs)
    // are NOT shown as if they belonged to the contributor. `createdByUserId`
    // is the link creator, shown under a role-accurate label. Capture Method
    // reads the flow label ("Secure Intake Link"), never the raw upload enum
    // (which is MULTIPART_PACKAGE / UPLOADED_FILE after completion). Identity
    // Level is the REQUESTER's snapshot, labeled as such.
    return [
      { label: "Submitted By", value: INTAKE_SUBMITTED_BY_ROLE_LABEL },
      // Contributor Identity is the REMOTE CONTRIBUTOR's — which for an intake
      // link is not independently verified. It must NOT be the requester/
      // workspace-owner identity level (`identityVerification` is derived from
      // the REQUESTER's snapshot, not the contributor). This keeps the
      // Technical Appendix consistent with the Chain of Custody, which states
      // "the remote contributor's identity is not independently verified".
      // `contributorIdentity` (requester-derived) is intentionally NOT used
      // here; the requester's level is shown separately as "Requester Identity".
      { label: "Contributor Identity", value: INTAKE_CONTRIBUTOR_IDENTITY_LABEL },
      {
        label: "Link Creator User Ref",
        value: redactIdentifier(evidence.createdByUserId),
      },
      ...lastAccessedRows,
      { label: "Capture Method", value: "Secure Intake Link" },
      {
        label: "Requester Identity",
        value: mapIdentityLevelLabel(evidence.identityLevelSnapshot),
      },
      ...orgRows,
    ];
  }

  // Non-intake (web / mobile capture) — UNCHANGED authenticated-uploader model.
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
    { label: "Created By User Ref", value: redactIdentifier(evidence.createdByUserId) },
    {
      label: "Uploaded By User Ref",
      value: redactIdentifier(evidence.uploadedByUserId),
    },
    ...lastAccessedRows,
    {
      label: "Capture Method",
      // Web Capture / Browser Upload: use the SAME flow-aware acquisition
      // mapper as the Executive Summary so both read "PROOVRA Web Upload", not
      // the structure enum "Multipart package". Gated on WEB_APP so Mobile /
      // API / unknown keep their existing label (this task is Web-only).
      value:
        (uploadSource ?? "").toUpperCase() === "WEB_APP"
          ? captureMethodDisplayLabel({
              captureMethod: evidence.captureMethod,
              uploadSource,
            })
          : mapCaptureMethodLabel(evidence.captureMethod),
    },
    {
      label: "Identity Level",
      value: mapIdentityLevelLabel(evidence.identityLevelSnapshot),
    },
    ...orgRows,
  ];
}

export function buildTimestampRows(
  evidence: ReportEvidence | CanonicalTimestampStateMaterial,
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
    { label: "Timestamp Provider", value: safe((evidence as ReportEvidence).tsaProvider) },
    { label: "Timestamp URL", value: safe((evidence as ReportEvidence).tsaUrl) },
    { label: "Serial Number", value: safe((evidence as ReportEvidence).tsaSerialNumber) },
    { label: "Generation Time (UTC)", value: formatTimestampForReportUtc((evidence as ReportEvidence).tsaGenTimeUtc) },
    { label: "Hash Algorithm", value: safe((evidence as ReportEvidence).tsaHashAlgorithm) },
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

export function buildOtsRows(
  evidence: ReportEvidence | CanonicalOtsStateMaterial
): KeyValueRow[] {
  return [
    {
      label: "OTS Status",
      value: mapOtsStatusPublicLabelWithTxid({
        status: evidence.otsStatus,
        bitcoinTxid: evidence.otsBitcoinTxid,
      }),
    },
    {
      label: "OTS Calendar",
      value: safe((evidence as ReportEvidence).otsCalendar),
    },
    {
      label: "OTS Anchored At (UTC)",
      value: safe((evidence as ReportEvidence).otsAnchoredAtUtc),
    },
    {
      label: "OTS Upgraded At (UTC)",
      value: safe((evidence as ReportEvidence).otsUpgradedAtUtc),
    },
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
  // Bitcoin). Drive the label
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
      value: formatTimestampForReportUtc(anchorSummary.anchoredAtUtc),
    },
    {
      label: "Anchor Transaction ID",
      value: safe(anchorSummary.transactionId),
    },
  ].filter(isMeaningfulTechnicalRow);
}

export function buildTechnicalAppendixModel(
  canonicalMaterials: CanonicalEvidenceMaterials,
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
  canonicalMaterials.timestampState.tsaInputKind != null &&
  canonicalMaterials.timestampState.tsaInputKind !== "FILE_SHA256";

const isMultipart =
  contentSummary.structure === "multipart" || contentSummary.itemCount > 1;

const recordedDigestLabel =
  isMultipart
    ? "Canonical Package Digest (SHA-256)"
    : "Original File SHA-256";

const timestampDigestLabel = getTimestampDigestValueLabel({
  structure: contentSummary.structure,
  itemCount: contentSummary.itemCount,
  tsaInputKind: canonicalMaterials.timestampState.tsaInputKind,
});
    
const fingerprintRows: KeyValueRow[] = [
  {
    label: recordedDigestLabel,
    value: safe(canonicalMaterials.fingerprint.fileSha256),
  },
  {
    label: "Canonical Fingerprint Hash",
    value: safe(canonicalMaterials.fingerprint.fingerprintHash),
  },
  {
    label: "Canonical Fingerprint Record",
    value: canonicalMaterials.fingerprint.fingerprintCanonicalJsonPresent
      ? "Recorded in verification package; omitted from PDF to keep the report readable and lightweight"
      : "Not recorded",
  },
];

  return {
    fileSha256: safe(canonicalMaterials.fingerprint.fileSha256),
    fingerprintHash: safe(canonicalMaterials.fingerprint.fingerprintHash),
    signingKeyReference: buildPublicSigningKeyReference(
      evidence.signingKeyId,
      evidence.signingKeyVersion
    ),
    signatureRows,
    fingerprintRows,
    timestampRows: buildTimestampRows(evidence, contentSummary),
    anchoringRows: buildOtsRows(canonicalMaterials.otsState).concat(
      buildAnchorRows(anchorSummary, {
        otsStatus:
          canonicalMaterials.otsState.effectiveStatus ??
          canonicalMaterials.otsState.otsStatus,
        otsBitcoinTxid: canonicalMaterials.otsState.otsBitcoinTxid,
        otsAnchoredAtUtc: canonicalMaterials.otsState.otsAnchoredAtUtc,
        otsProofPresent: canonicalMaterials.otsState.proofPresent,
      })
    ),
    timestampStatusLabel: mapTimestampStatusPublicLabel(
      canonicalMaterials.timestampState.tsaStatus
    ),
    timestampStatusTone: mapTimestampTone(
      canonicalMaterials.timestampState.tsaStatus
    ),
    otsStatusLabel: mapOtsStatusPublicLabelWithTxid({
      status:
        canonicalMaterials.otsState.effectiveStatus ??
        canonicalMaterials.otsState.otsStatus,
      bitcoinTxid: canonicalMaterials.otsState.otsBitcoinTxid,
    }),
    otsStatusTone:
      safe(
        canonicalMaterials.otsState.effectiveStatus ??
          canonicalMaterials.otsState.otsStatus,
        ""
      ).toUpperCase() === "ANCHORED" &&
      isValidBitcoinTxid(canonicalMaterials.otsState.otsBitcoinTxid)
        ? "success"
        : mapOtsTone(canonicalMaterials.otsState.otsStatus),
    tsaMessageImprint: safe(evidence.tsaMessageImprint),
    tsaInputDigestHex: safe(canonicalMaterials.timestampState.tsaInputDigestHex),
    tsaInputKind: safe(canonicalMaterials.timestampState.tsaInputKind),
    otsHash: safe(canonicalMaterials.otsState.otsHash),
    otsDetail: safe(evidence.otsFailureReason, ""),
    anchorHash: safe(anchorSummary?.anchorHash),
timestampReferenceNote:
  (canonicalMaterials.timestampState.tokenPresent ||
    ((evidence as ReportEvidence).tsaTokenBase64 ? true : false)) &&
  !externalMode
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
      evidence.otsProofBase64 || anchorSummary?.transactionId
        ? "Full OpenTimestamps anchoring proofs remain available through the verification package and verification endpoint."
        : "No additional anchoring proof payload was recorded.",
    timestampDigestLabel,
  };
}
