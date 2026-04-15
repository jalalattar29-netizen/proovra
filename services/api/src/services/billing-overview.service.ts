import { prisma } from "../db.js";
import { ensureEntitlement } from "./billing.service.js";
import { getPlanCapabilities } from "./plan-catalog.service.js";
import {
  getPersonalWorkspaceScope,
  getTeamWorkspaceScope,
} from "./workspace-billing.service.js";
import { getWorkspaceUsage } from "./workspace-usage.service.js";

export async function readBillingOverview(userId: string) {
  const entitlement = await ensureEntitlement(userId);

  const personalScope = await getPersonalWorkspaceScope(userId);
  const personalUsage = await getWorkspaceUsage(personalScope);
  const personalCaps = getPlanCapabilities(personalScope.plan);

  const ownedTeams = await prisma.team.findMany({
    where: { ownerUserId: userId },
    select: {
      id: true,
      name: true,
      ownerUserId: true,
      billingPlan: true,
      billingStatus: true,
      includedSeats: true,
      overSeatLimit: true,
      billingActivatedAt: true,
      billingCanceledAt: true,
      billingOwnerUserId: true,
    },
    orderBy: { createdAt: "desc" },
  });

  const teams = await Promise.all(
    ownedTeams.map(async (team) => {
      const scope = await getTeamWorkspaceScope(team.id);
      const usage = await getWorkspaceUsage(scope);
      const effectiveCaps = getPlanCapabilities(scope.plan);

      const activeSubscription = await prisma.subscription.findFirst({
        where: {
          userId,
          teamId: team.id,
        },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          provider: true,
          providerSubId: true,
          status: true,
          plan: true,
          currentPeriodEnd: true,
          createdAt: true,
        },
      });

      const includedSeats = Math.max(team.includedSeats ?? 0, scope.teamSeats || 0);

      return {
        id: team.id,
        name: team.name,
        workspaceType: "TEAM" as const,
        plan: team.billingPlan,
        effectivePlan: scope.plan,
        billingStatus: team.billingStatus,
        billingOwnerUserId: team.billingOwnerUserId,
        overSeatLimit: team.overSeatLimit,
        credits: scope.credits,
        teamSeats: scope.teamSeats,
        features: {
          reportsIncluded: effectiveCaps.reportsIncluded,
          verificationPackageIncluded:
            effectiveCaps.verificationPackageIncluded,
          publicVerifyIncluded: effectiveCaps.publicVerifyIncluded,
        },
        storage: {
          usedBytes: usage.storageBytesUsed.toString(),
          limitBytes: usage.storageBytesLimit.toString(),
          remainingBytes: usage.storageBytesRemaining.toString(),
          usedLabel: usage.storageLabel,
          limitLabel: usage.storageLimitLabel,
          remainingLabel: usage.storageRemainingLabel,
          usageRatio: usage.storageUsageRatio,
          usagePercent: usage.storageUsagePercent,
          nearLimit: usage.isNearStorageLimit,
          limitReached: usage.isStorageLimitReached,
        },
        seats: {
          used: usage.teamMemberCount,
          included: includedSeats,
          remaining: Math.max(0, includedSeats - usage.teamMemberCount),
          usageRatio: usage.seatUsageRatio,
          usagePercent: usage.seatUsagePercent,
          nearLimit: usage.isNearSeatLimit,
          limitReached: usage.isSeatLimitReached,
        },
        workspaceHealth: {
          storageNearLimit: usage.isNearStorageLimit,
          storageLimitReached: usage.isStorageLimitReached,
          seatNearLimit: usage.isNearSeatLimit,
          seatLimitReached: usage.isSeatLimitReached,
          overSeatLimit: Boolean(team.overSeatLimit),
        },
        counts: {
          evidence: usage.evidenceCount,
          members: usage.teamMemberCount,
        },
        subscription: activeSubscription,
        billingActivatedAt: team.billingActivatedAt,
        billingCanceledAt: team.billingCanceledAt,
      };
    })
  );

  const personalSubscription = await prisma.subscription.findFirst({
    where: {
      userId,
      teamId: null,
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      provider: true,
      providerSubId: true,
      status: true,
      plan: true,
      currentPeriodEnd: true,
      createdAt: true,
    },
  });

  const recentPayments = await prisma.payment.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: 20,
  });

  const paymentSummary = recentPayments.reduce(
    (acc, payment) => {
      acc.total += 1;

      if (payment.status === "SUCCEEDED") acc.succeeded += 1;
      else if (payment.status === "FAILED") acc.failed += 1;
      else if (payment.status === "REFUNDED") acc.refunded += 1;
      else acc.pending += 1;

      if (payment.teamId) acc.teamPayments += 1;
      else acc.personalPayments += 1;

      acc.totalAmountCents += payment.amountCents;

      return acc;
    },
    {
      total: 0,
      succeeded: 0,
      failed: 0,
      refunded: 0,
      pending: 0,
      personalPayments: 0,
      teamPayments: 0,
      totalAmountCents: 0,
    }
  );

  const activeTeamCount = teams.filter(
    (team) => team.billingStatus === "ACTIVE" || team.billingStatus === "PAST_DUE"
  ).length;

  const overSeatLimitCount = teams.filter((team) => team.overSeatLimit).length;
  const nearStorageLimitCount = teams.filter(
    (team) => team.workspaceHealth.storageNearLimit || team.workspaceHealth.storageLimitReached
  ).length;

  return {
    entitlement,
    summary: {
      personalPlan: personalScope.plan,
      personalCredits: personalScope.credits,
      totalTeams: teams.length,
      activeTeamPlans: activeTeamCount,
      overSeatLimitTeams: overSeatLimitCount,
      nearStorageLimitTeams: nearStorageLimitCount,
      payments: paymentSummary,
    },
    workspaces: {
      personal: {
        workspaceType: "PERSONAL" as const,
        plan: personalScope.plan,
        credits: personalScope.credits,
        teamSeats: personalScope.teamSeats,
        features: {
          reportsIncluded: personalCaps.reportsIncluded,
          verificationPackageIncluded:
            personalCaps.verificationPackageIncluded,
          publicVerifyIncluded: personalCaps.publicVerifyIncluded,
        },
        storage: {
          usedBytes: personalUsage.storageBytesUsed.toString(),
          limitBytes: personalUsage.storageBytesLimit.toString(),
          remainingBytes: personalUsage.storageBytesRemaining.toString(),
          usedLabel: personalUsage.storageLabel,
          limitLabel: personalUsage.storageLimitLabel,
          remainingLabel: personalUsage.storageRemainingLabel,
          usageRatio: personalUsage.storageUsageRatio,
          usagePercent: personalUsage.storageUsagePercent,
          nearLimit: personalUsage.isNearStorageLimit,
          limitReached: personalUsage.isStorageLimitReached,
        },
        workspaceHealth: {
          storageNearLimit: personalUsage.isNearStorageLimit,
          storageLimitReached: personalUsage.isStorageLimitReached,
        },
        counts: {
          evidence: personalUsage.evidenceCount,
        },
        subscription: personalSubscription,
      },
      teams,
    },
    payments: recentPayments,
    paymentMethods: {
      PAYG: ["STRIPE", "PAYPAL"],
      PRO: ["STRIPE", "PAYPAL"],
      TEAM: ["STRIPE", "PAYPAL"],
    },
  };
}