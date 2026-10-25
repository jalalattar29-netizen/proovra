/**
 * POST /v1/internal/lifecycle/run — THE lifecycle tick, for the worker's
 * dedicated lifecycle sweep (members audit LIFE-11).
 *
 * Guarded by the integration cron secret like every other internal sweep. It
 * executes due account, organization and workspace closures and reaps any an
 * interrupted run left in PROCESSING (`runLifecycleTick`). Safe to call while
 * the digest run also calls it: every request row is claimed by a guarded
 * update and every closure leg is idempotent.
 *
 * TENANT_SCOPE_EXCEPTION: platform_admin_global — a secret-gated machine
 * endpoint with no caller identity; each closure request row carries its own
 * already-authorized subject (account, organization or workspace).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { requireIntegrationCronSecret } from "../middleware/cron-secret.js";
import { runLifecycleTick } from "../services/lifecycle/lifecycle-scheduler.service.js";

export async function internalLifecycleRoutes(app: FastifyInstance) {
  app.post("/v1/internal/lifecycle/run", async (req: FastifyRequest, reply: FastifyReply) => {
    const ok = await requireIntegrationCronSecret(req, reply);
    if (!ok) return;
    const summary = await runLifecycleTick(new Date());
    return reply.code(200).send({ summary });
  });
}
