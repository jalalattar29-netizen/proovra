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

import { pastDueAddonGraceCutoff } from "@proovra/shared-runtime";

import { prisma } from "../../db.js";
import { automaticAddonCancellationEnabled } from "./automatic-effects.js";
import { recordBillingReviewItem } from "./billing-review.service.js";

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

/**
 * PRO-BL1-04 / DEC-02 (WS-BILL, 2026-11-19) — past-due recurring add-ons that
 * are beyond the one 7-day grace after their paid period, or whose paid period
 * is unknown: the add-ons whose capacity ends once automatic add-on effects are
 * switched on (`storageAddonCapacityStatusWhere`).
 *
 * ONE enumeration: the sweep step below and the automatic-effects preview both
 * call it, so the preview lists exactly what the switch would change.
 */
export type PastDueAddonBeyondGrace = {
  addonId: string;
  ownerUserId: string;
  teamId: string | null;
  addonKey: prismaPkg.StorageAddonKey;
  provider: prismaPkg.PaymentProvider | null;
  externalSubscriptionId: string | null;
  extraStorageBytes: bigint;
  paidThroughUtc: Date | null;
  why: "GRACE_ENDED" | "PAID_PERIOD_UNKNOWN";
};

export async function pastDueAddonsBeyondGrace(now: Date = new Date()): Promise<PastDueAddonBeyondGrace[]> {
  const rows = await prisma.workspaceStorageAddon.findMany({
    where: {
      billingCycle: prismaPkg.StorageAddonBillingCycle.MONTHLY,
      status: prismaPkg.WorkspaceStorageAddonStatus.PAST_DUE,
      OR: [{ currentPeriodEnd: null }, { currentPeriodEnd: { lte: pastDueAddonGraceCutoff(now) } }],
    },
    orderBy: { updatedAt: "asc" },
    take: 1000,
    select: {
      id: true,
      ownerUserId: true,
      teamId: true,
      addonKey: true,
      paymentProvider: true,
      externalSubscriptionId: true,
      extraStorageBytes: true,
      currentPeriodEnd: true,
    },
  });
  return rows.map((r) => ({
    addonId: r.id,
    ownerUserId: r.ownerUserId,
    teamId: r.teamId,
    addonKey: r.addonKey,
    provider: r.paymentProvider,
    externalSubscriptionId: r.externalSubscriptionId,
    extraStorageBytes: r.extraStorageBytes,
    paidThroughUtc: r.currentPeriodEnd,
    why: r.currentPeriodEnd ? "GRACE_ENDED" : "PAID_PERIOD_UNKNOWN",
  }));
}

/**
 * The sweep step. With automatic add-on effects OFF (the default) the capacity
 * of these add-ons is NOT ended — the meter keeps counting them — and each gets
 * one held review item saying what is being held and why. With the switch ON
 * the meter applies the bound itself and there is nothing to hold.
 */
export async function holdPastDueAddonCapacityEnds(
  now: Date = new Date(),
): Promise<{ candidates: number; held: number }> {
  const candidates = await pastDueAddonsBeyondGrace(now);
  if (automaticAddonCancellationEnabled()) return { candidates: candidates.length, held: 0 };
  let held = 0;
  for (const c of candidates) {
    if (!c.provider) continue;
    await recordBillingReviewItem({
      userId: c.ownerUserId,
      provider: c.provider,
      providerResourceId: c.externalSubscriptionId ?? c.addonId,
      product: "STORAGE_ADDON",
      reason: "AUTOMATIC_ADDON_CAPACITY_END_HELD",
      providerAction: "NONE",
      detail: {
        addonId: c.addonId,
        addonKey: c.addonKey,
        why: c.why,
        paidThroughUtc: c.paidThroughUtc ? c.paidThroughUtc.toISOString() : null,
        capacityStillCounted: true,
        held: "AUTOMATIC_ADDON_CANCELLATION",
      },
    });
    held += 1;
  }
  return { candidates: candidates.length, held };
}
