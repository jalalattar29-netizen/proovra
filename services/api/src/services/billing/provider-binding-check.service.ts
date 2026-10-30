/**
 * BILLING REMEDIATION (2026-10-30, AUD-14) — a stored provider reference the
 * provider says it does not know.
 *
 * A 404 for a stored subscription was a counter and nothing else: nothing was
 * recorded, the reference was asked about again on every pass, and because a
 * failed read writes nothing, the row kept its place at the head of the sweep's
 * least-recently-touched queue and held a slot from accounts that needed one.
 *
 * Each reference now has one durable row that spaces out the re-reads and, once
 * the answer has repeated, gives an operator a review item.
 *
 * WHAT THIS NEVER DOES
 * ---------------------------------------------------------------------------
 * Revoke, cancel or delete anything. A 404 proves only that this credential
 * cannot see the object: it can be a Sandbox-era reference, a rotated account,
 * or a real subscription PayPal stopped returning. The subscription and its
 * entitlement stay exactly as they are until a person decides.
 */

import * as prismaPkg from "@prisma/client";

import { prisma } from "../../db.js";
import { recordBillingReviewItem } from "./billing-review.service.js";

/** Hours until the next read, indexed by consecutive misses; then weekly. */
export const BINDING_CHECK_BACKOFF_HOURS = [1, 6, 24, 72] as const;
const LAST_BACKOFF_HOURS = 7 * 24;
/** Misses before it becomes an operator's question rather than a blip. */
export const BINDING_CHECK_REVIEW_AFTER_MISSES = 3;

export type BindingResourceKind = "SUBSCRIPTION" | "STORAGE_ADDON";

function nextCheckAt(misses: number, from: Date): Date {
  const hours = BINDING_CHECK_BACKOFF_HOURS[misses - 1] ?? LAST_BACKOFF_HOURS;
  return new Date(from.getTime() + hours * 60 * 60 * 1000);
}

export async function noteProviderReferenceMissing(input: {
  userId: string;
  provider: prismaPkg.PaymentProvider;
  resourceKind: BindingResourceKind;
  providerResourceId: string;
  now?: Date;
}): Promise<void> {
  const now = input.now ?? new Date();
  const key = { provider: input.provider, providerResourceId: input.providerResourceId };
  const existing = await prisma.billingProviderBindingCheck.findUnique({
    where: { provider_providerResourceId: key },
    select: { consecutiveMisses: true, state: true, firstMissingAtUtc: true },
  });
  const misses = existing && existing.state === "UNRESOLVED" ? existing.consecutiveMisses + 1 : 1;
  await prisma.billingProviderBindingCheck.upsert({
    where: { provider_providerResourceId: key },
    update: {
      state: "UNRESOLVED",
      consecutiveMisses: misses,
      lastMissingAtUtc: now,
      nextCheckAtUtc: nextCheckAt(misses, now),
      resolvedAtUtc: null,
      ...(existing?.state === "UNRESOLVED" ? {} : { firstMissingAtUtc: now }),
    },
    create: {
      ...key,
      userId: input.userId,
      resourceKind: input.resourceKind,
      firstMissingAtUtc: now,
      lastMissingAtUtc: now,
      nextCheckAtUtc: nextCheckAt(1, now),
    },
  });
  if (misses === BINDING_CHECK_REVIEW_AFTER_MISSES) {
    await recordBillingReviewItem({
      userId: input.userId,
      provider: input.provider,
      providerResourceId: input.providerResourceId,
      product: input.resourceKind === "STORAGE_ADDON" ? "STORAGE_ADDON" : "PLAN",
      reason: "PROVIDER_REFERENCE_UNRESOLVED",
      detail: { consecutiveMisses: misses, firstMissingAtUtc: (existing?.firstMissingAtUtc ?? now).toISOString() },
    });
  }
}

/** Any successful read of the reference ends it. */
export async function noteProviderReferenceFound(input: {
  provider: prismaPkg.PaymentProvider;
  providerResourceId: string;
  now?: Date;
}): Promise<void> {
  await prisma.billingProviderBindingCheck.updateMany({
    where: { provider: input.provider, providerResourceId: input.providerResourceId, state: "UNRESOLVED" },
    data: { state: "RESOLVED", resolvedAtUtc: input.now ?? new Date() },
  });
}

/** One account's references whose next read is not due yet. */
export async function referencesNotDue(userId: string, now: Date = new Date()): Promise<Set<string>> {
  const rows = await prisma.billingProviderBindingCheck.findMany({
    where: { userId, state: "UNRESOLVED", nextCheckAtUtc: { gt: now } },
    select: { provider: true, providerResourceId: true },
  });
  return new Set(rows.map((r) => `${String(r.provider)}:${r.providerResourceId}`));
}

/** Every reference the sweep should not offer this tick. Bounded. */
export async function sweepExcludedReferences(now: Date = new Date()): Promise<string[]> {
  const rows = await prisma.billingProviderBindingCheck.findMany({
    where: { state: "UNRESOLVED", nextCheckAtUtc: { gt: now } },
    orderBy: { nextCheckAtUtc: "desc" },
    take: 1000,
    select: { providerResourceId: true },
  });
  return rows.map((r) => r.providerResourceId);
}
