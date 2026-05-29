import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { Readable } from "node:stream";
import { z } from "zod";
import { prisma } from "../db.js";
import { hasRole } from "../services/rbac.js";
import * as prismaPkg from "@prisma/client";
import archiver from "archiver";
import { getObjectStream } from "../storage.js";
import { requireAuth } from "../middleware/auth.js";
import { requireLegalAcceptance } from "../middleware/require-legal-acceptance.js";
import { getAuthUserId } from "../auth.js";
import { appendPlatformAuditLog } from "../services/platform-audit-log.service.js";
import { writeAnalyticsEvent } from "../services/analytics-event.service.js";
import {
  changeCaseStatus,
  CaseError,
} from "../services/cases/case-lifecycle.service.js";
// Phase O-blockers / A-1 + A-2 — destructive-case mutation gate and
// cross-team evidence attach gate. Single source of truth in the
// case-permission matrix.
import {
  resolveCaseDestructiveGate,
  evaluateCrossTeamAttach,
} from "../services/cases/case-permission.service.js";

const CreateCaseBody = z.object({
  name: z.string().min(1).max(120),
  teamId: z.string().uuid().optional(),
});

const RenameCaseBody = z.object({
  name: z.string().min(1).max(120),
});

const AddEvidenceBody = z.object({
  evidenceId: z.string().uuid(),
});

const ShareTeamBody = z.object({
  userId: z.string().uuid(),
});

const ShareEmailBody = z.object({
  email: z.string().email(),
});

const AccessBody = z.object({
  userId: z.string().uuid(),
});

async function requireAuthAndLegal(req: FastifyRequest, reply: FastifyReply) {
  await requireAuth(req, reply);
  if (reply.sent) return;
  await requireLegalAcceptance(req, reply);
}

function readUserAgent(req: FastifyRequest): string | null {
  const ua = req.headers["user-agent"];
  return Array.isArray(ua) ? ua[0] ?? null : ua ?? null;
}

function getRequestPath(req: FastifyRequest): string {
  const url = req.url || "";
  const qIndex = url.indexOf("?");
  return qIndex >= 0 ? url.slice(0, qIndex) : url;
}

function auditCaseAction(
  req: FastifyRequest,
  params: {
    userId: string | null;
    action: string;
    outcome?: "success" | "failure" | "blocked";
    severity?: "info" | "warning" | "critical";
    resourceId?: string | null;
    metadata?: Record<string, unknown>;
  }
) {
  void appendPlatformAuditLog({
    userId: params.userId,
    action: params.action,
    category: "cases",
    severity: params.severity ?? "info",
    source: "api_cases",
    outcome: params.outcome ?? "success",
    resourceType: "case",
    resourceId: params.resourceId ?? null,
    requestId: req.id,
    metadata: params.metadata ?? {},
    ipAddress: req.ip,
    userAgent: readUserAgent(req),
  }).catch(() => null);
}

function fireCaseAnalyticsEvent(params: {
  eventType: string;
  userId: string;
  req: FastifyRequest;
  entityType?: string | null;
  entityId?: string | null;
  severity?: string | null;
  metadata?: Record<string, unknown>;
}) {
  void writeAnalyticsEvent({
    eventType: params.eventType,
    userId: params.userId,
    path: getRequestPath(params.req),
    entityType: params.entityType ?? "case",
    entityId: params.entityId ?? null,
    severity: params.severity ?? "info",
    metadata: params.metadata ?? {},
    req: params.req,
    skipSessionUpsert: true,
  }).catch(() => null);
}

export async function casesRoutes(app: FastifyInstance) {
  app.post("/v1/cases", { preHandler: requireAuthAndLegal }, async (req, reply) => {
    const body = CreateCaseBody.parse(req.body);
    const ownerUserId = getAuthUserId(req);

    if (body.teamId) {
      const member = await prisma.teamMember.findUnique({
        where: { teamId_userId: { teamId: body.teamId, userId: ownerUserId } },
      });

      if (!member) {
        auditCaseAction(req, {
          userId: ownerUserId,
          action: "cases.create",
          outcome: "blocked",
          severity: "warning",
          metadata: { reason: "forbidden_team_access", teamId: body.teamId },
        });
        return reply.code(403).send({ message: "Forbidden" });
      }
    }

    const created = await prisma.case.create({
      data: {
        name: body.name,
        ownerUserId,
        teamId: body.teamId ?? null,
      },
    });

    auditCaseAction(req, {
      userId: ownerUserId,
      action: "cases.create",
      outcome: "success",
      resourceId: created.id,
      metadata: {
        name: created.name,
        teamId: created.teamId,
      },
    });

    fireCaseAnalyticsEvent({
      eventType: "case_created",
      userId: ownerUserId,
      req,
      entityId: created.id,
      metadata: {
        hasTeam: Boolean(created.teamId),
      },
    });

    return reply.code(201).send(created);
  });

  app.get("/v1/cases", { preHandler: requireAuthAndLegal }, async (req, reply) => {
    const ownerUserId = getAuthUserId(req);

    const memberTeams = await prisma.teamMember.findMany({
      where: { userId: ownerUserId },
      select: { teamId: true },
    });
    const memberTeamIds = memberTeams.map((t) => t.teamId);

    const or: Array<Record<string, unknown>> = [
      { ownerUserId },
      { access: { some: { userId: ownerUserId } } },
    ];

    if (memberTeamIds.length > 0) {
      or.push({
        teamId: { in: memberTeamIds },
        access: { none: {} },
      });
    }

    // Phase 37.95 — enforce a server-side cap on the bare list. Larger
    // tenants must consume `/v1/cases/matter-queue` (case-workspace.routes)
    // which carries a cursor + bounded page size. This endpoint is the
    // simple non-paginated index — capped at a safe default.
    const items = await prisma.case.findMany({
      where: { OR: or },
      orderBy: { createdAt: "desc" },
      take: 200,
    });

    auditCaseAction(req, {
      userId: ownerUserId,
      action: "cases.list",
      outcome: "success",
      metadata: { count: items.length },
    });

    fireCaseAnalyticsEvent({
      eventType: "case_list_viewed",
      userId: ownerUserId,
      req,
      entityType: "case_list",
      metadata: { count: items.length },
    });

    return reply.code(200).send({ items });
  });

  app.get(
    "/v1/cases/:id",
    { preHandler: requireAuthAndLegal },
    async (req: FastifyRequest, reply) => {
      const id = z.string().uuid().parse((req.params as { id: string }).id);
      const ownerUserId = getAuthUserId(req);

      const item = await prisma.case.findUnique({
        where: { id },
        include: {
          access: {
            include: {
              user: {
                select: {
                  id: true,
                  email: true,
                  displayName: true,
                },
              },
            },
          },
        },
      });

      if (!item) {
        auditCaseAction(req, {
          userId: ownerUserId,
          action: "cases.view",
          outcome: "failure",
          severity: "warning",
          resourceId: id,
          metadata: { reason: "not_found" },
        });
        return reply.code(404).send({ message: "Case not found" });
      }

      if (item.ownerUserId === ownerUserId) {
        auditCaseAction(req, {
          userId: ownerUserId,
          action: "cases.view",
          outcome: "success",
          resourceId: id,
        });

        fireCaseAnalyticsEvent({
          eventType: "case_viewed",
          userId: ownerUserId,
          req,
          entityId: id,
        });

        return reply.code(200).send({ case: item });
      }

      if (item.access.some((a) => a.userId === ownerUserId)) {
        auditCaseAction(req, {
          userId: ownerUserId,
          action: "cases.view",
          outcome: "success",
          resourceId: id,
          metadata: { accessMode: "direct_share" },
        });

        fireCaseAnalyticsEvent({
          eventType: "case_viewed",
          userId: ownerUserId,
          req,
          entityId: id,
          metadata: { accessMode: "direct_share" },
        });

        return reply.code(200).send({ case: item });
      }

      if (item.teamId && item.access.length === 0) {
        const member = await prisma.teamMember.findUnique({
          where: { teamId_userId: { teamId: item.teamId, userId: ownerUserId } },
        });
        if (member) {
          auditCaseAction(req, {
            userId: ownerUserId,
            action: "cases.view",
            outcome: "success",
            resourceId: id,
            metadata: { accessMode: "team" },
          });

          fireCaseAnalyticsEvent({
            eventType: "case_viewed",
            userId: ownerUserId,
            req,
            entityId: id,
            metadata: { accessMode: "team" },
          });

          return reply.code(200).send({ case: item });
        }
      }

      auditCaseAction(req, {
        userId: ownerUserId,
        action: "cases.view",
        outcome: "blocked",
        severity: "warning",
        resourceId: id,
        metadata: { reason: "forbidden" },
      });

      return reply.code(403).send({ message: "Forbidden" });
    }
  );

  app.post(
    "/v1/cases/:id/access",
    { preHandler: requireAuthAndLegal },
    async (req: FastifyRequest, reply) => {
      const id = z.string().uuid().parse((req.params as { id: string }).id);
      const body = AccessBody.parse(req.body);
      const ownerUserId = getAuthUserId(req);

      const item = await prisma.case.findUnique({
        where: { id },
        select: { id: true, teamId: true },
      });

      if (!item) {
        auditCaseAction(req, {
          userId: ownerUserId,
          action: "cases.access_grant",
          outcome: "failure",
          severity: "warning",
          resourceId: id,
          metadata: { reason: "not_found" },
        });
        return reply.code(404).send({ message: "Case not found" });
      }

      if (!item.teamId) {
        auditCaseAction(req, {
          userId: ownerUserId,
          action: "cases.access_grant",
          outcome: "blocked",
          severity: "warning",
          resourceId: id,
          metadata: { reason: "not_team_case" },
        });
        return reply.code(400).send({ message: "Case is not a team case" });
      }

      const actor = await prisma.teamMember.findUnique({
        where: { teamId_userId: { teamId: item.teamId, userId: ownerUserId } },
      });

      if (!actor || !hasRole(actor.role, prismaPkg.TeamRole.ADMIN)) {
        auditCaseAction(req, {
          userId: ownerUserId,
          action: "cases.access_grant",
          outcome: "blocked",
          severity: "warning",
          resourceId: id,
          metadata: { reason: "forbidden", targetUserId: body.userId },
        });
        return reply.code(403).send({ message: "Forbidden" });
      }

      const access = await prisma.caseAccess.upsert({
        where: { caseId_userId: { caseId: id, userId: body.userId } },
        update: {},
        create: { caseId: id, userId: body.userId },
      });

      auditCaseAction(req, {
        userId: ownerUserId,
        action: "cases.access_grant",
        outcome: "success",
        resourceId: id,
        metadata: { targetUserId: body.userId, accessId: access.id },
      });

      fireCaseAnalyticsEvent({
        eventType: "case_access_granted",
        userId: ownerUserId,
        req,
        entityId: id,
        metadata: { targetUserId: body.userId },
      });

      return reply.code(201).send({ access });
    }
  );

  app.get(
    "/v1/cases/:id/export",
    { preHandler: requireAuthAndLegal },
    async (req: FastifyRequest, reply) => {
      const id = z.string().uuid().parse((req.params as { id: string }).id);
      const ownerUserId = getAuthUserId(req);

      const item = await prisma.case.findUnique({
        where: { id },
        include: { access: true },
      });

      if (!item) {
        auditCaseAction(req, {
          userId: ownerUserId,
          action: "cases.export",
          outcome: "failure",
          severity: "warning",
          resourceId: id,
          metadata: { reason: "not_found" },
        });
        return reply.code(404).send({ message: "Case not found" });
      }

      if (item.ownerUserId !== ownerUserId) {
        let hasAccess = item.access.some((a) => a.userId === ownerUserId);

        if (!hasAccess && item.teamId && item.access.length === 0) {
          const member = await prisma.teamMember.findUnique({
            where: { teamId_userId: { teamId: item.teamId, userId: ownerUserId } },
          });
          hasAccess = Boolean(member);
        }

        if (!hasAccess) {
          auditCaseAction(req, {
            userId: ownerUserId,
            action: "cases.export",
            outcome: "blocked",
            severity: "warning",
            resourceId: id,
            metadata: { reason: "forbidden" },
          });
          return reply.code(403).send({ message: "Forbidden" });
        }
      }

      const evidence = await prisma.evidence.findMany({
        where: { caseId: id, deletedAt: null },
        include: { reports: { orderBy: { version: "desc" }, take: 1 } },
      });

      auditCaseAction(req, {
        userId: ownerUserId,
        action: "cases.export",
        outcome: "success",
        resourceId: id,
        metadata: { evidenceCount: evidence.length },
      });

      fireCaseAnalyticsEvent({
        eventType: "case_exported",
        userId: ownerUserId,
        req,
        entityId: id,
        metadata: { evidenceCount: evidence.length },
      });

      reply.header("content-type", "application/zip");
      reply.header("content-disposition", `attachment; filename="case-${id}.zip"`);

      const archive = archiver("zip", { zlib: { level: 9 } });
      archive.on("error", (err) => {
        throw err;
      });

      archive.append(
        JSON.stringify(
          {
            caseId: id,
            evidence: evidence.map((ev) => ({
              id: ev.id,
              status: ev.status,
              createdAt: ev.createdAt.toISOString(),
            })),
          },
          null,
          2
        ),
        { name: "manifest.json" }
      );

      for (const ev of evidence) {
        const report = ev.reports?.[0];
        if (report) {
          const stream = await getObjectStream({
            bucket: report.storageBucket,
            key: report.storageKey,
          });

          archive.append(stream as unknown as Readable, {
            name: `reports/${ev.id}/v${report.version}.pdf`,
          });
        }
      }

      await archive.finalize();
      return reply.send(archive);
    }
  );

  app.get(
    "/v1/cases/:id/team-members",
    { preHandler: requireAuthAndLegal },
    async (req: FastifyRequest, reply) => {
      const id = z.string().uuid().parse((req.params as { id: string }).id);
      const ownerUserId = getAuthUserId(req);

      const caseItem = await prisma.case.findUnique({
        where: { id },
        select: { id: true, teamId: true, ownerUserId: true },
      });

      if (!caseItem) {
        auditCaseAction(req, {
          userId: ownerUserId,
          action: "cases.team_members_list",
          outcome: "failure",
          severity: "warning",
          resourceId: id,
          metadata: { reason: "not_found" },
        });
        return reply.code(404).send({ message: "Case not found" });
      }

      if (caseItem.ownerUserId !== ownerUserId) {
        auditCaseAction(req, {
          userId: ownerUserId,
          action: "cases.team_members_list",
          outcome: "blocked",
          severity: "warning",
          resourceId: id,
          metadata: { reason: "forbidden" },
        });
        return reply.code(403).send({ message: "Forbidden" });
      }

      if (!caseItem.teamId) {
        auditCaseAction(req, {
          userId: ownerUserId,
          action: "cases.team_members_list",
          outcome: "blocked",
          severity: "warning",
          resourceId: id,
          metadata: { reason: "not_team_case" },
        });
        return reply.code(400).send({ message: "Case is not a team case" });
      }

      const members = await prisma.teamMember.findMany({
        where: { teamId: caseItem.teamId },
        include: {
          user: {
            select: {
              id: true,
              email: true,
              displayName: true,
            },
          },
        },
      });

      auditCaseAction(req, {
        userId: ownerUserId,
        action: "cases.team_members_list",
        outcome: "success",
        resourceId: id,
        metadata: { count: members.length },
      });

      return reply.code(200).send({
        items: members.map((m) => ({
          userId: m.user.id,
          email: m.user.email,
          displayName: m.user.displayName,
          label: m.user.displayName || m.user.email || m.user.id,
        })),
      });
    }
  );

  app.patch(
    "/v1/cases/:id",
    { preHandler: requireAuthAndLegal },
    async (req: FastifyRequest, reply) => {
      const id = z.string().uuid().parse((req.params as { id: string }).id);
      const body = RenameCaseBody.parse(req.body);
      const userId = getAuthUserId(req);

      const item = await prisma.case.findUnique({ where: { id } });
      if (!item) {
        auditCaseAction(req, {
          userId,
          action: "cases.rename",
          outcome: "failure",
          severity: "warning",
          resourceId: id,
          metadata: { reason: "not_found" },
        });
        return reply.code(404).send({ message: "Case not found" });
      }

      // Phase O-blockers / A-1 — destructive case mutation requires
      // workspace OWNER or ADMIN. Personal-case owner is allowed via
      // the synthetic OWNER role from the access resolver.
      const renameGate = await resolveCaseDestructiveGate({
        caseRow: item,
        userId,
        mutation: "MANAGE_SETTINGS",
      });
      if (!renameGate.allowed) {
        auditCaseAction(req, {
          userId,
          action: "cases.rename",
          outcome: "blocked",
          severity: "warning",
          resourceId: id,
          metadata: {
            reason: "forbidden",
            denyReason: renameGate.reason,
            denyCode: "CASE_RENAME_DENIED",
            accessRole: renameGate.accessRole,
          },
        });
        return reply.code(403).send({
          message: "Forbidden",
          code: "CASE_RENAME_DENIED",
          detail: renameGate.reason,
        });
      }

      const updated = await prisma.case.update({
        where: { id },
        data: { name: body.name },
      });

      auditCaseAction(req, {
        userId,
        action: "cases.rename",
        outcome: "success",
        resourceId: id,
        metadata: { name: body.name },
      });

      fireCaseAnalyticsEvent({
        eventType: "case_updated",
        userId,
        req,
        entityId: id,
        metadata: { field: "name" },
      });

      return reply.code(200).send(updated);
    }
  );

  app.delete(
    "/v1/cases/:id",
    { preHandler: requireAuthAndLegal },
    async (req: FastifyRequest, reply) => {
      const id = z.string().uuid().parse((req.params as { id: string }).id);
      const userId = getAuthUserId(req);

      const item = await prisma.case.findUnique({ where: { id } });
      if (!item) {
        auditCaseAction(req, {
          userId,
          action: "cases.delete",
          outcome: "failure",
          severity: "warning",
          resourceId: id,
          metadata: { reason: "not_found" },
        });
        return reply.code(404).send({ message: "Case not found" });
      }

      // Phase O-blockers / A-1 — destructive case mutation. Replaces
      // the prior "any team member can delete" check with the bounded
      // case-permission matrix: OWNER / ADMIN only, plus the
      // synthetic OWNER role for personal-case owners. Emits a
      // CaseDeleteDenied audit row on rejection so the security team
      // can trace attempted destructive actions.
      const deleteGate = await resolveCaseDestructiveGate({
        caseRow: item,
        userId,
        mutation: "DELETE",
      });
      if (!deleteGate.allowed) {
        auditCaseAction(req, {
          userId,
          action: "cases.delete",
          outcome: "blocked",
          severity: "critical",
          resourceId: id,
          metadata: {
            reason: "forbidden",
            denyReason: deleteGate.reason,
            denyCode: "CASE_DELETE_DENIED",
            accessRole: deleteGate.accessRole,
            eventKind: "CaseDeleteDenied",
          },
        });
        return reply.code(403).send({
          message: "Forbidden",
          code: "CASE_DELETE_DENIED",
          detail: deleteGate.reason,
        });
      }

      await prisma.evidence.updateMany({
        where: { caseId: id },
        data: { caseId: null },
      });

      await prisma.caseAccess.deleteMany({ where: { caseId: id } });
      await prisma.case.delete({ where: { id } });

      auditCaseAction(req, {
        userId,
        action: "cases.delete",
        outcome: "success",
        resourceId: id,
      });

      fireCaseAnalyticsEvent({
        eventType: "case_deleted",
        userId,
        req,
        entityId: id,
      });

      return reply.code(204).send();
    }
  );

  app.post(
    "/v1/cases/:id/evidence",
    { preHandler: requireAuthAndLegal },
    async (req: FastifyRequest, reply) => {
      const id = z.string().uuid().parse((req.params as { id: string }).id);
      const body = AddEvidenceBody.parse(req.body);
      const userId = getAuthUserId(req);

      const caseItem = await prisma.case.findUnique({ where: { id } });
      if (!caseItem) {
        auditCaseAction(req, {
          userId,
          action: "cases.add_evidence",
          outcome: "failure",
          severity: "warning",
          resourceId: id,
          metadata: { reason: "case_not_found", evidenceId: body.evidenceId },
        });
        return reply.code(404).send({ message: "Case not found" });
      }

      let hasPermission = caseItem.ownerUserId === userId;

      if (!hasPermission && caseItem.teamId) {
        const member = await prisma.teamMember.findUnique({
          where: { teamId_userId: { teamId: caseItem.teamId, userId } },
        });
        hasPermission = Boolean(member);
      }

      if (!hasPermission) {
        auditCaseAction(req, {
          userId,
          action: "cases.add_evidence",
          outcome: "blocked",
          severity: "warning",
          resourceId: id,
          metadata: { reason: "forbidden", evidenceId: body.evidenceId },
        });
        return reply.code(403).send({ message: "Forbidden" });
      }

      const evidence = await prisma.evidence.findUnique({
        where: { id: body.evidenceId },
      });

      if (!evidence) {
        auditCaseAction(req, {
          userId,
          action: "cases.add_evidence",
          outcome: "failure",
          severity: "warning",
          resourceId: id,
          metadata: { reason: "evidence_not_found", evidenceId: body.evidenceId },
        });
        return reply.code(404).send({ message: "Evidence not found" });
      }

      if (evidence.ownerUserId !== userId) {
        auditCaseAction(req, {
          userId,
          action: "cases.add_evidence",
          outcome: "blocked",
          severity: "warning",
          resourceId: id,
          metadata: { reason: "evidence_not_owned", evidenceId: body.evidenceId },
        });
        return reply.code(403).send({ message: "Evidence does not belong to you" });
      }

      // Phase O-blockers / A-2 — Cross-team IDOR fix. Before this
      // check, a user who is a member of team A and team B could
      // attach team-A evidence into a team-B case (any evidence they
      // owned, into any case they could write). The strict equality
      // of `evidence.teamId === case.teamId` (including null === null
      // for personal cases) closes the cross-workspace leak. Emits a
      // `CROSS_TEAM_ATTACH_BLOCKED` audit event so the security team
      // can investigate the attempt.
      const crossTeam = evaluateCrossTeamAttach({
        caseTeamId: caseItem.teamId,
        evidenceTeamId: evidence.teamId,
      });
      if (!crossTeam.allowed) {
        auditCaseAction(req, {
          userId,
          action: "cases.add_evidence",
          outcome: "blocked",
          severity: "critical",
          resourceId: id,
          metadata: {
            reason: "forbidden",
            denyCode: crossTeam.code,
            denyReason: crossTeam.reason,
            eventKind: "CROSS_TEAM_ATTACH_BLOCKED",
            evidenceId: body.evidenceId,
            caseTeamId: caseItem.teamId,
            evidenceTeamId: evidence.teamId,
          },
        });
        return reply.code(403).send({
          message: "Cross-workspace attach is not permitted.",
          code: crossTeam.code,
          detail: crossTeam.reason,
        });
      }

      if (evidence.deletedAt) {
        auditCaseAction(req, {
          userId,
          action: "cases.add_evidence",
          outcome: "blocked",
          severity: "warning",
          resourceId: id,
          metadata: { reason: "evidence_deleted", evidenceId: body.evidenceId },
        });
        return reply.code(400).send({ message: "Cannot add deleted evidence" });
      }

      const updated = await prisma.evidence.update({
        where: { id: body.evidenceId },
        data: {
          caseId: id,
          teamId: caseItem.teamId ?? null,
        },
        select: {
          id: true,
          type: true,
          status: true,
          createdAt: true,
          caseId: true,
          teamId: true,
        },
      });

      auditCaseAction(req, {
        userId,
        action: "cases.add_evidence",
        outcome: "success",
        resourceId: id,
        metadata: { evidenceId: body.evidenceId },
      });

      fireCaseAnalyticsEvent({
        eventType: "case_evidence_added",
        userId,
        req,
        entityId: id,
        metadata: { evidenceId: body.evidenceId },
      });

      return reply.code(200).send({ evidence: updated });
    }
  );

  app.delete(
    "/v1/cases/:id/evidence/:evidenceId",
    { preHandler: requireAuthAndLegal },
    async (req: FastifyRequest, reply) => {
      const id = z.string().uuid().parse((req.params as { id: string }).id);
      const evidenceId = z
        .string()
        .uuid()
        .parse((req.params as { evidenceId: string }).evidenceId);
      const userId = getAuthUserId(req);

      const caseItem = await prisma.case.findUnique({ where: { id } });
      if (!caseItem) {
        auditCaseAction(req, {
          userId,
          action: "cases.remove_evidence",
          outcome: "failure",
          severity: "warning",
          resourceId: id,
          metadata: { reason: "case_not_found", evidenceId },
        });
        return reply.code(404).send({ message: "Case not found" });
      }

      let hasPermission = caseItem.ownerUserId === userId;

      if (!hasPermission && caseItem.teamId) {
        const member = await prisma.teamMember.findUnique({
          where: { teamId_userId: { teamId: caseItem.teamId, userId } },
        });
        hasPermission = Boolean(member);
      }

      if (!hasPermission) {
        auditCaseAction(req, {
          userId,
          action: "cases.remove_evidence",
          outcome: "blocked",
          severity: "warning",
          resourceId: id,
          metadata: { reason: "forbidden", evidenceId },
        });
        return reply.code(403).send({ message: "Forbidden" });
      }

      const evidence = await prisma.evidence.findUnique({
        where: { id: evidenceId },
      });

      if (!evidence) {
        auditCaseAction(req, {
          userId,
          action: "cases.remove_evidence",
          outcome: "failure",
          severity: "warning",
          resourceId: id,
          metadata: { reason: "evidence_not_found", evidenceId },
        });
        return reply.code(404).send({ message: "Evidence not found" });
      }

      if (evidence.caseId !== id) {
        auditCaseAction(req, {
          userId,
          action: "cases.remove_evidence",
          outcome: "blocked",
          severity: "warning",
          resourceId: id,
          metadata: { reason: "evidence_not_in_case", evidenceId },
        });
        return reply.code(400).send({ message: "Evidence is not in this case" });
      }

      const updated = await prisma.evidence.update({
        where: { id: evidenceId },
        data: {
          caseId: null,
          teamId: null,
        },
        select: {
          id: true,
          type: true,
          status: true,
          createdAt: true,
          caseId: true,
          teamId: true,
        },
      });

      auditCaseAction(req, {
        userId,
        action: "cases.remove_evidence",
        outcome: "success",
        resourceId: id,
        metadata: { evidenceId },
      });

      fireCaseAnalyticsEvent({
        eventType: "case_evidence_removed",
        userId,
        req,
        entityId: id,
        metadata: { evidenceId },
      });

      return reply.code(200).send({ evidence: updated });
    }
  );

  app.get(
    "/v1/cases/:id/available-evidence",
    { preHandler: requireAuthAndLegal },
    async (req: FastifyRequest, reply) => {
      const id = z.string().uuid().parse((req.params as { id: string }).id);
      const ownerUserId = getAuthUserId(req);

      const caseItem = await prisma.case.findUnique({ where: { id } });
      if (!caseItem) {
        auditCaseAction(req, {
          userId: ownerUserId,
          action: "cases.available_evidence_list",
          outcome: "failure",
          severity: "warning",
          resourceId: id,
          metadata: { reason: "not_found" },
        });
        return reply.code(404).send({ message: "Case not found" });
      }

      if (caseItem.ownerUserId !== ownerUserId) {
        auditCaseAction(req, {
          userId: ownerUserId,
          action: "cases.available_evidence_list",
          outcome: "blocked",
          severity: "warning",
          resourceId: id,
          metadata: { reason: "forbidden" },
        });
        return reply.code(403).send({ message: "Forbidden" });
      }

      const evidence = await prisma.evidence.findMany({
        where: {
          ownerUserId,
          deletedAt: null,
          caseId: null,
        },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          type: true,
          status: true,
          createdAt: true,
        },
      });

      auditCaseAction(req, {
        userId: ownerUserId,
        action: "cases.available_evidence_list",
        outcome: "success",
        resourceId: id,
        metadata: { count: evidence.length },
      });

      return reply.code(200).send({ items: evidence });
    }
  );

  app.post(
    "/v1/cases/:id/share-team",
    { preHandler: requireAuthAndLegal },
    async (req: FastifyRequest, reply) => {
      const id = z.string().uuid().parse((req.params as { id: string }).id);
      const body = ShareTeamBody.parse(req.body);
      const ownerUserId = getAuthUserId(req);

      const caseItem = await prisma.case.findUnique({ where: { id } });
      if (!caseItem) {
        auditCaseAction(req, {
          userId: ownerUserId,
          action: "cases.share_team",
          outcome: "failure",
          severity: "warning",
          resourceId: id,
          metadata: { reason: "not_found", targetUserId: body.userId },
        });
        return reply.code(404).send({ message: "Case not found" });
      }

      if (caseItem.ownerUserId !== ownerUserId) {
        auditCaseAction(req, {
          userId: ownerUserId,
          action: "cases.share_team",
          outcome: "blocked",
          severity: "warning",
          resourceId: id,
          metadata: { reason: "forbidden", targetUserId: body.userId },
        });
        return reply.code(403).send({ message: "Forbidden" });
      }

      if (!caseItem.teamId) {
        auditCaseAction(req, {
          userId: ownerUserId,
          action: "cases.share_team",
          outcome: "blocked",
          severity: "warning",
          resourceId: id,
          metadata: { reason: "not_team_case", targetUserId: body.userId },
        });
        return reply.code(400).send({ message: "Case is not a team case" });
      }

      const teamMember = await prisma.teamMember.findUnique({
        where: { teamId_userId: { teamId: caseItem.teamId, userId: body.userId } },
      });

      if (!teamMember) {
        auditCaseAction(req, {
          userId: ownerUserId,
          action: "cases.share_team",
          outcome: "blocked",
          severity: "warning",
          resourceId: id,
          metadata: { reason: "user_not_in_team", targetUserId: body.userId },
        });
        return reply.code(400).send({ message: "User is not in this team" });
      }

      const access = await prisma.caseAccess.upsert({
        where: { caseId_userId: { caseId: id, userId: body.userId } },
        update: {},
        create: { caseId: id, userId: body.userId },
      });

      auditCaseAction(req, {
        userId: ownerUserId,
        action: "cases.share_team",
        outcome: "success",
        resourceId: id,
        metadata: { targetUserId: body.userId, accessId: access.id },
      });

      fireCaseAnalyticsEvent({
        eventType: "case_shared",
        userId: ownerUserId,
        req,
        entityId: id,
        metadata: { targetUserId: body.userId, mode: "team" },
      });

      return reply.code(201).send({ access });
    }
  );

  app.post(
    "/v1/cases/:id/share-email",
    { preHandler: requireAuthAndLegal },
    async (req: FastifyRequest, reply) => {
      const id = z.string().uuid().parse((req.params as { id: string }).id);
      const body = ShareEmailBody.parse(req.body);
      const ownerUserId = getAuthUserId(req);

      const caseItem = await prisma.case.findUnique({ where: { id } });
      if (!caseItem) {
        auditCaseAction(req, {
          userId: ownerUserId,
          action: "cases.share_email",
          outcome: "failure",
          severity: "warning",
          resourceId: id,
          metadata: { reason: "not_found", email: body.email },
        });
        return reply.code(404).send({ message: "Case not found" });
      }

      if (caseItem.ownerUserId !== ownerUserId) {
        auditCaseAction(req, {
          userId: ownerUserId,
          action: "cases.share_email",
          outcome: "blocked",
          severity: "warning",
          resourceId: id,
          metadata: { reason: "forbidden", email: body.email },
        });
        return reply.code(403).send({ message: "Forbidden" });
      }

      const usersWithEmail = await prisma.user.findMany({
        where: { email: body.email },
      });

      if (usersWithEmail.length === 0) {
        auditCaseAction(req, {
          userId: ownerUserId,
          action: "cases.share_email",
          outcome: "failure",
          severity: "warning",
          resourceId: id,
          metadata: { reason: "user_not_found", email: body.email },
        });
        return reply.code(404).send({ message: "No user found with that email" });
      }

      if (usersWithEmail.length > 1) {
        auditCaseAction(req, {
          userId: ownerUserId,
          action: "cases.share_email",
          outcome: "blocked",
          severity: "warning",
          resourceId: id,
          metadata: { reason: "multiple_users_found", email: body.email },
        });
        return reply
          .code(400)
          .send({ message: "Multiple users found with that email. Please contact support." });
      }

      const targetUser = usersWithEmail[0];

      const access = await prisma.caseAccess.upsert({
        where: { caseId_userId: { caseId: id, userId: targetUser.id } },
        update: {},
        create: { caseId: id, userId: targetUser.id },
      });

      auditCaseAction(req, {
        userId: ownerUserId,
        action: "cases.share_email",
        outcome: "success",
        resourceId: id,
        metadata: { targetUserId: targetUser.id, email: body.email, accessId: access.id },
      });

      fireCaseAnalyticsEvent({
        eventType: "case_shared",
        userId: ownerUserId,
        req,
        entityId: id,
        metadata: { targetUserId: targetUser.id, mode: "email" },
      });

      return reply.code(201).send({ access });
    }
  );

  app.delete(
    "/v1/cases/:id/access/:accessId",
    { preHandler: requireAuthAndLegal },
    async (req: FastifyRequest, reply) => {
      const id = z.string().uuid().parse((req.params as { id: string }).id);
      const accessId = z
        .string()
        .uuid()
        .parse((req.params as { accessId: string }).accessId);
      const ownerUserId = getAuthUserId(req);

      const caseItem = await prisma.case.findUnique({ where: { id } });
      if (!caseItem) {
        auditCaseAction(req, {
          userId: ownerUserId,
          action: "cases.access_revoke",
          outcome: "failure",
          severity: "warning",
          resourceId: id,
          metadata: { reason: "case_not_found", accessId },
        });
        return reply.code(404).send({ message: "Case not found" });
      }

      if (caseItem.ownerUserId !== ownerUserId) {
        auditCaseAction(req, {
          userId: ownerUserId,
          action: "cases.access_revoke",
          outcome: "blocked",
          severity: "warning",
          resourceId: id,
          metadata: { reason: "forbidden", accessId },
        });
        return reply.code(403).send({ message: "Forbidden" });
      }

      const access = await prisma.caseAccess.findUnique({
        where: { id: accessId },
      });

      if (!access || access.caseId !== id) {
        auditCaseAction(req, {
          userId: ownerUserId,
          action: "cases.access_revoke",
          outcome: "failure",
          severity: "warning",
          resourceId: id,
          metadata: { reason: "access_not_found", accessId },
        });
        return reply.code(404).send({ message: "Access record not found" });
      }

      await prisma.caseAccess.delete({ where: { id: accessId } });

      auditCaseAction(req, {
        userId: ownerUserId,
        action: "cases.access_revoke",
        outcome: "success",
        resourceId: id,
        metadata: { accessId, targetUserId: access.userId },
      });

      fireCaseAnalyticsEvent({
        eventType: "case_access_revoked",
        userId: ownerUserId,
        req,
        entityId: id,
        metadata: { accessId, targetUserId: access.userId },
      });

      return reply.code(204).send();
    }
  );

  // ===========================================================================
  // Phase 2.5B — Bulk case operations.
  //
  // Hard rules:
  //   - Capped at 100 ids per call (matches the reviewer-ops bulk
  //     pattern in `bulk-triage.service.ts`).
  //   - Each id is processed independently. A failure on one case
  //     never blocks the others — the caller gets a per-id outcome
  //     so they can correct the failures and retry.
  //   - Reuses `changeCaseStatus()` so the Phase 2.4 closure cascade
  //     fires, legal holds are respected, audit log writes, and
  //     transition rules apply uniformly.
  //   - Access is checked the same way the LIST endpoint does:
  //     ownerUserId, has access row, or member of the team. Cases
  //     the caller cannot see are SKIPPED with `not_accessible`, not
  //     enumerated as "found but forbidden".
  //   - 403 / 401 only fire for the whole batch when the caller is
  //     not authed; per-id permission failures are SKIPPED rows.
  // ===========================================================================
  const BulkCasesBody = z.object({
    ids: z.array(z.string().uuid()).min(1).max(100),
    action: z.enum(["CLOSE", "ARCHIVE", "RESOLVE"]),
    reason: z.string().max(400).optional(),
  });

  app.post(
    "/v1/cases/bulk",
    { preHandler: requireAuthAndLegal },
    async (req, reply) => {
      const userId = getAuthUserId(req);
      const parsed = BulkCasesBody.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({
          code: "INVALID_BODY",
          message:
            "ids (1-100 UUIDs) and action (CLOSE | ARCHIVE | RESOLVE) are required.",
        });
      }
      const { ids, action, reason } = parsed.data;

      // Resolve which cases the caller can actually mutate. Mirrors
      // the access predicate in GET /v1/cases.
      const memberTeams = await prisma.teamMember.findMany({
        where: { userId },
        select: { teamId: true },
      });
      const memberTeamIds = memberTeams.map((t) => t.teamId);
      const accessOr: Array<Record<string, unknown>> = [
        { ownerUserId: userId },
        { access: { some: { userId } } },
      ];
      if (memberTeamIds.length > 0) {
        accessOr.push({
          teamId: { in: memberTeamIds },
          access: { none: {} },
        });
      }
      const accessible = await prisma.case.findMany({
        where: { id: { in: ids }, OR: accessOr },
        select: { id: true },
      });
      const accessibleSet = new Set(accessible.map((c) => c.id));

      // The target status depends on the action. ARCHIVE goes through
      // CLOSED first per the transition table; we only call
      // changeCaseStatus once per id, so we accept ARCHIVE as a
      // single-step input that the caller intends to be the terminal
      // state. The transition validator will reject ARCHIVE on an
      // OPEN case — that's an honest SKIP with `invalid_transition`.
      const targetStatus =
        action === "CLOSE"
          ? "CLOSED"
          : action === "ARCHIVE"
            ? "ARCHIVED"
            : "RESOLVED";

      const results: Array<{
        id: string;
        outcome: "SUCCESS" | "SKIPPED";
        reason?: string;
      }> = [];

      for (const id of ids) {
        if (!accessibleSet.has(id)) {
          results.push({
            id,
            outcome: "SKIPPED",
            reason: "not_accessible",
          });
          continue;
        }
        try {
          await changeCaseStatus({
            caseId: id,
            toStatus: targetStatus,
            actorUserId: userId,
            reason: reason ?? null,
            ipAddress: req.ip ?? null,
            userAgent: readUserAgent(req) ?? null,
          });
          results.push({ id, outcome: "SUCCESS" });
        } catch (err) {
          if (err instanceof CaseError) {
            results.push({
              id,
              outcome: "SKIPPED",
              reason: err.code,
            });
          } else {
            // Unknown error: log internally + report a generic SKIP
            // so the batch can continue. The audit log already
            // captured the per-id success path; failures land in
            // the route-level error stream.
            req.log.warn(
              { err, caseId: id, action },
              "cases.bulk.case_failed",
            );
            results.push({
              id,
              outcome: "SKIPPED",
              reason: "internal_error",
            });
          }
        }
      }

      const successCount = results.filter(
        (r) => r.outcome === "SUCCESS",
      ).length;
      const skippedCount = results.length - successCount;

      // Single audit row summarising the bulk operation. Per-id
      // success rows are already written by changeCaseStatus.
      await appendPlatformAuditLog({
        userId,
        action: "cases.bulk_status_changed",
        category: "cases.lifecycle",
        severity: "info",
        source: "cases_routes_bulk",
        outcome: skippedCount === results.length ? "failure" : "success",
        resourceType: "case",
        resourceId: null,
        metadata: {
          action,
          requestedCount: ids.length,
          successCount,
          skippedCount,
          targetStatus,
        },
        ipAddress: req.ip ?? null,
        userAgent: readUserAgent(req) ?? null,
      });

      return reply.code(200).send({
        results,
        summary: {
          total: results.length,
          success: successCount,
          skipped: skippedCount,
        },
      });
    },
  );

  // ===========================================================================
  // Phase 2.5B — Dual case↔evidence link reconciler.
  //
  // The schema has two ways to associate evidence with a case:
  //   1. `Evidence.caseId` (legacy column, kept for backwards compat).
  //   2. `CaseEvidenceLink` (canonical join table with role / source /
  //      reason / linkedByUserId).
  //
  // The Phase 2.4 inspection flagged that these can diverge silently.
  // This endpoint is a READ-ONLY diagnostic that surfaces the
  // divergence for a single case. It is NOT a remediation endpoint —
  // remediation paths (`removeLegacyEvidenceCaseId`, manual link
  // creation) already exist.
  //
  // Access: same as case READ (ownerUserId, access row, or team
  // member). Returns 403 if the caller cannot see the case.
  // ===========================================================================
  app.get<{ Params: { id: string } }>(
    "/v1/cases/:id/link-reconciliation",
    { preHandler: requireAuthAndLegal },
    async (req, reply) => {
      const userId = getAuthUserId(req);
      const caseId = z.string().uuid().parse(req.params.id);

      // Permission check: the case must be visible to the caller.
      const memberTeams = await prisma.teamMember.findMany({
        where: { userId },
        select: { teamId: true },
      });
      const memberTeamIds = memberTeams.map((t) => t.teamId);
      const accessOr: Array<Record<string, unknown>> = [
        { ownerUserId: userId },
        { access: { some: { userId } } },
      ];
      if (memberTeamIds.length > 0) {
        accessOr.push({
          teamId: { in: memberTeamIds },
          access: { none: {} },
        });
      }
      const caseRow = await prisma.case.findFirst({
        where: { id: caseId, OR: accessOr },
        select: { id: true, teamId: true },
      });
      if (!caseRow) {
        return reply.code(404).send({
          code: "CASE_NOT_FOUND",
          message: "Case not found or not accessible.",
        });
      }

      const [legacyAttached, canonicalLinks] = await Promise.all([
        // Evidence rows with Evidence.caseId === this caseId.
        prisma.evidence.findMany({
          where: { caseId },
          select: { id: true, displayFileName: true, title: true },
        }),
        // Canonical CaseEvidenceLink rows for this case.
        prisma.caseEvidenceLink.findMany({
          where: { caseId },
          select: { evidenceId: true, role: true },
        }),
      ]);

      const canonicalEvidenceIds = new Set(
        canonicalLinks.map((l) => l.evidenceId),
      );

      // Inconsistency #1: evidence attached via legacy caseId but
      // missing from the canonical join table.
      const legacyOnly = legacyAttached
        .filter((e) => !canonicalEvidenceIds.has(e.id))
        .map((e) => ({
          evidenceId: e.id,
          displayName: e.title ?? e.displayFileName ?? null,
          attachmentKind: "legacy_case_id_only" as const,
        }));

      // Inconsistency #2: canonical link rows for evidence whose
      // Evidence.caseId !== this case (or is null). This is the
      // "soft-linked" case — canonical join exists, but the legacy
      // column wasn't migrated. Not an error, but useful for
      // operators to know.
      const legacyAttachedIds = new Set(legacyAttached.map((e) => e.id));
      const canonicalOnly = canonicalLinks
        .filter((l) => !legacyAttachedIds.has(l.evidenceId))
        .map((l) => ({
          evidenceId: l.evidenceId,
          role: l.role,
          attachmentKind: "canonical_link_only" as const,
        }));

      return reply.code(200).send({
        caseId,
        summary: {
          legacyAttachments: legacyAttached.length,
          canonicalLinks: canonicalLinks.length,
          legacyOnlyCount: legacyOnly.length,
          canonicalOnlyCount: canonicalOnly.length,
          inSync:
            legacyOnly.length === 0 && canonicalOnly.length === 0,
        },
        legacyOnly,
        canonicalOnly,
      });
    },
  );
}