/**
 * BILLING REMEDIATION (2026-10-30, AUD-01, AUD-09) — the Stripe Subscription
 * Schedule behind a scheduled downgrade.
 *
 * Stripe's contract, from its schedule documentation: an update must restate
 * every current and future phase; the end of one phase is the start of the next;
 * a phase's metadata is applied to the subscription when that phase starts; and
 * releasing a schedule leaves the subscription running as it is.
 *
 * Provider calls only, plus the one local column that makes a half-finished
 * sequence findable. Commercial decisions stay in `plan-transition.service`.
 */

import { prisma } from "../../db.js";
import { StripeHttpError, stripeGet, stripeRequest } from "../stripe.service.js";

type SchedulePhase = {
  start_date?: number;
  end_date?: number;
  items?: Array<{ price?: string | { id?: string } | null }>;
};

/**
 * PRO-BL1-01 (review G1) — does the LIVE schedule carry a change onto `priceId`
 * from `startsAtUnix`? A released, completed or cancelled schedule carries
 * nothing, whatever a stored idempotent answer said about it.
 */
export function stripeScheduleCarriesChange(
  schedule: StripeScheduleLike,
  priceId: string,
  startsAtUnix: number,
): boolean {
  if (isStripeScheduleFinished(schedule)) return false;
  return (schedule.phases ?? []).some(
    (phase) =>
      typeof phase.start_date === "number" &&
      phase.start_date >= startsAtUnix &&
      (phase.items ?? []).some((item) => {
        const price = typeof item.price === "string" ? item.price : item.price?.id;
        return price === priceId;
      }),
  );
}

export type StripeScheduleLike = {
  id?: string;
  status?: string;
  phases?: SchedulePhase[];
};

/** A schedule that already finished or was released needs nothing more. */
export function isStripeScheduleFinished(schedule: StripeScheduleLike): boolean {
  return schedule.status === "released" || schedule.status === "completed" || schedule.status === "canceled";
}

/**
 * Release one schedule: the subscription stays on its current price and no
 * scheduled change happens. Idempotent, including against a schedule Stripe has
 * already finished, which it refuses with a 400 this function reads back.
 */
export async function releaseStripeSchedule(scheduleId: string): Promise<void> {
  try {
    await stripeRequest(`/subscription_schedules/${encodeURIComponent(scheduleId)}/release`, new URLSearchParams(), {
      idempotencyKey: `proovra-schedule-release-${scheduleId}`,
    });
  } catch (err) {
    if (!(err instanceof StripeHttpError) || err.status >= 500) throw err;
    const current = (await stripeGet(`/subscription_schedules/${encodeURIComponent(scheduleId)}`)) as StripeScheduleLike;
    if (!isStripeScheduleFinished(current)) throw err;
  }
}

/**
 * A schedule recorded with no scheduled change behind it: the phase edit failed
 * and so did the release, or the process died between them. It holds the
 * subscription and blocks the next plan change, so it is released. Run by
 * reconciliation; a failure stays recorded and is retried on the next pass.
 */
export async function releaseOrphanedStripeSchedule(input: {
  subscriptionId: string;
  scheduleId: string;
}): Promise<boolean> {
  try {
    await releaseStripeSchedule(input.scheduleId);
  } catch {
    return false;
  }
  await prisma.subscription.updateMany({
    where: { id: input.subscriptionId, providerScheduleId: input.scheduleId, pendingPlan: null },
    data: { providerScheduleId: null },
  });
  return true;
}
