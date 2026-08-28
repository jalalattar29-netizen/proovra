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
  // ===========================================================================
  // BILLING PERSONAL/ORGANIZATION MODEL (2026-08-28) — TEAM IS A PERSONAL PLAN.
  // ===========================================================================
  //
  // This function used to refuse TEAM outright, with the code
  // `TEAM_NOT_ALLOWED_FOR_PERSONAL_WORKSPACE`. That single line was where the
  // obsolete model was codified: it made TEAM unreachable on the workspace a
  // customer actually works in, so buying it meant creating a SECOND workspace
  // and leaving your evidence behind in the first.
  //
  // The product model has exactly two context kinds — PERSONAL and
  // ORGANIZATION — and the self-service progression FREE → PRO → TEAM applies
  // to the same Personal Workspace throughout. TEAM is a tier, not a place.
  //
  // PAYG is still refused, and that refusal is unrelated: it is a legacy
  // resolution row, never an assignable plan. ENTERPRISE is refused too — it is
  // an Organization contract, provisioned by Sales, and a personal entitlement
  // claiming it would be a self-service Enterprise grant.
  if (plan === prismaPkg.PlanType.ENTERPRISE) {
    const err: Error & { statusCode?: number; code?: string } = new Error(
      "ENTERPRISE is an Organization contract, not a personal plan"
    );
    err.statusCode = 409;
    err.code = "ENTERPRISE_NOT_SELF_SERVICE";
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

// BILLING PERSONAL/ORGANIZATION MODEL (2026-08-28) — `activateTeamPlan` was
// DELETED, with zero-consumer proof.
//
// After TEAM became a tier of the Personal Workspace, its only remaining
// caller was the DEV-ONLY plan route, which is 403'd in production — the
// capability analyzer classified the write as MODULE_SCOPED rather than
// route-attributed, which is the map's way of saying "no production path
// reaches this". Enterprise provisioning does not use it either: that service
// writes `billingPlan` on its own `team.create`/`team.update`, in three
// places, and always has.
//
// A workspace's commercial columns are therefore written by exactly one thing
// now — Enterprise provisioning — which is the only remaining reason a
// workspace has a plan at all.

// BILLING PERSONAL/ORGANIZATION MODEL (2026-08-28) — `cancelTeamPlan` was
// DELETED, with zero-consumer proof.
//
// Its only live caller was the webhook's TEAM branch, which applied a cancelled
// TEAM subscription to a WORKSPACE's billing columns. TEAM is now a tier of the
// Personal Workspace, so a cancellation writes the personal entitlement and
// there is no workspace state to clear. `workspace-closure.service.ts` never
// called it, and no other module did.
//
// The safety property it carried — a billing cancellation deletes no Evidence
// and purges no memberships — is NOT retired with it: the assertion moves to
// `activateTeamPlan`, which survives for Enterprise provisioning and writes the
// same columns. See `phase-9-commercial-invariants.test.ts`.

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
      // BILLING PERSONAL/ORGANIZATION MODEL (2026-08-28) — read so a landed
      // schedule can be cleared below.
      pendingPlan: true,
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
      // BILLING PERSONAL/ORGANIZATION MODEL (2026-08-28) — a SCHEDULED plan
      // change is cleared the moment it stops being in the future.
      //
      // Two ways that happens, and both are the provider telling us: the
      // scheduled plan is now the plan in force, or the subscription ended
      // before it could be. A `pendingPlan` left behind after either would
      // keep the Billing page promising a change that has already happened or
      // can no longer happen — the second being the worse of the two, since it
      // would tell someone who has cancelled that they are moving to Pro next
      // month.
      //
      // It is cleared HERE, in the one writer every provider fact passes
      // through, rather than by whichever caller happened to notice. This
      // function is not the place that decides a plan change; it is the place
      // that records what the provider says is true, and "the schedule is no
      // longer pending" is part of that same statement.
      ...(existing?.pendingPlan &&
      (existing.pendingPlan === params.plan ||
        params.status === prismaPkg.SubscriptionStatus.CANCELED)
        ? { pendingPlan: null, pendingPlanEffectiveAtUtc: null }
        : {}),
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

// BILLING PERSONAL/ORGANIZATION MODEL (2026-08-28) — `syncTeamBillingSnapshot`
// was DELETED. Zero consumers. It branched on `plan === TEAM` to activate or
// cancel a WORKSPACE's commercial state — the obsolete model exactly: a TEAM
// subscription no longer has a workspace whose state it could sync.

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

// BILLING PERSONAL/ORGANIZATION MODEL (2026-08-28) — `markTeamBillingCanceled`
// was DELETED. Zero consumers: a one-line wrapper over `cancelTeamPlan` that
// nothing outside this file ever called.
