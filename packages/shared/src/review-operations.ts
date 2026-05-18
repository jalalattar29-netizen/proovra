/**
 * Phase 13 — Enterprise review operations canonical types.
 *
 * Browser-safe (no Prisma, no Node imports). Holds:
 *   - Canonical review stage catalog + transition matrix
 *   - Decision types catalog
 *   - SLA status + helpers
 *   - Predicate that maps a workflow stage to the governance gate
 *     ("is the evidence approved for export?")
 *
 * The existing `EvidenceReviewWorkflowStatus` DB enum holds BOTH the
 * legacy values (NOT_STARTED / READY_FOR_EXTERNAL_REVIEW) and the
 * Phase 13 enterprise stages. The catalog below is the canonical
 * Phase 13 stage list; legacy values are mapped at read time.
 *
 * Wording rule (Phase 13 brief, rule 5): never claim "authentic /
 * legally admissible / proven / verified truth". Use "internal review",
 * "workflow approved", "rejected as insufficient".
 */

// -----------------------------------------------------------------------------
// Stage catalog
// -----------------------------------------------------------------------------

export const REVIEW_STAGES = [
  "QUEUED",
  "ASSIGNED",
  "IN_REVIEW",
  "NEEDS_MORE_INFO",
  "RESPONSE_RECEIVED",
  "APPROVED_INTERNAL",
  "REJECTED_INSUFFICIENT",
  "ESCALATED",
  "REOPENED",
  "CLOSED",
] as const;
export type ReviewStage = (typeof REVIEW_STAGES)[number];

export const REVIEW_STAGE_TERMINAL: ReadonlySet<ReviewStage> = new Set([
  "CLOSED",
]);

export function isTerminalReviewStage(stage: ReviewStage): boolean {
  return REVIEW_STAGE_TERMINAL.has(stage);
}

/**
 * Stage that satisfies the governance "requireReviewBefore*" gate.
 * Phase 13 tightens this so ONLY explicit operator approval unlocks
 * report / package / public-verify export. IN_REVIEW (mid-review),
 * NEEDS_MORE_INFO, RESPONSE_RECEIVED, ESCALATED do NOT satisfy.
 */
export function reviewStageSatisfiesGovernanceGate(
  stage: ReviewStage,
): boolean {
  return stage === "APPROVED_INTERNAL";
}

// -----------------------------------------------------------------------------
// Mapping legacy DB status → canonical Phase 13 stage
//
// The DB enum still contains NOT_STARTED + READY_FOR_EXTERNAL_REVIEW
// from earlier phases. They map to QUEUED and APPROVED_INTERNAL
// respectively for the operator-facing view. Workflows written before
// Phase 13 continue to work — no data migration required.
// -----------------------------------------------------------------------------

const LEGACY_DB_STATUS_MAP: Record<string, ReviewStage> = {
  NOT_STARTED: "QUEUED",
  IN_REVIEW: "IN_REVIEW",
  NEEDS_INFO: "NEEDS_MORE_INFO",
  READY_FOR_EXTERNAL_REVIEW: "APPROVED_INTERNAL",
  APPROVED_INTERNAL: "APPROVED_INTERNAL",
  ESCALATED: "ESCALATED",
  CLOSED: "CLOSED",
  // Phase 13 — added values; identity map.
  QUEUED: "QUEUED",
  ASSIGNED: "ASSIGNED",
  RESPONSE_RECEIVED: "RESPONSE_RECEIVED",
  REJECTED_INSUFFICIENT: "REJECTED_INSUFFICIENT",
  REOPENED: "REOPENED",
};

export function mapDbStatusToReviewStage(
  dbStatus: string | null | undefined,
): ReviewStage {
  if (!dbStatus) return "QUEUED";
  return LEGACY_DB_STATUS_MAP[dbStatus] ?? "QUEUED";
}

// -----------------------------------------------------------------------------
// Transition matrix
//
// Every transition is explicit. Self-transitions are allowed (heartbeats /
// no-ops). Anything not listed is rejected by
// `assertValidReviewStageTransition`.
//
// Rules:
//   - QUEUED is the entry state. New workflows always start here.
//   - ASSIGNED → IN_REVIEW (when the reviewer claims).
//   - APPROVED_INTERNAL is the canonical "approved" state and the
//     only on-ramp to CLOSED.
//   - REJECTED_INSUFFICIENT is a soft-terminal: the workflow is over
//     but the evidence is NOT deleted. Reopen returns to IN_REVIEW.
//   - REOPENED moves the workflow back into IN_REVIEW with the
//     `reopenCount` incremented; the previous decision stays in
//     event history.
//   - ESCALATED can return to IN_REVIEW after the escalation owner
//     acts, or roll forward to APPROVED_INTERNAL / REJECTED_INSUFFICIENT.
// -----------------------------------------------------------------------------

const REVIEW_STAGE_TRANSITIONS: Readonly<
  Record<ReviewStage, ReadonlyArray<ReviewStage>>
> = {
  QUEUED: ["ASSIGNED", "IN_REVIEW", "ESCALATED", "CLOSED"],
  ASSIGNED: ["IN_REVIEW", "NEEDS_MORE_INFO", "ESCALATED", "QUEUED", "CLOSED"],
  IN_REVIEW: [
    "NEEDS_MORE_INFO",
    "APPROVED_INTERNAL",
    "REJECTED_INSUFFICIENT",
    "ESCALATED",
    "ASSIGNED",
    "CLOSED",
  ],
  NEEDS_MORE_INFO: [
    "RESPONSE_RECEIVED",
    "IN_REVIEW",
    "ESCALATED",
    "REJECTED_INSUFFICIENT",
    "CLOSED",
  ],
  RESPONSE_RECEIVED: [
    "IN_REVIEW",
    "APPROVED_INTERNAL",
    "REJECTED_INSUFFICIENT",
    "NEEDS_MORE_INFO",
    "ESCALATED",
    "CLOSED",
  ],
  APPROVED_INTERNAL: ["REOPENED", "CLOSED"],
  REJECTED_INSUFFICIENT: ["REOPENED", "CLOSED"],
  ESCALATED: [
    "IN_REVIEW",
    "APPROVED_INTERNAL",
    "REJECTED_INSUFFICIENT",
    "NEEDS_MORE_INFO",
    "CLOSED",
  ],
  REOPENED: ["IN_REVIEW", "NEEDS_MORE_INFO", "ESCALATED"],
  CLOSED: ["REOPENED"],
};

export function isAllowedReviewStageTransition(
  from: ReviewStage,
  to: ReviewStage,
): boolean {
  if (from === to) return true; // heartbeat / no-op
  return REVIEW_STAGE_TRANSITIONS[from]?.includes(to) ?? false;
}

export function listAllowedReviewStageTransitions(
  from: ReviewStage,
): ReadonlyArray<ReviewStage> {
  return REVIEW_STAGE_TRANSITIONS[from] ?? [];
}

// -----------------------------------------------------------------------------
// Decision types
//
// Each decision corresponds to a stage change + an event in the
// review workflow history. APPROVE_INTERNAL is the only decision that
// satisfies the governance gate.
// -----------------------------------------------------------------------------

export const REVIEW_DECISION_TYPES = [
  "APPROVE_INTERNAL",
  "REQUEST_MORE_INFO",
  "REJECT_INSUFFICIENT",
  "ESCALATE",
  "REOPEN",
  "CLOSE",
] as const;
export type ReviewDecisionType = (typeof REVIEW_DECISION_TYPES)[number];

export function decisionTargetStage(
  decision: ReviewDecisionType,
): ReviewStage {
  switch (decision) {
    case "APPROVE_INTERNAL":
      return "APPROVED_INTERNAL";
    case "REQUEST_MORE_INFO":
      return "NEEDS_MORE_INFO";
    case "REJECT_INSUFFICIENT":
      return "REJECTED_INSUFFICIENT";
    case "ESCALATE":
      return "ESCALATED";
    case "REOPEN":
      return "REOPENED";
    case "CLOSE":
      return "CLOSED";
  }
}

/**
 * Decisions that MUST include a non-empty note when the actor logs
 * them. Rejection / reopen / escalation all require an operator
 * justification so audit history is meaningful.
 */
export const REVIEW_DECISIONS_REQUIRING_NOTE: ReadonlySet<ReviewDecisionType> =
  new Set(["REJECT_INSUFFICIENT", "ESCALATE", "REOPEN"]);

export function decisionRequiresNote(d: ReviewDecisionType): boolean {
  return REVIEW_DECISIONS_REQUIRING_NOTE.has(d);
}

// -----------------------------------------------------------------------------
// SLA status
// -----------------------------------------------------------------------------

export const REVIEW_SLA_STATUSES = [
  "ON_TRACK",
  "DUE_SOON",
  "OVERDUE",
  "BREACHED",
  "PAUSED",
] as const;
export type ReviewSlaStatus = (typeof REVIEW_SLA_STATUSES)[number];

export type SlaComputationInput = {
  dueAtUtc: Date | null | undefined;
  firstResponseDueAtUtc?: Date | null | undefined;
  escalationDueAtUtc?: Date | null | undefined;
  completedAtUtc?: Date | null | undefined;
  paused?: boolean;
  /** Window before due-at within which we surface DUE_SOON. */
  dueSoonMinutes?: number;
  /** Minutes after dueAtUtc beyond which we flip from OVERDUE to BREACHED. */
  breachAfterMinutes?: number;
  /** Override "now" for deterministic tests. */
  nowUtc?: Date;
};

/**
 * Compute the effective SLA status from raw timestamps. Returns null
 * when no SLA is configured for the workflow (no dueAtUtc + no
 * firstResponseDueAtUtc).
 *
 * "Completed" is terminal — once `completedAtUtc` is set, status is
 * always ON_TRACK regardless of timing (operator already finished
 * the review; SLA no longer applies).
 */
export function computeReviewSlaStatus(
  input: SlaComputationInput,
): ReviewSlaStatus | null {
  if (input.paused) return "PAUSED";
  const due = input.dueAtUtc ?? input.firstResponseDueAtUtc ?? null;
  if (!due) return null;
  const now = (input.nowUtc ?? new Date()).getTime();
  if (input.completedAtUtc && input.completedAtUtc.getTime() <= due.getTime()) {
    return "ON_TRACK";
  }
  const dueSoonWindowMs = (input.dueSoonMinutes ?? 60) * 60 * 1000;
  const breachWindowMs = (input.breachAfterMinutes ?? 60 * 24) * 60 * 1000;

  const msUntilDue = due.getTime() - now;
  if (msUntilDue > dueSoonWindowMs) return "ON_TRACK";
  if (msUntilDue > 0) return "DUE_SOON";
  // Past due.
  if (Math.abs(msUntilDue) > breachWindowMs) return "BREACHED";
  return "OVERDUE";
}
