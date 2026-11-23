/**
 * TEAM-SPEC §0 / R1 (2026-11-23) — what lowering a Personal account from TEAM
 * ends on the Personal Workspace Team was bought for: its reviewer operations
 * (queues, assignments, escalations).
 *
 * ONE read-only answer for every billing surface that tells the customer before
 * or after they lower the plan: the plan-change route, the cancel route and the
 * billing projection's DOWNGRADE offers. Nothing is closed, reassigned or
 * deleted; nothing is scheduled (billing-sweep holds are untouched); a lowering
 * is never blocked by it. Null when the move does not end reviewer operations
 * (not from TEAM, or to a plan that still includes them) or when the counts
 * cannot be read — an informational field must never fail a billing answer.
 */
import * as prismaPkg from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";

export type ReviewerOperationsEnding = { openWorkflows: number; activeEscalations: number };

const COMPLETED_REVIEW_STATUSES = ["APPROVED_INTERNAL", "REJECTED_INSUFFICIENT", "CLOSED"] as const;
const ACTIVE_ESCALATION_STATUSES = ["OPEN", "ACKNOWLEDGED", "REASSIGNED"] as const;

/** Whether moving `fromPlan` → `toPlan` ends reviewer operations. */
export function loweringEndsReviewerOperations(
  fromPlan: prismaPkg.PlanType | string,
  toPlan: prismaPkg.PlanType | string,
): boolean {
  return fromPlan === prismaPkg.PlanType.TEAM && (toPlan === prismaPkg.PlanType.PRO || toPlan === prismaPkg.PlanType.FREE);
}

export async function reviewerOperationsEndingOnLowering(
  input: { userId: string; fromPlan: prismaPkg.PlanType | string; toPlan: prismaPkg.PlanType | string },
  client: prismaPkg.PrismaClient = defaultPrisma as unknown as prismaPkg.PrismaClient,
): Promise<ReviewerOperationsEnding | null> {
  if (!loweringEndsReviewerOperations(input.fromPlan, input.toPlan)) return null;
  try {
    const personal = await client.team.findFirst({
      where: { ownerUserId: input.userId, isPersonal: true },
      select: { id: true },
    });
    if (!personal) return { openWorkflows: 0, activeEscalations: 0 };
    const [openWorkflows, activeEscalations] = await Promise.all([
      client.evidenceReviewWorkflow.count({
        where: { teamId: personal.id, status: { notIn: [...COMPLETED_REVIEW_STATUSES] as never } },
      }),
      client.reviewEscalation.count({
        where: { teamId: personal.id, status: { in: [...ACTIVE_ESCALATION_STATUSES] as never } },
      }),
    ]);
    return { openWorkflows, activeEscalations };
  } catch {
    return null;
  }
}
