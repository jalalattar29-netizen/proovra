import type { EvidenceIntelligence } from "@proovra/shared";

/**
 * Library scopes.
 *
 * `trash` replaced `deleted`. The old name described an operation the scope
 * never performed: nothing in it has been deleted, every record is physically
 * present in storage, and every record is restorable. Physical destruction is a
 * separate, governed pipeline whose results are tombstones and do not appear in
 * any regular library scope.
 */
export type EvidenceListScope = "active" | "archived" | "trash" | "locked";

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
  configured: boolean;
  anchorHash: string | null;
  transactionId: string | null;
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
  reportReady?: boolean;
  originalFileName: string | null;
  displayFileName: string | null;
  reviewReadyAtUtc: string | null;
  createdAt: string;
  /**
   * THE canonical lifecycle projection for this row — the same shape the detail
   * response carries, so a row and the page it opens cannot disagree.
   *
   * The row variant resolves legal hold from the Object Lock column rather than
   * the union evaluator (a list of 50 rows cannot afford 50 hold lookups), so
   * treat it as a display hint: every write re-resolves the hold properly, and
   * the worst case is an action offered and then refused.
   */
  lifecycle?: EvidenceLifecycleProjection | null;
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
  /**
   * THE canonical lifecycle projection. Present on both list rows and the
   * detail response; the ONE thing any surface reads to decide which lifecycle
   * actions to offer.
   */
  lifecycle?: EvidenceLifecycleProjection | null;
};

/**
 * THE canonical lifecycle projection, as it arrives on the wire.
 *
 * Re-declared here rather than imported from `@proovra/shared` because this
 * module is the browser's view of an API RESPONSE, and a response shape is a
 * contract that should break loudly if the server changes it — a structural
 * import would silently absorb a rename. A source-pinned contract test asserts
 * this stays field-for-field identical to `EvidenceLifecycleProjection`.
 *
 * Every field is a RESULT. Nothing here lets a client re-derive a verdict.
 */
export type EvidenceLifecycleProjection = {
  productState: "ACTIVE" | "ARCHIVED" | "TRASHED" | "DESTROYED";
  canArchive: boolean;
  canUnarchive: boolean;
  canTrash: boolean;
  canRestoreFromTrash: boolean;
  trashBlockReason: EvidenceLifecycleBlockReason | null;
  archiveBlockReason: EvidenceLifecycleBlockReason | null;
  trashGraceUntilUtc: string | null;
  appRetentionUntilUtc: string | null;
  objectLockRetainUntilUtc: string | null;
  effectiveRetentionUntilUtc: string | null;
  objectLockCompliance: boolean;
  legalHold: boolean;
  destructionEligibleAtUtc: string | null;
  destructionBlockReason: EvidenceLifecycleBlockReason | null;
};

export type EvidenceLifecycleBlockReason =
  | "ALREADY_IN_STATE"
  | "EVIDENCE_LOCKED"
  | "TERMINAL_DESTROYED"
  | "NOT_TRASHED"
  | "TRASH_GRACE_ACTIVE"
  | "APP_RETENTION_ACTIVE"
  | "OBJECT_LOCK_RETENTION_ACTIVE"
  | "LEGAL_HOLD_ACTIVE"
  | "DESTRUCTION_APPROVAL_REQUIRED";

/**
 * LEGACY delete-eligibility shape. Still emitted by the API, still read as a
 * fallback, but derived server-side FROM the projection above rather than
 * computed beside it. `COMPLIANCE_RETENTION` and `RETENTION_UNTIL` remain in
 * the union for wire compatibility and are now unreachable: no retention
 * deadline blocks a recoverable move to trash.
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
  /**
   * An ACCEPTED-but-not-finished answer. The synchronous route never sets
   * these; a queued backend does, and the difference matters — "accepted"
   * must never be reported to the operator as "completed".
   */
  accepted?: boolean;
  queued?: boolean;
  jobId?: string;
  pendingCount?: number;
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
  /**
   * COMMERCIAL AUTHORITY (2026-09-03) — the SERVER's snapshot, read from
   * `GET /v1/evidence/:id/review-workspace`.
   *
   * This was derived in the browser from the caller's whole billing
   * aggregate. The same three entitlement booleans were already being
   * computed server-side by `resolveWorkspaceCapabilitySnapshot` from the
   * canonical plan catalogue, and the server is what enforces them, so the
   * client asks rather than deciding. `null` while the detail loads or when
   * the workspace read failed — callers must not assume a capability.
   */
  capabilities: WorkspaceCapabilitySnapshot | null;
  caseName: string | null;
};

/**
 * COMMERCIAL AUTHORITY (2026-09-03) — the three billing fields are gone.
 *
 * The library held the caller's whole billing aggregate so it could decide,
 * in the browser, whether a PDF report was included. The server owns that
 * entitlement and enforces it; the library now asks and reports what it is
 * told.
 */
export type LibraryLoadState = {
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
