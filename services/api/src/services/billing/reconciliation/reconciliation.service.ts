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
import { recordPayment } from "../../billing.service.js";
import { getPlanPriceCents, getStorageAddonPriceCents } from "../../billing-pricing.service.js";
import { grantEvidenceCredits } from "../evidence-credits.service.js";
import {
  storageAddonStatusFromSubscription,
  syncPlanForSubscription,
} from "../subscription-lifecycle.handlers.js";
import type { BillingAccountRef } from "../billing-accounts.service.js";
import { StripeBillingReconciliationProvider } from "./stripe.provider.js";
import { PayPalBillingReconciliationProvider } from "./paypal.provider.js";
import {
  emptySummary,
  resolveOutcome,
  type BillingReconciliationProvider,
  type PaymentObservation,
  type ReconciliationSummary,
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
    case "CANCELED":
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
}): Promise<ReconciliationSummary> {
  const providers = input.providers ?? defaultReconciliationProviders();
  const summary = emptySummary();

  await reconcileEvidenceCredits({ account: input.account, providers, summary });
  await reconcileSubscriptions({ account: input.account, providers, summary });
  await reconcileStorageAddons({ account: input.account, providers, summary });

  summary.outcome = resolveOutcome(summary);
  return summary;
}

// ===========================================================================
// Evidence credits
// ===========================================================================

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

  const candidates = await prisma.payment.findMany({
    where: {
      userId: ctx.account.id,
      teamId: null,
      status: {
        in: [prismaPkg.PaymentStatus.SUCCEEDED, prismaPkg.PaymentStatus.PENDING],
      },
    },
    orderBy: { createdAt: "desc" },
    take: MAX_BINDINGS_PER_RUN,
    select: {
      provider: true,
      providerPaymentId: true,
      amountCents: true,
      currency: true,
    },
  });

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
    if (alreadyGranted) continue;

    const adapter = ctx.providers[binding.provider];
    if (!adapter) {
      ctx.summary.unavailable += 1;
      continue;
    }

    ctx.summary.checked += 1;
    const observation = await adapter.observePayment(binding.providerPaymentId);

    if (observation.state === "UNKNOWN") {
      ctx.summary.unavailable += 1;
      continue;
    }
    if (observation.state === "PENDING") {
      ctx.summary.pending += 1;
      continue;
    }
    if (observation.state !== "SUCCEEDED") {
      // FAILED / CANCELED / REFUNDED grant nothing. The local payment row is
      // left to the webhook path, which owns status transitions.
      continue;
    }

    if (!validateCreditPurchase(observation, ctx.summary)) continue;

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
 * A mismatch is NOT an error to the customer: it is a discrepancy an operator
 * has to look at, because it means the provider and the catalog disagree about
 * what was sold. Granting on a mismatched amount would be the product paying
 * for the disagreement.
 */
function validateCreditPurchase(
  observation: PaymentObservation,
  summary: ReconciliationSummary,
): boolean {
  if (!currencyMatches(observation.currency, SUPPORTED_CURRENCIES)) {
    summary.discrepancies += 1;
    return false;
  }

  const expected = getPlanPriceCents(
    prismaPkg.PlanType.PAYG,
    observation.currency === "EUR" ? "EUR" : "USD",
  );
  if (observation.amountCents !== expected) {
    summary.discrepancies += 1;
    return false;
  }

  // A quantity the provider states must be the canonical one. `null` means the
  // provider does not report a line quantity for this product shape, which is
  // normal for a PayPal order and is not a mismatch.
  if (
    observation.quantity !== null &&
    observation.quantity !== EVIDENCE_CREDIT_PRODUCT.creditsGrantedPerPurchase
  ) {
    summary.discrepancies += 1;
    return false;
  }

  return true;
}

// ===========================================================================
// Plan subscriptions
// ===========================================================================

async function reconcileSubscriptions(ctx: {
  account: BillingAccountRef;
  providers: ReconciliationProviders;
  summary: ReconciliationSummary;
}): Promise<void> {
  // The bindings belonging to THIS account and no other. A personal account
  // owns its `teamId: null` subscriptions; a workspace owns its own.
  const where =
    ctx.account.type === "PERSONAL"
      ? { userId: ctx.account.id, teamId: null }
      : ctx.account.type === "WORKSPACE"
        ? { teamId: ctx.account.id }
        : null;
  // An ORGANIZATION account is contract-managed and has no self-service
  // provider subscription to reconcile.
  if (!where) return;

  const bindings = await prisma.subscription.findMany({
    where: {
      ...where,
      status: {
        in: [
          prismaPkg.SubscriptionStatus.ACTIVE,
          prismaPkg.SubscriptionStatus.TRIALING,
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
    },
  });

  for (const binding of bindings) {
    const adapter = ctx.providers[binding.provider];
    if (!adapter) {
      ctx.summary.unavailable += 1;
      continue;
    }

    ctx.summary.checked += 1;
    const observation = await adapter.observeSubscription(binding.providerSubId);

    if (observation.state === "UNKNOWN") {
      ctx.summary.unavailable += 1;
      continue;
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
    });

    const status = subscriptionStatusFromObservation(observation);
    if (!status) continue;

    if (
      status === binding.status &&
      observation.currentPeriodEndUtc?.getTime() ===
        binding.currentPeriodEnd?.getTime()
    ) {
      // Provider and local already agree.
      await stampProviderState(binding.id, observation.observedAtUtc);
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
      plan: binding.plan,
      teamId: binding.teamId,
      provider: binding.provider,
      providerSubId: binding.providerSubId,
      status,
      currentPeriodEnd: observation.currentPeriodEndUtc,
    });
    await stampProviderState(binding.id, observation.observedAtUtc);
    ctx.summary.subscriptionsUpdated += 1;

    // A base subscription the customer cancelled AT THE PROVIDER means its
    // dependent recurring add-ons are still charging until something stops
    // them. Never assume the provider cancelled them too.
    if (status === prismaPkg.SubscriptionStatus.CANCELED) {
      const dependents = await countActiveDependentAddons({
        ownerUserId: binding.userId,
        teamId: binding.teamId,
      });
      if (dependents > 0) ctx.summary.actionRequired += dependents;
    }
  }
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
  const where =
    ctx.account.type === "PERSONAL"
      ? { ownerUserId: ctx.account.id, teamId: null }
      : ctx.account.type === "WORKSPACE"
        ? { teamId: ctx.account.id }
        : null;
  if (!where) return;

  const addons = await prisma.workspaceStorageAddon.findMany({
    where: {
      ...where,
      // ONLY recurring add-ons have a provider subscription. A legacy one-time
      // entitlement is not a subscription and reconciliation must never treat
      // it as one — it would be reported CANCELED by a provider that has never
      // heard of it.
      billingCycle: prismaPkg.StorageAddonBillingCycle.MONTHLY,
      externalSubscriptionId: { not: null },
      status: {
        in: [
          prismaPkg.WorkspaceStorageAddonStatus.ACTIVE,
          prismaPkg.WorkspaceStorageAddonStatus.PENDING,
          prismaPkg.WorkspaceStorageAddonStatus.PAST_DUE,
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
      currency: true,
      currentPeriodEnd: true,
      providerStateAtUtc: true,
    },
  });

  for (const addon of addons) {
    const provider = addon.paymentProvider;
    const ref = addon.externalSubscriptionId;
    if (!provider || !ref) continue;

    const adapter = ctx.providers[provider];
    if (!adapter) {
      ctx.summary.unavailable += 1;
      continue;
    }

    ctx.summary.checked += 1;
    const observation = await adapter.observeSubscription(ref);

    if (observation.state === "UNKNOWN") {
      ctx.summary.unavailable += 1;
      continue;
    }
    if (!isNotStale(observation.observedAtUtc, addon.providerStateAtUtc)) {
      continue;
    }

    const currency = addon.currency === "EUR" ? "EUR" : "USD";
    ctx.summary.paymentsRecorded += await recordMissingRenewals({
      observation,
      userId: addon.ownerUserId,
      teamId: addon.teamId,
      expectedCents: getStorageAddonPriceCents({
        addonKey: addon.addonKey,
        currency,
      }),
      summary: ctx.summary,
    });

    const subscriptionStatus = subscriptionStatusFromObservation(observation);
    if (!subscriptionStatus) continue;
    const next = storageAddonStatusFromSubscription(subscriptionStatus);

    if (next === addon.status) {
      await stampAddonProviderState(addon.id, observation.observedAtUtc);
      continue;
    }

    await prisma.workspaceStorageAddon.update({
      where: { id: addon.id },
      data: {
        status: next,
        currentPeriodEnd: observation.currentPeriodEndUtc ?? addon.currentPeriodEnd,
        ...(next === prismaPkg.WorkspaceStorageAddonStatus.CANCELED
          ? { canceledAtUtc: observation.observedAtUtc ?? new Date() }
          : {}),
        ...(observation.observedAtUtc
          ? { providerStateAtUtc: observation.observedAtUtc }
          : {}),
      },
    });
    ctx.summary.subscriptionsUpdated += 1;
    if (next === prismaPkg.WorkspaceStorageAddonStatus.PAST_DUE) {
      ctx.summary.actionRequired += 1;
    }
  }
}

async function stampAddonProviderState(
  addonId: string,
  observedAtUtc: Date | null,
): Promise<void> {
  if (!observedAtUtc) return;
  await prisma.workspaceStorageAddon.update({
    where: { id: addonId },
    data: { providerStateAtUtc: observedAtUtc },
  });
}

/**
 * Recurring add-ons that are still live under a base subscription that is not.
 *
 * Counted rather than cancelled here: this function runs inside an
 * OBSERVATION pass, and cancelling at the provider is a mutation that belongs
 * to the cancellation service, which asks the provider first and refuses to
 * record anything it did not confirm.
 */
export async function countActiveDependentAddons(input: {
  ownerUserId: string;
  teamId: string | null;
}): Promise<number> {
  return prisma.workspaceStorageAddon.count({
    where: {
      ...(input.teamId
        ? { teamId: input.teamId }
        : { ownerUserId: input.ownerUserId, teamId: null }),
      billingCycle: prismaPkg.StorageAddonBillingCycle.MONTHLY,
      externalSubscriptionId: { not: null },
      status: {
        in: [
          prismaPkg.WorkspaceStorageAddonStatus.ACTIVE,
          prismaPkg.WorkspaceStorageAddonStatus.PENDING,
          prismaPkg.WorkspaceStorageAddonStatus.PAST_DUE,
        ],
      },
    },
  });
}
