/**
 * PROOVRA Phase 2A — Reviewer Workspace shared contracts.
 *
 * Single source of truth for the bounded vocabulary the Reviewer
 * Workspace shares across the API, web, and worker:
 *
 *   * Reviewer role catalog
 *   * Coding field types
 *   * Reviewer verdicts (+ risk / escalation levels)
 *   * QC sample states + verdicts
 *   * Disagreement state machine
 *   * Hotkey codes
 *   * Workspace section ids
 *
 * Hard rules:
 *   1. Append-only enums (renaming a value is a breaking change).
 *   2. Free-form reason strings are bounded ≤ 240 chars at use sites.
 *   3. NEVER asserts authenticity / admissibility of evidence content.
 *      The reviewer workspace records DECISIONS, not truth.
 */

// =============================================================================
// 1. Reviewer roles
// =============================================================================

/**
 * Bounded reviewer role catalog. Each role layered on top of the
 * existing PROOVRA RBAC role (OWNER / ADMIN / MEMBER / VIEWER). The
 * reviewer role describes the *function* a member performs within a
 * review queue; it does not replace the workspace role.
 *
 *   REVIEWER          — performs first-pass review
 *   SENIOR_REVIEWER   — first-pass + adjudication on disagreements
 *   QC_REVIEWER       — performs QC sampling verdicts
 *   SUPERVISOR        — reassigns, balances load, signs off batches
 *   REVIEW_ADMIN      — authors schemas, configures queues + sampling
 */
export const REVIEWER_ROLES = [
  "REVIEWER",
  "SENIOR_REVIEWER",
  "QC_REVIEWER",
  "SUPERVISOR",
  "REVIEW_ADMIN",
] as const;
export type ReviewerRole = (typeof REVIEWER_ROLES)[number];

/**
 * Role → bounded capability set. Drives the in-app permission filter
 * + the server-side gate. The matrix is intentionally small:
 *
 *   review.code              — write coding values on assigned work
 *   review.decide            — record approve/reject/escalate/needs-info
 *   review.annotate          — add annotations
 *   review.escalate          — raise an escalation
 *   review.disagree          — file a disagreement vs. another reviewer's decision
 *   review.adjudicate        — resolve a disagreement
 *   review.qc.verdict        — record QC pass/fail
 *   review.assign            — assign work to a reviewer
 *   review.reassign          — move work between reviewers
 *   review.bulk              — bulk operations (assign/decide)
 *   review.schema.author     — create / edit coding schemas
 *   review.sampling.policy   — configure QC sampling rules
 */
export const REVIEWER_CAPABILITIES = [
  "review.code",
  "review.decide",
  "review.annotate",
  "review.escalate",
  "review.disagree",
  "review.adjudicate",
  "review.qc.verdict",
  "review.assign",
  "review.reassign",
  "review.bulk",
  "review.schema.author",
  "review.sampling.policy",
] as const;
export type ReviewerCapability = (typeof REVIEWER_CAPABILITIES)[number];

export const REVIEWER_ROLE_CAPABILITIES: Readonly<
  Record<ReviewerRole, ReadonlyArray<ReviewerCapability>>
> = {
  REVIEWER: [
    "review.code",
    "review.decide",
    "review.annotate",
    "review.escalate",
    "review.disagree",
  ],
  SENIOR_REVIEWER: [
    "review.code",
    "review.decide",
    "review.annotate",
    "review.escalate",
    "review.disagree",
    "review.adjudicate",
  ],
  QC_REVIEWER: [
    "review.qc.verdict",
    "review.annotate",
  ],
  SUPERVISOR: [
    "review.code",
    "review.decide",
    "review.annotate",
    "review.escalate",
    "review.disagree",
    "review.adjudicate",
    "review.qc.verdict",
    "review.assign",
    "review.reassign",
    "review.bulk",
  ],
  REVIEW_ADMIN: [
    "review.code",
    "review.decide",
    "review.annotate",
    "review.escalate",
    "review.disagree",
    "review.adjudicate",
    "review.qc.verdict",
    "review.assign",
    "review.reassign",
    "review.bulk",
    "review.schema.author",
    "review.sampling.policy",
  ],
};

export function reviewerCapabilitiesForRole(
  role: ReviewerRole,
): ReadonlySet<ReviewerCapability> {
  return new Set(REVIEWER_ROLE_CAPABILITIES[role]);
}

// =============================================================================
// 2. Coding field types
// =============================================================================

export const CODING_FIELD_TYPES = [
  "TEXT",
  "NUMERIC",
  "SINGLE_SELECT",
  "MULTI_SELECT",
  "BOOLEAN",
  "CONFIDENCE_SCORE",
  "REVIEWER_VERDICT",
  "RISK_LEVEL",
  "ESCALATION_LEVEL",
] as const;
export type CodingFieldType = (typeof CODING_FIELD_TYPES)[number];

/** Confidence score domain (0–100). */
export const CONFIDENCE_SCORE_RANGE = { min: 0, max: 100 } as const;

/** Bounded reviewer verdict — final per-evidence decision. */
export const REVIEWER_VERDICTS = [
  "PENDING",
  "APPROVE",
  "REJECT",
  "ESCALATE",
  "NEEDS_INFO",
] as const;
export type ReviewerVerdict = (typeof REVIEWER_VERDICTS)[number];

/** Risk levels. Ordered low → critical. */
export const REVIEWER_RISK_LEVELS = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
export type ReviewerRiskLevel = (typeof REVIEWER_RISK_LEVELS)[number];

/** Escalation levels. 0 = no escalation. */
export const ESCALATION_LEVELS = [0, 1, 2, 3] as const;
export type EscalationLevel = (typeof ESCALATION_LEVELS)[number];

// =============================================================================
// 3. Disagreement state machine
// =============================================================================

export const DISAGREEMENT_STATES = [
  "FILED",
  "UNDER_SECOND_REVIEW",
  "UNDER_SUPERVISOR_REVIEW",
  "RESOLVED_UPHELD",
  "RESOLVED_OVERTURNED",
  "RESOLVED_PARTIAL",
  "WITHDRAWN",
] as const;
export type DisagreementState = (typeof DISAGREEMENT_STATES)[number];

export const DISAGREEMENT_TRANSITIONS: Readonly<
  Record<DisagreementState, ReadonlyArray<DisagreementState>>
> = {
  FILED: ["UNDER_SECOND_REVIEW", "WITHDRAWN"],
  UNDER_SECOND_REVIEW: [
    "UNDER_SUPERVISOR_REVIEW",
    "RESOLVED_UPHELD",
    "RESOLVED_OVERTURNED",
    "RESOLVED_PARTIAL",
    "WITHDRAWN",
  ],
  UNDER_SUPERVISOR_REVIEW: [
    "RESOLVED_UPHELD",
    "RESOLVED_OVERTURNED",
    "RESOLVED_PARTIAL",
  ],
  RESOLVED_UPHELD: [],
  RESOLVED_OVERTURNED: [],
  RESOLVED_PARTIAL: [],
  WITHDRAWN: [],
};

export function isAllowedDisagreementTransition(
  from: DisagreementState,
  to: DisagreementState,
): boolean {
  const allowed = DISAGREEMENT_TRANSITIONS[from] ?? [];
  return (allowed as ReadonlyArray<DisagreementState>).includes(to);
}

// =============================================================================
// 4. QC sample state + verdicts
// =============================================================================

export const QC_SAMPLE_STATES = [
  "SAMPLED",
  "ASSIGNED",
  "IN_PROGRESS",
  "VERDICT_RENDERED",
  "EXPIRED",
] as const;
export type QcSampleState = (typeof QC_SAMPLE_STATES)[number];

export const QC_VERDICTS = ["PASS", "FAIL", "PARTIAL"] as const;
export type QcVerdict = (typeof QC_VERDICTS)[number];

export const QC_FAILURE_REASONS = [
  "INCORRECT_CODING",
  "MISSING_REQUIRED_FIELDS",
  "WRONG_DECISION",
  "MISSED_ESCALATION",
  "INSUFFICIENT_ANNOTATION",
  "POLICY_VIOLATION",
  "OTHER",
] as const;
export type QcFailureReason = (typeof QC_FAILURE_REASONS)[number];

// =============================================================================
// 5. Hotkey catalog
// =============================================================================

export const REVIEWER_HOTKEY_CODES = [
  "NEXT_ITEM",
  "PREVIOUS_ITEM",
  "APPROVE",
  "REJECT",
  "FLAG",
  "ESCALATE",
  "REQUEST_INFO",
  "ASSIGN",
  "SAVE",
  "HELP",
  "TOGGLE_ANNOTATIONS",
  "FOCUS_CODING_PANEL",
  "FOCUS_VIEWER",
] as const;
export type ReviewerHotkeyCode = (typeof REVIEWER_HOTKEY_CODES)[number];

/** Default key bindings (US keyboard, modifier-light). */
export const REVIEWER_DEFAULT_HOTKEYS: Readonly<
  Record<ReviewerHotkeyCode, string>
> = {
  NEXT_ITEM: "j",
  PREVIOUS_ITEM: "k",
  APPROVE: "a",
  REJECT: "r",
  FLAG: "f",
  ESCALATE: "e",
  REQUEST_INFO: "i",
  ASSIGN: "g",
  SAVE: "Mod+s",
  HELP: "?",
  TOGGLE_ANNOTATIONS: "n",
  FOCUS_CODING_PANEL: "c",
  FOCUS_VIEWER: "v",
};

// =============================================================================
// 6. Workspace sections
// =============================================================================

export const REVIEWER_WORKSPACE_SECTIONS = [
  "ASSIGNED_WORK",
  "ACTIVE_REVIEW",
  "REVIEW_QUEUE",
  "ESCALATIONS",
  "QUALITY_CONTROL",
  "DISAGREEMENTS",
  "METRICS",
] as const;
export type ReviewerWorkspaceSection =
  (typeof REVIEWER_WORKSPACE_SECTIONS)[number];

// =============================================================================
// 7. Coding schema categories (semantic vertical templates)
// =============================================================================

export const CODING_SCHEMA_CATEGORIES = [
  "GENERAL_EVIDENCE",
  "INSURANCE_REVIEW",
  "LEGAL_MATTER",
  "INCIDENT_INVESTIGATION",
  "COMPLIANCE_AUDIT",
  "JOURNALISM_REVIEW",
] as const;
export type CodingSchemaCategory = (typeof CODING_SCHEMA_CATEGORIES)[number];

// =============================================================================
// 8. Bounded denial reasons (review-side mutations)
// =============================================================================

export const REVIEWER_DENIAL_REASONS = [
  "WORKSPACE_NOT_FOUND",
  "WORKFLOW_NOT_FOUND",
  "NOT_ASSIGNED",
  "NOT_PERMITTED",
  "WORKFLOW_CLOSED",
  "SCHEMA_NOT_FOUND",
  "SCHEMA_VERSION_MISMATCH",
  "FIELD_NOT_FOUND",
  "FIELD_VALIDATION_FAILED",
  "VERDICT_REQUIRED",
  "RATIONALE_REQUIRED",
  "DISAGREEMENT_NOT_FOUND",
  "DISAGREEMENT_STATE_INVALID",
  "DISAGREEMENT_SELF_FILE",
  "QC_SAMPLE_NOT_FOUND",
  "QC_VERDICT_INVALID",
  "RATE_LIMITED",
  "POLICY_REJECTED",
] as const;
export type ReviewerDenialReason = (typeof REVIEWER_DENIAL_REASONS)[number];

// =============================================================================
// 9. Workspace aggregate shape (single read for the workspace landing)
// =============================================================================

export const REVIEWER_WORKSPACE_SCHEMA_VERSION =
  "PROOVRA_REVIEWER_WORKSPACE_V1" as const;

export type ReviewerWorkspaceProjection = {
  schemaVersion: typeof REVIEWER_WORKSPACE_SCHEMA_VERSION;
  generatedAtUtc: string;
  /** Bounded reviewer role for the caller. */
  role: ReviewerRole;
  /** Bounded list of capabilities the caller has. */
  capabilities: ReadonlyArray<ReviewerCapability>;
  /** Queue counts by bounded state. */
  queues: Readonly<Record<
    | "assigned"
    | "unassigned"
    | "in_progress"
    | "escalated"
    | "qc"
    | "completed",
    number
  >>;
  /** Disagreement counts for the caller. */
  disagreements: {
    asChallenger: number;
    awaitingAdjudication: number;
    resolvedThisWeek: number;
  };
  /** QC sampling counts visible to the caller. */
  qc: {
    pendingSamples: number;
    rendered7d: number;
    failureRate7dPct: number;
  };
  /** Bounded metric ribbon. */
  metrics: {
    throughput7d: number;
    approvalRate7dPct: number;
    escalationRate7dPct: number;
    avgReviewDurationMs7d: number;
  };
  /** Active review pointer (null when none). */
  activeReview: {
    workflowId: string;
    evidenceId: string;
    codingSchemaId: string | null;
    codingSchemaVersion: number | null;
  } | null;
};
