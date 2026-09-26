import * as prismaPkg from "@prisma/client";

import { prisma } from "../../db.js";
import { SELF_SERVICE_BASE_SUBSCRIPTION_PLANS } from "./base-subscription.service.js";
import {
  defaultReconciliationProviders,
  type ReconciliationProviders,
} from "./reconciliation/reconciliation.service.js";
import type { ObservationFailure, ObservedState } from "./reconciliation/types.js";
import { terminalizePendingPlanCheckout } from "./subscription-cancellation.service.js";
import { syncPlanForSubscription } from "./subscription-lifecycle.handlers.js";

type SubscriptionClient = Pick<
  prismaPkg.Prisma.TransactionClient["subscription"],
  "findFirst"
>;

type LockClient = Pick<prismaPkg.Prisma.TransactionClient, "$executeRaw">;

export type PendingProviderCheckoutAttempt =
  | {
      state: "PENDING_SAME_TARGET";
      provider: prismaPkg.PaymentProvider;
      targetPlan: prismaPkg.PlanType;
      subscriptionId: string;
    }
  | {
      state: "PENDING_DIFFERENT_TARGET";
      provider: prismaPkg.PaymentProvider;
      targetPlan: prismaPkg.PlanType;
      pendingPlan: prismaPkg.PlanType;
      subscriptionId: string;
    }
  | {
      state: "TERMINAL_OR_STALE_ATTEMPT";
      provider: prismaPkg.PaymentProvider;
      targetPlan: prismaPkg.PlanType;
      subscriptionId: string;
    }
  | {
      state: "NO_PENDING_ATTEMPT";
      provider: prismaPkg.PaymentProvider;
      targetPlan: prismaPkg.PlanType;
    };

export async function resolvePendingProviderCheckoutAttempt(input: {
  userId: string;
  provider: prismaPkg.PaymentProvider;
  targetPlan: prismaPkg.PlanType;
  client?: SubscriptionClient;
}): Promise<PendingProviderCheckoutAttempt> {
  const client = input.client ?? prisma.subscription;
  const row = await client.findFirst({
    where: {
      userId: input.userId,
      provider: input.provider,
      providerSubId: { not: "" },
      plan: { in: [...SELF_SERVICE_BASE_SUBSCRIPTION_PLANS] },
      status: prismaPkg.SubscriptionStatus.TRIALING,
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, plan: true },
  });

  if (!row) {
    return {
      state: "NO_PENDING_ATTEMPT",
      provider: input.provider,
      targetPlan: input.targetPlan,
    };
  }

  if (row.plan === input.targetPlan) {
    return {
      state: "PENDING_SAME_TARGET",
      provider: input.provider,
      targetPlan: input.targetPlan,
      subscriptionId: row.id,
    };
  }

  return {
    state: "PENDING_DIFFERENT_TARGET",
    provider: input.provider,
    targetPlan: input.targetPlan,
    pendingPlan: row.plan,
    subscriptionId: row.id,
  };
}

export async function withPendingProviderCheckoutGate<T>(input: {
  userId: string;
  provider: prismaPkg.PaymentProvider;
  targetPlan: prismaPkg.PlanType;
  create: () => Promise<T>;
}): Promise<
  | { kind: "CREATED"; result: T }
  | { kind: "BLOCKED"; attempt: PendingProviderCheckoutAttempt }
> {
  return prisma.$transaction(async (tx) => {
    await (tx as LockClient).$executeRaw`
      SELECT pg_advisory_xact_lock(hashtext(${`billing-checkout:${input.provider}:${input.userId}`}))
    `;

    const attempt = await resolvePendingProviderCheckoutAttempt({
      userId: input.userId,
      provider: input.provider,
      targetPlan: input.targetPlan,
      client: tx.subscription,
    });

    if (attempt.state !== "NO_PENDING_ATTEMPT") {
      return { kind: "BLOCKED", attempt };
    }

    return { kind: "CREATED", result: await input.create() };
  });
}

export function pendingCheckoutHttpResponse(
  attempt: PendingProviderCheckoutAttempt,
): {
  message: string;
  code: string;
  details: Record<string, unknown>;
} {
  if (attempt.state === "PENDING_SAME_TARGET") {
    return {
      message:
        "PayPal approval is already pending for this plan. Finish or abandon that approval before starting another checkout.",
      code: "PAYPAL_APPROVAL_PENDING",
      details: {
        provider: attempt.provider,
        plan: attempt.targetPlan,
        retry: "RESOLVE_PENDING_CHECKOUT",
        resolveEndpoint: "/v1/billing/checkout/paypal/pending/resolve",
      },
    };
  }

  if (attempt.state === "PENDING_DIFFERENT_TARGET") {
    return {
      message:
        "A different PayPal approval is already pending. Resolve that pending checkout before starting another plan.",
      code: "PAYPAL_DIFFERENT_PLAN_PENDING",
      details: {
        provider: attempt.provider,
        pendingPlan: attempt.pendingPlan,
        requestedPlan: attempt.targetPlan,
        retry: "RESOLVE_PENDING_CHECKOUT",
        resolveEndpoint: "/v1/billing/checkout/paypal/pending/resolve",
      },
    };
  }

  return {
    message: "This checkout attempt is no longer active. Start a new checkout.",
    code: "PAYPAL_PENDING_ATTEMPT_STALE",
    details: {
      provider: attempt.provider,
      requestedPlan: attempt.targetPlan,
    },
  };
}

export type PendingCheckoutResolutionResult = {
  outcome:
    | "NO_PENDING_ATTEMPT"
    | "STILL_PENDING"
    | "UPDATED"
    | "ABANDON_CONFIRMATION_REQUIRED"
    | "ABANDONED";
  provider: prismaPkg.PaymentProvider;
  plan: prismaPkg.PlanType;
  status: prismaPkg.SubscriptionStatus | null;
  warning?: string;
  confirmation?: { canConfirmAbandon: true };
  providerFailure?: ObservationFailure | "PROVIDER_NOT_CONFIGURED";
};

function statusFromSubscriptionObservation(
  state: ObservedState,
): prismaPkg.SubscriptionStatus | null {
  switch (state) {
    case "SUCCEEDED":
      return prismaPkg.SubscriptionStatus.ACTIVE;
    case "PENDING":
      return prismaPkg.SubscriptionStatus.TRIALING;
    case "FAILED":
    case "CANCELED":
    case "EXPIRED":
      return prismaPkg.SubscriptionStatus.CANCELED;
    case "REFUNDED":
    case "UNKNOWN":
      return null;
  }
}

async function markPendingCheckoutAbandoned(input: {
  id: string;
  provider: prismaPkg.PaymentProvider;
  providerSubId: string;
  plan: prismaPkg.PlanType;
}): Promise<PendingCheckoutResolutionResult> {
  await terminalizePendingPlanCheckout({ subscriptionId: input.id });

  return {
    outcome: "ABANDONED",
    provider: input.provider,
    plan: input.plan,
    status: prismaPkg.SubscriptionStatus.CANCELED,
  };
}

/**
 * Resolve the PayPal approval-pending row that blocks a new checkout.
 *
 * Provider truth always wins. If PayPal still reports the subscription as
 * pending, the gate stays closed. If PayPal reports ACTIVE, the normal
 * subscription writer applies the entitlement. If PayPal cannot answer, a
 * caller must ask the customer for explicit confirmation before recording a
 * local abandonment; that abandonment only removes PROOVRA's local checkout
 * blocker and does not claim PayPal cancelled anything.
 */
export async function resolvePendingPayPalCheckout(input: {
  userId: string;
  targetPlan: prismaPkg.PlanType;
  confirmed?: boolean;
  providers?: ReconciliationProviders;
}): Promise<PendingCheckoutResolutionResult> {
  const row = await prisma.subscription.findFirst({
    where: {
      userId: input.userId,
      provider: prismaPkg.PaymentProvider.PAYPAL,
      providerSubId: { not: "" },
      plan: { in: [...SELF_SERVICE_BASE_SUBSCRIPTION_PLANS] },
      status: prismaPkg.SubscriptionStatus.TRIALING,
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      provider: true,
      providerSubId: true,
      plan: true,
      teamId: true,
    },
  });

  if (!row) {
    return {
      outcome: "NO_PENDING_ATTEMPT",
      provider: prismaPkg.PaymentProvider.PAYPAL,
      plan: input.targetPlan,
      status: null,
    };
  }

  const adapter =
    (input.providers ?? defaultReconciliationProviders())[prismaPkg.PaymentProvider.PAYPAL];
  const observation = adapter
    ? await adapter.observeSubscription(row.providerSubId)
    : null;

  if (!observation || observation.state === "UNKNOWN") {
    const failure =
      observation?.failure ?? (adapter ? "PROVIDER_UNAVAILABLE" : "PROVIDER_NOT_CONFIGURED");
    if (!input.confirmed) {
      return {
        outcome: "ABANDON_CONFIRMATION_REQUIRED",
        provider: row.provider,
        plan: row.plan,
        status: prismaPkg.SubscriptionStatus.TRIALING,
        providerFailure: failure,
        warning:
          failure === "NOT_FOUND"
            ? "PayPal has no record of this approval attempt. Abandoning only removes PROOVRA's local checkout blocker; it does not cancel, reverse, or refund anything at PayPal."
            : "PayPal could not confirm this approval attempt. Abandoning only removes PROOVRA's local checkout blocker; it does not cancel, reverse, or refund anything at PayPal.",
        confirmation: { canConfirmAbandon: true },
      };
    }
    return markPendingCheckoutAbandoned(row);
  }

  const status = statusFromSubscriptionObservation(observation.state);
  if (status === prismaPkg.SubscriptionStatus.TRIALING) {
    return {
      outcome: "STILL_PENDING",
      provider: row.provider,
      plan: row.plan,
      status,
    };
  }

  if (status === prismaPkg.SubscriptionStatus.ACTIVE) {
    await syncPlanForSubscription({
      userId: input.userId,
      plan: row.plan,
      teamId: row.teamId,
      provider: row.provider,
      providerSubId: row.providerSubId,
      status,
      currentPeriodEnd: observation.currentPeriodEndUtc,
      observedAtUtc: observation.observedAtUtc,
    });
    return {
      outcome: "UPDATED",
      provider: row.provider,
      plan: row.plan,
      status,
    };
  }

  if (status === prismaPkg.SubscriptionStatus.CANCELED) {
    await terminalizePendingPlanCheckout({
      subscriptionId: row.id,
      observedAtUtc: observation.observedAtUtc,
    });
    return {
      outcome: "UPDATED",
      provider: row.provider,
      plan: row.plan,
      status,
    };
  }

  return {
    outcome: "STILL_PENDING",
    provider: row.provider,
    plan: row.plan,
    status: prismaPkg.SubscriptionStatus.TRIALING,
  };
}
