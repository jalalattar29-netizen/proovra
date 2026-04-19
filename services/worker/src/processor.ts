import type { Job } from "bullmq";
import type { Readable } from "node:stream";
import * as prismaPkg from "@prisma/client";
import type {
  Prisma,
  CertificationType,
  CertificationStatus,
} from "@prisma/client";
import {
  CertificationType as PrismaCertificationType,
  CertificationStatus as PrismaCertificationStatus,
} from "@prisma/client";
import {
  extractPreviewForAsset,
  type ExtractedPreview,
} from "./preview/extract.js";
import {
  assertWorkspaceAllowsReportArtifact,
  assertWorkspaceAllowsVerificationPackageArtifact,
  resolveEffectivePlanForEvidence,
} from "./workspace-billing.js";
import {
  canPlanGenerateReports,
  canPlanGenerateVerificationPackage,
} from "@proovra/shared-billing";
import {
  type EvidenceAssetKind as ReportEvidenceAssetKind,
  type EvidenceContentSummary as ReportEvidenceContentSummary,
  type EvidenceDisplayDescriptor as ReportEvidenceDisplayDescriptor,
  type EvidencePreviewPolicy as ReportPreviewPolicy,
  type EvidenceContentAccessPolicy,
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
import { appendCustodyEventTx } from "./custody-events.js";
import { appendWorkerAnalyticsEvent } from "./analytics-events.js";
import { prisma } from "./db.js";
import { env } from "./config.js";
import { logger, withJobContext } from "./logger.js";
import {
  applyDefaultObjectRetention,
  deleteObject,
  getObjectStream,
  headObject,
  putObjectBuffer,
} from "./storage.js";
import { createHash, randomUUID } from "node:crypto";
import { buildReportPdf } from "./pdf/report.js";
import {
  enqueueEvidencePurgeJob,
  enqueueReportJob as enqueueReportJobOnQueue,
  otsUpgradeQueue,
  reportDlqQueue,
} from "./queue.js";
import { captureException } from "./sentry.js";
import { createVerificationPackage } from "./verification-package.js";
import { createOpenTimestamp, type OtsStampResult } from "./ots.service.js";
import { appendWorkerAuditLog } from "./platform-audit-append.js";

type GenerateReportJobData = {
  evidenceId: string;
  forceRegenerate?: boolean;
  regenerateReason?: string | null;
};

type PurgeDeletedEvidenceJobData = {
  evidenceId: string;
};

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
  publicBaseUrl: string | null;
  configured: boolean;
  published: boolean;
  anchorHash: string | null;
  receiptId: string | null;
  transactionId: string | null;
  publicUrl: string | null;
  anchoredAtUtc: string | null;
};

type PreparedReportArtifacts = {
  reportPdf: Buffer;
  verificationZip: Buffer | null;
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
  anchorSummary: ReportAnchorSummary | null;

  reportEvidencePayload: Parameters<typeof buildReportPdf>[0]["evidence"];
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

function buildVerifyUrl(evidenceId: string): string {
  const base = envValue(
    "REPORT_VERIFY_BASE_URL",
    "https://app.proovra.com/verify"
  ).replace(/\/+$/, "");

  return `${base}/${encodeURIComponent(evidenceId)}`;
}

function buildEvidenceDetailUrl(evidenceId: string): string {
  const base = envValue("REPORT_APP_BASE_URL", "https://app.proovra.com").replace(
    /\/+$/,
    ""
  );
  return `${base}/evidence/${encodeURIComponent(evidenceId)}`;
}

function shortHash(
  value: string | null | undefined,
  head = 12,
  tail = 10
): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return null;
  if (text.length <= head + tail + 3) return text;
  return `${text.slice(0, head)}…${text.slice(-tail)}`;
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

function summarizePayloadForReport(eventType: string, payload: unknown): string {
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

    case "UPLOAD_STARTED": {
      const uploadMode =
        normalizePayloadPrimitive(obj.mode) ??
        normalizePayloadPrimitive(obj.uploadKind);
      return ["Upload session started", uploadMode ? `Mode: ${uploadMode}` : null]
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
      const hash = shortHash(normalizePayloadPrimitive(obj.fileSha256));

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
      const fingerprintHash = shortHash(
        normalizePayloadPrimitive(obj.fingerprintHash)
      );
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
      const reason = normalizePayloadPrimitive(obj.tsaFailureReason);
      return [
        "Timestamp request failed",
        tsaStatus ? `Status: ${tsaStatus}` : null,
        reason ? `Reason: ${reason}` : null,
      ]
        .filter(Boolean)
        .join(" • ");
    }

    case "OTS_APPLIED": {
      const otsStatus = normalizePayloadPrimitive(obj.otsStatus);
      const bitcoinTxid = shortHash(normalizePayloadPrimitive(obj.bitcoinTxid));
      const calendar = normalizePayloadPrimitive(obj.calendar);
      return [
        "OpenTimestamp proof created",
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

      return [
        reportVersion
          ? `Verification report generated • Version: ${reportVersion}`
          : "Verification report generated.",
        verificationStatusSnapshot
          ? `Verification: ${verificationStatusSnapshot}`
          : null,
        captureMethodSnapshot ? `Capture: ${captureMethodSnapshot}` : null,
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
      return "Evidence record locked.";

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

function createWorkerError(code: string, retriable: boolean): WorkerError {
  const err = new Error(code) as WorkerError;
  err.code = code;
  err.retriable = retriable;
  return err;
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

async function deleteObjectIfExists(params: { bucket: string; key: string }) {
  try {
    await deleteObject({
      bucket: params.bucket,
      key: params.key,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message.toLowerCase() : "unknown_error";

    if (
      message.includes("not found") ||
      message.includes("no such key") ||
      message.includes("nosuchkey") ||
      message.includes("404")
    ) {
      return;
    }

    throw error;
  }
}

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

function resolveReportContentAccessPolicy(): EvidenceContentAccessPolicy {
  const mode = (process.env.REPORT_CONTENT_ACCESS_MODE ?? "full_access")
    .trim()
    .toLowerCase();

  if (mode === "metadata_only") {
    return {
      mode: "metadata_only",
      allowContentView: false,
      allowDownload: false,
    };
  }

  if (mode === "preview_only") {
    return {
      mode: "preview_only",
      allowContentView: true,
      allowDownload: false,
    };
  }

  return {
    mode: "full_access",
    allowContentView: true,
    allowDownload: true,
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
  return `Verification materials for this ${params.kind} item include the recorded digest, custody linkage, timestamping state, and any published anchoring records associated with the preserved evidence record.`;
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
  };
  parts: Array<{
    id: string;
    partIndex: number;
    originalFileName: string | null;
    mimeType: string | null;
    sizeBytes: bigint | number | null;
    sha256: string | null;
    durationMs: number | null;
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
  const multipart = params.parts.length > 0;
  const accessPolicy = params.accessPolicy;
  const canExposeContent = accessPolicy.allowContentView;
  const canDownload = accessPolicy.allowDownload;

  const items: ReportEvidenceAsset[] = multipart
    ? params.parts.map((part) => {
        const kind = detectEvidenceAssetKind(part.mimeType);
        const sizeBytes = part.sizeBytes != null ? String(part.sizeBytes) : null;
        const isPrimary =
          params.evidence.storageBucket === part.storageBucket &&
          params.evidence.storageKey === part.storageKey;

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
              ? "primary_preview"
              : "secondary_preview"
            : canDownload
              ? "download_only"
              : "metadata_only",
          embedPreference: canPreviewThisItem
            ? resolveEmbedPreference(kind)
            : "metadata_only",
          artifactRole: isPrimary
            ? "primary_evidence"
            : canPreviewThisItem
              ? "supporting_evidence"
              : "attachment",
          originalPreservationNote: buildOriginalPreservationNote({ label, kind }),
          reviewerRepresentationLabel: buildReviewerRepresentationLabel({
            kind,
            isPrimary,
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
                ? "primary_preview"
                : canDownload
                  ? "download_only"
                  : "metadata_only",
              embedPreference: singlePreviewable
                ? resolveEmbedPreference(singleKind)
                : "metadata_only",
              artifactRole: "primary_evidence",
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

  if (items.length > 1 && !items.some((item) => item.isPrimary)) {
    items[0] = {
      ...items[0],
      isPrimary: true,
      previewRole:
        items[0]?.previewRole === "metadata_only"
          ? "metadata_only"
          : "primary_preview",
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
      structure: multipart ? "multipart" : "single",
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
  const publicBaseUrl = process.env.ANCHOR_PUBLIC_BASE_URL?.trim() || null;

  const anchor = await prisma.evidenceAnchor.findUnique({
    where: { evidenceId },
    select: {
      mode: true,
      provider: true,
      anchorHash: true,
      receiptId: true,
      transactionId: true,
      publicUrl: true,
      anchoredAtUtc: true,
    },
  });

  if (!anchor) {
    return {
      mode,
      provider,
      publicBaseUrl,
      configured: Boolean(provider),
      published: false,
      anchorHash: null,
      receiptId: null,
      transactionId: null,
      publicUrl: null,
      anchoredAtUtc: null,
    };
  }

  return {
    mode: normalizeAnchorMode(anchor.mode),
    provider: anchor.provider ?? provider,
    publicBaseUrl,
    configured: Boolean(anchor.provider ?? provider),
    published: true,
    anchorHash: anchor.anchorHash ?? null,
    receiptId: anchor.receiptId ?? null,
    transactionId: anchor.transactionId ?? null,
    publicUrl: anchor.publicUrl ?? null,
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
  const jobId = `ots-upgrade-${evidenceId}`;
  const existing = await otsUpgradeQueue.getJob(jobId);

  if (existing) {
    const state = await existing.getState();
    if (
      state === "waiting" ||
      state === "delayed" ||
      state === "active" ||
      state === "prioritized"
    ) {
      return { enqueued: false, reason: `job_${state}` };
    }
  }

  await otsUpgradeQueue.add(
    "UpgradeOts",
    { evidenceId },
    {
      jobId,
      delay: 5 * 60 * 1000,
      attempts: 20,
      backoff: { type: "exponential", delay: 60_000 },
      removeOnComplete: 100,
      removeOnFail: false,
    }
  );

  return { enqueued: true };
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

function deriveCaptureMethod(params: {
  multipart: boolean;
  mimeType: string | null;
  existingCaptureMethod: prismaPkg.CaptureMethod | null;
}): prismaPkg.CaptureMethod {
  if (params.existingCaptureMethod) return params.existingCaptureMethod;
  if (params.multipart) return prismaPkg.CaptureMethod.MULTIPART_PACKAGE;

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
      latestReportVersion: true,
      createdAt: true,
      uploadedAtUtc: true,
      signedAtUtc: true,
      capturedAtUtc: true,
      reportGeneratedAtUtc: true,
      deviceTimeIso: true,
      lat: true,
      lng: true,
      accuracyMeters: true,
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

  if (!canPlanGenerateReports(effectivePlan)) {
    throw createWorkerError("REPORT_NOT_INCLUDED_IN_PLAN", false);
  }

  let workspaceTeam:
    | {
        id: string;
        name: string;
        legalName: string | null;
        evidenceWorkspaceLabel: string | null;
        verificationState: prismaPkg.OrganizationVerificationState | null;
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
    fileSha256 = sha256HexFromStrings(hashes);

    if (fileSha256 !== evidence.fileSha256) {
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

  const reportContentAccessPolicy = resolveReportContentAccessPolicy();

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
    },
    parts: parts.map((part) => ({
      id: part.id,
      partIndex: part.partIndex,
      originalFileName: part.originalFileName,
      mimeType: part.mimeType,
      sizeBytes: part.sizeBytes,
      sha256: part.sha256,
      durationMs: part.durationMs,
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
  const lastEventHash =
    custodyEvents.length > 0
      ? custodyEvents[custodyEvents.length - 1]?.eventHash ?? null
      : null;

  const reportGeneratedEventSequence =
    (custodyEvents[custodyEvents.length - 1]?.sequence ?? 0) + 1;
  const verificationPackageEventSequence = reportGeneratedEventSequence + 1;
  const reviewReadyEventSequence = verificationPackageEventSequence + 1;

  const refreshReason = options?.refreshReason?.trim() || null;

  const anchorMode = normalizeAnchorMode(process.env.ANCHOR_MODE);
  const anchorProvider = process.env.ANCHOR_PROVIDER?.trim() || null;
  const anchorPublicBaseUrl =
    process.env.ANCHOR_PUBLIC_BASE_URL?.trim() || null;

  const anchorPayload =
    anchorMode === "off"
      ? null
      : {
          version: 1 as const,
          evidenceId: evidence.id,
          reportVersion: provisionalVersion,
          fileSha256,
          fingerprintHash,
          lastEventHash,
          anchorHash: sha256HexFromStrings([
            evidence.id,
            String(provisionalVersion),
            fileSha256,
            fingerprintHash,
            lastEventHash ?? "",
          ]),
          generatedAtUtc: now.toISOString(),
        };

  const captureMethod = deriveCaptureMethod({
    multipart: parts.length > 0,
    mimeType: evidence.mimeType,
    existingCaptureMethod: evidence.captureMethod ?? null,
  });

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
    captureMethod,
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

  const custodyEventsForReport = [
    ...custodyEvents.map((ev) => ({
      sequence: ev.sequence,
      atUtc: ev.atUtc.toISOString(),
      eventType: ev.eventType,
      payloadSummary: summarizePayloadForReport(ev.eventType, ev.payload),
    })),
    {
      sequence: reportGeneratedEventSequence,
      atUtc: now.toISOString(),
      eventType: "REPORT_GENERATED",
      payloadSummary: summarizePayloadForReport("REPORT_GENERATED", {
        phase: "report_generated",
        reportVersion: provisionalVersion,
        generatedAtUtc: now.toISOString(),
        verificationStatusSnapshot: identitySnapshot.verificationStatus,
        captureMethodSnapshot: identitySnapshot.captureMethod,
        identityLevelSnapshot: identitySnapshot.identityLevelSnapshot,
        ...(refreshReason ? { refreshReason } : {}),
      }),
    },
    {
      sequence: verificationPackageEventSequence,
      atUtc: now.toISOString(),
      eventType: "VERIFICATION_PACKAGE_GENERATED",
      payloadSummary: summarizePayloadForReport("VERIFICATION_PACKAGE_GENERATED", {
        version: provisionalVersion,
        packageType: "full_evidence_package",
      }),
    },
    {
      sequence: reviewReadyEventSequence,
      atUtc: now.toISOString(),
      eventType: "REVIEW_READY",
      payloadSummary: summarizePayloadForReport("REVIEW_READY", {
        reviewerSummaryVersion: provisionalVersion,
      }),
    },
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
    {
      sequence: reportGeneratedEventSequence,
      atUtc: now.toISOString(),
      eventType: "REPORT_GENERATED",
      payload: {
        phase: "report_generated",
        reportVersion: provisionalVersion,
        generatedAtUtc: now.toISOString(),
        verificationStatusSnapshot: identitySnapshot.verificationStatus,
        captureMethodSnapshot: identitySnapshot.captureMethod,
        identityLevelSnapshot: identitySnapshot.identityLevelSnapshot,
        ...(refreshReason ? { refreshReason } : {}),
      } as Prisma.InputJsonValue,
      prevEventHash: lastEventHash,
      eventHash: null,
    },
    {
      sequence: verificationPackageEventSequence,
      atUtc: now.toISOString(),
      eventType: "VERIFICATION_PACKAGE_GENERATED",
      payload: {
        version: provisionalVersion,
        packageType: "full_evidence_package",
      } as Prisma.InputJsonValue,
      prevEventHash: null,
      eventHash: null,
    },
    {
      sequence: reviewReadyEventSequence,
      atUtc: now.toISOString(),
      eventType: "REVIEW_READY",
      payload: {
        reviewerSummaryVersion: provisionalVersion,
      } as Prisma.InputJsonValue,
      prevEventHash: null,
      eventHash: null,
    },
  ];

  const verificationPackageIncluded =
    canPlanGenerateVerificationPackage(effectivePlan);

  const reportEvidencePayload = {
    id: evidence.id,
    title: resolveEvidenceTitle(evidence.title),
    // Report artifacts snapshot the post-generation lifecycle state as REPORTED.
    status: EvidenceStatus.REPORTED,
    verificationStatus: identitySnapshot.verificationStatus,
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
    lastVerifiedAtUtc: evidence.lastVerifiedAtUtc
      ? evidence.lastVerifiedAtUtc.toISOString()
      : null,
    lastVerifiedSource: evidence.lastVerifiedSource ?? null,
    verificationPackageGeneratedAtUtc: verificationPackageIncluded
      ? now.toISOString()
      : evidence.verificationPackageGeneratedAtUtc
        ? evidence.verificationPackageGeneratedAtUtc.toISOString()
        : null,
    verificationPackageVersion: verificationPackageIncluded
      ? provisionalVersion
      : evidence.verificationPackageVersion ?? null,
    latestReportVersion: provisionalVersion,
    reviewReadyAtUtc: now.toISOString(),
    reviewerSummaryVersion: provisionalVersion,

    capturedAtUtc: evidence.capturedAtUtc?.toISOString() ?? null,
    uploadedAtUtc: evidence.uploadedAtUtc?.toISOString() ?? null,
    signedAtUtc: evidence.signedAtUtc?.toISOString() ?? null,
    reportGeneratedAtUtc: now.toISOString(),
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
    },

    evidenceStructure:
      contentArtifacts.summary.structure === "multipart"
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
    tsaHashAlgorithm: evidence.tsaHashAlgorithm ?? null,
    tsaStatus: evidence.tsaStatus ?? null,
    tsaFailureReason: evidence.tsaFailureReason ?? null,

    otsProofBase64: otsResult?.proofBase64 ?? evidence.otsProofBase64 ?? null,
    otsHash: otsResult?.hash ?? evidence.otsHash ?? null,
    otsStatus: otsResult?.status ?? evidence.otsStatus ?? null,
    otsCalendar: otsResult?.calendar ?? evidence.otsCalendar ?? null,
    otsBitcoinTxid: otsResult?.bitcoinTxid ?? evidence.otsBitcoinTxid ?? null,
    otsAnchoredAtUtc:
      otsResult?.anchoredAtUtc ??
      (evidence.otsAnchoredAtUtc
        ? evidence.otsAnchoredAtUtc.toISOString()
        : null),
    otsUpgradedAtUtc:
      otsResult?.upgradedAtUtc ??
      (evidence.otsUpgradedAtUtc
        ? evidence.otsUpgradedAtUtc.toISOString()
        : null),
    otsFailureReason:
      otsResult?.failureReason ?? evidence.otsFailureReason ?? null,

    anchor: anchorSummary,
    certifications,
  } as Parameters<typeof buildReportPdf>[0]["evidence"];

  const reportPdf = await buildReportPdf({
    evidence: reportEvidencePayload,
    custodyEvents: custodyEventsForReport,
    version: provisionalVersion,
    generatedAtUtc: now.toISOString(),
    buildInfo: env.WORKER_BUILD_INFO ?? null,
    verifyUrl,
    downloadUrl: evidenceDetailUrl,
  });

  let verificationZip: Buffer | null = null;

  if (verificationEvidenceFiles.length > 0 && verificationPackageIncluded) {
    try {
      verificationZip = await createVerificationPackage({
        evidenceFiles: verificationEvidenceFiles,
        reportPdf,
        reportFileName: `proovra-verification-report-v${provisionalVersion}.pdf`,
        fingerprint: fingerprintCanonicalJson,
        signature: signatureBase64,
        timestampToken: evidence.tsaTokenBase64 ?? null,
        publicKey: signingKey.publicKeyPem,
        custody: custodyForVerificationPackage,
        evidenceId: evidence.id,
        reportVersion: provisionalVersion,
        signingKeyId,
        signingKeyVersion,
        anchor: anchorPayload,
        anchorMode,
        anchorProvider,
        anchorPublicBaseUrl,
        certifications,
        metadata: {
          title: display.displayTitle,
          evidenceType: evidence.type,
          evidenceStatus: evidence.status,
          verificationStatus: identitySnapshot.verificationStatus,
          captureMethod: identitySnapshot.captureMethod,
          identityLevelSnapshot: identitySnapshot.identityLevelSnapshot,
          submittedByEmail: identitySnapshot.submittedByEmail,
          submittedByAuthProvider: identitySnapshot.submittedByAuthProvider,
          createdAtUtc: evidence.createdAt.toISOString(),
          capturedAtUtc: evidence.capturedAtUtc?.toISOString() ?? null,
          uploadedAtUtc: evidence.uploadedAtUtc?.toISOString() ?? null,
          signedAtUtc: evidence.signedAtUtc?.toISOString() ?? null,
          reportGeneratedAtUtc: now.toISOString(),
          storageRegion: evidenceStorage.storageRegion,
          storageObjectLockMode: evidenceStorage.storageObjectLockMode,
          storageObjectLockRetainUntilUtc:
            evidenceStorage.storageObjectLockRetainUntilUtc,
          storageObjectLockLegalHoldStatus:
            evidenceStorage.storageObjectLockLegalHoldStatus,
          storageImmutable: evidenceStorage.storageImmutable,
        },
      });
    } catch (verificationError) {
      captureException(verificationError, {
        evidenceId,
        phase: "verification_package_prepare",
      });

      logger.error(
        {
          evidenceId,
          err: verificationError,
        },
        "Verification package generation failed during preparation"
      );
    }
  }

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
    verificationZip,
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
    anchorSummary,
    reportEvidencePayload,
    certifications,
  };
}

export async function processGenerateReport(job: Job<GenerateReportJobData>) {
  const start = Date.now();
  const evidenceId = job.data.evidenceId;
  const forceRegenerate = job.data.forceRegenerate === true;
  const regenerateReason =
    typeof job.data.regenerateReason === "string"
      ? job.data.regenerateReason.trim() || null
      : null;
  const requestId = randomUUID();

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
    });

    await assertWorkspaceAllowsReportArtifact({
      ownerUserId: evidence.ownerUserId,
      teamId: evidence.teamId ?? null,
      incomingBytes: BigInt(prepared.reportPdf.length),
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
            reportGeneratedAtUtc: true,
            fileSha256: true,
            fingerprintHash: true,
            signatureBase64: true,
            signingKeyId: true,
            signingKeyVersion: true,
            lockedAt: true,
            verificationPackageVersion: true,
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

        await putObjectBuffer({
          bucket: env.S3_BUCKET,
          key: prepared.reportKey,
          body: prepared.reportPdf,
          contentType: "application/pdf",
          immutable: true,
          metadata: {
            evidence_id: prepared.evidenceId,
            report_version: String(prepared.version),
            artifact_type: "report_pdf",
          },
          tags: {
            artifact: "report",
            evidenceId: prepared.evidenceId,
            immutable: "true",
          },
        });

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
            sizeBytes: BigInt(prepared.reportPdf.length),

            verificationStatusSnapshot:
              prepared.identitySnapshot.verificationStatus,
            identityLevelSnapshot:
              prepared.identitySnapshot.identityLevelSnapshot,
            submittedByEmailSnapshot:
              prepared.identitySnapshot.submittedByEmail,
            submittedByAuthProviderSnapshot:
              prepared.identitySnapshot.submittedByAuthProvider,
            captureMethodSnapshot: prepared.identitySnapshot.captureMethod,
            reviewerSummaryVersion:
              prepared.identitySnapshot.reviewerSummaryVersion,
            verificationPackageVersion: prepared.verificationZip
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
              prepared.identitySnapshot.workspaceNameSnapshot,
            organizationNameSnapshot:
              prepared.identitySnapshot.organizationNameSnapshot,
            organizationVerifiedSnapshot:
              prepared.identitySnapshot.organizationVerifiedSnapshot,
            recordedIntegrityVerifiedAtUtcSnapshot:
              prepared.reportEvidencePayload.recordedIntegrityVerifiedAtUtc
                ? new Date(
                    prepared.reportEvidencePayload.recordedIntegrityVerifiedAtUtc
                  )
                : null,
            lastVerifiedAtUtcSnapshot:
              prepared.reportEvidencePayload.lastVerifiedAtUtc
                ? new Date(prepared.reportEvidencePayload.lastVerifiedAtUtc)
                : null,
            lastVerifiedSourceSnapshot:
              (prepared.reportEvidencePayload.lastVerifiedSource as
                | prismaPkg.VerificationSource
                | null
                | undefined) ?? null,
            storageImmutableSnapshot:
              prepared.reportEvidencePayload.storageImmutable ?? null,

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
              prepared.reviewGuidance as unknown as Prisma.InputJsonValue,
            limitationsSnapshot:
              prepared.limitations as unknown as Prisma.InputJsonValue,
            anchorSnapshot:
              prepared.anchorSummary as unknown as Prisma.InputJsonValue,
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
          },
        });
        
        await appendCustodyEventTx(tx, {
          evidenceId: prepared.evidenceId,
          eventType: prismaPkg.CustodyEventType.IDENTITY_SNAPSHOT_RECORDED,
          atUtc: prepared.now,
          payload: {
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
            verificationStatusSnapshot:
              prepared.identitySnapshot.verificationStatus,
            captureMethodSnapshot: prepared.identitySnapshot.captureMethod,
            identityLevelSnapshot:
              prepared.identitySnapshot.identityLevelSnapshot,
            ...(regenerateReason ? { refreshReason: regenerateReason } : {}),
          } as Prisma.InputJsonValue,
        });

        let scheduleOtsUpgrade = false;

        if (!forceRegenerate && otsData) {
          if (otsData.status === "PENDING" || otsData.status === "ANCHORED") {
            await tx.evidence.update({
              where: { id: prepared.evidenceId },
              data: {
                otsProofBase64: otsData.proofBase64,
                otsHash: otsData.hash,
                otsStatus: otsData.status,
                otsCalendar: otsData.calendar,
                otsBitcoinTxid: otsData.bitcoinTxid,
                otsAnchoredAtUtc: otsData.anchoredAtUtc
                  ? new Date(otsData.anchoredAtUtc)
                  : null,
                otsUpgradedAtUtc: otsData.upgradedAtUtc
                  ? new Date(otsData.upgradedAtUtc)
                  : null,
                otsFailureReason: null,
              },
            });

            await appendCustodyEventTx(tx, {
              evidenceId: prepared.evidenceId,
              eventType: prismaPkg.CustodyEventType.OTS_APPLIED,
              atUtc: new Date(),
              payload: {
                otsStatus: otsData.status,
                hash: otsData.hash,
                calendar: otsData.calendar,
                bitcoinTxid: otsData.bitcoinTxid,
                anchoredAtUtc: otsData.anchoredAtUtc,
                upgradedAtUtc: otsData.upgradedAtUtc,
              } as Prisma.InputJsonValue,
            });

            if (otsData.status === "PENDING") {
              scheduleOtsUpgrade = true;
            }
          } else if (otsData.status === "FAILED") {
            await tx.evidence.update({
              where: { id: prepared.evidenceId },
              data: {
                otsProofBase64: null,
                otsHash: otsData.hash,
                otsStatus: otsData.status,
                otsCalendar: otsData.calendar,
                otsBitcoinTxid: null,
                otsAnchoredAtUtc: null,
                otsUpgradedAtUtc: null,
                otsFailureReason: otsData.failureReason,
              },
            });

            await appendCustodyEventTx(tx, {
              evidenceId: prepared.evidenceId,
              eventType: prismaPkg.CustodyEventType.OTS_FAILED,
              atUtc: new Date(),
              payload: {
                failureReason: otsData.failureReason,
              } as Prisma.InputJsonValue,
            });
          } else if (otsData.status === "DISABLED") {
            await tx.evidence.update({
              where: { id: prepared.evidenceId },
              data: {
                otsProofBase64: null,
                otsHash: null,
                otsStatus: "DISABLED",
                otsCalendar: null,
                otsBitcoinTxid: null,
                otsAnchoredAtUtc: null,
                otsUpgradedAtUtc: null,
                otsFailureReason: null,
              },
            });
          }
        }

        await tx.evidence.update({
          where: { id: prepared.evidenceId },
          data: {
            status: EvidenceStatus.REPORTED,
            captureMethod: prepared.identitySnapshot.captureMethod,
            identityLevelSnapshot:
              prepared.identitySnapshot.identityLevelSnapshot,
            submittedByEmail: prepared.identitySnapshot.submittedByEmail,
            submittedByAuthProvider:
              prepared.identitySnapshot.submittedByAuthProvider,
            submittedByUserId: prepared.identitySnapshot.submittedByUserId,
            createdByUserId: prepared.identitySnapshot.createdByUserId,
            uploadedByUserId: prepared.identitySnapshot.uploadedByUserId,
            workspaceNameSnapshot:
              prepared.identitySnapshot.workspaceNameSnapshot,
            organizationNameSnapshot:
              prepared.identitySnapshot.organizationNameSnapshot,
            organizationVerifiedSnapshot:
              prepared.identitySnapshot.organizationVerifiedSnapshot,
            latestReportVersion: prepared.version,
            reportGeneratedAtUtc: prepared.now,
            reviewReadyAtUtc: prepared.now,
            reviewerSummaryVersion:
              prepared.identitySnapshot.reviewerSummaryVersion,
          },
        });

        await appendCustodyEventTx(tx, {
          evidenceId: prepared.evidenceId,
          eventType: prismaPkg.CustodyEventType.REVIEW_READY,
          atUtc: prepared.now,
          payload: {
            reviewerSummaryVersion:
              prepared.identitySnapshot.reviewerSummaryVersion,
          } as Prisma.InputJsonValue,
        });

        return {
          skipped: false as const,
          version: prepared.version,
          reportKey: prepared.reportKey,
          scheduleOtsUpgrade,
          reportVersion: prepared.version,
        };
      },
      {
        maxWait: 10_000,
        timeout: 120_000,
      }
    );

    if (!finalized.skipped && prepared.verificationZip) {
      try {
        await assertWorkspaceAllowsVerificationPackageArtifact({
          ownerUserId: evidence.ownerUserId,
          teamId: evidence.teamId ?? null,
          incomingBytes: BigInt(prepared.verificationZip.length),
        });

        await putObjectBuffer({
          bucket: env.S3_BUCKET,
          key: prepared.verificationKey,
          body: prepared.verificationZip,
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
              sizeBytes: BigInt((prepared.verificationZip as Buffer).length),
              packageType: "full_evidence_package",
            },
          });

          await tx.evidence.update({
            where: { id: prepared.evidenceId },
            data: {
              verificationPackageGeneratedAtUtc: prepared.now,
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

function isRetentionStillActive(retainUntilUtc: Date | null | undefined): boolean {
  if (!retainUntilUtc) return false;
  return retainUntilUtc.getTime() > Date.now();
}

export async function processPurgeDeletedEvidence(
  job: Job<PurgeDeletedEvidenceJobData>
) {
  const start = Date.now();
  const evidenceId = job.data.evidenceId;
  const requestId = randomUUID();

  const ctx = withJobContext({
    requestId,
    jobId: job.id,
    evidenceId,
    attempt: job.attemptsMade + 1,
    status: "purging",
  });

  logger.info(ctx, "PurgeDeletedEvidenceJob started");

  try {
    const evidence = await prisma.evidence.findUnique({
      where: { id: evidenceId },
select: {
  id: true,
  ownerUserId: true,
  deletedAt: true,
  deleteScheduledForUtc: true,
  archivedAt: true,
  lockedAt: true,
  storageBucket: true,
  storageKey: true,
  storageObjectLockMode: true,
  storageObjectLockRetainUntilUtc: true,
},
    });

    if (!evidence) {
      logger.info(
        ctx,
        "PurgeDeletedEvidenceJob skipped because evidence does not exist"
      );
      return;
    }

    if (!evidence.deletedAt || !evidence.deleteScheduledForUtc) {
      logger.info(
        ctx,
        "PurgeDeletedEvidenceJob skipped because evidence is not pending deletion"
      );
      return;
    }

    if (evidence.archivedAt) {
      logger.info(ctx, "PurgeDeletedEvidenceJob skipped because evidence is archived");
      return;
    }

    if (evidence.lockedAt) {
      logger.info(ctx, "PurgeDeletedEvidenceJob skipped because evidence is locked");
      return;
    }

    const retentionUntilUtc = evidence.storageObjectLockRetainUntilUtc;

    if (retentionUntilUtc && isRetentionStillActive(retentionUntilUtc)) {
      const retentionUntilIso = retentionUntilUtc.toISOString();

      await enqueueEvidencePurgeJob(
        evidence.id,
        retentionUntilIso
      );

      logger.info(
        {
          ...ctx,
          retentionUntilUtc: retentionUntilIso,
        },
        "PurgeDeletedEvidenceJob rescheduled because storage retention is still active"
      );
      return;
    }

    const now = new Date();
    if (evidence.deleteScheduledForUtc.getTime() > now.getTime()) {
      await enqueueEvidencePurgeJob(
        evidence.id,
        evidence.deleteScheduledForUtc.toISOString()
      );

      logger.info(
        {
          ...ctx,
          rescheduledFor: evidence.deleteScheduledForUtc.toISOString(),
        },
        "PurgeDeletedEvidenceJob rescheduled because delete date is still in the future"
      );
      return;
    }

const [parts, reports, verificationPackages] = await Promise.all([
  prisma.evidencePart.findMany({
    where: { evidenceId: evidence.id },
    select: {
      id: true,
      storageBucket: true,
      storageKey: true,
      storageObjectLockRetainUntilUtc: true,
    },
  }),
  prisma.report.findMany({
    where: { evidenceId: evidence.id },
    select: {
      id: true,
      storageBucket: true,
      storageKey: true,
      storageObjectLockRetainUntilUtc: true,
    },
  }),
  prisma.verificationPackage.findMany({
    where: { evidenceId: evidence.id },
    select: {
      id: true,
      storageBucket: true,
      storageKey: true,
      storageObjectLockRetainUntilUtc: true,
    },
  }),
]);

const artifactRetentionDates = [
  evidence.storageObjectLockRetainUntilUtc ?? null,
  ...parts.map((item) => item.storageObjectLockRetainUntilUtc ?? null),
  ...reports.map((item) => item.storageObjectLockRetainUntilUtc ?? null),
  ...verificationPackages.map(
    (item) => item.storageObjectLockRetainUntilUtc ?? null
  ),
].filter((value): value is Date => value instanceof Date);

const latestRetentionUntilUtc =
  artifactRetentionDates.length > 0
    ? new Date(
        Math.max(...artifactRetentionDates.map((value) => value.getTime()))
      )
    : null;

if (latestRetentionUntilUtc && isRetentionStillActive(latestRetentionUntilUtc)) {
  await enqueueEvidencePurgeJob(
    evidence.id,
    latestRetentionUntilUtc.toISOString()
  );

  logger.info(
    {
      ...ctx,
      retentionUntilUtc: latestRetentionUntilUtc.toISOString(),
    },
    "PurgeDeletedEvidenceJob rescheduled because one or more stored artifacts are still under retention"
  );
  return;
}

    if (evidence.storageBucket && evidence.storageKey) {
      await deleteObjectIfExists({
        bucket: evidence.storageBucket,
        key: evidence.storageKey,
      });
    }

    for (const part of parts) {
      await deleteObjectIfExists({
        bucket: part.storageBucket,
        key: part.storageKey,
      });
    }

    for (const report of reports) {
      await deleteObjectIfExists({
        bucket: report.storageBucket,
        key: report.storageKey,
      });
    }

    for (const pkg of verificationPackages) {
      await deleteObjectIfExists({
        bucket: pkg.storageBucket,
        key: pkg.storageKey,
      });
    }

    await prisma.$transaction(async (tx) => {
      await appendCustodyEventTx(tx, {
        evidenceId: evidence.id,
        eventType: prismaPkg.CustodyEventType.EVIDENCE_PURGED,
        atUtc: now,
        payload: {
          purgedAtUtc: now.toISOString(),
          deletedAtUtc: evidence.deletedAt?.toISOString() ?? null,
        } as Prisma.InputJsonValue,
      });

      await tx.verificationView.deleteMany({
        where: { evidenceId: evidence.id },
      });

      await tx.verificationPackage.deleteMany({
        where: { evidenceId: evidence.id },
      });

      await tx.report.deleteMany({
        where: { evidenceId: evidence.id },
      });

      await tx.evidencePart.deleteMany({
        where: { evidenceId: evidence.id },
      });

      await tx.evidenceAnchor.deleteMany({
        where: { evidenceId: evidence.id },
      });

      await tx.evidenceCertification.deleteMany({
        where: { evidenceId: evidence.id },
      });

      await tx.custodyEvent.deleteMany({
        where: { evidenceId: evidence.id },
      });

      await tx.evidence.delete({
        where: { id: evidence.id },
      });
    });

    appendWorkerAuditLog({
      userId: evidence.ownerUserId,
      action: "evidence.purged",
      category: "evidence",
      severity: "warning",
      source: "worker_purge",
      outcome: "success",
      resourceType: "evidence",
      resourceId: evidence.id,
      requestId,
      metadata: {
        evidenceId: evidence.id,
        deletedAtUtc: evidence.deletedAt.toISOString(),
        purgedAtUtc: now.toISOString(),
      },
    }).catch(() => null);

    const durationMs = Date.now() - start;

    logger.info(
      {
        ...withJobContext({
          requestId,
          jobId: job.id,
          evidenceId,
          attempt: job.attemptsMade + 1,
          durationMs,
          status: "purged",
        }),
      },
      "PurgeDeletedEvidenceJob completed"
    );
  } catch (error) {
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
      "PurgeDeletedEvidenceJob failed"
    );

    throw error;
  }
}

export async function enqueueReportJob(
  evidenceId: string,
  options?: {
    forceRegenerate?: boolean;
    regenerateReason?: string | null;
  }
) {
  return enqueueReportJobOnQueue(evidenceId, options);
}
