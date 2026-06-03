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
import { z } from "zod";
import { getAuthUserId } from "../auth.js";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { buildCommandCenter } from "../services/dashboard/command-center.service.js";
import { getLatestOrgHealthSnapshot } from "../services/dashboard/org-health.service.js";
import { listReviewerRoutingRecommendations } from "../services/dashboard/reviewer-capacity.service.js";
import { listWorkspaceAccessAnomalies } from "../services/dashboard/access-anomaly.service.js";
const Query = z.object({ teamId: z.string().uuid() });
async function requireMember(req, reply, teamId) {
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
export async function dashboardRoutes(app) {
    app.get("/v1/dashboard/command-center", { preHandler: requireAuth }, async (req, reply) => {
        const query = Query.parse(req.query ?? {});
        const member = await requireMember(req, reply, query.teamId);
        if (!member)
            return;
        const envelope = await buildCommandCenter({
            teamId: query.teamId,
            role: member.role,
        });
        return reply.code(200).send(envelope);
    });
    // ---------------------------------------------------------------------------
    // Phase Final-Hidden-Feature-Surfacing — thin route wrappers over
    // existing dashboard services so the corresponding UI panels can read
    // each capability standalone (without paying the full command-center
    // aggregation cost). Auth posture identical to the command center
    // (requireAuth + requireMember + 404 on non-member).
    // ---------------------------------------------------------------------------
    // OrganizationalHealthSnapshot — surfaces on /admin/dashboard + /ops/analytics
    app.get("/v1/dashboard/org-health", { preHandler: requireAuth }, async (req, reply) => {
        const query = Query.parse(req.query ?? {});
        const member = await requireMember(req, reply, query.teamId);
        if (!member)
            return;
        const snapshot = await getLatestOrgHealthSnapshot({
            teamId: query.teamId,
        });
        return reply.code(200).send({ snapshot });
    });
    // ReviewerRoutingRecommendation — surfaces on /review (reviewer console)
    const RoutingRecsQuery = Query.extend({
        limit: z.coerce.number().int().min(1).max(25).optional(),
    });
    app.get("/v1/reviewer/routing-recommendations", { preHandler: requireAuth }, async (req, reply) => {
        const query = RoutingRecsQuery.parse(req.query ?? {});
        const member = await requireMember(req, reply, query.teamId);
        if (!member)
            return;
        const recommendations = await listReviewerRoutingRecommendations({
            teamId: query.teamId,
            limit: query.limit,
        });
        return reply.code(200).send({ recommendations });
    });
    // AccessAnomaly — surfaces on /security-center
    const AnomaliesQuery = Query.extend({
        limit: z.coerce.number().int().min(1).max(50).optional(),
    });
    app.get("/v1/security-center/access-anomalies", { preHandler: requireAuth }, async (req, reply) => {
        const query = AnomaliesQuery.parse(req.query ?? {});
        const member = await requireMember(req, reply, query.teamId);
        if (!member)
            return;
        const anomalies = await listWorkspaceAccessAnomalies({
            teamId: query.teamId,
            limit: query.limit ?? 12,
        });
        return reply.code(200).send({ anomalies });
    });
}
