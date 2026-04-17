import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import {
  assertTeamSeatAvailable,
  getWorkspaceUsage,
} from "../services/workspace-usage.service.js";
import {
  getPersonalWorkspaceScope,
  getTeamWorkspaceScope,
} from "../services/workspace-billing.service.js";
import { refreshTeamSeatState } from "../services/billing.service.js";
import { getPlanCapabilities } from "../services/plan-catalog.service.js";
import * as prismaPkg from "@prisma/client";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { requireLegalAcceptance } from "../middleware/require-legal-acceptance.js";
import { hasRole } from "../services/rbac.js";
import { getAuthUserId } from "../auth.js";
import { getEmailService } from "../services/email.service.js";
import { appendPlatformAuditLog } from "../services/platform-audit-log.service.js";
import { writeAnalyticsEvent } from "../services/analytics-event.service.js";

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

async function getTeamMemberByMemberId(teamId: string, memberId: string) {
  return prisma.teamMember.findFirst({
    where: {
      id: memberId,
      teamId,
    },
  });
}

async function createActivity(
  teamId: string,
  eventType: string,
  targetType: string,
  actorUserId: string | null,
  targetId?: string | null,
  metadata?: Prisma.InputJsonValue
) {
  try {
    const data: Prisma.TeamActivityUncheckedCreateInput = {
      teamId,
      eventType,
      targetType,
      actorUserId: actorUserId ?? null,
      targetId: targetId ?? null,
      ...(metadata !== undefined ? { metadata } : {}),
    };

    await prisma.teamActivity.create({ data });
  } catch (err) {
    console.error("Failed to log team activity:", err);
  }
}

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

function auditTeamAction(
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
    category: "teams",
    severity: params.severity ?? "info",
    source: "api_teams",
    outcome: params.outcome ?? "success",
    resourceType: "team",
    resourceId: params.resourceId ?? null,
    requestId: req.id,
    metadata: params.metadata ?? {},
    ipAddress: req.ip,
    userAgent: readUserAgent(req),
  }).catch(() => null);
}

function fireTeamAnalyticsEvent(params: {
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
    entityType: params.entityType ?? "team",
    entityId: params.entityId ?? null,
    severity: params.severity ?? "info",
    metadata: params.metadata ?? {},
    req: params.req,
    skipSessionUpsert: true,
  }).catch(() => null);
}

async function assertUserCanCreateAnotherTeam(ownerUserId: string) {
  const personalScope = await getPersonalWorkspaceScope(ownerUserId);
  const caps = getPlanCapabilities(personalScope.plan);
  const maxOwnedTeams = Math.max(0, caps.maxOwnedTeams ?? 0);

  if (maxOwnedTeams <= 0) {
    const err: Error & {
      statusCode?: number;
      code?: string;
      details?: Record<string, unknown>;
    } = new Error("Your current plan does not allow team creation");
    err.statusCode = 409;
    err.code = "TEAM_CREATION_NOT_ALLOWED";
    err.details = {
      plan: personalScope.plan,
      maxOwnedTeams,
    };
    throw err;
  }

  const ownedTeamCount = await prisma.team.count({
    where: { ownerUserId },
  });

  if (ownedTeamCount >= maxOwnedTeams) {
    const err: Error & {
      statusCode?: number;
      code?: string;
      details?: Record<string, unknown>;
    } = new Error("Team limit reached for current plan");
    err.statusCode = 409;
    err.code = "TEAM_WORKSPACE_LIMIT_REACHED";
    err.details = {
      plan: personalScope.plan,
      maxOwnedTeams,
      ownedTeamCount,
    };
    throw err;
  }

  return {
    plan: personalScope.plan,
    maxOwnedTeams,
    ownedTeamCount,
  };
}

export async function teamsRoutes(app: FastifyInstance) {
  app.post("/v1/teams", { preHandler: requireAuthAndLegal }, async (req, reply) => {
    const body = CreateTeamBody.parse(req.body);
    const ownerUserId = getAuthUserId(req);

    try {
      const ownershipState = await assertUserCanCreateAnotherTeam(ownerUserId);

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

      auditTeamAction(req, {
        userId: ownerUserId,
        action: "teams.create",
        outcome: "success",
        resourceId: team.id,
        metadata: {
          name: team.name,
          plan: ownershipState.plan,
          ownedTeamCountBeforeCreate: ownershipState.ownedTeamCount,
          maxOwnedTeams: ownershipState.maxOwnedTeams,
        },
      });

      fireTeamAnalyticsEvent({
        eventType: "team_created",
        userId: ownerUserId,
        req,
        entityId: team.id,
        metadata: {
          plan: ownershipState.plan,
        },
      });

      return reply.code(201).send(team);
    } catch (err) {
      const statusCode =
        typeof (err as { statusCode?: number })?.statusCode === "number"
          ? (err as { statusCode?: number }).statusCode!
          : 500;

      if (statusCode !== 500) {
        auditTeamAction(req, {
          userId: ownerUserId,
          action: "teams.create",
          outcome: "blocked",
          severity: "warning",
          metadata: {
            name: body.name.trim(),
            reason:
              (err as { code?: string })?.code ?? "team_creation_not_allowed",
          },
        });

        return reply.code(statusCode).send({
          message: (err as Error).message || "Unable to create team",
          code: (err as { code?: string })?.code,
          details: (err as { details?: Record<string, unknown> })?.details,
        });
      }

      auditTeamAction(req, {
        userId: ownerUserId,
        action: "teams.create",
        outcome: "failure",
        severity: "critical",
        metadata: {
          name: body.name.trim(),
          reason: "unexpected_error",
        },
      });

      throw err;
    }
  });

  app.get("/v1/teams", { preHandler: requireAuthAndLegal }, async (req, reply) => {
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

    const now = new Date();

    const items = await Promise.all(
      teams.map(async (team) => {
        const pendingInviteCount = await prisma.teamInvite.count({
          where: {
            teamId: team.id,
            acceptedAt: null,
            expiresAt: { gt: now },
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

    auditTeamAction(req, {
      userId,
      action: "teams.list",
      outcome: "success",
      metadata: { count: items.length },
    });

    return reply.code(200).send({ teams: items });
  });

  app.get(
    "/v1/teams/:id",
    { preHandler: requireAuthAndLegal },
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
        auditTeamAction(req, {
          userId,
          action: "teams.view",
          outcome: "failure",
          severity: "warning",
          resourceId: teamId,
          metadata: { reason: "not_found" },
        });
        return reply.code(404).send({ message: "Team not found" });
      }

      const actorMembership = team.members.find((m) => m.userId === userId);
      if (!actorMembership) {
        auditTeamAction(req, {
          userId,
          action: "teams.view",
          outcome: "blocked",
          severity: "warning",
          resourceId: teamId,
          metadata: { reason: "forbidden" },
        });
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
      const now = new Date();

      const pendingInviteCount = await prisma.teamInvite.count({
        where: {
          teamId,
          acceptedAt: null,
          expiresAt: { gt: now },
        },
      });

      const caseCount = await prisma.case.count({
        where: { teamId },
      });

      const workspaceScope = await getTeamWorkspaceScope(teamId);
      const workspaceUsage = await getWorkspaceUsage(workspaceScope);
      const effectiveSeatLimit = workspaceUsage.seatLimit;

      auditTeamAction(req, {
        userId,
        action: "teams.view",
        outcome: "success",
        resourceId: teamId,
      });

      fireTeamAnalyticsEvent({
        eventType: "team_viewed",
        userId,
        req,
        entityId: teamId,
      });

      return reply.code(200).send({
        id: team.id,
        name: team.name,
        ownerUserId: team.ownerUserId,
        billingOwnerUserId: team.billingOwnerUserId,
        legalName: team.legalName,
        address: team.address,
        logoUrl: team.logoUrl,
        timezone: team.timezone,
        legalEmail: team.legalEmail,
        retentionPolicy: team.retentionPolicy,
        billingPlan: team.billingPlan,
        billingStatus: team.billingStatus,
        includedSeats: team.includedSeats,
        overSeatLimit: team.overSeatLimit,
        currentUserRole: actorMembership.role,
        canManageMembers: hasRole(actorMembership.role, prismaPkg.TeamRole.ADMIN),
        stats: {
          memberCount: team.members.length,
          pendingInviteCount,
          caseCount,
          seatLimit: effectiveSeatLimit,
          seatUsed: workspaceUsage.teamMemberCount,
          seatAvailable: Math.max(0, effectiveSeatLimit - workspaceUsage.teamMemberCount),
          storageUsedBytes: workspaceUsage.storageBytesUsed.toString(),
          storageLimitBytes: workspaceUsage.storageBytesLimit.toString(),
          storageRemainingBytes: workspaceUsage.storageBytesRemaining.toString(),
          storageUsedLabel: workspaceUsage.storageLabel,
          storageLimitLabel: workspaceUsage.storageLimitLabel,
          storageRemainingLabel: workspaceUsage.storageRemainingLabel,
          storageUsageRatio: workspaceUsage.storageUsageRatio,
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
    { preHandler: requireAuthAndLegal },
    async (req: FastifyRequest, reply) => {
      const teamId = z.string().uuid().parse((req.params as { id: string }).id);
      const userId = getAuthUserId(req);

      const actor = await getActorMembership(teamId, userId);
      if (!actor) {
        auditTeamAction(req, {
          userId,
          action: "teams.cases_list",
          outcome: "blocked",
          severity: "warning",
          resourceId: teamId,
          metadata: { reason: "forbidden" },
        });
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
          teamId: true,
        },
      });

      auditTeamAction(req, {
        userId,
        action: "teams.cases_list",
        outcome: "success",
        resourceId: teamId,
        metadata: { count: items.length },
      });

      return reply.code(200).send({ items });
    }
  );

  app.get(
    "/v1/teams/:id/invites",
    { preHandler: requireAuthAndLegal },
    async (req: FastifyRequest, reply) => {
      const teamId = z.string().uuid().parse((req.params as { id: string }).id);
      const userId = getAuthUserId(req);

      const actor = await getActorMembership(teamId, userId);
      if (!actor || !hasRole(actor.role, prismaPkg.TeamRole.ADMIN)) {
        auditTeamAction(req, {
          userId,
          action: "teams.invites_list",
          outcome: "blocked",
          severity: "warning",
          resourceId: teamId,
          metadata: { reason: "forbidden" },
        });
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

      auditTeamAction(req, {
        userId,
        action: "teams.invites_list",
        outcome: "success",
        resourceId: teamId,
        metadata: { count: invites.length },
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
    { preHandler: requireAuthAndLegal },
    async (req: FastifyRequest, reply) => {
      const teamId = z.string().uuid().parse((req.params as { id: string }).id);
      const body = UpdateTeamBody.parse(req.body);
      const userId = getAuthUserId(req);

      const actor = await getActorMembership(teamId, userId);
      if (!actor || !hasRole(actor.role, prismaPkg.TeamRole.ADMIN)) {
        auditTeamAction(req, {
          userId,
          action: "teams.update",
          outcome: "blocked",
          severity: "warning",
          resourceId: teamId,
          metadata: { reason: "forbidden" },
        });
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

      auditTeamAction(req, {
        userId,
        action: "teams.update",
        outcome: "success",
        resourceId: teamId,
        metadata: {
          updatedFields: Object.keys(body),
        },
      });

      fireTeamAnalyticsEvent({
        eventType: "team_updated",
        userId,
        req,
        entityId: teamId,
        metadata: { updatedFields: Object.keys(body) },
      });

      return reply.code(200).send(updated);
    }
  );

  app.delete(
    "/v1/teams/:id",
    { preHandler: requireAuthAndLegal },
    async (req: FastifyRequest, reply) => {
      const teamId = z.string().uuid().parse((req.params as { id: string }).id);
      const userId = getAuthUserId(req);

      const actor = await getActorMembership(teamId, userId);
      if (!actor || actor.role !== prismaPkg.TeamRole.OWNER) {
        auditTeamAction(req, {
          userId,
          action: "teams.delete",
          outcome: "blocked",
          severity: "warning",
          resourceId: teamId,
          metadata: { reason: "only_owner_allowed" },
        });
        return reply.code(403).send({ message: "Only the team owner can delete this team" });
      }

      const activeTeamSubscription = await prisma.subscription.findFirst({
        where: {
          teamId,
          status: {
            in: [
              prismaPkg.SubscriptionStatus.ACTIVE,
              prismaPkg.SubscriptionStatus.PAST_DUE,
              prismaPkg.SubscriptionStatus.TRIALING,
            ],
          },
        },
        select: { id: true },
      });

      if (activeTeamSubscription) {
        auditTeamAction(req, {
          userId,
          action: "teams.delete",
          outcome: "blocked",
          severity: "warning",
          resourceId: teamId,
          metadata: { reason: "active_subscription_exists" },
        });

        return reply.code(409).send({
          message: "Cancel the active team subscription before deleting this team",
        });
      }

      const linkedEvidenceCount = await prisma.evidence.count({
        where: { teamId },
      });

      if (linkedEvidenceCount > 0) {
        auditTeamAction(req, {
          userId,
          action: "teams.delete",
          outcome: "blocked",
          severity: "warning",
          resourceId: teamId,
          metadata: {
            reason: "linked_evidence_exists",
            linkedEvidenceCount,
          },
        });

        return reply.code(409).send({
          message: "Move or delete team evidence before deleting this team",
        });
      }

      await prisma.teamInvite.deleteMany({
        where: { teamId },
      });

      await prisma.teamMember.deleteMany({
        where: { teamId },
      });

      await prisma.case.updateMany({
        where: { teamId },
        data: { teamId: null },
      });

      await prisma.team.delete({
        where: { id: teamId },
      });

      auditTeamAction(req, {
        userId,
        action: "teams.delete",
        outcome: "success",
        resourceId: teamId,
      });

      fireTeamAnalyticsEvent({
        eventType: "team_deleted",
        userId,
        req,
        entityId: teamId,
      });

      return reply.code(204).send();
    }
  );

  app.post(
    "/v1/teams/:id/invites",
    { preHandler: requireAuthAndLegal },
    async (req: FastifyRequest, reply) => {
      const teamId = z.string().uuid().parse((req.params as { id: string }).id);
      const body = InviteBody.parse(req.body);
      const userId = getAuthUserId(req);
      const email = normalizeEmail(body.email);

      const actor = await getActorMembership(teamId, userId);
      if (!actor || !hasRole(actor.role, prismaPkg.TeamRole.ADMIN)) {
        auditTeamAction(req, {
          userId,
          action: "teams.invite_create",
          outcome: "blocked",
          severity: "warning",
          resourceId: teamId,
          metadata: { reason: "forbidden", email },
        });
        return reply.code(403).send({ message: "Forbidden" });
      }

      /**
       * Important rule:
       * Invitation creation must NOT be blocked because the team is full.
       * Only actual member addition / invite acceptance should enforce the 5-member cap.
       *
       * We still require the workspace to support teams at all.
       */
      const scope = await getTeamWorkspaceScope(teamId);
      const scopeCaps = getPlanCapabilities(scope.plan);

      if (!scopeCaps.allowsTeamWorkspace) {
        auditTeamAction(req, {
          userId,
          action: "teams.invite_create",
          outcome: "blocked",
          severity: "warning",
          resourceId: teamId,
          metadata: { reason: "team_plan_required", email, plan: scope.plan },
        });

        return reply.code(409).send({
          message: "This team does not currently support member invitations",
        });
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

        auditTeamAction(req, {
          userId,
          action: "teams.invite_resend",
          outcome: "success",
          resourceId: teamId,
          metadata: {
            email,
            inviteId: existingPendingInvite.id,
            emailSent,
          },
        });

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
          auditTeamAction(req, {
            userId,
            action: "teams.invite_create",
            outcome: "blocked",
            severity: "warning",
            resourceId: teamId,
            metadata: { reason: "already_member", email },
          });

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

          await emailService.sendTeamInvitation(email, team?.name || "PROOVRA", token);
          emailSent = true;
        }
      } catch (err) {
        req.log.error({ err, teamId, email }, "Failed to send invite email");
      }

      await createActivity(teamId, "invite_created", "invite", userId, invite.id, {
        email,
        role: invite.role,
      });

      auditTeamAction(req, {
        userId,
        action: "teams.invite_create",
        outcome: "success",
        resourceId: teamId,
        metadata: {
          inviteId: invite.id,
          email,
          role: invite.role,
          emailSent,
          plan: scope.plan,
        },
      });

      fireTeamAnalyticsEvent({
        eventType: "team_invite_created",
        userId,
        req,
        entityId: teamId,
        metadata: { email, role: invite.role, plan: scope.plan },
      });

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
    { preHandler: requireAuthAndLegal },
    async (req: FastifyRequest, reply) => {
      const params = req.params as { id: string; inviteId: string };
      const teamId = z.string().uuid().parse(params.id);
      const inviteId = z.string().uuid().parse(params.inviteId);
      const userId = getAuthUserId(req);

      const actor = await getActorMembership(teamId, userId);
      if (!actor || !hasRole(actor.role, prismaPkg.TeamRole.ADMIN)) {
        auditTeamAction(req, {
          userId,
          action: "teams.invite_delete",
          outcome: "blocked",
          severity: "warning",
          resourceId: teamId,
          metadata: { reason: "forbidden", inviteId },
        });
        return reply.code(403).send({ message: "Forbidden" });
      }

      const invite = await prisma.teamInvite.findUnique({
        where: { id: inviteId },
      });

      if (!invite || invite.teamId !== teamId) {
        auditTeamAction(req, {
          userId,
          action: "teams.invite_delete",
          outcome: "failure",
          severity: "warning",
          resourceId: teamId,
          metadata: { reason: "invite_not_found", inviteId },
        });
        return reply.code(404).send({ message: "Invite not found" });
      }

      await prisma.teamInvite.delete({
        where: { id: inviteId },
      });

      await createActivity(teamId, "invite_deleted", "invite", userId, inviteId, {
        email: invite.email,
      });

      auditTeamAction(req, {
        userId,
        action: "teams.invite_delete",
        outcome: "success",
        resourceId: teamId,
        metadata: { inviteId, email: invite.email },
      });

      return reply.code(204).send();
    }
  );

  app.patch(
    "/v1/teams/:id/members/:memberId",
    { preHandler: requireAuthAndLegal },
    async (req: FastifyRequest, reply) => {
      const params = req.params as { id: string; memberId: string };
      const teamId = z.string().uuid().parse(params.id);
      const memberId = z.string().uuid().parse(params.memberId);
      const body = UpdateMemberBody.parse(req.body);
      const userId = getAuthUserId(req);

      const actor = await getActorMembership(teamId, userId);
      if (!actor || !hasRole(actor.role, prismaPkg.TeamRole.ADMIN)) {
        auditTeamAction(req, {
          userId,
          action: "teams.member_update",
          outcome: "blocked",
          severity: "warning",
          resourceId: teamId,
          metadata: { reason: "forbidden", memberId },
        });
        return reply.code(403).send({ message: "Forbidden" });
      }

      const target = await getTeamMemberByMemberId(teamId, memberId);

      if (!target) {
        auditTeamAction(req, {
          userId,
          action: "teams.member_update",
          outcome: "failure",
          severity: "warning",
          resourceId: teamId,
          metadata: { reason: "member_not_found", memberId },
        });
        return reply.code(404).send({ message: "Member not found" });
      }

      if (target.role === prismaPkg.TeamRole.OWNER) {
        auditTeamAction(req, {
          userId,
          action: "teams.member_update",
          outcome: "blocked",
          severity: "warning",
          resourceId: teamId,
          metadata: { reason: "owner_role_immutable", memberId },
        });
        return reply.code(400).send({ message: "Owner role cannot be changed" });
      }

      const updated = await prisma.teamMember.update({
        where: { id: target.id },
        data: { role: body.role },
      });

      await createActivity(teamId, "member_role_changed", "member", userId, target.userId, {
        role: body.role,
      });

      auditTeamAction(req, {
        userId,
        action: "teams.member_update",
        outcome: "success",
        resourceId: teamId,
        metadata: { memberId: target.id, userId: target.userId, role: body.role },
      });

      fireTeamAnalyticsEvent({
        eventType: "team_member_role_changed",
        userId,
        req,
        entityId: teamId,
        metadata: { memberId: target.id, userId: target.userId, role: body.role },
      });

      return reply.code(200).send({ member: updated });
    }
  );

  app.delete(
    "/v1/teams/:id/members/:memberId",
    { preHandler: requireAuthAndLegal },
    async (req: FastifyRequest, reply) => {
      const params = req.params as { id: string; memberId: string };
      const teamId = z.string().uuid().parse(params.id);
      const memberId = z.string().uuid().parse(params.memberId);
      const userId = getAuthUserId(req);

      const actor = await getActorMembership(teamId, userId);
      if (!actor || !hasRole(actor.role, prismaPkg.TeamRole.ADMIN)) {
        auditTeamAction(req, {
          userId,
          action: "teams.member_delete",
          outcome: "blocked",
          severity: "warning",
          resourceId: teamId,
          metadata: { reason: "forbidden", memberId },
        });
        return reply.code(403).send({ message: "Forbidden" });
      }

      const target = await getTeamMemberByMemberId(teamId, memberId);

      if (!target) {
        auditTeamAction(req, {
          userId,
          action: "teams.member_delete",
          outcome: "failure",
          severity: "warning",
          resourceId: teamId,
          metadata: { reason: "member_not_found", memberId },
        });
        return reply.code(404).send({ message: "Member not found" });
      }

      if (target.role === prismaPkg.TeamRole.OWNER) {
        auditTeamAction(req, {
          userId,
          action: "teams.member_delete",
          outcome: "blocked",
          severity: "warning",
          resourceId: teamId,
          metadata: { reason: "owner_cannot_be_removed", memberId },
        });
        return reply.code(400).send({ message: "Owner cannot be removed" });
      }

      await prisma.teamMember.delete({
        where: { id: target.id },
      });

      await refreshTeamSeatState(teamId);

      await createActivity(teamId, "member_removed", "member", userId, target.userId);

      auditTeamAction(req, {
        userId,
        action: "teams.member_delete",
        outcome: "success",
        resourceId: teamId,
        metadata: { memberId: target.id, userId: target.userId },
      });

      fireTeamAnalyticsEvent({
        eventType: "team_member_removed",
        userId,
        req,
        entityId: teamId,
        metadata: { memberId: target.id, userId: target.userId },
      });

      return reply.code(204).send();
    }
  );

  app.post(
    "/v1/teams/invites/:token/accept",
    { preHandler: requireAuthAndLegal },
    async (req: FastifyRequest, reply) => {
      const token = z.string().min(8).parse((req.params as { token: string }).token);
      const userId = getAuthUserId(req);

      const invite = await prisma.teamInvite.findUnique({
        where: { token },
      });

      if (!invite) {
        auditTeamAction(req, {
          userId,
          action: "teams.invite_accept",
          outcome: "failure",
          severity: "warning",
          metadata: { reason: "invite_not_found" },
        });
        return reply.code(404).send({ message: "Invite not found" });
      }

      if (invite.acceptedAt) {
        auditTeamAction(req, {
          userId,
          action: "teams.invite_accept",
          outcome: "blocked",
          severity: "warning",
          resourceId: invite.teamId,
          metadata: { reason: "already_accepted", inviteId: invite.id },
        });
        return reply.code(400).send({ message: "Invite already accepted" });
      }

      if (invite.expiresAt.getTime() < Date.now()) {
        auditTeamAction(req, {
          userId,
          action: "teams.invite_accept",
          outcome: "blocked",
          severity: "warning",
          resourceId: invite.teamId,
          metadata: { reason: "invite_expired", inviteId: invite.id },
        });
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
        auditTeamAction(req, {
          userId,
          action: "teams.invite_accept",
          outcome: "blocked",
          severity: "warning",
          resourceId: invite.teamId,
          metadata: { reason: "email_mismatch", inviteId: invite.id },
        });
        return reply.code(403).send({
          message: "You must be signed in with the invited email address",
        });
      }

      const existingMembership = await prisma.teamMember.findUnique({
        where: {
          teamId_userId: {
            teamId: invite.teamId,
            userId,
          },
        },
      });

      if (!existingMembership) {
        /**
         * Important rule:
         * Acceptance is where the member cap is enforced.
         * Invite creation itself must not be blocked for a full team.
         */
        const scope = await getTeamWorkspaceScope(invite.teamId);
        const scopeCaps = getPlanCapabilities(scope.plan);

        if (!scopeCaps.allowsTeamWorkspace) {
          auditTeamAction(req, {
            userId,
            action: "teams.invite_accept",
            outcome: "blocked",
            severity: "warning",
            resourceId: invite.teamId,
            metadata: {
              reason: "team_plan_required",
              inviteId: invite.id,
              plan: scope.plan,
            },
          });

          return reply.code(409).send({
            message: "This team no longer supports member access",
          });
        }

        await assertTeamSeatAvailable(scope);
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

      await refreshTeamSeatState(invite.teamId);

      await createActivity(invite.teamId, "invite_accepted", "member", userId, userId, {
        role: invite.role,
      });

      auditTeamAction(req, {
        userId,
        action: "teams.invite_accept",
        outcome: "success",
        resourceId: invite.teamId,
        metadata: { inviteId: invite.id, role: invite.role },
      });

      fireTeamAnalyticsEvent({
        eventType: "team_invite_accepted",
        userId,
        req,
        entityId: invite.teamId,
        metadata: { inviteId: invite.id, role: invite.role },
      });

      return reply.code(200).send({ invite: updated });
    }
  );

  app.get(
    "/v1/teams/:id/activity",
    { preHandler: requireAuthAndLegal },
    async (req: FastifyRequest, reply) => {
      const teamId = z.string().uuid().parse((req.params as { id: string }).id);
      const userId = getAuthUserId(req);

      const actor = await getActorMembership(teamId, userId);
      if (!actor) {
        auditTeamAction(req, {
          userId,
          action: "teams.activity_list",
          outcome: "blocked",
          severity: "warning",
          resourceId: teamId,
          metadata: { reason: "forbidden" },
        });
        return reply.code(403).send({ message: "Forbidden" });
      }

      const activities = await prisma.teamActivity.findMany({
        where: { teamId },
        orderBy: { createdAt: "desc" },
        take: 50,
      });

      const actorIds = activities
        .map((a) => a.actorUserId)
        .filter((id): id is string => id !== null);

      const users = actorIds.length
        ? await prisma.user.findMany({
            where: { id: { in: actorIds } },
            select: {
              id: true,
              email: true,
              displayName: true,
            },
          })
        : [];

      const usersById = new Map(users.map((u) => [u.id, u]));

      const enriched = activities.map((activity) => {
        const actorUser = activity.actorUserId ? usersById.get(activity.actorUserId) : null;
        return {
          id: activity.id,
          eventType: activity.eventType,
          targetType: activity.targetType,
          targetId: activity.targetId,
          actor: actorUser
            ? {
                id: actorUser.id,
                email: actorUser.email,
                displayName: actorUser.displayName,
              }
            : null,
          metadata: activity.metadata,
          createdAt: activity.createdAt,
        };
      });

      auditTeamAction(req, {
        userId,
        action: "teams.activity_list",
        outcome: "success",
        resourceId: teamId,
        metadata: { count: activities.length },
      });

      return reply.code(200).send({ activities: enriched });
    }
  );

  app.post(
    "/v1/teams/:id/cases/link",
    { preHandler: requireAuthAndLegal },
    async (req: FastifyRequest, reply) => {
      const LinkCaseBody = z.object({ caseId: z.string().uuid() });
      const params = req.params as { id: string };
      const teamId = z.string().uuid().parse(params.id);
      const { caseId } = LinkCaseBody.parse(req.body);
      const userId = getAuthUserId(req);

      const actor = await getActorMembership(teamId, userId);
      if (!actor || !hasRole(actor.role, prismaPkg.TeamRole.MEMBER)) {
        auditTeamAction(req, {
          userId,
          action: "teams.case_link",
          outcome: "blocked",
          severity: "warning",
          resourceId: teamId,
          metadata: { reason: "forbidden", caseId },
        });
        return reply.code(403).send({ message: "Forbidden" });
      }

      const caseItem = await prisma.case.findUnique({
        where: { id: caseId },
      });

      if (!caseItem) {
        auditTeamAction(req, {
          userId,
          action: "teams.case_link",
          outcome: "failure",
          severity: "warning",
          resourceId: teamId,
          metadata: { reason: "case_not_found", caseId },
        });
        return reply.code(404).send({ message: "Case not found" });
      }

      if (caseItem.teamId) {
        auditTeamAction(req, {
          userId,
          action: "teams.case_link",
          outcome: "blocked",
          severity: "warning",
          resourceId: teamId,
          metadata: { reason: "case_already_linked", caseId },
        });
        return reply.code(400).send({ message: "Case is already linked to a team" });
      }

      if (caseItem.ownerUserId !== userId && !hasRole(actor.role, prismaPkg.TeamRole.ADMIN)) {
        auditTeamAction(req, {
          userId,
          action: "teams.case_link",
          outcome: "blocked",
          severity: "warning",
          resourceId: teamId,
          metadata: { reason: "not_owner_or_admin", caseId },
        });
        return reply.code(403).send({ message: "Only case owner or team admin can link case" });
      }

      const updated = await prisma.case.update({
        where: { id: caseId },
        data: { teamId },
      });

      await createActivity(teamId, "case_linked", "case", userId, caseId, {
        caseName: updated.name,
      });

      auditTeamAction(req, {
        userId,
        action: "teams.case_link",
        outcome: "success",
        resourceId: teamId,
        metadata: { caseId, caseName: updated.name },
      });

      fireTeamAnalyticsEvent({
        eventType: "team_case_linked",
        userId,
        req,
        entityId: teamId,
        metadata: { caseId },
      });

      return reply.code(200).send(updated);
    }
  );

  app.delete(
    "/v1/teams/:id/cases/:caseId",
    { preHandler: requireAuthAndLegal },
    async (req: FastifyRequest, reply) => {
      const params = req.params as { id: string; caseId: string };
      const teamId = z.string().uuid().parse(params.id);
      const caseId = z.string().uuid().parse(params.caseId);
      const userId = getAuthUserId(req);

      const actor = await getActorMembership(teamId, userId);
      if (!actor || !hasRole(actor.role, prismaPkg.TeamRole.ADMIN)) {
        auditTeamAction(req, {
          userId,
          action: "teams.case_unlink",
          outcome: "blocked",
          severity: "warning",
          resourceId: teamId,
          metadata: { reason: "forbidden", caseId },
        });
        return reply.code(403).send({ message: "Forbidden" });
      }

      const caseItem = await prisma.case.findUnique({
        where: { id: caseId },
      });

      if (!caseItem || caseItem.teamId !== teamId) {
        auditTeamAction(req, {
          userId,
          action: "teams.case_unlink",
          outcome: "failure",
          severity: "warning",
          resourceId: teamId,
          metadata: { reason: "case_not_found_in_team", caseId },
        });
        return reply.code(404).send({ message: "Case not found in team" });
      }

      const updated = await prisma.case.update({
        where: { id: caseId },
        data: { teamId: null },
      });

      await createActivity(teamId, "case_unlinked", "case", userId, caseId, {
        caseName: updated.name,
      });

      auditTeamAction(req, {
        userId,
        action: "teams.case_unlink",
        outcome: "success",
        resourceId: teamId,
        metadata: { caseId, caseName: updated.name },
      });

      fireTeamAnalyticsEvent({
        eventType: "team_case_unlinked",
        userId,
        req,
        entityId: teamId,
        metadata: { caseId },
      });

      return reply.code(200).send(updated);
    }
  );
}