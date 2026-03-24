import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import * as prismaPkg from "@prisma/client";
import { hasRole } from "../services/rbac.js";
import { getAuthUserId } from "../auth.js";
import { getEmailService } from "../services/email.service.js";

const CreateTeamBody = z.object({
  name: z.string().min(1).max(120),
});

const TeamRoleSchema = prismaPkg.TeamRole
  ? z.nativeEnum(prismaPkg.TeamRole)
  : z.enum(["OWNER", "ADMIN", "MEMBER", "VIEWER"]);

const RetentionPolicySchema = prismaPkg.RetentionPolicy
  ? z.nativeEnum(prismaPkg.RetentionPolicy)
  : z.enum(["YEAR_1", "YEAR_5", "FOREVER"]);

const InviteBody = z.object({
  email: z.string().email(),
  role: TeamRoleSchema.optional(),
});

const UpdateMemberBody = z.object({
  role: TeamRoleSchema,
});

const UpdateTeamBody = z.object({
  name: z.string().min(1).max(120).optional(),
  legalName: z.string().min(1).max(180).optional(),
  address: z.string().min(1).optional(),
  logoUrl: z.string().url().optional(),
  timezone: z.string().min(1).max(64).optional(),
  legalEmail: z.string().email().optional(),
  retentionPolicy: RetentionPolicySchema.optional(),
});

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function buildInviteUrl(token: string): string {
  const base = process.env.WEB_BASE_URL ?? "https://www.proovra.com";
  return `${base.replace(/\/+$/, "")}/invite/${token}`;
}

async function getActorMembership(teamId: string, userId: string) {
  return prisma.teamMember.findUnique({
    where: {
      teamId_userId: {
        teamId,
        userId,
      },
    },
  });
}

export async function teamsRoutes(app: FastifyInstance) {
  app.post("/v1/teams", { preHandler: requireAuth }, async (req, reply) => {
    const body = CreateTeamBody.parse(req.body);
    const ownerUserId = getAuthUserId(req);

    const team = await prisma.team.create({
      data: {
        name: body.name.trim(),
        ownerUserId,
        members: {
          create: {
            userId: ownerUserId,
            role: prismaPkg.TeamRole.OWNER,
          },
        },
      },
    });

    return reply.code(201).send(team);
  });

  app.get("/v1/teams", { preHandler: requireAuth }, async (req, reply) => {
    const userId = getAuthUserId(req);

    const teams = await prisma.team.findMany({
      where: {
        members: {
          some: { userId },
        },
      },
      include: {
        members: {
          where: { userId },
          select: { role: true },
        },
        _count: {
          select: {
            members: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    const items = await Promise.all(
      teams.map(async (team) => {
        const pendingInviteCount = await prisma.teamInvite.count({
          where: {
            teamId: team.id,
            acceptedAt: null,
            expiresAt: { gt: new Date() },
          },
        });

        const caseCount = await prisma.case.count({
          where: { teamId: team.id },
        });

        return {
          id: team.id,
          name: team.name,
          createdAt: team.createdAt,
          role: team.members[0]?.role ?? prismaPkg.TeamRole.VIEWER,
          memberCount: team._count.members,
          pendingInviteCount,
          caseCount,
        };
      })
    );

    return reply.code(200).send({ teams: items });
  });

  app.get(
    "/v1/teams/:id",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply) => {
      const teamId = z.string().uuid().parse((req.params as { id: string }).id);
      const userId = getAuthUserId(req);

      const team = await prisma.team.findUnique({
        where: { id: teamId },
        include: {
          members: true,
        },
      });

      if (!team) {
        return reply.code(404).send({ message: "Team not found" });
      }

      const actorMembership = team.members.find((m) => m.userId === userId);
      if (!actorMembership) {
        return reply.code(403).send({ message: "Forbidden" });
      }

      const userIds = team.members.map((m) => m.userId);
      const users = userIds.length
        ? await prisma.user.findMany({
            where: { id: { in: userIds } },
            select: {
              id: true,
              email: true,
              displayName: true,
            },
          })
        : [];

      const usersById = new Map(users.map((u) => [u.id, u]));

      const pendingInviteCount = await prisma.teamInvite.count({
        where: {
          teamId,
          acceptedAt: null,
          expiresAt: { gt: new Date() },
        },
      });

      const caseCount = await prisma.case.count({
        where: { teamId },
      });

      return reply.code(200).send({
        id: team.id,
        name: team.name,
        ownerUserId: team.ownerUserId,
        legalName: team.legalName,
        address: team.address,
        logoUrl: team.logoUrl,
        timezone: team.timezone,
        legalEmail: team.legalEmail,
        retentionPolicy: team.retentionPolicy,
        currentUserRole: actorMembership.role,
        canManageMembers: hasRole(actorMembership.role, prismaPkg.TeamRole.ADMIN),
        stats: {
          memberCount: team.members.length,
          pendingInviteCount,
          caseCount,
        },
        members: team.members.map((member) => {
          const user = usersById.get(member.userId);
          return {
            id: member.id,
            userId: member.userId,
            role: member.role,
            createdAt: member.createdAt,
            user: user
              ? {
                  id: user.id,
                  email: user.email ?? undefined,
                  displayName: user.displayName ?? undefined,
                }
              : undefined,
            label: user?.displayName || user?.email || member.userId,
          };
        }),
      });
    }
  );

  app.get(
    "/v1/teams/:id/cases",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply) => {
      const teamId = z.string().uuid().parse((req.params as { id: string }).id);
      const userId = getAuthUserId(req);

      const actor = await getActorMembership(teamId, userId);
      if (!actor) {
        return reply.code(403).send({ message: "Forbidden" });
      }

      const items = await prisma.case.findMany({
        where: { teamId },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          name: true,
          createdAt: true,
          ownerUserId: true,
        },
      });

      return reply.code(200).send({ items });
    }
  );

  app.get(
    "/v1/teams/:id/invites",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply) => {
      const teamId = z.string().uuid().parse((req.params as { id: string }).id);
      const userId = getAuthUserId(req);

      const actor = await getActorMembership(teamId, userId);
      if (!actor || !hasRole(actor.role, prismaPkg.TeamRole.ADMIN)) {
        return reply.code(403).send({ message: "Forbidden" });
      }

      const invites = await prisma.teamInvite.findMany({
        where: {
          teamId,
          acceptedAt: null,
          expiresAt: { gt: new Date() },
        },
        orderBy: { createdAt: "desc" },
      });

      return reply.code(200).send({
        invites: invites.map((invite) => ({
          id: invite.id,
          email: invite.email,
          role: invite.role,
          createdAt: invite.createdAt,
          expiresAt: invite.expiresAt,
          inviteUrl: buildInviteUrl(invite.token),
        })),
      });
    }
  );

  app.patch(
    "/v1/teams/:id",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply) => {
      const teamId = z.string().uuid().parse((req.params as { id: string }).id);
      const body = UpdateTeamBody.parse(req.body);
      const userId = getAuthUserId(req);

      const actor = await getActorMembership(teamId, userId);
      if (!actor || !hasRole(actor.role, prismaPkg.TeamRole.ADMIN)) {
        return reply.code(403).send({ message: "Forbidden" });
      }

      const updated = await prisma.team.update({
        where: { id: teamId },
        data: {
          name: body.name?.trim() ?? undefined,
          legalName: body.legalName ?? undefined,
          address: body.address ?? undefined,
          logoUrl: body.logoUrl ?? undefined,
          timezone: body.timezone ?? undefined,
          legalEmail: body.legalEmail ? normalizeEmail(body.legalEmail) : undefined,
          retentionPolicy: body.retentionPolicy ?? undefined,
        },
      });

      return reply.code(200).send(updated);
    }
  );

  app.post(
    "/v1/teams/:id/invites",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply) => {
      const teamId = z.string().uuid().parse((req.params as { id: string }).id);
      const body = InviteBody.parse(req.body);
      const userId = getAuthUserId(req);
      const email = normalizeEmail(body.email);

      const actor = await getActorMembership(teamId, userId);
      if (!actor || !hasRole(actor.role, prismaPkg.TeamRole.ADMIN)) {
        return reply.code(403).send({ message: "Forbidden" });
      }

      const existingPendingInvite = await prisma.teamInvite.findFirst({
        where: {
          teamId,
          email,
          acceptedAt: null,
          expiresAt: { gt: new Date() },
        },
        orderBy: { createdAt: "desc" },
      });

      if (existingPendingInvite) {
        let emailSent = false;

        try {
          const emailService = getEmailService();
          if (emailService.isConfigured()) {
            const team = await prisma.team.findUnique({
              where: { id: teamId },
              select: { name: true },
            });

            await emailService.sendTeamInvitation(
              email,
              team?.name || "PROOVRA",
              existingPendingInvite.token
            );

            emailSent = true;
          }
        } catch (err) {
          req.log.error({ err, teamId, email }, "Failed to resend existing invite email");
        }

        return reply.code(200).send({
          invite: existingPendingInvite,
          inviteUrl: buildInviteUrl(existingPendingInvite.token),
          emailSent,
          existing: true,
          message: emailSent
            ? "Existing invitation resent successfully"
            : "Existing invitation already pending",
        });
      }

      const usersWithEmail = await prisma.user.findMany({
        where: { email },
        select: { id: true },
      });

      if (usersWithEmail.length === 1) {
        const existingMember = await prisma.teamMember.findUnique({
          where: {
            teamId_userId: {
              teamId,
              userId: usersWithEmail[0].id,
            },
          },
        });

        if (existingMember) {
          return reply.code(400).send({
            message: "That user is already a member of this team",
          });
        }
      }

      const token = randomUUID().replace(/-/g, "");
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

      const invite = await prisma.teamInvite.create({
        data: {
          teamId,
          email,
          role: body.role ?? prismaPkg.TeamRole.MEMBER,
          token,
          invitedByUserId: userId,
          expiresAt,
        },
      });

      let emailSent = false;
      try {
        const emailService = getEmailService();
        if (emailService.isConfigured()) {
          const team = await prisma.team.findUnique({
            where: { id: teamId },
            select: { name: true },
          });

          await emailService.sendTeamInvitation(
            email,
            team?.name || "PROOVRA",
            token
          );

          emailSent = true;
        }
      } catch (err) {
        req.log.error({ err, teamId, email }, "Failed to send invite email");
      }

      return reply.code(201).send({
        invite,
        inviteUrl: buildInviteUrl(token),
        emailSent,
        existing: false,
        message: emailSent
          ? "Invitation sent successfully"
          : "Invitation created successfully",
      });
    }
  );

  app.delete(
    "/v1/teams/:id/invites/:inviteId",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply) => {
      const params = req.params as { id: string; inviteId: string };
      const teamId = z.string().uuid().parse(params.id);
      const inviteId = z.string().uuid().parse(params.inviteId);
      const userId = getAuthUserId(req);

      const actor = await getActorMembership(teamId, userId);
      if (!actor || !hasRole(actor.role, prismaPkg.TeamRole.ADMIN)) {
        return reply.code(403).send({ message: "Forbidden" });
      }

      const invite = await prisma.teamInvite.findUnique({
        where: { id: inviteId },
      });

      if (!invite || invite.teamId !== teamId) {
        return reply.code(404).send({ message: "Invite not found" });
      }

      await prisma.teamInvite.delete({
        where: { id: inviteId },
      });

      return reply.code(204).send();
    }
  );

  app.patch(
    "/v1/teams/:id/members/:memberId",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply) => {
      const params = req.params as { id: string; memberId: string };
      const teamId = z.string().uuid().parse(params.id);
      const memberId = z.string().uuid().parse(params.memberId);
      const body = UpdateMemberBody.parse(req.body);
      const userId = getAuthUserId(req);

      const actor = await getActorMembership(teamId, userId);
      if (!actor || !hasRole(actor.role, prismaPkg.TeamRole.ADMIN)) {
        return reply.code(403).send({ message: "Forbidden" });
      }

      const target = await prisma.teamMember.findUnique({
        where: { id: memberId },
      });

      if (!target || target.teamId !== teamId) {
        return reply.code(404).send({ message: "Member not found" });
      }

      if (target.role === prismaPkg.TeamRole.OWNER) {
        return reply.code(400).send({ message: "Owner role cannot be changed" });
      }

      const updated = await prisma.teamMember.update({
        where: { id: memberId },
        data: { role: body.role },
      });

      return reply.code(200).send({ member: updated });
    }
  );

  app.delete(
    "/v1/teams/:id/members/:memberId",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply) => {
      const params = req.params as { id: string; memberId: string };
      const teamId = z.string().uuid().parse(params.id);
      const memberId = z.string().uuid().parse(params.memberId);
      const userId = getAuthUserId(req);

      const actor = await getActorMembership(teamId, userId);
      if (!actor || !hasRole(actor.role, prismaPkg.TeamRole.ADMIN)) {
        return reply.code(403).send({ message: "Forbidden" });
      }

      const target = await prisma.teamMember.findUnique({
        where: { id: memberId },
      });

      if (!target || target.teamId !== teamId) {
        return reply.code(404).send({ message: "Member not found" });
      }

      if (target.role === prismaPkg.TeamRole.OWNER) {
        return reply.code(400).send({ message: "Owner cannot be removed" });
      }

      await prisma.teamMember.delete({
        where: { id: memberId },
      });

      return reply.code(204).send();
    }
  );

  app.post(
    "/v1/teams/invites/:token/accept",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply) => {
      const token = z.string().min(8).parse((req.params as { token: string }).token);
      const userId = getAuthUserId(req);

      const invite = await prisma.teamInvite.findUnique({
        where: { token },
      });

      if (!invite) {
        return reply.code(404).send({ message: "Invite not found" });
      }

      if (invite.acceptedAt) {
        return reply.code(400).send({ message: "Invite already accepted" });
      }

      if (invite.expiresAt.getTime() < Date.now()) {
        return reply.code(400).send({ message: "Invite expired" });
      }

      const currentUser = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          email: true,
        },
      });

      const currentEmail = normalizeEmail(currentUser?.email ?? "");
      if (!currentEmail || currentEmail !== normalizeEmail(invite.email)) {
        return reply.code(403).send({
          message: "You must be signed in with the invited email address",
        });
      }

      await prisma.teamMember.upsert({
        where: {
          teamId_userId: {
            teamId: invite.teamId,
            userId,
          },
        },
        update: { role: invite.role },
        create: {
          teamId: invite.teamId,
          userId,
          role: invite.role,
        },
      });

      const updated = await prisma.teamInvite.update({
        where: { id: invite.id },
        data: { acceptedAt: new Date() },
      });

      return reply.code(200).send({ invite: updated });
    }
  );
}