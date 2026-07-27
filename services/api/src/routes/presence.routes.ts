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

import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { authorizeOrFail } from "../middleware/authorize.js";
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
      const body = HeartbeatBody.parse(req.body ?? {});

      // PHASE 1 AUTHORIZATION CLOSURE (2026-07-21) — canonical gate: a viewer
      // must be an ACTIVE member (org lifecycle enforced, fail-closed,
      // anti-enumeration 404) with collaboration.thread.read to record presence
      // on a workspace's resources.
      const authz = await authorizeOrFail(req, reply, {
        teamId: body.teamId,
        permission: "collaboration.thread.read",
        antiEnumeration: true,
      });
      if (!authz) return;
      const userId = authz.actorUserId;

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
      const query = HereQuery.parse(req.query ?? {});

      const authz = await authorizeOrFail(req, reply, {
        teamId: query.teamId,
        permission: "collaboration.thread.read",
        antiEnumeration: true,
      });
      if (!authz) return;
      const userId = authz.actorUserId;

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
