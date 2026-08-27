import { resolveCommercialContext } from "../services/billing/commercial-context.service.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import * as prismaPkg from "@prisma/client";
import { requireAuth } from "../middleware/auth.js";
import { cancelPayPalSubscription } from "../services/paypal.service.js";
import { requireLegalAcceptance } from "../middleware/require-legal-acceptance.js";
import { getAuthUserId } from "../auth.js";
import { devAuthEnabled } from "../dev/dev-login.js";
// BILLING COMMERCIAL CORRECTNESS (2026-08-27) — `cancelTeamPlan` is no longer
// imported here. The cancel route used to write the local team downgrade
// itself, immediately, before any webhook had confirmed the provider agreed;
// that terminal transition is now the webhook's alone.
//
// `activateTeamPlan` and `setPersonalPlan` remain, used ONLY by the dev-only
// `POST /v1/billing/plan` route below (registered behind `devAuthEnabled()`).
import {
  activateTeamPlan,
  cancelWorkspaceStorageAddon,
  getStorageAddonDefinition,
  setPersonalPlan,
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
// BILLING COMMERCIAL CORRECTNESS (2026-08-27) — the billing-ACCOUNT authority.
// Every route below that names a subject resolves and authorizes it here, so a
// wrong-workspace or cross-organization id is refused by ONE rule rather than
// by whatever check each route happened to carry.
import {
  assertBillingCapability,
  listBillingAccountsForViewer,
  type BillingAccountType,
} from "../services/billing/billing-accounts.service.js";
import {
  buildBillingAccountProjection,
  readBillingHistoryForAccount,
} from "../services/billing/billing-account-projection.service.js";
import { requestSubscriptionCancellation } from "../services/billing/subscription-cancellation.service.js";
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
  // BILLING COMMERCIAL CORRECTNESS (2026-08-27) — new add-ons are recurring.
  // The legacy ONE_TIME cycle stays readable for grandfathered rows but can no
  // longer be PURCHASED: a one-time payment cannot fund perpetual storage, and
  // nothing in the codebase ever expired one.
  billingCycle: z
    .literal(prismaPkg.StorageAddonBillingCycle.MONTHLY)
    .default(prismaPkg.StorageAddonBillingCycle.MONTHLY),
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

// BILLING COMMERCIAL CORRECTNESS (2026-08-27) — `readActiveStorageAddons` was
// DELETED with the route it served. Its only caller was
// `GET /v1/billing/storage-addons`, which returned the catalogue plus every
// active add-on the CALLER owns, account-agnostic, for a panel that then
// filtered it in the browser. The account projection returns already-scoped
// rows instead.

async function assertStorageAddonAllowed(params: {
  userId: string;
  addonKey: prismaPkg.StorageAddonKey;
  billingCycle: prismaPkg.StorageAddonBillingCycle;
  teamId?: string | null;
}) {
  if (params.billingCycle !== prismaPkg.StorageAddonBillingCycle.MONTHLY) {
    const err: Error & { statusCode?: number } = new Error(
      "Storage add-ons are sold as recurring monthly subscriptions"
    );
    err.statusCode = 400;
    throw err;
  }

  const definition = getStorageAddonDefinition(params.addonKey);

  if (params.teamId) {
    // BILLING COMMERCIAL CORRECTNESS (2026-08-27) — the ownership check that
    // stood here was a SECOND authorization authority. Both callers of this
    // function now assert BILLING_ADDON_PURCHASE on the billing account first,
    // which is the same question asked once, in the place that owns it.

    // §9.7 — explicit WORKSPACE subject; authorization already asserted.
    const scope = (
      await resolveCommercialContext({ type: "WORKSPACE", teamId: params.teamId, requesterUserId: params.userId })
    ).scope;
    const caps = getPlanCapabilities(scope.plan);

    if (definition.billingShape !== "SHARED") {
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
    if (!caps.allowsSharedWorkspace) {
      const err: Error & { statusCode?: number; code?: string } = new Error(
        "This workspace does not currently support team storage add-ons"
      );
      err.statusCode = 409;
      err.code = "SHARED_WORKSPACE_PLAN_REQUIRED";
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

  if (definition.billingShape !== "SINGLE_OCCUPANT") {
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
  /**
   * BILLING COMMERCIAL CORRECTNESS (2026-08-27) — the billing ACCOUNT surface.
   *
   * `/v1/billing/overview` returned one flat aggregate spanning every account
   * the caller touches, with raw Prisma rows on the wire and no capability
   * filtering. These three endpoints answer one question about ONE account for
   * ONE viewer, with an explicitly-constructed DTO.
   */
  app.get(
    "/v1/billing/accounts",
    { preHandler: requireAuthAndLegal },
    async (req, reply) => {
      const userId = getAuthUserId(req);
      const accounts = await listBillingAccountsForViewer(userId);

      auditBillingAction(req, {
        userId,
        action: "billing.accounts_list",
        outcome: "success",
        metadata: { count: accounts.length },
      });

      return reply.code(200).send({ accounts });
    }
  );

  app.get(
    "/v1/billing/accounts/:type/:id",
    { preHandler: requireAuthAndLegal },
    async (req, reply) => {
      const userId = getAuthUserId(req);
      const params = z
        .object({
          type: z.enum(["PERSONAL", "WORKSPACE", "ORGANIZATION"]),
          id: z.string().min(1).max(200),
        })
        .safeParse(req.params ?? {});
      if (!params.success) {
        return reply.code(400).send({ error: { code: "invalid_params" } });
      }

      const account = await assertBillingCapability({
        viewerUserId: userId,
        type: params.data.type,
        id: params.data.id,
        capability: "BILLING_ACCOUNT_VIEW",
      });

      const query = (req.query ?? {}) as { currency?: string };
      const projection = await buildBillingAccountProjection({
        account,
        viewerUserId: userId,
        requestedCurrency: query.currency ?? null,
      });

      auditBillingAction(req, {
        userId,
        action: "billing.account_view",
        outcome: "success",
        workspaceId: account.type === "WORKSPACE" ? account.id : null,
        metadata: { accountType: account.type, plan: projection.plan.planKey },
      });

      return reply.code(200).send(projection);
    }
  );

  app.get(
    "/v1/billing/accounts/:type/:id/history",
    { preHandler: requireAuthAndLegal },
    async (req, reply) => {
      const userId = getAuthUserId(req);
      const params = z
        .object({
          type: z.enum(["PERSONAL", "WORKSPACE", "ORGANIZATION"]),
          id: z.string().min(1).max(200),
        })
        .safeParse(req.params ?? {});
      if (!params.success) {
        return reply.code(400).send({ error: { code: "invalid_params" } });
      }

      const query = z
        .object({ limit: z.coerce.number().int().min(1).max(100).optional() })
        .safeParse(req.query ?? {});
      if (!query.success) {
        return reply.code(400).send({ error: { code: "invalid_query" } });
      }

      // A viewer without BILLING_HISTORY_VIEW gets a 403 with a stable code —
      // never a silent empty list, which is how a missing capability comes to
      // look like "you have no payments".
      const account = await assertBillingCapability({
        viewerUserId: userId,
        type: params.data.type,
        id: params.data.id,
        capability: "BILLING_HISTORY_VIEW",
      });

      const items = await readBillingHistoryForAccount({
        account,
        limit: query.data.limit,
      });

      auditBillingAction(req, {
        userId,
        action: "billing.account_history_view",
        outcome: "success",
        workspaceId: account.type === "WORKSPACE" ? account.id : null,
        metadata: { accountType: account.type, count: items.length },
      });

      return reply.code(200).send({ items, count: items.length });
    }
  );

  app.get("/v1/billing/pricing", async (req, reply) => {
    const query = (req.query ?? {}) as { currency?: string };
    const currency = resolveCheckoutCurrency({
      requestedCurrency: query.currency ?? null,
    });

    return reply.code(200).send(buildPricingCatalogResponse({ currency }));
  });

  /**
   * BILLING COMMERCIAL CORRECTNESS (2026-08-27) — `GET /v1/billing/storage-addons`
   * was DELETED here.
   *
   * It served the add-on catalogue plus the caller's active add-ons as one
   * account-agnostic blob, for a panel that then filtered it in the browser by
   * a target the user picked separately. Both halves now arrive already scoped
   * on `GET /v1/billing/accounts/:type/:id`: `storageAddons.offers` is filtered
   * to the account's commercial shape and its eligibility, and
   * `storageAddons.active` is that account's own rows. Its only consumer
   * (`StorageAddonsPanel`) is deleted, so nothing calls it.
   */

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
   * BILLING COMMERCIAL CORRECTNESS (2026-08-27) — `GET /v1/billing/payments`
   * was DELETED here.
   *
   * It returned EVERY payment the caller had ever made across every billing
   * account they touch, in one list, distinguished only by a `teamId` the UI
   * rendered as the words "Team payment" / "Personal payment". That is the
   * cross-payer merge the account model exists to end.
   *
   * Its replacement is `GET /v1/billing/accounts/:type/:id/history`, which is
   * scoped to ONE account and gated on `BILLING_HISTORY_VIEW` — so a viewer
   * without that capability gets a 403 with a stable code rather than a list
   * that silently omits what they may not see.
   */

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

  /**
   * BILLING COMMERCIAL CORRECTNESS (2026-08-27) — cancellation, rebuilt.
   *
   * The route this replaces:
   *   * called Stripe's `DELETE /subscriptions/{id}` — IMMEDIATE termination —
   *     while the confirmation dialog promised "ends at the current period";
   *   * caught a failed PayPal cancellation, logged a warning and then wrote
   *     the local row as CANCELED ANYWAY, so the app reported a cancelled
   *     subscription that PayPal was still billing;
   *   * wrote local terminal state before any webhook had confirmed anything;
   *   * authorized on `Team.ownerUserId`, so no other billing authority
   *     existed.
   *
   * Now: the SUBJECT is a billing account and the capability is BILLING_CANCEL;
   * the PROVIDER is asked first and a failure changes nothing locally; Stripe
   * schedules at period end and the response says exactly when access ends;
   * and the terminal CANCELED transition is left to the webhook.
   */
  app.post(
    "/v1/billing/subscription/cancel",
    { preHandler: requireAuthAndLegal },
    async (req, reply) => {
      const userId = getAuthUserId(req);
      const body = CancelSubscriptionBody.parse(req.body ?? {});

      const accountType: BillingAccountType = body.teamId
        ? "WORKSPACE"
        : "PERSONAL";
      const accountId = body.teamId ?? userId;

      const account = await assertBillingCapability({
        viewerUserId: userId,
        type: accountType,
        id: accountId,
        capability: "BILLING_CANCEL",
      });

      const subscription = await prisma.subscription.findFirst({
        where: {
          teamId: body.teamId ?? null,
          ...(body.teamId ? {} : { userId }),
          status: {
            in: [
              prismaPkg.SubscriptionStatus.ACTIVE,
              prismaPkg.SubscriptionStatus.PAST_DUE,
              prismaPkg.SubscriptionStatus.TRIALING,
            ],
          },
        },
        orderBy: { createdAt: "desc" },
        select: { id: true, provider: true, providerSubId: true },
      });

      if (!subscription) {
        auditBillingAction(req, {
          userId,
          action: "billing.subscription_cancel",
          outcome: "failure",
          severity: "warning",
          workspaceId: body.teamId ?? null,
          metadata: { reason: "no_active_subscription" },
        });
        return reply.code(404).send({
          error: {
            code: "SUBSCRIPTION_NOT_FOUND",
            message: "There is no active subscription to cancel.",
          },
        });
      }

      // The provider decides. A failure throws and NOTHING local changes.
      const outcome = await requestSubscriptionCancellation({
        subscriptionId: subscription.id,
      });

      auditBillingAction(req, {
        userId,
        action: "billing.subscription_cancel",
        outcome: "success",
        resourceId: subscription.id,
        workspaceId: body.teamId ?? null,
        providerEventId: subscription.providerSubId,
        metadata: {
          mode: outcome.mode,
          alreadyScheduled: outcome.alreadyScheduled,
          accessEndsAtUtc: outcome.accessEndsAtUtc,
        },
      });

      fireBillingAnalyticsEvent({
        eventType: "subscription_cancellation_requested",
        userId,
        req,
        entityId: subscription.id,
        metadata: { mode: outcome.mode, accountType: account.type },
      });

      // A bounded, server-decided outcome the client renders verbatim. It never
      // re-derives "is it cancelled?" from a plan string.
      return reply.code(200).send({ cancellation: outcome });
    }
  );

  /**
   * BILLING COMMERCIAL CORRECTNESS (2026-08-27) — cancel a RECURRING storage
   * add-on.
   *
   * This route carried a "Legacy-only" header and refused anything whose
   * `billingCycle` was not MONTHLY — while no production path could create a
   * MONTHLY add-on, so it was permanently unreachable and its button
   * permanently dead. Now that an add-on IS a monthly subscription, it is the
   * live cancellation path.
   *
   * A grandfathered ONE_TIME row is deliberately refused: there is no recurring
   * charge to stop, and "cancelling" it would only take away capacity the
   * customer already paid for outright.
   */
  app.post(
    "/v1/billing/storage-addons/cancel",
    { preHandler: requireAuthAndLegal },
    async (req, reply) => {
      const userId = getAuthUserId(req);
      const body = CancelStorageAddonBody.parse(req.body ?? {});

      const addon = await prisma.workspaceStorageAddon.findUnique({
        where: { id: body.addonId },
        select: {
          id: true,
          ownerUserId: true,
          teamId: true,
          addonKey: true,
          billingCycle: true,
          paymentProvider: true,
          externalSubscriptionId: true,
        },
      });

      // Fail closed and indistinguishably: a caller must not be able to probe
      // for other tenants' add-on ids.
      if (!addon) {
        return reply.code(404).send({
          error: {
            code: "STORAGE_ADDON_NOT_FOUND",
            message: "That storage add-on is not available to your account.",
          },
        });
      }

      // The add-on belongs to a billing ACCOUNT, and cancelling it is an
      // add-on purchase-authority decision on that account.
      await assertBillingCapability({
        viewerUserId: userId,
        type: addon.teamId ? "WORKSPACE" : "PERSONAL",
        id: addon.teamId ?? userId,
        capability: "BILLING_ADDON_PURCHASE",
      });

      if (
        addon.billingCycle === prismaPkg.StorageAddonBillingCycle.ONE_TIME
      ) {
        return reply.code(409).send({
          error: {
            code: "LEGACY_ONE_TIME_ADDON_NOT_CANCELLABLE",
            message:
              "This is a one-time storage purchase. It does not renew, and the storage it added stays with your account.",
          },
        });
      }

      if (!addon.externalSubscriptionId || !addon.paymentProvider) {
        return reply.code(409).send({
          error: {
            code: "STORAGE_ADDON_NOT_LINKED",
            message:
              "This storage add-on is not linked to a payment subscription. Contact support so it can be reviewed.",
          },
        });
      }

      // Provider FIRST. A failure throws a safe 502 and nothing local changes;
      // there is no local-only fallback that could report a cancellation the
      // provider never made.
      const subscriptionRow = await prisma.subscription.findUnique({
        where: {
          provider_providerSubId: {
            provider: addon.paymentProvider,
            providerSubId: addon.externalSubscriptionId,
          },
        },
        select: { id: true },
      });

      if (subscriptionRow) {
        await requestSubscriptionCancellation({
          subscriptionId: subscriptionRow.id,
        });
      } else if (
        addon.paymentProvider === prismaPkg.PaymentProvider.PAYPAL
      ) {
        // An add-on subscription this platform never recorded as a
        // `Subscription` row still has to be stopped at the provider, and a
        // failure must still surface rather than be swallowed.
        await cancelPayPalSubscription(
          addon.externalSubscriptionId,
          "Canceled by customer",
        );
      } else {
        await stripeRequestRaw(
          `/subscriptions/${addon.externalSubscriptionId}`,
          "DELETE",
        );
      }

      const updated = await cancelWorkspaceStorageAddon({
        addonId: addon.id,
        ownerUserId: addon.ownerUserId,
      });

      auditBillingAction(req, {
        userId,
        action: "billing.storage_addon_cancel",
        outcome: "success",
        resourceId: updated.id,
        workspaceId: updated.teamId ?? null,
        providerEventId: addon.externalSubscriptionId,
        metadata: {
          addonKey: updated.addonKey,
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
        },
      });

      // A bounded projection — never the raw Prisma row, which the previous
      // implementation returned verbatim.
      return reply.code(200).send({
        addon: {
          id: updated.id,
          addonKey: updated.addonKey,
          status: updated.status,
          canceledAtUtc: updated.canceledAtUtc?.toISOString() ?? null,
        },
      });
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

      // BILLING COMMERCIAL CORRECTNESS (2026-08-27) — capability, not just
      // ownership. `assertOwnedTeamForCheckout` answered "are you
      // Team.ownerUserId", which is one specific way of holding billing
      // authority rather than the question itself.
      await assertBillingCapability({
        viewerUserId: userId,
        type: body.teamId ? "WORKSPACE" : "PERSONAL",
        id: body.teamId ?? userId,
        capability: "BILLING_MANAGE",
      });

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
      if (body.billingCycle !== prismaPkg.StorageAddonBillingCycle.MONTHLY) {
        return reply.code(400).send({
          message: "Storage add-ons are sold as recurring monthly subscriptions",
        });
      }

      const userId = getAuthUserId(req);

      await assertBillingCapability({
        viewerUserId: userId,
        type: body.teamId ? "WORKSPACE" : "PERSONAL",
        id: body.teamId ?? userId,
        capability: "BILLING_ADDON_PURCHASE",
      });

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

      // BILLING COMMERCIAL CORRECTNESS (2026-08-27) — capability, not just
      // ownership. `assertOwnedTeamForCheckout` answered "are you
      // Team.ownerUserId", which is one specific way of holding billing
      // authority rather than the question itself.
      await assertBillingCapability({
        viewerUserId: userId,
        type: body.teamId ? "WORKSPACE" : "PERSONAL",
        id: body.teamId ?? userId,
        capability: "BILLING_MANAGE",
      });

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
      if (body.billingCycle !== prismaPkg.StorageAddonBillingCycle.MONTHLY) {
        return reply.code(400).send({
          message: "Storage add-ons are sold as recurring monthly subscriptions",
        });
      }

      const userId = getAuthUserId(req);

      await assertBillingCapability({
        viewerUserId: userId,
        type: body.teamId ? "WORKSPACE" : "PERSONAL",
        id: body.teamId ?? userId,
        capability: "BILLING_ADDON_PURCHASE",
      });

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

      // BILLING COMMERCIAL CORRECTNESS (2026-08-27) — a storage add-on is a
      // recurring SUBSCRIPTION, so there is no order branch left to take.
      const resourceId = String(
        (result.subscription as { id?: string } | undefined)?.id ?? "",
      );

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

      return reply.code(200).send({
        provider: "PAYPAL",
        mode: "subscription",
        subscription: result.subscription,
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