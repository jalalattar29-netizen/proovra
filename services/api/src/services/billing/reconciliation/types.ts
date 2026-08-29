/**
 * BILLING RECONCILIATION (2026-08-27) — the shared internal observation model.
 *
 * WHY AN OBSERVATION AND NOT A PROVIDER OBJECT
 * ---------------------------------------------------------------------------
 * A webhook and a reconciliation poll learn the same fact by different routes:
 * one is pushed and signature-verified, the other is pulled and answered by an
 * authenticated request we initiated. What they learn — "this provider
 * subscription is active until X", "this payment settled for N cents" — is the
 * same fact either way, and the domain must not be able to tell them apart.
 *
 * So a provider adapter never touches local state and never returns a provider
 * payload. It returns one of these, and the reconciliation service is the only
 * thing that decides what a fact means. That keeps the number of places that
 * can misread Stripe or PayPal at exactly two — the two adapters — and the
 * number of places that can WRITE a commercial consequence at one.
 *
 * WHAT IS DELIBERATELY ABSENT
 * ---------------------------------------------------------------------------
 * No raw object, no customer id, no invoice id, no payload fragment. A field
 * here exists because a domain rule reads it. `providerRef` is the one
 * identifier that survives, because the durable idempotency constraints are
 * keyed on it — and it never leaves the server.
 */

import type * as prismaPkg from "@prisma/client";

/**
 * The settled state of ONE provider transaction or subscription.
 *
 * `UNKNOWN` is not a failure mode to be tidied away later — it is the answer
 * whenever the provider could not be reached, answered malformed, or reported
 * something this version does not model. Every consumer treats it as "learn
 * nothing, change nothing". An adapter that cannot say SUCCEEDED must say
 * UNKNOWN; there is no path that infers success from silence.
 */
export type ObservedState =
  /** Money captured and settled. The only state that may grant anything. */
  | "SUCCEEDED"
  /** Authorized or awaiting settlement. Grants nothing. */
  | "PENDING"
  /** The provider declined, denied or reversed the charge. */
  | "FAILED"
  /** The subscription or order was cancelled at the provider. */
  | "CANCELED"
  /**
   * BILLING SURFACE CORRECTION (2026-08-29) — the provider's window CLOSED
   * without a charge being attempted.
   *
   * Distinct from CANCELED because the customer did nothing and from FAILED
   * because no money was ever asked for. A Stripe Checkout Session that timed
   * out, or one this product asked Stripe to expire, lands here.
   */
  | "EXPIRED"
  /**
   * The provider returned the money. Only ever produced when the canonical
   * lifecycle has a real writer for it — see `PaymentStatus.REFUNDED`.
   */
  | "REFUNDED"
  /** Unreachable, malformed, or a state this version does not model. */
  | "UNKNOWN";

/** Why an observation could not be turned into a fact. Never shown raw. */
export type ObservationFailure =
  /** Unreachable: DNS, timeout, connection reset, or a provider 5xx. */
  | "PROVIDER_UNAVAILABLE"
  /** The provider answered, and the answer was not the shape we asked about. */
  | "PROVIDER_MALFORMED"
  /** The provider has never heard of this reference. */
  | "NOT_FOUND"
  /** A state this version does not model. */
  | "UNSUPPORTED_STATE"
  /**
   * BILLING PAYMENT LIFECYCLE (2026-08-30) — the provider REFUSED US.
   *
   * A 401 or 403 is an operator problem — a rotated credential, a revoked
   * app, the wrong environment — and it is not a fact about the customer's
   * payment. It was reported as "unavailable", which told the customer to try
   * again later when no amount of waiting could help and nothing was raised
   * for the person who could fix it.
   */
  | "AUTHORIZATION_FAILED"
  /**
   * The stored reference cannot be asked about AT ALL.
   *
   * Blank, or a shape no provider endpoint accepts. A legacy row can carry
   * one, and no provider call will ever resolve it — so re-checking for ever
   * is not a remedy, and the surface has to say so.
   */
  | "REFERENCE_INVALID";

/**
 * ONE provider payment, as observed.
 *
 * `amountCents` and `currency` are what the PROVIDER says it charged. They are
 * carried so the service can compare them against the server catalog and
 * refuse a mismatch — never so that they can be written as authority.
 */
export type PaymentObservation = {
  kind: "PAYMENT";
  provider: prismaPkg.PaymentProvider;
  /** The provider's own id for this transaction. Server-side only. */
  providerRef: string;
  state: ObservedState;
  amountCents: number | null;
  currency: string | null;
  /**
   * Units the provider confirms were bought. For an evidence credit this is
   * the line quantity; the service still refuses anything but the canonical
   * quantity, so this is a check, not an input.
   */
  quantity: number | null;
  /**
   * The provider's authoritative timestamp for this state, normalized to UTC.
   * The ordering guard reads it: an observation older than the state already
   * recorded is discarded rather than applied.
   */
  observedAtUtc: Date | null;
  /**
   * WHERE THE CUSTOMER CAN FINISH PAYING, when the transaction is still open.
   *
   * BILLING SURFACE CORRECTION (2026-08-29) — a pending payment is only
   * resumable while the provider still holds the flow open, and only the
   * provider knows that. Nothing stores this: it is read from the live object
   * at the moment it is observed, and is null the instant the session is no
   * longer open. That is deliberate — a stored checkout URL outlives the
   * session it points at, and "Resume payment" that lands on an expired
   * Stripe page is worse than no button.
   */
  resumeUrl?: string | null;
  failure?: ObservationFailure;
};

/** ONE provider subscription, as observed. */
export type SubscriptionObservation = {
  kind: "SUBSCRIPTION";
  provider: prismaPkg.PaymentProvider;
  providerRef: string;
  state: ObservedState;
  /** Provider-confirmed paid-through date, UTC. Never synthesised. */
  currentPeriodEndUtc: Date | null;
  /** Provider-confirmed "stops renewing at period end". */
  cancelAtPeriodEnd: boolean;
  observedAtUtc: Date | null;
  /**
   * Bounded recent billing events for this subscription — only what is needed
   * to repair missing local renewal history. An adapter must cap this; the
   * service never asks for "all".
   */
  recentPayments: PaymentObservation[];
  failure?: ObservationFailure;
};

export type Observation = PaymentObservation | SubscriptionObservation;

/**
 * THE adapter contract.
 *
 * Injected, so the contract suites run with deterministic fixtures and no
 * credentials, no SDK and no socket. The production implementations are the
 * only things that hold a provider client.
 */
export type BillingReconciliationProvider = {
  readonly provider: prismaPkg.PaymentProvider;
  /** Observe ONE stored payment binding. Never enumerates the provider. */
  observePayment(providerRef: string): Promise<PaymentObservation>;
  /** Observe ONE stored subscription binding, with bounded recent events. */
  observeSubscription(providerRef: string): Promise<SubscriptionObservation>;
  /**
   * Stop an unsettled payment AT THE PROVIDER.
   *
   * BILLING SURFACE CORRECTION (2026-08-29) — OPTIONAL, and its absence is the
   * point. Stripe can expire an open Checkout Session, so the Stripe adapter
   * implements it. PayPal exposes no operation that cancels an unapproved
   * order — such an order simply lapses — so the PayPal adapter does NOT
   * implement it, and the surface therefore offers no "Cancel payment" on a
   * PayPal row.
   *
   * A local row marked cancelled while the provider still holds a live
   * authorisation is the exact lie this shape exists to make unwritable: there
   * is no code path that can mark one without a provider having answered,
   * because the only thing that can produce `CANCELED` here is the provider.
   */
  cancelPayment?(providerRef: string): Promise<PaymentCancellationResult>;
};

/**
 * What the PROVIDER did when asked to stop an unsettled payment.
 *
 * Carries no provider payload and no error text. `state` is what the
 * transaction is now, as the provider reports it back — never what the caller
 * hoped for.
 */
export type PaymentCancellationResult =
  /** The provider stopped it and reports this terminal state. */
  | { outcome: "STOPPED"; state: ObservedState; observedAtUtc: Date | null }
  /** The provider has no operation for this. Nothing was written anywhere. */
  | { outcome: "UNSUPPORTED" }
  /** It had already settled or already ended. Nothing to stop. */
  | { outcome: "ALREADY_TERMINAL"; state: ObservedState }
  /** Unreachable or malformed. Nothing was written anywhere. */
  | { outcome: "PROVIDER_UNAVAILABLE" };

/** A safe, user-facing reconciliation outcome. Contains no provider data. */
export type ReconciliationOutcome =
  | "NO_CHANGE"
  | "UPDATED"
  | "PENDING"
  | "ACTION_REQUIRED"
  | "PROVIDER_UNAVAILABLE";

/**
 * What a reconciliation run did, in categories a customer can read.
 *
 * Counts only. There is no field here that could carry a provider id, an
 * amount the provider disputed, or an error string — the surface renders this
 * verbatim, so anything unsafe in it would be unsafe on screen.
 */
export type ReconciliationSummary = {
  outcome: ReconciliationOutcome;
  /** Bindings examined. */
  checked: number;
  /** Credits granted by this run, having been paid for and never granted. */
  creditsRestored: number;
  /** Renewal payments recorded that the local history was missing. */
  paymentsRecorded: number;
  /** Subscriptions or add-ons whose lifecycle moved. */
  subscriptionsUpdated: number;
  /** Bindings the provider reported as still pending. */
  pending: number;
  /**
   * Bindings that need a person: the provider and PROOVRA disagree in a way
   * this service will not resolve on its own, or a dependent cancellation
   * could not be completed remotely.
   */
  actionRequired: number;
  /** Bindings the provider could not be reached for. */
  unavailable: number;
  /**
   * Discrepancies recorded for operators — an amount, currency or product that
   * did not match the server catalog. Counted, never described to the client.
   */
  discrepancies: number;
};

export function emptySummary(): ReconciliationSummary {
  return {
    outcome: "NO_CHANGE",
    checked: 0,
    creditsRestored: 0,
    paymentsRecorded: 0,
    subscriptionsUpdated: 0,
    pending: 0,
    actionRequired: 0,
    unavailable: 0,
    discrepancies: 0,
  };
}

/**
 * Resolve the single outcome from the counters.
 *
 * Order matters and is deliberate: a run that repaired something AND hit an
 * unreachable provider is ACTION_REQUIRED, not UPDATED — the customer needs to
 * know the picture is still incomplete more than they need to know part of it
 * worked.
 */
export function resolveOutcome(
  summary: ReconciliationSummary,
): ReconciliationOutcome {
  if (summary.actionRequired > 0 || summary.discrepancies > 0) {
    return "ACTION_REQUIRED";
  }
  if (summary.unavailable > 0) return "PROVIDER_UNAVAILABLE";
  if (
    summary.creditsRestored > 0 ||
    summary.paymentsRecorded > 0 ||
    summary.subscriptionsUpdated > 0
  ) {
    return "UPDATED";
  }
  if (summary.pending > 0) return "PENDING";
  return "NO_CHANGE";
}
