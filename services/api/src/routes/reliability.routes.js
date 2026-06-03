/**
 * Phase 12 — Reliability operations routes.
 *
 *   GET   /v1/reliability/summary?teamId
 *   GET   /v1/reliability/upload-sessions?teamId&status
 *   POST  /v1/reliability/upload-sessions/:evidenceId/mark-abandoned
 *   POST  /v1/reliability/upload-sessions/:evidenceId/request-review
 *   POST  /v1/reliability/reconcile          (cron-protected)
 *
 * All read + manual-action routes require authenticated OWNER/ADMIN
 * membership (404s for non-admins so role enumeration is not possible).
 * The cron route uses INTEGRATION_CRON_SECRET — same protection as the
 * webhook retry sweeper.
 */
import { z } from "zod";
import { UPLOAD_SESSION_STATUSES } from "@proovra/shared";
import { getAuthUserId } from "../auth.js";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { requireIntegrationCronSecret } from "../middleware/cron-secret.js";
import { countUploadSessionsByTeam, listUploadSessions, projectUploadSession, } from "../services/reliability/upload-session.service.js";
import { operatorMarkAbandoned, operatorRequestReview, reconcileUploads, } from "../services/reliability/upload-reconciliation.service.js";
import { getStaleThresholds, getUploadSizeLimits, } from "../services/reliability/upload-limits.service.js";
import { listQueuePolicies } from "../services/reliability/queue-policy.service.js";
const ParamsEvidenceId = z.object({ evidenceId: z.string().uuid() });
async function requireAdminMember(req, reply, teamId) {
    const userId = getAuthUserId(req);
    const membership = await prisma.teamMember.findUnique({
        where: { teamId_userId: { teamId, userId } },
    });
    if (!membership) {
        reply.code(404).send({ error: { code: "not_found" } });
        return null;
    }
    if (membership.role !== "OWNER" && membership.role !== "ADMIN") {
        reply.code(404).send({ error: { code: "not_found" } });
        return null;
    }
    return { userId };
}
export async function reliabilityRoutes(app) {
    app.get("/v1/reliability/summary", { preHandler: requireAuth }, async (req, reply) => {
        const query = z
            .object({ teamId: z.string().uuid() })
            .parse(req.query ?? {});
        const ok = await requireAdminMember(req, reply, query.teamId);
        if (!ok)
            return;
        const counts = await countUploadSessionsByTeam({ teamId: query.teamId });
        return reply.code(200).send({
            counts,
            thresholds: getStaleThresholds(),
            sizeLimits: getUploadSizeLimits(),
            queuePolicies: listQueuePolicies(),
        });
    });
    app.get("/v1/reliability/upload-sessions", { preHandler: requireAuth }, async (req, reply) => {
        const query = z
            .object({
            teamId: z.string().uuid(),
            status: z.enum(UPLOAD_SESSION_STATUSES).optional(),
            limit: z.coerce.number().int().min(1).max(200).optional(),
        })
            .parse(req.query ?? {});
        const ok = await requireAdminMember(req, reply, query.teamId);
        if (!ok)
            return;
        const rows = await listUploadSessions({
            teamId: query.teamId,
            status: query.status,
            limit: query.limit,
        });
        return reply
            .code(200)
            .send({ sessions: rows.map(projectUploadSession) });
    });
    app.post("/v1/reliability/upload-sessions/:evidenceId/mark-abandoned", { preHandler: requireAuth }, async (req, reply) => {
        const { evidenceId } = ParamsEvidenceId.parse(req.params);
        const body = z
            .object({ teamId: z.string().uuid() })
            .parse(req.body ?? {});
        const ok = await requireAdminMember(req, reply, body.teamId);
        if (!ok)
            return;
        // Cross-workspace probing protection — the session must belong
        // to the caller's workspace.
        const session = await prisma.uploadSession.findUnique({
            where: { evidenceId },
            select: { teamId: true },
        });
        if (!session || session.teamId !== body.teamId) {
            return reply.code(404).send({ error: { code: "not_found" } });
        }
        const updated = await operatorMarkAbandoned({
            evidenceId,
            actorUserId: ok.userId,
        });
        if (!updated) {
            return reply
                .code(409)
                .send({ error: { code: "transition_not_allowed" } });
        }
        return reply
            .code(200)
            .send({ session: projectUploadSession(updated) });
    });
    app.post("/v1/reliability/upload-sessions/:evidenceId/request-review", { preHandler: requireAuth }, async (req, reply) => {
        const { evidenceId } = ParamsEvidenceId.parse(req.params);
        const body = z
            .object({ teamId: z.string().uuid() })
            .parse(req.body ?? {});
        const ok = await requireAdminMember(req, reply, body.teamId);
        if (!ok)
            return;
        const session = await prisma.uploadSession.findUnique({
            where: { evidenceId },
            select: { teamId: true },
        });
        if (!session || session.teamId !== body.teamId) {
            return reply.code(404).send({ error: { code: "not_found" } });
        }
        const updated = await operatorRequestReview({
            evidenceId,
            actorUserId: ok.userId,
        });
        if (!updated) {
            return reply
                .code(409)
                .send({ error: { code: "transition_not_allowed" } });
        }
        return reply
            .code(200)
            .send({ session: projectUploadSession(updated) });
    });
    // Cron-driven: same protection as the webhook retry sweeper.
    app.post("/v1/reliability/reconcile", async (req, reply) => {
        const ok = await requireIntegrationCronSecret(req, reply);
        if (!ok)
            return;
        const body = z
            .object({ batchSize: z.number().int().min(1).max(2000).optional() })
            .parse(req.body ?? {});
        const summary = await reconcileUploads({ batchSize: body.batchSize });
        return reply.code(200).send({ summary });
    });
}
