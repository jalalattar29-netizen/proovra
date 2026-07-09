import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { createErrorResponse, ErrorCode } from "../errors.js";
import { requirePlatformAdmin } from "../middleware/require-platform-admin.js";
import { getCostDashboard } from "../services/admin/costs.service.js";

/**
 * Platform Control Center — Cost Dashboard (item G).
 *
 * READ-ONLY aggregation over EXISTING provider-cost models
 * (ProviderUsageEvent / ProviderBudget / ProviderBudgetAlert /
 * SemanticUsageDaily / EntitlementUsage). This plugin touches NO metering,
 * budget-enforcement, or entitlement logic — it only reads and projects.
 *
 * HONESTY CONTRACT (enforced in costs.service.ts):
 *   - All costs are ESTIMATED (from estimatedCostUsdMicros), never billed.
 *   - Provider costs are USD; embeddings spend is EUR (kept separate, never
 *     summed into the USD total).
 *   - Unmetered categories (storage $, bandwidth, infra, email, SMS) return
 *     explicit notConnected:true entries — no fabricated numbers.
 *   - NO API keys / secrets / tokens / env values are ever surfaced.
 */

const costsQuerySchema = z.object({
  windowDays: z.coerce.number().int().min(1).max(365).optional().default(30),
});

// TENANT_SCOPE_EXCEPTION: platform_admin_global -- every route in this plugin is
// gated by requirePlatformAdmin and reads GLOBAL cross-tenant aggregates. It is
// intentionally NOT scoped to a single tenant; the platform-admin gate IS the
// authorization boundary. No per-tenant authorizeOrFail applies here.
export async function adminCostsRoutes(app: FastifyInstance) {
  app.get(
    "/v1/admin/costs",
    { preHandler: requirePlatformAdmin },
    async (req, reply) => {
      const parsed = costsQuerySchema.safeParse(req.query ?? {});
      if (!parsed.success) {
        return reply.code(400).send(
          createErrorResponse(
            ErrorCode.VALIDATION_ERROR,
            req.id,
            { reason: parsed.error.message },
            "Invalid cost dashboard query"
          )
        );
      }

      const { windowDays } = parsed.data;
      const dashboard = await getCostDashboard(windowDays);
      return reply.code(200).send(dashboard);
    }
  );
}

export default adminCostsRoutes;
