import type { FastifyReply, FastifyRequest } from "fastify";
import { createErrorResponse, ErrorCode } from "../errors.js";
import { requireAuth } from "./auth.js";
import { isPlatformAdmin } from "../services/platform-admin.service.js";

export async function requirePlatformAdmin(
  req: FastifyRequest,
  reply: FastifyReply
) {
  await requireAuth(req, reply);
  if (reply.sent) return;

  const userId = req.user!.sub;
  const allowed = await isPlatformAdmin(userId, req.user?.role);
  if (!allowed) {
    return reply
      .code(403)
      .send(
        createErrorResponse(
          ErrorCode.FORBIDDEN,
          req.id,
          undefined,
          "Admin access required"
        )
      );
  }
}
