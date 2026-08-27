/**
 * BILLING DEPENDENT-CANCELLATION CONVERGENCE (2026-08-27) — the dependent
 * cascade, now durable.
 *
 * WHAT CHANGED, AND WHY
 * ---------------------------------------------------------------------------
 * This module used to call the provider directly and, on failure, increment an
 * in-memory counter inside a bare `catch`. That counter died with the HTTP
 * response: nothing was persisted, so nothing could retry, nothing could alert,
 * and no query could find the add-on that was still charging. A single
 * provider blip billed a customer indefinitely for storage they had cancelled.
 *
 * It now does two things and neither of them is a provider call:
 *
 *   1. `recordDependentCancellationObligations` persists the intent, inside
 *      the caller's transaction, alongside the base cancellation result.
 *   2. `attemptDependentCancellations` makes the first attempt against those
 *      durable rows.
 *
 * The provider semantics live in `storage-addon-cancellation.service.ts`, which
 * the direct add-on route also uses — so a Stripe add-on is scheduled for
 * period end whether the customer cancelled it on its own or by cancelling
 * their plan. There is no longer a second implementation to disagree.
 *
 * THE ORDER IS UNCHANGED, DELIBERATELY
 * ---------------------------------------------------------------------------
 * The base subscription is still cancelled at the provider FIRST. Reversing it
 * would remove paid storage from a customer whose plan then failed to cancel —
 * less capacity and the same charge, which is strictly worse. Multiple remote
 * subscriptions cannot be cancelled atomically, so the answer is a durable
 * compensating obligation, not a different order.
 */

import * as prismaPkg from "@prisma/client";

import { prisma } from "../../db.js";
import {
  attemptDependentCancellations,
  dependentAddonWhere,
  recordDependentCancellationObligations,
  UNRESOLVED_STATES,
} from "./dependent-cancellation.service.js";
import type { StorageAddonProviderCanceller } from "./storage-addon-cancellation.service.js";

/** What happened to the dependent add-ons of one base cancellation. */
export type DependentCancellationResult = {
  /** Add-ons that owe a cancellation after this request. */
  found: number;
  /** Add-ons the provider CONFIRMED will stop. */
  scheduled: number;
  /**
   * Add-ons the provider did NOT confirm. Non-zero means the caller must
   * report ACTION_REQUIRED — something is still charging — and the obligation
   * is now durable, so the worker will keep trying regardless.
   */
  failed: number;
};

/**
 * The recurring add-ons that depend on one base billing subject.
 *
 * Re-exported from the obligation authority so there is ONE definition of
 * "which add-ons does this base plan own". A legacy ONE_TIME row has no
 * provider binding and is never included: it is not a subscription, so it is
 * never cascaded, never retried and never charged again.
 */
export async function findDependentRecurringAddons(input: {
  ownerUserId: string;
  teamId: string | null;
}) {
  return prisma.workspaceStorageAddon.findMany({
    where: dependentAddonWhere(input),
    select: {
      id: true,
      paymentProvider: true,
      externalSubscriptionId: true,
      status: true,
    },
  });
}

/**
 * Record the obligation for every dependent add-on, then attempt it.
 *
 * `client` is the caller's transaction. The obligations are written in it, with
 * the base cancellation result, which is the crash-safety boundary: there is no
 * window in which the base is cancelled at the provider and the intent to stop
 * its dependants exists nowhere. The provider attempts happen AFTER that
 * transaction commits, because a remote call inside a database transaction
 * holds a connection open across the network.
 */
export async function recordDependentCancellationIntent(
  input: {
    ownerUserId: string;
    teamId: string | null;
    triggeredBySubscriptionId: string;
    now?: Date;
  },
  client: Pick<prismaPkg.Prisma.TransactionClient, "workspaceStorageAddon">,
): Promise<{ created: number; alreadyOpen: number }> {
  return recordDependentCancellationObligations(input, client);
}

/**
 * Attempt every outstanding obligation for one billing subject.
 *
 * Idempotent and safe to repeat: already-CONFIRMED add-ons are not selected,
 * the base subscription is never touched, and a durable lease stops the
 * customer's retry and the worker's sweep attempting the same add-on at once.
 */
export async function cancelDependentRecurringAddons(input: {
  ownerUserId: string;
  teamId: string | null;
  /** Retained for call compatibility; provider semantics come from the binding. */
  mode?: "PERIOD_END" | "IMMEDIATE";
  /** Injected by contract tests; production uses the real clients. */
  cancelAtProvider?: StorageAddonProviderCanceller;
  now?: Date;
}): Promise<DependentCancellationResult> {
  const attempt = await attemptDependentCancellations({
    ownerUserId: input.ownerUserId,
    teamId: input.teamId,
    cancelAtProvider: input.cancelAtProvider,
    now: input.now,
  });

  // What the caller reports is the state AFTER the attempt: anything still
  // unresolved is still charging, whether this attempt touched it or a lease
  // held it elsewhere.
  const stillOwed = await prisma.workspaceStorageAddon.count({
    where: {
      ...(input.teamId
        ? { teamId: input.teamId }
        : { ownerUserId: input.ownerUserId, teamId: null }),
      dependentCancellationState: { in: [...UNRESOLVED_STATES] },
    },
  });

  return {
    found: attempt.confirmed + stillOwed,
    scheduled: attempt.confirmed,
    failed: stillOwed,
  };
}
