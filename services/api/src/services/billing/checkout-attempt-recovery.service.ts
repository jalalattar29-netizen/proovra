/**
 * BILLING CHECKOUT ATTEMPTS (2026-09-28) — provider-first recovery for PayPal
 * PLAN and EVIDENCE-CREDIT checkout attempts.
 *
 * Three entry points, one rule set:
 *
 *   * `recheckCheckoutAttempt`   — the customer's "Check status" on one row;
 *   * `abandonCheckoutAttempt`   — the customer's local disposition, allowed
 *                                  only after the provider is asked first;
 *   * `reconcileCheckoutAttempts` — the account-wide "Re-check purchases and
 *                                  billing" pass.
 *
 * WHAT A RE-CHECK DOES
 * ---------------------------------------------------------------------------
 * It READS the provider and applies what it learns through the canonical
 * writers the webhook uses (`applyPayPalSubscriptionState`,
 * `settlePayPalEvidenceCreditOrder`). It creates no provider resource. The
 * single provider mutation it can cause is capturing an evidence-credit order
 * the BUYER HAS ALREADY APPROVED — exactly what the return route and the
 * CHECKOUT.ORDER.APPROVED webhook do, idempotent at PayPal through the stable
 * `proovra-capture-{orderId}` request id. It never charges anything the buyer
 * did not approve.
 *
 * WHAT IT WILL NOT CLAIM
 * ---------------------------------------------------------------------------
 * A 401, 404, malformed reference, unsupported status, unbound attempt or
 * outage is reported as exactly that. Only a provider answer of "awaiting
 * approval" or "processing" is reported as pending.
 *
 * This module imports no part of `reconciliation.service` (which imports it),
 * so the adapters are always passed in.
 */

import * as prismaPkg from "@prisma/client";

import { prisma } from "../../db.js";
import type { BillingAccountRef } from "./billing-accounts.service.js";
import {
  markCheckoutAttemptAbandoned,
  markCheckoutAttemptProviderCanceled,
  noteCheckoutAttemptCheck,
} from "./checkout-attempts.service.js";
import {
  applyPayPalSubscriptionState,
  settlePayPalEvidenceCreditOrder,
} from "./paypal-settlement.service.js";
import { SELF_SERVICE_BASE_SUBSCRIPTION_PLANS } from "./base-subscription.service.js";
import { terminalizePendingPlanCheckout } from "./subscription-cancellation.service.js";
import {
  settleStripeCheckoutSession,
  type StripeCheckoutSession,
} from "./stripe-settlement.service.js";
import { cancelPayPalSubscription } from "../paypal.service.js";
import { stripeGet } from "../stripe.service.js";
import {
  classifyStripeFailure,
  isStripeHostedCheckoutUrl,
} from "./reconciliation/stripe.provider.js";
import {
  withoutProviderStatus,
  type BillingReconciliationProvider,
  type AttemptWaitingFor,
  type CheckoutAttemptReconciliation,
  type ObservationFailure,
  type ReconciliationSummary,
  type StorageAttemptOutcome,
} from "./reconciliation/types.js";

const A = prismaPkg.BillingCheckoutAttemptStatus;

export type CheckoutRecoveryDeps = {
  providers: Partial<Record<prismaPkg.PaymentProvider, BillingReconciliationProvider>>;
  /** Injected by tests; production uses the canonical settlement writers. */
  applySubscription?: typeof applyPayPalSubscriptionState;
  settleOrder?: typeof settlePayPalEvidenceCreditOrder;
  /** Stripe: read ONE Checkout Session (throws StripeHttpError). */
  readStripeSession?: (sessionId: string) => Promise<StripeCheckoutSession & { url?: string | null }>;
  /** Stripe: canonical session settlement (webhook's writer). */
  settleStripeSession?: typeof settleStripeCheckoutSession;
  /** PayPal: ask PayPal to cancel an unapproved subscription. */
  cancelPayPalPlan?: (subscriptionId: string) => Promise<unknown>;
};

async function defaultReadStripeSession(
  sessionId: string,
): Promise<StripeCheckoutSession & { url?: string | null }> {
  return (await stripeGet(
    `/checkout/sessions/${encodeURIComponent(sessionId)}`,
  )) as StripeCheckoutSession & { url?: string | null };
}

/** How many attempts one account-wide pass examines. Bounded, always. */
export const MAX_ATTEMPTS_PER_RUN = 25;
/** Abandoned attempts are still re-read (provider truth wins) for this long. */
export const ABANDONED_RECHECK_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export function failureOutcome(
  failure: ObservationFailure | undefined,
): StorageAttemptOutcome {
  switch (failure) {
    case "NOT_FOUND":
      return "PROVIDER_REFERENCE_NOT_FOUND";
    case "REFERENCE_INVALID":
      return "PROVIDER_REFERENCE_INVALID";
    case "AUTHORIZATION_FAILED":
      return "PROVIDER_AUTHORIZATION_FAILED";
    case "PROVIDER_MALFORMED":
    case "UNSUPPORTED_STATE":
      return "PROVIDER_MALFORMED";
    default:
      return "PROVIDER_UNAVAILABLE";
  }
}

/** The outcomes that mean "the provider cannot prove how this ended". */
export const UNVERIFIABLE_OUTCOMES: ReadonlySet<StorageAttemptOutcome> = new Set([
  "NOT_PROVIDER_BOUND",
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_REFERENCE_NOT_FOUND",
  "PROVIDER_REFERENCE_INVALID",
  "PROVIDER_AUTHORIZATION_FAILED",
  "PROVIDER_MALFORMED",
]);

type LoadedAttempt =
  | {
      source: "ATTEMPT";
      id: string;
      product: prismaPkg.BillingCheckoutProduct;
      provider: prismaPkg.PaymentProvider;
      providerResourceId: string | null;
      status: prismaPkg.BillingCheckoutAttemptStatus;
      checkoutState: string;
      createdAt: Date;
    }
  | {
      /** A TRIALING PayPal subscription with no attempt row (pre-attempt era). */
      source: "LEGACY_SUBSCRIPTION";
      id: string;
      product: "PLAN";
      provider: prismaPkg.PaymentProvider;
      providerResourceId: string;
      status: prismaPkg.SubscriptionStatus;
      createdAt: Date;
    };

function notFound(): Error {
  const err: Error & { statusCode?: number } = new Error("Checkout attempt not found");
  err.statusCode = 404;
  return err;
}

/**
 * Load ONE attempt that belongs to THIS account. A missing row and another
 * account's row are the same 404, so the route cannot be used to probe ids.
 */
export async function loadOwnedCheckoutAttempt(
  account: BillingAccountRef,
  attemptId: string,
): Promise<LoadedAttempt | null> {
  if (account.type !== "PERSONAL") return null;
  const attempt = await prisma.billingCheckoutAttempt.findFirst({
    where: { id: attemptId, userId: account.id },
  });
  if (attempt) {
    return {
      source: "ATTEMPT",
      id: attempt.id,
      product: attempt.product,
      provider: attempt.provider,
      providerResourceId: attempt.providerResourceId,
      status: attempt.status,
      checkoutState: attempt.checkoutState,
      createdAt: attempt.createdAt,
    };
  }
  const legacy = await prisma.subscription.findFirst({
    where: {
      id: attemptId,
      userId: account.id,
      provider: prismaPkg.PaymentProvider.PAYPAL,
      plan: { in: [...SELF_SERVICE_BASE_SUBSCRIPTION_PLANS] },
      status: prismaPkg.SubscriptionStatus.TRIALING,
    },
    select: { id: true, provider: true, providerSubId: true, status: true, createdAt: true },
  });
  if (!legacy || !legacy.providerSubId) return null;
  const bound = await prisma.billingCheckoutAttempt.findFirst({
    where: { provider: legacy.provider, providerResourceId: legacy.providerSubId },
    select: { id: true },
  });
  if (bound) return null;
  return {
    source: "LEGACY_SUBSCRIPTION",
    id: legacy.id,
    product: "PLAN",
    provider: legacy.provider,
    providerResourceId: legacy.providerSubId,
    status: legacy.status,
    createdAt: legacy.createdAt,
  };
}

async function currentStatusOf(attempt: LoadedAttempt): Promise<string> {
  if (attempt.source === "ATTEMPT") {
    const row = await prisma.billingCheckoutAttempt.findUnique({
      where: { id: attempt.id },
      select: { status: true },
    });
    return row?.status ?? attempt.status;
  }
  const row = await prisma.subscription.findUnique({
    where: { id: attempt.id },
    select: { status: true },
  });
  return row?.status ?? attempt.status;
}

function baseResult(attempt: LoadedAttempt): Omit<CheckoutAttemptReconciliation, "currentStatus" | "outcome"> {
  return {
    attemptId: attempt.id,
    product:
      attempt.product === "EVIDENCE_CREDIT"
        ? "EVIDENCE_CREDIT"
        : attempt.product === "STORAGE_ADDON"
          ? "STORAGE"
          : "PLAN",
    createdAtUtc: attempt.createdAt.toISOString(),
    provider: attempt.provider,
    providerBound: Boolean(attempt.providerResourceId),
    previousStatus: attempt.status,
    locallyAbandoned: attempt.status === A.ABANDONED,
  };
}

/** What a STILL_PENDING attempt is waiting for, from the provider's own status word. */
function waitingForOf(attempt: LoadedAttempt, providerStatus: string | null): AttemptWaitingFor {
  const status = (providerStatus ?? "").toUpperCase();
  if (attempt.provider === prismaPkg.PaymentProvider.STRIPE) {
    return status === "OPEN" ? "PAYMENT_PAGE" : "PAYMENT_PROCESSING";
  }
  if (attempt.product === "PLAN" || attempt.product === "STORAGE_ADDON") {
    return status === "APPROVED" ? "ACTIVATION" : "APPROVAL";
  }
  return status === "CREATED" || status === "SAVED" || status === "PAYER_ACTION_REQUIRED" || status === ""
    ? "APPROVAL"
    : "PAYMENT_PROCESSING";
}

export type CheckoutAttemptCheck = CheckoutAttemptReconciliation & {
  /** Raw provider status, kept server-side for the abandon decision. */
  providerStatus?: string | null;
};

async function checkAttempt(
  attempt: LoadedAttempt,
  account: BillingAccountRef,
  deps: CheckoutRecoveryDeps,
): Promise<CheckoutAttemptCheck> {
  const base = baseResult(attempt);
  const finish = async (
    outcome: StorageAttemptOutcome,
    extra: { resumeUrl?: string | null; providerStatus?: string | null } = {},
  ): Promise<CheckoutAttemptCheck> => {
    if (attempt.source === "ATTEMPT") {
      await noteCheckoutAttemptCheck({ attemptId: attempt.id, outcome }).catch(() => undefined);
    }
    const waitingFor = outcome === "STILL_PENDING" ? waitingForOf(attempt, extra.providerStatus ?? null) : null;
    return {
      ...base,
      currentStatus: await currentStatusOf(attempt),
      outcome,
      ...(waitingFor ? { waitingFor } : {}),
      ...(extra.resumeUrl ? { resumeUrl: extra.resumeUrl } : {}),
      ...(extra.providerStatus !== undefined ? { providerStatus: extra.providerStatus } : {}),
    };
  };

  const ref = attempt.providerResourceId;
  if (!ref) return finish("NOT_PROVIDER_BOUND");

  const adapter = deps.providers[attempt.provider];
  if (!adapter) return finish("PROVIDER_UNAVAILABLE");

  const before = attempt.status;

  if (attempt.provider === prismaPkg.PaymentProvider.STRIPE) {
    // Every Stripe attempt is bound to ONE Checkout Session, whatever the
    // product. The session is read live and applied through the same writer
    // the checkout.session.* webhooks use.
    let session: StripeCheckoutSession & { url?: string | null };
    try {
      session = await (deps.readStripeSession ?? defaultReadStripeSession)(ref);
    } catch (err) {
      return finish(failureOutcome(classifyStripeFailure(err)));
    }
    if (!session || session.id !== ref) return finish("PROVIDER_MALFORMED");
    let settled: Awaited<ReturnType<typeof settleStripeCheckoutSession>>;
    try {
      settled = await (deps.settleStripeSession ?? settleStripeCheckoutSession)({
        session,
        expectedUserId: account.id,
        applyPlanSubscription: true,
      });
    } catch {
      return finish("PROVIDER_UNAVAILABLE");
    }
    if (settled.outcome === "REJECTED" && settled.reason === "NOT_OWNED") {
      return finish("PROVIDER_MALFORMED");
    }
    const open = (session.status ?? "").toLowerCase() === "open";
    const unsettled =
      (session.status ?? "").toLowerCase() === "complete" &&
      (session.payment_status ?? "").toLowerCase() !== "paid";
    const after = await currentStatusOf(attempt);
    const outcome: StorageAttemptOutcome =
      after !== before ? "UPDATED" : settled.outcome === "PENDING" ? "STILL_PENDING" : "NO_CHANGE";
    return finish(outcome, {
      resumeUrl: open && isStripeHostedCheckoutUrl(session.url) ? session.url ?? null : null,
      // `CAPTURE_PENDING`: the customer paid by a method still settling —
      // never abandonable. `OPEN`: the payment page is still usable.
      providerStatus: unsettled ? "CAPTURE_PENDING" : open ? "OPEN" : (session.status ?? null),
    });
  }

  if (attempt.product === "STORAGE_ADDON") {
    // PayPal storage checkouts are tracked on the storage add-on row itself,
    // never as an attempt; nothing else can create one.
    return finish("PROVIDER_MALFORMED");
  }

  if (attempt.product === "PLAN") {
    const observation = await adapter.observeSubscription(ref);
    if (observation.state === "UNKNOWN") {
      return finish(failureOutcome(observation.failure));
    }
    try {
      const applied = await (deps.applySubscription ?? applyPayPalSubscriptionState)({
        subscriptionId: ref,
        expectedUserId: account.id,
        source: "checkout_attempt_recheck",
      });
      // BILLING PAYPAL INTEGRITY (2026-09-28) — a subscription the settlement
      // refused to apply (not this account's, unattributable) is not "no
      // change": the provider object does not match the attempt.
      if (applied.outcome === "REJECTED" && applied.reason !== "STORAGE_ADDON_REFUSED") {
        return finish("PROVIDER_MALFORMED", { providerStatus: observation.providerStatus ?? null });
      }
    } catch {
      return finish("PROVIDER_UNAVAILABLE");
    }
    const after = await currentStatusOf(attempt);
    const outcome: StorageAttemptOutcome =
      after !== before ? "UPDATED" : observation.state === "PENDING" ? "STILL_PENDING" : "NO_CHANGE";
    return finish(outcome, {
      resumeUrl: observation.state === "PENDING" ? observation.resumeUrl ?? null : null,
      providerStatus: observation.providerStatus ?? null,
    });
  }

  // EVIDENCE_CREDIT
  const observation = await adapter.observePayment(ref);
  if (observation.state === "UNKNOWN") {
    return finish(failureOutcome(observation.failure));
  }
  let settledPending = false;
  try {
    const settled = await (deps.settleOrder ?? settlePayPalEvidenceCreditOrder)({
      orderId: ref,
      expectedUserId: account.id,
      capture: true,
    });
    settledPending = settled.outcome === "PENDING";
    if (settled.outcome === "REJECTED" && settled.reason !== "AMOUNT_MISMATCH") {
      return finish("PROVIDER_MALFORMED");
    }
  } catch {
    return finish("PROVIDER_UNAVAILABLE");
  }
  const after = await currentStatusOf(attempt);
  const outcome: StorageAttemptOutcome =
    after !== before ? "UPDATED" : settledPending ? "STILL_PENDING" : "NO_CHANGE";
  return finish(outcome, {
    resumeUrl: observation.resumeUrl ?? null,
    providerStatus: observation.providerStatus ?? null,
  });
}

/** Re-check ONE plan or credit attempt this account owns. */
export async function recheckCheckoutAttempt(input: {
  account: BillingAccountRef;
  attemptId: string;
  deps: CheckoutRecoveryDeps;
}): Promise<CheckoutAttemptCheck> {
  const attempt = await loadOwnedCheckoutAttempt(input.account, input.attemptId);
  if (!attempt) throw notFound();
  return checkAttempt(attempt, input.account, input.deps);
}

export type CheckoutAttemptAbandonResult =
  | CheckoutAttemptCheck
  | {
      attemptId: string;
      outcome:
        | "ABANDON_CONFIRMATION_REQUIRED"
        | "ABANDONED"
        | "ALREADY_RESOLVED"
        | "ABANDON_NOT_ALLOWED"
        /** The provider could not confirm the stop; nothing was written. */
        | "PROVIDER_CANCEL_FAILED";
      warning?: string;
      /**
       * Whether the PROVIDER confirmed it stopped the checkout (Stripe
       * expired the session / PayPal cancelled the subscription). On a
       * confirmation request: whether PROOVRA will ask it to.
       */
      cancelsAtProvider: boolean;
    };

/**
 * Provider statuses that mean the buyer already acted and money may be
 * moving. An attempt in one of these is never abandoned locally: the next
 * webhook or re-check applies it.
 */
const IN_FLIGHT_PROVIDER_STATUSES = new Set([
  "APPROVED",
  "CAPTURE_PENDING",
  "CAPTURE_COMPLETED",
  "COMPLETED",
]);

function providerName(provider: prismaPkg.PaymentProvider | null | undefined): string {
  return provider === prismaPkg.PaymentProvider.STRIPE ? "Stripe" : "PayPal";
}

export function abandonWarning(check: {
  outcome: StorageAttemptOutcome;
  provider?: prismaPkg.PaymentProvider | null;
  product?: string;
}): string {
  if (check.provider === prismaPkg.PaymentProvider.STRIPE) {
    const tail =
      " If Stripe later confirms a payment for it, PROOVRA will still apply that payment.";
    return check.outcome === "STILL_PENDING"
      ? "Stripe still shows this checkout page as open and unpaid. Abandoning asks Stripe to close it, so it can no longer be paid. Nothing has been charged." + tail
      : "Stripe could not confirm how this checkout ended. Abandoning only removes it from PROOVRA's open purchases so you can start again; it does not refund anything." + tail;
  }
  const tail =
    check.outcome === "STILL_PENDING" && check.product === "PLAN"
      ? " PROOVRA will also ask PayPal to cancel the unapproved subscription; PayPal may keep an unapproved one on its side until it expires, but it cannot charge you without your approval. If PayPal later confirms a payment for it, PROOVRA will still apply that payment."
      : " Abandoning only removes it from PROOVRA's open purchases so you can start again. It does not cancel, reverse or refund anything at PayPal. If PayPal later confirms a payment for it, PROOVRA will still apply that payment.";
  switch (check.outcome) {
    case "STILL_PENDING":
      return "PayPal still shows this checkout as waiting for your approval. Nothing is charged unless you approve it at PayPal." + tail;
    case "NOT_PROVIDER_BOUND":
      return "PayPal never confirmed that this checkout was created, so PROOVRA has no PayPal reference for it. Nothing can be charged without your approval at PayPal." + tail;
    case "PROVIDER_REFERENCE_NOT_FOUND":
      return "PayPal no longer has a record of this checkout. It was not approved through PROOVRA." + tail;
    case "PROVIDER_UNAVAILABLE":
      return "PayPal could not be reached to confirm how this checkout ended." + tail;
    default:
      return "PayPal could not confirm how this checkout ended." + tail;
  }
}

/** Provider-first local abandonment of ONE plan or credit attempt. */
export async function abandonCheckoutAttempt(input: {
  account: BillingAccountRef;
  attemptId: string;
  confirmed?: boolean;
  deps: CheckoutRecoveryDeps;
}): Promise<CheckoutAttemptAbandonResult> {
  const attempt = await loadOwnedCheckoutAttempt(input.account, input.attemptId);
  if (!attempt) throw notFound();

  const check = await checkAttempt(attempt, input.account, input.deps);
  const stillOpen =
    check.currentStatus === A.PENDING ||
    check.currentStatus === prismaPkg.SubscriptionStatus.TRIALING;
  if (!stillOpen) {
    // The provider settled it (or it already was): its answer is what stands.
    return check.outcome === "UPDATED"
      ? check
      : { attemptId: attempt.id, outcome: "ALREADY_RESOLVED", cancelsAtProvider: false };
  }

  const checkoutState =
    attempt.source === "ATTEMPT"
      ? (
          await prisma.billingCheckoutAttempt.findUnique({
            where: { id: attempt.id },
            select: { checkoutState: true },
          })
        )?.checkoutState
      : null;
  if (
    (check.providerStatus && IN_FLIGHT_PROVIDER_STATUSES.has(check.providerStatus)) ||
    checkoutState === "CAPTURE_PENDING" ||
    checkoutState === "APPROVED_AWAITING_ACTIVATION" ||
    checkoutState === "NEEDS_REVIEW"
  ) {
    return {
      attemptId: attempt.id,
      outcome: "ABANDON_NOT_ALLOWED",
      warning: `${providerName(attempt.provider)} shows this purchase as approved and being processed, so it cannot be abandoned. PROOVRA will apply it as soon as ${providerName(attempt.provider)} completes it.`,
      cancelsAtProvider: false,
    };
  }

  const eligible = check.outcome === "STILL_PENDING" || UNVERIFIABLE_OUTCOMES.has(check.outcome);
  if (!eligible) {
    return { attemptId: attempt.id, outcome: "ALREADY_RESOLVED", cancelsAtProvider: false };
  }

  // Ask the provider to STOP it when the provider can: an open Stripe
  // Checkout Session can be expired; a PayPal subscription that is still
  // APPROVAL_PENDING may be cancellable. An unverifiable attempt (unbound, not
  // found, unauthorized, outage) cannot be stopped, only abandoned locally.
  const stopAtProvider =
    check.outcome === "STILL_PENDING" &&
    Boolean(attempt.providerResourceId) &&
    (attempt.provider === prismaPkg.PaymentProvider.STRIPE ||
      (attempt.provider === prismaPkg.PaymentProvider.PAYPAL && attempt.product === "PLAN"));

  if (!input.confirmed) {
    return {
      attemptId: attempt.id,
      outcome: "ABANDON_CONFIRMATION_REQUIRED",
      warning: abandonWarning({ ...check, provider: attempt.provider, product: attempt.product }),
      // Promised only where the provider reliably honours it: Stripe expires
      // an open session. PayPal usually refuses to cancel an unapproved
      // subscription, so nothing is promised for it.
      cancelsAtProvider: stopAtProvider && attempt.provider === prismaPkg.PaymentProvider.STRIPE,
    };
  }

  let cancelsAtProvider = false;
  if (stopAtProvider && attempt.providerResourceId) {
    if (attempt.provider === prismaPkg.PaymentProvider.STRIPE) {
      const adapter = input.deps.providers[attempt.provider];
      const stopped = adapter?.cancelPayment
        ? await adapter.cancelPayment(attempt.providerResourceId)
        : ({ outcome: "UNSUPPORTED" } as const);
      if (stopped.outcome === "ALREADY_TERMINAL") {
        // It ended (paid, or expired) between the check and the stop: apply
        // what Stripe says instead of hiding it.
        const again = await checkAttempt(attempt, input.account, input.deps);
        return again.outcome === "UPDATED"
          ? again
          : { attemptId: attempt.id, outcome: "ALREADY_RESOLVED", cancelsAtProvider: false };
      }
      if (stopped.outcome !== "STOPPED") {
        // A Stripe payment page that may still be payable is never hidden.
        return {
          attemptId: attempt.id,
          outcome: "PROVIDER_CANCEL_FAILED",
          warning:
            "Stripe could not confirm that this checkout page was closed, so it is still shown as open. Try again in a moment.",
          cancelsAtProvider: false,
        };
      }
      const changed =
        attempt.source === "ATTEMPT" &&
        (await markCheckoutAttemptProviderCanceled({
          attemptId: attempt.id,
          userId: input.account.id,
          observedAtUtc: stopped.observedAtUtc,
        }));
      return {
        attemptId: attempt.id,
        outcome: changed ? "ABANDONED" : "ALREADY_RESOLVED",
        cancelsAtProvider: true,
      };
    }

    // PayPal plan: an APPROVAL_PENDING subscription. PayPal documents cancel
    // for ACTIVE/SUSPENDED subscriptions and answers 422 for others, so a
    // refusal is expected and is NOT a failure: the buyer never approved it
    // and PayPal cannot bill it. Only a confirmed 2xx is reported as a stop.
    try {
      await (input.deps.cancelPayPalPlan ??
        ((id: string) => cancelPayPalSubscription(id, "Checkout abandoned by customer")))(
        attempt.providerResourceId,
      );
      cancelsAtProvider = true;
    } catch {
      // 422 (not cancellable in this state), or unreachable: the attempt is
      // abandoned locally only, and the customer is told exactly that.
      cancelsAtProvider = false;
    }
  }

  let changed = false;
  if (cancelsAtProvider && attempt.source === "ATTEMPT") {
    changed = await markCheckoutAttemptProviderCanceled({
      attemptId: attempt.id,
      userId: input.account.id,
    });
    if (attempt.product === "PLAN" && attempt.providerResourceId) {
      const sub = await prisma.subscription.findFirst({
        where: {
          provider: attempt.provider,
          providerSubId: attempt.providerResourceId,
          userId: input.account.id,
          status: prismaPkg.SubscriptionStatus.TRIALING,
        },
        select: { id: true },
      });
      if (sub) await terminalizePendingPlanCheckout({ subscriptionId: sub.id });
    }
  } else if (attempt.source === "ATTEMPT") {
    changed = await markCheckoutAttemptAbandoned({ attemptId: attempt.id, userId: input.account.id });
    if (attempt.product === "PLAN" && attempt.providerResourceId) {
      const sub = await prisma.subscription.findFirst({
        where: {
          provider: attempt.provider,
          providerSubId: attempt.providerResourceId,
          userId: input.account.id,
          status: prismaPkg.SubscriptionStatus.TRIALING,
        },
        select: { id: true },
      });
      if (sub) await terminalizePendingPlanCheckout({ subscriptionId: sub.id });
    }
  } else {
    await terminalizePendingPlanCheckout({ subscriptionId: attempt.id });
    changed = true;
  }
  return {
    attemptId: attempt.id,
    outcome: changed ? "ABANDONED" : "ALREADY_RESOLVED",
    cancelsAtProvider,
  };
}

/**
 * The account-wide pass over plan and credit attempts: every PENDING attempt,
 * recently ABANDONED ones (a later provider-proven payment still wins), and
 * pre-attempt TRIALING PayPal subscriptions. Counted into `summary` so the
 * page can say what was checked and what still needs the customer.
 */
export async function reconcileCheckoutAttempts(input: {
  account: BillingAccountRef;
  summary: ReconciliationSummary;
  deps: CheckoutRecoveryDeps;
  now?: Date;
}): Promise<void> {
  if (input.account.type !== "PERSONAL") return;
  const now = input.now ?? new Date();

  const rows = await prisma.billingCheckoutAttempt.findMany({
    where: {
      userId: input.account.id,
      OR: [
        { status: A.PENDING },
        {
          status: A.ABANDONED,
          providerResourceId: { not: null },
          createdAt: { gte: new Date(now.getTime() - ABANDONED_RECHECK_WINDOW_MS) },
        },
      ],
    },
    orderBy: { createdAt: "desc" },
    take: MAX_ATTEMPTS_PER_RUN,
    select: { id: true },
  });

  const legacy = await prisma.subscription.findMany({
    where: {
      userId: input.account.id,
      provider: prismaPkg.PaymentProvider.PAYPAL,
      plan: { in: [...SELF_SERVICE_BASE_SUBSCRIPTION_PLANS] },
      status: prismaPkg.SubscriptionStatus.TRIALING,
    },
    orderBy: { createdAt: "desc" },
    take: MAX_ATTEMPTS_PER_RUN,
    select: { id: true },
  });

  const ids = [...rows.map((r) => r.id), ...legacy.map((r) => r.id)];
  const seen = new Set<string>();
  for (const id of ids) {
    const attempt = await loadOwnedCheckoutAttempt(input.account, id);
    if (!attempt || seen.has(attempt.id)) continue;
    seen.add(attempt.id);

    const check = await checkAttempt(attempt, input.account, input.deps);
    let result = withoutProviderStatus(check);
    if (isExpiredApproval(check, attempt, now)) {
      const expired = await expireUnapprovedAttempt({ attempt, account: input.account, deps: input.deps });
      if (expired) {
        result = { ...result, outcome: "UPDATED", currentStatus: expired, waitingFor: undefined };
      }
    }
    input.summary.attempts.push(result);
    input.summary.checked += 1;
    countAttemptOutcome(input.summary, result);
  }
}

/**
 * BILLING PAYPAL INTEGRITY (2026-09-28) — how long an attempt may wait for the
 * buyer's APPROVAL before PROOVRA closes it. PayPal does not announce when an
 * unapproved subscription or order stops being approvable, and the page used
 * to tell customers to "wait for it to expire" — an expiry no code observed,
 * while the open attempt blocked every new plan checkout. After this window
 * the attempt is closed provider-first (PayPal is asked; only an approval it
 * still reports as NOT approved is closed), exactly as the customer's own
 * Abandon would, and a later provider-proven payment still wins.
 */
export const APPROVAL_EXPIRY_MS = 24 * 60 * 60 * 1000;

function isExpiredApproval(check: CheckoutAttemptCheck, attempt: LoadedAttempt, now: Date): boolean {
  return (
    check.outcome === "STILL_PENDING" &&
    check.waitingFor === "APPROVAL" &&
    now.getTime() - attempt.createdAt.getTime() > APPROVAL_EXPIRY_MS &&
    (check.currentStatus === A.PENDING || check.currentStatus === prismaPkg.SubscriptionStatus.TRIALING)
  );
}

/** Close one approval-expired attempt, provider-first. Returns its new status, or null. */
async function expireUnapprovedAttempt(input: {
  attempt: LoadedAttempt;
  account: BillingAccountRef;
  deps: CheckoutRecoveryDeps;
}): Promise<string | null> {
  const result = await abandonCheckoutAttempt({
    account: input.account,
    attemptId: input.attempt.id,
    confirmed: true,
    deps: input.deps,
  });
  if (result.outcome !== "ABANDONED") return null;
  if (input.attempt.source === "ATTEMPT") {
    await prisma.billingCheckoutAttempt.updateMany({
      where: { id: input.attempt.id, status: { in: [A.ABANDONED, A.CANCELED] } },
      data: { checkoutState: "LOCALLY_EXPIRED" },
    });
  }
  return await currentStatusOf(input.attempt);
}

/**
 * Close every approval-expired PLAN attempt of one payer before a new plan
 * checkout is opened, so an approval nobody will finish does not block the
 * purchase the customer is trying to make now. Provider-first; an attempt
 * PayPal reports as approved or paid is never closed.
 */
export async function expireStalePlanAttempts(input: {
  userId: string;
  deps: CheckoutRecoveryDeps;
  now?: Date;
}): Promise<number> {
  const now = input.now ?? new Date();
  const account: BillingAccountRef = {
    type: "PERSONAL",
    id: input.userId,
    displayName: "",
    capabilities: ["BILLING_MANAGE"],
    billingOwnerMissing: false,
  };
  const stale = await prisma.billingCheckoutAttempt.findMany({
    where: {
      userId: input.userId,
      product: prismaPkg.BillingCheckoutProduct.PLAN,
      status: A.PENDING,
      createdAt: { lt: new Date(now.getTime() - APPROVAL_EXPIRY_MS) },
    },
    select: { id: true },
    take: 5,
  });
  let closed = 0;
  for (const row of stale) {
    const attempt = await loadOwnedCheckoutAttempt(account, row.id);
    if (!attempt) continue;
    const check = await checkAttempt(attempt, account, input.deps);
    if (!isExpiredApproval(check, attempt, now)) continue;
    if (await expireUnapprovedAttempt({ attempt, account, deps: input.deps })) closed += 1;
  }
  return closed;
}

/** Shared counting rule for every attempt kind. */
export function countAttemptOutcome(
  summary: ReconciliationSummary,
  result: Pick<CheckoutAttemptReconciliation, "outcome" | "locallyAbandoned">,
): void {
  if (result.outcome === "UPDATED") {
    summary.attemptsUpdated += 1;
    return;
  }
  // An attempt the customer already abandoned needs nothing more from them;
  // a provider that no longer knows it is the expected answer, not an alarm.
  if (result.locallyAbandoned) return;
  if (result.outcome === "STILL_PENDING") summary.pending += 1;
  else if (result.outcome === "PROVIDER_UNAVAILABLE") summary.unavailable += 1;
  else if (UNVERIFIABLE_OUTCOMES.has(result.outcome)) summary.actionRequired += 1;
}
