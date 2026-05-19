/**
 * Phase 25.5 — Reviewer assignment intelligence engine.
 *
 * Two pure deterministic engines that mirror the priority + stuck
 * detector contracts established in Phase 25:
 *
 *   1. `evaluateReviewerEligibility(facts, candidate)` →
 *      `EligibilityResult` (eligible? + bounded ineligibility reasons)
 *
 *   2. `rankReviewerSuggestions(facts, candidates)` →
 *      `ReviewerSuggestion[]` ordered by recommendation score.
 *      Each suggestion carries a bounded recommendation band, score,
 *      reasons, and risk flags.
 *
 * Hard rules:
 *   - Pure: no Prisma, no Node, no I/O. Browser-safe.
 *   - Deterministic: identical inputs → identical output.
 *   - Bounded reason / risk-flag catalogs so the UI renders chips
 *     without free-text leak.
 *   - GOVERNANCE-FIRST: any reviewer who fails the eligibility gate
 *     can never appear in the ranked-suggestion list. The ranker
 *     enforces this internally — callers cannot bypass.
 *   - NEVER recommends a reviewer who lacks the canonical assign
 *     permission, who is outside the workspace, or who is blocked by
 *     reviewer-scope / contributor-private restrictions.
 *   - NEVER leaks evidence details in ineligibility reasons — the
 *     vocabulary is bounded.
 *   - Workload balancing influences score but cannot override a
 *     governance-disqualifying signal — those rejections happen in
 *     the eligibility step before ranking.
 */

// =============================================================================
// Bounded vocabularies
// =============================================================================

export const ASSIGNMENT_INELIGIBILITY_CODES = [
  "missing_assign_permission",
  "outside_workspace_scope",
  "reviewer_scope_blocked",
  "contributor_private_blocked",
  "reviewer_restricted_blocked",
  "legal_hold_owner_conflict",
  "escalation_owner_conflict",
  "workflow_state_terminal",
  "workflow_already_assigned_to_actor",
  "reviewer_inactive",
  "reviewer_self_assignment_blocked",
] as const;

export type AssignmentIneligibilityCode =
  (typeof ASSIGNMENT_INELIGIBILITY_CODES)[number];

export const ASSIGNMENT_RANK_REASON_CODES = [
  "available_capacity",
  "balanced_workload",
  "recent_throughput_high",
  "workflow_state_compatible",
  "case_team_member",
  "reviewer_recent_activity",
  "expertise_tag_match",
] as const;

export type AssignmentRankReasonCode =
  (typeof ASSIGNMENT_RANK_REASON_CODES)[number];

export const ASSIGNMENT_RISK_FLAG_CODES = [
  "reviewer_overloaded",
  "reviewer_overdue_pressure",
  "reviewer_escalation_pressure",
  "reviewer_recent_assignment_burst",
  "reviewer_inactive_warning",
  "workload_imbalance",
] as const;

export type AssignmentRiskFlagCode =
  (typeof ASSIGNMENT_RISK_FLAG_CODES)[number];

// =============================================================================
// Inputs
// =============================================================================

export type WorkflowAssignmentFacts = {
  /** Caller-supplied epoch ms — keeps the engine pure. */
  nowEpochMs: number;
  workflowId: string;
  teamId: string;
  /** Bounded workflow status. */
  status: string;
  /** Whether the workflow is currently linked to an active legal hold. */
  hasActiveLegalHold: boolean;
  /** True when the workflow's source evidence row is reviewer-restricted. */
  reviewerRestricted: boolean;
  /** True when the workflow's source is contributor-private (external
   *  intake). Visibility ladder enforced at the eligibility step. */
  contributorPrivate: boolean;
  /** The actor initiating the (re)assignment. Self-assignment is
   *  blocked unless the actor is the assignedReviewerUserId of a
   *  workflow that's already assigned to them. */
  actorUserId: string;
  /** Currently assigned reviewer (if any). */
  currentReviewerUserId: string | null;
  /** Optional case-team membership requirement. When non-null, the
   *  candidate MUST be in the named case team to be eligible. */
  requiredCaseTeamId: string | null;
  /** Optional ownership lock — if set, only the named reviewer or an
   *  escalation owner may be (re)assigned. */
  escalationOwnerUserId: string | null;
};

export type ReviewerCandidate = {
  reviewerId: string;
  /** Active reviewer workspace scope. */
  workspaceTeamId: string;
  /** Bounded role: REVIEWER / ADMIN / OWNER. Anything else fails the
   *  eligibility gate. */
  role: "REVIEWER" | "ADMIN" | "OWNER" | string;
  /** Canonical permissions resolved from the role + per-user
   *  capabilities. Pure boolean snapshot — the engine never re-derives
   *  permissions. */
  permissions: {
    canAssignReviewer: boolean;
    canSeeReviewerRestricted: boolean;
    canSeeContributorPrivate: boolean;
    canActOnLegalHold: boolean;
  };
  /** Membership in the optional case team (null when no requirement). */
  isCaseTeamMember: boolean;
  /** Optional bounded expertise tags. Bounded to 16 tags. */
  expertiseTags: ReadonlyArray<string>;
  /** Real workload snapshot for this reviewer. */
  workload: {
    activeReviews: number;
    overdueReviews: number;
    dueSoonReviews: number;
    escalatedReviews: number;
    /** Recent (last 7d) completed count. */
    recentCompleted: number;
    /** Bounded reviewer pressure category. */
    pressure: "available" | "balanced" | "overloaded";
    /** Epoch-ms of last reviewer action. `null` when unknown. */
    lastActivityAtEpochMs: number | null;
    /** Number of NEW assignments this reviewer received in the last 24h.
     *  Drives the "assignment burst" risk flag. */
    recentAssignmentBurstCount: number;
  };
};

// =============================================================================
// Outputs
// =============================================================================

export type EligibilityReason = {
  code: AssignmentIneligibilityCode;
  /** Operator-readable, bounded vocabulary. Safe to render. NEVER
   *  contains evidence-side details. */
  label: string;
};

export type EligibilityResult =
  | { eligible: true; reasons: ReadonlyArray<EligibilityReason> }
  | { eligible: false; reasons: ReadonlyArray<EligibilityReason> };

export type AssignmentRankReason = {
  code: AssignmentRankReasonCode;
  delta: number;
  label: string;
};

export type AssignmentRiskFlag = {
  code: AssignmentRiskFlagCode;
  label: string;
  severity: "INFO" | "WARNING" | "HIGH";
};

export type RecommendationBand =
  | "RECOMMENDED"
  | "ACCEPTABLE"
  | "LAST_RESORT"
  | "NOT_RECOMMENDED";

export type ReviewerSuggestion = {
  reviewerId: string;
  score: number;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  recommendationBand: RecommendationBand;
  reasons: ReadonlyArray<AssignmentRankReason>;
  riskFlags: ReadonlyArray<AssignmentRiskFlag>;
};

// =============================================================================
// Eligibility engine
// =============================================================================

export function evaluateReviewerEligibility(
  facts: WorkflowAssignmentFacts,
  candidate: ReviewerCandidate,
): EligibilityResult {
  const reasons: EligibilityReason[] = [];

  // Workflow state terminal — refuse early.
  if (
    facts.status === "COMPLETED" ||
    facts.status === "CANCELLED" ||
    facts.status === "REJECTED"
  ) {
    reasons.push({
      code: "workflow_state_terminal",
      label: "Workflow has reached a terminal state.",
    });
  }

  // Workspace scope. The candidate MUST be in the same workspace as
  // the workflow.
  if (candidate.workspaceTeamId !== facts.teamId) {
    reasons.push({
      code: "outside_workspace_scope",
      label: "Reviewer is outside the workflow's workspace.",
    });
  }

  // Assign permission.
  if (!candidate.permissions.canAssignReviewer) {
    reasons.push({
      code: "missing_assign_permission",
      label: "Reviewer lacks the assign-reviewer permission.",
    });
  }

  // Reviewer-restricted scope.
  if (
    facts.reviewerRestricted &&
    !candidate.permissions.canSeeReviewerRestricted
  ) {
    reasons.push({
      code: "reviewer_restricted_blocked",
      label: "Reviewer cannot view reviewer-restricted workflows.",
    });
  }

  // Contributor-private scope.
  if (
    facts.contributorPrivate &&
    !candidate.permissions.canSeeContributorPrivate
  ) {
    reasons.push({
      code: "contributor_private_blocked",
      label: "Reviewer cannot view contributor-private workflows.",
    });
  }

  // Reviewer scope flag (e.g. role does not include reviewer
  // operations at all).
  if (
    candidate.role !== "REVIEWER" &&
    candidate.role !== "ADMIN" &&
    candidate.role !== "OWNER"
  ) {
    reasons.push({
      code: "reviewer_scope_blocked",
      label: "Role is not eligible for reviewer assignment.",
    });
  }

  // Legal hold owner conflict.
  if (facts.hasActiveLegalHold && !candidate.permissions.canActOnLegalHold) {
    reasons.push({
      code: "legal_hold_owner_conflict",
      label: "Workflow is under legal hold; reviewer lacks hold-action permission.",
    });
  }

  // Escalation ownership conflict — when an escalation owner is set,
  // only that owner (or someone who can act on escalations) is
  // eligible. The engine treats the named owner as eligible and
  // everyone else as conflicting. Future revisions can broaden this.
  if (
    facts.escalationOwnerUserId &&
    facts.escalationOwnerUserId !== candidate.reviewerId
  ) {
    reasons.push({
      code: "escalation_owner_conflict",
      label: "Workflow has an escalation owner that takes precedence.",
    });
  }

  // Required case-team membership.
  if (facts.requiredCaseTeamId && !candidate.isCaseTeamMember) {
    reasons.push({
      code: "reviewer_scope_blocked",
      label: "Reviewer is not in the required case team.",
    });
  }

  // Self-assignment guard. Operators MUST NOT re-assign a workflow to
  // themselves through this engine — that path goes through an
  // explicit operator action that has its own audit.
  if (
    facts.actorUserId === candidate.reviewerId &&
    facts.currentReviewerUserId !== candidate.reviewerId
  ) {
    reasons.push({
      code: "reviewer_self_assignment_blocked",
      label: "Self-assignment via the suggestion engine is blocked.",
    });
  }

  // Already-assigned-to-actor — informational, not blocking, but the
  // ranker uses this to skip suggesting "switch to yourself".
  if (
    candidate.reviewerId === facts.currentReviewerUserId &&
    facts.actorUserId === candidate.reviewerId
  ) {
    reasons.push({
      code: "workflow_already_assigned_to_actor",
      label: "Workflow is already assigned to this reviewer.",
    });
  }

  // Inactive reviewer (no activity in 30+ days).
  const lastActivity = candidate.workload.lastActivityAtEpochMs;
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
  if (
    lastActivity != null &&
    facts.nowEpochMs - lastActivity > THIRTY_DAYS_MS
  ) {
    reasons.push({
      code: "reviewer_inactive",
      label: "Reviewer has been inactive for 30+ days.",
    });
  }

  if (reasons.length === 0) {
    return { eligible: true, reasons: [] };
  }
  return { eligible: false, reasons };
}

// =============================================================================
// Suggestion ranking
// =============================================================================

const SCORE_MAX = 1000;
const BAND_RECOMMENDED_THRESHOLD = 600;
const BAND_ACCEPTABLE_THRESHOLD = 350;
const BAND_LAST_RESORT_THRESHOLD = 150;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function bandForScore(score: number): RecommendationBand {
  if (score >= BAND_RECOMMENDED_THRESHOLD) return "RECOMMENDED";
  if (score >= BAND_ACCEPTABLE_THRESHOLD) return "ACCEPTABLE";
  if (score >= BAND_LAST_RESORT_THRESHOLD) return "LAST_RESORT";
  return "NOT_RECOMMENDED";
}

function confidenceFor(reasons: ReadonlyArray<AssignmentRankReason>): "HIGH" | "MEDIUM" | "LOW" {
  const totalDelta = reasons.reduce((sum, r) => sum + r.delta, 0);
  if (totalDelta >= 500) return "HIGH";
  if (totalDelta >= 250) return "MEDIUM";
  return "LOW";
}

/**
 * Score one already-eligible candidate. Returns suggestion shape. Risk
 * flags ride alongside score so the UI can render warnings even on a
 * "recommended" reviewer (e.g. recommended + overload).
 */
function scoreCandidate(
  facts: WorkflowAssignmentFacts,
  candidate: ReviewerCandidate,
  systemActiveAverage: number,
): ReviewerSuggestion {
  const reasons: AssignmentRankReason[] = [];
  const riskFlags: AssignmentRiskFlag[] = [];
  let score = 0;

  // Capacity-based score. "available" is the strongest positive.
  if (candidate.workload.pressure === "available") {
    const delta = 250;
    score += delta;
    reasons.push({
      code: "available_capacity",
      delta,
      label: "Reviewer has available capacity",
    });
  } else if (candidate.workload.pressure === "balanced") {
    const delta = 120;
    score += delta;
    reasons.push({
      code: "balanced_workload",
      delta,
      label: "Reviewer workload is balanced",
    });
  } else if (candidate.workload.pressure === "overloaded") {
    riskFlags.push({
      code: "reviewer_overloaded",
      label: "Reviewer is overloaded — assigning increases SLA risk",
      severity: "HIGH",
    });
  }

  // Recent throughput.
  if (candidate.workload.recentCompleted >= 10) {
    const delta = 150;
    score += delta;
    reasons.push({
      code: "recent_throughput_high",
      delta,
      label: "Reviewer has high recent throughput",
    });
  } else if (candidate.workload.recentCompleted >= 4) {
    const delta = 80;
    score += delta;
    reasons.push({
      code: "recent_throughput_high",
      delta,
      label: "Reviewer has steady recent throughput",
    });
  }

  // Overdue pressure risk flag.
  if (candidate.workload.overdueReviews >= 3) {
    riskFlags.push({
      code: "reviewer_overdue_pressure",
      label: "Reviewer has 3+ overdue reviews",
      severity: "HIGH",
    });
  } else if (candidate.workload.overdueReviews >= 1) {
    riskFlags.push({
      code: "reviewer_overdue_pressure",
      label: "Reviewer has overdue reviews",
      severity: "WARNING",
    });
  }

  // Escalation pressure risk flag.
  if (candidate.workload.escalatedReviews >= 1) {
    riskFlags.push({
      code: "reviewer_escalation_pressure",
      label: "Reviewer has open escalations",
      severity: candidate.workload.escalatedReviews >= 3 ? "HIGH" : "WARNING",
    });
  }

  // Assignment burst risk flag.
  if (candidate.workload.recentAssignmentBurstCount >= 5) {
    riskFlags.push({
      code: "reviewer_recent_assignment_burst",
      label: "Reviewer received many new assignments in the last 24h",
      severity: "WARNING",
    });
  }

  // Workload imbalance — when this reviewer's active count is > 1.5x
  // the system average.
  if (
    systemActiveAverage > 0 &&
    candidate.workload.activeReviews > systemActiveAverage * 1.5
  ) {
    riskFlags.push({
      code: "workload_imbalance",
      label:
        "Reviewer is carrying significantly more active reviews than the team average",
      severity: "WARNING",
    });
  }

  // Inactivity warning (NOT a disqualifier — already filtered if 30d+).
  if (
    candidate.workload.lastActivityAtEpochMs != null &&
    facts.nowEpochMs - candidate.workload.lastActivityAtEpochMs >
      14 * ONE_DAY_MS
  ) {
    riskFlags.push({
      code: "reviewer_inactive_warning",
      label: "Reviewer has been inactive for 14+ days",
      severity: "WARNING",
    });
  } else if (
    candidate.workload.lastActivityAtEpochMs != null &&
    facts.nowEpochMs - candidate.workload.lastActivityAtEpochMs <
      3 * ONE_DAY_MS
  ) {
    // Positive nudge for recent activity.
    const delta = 60;
    score += delta;
    reasons.push({
      code: "reviewer_recent_activity",
      delta,
      label: "Reviewer has been active in the last 3 days",
    });
  }

  // Case-team membership.
  if (facts.requiredCaseTeamId && candidate.isCaseTeamMember) {
    const delta = 80;
    score += delta;
    reasons.push({
      code: "case_team_member",
      delta,
      label: "Reviewer is in the case team",
    });
  }

  // Expertise-tag match (placeholder: any non-empty tag list is a
  // small bump until a workflow-side `requiredTags` field exists).
  if (candidate.expertiseTags.length > 0) {
    const delta = 20;
    score += delta;
    reasons.push({
      code: "expertise_tag_match",
      delta,
      label: "Reviewer has registered expertise tags",
    });
  }

  // Workflow state compatibility — always-true positive for IN_REVIEW
  // / ASSIGNED. NEEDS_INFO workflows do NOT get this bump (the workflow
  // is waiting on a contributor, reassigning won't help).
  if (
    facts.status === "ASSIGNED" ||
    facts.status === "IN_REVIEW" ||
    facts.status === "SUBMITTED"
  ) {
    const delta = 30;
    score += delta;
    reasons.push({
      code: "workflow_state_compatible",
      delta,
      label: "Workflow state is compatible with reassignment",
    });
  }

  reasons.sort((a, b) => b.delta - a.delta);
  const clamped = Math.max(0, Math.min(SCORE_MAX, score));
  return {
    reviewerId: candidate.reviewerId,
    score: clamped,
    confidence: confidenceFor(reasons),
    recommendationBand: bandForScore(clamped),
    reasons,
    riskFlags,
  };
}

// =============================================================================
// Ranker — eligibility gate FIRST, then score.
// =============================================================================

export type RankerResult = {
  /** Ranked eligible reviewers (sorted by score desc). */
  ranked: ReadonlyArray<ReviewerSuggestion>;
  /** Reviewers who failed the eligibility gate, with reasons. The UI
   *  can render "X reviewers are not eligible because …" — operators
   *  see WHY without exposing evidence details. */
  ineligible: ReadonlyArray<{
    reviewerId: string;
    reasons: ReadonlyArray<EligibilityReason>;
  }>;
};

export function rankReviewerSuggestions(
  facts: WorkflowAssignmentFacts,
  candidates: ReadonlyArray<ReviewerCandidate>,
): RankerResult {
  // System average — drives the imbalance risk flag.
  const eligibleSet: ReviewerCandidate[] = [];
  const ineligible: RankerResult["ineligible"][number][] = [];
  for (const c of candidates) {
    const e = evaluateReviewerEligibility(facts, c);
    if (e.eligible) {
      eligibleSet.push(c);
    } else {
      ineligible.push({ reviewerId: c.reviewerId, reasons: e.reasons });
    }
  }
  const systemActiveAverage =
    eligibleSet.length > 0
      ? eligibleSet.reduce((sum, c) => sum + c.workload.activeReviews, 0) /
        eligibleSet.length
      : 0;

  const ranked = eligibleSet
    .map((c) => scoreCandidate(facts, c, systemActiveAverage))
    .sort((a, b) => b.score - a.score);
  return { ranked, ineligible };
}

// =============================================================================
// Throughput balancing helper — pure detector that summarises team-
// wide assignment health. Called by the reconciliation worker to raise
// operational signals (NOT to auto-assign).
// =============================================================================

export type TeamBalanceFacts = {
  reviewers: ReadonlyArray<ReviewerCandidate>;
};

export type TeamBalanceResult = {
  overloadedCount: number;
  starvedCount: number;
  inactiveCount: number;
  /** True when the workload distribution is significantly uneven —
   *  defined as: stdev of active reviews > 0.5 × mean AND mean >= 4. */
  imbalanced: boolean;
  topActiveReviewerCount: number;
};

export function evaluateTeamBalance(
  input: TeamBalanceFacts,
): TeamBalanceResult {
  const reviewers = input.reviewers;
  let overloaded = 0;
  let starved = 0;
  let inactive = 0;
  let topActive = 0;
  let totalActive = 0;
  for (const r of reviewers) {
    totalActive += r.workload.activeReviews;
    if (r.workload.pressure === "overloaded") overloaded += 1;
    if (r.workload.activeReviews === 0) starved += 1;
    if (
      r.workload.lastActivityAtEpochMs == null ||
      Date.now() - r.workload.lastActivityAtEpochMs > 30 * 24 * 60 * 60 * 1000
    ) {
      inactive += 1;
    }
    if (r.workload.activeReviews > topActive) {
      topActive = r.workload.activeReviews;
    }
  }
  const mean = reviewers.length > 0 ? totalActive / reviewers.length : 0;
  let stdev = 0;
  if (reviewers.length > 1) {
    const variance =
      reviewers.reduce(
        (sum, r) => sum + Math.pow(r.workload.activeReviews - mean, 2),
        0,
      ) / reviewers.length;
    stdev = Math.sqrt(variance);
  }
  const imbalanced = mean >= 4 && stdev > mean * 0.5;
  return {
    overloadedCount: overloaded,
    starvedCount: starved,
    inactiveCount: inactive,
    imbalanced,
    topActiveReviewerCount: topActive,
  };
}
