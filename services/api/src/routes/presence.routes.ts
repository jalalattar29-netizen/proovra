/**
 * Phase G3 — Presence routes.
 *
 *   POST /v1/me/presence/heartbeat
 *   GET  /v1/me/presence/here?teamId&resourceKind&resourceId
 *
 * Backed by the in-process presence store. Workspace-scoped via the
 * existing TeamMember check so a viewer can never appear on a
 * resource they cannot see.
 *
 * Hard rules:
 *
 *   * Heartbeat is anonymous in the response sense — the backend
 *     never echoes IP/device/route history.
 *   * Listing viewers always excludes the caller (a reviewer
 *     doesn't need to see themselves in their own "here now" list).
 *   * No audit emission. Presence pings are explicitly NOT custody
 *     events — they are operational awareness, not auditable
 *     actions.
 *   * Bounded payload: the response is a small array of
 *     {userId, displayName, lastSeenAtUtc}.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { getAuthUserId } from "../auth.js";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
// Phase O2.1 — route through the backend selector so the same
// endpoints work against either the in-memory Phase G3 store or the
// opt-in Redis backend (`PROOVRA_PRESENCE_BACKEND=redis`). The
// selection is invisible to the route handlers — see
// `services/presence/presence-selector.ts`.
import {
  listViewersAsyncViaSelector as listViewers,
  recordHeartbeatViaSelector as recordHeartbeat,
} from "../services/presence/presence-selector.js";

const HeartbeatBody = z.object({
  teamId: z.string().uuid(),
  // Bounded resource-kind vocabulary. Anything outside this list is
  // rejected so the presence surface cannot be co-opted into a
  // generic activity stream.
  resourceKind: z.enum([
    "evidence",
    "matter",
    "discussion_thread",
    "reviewer_workflow",
    "evidence_request",
  ]),
  resourceId: z.string().min(1).max(180),
});

const HereQuery = HeartbeatBody;

export async function presenceRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------------
  // POST /v1/me/presence/heartbeat
  //
  // Records the caller as actively viewing the (teamId, resourceKind,
  // resourceId) tuple. Returns the current list of OTHER viewers so
  // the frontend can render the indicator in a single round-trip.
  // ---------------------------------------------------------------------
  app.post(
    "/v1/me/presence/heartbeat",
    { preHandler: requireAuth },
    async (req, reply) => {
      const userId = getAuthUserId(req);
      const body = HeartbeatBody.parse(req.body ?? {});

      // Workspace membership gate — a viewer must be a member of the
      // workspace to record presence on its resources.
      const membership = await prisma.teamMember.findUnique({
        where: { teamId_userId: { teamId: body.teamId, userId } },
      });
      if (!membership) {
        return reply.code(404).send({ error: { code: "not_found" } });
      }

      // Capture a bounded display name. Falls back to the user id
      // suffix when no displayName is set so the indicator never
      // surfaces a raw uuid.
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, displayName: true, email: true },
      });
      const displayName =
        user?.displayName?.trim() ||
        (user?.email ?? "").split("@")[0] ||
        `user-${userId.slice(0, 6)}`;

      recordHeartbeat({
        teamId: body.teamId,
        resourceKind: body.resourceKind,
        resourceId: body.resourceId,
        userId,
        displayName,
      });

      const viewers = await listViewers({
        teamId: body.teamId,
        resourceKind: body.resourceKind,
        resourceId: body.resourceId,
        excludeUserId: userId,
      });

      return reply.code(200).send({ viewers });
    },
  );

  // ---------------------------------------------------------------------
  // GET /v1/me/presence/here
  //
  // Read-only — returns active viewers on the resource without
  // refreshing the caller's heartbeat. Used when a surface needs the
  // current viewer list but the caller is not actively focused on the
  // resource (e.g., a presence chip on a list row).
  // ---------------------------------------------------------------------
  app.get(
    "/v1/me/presence/here",
    { preHandler: requireAuth },
    async (req, reply) => {
      const userId = getAuthUserId(req);
      const query = HereQuery.parse(req.query ?? {});

      const membership = await prisma.teamMember.findUnique({
        where: { teamId_userId: { teamId: query.teamId, userId } },
      });
      if (!membership) {
        return reply.code(404).send({ error: { code: "not_found" } });
      }

      const viewers = await listViewers({
        teamId: query.teamId,
        resourceKind: query.resourceKind,
        resourceId: query.resourceId,
        excludeUserId: userId,
      });

      return reply.code(200).send({ viewers });
    },
  );
}
