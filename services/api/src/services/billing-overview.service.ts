import * as prismaPkg from "@prisma/client";
import { prisma } from "../db.js";
import {
  ensureEntitlement,
  getStorageAddonDefinition,
} from "./billing.service.js";
import { getPlanCapabilities } from "./plan-catalog.service.js";
import {
  getPersonalWorkspaceScope,
  getTeamWorkspaceScope,
} from "./workspace-billing.service.js";
import { getWorkspaceUsage } from "./workspace-usage.service.js";

function addonStatusSortValue(status: prismaPkg.WorkspaceStorageAddonStatus) {
  switch (status) {
    case prismaPkg.WorkspaceStorageAddonStatus.ACTIVE:
      return 0;
    case prismaPkg.WorkspaceStorageAddonStatus.PAST_DUE:
      return 1;
    case prismaPkg.WorkspaceStorageAddonStatus.PENDING:
      return 2;
    case prismaPkg.WorkspaceStorageAddonStatus.CANCELED:
      return 3;
    case prismaPkg.WorkspaceStorageAddonStatus.EXPIRED:
      return 4;
    case prismaPkg.WorkspaceStorageAddonStatus.FAILED:
      return 5;
    default:
      return 9;
  }
}

function toStorageAddonSummary(
  addon: {
    id: string;
    ownerUserId: string;
    teamId: string | null;
    addonKey: prismaPkg.StorageAddonKey;
    extraStorageBytes: bigint;
    billingCycle: prismaPkg.StorageAddonBillingCycle;
    status: prismaPkg.WorkspaceStorageAddonStatus;
    paymentProvider: prismaPkg.PaymentProvider | null;
    externalSubscriptionId: string | null;
    externalPaymentId: string | null;
    currency: string | null;
    amountCents: number | null;
    activatedAtUtc: Date | null;
    currentPeriodEnd: Date | null;
    expiresAtUtc: Date | null;
    canceledAtUtc: Date | null;
    createdAt: Date;
    updatedAt: Date;
  },
  teamName?: string | null
) {
  const definition = getStorageAddonDefinition(addon.addonKey);
  return {
    id: addon.id,
    ownerUserId: addon.ownerUserId,
    teamId: addon.teamId ?? null,
    teamName: teamName ?? null,
    addonKey: addon.addonKey,
    extraStorageBytes: addon.extraStorageBytes.toString(),
    billingCycle: addon.billingCycle,
    status: addon.status,
    paymentProvider: addon.paymentProvider ?? null,
    externalSubscriptionId: addon.externalSubscriptionId ?? null,
    externalPaymentId: addon.externalPaymentId ?? null,
    currency: addon.currency ?? definition.currency,
    amountCents: addon.amountCents ?? definition.priceCents,
    activatedAtUtc: addon.activatedAtUtc
      ? addon.activatedAtUtc.toISOString()
      : null,
    currentPeriodEnd: addon.currentPeriodEnd
      ? addon.currentPeriodEnd.toISOString()
      : null,
    expiresAtUtc: addon.expiresAtUtc
      ? addon.expiresAtUtc.toISOString()
      : null,
    canceledAtUtc: addon.canceledAtUtc
      ? addon.canceledAtUtc.toISOString()
      : null,
    createdAt: addon.createdAt.toISOString(),
    updatedAt: addon.updatedAt.toISOString(),
  };
}

export async function readBillingOverview(userId: string) {
  const entitlement = await ensureEntitlement(userId);

  const personalScope = await getPersonalWorkspaceScope(userId);
  const personalUsage = await getWorkspaceUsage(personalScope);
  const personalCaps = getPlanCapabilities(personalScope.plan);

  const [ownedTeams, allStorageAddons, recentPayments, personalSubscription] =
    await Promise.all([
      prisma.team.findMany({
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
      }),
      prisma.workspaceStorageAddon.findMany({
        where: { ownerUserId: userId },
        orderBy: [{ createdAt: "desc" }],
      }),
      prisma.payment.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        take: 20,
      }),
      prisma.subscription.findFirst({
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
      }),
    ]);

  const activePersonalStorageAddons = allStorageAddons.filter(
    (addon) =>
      addon.teamId === null &&
      (addon.status === prismaPkg.WorkspaceStorageAddonStatus.ACTIVE ||
        addon.status === prismaPkg.WorkspaceStorageAddonStatus.PAST_DUE)
  );

  const teams = await Promise.all(
    ownedTeams.map(async (team) => {
      const scope = await getTeamWorkspaceScope(team.id);
      const usage = await getWorkspaceUsage(scope);
      const effectiveCaps = getPlanCapabilities(scope.plan);

      const [activeSubscription, teamStorageAddons] = await Promise.all([
        prisma.subscription.findFirst({
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
        }),
        prisma.workspaceStorageAddon.findMany({
          where: {
            ownerUserId: userId,
            teamId: team.id,
          },
          orderBy: [{ createdAt: "desc" }],
        }),
      ]);

      const activeTeamStorageAddons = teamStorageAddons.filter(
        (addon) =>
          addon.status === prismaPkg.WorkspaceStorageAddonStatus.ACTIVE ||
          addon.status === prismaPkg.WorkspaceStorageAddonStatus.PAST_DUE
      );

      const activeTeamStorageAddonBytes = activeTeamStorageAddons.reduce(
        (sum, addon) => sum + addon.extraStorageBytes,
        0n
      );

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
          basePlanLimitBytes: effectiveCaps.includedStorageBytes.toString(),
          activeAddonBytes: activeTeamStorageAddonBytes.toString(),
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
        storageAddons: teamStorageAddons
          .slice()
          .sort((a, b) => addonStatusSortValue(a.status) - addonStatusSortValue(b.status))
          .map((addon) => toStorageAddonSummary(addon, team.name)),
        activeStorageAddonSummary: {
          count: activeTeamStorageAddons.length,
          totalExtraStorageBytes: activeTeamStorageAddonBytes.toString(),
        },
        billingActivatedAt: team.billingActivatedAt,
        billingCanceledAt: team.billingCanceledAt,
      };
    })
  );

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
    (team) =>
      team.workspaceHealth.storageNearLimit ||
      team.workspaceHealth.storageLimitReached
  ).length;

  const personalActiveAddonBytes = activePersonalStorageAddons.reduce(
    (sum, addon) => sum + addon.extraStorageBytes,
    0n
  );

  const totalActiveAddonBytes = allStorageAddons
    .filter(
      (addon) =>
        addon.status === prismaPkg.WorkspaceStorageAddonStatus.ACTIVE ||
        addon.status === prismaPkg.WorkspaceStorageAddonStatus.PAST_DUE
    )
    .reduce((sum, addon) => sum + addon.extraStorageBytes, 0n);

  return {
    entitlement,
    summary: {
      personalPlan: personalScope.plan,
      personalCredits: personalScope.credits,
      totalTeams: teams.length,
      activeTeamPlans: activeTeamCount,
      overSeatLimitTeams: overSeatLimitCount,
      nearStorageLimitTeams: nearStorageLimitCount,
      activeStorageAddons: allStorageAddons.filter(
        (addon) =>
          addon.status === prismaPkg.WorkspaceStorageAddonStatus.ACTIVE ||
          addon.status === prismaPkg.WorkspaceStorageAddonStatus.PAST_DUE
      ).length,
      activeStorageAddonBytes: totalActiveAddonBytes.toString(),
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
          basePlanLimitBytes: personalCaps.includedStorageBytes.toString(),
          activeAddonBytes: personalActiveAddonBytes.toString(),
        },
        workspaceHealth: {
          storageNearLimit: personalUsage.isNearStorageLimit,
          storageLimitReached: personalUsage.isStorageLimitReached,
        },
        counts: {
          evidence: personalUsage.evidenceCount,
        },
        subscription: personalSubscription,
        storageAddons: allStorageAddons
          .filter((addon) => addon.teamId === null)
          .slice()
          .sort((a, b) => addonStatusSortValue(a.status) - addonStatusSortValue(b.status))
          .map((addon) => toStorageAddonSummary(addon, null)),
        activeStorageAddonSummary: {
          count: activePersonalStorageAddons.length,
          totalExtraStorageBytes: personalActiveAddonBytes.toString(),
        },
      },
      teams,
    },
    storageAddons: {
      all: allStorageAddons
        .slice()
        .sort((a, b) => addonStatusSortValue(a.status) - addonStatusSortValue(b.status))
        .map((addon) => {
          const teamName =
            addon.teamId != null
              ? ownedTeams.find((team) => team.id === addon.teamId)?.name ?? null
              : null;
          return toStorageAddonSummary(addon, teamName);
        }),
      active: allStorageAddons
        .filter(
          (addon) =>
            addon.status === prismaPkg.WorkspaceStorageAddonStatus.ACTIVE ||
            addon.status === prismaPkg.WorkspaceStorageAddonStatus.PAST_DUE
        )
        .map((addon) => {
          const teamName =
            addon.teamId != null
              ? ownedTeams.find((team) => team.id === addon.teamId)?.name ?? null
              : null;
          return toStorageAddonSummary(addon, teamName);
        }),
    },
    payments: recentPayments,
    paymentMethods: {
      PAYG: ["STRIPE", "PAYPAL"],
      PRO: ["STRIPE", "PAYPAL"],
      TEAM: ["STRIPE", "PAYPAL"],
      STORAGE_ADDONS: ["STRIPE", "PAYPAL"],
    },
  };
}