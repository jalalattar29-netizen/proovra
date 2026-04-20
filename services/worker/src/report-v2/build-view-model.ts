import type {
  CalloutModel,
  InfoCard,
  KeyValueRow,
  ReportAnchorSummary,
  ReportArtifactMode,
  ReportCertificationSnapshot,
  ReportEvidence,
  ReportEvidenceAsset,
  ReportEvidenceContentSummary,
  ReportPreviewPolicy,
  ReportReviewGuidance,
  ReportV2Input,
  ReportViewModel,
} from "./types.js";
import {
  buildPublicEvidenceReference,
  buildPublicSigningKeyReference,
  formatBytesHuman,
  maskEmail,
  safe,
  safeBooleanLabel,
  shortHash,
  summarizeText,
} from "./formatters.js";
import {
  mapAnchorModePublicLabel,
  mapAuthProviderLabel,
  mapCaptureMethodLabel,
  mapCertificationStatusLabel,
  mapEvidenceAssetKindLabel,
  mapObjectLockModePublicLabel,
  mapOtsStatusPublicLabel,
  mapRecordStatusLabel,
  mapTimestampStatusPublicLabel,
  mapVerificationSourceLabel,
  mapVerificationStatusLabel,
} from "./normalizers.js";
import {
  buildFingerprintNarrative,
  buildInventoryRows,
  evidenceStructureLabel,
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
  buildAnchorPublicationSummary,
  buildExecutiveConclusion,
  buildIntegrityReadinessSummary,
  buildLegalLimitationShort,
  buildOtsCallout,
  buildReviewSequence,
  buildStorageCallout,
  buildTimestampCallout,
  hasCoreCryptoMaterials,
  isIntegrityVerified,
} from "./truth-model.js";
import {
  buildOrganizationDisplay,
  buildOrganizationStatus,
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
  display: DisplayDescriptor,
  externalMode: boolean
): KeyValueRow[] {
  const rows: KeyValueRow[] = [];
  const add = (label: string, value: string | null | undefined) => {
    if (value === null || value === undefined || value === "") return;
    rows.push({ label, value: String(value) });
  };

  add("Display Title", display.displayTitle);
  add("Display Description", display.displayDescription);
  add("Evidence Reference", buildPublicEvidenceReference(evidence.id));
  add("Evidence Type", mapPublicEvidenceTypeLabel(evidence, contentSummary));
  add("Record Status", mapRecordStatusLabel(evidence.status));
  add(
    "Verification Status",
    mapVerificationStatusLabel(evidence.verificationStatus)
  );
  add("Capture Method", mapCaptureMethodLabel(evidence.captureMethod));
  add("Identity Level", safe(evidence.identityLevelSnapshot));
  add(
    "Submitted By",
    externalMode
      ? maskEmail(evidence.submittedByEmail)
      : safe(evidence.submittedByEmail)
  );
  add("Auth Provider", mapAuthProviderLabel(evidence.submittedByAuthProvider));
  add("Organization / Workspace", buildOrganizationDisplay(evidence));
  add("Organization Status", buildOrganizationStatus(evidence));
  add("Evidence Structure", structureLabel);
  add("Item Count", String(contentSummary.itemCount));
  add(
    "Primary Content Kind",
    mapEvidenceAssetKindLabel(contentSummary.primaryKind)
  );
  add("MIME Type", safe(evidence.mimeType));
  add("Total Content Size", safe(contentSummary.totalSizeDisplay));
  add("Captured (UTC)", safe(evidence.capturedAtUtc));
  add("Uploaded (UTC)", safe(evidence.uploadedAtUtc));
  add("Signed (UTC)", safe(evidence.signedAtUtc));
  add(
    "Integrity Verified At (UTC)",
    safe(evidence.recordedIntegrityVerifiedAtUtc)
  );
  add(
    "Storage Protection",
    mapObjectLockModePublicLabel(evidence.storageObjectLockMode)
  );
  add(
    "Retention Until (UTC)",
    safe(evidence.storageObjectLockRetainUntilUtc)
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

  add(
    "Display Title",
    safe(
      evidence.display?.displayTitle ?? evidence.displayTitle ?? evidence.title,
      "Digital Evidence Record"
    )
  );
  add("Evidence Reference", buildPublicEvidenceReference(evidence.id));
  add("Evidence Type", mapPublicEvidenceTypeLabel(evidence, contentSummary));
  add("Evidence Structure", structureLabel);
  add("Previewable Items", String(contentSummary.previewableItemCount));
  add("Downloadable Items", String(contentSummary.downloadableItemCount));
  add("MIME Type", safe(evidence.mimeType));
  add("File Size", formatBytesHuman(evidence.sizeBytes));
  add("Duration", evidence.durationSec ? `${evidence.durationSec} sec` : null);
  add(
    "Latest Report Version",
    evidence.latestReportVersion
      ? String(evidence.latestReportVersion)
      : null
  );
  add("Report Generated At (UTC)", safe(evidence.reportGeneratedAtUtc));
  add(
    "Reviewer Summary Version",
    evidence.reviewerSummaryVersion
      ? String(evidence.reviewerSummaryVersion)
      : null
  );
  add("Last Verified At (UTC)", safe(evidence.lastVerifiedAtUtc));
  add(
    "Last Verified Source",
    mapVerificationSourceLabel(evidence.lastVerifiedSource)
  );
  add(
    "Storage Lock Mode",
    mapObjectLockModePublicLabel(evidence.storageObjectLockMode)
  );
  add(
    "Retention Until (UTC)",
    safe(evidence.storageObjectLockRetainUntilUtc)
  );
  add("Review Ready At (UTC)", safe(evidence.reviewReadyAtUtc));
  add("Forensic Custody Events", String(custody.forensic.length));
  add("Access Activity Events", String(custody.access.length));
  add("Public Verification Page", "See verification section");

  if (!externalMode) {
    add(
      "Verification Package Version",
      evidence.verificationPackageVersion
        ? String(evidence.verificationPackageVersion)
        : null
    );
    add(
      "Verification Package Generated At (UTC)",
      safe(evidence.verificationPackageGeneratedAtUtc)
    );
  }

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
      value: safe(evidence.identityLevelSnapshot),
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
  add("PDF", contentSummary.pdfCount > 0 ? String(contentSummary.pdfCount) : null);
  add("Text", contentSummary.textCount > 0 ? String(contentSummary.textCount) : null);
  add(
    "Other",
    contentSummary.otherCount > 0 ? String(contentSummary.otherCount) : null
  );
  add(
    "Primary Content Kind",
    mapEvidenceAssetKindLabel(contentSummary.primaryKind)
  );
  add(
    "Primary Content Label",
    safe(
      evidence?.primaryContentLabel ??
        mapEvidenceAssetKindLabel(contentSummary.primaryKind)
    )
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
  add("Primary Item Label", primaryItem ? safe(primaryItem.label) : null);
  add("Primary Item Size", primaryItem?.displaySizeLabel);
  add(
    "Primary Item Hash",
    primaryItem?.sha256 ? shortHash(primaryItem.sha256) : null
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
      value: summarizeText(safe(evidence.tsaUrl), 84),
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
      value: shortHash(evidence.otsBitcoinTxid),
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
        value: summarizeText(safe(anchorSummary.publicUrl), 84),
      },
      {
        label: "Anchor Receipt ID",
        value: shortHash(anchorSummary.receiptId),
      },
      {
        label: "Anchor Transaction ID",
        value: shortHash(anchorSummary.transactionId),
      }
    );
  }

  return rows;
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
    { label: `${prefix} Status`, value: mapCertificationStatusLabel(cert?.status) },
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
      value: shortHash(cert?.certificationHash),
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
      "This report was generated by the PROOVRA Digital Evidence Integrity System.",
    introBody:
      "PROOVRA applies cryptographic integrity controls, structured evidence fingerprinting, trusted timestamping records, OpenTimestamps anchoring evidence, and immutable storage protection designed to preserve the integrity state of the submitted evidence at the time of completion.",
    includedBulletItems: [
      structureLabel === "Single evidence item"
        ? "A SHA-256 cryptographic hash of the original evidence file"
        : "A SHA-256 cryptographic hash representing the multipart evidence set",
      "A canonical fingerprint record describing the evidence state and metadata",
      "A fingerprint hash derived from the canonical record",
      "A digital signature generated using the PROOVRA signing key",
      "A trusted RFC 3161 timestamp token issued by the configured Time Stamping Authority, when available",
      "OpenTimestamps anchoring evidence, when available",
      "A forensic custody timeline documenting relevant integrity-related system events",
      "Immutable storage protection using AWS S3 Object Lock, when available",
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
      "Where present, the RFC 3161 timestamp provides evidence that the signed integrity state existed at or before the issuance time recorded by the Time Stamping Authority. Where present, OpenTimestamps provides additional independent public anchoring evidence linked to the recorded evidence digest.",
    legalNotice: {
      title: "Legal Notice",
      body:
        "Cryptographic verification confirms integrity of the recorded evidence state only. It does not independently establish authorship, factual accuracy, legal admissibility, context, or probative weight. These issues remain subject to judicial, administrative, or expert evaluation under the applicable law and procedure.",
      tone: "warning" as const,
    },
    verificationLinkLabel: externalMode
      ? "Public verification page:"
      : "Verification link:",
    verificationLinkText: externalMode
      ? "Open public verification page"
      : verifyUrl,
  };
}

export function buildReportViewModel(input: ReportV2Input): ReportViewModel {
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

  const executiveConclusion = buildExecutiveConclusion(input.evidence);
  const legalLimitationShort = buildLegalLimitationShort();
  const reviewSequence = buildReviewSequence(primaryContentItem?.label);
const mismatchSummary = buildMismatchNarrative({
  evidence: input.evidence,
  integrityVerified,
  forensicEventCount: custody.forensic.length,
});

  const heroCards: InfoCard[] = [
    {
      label: "Primary Evidence",
      value: primaryContentItem
        ? `${safe(primaryContentItem.label)} (${mapEvidenceAssetKindLabel(
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
      tone: "warning",
    },
    {
      label: "External Publication",
      value: buildAnchorPublicationSummary(anchorSummary),
      tone: anchorSummary?.published ? "success" : "warning",
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
      display,
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

    galleryEnabled:
      contentItems.length > 1 && contentSummary.previewableItemCount > 0,
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
      technicalEnabled:
        !externalMode &&
        (Boolean(input.downloadUrl) ||
          process.env.REPORT_INCLUDE_TECHNICAL_QR === "true"),
      publicLabel: "Open verification page",
      technicalLabel: "Technical materials",
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
      primaryHashShort: primaryContentItem?.sha256
        ? shortHash(primaryContentItem.sha256)
        : "N/A",
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
      signingKeyShort: buildPublicSigningKeyReference(
        input.evidence.signingKeyId,
        input.evidence.signingKeyVersion
      ),
      tsaMessageImprintShort: safe(input.evidence.tsaMessageImprint),
      otsHashShort: safe(input.evidence.otsHash),
      anchorHashShort: anchorSummary?.anchorHash
        ? shortHash(anchorSummary.anchorHash)
        : "N/A",
    },
  };
}