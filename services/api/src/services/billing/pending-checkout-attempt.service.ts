import * as prismaPkg from "@prisma/client";

import { prisma } from "../../db.js";
import { SELF_SERVICE_BASE_SUBSCRIPTION_PLANS } from "./base-subscription.service.js";
import {
  defaultReconciliationProviders,
  type ReconciliationProviders,
} from "./reconciliation/reconciliation.service.js";
import type { ObservationFailure } from "./reconciliation/types.js";
import type { BillingAccountRef } from "./billing-accounts.service.js";
import { abandonCheckoutAttempt } from "./checkout-attempt-recovery.service.js";

type SubscriptionClient = Pick<
  prismaPkg.Prisma.TransactionClient["subscription"],
  "findFirst"
>;

type LockClient = Pick<prismaPkg.Prisma.TransactionClient, "$executeRaw">;

export type PendingStorageAddonCheckoutAttempt = {
  id: string;
  addonKey: prismaPkg.StorageAddonKey;
  createdAt: Date;
  providerBound: boolean;
};

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

/**
 * Serialize recurring PayPal storage checkout creation for one commercial
 * subject and persist the attempt before leaving for the provider.
 *
 * The local row id is also the PayPal-Request-Id. If the HTTP response is lost
 * after PayPal creates the subscription, the attempt remains durable and the
 * same provider request can be replayed without creating a second resource.
 */
export async function withPendingStorageAddonCheckoutGate<T>(input: {
  ownerUserId: string;
  teamId: string | null;
  addonKey: prismaPkg.StorageAddonKey;
  extraStorageBytes: bigint;
  currency: string;
  amountCents: number;
  create: (attemptId: string) => Promise<{
    result: T;
    providerSubId: string;
    providerHttpStatus: number | null;
    providerDebugId: string | null;
    providerEnvironment: string;
    providerClientIdFingerprint: string;
    providerPlanId: string;
    providerCurrency: string;
    approvalLinkIdentity: prismaPkg.Prisma.InputJsonObject | null;
  }>;
}): Promise<
  | { kind: "CREATED"; result: T; attemptId: string }
  | { kind: "BLOCKED"; attempt: PendingStorageAddonCheckoutAttempt }
> {
  const gate = await prisma.$transaction(async (tx) => {
    await (tx as LockClient).$executeRaw`
      SELECT pg_advisory_xact_lock(hashtext(${`billing-storage-checkout:PAYPAL:${input.ownerUserId}:${input.teamId ?? "personal"}`}))
    `;

    const existing = await tx.workspaceStorageAddon.findFirst({
      where: {
        ownerUserId: input.ownerUserId,
        teamId: input.teamId,
        paymentProvider: prismaPkg.PaymentProvider.PAYPAL,
        billingCycle: prismaPkg.StorageAddonBillingCycle.MONTHLY,
        status: prismaPkg.WorkspaceStorageAddonStatus.PENDING,
      },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        addonKey: true,
        createdAt: true,
        externalSubscriptionId: true,
      },
    });
    if (existing) {
      return {
        kind: "BLOCKED" as const,
        attempt: {
          id: existing.id,
          addonKey: existing.addonKey,
          createdAt: existing.createdAt,
          providerBound: Boolean(existing.externalSubscriptionId),
        },
      };
    }

    const attempt = await tx.workspaceStorageAddon.create({
      data: {
        ownerUserId: input.ownerUserId,
        teamId: input.teamId,
        addonKey: input.addonKey,
        extraStorageBytes: input.extraStorageBytes,
        billingCycle: prismaPkg.StorageAddonBillingCycle.MONTHLY,
        status: prismaPkg.WorkspaceStorageAddonStatus.PENDING,
        paymentProvider: prismaPkg.PaymentProvider.PAYPAL,
        currency: input.currency,
        amountCents: input.amountCents,
        metadata: {
          source: "paypal.storage_addon_checkout",
          checkoutState: "PROVIDER_CREATE_IN_PROGRESS",
        },
      },
      select: { id: true },
    });

    return { kind: "ATTEMPT" as const, attemptId: attempt.id };
  });

  if (gate.kind === "BLOCKED") return gate;

  // The transaction has committed before the network call. A process crash or
  // lost response therefore leaves one durable attempt with one stable
  // PayPal-Request-Id instead of losing the guard and creating a duplicate.
  try {
    const created = await input.create(gate.attemptId);
    if (!created.providerSubId.trim()) {
      throw new Error("PayPal storage checkout returned no subscription id");
    }
    await prisma.workspaceStorageAddon.update({
      where: { id: gate.attemptId },
      data: {
        externalSubscriptionId: created.providerSubId,
        metadata: {
          source: "paypal.storage_addon_checkout",
          checkoutState: "AWAITING_CUSTOMER_APPROVAL",
          providerHttpStatus: created.providerHttpStatus,
          providerDebugId: created.providerDebugId,
          providerEnvironment: created.providerEnvironment,
          providerClientIdFingerprint: created.providerClientIdFingerprint,
          providerPlanId: created.providerPlanId,
          providerCurrency: created.providerCurrency,
          approvalLinkIdentity: created.approvalLinkIdentity,
        },
      },
    });
    return {
      kind: "CREATED" as const,
      result: created.result,
      attemptId: gate.attemptId,
    };
  } catch (error) {
    const rejected =
      typeof error === "object" &&
      error !== null &&
      "publicCode" in error &&
      ["PAYMENT_PROVIDER_REJECTED", "PAYMENTS_UNAVAILABLE"].includes(
        String((error as { publicCode?: unknown }).publicCode ?? ""),
      );
    await prisma.workspaceStorageAddon.update({
      where: { id: gate.attemptId },
      data: {
        status: rejected
          ? prismaPkg.WorkspaceStorageAddonStatus.FAILED
          : prismaPkg.WorkspaceStorageAddonStatus.PENDING,
        metadata: {
          source: "paypal.storage_addon_checkout",
          checkoutState: rejected
            ? "PROVIDER_REJECTED"
            : "PROVIDER_OUTCOME_UNKNOWN",
        },
      },
    });
    throw error;
  }
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

/**
 * Resolve the PayPal plan approval that blocks a new checkout (the checkout
 * drawer's "resolve pending approval" action).
 *
 * BILLING CHECKOUT ATTEMPTS (2026-09-28) — delegated to the ONE provider-first
 * attempt authority, so this drawer action and Billing activity's "Abandon"
 * give the same answer. It now finds unbound attempts too (a lost create
 * response), and an approval PayPal still shows as open may be abandoned with
 * confirmation — it cannot charge without the buyer approving it — instead of
 * leaving the customer with no way out. Provider truth always wins, and
 * abandonment never claims PayPal cancelled anything.
 */
export async function resolvePendingPayPalCheckout(input: {
  userId: string;
  targetPlan: prismaPkg.PlanType;
  confirmed?: boolean;
  providers?: ReconciliationProviders;
  account?: BillingAccountRef;
}): Promise<PendingCheckoutResolutionResult> {
  const account: BillingAccountRef = input.account ?? {
    type: "PERSONAL",
    id: input.userId,
    displayName: "",
    capabilities: ["BILLING_MANAGE"],
    billingOwnerMissing: false,
  };

  const attempt = await prisma.billingCheckoutAttempt.findFirst({
    where: {
      userId: input.userId,
      product: prismaPkg.BillingCheckoutProduct.PLAN,
      provider: prismaPkg.PaymentProvider.PAYPAL,
      status: prismaPkg.BillingCheckoutAttemptStatus.PENDING,
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, planKey: true },
  });
  const legacy = attempt
    ? null
    : await prisma.subscription.findFirst({
        where: {
          userId: input.userId,
          provider: prismaPkg.PaymentProvider.PAYPAL,
          providerSubId: { not: "" },
          plan: { in: [...SELF_SERVICE_BASE_SUBSCRIPTION_PLANS] },
          status: prismaPkg.SubscriptionStatus.TRIALING,
        },
        orderBy: { createdAt: "desc" },
        select: { id: true, plan: true },
      });

  const attemptId = attempt?.id ?? legacy?.id ?? null;
  const plan = attempt?.planKey ?? legacy?.plan ?? input.targetPlan;
  if (!attemptId) {
    return {
      outcome: "NO_PENDING_ATTEMPT",
      provider: prismaPkg.PaymentProvider.PAYPAL,
      plan: input.targetPlan,
      status: null,
    };
  }

  const result = await abandonCheckoutAttempt({
    account,
    attemptId,
    confirmed: input.confirmed,
    deps: { providers: input.providers ?? defaultReconciliationProviders() },
  });

  const base = { provider: prismaPkg.PaymentProvider.PAYPAL, plan };
  switch (result.outcome) {
    case "ABANDON_CONFIRMATION_REQUIRED":
      return {
        ...base,
        outcome: "ABANDON_CONFIRMATION_REQUIRED",
        status: prismaPkg.SubscriptionStatus.TRIALING,
        ...(result.warning ? { warning: result.warning } : {}),
        confirmation: { canConfirmAbandon: true },
      };
    case "ABANDONED":
      return { ...base, outcome: "ABANDONED", status: prismaPkg.SubscriptionStatus.CANCELED };
    case "ABANDON_NOT_ALLOWED":
      return {
        ...base,
        outcome: "STILL_PENDING",
        status: prismaPkg.SubscriptionStatus.TRIALING,
        ...(result.warning ? { warning: result.warning } : {}),
      };
    default:
      return { ...base, outcome: "UPDATED", status: null };
  }
}
