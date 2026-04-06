import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import * as prismaPkg from "@prisma/client";
import { requireAuth } from "../middleware/auth.js";
import { requireLegalAcceptance } from "../middleware/require-legal-acceptance.js";
import { getAuthUserId } from "../auth.js";
import {
  addCredits,
  ensureEntitlement,
  recordPayment,
  setPlan,
} from "../services/billing.service.js";
import { stripeRequest, stripeRequestRaw } from "../services/stripe.service.js";
import { paypalRequest } from "../services/paypal.service.js";
import { prisma } from "../db.js";
import { appendPlatformAuditLog } from "../services/platform-audit-log.service.js";
import { writeAnalyticsEvent } from "../services/analytics-event.service.js";

const PricingResponse = {
  free: { plan: "FREE", credits: 0 },
  payg: { plan: "PAYG" },
  pro: { plan: "PRO" },
  team: { plan: "TEAM", seats: 5 },
};

const PlanTypeSchema = prismaPkg.PlanType
  ? z.nativeEnum(prismaPkg.PlanType)
  : z.enum(["FREE", "PAYG", "PRO", "TEAM"]);

const CheckoutBody = z.object({
  plan: PlanTypeSchema,
  currency: z.string().min(3).max(3).optional(),
});

function priceCentsFor(plan: prismaPkg.PlanType) {
  if (plan === prismaPkg.PlanType.PAYG) {
    return Number.parseInt(process.env.STRIPE_PAYG_PRICE_CENTS ?? "200", 10);
  }
  if (plan === prismaPkg.PlanType.PRO) {
    return Number.parseInt(process.env.STRIPE_PRO_PRICE_CENTS ?? "1500", 10);
  }
  if (plan === prismaPkg.PlanType.TEAM) {
    return Number.parseInt(process.env.STRIPE_TEAM_PRICE_CENTS ?? "4000", 10);
  }
  return 0;
}

function normalizeCurrency(value?: string) {
  const currency = (value ?? "USD").toUpperCase();
  return ["USD", "EUR", "GBP"].includes(currency) ? currency : "USD";
}

function priceIdFor(plan: prismaPkg.PlanType): string | null {
  if (plan === prismaPkg.PlanType.PAYG) return process.env.STRIPE_PAYG_PRICE_ID ?? null;
  if (plan === prismaPkg.PlanType.PRO) return process.env.STRIPE_PRO_PRICE_ID ?? null;
  if (plan === prismaPkg.PlanType.TEAM) return process.env.STRIPE_TEAM_PRICE_ID ?? null;
  return null;
}

async function requireAuthAndLegal(req: FastifyRequest, reply: FastifyReply) {
  await requireAuth(req, reply);
  if (reply.sent) return;
  await requireLegalAcceptance(req, reply);
}

function readUserAgent(req: FastifyRequest): string | null {
  const ua = req.headers["user-agent"];
  return Array.isArray(ua) ? ua[0] ?? null : ua ?? null;
}

function getRequestPath(req: FastifyRequest): string {
  const url = req.url || "";
  const qIndex = url.indexOf("?");
  return qIndex >= 0 ? url.slice(0, qIndex) : url;
}

function auditBillingAction(
  req: FastifyRequest,
  params: {
    userId: string | null;
    action: string;
    outcome?: "success" | "failure" | "blocked";
    severity?: "info" | "warning" | "critical";
    resourceId?: string | null;
    metadata?: Record<string, unknown>;
  }
) {
  void appendPlatformAuditLog({
    userId: params.userId,
    action: params.action,
    category: "billing",
    severity: params.severity ?? "info",
    source: "api_billing",
    outcome: params.outcome ?? "success",
    resourceType: "billing",
    resourceId: params.resourceId ?? null,
    requestId: req.id,
    metadata: params.metadata ?? {},
    ipAddress: req.ip,
    userAgent: readUserAgent(req),
  }).catch(() => null);
}

function fireBillingAnalyticsEvent(params: {
  eventType: string;
  userId: string;
  req: FastifyRequest;
  entityType?: string | null;
  entityId?: string | null;
  severity?: string | null;
  metadata?: Record<string, unknown>;
}) {
  void writeAnalyticsEvent({
    eventType: params.eventType,
    userId: params.userId,
    path: getRequestPath(params.req),
    entityType: params.entityType ?? "billing",
    entityId: params.entityId ?? null,
    severity: params.severity ?? "info",
    metadata: params.metadata ?? {},
    req: params.req,
    skipSessionUpsert: true,
  }).catch(() => null);
}

export async function billingRoutes(app: FastifyInstance) {
  app.get("/v1/billing/pricing", async (_req, reply) => {
    return reply.code(200).send(PricingResponse);
  });

  app.get("/v1/billing/status", { preHandler: requireAuthAndLegal }, async (req, reply) => {
    const userId = getAuthUserId(req);
    const entitlement = await ensureEntitlement(userId);

    auditBillingAction(req, {
      userId,
      action: "billing.status_view",
      outcome: "success",
      metadata: { plan: entitlement.plan, credits: entitlement.credits },
    });

    return reply.code(200).send({ entitlement });
  });

  app.get("/v1/billing/payments", { preHandler: requireAuthAndLegal }, async (req, reply) => {
    const userId = getAuthUserId(req);
    const items = await prisma.payment.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 20,
    });

    auditBillingAction(req, {
      userId,
      action: "billing.payments_list",
      outcome: "success",
      metadata: { count: items.length },
    });

    return reply.code(200).send({ items });
  });

  app.get(
    "/v1/billing/subscription",
    { preHandler: requireAuthAndLegal },
    async (req, reply) => {
      const userId = getAuthUserId(req);
      const subscription = await prisma.subscription.findFirst({
        where: { userId },
        orderBy: { createdAt: "desc" },
      });

      auditBillingAction(req, {
        userId,
        action: "billing.subscription_view",
        outcome: "success",
        metadata: {
          found: Boolean(subscription),
          status: subscription?.status ?? null,
          plan: subscription?.plan ?? null,
        },
      });

      return reply.code(200).send({ subscription });
    }
  );

  app.post(
    "/v1/billing/subscription/cancel",
    { preHandler: requireAuthAndLegal },
    async (req, reply) => {
      const userId = getAuthUserId(req);
      const subscription = await prisma.subscription.findFirst({
        where: { userId, status: prismaPkg.SubscriptionStatus.ACTIVE },
      });

      if (!subscription) {
        auditBillingAction(req, {
          userId,
          action: "billing.subscription_cancel",
          outcome: "failure",
          severity: "warning",
          metadata: { reason: "no_active_subscription" },
        });
        return reply.code(404).send({ message: "No active subscription" });
      }

      if (subscription.provider !== prismaPkg.PaymentProvider.STRIPE) {
        auditBillingAction(req, {
          userId,
          action: "billing.subscription_cancel",
          outcome: "blocked",
          severity: "warning",
          resourceId: subscription.id,
          metadata: { reason: "unsupported_provider", provider: subscription.provider },
        });
        return reply.code(400).send({ message: "Unsupported provider" });
      }

      await stripeRequestRaw(`/subscriptions/${subscription.providerSubId}`, "DELETE");

      const updated = await prisma.subscription.update({
        where: { id: subscription.id },
        data: { status: prismaPkg.SubscriptionStatus.CANCELED },
      });

      await ensureEntitlement(userId);

      auditBillingAction(req, {
        userId,
        action: "billing.subscription_cancel",
        outcome: "success",
        resourceId: updated.id,
        metadata: { provider: updated.provider, plan: updated.plan },
      });

      fireBillingAnalyticsEvent({
        eventType: "subscription_cancelled",
        userId,
        req,
        entityId: updated.id,
        metadata: { provider: updated.provider, plan: updated.plan },
      });

      return reply.code(200).send({ subscription: updated });
    }
  );

  app.post("/v1/billing/restore", { preHandler: requireAuthAndLegal }, async (req, reply) => {
    const userId = getAuthUserId(req);
    const entitlement = await ensureEntitlement(userId);

    auditBillingAction(req, {
      userId,
      action: "billing.restore_entitlement",
      outcome: "success",
      metadata: { plan: entitlement.plan, credits: entitlement.credits },
    });

    return reply.code(200).send({ entitlement });
  });

  app.post(
    "/v1/billing/checkout/stripe",
    { preHandler: requireAuthAndLegal },
    async (req, reply) => {
      const body = CheckoutBody.parse(req.body);
      const currency = normalizeCurrency(body.currency);
      const amountCents = priceCentsFor(body.plan);
      const mode = body.plan === prismaPkg.PlanType.PAYG ? "payment" : "subscription";
      const appBase =
        process.env.APP_BASE_URL ?? process.env.WEB_BASE_URL ?? "https://app.proovra.com";

      const params = new URLSearchParams();
      params.append("mode", mode);
      params.append("success_url", `${appBase.replace(/\/+$/, "")}/settings?success=1`);
      params.append("cancel_url", `${appBase.replace(/\/+$/, "")}/settings?canceled=1`);

      const userId = getAuthUserId(req);
      params.append("metadata[userId]", userId);
      params.append("metadata[plan]", body.plan);
      params.append("payment_method_types[]", "card");

      const priceId = priceIdFor(body.plan);
      if (priceId) {
        params.append("line_items[0][price]", priceId);
        params.append("line_items[0][quantity]", "1");
      } else {
        params.append("line_items[0][price_data][currency]", currency);
        params.append("line_items[0][price_data][product_data][name]", `Proovra ${body.plan}`);
        params.append("line_items[0][price_data][unit_amount]", amountCents.toString());
        params.append("line_items[0][quantity]", "1");
        if (mode === "subscription") {
          params.append("line_items[0][price_data][recurring][interval]", "month");
        }
      }

      if (mode === "subscription") {
        params.append("subscription_data[metadata][userId]", userId);
        params.append("subscription_data[metadata][plan]", body.plan);
      }

      const session = await stripeRequest("/checkout/sessions", params);

      auditBillingAction(req, {
        userId,
        action: "billing.checkout_stripe_created",
        outcome: "success",
        resourceId: String(session?.id ?? ""),
        metadata: {
          plan: body.plan,
          currency,
          mode,
          amountCents,
        },
      });

      fireBillingAnalyticsEvent({
        eventType: "billing_checkout_started",
        userId,
        req,
        entityId: String(session?.id ?? ""),
        metadata: {
          provider: "stripe",
          plan: body.plan,
          mode,
          amountCents,
        },
      });

      return reply.code(200).send({ session });
    }
  );

  app.post(
    "/v1/billing/checkout/paypal",
    { preHandler: requireAuthAndLegal },
    async (req, reply) => {
      const body = CheckoutBody.parse(req.body);
      const currency = normalizeCurrency(body.currency);
      const amountCents = priceCentsFor(body.plan);
      const amount = (amountCents / 100).toFixed(2);

      const userId = getAuthUserId(req);
      const order = await paypalRequest("/v2/checkout/orders", {
        intent: "CAPTURE",
        purchase_units: [
          {
            custom_id: userId,
            description: `Proovra ${body.plan}`,
            amount: { currency_code: currency, value: amount },
          },
        ],
      });

      await recordPayment({
        userId,
        provider: prismaPkg.PaymentProvider.PAYPAL,
        providerPaymentId: String(order.id ?? ""),
        amountCents,
        currency,
        status: prismaPkg.PaymentStatus.PENDING,
      });

      auditBillingAction(req, {
        userId,
        action: "billing.checkout_paypal_created",
        outcome: "success",
        resourceId: String(order.id ?? ""),
        metadata: {
          plan: body.plan,
          currency,
          amountCents,
        },
      });

      fireBillingAnalyticsEvent({
        eventType: "billing_checkout_started",
        userId,
        req,
        entityId: String(order.id ?? ""),
        metadata: {
          provider: "paypal",
          plan: body.plan,
          amountCents,
        },
      });

      return reply.code(200).send({ order });
    }
  );

  app.post(
    "/v1/billing/credits",
    { preHandler: requireAuthAndLegal },
    async (req, reply) => {
      const body = z.object({ credits: z.number().int().positive() }).parse(req.body);
      const userId = getAuthUserId(req);

      await addCredits(userId, body.credits);

      auditBillingAction(req, {
        userId,
        action: "billing.credits_added",
        outcome: "success",
        metadata: { credits: body.credits },
      });

      fireBillingAnalyticsEvent({
        eventType: "billing_credits_added",
        userId,
        req,
        metadata: { credits: body.credits },
      });

      return reply.code(200).send({ ok: true });
    }
  );

  app.post(
    "/v1/billing/plan",
    { preHandler: requireAuthAndLegal },
    async (req, reply) => {
      const body = z.object({ plan: PlanTypeSchema }).parse(req.body);
      const userId = getAuthUserId(req);

      await setPlan(userId, body.plan);

      const entitlement = await prisma.entitlement.findFirst({
        where: { userId, active: true },
      });

      auditBillingAction(req, {
        userId,
        action: "billing.plan_changed",
        outcome: "success",
        metadata: { plan: body.plan },
      });

      fireBillingAnalyticsEvent({
        eventType: "billing_plan_changed",
        userId,
        req,
        metadata: { plan: body.plan },
      });

      return reply.code(200).send({ entitlement });
    }
  );
}