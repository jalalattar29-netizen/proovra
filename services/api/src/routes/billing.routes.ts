import { resolveCommercialContext } from "../services/billing/commercial-context.service.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import * as prismaPkg from "@prisma/client";
import { requireAuth } from "../middleware/auth.js";
import { cancelPayPalSubscription } from "../services/paypal.service.js";
import { requireLegalAcceptance } from "../middleware/require-legal-acceptance.js";
import { getAuthUserId } from "../auth.js";
import { devAuthEnabled } from "../dev/dev-login.js";
import {
  setPersonalPlan,
  activateTeamPlan,
  cancelTeamPlan,
  cancelWorkspaceStorageAddon,
  getStorageAddonDefinition,
} from "../services/billing.service.js";
import { stripeRequestRaw } from "../services/stripe.service.js";
import {
  createStripeCheckoutSession,
  createPayPalCheckout,
  createStripeStorageAddonCheckoutSession,
  createPayPalStorageAddonCheckout,
} from "../services/billing-checkout.service.js";
import { prisma } from "../db.js";
import { emitTenantAudit } from "../services/audit/tenant-audit.service.js";
import { writeAnalyticsEvent } from "../services/analytics-event.service.js";
import { readBillingOverview } from "../services/billing-overview.service.js";
// §9.7 — scope consumed via the resolveCommercialContext envelope (explicit
// subjects); the scope adapter is no longer imported here.
import {
  buildPricingCatalogResponse,
  resolveCheckoutCurrency,
} from "../services/billing-pricing.service.js";
import { getPlanCapabilities } from "../services/plan-catalog.service.js";
// PHASE 10 §13.2 STEP 6 (2026-07-23) — managed-identity no-personal guard.
import { assertPersonalSpaceAllowed } from "../services/identity/identity-mode.service.js";

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

const CurrencySchema = z.enum(["USD", "EUR"]);

const CheckoutBody = z.object({
  plan: PlanTypeSchema,
  currency: CurrencySchema.optional(),
  teamId: z.string().uuid().optional(),
});

const StorageAddonCheckoutBody = z.object({
  addonKey: StorageAddonKeySchema,
  billingCycle: z.literal(prismaPkg.StorageAddonBillingCycle.ONE_TIME),
  currency: CurrencySchema.optional(),
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
    /** The authoritative Workspace (teamId) this billing action targets, when
     * one applies — MUST already be validated (e.g. via
     * `assertOwnedTeamForCheckout` or a DB-fetched, ownership-checked record).
     * Personal-scope / user-aggregate billing actions pass null. */
    workspaceId?: string | null;
    /** The provider's own identifier for the event/resource (Stripe/PayPal
     * checkout session, subscription, order, or externalSubscriptionId). */
    providerEventId?: string | null;
    metadata?: Record<string, unknown>;
  }
) {
  const outcome =
    params.outcome === "blocked"
      ? "denied"
      : params.outcome === "failure"
        ? "error"
        : "success";

  const denialReason =
    outcome !== "success"
      ? (typeof params.metadata?.reason === "string" ? params.metadata.reason : params.action)
      : null;

  void emitTenantAudit({
    action: params.action,
    outcome,
    denialReason,
    sourceApp: "API",
    actorUserId: params.userId,
    workspaceId: params.workspaceId ?? null,
    resourceType: "billing",
    resourceId: params.resourceId ?? null,
    correlationId: req.id ?? null,
    providerEventId: params.providerEventId ?? null,
    metadata: {
      ...(params.metadata ?? {}),
      severity: params.severity ?? "info",
      ipAddress: req.ip,
      userAgent: readUserAgent(req),
    },
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
  /**
   * TEAM checkout is still the only subscription checkout that targets a specific team.
   * PRO remains a personal/base plan, while team creation limits are enforced elsewhere.
   */
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

/**
 * PHASE 10 §13.2 STEP 6 (2026-07-23) — NO-PERSONAL enforcement on CHECKOUT.
 * A checkout with NO `teamId` is a PERSONAL-scope subscription (PRO/personal
 * base plan). A managed enterprise identity has no personal space and the
 * organization controls its billing/lifecycle, so deny a personal checkout
 * BEFORE any provider session is created. TEAM checkout (`teamId` present) is
 * gated by `assertOwnedTeamForCheckout` instead. Fails closed for MANAGED +
 * MANAGED_UNRESOLVED.
 */
async function assertPersonalCheckoutAllowed(userId: string, teamId?: string) {
  if (!teamId) {
    await assertPersonalSpaceAllowed(userId);
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
  if (params.billingCycle !== prismaPkg.StorageAddonBillingCycle.ONE_TIME) {
    const err: Error & { statusCode?: number } = new Error(
      "Storage add-ons are available only as one-time purchases"
    );
    err.statusCode = 400;
    throw err;
  }

  const definition = getStorageAddonDefinition(params.addonKey);

  if (params.teamId) {
    await assertOwnedTeamForCheckout(params.userId, params.teamId);

    // §9.7 — explicit WORKSPACE subject; ownership already asserted above.
    const scope = (
      await resolveCommercialContext({ type: "WORKSPACE", teamId: params.teamId, requesterUserId: params.userId })
    ).scope;
    const caps = getPlanCapabilities(scope.plan);

    if (definition.workspaceType !== "TEAM") {
      const err: Error & { statusCode?: number } = new Error(
        "This storage add-on is not valid for team workspaces"
      );
      err.statusCode = 400;
      throw err;
    }

    /**
     * Important:
     * Team workspaces are no longer assumed to be valid only on the TEAM paid plan.
     * A team workspace may also be valid when the owner's/base plan supports teams
     * (for example PRO in the new ruleset).
     *
     * So the correct guard here is:
     * - the effective workspace plan must support team workspaces
     * - not specifically `scope.plan === TEAM`
     */
    if (!caps.allowsTeamWorkspace) {
      const err: Error & { statusCode?: number; code?: string } = new Error(
        "This workspace does not currently support team storage add-ons"
      );
      err.statusCode = 409;
      err.code = "TEAM_WORKSPACE_PLAN_REQUIRED";
      throw err;
    }

    return {
      scope,
      definition,
    };
  }

  // PHASE 10 §13.2 STEP 6 (2026-07-23) — NO-PERSONAL enforcement on the
  // PERSONAL_ACCOUNT storage-addon checkout target. A managed enterprise
  // identity has no personal space, so deny BEFORE resolving commercial
  // context or creating any provider session. Fails closed for MANAGED +
  // MANAGED_UNRESOLVED. TEAM addon checkout (above) is unaffected.
  await assertPersonalSpaceAllowed(params.userId);

  // §9.7 — explicit PERSONAL_ACCOUNT subject.
  const scope = (
    await resolveCommercialContext({ type: "PERSONAL_ACCOUNT", userId: params.userId })
  ).scope;

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
  app.get("/v1/billing/pricing", async (req, reply) => {
    const query = (req.query ?? {}) as { currency?: string };
    const currency = resolveCheckoutCurrency({
      requestedCurrency: query.currency ?? null,
    });

    return reply.code(200).send(buildPricingCatalogResponse({ currency }));
  });

  app.get(
    "/v1/billing/storage-addons",
    { preHandler: requireAuthAndLegal },
    async (req, reply) => {
      const userId = getAuthUserId(req);
      const activeAddons = await readActiveStorageAddons(userId);

      const query = (req.query ?? {}) as { currency?: string };
      const currency = resolveCheckoutCurrency({
        requestedCurrency: query.currency ?? null,
      });

      auditBillingAction(req, {
        userId,
        action: "billing.storage_addons_view",
        outcome: "success",
        metadata: {
          activeCount: activeAddons.length,
          currency,
        },
      });

      const pricingCatalog = buildPricingCatalogResponse({ currency });

      return reply.code(200).send({
        catalog: pricingCatalog.storageAddons,
        active: activeAddons,
      });
    }
  );

  app.get(
    "/v1/billing/overview",
    { preHandler: requireAuthAndLegal },
    async (req, reply) => {
      const userId = getAuthUserId(req);
      const overview = await readBillingOverview(userId);

      auditBillingAction(req, {
        userId,
        action: "billing.overview_view",
        outcome: "success",
      });

      return reply.code(200).send(overview);
    }
  );

  app.get(
    "/v1/billing/status",
    { preHandler: requireAuthAndLegal },
    async (req, reply) => {
      const userId = getAuthUserId(req);
      const overview = await readBillingOverview(userId);

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
        storageAddons: overview.storageAddons,
        summary: overview.summary,
      });
    }
  );

  /**
   * PHASE 12 VERTICAL A (2026-07-30) — the canonical PAYMENT LEDGER read.
   *
   * `/v1/billing/overview` carries a 20-row payment SNAPSHOT for the summary
   * cards; this endpoint is the dedicated ledger the Billing page's payment
   * history renders from, so the history can be re-read (and paged) without
   * re-deriving the entire overview aggregate.
   *
   * Subject is SERVER-DERIVED from the session (`getAuthUserId`) — the caller
   * cannot name a userId/teamId, so cross-account reads are impossible by
   * construction. The response is an EXPLICIT SAFE PROJECTION: the raw Prisma
   * row was previously sent verbatim, which leaked `userId` and would leak any
   * column a future migration adds to `payments`.
   */
  app.get(
    "/v1/billing/payments",
    { preHandler: requireAuthAndLegal },
    async (req, reply) => {
      const userId = getAuthUserId(req);

      const query = z
        .object({ limit: z.coerce.number().int().min(1).max(100).optional() })
        .safeParse(req.query ?? {});
      if (!query.success) {
        return reply.code(400).send({ error: { code: "invalid_query" } });
      }
      const limit = query.data.limit ?? 20;

      const rows = await prisma.payment.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        take: limit,
        select: {
          id: true,
          provider: true,
          providerPaymentId: true,
          amountCents: true,
          currency: true,
          status: true,
          createdAt: true,
          teamId: true,
        },
      });

      const items = rows.map((row) => ({
        id: row.id,
        provider: row.provider,
        providerPaymentId: row.providerPaymentId,
        amountCents: row.amountCents,
        currency: row.currency,
        status: row.status,
        createdAt: row.createdAt.toISOString(),
        teamId: row.teamId ?? null,
      }));

      auditBillingAction(req, {
        userId,
        action: "billing.payments_list",
        outcome: "success",
        metadata: { count: items.length, limit },
      });

      return reply.code(200).send({ items, count: items.length, limit });
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
          workspaceId: body.teamId ?? null,
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
        try {
          await cancelPayPalSubscription(
            subscription.providerSubId,
            "Canceled by customer"
          );
        } catch (err) {
          req.log.warn(
            {
              err,
              providerSubId: subscription.providerSubId,
              subscriptionStatus: subscription.status,
              teamId: body.teamId ?? null,
            },
            "paypal.subscription_cancel.failed_remote_fallbacking_to_local_cancel"
          );
        }
      } else {
        auditBillingAction(req, {
          userId,
          action: "billing.subscription_cancel",
          outcome: "blocked",
          severity: "warning",
          resourceId: subscription.id,
          workspaceId: body.teamId ?? null,
          providerEventId: subscription.providerSubId ?? null,
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

      await prisma.workspaceStorageAddon.updateMany({
        where: {
          ownerUserId: userId,
          externalSubscriptionId: subscription.providerSubId,
          status: {
            in: [
              prismaPkg.WorkspaceStorageAddonStatus.PENDING,
              prismaPkg.WorkspaceStorageAddonStatus.ACTIVE,
              prismaPkg.WorkspaceStorageAddonStatus.PAST_DUE,
            ],
          },
        },
        data: {
          status: prismaPkg.WorkspaceStorageAddonStatus.CANCELED,
          canceledAtUtc: new Date(),
        },
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
        workspaceId: body.teamId ?? null,
        providerEventId: subscription.providerSubId ?? null,
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

  /**
   * Legacy-only endpoint.
   * New storage add-ons are one-time purchases and never create recurring subscriptions.
   * This route exists only to clean up historical monthly storage add-ons if they still exist.
   */
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
          message: "Only legacy recurring storage add-ons can be canceled",
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
        try {
          await cancelPayPalSubscription(
            addon.externalSubscriptionId,
            "Canceled by customer"
          );
        } catch (err) {
          req.log.warn(
            {
              err,
              addonId: addon.id,
              externalSubscriptionId: addon.externalSubscriptionId,
              teamId: addon.teamId ?? null,
            },
            "paypal.storage_addon_cancel.failed_remote_fallbacking_to_local_cancel"
          );
        }
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
        workspaceId: updated.teamId ?? null,
        providerEventId: addon.externalSubscriptionId ?? null,
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

  /**
   * PHASE 12 VERTICAL A (2026-07-30) — "restore purchases" / entitlement
   * re-sync.
   *
   * A provider checkout completes out-of-band (Stripe/PayPal webhook), so a
   * customer who returns to the app before the webhook lands sees a stale
   * entitlement. This endpoint re-reads the SERVER-AUTHORITATIVE commercial
   * state for the session's own account and returns the canonical overview
   * projection.
   *
   * Idempotent by construction: `readBillingOverview` → `ensureEntitlement`
   * only creates the entitlement row when it is missing, and the plan itself
   * is derived by `resolveCommercialContext` from the persisted subscription
   * state. NOTHING here accepts a client-declared plan, teamId or credit
   * amount — a retry converges on the same server truth, so the action is
   * safe to repeat.
   */
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

      return reply.code(200).send({
        ...overview,
        // Bounded, server-decided outcome the client renders verbatim — the
        // frontend never re-derives "did anything change?" from raw plan
        // values.
        restore: {
          restoredAtUtc: new Date().toISOString(),
          plan: overview.entitlement.plan,
          credits: overview.entitlement.credits,
          ownedWorkspaceCount: overview.workspaces.teams.length,
        },
      });
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

      // PHASE 10 §13.2 STEP 6 — deny personal (no-teamId) checkout for managed
      // identities BEFORE creating any provider session.
      await assertPersonalCheckoutAllowed(userId, body.teamId);

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
        workspaceId: body.teamId ?? null,
        providerEventId: result.session?.id ? String(result.session.id) : null,
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
          currency: result.currency,
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
      if (body.billingCycle !== prismaPkg.StorageAddonBillingCycle.ONE_TIME) {
        return reply.code(400).send({
          message: "Storage add-ons are available only as one-time purchases",
        });
      }

      const userId = getAuthUserId(req);

      const { scope } = await assertStorageAddonAllowed({
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
        workspaceId: body.teamId ?? null,
        providerEventId: result.session?.id ? String(result.session.id) : null,
        metadata: {
          addonKey: body.addonKey,
          billingCycle: body.billingCycle,
          teamId: body.teamId ?? null,
          amountCents: result.amountCents,
          currency: result.currency,
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
          amountCents: result.amountCents,
          currency: result.currency,
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

      // PHASE 10 §13.2 STEP 6 — deny personal (no-teamId) checkout for managed
      // identities BEFORE creating any provider session.
      await assertPersonalCheckoutAllowed(userId, body.teamId);

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
        "subscription" in result
          ? String((result.subscription as { id?: string } | undefined)?.id ?? "")
          : String((result.order as { id?: string } | undefined)?.id ?? "");

      auditBillingAction(req, {
        userId,
        action: "billing.checkout_paypal_created",
        outcome: "success",
        resourceId,
        workspaceId: body.teamId ?? null,
        providerEventId: resourceId || null,
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
          currency: result.currency,
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
      if (body.billingCycle !== prismaPkg.StorageAddonBillingCycle.ONE_TIME) {
        return reply.code(400).send({
          message: "Storage add-ons are available only as one-time purchases",
        });
      }

      const userId = getAuthUserId(req);

      const { scope } = await assertStorageAddonAllowed({
        userId,
        addonKey: body.addonKey,
        billingCycle: body.billingCycle,
        teamId: body.teamId ?? null,
      });

      const result = await createPayPalStorageAddonCheckout({
        userId,
        addonKey: body.addonKey,
        billingCycle: body.billingCycle,
        currency: body.currency,
        teamId: body.teamId ?? null,
        workspacePlan: scope.plan,
      });

      const resourceId =
        "subscription" in result
          ? String((result.subscription as { id?: string } | undefined)?.id ?? "")
          : String((result.order as { id?: string } | undefined)?.id ?? "");

      auditBillingAction(req, {
        userId,
        action: "billing.storage_addon_checkout_paypal_created",
        outcome: "success",
        resourceId,
        workspaceId: body.teamId ?? null,
        providerEventId: resourceId || null,
        metadata: {
          addonKey: body.addonKey,
          billingCycle: body.billingCycle,
          teamId: body.teamId ?? null,
          amountCents: result.amountCents,
          currency: result.currency,
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
          amountCents: result.amountCents,
          currency: result.currency,
          workspacePlan: scope.plan,
          mode: result.mode,
        },
      });

      if ("subscription" in result) {
        return reply.code(200).send({
          provider: "PAYPAL",
          mode: "subscription",
          subscription: result.subscription,
        });
      }

      return reply.code(200).send({
        provider: "PAYPAL",
        mode: "order",
        order: result.order,
      });
    }
  );

  // PHASE 12 CAPABILITY-PRESERVATION AUDIT (2026-07-28) — the dev-only
  // no-payment credit grant POST /v1/billing/credits was moved OUT of this
  // product route file into src/dev/dev-billing-credits.routes.ts, mounted only
  // inside the dev-auth boundary (devAuthEnabled()). Production route
  // registration is now 0 — it is no longer a permanent-403 product surface.
  //
  // POST /v1/billing/plan is the same dev/test-only direct plan mutation (real
  // checkout in production goes through /v1/billing/checkout/*). It stays in this
  // file because it shares the assertPersonalCheckoutAllowed / assertOwnedTeamForCheckout
  // governance guards, but its REGISTRATION is now gated behind devAuthEnabled()
  // (NODE_ENV !== production AND DEV_AUTH_ENABLED === "true"), so production route
  // registration = 0 rather than a permanent-403 product surface.
  if (devAuthEnabled()) {
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

      // Layer-2 defense: refuse even if somehow registered outside the dev boundary.
      if (!devAuthEnabled()) {
        return reply.code(404).send({ error: { code: "not_found" } });
      }

      if (body.plan === prismaPkg.PlanType.TEAM) {
        if (!body.teamId) {
          return reply
            .code(400)
            .send({ message: "teamId is required for TEAM plan" });
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

        // PHASE 10 §13.2 STEP 6 (2026-07-23) — dev-only direct personal-plan
        // change is still a personal-scope mutation; deny for managed
        // identities before the plan write (defense-in-depth alongside the
        // checkout-provider guards above; this route is 403'd in production).
        await assertPersonalCheckoutAllowed(userId, undefined);

        await setPersonalPlan(userId, body.plan);
      }

      const overview = await readBillingOverview(userId);

      auditBillingAction(req, {
        userId,
        action: "billing.plan_changed",
        outcome: "success",
        workspaceId: body.teamId ?? null,
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
}