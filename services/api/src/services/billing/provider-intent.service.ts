/**
 * PRO-BL1-01 (2026-11-18) — durable business-intent identity for provider
 * mutations on ONE base subscription (cancel, restart, plan change).
 *
 * The defect this closes
 * ---------------------------------------------------------------------------
 * Every such call used an idempotency key bucketed by UTC hour. Stripe and
 * PayPal return the STORED first answer for a repeated key with the same body,
 * without executing. Cancel -> restart -> cancel inside one hour therefore sent
 * the first cancel's key again, Stripe replayed "cancel_at_period_end: true"
 * while the subscription kept renewing, and PROOVRA recorded a cancellation
 * that never happened (and cancelled dependent add-ons for real). The same
 * held for downgrade -> withdraw -> downgrade.
 *
 * The contract
 * ---------------------------------------------------------------------------
 *   * An intent is minted (kind + target + a random nonce) and PERSISTED on the
 *     subscription row BEFORE the provider is called.
 *   * A retry of the SAME intent (same kind and target) whose answer was lost
 *     reuses that key, so the provider returns its original answer instead of
 *     acting twice. That is what an idempotency key is for.
 *   * The intent is SETTLED (cleared) once the provider's answer is known:
 *     confirmed and recorded, or definitively refused. The next intent — after
 *     a reversal, a refusal or a confirmation — gets a new key, so it can never
 *     be answered with a stale replay.
 *   * A different intent replaces an outstanding one (compare-and-set on the
 *     stored key, so two concurrent writers cannot both believe they own it).
 *   * An intent older than the providers' idempotency retention is not reused:
 *     the provider would no longer replay it, so the old key buys nothing.
 */

import { randomUUID } from "node:crypto";

import { prisma } from "../../db.js";

/** Stripe keeps idempotent results for at least 24 hours; PayPal similar. */
export const PROVIDER_INTENT_REUSE_WINDOW_MS = 24 * 60 * 60 * 1000;

export type ProviderIntentKind = "cancel" | "resume" | "plan";

type IntentClient = {
  subscription: {
    findUnique: typeof prisma.subscription.findUnique;
    updateMany: typeof prisma.subscription.updateMany;
  };
};

/** The stable part of a key: what is being asked, of which subscription. */
export function providerIntentPrefix(
  kind: ProviderIntentKind,
  subscriptionId: string,
  target?: string | null,
): string {
  return `proovra-${kind}-${subscriptionId}${target ? `-${target}` : ""}-`;
}

/**
 * Open (or re-open, for a lost-answer retry) the intent and return its key.
 * The key is durable before this returns.
 */
export async function beginProviderIntent(
  input: {
    subscriptionId: string;
    kind: ProviderIntentKind;
    /** What the intent asks for, e.g. "PRO-TEAM". Part of the identity. */
    target?: string | null;
    now?: Date;
  },
  db: IntentClient = prisma,
): Promise<string> {
  const now = input.now ?? new Date();
  const prefix = providerIntentPrefix(input.kind, input.subscriptionId, input.target);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const row = await db.subscription.findUnique({
      where: { id: input.subscriptionId },
      select: { providerIntentKey: true, providerIntentAtUtc: true },
    });
    if (!row) throw new Error("subscription disappeared while opening a provider intent");
    const open = row.providerIntentKey ?? null;
    const fresh =
      row.providerIntentAtUtc instanceof Date &&
      now.getTime() - row.providerIntentAtUtc.getTime() < PROVIDER_INTENT_REUSE_WINDOW_MS;
    if (open && open.startsWith(prefix) && fresh) {
      // The same intent, still unanswered: a genuine retry.
      return open;
    }
    // 96 random bits keeps a derived key inside PayPal-Request-Id's length.
    const key = `${prefix}${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    const swapped = await db.subscription.updateMany({
      where: { id: input.subscriptionId, providerIntentKey: open },
      data: { providerIntentKey: key, providerIntentAtUtc: now },
    });
    if (swapped.count === 1) return key;
    // Another writer changed the intent between the read and the swap: read
    // again and either join it (same intent) or replace it.
  }
  throw new Error("could not open a provider intent: concurrent writers");
}

/**
 * Close the intent once its outcome is known (confirmed, or definitively
 * refused). Only the intent named is closed: a newer one is left alone.
 */
export async function settleProviderIntent(
  input: { subscriptionId: string; key: string },
  db: IntentClient = prisma,
): Promise<void> {
  await db.subscription.updateMany({
    where: { id: input.subscriptionId, providerIntentKey: input.key },
    data: { providerIntentKey: null, providerIntentAtUtc: null },
  });
}
