import type { FastifyInstance, FastifyRequest } from "fastify";
import * as prismaPkg from "@prisma/client";
import {
  addCredits,
  ensureEntitlement,
  recordPayment,
  setPersonalPlan,
  activateTeamPlan,
  cancelTeamPlan,
  upsertSubscription,
} from "../services/billing.service.js";
import {
  parseStripeEvent,
  verifyStripeSignature,
} from "../services/stripe.service.js";
import {
  verifyPayPalWebhook,
  getPayPalSubscription,
} from "../services/paypal.service.js";
import { parsePayPalCustomId } from "../services/paypal-checkout-policy.service.js";

const PAYG_CREDITS_PER_PURCHASE = 1;

function parsePlan(value: unknown): prismaPkg.PlanType | null {
  if (
    value === prismaPkg.PlanType.FREE ||
    value === prismaPkg.PlanType.PAYG ||
    value === prismaPkg.PlanType.PRO ||
    value === prismaPkg.PlanType.TEAM
  ) {
    return value;
  }
  return null;
}

function parseStripeSubscriptionStatus(
  status?: string
): prismaPkg.SubscriptionStatus {
  if (status === "active") return prismaPkg.SubscriptionStatus.ACTIVE;
  if (status === "past_due") return prismaPkg.SubscriptionStatus.PAST_DUE;
  if (status === "trialing") return prismaPkg.SubscriptionStatus.TRIALING;
  return prismaPkg.SubscriptionStatus.CANCELED;
}

function parsePayPalSubscriptionStatus(
  status?: string
): prismaPkg.SubscriptionStatus {
  const normalized = (status ?? "").trim().toUpperCase();

  if (normalized === "ACTIVE") return prismaPkg.SubscriptionStatus.ACTIVE;
  if (normalized === "APPROVAL_PENDING") return prismaPkg.SubscriptionStatus.TRIALING;
  if (normalized === "APPROVED") return prismaPkg.SubscriptionStatus.TRIALING;
  if (normalized === "CREATED") return prismaPkg.SubscriptionStatus.TRIALING;
  if (normalized === "SUSPENDED") return prismaPkg.SubscriptionStatus.PAST_DUE;
  if (normalized === "EXPIRED") return prismaPkg.SubscriptionStatus.CANCELED;
  if (normalized === "CANCELLED") return prismaPkg.SubscriptionStatus.CANCELED;
  if (normalized === "CANCELLED_BY_SYSTEM") {
    return prismaPkg.SubscriptionStatus.CANCELED;
  }

  return prismaPkg.SubscriptionStatus.CANCELED;
}

function toTeamBillingStatus(
  status: prismaPkg.SubscriptionStatus
): prismaPkg.TeamBillingStatus {
  if (status === prismaPkg.SubscriptionStatus.ACTIVE) {
    return prismaPkg.TeamBillingStatus.ACTIVE;
  }
  if (status === prismaPkg.SubscriptionStatus.PAST_DUE) {
    return prismaPkg.TeamBillingStatus.PAST_DUE;
  }
  return prismaPkg.TeamBillingStatus.CANCELED;
}

async function syncPlanForSubscription(params: {
  userId: string;
  plan: prismaPkg.PlanType;
  teamId?: string | null;
  provider: prismaPkg.PaymentProvider;
  providerSubId: string;
  status: prismaPkg.SubscriptionStatus;
  currentPeriodEnd?: Date | null;
}) {
  await upsertSubscription({
    userId: params.userId,
    provider: params.provider,
    providerSubId: params.providerSubId,
    status: params.status,
    plan: params.plan,
    currentPeriodEnd: params.currentPeriodEnd ?? null,
    teamId: params.teamId ?? null,
  });

  if (params.plan === prismaPkg.PlanType.TEAM) {
    if (!params.teamId) return;

    if (params.status === prismaPkg.SubscriptionStatus.CANCELED) {
      await cancelTeamPlan({
        teamId: params.teamId,
        ownerUserId: params.userId,
      });
    } else {
      await activateTeamPlan({
        teamId: params.teamId,
        ownerUserId: params.userId,
        plan: prismaPkg.PlanType.TEAM,
        status: toTeamBillingStatus(params.status),
      });
    }

    return;
  }

  if (params.status === prismaPkg.SubscriptionStatus.CANCELED) {
    await setPersonalPlan(params.userId, prismaPkg.PlanType.FREE);
  } else {
    await setPersonalPlan(params.userId, params.plan);
  }
}

export async function webhooksRoutes(app: FastifyInstance) {
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (_req, body, done) => {
      done(null, body);
    }
  );

  app.post("/stripe", async (req: FastifyRequest, reply) => {
    const sig = req.headers["stripe-signature"];
    if (typeof sig !== "string") {
      return reply.code(400).send({ message: "Missing signature" });
    }

    const rawBody = req.body as Buffer;
    verifyStripeSignature(rawBody, sig);
    const event = parseStripeEvent(rawBody);

    if (event.type === "checkout.session.completed") {
      const session = event.data.object as {
        id: string;
        amount_total?: number;
        currency?: string;
        metadata?: {
          userId?: string;
          plan?: string;
          teamId?: string;
        };
      };

      const userId = session.metadata?.userId;
      const plan = parsePlan(session.metadata?.plan);

      if (userId && plan === prismaPkg.PlanType.PAYG) {
        await ensureEntitlement(userId);
        await addCredits(userId, PAYG_CREDITS_PER_PURCHASE);

        await recordPayment({
          userId,
          provider: prismaPkg.PaymentProvider.STRIPE,
          providerPaymentId: session.id,
          amountCents: session.amount_total ?? 0,
          currency: (session.currency ?? "usd").toUpperCase(),
          status: prismaPkg.PaymentStatus.SUCCEEDED,
          teamId: null,
        });
      }
    }

    if (
      event.type === "customer.subscription.created" ||
      event.type === "customer.subscription.updated" ||
      event.type === "customer.subscription.deleted"
    ) {
      const subscription = event.data.object as {
        id: string;
        status?: string;
        current_period_end?: number;
        metadata?: {
          userId?: string;
          plan?: string;
          teamId?: string;
        };
      };

      const userId = subscription.metadata?.userId;
      const plan = parsePlan(subscription.metadata?.plan);
      const teamId = subscription.metadata?.teamId ?? null;

      if (userId && plan) {
        await syncPlanForSubscription({
          userId,
          plan,
          teamId,
          provider: prismaPkg.PaymentProvider.STRIPE,
          providerSubId: subscription.id,
          status: parseStripeSubscriptionStatus(subscription.status),
          currentPeriodEnd: subscription.current_period_end
            ? new Date(subscription.current_period_end * 1000)
            : null,
        });
      }
    }

    if (event.type === "invoice.paid" || event.type === "invoice.payment_failed") {
      const invoice = event.data.object as {
        id: string;
        status?: string;
        amount_paid?: number;
        currency?: string;
        metadata?: {
          userId?: string;
          plan?: string;
          teamId?: string;
        };
      };

      const userId = invoice.metadata?.userId;
      const plan = parsePlan(invoice.metadata?.plan);
      const teamId = invoice.metadata?.teamId ?? null;

      if (userId && plan) {
        const status =
          invoice.status === "paid"
            ? prismaPkg.PaymentStatus.SUCCEEDED
            : prismaPkg.PaymentStatus.FAILED;

        await recordPayment({
          userId,
          provider: prismaPkg.PaymentProvider.STRIPE,
          providerPaymentId: invoice.id,
          amountCents: invoice.amount_paid ?? 0,
          currency: (invoice.currency ?? "usd").toUpperCase(),
          status,
          teamId,
        });
      }
    }

    return reply.code(200).send({ received: true });
  });

  app.post("/paypal", async (req: FastifyRequest, reply) => {
    const rawBody = (req.body as Buffer).toString("utf8");
    const verification = await verifyPayPalWebhook(req.headers, rawBody);

    if (verification.verification_status !== "SUCCESS") {
      return reply.code(400).send({ message: "Invalid webhook" });
    }

    const event = JSON.parse(rawBody) as {
      event_type: string;
      resource: {
        id?: string;
        status?: string;
        custom_id?: string;
        billing_info?: {
          next_billing_time?: string;
        };
        purchase_units?: Array<{
          custom_id?: string;
          amount?: { value?: string; currency_code?: string };
        }>;
      };
    };

    if (
      event.event_type === "PAYMENT.CAPTURE.COMPLETED" ||
      event.event_type === "CHECKOUT.ORDER.COMPLETED"
    ) {
      const unit = event.resource.purchase_units?.[0];
      const parsed = parsePayPalCustomId(unit?.custom_id ?? event.resource.custom_id);

      if (parsed.userId && parsed.plan === prismaPkg.PlanType.PAYG) {
        await ensureEntitlement(parsed.userId);
        await addCredits(parsed.userId, PAYG_CREDITS_PER_PURCHASE);

        await recordPayment({
          userId: parsed.userId,
          provider: prismaPkg.PaymentProvider.PAYPAL,
          providerPaymentId: event.resource.id ?? "",
          amountCents: Math.round(Number(unit?.amount?.value ?? 0) * 100),
          currency: (unit?.amount?.currency_code ?? "USD").toUpperCase(),
          status: prismaPkg.PaymentStatus.SUCCEEDED,
          teamId: null,
        });
      }

      return reply.code(200).send({ received: true });
    }

    if (
      event.event_type === "BILLING.SUBSCRIPTION.CREATED" ||
      event.event_type === "BILLING.SUBSCRIPTION.ACTIVATED" ||
      event.event_type === "BILLING.SUBSCRIPTION.UPDATED" ||
      event.event_type === "BILLING.SUBSCRIPTION.CANCELLED" ||
      event.event_type === "BILLING.SUBSCRIPTION.SUSPENDED" ||
      event.event_type === "BILLING.SUBSCRIPTION.EXPIRED"
    ) {
      const subscriptionId = event.resource.id ?? null;
      if (!subscriptionId) {
        return reply.code(200).send({ received: true });
      }

      let parsed = parsePayPalCustomId(event.resource.custom_id);

      if (!parsed.userId || !parsed.plan) {
        try {
          const liveSubscription = await getPayPalSubscription(subscriptionId);
          parsed = parsePayPalCustomId(
            typeof liveSubscription.custom_id === "string"
              ? liveSubscription.custom_id
              : undefined
          );
        } catch {
          // keep parsed as-is
        }
      }

      if (parsed.userId && parsed.plan) {
        await syncPlanForSubscription({
          userId: parsed.userId,
          plan: parsed.plan,
          teamId: parsed.teamId,
          provider: prismaPkg.PaymentProvider.PAYPAL,
          providerSubId: subscriptionId,
          status: parsePayPalSubscriptionStatus(event.resource.status),
          currentPeriodEnd: event.resource.billing_info?.next_billing_time
            ? new Date(event.resource.billing_info.next_billing_time)
            : null,
        });
      }

      return reply.code(200).send({ received: true });
    }

    return reply.code(200).send({ received: true });
  });
}