import test from "node:test";
import assert from "node:assert/strict";

// Phase 25 — Reviewer Operations Intelligence + SLA Engine
// shared-types contract tests.
//
// Coverage:
//   - lifecycle catalog completeness
//   - lifecycle transition matrix (allowed + blocked)
//   - escalation reason / status catalog completeness
//   - escalation status transition matrix
//   - queue type catalog membership
//   - SLA dimension computation (HEALTHY / DUE_SOON / BREACHED / PAUSED /
//     COMPLETED / ESCALATED)
//   - SLA rollup precedence (BREACHED > ESCALATED > DUE_SOON > HEALTHY)
//   - capacity score heuristic monotonicity (more load → lower score)
//   - deriveLifecycleState handles escalation override
//   - allowed-label catalog excludes overclaim phrases
//   - forbidden-overclaim re-export still works

import {
  REVIEWER_OPS_ALLOWED_LABELS,
  REVIEWER_OPS_DEFAULT_SLA_POLICY,
  REVIEWER_OPS_LIFECYCLE_STATES,
  REVIEWER_OPS_QUEUE_TYPES,
  REVIEWER_OPS_SLA_STATES,
  REVIEW_ESCALATION_REASONS,
  REVIEW_ESCALATION_STATUSES,
  REVIEW_ESCALATION_TERMINAL,
  REVIEW_SLA_DIMENSIONS,
  ReviewEscalationReasonSchema,
  ReviewEscalationStatusSchema,
  ReviewerOpsLifecycleStateSchema,
  ReviewerOpsQueueTypeSchema,
  ReviewerOpsSlaStateSchema,
  computeReviewerCapacityScore,
  computeReviewerOpsSlaSnapshot,
  deriveLifecycleState,
  isAllowedEscalationStatusTransition,
  isAllowedLifecycleTransition,
  isAllowedReviewerOpsLabel,
  isTerminalReviewEscalationStatus,
  lifecycleTransitionPassesStageGate,
  listAllowedEscalationStatusTransitions,
  listAllowedLifecycleTransitions,
  rollupReviewerOpsSlaState,
  stringContainsForbiddenOverclaim,
} from "../dist/index.js";

// -----------------------------------------------------------------------------
// Catalog completeness
// -----------------------------------------------------------------------------

test("REVIEWER_OPS_LIFECYCLE_STATES matches the Phase 25 brief", () => {
  assert.deepEqual([...REVIEWER_OPS_LIFECYCLE_STATES].sort(), [
    "APPROVED",
    "ARCHIVED",
    "ASSIGNED",
    "DRAFT",
    "ESCALATED",
    "IN_REVIEW",
    "NEEDS_INFORMATION",
    "QUEUED",
    "REJECTED",
    "SUBMITTED",
  ]);
});

test("ReviewerOpsLifecycleStateSchema rejects unknown states", () => {
  assert.equal(
    ReviewerOpsLifecycleStateSchema.safeParse("UNKNOWN").success,
    false,
  );
  assert.equal(
    ReviewerOpsLifecycleStateSchema.safeParse("APPROVED").success,
    true,
  );
});

test("REVIEW_ESCALATION_REASONS covers the brief's enumeration", () => {
  for (const r of [
    "NO_REVIEWER_ASSIGNED",
    "REVIEW_OVERDUE",
    "FIRST_REVIEW_OVERDUE",
    "COMPLETION_OVERDUE",
    "WORKFLOW_STALLED",
    "EVIDENCE_REQUEST_UNRESOLVED",
    "INTEGRITY_RISK",
    "VERIFICATION_MISMATCH",
    "REVIEWER_INACTIVE",
    "GOVERNANCE_BLOCKED",
    "REPEATED_REJECTION_LOOP",
  ]) {
    assert.equal(
      REVIEW_ESCALATION_REASONS.includes(r),
      true,
      `missing reason ${r}`,
    );
  }
});

test("ReviewEscalationReasonSchema enforces catalog", () => {
  assert.equal(ReviewEscalationReasonSchema.safeParse("BOGUS").success, false);
});

test("REVIEW_ESCALATION_STATUSES matches the brief", () => {
  assert.deepEqual([...REVIEW_ESCALATION_STATUSES].sort(), [
    "ACKNOWLEDGED",
    "OPEN",
    "REASSIGNED",
    "RESOLVED",
    "SUPPRESSED",
  ]);
});

test("REVIEW_ESCALATION_TERMINAL contains RESOLVED + SUPPRESSED", () => {
  assert.equal(REVIEW_ESCALATION_TERMINAL.has("RESOLVED"), true);
  assert.equal(REVIEW_ESCALATION_TERMINAL.has("SUPPRESSED"), true);
  assert.equal(REVIEW_ESCALATION_TERMINAL.has("OPEN"), false);
  assert.equal(isTerminalReviewEscalationStatus("RESOLVED"), true);
  assert.equal(isTerminalReviewEscalationStatus("OPEN"), false);
});

test("REVIEWER_OPS_QUEUE_TYPES catalog is exhaustive", () => {
  for (const q of [
    "MY_REVIEWS",
    "UNASSIGNED",
    "OVERDUE",
    "DUE_SOON",
    "ESCALATED",
    "HIGH_PRIORITY",
    "LEGAL_HOLD",
    "WORKFLOW_BLOCKED",
    "INTEGRITY_RISK",
    "EXTERNAL_INTAKE",
    "COMPLETED_RECENTLY",
  ]) {
    assert.equal(REVIEWER_OPS_QUEUE_TYPES.includes(q), true);
    assert.equal(ReviewerOpsQueueTypeSchema.safeParse(q).success, true);
  }
});

test("REVIEW_SLA_DIMENSIONS = ASSIGNMENT, FIRST_REVIEW, COMPLETION, ESCALATION", () => {
  assert.deepEqual([...REVIEW_SLA_DIMENSIONS].sort(), [
    "ASSIGNMENT",
    "COMPLETION",
    "ESCALATION",
    "FIRST_REVIEW",
  ]);
});

test("REVIEWER_OPS_SLA_STATES catalog complete", () => {
  for (const s of [
    "HEALTHY",
    "DUE_SOON",
    "BREACHED",
    "ESCALATED",
    "BLOCKED",
    "PAUSED",
    "COMPLETED",
  ]) {
    assert.equal(REVIEWER_OPS_SLA_STATES.includes(s), true);
    assert.equal(ReviewerOpsSlaStateSchema.safeParse(s).success, true);
  }
});

// -----------------------------------------------------------------------------
// Lifecycle transition matrix
// -----------------------------------------------------------------------------

test("DRAFT → SUBMITTED is allowed; SUBMITTED → APPROVED is blocked", () => {
  assert.equal(isAllowedLifecycleTransition("DRAFT", "SUBMITTED"), true);
  assert.equal(isAllowedLifecycleTransition("SUBMITTED", "APPROVED"), false);
});

test("IN_REVIEW allows APPROVED, REJECTED, NEEDS_INFORMATION, ESCALATED", () => {
  for (const to of ["APPROVED", "REJECTED", "NEEDS_INFORMATION", "ESCALATED"]) {
    assert.equal(
      isAllowedLifecycleTransition("IN_REVIEW", to),
      true,
      `IN_REVIEW → ${to}`,
    );
  }
});

test("ARCHIVED is terminal (no outgoing transitions)", () => {
  for (const to of REVIEWER_OPS_LIFECYCLE_STATES) {
    if (to === "ARCHIVED") {
      assert.equal(isAllowedLifecycleTransition("ARCHIVED", "ARCHIVED"), true);
      continue;
    }
    assert.equal(
      isAllowedLifecycleTransition("ARCHIVED", to),
      false,
      `ARCHIVED → ${to} should be blocked`,
    );
  }
});

test("APPROVED cannot flip directly to REJECTED", () => {
  assert.equal(isAllowedLifecycleTransition("APPROVED", "REJECTED"), false);
});

test("REJECTED → IN_REVIEW is the reopen path (allowed)", () => {
  assert.equal(isAllowedLifecycleTransition("REJECTED", "IN_REVIEW"), true);
});

test("listAllowedLifecycleTransitions returns the matrix row", () => {
  const allowed = listAllowedLifecycleTransitions("QUEUED");
  assert.equal(allowed.includes("ASSIGNED"), true);
  assert.equal(allowed.includes("ARCHIVED"), true);
  assert.equal(allowed.includes("APPROVED"), false);
});

test("lifecycleTransitionPassesStageGate cross-checks Phase 13 stage matrix", () => {
  // QUEUED → ASSIGNED is allowed at both layers.
  assert.equal(lifecycleTransitionPassesStageGate("QUEUED", "ASSIGNED"), true);
  // CLOSED → APPROVED_INTERNAL is blocked at the stage layer.
  assert.equal(
    lifecycleTransitionPassesStageGate("CLOSED", "APPROVED_INTERNAL"),
    false,
  );
});

// -----------------------------------------------------------------------------
// Escalation status transitions
// -----------------------------------------------------------------------------

test("OPEN → ACKNOWLEDGED + RESOLVED + SUPPRESSED allowed; RESOLVED → OPEN blocked", () => {
  assert.equal(isAllowedEscalationStatusTransition("OPEN", "ACKNOWLEDGED"), true);
  assert.equal(isAllowedEscalationStatusTransition("OPEN", "RESOLVED"), true);
  assert.equal(isAllowedEscalationStatusTransition("OPEN", "SUPPRESSED"), true);
  assert.equal(isAllowedEscalationStatusTransition("RESOLVED", "OPEN"), false);
  assert.equal(
    isAllowedEscalationStatusTransition("SUPPRESSED", "ACKNOWLEDGED"),
    false,
  );
});

test("listAllowedEscalationStatusTransitions returns the matrix row", () => {
  const allowed = listAllowedEscalationStatusTransitions("ACKNOWLEDGED");
  assert.equal(allowed.includes("RESOLVED"), true);
  assert.equal(allowed.includes("REASSIGNED"), true);
});

// -----------------------------------------------------------------------------
// deriveLifecycleState
// -----------------------------------------------------------------------------

test("deriveLifecycleState: open escalation always wins", () => {
  assert.equal(deriveLifecycleState("IN_REVIEW", true), "ESCALATED");
  assert.equal(deriveLifecycleState("APPROVED_INTERNAL", true), "ESCALATED");
});

test("deriveLifecycleState: maps Phase 13 stages to Phase 25 lifecycle states", () => {
  assert.equal(deriveLifecycleState("QUEUED", false), "QUEUED");
  assert.equal(deriveLifecycleState("ASSIGNED", false), "ASSIGNED");
  assert.equal(deriveLifecycleState("IN_REVIEW", false), "IN_REVIEW");
  assert.equal(deriveLifecycleState("NEEDS_MORE_INFO", false), "NEEDS_INFORMATION");
  assert.equal(deriveLifecycleState("APPROVED_INTERNAL", false), "APPROVED");
  assert.equal(deriveLifecycleState("REJECTED_INSUFFICIENT", false), "REJECTED");
  assert.equal(deriveLifecycleState("CLOSED", false), "ARCHIVED");
});

// -----------------------------------------------------------------------------
// SLA snapshot computation
// -----------------------------------------------------------------------------

const NOW = new Date("2026-05-18T12:00:00.000Z");

test("SLA snapshot: COMPLETED state when completedAt is set", () => {
  const snaps = computeReviewerOpsSlaSnapshot({
    nowUtc: NOW,
    assignmentDueAtUtc: new Date(NOW.getTime() + 3600_000),
    assignedAtUtc: new Date(NOW.getTime() - 3600_000),
  });
  const assignmentSnap = snaps.find((s) => s.dimension === "ASSIGNMENT");
  assert.equal(assignmentSnap?.state, "COMPLETED");
});

test("SLA snapshot: HEALTHY when due-at is far in the future", () => {
  const snaps = computeReviewerOpsSlaSnapshot({
    nowUtc: NOW,
    firstReviewDueAtUtc: new Date(NOW.getTime() + 24 * 3600_000),
    dueSoonMinutes: 60,
  });
  const s = snaps.find((x) => x.dimension === "FIRST_REVIEW");
  assert.equal(s?.state, "HEALTHY");
});

test("SLA snapshot: DUE_SOON within the warning window", () => {
  const snaps = computeReviewerOpsSlaSnapshot({
    nowUtc: NOW,
    firstReviewDueAtUtc: new Date(NOW.getTime() + 30 * 60_000),
    dueSoonMinutes: 60,
  });
  const s = snaps.find((x) => x.dimension === "FIRST_REVIEW");
  assert.equal(s?.state, "DUE_SOON");
});

test("SLA snapshot: BREACHED when past due-at", () => {
  const snaps = computeReviewerOpsSlaSnapshot({
    nowUtc: NOW,
    completionDueAtUtc: new Date(NOW.getTime() - 3600_000),
    dueSoonMinutes: 60,
  });
  const s = snaps.find((x) => x.dimension === "COMPLETION");
  assert.equal(s?.state, "BREACHED");
  assert.equal(s?.breachDurationMs && s.breachDurationMs > 0, true);
});

test("SLA snapshot: PAUSED overrides everything except COMPLETED", () => {
  const snaps = computeReviewerOpsSlaSnapshot({
    nowUtc: NOW,
    paused: true,
    completionDueAtUtc: new Date(NOW.getTime() - 3600_000),
  });
  const s = snaps.find((x) => x.dimension === "COMPLETION");
  assert.equal(s?.state, "PAUSED");
});

test("SLA snapshot: open escalation promotes FIRST_REVIEW + COMPLETION to ESCALATED", () => {
  const snaps = computeReviewerOpsSlaSnapshot({
    nowUtc: NOW,
    hasOpenEscalation: true,
    firstReviewDueAtUtc: new Date(NOW.getTime() + 3600_000),
    completionDueAtUtc: new Date(NOW.getTime() + 8 * 3600_000),
    assignmentDueAtUtc: new Date(NOW.getTime() + 3600_000),
    assignedAtUtc: new Date(NOW.getTime() - 1000),
  });
  const fr = snaps.find((x) => x.dimension === "FIRST_REVIEW");
  const co = snaps.find((x) => x.dimension === "COMPLETION");
  assert.equal(fr?.state, "ESCALATED");
  assert.equal(co?.state, "ESCALATED");
});

test("SLA snapshot: HEALTHY when dueAt not set (no SLA configured)", () => {
  const snaps = computeReviewerOpsSlaSnapshot({ nowUtc: NOW });
  for (const s of snaps) {
    assert.equal(s.state, "HEALTHY");
    assert.equal(s.dueAtUtc, null);
  }
});

// -----------------------------------------------------------------------------
// SLA rollup precedence
// -----------------------------------------------------------------------------

test("rollupReviewerOpsSlaState: BREACHED wins over DUE_SOON + HEALTHY", () => {
  const r = rollupReviewerOpsSlaState([
    { dimension: "ASSIGNMENT", dueAtUtc: null, dueSoonAtUtc: null, state: "HEALTHY", timeRemainingMs: null, breachDurationMs: null },
    { dimension: "FIRST_REVIEW", dueAtUtc: null, dueSoonAtUtc: null, state: "DUE_SOON", timeRemainingMs: null, breachDurationMs: null },
    { dimension: "COMPLETION", dueAtUtc: null, dueSoonAtUtc: null, state: "BREACHED", timeRemainingMs: null, breachDurationMs: null },
  ]);
  assert.equal(r, "BREACHED");
});

test("rollupReviewerOpsSlaState: HEALTHY when all healthy", () => {
  const r = rollupReviewerOpsSlaState([
    { dimension: "ASSIGNMENT", dueAtUtc: null, dueSoonAtUtc: null, state: "HEALTHY", timeRemainingMs: null, breachDurationMs: null },
    { dimension: "FIRST_REVIEW", dueAtUtc: null, dueSoonAtUtc: null, state: "HEALTHY", timeRemainingMs: null, breachDurationMs: null },
  ]);
  assert.equal(r, "HEALTHY");
});

// -----------------------------------------------------------------------------
// Capacity score
// -----------------------------------------------------------------------------

test("computeReviewerCapacityScore: idle reviewer scores 100", () => {
  const s = computeReviewerCapacityScore({
    activeReviewCount: 0,
    overdueReviewCount: 0,
    dueSoonReviewCount: 0,
    escalatedReviewCount: 0,
    needsInfoReviewCount: 0,
  });
  assert.equal(s, 100);
});

test("computeReviewerCapacityScore: load decreases score monotonically", () => {
  const idle = computeReviewerCapacityScore({
    activeReviewCount: 0,
    overdueReviewCount: 0,
    dueSoonReviewCount: 0,
    escalatedReviewCount: 0,
    needsInfoReviewCount: 0,
  });
  const moderate = computeReviewerCapacityScore({
    activeReviewCount: 3,
    overdueReviewCount: 0,
    dueSoonReviewCount: 1,
    escalatedReviewCount: 0,
    needsInfoReviewCount: 0,
  });
  const saturated = computeReviewerCapacityScore({
    activeReviewCount: 10,
    overdueReviewCount: 5,
    dueSoonReviewCount: 3,
    escalatedReviewCount: 2,
    needsInfoReviewCount: 1,
  });
  assert.equal(idle > moderate, true);
  assert.equal(moderate > saturated, true);
  // Heavy load floors at 0.
  assert.equal(saturated >= 0, true);
});

test("computeReviewerCapacityScore: escalations weigh more per unit than active reviews", () => {
  // Per-unit comparison: a single escalation must penalise the score
  // at least as much as a single active review.
  const oneActive = computeReviewerCapacityScore({
    activeReviewCount: 1,
    overdueReviewCount: 0,
    dueSoonReviewCount: 0,
    escalatedReviewCount: 0,
    needsInfoReviewCount: 0,
  });
  const oneEscalation = computeReviewerCapacityScore({
    activeReviewCount: 0,
    overdueReviewCount: 0,
    dueSoonReviewCount: 0,
    escalatedReviewCount: 1,
    needsInfoReviewCount: 0,
  });
  // One escalation hurts at least as much as one active review.
  assert.equal(
    oneEscalation < oneActive,
    true,
    `expected one escalation (${oneEscalation}) to score lower than one active (${oneActive})`,
  );
});

// -----------------------------------------------------------------------------
// Allowed-label catalog + overclaim re-export
// -----------------------------------------------------------------------------

test("REVIEWER_OPS_ALLOWED_LABELS contains operator-safe phrasing only", () => {
  for (const required of [
    "reviewer approved",
    "review completed",
    "workflow requirements satisfied",
    "integrity signals",
    "verification signals",
    "governance applied",
    "review blocked",
    "escalation required",
    "visibility restricted",
  ]) {
    assert.equal(REVIEWER_OPS_ALLOWED_LABELS.includes(required), true);
    assert.equal(isAllowedReviewerOpsLabel(required), true);
  }
  // Forbidden phrases never appear in the allowlist.
  for (const banned of [
    "proves",
    "legally admissible",
    "court-approved",
    "tamper-proof",
    "forensic proof",
  ]) {
    assert.equal(
      REVIEWER_OPS_ALLOWED_LABELS.includes(banned),
      false,
      `${banned} must never be allowed`,
    );
  }
});

test("isAllowedReviewerOpsLabel rejects free-form text", () => {
  assert.equal(isAllowedReviewerOpsLabel("court-approved"), false);
  assert.equal(isAllowedReviewerOpsLabel(""), false);
});

test("stringContainsForbiddenOverclaim re-exported from Phase 24 catalog", () => {
  assert.equal(stringContainsForbiddenOverclaim("court-approved"), true);
  assert.equal(stringContainsForbiddenOverclaim("integrity signals"), false);
});

// -----------------------------------------------------------------------------
// Default policy
// -----------------------------------------------------------------------------

test("REVIEWER_OPS_DEFAULT_SLA_POLICY matches the brief env defaults", () => {
  assert.equal(REVIEWER_OPS_DEFAULT_SLA_POLICY.assignmentHours, 4);
  assert.equal(REVIEWER_OPS_DEFAULT_SLA_POLICY.firstReviewHours, 24);
  assert.equal(REVIEWER_OPS_DEFAULT_SLA_POLICY.completionHours, 72);
  assert.equal(REVIEWER_OPS_DEFAULT_SLA_POLICY.escalationHours, 48);
  assert.equal(REVIEWER_OPS_DEFAULT_SLA_POLICY.dueSoonHours, 6);
});

test("ReviewEscalationStatusSchema enforces catalog", () => {
  assert.equal(
    ReviewEscalationStatusSchema.safeParse("UNKNOWN").success,
    false,
  );
  assert.equal(ReviewEscalationStatusSchema.safeParse("OPEN").success, true);
});
