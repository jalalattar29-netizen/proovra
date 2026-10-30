/**
 * BILLING REMEDIATION (2026-10-30, AUD-29) — ending a legacy workspace's TEAM plan.
 *
 * Self-service TEAM is a tier of the Personal Workspace now, but a workspace
 * bought under the old model still carries `billingPlan: TEAM`, and the policy
 * reads it while `billingStatus` is live. When `cancelTeamPlan` was deleted,
 * nothing was left to end that status, so the workspace kept TEAM after its
 * subscription was cancelled.
 *
 * Deliberately narrow. It acts only on the end of a subscription scoped to that
 * workspace, only for an OWNED workspace on TEAM, and its caller confirms no
 * other live subscription is scoped to it. An ORGANIZATION workspace stays with Enterprise
 * provisioning. It closes the billing state and deletes nothing: evidence,
 * members and `billingPlan` itself are left as they are.
 */
import * as prismaPkg from "@prisma/client";

import { prisma } from "../../db.js";

export async function endLegacyWorkspaceBilling(input: {
  teamId: string;
  now?: Date;
}): Promise<boolean> {
  const closed = await prisma.team.updateMany({
    where: {
      id: input.teamId,
      workspaceKind: prismaPkg.WorkspaceKind.OWNED,
      billingPlan: prismaPkg.PlanType.TEAM,
      billingStatus: { in: [prismaPkg.TeamBillingStatus.ACTIVE, prismaPkg.TeamBillingStatus.PAST_DUE] },
    },
    data: { billingStatus: prismaPkg.TeamBillingStatus.CANCELED, billingCanceledAt: input.now ?? new Date() },
  });
  return closed.count > 0;
}
