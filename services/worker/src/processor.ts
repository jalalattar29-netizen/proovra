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
import { evaluateEffectiveLegalHold } from "./governance/effective-legal-hold.js";
// EVIDENCE LIFECYCLE CONVERGENCE (2026-08-24) — the ONE destruction executor
// and the ONE approval rule. The purge job is a trigger for them now.
import {
  executeEvidenceDestruction,
  resolveDestructionApproval,
} from "@proovra/shared-runtime";
import { workerEvidenceDestructionStorage } from "./governance/destruction-storage-port.js";
import {
  assertWorkspaceAllowsReportArtifact,
  assertWorkspaceAllowsVerificationPackageArtifact,
  resolveEffectivePlanForEvidence,
  resolveEvidenceFundingSource,
} from "./workspace-billing.js";
import { resolveEvidenceOutputEntitlements } from "@proovra/shared-billing";
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
  type ReviewerArtifactRole,
  type ReviewerArtifactRoleSource,
} from "@proovra/shared";
import { appendCustodyEventTx, evaluateCustodyChain } from "./custody-events.js";
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
  applyDefaultObjectRetention,
  getObjectStream,
  headObject,
  putObjectBuffer,
} from "./storage.js";
import { createHash, randomUUID, verify as verifySignature } from "node:crypto";
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
  normalizeCustodyEventPayloadForPresentation,
} from "./report-v2/normalizers.js";
import { buildReportMediaIntelligence } from "./media-intelligence-report-bridge.js";
import {
  buildReportTechnicalSummary,
  buildReportAcquisitionContext,
} from "./report-technical-summary-bridge.js";
import { buildVerificationPackageIntelligence } from "./verification-package-intelligence-bridge.js";
import {
  enqueueEvidencePurgeJob,
  enqueueOtsUpgradeJob,
  enqueueReportGenerationRequest,
  reportDlqQueue,
} from "./queue.js";
import { captureException } from "./sentry.js";
import { createVerificationPackage, PackageGateDeniedError } from "./verification-package.js";
import { loadProvenanceChainForPackage } from "./capture-trust/load-provenance-chain.js";
import { createOpenTimestamp, type OtsStampResult } from "./ots.service.js";
import { buildOtsEvidenceUpdateData } from "./ots-state.js";
import { appendWorkerAuditLog } from "./platform-audit-append.js";
import { rejectEvidenceIntegrity } from "./integrity-rejection.service.js";
// PHASE 12 — POINT 5: the payload carries a request id; the authority is a row.
import { decodeCanonicalJob } from "./canonical-job.js";
import {
  markRequestRetryable,
  markRequestTerminal,
  mintRequestForLegacyJob,
  requestReportGenerationFromWorker,
  resolveAndClaimReportRequest,
  type ResolvedReportCommand,
} from "./report-generation-authority.js";
import type { ReportGenerationPurpose } from "@proovra/shared-runtime/reports";

type WorkerError = Error & {
  code: string;
  retriable: boolean;
};

type VerificationEvidenceFile = {
  name: string;
  buffer: Buffer;
  sha256?: string | null;
  mimeType?: string | null;
  sizeBytes?: number | null;
  originalFileName?: string | null;
  partIndex?: number | null;
  storageBucket?: string | null;
  storageKey?: string | null;
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
  buffer: Buffer;
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
// carries only the persisted evidence id — never a tenant/workspace id
// from the job payload.
function buildVerifyUrl(evidenceId: string): string {
  const base = envValue(
    "REPORT_VERIFY_BASE_URL",
    "https://app.proovra.com/verify"
  ).replace(/\/+$/, "");

  return absoluteInternalUrl(base, `/${encodeURIComponent(evidenceId)}`);
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
        ? resolveCustodyCapturePresentation(
            captureMethodSnapshot,
            context?.isIntake === true
          )
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

function sha256HexFromStrings(parts: string[]) {
  return createHash("sha256").update(parts.join("|")).digest("hex");
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
  const normalizedTsaStatus = String(params.tsaStatus ?? "")
    .trim()
    .toUpperCase();

  const timestampInputDigestHex =
    params.tsaInputDigestHex ?? params.fileSha256 ?? null;

  const timestampStatusIsPositive =
    normalizedTsaStatus === "STAMPED" ||
    normalizedTsaStatus === "GRANTED" ||
    normalizedTsaStatus === "VERIFIED" ||
    normalizedTsaStatus === "SUCCEEDED";

  const timestampStatusIsUnavailable =
    normalizedTsaStatus === "FAILED" ||
    normalizedTsaStatus === "UNAVAILABLE" ||
    normalizedTsaStatus === "ERROR" ||
    normalizedTsaStatus.length === 0;

  if (timestampStatusIsPositive) {
    return (
      Boolean(params.tsaMessageImprint && timestampInputDigestHex) &&
      String(params.tsaMessageImprint).toLowerCase() ===
        String(timestampInputDigestHex).toLowerCase()
    );
  }

  if (timestampStatusIsUnavailable) {
    return null;
  }

  return null;
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

function createWorkerError(code: string, retriable: boolean): WorkerError {
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
}): PreparedAnchorPayload | null {
  if (params.anchorMode === "off") return null;

  return {
    version: 1,
    evidenceId: params.evidenceId,
    reportVersion: params.reportVersion,
    fileSha256: params.fileSha256,
    fingerprintHash: params.fingerprintHash,
    lastEventHash: params.lastEventHash,
    anchorHash: sha256HexFromStrings([
      params.evidenceId,
      String(params.reportVersion),
      params.fileSha256,
      params.fingerprintHash,
      params.lastEventHash ?? "",
    ]),
    generatedAtUtc: params.generatedAtUtc,
    transactionId:
      params.anchorSummary?.transactionId ?? params.otsBitcoinTxid ?? null,
    anchoredAtUtc:
      params.anchorSummary?.anchoredAtUtc ??
      (params.otsBitcoinTxid ? params.otsAnchoredAtUtc ?? null : null),
  };
}

function isRetriableError(error: unknown): boolean {
  if (error && typeof error === "object" && "retriable" in error) {
    return (error as WorkerError).retriable === true;
  }
  return true;
}

function isAlreadyObjectLockedLike(e: unknown): boolean {
  const err = e as {
    name?: unknown;
    code?: unknown;
    Code?: unknown;
    message?: unknown;
  };

  const name = String(err?.name ?? "").toLowerCase();
  const code = String(err?.code ?? err?.Code ?? "").toLowerCase();
  const msg = String(err?.message ?? "").toLowerCase();

  return (
    name.includes("accessdenied") ||
    code.includes("accessdenied") ||
    code === "accessdenied" ||
    msg.includes("access denied because object protected by object lock") ||
    msg.includes("object protected by object lock") ||
    msg.includes("object lock") ||
    msg.includes("retention") ||
    msg.includes("legal hold")
  );
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function applyRetentionOrThrow(
  targets: Array<{ bucket: string; key: string }>
) {
  const deduped = Array.from(
    new Map(targets.map((item) => [`${item.bucket}:${item.key}`, item])).values()
  );

  for (const target of deduped) {
    try {
      await applyDefaultObjectRetention({
        bucket: target.bucket,
        key: target.key,
      });
    } catch (error) {
      if (isAlreadyObjectLockedLike(error)) {
        continue;
      }

      const reason =
        error instanceof Error ? error.message : "UNKNOWN_RETENTION_ERROR";

      throw createWorkerError(
        `OBJECT_RETENTION_APPLY_FAILED:${target.bucket}:${target.key}:${reason}`,
        false
      );
    }
  }
}

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

async function enqueueOtsUpgradeRetry(evidenceId: string) {
  const result = await enqueueOtsUpgradeJob(evidenceId);

  logger.info(
    {
      evidenceId,
      enqueued: result.enqueued,
      reason: "reason" in result ? result.reason : null,
    },
    "ots.upgrade.retry_scheduled"
  );

  return result;
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

async function prepareReportArtifacts(
  evidenceId: string,
  otsResult?: OtsStampResult | null,
  options?: {
    allowReported?: boolean;
    refreshReason?: string | null;
    // Phase A0 — surfaced to the integrity-rejection helper so a
    // mismatch's SecurityEvent + structured log carry the originating
    // job context. Optional because the helper degrades gracefully
    // when absent.
    jobId?: string | number | null;
    attempt?: number | null;
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
      otsProofBase64: true,
      otsHash: true,
      otsStatus: true,
      otsCalendar: true,
      otsBitcoinTxid: true,
      otsAnchoredAtUtc: true,
      otsUpgradedAtUtc: true,
      otsFailureReason: true,
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
        storageBucket: true,
        storageKey: true,
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
  const evidenceFunding = await resolveEvidenceFundingSource(evidence.id);
  const evidenceOutputs = resolveEvidenceOutputEntitlements({
    plan: effectivePlan,
    funding: evidenceFunding,
  });

  if (!evidenceOutputs.reportsIncluded) {
    throw createWorkerError("REPORT_NOT_INCLUDED_IN_PLAN", false);
  }

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
const verificationEvidenceFiles: VerificationEvidenceFile[] = [];
const loadedArtifacts: LoadedEvidenceArtifact[] = [];

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

      const head = await headObject({
        bucket: part.storageBucket,
        key: part.storageKey,
      });

      if (!head.sizeBytes || head.sizeBytes <= 0) {
        throw createWorkerError("EVIDENCE_OBJECT_NOT_FOUND", true);
      }

      const body = await getObjectStream({
        bucket: part.storageBucket,
        key: part.storageKey,
      });

      const partBuffer = await streamToBuffer(body as unknown as Readable);
      const partSha = createHash("sha256").update(partBuffer).digest("hex");
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
        buffer: partBuffer,
        sha256: partSha,
        mimeType: part.mimeType ?? null,
        sizeBytes: Number(part.sizeBytes ?? BigInt(partBuffer.length)),
        originalFileName: part.originalFileName ?? null,
        partIndex: part.partIndex,
        storageBucket: part.storageBucket,
        storageKey: part.storageKey,
        storageRegion: part.storageRegion ?? null,
        storageObjectLockMode: part.storageObjectLockMode ?? null,
        storageObjectLockRetainUntilUtc:
          part.storageObjectLockRetainUntilUtc?.toISOString() ?? null,
        storageObjectLockLegalHoldStatus:
          part.storageObjectLockLegalHoldStatus ?? null,
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
        buffer: partBuffer,
      });
    }

    if (verificationEvidenceFiles.length === 0) {
      throw createWorkerError("NO_MULTIPART_FILES_FOUND", false);
    }

    storageBucket = parts[0].storageBucket;
    storageKey = parts[0].storageKey;
fileSha256 =
  hashes.length === 1 ? hashes[0] : sha256HexFromStrings(hashes);

const legacySinglePartCompositeSha =
  hashes.length === 1 ? sha256HexFromStrings(hashes) : null;

if (
  fileSha256 !== evidence.fileSha256 &&
  legacySinglePartCompositeSha !== evidence.fileSha256
) {
  // Phase A0 — integrity hard-gate. Before we throw, transition the
  // Evidence row to FAILED_HASH_MISMATCH + append the custody
  // rejection event + emit the security event. The throw still moves
  // the BullMQ job to the DLQ (non-retriable) but downstream
  // workflows can no longer accidentally promote the row. The helper
  // is idempotent — a duplicate worker run finds the terminal state
  // and short-circuits.
  await rejectEvidenceIntegrity({
    evidenceId: evidence.id,
    expectedSha256: evidence.fileSha256 ?? null,
    computedSha256: fileSha256,
    source: "worker.report.multipart",
    jobId: options?.jobId ?? null,
    attempt: options?.attempt ?? null,
  });
  throw createWorkerError("EVIDENCE_FILE_SHA256_MISMATCH", false);
}
  } else {
    const head = await headObject({
      bucket: evidence.storageBucket!,
      key: evidence.storageKey!,
    });

    if (!head.sizeBytes || head.sizeBytes <= 0) {
      throw createWorkerError("EVIDENCE_OBJECT_NOT_FOUND", true);
    }

    const body = await getObjectStream({
      bucket: evidence.storageBucket!,
      key: evidence.storageKey!,
    });

    const singleEvidenceBuffer = await streamToBuffer(
      body as unknown as Readable
    );

    const singleSha256 = createHash("sha256")
      .update(singleEvidenceBuffer)
      .digest("hex");

    if (singleSha256 !== evidence.fileSha256) {
      // Phase A0 — integrity hard-gate (single-file path). See the
      // multipart branch above for the contract: status flip + custody
      // event + security event happen before the throw so a tampered
      // (or storage-mutated) object never produces a Report.
      await rejectEvidenceIntegrity({
        evidenceId: evidence.id,
        expectedSha256: evidence.fileSha256 ?? null,
        computedSha256: singleSha256,
        source: "worker.report.single_file",
        jobId: options?.jobId ?? null,
        attempt: options?.attempt ?? null,
      });
      throw createWorkerError("EVIDENCE_FILE_SHA256_MISMATCH", false);
    }

    fileSha256 = singleSha256;

    verificationEvidenceFiles.push({
      name: basenameFromStorageKey(
        evidence.storageKey,
        `evidence-file.${extensionFromMimeType(evidence.mimeType)}`
      ),
      buffer: singleEvidenceBuffer,
      sha256: singleSha256,
      mimeType: evidence.mimeType ?? null,
      sizeBytes: Number(evidence.sizeBytes ?? BigInt(singleEvidenceBuffer.length)),
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
      buffer: singleEvidenceBuffer,
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
    const extracted = await extractPreviewForAsset({
      kind: artifact.kind,
      mimeType: artifact.mimeType,
      buffer: artifact.buffer,
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
  const verifyUrl = buildVerifyUrl(evidence.id);

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
    tsaStatus: evidence.tsaStatus ?? null,
    tsaFailureReason: evidence.tsaFailureReason ?? null,

    otsProofBase64: otsResult
      ? otsResult.proofBase64
      : evidence.otsProofBase64 ?? null,
    otsHash: otsResult ? otsResult.hash : evidence.otsHash ?? null,
    otsStatus: otsResult ? otsResult.status : evidence.otsStatus ?? null,
    otsCalendar: otsResult ? otsResult.calendar : evidence.otsCalendar ?? null,
    otsBitcoinTxid: otsResult
      ? otsResult.bitcoinTxid
      : evidence.otsBitcoinTxid ?? null,
    otsAnchoredAtUtc:
      otsResult
        ? otsResult.anchoredAtUtc
        : evidence.otsAnchoredAtUtc
        ? evidence.otsAnchoredAtUtc.toISOString()
        : null,
    otsUpgradedAtUtc:
      otsResult
        ? otsResult.upgradedAtUtc
        : evidence.otsUpgradedAtUtc
        ? evidence.otsUpgradedAtUtc.toISOString()
        : null,
    otsFailureReason:
      otsResult
        ? otsResult.status === "FAILED"
          ? otsResult.failureReason
          : null
        : evidence.otsFailureReason ?? null,

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

  const reportBuildParams: ReportBuildParams = {
    evidence: reportEvidencePayload,
    custodyEvents: custodyEventsForReport,
    version: provisionalVersion,
    generatedAtUtc: now.toISOString(),
    buildInfo: env.WORKER_BUILD_INFO ?? null,
    verifyUrl,
    downloadUrl: evidenceDetailUrl,
    externalMode: false,
    mediaIntelligence: reportMediaIntelligence,
    technicalSummary: reportTechnicalSummary,
    acquisition: reportAcquisition,
  };

// Phase A2 — call the signature-aware variant so the Report row
// can persist the explicit pdfSignatureStatus + signedAtUtc +
// signerKeyId + warning. The legacy bytes-only signature
// (`buildReportPdfV2`) is preserved for callers that only need
// the PDF; new code paths use the outcome variant.
const pdfSigningOutcome = await buildReportPdfV2WithSignatureOutcome(reportBuildParams);
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
  try {
    await runReportGeneration(job, command, requestId);
  } catch (error) {
    // Terminal vs retryable is decided by the SAME predicate the queue uses, so
    // the durable row and the queue cannot disagree about whether the intent is
    // still alive.
    if (isRetriableError(error)) {
      await markRequestRetryable({
        requestId: command.requestId,
        terminalReasonCode: toBoundedReasonCode(error),
      });
    } else {
      await markRequestTerminal({
        requestId: command.requestId,
        state: "FAILED_TERMINAL",
        terminalReasonCode: toBoundedReasonCode(error),
      });
    }
    throw error;
  }

  // The artifact the run actually produced, recorded on the request so a
  // replay can return it instead of generating a second one.
  const latest = await prisma.report.findFirst({
    where: { evidenceId: command.evidenceId },
    orderBy: { version: "desc" },
    select: { id: true },
  });
  await markRequestTerminal({
    requestId: command.requestId,
    state: "SUCCEEDED",
    terminalReasonCode: "generated",
    resultReportId: latest?.id ?? null,
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

async function runReportGeneration(
  job: Job<unknown>,
  command: ResolvedReportCommand,
  requestId: string,
) {
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

    if (evidence.status === EvidenceStatus.REPORTED && !forceRegenerate) {
      const existingReport = await prisma.report.findFirst({
        where: { evidenceId },
        orderBy: { version: "desc" },
      });

      if (existingReport) {
        logger.info(ctx, "Report already generated, skipping");
        return;
      }
    }

    let otsData: OtsStampResult | null = null;

    try {
      if (!forceRegenerate && evidence.fingerprintCanonicalJson) {
        const latestReport = await prisma.report.findFirst({
          where: { evidenceId },
          orderBy: { version: "desc" },
          select: { version: true },
        });

        const reportVersion = latestReport ? latestReport.version + 1 : 1;

        otsData = await createOpenTimestamp({
          content: Buffer.from(evidence.fingerprintCanonicalJson, "utf8"),
          filenameStem: `fingerprint-${evidenceId}-v${reportVersion}`,
        });

        logger.info(
          {
            ...ctx,
            otsStatus: otsData.status,
            otsHash: otsData.hash,
          },
          "OpenTimestamp created"
        );
      }
    } catch (otsError) {
      captureException(otsError, {
        ...ctx,
        phase: "ots_stamp_early",
      });

      logger.warn(
        {
          ...ctx,
          err: otsError,
        },
        "OpenTimestamp creation failed, continuing with report generation"
      );
    }

    const prepared = await prepareReportArtifacts(evidenceId, otsData, {
      allowReported: forceRegenerate,
      refreshReason: regenerateReason,
      // Phase A0 — pass job context through so the integrity-rejection
      // helper can tag any SecurityEvent / log with the originating job.
      jobId: job.id ?? null,
      attempt: job.attemptsMade + 1,
    });

    const finalized = await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`
          SELECT pg_advisory_xact_lock(hashtext(${prepared.evidenceId}))
        `;

        const lockedEvidence = await tx.evidence.findFirst({
          where: { id: prepared.evidenceId, deletedAt: null },
          select: {
            id: true,
            ownerUserId: true,
            status: true,
            verificationStatus: true,
            recordedIntegrityVerifiedAtUtc: true,
            reportGeneratedAtUtc: true,
            fileSha256: true,
            fingerprintHash: true,
            signatureBase64: true,
            signingKeyId: true,
            signingKeyVersion: true,
            lockedAt: true,
            verificationPackageVersion: true,
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

        const existingLatestReport = await tx.report.findFirst({
          where: { evidenceId: prepared.evidenceId },
          orderBy: { version: "desc" },
          select: {
            id: true,
            version: true,
            storageBucket: true,
            storageKey: true,
            generatedAtUtc: true,
          },
        });

        if (
          lockedEvidence.status === EvidenceStatus.REPORTED &&
          existingLatestReport &&
          !forceRegenerate
        ) {
          return {
            skipped: true as const,
            existingReportVersion: existingLatestReport.version,
            scheduleOtsUpgrade: false,
            reportVersion: existingLatestReport.version,
            finalizedCustodyEvents: [],
          };
        }

        if (
          lockedEvidence.status !== EvidenceStatus.SIGNED &&
          !(forceRegenerate && lockedEvidence.status === EvidenceStatus.REPORTED)
        ) {
          throw createWorkerError(
            `EVIDENCE_NOT_SIGNED:${lockedEvidence.status}`,
            false
          );
        }

        if (
          !lockedEvidence.fileSha256 ||
          !lockedEvidence.fingerprintHash ||
          !lockedEvidence.signatureBase64 ||
          !lockedEvidence.signingKeyId ||
          lockedEvidence.signingKeyVersion == null
        ) {
          throw createWorkerError(
            "SIGNED_EVIDENCE_CRYPTO_STATE_INCOMPLETE",
            false
          );
        }

        // Phase C #5 — distinct event type for the worker-time identity
        // re-snapshot. The intake-time IDENTITY_SNAPSHOT_RECORDED event is
        // written by the API at evidence creation. Re-using the same event
        // type at report generation made the chain look like a duplicate or
        // tampered audit entry. REPORT_IDENTITY_CONTEXT_RECORDED carries
        // the same payload shape but the distinct semantic of "report-time
        // identity context for the reviewer audit context".
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

        let scheduleOtsUpgrade = false;

        if (!forceRegenerate && otsData) {
          if (otsData.status === "PENDING" || otsData.status === "ANCHORED") {
            await tx.evidence.update({
              where: { id: prepared.evidenceId },
              data: buildOtsEvidenceUpdateData({
                ...otsData,
                existingBitcoinTxid: evidence.otsBitcoinTxid ?? null,
              }),
            });

            await appendCustodyEventTx(tx, {
              evidenceId: prepared.evidenceId,
              eventType: prismaPkg.CustodyEventType.OTS_APPLIED,
              atUtc: new Date(),
              payload: {
                otsStatus: otsData.status,
                otsPhase:
                  otsData.status === "ANCHORED"
                    ? "anchored"
                    : "proof_created",
                hash: otsData.hash,
                calendar: otsData.calendar,
                bitcoinTxid: otsData.bitcoinTxid,
                anchoredAtUtc: otsData.anchoredAtUtc,
                upgradedAtUtc: otsData.upgradedAtUtc,
              } as Prisma.InputJsonValue,
            });

            if (
              otsData.status === "PENDING" ||
              (otsData.status === "ANCHORED" && !otsData.bitcoinTxid)
            ) {
              scheduleOtsUpgrade = true;
            }
          } else if (otsData.status === "FAILED") {
            await tx.evidence.update({
              where: { id: prepared.evidenceId },
              data: buildOtsEvidenceUpdateData({
                ...otsData,
                existingBitcoinTxid: evidence.otsBitcoinTxid ?? null,
              }),
            });

            await appendCustodyEventTx(tx, {
              evidenceId: prepared.evidenceId,
              eventType: prismaPkg.CustodyEventType.OTS_FAILED,
              atUtc: new Date(),
              payload: {
                otsStatus: "FAILED",
                otsPhase: "stamp_failed",
                failureReason: otsData.failureReason,
              } as Prisma.InputJsonValue,
            });
          } else if (otsData.status === "DISABLED") {
            await tx.evidence.update({
              where: { id: prepared.evidenceId },
              data: buildOtsEvidenceUpdateData({
                ...otsData,
                existingBitcoinTxid: evidence.otsBitcoinTxid ?? null,
              }),
            });
          }
        }

        const promotionCustodyEvents = await tx.custodyEvent.findMany({
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
          otsStatus:
            otsData?.status ?? prepared.reportEvidencePayload.otsStatus ?? null,
          otsHash: otsData?.hash ?? prepared.reportEvidencePayload.otsHash ?? null,
          otsAnchoredAtUtc:
            otsData?.anchoredAtUtc ??
            prepared.reportEvidencePayload.otsAnchoredAtUtc ??
            null,
          itemCount: prepared.contentSummary.itemCount,
          multipartItemHashesPresent:
            prepared.contentSummary.itemCount <= 1
              ? true
              : prepared.verificationEvidenceFiles.length > 1 &&
                prepared.verificationEvidenceFiles.every((file) => Boolean(file.sha256)),
          publicKeyPem: prepared.reportEvidencePayload.publicKeyPem as string,
          verifiedAtUtc: prepared.now,
          custodyEvents: promotionCustodyEvents,
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

        await appendCustodyEventTx(tx, {
          evidenceId: prepared.evidenceId,
          eventType: prismaPkg.CustodyEventType.REPORT_GENERATED,
          atUtc: prepared.now,
          payload: {
            phase: "report_generated",
            reportVersion: prepared.version,
            generatedAtUtc: prepared.now.toISOString(),
            verificationStatusSnapshot: effectiveVerificationStatus,
            captureMethodSnapshot: effectiveIdentitySnapshot.captureMethod,
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

        await tx.evidence.update({
          where: { id: prepared.evidenceId },
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

        await appendCustodyEventTx(tx, {
          evidenceId: prepared.evidenceId,
          eventType: prismaPkg.CustodyEventType.REVIEW_READY,
          atUtc: prepared.now,
          payload: {
            reviewerSummaryVersion:
              effectiveIdentitySnapshot.reviewerSummaryVersion,
          } as Prisma.InputJsonValue,
        });

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
        } as const;

        const finalizedCustodyForReport = finalizedCustodyEvents.map((ev) => ({
          sequence: ev.sequence,
          atUtc: ev.atUtc.toISOString(),
          eventType: ev.eventType,
          payloadSummary: summarizePayloadForReport(
            ev.eventType,
            ev.payload,
            finalizedCustodyDisplayContext
          ),
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
        });

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
        // traceability. Identity-only; never drives policy. Wrapped in
        // try/catch so a propagation failure can never break the
        // primary report-generation lifecycle. Trio values are
        // stringified for the S3 metadata block (string-only) and
        // surface NULL as empty string so the metadata key is always
        // present but unambiguously null on legacy rows.
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

        await putObjectBuffer({
          bucket: env.S3_BUCKET,
          key: prepared.reportKey,
          body: finalizedReportPdf,
          contentType: "application/pdf",
          immutable: true,
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
        // Phase O1.5C — bounded report.publish span emitted post-upload.
        await withProovraSpan(PROOVRA_SPAN_NAMES.REPORT_PUBLISH, { "proovra.operation": "report_publish", "proovra.evidence_id": prepared.evidenceId }, () => undefined);

        await applyRetentionOrThrow([
          {
            bucket: env.S3_BUCKET,
            key: prepared.reportKey,
          },
        ]);

        const reportHead = await headObject({
          bucket: env.S3_BUCKET,
          key: prepared.reportKey,
        });

        await tx.report.create({
          data: {
            evidenceId: prepared.evidenceId,
            version: prepared.version,
            storageBucket: env.S3_BUCKET,
            storageKey: prepared.reportKey,
            storageRegion: process.env.S3_REGION?.trim() || null,
            storageObjectLockMode: reportHead.objectLockMode
              ? String(reportHead.objectLockMode)
              : null,
            storageObjectLockRetainUntilUtc:
              reportHead.objectLockRetainUntilDate ?? null,
            storageObjectLockLegalHoldStatus:
              reportHead.objectLockLegalHoldStatus
                ? String(reportHead.objectLockLegalHoldStatus)
                : null,
            generatedAtUtc: prepared.now,
            sizeBytes: BigInt(finalizedReportPdf.length),

            verificationStatusSnapshot: effectiveIdentitySnapshot.verificationStatus,
            identityLevelSnapshot:
              effectiveIdentitySnapshot.identityLevelSnapshot,
            submittedByEmailSnapshot:
              effectiveIdentitySnapshot.submittedByEmail,
            submittedByAuthProviderSnapshot:
              effectiveIdentitySnapshot.submittedByAuthProvider,
            captureMethodSnapshot: effectiveIdentitySnapshot.captureMethod,
            reviewerSummaryVersion:
              effectiveIdentitySnapshot.reviewerSummaryVersion,
            verificationPackageVersion: prepared.verificationPackageIncluded
              ? prepared.version
              : null,

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
            // Backend writes these from the bounded signing outcome
            // so the API + frontend can render artifact trust
            // without inferring from copy.
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

        // Phase A2 — emit a distinct custody event for the PDF
        // signing decision. Distinct from REPORT_GENERATED so the
        // forensic timeline records what trust the artifact carries.
        // SIGNING_UNAVAILABLE rolls into REPORT_PDF_UNSIGNED_OPT_OUT
        // because both are "operator-acknowledged non-signed paths"
        // from the custody-chain perspective; the precise distinction
        // (opt-out vs dev-env) lives on the Report row + API.
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

        return {
          skipped: false as const,
          version: prepared.version,
          reportKey: prepared.reportKey,
          scheduleOtsUpgrade,
          reportVersion: prepared.version,
          finalizedReportEvidencePayload: effectiveReportEvidencePayload,
          effectiveVerificationStatus,
          effectiveRecordedIntegrityVerifiedAtUtc,
          finalizedReportPdf,
          finalizedTrustDecision,
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
      {
        maxWait: 10_000,
        timeout: 120_000,
      }
    );

    let finalizedVerificationZip: Buffer | null = null;
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
});
        // Phase 31.14 — bounded intelligence projection for the
        // verification package. Returns null when no surfaceable
        // data exists OR on any failure — the package builds
        // unchanged in either case (independent of downstream tooling).
        const verificationPackageIntelligence =
          await buildVerificationPackageIntelligence({
            teamId: evidence.teamId ?? null,
            evidenceId: prepared.evidenceId,
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
          await loadProvenanceChainForPackage(
            prepared.evidenceId,
            packageAcquisition?.isIntake === true,
          );

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
          evidenceFiles: prepared.verificationEvidenceFiles,
          reportPdf: finalized.finalizedReportPdf,
          reportFileName: `proovra-verification-report-v${prepared.version}.pdf`,
          fingerprint: prepared.fingerprintCanonicalJson,
signature: evidence.signatureBase64!,
          timestampToken: evidence.tsaTokenBase64 ?? null,
publicKey: finalized.finalizedReportEvidencePayload.publicKeyPem as string,
          // Presentation copy for custody.json / forensic-custody.json: the
          // raw structure enum (MULTIPART_PACKAGE) in the captureMethodSnapshot
          // payload is replaced with the role-safe capture method + a separate
          // structure label. The immutable event hash is preserved.
          custody: finalized.finalizedCustodyEvents.map((e) => ({
            ...e,
            payload: normalizeCustodyEventPayloadForPresentation(
              e.payload,
              packageAcquisition?.isIntake === true,
            ),
          })),
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
        finalizedVerificationZip = finalizedVerificationPackage.buffer;
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
        }
      }
    }

    if (!finalized.skipped && finalizedVerificationZip) {
            try {
        await assertWorkspaceAllowsVerificationPackageArtifact({
          ownerUserId: evidence.ownerUserId,
          teamId: evidence.teamId ?? null,
          incomingBytes: BigInt(finalizedVerificationZip.length),
          // Credit-funded records earn their package on a FREE account.
          evidenceId: evidence.id,
        });

        await putObjectBuffer({
          bucket: env.S3_BUCKET,
          key: prepared.verificationKey,
          body: finalizedVerificationZip,
          contentType: "application/zip",
          immutable: true,
          metadata: {
            evidence_id: prepared.evidenceId,
            report_version: String(prepared.version),
            artifact_type: "verification_package",
          },
          tags: {
            artifact: "verification-package",
            evidenceId: prepared.evidenceId,
            immutable: "true",
          },
        });

        await applyRetentionOrThrow([
          {
            bucket: env.S3_BUCKET,
            key: prepared.verificationKey,
          },
        ]);

        const verificationHead = await headObject({
          bucket: env.S3_BUCKET,
          key: prepared.verificationKey,
        });

        await prisma.$transaction(async (tx) => {
          await tx.verificationPackage.create({
            data: {
              evidenceId: prepared.evidenceId,
              version: prepared.version,
              storageBucket: env.S3_BUCKET,
              storageKey: prepared.verificationKey,
              storageRegion: process.env.S3_REGION?.trim() || null,
              storageObjectLockMode: verificationHead.objectLockMode
                ? String(verificationHead.objectLockMode)
                : null,
              storageObjectLockRetainUntilUtc:
                verificationHead.objectLockRetainUntilDate ?? null,
              storageObjectLockLegalHoldStatus:
                verificationHead.objectLockLegalHoldStatus
                  ? String(verificationHead.objectLockLegalHoldStatus)
                  : null,
              generatedAtUtc: prepared.now,
              sizeBytes: BigInt((finalizedVerificationZip as Buffer).length),
packageType: "full_evidence_package",
trustDecisionSnapshot:
  finalized.finalizedTrustDecision as unknown as Prisma.InputJsonValue,
            },
          });

          await tx.evidence.update({
            where: { id: prepared.evidenceId },
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
            } as Prisma.InputJsonValue,
          });
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
        captureException(verificationError, {
          requestId,
          evidenceId,
          jobId: job.id ?? null,
          phase: "verification_package_store",
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
      }
    }

    if (!finalized.skipped) {
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

    if (!finalized.skipped && finalized.scheduleOtsUpgrade) {
      try {
        await enqueueOtsUpgradeRetry(prepared.evidenceId);
      } catch (upgradeQueueError) {
        captureException(upgradeQueueError, {
          requestId,
          evidenceId,
          jobId: job.id ?? null,
          phase: "ots_upgrade_enqueue",
        });

        logger.error(
          {
            ...withJobContext({
              requestId,
              jobId: job.id,
              evidenceId,
              attempt: job.attemptsMade + 1,
              status: "ots_upgrade_enqueue_failed",
            }),
            err: upgradeQueueError,
          },
          "Failed to enqueue OTS upgrade retry job"
        );
      }
    }

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
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "REPORT_ALREADY_GENERATED"
    ) {
      const durationMs = Date.now() - start;

      logger.info(
        withJobContext({
          requestId,
          jobId: job.id,
          evidenceId,
          attempt: job.attemptsMade + 1,
          durationMs,
          status: "already_completed",
        }),
        "GenerateReportJob skipped because report already exists"
      );
      return;
    }

    // Phase CAPTURE-PLAN-GATE-FIX (P0 Bug 2 + P0 Bug 4) — plan-gate
    // denial is a BUSINESS outcome, not an unhandled server error.
    // The API-side `canPlanGenerateReports(scope.plan)` check in
    // evidence-complete.service.ts is supposed to be the only enqueue
    // gate, so if the worker reaches this branch the most likely
    // cause is either a stale entitlement read or a free-plan user
    // whose UI offered a button it shouldn't have. Either way:
    //   - do NOT capture in Sentry (no debugger pages woken up)
    //   - DO log at warn so operators can see the divergence
    //   - DO still discard + DLQ so the job doesn't keep retrying
    //   - DO record a non-retriable failure incident so the UI can
    //     surface a "Reports not included in your plan" state instead
    //     of polling forever.
    const isPlanDenial =
      error instanceof Error && error.message === "REPORT_NOT_INCLUDED_IN_PLAN";

    if (!isPlanDenial) {
      captureException(error, { requestId, evidenceId, jobId: job.id ?? null });
    } else {
      logger.warn(
        {
          ...withJobContext({
            requestId,
            jobId: job.id,
            evidenceId,
            attempt: job.attemptsMade + 1,
            status: "plan_gate_denied",
          }),
          errorCode: "REPORT_NOT_INCLUDED_IN_PLAN",
        },
        "GenerateReportJob refused: plan does not include reports"
      );
    }

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
      await reportDlqQueue.add(
        "ReportDLQ",
        {
          evidenceId,
          jobId: job.id,
          errorMessage: (error as Error).message,
          errorStack: (error as Error).stack ?? null,
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
      await reportDlqQueue.add(
        "ReportDLQ",
        {
          evidenceId,
          jobId: job.id,
          errorMessage: (error as Error).message,
          errorStack: (error as Error).stack ?? null,
          retriable: true,
        },
        { removeOnComplete: true, removeOnFail: false }
      );

      // Phase IA-reliability — retry-exhausted DLQ move is HIGH. A
      // retry-eligible job exhausted its retry budget; operators can
      // re-queue from the DLQ console, so it isn't terminal in the
      // same way a non-retriable failure is.
      await recordReportFailureIncident({
        evidenceId,
        jobId: job.id,
        error,
        severity: "HIGH",
        retriable: true,
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
      await enqueueEvidencePurgeJob(evidence.id, recheckAt.toISOString());
      logger.info(
        { ...ctx, blockReason: result.reason, rescheduledFor: recheckAt.toISOString() },
        "PurgeDeletedEvidenceJob rescheduled: destruction is not yet permitted",
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

/**
 * PHASE 12 — POINT 5: the worker's report producer.
 *
 * It no longer forwards `{ evidenceId, forceRegenerate }` to a queue. It
 * persists a `ReportGenerationRequest` through the ONE writer both services
 * share, and enqueues that row's id. A caller that wants a regeneration is
 * recording an authorization decision in the database, not setting a flag on a
 * message.
 */
export async function enqueueReportJob(
  evidenceId: string,
  options?: {
    forceRegenerate?: boolean;
    regenerateReason?: string | null;
    purpose?: ReportGenerationPurpose;
    machineId?: string;
  }
): Promise<{ enqueued: boolean; requestId?: string; reason?: string }> {
  return requestReportGenerationFromWorker({
    evidenceId,
    purpose: options?.purpose ?? "lifecycle_recovery",
    forceRegenerate: options?.forceRegenerate === true,
    regenerateReason: options?.regenerateReason ?? null,
    machineId: options?.machineId ?? "worker",
    enqueue: (requestId) => enqueueReportGenerationRequest(requestId),
  });
}
