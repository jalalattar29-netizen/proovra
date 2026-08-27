import { resolveCommercialContext } from "./billing/commercial-context.service.js";
import * as prismaPkg from "@prisma/client";
import { prisma } from "../db.js";
import {
  ensureEntitlement,
  getStorageAddonDefinition,
} from "./billing.service.js";
import { getPlanCapabilities } from "./plan-catalog.service.js";
// §9.7 — scope loading is consumed via the resolveCommercialContext envelope
// (explicit subjects); this file no longer calls the scope adapter directly.
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

  // §9.7 — canonical envelope with EXPLICIT subject (billing display surface).
  const personalScope = (
    await resolveCommercialContext({ type: "PERSONAL_ACCOUNT", userId })
  ).scope;
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
      // §9.7 — explicit WORKSPACE subject (overview lists workspaces of any kind).
      const scope = (
        await resolveCommercialContext({ type: "WORKSPACE", teamId: team.id, requesterUserId: userId })
      ).scope;
      const usage = await getWorkspaceUsage(scope);
      const effectiveCaps = getPlanCapabilities(scope.plan);

      const displayPlanForSeats =
        team.billingPlan === prismaPkg.PlanType.TEAM
          ? prismaPkg.PlanType.TEAM
          : scope.plan;

      const displaySeatCaps = getPlanCapabilities(displayPlanForSeats);

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

      const includedSeats = Math.max(
        team.includedSeats ?? 0,
        scope.teamSeats || 0,
        displaySeatCaps.includedSeats ?? 0
      );

      return {
        id: team.id,
        name: team.name,
        billingShape: "SHARED" as const,
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
          usageRatio:
            includedSeats > 0 ? usage.teamMemberCount / includedSeats : 0,
          usagePercent:
            includedSeats > 0
              ? Math.min(
                  100,
                  Math.round((usage.teamMemberCount / includedSeats) * 100)
                )
              : 0,
          nearLimit:
            includedSeats > 0 &&
            usage.teamMemberCount >= Math.max(1, Math.floor(includedSeats * 0.8)),
          limitReached: includedSeats > 0 && usage.teamMemberCount >= includedSeats,
        },
        workspaceHealth: {
          storageNearLimit: usage.isNearStorageLimit,
          storageLimitReached: usage.isStorageLimitReached,
          seatNearLimit:
            includedSeats > 0 &&
            usage.teamMemberCount >= Math.max(1, Math.floor(includedSeats * 0.8)),
          seatLimitReached: includedSeats > 0 && usage.teamMemberCount >= includedSeats,
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
        billingShape: "SINGLE_OCCUPANT" as const,
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
    // BILLING PRODUCTION CLOSURE (2026-08-27) — the raw `payments` array was
    // DELETED, narrowing this endpoint to the non-financial reads its
    // remaining consumers actually make.
    //
    // `/v1/billing/overview` still serves four surfaces that need one thing
    // from it: personal storage (the sidebar widget, the Home storage signals,
    // the Evidence library header) and the organization setup wizard's
    // readiness check. None of them read a payment, and no client in either app
    // ever did. What it carried instead was every payment row the caller had
    // made across every billing account they touch, merged and un-capability-
    // filtered — the exact shape `GET /v1/billing/payments` was deleted for.
    //
    // Account-scoped payment history lives at
    // `GET /v1/billing/accounts/:type/:id/history`, behind BILLING_HISTORY_VIEW.
    // The aggregate `summary` counts below are retained: they identify nobody
    // and no payer, and the setup wizard reads them.
    //
    // `paymentMethods` was DELETED at the same time.
    //
    // It was a hard-coded map from plan name to provider names. No provider
    // authority produced it, nothing verified it, and it shared a name with the
    // one thing a billing surface must never fabricate: which cards a customer
    // has on file. Which providers a checkout accepts is decided by the
    // checkout routes at the moment of purchase.
  };
}