/**
 * Wave 1 Phase 3 — Producer-Mode Truth Resolver HTTP surface.
 *
 *   GET /v1/intelligence/capabilities?teamId=…
 *     → returns { producerModes: ProducerModeStatus[] }
 *
 * The endpoint is the SOLE truth-source UI surfaces consult to
 * decide whether OCR / transcript / perceptual_similarity /
 * derivative_detection / semantic_search producers are enabled,
 * configured, automatic, etc. UI MUST NOT read raw env vars.
 *
 * Hard contracts:
 *   * Read-only — never mutates state.
 *   * Permission: `intelligence.read` (any authenticated workspace
 *     member with intelligence read access).
 *   * Anti-enumeration safe — non-members get 404 on missing team.
 *   * NEVER returns raw env vars / secrets / credential bytes.
 *   * NEVER returns 5xx for resolver failure — the resolver itself
 *     never throws and collapses to NOT_CONFIGURED instead.
 *
 * No duplication contract:
 *   * The resolver itself lives in
 *     `packages/shared-runtime/src/media-intelligence/producer-mode.ts`
 *     and delegates to `probeAzureDocumentIntelligence`,
 *     `probeDeepgram`, `isSemanticReadyAtRuntime`,
 *     `resolveEmbeddingProviderFromEnv`. This route is a thin
 *     HTTP wrapper — it does NOT re-implement any probe logic.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { authorizeOrFail } from "../middleware/authorize.js";
import { resolveProducerModeStatuses } from "@proovra/shared-runtime/media-intelligence";

const TeamQuery = z.object({
  teamId: z.string().uuid(),
});

export async function intelligenceCapabilitiesRoutes(app: FastifyInstance) {
  app.get(
    "/v1/intelligence/capabilities",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { teamId } = TeamQuery.parse(req.query ?? {});
      const actor = await authorizeOrFail(req, reply, {
        teamId,
        permission: "intelligence.read",
        antiEnumeration: true,
      });
      if (!actor) return;

      const producerModes = await resolveProducerModeStatuses({
        teamId,
        prisma,
      });

      return reply.code(200).send({ producerModes });
    },
  );
}
