import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { createErrorResponse, ErrorCode } from "../errors.js";
import { requirePlatformAdmin } from "../middleware/require-platform-admin.js";
import { buildAdminBillingDetail } from "../services/admin/billing.service.js";

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
 * route is a validator and a projection boundary. It touches NO checkout,
 * webhook or entitlement logic and performs no mutation.
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

}

export default adminBillingRoutes;
