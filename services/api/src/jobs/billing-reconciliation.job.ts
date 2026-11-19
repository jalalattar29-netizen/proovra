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
 *   * `ACCOUNT_BATCH` accounts per round, rounds bounded by a time budget and
 *     an account ceiling per tick (F-07) — never a full-table sweep.
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
import { acquireLease } from "../services/rate-limit.js";
import {
  applyHeldPlanLowerings,
  finalizeEndedPayPalPaidPeriods,
  retrySupersededCancellations,
} from "../services/billing/subscription-lifecycle.handlers.js";
import { finalizeEndedStorageAddons, holdPastDueAddonCapacityEnds } from "../services/billing/paid-period.service.js";
import { closeDueInternalGrants } from "../services/billing/internal-plan-grant.service.js";
import { sweepExcludedReferences } from "../services/billing/provider-binding-check.service.js";
import { ABANDONED_RECHECK_WINDOW_MS } from "../services/billing/checkout-attempt-recovery.service.js";

/** Accounts offered to the authority per round (a tick drains several rounds, F-07). */
export const ACCOUNT_BATCH = 20;

/**
 * F-07 (Free-user audit 4d9b, capacity; 2026-11-15) — a tick DRAINS.
 *
 * One tick used to offer one batch of 20 accounts and stop, so after a webhook
 * outage N stranded accounts needed at least N/20 hours. A tick now keeps
 * offering rounds of ACCOUNT_BATCH under the SAME lease until one of:
 *
 *   * no candidate is left that this cycle has not offered ("drained");
 *   * the time budget is spent ("budget") — checked before every account, so
 *     a tick overruns it by at most one account's reconciliation;
 *   * the per-tick account ceiling is reached ("max_accounts") — the bound on
 *     provider calls one tick can make;
 *   * a round met a provider it could not ask ("provider_unavailable") — the
 *     existing rule that an outage degrades to "no more repairs this tick",
 *     never to a retry storm (the first round behaves exactly as before).
 *
 *   BILLING_RECONCILER_TICK_BUDGET_MS        300000 (5 min; the lease is 30 min)
 *   BILLING_RECONCILER_MAX_ACCOUNTS_PER_TICK 500
 *
 * FAIR PROGRESS. The candidate queries stay keyset-ordered by what the data
 * says (oldest-touched first, five categories round-robin). On top of that the
 * process remembers which accounts this CYCLE has already offered and asks for
 * the others first, so a backlog larger than one tick is covered in rotation
 * instead of re-offering the same oldest rows every tick (an account the
 * provider reports in sync writes nothing and would otherwise stay oldest for
 * ever). When every candidate has been offered the cycle starts again. The
 * memory is per process and bounded (CYCLE_MEMORY_CAP); a restart simply
 * begins a new cycle from the oldest rows. Settlement stays the existing
 * idempotent, compare-and-set authority (reconcileBillingAccount).
 */
export const DEFAULT_TICK_BUDGET_MS = 300_000;
export const DEFAULT_MAX_ACCOUNTS_PER_TICK = 500;
const CYCLE_MEMORY_CAP = 5_000;

function wholeNumberSetting(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw.trim());
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

/** Accounts offered since the current fair-rotation cycle began (this process). */
const reconciliationCycle = { offered: new Set<string>() };

/** Test seam: forget the rotation (a fresh process). */
export function resetReconciliationCycle(): void {
  reconciliationCycle.offered.clear();
}

export type ReconciliationTickStop = "drained" | "budget" | "max_accounts" | "provider_unavailable";

/**
 * How long an open checkout attempt is left to its return route and webhooks
 * before the sweep asks the provider about it.
 */
export const ATTEMPT_SWEEP_GRACE_MS = 5 * 60 * 1000;

/** Longest a crashed sweep can hold the lease. */
const SWEEP_LEASE_MS = 30 * 60 * 1000;

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
  /** F-07 — accounts this tick/cycle already offered; asked for the others. */
  options: { excludeUserIds?: ReadonlyArray<string>; onlyUserIds?: ReadonlyArray<string> } = {},
): Promise<BillingAccountRef[]> {
  const creditProduct = { OR: [{ product: "EVIDENCE_CREDIT" }, { product: null }] };
  const skip = options.excludeUserIds && options.excludeUserIds.length > 0 ? [...options.excludeUserIds] : null;
  // F-07 test seam — confine the selection to these accounts (a suite sharing
  // its database with others measures only its own). No production caller
  // passes it.
  const only = options.onlyUserIds ? [...options.onlyUserIds] : null;
  const userScope = { ...(skip ? { notIn: skip } : {}), ...(only ? { in: only } : {}) };
  const scoped = skip !== null || only !== null;
  const notOffered = scoped ? { userId: userScope } : {};
  const ownerNotOffered = scoped ? { ownerUserId: userScope } : {};
  // BILLING REMEDIATION (2026-10-30, AUD-14) — a reference the provider just
  // answered 404 for, not due again yet. A failed read writes nothing, so such a
  // row stayed oldest-touched and took a batch slot on every tick.
  const excluded = await sweepExcludedReferences(now);
  const abandonedSince = new Date(now.getTime() - ABANDONED_RECHECK_WINDOW_MS);
  const [attempts, pendingPayments, settledCredits, addons, subscriptions, abandonedAttempts, abandonedAddons] = await Promise.all([
    prisma.billingCheckoutAttempt.findMany({
      where: {
        status: prismaPkg.BillingCheckoutAttemptStatus.PENDING,
        createdAt: { lt: new Date(now.getTime() - ATTEMPT_SWEEP_GRACE_MS) },
        ...notOffered,
      },
      // Each check writes the attempt's metadata, which bumps updatedAt, so
      // the oldest-checked attempt is always next.
      orderBy: { updatedAt: "asc" },
      take: limit,
      select: { userId: true },
    }),
    prisma.payment.findMany({
      where: { teamId: null, status: prismaPkg.PaymentStatus.PENDING, ...creditProduct, ...notOffered },
      orderBy: { createdAt: "asc" },
      take: limit,
      select: { userId: true },
    }),
    prisma.payment.findMany({
      where: { teamId: null, status: prismaPkg.PaymentStatus.SUCCEEDED, ...creditProduct, ...notOffered },
      orderBy: { createdAt: "desc" },
      take: limit * 4,
      select: { userId: true, provider: true, providerPaymentId: true },
    }),
    prisma.workspaceStorageAddon.findMany({
      where: {
        billingCycle: prismaPkg.StorageAddonBillingCycle.MONTHLY,
        externalSubscriptionId: { not: null, notIn: excluded },
        status: {
          in: [
            prismaPkg.WorkspaceStorageAddonStatus.ACTIVE,
            prismaPkg.WorkspaceStorageAddonStatus.PENDING,
            prismaPkg.WorkspaceStorageAddonStatus.PAST_DUE,
          ],
        },
        ...ownerNotOffered,
      },
      orderBy: { updatedAt: "asc" },
      take: limit,
      select: { ownerUserId: true },
    }),
    prisma.subscription.findMany({
      where: {
        providerSubId: { notIn: excluded },
        status: {
          in: [
            prismaPkg.SubscriptionStatus.ACTIVE,
            prismaPkg.SubscriptionStatus.TRIALING,
            prismaPkg.SubscriptionStatus.PAST_DUE,
          ],
        },
        ...notOffered,
      },
      orderBy: { updatedAt: "asc" },
      take: limit,
      select: { userId: true },
    }),
    // AUD-20 — an abandoned purchase can still be approved at the provider. It
    // left this query when it was abandoned, so a late approval whose webhook
    // was lost waited for the customer to press a button.
    prisma.billingCheckoutAttempt.findMany({
      where: {
        status: prismaPkg.BillingCheckoutAttemptStatus.ABANDONED,
        providerResourceId: { not: null },
        createdAt: { gte: abandonedSince },
        ...notOffered,
      },
      orderBy: { updatedAt: "asc" },
      take: limit,
      select: { userId: true },
    }),
    prisma.workspaceStorageAddon.findMany({
      where: {
        billingCycle: prismaPkg.StorageAddonBillingCycle.MONTHLY,
        externalSubscriptionId: { not: null, notIn: excluded },
        status: prismaPkg.WorkspaceStorageAddonStatus.ABANDONED,
        createdAt: { gte: abandonedSince },
        ...ownerNotOffered,
      },
      orderBy: { updatedAt: "asc" },
      take: limit,
      select: { ownerUserId: true },
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
    [...abandonedAttempts.map((a) => a.userId), ...abandonedAddons.map((a) => a.ownerUserId)],
  ];

  // F-07 — the SQL already left them out; a guard, not a second rule.
  const seen = new Set<string>(skip ?? []);
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
  /** F-07 — overrides BILLING_RECONCILER_TICK_BUDGET_MS (tests). */
  budgetMs?: number;
  /** F-07 — overrides BILLING_RECONCILER_MAX_ACCOUNTS_PER_TICK (tests). */
  maxAccounts?: number;
  /** F-07 test seam — only these accounts are offered (a shared test database). */
  onlyUserIds?: ReadonlyArray<string>;
}): Promise<{
  attempted: number;
  updated: number;
  failed: number;
  /** Provider facts that did not match our prices: review items, never grants. */
  discrepancies: number;
  /** Bindings the provider could not be asked about this tick. */
  unavailable: number;
  /** F-07 — rounds of ACCOUNT_BATCH this tick offered, and why it stopped. */
  rounds?: number;
  stopReason?: ReconciliationTickStop;
  /** Another process holds the sweep; this tick did nothing. */
  skipped?: boolean;
}> {
  // BILLING REMEDIATION (2026-10-30, AUD-14) — one sweep across all processes.
  // The writers are compare-and-set, so overlap never double-applied, but it
  // doubled every provider read and raced the supersession retry's lease.
  // B8-F-004 — every API process starts this sweep on its own timer, so an
  // unreadable lock REFUSES (AUD-50) instead of each process taking its own
  // memory lease during a Redis outage.
  const lease = await acquireLease("billing_reconciliation_sweep", SWEEP_LEASE_MS, {
    onStoreError: "refuse",
  });
  if (!lease.acquired) {
    return { attempted: 0, updated: 0, failed: 0, discrepancies: 0, unavailable: 0, skipped: true };
  }
  try {
    return await runSweep(input);
  } finally {
    await lease.release();
  }
}

async function runSweep(input?: {
  limit?: number;
  providers?: ReconciliationProviders;
  budgetMs?: number;
  maxAccounts?: number;
  onlyUserIds?: ReadonlyArray<string>;
}): Promise<{
  attempted: number;
  updated: number;
  failed: number;
  discrepancies: number;
  unavailable: number;
  rounds: number;
  stopReason: ReconciliationTickStop;
}> {
  // Maintenance no single account's pass would reach. Each step is isolated: a
  // failure is logged and the account sweep below still runs.
  await finalizeEndedStorageAddons().catch((err: unknown) => {
    logWarn("billing.reconciliation.finalize_addons_failed", {
      err: err instanceof Error ? err.message : "unknown",
    });
  });
  // PRO-BL1-04 / DEC-02 — past-due add-ons beyond the 7-day grace: with the
  // add-on switch off their capacity is kept and a held review item says so.
  await holdPastDueAddonCapacityEnds().catch((err: unknown) => {
    logWarn("billing.reconciliation.past_due_addon_hold_failed", {
      err: err instanceof Error ? err.message : "unknown",
    });
  });
  await closeDueInternalGrants(prisma).catch((err: unknown) => {
    logWarn("billing.reconciliation.grant_expiry_failed", {
      err: err instanceof Error ? err.message : "unknown",
    });
  });
  await retrySupersededCancellations().catch((err: unknown) => {
    logWarn("billing.reconciliation.supersession_retry_failed", {
      err: err instanceof Error ? err.message : "unknown",
    });
  });
  // PRO-BL1-03 — a cancelled PayPal plan ends when its kept paid period does
  // (the customer's own cancellation; not held by the lowering switch).
  await finalizeEndedPayPalPaidPeriods().catch((err: unknown) => {
    logWarn("billing.reconciliation.paypal_paid_period_finalize_failed", {
      err: err instanceof Error ? err.message : "unknown",
    });
  });
  // PRO-W2C-01 — a lowering the sweep held is applied once the switch is on
  // (and changes nothing while it is off).
  await applyHeldPlanLowerings().catch((err: unknown) => {
    logWarn("billing.reconciliation.held_plan_lowering_failed", {
      err: err instanceof Error ? err.message : "unknown",
    });
  });

  const batch = input?.limit ?? ACCOUNT_BATCH;
  const budgetMs =
    input?.budgetMs ??
    wholeNumberSetting(process.env.BILLING_RECONCILER_TICK_BUDGET_MS, DEFAULT_TICK_BUDGET_MS, 1_000, 25 * 60 * 1000);
  const maxAccounts =
    input?.maxAccounts ??
    wholeNumberSetting(process.env.BILLING_RECONCILER_MAX_ACCOUNTS_PER_TICK, DEFAULT_MAX_ACCOUNTS_PER_TICK, 1, 5_000);
  const startedAt = Date.now();
  const deadline = startedAt + budgetMs;
  const cycle = reconciliationCycle.offered;
  const offeredThisTick = new Set<string>();

  let updated = 0;
  let failed = 0;
  let discrepancies = 0;
  let unavailable = 0;
  let rounds = 0;
  let cycleRestarted = false;
  let stopReason: ReconciliationTickStop = "drained";

  // F-07 — rounds until drained, out of budget, at the ceiling, or a provider
  // could not be asked.
  for (;;) {
    if (Date.now() >= deadline) {
      stopReason = "budget";
      break;
    }
    if (offeredThisTick.size >= maxAccounts) {
      stopReason = "max_accounts";
      break;
    }
    const candidates = await selectReconciliationCandidates(
      Math.min(batch, maxAccounts - offeredThisTick.size),
      new Date(),
      { excludeUserIds: [...cycle, ...offeredThisTick], onlyUserIds: input?.onlyUserIds },
    );
    if (candidates.length === 0) {
      // Every candidate has been offered since this cycle began: begin the
      // next cycle (once per tick — nothing is offered twice in one tick).
      if (cycle.size === 0 || cycleRestarted) break;
      cycle.clear();
      cycleRestarted = true;
      continue;
    }
    rounds += 1;
    let roundUnavailable = 0;
    for (const account of candidates) {
      if (Date.now() >= deadline) break;
      offeredThisTick.add(account.id);
      cycle.add(account.id);
      try {
        const summary = await reconcileBillingAccount({
          account,
          providers: input?.providers,
        });
        if (summary.outcome === "UPDATED") updated += 1;
        discrepancies += summary.discrepancies;
        unavailable += summary.unavailable;
        roundUnavailable += summary.unavailable;
      } catch (err) {
        // Per-account isolation: one broken account must not end the tick.
        failed += 1;
        logWarn("billing.reconciliation.account_failed", {
          accountType: account.type,
          err: err instanceof Error ? err.message : "unknown",
        });
      }
    }
    if (roundUnavailable > 0) {
      stopReason = "provider_unavailable";
      break;
    }
  }
  if (cycle.size > CYCLE_MEMORY_CAP) cycle.clear();

  logInfo("billing.reconciliation.sweep_completed", {
    attempted: offeredThisTick.size,
    updated,
    failed,
    discrepancies,
    unavailable,
    rounds,
    stopReason,
    elapsedMs: Date.now() - startedAt,
  });
  // A discrepancy is a customer who paid and was not credited. Each one is
  // now a durable review item; the warning makes the tick that found it
  // visible rather than folded into a success line.
  if (discrepancies > 0) {
    logWarn("billing.reconciliation.discrepancies_found", { discrepancies });
  }

  return { attempted: offeredThisTick.size, updated, failed, discrepancies, unavailable, rounds, stopReason };
}
