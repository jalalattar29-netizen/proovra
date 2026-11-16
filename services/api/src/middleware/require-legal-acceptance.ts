import type { FastifyReply, FastifyRequest } from "fastify";
import {
  legalAcceptanceRequiredFor,
  refuseWithoutCurrentLegalAcceptance,
} from "./legal-acceptance-gate.js";

/**
 * The route-level form of the A1-06 rule, kept for the route files that name it
 * (`requireAuthAndLegal`). It applies the SAME decision `requireAuth` now makes
 * for every route: writes need the current terms, reads never do, and the
 * reviewed exemptions (cancel, export, close, revoke...) stay open. A request
 * `requireAuth` already proved current is not read twice.
 */
export async function requireLegalAcceptance(
  req: FastifyRequest,
  reply: FastifyReply
) {
  const userId = (req.user as { sub?: string } | undefined)?.sub;

  if (!userId) {
    return reply.code(401).send({
      error: {
        code: "UNAUTHORIZED",
        message: "Authentication required.",
        requestId: req.id,
      },
    });
  }

  const routePattern =
    (req as { routeOptions?: { url?: string } }).routeOptions?.url ?? null;
  if (!legalAcceptanceRequiredFor(req.method, routePattern, req.body)) return;

  await refuseWithoutCurrentLegalAcceptance(req, reply, userId);
}
