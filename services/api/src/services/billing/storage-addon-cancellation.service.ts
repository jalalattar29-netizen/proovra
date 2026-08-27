/**
 * BILLING DEPENDENT-CANCELLATION CONVERGENCE (2026-08-27) — THE canonical
 * recurring Storage add-on cancellation.
 *
 * ONE IMPLEMENTATION, TWO CALLERS
 * ---------------------------------------------------------------------------
 * A recurring add-on could previously be cancelled two ways with two different
 * meanings: the cascade scheduled it for period end, while the direct route
 * sent Stripe a `DELETE` — immediate termination of storage the customer had
 * already paid for that month. Same object, same button in the customer's
 * mind, two outcomes.
 *
 * Both paths now call `cancelStorageAddonAtProvider`, so the semantics are
 * decided once, per provider:
 *
 *   STRIPE  PERIOD_END. `cancel_at_period_end=true`, and the call is only
 *           credited when the provider ECHOES the flag back. The customer
 *           keeps the storage they paid for; the terminal transition arrives
 *           by webhook or reconciliation.
 *   PAYPAL  IMMEDIATE. PayPal's subscription cancel has no period-end option,
 *           so the product says immediate rather than promising something it
 *           cannot deliver.
 *
 * WHAT A FAILURE MEANS HERE
 * ---------------------------------------------------------------------------
 * This module never writes local state. It returns a typed outcome with a SAFE
 * reason code and lets the obligation authority decide what to persist. That
 * boundary is deliberate: the previous code caught the provider error and
 * dropped it, so a failure had no reason, no timestamp and no trace.
 *
 * No raw provider body ever leaves this file.
 */

import * as prismaPkg from "@prisma/client";

import { stripeRequest } from "../stripe.service.js";
import { cancelPayPalSubscription } from "../paypal.service.js";

/**
 * What a provider cancellation is asking for.
 *
 * Derived from the PROVIDER, never chosen by a caller: the mode is a fact
 * about what Stripe and PayPal can each do, and letting a caller pass
 * `PERIOD_END` for PayPal is how the product came to claim a scheduled
 * cancellation that did not exist.
 */
export type AddonCancellationMode = "PERIOD_END" | "IMMEDIATE";

export function addonCancellationModeForProvider(
  provider: prismaPkg.PaymentProvider,
): AddonCancellationMode {
  return provider === prismaPkg.PaymentProvider.STRIPE
    ? "PERIOD_END"
    : "IMMEDIATE";
}

/**
 * The SAFE failure vocabulary.
 *
 * A closed set, because these values are persisted, counted, indexed and shown
 * to operators. A provider error string is none of those things — it is
 * unbounded, it can carry an identifier, and it cannot be reasoned about.
 */
export type AddonCancellationReasonCode =
  /** The provider could not be reached, or answered with a transport error. */
  | "PROVIDER_UNAVAILABLE"
  /** The provider answered, and refused. */
  | "PROVIDER_REJECTED"
  /** The call succeeded but the provider did not confirm what was asked. */
  | "PROVIDER_STATE_MISMATCH"
  /** The add-on has no usable provider binding to cancel. */
  | "INVALID_BINDING"
  /** The provider answered in a shape this version does not model. */
  | "UNKNOWN_PROVIDER_RESPONSE"
  /** Fast retries are spent; the obligation is escalated, not abandoned. */
  | "RETRY_EXHAUSTED";

export type AddonCancellationOutcome =
  | {
      ok: true;
      mode: AddonCancellationMode;
      /**
       * True when the provider stated the subscription is over NOW. False for
       * a period-end schedule, where capacity legitimately continues.
       */
      terminal: boolean;
    }
  | { ok: false; mode: AddonCancellationMode; reasonCode: AddonCancellationReasonCode };

/**
 * Ask the provider to stop ONE recurring Storage add-on.
 *
 * Injectable so the orchestration suites drive every branch — confirmed,
 * rejected, unreachable, mismatched — against a real database with no
 * credential and no socket. Production passes nothing.
 */
export type StorageAddonProviderCanceller = (input: {
  provider: prismaPkg.PaymentProvider;
  providerRef: string;
  mode: AddonCancellationMode;
}) => Promise<AddonCancellationOutcome>;

/**
 * The production canceller.
 *
 * Every exit is explicit. There is no bare catch: a financial provider call
 * that fails produces a NAMED reason, because "something went wrong" cannot be
 * retried intelligently, counted, or explained to the person being charged.
 */
export async function cancelStorageAddonAtProvider(input: {
  provider: prismaPkg.PaymentProvider;
  providerRef: string | null;
  cancelAtProvider?: StorageAddonProviderCanceller;
}): Promise<AddonCancellationOutcome> {
  const mode = addonCancellationModeForProvider(input.provider);

  if (!input.providerRef || input.providerRef.trim() === "") {
    // A recurring row with no binding cannot be cancelled remotely, and must
    // never be reported as cancelled. It needs a person.
    return { ok: false, mode, reasonCode: "INVALID_BINDING" };
  }
  const providerRef = input.providerRef;

  if (input.cancelAtProvider) {
    return input.cancelAtProvider({ provider: input.provider, providerRef, mode });
  }

  if (input.provider === prismaPkg.PaymentProvider.STRIPE) {
    let response: Record<string, unknown>;
    try {
      const body = new URLSearchParams();
      body.append("cancel_at_period_end", "true");
      response = await stripeRequest(
        `/subscriptions/${encodeURIComponent(providerRef)}`,
        body,
      );
    } catch {
      // Transport, timeout or non-2xx. Retryable, and named as such.
      return { ok: false, mode, reasonCode: "PROVIDER_UNAVAILABLE" };
    }

    const flag = response["cancel_at_period_end"];
    if (flag === true) return { ok: true, mode, terminal: false };
    if (flag === false) {
      // The call succeeded and Stripe did not agree to the thing asked for.
      // Recording a cancellation the provider did not make is the defect class
      // this whole module exists to prevent.
      return { ok: false, mode, reasonCode: "PROVIDER_STATE_MISMATCH" };
    }
    return { ok: false, mode, reasonCode: "UNKNOWN_PROVIDER_RESPONSE" };
  }

  if (input.provider === prismaPkg.PaymentProvider.PAYPAL) {
    try {
      await cancelPayPalSubscription(providerRef, "Base subscription canceled");
    } catch {
      return { ok: false, mode, reasonCode: "PROVIDER_UNAVAILABLE" };
    }
    // PayPal's cancel is terminal by definition. There is no period-end flag
    // to echo, so success IS the confirmation.
    return { ok: true, mode, terminal: true };
  }

  return { ok: false, mode, reasonCode: "PROVIDER_REJECTED" };
}
