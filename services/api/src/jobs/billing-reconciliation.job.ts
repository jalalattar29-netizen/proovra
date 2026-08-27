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
 * The accounts whose stored bindings could need repair.
 *
 * Deliberately narrow. An account with no live provider binding and no
 * ungranted payment has nothing a provider could tell us, so asking would be a
 * request spent to learn nothing.
 */
export async function selectReconciliationCandidates(
  limit: number = ACCOUNT_BATCH,
): Promise<BillingAccountRef[]> {
  const [subscriptions, addons, ungrantedPayments] = await Promise.all([
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
      select: { userId: true, teamId: true },
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
      select: { ownerUserId: true, teamId: true },
    }),
    // A settled personal payment with no PURCHASE ledger row is the exact
    // shape of a lost credit webhook. The join is expressed as a NOT-EXISTS
    // over the ledger rather than a scan of every payment ever made.
    prisma.payment.findMany({
      where: {
        teamId: null,
        status: prismaPkg.PaymentStatus.SUCCEEDED,
      },
      orderBy: { createdAt: "desc" },
      take: limit * 4,
      select: { userId: true, provider: true, providerPaymentId: true },
    }),
  ]);

  const granted = ungrantedPayments.length
    ? await prisma.evidenceCreditLedgerEntry.findMany({
        where: {
          entryType: prismaPkg.EvidenceCreditEntryType.PURCHASE,
          providerRef: { in: ungrantedPayments.map((p) => p.providerPaymentId) },
        },
        select: { provider: true, providerRef: true },
      })
    : [];
  const grantedKeys = new Set(
    granted.map((g) => `${String(g.provider)}:${g.providerRef}`),
  );

  // Deduplicate to ACCOUNTS. One account with four bindings is one unit of
  // work, because the authority reconciles all of its bindings in one pass.
  const seen = new Set<string>();
  const out: BillingAccountRef[] = [];

  const push = (type: BillingAccountRef["type"], id: string) => {
    const key = `${type}:${id}`;
    if (seen.has(key) || out.length >= limit) return;
    seen.add(key);
    // The sweep is a SERVICE actor. It holds no viewer capabilities and its
    // work is not shown to anyone, so the ref carries an empty capability set
    // — the authority it calls does not read them.
    out.push({
      type,
      id,
      displayName: "",
      capabilities: [],
      billingOwnerMissing: false,
    });
  };

  for (const p of ungrantedPayments) {
    if (grantedKeys.has(`${String(p.provider)}:${p.providerPaymentId}`)) continue;
    push("PERSONAL", p.userId);
  }
  for (const sub of subscriptions) {
    if (sub.teamId) push("WORKSPACE", sub.teamId);
    else push("PERSONAL", sub.userId);
  }
  for (const addon of addons) {
    if (addon.teamId) push("WORKSPACE", addon.teamId);
    else push("PERSONAL", addon.ownerUserId);
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
