/**
 * THE PAYMENT-PROVIDER CREDENTIAL SIGNAL — one module, every observer.
 *
 * `billing.provider_authorization` is the PLATFORM condition "Stripe/PayPal is
 * refusing our API credential". It used to be raised and closed only from the
 * customer's per-payment Re-check and Abandon actions, so a rotated key raised
 * nothing until a customer happened to press a button, and an open condition
 * stayed open until one did — while the scheduled reconciliation sweep was
 * observing the same refusals (and the same recoveries) every tick and saying
 * nothing.
 *
 * The helpers live here, not in `pending-payments.service.ts`, so the
 * reconciliation service and checkout-attempt recovery can call them without
 * an import cycle (pending-payments already imports reconciliation).
 *
 * Nothing sensitive is carried: no token, no header, no response body, and no
 * customer identifier beyond an internal row id.
 */

import * as prismaPkg from "@prisma/client";

import {
  recordIncident,
  resolveConditionFromSourceRecovery,
} from "../observability/incident.service.js";
import { bump } from "../ops/metrics.service.js";
import type { ObservationFailure } from "./reconciliation/types.js";

/** Where the provider was being asked when it answered (or refused). */
export type ProviderSignalOperation =
  | "RECHECK_PAYMENT"
  | "ABANDON_PAYMENT"
  /** The account reconciliation (scheduled sweep or the customer's re-check). */
  | "RECONCILE_ACCOUNT"
  /** One checkout attempt's status check (sweep or customer). */
  | "RECHECK_CHECKOUT_ATTEMPT";

/** The one stable identity of "this provider refuses our credential". */
export function providerAuthorizationFingerprint(provider: prismaPkg.PaymentProvider): string {
  return "billing-provider-auth:" + provider;
}

/**
 * Recovery closes are throttled per provider: a reconciliation run makes many
 * successful calls and each would otherwise be a DB round trip. A refusal
 * clears the throttle, so the first success after a refusal always closes.
 */
const RECOVERY_THROTTLE_MS = 60_000;
const lastRecoveryAttemptAt = new Map<string, number>();

/** Test seam: forget the recovery throttle. */
export function resetProviderSignalThrottleForTests(): void {
  lastRecoveryAttemptAt.clear();
}

/**
 * Operational visibility for a provider failure, with nothing sensitive in it.
 */
export function recordProviderFailureSignal(input: {
  provider: prismaPkg.PaymentProvider;
  operation: ProviderSignalOperation;
  failure: ObservationFailure;
  /** The internal row the observation was about (payment, attempt, add-on). */
  paymentId?: string | null;
}): void {
  // One counter per FAILURE KIND, so an outage and a credential problem are
  // distinguishable on a dashboard rather than one flat "provider errors".
  switch (input.failure) {
    case "NOT_FOUND":
      bump("billing_provider_reference_not_found_total");
      break;
    case "REFERENCE_INVALID":
      bump("billing_provider_reference_invalid_total");
      break;
    case "AUTHORIZATION_FAILED":
      bump("billing_provider_authorization_failed_total");
      break;
    default:
      bump("billing_provider_unavailable_total");
  }

  if (input.failure !== "AUTHORIZATION_FAILED") return;

  // A refusal means the next success is a recovery and must not be throttled.
  lastRecoveryAttemptAt.delete(input.provider);

  /*
   * The one failure no customer and no retry can resolve: the provider has
   * stopped accepting our credential. OPS-027 — ONE PLATFORM condition per
   * provider (stable fingerprint, deliberate platform scope), re-observed on
   * every refusal and closed by `recordProviderObservationSuccess` on the next
   * call the provider answers.
   */
  void recordIncident({
    sourceId: "billing.provider_authorization",
    teamId: null,
    platform: true,
    category: "RECONCILIATION",
    severity: "HIGH",
    fingerprint: providerAuthorizationFingerprint(input.provider),
    message: {
      code: "ops.billing.provider_authorization",
      params: { provider: String(input.provider), operation: String(input.operation) },
    },
    runbookSlug: "billing-provider-authorization",
    metadata: {
      provider: input.provider,
      operation: input.operation,
      paymentId: input.paymentId ?? null,
    },
  }).catch(() => {
    /* incident creation is best-effort; the counter above always lands */
  });
}

/**
 * The provider ANSWERED an observation (any state but UNKNOWN), which proves
 * it accepts our credential. Closes the platform authorization condition if
 * one is open; a no-op otherwise. Best-effort and throttled per provider.
 */
export function recordProviderObservationSuccess(input: {
  provider: prismaPkg.PaymentProvider;
  now?: number;
}): void {
  const now = input.now ?? Date.now();
  const last = lastRecoveryAttemptAt.get(input.provider);
  if (last !== undefined && now - last < RECOVERY_THROTTLE_MS) return;
  lastRecoveryAttemptAt.set(input.provider, now);
  void resolveConditionFromSourceRecovery({
    teamId: null,
    platform: true,
    fingerprint: providerAuthorizationFingerprint(input.provider),
    safeMessage:
      input.provider +
      " answered a payment observation: the credential is accepted again. Resolved from a successful provider call.",
  }).catch(() => {
    /* best-effort */
  });
}

/**
 * The one call an observer makes after asking a provider anything: a refusal
 * or failure is signalled, an answer is a recovery. `state` is the observation
 * state; only `UNKNOWN` is a failure.
 */
export function noteProviderObservation(input: {
  provider: prismaPkg.PaymentProvider;
  operation: ProviderSignalOperation;
  observation: { state: string; failure?: ObservationFailure };
  paymentId?: string | null;
}): void {
  if (input.observation.state === "UNKNOWN") {
    recordProviderFailureSignal({
      provider: input.provider,
      operation: input.operation,
      failure: input.observation.failure ?? "PROVIDER_UNAVAILABLE",
      paymentId: input.paymentId ?? null,
    });
    return;
  }
  recordProviderObservationSuccess({ provider: input.provider });
}
