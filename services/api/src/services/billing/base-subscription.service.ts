import * as prismaPkg from "@prisma/client";

import { prisma } from "../../db.js";

type SubscriptionStatusValue =
  (typeof prismaPkg.SubscriptionStatus)[keyof typeof prismaPkg.SubscriptionStatus];

export const LIVE_BASE_SUBSCRIPTION_STATUSES: readonly SubscriptionStatusValue[] = [
  prismaPkg.SubscriptionStatus.ACTIVE,
  prismaPkg.SubscriptionStatus.PAST_DUE,
  prismaPkg.SubscriptionStatus.TRIALING,
];

export const SELF_SERVICE_BASE_SUBSCRIPTION_PLANS: readonly prismaPkg.PlanType[] = [
  prismaPkg.PlanType.PRO,
  prismaPkg.PlanType.TEAM,
];

export type LiveBaseSubscriptionRow = {
  id: string;
  provider: prismaPkg.PaymentProvider;
  providerSubId: string;
  status: SubscriptionStatusValue;
  plan: prismaPkg.PlanType;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  pendingPlan: prismaPkg.PlanType | null;
  pendingPlanEffectiveAtUtc: Date | null;
  teamId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type PersonalBaseSubscriptionState = {
  effectivePlan: prismaPkg.PlanType;
  subscription: LiveBaseSubscriptionRow | null;
  hasLiveBaseSubscription: boolean;
  providerSubscriptionPlan: prismaPkg.PlanType | null;
  providerSubscriptionStatus: prismaPkg.SubscriptionStatus | null;
  providerTransition:
    | {
        state: "IN_PROGRESS";
        targetPlan: prismaPkg.PlanType;
        provider: prismaPkg.PaymentProvider;
        status: typeof prismaPkg.SubscriptionStatus.TRIALING;
        effectiveAtUtc: Date | null;
      }
    | null;
};

const LIVE_BASE_SELECT = {
  id: true,
  provider: true,
  providerSubId: true,
  status: true,
  plan: true,
  currentPeriodEnd: true,
  cancelAtPeriodEnd: true,
  pendingPlan: true,
  pendingPlanEffectiveAtUtc: true,
  teamId: true,
  createdAt: true,
  updatedAt: true,
} satisfies prismaPkg.Prisma.SubscriptionSelect;

/**
 * The canonical personal base-subscription discovery.
 *
 * Personal FREE/PRO/TEAM are one commercial ladder. A live provider row may
 * still carry a legacy `teamId` from the old workspace-shaped TEAM model; that
 * row is still the person's base subscription and must be changed rather than
 * bypassed by checkout. Storage add-ons live in `WorkspaceStorageAddon` and
 * are intentionally absent from this resolver.
 */
export async function findLivePersonalBaseSubscription(
  userId: string,
): Promise<LiveBaseSubscriptionRow | null> {
  return prisma.subscription.findFirst({
    where: {
      userId,
      status: { in: [...LIVE_BASE_SUBSCRIPTION_STATUSES] },
      plan: { in: [...SELF_SERVICE_BASE_SUBSCRIPTION_PLANS] },
      providerSubId: { not: "" },
    },
    orderBy: { createdAt: "desc" },
    select: LIVE_BASE_SELECT,
  }) as Promise<LiveBaseSubscriptionRow | null>;
}

export function derivePersonalBaseSubscriptionState(input: {
  effectivePlan: prismaPkg.PlanType;
  subscription: LiveBaseSubscriptionRow | null;
}): PersonalBaseSubscriptionState {
  const subscription = input.subscription;
  const providerTransition =
    subscription &&
    subscription.status === prismaPkg.SubscriptionStatus.TRIALING &&
    subscription.plan !== input.effectivePlan
      ? {
          state: "IN_PROGRESS" as const,
          targetPlan: subscription.plan,
          provider: subscription.provider,
          status: prismaPkg.SubscriptionStatus.TRIALING,
          effectiveAtUtc: subscription.currentPeriodEnd,
        }
      : null;

  return {
    effectivePlan: input.effectivePlan,
    subscription,
    hasLiveBaseSubscription: Boolean(subscription),
    providerSubscriptionPlan: subscription?.plan ?? null,
    providerSubscriptionStatus: subscription?.status ?? null,
    providerTransition,
  };
}
