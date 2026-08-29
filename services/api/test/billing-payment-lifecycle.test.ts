/**
 * BILLING SURFACE CORRECTION — the payment transition rules, exhaustively.
 *
 * These are the rules that decide whether a fact about a payment may be
 * written. They are pure, so every combination is reachable without a database
 * and without a provider — which matters, because the cases that go wrong in
 * production are exactly the ones that are hard to stage: a webhook redelivered
 * out of order, a poll observing a moment that has already passed, a retry of
 * an event that was superseded weeks ago.
 */

import { describe, expect, it } from "vitest";
import * as prismaPkg from "@prisma/client";

import {
  decidePaymentTransition,
  isTerminalPaymentStatus,
  observedStateFromPaymentStatus,
  paymentStatusFromObservedState,
  TERMINAL_PAYMENT_STATUSES,
} from "../src/services/billing/reconciliation/payment-status.js";
import { paymentRowActions } from "../src/services/billing/pending-payments.service.js";
import type {
  BillingReconciliationProvider,
  ObservedState,
  PaymentObservation,
  PaymentCancellationResult,
  SubscriptionObservation,
} from "../src/services/billing/reconciliation/types.js";

const S = prismaPkg.PaymentStatus;
const EARLY = new Date("2026-08-01T00:00:00.000Z");
const LATE = new Date("2026-08-20T00:00:00.000Z");

const decide = (
  current: prismaPkg.PaymentStatus,
  observed: ObservedState,
  times: { currentObservedAtUtc?: Date | null; observedAtUtc?: Date | null } = {},
) =>
  decidePaymentTransition({
    current,
    currentObservedAtUtc: times.currentObservedAtUtc ?? null,
    observed,
    observedAtUtc: times.observedAtUtc ?? null,
  });

// ===========================================================================
// 1. The vocabulary
// ===========================================================================

describe("payment statuses", () => {
  it("treats PENDING as the only non-terminal status", () => {
    const all = Object.values(S);
    const nonTerminal = all.filter((s) => !isTerminalPaymentStatus(s));
    expect(nonTerminal).toEqual([S.PENDING]);
    expect(TERMINAL_PAYMENT_STATUSES.size).toBe(all.length - 1);
    // ABANDONED counts as terminal: this product will not resume that
    // checkout, even though the provider never told us anything.
    expect(TERMINAL_PAYMENT_STATUSES.has(S.ABANDONED)).toBe(true);
  });

  it("round-trips every PROVIDER status through the observation vocabulary", () => {
    // ABANDONED is excluded deliberately: it is the customer's statement, not
    // a provider's, and it maps to UNKNOWN precisely so no adapter can claim
    // to have observed it. See the ABANDONED section.
    for (const status of Object.values(S).filter((v) => v !== S.ABANDONED)) {
      expect(
        paymentStatusFromObservedState(observedStateFromPaymentStatus(status)),
      ).toBe(status);
    }
  });

  it("never turns an unreachable provider into a status", () => {
    expect(paymentStatusFromObservedState("UNKNOWN")).toBeNull();
    expect(decide(S.PENDING, "UNKNOWN")).toEqual({
      apply: false,
      reason: "NOTHING_LEARNED",
    });
  });

  it("separates EXPIRED from CANCELED", () => {
    // They are different facts: one is "the window closed", the other is
    // "somebody stopped it". The page says different things about each.
    expect(paymentStatusFromObservedState("EXPIRED")).toBe(S.EXPIRED);
    expect(paymentStatusFromObservedState("CANCELED")).toBe(S.CANCELED);
  });
});

// ===========================================================================
// 2. A pending payment may go anywhere it is observed to be
// ===========================================================================

describe("a pending payment", () => {
  it("moves to whatever terminal state the provider reports", () => {
    for (const observed of [
      "SUCCEEDED",
      "FAILED",
      "CANCELED",
      "EXPIRED",
      "REFUNDED",
    ] as ObservedState[]) {
      expect(decide(S.PENDING, observed)).toEqual({
        apply: true,
        status: paymentStatusFromObservedState(observed),
      });
    }
  });

  it("writes nothing when it is observed to still be pending", () => {
    expect(decide(S.PENDING, "PENDING")).toEqual({
      apply: false,
      reason: "ALREADY_THAT_STATUS",
    });
  });
});

// ===========================================================================
// 3. A settled payment is never moved backwards
// ===========================================================================

describe("a terminal payment", () => {
  it("is not returned to PENDING by a late or redelivered event", () => {
    // THE defect. `recordPayment` wrote `status` unconditionally on upsert, so
    // a PayPal APPROVAL_PENDING retry arriving after the capture had settled
    // rewrote SUCCEEDED to PENDING and the customer's history then said their
    // paid subscription was still being processed.
    for (const current of TERMINAL_PAYMENT_STATUSES) {
      expect(decide(current, "PENDING")).toEqual({
        apply: false,
        reason: "TERMINAL_NOT_REGRESSED",
      });
    }
  });

  it("is not rewritten by a contradictory second terminal fact", () => {
    expect(decide(S.SUCCEEDED, "FAILED")).toEqual({
      apply: false,
      reason: "TERMINAL_NOT_REGRESSED",
    });
    expect(decide(S.SUCCEEDED, "CANCELED")).toEqual({
      apply: false,
      reason: "TERMINAL_NOT_REGRESSED",
    });
    expect(decide(S.EXPIRED, "CANCELED")).toEqual({
      apply: false,
      reason: "TERMINAL_NOT_REGRESSED",
    });
  });

  it("allows the one real later-life transition money has", () => {
    expect(decide(S.SUCCEEDED, "REFUNDED")).toEqual({
      apply: true,
      status: S.REFUNDED,
    });
  });

  it("is idempotent: the same fact twice writes once", () => {
    expect(decide(S.SUCCEEDED, "SUCCEEDED")).toEqual({
      apply: false,
      reason: "ALREADY_THAT_STATUS",
    });
    expect(decide(S.EXPIRED, "EXPIRED")).toEqual({
      apply: false,
      reason: "ALREADY_THAT_STATUS",
    });
  });
});

// ===========================================================================
// 4. Ordering
// ===========================================================================

describe("out-of-order delivery", () => {
  it("discards an observation older than the state already recorded", () => {
    expect(
      decide(S.PENDING, "FAILED", {
        currentObservedAtUtc: LATE,
        observedAtUtc: EARLY,
      }),
    ).toEqual({ apply: false, reason: "OBSERVATION_IS_OLDER" });
  });

  it("applies an observation newer than the state already recorded", () => {
    expect(
      decide(S.PENDING, "SUCCEEDED", {
        currentObservedAtUtc: EARLY,
        observedAtUtc: LATE,
      }),
    ).toEqual({ apply: true, status: S.SUCCEEDED });
  });

  it("accepts an observation with the same timestamp", () => {
    // Equal is not older. A provider that reports one instant for two facts
    // must not have the second one silently dropped.
    expect(
      decide(S.PENDING, "SUCCEEDED", {
        currentObservedAtUtc: LATE,
        observedAtUtc: LATE,
      }),
    ).toEqual({ apply: true, status: S.SUCCEEDED });
  });

  it("falls back to the other rules when there is no ordering information", () => {
    // Refusing on absence would make the first observation of every legacy row
    // a no-op, which is the opposite of what reconciliation is for.
    expect(decide(S.PENDING, "SUCCEEDED")).toEqual({
      apply: true,
      status: S.SUCCEEDED,
    });
    expect(decide(S.SUCCEEDED, "PENDING", { observedAtUtc: LATE })).toEqual({
      apply: false,
      reason: "TERMINAL_NOT_REGRESSED",
    });
  });
});

// ===========================================================================
// 4b. ABANDONED — the customer's own statement
// ===========================================================================

describe("a payment the customer walked away from", () => {
  it("is terminal, so nothing reopens it as pending", () => {
    expect(isTerminalPaymentStatus(S.ABANDONED)).toBe(true);
    expect(decide(S.ABANDONED, "PENDING")).toEqual({
      apply: false,
      reason: "TERMINAL_NOT_REGRESSED",
    });
  });

  it("yields to money that actually moved", () => {
    /*
     * ABANDONED records an INTENTION — "I am not going to finish this" — taken
     * only after a reconciliation found no capture. A person can be overtaken
     * by events: if the provider later proves the payment settled, the
     * settlement is a fact and the intention is not.
     */
    expect(decide(S.ABANDONED, "SUCCEEDED")).toEqual({
      apply: true,
      status: S.SUCCEEDED,
    });
  });

  it("is not reopened by any other later provider answer", () => {
    for (const observed of ["FAILED", "CANCELED", "EXPIRED", "REFUNDED"] as ObservedState[]) {
      expect(decide(S.ABANDONED, observed)).toEqual({
        apply: false,
        reason: "TERMINAL_NOT_REGRESSED",
      });
    }
  });

  it("is never something a provider can claim to have observed", () => {
    // Every other status is a provider fact. This one is the customer's, and
    // giving it an observed state would invite an adapter to assert it.
    expect(observedStateFromPaymentStatus(S.ABANDONED)).toBe("UNKNOWN");
    expect(paymentStatusFromObservedState("UNKNOWN")).toBeNull();
  });

  it("is idempotent — abandoning twice writes once", () => {
    expect(decide(S.ABANDONED, "UNKNOWN")).toEqual({
      apply: false,
      reason: "NOTHING_LEARNED",
    });
  });
});

// ===========================================================================
// 5. Which actions a row may offer
// ===========================================================================

class StubProvider implements BillingReconciliationProvider {
  constructor(
    readonly provider: prismaPkg.PaymentProvider,
    private readonly supportsCancel: boolean,
  ) {
    if (!supportsCancel) delete (this as Partial<StubProvider>).cancelPayment;
  }

  async observePayment(providerRef: string): Promise<PaymentObservation> {
    return {
      kind: "PAYMENT",
      provider: this.provider,
      providerRef,
      state: "PENDING",
      amountCents: null,
      currency: null,
      quantity: null,
      observedAtUtc: null,
    };
  }

  async observeSubscription(
    providerRef: string,
  ): Promise<SubscriptionObservation> {
    return {
      kind: "SUBSCRIPTION",
      provider: this.provider,
      providerRef,
      state: "UNKNOWN",
      currentPeriodEndUtc: null,
      cancelAtPeriodEnd: false,
      observedAtUtc: null,
      recentPayments: [],
    };
  }

  cancelPayment?(providerRef: string): Promise<PaymentCancellationResult>;
}

const canCancelProvider = () => {
  const p = new StubProvider(prismaPkg.PaymentProvider.STRIPE, true);
  p.cancelPayment = async () => ({
    outcome: "STOPPED",
    state: "EXPIRED",
    observedAtUtc: LATE,
  });
  return p;
};

const cannotCancelProvider = () =>
  new StubProvider(prismaPkg.PaymentProvider.PAYPAL, false);

describe("the actions one payment row offers", () => {
  const providers = () => ({
    [prismaPkg.PaymentProvider.STRIPE]: canCancelProvider(),
    [prismaPkg.PaymentProvider.PAYPAL]: cannotCancelProvider(),
  });

  it("offers nothing at all on a finished payment", () => {
    for (const status of TERMINAL_PAYMENT_STATUSES) {
      expect(
        paymentRowActions({
          status,
          provider: prismaPkg.PaymentProvider.STRIPE,
          viewerMayCancel: true,
          providers: providers(),
        }),
      ).toEqual({ canRecheck: false, canCancel: false, canAbandon: false });
    }
  });

  it("offers cancellation only where the provider really supports it", () => {
    // Stripe can expire an open Checkout Session. PayPal has no operation that
    // cancels an unapproved order, so the button must not exist — a local
    // "Cancelled" while PayPal is still free to complete the order is a lie
    // with money attached.
    expect(
      paymentRowActions({
        status: S.PENDING,
        provider: prismaPkg.PaymentProvider.STRIPE,
        viewerMayCancel: true,
        providers: providers(),
      }),
    ).toEqual({ canRecheck: true, canCancel: true, canAbandon: false });

    expect(
      paymentRowActions({
        status: S.PENDING,
        provider: prismaPkg.PaymentProvider.PAYPAL,
        viewerMayCancel: true,
        providers: providers(),
      }),
    ).toEqual({ canRecheck: true, canCancel: false, canAbandon: true });
  });

  it("withholds BOTH stopping and abandoning from a viewer who may not cancel", () => {
    // Abandoning changes what this product will do with a live checkout, so it
    // is the payer's decision in exactly the way cancelling is.
    expect(
      paymentRowActions({
        status: S.PENDING,
        provider: prismaPkg.PaymentProvider.STRIPE,
        viewerMayCancel: false,
        providers: providers(),
      }),
    ).toEqual({ canRecheck: true, canCancel: false, canAbandon: false });
  });

  it("offers nothing when no adapter exists for the provider", () => {
    expect(
      paymentRowActions({
        status: S.PENDING,
        provider: prismaPkg.PaymentProvider.STRIPE,
        viewerMayCancel: true,
        providers: {},
      }),
    ).toEqual({ canRecheck: false, canCancel: false, canAbandon: false });
  });
});
