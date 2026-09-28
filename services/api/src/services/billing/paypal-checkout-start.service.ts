/**
 * BILLING CHECKOUT ATTEMPTS (2026-09-28) — starting a PayPal PLAN or
 * EVIDENCE-CREDIT checkout with a durable attempt, the way PayPal storage
 * checkouts already started.
 *
 *   1. commit an attempt row (advisory lock per payer and product);
 *   2. call PayPal with the attempt id as `PayPal-Request-Id` and in
 *      `custom_id`;
 *   3. bind the returned resource id, or record FAILED (PayPal refused before
 *      creating anything) / PROVIDER_OUTCOME_UNKNOWN (it may have created one).
 *
 * A duplicate click inside the reuse window returns the resource PayPal
 * already issued (read live, so no approval token is ever stored) instead of
 * creating a second one.
 */

import * as prismaPkg from "@prisma/client";

import {
  createPayPalCheckout,
} from "../billing-checkout.service.js";
import { getPlanPriceCents, resolveCheckoutCurrency } from "../billing-pricing.service.js";
import { getPayPalOrder, getPayPalSubscription } from "../paypal.service.js";
import {
  bindCheckoutAttempt,
  isProviderCreateRejection,
  openCheckoutAttempt,
  recordCheckoutCreateFailure,
  type CheckoutCreateDiagnostics,
  type OpenCheckoutAttemptGate,
} from "./checkout-attempts.service.js";
import { resolvePendingProviderCheckoutAttempt } from "./pending-checkout-attempt.service.js";
import { expireStalePlanAttempts } from "./checkout-attempt-recovery.service.js";
import { defaultReconciliationProviders } from "./reconciliation/reconciliation.service.js";

const PAYPAL = prismaPkg.PaymentProvider.PAYPAL;

export type PayPalCheckoutStart =
  | {
      kind: "CREATED" | "REUSED";
      attemptId: string;
      mode: "subscription" | "order";
      resource: Record<string, unknown>;
      currency: "USD" | "EUR";
      amountCents: number;
    }
  | {
      kind: "BLOCKED";
      httpBody: { message: string; code: string; details: Record<string, unknown> };
    };

function toDiagnostics(
  d: {
    httpStatus: number;
    debugId: string | null;
    environment: string;
    clientIdFingerprint: string;
    planId: string | null;
    currency: string;
    approvalLink: unknown;
  } | null,
): CheckoutCreateDiagnostics {
  return {
    providerHttpStatus: d?.httpStatus || null,
    providerDebugId: d?.debugId ?? null,
    providerEnvironment: d?.environment ?? null,
    providerClientIdFingerprint: d?.clientIdFingerprint ?? null,
    providerPlanId: d?.planId ?? null,
    providerCurrency: d?.currency ?? null,
    approvalLinkIdentity: (d?.approvalLink ?? null) as prismaPkg.Prisma.InputJsonObject | null,
  };
}

function blockedPlanBody(input: {
  requestedPlan: prismaPkg.PlanType;
  pendingPlan: prismaPkg.PlanType | null;
  providerBound: boolean;
  /** The provider holding the open plan checkout (plans block across providers). */
  blockingProvider?: prismaPkg.PaymentProvider;
}): { message: string; code: string; details: Record<string, unknown> } {
  if (input.blockingProvider && input.blockingProvider !== PAYPAL) {
    return {
      message:
        "A card (Stripe) checkout for a plan is already open. Finish it, or resolve it under Billing activity before starting a PayPal checkout.",
      code: "PLAN_CHECKOUT_ALREADY_OPEN",
      details: {
        provider: input.blockingProvider,
        pendingPlan: input.pendingPlan,
        requestedPlan: input.requestedPlan,
        providerBound: input.providerBound,
        retry: "RESOLVE_PENDING_CHECKOUT",
      },
    };
  }
  const same = !input.pendingPlan || input.pendingPlan === input.requestedPlan;
  return same
    ? {
        message:
          "A PayPal checkout for this plan is already open. Finish it, or resolve it on Billing before starting another.",
        code: "PAYPAL_APPROVAL_PENDING",
        details: {
          provider: PAYPAL,
          plan: input.requestedPlan,
          providerBound: input.providerBound,
          retry: "RESOLVE_PENDING_CHECKOUT",
          resolveEndpoint: "/v1/billing/checkout/paypal/pending/resolve",
        },
      }
    : {
        message:
          "A different PayPal plan checkout is already open. Resolve it on Billing before starting another plan.",
        code: "PAYPAL_DIFFERENT_PLAN_PENDING",
        details: {
          provider: PAYPAL,
          pendingPlan: input.pendingPlan,
          requestedPlan: input.requestedPlan,
          providerBound: input.providerBound,
          retry: "RESOLVE_PENDING_CHECKOUT",
          resolveEndpoint: "/v1/billing/checkout/paypal/pending/resolve",
        },
      };
}

async function createWithAttempt(input: {
  attemptId: string;
  create: () => Promise<{
    resourceId: string;
    resource: Record<string, unknown>;
    diagnostics: CheckoutCreateDiagnostics;
  }>;
}): Promise<Record<string, unknown>> {
  let created: Awaited<ReturnType<typeof input.create>>;
  try {
    created = await input.create();
  } catch (error) {
    await recordCheckoutCreateFailure({
      attemptId: input.attemptId,
      rejected: isProviderCreateRejection(error),
    }).catch(() => undefined);
    throw error;
  }
  if (!created.resourceId.trim()) {
    await recordCheckoutCreateFailure({ attemptId: input.attemptId, rejected: false }).catch(
      () => undefined,
    );
    throw new Error("PayPal checkout returned no resource id");
  }
  await bindCheckoutAttempt({
    attemptId: input.attemptId,
    providerResourceId: created.resourceId,
    diagnostics: created.diagnostics,
  });
  return created.resource;
}

/** A live, still-approvable resource for a duplicate click, or null. */
async function reusable(
  gate: Extract<OpenCheckoutAttemptGate, { kind: "REUSE" }>,
  mode: "subscription" | "order",
): Promise<Record<string, unknown> | null> {
  try {
    const resource =
      mode === "subscription"
        ? await getPayPalSubscription(gate.attempt.providerResourceId)
        : await getPayPalOrder(gate.attempt.providerResourceId);
    const status = String(resource.status ?? "").toUpperCase();
    const approvable =
      mode === "subscription"
        ? status === "APPROVAL_PENDING"
        : status === "CREATED" || status === "PAYER_ACTION_REQUIRED";
    return approvable ? resource : null;
  } catch {
    return null;
  }
}

export async function startPayPalPlanCheckout(input: {
  userId: string;
  plan: "PRO" | "TEAM";
  currency?: string | null;
}): Promise<PayPalCheckoutStart> {
  const currency = resolveCheckoutCurrency({ requestedCurrency: input.currency });
  const amountCents = getPlanPriceCents(input.plan, currency);

  // BILLING PAYPAL INTEGRITY (2026-09-28) — an approval nobody finished within
  // the approval window is closed provider-first before it can block this
  // purchase. Best effort: a provider outage leaves it to reconciliation.
  await expireStalePlanAttempts({
    userId: input.userId,
    deps: { providers: defaultReconciliationProviders() },
  }).catch(() => 0);

  const gate = await openCheckoutAttempt({
    userId: input.userId,
    product: prismaPkg.BillingCheckoutProduct.PLAN,
    provider: PAYPAL,
    planKey: input.plan,
    amountCents,
    currency,
    // A TRIALING row with no attempt is a checkout started before attempts
    // existed (or by the webhook alone). It still blocks a second checkout.
    extraBlock: async (tx) => {
      const legacy = await resolvePendingProviderCheckoutAttempt({
        userId: input.userId,
        provider: PAYPAL,
        targetPlan: input.plan,
        client: tx.subscription,
      });
      if (legacy.state === "NO_PENDING_ATTEMPT" || legacy.state === "TERMINAL_OR_STALE_ATTEMPT") {
        return null;
      }
      return {
        kind: "BLOCKED",
        reason: "PLAN_ATTEMPT_PENDING",
        attempt: {
          id: legacy.subscriptionId,
          planKey: legacy.state === "PENDING_DIFFERENT_TARGET" ? legacy.pendingPlan : input.plan,
          providerBound: true,
          createdAt: new Date(0),
        },
      };
    },
  });

  if (gate.kind === "REUSE") {
    const resource = await reusable(gate, "subscription");
    if (resource) {
      return {
        kind: "REUSED",
        attemptId: gate.attempt.id,
        mode: "subscription",
        resource,
        currency,
        amountCents,
      };
    }
    return {
      kind: "BLOCKED",
      httpBody: blockedPlanBody({ requestedPlan: input.plan, pendingPlan: input.plan, providerBound: true }),
    };
  }
  if (gate.kind === "BLOCKED") {
    return {
      kind: "BLOCKED",
      httpBody: blockedPlanBody({
        requestedPlan: input.plan,
        pendingPlan: gate.attempt.planKey,
        providerBound: gate.attempt.providerBound,
        blockingProvider: gate.attempt.provider,
      }),
    };
  }

  const resource = await createWithAttempt({
    attemptId: gate.attemptId,
    create: async () => {
      const result = await createPayPalCheckout({
        userId: input.userId,
        plan: input.plan,
        currency,
        teamId: null,
        attemptId: gate.attemptId,
      });
      if (result.mode !== "subscription") throw new Error("Unexpected PayPal plan checkout mode");
      return {
        resourceId: String(result.subscription.id ?? ""),
        resource: result.subscription,
        diagnostics: toDiagnostics(result.diagnostics),
      };
    },
  });

  return {
    kind: "CREATED",
    attemptId: gate.attemptId,
    mode: "subscription",
    resource,
    currency,
    amountCents,
  };
}

export async function startPayPalCreditCheckout(input: {
  userId: string;
  currency?: string | null;
}): Promise<PayPalCheckoutStart> {
  const currency = resolveCheckoutCurrency({ requestedCurrency: input.currency });
  const amountCents = getPlanPriceCents(prismaPkg.PlanType.PAYG, currency);

  const gate = await openCheckoutAttempt({
    userId: input.userId,
    product: prismaPkg.BillingCheckoutProduct.EVIDENCE_CREDIT,
    provider: PAYPAL,
    amountCents,
    currency,
  });

  if (gate.kind === "REUSE") {
    const resource = await reusable(gate, "order");
    if (resource) {
      return { kind: "REUSED", attemptId: gate.attempt.id, mode: "order", resource, currency, amountCents };
    }
  }
  if (gate.kind !== "OPEN") {
    return {
      kind: "BLOCKED",
      httpBody: {
        message: "A PayPal checkout for evidence credits is already starting. Wait a moment, then check Billing.",
        code: "CHECKOUT_IN_PROGRESS",
        details: { provider: PAYPAL },
      },
    };
  }

  const resource = await createWithAttempt({
    attemptId: gate.attemptId,
    create: async () => {
      const result = await createPayPalCheckout({
        userId: input.userId,
        plan: prismaPkg.PlanType.PAYG,
        currency,
        teamId: null,
        productKey: "EVIDENCE_CREDIT",
        attemptId: gate.attemptId,
      });
      if (result.mode !== "order") throw new Error("Unexpected PayPal credit checkout mode");
      return {
        resourceId: String(result.order.id ?? ""),
        resource: result.order,
        diagnostics: toDiagnostics(result.diagnostics),
      };
    },
  });

  return { kind: "CREATED", attemptId: gate.attemptId, mode: "order", resource, currency, amountCents };
}
