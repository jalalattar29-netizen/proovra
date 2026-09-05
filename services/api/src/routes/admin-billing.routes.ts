import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { createErrorResponse, ErrorCode } from "../errors.js";
import { getAuthUserId } from "../auth.js";
import { requirePlatformAdmin } from "../middleware/require-platform-admin.js";
import { prisma } from "../db.js";
import { buildAdminBillingDetail } from "../services/admin/billing.service.js";
import { emitPlatformAudit } from "../services/audit/tenant-audit.service.js";
import { ensureEntitlement } from "../services/billing.service.js";
import {
  grantEvidenceCreditsByPlatformAdmin,
  readEvidenceCreditWallet,
} from "../services/billing/evidence-credits.service.js";

/**
 * Platform Control Center — Billing & Revenue (ADM-012, ADM-016, ADM-030, ADM-032).
 *
 * REWRITTEN 2026-08-27. The previous implementation was accurate about money
 * and useless about people: its renewal-pressure rows carried no customer at
 * all, its failed-payment rows carried an email but no id to open, and
 * `cancelAtPeriodEnd` was never selected anywhere — so a subscriber who had
 * already left rendered as an ordinary ACTIVE one.
 *
 * All aggregation now lives in `services/admin/billing.service.ts`, so the
 * READ route is a validator and a projection boundary. It touches no checkout
 * or webhook logic.
 *
 * ONE MUTATION LIVES HERE, added deliberately: the platform-admin evidence
 * credit grant. It is here rather than on a page of its own because this is
 * already the Platform Control Center's billing surface, and a support
 * remediation belongs beside the account state that prompted it. It writes
 * through the CANONICAL wallet service and constructs no ledger row itself.
 *
 * ONE endpoint, deliberately. An earlier draft added
 * `GET /v1/admin/billing/reconciliation` as a lighter read, but `billing/detail`
 * already returns the same `reconciliation` block — a second route projecting a
 * subset of one aggregate is the parallel surface this remediation exists to
 * remove, and the capability analyzer correctly reported it as a registered
 * route with no consumer.
 *
 * TENANT_SCOPE_EXCEPTION: platform_admin_global -- gated by
 * requirePlatformAdmin, which IS the authorization boundary for this
 * cross-tenant read. No per-tenant authorizeOrFail applies.
 */

/**
 * What an operator supplies, and nothing more.
 *
 * The server decides the ledger entry type, the reference format and the
 * balance arithmetic — a request cannot construct a ledger row. `credits` is
 * bounded and positive: there is no negative grant here, because taking
 * credits back is a REVERSAL, a different movement with different rules, and
 * expressing it as a negative grant would make one code path able to both
 * refund and confiscate.
 */
const grantBodySchema = z.object({
  userId: z.string().uuid(),
  credits: z.number().int().min(1).max(500),
  /** Why. Recorded in the audit trail; required, because "no reason" is not one. */
  reason: z.string().trim().min(3).max(500),
  /**
   * The operator's own reference for this grant — a ticket id, an incident id.
   * Required: a retry that cannot be recognised is a double credit, and UI
   * double-click prevention is not correctness.
   */
  idempotencyKey: z.string().trim().min(3).max(120),
});

const detailQuerySchema = z.object({
  renewalWindowDays: z.coerce.number().int().min(1).max(120).optional().default(14),
  attentionLimit: z.coerce.number().int().min(1).max(200).optional().default(50),
});

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

      const detail = await buildAdminBillingDetail({
        renewalWindowDays: parsed.data.renewalWindowDays,
        attentionLimit: parsed.data.attentionLimit,
      });

      return reply.code(200).send(detail);
    }
  );


  // =========================================================================
  // POST /v1/admin/billing/evidence-credits
  //
  // Grant evidence credits to an existing PERSONAL account.
  //
  // WHY THIS EXISTS. The wallet had one way to gain credits — a completed
  // Stripe or PayPal payment — so support remediation, goodwill and controlled
  // internal testing had no mechanism. The workaround for that is always the
  // same: write a PURCHASE row. That puts a payment that never happened into
  // the one table whose purpose is to prove where every credit came from, and
  // the customer's own billing history reads it.
  //
  // WHAT IT IS NOT. It grants credits and nothing else: no plan change, no
  // limit change, no exemption, no unlimited flag. The granted credit is
  // admitted and spent by exactly the same authorities a bought one is —
  // allowance first, then one credit at completion — on Capture, on Personal
  // External Intake, and on any other personal creation surface.
  //
  // TENANT_SCOPE_EXCEPTION: platform_admin_global -- gated by
  // requirePlatformAdmin, which IS the authorization boundary for this
  // cross-tenant write. No per-tenant authorizeOrFail applies: the subject is
  // a PERSONAL account, not a workspace, and no workspace role — OWNER, ADMIN,
  // billing manager or organization admin — carries this authority.
  // =========================================================================
  app.post(
    "/v1/admin/billing/evidence-credits",
    { preHandler: requirePlatformAdmin },
    async (req, reply) => {
      const parsed = grantBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply
          .code(400)
          .send(
            createErrorResponse(
              ErrorCode.VALIDATION_ERROR,
              req.id,
              { fields: parsed.error.issues.map((i) => i.path.join(".")) },
              "Invalid credit grant request",
            ),
          );
      }
      const body = parsed.data;
      const actorUserId = getAuthUserId(req);

      /*
       * The target must exist. Resolved by id only
       * — never by email — so an operator cannot grant to whoever happens to
       * hold an address today, and so the audit row names a stable subject.
       */
      const target = await prisma.user.findUnique({
        where: { id: body.userId },
        select: { id: true },
      });
      if (!target) {
        return reply
          .code(404)
          .send(
            createErrorResponse(
              ErrorCode.USER_NOT_FOUND,
              req.id,
              undefined,
              "No such account",
            ),
          );
      }

      // The wallet's own reader, before and after, so the audit records the
      // movement rather than an assumption about it.
      await ensureEntitlement(target.id);
      const before = await readEvidenceCreditWallet(target.id);

      /*
       * THE IDEMPOTENCY KEY IS NAMESPACED BY TARGET, SERVER-SIDE.
       *
       * A bare client string would make one key mean one grant across the
       * whole platform, so two operators remediating two different customers
       * with the same obvious reference ("INC-1042") would silently give the
       * second one nothing. Binding the target to the key makes a retry for
       * THIS account idempotent while leaving other accounts unaffected, and
       * the uniqueness is enforced by a partial index rather than by this
       * check winning a race.
       */
      const grantRef = `${target.id}:${body.idempotencyKey}`;
      const result = await grantEvidenceCreditsByPlatformAdmin({
        userId: target.id,
        credits: body.credits,
        grantRef,
      });

      await emitPlatformAudit({
        action: "billing.evidence_credits_granted",
        outcome: "success",
        sourceApp: "API",
        actorUserId,
        resourceType: "billing_credit",
        resourceId: target.id,
        correlationId: req.id ?? null,
        metadata: {
          targetUserId: target.id,
          credits: body.credits,
          reason: body.reason,
          grantRef,
          previousBalance: before.availableCredits,
          resultingBalance: result.balanceAfter,
          // `false` is the honest record of a RETRY: the key already existed,
          // so this request moved nothing.
          applied: result.granted,
        },
      });

      return reply.code(200).send({
        userId: target.id,
        credits: body.credits,
        applied: result.granted,
        previousBalance: before.availableCredits,
        balanceAfter: result.balanceAfter,
        grantRef,
      });
    },
  );
}

export default adminBillingRoutes;
