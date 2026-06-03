/**
 * Phase 32.8E — Enterprise aggregator routes.
 *
 *   GET /v1/teams/workspace-admin?teamId=<uuid>
 *   GET /v1/governance/control-plane?teamId=<uuid>
 *   GET /v1/reviewer-ops/command?teamId=<uuid>
 *
 * Each endpoint is read-only, workspace-scoped, partial-failure
 * tolerant, and emits NO audit events. Used by the new enterprise
 * /teams, /governance, /reviewer-ops surfaces.
 */
import { z } from "zod";
import { getAuthUserId } from "../auth.js";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { buildWorkspaceAdmin } from "../services/workspace-admin/workspace-admin.service.js";
import { buildGovernanceControlPlane } from "../services/governance/governance-control-plane.service.js";
import { buildReviewerCommand } from "../services/reviewer-ops/reviewer-command.service.js";
const Query = z.object({ teamId: z.string().uuid() });
async function requireWorkspaceMember(req, reply, teamId) {
    const userId = getAuthUserId(req);
    const membership = await prisma.teamMember.findUnique({
        where: { teamId_userId: { teamId, userId } },
        select: { role: true, status: true },
    });
    if (!membership) {
        reply.code(404).send({ error: { code: "not_found" } });
        return null;
    }
    if (membership.status !== "ACTIVE") {
        reply.code(403).send({ error: { code: "member_inactive" } });
        return null;
    }
    return { userId, role: membership.role };
}
export async function enterpriseAggregatorsRoutes(app) {
    // ----------- Workspace administration (Teams) -----------
    app.get("/v1/teams/workspace-admin", { preHandler: requireAuth }, async (req, reply) => {
        const query = Query.parse(req.query ?? {});
        const member = await requireWorkspaceMember(req, reply, query.teamId);
        if (!member)
            return;
        const envelope = await buildWorkspaceAdmin({
            teamId: query.teamId,
            userId: member.userId,
            role: member.role,
        });
        if ("notFound" in envelope) {
            return reply.code(404).send({ error: { code: "not_found" } });
        }
        return reply.code(200).send(envelope);
    });
    // ----------- Governance control plane -----------
    app.get("/v1/governance/control-plane", { preHandler: requireAuth }, async (req, reply) => {
        const query = Query.parse(req.query ?? {});
        const member = await requireWorkspaceMember(req, reply, query.teamId);
        if (!member)
            return;
        const envelope = await buildGovernanceControlPlane({
            teamId: query.teamId,
            userId: member.userId,
            role: member.role,
        });
        return reply.code(200).send(envelope);
    });
    // ----------- Reviewer-ops command center -----------
    app.get("/v1/reviewer-ops/command", { preHandler: requireAuth }, async (req, reply) => {
        const query = Query.parse(req.query ?? {});
        const member = await requireWorkspaceMember(req, reply, query.teamId);
        if (!member)
            return;
        const envelope = await buildReviewerCommand({
            teamId: query.teamId,
            userId: member.userId,
            role: member.role,
        });
        return reply.code(200).send(envelope);
    });
}
