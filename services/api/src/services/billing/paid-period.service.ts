/**
 * BILLING REMEDIATION (2026-10-30, AUD-09) — a cancelled storage add-on keeps the
 * month already paid for.
 *
 * PayPal's cancel is immediate, and it ends BILLING. It does not refund the month
 * in progress, so ending the capacity with it took away storage the customer had
 * paid for, silently, including when cancelling a Stripe plan cancelled a PayPal
 * add-on beside it.
 *
 * An add-on the provider cancelled keeps its status until its paid period ends.
 * `expiresAtUtc` records that moment and `finalizeEndedStorageAddons` closes it.
 * Its own module because the obligation worker and the storage authority both
 * need it and import each other's neighbours.
 */

import * as prismaPkg from "@prisma/client";

import { prisma } from "../../db.js";

/**
 * Returns whether the paid period was kept. A row past its period, or never paid
 * for, falls through to the ordinary CANCELED transition.
 */
export async function keepPaidPeriodAfterProviderCancel(input: {
  addonId: string;
  observedAtUtc?: Date | null;
  now?: Date;
}): Promise<boolean> {
  const now = input.now ?? new Date();
  const row = await prisma.workspaceStorageAddon.findUnique({
    where: { id: input.addonId },
    select: { status: true, currentPeriodEnd: true, activatedAtUtc: true },
  });
  if (
    row?.status !== prismaPkg.WorkspaceStorageAddonStatus.ACTIVE ||
    !row.activatedAtUtc ||
    !row.currentPeriodEnd ||
    row.currentPeriodEnd <= now
  ) {
    return false;
  }
  await prisma.workspaceStorageAddon.update({
    where: { id: input.addonId },
    data: {
      expiresAtUtc: row.currentPeriodEnd,
      canceledAtUtc: input.observedAtUtc ?? now,
      ...(input.observedAtUtc ? { providerStateAtUtc: input.observedAtUtc } : {}),
    },
  });
  return true;
}

/** Close add-ons whose paid period ended after their provider cancelled them. */
export async function finalizeEndedStorageAddons(now: Date = new Date()): Promise<number> {
  const closed = await prisma.workspaceStorageAddon.updateMany({
    where: {
      billingCycle: prismaPkg.StorageAddonBillingCycle.MONTHLY,
      status: prismaPkg.WorkspaceStorageAddonStatus.ACTIVE,
      expiresAtUtc: { lte: now },
    },
    data: { status: prismaPkg.WorkspaceStorageAddonStatus.CANCELED },
  });
  return closed.count;
}
