/**
 * Phase 27 — Enterprise Retention + Legal Hold + Compliance Lifecycle
 * canonical types.
 *
 * Browser-safe (no Prisma, no Node imports). Extends Phase 14
 * `governance.ts` with first-class versioned retention policies,
 * destruction queue lifecycle, and the evidence lifecycle state
 * machine.
 *
 * Hard invariants:
 *   - Lifecycle transitions are deterministic. The orchestrator
 *     refuses any transition not in `EVIDENCE_LIFECYCLE_TRANSITIONS`.
 *   - Hold-aware: while a hold is active, the orchestrator refuses
 *     transitions to PENDING_DESTRUCTION or DESTROYED.
 *   - Immutable retention: a policy with `immutable=true` blocks
 *     destruction even after retention expires.
 *   - Operator-readable labels only. Catalog-bound; never compose
 *     free-form legal text in the UI.
 */

import { z } from "zod";

// -----------------------------------------------------------------------------
// Evidence lifecycle state machine
// -----------------------------------------------------------------------------

export const EVIDENCE_LIFECYCLE_STATES = [
  "ACTIVE",
  "UNDER_REVIEW",
  "ON_HOLD",
  "RETENTION_LOCKED",
  "PENDING_DESTRUCTION",
  "DESTROYED",
  "ARCHIVED",
] as const;
export const EvidenceLifecycleStateSchema = z.enum(
  EVIDENCE_LIFECYCLE_STATES,
);
export type EvidenceLifecycleState = z.infer<
  typeof EvidenceLifecycleStateSchema
>;

/**
 * Allowed transitions. Anything not listed is REJECTED by the
 * lifecycle orchestrator. DESTROYED is terminal. Hold semantics: the
 * orchestrator additionally refuses transitions TO PENDING_DESTRUCTION
 * or DESTROYED whenever a hold is active, regardless of this table.
 */
const EVIDENCE_LIFECYCLE_TRANSITIONS: Readonly<
  Record<EvidenceLifecycleState, ReadonlyArray<EvidenceLifecycleState>>
> = {
  ACTIVE: [
    "UNDER_REVIEW",
    "ON_HOLD",
    "RETENTION_LOCKED",
    "PENDING_DESTRUCTION",
    "ARCHIVED",
  ],
  UNDER_REVIEW: ["ACTIVE", "ON_HOLD", "ARCHIVED"],
  ON_HOLD: ["ACTIVE", "RETENTION_LOCKED", "ARCHIVED"],
  RETENTION_LOCKED: ["ACTIVE", "ON_HOLD", "ARCHIVED"],
  PENDING_DESTRUCTION: ["ACTIVE", "DESTROYED", "ARCHIVED"],
  DESTROYED: [], // terminal
  ARCHIVED: ["ACTIVE", "DESTROYED"],
};

export function isAllowedEvidenceLifecycleTransition(
  from: EvidenceLifecycleState,
  to: EvidenceLifecycleState,
): boolean {
  if (from === to) return true; // heartbeat / no-op
  return EVIDENCE_LIFECYCLE_TRANSITIONS[from]?.includes(to) ?? false;
}

export function listAllowedEvidenceLifecycleTransitions(
  from: EvidenceLifecycleState,
): ReadonlyArray<EvidenceLifecycleState> {
  return EVIDENCE_LIFECYCLE_TRANSITIONS[from] ?? [];
}

export const EVIDENCE_LIFECYCLE_TERMINAL_STATES: ReadonlySet<EvidenceLifecycleState> =
  new Set(["DESTROYED"]);

export function isTerminalLifecycleState(
  state: EvidenceLifecycleState,
): boolean {
  return EVIDENCE_LIFECYCLE_TERMINAL_STATES.has(state);
}

// States in which destruction is forbidden regardless of policy.
const DESTRUCTION_FORBIDDEN_STATES: ReadonlySet<EvidenceLifecycleState> = new Set([
  "ON_HOLD",
  "RETENTION_LOCKED",
  "DESTROYED",
]);

export function canEnterPendingDestruction(input: {
  fromState: EvidenceLifecycleState;
  hasActiveHold: boolean;
  immutableRetention: boolean;
}): boolean {
  if (input.hasActiveHold) return false;
  if (input.immutableRetention) return false;
  if (DESTRUCTION_FORBIDDEN_STATES.has(input.fromState)) return false;
  return isAllowedEvidenceLifecycleTransition(
    input.fromState,
    "PENDING_DESTRUCTION",
  );
}

// -----------------------------------------------------------------------------
// Retention policy catalogs
// -----------------------------------------------------------------------------

export const RETENTION_POLICY_STATUSES = [
  "ACTIVE",
  "PAUSED",
  "SUPERSEDED",
  "ARCHIVED",
] as const;
export const RetentionPolicyStatusSchema = z.enum(RETENTION_POLICY_STATUSES);
export type RetentionPolicyStatus = z.infer<typeof RetentionPolicyStatusSchema>;

const RETENTION_POLICY_STATUS_TRANSITIONS: Readonly<
  Record<RetentionPolicyStatus, ReadonlyArray<RetentionPolicyStatus>>
> = {
  ACTIVE: ["PAUSED", "SUPERSEDED", "ARCHIVED"],
  PAUSED: ["ACTIVE", "ARCHIVED"],
  SUPERSEDED: ["ARCHIVED"],
  ARCHIVED: [],
};

export function isAllowedRetentionPolicyTransition(
  from: RetentionPolicyStatus,
  to: RetentionPolicyStatus,
): boolean {
  if (from === to) return true;
  return RETENTION_POLICY_STATUS_TRANSITIONS[from]?.includes(to) ?? false;
}

export const RETENTION_POLICY_SCOPES = [
  "WORKSPACE",
  "EVIDENCE_TYPE",
  "CASE",
  "REGULATORY",
] as const;
export const RetentionPolicyScopeSchema = z.enum(RETENTION_POLICY_SCOPES);
export type RetentionPolicyScope = z.infer<typeof RetentionPolicyScopeSchema>;

export const RETENTION_POLICY_MIN_DAYS = 0; // 0 = immediate
export const RETENTION_POLICY_MAX_DAYS = 36500; // 100 years

/**
 * Bounded policy-shape validation. Routes validate the input via this
 * schema before delegating to the retention engine.
 */
export const RetentionPolicyCreateInputSchema = z
  .object({
    teamId: z.string().uuid(),
    displayName: z.string().min(1).max(180),
    description: z.string().max(2000).nullable().optional(),
    scope: RetentionPolicyScopeSchema,
    scopeQualifier: z.string().min(1).max(40).nullable().optional(),
    caseId: z.string().uuid().nullable().optional(),
    retentionDays: z
      .number()
      .int()
      .min(RETENTION_POLICY_MIN_DAYS)
      .max(RETENTION_POLICY_MAX_DAYS)
      .nullable()
      .optional(),
    immutable: z.boolean().optional(),
    autoExtensionEnabled: z.boolean().optional(),
    autoExtensionDays: z
      .number()
      .int()
      .min(1)
      .max(RETENTION_POLICY_MAX_DAYS)
      .nullable()
      .optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.scope === "EVIDENCE_TYPE" && !input.scopeQualifier) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scopeQualifier"],
        message: "scope=EVIDENCE_TYPE requires scopeQualifier",
      });
    }
    if (input.scope === "REGULATORY" && !input.scopeQualifier) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scopeQualifier"],
        message: "scope=REGULATORY requires scopeQualifier (jurisdiction code)",
      });
    }
    if (input.scope === "CASE" && !input.caseId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["caseId"],
        message: "scope=CASE requires caseId",
      });
    }
    if (input.autoExtensionEnabled && !input.autoExtensionDays) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["autoExtensionDays"],
        message: "auto-extension requires autoExtensionDays",
      });
    }
  });
export type RetentionPolicyCreateInput = z.infer<
  typeof RetentionPolicyCreateInputSchema
>;

export const RetentionPolicyUpdateInputSchema = z
  .object({
    teamId: z.string().uuid(),
    id: z.string().uuid(),
    displayName: z.string().min(1).max(180).optional(),
    description: z.string().max(2000).nullable().optional(),
    retentionDays: z
      .number()
      .int()
      .min(RETENTION_POLICY_MIN_DAYS)
      .max(RETENTION_POLICY_MAX_DAYS)
      .nullable()
      .optional(),
    immutable: z.boolean().optional(),
    autoExtensionEnabled: z.boolean().optional(),
    autoExtensionDays: z
      .number()
      .int()
      .min(1)
      .max(RETENTION_POLICY_MAX_DAYS)
      .nullable()
      .optional(),
    changeNote: z.string().min(1).max(2000),
  })
  .strict();
export type RetentionPolicyUpdateInput = z.infer<
  typeof RetentionPolicyUpdateInputSchema
>;

// -----------------------------------------------------------------------------
// Retention precedence — the resolver returns ONE effective policy
// per evidence + state. Precedence (most-specific wins):
//   CASE → EVIDENCE_TYPE → REGULATORY → WORKSPACE
// -----------------------------------------------------------------------------

export const RETENTION_PRECEDENCE_ORDER: ReadonlyArray<RetentionPolicyScope> = [
  "CASE",
  "EVIDENCE_TYPE",
  "REGULATORY",
  "WORKSPACE",
];

export function pickHighestPrecedencePolicy<
  T extends { scope: RetentionPolicyScope; status: RetentionPolicyStatus },
>(policies: ReadonlyArray<T>): T | null {
  for (const scope of RETENTION_PRECEDENCE_ORDER) {
    const match = policies.find(
      (p) => p.status === "ACTIVE" && p.scope === scope,
    );
    if (match) return match;
  }
  return null;
}

// -----------------------------------------------------------------------------
// Destruction review state machine
// -----------------------------------------------------------------------------

export const DESTRUCTION_REVIEW_STATUSES = [
  "PENDING",
  "UNDER_REVIEW",
  "APPROVED",
  "DENIED",
  "DEFERRED",
  "RESTORED",
  "EXECUTED",
  "CANCELLED",
] as const;
export const DestructionReviewStatusSchema = z.enum(
  DESTRUCTION_REVIEW_STATUSES,
);
export type DestructionReviewStatus = z.infer<
  typeof DestructionReviewStatusSchema
>;

const DESTRUCTION_REVIEW_TRANSITIONS: Readonly<
  Record<DestructionReviewStatus, ReadonlyArray<DestructionReviewStatus>>
> = {
  PENDING: ["UNDER_REVIEW", "DEFERRED", "CANCELLED"],
  UNDER_REVIEW: ["APPROVED", "DENIED", "DEFERRED", "CANCELLED"],
  APPROVED: ["EXECUTED", "CANCELLED"],
  DENIED: ["RESTORED", "CANCELLED"],
  DEFERRED: ["PENDING", "CANCELLED"],
  RESTORED: [], // terminal — evidence is back ACTIVE
  EXECUTED: [], // terminal — destruction certificate emitted
  CANCELLED: [], // terminal
};

export function isAllowedDestructionReviewTransition(
  from: DestructionReviewStatus,
  to: DestructionReviewStatus,
): boolean {
  if (from === to) return true;
  return DESTRUCTION_REVIEW_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * A REVIEW THAT IS STILL WAITING FOR A PERSON.
 *
 * Four read sites across three services asked for
 * `status in ('PROPOSED', 'PENDING_APPROVAL')`. Neither value is in
 * `DESTRUCTION_REVIEW_STATUSES` and nothing has ever written either one:
 * `createDestructionReview` writes PENDING. Because `status` is a
 * `VARCHAR(16)` and not a database enum, nothing rejected the impossible
 * value and no query ever failed — the counts were simply zero, everywhere,
 * always, and a workspace with a hundred reviews awaiting a decision was told
 * it had none.
 *
 * PENDING and UNDER_REVIEW are the two non-terminal states in which the queue
 * is waiting on a human. DEFERRED is excluded deliberately: a deferred review
 * is waiting on a DATE, and counting it as queue depth tells an operator to
 * act on something they have already decided to postpone.
 *
 * Defined HERE, next to the vocabulary it is drawn from, so a status that
 * leaves the vocabulary cannot survive in a counter — the guard asserts
 * exactly that.
 */
export const DESTRUCTION_REVIEW_AWAITING_DECISION = [
  "PENDING",
  "UNDER_REVIEW",
] as const satisfies readonly DestructionReviewStatus[];

/**
 * Newly proposed and not yet picked up.
 *
 * PENDING is what creation writes; nothing writes anything else at creation.
 * This is the narrower subset the retention surface calls "candidates".
 */
export const DESTRUCTION_REVIEW_PROPOSED = [
  "PENDING",
] as const satisfies readonly DestructionReviewStatus[];

export const DESTRUCTION_REVIEW_TERMINAL_STATUSES: ReadonlySet<DestructionReviewStatus> =
  new Set(["RESTORED", "EXECUTED", "CANCELLED"]);

export function isTerminalDestructionReviewStatus(
  status: DestructionReviewStatus,
): boolean {
  return DESTRUCTION_REVIEW_TERMINAL_STATUSES.has(status);
}

export const DESTRUCTION_REVIEW_REASONS = [
  "retention_expired",
  "manual_review",
  "policy_supersede",
] as const;
export type DestructionReviewReason =
  (typeof DESTRUCTION_REVIEW_REASONS)[number];

// -----------------------------------------------------------------------------
// Lifecycle event types — catalog the orchestrator writes.
// -----------------------------------------------------------------------------

export const LIFECYCLE_EVENT_TYPES = [
  "lifecycle_transition",
  "retention_applied",
  "retention_recomputed",
  "hold_placed",
  "hold_released",
  "destruction_review_created",
  "destruction_review_approved",
  "destruction_review_denied",
  "destruction_review_restored",
  "destruction_review_deferred",
  "destruction_executed",
  "policy_attached",
  "policy_superseded",
  "archive_requested",
  "restore_requested",
] as const;
export type LifecycleEventType = (typeof LIFECYCLE_EVENT_TYPES)[number];

// -----------------------------------------------------------------------------
// Compliance export-eligibility — operator-readable decision shape.
// -----------------------------------------------------------------------------

export const EXPORT_ELIGIBILITY_OUTCOMES = [
  "ALLOWED",
  "BLOCKED_BY_HOLD",
  "BLOCKED_BY_RETENTION",
  "BLOCKED_BY_POLICY",
  "BLOCKED_BY_LIFECYCLE",
  "BLOCKED_BY_REVIEW_GATE",
] as const;
export type ExportEligibilityOutcome =
  (typeof EXPORT_ELIGIBILITY_OUTCOMES)[number];

export type ExportEligibilityResult = {
  outcome: ExportEligibilityOutcome;
  /** Catalog-bound operator-readable reason. */
  reason: string;
  /** Phase 27 lifecycle state at the moment of the check. */
  lifecycleState: EvidenceLifecycleState | null;
};

// -----------------------------------------------------------------------------
// Bounded operator-readable labels (UI never composes free-form).
// -----------------------------------------------------------------------------

export const LIFECYCLE_STATE_LABELS: Record<EvidenceLifecycleState, string> = {
  ACTIVE: "Active",
  UNDER_REVIEW: "Under review",
  ON_HOLD: "On legal hold",
  RETENTION_LOCKED: "Retention locked",
  PENDING_DESTRUCTION: "Pending destruction",
  DESTROYED: "Destroyed",
  ARCHIVED: "Archived",
};

export const DESTRUCTION_REVIEW_LABELS: Record<DestructionReviewStatus, string> =
  {
    PENDING: "Pending",
    UNDER_REVIEW: "Under review",
    APPROVED: "Approved",
    DENIED: "Denied",
    DEFERRED: "Deferred",
    RESTORED: "Restored",
    EXECUTED: "Executed",
    CANCELLED: "Cancelled",
  };
