/**
 * Foundation types for the PROOVRA Evidence Workflow Engine.
 *
 * Phase 1: shapes only. No runtime behavior, no I/O, no DB. Existing
 * systems remain authoritative for all current capture, report,
 * verification, and audit behavior. These types are inert until a
 * later phase wires them in.
 *
 * Naming rule: every exported identifier is prefixed Workflow* so it
 * cannot collide with existing platform types (IntakeTemplate,
 * CaptureSession, TeamRole, IdentityLevel, EvidenceType, ...).
 *
 * Snapshot rule: any value matching these schemas must be safe to
 * freeze verbatim onto Evidence.intakePlanJson / CaptureSession
 * snapshot columns at finalize time. No functions, no env-dependent
 * values, no unbounded strings.
 */

import { z } from "zod";

// -----------------------------------------------------------------------------
// Intake modes
//
// Mirrors the conceptual modes the engine must support. `EXTERNAL_*` modes
// map to existing Evidence.captureMethod = "EXTERNAL_INTAKE". Internal modes
// map to Evidence.captureMethod values already in use.
// -----------------------------------------------------------------------------

export const WORKFLOW_INTAKE_MODES = [
  "AUTHENTICATED_STANDARD",
  "AUTHENTICATED_GUIDED",
  "EXTERNAL_ONE_TIME",
  "EXTERNAL_REUSABLE",
  "EXTERNAL_ANONYMOUS",
  "EXTERNAL_PSEUDONYMOUS",
  "FIELD_TEAM",
  "REVIEWER_REQUEST",
] as const;

export const WorkflowIntakeModeSchema = z.enum(WORKFLOW_INTAKE_MODES);
export type WorkflowIntakeMode = z.infer<typeof WorkflowIntakeModeSchema>;

export function isExternalWorkflowIntakeMode(
  mode: WorkflowIntakeMode | null | undefined,
): boolean {
  return (
    mode === "EXTERNAL_ONE_TIME" ||
    mode === "EXTERNAL_REUSABLE" ||
    mode === "EXTERNAL_ANONYMOUS" ||
    mode === "EXTERNAL_PSEUDONYMOUS"
  );
}

export function isAnonymousWorkflowIntakeMode(
  mode: WorkflowIntakeMode | null | undefined,
): boolean {
  return mode === "EXTERNAL_ANONYMOUS" || mode === "EXTERNAL_PSEUDONYMOUS";
}

// -----------------------------------------------------------------------------
// Workspace categories
//
// A future Team.workspaceCategory column will hold one of these. Until that
// migration lands the platform behaves as if every workspace is GENERAL.
// -----------------------------------------------------------------------------

export const WORKFLOW_WORKSPACE_CATEGORIES = [
  "GENERAL",
  "INSURANCE",
  "LEGAL",
  "JOURNALISM",
  "INVESTIGATIONS",
  "COMPLIANCE",
  "FIELD_OPERATIONS",
  "RESEARCH",
  "OTHER",
] as const;

export const WorkflowWorkspaceCategorySchema = z.enum(WORKFLOW_WORKSPACE_CATEGORIES);
export type WorkflowWorkspaceCategory = z.infer<typeof WorkflowWorkspaceCategorySchema>;

// -----------------------------------------------------------------------------
// Workspace roles
//
// Mirror of existing TeamRole. Kept independent so this package has no
// Prisma dependency and remains importable from the browser bundle.
// -----------------------------------------------------------------------------

export const WORKFLOW_WORKSPACE_ROLES = [
  "OWNER",
  "ADMIN",
  "MEMBER",
  "VIEWER",
] as const;

export const WorkflowWorkspaceRoleSchema = z.enum(WORKFLOW_WORKSPACE_ROLES);
export type WorkflowWorkspaceRole = z.infer<typeof WorkflowWorkspaceRoleSchema>;

// -----------------------------------------------------------------------------
// Identity tier
//
// Mirror of existing IdentityLevel enum used by evidence.service.ts. Ordered
// least-privileged to most-privileged.
// -----------------------------------------------------------------------------

export const WORKFLOW_IDENTITY_TIERS = [
  "BASIC_ACCOUNT",
  "VERIFIED_EMAIL",
  "OAUTH_BACKED_IDENTITY",
  "ORGANIZATION_ACCOUNT",
  "VERIFIED_ORGANIZATION",
] as const;

export const WorkflowIdentityTierSchema = z.enum(WORKFLOW_IDENTITY_TIERS);
export type WorkflowIdentityTier = z.infer<typeof WorkflowIdentityTierSchema>;

const IDENTITY_TIER_RANK: Readonly<Record<WorkflowIdentityTier, number>> = {
  BASIC_ACCOUNT: 0,
  VERIFIED_EMAIL: 1,
  OAUTH_BACKED_IDENTITY: 2,
  ORGANIZATION_ACCOUNT: 3,
  VERIFIED_ORGANIZATION: 4,
};

export function meetsWorkflowIdentityTier(
  actual: WorkflowIdentityTier,
  minimum: WorkflowIdentityTier,
): boolean {
  return IDENTITY_TIER_RANK[actual] >= IDENTITY_TIER_RANK[minimum];
}

// -----------------------------------------------------------------------------
// Plan mode
//
// Mirror of CaptureSession.planMode. Unchanged semantics.
// -----------------------------------------------------------------------------

export const WORKFLOW_PLAN_MODES = ["FLEXIBLE", "CHECKLIST_REQUIRED"] as const;
export const WorkflowPlanModeSchema = z.enum(WORKFLOW_PLAN_MODES);
export type WorkflowPlanMode = z.infer<typeof WorkflowPlanModeSchema>;

// -----------------------------------------------------------------------------
// Location requirement
//
// Mirror of IntakeTemplate.locationRequirement.
// -----------------------------------------------------------------------------

export const WORKFLOW_LOCATION_REQUIREMENTS = [
  "required",
  "recommended",
  "optional",
] as const;
export const WorkflowLocationRequirementSchema = z.enum(WORKFLOW_LOCATION_REQUIREMENTS);
export type WorkflowLocationRequirement = z.infer<
  typeof WorkflowLocationRequirementSchema
>;

// -----------------------------------------------------------------------------
// Accepted media kinds
//
// Mirror of IntakeTemplateAcceptedKind / EvidenceType.
// -----------------------------------------------------------------------------

export const WORKFLOW_ACCEPTED_KINDS = ["PHOTO", "VIDEO", "AUDIO", "DOCUMENT"] as const;
export const WorkflowAcceptedKindSchema = z.enum(WORKFLOW_ACCEPTED_KINDS);
export type WorkflowAcceptedKind = z.infer<typeof WorkflowAcceptedKindSchema>;

// -----------------------------------------------------------------------------
// Rules
//
// Intentionally narrow at v1. A generic rule DSL is a footgun. We only support
// four named actions; anything else is rejected at template save time. New
// actions are a deliberate code change, not an emergent feature.
// -----------------------------------------------------------------------------

export const WORKFLOW_RULE_ACTIONS = [
  "requireStep",
  "hideStep",
  "requireField",
  "requireIdentityTier",
] as const;
export const WorkflowRuleActionSchema = z.enum(WORKFLOW_RULE_ACTIONS);
export type WorkflowRuleAction = z.infer<typeof WorkflowRuleActionSchema>;

export const WORKFLOW_RULE_OPS = ["eq", "ne", "in", "notIn"] as const;
export const WorkflowRuleOpSchema = z.enum(WORKFLOW_RULE_OPS);
export type WorkflowRuleOp = z.infer<typeof WorkflowRuleOpSchema>;

export const WorkflowRuleConditionValueSchema = z.union([
  z.string().max(400),
  z.number(),
  z.boolean(),
  z.array(z.string().max(400)).max(64),
  z.null(),
]);
export type WorkflowRuleConditionValue = z.infer<typeof WorkflowRuleConditionValueSchema>;

export const WorkflowRuleSchema = z.object({
  id: z.string().min(1).max(120),
  when: z.object({
    field: z.string().min(1).max(120),
    op: WorkflowRuleOpSchema,
    value: WorkflowRuleConditionValueSchema,
  }),
  then: z.object({
    action: WorkflowRuleActionSchema,
    target: z.string().min(1).max(120),
  }),
});
export type WorkflowRule = z.infer<typeof WorkflowRuleSchema>;

// -----------------------------------------------------------------------------
// Step
//
// Superset of the existing IntakeTemplateStep. Every new field is optional so
// today's seed templates remain valid against this schema.
// -----------------------------------------------------------------------------

export const WorkflowStepSchema = z.object({
  id: z.string().min(1).max(120),
  title: z.string().min(1).max(180),
  description: z.string().max(2000),
  purposeLabel: z.string().min(1).max(120),
  required: z.boolean(),
  acceptedKinds: z.array(WorkflowAcceptedKindSchema).min(1).max(4),
  minItems: z.number().int().min(0).max(100).optional(),
  maxItems: z.number().int().min(1).max(100).optional(),
  identityTierMinimum: WorkflowIdentityTierSchema.optional(),
  allowedRoles: z.array(WorkflowWorkspaceRoleSchema).max(4).optional(),
  visibleWhenRuleIds: z.array(z.string().min(1).max(120)).max(16).optional(),
  requiredWhenRuleIds: z.array(z.string().min(1).max(120)).max(16).optional(),
});
export type WorkflowStep = z.infer<typeof WorkflowStepSchema>;

// -----------------------------------------------------------------------------
// Template
//
// Persisted shape of a workflow template. The same shape is what gets frozen
// onto Evidence.intakePlanJson and CaptureSession.templateSnapshot at finalize
// time. The seed list in services/api/src/services/capture-intake-templates.ts
// remains the source of truth until a templates table exists; this schema is
// designed so the seed templates validate against it without modification.
// -----------------------------------------------------------------------------

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,118}[a-z0-9])?$/;

export const WorkflowTemplateSchema = z.object({
  id: z.string().min(1).max(120),
  slug: z
    .string()
    .min(1)
    .max(120)
    .regex(SLUG_PATTERN, { message: "slug must be kebab-case" }),
  version: z.number().int().min(1),
  name: z.string().min(1).max(180),
  description: z.string().max(2000),
  workspaceCategory: WorkflowWorkspaceCategorySchema.optional(),
  locationRequirement: WorkflowLocationRequirementSchema,
  planMode: WorkflowPlanModeSchema,
  intakeModes: z
    .array(WorkflowIntakeModeSchema)
    .min(1)
    .max(WORKFLOW_INTAKE_MODES.length),
  allowedRoles: z.array(WorkflowWorkspaceRoleSchema).max(4).optional(),
  archived: z.boolean(),
  steps: z.array(WorkflowStepSchema).min(1).max(64),
  rules: z.array(WorkflowRuleSchema).max(64).optional(),
});
export type WorkflowTemplate = z.infer<typeof WorkflowTemplateSchema>;

// -----------------------------------------------------------------------------
// Workflow context
//
// What a future engine layer resolves at runtime to drive a session. Phase 1
// only ships the shape; nothing reads it yet.
// -----------------------------------------------------------------------------

export const WorkflowContextSchema = z.object({
  workspaceId: z.string().min(1),
  workspaceCategory: WorkflowWorkspaceCategorySchema,
  template: WorkflowTemplateSchema,
  intakeMode: WorkflowIntakeModeSchema,
  planMode: WorkflowPlanModeSchema,
  submitterRole: WorkflowWorkspaceRoleSchema.nullable(),
  submitterIdentityTier: WorkflowIdentityTierSchema,
  intakeLinkId: z.string().min(1).optional(),
});
export type WorkflowContext = z.infer<typeof WorkflowContextSchema>;
