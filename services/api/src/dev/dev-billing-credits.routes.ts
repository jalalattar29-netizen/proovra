/**
 * Dev/test-only direct credit grant.
 *
 *   POST /v1/billing/credits   { credits: <positive int> }
 *
 * PHASE 12 CAPABILITY-PRESERVATION AUDIT (2026-07-28) — this is a no-payment,
 * self-service credit grant with ZERO commercial capability. It exists only so
 * dev/test flows can top up credits without a real Stripe/PayPal checkout. It
 * MUST NOT exist as a product route: an authenticated self-grant credit path in
 * production is a security hole. It previously lived in `routes/billing.routes.ts`
 * guarded by a production 403; it now lives here under `src/dev/` and is mounted
 * ONLY inside the dev-auth boundary — production route registration = 0.
 *
 * HARD SAFETY (mirrors dev-login.ts):
 *   1. The plugin is only REGISTERED when `devAuthEnabled()` is true
 *      (NODE_ENV !== "production" AND DEV_AUTH_ENABLED === "true"), see server.ts.
 *   2. The handler re-checks `devAuthEnabled()` and 404s otherwise, so even a
 *      mis-registration in production is inert.
 *   3. It lives under `src/dev/` (NOT `src/routes/`), so the route-inventory /
 *      coverage guards intentionally do not enumerate it as a product surface.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { getAuthUserId } from "../auth.js";
import { requireAuth } from "../middleware/auth.js";
import { requireLegalAcceptance } from "../middleware/require-legal-acceptance.js";
import * as prismaPkg from "@prisma/client";
import { grantEvidenceCredits } from "../services/billing/evidence-credits.service.js";
import { emitPlatformAudit } from "../services/audit/tenant-audit.service.js";
import { devAuthEnabled } from "./dev-login.js";

export async function devBillingCreditsRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.post(
    "/v1/billing/credits",
    { preHandler: [requireAuth, requireLegalAcceptance] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      // Layer 2 — refuse even if somehow registered in production.
      if (!devAuthEnabled()) {
        return reply.code(404).send({ error: { code: "not_found" } });
      }
      const body = z
        .object({ credits: z.number().int().positive() })
        .parse(req.body);
      const userId = getAuthUserId(req);

      // BILLING COMMERCIAL CORRECTNESS (2026-08-27) — the dev grant goes
      // through the same canonical wallet as a real purchase, so a
      // dev-granted credit is spendable and auditable in exactly the same way
      // and this route cannot drift from the production path. The synthetic
      // provider ref keeps the grant idempotent per request.
      await grantEvidenceCredits({
        userId,
        credits: body.credits,
        provider: prismaPkg.PaymentProvider.STRIPE,
        providerRef: `dev-grant:${userId}:${req.id ?? "no-request-id"}`,
      });

      // The grant is still audited — a dev boundary is not an audit exemption.
      await emitPlatformAudit({
        action: "billing.credits_added",
        outcome: "success",
        sourceApp: "API",
        actorUserId: userId,
        resourceType: "billing_credit",
        resourceId: null,
        correlationId: req.id ?? null,
        metadata: { credits: body.credits, devOnly: true },
      });

      return reply.code(200).send({ ok: true });
    },
  );
}
