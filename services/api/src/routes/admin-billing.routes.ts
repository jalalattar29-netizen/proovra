import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { prisma } from "../db.js";
import { createErrorResponse, ErrorCode } from "../errors.js";
import { requirePlatformAdmin } from "../middleware/require-platform-admin.js";

/**
 * Platform Control Center P1 — Billing & Revenue detail aggregate.
 *
 * READ-ONLY aggregation over EXISTING billing models. This plugin touches NO
 * checkout / webhook / entitlement logic. It reads and projects:
 *   - Subscription           (status + plan mix + renewal pressure)
 *   - Payment                (gross revenue REUSING the analytics computation,
 *                             failed-payment list/count, recent events)
 *   - StripeWebhookEvent     (processingStatus → honest health)
 *   - PaypalWebhookEvent     (processingStatus → honest health)
 *   - WorkspaceStorageAddon  (active add-on count + MRR contribution)
 *
 * HONESTY CONTRACT:
 *   - MRR / ARR are computed ONLY from amounts that are actually modelled.
 *     `Subscription` has NO amount column in the schema, so subscription MRR is
 *     NOT safely derivable and is returned as `null` → the UI renders
 *     "Not measured". `WorkspaceStorageAddon` DOES model `amountCents` +
 *     `billingCycle`, so an add-on MRR contribution IS derivable and returned
 *     as a real number (labelled as storage-addon MRR, not total MRR).
 *   - Gross revenue reuses the EXACT computation from analytics.routes.ts
 *     (sum of amountCents for SUCCEEDED payments, grouped by status).
 *   - Webhook status is honest: healthy / degraded / not-connected based on
 *     REAL processingStatus rows. Zero rows → "not-connected".
 *   - NO card credentials, NO Stripe secrets, NO customer PII beyond email.
 *     Payment rows expose only id/provider/amount/currency/status/createdAt +
 *     the owning user's email (email is the single permitted PII field).
 */

const detailQuerySchema = z.object({
  failedLimit: z.coerce.number().int().min(1).max(100).optional().default(25),
  recentLimit: z.coerce.number().int().min(1).max(100).optional().default(25),
  // Days ahead to consider a subscription's currentPeriodEnd as "renewal
  // pressure". Bounded so an operator can widen/narrow the window.
  renewalWindowDays: z.coerce
    .number()
    .int()
    .min(1)
    .max(120)
    .optional()
    .default(14),
});

type WebhookHealth = "healthy" | "degraded" | "not-connected";

type WebhookStatus = {
  provider: "STRIPE" | "PAYPAL";
  health: WebhookHealth;
  total: number;
  failed: number;
  lastReceivedAt: string | null;
};

/**
 * Derive an honest webhook-health verdict from processingStatus counts.
 *   - not-connected  no rows have ever been received.
 *   - degraded       at least one row is in a failed/error processing state.
 *   - healthy        rows received, none failed.
 */
function deriveWebhookHealth(total: number, failed: number): WebhookHealth {
  if (total === 0) return "not-connected";
  if (failed > 0) return "degraded";
  return "healthy";
}

// processingStatus is a free VARCHAR (default "RECEIVED"). Anything that reads
// as an error/failure state is counted as a failure for the health verdict.
function isFailedProcessingStatus(status: string): boolean {
  const v = status.trim().toUpperCase();
  return (
    v === "FAILED" ||
    v === "ERROR" ||
    v === "ERRORED" ||
    v === "DEAD_LETTER" ||
    v === "REJECTED" ||
    v === "FAILED_PERMANENT"
  );
}

// TENANT_SCOPE_EXCEPTION: platform_admin_global -- every route in this plugin is
// gated by requirePlatformAdmin and reads GLOBAL cross-tenant aggregates. It is
// intentionally NOT scoped to a single tenant; the platform-admin gate IS the
// authorization boundary. No per-tenant authorizeOrFail applies here.
export async function adminBillingRoutes(app: FastifyInstance) {
  app.get(
    "/v1/admin/billing/detail",
    { preHandler: requirePlatformAdmin },
    async (req, reply) => {
      const parsed = detailQuerySchema.safeParse(req.query ?? {});
      if (!parsed.success) {
        return reply.code(400).send(
          createErrorResponse(
            ErrorCode.VALIDATION_ERROR,
            req.id,
            { reason: parsed.error.message },
            "Invalid billing detail query"
          )
        );
      }

      const { failedLimit, recentLimit, renewalWindowDays } = parsed.data;

      const now = new Date();
      const renewalWindowEnd = new Date(
        now.getTime() + renewalWindowDays * 24 * 60 * 60 * 1000
      );

      const [
        subscriptionsByStatus,
        subscriptionsByPlan,
        paymentsGrouped,
        failedPayments,
        recentPayments,
        stripeWebhookGroups,
        stripeLast,
        paypalWebhookGroups,
        paypalLast,
        activeStorageAddons,
        renewalPressureRows,
      ] = await Promise.all([
        prisma.subscription.groupBy({
          by: ["status"],
          _count: { status: true },
        }),
        prisma.subscription.groupBy({
          by: ["plan"],
          _count: { plan: true },
        }),
        // REUSE the analytics gross-revenue computation shape exactly.
        prisma.payment.groupBy({
          by: ["status"],
          _count: { status: true },
          _sum: { amountCents: true },
        }),
        prisma.payment.findMany({
          where: { status: "FAILED" },
          orderBy: [{ createdAt: "desc" }],
          take: failedLimit,
          select: {
            id: true,
            provider: true,
            amountCents: true,
            currency: true,
            status: true,
            createdAt: true,
            user: { select: { email: true } },
            // NOTE: providerPaymentId (provider credential) DELIBERATELY omitted.
          },
        }),
        prisma.payment.findMany({
          orderBy: [{ createdAt: "desc" }],
          take: recentLimit,
          select: {
            id: true,
            provider: true,
            amountCents: true,
            currency: true,
            status: true,
            createdAt: true,
            user: { select: { email: true } },
          },
        }),
        prisma.stripeWebhookEvent.groupBy({
          by: ["processingStatus"],
          _count: { processingStatus: true },
        }),
        prisma.stripeWebhookEvent.findFirst({
          orderBy: [{ receivedAt: "desc" }],
          select: { receivedAt: true },
        }),
        prisma.paypalWebhookEvent.groupBy({
          by: ["processingStatus"],
          _count: { processingStatus: true },
        }),
        prisma.paypalWebhookEvent.findFirst({
          orderBy: [{ receivedAt: "desc" }],
          select: { receivedAt: true },
        }),
        // Storage add-on MRR is DERIVABLE — amountCents + billingCycle exist.
        prisma.workspaceStorageAddon.findMany({
          where: { status: "ACTIVE" },
          select: {
            id: true,
            amountCents: true,
            currency: true,
            billingCycle: true,
            addonKey: true,
          },
        }),
        prisma.subscription.findMany({
          where: {
            status: { in: ["ACTIVE", "TRIALING", "PAST_DUE"] },
            currentPeriodEnd: { gte: now, lte: renewalWindowEnd },
          },
          orderBy: [{ currentPeriodEnd: "asc" }],
          take: 100,
          select: {
            id: true,
            plan: true,
            status: true,
            currentPeriodEnd: true,
          },
        }),
      ]);

      // ---- Subscription status counts (real) --------------------------------
      const subscriptionStatus: Record<string, number> = {
        ACTIVE: 0,
        TRIALING: 0,
        PAST_DUE: 0,
        CANCELED: 0,
      };
      for (const g of subscriptionsByStatus) {
        const key = String(g.status).toUpperCase();
        if (key in subscriptionStatus) subscriptionStatus[key] = g._count.status;
      }
      const activeSubscriptions = subscriptionStatus.ACTIVE;

      // ---- Plan mix (real) --------------------------------------------------
      const planMix: Record<string, number> = {
        FREE: 0,
        PAYG: 0,
        PRO: 0,
        TEAM: 0,
        ENTERPRISE: 0,
      };
      for (const g of subscriptionsByPlan) {
        const key = String(g.plan).toUpperCase();
        if (key in planMix) planMix[key] = g._count.plan;
      }

      // ---- Gross revenue + payment counts (REUSED analytics computation) ----
      let grossRevenueCents = 0;
      let successfulPayments = 0;
      let failedPaymentCount = 0;
      let refundedPayments = 0;
      const revenueCurrencies = new Set<string>();
      for (const row of paymentsGrouped) {
        if (row.status === "SUCCEEDED") {
          successfulPayments = row._count.status;
          grossRevenueCents += row._sum.amountCents ?? 0;
        }
        if (row.status === "FAILED") failedPaymentCount = row._count.status;
        if (row.status === "REFUNDED") refundedPayments = row._count.status;
      }
      for (const p of recentPayments) {
        if (p.currency) revenueCurrencies.add(p.currency.toUpperCase());
      }

      // ---- MRR / ARR — HONEST derivation ------------------------------------
      // Subscription rows carry NO amount, so subscription MRR/ARR is NOT
      // safely derivable → null ("Not measured"). Storage add-ons DO model an
      // amount + billing cycle, so their MRR contribution is a REAL number.
      // Only MONTHLY add-ons are recurring revenue. ONE_TIME add-ons are
      // excluded from MRR (they are not recurring). `amountCents` is the REAL
      // billed amount, so this contribution is a true derived number.
      let storageMrrAccum = 0;
      for (const a of activeStorageAddons) {
        if (a.amountCents == null) continue;
        if (a.billingCycle === "MONTHLY") {
          storageMrrAccum += a.amountCents;
        }
      }
      const storageAddonMrrCents: number = storageMrrAccum;

      // Subscription MRR / ARR: not derivable from the current schema.
      const subscriptionMrrCents: number | null = null;
      const subscriptionArrCents: number | null = null;

      // ---- Webhook health (honest, from real processingStatus rows) ---------
      function summariseWebhook(
        provider: "STRIPE" | "PAYPAL",
        groups: Array<{
          processingStatus: string;
          _count: { processingStatus: number };
        }>,
        last: { receivedAt: Date } | null
      ): WebhookStatus {
        let total = 0;
        let failed = 0;
        for (const g of groups) {
          total += g._count.processingStatus;
          if (isFailedProcessingStatus(g.processingStatus)) {
            failed += g._count.processingStatus;
          }
        }
        return {
          provider,
          health: deriveWebhookHealth(total, failed),
          total,
          failed,
          lastReceivedAt: last?.receivedAt?.toISOString() ?? null,
        };
      }

      const stripeWebhookStatus = summariseWebhook(
        "STRIPE",
        stripeWebhookGroups,
        stripeLast
      );
      const paypalWebhookStatus = summariseWebhook(
        "PAYPAL",
        paypalWebhookGroups,
        paypalLast
      );

      // ---- Project payment rows (operator-safe; email is the ONLY PII) ------
      const projectPayment = (p: {
        id: string;
        provider: string;
        amountCents: number;
        currency: string;
        status: string;
        createdAt: Date;
        user: { email: string | null } | null;
      }) => ({
        id: p.id,
        provider: p.provider,
        amountCents: p.amountCents,
        currency: p.currency,
        status: p.status,
        createdAt: p.createdAt.toISOString(),
        userEmail: p.user?.email ?? null,
      });

      const renewalPressure = renewalPressureRows.map((s) => ({
        id: s.id,
        plan: s.plan,
        status: s.status,
        currentPeriodEnd: s.currentPeriodEnd
          ? s.currentPeriodEnd.toISOString()
          : null,
      }));

      return reply.code(200).send({
        activeSubscriptions,
        subscriptionStatus,
        planMix,
        revenue: {
          grossRevenueCents,
          currencies: Array.from(revenueCurrencies),
          successfulPayments,
          failedPayments: failedPaymentCount,
          refundedPayments,
        },
        // MRR / ARR — explicitly honest. `subscription*` is null (not
        // derivable); `storageAddonMrrCents` is a real derived number.
        mrr: {
          subscriptionMrrCents,
          subscriptionArrCents,
          storageAddonMrrCents,
          derivable: subscriptionMrrCents != null,
          note:
            subscriptionMrrCents == null
              ? "Subscription MRR/ARR is not measured — Subscription rows do not carry a billed amount. Only the storage add-on MRR contribution is derivable."
              : null,
        },
        failedPayments: {
          count: failedPaymentCount,
          items: failedPayments.map(projectPayment),
        },
        recentPaymentEvents: recentPayments.map(projectPayment),
        stripeWebhookStatus,
        paypalWebhookStatus,
        storageAddons: {
          activeCount: activeStorageAddons.length,
          mrrContributionCents: storageAddonMrrCents,
        },
        renewalPressure: {
          windowDays: renewalWindowDays,
          count: renewalPressure.length,
          items: renewalPressure,
        },
      });
    }
  );
}

export default adminBillingRoutes;
