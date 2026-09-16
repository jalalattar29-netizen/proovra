import * as prismaPkg from "@prisma/client";

import { prisma } from "../../db.js";

type SubscriptionStatusValue =
  (typeof prismaPkg.SubscriptionStatus)[keyof typeof prismaPkg.SubscriptionStatus];

export const LIVE_BASE_SUBSCRIPTION_STATUSES: readonly SubscriptionStatusValue[] = [
  prismaPkg.SubscriptionStatus.ACTIVE,
  prismaPkg.SubscriptionStatus.PAST_DUE,
];

export const SELF_SERVICE_BASE_SUBSCRIPTION_PLANS: readonly prismaPkg.PlanType[] = [
  prismaPkg.PlanType.PRO,
  prismaPkg.PlanType.TEAM,
];

export function isAuthoritativeLiveBaseSubscriptionStatus(input: {
  provider: prismaPkg.PaymentProvider;
  status: SubscriptionStatusValue;
}): boolean {
  if (
    input.status === prismaPkg.SubscriptionStatus.ACTIVE ||
    input.status === prismaPkg.SubscriptionStatus.PAST_DUE
  ) {
    return true;
  }

  return (
    input.provider === prismaPkg.PaymentProvider.STRIPE &&
    input.status === prismaPkg.SubscriptionStatus.TRIALING
  );
}

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
  lifecycle:
    | "NO_SUBSCRIPTION"
    | "ACTIVE_SUBSCRIPTION"
    | "PAST_DUE_SUBSCRIPTION"
    | "CHECKOUT_AWAITING_APPROVAL"
    | "STALE_OR_ABANDONED_PROVIDER_RECORD"
    | "GRANTED_ENTITLEMENT_WITHOUT_LIVE_SUBSCRIPTION";
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
 * Personal FREE/PRO/TEAM are one commercial ladder. An authoritative live
 * provider row may still carry a legacy `teamId` from the old workspace-shaped
 * TEAM model; that row is still the person's base subscription and must be
 * changed rather than bypassed by checkout.
 *
 * PayPal reports CREATED / APPROVAL_PENDING subscriptions before the buyer has
 * approved the agreement, and webhook handling stores those states locally as
 * TRIALING without changing entitlement. Those PayPal rows are provider
 * attempts, not active commercial authority: they must not suppress checkout
 * offers, route a user into plan-change, or become cancellation targets.
 *
 * Stripe TRIALING is different: it is a provider-managed subscription state,
 * not an unapproved checkout object. Live authority is therefore provider
 * aware, not just a raw status list. Storage add-ons live in
 * `WorkspaceStorageAddon` and are intentionally absent from this resolver.
 */
export async function findLivePersonalBaseSubscription(
  userId: string,
): Promise<LiveBaseSubscriptionRow | null> {
  return prisma.subscription.findFirst({
    where: {
      userId,
      plan: { in: [...SELF_SERVICE_BASE_SUBSCRIPTION_PLANS] },
      providerSubId: { not: "" },
      OR: [
        { status: { in: [...LIVE_BASE_SUBSCRIPTION_STATUSES] } },
        {
          provider: prismaPkg.PaymentProvider.STRIPE,
          status: prismaPkg.SubscriptionStatus.TRIALING,
        },
      ],
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
  const hasLiveBaseSubscription = Boolean(
    subscription &&
      isAuthoritativeLiveBaseSubscriptionStatus({
        provider: subscription.provider,
        status: subscription.status,
      }),
  );

  let lifecycle: PersonalBaseSubscriptionState["lifecycle"];
  if (!subscription) {
    lifecycle =
      input.effectivePlan === prismaPkg.PlanType.FREE
        ? "NO_SUBSCRIPTION"
        : "GRANTED_ENTITLEMENT_WITHOUT_LIVE_SUBSCRIPTION";
  } else if (subscription.status === prismaPkg.SubscriptionStatus.ACTIVE) {
    lifecycle = "ACTIVE_SUBSCRIPTION";
  } else if (subscription.status === prismaPkg.SubscriptionStatus.PAST_DUE) {
    lifecycle = "PAST_DUE_SUBSCRIPTION";
  } else if (subscription.status === prismaPkg.SubscriptionStatus.TRIALING) {
    lifecycle = "CHECKOUT_AWAITING_APPROVAL";
  } else {
    lifecycle = "STALE_OR_ABANDONED_PROVIDER_RECORD";
  }

  return {
    effectivePlan: input.effectivePlan,
    subscription,
    hasLiveBaseSubscription,
    lifecycle,
    providerSubscriptionPlan: subscription?.plan ?? null,
    providerSubscriptionStatus: subscription?.status ?? null,
    providerTransition: null,
  };
}
