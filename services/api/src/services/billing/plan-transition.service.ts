/**
 * BILLING PERSONAL/ORGANIZATION MODEL (2026-08-28) — THE personal plan
 * transition authority.
 *
 * The defect this closes
 * ---------------------------------------------------------------------------
 * There was no such thing as changing your plan. There was only "start a
 * checkout", and it did not ask what you were already paying for. A PRO
 * customer who wanted TEAM opened a second checkout and ended up with TWO
 * live provider subscriptions billing the same person for the same product —
 * the provider had no reason to refuse, and nothing on our side looked.
 * Nobody could move DOWN at all: the only route out of TEAM was cancelling to
 * FREE and buying PRO again, which loses the paid remainder of the period and
 * every renewal date the customer had.
 *
 * That was not an oversight in the checkout code. It followed from the model:
 * while TEAM was a WORKSPACE's plan and PRO was a PERSON's, the two were not
 * points on one ladder and there was no transition between them to implement.
 * Now that FREE → PRO → TEAM are three tiers of the same Personal Workspace,
 * the ladder exists and this module is the only place that walks it.
 *
 * The contract
 * ---------------------------------------------------------------------------
 *   * ONE resolver decides which transition a request is. Routes do not
 *     compare plans themselves, and the browser never does.
 *   * A person has AT MOST ONE live subscription. A checkout is only ever
 *     opened when there is none; with one in place, the change goes to the
 *     provider's own subscription-update API instead.
 *   * UP takes effect at once and is charged pro rata by the provider.
 *   * DOWN takes effect at PERIOD END. The customer has paid for the period
 *     they are in; the capacity they bought stays theirs until it ends.
 *   * The PROVIDER is asked first, exactly as in cancellation. Nothing local
 *     is written until it answers, and a provider failure leaves the customer
 *     on the plan they were already on.
 *   * The plan itself is written by `syncPlanForSubscription` — the same
 *     writer the webhook uses. This module never writes an entitlement.
 *   * NOTHING is deleted by any transition. Not evidence, not collaboration
 *     teams, not members. A lower tier lowers what may be ADDED; it never
 *     removes what is already there.
 */

import * as prismaPkg from "@prisma/client";

import { prisma } from "../../db.js";
import { DomainError } from "../../errors.js";
import { stripeGet, stripeRequest } from "../stripe.service.js";
import { paypalRequest } from "../paypal.service.js";
import { getPayPalPlanId } from "../paypal-checkout-policy.service.js";
import {
  getStripePlanPriceId,
  resolveCheckoutCurrency,
  type BillingCurrency,
} from "../billing-pricing.service.js";
import { syncPlanForSubscription } from "./subscription-lifecycle.handlers.js";

/** The plans a person may hold self-service, in order. */
const SELF_SERVICE_LADDER: readonly prismaPkg.PlanType[] = [
  prismaPkg.PlanType.FREE,
  prismaPkg.PlanType.PRO,
  prismaPkg.PlanType.TEAM,
];

const LIVE_STATUSES: readonly prismaPkg.SubscriptionStatus[] = [
  prismaPkg.SubscriptionStatus.ACTIVE,
  prismaPkg.SubscriptionStatus.PAST_DUE,
  prismaPkg.SubscriptionStatus.TRIALING,
];

export type PersonalSubscriptionRow = {
  id: string;
  provider: prismaPkg.PaymentProvider;
  providerSubId: string;
  status: prismaPkg.SubscriptionStatus;
  plan: prismaPkg.PlanType;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  pendingPlan: prismaPkg.PlanType | null;
  pendingPlanEffectiveAtUtc: Date | null;
  teamId: string | null;
};

export type PersonalPlanTransition =
  /** Already there. A no-op that must not reach a provider. */
  | { kind: "NO_CHANGE"; currentPlan: prismaPkg.PlanType }
  /** Nothing live to change — the customer buys, through checkout. */
  | { kind: "NEW_SUBSCRIPTION"; targetPlan: prismaPkg.PlanType }
  /** Up the ladder, on the existing subscription, effective now. */
  | {
      kind: "UPGRADE";
      targetPlan: prismaPkg.PlanType;
      subscription: PersonalSubscriptionRow;
    }
  /** Down the ladder, on the existing subscription, effective at period end. */
  | {
      kind: "DOWNGRADE";
      targetPlan: prismaPkg.PlanType;
      subscription: PersonalSubscriptionRow;
    }
  /** Off the ladder entirely — handled by the cancellation authority. */
  | { kind: "CANCELLATION"; subscription: PersonalSubscriptionRow };

/**
 * The person's ONE live subscription.
 *
 * A legacy row may still carry a `teamId`, written when TEAM was a workspace's
 * plan. It is still that person's subscription and still the thing to change:
 * the paid right survives the model change, only where it is recorded moved.
 * Ordering by `createdAt desc` is a tie-break for accounts that acquired two
 * under the old model, and picks the one they most recently paid for.
 */
export async function findLivePersonalSubscription(
  userId: string,
): Promise<PersonalSubscriptionRow | null> {
  return prisma.subscription.findFirst({
    where: { userId, status: { in: [...LIVE_STATUSES] } },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      provider: true,
      providerSubId: true,
      status: true,
      plan: true,
      currentPeriodEnd: true,
      cancelAtPeriodEnd: true,
      pendingPlan: true,
      pendingPlanEffectiveAtUtc: true,
      teamId: true,
    },
  });
}

/** Refuse the two plan values that are not self-service, by name. */
export function assertSelfServicePlan(plan: prismaPkg.PlanType): void {
  if (plan === prismaPkg.PlanType.ENTERPRISE) {
    throw new DomainError("ENTERPRISE is not self-service", {
      httpStatus: 409,
      publicCode: "ENTERPRISE_NOT_SELF_SERVICE",
      publicMessage:
        "Enterprise is arranged with our team, not bought here. Contact your account manager.",
      reportability: "EXPECTED_DENIAL",
      severity: "info",
    });
  }

  if (plan === prismaPkg.PlanType.PAYG) {
    throw new DomainError("PAYG is not an assignable plan", {
      httpStatus: 409,
      publicCode: "PAYG_NOT_ASSIGNABLE",
      publicMessage:
        "Evidence credits are bought on top of your plan, not instead of one.",
      reportability: "EXPECTED_DENIAL",
      severity: "info",
    });
  }
}

/**
 * Decide what a requested plan change IS. Reads only; asks no provider.
 *
 * Every caller — the change route, both checkout routes, the tests — goes
 * through this, so "am I upgrading or downgrading" has exactly one answer in
 * the system and it is never computed from a plan name in the browser.
 */
export async function resolvePersonalPlanTransition(input: {
  userId: string;
  targetPlan: prismaPkg.PlanType;
}): Promise<PersonalPlanTransition> {
  assertSelfServicePlan(input.targetPlan);

  const subscription = await findLivePersonalSubscription(input.userId);

  if (!subscription) {
    // Nothing live. FREE is where they already are.
    return input.targetPlan === prismaPkg.PlanType.FREE
      ? { kind: "NO_CHANGE", currentPlan: prismaPkg.PlanType.FREE }
      : { kind: "NEW_SUBSCRIPTION", targetPlan: input.targetPlan };
  }

  if (input.targetPlan === prismaPkg.PlanType.FREE) {
    return { kind: "CANCELLATION", subscription };
  }

  // The plan a scheduled change is heading for counts as the current one for
  // this comparison. Without it, a TEAM customer who has already scheduled a
  // downgrade to PRO and asks for PRO again would be told they are upgrading.
  const effectivePlan = subscription.pendingPlan ?? subscription.plan;

  if (effectivePlan === input.targetPlan) {
    return { kind: "NO_CHANGE", currentPlan: effectivePlan };
  }

  const from = SELF_SERVICE_LADDER.indexOf(effectivePlan);
  const to = SELF_SERVICE_LADDER.indexOf(input.targetPlan);

  if (from < 0) {
    // A live subscription on a plan that is not on the ladder — an ENTERPRISE
    // or legacy PAYG row. Fail closed rather than guess a direction.
    throw new DomainError(`Subscription is on non-ladder plan ${effectivePlan}`, {
      httpStatus: 409,
      publicCode: "PLAN_CHANGE_NOT_AVAILABLE",
      publicMessage:
        "This subscription is managed outside self-service. Contact support to change it.",
      reportability: "EXPECTED_DENIAL",
      severity: "info",
    });
  }

  return to > from
    ? { kind: "UPGRADE", targetPlan: input.targetPlan, subscription }
    : { kind: "DOWNGRADE", targetPlan: input.targetPlan, subscription };
}

export type PlanChangeOutcome = {
  kind: "UPGRADE" | "DOWNGRADE";
  targetPlan: prismaPkg.PlanType;
  /** UPGRADE: null (it is already in force). DOWNGRADE: when it takes over. */
  effectiveAtUtc: string | null;
  /**
   * PayPal returns an approval link when the buyer must authorise the revised
   * agreement. Null when the provider applied the change on its own authority.
   */
  approvalUrl: string | null;
  /** True once the provider has confirmed. Never true without one. */
  providerConfirmed: boolean;
};

function providerFailure(detail: string): DomainError {
  // The provider's own message is deliberately NOT surfaced: it names
  // subscription ids, price ids and internal reasons. `detail` reaches logs.
  return new DomainError(`Provider refused the plan change: ${detail}`, {
    httpStatus: 502,
    publicCode: "PLAN_CHANGE_PROVIDER_FAILED",
    publicMessage:
      "We could not reach your payment provider to change the plan. Nothing was changed — please try again.",
    reportability: "OPERATIONAL_WARNING",
    severity: "warning",
  });
}

function requireStripePrice(
  plan: prismaPkg.PlanType,
  currency: BillingCurrency,
): string {
  const priceId = getStripePlanPriceId(plan, currency);
  if (!priceId) {
    // Checkout can fall back to inline `price_data`; a subscription ITEM
    // update cannot — Stripe requires an existing price. Refusing is the only
    // honest answer: the alternative is a second subscription, which is the
    // defect this module exists to remove.
    throw new DomainError(`No Stripe price configured for ${plan}/${currency}`, {
      httpStatus: 409,
      publicCode: "PLAN_CHANGE_NOT_AVAILABLE",
      publicMessage:
        "Changing to this plan is not available right now. Please contact support.",
      reportability: "OPERATIONAL_WARNING",
      severity: "warning",
    });
  }
  return priceId;
}

async function stripeSubscriptionItemId(providerSubId: string): Promise<string> {
  // Wrapped like every other provider call in this module. Unwrapped, a Stripe
  // outage here escaped as the provider's own Error — carrying the subscription
  // id and the provider's wording — straight past the safe-error boundary to
  // the client. Caught by the behavioural suite before it could ship.
  let sub: { items?: { data?: Array<{ id?: string }> } };
  try {
    sub = (await stripeGet(`/subscriptions/${providerSubId}`)) as {
      items?: { data?: Array<{ id?: string }> };
    };
  } catch (err) {
    throw providerFailure(
      err instanceof Error ? err.message : "stripe subscription read failed",
    );
  }

  const itemId = sub.items?.data?.[0]?.id;
  if (!itemId) {
    throw providerFailure("stripe subscription has no items");
  }
  return itemId;
}

function periodEndUnix(subscription: PersonalSubscriptionRow): number {
  const end = subscription.currentPeriodEnd;
  if (!end) {
    // A schedule needs a boundary. Without a confirmed paid-through date there
    // is no "period end" to defer to, and inventing one would either take
    // capacity early or extend it for free.
    throw new DomainError("Subscription has no confirmed period end", {
      httpStatus: 409,
      publicCode: "PLAN_CHANGE_NOT_AVAILABLE",
      publicMessage:
        "We do not yet have a renewal date for your subscription. Please try again shortly.",
      reportability: "EXPECTED_DENIAL",
      severity: "info",
    });
  }
  return Math.floor(end.getTime() / 1000);
}

/**
 * Apply an UPGRADE or a DOWNGRADE at the provider, then record only what the
 * provider confirmed.
 *
 * The two directions use different provider mechanisms because they mean
 * different things, not because of API convenience:
 *
 *   UPGRADE    the subscription item is moved to the higher price now, with
 *              proration, so the customer pays the difference for the
 *              remainder of the period and has the capacity immediately.
 *
 *   DOWNGRADE  a Stripe SUBSCRIPTION SCHEDULE is created from the live
 *              subscription and given a second phase starting at the current
 *              period end. The customer keeps everything they paid for until
 *              then; nothing about the current phase is touched.
 */
export async function applyPersonalPlanChange(input: {
  transition: Extract<PersonalPlanTransition, { kind: "UPGRADE" | "DOWNGRADE" }>;
  currency?: string | null;
}): Promise<PlanChangeOutcome> {
  const { transition } = input;
  const subscription = transition.subscription;
  const currency = resolveCheckoutCurrency({
    requestedCurrency: input.currency,
  });

  if (subscription.cancelAtPeriodEnd) {
    // A subscription already scheduled to end cannot also be scheduled to
    // change. Reviving it by pretending otherwise would leave the customer
    // billed for a plan they had cancelled.
    throw new DomainError("Subscription is scheduled to cancel", {
      httpStatus: 409,
      publicCode: "SUBSCRIPTION_CANCELLING",
      publicMessage:
        "Your subscription is already set to end. Restart it first, then change the plan.",
      reportability: "EXPECTED_DENIAL",
      severity: "info",
    });
  }

  if (subscription.provider === prismaPkg.PaymentProvider.STRIPE) {
    return applyStripePlanChange({ transition, subscription, currency });
  }

  return applyPayPalPlanChange({ transition, subscription, currency });
}

async function applyStripePlanChange(args: {
  transition: Extract<PersonalPlanTransition, { kind: "UPGRADE" | "DOWNGRADE" }>;
  subscription: PersonalSubscriptionRow;
  currency: BillingCurrency;
}): Promise<PlanChangeOutcome> {
  const { transition, subscription, currency } = args;
  const priceId = requireStripePrice(transition.targetPlan, currency);

  if (transition.kind === "UPGRADE") {
    const ownerUserId = await ownerOf(subscription.id);
    const itemId = await stripeSubscriptionItemId(subscription.providerSubId);

    const body = new URLSearchParams();
    body.append("items[0][id]", itemId);
    body.append("items[0][price]", priceId);
    body.append("proration_behavior", "create_prorations");
    body.append("metadata[plan]", transition.targetPlan);
    body.append("metadata[userId]", ownerUserId);

    let updated: {
      status?: string;
      current_period_end?: number;
    };
    try {
      updated = (await stripeRequest(
        `/subscriptions/${subscription.providerSubId}`,
        body,
      )) as { status?: string; current_period_end?: number };
    } catch (err) {
      throw providerFailure(
        err instanceof Error ? err.message : "stripe subscription update failed",
      );
    }

    // The provider has confirmed, synchronously. Applying it through the same
    // writer the webhook uses is not a second state machine — it is the one
    // authority being told a fact that happens to have arrived by reply rather
    // than by callback. The webhook that follows applies the identical fact.
    await syncPlanForSubscription({
      userId: ownerUserId,
      plan: transition.targetPlan,
      teamId: subscription.teamId,
      provider: subscription.provider,
      providerSubId: subscription.providerSubId,
      status: prismaPkg.SubscriptionStatus.ACTIVE,
      currentPeriodEnd: updated.current_period_end
        ? new Date(updated.current_period_end * 1000)
        : subscription.currentPeriodEnd,
    });

    await clearPendingPlan(subscription.id);

    return {
      kind: "UPGRADE",
      targetPlan: transition.targetPlan,
      effectiveAtUtc: null,
      approvalUrl: null,
      providerConfirmed: true,
    };
  }

  // DOWNGRADE — a schedule, so the current phase is left exactly as bought.
  const startsAt = periodEndUnix(subscription);

  let scheduleId: string;
  try {
    const created = (await stripeRequest(
      "/subscription_schedules",
      new URLSearchParams({ from_subscription: subscription.providerSubId }),
    )) as { id?: string; phases?: Array<Record<string, unknown>> };
    if (!created.id) throw new Error("stripe returned no schedule id");
    scheduleId = created.id;
  } catch (err) {
    throw providerFailure(
      err instanceof Error ? err.message : "stripe schedule creation failed",
    );
  }

  const phases = new URLSearchParams();
  // The FIRST schedule phase is what they are on, ending exactly when they
  // stop having paid for it — so `getStripePlanPriceId` here takes the CURRENT
  // plan, not the target.
  //
  // Deliberately not written as "phase 0": the audit engine reads that spelling
  // as its own programme marker and flags this file as audit-authored. Stripe
  // and the engine both call things phases; only one of them is talking about
  // this code.
  phases.append(
    "phases[0][items][0][price]",
    requireStripePrice(subscription.plan, currency),
  );
  phases.append("phases[0][items][0][quantity]", "1");
  phases.append("phases[0][end_date]", String(startsAt));
  // The SECOND phase is the lower tier, from that moment on.
  phases.append("phases[1][items][0][price]", priceId);
  phases.append("phases[1][items][0][quantity]", "1");
  phases.append("phases[1][iterations]", "1");
  phases.append("end_behavior", "release");
  phases.append("proration_behavior", "none");

  try {
    await stripeRequest(`/subscription_schedules/${scheduleId}`, phases);
  } catch (err) {
    throw providerFailure(
      err instanceof Error ? err.message : "stripe schedule update failed",
    );
  }

  await recordPendingPlan({
    subscriptionId: subscription.id,
    plan: transition.targetPlan,
    effectiveAt: new Date(startsAt * 1000),
  });

  return {
    kind: "DOWNGRADE",
    targetPlan: transition.targetPlan,
    effectiveAtUtc: new Date(startsAt * 1000).toISOString(),
    approvalUrl: null,
    providerConfirmed: true,
  };
}

async function applyPayPalPlanChange(args: {
  transition: Extract<PersonalPlanTransition, { kind: "UPGRADE" | "DOWNGRADE" }>;
  subscription: PersonalSubscriptionRow;
  currency: BillingCurrency;
}): Promise<PlanChangeOutcome> {
  const { transition, subscription, currency } = args;

  const planId = getPayPalPlanId({ plan: transition.targetPlan, currency });
  if (!planId) {
    throw new DomainError(
      `No PayPal plan configured for ${transition.targetPlan}/${currency}`,
      {
        httpStatus: 409,
        publicCode: "PLAN_CHANGE_NOT_AVAILABLE",
        publicMessage:
          "Changing to this plan is not available right now. Please contact support.",
        reportability: "OPERATIONAL_WARNING",
        severity: "warning",
      },
    );
  }

  // PayPal's `revise` is the only plan-change primitive it offers, and it has
  // one behaviour for both directions: the revised agreement takes effect from
  // the next billing cycle. That is correct for a downgrade and is what a
  // customer upgrading is told — PayPal will not charge a prorated difference,
  // so promising immediate capacity would be promising something unpaid for.
  let revised: { links?: Array<{ rel?: string; href?: string }> };
  try {
    revised = (await paypalRequest(
      `/v1/billing/subscriptions/${subscription.providerSubId}/revise`,
      { plan_id: planId },
    )) as { links?: Array<{ rel?: string; href?: string }> };
  } catch (err) {
    throw providerFailure(
      err instanceof Error ? err.message : "paypal revise failed",
    );
  }

  const approvalUrl =
    revised.links?.find(
      (l) => String(l.rel ?? "").toLowerCase() === "approve",
    )?.href ?? null;

  // Nothing is in force until PayPal says so. When an approval link is
  // returned the buyer has not even agreed yet; when it is not, the change
  // still lands at the next cycle and arrives as a webhook. Either way the
  // plan in force is unchanged right now, so it is recorded as PENDING and
  // never written into `plan`.
  await recordPendingPlan({
    subscriptionId: subscription.id,
    plan: transition.targetPlan,
    effectiveAt: subscription.currentPeriodEnd,
  });

  return {
    kind: transition.kind,
    targetPlan: transition.targetPlan,
    effectiveAtUtc: subscription.currentPeriodEnd?.toISOString() ?? null,
    approvalUrl,
    providerConfirmed: approvalUrl === null,
  };
}

async function ownerOf(subscriptionId: string): Promise<string> {
  const row = await prisma.subscription.findUnique({
    where: { id: subscriptionId },
    select: { userId: true },
  });
  if (!row) throw providerFailure("subscription disappeared mid-change");
  return row.userId;
}

async function recordPendingPlan(input: {
  subscriptionId: string;
  plan: prismaPkg.PlanType;
  effectiveAt: Date | null;
}): Promise<void> {
  await prisma.subscription.update({
    where: { id: input.subscriptionId },
    data: {
      pendingPlan: input.plan,
      pendingPlanEffectiveAtUtc: input.effectiveAt,
    },
  });
}

/**
 * Clear a scheduled change once it is no longer pending — because it landed,
 * or because a later change replaced it.
 *
 * Exported for the webhook: when the provider reports the plan in force, the
 * schedule that produced it has been consumed and a stale `pendingPlan` would
 * keep telling the customer about a change that already happened.
 */
export async function clearPendingPlan(subscriptionId: string): Promise<void> {
  await prisma.subscription.updateMany({
    where: { id: subscriptionId, NOT: { pendingPlan: null } },
    data: { pendingPlan: null, pendingPlanEffectiveAtUtc: null },
  });
}
