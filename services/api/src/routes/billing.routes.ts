import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import * as prismaPkg from "@prisma/client";
import { requireAuth } from "../middleware/auth.js";
import { cancelPayPalSubscription } from "../services/paypal.service.js";
import { requireLegalAcceptance } from "../middleware/require-legal-acceptance.js";
import { getAuthUserId } from "../auth.js";
import {
  addCredits,
  setPersonalPlan,
  activateTeamPlan,
  cancelTeamPlan,
  cancelWorkspaceStorageAddon,
  getStorageAddonDefinition,
  listStorageAddonDefinitions,
} from "../services/billing.service.js";
import { stripeRequestRaw } from "../services/stripe.service.js";
import {
  createStripeCheckoutSession,
  createPayPalCheckout,
  createStripeStorageAddonCheckoutSession,
  createPayPalStorageAddonCheckout,
} from "../services/billing-checkout.service.js";
import { prisma } from "../db.js";
import { appendPlatformAuditLog } from "../services/platform-audit-log.service.js";
import { writeAnalyticsEvent } from "../services/analytics-event.service.js";
import { getPricingCatalogResponse } from "../services/plan-catalog.service.js";
import { readBillingOverview } from "../services/billing-overview.service.js";
import {
  getPersonalWorkspaceScope,
  getTeamWorkspaceScope,
} from "../services/workspace-billing.service.js";

const PlanTypeSchema = prismaPkg.PlanType
  ? z.nativeEnum(prismaPkg.PlanType)
  : z.enum(["FREE", "PAYG", "PRO", "TEAM"]);

const StorageAddonKeySchema = prismaPkg.StorageAddonKey
  ? z.nativeEnum(prismaPkg.StorageAddonKey)
  : z.enum([
      "PERSONAL_10_GB",
      "PERSONAL_50_GB",
      "PERSONAL_200_GB",
      "TEAM_100_GB",
      "TEAM_500_GB",
      "TEAM_1_TB",
    ]);

const StorageAddonBillingCycleSchema = prismaPkg.StorageAddonBillingCycle
  ? z.nativeEnum(prismaPkg.StorageAddonBillingCycle)
  : z.enum(["ONE_TIME", "MONTHLY"]);

const CheckoutBody = z.object({
  plan: PlanTypeSchema,
  currency: z.string().min(3).max(3).optional(),
  teamId: z.string().uuid().optional(),
});

const StorageAddonCheckoutBody = z.object({
  addonKey: StorageAddonKeySchema,
  billingCycle: StorageAddonBillingCycleSchema,
  currency: z.string().min(3).max(3).optional(),
  teamId: z.string().uuid().optional(),
});

const CancelSubscriptionBody = z.object({
  teamId: z.string().uuid().optional(),
});

const CancelStorageAddonBody = z.object({
  addonId: z.string().uuid(),
});

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

async function assertOwnedTeamForCheckout(userId: string, teamId: string) {
  const team = await prisma.team.findUnique({
    where: { id: teamId },
    select: {
      id: true,
      ownerUserId: true,
      name: true,
    },
  });

  if (!team) {
    const err: Error & { statusCode?: number } = new Error("Team not found");
    err.statusCode = 404;
    throw err;
  }

  if (team.ownerUserId !== userId) {
    const err: Error & { statusCode?: number } = new Error(
      "Only the team owner can purchase or manage this team subscription"
    );
    err.statusCode = 403;
    throw err;
  }

  return team;
}

function assertCheckoutTarget(params: {
  plan: prismaPkg.PlanType;
  teamId?: string;
}) {
  if (params.plan === prismaPkg.PlanType.TEAM && !params.teamId) {
    const err: Error & { statusCode?: number } = new Error(
      "teamId is required for TEAM checkout"
    );
    err.statusCode = 400;
    throw err;
  }

  if (params.plan !== prismaPkg.PlanType.TEAM && params.teamId) {
    const err: Error & { statusCode?: number } = new Error(
      "teamId is only allowed for TEAM checkout"
    );
    err.statusCode = 400;
    throw err;
  }
}

function assertPurchasablePlan(plan: prismaPkg.PlanType) {
  if (plan === prismaPkg.PlanType.FREE) {
    const err: Error & { statusCode?: number } = new Error(
      "FREE plan does not require checkout"
    );
    err.statusCode = 400;
    throw err;
  }
}

async function readActiveStorageAddons(userId: string) {
  return prisma.workspaceStorageAddon.findMany({
    where: {
      ownerUserId: userId,
      status: {
        in: [
          prismaPkg.WorkspaceStorageAddonStatus.ACTIVE,
          prismaPkg.WorkspaceStorageAddonStatus.PAST_DUE,
        ],
      },
    },
    orderBy: [{ teamId: "asc" }, { createdAt: "desc" }],
  });
}

async function assertStorageAddonAllowed(params: {
  userId: string;
  addonKey: prismaPkg.StorageAddonKey;
  billingCycle: prismaPkg.StorageAddonBillingCycle;
  teamId?: string | null;
}) {
  const definition = getStorageAddonDefinition(params.addonKey);

  if (params.teamId) {
    await assertOwnedTeamForCheckout(params.userId, params.teamId);

    const scope = await getTeamWorkspaceScope(params.teamId);

    if (definition.workspaceType !== "TEAM") {
      const err: Error & { statusCode?: number } = new Error(
        "This storage add-on is not valid for team workspaces"
      );
      err.statusCode = 400;
      throw err;
    }

    if (scope.plan !== prismaPkg.PlanType.TEAM) {
      const err: Error & { statusCode?: number } = new Error(
        "Team storage add-ons require an active TEAM plan"
      );
      err.statusCode = 409;
      throw err;
    }

    if (params.billingCycle !== prismaPkg.StorageAddonBillingCycle.MONTHLY) {
      const err: Error & { statusCode?: number } = new Error(
        "Team storage add-ons are only available as monthly recurring add-ons"
      );
      err.statusCode = 400;
      throw err;
    }

    return {
      scope,
      definition,
    };
  }

  const scope = await getPersonalWorkspaceScope(params.userId);

  if (definition.workspaceType !== "PERSONAL") {
    const err: Error & { statusCode?: number } = new Error(
      "This storage add-on is not valid for personal workspaces"
    );
        err.statusCode = 400;
    throw err;
  }

  if (scope.plan === prismaPkg.PlanType.FREE) {
    const err: Error & { statusCode?: number } = new Error(
      "Please upgrade your base plan before purchasing extra storage"
    );
    err.statusCode = 409;
    throw err;
  }

  if (scope.plan === prismaPkg.PlanType.PAYG) {
    if (
      params.addonKey !== prismaPkg.StorageAddonKey.PERSONAL_10_GB &&
      params.addonKey !== prismaPkg.StorageAddonKey.PERSONAL_50_GB
    ) {
      const err: Error & { statusCode?: number } = new Error(
        "PAYG supports only +10 GB and +50 GB storage add-ons"
      );
      err.statusCode = 400;
      throw err;
    }

    return {
      scope,
      definition,
    };
  }

  if (scope.plan === prismaPkg.PlanType.PRO) {
    if (params.billingCycle !== prismaPkg.StorageAddonBillingCycle.MONTHLY) {
      const err: Error & { statusCode?: number } = new Error(
        "PRO storage add-ons are only available as monthly recurring add-ons"
      );
      err.statusCode = 400;
      throw err;
    }

    return {
      scope,
      definition,
    };
  }

  const err: Error & { statusCode?: number } = new Error(
    "Unsupported workspace plan for storage add-ons"
  );
  err.statusCode = 400;
  throw err;
}

export async function billingRoutes(app: FastifyInstance) {
  app.get("/v1/billing/pricing", async (_req, reply) => {
    return reply.code(200).send({
      ...getPricingCatalogResponse(),
      storageAddons: listStorageAddonDefinitions().map((item) => ({
        key: item.key,
        workspaceType: item.workspaceType,
        label: item.label,
        storageBytes: item.storageBytes.toString(),
        priceCents: item.priceCents,
        currency: item.currency,
      })),
    });
  });

  app.get(
    "/v1/billing/storage-addons",
    { preHandler: requireAuthAndLegal },
    async (req, reply) => {
      const userId = getAuthUserId(req);
      const activeAddons = await readActiveStorageAddons(userId);

      auditBillingAction(req, {
        userId,
        action: "billing.storage_addons_view",
        outcome: "success",
        metadata: {
          activeCount: activeAddons.length,
        },
      });

      return reply.code(200).send({
        catalog: listStorageAddonDefinitions().map((item) => ({
          key: item.key,
          workspaceType: item.workspaceType,
          label: item.label,
          storageBytes: item.storageBytes.toString(),
          priceCents: item.priceCents,
          currency: item.currency,
        })),
        active: activeAddons,
      });
    }
  );

  app.get(
    "/v1/billing/overview",
    { preHandler: requireAuthAndLegal },
    async (req, reply) => {
      const userId = getAuthUserId(req);
      const [overview, storageAddons] = await Promise.all([
        readBillingOverview(userId),
        readActiveStorageAddons(userId),
      ]);

      auditBillingAction(req, {
        userId,
        action: "billing.overview_view",
        outcome: "success",
      });

      return reply.code(200).send({
        ...overview,
        storageAddons,
      });
    }
  );

  app.get(
    "/v1/billing/status",
    { preHandler: requireAuthAndLegal },
    async (req, reply) => {
      const userId = getAuthUserId(req);
      const [overview, storageAddons] = await Promise.all([
        readBillingOverview(userId),
        readActiveStorageAddons(userId),
      ]);

      auditBillingAction(req, {
        userId,
        action: "billing.status_view",
        outcome: "success",
        metadata: {
          plan: overview.entitlement.plan,
          credits: overview.entitlement.credits,
        },
      });

      return reply.code(200).send({
        entitlement: overview.entitlement,
        workspaces: overview.workspaces,
        payments: overview.payments,
        paymentMethods: overview.paymentMethods,
        storageAddons,
      });
    }
  );

  app.get(
    "/v1/billing/payments",
    { preHandler: requireAuthAndLegal },
    async (req, reply) => {
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
    }
  );

  app.get(
    "/v1/billing/subscription",
    { preHandler: requireAuthAndLegal },
    async (req, reply) => {
      const userId = getAuthUserId(req);

      const [personal, teamSubscriptions, storageAddons] = await Promise.all([
        prisma.subscription.findFirst({
          where: { userId, teamId: null },
          orderBy: { createdAt: "desc" },
        }),
        prisma.subscription.findMany({
          where: { userId, teamId: { not: null } },
          orderBy: { createdAt: "desc" },
          take: 20,
        }),
prisma.workspaceStorageAddon.findMany({
  where: {
    ownerUserId: userId,
    status: {
      in: [
        prismaPkg.WorkspaceStorageAddonStatus.ACTIVE,
        prismaPkg.WorkspaceStorageAddonStatus.PAST_DUE,
      ],
    },
  },
            orderBy: { createdAt: "desc" },
          take: 50,
        }),
      ]);

      auditBillingAction(req, {
        userId,
        action: "billing.subscription_view",
        outcome: "success",
        metadata: {
          foundPersonal: Boolean(personal),
          teamCount: teamSubscriptions.length,
          storageAddonCount: storageAddons.length,
        },
      });

      return reply.code(200).send({
        personal,
        teams: teamSubscriptions,
        storageAddons,
      });
    }
  );

  app.post(
    "/v1/billing/subscription/cancel",
    { preHandler: requireAuthAndLegal },
    async (req, reply) => {
      const userId = getAuthUserId(req);
      const body = CancelSubscriptionBody.parse(req.body ?? {});

      if (body.teamId) {
        await assertOwnedTeamForCheckout(userId, body.teamId);
      }

      const subscription = await prisma.subscription.findFirst({
        where: {
          userId,
          status: {
            in: [
              prismaPkg.SubscriptionStatus.ACTIVE,
              prismaPkg.SubscriptionStatus.PAST_DUE,
              prismaPkg.SubscriptionStatus.TRIALING,
            ],
          },
          teamId: body.teamId ?? null,
        },
        orderBy: { createdAt: "desc" },
      });

      if (!subscription) {
        auditBillingAction(req, {
          userId,
          action: "billing.subscription_cancel",
          outcome: "failure",
          severity: "warning",
          metadata: {
            reason: "no_active_subscription",
            teamId: body.teamId ?? null,
          },
        });
        return reply.code(404).send({ message: "No active subscription" });
      }

      if (subscription.provider === prismaPkg.PaymentProvider.STRIPE) {
        await stripeRequestRaw(
          `/subscriptions/${subscription.providerSubId}`,
          "DELETE"
        );
      } else if (subscription.provider === prismaPkg.PaymentProvider.PAYPAL) {
        await cancelPayPalSubscription(
          subscription.providerSubId,
          "Canceled by customer"
        );
      } else {
        auditBillingAction(req, {
          userId,
          action: "billing.subscription_cancel",
          outcome: "blocked",
          severity: "warning",
          resourceId: subscription.id,
          metadata: {
            reason: "unsupported_provider",
            provider: subscription.provider,
            teamId: body.teamId ?? null,
          },
        });
        return reply.code(400).send({ message: "Unsupported provider" });
      }

      const updated = await prisma.subscription.update({
        where: { id: subscription.id },
        data: { status: prismaPkg.SubscriptionStatus.CANCELED },
      });

      if (body.teamId) {
        await cancelTeamPlan({
          teamId: body.teamId,
          ownerUserId: userId,
        });
      } else {
        await setPersonalPlan(userId, prismaPkg.PlanType.FREE);
      }

      auditBillingAction(req, {
        userId,
        action: "billing.subscription_cancel",
        outcome: "success",
        resourceId: updated.id,
        metadata: {
          provider: updated.provider,
          plan: updated.plan,
          teamId: body.teamId ?? null,
        },
      });

      fireBillingAnalyticsEvent({
        eventType: "subscription_cancelled",
        userId,
        req,
        entityId: updated.id,
        metadata: {
          provider: updated.provider,
          plan: updated.plan,
          teamId: body.teamId ?? null,
        },
      });

      const overview = await readBillingOverview(userId);

      return reply.code(200).send({
        subscription: updated,
        entitlement: overview.entitlement,
        workspaces: overview.workspaces,
      });
    }
  );

  app.post(
    "/v1/billing/storage-addons/cancel",
    { preHandler: requireAuthAndLegal },
    async (req, reply) => {
      const userId = getAuthUserId(req);
      const body = CancelStorageAddonBody.parse(req.body ?? {});

      const addon = await prisma.workspaceStorageAddon.findUnique({
        where: { id: body.addonId },
      });

      if (!addon || addon.ownerUserId !== userId) {
        auditBillingAction(req, {
          userId,
          action: "billing.storage_addon_cancel",
          outcome: "failure",
          severity: "warning",
          metadata: {
            addonId: body.addonId,
            reason: "not_found_or_not_owned",
          },
        });

        return reply.code(404).send({ message: "Storage addon not found" });
      }

      if (addon.billingCycle !== prismaPkg.StorageAddonBillingCycle.MONTHLY) {
        return reply.code(400).send({
          message: "Only recurring storage add-ons can be canceled",
        });
      }

      if (!addon.externalSubscriptionId || !addon.paymentProvider) {
        return reply.code(400).send({
          message: "This storage add-on has no linked provider subscription",
        });
      }

      if (addon.paymentProvider === prismaPkg.PaymentProvider.STRIPE) {
        await stripeRequestRaw(
          `/subscriptions/${addon.externalSubscriptionId}`,
          "DELETE"
        );
      } else if (addon.paymentProvider === prismaPkg.PaymentProvider.PAYPAL) {
        await cancelPayPalSubscription(
          addon.externalSubscriptionId,
          "Canceled by customer"
        );
      } else {
        return reply.code(400).send({ message: "Unsupported provider" });
      }

      const updated = await cancelWorkspaceStorageAddon({
        addonId: addon.id,
        ownerUserId: userId,
      });

      auditBillingAction(req, {
        userId,
        action: "billing.storage_addon_cancel",
        outcome: "success",
        resourceId: updated.id,
        metadata: {
          addonKey: updated.addonKey,
          teamId: updated.teamId ?? null,
          provider: updated.paymentProvider ?? null,
        },
      });

      fireBillingAnalyticsEvent({
        eventType: "billing_storage_addon_canceled",
        userId,
        req,
        entityId: updated.id,
        metadata: {
          addonKey: updated.addonKey,
          teamId: updated.teamId ?? null,
          provider: updated.paymentProvider ?? null,
        },
      });

      return reply.code(200).send({ addon: updated });
    }
  );

  app.post(
    "/v1/billing/restore",
    { preHandler: requireAuthAndLegal },
    async (req, reply) => {
      const userId = getAuthUserId(req);
      const overview = await readBillingOverview(userId);

      auditBillingAction(req, {
        userId,
        action: "billing.restore_entitlement",
        outcome: "success",
        metadata: {
          plan: overview.entitlement.plan,
          credits: overview.entitlement.credits,
        },
      });

      return reply.code(200).send(overview);
    }
  );

  app.post(
    "/v1/billing/checkout/stripe",
    { preHandler: requireAuthAndLegal },
    async (req, reply) => {
      const body = CheckoutBody.parse(req.body);
      const userId = getAuthUserId(req);

      assertPurchasablePlan(body.plan);
      assertCheckoutTarget({
        plan: body.plan,
        teamId: body.teamId,
      });

      if (body.teamId) {
        await assertOwnedTeamForCheckout(userId, body.teamId);
      }

      const result = await createStripeCheckoutSession({
        userId,
        plan: body.plan,
        currency: body.currency,
        teamId: body.teamId ?? null,
      });

      auditBillingAction(req, {
        userId,
        action: "billing.checkout_stripe_created",
        outcome: "success",
        resourceId: String(result.session?.id ?? ""),
        metadata: {
          plan: body.plan,
          currency: result.currency,
          mode: result.mode,
          amountCents: result.amountCents,
          teamId: body.teamId ?? null,
        },
      });

      fireBillingAnalyticsEvent({
        eventType: "billing_checkout_started",
        userId,
        req,
        entityId: String(result.session?.id ?? ""),
        metadata: {
          provider: "STRIPE",
          plan: body.plan,
          mode: result.mode,
          amountCents: result.amountCents,
          teamId: body.teamId ?? null,
        },
      });

      return reply.code(200).send({
        provider: "STRIPE",
        mode: result.mode,
        session: result.session,
      });
    }
  );

  app.post(
    "/v1/billing/storage-addons/checkout/stripe",
    { preHandler: requireAuthAndLegal },
    async (req, reply) => {
      const body = StorageAddonCheckoutBody.parse(req.body ?? {});
      const userId = getAuthUserId(req);

      const { definition, scope } = await assertStorageAddonAllowed({
        userId,
        addonKey: body.addonKey,
        billingCycle: body.billingCycle,
        teamId: body.teamId ?? null,
      });

      const result = await createStripeStorageAddonCheckoutSession({
        userId,
        addonKey: body.addonKey,
        billingCycle: body.billingCycle,
        currency: body.currency,
        teamId: body.teamId ?? null,
        workspacePlan: scope.plan,
      });

      auditBillingAction(req, {
        userId,
        action: "billing.storage_addon_checkout_stripe_created",
        outcome: "success",
        resourceId: String(result.session?.id ?? ""),
        metadata: {
          addonKey: body.addonKey,
          billingCycle: body.billingCycle,
          teamId: body.teamId ?? null,
          amountCents: definition.priceCents,
          workspacePlan: scope.plan,
        },
      });

      fireBillingAnalyticsEvent({
        eventType: "billing_storage_addon_checkout_started",
        userId,
        req,
        entityId: String(result.session?.id ?? ""),
        metadata: {
          provider: "STRIPE",
          addonKey: body.addonKey,
          billingCycle: body.billingCycle,
          teamId: body.teamId ?? null,
          amountCents: definition.priceCents,
          workspacePlan: scope.plan,
        },
      });

      return reply.code(200).send({
        provider: "STRIPE",
        mode: result.mode,
        session: result.session,
      });
    }
  );

  app.post(
    "/v1/billing/checkout/paypal",
    { preHandler: requireAuthAndLegal },
    async (req, reply) => {
      const body = CheckoutBody.parse(req.body);
      const userId = getAuthUserId(req);

      assertPurchasablePlan(body.plan);
      assertCheckoutTarget({
        plan: body.plan,
        teamId: body.teamId,
      });

      if (body.teamId) {
        await assertOwnedTeamForCheckout(userId, body.teamId);
      }

      const result = await createPayPalCheckout({
        userId,
        plan: body.plan,
        currency: body.currency,
        teamId: body.teamId ?? null,
      });

      const resourceId =
        result.mode === "order"
          ? String(result.order?.id ?? "")
          : String(result.subscription?.id ?? "");

      auditBillingAction(req, {
        userId,
        action: "billing.checkout_paypal_created",
        outcome: "success",
        resourceId,
        metadata: {
          mode: result.mode,
          plan: body.plan,
          currency: result.currency,
          amountCents: result.amountCents,
          teamId: body.teamId ?? null,
        },
      });

      fireBillingAnalyticsEvent({
        eventType: "billing_checkout_started",
        userId,
        req,
        entityId: resourceId,
        metadata: {
          provider: "PAYPAL",
          mode: result.mode,
          plan: body.plan,
          amountCents: result.amountCents,
          teamId: body.teamId ?? null,
        },
      });

      if (result.mode === "order") {
        return reply.code(200).send({
          provider: "PAYPAL",
          mode: "order",
          order: result.order,
        });
      }

      return reply.code(200).send({
        provider: "PAYPAL",
        mode: "subscription",
        subscription: result.subscription,
      });
    }
  );

  app.post(
    "/v1/billing/storage-addons/checkout/paypal",
    { preHandler: requireAuthAndLegal },
    async (req, reply) => {
      const body = StorageAddonCheckoutBody.parse(req.body ?? {});
      const userId = getAuthUserId(req);

      const { definition, scope } = await assertStorageAddonAllowed({
        userId,
        addonKey: body.addonKey,
        billingCycle: body.billingCycle,
        teamId: body.teamId ?? null,
      });

      const result = await createPayPalStorageAddonCheckout({
        userId,
        addonKey: body.addonKey,
        billingCycle: body.billingCycle,
        currency: body.currency ?? definition.currency,
        amount: (definition.priceCents / 100).toFixed(2),
        teamId: body.teamId ?? null,
        workspacePlan: scope.plan,
      });

      const resourceId =
        result.mode === "order"
          ? String(result.order?.id ?? "")
          : String(result.subscription?.id ?? "");

      auditBillingAction(req, {
        userId,
        action: "billing.storage_addon_checkout_paypal_created",
        outcome: "success",
        resourceId,
        metadata: {
          addonKey: body.addonKey,
          billingCycle: body.billingCycle,
          teamId: body.teamId ?? null,
          amountCents: definition.priceCents,
          workspacePlan: scope.plan,
          mode: result.mode,
        },
      });

      fireBillingAnalyticsEvent({
        eventType: "billing_storage_addon_checkout_started",
        userId,
        req,
        entityId: resourceId,
        metadata: {
          provider: "PAYPAL",
          addonKey: body.addonKey,
          billingCycle: body.billingCycle,
          teamId: body.teamId ?? null,
          amountCents: definition.priceCents,
          workspacePlan: scope.plan,
          mode: result.mode,
        },
      });

      if (result.mode === "order") {
        return reply.code(200).send({
          provider: "PAYPAL",
          mode: "order",
          order: result.order,
        });
      }

      return reply.code(200).send({
        provider: "PAYPAL",
        mode: "subscription",
        subscription: result.subscription,
      });
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
      const body = z
        .object({
          plan: PlanTypeSchema,
          teamId: z.string().uuid().optional(),
        })
        .parse(req.body);

      const userId = getAuthUserId(req);

      if (
        process.env.ALLOW_DIRECT_PLAN_CHANGE !== "true" &&
        process.env.NODE_ENV === "production"
      ) {
        return reply.code(403).send({ message: "Direct plan change is disabled" });
      }

      if (body.plan === prismaPkg.PlanType.TEAM) {
        if (!body.teamId) {
          return reply.code(400).send({ message: "teamId is required for TEAM plan" });
        }

        await assertOwnedTeamForCheckout(userId, body.teamId);

        await activateTeamPlan({
          teamId: body.teamId,
          ownerUserId: userId,
          plan: prismaPkg.PlanType.TEAM,
          status: prismaPkg.TeamBillingStatus.ACTIVE,
        });
      } else {
        if (body.teamId) {
          return reply
            .code(400)
            .send({ message: "teamId is only allowed for TEAM plan" });
        }

        await setPersonalPlan(userId, body.plan);
      }

      const overview = await readBillingOverview(userId);

      auditBillingAction(req, {
        userId,
        action: "billing.plan_changed",
        outcome: "success",
        metadata: { plan: body.plan, teamId: body.teamId ?? null },
      });

      fireBillingAnalyticsEvent({
        eventType: "billing_plan_changed",
        userId,
        req,
        metadata: { plan: body.plan, teamId: body.teamId ?? null },
      });

      return reply.code(200).send(overview);
    }
  );
}