import QRCode from "qrcode";
import type {
  CalloutModel,
  CustodyHashRow,
  InfoCard,
  KeyValueRow,
  PresentationMode,
  ReportAnchorSummary,
  ReportArtifactMode,
  ReportCertificationSnapshot,
  ReportCustodyEvent,
  ReportEvidence,
  ReportEvidenceAsset,
  ReportEvidenceContentSummary,
  ReportPresentationBuckets,
  ReportPresentationDecisions,
  ReportPreviewPolicy,
  ReportReviewGuidance,
  ReportV2Input,
  ReportViewModel,
  ReportVariant,
} from "./types.js";
import {
  buildPublicEvidenceReference,
  buildPublicSigningKeyReference,
  formatBytesHuman,
  maskEmail,
  safe,
  safeBooleanLabel,
} from "./formatters.js";
import {
  mapAnchorModePublicLabel,
  mapCaptureMethodLabel,
  mapCertificationStatusLabel,
  mapEvidenceAssetKindLabel,
  mapIdentityLevelLabel,
  mapObjectLockModePublicLabel,
  mapOtsStatusPublicLabel,
  mapRecordStatusLabel,
  mapTimestampStatusPublicLabel,
  mapVerificationSourceLabel,
  mapVerificationStatusLabel,
} from "./normalizers.js";
import {
  buildFingerprintNarrative,
  buildPresentationBuckets,
  buildInventoryRows,
  evidenceStructureLabel,
  isPreviewRenderable,
  parseFingerprintSummary,
  resolveContentItems,
  resolveContentSummary,
  resolvePrimaryContentItem,
} from "./content-model.js";
import {
  buildMismatchNarrative,
  buildTimelineRows,
  splitCustodyEvents,
} from "./custody-model.js";
import {
  buildExecutiveConclusion,
  buildIntegrityReadinessSummary,
  buildLegalLimitationShort,
  buildOtsCallout,
  buildReviewSequence,
  buildStorageCallout,
  buildTimestampCallout,
  hasCoreCryptoMaterials,
  isIntegrityVerified,
  normalizeOtsTone,
  normalizeStorageTone,
  normalizeTimestampTone,
} from "./truth-model.js";
import {
  buildOrganizationDisplay,
  buildTechnicalAppendixModel,
  buildTechnicalIdentityRows,
  buildTimestampRows,
  buildOtsRows,
  buildAnchorRows,
  resolveAnchorSummary,
} from "./technical-model.js";

type DisplayDescriptor = {
  displayTitle: string;
  displayDescription: string | null;
};

function buildVerifyUrl(evidenceId: string, provided?: string | null): string {
  const v = typeof provided === "string" ? provided.trim() : "";
  if (v) return v;

  const base = (
    process.env.REPORT_VERIFY_BASE_URL ?? "https://app.proovra.com/verify"
  )
    .trim()
    .replace(/\/+$/, "");

  return `${base}/${encodeURIComponent(evidenceId)}`;
}

async function generateQrDataUrl(value: string): Promise<string | null> {
  const text = safe(value, "");
  if (!text) return null;

  try {
    return await QRCode.toDataURL(text, {
      margin: 1,
      width: 256,
      errorCorrectionLevel: "M",
    });
  } catch (error) {
    console.error("[report-v2] Failed to generate QR data URL:", error);
    return null;
  }
}

function resolveDisplayDescriptor(
  evidence: ReportEvidence,
  contentSummary: ReportEvidenceContentSummary
): DisplayDescriptor {
  if (evidence.display?.displayTitle) {
    return {
      displayTitle: evidence.display.displayTitle,
      displayDescription: evidence.display.displayDescription ?? null,
    };
  }

  const displayTitle =
    safe(evidence.displayTitle, "") ||
    safe(evidence.title, "") ||
    "Digital Evidence Record";

  const displayDescription =
    safe(evidence.displayDescription, "") ||
    safe(evidence.contentCompositionSummary, "") ||
    (contentSummary.totalSizeDisplay
      ? `${evidenceStructureLabel(contentSummary)} • ${contentSummary.totalSizeDisplay}`
      : evidenceStructureLabel(contentSummary));

  return {
    displayTitle,
    displayDescription: displayDescription || null,
  };
}

function resolvePreviewPolicy(evidence: ReportEvidence): ReportPreviewPolicy {
  return (
    evidence.previewPolicy ?? {
      contentVisible: false,
      previewEnabled: false,
      downloadableFromVerify: false,
      rationale:
        "Evidence content may be described in the report while technical verification separately validates the recorded integrity state.",
      privacyNotice:
        "Anyone with access to the report or verification page may be able to inspect evidence-related materials exposed there.",
    }
  );
}

function resolveReviewGuidance(
  evidence: ReportEvidence,
  itemCount: number,
  previewableItemCount: number,
  integrityVerified: boolean
): ReportReviewGuidance {
  return (
    evidence.reviewGuidance ?? {
      reviewerWorkflow: [
        "First review the evidence content and item structure.",
        "Then review the recorded integrity outcome and custody chronology.",
        "Finally evaluate relevance, context, authorship, and admissibility separately.",
      ],
      contentReviewNote:
        previewableItemCount > 0
          ? "The report includes a structured evidence inventory and supports direct review of recorded evidence content where preview is appropriate."
          : "The recorded evidence content is not directly previewable in a standard way, but its structure and recorded integrity state remain reviewable.",
      legalAssessmentNote:
        "Use the evidence content together with the technical verification record; neither should be treated as a substitute for the other.",
      integrityAssessmentNote: integrityVerified
        ? "The recorded technical integrity checks passed for the available materials at report generation time."
        : "One or more recorded technical integrity checks require manual review before relying on this record.",
      multipartReviewNote:
        itemCount > 1
          ? "This record contains multiple items and should be reviewed as a package, including the role of the primary item."
          : "This record contains a single primary evidence item.",
    }
  );
}

function resolveLegalLimitations(evidence: ReportEvidence) {
  return (
    evidence.limitations ?? {
      short:
        "This report verifies the recorded integrity state of the evidence record. It does not independently prove factual truth, authorship, context, or legal admissibility.",
      detailed:
        "Technical verification supports detection of post-completion changes to the recorded evidence state. It does not by itself establish who created the content, whether the depicted events are true, or whether any court, insurer, regulator, employer, or authority must accept the material. Admissibility, evidentiary weight, authenticity disputes, and procedural acceptance remain matters for the competent decision-maker under applicable law.",
    }
  );
}

function mapPublicEvidenceTypeLabel(
  evidence: ReportEvidence,
  summary: ReportEvidenceContentSummary
): string {
  if (summary.itemCount > 1) {
    const hasImage = summary.imageCount > 0;
    const hasVideo = summary.videoCount > 0;
    const hasAudio = summary.audioCount > 0;
    const hasPdf = summary.pdfCount > 0 || summary.textCount > 0;

    const categories = [
      hasImage ? "Image" : null,
      hasVideo ? "Video" : null,
      hasAudio ? "Audio" : null,
      hasPdf ? "Document" : null,
    ].filter(Boolean) as string[];

    if (categories.length > 1) return "Mixed Media Evidence Package";
    if (categories.length === 1) return `${categories[0]} Evidence Package`;
    return "Multipart Evidence Package";
  }

  switch (safe(evidence.type, "").toUpperCase()) {
    case "PHOTO":
      return "Photo Evidence";
    case "VIDEO":
      return "Video Evidence";
    case "AUDIO":
      return "Audio Evidence";
    case "DOCUMENT":
      return "Document Evidence";
    default:
      if (safe(evidence.mimeType, "").startsWith("image/")) {
        return "Photo Evidence";
      }
      if (safe(evidence.mimeType, "").startsWith("video/")) {
        return "Video Evidence";
      }
      if (safe(evidence.mimeType, "").startsWith("audio/")) {
        return "Audio Evidence";
      }
      if (safe(evidence.mimeType, "").includes("pdf")) {
        return "Document Evidence";
      }
      return "Digital Evidence Record";
  }
}

function buildExecutiveRows(
  evidence: ReportEvidence,
  structureLabel: string,
  contentSummary: ReportEvidenceContentSummary,
  primaryContentItem: ReportEvidenceAsset | null,
  externalMode: boolean
): KeyValueRow[] {
  const rows: KeyValueRow[] = [];
  const add = (label: string, value: string | null | undefined) => {
    if (value === null || value === undefined || value === "") return;
    rows.push({ label, value: String(value) });
  };

  add("Evidence Reference", buildPublicEvidenceReference(evidence.id));
  add("Evidence Type", mapPublicEvidenceTypeLabel(evidence, contentSummary));
  add(
    "Verification Status",
    mapVerificationStatusLabel(evidence.verificationStatus)
  );
  add("Evidence Structure", structureLabel);
  add("Item Count", String(contentSummary.itemCount));
  add(
    "Lead Review Item",
    primaryContentItem
      ? safe(primaryContentItem.originalFileName || primaryContentItem.label)
      : "No identified lead item"
  );
  add(
    "Lead Item Type",
    primaryContentItem ? mapEvidenceAssetKindLabel(primaryContentItem.kind) : null
  );
  add("Total Content Size", safe(contentSummary.totalSizeDisplay));
  add("Captured (UTC)", safe(evidence.capturedAtUtc));
  add("Signed (UTC)", safe(evidence.signedAtUtc));
  add(
    "Submitted By",
    externalMode
      ? maskEmail(evidence.submittedByEmail)
      : safe(evidence.submittedByEmail)
  );
  add("Organization / Workspace", buildOrganizationDisplay(evidence));
  add(
    "Integrity Verified At (UTC)",
    safe(evidence.recordedIntegrityVerifiedAtUtc)
  );

  return rows;
}

function buildVerificationSummaryRows(
  evidence: ReportEvidence,
  custody: ReturnType<typeof splitCustodyEvents>,
  structureLabel: string,
  contentSummary: ReportEvidenceContentSummary,
  externalMode: boolean
): KeyValueRow[] {
  const rows: KeyValueRow[] = [];
  const add = (label: string, value: string | null | undefined) => {
    if (value === null || value === undefined || value === "") return;
    rows.push({ label, value: String(value) });
  };

  add("Evidence Reference", buildPublicEvidenceReference(evidence.id));
  add("Integrity State", mapVerificationStatusLabel(evidence.verificationStatus));
  add("Primary SHA-256", safe(evidence.fileSha256));
  add("Fingerprint Hash", safe(evidence.fingerprintHash));
  add("Primary MIME Type", safe(contentSummary.primaryMimeType));
  add("Content Size", formatBytesHuman(evidence.sizeBytes));
  add("Forensic Custody Events", String(custody.forensic.length));
  add("Access Activity Events", String(custody.access.length));
  add(
    "Signature Materials",
    evidence.signatureBase64 && evidence.signingKeyId
      ? "Recorded"
      : "Incomplete"
  );
  add(
    "Timestamp Status",
    mapTimestampStatusPublicLabel(evidence.tsaStatus)
  );
  add(
    "Anchoring Status",
    mapOtsStatusPublicLabel(evidence.otsStatus)
  );
  add("Last Verified At (UTC)", safe(evidence.lastVerifiedAtUtc));
  add(
    "Last Verified Source",
    mapVerificationSourceLabel(evidence.lastVerifiedSource)
  );
  add("Storage Lock Mode", mapObjectLockModePublicLabel(evidence.storageObjectLockMode));
  add("Retention Until (UTC)", safe(evidence.storageObjectLockRetainUntilUtc));
  add("Report Generated At (UTC)", safe(evidence.reportGeneratedAtUtc));
  add("Evidence Structure", structureLabel);
  add("Previewable Items", String(contentSummary.previewableItemCount));
  add("Downloadable Items", String(contentSummary.downloadableItemCount));
  add(
    "Verification Package Version",
    !externalMode && evidence.verificationPackageVersion
      ? String(evidence.verificationPackageVersion)
      : null
  );

  return rows;
}

function buildReviewReadinessRows(
  evidence: ReportEvidence,
  custody: ReturnType<typeof splitCustodyEvents>,
  externalMode: boolean
): KeyValueRow[] {
  return [
    {
      label: "Human Summary Ready",
      value: evidence.reviewReadyAtUtc ? "Yes" : "Not recorded",
    },
    {
      label: "Verification Status",
      value: mapVerificationStatusLabel(evidence.verificationStatus),
    },
    {
      label: "Timestamp Status",
      value: mapTimestampStatusPublicLabel(evidence.tsaStatus),
    },
    {
      label: "Public Anchoring Status",
      value: mapOtsStatusPublicLabel(evidence.otsStatus),
    },
    {
      label: "Immutable Storage",
      value: safeBooleanLabel(
        evidence.storageImmutable,
        "Verified",
        "Not fully verified",
        "Not reported"
      ),
    },
    {
      label: "Chain of Custody Present",
      value: custody.forensic.length > 0 ? "Yes" : "No",
    },
    {
      label: "Public / Access Activity Present",
      value: custody.access.length > 0 ? "Yes" : "No",
    },
    {
      label: "Technical Materials Available",
      value:
        evidence.fileSha256 &&
        evidence.fingerprintHash &&
        evidence.signatureBase64 &&
        evidence.signingKeyId
          ? "Yes"
          : "Incomplete",
    },
    {
      label: "Submitted By",
      value: externalMode
        ? maskEmail(evidence.submittedByEmail)
        : safe(evidence.submittedByEmail),
    },
    {
      label: "Identity Level",
      value: mapIdentityLevelLabel(evidence.identityLevelSnapshot),
    },
    {
      label: "Capture Method",
      value: mapCaptureMethodLabel(evidence.captureMethod),
    },
    {
      label: "Organization / Workspace",
      value: buildOrganizationDisplay(evidence),
    },
  ];
}

function buildEvidenceContentSummaryRows(
  contentSummary: ReportEvidenceContentSummary,
  primaryItem: ReportEvidenceAsset | null,
  evidence?: ReportEvidence
): KeyValueRow[] {
  const rows: KeyValueRow[] = [];
  const add = (label: string, value: string | null | undefined) => {
    if (value === null || value === undefined || value === "") return;
    rows.push({ label, value: String(value) });
  };

  add(
    "Structure",
    contentSummary.structure === "multipart"
      ? "Multipart evidence package"
      : "Single evidence item"
  );
  add("Total Items", String(contentSummary.itemCount));
  add("Previewable Items", String(contentSummary.previewableItemCount));
  add("Downloadable Items", String(contentSummary.downloadableItemCount));
  add(
    "Images",
    contentSummary.imageCount > 0 ? String(contentSummary.imageCount) : null
  );
  add(
    "Videos",
    contentSummary.videoCount > 0 ? String(contentSummary.videoCount) : null
  );
  add(
    "Audio",
    contentSummary.audioCount > 0 ? String(contentSummary.audioCount) : null
  );
  add(
    "PDF",
    contentSummary.pdfCount > 0 ? String(contentSummary.pdfCount) : null
  );
  add(
    "Text",
    contentSummary.textCount > 0 ? String(contentSummary.textCount) : null
  );
  add(
    "Other",
    contentSummary.otherCount > 0 ? String(contentSummary.otherCount) : null
  );
  add(
    "Lead Review Item",
    primaryItem
      ? safe(primaryItem.originalFileName || primaryItem.label)
      : null
  );
  add(
    "Lead Item Type",
    primaryItem ? mapEvidenceAssetKindLabel(primaryItem.kind) : null
  );
  add("Primary MIME Type", safe(contentSummary.primaryMimeType));
  add("Total Size", safe(contentSummary.totalSizeDisplay));
  add("Composition Summary", safe(evidence?.contentCompositionSummary));
  add("Content Access Mode", safe(evidence?.contentAccessPolicy?.mode));
  add(
    "Content View Allowed",
    evidence?.contentAccessPolicy
      ? safeBooleanLabel(
          evidence.contentAccessPolicy.allowContentView,
          "Yes",
          "No",
          "Not recorded"
        )
      : null
  );
  add(
    "Download Allowed",
    evidence?.contentAccessPolicy
      ? safeBooleanLabel(
          evidence.contentAccessPolicy.allowDownload,
          "Yes",
          "No",
          "Not recorded"
        )
      : null
  );

  return rows;
}

function buildStorageRows(
  evidence: ReportEvidence,
  anchorSummary: ReportAnchorSummary | null
): KeyValueRow[] {
  const rows: KeyValueRow[] = [
    { label: "Storage Region", value: safe(evidence.storageRegion) },
    {
      label: "Storage Protection Mode",
      value: mapObjectLockModePublicLabel(evidence.storageObjectLockMode),
    },
    {
      label: "Retention Until (UTC)",
      value: safe(evidence.storageObjectLockRetainUntilUtc),
    },
    {
      label: "Legal Hold",
      value: safe(evidence.storageObjectLockLegalHoldStatus, "OFF"),
    },
    {
      label: "Immutable Storage",
      value: safeBooleanLabel(
        evidence.storageImmutable,
        "Verified",
        "Not fully verified",
        "Not reported"
      ),
    },
    { label: "RFC 3161 Provider", value: safe(evidence.tsaProvider) },
    {
      label: "RFC 3161 URL",
      value: safe(evidence.tsaUrl),
    },
    { label: "RFC 3161 Serial", value: safe(evidence.tsaSerialNumber) },
    { label: "RFC 3161 Time (UTC)", value: safe(evidence.tsaGenTimeUtc) },
    {
      label: "RFC 3161 Hash Algorithm",
      value: safe(evidence.tsaHashAlgorithm),
    },
    {
      label: "RFC 3161 Status",
      value: mapTimestampStatusPublicLabel(evidence.tsaStatus),
    },
    {
      label: "Public Anchoring Status",
      value: mapOtsStatusPublicLabel(evidence.otsStatus),
    },
    { label: "OTS Calendar", value: safe(evidence.otsCalendar) },
    { label: "OTS Anchored At (UTC)", value: safe(evidence.otsAnchoredAtUtc) },
    { label: "OTS Upgraded At (UTC)", value: safe(evidence.otsUpgradedAtUtc) },
    {
      label: "OTS Bitcoin TxID",
      value: safe(evidence.otsBitcoinTxid),
    },
  ];

  if (anchorSummary) {
    rows.push(
      {
        label: "External Anchor Mode",
        value: mapAnchorModePublicLabel(anchorSummary.mode),
      },
      {
        label: "External Anchor Provider",
        value: safe(anchorSummary.provider),
      },
      {
        label: "Anchor Published",
        value: safeBooleanLabel(anchorSummary.published, "Yes", "No"),
      },
      {
        label: "Anchor Anchored At (UTC)",
        value: safe(anchorSummary.anchoredAtUtc),
      },
      {
        label: "Anchor Public URL",
        value: safe(anchorSummary.publicUrl),
      },
      {
        label: "Anchor Receipt ID",
        value: safe(anchorSummary.receiptId),
      },
      {
        label: "Anchor Transaction ID",
        value: safe(anchorSummary.transactionId),
      }
    );
  }

  return rows;
}

function buildCustodyHashRows(events: ReportCustodyEvent[]): CustodyHashRow[] {
  return events
    .filter((event) => safe(event.eventHash, "") || safe(event.prevEventHash, ""))
    .map((event) => ({
      sequence: String(event.sequence),
      atUtc: safe(event.atUtc),
      eventLabel: event.eventType,
      prevEventHash: safe(event.prevEventHash),
      eventHash: safe(event.eventHash),
    }));
}

function determinePresentationMode(
  contentSummary: ReportEvidenceContentSummary,
  contentItems: ReportEvidenceAsset[],
  custody: ReturnType<typeof splitCustodyEvents>,
  evidence: ReportEvidence
): PresentationMode {
  let score = 0;

  if (contentSummary.itemCount >= 4) score += 1;
  if (contentSummary.itemCount >= 8) score += 2;
  if (contentSummary.previewableItemCount >= 4) score += 1;
  if (custody.access.length > 0) score += 1;
  if (custody.forensic.length > 8) score += 1;
  if (evidence.certifications?.custodian || evidence.certifications?.qualifiedPerson) {
    score += 1;
  }

  const kinds = new Set(contentItems.map((item) => item.kind));
  if (kinds.size > 2) score += 1;
  if (kinds.has("video") || kinds.has("audio")) score += 1;

  const totalBytes = Number(contentSummary.totalSizeBytes ?? evidence.sizeBytes ?? 0);
  if (Number.isFinite(totalBytes) && totalBytes > 10 * 1024 * 1024) score += 1;

  if (score <= 1) return "simple";
  if (score <= 4) return "medium";
  return "heavy";
}

function mapReportVariant(mode: PresentationMode): ReportVariant {
  if (mode === "simple") return "compact";
  if (mode === "medium") return "balanced";
  return "full";
}

function buildPresentationDecisions(params: {
  presentationMode: PresentationMode;
  contentSummary: ReportEvidenceContentSummary;
  certifications: boolean;
}): ReportPresentationDecisions {
  const { presentationMode, contentSummary, certifications } = params;

  return {
    showAllPreviewableItems: true,
    showSupportingPreviewCards: contentSummary.previewableItemCount > 1,
    compactExecutiveSummary: presentationMode === "simple",
    compactLegalSection: presentationMode !== "heavy",
    compactForensicStatement: presentationMode === "simple",
    showHashChainDetailsInMainFlow: false,
    showEvidenceContentSection: presentationMode !== "simple",
    showCertificationSection: certifications,
    appendixDepth:
      presentationMode === "simple"
        ? "compact"
        : presentationMode === "medium"
          ? "balanced"
          : "full",
  };
}

function buildCertificationBlockTitle(
  kind: "custodian" | "qualified"
): string {
  return kind === "custodian"
    ? "Custodian certification state"
    : "Qualified-person certification state";
}

function buildCertificationCallout(
  cert: ReportCertificationSnapshot,
  kind: "custodian" | "qualified"
): CalloutModel {
  const title = buildCertificationBlockTitle(kind);
  const status = safe(cert?.status, "").toUpperCase();

  if (status === "ATTESTED") {
    return {
      title,
      body:
        kind === "custodian"
          ? "A custodian attestation record is attached and corresponds to the preserved evidence state."
          : "A qualified-person certification record is attached and corresponds to the preserved evidence state.",
      tone: "success",
    };
  }

  if (status === "REVOKED") {
    return {
      title,
      body:
        kind === "custodian"
          ? "A custodian certification record was revoked. Review the record carefully and use the attached state information to understand the revocation context."
          : "A qualified-person certification record was revoked. Review the record carefully and use the attached state information to understand the revocation context.",
      tone: "danger",
    };
  }

  return {
    title,
    body:
      kind === "custodian"
        ? "A custodian certification workflow exists but is not yet fully attested."
        : "A qualified-person certification workflow exists but is not yet fully attested.",
    tone: status === "REQUESTED" || status === "DRAFT" ? "warning" : "neutral",
  };
}

function buildCertificationRows(
  cert: ReportCertificationSnapshot,
  kind: "custodian" | "qualified"
): KeyValueRow[] {
  const prefix = kind === "custodian" ? "Custodian" : "Qualified Person";

  return [
    {
      label: `${prefix} Status`,
      value: mapCertificationStatusLabel(cert?.status),
    },
    { label: `${prefix} Version`, value: String(cert?.version ?? "N/A") },
    { label: `${prefix} Requested At`, value: safe(cert?.requestedAtUtc) },
    { label: `${prefix} Attested At`, value: safe(cert?.attestedAtUtc) },
    { label: `${prefix} Attestor Name`, value: safe(cert?.attestorName) },
    { label: `${prefix} Attestor Title`, value: safe(cert?.attestorTitle) },
    {
      label: `${prefix} Organization`,
      value: safe(cert?.attestorOrganization),
    },
    {
      label: `${prefix} Certification Hash`,
      value: safe(cert?.certificationHash),
    },
    { label: `${prefix} Revoked At`, value: safe(cert?.revokedAtUtc) },
  ];
}

function buildForensicIntegrityStatementModel(
  verifyUrl: string,
  structureLabel: string,
  externalMode: boolean
) {
  return {
    introLead:
      "Procedural verification checklist",
    introBody:
      "Use this section as a review workflow for validating the report against the preserved evidence package and the verification endpoint.",
    includedBulletItems: [
      "Confirm the evidence reference, package structure, and lead review item.",
      "Validate the full SHA-256 and fingerprint hash values against the preserved materials.",
      "Review custody chronology before relying on later access activity.",
      "Use the verification endpoint for signature, timestamp token, and anchoring proof validation.",
    ],
    reviewSteps:
      structureLabel === "Single evidence item"
        ? [
            "Obtain the original evidence file.",
            "Compute the SHA-256 hash of the evidence file.",
            "Compare the computed hash with the value listed in this report.",
            "Verify the digital signature using the provided public key.",
            "Verify the RFC 3161 timestamp token, when present.",
            "Verify the OpenTimestamps proof, when present.",
            "Review the forensic chain of custody events.",
            "Review immutable storage details, when present.",
          ]
        : [
            "Obtain the complete multipart evidence set.",
            "Review the canonical fingerprint and listed evidence parts.",
            "Validate the multipart composite hash against the recorded structure and hashes.",
            "Verify the digital signature using the provided public key.",
            "Verify the RFC 3161 timestamp token, when present.",
            "Verify the OpenTimestamps proof, when present.",
            "Review the forensic chain of custody events.",
            "Review immutable storage details, when present.",
          ],
    note:
      "Where a timestamp, anchoring record, or signature package exists, this PDF identifies the exact reference values while the verification workflow preserves the heavier validation payloads.",
    legalNotice: {
      title: "Procedural note",
      body:
        "This checklist is operational only and is intentionally separate from the report's legal interpretation section.",
      tone: "neutral" as const,
    },
    verificationLinkLabel: externalMode
      ? "Public verification page:"
      : "Verification link:",
    verificationLinkText: externalMode
      ? "Open public verification page"
      : verifyUrl,
  };
}

export async function buildReportViewModel(
  input: ReportV2Input
): Promise<ReportViewModel> {
  const mode: ReportArtifactMode = input.externalMode ? "external" : "internal";
  const verifyUrl = buildVerifyUrl(input.evidence.id, input.verifyUrl);
  const technicalUrl = verifyUrl.includes("?")
    ? `${verifyUrl}&tab=technical`
    : `${verifyUrl}?tab=technical`;

  const parsedFingerprintSummary = parseFingerprintSummary(
    input.evidence.fingerprintCanonicalJson
  );

  const contentSummary = resolveContentSummary(
    input.evidence,
    parsedFingerprintSummary
  );
  const contentItems = resolveContentItems(input.evidence);
  const primaryContentItem = resolvePrimaryContentItem(
    input.evidence,
    contentItems
  );
  const structureLabel =
    input.evidence.evidenceStructure?.trim() ||
    evidenceStructureLabel(contentSummary);

  const previewPolicy = resolvePreviewPolicy(input.evidence);
  const display = resolveDisplayDescriptor(input.evidence, contentSummary);
  const custody = splitCustodyEvents(input.custodyEvents);
  const integrityVerified = isIntegrityVerified(input.evidence);
  const reviewGuidance = resolveReviewGuidance(
    input.evidence,
    contentSummary.itemCount,
    contentSummary.previewableItemCount,
    integrityVerified
  );
  const legalLimitations = resolveLegalLimitations(input.evidence);
  const anchorSummary = resolveAnchorSummary(input.evidence);
  const externalMode = mode === "external";
  const presentationMode = determinePresentationMode(
    contentSummary,
    contentItems,
    custody,
    input.evidence
  );
  const reportVariant: ReportVariant = mapReportVariant(presentationMode);
  const presentationBuckets: ReportPresentationBuckets = buildPresentationBuckets({
    items: contentItems,
    primaryItem: primaryContentItem,
    presentationMode,
  });
  const presentationDecisions = buildPresentationDecisions({
    presentationMode,
    contentSummary,
    certifications: Boolean(
      input.evidence.certifications?.custodian ||
        input.evidence.certifications?.qualifiedPerson
    ),
  });

  const executiveConclusion = buildExecutiveConclusion(input.evidence);
  const legalLimitationShort = buildLegalLimitationShort();
  const reviewSequence = buildReviewSequence(
    primaryContentItem?.originalFileName ?? primaryContentItem?.label
  );
  const mismatchSummary = buildMismatchNarrative({
    evidence: input.evidence,
    integrityVerified,
    forensicEventCount: custody.forensic.length,
  });

  const timestampTone = normalizeTimestampTone(input.evidence.tsaStatus);
  const storageTone = normalizeStorageTone(
    input.evidence.storageImmutable,
    input.evidence.storageObjectLockMode,
    input.evidence.storageObjectLockRetainUntilUtc
  );
  const otsTone = normalizeOtsTone(input.evidence.otsStatus);

  const storageAndTimestampTone =
    timestampTone === "danger" || storageTone === "danger"
      ? "danger"
      : timestampTone === "success" && storageTone === "success"
        ? "success"
        : "warning";

  const technicalQrEnabled =
    !externalMode &&
    (Boolean(input.downloadUrl) ||
      process.env.REPORT_INCLUDE_TECHNICAL_QR === "true");

  const [publicQrDataUrl, technicalQrDataUrl] = await Promise.all([
    generateQrDataUrl(verifyUrl),
    technicalQrEnabled
      ? generateQrDataUrl(technicalUrl)
      : Promise.resolve(null),
  ]);

  const leadItemName =
    primaryContentItem?.originalFileName ??
    primaryContentItem?.label ??
    "No identified lead item";

  const heroCards: InfoCard[] = [
    {
      label: "Lead Review Item",
      value: primaryContentItem
        ? `${safe(leadItemName)} (${mapEvidenceAssetKindLabel(
            primaryContentItem.kind
          )})`
        : "No primary item identified",
      tone: "neutral",
    },
    {
      label: "Evidence Package",
      value: `${structureLabel} • ${contentSummary.itemCount} item${
        contentSummary.itemCount === 1 ? "" : "s"
      }`,
      tone: "neutral",
    },
    {
      label: "Storage & Timestamp",
      value: buildIntegrityReadinessSummary(input.evidence),
      tone: storageAndTimestampTone,
    },
    {
      label: "Report Mode",
      value:
        presentationMode === "simple"
          ? "Simple package presentation"
          : presentationMode === "medium"
            ? "Balanced package presentation"
            : "Heavy package presentation",
      tone: anchorSummary?.published
        ? "success"
        : otsTone === "danger"
          ? "danger"
          : "neutral",
    },
  ];

  const technicalAppendix = buildTechnicalAppendixModel(
    input.evidence,
    externalMode,
    anchorSummary
  );

  const forensicIntegrityStatement = buildForensicIntegrityStatementModel(
    verifyUrl,
    structureLabel,
    externalMode
  );

  return {
    mode,
    presentationMode,
    reportVariant,
    generatedAtUtc: input.generatedAtUtc,
    buildInfo: input.buildInfo ?? null,
    verifyUrl,
    technicalUrl,
    version: input.version,

    title: display.displayTitle,
    subtitle: display.displayDescription,

    evidenceReference: buildPublicEvidenceReference(input.evidence.id),
    recordStatusLabel: mapRecordStatusLabel(input.evidence.status),
    verificationStatusLabel: mapVerificationStatusLabel(
      input.evidence.verificationStatus
    ),
    integrityVerified,

    executiveConclusion,
    legalLimitationShort,
    reviewSequence,
    mismatchSummary,

    heroCards,

    executiveRows: buildExecutiveRows(
      input.evidence,
      structureLabel,
      contentSummary,
      primaryContentItem,
      externalMode
    ),
    verificationSummaryRows: buildVerificationSummaryRows(
      input.evidence,
      custody,
      structureLabel,
      contentSummary,
      externalMode
    ),
    reviewReadinessRows: buildReviewReadinessRows(
      input.evidence,
      custody,
      externalMode
    ),
    contentSummaryRows: buildEvidenceContentSummaryRows(
      contentSummary,
      primaryContentItem,
      input.evidence
    ),

    reviewGuidance,
    legalLimitations,

    contentSummary,
    contentItems,
    primaryContentItem,
    structureLabel,
    presentation: {
      decisions: presentationDecisions,
      buckets: presentationBuckets,
    },

    galleryEnabled: contentItems.some((item) => isPreviewRenderable(item)),
    inventoryRows: buildInventoryRows(contentItems),

    certifications: {
      custodian: input.evidence.certifications?.custodian ?? null,
      qualifiedPerson: input.evidence.certifications?.qualifiedPerson ?? null,
      hasAny: Boolean(
        input.evidence.certifications?.custodian ||
          input.evidence.certifications?.qualifiedPerson
      ),
    },

    certificationBlocks: [
      input.evidence.certifications?.custodian
        ? {
            kind: "custodian",
            callout: buildCertificationCallout(
              input.evidence.certifications.custodian,
              "custodian"
            ),
            rows: buildCertificationRows(
              input.evidence.certifications.custodian,
              "custodian"
            ),
          }
        : null,
      input.evidence.certifications?.qualifiedPerson
        ? {
            kind: "qualified",
            callout: buildCertificationCallout(
              input.evidence.certifications.qualifiedPerson,
              "qualified"
            ),
            rows: buildCertificationRows(
              input.evidence.certifications.qualifiedPerson,
              "qualified"
            ),
          }
        : null,
    ].filter(Boolean) as ReportViewModel["certificationBlocks"],

    storageRows: buildStorageRows(input.evidence, anchorSummary),
    storageCallouts: [
      buildStorageCallout(input.evidence),
      buildTimestampCallout(input.evidence),
      buildOtsCallout(input.evidence),
    ],

    forensicRows: buildTimelineRows(custody.forensic),
    accessRows: buildTimelineRows(custody.access),
    custodyHashRows: buildCustodyHashRows(custody.forensic),

    technicalIdentityRows: buildTechnicalIdentityRows(
      input.evidence,
      externalMode
    ),
    technicalFingerprintNarrative: buildFingerprintNarrative(
      parsedFingerprintSummary,
      contentSummary
    ),
    technicalAppendix,

    forensicIntegrityStatement,

    qr: {
      publicEnabled: true,
      technicalEnabled: technicalQrEnabled,
      publicLabel: "Open verification page",
      technicalLabel: "Technical materials",
      publicDataUrl: publicQrDataUrl,
      technicalDataUrl: technicalQrDataUrl,
    },

    meta: {
      hasCoreCrypto: hasCoreCryptoMaterials(input.evidence),
      previewPolicy,
      anchorSummary,
      display,
      publicEvidenceTypeLabel: mapPublicEvidenceTypeLabel(
        input.evidence,
        contentSummary
      ),
      reviewReadinessSummary: buildReviewReadinessRows(
        input.evidence,
        custody,
        externalMode
      ),
      timestampRows: buildTimestampRows(input.evidence),
      otsRows: buildOtsRows(input.evidence),
      anchorRows: buildAnchorRows(anchorSummary),
      signingKeyReference: buildPublicSigningKeyReference(
        input.evidence.signingKeyId,
        input.evidence.signingKeyVersion
      ),
      fileSizeLabel: formatBytesHuman(input.evidence.sizeBytes),
      primaryHash: primaryContentItem?.sha256 ?? "N/A",
      submittedByLabel: externalMode
        ? maskEmail(input.evidence.submittedByEmail)
        : safe(input.evidence.submittedByEmail),
      verificationPackageVersionLabel: input.evidence.verificationPackageVersion
        ? String(input.evidence.verificationPackageVersion)
        : "N/A",
      reviewerSummaryVersionLabel: input.evidence.reviewerSummaryVersion
        ? String(input.evidence.reviewerSummaryVersion)
        : "N/A",
      lastVerifiedSourceLabel: mapVerificationSourceLabel(
        input.evidence.lastVerifiedSource
      ),
      signingKeyLabel: buildPublicSigningKeyReference(
        input.evidence.signingKeyId,
        input.evidence.signingKeyVersion
      ),
      tsaMessageImprint: input.evidence.tsaMessageImprint ?? "N/A",
      otsHash: input.evidence.otsHash ?? "N/A",
      anchorHash: anchorSummary?.anchorHash ?? "N/A",
    },
  };
}
