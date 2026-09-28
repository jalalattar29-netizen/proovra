/**
 * BILLING RESTART (2026-09-28) — undo a cancellation that is SCHEDULED for
 * period end, provider-first. Kept apart from the cancellation service, whose
 * contract is that it writes nothing to a subscription outside its one
 * provider-confirmed transaction.
 */

import * as prismaPkg from "@prisma/client";

import { prisma } from "../../db.js";
import { DomainError } from "../../errors.js";
import { stripeRequest } from "../stripe.service.js";


export type ResumeOutcome = {
  /** RESUMED: the provider confirmed renewal is back on. */
  result: "RESUMED" | "NOT_SCHEDULED_TO_END";
  provider: prismaPkg.PaymentProvider;
  currentPeriodEnd: string | null;
  /**
   * Storage add-ons already scheduled to end with the base plan are NOT
   * restarted: each is its own provider subscription, and silently renewing
   * one is a charge the customer did not ask for here.
   */
  dependentAddonsStillEnding: number;
};

/**
 * Restart ONE subscription whose cancellation is scheduled for period end.
 *
 * Only a provider that supports a period-end cancellation can undo one:
 * Stripe (`cancel_at_period_end=false`). A PayPal cancellation is immediate
 * and final at PayPal — there is nothing to restart — so it is refused with
 * that explanation, never faked with a local flag. The provider is asked
 * first; only what it confirms is recorded.
 */
export async function requestSubscriptionResume(input: {
  subscriptionId: string;
  now?: Date;
}): Promise<ResumeOutcome> {
  const now = input.now ?? new Date();
  const subscription = await prisma.subscription.findUnique({
    where: { id: input.subscriptionId },
    select: {
      id: true,
      provider: true,
      providerSubId: true,
      status: true,
      currentPeriodEnd: true,
      cancelAtPeriodEnd: true,
      canceledAtUtc: true,
      userId: true,
      teamId: true,
    },
  });
  if (!subscription) {
    throw new DomainError("Subscription not found", {
      httpStatus: 404,
      publicCode: "SUBSCRIPTION_NOT_FOUND",
      publicMessage: "There is no subscription to restart.",
      reportability: "EXPECTED_DENIAL",
      severity: "info",
    });
  }

  if (subscription.provider !== prismaPkg.PaymentProvider.STRIPE) {
    throw new DomainError("Provider cannot restart a cancellation", {
      httpStatus: 409,
      publicCode: "PROVIDER_CANNOT_RESTART",
      publicMessage:
        "PayPal ends a subscription as soon as it is cancelled, so it cannot be restarted. You keep your plan until the end of the period you paid for; after that you can subscribe again.",
      reportability: "EXPECTED_DENIAL",
      severity: "info",
      metadata: { provider: String(subscription.provider) },
    });
  }

  const live =
    subscription.status === prismaPkg.SubscriptionStatus.ACTIVE ||
    subscription.status === prismaPkg.SubscriptionStatus.PAST_DUE ||
    subscription.status === prismaPkg.SubscriptionStatus.TRIALING;
  if (!live || (subscription.currentPeriodEnd && subscription.currentPeriodEnd <= now)) {
    throw new DomainError("Subscription already ended", {
      httpStatus: 409,
      publicCode: "SUBSCRIPTION_ALREADY_ENDED",
      publicMessage: "This subscription has already ended. Start a new subscription instead.",
      reportability: "EXPECTED_DENIAL",
      severity: "info",
    });
  }

  if (!subscription.cancelAtPeriodEnd) {
    return {
      result: "NOT_SCHEDULED_TO_END",
      provider: subscription.provider,
      currentPeriodEnd: subscription.currentPeriodEnd?.toISOString() ?? null,
      dependentAddonsStillEnding: 0,
    };
  }

  let response: Record<string, unknown>;
  try {
    const body = new URLSearchParams();
    body.append("cancel_at_period_end", "false");
    response = await stripeRequest(`/subscriptions/${subscription.providerSubId}`, body, {
      idempotencyKey: `proovra-resume-${subscription.id}-${subscription.canceledAtUtc?.getTime() ?? 0}`,
    });
  } catch (cause) {
    throw Object.assign(
      new DomainError("Provider restart failed", {
        httpStatus: 502,
        publicCode: "PROVIDER_RESTART_FAILED",
        publicMessage:
          "We could not reach the payment provider to restart this subscription. Nothing has changed; it is still set to end.",
        reportability: "OPERATIONAL_WARNING",
        severity: "warning",
      }),
      { cause },
    );
  }
  if (response["cancel_at_period_end"] !== false || response["id"] !== subscription.providerSubId) {
    throw new DomainError("Provider did not confirm restart", {
      httpStatus: 502,
      publicCode: "PROVIDER_RESTART_FAILED",
      publicMessage:
        "The payment provider did not confirm the restart. Nothing has changed; it is still set to end.",
      reportability: "OPERATIONAL_WARNING",
      severity: "warning",
    });
  }
  const periodEnd = response["current_period_end"];
  const confirmedPeriodEnd =
    typeof periodEnd === "number" && Number.isFinite(periodEnd)
      ? new Date(periodEnd * 1000)
      : subscription.currentPeriodEnd;

  await prisma.subscription.update({
    where: { id: subscription.id },
    data: {
      cancelAtPeriodEnd: false,
      canceledAtUtc: null,
      ...(confirmedPeriodEnd ? { currentPeriodEnd: confirmedPeriodEnd } : {}),
    },
  });

  const dependentAddonsStillEnding = await prisma.workspaceStorageAddon.count({
    where: {
      ownerUserId: subscription.userId,
      dependentCancellationTriggeredBySubscriptionId: subscription.id,
      dependentCancellationState: { not: prismaPkg.DependentCancellationState.NONE },
      status: prismaPkg.WorkspaceStorageAddonStatus.ACTIVE,
    },
  });

  return {
    result: "RESUMED",
    provider: subscription.provider,
    currentPeriodEnd: confirmedPeriodEnd?.toISOString() ?? null,
    dependentAddonsStillEnding,
  };
}
