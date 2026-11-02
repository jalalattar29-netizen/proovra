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

/**
 * The policy columns these overrides are stored in. Only the keys the caller
 * sent: an omitted key is unchanged, it never erases another override
 * (WORKFLOW-002). The write itself goes through the ONE versioned writer,
 * `updateWorkspaceGovernancePolicyWithVersion`.
 */
export function slaOverridesToPolicyPatch(overrides: ReviewerOpsSlaPolicyOverride) {
  const parsed = ReviewerOpsSlaPolicySchema.safeParse(overrides);
  if (!parsed.success) {
    throw new Error("invalid_sla_policy_overrides");
  }
  const o = parsed.data;
  return {
    ...(o.assignmentHours !== undefined ? { defaultAssignmentDueHours: o.assignmentHours } : {}),
    ...(o.firstReviewHours !== undefined ? { defaultFirstResponseDueHours: o.firstReviewHours } : {}),
    ...(o.completionHours !== undefined ? { defaultCompletionDueHours: o.completionHours } : {}),
    ...(o.escalationHours !== undefined ? { defaultEscalationDueHours: o.escalationHours } : {}),
    ...(o.dueSoonHours !== undefined ? { defaultDueSoonHours: o.dueSoonHours } : {}),
  };
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

export { REVIEWER_OPS_DEFAULT_SLA_POLICY };
