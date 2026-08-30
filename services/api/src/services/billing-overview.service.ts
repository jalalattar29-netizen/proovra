/**
 * THE PERSONAL ACCOUNT'S STORAGE AND ENTITLEMENT PROJECTION.
 *
 * WHAT THIS IS
 * ---------------------------------------------------------------------------
 * A convenience read for surfaces that need to show ONE person their own
 * storage and plan facts: the Home page, the sidebar storage widget, and the
 * storage wall that refuses an upload. It answers "how full am I, and what does
 * my plan include" — nothing else.
 *
 * WHAT THIS IS NOT
 * ---------------------------------------------------------------------------
 * It is NOT the billing authority, and its name is older than that
 * distinction. `/billing` reads `buildBillingAccountProjection`, which is
 * account-scoped, capability-filtered, and the only thing that may state a
 * price, a payment, a plan action or a contract term.
 *
 * It is also NOT a second commercial CALCULATOR, and never was — every figure
 * below comes from `resolveCommercialContext`, `getWorkspaceUsage` and
 * `getPlanCapabilities`, the same three primitives the canonical projection
 * calls. What was wrong with it was its SHAPE: it used to return
 * `workspaces.teams`, a per-workspace commercial rollup expressing the
 * Owned-Workspace-as-billing-subject model that `billing-accounts.service.ts`
 * retired on 2026-08-28. That rollup is gone (2026-09-03) along with the
 * summary counters derived from it.
 *
 * THE BOUNDARY, STATED SO IT CANNOT BE CROSSED BY ACCIDENT
 * ---------------------------------------------------------------------------
 * There is exactly ONE subject here: `userId`'s personal account. It resolves
 * no organization, reads no `EnterpriseContract`, and returns no seats,
 * contract terms, prices or capability set. An ORGANIZATION billing account —
 * the Enterprise subject — is reachable ONLY through
 * `resolveBillingAccountForViewer` + `buildBillingAccountProjection`, which
 * fail closed for a viewer without billing authority on it.
 *
 * If you are adding a consumer that needs a plan for a DECISION, a price, a
 * contract, an organization, or anyone other than the caller: this is the
 * wrong function. `billing-overview-boundary.test.ts` enforces that.
 */

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

/**
 * The projection's own name for what it returns. Inferred rather than
 * hand-written so it cannot drift from the implementation, but EXPORTED so a
 * consumer types against "a personal storage projection" rather than against
 * an anonymous billing-shaped blob.
 */
export type PersonalStorageProjection = Awaited<
  ReturnType<typeof readBillingOverview>
>;

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

  // COMMERCIAL AUTHORITY (2026-09-03) — the per-workspace rollup was DELETED.
  //
  // It resolved a commercial context, a usage rollup, a subscription and a
  // storage-add-on set for EVERY workspace the caller owns, and shaped them as
  // `workspaces.teams` — the Owned-Workspace-as-billing-subject model that
  // `billing-accounts.service.ts` retired on 2026-08-28. Nothing consumed it
  // any more once `/evidence` began reading the server's own capability
  // snapshot and organization setup began reading the canonical ORGANIZATION
  // billing account, so the shape and the work that built it are both gone.
  //
  // What remains here is a PERSONAL-account storage and entitlement
  // projection. It is not a commercial authority and never was: every figure
  // below comes from `resolveCommercialContext`, `getWorkspaceUsage` and
  // `getPlanCapabilities` — the same three primitives the canonical billing
  // projection calls.

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