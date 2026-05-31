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

// Phase 4B Final Closure I5 — legal-hold gate for workspace (team) deletion.
// Queries WORKSPACE + ORGANIZATION holds scoped to the teamId. Returns
// ok=true if no active hold blocks deletion; error is swallowed so engine
// failure never blocks the operational path.
async function checkWorkspaceLegalHold(
  teamId: string,
): Promise<{ ok: boolean; holdIds: string[] }> {
  try {
    const activeHolds = await prisma.legalHold.findMany({
      where: {
        teamId,
        state: "ACTIVE",
        OR: [{ kind: "WORKSPACE" }, { kind: "ORGANIZATION" }],
      },
      select: { id: true },
      take: 50,
    });
    if (activeHolds.length > 0) {
      return { ok: false, holdIds: activeHolds.map((h) => h.id) };
    }
    return { ok: true, holdIds: [] };
  } catch {
    return { ok: true, holdIds: [] };
  }
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

      // 4B-I1: QUOTA_WORKSPACES — gate on per-user workspace count.
      // Denial: 403 { denial: "QUOTA_EXCEEDED", entitlement: "QUOTA_WORKSPACES" }.
      // Engine errors are swallowed so this gate never blocks the operational path.
      try {
        const personalTeam = await prisma.team.findFirst({
          where: { ownerUserId, isPersonal: true },
          select: { id: true },
        });
        if (personalTeam) {
          const { assertQuotaEntitlement, recordEntitlementUsage } = await import(
            "../services/packaging/entitlement.service.js"
          );
          const qWorkspaces = await assertQuotaEntitlement({
            prisma,
            teamId: personalTeam.id,
            key: "QUOTA_WORKSPACES",
            requested: 1,
            actorUserId: ownerUserId,
          });
          if (!qWorkspaces.ok) {
            return reply.code(403).send({
              denial: "QUOTA_EXCEEDED",
              entitlement: "QUOTA_WORKSPACES",
            });
          }
          recordEntitlementUsage({
            prisma,
            teamId: personalTeam.id,
            key: "QUOTA_WORKSPACES",
            amount: 1,
          }).catch(() => null);
        }
      } catch {
        /* entitlement engine error — do not block workspace creation */
      }

      // Phase 2.7X Stage 6 — atomically create the bound Organization
      // so the team is never observed with a NULL `organization_id`.
      // This keeps the Stage 7-eligible NOT NULL tightening safe.
      const team = await prisma.$transaction(async (tx) => {
        const org = await tx.organization.create({
          data: {
            name: body.name.trim(),
            billingOwnerUserId: ownerUserId,
            status: "ACTIVE",
          },
          select: { id: true },
        });
        await tx.organizationMembership.create({
          data: {
            organizationId: org.id,
            userId: ownerUserId,
            role: "ORG_OWNER",
          },
        });
        return tx.team.create({
          data: {
            name: body.name.trim(),
            ownerUserId,
            organizationId: org.id,
            members: {
              create: {
                userId: ownerUserId,
                role: prismaPkg.TeamRole.OWNER,
              },
            },
          },
        });
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

    // Phase 32.8 Foundation cleanup — emit BOTH `teams` and `items`
    // so legacy callers (that expected `items`) and current callers
    // (that expect `teams`) keep working. Authority resolution no
    // longer depends on this endpoint — the canonical envelope is
    // `/v1/platform/context`. This dual-key shape exists strictly to
    // remove the latent MEMBER-fallback regression where the legacy
    // `useActiveWorkspaceId` read `teams.items` against a `{teams}`
    // payload and got `undefined`. See
    // services/api/test/phase-32-8-foundation-cleanup.test.ts.
    return reply.code(200).send({ teams: items, items });
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

      // Phase 4B Final Closure I5 — legal-hold gate: a WORKSPACE or
      // ORGANIZATION hold MUST block team deletion. Helper is try/catch-safe.
      const holdChk = await checkWorkspaceLegalHold(teamId);
      if (!holdChk.ok) {
        auditTeamAction(req, {
          userId,
          action: "teams.delete",
          outcome: "blocked",
          severity: "critical",
          resourceId: teamId,
          metadata: { reason: "legal_hold_blocked", holdIds: holdChk.holdIds },
        });
        return reply.code(403).send({ denial: "LEGAL_HOLD_BLOCKED", holdIds: holdChk.holdIds });
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

      // 4B-I1: QUOTA_USERS — gate before invite commit.
      // Denial: 403 { denial: "QUOTA_EXCEEDED", entitlement: "QUOTA_USERS" }.
      // recordEntitlementUsage is fire-and-forget. Engine errors are swallowed.
      try {
        const { assertQuotaEntitlement, recordEntitlementUsage } = await import(
          "../services/packaging/entitlement.service.js"
        );
        const qUsers = await assertQuotaEntitlement({
          prisma,
          teamId,
          key: "QUOTA_USERS",
          requested: 1,
          actorUserId: userId,
        });
        if (!qUsers.ok) {
          return reply.code(403).send({
            denial: "QUOTA_EXCEEDED",
            entitlement: "QUOTA_USERS",
          });
        }
        recordEntitlementUsage({ prisma, teamId, key: "QUOTA_USERS", amount: 1 }).catch(() => null);
      } catch {
        /* entitlement engine error — do not block invite creation */
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

  // Phase 2.1 — pre-removal impact query.
  //
  // Before Phase 2.1 the DELETE endpoint deleted a `TeamMember` row
  // without checking what records the user still owned inside the
  // team. That silently orphaned evidence + cases (custody breaks,
  // bulk queries skip the rows). The audit flagged this as the top
  // P0 enterprise blocker.
  //
  // This endpoint returns the impact counts so the UI can show the
  // operator exactly what will be left behind and (when non-zero)
  // require a transfer target before the destructive DELETE call.
  //
  // ADMIN+ only (mirrors the DELETE gate). VIEWER / MEMBER probes
  // return 403 with no enumeration.
  app.get(
    "/v1/teams/:id/members/:memberId/removal-impact",
    { preHandler: requireAuthAndLegal },
    async (req: FastifyRequest, reply) => {
      const params = req.params as { id: string; memberId: string };
      const teamId = z.string().uuid().parse(params.id);
      const memberId = z.string().uuid().parse(params.memberId);
      const userId = getAuthUserId(req);

      const actor = await getActorMembership(teamId, userId);
      if (!actor || !hasRole(actor.role, prismaPkg.TeamRole.ADMIN)) {
        return reply.code(403).send({ message: "Forbidden" });
      }

      const target = await getTeamMemberByMemberId(teamId, memberId);
      if (!target) {
        return reply.code(404).send({ message: "Member not found" });
      }
      const targetUserId = target.userId;

      // Count active records owned by the member inside this team.
      // Soft-deleted evidence is excluded (those rows are already
      // out of operational queues).
      const [ownedEvidence, ownedCases, openAssignments] = await Promise.all([
        prisma.evidence.count({
          where: {
            teamId,
            ownerUserId: targetUserId,
            deletedAt: null,
          },
        }),
        prisma.case.count({
          where: { teamId, ownerUserId: targetUserId },
        }),
        prisma.caseAssignment.count({
          where: {
            assignedToUserId: targetUserId,
            status: "ACTIVE",
            case: { teamId },
          },
        }).catch(() => 0),
      ]);

      const requiresTransfer = ownedEvidence > 0 || ownedCases > 0;

      // Eligible transfer targets: every other ADMIN+ member in the
      // same team. We use ADMIN+ rather than MEMBER+ so that an
      // ownership transfer never lands records in the lap of a
      // member who could themselves be removed soon. The frontend
      // surfaces this list to the operator.
      const eligibleTargetsRaw = await prisma.teamMember.findMany({
        where: {
          teamId,
          status: "ACTIVE",
          userId: { not: targetUserId },
          role: { in: [prismaPkg.TeamRole.OWNER, prismaPkg.TeamRole.ADMIN] },
        },
        select: {
          id: true,
          role: true,
          user: { select: { id: true, email: true, displayName: true } },
        },
      });
      const eligibleTargets = eligibleTargetsRaw.map((m) => ({
        memberId: m.id,
        userId: m.user.id,
        // Email shown only to ADMIN+ requester (already gated above).
        email: m.user.email,
        displayName: m.user.displayName,
        role: m.role,
      }));

      return reply.code(200).send({
        member: {
          memberId: target.id,
          userId: target.userId,
          role: target.role,
        },
        impact: {
          ownedEvidence,
          ownedCases,
          openAssignments,
          requiresTransfer,
        },
        eligibleTransferTargets: eligibleTargets,
      });
    },
  );

  app.delete(
    "/v1/teams/:id/members/:memberId",
    { preHandler: requireAuthAndLegal },
    async (req: FastifyRequest, reply) => {
      const params = req.params as { id: string; memberId: string };
      const teamId = z.string().uuid().parse(params.id);
      const memberId = z.string().uuid().parse(params.memberId);
      const userId = getAuthUserId(req);

      // Phase 2.1 — optional body to perform ownership transfer in
      // the same atomic operation. Keeps backward compatibility: a
      // member with zero owned records can still be removed with a
      // bodyless DELETE (the existing flow).
      const removalBodySchema = z
        .object({
          transferToUserId: z.string().uuid().optional(),
        })
        .optional();
      const parsedBody = removalBodySchema.safeParse(req.body ?? {});
      const transferToUserId = parsedBody.success
        ? parsedBody.data?.transferToUserId ?? null
        : null;

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

      // Phase 2.1 — orphan-safe pre-flight. Block removal if the
      // member still owns active evidence or cases in this team,
      // unless the caller specified a transfer target.
      const [ownedEvidenceCount, ownedCaseCount] = await Promise.all([
        prisma.evidence.count({
          where: {
            teamId,
            ownerUserId: target.userId,
            deletedAt: null,
          },
        }),
        prisma.case.count({
          where: { teamId, ownerUserId: target.userId },
        }),
      ]);
      const hasOwnedRecords =
        ownedEvidenceCount > 0 || ownedCaseCount > 0;

      if (hasOwnedRecords && !transferToUserId) {
        auditTeamAction(req, {
          userId,
          action: "teams.member_delete",
          outcome: "blocked",
          severity: "warning",
          resourceId: teamId,
          metadata: {
            reason: "owns_active_records",
            memberId,
            ownedEvidenceCount,
            ownedCaseCount,
          },
        });
        return reply.code(409).send({
          code: "TRANSFER_TARGET_REQUIRED",
          message:
            "This member still owns active evidence or cases in this team. Provide `transferToUserId` to re-assign ownership before removal.",
          impact: {
            ownedEvidence: ownedEvidenceCount,
            ownedCases: ownedCaseCount,
          },
        });
      }

      // Validate the transfer target if provided: must be an
      // existing ACTIVE member of the same team, must not be the
      // member being removed, and must be ADMIN+ (so the records
      // land with someone with appropriate authority).
      if (transferToUserId) {
        if (transferToUserId === target.userId) {
          return reply.code(400).send({
            code: "INVALID_TRANSFER_TARGET",
            message:
              "Cannot transfer ownership to the member being removed.",
          });
        }
        const transferMember = await prisma.teamMember.findUnique({
          where: {
            teamId_userId: { teamId, userId: transferToUserId },
          },
          select: { id: true, role: true, status: true },
        });
        if (
          !transferMember ||
          transferMember.status !== "ACTIVE" ||
          !hasRole(transferMember.role, prismaPkg.TeamRole.ADMIN)
        ) {
          return reply.code(400).send({
            code: "INVALID_TRANSFER_TARGET",
            message:
              "Transfer target must be an active OWNER or ADMIN of this team.",
          });
        }
      }

      // Atomic: transfer ownership of evidence + cases, then delete
      // the membership row. If either reassignment fails, the
      // transaction rolls back and no membership change occurs.
      await prisma.$transaction(async (tx) => {
        if (transferToUserId && hasOwnedRecords) {
          await tx.evidence.updateMany({
            where: {
              teamId,
              ownerUserId: target.userId,
              deletedAt: null,
            },
            data: { ownerUserId: transferToUserId },
          });
          await tx.case.updateMany({
            where: { teamId, ownerUserId: target.userId },
            data: { ownerUserId: transferToUserId },
          });
        }
        await tx.teamMember.delete({ where: { id: target.id } });
      });

      await refreshTeamSeatState(teamId);

      await createActivity(teamId, "member_removed", "member", userId, target.userId);
      if (transferToUserId && hasOwnedRecords) {
        // Record the transfer as its own activity so the team audit
        // trail explains why ownership rows moved.
        await createActivity(
          teamId,
          "ownership_transferred",
          "member",
          userId,
          target.userId,
        ).catch(() => null);
      }

      auditTeamAction(req, {
        userId,
        action: "teams.member_delete",
        outcome: "success",
        resourceId: teamId,
        metadata: {
          memberId: target.id,
          userId: target.userId,
          transferredToUserId: transferToUserId,
          ownedEvidenceCount,
          ownedCaseCount,
        },
      });

      fireTeamAnalyticsEvent({
        eventType: "team_member_removed",
        userId,
        req,
        entityId: teamId,
        metadata: {
          memberId: target.id,
          userId: target.userId,
          transferred: Boolean(transferToUserId && hasOwnedRecords),
          ownedEvidenceCount,
          ownedCaseCount,
        },
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

  // ===========================================================================
  // Phase 2.6B — External collaborators aggregator.
  //
  // Operator-facing governance read. Answers the question:
  // "Who has access to this team's cases / evidence WITHOUT being a
  //  formal team member?"
  //
  // Source of truth today: `CaseAccess` rows for cases belonging to
  // this team where the user is NOT in the team's TeamMember list.
  // Reviewer assignments don't extend external access (they grant
  // workflow rights to existing members).
  //
  // Hard rules:
  //   - ADMIN+ only. The list discloses email addresses and case
  //     names, so it's gated identically to other team-management
  //     reads.
  //   - The endpoint NEVER includes the user's full identity beyond
  //     email + displayName. No tokens, no session ids, no IP.
  //   - Empty result is normal (most workspaces have no external
  //     collaborators); we always return the structured envelope so
  //     the frontend handles "0 results" with the same code path as
  //     "N results".
  // ===========================================================================
  app.get(
    "/v1/teams/:id/external-collaborators",
    { preHandler: requireAuthAndLegal },
    async (req: FastifyRequest, reply) => {
      const teamId = z.string().uuid().parse((req.params as { id: string }).id);
      const userId = getAuthUserId(req);

      const actor = await getActorMembership(teamId, userId);
      if (!actor || !hasRole(actor.role, prismaPkg.TeamRole.ADMIN)) {
        return reply.code(403).send({ message: "Forbidden" });
      }

      // 1. The set of team-member user ids — anyone on this list is
      //    a formal team member, not an external collaborator.
      const teamMembers = await prisma.teamMember.findMany({
        where: { teamId },
        select: { userId: true },
      });
      const teamMemberIds = new Set(teamMembers.map((m) => m.userId));

      // 2. All cases owned by this team.
      const teamCases = await prisma.case.findMany({
        where: { teamId },
        select: { id: true, name: true },
      });
      const teamCaseIds = teamCases.map((c) => c.id);
      const caseNameById = new Map(teamCases.map((c) => [c.id, c.name]));

      if (teamCaseIds.length === 0) {
        return reply.code(200).send({
          teamId,
          summary: { totalCollaborators: 0, totalGrants: 0 },
          collaborators: [],
        });
      }

      // 3. All CaseAccess rows on those cases.
      const grants = await prisma.caseAccess.findMany({
        where: { caseId: { in: teamCaseIds } },
        select: {
          id: true,
          userId: true,
          caseId: true,
          createdAt: true,
        },
      });

      // 4. Filter out grants where the user IS a formal team member.
      const externalGrants = grants.filter(
        (g) => !teamMemberIds.has(g.userId),
      );

      // 5. Resolve user identity (email + displayName only).
      const externalUserIds = Array.from(
        new Set(externalGrants.map((g) => g.userId)),
      );
      const users = externalUserIds.length
        ? await prisma.user.findMany({
            where: { id: { in: externalUserIds } },
            select: { id: true, email: true, displayName: true },
          })
        : [];
      const userById = new Map(users.map((u) => [u.id, u]));

      // 6. Group grants per external user — one row per collaborator,
      //    with the list of cases they have access to.
      const grantsByUser = new Map<
        string,
        Array<{ grantId: string; caseId: string; caseName: string; grantedAt: string }>
      >();
      for (const g of externalGrants) {
        const list = grantsByUser.get(g.userId) ?? [];
        list.push({
          grantId: g.id,
          caseId: g.caseId,
          caseName: caseNameById.get(g.caseId) ?? "(unknown case)",
          grantedAt: g.createdAt.toISOString(),
        });
        grantsByUser.set(g.userId, list);
      }

      const collaborators = Array.from(grantsByUser.entries()).map(
        ([uid, grants]) => {
          const u = userById.get(uid);
          // Pick the earliest grant as the "first granted" timestamp.
          const earliestGrant = grants.reduce(
            (acc, g) => (g.grantedAt < acc ? g.grantedAt : acc),
            grants[0]?.grantedAt ?? new Date().toISOString(),
          );
          return {
            userId: uid,
            email: u?.email ?? null,
            displayName: u?.displayName ?? null,
            firstGrantedAt: earliestGrant,
            grants,
          };
        },
      );

      // Sort: most recently granted first.
      collaborators.sort((a, b) =>
        a.firstGrantedAt < b.firstGrantedAt ? 1 : -1,
      );

      return reply.code(200).send({
        teamId,
        summary: {
          totalCollaborators: collaborators.length,
          totalGrants: externalGrants.length,
        },
        collaborators,
      });
    },
  );

  // ===========================================================================
  // Phase 2.6B — Access review aggregator.
  //
  // Single endpoint an admin can hit to answer "who has access here,
  // and what can they do?" It unifies:
  //   - Internal team members (TeamMember) with role + addedAt
  //   - Pending invites (TeamInvite where acceptedAt is null and not
  //     expired)
  //   - External collaborators (CaseAccess for non-members)
  //
  // No schema change. This is a read-side composition over existing
  // models.
  //
  // Hard rules:
  //   - ADMIN+ only (same as the other team-management reads).
  //   - Email + displayName + role only. No tokens, no IP, no last-
  //     login (Phase 2.4 session inventory doesn't tag by team).
  //   - Empty arrays are valid responses; the frontend handles them
  //     identically to populated ones.
  // ===========================================================================
  app.get(
    "/v1/teams/:id/access-review",
    { preHandler: requireAuthAndLegal },
    async (req: FastifyRequest, reply) => {
      const teamId = z.string().uuid().parse((req.params as { id: string }).id);
      const userId = getAuthUserId(req);

      const actor = await getActorMembership(teamId, userId);
      if (!actor || !hasRole(actor.role, prismaPkg.TeamRole.ADMIN)) {
        return reply.code(403).send({ message: "Forbidden" });
      }

      const now = new Date();

      // 1. Internal members — resolve identity via User join.
      const members = await prisma.teamMember.findMany({
        where: { teamId },
        select: {
          id: true,
          userId: true,
          role: true,
          createdAt: true,
        },
      });
      const memberUserIds = members.map((m) => m.userId);
      const memberUsers = memberUserIds.length
        ? await prisma.user.findMany({
            where: { id: { in: memberUserIds } },
            select: { id: true, email: true, displayName: true },
          })
        : [];
      const memberUserById = new Map(memberUsers.map((u) => [u.id, u]));

      const internal = members.map((m) => {
        const u = memberUserById.get(m.userId);
        return {
          kind: "MEMBER" as const,
          memberId: m.id,
          userId: m.userId,
          email: u?.email ?? null,
          displayName: u?.displayName ?? null,
          role: m.role,
          addedAt: m.createdAt.toISOString(),
        };
      });

      // 2. Pending invites — not yet accepted + not expired.
      const invites = await prisma.teamInvite.findMany({
        where: {
          teamId,
          acceptedAt: null,
          expiresAt: { gt: now },
        },
        select: {
          id: true,
          email: true,
          role: true,
          invitedByUserId: true,
          createdAt: true,
          expiresAt: true,
        },
      });
      const pendingInvites = invites.map((inv) => ({
        kind: "PENDING_INVITE" as const,
        inviteId: inv.id,
        email: inv.email,
        role: inv.role,
        invitedByUserId: inv.invitedByUserId,
        createdAt: inv.createdAt.toISOString(),
        expiresAt: inv.expiresAt.toISOString(),
      }));

      // 3. External collaborators — reuse the same logic as the
      //    external-collaborators endpoint but bounded inline so the
      //    response shape stays self-contained.
      const teamMemberIdSet = new Set(memberUserIds);
      const teamCases = await prisma.case.findMany({
        where: { teamId },
        select: { id: true, name: true },
      });
      const teamCaseIds = teamCases.map((c) => c.id);
      const caseNameById = new Map(teamCases.map((c) => [c.id, c.name]));

      const grants = teamCaseIds.length
        ? await prisma.caseAccess.findMany({
            where: { caseId: { in: teamCaseIds } },
            select: {
              id: true,
              userId: true,
              caseId: true,
              createdAt: true,
            },
          })
        : [];
      const externalGrants = grants.filter(
        (g) => !teamMemberIdSet.has(g.userId),
      );
      const externalUserIds = Array.from(
        new Set(externalGrants.map((g) => g.userId)),
      );
      const externalUsers = externalUserIds.length
        ? await prisma.user.findMany({
            where: { id: { in: externalUserIds } },
            select: { id: true, email: true, displayName: true },
          })
        : [];
      const externalUserById = new Map(externalUsers.map((u) => [u.id, u]));

      const externalCollaborators = externalUserIds.map((uid) => {
        const u = externalUserById.get(uid);
        const userGrants = externalGrants.filter((g) => g.userId === uid);
        const grantsList = userGrants.map((g) => ({
          grantId: g.id,
          caseId: g.caseId,
          caseName: caseNameById.get(g.caseId) ?? "(unknown case)",
          grantedAt: g.createdAt.toISOString(),
        }));
        const firstGrantedAt = grantsList.reduce(
          (acc, g) => (g.grantedAt < acc ? g.grantedAt : acc),
          grantsList[0]?.grantedAt ?? new Date().toISOString(),
        );
        return {
          kind: "EXTERNAL" as const,
          userId: uid,
          email: u?.email ?? null,
          displayName: u?.displayName ?? null,
          firstGrantedAt,
          grants: grantsList,
        };
      });

      return reply.code(200).send({
        teamId,
        summary: {
          internalMembers: internal.length,
          pendingInvites: pendingInvites.length,
          externalCollaborators: externalCollaborators.length,
        },
        members: internal,
        pendingInvites,
        externalCollaborators,
      });
    },
  );

  // ===========================================================================
  // Phase 2.6D — Team-scoped external access revoke.
  //
  // The per-case revoke endpoint (`DELETE /v1/cases/:id/access/:accessId`)
  // requires `case.ownerUserId === caller`. That works for the case
  // OWNER but blocks a team ADMIN from revoking external grants on
  // cases they don't personally own. The brief asks for "external
  // access governable from one place" — meaning the workspace admin
  // surface, not the per-case surface.
  //
  // This route fills the gap: a team ADMIN+ can revoke any CaseAccess
  // grant on cases belonging to the team, regardless of who owns the
  // individual case. It does NOT mutate team membership; it only
  // deletes external CaseAccess rows. If the target user happens to
  // be a formal TeamMember (i.e. the grant is internal), the route
  // refuses with 422 INTERNAL_MEMBER — internal access is managed
  // through `/v1/teams/:id/members`, not here.
  //
  // Audit: emits `cases.access_revoke` per case + a parent
  // `teams.external_access_revoked` event so the team activity feed
  // sees one workspace-scoped record.
  // ===========================================================================
  app.delete(
    "/v1/teams/:id/external-grants/:grantId",
    { preHandler: requireAuthAndLegal },
    async (req: FastifyRequest, reply) => {
      const teamId = z.string().uuid().parse((req.params as { id: string }).id);
      const grantId = z
        .string()
        .uuid()
        .parse((req.params as { grantId: string }).grantId);
      const userId = getAuthUserId(req);

      const actor = await getActorMembership(teamId, userId);
      if (!actor || !hasRole(actor.role, prismaPkg.TeamRole.ADMIN)) {
        return reply.code(403).send({ message: "Forbidden" });
      }

      // Verify the grant exists and points at a case that belongs to
      // this team (defense in depth: prevent a team admin from
      // revoking grants on cases outside their team).
      const grant = await prisma.caseAccess.findUnique({
        where: { id: grantId },
        select: {
          id: true,
          caseId: true,
          userId: true,
          case: { select: { teamId: true, name: true } },
        },
      });
      if (!grant || grant.case?.teamId !== teamId) {
        return reply.code(404).send({
          code: "GRANT_NOT_FOUND",
          message: "External access grant not found on this team.",
        });
      }

      // Refuse to revoke a grant whose target user is a formal
      // team member — that's not "external" access, and removing it
      // here would silently drop a real team member's case access.
      // The operator should manage formal membership through the
      // members endpoints.
      const targetMembership = await prisma.teamMember.findFirst({
        where: { teamId, userId: grant.userId },
        select: { id: true },
      });
      if (targetMembership) {
        return reply.code(422).send({
          code: "INTERNAL_MEMBER",
          message:
            "This grant belongs to a formal team member. Manage their access via /v1/teams/:id/members.",
        });
      }

      // Delete the grant.
      await prisma.caseAccess.delete({ where: { id: grantId } });

      // Audit the per-case revoke action (matches the existing
      // `cases.access_revoke` taxonomy) and a parent team event so
      // the team activity feed surfaces it.
      auditTeamAction(req, {
        userId,
        action: "teams.external_access_revoked",
        outcome: "success",
        resourceId: teamId,
        metadata: {
          grantId,
          caseId: grant.caseId,
          caseName: grant.case?.name ?? null,
          targetUserId: grant.userId,
        },
      });
      try {
        await prisma.teamActivity.create({
          data: {
            teamId,
            actorUserId: userId,
            eventType: "team.external_access_revoked",
            targetType: "case_access",
            targetId: grantId,
            metadata: {
              caseId: grant.caseId,
              caseName: grant.case?.name ?? null,
              targetUserId: grant.userId,
            },
          },
        });
      } catch {
        /* best-effort timeline write */
      }

      return reply.code(200).send({ ok: true, grantId });
    },
  );

  // ===========================================================================
  // Phase 2.6D — Canonical RBAC matrix endpoint.
  //
  // Single source of truth for the OWNER/ADMIN/MEMBER/VIEWER role
  // hierarchy + the capabilities each role grants. Consumed by the
  // frontend TeamPermissionMatrix component so the UI never drifts
  // from the backend rbac implementation.
  //
  // The matrix is keyed by stable capability ids; categories are
  // presentational only. Adding a backend capability requires:
  //   1. Implementing the route + the hasRole(...) check.
  //   2. Adding a row to this catalog.
  //   3. CI continues to pass.
  // The matrix is read by every workspace admin on every `/teams/[id]`
  // mount; the response is cacheable for the lifetime of an app deploy
  // because the catalog is compiled into the API binary.
  //
  // No auth required — the matrix is the rbac taxonomy itself, not
  // user-specific. We DO require an authenticated request so anonymous
  // crawlers can't enumerate the API surface (cheap defense in depth).
  // ===========================================================================
  app.get(
    "/v1/platform/rbac/matrix",
    { preHandler: requireAuthAndLegal },
    async (_req: FastifyRequest, reply) => {
      // The catalog is intentionally inlined here. The Phase 2.6
      // TeamPermissionMatrix.tsx maintains the same shape; keeping
      // one copy of the source of truth in the API binary means the
      // frontend can fetch it AND fall back to a static copy if the
      // network is unavailable, without two ever-drifting hand-
      // maintained lists.
      //
      // The catalog mirrors `services/api/src/services/rbac.ts`'s
      // OWNER > ADMIN > MEMBER > VIEWER hierarchy: a row's `roles`
      // array lists every role whose `hasRole(role, ROW.minimumRole)`
      // returns true. When a future PR adds a capability, the
      // canonical place to register it is here.
      return reply.code(200).send({
        roles: [
          { id: "OWNER", label: "Owner", rank: 3 },
          { id: "ADMIN", label: "Admin", rank: 2 },
          { id: "MEMBER", label: "Member", rank: 1 },
          { id: "VIEWER", label: "Viewer", rank: 0 },
        ],
        categories: [
          {
            id: "evidence",
            label: "Evidence",
            capabilities: [
              {
                id: "evidence.view",
                label: "View evidence",
                roles: ["OWNER", "ADMIN", "MEMBER", "VIEWER"],
                description:
                  "Browse the workspace evidence library and open individual records.",
              },
              {
                id: "evidence.upload",
                label: "Upload + finalize evidence",
                roles: ["OWNER", "ADMIN", "MEMBER"],
                description:
                  "Create new evidence records via the capture flow, complete uploads, and finalize hash/signature pipeline.",
              },
              {
                id: "evidence.manage",
                label: "Manage evidence",
                roles: ["OWNER", "ADMIN", "MEMBER"],
                description:
                  "Edit titles/tags/retention class; archive or soft-delete records.",
              },
            ],
          },
          {
            id: "reports",
            label: "Reports & verification",
            capabilities: [
              {
                id: "report.generate",
                label: "Generate report snapshots",
                roles: ["OWNER", "ADMIN", "MEMBER"],
                description:
                  "Trigger a new report version. Report contents are operator-only.",
              },
              {
                id: "report.download",
                label: "Download report / verification package",
                roles: ["OWNER", "ADMIN", "MEMBER", "VIEWER"],
                description:
                  "Download the signed PDF / verification archive. Custody event written on every download.",
              },
            ],
          },
          {
            id: "cases",
            label: "Cases",
            capabilities: [
              {
                id: "case.view",
                label: "View cases",
                roles: ["OWNER", "ADMIN", "MEMBER", "VIEWER"],
                description:
                  "Browse and open cases scoped to this workspace; see linked evidence and timeline.",
              },
              {
                id: "case.create",
                label: "Create cases",
                roles: ["OWNER", "ADMIN", "MEMBER"],
                description: "Open new cases.",
              },
              {
                id: "case.manage",
                label: "Manage case lifecycle (status, archive, close)",
                roles: ["OWNER", "ADMIN"],
                description:
                  "Change case status. Closure cascades active assignments automatically.",
              },
              {
                id: "case.assign_reviewers",
                label: "Assign reviewers",
                roles: ["OWNER", "ADMIN"],
                description:
                  "Assign / re-assign reviewer roles on a case.",
              },
            ],
          },
          {
            id: "reviewer",
            label: "Reviewer workflow",
            capabilities: [
              {
                id: "review.queue",
                label: "View review queue",
                roles: ["OWNER", "ADMIN", "MEMBER"],
                description:
                  "See assigned reviews + workspace queue depth.",
              },
              {
                id: "review.action",
                label: "Approve / reject / pause / request-info",
                roles: ["OWNER", "ADMIN", "MEMBER"],
                description:
                  "Drive a review through its lifecycle. Reason text required for non-approve actions.",
              },
              {
                id: "review.escalation",
                label: "Resolve escalations",
                roles: ["OWNER", "ADMIN"],
                description:
                  "Resolve, suppress, reassign escalations.",
              },
            ],
          },
          {
            id: "team",
            label: "Team governance",
            capabilities: [
              {
                id: "team.invite",
                label: "Invite members",
                roles: ["OWNER", "ADMIN"],
                description:
                  "Send team invites. Subject to the workspace seat limit.",
              },
              {
                id: "team.role_change",
                label: "Change member role",
                roles: ["OWNER", "ADMIN"],
                description:
                  "Promote or demote between ADMIN / MEMBER / VIEWER.",
              },
              {
                id: "team.remove",
                label: "Remove members (with ownership transfer)",
                roles: ["OWNER", "ADMIN"],
                description:
                  "Offboard a member. Owned evidence / cases must be transferred first.",
              },
              {
                id: "team.external_revoke",
                label: "Revoke external access grants",
                roles: ["OWNER", "ADMIN"],
                description:
                  "Revoke non-team-member access grants on the workspace's cases (Phase 2.6D).",
              },
              {
                id: "team.delete",
                label: "Delete the team workspace",
                roles: ["OWNER"],
                description:
                  "Destructive. Only the OWNER can delete the team.",
              },
            ],
          },
          {
            id: "billing_security",
            label: "Billing & security",
            capabilities: [
              {
                id: "billing.view",
                label: "View billing + seats",
                roles: ["OWNER", "ADMIN", "MEMBER", "VIEWER"],
                description: "See plan, seat usage, billing owner.",
              },
              {
                id: "billing.manage",
                label: "Change plan / manage subscription",
                roles: ["OWNER"],
                description:
                  "Upgrade, downgrade, cancel subscriptions; manage storage add-ons.",
              },
              {
                id: "security_center.view",
                label: "Open Security Center",
                roles: ["OWNER", "ADMIN"],
                description:
                  "View workspace MFA policy, trusted devices, sessions, SAML config, SCIM tokens.",
              },
              {
                id: "security_center.manage",
                label: "Manage workspace MFA policy / SSO config",
                roles: ["OWNER", "ADMIN"],
                description:
                  "Change MFA enforcement level, manage SAML connections, revoke SCIM tokens. Step-up required.",
              },
            ],
          },
          {
            id: "audit",
            label: "Audit & activity",
            capabilities: [
              {
                id: "audit.workspace_activity",
                label: "View workspace activity feed",
                roles: ["OWNER", "ADMIN", "MEMBER"],
                description:
                  "See member invitations, role changes, ownership transfers, policy changes recorded in `team_activities`.",
              },
              {
                id: "audit.platform",
                label: "View platform audit log",
                roles: [],
                description:
                  "PLATFORM_ADMIN only — not granted by team role.",
              },
            ],
          },
        ],
        // Metadata so the frontend can fall back gracefully if the
        // endpoint version drifts from its bundled schema.
        version: "2.6D",
        generatedAt: new Date().toISOString(),
      });
    },
  );
}