import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  CAPTURE_LOCATION_CONTEXT_DESCRIPTION,
  CAPTURE_LOCATION_LEGAL_BOUNDARY,
  CAPTURE_LOCATION_SOURCE_LABEL,
  CAPTURE_LOCATION_STATUS_LABEL,
  buildCaptureLocationExternalMapUrl,
  buildEvidenceTrustDecision,
  compareReviewerArtifactRolePriority,
  getReviewerArtifactRoleLabel,
  getReviewerEvidenceTypeLabel,
  getReviewerUploadModeLabel,
  deriveAnchorSemantics,
  hasCaptureLocationMetadata,
  isPrimaryReviewerArtifactRole,
  maskPublicEmailsInText,
  resolveReviewerArtifactRole,
  resolveEffectiveOtsStatus,
  type EvidenceIntelligence,
  type ReviewerArtifactRole,
  type ReviewerArtifactRoleSource,
  type TrustDecision,
  type VerificationPackageMetadata,
} from "@proovra/shared";
import {
  type EvidenceAssetKind as PublicEvidenceAssetKind,
  type EvidenceContentSummary as PublicEvidenceContentSummary,
  type EvidencePreviewPolicy as PublicPreviewPolicy,
  type EvidenceContentAccessPolicy as PublicVerifyContentAccessPolicy,
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
  resolveEvidenceContentAccessPolicyForSurface,
  buildEvidencePreviewPolicy,
} from "@proovra/shared-evidence-presentation";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { getAuthUserId } from "../auth.js";
import { requireLegalAcceptance } from "../middleware/require-legal-acceptance.js";
import { createEvidence } from "../services/evidence.service.js";
import { completeEvidence } from "../services/evidence-complete.service.js";
import type { Prisma } from "@prisma/client";
import * as prismaPkg from "@prisma/client";
import { CertificationType as PrismaCertificationType } from "@prisma/client";
import { prisma } from "../db.js";
import { validateUploadedFile } from "../services/security/file-validation.service.js";
import {
  presignGetObject,
  presignPutObject,
  headObject,
  getObjectRange,
} from "../storage.js";
import { verifyJwt } from "../services/jwt.js";
import { enforceRateLimit } from "../services/rate-limit.js";
// Phase A.1D — explicit retry/regenerate path for report artifacts.
// The same enqueue function the evidence-complete service already uses
// on first finalize, surfaced as an audited owner-only mutation.
import { enqueueGenerateReportJob } from "../queue/report-queue.js";
import {
  appendCustodyEvent,
  evaluateCustodyChain,
  classifyCustodyEventType,
} from "../services/custody-events.service.js";
import { buildEvidenceIntelligence } from "../services/evidence-intelligence.service.js";
import {
  attestEvidenceCertification,
  listEvidenceCertifications,
  requestEvidenceCertification,
  revokeEvidenceCertification,
} from "../services/evidence-certification.service.js";
import { appendPlatformAuditLog } from "../services/platform-audit-log.service.js";
import { ed25519VerifyHexSignature, sha256Hex } from "../crypto.js";
import { writeAnalyticsEvent } from "../services/analytics-event.service.js";
import { readBillingOverview } from "../services/billing-overview.service.js";
import { createAiProvider } from "../services/ai/ai-provider.js";
import { AiCostGuard } from "../services/ai/ai-cost-guard.js";
import { AI_LEGAL_DISCLAIMER } from "../services/ai/ai-policy.js";
import { AiTask } from "../services/ai/ai-types.js";
import {
  appendReviewerAuditEvent,
  listReviewerAuditEvents,
} from "../services/evidence-review/reviewer-audit.service.js";
import {
  getEvidenceReviewerWorkflowSummary,
  listEvidenceReviewerWorkflowEvents,
  upsertEvidenceReviewerWorkflow,
} from "../services/evidence-review/reviewer-workflow.service.js";
import {
  createEvidenceRelationship,
  deleteEvidenceRelationship,
  listEvidenceRelationships,
  updateEvidenceRelationship,
} from "../services/evidence-review/relationship-summary.service.js";
import { listEvidenceArtifacts } from "../services/evidence-review/artifact-history.service.js";
import { buildEvidenceArtifactStatus } from "../services/evidence-artifact-status.service.js";
import { buildEvidenceReviewGovernance } from "../services/evidence-review/governance.service.js";
import { buildTrustDecisionConsistency } from "../services/trust-decision-consistency.service.js";

const EvidenceTypeSchema = prismaPkg.EvidenceType
  ? z.nativeEnum(prismaPkg.EvidenceType)
  : z.enum(["PHOTO", "VIDEO", "AUDIO", "DOCUMENT"]);

const JsonValueSchema: z.ZodType<Prisma.JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ])
);

const CreateEvidenceBody = z.object({
  type: EvidenceTypeSchema,
  mimeType: z.string().min(1).max(128).optional(),
  internalNotes: z.string().trim().max(4000).optional(),
  originalFileName: z.string().trim().min(1).max(255).optional(),
  captureFileName: z.string().trim().min(1).max(255).optional(),
  deviceTimeIso: z.string().min(1).max(64).optional(),
  checksumSha256Base64: z.string().min(1).max(128).optional(),
  contentMd5Base64: z.string().min(1).max(128).optional(),
  intakePlanJson: JsonValueSchema.optional(),
  // Optional: link this Evidence to an existing CaptureSession draft so that
  // the draft is moved to FINALIZED status and the audit trail is preserved.
  captureSessionId: z.string().uuid().optional(),
  gps: z
    .object({
      lat: z.number().finite().min(-90).max(90),
      lng: z.number().finite().min(-180).max(180),
      accuracyMeters: z.number().finite().min(0).max(1_000_000).optional(),
    })
    .optional(),
});

const ClaimBody = z.object({
  guestToken: z.string().min(1).optional(),
  evidenceIds: z.array(z.string().uuid()).optional(),
});

const LockBody = z.object({
  locked: z.boolean().optional().default(true),
});

const CreatePartBody = z.object({
  partIndex: z.number().int().min(0),
  mimeType: z.string().min(1).max(128).optional(),
  originalFileName: z.string().trim().min(1).max(255).optional(),
  durationMs: z.number().int().positive().optional(),
  checksumSha256Base64: z.string().min(1).max(128).optional(),
  contentMd5Base64: z.string().min(1).max(128).optional(),
  privateRole: z.string().trim().min(1).max(120).optional(),
  privateNote: z.string().trim().max(1000).optional(),
  checklistStepId: z.string().trim().min(1).max(120).optional(),
  sourceLabel: z.string().trim().min(1).max(120).optional(),
  clientSignals: JsonValueSchema.optional(),
});

const UpdateEvidenceLabelBody = z.object({
  label: z.string().trim().min(1).max(160),
});

const RestoreDeletedEvidenceBody = z.object({
  restore: z.boolean().optional().default(true),
});

const SavedViewFiltersSchema = z.object({
  search: z.string().max(160).optional().default(""),
  scope: z.enum(["active", "archived", "deleted", "locked"]).optional().default("active"),
  status: z.string().max(64).optional().default("all"),
  type: z.string().max(64).optional().default("all"),
  review: z.string().max(64).optional().default("all"),
  exportReadiness: z.string().max(64).optional().default("all"),
  caseAssignment: z.string().max(64).optional().default("all"),
  retention: z.string().max(64).optional().default("all"),
  sort: z.string().max(64).optional().default("newest"),
});

const CreateSavedViewBody = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(400).optional().nullable(),
  teamId: z.string().uuid().optional().nullable(),
  scope: z.enum(["active", "archived", "deleted", "locked"]),
  filters: SavedViewFiltersSchema,
  sortKey: z.string().trim().max(64).optional().nullable(),
  isDefault: z.boolean().optional().default(false),
});

const UpdateSavedViewBody = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(400).optional().nullable(),
  scope: z.enum(["active", "archived", "deleted", "locked"]).optional(),
  filters: SavedViewFiltersSchema.optional(),
  sortKey: z.string().trim().max(64).optional().nullable(),
  isDefault: z.boolean().optional(),
});

const BulkEvidenceActionBody = z.object({
  action: z.enum([
    "ADD_TO_CASE",
    "REMOVE_FROM_CASE",
    "ARCHIVE",
    "RESTORE_ARCHIVED",
    "TRASH",
    "RESTORE_TRASH",
    "EXPORT_METADATA_CSV",
  ]),
  evidenceIds: z.array(z.string().uuid()).min(1).max(100),
  caseId: z.string().uuid().optional(),
});

const ReviewerCommentBody = z.object({
  body: z.string().trim().min(1).max(4000),
  visibility: z.nativeEnum(prismaPkg.EvidenceCommentVisibility).optional().default(prismaPkg.EvidenceCommentVisibility.INTERNAL),
});

const ReviewerCommentUpdateBody = z.object({
  body: z.string().trim().min(1).max(4000).optional(),
  visibility: z.nativeEnum(prismaPkg.EvidenceCommentVisibility).optional(),
});

const LegalNoteBody = z.object({
  body: z.string().trim().min(1).max(6000),
  noteType: z.nativeEnum(prismaPkg.EvidenceLegalNoteType),
});

const LegalNoteUpdateBody = z.object({
  body: z.string().trim().min(1).max(6000).optional(),
  noteType: z.nativeEnum(prismaPkg.EvidenceLegalNoteType).optional(),
});

const AnnotationBody = z.object({
  evidencePartId: z.string().uuid().optional().nullable(),
  annotationType: z.nativeEnum(prismaPkg.EvidenceAnnotationType),
  body: z.string().trim().max(4000).optional().nullable(),
  pageNumber: z.number().int().min(1).max(100000).optional().nullable(),
  mediaTimestampMs: z.number().int().min(0).max(864000000).optional().nullable(),
  x: z.number().finite().optional().nullable(),
  y: z.number().finite().optional().nullable(),
  width: z.number().finite().optional().nullable(),
  height: z.number().finite().optional().nullable(),
  coordinateSpace: z.nativeEnum(prismaPkg.EvidenceAnnotationCoordinateSpace),
});

const AnnotationUpdateBody = AnnotationBody.partial();

const ReviewerWorkflowUpdateBody = z.object({
  assignedToUserId: z.string().uuid().nullable().optional(),
  status: z.nativeEnum(prismaPkg.EvidenceReviewWorkflowStatus).optional(),
  priority: z.nativeEnum(prismaPkg.EvidenceReviewWorkflowPriority).optional(),
  dueAt: z.string().datetime().nullable().optional(),
  note: z.string().trim().max(1000).optional().nullable(),
});

const RelationshipBody = z.object({
  targetEvidenceId: z.string().uuid(),
  relationshipType: z.nativeEnum(prismaPkg.EvidenceRelationshipType),
  note: z.string().trim().max(1000).optional().nullable(),
});

const RelationshipUpdateBody = z.object({
  relationshipType: z.nativeEnum(prismaPkg.EvidenceRelationshipType).optional(),
  note: z.string().trim().max(1000).optional().nullable(),
});

const RequestEvidenceCertificationBody = z.object({
  declarationType: z.nativeEnum(PrismaCertificationType),
});

const AttestEvidenceCertificationBody = z.object({
  declarationType: z.nativeEnum(PrismaCertificationType),
  attestorName: z.string().trim().min(1).max(160),
  attestorTitle: z.string().trim().min(1).max(160),
  attestorEmail: z.string().trim().email().max(320),
  attestorOrganization: z.string().trim().min(1).max(180).optional().nullable(),
  statementMarkdown: z.string().trim().min(1),
  statementSnapshot: z.unknown().optional().nullable(),
  signatureText: z.string().trim().min(1).max(512),
});

const RevokeEvidenceCertificationBody = z.object({
  declarationType: z.nativeEnum(PrismaCertificationType),
  reason: z.string().trim().min(1).max(500),
});

type ParamsId = { id: string };

const { EvidenceStatus, PlanType, VerificationSource, VerificationViewerType } =
  prismaPkg;
const evidenceAiProvider = createAiProvider();
const evidenceAiCostGuard = new AiCostGuard();

type PublicCustodyEventCategory = "forensic" | "access";

function assertEvidenceNotLocked(evidence: SelectedEvidence) {
  if (evidence.lockedAt) {
    const err: Error & { statusCode?: number; code?: string } = new Error(
      "Evidence is permanently locked"
    );
    err.statusCode = 409;
    err.code = "EVIDENCE_LOCKED";
    throw err;
  }
}

function assertEvidenceDeletionAllowedByRetention(evidence: SelectedEvidence) {
  const mode = String(evidence.storageObjectLockMode ?? "").toUpperCase();
  const retainUntil = evidence.storageObjectLockRetainUntilUtc;

  if (mode === "COMPLIANCE" && retainUntil && retainUntil > new Date()) {
    const err: Error & { statusCode?: number; code?: string } = new Error(
      "Evidence is under compliance retention and cannot be deleted before retention expiry"
    );
    err.statusCode = 409;
    err.code = "COMPLIANCE_RETENTION_ACTIVE";
    throw err;
  }
}

function getErrorCode(err: unknown, fallback = "OPERATION_BLOCKED"): string {
  return err instanceof Error && "code" in err
    ? ((err as Error & { code?: string }).code ?? fallback)
    : fallback;
}

type PublicVerifyTimelineEvent = {
  sequence: number;
  atUtc: string;
  eventType: prismaPkg.CustodyEventType;
  payloadSummary: string | null;
  prevEventHash: string | null;
  eventHash: string | null;
  category: PublicCustodyEventCategory;
};

type PublicEvidenceAsset = {
  id: string;
  index: number;
  label: string;
  originalFileName: string | null;
  mimeType: string | null;
  kind: PublicEvidenceAssetKind;
  sizeBytes: string | null;
  durationMs: number | null;
  sha256: string | null;
  isPrimary: boolean;
  artifactRole: ReviewerArtifactRole;
  artifactRoleLabel: string;
  artifactRoleSource: ReviewerArtifactRoleSource;
  checklistStepId: string | null;
  checklistStepLabel: string | null;
  previewable: boolean;
  downloadable: boolean;
  viewUrl: string | null;
  displaySizeLabel: string | null;
  previewRole:
    | "primary_preview"
    | "secondary_preview"
    | "download_only"
    | "metadata_only";
  originalPreservationNote: string;
  reviewerRepresentationLabel: string;
  reviewerRepresentationNote: string;
  verificationMaterialsNote: string;
  previewDataUrl?: string | null;
  previewTextExcerpt?: string | null;
  previewCaption?: string | null;
};

type PublicVerifyIntegrityProof = {
  overallIntegrity: boolean;
  canonicalHashMatches: boolean;
  signatureValid: boolean;
  custodyChainValid: boolean;
  custodyChainMode: string | null;
  custodyChainFailureReason: string | null;
  timestampDigestMatches: boolean | null;
  otsHashMatches: boolean | null;
};

type PublicVerifyVersioning = {
  latestReportVersion: number | null;
  latestReportGeneratedAtUtc: string | null;
  verificationPackageVersion: number | null;
  verificationPackageGeneratedAtUtc: string | null;
  reviewerSummaryVersion: number | null;
};

type PublicVerificationPackageIntegrity = {
  available: boolean;
  version: number | null;
  generatedAtUtc: string | null;
  packageType: string | null;
  manifestPresent: boolean;
  signedManifestPresent: boolean;
  manifestDigestPresent: boolean;
  checksumIndexPresent: boolean;
  offlineVerifierIncluded: boolean;
  auditExportIncluded: boolean;
  custodyExportIncluded: boolean;
  accessExportIncluded: boolean;
};

type VerificationPackageArtifactPresence = {
  manifestPresent: boolean;
  signedManifestPresent: boolean;
  manifestDigestPresent: boolean;
  checksumIndexPresent: boolean;
  offlineVerifierIncluded: boolean;
  auditExportIncluded: boolean;
  custodyExportIncluded: boolean;
  accessExportIncluded: boolean;
};

const PACKAGE_ARTIFACT_FILE_NAMES = {
  packageManifest: "package-manifest.json",
  packageManifestSignature: "package-manifest.sig",
  checksumIndex: "package-checksums.json",
  offlineVerifier: "verify-package.mjs",
  auditExport: "audit-access-report.json",
  custodyExport: "custody.json",
  accessExport: "access-activity.json",
} as const;

function parseZipCentralDirectoryEntries(buffer: Buffer): Set<string> {
  const entries = new Set<string>();
  let offset = 0;
  const CENTRAL_FILE_HEADER_SIG = 0x02014b50;

  while (offset + 46 <= buffer.length) {
    if (buffer.readUInt32LE(offset) !== CENTRAL_FILE_HEADER_SIG) {
      break;
    }

    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraFieldLength = buffer.readUInt16LE(offset + 30);
    const fileCommentLength = buffer.readUInt16LE(offset + 32);
    const nameStart = offset + 46;
    const nameEnd = nameStart + fileNameLength;

    if (nameEnd > buffer.length) {
      break;
    }

    const name = buffer.toString("utf8", nameStart, nameEnd);
    entries.add(name);

    offset = nameEnd + extraFieldLength + fileCommentLength;
  }

  return entries;
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const EOCD_SIG = 0x06054b50;
  for (let offset = buffer.length - 22; offset >= 0; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIG) {
      return offset;
    }
  }
  return -1;
}

async function listZipEntryNames(bucket: string, key: string): Promise<Set<string>> {
  const meta = await headObject({ bucket, key });
  const sizeBytes = meta.sizeBytes ?? 0;
  if (sizeBytes === 0) return new Set();

  const tailLength = Math.min(Number(sizeBytes), 128 * 1024);
  const tailStart = Number(sizeBytes) - tailLength;
  const tail = await getObjectRange({
    bucket,
    key,
    range: `bytes=${tailStart}-${Number(sizeBytes) - 1}`,
  });

  const eocdOffset = findEndOfCentralDirectory(tail);
  if (eocdOffset < 0 || eocdOffset + 22 > tail.length) {
    throw new Error("Unable to locate ZIP end of central directory");
  }

  const commentLength = tail.readUInt16LE(eocdOffset + 20);
  const centralDirectorySize = tail.readUInt32LE(eocdOffset + 12);
  const centralDirectoryOffset = tail.readUInt32LE(eocdOffset + 16);

  const cdEnd = centralDirectoryOffset + centralDirectorySize - 1;
  const cdBuffer =
    centralDirectoryOffset >= tailStart
      ? tail.subarray(centralDirectoryOffset - tailStart, centralDirectoryOffset - tailStart + centralDirectorySize)
      : await getObjectRange({
          bucket,
          key,
          range: `bytes=${centralDirectoryOffset}-${cdEnd}`,
        });

  return parseZipCentralDirectoryEntries(cdBuffer);
}

async function inspectVerificationPackageArtifacts(
  bucket: string | null,
  key: string | null
): Promise<VerificationPackageArtifactPresence | null> {
  if (!bucket || !key) {
    return null;
  }

  try {
    const entries = await listZipEntryNames(bucket, key);

    return {
      manifestPresent: entries.has(PACKAGE_ARTIFACT_FILE_NAMES.packageManifest),
      signedManifestPresent: entries.has(PACKAGE_ARTIFACT_FILE_NAMES.packageManifestSignature),
      manifestDigestPresent: entries.has(PACKAGE_ARTIFACT_FILE_NAMES.packageManifestSignature),
      checksumIndexPresent: entries.has(PACKAGE_ARTIFACT_FILE_NAMES.checksumIndex),
      offlineVerifierIncluded: entries.has(PACKAGE_ARTIFACT_FILE_NAMES.offlineVerifier),
      auditExportIncluded: entries.has(PACKAGE_ARTIFACT_FILE_NAMES.auditExport),
      custodyExportIncluded: entries.has(PACKAGE_ARTIFACT_FILE_NAMES.custodyExport),
      accessExportIncluded: entries.has(PACKAGE_ARTIFACT_FILE_NAMES.accessExport),
    };
  } catch (error) {
    console.warn(
      "Unable to inspect verification package contents for artifact presence:",
      error
    );
    return null;
  }
}

function isVerificationPackageMetadata(
  value: unknown
): value is VerificationPackageMetadata {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.manifestPresent === true || candidate.manifestPresent === false
  ) &&
    (candidate.signedManifestPresent === true ||
      candidate.signedManifestPresent === false) &&
    (candidate.checksumIndexPresent === true ||
      candidate.checksumIndexPresent === false) &&
    (candidate.offlineVerifierIncluded === true ||
      candidate.offlineVerifierIncluded === false) &&
    candidate.packageVersion === "v1" &&
    typeof candidate.generatedAtUtc === "string" &&
    (candidate.source === "GENERATION" ||
      candidate.source === "ZIP_INSPECTION");
}

type PublicCustodyLifecycle = {
  forensicEventCount: number;
  accessEventCount: number;
  forensicEvents: PublicVerifyTimelineEvent[];
  accessEvents: PublicVerifyTimelineEvent[];
  chronologyNote: string;
};

async function requireAuthAndLegal(req: FastifyRequest, reply: any) {
  await requireAuth(req, reply);
  if (reply.sent) return;
  await requireLegalAcceptance(req, reply);
}

function buildOriginalPreservationNote(params: {
  label: string;
  kind: PublicEvidenceAssetKind;
}): string {
  return `Original preserved ${params.kind} evidence item: ${params.label}.`;
}

function buildReviewerRepresentationLabel(params: {
  kind: PublicEvidenceAssetKind;
  artifactRole: ReviewerArtifactRole;
}): string {
  const prefix =
    params.artifactRole === "primary_evidence"
      ? "Primary"
      : params.artifactRole === "attachment"
        ? "Reference"
        : "Supporting";
  switch (params.kind) {
    case "image":
      return `${prefix} image review surface`;
    case "video":
      return `${prefix} video review surface`;
    case "audio":
      return `${prefix} audio review surface`;
    case "pdf":
      return `${prefix} document review surface`;
    case "text":
      return `${prefix} text review surface`;
    default:
      return `${prefix} evidence review surface`;
  }
}

function buildReviewerRepresentationNote(params: {
  kind: PublicEvidenceAssetKind;
  label: string;
  canExposeContent: boolean;
}): string {
  if (!params.canExposeContent) {
    return `Direct reviewer preview is restricted for preserved evidence item ${params.label}. Use the verification materials and access policy shown here to understand what remains exposed.`;
  }

  switch (params.kind) {
    case "image":
      return `Reviewer preview generated from the preserved image evidence item ${params.label}. Original image remains separately preserved.`;
    case "video":
      return `Reviewer playback access is exposed for preserved video evidence item ${params.label}. Original video remains separately preserved.`;
    case "audio":
      return `Reviewer playback access is exposed for preserved audio evidence item ${params.label}. Original audio remains separately preserved.`;
    case "pdf":
      return `Reviewer document access is exposed for preserved PDF evidence item ${params.label}. Original file remains separately preserved.`;
    case "text":
      return `Reviewer text access is exposed for preserved text evidence item ${params.label}. Original file remains separately preserved.`;
    default:
      return `Reviewer-facing access is exposed for preserved evidence item ${params.label}. Original file remains separately preserved.`;
  }
}

function buildVerificationMaterialsNote(params: {
  kind: PublicEvidenceAssetKind;
}): string {
  return `Verification materials for this ${params.kind} item include the recorded digest, custody linkage, timestamping state, and published anchoring indicators associated with the evidence record.`;
}

function sortPublicEvidenceItems(items: PublicEvidenceAsset[]): PublicEvidenceAsset[] {
  return [...items].sort((left, right) => {
    const roleOrder = compareReviewerArtifactRolePriority(
      left.artifactRole,
      right.artifactRole
    );
    if (roleOrder !== 0) return roleOrder;
    return left.index - right.index;
  });
}

const SAFE_EVIDENCE_SELECT = {
  id: true,
  title: true,
  ownerUserId: true,
  organizationId: true,
  originalFileName: true,
  displayFileName: true,
  internalNotes: true,
  intakePlanJson: true,
  type: true,
  status: true,
  verificationStatus: true,
  captureMethod: true,
  identityLevelSnapshot: true,
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
  verificationPackageMetadata: true,
  latestReportVersion: true,
  reviewReadyAtUtc: true,
  reviewerSummaryVersion: true,
  createdAt: true,
  uploadedAtUtc: true,
    tsaStatus: true,
  tsaProvider: true,
  tsaSerialNumber: true,
  tsaGenTimeUtc: true,
  tsaMessageImprint: true,
  tsaInputDigestHex: true,
  tsaInputKind: true,
  tsaHashAlgorithm: true,
  tsaFailureReason: true,

  otsProofBase64: true,
  otsHash: true,
  otsStatus: true,
  otsCalendar: true,
  otsBitcoinTxid: true,
  otsAnchoredAtUtc: true,
  otsUpgradedAtUtc: true,
  otsFailureReason: true,
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
  fileSha256: true,
  // Phase C #4: explicit multipart hash semantics so consumers don't have
  // to infer them from evidenceParts count.
  multipartManifestSha256: true,
  hashSemantics: true,
  fingerprintCanonicalJson: true,
  fingerprintHash: true,
  signatureBase64: true,
  signingKeyId: true,
  signingKeyVersion: true,
  deletedByUserId: true,
  lockedAt: true,
  lockedByUserId: true,
  archivedAt: true,
  caseId: true,
  teamId: true,
  deletedAt: true,
  deletedAtUtc: true,
  deleteScheduledForUtc: true,
  retentionUntilUtc: true,
} as const;

type SelectedEvidence = prismaPkg.Prisma.EvidenceGetPayload<{
  select: typeof SAFE_EVIDENCE_SELECT;
}>;

type StorageProtectionSummary = {
  immutable: boolean;
  mode: string | null;
  retainUntil: string | null;
  legalHold: string | null;
  region: string | null;
  verified: boolean;
} | null;

type AnchorStatusSummary = {
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

type SafeEvidence = {
  id: string;
  title: string;
  ownerUserId?: string;
  organizationId: string | null;
  originalFileName: string | null;
  displayFileName: string | null;
  internalNotes: string | null;
  intakePlanJson: Prisma.JsonValue | null;
    tsaStatus: string | null;
  tsaProvider: string | null;
  tsaSerialNumber: string | null;
  tsaGenTimeUtc: string | null;
  tsaMessageImprint: string | null;
  tsaHashAlgorithm: string | null;
  tsaFailureReason: string | null;

  otsProofBase64: string | null;
  otsHash: string | null;
  otsStatus: string | null;
  otsCalendar: string | null;
  otsBitcoinTxid: string | null;
  otsAnchoredAtUtc: string | null;
  otsUpgradedAtUtc: string | null;
  otsFailureReason: string | null;
  type: prismaPkg.EvidenceType;
  status: prismaPkg.EvidenceStatus;
  verificationStatus: prismaPkg.VerificationStatus | null;
  captureMethod: prismaPkg.CaptureMethod | null;
  identityLevelSnapshot: prismaPkg.IdentityLevel | null;
  submittedByEmail: string | null;
  submittedByAuthProvider: prismaPkg.AuthProvider | null;
  submittedByUserId: string | null;
  createdByUserId: string | null;
  uploadedByUserId: string | null;
  lastAccessedByUserId: string | null;
  lastAccessedAtUtc: string | null;
  workspaceNameSnapshot: string | null;
  organizationNameSnapshot: string | null;
  organizationVerifiedSnapshot: boolean | null;
  recordedIntegrityVerifiedAtUtc: string | null;
  lastVerifiedAtUtc: string | null;
  lastVerifiedSource: prismaPkg.VerificationSource | null;
  verificationPackageGeneratedAtUtc: string | null;
  verificationPackageVersion: number | null;
  latestReportVersion: number | null;
  reviewReadyAtUtc: string | null;
  reviewerSummaryVersion: number | null;
  createdAt: string;
  uploadedAtUtc: string | null;
  signedAtUtc: string | null;
  capturedAtUtc: string | null;
  reportGeneratedAtUtc: string | null;
  deviceTimeIso: string | null;
  lat: number | null;
  lng: number | null;
  accuracyMeters: number | null;
  mimeType: string | null;
  storageBucket: string | null;
  storageKey: string | null;
  storageRegion: string | null;
  storageObjectLockMode: string | null;
  storageObjectLockRetainUntilUtc: string | null;
  storageObjectLockLegalHoldStatus: string | null;
  sizeBytes: string | null;
  fileSha256: string | null;
  fingerprintHash: string | null;
  signatureBase64: string | null;
  signingKeyId: string | null;
  signingKeyVersion: number | null;
  deletedByUserId: string | null;
  retentionUntilUtc: string | null;
  lockedAt: string | null;
  lockedByUserId: string | null;
  archivedAt: string | null;
  caseId: string | null;
  teamId: string | null;
  deletedAt: string | null;
  deletedAtUtc: string | null;
  deleteScheduledForUtc: string | null;
};

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function getTierLimit(plan: prismaPkg.PlanType) {
  switch (plan) {
    case PlanType.PAYG:
      return { max: 30, windowSec: 60 };
    case PlanType.PRO:
    case PlanType.TEAM:
      return { max: 60, windowSec: 60 };
    case PlanType.FREE:
    default:
      return { max: 10, windowSec: 60 };
  }
}

function getVerifyLimit() {
  // Phase 1 — tightened defaults. 30/min sustained, configurable.
  // Was 60/min by default which the runtime audit demonstrated permits
  // unrestricted scraping of evidence metadata over a UUID guess space.
  // Operators can still raise via env if a legitimate fan-out is needed
  // (e.g. a high-traffic shared verify URL).
  return {
    max: readPositiveIntEnv("VERIFY_RATE_LIMIT_MAX", 30),
    windowSec: readPositiveIntEnv("VERIFY_RATE_LIMIT_WINDOW_SEC", 60),
  };
}

// Phase 1 — per-evidence-id verify limit. Stops one attacker from
// using rotated IPs / TLS-resumed connections to enumerate a single
// evidence record's history. Lower default than the per-IP bucket;
// legitimate viewers refresh a verify page at most a handful of
// times per minute.
function getVerifyPerEvidenceLimit() {
  return {
    max: readPositiveIntEnv("VERIFY_RATE_LIMIT_PER_EVIDENCE_MAX", 60),
    windowSec: readPositiveIntEnv(
      "VERIFY_RATE_LIMIT_PER_EVIDENCE_WINDOW_SEC",
      60,
    ),
  };
}

// =============================================================================
// Phase 1 — public verify identity exposure policy
// =============================================================================
//
// The runtime audit (2026-05-26) confirmed that the public verify
// response shape exposed `submittedByEmail`, `workspaceName`,
// `organizationName`, and `submittedByAuthProviderCode` to
// unauthenticated callers. For a regulated buyer, journalist's source,
// insurance claimant, or any case-sensitive submitter this is a P0
// privacy leak. Even though `submittedByEmail` was passed through
// `maskPublicEmail()` it leaked the FULL DOMAIN — enough to identify
// the submitting organization (e.g. `***@nytimes.com`).
//
// Default posture from Phase 1 onward:
//   * `submittedByEmail`         → ALWAYS null on /public/verify
//   * `workspaceName`            → null unless explicit env opt-in
//   * `organizationName`         → null unless explicit env opt-in
//   * `submittedByAuthProvider`  → label-only ("Google sign-in"), no code
//   * `organizationVerified`     → kept (boolean, no name)
//
// Operators may opt back into attribution display via the env flag
// `PUBLIC_VERIFY_EXPOSE_ATTRIBUTION=true`. The flag is global today;
// a per-evidence opt-in is tracked as Phase 2 product work.
//
// This function is the SINGLE place to consult before shaping the
// verify response. Do not branch elsewhere.
function getPublicVerifyIdentityExposure(): {
  exposeAttribution: boolean;
  exposeAuthProviderCode: boolean;
  reason: string;
} {
  const exposeAttribution =
    String(process.env.PUBLIC_VERIFY_EXPOSE_ATTRIBUTION ?? "false")
      .trim()
      .toLowerCase() === "true";
  const exposeAuthProviderCode =
    String(process.env.PUBLIC_VERIFY_EXPOSE_AUTH_PROVIDER_CODE ?? "false")
      .trim()
      .toLowerCase() === "true";

  return {
    exposeAttribution,
    exposeAuthProviderCode,
    reason: exposeAttribution
      ? "operator_opt_in:PUBLIC_VERIFY_EXPOSE_ATTRIBUTION=true"
      : "default_redacted",
  };
}

function readUserAgent(req: FastifyRequest): string | null {
  const ua = req.headers["user-agent"];
  return Array.isArray(ua) ? ua[0] ?? null : ua ?? null;
}

function getRequestPath(req: FastifyRequest): string {
  const url = req.url || "";
  const qIndex = url.indexOf("?");
  return qIndex >= 0 ? url.slice(0, qIndex) : url;
}

function auditEvidenceAction(
  req: FastifyRequest,
  params: {
    userId: string | null;
    action: string;
    outcome?: "success" | "failure" | "blocked";
    severity?: "info" | "warning" | "critical";
    resourceId?: string | null;
    metadata?: Record<string, unknown>;
  }
) {
  void appendPlatformAuditLog({
    userId: params.userId,
    action: params.action,
    category: "evidence",
    severity: params.severity ?? "info",
    source: "api_evidence",
    outcome: params.outcome ?? "success",
    resourceType: "evidence",
    resourceId: params.resourceId ?? null,
    requestId: req.id,
    metadata: params.metadata ?? {},
    ipAddress: req.ip,
    userAgent: readUserAgent(req),
  }).catch(() => null);
}

function auditVerificationAction(
  req: FastifyRequest,
  params: {
    userId: string | null;
    action: string;
    resourceId?: string | null;
    metadata?: Record<string, unknown>;
  }
) {
  void appendPlatformAuditLog({
    userId: params.userId,
    isPublic: params.userId === null,
    action: params.action,
    category: "verification",
    severity: "info",
    source: "public_verify",
    outcome: "success",
    resourceType: "evidence_verification",
    resourceId: params.resourceId ?? null,
    requestId: req.id,
    metadata: params.metadata ?? {},
    ipAddress: req.ip,
    userAgent: readUserAgent(req),
  }).catch(() => null);
}

function fireEvidenceAnalyticsEvent(params: {
  eventType: string;
  userId: string;
  req?: FastifyRequest;
  entityType?: string | null;
  entityId?: string | null;
  severity?: string | null;
  metadata?: Record<string, unknown>;
}) {
  void writeAnalyticsEvent({
    eventType: params.eventType,
    userId: params.userId,
    path: params.req ? getRequestPath(params.req) : null,
    entityType: params.entityType ?? "evidence",
    entityId: params.entityId ?? null,
    severity: params.severity ?? "info",
    metadata: params.metadata ?? {},
    req: params.req,
    skipSessionUpsert: true,
  }).catch(() => null);
}

async function getUserPlan(userId: string) {
  const entitlement = await prisma.entitlement.findFirst({
    where: { userId, active: true },
  });
  return entitlement?.plan ?? PlanType.FREE;
}

function bigintToString(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

function decimalToNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;

  if (typeof v === "number") {
    return Number.isFinite(v) ? v : null;
  }

  if (
    typeof v === "object" &&
    v !== null &&
    "toNumber" in v &&
    typeof (v as { toNumber: () => number }).toNumber === "function"
  ) {
    const n = (v as { toNumber: () => number }).toNumber();
    return Number.isFinite(n) ? n : null;
  }

  if (
    typeof v === "object" &&
    v !== null &&
    "toString" in v &&
    typeof (v as { toString: () => string }).toString === "function"
  ) {
    const n = Number((v as { toString: () => string }).toString());
    return Number.isFinite(n) ? n : null;
  }

  return null;
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

function normalizeMimeType(value: string | null | undefined): string | null {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!raw) return null;
  const text = raw.split(";")[0]?.trim() ?? "";
  if (!text) return null;
  if (text.length > 128) return null;
  if (/[\r\n]/.test(text)) return null;
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(text)) return null;
  return text;
}

function normalizeChecksumSha256Base64(
  value: string | null | undefined
): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return null;
  if (text.length > 128) return null;
  if (/[\r\n]/.test(text)) return null;
  if (!/^[A-Za-z0-9+/=]+$/.test(text)) return null;
  return text;
}

function normalizeContentMd5Base64(
  value: string | null | undefined
): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return null;
  if (text.length > 128) return null;
  if (/[\r\n]/.test(text)) return null;
  if (!/^[A-Za-z0-9+/=]+$/.test(text)) return null;
  return text;
}

function normalizePublicPayloadValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const t = value.trim();
    if (!t) return null;
    return t.includes("@") ? maskPublicEmail(t) : t;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return null;
}

function mapRecordStatusLabel(status: prismaPkg.EvidenceStatus | string): string {
  switch (String(status).toUpperCase()) {
    case "REPORTED":
      return "Reported";
    case "SIGNED":
      return "Signed";
    case "UPLOADED":
      return "Uploaded";
    case "UPLOADING":
      return "Uploading";
    case "CREATED":
    default:
      return "Created";
  }
}

function mapVerificationStatusLabel(
  status: prismaPkg.VerificationStatus | string | null | undefined
): string {
  switch (String(status ?? "").toUpperCase()) {
    case "RECORDED_INTEGRITY_VERIFIED":
      return "Recorded integrity state verified";
    case "MATERIALS_AVAILABLE":
      return "Technical materials available";
    case "REVIEW_REQUIRED":
      return "Review required";
    case "FAILED":
      return "Verification failed";
    default:
      return "Verification status not recorded";
  }
}

function mapAuthProviderLabel(
  provider: prismaPkg.AuthProvider | string | null | undefined
): string | null {
  switch (String(provider ?? "").toUpperCase()) {
    case "GOOGLE":
      return "Google";
    case "APPLE":
      return "Apple";
    case "EMAIL":
      return "Email";
    case "GUEST":
      return "Guest";
    default:
      return null;
  }
}

function mapIdentityLevelLabel(
  level: prismaPkg.IdentityLevel | string | null | undefined
): string {
  switch (String(level ?? "").toUpperCase()) {
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

function mapVerificationSourceLabel(
  source: prismaPkg.VerificationSource | string | null | undefined
): string {
  switch (String(source ?? "").toUpperCase()) {
    case "REPORT_GENERATED":
      return "Report generated";
    case "PUBLIC_VERIFY_VIEWED":
      return "Public verify viewed";
    case "TECHNICAL_VERIFICATION_CHECKED":
      return "Technical verification checked";
    default:
      return "Verification source not recorded";
  }
}

function formatDisplayDateUtc(value: Date | string): string {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "";

  const day = d.getUTCDate().toString().padStart(2, "0");
  const month = d.toLocaleString("en-GB", { month: "short", timeZone: "UTC" });
  const year = d.getUTCFullYear();
  const hours = d.getUTCHours().toString().padStart(2, "0");
  const minutes = d.getUTCMinutes().toString().padStart(2, "0");
  const seconds = d.getUTCSeconds().toString().padStart(2, "0");

  return `${day} ${month} ${year}, ${hours}:${minutes}:${seconds} UTC`;
}

function buildEvidenceSubtitle(params: {
  itemCount: number;
  status: prismaPkg.EvidenceStatus | string;
  createdAt: Date | string;
}) {
  const count = Math.max(1, params.itemCount || 1);
  return `${count} ${count === 1 ? "item" : "items"} • ${mapRecordStatusLabel(
    params.status
  )} • ${formatDisplayDateUtc(params.createdAt)}`;
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function getCompletedEvidenceLabel(itemCount: number | null): string {
  const count =
    typeof itemCount === "number" && Number.isFinite(itemCount)
      ? Math.max(0, itemCount)
      : 0;
  return count <= 1
    ? "Single evidence item completed"
    : "Multipart evidence package completed";
}

function normalizeAnchorMode(
  value: string | null | undefined
): "off" | "ready" | "active" {
  const raw = String(value ?? "ready").trim().toLowerCase();
  if (raw === "off" || raw === "active") return raw;
  return "ready";
}

function normalizeTimestampStatus(
  status: string | null | undefined
): string | null {
  const text = typeof status === "string" ? status.trim().toUpperCase() : "";
  return text || null;
}

function normalizeOtsStatus(status: string | null | undefined): string | null {
  const text = typeof status === "string" ? status.trim().toUpperCase() : "";
  return text || null;
}

function mapEvidenceTypeLabel(params: {
  type: prismaPkg.EvidenceType | string | null | undefined;
  mimeType?: string | null;
  itemCount?: number | null;
  contentSummary?: PublicEvidenceContentSummary | null;
}): string {
  return getReviewerEvidenceTypeLabel({
    itemCount: params.itemCount,
    structure: params.contentSummary?.structure ?? null,
    imageCount: params.contentSummary?.imageCount ?? null,
    videoCount: params.contentSummary?.videoCount ?? null,
    audioCount: params.contentSummary?.audioCount ?? null,
    pdfCount: params.contentSummary?.pdfCount ?? null,
    textCount: params.contentSummary?.textCount ?? null,
    otherCount: params.contentSummary?.otherCount ?? null,
    evidenceType: params.type,
    mimeType: params.mimeType ?? null,
  });
}

function mapCaptureMethodLabel(
  captureMethod: prismaPkg.CaptureMethod | string | null | undefined
): string {
  switch (String(captureMethod ?? "").toUpperCase()) {
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

function getTimestampDigestLabel(params: {
  itemCount: number;
  tsaInputKind: string | null | undefined;
}): string {
  const isMultipart =
    params.itemCount > 1 ||
    String(params.tsaInputKind ?? "").toUpperCase() ===
      "CANONICAL_PACKAGE_SHA256";

  return isMultipart
    ? "Timestamped Digest / Canonical Package Digest"
    : "Timestamped Digest / Original File SHA-256";
}

function maskPublicEmail(email: string | null | undefined): string | null {
  const value = String(email ?? "").trim();
  if (!value) return null;
  if (!value.includes("@")) return "Not recorded";

  const [name, domain] = value.split("@");
  const visible = name.slice(0, Math.min(3, name.length));
  return `${visible}***@${domain}`;
}

function normalizeTrustDecisionSnapshot(
  value: Prisma.JsonValue | null | undefined
): TrustDecision | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const candidate = value as Partial<TrustDecision>;

  return typeof candidate.verdict === "string" &&
    typeof candidate.verdictLabel === "string" &&
    typeof candidate.score === "number" &&
    Array.isArray(candidate.signals)
    ? (candidate as TrustDecision)
    : null;
}

function mapIntegrityHeadline(params: {
  overallIntegrity: boolean | null | undefined;
  verificationStatus: prismaPkg.VerificationStatus | null | undefined;
  timestampDigestMatches: boolean | null;
  timestampStatus: string | null | undefined;
  trustDecision?: TrustDecision | null;
}): string {
  const coreSignal = params.trustDecision?.signals.find(
    (signal) => signal.key === "core_integrity"
  );
  const explicitlyVerified =
    String(params.verificationStatus ?? "").toUpperCase() ===
    "RECORDED_INTEGRITY_VERIFIED";

  if (
    coreSignal?.status === "passed" &&
    explicitlyVerified &&
    params.overallIntegrity === true &&
    params.timestampDigestMatches !== true
  ) {
    return "Core Integrity Verified; Trusted Timestamp Unavailable";
  }
  if (coreSignal?.status === "passed" && explicitlyVerified) {
    return "Core Integrity Verified";
  }
  if (coreSignal?.status === "partial") {
    return "Integrity Materials Recorded";
  }
  if (
    params.overallIntegrity === true &&
    String(params.verificationStatus ?? "").toUpperCase() ===
      "MATERIALS_AVAILABLE"
  ) {
    return "Integrity Materials Recorded";
  }
  if (params.overallIntegrity === false) {
    return "Recorded Integrity Review Required";
  }
  return "Recorded Integrity Materials Available";
}

function mapIntegritySummaryText(params: {
  overallIntegrity: boolean | null | undefined;
  canonicalHashMatches: boolean;
  signatureValid: boolean;
  custodyChainValid: boolean;
  timestampDigestMatches: boolean | null;
  otsHashMatches: boolean | null;
  trustDecision?: TrustDecision | null;
}) {
  const coreSignal = params.trustDecision?.signals.find(
    (signal) => signal.key === "core_integrity"
  );

  if (coreSignal?.status === "partial" && params.trustDecision?.summary) {
    return params.trustDecision.summary;
  }

  const coreChecksPassed =
    params.canonicalHashMatches &&
    params.signatureValid &&
    params.custodyChainValid &&
    params.otsHashMatches !== false;

  if (coreChecksPassed && params.timestampDigestMatches === true) {
    return "Core integrity verified. Recorded digest, canonical fingerprint, signature material, custody references, trusted timestamp linkage, and OpenTimestamps linkage are available and consistent for this evidence record.";
  }

  if (coreChecksPassed && params.timestampDigestMatches === null) {
    return "Available integrity checks passed for the fingerprint, signature, custody chain, and OpenTimestamps linkage. Trusted timestamp verification is unavailable, so no timestamp digest match or mismatch can be concluded.";
  }

  if (params.timestampDigestMatches === false) {
    return "A trusted timestamp digest mismatch was detected. Manual review is recommended before relying on the timestamp layer.";
  }

  if (params.overallIntegrity === false) {
    return "One or more recorded integrity checks did not pass. Manual review is recommended before relying on this evidence record.";
  }

  return "Recorded technical verification materials are available for review.";
}

function mapStorageStatusLabel(storage: StorageProtectionSummary): string {
  if (!storage) return "Not reported";
  if (
    storage.immutable &&
    String(storage.mode ?? "").toUpperCase() === "COMPLIANCE"
  ) {
    return "Immutable storage verified";
  }
  if (
    storage.verified &&
    String(storage.mode ?? "").toUpperCase() === "GOVERNANCE"
  ) {
    return "Governance retention active";
  }
  if (storage.verified) {
    return "Storage protection reported";
  }
  return "Storage protection unverified";
}

function mapTimestampStatusLabel(status: string | null | undefined): string {
  const normalized = normalizeTimestampStatus(status);
  switch (normalized) {
    case "STAMPED":
    case "GRANTED":
    case "SUCCEEDED":
    case "VERIFIED":
      return "Trusted timestamp recorded";
    case "PENDING":
      return "Timestamp pending";
    case "FAILED":
      return "Timestamp failed";
    default:
      return "Timestamp unavailable";
  }
}

function mapOtsStatusLabel(status: string | null | undefined): string {
  // Honest base label: "ANCHORED" alone does NOT mean Bitcoin anchoring is
  // confirmed (Bitcoin transaction id may attach later via the OTS upgrade
  // pass). Use mapOtsStatusLabelWithTxid() in surfaces that have the txid.
  const normalized = normalizeOtsStatus(status);
  switch (normalized) {
    case "ANCHORED":
      return "OpenTimestamps proof present; public anchoring pending";
    case "PENDING":
      return "OpenTimestamps proof present; public anchoring pending";
    case "FAILED":
      return "OpenTimestamps anchoring failed";
    case "DISABLED":
      return "OpenTimestamps unavailable";
    default:
      return "OpenTimestamps not configured";
  }
}

function mapOtsStatusLabelWithTxid(params: {
  status: string | null | undefined;
  bitcoinTxid: string | null | undefined;
}): string {
  const normalized = normalizeOtsStatus(params.status);
  const hasTxid =
    typeof params.bitcoinTxid === "string" &&
    /^[a-f0-9]{64}$/i.test(params.bitcoinTxid.trim());
  if (normalized === "ANCHORED" && hasTxid) {
    return "Bitcoin anchoring verified";
  }
  return mapOtsStatusLabel(params.status);
}

function summarizePublicPayload(
  eventType: prismaPkg.CustodyEventType,
  payload: prismaPkg.Prisma.JsonValue | null,
  context?: {
    itemCount?: number | null;
    structure?: "single" | "multipart" | null;
  }
): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    if (eventType === prismaPkg.CustodyEventType.VERIFY_VIEWED) {
      return "Public verification page viewed.";
    }
    return null;
  }

  const obj = payload as Record<string, unknown>;

  switch (eventType) {
    case prismaPkg.CustodyEventType.EVIDENCE_CREATED:
      return "Evidence record created.";

    case prismaPkg.CustodyEventType.UPLOAD_STARTED:
    case prismaPkg.CustodyEventType.UPLOAD_AUTHORIZED: {
      const uploadMode = getReviewerUploadModeLabel({
        itemCount: context?.itemCount ?? null,
        structure: context?.structure ?? null,
        rawMode:
          normalizePublicPayloadValue(obj.uploadKind) ??
          normalizePublicPayloadValue(obj.mode),
      });
  return [
    "Upload authorization recorded (presigned URL issued; bytes not yet confirmed)",
    uploadMode ? `Mode: ${uploadMode}` : null,
  ]
    .filter(Boolean)
    .join(" • ");
}

    case prismaPkg.CustodyEventType.UPLOAD_COMPLETED: {
      const itemCount =
        typeof obj.itemCount === "number" && Number.isFinite(obj.itemCount)
          ? obj.itemCount
          : null;
      const sizeBytes = normalizePublicPayloadValue(obj.sizeBytes);
      return [
        getCompletedEvidenceLabel(itemCount),
        itemCount != null ? `Items: ${itemCount}` : null,
        sizeBytes ? `Size: ${sizeBytes} bytes` : null,
      ]
        .filter(Boolean)
        .join(" • ");
    }

    case prismaPkg.CustodyEventType.SIGNATURE_APPLIED: {
      const signingKeyId = normalizePublicPayloadValue(obj.signingKeyId);
      const signingKeyVersion = normalizePublicPayloadValue(
        obj.signingKeyVersion
      );
      const tsaStatus = normalizePublicPayloadValue(obj.tsaStatus);
      const tsaProvider = normalizePublicPayloadValue(obj.tsaProvider);
      return [
        "Cryptographic signature applied",
        signingKeyId ? `Key: ${signingKeyId}` : null,
        signingKeyVersion ? `Version: ${signingKeyVersion}` : null,
        tsaStatus ? `Timestamp: ${tsaStatus}` : null,
        tsaProvider ? `TSA: ${tsaProvider}` : null,
      ]
        .filter(Boolean)
        .join(" • ");
    }

    case prismaPkg.CustodyEventType.TIMESTAMP_APPLIED: {
      const tsaStatus = normalizePublicPayloadValue(obj.tsaStatus);
      const tsaProvider = normalizePublicPayloadValue(obj.tsaProvider);
      return [
        "Timestamp applied",
        tsaStatus ? `Status: ${tsaStatus}` : null,
        tsaProvider ? `TSA: ${tsaProvider}` : null,
      ]
        .filter(Boolean)
        .join(" • ");
    }

    case prismaPkg.CustodyEventType.TIMESTAMP_FAILED: {
      const tsaStatus = normalizePublicPayloadValue(obj.tsaStatus);
      const tsaProvider = normalizePublicPayloadValue(obj.tsaProvider);
      return [
        "Timestamp failed",
        tsaStatus ? `Status: ${tsaStatus}` : null,
        tsaProvider ? `TSA: ${tsaProvider}` : null,
      ]
        .filter(Boolean)
        .join(" • ");
    }

    case prismaPkg.CustodyEventType.OTS_APPLIED: {
      const otsStatus = normalizePublicPayloadValue(obj.otsStatus);
      const otsPhase = normalizePublicPayloadValue(obj.otsPhase);
      const calendar =
        normalizePublicPayloadValue(obj.calendar) ??
        normalizePublicPayloadValue(obj.otsCalendar);

      const bitcoinTxid =
        normalizePublicPayloadValue(obj.bitcoinTxid) ??
        normalizePublicPayloadValue(obj.otsBitcoinTxid);

      return [
        otsPhase === "anchored"
          ? "OpenTimestamps anchoring completed"
          : "OpenTimestamps proof recorded",
        otsStatus ? `Status: ${otsStatus}` : null,
        calendar ? `Calendar: ${calendar}` : null,
        bitcoinTxid ? `Bitcoin Tx: ${bitcoinTxid}` : null,
      ]
        .filter(Boolean)
        .join(" • ");
    }

    case prismaPkg.CustodyEventType.OTS_FAILED: {
      const otsStatus = normalizePublicPayloadValue(obj.otsStatus);
      const reason =
        normalizePublicPayloadValue(obj.otsFailureReason) ??
        normalizePublicPayloadValue(obj.failureReason);
      const genericReason = normalizePublicPayloadValue(obj.failureReason);

      return [
                "OpenTimestamps failed",
        otsStatus ? `Status: ${otsStatus}` : null,
        reason
          ? `Reason: ${reason}`
          : genericReason
            ? `Reason: ${genericReason}`
            : null,
      ]
        .filter(Boolean)
        .join(" • ");
    }

    case prismaPkg.CustodyEventType.REPORT_GENERATED: {
      const reportVersion = normalizePublicPayloadValue(obj.reportVersion);
      const anchorMode = normalizePublicPayloadValue(obj.anchorMode);
      const anchorHash = normalizePublicPayloadValue(obj.anchorHash);
      return [
        reportVersion
          ? `Verification report generated • Version: ${reportVersion}`
          : "Verification report generated.",
        anchorMode ? `Anchor Mode: ${anchorMode}` : null,
anchorHash ? `Anchor: ${anchorHash}` : null,
      ]
        .filter(Boolean)
        .join(" • ");
    }

    case prismaPkg.CustodyEventType.VERIFICATION_PACKAGE_GENERATED: {
      const version = normalizePublicPayloadValue(obj.version);
      const packageType = normalizePublicPayloadValue(obj.packageType);
      return [
        "Verification package generated",
        version ? `Version: ${version}` : null,
        packageType ? `Type: ${packageType}` : null,
      ]
        .filter(Boolean)
        .join(" • ");
    }

    case prismaPkg.CustodyEventType.VERIFICATION_PACKAGE_DOWNLOADED: {
      const version = normalizePublicPayloadValue(obj.version);
      return version
        ? `Verification package downloaded • Version: ${version}`
        : "Verification package downloaded.";
    }

    case prismaPkg.CustodyEventType.TECHNICAL_VERIFICATION_CHECKED: {
      const source = normalizePublicPayloadValue(obj.source);
      const overallIntegrity = normalizePublicPayloadValue(obj.overallIntegrity);
      return [
        "Technical verification checked",
        source ? `Source: ${source}` : null,
        overallIntegrity ? `Overall integrity: ${overallIntegrity}` : null,
      ]
        .filter(Boolean)
        .join(" • ");
    }

    case prismaPkg.CustodyEventType.REVIEW_READY: {
      const reviewerSummaryVersion = normalizePublicPayloadValue(
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

    case prismaPkg.CustodyEventType.IDENTITY_SNAPSHOT_RECORDED: {
      const identityLevel = normalizePublicPayloadValue(
        obj.identityLevelSnapshot
      );
      const submittedByEmail = normalizePublicPayloadValue(obj.submittedByEmail);
      const authProvider = normalizePublicPayloadValue(
        obj.submittedByAuthProvider
      );
      return [
        "Identity snapshot recorded",
        identityLevel ? `Identity: ${identityLevel}` : null,
        submittedByEmail ? `Email: ${submittedByEmail}` : null,
        authProvider ? `Provider: ${authProvider}` : null,
      ]
        .filter(Boolean)
        .join(" • ");
    }

    case prismaPkg.CustodyEventType.ANCHOR_PUBLISHED: {
      const provider = normalizePublicPayloadValue(obj.provider);
      const receiptId = normalizePublicPayloadValue(obj.receiptId);
      const transactionId = normalizePublicPayloadValue(obj.transactionId);
      return [
        "External anchor publication recorded",
        provider ? `Provider: ${provider}` : null,
receiptId ? `Receipt: ${receiptId}` : null,
transactionId ? `Tx: ${transactionId}` : null,
      ]
        .filter(Boolean)
        .join(" • ");
    }
    

    case prismaPkg.CustodyEventType.ANCHOR_FAILED: {
      const provider = normalizePublicPayloadValue(obj.provider);
      const reason = normalizePublicPayloadValue(obj.reason);
      return [
        "External anchor publication failed",
        provider ? `Provider: ${provider}` : null,
        reason ? `Reason: ${reason}` : null,
      ]
        .filter(Boolean)
        .join(" • ");
    }

    case prismaPkg.CustodyEventType.REPORT_DOWNLOADED: {
      const reportVersion = normalizePublicPayloadValue(obj.reportVersion);
      return reportVersion
        ? `Report downloaded • Version: ${reportVersion}`
        : "Report downloaded.";
    }

    case prismaPkg.CustodyEventType.VERIFY_VIEWED:
      return "Public verification page viewed.";

    case prismaPkg.CustodyEventType.EVIDENCE_VIEWED:
      return "Protected evidence file accessed.";

    case prismaPkg.CustodyEventType.EVIDENCE_LOCKED:
      return "Evidence record locked.";

    case prismaPkg.CustodyEventType.EVIDENCE_ARCHIVED:
      return "Evidence record archived.";

    case prismaPkg.CustodyEventType.EVIDENCE_RESTORED:
      return "Evidence record restored.";

    case prismaPkg.CustodyEventType.EVIDENCE_DELETE_RESTORED:
      return "Evidence deletion was reversed and the record was restored.";

    case prismaPkg.CustodyEventType.EVIDENCE_DELETE_SCHEDULED:
      return "Evidence record scheduled for deletion.";

    case prismaPkg.CustodyEventType.EVIDENCE_DELETED:
      return "Evidence record deleted.";

    case prismaPkg.CustodyEventType.EVIDENCE_COMPLETED:
  return "Evidence record completed.";  

    case prismaPkg.CustodyEventType.EVIDENCE_CLAIMED:
      return "Guest evidence ownership claimed.";

    default: {
      const safeEntries = Object.entries(obj)
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
        .map(([key, value]) =>
          `${key}: ${maskPublicEmailsInText(String(value))}`
        );

      return safeEntries.length > 0 ? safeEntries.join(" • ") : null;
    }
  }
}

function toSafeEvidence(e: SelectedEvidence): SafeEvidence {
  return {
    id: e.id,
    title: resolveEvidenceTitle(e.title),
    ownerUserId: e.ownerUserId,
    originalFileName: e.originalFileName ?? null,
        tsaStatus: e.tsaStatus ?? null,
    tsaProvider: e.tsaProvider ?? null,
    tsaSerialNumber: e.tsaSerialNumber ?? null,
    tsaGenTimeUtc: e.tsaGenTimeUtc ? e.tsaGenTimeUtc.toISOString() : null,
    tsaMessageImprint: e.tsaMessageImprint ?? null,
    tsaHashAlgorithm: e.tsaHashAlgorithm ?? null,
    tsaFailureReason: e.tsaFailureReason ?? null,

    otsProofBase64: e.otsProofBase64 ?? null,
    otsHash: e.otsHash ?? null,
    otsStatus: e.otsStatus ?? null,
    otsCalendar: e.otsCalendar ?? null,
    otsBitcoinTxid: e.otsBitcoinTxid ?? null,
    otsAnchoredAtUtc: e.otsAnchoredAtUtc
      ? e.otsAnchoredAtUtc.toISOString()
      : null,
    otsUpgradedAtUtc: e.otsUpgradedAtUtc
      ? e.otsUpgradedAtUtc.toISOString()
      : null,
    otsFailureReason: e.otsFailureReason ?? null,
    displayFileName: e.displayFileName ?? null,
    organizationId: e.organizationId ?? null,
    type: e.type,
    internalNotes: e.internalNotes ?? null,
    intakePlanJson: e.intakePlanJson ?? null,
    status: e.status,
    verificationStatus: e.verificationStatus ?? null,
    captureMethod: e.captureMethod ?? null,
    identityLevelSnapshot: e.identityLevelSnapshot ?? null,
    submittedByEmail: e.submittedByEmail ?? null,
    submittedByAuthProvider: e.submittedByAuthProvider ?? null,
    submittedByUserId: e.submittedByUserId ?? null,
    createdByUserId: e.createdByUserId ?? null,
    uploadedByUserId: e.uploadedByUserId ?? null,
    lastAccessedByUserId: e.lastAccessedByUserId ?? null,
    lastAccessedAtUtc: e.lastAccessedAtUtc
      ? e.lastAccessedAtUtc.toISOString()
      : null,
    workspaceNameSnapshot: e.workspaceNameSnapshot ?? null,
    organizationNameSnapshot: e.organizationNameSnapshot ?? null,
    organizationVerifiedSnapshot: e.organizationVerifiedSnapshot ?? null,
    recordedIntegrityVerifiedAtUtc: e.recordedIntegrityVerifiedAtUtc
      ? e.recordedIntegrityVerifiedAtUtc.toISOString()
      : null,
    lastVerifiedAtUtc: e.lastVerifiedAtUtc
      ? e.lastVerifiedAtUtc.toISOString()
      : null,
    lastVerifiedSource: e.lastVerifiedSource ?? null,
    verificationPackageGeneratedAtUtc: e.verificationPackageGeneratedAtUtc
      ? e.verificationPackageGeneratedAtUtc.toISOString()
      : null,
    verificationPackageVersion: e.verificationPackageVersion ?? null,
    latestReportVersion: e.latestReportVersion ?? null,
    reviewReadyAtUtc: e.reviewReadyAtUtc
      ? e.reviewReadyAtUtc.toISOString()
      : null,
    reviewerSummaryVersion: e.reviewerSummaryVersion ?? null,
    createdAt: e.createdAt.toISOString(),
    uploadedAtUtc: e.uploadedAtUtc ? e.uploadedAtUtc.toISOString() : null,
    signedAtUtc: e.signedAtUtc ? e.signedAtUtc.toISOString() : null,
    capturedAtUtc: e.capturedAtUtc ? e.capturedAtUtc.toISOString() : null,
    reportGeneratedAtUtc: e.reportGeneratedAtUtc
      ? e.reportGeneratedAtUtc.toISOString()
      : null,
    deviceTimeIso: e.deviceTimeIso ?? null,
    lat: decimalToNumber(e.lat),
    lng: decimalToNumber(e.lng),
    accuracyMeters: decimalToNumber(e.accuracyMeters),
    mimeType: e.mimeType ?? null,
    storageBucket: e.storageBucket ?? null,
    storageKey: e.storageKey ?? null,
    storageRegion: e.storageRegion ?? null,
    storageObjectLockMode: e.storageObjectLockMode ?? null,
    storageObjectLockRetainUntilUtc: e.storageObjectLockRetainUntilUtc
      ? e.storageObjectLockRetainUntilUtc.toISOString()
      : null,
    storageObjectLockLegalHoldStatus:
      e.storageObjectLockLegalHoldStatus ?? null,
    sizeBytes: bigintToString(e.sizeBytes),
    fileSha256: e.fileSha256 ?? null,
    fingerprintHash: e.fingerprintHash ?? null,
    signatureBase64: e.signatureBase64 ?? null,
    signingKeyId: e.signingKeyId ?? null,
    signingKeyVersion: e.signingKeyVersion ?? null,
    deletedByUserId: e.deletedByUserId ?? null,
    lockedAt: e.lockedAt ? e.lockedAt.toISOString() : null,
    lockedByUserId: e.lockedByUserId ?? null,
    archivedAt: e.archivedAt ? e.archivedAt.toISOString() : null,
    caseId: e.caseId ?? null,
    teamId: e.teamId ?? null,
    deletedAt: e.deletedAt ? e.deletedAt.toISOString() : null,
    deletedAtUtc: e.deletedAtUtc ? e.deletedAtUtc.toISOString() : null,
    deleteScheduledForUtc: e.deleteScheduledForUtc
      ? e.deleteScheduledForUtc.toISOString()
      : null,
    retentionUntilUtc: e.retentionUntilUtc
      ? e.retentionUntilUtc.toISOString()
      : null,
  };
}

async function getEvidenceItemCount(evidenceId: string): Promise<number> {
  const count = await prisma.evidencePart.count({
    where: { evidenceId },
  });
  return count > 0 ? count : 1;
}

async function getStorageProtectionSummary(
  bucket: string | null | undefined,
  key: string | null | undefined,
  snapshot?: {
    storageRegion?: string | null;
    storageObjectLockMode?: string | null;
    storageObjectLockRetainUntilUtc?: Date | string | null;
    storageObjectLockLegalHoldStatus?: string | null;
  }
): Promise<StorageProtectionSummary> {
  const snapshotMode =
    typeof snapshot?.storageObjectLockMode === "string"
      ? snapshot.storageObjectLockMode
      : null;

  const snapshotRetainUntil =
    snapshot?.storageObjectLockRetainUntilUtc instanceof Date
      ? snapshot.storageObjectLockRetainUntilUtc.toISOString()
      : typeof snapshot?.storageObjectLockRetainUntilUtc === "string"
        ? snapshot.storageObjectLockRetainUntilUtc
        : null;

  const snapshotLegalHold =
    typeof snapshot?.storageObjectLockLegalHoldStatus === "string"
      ? snapshot.storageObjectLockLegalHoldStatus
      : null;

  const snapshotRegion =
    typeof snapshot?.storageRegion === "string" && snapshot.storageRegion.trim()
      ? snapshot.storageRegion.trim()
      : process.env.S3_REGION?.trim() || null;

  if (snapshotMode || snapshotRetainUntil || snapshotLegalHold) {
    return {
      immutable: snapshotMode === "COMPLIANCE" && Boolean(snapshotRetainUntil),
      mode: snapshotMode,
      retainUntil: snapshotRetainUntil,
      legalHold: snapshotLegalHold,
      region: snapshotRegion,
      verified: true,
    };
  }

  if (!bucket || !key) return null;

  try {
    const meta = await headObject({ bucket, key });
    const mode = meta.objectLockMode ? String(meta.objectLockMode) : null;
    const retainUntil =
      meta.objectLockRetainUntilDate instanceof Date
        ? meta.objectLockRetainUntilDate.toISOString()
        : null;
    const legalHold = meta.objectLockLegalHoldStatus
      ? String(meta.objectLockLegalHoldStatus)
      : null;
    const immutable = mode === "COMPLIANCE" && Boolean(retainUntil);

    return {
      immutable,
      mode,
      retainUntil,
      legalHold,
      region: process.env.S3_REGION?.trim() || null,
      verified: Boolean(mode || retainUntil || legalHold),
    };
  } catch {
    return {
      immutable: false,
      mode: null,
      retainUntil: null,
      legalHold: null,
      region: process.env.S3_REGION?.trim() || null,
      verified: false,
    };
  }
}

function getStorageProtectionSummaryFromSnapshot(snapshot: {
  storageRegion?: string | null;
  storageObjectLockMode?: string | null;
  storageObjectLockRetainUntilUtc?: Date | string | null;
  storageObjectLockLegalHoldStatus?: string | null;
}): StorageProtectionSummary {
  const mode = snapshot.storageObjectLockMode ?? null;

  const retainUntil =
    snapshot.storageObjectLockRetainUntilUtc instanceof Date
      ? snapshot.storageObjectLockRetainUntilUtc.toISOString()
      : snapshot.storageObjectLockRetainUntilUtc ?? null;

  const legalHold = snapshot.storageObjectLockLegalHoldStatus ?? null;
  const region = snapshot.storageRegion ?? process.env.S3_REGION?.trim() ?? null;

  if (!mode && !retainUntil && !legalHold) return null;

  return {
    immutable: mode === "COMPLIANCE" && Boolean(retainUntil),
    mode,
    retainUntil,
    legalHold,
    region,
    verified: Boolean(mode || retainUntil || legalHold),
  };
}

async function assertCaseAccess(userId: string, caseId: string) {
  const item = await prisma.case.findUnique({
    where: { id: caseId },
    include: { access: true },
  });

  if (!item) {
    const err: Error & { statusCode?: number } = new Error("Case not found");
    err.statusCode = 404;
    throw err;
  }

  if (item.ownerUserId === userId) return;
  if (item.access.some((a) => a.userId === userId)) return;

  if (item.teamId && item.access.length === 0) {
    const member = await prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId: item.teamId, userId } },
    });
    if (member) return;
  }

  const err: Error & { statusCode?: number } = new Error("Forbidden");
  err.statusCode = 403;
  throw err;
}

async function getAccessibleEvidenceContext(userId: string) {
  const memberTeams = await prisma.teamMember.findMany({
    where: { userId },
    select: { teamId: true },
  });
  const memberTeamIds = memberTeams.map((item) => item.teamId);

  const accessibleCases = await prisma.case.findMany({
    where: {
      OR: [
        { ownerUserId: userId },
        { access: { some: { userId } } },
        ...(memberTeamIds.length > 0
          ? [
              {
                teamId: { in: memberTeamIds },
                access: { none: {} },
              },
            ]
          : []),
      ],
    },
    select: { id: true },
  });

  return {
    memberTeamIds,
    accessibleCaseIds: accessibleCases.map((item) => item.id),
  };
}

function buildEvidenceListBaseWhere(params: {
  query: EvidenceListQuery;
  userId: string;
  memberTeamIds: string[];
  accessibleCaseIds: string[];
}): Prisma.EvidenceWhereInput {
  const { query } = params;

  const archivedFilter: Prisma.EvidenceWhereInput =
    query.scope === "archived"
      ? { archivedAt: { not: null } }
      : query.scope === "active" || query.scope === "locked"
        ? { archivedAt: null }
        : {};

  const deletedFilter: Prisma.EvidenceWhereInput =
    query.scope === "deleted" ? { deletedAt: { not: null } } : { deletedAt: null };

  const lockedFilter: Prisma.EvidenceWhereInput =
    query.scope === "locked"
      ? { lockedAt: { not: null } }
      : query.scope === "active" || query.scope === "archived"
        ? { lockedAt: null }
        : {};

  const accessFilter: Prisma.EvidenceWhereInput = query.caseId
    ? { caseId: query.caseId }
    : {
        OR: [
          { ownerUserId: params.userId },
          ...(params.accessibleCaseIds.length > 0
            ? [{ caseId: { in: params.accessibleCaseIds } }]
            : []),
          ...(params.memberTeamIds.length > 0
            ? [{ teamId: { in: params.memberTeamIds } }]
            : []),
        ],
      };

  const searchFilter = buildEvidenceListSearchFilter(query.search);
  const statusFilter = query.status ? ({ status: query.status } satisfies Prisma.EvidenceWhereInput) : null;
  const typeFilter = buildEvidenceListTypeFilter(query.type);
  const caseAssignmentFilter = buildEvidenceListCaseAssignmentFilter(query.caseAssignment);
  const reportReadyFilter = buildEvidenceListReportReadyFilter(query.reportReady);

  return {
    AND: [
      accessFilter,
      archivedFilter,
      deletedFilter,
      lockedFilter,
      ...(searchFilter ? [searchFilter] : []),
      ...(statusFilter ? [statusFilter] : []),
      ...(typeFilter ? [typeFilter] : []),
      ...(caseAssignmentFilter ? [caseAssignmentFilter] : []),
      ...(reportReadyFilter ? [reportReadyFilter] : []),
    ],
  };
}

function buildEvidenceListSearchFilter(
  search: string | null
): Prisma.EvidenceWhereInput | null {
  if (!search) return null;

  const exactUuid = z.string().uuid().safeParse(search).success ? search : null;

  return {
    OR: [
      ...(exactUuid ? [{ id: exactUuid }] : []),
      { title: { contains: search, mode: "insensitive" } },
      { displayFileName: { contains: search, mode: "insensitive" } },
      { originalFileName: { contains: search, mode: "insensitive" } },
    ],
  };
}

function buildEvidenceListTypeFilter(
  type: string | null
): Prisma.EvidenceWhereInput | null {
  if (!type || type === "all") return null;

  switch (type) {
    case "photo":
    case "image":
      return {
        OR: [{ type: prismaPkg.EvidenceType.PHOTO }, { mimeType: { startsWith: "image/" } }],
      };
    case "video":
      return {
        OR: [{ type: prismaPkg.EvidenceType.VIDEO }, { mimeType: { startsWith: "video/" } }],
      };
    case "audio":
      return {
        OR: [{ type: prismaPkg.EvidenceType.AUDIO }, { mimeType: { startsWith: "audio/" } }],
      };
    case "document":
      return {
        OR: [
          { type: prismaPkg.EvidenceType.DOCUMENT },
          { mimeType: "application/pdf" },
          { mimeType: { startsWith: "text/" } },
          { mimeType: { contains: "json" } },
          { mimeType: { contains: "xml" } },
        ],
      };
    case "multipart":
      return {
        parts: {
          some: {
            partIndex: { gte: 1 },
          },
        },
      };
    case "other":
      return {
        AND: [
          { type: { notIn: [prismaPkg.EvidenceType.PHOTO, prismaPkg.EvidenceType.VIDEO, prismaPkg.EvidenceType.AUDIO] } },
          {
            NOT: {
              OR: [
                { mimeType: { startsWith: "image/" } },
                { mimeType: { startsWith: "video/" } },
                { mimeType: { startsWith: "audio/" } },
                { mimeType: "application/pdf" },
                { mimeType: { startsWith: "text/" } },
                { mimeType: { contains: "json" } },
                { mimeType: { contains: "xml" } },
              ],
            },
          },
        ],
      };
    case "photo evidence":
    case "photo":
      return { type: prismaPkg.EvidenceType.PHOTO };
    default: {
      const enumCandidate = type.toUpperCase();
      if (enumCandidate in prismaPkg.EvidenceType) {
        return { type: enumCandidate as prismaPkg.EvidenceType };
      }
      return null;
    }
  }
}

function buildEvidenceListCaseAssignmentFilter(
  caseAssignment: EvidenceListQuery["caseAssignment"]
): Prisma.EvidenceWhereInput | null {
  if (caseAssignment === "assigned") return { caseId: { not: null } };
  if (caseAssignment === "unassigned") return { caseId: null };
  return null;
}

function buildEvidenceListReportReadyFilter(
  reportReady: EvidenceListQuery["reportReady"]
): Prisma.EvidenceWhereInput | null {
  if (reportReady === "ready") {
    return {
      OR: [
        { latestReportVersion: { not: null } },
        { reportGeneratedAtUtc: { not: null } },
      ],
    };
  }

  if (reportReady === "missing") {
    return {
      latestReportVersion: null,
      reportGeneratedAtUtc: null,
    };
  }

  return null;
}

function buildEvidenceListCursorFilter(
  cursor: EvidenceListCursorPayload | null,
  sort: EvidenceListSort
): Prisma.EvidenceWhereInput | null {
  if (!cursor) return null;

  const createdAt = new Date(cursor.createdAt);
  if (Number.isNaN(createdAt.getTime())) {
    return null;
  }

  const direction = sort === "oldest" ? "asc" : "desc";

  if (direction === "asc") {
    return {
      OR: [
        { createdAt: { gt: createdAt } },
        {
          createdAt,
          id: { gt: cursor.id },
        },
      ],
    };
  }

  return {
    OR: [
      { createdAt: { lt: createdAt } },
      {
        createdAt,
        id: { lt: cursor.id },
      },
    ],
  };
}

function getEvidenceListOrderBy(
  sort: EvidenceListSort
): Prisma.EvidenceOrderByWithRelationInput[] {
  const createdDirection: Prisma.SortOrder = sort === "oldest" ? "asc" : "desc";

  return [{ createdAt: createdDirection }, { id: createdDirection }];
}

function mapEvidenceListItem(item: SelectedEvidenceListItem) {
  const itemCount = item._count.parts > 0 ? item._count.parts : 1;
  const storage = getStorageProtectionSummaryFromSnapshot({
    storageRegion: item.storageRegion,
    storageObjectLockMode: item.storageObjectLockMode,
    storageObjectLockRetainUntilUtc: item.storageObjectLockRetainUntilUtc,
    storageObjectLockLegalHoldStatus: item.storageObjectLockLegalHoldStatus,
  });

  return {
    id: item.id,
    title: resolveEvidenceTitle(item.title),
    type: item.type,
    mimeType: item.mimeType ?? null,
    primaryKind: detectEvidenceAssetKind(item.mimeType ?? null),
    previewable: isPreviewableEvidenceKind(detectEvidenceAssetKind(item.mimeType ?? null)),
    status: item.status,
    statusLabel: mapRecordStatusLabel(item.status),
    verificationStatus: item.verificationStatus,
    verificationStatusLabel: mapVerificationStatusLabel(item.verificationStatus),
    captureMethod: item.captureMethod,
    captureMethodLabel: mapCaptureMethodLabel(item.captureMethod),
    identityLevel: item.identityLevelSnapshot,
    identityLevelLabel: mapIdentityLevelLabel(item.identityLevelSnapshot),
    submittedByEmail: item.submittedByEmail,
    latestReportVersion: item.latestReportVersion,
    originalFileName: item.originalFileName ?? null,
    displayFileName: item.displayFileName ?? null,
    reviewReadyAtUtc: item.reviewReadyAtUtc ? item.reviewReadyAtUtc.toISOString() : null,
    createdAt: item.createdAt.toISOString(),
    archivedAt: item.archivedAt ? item.archivedAt.toISOString() : null,
    deletedAt: item.deletedAt ? item.deletedAt.toISOString() : null,
    deleteScheduledForUtc: item.deleteScheduledForUtc
      ? item.deleteScheduledForUtc.toISOString()
      : null,
    caseId: item.caseId,
    teamId: item.teamId,
    ownerUserId: item.ownerUserId,
    itemCount,
    storage,
    reviewWorkflow: item.reviewWorkflow
      ? {
          status: item.reviewWorkflow.status,
          priority: item.reviewWorkflow.priority,
          dueAt: item.reviewWorkflow.dueAt
            ? item.reviewWorkflow.dueAt.toISOString()
            : null,
          assignedTo: item.reviewWorkflow.assignedTo
            ? {
                id: item.reviewWorkflow.assignedTo.id,
                email: item.reviewWorkflow.assignedTo.email ?? null,
                displayName: item.reviewWorkflow.assignedTo.displayName ?? null,
              }
            : null,
        }
      : null,
    displaySubtitle: buildEvidenceSubtitle({
      itemCount,
      status: item.status,
      createdAt: item.createdAt,
    }),
  };
}

async function getEvidenceWithReadAccess(
  userId: string,
  evidenceId: string
): Promise<SelectedEvidence> {
  const evidence = await prisma.evidence.findUnique({
    where: { id: evidenceId },
    select: SAFE_EVIDENCE_SELECT,
  });

  if (!evidence) {
    const err: Error & { statusCode?: number } = new Error("Evidence not found");
    err.statusCode = 404;
    throw err;
  }

  if (evidence.ownerUserId === userId) {
    return evidence;
  }

  if (evidence.caseId) {
    const caseItem = await prisma.case.findUnique({
      where: { id: evidence.caseId },
      include: { access: true },
    });

    if (caseItem) {
      if (caseItem.ownerUserId === userId) {
        return evidence;
      }

      if (caseItem.access.some((a) => a.userId === userId)) {
        return evidence;
      }

      if (caseItem.teamId && caseItem.access.length === 0) {
        const member = await prisma.teamMember.findUnique({
          where: {
            teamId_userId: {
              teamId: caseItem.teamId,
              userId,
            },
          },
        });

        if (member) {
          return evidence;
        }
      }
    }
  }

  if (evidence.teamId) {
    const member = await prisma.teamMember.findUnique({
      where: {
        teamId_userId: {
          teamId: evidence.teamId,
          userId,
        },
      },
    });

    if (member) {
      return evidence;
    }
  }

  const err: Error & { statusCode?: number } = new Error("Forbidden");
  err.statusCode = 403;
  throw err;
}

async function getEvidenceWithOwnerAccess(
  userId: string,
  evidenceId: string
): Promise<SelectedEvidence> {
  const evidence = await prisma.evidence.findUnique({
    where: { id: evidenceId },
    select: SAFE_EVIDENCE_SELECT,
  });

  if (!evidence) {
    const err: Error & { statusCode?: number } = new Error("Evidence not found");
    err.statusCode = 404;
    throw err;
  }

  if (evidence.ownerUserId !== userId) {
    const err: Error & { statusCode?: number } = new Error("Forbidden");
    err.statusCode = 403;
    throw err;
  }

  return evidence;
}

async function getTeamMembershipRole(teamId: string, userId: string) {
  const membership = await prisma.teamMember.findUnique({
    where: { teamId_userId: { teamId, userId } },
    select: { role: true },
  });

  return membership?.role ?? null;
}

async function canManageEvidenceCollaborativeContent(
  userId: string,
  evidence: SelectedEvidence
) {
  if (evidence.ownerUserId === userId) {
    return true;
  }

  if (!evidence.teamId) {
    return false;
  }

  const role = await getTeamMembershipRole(evidence.teamId, userId);
  return role === prismaPkg.TeamRole.OWNER || role === prismaPkg.TeamRole.ADMIN;
}

async function assertSavedViewAccess(
  userId: string,
  savedViewId: string
) {
  const savedView = await prisma.evidenceSavedView.findUnique({
    where: { id: savedViewId },
  });

  if (!savedView) {
    const err: Error & { statusCode?: number } = new Error("Saved view not found");
    err.statusCode = 404;
    throw err;
  }

  if (savedView.ownerUserId === userId) {
    return savedView;
  }

  if (savedView.teamId) {
    const role = await getTeamMembershipRole(savedView.teamId, userId);
    if (role) {
      return savedView;
    }
  }

  const err: Error & { statusCode?: number } = new Error("Forbidden");
  err.statusCode = 403;
  throw err;
}

function normalizeUserHeader(req: FastifyRequest) {
  const userAgent = req.headers["user-agent"];
  return Array.isArray(userAgent) ? userAgent[0] ?? null : userAgent ?? null;
}

function mapEvidenceSavedView(savedView: {
  id: string;
  ownerUserId: string;
  teamId: string | null;
  name: string;
  description: string | null;
  filtersJson: Prisma.JsonValue;
  sortKey: string | null;
  scope: string;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: savedView.id,
    ownerUserId: savedView.ownerUserId,
    teamId: savedView.teamId,
    name: savedView.name,
    description: savedView.description ?? null,
    filters: toJsonSafe(savedView.filtersJson),
    sortKey: savedView.sortKey ?? null,
    scope: savedView.scope,
    isDefault: savedView.isDefault,
    createdAt: savedView.createdAt.toISOString(),
    updatedAt: savedView.updatedAt.toISOString(),
  };
}

function mapCollaborativeAuthor(user: { id: string; displayName: string | null; email: string | null }) {
  return {
    id: user.id,
    displayName: user.displayName ?? null,
    email: user.email ?? null,
  };
}

function escapeCsvCell(value: string | null | undefined) {
  const text = String(value ?? "");
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, "\"\"")}"`;
  }
  return text;
}

function buildMetadataCsv(
  items: Array<{
    id: string;
    title: string;
    status: string;
    verificationStatus: string | null;
    type: string;
    mimeType: string | null;
    caseId: string | null;
    createdAt: string;
    archivedAt: string | null;
    deletedAt: string | null;
    latestReportVersion: number | null;
  }>
) {
  const rows = [
    [
      "Evidence ID",
      "Title",
      "Status",
      "Verification Status",
      "Type",
      "MIME Type",
      "Case ID",
      "Created At UTC",
      "Archived At UTC",
      "Deleted At UTC",
      "Report Version",
    ],
    ...items.map((item) => [
      item.id,
      item.title,
      item.status,
      item.verificationStatus ?? "",
      item.type,
      item.mimeType ?? "",
      item.caseId ?? "",
      item.createdAt,
      item.archivedAt ?? "",
      item.deletedAt ?? "",
      item.latestReportVersion ? String(item.latestReportVersion) : "",
    ]),
  ];

  return rows.map((row) => row.map((cell) => escapeCsvCell(cell)).join(",")).join("\n");
}

function must(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) throw new Error(`${name} is not set`);
  return v.trim();
}

const EvidenceListScopeSchema = z.enum([
  "active",
  "archived",
  "deleted",
  "locked",
  "all",
]);

const EvidenceListLimitSchema = z.coerce.number().int().min(1).max(100).default(50);
const EvidenceListCaseAssignmentSchema = z.enum(["all", "assigned", "unassigned"]);
const EvidenceListSortSchema = z.enum(["newest", "oldest", "priority"]);

type EvidenceListSort = z.infer<typeof EvidenceListSortSchema>;

type EvidenceListCursorPayload = {
  createdAt: string;
  id: string;
};

type EvidenceListQuery = {
  caseId: string | null;
  scope: z.infer<typeof EvidenceListScopeSchema>;
  limit: number;
  cursor: EvidenceListCursorPayload | null;
  search: string | null;
  status: prismaPkg.EvidenceStatus | null;
  type: string | null;
  caseAssignment: z.infer<typeof EvidenceListCaseAssignmentSchema>;
  reportReady: "all" | "ready" | "missing";
  sort: EvidenceListSort;
};

const EVIDENCE_LIST_SELECT = {
  id: true,
  title: true,
  type: true,
  mimeType: true,
  originalFileName: true,
  displayFileName: true,
  status: true,
  verificationStatus: true,
  captureMethod: true,
  identityLevelSnapshot: true,
  submittedByEmail: true,
  latestReportVersion: true,
  reportGeneratedAtUtc: true,
  reviewReadyAtUtc: true,
  createdAt: true,
  archivedAt: true,
  deletedAt: true,
  deleteScheduledForUtc: true,
  caseId: true,
  teamId: true,
  ownerUserId: true,
  storageBucket: true,
  storageKey: true,
  storageRegion: true,
  storageObjectLockMode: true,
  storageObjectLockRetainUntilUtc: true,
  storageObjectLockLegalHoldStatus: true,
  reviewWorkflow: {
    select: {
      status: true,
      priority: true,
      dueAt: true,
      assignedTo: {
        select: {
          id: true,
          email: true,
          displayName: true,
        },
      },
    },
  },
  _count: {
    select: { parts: true },
  },
} as const;

type SelectedEvidenceListItem = prismaPkg.Prisma.EvidenceGetPayload<{
  select: typeof EVIDENCE_LIST_SELECT;
}>;

function toJsonSafe<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v))
  );
}

function encodeEvidenceListCursor(value: EvidenceListCursorPayload): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeEvidenceListCursor(value: string | null | undefined): EvidenceListCursorPayload | null {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return null;

  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as {
      createdAt?: unknown;
      id?: unknown;
    };

    if (typeof parsed.createdAt !== "string" || typeof parsed.id !== "string") {
      return null;
    }

    const createdAt = new Date(parsed.createdAt);
    if (Number.isNaN(createdAt.getTime())) {
      return null;
    }

    if (!z.string().uuid().safeParse(parsed.id).success) {
      return null;
    }

    return {
      createdAt: createdAt.toISOString(),
      id: parsed.id,
    };
  } catch {
    return null;
  }
}

function parseEvidenceStatusFilter(
  value: string | null | undefined
): prismaPkg.EvidenceStatus | null {
  const raw = typeof value === "string" ? value.trim().toUpperCase() : "";
  if (!raw) return null;
  return EvidenceStatus && raw in EvidenceStatus
    ? (raw as prismaPkg.EvidenceStatus)
    : null;
}

function normalizeEvidenceListTypeFilter(value: string | null | undefined): string | null {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  return raw || null;
}

function parseEvidenceListQuery(query: Record<string, unknown>): EvidenceListQuery {
  const caseId =
    typeof query.caseId === "string" && query.caseId.trim()
      ? z.string().uuid().parse(query.caseId)
      : null;

  const scope =
    typeof query.scope === "string" && query.scope.trim().length > 0
      ? EvidenceListScopeSchema.parse(query.scope.trim().toLowerCase())
      : query.includeDeleted === "true"
        ? "deleted"
        : query.includeArchived === "true"
          ? "all"
          : "active";

  const limit = EvidenceListLimitSchema.parse(query.limit ?? undefined);
  const cursor = decodeEvidenceListCursor(
    typeof query.cursor === "string" ? query.cursor : null
  );

  if (typeof query.cursor === "string" && query.cursor.trim() && !cursor) {
    const err: Error & { statusCode?: number } = new Error("Invalid evidence list cursor");
    err.statusCode = 400;
    throw err;
  }

  const search =
    typeof query.search === "string" && query.search.trim().length > 0
      ? query.search.trim().slice(0, 160)
      : null;

  const statusRaw =
    typeof query.status === "string" && query.status.trim().length > 0
      ? query.status
      : null;
  const status = parseEvidenceStatusFilter(statusRaw);

  if (statusRaw && !status) {
    const err: Error & { statusCode?: number } = new Error("Invalid evidence status filter");
    err.statusCode = 400;
    throw err;
  }

  const type = normalizeEvidenceListTypeFilter(
    typeof query.type === "string" ? query.type : null
  );

  const caseAssignment =
    typeof query.caseAssignment === "string" && query.caseAssignment.trim().length > 0
      ? EvidenceListCaseAssignmentSchema.parse(query.caseAssignment.trim().toLowerCase())
      : "all";

  const reportReadyRaw =
    typeof query.reportReady === "string" && query.reportReady.trim().length > 0
      ? query.reportReady.trim().toLowerCase()
      : "all";

  if (!["all", "ready", "missing"].includes(reportReadyRaw)) {
    const err: Error & { statusCode?: number } = new Error("Invalid report readiness filter");
    err.statusCode = 400;
    throw err;
  }

  const sort =
    typeof query.sort === "string" && query.sort.trim().length > 0
      ? EvidenceListSortSchema.parse(query.sort.trim().toLowerCase())
      : "newest";

  return {
    caseId,
    scope,
    limit,
    cursor,
    search,
    status,
    type,
    caseAssignment,
    reportReady: reportReadyRaw as EvidenceListQuery["reportReady"],
    sort,
  };
}



async function buildPublicEvidenceContent(params: {
  accessPolicy: PublicVerifyContentAccessPolicy;
  previews?: Map<
    string,
    {
      previewDataUrl?: string | null;
      previewTextExcerpt?: string | null;
      previewCaption?: string | null;
    }
  >;
  evidence: {
    id: string;
    mimeType: string | null;
    sizeBytes: bigint | number | null;
    storageBucket: string | null;
    storageKey: string | null;
    fileSha256: string | null;
    intakePlanJson?: Prisma.JsonValue | null;
    originalFileName?: string | null;
    displayFileName?: string | null;
    recordedAt?: Date | string | null;
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
}): Promise<{
  summary: PublicEvidenceContentSummary;
  items: PublicEvidenceAsset[];
  primaryItem: PublicEvidenceAsset | null;
  previewPolicy: PublicPreviewPolicy;
}> {
  const multipart = params.parts.length > 1;
  const singlePart = params.parts.length === 1 ? params.parts[0]! : null;

  const accessPolicy = params.accessPolicy;
  const canExposeContent = accessPolicy.allowContentView;
  const canDownload = accessPolicy.allowDownload;

  const buildRoleDecision = (input: {
    privateRole?: string | null;
    checklistStepId?: string | null;
    fallbackRole: ReviewerArtifactRole;
    fallbackRoleSource: ReviewerArtifactRoleSource;
  }) =>
    resolveReviewerArtifactRole({
      privateRole: input.privateRole ?? null,
      checklistStepId: input.checklistStepId ?? null,
      intakePlanJson: params.evidence.intakePlanJson ?? null,
      fallbackRole: input.fallbackRole,
      fallbackRoleSource: input.fallbackRoleSource,
    });

  const roleAwareItems: PublicEvidenceAsset[] = multipart
    ? await Promise.all(
        params.parts.map(async (part) => {
          const kind = detectEvidenceAssetKind(part.mimeType);
          const sizeBytes = bigintToString(part.sizeBytes);
          const resolvedRole = buildRoleDecision({
            privateRole: part.privateRole ?? null,
            checklistStepId: part.checklistStepId ?? null,
            fallbackRole:
              params.evidence.storageBucket === part.storageBucket &&
              params.evidence.storageKey === part.storageKey
                ? "primary_evidence"
                : "supporting_evidence",
            fallbackRoleSource:
              params.evidence.storageBucket === part.storageBucket &&
              params.evidence.storageKey === part.storageKey
                ? "fallback_root"
                : "fallback_first",
          });
          const isPrimary = isPrimaryReviewerArtifactRole(
            resolvedRole.artifactRole
          );

          const canPreviewThisItem =
            canExposeContent && isPreviewableEvidenceKind(kind);

          const canExposeDirectUrl =
            (canPreviewThisItem || canDownload) &&
            Boolean(part.storageBucket) &&
            Boolean(part.storageKey);

          const viewUrl = canExposeDirectUrl
            ? await presignGetObject({
                bucket: part.storageBucket,
                key: part.storageKey,
                expiresInSeconds: 600,
              })
            : null;

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
            artifactRole: resolvedRole.artifactRole,
            artifactRoleLabel: getReviewerArtifactRoleLabel(
              resolvedRole.artifactRole
            ),
            artifactRoleSource: resolvedRole.roleSource,
            checklistStepId: resolvedRole.checklistStepId,
            checklistStepLabel: resolvedRole.checklistStepLabel,
            previewable: canPreviewThisItem,
            downloadable: canDownload,
            viewUrl,
            displaySizeLabel: formatBytesForDisplay(sizeBytes),
            previewRole: canPreviewThisItem
              ? isPrimary
                ? "primary_preview"
                : "secondary_preview"
              : canDownload
                ? "download_only"
                : "metadata_only",
            originalPreservationNote: buildOriginalPreservationNote({
              label,
              kind,
            }),
            reviewerRepresentationLabel: buildReviewerRepresentationLabel({
              kind,
              artifactRole: resolvedRole.artifactRole,
            }),
            reviewerRepresentationNote: buildReviewerRepresentationNote({
              kind,
              label,
              canExposeContent: canPreviewThisItem,
            }),
            verificationMaterialsNote: buildVerificationMaterialsNote({ kind }),
            previewDataUrl:
              canExposeContent ? preview?.previewDataUrl ?? null : null,
            previewTextExcerpt:
              canExposeContent ? preview?.previewTextExcerpt ?? null : null,
            previewCaption:
              canExposeContent ? preview?.previewCaption ?? null : null,
          };
        })
      )
    : singlePart || (params.evidence.storageBucket && params.evidence.storageKey)
      ? await Promise.all([
          (async () => {
            const bucket = singlePart?.storageBucket ?? params.evidence.storageBucket!;
            const key = singlePart?.storageKey ?? params.evidence.storageKey!;
            const mimeType = singlePart?.mimeType ?? params.evidence.mimeType;
            const sizeBytesValue =
              singlePart?.sizeBytes ?? params.evidence.sizeBytes;
            const sizeBytes = bigintToString(sizeBytesValue);
            const sha256 = singlePart?.sha256 ?? params.evidence.fileSha256;
            const itemId = singlePart?.id ?? params.evidence.id;
            const itemIndex = singlePart?.partIndex ?? 0;
            const kind = detectEvidenceAssetKind(mimeType);
            const resolvedRole = buildRoleDecision({
              privateRole: singlePart?.privateRole ?? null,
              checklistStepId: singlePart?.checklistStepId ?? null,
              fallbackRole: "primary_evidence",
              fallbackRoleSource: "fallback_single",
            });
            const previewable =
              canExposeContent && isPreviewableEvidenceKind(kind);
            const canExposeDirectUrl = previewable || canDownload;

            const label = getEvidencePartDisplayLabel({
              partIndex: itemIndex,
              mimeType,
              originalFileName:
                singlePart?.originalFileName ??
                params.evidence.originalFileName ??
                null,
              storageKey: key,
            });

            const preview = params.previews?.get(itemId);

            return {
              id: itemId,
              index: itemIndex,
              label,
              originalFileName:
                singlePart?.originalFileName ??
                params.evidence.originalFileName ??
                params.evidence.displayFileName ??
                resolveOriginalAssetDisplayName({
                  originalFileName:
                    singlePart?.originalFileName ??
                    params.evidence.originalFileName ??
                    null,
                  storageKey: key,
                  mimeType,
                  recordedAt: params.evidence.recordedAt ?? null,
                  partIndex: itemIndex,
                  multipart: false,
                }),
              mimeType: mimeType ?? null,
              kind,
              sizeBytes,
              durationMs: singlePart?.durationMs ?? null,
              sha256: sha256 ?? null,
              isPrimary: isPrimaryReviewerArtifactRole(resolvedRole.artifactRole),
              artifactRole: resolvedRole.artifactRole,
              artifactRoleLabel: getReviewerArtifactRoleLabel(
                resolvedRole.artifactRole
              ),
              artifactRoleSource: resolvedRole.roleSource,
              checklistStepId: resolvedRole.checklistStepId,
              checklistStepLabel: resolvedRole.checklistStepLabel,
              previewable,
              downloadable: canDownload,
              viewUrl: canExposeDirectUrl
                ? await presignGetObject({
                    bucket,
                    key,
                    expiresInSeconds: 600,
                  })
                : null,
              displaySizeLabel: formatBytesForDisplay(sizeBytes),
              previewRole: previewable
                ? "primary_preview"
                : canDownload
                  ? "download_only"
                  : "metadata_only",
              originalPreservationNote: buildOriginalPreservationNote({
                label,
                kind,
              }),
              reviewerRepresentationLabel: buildReviewerRepresentationLabel({
                kind,
                artifactRole: resolvedRole.artifactRole,
              }),
              reviewerRepresentationNote: buildReviewerRepresentationNote({
                kind,
                label,
                canExposeContent: previewable,
              }),
              verificationMaterialsNote: buildVerificationMaterialsNote({
                kind,
              }),
              previewDataUrl:
                canExposeContent ? preview?.previewDataUrl ?? null : null,
              previewTextExcerpt:
                canExposeContent ? preview?.previewTextExcerpt ?? null : null,
              previewCaption:
                canExposeContent ? preview?.previewCaption ?? null : null,
            };
          })(),
        ])
      : [];

  const items: PublicEvidenceAsset[] = sortPublicEvidenceItems(
    roleAwareItems
  ).map((item, index, list) => {
    if (list.some((candidate) => candidate.isPrimary)) {
      return {
        ...item,
        previewRole:
          item.previewRole === "metadata_only"
            ? ("metadata_only" as const)
            : item.isPrimary
              ? ("primary_preview" as const)
              : ("secondary_preview" as const),
      };
    }

    if (index !== 0) return item;

    return {
      ...item,
      isPrimary: true,
      artifactRole: "primary_evidence" as const,
      artifactRoleLabel: getReviewerArtifactRoleLabel("primary_evidence"),
      artifactRoleSource: multipart ? "fallback_first" : "fallback_single",
      previewRole:
        item.previewRole === "metadata_only"
          ? ("metadata_only" as const)
          : ("primary_preview" as const),
    };
  });

  const primaryItem =
    items.find((item) => item.isPrimary) ?? (items.length > 0 ? items[0] : null);

  const summary = items.reduce<PublicEvidenceContentSummary>(
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

  const previewPolicy: PublicPreviewPolicy = buildEvidencePreviewPolicy({
    itemCount: summary.itemCount,
    previewableItemCount: summary.previewableItemCount,
    downloadableItemCount: summary.downloadableItemCount,
    accessPolicy,
  });

  return {
    summary,
    items,
    primaryItem,
    previewPolicy,
  };
}

function buildPublicVerifyOverview(params: {
  evidence: {
    id: string;
    title: string | null;
    type?: prismaPkg.EvidenceType | null;
    status: prismaPkg.EvidenceStatus;
    verificationStatus: prismaPkg.VerificationStatus | null;
    captureMethod: prismaPkg.CaptureMethod | null;
    identityLevelSnapshot: prismaPkg.IdentityLevel | null;
    submittedByEmail: string | null;
    submittedByAuthProvider: prismaPkg.AuthProvider | null;
    workspaceNameSnapshot: string | null;
    organizationNameSnapshot: string | null;
    organizationVerifiedSnapshot: boolean | null;
    mimeType: string | null;
    createdAt: Date;
    capturedAtUtc: Date | null;
    uploadedAtUtc: Date | null;
    signedAtUtc: Date | null;
    recordedIntegrityVerifiedAtUtc: Date | null;
    lastVerifiedAtUtc: Date | null;
    lastVerifiedSource: prismaPkg.VerificationSource | null;
    // Phase D Blocker 1 — analytics-only timestamp of the most recent
    // anonymous /public/verify hit. NEVER conflated with technical
    // verification or reviewer verification.
    lastPublicVerifyViewAtUtc: Date | null;
    reviewReadyAtUtc: Date | null;
    verificationPackageGeneratedAtUtc: Date | null;
    verificationPackageVersion: number | null;
    latestReportVersion: number | null;
    reviewerSummaryVersion: number | null;
    reportGeneratedAtUtc: Date | null;
  };
  latestReport: { version: number; generatedAtUtc: Date } | null;
  itemCount: number;
  storageProtection: StorageProtectionSummary;
  timestampStatus: string | null;
  timestampDigestMatches: boolean | null;
  otsStatus: string | null;
  overallIntegrity: boolean;
  chainOfCustodyPresent: boolean;
  anchor: AnchorStatusSummary;
  contentSummary: PublicEvidenceContentSummary | null;
  trustDecision?: TrustDecision | null;
  // Phase D Blocker 1 — when this overview is being built for a public
  // /public/verify hit, this carries the timestamp of the CURRENT page view.
  // It is rendered separately (currentPublicVerifyViewAtUtc) and never
  // appears as "last verified".
  currentPublicVerifyViewAtUtc?: Date | null;
}) {
    const reportGeneratedAtUtc = params.latestReport?.generatedAtUtc
    ? params.latestReport.generatedAtUtc.toISOString()
    : params.evidence.reportGeneratedAtUtc
      ? params.evidence.reportGeneratedAtUtc.toISOString()
      : null;

  const reportVersion =
    params.latestReport?.version ?? params.evidence.latestReportVersion ?? null;

  return {
    recordStatus: mapRecordStatusLabel(params.evidence.status),
    recordLifecycleStatus: params.evidence.status,
    verificationStatus: mapVerificationStatusLabel(
      params.evidence.verificationStatus
    ),
    verificationStatusCode: params.evidence.verificationStatus,
    integrityHeadline: mapIntegrityHeadline({
      overallIntegrity: params.overallIntegrity,
      verificationStatus: params.evidence.verificationStatus,
      timestampDigestMatches: params.timestampDigestMatches,
      timestampStatus: params.timestampStatus,
      trustDecision: params.trustDecision ?? null,
    }),
    evidenceTitle: resolveEvidenceTitle(params.evidence.title),
    contentStructure: params.contentSummary?.structure ?? null,
    contentCompositionSummary: buildContentCompositionSummary(
  params.contentSummary
),
primaryContentLabel: buildPrimaryContentLabel(
  params.contentSummary?.primaryKind ?? null
),
    previewableItemCount: params.contentSummary?.previewableItemCount ?? null,
    downloadableItemCount: params.contentSummary?.downloadableItemCount ?? null,
    primaryContentKind: params.contentSummary?.primaryKind ?? null,
    totalContentSizeBytes: params.contentSummary?.totalSizeBytes ?? null,
    totalContentSizeDisplay: params.contentSummary?.totalSizeDisplay ?? null,
    evidenceId: params.evidence.id,
    evidenceType: mapEvidenceTypeLabel({
      type: params.evidence.type,
      mimeType: params.evidence.mimeType,
      itemCount: params.itemCount,
      contentSummary: params.contentSummary,
    }),
    evidenceStructure:
      params.itemCount > 1 ? "Multipart evidence package" : "Single evidence item",
    itemCount: params.itemCount,
    captureMethod: mapCaptureMethodLabel(params.evidence.captureMethod),
    captureMethodCode: params.evidence.captureMethod,
    mimeType: params.evidence.mimeType ?? null,
    // Phase 1 — `submittedByEmail` is always redacted on the public
    // surface. The call site in /public/verify passes null. For other
    // callers (evidence detail, reviewer surfaces) the field is still
    // resolved via the same maskPublicEmail helper, which keeps the
    // 1-character + domain mask for low-trust internal display.
    submittedByEmail: params.evidence.submittedByEmail
      ? maskPublicEmail(params.evidence.submittedByEmail)
      : null,
    submittedByAuthProvider: mapAuthProviderLabel(
      params.evidence.submittedByAuthProvider
    ),
    // Phase 1 — `submittedByAuthProviderCode` (raw enum like "GOOGLE"
    // / "APPLE" / "GUEST" / "EMAIL_PASSWORD") was a fingerprint-able
    // leak on top of the label. The label-only is sufficient public
    // signal. Removed from the response shape.
    identityLevel: mapIdentityLevelLabel(params.evidence.identityLevelSnapshot),
    identityLevelCode: params.evidence.identityLevelSnapshot ?? null,
    workspaceName: params.evidence.workspaceNameSnapshot ?? null,
    organizationName: params.evidence.organizationNameSnapshot ?? null,
    organizationVerified: params.evidence.organizationVerifiedSnapshot ?? null,
    createdAt: params.evidence.createdAt.toISOString(),
    // Issue #6 timestamp provenance: surface what each timestamp actually
    // means, not just its raw value.
    //   - capturedAtUtc is the SERVER-recorded intake time. It is NOT proof
    //     of when the underlying media was captured by a device. The
    //     deviceTimeIso field carries the (untrusted) client-provided device
    //     clock when available.
    //   - uploadedAtUtc is the SERVER-recorded completion time, set after
    //     parts are verified at S3 (headObject + sha256). It is NOT a TSA
    //     timestamp.
    //   - signedAtUtc is the SERVER-recorded signing time of the canonical
    //     fingerprint.
    //   - The trustworthy "this digest existed at or before X" signal is the
    //     TSA token (when present), not these three server-clock values.
    capturedAtUtc: params.evidence.capturedAtUtc
      ? params.evidence.capturedAtUtc.toISOString()
      : null,
    capturedAtUtcLabel: "Server-recorded intake time",
    capturedAtUtcProvenance: "server_clock",
    uploadedAtUtc: params.evidence.uploadedAtUtc
      ? params.evidence.uploadedAtUtc.toISOString()
      : null,
    uploadedAtUtcLabel: "Server-recorded upload completion time",
    uploadedAtUtcProvenance: "server_clock",
    signedAtUtc: params.evidence.signedAtUtc
      ? params.evidence.signedAtUtc.toISOString()
      : null,
    signedAtUtcLabel: "Server-recorded signing time",
    signedAtUtcProvenance: "server_clock",
    recordedIntegrityVerifiedAtUtc:
      params.evidence.recordedIntegrityVerifiedAtUtc
        ? params.evidence.recordedIntegrityVerifiedAtUtc.toISOString()
        : null,
    // Phase D Blocker 1 — "Last verified" is reserved for meaningful
    // technical verifications (report generation, explicit reviewer
    // technical-verification action). It is NOT the public-page view time.
    // The public-page-view time lives on lastPublicVerifyViewAtUtc and
    // currentPublicVerifyViewAtUtc, surfaced separately below.
    lastVerifiedAtUtc: params.evidence.lastVerifiedAtUtc
      ? params.evidence.lastVerifiedAtUtc.toISOString()
      : null,
    lastVerifiedSource: mapVerificationSourceLabel(
      params.evidence.lastVerifiedSource
    ),
    lastVerifiedSourceCode: params.evidence.lastVerifiedSource ?? null,
    lastVerifiedAtUtcLabel:
      "Last meaningful technical verification (report generation or reviewer technical-verification action). Public page views do not update this field.",
    // Public verify analytics (anonymous page views).
    lastPublicVerifyViewAtUtc: params.evidence.lastPublicVerifyViewAtUtc
      ? params.evidence.lastPublicVerifyViewAtUtc.toISOString()
      : null,
    lastPublicVerifyViewAtUtcLabel:
      "Most recent anonymous public verify page view (analytics only — not a technical verification).",
    currentPublicVerifyViewAtUtc:
      params.currentPublicVerifyViewAtUtc?.toISOString() ?? null,
    currentPublicVerifyViewAtUtcLabel:
      "Timestamp of the current public verify page request (analytics only — not a technical verification).",
    reviewReadyAtUtc: params.evidence.reviewReadyAtUtc
      ? params.evidence.reviewReadyAtUtc.toISOString()
      : null,
    verificationPackageGeneratedAtUtc:
      params.evidence.verificationPackageGeneratedAtUtc
        ? params.evidence.verificationPackageGeneratedAtUtc.toISOString()
        : null,
    verificationPackageVersion:
      params.evidence.verificationPackageVersion ?? null,
    reviewerSummaryVersion: params.evidence.reviewerSummaryVersion ?? null,
    reportVersion,
    reportGeneratedAtUtc,
    timestampStatus: mapTimestampStatusLabel(params.timestampStatus),
    otsStatus: mapOtsStatusLabel(params.otsStatus),
    storageProtection: mapStorageStatusLabel(params.storageProtection),
    chainOfCustodyPresent: params.chainOfCustodyPresent,
    // External publication is a SEPARATE feature from OTS / Bitcoin
    // anchoring. We only assert publication-present when a real public
    // URL exists. txid / anchoredAtUtc are OTS signals and must not
    // promote externalPublicationPresent here. The same rule is
    // mirrored in the human-summary builder and in the verification
    // package's anchor.json + package-manifest.json (verification-
    // package.ts) so every surface returns the same answer.
    externalPublicationPresent: Boolean(params.anchor.publicUrl),
    externalPublicationProvider: params.anchor.provider,
    externalPublicationUrl: params.anchor.publicUrl,
    externalPublicationAnchoredAtUtc: params.anchor.anchoredAtUtc,
  };
}

function buildPublicVerifyHumanSummary(params: {
  overview: ReturnType<typeof buildPublicVerifyOverview>;
  canonicalHashMatches: boolean;
  signatureValid: boolean;
  custodyChainValid: boolean;
  timestampDigestMatches: boolean | null;
  otsHashMatches: boolean | null;
  overallIntegrity: boolean;
  trustDecision?: TrustDecision | null;
}) {
  return {
    integrityStatus: params.overview.integrityHeadline,
    recordStatus: params.overview.recordStatus,
    verificationStatus: params.overview.verificationStatus,
    contentStructure: params.overview.contentStructure ?? null,
    previewableItemCount: params.overview.previewableItemCount ?? null,
    downloadableItemCount: params.overview.downloadableItemCount ?? null,
    totalContentSizeDisplay: params.overview.totalContentSizeDisplay ?? null,
    summary: mapIntegritySummaryText({
      overallIntegrity: params.overallIntegrity,
      canonicalHashMatches: params.canonicalHashMatches,
      signatureValid: params.signatureValid,
      custodyChainValid: params.custodyChainValid,
      timestampDigestMatches: params.timestampDigestMatches,
      otsHashMatches: params.otsHashMatches,
      trustDecision: params.trustDecision ?? null,
    }),
    whatIsVerified:
      "This verification checks the recorded integrity state of the evidence record, including fingerprint consistency, signature validation, recorded custody chain continuity, timestamp linkage, and OpenTimestamps linkage where available.",
    evidenceTitle: params.overview.evidenceTitle,
    evidenceId: params.overview.evidenceId,
    evidenceType: params.overview.evidenceType,
    evidenceStructure: params.overview.evidenceStructure,
    captureMethod: params.overview.captureMethod,
    fileType: params.overview.mimeType,
    submittedBy: params.overview.submittedByEmail,
    authProvider: params.overview.submittedByAuthProvider,
    identityLevel: params.overview.identityLevel,
    organization: params.overview.organizationName,
    workspace: params.overview.workspaceName,
    organizationVerified: params.overview.organizationVerified,
    createdAt: params.overview.createdAt,
    capturedAtUtc: params.overview.capturedAtUtc,
    uploadedAtUtc: params.overview.uploadedAtUtc,
    signedAtUtc: params.overview.signedAtUtc,
    recordedIntegrityVerifiedAtUtc:
      params.overview.recordedIntegrityVerifiedAtUtc,
    lastVerifiedAtUtc: params.overview.lastVerifiedAtUtc,
    lastVerifiedSource: params.overview.lastVerifiedSource,
    // Phase D Blocker 1 — propagate public-view analytics fields to the
    // human-summary surface so the verify page can render them as
    // "Last public verify page view" / "Current public verify page view"
    // rather than masquerading as "Last verified".
    lastPublicVerifyViewAtUtc: params.overview.lastPublicVerifyViewAtUtc,
    currentPublicVerifyViewAtUtc:
      params.overview.currentPublicVerifyViewAtUtc,
    chainOfCustodyPresent: params.overview.chainOfCustodyPresent,
    reportVersion: params.overview.reportVersion,
    reportGeneratedAtUtc: params.overview.reportGeneratedAtUtc,
    verificationPackageVersion: params.overview.verificationPackageVersion,
    verificationPackageGeneratedAtUtc:
      params.overview.verificationPackageGeneratedAtUtc,
    reviewerSummaryVersion: params.overview.reviewerSummaryVersion,
    timestampStatus: params.overview.timestampStatus,
    otsStatus: params.overview.otsStatus,
    storageProtection: params.overview.storageProtection,
    // Canonical rule: only a real public URL counts as external
    // publication present. anchoredAtUtc alone is an OTS / public-
    // anchoring signal and does not imply an external publication
    // record exists.
    externalPublicationPresent: Boolean(
      params.overview.externalPublicationUrl
    ),
    externalPublicationProvider: params.overview.externalPublicationProvider,
    externalPublicationUrl: params.overview.externalPublicationUrl,
    externalPublicationAnchoredAtUtc:
      params.overview.externalPublicationAnchoredAtUtc,
  };
}

function buildPublicVerifyLimitations() {
  return {
    short:
      "This page verifies the recorded integrity state of the evidence record. It does not independently prove factual truth, authorship, context, or legal admissibility.",
    detailed:
      "Technical verification supports detection of post-completion changes to the recorded evidence state. It does not by itself establish who created the content, whether the depicted events are true, or whether any court, insurer, regulator, or authority must accept the material.",
  };
}

function buildPublicReviewGuidance(params: {
  itemCount: number;
  previewableItemCount: number;
  overallIntegrity: boolean;
}) {
  return {
    reviewerWorkflow: [
      "First review the evidence content and item structure.",
      "Then review the recorded integrity outcome and custody chronology.",
      "Finally evaluate relevance, context, authorship, and admissibility separately.",
    ],
contentReviewNote:
  params.previewableItemCount > 0
    ? "The evidence content may be available for reviewer-facing inspection on this page, subject to the configured public verification access policy."
    : "The evidence content is not directly exposed here, but its recorded integrity state and supporting technical materials remain reviewable.",
        legalAssessmentNote:
      "Use the evidence content together with the technical verification record; neither should be treated as a substitute for the other.",
    integrityAssessmentNote: params.overallIntegrity
      ? "The recorded technical integrity checks passed for the available materials."
      : "One or more recorded technical integrity checks require manual review before relying on this record.",
    multipartReviewNote:
      params.itemCount > 1
        ? "This record contains multiple items and should be reviewed as a package, including the role of the primary item."
        : "This record contains a single primary evidence item.",
  };
}

function buildTechnicalMaterials(params: {
  evidence: {
    fileSha256: string | null;
    multipartManifestSha256?: string | null;
    hashSemantics?: string | null;
    fingerprintHash: string | null;
    signatureBase64: string | null;
    signingKeyId: string | null;
    signingKeyVersion: number | null;
    tsaMessageImprint: string | null;
    tsaInputDigestHex: string | null;
    tsaInputKind: string | null;
    otsProofBase64: string | null;
  };
  publicKeyPem: string;
  partsCount?: number;
}) {
  // Phase C #4 — surface multipart hash semantics so reviewers don't have
  // to guess what fileSha256 represents on multipart records.
  //
  // Resolved hashSemantics rules:
  //   - explicit column wins when set on Phase-C+ records.
  //   - for legacy records (column null), infer from partsCount when known:
  //     0 or 1 parts -> "single_file"; >1 -> "multipart_composite_legacy".
  //   - "multipart_composite_legacy" carries an extra warning that the
  //     dedicated multipartManifestSha256 column was not populated, so
  //     reviewers fall back to per-part hashes from the verification package.
  const explicitSemantics = params.evidence.hashSemantics ?? null;
  let resolvedSemantics: string | null = explicitSemantics;
  if (!resolvedSemantics) {
    if (typeof params.partsCount === "number") {
      resolvedSemantics =
        params.partsCount > 1
          ? "multipart_composite_legacy"
          : "single_file";
    }
  }

  return {
    fileSha256: params.evidence.fileSha256,
    fileSha256Label:
      resolvedSemantics === "single_file"
        ? "SHA-256 of the original file"
        : resolvedSemantics === "multipart_composite"
          ? "Synthetic composite of per-part SHA-256 hashes (multipart). See multipartManifestSha256 for the canonical reproducible digest."
          : resolvedSemantics === "multipart_composite_legacy"
            ? "Synthetic composite of per-part SHA-256 hashes (multipart, legacy record). multipartManifestSha256 was not stored at the time of completion; reproduce from per-part hashes in the verification package."
            : "Hash semantics unknown for this record",
    multipartManifestSha256: params.evidence.multipartManifestSha256 ?? null,
    multipartManifestSha256Label:
      "Reproducible SHA-256 of newline-joined per-part SHA-256 hashes in part-index order",
    hashSemantics: resolvedSemantics,
    fingerprintHash: params.evidence.fingerprintHash,
    signatureBase64: params.evidence.signatureBase64,
    publicKeyPem: params.publicKeyPem,
    signingKeyId: params.evidence.signingKeyId,
    signingKeyVersion: params.evidence.signingKeyVersion,
    tsaMessageImprint: params.evidence.tsaMessageImprint,
    tsaInputDigestHex: params.evidence.tsaInputDigestHex,
    tsaInputKind: params.evidence.tsaInputKind,
    legacyMode: !params.evidence.tsaInputDigestHex,
    otsProofPresent: Boolean(params.evidence.otsProofBase64),
  };
}

function mapPublicCustodyEvent(ev: {
  sequence: number;
  atUtc: Date;
  eventType: prismaPkg.CustodyEventType;
  payload: prismaPkg.Prisma.JsonValue | null;
  prevEventHash: string | null;
  eventHash: string | null;
}, context?: {
  itemCount?: number | null;
  structure?: "single" | "multipart" | null;
}): PublicVerifyTimelineEvent {
  return {
    sequence: ev.sequence,
    atUtc: ev.atUtc.toISOString(),
    eventType: ev.eventType,
    payloadSummary: summarizePublicPayload(ev.eventType, ev.payload, context),
prevEventHash: ev.prevEventHash,
eventHash: ev.eventHash,
    category: classifyCustodyEventType(ev.eventType),
  };
}

async function getAnchorStatus(
  evidenceId: string
): Promise<AnchorStatusSummary> {
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

  const resolvedPublicUrl =
    anchor.publicUrl?.trim() ||
    (publicBaseUrl &&
    (anchor.receiptId || anchor.transactionId || anchor.anchorHash)
      ? `${publicBaseUrl.replace(/\/+$/, "")}/${encodeURIComponent(
          anchor.receiptId ?? anchor.transactionId ?? anchor.anchorHash ?? ""
        )}`
      : null);

  const semantics = deriveAnchorSemantics({
    transactionId: anchor.transactionId ?? null,
    receiptId: anchor.receiptId ?? null,
    publicUrl: resolvedPublicUrl,
    anchoredAtUtc: anchor.anchoredAtUtc
      ? anchor.anchoredAtUtc.toISOString()
      : null,
    otsStatus: null,
    otsProofPresent: null,
  });

  return {
    mode: normalizeAnchorMode(anchor.mode),
    provider: anchor.provider ?? provider,
    publicBaseUrl,
    configured: Boolean(anchor.provider ?? provider),
    published: semantics.published,
    anchorHash: anchor.anchorHash ?? null,
    receiptId: anchor.receiptId ?? null,
    transactionId: anchor.transactionId ?? null,
    publicUrl: semantics.externalPublicationUrl,
    anchoredAtUtc: anchor.anchoredAtUtc
      ? anchor.anchoredAtUtc.toISOString()
      : null,
  };
}

function buildPublicCustodyLifecycle(params: {
  forensicEvents: PublicVerifyTimelineEvent[];
  accessEvents: PublicVerifyTimelineEvent[];
}): PublicCustodyLifecycle {
  return {
    forensicEventCount: params.forensicEvents.length,
    accessEventCount: params.accessEvents.length,
    forensicEvents: params.forensicEvents,
    accessEvents: params.accessEvents,
    chronologyNote:
      "Forensic events describe integrity-relevant lifecycle actions. Access events describe later viewing, download, or verification access activity.",
  };
}

type BillingOverviewSnapshot = Awaited<ReturnType<typeof readBillingOverview>>;

function resolveWorkspaceCapabilitySnapshot(params: {
  overview: BillingOverviewSnapshot;
  evidence: SelectedEvidence;
}) {
  const teamWorkspace = params.evidence.teamId
    ? params.overview.workspaces.teams.find(
        (team) => team.id === params.evidence.teamId
      ) ?? null
    : null;

  if (teamWorkspace) {
    return {
      workspaceType: "TEAM" as const,
      workspaceName:
        params.evidence.workspaceNameSnapshot?.trim() ||
        teamWorkspace.name ||
        "Team Workspace",
      plan: teamWorkspace.plan,
      effectivePlan: teamWorkspace.effectivePlan ?? teamWorkspace.plan,
      reportsIncluded: Boolean(teamWorkspace.features?.reportsIncluded),
      verificationPackageIncluded: Boolean(
        teamWorkspace.features?.verificationPackageIncluded
      ),
      publicVerifyIncluded: Boolean(teamWorkspace.features?.publicVerifyIncluded),
      billingStatus: teamWorkspace.billingStatus ?? null,
      storageUsedLabel: teamWorkspace.storage?.usedLabel ?? null,
      storageLimitLabel: teamWorkspace.storage?.limitLabel ?? null,
      storageRemainingLabel: teamWorkspace.storage?.remainingLabel ?? null,
      seatsIncluded: teamWorkspace.seats?.included ?? null,
      seatsUsed: teamWorkspace.seats?.used ?? null,
      seatsRemaining: teamWorkspace.seats?.remaining ?? null,
      overSeatLimit: teamWorkspace.overSeatLimit ?? null,
    };
  }

  return {
    workspaceType: "PERSONAL" as const,
    workspaceName:
      params.evidence.workspaceNameSnapshot?.trim() || "Personal Workspace",
    plan: params.overview.workspaces.personal.plan,
    effectivePlan: params.overview.workspaces.personal.plan,
    reportsIncluded: Boolean(
      params.overview.workspaces.personal.features?.reportsIncluded
    ),
    verificationPackageIncluded: Boolean(
      params.overview.workspaces.personal.features
        ?.verificationPackageIncluded
    ),
    publicVerifyIncluded: Boolean(
      params.overview.workspaces.personal.features?.publicVerifyIncluded
    ),
    billingStatus:
      params.overview.workspaces.personal.subscription?.status ?? null,
    storageUsedLabel: params.overview.workspaces.personal.storage?.usedLabel ?? null,
    storageLimitLabel:
      params.overview.workspaces.personal.storage?.limitLabel ?? null,
    storageRemainingLabel:
      params.overview.workspaces.personal.storage?.remainingLabel ?? null,
    seatsIncluded: null,
    seatsUsed: null,
    seatsRemaining: null,
    overSeatLimit: null,
  };
}

function readBooleanClientSignal(
  source: Prisma.JsonValue | null | undefined,
  key: string
): boolean | null {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return null;
  }

  const value = (source as Record<string, unknown>)[key];
  return typeof value === "boolean" ? value : null;
}

function readStringClientSignal(
  source: Prisma.JsonValue | null | undefined,
  key: string
): string | null {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return null;
  }

  const value = (source as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function buildSourceContext(params: {
  evidence: SelectedEvidence;
  parts: Array<{
    sourceLabel: string | null;
    clientSignals: Prisma.JsonValue | null;
    originalFileName: string | null;
    mimeType: string | null;
  }>;
}) {
  const folderPathPresent = params.parts.some(
    (part) => readBooleanClientSignal(part.clientSignals, "folderPathPresent") === true
  );
  const screenshotLike = params.parts.some(
    (part) => readBooleanClientSignal(part.clientSignals, "screenshotLike") === true
  );
  const genericMime = params.parts.some(
    (part) => readBooleanClientSignal(part.clientSignals, "genericMime") === true
  );
  const oldLastModified = params.parts.some(
    (part) => readBooleanClientSignal(part.clientSignals, "oldLastModified") === true
  );
  const duplicateSignals = params.parts
    .map((part) => readStringClientSignal(part.clientSignals, "duplicateStatus"))
    .filter((value): value is string => Boolean(value));
  const locationIncluded =
    hasCaptureLocationMetadata({
      lat: decimalToNumber(params.evidence.lat),
      lng: decimalToNumber(params.evidence.lng),
    }) ||
    params.parts.some(
      (part) => readBooleanClientSignal(part.clientSignals, "locationIncluded") === true
    );
  const captureMethod = params.evidence.captureMethod ?? null;
  const sourceType =
    folderPathPresent || captureMethod === prismaPkg.CaptureMethod.MULTIPART_PACKAGE
      ? "folder_upload"
      : captureMethod === prismaPkg.CaptureMethod.SECURE_CAMERA
        ? "native_capture"
        : captureMethod === prismaPkg.CaptureMethod.UPLOADED_FILE ||
            captureMethod === prismaPkg.CaptureMethod.IMPORTED_DOCUMENT
          ? "imported_upload"
          : "unknown";

  return {
    sourceType,
    captureMethod,
    captureMethodLabel: mapCaptureMethodLabel(captureMethod),
    importedUpload: sourceType === "imported_upload",
    nativeCapture: sourceType === "native_capture",
    folderUpload: sourceType === "folder_upload",
    // Issue #6 timestamp provenance (capture context surface).
    // deviceTimeIso is a CLIENT-supplied device/browser clock value at intake.
    // It is NOT verified server-side and must not be relied on as proof of
    // actual capture time. capturedAtUtc and uploadedAtUtc are server clocks.
    deviceTimeIso: params.evidence.deviceTimeIso ?? null,
    deviceTimeIsoLabel: "Client-reported device clock at intake (unverified)",
    deviceTimeIsoProvenance: "client_reported",
    capturedAtUtc: params.evidence.capturedAtUtc
      ? params.evidence.capturedAtUtc.toISOString()
      : null,
    capturedAtUtcLabel: "Server-recorded intake time",
    capturedAtUtcProvenance: "server_clock",
    uploadedAtUtc: params.evidence.uploadedAtUtc
      ? params.evidence.uploadedAtUtc.toISOString()
      : null,
    uploadedAtUtcLabel: "Server-recorded upload completion time",
    uploadedAtUtcProvenance: "server_clock",
    createdAt: params.evidence.createdAt.toISOString(),
    locationIncluded,
    sourceLabels: params.parts
      .map((part) => part.sourceLabel?.trim() ?? "")
      .filter(Boolean),
    clientSignalsSummary: {
      screenshotLike,
      genericMime,
      oldLastModified,
      folderPathPresent,
      duplicateSignals,
    },
    metadataAvailability: {
      nativeMetadataRecorded: params.parts.some(
        (part) => Boolean(part.originalFileName || part.mimeType)
      ),
      captureLocationRecorded: locationIncluded,
      clientSignalsRecorded: params.parts.some((part) => Boolean(part.clientSignals)),
    },
    limitations: [
      "Imported upload indicates PROOVRA preserved the uploaded file and recorded integrity state. It does not independently prove original capture source.",
    ],
  };
}

function buildResolvedReviewerAlerts(params: {
  evidenceIntelligence: EvidenceIntelligence | null;
  workspaceCapabilitySnapshot: ReturnType<typeof resolveWorkspaceCapabilitySnapshot>;
  anchor: AnchorStatusSummary;
  latestReportVersion: number | null;
  latestVerificationPackageVersion: number | null;
  evidence: SelectedEvidence;
}) {
  const baseAlerts =
    params.evidenceIntelligence?.reviewerAlerts?.filter((alert: EvidenceIntelligence["reviewerAlerts"][number]) => {
      if (alert.label !== "Public verification not configured") return true;

      if (!params.workspaceCapabilitySnapshot.publicVerifyIncluded) {
        return false;
      }

      return !params.anchor.published;
    }) ?? [];

  const operationalAlerts = [...baseAlerts];

  if (!params.workspaceCapabilitySnapshot.publicVerifyIncluded) {
    operationalAlerts.push({
      severity: "info" as const,
      label: "Public verification not included",
      detail:
        "Public verification is not included in the current workspace plan.",
    });
  } else if (!params.anchor.published) {
    operationalAlerts.push({
      severity: "warning" as const,
      label: "Public verification not published",
      detail:
        "Public verification is supported for this workspace, but a public verification record is not published yet.",
    });
  }

  if (!params.latestReportVersion) {
    operationalAlerts.push({
      severity: "warning" as const,
      label: "Report not generated",
      detail:
        "Generate a PDF report when a fixed review artifact is required.",
    });
  }

  if (
    params.workspaceCapabilitySnapshot.verificationPackageIncluded &&
    !params.latestVerificationPackageVersion
  ) {
    operationalAlerts.push({
      severity: "warning" as const,
      label: "Verification package not generated",
      detail:
        "Generate a verification package for offline or external review when needed.",
    });
  }

  if (!params.evidence.caseId) {
    operationalAlerts.push({
      severity: "info" as const,
      label: "No case assignment",
      detail:
        "Case assignment is not recorded for this evidence item.",
    });
  }

  return operationalAlerts;
}

async function buildStorageLimitPayload(params: {
  ownerUserId: string;
  evidenceId?: string | null;
  teamId?: string | null;
  req?: FastifyRequest;
  reason?: string | null;
  incomingBytes?: string | null;
}) {
  const overview = await readBillingOverview(params.ownerUserId);

  const workspace =
    params.teamId != null
      ? overview.workspaces.teams.find((team) => team.id === params.teamId) ?? null
      : overview.workspaces.personal;

  const upgradeSuggestion =
    workspace && workspace.workspaceType === "PERSONAL"
      ? workspace.plan === prismaPkg.PlanType.PAYG
        ? "Upgrading to PRO may be more cost-effective if you need recurring storage."
        : workspace.plan === prismaPkg.PlanType.PRO
          ? "If you need much larger storage, upgrading to TEAM may be more cost-effective."
          : "Upgrade your base plan to unlock more storage options."
      : workspace && workspace.workspaceType === "TEAM"
        ? "If your team keeps growing, a larger recurring storage add-on may be more cost-effective."
        : null;

  return {
    code: "STORAGE_LIMIT_REACHED",
    message: "Storage limit reached",
    billingWall: {
      type: "storage_limit_reached",
      reason: params.reason ?? "workspace_storage_exhausted",
      evidenceId: params.evidenceId ?? null,
      workspace,
      summary: overview.summary,
      storageAddons: overview.storageAddons,
      suggestedActions: [
        "add_storage",
        "upgrade_plan",
        "review_archived_evidence",
      ],
      upgradeSuggestion,
      incomingBytes: params.incomingBytes ?? null,
    },
  };
}

function sanitizeFileName(value: string | null | undefined): string | null {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return null;

  const normalized = raw.replace(/\\/g, "/").split("/").pop()?.trim() ?? "";
  if (!normalized || normalized === "." || normalized === "..") return null;

  return normalized;
}

function formatCaptureFileTimestamp(value: Date | string | null | undefined): string {
  const d =
    value instanceof Date
      ? value
      : typeof value === "string"
        ? new Date(value)
        : null;

  if (!d || Number.isNaN(d.getTime())) return "unknown-time";

  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  const ms = String(d.getUTCMilliseconds()).padStart(3, "0");

  return `${yyyy}-${mm}-${dd}_${hh}-${mi}-${ss}.${ms}Z`;
}

function buildGeneratedEvidenceFileName(params: {
  mimeType: string | null | undefined;
  recordedAt?: Date | string | null | undefined;
  partIndex?: number | null;
  multipart?: boolean;
}): string {
  const ext = extensionFromMimeType(params.mimeType);
  const extSuffix = ext ? `.${ext}` : "";
  const ts = formatCaptureFileTimestamp(params.recordedAt);

  const kind = detectEvidenceAssetKind(params.mimeType);
  const prefix =
    kind === "image"
      ? "PROOVRA-CAPTURE"
      : kind === "video"
        ? "PROOVRA-VIDEO-CAPTURE"
        : kind === "audio"
          ? "PROOVRA-AUDIO-CAPTURE"
          : kind === "pdf"
            ? "PROOVRA-DOCUMENT-CAPTURE"
            : "PROOVRA-EVIDENCE";

  const partSuffix =
    params.multipart && typeof params.partIndex === "number"
      ? `-ITEM-${params.partIndex + 1}`
      : "";

  return `${prefix}-${ts}${partSuffix}${extSuffix}`;
}

function resolveOriginalAssetDisplayName(params: {
  originalFileName?: string | null;
  storageKey?: string | null;
  mimeType?: string | null;
  recordedAt?: Date | string | null;
  partIndex?: number | null;
  multipart?: boolean;
}): string {
  const originalName = sanitizeFileName(params.originalFileName);
  if (originalName) return originalName;

  const fromStorageKey = sanitizeFileName(
    basenameFromStorageKey(
      params.storageKey ?? null,
      `evidence-file.${extensionFromMimeType(params.mimeType)}`
    )
  );

if (
  fromStorageKey &&
  fromStorageKey !== "0" &&
  fromStorageKey !== "1" &&
  fromStorageKey !== "2" &&
  fromStorageKey.toLowerCase() !== "original"
) {
  return fromStorageKey;
}

  return buildGeneratedEvidenceFileName({
    mimeType: params.mimeType ?? null,
    recordedAt: params.recordedAt ?? null,
    partIndex: params.partIndex ?? null,
    multipart: params.multipart ?? false,
  });
}

export async function evidenceRoutes(app: FastifyInstance) {
  app.post("/v1/evidence", { preHandler: requireAuthAndLegal }, async (req, reply) => {
    const body = CreateEvidenceBody.parse(req.body);
    const ownerUserId = getAuthUserId(req);
    const plan = await getUserPlan(ownerUserId);
    const limit = getTierLimit(plan);
    const rate = await enforceRateLimit({
      key: `ratelimit:evidence:create:${plan}:${ownerUserId}`,
      max: limit.max,
      windowSec: limit.windowSec,
    });

    if (!rate.allowed) {
      auditEvidenceAction(req, {
        userId: ownerUserId,
        action: "evidence.create",
        outcome: "blocked",
        severity: "warning",
        metadata: { reason: "rate_limit_exceeded", plan },
      });
      return reply.code(429).send({ message: "Rate limit exceeded" });
    }

    const normalizedChecksum = normalizeChecksumSha256Base64(
      body.checksumSha256Base64
    );
    const normalizedContentMd5 = normalizeContentMd5Base64(
      body.contentMd5Base64
    );

    if (body.checksumSha256Base64 && !normalizedChecksum) {
      return reply.code(400).send({ message: "Invalid checksumSha256Base64" });
    }

    if (body.contentMd5Base64 && !normalizedContentMd5) {
      return reply.code(400).send({ message: "Invalid contentMd5Base64" });
    }

    try {
const result = await createEvidence({
  ownerUserId,
  type: body.type,
  mimeType: body.mimeType,
  internalNotes: body.internalNotes ?? null,
  originalFileName: body.originalFileName,
  captureFileName: body.captureFileName,
  deviceTimeIso: body.deviceTimeIso,
  gps: body.gps,
  checksumSha256Base64: normalizedChecksum,
  contentMd5Base64: normalizedContentMd5,
intakePlanJson:
  body.intakePlanJson === null || body.intakePlanJson === undefined
    ? undefined
    : (body.intakePlanJson as Prisma.InputJsonValue),
      });

      auditEvidenceAction(req, {
        userId: ownerUserId,
        action: "evidence.create",
        outcome: "success",
        resourceId: result.id,
        metadata: {
          type: body.type,
          mimeType: body.mimeType ?? null,
          hasGps: Boolean(body.gps),
          captureSessionId: body.captureSessionId ?? null,
        },
      });

      // Phase 9.5 — apply workspace retention policy on create. Resolves
      // the workspace's defaultRetentionDays; only sets retentionUntilUtc
      // when it is longer than any existing explicit retention. Never
      // shortens. Failure-safe: if the policy lookup fails the evidence
      // creation has already succeeded — retention application is
      // observability and can be re-run later.
      try {
        const createdEvidence = await prisma.evidence.findUnique({
          where: { id: result.id },
          select: { teamId: true, retentionUntilUtc: true },
        });
        if (createdEvidence?.teamId) {
          const { applyRetentionPolicyOnCreate } = await import(
            "../services/governance.service.js"
          );
          await applyRetentionPolicyOnCreate({
            evidenceId: result.id,
            teamId: createdEvidence.teamId,
            existingRetentionUntilUtc: createdEvidence.retentionUntilUtc ?? null,
          });
        }
      } catch (err) {
        req.log?.warn?.(
          { err, evidenceId: result.id },
          "governance.retention.apply_failed",
        );
      }

      // If this Evidence was created from a CaptureSession draft, finalize the
      // draft so the audit trail is preserved (DRAFT → FINALIZED). Failures
      // here must NOT fail the create; the draft can be reaped/cleaned later.
      if (body.captureSessionId) {
        try {
          const draft = await prisma.captureSession.findUnique({
            where: { id: body.captureSessionId },
          });
          if (
            draft &&
            draft.ownerUserId === ownerUserId &&
            draft.status === prismaPkg.CaptureSessionStatus.DRAFT
          ) {
            await prisma.$transaction(async (tx) => {
              await tx.captureSession.update({
                where: { id: draft.id },
                data: {
                  status: prismaPkg.CaptureSessionStatus.FINALIZED,
                  finalizedEvidenceId: result.id,
                  finalizedAtUtc: new Date(),
                },
              });
              await tx.captureSessionEvent.create({
                data: {
                  sessionId: draft.id,
                  actorUserId: ownerUserId,
                  eventType: prismaPkg.CaptureSessionEventType.FINALIZED,
                  payload: {
                    evidenceId: result.id,
                  } as prismaPkg.Prisma.InputJsonValue,
                },
              });
            });
          }
        } catch (sessionErr) {
          req.log?.warn?.(
            { err: sessionErr, captureSessionId: body.captureSessionId, evidenceId: result.id },
            "capture_session_finalize_link_failed"
          );
        }
      }

      return reply.code(201).send(result);
    } catch (err) {
      if (
        err instanceof Error &&
        "code" in err &&
        (err as Error & { code?: string }).code === "STORAGE_LIMIT_REACHED"
      ) {
        const payload = await buildStorageLimitPayload({
          ownerUserId,
          req,
          reason: "create_evidence_blocked",
        });

        auditEvidenceAction(req, {
          userId: ownerUserId,
          action: "evidence.create",
          outcome: "blocked",
          severity: "warning",
          metadata: {
            reason: "STORAGE_LIMIT_REACHED",
          },
        });

        return reply.code(409).send(payload);
      }

if (
  err instanceof Error &&
  "code" in err &&
  (err as Error & { code?: string }).code === "INSUFFICIENT_CREDITS"
) {
  auditEvidenceAction(req, {
    userId: ownerUserId,
    action: "evidence.create",
    outcome: "blocked",
    severity: "warning",
    metadata: { reason: "INSUFFICIENT_CREDITS" },
  });
  return reply.code(402).send({
    code: "INSUFFICIENT_CREDITS",
    message: "Insufficient credits",
  });
}

      // Expected billing gate — TEAM workspace evidence requires an
      // active TEAM plan. This is a user-recoverable condition (switch
      // to personal workspace, or upgrade the team), NOT a server fault.
      // Audit at warning severity and return a typed 402 so the client
      // can render a friendly recovery prompt without staged materials
      // being lost. NEVER report this as a high-priority server error.
      if (
        err instanceof Error &&
        "code" in err &&
        (err as Error & { code?: string }).code === "TEAM_PLAN_REQUIRED"
      ) {
        auditEvidenceAction(req, {
          userId: ownerUserId,
          action: "evidence.create",
          outcome: "blocked",
          severity: "warning",
          metadata: { reason: "TEAM_PLAN_REQUIRED" },
        });
        return reply.code(402).send({
          code: "TEAM_PLAN_REQUIRED",
          message:
            "Team workspace evidence creation requires an active TEAM plan.",
          target: "TEAM",
          requiredPlan: "TEAM",
        });
      }

      if (err instanceof Error && err.message === "FREE_LIMIT_REACHED") {
        auditEvidenceAction(req, {
          userId: ownerUserId,
          action: "evidence.create",
          outcome: "blocked",
          severity: "warning",
          metadata: { reason: "FREE_LIMIT_REACHED" },
        });
        return reply.code(402).send({ message: "Free plan limit reached" });
      }

      auditEvidenceAction(req, {
        userId: ownerUserId,
        action: "evidence.create",
        outcome: "failure",
        severity: "critical",
        metadata: {
          reason: err instanceof Error ? err.message : "unknown_error",
        },
      });

      throw err;
    }
  });

  app.patch(
    "/v1/evidence/:id/label",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply) => {
      const ownerUserId = getAuthUserId(req);
      const id = z.string().uuid().parse((req.params as ParamsId).id);
      const body = UpdateEvidenceLabelBody.parse(req.body);

      (req as FastifyRequest & { evidenceId?: string }).evidenceId = id;
      req.log = req.log.child({ evidenceId: id });

      let evidence: SelectedEvidence;
      try {
        evidence = await getEvidenceWithOwnerAccess(ownerUserId, id);
      } catch (err) {
        const statusCode =
          err instanceof Error && "statusCode" in err
            ? (err as Error & { statusCode?: number }).statusCode ?? 500
            : 500;
        const message = err instanceof Error ? err.message : "Unexpected error";
        return reply.code(statusCode).send({ message });
      }

      if (evidence.deletedAt) {
        auditEvidenceAction(req, {
          userId: ownerUserId,
          action: "evidence.update_label",
          outcome: "blocked",
          severity: "warning",
          resourceId: id,
          metadata: { reason: "deleted_evidence" },
        });
        return reply.code(409).send({ message: "Evidence is deleted" });
      }
      try {
  assertEvidenceNotLocked(evidence);
} catch (err) {
  return reply.code(409).send({
    code: getErrorCode(err, "EVIDENCE_LOCKED"),
    message: "Evidence is permanently locked and cannot be renamed",
  });
}

      const updated = await prisma.evidence.update({
        where: { id },
        data: { title: body.label },
        select: SAFE_EVIDENCE_SELECT,
      });

      auditEvidenceAction(req, {
        userId: ownerUserId,
        action: "evidence.update_label",
        outcome: "success",
        resourceId: id,
        metadata: { label: body.label },
      });

const itemCount = await getEvidenceItemCount(id);

const storage = await getStorageProtectionSummary(
  updated.storageBucket,
  updated.storageKey,
  {
    storageRegion: updated.storageRegion,
    storageObjectLockMode: updated.storageObjectLockMode,
    storageObjectLockRetainUntilUtc: updated.storageObjectLockRetainUntilUtc,
    storageObjectLockLegalHoldStatus: updated.storageObjectLockLegalHoldStatus,
  }
);

      return reply.code(200).send({
        evidence: {
          ...toSafeEvidence(updated),
          storage,
        },
        itemCount,
        displayLabel: resolveEvidenceTitle(updated.title),
        displaySubtitle: buildEvidenceSubtitle({
          itemCount,
          status: updated.status,
          createdAt: updated.createdAt,
        }),
      });
    }
  );

  app.post(
    "/v1/evidence/:id/parts",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply) => {
      const ownerUserId = getAuthUserId(req);
      const id = z.string().uuid().parse((req.params as ParamsId).id);
      const body = CreatePartBody.parse(req.body);

      (req as FastifyRequest & { evidenceId?: string }).evidenceId = id;
      req.log = req.log.child({ evidenceId: id });

      const normalizedChecksum = normalizeChecksumSha256Base64(
        body.checksumSha256Base64
      );
      const normalizedContentMd5 = normalizeContentMd5Base64(
        body.contentMd5Base64
      );

      if (body.checksumSha256Base64 && !normalizedChecksum) {
        return reply.code(400).send({ message: "Invalid checksumSha256Base64" });
      }

      if (body.contentMd5Base64 && !normalizedContentMd5) {
        return reply.code(400).send({ message: "Invalid contentMd5Base64" });
      }

try {
  const evidence = await getEvidenceWithOwnerAccess(ownerUserId, id);
  assertEvidenceNotLocked(evidence);
} catch (err) {
  const statusCode =
    err instanceof Error && "statusCode" in err
      ? (err as Error & { statusCode?: number }).statusCode ?? 500
      : 500;

  return reply.code(statusCode).send({
code: getErrorCode(err, "PART_UPLOAD_BLOCKED"),
message:
  err instanceof Error ? err.message : "Evidence part cannot be created",
  });
}

      try {
        const result = await prisma.$transaction(async (tx) => {
          await tx.$executeRaw`
            SELECT pg_advisory_xact_lock(hashtext(${id}))
          `;

          const evidence = await tx.evidence.findUnique({
            where: { id },
            select: SAFE_EVIDENCE_SELECT,
          });

          if (!evidence || evidence.deletedAt) {
            const err: Error & { statusCode?: number } = new Error(
              "Evidence not found"
            );
            err.statusCode = 404;
            throw err;
          }

          if (evidence.ownerUserId !== ownerUserId) {
            const err: Error & { statusCode?: number } = new Error("Forbidden");
            err.statusCode = 403;
            throw err;
          }

          if (
            evidence.status === EvidenceStatus.SIGNED ||
            evidence.status === EvidenceStatus.REPORTED ||
            evidence.lockedAt
          ) {
            const err: Error & { statusCode?: number } = new Error(
              "Evidence is immutable"
            );
            err.statusCode = 409;
            throw err;
          }

          const existing = await tx.evidencePart.findFirst({
            where: { evidenceId: id, partIndex: body.partIndex },
          });

          if (existing) {
            return { part: existing, created: false as const };
          }

          // Phase 11 — pre-presign file validation (authenticated path).
          // Magic-byte sniffing is empty here because bytes are not yet
          // uploaded; the helper still blocks dangerous extensions,
          // double extensions, and dangerous claimed MIME. SecurityEvent
          // is recorded internally.
          const presignValidation = validateUploadedFile({
            teamId: evidence.teamId,
            evidenceId: evidence.id,
            fileName: body.originalFileName ?? null,
            claimedMime: body.mimeType ?? null,
            head: new Uint8Array(0),
            source: "authenticated",
          });
          if (presignValidation.outcome === "block") {
            const err: Error & {
              statusCode?: number;
              code?: string;
              reason?: string | null;
            } = new Error("File validation blocked");
            err.statusCode = 415;
            err.code = "FILE_VALIDATION_BLOCKED";
            err.reason = presignValidation.findings.reason;
            throw err;
          }

const bucket = must("S3_BUCKET");
const normalizedMimeType =
  normalizeMimeType(body.mimeType) ?? "application/octet-stream";

const safeOriginalFileName = sanitizeFileName(body.originalFileName);
const ext = extensionFromMimeType(normalizedMimeType);
const fallbackFileName =
  safeOriginalFileName ??
  `part-${body.partIndex + 1}${ext ? `.${ext}` : ""}`;

const key = `evidence/${id}/parts/${String(body.partIndex).padStart(3, "0")}-${fallbackFileName}`;

          // Upload truth semantics: do NOT mark uploadedAtUtc here.
          // A presigned URL being issued is not proof the object was uploaded.
          // uploadedByUserId is stored as the presign requester for traceability,
          // but uploadedAtUtc is intentionally null until completeEvidence()
          // verifies the object via headObject() and computes its sha256.
          const part = await tx.evidencePart.create({
            data: {
              evidenceId: id,
              partIndex: body.partIndex,
              storageBucket: bucket,
              storageKey: key,
              // Phase D Blocker 2 — strip any directory components the
              // browser may have leaked from a folder upload, normalize, and
              // drop leading dots. We persist only a safe basename so the
              // raw relative path never enters our database.
              originalFileName: sanitizeFileName(body.originalFileName),
              mimeType: normalizedMimeType,
              durationMs: body.durationMs ?? null,
              privateRole: body.privateRole?.trim() || null,
              privateNote: body.privateNote?.trim() || null,
              checklistStepId: body.checklistStepId?.trim() || null,
              sourceLabel: body.sourceLabel?.trim() || null,
              clientSignals:
                body.clientSignals === undefined
                  ? undefined
                  : body.clientSignals === null
                    ? prismaPkg.Prisma.JsonNull
                    : body.clientSignals,
              uploadedByUserId: ownerUserId,
              uploadedAtUtc: null,
            },
          });

          return { part, created: true as const };
        });

        auditEvidenceAction(req, {
          userId: ownerUserId,
          action: "evidence.part_presign_created",
          outcome: "success",
          resourceId: id,
          metadata: {
            partIndex: body.partIndex,
            created: result.created,
          },
        });

        const putUrl = await presignPutObject({
          bucket: result.part.storageBucket,
          key: result.part.storageKey,
          contentType: result.part.mimeType ?? "application/octet-stream",
          checksumSha256Base64: normalizedChecksum,
          contentMd5Base64: normalizedContentMd5,
          expiresInSeconds: 600,
        });

        if (!result.created) {
          return reply.code(200).send({
            part: result.part,
            upload: {
              bucket: result.part.storageBucket,
              key: result.part.storageKey,
              putUrl,
              checksumRequired: Boolean(normalizedChecksum),
              contentMd5Required: Boolean(normalizedContentMd5),
              expiresInSeconds: 600,
            },
          });
        }

        return reply.code(201).send({
          part: result.part,
          upload: {
            bucket: result.part.storageBucket,
            key: result.part.storageKey,
            putUrl,
            checksumRequired: Boolean(normalizedChecksum),
            contentMd5Required: Boolean(normalizedContentMd5),
            expiresInSeconds: 600,
          },
        });
      } catch (err) {
        auditEvidenceAction(req, {
          userId: ownerUserId,
          action: "evidence.part_presign_created",
          outcome: "failure",
          severity: "warning",
          resourceId: id,
          metadata: {
            reason: err instanceof Error ? err.message : "unknown_error",
            partIndex: body.partIndex,
          },
        });

        const statusCode =
          err instanceof Error && "statusCode" in err
            ? (err as Error & { statusCode?: number }).statusCode ?? 500
            : 500;
        const message = err instanceof Error ? err.message : "Unexpected error";
        return reply.code(statusCode).send({ message });
      }
    }
  );

  app.get(
    "/v1/evidence/:id/parts",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply) => {
      const ownerUserId = getAuthUserId(req);
      const id = z.string().uuid().parse((req.params as ParamsId).id);

      (req as FastifyRequest & { evidenceId?: string }).evidenceId = id;
      req.log = req.log.child({ evidenceId: id });

      let evidence: SelectedEvidence;
      try {
        evidence = await getEvidenceWithReadAccess(ownerUserId, id);
      } catch (err) {
        const statusCode =
          err instanceof Error && "statusCode" in err
            ? (err as Error & { statusCode?: number }).statusCode ?? 500
            : 500;
        const message = err instanceof Error ? err.message : "Unexpected error";
        return reply.code(statusCode).send({ message });
      }

      const parts = await prisma.evidencePart.findMany({
        where: { evidenceId: id },
        orderBy: { partIndex: "asc" },
      });

      const enrichedParts = await Promise.all(
        parts.map(async (part) => {
          const sizeBytes = bigintToString(part.sizeBytes);
          const kind = detectEvidenceAssetKind(part.mimeType);
          const url = await presignGetObject({
            bucket: part.storageBucket,
            key: part.storageKey,
            expiresInSeconds: 600,
          });

          const storage = await getStorageProtectionSummary(
            part.storageBucket,
            part.storageKey,
            {
              storageRegion: part.storageRegion ?? null,
              storageObjectLockMode: part.storageObjectLockMode ?? null,
              storageObjectLockRetainUntilUtc:
                part.storageObjectLockRetainUntilUtc ?? null,
              storageObjectLockLegalHoldStatus:
                part.storageObjectLockLegalHoldStatus ?? null,
            }
          );

const previewable = isPreviewableEvidenceKind(kind);

return {
  ...toJsonSafe(part),
  privateRole: part.privateRole ?? null,
  privateNote: part.privateNote ?? null,
  checklistStepId: part.checklistStepId ?? null,
  sourceLabel: part.sourceLabel ?? null,
  clientSignals: part.clientSignals ?? null,
  url,
  publicUrl: previewable ? url : null,
  previewUrl: previewable ? url : null,
  kind,
  previewable,
  label: getEvidencePartDisplayLabel({
    partIndex: part.partIndex,
    mimeType: part.mimeType,
    originalFileName: part.originalFileName ?? null,
    storageKey: part.storageKey,
  }),
  displayName: resolveOriginalAssetDisplayName({
    originalFileName: part.originalFileName ?? null,
    storageKey: part.storageKey,
    mimeType: part.mimeType,
    recordedAt: evidence.capturedAtUtc ?? evidence.createdAt,
    partIndex: part.partIndex,
    multipart: true,
  }),
  displaySizeLabel: formatBytesForDisplay(sizeBytes),
  isPrimary:
    evidence.storageBucket === part.storageBucket &&
    evidence.storageKey === part.storageKey,
  storage,
};
        })
      );

      auditEvidenceAction(req, {
        userId: ownerUserId,
        action: "evidence.parts_listed",
        outcome: "success",
        resourceId: id,
        metadata: { partCount: parts.length },
      });

      return reply.code(200).send({
        evidenceId: id,
        multipart: enrichedParts.length > 1,
        primary:
          evidence.storageBucket && evidence.storageKey
            ? {
                bucket: evidence.storageBucket,
                key: evidence.storageKey,
              }
            : null,
        parts: enrichedParts,
      });
    }
  );

  app.post(
    "/v1/evidence/claim",
    { preHandler: requireAuth },
    async (req, reply) => {
      const body = ClaimBody.parse(req.body);

      if (!body.guestToken) {
        return reply.code(400).send({ message: "guest_token_required" });
      }

      const secret = process.env.AUTH_JWT_SECRET;
      if (!secret) {
        return reply.code(500).send({ message: "AUTH_JWT_SECRET is not set" });
      }

      const payload = verifyJwt(body.guestToken, secret);
      if (payload.provider !== "GUEST") {
        return reply.code(400).send({ message: "invalid_guest_token" });
      }

      const guestUserId = payload.sub;
      const userId = getAuthUserId(req);

      const where = {
        ownerUserId: guestUserId,
        deletedAt: null,
        status: {
          notIn: [
            EvidenceStatus.SIGNED,
            EvidenceStatus.REPORTED,
          ] as prismaPkg.EvidenceStatus[],
        },
        ...(body.evidenceIds?.length ? { id: { in: body.evidenceIds } } : {}),
      };

      const evidence = await prisma.evidence.findMany({
        where,
        select: { id: true },
      });

      if (evidence.length === 0) {
        return reply.code(200).send({ claimed: 0 });
      }

      await prisma.evidence.updateMany({
        where,
        data: { ownerUserId: userId },
      });

      await prisma.guestIdentity.updateMany({
        where: { userId: guestUserId },
        data: { claimedByUserId: userId, claimedAt: new Date() },
      });

      for (const item of evidence) {
        await appendCustodyEvent({
          evidenceId: item.id,
          eventType: prismaPkg.CustodyEventType.EVIDENCE_CLAIMED,
          payload: { fromUserId: guestUserId, toUserId: userId },
          ip: req.ip,
          userAgent: req.headers["user-agent"],
        }).catch(() => null);

        auditEvidenceAction(req, {
          userId,
          action: "evidence.claimed",
          outcome: "success",
          resourceId: item.id,
          metadata: {
            fromUserId: guestUserId,
            toUserId: userId,
          },
        });
      }

      return reply.code(200).send({ claimed: evidence.length });
    }
  );

  app.post(
    "/v1/evidence/:id/lock",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply) => {
      const ownerUserId = getAuthUserId(req);
      const id = z.string().uuid().parse((req.params as ParamsId).id);
      const body = LockBody.parse(req.body);

      (req as FastifyRequest & { evidenceId?: string }).evidenceId = id;
      req.log = req.log.child({ evidenceId: id });

      let evidence: SelectedEvidence;
      try {
        evidence = await getEvidenceWithOwnerAccess(ownerUserId, id);
      } catch (err) {
        const statusCode =
          err instanceof Error && "statusCode" in err
            ? (err as Error & { statusCode?: number }).statusCode ?? 500
            : 500;
        const message = err instanceof Error ? err.message : "Unexpected error";
        return reply.code(statusCode).send({ message });
      }

      if (
        evidence.status !== prismaPkg.EvidenceStatus.SIGNED &&
        evidence.status !== prismaPkg.EvidenceStatus.REPORTED
      ) {
        auditEvidenceAction(req, {
          userId: ownerUserId,
          action: "evidence.lock",
          outcome: "blocked",
          severity: "warning",
          resourceId: id,
          metadata: { reason: "not_signed_yet" },
        });
        return reply
          .code(400)
          .send({ message: "Evidence must be signed before lock" });
      }

      if (body.locked) {
        const updated = await prisma.evidence.update({
          where: { id },
          data: { lockedAt: new Date(), lockedByUserId: ownerUserId },
          select: SAFE_EVIDENCE_SELECT,
        });

        await appendCustodyEvent({
          evidenceId: id,
          eventType: prismaPkg.CustodyEventType.EVIDENCE_LOCKED,
          payload: { lockedByUserId: ownerUserId },
          ip: req.ip,
          userAgent: req.headers["user-agent"],
        }).catch(() => null);

        auditEvidenceAction(req, {
          userId: ownerUserId,
          action: "evidence.lock",
          outcome: "success",
          resourceId: id,
          metadata: { lockedByUserId: ownerUserId },
        });

        const storage = await getStorageProtectionSummary(
          updated.storageBucket,
          updated.storageKey,
          {
            storageRegion: updated.storageRegion,
            storageObjectLockMode: updated.storageObjectLockMode,
            storageObjectLockRetainUntilUtc:
              updated.storageObjectLockRetainUntilUtc,
            storageObjectLockLegalHoldStatus:
              updated.storageObjectLockLegalHoldStatus,
          }
        );
        

        return reply.code(200).send({
          evidence: {
            ...toSafeEvidence(updated),
            storage,
          },
        });
      }
      

      return reply.code(400).send({ message: "Unlock is not allowed" });
    }
  );
  

  app.post(
    "/v1/evidence/:id/archive",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply) => {
      const ownerUserId = getAuthUserId(req);
      const id = z.string().uuid().parse((req.params as ParamsId).id);

      (req as FastifyRequest & { evidenceId?: string }).evidenceId = id;
      req.log = req.log.child({ evidenceId: id });

      let evidence: SelectedEvidence;
      try {
        evidence = await getEvidenceWithOwnerAccess(ownerUserId, id);
      } catch (err) {
        const statusCode =
          err instanceof Error && "statusCode" in err
            ? (err as Error & { statusCode?: number }).statusCode ?? 500
            : 500;
        const message = err instanceof Error ? err.message : "Unexpected error";
        return reply.code(statusCode).send({ message });
      }
      try {
  assertEvidenceNotLocked(evidence);
} catch (err) {
  return reply.code(409).send({
    code: getErrorCode(err, "EVIDENCE_LOCKED"),
    message: "Evidence is permanently locked and cannot be archived",
  });
}

// Phase 9.5 / Phase X.1 — legal hold check (fail-closed). Archive is
// destructive for downstream UX (hides the evidence from list views),
// so a hold must block it. Routed through the canonical gate
// orchestrator — same module the delete endpoint uses.
{
  const { runDestructiveActionGate } = await import(
    "../services/governance/destructive-action-gate.service.js"
  );
  const gate = await runDestructiveActionGate({
    action: "archive_evidence",
    actorUserId: ownerUserId,
    evidence: {
      id: evidence.id,
      teamId: evidence.teamId,
      retentionUntilUtc: evidence.retentionUntilUtc ?? null,
    },
    routeLabel: "archive",
    req,
  });
  if (gate.gated) {
    return reply.code(gate.statusCode).send(gate.body);
  }
}

      if (evidence.archivedAt) {
        const storage = await getStorageProtectionSummary(
          evidence.storageBucket,
          evidence.storageKey,
          {
            storageRegion: evidence.storageRegion,
            storageObjectLockMode: evidence.storageObjectLockMode,
            storageObjectLockRetainUntilUtc:
              evidence.storageObjectLockRetainUntilUtc,
            storageObjectLockLegalHoldStatus:
              evidence.storageObjectLockLegalHoldStatus,
          }
        );
        return reply.code(200).send({
          evidence: {
            ...toSafeEvidence(evidence),
            storage,
          },
        });
      }

      const updated = await prisma.evidence.update({
        where: { id },
        data: { archivedAt: new Date() },
        select: SAFE_EVIDENCE_SELECT,
      });

      await appendCustodyEvent({
        evidenceId: id,
        eventType: prismaPkg.CustodyEventType.EVIDENCE_ARCHIVED,
        payload: { archivedByUserId: ownerUserId },
        ip: req.ip,
        userAgent: req.headers["user-agent"],
      }).catch(() => null);

      auditEvidenceAction(req, {
        userId: ownerUserId,
        action: "evidence.archive",
        outcome: "success",
        resourceId: id,
        metadata: { archivedByUserId: ownerUserId },
      });

      const storage = await getStorageProtectionSummary(
        updated.storageBucket,
        updated.storageKey,
        {
          storageRegion: updated.storageRegion,
          storageObjectLockMode: updated.storageObjectLockMode,
          storageObjectLockRetainUntilUtc:
            updated.storageObjectLockRetainUntilUtc,
          storageObjectLockLegalHoldStatus:
            updated.storageObjectLockLegalHoldStatus,
        }
      );

      return reply.code(200).send({
        evidence: {
          ...toSafeEvidence(updated),
          storage,
        },
      });
    }
  );

  app.post(
    "/v1/evidence/:id/unarchive",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply) => {
      const ownerUserId = getAuthUserId(req);
      const id = z.string().uuid().parse((req.params as ParamsId).id);

      (req as FastifyRequest & { evidenceId?: string }).evidenceId = id;
      req.log = req.log.child({ evidenceId: id });

      let evidence: SelectedEvidence;
      try {
        evidence = await getEvidenceWithOwnerAccess(ownerUserId, id);
      } catch (err) {
        const statusCode =
          err instanceof Error && "statusCode" in err
            ? (err as Error & { statusCode?: number }).statusCode ?? 500
            : 500;
        const message = err instanceof Error ? err.message : "Unexpected error";
        return reply.code(statusCode).send({ message });
      }
      try {
  assertEvidenceNotLocked(evidence);
} catch (err) {
  return reply.code(409).send({
    code: getErrorCode(err, "EVIDENCE_LOCKED"),
    message: "Evidence is permanently locked and cannot be restored from archive",
  });
}

      if (!evidence.archivedAt) {
        const storage = await getStorageProtectionSummary(
          evidence.storageBucket,
          evidence.storageKey,
          {
            storageRegion: evidence.storageRegion,
            storageObjectLockMode: evidence.storageObjectLockMode,
            storageObjectLockRetainUntilUtc:
              evidence.storageObjectLockRetainUntilUtc,
            storageObjectLockLegalHoldStatus:
              evidence.storageObjectLockLegalHoldStatus,
          }
        );
        return reply.code(200).send({
          evidence: {
            ...toSafeEvidence(evidence),
            storage,
          },
        });
      }

      const updated = await prisma.evidence.update({
        where: { id },
        data: { archivedAt: null },
        select: SAFE_EVIDENCE_SELECT,
      });

await appendCustodyEvent({
  evidenceId: id,
  eventType: prismaPkg.CustodyEventType.EVIDENCE_RESTORED,
  payload: {
    restoredByUserId: ownerUserId,
    restoreSource: "archive",
  },
  ip: req.ip,
  userAgent: req.headers["user-agent"],
}).catch(() => null);

      auditEvidenceAction(req, {
        userId: ownerUserId,
        action: "evidence.unarchive",
        outcome: "success",
        resourceId: id,
        metadata: { restoredByUserId: ownerUserId },
      });

      const storage = await getStorageProtectionSummary(
        updated.storageBucket,
        updated.storageKey,
        {
          storageRegion: updated.storageRegion,
          storageObjectLockMode: updated.storageObjectLockMode,
          storageObjectLockRetainUntilUtc:
            updated.storageObjectLockRetainUntilUtc,
          storageObjectLockLegalHoldStatus:
            updated.storageObjectLockLegalHoldStatus,
        }
      );

      return reply.code(200).send({
        evidence: {
          ...toSafeEvidence(updated),
          storage,
        },
      });
    }
  );

  app.delete(
    "/v1/evidence/:id",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply) => {
      const ownerUserId = getAuthUserId(req);
      const id = z.string().uuid().parse((req.params as ParamsId).id);

      (req as FastifyRequest & { evidenceId?: string }).evidenceId = id;
      req.log = req.log.child({ evidenceId: id });

      let evidence: SelectedEvidence;
      try {
        evidence = await getEvidenceWithOwnerAccess(ownerUserId, id);
      } catch (err) {
        const statusCode =
          err instanceof Error && "statusCode" in err
            ? (err as Error & { statusCode?: number }).statusCode ?? 500
            : 500;
        const message = err instanceof Error ? err.message : "Unexpected error";
        return reply.code(statusCode).send({ message });
      }

      try {
  assertEvidenceNotLocked(evidence);
  assertEvidenceDeletionAllowedByRetention(evidence);
} catch (err) {
  return reply.code(409).send({
    code: getErrorCode(err, "DELETE_BLOCKED"),
    message:
      err instanceof Error
        ? err.message
        : "Evidence cannot be deleted in its current preservation state",
  });
}

// Phase 9.5 / Phase X.1 — fail-closed governance enforcement on
// destructive delete. The inline glue that previously lived here is
// extracted to `runDestructiveActionGate` (orchestrator service). The
// gate consolidates the membership lookup, sensitive-action decision,
// custody-event-on-block, and HTTP-status mapping in one place. The
// route handler stays a thin adapter: dispatch → branch on `gated`.
{
  const { runDestructiveActionGate } = await import(
    "../services/governance/destructive-action-gate.service.js"
  );
  const gate = await runDestructiveActionGate({
    action: "delete_evidence",
    actorUserId: ownerUserId,
    evidence: {
      id: evidence.id,
      teamId: evidence.teamId,
      retentionUntilUtc: evidence.retentionUntilUtc ?? null,
    },
    routeLabel: "delete",
    req,
  });
  if (gate.gated) {
    return reply.code(gate.statusCode).send(gate.body);
  }
}

      if (evidence.deletedAt) {
        auditEvidenceAction(req, {
          userId: ownerUserId,
          action: "evidence.delete",
          outcome: "blocked",
          severity: "warning",
          resourceId: id,
          metadata: { reason: "already_deleted" },
        });
        return reply.code(409).send({ message: "Evidence is already deleted" });
      }

      const now = new Date();
      const deleteScheduledForUtc = addDays(now, 90);

      const updated = await prisma.evidence.update({
        where: { id },
        data: {
          deletedAt: now,
          deletedAtUtc: now,
          deletedByUserId: ownerUserId,
          deleteScheduledForUtc,
        },
        select: SAFE_EVIDENCE_SELECT,
      });

      await appendCustodyEvent({
        evidenceId: id,
        eventType: prismaPkg.CustodyEventType.EVIDENCE_DELETE_SCHEDULED,
        payload: {
          deletedByUserId: ownerUserId,
          deletedAtUtc: now.toISOString(),
          deleteScheduledForUtc: deleteScheduledForUtc.toISOString(),
        },
        ip: req.ip,
        userAgent: req.headers["user-agent"],
      }).catch(() => null);

      auditEvidenceAction(req, {
        userId: ownerUserId,
        action: "evidence.delete",
        outcome: "success",
        resourceId: id,
        metadata: {
          deletedByUserId: ownerUserId,
          deleteScheduledForUtc: deleteScheduledForUtc.toISOString(),
        },
      });

      return reply.code(200).send({
        deleted: true,
        evidence: toJsonSafe({
          ...toSafeEvidence(updated),
        }),
      });
    }
  );

  app.post(
    "/v1/evidence/:id/restore",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply) => {
      const ownerUserId = getAuthUserId(req);
      const id = z.string().uuid().parse((req.params as ParamsId).id);
      const body = RestoreDeletedEvidenceBody.parse(req.body);

      (req as FastifyRequest & { evidenceId?: string }).evidenceId = id;
      req.log = req.log.child({ evidenceId: id });

      let evidence: SelectedEvidence | null;
      try {
        evidence = await prisma.evidence.findUnique({
          where: { id },
          select: SAFE_EVIDENCE_SELECT,
        });

        if (!evidence) {
          return reply.code(404).send({ message: "Evidence not found" });
        }

        if (evidence.ownerUserId !== ownerUserId) {
          return reply.code(403).send({ message: "Forbidden" });
        }
      } catch (err) {
        const statusCode =
          err instanceof Error && "statusCode" in err
            ? (err as Error & { statusCode?: number }).statusCode ?? 500
            : 500;
        const message = err instanceof Error ? err.message : "Unexpected error";
        return reply.code(statusCode).send({ message });
      }
      if (evidence.lockedAt) {
  return reply.code(409).send({
    code: "EVIDENCE_LOCKED",
    message: "Evidence is permanently locked and cannot be restored from trash",
  });
}

      if (!body.restore) {
        return reply.code(400).send({ message: "Restore is required" });
      }

      if (!evidence.deletedAt) {
        return reply.code(409).send({ message: "Evidence is not deleted" });
      }

      const updated = await prisma.evidence.update({
        where: { id },
        data: {
          deletedAt: null,
          deletedAtUtc: null,
          deletedByUserId: null,
          deleteScheduledForUtc: null,
        },
        select: SAFE_EVIDENCE_SELECT,
      });

      await appendCustodyEvent({
        evidenceId: id,
        eventType: prismaPkg.CustodyEventType.EVIDENCE_RESTORED,
        payload: { restoredByUserId: ownerUserId, restoreSource: "trash" },
        ip: req.ip,
        userAgent: req.headers["user-agent"],
      }).catch(() => null);

      auditEvidenceAction(req, {
        userId: ownerUserId,
        action: "evidence.restore",
        outcome: "success",
        resourceId: id,
        metadata: { restoredByUserId: ownerUserId, restoreSource: "trash" },
      });

      return reply.code(200).send({
        restored: true,
        evidence: toJsonSafe({
          ...toSafeEvidence(updated),
        }),
      });
    }
  );

  app.get("/v1/evidence", { preHandler: requireAuth }, async (req, reply) => {
    const ownerUserId = getAuthUserId(req);
    const parsedQuery = parseEvidenceListQuery(req.query as Record<string, unknown>);
    const {
      caseId,
      scope,
      limit,
      cursor,
      search,
      status,
      type,
      caseAssignment,
      reportReady,
      sort,
    } = parsedQuery;

    if (caseId) {
      await assertCaseAccess(ownerUserId, caseId);
    }

    const memberTeams = await prisma.teamMember.findMany({
      where: { userId: ownerUserId },
      select: { teamId: true },
    });
    const memberTeamIds = memberTeams.map((entry) => entry.teamId);

    const accessibleCases = await prisma.case.findMany({
      where: {
        OR: [
          { ownerUserId },
          { access: { some: { userId: ownerUserId } } },
          ...(memberTeamIds.length > 0
            ? [
                {
                  teamId: { in: memberTeamIds },
                  access: { none: {} },
                },
              ]
            : []),
        ],
      },
      select: { id: true },
    });
    const accessibleCaseIds = accessibleCases.map((entry) => entry.id);

    const baseWhere = buildEvidenceListBaseWhere({
      query: parsedQuery,
      userId: ownerUserId,
      memberTeamIds,
      accessibleCaseIds,
    });
    const cursorFilter = buildEvidenceListCursorFilter(cursor, sort);
    const where: Prisma.EvidenceWhereInput = cursorFilter
      ? {
          AND: [baseWhere, cursorFilter],
        }
      : baseWhere;

    const items = await prisma.evidence.findMany({
      where,
      orderBy: getEvidenceListOrderBy(sort),
      take: limit + 1,
      select: EVIDENCE_LIST_SELECT,
    });

    const hasMore = items.length > limit;
    const pageItems = hasMore ? items.slice(0, limit) : items;
    const nextCursor = hasMore
      ? encodeEvidenceListCursor({
          createdAt: pageItems[pageItems.length - 1].createdAt.toISOString(),
          id: pageItems[pageItems.length - 1].id,
        })
      : null;

    const mappedItems = pageItems.map(mapEvidenceListItem);

    auditEvidenceAction(req, {
      userId: ownerUserId,
      action: "evidence.list",
      outcome: "success",
      metadata: {
        scope,
        count: mappedItems.length,
        limit,
        sort,
        caseId,
        hasMore,
        filters: {
          search: search ? "applied" : "none",
          status,
          type,
          caseAssignment,
          reportReady,
          cursorApplied: Boolean(cursor),
        },
      },
    });

    return reply.code(200).send({
      scope,
      items: mappedItems,
      pageInfo: {
        limit,
        nextCursor,
        hasMore,
      },
    });
  });

  app.get("/v1/evidence/saved-views", { preHandler: requireAuth }, async (req, reply) => {
    const userId = getAuthUserId(req);
    const memberTeams = await prisma.teamMember.findMany({
      where: { userId },
      select: { teamId: true },
    });
    const memberTeamIds = memberTeams.map((item) => item.teamId);

    const items = await prisma.evidenceSavedView.findMany({
      where: {
        OR: [
          { ownerUserId: userId },
          ...(memberTeamIds.length > 0 ? [{ teamId: { in: memberTeamIds } }] : []),
        ],
      },
      orderBy: [{ isDefault: "desc" }, { updatedAt: "desc" }],
    });

    return reply.code(200).send({
      items: items.map(mapEvidenceSavedView),
    });
  });

  app.post("/v1/evidence/saved-views", { preHandler: requireAuth }, async (req, reply) => {
    const userId = getAuthUserId(req);
    const body = CreateSavedViewBody.parse(req.body);

    if (body.teamId) {
      const membership = await prisma.teamMember.findUnique({
        where: { teamId_userId: { teamId: body.teamId, userId } },
      });
      if (!membership) {
        return reply.code(403).send({ message: "Forbidden" });
      }
    }

    if (body.isDefault) {
      await prisma.evidenceSavedView.updateMany({
        where: {
          ownerUserId: userId,
          teamId: body.teamId ?? null,
          isDefault: true,
        },
        data: { isDefault: false },
      });
    }

    const created = await prisma.evidenceSavedView.create({
      data: {
        ownerUserId: userId,
        teamId: body.teamId ?? null,
        name: body.name,
        description: body.description ?? null,
        filtersJson: body.filters as Prisma.InputJsonValue,
        sortKey: body.sortKey ?? null,
        scope: body.scope,
        isDefault: body.isDefault,
      },
    });

    return reply.code(201).send({ savedView: mapEvidenceSavedView(created) });
  });

  app.patch("/v1/evidence/saved-views/:id", { preHandler: requireAuth }, async (req, reply) => {
    const userId = getAuthUserId(req);
    const id = z.string().uuid().parse((req.params as ParamsId).id);
    const body = UpdateSavedViewBody.parse(req.body);
    const savedView = await assertSavedViewAccess(userId, id);

    if (body.isDefault === true) {
      await prisma.evidenceSavedView.updateMany({
        where: {
          ownerUserId: savedView.ownerUserId,
          teamId: savedView.teamId,
          isDefault: true,
        },
        data: { isDefault: false },
      });
    }

    const updated = await prisma.evidenceSavedView.update({
      where: { id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description ?? null } : {}),
        ...(body.scope !== undefined ? { scope: body.scope } : {}),
        ...(body.filters !== undefined
          ? { filtersJson: body.filters as Prisma.InputJsonValue }
          : {}),
        ...(body.sortKey !== undefined ? { sortKey: body.sortKey ?? null } : {}),
        ...(body.isDefault !== undefined ? { isDefault: body.isDefault } : {}),
      },
    });

    return reply.code(200).send({ savedView: mapEvidenceSavedView(updated) });
  });

  app.delete("/v1/evidence/saved-views/:id", { preHandler: requireAuth }, async (req, reply) => {
    const userId = getAuthUserId(req);
    const id = z.string().uuid().parse((req.params as ParamsId).id);
    await assertSavedViewAccess(userId, id);
    await prisma.evidenceSavedView.delete({ where: { id } });
    return reply.code(200).send({ deleted: true });
  });

  app.post(
    "/v1/evidence/saved-views/:id/default",
    { preHandler: requireAuth },
    async (req, reply) => {
      const userId = getAuthUserId(req);
      const id = z.string().uuid().parse((req.params as ParamsId).id);
      const savedView = await assertSavedViewAccess(userId, id);

      await prisma.$transaction([
        prisma.evidenceSavedView.updateMany({
          where: {
            ownerUserId: savedView.ownerUserId,
            teamId: savedView.teamId,
            isDefault: true,
          },
          data: { isDefault: false },
        }),
        prisma.evidenceSavedView.update({
          where: { id },
          data: { isDefault: true },
        }),
      ]);

      const updated = await prisma.evidenceSavedView.findUniqueOrThrow({ where: { id } });
      return reply.code(200).send({ savedView: mapEvidenceSavedView(updated) });
    }
  );

  app.post("/v1/evidence/bulk", { preHandler: requireAuth }, async (req, reply) => {
    const userId = getAuthUserId(req);
    const body = BulkEvidenceActionBody.parse(req.body);
    const uniqueIds = [...new Set(body.evidenceIds)];
    const results: Array<{ evidenceId: string; ok: boolean; reason?: string }> = [];
    const updatedItems: Array<ReturnType<typeof mapEvidenceListItem>> = [];

    let caseItem:
      | {
          id: string;
          ownerUserId: string;
          teamId: string | null;
        }
      | null = null;

    if (body.action === "ADD_TO_CASE") {
      if (!body.caseId) {
        return reply.code(400).send({ message: "caseId is required for ADD_TO_CASE" });
      }
      caseItem = await prisma.case.findUnique({
        where: { id: body.caseId },
        select: { id: true, ownerUserId: true, teamId: true },
      });
      if (!caseItem) {
        return reply.code(404).send({ message: "Case not found" });
      }

      let canAccessCase = caseItem.ownerUserId === userId;
      if (!canAccessCase && caseItem.teamId) {
        canAccessCase = Boolean(
          await prisma.teamMember.findUnique({
            where: { teamId_userId: { teamId: caseItem.teamId, userId } },
          })
        );
      }
      if (!canAccessCase) {
        return reply.code(403).send({ message: "Forbidden" });
      }
    }

    for (const evidenceId of uniqueIds) {
      try {
        const evidence =
          body.action === "ADD_TO_CASE" ||
          body.action === "REMOVE_FROM_CASE" ||
          body.action === "ARCHIVE" ||
          body.action === "RESTORE_ARCHIVED" ||
          body.action === "TRASH" ||
          body.action === "RESTORE_TRASH"
            ? await getEvidenceWithOwnerAccess(userId, evidenceId)
            : await getEvidenceWithReadAccess(userId, evidenceId);

        switch (body.action) {
          case "ADD_TO_CASE": {
            if (!caseItem) {
              throw new Error("Case not found");
            }
            if (evidence.deletedAt) {
              throw new Error("Cannot add deleted evidence to a case");
            }
            const updated = await prisma.evidence.update({
              where: { id: evidenceId },
              data: { caseId: caseItem.id, teamId: caseItem.teamId ?? null },
              select: EVIDENCE_LIST_SELECT,
            });
            updatedItems.push(mapEvidenceListItem(updated));
            break;
          }
          case "REMOVE_FROM_CASE": {
            if (!evidence.caseId) {
              throw new Error("Evidence is not assigned to a case");
            }
            const updated = await prisma.evidence.update({
              where: { id: evidenceId },
              data: { caseId: null, teamId: null },
              select: EVIDENCE_LIST_SELECT,
            });
            updatedItems.push(mapEvidenceListItem(updated));
            break;
          }
          case "ARCHIVE": {
            assertEvidenceNotLocked(evidence);
            const updated = await prisma.evidence.update({
              where: { id: evidenceId },
              data: { archivedAt: new Date() },
              select: EVIDENCE_LIST_SELECT,
            });
            await appendCustodyEvent({
              evidenceId,
              eventType: prismaPkg.CustodyEventType.EVIDENCE_ARCHIVED,
              payload: { archivedByUserId: userId, source: "bulk" },
              ip: req.ip,
              userAgent: normalizeUserHeader(req),
            }).catch(() => null);
            updatedItems.push(mapEvidenceListItem(updated));
            break;
          }
          case "RESTORE_ARCHIVED": {
            assertEvidenceNotLocked(evidence);
            const updated = await prisma.evidence.update({
              where: { id: evidenceId },
              data: { archivedAt: null },
              select: EVIDENCE_LIST_SELECT,
            });
            await appendCustodyEvent({
              evidenceId,
              eventType: prismaPkg.CustodyEventType.EVIDENCE_RESTORED,
              payload: { restoredByUserId: userId, restoreSource: "archive_bulk" },
              ip: req.ip,
              userAgent: normalizeUserHeader(req),
            }).catch(() => null);
            updatedItems.push(mapEvidenceListItem(updated));
            break;
          }
          case "TRASH": {
            assertEvidenceNotLocked(evidence);
            assertEvidenceDeletionAllowedByRetention(evidence);
            const now = new Date();
            const deleteScheduledForUtc = addDays(now, 90);
            const updated = await prisma.evidence.update({
              where: { id: evidenceId },
              data: {
                deletedAt: now,
                deletedAtUtc: now,
                deletedByUserId: userId,
                deleteScheduledForUtc,
              },
              select: EVIDENCE_LIST_SELECT,
            });
            await appendCustodyEvent({
              evidenceId,
              eventType: prismaPkg.CustodyEventType.EVIDENCE_DELETE_SCHEDULED,
              payload: {
                deletedByUserId: userId,
                deletedAtUtc: now.toISOString(),
                deleteScheduledForUtc: deleteScheduledForUtc.toISOString(),
                source: "bulk",
              },
              ip: req.ip,
              userAgent: normalizeUserHeader(req),
            }).catch(() => null);
            updatedItems.push(mapEvidenceListItem(updated));
            break;
          }
          case "RESTORE_TRASH": {
            if (!evidence.deletedAt) {
              throw new Error("Evidence is not deleted");
            }
            assertEvidenceNotLocked(evidence);
            const updated = await prisma.evidence.update({
              where: { id: evidenceId },
              data: {
                deletedAt: null,
                deletedAtUtc: null,
                deletedByUserId: null,
                deleteScheduledForUtc: null,
              },
              select: EVIDENCE_LIST_SELECT,
            });
            await appendCustodyEvent({
              evidenceId,
              eventType: prismaPkg.CustodyEventType.EVIDENCE_RESTORED,
              payload: { restoredByUserId: userId, restoreSource: "trash_bulk" },
              ip: req.ip,
              userAgent: normalizeUserHeader(req),
            }).catch(() => null);
            updatedItems.push(mapEvidenceListItem(updated));
            break;
          }
          case "EXPORT_METADATA_CSV": {
            const exportItem = await prisma.evidence.findUnique({
              where: { id: evidenceId },
              select: EVIDENCE_LIST_SELECT,
            });
            if (!exportItem) {
              throw new Error("Evidence not found");
            }
            updatedItems.push(mapEvidenceListItem(exportItem));
            break;
          }
          default:
            throw new Error("Unsupported bulk action");
        }

        results.push({ evidenceId, ok: true });
      } catch (error) {
        results.push({
          evidenceId,
          ok: false,
          reason: error instanceof Error ? error.message : "Operation failed",
        });
      }
    }

    if (body.action === "EXPORT_METADATA_CSV") {
      const csvItems = results
        .filter((result) => result.ok)
        .map((result) => updatedItems.find((item) => item.id === result.evidenceId))
        .filter((item): item is ReturnType<typeof mapEvidenceListItem> => Boolean(item));

      const csv = buildMetadataCsv(csvItems);
      return reply.code(200).send({
        successCount: results.filter((item) => item.ok).length,
        failedCount: results.filter((item) => !item.ok).length,
        results,
        fileName: `evidence-metadata-${new Date().toISOString().slice(0, 10)}.csv`,
        csv,
      });
    }

    return reply.code(200).send({
      successCount: results.filter((item) => item.ok).length,
      failedCount: results.filter((item) => !item.ok).length,
      results,
      items: updatedItems,
    });
  });

  app.get("/v1/evidence/:id/comments", { preHandler: requireAuth }, async (req, reply) => {
    const userId = getAuthUserId(req);
    const id = z.string().uuid().parse((req.params as ParamsId).id);
    await getEvidenceWithReadAccess(userId, id);

    const comments = await prisma.evidenceReviewerComment.findMany({
      where: { evidenceId: id, deletedAt: null },
      include: { author: { select: { id: true, displayName: true, email: true } } },
      orderBy: { createdAt: "desc" },
    });

    return reply.code(200).send({
      items: comments.map((comment) => ({
        id: comment.id,
        evidenceId: comment.evidenceId,
        visibility: comment.visibility,
        body: comment.body,
        createdAt: comment.createdAt.toISOString(),
        updatedAt: comment.updatedAt.toISOString(),
        edited: comment.updatedAt.getTime() !== comment.createdAt.getTime(),
        author: mapCollaborativeAuthor(comment.author),
      })),
    });
  });

  app.post("/v1/evidence/:id/comments", { preHandler: requireAuth }, async (req, reply) => {
    const userId = getAuthUserId(req);
    const id = z.string().uuid().parse((req.params as ParamsId).id);
    const body = ReviewerCommentBody.parse(req.body);
    await getEvidenceWithReadAccess(userId, id);

    const created = await prisma.evidenceReviewerComment.create({
      data: {
        evidenceId: id,
        authorUserId: userId,
        body: body.body,
        visibility: body.visibility,
      },
      include: { author: { select: { id: true, displayName: true, email: true } } },
    });

    await appendReviewerAuditEvent({
      evidenceId: id,
      actorUserId: userId,
      eventType: prismaPkg.EvidenceReviewerAuditEventType.COMMENT_CREATED,
      metadata: {
        commentId: created.id,
        visibility: created.visibility,
      } as Prisma.InputJsonValue,
    }).catch(() => null);

    return reply.code(201).send({
      comment: {
        id: created.id,
        evidenceId: created.evidenceId,
        visibility: created.visibility,
        body: created.body,
        createdAt: created.createdAt.toISOString(),
        updatedAt: created.updatedAt.toISOString(),
        edited: false,
        author: mapCollaborativeAuthor(created.author),
      },
    });
  });

  app.patch(
    "/v1/evidence/:id/comments/:commentId",
    { preHandler: requireAuth },
    async (req, reply) => {
      const userId = getAuthUserId(req);
      const id = z.string().uuid().parse((req.params as ParamsId).id);
      const commentId = z.string().uuid().parse((req.params as { commentId: string }).commentId);
      const body = ReviewerCommentUpdateBody.parse(req.body);
      const evidence = await getEvidenceWithReadAccess(userId, id);
      const comment = await prisma.evidenceReviewerComment.findUnique({ where: { id: commentId } });

      if (!comment || comment.evidenceId !== id || comment.deletedAt) {
        return reply.code(404).send({ message: "Comment not found" });
      }

      const canManage =
        comment.authorUserId === userId ||
        (await canManageEvidenceCollaborativeContent(userId, evidence));
      if (!canManage) {
        return reply.code(403).send({ message: "Forbidden" });
      }

      const updated = await prisma.evidenceReviewerComment.update({
        where: { id: commentId },
        data: {
          ...(body.body !== undefined ? { body: body.body } : {}),
          ...(body.visibility !== undefined ? { visibility: body.visibility } : {}),
        },
        include: { author: { select: { id: true, displayName: true, email: true } } },
      });

      await appendReviewerAuditEvent({
        evidenceId: id,
        actorUserId: userId,
        eventType: prismaPkg.EvidenceReviewerAuditEventType.COMMENT_UPDATED,
        metadata: {
          commentId: updated.id,
          visibility: updated.visibility,
        } as Prisma.InputJsonValue,
      }).catch(() => null);

      return reply.code(200).send({
        comment: {
          id: updated.id,
          evidenceId: updated.evidenceId,
          visibility: updated.visibility,
          body: updated.body,
          createdAt: updated.createdAt.toISOString(),
          updatedAt: updated.updatedAt.toISOString(),
          edited: updated.updatedAt.getTime() !== updated.createdAt.getTime(),
          author: mapCollaborativeAuthor(updated.author),
        },
      });
    }
  );

  app.delete(
    "/v1/evidence/:id/comments/:commentId",
    { preHandler: requireAuth },
    async (req, reply) => {
      const userId = getAuthUserId(req);
      const id = z.string().uuid().parse((req.params as ParamsId).id);
      const commentId = z.string().uuid().parse((req.params as { commentId: string }).commentId);
      const evidence = await getEvidenceWithReadAccess(userId, id);
      const comment = await prisma.evidenceReviewerComment.findUnique({ where: { id: commentId } });

      if (!comment || comment.evidenceId !== id || comment.deletedAt) {
        return reply.code(404).send({ message: "Comment not found" });
      }

      const canManage =
        comment.authorUserId === userId ||
        (await canManageEvidenceCollaborativeContent(userId, evidence));
      if (!canManage) {
        return reply.code(403).send({ message: "Forbidden" });
      }

      await prisma.evidenceReviewerComment.update({
        where: { id: commentId },
        data: { deletedAt: new Date() },
      });

      await appendReviewerAuditEvent({
        evidenceId: id,
        actorUserId: userId,
        eventType: prismaPkg.EvidenceReviewerAuditEventType.COMMENT_DELETED,
        metadata: { commentId } as Prisma.InputJsonValue,
      }).catch(() => null);

      return reply.code(200).send({ deleted: true });
    }
  );

  app.get("/v1/evidence/:id/legal-notes", { preHandler: requireAuth }, async (req, reply) => {
    const userId = getAuthUserId(req);
    const id = z.string().uuid().parse((req.params as ParamsId).id);
    await getEvidenceWithReadAccess(userId, id);

    const items = await prisma.evidenceLegalNote.findMany({
      where: { evidenceId: id, deletedAt: null },
      include: { author: { select: { id: true, displayName: true, email: true } } },
      orderBy: { createdAt: "desc" },
    });

    return reply.code(200).send({
      items: items.map((note) => ({
        id: note.id,
        evidenceId: note.evidenceId,
        noteType: note.noteType,
        body: note.body,
        createdAt: note.createdAt.toISOString(),
        updatedAt: note.updatedAt.toISOString(),
        edited: note.updatedAt.getTime() !== note.createdAt.getTime(),
        author: mapCollaborativeAuthor(note.author),
      })),
    });
  });

  app.post("/v1/evidence/:id/legal-notes", { preHandler: requireAuth }, async (req, reply) => {
    const userId = getAuthUserId(req);
    const id = z.string().uuid().parse((req.params as ParamsId).id);
    const body = LegalNoteBody.parse(req.body);
    await getEvidenceWithReadAccess(userId, id);

    const created = await prisma.evidenceLegalNote.create({
      data: {
        evidenceId: id,
        authorUserId: userId,
        noteType: body.noteType,
        body: body.body,
      },
      include: { author: { select: { id: true, displayName: true, email: true } } },
    });

    await appendReviewerAuditEvent({
      evidenceId: id,
      actorUserId: userId,
      eventType: prismaPkg.EvidenceReviewerAuditEventType.LEGAL_NOTE_CREATED,
      metadata: {
        legalNoteId: created.id,
        noteType: created.noteType,
      } as Prisma.InputJsonValue,
    }).catch(() => null);

    return reply.code(201).send({
      legalNote: {
        id: created.id,
        evidenceId: created.evidenceId,
        noteType: created.noteType,
        body: created.body,
        createdAt: created.createdAt.toISOString(),
        updatedAt: created.updatedAt.toISOString(),
        edited: false,
        author: mapCollaborativeAuthor(created.author),
      },
    });
  });

  app.patch(
    "/v1/evidence/:id/legal-notes/:noteId",
    { preHandler: requireAuth },
    async (req, reply) => {
      const userId = getAuthUserId(req);
      const id = z.string().uuid().parse((req.params as ParamsId).id);
      const noteId = z.string().uuid().parse((req.params as { noteId: string }).noteId);
      const body = LegalNoteUpdateBody.parse(req.body);
      const evidence = await getEvidenceWithReadAccess(userId, id);
      const note = await prisma.evidenceLegalNote.findUnique({ where: { id: noteId } });

      if (!note || note.evidenceId !== id || note.deletedAt) {
        return reply.code(404).send({ message: "Legal note not found" });
      }

      const canManage =
        note.authorUserId === userId ||
        (await canManageEvidenceCollaborativeContent(userId, evidence));
      if (!canManage) {
        return reply.code(403).send({ message: "Forbidden" });
      }

      const updated = await prisma.evidenceLegalNote.update({
        where: { id: noteId },
        data: {
          ...(body.body !== undefined ? { body: body.body } : {}),
          ...(body.noteType !== undefined ? { noteType: body.noteType } : {}),
        },
        include: { author: { select: { id: true, displayName: true, email: true } } },
      });

      await appendReviewerAuditEvent({
        evidenceId: id,
        actorUserId: userId,
        eventType: prismaPkg.EvidenceReviewerAuditEventType.LEGAL_NOTE_UPDATED,
        metadata: {
          legalNoteId: updated.id,
          noteType: updated.noteType,
        } as Prisma.InputJsonValue,
      }).catch(() => null);

      return reply.code(200).send({
        legalNote: {
          id: updated.id,
          evidenceId: updated.evidenceId,
          noteType: updated.noteType,
          body: updated.body,
          createdAt: updated.createdAt.toISOString(),
          updatedAt: updated.updatedAt.toISOString(),
          edited: updated.updatedAt.getTime() !== updated.createdAt.getTime(),
          author: mapCollaborativeAuthor(updated.author),
        },
      });
    }
  );

  app.delete(
    "/v1/evidence/:id/legal-notes/:noteId",
    { preHandler: requireAuth },
    async (req, reply) => {
      const userId = getAuthUserId(req);
      const id = z.string().uuid().parse((req.params as ParamsId).id);
      const noteId = z.string().uuid().parse((req.params as { noteId: string }).noteId);
      const evidence = await getEvidenceWithReadAccess(userId, id);
      const note = await prisma.evidenceLegalNote.findUnique({ where: { id: noteId } });

      if (!note || note.evidenceId !== id || note.deletedAt) {
        return reply.code(404).send({ message: "Legal note not found" });
      }

      const canManage =
        note.authorUserId === userId ||
        (await canManageEvidenceCollaborativeContent(userId, evidence));
      if (!canManage) {
        return reply.code(403).send({ message: "Forbidden" });
      }

      await prisma.evidenceLegalNote.update({
        where: { id: noteId },
        data: { deletedAt: new Date() },
      });

      await appendReviewerAuditEvent({
        evidenceId: id,
        actorUserId: userId,
        eventType: prismaPkg.EvidenceReviewerAuditEventType.LEGAL_NOTE_DELETED,
        metadata: { legalNoteId: noteId } as Prisma.InputJsonValue,
      }).catch(() => null);

      return reply.code(200).send({ deleted: true });
    }
  );

  app.get("/v1/evidence/:id/annotations", { preHandler: requireAuth }, async (req, reply) => {
    const userId = getAuthUserId(req);
    const id = z.string().uuid().parse((req.params as ParamsId).id);
    await getEvidenceWithReadAccess(userId, id);

    const items = await prisma.evidenceAnnotation.findMany({
      where: { evidenceId: id, deletedAt: null },
      include: { author: { select: { id: true, displayName: true, email: true } } },
      orderBy: { createdAt: "desc" },
    });

    return reply.code(200).send({
      items: items.map((annotation) => ({
        id: annotation.id,
        evidenceId: annotation.evidenceId,
        evidencePartId: annotation.evidencePartId ?? null,
        annotationType: annotation.annotationType,
        body: annotation.body ?? null,
        pageNumber: annotation.pageNumber ?? null,
        mediaTimestampMs: annotation.mediaTimestampMs ?? null,
        x: annotation.x ?? null,
        y: annotation.y ?? null,
        width: annotation.width ?? null,
        height: annotation.height ?? null,
        coordinateSpace: annotation.coordinateSpace,
        createdAt: annotation.createdAt.toISOString(),
        updatedAt: annotation.updatedAt.toISOString(),
        edited: annotation.updatedAt.getTime() !== annotation.createdAt.getTime(),
        author: mapCollaborativeAuthor(annotation.author),
      })),
    });
  });

  app.post("/v1/evidence/:id/annotations", { preHandler: requireAuth }, async (req, reply) => {
    const userId = getAuthUserId(req);
    const id = z.string().uuid().parse((req.params as ParamsId).id);
    const body = AnnotationBody.parse(req.body);
    await getEvidenceWithReadAccess(userId, id);

    if (body.evidencePartId) {
      const part = await prisma.evidencePart.findUnique({ where: { id: body.evidencePartId } });
      if (!part || part.evidenceId !== id) {
        return reply.code(400).send({ message: "Annotation part does not belong to this evidence" });
      }
    }

    const created = await prisma.evidenceAnnotation.create({
      data: {
        evidenceId: id,
        evidencePartId: body.evidencePartId ?? null,
        authorUserId: userId,
        annotationType: body.annotationType,
        body: body.body ?? null,
        pageNumber: body.pageNumber ?? null,
        mediaTimestampMs: body.mediaTimestampMs ?? null,
        x: body.x ?? null,
        y: body.y ?? null,
        width: body.width ?? null,
        height: body.height ?? null,
        coordinateSpace: body.coordinateSpace,
      },
      include: { author: { select: { id: true, displayName: true, email: true } } },
    });

    await appendReviewerAuditEvent({
      evidenceId: id,
      actorUserId: userId,
      eventType: prismaPkg.EvidenceReviewerAuditEventType.ANNOTATION_CREATED,
      metadata: {
        annotationId: created.id,
        annotationType: created.annotationType,
        evidencePartId: created.evidencePartId ?? null,
      } as Prisma.InputJsonValue,
    }).catch(() => null);

    return reply.code(201).send({
      annotation: {
        id: created.id,
        evidenceId: created.evidenceId,
        evidencePartId: created.evidencePartId ?? null,
        annotationType: created.annotationType,
        body: created.body ?? null,
        pageNumber: created.pageNumber ?? null,
        mediaTimestampMs: created.mediaTimestampMs ?? null,
        x: created.x ?? null,
        y: created.y ?? null,
        width: created.width ?? null,
        height: created.height ?? null,
        coordinateSpace: created.coordinateSpace,
        createdAt: created.createdAt.toISOString(),
        updatedAt: created.updatedAt.toISOString(),
        edited: false,
        author: mapCollaborativeAuthor(created.author),
      },
    });
  });

  app.patch(
    "/v1/evidence/:id/annotations/:annotationId",
    { preHandler: requireAuth },
    async (req, reply) => {
      const userId = getAuthUserId(req);
      const id = z.string().uuid().parse((req.params as ParamsId).id);
      const annotationId = z
        .string()
        .uuid()
        .parse((req.params as { annotationId: string }).annotationId);
      const body = AnnotationUpdateBody.parse(req.body);
      const evidence = await getEvidenceWithReadAccess(userId, id);
      const annotation = await prisma.evidenceAnnotation.findUnique({ where: { id: annotationId } });

      if (!annotation || annotation.evidenceId !== id || annotation.deletedAt) {
        return reply.code(404).send({ message: "Annotation not found" });
      }

      const canManage =
        annotation.authorUserId === userId ||
        (await canManageEvidenceCollaborativeContent(userId, evidence));
      if (!canManage) {
        return reply.code(403).send({ message: "Forbidden" });
      }

      const updated = await prisma.evidenceAnnotation.update({
        where: { id: annotationId },
        data: {
          ...(body.evidencePartId !== undefined ? { evidencePartId: body.evidencePartId ?? null } : {}),
          ...(body.annotationType !== undefined ? { annotationType: body.annotationType } : {}),
          ...(body.body !== undefined ? { body: body.body ?? null } : {}),
          ...(body.pageNumber !== undefined ? { pageNumber: body.pageNumber ?? null } : {}),
          ...(body.mediaTimestampMs !== undefined
            ? { mediaTimestampMs: body.mediaTimestampMs ?? null }
            : {}),
          ...(body.x !== undefined ? { x: body.x ?? null } : {}),
          ...(body.y !== undefined ? { y: body.y ?? null } : {}),
          ...(body.width !== undefined ? { width: body.width ?? null } : {}),
          ...(body.height !== undefined ? { height: body.height ?? null } : {}),
          ...(body.coordinateSpace !== undefined
            ? { coordinateSpace: body.coordinateSpace }
            : {}),
        },
        include: { author: { select: { id: true, displayName: true, email: true } } },
      });

      await appendReviewerAuditEvent({
        evidenceId: id,
        actorUserId: userId,
        eventType: prismaPkg.EvidenceReviewerAuditEventType.ANNOTATION_UPDATED,
        metadata: {
          annotationId: updated.id,
          annotationType: updated.annotationType,
          evidencePartId: updated.evidencePartId ?? null,
        } as Prisma.InputJsonValue,
      }).catch(() => null);

      return reply.code(200).send({
        annotation: {
          id: updated.id,
          evidenceId: updated.evidenceId,
          evidencePartId: updated.evidencePartId ?? null,
          annotationType: updated.annotationType,
          body: updated.body ?? null,
          pageNumber: updated.pageNumber ?? null,
          mediaTimestampMs: updated.mediaTimestampMs ?? null,
          x: updated.x ?? null,
          y: updated.y ?? null,
          width: updated.width ?? null,
          height: updated.height ?? null,
          coordinateSpace: updated.coordinateSpace,
          createdAt: updated.createdAt.toISOString(),
          updatedAt: updated.updatedAt.toISOString(),
          edited: updated.updatedAt.getTime() !== updated.createdAt.getTime(),
          author: mapCollaborativeAuthor(updated.author),
        },
      });
    }
  );

  app.delete(
    "/v1/evidence/:id/annotations/:annotationId",
    { preHandler: requireAuth },
    async (req, reply) => {
      const userId = getAuthUserId(req);
      const id = z.string().uuid().parse((req.params as ParamsId).id);
      const annotationId = z
        .string()
        .uuid()
        .parse((req.params as { annotationId: string }).annotationId);
      const evidence = await getEvidenceWithReadAccess(userId, id);
      const annotation = await prisma.evidenceAnnotation.findUnique({ where: { id: annotationId } });

      if (!annotation || annotation.evidenceId !== id || annotation.deletedAt) {
        return reply.code(404).send({ message: "Annotation not found" });
      }

      const canManage =
        annotation.authorUserId === userId ||
        (await canManageEvidenceCollaborativeContent(userId, evidence));
      if (!canManage) {
        return reply.code(403).send({ message: "Forbidden" });
      }

      await prisma.evidenceAnnotation.update({
        where: { id: annotationId },
        data: { deletedAt: new Date() },
      });

      await appendReviewerAuditEvent({
        evidenceId: id,
        actorUserId: userId,
        eventType: prismaPkg.EvidenceReviewerAuditEventType.ANNOTATION_DELETED,
        metadata: { annotationId } as Prisma.InputJsonValue,
      }).catch(() => null);

      return reply.code(200).send({ deleted: true });
    }
  );

  app.get("/v1/evidence/:id/comparison", { preHandler: requireAuth }, async (req, reply) => {
    const userId = getAuthUserId(req);
    const id = z.string().uuid().parse((req.params as ParamsId).id);
    const evidence = await getEvidenceWithReadAccess(userId, id);
    const parts = await prisma.evidencePart.findMany({
      where: { evidenceId: id },
      orderBy: { partIndex: "asc" },
      select: {
        id: true,
        partIndex: true,
        originalFileName: true,
        mimeType: true,
        sha256: true,
        sizeBytes: true,
      },
    });
    const latestReport = await prisma.report.findFirst({
      where: { evidenceId: id },
      orderBy: { version: "desc" },
      select: { version: true, generatedAtUtc: true, verificationPackageVersion: true },
    });
    const latestPackage = await prisma.verificationPackage.findFirst({
      where: { evidenceId: id },
      orderBy: { version: "desc" },
      select: { version: true, generatedAtUtc: true, packageType: true, trustDecisionSnapshot: true },
    });

    return reply.code(200).send({
      evidenceId: id,
      original: {
        mimeType: evidence.mimeType ?? null,
        sizeBytes: bigintToString(evidence.sizeBytes),
        originalFileName: evidence.originalFileName ?? null,
        displayFileName: evidence.displayFileName ?? null,
        fileSha256: evidence.fileSha256 ?? null,
        fingerprintHash: evidence.fingerprintHash ?? null,
      },
      previewRepresentation: {
        mimeType: evidence.mimeType ?? null,
        primaryKind: detectEvidenceAssetKind(evidence.mimeType ?? null),
        previewable: isPreviewableEvidenceKind(detectEvidenceAssetKind(evidence.mimeType ?? null)),
      },
      reportArtifact: latestReport
        ? {
            version: latestReport.version,
            generatedAtUtc: latestReport.generatedAtUtc.toISOString(),
            verificationPackageVersion: latestReport.verificationPackageVersion ?? null,
          }
        : null,
      verificationPackage: latestPackage
        ? {
            version: latestPackage.version,
            generatedAtUtc: latestPackage.generatedAtUtc.toISOString(),
            packageType: latestPackage.packageType ?? null,
            manifestDigest: null,
            trustDecisionSnapshot: toJsonSafe(latestPackage.trustDecisionSnapshot),
          }
        : null,
      contentItems: parts.map((part) => ({
        id: part.id,
        partIndex: part.partIndex,
        originalFileName: part.originalFileName ?? null,
        mimeType: part.mimeType ?? null,
        sha256: part.sha256 ?? null,
        sizeBytes: bigintToString(part.sizeBytes),
      })),
      mismatchFlags: {
        originalVsRecordedHash: evidence.fileSha256 ? null : null,
        originalVsVerificationPackageManifest: null,
        previewVsOriginal: null,
      },
    });
  });

  app.get("/v1/evidence/:id/duplicates", { preHandler: requireAuth }, async (req, reply) => {
    const userId = getAuthUserId(req);
    const id = z.string().uuid().parse((req.params as ParamsId).id);
    const evidence = await getEvidenceWithReadAccess(userId, id);
    const accessContext = await getAccessibleEvidenceContext(userId);
    const accessWhere = buildEvidenceListBaseWhere({
      query: {
        caseId: null,
        scope: "all",
        limit: 100,
        cursor: null,
        search: null,
        status: null,
        type: null,
        caseAssignment: "all",
        reportReady: "all",
        sort: "newest",
      },
      userId,
      memberTeamIds: accessContext.memberTeamIds,
      accessibleCaseIds: accessContext.accessibleCaseIds,
    });

    const partHashes = await prisma.evidencePart.findMany({
      where: { evidenceId: id, sha256: { not: null } },
      select: { sha256: true },
    });
    const partHashValues = partHashes.map((part) => part.sha256).filter((value): value is string => Boolean(value));

    const [exactHashMatches, fingerprintMatches, partHashMatches, possibleMetadataMatches] =
      await Promise.all([
        evidence.fileSha256
          ? prisma.evidence.findMany({
              where: {
                AND: [
                  accessWhere,
                  { id: { not: id } },
                  { fileSha256: evidence.fileSha256 },
                ],
              },
              select: EVIDENCE_LIST_SELECT,
              take: 20,
            })
          : Promise.resolve([]),
        evidence.fingerprintHash
          ? prisma.evidence.findMany({
              where: {
                AND: [
                  accessWhere,
                  { id: { not: id } },
                  { fingerprintHash: evidence.fingerprintHash },
                ],
              },
              select: EVIDENCE_LIST_SELECT,
              take: 20,
            })
          : Promise.resolve([]),
        partHashValues.length > 0
          ? prisma.evidence.findMany({
              where: {
                AND: [
                  accessWhere,
                  { id: { not: id } },
                  { parts: { some: { sha256: { in: partHashValues } } } },
                ],
              },
              select: EVIDENCE_LIST_SELECT,
              take: 20,
            })
          : Promise.resolve([]),
        evidence.originalFileName && evidence.mimeType && evidence.sizeBytes
          ? prisma.evidence.findMany({
              where: {
                AND: [
                  accessWhere,
                  { id: { not: id } },
                  { originalFileName: evidence.originalFileName },
                  { mimeType: evidence.mimeType },
                  { sizeBytes: evidence.sizeBytes },
                ],
              },
              select: EVIDENCE_LIST_SELECT,
              take: 20,
            })
          : Promise.resolve([]),
      ]);

    return reply.code(200).send({
      exactHashMatches: exactHashMatches.map(mapEvidenceListItem),
      fingerprintMatches: fingerprintMatches.map(mapEvidenceListItem),
      partHashMatches: partHashMatches.map(mapEvidenceListItem),
      possibleMetadataMatches: possibleMetadataMatches.map(mapEvidenceListItem),
      limitation:
        "Duplicate detection is limited to accessible records and recorded hashes or metadata.",
    });
  });

  app.get(
    "/v1/evidence/:id/reviewer-workflow",
    { preHandler: requireAuth },
    async (req, reply) => {
      const userId = getAuthUserId(req);
      const id = z.string().uuid().parse((req.params as ParamsId).id);
      await getEvidenceWithReadAccess(userId, id);

      return reply.code(200).send(await getEvidenceReviewerWorkflowSummary(id));
    }
  );

  app.patch(
    "/v1/evidence/:id/reviewer-workflow",
    { preHandler: requireAuth },
    async (req, reply) => {
      const userId = getAuthUserId(req);
      const id = z.string().uuid().parse((req.params as ParamsId).id);
      const body = ReviewerWorkflowUpdateBody.parse(req.body);
      const evidence = await getEvidenceWithReadAccess(userId, id);

      if (body.assignedToUserId) {
        const targetUserAccessible =
          evidence.ownerUserId === body.assignedToUserId ||
          (evidence.caseId
            ? await prisma.caseAccess.findFirst({
                where: {
                  caseId: evidence.caseId,
                  userId: body.assignedToUserId,
                },
                select: { caseId: true },
              })
            : evidence.teamId
              ? await prisma.teamMember.findFirst({
                  where: {
                    teamId: evidence.teamId,
                    userId: body.assignedToUserId,
                  },
                  select: { id: true },
                })
              : null);

        if (!targetUserAccessible) {
          return reply
            .code(400)
            .send({ message: "Assigned reviewer must have access to this evidence record" });
        }
      }

      const summary = await upsertEvidenceReviewerWorkflow({
        evidenceId: id,
        workspaceType: evidence.teamId ? "TEAM" : "PERSONAL",
        teamId: evidence.teamId ?? null,
        actorUserId: userId,
        assignedToUserId: body.assignedToUserId,
        status: body.status,
        priority: body.priority,
        dueAt:
          body.dueAt === undefined
            ? undefined
            : body.dueAt
              ? new Date(body.dueAt)
              : null,
        note: body.note ?? null,
      });

      await appendReviewerAuditEvent({
        evidenceId: id,
        actorUserId: userId,
        eventType: prismaPkg.EvidenceReviewerAuditEventType.WORKFLOW_UPDATED,
        metadata: {
          assignedToUserId: body.assignedToUserId ?? undefined,
          status: body.status ?? undefined,
          priority: body.priority ?? undefined,
          dueAt: body.dueAt ?? undefined,
        } as Prisma.InputJsonValue,
      }).catch(() => null);

      return reply.code(200).send(summary);
    }
  );

  // Phase 6 — external intake source summary. Authenticated workspace
  // members only. Returns null safely when the evidence did NOT arrive via
  // external intake (which is the common case for existing evidence).
  app.get(
    "/v1/evidence/:id/external-intake-summary",
    { preHandler: requireAuth },
    async (req, reply) => {
      const userId = getAuthUserId(req);
      const id = z.string().uuid().parse((req.params as ParamsId).id);
      await getEvidenceWithReadAccess(userId, id);

      const { loadExternalIntakeSourceSummary } = await import(
        "../services/external-intake-source-summary.service.js"
      );
      const summary = await loadExternalIntakeSourceSummary(id);
      return reply.code(200).send({ summary });
    },
  );

  app.get(
    "/v1/evidence/:id/reviewer-workflow/events",
    { preHandler: requireAuth },
    async (req, reply) => {
      const userId = getAuthUserId(req);
      const id = z.string().uuid().parse((req.params as ParamsId).id);
      await getEvidenceWithReadAccess(userId, id);

      const items = await listEvidenceReviewerWorkflowEvents(id);
      return reply.code(200).send({
        items: items.map((item) => ({
          id: item.id,
          eventType: item.eventType,
          note: item.note ?? null,
          previousValue: toJsonSafe(item.previousValue ?? null),
          nextValue: toJsonSafe(item.nextValue ?? null),
          createdAt: item.createdAt.toISOString(),
          actor: item.actor ? mapCollaborativeAuthor(item.actor) : null,
        })),
      });
    }
  );

  app.get(
    "/v1/evidence/:id/relationships",
    { preHandler: requireAuth },
    async (req, reply) => {
      const userId = getAuthUserId(req);
      const id = z.string().uuid().parse((req.params as ParamsId).id);
      await getEvidenceWithReadAccess(userId, id);

      return reply.code(200).send({
        items: await listEvidenceRelationships(id),
      });
    }
  );

  app.post(
    "/v1/evidence/:id/relationships",
    { preHandler: requireAuth },
    async (req, reply) => {
      const userId = getAuthUserId(req);
      const id = z.string().uuid().parse((req.params as ParamsId).id);
      const body = RelationshipBody.parse(req.body);
      const evidence = await getEvidenceWithReadAccess(userId, id);
      const target = await getEvidenceWithReadAccess(userId, body.targetEvidenceId);

      const relationship = await createEvidenceRelationship({
        sourceEvidenceId: id,
        targetEvidenceId: target.id,
        relationshipType: body.relationshipType,
        note: body.note ?? null,
        createdByUserId: userId,
        teamId: evidence.teamId ?? target.teamId ?? null,
      });

      await appendReviewerAuditEvent({
        evidenceId: id,
        actorUserId: userId,
        eventType: prismaPkg.EvidenceReviewerAuditEventType.RELATIONSHIP_CREATED,
        metadata: {
          relationshipId: relationship.id,
          targetEvidenceId: target.id,
          relationshipType: relationship.relationshipType,
        } as Prisma.InputJsonValue,
      }).catch(() => null);

      return reply.code(201).send({
        relationshipId: relationship.id,
        items: await listEvidenceRelationships(id),
      });
    }
  );

  app.patch(
    "/v1/evidence/:id/relationships/:relationshipId",
    { preHandler: requireAuth },
    async (req, reply) => {
      const userId = getAuthUserId(req);
      const id = z.string().uuid().parse((req.params as ParamsId).id);
      const relationshipId = z
        .string()
        .uuid()
        .parse((req.params as { relationshipId: string }).relationshipId);
      const body = RelationshipUpdateBody.parse(req.body);
      await getEvidenceWithReadAccess(userId, id);

      const relationship = await prisma.evidenceRelationship.findUnique({
        where: { id: relationshipId },
      });

      if (
        !relationship ||
        (relationship.sourceEvidenceId !== id && relationship.targetEvidenceId !== id)
      ) {
        return reply.code(404).send({ message: "Relationship not found" });
      }

      await updateEvidenceRelationship({
        relationshipId,
        relationshipType: body.relationshipType,
        note: body.note,
      });

      await appendReviewerAuditEvent({
        evidenceId: id,
        actorUserId: userId,
        eventType: prismaPkg.EvidenceReviewerAuditEventType.RELATIONSHIP_UPDATED,
        metadata: {
          relationshipId,
          relationshipType: body.relationshipType ?? undefined,
        } as Prisma.InputJsonValue,
      }).catch(() => null);

      return reply.code(200).send({
        items: await listEvidenceRelationships(id),
      });
    }
  );

  app.delete(
    "/v1/evidence/:id/relationships/:relationshipId",
    { preHandler: requireAuth },
    async (req, reply) => {
      const userId = getAuthUserId(req);
      const id = z.string().uuid().parse((req.params as ParamsId).id);
      const relationshipId = z
        .string()
        .uuid()
        .parse((req.params as { relationshipId: string }).relationshipId);
      await getEvidenceWithReadAccess(userId, id);

      const relationship = await prisma.evidenceRelationship.findUnique({
        where: { id: relationshipId },
      });

      if (
        !relationship ||
        (relationship.sourceEvidenceId !== id && relationship.targetEvidenceId !== id)
      ) {
        return reply.code(404).send({ message: "Relationship not found" });
      }

      await deleteEvidenceRelationship(relationshipId);

      await appendReviewerAuditEvent({
        evidenceId: id,
        actorUserId: userId,
        eventType: prismaPkg.EvidenceReviewerAuditEventType.RELATIONSHIP_DELETED,
        metadata: { relationshipId } as Prisma.InputJsonValue,
      }).catch(() => null);

      return reply.code(200).send({ deleted: true });
    }
  );

  app.get(
    "/v1/evidence/:id/reviewer-audit",
    { preHandler: requireAuth },
    async (req, reply) => {
      const userId = getAuthUserId(req);
      const id = z.string().uuid().parse((req.params as ParamsId).id);
      await getEvidenceWithReadAccess(userId, id);

      const items = await listReviewerAuditEvents(id);
      return reply.code(200).send({
        items: items.map((item) => ({
          id: item.id,
          eventType: item.eventType,
          metadata: toJsonSafe(item.metadata ?? null),
          createdAt: item.createdAt.toISOString(),
          actor: item.actor ? mapCollaborativeAuthor(item.actor) : null,
        })),
      });
    }
  );

  app.get(
    "/v1/evidence/:id/artifacts",
    { preHandler: requireAuth },
    async (req, reply) => {
      const userId = getAuthUserId(req);
      const id = z.string().uuid().parse((req.params as ParamsId).id);
      await getEvidenceWithReadAccess(userId, id);
      return reply.code(200).send(await listEvidenceArtifacts(id));
    }
  );

  app.get(
    "/v1/evidence/:id/ai-categorization",
    { preHandler: requireAuth },
    async (req, reply) => {
      const userId = getAuthUserId(req);
      const id = z.string().uuid().parse((req.params as ParamsId).id);
      await getEvidenceWithReadAccess(userId, id);

      // Tolerant lookup. The default path expects the
      // `evidence_ai_categorizations` table to exist (created by the
      // 20260508133000 migration). If the deployment's DB is missing
      // that migration, Prisma raises P2021 ("table does not exist").
      // We treat that case as "no categorization yet" so the endpoint
      // stays 200, while still emitting a WARN so the drift remains
      // visible in logs / Sentry breadcrumbs for the on-call operator.
      let latest:
        | Awaited<ReturnType<typeof prisma.evidenceAiCategorization.findFirst>>
        | null = null;
      try {
        latest = await prisma.evidenceAiCategorization.findFirst({
          where: { evidenceId: id },
          orderBy: { createdAt: "desc" },
        });
      } catch (err) {
        if (
          err instanceof prismaPkg.Prisma.PrismaClientKnownRequestError &&
          err.code === "P2021"
        ) {
          req.log?.warn?.(
            {
              err,
              evidenceId: id,
              code: err.code,
              meta: err.meta,
            },
            "evidence.ai_categorization.schema_drift_table_missing",
          );
          latest = null;
        } else {
          throw err;
        }
      }

      if (!latest) {
        return reply.code(200).send({
          categorization: {
            status: prismaPkg.EvidenceAiCategorizationStatus.DISABLED,
            summary: null,
            categories: [],
            suggestedTags: [],
            riskFlags: [],
            legalDisclaimer: AI_LEGAL_DISCLAIMER,
            model: null,
            createdAt: null,
            updatedAt: null,
          },
        });
      }

      return reply.code(200).send({
        categorization: {
          status: latest.status,
          summary: latest.summary ?? null,
          categories: toJsonSafe(latest.categoriesJson ?? []),
          suggestedTags: toJsonSafe(latest.suggestedTagsJson ?? []),
          riskFlags: toJsonSafe(latest.riskFlagsJson ?? []),
          legalDisclaimer: latest.legalDisclaimer,
          model: latest.model ?? null,
          createdAt: latest.createdAt.toISOString(),
          updatedAt: latest.updatedAt.toISOString(),
        },
      });
    }
  );

  app.post(
    "/v1/evidence/:id/ai-categorization/run",
    { preHandler: requireAuth },
    async (req, reply) => {
      const userId = getAuthUserId(req);
      const id = z.string().uuid().parse((req.params as ParamsId).id);
      const evidence = await getEvidenceWithReadAccess(userId, id);

      const guard = evidenceAiCostGuard.canCategorizeEvidence(userId, id);
      if (!guard.allowed) {
        return reply.code(429).send({
          message: guard.reason ?? "AI categorization is temporarily unavailable",
        });
      }

      const itemCount = await getEvidenceItemCount(id);
      const metadataPayload = {
        evidenceId: id,
        title: resolveEvidenceTitle(evidence.title),
        type: evidence.type,
        mimeType: evidence.mimeType ?? null,
        itemCount,
        sizeBytes: bigintToString(evidence.sizeBytes),
        captureMethod: evidence.captureMethod ?? null,
        verificationStatus: evidence.verificationStatus ?? null,
        reportReady: Boolean(evidence.latestReportVersion || evidence.reportGeneratedAtUtc),
        verificationPackageReady: Boolean(
          evidence.verificationPackageVersion || evidence.verificationPackageGeneratedAtUtc
        ),
        caseLinked: Boolean(evidence.caseId),
        workspaceLabel: evidence.workspaceNameSnapshot ?? null,
        checklistMetadataOnly: true,
      };

      const aiResult = await evidenceAiProvider.run(
        AiTask.EVIDENCE_METADATA_CATEGORIZATION,
        metadataPayload
      );

      const deterministicCategories = [
        evidence.type,
        itemCount > 1 ? "MULTIPART" : "SINGLE_ITEM",
        evidence.captureMethod ?? "CAPTURE_METHOD_UNRECORDED",
      ];
      const suggestedTags = [
        evidence.mimeType ?? "mime-unrecorded",
        evidence.verificationStatus ?? "verification-unrecorded",
        evidence.latestReportVersion || evidence.reportGeneratedAtUtc ? "report-ready" : "report-missing",
        evidence.caseId ? "case-linked" : "case-unassigned",
      ];
      const riskFlags = aiResult.flags.map((flag) => ({
        severity: flag.severity,
        title: flag.title,
        detail: flag.detail,
      }));

      const persisted = await prisma.evidenceAiCategorization.create({
        data: {
          evidenceId: id,
          requestedByUserId: userId,
          status:
            aiResult.status === "ok"
              ? prismaPkg.EvidenceAiCategorizationStatus.COMPLETED
              : aiResult.status === "disabled"
                ? prismaPkg.EvidenceAiCategorizationStatus.DISABLED
                : prismaPkg.EvidenceAiCategorizationStatus.FAILED,
          categoriesJson: deterministicCategories as Prisma.InputJsonValue,
          suggestedTagsJson: suggestedTags as Prisma.InputJsonValue,
          riskFlagsJson: riskFlags as Prisma.InputJsonValue,
          summary: aiResult.summary,
          legalDisclaimer: AI_LEGAL_DISCLAIMER,
          model:
            aiResult.status === "disabled"
              ? null
              : process.env.OPENAI_EVIDENCE_CATEGORIZATION_MODEL?.trim() ??
                process.env.OPENAI_MODEL?.trim() ??
                "gpt-4.1-mini",
        },
      });

      evidenceAiCostGuard.recordEvidenceCategorization(userId, id);

      await appendReviewerAuditEvent({
        evidenceId: id,
        actorUserId: userId,
        eventType: prismaPkg.EvidenceReviewerAuditEventType.AI_CATEGORIZATION_RUN,
        metadata: {
          categorizationId: persisted.id,
          status: persisted.status,
          model: persisted.model ?? null,
        } as Prisma.InputJsonValue,
      }).catch(() => null);

      return reply.code(200).send({
        categorization: {
          status: persisted.status,
          summary: persisted.summary ?? null,
          categories: deterministicCategories,
          suggestedTags,
          riskFlags,
          legalDisclaimer: persisted.legalDisclaimer,
          model: persisted.model ?? null,
          createdAt: persisted.createdAt.toISOString(),
          updatedAt: persisted.updatedAt.toISOString(),
          nextActions: aiResult.suggestions,
        },
      });
    }
  );

  app.get(
    "/v1/evidence/:id/review-workspace",
    { preHandler: requireAuth },
    async (req, reply) => {
      const id = z.string().uuid().parse((req.params as ParamsId).id);
      const ownerUserId = getAuthUserId(req);

      (req as FastifyRequest & { evidenceId?: string }).evidenceId = id;
      req.log = req.log.child({ evidenceId: id });

      try {
        const evidence = await getEvidenceWithReadAccess(ownerUserId, id);
        if (!evidence.signingKeyId || evidence.signingKeyVersion == null) {
          return reply
            .code(409)
            .send({ message: "Signing key metadata is not recorded for this evidence record" });
        }
        const signingKey = await prisma.signingKey.findUnique({
          where: {
            keyId_version: {
              keyId: evidence.signingKeyId,
              version: evidence.signingKeyVersion,
            },
          },
          select: { publicKeyPem: true },
        });

        if (!signingKey) {
          // Phase 1 — see /public/verify handler for context. A SIGNED
          // evidence row without a matching `signing_keys` row is an
          // operational misconfiguration (seed step missed). Emit a
          // critical alert. The authenticated surface can give the
          // operator a more specific code so support can triage.
          req.log.warn(
            {
              alert: true,
              severity: "critical",
              reason: "signing_key_missing_for_signed_evidence",
              evidenceId: id,
              signingKeyId: evidence.signingKeyId,
              signingKeyVersion: evidence.signingKeyVersion,
            },
            "operational.alert",
          );
          return reply
            .code(503)
            .send({
              code: "SIGNING_KEY_MISSING",
              message:
                "The signing key referenced by this evidence record is not registered. Re-run `pnpm prisma:seed` against this environment, or contact support.",
            });
        }

        const [
          itemCount,
          overview,
          storage,
          anchor,
          parts,
          allCustodyEvents,
          latestReport,
          latestVerificationPackage,
          caseItem,
          publicVerifyCount,
          lastPublicVerify,
          authenticatedVerifyCount,
          reportDownloadCount,
          verificationPackageDownloadCount,
        ] = await Promise.all([
          getEvidenceItemCount(id),
          readBillingOverview(ownerUserId),
          getStorageProtectionSummary(evidence.storageBucket, evidence.storageKey, {
            storageRegion: evidence.storageRegion,
            storageObjectLockMode: evidence.storageObjectLockMode,
            storageObjectLockRetainUntilUtc:
              evidence.storageObjectLockRetainUntilUtc,
            storageObjectLockLegalHoldStatus:
              evidence.storageObjectLockLegalHoldStatus,
          }),
          getAnchorStatus(id),
          prisma.evidencePart.findMany({
            where: { evidenceId: id },
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
              privateNote: true,
              checklistStepId: true,
              sourceLabel: true,
              clientSignals: true,
              uploadedAtUtc: true,
              createdAt: true,
            },
          }),
          prisma.custodyEvent.findMany({
            where: { evidenceId: id },
            orderBy: { sequence: "asc" },
            take: 500,
            select: {
              sequence: true,
              atUtc: true,
              eventType: true,
              payload: true,
              prevEventHash: true,
              eventHash: true,
            },
          }),
          prisma.report.findFirst({
            where: { evidenceId: id },
            orderBy: { version: "desc" },
            select: {
              version: true,
              generatedAtUtc: true,
              embeddedPreviewsSnapshot: true,
              trustDecisionSnapshot: true,
              verificationStatusSnapshot: true,
              displayTitleSnapshot: true,
              itemCountSnapshot: true,
            },
          }),
          prisma.verificationPackage.findFirst({
            where: { evidenceId: id },
            orderBy: { version: "desc" },
            select: {
              version: true,
              generatedAtUtc: true,
              packageType: true,
              storageBucket: true,
              storageKey: true,
              trustDecisionSnapshot: true,
            },
          }),
          evidence.caseId
            ? prisma.case.findUnique({
                where: { id: evidence.caseId },
                select: { id: true, name: true, teamId: true },
              })
            : Promise.resolve(null),
          prisma.verificationView.count({
            where: {
              evidenceId: id,
              viewerType: prismaPkg.VerificationViewerType.PUBLIC,
            },
          }),
          prisma.verificationView.findFirst({
            where: {
              evidenceId: id,
              viewerType: prismaPkg.VerificationViewerType.PUBLIC,
            },
            orderBy: { createdAt: "desc" },
            select: { createdAt: true },
          }),
          prisma.verificationView.count({
            where: {
              evidenceId: id,
              viewerType: prismaPkg.VerificationViewerType.AUTHENTICATED,
            },
          }),
          prisma.custodyEvent.count({
            where: {
              evidenceId: id,
              eventType: prismaPkg.CustodyEventType.REPORT_DOWNLOADED,
            },
          }),
          prisma.custodyEvent.count({
            where: {
              evidenceId: id,
              eventType:
                prismaPkg.CustodyEventType.VERIFICATION_PACKAGE_DOWNLOADED,
            },
          }),
        ]);

        const workspaceCapabilitySnapshot = resolveWorkspaceCapabilitySnapshot({
          overview,
          evidence,
        });

        const evidenceIntelligence = await buildEvidenceIntelligence({
          evidenceId: id,
          evidence,
          anchor,
          storage,
        });

        const forensicCustodyEvents = allCustodyEvents.filter(
          (ev) => classifyCustodyEventType(ev.eventType) === "forensic"
        );
        const accessCustodyEvents = allCustodyEvents.filter(
          (ev) => classifyCustodyEventType(ev.eventType) === "access"
        );

        const persistedVerificationPackageMetadata =
          isVerificationPackageMetadata(evidence.verificationPackageMetadata)
            ? evidence.verificationPackageMetadata
            : null;

        let verificationPackageIntegrity: PublicVerificationPackageIntegrity;
        if (persistedVerificationPackageMetadata) {
          verificationPackageIntegrity = {
            available: Boolean(latestVerificationPackage),
            version: latestVerificationPackage?.version ?? null,
            generatedAtUtc: latestVerificationPackage?.generatedAtUtc
              ? latestVerificationPackage.generatedAtUtc.toISOString()
              : null,
            packageType: latestVerificationPackage?.packageType ?? null,
            manifestPresent: persistedVerificationPackageMetadata.manifestPresent,
            signedManifestPresent:
              persistedVerificationPackageMetadata.signedManifestPresent,
            manifestDigestPresent:
              persistedVerificationPackageMetadata.signedManifestPresent,
            checksumIndexPresent:
              persistedVerificationPackageMetadata.checksumIndexPresent,
            offlineVerifierIncluded:
              persistedVerificationPackageMetadata.offlineVerifierIncluded,
            auditExportIncluded:
              persistedVerificationPackageMetadata.auditExportIncluded ?? false,
            custodyExportIncluded:
              persistedVerificationPackageMetadata.custodyExportIncluded ??
              false,
            accessExportIncluded:
              persistedVerificationPackageMetadata.accessExportIncluded ?? false,
          };
        } else if (latestVerificationPackage) {
          const inspectedArtifacts = await inspectVerificationPackageArtifacts(
            latestVerificationPackage.storageBucket,
            latestVerificationPackage.storageKey
          );

          verificationPackageIntegrity = {
            available: true,
            version: latestVerificationPackage.version,
            generatedAtUtc:
              latestVerificationPackage.generatedAtUtc.toISOString(),
            packageType: latestVerificationPackage.packageType ?? null,
            manifestPresent: inspectedArtifacts?.manifestPresent ?? false,
            signedManifestPresent:
              inspectedArtifacts?.signedManifestPresent ?? false,
            manifestDigestPresent:
              inspectedArtifacts?.manifestDigestPresent ?? false,
            checksumIndexPresent:
              inspectedArtifacts?.checksumIndexPresent ?? false,
            offlineVerifierIncluded:
              inspectedArtifacts?.offlineVerifierIncluded ?? false,
            auditExportIncluded:
              inspectedArtifacts?.auditExportIncluded ?? false,
            custodyExportIncluded:
              inspectedArtifacts?.custodyExportIncluded ?? false,
            accessExportIncluded:
              inspectedArtifacts?.accessExportIncluded ?? false,
          };
        } else {
          verificationPackageIntegrity = {
            available: false,
            version: null,
            generatedAtUtc: null,
            packageType: null,
            manifestPresent: false,
            signedManifestPresent: false,
            manifestDigestPresent: false,
            checksumIndexPresent: false,
            offlineVerifierIncluded: false,
            auditExportIncluded: false,
            custodyExportIncluded: false,
            accessExportIncluded: false,
          };
        }

        const reportPreviewMap = new Map<
          string,
          {
            previewDataUrl?: string | null;
            previewTextExcerpt?: string | null;
            previewCaption?: string | null;
          }
        >();

        if (Array.isArray(latestReport?.embeddedPreviewsSnapshot)) {
          for (const item of latestReport.embeddedPreviewsSnapshot) {
            if (
              item &&
              typeof item === "object" &&
              "id" in item &&
              typeof item.id === "string"
            ) {
              reportPreviewMap.set(item.id, {
                previewDataUrl:
                  "previewDataUrl" in item &&
                  typeof item.previewDataUrl === "string"
                    ? item.previewDataUrl
                    : null,
                previewTextExcerpt:
                  "previewTextExcerpt" in item &&
                  typeof item.previewTextExcerpt === "string"
                    ? item.previewTextExcerpt
                    : null,
                previewCaption:
                  "previewCaption" in item &&
                  typeof item.previewCaption === "string"
                    ? item.previewCaption
                    : null,
              });
            }
          }
        }

        const authenticatedContentAccessPolicy =
          resolveEvidenceContentAccessPolicyForSurface({
            surface: "authenticated_verify",
          });
        const content = await buildPublicEvidenceContent({
          accessPolicy: authenticatedContentAccessPolicy,
          previews: reportPreviewMap,
          evidence: {
            id: evidence.id,
            mimeType: evidence.mimeType,
            sizeBytes: evidence.sizeBytes,
            storageBucket: evidence.storageBucket,
            storageKey: evidence.storageKey,
            fileSha256: evidence.fileSha256,
            intakePlanJson: evidence.intakePlanJson ?? null,
            originalFileName: evidence.originalFileName ?? null,
            displayFileName: evidence.displayFileName ?? null,
            recordedAt: evidence.capturedAtUtc ?? evidence.createdAt,
          },
          parts,
        });

        const privateNoteByPartId = new Map(
          parts.map((part) => [part.id, part.privateNote ?? null] as const)
        );

        const contentItems = content.items.map((item) => ({
          ...item,
          privateNote: privateNoteByPartId.get(item.id) ?? null,
        }));

        const defaultPreviewItem =
          contentItems.find((item) => item.previewable && item.viewUrl) ??
          contentItems.find((item) => item.viewUrl) ??
          content.primaryItem ??
          null;

        const display = buildEvidenceDisplayDescriptor({
          title:
            evidence.title ??
            evidence.displayFileName ??
            evidence.originalFileName ??
            null,
          summary: content.summary,
          itemCount,
        });

        const recomputedFingerprintHash = evidence.fingerprintCanonicalJson
          ? sha256Hex(evidence.fingerprintCanonicalJson)
          : null;
        const canonicalHashMatches =
          Boolean(recomputedFingerprintHash) &&
          recomputedFingerprintHash === evidence.fingerprintHash;

        let signatureValid = false;
        try {
          signatureValid =
            recomputedFingerprintHash != null &&
            evidence.signatureBase64 != null &&
            ed25519VerifyHexSignature({
              messageHex: recomputedFingerprintHash,
              signatureBase64: evidence.signatureBase64,
              publicKeyPem: signingKey.publicKeyPem,
            });
        } catch {
          signatureValid = false;
        }

        const normalizedTsaStatus = String(evidence.tsaStatus ?? "")
          .trim()
          .toUpperCase();
        const timestampInputDigestHex =
          evidence.tsaInputDigestHex ?? evidence.fileSha256;
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
const timestampDigestMatches: boolean | null =
  timestampStatusIsPositive
    ? Boolean(evidence.tsaMessageImprint && timestampInputDigestHex) &&
      String(evidence.tsaMessageImprint).toLowerCase() ===
        String(timestampInputDigestHex).toLowerCase()
            : timestampStatusIsUnavailable
              ? null
              : null;

        const effectiveOtsStatus = resolveEffectiveOtsStatus({
          status: evidence.otsStatus,
          anchoredAtUtc: evidence.otsAnchoredAtUtc,
        });
        const effectiveOtsAnchoredAtUtc =
          effectiveOtsStatus === "ANCHORED" ? evidence.otsAnchoredAtUtc : null;
        const otsHashMatches =
          evidence.otsHash && evidence.fingerprintHash
            ? evidence.otsHash.toLowerCase() ===
              evidence.fingerprintHash.toLowerCase()
            : null;

        const custodyChain = evaluateCustodyChain({
          evidenceId: id,
          records: allCustodyEvents.map((ev) => ({
            sequence: ev.sequence,
            eventType: ev.eventType,
            atUtc: ev.atUtc,
            payload: ev.payload,
            prevEventHash: ev.prevEventHash,
            eventHash: ev.eventHash,
          })),
        });

        const snapshotTrustDecision =
          normalizeTrustDecisionSnapshot(latestReport?.trustDecisionSnapshot) ??
          normalizeTrustDecisionSnapshot(
            latestVerificationPackage?.trustDecisionSnapshot
          ) ??
          null;

        const liveTrustDecision = buildEvidenceTrustDecision({
          evidence: {
            verificationStatus: evidence.verificationStatus ?? null,
            recordedIntegrityVerifiedAtUtc:
              evidence.recordedIntegrityVerifiedAtUtc?.toISOString() ?? null,
            fileSha256: evidence.fileSha256 ?? null,
            fingerprintHash: evidence.fingerprintHash ?? null,
            signatureBase64: evidence.signatureBase64 ?? null,
            signingKeyId: evidence.signingKeyId ?? null,
            publicKeyPem: signingKey.publicKeyPem ?? null,
            tsaStatus: evidence.tsaStatus ?? null,
            tsaFailureReason: evidence.tsaFailureReason ?? null,
            otsStatus: effectiveOtsStatus,
            otsHash: evidence.otsHash ?? null,
            otsBitcoinTxid: evidence.otsBitcoinTxid ?? null,
            otsAnchoredAtUtc:
              effectiveOtsAnchoredAtUtc?.toISOString() ?? null,
            otsCalendar: evidence.otsCalendar ?? null,
            otsFailureReason: evidence.otsFailureReason ?? null,
            storageImmutable: storage?.immutable ?? null,
            storageObjectLockMode: storage?.mode ?? null,
            storageObjectLockRetainUntilUtc: storage?.retainUntil ?? null,
            identityLevelSnapshot: evidence.identityLevelSnapshot ?? null,
            submittedByEmail: evidence.submittedByEmail ?? null,
            submittedByAuthProvider: evidence.submittedByAuthProvider ?? null,
            verificationPackageVersion:
              latestVerificationPackage?.version ??
              evidence.verificationPackageVersion ??
              null,
            verificationPackageGeneratedAtUtc:
              latestVerificationPackage?.generatedAtUtc?.toISOString() ??
              evidence.verificationPackageGeneratedAtUtc?.toISOString() ??
              null,
            anchor: anchor
              ? {
                  configured: anchor.configured,
                  published: anchor.published,
                  provider: anchor.provider,
                  publicUrl: anchor.publicUrl,
                  anchoredAtUtc: anchor.anchoredAtUtc,
                  transactionId: anchor.transactionId,
                  receiptId: anchor.receiptId,
                }
              : null,
          },
          custodyEvents: allCustodyEvents.map((event) => ({
            eventType: event.eventType,
            category: classifyCustodyEventType(event.eventType),
            eventHash: event.eventHash ?? null,
            prevEventHash: event.prevEventHash ?? null,
          })),
        });

        const trustDecision = snapshotTrustDecision ?? liveTrustDecision;
        const trustDecisionConsistencySource = snapshotTrustDecision
          ? latestReport?.trustDecisionSnapshot
            ? "REPORT_SNAPSHOT"
            : "VERIFICATION_PACKAGE_SNAPSHOT"
          : "LIVE_SHARED_FALLBACK";

        const custodyDisplayContext = {
          itemCount: content.summary.itemCount,
          structure: content.summary.structure,
        } as const;

        const mappedForensicEvents = forensicCustodyEvents.map((event) =>
          mapPublicCustodyEvent(event, custodyDisplayContext)
        );
        const mappedAccessEvents = accessCustodyEvents.map((event) =>
          mapPublicCustodyEvent(event, custodyDisplayContext)
        );
        const custodyLifecycle = buildPublicCustodyLifecycle({
          forensicEvents: mappedForensicEvents,
          accessEvents: mappedAccessEvents,
        });

        const reportGeneratedAtUtc =
          latestReport?.generatedAtUtc ?? evidence.reportGeneratedAtUtc ?? null;
        const forensicEventsAtReportGeneration = reportGeneratedAtUtc
          ? forensicCustodyEvents.filter((ev) => ev.atUtc <= reportGeneratedAtUtc)
          : forensicCustodyEvents;
        const accessEventsAfterReportGeneration = reportGeneratedAtUtc
          ? accessCustodyEvents.filter((ev) => ev.atUtc > reportGeneratedAtUtc)
          : accessCustodyEvents;

        const snapshotGeneratedAtUtc =
          trustDecisionConsistencySource === "REPORT_SNAPSHOT"
            ? latestReport?.generatedAtUtc ?? evidence.reportGeneratedAtUtc ?? null
            : trustDecisionConsistencySource === "VERIFICATION_PACKAGE_SNAPSHOT"
              ? latestVerificationPackage?.generatedAtUtc ??
                evidence.verificationPackageGeneratedAtUtc ??
                null
              : null;

        const trustDecisionConsistency = buildTrustDecisionConsistency({
          snapshotTrustDecision,
          liveTrustDecision,
          source: trustDecisionConsistencySource,
          snapshotGeneratedAtUtc,
          latestReportGeneratedAtUtc:
            latestReport?.generatedAtUtc ?? evidence.reportGeneratedAtUtc ?? null,
          latestReportVersion:
            latestReport?.version ?? evidence.latestReportVersion ?? null,
          latestVerificationPackageGeneratedAtUtc:
            latestVerificationPackage?.generatedAtUtc ??
            evidence.verificationPackageGeneratedAtUtc ??
            null,
          latestVerificationPackageVersion:
            latestVerificationPackage?.version ??
            evidence.verificationPackageVersion ??
            null,
          forensicEventsAtSnapshot: forensicEventsAtReportGeneration.length,
          currentForensicEvents: forensicCustodyEvents.length,
          accessEventsAfterSnapshot: accessEventsAfterReportGeneration.length,
        });

        const custodyDisplayCounts = {
          forensicAtReportGeneration: forensicEventsAtReportGeneration.length,
          currentForensicEvents: forensicCustodyEvents.length,
          accessAfterReportGeneration: accessEventsAfterReportGeneration.length,
          currentAccessEvents: accessCustodyEvents.length,
          reportGeneratedAtUtc: reportGeneratedAtUtc
            ? reportGeneratedAtUtc.toISOString()
            : null,
        };

        const sourceContext = buildSourceContext({ evidence, parts });
        const relatedEvidenceCount = evidence.caseId
          ? await prisma.evidence.count({
              where: {
                caseId: evidence.caseId,
                deletedAt: null,
              },
            })
          : null;

        const reviewerAlerts = buildResolvedReviewerAlerts({
          evidenceIntelligence,
          workspaceCapabilitySnapshot,
          anchor,
          latestReportVersion: latestReport?.version ?? evidence.latestReportVersion,
          latestVerificationPackageVersion:
            latestVerificationPackage?.version ??
            evidence.verificationPackageVersion,
          evidence,
        });
        const reviewerWorkflowSummary = await getEvidenceReviewerWorkflowSummary(id);
        const relationshipItems = await listEvidenceRelationships(id);
        const artifactHistory = await listEvidenceArtifacts(id);
        const governance = buildEvidenceReviewGovernance();
        const reviewerAudit = await listReviewerAuditEvents(id);

        const reviewDecision =
          evidenceIntelligence?.reviewerDecision ?? {
            status: evidence.deletedAt
              ? "RESTRICTED"
              : evidence.verificationStatus ===
                    prismaPkg.VerificationStatus.RECORDED_INTEGRITY_VERIFIED &&
                  latestReport
                ? "READY_FOR_EXTERNAL_REVIEW"
                : "NEEDS_ATTENTION",
            label: evidence.deletedAt
              ? "Review with limitations"
              : evidence.verificationStatus ===
                    prismaPkg.VerificationStatus.RECORDED_INTEGRITY_VERIFIED &&
                  latestReport
                ? "Ready for review"
                : "Requires reviewer attention",
            summary: evidence.deletedAt
              ? "This record is in trash or restricted state and should be handled with retention controls in mind."
              : evidence.verificationStatus ===
                    prismaPkg.VerificationStatus.RECORDED_INTEGRITY_VERIFIED &&
                  latestReport
                ? "Technical verification materials are available for reviewer inspection."
                : "One or more technical or operational materials are still incomplete.",
            issues: reviewerAlerts.map((alert) => alert.label),
            nextActions: [
              latestReport
                ? "Review the generated report together with the live record state."
                : "Generate a report when a fixed reviewer snapshot is required.",
              latestVerificationPackage
                ? "Download the verification package for offline review if needed."
                : "Generate a verification package when offline review is required.",
            ],
          };

        const publicVerifyPath = `/verify/${evidence.id}`;

        auditEvidenceAction(req, {
          userId: ownerUserId,
          action: "evidence.review_workspace_viewed",
          outcome: "success",
          resourceId: id,
          metadata: {
            itemCount,
            forensicEventCount: forensicCustodyEvents.length,
            accessEventCount: accessCustodyEvents.length,
          },
        });

        return reply.code(200).send(
          toJsonSafe({
            evidence: {
              ...toSafeEvidence(evidence),
              itemCount,
              display,
              displayTitle: display.displayTitle,
              displaySubtitle: buildEvidenceSubtitle({
                itemCount,
                status: evidence.status,
                createdAt: evidence.createdAt,
              }),
              displayDescription: display.displayDescription,
              storage,
              anchor,
              contentAccessPolicy: authenticatedContentAccessPolicy,
              contentCompositionSummary: buildContentCompositionSummary(
                content.summary
              ),
              primaryContentLabel: buildPrimaryContentLabel(
                content.summary.primaryKind
              ),
              defaultPreviewItemId: defaultPreviewItem?.id ?? null,
              contentSummary: content.summary,
              contentItems: contentItems,
              primaryContentItem: content.primaryItem,
              previewPolicy: content.previewPolicy,
              evidenceIntelligence,
            },
            workspaceCapabilitySnapshot,
            sourceContext,
            reviewDecision,
            reviewerAlerts,
            custodyLifecycle,
            custodyDisplayCounts,
            sourceCaptureLocation: hasCaptureLocationMetadata({
              lat: decimalToNumber(evidence.lat),
              lng: decimalToNumber(evidence.lng),
            })
              ? {
                  statusLabel: CAPTURE_LOCATION_STATUS_LABEL,
                  description: CAPTURE_LOCATION_CONTEXT_DESCRIPTION,
                  lat: decimalToNumber(evidence.lat),
                  lng: decimalToNumber(evidence.lng),
                  accuracyMeters: decimalToNumber(evidence.accuracyMeters),
                  capturedAtUtc: evidence.capturedAtUtc
                    ? evidence.capturedAtUtc.toISOString()
                    : evidence.createdAt.toISOString(),
                  deviceTimeIso: evidence.deviceTimeIso ?? null,
                  source: CAPTURE_LOCATION_SOURCE_LABEL,
                  externalMapUrl:
                    buildCaptureLocationExternalMapUrl({
                      lat: decimalToNumber(evidence.lat),
                      lng: decimalToNumber(evidence.lng),
                      accuracyMeters: decimalToNumber(
                        evidence.accuracyMeters
                      ),
                    }) ?? null,
                  legalBoundary: CAPTURE_LOCATION_LEGAL_BOUNDARY,
                }
              : null,
            preservationMatrix: {
              verificationStatus: evidence.verificationStatus ?? null,
              verificationStatusLabel: mapVerificationStatusLabel(
                evidence.verificationStatus
              ),
              recordedIntegrityVerifiedAtUtc:
                evidence.recordedIntegrityVerifiedAtUtc?.toISOString() ?? null,
              sha256Recorded: Boolean(evidence.fileSha256),
              fingerprintHashRecorded: Boolean(evidence.fingerprintHash),
              signature: {
                recorded: Boolean(evidence.signatureBase64),
                valid: signatureValid,
                keyId: evidence.signingKeyId ?? null,
                keyVersion: evidence.signingKeyVersion ?? null,
              },
              tsa: {
                status: evidence.tsaStatus ?? null,
                provider: evidence.tsaProvider ?? null,
                timestampAvailable: timestampStatusIsPositive,
                digestMatchesTimestampInput: timestampDigestMatches,
                digestCheckConclusive: timestampDigestMatches !== null,
                genTimeUtc: evidence.tsaGenTimeUtc?.toISOString() ?? null,
                failureReason: evidence.tsaFailureReason ?? null,
                timestampedDigestLabel: getTimestampDigestLabel({
                  itemCount,
                  tsaInputKind: evidence.tsaInputKind,
                }),
              },
              ots: {
                status: evidence.otsStatus ?? null,
                effectiveStatus: effectiveOtsStatus,
                hashMatches: otsHashMatches,
                anchoredAtUtc:
                  effectiveOtsAnchoredAtUtc?.toISOString() ?? null,
                calendar: evidence.otsCalendar ?? null,
                bitcoinTxid: evidence.otsBitcoinTxid ?? null,
                failureReason: evidence.otsFailureReason ?? null,
              },
              custodyChain: {
                valid: custodyChain.valid,
                mode: custodyChain.mode,
                reason: custodyChain.reason,
              },
              storage,
              anchor,
              report: {
                available: Boolean(latestReport),
                version: latestReport?.version ?? evidence.latestReportVersion ?? null,
                generatedAtUtc: latestReport?.generatedAtUtc
                  ? latestReport.generatedAtUtc.toISOString()
                  : evidence.reportGeneratedAtUtc?.toISOString() ?? null,
              },
              verificationPackage: verificationPackageIntegrity,
            },
            relationships: {
              caseId: caseItem?.id ?? evidence.caseId ?? null,
              caseName: caseItem?.name ?? null,
              relatedEvidenceCount,
              multipart: content.summary.structure === "multipart",
              itemCount: content.summary.itemCount,
              note:
                !evidence.caseId && relationshipItems.length === 0
                  ? "No linked evidence relationships recorded yet."
                  : null,
              items: relationshipItems,
            },
            reviewWorkflow: reviewerWorkflowSummary.workflow
              ? {
                  available: true,
                  ...reviewerWorkflowSummary.workflow,
                  note: null,
                }
              : {
                  available: false,
                  status: null,
                  priority: null,
                  assignedTo: null,
                  dueAt: null,
                  lastReviewedAt: null,
                  note: "No reviewer workflow has been created.",
                },
            classification: {
              evidenceType: evidence.type,
              evidenceTypeLabel: getReviewerEvidenceTypeLabel({
                itemCount: content.summary.itemCount,
                structure: content.summary.structure,
                imageCount: content.summary.imageCount,
                videoCount: content.summary.videoCount,
                audioCount: content.summary.audioCount,
                pdfCount: content.summary.pdfCount,
                textCount: content.summary.textCount,
                otherCount: content.summary.otherCount,
                mimeType: evidence.mimeType,
                evidenceType: evidence.type,
              }),
              captureMethod: evidence.captureMethod ?? null,
              captureMethodLabel: mapCaptureMethodLabel(evidence.captureMethod),
              intakeTemplate:
                typeof evidence.intakePlanJson === "object" &&
                evidence.intakePlanJson &&
                "selectedPlanId" in
                  (evidence.intakePlanJson as Record<string, unknown>)
                  ? (
                      evidence.intakePlanJson as Record<string, unknown>
                    ).selectedPlanId ?? null
                  : null,
              workspaceType: workspaceCapabilitySnapshot.workspaceType,
              workspaceName: workspaceCapabilitySnapshot.workspaceName,
              matterType: caseItem?.name ?? null,
            },
            integrityDrift: {
              available: Boolean(reportGeneratedAtUtc),
              reportGeneratedAtUtc: reportGeneratedAtUtc
                ? reportGeneratedAtUtc.toISOString()
                : null,
              reportVersion: latestReport?.version ?? null,
              titleDiffersFromReportSnapshot:
                Boolean(latestReport?.displayTitleSnapshot) &&
                latestReport?.displayTitleSnapshot !== display.displayTitle,
              itemCountDiffersFromReportSnapshot:
                typeof latestReport?.itemCountSnapshot === "number" &&
                latestReport.itemCountSnapshot !== itemCount,
              postReportForensicEvents:
                forensicCustodyEvents.length -
                forensicEventsAtReportGeneration.length,
              postReportAccessEvents: accessEventsAfterReportGeneration.length,
              note: reportGeneratedAtUtc
                ? "Post-report activity reflects changes in lifecycle or access activity after the fixed report snapshot."
                : "No integrity drift indicators available from current API response.",
            },
            snapshot: {
              reportGeneratedAtUtc: reportGeneratedAtUtc
                ? reportGeneratedAtUtc.toISOString()
                : null,
              reportVersion: latestReport?.version ?? null,
              verificationPackageGeneratedAtUtc:
                latestVerificationPackage?.generatedAtUtc?.toISOString() ??
                evidence.verificationPackageGeneratedAtUtc?.toISOString() ??
                null,
              verificationPackageVersion:
                latestVerificationPackage?.version ??
                evidence.verificationPackageVersion ??
                null,
              currentStatus: evidence.status,
              statusAtReportGeneration:
                latestReport?.verificationStatusSnapshot ?? null,
              fixedArtifactNote:
                "PDF report is a fixed generated artifact. Public verification may show current verification or access state depending on implementation.",
            },
            publicVerificationSummary: {
              enabled: workspaceCapabilitySnapshot.publicVerifyIncluded,
              configured: anchor.configured,
              published: anchor.published,
              sharePath: workspaceCapabilitySnapshot.publicVerifyIncluded
                ? publicVerifyPath
                : null,
              publicUrl: anchor.publicUrl ?? null,
              publicViewCount: publicVerifyCount,
              authenticatedViewCount: authenticatedVerifyCount,
              lastPublicViewAt: lastPublicVerify?.createdAt?.toISOString() ?? null,
              reportDownloadCount,
              verificationPackageDownloadCount,
              analyticsAvailable: true,
            },
            artifactVersions: {
              history: artifactHistory,
              latestReport: latestReport
                ? {
                    available: true,
                    version: latestReport.version,
                    generatedAtUtc: latestReport.generatedAtUtc.toISOString(),
                  }
                : {
                    available: false,
                    version: evidence.latestReportVersion ?? null,
                    generatedAtUtc:
                      evidence.reportGeneratedAtUtc?.toISOString() ?? null,
                  },
              latestVerificationPackage: latestVerificationPackage
                ? {
                    available: true,
                    version: latestVerificationPackage.version,
                    packageType: latestVerificationPackage.packageType ?? null,
                    generatedAtUtc:
                      latestVerificationPackage.generatedAtUtc.toISOString(),
                  }
                : {
                    available: false,
                    version: evidence.verificationPackageVersion ?? null,
                    packageType: null,
                    generatedAtUtc:
                      evidence.verificationPackageGeneratedAtUtc?.toISOString() ??
                      null,
                  },
              technicalMaterials: buildTechnicalMaterials({
                evidence: {
                  fileSha256: evidence.fileSha256,
                  multipartManifestSha256:
                    evidence.multipartManifestSha256 ?? null,
                  hashSemantics: evidence.hashSemantics ?? null,
                  fingerprintHash: evidence.fingerprintHash,
                  signatureBase64: evidence.signatureBase64,
                  signingKeyId: evidence.signingKeyId,
                  signingKeyVersion: evidence.signingKeyVersion,
                  tsaMessageImprint: evidence.tsaMessageImprint,
                  tsaInputDigestHex: evidence.tsaInputDigestHex,
                  tsaInputKind: evidence.tsaInputKind,
                  otsProofBase64: evidence.otsProofBase64,
                },
                publicKeyPem: signingKey.publicKeyPem,
                partsCount: parts.length,
              }),
              trustDecision,
              trustDecisionConsistency,
            },
            governance,
            reviewerAudit: reviewerAudit.map((item) => ({
              id: item.id,
              eventType: item.eventType,
              metadata: toJsonSafe(item.metadata ?? null),
              createdAt: item.createdAt.toISOString(),
              actor: item.actor ? mapCollaborativeAuthor(item.actor) : null,
            })),
            parts: parts.map((part) => ({
              id: part.id,
              partIndex: part.partIndex,
              originalFileName: part.originalFileName ?? null,
              mimeType: part.mimeType ?? null,
              sizeBytes: part.sizeBytes?.toString() ?? null,
              sha256: part.sha256 ?? null,
              durationMs: part.durationMs ?? null,
              privateRole: part.privateRole ?? null,
              privateNote: part.privateNote ?? null,
              checklistStepId: part.checklistStepId ?? null,
              sourceLabel: part.sourceLabel ?? null,
              clientSignals: toJsonSafe(part.clientSignals ?? null),
              storage: getStorageProtectionSummaryFromSnapshot({
                storageRegion: part.storageRegion,
                storageObjectLockMode: part.storageObjectLockMode,
                storageObjectLockRetainUntilUtc:
                  part.storageObjectLockRetainUntilUtc,
                storageObjectLockLegalHoldStatus:
                  part.storageObjectLockLegalHoldStatus,
              }),
              uploadedAtUtc: part.uploadedAtUtc?.toISOString() ?? null,
              createdAt: part.createdAt.toISOString(),
            })),
            legalBoundary:
              "PROOVRA verifies the recorded integrity state of evidence records and supporting technical materials. It does not independently establish factual truth, authorship, identity, legal admissibility, or evidentiary weight.",
          })
        );
      } catch (err) {
        const statusCode =
          err instanceof Error && "statusCode" in err
            ? (err as Error & { statusCode?: number }).statusCode ?? 500
            : 500;
        const message = err instanceof Error ? err.message : "Unexpected error";
        return reply.code(statusCode).send({ message });
      }
    }
  );

  app.get(
    "/v1/evidence/:id",
    { preHandler: requireAuth },
    async (req, reply) => {
      const id = z.string().uuid().parse((req.params as ParamsId).id);
      const ownerUserId = getAuthUserId(req);

      (req as FastifyRequest & { evidenceId?: string }).evidenceId = id;
      req.log = req.log.child({ evidenceId: id });

      try {
        const evidence = await getEvidenceWithReadAccess(ownerUserId, id);
        const itemCount = await getEvidenceItemCount(id);
        const storage = await getStorageProtectionSummary(
          evidence.storageBucket,
          evidence.storageKey,
          {
            storageRegion: evidence.storageRegion,
            storageObjectLockMode: evidence.storageObjectLockMode,
            storageObjectLockRetainUntilUtc:
              evidence.storageObjectLockRetainUntilUtc,
            storageObjectLockLegalHoldStatus:
              evidence.storageObjectLockLegalHoldStatus,
          }
        );
        const anchor = await getAnchorStatus(id);

        const evidenceIntelligence = await buildEvidenceIntelligence({
          evidenceId: id,
          evidence,
          anchor,
          storage,
        });

        auditEvidenceAction(req, {
          userId: ownerUserId,
          action: "evidence.view",
          outcome: "success",
          resourceId: id,
          metadata: {
            itemCount,
            status: evidence.status,
            verificationStatus: evidence.verificationStatus,
          },
        });

        const parts = await prisma.evidencePart.findMany({
          where: { evidenceId: id },
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
            privateRole: true,
            checklistStepId: true,
          },
        });

        const authenticatedContentAccessPolicy: PublicVerifyContentAccessPolicy =
          resolveEvidenceContentAccessPolicyForSurface({
            surface: "authenticated_verify",
          });

const content = await buildPublicEvidenceContent({
  accessPolicy: authenticatedContentAccessPolicy,
  evidence: {
    id: evidence.id,
    mimeType: evidence.mimeType,
    sizeBytes: evidence.sizeBytes,
    storageBucket: evidence.storageBucket,
    storageKey: evidence.storageKey,
    fileSha256: evidence.fileSha256,
    intakePlanJson: evidence.intakePlanJson ?? null,
    originalFileName: evidence.originalFileName ?? null,
    displayFileName: evidence.displayFileName ?? null,
    recordedAt: evidence.capturedAtUtc ?? evidence.createdAt,
  },
  parts,
});

        const defaultPreviewItem =
          content.items.find((item) => item.previewable && item.viewUrl) ??
          content.items.find((item) => item.viewUrl) ??
          content.primaryItem ??
          null;

        const display = buildEvidenceDisplayDescriptor({
title: evidence.title ?? evidence.displayFileName ?? evidence.originalFileName ?? null,
          summary: content.summary,
          itemCount,
        });

        return reply.code(200).send({
          evidence: toJsonSafe({
            ...toSafeEvidence(evidence),
            itemCount,
            display,
            displayTitle: display.displayTitle,
            displaySubtitle: buildEvidenceSubtitle({
              itemCount,
              status: evidence.status,
              createdAt: evidence.createdAt,
            }),
            displayDescription: display.displayDescription,
            storage,
            anchor,
            contentAccessPolicy: authenticatedContentAccessPolicy,
            contentCompositionSummary: buildContentCompositionSummary(
              content.summary
            ),
            primaryContentLabel: buildPrimaryContentLabel(
              content.summary.primaryKind
            ),
            defaultPreviewItemId: defaultPreviewItem?.id ?? null,
            contentSummary: content.summary,
            contentItems: content.items,
            primaryContentItem: content.primaryItem,
            previewPolicy: content.previewPolicy,
            evidenceIntelligence,
          }),
        });
                  } catch (err) {
        const statusCode =
          err instanceof Error && "statusCode" in err
            ? (err as Error & { statusCode?: number }).statusCode ?? 500
            : 500;
        const message = err instanceof Error ? err.message : "Unexpected error";
        return reply.code(statusCode).send({ message });
      }
    }
  );

  app.post(
    "/v1/evidence/:id/complete",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply) => {
      const ownerUserId = getAuthUserId(req);
      const id = z.string().uuid().parse((req.params as ParamsId).id);

      (req as FastifyRequest & { evidenceId?: string }).evidenceId = id;
      req.log = req.log.child({ evidenceId: id });

try {
  const evidence = await getEvidenceWithOwnerAccess(ownerUserId, id);
  assertEvidenceNotLocked(evidence);
} catch (err) {
          const statusCode =
          err instanceof Error && "statusCode" in err
            ? (err as Error & { statusCode?: number }).statusCode ?? 500
            : 500;
        const message = err instanceof Error ? err.message : "Unexpected error";
        return reply.code(statusCode).send({ message });
      }

      const plan = await getUserPlan(ownerUserId);
      const limit = getTierLimit(plan);
      const rate = await enforceRateLimit({
        key: `ratelimit:evidence:complete:${plan}:${ownerUserId}`,
        max: limit.max,
        windowSec: limit.windowSec,
      });

      if (!rate.allowed) {
        auditEvidenceAction(req, {
          userId: ownerUserId,
          action: "evidence.complete",
          outcome: "blocked",
          severity: "warning",
          resourceId: id,
          metadata: { reason: "rate_limit_exceeded", plan },
        });
        return reply.code(429).send({ message: "Rate limit exceeded" });
      }

      // Phase 9.5 — governance gate on completion. Completion triggers the
      // existing pipeline that produces the report-v2 PDF and the
      // verification package. If policy denies report or package
      // generation, block completion and emit a custody event recording
      // the blocked attempt. Public-verify is also gated here because
      // there is no separate publish endpoint — public verify eligibility
      // is a side-effect of completion.
      const completionEvidence = await prisma.evidence.findUnique({
        where: { id },
        select: { id: true, teamId: true, retentionUntilUtc: true },
      });
      if (completionEvidence?.teamId) {
        const { enforceSensitiveAction, evidenceIsReviewed } = await import(
          "../services/governance.service.js"
        );
        const membership = await prisma.teamMember.findUnique({
          where: {
            teamId_userId: {
              teamId: completionEvidence.teamId,
              userId: ownerUserId,
            },
          },
        });
        const isReviewed = await evidenceIsReviewed(id);
        const reviewState = { isReviewed };

        for (const action of [
          "generate_report",
          "generate_package",
          "publish_public_verify",
        ] as const) {
          const decision = await enforceSensitiveAction(action, {
            teamId: completionEvidence.teamId,
            role: membership?.role,
            evidence: {
              id: completionEvidence.id,
              teamId: completionEvidence.teamId,
              retentionUntilUtc: completionEvidence.retentionUntilUtc ?? null,
            },
            reviewState,
          });
          if (!decision.allowed) {
            await appendCustodyEvent({
              evidenceId: id,
              eventType: prismaPkg.CustodyEventType.EXPORT_BLOCKED_BY_POLICY,
              payload: {
                action,
                reason: decision.reason,
                actorUserId: ownerUserId,
              },
              ip: req.ip,
              userAgent: req.headers["user-agent"],
            }).catch(() => null);
            const statusCode =
              decision.code === "GOVERNANCE_CHECK_FAILED" ? 503 : 409;
            return reply.code(statusCode).send({
              code: decision.code,
              reason: decision.reason,
              message:
                "Evidence finalization is blocked by workspace governance policy.",
            });
          }
        }
      }

      try {
        const result = await completeEvidence({ evidenceId: id, ownerUserId });

        await appendCustodyEvent({
  evidenceId: id,
  eventType: prismaPkg.CustodyEventType.EVIDENCE_COMPLETED,
  payload: {
    completedByUserId: ownerUserId,
    completedAtUtc: new Date().toISOString(),
  } as Prisma.InputJsonValue,
  ip: req.ip,
  userAgent: req.headers["user-agent"],
}).catch(() => null);

        // Initialize the EvidenceReviewWorkflow at NOT_STARTED so the
        // evidence shows up in the reviewer queue immediately on completion.
        // upsert is idempotent — replays / re-completions don't create duplicates.
        try {
          const evidenceForWorkflow = await prisma.evidence.findUnique({
            where: { id },
            select: { teamId: true, ownerUserId: true },
          });
          if (evidenceForWorkflow) {
            await upsertEvidenceReviewerWorkflow({
              evidenceId: id,
              workspaceType: evidenceForWorkflow.teamId ? "TEAM" : "PERSONAL",
              teamId: evidenceForWorkflow.teamId,
              actorUserId: ownerUserId,
              status: prismaPkg.EvidenceReviewWorkflowStatus.NOT_STARTED,
              priority: prismaPkg.EvidenceReviewWorkflowPriority.NORMAL,
              note: "Created automatically on Capture finalization.",
            });
          }
        } catch (workflowErr) {
          req.log?.warn?.(
            { err: workflowErr, evidenceId: id },
            "capture_finalize_workflow_init_failed"
          );
        }

        const refreshed = await prisma.evidence.findUnique({
          where: { id },
          select: SAFE_EVIDENCE_SELECT,
        });

        if (!refreshed) {
          return reply.code(404).send({ message: "Evidence not found" });
        }

        auditEvidenceAction(req, {
          userId: ownerUserId,
          action: "evidence.complete",
          outcome: "success",
          resourceId: id,
          metadata: {
            status: refreshed.status,
            verificationStatus: refreshed.verificationStatus,
            result: "completed",
          },
        });

        const storage = await getStorageProtectionSummary(
          refreshed.storageBucket,
          refreshed.storageKey,
          {
            storageRegion: refreshed.storageRegion,
            storageObjectLockMode: refreshed.storageObjectLockMode,
            storageObjectLockRetainUntilUtc:
              refreshed.storageObjectLockRetainUntilUtc,
            storageObjectLockLegalHoldStatus:
              refreshed.storageObjectLockLegalHoldStatus,
          }
        );
        
        const itemCount = await getEvidenceItemCount(id);

const parts = await prisma.evidencePart.findMany({
  where: { evidenceId: id },
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
    privateRole: true,
    checklistStepId: true,
  },
});

const authenticatedContentAccessPolicy: PublicVerifyContentAccessPolicy =
  resolveEvidenceContentAccessPolicyForSurface({
    surface: "authenticated_verify",
  });

const content = await buildPublicEvidenceContent({
  accessPolicy: authenticatedContentAccessPolicy,
  evidence: {
    id: refreshed.id,
    mimeType: refreshed.mimeType,
    sizeBytes: refreshed.sizeBytes,
    storageBucket: refreshed.storageBucket,
    storageKey: refreshed.storageKey,
    fileSha256: refreshed.fileSha256,
    intakePlanJson: refreshed.intakePlanJson ?? null,
    originalFileName: refreshed.originalFileName ?? null,
    displayFileName: refreshed.displayFileName ?? null,
    recordedAt: refreshed.capturedAtUtc ?? refreshed.createdAt,
  },
  parts,
});

const defaultPreviewItem =
  content.items.find((item) => item.previewable && item.viewUrl) ??
  content.items.find((item) => item.viewUrl) ??
  content.primaryItem ??
  null;

const display = buildEvidenceDisplayDescriptor({
  title:
    refreshed.title ??
    refreshed.displayFileName ??
    refreshed.originalFileName ??
    null,
  summary: content.summary,
  itemCount,
});

return reply.code(200).send({
  ...toJsonSafe(result),
  evidence: toJsonSafe({
    ...toSafeEvidence(refreshed),
    itemCount,
    display,
    displayTitle: display.displayTitle,
    displaySubtitle: buildEvidenceSubtitle({
      itemCount,
      status: refreshed.status,
      createdAt: refreshed.createdAt,
    }),
    displayDescription: display.displayDescription,
    storage,
    contentAccessPolicy: authenticatedContentAccessPolicy,
    contentCompositionSummary: buildContentCompositionSummary(content.summary),
    primaryContentLabel: buildPrimaryContentLabel(
      content.summary.primaryKind
    ),
    defaultPreviewItemId: defaultPreviewItem?.id ?? null,
    contentSummary: content.summary,
    contentItems: content.items,
    primaryContentItem: content.primaryItem,
    previewPolicy: content.previewPolicy,
  }),
});
      } catch (err) {
if (
  err instanceof Error &&
  "code" in err &&
  (err as Error & { code?: string }).code === "INSUFFICIENT_CREDITS"
) {
  auditEvidenceAction(req, {
    userId: ownerUserId,
    action: "evidence.complete",
    outcome: "blocked",
    severity: "warning",
    resourceId: id,
    metadata: { reason: "INSUFFICIENT_CREDITS" },
  });
  return reply.code(402).send({
    code: "INSUFFICIENT_CREDITS",
    message: "Insufficient credits",
  });
}

        if (
          err instanceof Error &&
          err.message === "Cannot complete evidence without an uploaded file"
        ) {
          auditEvidenceAction(req, {
            userId: ownerUserId,
            action: "evidence.complete",
            outcome: "failure",
            severity: "warning",
            resourceId: id,
            metadata: { reason: err.message },
          });
          return reply.code(400).send({ message: err.message });
        }

        if (
          err instanceof Error &&
          (err.message.startsWith("OBJECT_HEAD_FAILED:") ||
            err.message.startsWith("OBJECT_GET_FAILED:"))
        ) {
          auditEvidenceAction(req, {
            userId: ownerUserId,
            action: "evidence.complete",
            outcome: "failure",
            severity: "warning",
            resourceId: id,
            metadata: { reason: "uploaded_object_not_found" },
          });
          return reply.code(404).send({ message: "Uploaded object not found" });
        }

                // Phase 30.7 — custody-safe finalize gate denial.
        // The gate refused finalization because a Phase 30
        // resumable upload session exists and isn't COMPLETED
        // with every part VERIFIED. Surface a bounded reason
        // code in the response envelope; the actual reason is
        // encoded as `UPLOAD_SESSION_GATE:<bounded_code>` in
        // err.message by completeEvidence.
        if (
          err instanceof Error &&
          err.message.startsWith("UPLOAD_SESSION_GATE:")
        ) {
          const reason = err.message.slice("UPLOAD_SESSION_GATE:".length);
          const statusCode =
            (err as Error & { statusCode?: number }).statusCode ?? 409;
          auditEvidenceAction(req, {
            userId: ownerUserId,
            action: "evidence.complete",
            outcome: "blocked",
            severity: "warning",
            resourceId: id,
            metadata: { reason: `upload_session_gate:${reason}` },
          });
          return reply.code(statusCode).send({
            code: "FINALIZE_BLOCKED_BY_UPLOAD_SESSION",
            reason,
            message:
              "Evidence cannot be finalized until the resumable upload session is server-verified.",
          });
        }

        if (
          err instanceof Error &&
          "code" in err &&
          (err as Error & { code?: string }).code === "STORAGE_LIMIT_REACHED"
        ) {
          const lockedEvidence = await prisma.evidence.findUnique({
            where: { id },
            select: {
              teamId: true,
            },
          });

          const details =
            "details" in err
              ? ((err as Error & { details?: Record<string, unknown> }).details ?? {})
              : {};

          const payload = await buildStorageLimitPayload({
            ownerUserId,
            evidenceId: id,
            teamId: lockedEvidence?.teamId ?? null,
            req,
            reason: "complete_evidence_blocked",
            incomingBytes:
              typeof details?.incomingBytes === "string"
                ? details.incomingBytes
                : null,
          });

          auditEvidenceAction(req, {
            userId: ownerUserId,
            action: "evidence.complete",
            outcome: "blocked",
            severity: "warning",
            resourceId: id,
            metadata: {
              reason: "STORAGE_LIMIT_REACHED",
            },
          });

          return reply.code(409).send(payload);
        }

        auditEvidenceAction(req, {
          userId: ownerUserId,
          action: "evidence.complete",
          outcome: "failure",
          severity: "critical",
          resourceId: id,
          metadata: {
            reason: err instanceof Error ? err.message : "unknown_error",
          },
        });

        throw err;
      }
    }
  );

  /*
   * Side-effect-free artifact readiness endpoint.
   *
   * Purpose: lets Capture (and other clients) poll whether the post-finalization
   * artifacts (signed report, verification package) are ready WITHOUT generating
   * any audit, custody, view, or download events. The existing
   * /report/latest endpoint creates REPORT_DOWNLOADED + evidence.report_viewed,
   * which are intended for human report access — using it for polling falsifies
   * custody chain and reviewer audit history.
   *
   * Contract:
   *   GET /v1/evidence/:id/artifacts/status
   *   Auth: required (read access).
   *   Returns 200 with:
   *     { evidenceId, status, report: {...}, verificationPackage: {...} }
   *   Never creates CustodyEvent, ReviewerAuditEvent, or VerificationView rows.
   *   Does not increment counters or change Evidence state.
   */
  app.get(
    "/v1/evidence/:id/artifacts/status",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply) => {
      const ownerUserId = getAuthUserId(req);
      const id = z.string().uuid().parse((req.params as ParamsId).id);

      (req as FastifyRequest & { evidenceId?: string }).evidenceId = id;
      req.log = req.log.child({ evidenceId: id });

      let evidenceRecord: SelectedEvidence;
      try {
        evidenceRecord = await getEvidenceWithReadAccess(ownerUserId, id);
      } catch (err) {
        const statusCode =
          err instanceof Error && "statusCode" in err
            ? (err as Error & { statusCode?: number }).statusCode ?? 500
            : 500;
        const message = err instanceof Error ? err.message : "Unexpected error";
        return reply.code(statusCode).send({ message });
      }

      // Phase C #12: extracted to a bounded helper so route file shrinks
      // and the artifact-readiness logic can be tested independently.
      // Phase 32.5: pass evidenceTeamId so the helper can distinguish
      // "package pending generation" from "package not available
      // (personal workspace, no governance context)".
      // Phase 32.6.1: pass verificationPackageMetadata so the helper
      // can surface gate-denial state (blocked vs pending vs failed).
      const artifactStatus = await buildEvidenceArtifactStatus({
        evidenceId: id,
        evidenceStatus: evidenceRecord.status as
          | prismaPkg.EvidenceStatus
          | null,
        evidenceTeamId: evidenceRecord.teamId ?? null,
        evidenceVerificationPackageMetadata:
          evidenceRecord.verificationPackageMetadata ?? null,
      });

      // Phase 32.6 — bounded SRE counter for the side-effect-free
      // polling path. NOT bumped from the report/latest or
      // verification-package endpoints (those record real
      // download / custody events). Lets dashboards size the
      // polling load + the API->worker race window.
      try {
        const { bump } = await import("@proovra/shared-runtime/ops");
        bump("artifact_status_polled_total");
      } catch {
        /* metrics are best-effort */
      }

      return reply.code(200).send(artifactStatus);
    }
  );

  /**
   * Phase A.1D — POST /v1/evidence/:id/reports/regenerate
   *
   * Operational retry / regenerate path for the evidence report
   * artifact pair (report PDF + verification package). Wraps the same
   * `enqueueGenerateReportJob()` the `evidence-complete.service`
   * already uses on first finalize, with `forceRegenerate: true` so
   * the BullMQ job:
   *   1. supersedes any existing queued/processing job for this
   *      evidence id (the enqueue function handles dedup), AND
   *   2. runs with the 3-attempt budget reserved for retries
   *      (vs the 5-attempt budget for first generation).
   *
   * Verification package generation happens IN-PROCESS during report
   * generation (see worker `processor.ts`), so a single regenerate
   * call refreshes BOTH artifacts. There is no separate package-only
   * regenerate endpoint by design.
   *
   * RBAC:
   *   - Owner-only. The caller must be the evidence owner. We use the
   *     same `getEvidenceWithOwnerAccess` helper the existing
   *     owner-only mutations use (label, archive, restore, etc.).
   *   - Team admins on collaborative content do NOT yet get a
   *     regenerate path through this endpoint. That is a deliberate
   *     scoping decision; a Team-level "regenerate as admin" would
   *     require a new policy decision about cross-owner overrides
   *     and is intentionally deferred.
   *
   * Audit:
   *   - Emits a platform audit log row with action
   *     `evidence.report.regenerate_requested`. No CustodyEvent is
   *     appended here — custody tracks the actual GENERATED artifact,
   *     not the regenerate REQUEST. When the worker completes, the
   *     normal `REPORT_GENERATED` + `VERIFICATION_PACKAGE_GENERATED`
   *     custody events fire from the worker's existing path.
   *
   * Responses:
   *   - 202 Accepted with `{ enqueued: true | false, reason?: string }`.
   *     `enqueued: false` is returned when an active job already
   *     exists and the dedup helper decided to skip; the response is
   *     STILL 202 because from the caller's perspective the regen has
   *     been requested.
   *   - 403 Forbidden if the caller is not the evidence owner.
   *   - 404 Not Found if the evidence id does not exist.
   */
  app.post(
    "/v1/evidence/:id/reports/regenerate",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply) => {
      const userId = getAuthUserId(req);
      const id = z.string().uuid().parse((req.params as ParamsId).id);

      (req as FastifyRequest & { evidenceId?: string }).evidenceId = id;
      req.log = req.log.child({ evidenceId: id });

      // Ownership gate — same helper the existing owner-only
      // mutations use. Translates not-found → 404 and not-owner → 403.
      let evidenceRecord: SelectedEvidence;
      try {
        evidenceRecord = await getEvidenceWithOwnerAccess(userId, id);
      } catch (err) {
        const statusCode =
          err instanceof Error && "statusCode" in err
            ? (err as Error & { statusCode?: number }).statusCode ?? 500
            : 500;
        const message = err instanceof Error ? err.message : "Unexpected error";
        return reply.code(statusCode).send({ message });
      }

      // Enqueue with `forceRegenerate: true`. The enqueue helper
      // handles existing-job dedup; if an active job already exists it
      // returns `{ enqueued: false, reason }` and we surface that.
      let result: { enqueued: boolean; reason?: string };
      try {
        result = await enqueueGenerateReportJob(id, {
          forceRegenerate: true,
        });
      } catch (err: unknown) {
        const message =
          err instanceof Error
            ? err.message
            : "Failed to enqueue report regenerate job.";
        auditEvidenceAction(req, {
          userId,
          action: "evidence.report.regenerate_requested",
          outcome: "failure",
          resourceId: id,
          severity: "warning",
          metadata: { error: message },
        });
        return reply.code(500).send({ message });
      }

      auditEvidenceAction(req, {
        userId,
        action: "evidence.report.regenerate_requested",
        outcome: result.enqueued ? "success" : "blocked",
        resourceId: id,
        metadata: {
          enqueued: result.enqueued,
          reason: result.reason ?? null,
          evidenceStatus: evidenceRecord.status ?? null,
          evidenceTeamId: evidenceRecord.teamId ?? null,
        },
      });

      return reply.code(202).send({
        evidenceId: id,
        enqueued: result.enqueued,
        reason: result.reason ?? null,
        message: result.enqueued
          ? "Report regeneration enqueued. Poll /v1/evidence/:id/artifacts/status for progress."
          : "An active report job already exists for this evidence. No new job enqueued.",
      });
    }
  );

  app.get(
    "/v1/evidence/:id/report/latest",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply) => {
      const ownerUserId = getAuthUserId(req);
      const id = z.string().uuid().parse((req.params as ParamsId).id);

      (req as FastifyRequest & { evidenceId?: string }).evidenceId = id;
      req.log = req.log.child({ evidenceId: id });

      try {
        await getEvidenceWithReadAccess(ownerUserId, id);
      } catch (err) {
        const statusCode =
          err instanceof Error && "statusCode" in err
            ? (err as Error & { statusCode?: number }).statusCode ?? 500
            : 500;
        const message = err instanceof Error ? err.message : "Unexpected error";
        return reply.code(statusCode).send({ message });
      }

      // Phase 9.5 — gate report download by workspace policy. Fail-closed:
      // a transient policy lookup blocks the export rather than leaking
      // a download URL.
      {
        const evidenceForGate = await prisma.evidence.findUnique({
          where: { id },
          select: { id: true, teamId: true, retentionUntilUtc: true },
        });
        if (evidenceForGate?.teamId) {
          const { enforceSensitiveAction } = await import(
            "../services/governance.service.js"
          );
          const membership = await prisma.teamMember.findUnique({
            where: {
              teamId_userId: {
                teamId: evidenceForGate.teamId,
                userId: ownerUserId,
              },
            },
          });
          const decision = await enforceSensitiveAction("download_report", {
            teamId: evidenceForGate.teamId,
            role: membership?.role,
            evidence: {
              id: evidenceForGate.id,
              teamId: evidenceForGate.teamId,
              retentionUntilUtc: evidenceForGate.retentionUntilUtc ?? null,
            },
          });
          if (!decision.allowed) {
            await appendCustodyEvent({
              evidenceId: id,
              eventType: prismaPkg.CustodyEventType.EXPORT_BLOCKED_BY_POLICY,
              payload: {
                action: "report_download",
                reason: decision.reason,
                actorUserId: ownerUserId,
              },
              ip: req.ip,
              userAgent: req.headers["user-agent"],
            }).catch(() => null);
            return reply
              .code(decision.code === "GOVERNANCE_CHECK_FAILED" ? 503 : 403)
              .send({
                code: decision.code,
                reason: decision.reason,
                message:
                  "Report download is blocked by workspace governance policy.",
              });
          }
        }
      }

      const latest = await prisma.report.findFirst({
        where: { evidenceId: id },
        orderBy: { version: "desc" },
        select: {
          version: true,
          trustDecisionSnapshot: true,
          storageBucket: true,
          storageKey: true,
          storageRegion: true,
          displayTitleSnapshot: true,
displayDescriptionSnapshot: true,
contentStructureSnapshot: true,
itemCountSnapshot: true,
primaryContentKindSnapshot: true,
contentSummarySnapshot: true,
primaryContentLabelSnapshot: true,
contentAccessPolicySnapshot: true,
previewPolicySnapshot: true,
reviewGuidanceSnapshot: true,
limitationsSnapshot: true,
          storageObjectLockMode: true,
          storageObjectLockRetainUntilUtc: true,
          storageObjectLockLegalHoldStatus: true,
          generatedAtUtc: true,
          verificationStatusSnapshot: true,
          identityLevelSnapshot: true,
          submittedByEmailSnapshot: true,
          submittedByAuthProviderSnapshot: true,
          captureMethodSnapshot: true,
          reviewerSummaryVersion: true,
          verificationPackageVersion: true,
        },
      });

      if (!latest) {
        return reply.code(404).send({ message: "Report not found" });
      }

      try {
        const meta = await headObject({
          bucket: latest.storageBucket,
          key: latest.storageKey,
        });
        if (!meta.sizeBytes || meta.sizeBytes <= 0) {
          return reply.code(404).send({ message: "Report not found" });
        }
      } catch {
        return reply.code(404).send({ message: "Report not found" });
      }

      await appendCustodyEvent({
        evidenceId: id,
        eventType: prismaPkg.CustodyEventType.REPORT_DOWNLOADED,
        payload: { reportVersion: latest.version },
        ip: req.ip,
        userAgent: req.headers["user-agent"],
      }).catch(() => null);

      auditEvidenceAction(req, {
        userId: ownerUserId,
        action: "evidence.report_viewed",
        outcome: "success",
        resourceId: id,
        metadata: {
          reportVersion: latest.version,
        },
      });

      const url = await presignGetObject({
        bucket: latest.storageBucket,
        key: latest.storageKey,
        expiresInSeconds: 600,
      });

      const storage = await getStorageProtectionSummary(
        latest.storageBucket,
        latest.storageKey,
        {
          storageRegion: latest.storageRegion,
          storageObjectLockMode: latest.storageObjectLockMode,
          storageObjectLockRetainUntilUtc:
            latest.storageObjectLockRetainUntilUtc,
          storageObjectLockLegalHoldStatus:
            latest.storageObjectLockLegalHoldStatus,
        }
      );

      return reply.code(200).send({
        evidenceId: id,
        version: latest.version,
        bucket: latest.storageBucket,
        key: latest.storageKey,
        url,
        generatedAtUtc: latest.generatedAtUtc.toISOString(),
        reviewerSnapshot: {
          displayTitle: latest.displayTitleSnapshot ?? null,
          trustDecision: toJsonSafe(latest.trustDecisionSnapshot ?? null),
          displayDescription: latest.displayDescriptionSnapshot ?? null,
          contentStructure: latest.contentStructureSnapshot ?? null,
          itemCount: latest.itemCountSnapshot ?? null,
          primaryContentKind: latest.primaryContentKindSnapshot ?? null,
          primaryContentLabel: latest.primaryContentLabelSnapshot ?? null,
contentSummary: toJsonSafe(latest.contentSummarySnapshot ?? null),
contentAccessPolicy: toJsonSafe(latest.contentAccessPolicySnapshot ?? null),
previewPolicy: toJsonSafe(latest.previewPolicySnapshot ?? null),
reviewGuidance: toJsonSafe(latest.reviewGuidanceSnapshot ?? null),
legalLimitations: toJsonSafe(latest.limitationsSnapshot ?? null),
        },
                storage,
        snapshots: {
          verificationStatus: latest.verificationStatusSnapshot ?? null,
          verificationStatusLabel: mapVerificationStatusLabel(
            latest.verificationStatusSnapshot
          ),
          identityLevel: latest.identityLevelSnapshot ?? null,
          identityLevelLabel: mapIdentityLevelLabel(
            latest.identityLevelSnapshot
          ),
          submittedByEmail: latest.submittedByEmailSnapshot ?? null,
          submittedByAuthProvider: latest.submittedByAuthProviderSnapshot ?? null,
          submittedByAuthProviderLabel: mapAuthProviderLabel(
            latest.submittedByAuthProviderSnapshot
          ),
          captureMethod: latest.captureMethodSnapshot ?? null,
          captureMethodLabel: mapCaptureMethodLabel(
            latest.captureMethodSnapshot
          ),
          reviewerSummaryVersion: latest.reviewerSummaryVersion ?? null,
          verificationPackageVersion: latest.verificationPackageVersion ?? null,
        },
      });
    }
  );

  app.get(
    "/v1/evidence/:id/original",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply) => {
      const ownerUserId = getAuthUserId(req);
      const id = z.string().uuid().parse((req.params as ParamsId).id);

      (req as FastifyRequest & { evidenceId?: string }).evidenceId = id;
      req.log = req.log.child({ evidenceId: id });

      let evidence: SelectedEvidence;
      try {
        evidence = await getEvidenceWithReadAccess(ownerUserId, id);
      } catch (err) {
        const statusCode =
          err instanceof Error && "statusCode" in err
            ? (err as Error & { statusCode?: number }).statusCode ?? 500
            : 500;
        const message = err instanceof Error ? err.message : "Unexpected error";
        return reply.code(statusCode).send({ message });
      }

      if (!evidence.storageBucket || !evidence.storageKey) {
        return reply.code(404).send({ message: "Original file not found" });
      }

      // Phase 10 — original-download governance gate. Fail-closed.
      if (evidence.teamId) {
        const { enforceSensitiveAction } = await import(
          "../services/governance.service.js"
        );
        const membership = await prisma.teamMember.findUnique({
          where: {
            teamId_userId: {
              teamId: evidence.teamId,
              userId: ownerUserId,
            },
          },
        });
        const decision = await enforceSensitiveAction("download_original", {
          teamId: evidence.teamId,
          role: membership?.role,
          evidence: {
            id: evidence.id,
            teamId: evidence.teamId,
            retentionUntilUtc: evidence.retentionUntilUtc ?? null,
          },
        });
        if (!decision.allowed) {
          await appendCustodyEvent({
            evidenceId: id,
            eventType: prismaPkg.CustodyEventType.EXPORT_BLOCKED_BY_POLICY,
            payload: {
              action: "download_original",
              reason: decision.reason,
              actorUserId: ownerUserId,
            },
            ip: req.ip,
            userAgent: req.headers["user-agent"],
          }).catch(() => null);
          return reply
            .code(decision.code === "GOVERNANCE_CHECK_FAILED" ? 503 : 403)
            .send({
              code: decision.code,
              reason: decision.reason,
              message:
                "Original file download is blocked by workspace governance policy.",
            });
        }
      }

      const url = await presignGetObject({
        bucket: evidence.storageBucket,
        key: evidence.storageKey,
        expiresInSeconds: 600,
      });

      const accessedAt = new Date();

      // Phase 32.7.1 — fire-and-forget the analytics update for
      // `lastAccessedByUserId` / `lastAccessedAtUtc`. Under Neon
      // pool pressure this synchronous update could fail to start
      // a transaction and break the original-presign download for
      // the user, even though the presigned URL itself was already
      // generated. The update is pure analytics (display-side
      // "last accessed by X on Y"); the forensic custody event is
      // emitted separately below.
      void prisma.evidence
        .update({
          where: { id },
          data: {
            lastAccessedByUserId: ownerUserId,
            lastAccessedAtUtc: accessedAt,
          },
        })
        .catch((err) => {
          req.log.warn(
            {
              evidenceId: id,
              err: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
              surface: "evidence.lastAccessedAtUtc",
            },
            "original_presign.access_log_failed",
          );
        });

      await appendCustodyEvent({
        evidenceId: id,
        eventType: prismaPkg.CustodyEventType.EVIDENCE_VIEWED,
        payload: {
          mimeType: evidence.mimeType ?? null,
          accessMode: "authenticated_original_access",
          accessedByUserId: ownerUserId,
          accessedAtUtc: accessedAt.toISOString(),
        },
        ip: req.ip,
        userAgent: req.headers["user-agent"],
      }).catch(() => null);

      auditEvidenceAction(req, {
        userId: ownerUserId,
        action: "evidence.downloaded",
        outcome: "success",
        resourceId: id,
        metadata: {
          accessMode: "original_presign",
        },
      });

      const storage = await getStorageProtectionSummary(
        evidence.storageBucket,
        evidence.storageKey,
        {
          storageRegion: evidence.storageRegion,
          storageObjectLockMode: evidence.storageObjectLockMode,
          storageObjectLockRetainUntilUtc:
            evidence.storageObjectLockRetainUntilUtc,
          storageObjectLockLegalHoldStatus:
            evidence.storageObjectLockLegalHoldStatus,
        }
      );

const matchingPrimaryPart =
  evidence.storageBucket && evidence.storageKey
    ? await prisma.evidencePart.findFirst({
        where: {
          evidenceId: id,
          storageBucket: evidence.storageBucket,
          storageKey: evidence.storageKey,
        },
        select: {
          partIndex: true,
          originalFileName: true,
          mimeType: true,
        },
      })
    : null;

function cleanOptionalText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

const resolvedOriginalFileName =
  cleanOptionalText(evidence.originalFileName) ??
  cleanOptionalText(matchingPrimaryPart?.originalFileName) ??
  null;

const resolvedDisplayName =
  cleanOptionalText(evidence.displayFileName) ??
  resolveOriginalAssetDisplayName({
    originalFileName: resolvedOriginalFileName,
    storageKey: evidence.storageKey,
    mimeType: matchingPrimaryPart?.mimeType ?? evidence.mimeType,
    recordedAt: evidence.capturedAtUtc ?? evidence.createdAt,
    partIndex: matchingPrimaryPart?.partIndex ?? 0,
    multipart: Boolean(matchingPrimaryPart),
  });
  
  const originalKind = detectEvidenceAssetKind(evidence.mimeType);

return reply.code(200).send({
  evidenceId: id,
  bucket: evidence.storageBucket,
  key: evidence.storageKey,
originalFileName: resolvedOriginalFileName ?? resolvedDisplayName,
displayName: resolvedDisplayName,
  url,
  publicUrl: isPreviewableEvidenceKind(originalKind) ? url : null,
  previewUrl: isPreviewableEvidenceKind(originalKind) ? url : null,
  mimeType: evidence.mimeType,
  kind: originalKind,
  previewable: isPreviewableEvidenceKind(originalKind),
          sizeBytes: evidence.sizeBytes?.toString() ?? null,
        displaySizeLabel: formatBytesForDisplay(
          evidence.sizeBytes?.toString() ?? null
        ),
        lastAccessedByUserId: ownerUserId,
        lastAccessedAtUtc: accessedAt.toISOString(),
        storage,
      });
    }
  );

  app.get(
    "/v1/evidence/:id/verification-package",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply) => {
      const ownerUserId = getAuthUserId(req);
      const id = z.string().uuid().parse((req.params as ParamsId).id);

      (req as FastifyRequest & { evidenceId?: string }).evidenceId = id;
      req.log = req.log.child({ evidenceId: id });

      try {
        await getEvidenceWithReadAccess(ownerUserId, id);
      } catch (err) {
        const statusCode =
          err instanceof Error && "statusCode" in err
            ? (err as Error & { statusCode?: number }).statusCode ?? 500
            : 500;
        const message = err instanceof Error ? err.message : "Unexpected error";
        return reply.code(statusCode).send({ message });
      }

      // Phase 9.5 — gate package download by workspace policy. Fail-closed.
      {
        const evidenceForGate = await prisma.evidence.findUnique({
          where: { id },
          select: { id: true, teamId: true, retentionUntilUtc: true },
        });
        if (evidenceForGate?.teamId) {
          const { enforceSensitiveAction } = await import(
            "../services/governance.service.js"
          );
          const membership = await prisma.teamMember.findUnique({
            where: {
              teamId_userId: {
                teamId: evidenceForGate.teamId,
                userId: ownerUserId,
              },
            },
          });
          const decision = await enforceSensitiveAction("download_package", {
            teamId: evidenceForGate.teamId,
            role: membership?.role,
            evidence: {
              id: evidenceForGate.id,
              teamId: evidenceForGate.teamId,
              retentionUntilUtc: evidenceForGate.retentionUntilUtc ?? null,
            },
          });
          if (!decision.allowed) {
            await appendCustodyEvent({
              evidenceId: id,
              eventType: prismaPkg.CustodyEventType.EXPORT_BLOCKED_BY_POLICY,
              payload: {
                action: "verification_package_download",
                reason: decision.reason,
                actorUserId: ownerUserId,
              },
              ip: req.ip,
              userAgent: req.headers["user-agent"],
            }).catch(() => null);
            return reply
              .code(decision.code === "GOVERNANCE_CHECK_FAILED" ? 503 : 403)
              .send({
                code: decision.code,
                reason: decision.reason,
                message:
                  "Verification package download is blocked by workspace governance policy.",
              });
          }
        }
      }

      const latest = await prisma.verificationPackage.findFirst({
        where: { evidenceId: id },
        orderBy: { version: "desc" },
        select: {
          version: true,
          storageBucket: true,
          trustDecisionSnapshot: true,
          storageKey: true,
          storageRegion: true,
          storageObjectLockMode: true,
          storageObjectLockRetainUntilUtc: true,
          storageObjectLockLegalHoldStatus: true,
          generatedAtUtc: true,
          packageType: true,
        },
      });

      if (!latest) {
        // Phase 32.6.1 — structured "not yet ready" response.
        //
        // The previous behavior was a flat 404 "Verification package
        // not found", which conflated FOUR very different states:
        //   1. Worker is still generating it (pending) → client
        //      should keep polling /artifacts/status.
        //   2. Personal-workspace evidence (intentionally never
        //      generated; no governance context).
        //   3. Gate denied (legal hold / destruction review / etc.);
        //      blocked until the governance condition resolves.
        //   4. Genuinely missing (truly broken state).
        //
        // We resolve which case we're in by reading the same bounded
        // signals the artifact-status helper uses. Mapping:
        //   - blocked    → 409 Conflict + bounded outcome + reason
        //   - unavailable → 410 Gone + bounded reason
        //   - pending    → 202 Accepted + Retry-After hint
        //   - else       → 404 (legitimately missing)
        //
        // The client (already polls /artifacts/status) gets a
        // distinct, actionable response without leaking storage
        // internals or schema names.
        const evidenceForState = await prisma.evidence.findUnique({
          where: { id },
          select: {
            status: true,
            teamId: true,
            verificationPackageMetadata: true,
          },
        });
        const finalized =
          evidenceForState?.status === prismaPkg.EvidenceStatus.SIGNED ||
          evidenceForState?.status === prismaPkg.EvidenceStatus.REPORTED;
        const meta = evidenceForState?.verificationPackageMetadata as
          | { blocked?: unknown; outcome?: unknown; reason?: unknown; blockedAtUtc?: unknown }
          | null
          | undefined;
        const blocked =
          meta != null && typeof meta === "object" && meta.blocked === true;
        // Phase 32.6.6 — personal-workspace 410 path retired.
        //
        // Previously: `finalized && !evidenceForState?.teamId` returned
        // 410 verification_package_unavailable with reason
        // `personal_workspace_no_team_governance_context`. That was
        // incorrect product semantics: personal evidence MUST be able
        // to generate a verification package (BASIC mode). The worker
        // now produces a personal-basic package; this route therefore
        // falls through to the standard pending/missing branches
        // below.
        if (blocked) {
          return reply.code(409).send({
            code: "verification_package_blocked",
            outcome: typeof meta?.outcome === "string" ? meta!.outcome : null,
            reason: typeof meta?.reason === "string" ? meta!.reason : null,
            blockedAtUtc:
              typeof meta?.blockedAtUtc === "string" ? meta!.blockedAtUtc : null,
            message:
              "Verification package generation was blocked by governance policy.",
          });
        }
        if (finalized) {
          // Worker is still building it. Tell the client to poll the
          // side-effect-free /artifacts/status endpoint and retry in
          // a few seconds.
          reply.header("retry-after", "5");
          return reply.code(202).send({
            code: "verification_package_pending",
            message:
              "Verification package is being generated. Poll /v1/evidence/:id/artifacts/status for completion.",
          });
        }
        return reply
          .code(404)
          .send({
            code: "verification_package_not_found",
            message: "Verification package not found.",
          });
      }

      try {
        const meta = await headObject({
          bucket: latest.storageBucket,
          key: latest.storageKey,
        });
        if (!meta.sizeBytes || meta.sizeBytes <= 0) {
          return reply
            .code(404)
            .send({ message: "Verification package not found" });
        }
      } catch {
        return reply
          .code(404)
          .send({ message: "Verification package not found" });
      }

      const url = await presignGetObject({
        bucket: latest.storageBucket,
        key: latest.storageKey,
        expiresInSeconds: 600,
      });

      const storage = await getStorageProtectionSummary(
        latest.storageBucket,
        latest.storageKey,
        {
          storageRegion: latest.storageRegion,
          storageObjectLockMode: latest.storageObjectLockMode,
          storageObjectLockRetainUntilUtc:
            latest.storageObjectLockRetainUntilUtc,
          storageObjectLockLegalHoldStatus:
            latest.storageObjectLockLegalHoldStatus,
        }
      );

      await appendCustodyEvent({
        evidenceId: id,
        eventType: prismaPkg.CustodyEventType.VERIFICATION_PACKAGE_DOWNLOADED,
        payload: {
          version: latest.version,
          packageType: latest.packageType ?? null,
        },
        ip: req.ip,
        userAgent: req.headers["user-agent"],
      }).catch(() => null);

      auditEvidenceAction(req, {
        userId: ownerUserId,
        action: "verification.package_accessed",
        outcome: "success",
        resourceId: id,
        metadata: {
          packageKey: latest.storageKey,
          version: latest.version,
          packageType: latest.packageType ?? null,
        },
      });

return reply.code(200).send({
  evidenceId: id,
  version: latest.version,
  packageType: latest.packageType ?? null,
  key: latest.storageKey,
  url,
  generatedAtUtc: latest.generatedAtUtc.toISOString(),
  storage,
  trustDecision: toJsonSafe(latest.trustDecisionSnapshot ?? null),
});
    }
  );

  app.get(
    "/v1/evidence/:id/certifications",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply) => {
      const ownerUserId = getAuthUserId(req);
      const id = z.string().uuid().parse((req.params as ParamsId).id);

      (req as FastifyRequest & { evidenceId?: string }).evidenceId = id;
      req.log = req.log.child({ evidenceId: id });

      try {
        await getEvidenceWithReadAccess(ownerUserId, id);
        const certifications = await listEvidenceCertifications(id);

        auditEvidenceAction(req, {
          userId: ownerUserId,
          action: "evidence.certifications_listed",
          outcome: "success",
          resourceId: id,
          metadata: { certificationCount: certifications.length },
        });

        return reply.code(200).send({ evidenceId: id, certifications });
      } catch (err) {
        const statusCode =
          err instanceof Error && "statusCode" in err
            ? (err as Error & { statusCode?: number }).statusCode ?? 500
            : 500;
        const message = err instanceof Error ? err.message : "Unexpected error";
        return reply.code(statusCode).send({ message });
      }
    }
  );

  app.post(
    "/v1/evidence/:id/certifications/request",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply) => {
      const ownerUserId = getAuthUserId(req);
      const id = z.string().uuid().parse((req.params as ParamsId).id);
      const body = RequestEvidenceCertificationBody.parse(req.body);

      (req as FastifyRequest & { evidenceId?: string }).evidenceId = id;
      req.log = req.log.child({ evidenceId: id });

      try {
        await getEvidenceWithOwnerAccess(ownerUserId, id);

        const certification = await requestEvidenceCertification({
          evidenceId: id,
          declarationType: body.declarationType,
          requestedByUserId: ownerUserId,
        });

void appendCustodyEvent({
  evidenceId: id,
  eventType: prismaPkg.CustodyEventType.CERTIFICATION_REQUESTED,
  payload: {
    declarationType: body.declarationType,
    requestedByUserId: ownerUserId,
    version: certification.version,
  } as Prisma.InputJsonValue,
  ip: req.ip,
  userAgent: req.headers["user-agent"],
}).catch(() => null);
        auditEvidenceAction(req, {
          userId: ownerUserId,
action: "evidence.certification_requested",
          outcome: "success",
          resourceId: id,
          metadata: {
            declarationType: body.declarationType,
            version: certification.version,
          },
        });

        return reply.code(200).send({ evidenceId: id, certification });
      } catch (err) {
        const statusCode =
          err instanceof Error && "statusCode" in err
            ? (err as Error & { statusCode?: number }).statusCode ?? 500
            : 500;
        const message = err instanceof Error ? err.message : "Unexpected error";
        return reply.code(statusCode).send({ message });
      }
    }
  );

  app.post(
    "/v1/evidence/:id/certifications/revoke",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply) => {
      const ownerUserId = getAuthUserId(req);
      const id = z.string().uuid().parse((req.params as ParamsId).id);
      const body = RevokeEvidenceCertificationBody.parse(req.body);

      (req as FastifyRequest & { evidenceId?: string }).evidenceId = id;
      req.log = req.log.child({ evidenceId: id });

      try {
        await getEvidenceWithOwnerAccess(ownerUserId, id);

        const certification = await revokeEvidenceCertification({
          evidenceId: id,
          declarationType: body.declarationType,
          revokedByUserId: ownerUserId,
          reason: body.reason,
        });

        void appendCustodyEvent({
          evidenceId: id,
          eventType: prismaPkg.CustodyEventType.CERTIFICATION_REVOKED,
          payload: {
            declarationType: body.declarationType,
            revokedByUserId: ownerUserId,
            version: certification.version,
            revokeReason: certification.revokeReason,
          } as Prisma.InputJsonValue,
          ip: req.ip,
          userAgent: req.headers["user-agent"],
        }).catch(() => null);

        auditEvidenceAction(req, {
          userId: ownerUserId,
          action: "evidence.certification_revoked",
          outcome: "success",
          resourceId: id,
          metadata: {
            declarationType: body.declarationType,
            version: certification.version,
          },
        });

        return reply.code(200).send({ evidenceId: id, certification });
      } catch (err) {
        const statusCode =
          err instanceof Error && "statusCode" in err
            ? (err as Error & { statusCode?: number }).statusCode ?? 500
            : 500;
        const message = err instanceof Error ? err.message : "Unexpected error";
        return reply.code(statusCode).send({ message });
      }
    }
  );

  app.get("/public/verify/:id", async (req: FastifyRequest, reply) => {
    // Phase 1 — two-layer rate limit. Both buckets must allow.
    //   Layer 1 (per-IP): defends against scraping the UUID space.
    //   Layer 2 (per-evidence-id): defends against rotating-IP /
    //     proxy enumeration of a single record's verify history.
    // Both buckets are observable via the `verification.page_opened`
    // audit + the new `public_verify.rate_limited` warn log so an
    // operator can detect coordinated abuse.
    const limit = getVerifyLimit();
    const ipKey = `ratelimit:verify:ip:${req.ip}`;
    const ipRate = await enforceRateLimit({
      key: ipKey,
      max: limit.max,
      windowSec: limit.windowSec,
    });

    if (!ipRate.allowed) {
      const retryAfter = Math.max(
        1,
        Math.ceil((ipRate.resetAtMs - Date.now()) / 1000),
      );
      req.log.warn(
        {
          ip: req.ip,
          bucket: "ip",
          remaining: 0,
          resetAtMs: ipRate.resetAtMs,
          retryAfterSec: retryAfter,
        },
        "public_verify.rate_limited",
      );
      auditVerificationAction(req, {
        userId: null,
        action: "verification.page_opened",
        resourceId: null,
        metadata: { outcome: "rate_limited", bucket: "ip" },
      });
      reply.header("Retry-After", String(retryAfter));
      return reply
        .code(429)
        .send({ code: "RATE_LIMITED", message: "Rate limit exceeded" });
    }

    const id = z.string().uuid().parse((req.params as ParamsId).id);

    // Phase 1 — second bucket, keyed by evidence id. We parse the id
    // FIRST (above) so the bucket key is only set after validation;
    // unparseable input falls through to the zod 400 path without
    // consuming a rate-limit slot.
    const perEvidenceLimit = getVerifyPerEvidenceLimit();
    const perEvidenceRate = await enforceRateLimit({
      key: `ratelimit:verify:evidence:${id}`,
      max: perEvidenceLimit.max,
      windowSec: perEvidenceLimit.windowSec,
    });

    if (!perEvidenceRate.allowed) {
      const retryAfter = Math.max(
        1,
        Math.ceil((perEvidenceRate.resetAtMs - Date.now()) / 1000),
      );
      req.log.warn(
        {
          ip: req.ip,
          evidenceId: id,
          bucket: "evidence",
          remaining: 0,
          resetAtMs: perEvidenceRate.resetAtMs,
          retryAfterSec: retryAfter,
        },
        "public_verify.rate_limited",
      );
      auditVerificationAction(req, {
        userId: null,
        action: "verification.page_opened",
        resourceId: id,
        metadata: { outcome: "rate_limited", bucket: "evidence" },
      });
      reply.header("Retry-After", String(retryAfter));
      return reply
        .code(429)
        .send({ code: "RATE_LIMITED", message: "Rate limit exceeded" });
    }

    (req as FastifyRequest & { evidenceId?: string }).evidenceId = id;
    req.log = req.log.child({ evidenceId: id });

    const evidence = await prisma.evidence.findFirst({
      where: { id, deletedAt: null },
      select: {
        id: true,
        // Phase 31.12 — needed for the public Verify media-intelligence
        // advisory projection. NEVER surfaced in the response; used
        // only to scope the per-team intelligence count.
        teamId: true,
        // Phase 14 — explicit publication state gate. Records that
        // are NOT_PUBLISHED / SUSPENDED / UNPUBLISHED are not
        // returned from the public verify route.
        publicVerifyState: true,
        title: true,
        originalFileName: true,
        displayFileName: true,
        intakePlanJson: true,
        type: true,
        status: true,
        verificationStatus: true,
        captureMethod: true,
        identityLevelSnapshot: true,
        submittedByEmail: true,
        submittedByAuthProvider: true,
        verificationPackageMetadata: true,
        submittedByUserId: true,
        workspaceNameSnapshot: true,
        organizationNameSnapshot: true,
        organizationVerifiedSnapshot: true,
        createdAt: true,
        capturedAtUtc: true,
        uploadedAtUtc: true,
        signedAtUtc: true,
        recordedIntegrityVerifiedAtUtc: true,
        lastVerifiedAtUtc: true,
        lastVerifiedSource: true,
        // Phase D Blocker 1 — analytics-only column, surfaced separately
        // from lastVerifiedAtUtc on the verify page.
        lastPublicVerifyViewAtUtc: true,
        verificationPackageGeneratedAtUtc: true,
        verificationPackageVersion: true,
        latestReportVersion: true,
        reviewReadyAtUtc: true,
        reviewerSummaryVersion: true,
        mimeType: true,
        sizeBytes: true,
        reportGeneratedAtUtc: true,
        deviceTimeIso: true,
        lat: true,
        lng: true,
        accuracyMeters: true,
        fingerprintCanonicalJson: true,
        fingerprintHash: true,
        // Phase C #4 — multipart hash semantics in public verify too.
        multipartManifestSha256: true,
        hashSemantics: true,
        signatureBase64: true,
        signingKeyId: true,
        signingKeyVersion: true,
        fileSha256: true,
        tsaProvider: true,
        tsaUrl: true,
        tsaSerialNumber: true,
        tsaGenTimeUtc: true,
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
        storageBucket: true,
        storageKey: true,
        storageRegion: true,
        storageObjectLockMode: true,
        storageObjectLockRetainUntilUtc: true,
        storageObjectLockLegalHoldStatus: true,
      },
    });

    // Issue #4: Public verify must reject pre-finalized records.
    //
    // Before finalization the record has no fingerprint, no signature, no
    // verification artifacts. Returning a verify response in those states
    // would let UUID enumeration enrich the record, mislead viewers about
    // verification state, and produce an apparently-valid verify response
    // for an empty record. Treat as not-yet-available.
    if (!evidence) {
      return reply.code(404).send({ message: "Evidence not found" });
    }
    // Phase 14 — additive publication gate. When the evidence is not
    // explicitly PUBLISHED (NOT_PUBLISHED / SUSPENDED / UNPUBLISHED),
    // return 404 with no leak of state. This is BEFORE finalization
    // and policy checks so suspension is fast-fail and the response
    // body never contains governance state.
    if (evidence.publicVerifyState !== "PUBLISHED") {
      auditVerificationAction(req, {
        userId: null,
        action: "verification.page_opened",
        resourceId: id,
        metadata: {
          outcome: "publication_not_available",
          publicVerifyState: evidence.publicVerifyState,
        },
      });
      return reply.code(404).send({ message: "Evidence not found" });
    }
    {
      const evidenceStatus = evidence.status as
        | prismaPkg.EvidenceStatus
        | null;
      const isFinalized =
        evidenceStatus === EvidenceStatus.SIGNED ||
        evidenceStatus === EvidenceStatus.REPORTED;
      if (!isFinalized) {
        auditVerificationAction(req, {
          userId: null,
          action: "verification.page_opened",
          resourceId: id,
          metadata: {
            outcome: "not_finalized",
            status: evidenceStatus ?? null,
          },
        });
        return reply.code(409).send({
          code: "EVIDENCE_NOT_FINALIZED",
          message:
            "This evidence record has not been finalized yet. A verification response is not available for pre-finalized records.",
          status: evidenceStatus ?? null,
        });
      }
    }

    const [latestCustodianCertification, latestQualifiedPersonCertification] =
      await Promise.all([
        prisma.evidenceCertification.findFirst({
          where: {
            evidenceId: id,
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
            evidenceId: id,
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

    const publicCertifications = {
      custodian: latestCustodianCertification
        ? {
            declarationType: latestCustodianCertification.declarationType,
            status: latestCustodianCertification.status,
            version: latestCustodianCertification.version,
            requestedAtUtc:
              latestCustodianCertification.requestedAtUtc?.toISOString() ?? null,
            attestedAtUtc:
              latestCustodianCertification.attestedAtUtc?.toISOString() ?? null,
            attestorName: latestCustodianCertification.attestorName,
            attestorTitle: latestCustodianCertification.attestorTitle,
            attestorOrganization:
              latestCustodianCertification.attestorOrganization,
            certificationHash: latestCustodianCertification.certificationHash,
            revokedAtUtc:
              latestCustodianCertification.revokedAtUtc?.toISOString() ?? null,
            revokeReason: latestCustodianCertification.revokeReason,
          }
        : null,
      qualifiedPerson: latestQualifiedPersonCertification
        ? {
            declarationType: latestQualifiedPersonCertification.declarationType,
            status: latestQualifiedPersonCertification.status,
            version: latestQualifiedPersonCertification.version,
            requestedAtUtc:
              latestQualifiedPersonCertification.requestedAtUtc?.toISOString() ?? null,
            attestedAtUtc:
              latestQualifiedPersonCertification.attestedAtUtc?.toISOString() ?? null,
            attestorName: latestQualifiedPersonCertification.attestorName,
            attestorTitle: latestQualifiedPersonCertification.attestorTitle,
            attestorOrganization:
              latestQualifiedPersonCertification.attestorOrganization,
            certificationHash:
              latestQualifiedPersonCertification.certificationHash,
            revokedAtUtc:
              latestQualifiedPersonCertification.revokedAtUtc?.toISOString() ?? null,
            revokeReason: latestQualifiedPersonCertification.revokeReason,
          }
        : null,
    };

    if (!evidence) {
      return reply.code(404).send({ message: "Evidence not found" });
    }

    if (
      !evidence.fingerprintCanonicalJson ||
      !evidence.fingerprintHash ||
      !evidence.signatureBase64 ||
      !evidence.signingKeyId ||
      !evidence.signingKeyVersion ||
      !evidence.fileSha256
    ) {
      return reply.code(404).send({ message: "Evidence not signed" });
    }

    const signingKey = await prisma.signingKey.findUnique({
      where: {
        keyId_version: {
          keyId: evidence.signingKeyId,
          version: evidence.signingKeyVersion,
        },
      },
      select: { publicKeyPem: true },
    });

    if (!signingKey) {
      // Phase 1 — a SIGNED evidence row with no matching signing_keys
      // row is an OPERATIONAL FAILURE, not a normal 404. The seed step
      // (services/api/src/seed-signing-key.ts) was either skipped on
      // this environment or pointed at the wrong (keyId, version) pair.
      // The runtime audit hit this exact case on a fresh local-pem
      // environment.
      //
      // Two consequences:
      //   1. Log at WARN with an operational alert flag so the on-call
      //      gets paged before users see broken verify pages.
      //   2. Return a GENERIC public response. The exact internal
      //      cause ("signing key id X version Y not in signing_keys
      //      table") leaks operator-only information.
      req.log.warn(
        {
          alert: true,
          severity: "critical",
          reason: "signing_key_missing_for_signed_evidence",
          evidenceId: id,
          signingKeyId: evidence.signingKeyId,
          signingKeyVersion: evidence.signingKeyVersion,
        },
        "operational.alert",
      );
      auditVerificationAction(req, {
        userId: null,
        action: "verification.page_opened",
        resourceId: id,
        metadata: {
          outcome: "signing_key_missing",
          signingKeyId: evidence.signingKeyId,
          signingKeyVersion: evidence.signingKeyVersion,
        },
      });
      return reply
        .code(503)
        .send({
          code: "VERIFICATION_TEMPORARILY_UNAVAILABLE",
          message:
            "Verification is temporarily unavailable. Please retry in a few minutes.",
        });
    }

    const allCustodyEvents = await prisma.custodyEvent.findMany({
      where: { evidenceId: id },
      orderBy: { sequence: "asc" },
      take: 500,
      select: {
        sequence: true,
        atUtc: true,
        eventType: true,
        payload: true,
        prevEventHash: true,
        eventHash: true,
      },
    });

    const forensicCustodyEvents = allCustodyEvents.filter(
      (ev) => classifyCustodyEventType(ev.eventType) === "forensic"
    );

    const accessCustodyEvents = allCustodyEvents.filter(
      (ev) => classifyCustodyEventType(ev.eventType) === "access"
    );

const latestReport = await prisma.report.findFirst({
  where: { evidenceId: id },
  orderBy: { version: "desc" },
  select: {
    version: true,
    generatedAtUtc: true,
    embeddedPreviewsSnapshot: true,
    trustDecisionSnapshot: true,
  },
});

const latestVerificationPackage = await prisma.verificationPackage.findFirst({
  where: { evidenceId: id },
  orderBy: { version: "desc" },
  select: {
    version: true,
    generatedAtUtc: true,
    packageType: true,
    storageBucket: true,
    storageKey: true,
    trustDecisionSnapshot: true,
  },
});

const verificationPackageAvailable = Boolean(latestVerificationPackage);

const persistedVerificationPackageMetadata =
  isVerificationPackageMetadata(evidence.verificationPackageMetadata)
    ? evidence.verificationPackageMetadata
    : null;

let verificationPackageIntegrity: PublicVerificationPackageIntegrity;

if (persistedVerificationPackageMetadata) {
  verificationPackageIntegrity = {
    available: verificationPackageAvailable,
    version: latestVerificationPackage?.version ?? null,
    generatedAtUtc: latestVerificationPackage?.generatedAtUtc
      ? latestVerificationPackage.generatedAtUtc.toISOString()
      : null,
    packageType: latestVerificationPackage?.packageType ?? null,

    manifestPresent: persistedVerificationPackageMetadata.manifestPresent,
    signedManifestPresent:
      persistedVerificationPackageMetadata.signedManifestPresent,
    manifestDigestPresent:
      persistedVerificationPackageMetadata.signedManifestPresent,
    checksumIndexPresent:
      persistedVerificationPackageMetadata.checksumIndexPresent,
    offlineVerifierIncluded:
      persistedVerificationPackageMetadata.offlineVerifierIncluded,
    auditExportIncluded:
      persistedVerificationPackageMetadata.auditExportIncluded ?? false,
    custodyExportIncluded:
      persistedVerificationPackageMetadata.custodyExportIncluded ?? false,
    accessExportIncluded:
      persistedVerificationPackageMetadata.accessExportIncluded ?? false,
  };
} else if (verificationPackageAvailable) {
  const inspectedVerificationPackageArtifacts =
    await inspectVerificationPackageArtifacts(
      latestVerificationPackage?.storageBucket ?? null,
      latestVerificationPackage?.storageKey ?? null
    );

  verificationPackageIntegrity = {
    available: true,
    version: latestVerificationPackage?.version ?? null,
    generatedAtUtc: latestVerificationPackage?.generatedAtUtc
      ? latestVerificationPackage.generatedAtUtc.toISOString()
      : null,
    packageType: latestVerificationPackage?.packageType ?? null,

    manifestPresent:
      inspectedVerificationPackageArtifacts?.manifestPresent ?? false,
    signedManifestPresent:
      inspectedVerificationPackageArtifacts?.signedManifestPresent ?? false,
    manifestDigestPresent:
      inspectedVerificationPackageArtifacts?.manifestDigestPresent ?? false,
    checksumIndexPresent:
      inspectedVerificationPackageArtifacts?.checksumIndexPresent ?? false,
    offlineVerifierIncluded:
      inspectedVerificationPackageArtifacts?.offlineVerifierIncluded ?? false,
    auditExportIncluded:
      inspectedVerificationPackageArtifacts?.auditExportIncluded ?? false,
    custodyExportIncluded:
      inspectedVerificationPackageArtifacts?.custodyExportIncluded ?? false,
    accessExportIncluded:
      inspectedVerificationPackageArtifacts?.accessExportIncluded ?? false,
  };

  if (inspectedVerificationPackageArtifacts) {
    try {
      await prisma.evidence.update({
        where: { id: evidence.id },
        data: {
          verificationPackageMetadata: {
            manifestPresent:
              inspectedVerificationPackageArtifacts.manifestPresent,
            signedManifestPresent:
              inspectedVerificationPackageArtifacts.signedManifestPresent,
            checksumIndexPresent:
              inspectedVerificationPackageArtifacts.checksumIndexPresent,
            offlineVerifierIncluded:
              inspectedVerificationPackageArtifacts.offlineVerifierIncluded,
            auditExportIncluded:
              inspectedVerificationPackageArtifacts.auditExportIncluded,
            custodyExportIncluded:
              inspectedVerificationPackageArtifacts.custodyExportIncluded,
            accessExportIncluded:
              inspectedVerificationPackageArtifacts.accessExportIncluded,
            packageVersion: "v1",
            generatedAtUtc:
              evidence.verificationPackageGeneratedAtUtc?.toISOString() ??
              latestVerificationPackage?.generatedAtUtc?.toISOString() ??
              new Date().toISOString(),
            inspectedAtUtc: new Date().toISOString(),
            source: "ZIP_INSPECTION",
          },
        },
      });
    } catch (updateError) {
      console.warn(
        "Unable to backfill verification package metadata after ZIP inspection:",
        updateError
      );
    }
  }
} else {
  verificationPackageIntegrity = {
    available: false,
    version: latestVerificationPackage?.version ?? null,
    generatedAtUtc: latestVerificationPackage?.generatedAtUtc
      ? latestVerificationPackage.generatedAtUtc.toISOString()
      : null,
    packageType: latestVerificationPackage?.packageType ?? null,
    manifestPresent: false,
    signedManifestPresent: false,
    manifestDigestPresent: false,
    checksumIndexPresent: false,
    offlineVerifierIncluded: false,
    auditExportIncluded: false,
    custodyExportIncluded: false,
    accessExportIncluded: false,
  };
}

const snapshotTrustDecision =
  normalizeTrustDecisionSnapshot(latestReport?.trustDecisionSnapshot) ??
  normalizeTrustDecisionSnapshot(
    latestVerificationPackage?.trustDecisionSnapshot
  ) ??
  null;

    const itemCount = await getEvidenceItemCount(id);

        const parts = await prisma.evidencePart.findMany({
      where: { evidenceId: id },
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
        privateRole: true,
        checklistStepId: true,
      },
    });

const reportPreviewMap = new Map<
  string,
  {
    previewDataUrl?: string | null;
    previewTextExcerpt?: string | null;
    previewCaption?: string | null;
  }
>();

if (Array.isArray(latestReport?.embeddedPreviewsSnapshot)) {
  for (const item of latestReport.embeddedPreviewsSnapshot) {
    if (
      item &&
      typeof item === "object" &&
      "id" in item &&
      typeof item.id === "string"
    ) {
      reportPreviewMap.set(item.id, {
        previewDataUrl:
          "previewDataUrl" in item && typeof item.previewDataUrl === "string"
            ? item.previewDataUrl
            : null,
        previewTextExcerpt:
          "previewTextExcerpt" in item &&
          typeof item.previewTextExcerpt === "string"
            ? item.previewTextExcerpt
            : null,
        previewCaption:
          "previewCaption" in item && typeof item.previewCaption === "string"
            ? item.previewCaption
            : null,
      });
    }
  }
}

const publicVerifyAccessPolicy = resolveEvidenceContentAccessPolicyForSurface({
  configuredMode: process.env.PUBLIC_VERIFY_CONTENT_MODE ?? "preview_only",
  surface: "public_verify",
});
const content = await buildPublicEvidenceContent({
  accessPolicy: publicVerifyAccessPolicy,
  previews: reportPreviewMap,
  evidence: {
    id: evidence.id,
    mimeType: evidence.mimeType,
    sizeBytes: evidence.sizeBytes,
    storageBucket: evidence.storageBucket,
    storageKey: evidence.storageKey,
    fileSha256: evidence.fileSha256,
    intakePlanJson: evidence.intakePlanJson ?? null,
originalFileName: evidence.originalFileName ?? null,
displayFileName: evidence.displayFileName ?? null,
    recordedAt: evidence.capturedAtUtc ?? evidence.createdAt,
  },
  parts,
});

    const recomputedFingerprintHash = sha256Hex(
      evidence.fingerprintCanonicalJson
    );
    const canonicalHashMatches =
      recomputedFingerprintHash === evidence.fingerprintHash;

    let signatureValid = false;
    try {
      signatureValid = ed25519VerifyHexSignature({
        messageHex: recomputedFingerprintHash,
        signatureBase64: evidence.signatureBase64,
        publicKeyPem: signingKey.publicKeyPem,
      });
    } catch {
      signatureValid = false;
    }

const normalizedTsaStatus = String(evidence.tsaStatus ?? "")
  .trim()
  .toUpperCase();

const timestampInputDigestHex =
  evidence.tsaInputDigestHex ?? evidence.fileSha256;

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

const timestampDigestMatches: boolean | null = timestampStatusIsPositive
  ? Boolean(evidence.tsaMessageImprint && timestampInputDigestHex) &&
    String(evidence.tsaMessageImprint).toLowerCase() ===
      timestampInputDigestHex.toLowerCase()
  : timestampStatusIsUnavailable
    ? null
    : null;

const effectiveOtsStatus = resolveEffectiveOtsStatus({
  status: evidence.otsStatus,
  anchoredAtUtc: evidence.otsAnchoredAtUtc,
});
    const effectiveOtsAnchoredAtUtc =
      effectiveOtsStatus === "ANCHORED" ? evidence.otsAnchoredAtUtc : null;
    const otsHashMatches =
      evidence.otsHash && evidence.fingerprintHash
        ? evidence.otsHash.toLowerCase() ===
          evidence.fingerprintHash.toLowerCase()
        : null;

    const custodyChain = evaluateCustodyChain({
      evidenceId: id,
      records: allCustodyEvents.map((ev) => ({
        sequence: ev.sequence,
        eventType: ev.eventType,
        atUtc: ev.atUtc,
        payload: ev.payload,
        prevEventHash: ev.prevEventHash,
        eventHash: ev.eventHash,
      })),
    });

    const storageProtection = await getStorageProtectionSummary(
      evidence.storageBucket,
      evidence.storageKey,
      {
        storageRegion: evidence.storageRegion,
        storageObjectLockMode: evidence.storageObjectLockMode,
        storageObjectLockRetainUntilUtc:
          evidence.storageObjectLockRetainUntilUtc,
        storageObjectLockLegalHoldStatus:
          evidence.storageObjectLockLegalHoldStatus,
      }
    );

    const anchor = await getAnchorStatus(id);

const liveTrustDecision = buildEvidenceTrustDecision({
  evidence: {
    verificationStatus: evidence.verificationStatus ?? null,
    recordedIntegrityVerifiedAtUtc:
      evidence.recordedIntegrityVerifiedAtUtc?.toISOString() ?? null,
    fileSha256: evidence.fileSha256 ?? null,
    fingerprintHash: evidence.fingerprintHash ?? null,
    signatureBase64: evidence.signatureBase64 ?? null,
    signingKeyId: evidence.signingKeyId ?? null,
    publicKeyPem: signingKey.publicKeyPem ?? null,
    tsaStatus: evidence.tsaStatus ?? null,
    tsaFailureReason: evidence.tsaFailureReason ?? null,
    otsStatus: effectiveOtsStatus,
    otsHash: evidence.otsHash ?? null,
    otsBitcoinTxid: evidence.otsBitcoinTxid ?? null,
    otsAnchoredAtUtc: effectiveOtsAnchoredAtUtc?.toISOString() ?? null,
    otsCalendar: evidence.otsCalendar ?? null,
    otsFailureReason: evidence.otsFailureReason ?? null,
    storageImmutable: storageProtection?.immutable ?? null,
    storageObjectLockMode: storageProtection?.mode ?? null,
    storageObjectLockRetainUntilUtc: storageProtection?.retainUntil ?? null,
    identityLevelSnapshot: evidence.identityLevelSnapshot ?? null,
    submittedByEmail: evidence.submittedByEmail ?? null,
    submittedByAuthProvider: evidence.submittedByAuthProvider ?? null,
    verificationPackageVersion:
      latestVerificationPackage?.version ??
      evidence.verificationPackageVersion ??
      null,
    verificationPackageGeneratedAtUtc:
      latestVerificationPackage?.generatedAtUtc?.toISOString() ??
      evidence.verificationPackageGeneratedAtUtc?.toISOString() ??
      null,
    anchor: anchor
      ? {
          configured: anchor.configured,
          published: anchor.published,
          provider: anchor.provider,
          publicUrl: anchor.publicUrl,
          anchoredAtUtc: anchor.anchoredAtUtc,
          transactionId: anchor.transactionId,
          receiptId: anchor.receiptId,
        }
      : null,
  },
  custodyEvents: allCustodyEvents.map((event) => ({
    eventType: event.eventType,
    category: classifyCustodyEventType(event.eventType),
    eventHash: event.eventHash ?? null,
    prevEventHash: event.prevEventHash ?? null,
  })),
});

const trustDecision = snapshotTrustDecision ?? liveTrustDecision;
const trustDecisionConsistencySource = snapshotTrustDecision
  ? latestReport?.trustDecisionSnapshot
    ? "REPORT_SNAPSHOT"
    : "VERIFICATION_PACKAGE_SNAPSHOT"
  : "LIVE_SHARED_FALLBACK";

const timestampLayerBlocksIntegrity = timestampDigestMatches === false;

const overallIntegrity =
  canonicalHashMatches &&
  signatureValid &&
  custodyChain.valid &&
  !timestampLayerBlocksIntegrity &&
  otsHashMatches !== false;

    const verifiedAt = new Date();
    const responseVerificationStatus = evidence.verificationStatus ?? null;

    // Public-verify post-processing.
    //
    // Issue #2 (sampling removed) + Issue #4 (gate on finalized status) +
    // Issue #12 (separate analytics from forensic verification state).
    //
    // - Anonymous public hits NEVER write custody events. The forensic chain
    //   should not contain entries that imply a meaningful technical
    //   verification was performed by anyone with reviewer authority. The
    //   verification_views row + the new lastPublicVerifyViewAtUtc column
    //   carry the analytics signal cleanly.
    // - lastVerifiedAtUtc is reserved for meaningful verification events
    //   (report generation, explicit reviewer technical-verification action).
    //   It is NOT bumped by public-verify hits anymore.
    // - For pre-finalized records (status not in SIGNED/REPORTED), we still
    //   record the analytics view but do NOT update lastVerified* fields and
    //   do NOT include the analytics view if the record cannot meaningfully
    //   be verified yet. The verify response itself still serves the public
    //   page (which explains the not-yet-finalized state honestly).
    const evidenceStatusForGate = evidence.status as
      | prismaPkg.EvidenceStatus
      | null;
    const isFinalizedForVerify =
      evidenceStatusForGate === EvidenceStatus.SIGNED ||
      evidenceStatusForGate === EvidenceStatus.REPORTED;

    if (isFinalizedForVerify) {
      // Phase 32.7.1 — BLOCKER FIX. The previous implementation
      // awaited a `prisma.$transaction([evidence.update,
      // verificationView.create])` here, blocking the public verify
      // response on two analytics writes. Under Neon connection
      // pressure the transaction failed to start within the pooler
      // window, raising
      //   "Unable to start a transaction in the given time"
      // and propagating to Sentry as a high-priority issue. The
      // verify response then returned 500 even though the actual
      // verification data was already read successfully above.
      //
      // The two writes are ANALYTICS-ONLY:
      //   * `lastPublicVerifyViewAtUtc` is a UI timestamp; it does
      //     NOT imply a meaningful technical verification.
      //   * `verificationView.create()` is a view-counter row used
      //     by the access export in the verification package.
      //
      // Neither needs atomicity, neither needs to block the
      // response, and a failure on either is non-forensic.
      //
      // The fix:
      //   1. Drop the `$transaction` wrapper. Each write becomes an
      //      independent statement, releasing its pool slot as soon
      //      as the single statement completes.
      //   2. Fire-and-forget. The response now does not await.
      //   3. Failures log a bounded WARN line and do NOT propagate
      //      to Sentry (no `captureException`).
      //
      // Custody / audit / forensic semantics: UNCHANGED. The
      // `auditVerificationAction()` call below remains, and it
      // already wraps its own platform-audit-log append in a
      // fire-and-forget `.catch(() => null)`.
      const viewerUserAgent = readUserAgent(req);
      const viewerIp = req.ip;
      void (async () => {
        const results = await Promise.allSettled([
          prisma.evidence.update({
            where: { id },
            data: { lastPublicVerifyViewAtUtc: verifiedAt },
          }),
          prisma.verificationView.create({
            data: {
              evidenceId: id,
              viewerType: VerificationViewerType.PUBLIC,
              viewerUserId: null,
              accessMode: "public_verify",
              ipAddress: viewerIp,
              userAgent: viewerUserAgent,
            },
          }),
        ]);
        const failures = results
          .map((r, i) => (r.status === "rejected" ? { i, r } : null))
          .filter((x): x is { i: number; r: PromiseRejectedResult } => x !== null);
        if (failures.length > 0) {
          for (const { i, r } of failures) {
            const which = i === 0 ? "evidence.lastPublicVerifyViewAtUtc" : "verificationView";
            req.log.warn(
              {
                evidenceId: id,
                err:
                  r.reason instanceof Error
                    ? r.reason.message.slice(0, 200)
                    : String(r.reason).slice(0, 200),
                code:
                  r.reason instanceof Error && "code" in r.reason
                    ? (r.reason as { code?: string }).code ?? null
                    : null,
                surface: which,
              },
              "public_verify.access_log_failed",
            );
          }
        }
      })().catch((err) => {
        // Defensive: the inner block already swallows. This catch
        // exists for the truly pathological case where the IIFE
        // itself rejects before reaching the inner try.
        req.log.warn(
          {
            evidenceId: id,
            err: err instanceof Error ? err.message : String(err),
          },
          "public_verify.access_log_iife_failed",
        );
      });
    }

    auditVerificationAction(req, {
      userId: null,
      action: "verification.page_opened",
      resourceId: id,
      metadata: {
        evidenceId: id,
        overallIntegrity,
        finalizedForVerify: isFinalizedForVerify,
        // Sampling removed: public verify never writes custody events.
        custodyEventSampled: false,
      },
    });

    const custodyDisplayContext = {
      itemCount: content.summary.itemCount,
      structure: content.summary.structure,
    } as const;

    const mappedForensicEvents = forensicCustodyEvents.map((event) =>
      mapPublicCustodyEvent(event, custodyDisplayContext)
    );
    const mappedAccessEvents = accessCustodyEvents.map((event) =>
      mapPublicCustodyEvent(event, custodyDisplayContext)
    );

    // Phase 1 — apply public-verify identity exposure policy. The
    // default-redacted policy strips submittedByEmail entirely and
    // hides workspaceName / organizationName unless the operator
    // explicitly opted in via PUBLIC_VERIFY_EXPOSE_ATTRIBUTION=true.
    // organizationVerified (boolean) and submittedByAuthProvider
    // (the human label only, not the raw enum code) remain by
    // default — they communicate auth provenance without identifying
    // the organization.
    const identityExposure = getPublicVerifyIdentityExposure();
    if (!identityExposure.exposeAttribution) {
      req.log.info(
        {
          evidenceId: id,
          reason: identityExposure.reason,
          redacted: [
            "submittedByEmail",
            "workspaceName",
            "organizationName",
          ],
        },
        "public_verify.identity_redacted",
      );
    }
    const overview = buildPublicVerifyOverview({
      evidence: {
        id: evidence.id,
title: evidence.title ?? evidence.displayFileName ?? evidence.originalFileName ?? null,
        type: evidence.type,
        status: evidence.status,
        verificationStatus: responseVerificationStatus,
        captureMethod: evidence.captureMethod ?? null,
        identityLevelSnapshot: evidence.identityLevelSnapshot ?? null,
        // Phase 1 — PII redaction. submittedByEmail is ALWAYS null
        // on the public surface. maskPublicEmail (used downstream)
        // still leaked the domain, which is enough to identify the
        // submitter's organization for a journalist's source or an
        // insurance claimant. The mask is no longer reachable on
        // the public response path.
        submittedByEmail: null,
        submittedByAuthProvider: evidence.submittedByAuthProvider ?? null,
        workspaceNameSnapshot: identityExposure.exposeAttribution
          ? evidence.workspaceNameSnapshot ?? null
          : null,
        organizationNameSnapshot: identityExposure.exposeAttribution
          ? evidence.organizationNameSnapshot ?? null
          : null,
        organizationVerifiedSnapshot:
          evidence.organizationVerifiedSnapshot ?? null,
        mimeType: evidence.mimeType,
        createdAt: evidence.createdAt,
        capturedAtUtc: evidence.capturedAtUtc,
        uploadedAtUtc: evidence.uploadedAtUtc,
        signedAtUtc: evidence.signedAtUtc,
        recordedIntegrityVerifiedAtUtc:
          evidence.recordedIntegrityVerifiedAtUtc,
        // Phase D Blocker 1 — pass through the ACTUAL meaningful-verification
        // timestamp from the database. Do NOT inject the current page-view
        // time as "last verified". The current page-view time flows through
        // currentPublicVerifyViewAtUtc below.
        lastVerifiedAtUtc: evidence.lastVerifiedAtUtc,
        lastVerifiedSource: evidence.lastVerifiedSource ?? null,
        lastPublicVerifyViewAtUtc:
          evidence.lastPublicVerifyViewAtUtc ?? null,
        reviewReadyAtUtc: evidence.reviewReadyAtUtc,
verificationPackageGeneratedAtUtc:
  latestVerificationPackage?.generatedAtUtc ??
  evidence.verificationPackageGeneratedAtUtc,

verificationPackageVersion:
  latestVerificationPackage?.version ??
  evidence.verificationPackageVersion,
          latestReportVersion: evidence.latestReportVersion,
        reviewerSummaryVersion: evidence.reviewerSummaryVersion,
        reportGeneratedAtUtc: evidence.reportGeneratedAtUtc,
      },
      latestReport,
      itemCount,
      storageProtection,
      timestampStatus: evidence.tsaStatus,
      timestampDigestMatches,
      otsStatus: effectiveOtsStatus,
      overallIntegrity,
      chainOfCustodyPresent: forensicCustodyEvents.length > 0,
      anchor,
      contentSummary: content.summary,
      trustDecision,
      // Phase D Blocker 1 — surface the current page-view time as a
      // separate analytics field. The verify page renders this as
      // "Current public verify page view", NOT "Last verified".
      currentPublicVerifyViewAtUtc: verifiedAt,
    });

    const humanSummary = buildPublicVerifyHumanSummary({
      overview,
      canonicalHashMatches,
      signatureValid,
      custodyChainValid: custodyChain.valid,
      timestampDigestMatches,
      otsHashMatches,
      overallIntegrity,
      trustDecision,
    });

    const limitations = buildPublicVerifyLimitations();

    const reviewGuidance = buildPublicReviewGuidance({
      itemCount: content.summary.itemCount,
      previewableItemCount: content.summary.previewableItemCount,
      overallIntegrity,
    });

    const integrityProof: PublicVerifyIntegrityProof = {
  overallIntegrity,
  canonicalHashMatches,
  signatureValid,
  custodyChainValid: custodyChain.valid,
  custodyChainMode: custodyChain.mode,
  custodyChainFailureReason: custodyChain.reason,
  timestampDigestMatches,
  otsHashMatches,
};

const custodyLifecycle = buildPublicCustodyLifecycle({
  forensicEvents: mappedForensicEvents,
  accessEvents: mappedAccessEvents,
});

const reportGeneratedAtUtc =
  latestReport?.generatedAtUtc ?? evidence.reportGeneratedAtUtc ?? null;

const forensicEventsAtReportGeneration = reportGeneratedAtUtc
  ? forensicCustodyEvents.filter((ev) => ev.atUtc <= reportGeneratedAtUtc)
  : forensicCustodyEvents;

const accessEventsAfterReportGeneration = reportGeneratedAtUtc
  ? accessCustodyEvents.filter((ev) => ev.atUtc > reportGeneratedAtUtc)
  : accessCustodyEvents;

const snapshotGeneratedAtUtc =
  trustDecisionConsistencySource === "REPORT_SNAPSHOT"
    ? latestReport?.generatedAtUtc ?? evidence.reportGeneratedAtUtc ?? null
    : trustDecisionConsistencySource === "VERIFICATION_PACKAGE_SNAPSHOT"
      ? latestVerificationPackage?.generatedAtUtc ??
        evidence.verificationPackageGeneratedAtUtc ??
        null
      : null;

const trustDecisionConsistency = buildTrustDecisionConsistency({
  snapshotTrustDecision,
  liveTrustDecision,
  source: trustDecisionConsistencySource,
  snapshotGeneratedAtUtc,
  latestReportGeneratedAtUtc:
    latestReport?.generatedAtUtc ?? evidence.reportGeneratedAtUtc ?? null,
  latestReportVersion:
    latestReport?.version ?? evidence.latestReportVersion ?? null,
  latestVerificationPackageGeneratedAtUtc:
    latestVerificationPackage?.generatedAtUtc ??
    evidence.verificationPackageGeneratedAtUtc ??
    null,
  latestVerificationPackageVersion:
    latestVerificationPackage?.version ??
    evidence.verificationPackageVersion ??
    null,
  forensicEventsAtSnapshot: forensicEventsAtReportGeneration.length,
  currentForensicEvents: forensicCustodyEvents.length,
  accessEventsAfterSnapshot: accessEventsAfterReportGeneration.length,
});

const custodyDisplayCounts = {
  forensicAtReportGeneration: forensicEventsAtReportGeneration.length,
  currentForensicEvents: forensicCustodyEvents.length,
  currentForensic: forensicCustodyEvents.length,
  accessAfterReportGeneration: accessEventsAfterReportGeneration.length,
  currentAccessEvents: accessCustodyEvents.length,
  totalDisplayedEvents:
    forensicCustodyEvents.length + accessCustodyEvents.length,
  totalDisplayedNow:
    forensicCustodyEvents.length + accessCustodyEvents.length,
  reportGeneratedAtUtc: reportGeneratedAtUtc
    ? reportGeneratedAtUtc.toISOString()
    : null,
};

const technicalMaterials = buildTechnicalMaterials({
  evidence: {
    fileSha256: evidence.fileSha256,
    multipartManifestSha256: evidence.multipartManifestSha256 ?? null,
    hashSemantics: evidence.hashSemantics ?? null,
    fingerprintHash: evidence.fingerprintHash,
    signatureBase64: evidence.signatureBase64,
    signingKeyId: evidence.signingKeyId,
    signingKeyVersion: evidence.signingKeyVersion,
    tsaMessageImprint: evidence.tsaMessageImprint,
    tsaInputDigestHex: evidence.tsaInputDigestHex,
    tsaInputKind: evidence.tsaInputKind,
    otsProofBase64: evidence.otsProofBase64,
  },
  publicKeyPem: signingKey.publicKeyPem,
  partsCount: parts.length,
});

const versioning: PublicVerifyVersioning = {
  latestReportVersion:
    latestReport?.version ?? evidence.latestReportVersion ?? null,
  latestReportGeneratedAtUtc: latestReport?.generatedAtUtc
    ? latestReport.generatedAtUtc.toISOString()
    : evidence.reportGeneratedAtUtc
      ? evidence.reportGeneratedAtUtc.toISOString()
      : null,
verificationPackageVersion:
  latestVerificationPackage?.version ??
  evidence.verificationPackageVersion ??
  null,

verificationPackageGeneratedAtUtc:
  latestVerificationPackage?.generatedAtUtc
    ? latestVerificationPackage.generatedAtUtc.toISOString()
    : evidence.verificationPackageGeneratedAtUtc
      ? evidence.verificationPackageGeneratedAtUtc.toISOString()
      : null,
        reviewerSummaryVersion: evidence.reviewerSummaryVersion ?? null,
};
const defaultPreviewItem =
  content.items.find((item) => item.previewable && item.viewUrl) ??
  content.items.find((item) => item.viewUrl) ??
  content.primaryItem ??
  null;
const display = buildEvidenceDisplayDescriptor({
title: evidence.title ?? evidence.displayFileName ?? evidence.originalFileName ?? null,
  summary: content.summary,
  itemCount,
});

const captureContext = hasCaptureLocationMetadata({
  lat: decimalToNumber(evidence.lat),
  lng: decimalToNumber(evidence.lng),
})
  ? {
      statusLabel: CAPTURE_LOCATION_STATUS_LABEL,
      description: CAPTURE_LOCATION_CONTEXT_DESCRIPTION,
      lat: decimalToNumber(evidence.lat),
      lng: decimalToNumber(evidence.lng),
      accuracyMeters: decimalToNumber(evidence.accuracyMeters),
      capturedAtUtc: evidence.capturedAtUtc
        ? evidence.capturedAtUtc.toISOString()
        : evidence.createdAt.toISOString(),
      deviceTimeIso: evidence.deviceTimeIso ?? null,
      source: CAPTURE_LOCATION_SOURCE_LABEL,
      externalMapUrl:
        buildCaptureLocationExternalMapUrl({
          lat: decimalToNumber(evidence.lat),
          lng: decimalToNumber(evidence.lng),
          accuracyMeters: decimalToNumber(evidence.accuracyMeters),
        }) ?? null,
      legalBoundary: CAPTURE_LOCATION_LEGAL_BOUNDARY,
    }
  : null;

// Phase 31.12 — bounded public-safe media intelligence advisory.
// Returns null when there are no surfaceable signals OR when the
// projection fails. NEVER throws — the verify response is unchanged
// (other than `mediaIntelligenceAdvisory: null`) in the no-data
// case. The projection re-uses the canonical team-scoped read.
const mediaIntelligenceAdvisory = evidence.teamId
  ? await (async () => {
      try {
        const { projectVerifyMediaIntelligence } = await import(
          "../services/media-intelligence/verify-projection.service.js"
        );
        return await projectVerifyMediaIntelligence(
          { teamId: evidence.teamId!, evidenceId: evidence.id },
        );
      } catch {
        return null;
      }
    })()
  : null;

return reply.code(200).send({
  evidenceId: evidence.id,
  mediaIntelligenceAdvisory,
  trustDecision,
trustDecisionConsistency,
  verificationPackageIntegrity,
trustDecisionSource: trustDecision
  ? latestReport?.trustDecisionSnapshot
    ? "REPORT_SNAPSHOT"
    : latestVerificationPackage?.trustDecisionSnapshot
      ? "VERIFICATION_PACKAGE_SNAPSHOT"
      : "LIVE_SHARED_FALLBACK"
  : "UNAVAILABLE",
trustDecisionSnapshot: {
  reportVersion: latestReport?.version ?? null,
  reportGeneratedAtUtc: latestReport?.generatedAtUtc
    ? latestReport.generatedAtUtc.toISOString()
    : null,
  verificationPackageVersion: latestVerificationPackage?.version ?? null,
  verificationPackageGeneratedAtUtc: latestVerificationPackage?.generatedAtUtc
    ? latestVerificationPackage.generatedAtUtc.toISOString()
    : null,
},
  contentAccessPolicy: publicVerifyAccessPolicy,
    contentExposureDecision: {
    mode: publicVerifyAccessPolicy.mode,
    allowContentView: publicVerifyAccessPolicy.allowContentView,
    allowDownload: publicVerifyAccessPolicy.allowDownload,
    rationale:
      publicVerifyAccessPolicy.mode === "metadata_only"
        ? "Public verification access is restricted to integrity and metadata review."
        : publicVerifyAccessPolicy.mode === "preview_only"
          ? "Public verification access allows controlled preview without unrestricted download."
          : "Public verification access allows reviewer-facing preview and download according to the configured policy.",
  },
  certifications: publicCertifications,
  display,
  captureContext,
  overview,
  humanSummary,
  evidenceContent: {
    summary: content.summary,
    items: content.items,
    primaryItem: content.primaryItem,
defaultPreviewItemId: defaultPreviewItem?.id ?? null,
      previewPolicy: content.previewPolicy,
  },
  integrityProof,
  custodyLifecycle,
  custodyDisplayCounts,
  legalAssessment: {
    limitations,
    reviewGuidance,
  },
  storageAndTimestamping: {
    storage: storageProtection,
    tsa: {
      status: evidence.tsaStatus,
      provider: evidence.tsaProvider,
      url: evidence.tsaUrl,
      serialNumber: evidence.tsaSerialNumber,
      genTimeUtc: evidence.tsaGenTimeUtc
        ? evidence.tsaGenTimeUtc.toISOString()
        : null,
      hashAlgorithm: evidence.tsaHashAlgorithm,
messageImprint: evidence.tsaMessageImprint,
      inputDigestHex: evidence.tsaInputDigestHex ?? evidence.fileSha256,
      inputKind: evidence.tsaInputKind ?? null,
      legacyMode: !evidence.tsaInputDigestHex,
      failureReason: evidence.tsaFailureReason,
digestMatchesTimestampInput: timestampDigestMatches,
digestMatchesFileHash:
  timestampStatusIsPositive && evidence.fileSha256 && evidence.tsaMessageImprint
    ? evidence.tsaMessageImprint.toLowerCase() === evidence.fileSha256.toLowerCase()
    : null,
digestCheckConclusive: timestampDigestMatches !== null,
timestampAvailable: timestampStatusIsPositive,
timestampedDigestLabel:
  getTimestampDigestLabel({
    itemCount,
    tsaInputKind: evidence.tsaInputKind,
  }),
timestampedDigestNote:
  evidence.tsaInputKind && evidence.tsaInputKind !== "FILE_SHA256"
    ? "This value may differ from the original file SHA-256 when the timestamp is applied to canonical evidence or fingerprint material."
    : null,
    },
    ots: {
      status: effectiveOtsStatus,
      hash: evidence.otsHash ?? null,
      calendar: evidence.otsCalendar ?? null,
      bitcoinTxid: evidence.otsBitcoinTxid ?? null,
      anchoredAtUtc: effectiveOtsAnchoredAtUtc
        ? effectiveOtsAnchoredAtUtc.toISOString()
        : null,
      upgradedAtUtc: evidence.otsUpgradedAtUtc
        ? evidence.otsUpgradedAtUtc.toISOString()
        : null,
      failureReason: evidence.otsFailureReason ?? null,
      proofPresent: Boolean(evidence.otsProofBase64),
      hashMatchesFingerprintHash: otsHashMatches,
    },
    anchor,
  },
  technicalMaterials,
  versioning,
});
  });
}
