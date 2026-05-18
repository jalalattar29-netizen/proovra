/**
 * Pure workflow resolver helpers.
 *
 * Phase 3 contract: these helpers run client-side (web and mobile) to map
 * server responses into the typed Phase 1 shapes and to derive a
 * `WorkflowContext` from the data the capture page already has on hand. They
 * are intentionally pure — no DOM, no fetch, no React, no time-of-day
 * dependence — so callers can use them anywhere and tests can pin behavior.
 *
 * Failure mode rule: every function in this module degrades to "null" or a
 * non-throwing "warnings" array rather than throwing. The capture page must
 * not crash on a malformed server payload.
 *
 * What this module does NOT do:
 *   - It does NOT evaluate rules. Rule actions (requireStep / hideStep /
 *     requireField / requireIdentityTier) are validated and preserved, but
 *     no actions are applied. The rule engine is a later phase.
 *   - It does NOT touch DB, network, or browser globals.
 */

import {
  WorkflowIntakeMode,
  WorkflowIntakeModeSchema,
  WorkflowPlanMode,
  WorkflowPlanModeSchema,
  WorkflowRule,
  WorkflowRuleSchema,
  WorkflowStep,
  WorkflowStepSchema,
  WorkflowTemplate,
  WorkflowTemplateSchema,
  WorkflowWorkspaceCategory,
  WorkflowWorkspaceCategorySchema,
  WorkflowWorkspaceRole,
  WorkflowIdentityTier,
} from "./workflow-types.js";
import type { WorkflowContext } from "./workflow-types.js";

// -----------------------------------------------------------------------------
// safeParseWorkflowTemplate
//
// Tolerant parser for the shape returned by /v1/workflow/templates. The route
// projects extra fields (dbId, source) that are not part of the canonical
// WorkflowTemplate; we ignore them. We also coerce `null` to `undefined` for
// optional fields so the Phase 1 zod schemas accept them (zod treats null and
// undefined as distinct).
// -----------------------------------------------------------------------------

function nullToUndefined<T>(value: T | null | undefined): T | undefined {
  return value === null ? undefined : value;
}

export function safeParseWorkflowTemplate(input: unknown): WorkflowTemplate | null {
  if (!input || typeof input !== "object") return null;
  if (Array.isArray(input)) return null;

  const raw = input as Record<string, unknown>;

  const rawRules = nullToUndefined(raw.rules as WorkflowRule[] | null | undefined);

  const candidate = {
    id: raw.id,
    slug: raw.slug,
    version: raw.version,
    name: raw.name,
    description: raw.description ?? "",
    workspaceCategory: nullToUndefined(
      raw.workspaceCategory as WorkflowWorkspaceCategory | null | undefined,
    ),
    locationRequirement: raw.locationRequirement,
    planMode: raw.planMode,
    intakeModes: raw.intakeModes,
    allowedRoles: nullToUndefined(
      raw.allowedRoles as WorkflowWorkspaceRole[] | null | undefined,
    ),
    archived: raw.archived ?? false,
    steps: raw.steps,
    rules: rawRules,
  };

  const strict = WorkflowTemplateSchema.safeParse(candidate);
  if (strict.success) return strict.data;

  // Phase 3 degradation: if the only failure is in `rules`, strip them and
  // retry. A template with malformed rules remains usable with its rule list
  // sanitized to the empty array; capture does not yet evaluate rules anyway.
  // Telemetry can call sanitizeWorkflowRules() separately on the original
  // payload to learn what was dropped.
  if (rawRules !== undefined && rawRules !== null) {
    const candidateWithoutRules = { ...candidate, rules: undefined };
    const retried = WorkflowTemplateSchema.safeParse(candidateWithoutRules);
    if (retried.success) return retried.data;
  }

  return null;
}

export type SafeParseWorkflowTemplateListResult = {
  templates: WorkflowTemplate[];
  invalidCount: number;
  invalidSlugs: Array<string | null>;
};

/**
 * Parse a server-returned list defensively. Invalid entries are dropped, not
 * thrown. Callers can log `invalidCount` for telemetry without losing the
 * good rows.
 */
export function safeParseWorkflowTemplateList(
  list: unknown,
): SafeParseWorkflowTemplateListResult {
  if (!Array.isArray(list)) {
    return { templates: [], invalidCount: 0, invalidSlugs: [] };
  }

  const templates: WorkflowTemplate[] = [];
  const invalidSlugs: Array<string | null> = [];

  for (const item of list) {
    const parsed = safeParseWorkflowTemplate(item);
    if (parsed) {
      templates.push(parsed);
    } else {
      const slug =
        item && typeof item === "object" && typeof (item as Record<string, unknown>).slug === "string"
          ? ((item as Record<string, unknown>).slug as string)
          : null;
      invalidSlugs.push(slug);
    }
  }

  return {
    templates,
    invalidCount: invalidSlugs.length,
    invalidSlugs,
  };
}

// -----------------------------------------------------------------------------
// sanitizeWorkflowRules
//
// Filter out rules that don't validate. Returns a clean rule list plus a
// warnings array so callers can log dropped rules without crashing capture.
// -----------------------------------------------------------------------------

export type WorkflowRuleSanitizationWarning = {
  ruleId: string | null;
  reason: "schema_validation_failed";
};

export function sanitizeWorkflowRules(
  rules: unknown,
): {
  rules: WorkflowRule[];
  warnings: WorkflowRuleSanitizationWarning[];
} {
  if (!Array.isArray(rules)) return { rules: [], warnings: [] };

  const kept: WorkflowRule[] = [];
  const warnings: WorkflowRuleSanitizationWarning[] = [];

  for (const rule of rules) {
    const result = WorkflowRuleSchema.safeParse(rule);
    if (result.success) {
      kept.push(result.data);
    } else {
      const id =
        rule && typeof rule === "object" && typeof (rule as Record<string, unknown>).id === "string"
          ? ((rule as Record<string, unknown>).id as string)
          : null;
      warnings.push({ ruleId: id, reason: "schema_validation_failed" });
    }
  }

  return { rules: kept, warnings };
}

// -----------------------------------------------------------------------------
// sanitizeWorkflowSteps
//
// Same shape as sanitizeWorkflowRules but for steps. Used when the consumer
// got a partially-valid template and wants to salvage the well-formed steps.
// In Phase 3 this is conservative: if any step fails validation, the whole
// template should be rejected by safeParseWorkflowTemplate. Exported for use
// in tests and future renderers that may want per-step diagnostics.
// -----------------------------------------------------------------------------

export type WorkflowStepSanitizationWarning = {
  stepId: string | null;
  reason: "schema_validation_failed";
};

export function sanitizeWorkflowSteps(
  steps: unknown,
): {
  steps: WorkflowStep[];
  warnings: WorkflowStepSanitizationWarning[];
} {
  if (!Array.isArray(steps)) return { steps: [], warnings: [] };

  const kept: WorkflowStep[] = [];
  const warnings: WorkflowStepSanitizationWarning[] = [];

  for (const step of steps) {
    const result = WorkflowStepSchema.safeParse(step);
    if (result.success) {
      kept.push(result.data);
    } else {
      const id =
        step && typeof step === "object" && typeof (step as Record<string, unknown>).id === "string"
          ? ((step as Record<string, unknown>).id as string)
          : null;
      warnings.push({ stepId: id, reason: "schema_validation_failed" });
    }
  }

  return { steps: kept, warnings };
}

// -----------------------------------------------------------------------------
// resolveWorkflowContext
//
// Build a WorkflowContext from a selected template plus runtime inputs.
// Returns null if any *required* input is missing so the caller can degrade
// safely (e.g., legacy capture path).
//
// In Phase 3 the only consumer is the capture page. The WorkflowContext it
// produces is currently passive — capture still drives off the lifted
// CollectionPlanTemplate. The context exists so later phases can route policy
// decisions through it without changing this signature.
// -----------------------------------------------------------------------------

export type ResolveWorkflowContextInput = {
  template: WorkflowTemplate | null | undefined;
  workspaceId: string | null | undefined;
  workspaceCategory?: WorkflowWorkspaceCategory | null;
  intakeMode?: WorkflowIntakeMode | null;
  planMode?: WorkflowPlanMode | null;
  submitterRole?: WorkflowWorkspaceRole | null;
  submitterIdentityTier?: WorkflowIdentityTier | null;
  intakeLinkId?: string | null;
};

export type ResolveWorkflowContextResult = {
  context: WorkflowContext | null;
  reason:
    | "ok"
    | "missing_template"
    | "missing_workspace_id"
    | "missing_intake_mode"
    | "missing_identity_tier"
    | "template_intake_mode_mismatch"
    | "validation_failed";
};

const DEFAULT_INTAKE_MODE: WorkflowIntakeMode = "AUTHENTICATED_STANDARD";
const DEFAULT_IDENTITY_TIER: WorkflowIdentityTier = "BASIC_ACCOUNT";

export function resolveWorkflowContext(
  input: ResolveWorkflowContextInput,
): ResolveWorkflowContextResult {
  if (!input.template) {
    return { context: null, reason: "missing_template" };
  }
  if (!input.workspaceId) {
    return { context: null, reason: "missing_workspace_id" };
  }

  // Pick the effective intake mode. If the caller passes one, validate it
  // against the template's whitelist. Otherwise pick the first whitelisted
  // mode the template allows, falling back to the safe default.
  let intakeMode: WorkflowIntakeMode;
  if (input.intakeMode) {
    const intakeParsed = WorkflowIntakeModeSchema.safeParse(input.intakeMode);
    if (!intakeParsed.success) {
      return { context: null, reason: "missing_intake_mode" };
    }
    if (!input.template.intakeModes.includes(intakeParsed.data)) {
      return { context: null, reason: "template_intake_mode_mismatch" };
    }
    intakeMode = intakeParsed.data;
  } else {
    intakeMode = input.template.intakeModes[0] ?? DEFAULT_INTAKE_MODE;
  }

  // Plan mode defaults to the template's planMode if not explicitly chosen.
  let planMode: WorkflowPlanMode;
  if (input.planMode) {
    const planParsed = WorkflowPlanModeSchema.safeParse(input.planMode);
    if (!planParsed.success) {
      return { context: null, reason: "validation_failed" };
    }
    planMode = planParsed.data;
  } else {
    planMode = input.template.planMode;
  }

  const workspaceCategory =
    nullToUndefined(input.workspaceCategory) ??
    input.template.workspaceCategory ??
    "GENERAL";
  const categoryParsed = WorkflowWorkspaceCategorySchema.safeParse(workspaceCategory);
  if (!categoryParsed.success) {
    return { context: null, reason: "validation_failed" };
  }

  const submitterIdentityTier =
    nullToUndefined(input.submitterIdentityTier) ?? DEFAULT_IDENTITY_TIER;

  const context: WorkflowContext = {
    workspaceId: input.workspaceId,
    workspaceCategory: categoryParsed.data,
    template: input.template,
    intakeMode,
    planMode,
    submitterRole: nullToUndefined(input.submitterRole) ?? null,
    submitterIdentityTier,
    ...(input.intakeLinkId ? { intakeLinkId: input.intakeLinkId } : {}),
  };

  return { context, reason: "ok" };
}

// -----------------------------------------------------------------------------
// templateMatchesIntakeMode
//
// Convenience predicate. The capture page uses this to filter the merged
// template list down to ones that support the current intake mode.
// -----------------------------------------------------------------------------

export function templateMatchesIntakeMode(
  template: WorkflowTemplate,
  intakeMode: WorkflowIntakeMode,
): boolean {
  return template.intakeModes.includes(intakeMode);
}
