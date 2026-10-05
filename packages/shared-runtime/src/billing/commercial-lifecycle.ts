/**
 * THE COMMERCIAL LIFECYCLE READER — one implementation for the API and the
 * worker (2026-09-29).
 *
 * Moved here from `services/api/src/services/billing/commercial-context.service.ts`
 * (`resolvePaidLifecycle`), unchanged in its rules, so the worker's issuance
 * gates read the same answer the API's paid-mutation gates do. Before this the
 * worker read only `Entitlement.plan`, so a subscription past due beyond its
 * grace — or cancelled after its paid period — still received newly issued
 * reports until a CANCELED webhook rewrote the plan.
 *
 * RULES (faithful to the prior API implementation):
 *   FREE plan                        INACTIVE
 *   exactly one ACTIVE/TRIALING row  ACTIVE (providerStatus = that row's)
 *   more than one live row           CANCELLED (ambiguous provider state; fail closed)
 *   a PAST_DUE row                   GRACE until currentPeriodEnd + 7 days,
 *                                    PAST_DUE_EXPIRED after (and when the period
 *                                    end is unknown)
 *   no subscription row at all       ACTIVE (the authoritative plan field
 *                                    governs; tolerates webhook lag and
 *                                    contract-billed organizations)
 *   CANCELED before period end       ACTIVE until the period end
 *   otherwise                        CANCELLED
 *
 * The SUBJECT is explicit: a personal subject's subscription rows are keyed by
 * user and plan, a workspace's by team id.
 */
import type { PrismaClient } from "@prisma/client";

import { internalGrantCoversPlan, readActiveInternalPlanGrant } from "./internal-plan-grant.js";

export const COMMERCIAL_GRACE_PERIOD_DAYS = 7;
const GRACE_MS = COMMERCIAL_GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000;

export type CommercialLifecycleSubject =
  | { kind: "PERSONAL"; ownerUserId: string; plan: string }
  | { kind: "WORKSPACE"; teamId: string; plan: string };

export type CommercialLifecycleReading = {
  state: "ACTIVE" | "GRACE" | "PAST_DUE_EXPIRED" | "CANCELLED" | "INACTIVE";
  paidActive: boolean;
  mutationsAllowed: boolean;
  graceEndsAtUtc: Date | null;
  providerStatus: "ACTIVE" | "TRIALING" | "PAST_DUE" | "CANCELED" | null;
};

type SubscriptionReader = Pick<PrismaClient, "subscription"> & Partial<Pick<PrismaClient, "planGrant">>;

/**
 * INTERNAL PLAN GRANT — a PERSONAL subject whose plan an active internal grant
 * covers is never LAPSED: the grant, not a payment, carries the access. The
 * provider truth is kept (paidActive and providerStatus still describe the real
 * subscription rows, so account closure and the admin views stay honest), but
 * mutations are allowed. With no provider rows at all the reading is ACTIVE
 * and NOT paid — nobody pays for a grant.
 */
export async function readCommercialLifecycle(
  client: SubscriptionReader,
  subject: CommercialLifecycleSubject,
  now: Date = new Date(),
): Promise<CommercialLifecycleReading> {
  const provider = await readProviderLifecycle(client, subject, now);
  if (subject.kind !== "PERSONAL" || subject.plan === "FREE" || !client.planGrant) return provider;
  const grant = await readActiveInternalPlanGrant(client as Pick<PrismaClient, "planGrant">, subject.ownerUserId, now);
  if (!grant || !internalGrantCoversPlan(grant.plan, subject.plan)) return provider;
  if (provider.providerStatus === null) {
    return { state: "ACTIVE", paidActive: false, mutationsAllowed: true, graceEndsAtUtc: null, providerStatus: null };
  }
  return provider.mutationsAllowed ? provider : { ...provider, state: "ACTIVE", mutationsAllowed: true };
}

async function readProviderLifecycle(
  client: SubscriptionReader,
  subject: CommercialLifecycleSubject,
  now: Date,
): Promise<CommercialLifecycleReading> {
  if (subject.plan === "FREE") {
    return {
      state: "INACTIVE",
      paidActive: false,
      mutationsAllowed: true,
      graceEndsAtUtc: null,
      providerStatus: null,
    };
  }

  /*
   * AN UNAPPROVED CHECKOUT ATTEMPT IS NOT A COMMERCIAL FACT (2026-09-29).
   *
   * PayPal stores a checkout that is created, awaiting approval or approved
   * but not yet active as TRIALING (there is no trial product). Counting such
   * a row as "live" beside the real ACTIVE subscription made the subject read
   * CANCELLED — a paying customer lost report issuance and paid mutations
   * because they had once opened a second checkout. The rule is the one the
   * billing service already applies (isAuthoritativeLiveBaseSubscriptionStatus):
   * a PayPal TRIALING row is an attempt and is ignored here entirely. Two
   * genuine live subscriptions still fail closed below.
   */
  const scope =
    subject.kind === "WORKSPACE"
      ? { teamId: subject.teamId }
      : { userId: subject.ownerUserId, plan: subject.plan as never };
  const where = { ...scope, NOT: { provider: "PAYPAL" as never, status: "TRIALING" as never } };

  const live = await client.subscription.findMany({
    where: { ...where, status: { in: ["ACTIVE", "TRIALING"] } },
    orderBy: { updatedAt: "desc" },
    select: { status: true },
    take: 2,
  });
  if (live.length > 1) {
    return {
      state: "CANCELLED",
      paidActive: false,
      mutationsAllowed: false,
      graceEndsAtUtc: null,
      providerStatus: live[0].status as CommercialLifecycleReading["providerStatus"],
    };
  }
  if (live.length === 1) {
    return {
      state: "ACTIVE",
      paidActive: true,
      mutationsAllowed: true,
      graceEndsAtUtc: null,
      providerStatus: live[0].status as CommercialLifecycleReading["providerStatus"],
    };
  }

  const pastDue = await client.subscription.findFirst({
    where: { ...where, status: "PAST_DUE" },
    orderBy: { updatedAt: "desc" },
    select: { currentPeriodEnd: true },
  });
  if (pastDue) {
    const periodEnd = pastDue.currentPeriodEnd?.getTime() ?? null;
    if (periodEnd === null) {
      return {
        state: "PAST_DUE_EXPIRED",
        paidActive: false,
        mutationsAllowed: false,
        graceEndsAtUtc: null,
        providerStatus: "PAST_DUE",
      };
    }
    const graceEnd = periodEnd + GRACE_MS;
    return now.getTime() <= graceEnd
      ? {
          state: "GRACE",
          paidActive: true,
          mutationsAllowed: true,
          graceEndsAtUtc: new Date(graceEnd),
          providerStatus: "PAST_DUE",
        }
      : {
          state: "PAST_DUE_EXPIRED",
          paidActive: false,
          mutationsAllowed: false,
          graceEndsAtUtc: null,
          providerStatus: "PAST_DUE",
        };
  }

  const any = await client.subscription.findFirst({
    where,
    orderBy: { updatedAt: "desc" },
    select: { status: true, currentPeriodEnd: true },
  });
  if (!any) {
    return {
      state: "ACTIVE",
      paidActive: true,
      mutationsAllowed: true,
      graceEndsAtUtc: null,
      providerStatus: null,
    };
  }
  if (
    any.status === "CANCELED" &&
    any.currentPeriodEnd &&
    any.currentPeriodEnd.getTime() > now.getTime()
  ) {
    return {
      state: "ACTIVE",
      paidActive: true,
      mutationsAllowed: true,
      graceEndsAtUtc: any.currentPeriodEnd,
      providerStatus: "CANCELED",
    };
  }
  return {
    state: "CANCELLED",
    paidActive: false,
    mutationsAllowed: false,
    graceEndsAtUtc: null,
    providerStatus: any.status as CommercialLifecycleReading["providerStatus"],
  };
}
