/**
 * Phase 32.8 Foundation — Canonical platform-context route.
 *
 * GET /v1/platform/context
 *
 * Single read endpoint returning the canonical PlatformContextEnvelope
 * consumed by the web shell (header, sidebar, workspace switcher, and
 * every operator page). Strictly side-effect free.
 *
 * Hard rules — enforced by source-contract tests:
 *
 *   1. NO mutation. The route is GET only.
 *   2. NO audit emission. The platform-context service is a pure read.
 *   3. NO signed URLs. NO queue enqueue. NO custody events.
 *   4. Returns 401 if unauthenticated; 200 + envelope otherwise.
 *   5. The envelope shape is frozen by AUTHORITY_SCHEMA_VERSION and
 *      bumping it requires bumping that constant.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { getAuthUserId } from "../auth.js";
import { buildPlatformContext } from "../services/platform-context/platform-context.service.js";

const SwitchWorkspaceBody = z.object({
  /**
   * `null` switches the user back to their PERSONAL workspace (clears
   * users.current_workspace_id). A UUID string switches to a team
   * workspace the user is an ACTIVE member of.
   */
  workspaceId: z.string().uuid().nullable(),
});

export async function platformContextRoutes(app: FastifyInstance) {
  app.get(
    "/v1/platform/context",
    { preHandler: requireAuth },
    async (req: any, reply) => {
      const userId = getAuthUserId(req);
      const jwtRole =
        typeof req.user?.role === "string" ? (req.user.role as string) : null;

      const result = await buildPlatformContext({
        userId,
        requestId: req.id,
        jwtRole,
      });

      if (!result.ok) {
        return reply.code(404).send({
          message: "User not found",
          code: "user_not_found",
          requestId: req.id,
        });
      }

      return reply.code(200).send(result.envelope);
    },
  );

  /**
   * Atomic workspace-switch endpoint. Verifies the user is a member
   * of the target team (or returns 403), persists currentWorkspaceId,
   * then returns the freshly-built PlatformContextEnvelope. The
   * frontend state machine consumes the response in one render —
   * never mixes old/new authority states.
   */
  app.post(
    "/v1/platform/context/switch-workspace",
    { preHandler: requireAuth },
    async (req: any, reply) => {
      const userId = getAuthUserId(req);
      const jwtRole =
        typeof req.user?.role === "string" ? (req.user.role as string) : null;
      const body = SwitchWorkspaceBody.parse(req.body);

      if (body.workspaceId) {
        const membership = await prisma.teamMember.findUnique({
          where: {
            teamId_userId: {
              teamId: body.workspaceId,
              userId,
            },
          },
          select: { status: true },
        });
        if (!membership || membership.status !== "ACTIVE") {
          return reply.code(403).send({
            message: "Not a member of this workspace",
            code: "workspace_membership_required",
            requestId: req.id,
          });
        }
      }

      await prisma.user.update({
        where: { id: userId },
        data: { currentWorkspaceId: body.workspaceId },
      });

      const result = await buildPlatformContext({
        userId,
        requestId: req.id,
        jwtRole,
      });

      if (!result.ok) {
        return reply.code(404).send({
          message: "User not found",
          code: "user_not_found",
          requestId: req.id,
        });
      }

      return reply.code(200).send(result.envelope);
    },
  );
}
