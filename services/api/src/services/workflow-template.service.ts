/**
 * Workflow template service.
 *
 * Phase 2 contract:
 *
 *   1. The in-code seed list in capture-intake-templates.ts remains the source
 *      of truth for platform templates. This service NEVER mutates it.
 *
 *   2. DB rows in `evidence_workflow_templates` extend the seed list. They are
 *      validated against the Phase 1 shared zod schemas before being merged.
 *      Invalid rows are skipped (logged at warn) so a single malformed row
 *      cannot take down listings.
 *
 *   3. Merging precedence by slug:
 *        a. workspace-scoped DB row (team_id matches the caller's workspace),
 *        b. global DB row (team_id IS NULL — platform override),
 *        c. in-code seed.
 *      First match wins. Archived rows are filtered out at the merge stage
 *      so consumers never see them by default.
 *
 *   4. Snapshot compatibility: a lifted seed template has the same logical
 *      shape as a DB-validated workflow template. When a future phase wires
 *      this into capture, snapshotting the full WorkflowTemplate JSON onto
 *      CaptureSession.templateSnapshot / Evidence.intakePlanJson is safe —
 *      the existing `snapshotIntakeTemplate()` output is a strict subset of
 *      this shape.
 *
 *   5. Nothing in this service is called by the live capture page yet. The
 *      existing /v1/capture/intake-templates endpoint continues to use the
 *      seed list directly (capture.routes.ts), unchanged.
 */

import { Prisma } from "@prisma/client";
import type { PrismaClient, EvidenceWorkflowTemplate as DbWorkflowTemplate } from "@prisma/client";
import {
  WORKFLOW_BASELINE_EXPORT_POLICY,
  WORKFLOW_BASELINE_REVIEW_POLICY,
  WORKFLOW_BASELINE_VISIBILITY_POLICY,
  WorkflowExportPolicy,
  WorkflowExportPolicySchema,
  WorkflowPlanMode,
  WorkflowReviewPolicy,
  WorkflowReviewPolicySchema,
  WorkflowRule,
  WorkflowRuleSchema,
  WorkflowStep,
  WorkflowStepSchema,
  WorkflowTemplate,
  WorkflowTemplateSchema,
  WorkflowVisibilityPolicy,
  WorkflowVisibilityPolicySchema,
  WorkflowWorkspaceCategory,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../db.js";
import {
  IntakeTemplate,
  listIntakeTemplates,
} from "./capture-intake-templates.js";

// -----------------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------------

export type WorkflowTemplateSource = "platform_seed" | "platform_db" | "workspace_db";

export type EffectiveWorkflowTemplate = {
  template: WorkflowTemplate;
  source: WorkflowTemplateSource;
  dbId: string | null;
};

export type ListEffectiveTemplatesOptions = {
  teamId?: string | null;
  workspaceCategory?: WorkflowWorkspaceCategory | null;
  includeArchived?: boolean;
};

export type WorkflowTemplatePersistInput = {
  slug: string;
  name: string;
  description?: string | null;
  workspaceCategory?: WorkflowWorkspaceCategory | null;
  planMode: WorkflowPlanMode;
  locationRequirement: WorkflowTemplate["locationRequirement"];
  intakeModes: WorkflowTemplate["intakeModes"];
  allowedRoles?: WorkflowTemplate["allowedRoles"];
  steps: WorkflowStep[];
  rules?: WorkflowRule[];
  visibilityPolicy?: WorkflowVisibilityPolicy | null;
  reviewPolicy?: WorkflowReviewPolicy | null;
  exportPolicy?: WorkflowExportPolicy | null;
};

// -----------------------------------------------------------------------------
// Default intake mode set used when lifting a legacy seed template to the
// workflow shape. The seed templates predate the IntakeMode concept; today
// every workflow that comes from the seed is reachable via authenticated
// capture, hence both authenticated modes.
// -----------------------------------------------------------------------------

const SEED_DEFAULT_INTAKE_MODES: WorkflowTemplate["intakeModes"] = [
  "AUTHENTICATED_STANDARD",
  "AUTHENTICATED_GUIDED",
];

const SEED_DEFAULT_PLAN_MODE: WorkflowPlanMode = "FLEXIBLE";

// -----------------------------------------------------------------------------
// Lift a legacy seed template into the workflow shape.
//
// Deterministic and pure. Used for:
//   - merging seed + DB in listEffectiveWorkflowTemplates.
//   - asserting seed templates remain compatible with Phase 1 schemas in
//     tests (every seed must lift successfully).
// -----------------------------------------------------------------------------

export function liftIntakeTemplateToWorkflowTemplate(
  seed: IntakeTemplate,
): WorkflowTemplate {
  const lifted: WorkflowTemplate = {
    id: seed.id,
    slug: seed.id,
    version: seed.version,
    name: seed.name,
    description: seed.description,
    locationRequirement: seed.locationRequirement,
    planMode: SEED_DEFAULT_PLAN_MODE,
    intakeModes: [...SEED_DEFAULT_INTAKE_MODES],
    archived: seed.archived,
    steps: seed.steps.map(
      (step): WorkflowStep => ({
        id: step.id,
        title: step.title,
        description: step.description,
        purposeLabel: step.purposeLabel,
        required: step.required,
        acceptedKinds: [...step.acceptedKinds],
      }),
    ),
  };

  // Validate via Phase 1 schema. A seed that fails this is a bug — surface
  // it loudly rather than silently dropping it.
  return WorkflowTemplateSchema.parse(lifted);
}

// -----------------------------------------------------------------------------
// Parse a DB row into a validated WorkflowTemplate. Returns null on validation
// failure (logged by the caller) so a single bad row cannot break a listing.
// -----------------------------------------------------------------------------

export function parseDbWorkflowTemplate(
  row: DbWorkflowTemplate,
): WorkflowTemplate | null {
  const candidate = {
    id: row.id,
    slug: row.slug,
    version: row.version,
    name: row.name,
    description: row.description ?? "",
    workspaceCategory: row.workspaceCategory ?? undefined,
    locationRequirement: row.locationRequirement,
    planMode: row.planMode,
    intakeModes: row.intakeModes,
    allowedRoles: row.allowedRoles.length > 0 ? row.allowedRoles : undefined,
    archived: row.archived,
    steps: row.stepsJson,
    rules: row.rulesJson ?? undefined,
  };

  const result = WorkflowTemplateSchema.safeParse(candidate);
  if (!result.success) {
    return null;
  }
  return result.data;
}

// -----------------------------------------------------------------------------
// In-memory merger. Pure for testability — callers fetch DB rows once and
// pass them in.
// -----------------------------------------------------------------------------

export function mergeWorkflowTemplates(params: {
  seeds: IntakeTemplate[];
  workspaceRows: DbWorkflowTemplate[];
  globalRows: DbWorkflowTemplate[];
  includeArchived?: boolean;
  workspaceCategory?: WorkflowWorkspaceCategory | null;
  onInvalidRow?: (row: DbWorkflowTemplate, reason: string) => void;
}): EffectiveWorkflowTemplate[] {
  const includeArchived = params.includeArchived === true;
  const out = new Map<string, EffectiveWorkflowTemplate>();

  const addRow = (
    row: DbWorkflowTemplate,
    source: "workspace_db" | "platform_db",
  ): void => {
    if (!includeArchived && row.archived) return;
    const parsed = parseDbWorkflowTemplate(row);
    if (!parsed) {
      params.onInvalidRow?.(row, "schema_validation_failed");
      return;
    }
    if (
      params.workspaceCategory &&
      parsed.workspaceCategory &&
      parsed.workspaceCategory !== params.workspaceCategory
    ) {
      return;
    }
    // Workspace rows win over platform rows by slug. Within the same scope,
    // first row by createdAt order wins (callers should sort).
    if (out.has(parsed.slug) && source === "platform_db") return;
    out.set(parsed.slug, {
      template: parsed,
      source,
      dbId: row.id,
    });
  };

  for (const row of params.workspaceRows) addRow(row, "workspace_db");
  for (const row of params.globalRows) addRow(row, "platform_db");

  for (const seed of params.seeds) {
    if (!includeArchived && seed.archived) continue;
    if (out.has(seed.id)) continue; // DB row already wins
    const lifted = liftIntakeTemplateToWorkflowTemplate(seed);
    out.set(seed.id, {
      template: lifted,
      source: "platform_seed",
      dbId: null,
    });
  }

  return Array.from(out.values()).sort((a, b) =>
    a.template.slug.localeCompare(b.template.slug),
  );
}

// -----------------------------------------------------------------------------
// Async listing — calls Prisma.
// -----------------------------------------------------------------------------

export async function listEffectiveWorkflowTemplates(
  opts: ListEffectiveTemplatesOptions = {},
  client: Pick<PrismaClient, "evidenceWorkflowTemplate"> = defaultPrisma,
): Promise<EffectiveWorkflowTemplate[]> {
  const teamId = opts.teamId ?? null;
  const includeArchived = opts.includeArchived === true;

  const archivedClause = includeArchived ? {} : { archived: false };

  const [workspaceRows, globalRows] = await Promise.all([
    teamId
      ? client.evidenceWorkflowTemplate.findMany({
          where: { teamId, ...archivedClause },
          orderBy: { createdAt: "asc" },
        })
      : Promise.resolve([] as DbWorkflowTemplate[]),
    client.evidenceWorkflowTemplate.findMany({
      where: { teamId: null, ...archivedClause },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  return mergeWorkflowTemplates({
    seeds: listIntakeTemplates(),
    workspaceRows,
    globalRows,
    includeArchived,
    workspaceCategory: opts.workspaceCategory ?? null,
  });
}

export async function getEffectiveWorkflowTemplateBySlug(
  slug: string,
  teamId: string | null,
  client: Pick<PrismaClient, "evidenceWorkflowTemplate"> = defaultPrisma,
): Promise<EffectiveWorkflowTemplate | null> {
  const list = await listEffectiveWorkflowTemplates({ teamId }, client);
  return list.find((entry) => entry.template.slug === slug) ?? null;
}

// -----------------------------------------------------------------------------
// Persistence helpers — used by routes only. Validates input via Phase 1
// schemas before touching the DB.
// -----------------------------------------------------------------------------

export type CreateWorkflowTemplateContext = {
  teamId: string;
  actorUserId: string;
};

export async function createWorkspaceWorkflowTemplate(
  input: WorkflowTemplatePersistInput,
  ctx: CreateWorkflowTemplateContext,
  client: Pick<PrismaClient, "evidenceWorkflowTemplate"> = defaultPrisma,
): Promise<DbWorkflowTemplate> {
  const validated = validateWorkflowTemplatePayload(input);

  return client.evidenceWorkflowTemplate.create({
    data: {
      slug: input.slug,
      teamId: ctx.teamId,
      workspaceCategory: input.workspaceCategory ?? null,
      version: 1,
      name: input.name,
      description: input.description ?? null,
      archived: false,
      planMode: input.planMode,
      locationRequirement: input.locationRequirement,
      intakeModes: input.intakeModes,
      allowedRoles: input.allowedRoles ?? [],
      stepsJson: validated.steps as unknown as Prisma.InputJsonValue,
      rulesJson:
        validated.rules && validated.rules.length > 0
          ? (validated.rules as unknown as Prisma.InputJsonValue)
          : Prisma.JsonNull,
      visibilityPolicyJson:
        input.visibilityPolicy
          ? (input.visibilityPolicy as unknown as Prisma.InputJsonValue)
          : Prisma.JsonNull,
      reviewPolicyJson:
        input.reviewPolicy
          ? (input.reviewPolicy as unknown as Prisma.InputJsonValue)
          : Prisma.JsonNull,
      exportPolicyJson:
        input.exportPolicy
          ? (input.exportPolicy as unknown as Prisma.InputJsonValue)
          : Prisma.JsonNull,
      createdByUserId: ctx.actorUserId,
      updatedByUserId: ctx.actorUserId,
    },
  });
}

export type UpdateWorkflowTemplateContext = {
  templateId: string;
  teamId: string;
  actorUserId: string;
};

export async function updateWorkspaceWorkflowTemplate(
  input: Partial<WorkflowTemplatePersistInput>,
  ctx: UpdateWorkflowTemplateContext,
  client: Pick<PrismaClient, "evidenceWorkflowTemplate"> = defaultPrisma,
): Promise<DbWorkflowTemplate | null> {
  const existing = await client.evidenceWorkflowTemplate.findFirst({
    where: { id: ctx.templateId, teamId: ctx.teamId },
  });
  if (!existing) return null;

  // Reconstruct a full template payload for re-validation. Any field omitted
  // from the patch falls back to the persisted value.
  const projected: WorkflowTemplatePersistInput = {
    slug: existing.slug,
    name: input.name ?? existing.name,
    description: input.description ?? existing.description,
    workspaceCategory: input.workspaceCategory ?? existing.workspaceCategory ?? null,
    planMode: (input.planMode ?? existing.planMode) as WorkflowPlanMode,
    locationRequirement: (input.locationRequirement ??
      existing.locationRequirement) as WorkflowTemplate["locationRequirement"],
    intakeModes: (input.intakeModes ??
      existing.intakeModes) as WorkflowTemplate["intakeModes"],
    allowedRoles: (input.allowedRoles ??
      existing.allowedRoles) as WorkflowTemplate["allowedRoles"],
    steps: input.steps ?? (existing.stepsJson as unknown as WorkflowStep[]),
    rules:
      input.rules ?? ((existing.rulesJson as unknown as WorkflowRule[]) ?? []),
    visibilityPolicy:
      input.visibilityPolicy ??
      (existing.visibilityPolicyJson as unknown as WorkflowVisibilityPolicy | null) ??
      null,
    reviewPolicy:
      input.reviewPolicy ??
      (existing.reviewPolicyJson as unknown as WorkflowReviewPolicy | null) ??
      null,
    exportPolicy:
      input.exportPolicy ??
      (existing.exportPolicyJson as unknown as WorkflowExportPolicy | null) ??
      null,
  };

  validateWorkflowTemplatePayload(projected);

  return client.evidenceWorkflowTemplate.update({
    where: { id: ctx.templateId },
    data: {
      name: projected.name,
      description: projected.description ?? null,
      workspaceCategory: projected.workspaceCategory ?? null,
      planMode: projected.planMode,
      locationRequirement: projected.locationRequirement,
      intakeModes: projected.intakeModes,
      allowedRoles: projected.allowedRoles ?? [],
      stepsJson: projected.steps as unknown as Prisma.InputJsonValue,
      rulesJson:
        projected.rules && projected.rules.length > 0
          ? (projected.rules as unknown as Prisma.InputJsonValue)
          : Prisma.JsonNull,
      visibilityPolicyJson: projected.visibilityPolicy
        ? (projected.visibilityPolicy as unknown as Prisma.InputJsonValue)
        : Prisma.JsonNull,
      reviewPolicyJson: projected.reviewPolicy
        ? (projected.reviewPolicy as unknown as Prisma.InputJsonValue)
        : Prisma.JsonNull,
      exportPolicyJson: projected.exportPolicy
        ? (projected.exportPolicy as unknown as Prisma.InputJsonValue)
        : Prisma.JsonNull,
      version: { increment: 1 },
      updatedByUserId: ctx.actorUserId,
    },
  });
}

export async function archiveWorkspaceWorkflowTemplate(
  ctx: { templateId: string; teamId: string; actorUserId: string },
  client: Pick<PrismaClient, "evidenceWorkflowTemplate"> = defaultPrisma,
): Promise<DbWorkflowTemplate | null> {
  const result = await client.evidenceWorkflowTemplate.updateMany({
    where: { id: ctx.templateId, teamId: ctx.teamId, archived: false },
    data: { archived: true, updatedByUserId: ctx.actorUserId },
  });
  if (result.count === 0) return null;
  return client.evidenceWorkflowTemplate.findUnique({
    where: { id: ctx.templateId },
  });
}

// -----------------------------------------------------------------------------
// Validation
// -----------------------------------------------------------------------------

export function validateWorkflowTemplatePayload(
  input: WorkflowTemplatePersistInput,
): WorkflowTemplate {
  if (input.visibilityPolicy !== undefined && input.visibilityPolicy !== null) {
    WorkflowVisibilityPolicySchema.parse(input.visibilityPolicy);
  }
  if (input.reviewPolicy !== undefined && input.reviewPolicy !== null) {
    WorkflowReviewPolicySchema.parse(input.reviewPolicy);
  }
  if (input.exportPolicy !== undefined && input.exportPolicy !== null) {
    WorkflowExportPolicySchema.parse(input.exportPolicy);
  }
  for (const step of input.steps) {
    WorkflowStepSchema.parse(step);
  }
  if (input.rules) {
    for (const rule of input.rules) {
      WorkflowRuleSchema.parse(rule);
    }
  }

  // Build a synthetic template for full-template validation.
  const candidate: WorkflowTemplate = {
    id: input.slug, // pre-persist; the DB row id is generated on insert
    slug: input.slug,
    version: 1,
    name: input.name,
    description: input.description ?? "",
    workspaceCategory: input.workspaceCategory ?? undefined,
    locationRequirement: input.locationRequirement,
    planMode: input.planMode,
    intakeModes: input.intakeModes,
    allowedRoles: input.allowedRoles,
    archived: false,
    steps: input.steps,
    rules: input.rules,
  };
  return WorkflowTemplateSchema.parse(candidate);
}

// -----------------------------------------------------------------------------
// Public projection — what the API returns. Includes policy snapshots so
// admins can see them, but always derived through the Phase 1 schemas so
// invalid persisted data can never leak.
// -----------------------------------------------------------------------------

export function projectEffectiveWorkflowTemplate(
  entry: EffectiveWorkflowTemplate,
): {
  id: string;
  dbId: string | null;
  slug: string;
  source: WorkflowTemplateSource;
  version: number;
  name: string;
  description: string;
  workspaceCategory: WorkflowWorkspaceCategory | null;
  locationRequirement: WorkflowTemplate["locationRequirement"];
  planMode: WorkflowPlanMode;
  intakeModes: WorkflowTemplate["intakeModes"];
  allowedRoles: WorkflowTemplate["allowedRoles"] | null;
  archived: boolean;
  steps: WorkflowStep[];
  rules: WorkflowRule[];
} {
  return {
    id: entry.template.id,
    dbId: entry.dbId,
    slug: entry.template.slug,
    source: entry.source,
    version: entry.template.version,
    name: entry.template.name,
    description: entry.template.description,
    workspaceCategory: entry.template.workspaceCategory ?? null,
    locationRequirement: entry.template.locationRequirement,
    planMode: entry.template.planMode,
    intakeModes: entry.template.intakeModes,
    allowedRoles: entry.template.allowedRoles ?? null,
    archived: entry.template.archived,
    steps: entry.template.steps,
    rules: entry.template.rules ?? [],
  };
}

// Re-export the baselines for callers that want to fall back to them.
export {
  WORKFLOW_BASELINE_EXPORT_POLICY,
  WORKFLOW_BASELINE_REVIEW_POLICY,
  WORKFLOW_BASELINE_VISIBILITY_POLICY,
};
