/**
 * Account closure — the PURE subscription decision.
 *
 * Deliberately free of Prisma and of every service import. The preflight
 * service loads the facts and this module judges them, which is the same
 * adapter/policy split the billing package already uses ("services/api/
 * workspace-billing is an input ADAPTER that loads persisted fields and
 * delegates to these functions"). Keeping it separate is what lets the whole
 * commercial matrix be tested without standing up a database client.
 */

import type { AccountClosureBlocker } from "./account-lifecycle-preflight.service.js";
/**
 * One candidate subscription row, already judged by the canonical authority.
 *
 * `paidActiveForSubject` is NOT computed here and must never be: it is
 * `resolveCommercialContext(...).lifecycle.paidActive` for the subject the row
 * belongs to. This type exists so the decision below can be tested over every
 * commercial state without a database, while the verdict it consumes still
 * comes from the one authority Billing itself uses.
 */
export type ClosureSubscriptionCandidate = {
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: Date | null;
  paidActiveForSubject: boolean;
};

/**
 * THE SUBSCRIPTION BLOCKER — A ROW IS NOT A SUBSCRIPTION.
 *
 * This asked the database directly for any row belonging to the user with a
 * status in (ACTIVE, TRIALING, PAST_DUE) and treated a hit as proof of a live
 * billing relationship. It is not. A row in that set can be:
 *
 *   - a WORKSPACE subscription. `Subscription.userId` is the purchaser and
 *     `teamId` is the subject; the canonical Billing projection reads a
 *     PERSONAL subscription as `{ userId, teamId: null }`. Without that scope
 *     a workspace's subscription was charged against its buyer's personal
 *     account closure.
 *   - a STALE row the provider has moved on from. The schema says so in as
 *     many words: status stays ACTIVE while `cancelAtPeriodEnd` is true and
 *     the terminal transition arrives by webhook — and a webhook can be late
 *     or lost. There is a production stale-row regression on record.
 *   - a PAST_DUE row whose bounded grace has long since elapsed, which the
 *     canonical policy scores as PAST_DUE_EXPIRED: not paid, not active.
 *
 * Meanwhile the canonical authority short-circuits a FREE scope before it ever
 * looks at a subscription row. So the two disagreed exactly as reported:
 * Billing said FREE while closure said "you have an active subscription" for
 * one account at one instant, and the person was sent to a Billing page that
 * offered nothing to cancel.
 *
 * The row query is now only a way to FIND candidates. Whether each one is live
 * is decided by `lifecycle.paidActive` from the same authority `/billing`
 * renders, so the two cannot diverge again.
 *
 * This does not narrow the protection. A genuinely live subscription still
 * blocks, including one already cancelled but inside its paid period —
 * `resolvePaidLifecycle` keeps that ACTIVE, which is what the second message
 * below is for.
 */
export function buildSubscriptionClosureBlocker(
  candidates: ReadonlyArray<ClosureSubscriptionCandidate>,
): AccountClosureBlocker | null {
  const live = candidates.filter((c) => c.paidActiveForSubject);
  if (live.length === 0) return null;

  // Access runs to the end of the paid period, so a cancelled subscription
  // still blocks closure — but the person has nothing left to do except
  // wait, and the message says which case they are in.
  const allCancelling = live.every((s) => s.cancelAtPeriodEnd);
  const endsAt = live
    .map((s) => s.currentPeriodEnd)
    .filter((d): d is Date => d instanceof Date)
    .sort((a, b) => b.getTime() - a.getTime())[0];

  return {
    code: "BILLING_SUBSCRIPTION_ACTIVE",
    message: allCancelling
      ? endsAt
        ? `Your subscription is already cancelled and ends on ${endsAt.toISOString().slice(0, 10)}. You can close your account after that.`
        : "Your subscription is already cancelled and ends at the end of the paid period. You can close your account after that."
      : "You have an active subscription. Cancel it before closing your account.",
    count: live.length,
  };
}
