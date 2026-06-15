import type { EvidenceIntelligence } from "@proovra/shared";
import type {
  BillingOverviewResponse,
  PersonalWorkspaceSummary,
  TeamWorkspaceSummary,
} from "../../../../components/billing/types";

export type EvidenceListScope = "active" | "archived" | "deleted" | "locked";

export type SavedViewFilters = {
  search: string;
  scope: EvidenceListScope;
  status: string;
  type: string;
  review: string;
  exportReadiness: string;
  caseAssignment: string;
  retention: string;
  sort: string;
};

export type EvidenceListQuery = {
  scope: EvidenceListScope;
  limit: number;
  cursor?: string | null;
  search?: string;
  status?: string;
  type?: string;
  caseAssignment?: "all" | "assigned" | "unassigned";
  caseId?: string;
  reportReady?: "all" | "ready" | "missing";
  /** Phase HOME-PROOF / HOME-CLOSURE — trust signal filters (single
   * value or comma-separated list). */
  tsaStatus?: string;
  otsStatus?: string;
  publicVerifyState?: string;
  verificationStatus?: string;
  sort?: "newest" | "oldest" | "priority";
};

export type EvidenceListPageInfo = {
  limit: number;
  nextCursor: string | null;
  hasMore: boolean;
};

export type StorageProtectionSummary = {
  immutable: boolean;
  mode: string | null;
  retainUntil: string | null;
  legalHold: string | null;
  region: string | null;
  verified: boolean;
} | null;

export type AnchorSummary = {
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

export type EvidenceListItem = {
  id: string;
  title: string;
  type: string;
  mimeType: string | null;
  primaryKind?: string | null;
  previewable?: boolean;
  status: string;
  statusLabel?: string;
  verificationStatus: string | null;
  verificationStatusLabel?: string;
  captureMethod: string | null;
  captureMethodLabel?: string;
  identityLevel: string | null;
  identityLevelLabel?: string;
  submittedByEmail: string | null;
  latestReportVersion: number | null;
  originalFileName: string | null;
  displayFileName: string | null;
  reviewReadyAtUtc: string | null;
  createdAt: string;
  archivedAt: string | null;
  deletedAt: string | null;
  deleteScheduledForUtc: string | null;
  caseId: string | null;
  teamId: string | null;
  ownerUserId: string;
  itemCount: number;
  storage: StorageProtectionSummary;
  reviewWorkflow?: {
    status: string;
    priority: string;
    dueAt: string | null;
    assignedTo: {
      id: string;
      email: string | null;
      displayName: string | null;
    } | null;
  } | null;
  displaySubtitle: string;
};

export type EvidenceListResponse = {
  scope?: EvidenceListScope;
  items?: EvidenceListItem[];
  pageInfo?: EvidenceListPageInfo;
  totalCount?: number;
};

/**
 * Phase EVIDENCE-LIBRARY-DATA-ACCURACY — workspace-scoped totals
 * returned by `GET /v1/evidence/library-summary`. Used by the
 * Evidence Library metric cards to render real workspace counts
 * with honest "Workspace total" / "On this page" labels.
 *
 * Package readiness is computed from the REAL `verificationPackages`
 * relation (NOT the `latestReportVersion` proxy). When this endpoint
 * is unavailable the UI shows "Package readiness unavailable" for the
 * packages metric — it never falls back to the proxy silently.
 */
export type EvidenceLibrarySummaryResponse = {
  scope?: EvidenceListScope;
  source: "workspace_total";
  totalActiveRecords: number;
  reportsReadyCount: number;
  packagesReadyCount: number;
  packagesMissingCount: number;
  storageProtectedCount: number;
  storageNeedsReviewCount: number;
  multipartCount: number;
  verificationIssuesCount: number;
  unassignedCount: number;
  needsActionCount: number;
};

export type CaseOption = {
  id: string;
  name: string;
  ownerUserId?: string;
  teamId?: string | null;
};

export type CasesListResponse = {
  items?: CaseOption[];
};

export type EvidenceSavedView = {
  id: string;
  ownerUserId: string;
  teamId: string | null;
  name: string;
  description: string | null;
  filters: SavedViewFilters;
  sortKey: string | null;
  scope: EvidenceListScope;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
};

export type EvidenceSavedViewsResponse = {
  items?: EvidenceSavedView[];
  savedView?: EvidenceSavedView;
};

export type EvidenceContentItem = {
  id: string;
  index: number;
  label: string;
  originalFileName?: string | null;
  mimeType?: string | null;
  kind: "image" | "video" | "audio" | "pdf" | "text" | "other";
  sizeBytes?: string | null;
  durationMs?: number | null;
  sha256?: string | null;
  isPrimary: boolean;
  artifactRole?: "primary_evidence" | "supporting_evidence" | "attachment" | null;
  artifactRoleLabel?: string | null;
  artifactRoleSource?: string | null;
  checklistStepId?: string | null;
  checklistStepLabel?: string | null;
  sourceLabel?: string | null;
  previewable: boolean;
  downloadable: boolean;
  viewUrl?: string | null;
  displaySizeLabel?: string | null;
  previewRole?: "primary_preview" | "secondary_preview" | "download_only" | "metadata_only";
};

export type EvidenceContentSummary = {
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
  primaryKind: "image" | "video" | "audio" | "pdf" | "text" | "other" | null;
  primaryMimeType: string | null;
  totalSizeBytes: string | null;
  totalSizeDisplay: string | null;
};

export type EvidenceRecord = {
  id: string;
  title: string;
  originalFileName: string | null;
  displayFileName: string | null;
  displayTitle?: string | null;
  displaySubtitle?: string | null;
  displayDescription?: string | null;
  internalNotes: string | null;
  intakePlanJson: Record<string, unknown> | null;
  type: string;
  status: string;
  verificationStatus: string | null;
  captureMethod: string | null;
  identityLevelSnapshot: string | null;
  submittedByEmail: string | null;
  submittedByAuthProvider: string | null;
  createdByUserId: string | null;
  uploadedByUserId: string | null;
  workspaceNameSnapshot: string | null;
  organizationNameSnapshot: string | null;
  organizationVerifiedSnapshot: boolean | null;
  recordedIntegrityVerifiedAtUtc: string | null;
  lastVerifiedAtUtc: string | null;
  lastVerifiedSource: string | null;
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
  retentionUntilUtc: string | null;
  lockedAt: string | null;
  archivedAt: string | null;
  caseId: string | null;
  teamId: string | null;
  deletedAt: string | null;
  deleteScheduledForUtc: string | null;
  itemCount: number;
  storage: StorageProtectionSummary;
  anchor: AnchorSummary | null;
  contentAccessPolicy?: {
    mode?: "metadata_only" | "preview_only" | "full_access";
    allowContentView?: boolean;
    allowDownload?: boolean;
  } | null;
  contentCompositionSummary?: string | null;
  primaryContentLabel?: string | null;
  defaultPreviewItemId?: string | null;
  contentSummary?: EvidenceContentSummary | null;
  contentItems?: EvidenceContentItem[] | null;
  primaryContentItem?: EvidenceContentItem | null;
  previewPolicy?: {
    contentVisible?: boolean;
    previewEnabled?: boolean;
    downloadableFromVerify?: boolean;
    rationale?: string | null;
    privacyNotice?: string | null;
  } | null;
  evidenceIntelligence?: EvidenceIntelligence | null;
  /**
   * Phase EVIDENCE-DELETE-ELIGIBILITY — additive, read-only.
   * Computed server-side from the existing retention columns + the
   * EvidenceLegalHold table. The UI prefers this over its
   * client-side mirror because it includes the legal-hold lookup
   * that lives outside the evidence row. Optional for back-compat
   * with any client that hits an older API build.
   */
  deleteEligibility?: EvidenceDeleteEligibility | null;
};

/**
 * Phase EVIDENCE-DELETE-ELIGIBILITY — shape mirrors the backend
 * type in services/api/src/services/evidence/evidence-delete-eligibility.service.ts.
 * Source-pinned contract tests assert the two stay in lockstep.
 */
export type EvidenceDeleteReasonCode =
  | "COMPLIANCE_RETENTION"
  | "LEGAL_HOLD"
  | "RETENTION_UNTIL"
  | "EVIDENCE_LOCKED"
  | "ALREADY_DELETED"
  | "UNKNOWN";

export type EvidenceDeleteEligibility = {
  canMoveToTrash: boolean;
  reasonCode: EvidenceDeleteReasonCode | null;
  blockedUntil: string | null;
  message: string;
};

export type EvidenceResponse = {
  evidence?: EvidenceRecord;
};

export type EvidencePart = {
  id: string;
  partIndex: number;
  originalFileName?: string | null;
  mimeType?: string | null;
  sizeBytes?: string | null;
  sha256?: string | null;
  durationMs?: number | null;
  privateRole?: string | null;
  privateNote?: string | null;
  checklistStepId?: string | null;
  sourceLabel?: string | null;
  clientSignals?: Record<string, unknown> | null;
  url?: string | null;
  publicUrl?: string | null;
  previewUrl?: string | null;
  kind?: "image" | "video" | "audio" | "pdf" | "text" | "other";
  previewable?: boolean;
  label?: string | null;
  displayName?: string | null;
  displaySizeLabel?: string | null;
  isPrimary?: boolean;
  storage?: StorageProtectionSummary;
  capturedAt?: string | null;
  createdAt?: string | null;
};

export type PartsResponse = {
  evidenceId?: string;
  multipart?: boolean;
  primary?: {
    bucket?: string | null;
    key?: string | null;
  } | null;
  parts?: EvidencePart[];
};

export type OriginalResponse = {
  evidenceId?: string;
  bucket?: string | null;
  key?: string | null;
  originalFileName?: string | null;
  displayName?: string | null;
  url?: string | null;
  publicUrl?: string | null;
  previewUrl?: string | null;
  mimeType?: string | null;
  kind?: "image" | "video" | "audio" | "pdf" | "text" | "other";
  previewable?: boolean;
  sizeBytes?: string | null;
  displaySizeLabel?: string | null;
  lastAccessedAtUtc?: string | null;
  storage?: StorageProtectionSummary;
};

export type ReportResponse = {
  evidenceId?: string;
  version?: number | null;
  url?: string | null;
  generatedAtUtc?: string | null;
  // Phase A2 — bounded PDF artifact signature projection. NULL on
  // legacy reports that pre-date A2 columns. The UI MUST render the
  // signed badge ONLY when `pdfSignature.status === "SIGNED"`. Any
  // other value is rendered as an explicit unsigned artifact.
  pdfSignature?: {
    status:
      | "SIGNED"
      | "UNSIGNED_OPT_OUT"
      | "SIGNING_UNAVAILABLE"
      | "SIGNING_FAILED"
      | "NOT_APPLICABLE";
    signedAtUtc: string | null;
    signerKeyId: string | null;
    warning: string | null;
  } | null;
};

export type VerificationPackageResponse = {
  evidenceId?: string;
  version?: number | null;
  packageType?: string | null;
  key?: string | null;
  url?: string | null;
  generatedAtUtc?: string | null;
  storage?: StorageProtectionSummary;
  trustDecision?: unknown;
  // Phase A2 — Verification Package manifest signature. Distinct
  // from the Report PDF signature. Today the worker always signs
  // the manifest; the union reserves UNSIGNED for a future opt-out.
  manifestSignature?: {
    status: "SIGNED" | "UNSIGNED" | "NOT_APPLICABLE";
    signerKeyId: string | null;
  } | null;
};

export type CollaborativeAuthor = {
  id: string;
  displayName: string | null;
  email: string | null;
};

export type ReviewerComment = {
  id: string;
  evidenceId: string;
  visibility: "INTERNAL" | "TEAM";
  body: string;
  createdAt: string;
  updatedAt: string;
  edited: boolean;
  author: CollaborativeAuthor;
};

export type ReviewerCommentsResponse = {
  items?: ReviewerComment[];
  comment?: ReviewerComment;
};

export type LegalNote = {
  id: string;
  evidenceId: string;
  noteType: "GENERAL" | "PRIVILEGED" | "DISCLOSURE" | "REVIEW_BOUNDARY" | "HANDOFF";
  body: string;
  createdAt: string;
  updatedAt: string;
  edited: boolean;
  author: CollaborativeAuthor;
};

export type LegalNotesResponse = {
  items?: LegalNote[];
  legalNote?: LegalNote;
};

export type EvidenceAnnotation = {
  id: string;
  evidenceId: string;
  evidencePartId: string | null;
  annotationType: "POINT" | "BOX" | "REGION" | "TIMESTAMP" | "TEXT";
  body: string | null;
  pageNumber: number | null;
  mediaTimestampMs: number | null;
  x: number | null;
  y: number | null;
  width: number | null;
  height: number | null;
  coordinateSpace: "NORMALIZED" | "PIXEL" | "TIME_ONLY" | "DOCUMENT_PAGE";
  createdAt: string;
  updatedAt: string;
  edited: boolean;
  author: CollaborativeAuthor;
};

export type EvidenceAnnotationsResponse = {
  items?: EvidenceAnnotation[];
  annotation?: EvidenceAnnotation;
};

export type EvidenceComparisonResponse = {
  evidenceId?: string;
  original?: Record<string, unknown> | null;
  previewRepresentation?: Record<string, unknown> | null;
  reportArtifact?: Record<string, unknown> | null;
  verificationPackage?: Record<string, unknown> | null;
  contentItems?: Array<Record<string, unknown>>;
  mismatchFlags?: Record<string, unknown> | null;
};

// Phase EVIDENCE-DUPLICATES-GROUPING — the duplicates endpoint
// returns a deduped, grouped view in addition to the legacy four
// per-category arrays. The grouped variant is the one the UI now
// consumes; the legacy arrays stay in the type for back-compat.
export type EvidenceDuplicateMatchReason =
  | "exact_hash"
  | "fingerprint"
  | "part_hash"
  | "metadata";

export type EvidenceDuplicateGroupedMatch = {
  evidenceId: string;
  /**
   * The raw `evidence.title` column WITHOUT the backend's
   * "Digital Evidence Record" fallback. Null when the column is
   * empty so the UI cascade can fall through to displayFileName /
   * originalFileName / type label.
   */
  rawTitle: string | null;
  displayFileName: string | null;
  originalFileName: string | null;
  type: string;
  mimeType: string | null;
  itemCount: number;
  createdAt: string;
  matchReasons: EvidenceDuplicateMatchReason[];
  /** ≥0 — how many part-level hashes matched this record. */
  matchedPartsCount: number;
};

export type EvidenceDuplicatesResponse = {
  exactHashMatches?: EvidenceListItem[];
  fingerprintMatches?: EvidenceListItem[];
  partHashMatches?: EvidenceListItem[];
  possibleMetadataMatches?: EvidenceListItem[];
  groupedMatches?: EvidenceDuplicateGroupedMatch[];
  totalRecords?: number;
  limitation?: string;
};

export type EvidenceBulkAction =
  | "ADD_TO_CASE"
  | "REMOVE_FROM_CASE"
  | "ARCHIVE"
  | "RESTORE_ARCHIVED"
  | "TRASH"
  | "RESTORE_TRASH"
  | "EXPORT_METADATA_CSV";

export type EvidenceBulkActionResult = {
  evidenceId: string;
  ok: boolean;
  reason?: string;
};

export type EvidenceBulkActionResponse = {
  successCount: number;
  failedCount: number;
  results: EvidenceBulkActionResult[];
  items?: EvidenceListItem[];
  csv?: string;
  fileName?: string;
};

export type EvidenceAiCategorization = {
  status: "DISABLED" | "PENDING" | "COMPLETED" | "FAILED";
  summary: string | null;
  categories: string[];
  suggestedTags: string[];
  riskFlags: Array<{ severity: string; title: string; detail: string }>;
  legalDisclaimer: string;
  model: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  nextActions?: string[];
};

export type EvidenceAiCategorizationResponse = {
  categorization?: EvidenceAiCategorization;
};

export type WorkspaceCapabilitySnapshot = {
  workspaceType: "PERSONAL" | "TEAM";
  workspaceName: string;
  plan: string;
  reportsIncluded: boolean;
  verificationPackageIncluded: boolean;
  publicVerifyIncluded: boolean;
};

export type DetailWorkspaceState = {
  evidence: EvidenceRecord | null;
  parts: EvidencePart[];
  original: OriginalResponse | null;
  report: ReportResponse | null;
  verificationPackage: VerificationPackageResponse | null;
  capabilities: WorkspaceCapabilitySnapshot;
  caseName: string | null;
};

export type LibraryLoadState = {
  billingOverview: BillingOverviewResponse | null;
  personalWorkspace: PersonalWorkspaceSummary | null;
  teamWorkspaces: TeamWorkspaceSummary[];
  cases: CaseOption[];
  savedViews: EvidenceSavedView[];
  items: EvidenceListItem[];
  pageInfo: EvidenceListPageInfo | null;
  totalCount?: number;
};

export type ReviewAlertSeverity = "critical" | "operational" | "informational";

export type ReviewAlert = {
  severity: ReviewAlertSeverity;
  label: string;
  detail: string;
};
