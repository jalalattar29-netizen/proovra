/**
 * Legacy PDF renderer.
 *
 * This file remains as a compatibility fallback while Report V2
 * is introduced under services/worker/src/report-v2.
 *
 * Do not add new structural report features here.
 * Only critical compatibility or production hotfixes are allowed.
 */
import PDFDocument from "pdfkit";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { signPdfIfEnabled } from "./signPdf.js";
import { isAccessCustodyEventType } from "@proovra/shared";

type PDFDoc = InstanceType<typeof PDFDocument>;

export type ReportEvidenceAssetKind =
  | "image"
  | "video"
  | "audio"
  | "pdf"
  | "text"
  | "other";

export type ReportEvidenceAsset = {
  id: string;
  index: number;
  label: string;
  originalFileName: string | null;
  mimeType: string | null;
  kind: ReportEvidenceAssetKind;
  sizeBytes: string | null;
  durationMs: number | null;
  sha256: string | null;
  isPrimary: boolean;
  previewable: boolean;
  downloadable: boolean;
  viewUrl: string | null;
  displaySizeLabel: string | null;
  previewRole?:
    | "primary_preview"
    | "secondary_preview"
    | "download_only"
    | "metadata_only";
  embedPreference?:
    | "image"
    | "pdf_first_page"
    | "audio_placeholder"
    | "video_placeholder"
    | "text_excerpt"
    | "metadata_only";
  artifactRole?: "primary_evidence" | "supporting_evidence" | "attachment";
  originalPreservationNote?: string | null;
  reviewerRepresentationLabel?: string | null;
  reviewerRepresentationNote?: string | null;
  verificationMaterialsNote?: string | null;

  previewDataUrl?: string | null;
  previewTextExcerpt?: string | null;
  previewCaption?: string | null;
};

export type ReportEvidenceContentSummary = {
  structure: "single" | "multipart";
  itemCount: number;
  previewableItemCount: number;
  downloadableItemCount: number;
  imageCount: number;
  videoCount: number;
  audioCount: number;
  pdfCount: number;
  textCount: number;
  otherCount: number;
  primaryKind: ReportEvidenceAssetKind | null;
  primaryMimeType: string | null;
  totalSizeBytes: string | null;
  totalSizeDisplay: string | null;
};

export type ReportPreviewPolicy = {
  contentVisible: boolean;
  previewEnabled: boolean;
  downloadableFromVerify: boolean;
  rationale: string;
  privacyNotice: string;
};

export type ReportReviewGuidance = {
  reviewerWorkflow: string[];
  contentReviewNote: string;
  legalAssessmentNote: string;
  integrityAssessmentNote: string;
  multipartReviewNote: string;
};

export type ReportLegalLimitations = {
  short: string;
  detailed: string;
};

export type ReportAnchorSummary = {
  mode: "off" | "ready" | "active";
  provider: string | null;
  publicBaseUrl: string | null;
  configured: boolean;
  published: boolean;
  anchorHash: string | null;
  receiptId: string | null;
  transactionId: string | null;
  publicUrl: string | null;
  anchoredAtUtc: string | null;
};

export type ReportEvidence = {
  id: string;
  title?: string | null;

  type?: string | null;
  status: string;
  verificationStatus?: string | null;

  captureMethod?: string | null;
  identityLevelSnapshot?: string | null;

  submittedByEmail?: string | null;
  submittedByAuthProvider?: string | null;
  submittedByUserId?: string | null;
  createdByUserId?: string | null;
  uploadedByUserId?: string | null;
  lastAccessedByUserId?: string | null;
  lastAccessedAtUtc?: string | null;

  workspaceNameSnapshot?: string | null;
  organizationNameSnapshot?: string | null;
  organizationVerifiedSnapshot?: boolean | null;

  recordedIntegrityVerifiedAtUtc?: string | null;
  lastVerifiedAtUtc?: string | null;
  lastVerifiedSource?: string | null;

  verificationPackageGeneratedAtUtc?: string | null;
  verificationPackageVersion?: number | null;
  latestReportVersion?: number | null;
  reviewReadyAtUtc?: string | null;
  reviewerSummaryVersion?: number | null;

  capturedAtUtc: string | null;
  uploadedAtUtc: string | null;
  signedAtUtc: string | null;
  reportGeneratedAtUtc: string | null;

  mimeType: string | null;
  sizeBytes: string | null;
  durationSec?: string | null;

  storageBucket: string | null;
  storageKey: string | null;
  publicUrl: string | null;
  storageRegion?: string | null;
  storageImmutable?: boolean | null;
  storageObjectLockMode?: string | null;
  storageObjectLockRetainUntilUtc?: string | null;
  storageObjectLockLegalHoldStatus?: string | null;

  gps: {
    lat: string | null;
    lng: string | null;
    accuracyMeters: string | null;
  };

  evidenceStructure?: string | null;
  itemCount?: number | null;
  display?: {
    displayTitle: string;
    displayDescription: string | null;
  } | null;
  displayTitle?: string | null;
  displayDescription?: string | null;
  contentCompositionSummary?: string | null;
  primaryContentLabel?: string | null;
  contentSummary?: ReportEvidenceContentSummary | null;
  contentItems?: ReportEvidenceAsset[] | null;
  primaryContentItem?: ReportEvidenceAsset | null;
  defaultPreviewItemId?: string | null;
  previewPolicy?: ReportPreviewPolicy | null;
  reviewGuidance?: ReportReviewGuidance | null;
  limitations?: ReportLegalLimitations | null;

  contentAccessPolicy?: {
    mode?: string | null;
    allowContentView?: boolean;
    allowDownload?: boolean;
  } | null;

  fileSha256: string | null;
  fingerprintCanonicalJson: string | null;
  fingerprintHash: string | null;
  signatureBase64: string | null;
  signingKeyId: string | null;
  signingKeyVersion: number | null;
  publicKeyPem: string | null;

  tsaProvider: string | null;
  tsaUrl: string | null;
  tsaSerialNumber: string | null;
  tsaGenTimeUtc: string | null;
  tsaTokenBase64: string | null;
  tsaMessageImprint: string | null;
  tsaHashAlgorithm: string | null;
  tsaStatus: string | null;
  tsaFailureReason: string | null;

  otsProofBase64?: string | null;
  otsHash?: string | null;
  otsStatus?: string | null;
  otsCalendar?: string | null;
  otsBitcoinTxid?: string | null;
  otsAnchoredAtUtc?: string | null;
  otsUpgradedAtUtc?: string | null;
  otsFailureReason?: string | null;

  anchor?: ReportAnchorSummary | null;
  certifications?: {
    custodian?: {
      declarationType?: string | null;
      status?: string | null;
      version?: number | null;
      requestedAtUtc?: string | null;
      attestedAtUtc?: string | null;
      attestorName?: string | null;
      attestorTitle?: string | null;
      attestorOrganization?: string | null;
      certificationHash?: string | null;
      revokedAtUtc?: string | null;
    } | null;
    qualifiedPerson?: {
      declarationType?: string | null;
      status?: string | null;
      version?: number | null;
      requestedAtUtc?: string | null;
      attestedAtUtc?: string | null;
      attestorName?: string | null;
      attestorTitle?: string | null;
      attestorOrganization?: string | null;
      certificationHash?: string | null;
      revokedAtUtc?: string | null;
    } | null;
  } | null;

  anchorMode?: string | null;
  anchorProvider?: string | null;
  anchorHash?: string | null;
  anchorReceiptId?: string | null;
  anchorTransactionId?: string | null;
  anchorPublicUrl?: string | null;
  anchorAnchoredAtUtc?: string | null;
    embeddedPreviewsSnapshot?: Array<{
    id: string;
    previewDataUrl?: string | null;
    previewTextExcerpt?: string | null;
    previewCaption?: string | null;
  }> | null;
};

export type ReportCustodyEvent = {
  sequence: number;
  atUtc: string;
  eventType: string;
  payloadSummary: string;
  prevEventHash?: string | null;
  eventHash?: string | null;
  category?: "forensic" | "access";
};

type ParsedFingerprintSummary = {
  multipart: boolean;
  itemCount: number;
  imageCount: number;
  videoCount: number;
  audioCount: number;
  documentCount: number;
  mimeTypes: string[];
  partsCount: number;
};

type HeaderContext = {
  evidenceId: string;
  generatedAtUtc: string;
  status?: string;
};

type ReportEvidenceDisplayDescriptor = {
  displayTitle: string;
  displayDescription: string | null;
};

type ClassifiedCustodyEvent = ReportCustodyEvent & {
  category: "forensic" | "access";
};

function env(name: string): string | undefined {
  const v = process.env[name];
  const t = typeof v === "string" ? v.trim() : "";
  return t ? t : undefined;
}

function safe(value: string | null | undefined, fallback = "N/A"): string {
  const t = typeof value === "string" ? value.trim() : "";
  return t ? t : fallback;
}

function safeBooleanLabel(
  value: boolean | null | undefined,
  trueLabel = "Yes",
  falseLabel = "No",
  unknownLabel = "N/A"
): string {
  if (value === true) return trueLabel;
  if (value === false) return falseLabel;
  return unknownLabel;
}

function summarizeText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

function formatBytesHuman(bytesStr: string | null): string {
  const n = bytesStr ? Number(bytesStr) : Number.NaN;
  if (!Number.isFinite(n) || n <= 0) return "N/A";

  const units = ["B", "KB", "MB", "GB", "TB"] as const;
  let idx = 0;
  let v = n;

  while (v >= 1024 && idx < units.length - 1) {
    v /= 1024;
    idx++;
  }

  return `${v.toFixed(idx === 0 ? 0 : 2)} ${units[idx]}`;
}

function shortHash(h: string | null | undefined, head = 10, tail = 8): string {
  const t = safe(h, "");
  if (!t) return "N/A";
  if (t.length <= head + tail + 3) return t;
  return `${t.slice(0, head)}…${t.slice(-tail)}`;
}

function redactIdentifier(
  value: string | null | undefined,
  visible = 6
): string {
  const t = safe(value, "");
  if (!t) return "Not included in external report";
  if (t.length <= visible * 2 + 3) return t;
  return `${t.slice(0, visible)}…${t.slice(-visible)}`;
}

function maskEmail(value: string | null | undefined): string {
  const t = safe(value, "");
  if (!t || !t.includes("@")) return "Not recorded";

  const [local, domain] = t.split("@");
  if (!local || !domain) return t;

  if (local.length <= 2) {
    return `${local[0] ?? "*"}***@${domain}`;
  }

  return `${local.slice(0, 2)}***@${domain}`;
}

function buildPublicEvidenceReference(
  evidenceId: string | null | undefined
): string {
  const t = safe(evidenceId, "");
  if (!t) return "Not recorded";
  if (t.length <= 16) return t;
  return `${t.slice(0, 8)}…${t.slice(-8)}`;
}

function buildPublicSigningKeyReference(
  keyId: string | null | undefined,
  version: number | null | undefined
): string {
  const id = safe(keyId, "");
  if (!id) return "Not recorded";

  const publicRef = id
    .replace(/^dw_/, "")
    .replace(/_kms$/i, "")
    .replace(/_/g, "-");

  return version ? `${publicRef} / v${version}` : publicRef;
}

function mmToPt(mm: number): number {
  return (mm * 72) / 25.4;
}

function normalizeEnumText(value: string | null | undefined): string {
  return safe(value, "")
    .toLowerCase()
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function mapRecordStatusLabel(status: string | null | undefined): string {
  switch (safe(status, "").toUpperCase()) {
    case "CREATED":
      return "Created";
    case "UPLOADING":
      return "Uploading";
    case "UPLOADED":
      return "Uploaded";
    case "SIGNED":
      return "Signed";
    case "REPORTED":
      return "Reported";
    default:
      return safe(status);
  }
}

function mapVerificationStatusLabel(
  status: string | null | undefined
): string {
  switch (safe(status, "").toUpperCase()) {
    case "MATERIALS_AVAILABLE":
      return "Technical materials available";
    case "RECORDED_INTEGRITY_VERIFIED":
      return "Recorded integrity state verified";
    case "REVIEW_REQUIRED":
      return "Review required";
    case "FAILED":
      return "Verification failed";
    default:
      return "Verification status not recorded";
  }
}

function mapCertificationStatusLabel(value: string | null | undefined): string {
  switch (safe(value, "").toUpperCase()) {
    case "ATTESTED":
      return "Attested";
    case "REQUESTED":
      return "Requested";
    case "DRAFT":
      return "Draft";
    case "REVOKED":
      return "Revoked";
    default:
      return safe(value, "Not recorded");
  }
}

function certificationTone(
  value: string | null | undefined
): "success" | "warning" | "danger" | "neutral" {
  switch (safe(value, "").toUpperCase()) {
    case "ATTESTED":
      return "success";
    case "REQUESTED":
    case "DRAFT":
      return "warning";
    case "REVOKED":
      return "danger";
    default:
      return "neutral";
  }
}

function mapCaptureMethodLabel(value: string | null | undefined): string {
  switch (safe(value, "").toUpperCase()) {
    case "SECURE_CAMERA":
      return "Captured with PROOVRA secure camera";
    case "UPLOADED_FILE":
      return "Uploaded existing file";
    case "IMPORTED_DOCUMENT":
      return "Imported document";
    case "MULTIPART_PACKAGE":
      return "Multipart package";
    default:
      return "Capture method not recorded";
  }
}

function mapIdentityLevelLabel(value: string | null | undefined): string {
  switch (safe(value, "").toUpperCase()) {
    case "BASIC_ACCOUNT":
      return "Basic account";
    case "VERIFIED_EMAIL":
      return "Verified email";
    case "OAUTH_BACKED_IDENTITY":
      return "OAuth-backed identity";
    case "ORGANIZATION_ACCOUNT":
      return "Organization account";
    case "VERIFIED_ORGANIZATION":
      return "Verified organization";
    default:
      return "Identity level not recorded";
  }
}

function mapAuthProviderLabel(value: string | null | undefined): string {
  switch (safe(value, "").toUpperCase()) {
    case "GOOGLE":
      return "Google";
    case "APPLE":
      return "Apple";
    case "EMAIL":
      return "Email";
    case "GUEST":
      return "Guest";
    default:
      return "Provider not recorded";
  }
}

function mapVerificationSourceLabel(value: string | null | undefined): string {
  switch (safe(value, "").toUpperCase()) {
    case "REPORT_GENERATED":
      return "Report generated";
    case "PUBLIC_VERIFY_VIEWED":
      return "Public verification page viewed";
    case "TECHNICAL_VERIFICATION_CHECKED":
      return "Technical verification checked";
    default:
      return "Verification source not recorded";
  }
}

function mapCustodyEventLabel(eventType: string | null | undefined): string {
  switch (safe(eventType, "").toUpperCase()) {
    case "EVIDENCE_CREATED":
      return "Evidence created";
    case "IDENTITY_SNAPSHOT_RECORDED":
      return "Identity snapshot recorded";
    case "UPLOAD_STARTED":
      return "Upload started";
    case "UPLOAD_COMPLETED":
      return "Upload completed";
    case "SIGNATURE_APPLIED":
      return "Digital signature applied";
    case "TIMESTAMP_APPLIED":
      return "Trusted timestamp applied";
    case "REPORT_GENERATED":
      return "Report generated";
    case "REVIEW_READY":
      return "Review-ready state recorded";
    case "VERIFICATION_PACKAGE_GENERATED":
      return "Verification package generated";
    case "CERTIFICATION_REQUESTED":
      return "Certification requested";
    case "CERTIFICATION_ATTESTED":
      return "Certification attested";
    case "CERTIFICATION_REVOKED":
      return "Certification revoked";
    case "EVIDENCE_PURGED":
      return "Evidence purged";
    case "OTS_APPLIED":
      return "OpenTimestamps update";
    case "TECHNICAL_VERIFICATION_CHECKED":
      return "Technical verification checked";
    case "VERIFY_VIEWED":
      return "Verification page viewed";
    case "EVIDENCE_VIEWED":
      return "Evidence viewed";
    case "REPORT_DOWNLOADED":
      return "Report downloaded";
    case "VERIFICATION_PACKAGE_DOWNLOADED":
      return "Verification package downloaded";
    case "EVIDENCE_LOCKED":
      return "Evidence locked";
    case "EVIDENCE_ARCHIVED":
      return "Evidence archived";
    case "EVIDENCE_RESTORED":
      return "Evidence restored";
    case "ANCHOR_PUBLISHED":
      return "External anchor published";
    case "ANCHOR_FAILED":
      return "External anchor failed";
    default:
      return normalizeEnumText(eventType);
  }
}

function mapTimestampStatusPublicLabel(
  status: string | null | undefined
): string {
  switch (safe(status, "").toUpperCase()) {
    case "STAMPED":
    case "GRANTED":
    case "VERIFIED":
    case "SUCCEEDED":
      return "Trusted timestamp recorded";
    case "PENDING":
    case "UNAVAILABLE":
      return "Timestamp pending";
    case "FAILED":
      return "Timestamp failed";
    default:
      return "Timestamp not recorded";
  }
}

function mapOtsStatusPublicLabel(status: string | null | undefined): string {
  switch (safe(status, "").toUpperCase()) {
    case "ANCHORED":
      return "Public anchoring recorded";
    case "PENDING":
      return "Anchoring pending";
    case "FAILED":
      return "Anchoring failed";
    case "DISABLED":
      return "Anchoring disabled";
    default:
      return "Anchoring not recorded";
  }
}

function mapObjectLockModePublicLabel(mode: string | null | undefined): string {
  switch (safe(mode, "").toUpperCase()) {
    case "COMPLIANCE":
      return "Compliance retention lock";
    case "GOVERNANCE":
      return "Governance retention lock";
    default:
      return "Not recorded";
  }
}

function mapAnchorModePublicLabel(mode: string | null | undefined): string {
  switch (safe(mode, "").toUpperCase()) {
    case "ACTIVE":
      return "Active anchoring";
    case "READY":
      return "Anchor configured";
    case "OFF":
      return "Anchoring off";
    case "PUBLIC":
      return "Public anchoring";
    case "PRIVATE":
      return "Private anchoring";
    case "HASH_ONLY":
      return "Digest anchoring";
    default:
      return "Not recorded";
  }
}

function mapEvidenceAssetKindLabel(
  kind: ReportEvidenceAssetKind | null | undefined
): string {
  switch (kind) {
    case "image":
      return "Image";
    case "video":
      return "Video";
    case "audio":
      return "Audio";
    case "pdf":
      return "PDF";
    case "text":
      return "Text";
    case "other":
      return "Other";
    default:
      return "Not recorded";
  }
}

function buildOrganizationDisplay(evidence: ReportEvidence): string {
  const org = safe(evidence.organizationNameSnapshot, "");
  const workspace = safe(evidence.workspaceNameSnapshot, "");

  if (org) {
    return evidence.organizationVerifiedSnapshot ? `${org} (verified)` : org;
  }

  if (workspace) return workspace;
  return "Not recorded";
}

function buildOrganizationStatus(evidence: ReportEvidence): string {
  const hasOrg = safe(evidence.organizationNameSnapshot, "") !== "";
  const hasWorkspace = safe(evidence.workspaceNameSnapshot, "") !== "";

  if (evidence.organizationVerifiedSnapshot === true) {
    return "Verified organization";
  }
  if (hasOrg) return "Organization recorded";
  if (hasWorkspace) return "Workspace recorded";
  return "Not recorded";
}

function parseFingerprintSummary(
  fingerprintCanonicalJson: string | null | undefined
): ParsedFingerprintSummary {
  const fallback: ParsedFingerprintSummary = {
    multipart: false,
    itemCount: 1,
    imageCount: 0,
    videoCount: 0,
    audioCount: 0,
    documentCount: 0,
    mimeTypes: [],
    partsCount: 0,
  };

  if (!fingerprintCanonicalJson) return fallback;

  try {
    const parsed = JSON.parse(fingerprintCanonicalJson) as {
      file?: {
        multipart?: boolean;
        summary?: {
          itemCount?: number;
          imageCount?: number;
          videoCount?: number;
          audioCount?: number;
          documentCount?: number;
          mimeTypes?: string[];
        };
        parts?: Array<unknown>;
      };
    };

    const multipart = Boolean(parsed?.file?.multipart);
    const partsCount = Array.isArray(parsed?.file?.parts)
      ? parsed.file.parts.length
      : 0;
    const summary = parsed?.file?.summary;

    const itemCount =
      typeof summary?.itemCount === "number"
        ? summary.itemCount
        : multipart
          ? partsCount || 0
          : 1;

    return {
      multipart,
      itemCount,
      imageCount:
        typeof summary?.imageCount === "number" ? summary.imageCount : 0,
      videoCount:
        typeof summary?.videoCount === "number" ? summary.videoCount : 0,
      audioCount:
        typeof summary?.audioCount === "number" ? summary.audioCount : 0,
      documentCount:
        typeof summary?.documentCount === "number"
          ? summary.documentCount
          : 0,
      mimeTypes: Array.isArray(summary?.mimeTypes)
        ? summary.mimeTypes.filter(
            (v): v is string => typeof v === "string" && v.trim().length > 0
          )
        : [],
      partsCount,
    };
  } catch {
    return fallback;
  }
}

function buildFallbackContentSummary(
  evidence: ReportEvidence,
  parsed: ParsedFingerprintSummary
): ReportEvidenceContentSummary {
  const otherCount = Math.max(
    0,
    parsed.itemCount -
      (parsed.imageCount +
        parsed.videoCount +
        parsed.audioCount +
        parsed.documentCount)
  );

  return {
    structure: parsed.itemCount > 1 ? "multipart" : "single",
    itemCount: parsed.itemCount,
    previewableItemCount: 0,
    downloadableItemCount: parsed.itemCount > 0 ? parsed.itemCount : 0,
    imageCount: parsed.imageCount,
    videoCount: parsed.videoCount,
    audioCount: parsed.audioCount,
    pdfCount: parsed.documentCount,
    textCount: 0,
    otherCount,
    primaryKind: null,
    primaryMimeType: evidence.mimeType ?? null,
    totalSizeBytes: evidence.sizeBytes ?? null,
    totalSizeDisplay: formatBytesHuman(evidence.sizeBytes ?? null),
  };
}

function resolveContentSummary(
  evidence: ReportEvidence,
  parsed: ParsedFingerprintSummary
): ReportEvidenceContentSummary {
  return evidence.contentSummary ?? buildFallbackContentSummary(evidence, parsed);
}

function resolveContentItems(evidence: ReportEvidence): ReportEvidenceAsset[] {
  const items = Array.isArray(evidence.contentItems) ? evidence.contentItems : [];

  const embeddedPreviewMap = new Map<
    string,
    {
      previewDataUrl?: string | null;
      previewTextExcerpt?: string | null;
      previewCaption?: string | null;
    }
  >();

  const embedded = (evidence as ReportEvidence & {
    embeddedPreviewsSnapshot?: Array<{
      id: string;
      previewDataUrl?: string | null;
      previewTextExcerpt?: string | null;
      previewCaption?: string | null;
    }> | null;
  }).embeddedPreviewsSnapshot;

  if (Array.isArray(embedded)) {
    for (const item of embedded) {
      if (item?.id) {
        embeddedPreviewMap.set(item.id, {
          previewDataUrl: item.previewDataUrl ?? null,
          previewTextExcerpt: item.previewTextExcerpt ?? null,
          previewCaption: item.previewCaption ?? null,
        });
      }
    }
  }

  return items.map((item) => {
    const preview = embeddedPreviewMap.get(item.id);
    if (!preview) return item;
    return {
      ...item,
      previewDataUrl: item.previewDataUrl ?? preview.previewDataUrl ?? null,
      previewTextExcerpt:
        item.previewTextExcerpt ?? preview.previewTextExcerpt ?? null,
      previewCaption: item.previewCaption ?? preview.previewCaption ?? null,
    };
  });
}

function resolvePrimaryContentItem(
  evidence: ReportEvidence
): ReportEvidenceAsset | null {
  const items = resolveContentItems(evidence);

  if (evidence.defaultPreviewItemId) {
    const previewItem = items.find(
      (item) => item.id === evidence.defaultPreviewItemId
    );
    if (previewItem) return previewItem;
  }

  if (evidence.primaryContentItem) return evidence.primaryContentItem;

  return items.find((item) => item.isPrimary) ?? items[0] ?? null;
}

function evidenceStructureLabel(summary: ReportEvidenceContentSummary): string {
  if (summary.itemCount <= 1) return "Single evidence item";
  return "Multipart evidence package";
}

function resolveDisplayDescriptor(
  evidence: ReportEvidence,
  contentSummary: ReportEvidenceContentSummary
): ReportEvidenceDisplayDescriptor {
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

function resolveLegalLimitations(
  evidence: ReportEvidence
): ReportLegalLimitations {
  return (
    evidence.limitations ?? {
      short:
        "This report verifies the recorded integrity state of the evidence record. It does not independently prove factual truth, authorship, context, or legal admissibility.",
      detailed:
        "Technical verification supports detection of post-completion changes to the recorded evidence state. It does not by itself establish who created the content, whether the depicted events are true, or whether any court, insurer, regulator, employer, or authority must accept the material. Admissibility, evidentiary weight, authenticity disputes, and procedural acceptance remain matters for the competent decision-maker under applicable law.",
    }
  );
}

function resolveAnchorSummary(
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

function buildMismatchNarrative(params: {
  evidence: ReportEvidence;
  integrityVerified: boolean;
  custody: ReturnType<typeof splitCustodyEvents>;
}): { title: string; body: string; tone: "success" | "warning" | "danger" } {
  const issues: string[] = [];

  if (!params.integrityVerified) {
    issues.push(
      "Recorded integrity did not reach a verified state and should be reviewed manually."
    );
  }

  if (safe(params.evidence.tsaStatus, "").toUpperCase() === "FAILED") {
    issues.push(
      `Trusted timestamp processing reported a failure${
        params.evidence.tsaFailureReason
          ? `: ${params.evidence.tsaFailureReason}`
          : "."
      }`
    );
  }

  if (safe(params.evidence.otsStatus, "").toUpperCase() === "FAILED") {
    issues.push(
      `OpenTimestamps processing reported a failure${
        params.evidence.otsFailureReason
          ? `: ${params.evidence.otsFailureReason}`
          : "."
      }`
    );
  }

  if (params.custody.forensic.length === 0) {
    issues.push("No forensic custody events were included in this report payload.");
  }

  if (issues.length === 0) {
    return {
      title: "Mismatch detection",
      body:
        "No explicit integrity, timestamping, OpenTimestamps, or custody mismatch signals were recorded in this report payload. Reviewers should still evaluate legal context and evidentiary relevance separately.",
      tone: "success",
    };
  }

  return {
    title: "Mismatch detection",
    body: issues.join(" "),
    tone: issues.length > 1 ? "danger" : "warning",
  };
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

function buildFingerprintNarrative(
  parsedSummary: ParsedFingerprintSummary,
  contentSummary: ReportEvidenceContentSummary
): string {
  const mimeText =
    parsedSummary.mimeTypes.length > 0
      ? parsedSummary.mimeTypes.join(", ")
      : safe(contentSummary.primaryMimeType, "not recorded");

  if (contentSummary.itemCount <= 1) {
    return `Single-item evidence record represented by a canonical fingerprint and recorded MIME metadata. MIME types recorded: ${mimeText}.`;
  }

  return `Multipart evidence package with ${contentSummary.itemCount} items (${contentSummary.imageCount} image, ${contentSummary.videoCount} video, ${contentSummary.audioCount} audio, ${contentSummary.pdfCount + contentSummary.textCount} document/text, ${contentSummary.otherCount} other). The package is represented by a canonical fingerprint describing structure, metadata, and recorded integrity values. MIME types recorded: ${mimeText}. Full canonical fingerprint should be reviewed in the technical verification package.`;
}

function buildVerificationLinkLabel(
  kind: "public" | "technical" = "public"
): string {
  return kind === "technical"
    ? "Open technical verification view"
    : "Open public verification page";
}

function normalizeTimestampStatus(
  status: string | null | undefined
): "SUCCESS" | "WARNING" | "DANGER" | "NEUTRAL" {
  const s = safe(status, "").toUpperCase();
  if (
    s === "GRANTED" ||
    s === "STAMPED" ||
    s === "VERIFIED" ||
    s === "SUCCEEDED"
  ) {
    return "SUCCESS";
  }
  if (s === "PENDING" || s === "UNAVAILABLE") {
    return "WARNING";
  }
  if (s) return "DANGER";
  return "NEUTRAL";
}

function normalizeOtsStatus(
  status: string | null | undefined
): "SUCCESS" | "WARNING" | "DANGER" | "NEUTRAL" {
  const s = safe(status, "").toUpperCase();
  if (s === "ANCHORED") return "SUCCESS";
  if (s === "PENDING") return "WARNING";
  if (s === "FAILED") return "DANGER";
  return "NEUTRAL";
}

function normalizeStorageProtectionStatus(
  immutable: boolean | null | undefined,
  mode: string | null | undefined,
  retainUntil: string | null | undefined
): "SUCCESS" | "WARNING" | "DANGER" | "NEUTRAL" {
  const normalizedMode = safe(mode, "").toUpperCase();

  if (
    immutable &&
    normalizedMode === "COMPLIANCE" &&
    safe(retainUntil, "") !== ""
  ) {
    return "SUCCESS";
  }
  if (immutable || normalizedMode === "GOVERNANCE") {
    return "WARNING";
  }
  if (normalizedMode) {
    return "DANGER";
  }
  return "NEUTRAL";
}

function classifyCustodyEvent(event: ReportCustodyEvent): ClassifiedCustodyEvent {
  return {
    ...event,
    category: isAccessCustodyEventType(event.eventType)
      ? "access"
      : "forensic",
  };
}

function splitCustodyEvents(events: ReportCustodyEvent[]) {
  const classified = events.map(classifyCustodyEvent);
  return {
    all: classified,
    forensic: classified.filter((ev) => ev.category === "forensic"),
    access: classified.filter((ev) => ev.category === "access"),
  };
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ASSETS_CANDIDATES: string[] = [
  path.resolve(__dirname, "assets"),
  path.resolve(__dirname, "../pdf/assets"),
  path.resolve(__dirname, "../assets"),
  path.resolve(process.cwd(), "src/pdf/assets"),
  path.resolve(process.cwd(), "services/worker/src/pdf/assets"),
];

function tryReadAsset(filename: string): Buffer | null {
  for (const dir of ASSETS_CANDIDATES) {
    try {
      const p = path.join(dir, filename);
      if (!fs.existsSync(p)) continue;
      return fs.readFileSync(p);
    } catch {
      // continue
    }
  }
  return null;
}

const BRAND = {
  name: env("REPORT_BRAND_NAME") ?? "PROOVRA",
  title: "Verification Report",

  ink: "#111827",
  muted: "#667085",
  line: "#D0D5DD",
  accent: "#1F3A5F",
  accentSoft: "#EAF1F8",
  paper: "#F8FAFC",

  success: "#245C4A",
  danger: "#8A3B2E",
  warning: "#8B6C1E",
};

let currentHeaderContext: HeaderContext | null = null;

function setHeaderContext(opts: HeaderContext): void {
  currentHeaderContext = opts;
}

function hr(doc: PDFDoc, y?: number): void {
  const x = doc.page.margins.left;
  const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const yy = typeof y === "number" ? y : doc.y;

  doc.save();
  doc.lineWidth(0.9).strokeColor(BRAND.line);
  doc.moveTo(x, yy).lineTo(x + w, yy).stroke();
  doc.restore();
}

function addPageWithHeader(doc: PDFDoc): void {
  doc.addPage();
  if (currentHeaderContext) {
    drawHeader(doc, currentHeaderContext);
  }
}

function ensureSpace(doc: PDFDoc, neededHeight: number): void {
  const bottom = doc.page.height - doc.page.margins.bottom - 10;
  if (doc.y + neededHeight > bottom) {
    addPageWithHeader(doc);
  }
}

function ensurePageWithHeader(
  doc: PDFDoc,
  neededHeight: number,
  opts?: HeaderContext
): void {
  if (opts) {
    setHeaderContext(opts);
  }

  const bottom = doc.page.height - doc.page.margins.bottom - 10;
  if (doc.y + neededHeight > bottom) {
    addPageWithHeader(doc);
  }
}

function paintPageBackground(doc: PDFDoc): void {
  const bg = tryReadAsset("paper-silver.png");
  const pageW = doc.page.width;
  const pageH = doc.page.height;

  doc.save();
  doc.rect(0, 0, pageW, pageH).fill(BRAND.paper);

  if (bg) {
    try {
      doc.opacity(0.16);
      doc.image(bg, 0, 0, { width: pageW, height: pageH });
      doc.opacity(1);
    } catch {
      doc.opacity(1);
    }
  }

  const wm = tryReadAsset("logo.png");
  if (wm) {
    try {
      doc.opacity(0.045);
      const size = Math.min(pageW, pageH) * 0.6;
      const x = (pageW - size) / 2;
      const y = (pageH - size) / 2 - mmToPt(6);
      doc.image(wm, x, y, { fit: [size, size] });
      doc.opacity(1);
    } catch {
      doc.opacity(1);
    }
  }

  const seal = tryReadAsset("seal.png");
  if (seal) {
    try {
      doc.opacity(0.16);
      const size = mmToPt(44);
      const x = pageW - doc.page.margins.right - size + mmToPt(2);
      const y = doc.page.margins.top - mmToPt(1.5);
      doc.image(seal, x, y, { fit: [size, size] });
      doc.opacity(1);
    } catch {
      doc.opacity(1);
    }
  }

  doc.restore();
}

function drawBadge(doc: PDFDoc, text: string, x: number, y: number): void {
  const padX = 11;
  const padY = 4;

  doc.save();
  doc.font("Helvetica-Bold").fontSize(9);

  const tw = doc.widthOfString(text);
  const th = doc.currentLineHeight();

  doc.fillColor(BRAND.accentSoft);
  doc.roundedRect(x, y, tw + padX * 2, th + padY * 2, 7).fill();

  doc.fillColor(BRAND.accent);
  doc.text(text, x + padX, y + padY, { lineBreak: false });
  doc.restore();
}

function drawCallout(
  doc: PDFDoc,
  opts: {
    title: string;
    body: string;
    tone?: "neutral" | "success" | "warning" | "danger";
  }
): void {
  const x = doc.page.margins.left;
  const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  const tone = opts.tone ?? "neutral";
  const borderColor =
    tone === "success"
      ? BRAND.success
      : tone === "warning"
        ? BRAND.warning
        : tone === "danger"
          ? BRAND.danger
          : BRAND.accent;

  const fillColor =
    tone === "success"
      ? "#EEF8F3"
      : tone === "warning"
        ? "#FBF5E8"
        : tone === "danger"
          ? "#FCEDEA"
          : BRAND.accentSoft;

  doc.font("Helvetica-Bold").fontSize(10.2);
  const titleHeight = doc.heightOfString(opts.title, { width: w - 24 });

  doc.font("Helvetica").fontSize(9.3);
  const bodyHeight = doc.heightOfString(opts.body, {
    width: w - 24,
    lineGap: 1.5,
  });

  const blockHeight = titleHeight + bodyHeight + 18;
  ensureSpace(doc, blockHeight + 6);

  const y = doc.y;

  doc.save();
  doc.roundedRect(x, y, w, blockHeight, 9).fill(fillColor);
  doc
    .lineWidth(0.9)
    .strokeColor(borderColor)
    .roundedRect(x, y, w, blockHeight, 9)
    .stroke();
  doc.restore();

  doc.save();
  doc.fillColor(BRAND.ink).font("Helvetica-Bold").fontSize(10.2);
  doc.text(opts.title, x + 12, y + 8, { width: w - 24 });
  doc.restore();

  doc.save();
  doc.fillColor(BRAND.ink).font("Helvetica").fontSize(9.3);
  doc.text(opts.body, x + 12, y + 23, { width: w - 24, lineGap: 1.5 });
  doc.restore();

  doc.y = y + blockHeight + 6;
}

function drawInfoCards(
  doc: PDFDoc,
  cards: Array<{
    label: string;
    value: string;
    tone?: "neutral" | "success" | "warning" | "danger";
  }>
): void {
  if (cards.length === 0) return;

  const x = doc.page.margins.left;
  const totalW = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const gap = 10;
  const columns = 2;
  const cardW = (totalW - gap) / columns;

  let cursorX = x;
  let rowY = doc.y;
  let rowMaxHeight = 0;

  const estimateCardHeight = (card: { label: string; value: string }) => {
    doc.font("Helvetica-Bold").fontSize(9.3);
    const labelHeight = doc.heightOfString(card.label, { width: cardW - 24 });
    doc.font("Helvetica-Bold").fontSize(14.5);
    const valueHeight = doc.heightOfString(card.value, {
      width: cardW - 24,
      lineGap: 1.5,
    });
    return labelHeight + valueHeight + 28;
  };

  const estimatedHeights = cards.map(estimateCardHeight);
  const firstRowMax = Math.max(...estimatedHeights.slice(0, columns), 84);
  const secondRowMax =
    cards.length > columns ? Math.max(...estimatedHeights.slice(columns), 84) : 0;
  ensureSpace(doc, firstRowMax + (secondRowMax ? secondRowMax + gap : 0) + 8);

  cards.forEach((card, index) => {
    if (index > 0 && index % columns === 0) {
      cursorX = x;
      rowY += rowMaxHeight + gap;
      rowMaxHeight = 0;
    }

    const tone = card.tone ?? "neutral";
    const fill =
      tone === "success"
        ? "#EEF8F3"
        : tone === "warning"
          ? "#FFFAEB"
          : tone === "danger"
            ? "#FEF3F2"
            : "#FFFFFF";
    const border =
      tone === "success"
        ? BRAND.success
        : tone === "warning"
          ? BRAND.warning
          : tone === "danger"
            ? BRAND.danger
            : BRAND.line;

    doc.font("Helvetica-Bold").fontSize(9.3);
    const labelHeight = doc.heightOfString(card.label, { width: cardW - 24 });
    doc.font("Helvetica-Bold").fontSize(14.5);
    const valueHeight = doc.heightOfString(card.value, {
      width: cardW - 24,
      lineGap: 1.5,
    });
    const cardH = Math.max(84, labelHeight + valueHeight + 28);
    rowMaxHeight = Math.max(rowMaxHeight, cardH);

    doc.save();
    doc.roundedRect(cursorX, rowY, cardW, cardH, 12).fill(fill);
    doc
      .lineWidth(0.9)
      .strokeColor(border)
      .roundedRect(cursorX, rowY, cardW, cardH, 12)
      .stroke();
    doc.restore();

    doc.save();
    doc.fillColor(BRAND.muted).font("Helvetica-Bold").fontSize(9.3);
    doc.text(card.label, cursorX + 12, rowY + 10, {
      width: cardW - 24,
      lineGap: 1.2,
    });
    doc.restore();

    doc.save();
    doc.fillColor(BRAND.ink).font("Helvetica-Bold").fontSize(14.5);
    doc.text(card.value, cursorX + 12, rowY + 28, {
      width: cardW - 24,
      lineGap: 1.5,
    });
    doc.restore();

    cursorX += cardW + gap;
  });

  doc.y = rowY + rowMaxHeight + 6;
}

function drawHeader(
  doc: PDFDoc,
  opts: { evidenceId: string; generatedAtUtc: string; status?: string }
): void {
  const left = doc.page.margins.left;
  const top = doc.page.margins.top;
  const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  doc.save();
  doc.rect(0, 0, doc.page.width, mmToPt(3)).fill(BRAND.accent);
  doc.restore();

  doc.x = left;
  doc.y = top;

  const logo = tryReadAsset("logo.png");
  let brandX = left;

  if (logo) {
    try {
      const h = mmToPt(14);
      const logoW = h * 4.6;
      doc.image(logo, left, doc.y - 2, { fit: [logoW, h] });
      brandX = left + logoW + 13;
    } catch {
      brandX = left;
    }
  }

  doc.fillColor(BRAND.ink).font("Helvetica-Bold").fontSize(20.5);
  doc.text(BRAND.name, brandX, doc.y + 1, { continued: true });

  doc.fillColor(BRAND.muted).font("Helvetica").fontSize(12.2);
  doc.text(` — ${BRAND.title}`);

  const badgeText = safe(opts.status, "").toUpperCase();
  if (badgeText) {
    const bx = left + w - 140;
    const by = top + 15;
    drawBadge(doc, textClamp(badgeText, 20), bx, by);
  }

  doc.moveDown(0.72);

  const metaW = w - 168;
  doc.fillColor(BRAND.muted).font("Helvetica").fontSize(10);
  doc.text(
    `Evidence Reference: ${buildPublicEvidenceReference(opts.evidenceId)}`,
    left,
    doc.y,
    { width: metaW }
  );
  doc.moveDown(0.18);
  doc.text(`Generated (UTC): ${opts.generatedAtUtc}`, left, doc.y, {
    width: metaW,
  });

  doc.moveDown(0.52);
  hr(doc);
  doc.moveDown(0.5);
}

function textClamp(text: string, maxChars: number): string {
  return text.length > maxChars
    ? `${text.slice(0, Math.max(0, maxChars - 1))}…`
    : text;
}

function section(
  doc: PDFDoc,
  title: string,
  render: () => void,
  options?: { minSpace?: number }
): void {
  const minSpace = options?.minSpace ?? 52;

  ensureSpace(doc, minSpace);

  hr(doc);
  doc.moveDown(0.2);

  doc.save();
  doc.fillColor(BRAND.ink).font("Helvetica-Bold").fontSize(12.5);
  doc.text(title, doc.page.margins.left, doc.y);
  doc.restore();

  doc.moveDown(0.12);
  render();
  doc.moveDown(0.2);
}

function safeParagraph(
  doc: PDFDoc,
  text: string,
  options?: { fontSize?: number; color?: string; gap?: number }
): void {
  const x = doc.page.margins.left;
  const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const fontSize = options?.fontSize ?? 9;
  const gap = options?.gap ?? 1.8;

  doc.font("Helvetica").fontSize(fontSize);
  const needed = doc.heightOfString(text, { width: w, lineGap: gap }) + 5;
  ensureSpace(doc, needed);

  doc.save();
  doc.fillColor(options?.color ?? BRAND.muted);
  doc.text(text, x, doc.y, { width: w, lineGap: gap });
  doc.restore();
}

function prettifySummaryText(input: string): string {
  const raw = safe(input, "");
  if (!raw || raw === "N/A") return "N/A";

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const parts = Object.entries(parsed).map(([k, v]) => {
      if (v === null || v === undefined) return `${k}: N/A`;
      if (typeof v === "object") return `${k}: ${JSON.stringify(v)}`;
      return `${k}: ${String(v)}`;
    });
    return parts.join(" • ");
  } catch {
    return raw
      .replace(/^\{/, "")
      .replace(/\}$/, "")
      .replace(/","/g, " • ")
      .replace(/":"/g, ": ")
      .replace(/"/g, "");
  }
}

function kvGrid(
  doc: PDFDoc,
  rows: Array<[string, string]>,
  options?: { colGap?: number }
): void {
  const x = doc.page.margins.left;
  const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const colGap = options?.colGap ?? 16;
  const colW = (w - colGap) / 2;

  const calcCellHeight = (row?: [string, string]): number => {
    if (!row) return 0;
    const [k, v] = row;

    doc.font("Helvetica").fontSize(8.7);
    const keyH = doc.heightOfString(k, { width: colW });

    doc.font("Helvetica-Bold").fontSize(9.8);
    const valueH = doc.heightOfString(v, { width: colW });

    return keyH + valueH + 14;
  };

  const pairHeights: number[] = [];
  for (let i = 0; i < rows.length; i += 2) {
    pairHeights.push(
      Math.max(calcCellHeight(rows[i]), calcCellHeight(rows[i + 1]))
    );
  }

  const totalNeeded = pairHeights.reduce((a, b) => a + b, 0) + 4;
  ensureSpace(doc, totalNeeded);

  let currentY = doc.y;

  for (let i = 0; i < rows.length; i += 2) {
    const left = rows[i];
    const right = rows[i + 1];
    const rowHeight = pairHeights[i / 2];

    const renderCell = (row: [string, string] | undefined, colX: number) => {
      if (!row) return;
      const [k, v] = row;
      let y = currentY;

      doc.save();
      doc.fillColor(BRAND.muted).font("Helvetica").fontSize(8.7);
      doc.text(k, colX, y, { width: colW });
      doc.restore();

      y = doc.y + 1.5;

      doc.save();
      doc.fillColor(BRAND.ink).font("Helvetica-Bold").fontSize(9.8);
      doc.text(v, colX, y, { width: colW });
      doc.restore();
    };

    renderCell(left, x);
    renderCell(right, x + colW + colGap);

    currentY += rowHeight;
    doc.y = currentY;
  }
}

function monospaceStrip(
  doc: PDFDoc,
  label: string,
  value: string,
  options?: { maxChars?: number }
): void {
  const x = doc.page.margins.left;
  const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  const maxChars = options?.maxChars;
  const finalValue =
    typeof maxChars === "number" ? summarizeText(value, maxChars) : value;

  const labelFontSize = 8.8;
  const codeFontSize = 8.8;
  const labelGapAfter = 5;
  const bottomPadding = 10;

  doc.font("Helvetica").fontSize(labelFontSize);
  const labelHeight = doc.heightOfString(label, { width: w });

  doc.font("Courier").fontSize(codeFontSize);
  const textHeight = doc.heightOfString(finalValue, {
    width: w,
    lineGap: 1.5,
  });
  const blockHeight = Math.max(16, textHeight + 8);

  const neededHeight =
    labelHeight + labelGapAfter + blockHeight + bottomPadding;
  ensureSpace(doc, neededHeight);

  const labelY = doc.y;

  doc.save();
  doc.fillColor(BRAND.muted).font("Helvetica").fontSize(labelFontSize);
  doc.text(label, x, labelY, { width: w });
  doc.restore();

  const blockY = doc.y + 3;

  doc.save();
  doc.opacity(0.045);
  doc.roundedRect(x - 3, blockY - 3, w + 6, blockHeight + 6, 7).fill(BRAND.ink);
  doc.opacity(1);
  doc.restore();

  doc.save();
  doc.fillColor(BRAND.ink).font("Courier").fontSize(codeFontSize);
  doc.text(finalValue, x, blockY, {
    width: w,
    lineGap: 1.5,
  });
  doc.restore();

  doc.y = blockY + blockHeight;
  doc.moveDown(0.22);
}

function drawTable(
  doc: PDFDoc,
  headers: string[],
  rows: string[][],
  colWidths: number[]
): void {
  const x = doc.page.margins.left;
  const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  const headerH = 20;
  const rowPadY = 5;

  const calcRowHeight = (cells: string[]): number => {
    doc.font("Helvetica").fontSize(8.9);
    let maxH = 0;

    for (let i = 0; i < cells.length; i++) {
      const cw = colWidths[i];
      const h = doc.heightOfString(cells[i], {
        width: cw - 10,
        align: "left",
        lineGap: 1.5,
      });
      maxH = Math.max(maxH, h);
    }

    return Math.max(headerH, maxH + rowPadY * 2);
  };

  ensureSpace(doc, 120);

  const headerY = doc.y;

  doc.save();
  doc.opacity(0.06);
  doc.roundedRect(x, headerY, w, headerH, 5).fill(BRAND.accent);
  doc.opacity(1);
  doc.restore();

  doc.save();
  doc.fillColor(BRAND.ink).font("Helvetica-Bold").fontSize(8.8);

  let cx = x;
  for (let i = 0; i < headers.length; i++) {
    doc.text(headers[i], cx + 5, headerY + 5.5, {
      width: colWidths[i] - 10,
      lineBreak: false,
    });
    cx += colWidths[i];
  }
  doc.restore();

  doc.y = headerY + headerH;
  hr(doc, doc.y);
  doc.moveDown(0.08);

  for (const r of rows) {
    const prettyRow = [...r];
    if (prettyRow[3]) {
      prettyRow[3] = prettifySummaryText(prettyRow[3]);
    }

    const rh = calcRowHeight(prettyRow);
    ensureSpace(doc, rh + 10);

    const rowY = doc.y;

    doc.save();
    doc.fillColor(BRAND.ink).font("Helvetica").fontSize(8.9);

    let rx = x;
    for (let i = 0; i < prettyRow.length; i++) {
      doc.text(prettyRow[i], rx + 5, rowY + rowPadY, {
        width: colWidths[i] - 10,
        lineGap: 1.5,
      });
      rx += colWidths[i];
    }
    doc.restore();

    doc.y = rowY + rh;
    hr(doc, doc.y);
    doc.moveDown(0.08);
  }
}

function drawQrBlock(
  doc: PDFDoc,
  opts: {
    title: string;
    qrBuffer: Buffer;
    size?: number;
    caption?: string;
    urlText?: string;
    urlLink?: string;
  }
): void {
  const x = doc.page.margins.left;
  const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const size = opts.size ?? 96;

  ensureSpace(doc, size + 60);

  const startY = doc.y;
  const blockH = Math.max(size + 16, 118);
  const textX = x + 14;
  const textW = w - size - 44;
  const qrX = x + w - size - 14;
  const qrY = startY + 11;

  doc.save();
  doc.opacity(0.035);
  doc.roundedRect(x, startY, w, blockH, 10).fill(BRAND.ink);
  doc.opacity(1);
  doc.restore();

  doc.save();
  doc.lineWidth(0.8).strokeColor(BRAND.line);
  doc.roundedRect(x, startY, w, blockH, 10).stroke();
  doc.restore();

  doc.save();
  doc.fillColor(BRAND.ink).font("Helvetica-Bold").fontSize(10);
  doc.text(opts.title, textX, startY + 12, { width: textW });
  doc.restore();

  let textY = startY + 30;

  if (opts.caption) {
    doc.save();
    doc.fillColor(BRAND.muted).font("Helvetica").fontSize(9.1);
    doc.text(opts.caption, textX, textY, {
      width: textW,
      lineGap: 1.5,
    });
    doc.restore();
    textY = doc.y + 5;
  }

  if (opts.urlText) {
    doc.save();
    doc.fillColor(BRAND.accent).font("Helvetica").fontSize(8.3);
    doc.text(opts.urlText, textX, textY, {
      width: textW,
      link: opts.urlLink,
      underline: Boolean(opts.urlLink),
      lineGap: 1.5,
    });
    doc.restore();
  }

  doc.image(opts.qrBuffer, qrX, qrY, { fit: [size, size] });

  doc.save();
  doc.fillColor(BRAND.muted).font("Helvetica").fontSize(7.7);
  doc.text("Scan QR", qrX, startY + blockH - 13, {
    width: size,
    align: "center",
    lineBreak: false,
  });
  doc.restore();

  doc.y = startY + blockH + 6;
}

async function tryGenerateQrPngBuffer(data: string): Promise<Buffer | null> {
  try {
    const QRCodeModule = (await import("qrcode")) as {
      toBuffer?: (
        text: string,
        opts?: Record<string, unknown>
      ) => Promise<Buffer>;
      default?: {
        toBuffer?: (
          text: string,
          opts?: Record<string, unknown>
        ) => Promise<Buffer>;
      };
    };

    const toBuffer = QRCodeModule.toBuffer ?? QRCodeModule.default?.toBuffer;

    if (!toBuffer) {
      throw new Error("qrcode.toBuffer not found");
    }

    return await toBuffer(data, {
      margin: 1,
      width: 240,
    });
  } catch (error) {
    console.error("[PDF][QR] Failed to generate QR:", error);
    return null;
  }
}

function addFooters(
  doc: PDFDoc,
  opts: { generatedAtUtc: string; reportVersion: number }
): void {
  const range = doc.bufferedPageRange();

  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);

    const x = doc.page.margins.left;
    const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const y = doc.page.height - doc.page.margins.bottom - 20;

    doc.save();
    doc.font("Helvetica").fontSize(8.6).fillColor(BRAND.muted);

    doc.text(
      `${BRAND.name} • Verification Report v${opts.reportVersion} • Generated (UTC): ${opts.generatedAtUtc}`,
      x,
      y,
      { width: w, align: "left" }
    );
    doc.text(`Page ${i + 1} / ${range.count}`, x, y, {
      width: w,
      align: "right",
    });

    doc.restore();
  }
}

function buildVerifyUrl(evidenceId: string, provided?: string | null): string {
  const v = typeof provided === "string" ? provided.trim() : "";
  if (v) return v;

  const base = (
    env("REPORT_VERIFY_BASE_URL") ?? "https://app.proovra.com/verify"
  )
    .trim()
    .replace(/\/+$/, "");

  return `${base}/${encodeURIComponent(evidenceId)}`;
}

function estimateEvidenceSummarySectionHeight(
  doc: PDFDoc,
  rows: Array<[string, string]>
): number {
  const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const colGap = 16;
  const colW = (w - colGap) / 2;

  const calcCellHeight = (row?: [string, string]): number => {
    if (!row) return 0;
    const [k, v] = row;

    doc.font("Helvetica").fontSize(8.7);
    const keyH = doc.heightOfString(k, { width: colW });

    doc.font("Helvetica-Bold").fontSize(9.8);
    const valueH = doc.heightOfString(v, { width: colW });

    return keyH + valueH + 14;
  };

  let gridHeight = 0;
  for (let i = 0; i < rows.length; i += 2) {
    gridHeight += Math.max(calcCellHeight(rows[i]), calcCellHeight(rows[i + 1]));
  }

  return 18 + 10 + gridHeight + 12;
}

function estimateForensicIntegrityStatementHeight(
  doc: PDFDoc,
  opts: {
    verifyUrl: string;
    structureLabel: string;
    externalMode?: boolean;
  }
): number {
  const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  doc.font("Helvetica").fontSize(10.2);
  const intro1 = doc.heightOfString(
    "This report was generated by the PROOVRA Digital Evidence Integrity System.",
    { width: w, lineGap: 1.8 }
  );

  doc.font("Helvetica").fontSize(9.8);
  const intro2 = doc.heightOfString(
    "PROOVRA applies cryptographic integrity controls, structured evidence fingerprinting, trusted timestamping records, OpenTimestamps anchoring evidence, and immutable storage protection designed to preserve the integrity state of the submitted evidence at the time of completion.",
    { width: w, lineGap: 1.8 }
  );

  doc.font("Helvetica-Bold").fontSize(10.1);
  const h1 = doc.heightOfString("Integrity materials included in this report:", {
    width: w,
  });
  const h2 = doc.heightOfString("Independent review may include:", {
    width: w,
  });

  doc.font("Helvetica").fontSize(9.8);
  const bullets = [
    opts.structureLabel === "Single evidence item"
      ? "• A SHA-256 cryptographic hash of the original evidence file"
      : "• A SHA-256 cryptographic hash representing the multipart evidence set",
    "• A canonical fingerprint record describing the evidence state and metadata",
    "• A fingerprint hash derived from the canonical record",
    "• A digital signature generated using the PROOVRA signing key",
    "• A trusted RFC 3161 timestamp token issued by the configured Time Stamping Authority, when available",
    "• OpenTimestamps anchoring evidence for the evidence digest, when available",
    "• A forensic chain of custody timeline documenting relevant integrity-related system events",
    "• Immutable storage controls using AWS S3 Object Lock, when enabled for the evidence object",
  ];

  const steps =
    opts.structureLabel === "Single evidence item"
      ? [
          "1. Obtaining the original evidence file",
          "2. Computing the SHA-256 hash of the evidence file",
          "3. Comparing the computed hash with the value listed in this report",
          "4. Verifying the digital signature using the provided public key",
          "5. Verifying the RFC 3161 timestamp token, when present",
          "6. Verifying the OpenTimestamps proof, when present",
          "7. Reviewing the forensic chain of custody events",
          "8. Reviewing immutable storage protection details, when present",
        ]
      : [
          "1. Obtaining the complete multipart evidence set",
          "2. Reviewing the canonical fingerprint and listed evidence parts",
          "3. Validating the multipart composite hash against the hashes and structure recorded in the canonical fingerprint",
          "4. Verifying the digital signature using the provided public key",
          "5. Verifying the RFC 3161 timestamp token, when present",
          "6. Verifying the OpenTimestamps proof, when present",
          "7. Reviewing the forensic chain of custody events",
          "8. Reviewing immutable storage protection details, when present",
        ];

  const bulletsHeight = bullets.reduce(
    (sum, item) => sum + doc.heightOfString(item, { width: w, lineGap: 1.8 }),
    0
  );

  const stepsHeight = steps.reduce(
    (sum, item) => sum + doc.heightOfString(item, { width: w, lineGap: 1.8 }),
    0
  );

  doc.font("Helvetica").fontSize(9.2);
  const note = doc.heightOfString(
    "Where present, the RFC 3161 timestamp provides evidence that the signed integrity state existed at or before the issuance time recorded by the Time Stamping Authority. Where present, OpenTimestamps provides additional independent public anchoring evidence linked to the recorded evidence digest.",
    { width: w, lineGap: 1.8 }
  );

  doc.font("Helvetica-Bold").fontSize(10.2);
  const legalTitle = doc.heightOfString("Legal Notice", { width: w - 24 });

  doc.font("Helvetica").fontSize(9.3);
  const legalBody = doc.heightOfString(
    "Cryptographic verification confirms integrity of the recorded evidence state only. It does not independently establish authorship, factual accuracy, legal admissibility, context, or probative weight. These issues remain subject to judicial, administrative, or expert evaluation under the applicable law and procedure.",
    { width: w - 24, lineGap: 1.5 }
  );
  const legalBlock = legalTitle + legalBody + 24;

  const externalMode = opts.externalMode !== false;
  const linkLabelText = externalMode
    ? "Public verification page:"
    : "Verification link:";
  const linkBodyText = externalMode
    ? "Open public verification page"
    : opts.verifyUrl;

  doc.font("Helvetica-Bold").fontSize(9.2);
  const linkLabel = doc.heightOfString(linkLabelText, { width: w });

  doc.font("Helvetica").fontSize(8.8);
  const link = doc.heightOfString(linkBodyText, {
    width: w,
    lineGap: 1.5,
  });

  return (
    28 +
    intro1 +
    intro2 +
    h1 +
    bulletsHeight +
    h2 +
    stepsHeight +
    note +
    legalBlock +
    linkLabel +
    link
  );
}

function renderForensicIntegrityStatement(
  doc: PDFDoc,
  opts: {
    verifyUrl: string;
    structureLabel: string;
    externalMode?: boolean;
  }
): void {
  const x = doc.page.margins.left;
  const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  safeParagraph(
    doc,
    "This report was generated by the PROOVRA Digital Evidence Integrity System.",
    { fontSize: 10.2, color: BRAND.ink }
  );
  doc.moveDown(0.15);

  safeParagraph(
    doc,
    "PROOVRA applies cryptographic integrity controls, structured evidence fingerprinting, trusted timestamping records, OpenTimestamps anchoring evidence, and immutable storage protection designed to preserve the integrity state of the submitted evidence at the time of completion.",
    { fontSize: 9.8, color: BRAND.ink }
  );
  doc.moveDown(0.18);

  doc.save();
  doc.fillColor(BRAND.accent).font("Helvetica-Bold").fontSize(10.1);
  doc.text("Integrity materials included in this report:", x, doc.y, { width: w });
  doc.restore();
  doc.moveDown(0.12);

  const bullets = [
    opts.structureLabel === "Single evidence item"
      ? "A SHA-256 cryptographic hash of the original evidence file"
      : "A SHA-256 cryptographic hash representing the multipart evidence set",
    "A canonical fingerprint record describing the evidence state and metadata",
    "A fingerprint hash derived from the canonical record",
    "A digital signature generated using the PROOVRA signing key",
    "A trusted RFC 3161 timestamp token issued by the configured Time Stamping Authority, when available",
    "OpenTimestamps anchoring evidence, when available",
    "A forensic custody timeline documenting relevant integrity-related system events",
    "Immutable storage protection using AWS S3 Object Lock, when available",
  ];

  for (const b of bullets) {
    safeParagraph(doc, `• ${b}`, { fontSize: 9.8, color: BRAND.ink });
  }

  doc.moveDown(0.16);

  doc.save();
  doc.fillColor(BRAND.accent).font("Helvetica-Bold").fontSize(10.1);
  doc.text("Independent review may include:", x, doc.y, { width: w });
  doc.restore();
  doc.moveDown(0.12);

  const steps =
    opts.structureLabel === "Single evidence item"
      ? [
          "Obtaining the original evidence file",
          "Computing the SHA-256 hash of the evidence file",
          "Comparing the computed hash with the value listed in this report",
          "Verifying the digital signature using the provided public key",
          "Verifying the RFC 3161 timestamp token, when present",
          "Verifying the OpenTimestamps proof, when present",
          "Reviewing the forensic chain of custody events",
          "Reviewing immutable storage details, when present",
        ]
      : [
          "Obtaining the complete multipart evidence set",
          "Reviewing the canonical fingerprint and listed evidence parts",
          "Validating the multipart composite hash against the hashes and structure recorded in the canonical fingerprint",
          "Verifying the digital signature using the provided public key",
          "Verifying the RFC 3161 timestamp token, when present",
          "Verifying the OpenTimestamps proof, when present",
          "Reviewing the forensic chain of custody events",
          "Reviewing immutable storage details, when present",
        ];

  for (let i = 0; i < steps.length; i++) {
    safeParagraph(doc, `${i + 1}. ${steps[i]}`, {
      fontSize: 9.8,
      color: BRAND.ink,
    });
  }

  doc.moveDown(0.16);

  safeParagraph(
    doc,
    "Where present, the RFC 3161 timestamp provides evidence that the signed integrity state existed at or before the issuance time recorded by the Time Stamping Authority. Where present, OpenTimestamps provides additional independent public anchoring evidence linked to the recorded evidence digest.",
    { fontSize: 9.2, color: BRAND.muted }
  );
  doc.moveDown(0.16);

  drawCallout(doc, {
    title: "Legal Notice",
    body:
      "Cryptographic verification confirms integrity of the recorded evidence state only. It does not independently establish authorship, factual accuracy, legal admissibility, context, or probative weight. These issues remain subject to judicial, administrative, or expert evaluation under the applicable law and procedure.",
    tone: "warning",
  });

  const externalMode = opts.externalMode !== false;
  const linkLabelText = externalMode
    ? "Public verification page:"
    : "Verification link:";
  const linkBodyText = externalMode
    ? "Open public verification page"
    : opts.verifyUrl;

  const labelHeight = doc.heightOfString(linkLabelText, { width: w });
  const linkHeight = doc.heightOfString(linkBodyText, {
    width: w,
    lineGap: 1.5,
  });

  ensureSpace(doc, labelHeight + linkHeight + 12);

  doc.save();
  doc.fillColor(BRAND.accent).font("Helvetica-Bold").fontSize(9.2);
  doc.text(linkLabelText, x, doc.y, { width: w });
  doc.restore();
  doc.moveDown(0.08);

  doc.save();
  doc.fillColor(BRAND.accent).font("Helvetica").fontSize(8.8);
  doc.text(linkBodyText, x, doc.y, {
    width: w,
    link: opts.verifyUrl,
    underline: true,
    lineGap: 1.5,
  });
  doc.restore();
}

function buildExecutiveRows(
  evidence: ReportEvidence,
  structureLabel: string,
  contentSummary: ReportEvidenceContentSummary,
  display: ReportEvidenceDisplayDescriptor,
  externalMode: boolean
): Array<[string, string]> {
  const rows: Array<[string, string]> = [];
  const add = (label: string, value: string | null | undefined) => {
    if (value === null || value === undefined || value === "") return;
    rows.push([label, String(value)]);
  };

  add("Display Title", display.displayTitle);
  add("Display Description", display.displayDescription);
  add("Evidence Reference", buildPublicEvidenceReference(evidence.id));
  add("Evidence Type", mapPublicEvidenceTypeLabel(evidence, contentSummary));
  add("Record Status", mapRecordStatusLabel(evidence.status));
  add("Verification Status", mapVerificationStatusLabel(evidence.verificationStatus));
  add("Capture Method", mapCaptureMethodLabel(evidence.captureMethod));
  add("Identity Level", mapIdentityLevelLabel(evidence.identityLevelSnapshot));
  add(
    "Submitted By",
    externalMode ? maskEmail(evidence.submittedByEmail) : safe(evidence.submittedByEmail)
  );
  add("Auth Provider", mapAuthProviderLabel(evidence.submittedByAuthProvider));
  add("Organization / Workspace", buildOrganizationDisplay(evidence));
  add("Organization Status", buildOrganizationStatus(evidence));
  add("Evidence Structure", structureLabel);
  add("Item Count", String(contentSummary.itemCount));
  add("Primary Content Kind", mapEvidenceAssetKindLabel(contentSummary.primaryKind));
  add("MIME Type", safe(evidence.mimeType));
  add("Total Content Size", safe(contentSummary.totalSizeDisplay));
  add("Captured (UTC)", safe(evidence.capturedAtUtc));
  add("Uploaded (UTC)", safe(evidence.uploadedAtUtc));
  add("Signed (UTC)", safe(evidence.signedAtUtc));
  add("Integrity Verified At (UTC)", safe(evidence.recordedIntegrityVerifiedAtUtc));
  add("Storage Protection", mapObjectLockModePublicLabel(evidence.storageObjectLockMode));
  add("Retention Until (UTC)", safe(evidence.storageObjectLockRetainUntilUtc));

  return rows;
}

function buildVerificationSummaryRows(
  evidence: ReportEvidence,
  custody: ReturnType<typeof splitCustodyEvents>,
  structureLabel: string,
  contentSummary: ReportEvidenceContentSummary,
  externalMode: boolean
): Array<[string, string]> {
  const rows: Array<[string, string]> = [];
  const add = (label: string, value: string | null | undefined) => {
    if (value === null || value === undefined || value === "") return;
    rows.push([label, String(value)]);
  };

  add(
    "Display Title",
    safe(evidence.display?.displayTitle ?? evidence.displayTitle ?? evidence.title, "Digital Evidence Record")
  );
  add("Evidence Reference", buildPublicEvidenceReference(evidence.id));
  add("Evidence Type", mapPublicEvidenceTypeLabel(evidence, contentSummary));
  add("Evidence Structure", structureLabel);
  add("Previewable Items", String(contentSummary.previewableItemCount));
  add("Downloadable Items", String(contentSummary.downloadableItemCount));
  add("MIME Type", safe(evidence.mimeType));
  add("File Size", formatBytesHuman(evidence.sizeBytes));
  add("Duration", evidence.durationSec ? `${evidence.durationSec} sec` : null);
  add("Latest Report Version", evidence.latestReportVersion ? String(evidence.latestReportVersion) : null);
  add("Report Generated At (UTC)", safe(evidence.reportGeneratedAtUtc));
  add("Reviewer Summary Version", evidence.reviewerSummaryVersion ? String(evidence.reviewerSummaryVersion) : null);
  add("Last Verified At (UTC)", safe(evidence.lastVerifiedAtUtc));
  add("Last Verified Source", mapVerificationSourceLabel(evidence.lastVerifiedSource));
  add("Storage Lock Mode", mapObjectLockModePublicLabel(evidence.storageObjectLockMode));
  add("Retention Until (UTC)", safe(evidence.storageObjectLockRetainUntilUtc));
  add("Review Ready At (UTC)", safe(evidence.reviewReadyAtUtc));
  add("Forensic Custody Events", String(custody.forensic.length));
  add("Access Activity Events", String(custody.access.length));
  add("Public Verification Page", "See QR / verification link section");

  if (!externalMode) {
    add("Verification Package Version", evidence.verificationPackageVersion ? String(evidence.verificationPackageVersion) : null);
    add("Verification Package Generated At (UTC)", safe(evidence.verificationPackageGeneratedAtUtc));
  }

  return rows;
}

function buildReviewReadinessRows(
  evidence: ReportEvidence,
  custody: ReturnType<typeof splitCustodyEvents>,
  externalMode: boolean
): Array<[string, string]> {
  return [
    [
      "Human Summary Ready",
      evidence.reviewReadyAtUtc ? "Yes" : "Not recorded",
    ],
    [
      "Verification Status",
      mapVerificationStatusLabel(evidence.verificationStatus),
    ],
    [
      "Timestamp Status",
      mapTimestampStatusPublicLabel(evidence.tsaStatus),
    ],
    ["Public Anchoring Status", mapOtsStatusPublicLabel(evidence.otsStatus)],
    [
      "Immutable Storage",
      safeBooleanLabel(
        evidence.storageImmutable,
        "Verified",
        "Not fully verified",
        "Not reported"
      ),
    ],
    [
      "Chain of Custody Present",
      custody.forensic.length > 0 ? "Yes" : "No",
    ],
    [
      "Public / Access Activity Present",
      custody.access.length > 0 ? "Yes" : "No",
    ],
    [
      "Technical Materials Available",
      evidence.fileSha256 &&
      evidence.fingerprintHash &&
      evidence.signatureBase64 &&
      evidence.signingKeyId
        ? "Yes"
        : "Incomplete",
    ],
    [
      "Submitted By",
      externalMode
        ? maskEmail(evidence.submittedByEmail)
        : safe(evidence.submittedByEmail),
    ],
    ["Identity Level", mapIdentityLevelLabel(evidence.identityLevelSnapshot)],
    ["Capture Method", mapCaptureMethodLabel(evidence.captureMethod)],
    ["Organization / Workspace", buildOrganizationDisplay(evidence)],
  ];
}

function buildEvidenceContentSummaryRows(
  contentSummary: ReportEvidenceContentSummary,
  primaryItem: ReportEvidenceAsset | null,
  evidence?: ReportEvidence
): Array<[string, string]> {
  const rows: Array<[string, string]> = [];
  const add = (label: string, value: string | null | undefined) => {
    if (value === null || value === undefined || value === "") return;
    rows.push([label, String(value)]);
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
  add("Images", contentSummary.imageCount > 0 ? String(contentSummary.imageCount) : null);
  add("Videos", contentSummary.videoCount > 0 ? String(contentSummary.videoCount) : null);
  add("Audio", contentSummary.audioCount > 0 ? String(contentSummary.audioCount) : null);
  add("PDF", contentSummary.pdfCount > 0 ? String(contentSummary.pdfCount) : null);
  add("Text", contentSummary.textCount > 0 ? String(contentSummary.textCount) : null);
  add("Other", contentSummary.otherCount > 0 ? String(contentSummary.otherCount) : null);
  add("Primary Content Kind", mapEvidenceAssetKindLabel(contentSummary.primaryKind));
  add(
    "Primary Content Label",
    safe(evidence?.primaryContentLabel ?? mapEvidenceAssetKindLabel(contentSummary.primaryKind))
  );
  add("Primary MIME Type", safe(contentSummary.primaryMimeType));
  add("Total Size", safe(contentSummary.totalSizeDisplay));
  add("Composition Summary", safe(evidence?.contentCompositionSummary));
  add("Content Access Mode", safe(evidence?.contentAccessPolicy?.mode));
  add(
    "Content View Allowed",
    evidence?.contentAccessPolicy
      ? safeBooleanLabel(evidence.contentAccessPolicy.allowContentView, "Yes", "No", "Not recorded")
      : null
  );
  add(
    "Download Allowed",
    evidence?.contentAccessPolicy
      ? safeBooleanLabel(evidence.contentAccessPolicy.allowDownload, "Yes", "No", "Not recorded")
      : null
  );
  add("Primary Item Label", primaryItem ? safe(primaryItem.label) : null);
  add("Primary Item Size", primaryItem?.displaySizeLabel);
  add("Primary Item Hash", primaryItem?.sha256 ? shortHash(primaryItem.sha256) : null);

  return rows;
}

function buildEvidenceInventoryRows(items: ReportEvidenceAsset[]): string[][] {
  return items.map((item) => {
    const roleParts = [
      item.artifactRole === "primary_evidence"
        ? "Primary evidence"
        : item.artifactRole === "supporting_evidence"
          ? "Supporting evidence"
          : item.artifactRole === "attachment"
            ? "Attachment"
            : null,
      item.previewRole === "primary_preview"
        ? "Primary preview"
        : item.previewRole === "secondary_preview"
          ? "Secondary preview"
          : item.previewRole === "download_only"
            ? "Download-only"
            : item.previewRole === "metadata_only"
              ? "Metadata-only"
              : null,
    ]
      .filter(Boolean)
      .join("\n");

    return [
      String(item.index + 1),
      item.isPrimary ? `${safe(item.label)} (primary)` : safe(item.label),
      mapEvidenceAssetKindLabel(item.kind),
      [
        item.mimeType ? `MIME: ${item.mimeType}` : null,
        item.displaySizeLabel ? `Size: ${item.displaySizeLabel}` : null,
      ]
        .filter(Boolean)
        .join("\n"),
      item.sha256 ? shortHash(item.sha256) : "N/A",
      roleParts || "Not recorded",
    ];
  });
}

function tryDecodeDataUrlToBuffer(dataUrl: string | null | undefined): Buffer | null {
  const raw = safe(dataUrl, "");
  if (!raw) return null;
  const match = raw.match(/^data:.*?;base64,(.+)$/);
  if (!match?.[1]) return null;
  try {
    return Buffer.from(match[1], "base64");
  } catch {
    return null;
  }
}

function drawPreviewPlaceholder(
  doc: PDFDoc,
  x: number,
  y: number,
  w: number,
  h: number,
  title: string,
  subtitle?: string
): void {
  doc.save();
  doc.roundedRect(x, y, w, h, 9).fill("#F3F6FA");
  doc.lineWidth(0.8).strokeColor(BRAND.line);
  doc.roundedRect(x, y, w, h, 9).stroke();
  doc.restore();

  doc.save();
  doc.fillColor(BRAND.accent).font("Helvetica-Bold").fontSize(10);
  doc.text(title, x + 12, y + 14, {
    width: w - 24,
    align: "center",
  });
  doc.restore();

  if (subtitle) {
    doc.save();
    doc.fillColor(BRAND.muted).font("Helvetica").fontSize(8.8);
    doc.text(subtitle, x + 12, y + 34, {
      width: w - 24,
      align: "center",
      lineGap: 1.5,
    });
    doc.restore();
  }
}

function renderEvidenceThumbnail(
  doc: PDFDoc,
  item: ReportEvidenceAsset,
  x: number,
  y: number,
  width: number,
  height: number
): void {
  const previewBuffer = tryDecodeDataUrlToBuffer(item.previewDataUrl);

  doc.save();
  doc.roundedRect(x, y, width, height, 9).fill("#F8FAFC");
  doc.restore();

  if (previewBuffer) {
    try {
      doc.image(previewBuffer, x, y, {
        fit: [width, height],
        align: "center",
        valign: "center",
      });
    } catch {
      // Fall back to placeholder below.
    }
  } else {
    let placeholderTitle = mapEvidenceAssetKindLabel(item.kind);
    let placeholderSubtitle = safe(item.mimeType, "Preview unavailable");

    if (item.kind === "video") {
      placeholderTitle = "Video";
      placeholderSubtitle = "Preview in verification workspace";
    } else if (item.kind === "audio") {
      placeholderTitle = "Audio";
      placeholderSubtitle = "Playback in verification workspace";
    } else if (item.kind === "pdf") {
      placeholderTitle = "Document";
      placeholderSubtitle = "First-page preview unavailable";
    } else if (item.kind === "text") {
      placeholderTitle = "Text";
      placeholderSubtitle = item.previewTextExcerpt
        ? summarizeText(item.previewTextExcerpt, 54)
        : "Text excerpt unavailable";
    }

    drawPreviewPlaceholder(
      doc,
      x,
      y,
      width,
      height,
      placeholderTitle,
      placeholderSubtitle
    );
  }

  doc.save();
  doc.lineWidth(0.8).strokeColor(BRAND.line);
  doc.roundedRect(x, y, width, height, 9).stroke();
  doc.restore();
}

function renderEmbeddedEvidencePreview(
  doc: PDFDoc,
  item: ReportEvidenceAsset,
  x: number,
  width: number,
  height: number
): boolean {
  const previewBuffer = tryDecodeDataUrlToBuffer(item.previewDataUrl);
  if (!previewBuffer) return false;

  try {
    const y = doc.y;

    ensureSpace(doc, height + 18);

    doc.save();
    doc.roundedRect(x, y, width, height, 10).fill("#F8FAFC");
    doc.restore();

    doc.image(previewBuffer, x, y, {
      fit: [width, height],
      align: "center",
      valign: "center",
    });

    doc.save();
    doc.lineWidth(0.8).strokeColor(BRAND.line);
    doc.roundedRect(x, y, width, height, 10).stroke();
    doc.restore();

    doc.y = y + height + 6;
    return true;
  } catch {
    return false;
  }
}

function drawEvidenceGallery(
  doc: PDFDoc,
  items: ReportEvidenceAsset[]
): void {
  if (items.length === 0) return;

  const x = doc.page.margins.left;
  const totalW = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const gap = 12;
  const columns = Math.min(3, items.length);
  const cardW = (totalW - gap * (columns - 1)) / columns;
  const thumbH = 96;
  const cardPad = 10;
  const cardMetaGap = 8;

  const estimateCardHeight = (item: ReportEvidenceAsset): number => {
    doc.font("Helvetica-Bold").fontSize(9.4);
    const titleH = doc.heightOfString(
      `${item.index + 1}. ${safe(item.label)}`,
      { width: cardW - cardPad * 2, lineGap: 1.2 }
    );

    doc.font("Helvetica").fontSize(7.9);
    const metaText = [
      mapEvidenceAssetKindLabel(item.kind),
      safe(item.mimeType, ""),
      safe(item.displaySizeLabel, ""),
      item.sha256 ? `SHA ${shortHash(item.sha256, 8, 6)}` : "",
    ]
      .filter(Boolean)
      .join(" • ");
    const metaH = doc.heightOfString(metaText, {
      width: cardW - cardPad * 2,
      lineGap: 1.2,
    });

    return cardPad + titleH + 6 + thumbH + cardMetaGap + metaH + cardPad;
  };

  let cursorX = x;
  let rowY = doc.y;
  let rowMaxHeight = 0;

  items.forEach((item, index) => {
    if (index > 0 && index % columns === 0) {
      cursorX = x;
      rowY += rowMaxHeight + gap;
      rowMaxHeight = 0;
    }

    const cardH = Math.max(158, estimateCardHeight(item));
    const beforeEnsureY = doc.y;
    ensurePageWithHeader(doc, rowY - doc.y + cardH + 6);

    if (doc.y !== beforeEnsureY) {
      cursorX = x;
      rowY = doc.y;
      rowMaxHeight = 0;
    }

    rowMaxHeight = Math.max(rowMaxHeight, cardH);

    doc.save();
    doc.roundedRect(cursorX, rowY, cardW, cardH, 12).fill("#FFFFFF");
    doc
      .lineWidth(0.85)
      .strokeColor(BRAND.line)
      .roundedRect(cursorX, rowY, cardW, cardH, 12)
      .stroke();
    doc.restore();

    doc.save();
    doc.fillColor(BRAND.ink).font("Helvetica-Bold").fontSize(9.4);
    doc.text(
      `${item.index + 1}. ${safe(item.label)}`,
      cursorX + cardPad,
      rowY + cardPad,
      {
        width: cardW - cardPad * 2,
        lineGap: 1.2,
      }
    );
    doc.restore();

    const titleEndY = doc.y;
    const thumbY = titleEndY + 6;
    renderEvidenceThumbnail(
      doc,
      item,
      cursorX + cardPad,
      thumbY,
      cardW - cardPad * 2,
      thumbH
    );

    const metaText = [
      mapEvidenceAssetKindLabel(item.kind),
      safe(item.mimeType, ""),
      safe(item.displaySizeLabel, ""),
      item.sha256 ? `SHA ${shortHash(item.sha256, 8, 6)}` : "",
    ]
      .filter(Boolean)
      .join(" • ");

    doc.save();
    doc.fillColor(BRAND.muted).font("Helvetica").fontSize(7.9);
    doc.text(
      metaText,
      cursorX + cardPad,
      thumbY + thumbH + cardMetaGap,
      {
        width: cardW - cardPad * 2,
        lineGap: 1.2,
      }
    );
    doc.restore();

    cursorX += cardW + gap;
    doc.y = rowY;
  });

  doc.y = rowY + rowMaxHeight + 8;
}

function drawEvidencePreviewCard(
  doc: PDFDoc,
  item: ReportEvidenceAsset,
  options?: { large?: boolean; compact?: boolean }
): void {
  const pageW =
    doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const compact = options?.compact === true;
  const width = compact
    ? Math.min(pageW, 210)
    : options?.large
      ? Math.min(pageW, 280)
      : Math.min(pageW, 250);
  const previewH = compact ? 128 : options?.large ? 210 : 180;
  const x = doc.page.margins.left + (pageW - width) / 2;

  ensureSpace(doc, previewH + (compact ? 42 : 92));

  doc.save();
  doc.fillColor(BRAND.ink).font("Helvetica-Bold").fontSize(10.8);
  doc.text(
    item.isPrimary ? `Primary Evidence Preview — ${safe(item.label)}` : safe(item.label),
    x,
    doc.y,
    { width }
  );
  doc.restore();
  doc.moveDown(0.12);

  const renderedEmbedded = renderEmbeddedEvidencePreview(
    doc,
    item,
    x,
    width,
    previewH
  );

  if (!renderedEmbedded) {
    const y = doc.y;

    let placeholderTitle = "Evidence preview not embedded";
    let placeholderSubtitle =
      "This report retains the structured evidence inventory and technical verification record.";

    switch (item.kind) {
      case "image":
placeholderTitle = "Image preview placeholder";
placeholderSubtitle =
  "The report confirms the recorded evidence structure and integrity state, but no embedded image rendering was included in this report artifact.";
          break;
      case "pdf":
placeholderTitle = "PDF first-page preview placeholder";
placeholderSubtitle =
  "The report confirms the recorded evidence structure and integrity state, but no embedded PDF page rendering was included in this report artifact.";
          break;
      case "video":
        placeholderTitle = "Video preview placeholder";
placeholderSubtitle =
  "This report records the evidence item and its integrity state. Controlled playback should be performed through the verification interface or protected evidence workspace.";
          break;
      case "audio":
        placeholderTitle = "Audio preview placeholder";
placeholderSubtitle =
  "This report records the evidence item and its integrity state. Controlled playback should be performed through the verification interface or protected evidence workspace.";
          break;
      case "text":
        placeholderTitle = "Text excerpt placeholder";
        placeholderSubtitle =
          item.previewTextExcerpt
            ? summarizeText(item.previewTextExcerpt, 180)
            : "No text excerpt was included in the report payload.";
        break;
      default:
        placeholderTitle = "Evidence preview placeholder";
        placeholderSubtitle =
          "This item is represented in the structured evidence inventory.";
        break;
    }

    drawPreviewPlaceholder(doc, x, y, width, previewH, placeholderTitle, placeholderSubtitle);
    doc.y = y + previewH + 6;
  }

  if (compact) {
    doc.save();
    doc.fillColor(BRAND.muted).font("Helvetica").fontSize(8.6);
    doc.text(
      [
        mapEvidenceAssetKindLabel(item.kind),
        safe(item.mimeType, ""),
        safe(item.displaySizeLabel, ""),
        item.sha256 ? `SHA-256 ${shortHash(item.sha256)}` : "",
      ]
        .filter(Boolean)
        .join(" • "),
      x,
      doc.y,
      { width, align: "center", lineGap: 1.5 }
    );
    doc.restore();
    doc.moveDown(0.2);
    return;
  }

  doc.save();
  doc.fillColor(BRAND.muted).font("Helvetica").fontSize(8.7);
  doc.text(
    "Reviewer representation note: any embedded preview in this report is provided to support human review of the preserved evidence item. The original evidence file remains separately preserved and should be evaluated together with the integrity, custody, timestamping, and publication materials recorded in this report.",
    x,
    doc.y,
    {
      width,
      lineGap: 1.5,
    }
  );
  doc.restore();
  doc.moveDown(0.25);

  kvGrid(doc, [
    ["Item Label", safe(item.label)],
    ["Kind", mapEvidenceAssetKindLabel(item.kind)],
    ["MIME Type", safe(item.mimeType)],
    ["Display Size", safe(item.displaySizeLabel)],
    ["Previewable", item.previewable ? "Yes" : "No"],
    ["Downloadable", item.downloadable ? "Yes" : "No"],
    ["Preview Role", safe(item.previewRole)],
    ["Artifact Role", safe(item.artifactRole)],
    [
      "SHA-256",
      item.sha256 ? shortHash(item.sha256) : "Not recorded",
    ],
    [
      "Caption",
      safe(item.previewCaption),
    ],
    [
      "Original Preservation",
      safe(item.originalPreservationNote),
    ],
    [
      "Reviewer Representation",
      safe(item.reviewerRepresentationLabel),
    ],
  ]);

  if (item.reviewerRepresentationNote) {
    drawCallout(doc, {
      title: "Reviewer representation note",
      body: item.reviewerRepresentationNote,
      tone: "warning",
    });
  }

  if (item.verificationMaterialsNote) {
    drawCallout(doc, {
      title: "Verification materials note",
      body: item.verificationMaterialsNote,
      tone: "neutral",
    });
  }
}

export async function buildReportPdf(params: {
  evidence: ReportEvidence;
  custodyEvents: ReportCustodyEvent[];
  version: number;
  generatedAtUtc: string;
  buildInfo?: string | null;
  verifyUrl?: string | null;
  downloadUrl?: string | null;
  externalMode?: boolean;
}): Promise<Buffer> {
  const doc = new PDFDocument({
    autoFirstPage: true,
    margin: 50,
    bufferPages: true,
  });

  paintPageBackground(doc);
  doc.on("pageAdded", () => paintPageBackground(doc));

  const buildToken = params.buildInfo
    ? `;PROOVRA_BUILD=${params.buildInfo}`
    : "";

  doc.info = {
    Title: `${BRAND.name} — Verification Report`,
    Subject:
      "Executive Conclusion > Evidence Content > Integrity Proof > Storage and Timestamping > Forensic Custody > Access Activity > Technical Appendix > Legal Limitations",
    Keywords: `PROOVRA_REPORT_VERSION=${params.version};PROOVRA_GENERATED_AT=${params.generatedAtUtc}${buildToken}`,
    Creator: BRAND.name,
    Producer: BRAND.name,
    CreationDate: new Date(params.generatedAtUtc),
    ModDate: new Date(params.generatedAtUtc),
  };

  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));

  const verifyUrl = buildVerifyUrl(params.evidence.id, params.verifyUrl);
  const technicalUrl = verifyUrl.includes("?")
    ? `${verifyUrl}&tab=technical`
    : `${verifyUrl}?tab=technical`;

  const parsedFingerprintSummary = parseFingerprintSummary(
    params.evidence.fingerprintCanonicalJson
  );
  const contentSummary = resolveContentSummary(
    params.evidence,
    parsedFingerprintSummary
  );
  const contentItems = resolveContentItems(params.evidence);
  const primaryContentItem = resolvePrimaryContentItem(params.evidence);
  const structureLabel =
    params.evidence.evidenceStructure?.trim() ||
    evidenceStructureLabel(contentSummary);
  const previewPolicy = resolvePreviewPolicy(params.evidence);
  const display = resolveDisplayDescriptor(params.evidence, contentSummary);

  const custody = splitCustodyEvents(params.custodyEvents);

  const hasCoreCrypto =
    Boolean(params.evidence.fileSha256) &&
    Boolean(params.evidence.fingerprintHash) &&
    Boolean(params.evidence.signatureBase64) &&
    Boolean(params.evidence.signingKeyId);

  const timestampTone = normalizeTimestampStatus(params.evidence.tsaStatus);
  const otsTone = normalizeOtsStatus(params.evidence.otsStatus);
  const storageTone = normalizeStorageProtectionStatus(
    params.evidence.storageImmutable,
    params.evidence.storageObjectLockMode,
    params.evidence.storageObjectLockRetainUntilUtc
  );

  const integrityVerified =
    safe(params.evidence.verificationStatus, "").toUpperCase() ===
      "RECORDED_INTEGRITY_VERIFIED" ||
    safe(params.evidence.recordedIntegrityVerifiedAtUtc, "") !== "";

  const reviewGuidance = resolveReviewGuidance(
    params.evidence,
    contentSummary.itemCount,
    contentSummary.previewableItemCount,
    integrityVerified
  );
  const legalLimitations = resolveLegalLimitations(params.evidence);
  const anchorSummary = resolveAnchorSummary(params.evidence);

  const finalDisplayStatus = mapRecordStatusLabel(params.evidence.status);

  const headerContext: HeaderContext = {
    evidenceId: params.evidence.id,
    generatedAtUtc: params.generatedAtUtc,
    status: finalDisplayStatus,
  };

  const externalMode = params.externalMode === true;
  const includeTechnicalQr =
    !externalMode &&
    (Boolean(params.downloadUrl) ||
      env("REPORT_INCLUDE_TECHNICAL_QR") === "true");

  setHeaderContext(headerContext);
  drawHeader(doc, headerContext);

  doc.save();
  doc.fillColor(BRAND.ink).font("Helvetica-Bold").fontSize(16);
  doc.text(display.displayTitle, doc.page.margins.left, doc.y);
  doc.restore();

  if (display.displayDescription) {
    doc.moveDown(0.1);
    safeParagraph(doc, display.displayDescription, {
      fontSize: 9.5,
      color: BRAND.muted,
    });
  }

  doc.moveDown(0.18);

  doc.save();
  doc.fillColor(integrityVerified ? BRAND.success : BRAND.danger);
  doc.font("Helvetica-Bold").fontSize(13.2);
  doc.text(
    integrityVerified
      ? "Recorded Integrity Verified"
      : "Recorded Integrity Review Required",
    doc.page.margins.left,
    doc.y
  );
  doc.restore();
  doc.moveDown(0.2);

  drawCallout(doc, {
    title: "Executive conclusion",
    body: integrityVerified
      ? "This report supports the conclusion that the recorded integrity state of the evidence record was verified within the system record. Reviewers should still separately assess factual context, authorship, relevance, and admissibility."
      : "This report supports review of the recorded evidence state, but the integrity outcome remains incomplete or requires manual assessment before reliance.",
    tone: integrityVerified ? "success" : "danger",
  });

  drawCallout(doc, {
    title: "Important legal limitation",
    body: legalLimitations.short,
    tone: "warning",
  });

  drawInfoCards(doc, [
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
      value: `${mapTimestampStatusPublicLabel(
        params.evidence.tsaStatus
      )} • ${safeBooleanLabel(
        params.evidence.storageImmutable,
        "Immutable",
        "Review storage",
        "Not reported"
      )}`,
      tone:
        timestampTone === "SUCCESS" && storageTone === "SUCCESS"
          ? "success"
          : timestampTone === "DANGER" || storageTone === "DANGER"
            ? "danger"
            : "warning",
    },
    {
      label: "External Publication",
      value: anchorSummary?.published
        ? `Published via ${safe(anchorSummary.provider, "external anchor")}`
        : "No external publication recorded",
      tone: anchorSummary?.published ? "success" : "warning",
    },
  ]);

  const mismatchSummary = buildMismatchNarrative({
    evidence: params.evidence,
    integrityVerified,
    custody,
  });

  drawCallout(doc, {
    title: "Review sequence",
    body:
      `Start with the primary evidence item${
        primaryContentItem ? ` (${safe(primaryContentItem.label)})` : ""
      }, then review the package structure, then assess the recorded integrity outcome, and only then move into forensic custody, timestamps, and the technical appendix when deeper validation is needed.`,
    tone: "neutral",
  });

  drawCallout(doc, mismatchSummary);

  section(
    doc,
    "Evidence Content",
    () => {
      safeParagraph(
        doc,
        "This section describes what was recorded as evidence content. It is intentionally separated from the technical integrity proof so reviewers can distinguish the content itself from the mechanism used to verify the recorded state.",
        { fontSize: 9.5, color: BRAND.muted }
      );
      doc.moveDown(0.12);

      kvGrid(
        doc,
        buildEvidenceContentSummaryRows(
          contentSummary,
          primaryContentItem,
          params.evidence
        )
      );
      doc.moveDown(0.12);

      drawCallout(doc, {
        title: "Reviewer content note",
        body: primaryContentItem
          ? [
              reviewGuidance.contentReviewNote,
              `${previewPolicy.rationale} ${previewPolicy.privacyNotice}`,
              `Label: ${safe(primaryContentItem.label)}`,
              `Kind: ${mapEvidenceAssetKindLabel(primaryContentItem.kind)}`,
              primaryContentItem.mimeType ? `MIME: ${primaryContentItem.mimeType}` : null,
              primaryContentItem.displaySizeLabel
                ? `Size: ${primaryContentItem.displaySizeLabel}`
                : null,
              primaryContentItem.previewable ? "Previewable item" : "Non-previewable item",
              primaryContentItem.sha256
                ? `SHA-256: ${shortHash(primaryContentItem.sha256)}`
                : null,
            ]
              .filter(Boolean)
              .join(" • ")
          : `${reviewGuidance.contentReviewNote} No primary evidence item was explicitly identified in the report payload.`,
        tone: "neutral",
      });

      if (contentItems.length > 1) {
        drawCallout(doc, {
          title: "Multipart evidence package note",
          body:
            "This report should be reviewed as an evidence package rather than as a single loose file. The primary item gives the fastest understanding of the record, but supporting items may materially affect interpretation, chronology, or context.",
          tone: "warning",
        });

        drawCallout(doc, {
          title: "Evidence package gallery",
          body:
            "Recorded evidence items are indexed below as a compact review gallery so multipart packages can be reviewed quickly without dedicating a full page to every image, video, or document.",
          tone: "neutral",
        });

        drawEvidenceGallery(doc, contentItems);
      }

      if (primaryContentItem) {
        if (previewPolicy.previewEnabled) {
          if (contentItems.length > 1) {
            drawCallout(doc, {
              title: "Primary evidence spotlight",
              body:
                "The primary evidence item is indexed here as the lead review item, but multipart packages are intentionally summarized through the compact gallery instead of dedicating a full-page viewer to each item. Deeper visual inspection should be performed in the controlled verification workspace.",
              tone: "neutral",
            });
            drawEvidencePreviewCard(doc, primaryContentItem, { compact: true });
          } else {
            drawEvidencePreviewCard(doc, primaryContentItem, { large: true });
          }
        } else {
          drawCallout(doc, {
            title: "Preview disabled by report policy",
            body:
              "The report policy for this artifact does not allow embedded evidence preview. Reviewers should use the structured inventory and verification workflow instead.",
            tone: "warning",
          });
        }
      }

      if (contentItems.length === 0) {
        drawCallout(doc, {
          title: "No structured evidence item inventory included",
          body:
            "The report payload did not include explicit item-level inventory rows. Reviewers should rely on the canonical fingerprint, MIME type, and evidence structure fields.",
          tone: "warning",
        });
      } else {
        drawCallout(doc, {
          title: "Structured evidence inventory",
          body:
            contentItems.length > 1
              ? "This report includes both a compact review gallery and a structured item-level inventory for multipart evidence. Reviewers can use the gallery for rapid orientation and the table below for precise item details."
              : "This report includes a structured item-level inventory for the recorded evidence item.",
          tone: "neutral",
        });

        const innerW =
          doc.page.width - doc.page.margins.left - doc.page.margins.right;
        const colWidths = [
          Math.max(32, innerW * 0.06),
          Math.max(120, innerW * 0.24),
          Math.max(84, innerW * 0.14),
          Math.max(96, innerW * 0.18),
          Math.max(82, innerW * 0.12),
          innerW -
            (Math.max(32, innerW * 0.06) +
              Math.max(120, innerW * 0.24) +
              Math.max(84, innerW * 0.14) +
              Math.max(96, innerW * 0.18) +
              Math.max(82, innerW * 0.12)),
        ];

        drawTable(
          doc,
          [
            "#",
            "Item",
            "Kind",
            "MIME / Size",
            "SHA-256",
            "Role / Preview",
          ],
          buildEvidenceInventoryRows(contentItems),
          colWidths
        );
      }
    },
    { minSpace: 150 }
  );

  section(
    doc,
    "Integrity Proof",
    () => {
      safeParagraph(
        doc,
        "This section explains what the system technically supports about the recorded state of the evidence record. It is intentionally separated from the evidence content itself and from broader legal interpretation.",
        { fontSize: 9.5, color: BRAND.muted }
      );
      doc.moveDown(0.12);

      kvGrid(doc, [
        [
          "Recorded Integrity Status",
          integrityVerified
            ? "Recorded integrity state verified"
            : "Recorded integrity review required",
        ],
        [
          "Verification Status",
          mapVerificationStatusLabel(params.evidence.verificationStatus),
        ],
        [
          "Fingerprint Hash Present",
          safeBooleanLabel(Boolean(params.evidence.fingerprintHash), "Yes", "No"),
        ],
        [
          "Digital Signature Present",
          safeBooleanLabel(Boolean(params.evidence.signatureBase64), "Yes", "No"),
        ],
        [
          "Signing Key Reference",
          buildPublicSigningKeyReference(
            params.evidence.signingKeyId,
            params.evidence.signingKeyVersion
          ),
        ],
        [
          "Chain of Custody Present",
          custody.forensic.length > 0 ? "Yes" : "No",
        ],
        [
          "Trusted Timestamp Status",
          mapTimestampStatusPublicLabel(params.evidence.tsaStatus),
        ],
        [
          "OpenTimestamps Status",
          mapOtsStatusPublicLabel(params.evidence.otsStatus),
        ],
        [
          "Immutable Storage",
          safeBooleanLabel(
            params.evidence.storageImmutable,
            "Verified",
            "Not fully verified",
            "Not reported"
          ),
        ],
        [
          "External Anchor Published",
          safeBooleanLabel(anchorSummary?.published, "Yes", "No", "Not reported"),
        ],
      ]);

      doc.moveDown(0.14);

      drawCallout(doc, {
        title: "What is technically established",
        body:
          "The report records whether file and fingerprint digests, digital signature materials, custody events, timestamp records, public anchoring records, and storage-protection indicators were present in the recorded evidence state.",
        tone: "success",
      });

      drawCallout(doc, {
        title: "What is not technically established by this report alone",
        body:
          "This report does not independently prove factual truth, authorship, legal admissibility, narrative context, or the real-world meaning of the evidence content. It supports integrity review of the recorded state only.",
        tone: "warning",
      });

      if (!hasCoreCrypto) {
        drawCallout(doc, {
          title: "Incomplete technical materials",
          body:
            "One or more core technical materials were not present in the report payload. Review should proceed with caution.",
          tone: "danger",
        });
      }
    },
    { minSpace: 130 }
  );

  section(doc, "Certification & Attestation", () => {
    safeParagraph(
      doc,
      "This section records whether a certificated or attested statement was captured and attached as part of the evidence verification record.",
      { fontSize: 9.5, color: BRAND.muted }
    );
    doc.moveDown(0.12);

    const custodian = params.evidence.certifications?.custodian ?? null;
    const qualifiedPerson = params.evidence.certifications?.qualifiedPerson ?? null;

    if (!custodian && !qualifiedPerson) {
      drawCallout(doc, {
        title: "No actual certification attached",
        body:
          "No actual stored attestation record was attached to this evidence report. This means a certification workflow was not completed as part of the preserved record.",
        tone: "warning",
      });
      return;
    }

    if (custodian) {
      kvGrid(doc, [
        ["Custodian Status", mapCertificationStatusLabel(custodian.status)],
        ["Custodian Version", String(custodian.version)],
        ["Custodian Requested At", safe(custodian.requestedAtUtc)],
        ["Custodian Attested At", safe(custodian.attestedAtUtc)],
        ["Custodian Attestor Name", safe(custodian.attestorName)],
        ["Custodian Attestor Title", safe(custodian.attestorTitle)],
        ["Custodian Organization", safe(custodian.attestorOrganization)],
        ["Custodian Certification Hash", shortHash(custodian.certificationHash)],
        ["Custodian Revoked At", safe(custodian.revokedAtUtc)],
      ]);

      drawCallout(doc, {
        title: "Custodian certification state",
        body:
          custodian.status === "ATTESTED"
            ? "A custodian attestation record is attached and corresponds to the preserved evidence state."
            : custodian.status === "REVOKED"
              ? "A custodian certification record was revoked. Review the record carefully and use the attached state information to understand the revocation context."
              : "A custodian certification workflow exists but is not yet fully attested.",
        tone: certificationTone(custodian.status),
      });
    }

    if (qualifiedPerson) {
      if (custodian) {
        doc.moveDown(0.12);
      }

      kvGrid(doc, [
        ["Qualified Person Status", mapCertificationStatusLabel(qualifiedPerson.status)],
        ["Qualified Person Version", String(qualifiedPerson.version)],
        ["Qualified Person Requested At", safe(qualifiedPerson.requestedAtUtc)],
        ["Qualified Person Attested At", safe(qualifiedPerson.attestedAtUtc)],
        ["Qualified Person Attestor Name", safe(qualifiedPerson.attestorName)],
        ["Qualified Person Attestor Title", safe(qualifiedPerson.attestorTitle)],
        ["Qualified Person Organization", safe(qualifiedPerson.attestorOrganization)],
        ["Qualified Person Certification Hash", shortHash(qualifiedPerson.certificationHash)],
        ["Qualified Person Revoked At", safe(qualifiedPerson.revokedAtUtc)],
      ]);

      drawCallout(doc, {
        title: "Qualified-person certification state",
        body:
          qualifiedPerson.status === "ATTESTED"
            ? "A qualified-person certification record is attached and corresponds to the preserved evidence state."
            : qualifiedPerson.status === "REVOKED"
              ? "A qualified-person certification record was revoked. Review the record carefully and use the attached state information to understand the revocation context."
              : "A qualified-person certification workflow exists but is not yet fully attested.",
        tone: certificationTone(qualifiedPerson.status),
      });
    }
  },
  { minSpace: 130 }
  );

  {
    const qrBuf = await tryGenerateQrPngBuffer(verifyUrl);
    if (qrBuf) {
      drawQrBlock(doc, {
        title: "Open verification page",
        qrBuffer: qrBuf,
        size: 102,
        caption:
          "Scan to open the public reviewer-facing verification page for this evidence record.",
        urlText: buildVerificationLinkLabel("public"),
        urlLink: verifyUrl,
      });
    }
  }

  section(
    doc,
    "Storage & Timestamping",
    () => {
      kvGrid(doc, [
        ["Storage Region", safe(params.evidence.storageRegion)],
        [
          "Storage Protection Mode",
          mapObjectLockModePublicLabel(params.evidence.storageObjectLockMode),
        ],
        [
          "Retention Until (UTC)",
          safe(params.evidence.storageObjectLockRetainUntilUtc),
        ],
        [
          "Legal Hold",
          safe(params.evidence.storageObjectLockLegalHoldStatus, "OFF"),
        ],
        [
          "Immutable Storage",
          safeBooleanLabel(
            params.evidence.storageImmutable,
            "Verified",
            "Not fully verified",
            "Not reported"
          ),
        ],
        ["RFC 3161 Provider", safe(params.evidence.tsaProvider)],
        ["RFC 3161 URL", summarizeText(safe(params.evidence.tsaUrl), 84)],
        ["RFC 3161 Serial", safe(params.evidence.tsaSerialNumber)],
        ["RFC 3161 Time (UTC)", safe(params.evidence.tsaGenTimeUtc)],
        ["RFC 3161 Hash Algorithm", safe(params.evidence.tsaHashAlgorithm)],
        [
          "RFC 3161 Status",
          mapTimestampStatusPublicLabel(params.evidence.tsaStatus),
        ],
        [
          "Public Anchoring Status",
          mapOtsStatusPublicLabel(params.evidence.otsStatus),
        ],
        ["OTS Calendar", safe(params.evidence.otsCalendar)],
        ["OTS Anchored At (UTC)", safe(params.evidence.otsAnchoredAtUtc)],
        ["OTS Upgraded At (UTC)", safe(params.evidence.otsUpgradedAtUtc)],
        ["OTS Bitcoin TxID", shortHash(params.evidence.otsBitcoinTxid)],
      ]);

      if (anchorSummary) {
        doc.moveDown(0.12);
        kvGrid(doc, [
          ["External Anchor Mode", mapAnchorModePublicLabel(anchorSummary.mode)],
          ["External Anchor Provider", safe(anchorSummary.provider)],
          ["Anchor Published", safeBooleanLabel(anchorSummary.published, "Yes", "No")],
          ["Anchor Anchored At (UTC)", safe(anchorSummary.anchoredAtUtc)],
          ["Anchor Public URL", summarizeText(safe(anchorSummary.publicUrl), 84)],
          ["Anchor Receipt ID", shortHash(anchorSummary.receiptId)],
          ["Anchor Transaction ID", shortHash(anchorSummary.transactionId)],
        ]);
      }

      doc.moveDown(0.14);

      drawCallout(doc, {
        title:
          storageTone === "SUCCESS"
            ? "Immutable storage verified"
            : storageTone === "WARNING"
              ? "Storage protection recorded"
              : storageTone === "DANGER"
                ? "Storage protection requires review"
                : "Storage protection not reported",
        body:
          storageTone === "SUCCESS"
            ? "This report records immutable-style storage protection consistent with Object Lock COMPLIANCE mode and a retention-until timestamp."
            : storageTone === "WARNING"
              ? "Some storage protection indicators are recorded, but the report does not fully confirm COMPLIANCE immutable protection."
              : storageTone === "DANGER"
                ? "Storage metadata indicates a state that should be reviewed before relying on immutability conclusions."
                : "No verifiable storage-protection information was included in the report payload.",
        tone:
          storageTone === "SUCCESS"
            ? "success"
            : storageTone === "DANGER"
              ? "danger"
              : "warning",
      });

      drawCallout(doc, {
        title:
          timestampTone === "SUCCESS"
            ? "Trusted timestamp recorded"
            : timestampTone === "WARNING"
              ? "Timestamp pending or unavailable"
              : timestampTone === "DANGER"
                ? "Timestamp failure recorded"
                : "Timestamp not reported",
        body:
          timestampTone === "SUCCESS"
            ? "An RFC 3161 timestamp record is available and may support later review of when the recorded integrity state existed."
            : timestampTone === "WARNING"
              ? "The report does not confirm a final trusted timestamp result."
              : timestampTone === "DANGER"
                ? `Timestamp processing reported a failure state. ${safe(
                    params.evidence.tsaFailureReason,
                    ""
                  )}`.trim()
                : "No trusted timestamp record was included.",
        tone:
          timestampTone === "SUCCESS"
            ? "success"
            : timestampTone === "DANGER"
              ? "danger"
              : "warning",
      });

      drawCallout(doc, {
        title:
          otsTone === "SUCCESS"
            ? "OpenTimestamps anchored"
            : otsTone === "WARNING"
              ? "OpenTimestamps pending"
              : otsTone === "DANGER"
                ? "OpenTimestamps failed"
                : "OpenTimestamps not reported",
        body:
          otsTone === "SUCCESS"
            ? "An OpenTimestamps proof is recorded in an anchored state and may provide additional independent public anchoring evidence."
            : otsTone === "WARNING"
              ? "OpenTimestamps proof data is present but not yet in a final anchored state."
              : otsTone === "DANGER"
                ? `OpenTimestamps processing reported a failure state. ${safe(
                    params.evidence.otsFailureReason,
                    ""
                  )}`.trim()
                : "No OpenTimestamps record was included.",
        tone:
          otsTone === "SUCCESS"
            ? "success"
            : otsTone === "DANGER"
              ? "danger"
              : "warning",
      });
    },
    { minSpace: 150 }
  );

  section(
    doc,
    "Custody & Lifecycle Summary",
    () => {
      safeParagraph(
        doc,
        "Forensic lifecycle events are listed separately from later access activity. This separation helps reviewers distinguish integrity-relevant record changes from later viewing, download, and verification activity.",
        { fontSize: 8.9, color: BRAND.muted }
      );
      doc.moveDown(0.12);

      drawCallout(doc, {
        title: "Sequence note",
        body:
          "Original event sequence numbers are preserved from the full evidence timeline. Access-related events are shown separately, so numbering may appear non-consecutive within this section.",
        tone: "neutral",
      });

      if (custody.forensic.length === 0) {
        drawCallout(doc, {
          title: "No forensic custody events returned",
          body:
            "This report did not receive internal forensic custody-event entries for this evidence record. That means no system-recorded forensic chain was available in this output; it should not be treated as proof that no handling occurred outside the recorded workflow.",
          tone: "warning",
        });
      } else {
        const innerW =
          doc.page.width - doc.page.margins.left - doc.page.margins.right;
        const colWidths = [
          Math.max(44, innerW * 0.08),
          Math.max(118, innerW * 0.24),
          Math.max(132, innerW * 0.22),
          innerW -
            (Math.max(44, innerW * 0.08) +
              Math.max(118, innerW * 0.24) +
              Math.max(132, innerW * 0.22)),
        ];

        const headers = ["Seq", "At (UTC)", "Event", "Summary"];
        const rows = custody.forensic.map((ev) => {
          const summaryLines = [safe(ev.payloadSummary)];

          if (ev.prevEventHash) {
            summaryLines.push(`Previous hash: ${ev.prevEventHash}`);
          }
          if (ev.eventHash) {
            summaryLines.push(`Event hash: ${ev.eventHash}`);
          }

          return [
            String(ev.sequence),
            safe(ev.atUtc),
            mapCustodyEventLabel(ev.eventType),
            summaryLines.filter(Boolean).join("\n"),
          ];
        });

        drawTable(doc, headers, rows, colWidths);
      }
    },
    { minSpace: 120 }
  );

  if (custody.access.length > 0) {
    ensurePageWithHeader(doc, 180);

    section(
      doc,
      "Access Activity",
      () => {
        const innerW =
          doc.page.width - doc.page.margins.left - doc.page.margins.right;
        const colWidths = [
          Math.max(44, innerW * 0.08),
          Math.max(118, innerW * 0.24),
          Math.max(132, innerW * 0.22),
          innerW -
            (Math.max(44, innerW * 0.08) +
              Math.max(118, innerW * 0.24) +
              Math.max(132, innerW * 0.22)),
        ];

        const headers = ["Seq", "At (UTC)", "Event", "Summary"];
        const rows = custody.access.map((ev) => {
          const summaryLines = [safe(ev.payloadSummary)];

          if (ev.prevEventHash) {
            summaryLines.push(`Previous hash: ${ev.prevEventHash}`);
          }
          if (ev.eventHash) {
            summaryLines.push(`Event hash: ${ev.eventHash}`);
          }

          return [
            String(ev.sequence),
            safe(ev.atUtc),
            mapCustodyEventLabel(ev.eventType),
            summaryLines.filter(Boolean).join("\n"),
          ];
        });

        drawTable(doc, headers, rows, colWidths);
      },
      { minSpace: 100 }
    );
  }

  section(
    doc,
    externalMode
      ? "Technical Appendix — Reviewer-Facing Technical Summary"
      : "Technical Appendix — Identity, Fingerprint, Signature, and Anchoring",
    () => {
      kvGrid(doc, [
        [
          "Submitted By Email",
          externalMode
            ? maskEmail(params.evidence.submittedByEmail)
            : safe(params.evidence.submittedByEmail),
        ],
        [
          "Submitted By Provider",
          mapAuthProviderLabel(params.evidence.submittedByAuthProvider),
        ],
        [
          "Submitted By User Ref",
          redactIdentifier(params.evidence.submittedByUserId),
        ],
        [
          "Created By User Ref",
          redactIdentifier(params.evidence.createdByUserId),
        ],
        [
          "Uploaded By User Ref",
          redactIdentifier(params.evidence.uploadedByUserId),
        ],
        [
          "Last Accessed By User Ref",
          redactIdentifier(params.evidence.lastAccessedByUserId),
        ],
        ["Last Accessed At (UTC)", safe(params.evidence.lastAccessedAtUtc)],
        ["Capture Method", mapCaptureMethodLabel(params.evidence.captureMethod)],
        [
          "Identity Level",
          mapIdentityLevelLabel(params.evidence.identityLevelSnapshot),
        ],
        ["Organization / Workspace", buildOrganizationDisplay(params.evidence)],
        ["Organization Status", buildOrganizationStatus(params.evidence)],
      ]);

      doc.moveDown(0.12);

      drawCallout(doc, {
        title: "Fingerprint structure summary",
        body: buildFingerprintNarrative(parsedFingerprintSummary, contentSummary),
        tone: "neutral",
      });

      if (externalMode) {
        drawCallout(doc, {
          title: "External report note",
          body:
            "This external report includes reviewer-facing technical summaries only. Deep technical materials should be reviewed through the technical verification workflow or verification package when required.",
          tone: "neutral",
        });
      }

      monospaceStrip(doc, "File SHA-256", safe(params.evidence.fileSha256));
      monospaceStrip(
        doc,
        "Fingerprint Hash",
        safe(params.evidence.fingerprintHash)
      );

      if (!externalMode) {
        monospaceStrip(
          doc,
          "Signing Key Reference",
          buildPublicSigningKeyReference(
            params.evidence.signingKeyId,
            params.evidence.signingKeyVersion
          )
        );
        monospaceStrip(
          doc,
          "Signature (Base64) (excerpt)",
          safe(params.evidence.signatureBase64),
          { maxChars: 260 }
        );
        monospaceStrip(
          doc,
          "Public Key (PEM) (excerpt)",
          safe(params.evidence.publicKeyPem),
          { maxChars: 260 }
        );
      } else {
        drawCallout(doc, {
          title: "Technical signature materials",
          body:
            "Detailed signature materials and public-key verification artifacts remain available through the technical verification workflow and verification package, where enabled. They are not reproduced in full in this reviewer-facing report.",
          tone: "neutral",
        });
      }

      ensureSpace(doc, 220);

      doc.save();
      doc.fillColor(BRAND.ink).font("Helvetica-Bold").fontSize(10.6);
      doc.text("RFC 3161 Time Stamping Authority", doc.page.margins.left, doc.y);
      doc.restore();
      doc.moveDown(0.14);

      kvGrid(doc, [
        ["Timestamp Provider", safe(params.evidence.tsaProvider)],
        ["Timestamp URL", summarizeText(safe(params.evidence.tsaUrl), 84)],
        ["Serial Number", safe(params.evidence.tsaSerialNumber)],
        ["Generation Time (UTC)", safe(params.evidence.tsaGenTimeUtc)],
        ["Hash Algorithm", safe(params.evidence.tsaHashAlgorithm)],
        [
          "Timestamp Status",
          mapTimestampStatusPublicLabel(params.evidence.tsaStatus),
        ],
      ]);

      if (!externalMode) {
        monospaceStrip(
          doc,
          "Timestamp Message Imprint",
          safe(params.evidence.tsaMessageImprint),
          { maxChars: 140 }
        );
      }

      if (!externalMode && params.evidence.tsaTokenBase64) {
        monospaceStrip(
          doc,
          "Timestamp Token (Base64) (excerpt)",
          safe(params.evidence.tsaTokenBase64),
          { maxChars: 220 }
        );
      }

      if (params.evidence.otsStatus || params.evidence.otsHash) {
        ensureSpace(doc, 180);

        doc.save();
        doc.fillColor(BRAND.ink).font("Helvetica-Bold").fontSize(10.6);
        doc.text("OpenTimestamps", doc.page.margins.left, doc.y);
        doc.restore();
        doc.moveDown(0.14);

        kvGrid(doc, [
          ["OTS Status", mapOtsStatusPublicLabel(params.evidence.otsStatus)],
          ["OTS Calendar", safe(params.evidence.otsCalendar)],
          ["OTS Anchored At (UTC)", safe(params.evidence.otsAnchoredAtUtc)],
          ["OTS Upgraded At (UTC)", safe(params.evidence.otsUpgradedAtUtc)],
          [
            "OTS Bitcoin TxID",
            !externalMode
              ? safe(params.evidence.otsBitcoinTxid)
              : shortHash(params.evidence.otsBitcoinTxid),
          ],
        ]);

        if (!externalMode && params.evidence.otsHash) {
          monospaceStrip(doc, "OTS Hash", safe(params.evidence.otsHash), {
            maxChars: 180,
          });
        }

        if (!externalMode && params.evidence.otsProofBase64) {
          monospaceStrip(
            doc,
            "OTS Proof (Base64) (excerpt)",
            safe(params.evidence.otsProofBase64),
            { maxChars: 220 }
          );
        }

        if (params.evidence.otsFailureReason) {
          if (!externalMode) {
            monospaceStrip(
              doc,
              "OTS Failure / Detail",
              summarizeText(safe(params.evidence.otsFailureReason), 160),
              { maxChars: 160 }
            );
          } else {
            drawCallout(doc, {
              title: "Anchoring detail",
              body:
                "Additional anchoring failure details are available through the technical verification workflow.",
              tone: "warning",
            });
          }
        }
      }

      if (anchorSummary) {
        ensureSpace(doc, 160);

        doc.save();
        doc.fillColor(BRAND.ink).font("Helvetica-Bold").fontSize(10.6);
        doc.text("External Anchoring", doc.page.margins.left, doc.y);
        doc.restore();
        doc.moveDown(0.14);

        kvGrid(doc, [
          ["Anchor Mode", mapAnchorModePublicLabel(anchorSummary.mode)],
          ["Anchor Provider", safe(anchorSummary.provider)],
          ["Anchor Anchored At (UTC)", safe(anchorSummary.anchoredAtUtc)],
          [
            "Anchor Public URL",
            summarizeText(safe(anchorSummary.publicUrl), 84),
          ],
          [
            "Anchor Receipt ID",
            !externalMode ? safe(anchorSummary.receiptId) : shortHash(anchorSummary.receiptId),
          ],
          [
            "Anchor Transaction ID",
            !externalMode ? safe(anchorSummary.transactionId) : shortHash(anchorSummary.transactionId),
          ],
        ]);

        if (!externalMode) {
          monospaceStrip(doc, "Anchor Hash", safe(anchorSummary.anchorHash), {
            maxChars: 180,
          });
        }
      }
    },
    { minSpace: 120 }
  );

  if (includeTechnicalQr) {
    const qrBuf = await tryGenerateQrPngBuffer(technicalUrl);
    if (qrBuf) {
      drawQrBlock(doc, {
        title: "Technical materials",
        qrBuffer: qrBuf,
        size: 100,
        caption:
          "Scan to open the technical verification view for this evidence record.",
        urlText: buildVerificationLinkLabel("technical"),
        urlLink: technicalUrl,
      });
    }
  }

  section(
    doc,
    "Legal Limitations & Review Use",
    () => {
      safeParagraph(
        doc,
        "This section states what this report does and does not establish. It is intentionally separated from both the evidence-content section and the technical appendix to reduce legal ambiguity.",
        { fontSize: 9.3, color: BRAND.muted }
      );
      doc.moveDown(0.12);

      drawCallout(doc, {
        title: "What this report supports",
        body:
          "This report supports review of the recorded evidence content, the recorded integrity state, the custody chronology, timestamp records, anchoring records, and storage-protection indicators included in the system record.",
        tone: "success",
      });

      drawCallout(doc, {
        title: "What this report does not independently prove",
        body: legalLimitations.detailed,
        tone: "warning",
      });

      drawCallout(doc, {
        title: "Correct review posture",
        body:
          "Review the evidence content itself, then review the integrity materials that protect the recorded state of that content, then assess legal relevance, authenticity disputes, authorship, context, and admissibility under the applicable procedure.",
        tone: "neutral",
      });

      drawCallout(doc, {
        title: "Embedded previews are reviewer representations",
        body:
          "Any embedded image, document snapshot, or other reviewer-facing representation in this report is included to support human review of the preserved evidence item. It should not be treated as a substitute for the preserved original file when deeper review, expert comparison, or formal legal process requires the underlying evidence.",
        tone: "warning",
      });
    },
    { minSpace: 140 }
  );

  const forensicBlockHeight = estimateForensicIntegrityStatementHeight(doc, {
    verifyUrl,
    structureLabel,
    externalMode,
  });

  ensurePageWithHeader(doc, forensicBlockHeight + 40);

  section(
    doc,
    "Forensic Integrity Statement",
    () => {
      renderForensicIntegrityStatement(doc, {
        verifyUrl,
        structureLabel,
        externalMode,
      });
    },
    { minSpace: 140 }
  );

  addFooters(doc, {
    generatedAtUtc: params.generatedAtUtc,
    reportVersion: params.version,
  });

  const endPromise = new Promise<void>((resolve, reject) => {
    doc.once("end", resolve);
    doc.once("error", reject);
  });

  doc.end();
  await endPromise;

  const pdf = Buffer.concat(chunks);
  return signPdfIfEnabled(pdf);
}
