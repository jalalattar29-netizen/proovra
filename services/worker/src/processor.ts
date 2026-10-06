import type { Job } from "bullmq";
import type { Readable } from "node:stream";
import * as prismaPkg from "@prisma/client";
import type { ReportTrustDecision } from "./report-v2/types.js";
import {
  buildTrustDecision,
  buildReportCanonicalMaterials,
} from "./report-v2/truth-model.js";
import type {
  Prisma,
  CertificationType,
  CertificationStatus,
} from "@prisma/client";
import {
  CertificationType as PrismaCertificationType,
} from "@prisma/client";
import {
  extractPreviewForAsset,
  type ExtractedPreview,
} from "./preview/extract.js";
// PHASE 6 §9.7 (2026-07-22) — purge-time legal-hold re-check (4B holds).
import { evaluateEffectiveLegalHold } from "@proovra/shared-runtime";
// EVIDENCE LIFECYCLE CONVERGENCE (2026-08-24) — the ONE destruction executor
// and the ONE approval rule. The purge job is a trigger for them now.
import {
  executeEvidenceDestruction,
  generateVerificationShareToken,
  mintVerificationShareTokenTx,
  resolveDestructionApproval,
} from "@proovra/shared-runtime";
import { workerEvidenceDestructionStorage } from "./governance/destruction-storage-port.js";
import {
  assertWorkspaceAllowsReportArtifact,
  assertWorkspaceAllowsVerificationPackageArtifact,
  resolveEffectivePlanForEvidence,
} from "./workspace-billing.js";
import {
  OUTPUT_ENTITLEMENT_UNRESOLVED,
  resolveEvidenceOutputIssuance,
} from "./output-issuance.js";
import {
  type EvidenceAssetKind as ReportEvidenceAssetKind,
  type EvidenceContentSummary as ReportEvidenceContentSummary,
  type EvidenceDisplayDescriptor as ReportEvidenceDisplayDescriptor,
  type EvidencePreviewPolicy as ReportPreviewPolicy,
  type EvidenceContentAccessPolicy,
  resolveEvidenceContentAccessPolicyForSurface,
  resolveEvidenceTitle,
  detectEvidenceAssetKind,
  isPreviewableEvidenceKind,
  extensionFromMimeType,
  basenameFromStorageKey,
  getEvidencePartDisplayLabel,
  formatBytesForDisplay,
  buildContentCompositionSummary,
  buildPrimaryContentLabel,
  buildEvidenceDisplayDescriptor,
  buildEvidencePreviewPolicy,
} from "@proovra/shared-evidence-presentation";
import {
  compareReviewerArtifactRolePriority,
  classifyCustodyEventType,
  evaluateRecordedIntegrityPromotion,
  getReviewerEvidenceCategories,
  getReviewerEvidenceTypeLabel,
  getReviewerUploadModeLabel,
  isPrimaryReviewerArtifactRole,
  resolveReviewerArtifactRole,
  JOB_NAMES,
  absoluteInternalUrl,
  internalResourcePath,
  // COMMERCIAL CLOSURE (2026-09-08) — the SHARED classifier for "this failure
  // was a commercial denial, not an operational fault".
  isCommerciallyObsoleteTerminalReason,
  type ReviewerArtifactRole,
  type ReviewerArtifactRoleSource,
  // UC-0 — the acquisition authority.
  resolveEvidenceAcquisition,
  compareTimestampDigest,
  isCompleteOtsAnchor,
  presentedTsaStatus,
  custodyLabelHints,
} from "@proovra/shared";
import { appendCustodyEventTx, evaluateCustodyChain } from "./custody-events.js";
import { custodyThroughIssuance } from "./custody-issuance-cutoff.js";
import {
  EVIDENCE_TOO_LARGE_FOR_PROCESSING,
  exceedsProcessingCeiling,
  sumPartBytes,
} from "./evidence-processing-bounds.js";
import { appendWorkerAnalyticsEvent } from "./analytics-events.js";
import { recordWorkerIncident } from "./governance/incident-emitter.js";
import { prisma } from "./db.js";
import { env } from "./config.js";
import { logger, withJobContext } from "./logger.js";
// `deleteObject` is deliberately NOT imported here any more. This module used
// to delete evidence objects during the purge; it no longer performs physical
// deletion at all, and the canonical executor reaches storage through the
// injected port in `governance/destruction-storage-port.ts`. Removing the
// import is not tidying — an unused deletion primitive in the worker's largest
// module is an invitation to re-open the second delete path this pass closed.
import {
  getObjectStream,
  headObject,
} from "./storage.js";
import {
  cleanupStagedTemp,
  type StagedPackage,
} from "./verification-package-staging.js";
// EVIDENCE OUTPUT LIFECYCLE (2026-09-29) — the one way a report PDF or a
// package ZIP is written: checksum-bound, retention in the same request,
// single-use key, read back by VersionId before a row may say READY.
import {
  StoragePublicationRejectedError,
  buildPublicationKey,
  publishImmutableArtifact,
  type PublishedArtifact,
} from "./immutable-publication.js";
import type { PackageSealResult } from "./verification-package.js";
import { createHash, createPublicKey, randomUUID, verify as verifySignature } from "node:crypto";
// Phase O1.5B — bounded integrity.signature.verify span on the
// Ed25519 verification of report signing artifacts.
// Phase O1.5C — report pipeline spans.
import { PROOVRA_SPAN_NAMES, withProovraSpan, withProovraSpanSync } from "./otel.js";
import {
  buildReportPdfV2,
  buildReportPdfV2WithSignatureOutcome,
} from "./report-v2/build-report-pdf.js";
import {
  resolveCustodyCapturePresentation,
  packageCustodyEntry,
} from "./report-v2/normalizers.js";
import { buildReportMediaIntelligence } from "./media-intelligence-report-bridge.js";
import { buildReportDerivedReview } from "./report-v2/derived-review-bridge.js";
import {
  buildReportTechnicalSummary,
  buildReportAcquisitionContext,
} from "./report-technical-summary-bridge.js";
import { buildVerificationPackageIntelligence } from "./verification-package-intelligence-bridge.js";
import {
  enqueueEvidencePurgeJob,
  reportDlqQueue,
} from "./queue.js";
import { captureException } from "./sentry.js";
import { createVerificationPackage, PackageGateDeniedError } from "./verification-package.js";
import { loadProvenanceChainForPackage } from "./capture-trust/load-provenance-chain.js";
import { appendWorkerAuditLog } from "./platform-audit-append.js";
import { recheckEvidenceIntegrity, recordIntegrityObservation } from "./integrity-recheck.js";
import { compositeSha256, sha256HexFromStream } from "@proovra/shared-runtime";
import { resolveExpectedOriginalDigest } from "./integrity-recheck.js";
// PHASE 12 — POINT 5: the payload carries a request id; the authority is a row.
import { decodeCanonicalJob } from "./canonical-job.js";
import {
  markRequestRetryable,
  markRequestTerminal,
  claimFenceWhere,
  recordRequestProgress,
  ReportClaimLost,
  mintRequestForLegacyJob,
  resolveAndClaimReportRequest,
  type ResolvedReportCommand,
} from "./report-generation-authority.js";

type WorkerError = Error & {
  code: string;
  retriable: boolean;
};

type VerificationEvidenceFile = {
  /** UC-0 — EvidencePart.artifactClass. */
  artifactClass?: string | null;
  name: string;
  /** Optional: ORIGINAL parts are streamed from storage, not buffered. */
  buffer?: Buffer | null;
  sha256?: string | null;
  mimeType?: string | null;
  sizeBytes?: number | null;
  originalFileName?: string | null;
  partIndex?: number | null;
  storageBucket?: string | null;
  storageKey?: string | null;
  /** ET-PKG-15 — the sealed version, streamed into the package. */
  storageVersionId?: string | null;
  storageRegion?: string | null;
  storageObjectLockMode?: string | null;
  storageObjectLockRetainUntilUtc?: string | null;
  storageObjectLockLegalHoldStatus?: string | null;
  artifactRole?: ReviewerArtifactRole | null;
  artifactRoleSource?: ReviewerArtifactRoleSource | null;
  checklistStepId?: string | null;
  checklistStepLabel?: string | null;
  sourceLabel?: string | null;
};

type LoadedEvidenceArtifact = {
  id: string;
  partIndex: number;
  label: string;
  originalFileName: string | null;
  mimeType: string | null;
  kind: ReportEvidenceAssetKind;
  // Report byte-loading closure: ORIGINAL bytes are NOT held here. The preview loop
  // fetches ONE artifact at a time from storage, so peak memory is one part.
  storageBucket: string;
  storageKey: string;
};

type VerificationPackageArtifactPresence = {
  manifestPresent: boolean;
  signedManifestPresent: boolean;
  checksumIndexPresent: boolean;
  auditExportIncluded?: boolean;
  custodyExportIncluded?: boolean;
  accessExportIncluded?: boolean;
};

type EvidenceStorageSnapshot = {
  storageRegion: string | null;
  storageObjectLockMode: string | null;
  storageObjectLockRetainUntilUtc: string | null;
  storageObjectLockLegalHoldStatus: string | null;
  storageImmutable: boolean;
};

type IdentitySnapshot = {
  verificationStatus: prismaPkg.VerificationStatus;
  captureMethod: prismaPkg.CaptureMethod;
  identityLevelSnapshot: prismaPkg.IdentityLevel;
  submittedByEmail: string | null;
  submittedByAuthProvider: prismaPkg.AuthProvider | null;
  submittedByUserId: string | null;
  createdByUserId: string | null;
  uploadedByUserId: string | null;
  workspaceNameSnapshot: string | null;
  organizationNameSnapshot: string | null;
  organizationVerifiedSnapshot: boolean | null;
  reviewerSummaryVersion: number;
  /**
   * Phase 2 canonical workspace-scope inputs captured at preparation
   * time. `workspaceIsPersonal=true` means the attached Team row is
   * a personal-account workspace; non-null `teamId` alone is NOT a
   * signal of enterprise team governance because personal workspaces
   * are stored as Team rows.
   */
  workspaceIsPersonal: boolean | null;
  workspaceLabelAtPackageTime: string | null;
};

type ReportCertificationSnapshot = {
  declarationType: "CUSTODIAN" | "QUALIFIED_PERSON";
  status: "DRAFT" | "REQUESTED" | "ATTESTED" | "REVOKED";
  version: number;
  requestedAtUtc: string | null;
  requestedByUserId: string | null;
  attestedAtUtc: string | null;
  attestedByUserId: string | null;
  attestorName: string | null;
  attestorTitle: string | null;
  attestorEmail: string | null;
  attestorOrganization: string | null;
  statementMarkdown: string | null;
  statementSnapshot: unknown;
  signatureText: string | null;
  certificationHash: string | null;
  revokedAtUtc: string | null;
  revokedByUserId: string | null;
  revokeReason: string | null;
};

type ReportEvidenceAsset = {
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
  previewRole:
    | "primary_preview"
    | "secondary_preview"
    | "download_only"
    | "metadata_only";
  embedPreference:
    | "image"
    | "pdf_first_page"
    | "audio_placeholder"
    | "video_placeholder"
    | "text_excerpt"
    | "metadata_only";
  artifactRole: "primary_evidence" | "supporting_evidence" | "attachment";
  artifactRoleSource: ReviewerArtifactRoleSource;
  checklistStepId: string | null;
  checklistStepLabel: string | null;
  originalPreservationNote: string;
  reviewerRepresentationLabel: string;
  reviewerRepresentationNote: string;
  verificationMaterialsNote: string;
  previewDataUrl: string | null;
  previewTextExcerpt: string | null;
  previewCaption: string | null;
};

type ReportReviewGuidance = {
  reviewerWorkflow: string[];
  contentReviewNote: string;
  legalAssessmentNote: string;
  integrityAssessmentNote: string;
  multipartReviewNote: string;
};

type ReportLegalLimitations = {
  short: string;
  detailed: string;
};

type ReportAnchorSummary = {
  mode: "off" | "ready" | "active";
  provider: string | null;
  configured: boolean;
  anchorHash: string | null;
  transactionId: string | null;
  anchoredAtUtc: string | null;
};

type PreparedAnchorPayload = {
  version: 1;
  evidenceId: string;
  reportVersion: number;
  fileSha256: string;
  fingerprintHash: string;
  lastEventHash: string | null;
  anchorHash: string;
  generatedAtUtc: string;
  transactionId?: string | null;
  anchoredAtUtc?: string | null;
  /** The record's OTS state and how its anchor was established (2026-09-29). */
  otsStatus?: string | null;
  otsAnchorCheck?: string | null;
};

type ReportBuildParams = {
  evidence: Parameters<typeof buildReportPdfV2>[0]["evidence"];
  custodyEvents: Parameters<typeof buildReportPdfV2>[0]["custodyEvents"];
  version: number;
  generatedAtUtc: string;
  buildInfo?: string | null;
  verifyUrl?: string | null;
  downloadUrl?: string | null;
  externalMode?: boolean;
  // Phase 31.11 — OPTIONAL projection passed through to the
  // renderer. NULL = legacy byte-identical output.
  mediaIntelligence?: Parameters<typeof buildReportPdfV2>[0]["mediaIntelligence"];
  // Enterprise Technical Metadata layer — OPTIONAL compact technical
  // summary. NULL = no "Media Technical Summary" section.
  technicalSummary?: Parameters<typeof buildReportPdfV2>[0]["technicalSummary"];
  // Evidence Acquisition context — OPTIONAL public-safe acquisition
  // table in the Executive Summary. NULL = no acquisition table.
  acquisition?: Parameters<typeof buildReportPdfV2>[0]["acquisition"];
  // UC-4 — OPTIONAL bounded DERIVED screen-review summary. NULL = no section.
  derivedReview?: Parameters<typeof buildReportPdfV2>[0]["derivedReview"];
  /** UC-OUT-001 — the record's publication state at issuance. */
  publicVerificationPublished?: boolean;
  /** UC-PROV-003 — validated capture-manifest facts. */
  captureManifest?: Parameters<typeof buildReportPdfV2>[0]["captureManifest"];
  /** UC-TRUST-008 — the exact stored bytes this report certifies. */
  certifiedOriginal?: Parameters<typeof buildReportPdfV2>[0]["certifiedOriginal"];
};

type PreparedReportArtifacts = {
  reportPdf: Buffer;
  // Phase A2 — bounded outcome of the PDF artifact signing step.
  // Persisted on the Report row so the API can surface artifact
  // trust without inferring from labels. Always non-null; the
  // worker chooses one of SIGNED / UNSIGNED_OPT_OUT /
  // SIGNING_UNAVAILABLE.
  pdfSigningOutcome: import("./pdf/signPdf.js").PdfSigningOutcome;
  verificationZip: Buffer | null;
  verifyUrl: string;
  /** ET-PKG-07 — the share token inside `verifyUrl`; stored (hashed) when the report commits. */
  reportShareToken: string;
  /**
   * UC-OUT-001 — was the record PUBLISHED when this report was prepared? Only
   * then is a REPORT link minted and printed; a private record's report says
   * "Not published — the owner can create a verification link".
   */
  publicVerifyPublishedAtIssuance: boolean;
  downloadUrl: string;
    packageMetadataContext: {
    caseId: string | null;
    caseName: string | null;
    /** Organization-supplied customer identifier; null unless intake. */
    customerId: string | null;
    retentionPolicy: string | null;
    workspaceId: string | null;
    organizationId: string | null;
    teamId: string | null;
    ownerUserId: string | null;
  };
  reportKey: string;
  verificationKey: string;
  version: number;
  now: Date;
  evidenceId: string;
  evidenceStorage: EvidenceStorageSnapshot;
  fingerprintCanonicalJson: string;
  identitySnapshot: IdentitySnapshot;
  effectivePlan: prismaPkg.PlanType;

  display: ReportEvidenceDisplayDescriptor;
  reviewGuidance: ReportReviewGuidance;
  contentAccessPolicy: EvidenceContentAccessPolicy;
  contentSummary: ReportEvidenceContentSummary;
  contentItems: ReportEvidenceAsset[];
  primaryContentItem: ReportEvidenceAsset | null;
  previewPolicy: ReportPreviewPolicy;
  contentCompositionSummary: string | null;
  primaryContentLabel: string | null;
  defaultPreviewItemId: string | null;
  limitations: ReportLegalLimitations;
  verificationEvidenceFiles: VerificationEvidenceFile[];
  verificationPackageIncluded: boolean;
  anchorSummary: ReportAnchorSummary | null;
    custodyForVerificationPackage: Array<{
    sequence: number;
    atUtc: string;
    eventType: string;
    payload: unknown;
    prevEventHash: string | null;
    eventHash: string | null;
  }>;

reportEvidencePayload: ReportBuildParams["evidence"];
trustDecision: ReportTrustDecision;
  certifications: {
    custodian: ReportCertificationSnapshot | null;
    qualifiedPerson: ReportCertificationSnapshot | null;
  };
};

function toReportCertificationSnapshot(
  item:
    | {
        declarationType: CertificationType;
        status: CertificationStatus;
        version: number;
        requestedAtUtc: Date | null;
        requestedByUserId: string | null;
        attestedAtUtc: Date | null;
        attestedByUserId: string | null;
        attestorName: string | null;
        attestorTitle: string | null;
        attestorEmail: string | null;
        attestorOrganization: string | null;
        statementMarkdown: string | null;
        statementSnapshot: unknown;
        signatureText: string | null;
        certificationHash: string | null;
        revokedAtUtc: Date | null;
        revokedByUserId: string | null;
        revokeReason: string | null;
      }
    | null
): ReportCertificationSnapshot | null {
  if (!item) return null;

  return {
    declarationType: item.declarationType,
    status: item.status,
    version: item.version,
    requestedAtUtc: item.requestedAtUtc?.toISOString() ?? null,
    requestedByUserId: item.requestedByUserId ?? null,
    attestedAtUtc: item.attestedAtUtc?.toISOString() ?? null,
    attestedByUserId: item.attestedByUserId ?? null,
    attestorName: item.attestorName ?? null,
    attestorTitle: item.attestorTitle ?? null,
    attestorEmail: item.attestorEmail ?? null,
    attestorOrganization: item.attestorOrganization ?? null,
    statementMarkdown: item.statementMarkdown ?? null,
    statementSnapshot: item.statementSnapshot,
    signatureText: item.signatureText ?? null,
    certificationHash: item.certificationHash ?? null,
    revokedAtUtc: item.revokedAtUtc?.toISOString() ?? null,
    revokedByUserId: item.revokedByUserId ?? null,
    revokeReason: item.revokeReason ?? null,
  };
}

function envValue(name: string, fallback?: string): string {
  const raw = process.env[name];
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (trimmed) return trimmed;
  if (typeof fallback === "string") return fallback;
  throw new Error(`${name} is not set`);
}

function buildPublicUrl(key: string): string | null {
  if (!env.S3_PUBLIC_BASE_URL) return null;
  return `${env.S3_PUBLIC_BASE_URL.replace(/\/+$/, "")}/${key}`;
}

// PHASE 11 — the /verify/:id surface is a public, unauthenticated
// verification page (route: apps/web/app/verify/[token]/page.tsx). It
// predates and sits outside the canonical INTERNAL_RESOURCE_TYPES /
// PUBLIC_PREFIXES vocabulary in @proovra/shared's tenant-url module, so
// it composes its base + path via `absoluteInternalUrl` (which accepts
// any relative path) rather than `internalResourcePath`. The link
// carries only an opaque share token — never the evidence id, and never a
// tenant/workspace id from the job payload.
//
// ET-PKG-07 (2026-09-30) — this took the EVIDENCE ID. A report's link and QR
// code therefore carried the record's primary key as a permanent public
// capability. It now takes the share token minted for this report version
// (see `reportShareToken` in prepareReportArtifacts): revocable and rotatable
// on its own, and inert until the owner publishes the record.
function buildVerifyUrl(shareToken: string): string {
  const base = envValue(
    "REPORT_VERIFY_BASE_URL",
    "https://app.proovra.com/verify"
  ).replace(/\/+$/, "");

  return absoluteInternalUrl(base, `/${encodeURIComponent(shareToken)}`);
}

// PHASE 11 — canonical resource-id path for the authenticated evidence
// detail page. Only the persisted evidence id is carried; no tenant
// param.
function buildEvidenceDetailUrl(evidenceId: string): string {
  const base = envValue("REPORT_APP_BASE_URL", "https://app.proovra.com").replace(
    /\/+$/,
    ""
  );
  return absoluteInternalUrl(
    base,
    internalResourcePath({ type: "evidence", id: evidenceId })
  );
}

function normalizePayloadPrimitive(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const t = value.trim();
    return t || null;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return null;
}

export function summarizePayloadForReport(
  eventType: string,
  payload: unknown,
  context?: {
    itemCount?: number | null;
    structure?: "single" | "multipart" | null;
    isIntake?: boolean;
    /** UC-0 — the record's acquisition snapshot; drives the method label. */
    acquisitionMode?: string | null;
  }
): string {
  const event = String(eventType || "").toUpperCase();

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    switch (event) {
      case "VERIFY_VIEWED":
        return "Public verification page viewed.";
      case "REPORT_GENERATED":
        return "Verification report generated.";
      case "VERIFICATION_PACKAGE_GENERATED":
        return "Verification package generated.";
      case "VERIFICATION_PACKAGE_DOWNLOADED":
        return "Verification package downloaded.";
      case "TECHNICAL_VERIFICATION_CHECKED":
        return "Technical verification checked.";
      case "REVIEW_READY":
        return "Evidence marked review ready.";
      case "IDENTITY_SNAPSHOT_RECORDED":
        return "Identity snapshot recorded.";
      case "EVIDENCE_VIEWED":
        return "Protected evidence file accessed.";
      case "TIMESTAMP_APPLIED":
        return "Trusted timestamp applied.";
      case "TIMESTAMP_FAILED":
        return "Timestamp request failed.";
      case "OTS_APPLIED":
        return "OpenTimestamp proof created.";
      case "OTS_FAILED":
        return "OpenTimestamp proof creation failed.";
      default:
        return "No structured event details recorded.";
    }
  }

  const obj = payload as Record<string, unknown>;

  switch (event) {
    case "EVIDENCE_CREATED":
      return "Evidence record created.";

    case "UPLOAD_STARTED":
    case "UPLOAD_AUTHORIZED": {
      // Both events represent the same intake moment (legacy vs current name).
      // The honest meaning is: a presigned upload URL was issued / the storage
      // location was reserved. Bytes are NOT yet confirmed at the storage layer.
      const uploadMode = getReviewerUploadModeLabel({
        itemCount: context?.itemCount ?? null,
        structure: context?.structure ?? null,
        rawMode:
          normalizePayloadPrimitive(obj.mode) ??
          normalizePayloadPrimitive(obj.uploadKind),
      });
  return [
    "Upload authorization recorded (presigned URL issued; bytes not yet confirmed)",
    uploadMode ? `Mode: ${uploadMode}` : null,
  ]
    .filter(Boolean)
    .join(" • ");
}

    case "UPLOAD_COMPLETED": {
      const multipart = obj.multipart === true;
      const itemCountValue =
        typeof obj.itemCount === "number" && Number.isFinite(obj.itemCount)
          ? obj.itemCount
          : null;
      const itemCount = itemCountValue !== null ? String(itemCountValue) : null;
      const sizeBytes = normalizePayloadPrimitive(obj.sizeBytes);
const hash = normalizePayloadPrimitive(obj.fileSha256);

      const completionLabel =
        itemCountValue !== null
          ? itemCountValue <= 1
            ? "Single evidence item completed"
            : "Multipart evidence package completed"
          : multipart
            ? "Multipart evidence package completed"
            : "Single evidence item completed";

      return [
        completionLabel,
        itemCount ? `Items: ${itemCount}` : null,
        sizeBytes ? `Size: ${sizeBytes} bytes` : null,
        hash ? `Hash: ${hash}` : null,
      ]
        .filter(Boolean)
        .join(" • ");
    }

    case "SIGNATURE_APPLIED": {
      const signingKeyId = normalizePayloadPrimitive(obj.signingKeyId);
      const signingKeyVersion = normalizePayloadPrimitive(obj.signingKeyVersion);
const fingerprintHash = normalizePayloadPrimitive(obj.fingerprintHash);
      const tsaStatus = normalizePayloadPrimitive(obj.tsaStatus);
      const tsaProvider = normalizePayloadPrimitive(obj.tsaProvider);

      return [
        "Cryptographic signature applied",
        signingKeyId ? `Key: ${signingKeyId}` : null,
        signingKeyVersion ? `Version: ${signingKeyVersion}` : null,
        fingerprintHash ? `Fingerprint: ${fingerprintHash}` : null,
        tsaStatus ? `Timestamp: ${tsaStatus}` : null,
        tsaProvider ? `TSA: ${tsaProvider}` : null,
      ]
        .filter(Boolean)
        .join(" • ");
    }

    case "TIMESTAMP_APPLIED": {
      const tsaStatus = normalizePayloadPrimitive(obj.tsaStatus);
      const tsaProvider = normalizePayloadPrimitive(obj.tsaProvider);
      const serial = normalizePayloadPrimitive(obj.tsaSerialNumber);
      return [
        "Trusted timestamp applied",
        tsaStatus ? `Status: ${tsaStatus}` : null,
        tsaProvider ? `TSA: ${tsaProvider}` : null,
        serial ? `Serial: ${serial}` : null,
      ]
        .filter(Boolean)
        .join(" • ");
    }

case "TIMESTAMP_FAILED": {
  const tsaStatus = normalizePayloadPrimitive(obj.tsaStatus);

  return [
    "Trusted timestamp could not be obtained",
    tsaStatus ? `Status: ${tsaStatus}` : null,
    "Reviewer should rely on the recorded digest, signature, custody history, and available verification materials.",
  ]
    .filter(Boolean)
    .join(" • ");
}

    case "OTS_APPLIED": {
      const otsStatus = normalizePayloadPrimitive(obj.otsStatus);
      const otsPhase = normalizePayloadPrimitive(obj.otsPhase);
      const bitcoinTxid = normalizePayloadPrimitive(obj.bitcoinTxid);
      const calendar = normalizePayloadPrimitive(obj.calendar);
      return [
        otsPhase === "anchored"
          ? "OpenTimestamp anchoring completed"
          : "OpenTimestamp proof created",
        otsStatus ? `Status: ${otsStatus}` : null,
        bitcoinTxid ? `Bitcoin Tx: ${bitcoinTxid}` : null,
        calendar ? `Calendar: ${calendar}` : null,
      ]
        .filter(Boolean)
        .join(" • ");
    }

    case "OTS_FAILED": {
      const reason = normalizePayloadPrimitive(obj.failureReason);
      return [
        "OpenTimestamp proof creation failed",
        reason ? `Reason: ${reason}` : null,
      ]
        .filter(Boolean)
        .join(" • ");
    }

    case "REPORT_GENERATED": {
      const reportVersion = normalizePayloadPrimitive(obj.reportVersion);
      const refreshReason = normalizePayloadPrimitive(obj.refreshReason);
      const verificationStatusSnapshot = normalizePayloadPrimitive(
        obj.verificationStatusSnapshot
      );
      const captureMethodSnapshot = normalizePayloadPrimitive(
        obj.captureMethodSnapshot
      );
      const identityLevelSnapshot = normalizePayloadPrimitive(
        obj.identityLevelSnapshot
      );

      // Role-safe capture presentation. The raw snapshot is the STRUCTURE
      // enum (MULTIPART_PACKAGE) after `completeEvidence`; render the
      // reviewer-facing method ("Secure Intake Link" / "PROOVRA Web Upload")
      // and the structure ("Multipart evidence package") separately — never
      // the raw enum as the "Capture:" label.
      const capturePresentation = captureMethodSnapshot
        ? resolveCustodyCapturePresentation(captureMethodSnapshot, {
            acquisitionMode: context?.acquisitionMode ?? null,
            isIntake: context?.isIntake === true,
          })
        : { method: null, structure: null };

      return [
        reportVersion
          ? `Verification report generated • Version: ${reportVersion}`
          : "Verification report generated.",
        verificationStatusSnapshot
          ? `Verification: ${verificationStatusSnapshot}`
          : null,
        capturePresentation.method
          ? `Capture: ${capturePresentation.method}`
          : null,
        capturePresentation.structure
          ? `Structure: ${capturePresentation.structure}`
          : null,
        identityLevelSnapshot ? `Identity: ${identityLevelSnapshot}` : null,
        refreshReason ? `Refresh: ${refreshReason}` : null,
      ]
        .filter(Boolean)
        .join(" • ");
    }

    case "VERIFICATION_PACKAGE_GENERATED": {
      const version = normalizePayloadPrimitive(obj.version);
      const packageType = normalizePayloadPrimitive(obj.packageType);
      return [
        "Verification package generated",
        version ? `Version: ${version}` : null,
        packageType ? `Type: ${packageType}` : null,
      ]
        .filter(Boolean)
        .join(" • ");
    }

    case "VERIFICATION_PACKAGE_DOWNLOADED": {
      const version = normalizePayloadPrimitive(obj.version);
      return version
        ? `Verification package downloaded • Version: ${version}`
        : "Verification package downloaded.";
    }

    case "TECHNICAL_VERIFICATION_CHECKED": {
      const source = normalizePayloadPrimitive(obj.source);
      const overallIntegrity = normalizePayloadPrimitive(obj.overallIntegrity);
      const verificationStatus = normalizePayloadPrimitive(obj.verificationStatus);
      const accessPolicyMode = normalizePayloadPrimitive(obj.accessPolicyMode);

      return [
        "Technical verification checked",
        source ? `Source: ${source}` : null,
        overallIntegrity ? `Overall integrity: ${overallIntegrity}` : null,
        verificationStatus ? `Status: ${verificationStatus}` : null,
        accessPolicyMode ? `Access policy: ${accessPolicyMode}` : null,
      ]
        .filter(Boolean)
        .join(" • ");
    }

    case "REVIEW_READY": {
      const reviewerSummaryVersion = normalizePayloadPrimitive(
        obj.reviewerSummaryVersion
      );
      return [
        "Evidence marked review ready",
        reviewerSummaryVersion
          ? `Reviewer summary version: ${reviewerSummaryVersion}`
          : null,
      ]
        .filter(Boolean)
        .join(" • ");
    }

    case "IDENTITY_SNAPSHOT_RECORDED": {
      const identityLevel = normalizePayloadPrimitive(obj.identityLevelSnapshot);
      const submittedByEmail = normalizePayloadPrimitive(obj.submittedByEmail);
      const authProvider = normalizePayloadPrimitive(obj.submittedByAuthProvider);
      return [
        "Identity snapshot recorded",
        identityLevel ? `Identity: ${identityLevel}` : null,
        submittedByEmail ? `Email: ${submittedByEmail}` : null,
        authProvider ? `Provider: ${authProvider}` : null,
      ]
        .filter(Boolean)
        .join(" • ");
    }

    case "REPORT_DOWNLOADED": {
      const reportVersion = normalizePayloadPrimitive(obj.reportVersion);
      return reportVersion
        ? `Report downloaded • Version: ${reportVersion}`
        : "Report downloaded.";
    }

    case "VERIFY_VIEWED":
      return "Public verification page viewed.";

    case "EVIDENCE_VIEWED":
      return "Protected evidence file accessed.";

    case "EVIDENCE_LOCKED":
      return "Object Lock retention applied to storage. Storage object cannot be altered or deleted before the retention deadline expires.";

    case "STORAGE_PROTECTION_UNAVAILABLE":
      return "Storage protection was attempted, but Object Lock retention was not actually applied. Treat storage immutability as not asserted for this record.";

    case "OTS_ATTEMPT_ERROR":
      return "An OpenTimestamps attempt was initiated but errored before a provider status was available.";

    case "REPORT_IDENTITY_CONTEXT_RECORDED":
      return "Identity context re-snapshotted at report generation for the report's reviewer audit context.";

    case "EVIDENCE_ARCHIVED":
      return "Evidence record archived.";

    case "EVIDENCE_RESTORED":
      return "Evidence record restored.";

    case "EVIDENCE_DELETED":
      return "Evidence record deleted.";

    case "EVIDENCE_CLAIMED":
      return "Guest evidence ownership claimed.";

    default: {
      const entries = Object.entries(obj)
        .filter(([key, value]) => {
          const lowered = key.toLowerCase();
          if (
            lowered.includes("bucket") ||
            lowered.includes("storagekey") ||
            lowered === "key" ||
            lowered.includes("token") ||
            lowered.includes("secret") ||
            lowered.includes("password") ||
            lowered.includes("lat") ||
            lowered.includes("lng") ||
            lowered.includes("accuracy") ||
            lowered.includes("ip") ||
            lowered.includes("useragent")
          ) {
            return false;
          }

          return (
            typeof value === "string" ||
            typeof value === "number" ||
            typeof value === "boolean"
          );
        })
        .slice(0, 5)
        .map(([key, value]) => `${key}: ${String(value)}`);

      return entries.length > 0
        ? entries.join(" • ")
        : "No structured event details recorded.";
    }
  }
}

function normalizeAnchorMode(
  value: string | null | undefined
): "off" | "ready" | "active" {
  const raw = String(value ?? "ready").trim().toLowerCase();
  if (raw === "off" || raw === "active") return raw;
  return "ready";
}

function verifyEd25519HexSignature(params: {
  messageHex: string;
  signatureBase64: string;
  publicKeyPem: string;
}): boolean {
  const normalizedHex = params.messageHex.trim().toLowerCase();

  if (!/^[a-f0-9]+$/.test(normalizedHex) || normalizedHex.length % 2 !== 0) {
    throw new Error("verifyEd25519HexSignature: messageHex must be valid hex");
  }

  const publicKeyPem = params.publicKeyPem.trim();
  if (!publicKeyPem.includes("BEGIN") || !publicKeyPem.includes("END")) {
    throw new Error("verifyEd25519HexSignature: publicKeyPem is invalid");
  }

  // Phase O1.5B — bounded integrity.signature.verify span. Algorithm
  // name + outcome only. NEVER the signature bytes, public key, or
  // message hex.
  return withProovraSpanSync(
    PROOVRA_SPAN_NAMES.INTEGRITY_SIGNATURE_VERIFY,
    {
      "proovra.operation": "integrity_signature_verify",
      "proovra.provider": "ed25519",
    },
    () =>
      verifySignature(
        null,
        Buffer.from(normalizedHex, "hex"),
        `${publicKeyPem}\n`,
        Buffer.from(params.signatureBase64, "base64")
      ),
  );
}

function resolveTimestampDigestMatch(params: {
  tsaStatus: string | null | undefined;
  tsaMessageImprint: string | null | undefined;
  tsaInputDigestHex: string | null | undefined;
  fileSha256: string;
}): boolean | null {
  // The ONE comparison (2026-09-29, shared with Public Verify): a missing
  // imprint is an unknown comparison — never the "timestamp digest mismatch"
  // blocker that kept a record from promotion without anything differing.
  return compareTimestampDigest({
    tsaStatus: params.tsaStatus,
    tsaMessageImprint: params.tsaMessageImprint,
    tsaInputDigestHex: params.tsaInputDigestHex,
    fileSha256: params.fileSha256,
  });
}

function resolveRecordedIntegrityPromotionDecision(params: {
  evidenceId: string;
  verificationStatus: prismaPkg.VerificationStatus | null;
  recordedIntegrityVerifiedAtUtc: Date | null;
  fileSha256: string;
  fingerprintCanonicalJson: string;
  fingerprintHash: string;
  signatureBase64: string;
  signingKeyId: string;
  tsaStatus: string | null;
  tsaMessageImprint: string | null;
  tsaInputDigestHex: string | null;
  otsStatus: string | null;
  otsHash: string | null;
  otsAnchoredAtUtc: string | Date | null;
  itemCount: number;
  multipartItemHashesPresent: boolean;
  publicKeyPem: string;
  verifiedAtUtc: Date;
  custodyEvents: Array<{
    sequence: number;
    atUtc: Date;
    eventType: prismaPkg.CustodyEventType;
    payload: Prisma.JsonValue | null;
    prevEventHash: string | null;
    eventHash: string | null;
  }>;
}): {
  qualifies: boolean;
  shouldPromote: boolean;
  blockers: string[];
  effectiveVerificationStatus: prismaPkg.VerificationStatus | null;
  effectiveRecordedIntegrityVerifiedAtUtc: string | null;
} {
  const recomputedFingerprintHash = createHash("sha256")
    .update(params.fingerprintCanonicalJson)
    .digest("hex");
  const canonicalHashMatches =
    recomputedFingerprintHash === params.fingerprintHash;

  let signatureValid = false;
  try {
    signatureValid = verifyEd25519HexSignature({
      messageHex: recomputedFingerprintHash,
      signatureBase64: params.signatureBase64,
      publicKeyPem: params.publicKeyPem,
    });
  } catch {
    signatureValid = false;
  }

  const custodyChain = evaluateCustodyChain({
    evidenceId: params.evidenceId,
    records: params.custodyEvents.map((event) => ({
      sequence: event.sequence,
      eventType: event.eventType,
      atUtc: event.atUtc,
      payload: event.payload,
      prevEventHash: event.prevEventHash,
      eventHash: event.eventHash,
    })),
  });

  const forensicCustodyEvents = params.custodyEvents.filter(
    (event) => classifyCustodyEventType(event.eventType) === "forensic"
  );
  const forensicCustodyHasHashChain = forensicCustodyEvents.some(
    (event) => Boolean(event.prevEventHash || event.eventHash)
  );

  const timestampDigestMatches = resolveTimestampDigestMatch({
    tsaStatus: params.tsaStatus,
    tsaMessageImprint: params.tsaMessageImprint,
    tsaInputDigestHex: params.tsaInputDigestHex,
    fileSha256: params.fileSha256,
  });

  const otsHashMatches =
    params.otsHash && params.fingerprintHash
      ? params.otsHash.toLowerCase() === params.fingerprintHash.toLowerCase()
      : null;

  const decision = evaluateRecordedIntegrityPromotion({
    evidence: {
      verificationStatus: params.verificationStatus,
      recordedIntegrityVerifiedAtUtc:
        params.recordedIntegrityVerifiedAtUtc?.toISOString() ?? null,
      fileSha256: params.fileSha256,
      fingerprintHash: params.fingerprintHash,
      signatureBase64: params.signatureBase64,
      signingKeyId: params.signingKeyId,
    },
    itemCount: params.itemCount,
    multipartItemHashesPresent: params.multipartItemHashesPresent,
    canonicalHashMatches,
    signatureValid,
    custodyChainValid: custodyChain.valid,
    forensicCustodyEventCount: forensicCustodyEvents.length,
    forensicCustodyHasHashChain,
    timestampDigestMatches,
    otsHashMatches,
  });

  const effectiveRecordedIntegrityVerifiedAtUtc = decision.qualifies
    ? params.recordedIntegrityVerifiedAtUtc?.toISOString() ??
      params.verifiedAtUtc.toISOString()
    : params.recordedIntegrityVerifiedAtUtc?.toISOString() ?? null;

  return {
    qualifies: decision.qualifies,
    shouldPromote: decision.shouldPromote,
    blockers: decision.blockers,
    effectiveVerificationStatus: decision.qualifies
      ? prismaPkg.VerificationStatus.RECORDED_INTEGRITY_VERIFIED
      : params.verificationStatus,
    effectiveRecordedIntegrityVerifiedAtUtc,
  };
}

/**
 * Exported for the partial-failure contract test. Behaviour unchanged: this is
 * the same private helper, given a name a test can reach so the package-failure
 * state transition can be asserted without standing up a signed fixture.
 */
/**
 * The workspace allowance refused the package: its plan does not include one,
 * or publishing it would exceed the workspace's storage. A commercial answer,
 * carried apart from pipeline failures so it never opens an incident or
 * burns the retry budget.
 */
export class PackageAllowanceRefusal extends Error {
  readonly code: "VERIFICATION_PACKAGE_NOT_INCLUDED" | "STORAGE_LIMIT_REACHED";
  constructor(code: "VERIFICATION_PACKAGE_NOT_INCLUDED" | "STORAGE_LIMIT_REACHED") {
    super(code);
    this.name = "PackageAllowanceRefusal";
    this.code = code;
  }
}

/** Errors the package path raised after its own incident was recorded. */
export function isPackageOwnedFailure(error: unknown): boolean {
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
  return (
    code.startsWith("VERIFICATION_PACKAGE_INCOMPLETE_") ||
    code === "VERIFICATION_PACKAGE_STORAGE_REJECTED"
  );
}

/** Classify an allowance-gate error; anything unrecognised stays a failure. */
export function toPackageAllowanceRefusal(error: unknown): unknown {
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
  if (code === "VERIFICATION_PACKAGE_NOT_INCLUDED" || code === "STORAGE_LIMIT_REACHED") {
    return new PackageAllowanceRefusal(code);
  }
  return error;
}

export function createWorkerError(code: string, retriable: boolean): WorkerError {
  const err = new Error(code) as WorkerError;
  err.code = code;
  err.retriable = retriable;
  return err;
}

function buildFinalizedAnchorPayload(params: {
  anchorMode: "off" | "ready" | "active";
  evidenceId: string;
  reportVersion: number;
  fileSha256: string;
  fingerprintHash: string;
  lastEventHash: string | null;
  generatedAtUtc: string;
  anchorSummary: ReportAnchorSummary | null;
  otsBitcoinTxid?: string | null;
  otsAnchoredAtUtc?: string | null;
  otsStatus?: string | null;
  otsAnchorCheck?: string | null;
}): PreparedAnchorPayload | null {
  if (params.anchorMode === "off") return null;

  return {
    version: 1,
    evidenceId: params.evidenceId,
    reportVersion: params.reportVersion,
    fileSha256: params.fileSha256,
    fingerprintHash: params.fingerprintHash,
    lastEventHash: params.lastEventHash,
    anchorHash: compositeSha256([
      params.evidenceId,
      String(params.reportVersion),
      params.fileSha256,
      params.fingerprintHash,
      params.lastEventHash ?? "",
    ]),
    generatedAtUtc: params.generatedAtUtc,
    transactionId:
      params.anchorSummary?.transactionId ?? params.otsBitcoinTxid ?? null,
    // (2026-09-29) The recorded anchor time travels whenever the record IS
    // anchored (status + time, the shared completeness rule). It used to be
    // dropped without a txid, so the manifest said "pending" beside an
    // opentimestamps.json that said anchored. A chain-checked claim still
    // needs the txid (resolveOtsAnchorClaim).
    anchoredAtUtc:
      params.anchorSummary?.anchoredAtUtc ??
      (isCompleteOtsAnchor({ status: params.otsStatus ?? null, anchoredAtUtc: params.otsAnchoredAtUtc ?? null })
        ? (params.otsAnchoredAtUtc ?? null)
        : null),
    otsStatus: params.otsStatus ?? null,
    otsAnchorCheck: params.otsAnchorCheck ?? null,
  };
}

/**
 * Exported for the partial-failure contract test. This predicate is what the
 * catch in processGenerateReport uses to choose FAILED_RETRYABLE over
 * FAILED_TERMINAL, so it is the exact decision the package-failure path turns
 * on.
 */
export function isRetriableError(error: unknown): boolean {
  if (error && typeof error === "object" && "retriable" in error) {
    return (error as WorkerError).retriable === true;
  }
  return true;
}

/**
 * The worker-error codes that mean "this record was not commercially entitled
 * to the output", as opposed to "the pipeline could not produce it".
 *
 * Read through the SHARED classifier so the worker's idea of a commercial
 * denial and the API's — which decides whether a terminal request may be
 * superseded after an upgrade — cannot drift. A code this returns true for is
 * a code that a change of plan resolves; nothing else may be added.
 */
function commercialDenialCode(error: unknown): string | null {
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : error instanceof Error
        ? error.message
        : "";
  return isCommerciallyObsoleteTerminalReason(code) ? code : null;
}

function isCommercialDenialError(error: unknown): boolean {
  return commercialDenialCode(error) !== null;
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}


/**
 * Incrementally SHA-256 a stream WITHOUT materialising it — the integrity re-hash
 * gate reads each ORIGINAL part exactly once, in bounded chunks, so a large UC-3
 * continuous Evidence is verified without buffering any part in RAM.
 */
// UC-ARCH-006 — sha256HexFromStream / compositeSha256 are the ONE digest
// rules in @proovra/shared-runtime (integrity/digest.ts).

// `deleteObjectIfExists` used to live here. Its only caller was the purge
// job's inline storage loop, which is gone: physical deletion is performed by
// the canonical destruction executor through the injected storage port, whose
// worker adapter (`governance/destruction-storage-port.ts`) does the same
// not-found normalisation with a typed check instead of a substring match on an
// error message.

function buildReportLegalLimitations(): ReportLegalLimitations {
  return {
    short:
      "This report verifies the recorded integrity state of the evidence record. It does not independently prove factual truth, authorship, context, or legal admissibility.",
    detailed:
      "Technical verification supports detection of post-completion changes to the recorded evidence state. It does not by itself establish who created the content, whether the depicted events are true, or whether any court, insurer, regulator, or authority must accept the material.",
  };
}

function buildReportReviewGuidance(params: {
  itemCount: number;
  previewableItemCount: number;
  overallIntegrity: boolean;
}): ReportReviewGuidance {
  return {
    reviewerWorkflow: [
      "First review the evidence content and item structure.",
      "Then review the recorded integrity outcome and custody chronology.",
      "Finally evaluate relevance, context, authorship, and admissibility separately.",
    ],
    contentReviewNote:
      params.previewableItemCount > 0
        ? "The report includes a structured evidence inventory and may embed reviewer-facing previews of the recorded evidence content where appropriate for the artifact type."
        : "The recorded evidence content is not directly previewable in a standard way, but its structure and recorded integrity state remain reviewable.",
    legalAssessmentNote:
      "Use the evidence content together with the technical verification record; neither should be treated as a substitute for the other.",
    integrityAssessmentNote: params.overallIntegrity
      ? "The recorded technical integrity checks passed for the available materials at report generation time."
      : "One or more recorded technical integrity checks require manual review before relying on this record.",
    multipartReviewNote:
      params.itemCount > 1
        ? "This record contains multiple items and should be reviewed as a package, including the role of the primary item."
        : "This record contains a single primary evidence item.",
  };
}

function resolveEmbedPreference(
  kind: ReportEvidenceAssetKind
): ReportEvidenceAsset["embedPreference"] {
  switch (kind) {
    case "image":
      return "image";
    case "pdf":
      return "pdf_first_page";
    case "audio":
      return "audio_placeholder";
    case "video":
      return "video_placeholder";
    case "text":
      return "text_excerpt";
    default:
      return "metadata_only";
  }
}

function buildPreviewCaption(params: {
  label: string;
  kind: ReportEvidenceAssetKind;
  mimeType: string | null;
}): string | null {
  const kindLabel =
    params.kind.charAt(0).toUpperCase() + params.kind.slice(1);

  if (params.mimeType) {
    return `${kindLabel} preview for ${params.label} (${params.mimeType})`;
  }

  return `${kindLabel} preview for ${params.label}`;
}

function buildOriginalPreservationNote(params: {
  label: string;
  kind: ReportEvidenceAssetKind;
}): string {
  return `Original preserved ${params.kind} evidence item: ${params.label}.`;
}

function buildReviewerRepresentationLabel(params: {
  kind: ReportEvidenceAssetKind;
  isPrimary: boolean;
}): string {
  const prefix = params.isPrimary ? "Primary" : "Supporting";
  switch (params.kind) {
    case "image":
      return `${prefix} image reviewer preview`;
    case "video":
      return `${prefix} video reviewer representation`;
    case "audio":
      return `${prefix} audio reviewer representation`;
    case "pdf":
      return `${prefix} document reviewer representation`;
    case "text":
      return `${prefix} text reviewer representation`;
    default:
      return `${prefix} evidence reviewer representation`;
  }
}

function buildReviewerRepresentationNote(params: {
  kind: ReportEvidenceAssetKind;
  label: string;
}): string {
  switch (params.kind) {
    case "image":
      return `Reviewer preview generated from the preserved image evidence item ${params.label}. Original image remains separately preserved.`;
    case "video":
      return `Reviewer representation generated for preserved video evidence item ${params.label}. Controlled playback should be performed through the verification workflow when needed.`;
    case "audio":
      return `Reviewer representation generated for preserved audio evidence item ${params.label}. Controlled listening should be performed through the verification workflow when needed.`;
    case "pdf":
      return `Reviewer representation generated from the preserved PDF evidence item ${params.label}. Original document remains separately preserved.`;
    case "text":
      return `Reviewer excerpt generated from the preserved text evidence item ${params.label}. Original file remains separately preserved.`;
    default:
      return `Reviewer representation generated from the preserved evidence item ${params.label}. Original file remains separately preserved.`;
  }
}

function buildVerificationMaterialsNote(params: {
  kind: ReportEvidenceAssetKind;
}): string {
  return `Verification materials for this ${params.kind} item include the recorded digest, custody linkage, timestamping state, and any OpenTimestamps/Bitcoin anchoring records associated with the preserved evidence record.`;
}

function buildReportEvidenceContent(params: {
  accessPolicy: EvidenceContentAccessPolicy;
  previews?: Map<string, ExtractedPreview>;
  evidence: {
    id: string;
    mimeType: string | null;
    sizeBytes: bigint | number | null;
    storageBucket: string | null;
    storageKey: string | null;
    fileSha256: string | null;
    intakePlanJson?: Prisma.JsonValue | null;
  };
  parts: Array<{
    id: string;
    partIndex: number;
    originalFileName: string | null;
    mimeType: string | null;
    sizeBytes: bigint | number | null;
    sha256: string | null;
    durationMs: number | null;
    privateRole?: string | null;
    checklistStepId?: string | null;
    storageBucket: string;
    storageKey: string;
  }>;
}): {
  summary: ReportEvidenceContentSummary;
  items: ReportEvidenceAsset[];
  primaryItem: ReportEvidenceAsset | null;
  previewPolicy: ReportPreviewPolicy;
  limitations: ReportLegalLimitations;
} {
const hasStoredParts = params.parts.length > 0;
  const accessPolicy = params.accessPolicy;
  const canExposeContent = accessPolicy.allowContentView;
  const canDownload = accessPolicy.allowDownload;

const items: ReportEvidenceAsset[] = hasStoredParts
  ? [...params.parts]
      .map((part) => {
            const kind = detectEvidenceAssetKind(part.mimeType);
        const sizeBytes = part.sizeBytes != null ? String(part.sizeBytes) : null;
const resolvedRole = resolveReviewerArtifactRole({
  privateRole: part.privateRole ?? null,
  checklistStepId: part.checklistStepId ?? null,
  intakePlanJson: params.evidence.intakePlanJson ?? null,
  fallbackRole:
    params.parts.length === 1 ||
    (params.evidence.storageBucket === part.storageBucket &&
      params.evidence.storageKey === part.storageKey)
      ? "primary_evidence"
      : "supporting_evidence",
  fallbackRoleSource:
    params.parts.length === 1
      ? "fallback_single"
      : params.evidence.storageBucket === part.storageBucket &&
          params.evidence.storageKey === part.storageKey
        ? "fallback_root"
        : "fallback_first",
});
const isPrimary = isPrimaryReviewerArtifactRole(resolvedRole.artifactRole);

        const canPreviewThisItem =
          canExposeContent && isPreviewableEvidenceKind(kind);

        const label = getEvidencePartDisplayLabel({
          partIndex: part.partIndex,
          mimeType: part.mimeType,
          originalFileName: part.originalFileName,
          storageKey: part.storageKey,
        });

        const preview = params.previews?.get(part.id);

        return {
          id: part.id,
          index: part.partIndex,
          label,
          originalFileName: part.originalFileName ?? null,
          mimeType: part.mimeType ?? null,
          kind,
          sizeBytes,
          durationMs: part.durationMs ?? null,
          sha256: part.sha256 ?? null,
          isPrimary,
          previewable: canPreviewThisItem,
          downloadable: canDownload,
          viewUrl: null,
          displaySizeLabel: formatBytesForDisplay(sizeBytes),
          previewRole: canPreviewThisItem
            ? isPrimary
              ? ("primary_preview" as const)
              : ("secondary_preview" as const)
            : canDownload
              ? ("download_only" as const)
              : ("metadata_only" as const),
          embedPreference: canPreviewThisItem
            ? resolveEmbedPreference(kind)
            : "metadata_only",
          artifactRole: resolvedRole.artifactRole,
          artifactRoleSource: resolvedRole.roleSource,
          checklistStepId: resolvedRole.checklistStepId,
          checklistStepLabel: resolvedRole.checklistStepLabel,
          originalPreservationNote: buildOriginalPreservationNote({ label, kind }),
          reviewerRepresentationLabel: buildReviewerRepresentationLabel({
            kind,
            isPrimary: resolvedRole.artifactRole === "primary_evidence",
          }),
          reviewerRepresentationNote: buildReviewerRepresentationNote({
            kind,
            label,
          }),
          verificationMaterialsNote: buildVerificationMaterialsNote({ kind }),
          previewDataUrl: preview?.previewDataUrl ?? null,
          previewTextExcerpt: preview?.previewTextExcerpt ?? null,
          previewCaption:
            preview?.previewCaption ??
            buildPreviewCaption({
              label,
              kind,
              mimeType: part.mimeType ?? null,
            }),
        };
      })
      .sort((left, right) => {
        const roleOrder = compareReviewerArtifactRolePriority(
          left.artifactRole,
          right.artifactRole
        );
        if (roleOrder !== 0) return roleOrder;
        return left.index - right.index;
      })
    : params.evidence.storageBucket && params.evidence.storageKey
      ? (() => {
          const singleKind = detectEvidenceAssetKind(params.evidence.mimeType);
          const singlePreviewable =
            canExposeContent && isPreviewableEvidenceKind(singleKind);

          const label = getEvidencePartDisplayLabel({
            partIndex: 0,
            mimeType: params.evidence.mimeType,
            storageKey: params.evidence.storageKey,
          });

          const preview = params.previews?.get(params.evidence.id);

          return [
            {
              id: params.evidence.id,
              index: 0,
              label,
              originalFileName: basenameFromStorageKey(
                params.evidence.storageKey,
                `evidence-file.${extensionFromMimeType(params.evidence.mimeType)}`
              ),
              mimeType: params.evidence.mimeType ?? null,
              kind: singleKind,
              sizeBytes:
                params.evidence.sizeBytes != null
                  ? String(params.evidence.sizeBytes)
                  : null,
              durationMs: null,
              sha256: params.evidence.fileSha256 ?? null,
              isPrimary: true,
              previewable: singlePreviewable,
              downloadable: canDownload,
              viewUrl: null,
              displaySizeLabel: formatBytesForDisplay(params.evidence.sizeBytes),
              previewRole: singlePreviewable
                ? ("primary_preview" as const)
                : canDownload
                  ? ("download_only" as const)
                  : ("metadata_only" as const),
              embedPreference: singlePreviewable
                ? resolveEmbedPreference(singleKind)
                : "metadata_only",
              artifactRole: "primary_evidence",
              artifactRoleSource: "fallback_single",
              checklistStepId: null,
              checklistStepLabel: null,
              originalPreservationNote: buildOriginalPreservationNote({
                label,
                kind: singleKind,
              }),
              reviewerRepresentationLabel: buildReviewerRepresentationLabel({
                kind: singleKind,
                isPrimary: true,
              }),
              reviewerRepresentationNote: buildReviewerRepresentationNote({
                kind: singleKind,
                label,
              }),
              verificationMaterialsNote: buildVerificationMaterialsNote({
                kind: singleKind,
              }),
              previewDataUrl: preview?.previewDataUrl ?? null,
              previewTextExcerpt: preview?.previewTextExcerpt ?? null,
              previewCaption:
                preview?.previewCaption ??
                buildPreviewCaption({
                  label,
                  kind: singleKind,
                  mimeType: params.evidence.mimeType ?? null,
                }),
            },
          ];
        })()
      : [];

if (items.length > 0 && !items.some((item) => item.isPrimary)) {
      items[0] = {
      ...items[0],
      isPrimary: true,
      previewRole:
        items[0]?.previewRole === "metadata_only"
          ? ("metadata_only" as const)
          : ("primary_preview" as const),
      artifactRole: "primary_evidence",
    };
  }

  const primaryItem =
    items.find((item) => item.isPrimary) ?? (items.length > 0 ? items[0] : null);

  const summary = items.reduce<ReportEvidenceContentSummary>(
    (acc, item) => {
      acc.itemCount += 1;
      if (item.previewable) acc.previewableItemCount += 1;
      if (item.downloadable) acc.downloadableItemCount += 1;

      if (item.kind === "image") acc.imageCount += 1;
      else if (item.kind === "video") acc.videoCount += 1;
      else if (item.kind === "audio") acc.audioCount += 1;
      else if (item.kind === "pdf") acc.pdfCount += 1;
      else if (item.kind === "text") acc.textCount += 1;
      else acc.otherCount += 1;

      return acc;
    },
    {
structure: items.length > 1 ? "multipart" : "single",
      itemCount: 0,
      previewableItemCount: 0,
      downloadableItemCount: 0,
      imageCount: 0,
      videoCount: 0,
      audioCount: 0,
      pdfCount: 0,
      textCount: 0,
      otherCount: 0,
      primaryKind: primaryItem?.kind ?? null,
      primaryMimeType: primaryItem?.mimeType ?? null,
      totalSizeBytes: null,
      totalSizeDisplay: null,
    }
  );

  const totalSizeBigInt = items.reduce<bigint>((acc, item) => {
    const value = item.sizeBytes ? BigInt(item.sizeBytes) : 0n;
    return acc + value;
  }, 0n);

  summary.totalSizeBytes =
    totalSizeBigInt > 0n ? totalSizeBigInt.toString() : null;
  summary.totalSizeDisplay = formatBytesForDisplay(summary.totalSizeBytes);
  summary.primaryKind = primaryItem?.kind ?? null;
  summary.primaryMimeType = primaryItem?.mimeType ?? null;

  const previewPolicy = buildEvidencePreviewPolicy({
    itemCount: summary.itemCount,
    previewableItemCount: summary.previewableItemCount,
    downloadableItemCount: summary.downloadableItemCount,
    accessPolicy,
  });

  const limitations = buildReportLegalLimitations();

  return {
    summary,
    items,
    primaryItem,
    previewPolicy,
    limitations,
  };
}

async function resolveAnchorStatusForReport(
  evidenceId: string
): Promise<ReportAnchorSummary> {
  const mode = normalizeAnchorMode(process.env.ANCHOR_MODE);
  const provider = process.env.ANCHOR_PROVIDER?.trim() || null;

  const anchor = await prisma.evidenceAnchor.findUnique({
    where: { evidenceId },
    select: {
      mode: true,
      provider: true,
      anchorHash: true,
      transactionId: true,
      anchoredAtUtc: true,
    },
  });

  if (!anchor) {
    return {
      mode,
      provider,
      configured: Boolean(provider),
      anchorHash: null,
      transactionId: null,
      anchoredAtUtc: null,
    };
  }

  return {
    mode: normalizeAnchorMode(anchor.mode),
    provider: anchor.provider ?? provider,
    configured: Boolean(anchor.provider ?? provider),
    anchorHash: anchor.anchorHash ?? null,
    transactionId: anchor.transactionId ?? null,
    anchoredAtUtc: anchor.anchoredAtUtc
      ? anchor.anchoredAtUtc.toISOString()
      : null,
  };
}

async function resolveEvidenceStorageSnapshot(params: {
  storageBucket: string | null;
  storageKey: string | null;
  storageRegion?: string | null;
  storageObjectLockMode?: string | null;
  storageObjectLockRetainUntilUtc?: Date | null;
  storageObjectLockLegalHoldStatus?: string | null;
}): Promise<EvidenceStorageSnapshot> {
  const snapshotMode =
    typeof params.storageObjectLockMode === "string"
      ? params.storageObjectLockMode
      : null;

  const snapshotRetainUntil = params.storageObjectLockRetainUntilUtc
    ? params.storageObjectLockRetainUntilUtc.toISOString()
    : null;

  const snapshotLegalHold =
    typeof params.storageObjectLockLegalHoldStatus === "string"
      ? params.storageObjectLockLegalHoldStatus
      : null;

  const snapshotRegion =
    typeof params.storageRegion === "string" && params.storageRegion.trim()
      ? params.storageRegion.trim()
      : process.env.S3_REGION?.trim() || null;

  if (snapshotMode || snapshotRetainUntil || snapshotLegalHold) {
    return {
      storageRegion: snapshotRegion,
      storageObjectLockMode: snapshotMode,
      storageObjectLockRetainUntilUtc: snapshotRetainUntil,
      storageObjectLockLegalHoldStatus: snapshotLegalHold,
      storageImmutable:
        snapshotMode === "COMPLIANCE" && Boolean(snapshotRetainUntil),
    };
  }

  if (!params.storageBucket || !params.storageKey) {
    return {
      storageRegion: snapshotRegion,
      storageObjectLockMode: null,
      storageObjectLockRetainUntilUtc: null,
      storageObjectLockLegalHoldStatus: null,
      storageImmutable: false,
    };
  }

  try {
    const meta = await headObject({
      bucket: params.storageBucket,
      key: params.storageKey,
    });

    const mode = meta.objectLockMode ? String(meta.objectLockMode) : null;
    const retainUntil =
      meta.objectLockRetainUntilDate instanceof Date
        ? meta.objectLockRetainUntilDate.toISOString()
        : null;
    const legalHold = meta.objectLockLegalHoldStatus
      ? String(meta.objectLockLegalHoldStatus)
      : null;

    return {
      storageRegion: snapshotRegion,
      storageObjectLockMode: mode,
      storageObjectLockRetainUntilUtc: retainUntil,
      storageObjectLockLegalHoldStatus: legalHold,
      storageImmutable: mode === "COMPLIANCE" && Boolean(retainUntil),
    };
  } catch {
    return {
      storageRegion: snapshotRegion,
      storageObjectLockMode: null,
      storageObjectLockRetainUntilUtc: null,
      storageObjectLockLegalHoldStatus: null,
      storageImmutable: false,
    };
  }
}

function deriveIdentityLevel(params: {
  provider: prismaPkg.AuthProvider;
  emailVerifiedAt: Date | null;
  organizationVerificationState: prismaPkg.OrganizationVerificationState | null;
  currentWorkspaceVerified: boolean;
  hasWorkspaceTeam: boolean;
}): prismaPkg.IdentityLevel {
  if (params.currentWorkspaceVerified) {
    return prismaPkg.IdentityLevel.VERIFIED_ORGANIZATION;
  }

  if (
    params.organizationVerificationState ===
    prismaPkg.OrganizationVerificationState.VERIFIED
  ) {
    return prismaPkg.IdentityLevel.VERIFIED_ORGANIZATION;
  }

  if (params.hasWorkspaceTeam) {
    return prismaPkg.IdentityLevel.ORGANIZATION_ACCOUNT;
  }

  if (
    params.provider === prismaPkg.AuthProvider.GOOGLE ||
    params.provider === prismaPkg.AuthProvider.APPLE
  ) {
    return prismaPkg.IdentityLevel.OAUTH_BACKED_IDENTITY;
  }

  if (params.emailVerifiedAt) {
    return prismaPkg.IdentityLevel.VERIFIED_EMAIL;
  }

  return prismaPkg.IdentityLevel.BASIC_ACCOUNT;
}

function deriveReportCaptureMethod(params: {
  itemCount: number;
  mimeType: string | null;
  existingCaptureMethod: prismaPkg.CaptureMethod | null;
}): prismaPkg.CaptureMethod {
  if (params.itemCount > 1) {
    return prismaPkg.CaptureMethod.MULTIPART_PACKAGE;
  }

  if (
    params.existingCaptureMethod &&
    params.existingCaptureMethod !== prismaPkg.CaptureMethod.MULTIPART_PACKAGE
  ) {
    return params.existingCaptureMethod;
  }

  const mime = String(params.mimeType ?? "").toLowerCase();

  if (mime === "application/pdf" || mime.startsWith("text/")) {
    return prismaPkg.CaptureMethod.IMPORTED_DOCUMENT;
  }

  return prismaPkg.CaptureMethod.UPLOADED_FILE;
}

const { EvidenceStatus } = prismaPkg;

/**
 * OTS COMES FROM THE ROW. There used to be an `otsResult` parameter here, fed
 * by the stamp this job created moments earlier, and every OTS field below was
 * a ternary choosing between it and the stored column. The stamp is no longer
 * this job's to make, so the parameter is gone and each ternary has collapsed
 * onto the branch that reads the record — which is what the fallback branch
 * always did, and is now simply what happens.
 */
/**
 * The report a package request was verified against is no longer the report
 * row for that version (or its recorded digest changed) at commit time.
 */
export const PACKAGE_REPORT_BASELINE_CHANGED = "PACKAGE_REPORT_BASELINE_CHANGED";

/** A concurrent run committed the package for this report version first. */
export class PackageAlreadyCommittedError extends Error {
  constructor(readonly reportVersion: number) {
    super("VERIFICATION_PACKAGE_ALREADY_COMMITTED");
    this.name = "PackageAlreadyCommittedError";
  }
}

/**
 * The object store answered "not found" (S3 HEAD answers a bare `NotFound`
 * with no body; GET answers `NoSuchKey`). A 404 on a HEAD without a VersionId
 * also covers a missing bucket and a current delete marker over a retained
 * version, so it establishes only "not readable at the recorded location" —
 * never "destroyed".
 */
export function isStorageNotFound(err: unknown): boolean {
  const e = err as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } } | null;
  return (
    e?.name === "NoSuchKey" ||
    e?.name === "NotFound" ||
    e?.Code === "NoSuchKey" ||
    e?.$metadata?.httpStatusCode === 404
  );
}

/**
 * THE SIGNED ORIGINAL IS NOT READABLE AT ITS RECORDED LOCATION (2026-09-29).
 *
 * Incident report-8cccb175: a package recovery HEADed an original part, got a
 * 404, and the raw `NotFound` escaped as a RETRIABLE error — five identical
 * attempts, then the DLQ, recorded as `NotFound` with no component named. A
 * 404 from the store is deterministic for this run; retrying cannot change it.
 *
 * It is terminal here, names the component (never the key, which carries a
 * file name), and reaches an operator through the report-failure incident.
 * Nothing is built from other bytes. Whether the object is hidden by a delete
 * marker or truly absent is for the operator to establish from the bucket's
 * version listing; if a retained version is restored and its bytes match the
 * signed digest, a new request re-runs this path unchanged.
 *
 * Any other storage error (throttling, network, 5xx, access) stays retriable.
 */
export const EVIDENCE_ORIGINAL_NOT_FOUND = "EVIDENCE_ORIGINAL_NOT_FOUND";

export function originalNotFoundError(component: string): WorkerError {
  const err = createWorkerError(EVIDENCE_ORIGINAL_NOT_FOUND, false);
  err.message =
    `${EVIDENCE_ORIGINAL_NOT_FOUND}: object storage answered "not found" for ${component} ` +
    "at its recorded location. This does not establish loss: a delete marker, a wrong key or " +
    "bucket, or a missing object are all possible. No report or package was built from other " +
    "bytes; the record, its hash and its signature are unchanged.";
  return err;
}

/** Read an ORIGINAL object, turning a store 404 into the terminal refusal above. */
export async function readOriginalObject<T>(component: string, read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (err) {
    if (isStorageNotFound(err)) throw originalNotFoundError(component);
    throw err;
  }
}

async function prepareReportArtifacts(
  evidenceId: string,
  options?: {
    allowReported?: boolean;
    refreshReason?: string | null;
    // Phase A0 — surfaced to the integrity-rejection helper so a
    // mismatch's SecurityEvent + structured log carry the originating
    // job context. Optional because the helper degrades gracefully
    // when absent.
    jobId?: string | number | null;
    attempt?: number | null;
    /**
     * Package-only recovery embeds an EXISTING, verified report. Rendering a
     * provisional report would cost a Chromium run whose bytes are thrown
     * away, and add a failure mode unrelated to the package.
     */
    skipProvisionalPdf?: boolean;
  }
): Promise<PreparedReportArtifacts> {
  const evidence = await prisma.evidence.findFirst({
    where: { id: evidenceId, deletedAt: null },
    select: {
      id: true,
      ownerUserId: true,
      teamId: true,
      title: true,
      type: true,
      status: true,
      verificationStatus: true,
      // PHASE 12B — CaseEvidenceLink authority; primary case = earliest link.
      caseLinks: { select: { caseId: true }, orderBy: { linkedAtUtc: "asc" }, take: 1 },
      organizationId: true,
      captureMethod: true,
      acquisitionMode: true,
      submittedByEmail: true,
      submittedByAuthProvider: true,
      submittedByUserId: true,
      createdByUserId: true,
      uploadedByUserId: true,
      lastAccessedByUserId: true,
      lastAccessedAtUtc: true,
      workspaceNameSnapshot: true,
      organizationNameSnapshot: true,
      organizationVerifiedSnapshot: true,
      recordedIntegrityVerifiedAtUtc: true,
      lastVerifiedAtUtc: true,
      lastVerifiedSource: true,
      // UC-OUT-001 — a link is printed only for a published record.
      publicVerifyState: true,
      verificationPackageGeneratedAtUtc: true,
      verificationPackageVersion: true,
      // Phase D Blocker 3 — per-component artifact presence record.
      verificationPackageMetadata: true,
      latestReportVersion: true,
      reviewReadyAtUtc: true,
      reviewerSummaryVersion: true,
      intakePlanJson: true,
      // Snapshot taken at submission; the intake link stays authoritative.
      intakeCustomerId: true,
      createdAt: true,
      uploadedAtUtc: true,
      signedAtUtc: true,
      capturedAtUtc: true,
      reportGeneratedAtUtc: true,
      deviceTimeIso: true,
      lat: true,
      lng: true,
      accuracyMeters: true,
      locationSource: true,
      mimeType: true,
      storageBucket: true,
      storageKey: true,
      // (2026-09-29, D14) The version that was hashed and signed.
      storageVersionId: true,
      storageRegion: true,
      storageObjectLockMode: true,
      storageObjectLockRetainUntilUtc: true,
      storageObjectLockLegalHoldStatus: true,
      sizeBytes: true,
      durationSec: true,
      fileSha256: true,
      fingerprintCanonicalJson: true,
      fingerprintHash: true,
      signatureBase64: true,
      signingKeyId: true,
      signingKeyVersion: true,
      signingKeySha256: true,
      tsaProvider: true,
      tsaUrl: true,
      tsaSerialNumber: true,
      tsaGenTimeUtc: true,
      tsaTokenBase64: true,
      tsaMessageImprint: true,
      tsaInputDigestHex: true,
      tsaInputKind: true,
      tsaHashAlgorithm: true,
      tsaStatus: true,
      tsaFailureReason: true,
      tsaValidatedAtUtc: true,
      otsProofBase64: true,
      otsHash: true,
      otsStatus: true,
      otsCalendar: true,
      otsBitcoinTxid: true,
      otsAnchoredAtUtc: true,
      otsUpgradedAtUtc: true,
      otsFailureReason: true,
      otsAnchorCheck: true,
    },
  });

  if (!evidence) throw createWorkerError("EVIDENCE_NOT_FOUND", false);

  const allowReported = options?.allowReported === true;

  if (
    evidence.status !== EvidenceStatus.SIGNED &&
    !(allowReported && evidence.status === EvidenceStatus.REPORTED)
  ) {
    if (evidence.status === EvidenceStatus.REPORTED) {
      throw createWorkerError("REPORT_ALREADY_GENERATED", false);
    }
    throw createWorkerError(`EVIDENCE_NOT_SIGNED:${evidence.status}`, false);
  }

  if (!evidence.fileSha256) {
    throw createWorkerError("EVIDENCE_FILE_SHA256_MISSING", false);
  }
  if (!evidence.fingerprintCanonicalJson) {
    throw createWorkerError(
      "EVIDENCE_FINGERPRINT_CANONICAL_JSON_MISSING",
      false
    );
  }
  if (!evidence.fingerprintHash) {
    throw createWorkerError("EVIDENCE_FINGERPRINT_HASH_MISSING", false);
  }
  if (!evidence.signatureBase64) {
    throw createWorkerError("EVIDENCE_SIGNATURE_MISSING", false);
  }
  if (!evidence.signingKeyId || evidence.signingKeyVersion == null) {
    throw createWorkerError("EVIDENCE_SIGNING_KEY_MISSING", false);
  }

  // ET-SM-07 — every issuance re-reads the original bytes; what it finds is
  // recorded through the integrity-recheck authority under the trigger that
  // asked (a package-only run embeds an existing report).
  const integrityTrigger = options?.skipProvisionalPdf
    ? ("PACKAGE_ISSUANCE" as const)
    : ("REPORT_ISSUANCE" as const);

  const fingerprintCanonicalJson = evidence.fingerprintCanonicalJson;
  const fingerprintHash = evidence.fingerprintHash;
  const signatureBase64 = evidence.signatureBase64;
  const signingKeyId = evidence.signingKeyId;
  const signingKeyVersion = evidence.signingKeyVersion;

  const evidenceStorage = await resolveEvidenceStorageSnapshot({
    storageBucket: evidence.storageBucket ?? null,
    storageKey: evidence.storageKey ?? null,
    storageRegion: evidence.storageRegion ?? null,
    storageObjectLockMode: evidence.storageObjectLockMode ?? null,
    storageObjectLockRetainUntilUtc:
      evidence.storageObjectLockRetainUntilUtc ?? null,
    storageObjectLockLegalHoldStatus:
      evidence.storageObjectLockLegalHoldStatus ?? null,
  });

  const [
    parts,
    ownerUser,
    anchorSummary,
    latestCustodianCertification,
    latestQualifiedPersonCertification,
  ] = await Promise.all([
    prisma.evidencePart.findMany({
      where: { evidenceId: evidence.id },
      orderBy: { partIndex: "asc" },
      select: {
        id: true,
        partIndex: true,
        originalFileName: true,
        mimeType: true,
        sizeBytes: true,
        sha256: true,
        durationMs: true,
        artifactClass: true,
        storageBucket: true,
        storageKey: true,
        storageVersionId: true,
        storageRegion: true,
        storageObjectLockMode: true,
        storageObjectLockRetainUntilUtc: true,
        storageObjectLockLegalHoldStatus: true,
        privateRole: true,
        checklistStepId: true,
        sourceLabel: true,
        uploadedByUserId: true,
      },
    }),
    prisma.user.findUnique({
      where: { id: evidence.ownerUserId },
      select: {
        id: true,
        email: true,
        provider: true,
        emailVerifiedAt: true,
        organizationVerificationState: true,
        currentWorkspaceId: true,
      },
    }),
    resolveAnchorStatusForReport(evidence.id),
    prisma.evidenceCertification.findFirst({
      where: {
        evidenceId: evidence.id,
        declarationType: PrismaCertificationType.CUSTODIAN,
      },
      orderBy: [{ version: "desc" }, { updatedAt: "desc" }],
      select: {
        declarationType: true,
        status: true,
        version: true,
        requestedAtUtc: true,
        requestedByUserId: true,
        attestedAtUtc: true,
        attestedByUserId: true,
        attestorName: true,
        attestorTitle: true,
        attestorEmail: true,
        attestorOrganization: true,
        statementMarkdown: true,
        statementSnapshot: true,
        signatureText: true,
        certificationHash: true,
        revokedAtUtc: true,
        revokedByUserId: true,
        revokeReason: true,
      },
    }),
    prisma.evidenceCertification.findFirst({
      where: {
        evidenceId: evidence.id,
        declarationType: PrismaCertificationType.QUALIFIED_PERSON,
      },
      orderBy: [{ version: "desc" }, { updatedAt: "desc" }],
      select: {
        declarationType: true,
        status: true,
        version: true,
        requestedAtUtc: true,
        requestedByUserId: true,
        attestedAtUtc: true,
        attestedByUserId: true,
        attestorName: true,
        attestorTitle: true,
        attestorEmail: true,
        attestorOrganization: true,
        statementMarkdown: true,
        statementSnapshot: true,
        signatureText: true,
        certificationHash: true,
        revokedAtUtc: true,
        revokedByUserId: true,
        revokeReason: true,
      },
    }),
  ]);

  if (!ownerUser) {
    throw createWorkerError("OWNER_USER_NOT_FOUND", false);
  }

  const certifications = {
    custodian: toReportCertificationSnapshot(latestCustodianCertification),
    qualifiedPerson: toReportCertificationSnapshot(latestQualifiedPersonCertification),
  };

  const effectivePlan = await resolveEffectivePlanForEvidence({
    ownerUserId: evidence.ownerUserId,
    teamId: evidence.teamId ?? null,
  });

  // BILLING COMMERCIAL CORRECTNESS (2026-08-27) — the entitlement belongs to
  // the RECORD and its funding, not to the account's recurring plan. An
  // evidence-credit buyer is on FREE, so asking the plan alone refused the
  // report for a record the customer had already paid for.
  //
  // EVIDENCE OUTPUT LIFECYCLE (2026-09-29) — the ONE issuance decision: plan,
  // funding AND the subscription lifecycle. A lapsed or ended subscription no
  // longer receives newly issued outputs; an unreadable lifecycle issues
  // nothing and retries later.
  const issuance = await resolveEvidenceOutputIssuance({
    id: evidence.id,
    ownerUserId: evidence.ownerUserId,
    teamId: evidence.teamId ?? null,
  });
  if (issuance.decision === "UNRESOLVED") {
    throw createWorkerError(OUTPUT_ENTITLEMENT_UNRESOLVED, true);
  }
  if (issuance.decision !== "ENTITLED" || !issuance.reportsIncluded) {
    throw createWorkerError("REPORT_NOT_INCLUDED_IN_PLAN", false);
  }
  const evidenceOutputs = {
    reportsIncluded: issuance.reportsIncluded,
    verificationPackageIncluded: issuance.verificationPackageIncluded,
  };

  let workspaceTeam:
    | {
        id: string;
        name: string;
        legalName: string | null;
        evidenceWorkspaceLabel: string | null;
        verificationState: prismaPkg.OrganizationVerificationState | null;
        isPersonal: boolean;
      }
    | null = null;

  if (evidence.teamId) {
    workspaceTeam = await prisma.team.findUnique({
      where: { id: evidence.teamId },
      select: {
        id: true,
        name: true,
        legalName: true,
        evidenceWorkspaceLabel: true,
        verificationState: true,
        retentionPolicy: true,
        // Phase 2 canonical workspace scope — `Team.isPersonal=true`
        // means this is a personal-account workspace, not enterprise
        // team governance. The legacy "teamId truthy = team_governed"
        // derivation in verification-package.ts is misleading because
        // every record has a teamId (personal workspaces are stored
        // as Team rows). We surface `isPersonal` so the package can
        // emit a correct canonical workspace scope.
        isPersonal: true,
      },
    });
  }

  let caseItem:
  | {
      id: string;
      name: string;
      teamId: string | null;
      ownerUserId: string;
    }
  | null = null;

const primaryCaseId = evidence.caseLinks?.[0]?.caseId ?? null;
if (primaryCaseId) {
  caseItem = await prisma.case.findUnique({
    where: { id: primaryCaseId },
    select: {
      id: true,
      name: true,
      teamId: true,
      ownerUserId: true,
    },
  });
}

  if (parts.length === 0 && (!evidence.storageBucket || !evidence.storageKey)) {
    throw createWorkerError("EVIDENCE_STORAGE_NOT_SET", false);
  }

let storageBucket = evidence.storageBucket ?? null;
let storageKey = evidence.storageKey ?? null;
let fileSha256 = "";
// UC-TRUST-001 — the bytes are compared with the digest the SIGNED fingerprint
// certifies, never only with the unsigned fileSha256 / part columns; a column
// that disagrees with the fingerprint is itself an integrity failure.
const expectedOriginal = resolveExpectedOriginalDigest({
  fingerprintCanonicalJson: evidence.fingerprintCanonicalJson,
  fileSha256: evidence.fileSha256,
  parts: parts.map((p) => ({ partIndex: p.partIndex, sha256: p.sha256 ?? null })),
});
const expectedOriginalDigest = expectedOriginal.expectedDigest ?? evidence.fileSha256;
const signedPartMismatch = (partIndex: number, sha: string): boolean =>
  expectedOriginal.signedPartDigests !== null && expectedOriginal.signedPartDigests.get(partIndex) !== sha;
const verificationEvidenceFiles: VerificationEvidenceFile[] = [];
const loadedArtifacts: LoadedEvidenceArtifact[] = [];

  // Defence-in-depth size backstop (derived from the canonical evidence-size
  // authority): fail closed BEFORE any large buffering/decode work if malformed or
  // historical state presents an Evidence beyond the supported processing bound.
  {
    const totalEvidenceBytes =
      parts.length > 0 ? sumPartBytes(parts) : Number(evidence.sizeBytes ?? 0);
    if (exceedsProcessingCeiling(totalEvidenceBytes)) {
      throw createWorkerError(EVIDENCE_TOO_LARGE_FOR_PROCESSING, false);
    }
  }

  if (parts.length > 0) {
    const hashes: string[] = [];

    for (const [index, part] of parts.entries()) {
      const resolvedRole = resolveReviewerArtifactRole({
        privateRole: part.privateRole ?? null,
        checklistStepId: part.checklistStepId ?? null,
        intakePlanJson: evidence.intakePlanJson ?? null,
        fallbackRole:
          parts.length === 1 || index === 0
            ? "primary_evidence"
            : "supporting_evidence",
        fallbackRoleSource:
          parts.length === 1
            ? "fallback_single"
            : index === 0
              ? "fallback_root"
              : "fallback_first",
      });

      const component = `original part ${part.partIndex}`;
      const head = await readOriginalObject(component, () =>
        headObject({
          bucket: part.storageBucket,
          key: part.storageKey,
          versionId: part.storageVersionId ?? null,
        }),
      );

      if (!head.sizeBytes || head.sizeBytes <= 0) {
        throw createWorkerError("EVIDENCE_OBJECT_NOT_FOUND", true);
      }

      const body = await readOriginalObject(component, () =>
        getObjectStream({
          bucket: part.storageBucket,
          key: part.storageKey,
          versionId: part.storageVersionId ?? null,
        }),
      );

      // Integrity re-hash by STREAMING — each ORIGINAL part is read once in bounded
      // chunks and never materialised as a Buffer.
      const partSha = await sha256HexFromStream(body as unknown as Readable);
      hashes.push(partSha);

      verificationEvidenceFiles.push({
        artifactRole: resolvedRole.artifactRole,
        artifactRoleSource: resolvedRole.roleSource,
        name:
          part.originalFileName ??
          basenameFromStorageKey(
            part.storageKey,
            `part-${String(index + 1).padStart(4, "0")}.${extensionFromMimeType(
              part.mimeType
            )}`
          ),
        sha256: partSha,
        mimeType: part.mimeType ?? null,
        sizeBytes: Number(part.sizeBytes ?? 0),
        originalFileName: part.originalFileName ?? null,
        partIndex: part.partIndex,
        storageBucket: part.storageBucket,
        storageKey: part.storageKey,
        storageVersionId: part.storageVersionId ?? null,
        storageRegion: part.storageRegion ?? null,
        storageObjectLockMode: part.storageObjectLockMode ?? null,
        storageObjectLockRetainUntilUtc:
          part.storageObjectLockRetainUntilUtc?.toISOString() ?? null,
        storageObjectLockLegalHoldStatus:
          part.storageObjectLockLegalHoldStatus ?? null,
        artifactClass: part.artifactClass ?? null,
        checklistStepId: resolvedRole.checklistStepId,
        checklistStepLabel: resolvedRole.checklistStepLabel,
        sourceLabel: part.sourceLabel ?? null,
      });
            loadedArtifacts.push({
        id: part.id,
        partIndex: part.partIndex,
        label: getEvidencePartDisplayLabel({
          partIndex: part.partIndex,
          mimeType: part.mimeType,
          originalFileName: part.originalFileName,
          storageKey: part.storageKey,
        }),
        originalFileName: part.originalFileName ?? null,
        mimeType: part.mimeType ?? null,
        kind: detectEvidenceAssetKind(part.mimeType),
        storageBucket: part.storageBucket,
        storageKey: part.storageKey,
      });
    }

    if (verificationEvidenceFiles.length === 0) {
      throw createWorkerError("NO_MULTIPART_FILES_FOUND", false);
    }

    storageBucket = parts[0].storageBucket;
    storageKey = parts[0].storageKey;
fileSha256 =
  hashes.length === 1 ? hashes[0] : compositeSha256(hashes);

const legacySinglePartCompositeSha =
  hashes.length === 1 ? compositeSha256(hashes) : null;

if (
  (fileSha256 !== expectedOriginalDigest &&
    legacySinglePartCompositeSha !== expectedOriginalDigest) ||
  parts.some((p, i) => signedPartMismatch(p.partIndex, hashes[i] ?? "")) ||
  expectedOriginal.columnsAgree === false
) {
  // Phase A0 — integrity hard-gate. Before we throw, transition the
  // Evidence row to FAILED_HASH_MISMATCH + append the custody
  // rejection event + emit the security event. The throw still moves
  // the BullMQ job to the DLQ (non-retriable) but downstream
  // workflows can no longer accidentally promote the row. The helper
  // is idempotent — a duplicate worker run finds the terminal state
  // and short-circuits.
  await recordIntegrityObservation({
    evidenceId: evidence.id,
    teamId: evidence.teamId ?? null,
    expectedDigest: expectedOriginalDigest ?? null,
    observation: {
      outcome: "FAILED",
      failureCode: "DIGEST_MISMATCH",
      checkedDigest: fileSha256,
      storageVersionId: null,
      checkedObjects: parts.map((p, i) => ({
        partIndex: p.partIndex,
        versionId: p.storageVersionId ?? null,
        sha256: hashes[i] ?? null,
      })),
    },
    trigger: integrityTrigger,
    rejectionSource: "worker.report.multipart",
    correlationId: options?.jobId != null ? String(options.jobId) : null,
    attempt: options?.attempt ?? null,
  });
  throw createWorkerError("EVIDENCE_FILE_SHA256_MISMATCH", false);
}
// ET-SM-07 — the bytes were read at their recorded versions and matched:
// that IS an integrity recheck, and it is recorded as one.
await recordIntegrityObservation({
  evidenceId: evidence.id,
  teamId: evidence.teamId ?? null,
  expectedDigest: expectedOriginalDigest ?? null,
  observation: {
    outcome: "VERIFIED",
    failureCode: null,
    checkedDigest: fileSha256,
    storageVersionId: null,
    checkedObjects: parts.map((p, i) => ({
      partIndex: p.partIndex,
      versionId: p.storageVersionId ?? null,
      sha256: hashes[i] ?? null,
    })),
  },
  trigger: integrityTrigger,
  correlationId: options?.jobId != null ? String(options.jobId) : null,
});
  } else {
    const head = await readOriginalObject("the original file", () =>
      headObject({
        bucket: evidence.storageBucket!,
        key: evidence.storageKey!,
        versionId: evidence.storageVersionId ?? null,
      }),
    );

    if (!head.sizeBytes || head.sizeBytes <= 0) {
      throw createWorkerError("EVIDENCE_OBJECT_NOT_FOUND", true);
    }

    const body = await readOriginalObject("the original file", () =>
      getObjectStream({
        bucket: evidence.storageBucket!,
        key: evidence.storageKey!,
        versionId: evidence.storageVersionId ?? null,
      }),
    );

    // Integrity re-hash by STREAMING — never buffer the whole single file.
    const singleSha256 = await sha256HexFromStream(body as unknown as Readable);

    if (singleSha256 !== expectedOriginalDigest || expectedOriginal.columnsAgree === false) {
      // Phase A0 — integrity hard-gate (single-file path). See the
      // multipart branch above for the contract: status flip + custody
      // event + security event happen before the throw so a tampered
      // (or storage-mutated) object never produces a Report.
      await recordIntegrityObservation({
        evidenceId: evidence.id,
        teamId: evidence.teamId ?? null,
        expectedDigest: expectedOriginalDigest ?? null,
        observation: {
          outcome: "FAILED",
          failureCode: "DIGEST_MISMATCH",
          checkedDigest: singleSha256,
          storageVersionId: evidence.storageVersionId ?? null,
          checkedObjects: [
            { partIndex: null, versionId: evidence.storageVersionId ?? null, sha256: singleSha256 },
          ],
        },
        trigger: integrityTrigger,
        rejectionSource: "worker.report.single_file",
        correlationId: options?.jobId != null ? String(options.jobId) : null,
        attempt: options?.attempt ?? null,
      });
      throw createWorkerError("EVIDENCE_FILE_SHA256_MISMATCH", false);
    }
    // ET-SM-07 — read at the recorded version and matched: recorded as a recheck.
    await recordIntegrityObservation({
      evidenceId: evidence.id,
      teamId: evidence.teamId ?? null,
      expectedDigest: expectedOriginalDigest ?? null,
      observation: {
        outcome: "VERIFIED",
        failureCode: null,
        checkedDigest: singleSha256,
        storageVersionId: evidence.storageVersionId ?? null,
        checkedObjects: [
          { partIndex: null, versionId: evidence.storageVersionId ?? null, sha256: singleSha256 },
        ],
      },
      trigger: integrityTrigger,
      correlationId: options?.jobId != null ? String(options.jobId) : null,
    });

    fileSha256 = singleSha256;

    verificationEvidenceFiles.push({
      name: basenameFromStorageKey(
        evidence.storageKey,
        `evidence-file.${extensionFromMimeType(evidence.mimeType)}`
      ),
      sha256: singleSha256,
      mimeType: evidence.mimeType ?? null,
      sizeBytes: Number(evidence.sizeBytes ?? 0),
      originalFileName: basenameFromStorageKey(
        evidence.storageKey!,
        `evidence-file.${extensionFromMimeType(evidence.mimeType)}`
      ),
      partIndex: null,
      storageBucket: evidence.storageBucket,
      storageKey: evidence.storageKey,
      storageRegion: evidenceStorage.storageRegion,
      storageObjectLockMode: evidenceStorage.storageObjectLockMode,
      storageObjectLockRetainUntilUtc:
        evidenceStorage.storageObjectLockRetainUntilUtc,
      storageObjectLockLegalHoldStatus:
        evidenceStorage.storageObjectLockLegalHoldStatus,
    });

    loadedArtifacts.push({
      id: evidence.id,
      partIndex: 0,
      label: getEvidencePartDisplayLabel({
        partIndex: 0,
        mimeType: evidence.mimeType,
        storageKey: evidence.storageKey!,
      }),
      originalFileName: basenameFromStorageKey(
        evidence.storageKey!,
        `evidence-file.${extensionFromMimeType(evidence.mimeType)}`
      ),
      mimeType: evidence.mimeType ?? null,
      kind: detectEvidenceAssetKind(evidence.mimeType),
      storageBucket: evidence.storageBucket!,
      storageKey: evidence.storageKey!,
    });

    storageBucket = evidence.storageBucket ?? storageBucket;
    storageKey = evidence.storageKey ?? storageKey;
  }

  const reportContentAccessPolicy = resolveEvidenceContentAccessPolicyForSurface(
    {
      configuredMode: process.env.REPORT_CONTENT_ACCESS_MODE ?? undefined,
      surface: "report",
    }
  );

  const previewMap = new Map<string, ExtractedPreview>();

  for (const artifact of loadedArtifacts) {
    // Report byte-loading closure: fetch ONE artifact's bytes at a time for preview
    // extraction, then let it go — peak memory is a single part, not all parts. (A
    // future UC-4 keyframe derivative would replace even this bounded read.)
    const previewBuffer = await streamToBuffer(
      (await readOriginalObject(
        artifact.partIndex === 0 && artifact.id === evidence.id
          ? "the original file"
          : `original part ${artifact.partIndex}`,
        () => getObjectStream({ bucket: artifact.storageBucket, key: artifact.storageKey }),
      )) as unknown as Readable,
    );
    const extracted = await extractPreviewForAsset({
      kind: artifact.kind,
      mimeType: artifact.mimeType,
      buffer: previewBuffer,
    });

    previewMap.set(artifact.id, extracted);
  }

  const contentArtifacts = buildReportEvidenceContent({
    accessPolicy: reportContentAccessPolicy,
    previews: previewMap,
    evidence: {
      id: evidence.id,
      mimeType: evidence.mimeType ?? null,
      sizeBytes: evidence.sizeBytes ?? null,
      storageBucket,
      storageKey,
      fileSha256,
      intakePlanJson: evidence.intakePlanJson ?? null,
    },
    parts: parts.map((part) => ({
      id: part.id,
      partIndex: part.partIndex,
      originalFileName: part.originalFileName,
      mimeType: part.mimeType,
      sizeBytes: part.sizeBytes,
      sha256: part.sha256,
      durationMs: part.durationMs,
      privateRole: part.privateRole ?? null,
      checklistStepId: part.checklistStepId ?? null,
      storageBucket: part.storageBucket,
      storageKey: part.storageKey,
    })),
  });

  const defaultPreviewItem =
    contentArtifacts.items.find((item) => item.previewable) ??
    contentArtifacts.items.find((item) => item.isPrimary) ??
    contentArtifacts.items[0] ??
    null;

  const defaultPreviewItemId = defaultPreviewItem?.id ?? null;

  const contentCompositionSummary = buildContentCompositionSummary(
    contentArtifacts.summary
  );
  const primaryContentLabel = buildPrimaryContentLabel(
    contentArtifacts.summary.primaryKind
  );

  const display = buildEvidenceDisplayDescriptor({
    title: evidence.title,
    summary: contentArtifacts.summary,
    itemCount: contentArtifacts.summary.itemCount,
  });

  const custodyEvents = await prisma.custodyEvent.findMany({
    where: { evidenceId: evidence.id },
    orderBy: { sequence: "asc" },
    select: {
      sequence: true,
      atUtc: true,
      eventType: true,
      payload: true,
      prevEventHash: true,
      eventHash: true,
    },
  });

  const signingKey = await prisma.signingKey.findUnique({
    where: {
      keyId_version: {
        keyId: signingKeyId,
        version: signingKeyVersion,
      },
    },
  });

  if (!signingKey) {
    throw createWorkerError("SIGNING_KEY_NOT_FOUND", false);
  }
  // UC-TRUST-003 — the registry key must be the one the record was signed
  // with (its SPKI SHA-256 is bound to the record at signing). A replaced or
  // forged registry row is refused; a legacy record without the binding keeps
  // the previous behaviour.
  if (evidence.signingKeySha256) {
    const der = createPublicKey(signingKey.publicKeyPem.trim()).export({ type: "spki", format: "der" });
    if (createHash("sha256").update(der).digest("hex") !== evidence.signingKeySha256.toLowerCase()) {
      throw createWorkerError("SIGNING_KEY_IDENTITY_MISMATCH", false);
    }
  }

  const currentMaxReport = await prisma.report.aggregate({
    where: { evidenceId: evidence.id },
    _max: { version: true },
  });

  const provisionalVersion = (currentMaxReport._max.version ?? 0) + 1;
  const now = new Date();
  const reportKey = `reports/${evidence.id}/v${provisionalVersion}.pdf`;
  const verificationKey = `verification/${evidence.id}/v${provisionalVersion}.zip`;
  const publicUrl = storageKey ? buildPublicUrl(storageKey) : null;
  const evidenceDetailUrl = buildEvidenceDetailUrl(evidence.id);
  // ET-PKG-07 — the link this report version will carry. The token is
  // generated now (the PDF must contain it) and its HASH is stored only when
  // the report row commits, in the same transaction: a run that fails leaves
  // no link behind, and a retry generates a fresh one.
  const reportShareToken = generateVerificationShareToken();
  const verifyUrl = buildVerifyUrl(reportShareToken);
  // UC-OUT-001 — Public Verify answers only for a PUBLISHED record. A private
  // record's report prints no link (and no REPORT link is minted): printing
  // one would hand every reader a page that answers "Evidence not found".
  const publicVerifyPublishedAtIssuance = evidence.publicVerifyState === "PUBLISHED";

  const workspaceVerified =
    workspaceTeam?.verificationState ===
    prismaPkg.OrganizationVerificationState.VERIFIED;

  const identityLevel = deriveIdentityLevel({
    provider: ownerUser.provider,
    emailVerifiedAt: ownerUser.emailVerifiedAt ?? null,
    organizationVerificationState:
      ownerUser.organizationVerificationState ?? null,
    currentWorkspaceVerified: workspaceVerified,
    hasWorkspaceTeam: Boolean(evidence.teamId),
  });

  const identitySnapshot: IdentitySnapshot = {
    verificationStatus:
      evidence.verificationStatus ??
      prismaPkg.VerificationStatus.MATERIALS_AVAILABLE,
captureMethod: deriveReportCaptureMethod({
  itemCount: contentArtifacts.summary.itemCount,
  mimeType: contentArtifacts.summary.primaryMimeType ?? evidence.mimeType,
  existingCaptureMethod: evidence.captureMethod ?? null,
}),
    identityLevelSnapshot: identityLevel,
    submittedByEmail: ownerUser.email ?? null,
    submittedByAuthProvider: ownerUser.provider ?? null,
    submittedByUserId: evidence.submittedByUserId ?? evidence.ownerUserId,
    createdByUserId: evidence.createdByUserId ?? evidence.ownerUserId,
    uploadedByUserId:
      evidence.uploadedByUserId ??
      parts.find((p) => p.uploadedByUserId)?.uploadedByUserId ??
      evidence.ownerUserId,
    workspaceNameSnapshot:
      workspaceTeam?.evidenceWorkspaceLabel ?? workspaceTeam?.name ?? null,
    organizationNameSnapshot:
      workspaceTeam?.legalName ?? workspaceTeam?.name ?? null,
    organizationVerifiedSnapshot: workspaceVerified,
    reviewerSummaryVersion: provisionalVersion,
    // Phase 2 — canonical workspace-scope inputs captured at prep time.
    workspaceIsPersonal: workspaceTeam?.isPersonal ?? null,
    workspaceLabelAtPackageTime:
      workspaceTeam?.evidenceWorkspaceLabel ??
      workspaceTeam?.name ??
      null,
  };

  const reviewGuidance = buildReportReviewGuidance({
    itemCount: contentArtifacts.summary.itemCount,
    previewableItemCount: contentArtifacts.summary.previewableItemCount,
    overallIntegrity: Boolean(
      evidence.recordedIntegrityVerifiedAtUtc ||
        evidence.verificationStatus ===
          prismaPkg.VerificationStatus.RECORDED_INTEGRITY_VERIFIED
    ),
  });

  // Evidence Acquisition context (public-safe, no recipient). Resolved here so
  // the custody timeline can render intake-aware capture wording; also reused
  // for the Executive Summary acquisition table below.
  const reportAcquisition = await buildReportAcquisitionContext({
    teamId: evidence.teamId ?? null,
    evidenceId,
  });

  const custodyDisplayContext = {
    itemCount: contentArtifacts.summary.itemCount,
    structure: contentArtifacts.summary.structure,
    isIntake: reportAcquisition?.isIntake === true,
    acquisitionMode: resolveEvidenceAcquisition({
      acquisitionMode: evidence.acquisitionMode ?? null,
    }).mode,
  } as const;

  const custodyEventsForReport = [
    ...custodyEvents.map((ev) => ({
      sequence: ev.sequence,
      atUtc: ev.atUtc.toISOString(),
      eventType: ev.eventType,
      payloadSummary: summarizePayloadForReport(
        ev.eventType,
        ev.payload,
        custodyDisplayContext
      ),
      labelHints: custodyLabelHints(ev.payload),
      prevEventHash: ev.prevEventHash ?? null,
      eventHash: ev.eventHash ?? null,
      category: classifyCustodyEventType(ev.eventType),
    })),
  ];

  const custodyForVerificationPackage = [
    ...custodyEvents.map((ev) => ({
      sequence: ev.sequence,
      atUtc: ev.atUtc.toISOString(),
      eventType: ev.eventType,
      payload: ev.payload,
      prevEventHash: ev.prevEventHash ?? null,
      eventHash: ev.eventHash ?? null,
    })),
  ];

  const verificationPackageIncluded =
    evidenceOutputs.verificationPackageIncluded;

  const reportEvidencePayload = {
    id: evidence.id,
    type: evidence.type,
    intakeCustomerId: evidence.intakeCustomerId ?? null,
createdAtUtc: evidence.createdAt.toISOString(),
    // Client/browser-reported device capture time (NOT a trusted timestamp,
    // NOT the server submission time, NOT EXIF). Carried through so the
    // verification package files (capture-context/case-metadata/
    // original-linkage) match fingerprint.json instead of showing null.
    deviceTimeIso: evidence.deviceTimeIso ?? null,
    title: resolveEvidenceTitle(evidence.title),
    status: evidence.status,
    verificationStatus:
      evidence.verificationStatus ??
      identitySnapshot.verificationStatus,
    captureMethod: identitySnapshot.captureMethod,
    // UC-0 — the acquisition snapshot for this output (never re-derived).
    acquisitionMode: resolveEvidenceAcquisition({
      acquisitionMode: evidence.acquisitionMode ?? null,
    }).mode,
    identityLevelSnapshot: identitySnapshot.identityLevelSnapshot,
    submittedByEmail: identitySnapshot.submittedByEmail,
    submittedByAuthProvider: identitySnapshot.submittedByAuthProvider,
    submittedByUserId: identitySnapshot.submittedByUserId,
    createdByUserId: identitySnapshot.createdByUserId,
    uploadedByUserId: identitySnapshot.uploadedByUserId,
    lastAccessedByUserId: evidence.lastAccessedByUserId ?? null,
    lastAccessedAtUtc: evidence.lastAccessedAtUtc?.toISOString() ?? null,
    workspaceNameSnapshot: identitySnapshot.workspaceNameSnapshot,
    organizationNameSnapshot: identitySnapshot.organizationNameSnapshot,
    organizationVerifiedSnapshot:
      identitySnapshot.organizationVerifiedSnapshot,
    recordedIntegrityVerifiedAtUtc: evidence.recordedIntegrityVerifiedAtUtc
      ? evidence.recordedIntegrityVerifiedAtUtc.toISOString()
      : null,
lastVerifiedAtUtc: now.toISOString(),
lastVerifiedSource: prismaPkg.VerificationSource.REPORT_GENERATED,
verificationPackageGeneratedAtUtc: verificationPackageIncluded
  ? now.toISOString()
  : evidence.verificationPackageGeneratedAtUtc?.toISOString() ?? null,

verificationPackageVersion: verificationPackageIncluded
  ? provisionalVersion
  : evidence.verificationPackageVersion ?? null,
// Phase D Blocker 3 — pass through the persisted per-component artifact
// presence record so the report renders truthful per-component flags
// instead of inferring all components are present from existence.
verificationPackageMetadata:
  (evidence.verificationPackageMetadata as
    | {
        manifestPresent?: boolean;
        signedManifestPresent?: boolean;
        checksumIndexPresent?: boolean;
        auditExportIncluded?: boolean;
        custodyExportIncluded?: boolean;
        accessExportIncluded?: boolean;
        packageVersion?: string;
        generatedAtUtc?: string;
        source?: string;
      }
    | null
    | undefined) ?? null,
      latestReportVersion: evidence.latestReportVersion ?? null,
    reviewReadyAtUtc: evidence.reviewReadyAtUtc?.toISOString() ?? null,
    reviewerSummaryVersion: evidence.reviewerSummaryVersion ?? null,

    capturedAtUtc: evidence.capturedAtUtc?.toISOString() ?? null,
    uploadedAtUtc: evidence.uploadedAtUtc?.toISOString() ?? null,
    signedAtUtc: evidence.signedAtUtc?.toISOString() ?? null,
    reportGeneratedAtUtc: evidence.reportGeneratedAtUtc?.toISOString() ?? null,
    mimeType: evidence.mimeType,
    sizeBytes: evidence.sizeBytes?.toString() ?? null,
    durationSec: evidence.durationSec?.toString() ?? null,
    storageBucket: storageBucket ?? "unknown",
    storageKey: storageKey ?? "multipart",
    publicUrl,
    storageRegion: evidenceStorage.storageRegion,
    storageImmutable: evidenceStorage.storageImmutable,
    storageObjectLockMode: evidenceStorage.storageObjectLockMode,
    storageObjectLockRetainUntilUtc:
      evidenceStorage.storageObjectLockRetainUntilUtc,
    storageObjectLockLegalHoldStatus:
      evidenceStorage.storageObjectLockLegalHoldStatus,
    gps: {
      lat: evidence.lat?.toString() ?? null,
      lng: evidence.lng?.toString() ?? null,
      accuracyMeters: evidence.accuracyMeters?.toString() ?? null,
      // Provenance of (lat, lng) — drives the report's Context Signal
      // source label. Null on legacy rows is fine; the shared helper
      // defaults to the historical CAPTURE label so pre-feature
      // reports render identically.
      locationSource: evidence.locationSource ?? null,
    },

evidenceStructure:
  contentArtifacts.summary.itemCount > 1
    ? "Multipart evidence package"
    : "Single evidence item",
        itemCount: contentArtifacts.summary.itemCount,
    display,
    displayTitle: display.displayTitle,
    displayDescription: display.displayDescription,
    contentAccessPolicy: reportContentAccessPolicy,
    contentSummary: contentArtifacts.summary,
    contentCompositionSummary,
    primaryContentLabel,
    contentItems: contentArtifacts.items,
    primaryContentItem: contentArtifacts.primaryItem,
    defaultPreviewItemId,
    previewPolicy: contentArtifacts.previewPolicy,
    reviewGuidance,
    limitations: contentArtifacts.limitations,

    fileSha256,
    fingerprintCanonicalJson,
    fingerprintHash,
    signatureBase64,
    signingKeyId,
    signingKeyVersion,
    publicKeyPem: signingKey.publicKeyPem,

    tsaProvider: evidence.tsaProvider ?? null,
    tsaUrl: evidence.tsaUrl ?? null,
    tsaSerialNumber: evidence.tsaSerialNumber ?? null,
    tsaGenTimeUtc: evidence.tsaGenTimeUtc?.toISOString() ?? null,
    tsaTokenBase64: evidence.tsaTokenBase64 ?? null,
    tsaMessageImprint: evidence.tsaMessageImprint ?? null,
    tsaInputDigestHex: evidence.tsaInputDigestHex ?? null,
    tsaInputKind: evidence.tsaInputKind ?? null,
    tsaHashAlgorithm: evidence.tsaHashAlgorithm ?? null,
    // ET-TSA-01: an unvalidated STAMPED token is RECORDED_NOT_VALIDATED here,
    // so the report and the package never call it a trusted timestamp.
    tsaStatus: presentedTsaStatus(evidence),
    tsaFailureReason: evidence.tsaFailureReason ?? null,

    // The record's own OTS state, as stored by the one lifecycle that writes
    // it. A report says what is true when it is built; if the anchor is still
    // pending, the report says pending.
    otsProofBase64: evidence.otsProofBase64 ?? null,
    otsHash: evidence.otsHash ?? null,
    otsStatus: evidence.otsStatus ?? null,
    otsCalendar: evidence.otsCalendar ?? null,
    otsBitcoinTxid: evidence.otsBitcoinTxid ?? null,
    otsAnchoredAtUtc: evidence.otsAnchoredAtUtc
      ? evidence.otsAnchoredAtUtc.toISOString()
      : null,
    otsUpgradedAtUtc: evidence.otsUpgradedAtUtc
      ? evidence.otsUpgradedAtUtc.toISOString()
      : null,
    otsFailureReason: evidence.otsFailureReason ?? null,
    // How the anchor was established — only BITCOIN_VERIFIED may read verified.
    otsAnchorCheck: evidence.otsAnchorCheck ?? null,

    anchor: anchorSummary,
    certifications,
} as ReportBuildParams["evidence"];

const trustDecision = buildTrustDecision({
  evidence: reportEvidencePayload,
  custodyEvents: custodyEventsForReport,
  isIntake: reportAcquisition?.isIntake === true,
});

  // Phase 31.11 — bounded media intelligence projection. Never throws,
  // never blocks: a null result means the report renders byte-identical
  // to the pre-31.10 legacy output. A non-null result means the
  // advisory "Media Intelligence Observations" section will render.
  const reportMediaIntelligence = await buildReportMediaIntelligence({
    teamId: evidence.teamId ?? null,
    evidenceId,
  });

  // Enterprise Technical Metadata layer — compact technical summary
  // projection (media facts + EXIF summary + capture environment).
  // Never throws; null means the "Media Technical Summary" section
  // renders nothing.
  const reportTechnicalSummary = await buildReportTechnicalSummary({
    teamId: evidence.teamId ?? null,
    evidenceId,
  });

  // UC-4 — bounded DERIVED screen-review summary (provenance-only). Null when
  // no reconstruction exists, so the report is byte-identical for non-UC-4.
  const reportDerivedReview = await buildReportDerivedReview({
    teamId: evidence.teamId ?? null,
    evidenceId,
    ownerUserId: evidence.ownerUserId ?? null,
  });

  const reportBuildParams: ReportBuildParams = {
    evidence: reportEvidencePayload,
    custodyEvents: custodyEventsForReport,
    version: provisionalVersion,
    generatedAtUtc: now.toISOString(),
    buildInfo: env.WORKER_BUILD_INFO ?? null,
    verifyUrl,
    publicVerificationPublished: publicVerifyPublishedAtIssuance,
    // UC-TRUST-008 — the exact bytes this report certifies (re-read above).
    certifiedOriginal: {
      recordedSha256: expectedOriginalDigest,
      objectVersionIds:
        parts.length > 0 ? parts.map((p) => p.storageVersionId ?? null) : [evidence.storageVersionId ?? null],
      rereadAtUtc: now.toISOString(),
    },
    // UC-PROV-003 — the validated manifest facts of the capture that sealed.
    captureManifest: (await loadProvenanceChainForPackage(evidence.id))?.captureManifestFacts ?? null,
    downloadUrl: evidenceDetailUrl,
    externalMode: false,
    mediaIntelligence: reportMediaIntelligence,
    technicalSummary: reportTechnicalSummary,
    acquisition: reportAcquisition,
    derivedReview: reportDerivedReview,
  };

// Phase A2 — call the signature-aware variant so the Report row
// can persist the explicit pdfSignatureStatus + signedAtUtc +
// signerKeyId + warning. The legacy bytes-only signature
// (`buildReportPdfV2`) is preserved for callers that only need
// the PDF; new code paths use the outcome variant.
const pdfSigningOutcome: import("./pdf/signPdf.js").PdfSigningOutcome =
  options?.skipProvisionalPdf === true
    ? {
        status: "UNSIGNED_OPT_OUT",
        pdf: Buffer.alloc(0),
        warning: "Not rendered: package-only recovery embeds the stored report.",
      }
    : await buildReportPdfV2WithSignatureOutcome(reportBuildParams);
const reportPdf = pdfSigningOutcome.pdf;

const verificationZip: Buffer | null = null;

  if (verificationEvidenceFiles.length > 0 && !verificationPackageIncluded) {
    logger.info(
      {
        evidenceId,
        plan: effectivePlan,
      },
      "Verification package skipped because it is not included in the current plan"
    );
  }

return {
  reportPdf,
  // Phase A2 — propagate the signing outcome to the finalize
  // transaction below so the Report row carries the structured
  // signature status.
  pdfSigningOutcome,
  verificationZip,
  verifyUrl,
  reportShareToken,
  publicVerifyPublishedAtIssuance,
  downloadUrl: evidenceDetailUrl,
  reportKey,
  verificationKey,
  version: provisionalVersion,
  now,
  evidenceId: evidence.id,
  evidenceStorage,
  fingerprintCanonicalJson,
  identitySnapshot,
  effectivePlan,
  display,
  reviewGuidance,
  contentAccessPolicy: reportContentAccessPolicy,
  contentSummary: contentArtifacts.summary,
  contentItems: contentArtifacts.items,
  primaryContentItem: contentArtifacts.primaryItem,
  previewPolicy: contentArtifacts.previewPolicy,
  contentCompositionSummary,
  primaryContentLabel,
  defaultPreviewItemId,
  limitations: contentArtifacts.limitations,
  verificationEvidenceFiles,
  verificationPackageIncluded,
  anchorSummary,
reportEvidencePayload,
trustDecision,
certifications,
custodyForVerificationPackage,
packageMetadataContext: {
    caseId: primaryCaseId,
    caseName: caseItem?.name ?? null,
    customerId: evidence.intakeCustomerId ?? null,
    retentionPolicy: null,
    workspaceId: evidence.teamId ?? null,
    organizationId: evidence.organizationId ?? null,
    teamId: evidence.teamId ?? null,
    ownerUserId: evidence.ownerUserId ?? null,
  },
};
}

/**
 * PHASE 12 — POINT 5: the report processor's entry point.
 *
 * The queue now carries a `ReportGenerationRequest` id and nothing else. This
 * function's whole job is to turn that id into a runnable command — or into a
 * bounded refusal — and then hand the command to the generation body below,
 * which is unchanged apart from reading the command instead of the payload.
 *
 * Four outcomes never reach the generator:
 *
 *   * a payload that does not decode (rejected before any DB access);
 *   * a request already terminal (REPLAY: the stored result is returned, no
 *     second artifact is produced and no second completion event is emitted);
 *   * a request whose workspace, organization, policy version or legal-hold
 *     state no longer permits it (BLOCKED, written terminally before any
 *     storage write);
 *   * a request another worker holds a live claim on (bounded no-op).
 */
export async function processGenerateReport(job: Job<unknown>) {
  const requestId = randomUUID();

  const decoded = decodeCanonicalJob(JOB_NAMES.GENERATE_REPORT, job, {
    requestId,
  });

  // A pre-Point-5 job still draining out of Redis names an EVIDENCE id, not a
  // request id. It is minted into a durable request — deliberately without the
  // `forceRegenerate` its payload asserted — so it runs through exactly the
  // same authority as everything else.
  let commandRequestId = decoded.commandId;
  if (decoded.legacy) {
    const minted = await mintRequestForLegacyJob({
      evidenceId: decoded.commandId,
      jobId: job.id,
    });
    if (minted.requestId === null) {
      logger.warn(
        { requestId, jobId: job.id ?? null, reason: minted.reason },
        "GenerateReportJob legacy drain could not mint a durable request",
      );
      return;
    }
    commandRequestId = minted.requestId;
  }

  const resolution = await resolveAndClaimReportRequest({
    requestId: commandRequestId,
    requestIdForLog: requestId,
  });

  if (resolution.outcome === "replay") {
    logger.info(
      {
        requestId,
        jobId: job.id ?? null,
        reportRequestId: commandRequestId,
        state: resolution.state,
        status: "replay_noop",
      },
      "GenerateReportJob replayed onto a terminal request; no artifact regenerated",
    );
    return;
  }

  if (resolution.outcome === "noop") {
    logger.warn(
      {
        requestId,
        jobId: job.id ?? null,
        reportRequestId: commandRequestId,
        reason: resolution.reason,
        status: "refused",
      },
      "GenerateReportJob refused before any mutation",
    );
    return;
  }

  const command = resolution.command;
  let run: ReportRunResult;
  try {
    run = await runReportGeneration(job, command, requestId);
  } catch (error) {
    // Terminal vs retryable is decided by the SAME predicate the queue uses, so
    // the durable row and the queue cannot disagree about whether the intent is
    // still alive.
    // ET-SEC-30 — both writes are fenced by this run's claim: a late worker
    // whose lease was re-claimed changes nothing.
    const fence = { claimedAtUtc: command.claimedAtUtc };
    if (isRetriableError(error)) {
      await markRequestRetryable({
        requestId: command.requestId,
        terminalReasonCode: toBoundedReasonCode(error),
        fence,
      });
    } else {
      await markRequestTerminal({
        requestId: command.requestId,
        state: "FAILED_TERMINAL",
        terminalReasonCode: toBoundedReasonCode(error),
        fence,
      });
    }
    throw error;
  }

  // The artifact the run actually produced or targeted (ET-RPT-07), recorded
  // on the request so a replay returns it instead of generating a second one.
  // A pair already complete names the version it targeted; a run that lost to
  // another issuance produced nothing and records no report.
  const produced =
    run.reportVersion !== null
      ? await prisma.report.findUnique({
          where: { evidenceId_version: { evidenceId: command.evidenceId, version: run.reportVersion } },
          select: { id: true },
        })
      : null;
  await markRequestTerminal({
    requestId: command.requestId,
    state: "SUCCEEDED",
    terminalReasonCode: run.outcome,
    resultReportId: produced?.id ?? null,
    fence: { claimedAtUtc: command.claimedAtUtc },
  });
}

/**
 * Bounded failure code for the durable row.
 *
 * A raw error message can carry a storage key, a signing-key path or a
 * recipient address, and the request row is readable through the operator
 * projection. Only the error's own code survives.
 */
function toBoundedReasonCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code) return code.slice(0, 64);
  }
  if (error instanceof Error) return error.name.slice(0, 64);
  return "unknown_error";
}

/**
 * The stored bytes of a committed report, VERIFIED, or an explicit refusal.
 *
 * Package-only recovery embeds the report that already exists. It may do so
 * only after proving the bytes in storage are the bytes that were recorded:
 *
 *   * `reports.pdf_sha256` when the row carries it (every report written since
 *     it was introduced);
 *   * otherwise the SHA-256 the object store validated and kept when the
 *     worker PUT the PDF with `ChecksumSHA256` (legacy rows);
 *   * otherwise nothing can vouch for the bytes, and they are not used.
 *
 * Every refusal is terminal and non-retryable: a missing, unverifiable or
 * altered report is a matter for a person, and silently rendering a
 * replacement would put new bytes behind a version that is already published.
 * Only a transient read failure is retried.
 */
export async function readVerifiedStoredReport(
  report: {
    version: number;
    storageBucket: string;
    storageKey: string;
    sizeBytes: bigint | null;
    pdfSha256: string | null;
    /** UC-OUT-003 — the committed report object VERSION; read exactly it when recorded. */
    s3VersionId?: string | null;
  },
  io: { head: typeof headObject; stream: typeof getObjectStream } = { head: headObject, stream: getObjectStream },
): Promise<{ bytes: Buffer; sha256: string }> {
  const isNotFound = isStorageNotFound;
  // UC-OUT-003 — pinned like the originals (ET-PKG-15): a later object version
  // at the same key (an interrupted earlier attempt) must not be read in place
  // of the committed one.
  const versionId = report.s3VersionId ?? null;
  let head: Awaited<ReturnType<typeof headObject>>;
  try {
    head = await io.head({ bucket: report.storageBucket, key: report.storageKey, versionId });
  } catch (err) {
    if (isNotFound(err)) throw createWorkerError("REPORT_OBJECT_MISSING", false);
    throw createWorkerError("REPORT_OBJECT_READ_FAILED", true);
  }
  let bytes: Buffer;
  try {
    const body = await io.stream({ bucket: report.storageBucket, key: report.storageKey, versionId });
    bytes = await streamToBuffer(body as unknown as Readable);
  } catch (err) {
    if (isNotFound(err)) throw createWorkerError("REPORT_OBJECT_MISSING", false);
    throw createWorkerError("REPORT_OBJECT_READ_FAILED", true);
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (report.sizeBytes != null && BigInt(bytes.length) !== report.sizeBytes) {
    throw createWorkerError("REPORT_INTEGRITY_MISMATCH", false);
  }
  if (report.pdfSha256) {
    if (report.pdfSha256.toLowerCase() !== sha256) {
      throw createWorkerError("REPORT_INTEGRITY_MISMATCH", false);
    }
    return { bytes, sha256 };
  }
  // A composite checksum ("…-N", multipart upload) is not a hash of the bytes.
  const stored = head.checksumSha256;
  if (stored && !stored.includes("-")) {
    if (Buffer.from(stored, "base64").toString("hex") !== sha256) {
      throw createWorkerError("REPORT_INTEGRITY_MISMATCH", false);
    }
    return { bytes, sha256 };
  }
  throw createWorkerError("REPORT_INTEGRITY_UNVERIFIABLE", false);
}

/**
 * The `finalized` context the package stage needs, for a report that ALREADY
 * exists — built from persisted state instead of from a report transaction.
 *
 * Nothing here writes. The report row, its object and the evidence row are
 * read; the version, keys and trust decision are the report's own, so the
 * package certifies exactly the report it embeds.
 */
async function loadCommittedReportForPackage(params: {
  evidenceId: string;
  version: number;
  prepared: PreparedReportArtifacts;
  teamId: string | null;
}) {
  const { evidenceId, version, prepared } = params;
  const report = await prisma.report.findUnique({
    where: { evidenceId_version: { evidenceId, version } },
    select: {
      version: true,
      storageBucket: true,
      storageKey: true,
      sizeBytes: true,
      pdfSha256: true,
      generatedAtUtc: true,
      reviewerSummaryVersion: true,
      trustDecisionSnapshot: true,
      s3VersionId: true,
    },
  });
  if (!report) throw createWorkerError("REPORT_VERSION_NOT_FOUND", false);

  const verified = await readVerifiedStoredReport(report);

  // Every downstream consumer reads the version and keys from `prepared`.
  prepared.version = version;
  prepared.reportKey = report.storageKey;

  const current = await prisma.evidence.findUniqueOrThrow({
    where: { id: evidenceId },
    select: {
      verificationStatus: true,
      recordedIntegrityVerifiedAtUtc: true,
      reviewReadyAtUtc: true,
    },
  });
  /*
   * AS OF THE REPORT'S ISSUANCE, NOT AS OF NOW.
   *
   * A package built later for an issued report used to carry every custody
   * event up to the moment of assembly, beside a report that described the
   * chain as it stood when it was issued. The package now carries the chain
   * the report describes: every event recorded at or before the report's
   * issuance instant (the issuance's own events share that instant). Later
   * events are later facts; the seal records the cut-off and that the package
   * was assembled after the report.
   */
  // ET-CUS-06: a contiguous prefix by SEQUENCE (custody-issuance-cutoff).
  const custodyEvents = await custodyThroughIssuance(prisma, evidenceId, report.generatedAtUtc);

  const effectiveVerificationStatus =
    current.verificationStatus ?? prepared.identitySnapshot.verificationStatus;
  const effectiveRecordedIntegrityVerifiedAtUtc =
    current.recordedIntegrityVerifiedAtUtc?.toISOString() ?? null;
  const finalizedReportEvidencePayload = {
    ...prepared.reportEvidencePayload,
    status: EvidenceStatus.REPORTED,
    verificationStatus: effectiveVerificationStatus,
    recordedIntegrityVerifiedAtUtc: effectiveRecordedIntegrityVerifiedAtUtc,
    reportGeneratedAtUtc: report.generatedAtUtc.toISOString(),
    latestReportVersion: version,
    reviewReadyAtUtc:
      current.reviewReadyAtUtc?.toISOString() ?? report.generatedAtUtc.toISOString(),
    reviewerSummaryVersion: report.reviewerSummaryVersion ?? version,
  };

  // The decision the report itself carries; rebuilt only for rows written
  // before the snapshot existed.
  let finalizedTrustDecision = report.trustDecisionSnapshot as unknown as ReturnType<
    typeof buildTrustDecision
  > | null;
  if (!finalizedTrustDecision) {
    const acquisition = await buildReportAcquisitionContext({
      teamId: params.teamId,
      evidenceId,
    });
    const displayContext = {
      itemCount: prepared.contentSummary.itemCount,
      structure: prepared.contentSummary.structure,
      isIntake: acquisition?.isIntake === true,
      acquisitionMode: finalizedReportEvidencePayload.acquisitionMode ?? null,
    } as const;
    finalizedTrustDecision = buildTrustDecision({
      evidence: finalizedReportEvidencePayload,
      custodyEvents: custodyEvents.map((ev) => ({
        sequence: ev.sequence,
        atUtc: ev.atUtc.toISOString(),
        eventType: ev.eventType,
        payloadSummary: summarizePayloadForReport(ev.eventType, ev.payload, displayContext),
        labelHints: custodyLabelHints(ev.payload),
        prevEventHash: ev.prevEventHash ?? null,
        eventHash: ev.eventHash ?? null,
        category: classifyCustodyEventType(ev.eventType),
      })),
      isIntake: acquisition?.isIntake === true,
    });
  }

  return {
    skipped: false as const,
    reportCreated: false as const,
    version,
    reportKey: report.storageKey,
    reportVersion: version,
    finalizedReportSha256: verified.sha256,
    finalizedReportEvidencePayload,
    effectiveVerificationStatus,
    effectiveRecordedIntegrityVerifiedAtUtc,
    finalizedReportPdf: verified.bytes,
    finalizedTrustDecision,
    reportIssuedAtUtc: report.generatedAtUtc,
    custodyThroughSequence: custodyEvents.at(-1)?.sequence ?? null,
    finalizedCustodyEvents: custodyEvents.map((ev) => ({
      sequence: ev.sequence,
      atUtc: ev.atUtc.toISOString(),
      eventType: ev.eventType,
      payload: ev.payload,
      prevEventHash: ev.prevEventHash ?? null,
      eventHash: ev.eventHash ?? null,
    })),
  };
}

/**
 * ET-RPT-07 — what a run produced or targeted, so the request records THAT
 * report, never "the newest one": a package-only recovery for v1 (while v2
 * exists), a pair already complete, or a run that lost the race to another
 * issuance each named the newest report as their result.
 */
/**
 * ET-SM-02 — the states a record may be in for a report to COMMIT: signed or
 * already reported, not trashed, not destroyed or pending destruction.
 */
const REPORTABLE_AT_COMMIT_WHERE: Prisma.EvidenceWhereInput = {
  status: { in: [EvidenceStatus.SIGNED, EvidenceStatus.REPORTED] },
  deletedAt: null,
  lifecycleState: { notIn: ["DESTROYED", "PENDING_DESTRUCTION", "TRASHED"] },
};

function isReportableAtCommit(e: { status: string; deletedAt: Date | null; lifecycleState: string | null }): boolean {
  return (
    (e.status === EvidenceStatus.SIGNED || e.status === EvidenceStatus.REPORTED) &&
    e.deletedAt === null &&
    e.lifecycleState !== "DESTROYED" &&
    e.lifecycleState !== "PENDING_DESTRUCTION" &&
    e.lifecycleState !== "TRASHED"
  );
}

export type ReportRunResult =
  | { outcome: "generated"; reportVersion: number }
  | { outcome: "package_built"; reportVersion: number }
  /** Nothing to do: the pair at this version already existed. */
  | { outcome: "pair_complete"; reportVersion: number }
  /** Another issuance committed first; this run produced nothing. */
  | { outcome: "already_issued"; reportVersion: null };

async function runReportGeneration(
  job: Job<unknown>,
  command: ResolvedReportCommand,
  requestId: string,
): Promise<ReportRunResult> {
  // Phase O1.5C — emit bounded report.generate + render.html span at
  // entry. The inner render.pdf / upload / publish spans are emitted
  // at their actual call sites below. NEVER report contents / PDF
  // bytes / signed URLs in attributes.
  await withProovraSpan(PROOVRA_SPAN_NAMES.REPORT_GENERATE, { "proovra.operation": "report_generate", "proovra.evidence_id": command.evidenceId }, () => undefined);
  await withProovraSpan(PROOVRA_SPAN_NAMES.REPORT_RENDER_HTML, { "proovra.operation": "report_render_html", "proovra.evidence_id": command.evidenceId }, () => undefined);
  const start = Date.now();
  const evidenceId = command.evidenceId;
  const forceRegenerate = command.forceRegenerate;
  const regenerateReason = command.regenerateReason;

  const ctx = withJobContext({
    requestId,
    jobId: job.id,
    evidenceId,
    attempt: job.attemptsMade + 1,
    status: forceRegenerate ? "regenerating" : "started",
  });

  logger.info(ctx, "GenerateReportJob started");

  try {
    const evidence = await prisma.evidence.findFirst({
      where: { id: evidenceId, deletedAt: null },
    });

    if (!evidence) {
      throw createWorkerError("EVIDENCE_NOT_FOUND", false);
    }

    /*
     * Is this record entitled to a verification package at all?
     *
     * Asked through the ONE authority, with plan AND this record's own funding,
     * exactly as `prepareReportArtifacts` asks it a few lines later — so the
     * completeness guard below and the generation gate cannot disagree about
     * whether a package was ever owed. A record whose plan excludes packages is
     * COMPLETE with a report alone, and must not be regenerated forever chasing
     * an output it was never going to get.
     *
     * Fails OPEN (`true`) on a resolution error: the worse mistake here is to
     * declare a pair complete that is not, because that is the silent state this
     * whole closure exists to end.
     */
    const packageIssuance = await resolveEvidenceOutputIssuance({
      id: evidence.id,
      ownerUserId: evidence.ownerUserId,
      teamId: evidence.teamId ?? null,
    });
    // Never guessed: an unreadable entitlement is neither "owed" nor "not
    // owed". The run stops and retries later rather than declaring a pair
    // complete (or incomplete) on a guess. (This guard used to fail OPEN.)
    if (packageIssuance.decision === "UNRESOLVED") {
      throw createWorkerError(OUTPUT_ENTITLEMENT_UNRESOLVED, true);
    }
    const verificationPackageEntitled =
      packageIssuance.decision === "ENTITLED" &&
      packageIssuance.verificationPackageIncluded;

    /*
     * RELIABILITY CLOSURE (2026-09-09) — THE PACKAGE FAILURE THIS RUN SAW.
     *
     * The report transaction and the verification-package transaction are two
     * durable writes for ONE requested output. When the package half failed,
     * both of its catch branches logged, counted and swallowed — and the caller
     * then marked the whole request SUCCEEDED. The customer's projection said
     * the package had simply never been asked for, Operations opened nothing,
     * and the only convergence was a human noticing and clicking Generate.
     *
     * A request is not successful while an output it is responsible for is
     * missing. This carries the fact out of the swallow and into the run's
     * result, where the terminal write can see it.
     *
     * A GOVERNANCE DENIAL IS NOT RECORDED HERE. That is a legitimate modelled
     * outcome with its own persisted metadata and its own operational
     * condition; treating it as a pipeline failure would turn a policy decision
     * into an incident and retry against a gate that is meant to hold.
     */
    let packageTechnicalFailure: {
      phase: string;
      message: string;
      /** False for a deterministic storage refusal: retrying cannot succeed. */
      retriable?: boolean;
      storageCode?: string | null;
    } | null = null;
    /**
     * The package was refused by the workspace allowance (plan or storage),
     * not failed by the pipeline. Carried out so the request records the
     * commercial answer instead of escalating an outage.
     */
    let packageAllowanceRefusal: PackageAllowanceRefusal | null = null;

    /*
     * =====================================================================
     * WHAT THIS RUN IS FOR — decided from durable facts, not from "a Report
     * row exists".
     * =====================================================================
     *
     *   NEW_REPORT           render, sign and commit report vN+1, then its
     *                        package. First generation, or an explicit new
     *                        version (`forceRegenerate`, authorized upstream).
     *   PACKAGE_FOR_VERSION  the report the request owns already exists; build
     *                        ONLY its package, embedding the STORED report
     *                        bytes after verifying them. Never a new report.
     *
     * A retry of a request that already committed its report (`stage =
     * REPORT_COMMITTED`) resumes as PACKAGE_FOR_VERSION for exactly that
     * version — this is what stops every retry from minting another report.
     * A package-only recovery request (`artifactType = VERIFICATION_PACKAGE`)
     * targets the version it names. A non-forced completion request on a
     * REPORTED record completes the pair for the latest report; that path used
     * to reach `prepareReportArtifacts(allowReported: false)`, throw
     * `REPORT_ALREADY_GENERATED`, and be recorded as SUCCEEDED with no package.
     */
    const latestReportRow = await prisma.report.findFirst({
      where: { evidenceId },
      orderBy: { version: "desc" },
      select: { version: true },
    });
    let runMode: "NEW_REPORT" | "PACKAGE_FOR_VERSION";
    let packageTargetVersion: number | null = null;
    if (
      command.reportVersion != null &&
      (command.stage === "REPORT_COMMITTED" ||
        command.stage === "PACKAGE_PUBLISHED" ||
        command.artifactType === "VERIFICATION_PACKAGE")
    ) {
      runMode = "PACKAGE_FOR_VERSION";
      packageTargetVersion = command.reportVersion;
    } else if (command.artifactType === "VERIFICATION_PACKAGE") {
      if (!latestReportRow) throw createWorkerError("REPORT_VERSION_NOT_FOUND", false);
      runMode = "PACKAGE_FOR_VERSION";
      packageTargetVersion = latestReportRow.version;
    } else if (forceRegenerate) {
      runMode = "NEW_REPORT";
    } else if (evidence.status === EvidenceStatus.REPORTED) {
      if (!latestReportRow) {
        // REPORTED with no report row is a consistency fault, not a request to
        // mint one: a person reviews it before anything is regenerated.
        throw createWorkerError("REPORT_MISSING_FOR_REPORTED_EVIDENCE", false);
      }
      runMode = "PACKAGE_FOR_VERSION";
      packageTargetVersion = latestReportRow.version;
    } else {
      runMode = "NEW_REPORT";
    }

    if (runMode === "PACKAGE_FOR_VERSION" && packageTargetVersion != null) {
      const pairComplete =
        !verificationPackageEntitled ||
        (await prisma.verificationPackage.findFirst({
          where: { evidenceId, version: packageTargetVersion },
          select: { id: true },
        })) !== null;
      if (pairComplete) {
        logger.info(
          { ...ctx, reportVersion: packageTargetVersion, status: "pair_complete" },
          "Report and its verification package already exist for this version; nothing to do",
        );
        return { outcome: "pair_complete", reportVersion: packageTargetVersion };
      }
      logger.warn(
        { ...ctx, reportVersion: packageTargetVersion, status: "package_recovery" },
        "Report exists without its verification package; building the package for the stored report",
      );
    }

    /*
     * =====================================================================
     * OTS IS NOT THIS JOB'S TO CREATE. IT READS THE RECORD'S OWN STATE.
     * =====================================================================
     * This job used to call `createOpenTimestamp` here, persist the result in
     * its own transaction below, and schedule the upgrade. That made a
     * COMMERCIAL pipeline the owner of an INTEGRITY proof, with two costs.
     *
     * The customer-facing one: a record whose plan does not include reports
     * has no report job, so it never obtained an anchor — while Pricing lists
     * OpenTimestamps under "Every plan includes". And when the job did run for
     * such a record, the stamp was created at the top and thrown away when
     * `prepareReportArtifacts` refused a few lines later. The calendar was
     * contacted to produce a proof nobody would ever store.
     *
     * The structural one: a report is a RENDERING of integrity state, and a
     * renderer that also produces what it renders cannot be re-run safely.
     * Regeneration had to be excluded by hand (`!forceRegenerate`) to avoid
     * minting a second proof for one record.
     *
     * Initialization now belongs to `ots-lifecycle.ts`, driven by the
     * `ots-upgrade` queue and triggered by evidence finalization. This job
     * reads `evidence.ots*` like any other stored field — `prepareReportArtifacts`
     * already fell back to those columns whenever no stamp was passed, so the
     * report's content is unchanged for a record that has one, and truthful
     * rather than absent for a record that does not.
     */
    const prepared = await prepareReportArtifacts(evidenceId, {
      allowReported: forceRegenerate || runMode === "PACKAGE_FOR_VERSION",
      skipProvisionalPdf: runMode === "PACKAGE_FOR_VERSION",
      refreshReason: regenerateReason,
      // Phase A0 — pass job context through so the integrity-rejection
      // helper can tag any SecurityEvent / log with the originating job.
      jobId: job.id ?? null,
      attempt: job.attemptsMade + 1,
    }).catch(async (err: unknown) => {
      // ET-SM-07 — A STORAGE ANOMALY IS AN INTEGRITY FACT. The original was
      // not readable at its recorded location, so nothing was issued; the
      // recheck authority records that against the record (its state becomes
      // "failed", not "verified") instead of leaving the last good check
      // standing. Best-effort: the original refusal is what the job reports.
      if ((err as { code?: string } | null)?.code === EVIDENCE_ORIGINAL_NOT_FOUND) {
        await recheckEvidenceIntegrity({
          evidenceId,
          trigger: "STORAGE_ANOMALY",
          correlationId: job.id != null ? String(job.id) : null,
          force: true,
        }).catch(() => undefined);
      }
      throw err;
    });

    const finalized =
      runMode === "PACKAGE_FOR_VERSION"
        ? await loadCommittedReportForPackage({
            evidenceId,
            version: packageTargetVersion!,
            prepared,
            teamId: evidence.teamId ?? null,
          })
        : await (async () => {
        /*
         * =====================================================================
         * REPORT ISSUANCE IN THREE PHASES (2026-09-29)
         * =====================================================================
         * The report used to be rendered, uploaded to object storage, retention-
         * locked and HEAD-checked INSIDE one 120-second database transaction.
         * A storage call inside a transaction holds row locks and a connection
         * for the length of a network round trip, and when the commit then
         * failed the locked object was already published under a key the retry
         * would write again with different bytes.
         *
         *   A. RESERVE (short transaction, advisory lock): decide whether this
         *      run may issue a report at all, and reserve version N on the
         *      request row (`stage = REPORT_RESERVED`). A retry of the same
         *      request reuses its reservation; a concurrent request reserves
         *      past it.
         *   B. RENDER + PUBLISH (no transaction): read the record, render the
         *      PDF, check the allowance with the exact size, publish it once
         *      to a single-use key with its checksum and retention, and verify
         *      it by VersionId.
         *   C. COMMIT (short transaction, advisory lock): confirm the
         *      reservation still stands, then append the issuance custody
         *      events, write the Report row with the exact object identity,
         *      and advance the request to REPORT_COMMITTED.
         *
         * If C refuses (someone else committed N), the object published in B is
         * an unreferenced immutable orphan — never a second version at a key a
         * row points to — and the run retries against fresh state.
         *
         * The PDF describes the custody chain AS OF ITS ISSUANCE: it is
         * rendered from the chain read in B, and `custodyThroughSequence` on
         * the row records exactly where that chain ended. The issuance's own
         * events (identity context, REPORT_GENERATED, REVIEW_READY) are
         * appended in C and follow it in the chain.
         */

        // ---- A. RESERVE ----------------------------------------------------
        const reservation = await prisma.$transaction(
          async (tx) => {
            await tx.$executeRaw`
              SELECT pg_advisory_xact_lock(hashtext(${prepared.evidenceId}))
            `;
            const lockedEvidence = await tx.evidence.findFirst({
              where: { id: prepared.evidenceId, deletedAt: null },
              select: {
                id: true,
                status: true,
                fileSha256: true,
                fingerprintHash: true,
                signatureBase64: true,
                signingKeyId: true,
                signingKeyVersion: true,
              },
            });
            if (!lockedEvidence) {
              throw createWorkerError("EVIDENCE_NOT_FOUND", false);
            }

            const existingLatestReport = await tx.report.findFirst({
              where: { evidenceId: prepared.evidenceId },
              orderBy: { version: "desc" },
              select: { version: true },
            });

            /*
             * Completeness is a PAIR AT ONE VERSION: the package that
             * accompanies the latest report, not "some package". Report v2
             * beside package v1 is not complete — package v1 embeds report v1.
             */
            const lockedPackage =
              verificationPackageEntitled && existingLatestReport
                ? await tx.verificationPackage.findFirst({
                    where: {
                      evidenceId: prepared.evidenceId,
                      version: existingLatestReport.version,
                    },
                    select: { id: true },
                  })
                : null;

            if (
              lockedEvidence.status === EvidenceStatus.REPORTED &&
              existingLatestReport &&
              !forceRegenerate
            ) {
              if (!verificationPackageEntitled || lockedPackage !== null) {
                return {
                  skipped: true as const,
                  existingReportVersion: existingLatestReport.version,
                };
              }
              // A concurrent run committed a report after this run decided to
              // issue the first one. Issuing another would be wrong; the retry
              // re-reads the state and completes that report's package instead.
              throw createWorkerError("REPORT_STATE_CHANGED_RETRY", true);
            }

            if (
              lockedEvidence.status !== EvidenceStatus.SIGNED &&
              !(forceRegenerate && lockedEvidence.status === EvidenceStatus.REPORTED)
            ) {
              throw createWorkerError(
                `EVIDENCE_NOT_SIGNED:${lockedEvidence.status}`,
                false,
              );
            }

            if (
              !lockedEvidence.fileSha256 ||
              !lockedEvidence.fingerprintHash ||
              !lockedEvidence.signatureBase64 ||
              !lockedEvidence.signingKeyId ||
              lockedEvidence.signingKeyVersion == null
            ) {
              throw createWorkerError("SIGNED_EVIDENCE_CRYPTO_STATE_INCOMPLETE", false);
            }

            // This request's own reservation, when a previous attempt made one
            // and nothing was committed at it.
            const own = await tx.reportGenerationRequest.findUnique({
              where: { id: command.requestId },
              select: { reportVersion: true, stage: true },
            });
            const latestVersion = existingLatestReport?.version ?? 0;
            let reserved: number;
            if (
              own?.stage === "REPORT_RESERVED" &&
              own.reportVersion != null &&
              own.reportVersion > latestVersion
            ) {
              reserved = own.reportVersion;
            } else {
              const others = await tx.reportGenerationRequest.aggregate({
                where: {
                  evidenceId: prepared.evidenceId,
                  id: { not: command.requestId },
                  stage: "REPORT_RESERVED",
                  state: { in: ["QUEUED", "PROCESSING", "FAILED_RETRYABLE"] },
                },
                _max: { reportVersion: true },
              });
              reserved = Math.max(latestVersion, others._max.reportVersion ?? 0) + 1;
              const fenced = await tx.reportGenerationRequest.updateMany({
                where: claimFenceWhere(command),
                data: { reportVersion: reserved, stage: "REPORT_RESERVED" },
              });
              if (fenced.count !== 1) throw new ReportClaimLost(command.requestId);
            }
            return {
              skipped: false as const,
              reservedVersion: reserved,
              previousReportVersion: existingLatestReport?.version ?? null,
            };
          },
          { maxWait: 10_000, timeout: 15_000 },
        );

        if (reservation.skipped) {
          return {
            skipped: true as const,
            existingReportVersion: reservation.existingReportVersion,
            reportVersion: reservation.existingReportVersion,
            finalizedCustodyEvents: [],
          };
        }

        const reservedVersion = reservation.reservedVersion;
        prepared.version = reservedVersion;
        /*
         * The reviewer-summary version travels on the identity snapshot and is
         * persisted on the Report row, so it follows the reservation; it was
         * captured from the provisional number at prep time.
         */
        prepared.identitySnapshot.reviewerSummaryVersion = reservedVersion;
        // DURABLE PROGRESS — the version is reserved; rendering begins.
        await recordRequestProgress(command, "RENDERING_REPORT");

        // ---- B. RENDER + PUBLISH (no transaction) --------------------------
        const lockedEvidence = await prisma.evidence.findFirst({
          where: { id: prepared.evidenceId, deletedAt: null },
          select: {
            id: true,
            verificationStatus: true,
            recordedIntegrityVerifiedAtUtc: true,
            // Phase 6 — Read Phase T template-identity trio so the
            // generated report can surface a provenance envelope.
            // Identity-only; never drives policy.
            templateSlug: true,
            templateVersion: true,
            templateDbId: true,
          },
        });
        if (!lockedEvidence) {
          throw createWorkerError("EVIDENCE_NOT_FOUND", false);
        }

        const custodyAtIssue = await prisma.custodyEvent.findMany({
          where: { evidenceId: prepared.evidenceId },
          orderBy: { sequence: "asc" },
          select: {
            sequence: true,
            atUtc: true,
            eventType: true,
            payload: true,
            prevEventHash: true,
            eventHash: true,
          },
        });
        const custodyThroughSequence = custodyAtIssue.at(-1)?.sequence ?? null;

        const promotionDecision = resolveRecordedIntegrityPromotionDecision({
          evidenceId: prepared.evidenceId,
          verificationStatus: lockedEvidence.verificationStatus ?? null,
          recordedIntegrityVerifiedAtUtc:
            lockedEvidence.recordedIntegrityVerifiedAtUtc ?? null,
          fileSha256: prepared.reportEvidencePayload.fileSha256!,
          fingerprintCanonicalJson: prepared.fingerprintCanonicalJson,
          fingerprintHash: prepared.reportEvidencePayload.fingerprintHash!,
          signatureBase64: prepared.reportEvidencePayload.signatureBase64!,
          signingKeyId: prepared.reportEvidencePayload.signingKeyId!,
          tsaStatus: prepared.reportEvidencePayload.tsaStatus ?? null,
          tsaMessageImprint: prepared.reportEvidencePayload.tsaMessageImprint ?? null,
          tsaInputDigestHex: prepared.reportEvidencePayload.tsaInputDigestHex ?? null,
          otsStatus: prepared.reportEvidencePayload.otsStatus ?? null,
          otsHash: prepared.reportEvidencePayload.otsHash ?? null,
          otsAnchoredAtUtc:
            prepared.reportEvidencePayload.otsAnchoredAtUtc ?? null,
          itemCount: prepared.contentSummary.itemCount,
          multipartItemHashesPresent:
            prepared.contentSummary.itemCount <= 1
              ? true
              : prepared.verificationEvidenceFiles.length > 1 &&
                prepared.verificationEvidenceFiles.every((file) => Boolean(file.sha256)),
          publicKeyPem: prepared.reportEvidencePayload.publicKeyPem as string,
          verifiedAtUtc: prepared.now,
          custodyEvents: custodyAtIssue,
        });

        const effectiveVerificationStatus =
          promotionDecision.effectiveVerificationStatus ??
          prepared.identitySnapshot.verificationStatus;
        const effectiveRecordedIntegrityVerifiedAtUtc =
          promotionDecision.effectiveRecordedIntegrityVerifiedAtUtc;
        const effectiveIdentitySnapshot = {
          ...prepared.identitySnapshot,
          verificationStatus: effectiveVerificationStatus,
        };
        const effectiveReportEvidencePayload = {
          ...prepared.reportEvidencePayload,
          status: EvidenceStatus.REPORTED,
          verificationStatus: effectiveVerificationStatus,
          recordedIntegrityVerifiedAtUtc: effectiveRecordedIntegrityVerifiedAtUtc,
          reportGeneratedAtUtc: prepared.now.toISOString(),
          latestReportVersion: prepared.version,
          reviewReadyAtUtc: prepared.now.toISOString(),
          reviewerSummaryVersion: effectiveIdentitySnapshot.reviewerSummaryVersion,
        };
        const effectiveReviewGuidance = buildReportReviewGuidance({
          itemCount: prepared.contentSummary.itemCount,
          previewableItemCount: prepared.contentSummary.previewableItemCount,
          overallIntegrity:
            effectiveVerificationStatus ===
              prismaPkg.VerificationStatus.RECORDED_INTEGRITY_VERIFIED ||
            Boolean(effectiveRecordedIntegrityVerifiedAtUtc),
        });

        // Resolved before the custody display context so the finalized
        // custody timeline renders intake-aware capture wording; reused for
        // the finalized report's acquisition table below.
        const finalizedReportAcquisition = await buildReportAcquisitionContext({
          teamId: evidence.teamId ?? null,
          evidenceId: prepared.evidenceId,
        });

        const finalizedCustodyDisplayContext = {
          itemCount: prepared.contentSummary.itemCount,
          structure: prepared.contentSummary.structure,
          isIntake: finalizedReportAcquisition?.isIntake === true,
          acquisitionMode: effectiveReportEvidencePayload.acquisitionMode ?? null,
        } as const;

        const finalizedCustodyForReport = custodyAtIssue.map((ev) => ({
          sequence: ev.sequence,
          atUtc: ev.atUtc.toISOString(),
          eventType: ev.eventType,
          payloadSummary: summarizePayloadForReport(
            ev.eventType,
            ev.payload,
            finalizedCustodyDisplayContext
          ),
          labelHints: custodyLabelHints(ev.payload),
          prevEventHash: ev.prevEventHash ?? null,
          eventHash: ev.eventHash ?? null,
          category: classifyCustodyEventType(ev.eventType),
        }));

        const finalizedTrustDecision = buildTrustDecision({
          evidence: effectiveReportEvidencePayload,
          custodyEvents: finalizedCustodyForReport,
          isIntake: finalizedReportAcquisition?.isIntake === true,
        });

        // Phase 31.11 — bounded media intelligence projection for the
        // finalized report. Same isolation invariants as the
        // provisional-report path above.
        const finalizedReportMediaIntelligence = await buildReportMediaIntelligence({
          teamId: evidence.teamId ?? null,
          evidenceId: prepared.evidenceId,
        });
        const finalizedReportTechnicalSummary = await buildReportTechnicalSummary({
          teamId: evidence.teamId ?? null,
          evidenceId: prepared.evidenceId,
        });
        // UC-4 — bounded DERIVED screen-review summary for the finalized report.
        const finalizedReportDerivedReview = await buildReportDerivedReview({
          teamId: evidence.teamId ?? null,
          evidenceId: prepared.evidenceId,
          ownerUserId: evidence.ownerUserId ?? null,
        });
        // ET-RPT-03 — the record's canonical legal hold (evidence, case and
        // workspace scope). A failed read is UNAVAILABLE, never "none".
        const finalizedRecordLegalHold = await evaluateEffectiveLegalHold(prisma, {
          evidenceId: prepared.evidenceId,
          teamId: evidence.teamId ?? null,
          collectAll: true,
        }).then(
          (hold) => ({
            state: hold.held ? ("ACTIVE" as const) : ("NONE" as const),
            scopes: hold.held
              ? hold.reasonCode === "UNRESOLVED_HOLD"
                ? ["UNRESOLVED"]
                : hold.matches.filter((m) => m.unresolved !== true).map((m) => m.scope)
              : [],
          }),
          (err: unknown) => {
            logger.warn(
              { evidenceId: prepared.evidenceId, err: err instanceof Error ? err.message : String(err) },
              "report.legal_hold_unavailable",
            );
            return { state: "UNAVAILABLE" as const, scopes: [] };
          },
        );

        // Phase O1.5C — bounded report.render.pdf span.
        await withProovraSpan(PROOVRA_SPAN_NAMES.REPORT_RENDER_PDF, { "proovra.operation": "report_render_pdf", "proovra.evidence_id": prepared.evidenceId }, () => undefined);
        const finalizedReportPdf = await buildReportPdfV2({
          evidence: effectiveReportEvidencePayload,
          custodyEvents: finalizedCustodyForReport,
          version: prepared.version,
          generatedAtUtc: prepared.now.toISOString(),
          buildInfo: env.WORKER_BUILD_INFO ?? null,
          verifyUrl: prepared.verifyUrl,
          downloadUrl: prepared.downloadUrl,
          externalMode: false,
          mediaIntelligence: finalizedReportMediaIntelligence,
          technicalSummary: finalizedReportTechnicalSummary,
          acquisition: finalizedReportAcquisition,
          derivedReview: finalizedReportDerivedReview,
          recordLegalHold: finalizedRecordLegalHold,
        });

        // The allowance is checked with the EXACT size, before any byte is
        // written to storage.
        await assertWorkspaceAllowsReportArtifact({
          ownerUserId: evidence.ownerUserId,
          teamId: evidence.teamId ?? null,
          incomingBytes: BigInt(finalizedReportPdf.length),
          // Credit-funded records earn their report on a FREE account.
          evidenceId: evidence.id,
        });

        // Phase O1.5C — bounded report.upload span. NEVER PDF bytes
        // or signed URL in attributes.
        await withProovraSpan(PROOVRA_SPAN_NAMES.REPORT_UPLOAD, { "proovra.operation": "report_upload", "proovra.evidence_id": prepared.evidenceId, "proovra.size_bytes": finalizedReportPdf.length }, () => undefined);
        // Phase 6 — Build report provenance envelope for downstream
        // traceability. Identity-only; never drives policy.
        let reportProvenanceMetadata: Record<string, string> = {};
        try {
          reportProvenanceMetadata = {
            template_slug: lockedEvidence.templateSlug ?? "",
            template_version:
              lockedEvidence.templateVersion != null
                ? String(lockedEvidence.templateVersion)
                : "",
            template_db_id: lockedEvidence.templateDbId ?? "",
          };
        } catch {
          /* identity propagation failure must never break report flow */
        }

        // The hash of the exact bytes published below; package-only recovery
        // verifies the stored object against it before embedding it.
        const finalizedReportDigest = createHash("sha256").update(finalizedReportPdf).digest();
        const finalizedReportSha256 = finalizedReportDigest.toString("hex");

        // DURABLE PROGRESS — rendered; publishing + reading back the stored PDF.
        await recordRequestProgress(command, "VERIFYING_REPORT");
        const publishedReport = await publishImmutableArtifact({
          bucket: env.S3_BUCKET,
          key: buildPublicationKey({
            family: "reports",
            evidenceId: prepared.evidenceId,
            version: prepared.version,
            requestId: command.requestId,
            extension: "pdf",
          }),
          body: { kind: "buffer", buffer: finalizedReportPdf },
          sha256Base64: finalizedReportDigest.toString("base64"),
          contentType: "application/pdf",
          metadata: {
            evidence_id: prepared.evidenceId,
            report_version: String(prepared.version),
            artifact_type: "report_pdf",
            ...reportProvenanceMetadata,
          },
          tags: {
            artifact: "report",
            evidenceId: prepared.evidenceId,
            immutable: "true",
          },
        });
        prepared.reportKey = publishedReport.key;
        // Phase O1.5C — bounded report.publish span emitted post-upload.
        await withProovraSpan(PROOVRA_SPAN_NAMES.REPORT_PUBLISH, { "proovra.operation": "report_publish", "proovra.evidence_id": prepared.evidenceId }, () => undefined);

        const issueKind = forceRegenerate && reservation.previousReportVersion != null
          ? "UPDATED_REPORT"
          : "FIRST_ISSUE";

        // ---- C. COMMIT -----------------------------------------------------
        return await prisma.$transaction(
          async (tx) => {
            await tx.$executeRaw`
              SELECT pg_advisory_xact_lock(hashtext(${prepared.evidenceId}))
            `;
            const stillReserved = await tx.reportGenerationRequest.findUnique({
              where: { id: command.requestId },
              select: { reportVersion: true, stage: true },
            });
            const taken = await tx.report.findUnique({
              where: {
                evidenceId_version: {
                  evidenceId: prepared.evidenceId,
                  version: prepared.version,
                },
              },
              select: { id: true },
            });
            if (
              taken ||
              stillReserved?.stage !== "REPORT_RESERVED" ||
              stillReserved.reportVersion !== prepared.version
            ) {
              // The object published above is now an unreferenced, immutable
              // orphan. It is never overwritten and never pointed at.
              throw createWorkerError("REPORT_RESERVATION_LOST_RETRY", true);
            }

            // ET-SM-02 — the record may have moved while the PDF rendered and
            // published outside any lock (seconds to minutes): an integrity
            // rejection (FAILED_HASH_MISMATCH), trash, or destruction. Status
            // was validated only at reservation, and the commit then wrote
            // REPORTED unconditionally over whatever the record had become.
            // Re-read under the lock; refuse (terminal) unless it is still
            // reportable. The published object stays an unreferenced orphan.
            const live = await tx.evidence.findUnique({
              where: { id: prepared.evidenceId },
              select: { status: true, deletedAt: true, lifecycleState: true },
            });
            if (!live || !isReportableAtCommit(live)) {
              throw createWorkerError("REPORT_EVIDENCE_STATE_CHANGED", false);
            }

            // Phase C #5 — distinct event type for the worker-time identity
            // re-snapshot (REPORT_IDENTITY_CONTEXT_RECORDED, not the intake-time
            // IDENTITY_SNAPSHOT_RECORDED).
            await appendCustodyEventTx(tx, {
              evidenceId: prepared.evidenceId,
              eventType:
                prismaPkg.CustodyEventType.REPORT_IDENTITY_CONTEXT_RECORDED,
              atUtc: prepared.now,
              payload: {
                phase: "report_identity_context",
                submittedByEmail: prepared.identitySnapshot.submittedByEmail,
                submittedByAuthProvider:
                  prepared.identitySnapshot.submittedByAuthProvider,
                identityLevelSnapshot:
                  prepared.identitySnapshot.identityLevelSnapshot,
                workspaceNameSnapshot:
                  prepared.identitySnapshot.workspaceNameSnapshot,
                organizationNameSnapshot:
                  prepared.identitySnapshot.organizationNameSnapshot,
                organizationVerifiedSnapshot:
                  prepared.identitySnapshot.organizationVerifiedSnapshot,
              } as Prisma.InputJsonValue,
            });

            await appendCustodyEventTx(tx, {
              evidenceId: prepared.evidenceId,
              eventType: prismaPkg.CustodyEventType.REPORT_GENERATED,
              atUtc: prepared.now,
              payload: {
                phase: "report_generated",
                reportVersion: prepared.version,
                generatedAtUtc: prepared.now.toISOString(),
                issueKind,
                ...(issueKind === "UPDATED_REPORT"
                  ? { previousReportVersion: reservation.previousReportVersion }
                  : {}),
                pdfSha256: finalizedReportSha256,
                custodyThroughSequence,
                verificationStatusSnapshot: effectiveVerificationStatus,
                captureMethodSnapshot: effectiveIdentitySnapshot.captureMethod,
                acquisitionModeSnapshot:
                  effectiveReportEvidencePayload.acquisitionMode ?? null,
                identityLevelSnapshot:
                  effectiveIdentitySnapshot.identityLevelSnapshot,
                ...(regenerateReason ? { refreshReason: regenerateReason } : {}),
                ...(promotionDecision.shouldPromote
                  ? {
                      recordedIntegrityVerifiedAtUtc:
                        effectiveRecordedIntegrityVerifiedAtUtc,
                      integrityPromotion: "recorded_integrity_verified",
                    }
                  : {}),
              } as Prisma.InputJsonValue,
            });

            const committed = await tx.evidence.updateMany({
              where: { id: prepared.evidenceId, ...REPORTABLE_AT_COMMIT_WHERE },
              data: {
                status: EvidenceStatus.REPORTED,
                verificationStatus: effectiveVerificationStatus,
                recordedIntegrityVerifiedAtUtc:
                  effectiveRecordedIntegrityVerifiedAtUtc != null
                    ? new Date(effectiveRecordedIntegrityVerifiedAtUtc)
                    : null,
                captureMethod: effectiveIdentitySnapshot.captureMethod,
                identityLevelSnapshot:
                  effectiveIdentitySnapshot.identityLevelSnapshot,
                submittedByEmail: effectiveIdentitySnapshot.submittedByEmail,
                submittedByAuthProvider:
                  effectiveIdentitySnapshot.submittedByAuthProvider,
                submittedByUserId: effectiveIdentitySnapshot.submittedByUserId,
                createdByUserId: effectiveIdentitySnapshot.createdByUserId,
                uploadedByUserId: effectiveIdentitySnapshot.uploadedByUserId,
                workspaceNameSnapshot:
                  effectiveIdentitySnapshot.workspaceNameSnapshot,
                organizationNameSnapshot:
                  effectiveIdentitySnapshot.organizationNameSnapshot,
                organizationVerifiedSnapshot:
                  effectiveIdentitySnapshot.organizationVerifiedSnapshot,
                latestReportVersion: prepared.version,
                reportGeneratedAtUtc: prepared.now,
                lastVerifiedAtUtc: prepared.now,
                lastVerifiedSource: prismaPkg.VerificationSource.REPORT_GENERATED,
                reviewReadyAtUtc: prepared.now,
                reviewerSummaryVersion:
                  effectiveIdentitySnapshot.reviewerSummaryVersion,
              },
            });
            if (committed.count !== 1) {
              throw createWorkerError("REPORT_EVIDENCE_STATE_CHANGED", false);
            }

            await appendCustodyEventTx(tx, {
              evidenceId: prepared.evidenceId,
              eventType: prismaPkg.CustodyEventType.REVIEW_READY,
              atUtc: prepared.now,
              payload: {
                reviewerSummaryVersion:
                  effectiveIdentitySnapshot.reviewerSummaryVersion,
              } as Prisma.InputJsonValue,
            });

            // ET-PKG-07 — the link printed in this report (and its QR code)
            // exists from the moment the report does, and not before. Only
            // the hash is stored. It opens nothing until the owner publishes
            // the record, and the owner can revoke or rotate it on its own.
            // UC-OUT-001 — minted only when the report PRINTS it, i.e. the
            // record was published at issuance.
            if (prepared.publicVerifyPublishedAtIssuance) {
              await mintVerificationShareTokenTx(tx, {
                evidenceId: prepared.evidenceId,
                teamId: prepared.packageMetadataContext.teamId ?? null,
                purpose: "REPORT",
                reportVersion: prepared.version,
                audience: `Report version ${prepared.version}`,
                token: prepared.reportShareToken,
                now: prepared.now,
              });
            }

            await tx.report.create({
              data: {
                evidenceId: prepared.evidenceId,
                version: prepared.version,
                storageBucket: env.S3_BUCKET,
                storageKey: publishedReport.key,
                storageRegion: process.env.S3_REGION?.trim() || null,
                storageObjectLockMode: publishedReport.objectLockMode,
                storageObjectLockRetainUntilUtc:
                  publishedReport.objectLockRetainUntilUtc,
                storageObjectLockLegalHoldStatus:
                  publishedReport.objectLockLegalHoldStatus,
                generatedAtUtc: prepared.now,
                sizeBytes: BigInt(finalizedReportPdf.length),
                pdfSha256: finalizedReportSha256,
                s3VersionId: publishedReport.versionId,
                issueKind,
                issueReason:
                  issueKind === "UPDATED_REPORT"
                    ? (regenerateReason?.slice(0, 200) ?? null)
                    : null,
                previousReportVersion:
                  issueKind === "UPDATED_REPORT"
                    ? reservation.previousReportVersion
                    : null,
                custodyThroughSequence,

                verificationStatusSnapshot: effectiveIdentitySnapshot.verificationStatus,
                identityLevelSnapshot:
                  effectiveIdentitySnapshot.identityLevelSnapshot,
                submittedByEmailSnapshot:
                  effectiveIdentitySnapshot.submittedByEmail,
                submittedByAuthProviderSnapshot:
                  effectiveIdentitySnapshot.submittedByAuthProvider,
                captureMethodSnapshot: effectiveIdentitySnapshot.captureMethod,
                acquisitionModeSnapshot:
                  effectiveReportEvidencePayload.acquisitionMode ?? null,
                reviewerSummaryVersion:
                  effectiveIdentitySnapshot.reviewerSummaryVersion,
                /*
                 * This column names a package that EXISTS, or it names nothing.
                 * The package transaction sets it, conditionally on its own
                 * success. Here it starts null.
                 */
                verificationPackageVersion: null,

                displayTitleSnapshot: prepared.display.displayTitle,
                displayDescriptionSnapshot: prepared.display.displayDescription,
                contentStructureSnapshot: prepared.contentSummary.structure,
                itemCountSnapshot: prepared.contentSummary.itemCount,
                previewableItemCountSnapshot:
                  prepared.contentSummary.previewableItemCount,
                downloadableItemCountSnapshot:
                  prepared.contentSummary.downloadableItemCount,
                primaryContentKindSnapshot: prepared.contentSummary.primaryKind,
                primaryContentLabelSnapshot: prepared.primaryContentLabel,
                contentCompositionSummarySnapshot:
                  prepared.contentCompositionSummary,
                contentAccessPolicyModeSnapshot:
                  prepared.contentAccessPolicy.mode ?? null,
                defaultPreviewItemIdSnapshot: prepared.defaultPreviewItemId,

                workspaceNameSnapshot:
                  effectiveIdentitySnapshot.workspaceNameSnapshot,
                organizationNameSnapshot:
                  effectiveIdentitySnapshot.organizationNameSnapshot,
                organizationVerifiedSnapshot:
                  effectiveIdentitySnapshot.organizationVerifiedSnapshot,
                recordedIntegrityVerifiedAtUtcSnapshot:
                  effectiveReportEvidencePayload.recordedIntegrityVerifiedAtUtc
                    ? new Date(
                        effectiveReportEvidencePayload.recordedIntegrityVerifiedAtUtc
                      )
                    : null,
                lastVerifiedAtUtcSnapshot:
                  effectiveReportEvidencePayload.lastVerifiedAtUtc
                    ? new Date(effectiveReportEvidencePayload.lastVerifiedAtUtc)
                    : null,
                lastVerifiedSourceSnapshot:
                  (effectiveReportEvidencePayload.lastVerifiedSource as
                    | prismaPkg.VerificationSource
                    | null
                    | undefined) ?? null,
                storageImmutableSnapshot:
                  effectiveReportEvidencePayload.storageImmutable ?? null,

                displaySnapshot:
                  prepared.display as unknown as Prisma.InputJsonValue,
                contentSummarySnapshot:
                  prepared.contentSummary as unknown as Prisma.InputJsonValue,
                contentItemsSnapshot:
                  prepared.contentItems as unknown as Prisma.InputJsonValue,
                primaryContentItemSnapshot:
                  prepared.primaryContentItem as unknown as Prisma.InputJsonValue,
                previewPolicySnapshot:
                  prepared.previewPolicy as unknown as Prisma.InputJsonValue,
                reviewGuidanceSnapshot:
                  effectiveReviewGuidance as unknown as Prisma.InputJsonValue,
                limitationsSnapshot:
                  prepared.limitations as unknown as Prisma.InputJsonValue,
                anchorSnapshot:
                  prepared.anchorSummary as unknown as Prisma.InputJsonValue,
                trustDecisionSnapshot:
                  finalizedTrustDecision as unknown as Prisma.InputJsonValue,
                contentAccessPolicySnapshot:
                  prepared.contentAccessPolicy as unknown as Prisma.InputJsonValue,
                embeddedPreviewsSnapshot:
                  prepared.contentItems
                    .filter(
                      (item) => item.previewDataUrl || item.previewTextExcerpt
                    )
                    .map((item) => ({
                      id: item.id,
                      previewDataUrl: item.previewDataUrl ?? null,
                      previewTextExcerpt: item.previewTextExcerpt ?? null,
                      previewCaption: item.previewCaption ?? null,
                    })) as unknown as Prisma.InputJsonValue,
                // Phase A2 — explicit PDF artifact signature columns.
                pdfSignatureStatus: prepared.pdfSigningOutcome.status,
                pdfSignedAtUtc:
                  prepared.pdfSigningOutcome.status === "SIGNED"
                    ? prepared.pdfSigningOutcome.signedAtUtc
                    : null,
                pdfSignerKeyId:
                  prepared.pdfSigningOutcome.status === "SIGNED"
                    ? prepared.pdfSigningOutcome.signerKeyId
                    : null,
                pdfSigningWarning:
                  prepared.pdfSigningOutcome.status === "SIGNED"
                    ? null
                    : prepared.pdfSigningOutcome.warning,
              },
            });

            // Phase A2 — a distinct custody event for the PDF signing decision.
            const pdfCustodyEventType =
              prepared.pdfSigningOutcome.status === "SIGNED"
                ? prismaPkg.CustodyEventType.REPORT_PDF_SIGNED
                : prismaPkg.CustodyEventType.REPORT_PDF_UNSIGNED_OPT_OUT;
            await appendCustodyEventTx(tx, {
              evidenceId: prepared.evidenceId,
              eventType: pdfCustodyEventType,
              atUtc: prepared.now,
              payload: {
                reportVersion: prepared.version,
                pdfSignatureStatus: prepared.pdfSigningOutcome.status,
                pdfSignerKeyId:
                  prepared.pdfSigningOutcome.status === "SIGNED"
                    ? prepared.pdfSigningOutcome.signerKeyId
                    : null,
                pdfSignedAtUtc:
                  prepared.pdfSigningOutcome.status === "SIGNED"
                    ? prepared.pdfSigningOutcome.signedAtUtc.toISOString()
                    : null,
              },
            });

            /*
             * DURABLE PROGRESS, IN THE SAME TRANSACTION AS THE REPORT ROW. A
             * retry of this request after this point resumes at the package for
             * exactly this version; if the transaction rolls back, neither
             * exists.
             */
            // ET-SEC-30 — fenced: a run whose claim was taken over rolls back.
            const fenced = await tx.reportGenerationRequest.updateMany({
              where: claimFenceWhere(command),
              data: { reportVersion: prepared.version, stage: "REPORT_COMMITTED" },
            });
            if (fenced.count !== 1) throw new ReportClaimLost(command.requestId);

            // The chain the package built by THIS run carries: everything up to
            // and including the issuance events just appended.
            const finalizedCustodyEvents = await tx.custodyEvent.findMany({
              where: { evidenceId: prepared.evidenceId },
              orderBy: { sequence: "asc" },
              select: {
                sequence: true,
                atUtc: true,
                eventType: true,
                payload: true,
                prevEventHash: true,
                eventHash: true,
              },
            });

            return {
              skipped: false as const,
              reportCreated: true as const,
              version: prepared.version,
              reportKey: publishedReport.key,
              reportVersion: prepared.version,
              finalizedReportSha256,
              finalizedReportEvidencePayload: effectiveReportEvidencePayload,
              effectiveVerificationStatus,
              effectiveRecordedIntegrityVerifiedAtUtc,
              finalizedReportPdf,
              finalizedTrustDecision,
              reportIssuedAtUtc: prepared.now,
              custodyThroughSequence:
                finalizedCustodyEvents.at(-1)?.sequence ?? custodyThroughSequence,
              finalizedCustodyEvents: finalizedCustodyEvents.map((ev) => ({
                sequence: ev.sequence,
                atUtc: ev.atUtc.toISOString(),
                eventType: ev.eventType,
                payload: ev.payload,
                prevEventHash: ev.prevEventHash ?? null,
                eventHash: ev.eventHash ?? null,
              })),
            };
          },
          { maxWait: 10_000, timeout: 30_000 },
        );
      })();

    // DURABLE PROGRESS — the report is committed (or already existed, for a
    // package-only run); the verification package is built next.
    if (!finalized.skipped) await recordRequestProgress(command, "BUILDING_PACKAGE");
    let finalizedVerificationStaged: StagedPackage | null = null;
    let finalizedVerificationSeal: PackageSealResult | null = null;
    let finalizedVerificationArtifactPresence: VerificationPackageArtifactPresence | null = null;

    // Phase 32.6.6 — personal BASIC + team GOVERNED modes (was: skip
    // personal entirely).
    //
    // The previous Phase 32.5 behavior was to SKIP verification
    // package generation for any evidence without a teamId. That was
    // overly conservative: personal evidence still needs a
    // verification package — the user can sign, report, and verify
    // their own record. Skipping left those users with a 410
    // "unavailable for personal-workspace" response on the
    // download endpoint, which is incorrect product semantics.
    //
    // The new contract:
    //   * `evidence.teamId == null` → createVerificationPackage builds
    //     a PERSONAL BASIC package (no governance gate, no workspace
    //     policy section; `package-mode.json` declares `personal_basic`).
    //   * `evidence.teamId != null` → createVerificationPackage builds
    //     a TEAM GOVERNED package (existing behavior unchanged; the
    //     workspace governance gate, legal hold, and policy still
    //     enforce — no governance weakening).
    //
    // The personal-workspace skip counter
    // (`package_generation_skipped_personal_workspace_total`) is
    // intentionally not bumped any longer; personal evidence now
    // counts as a normal generation attempt. The counter remains
    // registered in the catalog for backward-compat with historic
    // dashboards.

    if (
      !finalized.skipped &&
      prepared.verificationPackageIncluded &&
      finalized.finalizedCustodyEvents.length > 0
    ) {
      // Phase 32.6 — bump the started counter at the canonical
      // entry point so SRE dashboards count attempts (vs. successes
      // tracked separately via package_generation_completed_total).
      try {
        const { bump } = await import("@proovra/shared-runtime/ops");
        bump("package_generation_started_total");
      } catch {
        /* metrics are best-effort */
      }
      try {
                const finalizedLastEventHash =
          finalized.finalizedCustodyEvents.at(-1)?.eventHash ?? null;

const finalizedAnchorPayload = buildFinalizedAnchorPayload({
  anchorMode: normalizeAnchorMode(process.env.ANCHOR_MODE),
  evidenceId: prepared.evidenceId,
  reportVersion: prepared.version,
  fileSha256: evidence.fileSha256!,
  fingerprintHash: evidence.fingerprintHash!,
  lastEventHash: finalizedLastEventHash,
  generatedAtUtc: prepared.now.toISOString(),
  anchorSummary: prepared.anchorSummary,
  otsBitcoinTxid: prepared.reportEvidencePayload.otsBitcoinTxid ?? null,
  otsAnchoredAtUtc: prepared.reportEvidencePayload.otsAnchoredAtUtc ?? null,
  otsStatus: prepared.reportEvidencePayload.otsStatus ?? null,
  otsAnchorCheck: prepared.reportEvidencePayload.otsAnchorCheck ?? null,
});
        // Phase 31.14 — bounded intelligence projection for the
        // verification package. Returns null when no surfaceable
        // data exists OR on any failure — the package builds
        // unchanged in either case (independent of downstream tooling).
        const verificationPackageIntelligence =
          await buildVerificationPackageIntelligence({
            teamId: evidence.teamId ?? null,
            evidenceId: prepared.evidenceId,
            ownerUserId: evidence.ownerUserId ?? null,
          });

        // Phase 3 — canonical evidence materials sealed at
        // verification-package generation time. The bundle is the
        // single self-describing snapshot of every lifecycle
        // material; it lands inside the ZIP as
        // `canonical-record.json`. Every section's
        // `snapshotSemantics` is `package-snapshot-only` because
        // outputType = VERIFICATION_PACKAGE_SNAPSHOT.
        // Acquisition context for the PACKAGE metadata scope (the report-scope
        // `finalizedReportAcquisition` is out of scope here). Drives role-safe
        // submitter/capture-method labeling in case-metadata.json +
        // original-linkage.json + canonical-record.json. Same bounded
        // projection used for the report. Resolved FIRST because the canonical
        // materials + provenance chain below both need the reliable intake
        // signal (`completeEvidence` overwrites capture_method to the structure
        // enum MULTIPART_PACKAGE, so it cannot be used to detect intake).
        const packageAcquisition = await buildReportAcquisitionContext({
          teamId: evidence.teamId ?? null,
          evidenceId: prepared.evidenceId,
        });

        const packageCanonicalMaterials = buildReportCanonicalMaterials({
          evidence: finalized.finalizedReportEvidencePayload,
          custodyEvents: finalized.finalizedCustodyEvents.map((e) => ({
            sequence: e.sequence,
            atUtc: e.atUtc,
            eventType: e.eventType,
            payloadSummary: "",
            prevEventHash: e.prevEventHash ?? null,
            eventHash: e.eventHash ?? null,
          })),
          trustDecision: finalized.finalizedTrustDecision,
          isIntake: packageAcquisition?.isIntake === true,
          snapshotGeneratedAtUtc:
            finalized.finalizedReportEvidencePayload.reportGeneratedAtUtc ??
            prepared.now,
          outputType: "VERIFICATION_PACKAGE_SNAPSHOT",
          parts: prepared.verificationEvidenceFiles.map((f, i) => ({
            partIndex: f.partIndex ?? i,
            sha256: f.sha256 ?? null,
            sizeBytes: f.sizeBytes ?? null,
            mimeType: f.mimeType ?? null,
          })),
          mediaIntelligence: verificationPackageIntelligence ?? null,
        });

        // Phase 1B Closure — bounded ProvenanceChain for `provenance/chain.json`.
        // Loaded AFTER the acquisition context so intake evidence resolves to
        // SECURE_INTAKE_LINK: `completeEvidence` overwrites the persisted
        // capture_method to the structure enum MULTIPART_PACKAGE, so it cannot
        // be used to detect intake. The reliable, persistent intake signal is
        // the acquisition context (intake-link linkage / uploadSource). Optional
        // — a null chain never blocks the bundle.
        const verificationPackageProvenanceChain =
          await loadProvenanceChainForPackage(prepared.evidenceId);

        const finalizedVerificationPackage = await createVerificationPackage({
          teamId: evidence.teamId ?? undefined,
          // Phase 2 canonical workspace scope inputs. `isPersonalTeam`
          // is the only correct way to distinguish personal vs team
          // workspaces (teamId is always non-null for normal flows).
          // Sourced from `prepared.identitySnapshot` because the team
          // is loaded inside the prepare phase, not here.
          isPersonalTeam: prepared.identitySnapshot.workspaceIsPersonal,
          workspaceLabelAtPackageTime:
            prepared.identitySnapshot.workspaceLabelAtPackageTime ??
            prepared.identitySnapshot.workspaceNameSnapshot ??
            null,
          canonicalMaterials: packageCanonicalMaterials,
          intelligence: verificationPackageIntelligence,
          provenanceChain: verificationPackageProvenanceChain,
          // UC-OUT-001 — README step 2c / 6 say whether Public Verify can be used.
          publicVerification: { publishedAtIssuance: prepared.publicVerifyPublishedAtIssuance },
          evidenceFiles: prepared.verificationEvidenceFiles,
          reportPdf: finalized.finalizedReportPdf,
          reportFileName: `proovra-verification-report-v${prepared.version}.pdf`,
          // FORMAT 5 — the seal binds the checksum index and, through it, the
          // exact report bytes above. Chronology is stated, never implied: a
          // package assembled after its report says so.
          seal: {
            reportSha256: finalized.finalizedReportSha256,
            reportIssuedAtUtc: finalized.reportIssuedAtUtc.toISOString(),
            packageAssembledAtUtc: new Date().toISOString(),
            assembly: finalized.reportCreated ? "WITH_REPORT_ISSUE" : "AFTER_REPORT_ISSUE",
            custodyThroughSequence: finalized.custodyThroughSequence,
            proofMaterialsObservedAtUtc: prepared.now.toISOString(),
            fileSha256: evidence.fileSha256 ?? null,
            fingerprintHash: evidence.fingerprintHash ?? null,
          },
          fingerprint: prepared.fingerprintCanonicalJson,
signature: evidence.signatureBase64!,
          // ET-TSA-04: only a VALIDATED token ships as timestamp.tsr; a failed
          // or unvalidated reply is described in the README, never included.
          timestampToken:
            presentedTsaStatus(evidence) === "STAMPED" ? evidence.tsaTokenBase64 ?? null : null,
publicKey: finalized.finalizedReportEvidencePayload.publicKeyPem as string,
          // custody.json / forensic-custody.json (ET-PKG-01): each payload
          // exactly as hashed, so the chain recomputes from the package; the
          // role-safe presentation copy rides beside it as presentationPayload.
          custody: finalized.finalizedCustodyEvents.map((e) =>
            packageCustodyEntry(e, {
              acquisitionMode:
                finalized.finalizedReportEvidencePayload.acquisitionMode ?? null,
              isIntake: packageAcquisition?.isIntake === true,
            }),
          ),
          evidenceId: prepared.evidenceId,
          reportVersion: prepared.version,
          trustDecision: finalized.finalizedTrustDecision,
signingKeyId: evidence.signingKeyId ?? undefined,
signingKeyVersion: evidence.signingKeyVersion ?? undefined,
          anchor: finalizedAnchorPayload,
          anchorMode: normalizeAnchorMode(process.env.ANCHOR_MODE),
          anchorProvider: process.env.ANCHOR_PROVIDER?.trim() || null,
          certifications: prepared.certifications,
          // Hotfix — pass OTS state + proof through so the package
          // honestly includes `opentimestamps-proof.ots` whenever the
          // record actually has proof bytes. Null fields stay null;
          // never fabricated.
          ots: {
            status: finalized.finalizedReportEvidencePayload.otsStatus ?? null,
            proofBase64:
              finalized.finalizedReportEvidencePayload.otsProofBase64 ?? null,
            hash: finalized.finalizedReportEvidencePayload.otsHash ?? null,
            calendar:
              finalized.finalizedReportEvidencePayload.otsCalendar ?? null,
            bitcoinTxid:
              finalized.finalizedReportEvidencePayload.otsBitcoinTxid ?? null,
            anchoredAtUtc:
              finalized.finalizedReportEvidencePayload.otsAnchoredAtUtc ?? null,
            upgradedAtUtc:
              finalized.finalizedReportEvidencePayload.otsUpgradedAtUtc ?? null,
            anchorCheck:
              finalized.finalizedReportEvidencePayload.otsAnchorCheck ?? null,
            failureReason:
              finalized.finalizedReportEvidencePayload.otsFailureReason ?? null,
          },
          metadata: {
            title: prepared.display.displayTitle,
            // A multipart package aggregates multiple items, so the single
            // primary-record enum (which may be DOCUMENT) is misleading in
            // legal/forensic package material. Derive a package-level type
            // from the SAME reviewer categories used by reviewerEvidenceType
            // so the two can never contradict: MIXED_MEDIA_PACKAGE only when
            // genuinely mixed (>1 media category), a single-category package
            // label otherwise (e.g. IMAGE_PACKAGE), never DOCUMENT for a
            // package. Single-item evidence keeps the raw record enum.
            rawEvidenceType:
              prepared.contentSummary.itemCount > 1
                ? (() => {
                    const cats = getReviewerEvidenceCategories({
                      itemCount: prepared.contentSummary.itemCount,
                      structure: prepared.contentSummary.structure,
                      imageCount: prepared.contentSummary.imageCount,
                      videoCount: prepared.contentSummary.videoCount,
                      audioCount: prepared.contentSummary.audioCount,
                      pdfCount: prepared.contentSummary.pdfCount,
                      textCount: prepared.contentSummary.textCount,
                      otherCount: prepared.contentSummary.otherCount,
                      evidenceType: String(evidence.type),
                      mimeType: evidence.mimeType ?? null,
                    }).filter((c) => c !== "Other");
                    return cats.length > 1
                      ? "MIXED_MEDIA_PACKAGE"
                      : cats.length === 1
                        ? `${cats[0].toUpperCase().replace(/\s+/g, "_")}_PACKAGE`
                        : "MULTIPART_PACKAGE";
                  })()
                : String(evidence.type),
            rawEvidenceTypeSource:
              prepared.contentSummary.itemCount > 1
                ? "multipart_package_derivation"
                : "primary_record_enum",
            reviewerEvidenceType: getReviewerEvidenceTypeLabel({
              itemCount: prepared.contentSummary.itemCount,
              structure: prepared.contentSummary.structure,
              imageCount: prepared.contentSummary.imageCount,
              videoCount: prepared.contentSummary.videoCount,
              audioCount: prepared.contentSummary.audioCount,
              pdfCount: prepared.contentSummary.pdfCount,
              textCount: prepared.contentSummary.textCount,
              otherCount: prepared.contentSummary.otherCount,
              evidenceType: String(evidence.type),
              mimeType: evidence.mimeType ?? null,
            }),
            evidenceStructure:
              prepared.contentSummary.itemCount > 1
                ? "Multipart evidence package"
                : "Single evidence item",
            itemCount: prepared.contentSummary.itemCount,
            contentCategories: getReviewerEvidenceCategories({
              itemCount: prepared.contentSummary.itemCount,
              structure: prepared.contentSummary.structure,
              imageCount: prepared.contentSummary.imageCount,
              videoCount: prepared.contentSummary.videoCount,
              audioCount: prepared.contentSummary.audioCount,
              pdfCount: prepared.contentSummary.pdfCount,
              textCount: prepared.contentSummary.textCount,
              otherCount: prepared.contentSummary.otherCount,
              evidenceType: String(evidence.type),
              mimeType: evidence.mimeType ?? null,
            }),
            imageCount: prepared.contentSummary.imageCount,
            videoCount: prepared.contentSummary.videoCount,
            audioCount: prepared.contentSummary.audioCount,
            pdfCount: prepared.contentSummary.pdfCount,
            textCount: prepared.contentSummary.textCount,
            otherCount: prepared.contentSummary.otherCount,
            mimeType: evidence.mimeType ?? null,
evidenceStatus: String(evidence.status),
createdAtUtc: evidence.createdAt.toISOString(),
verificationStatus: String(
  finalized.finalizedReportEvidencePayload.verificationStatus,
),
captureMethod: String(
  finalized.finalizedReportEvidencePayload.captureMethod,
),
// Drives role-safe submitter/capture-method labeling in case-metadata.json +
// original-linkage.json (the identity-snapshot email is the LINK CREATOR /
// workspace owner for intake, never the remote contributor).
isIntake: packageAcquisition?.isIntake === true,
acquisitionMode: finalized.finalizedReportEvidencePayload.acquisitionMode ?? null,
identityLevelSnapshot: String(
  finalized.finalizedReportEvidencePayload.identityLevelSnapshot,
),
submittedByEmail: finalized.finalizedReportEvidencePayload.submittedByEmail,
submittedByAuthProvider:
  finalized.finalizedReportEvidencePayload.submittedByAuthProvider
    ? String(finalized.finalizedReportEvidencePayload.submittedByAuthProvider)
    : null,
            capturedAtUtc:
              finalized.finalizedReportEvidencePayload.capturedAtUtc ?? null,
            deviceTimeIso:
              finalized.finalizedReportEvidencePayload.deviceTimeIso ?? null,
            uploadedAtUtc:
              finalized.finalizedReportEvidencePayload.uploadedAtUtc ?? null,
            signedAtUtc:
              finalized.finalizedReportEvidencePayload.signedAtUtc ?? null,
            reportGeneratedAtUtc:
              finalized.finalizedReportEvidencePayload.reportGeneratedAtUtc ??
              prepared.now.toISOString(),
            captureLocation:
              finalized.finalizedReportEvidencePayload.gps &&
              (finalized.finalizedReportEvidencePayload.gps.lat !== null ||
                finalized.finalizedReportEvidencePayload.gps.lng !== null ||
                finalized.finalizedReportEvidencePayload.gps.accuracyMeters !==
                  null)
                ? {
                    lat:
                      finalized.finalizedReportEvidencePayload.gps.lat !== null
                        ? Number(finalized.finalizedReportEvidencePayload.gps.lat)
                        : null,
                    lng:
                      finalized.finalizedReportEvidencePayload.gps.lng !== null
                        ? Number(finalized.finalizedReportEvidencePayload.gps.lng)
                        : null,
                    accuracyMeters:
                      finalized.finalizedReportEvidencePayload.gps
                        .accuracyMeters !== null
                        ? Number(
                            finalized.finalizedReportEvidencePayload.gps
                              .accuracyMeters
                          )
                        : null,
                    locationSource:
                      finalized.finalizedReportEvidencePayload.gps
                        .locationSource ?? null,
                  }
                : null,
            storageRegion: prepared.evidenceStorage.storageRegion,
            storageObjectLockMode:
              prepared.evidenceStorage.storageObjectLockMode,
            storageObjectLockRetainUntilUtc:
              prepared.evidenceStorage.storageObjectLockRetainUntilUtc,
            storageObjectLockLegalHoldStatus:
              prepared.evidenceStorage.storageObjectLockLegalHoldStatus,
            storageImmutable: prepared.evidenceStorage.storageImmutable,
            tsaStatus:
              finalized.finalizedReportEvidencePayload.tsaStatus ?? null,
            otsStatus:
              finalized.finalizedReportEvidencePayload.otsStatus ?? null,
caseId: prepared.packageMetadataContext.caseId,
caseName: prepared.packageMetadataContext.caseName,
customerId: prepared.packageMetadataContext.customerId,
retentionPolicy: prepared.packageMetadataContext.retentionPolicy,
workspaceId: prepared.packageMetadataContext.workspaceId,
organizationId: prepared.packageMetadataContext.organizationId,
teamId: prepared.packageMetadataContext.teamId,
ownerUserId: prepared.packageMetadataContext.ownerUserId,
            verificationPackageVersion: prepared.version,
            recordedIntegrityVerifiedAtUtc:
              finalized.finalizedReportEvidencePayload
                .recordedIntegrityVerifiedAtUtc ?? null,
          },
        });
        finalizedVerificationStaged = finalizedVerificationPackage.staged;
        finalizedVerificationSeal = finalizedVerificationPackage.seal;
        finalizedVerificationArtifactPresence =
          finalizedVerificationPackage.artifactPresence;
        // Phase 32.6 — completion counter at the canonical success
        // site (after artifact-presence is populated). Failures
        // counted separately via the catch arm.
        try {
          const { bump } = await import("@proovra/shared-runtime/ops");
          bump("package_generation_completed_total");
        } catch {
          /* metrics are best-effort */
        }
      } catch (verificationError) {
        // Phase 32.6.1 — distinguish PackageGateDeniedError (expected
        // governance-blocked path) from real bugs.
        //
        // Background: previously every catch in this block called
        // captureException + logger.error. That turned every
        // legitimate governance gate denial (e.g. legal hold, active
        // destruction review) into a Sentry "high" alert, AND left
        // the evidence row with NO marker that a denial had occurred.
        // The downstream /v1/evidence/:id/verification-package route
        // then returned 404 — operators couldn't tell "blocked by
        // policy" from "never attempted" from "actually missing".
        //
        // Fix:
        //   1. PackageGateDeniedError → persist bounded `{ outcome,
        //      reason, blockedAtUtc }` to evidence.verificationPackageMetadata,
        //      bump `package_generation_blocked_total` (already
        //      registered), log INFO (not error), NO captureException.
        //   2. Any other error → keep captureException + log.error +
        //      bump failed_total (existing behavior).
        //
        // Anti-leak: the persisted metadata is bounded to the gate's
        // catalog vocabulary (outcome + reason are bounded strings
        // from the gate). NEVER contains storage keys, signed URLs,
        // raw stack traces, or private fields.
        if (verificationError instanceof PackageGateDeniedError) {
          try {
            const { bump } = await import("@proovra/shared-runtime/ops");
            bump("package_generation_blocked_total");
          } catch {
            /* metrics are best-effort */
          }
          try {
            await prisma.evidence.update({
              where: { id: evidenceId },
              data: {
                verificationPackageMetadata: {
                  blocked: true,
                  outcome: verificationError.outcome,
                  reason: verificationError.reason,
                  label: verificationError.label,
                  blockedAtUtc: new Date().toISOString(),
                },
              },
            });
          } catch (writeErr) {
            // Persistence failure here is logged separately so we
            // can spot it without conflating with the gate denial.
            logger.warn(
              {
                evidenceId,
                err: writeErr instanceof Error ? writeErr.message : String(writeErr),
              },
              "verification_package.gate_denial_persist_failed",
            );
          }
          logger.info(
            {
              evidenceId,
              outcome: verificationError.outcome,
              reason: verificationError.reason,
            },
            "verification_package.blocked_by_governance",
          );
        } else {
          captureException(verificationError, {
            evidenceId,
            phase: "verification_package_prepare_finalized",
          });

          // Phase 32.6 — bounded failure counter.
          try {
            const { bump } = await import("@proovra/shared-runtime/ops");
            bump("package_generation_failed_total");
          } catch {
            /* metrics are best-effort */
          }

          logger.error(
            {
              evidenceId,
              err: verificationError,
            },
            "Verification package generation failed after finalized custody"
          );

          packageTechnicalFailure = {
            phase: "prepare",
            message: toBoundedReasonCode(verificationError),
          };
        }
      }
    }

    if (!finalized.skipped && finalizedVerificationStaged) {
      const staged = finalizedVerificationStaged;
      // Set once the object is PUBLISHED (before the row is committed); the
      // catch below uses it to tell "published but not recorded" (an
      // immutable orphan) from "not published".
      let publishedPackage: PublishedArtifact | null = null;
            try {
        /*
         * PACKAGE PUBLICATION (2026-09-29) — one verified, immutable write.
         *
         *   exact size + SHA-256 known from the temp file
         *   → allowance gate (BEFORE any byte leaves the worker)
         *   → PutObject to a single-use key WITH x-amz-checksum-sha256 AND the
         *     Object Lock retention in the same request, If-None-Match: *
         *   → HEAD by VersionId: size, stored SHA-256, lock mode, retain-until
         *   → DB row records the exact key, VersionId and digest.
         *
         * The UC-3 staging PUT (no checksum) and the promote CopyObject (lock
         * headers, no checksum) are gone: they are the two candidate calls for
         * the 2026-09-28 Object Lock refusal, and neither is needed — the gate
         * already has the exact size before upload. No transaction is open
         * while storage is written.
         */
        try {
          await assertWorkspaceAllowsVerificationPackageArtifact({
            ownerUserId: evidence.ownerUserId,
            teamId: evidence.teamId ?? null,
            incomingBytes: BigInt(staged.sizeBytes),
            // Credit-funded records earn their package on a FREE account.
            evidenceId: evidence.id,
          });
        } catch (gateError) {
          throw toPackageAllowanceRefusal(gateError);
        }

        // A concurrent run may already have committed this exact package:
        // nothing is published a second time for it.
        if (
          await prisma.verificationPackage.findFirst({
            where: { evidenceId: prepared.evidenceId, version: prepared.version },
            select: { id: true },
          })
        ) {
          throw new PackageAlreadyCommittedError(prepared.version);
        }

        // DURABLE PROGRESS — built; publishing + reading back the stored ZIP.
        await recordRequestProgress(command, "VERIFYING_PACKAGE");
        publishedPackage = await publishImmutableArtifact({
          bucket: env.S3_BUCKET,
          key: buildPublicationKey({
            family: "verification",
            evidenceId: prepared.evidenceId,
            version: prepared.version,
            requestId: command.requestId,
            extension: "zip",
          }),
          body: { kind: "file", filePath: staged.tempPath, sizeBytes: staged.sizeBytes },
          sha256Base64: staged.sha256Base64,
          contentType: "application/zip",
          metadata: {
            evidence_id: prepared.evidenceId,
            report_version: String(prepared.version),
            artifact_type: "verification_package",
            package_format_version: finalizedVerificationSeal
              ? String(finalizedVerificationSeal.packageFormatVersion)
              : "4",
          },
          tags: {
            artifact: "verification-package",
            evidenceId: prepared.evidenceId,
            immutable: "true",
          },
        });
        // Local temp is no longer the only copy — bound worker disk.
        await cleanupStagedTemp(staged);
        const verificationHead = publishedPackage;

        await prisma.$transaction(async (tx) => {
          /*
           * THE BASELINE, RE-CHECKED WHERE IT IS COMMITTED (2026-09-29).
           *
           * Under the record's advisory lock: the report this package embeds
           * must still be the report row for this version with the digest the
           * run verified, and no package may exist for it yet. A request whose
           * baseline moved is refused explicitly (never attached to another
           * PDF); a concurrent run that committed first wins, and this run's
           * published object stays an unreferenced immutable orphan.
           */
          await tx.$executeRaw`
            SELECT pg_advisory_xact_lock(hashtext(${prepared.evidenceId}))
          `;
          const baseline = await tx.report.findUnique({
            where: {
              evidenceId_version: { evidenceId: prepared.evidenceId, version: prepared.version },
            },
            select: { pdfSha256: true },
          });
          if (!baseline) {
            throw createWorkerError(PACKAGE_REPORT_BASELINE_CHANGED, false);
          }
          if (
            baseline.pdfSha256 &&
            baseline.pdfSha256.toLowerCase() !== finalized.finalizedReportSha256.toLowerCase()
          ) {
            throw createWorkerError(PACKAGE_REPORT_BASELINE_CHANGED, false);
          }
          if (
            await tx.verificationPackage.findFirst({
              where: { evidenceId: prepared.evidenceId, version: prepared.version },
              select: { id: true },
            })
          ) {
            throw new PackageAlreadyCommittedError(prepared.version);
          }

          await tx.verificationPackage.create({
            data: {
              evidenceId: prepared.evidenceId,
              version: prepared.version,
              storageBucket: env.S3_BUCKET,
              storageKey: verificationHead.key,
              storageRegion: process.env.S3_REGION?.trim() || null,
              storageObjectLockMode: verificationHead.objectLockMode,
              storageObjectLockRetainUntilUtc:
                verificationHead.objectLockRetainUntilUtc,
              storageObjectLockLegalHoldStatus:
                verificationHead.objectLockLegalHoldStatus,
              generatedAtUtc: prepared.now,
              sizeBytes: BigInt(staged.sizeBytes),
packageType: "full_evidence_package",
trustDecisionSnapshot:
  finalized.finalizedTrustDecision as unknown as Prisma.InputJsonValue,
              // The report this package certifies, and the hash of the exact
              // report bytes embedded in it.
              reportVersion: prepared.version,
              reportSha256: finalized.finalizedReportSha256,
              packageSha256: staged.sha256Hex,
              s3VersionId: verificationHead.versionId,
              packageFormatVersion:
                finalizedVerificationSeal?.packageFormatVersion ?? null,
              // ET-PKG-02: what Public Verify serves so a recipient can check
              // the seal key of the package they hold against PROOVRA.
              sealSha256: finalizedVerificationSeal?.sealSha256 ?? null,
              sealSigningKeySha256: finalizedVerificationSeal?.signingKeyFingerprint ?? null,
              reportIssuedAtUtc: finalized.reportIssuedAtUtc,
              custodyThroughSequence: finalized.custodyThroughSequence,
            },
          });

          // ET-SEC-29 — the record's "latest package" pointer only ADVANCES. A
          // package-only recovery of an older report version (e.g. v1 while v2
          // is latest) attaches its own package row above but must not move the
          // pointer (or its metadata) backwards. Equal is allowed: a rebuild of
          // the same version refreshes its metadata.
          await tx.evidence.updateMany({
            where: {
              id: prepared.evidenceId,
              OR: [
                { verificationPackageVersion: null },
                { verificationPackageVersion: { lte: prepared.version } },
              ],
            },
            data: {
              verificationPackageGeneratedAtUtc: prepared.now,
              verificationPackageVersion: prepared.version,
              verificationPackageMetadata: {
                manifestPresent:
                  finalizedVerificationArtifactPresence?.manifestPresent === true,
                signedManifestPresent:
                  finalizedVerificationArtifactPresence?.signedManifestPresent === true,
                checksumIndexPresent:
                  finalizedVerificationArtifactPresence?.checksumIndexPresent === true,
                auditExportIncluded:
                  finalizedVerificationArtifactPresence?.auditExportIncluded === true,
                custodyExportIncluded:
                  finalizedVerificationArtifactPresence?.custodyExportIncluded === true,
                accessExportIncluded:
                  finalizedVerificationArtifactPresence?.accessExportIncluded === true,
                packageVersion: "v1",
                generatedAtUtc: prepared.now.toISOString(),
                source: "GENERATION",
              },
            },
          });

          await tx.report.updateMany({
  where: {
    evidenceId: prepared.evidenceId,
    version: prepared.version,
  },
  data: {
    verificationPackageVersion: prepared.version,
  },
});

          await appendCustodyEventTx(tx, {
            evidenceId: prepared.evidenceId,
            eventType:
              prismaPkg.CustodyEventType.VERIFICATION_PACKAGE_GENERATED,
            atUtc: prepared.now,
            payload: {
              version: prepared.version,
              packageType: "full_evidence_package",
              reportVersion: prepared.version,
              reportSha256: finalized.finalizedReportSha256,
              // A package built for an existing, verified report rather than
              // alongside a newly rendered one.
              ...(finalized.reportCreated ? {} : { recovery: true }),
            } as Prisma.InputJsonValue,
          });

          const fencedPublish = await tx.reportGenerationRequest.updateMany({
            where: claimFenceWhere(command),
            data: { reportVersion: prepared.version, stage: "PACKAGE_PUBLISHED" },
          });
          if (fencedPublish.count !== 1) throw new ReportClaimLost(command.requestId);
        });

        appendWorkerAuditLog({
          userId: evidence.ownerUserId,
          // PHASE 12 POINT 3 — V3 binds tenant scope INTO the hash. Taken from
          // the persisted evidence row, never from ambient context.
          organizationId: evidence.organizationId ?? null,
          workspaceId: evidence.teamId ?? null,
          action: "evidence.verification_package_generated",
          category: "evidence",
          severity: "info",
          source: "worker_report",
          outcome: "success",
          resourceType: "evidence",
          resourceId: prepared.evidenceId,
          requestId,
          metadata: {
            evidenceId: prepared.evidenceId,
            verificationPackageVersion: prepared.version,
            reportVersion: prepared.version,
            recovery: !finalized.reportCreated,
            effectivePlan: prepared.effectivePlan,
          },
        }).catch(() => null);

        // Phase SEARCH-REMEDIATION-3 — index the freshly-finalised
        // package + its co-finalised report directly into
        // evidence_search_documents. Best-effort: any failure here
        // is swallowed and logged; it must NEVER surface to the
        // report/package generation pipeline. The reconciliation
        // sweeper backstops orphan rows in case this hook misses.
        try {
          const created = await prisma.verificationPackage.findFirst({
            where: {
              evidenceId: prepared.evidenceId,
              version: prepared.version,
            },
            select: { id: true },
          });
          if (created) {
            // Phase SEARCH-REMEDIATION-CI-FIX — worker uses its own
            // mirror of the API's indexer (see
            // services/worker/src/search-index/artifact-indexer.ts
            // for the rationale). Worker MUST NOT import from
            // services/api/src — that violates the build rootDir
            // boundary and crashes the worker Docker image build.
            const { indexPackage } = await import(
              "./search-index/artifact-indexer.js"
            );
            const res = await indexPackage({ packageId: created.id });
            if (!res.ok) {
              logger.warn(
                {
                  packageId: created.id,
                  reason: res.reason,
                },
                "search_index.package_skipped",
              );
            }
          }
          // Same for the report row co-finalized at this version.
          const co = await prisma.report.findFirst({
            where: {
              evidenceId: prepared.evidenceId,
              version: prepared.version,
            },
            select: { id: true },
          });
          if (co) {
            const { indexReport } = await import(
              "./search-index/artifact-indexer.js"
            );
            const res = await indexReport({ reportId: co.id });
            if (!res.ok) {
              logger.warn(
                {
                  reportId: co.id,
                  reason: res.reason,
                },
                "search_index.report_skipped",
              );
            }
          }
        } catch (err) {
          logger.warn(
            {
              err: err instanceof Error ? err.message.slice(0, 200) : "unknown",
              evidenceId: prepared.evidenceId,
              version: prepared.version,
            },
            "search_index.lifecycle_failed",
          );
        }

      } catch (verificationError) {
        // Fail closed: never leave a private temp file behind. A published but
        // unrecorded object is NOT overwritten by the retry (single-use keys,
        // If-None-Match); it is left as an immutable orphan and listed by the
        // orphan inventory, and the retry publishes under a fresh key.
        await cleanupStagedTemp(staged).catch(() => {});

        if (verificationError instanceof PackageAlreadyCommittedError) {
          // Not a failure: the pair is complete. Any object this run published
          // is an unreferenced immutable orphan for the orphan inventory.
          logger.info(
            {
              ...withJobContext({ requestId, jobId: job.id, evidenceId, status: "package_already_committed" }),
              reportVersion: prepared.version,
              orphanKeyPublished: publishedPackage !== null,
            },
            "Verification package for this report version was committed by a concurrent run",
          );
        } else if (verificationError instanceof PackageAllowanceRefusal) {
          // A commercial or storage-allowance answer, not a pipeline fault.
          packageAllowanceRefusal = verificationError;
        } else {
        captureException(verificationError, {
          requestId,
          evidenceId,
          jobId: job.id ?? null,
          phase: "verification_package_store",
          jobKind: "GenerateReportJob",
          queueName: "report",
          storageCode:
            verificationError instanceof StoragePublicationRejectedError
              ? verificationError.storageCode
              : null,
          publishedButUnrecorded: publishedPackage !== null,
        });

        logger.error(
          {
            ...withJobContext({
              requestId,
              jobId: job.id,
              evidenceId,
              attempt: job.attemptsMade + 1,
              status: "verification_package_failed",
            }),
            err: verificationError,
          },
          "Verification package upload failed, but report was generated successfully"
        );

        appendWorkerAuditLog({
          userId: evidence.ownerUserId,
          // PHASE 12 POINT 3 — V3 binds tenant scope INTO the hash. Taken from
          // the persisted evidence row, never from ambient context.
          organizationId: evidence.organizationId ?? null,
          workspaceId: evidence.teamId ?? null,
          action: "evidence.verification_package_generation_failed",
          category: "evidence",
          severity: "warning",
          source: "worker_report",
          outcome: "failure",
          resourceType: "evidence",
          resourceId: prepared.evidenceId,
          requestId,
          metadata: {
            evidenceId: prepared.evidenceId,
            reportVersion: prepared.version,
            verificationPackageVersion: prepared.version,
            effectivePlan: prepared.effectivePlan,
            errorMessage:
              verificationError instanceof Error
                ? verificationError.message
                : "UNKNOWN_VERIFICATION_PACKAGE_ERROR",
          },
        }).catch(() => null);

        packageTechnicalFailure = {
          phase: "store",
          message: toBoundedReasonCode(verificationError),
          // A deterministic storage refusal, or a report baseline that moved,
          // cannot succeed on retry; it is terminal at once instead of
          // burning the whole retry budget.
          retriable:
            !(verificationError instanceof StoragePublicationRejectedError) &&
            (verificationError as { code?: unknown })?.code !== PACKAGE_REPORT_BASELINE_CHANGED,
          storageCode:
            verificationError instanceof StoragePublicationRejectedError
              ? verificationError.storageCode
              : null,
        };
        }
      }
    }

    if (!finalized.skipped && finalized.reportCreated) {
      appendWorkerAnalyticsEvent({
        eventType: "report_generated",
        userId: evidence.ownerUserId,
        entityType: "evidence",
        entityId: prepared.evidenceId,
        severity: "info",
        metadata: {
          evidenceId: prepared.evidenceId,
          reportVersion: finalized.reportVersion,
          generatedAtUtc: prepared.now.toISOString(),
          source: "worker",
          forceRegenerate,
          regenerateReason,
          effectivePlan: prepared.effectivePlan,
        },
      }).catch(() => null);

      appendWorkerAuditLog({
        userId: evidence.ownerUserId,
        // PHASE 12 POINT 3 — V3 binds tenant scope INTO the hash. Taken from the
        // persisted evidence row being audited, never from ambient context.
        organizationId: evidence.organizationId ?? null,
        workspaceId: evidence.teamId ?? null,
        action: "evidence.report_generated",
        category: "evidence",
        severity: "info",
        source: "worker_report",
        outcome: "success",
        resourceType: "evidence",
        resourceId: prepared.evidenceId,
        requestId,
        metadata: {
          evidenceId: prepared.evidenceId,
          reportVersion: finalized.reportVersion,
          effectivePlan: prepared.effectivePlan,
        },
      }).catch(() => null);
    }

    /*
     * THE REPORT JOB NO LONGER SCHEDULES OTS WORK EITHER.
     *
     * This called `enqueueOtsUpgradeRetry` whenever the stamp it had just
     * made still needed the anchoring ladder. With initialization moved out,
     * the condition was permanently false, and a scheduler that can never
     * fire is worse than none: it reads as coverage.
     *
     * Scheduling belongs to the lifecycle that owns the state. Evidence
     * finalization enqueues the first job, the upgrade processor re-enqueues
     * its own follow-up under the global budget, and the reconciliation
     * script covers records that predate all of it.
     */

    const durationMs = Date.now() - start;

    logger.info(
      {
        ...withJobContext({
          requestId,
          jobId: job.id,
          evidenceId,
          attempt: job.attemptsMade + 1,
          durationMs,
          status: finalized.skipped ? "already_completed" : "completed",
        }),
        forceRegenerate,
        regenerateReason,
        effectivePlan: prepared.effectivePlan,
      },
      finalized.skipped
        ? "GenerateReportJob skipped because report already exists"
        : "GenerateReportJob completed"
    );

    /*
     * =====================================================================
     * THE REQUEST IS NOT SUCCESSFUL WHILE AN OUTPUT IT OWNS IS MISSING.
     * =====================================================================
     * One request produces one PAIR — the report and the verification package
     * are built by this job precisely so the customer has one action for one
     * pipeline. Reporting SUCCEEDED with half of it missing made the request
     * row, which is the durable authority every surface reads, state something
     * that was not true: the projection reported the package as "never asked
     * for", Operations opened nothing, and the only convergence was a human
     * noticing.
     *
     * Throwing here rather than returning routes this into machinery that
     * already exists: the caller writes FAILED_RETRYABLE (this error is
     * retryable), BullMQ re-runs the request under its own attempt budget, the
     * completeness guard at the top of this function now lets that re-run
     * proceed, and if the budget is exhausted the stranded-request reconciler
     * retires the row to a truthful terminal state. Nothing new was invented to
     * carry it.
     *
     * The report that DID commit is untouched and stays downloadable. This is a
     * statement about the REQUEST, not a rollback of the artifact.
     */
    if (packageAllowanceRefusal) {
      // Not an incident: the workspace's plan or storage refused it. The
      // request records the bounded commercial code; an upgrade or more
      // storage makes it supersedable (see COMMERCIAL_TERMINAL_REASONS).
      throw createWorkerError(packageAllowanceRefusal.code, false);
    }
    if (packageTechnicalFailure && verificationPackageEntitled) {
      await recordPackageGenerationIncident({
        evidenceId,
        teamId: evidence.teamId ?? null,
        jobId: job.id ?? null,
        phase: packageTechnicalFailure.phase,
        reasonCode:
          packageTechnicalFailure.retriable === false
            ? `VERIFICATION_PACKAGE_STORAGE_REJECTED`
            : packageTechnicalFailure.message,
        reportVersion: packageTargetVersion ?? prepared.version,
        storageCode: packageTechnicalFailure.storageCode ?? null,
      });
      if (packageTechnicalFailure.retriable === false) {
        // Deterministic: terminal now, escalated with a CRITICAL incident that
        // names the storage code. An operator path (supersede) exists once the
        // configuration or code is fixed.
        throw createWorkerError("VERIFICATION_PACKAGE_STORAGE_REJECTED", false);
      }
      throw createWorkerError(
        "VERIFICATION_PACKAGE_INCOMPLETE_" +
          packageTechnicalFailure.phase.toUpperCase(),
        true,
      );
    }
    if (finalized.skipped) return { outcome: "already_issued", reportVersion: null };
    return runMode === "PACKAGE_FOR_VERSION"
      ? { outcome: "package_built", reportVersion: packageTargetVersion! }
      : { outcome: "generated", reportVersion: prepared.version };
  } catch (error) {
    /*
     * `REPORT_ALREADY_GENERATED` IS NO LONGER SWALLOWED AS SUCCESS.
     *
     * It returned normally here, and the caller recorded the request as
     * SUCCEEDED "generated" — while the package the request owned did not
     * exist and no build had been attempted. Runs are now routed by what they
     * own (see WHAT THIS RUN IS FOR above), so reaching this error is a genuine
     * inconsistency, and it is reported as the failure it is.
     */

    /*
     * A COMMERCIAL DENIAL IS NOT AN OPERATIONAL FAILURE.
     *
     * Phase CAPTURE-PLAN-GATE-FIX got the first half of this right — no Sentry
     * capture, a warn log — and then did the second half wrong: it still
     * discarded to the DLQ and still opened a CRITICAL OperationalIncident,
     * on the stated reasoning that the incident would let "the UI surface a
     * 'Reports not included in your plan' state instead of polling forever".
     *
     * No UI ever consumed it. What shipped instead was a permanent CRITICAL
     * incident titled "Report generation failure" on a workspace whose only
     * offence was being on a plan that does not include reports, offering a
     * "Regenerate" remediation that would fail identically. A plan is not an
     * outage; an operator has nothing to fix and nothing to acknowledge.
     *
     * So this path now exits cleanly. The DURABLE REQUEST ROW still records
     * FAILED_TERMINAL with `REPORT_NOT_INCLUDED_IN_PLAN` — the caller writes it
     * from `toBoundedReasonCode` — and THAT is what the product reads: the
     * artifact-status projection turns it into `NOT_INCLUDED`, and the
     * generation authority treats it as commercially obsolete so a later
     * upgrade can supersede it. One durable fact, read by the surfaces that
     * need it, instead of an incident nobody could act on.
     *
     * `job.discard()` is kept: the job must not retry a decision that will not
     * change on its own.
     */
    const isPlanDenial = isCommercialDenialError(error);

    if (isPlanDenial) {
      logger.warn(
        {
          ...withJobContext({
            requestId,
            jobId: job.id,
            evidenceId,
            attempt: job.attemptsMade + 1,
            durationMs: Date.now() - start,
            status: "plan_gate_denied",
          }),
          errorCode: commercialDenialCode(error),
        },
        "GenerateReportJob refused: this record's plan does not include the output",
      );
      await job.discard();
      throw error;
    }

    captureException(error, { requestId, evidenceId, jobId: job.id ?? null });

    const durationMs = Date.now() - start;

    logger.error(
      {
        ...withJobContext({
          requestId,
          jobId: job.id,
          evidenceId,
          attempt: job.attemptsMade + 1,
          durationMs,
          status: "failed",
        }),
        err: error,
      },
      "GenerateReportJob failed"
    );

    const attempts = job.opts.attempts ?? 1;
    const retriable = isRetriableError(error);

    if (!retriable) {
      await job.discard();
      // ET-Q-08 — a DLQ record carries a bounded error CODE, never the raw
      // message or stack (a stack names storage keys and file paths).
      await reportDlqQueue.add(
        "ReportDLQ",
        {
          evidenceId,
          jobId: job.id,
          errorCode: toBoundedReasonCode(error),
          retriable: false,
        },
        { removeOnComplete: true, removeOnFail: false }
      );

      // Phase IA-reliability — bridge into OperationalIncident so
      // /v1/me/inbox sees the failure. Non-retriable DLQ moves are
      // CRITICAL — the report cannot be regenerated without operator
      // intervention.
      await recordReportFailureIncident({
        evidenceId,
        jobId: job.id,
        error,
        severity: "CRITICAL",
        retriable: false,
      });

      logger.error(
        {
          ...withJobContext({
            requestId,
            jobId: job.id,
            evidenceId,
            attempt: job.attemptsMade + 1,
            durationMs,
            status: "dlq",
          }),
          moved_to_dlq: true,
        },
        "GenerateReportJob moved to DLQ (non-retriable)"
      );

      throw error;
    }

    if (job.attemptsMade + 1 >= attempts) {
      // ET-Q-08 — NO DLQ record here. BullMQ's per-run attempts are spent, but
      // the durable request stays FAILED_RETRYABLE and lifecycle recovery
      // re-drives it (up to 12 claims), so it is not dead letter. The DLQ holds
      // only terminal failures; a request that exhausts its DURABLE budget is
      // retired and escalated by the report authority.

      // ET-REC-10 — ONE BUDGET. This is BullMQ's per-run budget (5 attempts);
      // the request's DURABLE budget (REPORT_RECONCILE_MAX_ATTEMPTS = 12 claims)
      // keeps it FAILED_RETRYABLE and the reconciler re-enqueues it. A HIGH
      // "retry budget exhausted" incident here told operators it was over
      // while the customer saw Retry and the supersede action was refused (not
      // terminal). The exhausted incident is opened by the report authority
      // when the durable row goes FAILED_TERMINAL.

      logger.error(
        {
          ...withJobContext({
            requestId,
            jobId: job.id,
            evidenceId,
            attempt: job.attemptsMade + 1,
            durationMs,
            status: "dlq",
          }),
          moved_to_dlq: true,
        },
        "GenerateReportJob moved to DLQ"
      );
    }

    throw error;
  }
}

// ---------------------------------------------------------------------------
// Phase IA-reliability — report DLQ → OperationalIncident bridge.
//
// Called from both terminal-failure paths in `processGenerateReport` (the
// non-retriable discard + the retry-exhausted DLQ move). Looks up the
// evidence's teamId so the incident lands in the correct workspace
// scope, normalises the error message into a bounded fingerprint, and
// delegates to the worker-side `recordWorkerIncident` helper which
// upserts the operational_incidents row + writes a child event row.
//
// Hard rules:
//   * NEVER include stack traces or PII in the incident — only a
//     truncated, normalised message + the job id + evidence id.
//   * Fingerprint is deterministic on `evidenceId + errorClass` so
//     repeated failures dedupe to one row.
//   * Best-effort — incident emission failure is logged and swallowed
//     so it never masks the original DLQ move.
// ---------------------------------------------------------------------------
async function recordReportFailureIncident(input: {
  evidenceId: string;
  jobId: string | undefined;
  error: unknown;
  severity: "CRITICAL" | "HIGH";
  retriable: boolean;
}): Promise<void> {
  /*
   * A PACKAGE FAILURE IS NOT A REPORT FAILURE.
   *
   * When the report committed and only its package failed, the package path
   * has already recorded `PACKAGE:<id>:v<N>:<class>`. Recording the same run
   * again here, under the REPORT source, produced a second condition for the
   * same fact — and that one's probe asks "does a report exist?", which is
   * true, so it read as recovered while the package was still missing.
   */
  if (isPackageOwnedFailure(input.error)) return;
  try {
    const ev = await prisma.evidence.findUnique({
      where: { id: input.evidenceId },
      select: { teamId: true, title: true },
    });
    // Phase WORKER-INCIDENT-SAFESUMMARY-FIX — always produce a
    // non-empty rawMessage. WorkerError carries its code in `.message`
    // and may also expose `.code` directly. Either way we want a
    // deterministic operator-readable string so safeSummary downstream
    // cannot collapse to empty.
    const errorCode =
      input.error && typeof (input.error as { code?: unknown }).code === "string"
        ? ((input.error as { code: string }).code)
        : null;
    const errorMessage =
      input.error instanceof Error && input.error.message
        ? input.error.message
        : typeof input.error === "string" && input.error
          ? input.error
          : null;
    const rawMessage =
      errorMessage || errorCode || "Unknown error";
    const errorClass = rawMessage
      .split(/[:\n]/, 1)[0]
      .trim()
      .slice(0, 80)
      .toUpperCase()
      .replace(/\s+/g, "_") || "UNKNOWN";
    const fingerprint = `REPORT:${input.evidenceId}:${errorClass}`;
    const evidenceLabel = ev?.title ? ev.title.slice(0, 80) : input.evidenceId.slice(0, 8);
    await recordWorkerIncident({
      sourceId: "pipeline.report_generation_failed",
      teamId: ev?.teamId ?? null,
      category: "REPORT",
      severity: input.severity,
      fingerprint,
      title: input.retriable
        ? `Report generation retry budget exhausted (${evidenceLabel})`
        : `Report generation failure (${evidenceLabel})`,
      safeSummary: rawMessage.slice(0, 380),
      relatedEvidenceId: input.evidenceId,
      relatedJobId: input.jobId ?? null,
      metadata: {
        queueName: "report",
        retriable: input.retriable,
        errorClass,
      },
    });
  } catch (err) {
    logger.warn(
      { err, evidenceId: input.evidenceId },
      "worker.report.incident_bridge_failed",
    );
  }
}

/**
 * RELIABILITY CLOSURE (2026-09-09) — A TECHNICAL PACKAGE FAILURE IS AN
 * OPERATIONAL CONDITION.
 *
 * The verification package had exactly one failure signal: a bumped counter and
 * a log line. Nothing opened, nothing escalated, nothing auto-resolved — so a
 * record left with a report and no package was operationally silent, and the
 * only party who could notice was the customer, on a surface that told them the
 * package had simply never been requested.
 *
 * This is deliberately the SAME bridge the report pipeline uses
 * (`recordWorkerIncident` → the canonical incident authority), under the
 * PACKAGE category the remediation registry already governs. No second incident
 * engine, no second condition vocabulary.
 *
 * WHAT IT IS NOT RAISED FOR. Not a commercial exclusion — that never reaches
 * here, because an unentitled record throws its bounded plan denial long before
 * the package step. Not a governance denial — that has its own persisted
 * metadata and its own `pipeline.package_generation_denied` condition, and
 * calling a policy decision an outage is the error this whole closure is about.
 * Only a genuine build or storage failure.
 *
 * RESOLUTION IS AUTOMATIC AND IS NOT THIS FUNCTION'S BUSINESS. The condition's
 * observation probe reads `Evidence.verificationPackageVersion`; when the pair
 * finally converges, the canonical incident-transition authority resolves it
 * from that domain truth.
 */
async function recordPackageGenerationIncident(input: {
  evidenceId: string;
  teamId: string | null;
  jobId: string | number | null | undefined;
  phase: string;
  reasonCode: string;
  /** The report version whose package failed — the condition clears only when THAT package exists. */
  reportVersion: number;
  /** The object-store error code when storage refused the publication. */
  storageCode?: string | null;
}): Promise<void> {
  try {
    const errorClass =
      (input.reasonCode || "UNKNOWN")
        .split(/[:\n]/, 1)[0]
        .trim()
        .slice(0, 80)
        .toUpperCase()
        .replace(/\s+/g, "_") || "UNKNOWN";
    const deterministic = errorClass === "VERIFICATION_PACKAGE_STORAGE_REJECTED";
    await recordWorkerIncident({
      sourceId: "pipeline.package_generation_failed",
      teamId: input.teamId,
      category: "PACKAGE",
      // A deterministic storage refusal will not clear on retry: it needs a
      // configuration or code change, so it is CRITICAL from the first sight.
      severity: deterministic ? "CRITICAL" : "HIGH",
      // One condition per (record, report version, failure class). Segment 1
      // is the evidence id and segment 2 the version the probe checks.
      fingerprint: `PACKAGE:${input.evidenceId}:v${input.reportVersion}:${errorClass}`,
      title: deterministic
        ? `Verification package v${input.reportVersion} refused by object storage (${input.evidenceId.slice(0, 8)})`
        : `Verification package v${input.reportVersion} generation failed (${input.evidenceId.slice(0, 8)})`,
      safeSummary: deterministic
        ? `Report version ${input.reportVersion} is stored, but object storage refused its verification package. Retrying the same request cannot succeed; after the storage configuration or worker is corrected, an operator can retry it from Operations. The evidence and the report are unaffected.`
        : `Report version ${input.reportVersion} is stored, but its verification package was not. The evidence and the report are unaffected; the pipeline retries, and the condition clears only when the package for version ${input.reportVersion} exists.`,
      relatedEvidenceId: input.evidenceId,
      relatedJobId: input.jobId == null ? null : String(input.jobId),
      metadata: {
        queueName: "report",
        phase: input.phase,
        errorClass,
        reportVersion: input.reportVersion,
        ...(input.storageCode ? { storageCode: input.storageCode.slice(0, 64) } : {}),
      },
    });
  } catch (err) {
    logger.warn(
      { err, evidenceId: input.evidenceId },
      "worker.package.incident_bridge_failed",
    );
  }
}

/**
 * `PurgeDeletedEvidenceJob` — now a TRIGGER, not an executor.
 *
 * What this function used to be, and why none of it is left:
 *
 *   * it re-implemented destruction eligibility (its own retention, lock,
 *     archive and hold checks) beside three other implementations that
 *     disagreed with it — most visibly by SKIPPING any archived record, so an
 *     archived-then-trashed record was never destroyed;
 *   * it deleted the evidence, part, report and verification-package objects
 *     but not redaction derivatives, so a "purged" record could leave a fully
 *     readable redacted rendering behind;
 *   * it then ran `tx.evidence.delete` and `tx.custodyEvent.deleteMany`, which
 *     removed the row AND its custody chain. A destroyed record left no trace
 *     that it had ever existed and no certificate that it had been destroyed —
 *     the exact opposite of a tombstone.
 *
 * All of that is now `executeEvidenceDestruction` in `@proovra/shared-runtime`,
 * shared with every other destruction trigger. What remains here is the queue
 * contract: decode the envelope strictly, resolve the two facts the executor
 * refuses to guess (the effective legal-hold verdict and the approval posture),
 * call it, and translate the outcome into a reschedule, a no-op or a log line.
 *
 * A blocked outcome reschedules rather than fails. Every block reason this can
 * see is a TIME boundary or a hold, and both lift on their own; a failed job
 * would need an operator where a re-tick needs nobody.
 */
export async function processPurgeDeletedEvidence(job: Job<unknown>) {
  const start = Date.now();
  const requestId = randomUUID();

  // PHASE 12 — POINT 5. Strict decode before the first database read: a
  // destructive job must refuse a malformed or tampered payload rather than
  // repair it into a runnable command, and the evidence row is the only source
  // of tenancy.
  const decoded = decodeCanonicalJob(JOB_NAMES.PURGE_DELETED_EVIDENCE, job, {
    requestId,
  });
  const evidenceId = decoded.commandId;

  const ctx = {
    ...withJobContext({
      requestId,
      jobId: job.id,
      evidenceId,
      attempt: job.attemptsMade + 1,
      status: "purging",
    }),
    correlationId: decoded.traceId || null,
    envelope: decoded.legacy ? ("legacy" as const) : ("canonical" as const),
  };

  logger.info(ctx, "PurgeDeletedEvidenceJob started");

  try {
    const evidence = await prisma.evidence.findUnique({
      where: { id: evidenceId },
      select: {
        id: true,
        teamId: true,
        deleteScheduledForUtc: true,
        caseLinks: { select: { caseId: true } },
      },
    });

    if (!evidence) {
      logger.info(
        ctx,
        "PurgeDeletedEvidenceJob skipped because evidence does not exist",
      );
      return;
    }

    // The effective hold verdict, from THE union evaluator, fail-closed: a
    // transient database error throws rather than reporting "no hold".
    const hold = await evaluateEffectiveLegalHold(prisma, {
      teamId: evidence.teamId ?? null,
      evidenceId: evidence.id,
      caseIds: (evidence.caseLinks ?? []).map((l) => l.caseId),
    });

    // Does this record need an approved destruction, and does it have one?
    // Resolved by the ONE shared rule, fail-closed. This job is the AUTOMATIC
    // path: it carries no approval of its own, so a workspace record without an
    // approved review is refused here and only the governance pipeline can move
    // it forward.
    const approval = await resolveDestructionApproval(prisma, {
      evidenceId: evidence.id,
      teamId: evidence.teamId ?? null,
    });

    const result = await executeEvidenceDestruction(
      prisma,
      {
        evidenceId: evidence.id,
        trigger: "purge_job",
        legalHold: hold.held,
        destructionApprovalRequired: approval.required,
        destructionApproved: approval.approved,
        destructionReviewId: approval.destructionReviewId,
        correlationId: decoded.traceId || null,
      },
      workerEvidenceDestructionStorage,
    );

    if (result.ok && result.outcome === "DESTROYED") {
      appendWorkerAuditLog({
        userId: null,
        organizationId: null,
        workspaceId: evidence.teamId ?? null,
        action: "evidence.destroyed",
        category: "evidence",
        severity: "warning",
        source: "worker_purge",
        outcome: "success",
        resourceType: "evidence",
        resourceId: evidence.id,
        requestId,
        metadata: {
          evidenceId: evidence.id,
          certificateHash: result.certificateHash,
          destroyedObjectCount: result.destroyedObjectCount,
        },
      }).catch(() => null);

      logger.info(
        {
          ...withJobContext({
            requestId,
            jobId: job.id,
            evidenceId,
            attempt: job.attemptsMade + 1,
            durationMs: Date.now() - start,
            status: "destroyed",
          }),
          certificateHash: result.certificateHash,
          destroyedObjectCount: result.destroyedObjectCount,
        },
        "PurgeDeletedEvidenceJob completed",
      );
      return;
    }

    if (result.ok) {
      logger.info(ctx, "PurgeDeletedEvidenceJob skipped: already destroyed");
      return;
    }

    if (result.outcome === "BLOCKED") {
      // Re-tick at the boundary the executor named when it is a date we know,
      // otherwise daily. Nothing is orphaned: releasing the hold or passing the
      // deadline lets the next tick proceed.
      const recheckAt =
        evidence.deleteScheduledForUtc &&
        evidence.deleteScheduledForUtc.getTime() > Date.now()
          ? evidence.deleteScheduledForUtc
          : new Date(Date.now() + 24 * 60 * 60 * 1000);
      // ET-Q-05 — schedule a REAL follow-up (selfJobId), and log what the
      // queue answered instead of claiming a reschedule that collapsed.
      const rescheduled = await enqueueEvidencePurgeJob(evidence.id, recheckAt.toISOString(), {
        selfJobId: job.id ?? null,
      });
      logger.info(
        {
          ...ctx,
          blockReason: result.reason,
          rescheduledFor: recheckAt.toISOString(),
          rescheduleEnqueued: rescheduled.enqueued,
        },
        rescheduled.enqueued
          ? "PurgeDeletedEvidenceJob rescheduled: destruction is not yet permitted"
          : "PurgeDeletedEvidenceJob NOT rescheduled: the trash-grace reconciler re-nominates it",
      );
      return;
    }

    if (result.outcome === "CLAIM_HELD" || result.outcome === "NOT_FOUND") {
      logger.info(
        { ...ctx, outcome: result.outcome },
        "PurgeDeletedEvidenceJob stood down",
      );
      return;
    }

    // Storage refused, or an object survived the delete. The record is back in
    // TRASHED, uncertified and undestroyed. This IS a failure — it needs the
    // queue's retry and an operator's eyes, and it must never look like a
    // completed destruction.
    logger.error(
      { ...ctx, outcome: result.outcome, failedKeys: result.failedKeys },
      "PurgeDeletedEvidenceJob failed: storage deletion could not be verified",
    );
    throw new Error(result.outcome);
  } catch (error) {
    captureException(error, { requestId, evidenceId, jobId: job.id ?? null });

    logger.error(
      {
        ...withJobContext({
          requestId,
          jobId: job.id,
          evidenceId,
          attempt: job.attemptsMade + 1,
          durationMs: Date.now() - start,
          status: "failed",
        }),
        err: error,
      },
      "PurgeDeletedEvidenceJob failed",
    );

    throw error;
  }
}

/*
 * RETIRED (2026-09-29): `enqueueReportJob`.
 *
 * Its only producers were the OTS anchoring paths, which forced a new report
 * version whenever a proof improved. Those no longer re-issue reports (see
 * ots-upgrade.processor.ts), so the forced-regeneration producer is gone
 * rather than left callable. Every worker producer now goes through
 * `requestReportGenerationFromWorker` from the first-issuance reconciliation.
 */
