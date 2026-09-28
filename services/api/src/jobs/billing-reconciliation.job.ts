/**
 * THE SCHEDULED BILLING RECONCILIATION SWEEP.
 *
 * WHY IT EXISTS
 * ---------------------------------------------------------------------------
 * The manual `Re-check purchases and billing` action only helps a customer who
 * notices. Someone who bought an evidence credit, never received it, and
 * assumed the product was broken will not press a button — they will churn.
 * This sweep offers the same reconciliation to accounts that have a binding
 * capable of needing repair, without anyone asking.
 *
 * WHAT IT IS NOT
 * ---------------------------------------------------------------------------
 * It is not a second reconciliation implementation. Every account it selects
 * is handed to `reconcileBillingAccount`, the same authority the route calls,
 * so a fact learned by the sweep and a fact learned by a customer's press
 * cannot mean different things. This file decides only WHICH accounts to offer
 * and in what order.
 *
 * IT NEVER ENUMERATES A PROVIDER
 * ---------------------------------------------------------------------------
 * The candidate set comes from OUR OWN tables — subscriptions and add-ons in a
 * repairable state, and personal payments whose credits were never granted.
 * Nothing here lists Stripe customers or PayPal subscriptions. A provider is
 * only ever asked about a reference this server already stored, which is what
 * keeps the request volume proportional to our data rather than to the
 * provider's.
 *
 * BOUNDED IN EVERY DIRECTION
 * ---------------------------------------------------------------------------
 *   * `ACCOUNT_BATCH` accounts per tick — never a full-table sweep.
 *   * keyset ordering by the account's own last-touched time, so a restarted
 *     process resumes from what the DATA says rather than an in-memory offset.
 *   * one try/catch per account: a single broken account cannot abort the tick.
 *   * the reconciliation service caps bindings per account independently.
 *   * a provider that is failing produces UNKNOWN observations, which change
 *     nothing — so a provider outage degrades to "no repairs this tick" rather
 *     than to a retry storm.
 */

import * as prismaPkg from "@prisma/client";

import { prisma } from "../db.js";
import { log as logInfo, warn as logWarn } from "../utils/logger.js";
import {
  reconcileBillingAccount,
  type ReconciliationProviders,
} from "../services/billing/reconciliation/reconciliation.service.js";
import type { BillingAccountRef } from "../services/billing/billing-accounts.service.js";

/** Accounts offered to the authority per tick. */
export const ACCOUNT_BATCH = 20;

/**
 * How long an open checkout attempt is left to its return route and webhooks
 * before the sweep asks the provider about it.
 */
export const ATTEMPT_SWEEP_GRACE_MS = 5 * 60 * 1000;

/**
 * The accounts whose stored bindings could need repair.
 *
 * BILLING PAYPAL INTEGRITY (2026-09-28) — five categories, each with its own
 * share of the batch, filled round-robin:
 *
 *   1. open checkout attempts (a credit capture whose response was lost, an
 *      approval whose webhook never came, an approval-pending plan that must
 *      eventually be closed) — never looked at before, so a paid-but-unrecorded
 *      credit waited for the customer to press a button;
 *   2. PENDING credit payments (a capture still settling whose completion
 *      webhook was lost);
 *   3. SUCCEEDED credit payments with no ledger grant (a lost grant);
 *   4. recurring storage add-ons;
 *   5. base subscriptions.
 *
 * Category 3 used to take EVERY settled personal payment without a ledger
 * row — every plan and storage renewal qualifies, forever — and was pushed
 * first, so with twenty recent payers nothing else ever got a slot.
 */
export async function selectReconciliationCandidates(
  limit: number = ACCOUNT_BATCH,
  now: Date = new Date(),
): Promise<BillingAccountRef[]> {
  const creditProduct = { OR: [{ product: "EVIDENCE_CREDIT" }, { product: null }] };
  const [attempts, pendingPayments, settledCredits, addons, subscriptions] = await Promise.all([
    prisma.billingCheckoutAttempt.findMany({
      where: {
        status: prismaPkg.BillingCheckoutAttemptStatus.PENDING,
        createdAt: { lt: new Date(now.getTime() - ATTEMPT_SWEEP_GRACE_MS) },
      },
      // Each check writes the attempt's metadata, which bumps updatedAt, so
      // the oldest-checked attempt is always next.
      orderBy: { updatedAt: "asc" },
      take: limit,
      select: { userId: true },
    }),
    prisma.payment.findMany({
      where: { teamId: null, status: prismaPkg.PaymentStatus.PENDING, ...creditProduct },
      orderBy: { createdAt: "asc" },
      take: limit,
      select: { userId: true },
    }),
    prisma.payment.findMany({
      where: { teamId: null, status: prismaPkg.PaymentStatus.SUCCEEDED, ...creditProduct },
      orderBy: { createdAt: "desc" },
      take: limit * 4,
      select: { userId: true, provider: true, providerPaymentId: true },
    }),
    prisma.workspaceStorageAddon.findMany({
      where: {
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
      orderBy: { updatedAt: "asc" },
      take: limit,
      select: { ownerUserId: true },
    }),
    prisma.subscription.findMany({
      where: {
        status: {
          in: [
            prismaPkg.SubscriptionStatus.ACTIVE,
            prismaPkg.SubscriptionStatus.TRIALING,
            prismaPkg.SubscriptionStatus.PAST_DUE,
          ],
        },
      },
      orderBy: { updatedAt: "asc" },
      take: limit,
      select: { userId: true },
    }),
  ]);

  const granted = settledCredits.length
    ? await prisma.evidenceCreditLedgerEntry.findMany({
        where: {
          entryType: prismaPkg.EvidenceCreditEntryType.PURCHASE,
          providerRef: { in: settledCredits.map((p) => p.providerPaymentId) },
        },
        select: { provider: true, providerRef: true },
      })
    : [];
  const grantedKeys = new Set(granted.map((g) => `${String(g.provider)}:${g.providerRef}`));
  const ungranted = settledCredits.filter(
    (p) => !grantedKeys.has(`${String(p.provider)}:${p.providerPaymentId}`),
  );

  // Every self-service binding reconciles against its OWNER's personal
  // account (BILLING PERSONAL/ORGANIZATION MODEL, 2026-08-28).
  const queues: string[][] = [
    attempts.map((a) => a.userId),
    pendingPayments.map((p) => p.userId),
    ungranted.map((p) => p.userId),
    addons.map((a) => a.ownerUserId),
    subscriptions.map((s) => s.userId),
  ];

  const seen = new Set<string>();
  const out: BillingAccountRef[] = [];
  const cursors = queues.map(() => 0);
  let progressed = true;
  while (out.length < limit && progressed) {
    progressed = false;
    for (let q = 0; q < queues.length && out.length < limit; q++) {
      const queue = queues[q]!;
      while (cursors[q]! < queue.length) {
        const userId = queue[cursors[q]!]!;
        cursors[q] = cursors[q]! + 1;
        if (seen.has(userId)) continue;
        seen.add(userId);
        // The sweep is a SERVICE actor. It holds no viewer capabilities and
        // its work is not shown to anyone.
        out.push({
          type: "PERSONAL",
          id: userId,
          displayName: "",
          capabilities: [],
          billingOwnerMissing: false,
        });
        progressed = true;
        break;
      }
    }
  }
  return out;
}
/**
 * One tick.
 *
 * Returns the per-account outcomes so the caller can log a bounded operational
 * summary. Nothing here logs a provider payload, a provider id, an amount or a
 * customer identifier.
 */
export async function runBillingReconciliationSweep(input?: {
  limit?: number;
  providers?: ReconciliationProviders;
}): Promise<{ attempted: number; updated: number; failed: number }> {
  const candidates = await selectReconciliationCandidates(
    input?.limit ?? ACCOUNT_BATCH,
  );

  let updated = 0;
  let failed = 0;

  for (const account of candidates) {
    try {
      const summary = await reconcileBillingAccount({
        account,
        providers: input?.providers,
      });
      if (summary.outcome === "UPDATED") updated += 1;
    } catch (err) {
      // Per-account isolation: one broken account must not end the tick.
      failed += 1;
      logWarn("billing.reconciliation.account_failed", {
        accountType: account.type,
        err: err instanceof Error ? err.message : "unknown",
      });
    }
  }

  logInfo("billing.reconciliation.sweep_completed", {
    attempted: candidates.length,
    updated,
    failed,
  });

  return { attempted: candidates.length, updated, failed };
}
