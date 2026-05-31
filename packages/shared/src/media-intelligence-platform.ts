/**
 * PROOVRA Phase 3B — Enterprise Intelligence Platform shared contracts.
 *
 * Single source of truth for the bounded vocabulary used by:
 *
 *   * Media Intelligence Records (the unified abstraction over
 *     Azure OCR / Deepgram transcripts / Rekognition labels /
 *     OpenAI extractions).
 *   * Reviewer Corrections (audit-trail-friendly per-modality
 *     corrections with full version history).
 *   * Confidence scoring (provider / review / final).
 *   * Provider abstraction (no vendor lock-in).
 *   * Cost controls (per-workspace / team / case / provider
 *     usage events + budgets + alerts + soft/hard limits).
 *   * Executive Dashboard metrics.
 *   * Audit & Transparency Center.
 *
 * Hard rules:
 *
 *   1. Append-only enums. The platform's audit chain depends on
 *      bounded vocabularies surviving forever.
 *   2. NEVER PII in the bounded payloads — counts + bounded labels
 *      only. Raw OCR / transcript text lives in the record's
 *      content blob, NEVER in audit / executive / verification
 *      manifests.
 *   3. Confidence is always one of `INTELLIGENCE_CONFIDENCE_BANDS`
 *      so reviewer queues compare apples-to-apples across providers.
 *   4. Corrections are bounded + versioned + auditable. They
 *      NEVER overwrite the provider's original output — they
 *      append a correction record alongside it.
 *   5. Cost controls fail closed at hard limits — the bounded
 *      `decisionGate` returns BLOCKED so provider adapters refuse
 *      to call out.
 *   6. Executive metrics are aggregates — never per-document /
 *      per-user identifiers leaked to a global dashboard.
 */

import type {
  RedactionConfidenceBand,
  RedactionDetectionKind,
  RedactionDetectionProvider,
} from "./redaction.js";

// ===========================================================================
// 1. Modalities — bounded artifact kinds the platform produces records for
// ===========================================================================

export const MEDIA_INTELLIGENCE_MODALITIES = [
  "IMAGE",
  "DOCUMENT",
  "PDF",
  "AUDIO",
  "VIDEO",
] as const;
export type MediaIntelligenceModality =
  (typeof MEDIA_INTELLIGENCE_MODALITIES)[number];

// ===========================================================================
// 2. Intelligence record kinds — what the record represents
// ===========================================================================

export const MEDIA_INTELLIGENCE_RECORD_KINDS = [
  // Document Intelligence
  "DOCUMENT_OCR_TEXT",
  "DOCUMENT_LAYOUT",
  "DOCUMENT_TABLE",
  "DOCUMENT_FORM_FIELD",
  // Transcript Intelligence
  "TRANSCRIPT_SEGMENT",
  "TRANSCRIPT_WORD",
  "SPEAKER_SEGMENT",
  // Visual Intelligence
  "IMAGE_OBJECT_LABEL",
  "IMAGE_TEXT_BLOCK",
  "IMAGE_FACE",
  // Cross-modality entity
  "ENTITY",
  // Frame-level video intelligence
  "VIDEO_FRAME_LABEL",
] as const;
export type MediaIntelligenceRecordKind =
  (typeof MEDIA_INTELLIGENCE_RECORD_KINDS)[number];

// ===========================================================================
// 3. Provider catalog — extended from the redaction provider list
//    with the intelligence-tier providers + OpenAI.
// ===========================================================================

export const MEDIA_INTELLIGENCE_PROVIDERS = [
  // Already used by the redaction platform
  "AZURE_DOCUMENT_INTELLIGENCE",
  "AWS_REKOGNITION_FACES",
  "AWS_REKOGNITION_TEXT",
  "AWS_REKOGNITION_LABELS",
  "DEEPGRAM_TRANSCRIPT",
  // Generic OpenAI bridge — used by the entity extraction +
  // bounded summarisation paths. Bounded — every call is gated
  // by workspace policy + cost controls.
  "OPENAI_ENTITY_EXTRACTION",
  "OPENAI_DOCUMENT_SUMMARY",
  // Reviewer / operator manual record (used when the operator
  // hand-types an OCR correction the record came from before any
  // provider was called).
  "MANUAL_OPERATOR",
] as const;
export type MediaIntelligenceProvider =
  (typeof MEDIA_INTELLIGENCE_PROVIDERS)[number];

// ===========================================================================
// 4. Bounded confidence band catalog
// ===========================================================================

export const INTELLIGENCE_CONFIDENCE_BANDS = [
  "LOW",
  "MEDIUM",
  "HIGH",
  "VERY_HIGH",
] as const;
export type IntelligenceConfidenceBand =
  (typeof INTELLIGENCE_CONFIDENCE_BANDS)[number];

/**
 * Bounded helper — collapse a [0, 1] raw confidence into one of
 * the four bands. Same cut-offs as `classifyConfidence` from the
 * redaction module so the operator queue compares apples-to-apples
 * across phases.
 */
export function classifyIntelligenceConfidence(
  raw: number,
): IntelligenceConfidenceBand {
  if (raw >= 0.95) return "VERY_HIGH";
  if (raw >= 0.8) return "HIGH";
  if (raw >= 0.5) return "MEDIUM";
  return "LOW";
}

// ===========================================================================
// 5. Intelligence record states + correction lifecycle
// ===========================================================================

export const MEDIA_INTELLIGENCE_RECORD_STATES = [
  // Provider produced + persisted; no human has reviewed it.
  "INGESTED",
  // A reviewer has opened the record for review.
  "IN_REVIEW",
  // A reviewer accepted the record (with or without modification).
  "ACCEPTED",
  // A reviewer rejected the record entirely (e.g. spurious face).
  "REJECTED",
  // A reviewer modified the record's payload via a correction.
  "CORRECTED",
  // Superseded by a new ingest (re-run from a higher-quality provider).
  "SUPERSEDED",
] as const;
export type MediaIntelligenceRecordState =
  (typeof MEDIA_INTELLIGENCE_RECORD_STATES)[number];

export const REVIEWER_CORRECTION_KINDS = [
  "OCR_TEXT",
  "OCR_REGION",
  "TRANSCRIPT_TEXT",
  "TRANSCRIPT_TIMING",
  "SPEAKER_LABEL",
  "SPEAKER_DIARIZATION_MERGE",
  "SPEAKER_DIARIZATION_SPLIT",
  "ENTITY_TYPE",
  "ENTITY_VALUE",
  "LAYOUT_BLOCK",
  "VIDEO_LABEL",
] as const;
export type ReviewerCorrectionKind =
  (typeof REVIEWER_CORRECTION_KINDS)[number];

export const REVIEWER_CORRECTION_STATES = [
  "DRAFT",
  "ACCEPTED",
  "REVERTED",
] as const;
export type ReviewerCorrectionState =
  (typeof REVIEWER_CORRECTION_STATES)[number];

// ===========================================================================
// 6. Provider adapter interface (bounded, vendor-agnostic)
// ===========================================================================

export const PROVIDER_ADAPTER_OPERATIONS = [
  "OCR_DOCUMENT",
  "OCR_IMAGE",
  "TRANSCRIBE_AUDIO",
  "TRANSCRIBE_VIDEO_AUDIO_TRACK",
  "DETECT_FACES",
  "DETECT_OBJECTS",
  "DETECT_TEXT_IN_IMAGE",
  "EXTRACT_ENTITIES",
  "SUMMARISE_DOCUMENT",
] as const;
export type ProviderAdapterOperation =
  (typeof PROVIDER_ADAPTER_OPERATIONS)[number];

export const PROVIDER_ADAPTER_STATES = [
  "READY",
  "NOT_CONFIGURED",
  "DISABLED_BY_POLICY",
  "RATE_LIMITED",
  "BUDGET_EXCEEDED",
  "ERROR",
] as const;
export type ProviderAdapterState =
  (typeof PROVIDER_ADAPTER_STATES)[number];

export type ProviderAdapterProbe = {
  provider: MediaIntelligenceProvider;
  state: ProviderAdapterState;
  operations: ReadonlyArray<ProviderAdapterOperation>;
  reason: string | null;
};

// ===========================================================================
// 7. Cost controls
// ===========================================================================

export const PROVIDER_COST_UNITS = [
  "PAGE",
  "MINUTE",
  "TOKEN",
  "IMAGE",
  "CALL",
  "MEGABYTE",
] as const;
export type ProviderCostUnit = (typeof PROVIDER_COST_UNITS)[number];

export const PROVIDER_BUDGET_PERIODS = [
  "DAILY",
  "WEEKLY",
  "MONTHLY",
  "QUARTERLY",
  "ANNUAL",
] as const;
export type ProviderBudgetPeriod = (typeof PROVIDER_BUDGET_PERIODS)[number];

export const PROVIDER_BUDGET_SCOPES = [
  "WORKSPACE",
  "TEAM",
  "CASE",
  "PROJECT",
  "PROVIDER",
] as const;
export type ProviderBudgetScope = (typeof PROVIDER_BUDGET_SCOPES)[number];

export const PROVIDER_BUDGET_DECISIONS = [
  "ALLOW",
  "WARN",
  "BLOCK",
] as const;
export type ProviderBudgetDecision =
  (typeof PROVIDER_BUDGET_DECISIONS)[number];

/**
 * Bounded provider-budget decision the adapter consults BEFORE a
 * paid provider call. ALLOW = call proceeds; WARN = call proceeds
 * + soft alert; BLOCK = adapter refuses (fail-closed at the hard
 * limit).
 */
export type ProviderBudgetGateInput = {
  teamId: string;
  provider: MediaIntelligenceProvider;
  estimatedCostUsdMicros: number;
};

export type ProviderBudgetGateResult = {
  decision: ProviderBudgetDecision;
  /** Bounded operator-readable reason. */
  reason: string | null;
  /** Budget id + period the decision was made against, when applicable. */
  budgetId: string | null;
};

// ===========================================================================
// 8. Audit & Transparency Center categories
// ===========================================================================

export const AUDIT_TRANSPARENCY_CATEGORIES = [
  "DATA_PROCESSING",
  "DETECTION",
  "REVIEW",
  "APPROVAL",
  "REDACTION",
  "VERIFICATION",
  "AI_PROVIDER",
  "PROVIDER_USAGE",
  "CORRECTION",
  "POLICY",
  "EXPORT",
  "ACCESS",
] as const;
export type AuditTransparencyCategory =
  (typeof AUDIT_TRANSPARENCY_CATEGORIES)[number];

export type AuditTransparencyEntry = {
  category: AuditTransparencyCategory;
  /** Bounded event code from the producing service. */
  code: string;
  /** Bounded operator-readable label (≤ 120 chars). NEVER PII. */
  label: string;
  occurredAtUtc: string;
  actorUserId: string | null;
  /** Bounded source service so the operator can trace the row. */
  sourceService: string;
  /** Bounded count + bounded ids so the row is auditable but small. */
  payload: Record<string, string | number | boolean | null>;
};

// ===========================================================================
// 9. Executive metrics
// ===========================================================================

export const EXECUTIVE_METRICS_SCHEMA_VERSION =
  "PROOVRA_EXECUTIVE_METRICS_V1" as const;

export type ExecutiveMetricBand = "RED" | "AMBER" | "GREEN";

export type ExecutiveCaptureMetrics = {
  capturesLast7d: number;
  captureSuccessRatePct: number;
  mobileSignedRatio: number;
  highTrustCapturesLast7d: number;
};

export type ExecutiveReviewMetrics = {
  reviewedLast7d: number;
  approvalRatePct: number;
  qcAccuracyPct: number;
  averageReviewDurationMs: number;
};

export type ExecutiveEvidenceMetrics = {
  totalEvidence: number;
  storageBytes: number;
  byMimeFamily: Record<string, number>;
};

export type ExecutiveVerificationMetrics = {
  verificationsLast7d: number;
  publicVerifyViewsLast7d: number;
  successRatePct: number;
};

export type ExecutiveAiMetrics = {
  providerCallsLast7d: number;
  estimatedCostUsdLast7d: number;
  correctionsLast7d: number;
  averageProviderConfidence: number;
};

export type ExecutiveSlaMetrics = {
  averageDetectionLatencyMs: number;
  averageDerivativeLatencyMs: number;
  jobFailureRatePct: number;
  providerAvailabilityPct: number;
};

export type ExecutiveMetricsProjection = {
  schemaVersion: typeof EXECUTIVE_METRICS_SCHEMA_VERSION;
  generatedAtUtc: string;
  teamId: string;
  capture: ExecutiveCaptureMetrics;
  review: ExecutiveReviewMetrics;
  evidence: ExecutiveEvidenceMetrics;
  verification: ExecutiveVerificationMetrics;
  ai: ExecutiveAiMetrics;
  sla: ExecutiveSlaMetrics;
  /** Bounded standing limitations for the dashboard footer. */
  limitations: ReadonlyArray<string>;
};

export const EXECUTIVE_METRICS_LIMITATIONS: ReadonlyArray<string> = [
  "EXECUTIVE_METRICS_ARE_AGGREGATE_ONLY",
  "EXECUTIVE_METRICS_DO_NOT_EXPOSE_PII",
  "EXECUTIVE_METRICS_LAG_BY_UP_TO_5_MIN",
];

// ===========================================================================
// 10. Activity codes — Phase 3B intelligence events
// ===========================================================================

export const MEDIA_INTELLIGENCE_ACTIVITY_CODES = [
  // Record lifecycle
  "RECORD_INGESTED",
  "RECORD_OPENED_FOR_REVIEW",
  "RECORD_ACCEPTED",
  "RECORD_REJECTED",
  "RECORD_SUPERSEDED",
  // Correction lifecycle
  "CORRECTION_CREATED",
  "CORRECTION_ACCEPTED",
  "CORRECTION_REVERTED",
  // Provider lifecycle
  "PROVIDER_CALL_STARTED",
  "PROVIDER_CALL_COMPLETED",
  "PROVIDER_CALL_FAILED",
  "PROVIDER_CALL_REFUSED_BUDGET",
  "PROVIDER_CALL_REFUSED_POLICY",
  // Budget lifecycle
  "BUDGET_CREATED",
  "BUDGET_UPDATED",
  "BUDGET_SOFT_LIMIT_HIT",
  "BUDGET_HARD_LIMIT_HIT",
] as const;
export type MediaIntelligenceActivityCode =
  (typeof MEDIA_INTELLIGENCE_ACTIVITY_CODES)[number];

// ===========================================================================
// 11. Projections — single bounded read shapes the UI consumes
// ===========================================================================

export type MediaIntelligenceRecordProjection = {
  id: string;
  evidenceId: string;
  modality: MediaIntelligenceModality;
  kind: MediaIntelligenceRecordKind;
  provider: MediaIntelligenceProvider;
  state: MediaIntelligenceRecordState;
  /**
   * Provider raw confidence in [0, 1].
   *
   * NULL when the provider did NOT supply a confidence channel for this record
   * (e.g. some Azure Document Intelligence layouts, legacy pre-confidence rows).
   * Preserves provider failure transparency — distinct from confidence === 0
   * (which means "provider returned, but is sure it's wrong"). UI must render
   * a bounded "—" / "n/a" chip for null, not a numeric 0.
   */
  providerConfidence: number | null;
  providerConfidenceBand: IntelligenceConfidenceBand;
  /** Reviewer-supplied confidence band; null until a reviewer touched it. */
  reviewConfidenceBand: IntelligenceConfidenceBand | null;
  /** Final fused confidence band. */
  finalConfidenceBand: IntelligenceConfidenceBand;
  /** Bounded operator-facing label (≤ 120 chars). NEVER full text. */
  label: string | null;
  /** Source page / frame / ms anchor when applicable. */
  anchor: Record<string, unknown> | null;
  createdAtUtc: string;
  reviewedAtUtc: string | null;
  correctionCount: number;
};

export type ReviewerCorrectionProjection = {
  id: string;
  recordId: string;
  kind: ReviewerCorrectionKind;
  state: ReviewerCorrectionState;
  /** Bounded payload — the corrected value. Shape depends on kind. */
  patch: Record<string, unknown>;
  rationale: string | null;
  authoredByUserId: string;
  acceptedByUserId: string | null;
  createdAtUtc: string;
  acceptedAtUtc: string | null;
};

export type ProviderUsageEventProjection = {
  id: string;
  provider: MediaIntelligenceProvider;
  operation: ProviderAdapterOperation;
  unit: ProviderCostUnit;
  units: number;
  estimatedCostUsdMicros: number;
  evidenceId: string | null;
  caseId: string | null;
  projectId: string | null;
  initiatedByUserId: string | null;
  occurredAtUtc: string;
};

export type ProviderBudgetProjection = {
  id: string;
  scope: ProviderBudgetScope;
  scopeTargetId: string | null;
  provider: MediaIntelligenceProvider | null;
  period: ProviderBudgetPeriod;
  softLimitUsdMicros: number;
  hardLimitUsdMicros: number;
  consumedUsdMicrosThisPeriod: number;
  state: "ACTIVE" | "EXHAUSTED" | "DISABLED";
  createdByUserId: string;
  createdAtUtc: string;
};

// ===========================================================================
// 12. Verification-package manifest extensions
// ===========================================================================

export type DocumentIntelligenceManifestEntry = {
  evidenceId: string;
  totalRecords: number;
  perKind: Partial<Record<MediaIntelligenceRecordKind, number>>;
  perProvider: Partial<Record<MediaIntelligenceProvider, number>>;
  perConfidence: Partial<Record<IntelligenceConfidenceBand, number>>;
  correctionCount: number;
};

export type TranscriptIntelligenceManifestEntry = {
  evidenceId: string;
  totalSegments: number;
  totalSpeakers: number;
  totalDurationMs: number;
  perProvider: Partial<Record<MediaIntelligenceProvider, number>>;
  correctionCount: number;
};

export type ProviderManifestEntry = {
  provider: MediaIntelligenceProvider;
  callCount: number;
  unitsByOperation: Partial<
    Record<ProviderAdapterOperation, { unit: ProviderCostUnit; units: number }>
  >;
  estimatedCostUsdMicros: number;
};

export type ConfidenceManifestEntry = {
  evidenceId: string;
  perBand: Partial<Record<IntelligenceConfidenceBand, number>>;
  reviewedCount: number;
  acceptedCount: number;
  rejectedCount: number;
  correctedCount: number;
};

export type CorrectionHistoryManifestEntry = {
  evidenceId: string;
  totalCorrections: number;
  perKind: Partial<Record<ReviewerCorrectionKind, number>>;
  perAuthor: Record<string, number>;
};

// ===========================================================================
// 13. Standing limitations — surfaced on the executive + audit surfaces
// ===========================================================================

export const INTELLIGENCE_PROVENANCE_LIMITATIONS: ReadonlyArray<string> = [
  "AI_OUTPUT_IS_NEVER_GROUND_TRUTH",
  "REVIEWER_CORRECTIONS_ARE_HUMAN_JUDGEMENT",
  "PROVIDER_CONFIDENCE_IS_VENDOR_SPECIFIC_BUT_BANDED_CONSISTENTLY",
  "FINAL_CONFIDENCE_NEVER_OVERRIDES_HUMAN_DECISION",
];

// ===========================================================================
// 14. Cross-phase type re-exports used in projections (avoids drift)
// ===========================================================================

export type {
  RedactionConfidenceBand,
  RedactionDetectionKind,
  RedactionDetectionProvider,
};
