/**
 * A ROUTE THAT NAMES A RECORD ANSWERS TO THE RECORD RULE (RC-CASE-REACH).
 *
 * The audit's root cause was that reach is something every reader opts into, and
 * the routes written around a workspace gate never did: provenance, governance
 * status and holds, media intelligence, intelligence records, redaction, signer
 * attestations. Each checked the workspace and the permission, then served a
 * record the Evidence route conceals from the same caller.
 *
 * `installRecordReachGuard(app)` at the top of a route plugin reverses the
 * default for that file: every route it registers with `:evidenceId` or
 * `/evidence/:id` in its path gets the check, including routes added later. A
 * source gate (`record-reach-guard.contract.test.ts`) requires each route file
 * to either install it or be listed with the authority it uses instead.
 *
 * It runs last in the route's preHandlers, so the session is resolved by then,
 * and before the handler, so a custody-writing GET writes nothing. It decides
 * one thing, the case rule; membership and permission stay with the route's own
 * gate. A route with no signed-in user (portal and public token routes) has no
 * caller to apply it to and is left to its own token authority.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { getAuthUserId } from "../auth.js";
import { evidenceClosedTo } from "../services/access/record-reach.js";

const NAMES_A_RECORD = /(:evidenceId\b|\/evidence\/:id\b)/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Reads that answer an unknown record with an empty list, not a 404. A closed
 * record gets that same answer, or the difference would confirm it exists.
 */
const EMPTY_ANSWER: Readonly<Record<string, unknown>> = {
  "/v1/governance/lifecycle/evidence/:id/events": { events: [] },
  "/v1/intelligence/evidence/:evidenceId/records": { records: [] },
  "/v1/intelligence/evidence/:evidenceId/corrections": { corrections: [] },
  "/v1/redaction/videos/:evidenceId/frames": { frames: [] },
  "/v1/redaction/videos/:evidenceId/tracks": { tracks: [] },
};

function recordGuard(routeUrl: string) {
  return async function requireRecordReach(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    let userId: string;
    try {
      userId = getAuthUserId(req);
    } catch {
      return;
    }
    const params = (req.params ?? {}) as { evidenceId?: string; id?: string };
    const evidenceId = params.evidenceId ?? params.id;
    if (!evidenceId || !UUID.test(evidenceId)) return;
    if (!(await evidenceClosedTo(evidenceId, userId))) return;
    const empty = req.method === "GET" ? EMPTY_ANSWER[routeUrl] : undefined;
    if (empty) {
      await reply.code(200).send(empty);
      return;
    }
    await reply.code(404).send({ error: { code: "not_found" } });
  };
}

export function installRecordReachGuard(app: FastifyInstance): void {
  app.addHook("onRoute", (route) => {
    if (!NAMES_A_RECORD.test(route.url)) return;
    const existing = route.preHandler
      ? Array.isArray(route.preHandler)
        ? route.preHandler
        : [route.preHandler]
      : [];
    route.preHandler = [...existing, recordGuard(route.url)] as typeof route.preHandler;
  });
}
