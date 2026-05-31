/**
 * PROOVRA Phase 3B Enterprise Closure — shared contracts.
 *
 * Closes the audit gaps identified after Phase 3B by adding the
 * bounded vocabularies + projection shapes the closure introduces:
 *
 *   * Selectable historical time ranges (24h / 7d / 30d / 90d / 12m).
 *   * Trend math primitives (current / previous / delta / direction).
 *   * Provider / reviewer / team quality projections.
 *   * Correction version chain projection.
 *   * Budget breach projection + spend-by-scope projection.
 *   * Canonical lifecycle audit categories + extended activity codes.
 *
 * Hard rules:
 *   * Append-only enums.
 *   * NEVER PII — bounded counts + bounded ids only.
 *   * Re-export from `packages/shared/src/index.ts` so every
 *     runtime consumes the same vocabulary.
 */

import type {
  IntelligenceConfidenceBand,
  MediaIntelligenceProvider,
  ProviderBudgetPeriod,
  ProviderBudgetScope,
  ReviewerCorrectionKind,
  ReviewerCorrectionState,
} from "./media-intelligence-platform.js";

// ===========================================================================
// 1. Historical time ranges + trend math primitives
// ===========================================================================

export const EXECUTIVE_METRICS_RANGES = [
  "24h",
  "7d",
  "30d",
  "90d",
  "12m",
] as const;
export type ExecutiveMetricsRange = (typeof EXECUTIVE_METRICS_RANGES)[number];

/**
 * Bounded window-length helper. Returns the window in milliseconds.
 * Used by the executive aggregator + tests so both runtimes agree.
 */
export function rangeWindowMs(range: ExecutiveMetricsRange): number {
  switch (range) {
    case "24h":
      return 24 * 60 * 60 * 1000;
    case "7d":
      return 7 * 24 * 60 * 60 * 1000;
    case "30d":
      return 30 * 24 * 60 * 60 * 1000;
    case "90d":
      return 90 * 24 * 60 * 60 * 1000;
    case "12m":
      return 365 * 24 * 60 * 60 * 1000;
  }
}

export const TREND_DIRECTIONS = ["UP", "DOWN", "STABLE"] as const;
export type TrendDirection = (typeof TREND_DIRECTIONS)[number];

/**
 * Bounded trend classifier. STABLE if absolute delta % is ≤ 1.0.
 * Otherwise UP / DOWN. Cheap and deterministic.
 */
export function classifyTrend(
  current: number,
  previous: number,
): TrendDirection {
  if (previous === 0) {
    if (current === 0) return "STABLE";
    return current > 0 ? "UP" : "DOWN";
  }
  const deltaPct = ((current - previous) / Math.abs(previous)) * 100;
  if (Math.abs(deltaPct) <= 1) return "STABLE";
  return deltaPct > 0 ? "UP" : "DOWN";
}

/**
 * Bounded scalar metric with trend metadata. The executive aggregator
 * projects every numeric metric as one of these so the dashboard
 * renders identical chrome around every tile.
 */
export type TrendMetric = {
  current: number;
  previous: number;
  delta: number;
  deltaPct: number;
  direction: TrendDirection;
};

export function buildTrendMetric(current: number, previous: number): TrendMetric {
  const delta = current - previous;
  const deltaPct =
    previous === 0 ? (current === 0 ? 0 : 100) : (delta / Math.abs(previous)) * 100;
  return {
    current,
    previous,
    delta,
    deltaPct: Math.round(deltaPct * 10) / 10,
    direction: classifyTrend(current, previous),
  };
}

// ===========================================================================
// 2. Executive trend projection — superset of the snapshot shape.
// ===========================================================================

export type ExecutiveCaptureTrend = {
  captures: TrendMetric;
  captureSuccessRatePct: TrendMetric;
  mobileSignedRatio: TrendMetric;
  highTrustCaptures: TrendMetric;
};

export type ExecutiveReviewTrend = {
  reviewed: TrendMetric;
  approvalRatePct: TrendMetric;
  qcAccuracyPct: TrendMetric;
  averageReviewDurationMs: TrendMetric;
};

export type ExecutiveEvidenceTrend = {
  totalEvidence: TrendMetric;
  storageBytes: TrendMetric;
};

export type ExecutiveVerificationTrend = {
  verifications: TrendMetric;
  publicVerifyViews: TrendMetric;
  successRatePct: TrendMetric;
};

export type ExecutiveAiTrend = {
  providerCalls: TrendMetric;
  estimatedCostUsd: TrendMetric;
  corrections: TrendMetric;
  averageProviderConfidence: TrendMetric;
};

export type ExecutiveSlaTrend = {
  jobFailureRatePct: TrendMetric;
  providerAvailabilityPct: TrendMetric;
};

export type ExecutiveCostTrend = {
  totalCostUsd: TrendMetric;
  blockedCalls: TrendMetric;
  budgetBreaches: TrendMetric;
};

export type ExecutiveCorrectionTrend = {
  created: TrendMetric;
  accepted: TrendMetric;
  reverted: TrendMetric;
  superseded: TrendMetric;
};

export const EXECUTIVE_TRENDS_SCHEMA_VERSION =
  "PROOVRA_EXECUTIVE_TRENDS_V1" as const;

export type ExecutiveTrendsProjection = {
  schemaVersion: typeof EXECUTIVE_TRENDS_SCHEMA_VERSION;
  generatedAtUtc: string;
  teamId: string;
  range: ExecutiveMetricsRange;
  windowStartUtc: string;
  windowEndUtc: string;
  previousWindowStartUtc: string;
  previousWindowEndUtc: string;
  capture: ExecutiveCaptureTrend;
  review: ExecutiveReviewTrend;
  evidence: ExecutiveEvidenceTrend;
  verification: ExecutiveVerificationTrend;
  ai: ExecutiveAiTrend;
  sla: ExecutiveSlaTrend;
  cost: ExecutiveCostTrend;
  corrections: ExecutiveCorrectionTrend;
  limitations: ReadonlyArray<string>;
};

// ===========================================================================
// 3. Provider quality projection
// ===========================================================================

export type ProviderQualityRow = {
  provider: MediaIntelligenceProvider;
  callCount: number;
  failureCount: number;
  failureRatePct: number;
  recordCount: number;
  correctionCount: number;
  correctionRatePct: number;
  acceptanceCount: number;
  acceptanceRatePct: number;
  rejectionCount: number;
  rejectionRatePct: number;
  revertCount: number;
  revertRatePct: number;
  /** Mean of provider raw confidence in the window. */
  averageProviderConfidence: number;
  /**
   * Confidence accuracy = 1 − (correctionCount / recordCount). Bounded
   * to [0, 1]. A provider whose records are always corrected scores 0,
   * and one whose records are never corrected scores 1.
   */
  confidenceAccuracy: number;
  /**
   * Ranking score in [0, 1]. Combines confidence accuracy + (1 −
   * failure rate). Larger is better.
   */
  rankingScore: number;
  rank: number;
  estimatedCostUsdMicros: number;
};

export type ProviderQualityProjection = {
  generatedAtUtc: string;
  teamId: string;
  range: ExecutiveMetricsRange;
  rows: ReadonlyArray<ProviderQualityRow>;
};

// ===========================================================================
// 4. Reviewer quality projection
// ===========================================================================

export type ReviewerQualityRow = {
  reviewerUserId: string;
  correctionsAuthored: number;
  correctionsAccepted: number;
  correctionsReverted: number;
  acceptanceRatePct: number;
  revertRatePct: number;
  /**
   * Bounded estimate (ms) of the median elapsed time between
   * `createdAt` of a correction and its `acceptedAt`.
   */
  medianAcceptLatencyMs: number;
  /**
   * Agreement rate = 1 − (acceptedCorrectionsByOthers /
   * acceptedCorrectionsAuthored). Reviewers whose own corrections are
   * frequently superseded by others score lower.
   */
  agreementRatePct: number;
  /**
   * Composite quality score in [0, 100]. Bounded weighting of
   * acceptanceRatePct * 0.5 + agreementRatePct * 0.3 +
   * (100 − revertRatePct) * 0.2.
   */
  qualityScore: number;
};

export type ReviewerQualityProjection = {
  generatedAtUtc: string;
  teamId: string;
  range: ExecutiveMetricsRange;
  rows: ReadonlyArray<ReviewerQualityRow>;
};

// ===========================================================================
// 5. Team / workspace / case quality projection
// ===========================================================================

export type TeamQualityRow = {
  /** Bounded scope this row aggregates. */
  scope: "TEAM" | "WORKSPACE" | "CASE";
  /** UUID of the scope target (teamId if scope=TEAM/WORKSPACE). */
  scopeTargetId: string;
  recordCount: number;
  correctionCount: number;
  /** corrections per 100 records — bounded operator metric. */
  correctionDensity: number;
  acceptedCount: number;
  rejectedCount: number;
  averageProviderConfidence: number;
  reviewQualityScore: number;
};

export type TeamQualityProjection = {
  generatedAtUtc: string;
  teamId: string;
  range: ExecutiveMetricsRange;
  rows: ReadonlyArray<TeamQualityRow>;
};

// ===========================================================================
// 6. Correction version chain projection
// ===========================================================================

export type CorrectionVersionRow = {
  id: string;
  versionNumber: number;
  parentCorrectionId: string | null;
  supersedesCorrectionId: string | null;
  supersededByCorrectionId: string | null;
  kind: ReviewerCorrectionKind;
  state: ReviewerCorrectionState;
  authoredByUserId: string;
  acceptedByUserId: string | null;
  createdAtUtc: string;
  acceptedAtUtc: string | null;
  revertedAtUtc: string | null;
  supersededAtUtc: string | null;
  rationale: string | null;
  patchPreview: Record<string, unknown>;
};

export type CorrectionVersionChainProjection = {
  recordId: string;
  evidenceId: string;
  versions: ReadonlyArray<CorrectionVersionRow>;
  /** Bounded immutability assertion — once written, never rewritten. */
  immutable: true;
};

// ===========================================================================
// 7. Budget breach + spend-by-scope projection
// ===========================================================================

export type BudgetBreachRow = {
  id: string;
  budgetId: string;
  threshold: "SOFT" | "HARD";
  consumedUsdMicros: number;
  occurredAtUtc: string;
  budgetScope: ProviderBudgetScope;
  budgetScopeTargetId: string | null;
  budgetPeriod: ProviderBudgetPeriod;
  budgetProvider: MediaIntelligenceProvider | null;
  softLimitUsdMicros: number;
  hardLimitUsdMicros: number;
};

export type BudgetBreachProjection = {
  generatedAtUtc: string;
  teamId: string;
  range: ExecutiveMetricsRange;
  totalBreaches: number;
  softBreaches: number;
  hardBreaches: number;
  rows: ReadonlyArray<BudgetBreachRow>;
};

export type BudgetSpendRow = {
  budgetId: string;
  scope: ProviderBudgetScope;
  scopeTargetId: string | null;
  provider: MediaIntelligenceProvider | null;
  period: ProviderBudgetPeriod;
  softLimitUsdMicros: number;
  hardLimitUsdMicros: number;
  consumedUsdMicrosThisPeriod: number;
  remainingUsdMicros: number;
  /**
   * Bounded projection of consumption if the current burn-rate
   * continues to the end of the period. Honest — uses period
   * proportion × consumed.
   */
  projectedSpendUsdMicros: number;
  thresholdStatus: "OK" | "WARN" | "BLOCK" | "EXHAUSTED";
};

export type BudgetSpendProjection = {
  generatedAtUtc: string;
  teamId: string;
  rows: ReadonlyArray<BudgetSpendRow>;
};

// ===========================================================================
// 8. Canonical lifecycle audit codes (extended)
// ===========================================================================

/**
 * Extended activity codes the lifecycle emitter writes. Superset of
 * `MEDIA_INTELLIGENCE_ACTIVITY_CODES` — keeps the Phase 3B base
 * intact and adds the new closure codes.
 */
export const INTELLIGENCE_LIFECYCLE_CODES = [
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
  "CORRECTION_SUPERSEDED",
  // Provider lifecycle
  "PROVIDER_CALL_STARTED",
  "PROVIDER_CALL_COMPLETED",
  "PROVIDER_CALL_FAILED",
  "PROVIDER_CALL_REFUSED_BUDGET",
  "PROVIDER_CALL_REFUSED_POLICY",
  // Budget lifecycle (extended for closure)
  "BUDGET_CREATED",
  "BUDGET_UPDATED",
  "BUDGET_SOFT_LIMIT_REACHED",
  "BUDGET_HARD_LIMIT_REACHED",
  "BUDGET_BLOCKED",
  "BUDGET_OVERRIDE",
  "BUDGET_RESET",
  // Phase 4B Final Closure — policy violations + archive + destruction + chain transfer + webhook
  "POLICY_VIOLATION_ENTITLEMENT",
  "POLICY_VIOLATION_LEGAL_HOLD",
  "POLICY_VIOLATION_RETENTION",
  "POLICY_VIOLATION_QUOTA",
  "ARCHIVE_TRANSITION_REQUESTED",
  "ARCHIVE_TRANSITION_STARTED",
  "ARCHIVE_TRANSITION_COMPLETED",
  "ARCHIVE_TRANSITION_FAILED",
  "ARCHIVE_RESTORE_REQUESTED",
  "ARCHIVE_RESTORE_COMPLETED",
  "DESTRUCTION_EXECUTED",
  "DESTRUCTION_FAILED",
  "CHAIN_TRANSFER_CUSTODY_EXTENDED",
  "WEBHOOK_DELIVERED",
  "WEBHOOK_FAILED",
  "WEBHOOK_DEAD_LETTERED",
] as const;
export type IntelligenceLifecycleCode =
  (typeof INTELLIGENCE_LIFECYCLE_CODES)[number];

/**
 * Bounded category vocabulary the audit federator uses to bucket
 * lifecycle events when surfacing them to the operator.
 */
export const INTELLIGENCE_LIFECYCLE_CATEGORIES = [
  "RECORD_LIFECYCLE",
  "CORRECTION_LIFECYCLE",
  "PROVIDER_LIFECYCLE",
  "BUDGET_LIFECYCLE",
] as const;
export type IntelligenceLifecycleCategory =
  (typeof INTELLIGENCE_LIFECYCLE_CATEGORIES)[number];

export function classifyLifecycleCategory(
  code: IntelligenceLifecycleCode,
): IntelligenceLifecycleCategory {
  if (code.startsWith("RECORD_")) return "RECORD_LIFECYCLE";
  if (code.startsWith("CORRECTION_")) return "CORRECTION_LIFECYCLE";
  if (code.startsWith("PROVIDER_")) return "PROVIDER_LIFECYCLE";
  return "BUDGET_LIFECYCLE";
}

// ===========================================================================
// 9. Verification-package manifest extensions
// ===========================================================================

export type CorrectionVersionChainManifestEntry = {
  evidenceId: string;
  chains: ReadonlyArray<{
    recordId: string;
    versions: ReadonlyArray<{
      id: string;
      versionNumber: number;
      kind: ReviewerCorrectionKind;
      state: ReviewerCorrectionState;
      authoredByUserId: string;
      acceptedByUserId: string | null;
      createdAtUtc: string;
      acceptedAtUtc: string | null;
      revertedAtUtc: string | null;
      supersededAtUtc: string | null;
      parentCorrectionId: string | null;
      supersedesCorrectionId: string | null;
    }>;
  }>;
  totalVersions: number;
};

export type ProviderQualityManifestEntry = {
  generatedAtUtc: string;
  rangeWindowMs: number;
  rows: ReadonlyArray<{
    provider: MediaIntelligenceProvider;
    callCount: number;
    failureRatePct: number;
    correctionRatePct: number;
    confidenceAccuracy: number;
    rankingScore: number;
    rank: number;
  }>;
};

export type BudgetGovernanceManifestEntry = {
  generatedAtUtc: string;
  rangeWindowMs: number;
  totalBreaches: number;
  softBreaches: number;
  hardBreaches: number;
  blockedCalls: number;
};

export type AuditEventsManifestEntry = {
  evidenceId: string;
  totalEvents: number;
  perCategory: Partial<Record<IntelligenceLifecycleCategory, number>>;
  perCode: Partial<Record<IntelligenceLifecycleCode, number>>;
};

// ===========================================================================
// 10. Bounded re-exports for downstream type-narrowing.
// ===========================================================================

export type {
  IntelligenceConfidenceBand,
  MediaIntelligenceProvider,
  ProviderBudgetPeriod,
  ProviderBudgetScope,
  ReviewerCorrectionKind,
  ReviewerCorrectionState,
};
