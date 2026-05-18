/**
 * Phase 22 — Evidence Workflow Instance canonical types.
 *
 * The Phase 1-4 workflow surface (templates, intake links, intake
 * sessions, visibility resolver) is already in place. Phase 22 adds
 * the RUNTIME layer on top:
 *
 *   - `WorkflowInstanceStatus` — the lifecycle state machine for a
 *     concrete running workflow attached to an evidence submission.
 *   - `WorkflowStepInstanceStatus` — per-step status within an
 *     instance.
 *   - `WorkflowActorRole` — the role of the actor relative to THIS
 *     instance (not the workspace role, which is captured by
 *     WORKFLOW_WORKSPACE_ROLES in workflow-types.ts).
 *   - Transition allow-lists + helpers.
 *
 * Hard invariants encoded here:
 *   - State transitions are explicit + deterministic. Adding one is
 *     a code change; runtime cannot invent transitions.
 *   - LEGAL_HOLD is reachable from any non-terminal state but
 *     blocks ARCHIVED until governance releases the hold.
 *   - APPROVED → REPORT_READY → PACKAGE_READY → SHARED_EXTERNALLY is
 *     a strict export ladder; intermediate jumps are blocked.
 *   - Service accounts are restricted to the API_INGESTION intake
 *     mode + a minimal subset of actor roles.
 *   - Anonymous source identity NEVER appears in any actor-role
 *     enum value (the actor is `ANONYMOUS_SOURCE` — the identity
 *     itself is never surfaced).
 */

import { z } from "zod";

// -----------------------------------------------------------------------------
// Workflow template status (NEW — extends the existing `archived` boolean)
// -----------------------------------------------------------------------------

export const WORKFLOW_TEMPLATE_STATUSES = [
  "DRAFT",
  "ACTIVE",
  "ARCHIVED",
] as const;
export const WorkflowTemplateStatusSchema = z.enum(WORKFLOW_TEMPLATE_STATUSES);
export type WorkflowTemplateStatus = z.infer<typeof WorkflowTemplateStatusSchema>;

// -----------------------------------------------------------------------------
// Workflow instance status (the runtime state machine)
// -----------------------------------------------------------------------------

export const WORKFLOW_INSTANCE_STATUSES = [
  "DRAFT",
  "ACTIVE",
  "SUBMITTED",
  "NEEDS_REVIEW",
  "APPROVED",
  "REPORT_READY",
  "PACKAGE_READY",
  "SHARED_EXTERNALLY",
  "ARCHIVED",
  "RETAINED",
  "LEGAL_HOLD",
  "CANCELLED",
  "CHANGES_REQUESTED",
] as const;
export const WorkflowInstanceStatusSchema = z.enum(WORKFLOW_INSTANCE_STATUSES);
export type WorkflowInstanceStatus = z.infer<typeof WorkflowInstanceStatusSchema>;

const WORKFLOW_INSTANCE_TERMINAL: ReadonlyArray<WorkflowInstanceStatus> = [
  "ARCHIVED",
  "RETAINED",
  "CANCELLED",
];

export function isTerminalWorkflowInstanceStatus(
  s: WorkflowInstanceStatus,
): boolean {
  return WORKFLOW_INSTANCE_TERMINAL.includes(s);
}

/**
 * Explicit transition allow-list. Adding one is a code change. The
 * service layer + tests both consult this map; routes never invent
 * a transition by passing an arbitrary `to` value.
 *
 * LEGAL_HOLD is reachable from every non-terminal state — operators
 * may set a hold at any time. Releasing the hold returns to the
 * pre-hold state (handled by the service layer; the allow-list here
 * only validates the direct edge).
 */
const WORKFLOW_INSTANCE_TRANSITIONS: Readonly<
  Record<WorkflowInstanceStatus, ReadonlyArray<WorkflowInstanceStatus>>
> = {
  DRAFT: ["ACTIVE", "CANCELLED", "LEGAL_HOLD"],
  ACTIVE: ["SUBMITTED", "CANCELLED", "LEGAL_HOLD"],
  SUBMITTED: ["NEEDS_REVIEW", "CHANGES_REQUESTED", "CANCELLED", "LEGAL_HOLD"],
  NEEDS_REVIEW: [
    "APPROVED",
    "CHANGES_REQUESTED",
    "CANCELLED",
    "LEGAL_HOLD",
  ],
  CHANGES_REQUESTED: ["ACTIVE", "SUBMITTED", "CANCELLED", "LEGAL_HOLD"],
  APPROVED: ["REPORT_READY", "ARCHIVED", "RETAINED", "LEGAL_HOLD"],
  REPORT_READY: ["PACKAGE_READY", "ARCHIVED", "RETAINED", "LEGAL_HOLD"],
  PACKAGE_READY: [
    "SHARED_EXTERNALLY",
    "ARCHIVED",
    "RETAINED",
    "LEGAL_HOLD",
  ],
  SHARED_EXTERNALLY: ["ARCHIVED", "RETAINED", "LEGAL_HOLD"],
  LEGAL_HOLD: [
    // Release returns to the operator-selected prior state. We allow
    // any non-terminal state here; the service layer enforces that the
    // selected state was the one set before the hold.
    "ACTIVE",
    "SUBMITTED",
    "NEEDS_REVIEW",
    "APPROVED",
    "REPORT_READY",
    "PACKAGE_READY",
    "SHARED_EXTERNALLY",
  ],
  ARCHIVED: [],
  RETAINED: ["ARCHIVED"],
  CANCELLED: [],
};

export function isAllowedWorkflowInstanceTransition(
  from: WorkflowInstanceStatus,
  to: WorkflowInstanceStatus,
): boolean {
  if (from === to) return false;
  return WORKFLOW_INSTANCE_TRANSITIONS[from].includes(to);
}

export function listAllowedWorkflowInstanceTransitions(
  from: WorkflowInstanceStatus,
): ReadonlyArray<WorkflowInstanceStatus> {
  return WORKFLOW_INSTANCE_TRANSITIONS[from];
}

// -----------------------------------------------------------------------------
// Workflow step status
// -----------------------------------------------------------------------------

export const WORKFLOW_STEP_INSTANCE_STATUSES = [
  "NOT_STARTED",
  "IN_PROGRESS",
  "SATISFIED",
  "NEEDS_ATTENTION",
  "WAIVED",
  "FAILED",
] as const;
export const WorkflowStepInstanceStatusSchema = z.enum(
  WORKFLOW_STEP_INSTANCE_STATUSES,
);
export type WorkflowStepInstanceStatus = z.infer<
  typeof WorkflowStepInstanceStatusSchema
>;

const WORKFLOW_STEP_TERMINAL: ReadonlyArray<WorkflowStepInstanceStatus> = [
  "SATISFIED",
  "WAIVED",
  "FAILED",
];

export function isTerminalWorkflowStepStatus(
  s: WorkflowStepInstanceStatus,
): boolean {
  return WORKFLOW_STEP_TERMINAL.includes(s);
}

export function isSatisfyingWorkflowStepStatus(
  s: WorkflowStepInstanceStatus,
): boolean {
  return s === "SATISFIED" || s === "WAIVED";
}

// -----------------------------------------------------------------------------
// Actor role (per-instance) — distinct from the workspace role.
//
// The workspace role (OWNER/ADMIN/MEMBER/VIEWER) is preserved in
// WORKFLOW_WORKSPACE_ROLES (workflow-types.ts). The instance actor
// role is the role of the actor RELATIVE TO this workflow.
// -----------------------------------------------------------------------------

export const WORKFLOW_ACTOR_ROLES = [
  "WORKSPACE_OWNER",
  "WORKSPACE_ADMIN",
  "OPERATOR",
  "REVIEWER",
  "EXTERNAL_CONTRIBUTOR",
  "ANONYMOUS_SOURCE",
  "SERVICE_ACCOUNT",
] as const;
export const WorkflowActorRoleSchema = z.enum(WORKFLOW_ACTOR_ROLES);
export type WorkflowActorRole = z.infer<typeof WorkflowActorRoleSchema>;

// Service accounts are restricted to API ingestion + a minimal subset
// of actor roles. The engine REFUSES any combination outside this set.
export function isServiceAccountAllowedRole(role: WorkflowActorRole): boolean {
  return role === "SERVICE_ACCOUNT";
}

export function isExternalActorRole(role: WorkflowActorRole): boolean {
  return role === "EXTERNAL_CONTRIBUTOR" || role === "ANONYMOUS_SOURCE";
}

export function isReviewerOrAboveRole(role: WorkflowActorRole): boolean {
  return (
    role === "WORKSPACE_OWNER" ||
    role === "WORKSPACE_ADMIN" ||
    role === "OPERATOR" ||
    role === "REVIEWER"
  );
}

// -----------------------------------------------------------------------------
// Sensitive actions that REQUIRE step-up (Phase 19 wiring)
// -----------------------------------------------------------------------------

export const WORKFLOW_STEP_UP_ACTIONS = [
  "TEMPLATE_ACTIVATE",
  "TEMPLATE_ARCHIVE",
  "INSTANCE_CANCEL_AFTER_SUBMIT",
  "STEP_WAIVE_REQUIRED",
  "APPROVE_HIGH_RISK",
  "OVERRIDE_EXPORT_BLOCK",
  "PUBLISH_PUBLIC_VERIFICATION",
  "CHANGE_VISIBILITY_POLICY",
  "CHANGE_EXPORT_POLICY",
] as const;
export type WorkflowStepUpAction = (typeof WORKFLOW_STEP_UP_ACTIONS)[number];

// -----------------------------------------------------------------------------
// Visibility / export targets — explicit surface enumeration
// -----------------------------------------------------------------------------

export const WORKFLOW_VISIBILITY_TARGETS = [
  "AUTHENTICATED_APP",
  "EXTERNAL_CONTRIBUTOR",
  "PUBLIC_VERIFY",
  "REPORT",
  "VERIFICATION_PACKAGE",
] as const;
export const WorkflowVisibilityTargetSchema = z.enum(
  WORKFLOW_VISIBILITY_TARGETS,
);
export type WorkflowVisibilityTarget = z.infer<
  typeof WorkflowVisibilityTargetSchema
>;

export const WORKFLOW_EXPORT_TARGETS = [
  "REPORT",
  "VERIFICATION_PACKAGE",
  "ORIGINAL_DOWNLOAD",
  "PUBLIC_VERIFY",
  "INTEGRATION_API",
] as const;
export const WorkflowExportTargetSchema = z.enum(WORKFLOW_EXPORT_TARGETS);
export type WorkflowExportTarget = z.infer<typeof WorkflowExportTargetSchema>;

// -----------------------------------------------------------------------------
// Identity requirement per step (operator-readable label for the runtime)
//
// The existing `workflow-types.ts` exposes `WORKFLOW_IDENTITY_TIERS`
// (BASIC_ACCOUNT, VERIFIED_EMAIL, OAUTH_BACKED_IDENTITY,
// ORGANIZATION_ACCOUNT, VERIFIED_ORGANIZATION). Phase 22 adds the
// per-step requirement enum used by step instances + the runtime
// engine. The mapping from this enum to the tier is one-to-many:
// VERIFIED_PHONE maps to OAUTH_BACKED_IDENTITY when wired with
// Phase 18 verify; the engine resolves it at evaluation time.
// -----------------------------------------------------------------------------

export const WORKFLOW_STEP_IDENTITY_REQUIREMENTS = [
  "NONE",
  "EMAIL",
  "PHONE",
  "VERIFIED_PHONE",
  "WORKSPACE_MEMBER",
] as const;
export const WorkflowStepIdentityRequirementSchema = z.enum(
  WORKFLOW_STEP_IDENTITY_REQUIREMENTS,
);
export type WorkflowStepIdentityRequirement = z.infer<
  typeof WorkflowStepIdentityRequirementSchema
>;

// -----------------------------------------------------------------------------
// Canonical error code surface — returned by the engine to routes.
//
// Routes map these into the standardized Phase 20 error codes
// (STEP_UP_REQUIRED, GOVERNANCE_BLOCKED, etc.) when sending the wire
// response. Keeping the enum here lets every service speak the same
// language.
// -----------------------------------------------------------------------------

export const WORKFLOW_ERROR_CODES = [
  "WORKFLOW_INVALID_TRANSITION",
  "WORKFLOW_GOVERNANCE_BLOCKED",
  "WORKFLOW_STEP_REQUIRED",
  "WORKFLOW_STEP_NOT_FOUND",
  "WORKFLOW_VISIBILITY_DENIED",
  "WORKFLOW_INSTANCE_NOT_FOUND",
  "WORKFLOW_TEMPLATE_NOT_FOUND",
  "WORKFLOW_ACTOR_NOT_PERMITTED",
  "WORKFLOW_LEGAL_HOLD_ACTIVE",
  "WORKFLOW_ALREADY_SUBMITTED",
] as const;
export type WorkflowErrorCode = (typeof WORKFLOW_ERROR_CODES)[number];
