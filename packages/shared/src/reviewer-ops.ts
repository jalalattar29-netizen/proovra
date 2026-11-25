/**
 * Phase 25 — Reviewer Operations Intelligence canonical types.
 *
 * Browser-safe (no Prisma, no Node imports). Layered on top of the
 * Phase 13 `review-operations.ts` module — this file does NOT redefine
 * the stage / decision catalogs, it adds the queue / escalation /
 * workload primitives that Phase 25 introduces.
 *
 * Hard invariants:
 *   - Queue type catalog is exhaustive — operator-readable only.
 *   - Escalation reasons + statuses are bounded enums; the service
 *     layer rejects anything outside the catalog.
 *   - Lifecycle state catalog is the brief's explicit Phase 25 list.
 *     The DB workflow row still uses `EvidenceReviewWorkflowStatus`
 *     (which carries the Phase 13 stages); Phase 25 derives the
 *     lifecycle state from the DB stage + escalation state.
 *   - SLA dimension names match the brief.
 *   - Wording: every operator-readable label avoids "proves", "legally
 *     admissible", "court-approved", "tamper-proof", "forensic proof",
 *     "guaranteed authentic". Routes / services scrub user-supplied
 *     reason/note fields against `stringContainsForbiddenOverclaim`.
 */

import { z } from "zod";

import {
  INCIDENT_CATEGORIES,
  INCIDENT_SEVERITIES,
  INCIDENT_STATUS_FILTERS,
} from "./observability.js";

import {
  isAllowedReviewStageTransition,
  type ReviewStage,
} from "./review-operations.js";

// -----------------------------------------------------------------------------
// Lifecycle state — the Phase 25 brief's explicit list.
//
// Mapping from Phase 13 ReviewStage + escalation state:
//   DRAFT              — workflow row does not yet exist (computed by route)
//   SUBMITTED          — workflow row exists; status = QUEUED
//   QUEUED             — workflow row exists; status = QUEUED, assignedTo = null
//   ASSIGNED           — status = ASSIGNED
//   IN_REVIEW          — status = IN_REVIEW
//   NEEDS_INFORMATION  — status = NEEDS_MORE_INFO
//   ESCALATED          — status = ESCALATED OR open escalation present
//   APPROVED           — status = APPROVED_INTERNAL
//   REJECTED           — status = REJECTED_INSUFFICIENT
//   ARCHIVED           — status = CLOSED
// -----------------------------------------------------------------------------

export const REVIEWER_OPS_LIFECYCLE_STATES = [
  "DRAFT",
  "SUBMITTED",
  "QUEUED",
  "ASSIGNED",
  "IN_REVIEW",
  "NEEDS_INFORMATION",
  "ESCALATED",
  "APPROVED",
  "REJECTED",
  "ARCHIVED",
] as const;
export const ReviewerOpsLifecycleStateSchema = z.enum(
  REVIEWER_OPS_LIFECYCLE_STATES,
);
export type ReviewerOpsLifecycleState = z.infer<
  typeof ReviewerOpsLifecycleStateSchema
>;

/**
 * Map the Phase 13 DB review stage + escalation flag to the Phase 25
 * lifecycle state. `hasOpenEscalation` wins over an OPEN stage — an
 * escalation is always operator-visible while the review is in progress.
 *
 * T-051 (stage C) — a FINISHED stage (approved, rejected, archived) wins over
 * the escalation flag: a lingering escalation on a finished review is a
 * monitoring item of its own, never a reason to call the review "Escalated".
 */
export function deriveLifecycleState(
  stage: ReviewStage,
  hasOpenEscalation: boolean,
): ReviewerOpsLifecycleState {
  const finished =
    stage === "APPROVED_INTERNAL" || stage === "REJECTED_INSUFFICIENT" || stage === "CLOSED";
  if (hasOpenEscalation && !finished) return "ESCALATED";
  switch (stage) {
    case "QUEUED":
      return "QUEUED";
    case "ASSIGNED":
      return "ASSIGNED";
    case "IN_REVIEW":
      return "IN_REVIEW";
    case "NEEDS_MORE_INFO":
      return "NEEDS_INFORMATION";
    case "RESPONSE_RECEIVED":
      return "IN_REVIEW";
    case "APPROVED_INTERNAL":
      return "APPROVED";
    case "REJECTED_INSUFFICIENT":
      return "REJECTED";
    case "ESCALATED":
      return "ESCALATED";
    case "REOPENED":
      return "IN_REVIEW";
    case "CLOSED":
      return "ARCHIVED";
  }
}

// -----------------------------------------------------------------------------
// Phase 25 lifecycle transition matrix.
//
// The brief enumerates allowed transitions. We re-validate Phase 25
// transitions on top of the Phase 13 stage matrix so any "lifecycle
// state" transition the route layer accepts maps to an allowed
// underlying ReviewStage transition.
// -----------------------------------------------------------------------------

const LIFECYCLE_TRANSITIONS: Readonly<
  Record<ReviewerOpsLifecycleState, ReadonlyArray<ReviewerOpsLifecycleState>>
> = {
  DRAFT: ["SUBMITTED"],
  SUBMITTED: ["QUEUED", "ASSIGNED"],
  QUEUED: ["ASSIGNED", "IN_REVIEW", "ESCALATED", "ARCHIVED"],
  ASSIGNED: ["IN_REVIEW", "NEEDS_INFORMATION", "ESCALATED", "QUEUED", "ARCHIVED"],
  IN_REVIEW: [
    "NEEDS_INFORMATION",
    "APPROVED",
    "REJECTED",
    "ESCALATED",
    "ASSIGNED",
    "ARCHIVED",
  ],
  NEEDS_INFORMATION: ["IN_REVIEW", "ESCALATED", "REJECTED", "ARCHIVED"],
  ESCALATED: ["IN_REVIEW", "APPROVED", "REJECTED", "NEEDS_INFORMATION", "ARCHIVED"],
  APPROVED: ["ARCHIVED"],
  REJECTED: ["ARCHIVED", "IN_REVIEW"], // reopen path goes through IN_REVIEW
  ARCHIVED: [],
};

export function isAllowedLifecycleTransition(
  from: ReviewerOpsLifecycleState,
  to: ReviewerOpsLifecycleState,
): boolean {
  if (from === to) return true; // heartbeat / no-op
  return LIFECYCLE_TRANSITIONS[from]?.includes(to) ?? false;
}

export function listAllowedLifecycleTransitions(
  from: ReviewerOpsLifecycleState,
): ReadonlyArray<ReviewerOpsLifecycleState> {
  return LIFECYCLE_TRANSITIONS[from] ?? [];
}

/**
 * Belt-and-braces: the route layer translates a lifecycle transition
 * into an underlying Phase 13 stage transition. This helper verifies
 * the underlying stage transition is also allowed.
 */
export function lifecycleTransitionPassesStageGate(
  fromStage: ReviewStage,
  toStage: ReviewStage,
): boolean {
  return isAllowedReviewStageTransition(fromStage, toStage);
}

// -----------------------------------------------------------------------------
// Queue type catalog
// -----------------------------------------------------------------------------

export const REVIEWER_OPS_QUEUE_TYPES = [
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
] as const;
export const ReviewerOpsQueueTypeSchema = z.enum(REVIEWER_OPS_QUEUE_TYPES);
export type ReviewerOpsQueueType = z.infer<typeof ReviewerOpsQueueTypeSchema>;

// -----------------------------------------------------------------------------
// SLA dimensions — the Phase 25 brief's four explicit kinds.
// -----------------------------------------------------------------------------

export const REVIEW_SLA_DIMENSIONS = [
  "ASSIGNMENT",
  "FIRST_REVIEW",
  "COMPLETION",
  "ESCALATION",
] as const;
export type ReviewSlaDimension = (typeof REVIEW_SLA_DIMENSIONS)[number];

export type ReviewSlaDimensionSnapshot = {
  dimension: ReviewSlaDimension;
  dueAtUtc: string | null;
  dueSoonAtUtc: string | null;
  /** "HEALTHY" | "DUE_SOON" | "BREACHED" | "PAUSED" | "COMPLETED" — see catalog below. */
  state: ReviewerOpsSlaState;
  timeRemainingMs: number | null;
  breachDurationMs: number | null;
  /**
   * T-043 (stage C) — when the dimension's fact happened (assigned, first
   * decision, finished). Null while it is still open. Distinct from `dueAtUtc`:
   * "Met" is shown with THIS time, never with the deadline.
   */
  completedAtUtc: string | null;
  /**
   * True when the fact happened on or before the deadline, false when it came
   * after it, null while open or when there was no deadline. Only `true` may
   * be presented as "Met".
   */
  metOnTime: boolean | null;
};

/**
 * T-045 (stage C) — the dimensions that are deadlines of the REVIEW. The
 * ESCALATION dimension is the engine's automatic-escalation trigger time, not
 * a promise to the reader: it is neither presented as a deadline nor allowed
 * to make the review read overdue.
 */
export const REVIEW_DEADLINE_DIMENSIONS: ReadonlyArray<ReviewSlaDimension> = [
  "ASSIGNMENT",
  "FIRST_REVIEW",
  "COMPLETION",
];

function isReviewDeadlineDimension(d: ReviewSlaDimension): boolean {
  return REVIEW_DEADLINE_DIMENSIONS.includes(d);
}

// Phase 25 SLA state catalog. Wider than the Phase 13 ReviewSlaStatus
// catalog so we can express "completed for this dimension" + "blocked".
export const REVIEWER_OPS_SLA_STATES = [
  "HEALTHY",
  "DUE_SOON",
  "BREACHED",
  "ESCALATED",
  "BLOCKED",
  "PAUSED",
  "COMPLETED",
] as const;
export const ReviewerOpsSlaStateSchema = z.enum(REVIEWER_OPS_SLA_STATES);
export type ReviewerOpsSlaState = z.infer<typeof ReviewerOpsSlaStateSchema>;

// -----------------------------------------------------------------------------
// Escalation catalog
// -----------------------------------------------------------------------------

export const REVIEW_ESCALATION_REASONS = [
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
  // 2026-10-23 — a reviewer escalated the review from the Evidence page.
  "REVIEWER_ESCALATED",
] as const;
export const ReviewEscalationReasonSchema = z.enum(REVIEW_ESCALATION_REASONS);
export type ReviewEscalationReason = z.infer<typeof ReviewEscalationReasonSchema>;

export const REVIEW_ESCALATION_STATUSES = [
  "OPEN",
  "ACKNOWLEDGED",
  "REASSIGNED",
  "RESOLVED",
  "SUPPRESSED",
] as const;
export const ReviewEscalationStatusSchema = z.enum(REVIEW_ESCALATION_STATUSES);
export type ReviewEscalationStatus = z.infer<typeof ReviewEscalationStatusSchema>;

export const REVIEW_ESCALATION_TERMINAL: ReadonlySet<ReviewEscalationStatus> =
  new Set(["RESOLVED", "SUPPRESSED"]);

export function isTerminalReviewEscalationStatus(
  status: ReviewEscalationStatus,
): boolean {
  return REVIEW_ESCALATION_TERMINAL.has(status);
}

/**
 * T-060 / T-052 (stage C) — the ONE set of escalation statuses that are still
 * active. Every surface (queues, counts, notifications, the Review page) reads
 * this set: acknowledged and reassigned escalations are still active.
 */
export const REVIEW_ESCALATION_ACTIVE_STATUSES = ["OPEN", "ACKNOWLEDGED", "REASSIGNED"] as const;

export function isActiveReviewEscalationStatus(status: string): boolean {
  return (REVIEW_ESCALATION_ACTIVE_STATUSES as ReadonlyArray<string>).includes(status);
}

/**
 * T-049 (stage C) — escalation severity rank. Severity is stored as text, so a
 * database `ORDER BY severity DESC` is alphabetical (WARNING > INFO > HIGH >
 * CRITICAL) and must never be used to pick "the" escalation.
 */
export const REVIEW_ESCALATION_SEVERITY_RANK: Readonly<Record<string, number>> = {
  CRITICAL: 4,
  HIGH: 3,
  WARNING: 2,
  INFO: 1,
};

export function reviewEscalationSeverityRank(severity: string | null | undefined): number {
  return REVIEW_ESCALATION_SEVERITY_RANK[String(severity ?? "").toUpperCase()] ?? 0;
}

/** Highest severity first, then newest. Stable for equal keys. */
export function compareReviewEscalationsBySeverity(
  a: { severity: string; createdAt: Date | string },
  b: { severity: string; createdAt: Date | string },
): number {
  const rank = reviewEscalationSeverityRank(b.severity) - reviewEscalationSeverityRank(a.severity);
  if (rank !== 0) return rank;
  return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
}

/**
 * T-049 (stage C) — the ONE selector: of a review's escalations, the active one
 * with the highest severity (then the newest) plus how many are active.
 * Resolving one never hides another that is still active.
 */
export function selectGoverningEscalation<
  T extends { severity: string; status: string; createdAt: Date | string },
>(rows: ReadonlyArray<T>): { top: T | null; activeCount: number } {
  const active = rows.filter((r) => isActiveReviewEscalationStatus(r.status));
  if (active.length === 0) return { top: null, activeCount: 0 };
  const sorted = [...active].sort(compareReviewEscalationsBySeverity);
  return { top: sorted[0]!, activeCount: active.length };
}

// -----------------------------------------------------------------------------
// T-052 (stage C) — count units. A review count and an escalation count are
// different measures (COR-A): one review can carry two active escalations.
// Every count a surface shows names its unit from this map.
// -----------------------------------------------------------------------------

export const REVIEW_COUNT_UNITS = ["reviews", "escalations", "records", "samples", "tasks"] as const;
export type ReviewCountUnit = (typeof REVIEW_COUNT_UNITS)[number];

const REVIEW_COUNT_UNIT_WORDS: Readonly<Record<ReviewCountUnit, [string, string]>> = {
  reviews: ["review", "reviews"],
  escalations: ["escalation", "escalations"],
  records: ["record", "records"],
  samples: ["QC sample", "QC samples"],
  tasks: ["team task", "team tasks"],
};

/** "1 review", "2 escalations". */
export function formatReviewCount(count: number, unit: ReviewCountUnit): string {
  const [one, many] = REVIEW_COUNT_UNIT_WORDS[unit];
  return `${count} ${count === 1 ? one : many}`;
}

export const REVIEW_COUNT_DEFINITIONS = {
  openReviews: { label: "Open reviews", unit: "reviews", definition: "Reviews not approved, rejected or archived." },
  unassignedReviews: { label: "Unassigned reviews", unit: "reviews", definition: "Open reviews with no assignee." },
  myReviews: { label: "My reviews", unit: "reviews", definition: "Open reviews assigned to you." },
  inProgressReviews: { label: "In progress", unit: "reviews", definition: "Open reviews a reviewer has started." },
  escalatedReviews: {
    label: "Escalated reviews",
    unit: "reviews",
    definition: "Open reviews with escalated status or at least one active escalation.",
  },
  activeEscalations: {
    label: "Active escalations",
    unit: "escalations",
    definition: "Escalations that are open, acknowledged or reassigned. One review can carry several.",
  },
  completedReviews7d: { label: "Completed (7 days)", unit: "reviews", definition: "Reviews finished in the last 7 days." },
  pendingQcSamples: {
    label: "QC awaiting verdict",
    unit: "samples",
    definition: "QC samples sampled, assigned or in progress.",
  },
  awaitingFirstReview: {
    label: "Awaiting first review",
    unit: "reviews",
    definition: "Open reviews whose current round has no decision yet.",
  },
} as const satisfies Record<string, { label: string; unit: ReviewCountUnit; definition: string }>;

export type ReviewCountKey = keyof typeof REVIEW_COUNT_DEFINITIONS;

/** T-054 (stage C) — the ONE "QC awaiting verdict" state set. */
export const QC_SAMPLE_PENDING_STATES = ["SAMPLED", "ASSIGNED", "IN_PROGRESS"] as const;

/**
 * T-057 (stage C) — the DB status ESCALATED comes from an escalation, a first /
 * second conflict or an unresolved adjudication: never "manual decision".
 */
export const REVIEW_ESCALATED_STATUS_LABEL = "Escalated status (conflict or escalation)";

/**
 * T-064 (stage C) — the Evidence Library's record figures are about RECORDS,
 * not review workflows: "Unassigned" there meant "no case linked" and
 * "Review-ready" a per-record marker, so they disagreed with the review
 * counts (O-07: 6 records vs 5 reviews). They now say what they count.
 */
/**
 * T-059 (stage C) — the Collaboration Teams workload card counts TEAM TASKS
 * (collaboration-team assignments), not review workflows: with zero tasks and
 * two assigned reviews it said "nothing assigned to an individual". It now
 * names its unit and never claims nobody carries work.
 */
export const COLLABORATION_TEAM_WORKLOAD_COPY = {
  peopleLabel: "People carrying team tasks",
  busiestMeta: (open: number) => `heaviest load ${open} open team ${open === 1 ? "task" : "tasks"}`,
  noneMeta: "no team task is assigned to a person (reviews are counted in Review)",
} as const;

export const EVIDENCE_LIBRARY_RECORD_FIGURE_COPY = {
  notInCase: { label: "Records not in a case", caption: "No case linked yet" },
  reviewReadyMarker: { label: "Review-ready markers", caption: "Records on this page" },
} as const;

const ESCALATION_STATUS_TRANSITIONS: Readonly<
  Record<ReviewEscalationStatus, ReadonlyArray<ReviewEscalationStatus>>
> = {
  OPEN: ["ACKNOWLEDGED", "REASSIGNED", "RESOLVED", "SUPPRESSED"],
  ACKNOWLEDGED: ["REASSIGNED", "RESOLVED", "SUPPRESSED"],
  REASSIGNED: ["ACKNOWLEDGED", "RESOLVED", "SUPPRESSED"],
  RESOLVED: [], // terminal
  SUPPRESSED: [], // terminal
};

export function isAllowedEscalationStatusTransition(
  from: ReviewEscalationStatus,
  to: ReviewEscalationStatus,
): boolean {
  if (from === to) return true;
  return ESCALATION_STATUS_TRANSITIONS[from]?.includes(to) ?? false;
}

export function listAllowedEscalationStatusTransitions(
  from: ReviewEscalationStatus,
): ReadonlyArray<ReviewEscalationStatus> {
  return ESCALATION_STATUS_TRANSITIONS[from] ?? [];
}

// -----------------------------------------------------------------------------
// Reviewer action catalog (for action audit + UI button labelling)
// -----------------------------------------------------------------------------

export const REVIEWER_OPS_ACTIONS = [
  "ASSIGN",
  "REASSIGN",
  "START",
  "PAUSE",
  "REQUEST_INFO",
  "APPROVE",
  "REJECT",
  "ESCALATE",
  "ACKNOWLEDGE_ESCALATION",
  "RESOLVE_ESCALATION",
  "SUPPRESS_ESCALATION",
  "RECONCILE",
] as const;
export type ReviewerOpsAction = (typeof REVIEWER_OPS_ACTIONS)[number];

// -----------------------------------------------------------------------------
// Error codes — surface to the route layer for stable client mapping.
// -----------------------------------------------------------------------------

export const REVIEWER_OPS_ERROR_CODES = [
  "REVIEW_INVALID_TRANSITION",
  "REVIEW_SLA_BREACHED",
  "REVIEW_GOVERNANCE_BLOCKED",
  "REVIEW_STEP_UP_REQUIRED",
  "REVIEW_ESCALATION_EXISTS",
  "REVIEW_PERMISSION_DENIED",
  "REVIEW_NOTE_REQUIRED",
  "REVIEW_WORKFLOW_NOT_FOUND",
  "REVIEW_ESCALATION_NOT_FOUND",
  "REVIEW_ESCALATION_TERMINAL",
  "REVIEW_ACTOR_BLOCKED",
  // A concurrent change won the race (2026-10-24) — distinct from a stage
  // that never allowed the move.
  "REVIEW_CONFLICT",
  // Members audit REV-02 (2026-10-25) — the person named cannot carry this
  // review: not an active reviewer-capable member, or unable to reach it.
  "REVIEW_ASSIGNEE_NOT_ELIGIBLE",
  // Members audit (unassigned-member decision) — on PRO/TEAM the person is not
  // yet placed in an active Collaboration Team.
  "REVIEW_ASSIGNEE_NOT_PLACED",
] as const;
export type ReviewerOpsErrorCode = (typeof REVIEWER_OPS_ERROR_CODES)[number];

// -----------------------------------------------------------------------------
// SLA computation — Phase 25 multi-dimensional helper.
//
// Returns a per-dimension snapshot. Each dimension is independent: an
// assignment SLA can be COMPLETED while a completion SLA is BREACHED.
// `paused` is a row-level flag that maps every active dimension to PAUSED.
// -----------------------------------------------------------------------------

export type ReviewSlaComputationInput = {
  nowUtc?: Date;
  paused?: boolean;
  hasOpenEscalation?: boolean;
  // Per-dimension due-at + completion timestamps. Anything null means
  // the dimension is not configured.
  assignmentDueAtUtc?: Date | null;
  assignedAtUtc?: Date | null;
  firstReviewDueAtUtc?: Date | null;
  firstReviewedAtUtc?: Date | null;
  completionDueAtUtc?: Date | null;
  completedAtUtc?: Date | null;
  escalationDueAtUtc?: Date | null;
  escalationResolvedAtUtc?: Date | null;
  /** Minutes before due-at within which we surface DUE_SOON (default 360). */
  dueSoonMinutes?: number;
};

export function computeReviewerOpsSlaSnapshot(
  input: ReviewSlaComputationInput,
): ReadonlyArray<ReviewSlaDimensionSnapshot> {
  const now = (input.nowUtc ?? new Date()).getTime();
  const dueSoonMs = (input.dueSoonMinutes ?? 360) * 60 * 1000;
  const result: ReviewSlaDimensionSnapshot[] = [];
  type Pair = {
    dimension: ReviewSlaDimension;
    dueAt: Date | null | undefined;
    completedAt: Date | null | undefined;
  };
  const pairs: Pair[] = [
    {
      dimension: "ASSIGNMENT",
      dueAt: input.assignmentDueAtUtc,
      completedAt: input.assignedAtUtc,
    },
    {
      dimension: "FIRST_REVIEW",
      dueAt: input.firstReviewDueAtUtc,
      completedAt: input.firstReviewedAtUtc,
    },
    {
      dimension: "COMPLETION",
      dueAt: input.completionDueAtUtc,
      completedAt: input.completedAtUtc,
    },
    {
      dimension: "ESCALATION",
      dueAt: input.escalationDueAtUtc,
      completedAt: input.escalationResolvedAtUtc,
    },
  ];
  for (const p of pairs) {
    const completedAtUtc = p.completedAt ? p.completedAt.toISOString() : null;
    if (!p.dueAt) {
      result.push({
        dimension: p.dimension,
        dueAtUtc: null,
        dueSoonAtUtc: null,
        state: p.completedAt ? "COMPLETED" : "HEALTHY",
        timeRemainingMs: null,
        breachDurationMs: null,
        completedAtUtc,
        metOnTime: null,
      });
      continue;
    }
    const dueAtMs = p.dueAt.getTime();
    const dueSoonAtMs = dueAtMs - dueSoonMs;
    let state: ReviewerOpsSlaState;
    let timeRemainingMs: number | null = dueAtMs - now;
    let breachDurationMs: number | null = null;
    // T-045 (stage C) — an open escalation is NOT a deadline state. The
    // escalation is shown on its own (severity + active count); a dimension
    // reads overdue only once its deadline has passed. `hasOpenEscalation` is
    // accepted for compatibility and no longer changes any state.
    if (p.completedAt) {
      state = "COMPLETED";
      timeRemainingMs = null;
    } else if (input.paused) {
      state = "PAUSED";
    } else if (now < dueSoonAtMs) {
      state = "HEALTHY";
    } else if (now < dueAtMs) {
      state = "DUE_SOON";
    } else {
      state = "BREACHED";
      breachDurationMs = now - dueAtMs;
      timeRemainingMs = -breachDurationMs;
    }
    result.push({
      dimension: p.dimension,
      dueAtUtc: p.dueAt.toISOString(),
      dueSoonAtUtc: new Date(dueSoonAtMs).toISOString(),
      state,
      timeRemainingMs,
      breachDurationMs,
      completedAtUtc,
      metOnTime: p.completedAt ? p.completedAt.getTime() <= dueAtMs : null,
    });
  }
  return result;
}

/**
 * Roll up the per-dimension snapshots to one overall SLA state for
 * dashboards. Worst-state wins (BREACHED > ESCALATED > DUE_SOON >
 * PAUSED > BLOCKED > HEALTHY > COMPLETED).
 */
const SLA_SEVERITY_ORDER: ReadonlyArray<ReviewerOpsSlaState> = [
  "BREACHED",
  "ESCALATED",
  "DUE_SOON",
  "BLOCKED",
  "PAUSED",
  "HEALTHY",
  "COMPLETED",
];

/**
 * The PRESENTED rollup (the review's header). Only the review's own deadlines
 * that exist take part (T-045, T-046): the escalation trigger and dimensions
 * with no deadline never make a review read overdue or on track.
 */
export function rollupReviewerOpsSlaState(
  snapshots: ReadonlyArray<ReviewSlaDimensionSnapshot>,
): ReviewerOpsSlaState {
  const presented = presentReviewSlaDimensions(snapshots);
  if (presented.length === 0) return "HEALTHY";
  for (const s of SLA_SEVERITY_ORDER) {
    if (presented.some((x) => x.state === s)) return s;
  }
  return "HEALTHY";
}

/**
 * T-046 (stage C) — the dimensions a reader is shown: the review's own
 * deadlines (never the escalation trigger) that actually have a deadline.
 */
export function presentReviewSlaDimensions(
  snapshots: ReadonlyArray<ReviewSlaDimensionSnapshot>,
): ReadonlyArray<ReviewSlaDimensionSnapshot> {
  return snapshots.filter((s) => isReviewDeadlineDimension(s.dimension) && s.dueAtUtc !== null);
}

export type GoverningReviewDeadline =
  /** The earliest deadline still open. */
  | { kind: "open"; dimension: ReviewSlaDimensionSnapshot }
  /** Every presented deadline has its fact. */
  | { kind: "all_met"; missed: number }
  /** The review has no deadline at all. */
  | { kind: "none" };

/**
 * T-043 / T-048 (stage C) — ONE function for "the deadline that governs this
 * review now": the earliest not-yet-completed presented dimension. Used by the
 * Review page header and focus mode alike.
 */
export function governingReviewDeadline(
  snapshots: ReadonlyArray<ReviewSlaDimensionSnapshot>,
): GoverningReviewDeadline {
  const presented = presentReviewSlaDimensions(snapshots);
  if (presented.length === 0) return { kind: "none" };
  const open = presented
    .filter((s) => s.state !== "COMPLETED")
    .sort((a, b) => Date.parse(a.dueAtUtc as string) - Date.parse(b.dueAtUtc as string));
  if (open.length > 0) return { kind: "open", dimension: open[0]! };
  return { kind: "all_met", missed: presented.filter((s) => s.metOnTime === false).length };
}

export type ReviewSlaDimensionOutcome =
  | { kind: "met"; completedAtUtc: string }
  | { kind: "missed"; completedAtUtc: string; lateByMs: number }
  /** Completed with no deadline to compare against. */
  | { kind: "done"; completedAtUtc: string }
  | { kind: "open"; dueAtUtc: string; timeRemainingMs: number }
  | { kind: "due_soon"; dueAtUtc: string; timeRemainingMs: number }
  | { kind: "overdue"; dueAtUtc: string; overdueByMs: number }
  | { kind: "paused"; dueAtUtc: string | null };

/**
 * T-043 (stage C) — what a dimension says. "met" only when the fact happened on
 * or before the deadline, with the fact's time; a late fact is "missed" with the
 * lateness; an open dimension carries its deadline.
 */
export function reviewSlaDimensionOutcome(
  s: ReviewSlaDimensionSnapshot,
): ReviewSlaDimensionOutcome {
  if (s.completedAtUtc) {
    if (s.dueAtUtc === null || s.metOnTime === null) {
      return { kind: "done", completedAtUtc: s.completedAtUtc };
    }
    if (s.metOnTime) return { kind: "met", completedAtUtc: s.completedAtUtc };
    return {
      kind: "missed",
      completedAtUtc: s.completedAtUtc,
      lateByMs: Date.parse(s.completedAtUtc) - Date.parse(s.dueAtUtc),
    };
  }
  if (s.state === "PAUSED") return { kind: "paused", dueAtUtc: s.dueAtUtc };
  const due = s.dueAtUtc as string;
  const remaining = s.timeRemainingMs ?? 0;
  if (s.state === "BREACHED") return { kind: "overdue", dueAtUtc: due, overdueByMs: -remaining };
  if (s.state === "DUE_SOON") return { kind: "due_soon", dueAtUtc: due, timeRemainingMs: remaining };
  return { kind: "open", dueAtUtc: due, timeRemainingMs: remaining };
}

// -----------------------------------------------------------------------------
// One reading of a review row's deadlines (WORKFLOW-006, WORKFLOW-007).
//
// The stored `slaStatus` drives the queues, counts and reminders, and the
// per-dimension snapshot drives the badge. They used to be two calculations with
// different windows, so a row could read Due soon on the badge and be absent from
// the Due soon queue. Both now start from this mapping.
// -----------------------------------------------------------------------------

/** Workflow DB statuses whose review is over. The one definition of open work. */
export const REVIEW_FINISHED_DB_STATUSES = [
  "CLOSED",
  "REJECTED_INSUFFICIENT",
  "APPROVED_INTERNAL",
] as const;

export function isReviewOpenDbStatus(status: string): boolean {
  return !(REVIEW_FINISHED_DB_STATUSES as ReadonlyArray<string>).includes(status);
}

export type ReviewSlaRowFacts = {
  slaPausedAtUtc?: Date | null;
  assignmentDueAtUtc?: Date | null;
  assignedAtUtc?: Date | null;
  firstResponseDueAtUtc?: Date | null;
  /**
   * The last reviewer touch (Start writes it). NOT a first review: the
   * presented first-review dimension completes on `firstDecidedAtUtc` (T-044).
   * Read only by the stored-status mapping, whose semantics stay stable.
   */
  lastReviewedAt?: Date | null;
  /** When the review's first decision was recorded (any round). */
  firstDecidedAtUtc?: Date | null;
  /** The review's deadline. An operator-typed date wins over the stamped one. */
  dueAt?: Date | null;
  completionDueAtUtc?: Date | null;
  completedAtUtc?: Date | null;
  closedAt?: Date | null;
  escalationDueAtUtc?: Date | null;
  escalatedAtUtc?: Date | null;
  /** The due-soon window stamped with the row's deadlines. */
  slaDueSoonHours?: number | null;
};

/**
 * T-168 / T-043 / T-044 (stage C) — the PRESENTED reading of a row's SLA facts.
 *
 *  - First review completes on the first recorded decision (`firstDecidedAtUtc`),
 *    or when the review finished without one. Start (`lastReviewedAt`) is not a
 *    first review.
 *  - The ESCALATION dimension is the engine's automatic-escalation trigger. Its
 *    "completion" is the review being escalated or finished; it is computed for
 *    compatibility but never presented and never rolled up (T-045).
 */
export function reviewSlaInputFromRow(
  row: ReviewSlaRowFacts,
  opts: { nowUtc?: Date; hasOpenEscalation?: boolean; dueSoonHours?: number } = {},
): ReviewSlaComputationInput {
  const finishedAt = row.completedAtUtc ?? row.closedAt ?? null;
  const dueSoonHours =
    row.slaDueSoonHours ?? opts.dueSoonHours ?? REVIEWER_OPS_DEFAULT_SLA_POLICY.dueSoonHours;
  return {
    nowUtc: opts.nowUtc,
    paused: Boolean(row.slaPausedAtUtc),
    hasOpenEscalation: Boolean(opts.hasOpenEscalation),
    assignmentDueAtUtc: row.assignmentDueAtUtc ?? null,
    assignedAtUtc: row.assignedAtUtc ?? finishedAt,
    firstReviewDueAtUtc: row.firstResponseDueAtUtc ?? null,
    firstReviewedAtUtc: row.firstDecidedAtUtc ?? finishedAt,
    completionDueAtUtc: row.dueAt ?? row.completionDueAtUtc ?? null,
    completedAtUtc: finishedAt,
    escalationDueAtUtc: row.escalationDueAtUtc ?? null,
    escalationResolvedAtUtc: row.escalatedAtUtc ?? finishedAt,
    dueSoonMinutes: dueSoonHours * 60,
  };
}

/**
 * True when the row carries at least one of the review's OWN deadlines. The
 * automatic-escalation trigger is not a review deadline (T-045), so a row that
 * carries only the trigger has no SLA status.
 */
export function reviewRowHasDeadline(row: ReviewSlaRowFacts): boolean {
  return Boolean(
    row.assignmentDueAtUtc ?? row.firstResponseDueAtUtc ?? row.dueAt ?? row.completionDueAtUtc,
  );
}

export type StoredReviewSlaStatus = "ON_TRACK" | "DUE_SOON" | "BREACHED" | "PAUSED";

/**
 * The stored `slaStatus`: the queues, counts, workload, reminders, the breach
 * sweep and its e-mail read it. Since 2026-11-25 (Team remediation round 2) it
 * is the PRESENTED reading, the same one the Review header shows: first review
 * completes on the first recorded decision (never on Start), and the escalation
 * trigger never makes a review overdue. Before, it counted Start as the first
 * review and rolled the trigger up, so a started-but-undecided review past its
 * first-review deadline read "On track" in the queues while its header read
 * "Overdue", and every review not escalated by the trigger was stored BREACHED
 * and e-mailed as overdue while its header read healthy.
 *
 * Callers that read rows decided before `first_decided_at_utc` existed must
 * pass the read-time facts (`withReadTimeSlaFacts`), as the header does.
 * A missed deadline is a breach: no grace period. Null when the row has none of
 * the review's own deadlines.
 */
export function storedReviewSlaStatus(
  row: ReviewSlaRowFacts,
  opts: { nowUtc?: Date; dueSoonHours?: number } = {},
): StoredReviewSlaStatus | null {
  if (!reviewRowHasDeadline(row)) return null;
  // An open escalation changes the badge's wording, never the timing.
  const snapshots = computeReviewerOpsSlaSnapshot(reviewSlaInputFromRow(row, opts));
  switch (rollupReviewerOpsSlaState(snapshots)) {
    case "BREACHED":
      return "BREACHED";
    case "DUE_SOON":
      return "DUE_SOON";
    case "PAUSED":
      return "PAUSED";
    default:
      return "ON_TRACK";
  }
}

/**
 * When the review became overdue: the earliest of its own presented deadlines
 * that is missed now. Null when nothing is missed. The breach sweep uses it to
 * tell a breach it detects as it happens from one it finds long after the
 * deadline (a backlog re-read under new rules, or a sweep outage).
 */
export function reviewSlaBreachedSince(
  row: ReviewSlaRowFacts,
  opts: { nowUtc?: Date; dueSoonHours?: number } = {},
): Date | null {
  if (!reviewRowHasDeadline(row)) return null;
  const missed = presentReviewSlaDimensions(computeReviewerOpsSlaSnapshot(reviewSlaInputFromRow(row, opts)))
    .filter((d) => d.state === "BREACHED" && d.dueAtUtc !== null)
    .map((d) => new Date(d.dueAtUtc as string | Date).getTime());
  return missed.length > 0 ? new Date(Math.min(...missed)) : null;
}

// -----------------------------------------------------------------------------
// Default SLA policy. The route layer reads env vars; the shared
// defaults are the brief's documented values.
// -----------------------------------------------------------------------------

export const REVIEWER_OPS_DEFAULT_SLA_POLICY = {
  assignmentHours: 4,
  firstReviewHours: 24,
  completionHours: 72,
  escalationHours: 48,
  dueSoonHours: 6,
} as const;

export type ReviewerOpsSlaPolicy = typeof REVIEWER_OPS_DEFAULT_SLA_POLICY;

// -----------------------------------------------------------------------------
// Workload heuristic
//
// Score is in [0..100] where 100 = idle, 0 = saturated. The exact
// thresholds are operator-tunable in the workload service; this helper
// computes a deterministic starting score so tests don't need to mock
// the service.
// -----------------------------------------------------------------------------

export type ReviewerWorkloadCountsInput = {
  activeReviewCount: number;
  overdueReviewCount: number;
  dueSoonReviewCount: number;
  escalatedReviewCount: number;
  needsInfoReviewCount: number;
};

export function computeReviewerCapacityScore(
  counts: ReviewerWorkloadCountsInput,
): number {
  // Weighted penalty system. The numbers are not magic — they encode
  // "an escalation is 4x the load of an active review", which is the
  // brief's "operator-explainable" guidance.
  const penalty =
    counts.activeReviewCount * 5 +
    counts.dueSoonReviewCount * 8 +
    counts.overdueReviewCount * 15 +
    counts.escalatedReviewCount * 20 +
    counts.needsInfoReviewCount * 2;
  const score = 100 - penalty;
  if (score < 0) return 0;
  if (score > 100) return 100;
  return score;
}

// -----------------------------------------------------------------------------
// Operator-readable label catalog — used by the API + UI. No legal
// overclaim phrases. This catalog is what the route layer sends to the
// client; the UI never composes free-form labels.
// -----------------------------------------------------------------------------

export const REVIEWER_OPS_ALLOWED_LABELS: ReadonlyArray<string> = [
  "reviewer approved",
  "review completed",
  "workflow requirements satisfied",
  "integrity signals",
  "verification signals",
  "governance applied",
  "review blocked",
  "escalation required",
  "visibility restricted",
  "assignment due soon",
  "first review due soon",
  "completion due soon",
  "assignment overdue",
  "first review overdue",
  "completion overdue",
  "escalation overdue",
  "review paused",
  "reviewer inactive",
];

export function isAllowedReviewerOpsLabel(label: string): boolean {
  return REVIEWER_OPS_ALLOWED_LABELS.includes(label);
}

// -----------------------------------------------------------------------------
// Forbidden overclaim phrases — re-export the search catalog so the
// reviewer-ops route layer scrubs reason/note inputs against the same
// list (single source of truth lives in search.ts).
// -----------------------------------------------------------------------------

export { stringContainsForbiddenOverclaim } from "./search.js";

// =============================================================================
// Phase 25.5 — Reviewer Operations Hardening
// =============================================================================

// -----------------------------------------------------------------------------
// SLA policy — workspace + template overrides on top of env defaults.
//
// Precedence (most-specific wins):
//   workflow-template override  >  workspace override  >  env default
//
// All values are hours; the resolver clamps to the bounds below.
// -----------------------------------------------------------------------------

export const REVIEWER_OPS_SLA_POLICY_HOURS_MIN = 1;
export const REVIEWER_OPS_SLA_POLICY_HOURS_MAX = 720; // 30 days

export const ReviewerOpsSlaPolicySchema = z
  .object({
    assignmentHours: z
      .number()
      .int()
      .min(REVIEWER_OPS_SLA_POLICY_HOURS_MIN)
      .max(REVIEWER_OPS_SLA_POLICY_HOURS_MAX)
      .optional(),
    firstReviewHours: z
      .number()
      .int()
      .min(REVIEWER_OPS_SLA_POLICY_HOURS_MIN)
      .max(REVIEWER_OPS_SLA_POLICY_HOURS_MAX)
      .optional(),
    completionHours: z
      .number()
      .int()
      .min(REVIEWER_OPS_SLA_POLICY_HOURS_MIN)
      .max(REVIEWER_OPS_SLA_POLICY_HOURS_MAX)
      .optional(),
    escalationHours: z
      .number()
      .int()
      .min(REVIEWER_OPS_SLA_POLICY_HOURS_MIN)
      .max(REVIEWER_OPS_SLA_POLICY_HOURS_MAX)
      .optional(),
    dueSoonHours: z
      .number()
      .int()
      .min(REVIEWER_OPS_SLA_POLICY_HOURS_MIN)
      .max(REVIEWER_OPS_SLA_POLICY_HOURS_MAX)
      .optional(),
  })
  .strict();
export type ReviewerOpsSlaPolicyOverride = z.infer<
  typeof ReviewerOpsSlaPolicySchema
>;

/**
 * Resolve the effective SLA policy from layered overrides. Each input
 * layer is partial; the helper returns a fully-populated policy
 * filling missing fields from the next layer down.
 *
 * Layers (top wins):
 *   1. `templateOverride`   — EvidenceWorkflowTemplate.reviewPolicyJson.sla
 *   2. `workspaceOverride`  — WorkspaceGovernancePolicy.default*Hours fields
 *   3. `envDefaults`        — process env (REVIEW_SLA_*_HOURS)
 *   4. `REVIEWER_OPS_DEFAULT_SLA_POLICY` (final fallback)
 */
export type SlaPolicyResolutionInput = {
  templateOverride?: ReviewerOpsSlaPolicyOverride | null;
  workspaceOverride?: ReviewerOpsSlaPolicyOverride | null;
  envDefaults?: ReviewerOpsSlaPolicyOverride | null;
};

export function resolveReviewerOpsSlaPolicy(
  input: SlaPolicyResolutionInput,
): ReviewerOpsSlaPolicy {
  const pick = <K extends keyof ReviewerOpsSlaPolicy>(
    key: K,
  ): ReviewerOpsSlaPolicy[K] => {
    const t = input.templateOverride?.[key as keyof ReviewerOpsSlaPolicyOverride];
    if (typeof t === "number") return t as ReviewerOpsSlaPolicy[K];
    const w = input.workspaceOverride?.[key as keyof ReviewerOpsSlaPolicyOverride];
    if (typeof w === "number") return w as ReviewerOpsSlaPolicy[K];
    const e = input.envDefaults?.[key as keyof ReviewerOpsSlaPolicyOverride];
    if (typeof e === "number") return e as ReviewerOpsSlaPolicy[K];
    return REVIEWER_OPS_DEFAULT_SLA_POLICY[key];
  };
  return {
    assignmentHours: pick("assignmentHours"),
    firstReviewHours: pick("firstReviewHours"),
    completionHours: pick("completionHours"),
    escalationHours: pick("escalationHours"),
    dueSoonHours: pick("dueSoonHours"),
  };
}

// -----------------------------------------------------------------------------
// Reminder kinds — bounded catalog for the Phase 25.5 reminder engine.
// -----------------------------------------------------------------------------

export const REVIEWER_OPS_REMINDER_KINDS = [
  "DUE_SOON",
  "ESCALATION_WARNING",
  "REVIEWER_INACTIVE",
  "REASSIGNMENT_SUGGESTION",
] as const;
export const ReviewerOpsReminderKindSchema = z.enum(
  REVIEWER_OPS_REMINDER_KINDS,
);
export type ReviewerOpsReminderKind = z.infer<
  typeof ReviewerOpsReminderKindSchema
>;

export const REVIEWER_OPS_REMINDER_STATUSES = [
  "SCHEDULED",
  "DELIVERED",
  "SUPPRESSED",
  "FAILED",
] as const;
export type ReviewerOpsReminderStatus =
  (typeof REVIEWER_OPS_REMINDER_STATUSES)[number];

// -----------------------------------------------------------------------------
// Bulk triage — bounded action catalog + input schema.
// -----------------------------------------------------------------------------

export const REVIEWER_OPS_BULK_ACTIONS = [
  "ASSIGN",
  "REASSIGN",
  "ESCALATE",
  "PAUSE",
  "REQUEST_INFO",
  "CLOSE",
  "PRIORITY_HIGH",
  "PRIORITY_NORMAL",
  "PRIORITY_URGENT",
] as const;
export const ReviewerOpsBulkActionSchema = z.enum(REVIEWER_OPS_BULK_ACTIONS);
export type ReviewerOpsBulkAction = z.infer<typeof ReviewerOpsBulkActionSchema>;

// Bulk operations are bounded to keep the request cycle predictable +
// the audit chain reviewable.
export const REVIEWER_OPS_BULK_MAX_ITEMS = 100;

export const ReviewerOpsBulkInputSchema = z
  .object({
    teamId: z.string().uuid(),
    workflowIds: z
      .array(z.string().uuid())
      .min(1)
      .max(REVIEWER_OPS_BULK_MAX_ITEMS),
    action: ReviewerOpsBulkActionSchema,
    // Per-action optional payload.
    assignedToUserId: z.string().uuid().optional(),
    note: z.string().min(1).max(1000).optional(),
    /**
     * T-030 — "single" marks a CLOSE of exactly one review sent from the
     * review itself (Archive): its own action class under the reject flag and
     * the single-review session window, never labelled bulk. Absent = bulk.
     */
    scope: z.enum(["single", "bulk"]).optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.scope === "single" && input.workflowIds.length !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "scope single names exactly one review",
        path: ["scope"],
      });
    }
    if (input.action === "ASSIGN" || input.action === "REASSIGN") {
      if (!input.assignedToUserId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "assignedToUserId required for ASSIGN/REASSIGN",
          path: ["assignedToUserId"],
        });
      }
    }
    if (
      input.action === "ESCALATE" ||
      input.action === "PAUSE" ||
      input.action === "REQUEST_INFO"
    ) {
      if (!input.note || input.note.trim().length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "note required for ESCALATE/PAUSE/REQUEST_INFO",
          path: ["note"],
        });
      }
    }
  });
export type ReviewerOpsBulkInput = z.infer<typeof ReviewerOpsBulkInputSchema>;

/**
 * THE BULK ITEM ERROR CONTRACT (2026-10-24).
 *
 * A failed bulk row used to carry `err.message.slice(0, 200)` — whatever the
 * thrown error said, Prisma text and internal identifiers included — and
 * every unmapped refusal was labelled REVIEW_INVALID_TRANSITION, so a missing
 * record, a blank note and a lost race all read the same. A row now carries
 * one of these codes and the fixed message beside it, nothing else; technical
 * detail stays in the server log and Sentry, correlated by the request id.
 *
 *   REVIEW_WORKFLOW_NOT_FOUND  missing OR in another workspace — one answer
 *                              for both, so a foreign id discloses nothing.
 *   REVIEW_NOTE_REQUIRED       the action needs a note and it was blank.
 *   REVIEW_INVALID_TRANSITION  the review's stage does not allow the action.
 *   REVIEW_CONFLICT            someone else changed the review first.
 *   REVIEW_PERMISSION_DENIED   the caller's role may not do this.
 *   REVIEW_ITEM_FAILED         unexpected; reported, never described.
 */
export const REVIEWER_OPS_BULK_ITEM_ERROR_CODES = [
  "REVIEW_WORKFLOW_NOT_FOUND",
  "REVIEW_NOTE_REQUIRED",
  "REVIEW_INVALID_TRANSITION",
  "REVIEW_CONFLICT",
  "REVIEW_PERMISSION_DENIED",
  "REVIEW_GOVERNANCE_BLOCKED",
  "REVIEW_ESCALATION_EXISTS",
  "REVIEW_ACTOR_BLOCKED",
  "REVIEW_ASSIGNEE_NOT_ELIGIBLE",
  "REVIEW_ASSIGNEE_NOT_PLACED",
  "REVIEW_ITEM_FAILED",
] as const;
export type ReviewerOpsBulkItemErrorCode =
  (typeof REVIEWER_OPS_BULK_ITEM_ERROR_CODES)[number];

export type ReviewerOpsBulkNextAction =
  | "ADD_NOTE"
  | "REFRESH_AND_RETRY"
  | "CONTACT_ADMIN"
  | "CONTACT_SUPPORT";

export const REVIEWER_OPS_BULK_ITEM_ERRORS: Readonly<
  Record<
    ReviewerOpsBulkItemErrorCode,
    { message: string; nextAction?: ReviewerOpsBulkNextAction }
  >
> = {
  REVIEW_WORKFLOW_NOT_FOUND: {
    message: "This review was not found in this workspace.",
  },
  REVIEW_NOTE_REQUIRED: {
    message: "This action needs a note.",
    nextAction: "ADD_NOTE",
  },
  REVIEW_INVALID_TRANSITION: {
    message: "This review's current stage does not allow this action.",
    nextAction: "REFRESH_AND_RETRY",
  },
  REVIEW_CONFLICT: {
    message: "This review was changed by someone else. Refresh and try again.",
    nextAction: "REFRESH_AND_RETRY",
  },
  REVIEW_PERMISSION_DENIED: {
    message: "Your role does not allow this action on this review.",
    nextAction: "CONTACT_ADMIN",
  },
  REVIEW_GOVERNANCE_BLOCKED: {
    message: "A workspace governance rule blocks this action on this review.",
    nextAction: "CONTACT_ADMIN",
  },
  REVIEW_ESCALATION_EXISTS: {
    message: "This review already has an open escalation.",
  },
  REVIEW_ACTOR_BLOCKED: {
    message: "Your access to this workspace does not allow this action.",
    nextAction: "CONTACT_ADMIN",
  },
  REVIEW_ASSIGNEE_NOT_ELIGIBLE: {
    message: "That person cannot be assigned this review. Choose an active reviewer who can open this record.",
    nextAction: "REFRESH_AND_RETRY",
  },
  REVIEW_ASSIGNEE_NOT_PLACED: {
    message: "That person isn't in a Collaboration Team yet. Place them in a team before assigning them work.",
    nextAction: "CONTACT_ADMIN",
  },
  REVIEW_ITEM_FAILED: {
    message:
      "This review could not be updated. Quote the request ID if you contact support.",
    nextAction: "CONTACT_SUPPORT",
  },
};

export type ReviewerOpsBulkItemResult = {
  workflowId: string;
  ok: boolean;
  errorCode?: ReviewerOpsBulkItemErrorCode;
  /** Always the fixed message for `errorCode` — never error text. */
  message?: string;
  nextAction?: ReviewerOpsBulkNextAction;
};

// Set of bulk actions that require a step-up challenge when the
// workspace governance flag `requireStepUpForBulk` is true.
export const REVIEWER_OPS_BULK_HIGH_RISK_ACTIONS: ReadonlySet<ReviewerOpsBulkAction> =
  new Set([
    "ESCALATE",
    "CLOSE",
    "PRIORITY_URGENT",
  ]);

// -----------------------------------------------------------------------------
// Saved queue views (Phase 25.5) — discriminator catalog + filter shape.
// -----------------------------------------------------------------------------

export const REVIEWER_OPS_SAVED_VIEW_SCOPE = "REVIEWER_OPS" as const;
export const SEARCH_SAVED_VIEW_SCOPE = "SEARCH" as const;
/**
 * PHASE B §7 — the operations workbench's own scope on the SAME table.
 *
 * `SavedSearchView.scope` is a plain VARCHAR precisely so a new surface is a
 * new discriminator rather than a new table, so this needs no migration. Every
 * read and write on the operations side pins this value, which is what keeps
 * one surface's views from appearing in another's list.
 */
export const OPERATIONS_SAVED_VIEW_SCOPE = "OPERATIONS" as const;

export const SAVED_VIEW_SCOPES = [
  SEARCH_SAVED_VIEW_SCOPE,
  REVIEWER_OPS_SAVED_VIEW_SCOPE,
  OPERATIONS_SAVED_VIEW_SCOPE,
] as const;
export type SavedViewScope = (typeof SAVED_VIEW_SCOPES)[number];

/**
 * WHAT AN OPERATIONS VIEW MAY STORE.
 *
 * `.strict()`, deliberately: a saved view is a stored query that a later
 * release will replay, and an unrecognised key would either be dropped
 * silently or replayed into a filter that no longer means what it did. It is
 * also the boundary that stops a saved view from becoming a place to smuggle
 * arbitrary JSON into a query builder.
 *
 * The fields are EXACTLY the queue's filters and nothing else — no result
 * count, no timestamp, no cached rows. A view describes a question; storing
 * any part of an answer with it would make the answer stale the moment it
 * was saved.
 */
/**
 * The saved-view SCHEMA VERSION.
 *
 * Stored with every view so a later release can tell a view it understands
 * from one it does not. A view carrying an unknown version is REFUSED rather
 * than replayed: a filter shape that changed meaning between releases would
 * otherwise silently apply a different query than the one that was saved,
 * which is worse than an error the operator can see.
 */
export const OPERATIONS_SAVED_VIEW_SCHEMA_VERSION = 1;

export const OperationsSavedViewFilterSchema = z
  .object({
    /**
     * Absent on views saved before versioning existed. Those are treated as
     * version 1, which is what they are — the shape has not changed since.
     */
    v: z.literal(OPERATIONS_SAVED_VIEW_SCHEMA_VERSION).optional(),
    teamId: z.string().uuid(),
    /** One posture from the closed SLA vocabulary. */
    sla: z
      .enum([
        "UNTRACKED_LEGACY",
        "NOT_APPLICABLE",
        "ON_TRACK",
        "AT_RISK",
        "BREACHED",
        "ACKNOWLEDGED",
        "RESOLVED",
      ])
      .optional(),
    // Each field mirrors the queue route's own parameter EXACTLY — same
    // names, same values, same bounds. A saved view that could express a
    // filter the queue cannot apply is a view that silently does something
    // else when it is replayed.
    // The queue's status FILTER vocabulary: one stored status, the canonical
    // UNRESOLVED set, or ALL (history included) — exactly what the queue
    // route accepts, so a saved "Unresolved" or "All" view replays as itself.
    status: z
      .enum(INCIDENT_STATUS_FILTERS as unknown as [string, ...string[]])
      .optional(),
    severity: z
      .enum(INCIDENT_SEVERITIES as unknown as [string, ...string[]])
      .optional(),
    category: z
      .enum(INCIDENT_CATEGORIES as unknown as [string, ...string[]])
      .optional(),
    /**
     * Ownership. "me" is stored as the WORD, never resolved to the saver's
     * id: a shared view called "Mine" must mean the reader's own work, not
     * permanently the author's.
     */
    owner: z
      .union([
        z.literal("any"),
        z.literal("me"),
        z.literal("unassigned"),
        z.string().uuid(),
      ])
      .optional(),
    q: z.string().trim().max(120).optional(),
    sort: z.enum(["recent", "severity", "oldest", "occurrences"]).optional(),
  })
  .strict();
export type OperationsSavedViewFilter = z.infer<
  typeof OperationsSavedViewFilterSchema
>;

export const ReviewerOpsSavedViewFilterSchema = z
  .object({
    teamId: z.string().uuid(),
    queue: ReviewerOpsQueueTypeSchema.optional(),
    slaStates: z.array(ReviewerOpsSlaStateSchema).max(7).optional(),
    lifecycleStates: z
      .array(ReviewerOpsLifecycleStateSchema)
      .max(10)
      .optional(),
    assignedToUserId: z.string().uuid().optional(),
    onlyMine: z.boolean().optional(),
    priority: z.enum(["LOW", "NORMAL", "HIGH", "URGENT"]).optional(),
    sortBy: z
      .enum(["SLA_URGENCY", "UPDATED_DESC", "PRIORITY_DESC", "CREATED_ASC"])
      .optional(),
  })
  .strict();
export type ReviewerOpsSavedViewFilter = z.infer<
  typeof ReviewerOpsSavedViewFilterSchema
>;

// -----------------------------------------------------------------------------
// Inactivity detection — defaults + bounded threshold.
// -----------------------------------------------------------------------------

export const REVIEWER_OPS_INACTIVITY_DEFAULT_HOURS = 48;
export const REVIEWER_OPS_INACTIVITY_MAX_HOURS = 720;

/**
 * Decide whether a workflow row qualifies as reviewer-inactive.
 * Pure helper so the reconcile sweep + tests share one definition.
 */
export function isReviewerInactive(input: {
  nowUtc: Date;
  lastReviewedAtUtc: Date | null;
  assignedAtUtc: Date | null;
  thresholdHours?: number;
}): boolean {
  const threshold =
    input.thresholdHours ?? REVIEWER_OPS_INACTIVITY_DEFAULT_HOURS;
  const anchor = input.lastReviewedAtUtc ?? input.assignedAtUtc;
  if (!anchor) return false; // no anchor → can't be inactive yet
  const ageMs = input.nowUtc.getTime() - anchor.getTime();
  return ageMs > threshold * 3600_000;
}

// -----------------------------------------------------------------------------
// Analytics — operator-safe projections.
// -----------------------------------------------------------------------------

export type EscalationAnalyticsBucket = {
  /** YYYY-MM-DD UTC day bucket. */
  dayBucket: string;
  opened: number;
  resolved: number;
  suppressed: number;
};

export type EscalationAnalyticsHotspot = {
  reason: ReviewEscalationReason;
  openCount: number;
  resolvedCount: number;
  meanResolutionMs: number | null;
};

export type EscalationAnalyticsProjection = {
  range: { startUtc: string; endUtc: string };
  totalOpen: number;
  totalOpenedInRange: number;
  totalResolvedInRange: number;
  meanResolutionMs: number | null;
  byDay: ReadonlyArray<EscalationAnalyticsBucket>;
  hotspots: ReadonlyArray<EscalationAnalyticsHotspot>;
};

export type ReviewerPerformanceRow = {
  reviewerUserId: string;
  active: number;
  completedInRange: number;
  approvedInRange: number;
  rejectedInRange: number;
  overdue: number;
  escalated: number;
  meanResolutionMs: number | null;
  /** 0..1; null when the reviewer completed nothing in the range (TEAM-SPEC §2.8). */
  slaComplianceRate: number | null;
  /** 0..100; null when no workload snapshot exists for the reviewer. */
  capacityScore: number | null;
};

export type ReviewerPerformanceProjection = {
  range: { startUtc: string; endUtc: string };
  rows: ReadonlyArray<ReviewerPerformanceRow>;
};
