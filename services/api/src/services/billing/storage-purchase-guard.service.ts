/**
 * BILLING REMEDIATION (2026-10-30, section 10) — what stands between a repeat
 * click and a second recurring charge.
 *
 * Stacking is the product's behaviour: capacity sums the rows, and buying a SKU
 * twice is allowed. So this refuses nothing permanently. It separates TWO THINGS
 * that used to look identical to the server:
 *
 *   * intending to add more, which the customer states after seeing what they
 *     already pay for (`confirmAdditional`);
 *   * repeating a purchase that may already have worked: a stale tab, a second
 *     device, or a retry after an outcome nobody saw.
 *
 * Without the statement, any live add-on of this SKU or any open purchase on
 * EITHER provider answers 409 with what it found. An open purchase also blocks
 * across providers here, which the per-provider gates cannot see.
 *
 * BILLING DECISIONS (2026-10-31, section C) — the statement covers what the
 * customer saw, and nothing else. An open purchase on the other provider answers
 * 409 even with it, because that purchase may be the very storage they are
 * adding, and a count that moved since they confirmed asks them again.
 */

import * as prismaPkg from "@prisma/client";

import { prisma } from "../../db.js";
import { payerLegacyWorkspaceIds } from "./billing-accounts.service.js";
import { APPROVAL_EXPIRY_MS } from "./checkout-attempt-recovery.service.js";
import { CHECKOUT_REUSE_WINDOW_MS } from "./checkout-attempts.service.js";

/** The reads this guard makes; a checkout gate passes its locked transaction. */
export type StorageDuplicateClient = Pick<
  prismaPkg.Prisma.TransactionClient,
  "team" | "workspaceStorageAddon" | "billingCheckoutAttempt"
>;

const LIVE = [prismaPkg.WorkspaceStorageAddonStatus.ACTIVE, prismaPkg.WorkspaceStorageAddonStatus.PAST_DUE];

export type StorageDuplicateFinding = {
  code: "STORAGE_ADDON_ALREADY_HELD" | "STORAGE_PURCHASE_PENDING";
  message: string;
  details: {
    addonKey: prismaPkg.StorageAddonKey;
    activeCount: number;
    pendingProvider: prismaPkg.PaymentProvider | null;
    attemptId: string | null;
    createdAtUtc: string | null;
    retry: "CONFIRM_ADDITIONAL" | "RECONCILE_STORAGE_ATTEMPT";
  };
};

export async function findStorageDuplicate(input: {
  userId: string;
  addonKey: prismaPkg.StorageAddonKey;
  provider: prismaPkg.PaymentProvider;
  /** The customer's statement. A null count comes from a client that sends none. */
  confirmation?: { heldCount: number | null } | null;
  now?: Date;
  /**
   * FREE-AUDIT REMEDIATION (2026-11-13, DUP-STORAGE) — the gate's transaction,
   * holding `personalStorageCheckoutLockKey`. The route's early call (no client)
   * answers fast; the gate's call under the lock is the one that decides.
   */
  client?: StorageDuplicateClient;
}): Promise<StorageDuplicateFinding | null> {
  const db = input.client ?? prisma;
  const now = input.now ?? new Date();
  const since = new Date(now.getTime() - APPROVAL_EXPIRY_MS);
  // A purchase the other provider is still CREATING (no provider id yet) is as
  // open as a bound one: it is the other half of the two-tab race.
  const inFlightSince = new Date(now.getTime() - CHECKOUT_REUSE_WINDOW_MS);
  const legacy = await payerLegacyWorkspaceIds(input.userId, db);

  // Sequential on purpose: inside a transaction the reads share one connection.
  const activeCount = await db.workspaceStorageAddon.count({
    where: {
      ownerUserId: input.userId,
      addonKey: input.addonKey,
      status: { in: LIVE },
      OR: [{ teamId: null }, { teamId: { in: legacy } }],
    },
  });
  const openPayPal = await db.workspaceStorageAddon.findFirst({
    where: {
      ownerUserId: input.userId,
      addonKey: input.addonKey,
      status: prismaPkg.WorkspaceStorageAddonStatus.PENDING,
      // Only the OTHER provider's: a newer row of this provider must not hide
      // an older open one of the other (findFirst returns one row).
      paymentProvider: { not: input.provider },
      createdAt: { gte: since },
      OR: [
        { externalSubscriptionId: { not: null } },
        { createdAt: { gte: inFlightSince } },
      ],
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, createdAt: true, paymentProvider: true },
  });
  const openStripe = await db.billingCheckoutAttempt.findFirst({
    where: {
      userId: input.userId,
      product: prismaPkg.BillingCheckoutProduct.STORAGE_ADDON,
      storageAddonKey: input.addonKey,
      status: prismaPkg.BillingCheckoutAttemptStatus.PENDING,
      provider: { not: input.provider },
      createdAt: { gte: since },
      OR: [
        { providerResourceId: { not: null } },
        { createdAt: { gte: inFlightSince } },
      ],
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, createdAt: true, provider: true },
  });

  // The same provider's own gate handles its open attempt, and can reuse it.
  const other =
    openPayPal && openPayPal.paymentProvider !== input.provider
      ? { id: openPayPal.id, createdAt: openPayPal.createdAt, provider: openPayPal.paymentProvider }
      : openStripe && openStripe.provider !== input.provider
        ? { id: openStripe.id, createdAt: openStripe.createdAt, provider: openStripe.provider }
        : null;

  if (other) {
    return {
      code: "STORAGE_PURCHASE_PENDING",
      message:
        "This storage add-on already has a purchase open with your other payment method. Check that purchase before starting another, so you are not billed twice.",
      details: {
        addonKey: input.addonKey,
        activeCount,
        pendingProvider: other.provider,
        attemptId: other.id,
        createdAtUtc: other.createdAt.toISOString(),
        retry: "RECONCILE_STORAGE_ATTEMPT",
      },
    };
  }
  const confirmed =
    input.confirmation != null &&
    (input.confirmation.heldCount === null || input.confirmation.heldCount === activeCount);
  if (activeCount > 0 && !confirmed) {
    return {
      code: "STORAGE_ADDON_ALREADY_HELD",
      message:
        "You already pay for this storage add-on. Buying it again adds a second recurring charge and more storage.",
      details: {
        addonKey: input.addonKey,
        activeCount,
        pendingProvider: null,
        attemptId: null,
        createdAtUtc: null,
        retry: "CONFIRM_ADDITIONAL",
      },
    };
  }
  return null;
}
