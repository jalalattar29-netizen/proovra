import type {
  CanonicalEvidenceMaterials,
  CanonicalTimestampStateMaterial,
} from "@proovra/shared";
import { OTS_FAILURE_LABELS, presentOtsAnchoring } from "@proovra/shared";
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
  reportIdentityLevelLabel,
  reportIdentityRows,
  mapTimestampStatusPublicLabel,
} from "./normalizers.js";
import {
  TSA_VALIDATED_QUALIFICATION_STATEMENT,
  formatTimestampForReportUtc,
} from "@proovra/shared";
import { buildOtsAnchoringRows, otsReportBoundary, otsVerificationLabelFor, reportOtsAnchoring } from "./ots-presentation.js";
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
  if (["PENDING", "UNAVAILABLE", "RECORDED_NOT_VALIDATED"].includes(value)) {
    return "warning";
  }
  if (value === "FAILED") {
    return "danger";
  }
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
    Boolean(evidence.anchorAnchoredAtUtc) ||
    Boolean(evidence.anchorTransactionId);

  if (!hasLegacyAnchor) return null;

  // A legacy evidence-anchor row: its own material only. The OpenTimestamps
  // state is never inferred from it (ots-presentation.ts states that).
  return {
    mode: normalizeLegacyAnchorMode(evidence.anchorMode),
    provider: evidence.anchorProvider ?? null,
    configured: Boolean(evidence.anchorProvider),
    anchorHash: evidence.anchorHash ?? null,
    transactionId: null,
    anchoredAtUtc: null,
  };
}

function normalizeLegacyAnchorMode(mode: string | null | undefined): ReportAnchorSummary["mode"] {
  const value = safe(mode, "").toLowerCase();
  return value === "ready" || value === "active" ? value : "off";
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
  // NOTE: a `contributorIdentity` parameter and (UC-0) an `uploadSource`
  // parameter used to follow. The first was never read (it is REQUESTER-
  // derived); the second picked the Capture Method label from the capture
  // environment, which was inverted for the mobile and citizen routes. The
  // label now comes from `evidence.acquisitionMode`.
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
      // The requester-derived identity level is intentionally NOT shown here;
      // it is surfaced separately as "Requester Identity".
      { label: "Contributor Identity", value: INTAKE_CONTRIBUTOR_IDENTITY_LABEL },
      {
        label: "Link Creator User Ref",
        value: redactIdentifier(evidence.createdByUserId),
      },
      ...lastAccessedRows,
      { label: "Capture Method", value: "Secure Intake Link" },
      {
        label: "Requester Identity",
        value: reportIdentityLevelLabel(evidence),
      },
      // Business metadata, not a PROOVRA identifier. The label says who
      // supplied it precisely so the reader does not read it as something the
      // platform issued, checked, or matched against the contributor. Omitted
      // entirely when the organization did not supply one — an empty
      // "Customer Reference: —" row invites the reader to wonder what failed.
      ...(evidence.intakeCustomerId
        ? [
            {
              label: "Customer Reference (organization-supplied)",
              value: evidence.intakeCustomerId,
            },
          ]
        : []),
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
      // UC-0 — the report's acquisition snapshot, the same label every other
      // report and package surface shows.
      value: captureMethodDisplayLabel({
        acquisitionMode: evidence.acquisitionMode ?? null,
        isIntake,
      }),
    },
    {
      label: "Identity Level",
      value: reportIdentityLevelLabel(evidence),
    },
    ...reportIdentityRows(evidence),
    ...orgRows,
  ];
}

export function buildTimestampRows(
  evidence: ReportEvidence | CanonicalTimestampStateMaterial,
  contentSummary?: ReportEvidenceContentSummary
): KeyValueRow[] {

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
    // The validation's scope, stated here once rather than in the signal card.
    ...(/^trusted timestamp validated$/i.test(mapTimestampStatusPublicLabel(evidence.tsaStatus))
      ? [{ label: "Validation Scope", value: TSA_VALIDATED_QUALIFICATION_STATEMENT }]
      : []),
    {
      label: "Timestamped Digest Type",
      value: timestampDigestLabel,
    },
  ];
}

/**
 * (2026-10-13) The OTS technical rows: the canonical anchoring state and the
 * facts the stored proof yields (ots-presentation.ts), from the payload the
 * report renders. The anchored time is PROOVRA's recording time.
 */
export function buildOtsRows(evidence: ReportEvidence): KeyValueRow[] {
  return buildOtsAnchoringRows(evidence).filter(isMeaningfulTechnicalRow);
}

/** The legacy anchor record's own rows (provider). Never an OTS state. */
export function buildAnchorRows(anchorSummary: ReportAnchorSummary | null): KeyValueRow[] {
  if (!anchorSummary) return [];
  return [{ label: "Anchor Provider", value: safe(anchorSummary.provider) }].filter(isMeaningfulTechnicalRow);
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

  const otsAnchoring = reportOtsAnchoring(evidence);
  const otsPresentation = presentOtsAnchoring(canonicalMaterials.otsState);
  const otsTone: Tone =
    otsPresentation.tone === "success" ? "success" : otsPresentation.tone === "danger" ? "danger" : "neutral";

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
    anchoringRows: buildOtsRows(evidence).concat(buildAnchorRows(anchorSummary)),
    timestampStatusLabel: mapTimestampStatusPublicLabel(
      canonicalMaterials.timestampState.tsaStatus
    ),
    timestampStatusTone: mapTimestampTone(
      canonicalMaterials.timestampState.tsaStatus
    ),
    otsStatusLabel: otsVerificationLabelFor(canonicalMaterials.otsState.verification),
    otsStatusTone: otsTone,
    tsaMessageImprint: safe(evidence.tsaMessageImprint),
    tsaInputDigestHex: safe(canonicalMaterials.timestampState.tsaInputDigestHex),
    tsaInputKind: safe(canonicalMaterials.timestampState.tsaInputKind),
    otsHash: safe(canonicalMaterials.otsState.otsHash),
    // ANCHORED: the boundary, stated once. FAILED / UNAVAILABLE: the bounded
    // reason in words, never the stored code.
    otsDetail:
      otsAnchoring.state === "ANCHORED"
        ? (otsReportBoundary(otsAnchoring) ?? "")
        : otsAnchoring.failureCode
          ? (OTS_FAILURE_LABELS[otsAnchoring.failureCode] ?? OTS_FAILURE_LABELS.OTS_PROCESSING_FAILED!)
          : "",
    otsDetailTitle:
      otsAnchoring.verification === "CHAIN_VERIFIED"
        ? "What the Bitcoin verification establishes"
        : otsAnchoring.state === "ANCHORED"
          ? "What the Bitcoin attestation establishes"
          : "Anchoring detail",
    otsDetailTone: otsAnchoring.state === "ANCHORED" ? "neutral" : otsTone,
    anchorHash: safe(anchorSummary?.anchorHash),
timestampReferenceNote:
  (canonicalMaterials.timestampState.tokenPresent ||
    ((evidence as ReportEvidence).tsaTokenBase64 ? true : false)) &&
  !externalMode
    ? usesCanonicalTimestampDigest
      ? `The RFC 3161 token is included in the verification package as timestamp.tsr when PROOVRA validated it. This value may differ from the original file SHA-256 when the timestamp is applied to canonical evidence or fingerprint material.`
      : "The RFC 3161 token is included in the verification package as timestamp.tsr when PROOVRA validated it."
    : usesCanonicalTimestampDigest
      ? "RFC 3161 token bytes are intentionally excluded from the PDF body. This value may differ from the original file SHA-256 when the timestamp is applied to canonical evidence or fingerprint material."
      : "RFC 3161 token bytes are intentionally excluded from the PDF body.",
        signatureReferenceNote:
      evidence.signatureBase64 && !externalMode
        ? "Full signature and public-key materials are included in the verification package."
        : "Signature blobs are intentionally excluded from the PDF body.",
    anchoringReferenceNote:
      evidence.otsProofBase64 || anchorSummary?.transactionId
        ? "Full OpenTimestamps anchoring proofs remain available through the verification package and verification endpoint."
        : "No additional anchoring proof payload was recorded.",
    timestampDigestLabel,
  };
}
