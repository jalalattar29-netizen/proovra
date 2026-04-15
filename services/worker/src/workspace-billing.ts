import * as prismaPkg from "@prisma/client";
import { prisma } from "./db.js";

export async function resolveEffectivePlanForEvidence(params: {
  ownerUserId: string;
  teamId?: string | null;
}): Promise<prismaPkg.PlanType> {
  if (params.teamId) {
    const team = await prisma.team.findUnique({
      where: { id: params.teamId },
      select: {
        billingPlan: true,
        billingStatus: true,
      },
    });

    if (!team) {
      throw new Error("TEAM_NOT_FOUND_FOR_EVIDENCE");
    }

    return team.billingStatus === prismaPkg.TeamBillingStatus.ACTIVE ||
      team.billingStatus === prismaPkg.TeamBillingStatus.PAST_DUE
      ? team.billingPlan
      : prismaPkg.PlanType.FREE;
  }

  const entitlement = await prisma.entitlement.findFirst({
    where: { userId: params.ownerUserId, active: true },
    orderBy: { createdAt: "desc" },
    select: { plan: true },
  });

  return entitlement?.plan ?? prismaPkg.PlanType.FREE;
}