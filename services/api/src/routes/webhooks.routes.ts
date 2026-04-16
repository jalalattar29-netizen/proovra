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
  upsertWorkspaceStorageAddon,
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

function parseStorageAddonKey(
  value: unknown
): prismaPkg.StorageAddonKey | null {
  if (
    value === prismaPkg.StorageAddonKey.PERSONAL_10_GB ||
    value === prismaPkg.StorageAddonKey.PERSONAL_50_GB ||
    value === prismaPkg.StorageAddonKey.PERSONAL_200_GB ||
    value === prismaPkg.StorageAddonKey.TEAM_100_GB ||
    value === prismaPkg.StorageAddonKey.TEAM_500_GB ||
    value === prismaPkg.StorageAddonKey.TEAM_1_TB
  ) {
    return value;
  }
  return null;
}

function parseStorageAddonBillingCycle(
  value: unknown,
  fallback: prismaPkg.StorageAddonBillingCycle = prismaPkg.StorageAddonBillingCycle.MONTHLY
): prismaPkg.StorageAddonBillingCycle {
  if (value === prismaPkg.StorageAddonBillingCycle.ONE_TIME) {
    return prismaPkg.StorageAddonBillingCycle.ONE_TIME;
  }
  if (value === prismaPkg.StorageAddonBillingCycle.MONTHLY) {
    return prismaPkg.StorageAddonBillingCycle.MONTHLY;
  }
  return fallback;
}

function parseStripeSubscriptionStatus(
  status?: string
): prismaPkg.SubscriptionStatus {
  const normalized = (status ?? "").trim().toLowerCase();

  if (normalized === "active") return prismaPkg.SubscriptionStatus.ACTIVE;
  if (normalized === "trialing") return prismaPkg.SubscriptionStatus.TRIALING;
  if (normalized === "past_due") return prismaPkg.SubscriptionStatus.PAST_DUE;
  if (normalized === "unpaid") return prismaPkg.SubscriptionStatus.PAST_DUE;
  if (normalized === "canceled" || normalized === "incomplete_expired") {
    return prismaPkg.SubscriptionStatus.CANCELED;
  }

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

function toWorkspaceStorageAddonStatusFromStripe(
  status?: string
): prismaPkg.WorkspaceStorageAddonStatus {
  const normalized = (status ?? "").trim().toLowerCase();

  if (normalized === "active") {
    return prismaPkg.WorkspaceStorageAddonStatus.ACTIVE;
  }

  if (normalized === "trialing") {
    return prismaPkg.WorkspaceStorageAddonStatus.PENDING;
  }

  if (normalized === "past_due") {
    return prismaPkg.WorkspaceStorageAddonStatus.PAST_DUE;
  }

  if (normalized === "incomplete") {
    return prismaPkg.WorkspaceStorageAddonStatus.PENDING;
  }

  if (normalized === "unpaid") {
    return prismaPkg.WorkspaceStorageAddonStatus.PAST_DUE;
  }

  if (normalized === "canceled" || normalized === "incomplete_expired") {
    return prismaPkg.WorkspaceStorageAddonStatus.CANCELED;
  }

  return prismaPkg.WorkspaceStorageAddonStatus.FAILED;
}

function toWorkspaceStorageAddonStatusFromPayPal(
  status?: string
): prismaPkg.WorkspaceStorageAddonStatus {
  const normalized = (status ?? "").trim().toUpperCase();

  if (normalized === "ACTIVE") {
    return prismaPkg.WorkspaceStorageAddonStatus.ACTIVE;
  }

  if (
    normalized === "APPROVAL_PENDING" ||
    normalized === "APPROVED" ||
    normalized === "CREATED"
  ) {
    return prismaPkg.WorkspaceStorageAddonStatus.PENDING;
  }

  if (normalized === "SUSPENDED") {
    return prismaPkg.WorkspaceStorageAddonStatus.PAST_DUE;
  }

  if (normalized === "EXPIRED") {
    return prismaPkg.WorkspaceStorageAddonStatus.EXPIRED;
  }

  if (
    normalized === "CANCELLED" ||
    normalized === "CANCELLED_BY_SYSTEM"
  ) {
    return prismaPkg.WorkspaceStorageAddonStatus.CANCELED;
  }

  return prismaPkg.WorkspaceStorageAddonStatus.FAILED;
}

function tryParseAddonContextFromCustomId(raw: unknown): {
  userId?: string;
  teamId?: string | null;
  storageAddonKey?: prismaPkg.StorageAddonKey | null;
  billingCycle?: prismaPkg.StorageAddonBillingCycle | null;
} {
  if (typeof raw !== "string" || !raw.trim()) {
    return {};
  }

  const text = raw.trim();

  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    return {
      userId: typeof parsed.userId === "string" ? parsed.userId : undefined,
      teamId:
        typeof parsed.teamId === "string"
          ? parsed.teamId
          : parsed.teamId === null
            ? null
            : undefined,
      storageAddonKey: parseStorageAddonKey(parsed.storageAddonKey),
      billingCycle:
        parsed.billingCycle === prismaPkg.StorageAddonBillingCycle.ONE_TIME
          ? prismaPkg.StorageAddonBillingCycle.ONE_TIME
          : parsed.billingCycle === prismaPkg.StorageAddonBillingCycle.MONTHLY
            ? prismaPkg.StorageAddonBillingCycle.MONTHLY
            : null,
    };
  } catch {
    // continue
  }

  const out: Record<string, string> = {};
  for (const part of text.split(/[|;&]/g)) {
    const [rawKey, rawValue] = part.split(/[=:]/, 2);
    const key = rawKey?.trim();
    const value = rawValue?.trim();
    if (key && value) {
      out[key] = value;
    }
  }

  return {
    userId: out.userId,
    teamId: out.teamId ?? null,
    storageAddonKey: parseStorageAddonKey(out.storageAddonKey),
    billingCycle:
      out.billingCycle === prismaPkg.StorageAddonBillingCycle.ONE_TIME
        ? prismaPkg.StorageAddonBillingCycle.ONE_TIME
        : out.billingCycle === prismaPkg.StorageAddonBillingCycle.MONTHLY
          ? prismaPkg.StorageAddonBillingCycle.MONTHLY
          : null,
  };
}

function parseAmountCents(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
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
        subscription?: string | null;
        mode?: string;
        amount_total?: number;
        currency?: string;
        metadata?: {
          userId?: string;
          plan?: string;
          teamId?: string;
          storageAddonKey?: string;
          billingCycle?: string;
          currency?: string;
          amountCents?: string;
        };
      };

      const userId = session.metadata?.userId;
      const plan = parsePlan(session.metadata?.plan);
      const teamId = session.metadata?.teamId ?? null;
      const storageAddonKey = parseStorageAddonKey(
        session.metadata?.storageAddonKey
      );

      if (userId && plan === prismaPkg.PlanType.PAYG) {
        await ensureEntitlement(userId);
        await addCredits(userId, PAYG_CREDITS_PER_PURCHASE);

        await recordPayment({
          userId,
          provider: prismaPkg.PaymentProvider.STRIPE,
          providerPaymentId: session.id,
          amountCents: session.amount_total ?? 0,
          currency: (session.currency ?? session.metadata?.currency ?? "usd").toUpperCase(),
          status: prismaPkg.PaymentStatus.SUCCEEDED,
          teamId: null,
        });
      }

      if (userId && storageAddonKey) {
        const storageAddonBillingCycle = parseStorageAddonBillingCycle(
          session.metadata?.billingCycle,
          session.subscription
            ? prismaPkg.StorageAddonBillingCycle.MONTHLY
            : prismaPkg.StorageAddonBillingCycle.ONE_TIME
        );

        const effectiveCurrency = (
          session.currency ??
          session.metadata?.currency ??
          "usd"
        ).toUpperCase();

        const effectiveAmountCents =
          session.amount_total ??
          parseAmountCents(session.metadata?.amountCents) ??
          0;

        await recordPayment({
          userId,
          provider: prismaPkg.PaymentProvider.STRIPE,
          providerPaymentId: session.id,
          amountCents: effectiveAmountCents,
          currency: effectiveCurrency,
          status: prismaPkg.PaymentStatus.SUCCEEDED,
          teamId,
        });

        if (
          !session.subscription &&
          storageAddonBillingCycle === prismaPkg.StorageAddonBillingCycle.ONE_TIME
        ) {
          await upsertWorkspaceStorageAddon({
            ownerUserId: userId,
            teamId,
            addonKey: storageAddonKey,
            billingCycle: prismaPkg.StorageAddonBillingCycle.ONE_TIME,
            status: prismaPkg.WorkspaceStorageAddonStatus.ACTIVE,
            paymentProvider: prismaPkg.PaymentProvider.STRIPE,
            externalPaymentId: session.id,
            amountCents: effectiveAmountCents,
            currency: effectiveCurrency,
            metadata: {
              source: "stripe.checkout.session.completed",
              mode: session.mode ?? null,
              subscriptionId: session.subscription ?? null,
            },
          });
        }
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
          storageAddonKey?: string;
          billingCycle?: string;
          currency?: string;
          amountCents?: string;
        };
      };

      const userId = subscription.metadata?.userId;
      const plan = parsePlan(subscription.metadata?.plan);
      const teamId = subscription.metadata?.teamId ?? null;
      const storageAddonKey = parseStorageAddonKey(
        subscription.metadata?.storageAddonKey
      );
      const stripeStatus = parseStripeSubscriptionStatus(subscription.status);

      if (userId && plan) {
        await syncPlanForSubscription({
          userId,
          plan,
          teamId,
          provider: prismaPkg.PaymentProvider.STRIPE,
          providerSubId: subscription.id,
          status: stripeStatus,
          currentPeriodEnd: subscription.current_period_end
            ? new Date(subscription.current_period_end * 1000)
            : null,
        });
      }

      if (userId && storageAddonKey) {
        await upsertWorkspaceStorageAddon({
          ownerUserId: userId,
          teamId,
          addonKey: storageAddonKey,
          billingCycle: parseStorageAddonBillingCycle(
            subscription.metadata?.billingCycle,
            prismaPkg.StorageAddonBillingCycle.MONTHLY
          ),
          status: toWorkspaceStorageAddonStatusFromStripe(subscription.status),
          paymentProvider: prismaPkg.PaymentProvider.STRIPE,
          externalSubscriptionId: subscription.id,
          currency:
            typeof subscription.metadata?.currency === "string"
              ? subscription.metadata.currency.toUpperCase()
              : null,
          amountCents: parseAmountCents(subscription.metadata?.amountCents),
          currentPeriodEnd: subscription.current_period_end
            ? new Date(subscription.current_period_end * 1000)
            : null,
          metadata: {
            source: event.type,
            stripeStatus: subscription.status ?? null,
          },
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
          storageAddonKey?: string;
        };
      };

      const userId = invoice.metadata?.userId;
      const plan = parsePlan(invoice.metadata?.plan);
      const teamId = invoice.metadata?.teamId ?? null;
      const storageAddonKey = parseStorageAddonKey(
        invoice.metadata?.storageAddonKey
      );

      if (userId && (plan || storageAddonKey)) {
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
      const parsed = parsePayPalCustomId(
        unit?.custom_id ?? event.resource.custom_id
      );
      const addonContext = tryParseAddonContextFromCustomId(
        unit?.custom_id ?? event.resource.custom_id
      );

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

      if (addonContext.userId && addonContext.storageAddonKey) {
        await recordPayment({
          userId: addonContext.userId,
          provider: prismaPkg.PaymentProvider.PAYPAL,
          providerPaymentId: event.resource.id ?? "",
          amountCents: Math.round(Number(unit?.amount?.value ?? 0) * 100),
          currency: (unit?.amount?.currency_code ?? "USD").toUpperCase(),
          status: prismaPkg.PaymentStatus.SUCCEEDED,
          teamId: addonContext.teamId ?? null,
        });

        await upsertWorkspaceStorageAddon({
          ownerUserId: addonContext.userId,
          teamId: addonContext.teamId ?? null,
          addonKey: addonContext.storageAddonKey,
          billingCycle:
            addonContext.billingCycle ??
            prismaPkg.StorageAddonBillingCycle.ONE_TIME,
          status: prismaPkg.WorkspaceStorageAddonStatus.ACTIVE,
          paymentProvider: prismaPkg.PaymentProvider.PAYPAL,
          externalPaymentId: event.resource.id ?? "",
          amountCents: Math.round(Number(unit?.amount?.value ?? 0) * 100),
          currency: (unit?.amount?.currency_code ?? "USD").toUpperCase(),
          metadata: {
            source: event.event_type,
          },
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
      let addonContext = tryParseAddonContextFromCustomId(event.resource.custom_id);

      const needsPlanRefresh = !parsed.userId || !parsed.plan;
      const needsAddonRefresh =
        !addonContext.userId || !addonContext.storageAddonKey;

      if (needsPlanRefresh || needsAddonRefresh) {
        try {
          const liveSubscription = await getPayPalSubscription(subscriptionId);
          parsed = parsePayPalCustomId(
            typeof liveSubscription.custom_id === "string"
              ? liveSubscription.custom_id
              : undefined
          );
          addonContext = tryParseAddonContextFromCustomId(
            liveSubscription.custom_id
          );
        } catch {
          // keep parsed as-is
        }
      }

      const paypalStatus = parsePayPalSubscriptionStatus(event.resource.status);

      if (parsed.userId && parsed.plan) {
        await syncPlanForSubscription({
          userId: parsed.userId,
          plan: parsed.plan,
          teamId: parsed.teamId,
          provider: prismaPkg.PaymentProvider.PAYPAL,
          providerSubId: subscriptionId,
          status: paypalStatus,
          currentPeriodEnd: event.resource.billing_info?.next_billing_time
            ? new Date(event.resource.billing_info.next_billing_time)
            : null,
        });
      }

      if (addonContext.userId && addonContext.storageAddonKey) {
        await upsertWorkspaceStorageAddon({
          ownerUserId: addonContext.userId,
          teamId: addonContext.teamId ?? null,
          addonKey: addonContext.storageAddonKey,
          billingCycle:
            addonContext.billingCycle ??
            prismaPkg.StorageAddonBillingCycle.MONTHLY,
          status: toWorkspaceStorageAddonStatusFromPayPal(event.resource.status),
          paymentProvider: prismaPkg.PaymentProvider.PAYPAL,
          externalSubscriptionId: subscriptionId,
          currentPeriodEnd: event.resource.billing_info?.next_billing_time
            ? new Date(event.resource.billing_info.next_billing_time)
            : null,
          metadata: {
            source: event.event_type,
            paypalStatus: event.resource.status ?? null,
          },
        });
      }

      return reply.code(200).send({ received: true });
    }

    return reply.code(200).send({ received: true });
  });
}