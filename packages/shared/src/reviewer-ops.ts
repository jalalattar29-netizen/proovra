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
  INCIDENT_STATUSES,
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
 * lifecycle state. `hasOpenEscalation` wins over a non-terminal stage —
 * an escalation is always operator-visible.
 */
export function deriveLifecycleState(
  stage: ReviewStage,
  hasOpenEscalation: boolean,
): ReviewerOpsLifecycleState {
  if (hasOpenEscalation) return "ESCALATED";
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
};

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
    if (!p.dueAt) {
      result.push({
        dimension: p.dimension,
        dueAtUtc: null,
        dueSoonAtUtc: null,
        state: "HEALTHY",
        timeRemainingMs: null,
        breachDurationMs: null,
      });
      continue;
    }
    const dueAtMs = p.dueAt.getTime();
    const dueSoonAtMs = dueAtMs - dueSoonMs;
    let state: ReviewerOpsSlaState;
    let timeRemainingMs: number | null = dueAtMs - now;
    let breachDurationMs: number | null = null;
    if (p.completedAt) {
      state = "COMPLETED";
      timeRemainingMs = null;
    } else if (input.paused) {
      state = "PAUSED";
    } else if (
      input.hasOpenEscalation &&
      (p.dimension === "FIRST_REVIEW" || p.dimension === "COMPLETION")
    ) {
      state = "ESCALATED";
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

export function rollupReviewerOpsSlaState(
  snapshots: ReadonlyArray<ReviewSlaDimensionSnapshot>,
): ReviewerOpsSlaState {
  if (snapshots.length === 0) return "HEALTHY";
  for (const s of SLA_SEVERITY_ORDER) {
    if (snapshots.some((x) => x.state === s)) return s;
  }
  return "HEALTHY";
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
  })
  .strict()
  .superRefine((input, ctx) => {
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

export type ReviewerOpsBulkItemResult = {
  workflowId: string;
  ok: boolean;
  errorCode?: string;
  message?: string;
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
    status: z
      .enum(INCIDENT_STATUSES as unknown as [string, ...string[]])
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
  slaComplianceRate: number; // 0..1
  capacityScore: number;
};

export type ReviewerPerformanceProjection = {
  range: { startUtc: string; endUtc: string };
  rows: ReadonlyArray<ReviewerPerformanceRow>;
};
