import { prisma } from "../db.js";
// PHASE 12 REMEDIATION §6.1 (2026-08-06) — the ONE seat-OCCUPANCY authority,
// shared with the worker. The seat-CEILING comparison stays
// `computeOverSeatLimit` in this file — one quantity, one comparison.
import { countActiveSeatOccupancy } from "@proovra/shared-runtime";
import * as prismaPkg from "@prisma/client";
import { getPlanCapabilities } from "./plan-catalog.service.js";
import { writeAnalyticsEvent } from "./analytics-event.service.js";

const GB = 1024n * 1024n * 1024n;

type StorageAddonDefinition = {
  key: prismaPkg.StorageAddonKey;
  billingShape: "SINGLE_OCCUPANT" | "SHARED";
  storageBytes: bigint;
  priceCents: number;
  currency: string;
  label: string;
};

const STORAGE_ADDON_DEFINITIONS: readonly StorageAddonDefinition[] = [
  {
    key: prismaPkg.StorageAddonKey.PERSONAL_10_GB,
    billingShape: "SINGLE_OCCUPANT",
    storageBytes: 10n * GB,
    priceCents: 299,
    currency: "EUR",
    label: "+10 GB",
  },
  {
    key: prismaPkg.StorageAddonKey.PERSONAL_50_GB,
    billingShape: "SINGLE_OCCUPANT",
    storageBytes: 50n * GB,
    priceCents: 799,
    currency: "EUR",
    label: "+50 GB",
  },
  {
    key: prismaPkg.StorageAddonKey.PERSONAL_200_GB,
    billingShape: "SINGLE_OCCUPANT",
    storageBytes: 200n * GB,
    priceCents: 1999,
    currency: "EUR",
    label: "+200 GB",
  },
  {
    key: prismaPkg.StorageAddonKey.TEAM_100_GB,
    billingShape: "SHARED",
    storageBytes: 100n * GB,
    priceCents: 999,
    currency: "EUR",
    label: "+100 GB",
  },
  {
    key: prismaPkg.StorageAddonKey.TEAM_500_GB,
    billingShape: "SHARED",
    storageBytes: 500n * GB,
    priceCents: 3499,
    currency: "EUR",
    label: "+500 GB",
  },
  {
    key: prismaPkg.StorageAddonKey.TEAM_1_TB,
    billingShape: "SHARED",
    storageBytes: 1024n * GB,
    priceCents: 5999,
    currency: "EUR",
    label: "+1 TB",
  },
] as const;

async function trackBillingEvent(params: {
  eventType: string;
  userId: string;
  teamId?: string | null;
  plan?: prismaPkg.PlanType | null;
  provider?: prismaPkg.PaymentProvider | null;
  paymentStatus?: prismaPkg.PaymentStatus | null;
  subscriptionStatus?: prismaPkg.SubscriptionStatus | null;
  metadata?: Record<string, unknown>;
}) {
  try {
    await writeAnalyticsEvent({
      eventType: params.eventType,
      userId: params.userId,
      entityType: params.teamId ? "team_billing" : "personal_billing",
      entityId: params.teamId ?? params.userId,
      sessionId: `system_${params.eventType}_${params.teamId ?? params.userId}`,
      visitorId: `system_billing_${params.userId}`,
      path: params.teamId ? "/billing/team" : "/billing",
      skipSessionUpsert: true,
      metadata: {
        teamId: params.teamId ?? null,
        plan: params.plan ?? null,
        provider: params.provider ?? null,
        paymentStatus: params.paymentStatus ?? null,
        subscriptionStatus: params.subscriptionStatus ?? null,
        ...(params.metadata ?? {}),
      },
    });
  } catch {
    // analytics must never block billing flows
  }
}

function toNullableJsonInput(
  value: Record<string, unknown> | null | undefined
):
  | prismaPkg.Prisma.NullableJsonNullValueInput
  | prismaPkg.Prisma.InputJsonValue {
  if (value == null) {
    return prismaPkg.Prisma.JsonNull;
  }

  return value as prismaPkg.Prisma.InputJsonValue;
}

export function getStorageAddonDefinition(
  key: prismaPkg.StorageAddonKey
): StorageAddonDefinition {
  const found = STORAGE_ADDON_DEFINITIONS.find((item) => item.key === key);
  if (!found) {
    throw new Error(`Unknown storage addon key: ${String(key)}`);
  }
  return found;
}

export function listStorageAddonDefinitions() {
  return [...STORAGE_ADDON_DEFINITIONS];
}

export async function ensureEntitlement(userId: string) {
  const existing = await prisma.entitlement.findFirst({
    where: { userId, active: true },
    orderBy: { createdAt: "desc" },
  });

  if (existing) {
    return existing;
  }

  const created = await prisma.entitlement.create({
    data: {
      userId,
      plan: prismaPkg.PlanType.FREE,
      credits: 0,
      teamSeats: 0,
      active: true,
    },
  });

  await trackBillingEvent({
    eventType: "billing_plan_changed",
    userId,
    plan: created.plan,
    metadata: {
      reason: "entitlement_initialized",
      credits: created.credits,
      teamSeats: created.teamSeats,
    },
  });

  return created;
}

export async function getActiveEntitlement(userId: string) {
  return ensureEntitlement(userId);
}

export async function setPersonalPlan(
  userId: string,
  plan: prismaPkg.PlanType
) {
  if (plan === prismaPkg.PlanType.TEAM) {
    const err: Error & { statusCode?: number; code?: string } = new Error(
      "TEAM is not a valid personal plan"
    );
    err.statusCode = 409;
    err.code = "TEAM_NOT_ALLOWED_FOR_PERSONAL_WORKSPACE";
    throw err;
  }

  // BILLING PRODUCTION CLOSURE (2026-08-27) — PAYG is not a plan any writer may
  // produce.
  //
  // This is THE single writer of `entitlements.plan`, which makes it the one
  // place the invariant can be stated once and be true everywhere. Evidence
  // credits are a wallet over whatever plan the account is on; promoting an
  // account to the legacy PAYG row would hand it that row's grandfathered
  // terms — 5 GB of storage and 50 AI operations a month that no purchase pays
  // for — and would rebind every future completion to a credit.
  //
  // The catalog row stays, because historical entitlements still resolve
  // through it. Nothing may CREATE another one.
  if (plan === prismaPkg.PlanType.PAYG) {
    const err: Error & { statusCode?: number; code?: string } = new Error(
      "PAYG is a legacy resolution row, not an assignable plan"
    );
    err.statusCode = 409;
    err.code = "PAYG_NOT_ASSIGNABLE";
    throw err;
  }

  await ensureEntitlement(userId);

  await prisma.entitlement.updateMany({
    where: {
      userId,
      active: true,
    },
    data: {
      plan,
      teamSeats: 0,
    },
  });

  const next = await ensureEntitlement(userId);

  await trackBillingEvent({
    eventType: "billing_plan_changed",
    userId,
    plan,
    metadata: {
      billingShape: "SINGLE_OCCUPANT",
      credits: next.credits ?? 0,
      teamSeats: next.teamSeats ?? 0,
    },
  });

  return next;
}

export async function activateTeamPlan(params: {
  teamId: string;
  ownerUserId: string;
  plan: prismaPkg.PlanType;
  status?: prismaPkg.TeamBillingStatus;
}) {
  if (params.plan !== prismaPkg.PlanType.TEAM) {
    const err: Error & { statusCode?: number; code?: string } = new Error(
      "Only TEAM can activate a team workspace plan"
    );
    err.statusCode = 409;
    err.code = "INVALID_TEAM_PLAN";
    throw err;
  }

  const team = await prisma.team.findUnique({
    where: { id: params.teamId },
    select: {
      id: true,
      ownerUserId: true,
      // P5 domain remediation (2026-07-21) — seat counting is ACTIVE-only
      // (suspended/revoked members are access-denied and release their seat).
      _count: { select: { members: { where: { status: "ACTIVE" } } } },
    },
  });

  if (!team) {
    const err: Error & { statusCode?: number } = new Error("Team not found");
    err.statusCode = 404;
    throw err;
  }

  if (team.ownerUserId !== params.ownerUserId) {
    const err: Error & { statusCode?: number } = new Error(
      "Only the team owner can manage this team billing"
    );
    err.statusCode = 403;
    throw err;
  }

  const caps = getPlanCapabilities(prismaPkg.PlanType.TEAM);
  const includedSeats = caps.includedSeats;
  // PHASE 12 POINT 4 PASS C — third implementation of the same rule, folded
  // into the shared policy. This one already counted ACTIVE members only, but
  // it still lacked the `includedSeats > 0` unlimited guard, so a plan whose
  // catalog entry carries no seat ceiling would have marked every workspace
  // over the limit on activation.
  const overSeatLimit = computeOverSeatLimit({
    activeMemberCount: team._count.members,
    includedSeats,
  });

  const updated = await prisma.team.update({
    where: { id: params.teamId },
    data: {
      billingOwnerUserId: params.ownerUserId,
      billingPlan: prismaPkg.PlanType.TEAM,
      billingStatus: params.status ?? prismaPkg.TeamBillingStatus.ACTIVE,
      includedSeats,
      overSeatLimit,
      billingActivatedAt: new Date(),
      billingCanceledAt: null,
    },
  });

  await trackBillingEvent({
    eventType: "team_plan_activated",
    userId: params.ownerUserId,
    teamId: params.teamId,
    plan: prismaPkg.PlanType.TEAM,
    metadata: {
      billingStatus: updated.billingStatus,
      includedSeats,
      memberCount: team._count.members,
      overSeatLimit,
    },
  });

  if (overSeatLimit) {
    await trackBillingEvent({
      eventType: "team_seat_limit_reached",
      userId: params.ownerUserId,
      teamId: params.teamId,
      plan: prismaPkg.PlanType.TEAM,
      metadata: {
        memberCount: team._count.members,
        includedSeats,
      },
    });
  }

  return updated;
}

export async function cancelTeamPlan(params: {
  teamId: string;
  ownerUserId: string;
}) {
  const team = await prisma.team.findUnique({
    where: { id: params.teamId },
    select: {
      id: true,
      ownerUserId: true,
    },
  });

  if (!team) {
    const err: Error & { statusCode?: number } = new Error("Team not found");
    err.statusCode = 404;
    throw err;
  }

  if (team.ownerUserId !== params.ownerUserId) {
    const err: Error & { statusCode?: number } = new Error(
      "Only the team owner can manage this team billing"
    );
    err.statusCode = 403;
    throw err;
  }

  // PHASE 12 REMEDIATION — COMM-001 (2026-08-06). TWO defects, one fix.
  //
  //  1. COUNTING. This was `teamMember.count({ where: { teamId } })` with no
  //     status predicate, so SUSPENDED and REVOKED members occupied seats in
  //     the arithmetic. Occupancy now comes from the ONE shared authority
  //     (`countActiveSeatOccupancy`), which counts only memberships that
  //     currently grant access — the same predicate the access-policy engine
  //     and `rbac.service.ts` (the invite-time enforcer) already use, and the
  //     same one the worker's reconciliation now uses.
  //
  //  2. DUPLICATE CEILING RULE. The comparison here was the inline
  //     `memberCount > 0`, a SECOND seat-ceiling rule that contradicted the
  //     canonical `computeOverSeatLimit` below — under which `includedSeats:
  //     0` means NO CEILING. The two disagreed about the very row this
  //     function writes: `refreshTeamSeatState`, running afterwards over the
  //     same workspace, would compute `false` where this wrote `true`. The
  //     inline rule is deleted; there is now one comparison authority, and
  //     the value this function persists is the value the canonical
  //     refresher will agree with.
  const activeSeats = await countActiveSeatOccupancy(
    { teamId: params.teamId },
    prisma,
  );
  const canceledIncludedSeats = 0;

  const updated = await prisma.team.update({
    where: { id: params.teamId },
    data: {
      billingOwnerUserId: null,
      billingPlan: prismaPkg.PlanType.FREE,
      billingStatus: prismaPkg.TeamBillingStatus.CANCELED,
      includedSeats: canceledIncludedSeats,
      overSeatLimit: computeOverSeatLimit({
        activeMemberCount: activeSeats,
        includedSeats: canceledIncludedSeats,
      }),
      billingCanceledAt: new Date(),
    },
  });

  await trackBillingEvent({
    eventType: "team_plan_canceled",
    userId: params.ownerUserId,
    teamId: params.teamId,
    plan: prismaPkg.PlanType.FREE,
    metadata: {
      // COMM-001 — reported quantity now matches the enforced one.
      activeSeats,
      overSeatLimit: updated.overSeatLimit,
      billingStatus: updated.billingStatus,
    },
  });

  return updated;
}

// =============================================================================
// BILLING COMMERCIAL CORRECTNESS (2026-08-27) — `addCredits` and
// `consumeCredits` were DELETED here. Their replacement is the canonical
// evidence-credit wallet in `services/billing/evidence-credits.service.ts`.
//
// Both were unsafe for the thing they were used for:
//
//   `addCredits`      incremented the balance with NO idempotency and NO
//                     ledger, so a re-delivered provider event double-credited
//                     a wallet and nothing recorded which payment bought what.
//   `consumeCredits`  read the balance, compared it in application memory,
//                     then decremented in a SEPARATE statement. Two concurrent
//                     completions could both read "1 credit" and both decrement
//                     it, and it accepted no transaction client, so its caller
//                     inside the evidence-completion transaction was in fact
//                     writing outside that transaction — a rolled-back
//                     completion still burned the credit.
//
// The wallet replaces both with a conditional decrement
// (`credits: { gte: required }` in the WHERE) plus an immutable ledger entry
// written in the caller's own transaction, with a UNIQUE `evidence_id` making
// consumption idempotent per Evidence record.
// =============================================================================

export async function recordPayment(params: {
  userId: string;
  provider: prismaPkg.PaymentProvider;
  providerPaymentId: string;
  amountCents: number;
  currency: string;
  status: prismaPkg.PaymentStatus;
  teamId?: string | null;
}) {
  const payment = await prisma.payment.upsert({
    where: {
      provider_providerPaymentId: {
        provider: params.provider,
        providerPaymentId: params.providerPaymentId,
      },
    },
    update: {
      status: params.status,
      amountCents: params.amountCents,
      currency: params.currency,
      teamId: params.teamId ?? null,
    },
    create: {
      userId: params.userId,
      provider: params.provider,
      providerPaymentId: params.providerPaymentId,
      amountCents: params.amountCents,
      currency: params.currency,
      status: params.status,
      teamId: params.teamId ?? null,
    },
  });

  await trackBillingEvent({
    eventType:
      params.status === prismaPkg.PaymentStatus.SUCCEEDED
        ? "billing_payment_succeeded"
        : params.status === prismaPkg.PaymentStatus.FAILED
          ? "billing_payment_failed"
          : params.status === prismaPkg.PaymentStatus.REFUNDED
            ? "billing_payment_refunded"
            : "billing_checkout_completed",
    userId: params.userId,
    teamId: params.teamId ?? null,
    provider: params.provider,
    paymentStatus: params.status,
    metadata: {
      paymentId: params.providerPaymentId,
      amountCents: params.amountCents,
      currency: params.currency,
    },
  });

  return payment;
}

export async function upsertSubscription(params: {
  userId: string;
  provider: prismaPkg.PaymentProvider;
  providerSubId: string;
  status: prismaPkg.SubscriptionStatus;
  plan: prismaPkg.PlanType;
  currentPeriodEnd?: Date | null;
  teamId?: string | null;
}) {
  const existing = await prisma.subscription.findUnique({
    where: {
      provider_providerSubId: {
        provider: params.provider,
        providerSubId: params.providerSubId,
      },
    },
    select: {
      id: true,
      status: true,
      plan: true,
      teamId: true,
      currentPeriodEnd: true,
      userId: true,
    },
  });

  // §9.10 STALE/OUT-OF-ORDER PROTECTION (2026-07-23): a provider event whose
  // billing period is OLDER than the stored row's cannot restore an older
  // entitlement state. Provider events for the same subscription advance
  // monotonically in currentPeriodEnd; an event carrying an earlier period
  // end than what we already recorded is a late/retried delivery of an
  // older state — skip the write (idempotent no-op) and keep the newer row.
  if (
    existing &&
    existing.currentPeriodEnd &&
    params.currentPeriodEnd &&
    params.currentPeriodEnd.getTime() < existing.currentPeriodEnd.getTime()
  ) {
    return prisma.subscription.findUniqueOrThrow({
      where: {
        provider_providerSubId: {
          provider: params.provider,
          providerSubId: params.providerSubId,
        },
      },
    });
  }

  // §9.10 SUBJECT BINDING: a provider subscription id maps to exactly ONE
  // commercial subject. A retried/late event may not silently REBIND the
  // stored row to a different user or workspace — fail closed instead.
  if (
    existing &&
    (existing.userId !== params.userId ||
      (existing.teamId ?? null) !== (params.teamId ?? null))
  ) {
    const err: Error & { statusCode?: number; code?: string } = new Error(
      "Provider subscription is bound to a different commercial subject"
    );
    err.statusCode = 409;
    err.code = "PROVIDER_SUBSCRIPTION_SUBJECT_MISMATCH";
    throw err;
  }

  const subscription = await prisma.subscription.upsert({
    where: {
      provider_providerSubId: {
        provider: params.provider,
        providerSubId: params.providerSubId,
      },
    },
    update: {
      status: params.status,
      plan: params.plan,
      currentPeriodEnd: params.currentPeriodEnd ?? null,
      teamId: params.teamId ?? null,
    },
    create: {
      userId: params.userId,
      provider: params.provider,
      providerSubId: params.providerSubId,
      status: params.status,
      plan: params.plan,
      currentPeriodEnd: params.currentPeriodEnd ?? null,
      teamId: params.teamId ?? null,
    },
  });

  await trackBillingEvent({
    eventType:
      params.status === prismaPkg.SubscriptionStatus.CANCELED
        ? "billing_subscription_canceled"
        : existing
          ? "billing_subscription_updated"
          : "billing_subscription_created",
    userId: params.userId,
    teamId: params.teamId ?? null,
    plan: params.plan,
    provider: params.provider,
    subscriptionStatus: params.status,
    metadata: {
      providerSubId: params.providerSubId,
      currentPeriodEnd: params.currentPeriodEnd
        ? params.currentPeriodEnd.toISOString()
        : null,
      previousStatus: existing?.status ?? null,
      previousPlan: existing?.plan ?? null,
    },
  });

  return subscription;
}

export async function upsertWorkspaceStorageAddon(params: {
  ownerUserId: string;
  teamId?: string | null;
  addonKey: prismaPkg.StorageAddonKey;
  billingCycle: prismaPkg.StorageAddonBillingCycle;
  status: prismaPkg.WorkspaceStorageAddonStatus;
  paymentProvider?: prismaPkg.PaymentProvider | null;
  externalSubscriptionId?: string | null;
  externalPaymentId?: string | null;
  currency?: string | null;
  amountCents?: number | null;
  currentPeriodEnd?: Date | null;
  expiresAtUtc?: Date | null;
  metadata?: Record<string, unknown> | null;
}) {
  /**
   * BILLING COMMERCIAL CORRECTNESS (2026-08-27) — BOTH cycles are writable
   * again, and the reason is not symmetry.
   *
   * This used to reject anything but ONE_TIME. A one-time payment cannot fund
   * perpetual storage, and nothing ever expired one: `expiresAtUtc` was
   * written `null` on every row and `WorkspaceStorageAddonStatus.EXPIRED` had
   * no writer anywhere in the codebase. A single €2.99 purchase therefore
   * granted 10 GB for ever — including after the base subscription was
   * cancelled — which is an unbounded liability sold as a top-up.
   *
   * New purchases are MONTHLY subscriptions. ONE_TIME remains writable ONLY so
   * that grandfathered rows can still be updated in place by their provider's
   * webhooks; no checkout path can create one any more.
   */
  const definition = getStorageAddonDefinition(params.addonKey);

  const existingBySubscription = params.externalSubscriptionId
    ? await prisma.workspaceStorageAddon.findUnique({
        where: {
          externalSubscriptionId: params.externalSubscriptionId,
        },
      })
    : null;

  const existingByPayment =
    !existingBySubscription && params.externalPaymentId
      ? await prisma.workspaceStorageAddon.findUnique({
          where: {
            externalPaymentId: params.externalPaymentId,
          },
        })
      : null;

  const existing = existingBySubscription ?? existingByPayment;

  const data = {
    ownerUserId: params.ownerUserId,
    teamId: params.teamId ?? null,
    addonKey: params.addonKey,
    extraStorageBytes: definition.storageBytes,
    // Honour the cycle the caller states. Hardcoding ONE_TIME here silently
    // rewrote a recurring add-on's own identity on every webhook update.
    billingCycle: params.billingCycle,
    status: params.status,
    paymentProvider: params.paymentProvider ?? null,
    externalSubscriptionId: params.externalSubscriptionId ?? null,
    externalPaymentId: params.externalPaymentId ?? null,
    currency: (params.currency ?? definition.currency).toUpperCase(),
    amountCents: params.amountCents ?? definition.priceCents,
    activatedAtUtc:
      params.status === prismaPkg.WorkspaceStorageAddonStatus.ACTIVE
        ? existing?.activatedAtUtc ?? new Date()
        : existing?.activatedAtUtc ?? null,
    // A recurring add-on HAS a period end; a grandfathered one-time row does
    // not. Hardcoding null erased the renewal date for every recurring row.
    currentPeriodEnd:
      params.billingCycle === prismaPkg.StorageAddonBillingCycle.MONTHLY
        ? params.currentPeriodEnd ?? existing?.currentPeriodEnd ?? null
        : null,
    expiresAtUtc: params.expiresAtUtc ?? null,
    canceledAtUtc:
      params.status === prismaPkg.WorkspaceStorageAddonStatus.CANCELED
        ? new Date()
        : null,
    metadata: toNullableJsonInput(params.metadata),
  };

  const addon = existing
    ? await prisma.workspaceStorageAddon.update({
        where: { id: existing.id },
        data,
      })
    : await prisma.workspaceStorageAddon.create({
        data,
      });

  await trackBillingEvent({
    eventType:
      params.status === prismaPkg.WorkspaceStorageAddonStatus.ACTIVE
        ? existing
          ? "billing_storage_addon_updated"
          : "billing_storage_addon_activated"
        : params.status === prismaPkg.WorkspaceStorageAddonStatus.PAST_DUE
          ? "billing_storage_addon_past_due"
          : params.status === prismaPkg.WorkspaceStorageAddonStatus.PENDING
            ? "billing_storage_addon_pending"
            : params.status === prismaPkg.WorkspaceStorageAddonStatus.CANCELED
              ? "billing_storage_addon_canceled"
              : params.status === prismaPkg.WorkspaceStorageAddonStatus.EXPIRED
                ? "billing_storage_addon_expired"
                : "billing_storage_addon_failed",
    userId: params.ownerUserId,
    teamId: params.teamId ?? null,
    provider: params.paymentProvider ?? null,
    metadata: {
      addonId: addon.id,
      addonKey: addon.addonKey,
      billingCycle: addon.billingCycle,
      extraStorageBytes: addon.extraStorageBytes.toString(),
      externalSubscriptionId: addon.externalSubscriptionId,
      externalPaymentId: addon.externalPaymentId,
      status: addon.status,
      currentPeriodEnd: addon.currentPeriodEnd?.toISOString() ?? null,
      expiresAtUtc: addon.expiresAtUtc?.toISOString() ?? null,
    },
  });

  return addon;
}

export async function cancelWorkspaceStorageAddon(params: {
  addonId: string;
  ownerUserId: string;
}) {
  const addon = await prisma.workspaceStorageAddon.findUnique({
    where: { id: params.addonId },
  });

  if (!addon) {
    const err: Error & { statusCode?: number } = new Error(
      "Storage addon not found"
    );
    err.statusCode = 404;
    throw err;
  }

  if (addon.ownerUserId !== params.ownerUserId) {
    const err: Error & { statusCode?: number } = new Error(
      "You are not allowed to manage this storage addon"
    );
    err.statusCode = 403;
    throw err;
  }

  const updated = await prisma.workspaceStorageAddon.update({
    where: { id: addon.id },
    data: {
      status: prismaPkg.WorkspaceStorageAddonStatus.CANCELED,
      canceledAtUtc: new Date(),
    },
  });

  await trackBillingEvent({
    eventType: "billing_storage_addon_canceled",
    userId: updated.ownerUserId,
    teamId: updated.teamId ?? null,
    provider: updated.paymentProvider ?? null,
    metadata: {
      addonId: updated.id,
      addonKey: updated.addonKey,
      externalSubscriptionId: updated.externalSubscriptionId,
      billingCycle: updated.billingCycle,
    },
  });

  return updated;
}

export async function syncTeamBillingSnapshot(params: {
  teamId: string;
  ownerUserId: string;
  plan: prismaPkg.PlanType;
  status: prismaPkg.TeamBillingStatus;
}) {
  if (params.plan === prismaPkg.PlanType.TEAM) {
    return activateTeamPlan({
      teamId: params.teamId,
      ownerUserId: params.ownerUserId,
      plan: prismaPkg.PlanType.TEAM,
      status: params.status,
    });
  }

  return cancelTeamPlan({
    teamId: params.teamId,
    ownerUserId: params.ownerUserId,
  });
}

/**
 * PHASE 12 POINT 4 PASS C — the ONE seat-limit policy.
 *
 * This rule was implemented twice with different behaviour: the canonical path
 * below counted ACTIVE members only (the P5 domain remediation) and treated
 * `includedSeats: 0` as unlimited, while the enterprise org-plan grant loop
 * recomputed it inline over ALL members with no zero-guard. A suspended or
 * revoked member therefore inflated the count on the provisioning path and
 * could mark a workspace over its seat limit when it was not — a false
 * commercial restriction, applied silently.
 *
 * Both callers now share this function so the two paths cannot diverge again.
 */
export function computeOverSeatLimit(input: {
  activeMemberCount: number;
  includedSeats: number;
}): boolean {
  // `includedSeats: 0` means "no seat ceiling", never "zero seats allowed".
  if (input.includedSeats <= 0) return false;
  return input.activeMemberCount > input.includedSeats;
}

export async function refreshTeamSeatState(teamId: string) {
  const team = await prisma.team.findUnique({
    where: { id: teamId },
    select: {
      id: true,
      ownerUserId: true,
      billingPlan: true,
      includedSeats: true,
      _count: {
        // P5 domain remediation (2026-07-21) — ACTIVE-only seat counting.
        select: { members: { where: { status: "ACTIVE" } } },
      },
    },
  });

  if (!team) return null;

  const overSeatLimit = computeOverSeatLimit({
    activeMemberCount: team._count.members,
    includedSeats: team.includedSeats,
  });

  const updated = await prisma.team.update({
    where: { id: teamId },
    data: {
      overSeatLimit,
    },
  });

  if (overSeatLimit) {
    await trackBillingEvent({
      eventType: "team_seat_limit_reached",
      userId: team.ownerUserId,
      teamId,
      plan: team.billingPlan,
      metadata: {
        memberCount: team._count.members,
        includedSeats: team.includedSeats,
      },
    });
  }

  return updated;
}

export async function markTeamBillingCanceled(
  teamId: string,
  ownerUserId: string
) {
  return cancelTeamPlan({
    teamId,
    ownerUserId,
  });
}