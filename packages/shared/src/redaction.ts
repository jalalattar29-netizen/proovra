/**
 * PROOVRA Phase 3A — Enterprise Redaction Platform shared contracts.
 *
 * Single source of truth for the bounded vocabulary that the
 * Redaction Platform shares between API, web, worker, and the
 * Verification Package builder.
 *
 * Hard rules:
 *
 *   1. Original evidence is IMMUTABLE.
 *      The platform never overwrites, modifies, or destroys the
 *      original artifact. Every redaction produces a DERIVATIVE.
 *
 *   2. Append-only enums.
 *      Renaming a code is a breaking change for every persisted
 *      decision row and every verification package ever produced.
 *
 *   3. Bounded rationale ≤ 600 chars at use sites.
 *
 *   4. Detections are SUGGESTIONS only — every detection requires a
 *      human decision before a derivative is published.
 *
 *   5. NEVER asserts authenticity / admissibility of the redacted
 *      derivative. The platform records WHAT was redacted, WHY, and
 *      BY WHOM — it does not claim the original was correctly
 *      interpreted.
 */

// ===========================================================================
// 1. Artifact kinds the redaction platform supports
// ===========================================================================

export const REDACTION_ARTIFACT_KINDS = [
  "IMAGE",
  "PDF",
  "VIDEO",
  "AUDIO",
] as const;
export type RedactionArtifactKind = (typeof REDACTION_ARTIFACT_KINDS)[number];

// ===========================================================================
// 2. Region kinds (shape of the redacted slice of the artifact)
// ===========================================================================

export const REDACTION_REGION_KINDS = [
  // Image / video-frame: normalized bounding box (x, y, w, h ∈ [0,1]).
  "BBOX_NORMALIZED",
  // Image / video-frame: polygon of normalized points.
  "POLYGON_NORMALIZED",
  // PDF: bounded text-range hit produced by OCR or text-layer extraction.
  "PDF_TEXT_RANGE",
  // PDF: page-level rectangle (page index + normalized box on that page).
  "PDF_PAGE_RECT",
  // Video: bbox PLUS frame range (startFrame..endFrame inclusive).
  "VIDEO_FRAME_BBOX",
  // Audio: bounded ms range (startMs..endMs).
  "AUDIO_RANGE_MS",
] as const;
export type RedactionRegionKind = (typeof REDACTION_REGION_KINDS)[number];

// ===========================================================================
// 3. Redaction methods (how the derivative renders the region)
// ===========================================================================

export const REDACTION_METHODS = [
  // Image / video: Gaussian blur over the region.
  "BLUR",
  // Image / video: blocky pixelation over the region.
  "PIXELATE",
  // Image / video / PDF: opaque black fill over the region. Default for
  // PDF derivatives because it is the only visually unambiguous redaction.
  "BLACKOUT",
  // Audio: silence the region.
  "MUTE",
  // Audio: replace with bounded "REDACTED" beep tone.
  "BEEP",
  // PDF: strip the underlying content-stream operators (text runs,
  // images) intersecting the region. The derivative also renders an
  // opaque BLACKOUT band as the visible indicator. NEVER the only
  // mechanism — always paired with BLACKOUT for visual honesty.
  "REMOVE_CONTENT",
] as const;
export type RedactionMethod = (typeof REDACTION_METHODS)[number];

// ===========================================================================
// 4. Detection kinds (what the AI / rule found)
// ===========================================================================

export const REDACTION_DETECTION_KINDS = [
  "FACE",
  "TEXT_BLOCK",
  "EMAIL",
  "PHONE",
  "POSTAL_ADDRESS",
  "GOVERNMENT_ID",
  "CREDIT_CARD",
  "BANK_ACCOUNT",
  "NATIONAL_INSURANCE",
  "DATE_OF_BIRTH",
  "LICENSE_PLATE",
  "SIGNATURE",
  "QR_BARCODE",
  "SCREEN_CONTENT",
  "MINOR_FACE",
  "CUSTOM_RULE",
] as const;
export type RedactionDetectionKind =
  (typeof REDACTION_DETECTION_KINDS)[number];

// ===========================================================================
// 5. Detection providers (where the suggestion came from)
//
// Phase 3A real implementations:
//   * MANUAL          — operator drew the region by hand.
//   * REGEX_PII       — bounded text-pattern matcher (email/phone/etc.)
//                        over OCR text / transcript / pdf text-layer.
//   * POLICY_RULE     — workspace governance policy hit.
//
// Phase 3A bounded stubs (return `not_configured` until creds present):
//   * AWS_REKOGNITION_FACES
//   * AWS_REKOGNITION_TEXT
//   * AZURE_DOCUMENT_INTELLIGENCE
//   * OCR_TEXT_LAYER
//   * DEEPGRAM_TRANSCRIPT
//
// Hard rule: every detection — regardless of provider — is a
// SUGGESTION until a human decision is recorded against it.
// ===========================================================================

export const REDACTION_DETECTION_PROVIDERS = [
  "MANUAL",
  "REGEX_PII",
  "POLICY_RULE",
  "AWS_REKOGNITION_FACES",
  "AWS_REKOGNITION_TEXT",
  "AZURE_DOCUMENT_INTELLIGENCE",
  "OCR_TEXT_LAYER",
  "DEEPGRAM_TRANSCRIPT",
  "CUSTOM_PROVIDER",
] as const;
export type RedactionDetectionProvider =
  (typeof REDACTION_DETECTION_PROVIDERS)[number];

// Bounded probe outcomes for every provider so the API can honestly
// surface "this provider is not configured in this workspace" instead
// of silently dropping detections.
export const REDACTION_DETECTION_PROVIDER_STATES = [
  "READY",
  "NOT_CONFIGURED",
  "DISABLED_BY_POLICY",
  "RATE_LIMITED",
  "ERROR",
] as const;
export type RedactionDetectionProviderState =
  (typeof REDACTION_DETECTION_PROVIDER_STATES)[number];

// Bounded confidence bands. Provider-specific raw confidence scores
// are mapped down to one of these four bands so reviewers compare
// apples-to-apples across providers.
export const REDACTION_CONFIDENCE_BANDS = [
  "LOW",
  "MEDIUM",
  "HIGH",
  "VERY_HIGH",
] as const;
export type RedactionConfidenceBand =
  (typeof REDACTION_CONFIDENCE_BANDS)[number];

/**
 * Bounded helper — collapse a [0, 1] raw confidence into one of the
 * four bands. Same mapping everywhere so the reviewer queue is
 * consistent across providers.
 */
export function classifyConfidence(
  raw: number,
): RedactionConfidenceBand {
  if (raw >= 0.95) return "VERY_HIGH";
  if (raw >= 0.8) return "HIGH";
  if (raw >= 0.5) return "MEDIUM";
  return "LOW";
}

// ===========================================================================
// 6. Decision states (what the human said about a detection)
// ===========================================================================

export const REDACTION_DECISION_STATES = [
  // Provider produced it; no human has touched it yet.
  "SUGGESTED",
  // Reviewer accepted the detection — it becomes part of the version.
  "ACCEPTED",
  // Reviewer modified the bounded box / method before accepting.
  "MODIFIED",
  // Reviewer explicitly rejected the detection. The DECISION row is
  // preserved so audit can answer "why was this NOT redacted?".
  "REJECTED",
  // Reviewer deferred to a senior approver.
  "DEFERRED",
] as const;
export type RedactionDecisionState =
  (typeof REDACTION_DECISION_STATES)[number];

// ===========================================================================
// 7. Project + version state machines
// ===========================================================================

export const REDACTION_PROJECT_STATES = [
  "DRAFT",
  "IN_REVIEW",
  "APPROVED",
  "PUBLISHED",
  "REJECTED",
  "SUPERSEDED",
  "ARCHIVED",
] as const;
export type RedactionProjectState =
  (typeof REDACTION_PROJECT_STATES)[number];

export const REDACTION_VERSION_STATES = [
  // Reviewer is still composing regions / decisions.
  "DRAFT",
  // Submitted for approver review. Regions are locked.
  "IN_REVIEW",
  // Approver approved this exact set. Derivative may be generated.
  "APPROVED",
  // Approver rejected. Version is preserved (audit). A new version
  // may be drafted.
  "REJECTED",
  // Derivative has been generated and the version is the workspace's
  // current published view.
  "PUBLISHED",
  // A newer version has been PUBLISHED. This row is preserved.
  "SUPERSEDED",
] as const;
export type RedactionVersionState =
  (typeof REDACTION_VERSION_STATES)[number];

// Allowed version-state transitions. Anything else is refused at the
// service boundary with denial `INVALID_TRANSITION`.
export const REDACTION_VERSION_TRANSITIONS: Readonly<
  Record<RedactionVersionState, ReadonlyArray<RedactionVersionState>>
> = {
  DRAFT: ["IN_REVIEW", "REJECTED"],
  IN_REVIEW: ["APPROVED", "REJECTED", "DRAFT"],
  APPROVED: ["PUBLISHED", "REJECTED"],
  REJECTED: ["DRAFT"],
  PUBLISHED: ["SUPERSEDED"],
  SUPERSEDED: [],
};

export function isAllowedVersionTransition(
  from: RedactionVersionState,
  to: RedactionVersionState,
): boolean {
  return REDACTION_VERSION_TRANSITIONS[from].includes(to);
}

// ===========================================================================
// 8. Approval verdicts
// ===========================================================================

export const REDACTION_APPROVAL_VERDICTS = [
  "APPROVE",
  "REJECT",
  "REQUEST_CHANGES",
  "DEFER",
] as const;
export type RedactionApprovalVerdict =
  (typeof REDACTION_APPROVAL_VERDICTS)[number];

// ===========================================================================
// 9. Derivative kinds + states
// ===========================================================================

export const REDACTION_DERIVATIVE_KINDS = [
  "IMAGE_REDACTED",
  "PDF_REDACTED",
  "VIDEO_REDACTED",
  "AUDIO_REDACTED",
] as const;
export type RedactionDerivativeKind =
  (typeof REDACTION_DERIVATIVE_KINDS)[number];

export const REDACTION_DERIVATIVE_STATES = [
  "PENDING",
  "RENDERING",
  "READY",
  "FAILED",
  "QUARANTINED",
] as const;
export type RedactionDerivativeState =
  (typeof REDACTION_DERIVATIVE_STATES)[number];

// ===========================================================================
// 10. RBAC — Redaction roles + capabilities
// ===========================================================================

export const REDACTION_ROLES = [
  "REDACTION_REVIEWER",
  "REDACTION_APPROVER",
  "REDACTION_ADMINISTRATOR",
] as const;
export type RedactionRole = (typeof REDACTION_ROLES)[number];

export const REDACTION_CAPABILITIES = [
  // Read-only view of the redaction project + versions + derivatives.
  "redaction.view",
  // Open a project and draft regions / decisions on a version.
  "redaction.region.author",
  // Run detection providers against a version.
  "redaction.detection.run",
  // Resolve an individual detection (accept / reject / modify).
  "redaction.detection.review",
  // Submit a version for approval.
  "redaction.version.submit",
  // Approve / reject a submitted version.
  "redaction.version.approve",
  // Publish an approved version (locks it, schedules derivative).
  "redaction.version.publish",
  // Download the redacted derivative bytes.
  "redaction.derivative.download",
  // Workspace administrator operations — bind providers, define
  // custom detection rules, manage policies.
  "redaction.administer",
] as const;
export type RedactionCapability =
  (typeof REDACTION_CAPABILITIES)[number];

export const REDACTION_CAPABILITY_MATRIX: Readonly<
  Record<RedactionRole, ReadonlyArray<RedactionCapability>>
> = {
  REDACTION_REVIEWER: [
    "redaction.view",
    "redaction.region.author",
    "redaction.detection.run",
    "redaction.detection.review",
    "redaction.version.submit",
  ],
  REDACTION_APPROVER: [
    "redaction.view",
    "redaction.region.author",
    "redaction.detection.run",
    "redaction.detection.review",
    "redaction.version.submit",
    "redaction.version.approve",
    "redaction.version.publish",
    "redaction.derivative.download",
  ],
  REDACTION_ADMINISTRATOR: [
    "redaction.view",
    "redaction.region.author",
    "redaction.detection.run",
    "redaction.detection.review",
    "redaction.version.submit",
    "redaction.version.approve",
    "redaction.version.publish",
    "redaction.derivative.download",
    "redaction.administer",
  ],
};

export function redactionCapabilitiesForRole(
  role: RedactionRole,
): ReadonlySet<RedactionCapability> {
  return new Set(REDACTION_CAPABILITY_MATRIX[role]);
}

// ===========================================================================
// 11. Audit / activity catalog
//
// Bounded code list — every redaction action must map to one of these.
// Codes are written to the existing platform audit chain via the
// redaction-activity service; there is NEVER a parallel audit store.
// ===========================================================================

export const REDACTION_ACTIVITY_CODES = [
  // Project lifecycle.
  "PROJECT_CREATED",
  "PROJECT_REOPENED",
  "PROJECT_ARCHIVED",
  // Version lifecycle.
  "VERSION_CREATED",
  "VERSION_SUBMITTED_FOR_REVIEW",
  "VERSION_APPROVED",
  "VERSION_REJECTED",
  "VERSION_PUBLISHED",
  "VERSION_SUPERSEDED",
  // Regions.
  "REGION_ADDED",
  "REGION_REMOVED",
  "REGION_MODIFIED",
  // Detection lifecycle.
  "DETECTION_RUN_STARTED",
  "DETECTION_RUN_COMPLETED",
  "DETECTION_RUN_FAILED",
  "DETECTION_GENERATED",
  // Per-detection reviewer decision.
  "DETECTION_ACCEPTED",
  "DETECTION_REJECTED",
  "DETECTION_MODIFIED",
  "DETECTION_DEFERRED",
  // Approval workflow.
  "APPROVAL_REQUESTED",
  "APPROVAL_GRANTED",
  "APPROVAL_DENIED",
  "APPROVAL_CHANGES_REQUESTED",
  // Derivative pipeline.
  "DERIVATIVE_REQUESTED",
  "DERIVATIVE_RENDER_STARTED",
  "DERIVATIVE_RENDER_COMPLETED",
  "DERIVATIVE_RENDER_FAILED",
  "DERIVATIVE_DOWNLOADED",
  "DERIVATIVE_QUARANTINED",
  // Cross-surface.
  "POLICY_VIOLATION_DETECTED",
  "ORIGINAL_INTEGRITY_REVERIFIED",
] as const;
export type RedactionActivityCode =
  (typeof REDACTION_ACTIVITY_CODES)[number];

// ===========================================================================
// 12. Bounded denial reasons
// ===========================================================================

export const REDACTION_DENIAL_REASONS = [
  "NOT_PERMITTED",
  "PROJECT_NOT_FOUND",
  "VERSION_NOT_FOUND",
  "VERSION_LOCKED",
  "INVALID_TRANSITION",
  "DETECTION_NOT_FOUND",
  "REGION_INVALID",
  "REGION_OUT_OF_BOUNDS",
  "RATIONALE_REQUIRED",
  "ARTIFACT_NOT_REDACTABLE",
  "PROVIDER_NOT_CONFIGURED",
  "PROVIDER_RATE_LIMITED",
  "DERIVATIVE_NOT_READY",
  "DERIVATIVE_QUARANTINED",
  "POLICY_REJECTED",
  "ALREADY_APPROVED",
  "ALREADY_PUBLISHED",
  "ALREADY_REJECTED",
  "WORKSPACE_NOT_FOUND",
] as const;
export type RedactionDenialReason =
  (typeof REDACTION_DENIAL_REASONS)[number];

// ===========================================================================
// 13. Standing limitations — surfaced everywhere the platform is exposed
// ===========================================================================

export const REDACTION_PROVENANCE_LIMITATIONS: ReadonlyArray<string> = [
  "REDACTION_NEVER_MODIFIES_ORIGINAL",
  "REDACTION_DERIVATIVE_IS_NOT_ORIGINAL",
  "REDACTION_PROVIDER_SUGGESTIONS_ARE_NOT_GROUND_TRUTH",
  "REDACTION_APPROVAL_IS_HUMAN_JUDGEMENT",
  "REDACTION_DERIVATIVE_INTEGRITY_VERIFIES_THE_PIPELINE_NOT_THE_FACT",
];

// ===========================================================================
// 14. Projection — single read shape consumed by the reviewer UI
// ===========================================================================

export const REDACTION_PROJECTION_SCHEMA_VERSION =
  "PROOVRA_REDACTION_V1" as const;

export type RedactionRegionProjection = {
  id: string;
  kind: RedactionRegionKind;
  method: RedactionMethod;
  /** Bounded geometry. Shape depends on `kind`. */
  geometry: Readonly<Record<string, unknown>>;
  /** When the region was first added (UTC ISO 8601). */
  createdAtUtc: string;
  /** Free-text bounded ≤ 600 chars. */
  rationale: string | null;
  /** The detection that produced this region, when applicable. */
  sourceDetectionId: string | null;
  /** Bounded provider tag for audit. */
  sourceProvider: RedactionDetectionProvider | null;
  authoredByUserId: string;
};

export type RedactionDetectionProjection = {
  id: string;
  kind: RedactionDetectionKind;
  provider: RedactionDetectionProvider;
  confidenceBand: RedactionConfidenceBand;
  rawConfidence: number;
  /** Region the provider thinks should be redacted. */
  suggestedRegion: RedactionRegionProjection;
  /** Bounded preview text (≤ 80 chars). NEVER full PII. */
  previewLabel: string | null;
  decisionState: RedactionDecisionState;
  decisionByUserId: string | null;
  decidedAtUtc: string | null;
};

export type RedactionApprovalProjection = {
  id: string;
  verdict: RedactionApprovalVerdict;
  approverUserId: string;
  decidedAtUtc: string;
  rationale: string | null;
};

export type RedactionDerivativeProjection = {
  id: string;
  kind: RedactionDerivativeKind;
  state: RedactionDerivativeState;
  storageKey: string | null;
  storageBucket: string | null;
  byteSize: number | null;
  fileSha256: string | null;
  renderedAtUtc: string | null;
  failureReason: string | null;
};

export type RedactionVersionProjection = {
  id: string;
  versionOrdinal: number;
  state: RedactionVersionState;
  authoredByUserId: string;
  createdAtUtc: string;
  submittedAtUtc: string | null;
  approvedAtUtc: string | null;
  publishedAtUtc: string | null;
  rationale: string | null;
  regionCount: number;
  acceptedDetectionCount: number;
  rejectedDetectionCount: number;
  approvals: ReadonlyArray<RedactionApprovalProjection>;
  derivative: RedactionDerivativeProjection | null;
};

export type RedactionProjectProjection = {
  schemaVersion: typeof REDACTION_PROJECTION_SCHEMA_VERSION;
  generatedAtUtc: string;

  id: string;
  teamId: string;
  evidenceId: string;
  /** Bounded artifact kind so the UI can pick the right viewer. */
  artifactKind: RedactionArtifactKind;
  title: string | null;
  state: RedactionProjectState;
  createdByUserId: string;
  createdAtUtc: string;

  /**
   * The current published version, or NULL if no version has been
   * published yet. Consumers downstream of the platform (verify
   * page, report, verification package) only see published rows.
   */
  publishedVersion: RedactionVersionProjection | null;

  /** All versions ordered newest → oldest. */
  versions: ReadonlyArray<RedactionVersionProjection>;

  /** Surface of the standing limitations. */
  limitations: ReadonlyArray<string>;
};

// ===========================================================================
// 15. Public-safe projection (Verify page consumer)
//
// The verify page is anonymous + public. We expose ONLY:
//   * "redacted derivative exists" boolean
//   * the published version's bounded state
//   * the published version's approval timestamp
//
// We NEVER expose region geometry, detection text, or rationale.
// ===========================================================================

export type RedactionPublicVerifyBadge = {
  hasPublishedDerivative: boolean;
  publishedVersionOrdinal: number | null;
  publishedAtUtc: string | null;
  approvalCount: number;
  /** Bounded standing-limitation codes — never the full geometry. */
  limitations: ReadonlyArray<string>;
};

// ===========================================================================
// 16. Bounded helpers — region geometry validators
//
// Pure functions. Used at every region write to refuse out-of-bounds
// or malformed regions before they touch the database. The same code
// runs in the API and the worker derivative pipeline.
// ===========================================================================

export type BboxNormalized = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export function isValidBboxNormalized(b: unknown): b is BboxNormalized {
  if (b === null || typeof b !== "object") return false;
  const obj = b as Record<string, unknown>;
  for (const k of ["x", "y", "width", "height"] as const) {
    if (typeof obj[k] !== "number" || !Number.isFinite(obj[k] as number)) {
      return false;
    }
  }
  const x = obj.x as number;
  const y = obj.y as number;
  const w = obj.width as number;
  const h = obj.height as number;
  if (x < 0 || y < 0 || w <= 0 || h <= 0) return false;
  if (x + w > 1.0001 || y + h > 1.0001) return false;
  return true;
}

export type PolygonNormalized = {
  points: ReadonlyArray<{ x: number; y: number }>;
};

export function isValidPolygonNormalized(p: unknown): p is PolygonNormalized {
  if (p === null || typeof p !== "object") return false;
  const obj = p as Record<string, unknown>;
  const points = obj.points;
  if (!Array.isArray(points) || points.length < 3 || points.length > 64) {
    return false;
  }
  for (const pt of points) {
    if (!pt || typeof pt !== "object") return false;
    const x = (pt as { x?: unknown }).x;
    const y = (pt as { y?: unknown }).y;
    if (
      typeof x !== "number" ||
      typeof y !== "number" ||
      !Number.isFinite(x) ||
      !Number.isFinite(y)
    ) {
      return false;
    }
    if (x < 0 || x > 1.0001 || y < 0 || y > 1.0001) return false;
  }
  return true;
}

export type VideoFrameBbox = {
  startFrame: number;
  endFrame: number;
  bbox: BboxNormalized;
  /** Optional opaque object id for tracking continuity across frames. */
  trackingId?: string;
};

export function isValidVideoFrameBbox(v: unknown): v is VideoFrameBbox {
  if (v === null || typeof v !== "object") return false;
  const obj = v as Record<string, unknown>;
  const sf = obj.startFrame;
  const ef = obj.endFrame;
  if (
    typeof sf !== "number" ||
    typeof ef !== "number" ||
    !Number.isInteger(sf) ||
    !Number.isInteger(ef)
  ) {
    return false;
  }
  if (sf < 0 || ef < sf) return false;
  return isValidBboxNormalized(obj.bbox);
}

export type AudioRangeMs = {
  startMs: number;
  endMs: number;
};

export function isValidAudioRangeMs(r: unknown): r is AudioRangeMs {
  if (r === null || typeof r !== "object") return false;
  const obj = r as Record<string, unknown>;
  const s = obj.startMs;
  const e = obj.endMs;
  if (
    typeof s !== "number" ||
    typeof e !== "number" ||
    !Number.isFinite(s) ||
    !Number.isFinite(e)
  ) {
    return false;
  }
  return s >= 0 && e > s;
}

export type PdfPageRect = {
  pageIndex: number;
  rect: BboxNormalized;
};

export function isValidPdfPageRect(r: unknown): r is PdfPageRect {
  if (r === null || typeof r !== "object") return false;
  const obj = r as Record<string, unknown>;
  const p = obj.pageIndex;
  if (typeof p !== "number" || !Number.isInteger(p) || p < 0) return false;
  return isValidBboxNormalized(obj.rect);
}

export type PdfTextRange = {
  pageIndex: number;
  /** Offset within the page's extracted text-layer. */
  charStart: number;
  charEnd: number;
  /** Optional bbox hint to render the BLACKOUT mask. */
  bboxHint?: BboxNormalized;
};

export function isValidPdfTextRange(r: unknown): r is PdfTextRange {
  if (r === null || typeof r !== "object") return false;
  const obj = r as Record<string, unknown>;
  const p = obj.pageIndex;
  const s = obj.charStart;
  const e = obj.charEnd;
  if (typeof p !== "number" || !Number.isInteger(p) || p < 0) return false;
  if (typeof s !== "number" || !Number.isInteger(s) || s < 0) return false;
  if (typeof e !== "number" || !Number.isInteger(e) || e <= s) return false;
  if (obj.bboxHint !== undefined && !isValidBboxNormalized(obj.bboxHint)) {
    return false;
  }
  return true;
}

/**
 * Canonical region-geometry validator. Returns true iff the geometry
 * matches the kind. Used at every region write to refuse malformed
 * regions before they touch the database.
 */
export function isValidRegionGeometry(
  kind: RedactionRegionKind,
  geometry: unknown,
): boolean {
  switch (kind) {
    case "BBOX_NORMALIZED":
      return isValidBboxNormalized(geometry);
    case "POLYGON_NORMALIZED":
      return isValidPolygonNormalized(geometry);
    case "PDF_TEXT_RANGE":
      return isValidPdfTextRange(geometry);
    case "PDF_PAGE_RECT":
      return isValidPdfPageRect(geometry);
    case "VIDEO_FRAME_BBOX":
      return isValidVideoFrameBbox(geometry);
    case "AUDIO_RANGE_MS":
      return isValidAudioRangeMs(geometry);
  }
}

// ===========================================================================
// 17. Cross-platform integration shapes
// ===========================================================================

/**
 * Reviewer-workspace summary slot — added to the aggregator so the
 * Reviewer landing page surfaces the operator's redaction queue
 * (workspace-anchored counts only — never per-grant detail).
 */
export type RedactionReviewerSummary = {
  pendingDecisionCount: number;
  awaitingApprovalCount: number;
  approvedPendingDerivativeCount: number;
  publishedCount: number;
  rejectedCount: number;
};

/**
 * External portal extension — for a given grant, bounded list of
 * approved-published redaction derivatives the external reviewer
 * is allowed to read. The grant always points at the derivative,
 * NEVER the original.
 */
export type PortalRedactionExposure = {
  derivativeId: string;
  versionOrdinal: number;
  publishedAtUtc: string;
  artifactKind: RedactionArtifactKind;
};

/**
 * Verification-package manifest slot — bounded record describing
 * each published redaction version so independent verification can
 * inspect the lineage without re-hitting the platform.
 */
export type RedactionVerificationManifestEntry = {
  projectId: string;
  evidenceId: string;
  artifactKind: RedactionArtifactKind;
  publishedVersion: {
    id: string;
    versionOrdinal: number;
    publishedAtUtc: string;
    publishedByUserId: string | null;
    regionCount: number;
    derivative: {
      kind: RedactionDerivativeKind;
      storageKey: string | null;
      byteSize: number | null;
      fileSha256: string | null;
    } | null;
    approvals: ReadonlyArray<RedactionApprovalProjection>;
  };
};

// ===========================================================================
// 18. Hard rule — provider stub honesty
//
// Provider-state probes MUST return a bounded outcome. Detection
// services NEVER drop suggestions silently — when a provider is not
// configured, the detection run records a `DETECTION_RUN_FAILED`
// activity with provider_state=NOT_CONFIGURED so the operator knows
// to bind credentials. This is the same honest-fallback rule the
// rest of the platform follows.
// ===========================================================================

export type RedactionProviderProbe = {
  provider: RedactionDetectionProvider;
  state: RedactionDetectionProviderState;
  /** Bounded operator-facing reason. NEVER the raw provider error. */
  reason: string | null;
};
