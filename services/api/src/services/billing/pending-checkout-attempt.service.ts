import * as prismaPkg from "@prisma/client";

import { prisma } from "../../db.js";
import { SELF_SERVICE_BASE_SUBSCRIPTION_PLANS } from "./base-subscription.service.js";

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
