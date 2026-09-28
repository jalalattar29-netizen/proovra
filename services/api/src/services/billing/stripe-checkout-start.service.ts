/**
 * BILLING CHECKOUT ATTEMPTS (2026-09-28) — starting a Stripe PLAN,
 * EVIDENCE-CREDIT or STORAGE-ADDON checkout with a durable attempt, the same
 * way PayPal plan and credit checkouts now start.
 *
 *   1. commit an attempt row (advisory lock; a PLAN attempt blocks across
 *      providers, because a person has ONE base subscription);
 *   2. create the Checkout Session with the attempt id as Stripe's
 *      `Idempotency-Key`, in `metadata[attemptId]` and `client_reference_id`;
 *   3. bind the returned session id, or record FAILED (Stripe refused before
 *      creating anything) / PROVIDER_OUTCOME_UNKNOWN (it may have created one).
 *
 * Before this, a Stripe checkout left NO local trace until a webhook arrived:
 * an abandoned or lost session never appeared on Billing, and a double click
 * created two sessions. A duplicate click inside the reuse window now returns
 * the session Stripe already issued (read live; the URL is never stored).
 *
 * This module decides nothing commercial. Settlement is
 * `settleStripeCheckoutSession`, called by the webhook and by recovery.
 */

import * as prismaPkg from "@prisma/client";

import {
  createStripeCheckoutSession,
  createStripeStorageAddonCheckoutSession,
} from "../billing-checkout.service.js";
import {
  getPlanPriceCents,
  getStorageAddonPriceCents,
  resolveCheckoutCurrency,
} from "../billing-pricing.service.js";
import { StripeHttpError, stripeGet } from "../stripe.service.js";
import {
  bindCheckoutAttempt,
  isProviderCreateRejection,
  openCheckoutAttempt,
  recordCheckoutCreateFailure,
  type OpenCheckoutAttemptGate,
} from "./checkout-attempts.service.js";
import { isStripeHostedCheckoutUrl } from "./reconciliation/stripe.provider.js";
import { expireStalePlanAttempts } from "./checkout-attempt-recovery.service.js";
import { defaultReconciliationProviders } from "./reconciliation/reconciliation.service.js";

const STRIPE = prismaPkg.PaymentProvider.STRIPE;

export type StripeCheckoutStart =
  | {
      kind: "CREATED" | "REUSED";
      attemptId: string;
      mode: "subscription" | "payment";
      session: Record<string, unknown>;
      currency: string;
      amountCents: number;
    }
  | {
      kind: "BLOCKED";
      httpBody: { message: string; code: string; details: Record<string, unknown> };
    };

/**
 * Whether a thrown Stripe create error proves Stripe created nothing.
 *
 * A 4xx is a refusal of the request itself (validation, auth, card config);
 * no session exists. 409 (idempotency conflict) and 429 (rate limit) are
 * excluded: the first means a request with this key is still in flight, the
 * second is not a statement about the object. Everything else — a timeout, a
 * 5xx, a dropped connection — may have created one.
 */
export function isStripeCreateRejection(error: unknown): boolean {
  if (isProviderCreateRejection(error)) return true;
  return (
    error instanceof StripeHttpError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 409 &&
    error.status !== 429
  );
}

function emptyDiagnostics(sessionId: string) {
  return {
    providerHttpStatus: 200,
    providerDebugId: null,
    providerEnvironment: null,
    providerClientIdFingerprint: null,
    providerPlanId: null,
    providerCurrency: null,
    approvalLinkIdentity: { sessionId } as prismaPkg.Prisma.InputJsonObject,
  };
}

async function createWithAttempt(input: {
  attemptId: string;
  create: () => Promise<{ session: Record<string, unknown>; currency: string }>;
}): Promise<Record<string, unknown>> {
  let session: Record<string, unknown>;
  try {
    session = (await input.create()).session;
  } catch (error) {
    await recordCheckoutCreateFailure({
      attemptId: input.attemptId,
      rejected: isStripeCreateRejection(error),
    }).catch(() => undefined);
    throw error;
  }
  const sessionId = typeof session.id === "string" ? session.id.trim() : "";
  if (!sessionId) {
    await recordCheckoutCreateFailure({ attemptId: input.attemptId, rejected: false }).catch(
      () => undefined,
    );
    throw new Error("Stripe checkout returned no session id");
  }
  await bindCheckoutAttempt({
    attemptId: input.attemptId,
    providerResourceId: sessionId,
    diagnostics: emptyDiagnostics(sessionId),
  });
  return session;
}

/** A live, still-payable session for a duplicate click, or null. */
async function reusable(
  gate: Extract<OpenCheckoutAttemptGate, { kind: "REUSE" }>,
): Promise<Record<string, unknown> | null> {
  try {
    const session = await stripeGet(
      `/checkout/sessions/${encodeURIComponent(gate.attempt.providerResourceId)}`,
    );
    return session.id === gate.attempt.providerResourceId &&
      session.status === "open" &&
      isStripeHostedCheckoutUrl(session.url)
      ? session
      : null;
  } catch {
    return null;
  }
}

function blockedBody(
  gate: Extract<OpenCheckoutAttemptGate, { kind: "BLOCKED" }>,
  requested: { product: "PLAN" | "EVIDENCE_CREDIT" | "STORAGE_ADDON"; plan?: string | null },
): { message: string; code: string; details: Record<string, unknown> } {
  const provider = gate.attempt.provider ?? STRIPE;
  const where = provider === prismaPkg.PaymentProvider.PAYPAL ? "PayPal" : "card (Stripe)";
  if (requested.product === "PLAN") {
    return {
      message: `A ${where} checkout for a plan is already open. Finish it, or resolve it under Billing activity before starting another.`,
      code: "PLAN_CHECKOUT_ALREADY_OPEN",
      details: {
        provider,
        pendingPlan: gate.attempt.planKey,
        requestedPlan: requested.plan ?? null,
        providerBound: gate.attempt.providerBound,
        retry: "RESOLVE_PENDING_CHECKOUT",
      },
    };
  }
  return {
    message: "This card checkout is already starting. Wait a moment, then check Billing.",
    code: "CHECKOUT_IN_PROGRESS",
    details: { provider },
  };
}

export async function startStripePlanCheckout(input: {
  userId: string;
  plan: "PRO" | "TEAM";
  currency?: string | null;
  teamId?: string | null;
}): Promise<StripeCheckoutStart> {
  const currency = resolveCheckoutCurrency({ requestedCurrency: input.currency });
  const amountCents = getPlanPriceCents(input.plan, currency);
  // Plan attempts block across providers: an expired PayPal approval must not
  // block a card purchase either (see startPayPalPlanCheckout).
  await expireStalePlanAttempts({
    userId: input.userId,
    deps: { providers: defaultReconciliationProviders() },
  }).catch(() => 0);
  const gate = await openCheckoutAttempt({
    userId: input.userId,
    product: prismaPkg.BillingCheckoutProduct.PLAN,
    provider: STRIPE,
    planKey: input.plan,
    amountCents,
    currency,
  });
  if (gate.kind === "REUSE") {
    const session = await reusable(gate);
    if (session) {
      return { kind: "REUSED", attemptId: gate.attempt.id, mode: "subscription", session, currency, amountCents };
    }
    return {
      kind: "BLOCKED",
      httpBody: blockedBody(
        {
          kind: "BLOCKED",
          reason: "PLAN_ATTEMPT_PENDING",
          attempt: { id: gate.attempt.id, planKey: input.plan, providerBound: true, createdAt: gate.attempt.createdAt, provider: STRIPE },
        },
        { product: "PLAN", plan: input.plan },
      ),
    };
  }
  if (gate.kind === "BLOCKED") {
    return { kind: "BLOCKED", httpBody: blockedBody(gate, { product: "PLAN", plan: input.plan }) };
  }
  const session = await createWithAttempt({
    attemptId: gate.attemptId,
    create: () =>
      createStripeCheckoutSession({
        userId: input.userId,
        plan: input.plan,
        currency,
        teamId: input.teamId ?? null,
        attemptId: gate.attemptId,
      }),
  });
  return { kind: "CREATED", attemptId: gate.attemptId, mode: "subscription", session, currency, amountCents };
}

export async function startStripeCreditCheckout(input: {
  userId: string;
  currency?: string | null;
}): Promise<StripeCheckoutStart> {
  const currency = resolveCheckoutCurrency({ requestedCurrency: input.currency });
  const amountCents = getPlanPriceCents(prismaPkg.PlanType.PAYG, currency);
  const gate = await openCheckoutAttempt({
    userId: input.userId,
    product: prismaPkg.BillingCheckoutProduct.EVIDENCE_CREDIT,
    provider: STRIPE,
    amountCents,
    currency,
  });
  if (gate.kind === "REUSE") {
    const session = await reusable(gate);
    if (session) {
      return { kind: "REUSED", attemptId: gate.attempt.id, mode: "payment", session, currency, amountCents };
    }
  }
  if (gate.kind !== "OPEN") {
    return {
      kind: "BLOCKED",
      httpBody: {
        message: "This card checkout is already starting. Wait a moment, then check Billing.",
        code: "CHECKOUT_IN_PROGRESS",
        details: { provider: STRIPE },
      },
    };
  }
  const session = await createWithAttempt({
    attemptId: gate.attemptId,
    create: () =>
      createStripeCheckoutSession({
        userId: input.userId,
        plan: prismaPkg.PlanType.PAYG,
        currency,
        teamId: null,
        productKey: "EVIDENCE_CREDIT",
        attemptId: gate.attemptId,
      }),
  });
  return { kind: "CREATED", attemptId: gate.attemptId, mode: "payment", session, currency, amountCents };
}

export async function startStripeStorageCheckout(input: {
  userId: string;
  addonKey: prismaPkg.StorageAddonKey;
  currency: string;
  teamId?: string | null;
  workspacePlan: prismaPkg.PlanType;
}): Promise<StripeCheckoutStart> {
  const amountCents = getStorageAddonPriceCents({
    addonKey: input.addonKey,
    currency: input.currency as Parameters<typeof getStorageAddonPriceCents>[0]["currency"],
  });
  const gate = await openCheckoutAttempt({
    userId: input.userId,
    product: prismaPkg.BillingCheckoutProduct.STORAGE_ADDON,
    provider: STRIPE,
    storageAddonKey: input.addonKey,
    amountCents,
    currency: input.currency,
  });
  if (gate.kind === "REUSE") {
    const session = await reusable(gate);
    if (session) {
      return { kind: "REUSED", attemptId: gate.attempt.id, mode: "subscription", session, currency: input.currency, amountCents };
    }
  }
  if (gate.kind !== "OPEN") {
    return {
      kind: "BLOCKED",
      httpBody: blockedBody(
        gate.kind === "BLOCKED"
          ? gate
          : {
              kind: "BLOCKED",
              reason: "CHECKOUT_IN_PROGRESS",
              attempt: { id: gate.attempt.id, planKey: null, providerBound: true, createdAt: gate.attempt.createdAt, provider: STRIPE },
            },
        { product: "STORAGE_ADDON" },
      ),
    };
  }
  const session = await createWithAttempt({
    attemptId: gate.attemptId,
    create: () =>
      createStripeStorageAddonCheckoutSession({
        userId: input.userId,
        addonKey: input.addonKey,
        billingCycle: prismaPkg.StorageAddonBillingCycle.MONTHLY,
        currency: input.currency,
        teamId: input.teamId ?? null,
        workspacePlan: input.workspacePlan,
        attemptId: gate.attemptId,
      }),
  });
  return { kind: "CREATED", attemptId: gate.attemptId, mode: "subscription", session, currency: input.currency, amountCents };
}
