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

const RenameCaseBody = z.object({
  name: z.string().min(1).max(120)
});

const AddEvidenceBody = z.object({
  evidenceId: z.string().uuid()
});

const ShareTeamBody = z.object({
  userId: z.string().uuid()
});

const ShareEmailBody = z.object({
  email: z.string().email()
});

const AccessBody = z.object({
  userId: z.string().uuid()
});

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

    const or: any[] = [
      { ownerUserId },
      { access: { some: { userId: ownerUserId } } }
    ];

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
        include: {
          access: {
            include: {
              user: {
                select: {
                  id: true,
                  email: true,
                  displayName: true
                }
              }
            }
          }
        }
      });

      if (!item) return reply.code(404).send({ message: "Case not found" });

      if (item.ownerUserId === ownerUserId) {
        return reply.code(200).send({ case: item });
      }

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
      if (!item.teamId) {
        return reply.code(400).send({ message: "Case is not a team case" });
      }

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

  app.get(
    "/v1/cases/:id/team-members",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply) => {
      const id = z.string().uuid().parse((req.params as { id: string }).id);
      const ownerUserId = getAuthUserId(req);

      const caseItem = await prisma.case.findUnique({
        where: { id },
        select: { id: true, teamId: true, ownerUserId: true }
      });

      if (!caseItem) return reply.code(404).send({ message: "Case not found" });
      if (caseItem.ownerUserId !== ownerUserId) {
        return reply.code(403).send({ message: "Forbidden" });
      }
      if (!caseItem.teamId) {
        return reply.code(400).send({ message: "Case is not a team case" });
      }

      const members = await prisma.teamMember.findMany({
        where: { teamId: caseItem.teamId },
        include: {
          user: {
            select: {
              id: true,
              email: true,
              displayName: true
            }
          }
        }
      });

      return reply.code(200).send({
        items: members.map((m) => ({
          userId: m.user.id,
          email: m.user.email,
          displayName: m.user.displayName,
          label: m.user.displayName || m.user.email || m.user.id
        }))
      });
    }
  );

  app.patch(
    "/v1/cases/:id",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply) => {
      const id = z.string().uuid().parse((req.params as { id: string }).id);
      const body = RenameCaseBody.parse(req.body);
      const ownerUserId = getAuthUserId(req);

      const item = await prisma.case.findUnique({ where: { id } });
      if (!item) return reply.code(404).send({ message: "Case not found" });
      if (item.ownerUserId !== ownerUserId) {
        return reply.code(403).send({ message: "Forbidden" });
      }

      const updated = await prisma.case.update({
        where: { id },
        data: { name: body.name }
      });

      return reply.code(200).send(updated);
    }
  );

  app.delete(
    "/v1/cases/:id",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply) => {
      const id = z.string().uuid().parse((req.params as { id: string }).id);
      const ownerUserId = getAuthUserId(req);

      const item = await prisma.case.findUnique({ where: { id } });
      if (!item) return reply.code(404).send({ message: "Case not found" });
      if (item.ownerUserId !== ownerUserId) {
        return reply.code(403).send({ message: "Forbidden" });
      }

      await prisma.evidence.updateMany({
        where: { caseId: id },
        data: { caseId: null }
      });

      await prisma.caseAccess.deleteMany({ where: { caseId: id } });
      await prisma.case.delete({ where: { id } });

      return reply.code(204).send();
    }
  );

  app.post(
    "/v1/cases/:id/evidence",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply) => {
      const id = z.string().uuid().parse((req.params as { id: string }).id);
      const body = AddEvidenceBody.parse(req.body);
      const ownerUserId = getAuthUserId(req);

      const caseItem = await prisma.case.findUnique({ where: { id } });
      if (!caseItem) return reply.code(404).send({ message: "Case not found" });
      if (caseItem.ownerUserId !== ownerUserId) {
        return reply.code(403).send({ message: "Forbidden" });
      }

      const evidence = await prisma.evidence.findUnique({
        where: { id: body.evidenceId }
      });

      if (!evidence) return reply.code(404).send({ message: "Evidence not found" });
      if (evidence.ownerUserId !== ownerUserId) {
        return reply.code(403).send({ message: "Evidence does not belong to you" });
      }
      if (evidence.deletedAt) {
        return reply.code(400).send({ message: "Cannot add deleted evidence" });
      }

      const updated = await prisma.evidence.update({
        where: { id: body.evidenceId },
        data: { caseId: id },
        select: {
          id: true,
          type: true,
          status: true,
          createdAt: true,
          caseId: true
        }
      });

      return reply.code(200).send({ evidence: updated });
    }
  );

  app.delete(
    "/v1/cases/:id/evidence/:evidenceId",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply) => {
      const id = z.string().uuid().parse((req.params as { id: string }).id);
      const evidenceId = z
        .string()
        .uuid()
        .parse((req.params as { evidenceId: string }).evidenceId);
      const ownerUserId = getAuthUserId(req);

      const caseItem = await prisma.case.findUnique({ where: { id } });
      if (!caseItem) return reply.code(404).send({ message: "Case not found" });
      if (caseItem.ownerUserId !== ownerUserId) {
        return reply.code(403).send({ message: "Forbidden" });
      }

      const evidence = await prisma.evidence.findUnique({
        where: { id: evidenceId }
      });

      if (!evidence) return reply.code(404).send({ message: "Evidence not found" });
      if (evidence.caseId !== id) {
        return reply.code(400).send({ message: "Evidence is not in this case" });
      }

      const updated = await prisma.evidence.update({
        where: { id: evidenceId },
        data: { caseId: null },
        select: {
          id: true,
          type: true,
          status: true,
          createdAt: true,
          caseId: true
        }
      });

      return reply.code(200).send({ evidence: updated });
    }
  );

  app.get(
    "/v1/cases/:id/available-evidence",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply) => {
      const id = z.string().uuid().parse((req.params as { id: string }).id);
      const ownerUserId = getAuthUserId(req);

      const caseItem = await prisma.case.findUnique({ where: { id } });
      if (!caseItem) return reply.code(404).send({ message: "Case not found" });
      if (caseItem.ownerUserId !== ownerUserId) {
        return reply.code(403).send({ message: "Forbidden" });
      }

      const evidence = await prisma.evidence.findMany({
        where: {
          ownerUserId,
          deletedAt: null,
          caseId: null
        },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          type: true,
          status: true,
          createdAt: true
        }
      });

      return reply.code(200).send({ items: evidence });
    }
  );

  app.post(
    "/v1/cases/:id/share-team",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply) => {
      const id = z.string().uuid().parse((req.params as { id: string }).id);
      const body = ShareTeamBody.parse(req.body);
      const ownerUserId = getAuthUserId(req);

      const caseItem = await prisma.case.findUnique({ where: { id } });
      if (!caseItem) return reply.code(404).send({ message: "Case not found" });
      if (caseItem.ownerUserId !== ownerUserId) {
        return reply.code(403).send({ message: "Forbidden" });
      }
      if (!caseItem.teamId) {
        return reply.code(400).send({ message: "Case is not a team case" });
      }

      const teamMember = await prisma.teamMember.findUnique({
        where: { teamId_userId: { teamId: caseItem.teamId, userId: body.userId } }
      });

      if (!teamMember) {
        return reply.code(400).send({ message: "User is not in this team" });
      }

      const access = await prisma.caseAccess.upsert({
        where: { caseId_userId: { caseId: id, userId: body.userId } },
        update: {},
        create: { caseId: id, userId: body.userId }
      });

      return reply.code(201).send({ access });
    }
  );

  app.post(
    "/v1/cases/:id/share-email",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply) => {
      const id = z.string().uuid().parse((req.params as { id: string }).id);
      const body = ShareEmailBody.parse(req.body);
      const ownerUserId = getAuthUserId(req);

      const caseItem = await prisma.case.findUnique({ where: { id } });
      if (!caseItem) return reply.code(404).send({ message: "Case not found" });
      if (caseItem.ownerUserId !== ownerUserId) {
        return reply.code(403).send({ message: "Forbidden" });
      }

      const usersWithEmail = await prisma.user.findMany({
        where: { email: body.email }
      });

      if (usersWithEmail.length === 0) {
        return reply.code(404).send({ message: "No user found with that email" });
      }

      if (usersWithEmail.length > 1) {
        return reply
          .code(400)
          .send({ message: "Multiple users found with that email. Please contact support." });
      }

      const targetUser = usersWithEmail[0];

      const access = await prisma.caseAccess.upsert({
        where: { caseId_userId: { caseId: id, userId: targetUser.id } },
        update: {},
        create: { caseId: id, userId: targetUser.id }
      });

      return reply.code(201).send({ access });
    }
  );

  app.delete(
    "/v1/cases/:id/access/:accessId",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply) => {
      const id = z.string().uuid().parse((req.params as { id: string }).id);
      const accessId = z
        .string()
        .uuid()
        .parse((req.params as { accessId: string }).accessId);
      const ownerUserId = getAuthUserId(req);

      const caseItem = await prisma.case.findUnique({ where: { id } });
      if (!caseItem) return reply.code(404).send({ message: "Case not found" });
      if (caseItem.ownerUserId !== ownerUserId) {
        return reply.code(403).send({ message: "Forbidden" });
      }

      const access = await prisma.caseAccess.findUnique({
        where: { id: accessId }
      });

      if (!access || access.caseId !== id) {
        return reply.code(404).send({ message: "Access record not found" });
      }

      await prisma.caseAccess.delete({ where: { id: accessId } });
      return reply.code(204).send();
    }
  );
}