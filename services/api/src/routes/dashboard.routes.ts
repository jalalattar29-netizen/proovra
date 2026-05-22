/**
 * Phase 32.8C — Enterprise Evidence Operations Command Center route.
 *
 *   GET /v1/dashboard/command-center?teamId=<uuid>
 *
 * Read-only aggregator that powers the /home dashboard. Returns a
 * typed envelope with per-section status so the renderer can render
 * each section independently and degrade gracefully when one
 * subsystem is unavailable.
 *
 * Auth posture:
 *   - Requires authentication (`requireAuth`).
 *   - Asserts ACTIVE workspace membership for the given `teamId`.
 *   - Permission posture is the same as any other workspace-scoped
 *     read: any active member of the workspace may read the
 *     dashboard. Section-level data shown to non-admin roles is
 *     already bounded by what they could see by visiting the
 *     underlying surfaces directly (counts only; the renderer
 *     hides admin-only quick actions on the client side).
 *
 * Hard rules:
 *   - NEVER mutates state.
 *   - NEVER emits an audit event (loading the dashboard is NOT a
 *     "viewed evidence" or "viewed legal hold" event).
 *   - NEVER returns raw sensitive content (no file bytes, no signed
 *     URLs, no privileged legal text). The service exposes counts +
 *     stable IDs + bounded titles only.
 *   - Bounded query limits live in the service layer.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { getAuthUserId } from "../auth.js";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";

import { buildCommandCenter } from "../services/dashboard/command-center.service.js";

const Query = z.object({ teamId: z.string().uuid() });

async function requireMember(
  req: FastifyRequest,
  reply: FastifyReply,
  teamId: string,
): Promise<{ userId: string; role: string } | null> {
  const userId = getAuthUserId(req);
  const membership = await prisma.teamMember.findUnique({
    where: { teamId_userId: { teamId, userId } },
    select: { role: true, status: true },
  });
  if (!membership) {
    // 404 on non-member to avoid enumeration. Same posture as
    // reviewer-ops and governance.
    reply.code(404).send({ error: { code: "not_found" } });
    return null;
  }
  if (membership.status !== "ACTIVE") {
    reply.code(403).send({
      error: { code: "member_inactive" },
    });
    return null;
  }
  return { userId, role: membership.role };
}

export async function dashboardRoutes(app: FastifyInstance) {
  app.get(
    "/v1/dashboard/command-center",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const query = Query.parse(req.query ?? {});
      const member = await requireMember(req, reply, query.teamId);
      if (!member) return;

      const envelope = await buildCommandCenter({
        teamId: query.teamId,
        role: member.role,
      });

      return reply.code(200).send(envelope);
    },
  );
}
