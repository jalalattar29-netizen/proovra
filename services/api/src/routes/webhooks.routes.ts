import type { FastifyInstance, FastifyRequest } from "fastify";
import * as prismaPkg from "@prisma/client";
import {
  addCredits,
  ensureEntitlement,
  recordPayment,
  setPlan,
  setTeamSeats,
  upsertSubscription
} from "../services/billing.service.js";
import { parseStripeEvent, verifyStripeSignature } from "../services/stripe.service.js";
import { verifyPayPalWebhook } from "../services/paypal.service.js";

const PAYG_CREDITS_PER_PURCHASE = 1;

export async function webhooksRoutes(app: FastifyInstance) {
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (req, body, done) => {
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
        metadata?: { userId?: string; plan?: string };
      };
      const userId = session.metadata?.userId;
      const plan = session.metadata?.plan as prismaPkg.PlanType | undefined;
      if (userId && plan) {
        await ensureEntitlement(userId);
        if (plan === prismaPkg.PlanType.PAYG) {
          await addCredits(userId, PAYG_CREDITS_PER_PURCHASE);
        } else {
          await setPlan(userId, plan);
          if (plan === prismaPkg.PlanType.TEAM) {
            await setTeamSeats(userId, 5);
          }
        }
        await recordPayment({
          userId,
          provider: prismaPkg.PaymentProvider.STRIPE,
          providerPaymentId: session.id,
          amountCents: session.amount_total ?? 0,
          currency: (session.currency ?? "usd").toUpperCase(),
          status: prismaPkg.PaymentStatus.SUCCEEDED
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
        metadata?: { userId?: string; plan?: string };
      };
      const userId = subscription.metadata?.userId;
      const plan = subscription.metadata?.plan as prismaPkg.PlanType | undefined;
      if (userId && plan) {
        const status =
          subscription.status === "active"
            ? prismaPkg.SubscriptionStatus.ACTIVE
            : subscription.status === "past_due"
            ? prismaPkg.SubscriptionStatus.PAST_DUE
            : subscription.status === "trialing"
            ? prismaPkg.SubscriptionStatus.TRIALING
            : prismaPkg.SubscriptionStatus.CANCELED;
        await upsertSubscription({
          userId,
          provider: prismaPkg.PaymentProvider.STRIPE,
          providerSubId: subscription.id,
          status,
          plan,
          currentPeriodEnd: subscription.current_period_end
            ? new Date(subscription.current_period_end * 1000)
            : null
        });
        if (status === prismaPkg.SubscriptionStatus.CANCELED) {
          await setPlan(userId, prismaPkg.PlanType.FREE);
          await setTeamSeats(userId, 0);
        } else {
          await setPlan(userId, plan);
          if (plan === prismaPkg.PlanType.TEAM) {
            await setTeamSeats(userId, 5);
          }
        }
      }
    }

    if (event.type === "invoice.paid" || event.type === "invoice.payment_failed") {
      const invoice = event.data.object as {
        id: string;
        status?: string;
        amount_paid?: number;
        currency?: string;
        subscription?: string;
        metadata?: { userId?: string; plan?: string };
      };
      const userId = invoice.metadata?.userId;
      const plan = invoice.metadata?.plan as prismaPkg.PlanType | undefined;
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
          status
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
        id: string;
        purchase_units?: Array<{
          custom_id?: string;
          description?: string;
          amount?: { value?: string; currency_code?: string };
        }>;
      };
    };
    if (event.event_type === "CHECKOUT.ORDER.APPROVED") {
      const unit = event.resource.purchase_units?.[0];
      const userId = unit?.custom_id;
      const description = unit?.description ?? "";
      const planMatch = description.split(" ").pop() as prismaPkg.PlanType | undefined;
      if (userId && planMatch) {
        await ensureEntitlement(userId);
        if (planMatch === prismaPkg.PlanType.PAYG) {
          await addCredits(userId, PAYG_CREDITS_PER_PURCHASE);
        } else {
          await setPlan(userId, planMatch);
          if (planMatch === prismaPkg.PlanType.TEAM) {
            await setTeamSeats(userId, 5);
          }
        }
        await recordPayment({
          userId,
          provider: prismaPkg.PaymentProvider.PAYPAL,
          providerPaymentId: event.resource.id,
          amountCents: Math.round(Number(unit?.amount?.value ?? 0) * 100),
          currency: unit?.amount?.currency_code ?? "USD",
          status: prismaPkg.PaymentStatus.SUCCEEDED
        });
      }
    }

    return reply.code(200).send({ received: true });
  });
}
