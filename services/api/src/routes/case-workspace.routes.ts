/**
 * Phase 32.8D — Case Workspace + Reports aggregator routes.
 *
 *   GET /v1/cases/summary?teamId=<uuid>
 *   GET /v1/cases/:id/workspace
 *   GET /v1/reports/artifacts?teamId=<uuid>&limit=&cursor=&lifecycle=&search=&caseId=
 *
 * Each endpoint is read-only, workspace-scoped, partial-failure
 * tolerant, and EMITS NO AUDIT — browsing these aggregators is not
 * an auditable event the way an explicit case view or artifact
 * download is. The existing `/v1/cases/:id` GET endpoint remains
 * the canonical "viewed-case" audit surface; this workspace endpoint
 * is the tabbed-overview reader and intentionally does not duplicate
 * that audit.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { getAuthUserId } from "../auth.js";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";

import {
  buildCasesSummary,
  buildCaseWorkspace,
} from "../services/cases/case-workspace.service.js";
import { listWorkspaceArtifacts } from "../services/reports/reports-aggregator.service.js";

// ---------------------------------------------------------------------------
// Membership helpers
// ---------------------------------------------------------------------------

async function requireWorkspaceMember(
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
    reply.code(404).send({ error: { code: "not_found" } });
    return null;
  }
  if (membership.status !== "ACTIVE") {
    reply.code(403).send({ error: { code: "member_inactive" } });
    return null;
  }
  return { userId, role: membership.role };
}

async function requireCaseAccess(
  req: FastifyRequest,
  reply: FastifyReply,
  caseId: string,
): Promise<{ userId: string; role: string } | null> {
  const userId = getAuthUserId(req);
  const caseRow = await prisma.case.findUnique({
    where: { id: caseId },
    select: {
      id: true,
      ownerUserId: true,
      teamId: true,
      access: { where: { userId }, select: { id: true } },
    },
  });
  if (!caseRow) {
    reply.code(404).send({ error: { code: "not_found" } });
    return null;
  }
  // Case owner — always allowed.
  if (caseRow.ownerUserId === userId) {
    return { userId, role: "OWNER" };
  }
  // Direct access — allowed.
  if (caseRow.access.length > 0) {
    return { userId, role: "MEMBER" };
  }
  // Team workspace member with no explicit access list on the case.
  if (caseRow.teamId) {
    const membership = await prisma.teamMember.findUnique({
      where: {
        teamId_userId: { teamId: caseRow.teamId, userId },
      },
      select: { role: true, status: true },
    });
    if (
      membership &&
      membership.status === "ACTIVE" &&
      caseRow.access.length === 0
    ) {
      // Case has no explicit access list — workspace membership grants
      // read access. (Same model as /v1/cases list.)
      const teamCaseAccessCount = await prisma.caseAccess.count({
        where: { caseId },
      });
      if (teamCaseAccessCount === 0) {
        return { userId, role: membership.role };
      }
    }
  }
  reply.code(404).send({ error: { code: "not_found" } });
  return null;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const SummaryQuery = z.object({ teamId: z.string().uuid() });

const WorkspaceParams = z.object({ id: z.string().uuid() });

const ArtifactsQuery = z.object({
  teamId: z.string().uuid(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).max(512).optional(),
  lifecycle: z
    .enum([
      "all",
      "report_ready",
      "report_pending",
      "report_failed",
      "package_ready",
      "package_pending",
      "package_blocked",
    ])
    .optional(),
  search: z.string().min(1).max(80).optional(),
  caseId: z.string().uuid().optional(),
});

export async function caseWorkspaceRoutes(app: FastifyInstance) {
  // ----------- Cases summary (for /cases list page) -----------
  app.get(
    "/v1/cases/summary",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const query = SummaryQuery.parse(req.query ?? {});
      const member = await requireWorkspaceMember(req, reply, query.teamId);
      if (!member) return;
      const envelope = await buildCasesSummary({
        teamId: query.teamId,
        userId: member.userId,
        role: member.role,
      });
      return reply.code(200).send(envelope);
    },
  );

  // ----------- Single case workspace (for /cases/:id tabs) -----------
  app.get(
    "/v1/cases/:id/workspace",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = WorkspaceParams.parse(req.params ?? {});
      const member = await requireCaseAccess(req, reply, params.id);
      if (!member) return;
      const envelope = await buildCaseWorkspace({
        caseId: params.id,
        userId: member.userId,
        role: member.role,
      });
      if ("notFound" in envelope) {
        return reply.code(404).send({ error: { code: "not_found" } });
      }
      return reply.code(200).send(envelope);
    },
  );

  // ----------- Workspace artifacts list (for /reports page) -----------
  app.get(
    "/v1/reports/artifacts",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const query = ArtifactsQuery.parse(req.query ?? {});
      const member = await requireWorkspaceMember(req, reply, query.teamId);
      if (!member) return;
      const envelope = await listWorkspaceArtifacts({
        teamId: query.teamId,
        role: member.role,
        limit: query.limit,
        cursor: query.cursor ?? null,
        lifecycleFilter: query.lifecycle ?? "all",
        search: query.search ?? null,
        caseId: query.caseId ?? null,
      });
      return reply.code(200).send(envelope);
    },
  );
}
