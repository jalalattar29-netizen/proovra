/**
 * TEAM-SPEC §0 / R1 (2026-11-23) — what lowering a Personal account from TEAM
 * ends on the Personal Workspace Team was bought for: its reviewer operations
 * (queues, assignments, escalations).
 *
 * ONE read-only answer for every billing surface that tells the customer before
 * or after they lower the plan: the plan-change route, the cancel route and the
 * billing projection's DOWNGRADE offers. Nothing is closed, reassigned or
 * deleted; nothing is scheduled (billing-sweep holds are untouched); a lowering
 * is never blocked by it. Null when the move does not end reviewer operations
 * (not from TEAM, or to a plan that still includes them) or when the counts
 * cannot be read — an informational field must never fail a billing answer.
 */
import * as prismaPkg from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";

export type ReviewerOperationsEnding = { openWorkflows: number; activeEscalations: number };

const COMPLETED_REVIEW_STATUSES = ["APPROVED_INTERNAL", "REJECTED_INSUFFICIENT", "CLOSED"] as const;
const ACTIVE_ESCALATION_STATUSES = ["OPEN", "ACKNOWLEDGED", "REASSIGNED"] as const;

/** Whether moving `fromPlan` → `toPlan` ends reviewer operations. */
export function loweringEndsReviewerOperations(
  fromPlan: prismaPkg.PlanType | string,
  toPlan: prismaPkg.PlanType | string,
): boolean {
  return fromPlan === prismaPkg.PlanType.TEAM && (toPlan === prismaPkg.PlanType.PRO || toPlan === prismaPkg.PlanType.FREE);
}

export async function reviewerOperationsEndingOnLowering(
  input: { userId: string; fromPlan: prismaPkg.PlanType | string; toPlan: prismaPkg.PlanType | string },
  client: prismaPkg.PrismaClient = defaultPrisma as unknown as prismaPkg.PrismaClient,
): Promise<ReviewerOperationsEnding | null> {
  if (!loweringEndsReviewerOperations(input.fromPlan, input.toPlan)) return null;
  try {
    const personal = await client.team.findFirst({
      where: { ownerUserId: input.userId, isPersonal: true },
      select: { id: true },
    });
    if (!personal) return { openWorkflows: 0, activeEscalations: 0 };
    const [openWorkflows, activeEscalations] = await Promise.all([
      client.evidenceReviewWorkflow.count({
        where: { teamId: personal.id, status: { notIn: [...COMPLETED_REVIEW_STATUSES] as never } },
      }),
      client.reviewEscalation.count({
        where: { teamId: personal.id, status: { in: [...ACTIVE_ESCALATION_STATUSES] as never } },
      }),
    ]);
    return { openWorkflows, activeEscalations };
  } catch {
    return null;
  }
}

/**
 * TEAM-SPEC §0 / R1 (2026-11-23, cancel disclosure) — what CANCELLING a TEAM
 * subscription ends, and WHEN, told before the customer confirms.
 *
 * The date is the moment the entitlement actually leaves TEAM, read from the
 * same field and the same rules the lowering itself uses — never estimated:
 *
 *   * Stripe: `requestSubscriptionCancellation` sets `cancel_at_period_end`
 *     (subscription-cancellation.service.ts), Stripe ends the subscription at
 *     the period end, and its CANCELED webhook lowers the plan
 *     (`syncPlanForSubscription`). The date is `Subscription.currentPeriodEnd`
 *     while it is ahead; a stored period end already behind us is not a date
 *     Stripe will use (it confirms a new one), so none is claimed (null, not
 *     immediate) — the post-cancel answer carries the confirmed date.
 *   * PayPal: the cancel is immediate at PayPal, but the paid period is kept
 *     (PRO-BL1-03 / DEC-02): the plan stays while `currentPeriodEnd` is ahead
 *     and no payment of this subscription was refunded or disputed
 *     (`payPalPaidPeriodRunning`, subscription-lifecycle.handlers.ts), and is
 *     then lowered by `finalizeEndedPayPalPaidPeriods`, which carries out a
 *     customer cancellation even while BILLING_AUTO_PLAN_LOWERING is off.
 *     Otherwise the CANCELED webhook lowers it at once: "immediately".
 *
 * Read-only. Nothing is scheduled, closed or held; cancelling is never blocked.
 * Null when cancelling does not end reviewer operations (not TEAM) or the
 * counts cannot be read.
 */
export type CancellationReviewerOperationsEnding = ReviewerOperationsEnding & {
  /** When reviewer operations stop. Null when immediate, or not known before the provider answers. */
  effectiveAt: string | null;
  /** True when cancelling ends them at once. */
  effectiveImmediately: boolean;
};

export type CancellationEffectiveDate = { effectiveAt: string | null; effectiveImmediately: boolean };

type CancellableSubscription = {
  provider: prismaPkg.PaymentProvider | string;
  providerSubId: string;
  currentPeriodEnd: Date | null;
};

export async function cancellationEffectiveDate(
  subscription: CancellableSubscription,
  client: prismaPkg.PrismaClient = defaultPrisma as unknown as prismaPkg.PrismaClient,
  now: Date = new Date(),
): Promise<CancellationEffectiveDate> {
  const periodEnd = subscription.currentPeriodEnd;
  const ahead = periodEnd !== null && periodEnd.getTime() > now.getTime();
  if (subscription.provider === prismaPkg.PaymentProvider.PAYPAL) {
    if (!ahead) return { effectiveAt: null, effectiveImmediately: true };
    // The same adverse-payment rule as `payPalPaidPeriodRunning`.
    const adverse = await client.payment.findFirst({
      where: {
        provider: prismaPkg.PaymentProvider.PAYPAL,
        providerResourceId: subscription.providerSubId,
        OR: [{ refundedAmountCents: { gt: 0 } }, { disputeStatus: { in: ["OPEN", "LOST"] } }],
      },
      select: { id: true },
    });
    return adverse
      ? { effectiveAt: null, effectiveImmediately: true }
      : { effectiveAt: periodEnd!.toISOString(), effectiveImmediately: false };
  }
  return ahead
    ? { effectiveAt: periodEnd!.toISOString(), effectiveImmediately: false }
    : { effectiveAt: null, effectiveImmediately: false };
}

export async function reviewerOperationsEndingOnCancellation(
  input: {
    userId: string;
    plan: prismaPkg.PlanType | string;
    subscription: CancellableSubscription;
    now?: Date;
  },
  client: prismaPkg.PrismaClient = defaultPrisma as unknown as prismaPkg.PrismaClient,
): Promise<CancellationReviewerOperationsEnding | null> {
  const counts = await reviewerOperationsEndingOnLowering(
    { userId: input.userId, fromPlan: input.plan, toPlan: prismaPkg.PlanType.FREE },
    client,
  );
  if (!counts) return null;
  try {
    const when = await cancellationEffectiveDate(input.subscription, client, input.now);
    return { ...counts, ...when };
  } catch {
    return null;
  }
}
