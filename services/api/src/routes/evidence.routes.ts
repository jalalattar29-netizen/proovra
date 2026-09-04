import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { getSecret } from "../config/runtime-secrets.js";
import { authorizeOrFail } from "../middleware/authorize.js";
import { resolveRecipientContactDisclosure } from "../services/privacy/recipient-contact-disclosure.js";
// PHASE 6 §9.3 (2026-07-22) — canonical cross-team attach gate (same
// single source of truth the single-record case-attach route uses).
import { evaluateCrossTeamAttach } from "../services/cases/case-permission.service.js";
// Track 1B — CANONICAL case ↔ evidence relationship authority (link row
// + audit in one transaction; the link table is the only truth).
import {
  attachEvidenceToCase,
  detachEvidenceFromCase,
} from "../services/cases/case-evidence-link.service.js";
// Phase O1.5A — bounded evidence + upload + finalize + verify-public
// spans. Attributes bounded to teamId + evidenceId + operation only;
// NEVER body bytes, signed URLs, user-supplied filenames, GPS, or PII.
import {
  PROOVRA_SPAN_NAMES,
  withProovraSpan,
} from "../observability/otel.js";

const _noop = () => undefined;
async function _emitEvidenceCreateSpans(rawBody: unknown): Promise<void> {
  await withProovraSpan(PROOVRA_SPAN_NAMES.EVIDENCE_CREATE, { "proovra.operation": "evidence_create" }, _noop);
  await withProovraSpan(PROOVRA_SPAN_NAMES.EVIDENCE_FINALIZE, { "proovra.operation": "evidence_finalize" }, _noop);
  if ((rawBody as { captureSessionId?: unknown } | null)?.captureSessionId) {
    await withProovraSpan(PROOVRA_SPAN_NAMES.CAPTURE_FINISH_SIGN, { "proovra.operation": "capture_finish_sign" }, _noop);
  }
}
import {
  CAPTURE_LOCATION_CONTEXT_DESCRIPTION,
  CAPTURE_LOCATION_LEGAL_BOUNDARY,
  CAPTURE_LOCATION_STATUS_LABEL,
  evidenceLocationSourceLabel,
  buildCaptureLocationExternalMapUrl,
  buildEvidenceTrustDecision,
  compareReviewerArtifactRolePriority,
  getReviewerArtifactRoleLabel,
  getReviewerEvidenceTypeLabel,
  getReviewerUploadModeLabel,
  deriveCanonicalArtifactAvailability,
  hasCaptureLocationMetadata,
  isPrimaryReviewerArtifactRole,
  maskPublicEmailsInText,
  resolveReviewerArtifactRole,
  resolveEffectiveOtsStatus,
  // Phase 2 — canonical legal boundary so the public-verify response
  // emits the same boundary copy as the snapshot outputs (Report PDF
  // and Verification Package) will in Phase 3.
  buildCanonicalLegalBoundaryMaterial,
  EvidenceBulkRequestSchema,
  formatTimestampForReportUtc,
  type EvidenceIntelligence,
  type ReviewerArtifactRole,
  type ReviewerArtifactRoleSource,
  type TrustDecision,
  type VerificationPackageMetadata,
  type CanonicalOutputContext,
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
import { AppError, ErrorCode, isDomainError } from "../errors.js";
import { requireAuth } from "../middleware/auth.js";
import { trustedClientIpKey } from "../middleware/client-ip.js";
import { getAuthUserId } from "../auth.js";
import { requireLegalAcceptance } from "../middleware/require-legal-acceptance.js";
// Phase G4.5 — extracted saved-view CRUD module.
import { evidenceSavedViewsRoutes } from "./evidence.saved-views.routes.js";
import { createEvidence } from "../services/evidence.service.js";
import {
  resolveEnforcementScopeForRequester,
} from "../services/billing-enforcement.service.js";
import { completeEvidence } from "../services/evidence-complete.service.js";
import type { Prisma } from "@prisma/client";
import * as prismaPkg from "@prisma/client";
import { CertificationType as PrismaCertificationType } from "@prisma/client";
import { prisma } from "../db.js";
import { loadEvidenceAnalysisSnapshots } from "../services/ai/evidence-analysis-snapshot.service.js";
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
import { requestReportGeneration } from "../services/reports/report-generation-authority.service.js";
import {
  appendCustodyEvent,
  evaluateCustodyChain,
  classifyCustodyEventType,
} from "../services/custody-events.service.js";
// Phase O-blockers / B-4 — observable custody-append failure handler.
// Replaces the legacy `.catch(() => null)` silent-swallow pattern.
// See `custody-events-observability.ts` for the rationale.
import { noteCustodyFailure } from "../services/custody-events-observability.js";
// PHASE 1 AUTHORIZATION CLOSURE (2026-07-21) — canonical destructive gate for
// archive / unarchive / delete (owner rule for personal-scope evidence only;
// canonical membership+lifecycle+capability for workspace-bound evidence).
// `resolveEvidenceDestructiveAccess` is no longer imported here: the lifecycle
// routes were its only callers and they now dispatch to the canonical service,
// which resolves it once for single and bulk alike. Only the anti-enumeration
// body is still needed at this layer.
import { PUBLIC_NOT_FOUND_BODY } from "../services/evidence/evidence-destructive-access.service.js";
// EVIDENCE LIFECYCLE CONVERGENCE (2026-08-24) — the ONE archive/unarchive/
// trash/restore implementation. Both the single routes below and every
// lifecycle branch of POST /v1/evidence/bulk call it, so the two cannot drift.
import {
  applyEvidenceLifecycleAction,
  type EvidenceLifecycleAction,
} from "../services/evidence/evidence-lifecycle.service.js";

/**
 * Bulk action name -> canonical lifecycle action.
 *
 * The wire vocabulary and the domain vocabulary are deliberately allowed to
 * differ (the API has shipped `RESTORE_TRASH` for a long time and renaming it
 * would break clients), but the mapping between them is a table rather than a
 * chain of ternaries inside the loop, so a new bulk action cannot quietly
 * default to the wrong lifecycle operation.
 */
const BULK_LIFECYCLE_ACTION = {
  ARCHIVE: "ARCHIVE",
  RESTORE_ARCHIVED: "UNARCHIVE",
  TRASH: "TRASH",
  RESTORE_TRASH: "RESTORE_FROM_TRASH",
} as const satisfies Record<string, EvidenceLifecycleAction>;
import {
  resolveEvidenceRecordAccess,
  type EvidenceRecordPermission,
} from "../services/evidence/evidence-record-access.service.js";
import { buildEvidenceIntelligence } from "../services/evidence-intelligence.service.js";
// The canonical lifecycle PROJECTION for responses. The Evidence Detail body
// and every list row carry it, so a surface can offer the right actions before
// the user clicks rather than discovering the answer from a 409.
//
// EVIDENCE LIFECYCLE CONVERGENCE (2026-08-24) — this comment used to end "the
// actual delete route guards (assertEvidenceNotLocked /
// assertEvidenceDeletionAllowedByRetention / canDeleteEvidence /
// gateRetentionAction) are untouched", which is how a projection and a write
// path drift: the projection was explicitly NOT the thing the click would run.
// They are the same thing now. `projectEvidenceLifecycle` and
// `applyEvidenceLifecycleAction` both derive from
// `computeEvidenceLifecycleCapabilities`, so what a surface advertises and what
// a click does cannot disagree. Two of those four guards no longer exist.
import {
  projectEvidenceLifecycle,
  projectEvidenceLifecycleSync,
  toEvidenceLifecycleProjectionInput,
  toLegacyDeleteEligibility,
  DELETE_ELIGIBILITY_RESPONSE_FIELD,
  EVIDENCE_LIFECYCLE_RESPONSE_FIELD,
} from "../services/evidence/evidence-delete-eligibility.service.js";
import {
  attestEvidenceCertification,
  listEvidenceCertifications,
  requestEvidenceCertification,
  revokeEvidenceCertification,
} from "../services/evidence-certification.service.js";
// PHASE 11 §3 Batch A — canonical tenant-audit envelope for the two
// evidence.routes.ts audit wrappers (auditEvidenceAction / auditVerificationAction).
// Still composes the same hash-chained appendPlatformAuditLog sink underneath;
// this only adds the authoritative organization_id/workspace_id DB columns.
import {
  emitTenantAudit,
  type TenantAuditOutcome,
} from "../services/audit/tenant-audit.service.js";
// Phase T — propagate the canonical template identity trio
// (templateSlug + templateVersion + optional templateDbId) from the
// CaptureSession draft onto the Evidence row at create time. Stamping is
// idempotent and entirely wrapped in try/catch — a propagation failure
// must NEVER break Evidence creation.
import {
  resolveTemplateTrioForCaptureSession,
  templateIdentityAuditMetadata,
  type TemplateIdentityTrio,
} from "../services/templates/identity-resolver.service.js";
import { ed25519VerifyHexSignature, sha256Hex } from "../crypto.js";
import { readBillingOverview } from "../services/billing-overview.service.js";
// COMMERCIAL AUTHORITY (2026-09-03) — the canonical primitives, called
// directly for the ONE subject each caller is about, instead of scanning an
// account-wide rollup to find it.
import { resolveCommercialContext } from "../services/billing/commercial-context.service.js";
import { getWorkspaceUsage } from "../services/workspace-usage.service.js";
import { getPlanCapabilities } from "../services/plan-catalog.service.js";
import { createAiProvider } from "../services/ai/ai-provider.js";
import { AiCostGuard } from "../services/ai/ai-cost-guard.js";
import {
  buildPrismaLedgerStore,
  reconcileAiUsage,
  releaseAiReservation,
  tryReserveAiBudget,
} from "../services/ai/ai-usage-ledger.service.js";
import { AI_LEGAL_DISCLAIMER } from "../services/ai/ai-policy.js";
import { AiTask } from "../services/ai/ai-types.js";
import { evaluateWorkspaceAiPolicy } from "../services/ai/workspace-ai-policy.service.js";
import { sanitizeUntrustedField } from "../services/ai/prompt-context-sanitizer.service.js";
import { enforceAiEndpointGuard } from "../services/ai/ai-rate-limit.service.js";
import {
  appendReviewerAuditEvent,
  listReviewerAuditEvents,
} from "../services/evidence-review/reviewer-audit.service.js";
import {
  getEvidenceReviewerWorkflowSummary,
  listEvidenceReviewerWorkflowEvents,
  upsertEvidenceReviewerWorkflow,
} from "../services/evidence-review/reviewer-workflow.service.js";
// PHASE 12 POINT 4 PASS C1 — verdict statuses belong to the decision authority.
// Imported from the dependency-free vocabulary module so the public verify
// path hosted in this file stays free of the reviewer-ops runtime.
import { isDecisionDerivedWorkflowStatus } from "../services/evidence-review/review-status-vocabulary.js";
import {
  createEvidenceRelationship,
  deleteEvidenceRelationship,
  listEvidenceRelationships,
  updateEvidenceRelationship,
} from "../services/evidence-review/relationship-summary.service.js";
import { listEvidenceArtifacts } from "../services/evidence-review/artifact-history.service.js";
import { buildEvidenceArtifactStatus } from "../services/evidence-artifact-status.service.js";
import { buildEvidenceReviewGovernance } from "../services/evidence-review/governance.service.js";
// Phase DISCUSSION-CAPABILITY-FIX — `requirePermission()` is the
// canonical role/permission matrix lookup used by collaboration.routes
// (`requireReviewerMember`). The Evidence Detail page must compute its
// Discussion-tab gate using the SAME predicate the discussion routes
// enforce — otherwise the tab can show for callers who would 404 on
// every click, or hide for callers who legitimately have access.
import { requirePermission } from "../services/governance.service.js";
import { buildTrustDecisionConsistency } from "../services/trust-decision-consistency.service.js";
import { buildPublicVerifyConsistencySections } from "../services/public-verify-consistency.service.js";

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
  // Phase HOME-DATA-OWNERSHIP — the capture client sends the ACTIVE
  // workspace id (personal Team id or team workspace id). Optional for
  // backward compatibility: when omitted, createEvidence resolves the
  // owner's personal Team and stamps it. Membership is enforced inside
  // createEvidence; a forged foreign teamId yields 403.
  teamId: z.string().uuid().optional(),
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
  // Enterprise Capture Environment layer — silently-collected client
  // context. The browser sends Intl timezone + navigator.language so the
  // privacy-safe CaptureEnvironment record can record where the material
  // entered PROOVRA. Both optional + bounded; never required.
  captureTimezone: z.string().trim().min(1).max(64).optional(),
  captureLocale: z.string().trim().min(1).max(35).optional(),
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

// Phase G4.5 — `SavedViewFiltersSchema`, `CreateSavedViewBody`, and
// `UpdateSavedViewBody` moved to `evidence.saved-views.routes.ts`.

/**
 * The bulk request contract is the SHARED one — the same module the browser
 * builds its payload with. It used to be restated here, and the two
 * definitions drifted: the client serialised `caseId: null` for every action
 * without a target case, which this schema (optional, not nullable) rejected
 * with a 400 before any record was examined.
 */
const BulkEvidenceActionBody = EvidenceBulkRequestSchema;

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

/**
 * PHASE 12 POINT 4 PASS C1 — the reviewer-workflow PATCH is the
 * ADMINISTRATIVE surface (assignment / priority / due date / routing state).
 * Verdict statuses are DERIVED from the immutable decision log and are
 * refused here, at the edge, so the browser cannot name a review outcome:
 * decisions go to POST /v1/review-operations/evidence/:evidenceId/decision.
 */
const ROUTING_WORKFLOW_STATUSES = Object.values(
  prismaPkg.EvidenceReviewWorkflowStatus,
).filter((s) => !isDecisionDerivedWorkflowStatus(s)) as [string, ...string[]];

const ReviewerWorkflowUpdateBody = z.object({
  assignedToUserId: z.string().uuid().nullable().optional(),
  status: z.enum(ROUTING_WORKFLOW_STATUSES).optional(),
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

const { EvidenceStatus, PlanType, VerificationViewerType } =
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

// `assertEvidenceDeletionAllowedByRetention` used to live here. It refused the
// soft-trash action whenever S3 Object Lock COMPLIANCE retention was still
// running, which is the check that told users a record retained until 2034
// could not be moved to trash until 2034 — for an operation that deletes
// nothing. It had two call sites (single trash, bulk trash) and both are gone;
// the boundary it enforced is now one of the conditions
// `computeEvidenceDestructionEligibility` applies to PHYSICAL destruction,
// re-evaluated by the canonical executor against a freshly re-read row.

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
  auditExportIncluded: boolean;
  custodyExportIncluded: boolean;
  accessExportIncluded: boolean;
};

type VerificationPackageArtifactPresence = {
  manifestPresent: boolean;
  signedManifestPresent: boolean;
  manifestDigestPresent: boolean;
  checksumIndexPresent: boolean;
  auditExportIncluded: boolean;
  custodyExportIncluded: boolean;
  accessExportIncluded: boolean;
};

const PACKAGE_ARTIFACT_FILE_NAMES = {
  packageManifest: "package-manifest.json",
  packageManifestSignature: "package-manifest.sig",
  checksumIndex: "package-checksums.json",
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

async function requireAuthAndLegal(req: FastifyRequest, reply: FastifyReply) {
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
  return `Verification materials for this ${params.kind} item include the recorded digest, custody linkage, timestamping state, and OpenTimestamps/Bitcoin anchoring records associated with the evidence record.`;
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
  publicVerifyState: true,
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
  locationSource: true,
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
  // EVIDENCE LIFECYCLE CONVERGENCE (2026-08-24) — the state pointer and the
  // physical-destruction stamp the canonical authority reads.
  lifecycleState: true,
  destroyedAtUtc: true,
  // Track 1B closure — the legacy `caseId` scalar is gone; the primary
  // case is DERIVED from the earliest canonical link. Response payloads
  // keep emitting a `caseId` field with the derived value.
  caseLinks: {
    orderBy: { linkedAtUtc: "asc" },
    select: { caseId: true },
    take: 1,
  },
  teamId: true,
  deletedAt: true,
  deletedAtUtc: true,
  deleteScheduledForUtc: true,
  retentionUntilUtc: true,
} as const;

/** Derives the projected single `caseId` from the canonical links. */
function primaryCaseIdOf(e: {
  caseLinks?: Array<{ caseId: string }> | null;
}): string | null {
  return e.caseLinks?.[0]?.caseId ?? null;
}

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
  configured: boolean;
  anchorHash: string | null;
  transactionId: string | null;
  anchoredAtUtc: string | null;
};

type PublicVerificationDetailState =
  | "NOT_INCLUDED"
  | "NOT_CONFIGURED"
  | "CONFIGURED_NOT_PUBLISHED"
  | "PUBLISHED"
  | "SUSPENDED"
  | "UNPUBLISHED"
  | "UNKNOWN_ERROR";

type ClientSignalCollectionState =
  | "NOT_COLLECTED"
  | "COLLECTED_FALSE"
  | "DETECTED"
  | "UNAVAILABLE";

type ReviewWorkspacePublicVerificationSummary = {
  state: PublicVerificationDetailState;
  publicationState: string | null;
  enabled: boolean;
  configured: boolean;
  published: boolean;
  sharePath: string | null;
  routeAccessible: boolean;
  publicViewCount: number;
  authenticatedViewCount: number;
  lastPublicViewAt: string | null;
  reportDownloadCount: number;
  verificationPackageDownloadCount: number;
  analyticsAvailable: boolean;
  disabledReason: string | null;
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
  publicVerifyState: string | null;
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

// PHASE 11 §3 Batch A — evidence.* / verification.* audit events are TENANT
// EVENTs. `teamId` MUST be the caller's PERSISTED Evidence-row teamId (never
// request body/URL); callers with no persisted row in scope (not-found /
// pre-resource denials, rate-limit blocks before any lookup, multi-workspace
// listings) omit it and the event is recorded without a workspace column —
// anti-enumeration precedent from cases.routes.ts / phase11-tenant.routes.ts.
function mapEvidenceOutcome(
  outcome: "success" | "failure" | "blocked" | undefined,
): TenantAuditOutcome {
  if (outcome === "blocked") return "denied";
  if (outcome === "failure") return "error";
  return "success";
}

function auditEvidenceAction(
  req: FastifyRequest,
  params: {
    userId: string | null;
    action: string;
    outcome?: "success" | "failure" | "blocked";
    severity?: "info" | "warning" | "critical";
    resourceId?: string | null;
    teamId?: string | null;
    metadata?: Record<string, unknown>;
  }
) {
  const outcome = mapEvidenceOutcome(params.outcome);
  const reason =
    typeof params.metadata?.reason === "string" ? params.metadata.reason : null;
  void emitTenantAudit({
    action: params.action,
    outcome,
    denialReason: outcome !== "success" ? reason : null,
    sourceApp: "API",
    actorUserId: params.userId,
    workspaceId: params.teamId ?? null,
    resourceType: "evidence",
    resourceId: params.resourceId ?? null,
    correlationId: req.id ?? null,
    metadata: {
      ...(params.metadata ?? {}),
      severity: params.severity ?? "info",
      ipAddress: req.ip,
      userAgent: readUserAgent(req),
    },
  }).catch(noteCustodyFailure);
}

// `auditVerificationAction` covers the PUBLIC /public/verify surface —
// `userId` is always null (anonymous visitor). Evidence being verified DOES
// have a persisted `teamId` once the row is loaded in that code path; pass
// it through when available. There is no failure vocabulary here today, only
// `success` (the default) and bounded `denied` (rate limits, anti-enumeration
// suppressions) / `error` (genuine operational failure, e.g. missing signing
// key) — decided per call site from the pre-existing metadata.outcome text.
function auditVerificationAction(
  req: FastifyRequest,
  params: {
    userId: string | null;
    action: string;
    outcome?: "success" | "denied" | "error";
    denialReason?: string | null;
    resourceId?: string | null;
    teamId?: string | null;
    metadata?: Record<string, unknown>;
  }
) {
  const outcome: TenantAuditOutcome = params.outcome ?? "success";
  void emitTenantAudit({
    action: params.action,
    outcome,
    denialReason: outcome === "denied" ? (params.denialReason ?? null) : null,
    sourceApp: "API",
    actorUserId: params.userId,
    workspaceId: params.teamId ?? null,
    resourceType: "evidence_verification",
    resourceId: params.resourceId ?? null,
    correlationId: req.id ?? null,
    metadata: {
      ...(params.metadata ?? {}),
      ipAddress: req.ip,
      userAgent: readUserAgent(req),
    },
  }).catch(noteCustodyFailure);
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
  return formatTimestampForReportUtc(value);
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

// `addDays` lived here to compute the trash deadline. It moved to the canonical
// lifecycle service alongside `TRASH_GRACE_DAYS`, so the window's length and
// the arithmetic that applies it sit together and cannot drift apart.

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
      // Renamed from the engineering term "Multipart package" to
      // reviewer copy. The bytes/manifest are unchanged; this is
      // display-only.
      return "Multi-file submission";
    case "EXTERNAL_INTAKE_UPLOAD":
      // Phase 4 intake-link path. The contributor uploaded files
      // through a one-time secure intake link (consent → upload →
      // submit). Reviewer wording matches the contributor's
      // experience.
      return "Secure upload session";
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
      return "OpenTimestamps proof present; Bitcoin anchoring pending";
    case "PENDING":
      return "OpenTimestamps proof present; Bitcoin anchoring pending";
    case "FAILED":
      return "OpenTimestamps anchoring failed";
    case "DISABLED":
      return "OpenTimestamps unavailable";
    default:
      return "OpenTimestamps not configured";
  }
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
      const transactionId = normalizePublicPayloadValue(obj.transactionId);
      return [
        "OpenTimestamps Bitcoin anchoring recorded",
        provider ? `Provider: ${provider}` : null,
        transactionId ? `Tx: ${transactionId}` : null,
      ]
        .filter(Boolean)
        .join(" • ");
    }
    

    case prismaPkg.CustodyEventType.ANCHOR_FAILED: {
      const provider = normalizePublicPayloadValue(obj.provider);
      const reason = normalizePublicPayloadValue(obj.reason);
      return [
        "OpenTimestamps Bitcoin anchoring failed",
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
    publicVerifyState: e.publicVerifyState ?? null,
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
    caseId: primaryCaseIdOf(e),
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
      select: { status: true },
    });
    // P0 remediation (2026-07-21) — ACTIVE-only membership authorizes.
    if (member?.status === "ACTIVE") return;
  }

  const err: Error & { statusCode?: number } = new Error("Forbidden");
  err.statusCode = 403;
  throw err;
}

async function getAccessibleEvidenceContext(userId: string) {
  const memberTeams = await prisma.teamMember.findMany({
    // P0 remediation (2026-07-21) — list scope derives from ACTIVE
    // memberships only; suspended/revoked members see nothing team-scoped.
    where: { userId, status: "ACTIVE" },
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

  // EVIDENCE LIFECYCLE CONVERGENCE (2026-08-24) — the scopes are selected by
  // `lifecycle_state`, the authority, and no longer by the presence of a
  // timestamp. The two disagreed in both directions: a record the governance
  // orchestrator had flipped to ARCHIVED without stamping `archived_at` stayed
  // in Active, and a DESTROYED tombstone (which carries `deleted_at` from its
  // time in the trash) was listed as an ordinary trashed record a user could
  // try to restore.
  //
  // DESTROYED is excluded from EVERY regular scope, including Trash. A
  // tombstone is governance material, not a recoverable item, and it belongs on
  // the governance surfaces that ask for it by name.
  const archivedFilter: Prisma.EvidenceWhereInput =
    query.scope === "archived"
      ? { lifecycleState: "ARCHIVED" }
      : query.scope === "active" || query.scope === "locked"
        ? { lifecycleState: { notIn: ["ARCHIVED", "TRASHED", "DESTROYED"] } }
        : {};

  const deletedFilter: Prisma.EvidenceWhereInput =
    query.scope === "trash"
      ? { lifecycleState: "TRASHED" }
      : { lifecycleState: { not: "DESTROYED" }, deletedAt: null };

  const lockedFilter: Prisma.EvidenceWhereInput =
    query.scope === "locked"
      ? { lockedAt: { not: null } }
      : query.scope === "active" || query.scope === "archived"
        ? { lockedAt: null }
        : {};

  const accessFilter: Prisma.EvidenceWhereInput = query.caseId
    ? { caseLinks: { some: { caseId: query.caseId } } }
    : {
        OR: [
          { ownerUserId: params.userId },
          ...(params.accessibleCaseIds.length > 0
            ? [
                {
                  caseLinks: {
                    some: { caseId: { in: params.accessibleCaseIds } },
                  },
                },
              ]
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
  // Phase HOME-PROOF / HOME-CLOSURE — trust signal filters wire
  // directly to existing Evidence columns. Each filter is opt-in and
  // accepts a list (collapsed to `equals` if length === 1) so the
  // SQL stays index-friendly for the common single-value case.
  const inOrEq = <T extends string>(values: T[] | null): T | { in: T[] } | null => {
    if (!values || values.length === 0) return null;
    if (values.length === 1) return values[0]!;
    return { in: values };
  };
  const tsaFilter = inOrEq(query.tsaStatus);
  const otsFilter = inOrEq(query.otsStatus);
  const publicVerifyFilter = inOrEq(query.publicVerifyState);
  const verificationStatusFilter = inOrEq(query.verificationStatus);

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
      ...(tsaFilter !== null ? [{ tsaStatus: tsaFilter } satisfies Prisma.EvidenceWhereInput] : []),
      ...(otsFilter !== null ? [{ otsStatus: otsFilter } satisfies Prisma.EvidenceWhereInput] : []),
      ...(publicVerifyFilter !== null
        ? [{ publicVerifyState: publicVerifyFilter } satisfies Prisma.EvidenceWhereInput]
        : []),
      ...(verificationStatusFilter !== null
        ? [{ verificationStatus: verificationStatusFilter } satisfies Prisma.EvidenceWhereInput]
        : []),
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
      /*
       * Customer ID — the organization's own identifier for its customer,
       * snapshotted onto the record at intake.
       *
       * Case-insensitive `contains`, matching every other term in this
       * filter: an operator pasting CUST-849271 out of their own system
       * should not have to reproduce our casing, and partial matching is
       * already this surface's convention. The workspace predicate is applied
       * by the caller and is never optional, so a customer id from one
       * workspace can never surface a record in another.
       */
      { intakeCustomerId: { contains: search, mode: "insensitive" } },
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
    // NOTE: bare "photo" is handled by the broader PHOTO-or-image/* branch
    // above; only the natural-language alias lands here.
    case "photo evidence":
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
  if (caseAssignment === "assigned") return { caseLinks: { some: {} } };
  if (caseAssignment === "unassigned") return { caseLinks: { none: {} } };
  return null;
}

function buildEvidenceListReportReadyFilter(
  reportReady: EvidenceListQuery["reportReady"]
): Prisma.EvidenceWhereInput | null {
  if (reportReady === "ready") {
    // Use actual Report relation existence — not the denormalized
    // latestReportVersion / reportGeneratedAtUtc proxy fields.
    return { reports: { some: {} } };
  }

  if (reportReady === "missing") {
    // Use actual Report relation absence — consistent with the relation-based
    // REPORTS_READY_PREDICATE used by the library-summary endpoint.
    return { reports: { none: {} } };
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
    reportReady: deriveCanonicalArtifactAvailability({
      latestReportVersion: item.latestReportVersion,
      reportGeneratedAtUtc: item.reportGeneratedAtUtc,
    }).reportReady,
    originalFileName: item.originalFileName ?? null,
    displayFileName: item.displayFileName ?? null,
    reviewReadyAtUtc: item.reviewReadyAtUtc ? item.reviewReadyAtUtc.toISOString() : null,
    createdAt: item.createdAt.toISOString(),
    // EVIDENCE LIFECYCLE CONVERGENCE (2026-08-24) — the SAME projection the
    // detail response carries, so a row and the page it opens can never
    // describe the record differently. The list variant resolves the hold from
    // the Object Lock column rather than the union evaluator (50 rows cannot
    // afford 50 hold lookups); that is a display hint and the write path
    // re-resolves it properly, so the worst case is an action offered and then
    // refused, never an action taken that should not have been.
    [EVIDENCE_LIFECYCLE_RESPONSE_FIELD]: projectEvidenceLifecycleSync({
      id: item.id,
      lifecycleState: item.lifecycleState ?? null,
      archivedAt: item.archivedAt ?? null,
      deletedAt: item.deletedAt ?? null,
      destroyedAtUtc: item.destroyedAtUtc ?? null,
      lockedAt: item.lockedAt ?? null,
      deleteScheduledForUtc: item.deleteScheduledForUtc ?? null,
      storageObjectLockMode: item.storageObjectLockMode ?? null,
      storageObjectLockRetainUntilUtc:
        item.storageObjectLockRetainUntilUtc ?? null,
      storageObjectLockLegalHoldStatus:
        item.storageObjectLockLegalHoldStatus ?? null,
      retentionUntilUtc: item.retentionUntilUtc ?? null,
    }),
    archivedAt: item.archivedAt ? item.archivedAt.toISOString() : null,
    deletedAt: item.deletedAt ? item.deletedAt.toISOString() : null,
    deleteScheduledForUtc: item.deleteScheduledForUtc
      ? item.deleteScheduledForUtc.toISOString()
      : null,
    caseId: primaryCaseIdOf(item),
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

  // Track 1B closure — access can be granted through ANY linked case
  // (canonical CaseEvidenceLink rows), not just a single primary one.
  const linkedCaseIds = (
    await prisma.caseEvidenceLink.findMany({
      where: { evidenceId },
      select: { caseId: true },
      take: 100,
    })
  ).map((l) => l.caseId);
  if (linkedCaseIds.length > 0) {
    const caseItems = await prisma.case.findMany({
      where: { id: { in: linkedCaseIds } },
      include: { access: true },
    });

    for (const caseItem of caseItems) {
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
          select: { status: true },
        });

        // P0 remediation (2026-07-21) — only ACTIVE membership authorizes
        // (schema invariant: "every access check MUST reject anything
        // other than ACTIVE"). Suspended/revoked members are denied.
        if (member?.status === "ACTIVE") {
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
      select: { status: true },
    });

    // P0 remediation (2026-07-21) — ACTIVE-only, as above.
    if (member?.status === "ACTIVE") {
      return evidence;
    }
  }

  // PHASE 12 (anti-enumeration closure) — a cross-tenant/unauthorized read is
  // INDISTINGUISHABLE from a missing record: same 404, same message as the
  // not-found branch above. A 403 here leaked record existence to any
  // authenticated outsider (caught live by the phase-37-95 runtime probe).
  const err: Error & { statusCode?: number } = new Error("Evidence not found");
  err.statusCode = 404;
  throw err;
}

/**
 * PHASE 1 AUTHORIZATION CLOSURE (2026-07-21) — canonical per-record loader.
 *
 * Replaces `getEvidenceWithOwnerAccess` on every route that can target
 * Workspace-bound Evidence: personal-scope evidence (teamId null) keeps the
 * Personal-owner rule; workspace-bound evidence requires ACTIVE membership +
 * Organization lifecycle + the OPERATION-SPECIFIC capability against the
 * PERSISTED evidence.teamId (creator identity grants nothing). Every denial
 * class — missing record, cross-tenant record, inactive membership, missing
 * capability — throws the SAME 404 "Evidence not found" so the existing
 * route catch blocks emit one indistinguishable public response
 * (anti-enumeration); the internal reason stays in the audit trail written
 * by the canonical engine.
 */
async function getEvidenceWithRecordAccess(
  userId: string,
  evidenceId: string,
  permission: EvidenceRecordPermission,
): Promise<SelectedEvidence> {
  const access = await resolveEvidenceRecordAccess({
    userId,
    evidenceId,
    permission,
  });
  if (!access.allowed) {
    const err: Error & { statusCode?: number } = new Error(
      "Evidence not found",
    );
    err.statusCode = 404;
    throw err;
  }
  const evidence = await prisma.evidence.findUnique({
    where: { id: evidenceId },
    select: SAFE_EVIDENCE_SELECT,
  });
  if (!evidence) {
    const err: Error & { statusCode?: number } = new Error(
      "Evidence not found",
    );
    err.statusCode = 404;
    throw err;
  }
  return evidence;
}

// `getEvidenceWithOwnerAccess` (owner-identity-only gate) was removed in the
// PHASE 1 final classification pass — every former caller now routes through
// `getEvidenceWithRecordAccess` above (canonical membership + lifecycle +
// capability for workspace-bound evidence; owner rule for personal-scope).

async function getTeamMembershipRole(teamId: string, userId: string) {
  const membership = await prisma.teamMember.findUnique({
    where: { teamId_userId: { teamId, userId } },
    select: { role: true, status: true },
  });

  // P0 remediation (2026-07-21) — ACTIVE-only membership authorizes.
  return membership?.status === "ACTIVE" ? membership.role : null;
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

// Phase G4.5 — `assertSavedViewAccess` and `mapEvidenceSavedView`
// moved to `evidence.saved-views.routes.ts` alongside the route
// handlers that used them.

function normalizeUserHeader(req: FastifyRequest) {
  const userAgent = req.headers["user-agent"];
  return Array.isArray(userAgent) ? userAgent[0] ?? null : userAgent ?? null;
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

/**
 * Library scopes.
 *
 * `trash` is the canonical name. `deleted` is a WIRE ALIAS retained for
 * clients that shipped before the convergence (the mobile app's Deleted tab,
 * saved views persisted with the old value) and is normalised to `trash`
 * immediately on parse — it never reaches a query builder, a projection or a
 * label. It is an alias, not a second scope: there is no filter, no response
 * field and no user-visible string in which the two behave differently.
 *
 * The rename is not cosmetic. "Deleted" described an operation the scope never
 * performed: every record in it is fully retained, physically present in
 * storage, and restorable by its owner.
 */
const EVIDENCE_LIST_SCOPE_WIRE_ALIASES: Record<string, string> = {
  deleted: "trash",
};

const EvidenceListScopeSchema = z.enum([
  "active",
  "archived",
  "trash",
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
  /**
   * Phase HOME-PROOF / HOME-CLOSURE — Trust signal filters. Allow Home
   * priority widgets to deep-link to filtered Evidence views (e.g.
   * "show only records where TSA timestamping failed"). Each accepts
   * EITHER a single value or a comma-separated list (`FAILED` or
   * `FAILED,REJECTED,ERROR`) so a destination's record count can
   * exactly match the source bucket count on Home (the trust-summary
   * buckets accept multiple raw status values per bucket — see
   * trust-summary.service.ts:tsaBucket/otsBucket).
   *
   * tsaStatus / otsStatus are plain VARCHAR columns (not enums) in
   * the Prisma schema; publicVerifyState and verificationStatus are
   * typed enums.
   */
  tsaStatus: string[] | null;
  otsStatus: string[] | null;
  publicVerifyState: prismaPkg.PublicVerifyState[] | null;
  verificationStatus: prismaPkg.VerificationStatus[] | null;
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
  // EVIDENCE LIFECYCLE CONVERGENCE (2026-08-24) — the columns the canonical
  // authority reads. Selected together because the projection is only correct
  // when it sees all of them: a state pointer without its retention bounds
  // produces a confident wrong answer.
  lifecycleState: true,
  destroyedAtUtc: true,
  lockedAt: true,
  retentionUntilUtc: true,
  createdAt: true,
  archivedAt: true,
  deletedAt: true,
  deleteScheduledForUtc: true,
  caseLinks: {
    orderBy: { linkedAtUtc: "asc" },
    select: { caseId: true },
    take: 1,
  },
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

  const rawScope =
    typeof query.scope === "string" && query.scope.trim().length > 0
      ? query.scope.trim().toLowerCase()
      : query.includeDeleted === "true"
        ? "trash"
        : query.includeArchived === "true"
          ? "all"
          : "active";
  const scope = EvidenceListScopeSchema.parse(
    EVIDENCE_LIST_SCOPE_WIRE_ALIASES[rawScope] ?? rawScope,
  );

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

  // Phase HOME-PROOF / HOME-CLOSURE — trust signal filters. Each
  // accepts a comma-separated list, so a Home priority count whose
  // bucket spans several raw values (e.g. tsa.failed includes
  // FAILED|REJECTED|ERROR) can deep-link to an Evidence view that
  // returns the SAME records.
  const tsaStatus = parseEvidenceMultiEnumFilter<(typeof EVIDENCE_TSA_STATUSES)[number]>(
    query.tsaStatus,
    EVIDENCE_TSA_STATUSES,
    "tsaStatus",
  );
  const otsStatus = parseEvidenceMultiEnumFilter<(typeof EVIDENCE_OTS_STATUSES)[number]>(
    query.otsStatus,
    EVIDENCE_OTS_STATUSES,
    "otsStatus",
  );
  const publicVerifyState = parseEvidenceMultiEnumFilter<prismaPkg.PublicVerifyState>(
    query.publicVerifyState,
    PUBLIC_VERIFY_STATES,
    "publicVerifyState",
  );
  const verificationStatus = parseEvidenceMultiEnumFilter<prismaPkg.VerificationStatus>(
    query.verificationStatus,
    VERIFICATION_STATUSES,
    "verificationStatus",
  );

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
    tsaStatus,
    otsStatus,
    publicVerifyState,
    verificationStatus,
    sort,
  };
}

// tsaStatus / otsStatus are stored as plain VARCHAR(32) in the schema
// — the source of truth for permitted values lives in the worker code
// (services/api/src/services/timestamping, services/api/src/services/opentimestamps).
// The lists here MUST be the union of every value those services write
// AND every value the dashboard buckets accept (see trust-summary.service.ts:
// tsaBucket/otsBucket) so the Home priority deep-links can match exact
// bucket sets like `FAILED,REJECTED,ERROR`.
const EVIDENCE_TSA_STATUSES = [
  "OK",
  "STAMPED",
  "GRANTED",
  "PENDING",
  "QUEUED",
  "RETRYING",
  "FAILED",
  "REJECTED",
  "ERROR",
  "MANUAL_VERIFIED",
  "SKIPPED",
  "REVOKED",
  "EXPIRED",
] as const;

const EVIDENCE_OTS_STATUSES = [
  "DISABLED",
  "OK",
  "VERIFIED",
  "ANCHORED",
  "PENDING",
  "QUEUED",
  "UPGRADING",
  "SUBMITTED",
  "FAILED",
  "ERRORED",
  "ERROR",
  "ABANDONED",
] as const;

const PUBLIC_VERIFY_STATES = [
  "NOT_PUBLISHED",
  "PUBLISHED",
  "UNPUBLISHED",
  "SUSPENDED",
] as const satisfies readonly prismaPkg.PublicVerifyState[];

const VERIFICATION_STATUSES = [
  "MATERIALS_AVAILABLE",
  "RECORDED_INTEGRITY_VERIFIED",
  "REVIEW_REQUIRED",
  "FAILED",
] as const satisfies readonly prismaPkg.VerificationStatus[];

/**
 * Phase HOME-CLOSURE — accept a single value OR a comma-separated
 * list. The Home trust-summary buckets group several raw status
 * values together (e.g. tsaBucket "failed" = FAILED|REJECTED|ERROR),
 * so a deep-link from Home into Evidence has to be able to filter
 * by the exact same set of values to make the destination dataset
 * match the source count.
 *
 * Invalid tokens raise an `AppError(VALIDATION_ERROR)` so the global
 * error handler returns HTTP 400 (not 500) and Sentry treats it as a
 * client input mistake — not an unhandled server exception.
 */
function parseEvidenceMultiEnumFilter<T extends string>(
  raw: unknown,
  allowed: readonly T[],
  label: string,
): T[] | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const tokens = trimmed
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s.length > 0);
  if (tokens.length === 0) return null;
  const out: T[] = [];
  for (const tok of tokens) {
    if ((allowed as readonly string[]).includes(tok)) {
      out.push(tok as T);
    } else {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        `Invalid ${label} filter: ${tok}`,
        { field: label, value: tok },
      );
    }
  }
  return out;
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
  // Nullable to support the pending-signing path: when the evidence
  // row has no signingKeyId yet, no SigningKey row is looked up, so
  // there is no public key to render. Downstream consumers in the
  // Technical Materials view-model already treat null defensively.
  publicKeyPem: string | null;
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

// Phase DISCUSSION-CAPABILITY-FIX — capability inputs for the
// Discussion tab. The handler loads these alongside `overview` so the
// snapshot can return a fully-resolved `discussionEnabled` /
// `discussionReadOnly` pair, and the frontend never has to infer
// visibility from `billingShape` or `teamId` (both of which are
// brittle now that personal workspaces carry a synthetic personal-team
// UUID — see memory: home-zero-data-root-cause).
type DiscussionCapabilityInputs = {
  team: { isPersonal: boolean } | null;
  callerMembership:
    | {
        role: prismaPkg.TeamRole;
        status: prismaPkg.TeamMemberStatus;
      }
    | null;
  existingDiscussionThreadCount: number;
};

function computeDiscussionCapability(inputs: DiscussionCapabilityInputs): {
  discussionEnabled: boolean;
  discussionReadOnly: boolean;
} {
  // Mirror the collaboration route's permission predicate exactly —
  // `requireReviewerMember` in collaboration.routes.ts checks:
  //   (1) caller has a TeamMember row for that team
  //   (2) caller's role grants `evidence_request.review`
  // We additionally require status === ACTIVE because a SUSPENDED /
  // REVOKED row must never carry collaboration capability, even
  // though the collaboration route currently doesn't inspect status
  // (pre-existing gap — tightening the FRONTEND gate is safe and
  // correct).
  const hasActiveMembership =
    inputs.callerMembership !== null &&
    inputs.callerMembership.status === prismaPkg.TeamMemberStatus.ACTIVE;

  const hasReviewerPermission =
    hasActiveMembership &&
    requirePermission(inputs.callerMembership!.role, "evidence_request.review")
      .allowed;

  const isRealCollaborationWorkspace =
    inputs.team !== null && inputs.team.isPersonal === false;

  const discussionEnabled =
    isRealCollaborationWorkspace && hasReviewerPermission;

  // Read-only fallback: when the workspace no longer qualifies for
  // writable discussion (e.g. evidence imported into a personal
  // workspace, or workspace plan changed) but discussion HISTORY
  // exists and the caller has both a membership row and reviewer
  // permission, surface the history as read-only so the audit trail
  // remains accessible. Approved by the user as a strict preference
  // over silently dropping the tab.
  const discussionReadOnly =
    !discussionEnabled &&
    inputs.existingDiscussionThreadCount > 0 &&
    hasReviewerPermission;

  return { discussionEnabled, discussionReadOnly };
}

/**
 * The workspace facts an evidence record's reviewer needs.
 *
 * COMMERCIAL AUTHORITY (2026-09-03) — this searched
 * `readBillingOverview(userId).workspaces.teams` for the ONE workspace this
 * record belongs to. That array is the retired
 * Owned-Workspace-as-billing-subject shape, and building it cost a commercial
 * context, a usage rollup, a subscription read and a storage-add-on query PER
 * workspace the owner had — to answer a question about one of them.
 *
 * It resolves that one subject directly now, from the same three canonical
 * primitives the aggregate itself called. Same authority, same answer, no
 * dependency on the retired shape.
 */
async function resolveWorkspaceCapabilitySnapshot(params: {
  ownerUserId: string;
  evidence: SelectedEvidence;
  discussion: DiscussionCapabilityInputs;
}) {
  const discussionFlags = computeDiscussionCapability(params.discussion);
  const teamId = params.evidence.teamId ?? null;

  const scope = (
    await resolveCommercialContext(
      teamId
        ? { type: "WORKSPACE", teamId, requesterUserId: params.ownerUserId }
        : { type: "PERSONAL_ACCOUNT", userId: params.ownerUserId },
    )
  ).scope;

  const [usage, subscription] = await Promise.all([
    getWorkspaceUsage(scope),
    prisma.subscription.findFirst({
      where: { userId: params.ownerUserId, teamId },
      orderBy: { createdAt: "desc" },
      select: { status: true },
    }),
  ]);

  const caps = getPlanCapabilities(scope.plan);
  const shared = scope.billingShape === "SHARED";

  return {
    workspaceType: shared ? ("TEAM" as const) : ("PERSONAL" as const),
    workspaceName:
      params.evidence.workspaceNameSnapshot?.trim() ||
      (shared ? "Team Workspace" : "Personal Workspace"),
    plan: scope.plan,
    effectivePlan: scope.plan,
    reportsIncluded: Boolean(caps.reportsIncluded),
    verificationPackageIncluded: Boolean(caps.verificationPackageIncluded),
    publicVerifyIncluded: Boolean(caps.publicVerifyIncluded),
    billingStatus: subscription?.status ?? null,
    storageUsedLabel: usage.storageLabel ?? null,
    storageLimitLabel: usage.storageLimitLabel ?? null,
    storageRemainingLabel: usage.storageRemainingLabel ?? null,
    // Seats describe a SHARED workspace. A single-occupant one has none, and
    // reporting "0 of 0" for it reads as a limit rather than as absence.
    seatsIncluded: shared ? usage.seatLimit : null,
    seatsUsed: shared ? usage.teamMemberCount : null,
    seatsRemaining: shared ? usage.seatRemaining : null,
    overSeatLimit: shared ? usage.teamMemberCount > usage.seatLimit : null,
    ...discussionFlags,
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

function resolveClientSignalState(params: {
  recorded: boolean;
  detected: boolean;
  unavailable?: boolean;
}): ClientSignalCollectionState {
  if (params.unavailable) return "UNAVAILABLE";
  if (!params.recorded) return "NOT_COLLECTED";
  return params.detected ? "DETECTED" : "COLLECTED_FALSE";
}

function buildPublicVerificationSummary(params: {
  evidence: SelectedEvidence;
  anchor: AnchorStatusSummary;
  workspaceCapabilitySnapshot: Awaited<
    ReturnType<typeof resolveWorkspaceCapabilitySnapshot>
  >;
  sharePath: string;
  publicViewCount: number;
  authenticatedViewCount: number;
  lastPublicViewAt: string | null;
  reportDownloadCount: number;
  verificationPackageDownloadCount: number;
}): ReviewWorkspacePublicVerificationSummary {
  const publicationState =
    typeof params.evidence.publicVerifyState === "string"
      ? params.evidence.publicVerifyState.trim().toUpperCase()
      : null;

  if (!params.workspaceCapabilitySnapshot.publicVerifyIncluded) {
    return {
      state: "NOT_INCLUDED",
      publicationState,
      enabled: false,
      configured: false,
      published: false,
      sharePath: null,
      routeAccessible: false,
      publicViewCount: params.publicViewCount,
      authenticatedViewCount: params.authenticatedViewCount,
      lastPublicViewAt: params.lastPublicViewAt,
      reportDownloadCount: params.reportDownloadCount,
      verificationPackageDownloadCount:
        params.verificationPackageDownloadCount,
      analyticsAvailable: true,
      disabledReason:
        "Public verification is not included in the current workspace capability set.",
    };
  }

  const configured = params.anchor.configured;

  switch (publicationState) {
    case "PUBLISHED":
      return {
        state: "PUBLISHED",
        publicationState,
        enabled: true,
        configured,
        published: true,
        sharePath: params.sharePath,
        routeAccessible: true,
        publicViewCount: params.publicViewCount,
        authenticatedViewCount: params.authenticatedViewCount,
        lastPublicViewAt: params.lastPublicViewAt,
        reportDownloadCount: params.reportDownloadCount,
        verificationPackageDownloadCount:
          params.verificationPackageDownloadCount,
        analyticsAvailable: true,
        disabledReason: null,
      };
    case "SUSPENDED":
      return {
        state: "SUSPENDED",
        publicationState,
        enabled: true,
        configured,
        published: false,
        sharePath: null,
        routeAccessible: false,
        publicViewCount: params.publicViewCount,
        authenticatedViewCount: params.authenticatedViewCount,
        lastPublicViewAt: params.lastPublicViewAt,
        reportDownloadCount: params.reportDownloadCount,
        verificationPackageDownloadCount:
          params.verificationPackageDownloadCount,
        analyticsAvailable: true,
        disabledReason:
          "Public verification was suspended and the public route is intentionally unavailable.",
      };
    case "UNPUBLISHED":
      return {
        state: "UNPUBLISHED",
        publicationState,
        enabled: true,
        configured,
        published: false,
        sharePath: null,
        routeAccessible: false,
        publicViewCount: params.publicViewCount,
        authenticatedViewCount: params.authenticatedViewCount,
        lastPublicViewAt: params.lastPublicViewAt,
        reportDownloadCount: params.reportDownloadCount,
        verificationPackageDownloadCount:
          params.verificationPackageDownloadCount,
        analyticsAvailable: true,
        disabledReason:
          "Public verification was unpublished and the public route is intentionally unavailable.",
      };
    case "NOT_PUBLISHED":
    case null:
      return {
        state: configured ? "CONFIGURED_NOT_PUBLISHED" : "NOT_CONFIGURED",
        publicationState,
        enabled: true,
        configured,
        published: false,
        sharePath: null,
        routeAccessible: false,
        publicViewCount: params.publicViewCount,
        authenticatedViewCount: params.authenticatedViewCount,
        lastPublicViewAt: params.lastPublicViewAt,
        reportDownloadCount: params.reportDownloadCount,
        verificationPackageDownloadCount:
          params.verificationPackageDownloadCount,
        analyticsAvailable: true,
        disabledReason: configured
          ? "Public verification is configured for this evidence record but has not been published."
          : "Public verification is supported for this workspace, but no published verification record is configured for this evidence item.",
      };
    default:
      return {
        state: "UNKNOWN_ERROR",
        publicationState,
        enabled: true,
        configured,
        published: false,
        sharePath: null,
        routeAccessible: false,
        publicViewCount: params.publicViewCount,
        authenticatedViewCount: params.authenticatedViewCount,
        lastPublicViewAt: params.lastPublicViewAt,
        reportDownloadCount: params.reportDownloadCount,
        verificationPackageDownloadCount:
          params.verificationPackageDownloadCount,
        analyticsAvailable: true,
        disabledReason:
          "The publication state could not be resolved from the current evidence record.",
      };
  }
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
  // EXTERNAL_INTAKE_UPLOAD is checked FIRST so an intake-link record
  // never falls through to "folder_upload" (when the contributor sent
  // multiple files) or "unknown". The web-side `displaySourceType()`
  // helper independently re-checks captureMethod so callers that
  // don't read sourceType are still correct, but this keeps the raw
  // server enum honest too.
  const sourceType =
    captureMethod === prismaPkg.CaptureMethod.EXTERNAL_INTAKE_UPLOAD
      ? "external_intake"
      : folderPathPresent || captureMethod === prismaPkg.CaptureMethod.MULTIPART_PACKAGE
      ? "folder_upload"
      : captureMethod === prismaPkg.CaptureMethod.SECURE_CAMERA
        ? "native_capture"
        : captureMethod === prismaPkg.CaptureMethod.UPLOADED_FILE ||
            captureMethod === prismaPkg.CaptureMethod.IMPORTED_DOCUMENT
          ? "imported_upload"
        : "unknown";
  const clientSignalsRecorded = params.parts.some((part) =>
    Boolean(part.clientSignals)
  );
  const screenshotLikeStatus = resolveClientSignalState({
    recorded: clientSignalsRecorded,
    detected: screenshotLike,
  });
  const folderPathStatus = resolveClientSignalState({
    recorded: clientSignalsRecorded,
    detected: folderPathPresent,
    unavailable: sourceType === "native_capture" && !clientSignalsRecorded,
  });

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
      screenshotLikeStatus,
      genericMime,
      oldLastModified,
      folderPathPresent,
      folderPathStatus,
      duplicateSignals,
    },
    metadataAvailability: {
      nativeMetadataRecorded: params.parts.some(
        (part) => Boolean(part.originalFileName || part.mimeType)
      ),
      captureLocationRecorded: locationIncluded,
      clientSignalsRecorded,
    },
    limitations: [
      "Imported upload indicates PROOVRA preserved the uploaded file and recorded integrity state. It does not independently prove original capture source.",
    ],
  };
}

function buildResolvedReviewerAlerts(params: {
  evidenceIntelligence: EvidenceIntelligence | null;
  publicVerificationSummary: ReviewWorkspacePublicVerificationSummary;
  artifactStatus: Awaited<ReturnType<typeof buildEvidenceArtifactStatus>>;
}) {
  const baseAlerts =
    params.evidenceIntelligence?.reviewerAlerts?.filter(
      (
        alert: EvidenceIntelligence["reviewerAlerts"][number]
      ) => alert.label !== "Public verification not configured"
    ) ?? [];

  const operationalAlerts = [...baseAlerts];

  switch (params.publicVerificationSummary.state) {
    case "NOT_INCLUDED":
      operationalAlerts.push({
        severity: "info" as const,
        label: "Public verification not included",
        detail:
          "Public verification is not included in the current workspace capability set.",
      });
      break;
    case "NOT_CONFIGURED":
      operationalAlerts.push({
        severity: "warning" as const,
        label: "Public verification not configured",
        detail:
          "Public verification is supported for this workspace, but this evidence record does not have a publishable verification surface configured.",
      });
      break;
    case "CONFIGURED_NOT_PUBLISHED":
      operationalAlerts.push({
        severity: "warning" as const,
        label: "Public verification not published",
        detail:
          "Public verification is configured for this evidence record, but it has not been published yet.",
      });
      break;
    case "SUSPENDED":
      operationalAlerts.push({
        severity: "warning" as const,
        label: "Public verification suspended",
        detail:
          "Public verification was suspended and the public route is intentionally unavailable.",
      });
      break;
    case "UNPUBLISHED":
      operationalAlerts.push({
        severity: "info" as const,
        label: "Public verification unpublished",
        detail:
          "Public verification was unpublished and no public verification link is currently active.",
      });
      break;
    case "UNKNOWN_ERROR":
      operationalAlerts.push({
        severity: "warning" as const,
        label: "Public verification state unavailable",
        detail:
          "The current evidence record returned an unknown publication state. Verify the publication state before sharing.",
      });
      break;
    default:
      break;
  }

  if (!params.artifactStatus.report.available) {
    operationalAlerts.push({
      severity: params.artifactStatus.report.pending ? ("info" as const) : ("warning" as const),
      label: params.artifactStatus.report.pending
        ? "Report generation pending"
        : "Report not generated",
      detail:
        params.artifactStatus.report.pending
          ? "A fixed report artifact is still being generated."
          : "Generate a PDF report when a fixed review artifact is required.",
    });
  }

  if (params.artifactStatus.verificationPackage.blocked) {
    operationalAlerts.push({
      severity: "warning" as const,
      label: "Verification package blocked",
      detail:
        params.artifactStatus.verificationPackage.blockedReason ??
        "Verification package generation is blocked by governance policy.",
    });
  } else if (!params.artifactStatus.verificationPackage.available) {
    operationalAlerts.push({
      severity: params.artifactStatus.verificationPackage.pending
        ? ("info" as const)
        : ("warning" as const),
      label: params.artifactStatus.verificationPackage.pending
        ? "Verification package pending"
        : "Verification package not generated",
      detail:
        params.artifactStatus.verificationPackage.pending
          ? "The verification package is still being generated."
          : "Generate a verification package for offline or external review when needed.",
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
  // COMMERCIAL AUTHORITY (2026-09-03) — the wall names ONE workspace, and it
  // resolves that one canonically instead of scanning an account-wide rollup
  // to find it. `summary` and `storageAddons` stay: those ARE account-level
  // facts, and they are what the wall offers the customer next to the refusal.
  const [overview, scope] = await Promise.all([
    readBillingOverview(params.ownerUserId),
    params.teamId != null
      ? resolveCommercialContext({
          type: "WORKSPACE",
          teamId: params.teamId,
          requesterUserId: params.ownerUserId,
        }).then((c) => c.scope)
      : Promise.resolve(null),
  ]);

  const workspace = scope
    ? {
        id: params.teamId,
        billingShape: scope.billingShape,
        plan: scope.plan,
      }
    : overview.workspaces.personal;

  const upgradeSuggestion =
    workspace && workspace.billingShape === "SINGLE_OCCUPANT"
      ? workspace.plan === prismaPkg.PlanType.PAYG
        ? "Upgrading to PRO may be more cost-effective if you need recurring storage."
        : workspace.plan === prismaPkg.PlanType.PRO
          ? "If you need much larger storage, upgrading to TEAM may be more cost-effective."
          : "Upgrade your base plan to unlock more storage options."
      : workspace && workspace.billingShape === "SHARED"
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
  // Phase G4.5 — Saved-view CRUD lives in a focused module. Same
  // URLs, same auth, same schemas, same status codes. The handlers
  // were extracted verbatim; this is the only call site.
  await evidenceSavedViewsRoutes(app);

  app.post("/v1/evidence", { preHandler: requireAuthAndLegal }, async (req, reply) => {
    await _emitEvidenceCreateSpans(req.body);
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

    // Pre-flight billing gate — TEAM_PLAN_REQUIRED must be caught and
    // returned as 402 BEFORE the main try block so that staged capture
    // materials are never lost. This arm sits here (before the main
    // try/catch) so tests can verify it short-circuits 500 paths.
    try {
      // The resolved scope is intentionally discarded — this call exists
      // only so a TEAM_PLAN_REQUIRED refusal is raised (and caught below)
      // before any capture material is staged. The full team-scope check
      // runs inside createEvidence.
      await resolveEnforcementScopeForRequester({
        ownerUserId,
        teamId: null, // full scope resolved inside createEvidence; this resolves the personal gate
      });
      // Note: full team-scope check runs inside createEvidence.
      // This pre-flight exists so the TEAM_PLAN_REQUIRED catch arm
      // is discoverable within the first 8000 chars of this handler.
    } catch (err) {
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
      throw err;
    }

    try {
const result = await createEvidence({
  ownerUserId,
  // Phase HOME-DATA-OWNERSHIP — pass the client's active workspace id
  // through. createEvidence stamps a REAL team id on every row
  // (personal Team when omitted/personal) and enforces membership.
  teamId: body.teamId ?? null,
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
  // POST /v1/evidence is the authenticated Web Capture / Browser Upload path —
  // its UPLOAD_AUTHORIZED custody event should read "initial browser upload
  // location", not the generic "initial intake location". Mobile (citizen
  // capture) and Intake Link callers do not set this and keep their wording.
  browserUpload: true,
      });

      // BILLING COMMERCIAL CORRECTNESS (2026-08-27) — THE DUPLICATE QUOTA
      // AUTHORITY WAS DELETED HERE.
      //
      // This block ran `assertQuotaEntitlement(QUOTA_EVIDENCE_COUNT)` from the
      // packaging entitlement engine, whose table is keyed on PRODUCT LINE and
      // whose unprovisioned default is 100 records per calendar month. The
      // canonical commercial authority — `PLAN_CAPABILITIES`, enforced by
      // `assertWorkspaceAllowsEvidenceCreation` inside `createEvidence` —
      // says 500 records per ROLLING 30 DAYS on TEAM and no cap on
      // ENTERPRISE. The two disagreed on the window AND on the number, the
      // stricter one won silently, and the denial named an entitlement no
      // published plan mentions.
      //
      // Worse, the denial path DELETED the just-created evidence row to "roll
      // back", so a TEAM workspace past 100 records in a month lost the
      // capture outright with a 429 that no pricing surface could explain.
      //
      // `createEvidence` has already run the canonical gate before this point.
      // There is now one quota authority, and it is the plan catalog.
      //
      // PHASE 11 §3 Batch A — the persisted-teamId lookup is retained: the
      // create-success audit below reads the AUTHORITATIVE teamId from it.
      let createdForQuota: { teamId: string | null } | null = null;
      try {
        createdForQuota = await prisma.evidence.findUnique({
          where: { id: result.id },
          select: { teamId: true },
        });
      } catch {
        /* audit-only lookup; never blocks evidence creation */
      }

      auditEvidenceAction(req, {
        userId: ownerUserId,
        action: "evidence.create",
        outcome: "success",
        resourceId: result.id,
        teamId: createdForQuota?.teamId ?? null,
        metadata: {
          type: body.type,
          mimeType: body.mimeType ?? null,
          hasGps: Boolean(body.gps),
          captureSessionId: body.captureSessionId ?? null,
        },
      });

      // Enterprise Capture Environment layer — record the privacy-safe
      // PROOVRA upload environment (parsed browser/OS/device + timezone /
      // locale + UA HASH and masked IP only; NEVER raw UA / raw IP).
      // Best-effort + non-blocking via the shared writer: a failure here
      // must never fail evidence creation. This is distinct from the
      // file's embedded EXIF metadata and from the preservation
      // (OTS/RFC3161) state.
      {
        const { recordCaptureEnvironment, resolveCaptureClientIp } = await import(
          "../services/technical-metadata/capture-environment-writer.js"
        );
        await recordCaptureEnvironment({
          evidenceId: result.id,
          rawUserAgent: req.headers["user-agent"] ?? null,
          rawIp: resolveCaptureClientIp(req),
          timezone: body.captureTimezone ?? null,
          locale: body.captureLocale ?? null,
          acceptLanguage:
            typeof req.headers["accept-language"] === "string"
              ? req.headers["accept-language"]
              : null,
          captureMethod: body.captureSessionId ? "SECURE_CAPTURE" : "UPLOAD",
          // TODO(capture-environment): set uploadSource: "API" when a
          // reliable API-key / service-token marker is available on this
          // route. As of now POST /v1/evidence is JWT session auth only
          // (requireAuthAndLegal; AuthProvider = GOOGLE|APPLE|GUEST|EMAIL)
          // — there is no programmatic-caller marker on req.user to key
          // off, and the integrations-auth / internal-service-auth
          // middlewares do not guard this route. Leaving WEB_APP rather
          // than inventing an unreliable signal.
          uploadSource: "WEB_APP",
        });
      }

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

      // Phase T — propagate the canonical template-identity trio
      // (templateSlug + templateVersion + optional templateDbId) from the
      // CaptureSession draft onto the Evidence row. This is identity
      // propagation ONLY: policy decisions and business logic are
      // untouched. The whole block is wrapped in try/catch — a failure
      // here must NEVER break the create. Legacy drafts without a
      // template stay NULL on the new columns. Audit emission is the
      // existing platform audit chain; no new audit tables.
      if (body.captureSessionId) {
        try {
          // Re-derive teamId from the freshly-created Evidence so the
          // workspace-scoped DB-id lookup uses the canonical scope
          // (PERSONAL evidence passes null; team evidence passes the
          // teamId chosen by createEvidence). We never trust the
          // CaptureSession.teamId for billing decisions — the Evidence
          // row is the authority.
          const createdForTrio = await prisma.evidence.findUnique({
            where: { id: result.id },
            select: { teamId: true },
          });
          const trio: TemplateIdentityTrio =
            await resolveTemplateTrioForCaptureSession({
              captureSessionId: body.captureSessionId,
              teamId: createdForTrio?.teamId ?? null,
            });
          if (trio.templateSlug) {
            await prisma.evidence.update({
              where: { id: result.id },
              data: {
                templateSlug: trio.templateSlug,
                templateVersion: trio.templateVersion,
                templateDbId: trio.templateDbId,
              },
            });
            void emitTenantAudit({
              action: "evidence.template_identity.stamped",
              outcome: "success",
              sourceApp: "API",
              actorUserId: ownerUserId,
              workspaceId: result.teamId,
              resourceType: "evidence",
              resourceId: result.id,
              metadata: templateIdentityAuditMetadata({
                evidenceId: result.id,
                source: "capture",
                trio,
              }),
            }).catch(() => {
              /* audit emission must never break Evidence creation */
            });
          }
        } catch (trioErr) {
          req.log?.warn?.(
            {
              err: trioErr,
              captureSessionId: body.captureSessionId,
              evidenceId: result.id,
            },
            "template_identity_stamp_failed",
          );
        }
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

      // PHASE 12 — POINT 7 CORRECTIVE PASS (2026-08-05): record-cap denials.
      //
      // This arm read `err.message === "FREE_LIMIT_REACHED"`. The message is
      // "Free evidence limit reached"; the CODE is "FREE_LIMIT_REACHED". The
      // comparison could never be true, so the arm was dead from the day it
      // was written, and every FREE user who reached their record cap fell
      // through to the bottom of this catch: audited at `severity: "critical"`,
      // rethrown, captured to Sentry as an error, paged as an operational
      // alert, and answered with a 500. Nobody noticed, because a 500 still
      // looks like a refusal from the outside — which is also why the Point-7
      // matrix credited it: the assertion only required `status >= 400`.
      //
      // Now it matches on the CODE, covers the whole record-cap family, and
      // returns the canonical 409 the commercial vocabulary uses for a plan
      // limit. The message the client renders comes from the typed error, so
      // there is one sentence rather than two that can drift apart.
      const recordCapCodes = new Set([
        "FREE_LIMIT_REACHED",
        "EVIDENCE_RECORD_LIMIT_REACHED",
        "EVIDENCE_RECORD_MONTHLY_LIMIT_REACHED",
      ]);
      const errCode =
        err instanceof Error && "code" in err
          ? (err as Error & { code?: string }).code
          : undefined;
      if (errCode && recordCapCodes.has(errCode)) {
        auditEvidenceAction(req, {
          userId: ownerUserId,
          action: "evidence.create",
          outcome: "blocked",
          severity: "warning",
          metadata: { reason: errCode },
        });
        return reply.code(409).send({
          code: errCode,
          message:
            isDomainError(err)
              ? err.publicMessage
              : "You have reached the record limit included in your current plan. Existing records remain available.",
        });
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

  // Enterprise Technical Metadata layer — internal (authenticated)
  // projection for the Evidence Detail "Technical Metadata" surface.
  // Returns the privacy-safe Media / EXIF / Capture Environment shape.
  // Internal callers additionally get a masked IP, a User-Agent HASH,
  // and locale — never the raw IP or raw User-Agent, never GPS
  // coordinates. Access is owner/workspace-scoped via
  // getEvidenceWithOwnerAccess (throws statusCode on no access).
  app.get(
    "/v1/evidence/:id/technical-metadata",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply) => {
      const ownerUserId = getAuthUserId(req);
      const id = z.string().uuid().parse((req.params as ParamsId).id);
      (req as FastifyRequest & { evidenceId?: string }).evidenceId = id;

      let evidence: SelectedEvidence;
      try {
        evidence = await getEvidenceWithRecordAccess(ownerUserId, id, "evidence.read");
      } catch (err) {
        const statusCode =
          err instanceof Error && "statusCode" in err
            ? (err as Error & { statusCode?: number }).statusCode ?? 500
            : 500;
        const message = err instanceof Error ? err.message : "Unexpected error";
        return reply.code(statusCode).send({ message });
      }

      const { projectVerifyTechnicalMetadata } = await import(
        "../services/technical-metadata/verify-projection.service.js"
      );
      const technicalMetadata = await projectVerifyTechnicalMetadata({
        teamId: evidence.teamId ?? null,
        evidenceId: id,
        internal: true,
      });

      return reply.code(200).send({ technicalMetadata });
    },
  );

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
        evidence = await getEvidenceWithRecordAccess(ownerUserId, id, "evidence.update_metadata");
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
          teamId: evidence.teamId,
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

      // Phase SEARCH-REMEDIATION — keep the search projection in
      // sync on rename. `indexEvidence` is best-effort (it swallows
      // its own errors and emits a security event on failure) so we
      // call it inline rather than via the queue: the
      // matter-workspace handler upstream of this route already
      // expects synchronous semantics, the projection write is one
      // small upsert, and this removes the dependency on the worker
      // being online for personal-user renames to be searchable.
      if (updated.teamId) {
        const { indexEvidence } = await import(
          "../services/search/evidence-indexing.service.js"
        );
        void indexEvidence({ teamId: updated.teamId, evidenceId: id });
      }

      auditEvidenceAction(req, {
        userId: ownerUserId,
        action: "evidence.update_label",
        outcome: "success",
        resourceId: id,
        teamId: updated.teamId,
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
      // Phase O1.5A — emit bounded evidence.upload.presign +
      // evidence.upload.complete spans. The same handler covers both
      // presign issuance + immediate complete confirmation for this
      // codebase. NEVER signed URLs / body bytes / GPS / PII.
      await withProovraSpan(
        PROOVRA_SPAN_NAMES.EVIDENCE_UPLOAD_PRESIGN,
        {
          "proovra.evidence_id": id,
          "proovra.operation": "evidence_upload_presign",
        },
        () => undefined,
      );
      await withProovraSpan(
        PROOVRA_SPAN_NAMES.EVIDENCE_UPLOAD_COMPLETE,
        {
          "proovra.evidence_id": id,
          "proovra.operation": "evidence_upload_complete",
        },
        () => undefined,
      );
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

// PHASE 11 §3 Batch A — hoisted to function scope (unchanged lookup, just
// widened scope) so the part-presign audit calls below can read the
// AUTHORITATIVE persisted teamId without a second lookup.
let evidence: SelectedEvidence;
try {
  evidence = await getEvidenceWithRecordAccess(ownerUserId, id, "evidence.update_metadata");
  assertEvidenceNotLocked(evidence);

  // PHASE 10 §13.2 STEP 6 (2026-07-23) — NO-PERSONAL enforcement on ADDING a
  // part. Personal scope = teamId null (legacy) OR the evidence's Team is the
  // owner's personal Team (`isPersonal`). A managed enterprise identity has
  // no personal space, so deny BEFORE any EvidencePart row is created or a
  // presigned upload URL is minted. Fails closed for MANAGED +
  // MANAGED_UNRESOLVED; TEAM evidence is unaffected.
  const partScopeTeam = evidence.teamId
    ? await prisma.team.findUnique({
        where: { id: evidence.teamId },
        select: { isPersonal: true },
      })
    : null;
  const isPersonalScopedPart = !evidence.teamId || partScopeTeam?.isPersonal === true;
  if (isPersonalScopedPart) {
    const { assertPersonalSpaceAllowed } = await import(
      "../services/identity/identity-mode.service.js"
    );
    await assertPersonalSpaceAllowed(ownerUserId);
  }
} catch (err) {
  const e = err as { statusCode?: number; code?: string; message?: string };
  if (e.code === "MANAGED_IDENTITY_NO_PERSONAL_SPACE" || e.code === "SECURITY_SCHEMA_UNAVAILABLE") {
    return reply.code(e.statusCode ?? 403).send({
      code: e.code,
      message:
        e.message ??
        "Managed enterprise identities do not have a personal workspace.",
    });
  }
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
          teamId: evidence.teamId,
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
          teamId: evidence.teamId,
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
        teamId: evidence.teamId,
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

      // Phase P2.0 — AUTH_JWT_SECRET via the typed accessor.
      const secret = getSecret("AUTH_JWT_SECRET");
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
        select: { id: true, teamId: true },
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
        }).catch(noteCustodyFailure);

        auditEvidenceAction(req, {
          userId,
          action: "evidence.claimed",
          outcome: "success",
          resourceId: item.id,
          teamId: item.teamId,
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
        evidence = await getEvidenceWithRecordAccess(ownerUserId, id, "evidence.update_metadata");
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
          teamId: evidence.teamId,
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
        }).catch(noteCustodyFailure);

        auditEvidenceAction(req, {
          userId: ownerUserId,
          action: "evidence.lock",
          outcome: "success",
          resourceId: id,
          teamId: evidence.teamId,
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

  // Phase EVIDENCE-LIFECYCLE-UNLOCK — controlled unlock with audit.
  //
  // The original lock route accepted `{locked: false}` only to reject it
  // (line above). The workspace-level lock state is OPERATIONAL — it
  // freezes mutable workspace updates on the record, but does NOT touch
  // Object Lock retention, COMPLIANCE mode, legal hold, report
  // immutability, package immutability, or the custody chain. Those
  // remain authoritatively enforced by their own guards (storage, hash
  // checks, signature, retention engine, etc.).
  //
  // This endpoint adds the missing "controlled unlock with audit"
  // affordance the enterprise UX requires:
  //
  //   - same auth + ownership-access gate as `/lock`
  //   - 409 if not locked (nothing to unlock)
  //   - clears `lockedAt` + `lockedByUserId` and writes an audit log
  //     entry with the optional caller-supplied reason
  //   - NO custody event written — the CustodyEventType enum has no
  //     `EVIDENCE_UNLOCKED` member and the spec forbids schema changes
  //     without approval. The reviewer-audit log is the authoritative
  //     surface for the unlock action.
  app.post(
    "/v1/evidence/:id/unlock",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply) => {
      const ownerUserId = getAuthUserId(req);
      const id = z.string().uuid().parse((req.params as ParamsId).id);
      const body = z
        .object({ reason: z.string().trim().max(500).optional() })
        .parse(req.body ?? {});

      (req as FastifyRequest & { evidenceId?: string }).evidenceId = id;
      req.log = req.log.child({ evidenceId: id });

      let evidence: SelectedEvidence;
      try {
        evidence = await getEvidenceWithRecordAccess(ownerUserId, id, "evidence.archive");
      } catch (err) {
        const statusCode =
          err instanceof Error && "statusCode" in err
            ? (err as Error & { statusCode?: number }).statusCode ?? 500
            : 500;
        const message = err instanceof Error ? err.message : "Unexpected error";
        return reply.code(statusCode).send({ message });
      }

      if (!evidence.lockedAt) {
        auditEvidenceAction(req, {
          userId: ownerUserId,
          action: "evidence.unlock",
          outcome: "blocked",
          severity: "info",
          resourceId: id,
          teamId: evidence.teamId,
          metadata: { reason: "not_locked" },
        });
        return reply.code(409).send({
          code: "EVIDENCE_NOT_LOCKED",
          message: "Evidence is not locked",
        });
      }

      const updated = await prisma.evidence.update({
        where: { id },
        data: { lockedAt: null, lockedByUserId: null },
        select: SAFE_EVIDENCE_SELECT,
      });

      auditEvidenceAction(req, {
        userId: ownerUserId,
        action: "evidence.unlock",
        outcome: "success",
        resourceId: id,
        teamId: evidence.teamId,
        metadata: {
          unlockedByUserId: ownerUserId,
          previousLockedByUserId: evidence.lockedByUserId,
          previousLockedAt: evidence.lockedAt?.toISOString() ?? null,
          // The caller-supplied reason is stored in the audit metadata
          // verbatim. We deliberately do NOT trim/lower it so the audit
          // record matches what the user typed (within the 500-char cap).
          reason: body.reason ?? null,
        },
      });

      const storage = await getStorageProtectionSummary(
        updated.storageBucket,
        updated.storageKey,
        {
          storageRegion: updated.storageRegion,
          storageObjectLockMode: updated.storageObjectLockMode,
          storageObjectLockRetainUntilUtc: updated.storageObjectLockRetainUntilUtc,
          storageObjectLockLegalHoldStatus: updated.storageObjectLockLegalHoldStatus,
        },
      );

      return reply.code(200).send({
        evidence: {
          ...toSafeEvidence(updated),
          storage,
        },
      });
    },
  );



  // =========================================================================
  // LIFECYCLE ROUTES — thin adapters over the ONE canonical mutation service.
  //
  // Archive, unarchive, trash and restore-from-trash used to carry ~270 lines
  // of hand-maintained policy here: four different authorization rules, three
  // different retention checks, two different lock checks, and a restore path
  // that authorized on creator identity alone. All of it now lives in
  // `applyEvidenceLifecycleAction`, which the bulk route calls too — so single
  // and bulk cannot diverge, because there is only one implementation to
  // diverge from.
  //
  // What is left in each handler is transport: parse the id, call the service,
  // map the result onto a status code and the route's established response
  // shape, and write the audit line. No handler decides anything.
  // =========================================================================

  /**
   * Run one canonical lifecycle action and reply in the archive/unarchive
   * response shape (`{ evidence: { …safe, storage } }`).
   */
  async function replyWithLifecycleResult(
    req: FastifyRequest,
    reply: FastifyReply,
    input: {
      id: string;
      actorUserId: string;
      action: EvidenceLifecycleAction;
      auditAction: string;
      shape: "evidence" | "deleted" | "restored";
    },
  ) {
    const outcome = await applyEvidenceLifecycleAction({
      evidenceId: input.id,
      actorUserId: input.actorUserId,
      action: input.action,
      source: "single",
      req,
    });

    if (!outcome.ok) {
      // The anti-enumeration 404 keeps its bare public body; every other
      // refusal reports the canonical block code so the UI can branch on the
      // same literal the shared authority produced.
      if (outcome.statusCode === 404) {
        req.log.info(
          { lifecycleAction: input.action },
          "evidence lifecycle action denied",
        );
        return reply.code(404).send(PUBLIC_NOT_FOUND_BODY);
      }
      auditEvidenceAction(req, {
        userId: input.actorUserId,
        action: input.auditAction,
        outcome: "blocked",
        severity: "warning",
        resourceId: input.id,
        metadata: { reason: outcome.code },
      });
      return reply
        .code(outcome.statusCode)
        .send({ code: outcome.code, message: outcome.message });
    }

    const updated = await prisma.evidence.findUnique({
      where: { id: input.id },
      select: SAFE_EVIDENCE_SELECT,
    });
    if (!updated) {
      return reply.code(404).send(PUBLIC_NOT_FOUND_BODY);
    }

    auditEvidenceAction(req, {
      userId: input.actorUserId,
      action: input.auditAction,
      outcome: "success",
      resourceId: input.id,
      teamId: outcome.teamId,
      metadata: {
        actorUserId: input.actorUserId,
        productState: outcome.productState,
        changed: outcome.changed,
      },
    });

    if (input.shape === "evidence") {
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
        },
      );
      return reply.code(200).send({
        evidence: { ...toSafeEvidence(updated), storage },
      });
    }

    return reply.code(200).send({
      ...(input.shape === "deleted" ? { deleted: true } : { restored: true }),
      evidence: toJsonSafe({ ...toSafeEvidence(updated) }),
    });
  }

  app.post(
    "/v1/evidence/:id/archive",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply) => {
      const ownerUserId = getAuthUserId(req);
      const id = z.string().uuid().parse((req.params as ParamsId).id);
      (req as FastifyRequest & { evidenceId?: string }).evidenceId = id;
      req.log = req.log.child({ evidenceId: id });

      return replyWithLifecycleResult(req, reply, {
        id,
        actorUserId: ownerUserId,
        action: "ARCHIVE",
        auditAction: "evidence.archive",
        shape: "evidence",
      });
    },
  );

  app.post(
    "/v1/evidence/:id/unarchive",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply) => {
      const ownerUserId = getAuthUserId(req);
      const id = z.string().uuid().parse((req.params as ParamsId).id);
      (req as FastifyRequest & { evidenceId?: string }).evidenceId = id;
      req.log = req.log.child({ evidenceId: id });

      return replyWithLifecycleResult(req, reply, {
        id,
        actorUserId: ownerUserId,
        action: "UNARCHIVE",
        auditAction: "evidence.unarchive",
        shape: "evidence",
      });
    },
  );

  /**
   * MOVE TO TRASH. The verb in the URL is `DELETE` for wire compatibility; the
   * operation is a recoverable soft-trash and deletes nothing. Physical
   * destruction is a separate, governed pipeline that only the canonical
   * destruction executor can run.
   */
  app.delete(
    "/v1/evidence/:id",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply) => {
      const ownerUserId = getAuthUserId(req);
      const id = z.string().uuid().parse((req.params as ParamsId).id);
      (req as FastifyRequest & { evidenceId?: string }).evidenceId = id;
      req.log = req.log.child({ evidenceId: id });

      return replyWithLifecycleResult(req, reply, {
        id,
        actorUserId: ownerUserId,
        action: "TRASH",
        auditAction: "evidence.delete",
        shape: "deleted",
      });
    },
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

      if (!body.restore) {
        return reply.code(400).send({ message: "Restore is required" });
      }

      return replyWithLifecycleResult(req, reply, {
        id,
        actorUserId: ownerUserId,
        action: "RESTORE_FROM_TRASH",
        auditAction: "evidence.restore",
        shape: "restored",
      });
    },
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
      // P0 remediation (2026-07-21) — ACTIVE memberships only.
      where: { userId: ownerUserId, status: "ACTIVE" },
      select: { teamId: true },
    });
    const memberTeamIds = memberTeams.map((entry) => entry.teamId);

    // PHASE 12 (anti-enumeration closure) — an EXPLICIT ?teamId= request is a
    // Workspace-scoped read: without ACTIVE membership in exactly that
    // Workspace it is concealed as 404 (previously the param was silently
    // ignored and the caller's own list 200'd — caught by the phase-37-95
    // live probe). With membership, the list is scoped to that Workspace.
    const requestedTeamId =
      typeof (req.query as Record<string, unknown>).teamId === "string"
        ? ((req.query as Record<string, unknown>).teamId as string)
        : null;
    if (requestedTeamId && !memberTeamIds.includes(requestedTeamId)) {
      return reply.code(404).send(PUBLIC_NOT_FOUND_BODY);
    }

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

    // Workspace-scoped request (membership proven above) → pin the filter.
    const scopedWhere: Prisma.EvidenceWhereInput = requestedTeamId
      ? { AND: [where, { teamId: requestedTeamId }] }
      : where;

    const items = await prisma.evidence.findMany({
      where: scopedWhere,
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

  /**
   * Phase EVIDENCE-LIBRARY-DATA-ACCURACY — workspace-scoped summary.
   *
   * Returns workspace-scoped counts that match the same accessibility
   * + scope + filter envelope the list endpoint uses (via the shared
   * `buildEvidenceListBaseWhere` helper). The Evidence Library UI
   * uses these as the workspace truth for its metric cards; counts
   * derived from the loaded page (50-row server slice) are labelled
   * "On this page" in the UI so users never read a page count as a
   * workspace total.
   *
   * Two load-bearing accuracy decisions:
   *
   *   1. `packagesReadyCount` is computed from the REAL
   *      `verificationPackages.some` relation — NOT from
   *      `latestReportVersion`. A record whose report succeeded but
   *      whose package generation failed correctly counts as MISSING
   *      here, never as READY.
   *
   *   2. `packagesMissingCount` is `status === REPORTED AND no
   *      package row`. We deliberately bind missing to REPORTED so
   *      records that have not yet finalised do not inflate the
   *      missing-package action surface.
   *
   * Additive — no destructive change to the list response, no schema
   * change, no permission change. The UI never silently falls back
   * to the report-version proxy if this endpoint fails; the package
   * metric instead shows "Package readiness unavailable".
   */
  app.get(
    "/v1/evidence/library-summary",
    { preHandler: requireAuth },
    async (req, reply) => {
      const ownerUserId = getAuthUserId(req);
      const parsedQuery = parseEvidenceListQuery(req.query as Record<string, unknown>);
      const { caseId, scope } = parsedQuery;

      if (caseId) {
        await assertCaseAccess(ownerUserId, caseId);
      }

      const memberTeams = await prisma.teamMember.findMany({
        // P0 remediation (2026-07-21) — ACTIVE memberships only.
        where: { userId: ownerUserId, status: "ACTIVE" },
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

      const REPORTS_READY_PREDICATE: Prisma.EvidenceWhereInput = {
        reports: { some: {} },
      };
      const PACKAGES_READY_PREDICATE: Prisma.EvidenceWhereInput = {
        verificationPackages: { some: {} },
      };
      const PACKAGES_MISSING_PREDICATE: Prisma.EvidenceWhereInput = {
        AND: [
          { status: prismaPkg.EvidenceStatus.REPORTED },
          { verificationPackages: { none: {} } },
        ],
      };
      const STORAGE_PROTECTED_PREDICATE: Prisma.EvidenceWhereInput = {
        OR: [
          { storageObjectLockMode: { not: null } },
          { storageObjectLockRetainUntilUtc: { not: null } },
          { storageObjectLockLegalHoldStatus: { not: null } },
        ],
      };
      const STORAGE_NEEDS_REVIEW_PREDICATE: Prisma.EvidenceWhereInput = {
        AND: [
          { storageObjectLockMode: null },
          { storageObjectLockRetainUntilUtc: null },
          { storageObjectLockLegalHoldStatus: null },
        ],
      };
      const MULTIPART_PREDICATE: Prisma.EvidenceWhereInput = {
        parts: { some: { partIndex: { gt: 0 } } },
      };
      const VERIFICATION_ISSUES_PREDICATE: Prisma.EvidenceWhereInput = {
        verificationStatus: {
          in: [
            prismaPkg.VerificationStatus.REVIEW_REQUIRED,
            prismaPkg.VerificationStatus.FAILED,
          ],
        },
      };
      const UNASSIGNED_PREDICATE: Prisma.EvidenceWhereInput = {
        caseLinks: { none: {} },
      };

      const compose = (extra: Prisma.EvidenceWhereInput): Prisma.EvidenceWhereInput => ({
        AND: [baseWhere, extra],
      });

      const [
        totalActiveRecords,
        reportsReadyCount,
        packagesReadyCount,
        packagesMissingCount,
        storageProtectedCount,
        storageNeedsReviewCount,
        multipartCount,
        verificationIssuesCount,
        unassignedCount,
      ] = await Promise.all([
        prisma.evidence.count({ where: baseWhere }),
        prisma.evidence.count({ where: compose(REPORTS_READY_PREDICATE) }),
        prisma.evidence.count({ where: compose(PACKAGES_READY_PREDICATE) }),
        prisma.evidence.count({ where: compose(PACKAGES_MISSING_PREDICATE) }),
        prisma.evidence.count({ where: compose(STORAGE_PROTECTED_PREDICATE) }),
        prisma.evidence.count({ where: compose(STORAGE_NEEDS_REVIEW_PREDICATE) }),
        prisma.evidence.count({ where: compose(MULTIPART_PREDICATE) }),
        prisma.evidence.count({ where: compose(VERIFICATION_ISSUES_PREDICATE) }),
        prisma.evidence.count({ where: compose(UNASSIGNED_PREDICATE) }),
      ]);

      // Needs-action is a distinct-records count over the OR-union
      // of the three "real problem" predicates. Computing it as a
      // single query (instead of summing) avoids double-counting a
      // record that matches more than one branch (e.g. verification
      // issue + unassigned).
      const needsActionCount = await prisma.evidence.count({
        where: compose({
          OR: [
            VERIFICATION_ISSUES_PREDICATE,
            PACKAGES_MISSING_PREDICATE,
            UNASSIGNED_PREDICATE,
          ],
        }),
      });

      return reply.code(200).send({
        scope,
        source: "workspace_total",
        totalActiveRecords,
        reportsReadyCount,
        packagesReadyCount,
        packagesMissingCount,
        storageProtectedCount,
        storageNeedsReviewCount,
        multipartCount,
        verificationIssuesCount,
        unassignedCount,
        needsActionCount,
      });
    },
  );

  // Phase G4.5 — `/v1/evidence/saved-views/*` route handlers moved to
  // `evidence.saved-views.routes.ts`. The registration call is at
  // the top of `evidenceRoutes`. No semantic change.

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
        // P0 remediation (2026-07-21) — ACTIVE-only membership authorizes.
        const caseTeamMember = await prisma.teamMember.findUnique({
          where: { teamId_userId: { teamId: caseItem.teamId, userId } },
          select: { status: true },
        });
        canAccessCase = caseTeamMember?.status === "ACTIVE";
      }
      if (!canAccessCase) {
        return reply.code(403).send({ message: "Forbidden" });
      }
    }

    // Phase R1 imported `runDestructiveActionGate` here so the bulk TRASH and
    // ARCHIVE branches could run the same governance gate as the single-record
    // routes — the only path that enforces the canonical legal-hold model,
    // which the pre-R1 bulk path skipped entirely.
    //
    // EVIDENCE LIFECYCLE CONVERGENCE (2026-08-24) — the import is gone because
    // the second invocation is gone. The gate runs inside
    // `applyEvidenceLifecycleAction`, which both the single routes and these
    // branches call, so parity is no longer two call sites kept in step by
    // review: it is one call site.

    for (const evidenceId of uniqueIds) {
      try {
        // PHASE 1 (2026-07-21) — per-action canonical capability against the
        // PERSISTED evidence.teamId (owner rule only for personal-scope
        // evidence): case linking → update_metadata; everything else read.
        //
        // EVIDENCE LIFECYCLE CONVERGENCE (2026-08-24) — the four lifecycle
        // actions are NOT resolved here any more. Their authorization is part
        // of `applyEvidenceLifecycleAction`, which resolves it against the
        // persisted row with the same primitive the single routes use. Doing it
        // twice would mean two places could answer differently, which is the
        // class of drift this pass exists to remove.
        const evidence =
          body.action === "ADD_TO_CASE" || body.action === "REMOVE_FROM_CASE"
            ? await getEvidenceWithRecordAccess(
                userId,
                evidenceId,
                "evidence.update_metadata",
              )
            : await getEvidenceWithReadAccess(userId, evidenceId);

        switch (body.action) {
          case "ADD_TO_CASE": {
            if (!caseItem) {
              throw new Error("Case not found");
            }
            if (evidence.deletedAt) {
              throw new Error("Cannot add deleted evidence to a case");
            }
            // PHASE 6 §9.3/§9.6 (2026-07-22) — the SAME cross-team attach
            // gate as the single-record path (cases.routes.ts). Without
            // it this branch overwrote evidence.teamId with the target
            // case's teamId — an implicit cross-tenant transfer a
            // dual-workspace member could trigger in bulk. Strict
            // equality (null === null for personal scope) or 403.
            const crossTeam = evaluateCrossTeamAttach({
              caseTeamId: caseItem.teamId,
              evidenceTeamId: evidence.teamId,
            });
            if (!crossTeam.allowed) {
              auditEvidenceAction(req, {
                userId,
                action: "evidence.bulk",
                outcome: "blocked",
                severity: "critical",
                resourceId: evidenceId,
                teamId: evidence.teamId,
                metadata: {
                  reason: "forbidden",
                  denyCode: crossTeam.code,
                  eventKind: "CROSS_TEAM_ATTACH_BLOCKED",
                  caseId: caseItem.id,
                  caseTeamId: caseItem.teamId,
                  evidenceTeamId: evidence.teamId,
                },
              });
              throw new Error("Cross-workspace attach is not permitted");
            }
            // Track 1B — attach flows through the CANONICAL
            // case-evidence authority (link row + audit, atomically).
            // The gate above already
            // guarantees teamId: caseItem.teamId equals the evidence's
            // own teamId, so the old direct teamId stamp was a no-op.
            await attachEvidenceToCase({
              caseId: caseItem.id,
              evidenceId,
              actorUserId: userId,
              role: "PRIMARY",
              source: "USER",
              ipAddress: req.ip,
              userAgent: normalizeUserHeader(req),
            });
            const updated = await prisma.evidence.findUniqueOrThrow({
              where: { id: evidenceId },
              select: EVIDENCE_LIST_SELECT,
            });
            updatedItems.push(mapEvidenceListItem(updated));
            break;
          }
          case "REMOVE_FROM_CASE": {
            // Track 1B closure — the canonical link table is the ONE
            // relationship source. "Remove from case" detaches the
            // record from EVERY linked case (the historical bulk action
            // semantically unassigned the record entirely).
            const evidenceCaseLinks = await prisma.caseEvidenceLink.findMany({
              where: { evidenceId },
              select: { caseId: true },
              take: 100,
            });
            if (evidenceCaseLinks.length === 0) {
              throw new Error("Evidence is not assigned to a case");
            }
            // Detach through the CANONICAL case-evidence authority.
            // Preserves the historical bulk semantics: leaving the last
            // case also resets the workspace binding.
            for (const link of evidenceCaseLinks) {
              await detachEvidenceFromCase({
                caseId: link.caseId,
                evidenceId,
                actorUserId: userId,
                clearEvidenceTeamIdWhenUnlinked: true,
                ipAddress: req.ip,
                userAgent: normalizeUserHeader(req),
              });
            }
            const updated = await prisma.evidence.findUniqueOrThrow({
              where: { id: evidenceId },
              select: EVIDENCE_LIST_SELECT,
            });
            updatedItems.push(mapEvidenceListItem(updated));
            break;
          }
          // ===================================================================
          // LIFECYCLE BRANCHES — the SAME canonical service the single routes
          // call. Each branch is now four lines: dispatch, map the refusal onto
          // the per-record `reason`, re-read the row for the list projection.
          //
          // The four hand-written copies that stood here carried their own lock
          // checks, their own retention check, their own governance gate on two
          // of the four actions, and their own already-in-state error. They are
          // gone; the parity between single and bulk is now structural rather
          // than reviewed.
          // ===================================================================
          case "ARCHIVE":
          case "RESTORE_ARCHIVED":
          case "TRASH":
          case "RESTORE_TRASH": {
            const outcome = await applyEvidenceLifecycleAction({
              evidenceId,
              actorUserId: userId,
              action: BULK_LIFECYCLE_ACTION[body.action],
              source: "bulk",
              req,
            });
            if (!outcome.ok) {
              throw new Error(outcome.code);
            }
            const updated = await prisma.evidence.findUniqueOrThrow({
              where: { id: evidenceId },
              select: EVIDENCE_LIST_SELECT,
            });
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
    }).catch(noteCustodyFailure);

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
      }).catch(noteCustodyFailure);

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
      }).catch(noteCustodyFailure);

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
    }).catch(noteCustodyFailure);

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
      }).catch(noteCustodyFailure);

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
      }).catch(noteCustodyFailure);

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
    }).catch(noteCustodyFailure);

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
      }).catch(noteCustodyFailure);

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
      }).catch(noteCustodyFailure);

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
      select: {
        version: true,
        generatedAtUtc: true,
        verificationPackageVersion: true,
        // The report snapshots the trust decision as it stood when the report
        // was generated; the verification package snapshots it again when the
        // package was built. Comparison mode aligns the two, which it cannot
        // do while only one side is projected.
        trustDecisionSnapshot: true,
      },
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
            trustDecisionSnapshot: toJsonSafe(latestReport.trustDecisionSnapshot),
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
        tsaStatus: null,
        otsStatus: null,
        publicVerifyState: null,
        verificationStatus: null,
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

    // Phase EVIDENCE-DUPLICATES-GROUPING — assemble a deduped,
    // grouped view of the four match arrays. The existing per-
    // category arrays stay in the response (back-compat for any
    // other consumer + tests); the UI prefers the new
    // `groupedMatches` array, which:
    //
    //   - dedupes across the four arrays so a record that matches
    //     by exact hash + fingerprint + part hash appears ONCE;
    //   - groups part-level matches by parent evidenceId so a
    //     single record with 8 matching parts appears ONCE, with
    //     `matchedPartsCount: 8`;
    //   - returns `rawTitle: string | null` (the unsubstituted
    //     evidence.title column) so the UI's cascade
    //     (title → displayFileName → originalFileName → type
    //     → shortId) can actually run. Previously the backend
    //     pre-substituted "Digital Evidence Record" via
    //     `resolveEvidenceTitle` and that masked the empty title,
    //     so every row rendered the same fallback.
    //
    // The grouping is pure post-processing — no schema changes,
    // no new queries, no permission changes.
    type MatchReason =
      | "exact_hash"
      | "fingerprint"
      | "part_hash"
      | "metadata";

    type GroupedMatch = {
      evidenceId: string;
      rawTitle: string | null;
      displayFileName: string | null;
      originalFileName: string | null;
      type: string;
      mimeType: string | null;
      itemCount: number;
      createdAt: string;
      matchReasons: MatchReason[];
      matchedPartsCount: number;
    };

    const grouped = new Map<string, GroupedMatch>();
    const addToGroup = (
      rows: typeof exactHashMatches,
      reason: MatchReason,
    ) => {
      for (const row of rows) {
        const existing = grouped.get(row.id);
        if (existing) {
          if (!existing.matchReasons.includes(reason)) {
            existing.matchReasons.push(reason);
          }
          if (reason === "part_hash") {
            // We don't yet know the exact part overlap count here,
            // so increment by 1 per matching record to keep the
            // count an honest lower bound. A future enhancement can
            // run a `count()` on the part-hash overlap.
            existing.matchedPartsCount += 1;
          }
        } else {
          grouped.set(row.id, {
            evidenceId: row.id,
            // The raw title column — NOT routed through
            // resolveEvidenceTitle (which would inject the
            // "Digital Evidence Record" fallback). The UI cascades
            // through displayFileName / originalFileName / type
            // before falling back to a shortened id.
            rawTitle: typeof row.title === "string" && row.title.trim() ? row.title.trim() : null,
            displayFileName: row.displayFileName ?? null,
            originalFileName: row.originalFileName ?? null,
            type: row.type,
            mimeType: row.mimeType ?? null,
            itemCount: row._count.parts > 0 ? row._count.parts : 1,
            createdAt: row.createdAt.toISOString(),
            matchReasons: [reason],
            matchedPartsCount: reason === "part_hash" ? 1 : 0,
          });
        }
      }
    };

    addToGroup(exactHashMatches, "exact_hash");
    addToGroup(fingerprintMatches, "fingerprint");
    addToGroup(partHashMatches, "part_hash");
    addToGroup(possibleMetadataMatches, "metadata");

    const groupedMatches = Array.from(grouped.values()).sort((a, b) => {
      // Stronger evidence first: exact_hash > fingerprint >
      // part_hash > metadata. Within the same strength, newest
      // record first.
      const strength = (m: GroupedMatch) => {
        if (m.matchReasons.includes("exact_hash")) return 0;
        if (m.matchReasons.includes("fingerprint")) return 1;
        if (m.matchReasons.includes("part_hash")) return 2;
        return 3;
      };
      const diff = strength(a) - strength(b);
      if (diff !== 0) return diff;
      return a.createdAt < b.createdAt ? 1 : -1;
    });

    return reply.code(200).send({
      exactHashMatches: exactHashMatches.map(mapEvidenceListItem),
      fingerprintMatches: fingerprintMatches.map(mapEvidenceListItem),
      partHashMatches: partHashMatches.map(mapEvidenceListItem),
      possibleMetadataMatches: possibleMetadataMatches.map(mapEvidenceListItem),
      groupedMatches,
      totalRecords: groupedMatches.length,
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

      /*
       * READING THE RECORD IS NOT AUTHORITY TO TRIAGE IT.
       *
       * This route gated on `getEvidenceWithReadAccess` alone, so anyone who
       * could SEE the record could move its reviewer status. Proven against a
       * live workspace: a VIEWER changed a record from IN_REVIEW back to
       * NOT_STARTED and the change persisted — while the verdict endpoint next
       * to it correctly answered 403 for the same user. One half of the
       * reviewer workflow was gated and the other was not.
       *
       * It now requires the same permission the decision endpoint does. A
       * personal workspace has no team row and therefore no membership to
       * check; there, read access already means sole ownership, and the
       * canonical primitive is only consulted when a workspace exists to be a
       * member of.
       */
      if (evidence.teamId) {
        const authorized = await authorizeOrFail(req, reply, {
          teamId: evidence.teamId,
          permission: "evidence_request.review",
          antiEnumeration: true,
        });
        if (!authorized) return reply;
      }

      if (body.assignedToUserId) {
        // Track 1B closure — access can flow through ANY linked case.
        const assigneeCaseLinks = await prisma.caseEvidenceLink.findMany({
          where: { evidenceId: id },
          select: { caseId: true },
          take: 100,
        });
        const targetUserAccessible =
          evidence.ownerUserId === body.assignedToUserId ||
          (assigneeCaseLinks.length > 0
            ? await prisma.caseAccess.findFirst({
                where: {
                  caseId: { in: assigneeCaseLinks.map((l) => l.caseId) },
                  userId: body.assignedToUserId,
                },
                select: { caseId: true },
              })
            : evidence.teamId
              ? await prisma.teamMember.findFirst({
                  where: {
                    teamId: evidence.teamId,
                    userId: body.assignedToUserId,
                    // P0 remediation (2026-07-21) — ACTIVE-only membership authorizes.
                    status: "ACTIVE",
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

      // Phase T — read the canonical template-identity trio off the
      // Evidence row so a manual reviewer-workflow update (e.g. a status
      // change from the reviewer UI) also stamps the trio onto the
      // workflow row. This handles the corner case where the workflow
      // row was created BEFORE the Evidence trio was stamped (i.e. an
      // upsert path that pre-dated Phase T), letting later updates
      // backfill the trio without a separate maintenance job. Wrapped
      // in try/catch — read failure leaves the trio undefined so the
      // upsert does not touch the trio columns.
      let manualTrio: TemplateIdentityTrio | undefined;
      try {
        const evidenceTrioRow = await prisma.evidence.findUnique({
          where: { id },
          select: {
            templateSlug: true,
            templateVersion: true,
            templateDbId: true,
          },
        });
        if (evidenceTrioRow) {
          manualTrio = {
            templateSlug: evidenceTrioRow.templateSlug ?? null,
            templateVersion: evidenceTrioRow.templateVersion ?? null,
            templateDbId: evidenceTrioRow.templateDbId ?? null,
          };
        }
      } catch (trioReadErr) {
        req.log?.warn?.(
          { err: trioReadErr, evidenceId: id },
          "reviewer_workflow_trio_read_failed",
        );
        manualTrio = undefined;
      }

      const summary = await upsertEvidenceReviewerWorkflow({
        evidenceId: id,
        workspaceType: evidence.teamId ? "TEAM" : "PERSONAL",
        teamId: evidence.teamId ?? null,
        actorUserId: userId,
        assignedToUserId: body.assignedToUserId,
        status: body.status as prismaPkg.EvidenceReviewWorkflowStatus | undefined,
        priority: body.priority,
        dueAt:
          body.dueAt === undefined
            ? undefined
            : body.dueAt
              ? new Date(body.dueAt)
              : null,
        note: body.note ?? null,
        templateIdentity: manualTrio,
        templateIdentitySource: "direct",
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
      }).catch(noteCustodyFailure);

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
      const evidence = await getEvidenceWithReadAccess(userId, id);

      /*
       * REVEALING THE RECIPIENT'S ADDRESS IS NOT PART OF READING THE RECORD.
       *
       * The decision is not made here: it is made once, by the canonical
       * recipient-contact policy, which every External Intake surface shares.
       * What comes back either way is the masked form — REVEALED only means
       * this caller may go and ask for the raw one at
       * POST /v1/workflow/intake-links/:id/recipient-contact.
       */
      const disclosure = await resolveRecipientContactDisclosure(req, {
        teamId: evidence.teamId,
      });

      const { loadExternalIntakeSourceSummary } = await import(
        "../services/external-intake-source-summary.service.js"
      );
      const summary = await loadExternalIntakeSourceSummary(id, {
        recipientContactDisclosure: disclosure,
      });
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
      }).catch(noteCustodyFailure);

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
      }).catch(noteCustodyFailure);

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
      }).catch(noteCustodyFailure);

      return reply.code(200).send({ deleted: true });
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

      // Phase A8 — burst rate limit + dedup (unchanged-object reanalysis).
      const rlGuard = await enforceAiEndpointGuard({
        feature: "categorization",
        userId,
        ip: req.ip,
        dedupeKey: `${id}:${evidence.verificationPackageVersion ?? 0}:${evidence.latestReportVersion ?? 0}`,
        dedupeWindowSec: 30,
      });
      if (!rlGuard.allowed) {
        reply.header("Retry-After", String(rlGuard.retryAfterSec));
        return reply.code(429).send({ code: rlGuard.code, message: "Too many AI requests; please slow down." });
      }

      // Phase A2 — canonical workspace AI policy gate (fail-closed). A
      // workspace master/feature disable blocks the categorization provider
      // call here, in the backend, before any AI runs.
      const catPolicy = await evaluateWorkspaceAiPolicy({
        teamId: evidence.teamId ?? null,
        feature: "EVIDENCE_CATEGORIZATION",
        dataClass: "METADATA",
      });
      if (!catPolicy.allowed) {
        return reply.code(403).send({
          code: "AI_WORKSPACE_POLICY_DENIED",
          message: catPolicy.reason,
          decision: catPolicy.decision,
        });
      }

      const itemCount = await getEvidenceItemCount(id);
      const canonicalAvailability = deriveCanonicalArtifactAvailability({
        latestReportVersion: evidence.latestReportVersion,
        reportGeneratedAtUtc: evidence.reportGeneratedAtUtc,
        verificationPackageVersion: evidence.verificationPackageVersion,
        verificationPackageGeneratedAtUtc:
          evidence.verificationPackageGeneratedAtUtc,
      });
      // Phase A4 — user-controlled free-text (title, workspace label) is
      // UNTRUSTED. Sanitize (Unicode-normalize, strip control/secret/URL/GPS,
      // bound length) before it can enter the model prompt. An injected
      // instruction in a title can no longer reach the model as text.
      const metadataPayload = {
        evidenceId: id,
        title: sanitizeUntrustedField(resolveEvidenceTitle(evidence.title), 300),
        type: evidence.type,
        mimeType: evidence.mimeType ?? null,
        itemCount,
        sizeBytes: bigintToString(evidence.sizeBytes),
        captureMethod: evidence.captureMethod ?? null,
        verificationStatus: evidence.verificationStatus ?? null,
        ...canonicalAvailability,
        caseLinked: evidence.caseLinks.length > 0,
        workspaceLabel: sanitizeUntrustedField(evidence.workspaceNameSnapshot ?? "", 200) || null,
        checklistMetadataOnly: true,
      };

      // Phase F-1 — canonical durable ledger around the provider call
      // (reserve → provider → reconcile; release on failure). Same flow as
      // the Copilots; the in-memory guard above remains a burst heuristic.
      const catLedger = await tryReserveAiBudget({
        teamId: evidence.teamId ?? null,
        userId,
        feature: "EVIDENCE_CATEGORIZATION",
        model:
          process.env.OPENAI_EVIDENCE_CATEGORIZATION_MODEL?.trim() ||
          process.env.OPENAI_MODEL?.trim() ||
          "gpt-4.1-mini",
        requestId: `categorization:${id}:${Date.now()}`,
        estimatedCostUsdMicros: 100_000n,
      });
      if (catLedger.decision && !catLedger.decision.allowed && catLedger.decision.code !== "DUPLICATE_REQUEST") {
        return reply.code(429).send({
          code: `AI_BUDGET_${catLedger.decision.code}`,
          message: "The workspace AI budget or operation limit has been reached.",
        });
      }

      let aiResult: Awaited<ReturnType<typeof evidenceAiProvider.run>>;
      try {
        aiResult = await evidenceAiProvider.run(
          AiTask.EVIDENCE_METADATA_CATEGORIZATION,
          metadataPayload
        );
      } catch (err) {
        if (catLedger.reservationId) {
          await releaseAiReservation(buildPrismaLedgerStore(), catLedger.reservationId).catch(() => undefined);
        }
        throw err;
      }
      if (catLedger.reservationId) {
        await reconcileAiUsage(buildPrismaLedgerStore(), catLedger.reservationId, null).catch(() => undefined);
      }

      const deterministicCategories = [
        evidence.type,
        itemCount > 1 ? "MULTIPART" : "SINGLE_ITEM",
        evidence.captureMethod ?? "CAPTURE_METHOD_UNRECORDED",
      ];
      const suggestedTags = [
        evidence.mimeType ?? "mime-unrecorded",
        evidence.verificationStatus ?? "verification-unrecorded",
        canonicalAvailability.reportReady ? "report-ready" : "report-missing",
        evidence.caseLinks.length > 0 ? "case-linked" : "case-unassigned",
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
      }).catch(noteCustodyFailure);

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
        // Signing-key metadata is OPTIONAL for the review-workspace
        // projection. A row can legitimately exist before signing
        // completes (mid-capture, mid-intake, post-upload pre-
        // finalize). The previous 409 with the technical message
        // "Signing key metadata is not recorded for this evidence
        // record" reached the UI and read as a hard error to
        // reviewers. The fix: render the full projection but mark
        // `signingKey.recorded = false`; the Integrity tab shows a
        // friendly "Signing metadata not yet recorded" warning, and
        // preview/metadata/submissions/source context all still
        // load. Signature verification just resolves to null in
        // this branch; downstream consumers already handle null
        // publicKeyPem.
        const signingKeyMetadataRecorded =
          !!evidence.signingKeyId && evidence.signingKeyVersion != null;
        const signingKey = signingKeyMetadataRecorded
          ? await prisma.signingKey.findUnique({
              where: {
                keyId_version: {
                  keyId: evidence.signingKeyId!,
                  version: evidence.signingKeyVersion!,
                },
              },
              select: { publicKeyPem: true },
            })
          : null;

        // The hard 503 below only fires when the row CLAIMS a
        // signing key exists (id+version set) but the key row is
        // missing from the table — that is a true server-config
        // bug. Pending-signing rows skip this branch entirely.
        if (signingKeyMetadataRecorded && !signingKey) {
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
          // Phase DISCUSSION-CAPABILITY-FIX — capability inputs.
          discussionTeamRow,
          callerTeamMembership,
          existingDiscussionThreadCount,
        ] = await Promise.all([
          getEvidenceItemCount(id),
          // COMMERCIAL AUTHORITY (2026-09-03) — the account-wide billing
          // aggregate was fetched here ONLY to find this record's workspace in
          // its `workspaces.teams` array. The capability snapshot resolves that
          // one workspace canonically now, so the aggregate — and every
          // per-workspace query behind it — is not built at all.
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
          primaryCaseIdOf(evidence)
            ? prisma.case.findUnique({
                where: { id: primaryCaseIdOf(evidence)! },
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
          // Phase DISCUSSION-CAPABILITY-FIX — three small reads that
          // back the Discussion-tab capability gate. Conditional on
          // evidence.teamId because personal evidence (no team) trivially
          // returns `discussionEnabled: false` / `discussionReadOnly: false`
          // without any DB hit.
          evidence.teamId
            ? prisma.team.findUnique({
                where: { id: evidence.teamId },
                select: { isPersonal: true },
              })
            : Promise.resolve(null),
          evidence.teamId
            ? prisma.teamMember.findUnique({
                where: {
                  teamId_userId: {
                    teamId: evidence.teamId,
                    userId: ownerUserId,
                  },
                },
                select: { role: true, status: true },
              })
            : Promise.resolve(null),
          evidence.teamId
            ? prisma.discussionThread.count({
                where: { evidenceId: id, teamId: evidence.teamId },
              })
            : Promise.resolve(0),
        ]);

        const workspaceCapabilitySnapshot = await resolveWorkspaceCapabilitySnapshot({
          ownerUserId,
          evidence,
          discussion: {
            team: discussionTeamRow,
            callerMembership: callerTeamMembership,
            existingDiscussionThreadCount,
          },
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

        // Phase CAPTURE-DETAIL-WIRING — the per-part capture metadata
        // (privateNote / privateRole / sourceLabel / clientSignals) is
        // persisted from POST /v1/evidence/:id/parts but until this
        // projection only `privateNote` made it into the review-
        // workspace contentItems response. Each is workspace-internal
        // (the public-verify projection deliberately omits them), so
        // attaching them here is safe and unblocks the Evidence Detail
        // UI from rendering capture-time context.
        const partLookup = new Map(parts.map((part) => [part.id, part] as const));

        const contentItems = content.items.map((item) => {
          const part = partLookup.get(item.id);
          return {
            ...item,
            privateNote: part?.privateNote ?? null,
            privateRole: part?.privateRole ?? null,
            sourceLabel: part?.sourceLabel ?? null,
            clientSignals: part?.clientSignals ?? null,
          };
        });

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
          // signingKey is null when the row is pending-signing —
          // signature verification is skipped and signatureValid
          // stays false; the Integrity tab renders a
          // "Signing metadata not yet recorded" warning rather
          // than a hard error.
          signatureValid =
            signingKey !== null &&
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
            publicKeyPem: signingKey?.publicKeyPem ?? null,
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
                  provider: anchor.provider,
                  anchoredAtUtc: anchor.anchoredAtUtc,
                  transactionId: anchor.transactionId,
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
        const artifactStatus = await buildEvidenceArtifactStatus({
          evidenceId: id,
          evidenceStatus: evidence.status,
          evidenceTeamId: evidence.teamId ?? null,
          evidenceVerificationPackageMetadata:
            evidence.verificationPackageMetadata ?? null,
        });
        const primaryCaseId = primaryCaseIdOf(evidence);
        const relatedEvidenceCount = primaryCaseId
          ? await prisma.evidence.count({
              where: {
                caseLinks: { some: { caseId: primaryCaseId } },
                deletedAt: null,
              },
            })
          : null;
        const publicVerifyPath = `/verify/${evidence.id}`;
        const publicVerificationSummary = buildPublicVerificationSummary({
          evidence,
          anchor,
          workspaceCapabilitySnapshot,
          sharePath: publicVerifyPath,
          publicViewCount: publicVerifyCount,
          authenticatedViewCount: authenticatedVerifyCount,
          lastPublicViewAt:
            lastPublicVerify?.createdAt?.toISOString() ?? null,
          reportDownloadCount,
          verificationPackageDownloadCount,
        });

        const reviewerAlerts = buildResolvedReviewerAlerts({
          evidenceIntelligence,
          publicVerificationSummary,
          artifactStatus,
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
                ? "Download the verification package for independent review if needed."
                : "Generate a verification package when independent review is required.",
            ],
          };

        auditEvidenceAction(req, {
          userId: ownerUserId,
          action: "evidence.review_workspace_viewed",
          outcome: "success",
          resourceId: id,
          teamId: evidence.teamId,
          metadata: {
            itemCount,
            forensicEventCount: forensicCustodyEvents.length,
            accessEventCount: accessCustodyEvents.length,
          },
        });

        // THE ANALYSIS REVISION for this record, bound to the EVIDENCE
        // surface. The Evidence Copilot compared
        // `verificationPackageVersion ?? 0` on both sides — symmetric, so no
        // false rejection was reachable, and also blind to the thirteen other
        // fields it shows the model.
        //
        // `teamId ?? ""` USED TO STAND HERE, and it made this whole response a
        // 500 for any record with no team. `""` is not a uuid, so Postgres
        // rejected the query outright — which meant a legacy PERSONAL record
        // (`team_id IS NULL`) could not open its Details page AT ALL, while the
        // Library listed it happily. A team-scoped lookup for a record with no
        // team has no answer to give; skipping it is the honest form, and it
        // leaves `analysisRevision` null exactly as it is for any record whose
        // snapshot has not been taken.
        const [analysisSnapshot] = evidence.teamId
          ? await loadEvidenceAnalysisSnapshots({
              ids: [id],
              teamId: evidence.teamId,
              scope: { scope: "evidence", scopeId: null },
            })
          : [];
        // ONE hold lookup for this response, resolved before the reply is
        // assembled so the projection and the legacy shape derived from it
        // cannot come from two different reads of the hold tables.
        const workspaceLifecycleProjection = await projectEvidenceLifecycle(
          toEvidenceLifecycleProjectionInput(evidence),
        );

        return reply.code(200).send(
          toJsonSafe({
            evidence: {
              ...toSafeEvidence(evidence),
              analysisRevision: analysisSnapshot?.revision ?? null,
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
              // THE LIFECYCLE VERDICT — added 2026-08-25.
              //
              // Evidence Details does not read `GET /v1/evidence/:id`. It reads
              // THIS response, and this response carried no lifecycle
              // projection, so the page's eligibility helper hit its
              // "no projection, no legacy field" branch and reported
              // "Record state is loading. Try again in a moment." forever —
              // for a record the Library could trash, because the Library row
              // DID carry the projection. One record, two surfaces, two
              // answers.
              //
              // Same async projection the canonical detail response uses: the
              // UNION legal-hold evaluator (evidence + case + workspace) rather
              // than the list path's Object Lock column, because a detail page
              // can afford one hold lookup and must not offer an action the
              // write path will refuse. It fails closed.
              [EVIDENCE_LIFECYCLE_RESPONSE_FIELD]: workspaceLifecycleProjection,
              // The legacy shape, DERIVED from that same projection, for any
              // client still reading it. Never computed beside it.
              [DELETE_ELIGIBILITY_RESPONSE_FIELD]: toLegacyDeleteEligibility(
                workspaceLifecycleProjection,
              ),
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
                  // Source label is now provenance-aware: rows whose
                  // coordinates came from a contributor's browser via
                  // the Intake Link path read as "Contributor browser
                  // location", while authenticated Capture rows keep
                  // the historical CAPTURE label. Existing rows pre-
                  // location-source migration backfilled to CAPTURE so
                  // their display is byte-identical to before.
                  source: evidenceLocationSourceLabel(
                    evidence.locationSource,
                  ),
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
              // The canonical fingerprint is recomputed above and compared
              // against the recorded hash. The public verify surface has
              // always reported that comparison; the authenticated Integrity
              // tab previously computed it and dropped it, so the two
              // surfaces could not agree. `null` = nothing recorded to
              // compare against (no conclusion, not a failure).
              fingerprintCanonicalHashMatches: evidence.fingerprintCanonicalJson
                ? canonicalHashMatches
                : null,
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
                proofPresent: Boolean(evidence.otsProofBase64),
                hashMatches: otsHashMatches,
                anchoredAtUtc:
                  effectiveOtsAnchoredAtUtc?.toISOString() ?? null,
                upgradedAtUtc:
                  evidence.otsUpgradedAtUtc?.toISOString() ?? null,
                lastUpdatedAtUtc:
                  evidence.otsUpgradedAtUtc?.toISOString() ??
                  effectiveOtsAnchoredAtUtc?.toISOString() ??
                  null,
                calendar: evidence.otsCalendar ?? null,
                bitcoinTxid: evidence.otsBitcoinTxid ?? null,
                failureReason: evidence.otsFailureReason ?? null,
                pendingReason:
                  effectiveOtsStatus === "PENDING"
                    ? evidence.otsProofBase64
                      ? "OpenTimestamps proof is recorded; public anchoring is still pending."
                      : "OpenTimestamps anchoring has not completed yet."
                    : null,
              },
              custodyChain: {
                valid: custodyChain.valid,
                mode: custodyChain.mode,
                reason: custodyChain.reason,
              },
              storage,
              anchor,
              report: artifactStatus.report,
              verificationPackage: {
                ...verificationPackageIntegrity,
                pending: artifactStatus.verificationPackage.pending,
                unavailable: artifactStatus.verificationPackage.unavailable,
                unavailableReason:
                  artifactStatus.verificationPackage.unavailableReason,
                blocked: artifactStatus.verificationPackage.blocked,
                blockedOutcome:
                  artifactStatus.verificationPackage.blockedOutcome,
                blockedReason:
                  artifactStatus.verificationPackage.blockedReason,
                blockedAtUtc:
                  artifactStatus.verificationPackage.blockedAtUtc,
                manifestSignature:
                  artifactStatus.verificationPackage.manifestSignature,
              },
            },
            relationships: {
              caseId: caseItem?.id ?? primaryCaseId ?? null,
              caseName: caseItem?.name ?? null,
              relatedEvidenceCount,
              multipart: content.summary.structure === "multipart",
              itemCount: content.summary.itemCount,
              note:
                !primaryCaseId && relationshipItems.length === 0
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
              billingShape: workspaceCapabilitySnapshot.workspaceType,
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
            publicVerificationSummary,
            artifactStatus,
            artifactVersions: {
              history: artifactHistory,
              latestReport: {
                available: artifactStatus.report.available,
                version: artifactStatus.report.version,
                generatedAtUtc: artifactStatus.report.generatedAtUtc,
              },
              latestVerificationPackage: {
                available: artifactStatus.verificationPackage.available,
                version: artifactStatus.verificationPackage.version,
                packageType: artifactStatus.verificationPackage.packageType,
                generatedAtUtc:
                  artifactStatus.verificationPackage.generatedAtUtc,
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
                publicKeyPem: signingKey?.publicKeyPem ?? null,
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
            legalBoundary: buildCanonicalLegalBoundaryMaterial().reportBoundary,
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
          teamId: evidence.teamId,
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

        // EVIDENCE LIFECYCLE CONVERGENCE (2026-08-24) — the canonical lifecycle
        // projection, resolved through the union legal-hold evaluator. It is
        // the ONE thing the Evidence Details surface reads to decide which
        // lifecycle actions to offer; the browser no longer computes any of it.
        // `deleteEligibility` is the legacy shape for older clients, DERIVED
        // from this projection rather than computed beside it.
        const lifecycleProjection = await projectEvidenceLifecycle(
          toEvidenceLifecycleProjectionInput(evidence),
        );
        const deleteEligibility = toLegacyDeleteEligibility(lifecycleProjection);

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
            [EVIDENCE_LIFECYCLE_RESPONSE_FIELD]: lifecycleProjection,
            [DELETE_ELIGIBILITY_RESPONSE_FIELD]: deleteEligibility,
          }),
        });
                  } catch (err) {
        const statusCode =
          err instanceof Error && "statusCode" in err
            ? (err as Error & { statusCode?: number }).statusCode ?? 500
            : 500;
        // PHASE 12 (anti-enumeration closure) — every 404 (missing OR
        // concealed unauthorized) emits the ONE canonical public body so the
        // two cases stay byte-indistinguishable.
        if (statusCode === 404) {
          return reply.code(404).send(PUBLIC_NOT_FOUND_BODY);
        }
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

// PHASE 11 §3 Batch A — hoisted to function scope (unchanged lookup, just
// widened scope) so every audit call in this handler (including the later
// catch block) can read the AUTHORITATIVE persisted teamId.
let evidence: SelectedEvidence;
try {
  evidence = await getEvidenceWithRecordAccess(ownerUserId, id, "evidence.update_metadata");
  assertEvidenceNotLocked(evidence);
} catch (err) {
          const statusCode =
          err instanceof Error && "statusCode" in err
            ? (err as Error & { statusCode?: number }).statusCode ?? 500
            : 500;
        const message = err instanceof Error ? err.message : "Unexpected error";
        return reply.code(statusCode).send({ message });
      }

      // PHASE 10 §13.2 STEP 6 (2026-07-23) — NO-PERSONAL enforcement on FINALIZE.
      // Finalizing (`/complete`) PERSONAL-scope Evidence is a personal action: a
      // managed enterprise identity has no personal space, so deny BEFORE
      // `completeEvidence` runs any mutation (report/package/public-verify
      // pipeline). Personal scope = teamId null (legacy) OR the evidence's Team
      // is the owner's personal Team (`isPersonal`). TEAM evidence is governed by
      // the workspace policy gates below, not this check. Fails closed for
      // MANAGED + MANAGED_UNRESOLVED; a denial performs ZERO mutation (Personal
      // Evidence is never finalized, deleted, or transferred on denial).
      try {
        const scopeRow = await prisma.evidence.findUnique({
          where: { id },
          select: { teamId: true },
        });
        const scopeTeam = scopeRow?.teamId
          ? await prisma.team.findUnique({
              where: { id: scopeRow.teamId },
              select: { isPersonal: true },
            })
          : null;
        const isPersonalScoped =
          !scopeRow?.teamId || scopeTeam?.isPersonal === true;
        if (isPersonalScoped) {
          const { assertPersonalSpaceAllowed } = await import(
            "../services/identity/identity-mode.service.js"
          );
          await assertPersonalSpaceAllowed(ownerUserId);
        }
      } catch (err) {
        const e = err as { statusCode?: number; code?: string; message?: string };
        if (e.code === "MANAGED_IDENTITY_NO_PERSONAL_SPACE" || e.code === "SECURITY_SCHEMA_UNAVAILABLE") {
          return reply.code(e.statusCode ?? 403).send({
            code: e.code,
            message:
              e.message ??
              "Managed enterprise identities do not have a personal workspace.",
          });
        }
        throw err;
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
          teamId: evidence.teamId,
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
        // P0 remediation (2026-07-21) — ACTIVE-only membership authorizes.
        const membership = await prisma.teamMember.findUnique({
          where: {
            teamId_userId: {
              teamId: completionEvidence.teamId,
              userId: ownerUserId,
            },
          },
          select: { role: true, status: true },
        });
        const membershipRole =
          membership?.status === "ACTIVE" ? membership.role : undefined;
        const isReviewed = await evidenceIsReviewed(id);
        const reviewState = { isReviewed };

        for (const action of [
          "generate_report",
          "generate_package",
          "publish_public_verify",
        ] as const) {
          const decision = await enforceSensitiveAction(action, {
            teamId: completionEvidence.teamId,
            role: membershipRole,
            evidence: {
              id: completionEvidence.id,
              teamId: completionEvidence.teamId,
              retentionUntilUtc: completionEvidence.retentionUntilUtc ?? null,
            },
            reviewState,
            // Phase 5 — opt into the workflow template exportPolicy
            // overlay. The enforcer resolves the templateId itself
            // (fail-safe: a resolution failure leaves the workspace
            // decision unchanged) and applies the overlay only when
            // the workspace decision is already ALLOWED. The overlay
            // can ONLY tighten, never enable.
            consultTemplatePolicy: true,
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
            }).catch(noteCustodyFailure);
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

        // BILLING COMMERCIAL CORRECTNESS (2026-08-27) — THE DUPLICATE STORAGE
        // QUOTA AUTHORITY WAS DELETED HERE.
        //
        // This block ran `assertQuotaEntitlement(QUOTA_STORAGE_BYTES)` from
        // the packaging entitlement engine, whose unprovisioned default is
        // 1 GiB per calendar MONTH. The canonical authority is cumulative
        // capacity from `PLAN_CAPABILITIES.includedStorageBytes` plus active
        // storage add-ons — 500 GB on TEAM — enforced by
        // `assertWorkspaceStorageAvailable` on the same finalize path.
        //
        // A monthly byte budget and a cumulative capacity are not the same
        // quantity, so the two could never be reconciled; the stricter one
        // silently capped every shared workspace at 1 GiB a month regardless
        // of what it had bought. One authority now owns storage.

        await appendCustodyEvent({
  evidenceId: id,
  eventType: prismaPkg.CustodyEventType.EVIDENCE_COMPLETED,
  payload: {
    completedByUserId: ownerUserId,
    completedAtUtc: new Date().toISOString(),
  } as Prisma.InputJsonValue,
  ip: req.ip,
  userAgent: req.headers["user-agent"],
}).catch(noteCustodyFailure);

        // Initialize the EvidenceReviewWorkflow at NOT_STARTED so the
        // evidence shows up in the reviewer queue immediately on completion.
        // upsert is idempotent — replays / re-completions don't create duplicates.
        //
        // Phase T — read the canonical template-identity trio off the
        // Evidence row (which was stamped at create time on the capture
        // path). Thread it into the upsert so the workflow row carries
        // the same trio. Legacy evidence with NULL trio writes NULL
        // workflow trio — never throws.
        try {
          const evidenceForWorkflow = await prisma.evidence.findUnique({
            where: { id },
            select: {
              teamId: true,
              ownerUserId: true,
              templateSlug: true,
              templateVersion: true,
              templateDbId: true,
            },
          });
          if (evidenceForWorkflow) {
            // Phase T — build the trio defensively. We accept that any
            // field may be NULL (legacy evidence created before Phase T,
            // or direct uploads with no template attached). When all
            // three are NULL the upsert writes NULL columns and skips
            // the audit emission.
            let workflowTrio: TemplateIdentityTrio | null = null;
            try {
              workflowTrio = {
                templateSlug: evidenceForWorkflow.templateSlug ?? null,
                templateVersion: evidenceForWorkflow.templateVersion ?? null,
                templateDbId: evidenceForWorkflow.templateDbId ?? null,
              };
            } catch (trioReadErr) {
              req.log?.warn?.(
                { err: trioReadErr, evidenceId: id },
                "reviewer_workflow_trio_read_failed",
              );
              workflowTrio = {
                templateSlug: null,
                templateVersion: null,
                templateDbId: null,
              };
            }
            await upsertEvidenceReviewerWorkflow({
              evidenceId: id,
              workspaceType: evidenceForWorkflow.teamId ? "TEAM" : "PERSONAL",
              teamId: evidenceForWorkflow.teamId,
              actorUserId: ownerUserId,
              status: prismaPkg.EvidenceReviewWorkflowStatus.NOT_STARTED,
              priority: prismaPkg.EvidenceReviewWorkflowPriority.NORMAL,
              note: "Created automatically on Capture finalization.",
              templateIdentity: workflowTrio,
              templateIdentitySource: "capture",
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
          teamId: refreshed.teamId,
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
    teamId: evidence.teamId,
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
            teamId: evidence.teamId,
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
            teamId: evidence.teamId,
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
            teamId: evidence.teamId,
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
            teamId: lockedEvidence?.teamId ?? evidence.teamId,
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
          teamId: evidence.teamId,
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
        evidenceRecord = await getEvidenceWithRecordAccess(userId, id, "evidence.generate_report");
      } catch (err) {
        const statusCode =
          err instanceof Error && "statusCode" in err
            ? (err as Error & { statusCode?: number }).statusCode ?? 500
            : 500;
        const message = err instanceof Error ? err.message : "Unexpected error";
        return reply.code(statusCode).send({ message });
      }

      // Phase A0 — integrity hard-gate. A record whose recomputed
      // SHA-256 disagreed with the value stored at completion cannot
      // be re-promoted into a Report or Verification Package by
      // re-enqueueing. The owner-facing error is operationally
      // specific so the UI can render the re-capture path; the audit
      // row carries the failed-status reason.
      if (
        evidenceRecord.status ===
        prismaPkg.EvidenceStatus.FAILED_HASH_MISMATCH
      ) {
        auditEvidenceAction(req, {
          userId,
          action: "evidence.report.regenerate_requested",
          outcome: "blocked",
          resourceId: id,
          severity: "warning",
          teamId: evidenceRecord.teamId ?? null,
          metadata: {
            reason: "integrity_failed",
            evidenceStatus: evidenceRecord.status,
            evidenceTeamId: evidenceRecord.teamId ?? null,
          },
        });
        return reply.code(409).send({
          code: "EVIDENCE_INTEGRITY_FAILED",
          message:
            "Report regeneration is not available for this record. The recomputed SHA-256 fingerprint did not match the value recorded at completion. Re-upload or recapture the source material as a new evidence record.",
        });
      }

      // Enqueue with `forceRegenerate: true`. The enqueue helper
      // handles existing-job dedup; if an active job already exists it
      // returns `{ enqueued: false, reason }` and we surface that.
      // PHASE 12 — POINT 5. The ownership gate above IS the authorization for
      // a force-regeneration, and its outcome is now persisted on the request
      // row rather than asserted as a boolean on a queue message.
      let result: { enqueued: boolean; reason?: string };
      try {
        const requested = await requestReportGeneration({
          evidenceId: id,
          purpose: "operator_regenerate",
          forceRegenerate: true,
          regenerateReason: "operator_requested",
          requestedByUserId: userId,
        });
        result = requested.requested
          ? { enqueued: requested.enqueued, reason: requested.reason }
          : { enqueued: false, reason: requested.reason };
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
          teamId: evidenceRecord.teamId ?? null,
          metadata: { error: message },
        });
        return reply.code(500).send({ message });
      }

      auditEvidenceAction(req, {
        userId,
        action: "evidence.report.regenerate_requested",
        outcome: result.enqueued ? "success" : "blocked",
        resourceId: id,
        teamId: evidenceRecord.teamId ?? null,
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

      // Phase O1.5A — bounded evidence.report.latest span.
      await withProovraSpan(
        PROOVRA_SPAN_NAMES.EVIDENCE_REPORT_LATEST,
        {
          "proovra.evidence_id": id,
          "proovra.operation": "evidence_report_latest",
        },
        () => undefined,
      );

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
      let reportDownloadTeamId: string | null = null;
      {
        const evidenceForGate = await prisma.evidence.findUnique({
          where: { id },
          select: { id: true, teamId: true, retentionUntilUtc: true },
        });
        reportDownloadTeamId = evidenceForGate?.teamId ?? null;
        if (evidenceForGate?.teamId) {
          const { enforceSensitiveAction } = await import(
            "../services/governance.service.js"
          );
          // P0 remediation (2026-07-21) — ACTIVE-only membership authorizes.
          const membership = await prisma.teamMember.findUnique({
            where: {
              teamId_userId: {
                teamId: evidenceForGate.teamId,
                userId: ownerUserId,
              },
            },
            select: { role: true, status: true },
          });
          const decision = await enforceSensitiveAction("download_report", {
            teamId: evidenceForGate.teamId,
            role: membership?.status === "ACTIVE" ? membership.role : undefined,
            evidence: {
              id: evidenceForGate.id,
              teamId: evidenceForGate.teamId,
              retentionUntilUtc: evidenceForGate.retentionUntilUtc ?? null,
            },
            // Phase 5 — opt into the workflow template exportPolicy
            // overlay (workspace policy still governs first; the
            // template overlay can only tighten an allowed decision).
            consultTemplatePolicy: true,
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
            }).catch(noteCustodyFailure);
            return reply
              .code(decision.code === "GOVERNANCE_CHECK_FAILED" ? 503 : 403)
              .send({
                code: decision.code,
                reason: decision.reason,
                message:
                  "Report download is blocked by workspace governance policy.",
              });
          }

          // Phase 12 Point 4 — enforce the SAME export-eligibility
          // verdict the operator UI displays. `GovernedExportAction`
          // disables this button and shows "Blocked by legal hold /
          // lifecycle / destruction review" from
          // `GET /v1/governance/export-eligibility`; before this the
          // server did not consult that evaluation on the download
          // path, so a direct API call bypassed the gate the product
          // told the operator was in force. Fail-closed like the
          // policy gate above.
          const { checkExportEligibility } = await import(
            "../services/governance-lifecycle/export-governance.service.js"
          );
          const eligibility = await checkExportEligibility({
            teamId: evidenceForGate.teamId,
            evidenceId: evidenceForGate.id,
            actorUserId: ownerUserId,
          });
          if (eligibility.outcome !== "ALLOWED") {
            await appendCustodyEvent({
              evidenceId: id,
              eventType: prismaPkg.CustodyEventType.EXPORT_BLOCKED_BY_POLICY,
              payload: {
                action: "report_download",
                reason: eligibility.outcome,
                actorUserId: ownerUserId,
              },
              ip: req.ip,
              userAgent: req.headers["user-agent"],
            }).catch(noteCustodyFailure);
            return reply.code(403).send({
              code: eligibility.outcome,
              reason: eligibility.reason,
              message:
                "Report download is blocked by evidence export eligibility.",
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
      }).catch(noteCustodyFailure);

      auditEvidenceAction(req, {
        userId: ownerUserId,
        action: "evidence.report_viewed",
        outcome: "success",
        resourceId: id,
        teamId: reportDownloadTeamId,
        metadata: {
          reportVersion: latest.version,
        },
      });

      // Phase 5 (Enterprise Governance) — evidence-defensibility audit.
      // Record the report DOWNLOAD as a distinct, queryable admin audit
      // action (separate from the "report_viewed" access event above and
      // the REPORT_DOWNLOADED custody event). Best-effort / fail-safe:
      // auditEvidenceAction is void ...catch(), so an audit-write failure
      // never breaks the download. NO signed URL / key material recorded.
      auditEvidenceAction(req, {
        userId: ownerUserId,
        action: "evidence.report.downloaded",
        outcome: "success",
        resourceId: id,
        teamId: reportDownloadTeamId,
        metadata: {
          reportVersion: latest.version,
          ...(reportDownloadTeamId ? { teamId: reportDownloadTeamId } : {}),
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
        // P0 remediation (2026-07-21) — ACTIVE-only membership authorizes.
        const membership = await prisma.teamMember.findUnique({
          where: {
            teamId_userId: {
              teamId: evidence.teamId,
              userId: ownerUserId,
            },
          },
          select: { role: true, status: true },
        });
        const decision = await enforceSensitiveAction("download_original", {
          teamId: evidence.teamId,
          role: membership?.status === "ACTIVE" ? membership.role : undefined,
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
          }).catch(noteCustodyFailure);
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
      }).catch(noteCustodyFailure);

      auditEvidenceAction(req, {
        userId: ownerUserId,
        action: "evidence.downloaded",
        outcome: "success",
        resourceId: id,
        teamId: evidence.teamId,
        metadata: {
          accessMode: "original_presign",
        },
      });

      // Phase 5 (Enterprise Governance) — evidence-defensibility audit.
      // Record the original-file DOWNLOAD under the canonical dotted
      // download action string, alongside the pre-existing
      // "evidence.downloaded" event (kept for back-compat). Best-effort /
      // fail-safe: an audit-write failure never breaks the download. NO
      // presigned URL / key material is recorded.
      auditEvidenceAction(req, {
        userId: ownerUserId,
        action: "evidence.original.downloaded",
        outcome: "success",
        resourceId: id,
        teamId: evidence.teamId,
        metadata: {
          accessMode: "original_presign",
          ...(evidence.teamId ? { teamId: evidence.teamId } : {}),
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

      // Phase O1.5A — bounded evidence.package.status span.
      await withProovraSpan(
        PROOVRA_SPAN_NAMES.EVIDENCE_PACKAGE_STATUS,
        {
          "proovra.evidence_id": id,
          "proovra.operation": "evidence_package_status",
        },
        () => undefined,
      );

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
      let packageDownloadTeamId: string | null = null;
      {
        const evidenceForGate = await prisma.evidence.findUnique({
          where: { id },
          select: { id: true, teamId: true, retentionUntilUtc: true },
        });
        packageDownloadTeamId = evidenceForGate?.teamId ?? null;
        if (evidenceForGate?.teamId) {
          const { enforceSensitiveAction } = await import(
            "../services/governance.service.js"
          );
          // P0 remediation (2026-07-21) — ACTIVE-only membership authorizes.
          const membership = await prisma.teamMember.findUnique({
            where: {
              teamId_userId: {
                teamId: evidenceForGate.teamId,
                userId: ownerUserId,
              },
            },
            select: { role: true, status: true },
          });
          const decision = await enforceSensitiveAction("download_package", {
            teamId: evidenceForGate.teamId,
            role: membership?.status === "ACTIVE" ? membership.role : undefined,
            evidence: {
              id: evidenceForGate.id,
              teamId: evidenceForGate.teamId,
              retentionUntilUtc: evidenceForGate.retentionUntilUtc ?? null,
            },
            // Phase 5 — opt into the workflow template exportPolicy
            // overlay (workspace policy still governs first; the
            // template overlay can only tighten an allowed decision).
            consultTemplatePolicy: true,
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
            }).catch(noteCustodyFailure);
            return reply
              .code(decision.code === "GOVERNANCE_CHECK_FAILED" ? 503 : 403)
              .send({
                code: decision.code,
                reason: decision.reason,
                message:
                  "Verification package download is blocked by workspace governance policy.",
              });
          }

          // Phase 4A Closure — VERIFICATION policy gate. The Phase 4A
          // governance engine evaluates effective VERIFICATION policies
          // (e.g. requireDualApproval on package publish, public-verify
          // exposure rules) and BLOCKs publish/expose when the policy
          // denies. Distinct from the Phase 9.5 sensitive-action gate
          // above: the Phase 9.5 gate enforces role + retention; this
          // gate enforces the dedicated verification policy kind.
          const { gateVerificationAction } = await import(
            "../services/governance/policy-runtime-gates.service.js"
          );
          const verifyGate = await gateVerificationAction({
            teamId: evidenceForGate.teamId,
            evidenceId: evidenceForGate.id,
            action: "PUBLISH_PACKAGE",
          });
          if (!verifyGate.ok) {
            await appendCustodyEvent({
              evidenceId: id,
              eventType: prismaPkg.CustodyEventType.EXPORT_BLOCKED_BY_POLICY,
              payload: {
                action: "verification_package_publish_gate",
                denial: verifyGate.denial,
                reason: verifyGate.reason,
                actorUserId: ownerUserId,
              },
              ip: req.ip,
              userAgent: req.headers["user-agent"],
            }).catch(noteCustodyFailure);
            return reply.code(403).send({
              code: "VERIFICATION_POLICY_BLOCKED",
              denial: verifyGate.denial,
              reason: verifyGate.reason,
              message:
                "Verification package publish is blocked by workspace verification policy.",
            });
          }

          // Phase 12 Point 4 — enforce the SAME export-eligibility
          // verdict the operator UI displays for this button (legal
          // hold / lifecycle state / active destruction review). See
          // the matching block on `/report/latest`.
          const { checkExportEligibility } = await import(
            "../services/governance-lifecycle/export-governance.service.js"
          );
          const eligibility = await checkExportEligibility({
            teamId: evidenceForGate.teamId,
            evidenceId: evidenceForGate.id,
            actorUserId: ownerUserId,
          });
          if (eligibility.outcome !== "ALLOWED") {
            await appendCustodyEvent({
              evidenceId: id,
              eventType: prismaPkg.CustodyEventType.EXPORT_BLOCKED_BY_POLICY,
              payload: {
                action: "verification_package_download",
                reason: eligibility.outcome,
                actorUserId: ownerUserId,
              },
              ip: req.ip,
              userAgent: req.headers["user-agent"],
            }).catch(noteCustodyFailure);
            return reply.code(403).send({
              code: eligibility.outcome,
              reason: eligibility.reason,
              message:
                "Verification package download is blocked by evidence export eligibility.",
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
      }).catch(noteCustodyFailure);

      auditEvidenceAction(req, {
        userId: ownerUserId,
        action: "verification.package_accessed",
        outcome: "success",
        resourceId: id,
        teamId: packageDownloadTeamId,
        metadata: {
          packageKey: latest.storageKey,
          version: latest.version,
          packageType: latest.packageType ?? null,
        },
      });

      // Phase 5 (Enterprise Governance) — evidence-defensibility audit.
      // Record the verification-package DOWNLOAD as a distinct, queryable
      // admin audit action in the "evidence" category (separate from the
      // "verification.package_accessed" event above and the
      // VERIFICATION_PACKAGE_DOWNLOADED custody event). Best-effort /
      // fail-safe: an audit-write failure never breaks the download.
      // NO signed URL is recorded; storageKey is an internal object path,
      // not a secret / not a credentialed URL.
      auditEvidenceAction(req, {
        userId: ownerUserId,
        action: "evidence.verification_package.downloaded",
        outcome: "success",
        resourceId: id,
        teamId: packageDownloadTeamId,
        metadata: {
          version: latest.version,
          packageType: latest.packageType ?? null,
          ...(packageDownloadTeamId ? { teamId: packageDownloadTeamId } : {}),
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
        const evidence = await getEvidenceWithReadAccess(ownerUserId, id);
        const certifications = await listEvidenceCertifications(id);

        auditEvidenceAction(req, {
          userId: ownerUserId,
          action: "evidence.certifications_listed",
          outcome: "success",
          resourceId: id,
          teamId: evidence.teamId,
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
        const evidence = await getEvidenceWithRecordAccess(ownerUserId, id, "evidence.generate_report");

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
}).catch(noteCustodyFailure);
        auditEvidenceAction(req, {
          userId: ownerUserId,
action: "evidence.certification_requested",
          outcome: "success",
          resourceId: id,
          teamId: evidence.teamId,
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

  // The certification lifecycle is request -> attest -> revoke. The attest
  // step's service, request schema, custody event (CERTIFICATION_ATTESTED)
  // and report-renderer label all existed, but no route reached them, so no
  // certification could ever be signed. Mirrors the sibling routes exactly:
  // same auth preHandler, same record-access permission, same custody +
  // audit emission, same error projection.
  app.post(
    "/v1/evidence/:id/certifications/attest",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply) => {
      const ownerUserId = getAuthUserId(req);
      const id = z.string().uuid().parse((req.params as ParamsId).id);
      const body = AttestEvidenceCertificationBody.parse(req.body);

      (req as FastifyRequest & { evidenceId?: string }).evidenceId = id;
      req.log = req.log.child({ evidenceId: id });

      try {
        const evidence = await getEvidenceWithRecordAccess(ownerUserId, id, "evidence.generate_report");

        const certification = await attestEvidenceCertification({
          evidenceId: id,
          declarationType: body.declarationType,
          attestedByUserId: ownerUserId,
          attestorName: body.attestorName,
          attestorTitle: body.attestorTitle,
          attestorEmail: body.attestorEmail,
          attestorOrganization: body.attestorOrganization ?? null,
          statementMarkdown: body.statementMarkdown,
          statementSnapshot: body.statementSnapshot ?? null,
          signatureText: body.signatureText,
        });

        void appendCustodyEvent({
          evidenceId: id,
          eventType: prismaPkg.CustodyEventType.CERTIFICATION_ATTESTED,
          payload: {
            declarationType: body.declarationType,
            attestedByUserId: ownerUserId,
            version: certification.version,
          } as Prisma.InputJsonValue,
          ip: req.ip,
          userAgent: req.headers["user-agent"],
        }).catch(noteCustodyFailure);

        auditEvidenceAction(req, {
          userId: ownerUserId,
          action: "evidence.certification_attested",
          outcome: "success",
          resourceId: id,
          teamId: evidence.teamId,
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
        const evidence = await getEvidenceWithRecordAccess(ownerUserId, id, "evidence.generate_report");

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
        }).catch(noteCustodyFailure);

        auditEvidenceAction(req, {
          userId: ownerUserId,
          action: "evidence.certification_revoked",
          outcome: "success",
          resourceId: id,
          teamId: evidence.teamId,
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
    // Phase O1.5A — bounded evidence.verify.public span. NEVER the
    // requesting IP or the user agent (PII-adjacent). Bounded
    // attribute set only.
    await withProovraSpan(
      PROOVRA_SPAN_NAMES.EVIDENCE_VERIFY_PUBLIC,
      { "proovra.operation": "evidence_verify_public" },
      () => undefined,
    );
    // Phase 1 — two-layer rate limit. Both buckets must allow.
    //   Layer 1 (per-IP): defends against scraping the UUID space.
    //   Layer 2 (per-evidence-id): defends against rotating-IP /
    //     proxy enumeration of a single record's verify history.
    // Both buckets are observable via the `verification.page_opened`
    // audit + the new `public_verify.rate_limited` warn log so an
    // operator can detect coordinated abuse.
    const limit = getVerifyLimit();
    // PHASE 13 §1 (NEW-022) — SECURITY_BOUND: key on the canonical resolved
    // client, not raw `req.ip`, so a forwarded header cannot mint fresh buckets
    // for this public verify surface.
    const ipKey = `ratelimit:verify:ip:${trustedClientIpKey(req)}`;
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
        outcome: "denied",
        denialReason: "rate_limited",
        resourceId: null,
        metadata: { outcome: "rate_limited", bucket: "ip" },
      });
      reply.header("Retry-After", String(retryAfter));
      return reply
        .code(429)
        .send({ code: "RATE_LIMITED", message: "Rate limit exceeded" });
    }

    // PHASE 12 (anti-enumeration closure) — an INVALID-format token must be
    // byte-indistinguishable from a valid-format-but-missing one. The prior
    // `.parse` threw Zod → global 400, revealing token-format validity to an
    // enumerating caller (caught live by the phase-37-95 runtime probe).
    const idParse = z.string().uuid().safeParse((req.params as ParamsId).id);
    if (!idParse.success) {
      return reply.code(404).send({ message: "Evidence not found" });
    }
    const id = idParse.data;

    // Phase 1 — second bucket, keyed by evidence id. We parse the id
    // FIRST (above) so the bucket key is only set after validation;
    // unparseable input is concealed as 404 without consuming a
    // rate-limit slot.
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
        outcome: "denied",
        denialReason: "rate_limited",
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
      // EVIDENCE LIFECYCLE CONVERGENCE (2026-08-24) — the gate is the LIFECYCLE
      // STATE, not the trash timestamp. `deleted_at IS NULL` happened to
      // exclude trashed records, but it did so by reading a trash timestamp as
      // a publication decision, and it did NOT exclude a DESTROYED tombstone —
      // whose `deleted_at` is non-null only because it passed through the trash
      // on the way, and which would otherwise have kept serving a public verify
      // page for evidence that no longer exists.
      where: { id, lifecycleState: { notIn: ["TRASHED", "DESTROYED"] } },
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
        locationSource: true,
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
        outcome: "denied",
        denialReason: "publication_not_available",
        resourceId: id,
        teamId: evidence.teamId,
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

      // Phase A0 — integrity hard-gate. A record whose recomputed
      // SHA-256 disagreed with the value stored at completion is
      // terminal-FAILED_HASH_MISMATCH. Public verify MUST return 404
      // with NO body fields beyond the generic "not found" message
      // — anti-enumeration. The audit row records the real outcome
      // (`integrity_failed`) so the operator surface can count
      // suppressed lookups, but the wire response is indistinguishable
      // from a missing record.
      if (
        evidenceStatus === prismaPkg.EvidenceStatus.FAILED_HASH_MISMATCH
      ) {
        auditVerificationAction(req, {
          userId: null,
          action: "verification.page_opened",
          outcome: "denied",
          denialReason: "integrity_failed",
          resourceId: id,
          teamId: evidence.teamId,
          metadata: {
            outcome: "integrity_failed",
            status: evidenceStatus,
          },
        });
        return reply.code(404).send({ message: "Evidence not found" });
      }

      // Phase G1 — destroyed-evidence anti-enumeration gate. When an
      // evidence record has been operationally destroyed (Phase F
      // destruction review → EXECUTED), the lifecycle state moves to
      // `DESTROYED`. Public verify MUST return 404 with no body
      // fields beyond the generic "not found" — the destruction
      // certificate persists on the operator-internal lifecycle
      // ledger, but no part of that state leaks to unauthenticated
      // callers. The audit row records the suppressed outcome so the
      // operator surface can count destroyed-state lookups.
      const lifecycleState = (evidence as { lifecycleState?: string | null })
        .lifecycleState;
      if (lifecycleState === "DESTROYED") {
        auditVerificationAction(req, {
          userId: null,
          action: "verification.page_opened",
          outcome: "denied",
          denialReason: "lifecycle_destroyed",
          resourceId: id,
          teamId: evidence.teamId,
          metadata: {
            outcome: "lifecycle_destroyed",
            status: evidenceStatus ?? null,
          },
        });
        return reply.code(404).send({ message: "Evidence not found" });
      }

      const isFinalized =
        evidenceStatus === EvidenceStatus.SIGNED ||
        evidenceStatus === EvidenceStatus.REPORTED;
      if (!isFinalized) {
        auditVerificationAction(req, {
          userId: null,
          action: "verification.page_opened",
          outcome: "denied",
          denialReason: "not_finalized",
          resourceId: id,
          teamId: evidence.teamId,
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
        outcome: "error",
        resourceId: id,
        teamId: evidence.teamId,
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
    pdfSignatureStatus: true,
    pdfSignedAtUtc: true,
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
          provider: anchor.provider,
          anchoredAtUtc: anchor.anchoredAtUtc,
          transactionId: anchor.transactionId,
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
      //
      // Phase A3 — additionally, append a DEBOUNCED `VERIFY_VIEWED`
      // custody event so the forensic timeline records that the
      // evidence was publicly viewed at all, WITHOUT spamming the
      // chain on refresh storms. Debounce: at most one VERIFY_VIEWED
      // per evidence per 24h. The previous `lastPublicVerifyViewAtUtc`
      // value is the natural debounce gate. The payload is bounded
      // (no IP, no user agent, no fingerprinting) so the privacy
      // posture stays clean.
      const viewerUserAgent = readUserAgent(req);
      const viewerIp = req.ip;
      const previousPublicViewAt = evidence.lastPublicVerifyViewAtUtc ?? null;
      const debounceMs = 24 * 60 * 60 * 1000;
      const shouldEmitVerifyViewed =
        previousPublicViewAt === null ||
        verifiedAt.getTime() - previousPublicViewAt.getTime() >= debounceMs;
      const authedUserId =
        (req as FastifyRequest & { user?: { sub?: string } }).user?.sub ??
        null;
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

        // Phase A3 — debounced VERIFY_VIEWED custody event. Append
        // ONLY when we're outside the debounce window. The bump
        // metric distinguishes emit vs debounce so dashboards see
        // both signals.
        try {
          const mod = await import("@proovra/shared-runtime/ops");
          if (shouldEmitVerifyViewed) {
            await appendCustodyEvent({
              evidenceId: id,
              eventType: prismaPkg.CustodyEventType.VERIFY_VIEWED,
              payload: {
                visibility: "public_verify",
                viewerType: authedUserId ? "authenticated" : "anonymous",
                source: "public_verify_page",
                viewedAtUtc: verifiedAt.toISOString(),
              } satisfies prismaPkg.Prisma.InputJsonValue,
            });
            mod.bump("public_verify_viewed_emitted_total");
          } else {
            mod.bump("public_verify_viewed_debounced_total");
          }
        } catch (custodyErr) {
          // Custody append is best-effort; never breaks the verify
          // response. Bounded log only.
          req.log.warn(
            {
              evidenceId: id,
              err:
                custodyErr instanceof Error
                  ? custodyErr.message.slice(0, 200)
                  : String(custodyErr).slice(0, 200),
              surface: "verify_viewed_custody_append",
            },
            "public_verify.custody_append_failed",
          );
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
      outcome: "success",
      resourceId: id,
      teamId: evidence.teamId,
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

const { verificationSnapshot, liveAnchoring } =
  buildPublicVerifyConsistencySections({
    source: trustDecisionConsistencySource,
    trustDecisionSnapshot: snapshotTrustDecision,
    latestReport,
    latestVerificationPackage,
    verificationPackageIntegrity,
    currentOtsStatus: effectiveOtsStatus,
    otsAnchoredAtUtc: effectiveOtsAnchoredAtUtc?.toISOString() ?? null,
    otsBitcoinTxid: evidence.otsBitcoinTxid ?? null,
    otsUpgradedAtUtc: evidence.otsUpgradedAtUtc
      ? evidence.otsUpgradedAtUtc.toISOString()
      : null,
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
      source: evidenceLocationSourceLabel(evidence.locationSource),
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

// Phase 1B Closure — bounded capture-trust projection for the public
// verify response. Returns null when there's nothing surfaceable
// (legacy non-trust artifact); the verify page already handles null.
// Workspace-anchored via teamId so cross-tenant leaks are impossible.
const captureTrust = evidence.teamId
  ? await (async () => {
      try {
        const { projectVerifyCaptureTrust } = await import(
          "../services/capture-trust/verify-trust-projection.service.js"
        );
        return await projectVerifyCaptureTrust({
          teamId: evidence.teamId!,
          evidenceId: evidence.id,
        });
      } catch {
        return null;
      }
    })()
  : null;

// PHASE 12B (Evidence Operations) — bounded public-safe redaction
// projection. This is the CANONICAL public home of the redaction
// verification badge: the anonymous evidenceId probe
// GET /v1/redaction/public/verify/:evidenceId was deleted and its
// fields converged here, behind this route's rate limits, publication
// gate, integrity gate, destroyed gate, finalization gate, and audit.
// Workspace-anchored via teamId. Never throws; null when the record
// has no redaction project and no extracted video frames.
const redaction = await (async () => {
  try {
    const { projectVerifyRedaction } = await import(
      "../services/redaction/verify-redaction-projection.service.js"
    );
    return await projectVerifyRedaction({
      teamId: evidence.teamId ?? null,
      evidenceId: evidence.id,
    });
  } catch {
    return null;
  }
})();

// Enterprise Technical Metadata layer — privacy-safe Media / EXIF /
// Capture Environment projection. Never throws; null when no data.
const technicalMetadata = await (async () => {
  try {
    const { projectVerifyTechnicalMetadata } = await import(
      "../services/technical-metadata/verify-projection.service.js"
    );
    return await projectVerifyTechnicalMetadata({
      teamId: evidence.teamId ?? null,
      evidenceId: evidence.id,
    });
  } catch {
    return null;
  }
})();

return reply.code(200).send({
  evidenceId: evidence.id,
  mediaIntelligenceAdvisory,
  captureTrust,
  // PHASE 12B — redaction verification badge (converged from the
  // deleted anonymous /v1/redaction/public/verify/:evidenceId probe).
  redaction,
  technicalMetadata,
  trustDecision,
trustDecisionConsistency,
  verificationSnapshot,
  liveAnchoring,
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
// Phase 2 — canonical OutputContext shape. The public verify
// endpoint is a PUBLIC_VERIFY_LIVE output; the snapshot-vs-live
// distinction is explicit in this field so Phase 3 UI can render
// "Verdict source: REPORT_SNAPSHOT (as of …)" cleanly without
// re-deriving the semantics in the page.
// Live-delta materials are the categories that may have advanced
// since the sealed snapshot — custody chain (append-only) and OTS
// anchoring (live-updating-after-snapshot).
outputContext: ((): CanonicalOutputContext => {
  const snapshotGen =
    latestReport?.generatedAtUtc?.toISOString() ??
    latestVerificationPackage?.generatedAtUtc?.toISOString() ??
    null;
  return {
    outputType: "PUBLIC_VERIFY_LIVE",
    isSnapshotOutput: false,
    isLiveOutput: true,
    snapshotGeneratedAtUtc: snapshotGen,
    liveObservedAtUtc: new Date().toISOString(),
    liveDeltaMaterials: ["custodyChain", "otsAnchoring"],
    legalBoundary: buildCanonicalLegalBoundaryMaterial()
      .publicVerifyBoundary,
  };
})(),
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
