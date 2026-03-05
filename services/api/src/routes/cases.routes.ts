import type { FastifyInstance, FastifyRequest } from "fastify";
import { Readable } from "node:stream";
import { z } from "zod";
import { prisma } from "../db.js";
import { hasRole } from "../services/rbac.js";
import * as prismaPkg from "@prisma/client";
import archiver from "archiver";
import { getObjectStream } from "../storage.js";
import { requireAuth } from "../middleware/auth.js";
import { getAuthUserId } from "../auth.js";

const CreateCaseBody = z.object({
  name: z.string().min(1).max(120),
  teamId: z.string().uuid().optional()
});
const AccessBody = z.object({ userId: z.string().uuid() });

export async function casesRoutes(app: FastifyInstance) {
  app.post("/v1/cases", { preHandler: requireAuth }, async (req, reply) => {
    const body = CreateCaseBody.parse(req.body);
    const ownerUserId = getAuthUserId(req);
    if (body.teamId) {
      const member = await prisma.teamMember.findUnique({
        where: { teamId_userId: { teamId: body.teamId, userId: ownerUserId } }
      });
      if (!member) return reply.code(403).send({ message: "Forbidden" });
    }
    const created = await prisma.case.create({
      data: {
        name: body.name,
        ownerUserId,
        teamId: body.teamId ?? null
      }
    });
    return reply.code(201).send(created);
  });

app.get("/v1/cases", { preHandler: requireAuth }, async (req, reply) => {
  const ownerUserId = getAuthUserId(req);

  const memberTeams = await prisma.teamMember.findMany({
    where: { userId: ownerUserId },
    select: { teamId: true }
  });
  const memberTeamIds = memberTeams.map((t) => t.teamId);

  // ✅ مهم: لا تضيف شرط team/public إذا ما عنده teams
  const or: any[] = [
    { ownerUserId },
    { access: { some: { userId: ownerUserId } } }
  ];

  // Team cases that are "team-visible" only (no explicit access rows)
  if (memberTeamIds.length > 0) {
    or.push({
      teamId: { in: memberTeamIds },
      access: { none: {} }
    });
  }

  const items = await prisma.case.findMany({
    where: { OR: or },
    orderBy: { createdAt: "desc" }
  });

  return reply.code(200).send({ items });
});
  app.get(
    "/v1/cases/:id",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply) => {
      const id = z.string().uuid().parse((req.params as { id: string }).id);
      const ownerUserId = getAuthUserId(req);
      const item = await prisma.case.findUnique({
        where: { id },
        include: { access: true }
      });
      if (!item) return reply.code(404).send({ message: "Case not found" });
      if (item.ownerUserId === ownerUserId) return reply.code(200).send({ case: item });
      if (item.access.some((a) => a.userId === ownerUserId)) {
        return reply.code(200).send({ case: item });
      }
      if (item.teamId && item.access.length === 0) {
        const member = await prisma.teamMember.findUnique({
          where: { teamId_userId: { teamId: item.teamId, userId: ownerUserId } }
        });
        if (member) return reply.code(200).send({ case: item });
      }
      return reply.code(403).send({ message: "Forbidden" });
    }
  );

  app.post(
    "/v1/cases/:id/access",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply) => {
      const id = z.string().uuid().parse((req.params as { id: string }).id);
      const body = AccessBody.parse(req.body);
      const ownerUserId = getAuthUserId(req);
      const item = await prisma.case.findUnique({
        where: { id },
        select: { id: true, teamId: true }
      });
      if (!item) return reply.code(404).send({ message: "Case not found" });
      if (!item.teamId) return reply.code(400).send({ message: "Case is not a team case" });
      const actor = await prisma.teamMember.findUnique({
        where: { teamId_userId: { teamId: item.teamId, userId: ownerUserId } }
      });
      if (!actor || !hasRole(actor.role, prismaPkg.TeamRole.ADMIN)) {
        return reply.code(403).send({ message: "Forbidden" });
      }
      const access = await prisma.caseAccess.upsert({
        where: { caseId_userId: { caseId: id, userId: body.userId } },
        update: {},
        create: { caseId: id, userId: body.userId }
      });
      return reply.code(201).send({ access });
    }
  );

  app.get(
    "/v1/cases/:id/export",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply) => {
      const id = z.string().uuid().parse((req.params as { id: string }).id);
      const ownerUserId = getAuthUserId(req);
      const item = await prisma.case.findUnique({
        where: { id },
        include: { access: true }
      });
      if (!item) return reply.code(404).send({ message: "Case not found" });
      if (item.ownerUserId !== ownerUserId) {
        let hasAccess = item.access.some((a) => a.userId === ownerUserId);
        if (!hasAccess && item.teamId && item.access.length === 0) {
          const member = await prisma.teamMember.findUnique({
            where: { teamId_userId: { teamId: item.teamId, userId: ownerUserId } }
          });
          hasAccess = Boolean(member);
        }
        if (!hasAccess) return reply.code(403).send({ message: "Forbidden" });
      }

      const evidence = await prisma.evidence.findMany({
        where: { caseId: id, deletedAt: null },
        include: { reports: { orderBy: { version: "desc" }, take: 1 } }
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
              createdAt: ev.createdAt.toISOString()
            }))
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
            key: report.storageKey
          });
          archive.append(stream as unknown as Readable, {
            name: `reports/${ev.id}/v${report.version}.pdf`
          });
        }
      }

      await archive.finalize();
      return reply.send(archive);
    }
  );
}
