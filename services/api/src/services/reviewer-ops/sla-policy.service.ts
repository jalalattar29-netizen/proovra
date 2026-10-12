/**
 * Phase 25.5 — SLA policy resolver.
 *
 * Resolves the effective SLA policy for a given workspace + optional
 * workflow template. Precedence (most-specific wins):
 *
 *   templateOverride  >  workspaceOverride  >  envDefaults  >  shared defaults
 *
 * Workspace overrides come from `WorkspaceGovernancePolicy`:
 *   - default_assignment_due_hours
 *   - default_first_response_due_hours
 *   - default_completion_due_hours
 *   - default_escalation_due_hours
 *   - default_due_soon_hours
 *
 * Template overrides come from `EvidenceWorkflowTemplate.reviewPolicyJson`
 * under the `sla` key, validated by `ReviewerOpsSlaPolicySchema`. Invalid
 * shapes are ignored (fail-open to lower-precedence values).
 */

import type { PrismaClient } from "@prisma/client";
import {
  REVIEWER_OPS_DEFAULT_SLA_POLICY,
  ReviewerOpsSlaPolicySchema,
  type ReviewerOpsSlaPolicyOverride,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";

export {
  resolveEffectiveSlaPolicy,
  type SlaPolicyResolutionResult,
} from "@proovra/shared-runtime";

// -----------------------------------------------------------------------------
// Public — upsertWorkspaceSlaPolicy
// -----------------------------------------------------------------------------

export type UpsertWorkspaceSlaPolicyInput = {
  teamId: string;
  actorUserId: string;
  overrides: ReviewerOpsSlaPolicyOverride;
};

export async function upsertWorkspaceSlaPolicy(
  input: UpsertWorkspaceSlaPolicyInput,
  client: PrismaClient = defaultPrisma,
): Promise<ReviewerOpsSlaPolicyOverride> {
  // Re-validate via the shared schema; the route layer should have
  // validated already, but defence in depth.
  const parsed = ReviewerOpsSlaPolicySchema.safeParse(input.overrides);
  if (!parsed.success) {
    throw new Error("invalid_sla_policy_overrides");
  }
  const o = parsed.data;
  await client.workspaceGovernancePolicy.upsert({
    where: { teamId: input.teamId },
    update: {
      defaultAssignmentDueHours: o.assignmentHours ?? null,
      defaultFirstResponseDueHours: o.firstReviewHours ?? null,
      defaultCompletionDueHours: o.completionHours ?? null,
      defaultEscalationDueHours: o.escalationHours ?? null,
      defaultDueSoonHours: o.dueSoonHours ?? null,
      updatedByUserId: input.actorUserId,
    },
    create: {
      teamId: input.teamId,
      defaultAssignmentDueHours: o.assignmentHours ?? null,
      defaultFirstResponseDueHours: o.firstReviewHours ?? null,
      defaultCompletionDueHours: o.completionHours ?? null,
      defaultEscalationDueHours: o.escalationHours ?? null,
      defaultDueSoonHours: o.dueSoonHours ?? null,
      updatedByUserId: input.actorUserId,
    },
  });
  return o;
}

// -----------------------------------------------------------------------------
// Public — workspace step-up + inactivity flag accessors.
// -----------------------------------------------------------------------------

export type WorkspaceReviewerOpsFlags = {
  requireStepUpForApprove: boolean;
  requireStepUpForReject: boolean;
  requireStepUpForEscalationResolve: boolean;
  requireStepUpForBulk: boolean;
  reviewerInactivityHours: number | null;
};

export async function loadWorkspaceReviewerOpsFlags(
  teamId: string,
  client: PrismaClient = defaultPrisma,
): Promise<WorkspaceReviewerOpsFlags> {
  const row = await client.workspaceGovernancePolicy.findUnique({
    where: { teamId },
    select: {
      requireStepUpForApprove: true,
      requireStepUpForReject: true,
      requireStepUpForEscalationResolve: true,
      requireStepUpForBulk: true,
      reviewerInactivityHours: true,
    },
  });
  return {
    requireStepUpForApprove: row?.requireStepUpForApprove ?? false,
    requireStepUpForReject: row?.requireStepUpForReject ?? false,
    requireStepUpForEscalationResolve:
      row?.requireStepUpForEscalationResolve ?? false,
    requireStepUpForBulk: row?.requireStepUpForBulk ?? false,
    reviewerInactivityHours: row?.reviewerInactivityHours ?? null,
  };
}

export async function upsertWorkspaceReviewerOpsFlags(
  input: {
    teamId: string;
    actorUserId: string;
    flags: Partial<WorkspaceReviewerOpsFlags>;
  },
  client: PrismaClient = defaultPrisma,
): Promise<WorkspaceReviewerOpsFlags> {
  const f = input.flags;
  await client.workspaceGovernancePolicy.upsert({
    where: { teamId: input.teamId },
    update: {
      ...(f.requireStepUpForApprove !== undefined
        ? { requireStepUpForApprove: f.requireStepUpForApprove }
        : {}),
      ...(f.requireStepUpForReject !== undefined
        ? { requireStepUpForReject: f.requireStepUpForReject }
        : {}),
      ...(f.requireStepUpForEscalationResolve !== undefined
        ? {
            requireStepUpForEscalationResolve:
              f.requireStepUpForEscalationResolve,
          }
        : {}),
      ...(f.requireStepUpForBulk !== undefined
        ? { requireStepUpForBulk: f.requireStepUpForBulk }
        : {}),
      ...(f.reviewerInactivityHours !== undefined
        ? { reviewerInactivityHours: f.reviewerInactivityHours }
        : {}),
      updatedByUserId: input.actorUserId,
    },
    create: {
      teamId: input.teamId,
      requireStepUpForApprove: f.requireStepUpForApprove ?? false,
      requireStepUpForReject: f.requireStepUpForReject ?? false,
      requireStepUpForEscalationResolve:
        f.requireStepUpForEscalationResolve ?? false,
      requireStepUpForBulk: f.requireStepUpForBulk ?? false,
      reviewerInactivityHours: f.reviewerInactivityHours ?? null,
      updatedByUserId: input.actorUserId,
    },
  });
  return loadWorkspaceReviewerOpsFlags(input.teamId, client);
}

export { REVIEWER_OPS_DEFAULT_SLA_POLICY };
