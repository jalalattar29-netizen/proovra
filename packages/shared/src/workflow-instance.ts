/**
 * Phase 22 — Evidence Workflow Instance canonical types.
 *
 * Phase R canonicalization (post-Phase 22 audit): the runtime layer
 * is trimmed to the statuses that have a real route + UI control.
 * The original advertised ladder (APPROVED → REPORT_READY →
 * PACKAGE_READY → SHARED_EXTERNALLY) had zero producers and zero UI
 * actions — it has been removed. ARCHIVED / RETAINED / LEGAL_HOLD /
 * ACTIVE are also retired from the canonical list because no
 * producer ever called `transitionInstance(..., status)` for them
 * and no UI surface fired the corresponding action.
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

// Phase R canonicalization — the runtime statuses kept in the
// allow-list are ONLY the ones with a real producer route + UI
// control. REPORT_READY / PACKAGE_READY / SHARED_EXTERNALLY /
// LEGAL_HOLD / ARCHIVED / RETAINED / ACTIVE were verified to have
// zero `transitionInstance(..., status)` call sites and zero UI
// buttons that target them. They are removed from the contract so
// the type system stops advertising capabilities that do not exist.
//
// The status column in the database remains VARCHAR(32); existing
// rows that happen to hold a retired value are tolerated by the
// engine projection (they are passed through as opaque strings)
// but no new transitions can produce them.
export const WORKFLOW_INSTANCE_STATUSES = [
  "DRAFT",
  "SUBMITTED",
  "NEEDS_REVIEW",
  "CHANGES_REQUESTED",
  "APPROVED",
  "CANCELLED",
] as const;
export const WorkflowInstanceStatusSchema = z.enum(WORKFLOW_INSTANCE_STATUSES);
export type WorkflowInstanceStatus = z.infer<typeof WorkflowInstanceStatusSchema>;

const WORKFLOW_INSTANCE_TERMINAL: ReadonlyArray<WorkflowInstanceStatus> = [
  "APPROVED",
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
 * Phase R canonicalization: the allow-list only contains edges that
 * a producer route actually walks. DRAFT → SUBMITTED is the only
 * way to leave DRAFT now that ACTIVE has been retired. APPROVED is
 * terminal-by-default — the export ladder it used to feed
 * (REPORT_READY / PACKAGE_READY / SHARED_EXTERNALLY) is gone.
 */
const WORKFLOW_INSTANCE_TRANSITIONS: Readonly<
  Record<WorkflowInstanceStatus, ReadonlyArray<WorkflowInstanceStatus>>
> = {
  DRAFT: ["SUBMITTED", "CANCELLED"],
  SUBMITTED: ["NEEDS_REVIEW", "CHANGES_REQUESTED", "CANCELLED"],
  NEEDS_REVIEW: ["APPROVED", "CHANGES_REQUESTED", "CANCELLED"],
  CHANGES_REQUESTED: ["SUBMITTED", "CANCELLED"],
  APPROVED: [],
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
