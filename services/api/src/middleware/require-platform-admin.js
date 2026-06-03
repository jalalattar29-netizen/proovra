import { createErrorResponse, ErrorCode } from "../errors.js";
import { requireAuth } from "./auth.js";
import { isPlatformAdmin } from "../services/platform-admin.service.js";
export async function requirePlatformAdmin(req, reply) {
    await requireAuth(req, reply);
    if (reply.sent)
        return;
    const userId = req.user.sub;
    const role = req.user
        ?.platformRole ??
        req.user?.role ??
        null;
    const allowed = await isPlatformAdmin(userId, role);
    if (!allowed) {
        return reply.code(403).send(createErrorResponse(ErrorCode.FORBIDDEN, req.id, undefined, "Admin access required"));
    }
}
