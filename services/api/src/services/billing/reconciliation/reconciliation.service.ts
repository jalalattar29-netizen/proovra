/**
 * BILLING RECONCILIATION (2026-08-27) — THE canonical reconciliation service.
 *
 * THE PROBLEM
 * ---------------------------------------------------------------------------
 * A provider webhook can be lost. It can be dropped in transit, rejected by a
 * deploy, or processed into a failure that is never retried. When that happens
 * the customer has paid and PROOVRA has recorded nothing: a purchased evidence
 * credit never arrives, a renewal never appears in history, a cancellation the
 * customer made at the provider never reaches us. "Refresh billing status"
 * re-read local rows, which by definition could not help.
 *
 * THE SHAPE
 * ---------------------------------------------------------------------------
 * Reconciliation NEVER accepts a provider reference. It takes an authenticated
 * actor and a canonical billing account, resolves the bindings THIS SERVER
 * stored for that account, asks the provider about exactly those, and applies
 * the result through the same handlers a verified webhook uses:
 *
 *     account  ->  stored bindings  ->  adapter  ->  observation
 *                                                        |
 *                            validate against local + catalog
 *                                                        |
 *                                  the SAME domain handlers as the webhook
 *
 * That is the whole security argument. There is no field on the wire that
 * names a Stripe session, a PayPal order, an amount, a product or a quantity,
 * so no caller can claim another account's purchase — not because a check
 * rejects the attempt, but because the route accepts nothing to check.
 *
 * WHAT IT WILL NOT DO
 * ---------------------------------------------------------------------------
 *   * It will not grant anything from a PENDING, FAILED, CANCELED or UNKNOWN
 *     observation. An unreachable provider produces UNKNOWN, and UNKNOWN moves
 *     nothing in either direction.
 *   * It will not accept a provider's amount, currency or quantity as
 *     authority. Each is compared against the server catalog and a mismatch
 *     grants nothing and is counted as a discrepancy for an operator.
 *   * It will not apply an observation older than the state already recorded.
 *     `providerStateAtUtc` is the durable ordering field, so a slow poll
 *     cannot resurrect a subscription a newer webhook already cancelled.
 *   * It will not write a second payment ledger. Idempotency is the EXISTING
 *     durable constraints: `payments (provider, providerPaymentId)` and the
 *     partial unique index on PURCHASE credit-ledger rows.
 */

import * as prismaPkg from "@prisma/client";
import { EVIDENCE_CREDIT_PRODUCT } from "@proovra/shared-billing";

import { prisma } from "../../../db.js";
import { recordPayment, setPersonalPlan, type PaymentProduct } from "../../billing.service.js";
import {
  getPlanPriceCents,
  getStorageAddonPriceCents,
  planFromStripePriceId,
} from "../../billing-pricing.service.js";
import { findLivePersonalBaseSubscription } from "../base-subscription.service.js";
import {
  noteProviderReferenceFound,
  noteProviderReferenceMissing,
  referencesNotDue,
} from "../provider-binding-check.service.js";
import { releaseOrphanedStripeSchedule } from "../stripe-schedule.service.js";
import { grantEvidenceCredits } from "../evidence-credits.service.js";
import {
  attemptPayerDependentCancellations,
  confirmObligationFromProviderTruth,
  payerOwnedAddonWhere,
  recordDependentCancellationObligations,
  reopenObligationFromProviderTruth,
  UNRESOLVED_STATES,
} from "../dependent-cancellation.service.js";
import { syncDependentCancellationConditions } from "../dependent-cancellation-conditions.service.js";
import { recordBillingReviewItem } from "../billing-review.service.js";
import { noteProviderObservation } from "../provider-authorization-signal.service.js";
import type { StorageAddonProviderCanceller } from "../storage-addon-cancellation.service.js";
import {
  syncPlanForSubscription,
} from "../subscription-lifecycle.handlers.js";
import type { BillingAccountRef } from "../billing-accounts.service.js";
import { applyStorageSubscriptionObservation } from "../storage-activation.service.js";
import { keepPaidPeriodAfterProviderCancel } from "../paid-period.service.js";
import { parsePayPalStorageAddonCustomId } from "../../paypal-checkout-policy.service.js";
import { StripeBillingReconciliationProvider } from "./stripe.provider.js";
import { PayPalBillingReconciliationProvider } from "./paypal.provider.js";
import { decidePaymentTransition } from "./payment-status.js";
import {
  abandonWarning,
  APPROVAL_EXPIRY_MS,
  countAttemptOutcome,
  reconcileCheckoutAttempts,
  UNVERIFIABLE_OUTCOMES,
} from "../checkout-attempt-recovery.service.js";
import {
  emptySummary,
  resolveOutcome,
  type BillingReconciliationProvider,
  type ObservationFailure,
  type PaymentObservation,
  type ReconciliationSummary,
  type StorageAttemptReconciliation,
  type SubscriptionObservation,
} from "./types.js";

/**
 * Injected adapters, keyed by provider.
 *
 * Contract suites pass deterministic fixtures here; production passes the two
 * real clients. Nothing in this service knows which it received.
 */
export type ReconciliationProviders = Partial<
  Record<prismaPkg.PaymentProvider, BillingReconciliationProvider>
>;

export function defaultReconciliationProviders(): ReconciliationProviders {
  return {
    [prismaPkg.PaymentProvider.STRIPE]: new StripeBillingReconciliationProvider(),
    [prismaPkg.PaymentProvider.PAYPAL]: new PayPalBillingReconciliationProvider(),
  };
}

/** How many bindings one reconciliation run may examine. Bounded, always. */
export const MAX_BINDINGS_PER_RUN = 25;

/**
 * Currency comparison.
 *
 * A provider reports lower-case ISO codes on Stripe and upper-case on PayPal;
 * both adapters normalize to upper-case, and this is the last guard against a
 * provider answering in a currency we never priced.
 */
function currencyMatches(
  observed: string | null,
  supported: readonly string[],
): boolean {
  return observed !== null && supported.includes(observed);
}

const SUPPORTED_CURRENCIES = ["USD", "EUR"] as const;

/**
 * Is this observation at least as new as what we already recorded?
 *
 * `null` on either side means "no ordering information", and the observation
 * is allowed through — refusing on absence would make the first reconciliation
 * of every legacy binding a no-op. Once a provider time IS recorded, an older
 * one can never overwrite it.
 */
function isNotStale(
  observedAtUtc: Date | null,
  recordedAtUtc: Date | null,
): boolean {
  if (!observedAtUtc || !recordedAtUtc) return true;
  // ET-COM-01 — a recorded stamp in the future is a pre-fix period-end stamp and
  // carries no ordering information: treat it as absent.
  if (recordedAtUtc.getTime() > Date.now()) return true;
  return observedAtUtc.getTime() >= recordedAtUtc.getTime();
}

function subscriptionStatusFromObservation(
  observation: SubscriptionObservation,
): prismaPkg.SubscriptionStatus | null {
  switch (observation.state) {
    case "SUCCEEDED":
      return prismaPkg.SubscriptionStatus.ACTIVE;
    case "FAILED":
      return prismaPkg.SubscriptionStatus.PAST_DUE;
    // BILLING SURFACE CORRECTION (2026-08-29) — EXPIRED became a state of its
    // own for PAYMENTS, where "nobody stopped it, the window closed" is a
    // distinction a customer needs. A SUBSCRIPTION has no such distinction:
    // expired and cancelled both mean it is no longer billing, and the local
    // lifecycle has one word for that, so the two share an arm.
    case "CANCELED":
    case "EXPIRED":
      return prismaPkg.SubscriptionStatus.CANCELED;
    case "PENDING":
      return prismaPkg.SubscriptionStatus.TRIALING;
    // REFUNDED and UNKNOWN carry no subscription meaning. Fail closed.
    default:
      return null;
  }
}

/**
 * Reconcile ONE billing account.
 *
 * The caller has ALREADY authorized the account and the capability. This
 * service does not authorize; it is reachable from the route and from the
 * worker, and both resolve authority before calling.
 */
export async function reconcileBillingAccount(input: {
  account: BillingAccountRef;
  providers?: ReconciliationProviders;
  /** Injected by contract tests for the dependent add-on provider calls. */
  cancelAddonAtProvider?: StorageAddonProviderCanceller;
}): Promise<ReconciliationSummary> {
  const providers = input.providers ?? defaultReconciliationProviders();
  const summary = emptySummary();

  await reconcileEvidenceCredits({ account: input.account, providers, summary });
  await reconcileSubscriptions({ account: input.account, providers, summary });
  // BILLING CHECKOUT ATTEMPTS (2026-09-28) — plan and credit checkouts that
  // have not produced a payment: unbound attempts, approvals still open,
  // orders awaiting capture, and pre-attempt TRIALING subscriptions.
  await reconcileCheckoutAttempts({
    account: input.account,
    summary,
    deps: { providers },
  });
  await reconcileStorageAddons({ account: input.account, providers, summary });
  await convergeDependentCancellations({
    account: input.account,
    summary,
    cancelAddonAtProvider: input.cancelAddonAtProvider,
  });

  summary.outcome = resolveOutcome(summary);
  return summary;
}

/**
 * BILLING DEPENDENT-CANCELLATION CONVERGENCE (2026-08-27) — the orphan sweep.
 *
 * THE HOLE THIS CLOSES
 * ---------------------------------------------------------------------------
 * The subscription pass only ever looked at bases whose LOCAL status was
 * ACTIVE, TRIALING or PAST_DUE. A Stripe base that reached its period end had
 * its webhook write CANCELED, which removed it from that selection — so the
 * one place that noticed live dependants stopped being reachable at exactly
 * the moment the orphan became permanent. And what it did notice, it only
 * COUNTED.
 *
 * This pass asks the question the other one could not:
 *
 *   the base is CANCELED, or is scheduled to cancel at period end
 *   AND a recurring add-on that depends on it is still live
 *   OR an obligation on that add-on is unresolved
 *
 * and then it ACTS: it creates the obligation if the crash window swallowed
 * it, attempts the provider, records the result durably, and opens the
 * Operations condition. Nothing here is a count that the caller may discard.
 */
async function convergeDependentCancellations(ctx: {
  account: BillingAccountRef;
  summary: ReconciliationSummary;
  cancelAddonAtProvider?: StorageAddonProviderCanceller;
}): Promise<void> {
  // BILLING PERSONAL/ORGANIZATION MODEL (2026-08-28) — one self-service
  // subject. An ORGANIZATION account is contract-managed and owns no
  // self-service add-on, so it has nothing to converge here.
  if (ctx.account.type !== "PERSONAL") return;
  const scope = { ownerUserId: ctx.account.id, teamId: null as string | null };

  // ---- 1. Create obligations the crash window swallowed --------------------
  //
  // A base that the provider has cancelled — or scheduled to cancel — while a
  // dependent add-on is still live and carries NO obligation is exactly the
  // shape of "the process died between the base provider call and the local
  // transaction". The intent was real; only the record is missing.
  //
  // BILLING PAYPAL INTEGRITY (2026-09-28) — the question is asked PER ADD-ON
  // by the one dependency rule (`owedDependentCancellationTrigger`). It used
  // to be "does ANY cancelled subscription row exist?", which made an
  // abandoned PayPal approval, or a plan cancelled before the customer
  // resubscribed, cancel every live storage add-on at the provider.
  const created = await recordDependentCancellationObligations(
    { ownerUserId: scope.ownerUserId, teamId: scope.teamId },
    prisma,
  );
  if (created.created > 0) {
    ctx.summary.subscriptionsUpdated += created.created;
  }

  // ---- 2. Attempt every unresolved obligation ------------------------------
  //
  // Every obligation this PAYER owns, including legacy workspace-scoped
  // add-ons, which bill through (and can only be acted on from) this Personal
  // account. Each subject keeps its own dependency re-validation.
  const attempt = await attemptPayerDependentCancellations({
    userId: scope.ownerUserId,
    cancelAtProvider: ctx.cancelAddonAtProvider,
  });
  ctx.summary.subscriptionsUpdated += attempt.confirmed;

  // ---- 3. Report what is still owed, durably -------------------------------
  const stillOwed = await prisma.workspaceStorageAddon.count({
    where: {
      ...payerOwnedAddonWhere(scope.ownerUserId),
      dependentCancellationState: { in: [...UNRESOLVED_STATES] },
    },
  });
  if (stillOwed > 0) {
    ctx.summary.actionRequired += stillOwed;
    // The condition is the durable half of ACTION_REQUIRED: a summary counter
    // can be discarded by a caller, an Operations condition cannot.
    //
    // Bounded to THIS payer's add-ons. It used to be the global sweep, so one
    // customer's re-check wrote (up to a page of) every other tenant's
    // conditions inside their request.
    await syncDependentCancellationConditions({ payerUserId: scope.ownerUserId });
  }
}

// ===========================================================================
// Evidence credits
// ===========================================================================

/** Pages of credit payments one run may read while skipping granted ones. */
export const MAX_CREDIT_CANDIDATE_PAGES = 8;

/**
 * The newest credit payments of one personal account that have NO PURCHASE
 * ledger grant, up to `MAX_BINDINGS_PER_RUN`. A granted historic row with no
 * product is classified on the way past, as the loop below always did.
 */
export async function selectUngrantedCreditCandidates(
  userId: string,
  classify: (id: string, product: PaymentProduct) => Promise<unknown>,
) {
  const select = {
    id: true,
    provider: true,
    providerPaymentId: true,
    amountCents: true,
    currency: true,
    status: true,
    providerStateAtUtc: true,
    product: true,
    checkoutAttemptId: true,
    createdAt: true,
  } as const;
  const base: prismaPkg.Prisma.PaymentWhereInput = {
    userId,
    teamId: null,
    status: {
      in: [prismaPkg.PaymentStatus.SUCCEEDED, prismaPkg.PaymentStatus.PENDING],
    },
    OR: [{ product: "EVIDENCE_CREDIT" }, { product: null }],
  };

  const out: Array<prismaPkg.Prisma.PaymentGetPayload<{ select: typeof select }>> = [];
  let after: { createdAt: Date; id: string } | null = null;
  for (let page = 0; page < MAX_CREDIT_CANDIDATE_PAGES; page++) {
    const rows: Array<prismaPkg.Prisma.PaymentGetPayload<{ select: typeof select }>> =
      await prisma.payment.findMany({
        where: after
          ? {
              AND: [
                base,
                {
                  OR: [
                    { createdAt: { lt: after.createdAt } },
                    { createdAt: after.createdAt, id: { lt: after.id } },
                  ],
                },
              ],
            }
          : base,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: MAX_BINDINGS_PER_RUN,
        select,
      });
    if (rows.length === 0) break;

    const granted = await prisma.evidenceCreditLedgerEntry.findMany({
      where: {
        entryType: prismaPkg.EvidenceCreditEntryType.PURCHASE,
        providerRef: { in: rows.map((r) => r.providerPaymentId) },
      },
      select: { provider: true, providerRef: true },
    });
    const grantedKeys = new Set(granted.map((g) => `${String(g.provider)}:${g.providerRef}`));

    for (const row of rows) {
      if (grantedKeys.has(`${String(row.provider)}:${row.providerPaymentId}`)) {
        if (!row.product) await classify(row.id, "EVIDENCE_CREDIT");
        continue;
      }
      out.push(row);
      if (out.length >= MAX_BINDINGS_PER_RUN) return out;
    }
    if (rows.length < MAX_BINDINGS_PER_RUN) break;
    const last = rows[rows.length - 1]!;
    after = { createdAt: last.createdAt, id: last.id };
  }
  return out;
}

/**
 * Recover credits for a settled purchase whose webhook was lost.
 *
 * The binding is a SUCCEEDED `payments` row on the personal account that has
 * no matching PURCHASE ledger entry. That combination is exactly "money we
 * recorded, credits we did not grant" — and it is only reachable for a
 * PERSONAL account, because a credit wallet has no workspace.
 */
async function reconcileEvidenceCredits(ctx: {
  account: BillingAccountRef;
  providers: ReconciliationProviders;
  summary: ReconciliationSummary;
}): Promise<void> {
  if (ctx.account.type !== "PERSONAL") return;

  /*
   * BILLING PAYPAL INTEGRITY (2026-09-28) — CREDIT PURCHASES ONLY.
   *
   * This read every SUCCEEDED/PENDING personal payment without a ledger row —
   * which is every PayPal plan and storage RENEWAL (they never have one). Each
   * re-check then asked PayPal's capture and order endpoints about a sale id,
   * counted the 404 as "provider could not be reached" forever, and — had a
   * renewal price ever equalled the credit price — would have GRANTED a
   * credit for a subscription payment. Rows now carry their product; a
   * historic row (product NULL) is examined once and classified from what the
   * provider object itself says, never from its amount.
   */
  const classify = (id: string, product: PaymentProduct) =>
    prisma.payment.updateMany({ where: { id, product: null }, data: { product } });

  /*
   * ALREADY-GRANTED PURCHASES ARE NOT CANDIDATES.
   *
   * The window was "the 25 newest credit payments", granted or not, so an
   * account with 25 settled-and-granted purchases newer than a lost grant
   * never reached it: the paid-but-not-credited purchase starved behind ones
   * that needed nothing. Pages are read newest-first by keyset and granted
   * rows (the durable PURCHASE ledger entry is the authority) are filtered
   * out until the run's budget of UNGRANTED candidates is full, within a
   * bounded number of pages.
   */
  const candidates = await selectUngrantedCreditCandidates(ctx.account.id, classify);

  for (const binding of candidates) {
    // Already granted? The durable PURCHASE row is the authority, and it is
    // the same row the webhook writes — so a webhook that arrived first makes
    // this a no-op without a second grant being attempted.
    const alreadyGranted = await prisma.evidenceCreditLedgerEntry.findFirst({
      where: {
        entryType: prismaPkg.EvidenceCreditEntryType.PURCHASE,
        provider: binding.provider,
        providerRef: binding.providerPaymentId,
      },
      select: { id: true },
    });
    if (alreadyGranted) {
      if (!binding.product) await classify(binding.id, "EVIDENCE_CREDIT");
      continue;
    }

    // A Stripe INVOICE is a subscription payment, never a credit purchase.
    if (
      !binding.product &&
      binding.provider === prismaPkg.PaymentProvider.STRIPE &&
      binding.providerPaymentId.startsWith("in_")
    ) {
      await classify(binding.id, "SUBSCRIPTION_UNSPECIFIED");
      continue;
    }

    const adapter = ctx.providers[binding.provider];
    if (!adapter) {
      ctx.summary.unavailable += 1;
      continue;
    }

    ctx.summary.checked += 1;
    const observation = await adapter.observePayment(binding.providerPaymentId);
    const historicUnmatched =
      observation.state === "UNKNOWN" &&
      !binding.product &&
      (observation.failure === "NOT_FOUND" || observation.failure === "REFERENCE_INVALID");
    // The platform credential condition is raised and closed from what the
    // sweep observes too, not only from a customer's button. A historic row
    // the provider never knew is a classification, not a provider failure.
    if (!historicUnmatched) {
      noteProviderObservation({
        provider: binding.provider,
        operation: "RECONCILE_ACCOUNT",
        observation,
        paymentId: binding.id,
      });
    }

    if (observation.state === "UNKNOWN") {
      if (historicUnmatched) {
        // Neither a capture nor an order the provider knows: a historic
        // subscription sale, not a credit purchase. Recorded as such, so it
        // is not asked about — or reported as an outage — again.
        await classify(binding.id, "UNCLASSIFIED");
        ctx.summary.checked -= 1;
        continue;
      }
      ctx.summary.unavailable += 1;
      continue;
    }

    if (observation.productKey !== "EVIDENCE_CREDIT") {
      if (!binding.product) {
        await classify(
          binding.id,
          observation.productKey === "PLAN" || observation.productKey === "STORAGE_ADDON" || observation.productKey === "STORAGE_ADDON_ONE_TIME"
            ? observation.productKey
            : "UNCLASSIFIED",
        );
      }
      ctx.summary.checked -= 1;
      continue;
    }
    if (!binding.product) await classify(binding.id, "EVIDENCE_CREDIT");

    /*
     * BILLING SURFACE CORRECTION (2026-08-29) — record WHAT WAS OBSERVED about
     * the payment itself, not only what it entitles. The transition rules are
     * the shared ones, so a stale poll still cannot overwrite a newer webhook.
     */
    const transition = decidePaymentTransition({
      current: binding.status,
      currentObservedAtUtc: binding.providerStateAtUtc,
      observed: observation.state,
      observedAtUtc: observation.observedAtUtc,
    });
    if (transition.apply) {
      await prisma.payment.updateMany({
        where: { id: binding.id, status: binding.status },
        data: {
          status: transition.status,
          ...(observation.observedAtUtc
            ? { providerStateAtUtc: observation.observedAtUtc }
            : {}),
        },
      });
    }

    if (observation.state === "PENDING") {
      ctx.summary.pending += 1;
      continue;
    }
    if (observation.state !== "SUCCEEDED") {
      // FAILED / CANCELED / REFUNDED grant nothing.
      continue;
    }

    const attemptId = binding.checkoutAttemptId ?? observation.attemptId ?? null;
    if (!(await validateCreditPurchase(observation, ctx.account.id, attemptId, ctx.summary, binding))) continue;

    // The canonical quantity, never the provider's. The provider's quantity is
    // checked above; what is GRANTED comes from the catalog.
    const granted = await grantEvidenceCredits({
      userId: ctx.account.id,
      credits: EVIDENCE_CREDIT_PRODUCT.creditsGrantedPerPurchase,
      provider: binding.provider,
      providerRef: binding.providerPaymentId,
    });

    if (granted.granted) {
      ctx.summary.creditsRestored +=
        EVIDENCE_CREDIT_PRODUCT.creditsGrantedPerPurchase;
    }
  }
}

/**
 * Everything a settled credit purchase must satisfy before it grants.
 *
 * BILLING PAYPAL INTEGRITY (2026-09-28) — the price is THIS purchase's: the
 * immutable amount on its checkout attempt. Only a purchase from before
 * attempts existed is compared with the current catalogue. A mismatch is a
 * discrepancy an operator reviews, never a grant.
 */
export async function validateCreditPurchase(
  observation: PaymentObservation,
  userId: string,
  attemptId: string | null,
  summary: ReconciliationSummary,
  binding: { provider: prismaPkg.PaymentProvider; providerPaymentId: string },
): Promise<boolean> {
  /*
   * A DISCREPANCY IS A REVIEW ITEM, NOT ONLY A COUNTER.
   *
   * The customer has paid and is not credited. The settlement paths already
   * record this as an AMOUNT_MISMATCH review; the reconciliation path only
   * incremented a summary counter the scheduled sweep then discarded, while
   * the Billing banner tells the customer support is reviewing it. The review
   * row is the durable fact behind that sentence. Amounts and currencies only,
   * no provider payload. Best-effort: the counter always lands.
   */
  const mismatch = async (
    kind: "CURRENCY" | "AMOUNT" | "QUANTITY",
    expected: { amountCents: number; currency: string } | null,
  ): Promise<false> => {
    summary.discrepancies += 1;
    await recordBillingReviewItem({
      userId,
      provider: binding.provider,
      providerResourceId: binding.providerPaymentId,
      product: "EVIDENCE_CREDIT",
      reason: "AMOUNT_MISMATCH",
      detail: {
        source: "reconciliation",
        mismatch: kind,
        observedAmountCents: observation.amountCents ?? null,
        observedCurrency: observation.currency ?? null,
        observedQuantity: observation.quantity ?? null,
        expectedAmountCents: expected?.amountCents ?? null,
        expectedCurrency: expected?.currency ?? null,
      },
    }).catch(() => undefined);
    return false;
  };

  if (!currencyMatches(observation.currency, SUPPORTED_CURRENCIES)) {
    return mismatch("CURRENCY", null);
  }

  let expected: { amountCents: number; currency: string } | null = null;
  if (attemptId) {
    const attempt = await prisma.billingCheckoutAttempt.findUnique({
      where: { id: attemptId },
      select: { userId: true, product: true, amountCents: true, currency: true },
    });
    if (
      attempt &&
      attempt.userId === userId &&
      attempt.product === prismaPkg.BillingCheckoutProduct.EVIDENCE_CREDIT
    ) {
      expected = { amountCents: attempt.amountCents, currency: attempt.currency.toUpperCase() };
    }
  }
  if (!expected) {
    const currency = observation.currency === "EUR" ? "EUR" : "USD";
    expected = { amountCents: getPlanPriceCents(prismaPkg.PlanType.PAYG, currency), currency };
  }
  if (observation.amountCents !== expected.amountCents || observation.currency !== expected.currency) {
    return mismatch("AMOUNT", expected);
  }

  // A quantity the provider states must be the canonical one. `null` means the
  // provider does not report a line quantity for this product shape, which is
  // normal for a PayPal order and is not a mismatch.
  if (
    observation.quantity !== null &&
    observation.quantity !== EVIDENCE_CREDIT_PRODUCT.creditsGrantedPerPurchase
  ) {
    return mismatch("QUANTITY", expected);
  }

  return true;
}

// ===========================================================================
// Plan subscriptions
// ===========================================================================

/**
 * The rows a PERSONAL account's re-check may read and apply: ones this person
 * PAID for (`userId` / `ownerUserId`) with no workspace, or with a legacy
 * workspace this person still OWNS. Never another payer's row.
 */
export function payerOwnedSubscriptionScope(userId: string): prismaPkg.Prisma.SubscriptionWhereInput {
  return { userId, OR: [{ teamId: null }, { team: { ownerUserId: userId } }] };
}

export function payerOwnedStorageScope(userId: string): prismaPkg.Prisma.WorkspaceStorageAddonWhereInput {
  return payerOwnedAddonWhere(userId);
}

async function reconcileSubscriptions(ctx: {
  account: BillingAccountRef;
  providers: ReconciliationProviders;
  summary: ReconciliationSummary;
}): Promise<void> {
  // The bindings belonging to THIS account and no other. A personal account
  // owns its `teamId: null` subscriptions; a workspace owns its own.
  // Self-service subscriptions belong to the PERSONAL subject. An
  // ORGANIZATION reconciles its contract, never a plan checkout.
  //
  // BILLING LEGACY ROWS (2026-09-28) — a subscription bought under the old
  // workspace-shaped TEAM model still carries a `teamId`. It is the PAYER's
  // base subscription (`findLivePersonalBaseSubscription` already treats it
  // so), and excluding it here left it unchecked forever. It is included when
  // this person paid for it (`userId`) AND still owns that workspace; a row
  // for a workspace someone else now owns is left to Operations rather than
  // being reconciled into the wrong account.
  const where =
    ctx.account.type === "PERSONAL" ? payerOwnedSubscriptionScope(ctx.account.id) : null;
  // An ORGANIZATION account is contract-managed and has no self-service
  // provider subscription to reconcile.
  if (!where) return;

  const bindings = await prisma.subscription.findMany({
    where: {
      ...where,
      // TRIALING rows are checkouts that never activated. They are examined
      // by the checkout-attempt pass, which classifies a 404 or an unbound
      // attempt truthfully instead of counting it as a provider outage.
      status: {
        in: [
          prismaPkg.SubscriptionStatus.ACTIVE,
          prismaPkg.SubscriptionStatus.PAST_DUE,
        ],
      },
    },
    orderBy: { updatedAt: "desc" },
    take: MAX_BINDINGS_PER_RUN,
    select: {
      id: true,
      userId: true,
      teamId: true,
      plan: true,
      provider: true,
      providerSubId: true,
      status: true,
      currentPeriodEnd: true,
      providerStateAtUtc: true,
      cancelAtPeriodEnd: true,
      pendingPlan: true,
      providerScheduleId: true,
      supersededBySubscriptionId: true,
    },
  });
  const notDue = await referencesNotDue(ctx.account.id);

  for (const binding of bindings) {
    const adapter = ctx.providers[binding.provider];
    if (!adapter) {
      ctx.summary.unavailable += 1;
      continue;
    }
    // BILLING REMEDIATION (2026-10-30, AUD-14) — asked and answered "not found"
    // recently. It keeps its entitlement; it just is not asked again yet.
    if (notDue.has(`${String(binding.provider)}:${binding.providerSubId}`)) continue;

    ctx.summary.checked += 1;
    const observation = await adapter.observeSubscription(binding.providerSubId);
    noteProviderObservation({
      provider: binding.provider,
      operation: "RECONCILE_ACCOUNT",
      observation,
    });

    if (observation.state === "UNKNOWN") {
      if (observation.failure === "NOT_FOUND") {
        await noteProviderReferenceMissing({
          userId: binding.userId,
          provider: binding.provider,
          resourceKind: "SUBSCRIPTION",
          providerResourceId: binding.providerSubId,
        });
      }
      ctx.summary.unavailable += 1;
      continue;
    }
    await noteProviderReferenceFound({ provider: binding.provider, providerResourceId: binding.providerSubId });

    // A schedule left behind by a failed phase edit holds the subscription and
    // blocks the next plan change.
    if (binding.providerScheduleId && !binding.pendingPlan) {
      await releaseOrphanedStripeSchedule({ subscriptionId: binding.id, scheduleId: binding.providerScheduleId });
    }

    // THE ORDERING GUARD. A poll that started before a webhook landed can
    // finish after it; without this, a stale "active" would resurrect a
    // subscription the provider had already cancelled.
    if (!isNotStale(observation.observedAtUtc, binding.providerStateAtUtc)) {
      continue;
    }

    // Missing renewal history first: a payment belongs to the subscription's
    // past whether or not its current state changed.
    ctx.summary.paymentsRecorded += await recordMissingRenewals({
      observation,
      userId: binding.userId,
      teamId: binding.teamId,
      expectedCents: getPlanPriceCents(
        binding.plan,
        observation.recentPayments[0]?.currency === "EUR" ? "EUR" : "USD",
      ),
      summary: ctx.summary,
      product: "PLAN",
      providerResourceId: binding.providerSubId,
    });

    const status = subscriptionStatusFromObservation(observation);
    if (!status) continue;

    const isStripe = binding.provider === prismaPkg.PaymentProvider.STRIPE;
    // AUD-01 — the price billed states the plan in force, so a landed schedule
    // whose webhook was lost converges here too.
    const plan = (isStripe ? planFromStripePriceId(observation.planId) : null) ?? binding.plan;

    if (
      status === binding.status &&
      plan === binding.plan &&
      (!isStripe || observation.cancelAtPeriodEnd === binding.cancelAtPeriodEnd) &&
      (observation.currentPeriodEndUtc === null ||
        observation.currentPeriodEndUtc.getTime() === binding.currentPeriodEnd?.getTime())
    ) {
      // Provider and local already agree.
      await stampProviderState(binding.id, observation.observedAtUtc);
      if (await repairEntitlementDrift(binding)) ctx.summary.subscriptionsUpdated += 1;
      continue;
    }

    if (status === prismaPkg.SubscriptionStatus.TRIALING) {
      // A pending renewal must not extend entitlement.
      ctx.summary.pending += 1;
      await stampProviderState(binding.id, observation.observedAtUtc);
      continue;
    }

    await syncPlanForSubscription({
      userId: binding.userId,
      plan,
      teamId: binding.teamId,
      provider: binding.provider,
      providerSubId: binding.providerSubId,
      status,
      currentPeriodEnd: observation.currentPeriodEndUtc,
      observedAtUtc: observation.observedAtUtc,
      ...(isStripe
        ? {
            cancelAtPeriodEnd: observation.cancelAtPeriodEnd,
            providerScheduleId: observation.providerScheduleId ?? null,
          }
        : {}),
    });
    await stampProviderState(binding.id, observation.observedAtUtc);
    ctx.summary.subscriptionsUpdated += 1;

    // A base subscription the customer cancelled AT THE PROVIDER may leave
    // dependent add-ons charging. Which ones are OWED a cancellation is the
    // dependency rule's decision, made (and acted on, and counted as still
    // owed) by `convergeDependentCancellations` at the end of this run.
  }
}

/**
 * BILLING REMEDIATION (2026-10-30, AUD-03) — the provider and the subscription
 * row agree, but the entitlement does not: the process died between the two
 * writes, or an older code path skipped one. "They agree" used to end the check
 * there, so a paying customer stayed on Free indefinitely, and the next checkout
 * then opened a second subscription.
 *
 * Only for the subscription that IS this person's plan, and only over a
 * self-service plan value. `entitlements.plan` is the provider-derived plan: an
 * internal grant is a separate row, so this cannot overwrite one.
 */
async function repairEntitlementDrift(binding: {
  id: string;
  userId: string;
  plan: prismaPkg.PlanType;
  status: prismaPkg.SubscriptionStatus;
  providerSubId: string;
  supersededBySubscriptionId: string | null;
}): Promise<boolean> {
  if (binding.supersededBySubscriptionId) return false;
  const live = await findLivePersonalBaseSubscription(binding.userId);
  if (live?.id !== binding.id) return false;
  const entitlement = await prisma.entitlement.findFirst({
    where: { userId: binding.userId, active: true },
    orderBy: { createdAt: "desc" },
    select: { plan: true },
  });
  if (!entitlement || entitlement.plan === binding.plan) return false;
  const selfService: readonly prismaPkg.PlanType[] = [
    prismaPkg.PlanType.FREE,
    prismaPkg.PlanType.PRO,
    prismaPkg.PlanType.TEAM,
  ];
  if (!selfService.includes(entitlement.plan)) return false;
  await setPersonalPlan(binding.userId, binding.plan, {
    actorUserId: null,
    serviceActor: "billing_reconciliation",
    providerSubId: binding.providerSubId,
  });
  return true;
}

/**
 * AUD-03 — the moment drift costs money. A paying customer whose entitlement
 * reads Free is offered checkout; buying opens a second subscription, which is
 * then superseded and charged. So a plan checkout first asks the provider about
 * the subscription already on record. Returns the plan repaired, or null when
 * there was nothing to repair, or the provider could not say: the supersession
 * guard still stands behind a checkout that goes ahead.
 */
export async function repairEntitlementBeforeCheckout(
  userId: string,
  providers: ReconciliationProviders = defaultReconciliationProviders(),
): Promise<prismaPkg.PlanType | null> {
  const live = await findLivePersonalBaseSubscription(userId);
  if (!live || live.status === prismaPkg.SubscriptionStatus.TRIALING) return null;
  const entitlement = await prisma.entitlement.findFirst({
    where: { userId, active: true },
    orderBy: { createdAt: "desc" },
    select: { plan: true },
  });
  if (entitlement?.plan === live.plan) return null;
  const observation = await providers[live.provider]?.observeSubscription(live.providerSubId);
  if (observation?.state !== "SUCCEEDED") return null;
  const repaired = await repairEntitlementDrift({
    id: live.id,
    userId,
    plan: live.plan,
    status: live.status,
    providerSubId: live.providerSubId,
    supersededBySubscriptionId: null,
  });
  return repaired ? live.plan : null;
}

/** Record the provider's own timestamp for the state we just applied. */
async function stampProviderState(
  subscriptionId: string,
  observedAtUtc: Date | null,
): Promise<void> {
  if (!observedAtUtc) return;
  await prisma.subscription.update({
    where: { id: subscriptionId },
    data: { providerStateAtUtc: observedAtUtc },
  });
}

/**
 * Write the renewal payments local history is missing.
 *
 * `recordPayment` upserts on `(provider, providerPaymentId)`, which is the
 * durable constraint that makes this idempotent against a webhook racing it —
 * the second writer updates the same row rather than inserting a second.
 */
async function recordMissingRenewals(input: {
  observation: SubscriptionObservation;
  userId: string;
  teamId: string | null;
  expectedCents: number;
  summary: ReconciliationSummary;
  /** What these renewals paid for, and the provider subscription they belong to. */
  product: "PLAN" | "STORAGE_ADDON";
  providerResourceId: string;
}): Promise<number> {
  let recorded = 0;

  for (const payment of input.observation.recentPayments) {
    if (payment.state === "PENDING") {
      input.summary.pending += 1;
      continue;
    }
    if (payment.state !== "SUCCEEDED" && payment.state !== "FAILED") continue;

    const existing = await prisma.payment.findUnique({
      where: {
        provider_providerPaymentId: {
          provider: payment.provider,
          providerPaymentId: payment.providerRef,
        },
      },
      select: { id: true },
    });
    if (existing) continue;

    if (payment.state === "SUCCEEDED") {
      if (!currencyMatches(payment.currency, SUPPORTED_CURRENCIES)) {
        input.summary.discrepancies += 1;
        continue;
      }
      if (payment.amountCents !== input.expectedCents) {
        input.summary.discrepancies += 1;
        continue;
      }
    }

    await recordPayment({
      userId: input.userId,
      provider: payment.provider,
      providerPaymentId: payment.providerRef,
      amountCents: payment.amountCents ?? 0,
      currency: payment.currency ?? "USD",
      status:
        payment.state === "SUCCEEDED"
          ? prismaPkg.PaymentStatus.SUCCEEDED
          : prismaPkg.PaymentStatus.FAILED,
      teamId: input.teamId,
      product: input.product,
      providerResourceId: input.providerResourceId,
      observedAtUtc: payment.observedAtUtc,
    });
    recorded += 1;
  }

  return recorded;
}

// ===========================================================================
// Recurring storage add-ons
// ===========================================================================

async function reconcileStorageAddons(ctx: {
  account: BillingAccountRef;
  providers: ReconciliationProviders;
  summary: ReconciliationSummary;
}): Promise<void> {
  // Legacy workspace-scoped recurring add-ons: same payer-owned rule as plans.
  const where =
    ctx.account.type === "PERSONAL" ? payerOwnedStorageScope(ctx.account.id) : null;
  if (!where) return;

  const addons = await prisma.workspaceStorageAddon.findMany({
    where: {
      ...where,
      // ONLY recurring add-ons have a provider subscription. A legacy one-time
      // entitlement is not a subscription and reconciliation must never treat
      // it as one — it would be reported CANCELED by a provider that has never
      // heard of it.
      billingCycle: prismaPkg.StorageAddonBillingCycle.MONTHLY,
      status: {
        in: [
          prismaPkg.WorkspaceStorageAddonStatus.ACTIVE,
          prismaPkg.WorkspaceStorageAddonStatus.PENDING,
          prismaPkg.WorkspaceStorageAddonStatus.PAST_DUE,
          prismaPkg.WorkspaceStorageAddonStatus.ABANDONED,
        ],
      },
    },
    orderBy: { updatedAt: "desc" },
    take: MAX_BINDINGS_PER_RUN,
    select: {
      id: true,
      ownerUserId: true,
      teamId: true,
      addonKey: true,
      paymentProvider: true,
      externalSubscriptionId: true,
      status: true,
      activatedAtUtc: true,
      currency: true,
      currentPeriodEnd: true,
      providerStateAtUtc: true,
      createdAt: true,
    },
  });

  for (const addon of addons) {
    const result = await reconcileStorageAddonRow({
      addon,
      providers: ctx.providers,
      summary: ctx.summary,
    });
    ctx.summary.storageAttempts.push(result);
    // Only never-activated rows are checkout ATTEMPTS; an ACTIVE add-on is a
    // subscription the pass kept in step, not a purchase awaiting anything.
    if (!addon.activatedAtUtc) {
      ctx.summary.attempts.push({
        attemptId: result.attemptId,
        product: "STORAGE",
        createdAtUtc: result.createdAtUtc,
        provider: result.provider,
        providerBound: result.providerBound,
        previousStatus: result.previousStatus,
        currentStatus: result.currentStatus,
        outcome: result.outcome,
        locallyAbandoned: result.previousStatus === prismaPkg.WorkspaceStorageAddonStatus.ABANDONED,
        ...(result.resumeUrl ? { resumeUrl: result.resumeUrl } : {}),
        ...(result.waitingFor ? { waitingFor: result.waitingFor } : {}),
      });
    }
  }
}

type StorageAddonReconciliationRow = {
  id: string;
  ownerUserId: string;
  teamId: string | null;
  addonKey: prismaPkg.StorageAddonKey;
  paymentProvider: prismaPkg.PaymentProvider | null;
  externalSubscriptionId: string | null;
  status: prismaPkg.WorkspaceStorageAddonStatus;
  activatedAtUtc: Date | null;
  currency: string | null;
  currentPeriodEnd: Date | null;
  providerStateAtUtc: Date | null;
  createdAt: Date;
};

function storageAttemptFailureOutcome(
  failure: ObservationFailure | undefined,
): StorageAttemptReconciliation["outcome"] {
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

function storageStatusFromObservation(
  observation: SubscriptionObservation,
  addon: StorageAddonReconciliationRow,
): prismaPkg.WorkspaceStorageAddonStatus | null {
  switch (observation.state) {
    case "SUCCEEDED":
      return prismaPkg.WorkspaceStorageAddonStatus.ACTIVE;
    case "PENDING":
      return addon.status === prismaPkg.WorkspaceStorageAddonStatus.ABANDONED
        ? addon.status
        : prismaPkg.WorkspaceStorageAddonStatus.PENDING;
    case "FAILED":
      return addon.activatedAtUtc
        ? prismaPkg.WorkspaceStorageAddonStatus.PAST_DUE
        : prismaPkg.WorkspaceStorageAddonStatus.FAILED;
    case "CANCELED":
      return prismaPkg.WorkspaceStorageAddonStatus.CANCELED;
    case "EXPIRED":
      return prismaPkg.WorkspaceStorageAddonStatus.EXPIRED;
    default:
      return null;
  }
}

async function reconcileStorageAddonRow(input: {
  addon: StorageAddonReconciliationRow;
  providers: ReconciliationProviders;
  summary: ReconciliationSummary;
}): Promise<StorageAttemptReconciliation> {
  const { addon, summary } = input;
  const base = {
    attemptId: addon.id,
    kind: "STORAGE_ADDON" as const,
    addonKey: addon.addonKey,
    createdAtUtc: addon.createdAt.toISOString(),
    provider: addon.paymentProvider,
    providerBound: Boolean(addon.externalSubscriptionId),
    previousStatus: addon.status,
  };
  summary.checked += 1;
  const locallyAbandoned =
    addon.status === prismaPkg.WorkspaceStorageAddonStatus.ABANDONED;
  // BILLING CHECKOUT ATTEMPTS (2026-09-28) — the same counting rule as every
  // other attempt. An attempt the customer already abandoned is re-read so a
  // later provider-proven activation still wins, but a provider that no
  // longer knows it is the expected answer, not "action required" on every
  // re-check for ever.
  const unresolved = async (
    outcome: StorageAttemptReconciliation["outcome"],
  ): Promise<StorageAttemptReconciliation> => {
    countAttemptOutcome(summary, { outcome, locallyAbandoned });
    await noteStorageAttemptCheck(addon.id, outcome);
    return { ...base, currentStatus: addon.status, outcome };
  };

  const provider = addon.paymentProvider;
  const ref = addon.externalSubscriptionId;
  if (!provider || !ref) return unresolved("NOT_PROVIDER_BOUND");

  const adapter = input.providers[provider];
  if (!adapter) return unresolved("PROVIDER_UNAVAILABLE");

  const observation = await adapter.observeSubscription(ref);
  noteProviderObservation({ provider, operation: "RECHECK_CHECKOUT_ATTEMPT", observation });
  if (observation.state === "UNKNOWN") {
    if (observation.failure === "NOT_FOUND" && addon.activatedAtUtc) {
      await noteProviderReferenceMissing({
        userId: addon.ownerUserId,
        provider,
        resourceKind: "STORAGE_ADDON",
        providerResourceId: ref,
      });
    }
    return unresolved(storageAttemptFailureOutcome(observation.failure));
  }
  await noteProviderReferenceFound({ provider, providerResourceId: ref });
  if (!isNotStale(observation.observedAtUtc, addon.providerStateAtUtc)) {
    return { ...base, currentStatus: addon.status, outcome: "STALE_IGNORED" };
  }

  const currency = addon.currency === "EUR" ? "EUR" : "USD";
  summary.paymentsRecorded += await recordMissingRenewals({
    observation,
    userId: addon.ownerUserId,
    teamId: addon.teamId,
    expectedCents: getStorageAddonPriceCents({
      addonKey: addon.addonKey,
      currency,
    }),
    summary,
    product: "STORAGE_ADDON",
    providerResourceId: ref,
  });

  // BILLING PAYPAL INTEGRITY (2026-09-28) — a FIRST activation is decided by
  // the ONE storage activation authority, with the same plan-id, identity and
  // eligibility checks the webhook and the return route apply. This pass used
  // to grant it with no check at all.
  if (observation.state === "SUCCEEDED" && !addon.activatedAtUtc) {
    const claimed = provider === prismaPkg.PaymentProvider.PAYPAL
      ? parsePayPalStorageAddonCustomId(observation.customId ?? null)
      : null;
    const applied = await applyStorageSubscriptionObservation({
      provider,
      subscriptionId: ref,
      status: prismaPkg.SubscriptionStatus.ACTIVE,
      planId: observation.planId ?? null,
      claimed: claimed
        ? {
            userId: claimed.userId,
            teamId: claimed.teamId,
            addonKey: claimed.storageAddonKey,
            attemptId: claimed.attemptId ?? null,
          }
        : null,
      currentPeriodEnd: observation.currentPeriodEndUtc,
      observedAtUtc: observation.observedAtUtc,
      source: "billing_reconciliation",
    });
    if (applied.outcome === "IGNORED") {
      return unresolved("PROVIDER_MALFORMED");
    }
    const current = await prisma.workspaceStorageAddon.findUnique({
      where: { id: addon.id },
      select: { status: true },
    });
    summary.subscriptionsUpdated += 1;
    await noteStorageAttemptCheck(addon.id, "UPDATED");
    return { ...base, currentStatus: current?.status ?? addon.status, outcome: "UPDATED" };
  }

  const next = storageStatusFromObservation(observation, addon);
  if (!next) {
    summary.actionRequired += 1;
    return { ...base, currentStatus: addon.status, outcome: "PROVIDER_MALFORMED" };
  }

  // AUD-09 — a cancellation ends future billing. The month already paid for
  // stays until it ends: one writer decides that, shared with the webhook.
  if (
    next === prismaPkg.WorkspaceStorageAddonStatus.CANCELED &&
    addon.activatedAtUtc &&
    (await keepPaidPeriodAfterProviderCancel({ addonId: addon.id, observedAtUtc: observation.observedAtUtc }))
  ) {
    return { ...base, currentStatus: addon.status, outcome: "NO_CHANGE" };
  }

  // BILLING PAYPAL INTEGRITY (2026-09-28) — an approval nobody finished within
  // the approval window is closed (provider-first: PayPal itself still reports
  // it as NOT approved). It no longer sits "waiting" forever; a later
  // provider-proven activation still wins over the local close.
  if (
    observation.state === "PENDING" &&
    (observation.providerStatus ?? "").toUpperCase() === "APPROVAL_PENDING" &&
    addon.status === prismaPkg.WorkspaceStorageAddonStatus.PENDING &&
    Date.now() - addon.createdAt.getTime() > APPROVAL_EXPIRY_MS
  ) {
    const row = await prisma.workspaceStorageAddon.findUnique({
      where: { id: addon.id },
      select: { metadata: true },
    });
    const meta =
      row?.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
        ? (row.metadata as Record<string, unknown>)
        : {};
    const closed = await prisma.workspaceStorageAddon.updateMany({
      where: { id: addon.id, status: prismaPkg.WorkspaceStorageAddonStatus.PENDING },
      data: {
        status: prismaPkg.WorkspaceStorageAddonStatus.ABANDONED,
        metadata: { ...meta, checkoutState: "LOCALLY_EXPIRED" } as prismaPkg.Prisma.InputJsonObject,
      },
    });
    if (closed.count > 0) {
      summary.attemptsUpdated += 1;
      await noteStorageAttemptCheck(addon.id, "UPDATED");
      return { ...base, currentStatus: prismaPkg.WorkspaceStorageAddonStatus.ABANDONED, outcome: "UPDATED" };
    }
  }

  if (observation.state === "PENDING" && !locallyAbandoned) summary.pending += 1;
  if (next === prismaPkg.WorkspaceStorageAddonStatus.PAST_DUE) {
    summary.actionRequired += 1;
  }

  if (observation.observedAtUtc) {
    if (observation.state === "CANCELED" || observation.cancelAtPeriodEnd) {
      await confirmObligationFromProviderTruth({
        addonId: addon.id,
        observedAtUtc: observation.observedAtUtc,
      });
    } else if (observation.state === "SUCCEEDED") {
      await reopenObligationFromProviderTruth({
        addonId: addon.id,
        observedAtUtc: observation.observedAtUtc,
      });
    }
  }

  const changed =
    next !== addon.status ||
    observation.currentPeriodEndUtc?.getTime() !== addon.currentPeriodEnd?.getTime();
  if (!changed) {
    const stamped = await stampAddonProviderState({
      addonId: addon.id,
      observedAtUtc: observation.observedAtUtc,
      expectedObservedAtUtc: addon.providerStateAtUtc,
      expectedStatus: addon.status,
    });
    if (!stamped) {
      return { ...base, currentStatus: addon.status, outcome: "STALE_IGNORED" };
    }
    const outcome = observation.state === "PENDING" ? "STILL_PENDING" : "NO_CHANGE";
    // AUD-18 — durable, like a plan attempt: the row must not read "waiting for
    // approval" again after a reload, and approved storage is not abandonable.
    const activating = (observation.providerStatus ?? "").toUpperCase() === "APPROVED";
    await noteStorageAttemptCheck(addon.id, outcome, activating ? "APPROVED_AWAITING_ACTIVATION" : undefined);
    return {
      ...base,
      currentStatus: addon.status,
      outcome,
      ...(outcome === "STILL_PENDING"
        ? {
            waitingFor:
              (observation.providerStatus ?? "").toUpperCase() === "APPROVED"
                ? ("ACTIVATION" as const)
                : ("APPROVAL" as const),
          }
        : {}),
      ...(observation.resumeUrl ? { resumeUrl: observation.resumeUrl } : {}),
      providerStatus: observation.providerStatus ?? null,
    };
  }

  const updated = await prisma.workspaceStorageAddon.updateMany({
    where: {
      id: addon.id,
      status: addon.status,
      providerStateAtUtc: addon.providerStateAtUtc,
    },
    data: {
      status: next,
      currentPeriodEnd: observation.currentPeriodEndUtc ?? addon.currentPeriodEnd,
      ...(next === prismaPkg.WorkspaceStorageAddonStatus.ACTIVE && !addon.activatedAtUtc
        ? { activatedAtUtc: observation.observedAtUtc ?? new Date() }
        : {}),
      ...(next === prismaPkg.WorkspaceStorageAddonStatus.CANCELED
        ? { canceledAtUtc: observation.observedAtUtc ?? new Date() }
        : {}),
      ...(observation.observedAtUtc
        ? { providerStateAtUtc: observation.observedAtUtc }
        : {}),
    },
  });
  if (updated.count === 0) {
    return { ...base, currentStatus: addon.status, outcome: "STALE_IGNORED" };
  }
  summary.subscriptionsUpdated += 1;
  await noteStorageAttemptCheck(addon.id, "UPDATED");
  return { ...base, currentStatus: next, outcome: "UPDATED" };
}

/**
 * Remember the last provider answer on the attempt row (merged into its
 * metadata), so Billing activity can say WHY an attempt is still open — "PayPal
 * no longer has a record of this" — without another provider call.
 */
async function noteStorageAttemptCheck(
  addonId: string,
  outcome: StorageAttemptReconciliation["outcome"],
  checkoutState?: string,
): Promise<void> {
  const row = await prisma.workspaceStorageAddon.findUnique({
    where: { id: addonId },
    select: { metadata: true },
  });
  if (!row) return;
  const metadata =
    row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
      ? (row.metadata as Record<string, unknown>)
      : {};
  await prisma.workspaceStorageAddon
    .update({
      where: { id: addonId },
      data: {
        metadata: {
          ...metadata,
          ...(checkoutState ? { checkoutState } : {}),
          lastProviderCheck: { outcome, atUtc: new Date().toISOString() },
        } as prismaPkg.Prisma.InputJsonObject,
      },
    })
    .catch(() => undefined);
}

/** Reconcile one storage attempt, using the same authority as account-wide re-check. */
export async function reconcileStorageAddonAttempt(input: {
  account: BillingAccountRef;
  attemptId: string;
  providers?: ReconciliationProviders;
}): Promise<StorageAttemptReconciliation> {
  if (input.account.type !== "PERSONAL") {
    const err: Error & { statusCode?: number } = new Error("Storage attempt not found");
    err.statusCode = 404;
    throw err;
  }
  const addon = await prisma.workspaceStorageAddon.findFirst({
    where: {
      id: input.attemptId,
      ownerUserId: input.account.id,
      teamId: null,
      billingCycle: prismaPkg.StorageAddonBillingCycle.MONTHLY,
    },
    select: {
      id: true,
      ownerUserId: true,
      teamId: true,
      addonKey: true,
      paymentProvider: true,
      externalSubscriptionId: true,
      status: true,
      activatedAtUtc: true,
      currency: true,
      currentPeriodEnd: true,
      providerStateAtUtc: true,
      createdAt: true,
    },
  });
  if (!addon) {
    const err: Error & { statusCode?: number } = new Error("Storage attempt not found");
    err.statusCode = 404;
    throw err;
  }
  const summary = emptySummary();
  return reconcileStorageAddonRow({
    addon,
    providers: input.providers ?? defaultReconciliationProviders(),
    summary,
  });
}

export type StorageAttemptAbandonResult =
  | StorageAttemptReconciliation
  | {
      attemptId: string;
      outcome:
        | "ABANDON_CONFIRMATION_REQUIRED"
        | "ABANDONED"
        | "ALREADY_ABANDONED"
        | "ALREADY_RESOLVED"
        | "ABANDON_NOT_ALLOWED";
      warning?: string;
      /** Local disposition only; never a provider cancellation. */
      cancelsAtProvider?: false;
    };

/**
 * Provider-first local disposition for a storage attempt.
 *
 * BILLING CHECKOUT ATTEMPTS (2026-09-28) — an approval PayPal still shows as
 * APPROVAL_PENDING may now be abandoned too, with confirmation. It cannot
 * charge without the buyer approving it, and refusing left the customer with
 * no way to clear the attempt except waiting for an expiry PayPal does not
 * announce. An APPROVED (buyer-consented, activating) subscription is never
 * abandoned; provider truth still wins over any abandonment afterwards.
 */
export async function abandonStorageAddonAttempt(input: {
  account: BillingAccountRef;
  attemptId: string;
  confirmed?: boolean;
  providers?: ReconciliationProviders;
}): Promise<StorageAttemptAbandonResult> {
  const checked = await reconcileStorageAddonAttempt(input);
  if (checked.currentStatus === prismaPkg.WorkspaceStorageAddonStatus.ABANDONED) {
    return { attemptId: input.attemptId, outcome: "ALREADY_ABANDONED", cancelsAtProvider: false };
  }
  if (checked.currentStatus !== prismaPkg.WorkspaceStorageAddonStatus.PENDING) {
    // The provider (or an earlier writer) settled it; that answer stands.
    return checked.outcome === "UPDATED"
      ? checked
      : { attemptId: input.attemptId, outcome: "ALREADY_RESOLVED", cancelsAtProvider: false };
  }
  if (checked.providerStatus === "APPROVED") {
    return {
      attemptId: input.attemptId,
      outcome: "ABANDON_NOT_ALLOWED",
      warning:
        "PayPal shows this storage purchase as approved and activating, so it cannot be abandoned. PROOVRA will apply it as soon as PayPal activates it.",
      cancelsAtProvider: false,
    };
  }
  const eligible =
    checked.outcome === "STILL_PENDING" || UNVERIFIABLE_OUTCOMES.has(checked.outcome);
  if (!eligible) return checked;
  if (!input.confirmed) {
    return {
      attemptId: input.attemptId,
      outcome: "ABANDON_CONFIRMATION_REQUIRED",
      warning: abandonWarning(checked),
      cancelsAtProvider: false,
    };
  }
  const updated = await prisma.workspaceStorageAddon.updateMany({
    where: {
      id: input.attemptId,
      ownerUserId: input.account.id,
      teamId: null,
      status: prismaPkg.WorkspaceStorageAddonStatus.PENDING,
    },
    data: { status: prismaPkg.WorkspaceStorageAddonStatus.ABANDONED },
  });
  return {
    attemptId: input.attemptId,
    outcome: updated.count > 0 ? "ABANDONED" : "ALREADY_ABANDONED",
    cancelsAtProvider: false,
  };
}

async function stampAddonProviderState(input: {
  addonId: string;
  observedAtUtc: Date | null;
  expectedObservedAtUtc: Date | null;
  expectedStatus: prismaPkg.WorkspaceStorageAddonStatus;
}): Promise<boolean> {
  if (!input.observedAtUtc) return true;
  const stamped = await prisma.workspaceStorageAddon.updateMany({
    where: {
      id: input.addonId,
      status: input.expectedStatus,
      providerStateAtUtc: input.expectedObservedAtUtc,
    },
    data: { providerStateAtUtc: input.observedAtUtc },
  });
  return stamped.count > 0;
}
