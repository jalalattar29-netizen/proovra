/**
 * BILLING RECONCILIATION (2026-08-27) — the shared subscription-lifecycle
 * handlers.
 *
 * WHY THIS FILE EXISTS
 * ---------------------------------------------------------------------------
 * `syncPlanForSubscription` and `storageAddonStatusFromSubscription` lived
 * inside `webhooks.routes.ts`. That was fine while a verified webhook was the
 * only way a provider fact could reach the domain. It is not fine now:
 * reconciliation learns the SAME facts by polling, and a second copy of "what
 * an ACTIVE TEAM subscription means" is exactly how the two paths come to
 * disagree about a customer's plan.
 *
 * The behaviour is moved, not rewritten. The webhook imports it from here and
 * calls it unchanged, so the verified path keeps its meaning and the polled
 * path cannot invent a different one.
 *
 * WHAT IS NOT HERE
 * ---------------------------------------------------------------------------
 * No provider parsing, no signature handling, no route concerns. This module
 * takes facts that have already been established — by a verified signature or
 * by an authenticated read we initiated — and applies the commercial
 * consequence.
 */

import * as prismaPkg from "@prisma/client";

// BILLING PERSONAL/ORGANIZATION MODEL (2026-08-28) — `activateTeamPlan` and
// `cancelTeamPlan` are no longer imported. They write a WORKSPACE's commercial
// columns, and a self-service subscription no longer has a workspace to write.
// They remain in `billing.service` for the Enterprise provisioning path, which
// legitimately does set an organization workspace's plan.
import { prisma } from "../../db.js";
import { setPersonalPlan, upsertSubscription } from "../billing.service.js";

/** Members audit ENT-12 — a provider fact changed the plan; the audit names the subscription. */
const WEBHOOK_PLAN_ORIGIN = (providerSubId: string) => ({
  actorUserId: null,
  serviceActor: "billing_provider_webhook",
  providerSubId,
});
import { SELF_SERVICE_BASE_SUBSCRIPTION_PLANS } from "./base-subscription.service.js";
import { recordBillingReviewItem } from "./billing-review.service.js";
import {
  cancelSupersededSubscriptionAtProvider,
  type SupersededCanceller,
} from "./base-subscription-supersession.service.js";

/**
 * The add-on status a provider subscription status implies.
 *
 * Exhaustive over `SubscriptionStatus` on purpose: a new provider status added
 * to the enum should fail the build here rather than silently fall through to
 * "leave it active", which is the disposition that keeps an orphan charging.
 */
export function storageAddonStatusFromSubscription(
  status: prismaPkg.SubscriptionStatus,
): prismaPkg.WorkspaceStorageAddonStatus {
  switch (status) {
    case prismaPkg.SubscriptionStatus.ACTIVE:
      return prismaPkg.WorkspaceStorageAddonStatus.ACTIVE;
    case prismaPkg.SubscriptionStatus.TRIALING:
      return prismaPkg.WorkspaceStorageAddonStatus.PENDING;
    case prismaPkg.SubscriptionStatus.PAST_DUE:
      return prismaPkg.WorkspaceStorageAddonStatus.PAST_DUE;
    case prismaPkg.SubscriptionStatus.CANCELED:
      return prismaPkg.WorkspaceStorageAddonStatus.CANCELED;
  }
}

export type SyncPlanOutcome =
  /** The fact was recorded; the entitlement follows it (or needed no change). */
  | { outcome: "APPLIED"; subscriptionId: string; status: prismaPkg.SubscriptionStatus }
  /**
   * BILLING PAYPAL INTEGRITY (2026-09-28) — this subscription became ACTIVE
   * while ANOTHER base subscription was already live for the same payer (an
   * approval the buyer completed after abandoning it, next to a plan bought
   * since). It is recorded as the provider states it, it grants nothing, and
   * PROOVRA asks the provider to cancel it; the charge is recorded for refund
   * review. Whichever wrote last no longer decides the customer's plan.
   */
  | {
      outcome: "SUPERSEDED";
      subscriptionId: string;
      keptSubscriptionId: string;
      canceledAtProvider: boolean;
    };

type ActivationClient = prismaPkg.Prisma.TransactionClient;

/**
 * Apply ONE established subscription fact to the canonical plan state.
 *
 * Shared by every path that learns a subscription fact (verified webhooks,
 * authenticated return routes, per-attempt re-check, account re-check and the
 * sweep), so none of them can mean something different by ACTIVE.
 * `upsertSubscription` owns the monotonic ordering rules.
 *
 * BILLING PAYPAL INTEGRITY (2026-09-28) — a NEW activation is decided under a
 * per-payer advisory lock: two activations racing (a late PayPal approval and
 * a card checkout) are serialised, so exactly one becomes the entitlement and
 * the other is superseded rather than "last writer wins".
 */
export async function syncPlanForSubscription(params: {
  userId: string;
  plan: prismaPkg.PlanType;
  teamId?: string | null;
  provider: prismaPkg.PaymentProvider;
  providerSubId: string;
  status: prismaPkg.SubscriptionStatus;
  currentPeriodEnd?: Date | null;
  observedAtUtc?: Date | null;
  /** Provider-billed currency / unit amount, when this fact carries them. */
  billedCurrency?: string | null;
  billedUnitAmountCents?: number | null;
  /** The provider's own "will stop renewing". Undefined = this fact does not say. */
  cancelAtPeriodEnd?: boolean;
  /** Stripe: the schedule managing it. Undefined = this fact does not say. */
  providerScheduleId?: string | null;
  /** Injected by tests; production cancels through the real provider client. */
  cancelSupersededAtProvider?: SupersededCanceller;
}): Promise<SyncPlanOutcome> {
  const write = (client: ActivationClient | typeof prisma = prisma) =>
    upsertSubscription(
      {
        userId: params.userId,
        provider: params.provider,
        providerSubId: params.providerSubId,
        status: params.status,
        plan: params.plan,
        currentPeriodEnd: params.currentPeriodEnd ?? null,
        teamId: params.teamId ?? null,
        observedAtUtc: params.observedAtUtc ?? null,
        billedCurrency: params.billedCurrency ?? null,
        billedUnitAmountCents: params.billedUnitAmountCents ?? null,
        cancelAtPeriodEnd: params.cancelAtPeriodEnd,
        providerScheduleId: params.providerScheduleId,
      },
      client,
    );

  if (params.status === prismaPkg.SubscriptionStatus.ACTIVE) {
    const decided = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtext(${`billing-base-activation:${params.userId}`}))
      `;
      const before = await tx.subscription.findUnique({
        where: {
          provider_providerSubId: { provider: params.provider, providerSubId: params.providerSubId },
        },
        select: { id: true, status: true, supersededBySubscriptionId: true },
      });
      const wasLive =
        before?.status === prismaPkg.SubscriptionStatus.ACTIVE ||
        before?.status === prismaPkg.SubscriptionStatus.PAST_DUE;
      const otherLive = wasLive
        ? null
        : await tx.subscription.findFirst({
            where: {
              userId: params.userId,
              plan: { in: [...SELF_SERVICE_BASE_SUBSCRIPTION_PLANS] },
              providerSubId: { not: "" },
              supersededBySubscriptionId: null,
              NOT: [
                { provider: params.provider, providerSubId: params.providerSubId },
                // A provider-confirmed IMMEDIATE cancellation (PayPal) whose
                // webhook has not landed yet is already over; it is not a
                // live entitlement that could make this one a duplicate.
                { canceledAtUtc: { not: null }, cancelAtPeriodEnd: false },
              ],
              status: {
                in: [prismaPkg.SubscriptionStatus.ACTIVE, prismaPkg.SubscriptionStatus.PAST_DUE],
              },
            },
            orderBy: { createdAt: "asc" },
            select: { id: true },
          });
      const subscription = await write(tx);
      // BILLING REMEDIATION (2026-10-30, AUD-12) — the decision is durable, and
      // written under the lock. It used to live only in this call: a failed
      // provider cancel left a duplicate no later fact recognised as one, so
      // the next ACTIVE read it as already live and took over the plan.
      if (otherLive && !before?.supersededBySubscriptionId && subscription.status === prismaPkg.SubscriptionStatus.ACTIVE) {
        await tx.subscription.update({
          where: { id: subscription.id },
          data: {
            supersededBySubscriptionId: otherLive.id,
            supersessionCancelState: "PENDING",
            supersessionCancelNextRetryAtUtc: new Date(),
          },
        });
      }
      return { subscription, otherLive, supersededBy: before?.supersededBySubscriptionId ?? null };
    });

    const { subscription, otherLive, supersededBy } = decided;
    if (subscription.status !== prismaPkg.SubscriptionStatus.ACTIVE) {
      // The ordering rules refused the fact (older than what is recorded).
      return { outcome: "APPLIED", subscriptionId: subscription.id, status: subscription.status };
    }
    if (supersededBy) {
      // Already decided. The cancel is the retry worker's; this fact grants nothing.
      return {
        outcome: "SUPERSEDED",
        subscriptionId: subscription.id,
        keptSubscriptionId: supersededBy,
        canceledAtProvider: false,
      };
    }
    if (otherLive) {
      const canceledAtProvider = await supersede({
        userId: params.userId,
        provider: params.provider,
        providerSubId: params.providerSubId,
        plan: params.plan,
        keptSubscriptionId: otherLive.id,
        cancel: params.cancelSupersededAtProvider ?? cancelSupersededSubscriptionAtProvider,
      });
      return {
        outcome: "SUPERSEDED",
        subscriptionId: subscription.id,
        keptSubscriptionId: otherLive.id,
        canceledAtProvider,
      };
    }
    await setPersonalPlan(params.userId, subscription.plan, WEBHOOK_PLAN_ORIGIN(params.providerSubId));
    return { outcome: "APPLIED", subscriptionId: subscription.id, status: subscription.status };
  }

  // BILLING CHECKOUT ATTEMPTS (2026-09-28) — what this subscription was
  // BEFORE this fact, so a cancellation can tell whether it ever carried the
  // entitlement it would take away.
  const before = await prisma.subscription.findUnique({
    where: {
      provider_providerSubId: {
        provider: params.provider,
        providerSubId: params.providerSubId,
      },
    },
    select: { status: true, activatedAtUtc: true, supersededBySubscriptionId: true },
  });

  const subscription = await write();
  const applied = { outcome: "APPLIED" as const, subscriptionId: subscription.id, status: subscription.status };

  // TEAM is a PERSONAL tier (BILLING PERSONAL/ORGANIZATION MODEL, 2026-08-28):
  // PRO and TEAM take the same path and differ only in the plan value. A
  // legacy row still carrying a `teamId` is applied to its owner's personal
  // entitlement rather than dropped.

  if (subscription.status === prismaPkg.SubscriptionStatus.CANCELED) {
    /*
     * A cancellation removes only the entitlement THIS subscription granted:
     *
     *   * never activated (no prior row, or the prior row was TRIALING):
     *     it granted nothing, so it takes nothing away;
     *   * another self-service base subscription is still ACTIVE/PAST_DUE:
     *     that one is the entitlement now, and is left in force;
     *   * otherwise the paid access this subscription carried ends: FREE.
     */
    const everCarriedEntitlement =
      before !== null &&
      !before.supersededBySubscriptionId &&
      (before.activatedAtUtc !== null ||
        before.status === prismaPkg.SubscriptionStatus.ACTIVE ||
        before.status === prismaPkg.SubscriptionStatus.PAST_DUE);
    if (!everCarriedEntitlement) return applied;

    const otherLive = await prisma.subscription.findFirst({
      where: {
        userId: params.userId,
        id: { not: subscription.id },
        plan: { in: [...SELF_SERVICE_BASE_SUBSCRIPTION_PLANS] },
        supersededBySubscriptionId: null,
        status: {
          in: [
            prismaPkg.SubscriptionStatus.ACTIVE,
            prismaPkg.SubscriptionStatus.PAST_DUE,
          ],
        },
      },
      orderBy: { updatedAt: "desc" },
      select: { id: true, plan: true },
    });
    if (otherLive) {
      // The surviving subscription is the entitlement. Only when the plan in
      // force was THIS subscription's does it move to the survivor's; a granted
      // or differently-sourced plan is left exactly as it is.
      if (otherLive.plan !== subscription.plan) {
        const entitlement = await prisma.entitlement.findFirst({
          where: { userId: params.userId, active: true },
          orderBy: { createdAt: 'desc' },
          select: { plan: true },
        });
        if (entitlement?.plan === subscription.plan) {
          await setPersonalPlan(params.userId, otherLive.plan, WEBHOOK_PLAN_ORIGIN(params.providerSubId));
        }
      }
      return applied;
    }

    await setPersonalPlan(params.userId, prismaPkg.PlanType.FREE, WEBHOOK_PLAN_ORIGIN(params.providerSubId));
  }

  return applied;
}

/** Minutes after a failed attempt, indexed by attempts made; then daily, for ever. */
export const SUPERSESSION_RETRY_MINUTES = [5, 30, 120, 720] as const;

/**
 * BILLING REMEDIATION (2026-10-30, AUD-12) — keep asking the provider to stop
 * every superseded duplicate it has not confirmed stopping. A duplicate bills
 * the customer every period, so this never gives up: after the fast schedule it
 * is MANUAL_INTERVENTION, still retried daily, and the review item stays open.
 * The state column is the lease: only one worker's compare-and-set matches.
 */
export async function retrySupersededCancellations(input: {
  limit?: number;
  now?: Date;
  cancel?: SupersededCanceller;
} = {}): Promise<{ attempted: number; confirmed: number }> {
  const now = input.now ?? new Date();
  const cancel = input.cancel ?? cancelSupersededSubscriptionAtProvider;
  const due = await prisma.subscription.findMany({
    where: {
      supersededBySubscriptionId: { not: null },
      supersessionCancelState: { in: ["PENDING", "RETRY_SCHEDULED", "MANUAL_INTERVENTION"] },
      supersessionCancelNextRetryAtUtc: { lte: now },
    },
    orderBy: { supersessionCancelNextRetryAtUtc: "asc" },
    take: input.limit ?? 20,
    select: {
      id: true,
      userId: true,
      provider: true,
      providerSubId: true,
      plan: true,
      status: true,
      supersessionCancelState: true,
      supersessionCancelAttemptCount: true,
      supersessionCancelNextRetryAtUtc: true,
    },
  });
  let attempted = 0;
  let confirmed = 0;
  for (const row of due) {
    const attemptCount = row.supersessionCancelAttemptCount + 1;
    const delay = SUPERSESSION_RETRY_MINUTES[attemptCount - 1] ?? 24 * 60;
    const claimed = await prisma.subscription.updateMany({
      where: {
        id: row.id,
        supersessionCancelState: row.supersessionCancelState,
        supersessionCancelNextRetryAtUtc: row.supersessionCancelNextRetryAtUtc,
      },
      data: {
        supersessionCancelAttemptCount: attemptCount,
        supersessionCancelNextRetryAtUtc: new Date(now.getTime() + delay * 60_000),
      },
    });
    if (claimed.count !== 1) continue;
    attempted += 1;
    if (row.status === prismaPkg.SubscriptionStatus.CANCELED) {
      await prisma.subscription.update({
        where: { id: row.id },
        data: { supersessionCancelState: "CONFIRMED", supersessionCancelNextRetryAtUtc: null },
      });
      confirmed += 1;
      continue;
    }
    let result: Awaited<ReturnType<SupersededCanceller>>;
    try {
      result = await cancel(row.provider, row.providerSubId);
    } catch {
      result = { canceled: false, observedAtUtc: null };
    }
    if (!result.canceled) {
      await prisma.subscription.update({
        where: { id: row.id },
        data: {
          supersessionCancelState:
            attemptCount > SUPERSESSION_RETRY_MINUTES.length ? "MANUAL_INTERVENTION" : "RETRY_SCHEDULED",
        },
      });
      continue;
    }
    await upsertSubscription({
      userId: row.userId,
      provider: row.provider,
      providerSubId: row.providerSubId,
      status: prismaPkg.SubscriptionStatus.CANCELED,
      plan: row.plan,
      observedAtUtc: result.observedAtUtc,
    }).catch(() => undefined);
    await prisma.subscription.update({
      where: { id: row.id },
      data: { supersessionCancelState: "CONFIRMED", supersessionCancelNextRetryAtUtc: null },
    });
    await recordBillingReviewItem({
      userId: row.userId,
      provider: row.provider,
      providerResourceId: row.providerSubId,
      product: "PLAN",
      reason: "DUPLICATE_BASE_SUBSCRIPTION",
      providerAction: "CANCELED_AT_PROVIDER",
      refundReviewRequired: true,
      detail: { supersededPlan: row.plan, retriedAttempts: attemptCount },
    });
    confirmed += 1;
  }
  return { attempted, confirmed };
}

/**
 * Cancel a superseded base subscription at its provider and record the case.
 * Returns whether the provider confirmed the cancellation. Never throws: a
 * provider failure is recorded (CANCEL_FAILED) and surfaced for review, and
 * the entitlement is still not granted from the duplicate.
 */
async function supersede(input: {
  userId: string;
  provider: prismaPkg.PaymentProvider;
  providerSubId: string;
  plan: prismaPkg.PlanType;
  keptSubscriptionId: string;
  cancel: SupersededCanceller;
}): Promise<boolean> {
  let result: Awaited<ReturnType<SupersededCanceller>>;
  try {
    result = await input.cancel(input.provider, input.providerSubId);
  } catch {
    result = { canceled: false, observedAtUtc: null };
  }
  if (result.canceled) {
    await upsertSubscription({
      userId: input.userId,
      provider: input.provider,
      providerSubId: input.providerSubId,
      status: prismaPkg.SubscriptionStatus.CANCELED,
      plan: input.plan,
      observedAtUtc: result.observedAtUtc,
    }).catch(() => undefined);
  }
  await prisma.subscription.updateMany({
    where: { provider: input.provider, providerSubId: input.providerSubId },
    data: result.canceled
      ? { supersessionCancelState: "CONFIRMED", supersessionCancelNextRetryAtUtc: null, supersessionCancelAttemptCount: 1 }
      : {
          supersessionCancelState: "RETRY_SCHEDULED",
          supersessionCancelAttemptCount: 1,
          supersessionCancelNextRetryAtUtc: new Date(Date.now() + SUPERSESSION_RETRY_MINUTES[0]! * 60_000),
        },
  });
  await recordBillingReviewItem({
    userId: input.userId,
    provider: input.provider,
    providerResourceId: input.providerSubId,
    product: "PLAN",
    reason: "DUPLICATE_BASE_SUBSCRIPTION",
    providerAction: result.canceled ? "CANCELED_AT_PROVIDER" : "CANCEL_FAILED",
    // The provider charged the first period when it activated the duplicate.
    refundReviewRequired: true,
    detail: {
      keptSubscriptionId: input.keptSubscriptionId,
      supersededPlan: input.plan,
    },
  });
  return result.canceled;
}
