/**
 * THE effective review/operations SLA policy for a workspace: shared defaults,
 * then environment overrides, then the workspace's own governance policy, then
 * a workflow template's. Lives here so the API and the Worker resolve the SAME
 * promise — the Worker opens SLA cycles for the conditions it records.
 */
import type { PrismaClient } from "@prisma/client";
import {
  REVIEWER_OPS_SLA_POLICY_HOURS_MAX,
  REVIEWER_OPS_SLA_POLICY_HOURS_MIN,
  ReviewerOpsSlaPolicySchema,
  resolveReviewerOpsSlaPolicy,
  type ReviewerOpsSlaPolicy,
  type ReviewerOpsSlaPolicyOverride,
} from "@proovra/shared";

import { getRegisteredPrisma } from "../prisma-registry.js";

// -----------------------------------------------------------------------------
// Env defaults — read at call time so test harnesses can override.
// -----------------------------------------------------------------------------

function envOverride(): ReviewerOpsSlaPolicyOverride {
  const parse = (key: string): number | undefined => {
    const raw = process.env[key];
    if (!raw) return undefined;
    const n = Number(raw);
    if (!Number.isFinite(n)) return undefined;
    if (n < REVIEWER_OPS_SLA_POLICY_HOURS_MIN) return undefined;
    if (n > REVIEWER_OPS_SLA_POLICY_HOURS_MAX) return undefined;
    return Math.floor(n);
  };
  const out: ReviewerOpsSlaPolicyOverride = {};
  const a = parse("REVIEW_SLA_ASSIGNMENT_HOURS");
  if (a !== undefined) out.assignmentHours = a;
  const f = parse("REVIEW_SLA_FIRST_REVIEW_HOURS");
  if (f !== undefined) out.firstReviewHours = f;
  const c = parse("REVIEW_SLA_COMPLETION_HOURS");
  if (c !== undefined) out.completionHours = c;
  const e = parse("REVIEW_SLA_ESCALATION_HOURS");
  if (e !== undefined) out.escalationHours = e;
  const d = parse("REVIEW_SLA_DUE_SOON_HOURS");
  if (d !== undefined) out.dueSoonHours = d;
  return out;
}

// -----------------------------------------------------------------------------
// Workspace override loader
// -----------------------------------------------------------------------------

async function loadWorkspaceOverride(
  teamId: string,
  client: PrismaClient,
): Promise<ReviewerOpsSlaPolicyOverride> {
  const row = await client.workspaceGovernancePolicy.findUnique({
    where: { teamId },
  });
  if (!row) return {};
  const out: ReviewerOpsSlaPolicyOverride = {};
  if (row.defaultAssignmentDueHours != null) {
    out.assignmentHours = row.defaultAssignmentDueHours;
  }
  // Phase 13.5's `defaultFirstResponseDueHours` is the first-review SLA.
  if (row.defaultFirstResponseDueHours != null) {
    out.firstReviewHours = row.defaultFirstResponseDueHours;
  }
  if (row.defaultCompletionDueHours != null) {
    out.completionHours = row.defaultCompletionDueHours;
  }
  if (row.defaultEscalationDueHours != null) {
    out.escalationHours = row.defaultEscalationDueHours;
  }
  if (row.defaultDueSoonHours != null) {
    out.dueSoonHours = row.defaultDueSoonHours;
  }
  return out;
}

// -----------------------------------------------------------------------------
// Template override loader
// -----------------------------------------------------------------------------

async function loadTemplateOverride(
  templateId: string | null | undefined,
  client: PrismaClient,
): Promise<ReviewerOpsSlaPolicyOverride> {
  if (!templateId) return {};
  const row = await client.evidenceWorkflowTemplate.findUnique({
    where: { id: templateId },
    select: { reviewPolicyJson: true },
  });
  if (!row?.reviewPolicyJson) return {};
  const candidate = (row.reviewPolicyJson as Record<string, unknown>).sla;
  if (!candidate || typeof candidate !== "object") return {};
  const parsed = ReviewerOpsSlaPolicySchema.safeParse(candidate);
  if (!parsed.success) return {};
  return parsed.data;
}

// -----------------------------------------------------------------------------
// Public — resolveEffectiveSlaPolicy
// -----------------------------------------------------------------------------

export type SlaPolicyResolutionResult = {
  policy: ReviewerOpsSlaPolicy;
  sources: {
    template: ReviewerOpsSlaPolicyOverride;
    workspace: ReviewerOpsSlaPolicyOverride;
    env: ReviewerOpsSlaPolicyOverride;
  };
};

export async function resolveEffectiveSlaPolicy(
  input: { teamId: string; templateId?: string | null },
  client: PrismaClient = getRegisteredPrisma(),
): Promise<SlaPolicyResolutionResult> {
  const [workspace, template] = await Promise.all([
    loadWorkspaceOverride(input.teamId, client),
    loadTemplateOverride(input.templateId ?? null, client),
  ]);
  const env = envOverride();
  const policy = resolveReviewerOpsSlaPolicy({
    templateOverride: template,
    workspaceOverride: workspace,
    envDefaults: env,
  });
  return {
    policy,
    sources: { template, workspace, env },
  };
}

