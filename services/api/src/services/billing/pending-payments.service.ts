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
import { recordIncident } from "../observability/incident.service.js";
import { bump } from "../ops/metrics.service.js";
import {
  organizationWorkspaceIds,
  paymentWhereForAccount,
  type BillingAccountRef,
} from "./billing-accounts.service.js";
import {
  decidePaymentTransition,
  isTerminalPaymentStatus,
} from "./reconciliation/payment-status.js";
import type { ObservationFailure } from "./reconciliation/types.js";
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
  /**
   * Give up on a checkout the PROVIDER cannot be asked to stop.
   *
   * BILLING SURFACE CORRECTION (2026-08-29) — the honest action for a PayPal
   * approval attempt. PayPal exposes no cancellation for an unapproved order,
   * so the row had "Re-check" and nothing else, and a customer looking at a
   * March attempt in August had no way to be rid of it. This is not a claim
   * that PayPal stopped anything: it records that the CUSTOMER is not going to
   * finish, after a reconciliation confirms nothing was captured, and stops
   * this product resuming that checkout.
   *
   * Never offered where `canCancel` is — a provider that can really be asked
   * to stop should be asked, not worked around.
   */
  canAbandon: boolean;
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
    return { canRecheck: false, canCancel: false, canAbandon: false };
  }

  const adapter = (input.providers ?? defaultReconciliationProviders())[
    input.provider
  ];

  const providerCanCancel = Boolean(adapter?.cancelPayment);

  return {
    canRecheck: Boolean(adapter),
    // Three things must ALL hold: the viewer may cancel, an adapter exists,
    // and that adapter actually implements a provider cancellation.
    canCancel: input.viewerMayCancel && providerCanCancel,
    // The fallback, and ONLY the fallback: where the provider can really be
    // asked to stop, it is asked.
    canAbandon: input.viewerMayCancel && Boolean(adapter) && !providerCanCancel,
  };
}

/**
 * The safe result of asking the provider about one payment.
 *
 * BILLING PAYMENT LIFECYCLE (2026-08-30) — every failure used to arrive as
 * PROVIDER_UNAVAILABLE, which is a claim about the NETWORK. Three of the four
 * ways this can fail are not outages, and "try again shortly" is the wrong
 * remedy for all three: a reference the provider has never heard of will
 * answer the same way for ever, a credential problem needs an operator rather
 * than patience, and a reference no endpoint accepts can never be resolved.
 *
 * A customer told to wait when waiting cannot help is being sent round a loop,
 * and the abandon action exists precisely to break that loop.
 */
export type PaymentRecheckResult = {
  outcome:
    /** The provider answered and the row moved. */
    | "UPDATED"
    /** The provider answered and there was nothing to change. */
    | "NO_CHANGE"
    /** Unreachable — DNS, timeout, connection reset, provider 5xx. */
    | "PROVIDER_UNAVAILABLE"
    /** The provider has never heard of the reference we stored. */
    | "PROVIDER_REFERENCE_NOT_FOUND"
    /** The stored reference is blank or a shape no endpoint accepts. */
    | "PROVIDER_REFERENCE_INVALID"
    /** The provider refused US: an operator problem, not the customer's. */
    | "PROVIDER_AUTHORIZATION_FAILED";
  /** The status the row holds after the check. */
  status: prismaPkg.PaymentStatus;
  /**
   * Where the customer can finish paying, when the provider still holds the
   * flow open. Never stored, and null the moment it stops being valid.
   */
  resumeUrl: string | null;
  actions: PaymentRowActions;
};

/**
 * An observation failure as the outcome a caller acts on.
 *
 * Deliberately total: a failure this version does not model is reported as
 * unavailable, which is the ONLY safe default — it changes nothing, claims
 * nothing, and invites a retry.
 */
export function recheckOutcomeForFailure(
  failure: ObservationFailure | undefined,
): PaymentRecheckResult["outcome"] {
  switch (failure) {
    case "NOT_FOUND":
      return "PROVIDER_REFERENCE_NOT_FOUND";
    case "REFERENCE_INVALID":
      return "PROVIDER_REFERENCE_INVALID";
    case "AUTHORIZATION_FAILED":
      return "PROVIDER_AUTHORIZATION_FAILED";
    case "PROVIDER_MALFORMED":
    case "UNSUPPORTED_STATE":
    case "PROVIDER_UNAVAILABLE":
    case undefined:
    default:
      return "PROVIDER_UNAVAILABLE";
  }
}

/**
 * Operational visibility for a provider failure, with nothing sensitive in it.
 *
 * No token, no secret, no header, no response body, and no customer identifier
 * beyond the payment's own internal id — which correlates this to the audit row
 * and to nothing outside the system.
 */
export function recordProviderFailureSignal(input: {
  provider: prismaPkg.PaymentProvider;
  operation: "RECHECK_PAYMENT" | "ABANDON_PAYMENT";
  failure: ObservationFailure;
  paymentId: string;
}): void {
  // One counter per FAILURE KIND, so an outage and a credential problem are
  // distinguishable on a dashboard rather than one flat "provider errors".
  // Named explicitly rather than composed: a counter name is part of the
  // operational contract, and a name built by string concatenation is one no
  // dashboard can be written against before it first fires.
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

  /*
   * The one failure no customer and no retry can resolve: the provider has
   * stopped accepting our credential. Deduped by the hour, so a bad key opens
   * one incident rather than one per customer who presses Re-check.
   */
  void recordIncident({
    sourceId: "billing.provider_authorization",
    teamId: null,
    category: "RECONCILIATION",
    severity: "HIGH",
    fingerprint:
      "billing-provider-auth:" +
      input.provider +
      ":" +
      String(Math.floor(Date.now() / 3600_000)),
    title: input.provider + " refused our credentials",
    safeSummary:
      input.provider +
      " answered 401/403 during " +
      input.operation +
      ". Payment states cannot be verified until the credential is restored. No customer payment has been changed.",
    runbookSlug: "billing-provider-authorization",
    metadata: {
      provider: input.provider,
      operation: input.operation,
      paymentId: input.paymentId,
    },
  }).catch(() => {
    /* incident creation is best-effort; the counter above always lands */
  });
}

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
    /*
     * WHY it failed decides what the customer is told and what they can do.
     *
     * This branch answered PROVIDER_UNAVAILABLE for every failure, so a
     * reference PayPal has never heard of and a rotated credential both told
     * the customer to try again shortly — advice that cannot work in either
     * case.
     */
    const outcome = recheckOutcomeForFailure(observation.failure);
    recordProviderFailureSignal({
      provider: row.provider,
      operation: "RECHECK_PAYMENT",
      failure: observation.failure ?? "PROVIDER_UNAVAILABLE",
      paymentId: row.id,
    });
    return {
      outcome,
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

/**
 * The safe result of a customer's request to abandon an unresolved attempt.
 *
 * BILLING PAYMENT LIFECYCLE (2026-08-30) — `ABANDON_CONFIRMATION_REQUIRED` is
 * the outcome this whole correction exists for. See `abandonPendingPayment`.
 */
export type PaymentAbandonResult = {
  outcome:
    /** Recorded: the attempt is out of the customer's active Billing view. */
    | "ABANDONED"
    /** It already was. Repeating the request changes nothing. */
    | "ALREADY_ABANDONED"
    /** It had already reached a terminal state. Nothing to abandon. */
    | "ALREADY_FINISHED"
    /** The provider knew better, and its answer was recorded instead. */
    | "PROVIDER_ANSWERED"
    /**
     * The provider could not be asked, so the customer is told exactly what
     * abandoning does and does not mean, and asked again.
     */
    | "ABANDON_CONFIRMATION_REQUIRED";
  status: prismaPkg.PaymentStatus;
  actions: PaymentRowActions;
  /**
   * Present ONLY with ABANDON_CONFIRMATION_REQUIRED. What the customer is
   * agreeing to, in the absence of provider truth.
   */
  warning?: string;
  /** Present ONLY with ABANDON_CONFIRMATION_REQUIRED. */
  confirmation?: { canConfirmAbandon: true };
  /** Why the provider could not be asked, when it could not. */
  providerFailure?: PaymentRecheckResult["outcome"];
};

/**
 * Record that the CUSTOMER is not going to finish a checkout.
 *
 * THE DEFECT THIS FIXES
 * ---------------------------------------------------------------------------
 * The first version reconciled first and REFUSED — 503 — whenever the provider
 * could not be reached. The projection said `canAbandon: true`, the page
 * offered "Abandon payment attempt", and pressing it failed in exactly the
 * case the action exists for: a months-old PayPal attempt nobody can get an
 * answer about. An advertised action that cannot complete in its own use case
 * is worse than no action, because the customer keeps trying it.
 *
 * It also said "Nothing has been charged" while admitting it could not reach
 * the provider. That is a financial claim made from ignorance, and it is not
 * ours to make: if PayPal cannot be asked, we do not know.
 *
 * WHAT IT DOES NOW
 * ---------------------------------------------------------------------------
 * PROVIDER-FIRST, still — the provider is asked before anything is written,
 * and provider truth always wins:
 *
 *   * settled / failed / cancelled / expired -> that TRUTH is recorded, and
 *     the customer is answered with what actually happened. A payment that
 *     captured is never marked abandoned.
 *   * still open, and the provider can really be asked to stop it -> the
 *     customer is told so; provider cancellation is a different act with a
 *     different label and its own audit, and it is not silently substituted.
 *   * still open with no provider cancellation -> ABANDONED. Nothing is
 *     claimed about the provider.
 *   * UNREACHABLE, unknown reference, or an unresolvable legacy reference ->
 *     ABANDON_CONFIRMATION_REQUIRED. Not a refusal: a second, explicit
 *     question that states exactly what abandoning does and does not mean.
 *     A caller that comes back with `confirmed` records the abandonment.
 *
 * WHAT IT NEVER CLAIMS: that the provider cancelled anything, that a charge
 * was reversed, or that nothing was charged. `ABANDONED` is a statement about
 * this product's view, and `decidePaymentTransition` lets later provider proof
 * overrule it.
 */
export async function abandonPendingPayment(input: {
  account: BillingAccountRef;
  paymentId: string;
  /**
   * The customer has been shown what abandoning means and said yes.
   *
   * Only consulted when the provider could not prove anything — provider truth
   * never needs a customer's permission to be recorded, and this flag can
   * never turn a settled payment into an abandoned one.
   */
  confirmed?: boolean;
  providers?: ReconciliationProviders;
}): Promise<PaymentAbandonResult> {
  const providers = input.providers ?? defaultReconciliationProviders();
  const row = await loadScopedPayment(input);

  const actionsFor = (status: prismaPkg.PaymentStatus): PaymentRowActions =>
    paymentRowActions({
      status,
      provider: row.provider,
      viewerMayCancel: true,
      providers,
    });

  // IDEMPOTENT at the front: a second confirmation changes nothing and asks
  // the provider nothing.
  if (row.status === prismaPkg.PaymentStatus.ABANDONED) {
    return {
      outcome: "ALREADY_ABANDONED",
      status: row.status,
      actions: actionsFor(row.status),
    };
  }

  if (isTerminalPaymentStatus(row.status)) {
    return {
      outcome: "ALREADY_FINISHED",
      status: row.status,
      actions: actionsFor(row.status),
    };
  }

  const adapter = providers[row.provider];

  // Ask the provider ONCE. An adapter we do not have is treated exactly like
  // one we cannot reach: unknown, not "nothing happened".
  const observation = adapter
    ? await adapter.observePayment(row.providerPaymentId)
    : null;

  if (!observation || observation.state === "UNKNOWN") {
    const failure = observation?.failure ?? "PROVIDER_UNAVAILABLE";
    recordProviderFailureSignal({
      provider: row.provider,
      operation: "ABANDON_PAYMENT",
      failure,
      paymentId: row.id,
    });

    if (!input.confirmed) {
      /*
       * The correction. This used to throw 503, which made the advertised
       * action impossible in its own use case. It is a QUESTION now, and the
       * warning is the honest version of what the old message claimed: we
       * cannot say nothing was charged, because we could not ask.
       */
      return {
        outcome: "ABANDON_CONFIRMATION_REQUIRED",
        status: row.status,
        actions: actionsFor(row.status),
        providerFailure: recheckOutcomeForFailure(failure),
        warning:
          failure === "NOT_FOUND"
            ? "Your payment provider has no record of this attempt. Abandoning only removes it from your active Billing view. It does not cancel, reverse, or refund anything at your provider."
            : failure === "REFERENCE_INVALID"
              ? "This older attempt cannot be matched with your payment provider automatically. Abandoning only removes it from your active Billing view. It does not cancel, reverse, or refund anything at your provider."
              : "Your payment provider could not be reached. Abandoning only removes this attempt from your active Billing view. It does not cancel, reverse, or refund anything at your provider.",
        confirmation: { canConfirmAbandon: true },
      };
    }

    return recordLocalAbandonment(row, actionsFor);
  }

  if (observation.state !== "PENDING") {
    // The provider knows something better than "abandoned". Record THAT.
    const truth = decidePaymentTransition({
      current: row.status,
      currentObservedAtUtc: row.providerStateAtUtc,
      observed: observation.state,
      observedAtUtc: observation.observedAtUtc,
    });
    if (truth.apply) {
      await prisma.payment.updateMany({
        where: { id: row.id, status: row.status },
        data: {
          status: truth.status,
          ...(observation.observedAtUtc
            ? { providerStateAtUtc: observation.observedAtUtc }
            : {}),
        },
      });
      return {
        outcome: "PROVIDER_ANSWERED",
        status: truth.status,
        actions: actionsFor(truth.status),
      };
    }
    return {
      outcome: "PROVIDER_ANSWERED",
      status: row.status,
      actions: actionsFor(row.status),
    };
  }

  /*
   * Still open, and the provider CAN really be asked to stop it.
   *
   * Abandoning here would quietly leave a live checkout running at the
   * provider while telling the customer it was dealt with. Provider
   * cancellation is a different act, with a different label and its own audit
   * trail, and the caller is told to use it rather than having it substituted.
   */
  if (adapter?.cancelPayment && !input.confirmed) {
    return {
      outcome: "ABANDON_CONFIRMATION_REQUIRED",
      status: row.status,
      actions: actionsFor(row.status),
      warning:
        "This checkout is still open and your payment provider can close it properly. Stopping it there is the better outcome; abandoning only removes it from your active Billing view.",
      confirmation: { canConfirmAbandon: true },
    };
  }

  return recordLocalAbandonment(row, actionsFor);
}

/**
 * Write the customer's decision, conditionally.
 *
 * The update is a COMPARE-AND-SET on PENDING, so two confirmations racing
 * produce one transition — and a provider result that landed between the
 * observation and this write wins, because the row is no longer PENDING and
 * the update matches nothing.
 */
async function recordLocalAbandonment(
  row: { id: string; status: prismaPkg.PaymentStatus; provider: prismaPkg.PaymentProvider },
  actionsFor: (status: prismaPkg.PaymentStatus) => PaymentRowActions,
): Promise<PaymentAbandonResult> {
  const written = await prisma.payment.updateMany({
    where: { id: row.id, status: prismaPkg.PaymentStatus.PENDING },
    data: { status: prismaPkg.PaymentStatus.ABANDONED },
  });

  if (written.count === 0) {
    // Something moved it first — a webhook, a concurrent re-check, another
    // confirmation. Whatever it is now is the truth, and it is not ours to
    // overwrite.
    const current = await prisma.payment.findUniqueOrThrow({
      where: { id: row.id },
      select: { status: true },
    });
    return {
      outcome:
        current.status === prismaPkg.PaymentStatus.ABANDONED
          ? "ALREADY_ABANDONED"
          : "PROVIDER_ANSWERED",
      status: current.status,
      actions: actionsFor(current.status),
    };
  }

  bump("billing_payment_abandoned_total");
  return {
    outcome: "ABANDONED",
    status: prismaPkg.PaymentStatus.ABANDONED,
    actions: actionsFor(prismaPkg.PaymentStatus.ABANDONED),
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
        // NOT "nothing has been charged": we have just said we could not ask.
        // What we can state is what WE did, which is nothing.
        "We could not reach your payment provider, so this payment is unchanged in PROOVRA. Please try again shortly.",
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
