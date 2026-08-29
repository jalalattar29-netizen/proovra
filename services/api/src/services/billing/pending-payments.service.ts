/**
 * BILLING SURFACE CORRECTION (2026-08-29) — the lifecycle of a payment that
 * has not settled.
 *
 * WHAT WAS WRONG
 * ---------------------------------------------------------------------------
 * The Billing page listed payments and, for a PENDING one, offered nothing.
 * There was no way to ask the provider what had actually happened, no way to
 * stop one, and no state a stuck row could ever reach — so a customer who
 * closed a Stripe tab in March was still reading "Pending · Personal account"
 * in August, unable to tell whether a charge was coming.
 *
 * WHAT THIS ADDS, AND WHAT IT REFUSES TO ADD
 * ---------------------------------------------------------------------------
 *   * RE-CHECK asks the provider about ONE stored reference and records what
 *     it says. It moves no money and creates no session: it is a read, plus
 *     the transition `decidePaymentTransition` permits.
 *
 *   * CANCEL is provider-first and provider-only. Stripe can expire an open
 *     Checkout Session, so a Stripe row can be cancelled. PayPal exposes no
 *     operation that cancels an unapproved order, so a PayPal row cannot be,
 *     and the surface never offers it — rather than marking a row cancelled
 *     locally while PayPal is still free to complete it.
 *
 *   * Nothing here DELETES a payment row. A cancelled or expired payment is
 *     part of the account's history and stays in it.
 *
 * AUTHORIZATION
 * ---------------------------------------------------------------------------
 * The caller has already resolved the account and the capability. Every query
 * below is additionally scoped by `paymentWhereForAccount`, so a payment id
 * belonging to another account cannot be reached even with a valid capability
 * on this one.
 */

import * as prismaPkg from "@prisma/client";

import { DomainError } from "../../errors.js";
import { prisma } from "../../db.js";
import {
  organizationWorkspaceIds,
  paymentWhereForAccount,
  type BillingAccountRef,
} from "./billing-accounts.service.js";
import {
  decidePaymentTransition,
  isTerminalPaymentStatus,
} from "./reconciliation/payment-status.js";
import {
  defaultReconciliationProviders,
  type ReconciliationProviders,
} from "./reconciliation/reconciliation.service.js";

/**
 * What a customer may do with one payment row, decided HERE.
 *
 * The browser renders these booleans; it never works them out from a status
 * string. "Which payments can be cancelled" is a commercial and provider fact,
 * and a page that derives it would be deriving it from the two things it can
 * see (a status and a provider name) rather than from what the provider
 * actually supports.
 */
export type PaymentRowActions = {
  /** Ask the provider what this payment is now. Always safe; never charges. */
  canRecheck: boolean;
  /** Stop it at the provider. Only where the provider has such an operation. */
  canCancel: boolean;
};

export function paymentRowActions(input: {
  status: prismaPkg.PaymentStatus;
  provider: prismaPkg.PaymentProvider;
  /** Whether the viewer holds BILLING_CANCEL on this account. */
  viewerMayCancel: boolean;
  providers?: ReconciliationProviders;
}): PaymentRowActions {
  if (isTerminalPaymentStatus(input.status)) {
    // A finished payment has no actions. Offering "Re-check" on a row that
    // settled in March invites a customer to press it and learn nothing.
    return { canRecheck: false, canCancel: false };
  }

  const adapter = (input.providers ?? defaultReconciliationProviders())[
    input.provider
  ];

  return {
    canRecheck: Boolean(adapter),
    // Three things must ALL hold: the viewer may cancel, an adapter exists,
    // and that adapter actually implements a provider cancellation.
    canCancel:
      input.viewerMayCancel && Boolean(adapter?.cancelPayment),
  };
}

/** The safe result of asking the provider about one payment. */
export type PaymentRecheckResult = {
  outcome: "UPDATED" | "NO_CHANGE" | "PROVIDER_UNAVAILABLE";
  /** The status the row holds after the check. */
  status: prismaPkg.PaymentStatus;
  /**
   * Where the customer can finish paying, when the provider still holds the
   * flow open. Never stored, and null the moment it stops being valid.
   */
  resumeUrl: string | null;
  actions: PaymentRowActions;
};

async function loadScopedPayment(input: {
  account: BillingAccountRef;
  paymentId: string;
}) {
  const row = await prisma.payment.findFirst({
    where: {
      AND: [
        { id: input.paymentId },
        paymentWhereForAccount({
          account: input.account,
          organizationWorkspaceIds:
            input.account.type === "ORGANIZATION"
              ? await organizationWorkspaceIds(input.account.id)
              : undefined,
        }),
      ],
    },
    select: {
      id: true,
      provider: true,
      providerPaymentId: true,
      status: true,
      providerStateAtUtc: true,
    },
  });

  if (!row) {
    // Deliberately the same answer as "no such payment". A payment that
    // belongs to another account must not be distinguishable from one that
    // does not exist.
    throw new DomainError("Payment not found for this billing account", {
      httpStatus: 404,
      publicCode: "PAYMENT_NOT_FOUND",
      publicMessage: "We could not find that payment on this account.",
      reportability: "EXPECTED_DENIAL",
      severity: "info",
    });
  }

  return row;
}

/**
 * Ask the provider what ONE payment is now, and record it.
 *
 * Idempotent by construction: the write only happens when
 * `decidePaymentTransition` says the observation is newer, different and not a
 * regression, so pressing "Re-check" repeatedly changes nothing after the
 * first answer.
 */
export async function recheckPayment(input: {
  account: BillingAccountRef;
  paymentId: string;
  viewerMayCancel: boolean;
  providers?: ReconciliationProviders;
}): Promise<PaymentRecheckResult> {
  const providers = input.providers ?? defaultReconciliationProviders();
  const row = await loadScopedPayment(input);

  const actionsFor = (status: prismaPkg.PaymentStatus): PaymentRowActions =>
    paymentRowActions({
      status,
      provider: row.provider,
      viewerMayCancel: input.viewerMayCancel,
      providers,
    });

  if (isTerminalPaymentStatus(row.status)) {
    return {
      outcome: "NO_CHANGE",
      status: row.status,
      resumeUrl: null,
      actions: actionsFor(row.status),
    };
  }

  const adapter = providers[row.provider];
  if (!adapter) {
    return {
      outcome: "PROVIDER_UNAVAILABLE",
      status: row.status,
      resumeUrl: null,
      actions: actionsFor(row.status),
    };
  }

  const observation = await adapter.observePayment(row.providerPaymentId);
  if (observation.state === "UNKNOWN") {
    return {
      outcome: "PROVIDER_UNAVAILABLE",
      status: row.status,
      resumeUrl: null,
      actions: actionsFor(row.status),
    };
  }

  const decision = decidePaymentTransition({
    current: row.status,
    currentObservedAtUtc: row.providerStateAtUtc,
    observed: observation.state,
    observedAtUtc: observation.observedAtUtc,
  });

  if (!decision.apply) {
    return {
      outcome: "NO_CHANGE",
      status: row.status,
      // Still open, and the provider just told us where. This is the state a
      // customer most needs an action for.
      resumeUrl: observation.resumeUrl ?? null,
      actions: actionsFor(row.status),
    };
  }

  await prisma.payment.update({
    where: { id: row.id },
    data: {
      status: decision.status,
      ...(observation.observedAtUtc
        ? { providerStateAtUtc: observation.observedAtUtc }
        : {}),
    },
  });

  return {
    outcome: "UPDATED",
    status: decision.status,
    resumeUrl:
      decision.status === prismaPkg.PaymentStatus.PENDING
        ? (observation.resumeUrl ?? null)
        : null,
    actions: actionsFor(decision.status),
  };
}

/** The safe result of asking the provider to stop one payment. */
export type PaymentCancelResult = {
  outcome: "CANCELLED" | "ALREADY_FINISHED";
  status: prismaPkg.PaymentStatus;
  actions: PaymentRowActions;
};

/**
 * Stop an unsettled payment AT THE PROVIDER.
 *
 * Provider-first, with no local optimism: the row is only written after the
 * provider has answered with a terminal state, and the state written is the
 * one the PROVIDER reports — an expired Stripe session records EXPIRED, not
 * "cancelled", because that is what happened to it.
 *
 * Every refusal below leaves the payment exactly as it was.
 */
export async function cancelPendingPayment(input: {
  account: BillingAccountRef;
  paymentId: string;
  providers?: ReconciliationProviders;
}): Promise<PaymentCancelResult> {
  const providers = input.providers ?? defaultReconciliationProviders();
  const row = await loadScopedPayment(input);

  const actionsFor = (status: prismaPkg.PaymentStatus): PaymentRowActions =>
    paymentRowActions({
      status,
      provider: row.provider,
      viewerMayCancel: true,
      providers,
    });

  if (isTerminalPaymentStatus(row.status)) {
    return {
      outcome: "ALREADY_FINISHED",
      status: row.status,
      actions: actionsFor(row.status),
    };
  }

  const adapter = providers[row.provider];
  if (!adapter?.cancelPayment) {
    throw new DomainError(
      "Provider exposes no cancellation for an unsettled payment",
      {
        httpStatus: 409,
        publicCode: "PAYMENT_CANCELLATION_UNSUPPORTED",
        publicMessage:
          "This payment cannot be stopped from here. Use Re-check to see whether it has completed, or cancel it with your payment provider.",
        reportability: "EXPECTED_DENIAL",
        severity: "info",
      },
    );
  }

  const result = await adapter.cancelPayment(row.providerPaymentId);

  if (result.outcome === "UNSUPPORTED") {
    throw new DomainError("Provider declined to cancel this payment", {
      httpStatus: 409,
      publicCode: "PAYMENT_CANCELLATION_UNSUPPORTED",
      publicMessage:
        "This payment cannot be stopped from here. Use Re-check to see whether it has completed, or cancel it with your payment provider.",
      reportability: "EXPECTED_DENIAL",
      severity: "info",
    });
  }

  if (result.outcome === "PROVIDER_UNAVAILABLE") {
    throw new DomainError("Payment provider unavailable during cancellation", {
      httpStatus: 503,
      publicCode: "PAYMENT_PROVIDER_UNAVAILABLE",
      publicMessage:
        "We could not reach your payment provider. Nothing has changed and nothing has been charged — please try again shortly.",
      reportability: "EXPECTED_DENIAL",
      severity: "warning",
    });
  }

  // Both remaining outcomes carry a PROVIDER-REPORTED state, so the same
  // transition rules apply to each: what is recorded is what the provider
  // says, subject to the ordering and monotonicity guards.
  const observedAtUtc =
    result.outcome === "STOPPED" ? result.observedAtUtc : null;

  const decision = decidePaymentTransition({
    current: row.status,
    currentObservedAtUtc: row.providerStateAtUtc,
    observed: result.state,
    observedAtUtc,
  });

  if (!decision.apply) {
    return {
      outcome: result.outcome === "STOPPED" ? "CANCELLED" : "ALREADY_FINISHED",
      status: row.status,
      actions: actionsFor(row.status),
    };
  }

  await prisma.payment.update({
    where: { id: row.id },
    data: {
      status: decision.status,
      ...(observedAtUtc ? { providerStateAtUtc: observedAtUtc } : {}),
    },
  });

  return {
    outcome: result.outcome === "STOPPED" ? "CANCELLED" : "ALREADY_FINISHED",
    status: decision.status,
    actions: actionsFor(decision.status),
  };
}
