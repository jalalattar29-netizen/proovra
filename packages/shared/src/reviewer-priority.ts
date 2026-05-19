/**
 * Phase 25 — Reviewer queue priority scoring engine.
 *
 * Pure, deterministic, explainable priority score for a reviewer queue
 * row. Both runtimes (api orchestrator + reviewer reconciliation worker)
 * import this single source of truth so queue ordering never drifts.
 *
 * Hard rules:
 *   - Pure: no Prisma, no Node, no I/O. Browser-safe.
 *   - Deterministic: given the same `PriorityFacts`, the function always
 *     returns the same score + reason set. No Date.now() — callers
 *     supply `nowEpochMs` so tests are reproducible.
 *   - Bounded: score ∈ [0, 1000]. Reasons are bounded to a typed catalog
 *     so the UI can render explanation chips without a free-text leak.
 *   - Explainable: every score change carries a `PriorityReason` row
 *     naming the signal + the contribution. The UI shows operators
 *     "why this is at the top of the queue".
 *   - Real signals only — every field on `PriorityFacts` is something
 *     the API actually fetches. No synthetic / advertising priority.
 *   - Governance-first: legal-hold + SLA-breach + escalation-CRITICAL
 *     dominate any per-reviewer balancing signal so a reviewer's
 *     workload cap can never push a critical record down the queue.
 */

// =============================================================================
// Bounded reason catalog
// =============================================================================

export const PRIORITY_REASON_CODES = [
  "sla_breached",
  "sla_due_soon",
  "escalation_critical",
  "escalation_high",
  "escalation_open",
  "legal_hold_active",
  "immutable_drift_open",
  "package_blocked",
  "export_blocked",
  "evidence_priority_critical",
  "evidence_priority_high",
  "evidence_priority_normal",
  "external_intake_urgent",
  "stuck_workflow",
  "reviewer_overloaded",
  "reviewer_available",
  "workflow_age_old",
  "needs_info_stale",
  "case_critical",
] as const;

export type PriorityReasonCode = (typeof PRIORITY_REASON_CODES)[number];

export type PriorityReason = {
  code: PriorityReasonCode;
  /** Per-signal contribution to the score (always ≥ 0; reasons are
   *  cumulative). */
  delta: number;
  /** Operator-readable, bounded vocabulary. Safe to render. */
  label: string;
};

// =============================================================================
// Bounded input contract
// =============================================================================

export type WorkflowSlaStatus =
  | "ON_TRACK"
  | "DUE_SOON"
  | "BREACHED"
  | null;

export type EscalationSeverity =
  | "INFO"
  | "WARNING"
  | "HIGH"
  | "CRITICAL"
  | null;

export type EvidencePriorityHint = "CRITICAL" | "HIGH" | "NORMAL" | "LOW" | null;

export type PriorityFacts = {
  /** Caller-supplied current epoch ms — keeps the function pure. */
  nowEpochMs: number;
  /** Workflow's SLA status snapshot. */
  slaStatus: WorkflowSlaStatus;
  /** Most-severe open escalation linked to this workflow, if any. */
  activeEscalationSeverity: EscalationSeverity;
  /** Hold + governance flags. */
  hasActiveLegalHold: boolean;
  hasOpenImmutableDriftIncident: boolean;
  packageBlocked: boolean;
  exportBlocked: boolean;
  /** Evidence-side priority signal (intake-supplied or operator-set). */
  evidencePriority: EvidencePriorityHint;
  /** External-intake records get an urgency bump. */
  isExternalIntake: boolean;
  /** Stuck-workflow detection result (see
   *  `services/api/src/services/reviewer-ops/stuck-workflow-detector.service.ts`).
   *  Caller supplies the boolean; the priority engine does not re-detect. */
  isStuck: boolean;
  /**
   * Reviewer workload signal at the moment we compute. `null` when the
   * row is unassigned. Bounded categorical so we don't leak counts here.
   */
  assignedReviewerPressure: "available" | "balanced" | "overloaded" | null;
  /** Workflow age — drives the "stale workflow" component. */
  workflowCreatedAtEpochMs: number;
  /** Last reviewer touch — drives the "needs-info stale" component when
   *  the workflow is awaiting reviewer attention. */
  lastTouchAtEpochMs: number | null;
  /** Bounded case-criticality hint. */
  caseCriticality: "CRITICAL" | "HIGH" | "STANDARD" | null;
};

// =============================================================================
// Score envelope
// =============================================================================

export type PriorityScoreResult = {
  score: number;
  /** Bounded operator-readable label (e.g. "URGENT", "ATTENTION",
   *  "STANDARD"). Drives the UI severity chip. */
  band: "URGENT" | "ATTENTION" | "STANDARD";
  /** Cumulative reason rows. Sorted by `delta` descending so the UI
   *  can show the top-3 drivers without sorting itself. */
  reasons: ReadonlyArray<PriorityReason>;
};

const SCORE_MAX = 1000;
const BAND_URGENT_THRESHOLD = 600;
const BAND_ATTENTION_THRESHOLD = 300;

const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;

// =============================================================================
// Pure score engine
// =============================================================================

/**
 * Compute the priority score + reasons for a reviewer queue row.
 *
 * Cumulative model: each signal contributes a bounded delta. The final
 * score is clamped to [0, SCORE_MAX].
 */
export function computeReviewerPriority(
  facts: PriorityFacts,
): PriorityScoreResult {
  const reasons: PriorityReason[] = [];
  let score = 0;

  // ---------------------------------------------------------------------------
  // Governance-first: legal hold + SLA + escalation dominate everything.
  // ---------------------------------------------------------------------------
  if (facts.hasActiveLegalHold) {
    const delta = 250;
    score += delta;
    reasons.push({
      code: "legal_hold_active",
      delta,
      label: "Active legal hold",
    });
  }
  if (facts.slaStatus === "BREACHED") {
    const delta = 220;
    score += delta;
    reasons.push({
      code: "sla_breached",
      delta,
      label: "Reviewer SLA breached",
    });
  } else if (facts.slaStatus === "DUE_SOON") {
    const delta = 90;
    score += delta;
    reasons.push({
      code: "sla_due_soon",
      delta,
      label: "Reviewer SLA approaching deadline",
    });
  }

  // ---------------------------------------------------------------------------
  // Escalation severity.
  // ---------------------------------------------------------------------------
  if (facts.activeEscalationSeverity === "CRITICAL") {
    const delta = 200;
    score += delta;
    reasons.push({
      code: "escalation_critical",
      delta,
      label: "Open CRITICAL escalation",
    });
  } else if (facts.activeEscalationSeverity === "HIGH") {
    const delta = 110;
    score += delta;
    reasons.push({
      code: "escalation_high",
      delta,
      label: "Open HIGH escalation",
    });
  } else if (
    facts.activeEscalationSeverity === "WARNING" ||
    facts.activeEscalationSeverity === "INFO"
  ) {
    const delta = 40;
    score += delta;
    reasons.push({
      code: "escalation_open",
      delta,
      label: "Open escalation on this workflow",
    });
  }

  // ---------------------------------------------------------------------------
  // Governance blockers — package / export / immutable drift.
  // ---------------------------------------------------------------------------
  if (facts.hasOpenImmutableDriftIncident) {
    const delta = 120;
    score += delta;
    reasons.push({
      code: "immutable_drift_open",
      delta,
      label: "Storage governance drift requires attention",
    });
  }
  if (facts.packageBlocked) {
    const delta = 60;
    score += delta;
    reasons.push({
      code: "package_blocked",
      delta,
      label: "Verification package blocked",
    });
  }
  if (facts.exportBlocked) {
    const delta = 60;
    score += delta;
    reasons.push({
      code: "export_blocked",
      delta,
      label: "Compliance export blocked",
    });
  }

  // ---------------------------------------------------------------------------
  // Evidence + case priority hints.
  // ---------------------------------------------------------------------------
  if (facts.evidencePriority === "CRITICAL") {
    const delta = 90;
    score += delta;
    reasons.push({
      code: "evidence_priority_critical",
      delta,
      label: "Evidence flagged CRITICAL",
    });
  } else if (facts.evidencePriority === "HIGH") {
    const delta = 50;
    score += delta;
    reasons.push({
      code: "evidence_priority_high",
      delta,
      label: "Evidence flagged HIGH",
    });
  } else if (facts.evidencePriority === "NORMAL") {
    const delta = 10;
    score += delta;
    reasons.push({
      code: "evidence_priority_normal",
      delta,
      label: "Evidence priority NORMAL",
    });
  }
  if (facts.caseCriticality === "CRITICAL") {
    const delta = 80;
    score += delta;
    reasons.push({
      code: "case_critical",
      delta,
      label: "Case flagged CRITICAL",
    });
  }
  if (facts.isExternalIntake) {
    const delta = 30;
    score += delta;
    reasons.push({
      code: "external_intake_urgent",
      delta,
      label: "External intake (urgency bump)",
    });
  }

  // ---------------------------------------------------------------------------
  // Operational pressure — stuck workflows + reviewer load + age.
  // ---------------------------------------------------------------------------
  if (facts.isStuck) {
    const delta = 80;
    score += delta;
    reasons.push({
      code: "stuck_workflow",
      delta,
      label: "Workflow stuck — no recent operator action",
    });
  }
  // Stale workflow: > 14 days old without resolution.
  const ageMs = Math.max(
    0,
    facts.nowEpochMs - facts.workflowCreatedAtEpochMs,
  );
  if (ageMs > 14 * ONE_DAY_MS) {
    const delta = 50;
    score += delta;
    reasons.push({
      code: "workflow_age_old",
      delta,
      label: "Workflow open for more than 14 days",
    });
  }
  // Reviewer awaiting info → bump when last touch is > 3 days old.
  if (facts.lastTouchAtEpochMs != null) {
    const sinceLastTouch = Math.max(
      0,
      facts.nowEpochMs - facts.lastTouchAtEpochMs,
    );
    if (sinceLastTouch > 3 * ONE_DAY_MS) {
      const delta = 40;
      score += delta;
      reasons.push({
        code: "needs_info_stale",
        delta,
        label: "No reviewer touch in 3+ days",
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Reviewer workload balancing — small adjustments only. Critical
  // governance signals already dominate; the balance can't suppress.
  // ---------------------------------------------------------------------------
  if (facts.assignedReviewerPressure === "overloaded") {
    const delta = 30;
    score += delta;
    reasons.push({
      code: "reviewer_overloaded",
      delta,
      label: "Assigned reviewer is overloaded",
    });
  } else if (facts.assignedReviewerPressure === "available") {
    // Small positive nudge — easy to reassign / progress.
    const delta = 5;
    score += delta;
    reasons.push({
      code: "reviewer_available",
      delta,
      label: "Reviewer has capacity",
    });
  }

  // Sort the reasons by descending delta so the UI can render the top-3
  // drivers without re-sorting.
  reasons.sort((a, b) => b.delta - a.delta);

  const clamped = Math.max(0, Math.min(SCORE_MAX, score));
  const band: PriorityScoreResult["band"] =
    clamped >= BAND_URGENT_THRESHOLD
      ? "URGENT"
      : clamped >= BAND_ATTENTION_THRESHOLD
        ? "ATTENTION"
        : "STANDARD";

  return { score: clamped, band, reasons };
}

// =============================================================================
// Bounded explanation chip for the UI. Returns the top-N reasons formatted
// as a single short label string — useful for compact rendering.
// =============================================================================

export function summarisePriorityReasons(
  reasons: ReadonlyArray<PriorityReason>,
  maxReasons = 3,
): string {
  if (reasons.length === 0) return "No priority signals";
  const top = reasons.slice(0, maxReasons);
  return top.map((r) => r.label).join(" · ");
}
