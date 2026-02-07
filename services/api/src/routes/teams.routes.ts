import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import * as prismaPkg from "@prisma/client";
import { hasRole } from "../services/rbac.js";
import { getAuthUserId } from "../auth.js";

const CreateTeamBody = z.object({ name: z.string().min(1).max(120) });
const TeamRoleSchema = prismaPkg.TeamRole
  ? z.nativeEnum(prismaPkg.TeamRole)
  : z.enum(["OWNER", "ADMIN", "MEMBER", "VIEWER"]);
const RetentionPolicySchema = prismaPkg.RetentionPolicy
  ? z.nativeEnum(prismaPkg.RetentionPolicy)
  : z.enum(["YEAR_1", "YEAR_5", "FOREVER"]);

const AddMemberBody = z.object({
  userId: z.string().uuid(),
  role: TeamRoleSchema
});
const InviteBody = z.object({
  email: z.string().email(),
  role: TeamRoleSchema.optional()
});
const UpdateMemberBody = z.object({
  role: TeamRoleSchema
});
const UpdateTeamBody = z.object({
  legalName: z.string().min(1).max(180).optional(),
  address: z.string().min(1).optional(),
  logoUrl: z.string().url().optional(),
  timezone: z.string().min(1).max(64).optional(),
  legalEmail: z.string().email().optional(),
  retentionPolicy: RetentionPolicySchema.optional()
});

export async function teamsRoutes(app: FastifyInstance) {
  app.post("/v1/teams", { preHandler: requireAuth }, async (req, reply) => {
    const body = CreateTeamBody.parse(req.body);
    const ownerUserId = getAuthUserId(req);
    const team = await prisma.team.create({
      data: {
        name: body.name,
        ownerUserId,
        members: {
          create: {
            userId: ownerUserId,
            role: prismaPkg.TeamRole.OWNER
          }
        }
      }
    });
    return reply.code(201).send(team);
  });

  app.get("/v1/teams", { preHandler: requireAuth }, async (req, reply) => {
    const ownerUserId = getAuthUserId(req);
    const teams = await prisma.team.findMany({
      where: {
        members: {
          some: { userId: ownerUserId }
        }
      },
      orderBy: { createdAt: "desc" }
    });
    return reply.code(200).send({ teams });
  });

  app.get(
    "/v1/teams/:id",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply) => {
      const id = z.string().uuid().parse((req.params as { id: string }).id);
      const team = await prisma.team.findUnique({
        where: { id },
        include: { members: true }
      });
      if (!team) return reply.code(404).send({ message: "Team not found" });
      const ownerUserId = getAuthUserId(req);
      const member = team.members.find((m) => m.userId === ownerUserId);
      if (!member) return reply.code(403).send({ message: "Forbidden" });
      return reply.code(200).send(team);
    }
  );

  app.get(
    "/v1/teams/:id/invites",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply) => {
      const id = z.string().uuid().parse((req.params as { id: string }).id);
      const ownerUserId = getAuthUserId(req);
      const member = await prisma.teamMember.findUnique({
        where: { teamId_userId: { teamId: id, userId: ownerUserId } }
      });
      if (!member || !hasRole(member.role, prismaPkg.TeamRole.ADMIN)) {
        return reply.code(403).send({ message: "Forbidden" });
      }
      const invites = await prisma.teamInvite.findMany({
        where: { teamId: id },
        orderBy: { createdAt: "desc" }
      });
      return reply.code(200).send({ invites });
    }
  );

  app.patch(
    "/v1/teams/:id",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply) => {
      const id = z.string().uuid().parse((req.params as { id: string }).id);
      const body = UpdateTeamBody.parse(req.body);
      const ownerUserId = getAuthUserId(req);
      const member = await prisma.teamMember.findUnique({
        where: { teamId_userId: { teamId: id, userId: ownerUserId } }
      });
      if (!member || !hasRole(member.role, prismaPkg.TeamRole.ADMIN)) {
        return reply.code(403).send({ message: "Forbidden" });
      }
      const updated = await prisma.team.update({
        where: { id },
        data: {
          legalName: body.legalName ?? undefined,
          address: body.address ?? undefined,
          logoUrl: body.logoUrl ?? undefined,
          timezone: body.timezone ?? undefined,
          legalEmail: body.legalEmail ?? undefined,
          retentionPolicy: body.retentionPolicy ?? undefined
        }
      });
      return reply.code(200).send(updated);
    }
  );

  app.post(
    "/v1/teams/:id/members",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply) => {
      const id = z.string().uuid().parse((req.params as { id: string }).id);
      const body = AddMemberBody.parse(req.body);
      const ownerUserId = getAuthUserId(req);
      const member = await prisma.teamMember.findUnique({
        where: { teamId_userId: { teamId: id, userId: ownerUserId } }
      });
      if (!member || !hasRole(member.role, prismaPkg.TeamRole.ADMIN)) {
        return reply.code(403).send({ message: "Forbidden" });
      }
      const created = await prisma.teamMember.create({
        data: {
          teamId: id,
          userId: body.userId,
          role: body.role
        }
      });
      return reply.code(201).send(created);
    }
  );

  app.patch(
    "/v1/teams/:id/members/:userId",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply) => {
      const id = z.string().uuid().parse((req.params as { id: string }).id);
      const targetUserId = z
        .string()
        .uuid()
        .parse((req.params as { userId: string }).userId);
      const body = UpdateMemberBody.parse(req.body);
      const ownerUserId = getAuthUserId(req);
      const member = await prisma.teamMember.findUnique({
        where: { teamId_userId: { teamId: id, userId: ownerUserId } }
      });
      if (!member || !hasRole(member.role, prismaPkg.TeamRole.ADMIN)) {
        return reply.code(403).send({ message: "Forbidden" });
      }
      const updated = await prisma.teamMember.update({
        where: { teamId_userId: { teamId: id, userId: targetUserId } },
        data: { role: body.role }
      });
      return reply.code(200).send({ member: updated });
    }
  );

  app.post(
    "/v1/teams/:id/invites",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply) => {
      const id = z.string().uuid().parse((req.params as { id: string }).id);
      const body = InviteBody.parse(req.body);
      const ownerUserId = getAuthUserId(req);
      const member = await prisma.teamMember.findUnique({
        where: { teamId_userId: { teamId: id, userId: ownerUserId } }
      });
      if (!member || !hasRole(member.role, prismaPkg.TeamRole.ADMIN)) {
        return reply.code(403).send({ message: "Forbidden" });
      }
      const token = randomUUID().replace(/-/g, "");
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      const invite = await prisma.teamInvite.create({
        data: {
          teamId: id,
          email: body.email,
          role: body.role ?? prismaPkg.TeamRole.MEMBER,
          token,
          invitedByUserId: ownerUserId,
          expiresAt
        }
      });
      const base = process.env.WEB_BASE_URL ?? "https://www.proovra.com";
      return reply.code(201).send({
        invite,
        inviteUrl: `${base.replace(/\/+$/, "")}/invite/${token}`
      });
    }
  );

  app.post(
    "/v1/teams/invites/:token/accept",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply) => {
      const token = z.string().min(8).parse((req.params as { token: string }).token);
      const userId = getAuthUserId(req);
      const invite = await prisma.teamInvite.findUnique({
        where: { token }
      });
      if (!invite) return reply.code(404).send({ message: "Invite not found" });
      if (invite.acceptedAt) return reply.code(400).send({ message: "Invite already accepted" });
      if (invite.expiresAt.getTime() < Date.now()) {
        return reply.code(400).send({ message: "Invite expired" });
      }

      await prisma.teamMember.upsert({
        where: { teamId_userId: { teamId: invite.teamId, userId } },
        update: { role: invite.role },
        create: { teamId: invite.teamId, userId, role: invite.role }
      });

      const updated = await prisma.teamInvite.update({
        where: { id: invite.id },
        data: { acceptedAt: new Date() }
      });
      return reply.code(200).send({ invite: updated });
    }
  );
}
