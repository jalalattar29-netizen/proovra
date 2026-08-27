/**
 * BILLING COMMERCIAL CORRECTNESS (2026-08-27) — THE cancellation contract.
 *
 * The defects this closes
 * ---------------------------------------------------------------------------
 * 1. THE UI LIED ABOUT THE LIFECYCLE. The confirmation modal said "paid TEAM
 *    capability ends at the current period", and the route then called Stripe's
 *    `DELETE /subscriptions/{id}` — immediate termination — and immediately
 *    wrote `setPersonalPlan(FREE)` / `cancelTeamPlan`. A customer who cancelled
 *    mid-period lost access instantly, having been told otherwise, with no
 *    refund of the remainder.
 *
 * 2. PAYPAL COULD KEEP BILLING AFTER A "SUCCESSFUL" CANCELLATION. The PayPal
 *    branch wrapped `cancelPayPalSubscription` in try/catch and, on failure,
 *    logged a warning and CARRIED ON to write the local row as CANCELED. The
 *    app then reported a cancelled subscription that PayPal was still charging.
 *    That is the worst possible failure mode for a billing system: silent, and
 *    on the money.
 *
 * 3. LOCAL STATE LED THE PROVIDER. Even on Stripe, the local row was written
 *    before any webhook confirmed anything, so a provider-side failure after
 *    the HTTP call left the two permanently disagreeing.
 *
 * The contract
 * ---------------------------------------------------------------------------
 *   * The PROVIDER is asked first. Nothing local is written until it answers.
 *   * A provider failure produces a safe error and leaves the subscription
 *     ACTIVE. There is no local-only fallback, for either provider, ever.
 *   * Where the provider supports it (Stripe), cancellation is scheduled at
 *     PERIOD END: access runs to the confirmed `currentPeriodEnd`, the row is
 *     marked `cancelAtPeriodEnd`, and `status` stays ACTIVE.
 *   * Where it does not (PayPal, whose subscription cancel is immediate), the
 *     caller is told so BEFORE it happens and the outcome says `IMMEDIATE`.
 *   * The terminal CANCELED transition is written by the WEBHOOK, which is the
 *     provider's own statement about its own state. This service never writes
 *     it.
 *   * Repeating the request is safe: an already-scheduled cancellation returns
 *     the same outcome instead of a second provider call.
 */

import * as prismaPkg from "@prisma/client";

import { prisma } from "../../db.js";
import { DomainError } from "../../errors.js";
import { stripeRequest } from "../stripe.service.js";
import { cancelPayPalSubscription } from "../paypal.service.js";
import { cancelDependentRecurringAddons } from "./storage-addon-dependency.service.js";

/**
 * What a provider can actually do, stated per provider rather than assumed.
 *
 *   PERIOD_END  the subscription is flagged to stop renewing; access continues
 *               to the paid-through date.
 *   IMMEDIATE   the provider terminates the subscription now. Only used when
 *               the provider offers nothing else.
 */
export type CancellationMode = "PERIOD_END" | "IMMEDIATE";

export function cancellationModeForProvider(
  provider: prismaPkg.PaymentProvider,
): CancellationMode {
  // Stripe supports `cancel_at_period_end`. PayPal's
  // `/v1/billing/subscriptions/{id}/cancel` has no period-end option — it ends
  // the agreement — so the product must SAY "immediate" rather than promise a
  // period end it cannot deliver.
  return provider === prismaPkg.PaymentProvider.STRIPE
    ? "PERIOD_END"
    : "IMMEDIATE";
}

export type CancellationOutcome = {
  mode: CancellationMode;
  /** Provider-confirmed end of access. Null when the provider gave no date. */
  accessEndsAtUtc: string | null;
  /** True once the provider has confirmed the scheduled cancellation. */
  cancelAtPeriodEnd: boolean;
  /** The local status AFTER this call. Never CANCELED — that is the webhook's. */
  status: prismaPkg.SubscriptionStatus;
  /** True when the request was a no-op because it was already scheduled. */
  alreadyScheduled: boolean;
  /**
   * BILLING RECONCILIATION (2026-08-27) — what happened to the recurring
   * Storage add-ons that depend on this subscription.
   *
   * A recurring add-on is its own provider subscription. Cancelling the base
   * plan used to do nothing to it, so the provider kept charging for storage
   * attached to a plan the customer no longer had. `dependentAddonsFailed > 0`
   * means something is STILL CHARGING and the caller must say so rather than
   * report a clean cancellation.
   */
  dependentAddonsFound: number;
  dependentAddonsScheduled: number;
  dependentAddonsFailed: number;
};

function providerFailure(provider: prismaPkg.PaymentProvider): DomainError {
  return new DomainError(`Provider cancellation failed for ${provider}`, {
    httpStatus: 502,
    publicCode: "PROVIDER_CANCELLATION_FAILED",
    publicMessage:
      "We could not reach the payment provider to cancel this subscription. Nothing has changed and you have not been charged again — please try again shortly.",
    reportability: "OPERATIONAL_WARNING",
    severity: "warning",
    metadata: { provider: String(provider) },
  });
}

/**
 * Request cancellation of ONE subscription.
 *
 * The caller must ALREADY have authorized the subject (`BILLING_CANCEL` on the
 * billing account this subscription belongs to). This service does not
 * authorize; it performs the provider interaction and records only what the
 * provider confirmed.
 */
export async function requestSubscriptionCancellation(input: {
  subscriptionId: string;
}): Promise<CancellationOutcome> {
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
      publicMessage: "There is no active subscription to cancel.",
      reportability: "EXPECTED_DENIAL",
      severity: "info",
    });
  }

  const mode = cancellationModeForProvider(subscription.provider);

  // Idempotent repeat. A second request must not produce a second provider
  // call, and must not produce a conflicting state.
  //
  // BILLING PRODUCTION CLOSURE (2026-08-27) — `canceledAtUtc` joins the guard.
  // `cancelAtPeriodEnd` is now false for an IMMEDIATE provider, so it can no
  // longer stand alone: a second PayPal cancel would otherwise reach the
  // provider again, and PayPal refuses to cancel an already-cancelled
  // subscription — turning a harmless double click into a "we could not reach
  // your payment provider" error about a cancellation that had already
  // succeeded.
  if (subscription.cancelAtPeriodEnd || subscription.canceledAtUtc) {
    // A repeat is where a PREVIOUS partial failure gets its retry: the base
    // subscription is already scheduled, but a dependent add-on may still be
    // charging because its provider call failed last time. Cancelling the
    // dependants again is safe — each is provider-first and idempotent — and
    // it is the only way a customer can clear an ACTION_REQUIRED themselves.
    const retry = await cancelDependentRecurringAddons({
      ownerUserId: subscription.userId,
      teamId: subscription.teamId,
      mode,
    });
    return {
      mode,
      accessEndsAtUtc: subscription.cancelAtPeriodEnd
        ? subscription.currentPeriodEnd?.toISOString() ?? null
        : null,
      cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
      status: subscription.status,
      alreadyScheduled: true,
      dependentAddonsFound: retry.found,
      dependentAddonsScheduled: retry.scheduled,
      dependentAddonsFailed: retry.failed,
    };
  }

  if (subscription.status === prismaPkg.SubscriptionStatus.CANCELED) {
    // Same retry reasoning as above: a terminally cancelled base plan with a
    // live dependent add-on is exactly the orphan this closes.
    const retry = await cancelDependentRecurringAddons({
      ownerUserId: subscription.userId,
      teamId: subscription.teamId,
      mode,
    });
    return {
      mode,
      accessEndsAtUtc: subscription.currentPeriodEnd?.toISOString() ?? null,
      cancelAtPeriodEnd: false,
      status: prismaPkg.SubscriptionStatus.CANCELED,
      alreadyScheduled: true,
      dependentAddonsFound: retry.found,
      dependentAddonsScheduled: retry.scheduled,
      dependentAddonsFailed: retry.failed,
    };
  }

  // ---- Ask the provider FIRST -------------------------------------------
  let confirmedPeriodEnd: Date | null = subscription.currentPeriodEnd ?? null;

  if (subscription.provider === prismaPkg.PaymentProvider.STRIPE) {
    // `POST /subscriptions/{id}` with `cancel_at_period_end=true`, NOT
    // `DELETE`. The previous implementation used DELETE — immediate
    // termination — while the confirmation dialog promised the period end.
    let response: Record<string, unknown>;
    try {
      const body = new URLSearchParams();
      body.append("cancel_at_period_end", "true");
      response = await stripeRequest(
        `/subscriptions/${subscription.providerSubId}`,
        body,
      );
    } catch (cause) {
      // NO local write. The subscription stays exactly as it was.
      throw Object.assign(providerFailure(subscription.provider), { cause });
    }

    // Take the period end the provider CONFIRMED, not the one we had stored.
    const periodEnd = response["current_period_end"];
    if (typeof periodEnd === "number" && Number.isFinite(periodEnd)) {
      confirmedPeriodEnd = new Date(periodEnd * 1000);
    }
    const confirmedFlag = response["cancel_at_period_end"];
    if (confirmedFlag !== true) {
      // The call succeeded but the provider did not agree to the thing we
      // asked for. Refuse to record a cancellation that is not real.
      throw providerFailure(subscription.provider);
    }
  } else if (subscription.provider === prismaPkg.PaymentProvider.PAYPAL) {
    try {
      await cancelPayPalSubscription(
        subscription.providerSubId,
        "Canceled by customer",
      );
    } catch (cause) {
      // THE defect this replaces: the previous code caught this, logged a
      // warning and then wrote the local row as CANCELED anyway — so the app
      // reported a cancelled subscription PayPal was still billing. There is
      // no fallback. The subscription stays active and the customer is told
      // the truth.
      throw Object.assign(providerFailure(subscription.provider), { cause });
    }
  } else {
    throw new DomainError("Unsupported payment provider", {
      httpStatus: 400,
      publicCode: "UNSUPPORTED_PAYMENT_PROVIDER",
      publicMessage: "This subscription cannot be cancelled here.",
      reportability: "OPERATIONAL_WARNING",
      severity: "warning",
    });
  }

  // ---- Record ONLY what the provider confirmed ---------------------------
  //
  // `status` deliberately stays as it was. The terminal CANCELED transition is
  // the provider's own statement and arrives by webhook; writing it here would
  // recreate the disagreement this service exists to end.
  // BILLING PRODUCTION CLOSURE (2026-08-27) — record what the provider did,
  // per provider.
  //
  // Both branches used to write `cancelAtPeriodEnd: true`, so a PayPal
  // cancellation — which ends the agreement THERE AND THEN — was stored as a
  // scheduled period-end cancellation. The row then said two contradictory
  // things at once, and every reader of `cancelAtPeriodEnd` (the projection's
  // plan summary, the CANCELING lifecycle, the "cancels on <date>" copy)
  // published the half that was not true.
  //
  // `cancelAtPeriodEnd` now means exactly what it says: the provider agreed to
  // stop renewing at the end of a period it named. PayPal names none, so the
  // flag stays false and `canceledAtUtc` carries the confirmed moment.
  const schedulesPeriodEnd = mode === "PERIOD_END";
  const updated = await prisma.subscription.update({
    where: { id: subscription.id },
    data: {
      cancelAtPeriodEnd: schedulesPeriodEnd,
      canceledAtUtc: new Date(),
      ...(schedulesPeriodEnd && confirmedPeriodEnd
        ? { currentPeriodEnd: confirmedPeriodEnd }
        : {}),
    },
    select: { status: true, currentPeriodEnd: true, cancelAtPeriodEnd: true },
  });

  // ---- Then the dependants ----------------------------------------------
  //
  // Ordering is deliberate. The base call is confirmed FIRST, because a
  // dependent add-on cancelled under a base subscription that then failed to
  // cancel would leave the customer with less storage and the same plan
  // charge — strictly worse than doing nothing. Once the provider has agreed
  // to end the base subscription, every recurring add-on that depends on it is
  // asked to stop, in the same mode.
  const dependents = await cancelDependentRecurringAddons({
    ownerUserId: subscription.userId,
    teamId: subscription.teamId,
    mode,
  });

  return {
    mode,
    // An IMMEDIATE cancellation has no future access date to report. Returning
    // the stored period end here would put a date on the screen that the
    // provider has already invalidated.
    accessEndsAtUtc: schedulesPeriodEnd
      ? updated.currentPeriodEnd?.toISOString() ?? null
      : null,
    cancelAtPeriodEnd: updated.cancelAtPeriodEnd,
    status: updated.status,
    alreadyScheduled: false,
    dependentAddonsFound: dependents.found,
    dependentAddonsScheduled: dependents.scheduled,
    dependentAddonsFailed: dependents.failed,
  };
}
