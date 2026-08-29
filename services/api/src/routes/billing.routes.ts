import { resolveCommercialContext } from "../services/billing/commercial-context.service.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import * as prismaPkg from "@prisma/client";
import { EVIDENCE_CREDIT_PRODUCT } from "@proovra/shared-billing";
import { requireAuth } from "../middleware/auth.js";
// BILLING DEPENDENT-CANCELLATION CONVERGENCE (2026-08-27) — `cancelPayPalSubscription`
// and `stripeRequestRaw` are no longer imported here. This route reached the
// provider three different ways depending on what it found locally, and its
// Stripe arm sent DELETE while the SAME add-on cancelled through a plan
// cancellation was scheduled for period end. Both paths now call
// `cancelStorageAddonAtProvider`, which owns the provider semantics.
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
  cancelWorkspaceStorageAddon,
  getStorageAddonDefinition,
  setPersonalPlan,
} from "../services/billing.service.js";
import {
  createStripeCheckoutSession,
  createStripeEvidenceCreditCheckout,
  createPayPalCheckout,
  createPayPalEvidenceCreditCheckout,
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
// BILLING PERSONAL/ORGANIZATION MODEL (2026-08-28) — the ONE authority that
// decides what a requested plan change IS. No route compares plans itself.
import {
  applyPersonalPlanChange,
  assertSelfServicePlan,
  findLivePersonalSubscription,
  resolvePersonalPlanTransition,
} from "../services/billing/plan-transition.service.js";
import { reconcileBillingAccount } from "../services/billing/reconciliation/reconciliation.service.js";
import {
  cancelPendingPayment,
  recheckPayment,
} from "../services/billing/pending-payments.service.js";
import { cancelStorageAddonAtProvider } from "../services/billing/storage-addon-cancellation.service.js";
import {
  attemptDependentCancellations,
  summarizeDependentCancellations,
} from "../services/billing/dependent-cancellation.service.js";
import { createErrorResponse, ErrorCode } from "../errors.js";
import { enforceRateLimit } from "../services/rate-limit.js";
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

/**
 * BILLING PRODUCTION CLOSURE (2026-08-27) — the RECURRING plans, and only
 * those.
 *
 * This accepted the whole `PlanType` enum, so a client could open checkout
 * naming PAYG and the resulting session carried a legacy plan row as the
 * identity of a one-time product. Evidence credits now have their own routes
 * and their own server-owned product identity; FREE was already refused by
 * `assertPurchasablePlan`, and ENTERPRISE is contracted, never self-service.
 *
 * PAYG is not listed here and no modern route accepts it.
 */
const RecurringPlanSchema = z.enum(["PRO", "TEAM"]);

const CheckoutBody = z.object({
  plan: RecurringPlanSchema,
  currency: CurrencySchema.optional(),
  teamId: z.string().uuid().optional(),
});

/**
 * Buying evidence credits takes NO commercial input at all. Quantity is
 * `EVIDENCE_CREDIT_PRODUCT.creditsGrantedPerPurchase`, the price comes from the
 * server map, and the billing subject is always the caller's personal account —
 * a credit wallet has no workspace.
 */
const EvidenceCreditCheckoutBody = z.object({
  currency: CurrencySchema.optional(),
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

/**
 * BILLING PERSONAL/ORGANIZATION MODEL (2026-08-28) — a plan change takes a
 * TARGET, and nothing else.
 *
 * FREE is accepted here and refused by the route with the reason: moving to
 * Free is a cancellation, and cancellation has its own contract — provider
 * first, period-end promise, dependent add-ons taken down with it. Rejecting
 * FREE at the schema would have made that a validation error instead of an
 * explanation, and the customer's request is perfectly sensible.
 *
 * No current plan, no direction, no price and no workspace: every one of those
 * is something the server already knows, and any of them accepted from a
 * client is a value a client can lie about.
 */
const ChangePlanBody = z.object({
  plan: z.enum(["FREE", "PRO", "TEAM"]),
  currency: CurrencySchema.optional(),
});

/**
 * BILLING PERSONAL/ORGANIZATION MODEL (2026-08-28) — `teamId` was REMOVED.
 *
 * It selected an Owned Workspace's own TEAM subscription to cancel. TEAM is a
 * tier of the personal subscription now, so there is exactly one thing a
 * person can cancel and the server already knows which it is. Leaving the
 * field accepted-but-ignored would let a stale client keep believing it was
 * cancelling one of several workspaces.
 */
const CancelSubscriptionBody = z.object({});

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

// BILLING PERSONAL/ORGANIZATION MODEL (2026-08-28) — `assertOwnedTeamForCheckout`
// was DELETED. It answered "does this user own the workspace they are buying
// for", and a checkout has no workspace to buy for: `assertCheckoutTarget`
// refuses a `teamId` outright, so there is no target left to own.
function assertCheckoutTarget(params: {
  plan: prismaPkg.PlanType;
  teamId?: string;
}) {
  if (params.teamId) {
    const err: Error & { statusCode?: number; code?: string } = new Error(
      "A subscription is bought for your Personal Workspace; it does not take a workspace target",
    );
    err.statusCode = 400;
    err.code = "CHECKOUT_TARGET_NOT_SUPPORTED";
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

/**
 * BILLING PERSONAL/ORGANIZATION MODEL (2026-08-28) — a person may hold ONE
 * live subscription.
 *
 * Both checkout routes pass through here before any provider session is
 * created. Before this existed, a PRO customer who wanted TEAM opened a second
 * checkout and got a second live provider subscription: the provider had no
 * reason to refuse, and nothing on our side looked. They were then billed
 * twice, for one Personal Workspace, indefinitely.
 *
 * The refusal names the endpoint that CAN do what they asked, because "you
 * already have a subscription" on its own reads as a dead end to a customer
 * who is trying to give us more money.
 */
async function duplicateSubscriptionRefusal(
  userId: string,
  plan: prismaPkg.PlanType,
): Promise<{
  message: string;
  code: string;
  details: Record<string, unknown>;
} | null> {
  const live = await findLivePersonalSubscription(userId);
  if (!live) return null;

  // An EXPLICIT reply rather than a throw. This refusal is an expected,
  // actionable answer — like `CHECKOUT_REQUIRED` and `CANCELLATION_REQUIRED`
  // beside it — and its whole value is the `changeEndpoint` it carries. A
  // thrown error keeps its status but loses its code and details to whichever
  // handler catches it, which would leave the customer with "409" and nothing
  // to do about it.
  return {
    message:
      "You already have a subscription. Change your plan instead of buying a second one.",
    code: "SUBSCRIPTION_ALREADY_ACTIVE",
    details: {
      requestedPlan: plan,
      changeEndpoint: "/v1/billing/subscription/plan",
    },
  };
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
          type: z.enum(["PERSONAL", "ORGANIZATION"]),
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
          type: z.enum(["PERSONAL", "ORGANIZATION"]),
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

  /**
   * BILLING PRODUCTION CLOSURE (2026-08-27) — `GET /v1/billing/status` was
   * DELETED here.
   *
   * It returned the whole `readBillingOverview` aggregate — every payment the
   * caller had made across every billing account, a `paymentMethods` shape no
   * provider authority backs, every storage add-on and every workspace — behind
   * nothing but authentication. It was the same cross-payer merge that
   * `GET /v1/billing/payments` was removed for, still reachable under a
   * different name.
   *
   * Its one consumer was the mobile Billing screen, which read a single field
   * off it. That screen now reads the capability-gated account projection
   * (`/v1/billing/accounts`, then `/v1/billing/accounts/PERSONAL/:id`).
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
  /**
   * BILLING PERSONAL/ORGANIZATION MODEL (2026-08-28) — change the plan on the
   * subscription you already have.
   *
   * This endpoint did not exist, and could not have: while TEAM was a
   * WORKSPACE's plan and PRO was a PERSON's, they were not two points on one
   * ladder and there was no move between them to make. The only way "up" was a
   * second checkout, which bought a second live subscription; the only way
   * "down" was cancelling to FREE and buying again, losing the paid remainder
   * of the period.
   *
   * The direction is decided by the server, from the subscription the server
   * can see. The client sends a target plan and nothing else — not the current
   * plan, not whether it believes this is an upgrade, not a price.
   */
  app.post(
    "/v1/billing/subscription/plan",
    { preHandler: requireAuthAndLegal },
    async (req, reply) => {
      const body = ChangePlanBody.parse(req.body ?? {});
      const userId = getAuthUserId(req);

      await assertBillingCapability({
        viewerUserId: userId,
        type: "PERSONAL",
        id: userId,
        capability: "BILLING_MANAGE",
      });

      // A managed enterprise identity has no personal space, so it has no
      // personal plan to change. Denied before any provider is contacted.
      await assertPersonalCheckoutAllowed(userId, undefined);

      const transition = await resolvePersonalPlanTransition({
        userId,
        targetPlan: body.plan,
      });

      if (transition.kind === "NO_CHANGE") {
        return reply.code(200).send({
          outcome: "NO_CHANGE",
          plan: transition.currentPlan,
        });
      }

      if (transition.kind === "NEW_SUBSCRIPTION") {
        // Nothing live to change. This is a purchase, and a purchase needs a
        // payment method, which needs a checkout — so the answer names the
        // route that can do it rather than pretending to have done anything.
        return reply.code(409).send({
          error: {
            code: "CHECKOUT_REQUIRED",
            message:
              "You do not have a subscription yet. Start a checkout to subscribe.",
          },
          plan: transition.targetPlan,
        });
      }

      if (transition.kind === "CANCELLATION") {
        // FREE is not bought, it is what remains after cancelling. Routing it
        // here rather than duplicating the cancellation contract keeps ONE
        // implementation of provider-first cancellation, dependent add-on
        // teardown and the period-end promise.
        return reply.code(409).send({
          error: {
            code: "CANCELLATION_REQUIRED",
            message:
              "Moving to Free means cancelling your subscription. Use the cancel action so we can tell you exactly what happens and when.",
          },
        });
      }

      // The provider decides. A failure throws and NOTHING local changes.
      const outcome = await applyPersonalPlanChange({
        transition,
        currency: body.currency ?? null,
      });

      auditBillingAction(req, {
        userId,
        action: "billing.subscription_plan_changed",
        outcome: "success",
        resourceId: transition.subscription.id,
        providerEventId: transition.subscription.providerSubId,
        metadata: {
          kind: outcome.kind,
          fromPlan: transition.subscription.plan,
          toPlan: outcome.targetPlan,
          effectiveAtUtc: outcome.effectiveAtUtc,
          providerConfirmed: outcome.providerConfirmed,
          approvalRequired: outcome.approvalUrl !== null,
        },
      });

      fireBillingAnalyticsEvent({
        eventType: "subscription_plan_changed",
        userId,
        req,
        entityId: transition.subscription.id,
        metadata: { kind: outcome.kind, toPlan: outcome.targetPlan },
      });

      return reply.code(200).send({
        outcome: outcome.kind,
        plan: outcome.targetPlan,
        effectiveAtUtc: outcome.effectiveAtUtc,
        approvalUrl: outcome.approvalUrl,
        providerConfirmed: outcome.providerConfirmed,
      });
    },
  );

  app.post(
    "/v1/billing/subscription/cancel",
    { preHandler: requireAuthAndLegal },
    async (req, reply) => {
      const userId = getAuthUserId(req);
      // Parsed to REFUSE unknown keys rather than to read anything: the body
      // carries nothing, and a client still sending a teamId should learn that
      // here instead of having it silently ignored.
      CancelSubscriptionBody.parse(req.body ?? {});

      // BILLING PERSONAL/ORGANIZATION MODEL (2026-08-28) — cancellation is
      // always a PERSONAL act. A `teamId` in the body used to redirect it at
      // an Owned Workspace's own TEAM subscription; TEAM is now a tier of the
      // personal subscription, so there is only one thing to cancel.
      const accountType: BillingAccountType = "PERSONAL";
      const accountId = userId;

      const account = await assertBillingCapability({
        viewerUserId: userId,
        type: accountType,
        id: accountId,
        capability: "BILLING_CANCEL",
      });

      // BILLING PERSONAL/ORGANIZATION MODEL (2026-08-28) — the SAME lookup the
      // transition authority uses, so "which subscription is yours" has one
      // answer everywhere. It used to key on the request BODY: a teamId
      // selected a workspace's subscription, its absence the personal one. A
      // legacy row still carrying a teamId is found by this too — it is that
      // person's subscription, and cancelling it is exactly what they asked
      // for.
      const subscription = await findLivePersonalSubscription(userId);

      if (!subscription) {
        auditBillingAction(req, {
          userId,
          action: "billing.subscription_cancel",
          outcome: "failure",
          severity: "warning",
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
        providerEventId: subscription.providerSubId,
        metadata: {
          mode: outcome.mode,
          alreadyScheduled: outcome.alreadyScheduled,
          accessEndsAtUtc: outcome.accessEndsAtUtc,
          dependentAddonsFound: outcome.dependentAddonsFound,
          dependentAddonsScheduled: outcome.dependentAddonsScheduled,
          dependentAddonsFailed: outcome.dependentAddonsFailed,
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
      //
      // BILLING RECONCILIATION (2026-08-27) — `ACTION_REQUIRED` is a
      // server-decided verdict, not a client inference. A recurring Storage
      // add-on is its own provider subscription, so a base cancellation that
      // could not stop one of them leaves something CHARGING. Reporting that
      // as a clean cancellation is the failure mode this closes, and the
      // client must not have to work it out from a count.
      return reply.code(200).send({
        cancellation: {
          ...outcome,
          result:
            outcome.dependentAddonsFailed > 0 ? "ACTION_REQUIRED" : "COMPLETE",
        },
      });
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
        // The payer is the add-on's owner. A stored `teamId` is tenancy.
        type: "PERSONAL",
        id: addon.ownerUserId,
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

      // BILLING DEPENDENT-CANCELLATION CONVERGENCE (2026-08-27) — ONE
      // canonical provider semantic for a recurring add-on.
      //
      // This route used to reach the provider three different ways depending
      // on what it found locally, and the Stripe arm sent `DELETE` — immediate
      // termination of storage the customer had already paid for that month —
      // while the SAME add-on cancelled as part of a plan cancellation was
      // scheduled for period end. Same object, same button in the customer's
      // mind, two outcomes.
      //
      // Both paths now call `cancelStorageAddonAtProvider`, so Stripe is always
      // period-end and PayPal is always immediate, and the local write records
      // only what the provider confirmed.
      const outcome = await cancelStorageAddonAtProvider({
        provider: addon.paymentProvider,
        providerRef: addon.externalSubscriptionId,
      });

      if (!outcome.ok) {
        // Provider first, and no local-only fallback. The add-on stays exactly
        // as it is, so it remains visible and still known to be charging.
        return reply.code(502).send({
          error: {
            code: "PROVIDER_CANCELLATION_FAILED",
            message:
              "We could not reach your payment provider to stop this add-on. Nothing has changed and you have not been charged again — please try again shortly.",
          },
        });
      }

      // A PERIOD_END schedule leaves the capacity the customer paid for in
      // place; the terminal transition is the provider's own, by webhook or
      // reconciliation. Only a TERMINAL provider statement ends it here.
      const updated = outcome.terminal
        ? await cancelWorkspaceStorageAddon({
            addonId: addon.id,
            ownerUserId: addon.ownerUserId,
          })
        : await prisma.workspaceStorageAddon.update({
            where: { id: addon.id },
            data: { canceledAtUtc: new Date() },
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
  /**
   * BILLING RECONCILIATION (2026-08-27) — real provider reconciliation,
   * replacing `POST /v1/billing/restore`.
   *
   * The route it replaces re-read local rows and returned them. It could not
   * help the one customer who needs it — the one whose webhook was lost, so
   * that the local rows are exactly what is wrong.
   *
   * WHAT THIS ROUTE ACCEPTS
   * -------------------------------------------------------------------------
   * The account in the path, and nothing else. Not a session id, not a
   * subscription id, not an amount, a currency, a product, a quantity or a
   * status. That is the security argument in full: a caller cannot claim
   * another account's purchase because there is no field in which to name one.
   * The server resolves the bindings IT stored for the authorized account and
   * asks the provider only about those.
   *
   * BOUNDED AND SERIALIZED
   * -------------------------------------------------------------------------
   * Rate-limited per actor and per account, and one run at a time per account
   * through the same distributed limiter — a second concurrent press is told
   * to wait rather than starting a parallel pass over the same bindings. The
   * service itself caps how many bindings any single run examines.
   */
  app.post(
    "/v1/billing/accounts/:type/:id/reconcile",
    { preHandler: requireAuthAndLegal },
    async (req, reply) => {
      const userId = getAuthUserId(req);
      const params = z
        .object({
          type: z.enum(["PERSONAL", "ORGANIZATION"]),
          id: z.string().min(1).max(200),
        })
        .safeParse(req.params ?? {});
      if (!params.success) {
        return reply.code(400).send({ error: { code: "invalid_params" } });
      }

      // Reconciliation writes money-backed entitlements, so it needs the
      // MANAGE capability rather than the view one: a workspace administrator
      // who is not the payer may see the plan, not repair the billing.
      const account = await assertBillingCapability({
        viewerUserId: userId,
        type: params.data.type,
        id: params.data.id,
        capability: "BILLING_MANAGE",
      });

      const rate = await enforceRateLimit({
        key: `ratelimit:billing_reconcile:${userId}:${account.type}:${account.id}`,
        max: 4,
        windowSec: 300,
      });
      if (!rate.allowed) {
        return reply.code(429).send(
          createErrorResponse(
            ErrorCode.RATE_LIMIT_EXCEEDED,
            req.id,
            undefined,
            "Billing has been re-checked recently. Please try again in a few minutes.",
          ),
        );
      }

      // ONE run per account at a time. A second press while a run is in flight
      // would duplicate every provider request for no benefit.
      const lease = await enforceRateLimit({
        key: `lease:billing_reconcile:${account.type}:${account.id}`,
        max: 1,
        windowSec: 60,
      });
      if (!lease.allowed) {
        return reply.code(200).send({
          outcome: "PENDING",
          summary: null,
          message: "A check is already running for this account.",
        });
      }

      const summary = await reconcileBillingAccount({ account });

      auditBillingAction(req, {
        userId,
        action: "billing.account_reconciled",
        outcome: "success",
        metadata: {
          accountType: account.type,
          result: summary.outcome,
          checked: summary.checked,
          creditsRestored: summary.creditsRestored,
          paymentsRecorded: summary.paymentsRecorded,
          subscriptionsUpdated: summary.subscriptionsUpdated,
        },
      });

      // Counts and categories only. Nothing here can carry a provider id, a
      // provider error string or a disputed amount, because the surface
      // renders it verbatim.
      return reply.code(200).send({ outcome: summary.outcome, summary });
    },
  );

  /**
   * BILLING SURFACE CORRECTION (2026-08-29) — ONE pending payment, re-checked.
   *
   * Distinct from the account-wide reconcile above, which sweeps every binding
   * and repairs entitlements. This asks the provider about the single
   * transaction the customer is looking at, and answers with what that row is
   * now — which is what a person staring at a months-old "Pending" line
   * actually wants.
   *
   * It is a READ at the provider. No session is created, nothing is charged,
   * and the only local write is the status transition the shared rules permit.
   */
  app.post(
    "/v1/billing/accounts/:type/:id/payments/:paymentId/recheck",
    { preHandler: requireAuthAndLegal },
    async (req, reply) => {
      const userId = getAuthUserId(req);
      const params = z
        .object({
          type: z.enum(["PERSONAL", "ORGANIZATION"]),
          id: z.string().min(1).max(200),
          paymentId: z.string().uuid(),
        })
        .safeParse(req.params ?? {});
      if (!params.success) {
        return reply.code(400).send({ error: { code: "invalid_params" } });
      }

      const account = await assertBillingCapability({
        viewerUserId: userId,
        type: params.data.type,
        id: params.data.id,
        capability: "BILLING_HISTORY_VIEW",
      });

      // Bounded per payer. A provider read is cheap but not free, and a page
      // with twenty pending rows must not become twenty provider calls a
      // second.
      const rate = await enforceRateLimit({
        key: `ratelimit:billing_payment_recheck:${userId}`,
        max: 20,
        windowSec: 300,
      });
      if (!rate.allowed) {
        return reply.code(429).send(
          createErrorResponse(
            ErrorCode.RATE_LIMIT_EXCEEDED,
            req.id,
            undefined,
            "Payments have been re-checked several times just now. Please try again in a few minutes.",
          ),
        );
      }

      const result = await recheckPayment({
        account,
        paymentId: params.data.paymentId,
        viewerMayCancel: account.capabilities.includes("BILLING_CANCEL"),
      });

      auditBillingAction(req, {
        userId,
        action: "billing.payment_rechecked",
        outcome: "success",
        metadata: {
          accountType: account.type,
          result: result.outcome,
          status: result.status,
        },
      });

      return reply.code(200).send(result);
    },
  );

  /**
   * Stop ONE unsettled payment at the provider.
   *
   * BILLING_CANCEL, not BILLING_HISTORY_VIEW: stopping a payment is a
   * financial act, and a viewer who may read the history is not thereby
   * allowed to change what the provider does.
   *
   * The service refuses unless the provider has a real operation for it, so a
   * PayPal row cannot reach a local "cancelled" state that PayPal never
   * agreed to.
   */
  app.post(
    "/v1/billing/accounts/:type/:id/payments/:paymentId/cancel",
    { preHandler: requireAuthAndLegal },
    async (req, reply) => {
      const userId = getAuthUserId(req);
      const params = z
        .object({
          type: z.enum(["PERSONAL", "ORGANIZATION"]),
          id: z.string().min(1).max(200),
          paymentId: z.string().uuid(),
        })
        .safeParse(req.params ?? {});
      if (!params.success) {
        return reply.code(400).send({ error: { code: "invalid_params" } });
      }

      const account = await assertBillingCapability({
        viewerUserId: userId,
        type: params.data.type,
        id: params.data.id,
        capability: "BILLING_CANCEL",
      });

      const result = await cancelPendingPayment({
        account,
        paymentId: params.data.paymentId,
      });

      auditBillingAction(req, {
        userId,
        action: "billing.payment_cancelled",
        outcome: "success",
        metadata: {
          accountType: account.type,
          result: result.outcome,
          status: result.status,
        },
      });

      return reply.code(200).send(result);
    },
  );

  app.post(
    "/v1/billing/checkout/stripe",
    { preHandler: requireAuthAndLegal },
    async (req, reply) => {
      const body = CheckoutBody.parse(req.body);
      const userId = getAuthUserId(req);

      assertPurchasablePlan(body.plan);
      assertSelfServicePlan(body.plan);
      assertCheckoutTarget({
        plan: body.plan,
        teamId: body.teamId,
      });
      // A checkout is for someone who has nothing live. Anyone who does has a
      // plan CHANGE, which goes to the provider's own subscription API.
      const duplicate = await duplicateSubscriptionRefusal(userId, body.plan);
      if (duplicate) return reply.code(409).send(duplicate);

      // PHASE 10 §13.2 STEP 6 — deny personal (no-teamId) checkout for managed
      // identities BEFORE creating any provider session.
      await assertPersonalCheckoutAllowed(userId, body.teamId);

      // BILLING COMMERCIAL CORRECTNESS (2026-08-27) — capability, not just
      // ownership. `assertOwnedTeamForCheckout` answered "are you
      // Team.ownerUserId", which is one specific way of holding billing
      // authority rather than the question itself.
      await assertBillingCapability({
        viewerUserId: userId,
        // BILLING PERSONAL/ORGANIZATION MODEL (2026-08-28) — the subject is
        // the PERSONAL account, always. A `teamId` in the body used to select
        // an Owned Workspace as the payer, which is how TEAM became a
        // purchase for a different workspace instead of an upgrade of this one.
        type: "PERSONAL",
        id: userId,
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

  /**
   * BILLING PRODUCTION CLOSURE (2026-08-27) — buy evidence credits.
   *
   * Its own route because it is its own product. The client sends a display
   * currency and nothing else: no plan, no amount, no quantity, no billing
   * subject. Everything commercial is resolved server-side from
   * `EVIDENCE_CREDIT_PRODUCT` and the server price map, so there is no field
   * on the wire a caller could tamper with to buy credits cheaply or in bulk.
   */
  /**
   * BILLING DEPENDENT-CANCELLATION CONVERGENCE (2026-08-27) — retry ONLY the
   * outstanding storage add-on cancellations.
   *
   * Deliberately its own route rather than re-showing the base Cancel button.
   * Re-running a base cancellation to reach a dependent retry would ask the
   * provider to cancel a subscription it has already cancelled, and would
   * present the customer with a control that says it will do something it has
   * already done.
   *
   * It takes the ACCOUNT in the path and nothing else: no add-on id, no
   * provider reference, no amount. The server resolves the obligations IT
   * recorded and retries exactly those — never the base subscription, and
   * never an add-on whose cancellation the provider has already confirmed.
   */
  app.post(
    "/v1/billing/accounts/:type/:id/retry-storage-cancellation",
    { preHandler: requireAuthAndLegal },
    async (req, reply) => {
      const userId = getAuthUserId(req);
      const params = z
        .object({
          type: z.enum(["PERSONAL", "ORGANIZATION"]),
          id: z.string().min(1).max(200),
        })
        .safeParse(req.params ?? {});
      if (!params.success) {
        return reply.code(400).send({ error: { code: "invalid_params" } });
      }

      // Stopping a recurring charge is a financial mutation, so it takes the
      // CANCEL capability — the same one the original cancellation took. A
      // workspace administrator who is not the payer may see that an add-on is
      // still billing and may not act on the payer's provider account.
      const account = await assertBillingCapability({
        viewerUserId: userId,
        type: params.data.type,
        id: params.data.id,
        capability: "BILLING_CANCEL",
      });

      const rate = await enforceRateLimit({
        key: `ratelimit:billing_addon_retry:${userId}:${account.type}:${account.id}`,
        max: 6,
        windowSec: 300,
      });
      if (!rate.allowed) {
        return reply.code(429).send(
          createErrorResponse(
            ErrorCode.RATE_LIMIT_EXCEEDED,
            req.id,
            undefined,
            "We are already retrying. Please give it a few minutes.",
          ),
        );
      }

      // An ORGANIZATION account is contract-managed and owns no self-service
      // add-on, so there is nothing for it to retry.
      if (account.type === "ORGANIZATION") {
        return reply
          .code(200)
          .send({ outcome: "NO_CHANGE", summary: null, supportRequired: false });
      }

      const scope =
        account.type === "PERSONAL"
          ? { ownerUserId: account.id, teamId: null as string | null }
          : await (async () => {
              const row = await prisma.workspaceStorageAddon.findFirst({
                where: { teamId: account.id },
                select: { ownerUserId: true },
              });
              return row
                ? { ownerUserId: row.ownerUserId, teamId: account.id }
                : null;
            })();

      if (!scope) {
        return reply
          .code(200)
          .send({ outcome: "NO_CHANGE", summary: null, supportRequired: false });
      }

      const attempt = await attemptDependentCancellations({
        ownerUserId: scope.ownerUserId,
        teamId: scope.teamId,
      });
      const summary = await summarizeDependentCancellations(scope);

      auditBillingAction(req, {
        userId,
        action: "billing.storage_addon_cancellation_retry",
        outcome: "success",
        metadata: {
          accountType: account.type,
          attempted: attempt.attempted,
          confirmed: attempt.confirmed,
          failed: attempt.failed,
          escalated: attempt.escalated,
        },
      });

      return reply.code(200).send({
        outcome: summary
          ? summary.supportRequired
            ? "ACTION_REQUIRED"
            : "PENDING"
          : "UPDATED",
        summary,
        supportRequired: summary?.supportRequired ?? false,
      });
    },
  );

  app.post(
    "/v1/billing/credits/checkout/stripe",
    { preHandler: requireAuthAndLegal },
    async (req, reply) => {
      const body = EvidenceCreditCheckoutBody.parse(req.body ?? {});
      const userId = getAuthUserId(req);

      await assertPersonalCheckoutAllowed(userId, undefined);
      await assertBillingCapability({
        viewerUserId: userId,
        type: "PERSONAL",
        id: userId,
        capability: "BILLING_ADDON_PURCHASE",
      });

      const result = await createStripeEvidenceCreditCheckout({
        userId,
        currency: body.currency,
      });

      auditBillingAction(req, {
        userId,
        action: "billing.evidence_credit_checkout_created",
        outcome: "success",
        resourceId: String(result.session?.id ?? ""),
        providerEventId: result.session?.id ? String(result.session.id) : null,
        metadata: {
          productKey: EVIDENCE_CREDIT_PRODUCT.productKey,
          credits: EVIDENCE_CREDIT_PRODUCT.creditsGrantedPerPurchase,
          currency: result.currency,
          amountCents: result.amountCents,
        },
      });

      return reply.code(200).send({
        provider: "STRIPE",
        mode: result.mode,
        session: result.session,
      });
    },
  );

  /** PayPal counterpart. Same server-owned product identity. */
  app.post(
    "/v1/billing/credits/checkout/paypal",
    { preHandler: requireAuthAndLegal },
    async (req, reply) => {
      const body = EvidenceCreditCheckoutBody.parse(req.body ?? {});
      const userId = getAuthUserId(req);

      await assertPersonalCheckoutAllowed(userId, undefined);
      await assertBillingCapability({
        viewerUserId: userId,
        type: "PERSONAL",
        id: userId,
        capability: "BILLING_ADDON_PURCHASE",
      });

      const result = await createPayPalEvidenceCreditCheckout({
        userId,
        currency: body.currency,
      });

      auditBillingAction(req, {
        userId,
        action: "billing.evidence_credit_checkout_created",
        outcome: "success",
        metadata: {
          productKey: EVIDENCE_CREDIT_PRODUCT.productKey,
          credits: EVIDENCE_CREDIT_PRODUCT.creditsGrantedPerPurchase,
          currency: result.currency,
          amountCents: result.amountCents,
        },
      });

      return reply.code(200).send({
        provider: "PAYPAL",
        mode: result.mode,
        order: "order" in result ? result.order : undefined,
      });
    },
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
        // BILLING PERSONAL/ORGANIZATION MODEL (2026-08-28) — the subject is
        // the PERSONAL account, always. A `teamId` in the body used to select
        // an Owned Workspace as the payer, which is how TEAM became a
        // purchase for a different workspace instead of an upgrade of this one.
        type: "PERSONAL",
        id: userId,
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
      assertSelfServicePlan(body.plan);
      assertCheckoutTarget({
        plan: body.plan,
        teamId: body.teamId,
      });
      // A checkout is for someone who has nothing live. Anyone who does has a
      // plan CHANGE, which goes to the provider's own subscription API.
      const duplicate = await duplicateSubscriptionRefusal(userId, body.plan);
      if (duplicate) return reply.code(409).send(duplicate);

      // PHASE 10 §13.2 STEP 6 — deny personal (no-teamId) checkout for managed
      // identities BEFORE creating any provider session.
      await assertPersonalCheckoutAllowed(userId, body.teamId);

      // BILLING COMMERCIAL CORRECTNESS (2026-08-27) — capability, not just
      // ownership. `assertOwnedTeamForCheckout` answered "are you
      // Team.ownerUserId", which is one specific way of holding billing
      // authority rather than the question itself.
      await assertBillingCapability({
        viewerUserId: userId,
        // BILLING PERSONAL/ORGANIZATION MODEL (2026-08-28) — the subject is
        // the PERSONAL account, always. A `teamId` in the body used to select
        // an Owned Workspace as the payer, which is how TEAM became a
        // purchase for a different workspace instead of an upgrade of this one.
        type: "PERSONAL",
        id: userId,
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
        // BILLING PERSONAL/ORGANIZATION MODEL (2026-08-28) — the subject is
        // the PERSONAL account, always. A `teamId` in the body used to select
        // an Owned Workspace as the payer, which is how TEAM became a
        // purchase for a different workspace instead of an upgrade of this one.
        type: "PERSONAL",
        id: userId,
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

      // BILLING PERSONAL/ORGANIZATION MODEL (2026-08-28) — the dev route sets
      // the PERSONAL plan, for every tier.
      //
      // It used to fork: TEAM activated a workspace's commercial state and
      // demanded a `teamId`, everything else wrote the personal entitlement.
      // That fork was the obsolete model in the one place a developer sets up a
      // local account — so a dev could not put themselves on TEAM without
      // first creating a workspace, and the state they ended up in was not the
      // state a real customer would have.
      //
      // `setPersonalPlan` now accepts TEAM, so all three self-service tiers go
      // through one writer.
      if (body.teamId) {
        return reply.code(400).send({
          message:
            "A plan applies to your Personal Workspace; it does not take a workspace target",
        });
      }

      // PHASE 10 §13.2 STEP 6 (2026-07-23) — dev-only direct personal-plan
      // change is still a personal-scope mutation; deny for managed
      // identities before the plan write (defense-in-depth alongside the
      // checkout-provider guards above; this route is 403'd in production).
      await assertPersonalCheckoutAllowed(userId, undefined);

      await setPersonalPlan(userId, body.plan);

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
}