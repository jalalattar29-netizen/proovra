/**
 * PROOVRA Phase 5 — Collaboration Team service.
 *
 * The canonical implementation of the Team Collaboration Platform.
 * All mutations + reads flow through this module. Route handlers
 * are thin wrappers that:
 *
 *   1. Resolve the active workspace via
 *      `resolveActiveOperationalWorkspace` (Phase 3 canonical resolver).
 *   2. Call a method here.
 *   3. Return the bounded result + emit canonical audit event.
 *
 * Hard rules (Phase 5 constitution):
 *
 *   - Collaboration Team is NOT a workspace; every team has a
 *     `workspaceId` pointing to the legacy `Team.id` (runtime workspace).
 *   - Personal users CAN create teams without an Organization.
 *   - All mutations emit a `CollaborationTeamActivity` row.
 *   - Token raw values NEVER reach the database; only sha256 hashes.
 *   - Plan limits are enforced before every mutation that grows
 *     team/member/invite counts.
 *
 * Constitutional reference:
 *   docs/architecture/phase-5-team-platform-readiness.md
 *   docs/architecture/phase-5-team-platform-final.md
 */

import { createHash, randomBytes } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import {
  COLLABORATION_TEAM_ASSIGNMENT_PRIORITIES,
  COLLABORATION_TEAM_ASSIGNMENT_STATUSES,
  COLLABORATION_TEAM_ASSIGNMENT_TARGETS,
  COLLABORATION_TEAM_INVITE_CHANNELS,
  COLLABORATION_TEAM_INVITE_TOKEN_PREFIX,
  COLLABORATION_TEAM_INVITE_TOKEN_RANDOM_BYTES,
  COLLABORATION_TEAM_MANAGE_ROLES,
  COLLABORATION_TEAM_ROLES,
  COLLABORATION_TEAM_TRANSFER_LEAD_ROLES,
  COLLABORATION_TEAM_TYPES,
  collaborationTeamRoleHasPermission,
  getCollaborationTeamPlanLimits,
  type CollaborationTeamActivityEventType,
  type CollaborationTeamAssignmentPriority,
  type CollaborationTeamAssignmentStatus,
  type CollaborationTeamAssignmentTarget,
  type CollaborationTeamInviteChannel,
  type CollaborationTeamPermission,
  type CollaborationTeamRole,
  type CollaborationTeamType,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";

// =============================================================================
// Errors
// =============================================================================

export class CollaborationTeamError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  constructor(code: string, message: string, httpStatus = 400) {
    super(message);
    this.name = "CollaborationTeamError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

const E = {
  notFound: (what: string) =>
    new CollaborationTeamError("team_not_found", `${what} not found.`, 404),
  forbidden: (perm: string) =>
    new CollaborationTeamError(
      "team_forbidden",
      `Permission required: ${perm}.`,
      403,
    ),
  invalid: (msg: string) =>
    new CollaborationTeamError("team_invalid", msg, 400),
  conflict: (msg: string) =>
    new CollaborationTeamError("team_conflict", msg, 409),
  rateLimited: (msg: string) =>
    new CollaborationTeamError("team_rate_limited", msg, 429),
  planLimit: (msg: string) =>
    new CollaborationTeamError("team_plan_limit", msg, 402),
};

// =============================================================================
// Token helpers
// =============================================================================

function generateInviteToken(): { raw: string; hash: string } {
  const buf = randomBytes(COLLABORATION_TEAM_INVITE_TOKEN_RANDOM_BYTES);
  // base32 (RFC 4648, no padding) for URL-safety + SMS-readability.
  const raw =
    COLLABORATION_TEAM_INVITE_TOKEN_PREFIX + base32Encode(buf).replace(/=+$/, "");
  const hash = createHash("sha256").update(raw).digest("hex");
  return { raw, hash };
}

function hashInviteToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function base32Encode(buf: Buffer): string {
  const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

// =============================================================================
// Validation helpers
// =============================================================================

const NAME_MAX = 120;
const DESC_MAX = 600;

function validateName(name: string | null | undefined): string {
  const trimmed = (name ?? "").trim();
  if (trimmed.length === 0) throw E.invalid("Team name is required.");
  if (trimmed.length > NAME_MAX)
    throw E.invalid(`Team name max ${NAME_MAX} chars.`);
  return trimmed;
}

function validateDescription(d: string | null | undefined): string | null {
  if (d === null || d === undefined) return null;
  const t = d.trim();
  if (t.length === 0) return null;
  if (t.length > DESC_MAX)
    throw E.invalid(`Description max ${DESC_MAX} chars.`);
  return t;
}

function validateTeamType(t: string | null | undefined): CollaborationTeamType {
  if (!t) return "GENERAL";
  if (
    (COLLABORATION_TEAM_TYPES as ReadonlyArray<string>).includes(t)
  )
    return t as CollaborationTeamType;
  throw E.invalid(
    `team_type must be one of ${COLLABORATION_TEAM_TYPES.join(", ")}.`,
  );
}

function validateRole(r: string | null | undefined): CollaborationTeamRole {
  if (!r) return "MEMBER";
  if ((COLLABORATION_TEAM_ROLES as ReadonlyArray<string>).includes(r))
    return r as CollaborationTeamRole;
  throw E.invalid(`role must be one of ${COLLABORATION_TEAM_ROLES.join(", ")}.`);
}

function validateChannel(
  c: string | null | undefined,
): CollaborationTeamInviteChannel {
  if (!c || !(COLLABORATION_TEAM_INVITE_CHANNELS as ReadonlyArray<string>).includes(c))
    throw E.invalid("channel must be EMAIL, SMS, or LINK.");
  return c as CollaborationTeamInviteChannel;
}

function validateAssignmentTarget(
  t: string | null | undefined,
): CollaborationTeamAssignmentTarget {
  if (
    !t ||
    !(COLLABORATION_TEAM_ASSIGNMENT_TARGETS as ReadonlyArray<string>).includes(t)
  )
    throw E.invalid("target_type must be CASE, EVIDENCE, or REVIEW.");
  return t as CollaborationTeamAssignmentTarget;
}

function validatePriority(
  p: string | null | undefined,
): CollaborationTeamAssignmentPriority {
  if (!p) return "NORMAL";
  if (
    (COLLABORATION_TEAM_ASSIGNMENT_PRIORITIES as ReadonlyArray<string>).includes(p)
  )
    return p as CollaborationTeamAssignmentPriority;
  throw E.invalid(
    `priority must be one of ${COLLABORATION_TEAM_ASSIGNMENT_PRIORITIES.join(", ")}.`,
  );
}

function validateAssignmentStatus(
  s: string | null | undefined,
): CollaborationTeamAssignmentStatus {
  if (
    !s ||
    !(COLLABORATION_TEAM_ASSIGNMENT_STATUSES as ReadonlyArray<string>).includes(s)
  )
    throw E.invalid(
      `status must be one of ${COLLABORATION_TEAM_ASSIGNMENT_STATUSES.join(", ")}.`,
    );
  return s as CollaborationTeamAssignmentStatus;
}

const EMAIL_RE =
  /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

function validateEmail(e: string | null | undefined): string {
  if (!e || typeof e !== "string" || !EMAIL_RE.test(e))
    throw E.invalid("A valid email address is required.");
  return e.toLowerCase();
}

function validatePhone(p: string | null | undefined): string {
  if (!p || typeof p !== "string") throw E.invalid("Phone is required.");
  // Lazy E.164 check; consumer should normalise upstream via shared helper.
  if (!/^\+[1-9]\d{7,14}$/.test(p))
    throw E.invalid("Phone must be E.164 (e.g. +12025551234).");
  return p;
}

// =============================================================================
// Activity emitter
// =============================================================================

async function recordActivity(
  client: PrismaClient | Prisma.TransactionClient,
  args: {
    teamId: string;
    workspaceId: string;
    actorUserId: string | null;
    eventType: CollaborationTeamActivityEventType;
    targetType?: string | null;
    targetId?: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await client.collaborationTeamActivity.create({
    data: {
      teamId: args.teamId,
      workspaceId: args.workspaceId,
      actorUserId: args.actorUserId,
      eventType: args.eventType,
      targetType: args.targetType ?? null,
      targetId: args.targetId ?? null,
      metadata: (args.metadata ?? {}) as Prisma.InputJsonValue,
    },
  });
}

// =============================================================================
// Permission helpers
// =============================================================================

async function requireMemberWithPermission(
  client: PrismaClient,
  teamId: string,
  actorUserId: string,
  permission: CollaborationTeamPermission,
): Promise<{ role: CollaborationTeamRole; team: { id: string; workspaceId: string; status: string } }> {
  const team = await client.collaborationTeam.findUnique({
    where: { id: teamId },
    select: { id: true, workspaceId: true, status: true },
  });
  if (!team) throw E.notFound("Team");
  const member = await client.collaborationTeamMember.findFirst({
    where: { teamId, userId: actorUserId, status: "ACTIVE" },
    select: { role: true },
  });
  if (!member) throw E.forbidden(permission);
  const role = member.role as CollaborationTeamRole;
  if (!collaborationTeamRoleHasPermission(role, permission))
    throw E.forbidden(permission);
  return { role, team };
}

// =============================================================================
// Plan-limit enforcement
// =============================================================================

type WorkspacePlanForLimits =
  | "FREE"
  | "PAYG"
  | "PRO"
  | "TEAM"
  | "ENTERPRISE"
  | string;

async function resolveWorkspacePlan(
  client: PrismaClient,
  workspaceId: string,
): Promise<WorkspacePlanForLimits> {
  const ws = await client.team.findUnique({
    where: { id: workspaceId },
    select: { billingPlan: true },
  });
  return (ws?.billingPlan ?? "FREE") as WorkspacePlanForLimits;
}

// =============================================================================
// Public API
// =============================================================================

// -----------------------------------------------------------------------------
// Teams CRUD
// -----------------------------------------------------------------------------

export async function createCollaborationTeam(
  input: {
    workspaceId: string;
    actorUserId: string;
    name: string;
    description?: string | null;
    teamType?: string | null;
  },
  client: PrismaClient = defaultPrisma,
): Promise<{ id: string }> {
  const name = validateName(input.name);
  const description = validateDescription(input.description);
  const teamType = validateTeamType(input.teamType);

  // Plan limit: maxTeams.
  const plan = await resolveWorkspacePlan(client, input.workspaceId);
  const limits = getCollaborationTeamPlanLimits(plan);
  const existingActive = await client.collaborationTeam.count({
    where: { workspaceId: input.workspaceId, status: "ACTIVE" },
  });
  if (existingActive >= limits.maxTeams) {
    throw E.planLimit(
      `Plan ${plan} allows up to ${limits.maxTeams} active team(s). Archive or upgrade to add more.`,
    );
  }

  const result = await client.$transaction(async (tx) => {
    const team = await tx.collaborationTeam.create({
      data: {
        workspaceId: input.workspaceId,
        name,
        description,
        teamType,
        status: "ACTIVE",
        createdByUserId: input.actorUserId,
      },
      select: { id: true },
    });
    // Creator becomes LEAD.
    await tx.collaborationTeamMember.create({
      data: {
        teamId: team.id,
        userId: input.actorUserId,
        role: "LEAD",
        status: "ACTIVE",
        invitedByUserId: null,
      },
    });
    await recordActivity(tx, {
      teamId: team.id,
      workspaceId: input.workspaceId,
      actorUserId: input.actorUserId,
      eventType: "TEAM_CREATED",
      metadata: { name, teamType },
    });
    return team;
  });

  return { id: result.id };
}

export async function listCollaborationTeams(
  input: { workspaceId: string; actorUserId: string; includeArchived?: boolean },
  client: PrismaClient = defaultPrisma,
): Promise<
  Array<{
    id: string;
    name: string;
    description: string | null;
    teamType: CollaborationTeamType;
    status: string;
    createdAt: Date;
    updatedAt: Date;
    archivedAtUtc: Date | null;
    memberCount: number;
    pendingInviteCount: number;
    openAssignmentCount: number;
    lastActivityAt: Date | null;
    viewerRole: CollaborationTeamRole | null;
  }>
> {
  const teams = await client.collaborationTeam.findMany({
    where: {
      workspaceId: input.workspaceId,
      ...(input.includeArchived ? {} : { status: "ACTIVE" }),
      // Only teams where the actor is a member (across all statuses,
      // so a removed member can still see history if surfaced — but
      // sidebar will only show ACTIVE).
      members: { some: { userId: input.actorUserId } },
    },
    orderBy: { updatedAt: "desc" },
    take: 100,
    include: {
      _count: {
        select: {
          members: { where: { status: "ACTIVE" } } as any,
          invites: { where: { status: "PENDING" } } as any,
          assignments: { where: { status: { in: ["OPEN", "IN_PROGRESS"] } } } as any,
        },
      },
      activity: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { createdAt: true },
      },
      members: {
        where: { userId: input.actorUserId },
        select: { role: true, status: true },
        take: 1,
      },
    },
  });
  return teams.map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    teamType: t.teamType as CollaborationTeamType,
    status: t.status,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    archivedAtUtc: t.archivedAtUtc,
    memberCount: (t._count.members as number) ?? 0,
    pendingInviteCount: (t._count.invites as number) ?? 0,
    openAssignmentCount: (t._count.assignments as number) ?? 0,
    lastActivityAt: t.activity[0]?.createdAt ?? null,
    viewerRole:
      t.members[0] && t.members[0].status === "ACTIVE"
        ? (t.members[0].role as CollaborationTeamRole)
        : null,
  }));
}

export async function getCollaborationTeamDetail(
  input: { teamId: string; actorUserId: string },
  client: PrismaClient = defaultPrisma,
) {
  const team = await client.collaborationTeam.findUnique({
    where: { id: input.teamId },
    include: {
      members: {
        orderBy: { joinedAt: "asc" },
        include: {
          user: {
            select: {
              id: true,
              email: true,
              displayName: true,
              firstName: true,
              lastName: true,
              avatarUrl: true,
            },
          },
        },
      },
      invites: {
        where: { status: { in: ["PENDING", "ACCEPTED"] } },
        orderBy: { createdAt: "desc" },
        take: 50,
      },
      _count: {
        select: {
          assignments: true,
        },
      },
    },
  });
  if (!team) throw E.notFound("Team");
  const viewer = team.members.find(
    (m) => m.userId === input.actorUserId && m.status === "ACTIVE",
  );
  if (!viewer) throw E.forbidden("team.read");
  return {
    id: team.id,
    workspaceId: team.workspaceId,
    name: team.name,
    description: team.description,
    teamType: team.teamType as CollaborationTeamType,
    status: team.status,
    createdAt: team.createdAt,
    updatedAt: team.updatedAt,
    archivedAtUtc: team.archivedAtUtc,
    viewerRole: viewer.role as CollaborationTeamRole,
    members: team.members.map((m) => ({
      id: m.id,
      userId: m.userId,
      role: m.role as CollaborationTeamRole,
      status: m.status,
      joinedAt: m.joinedAt,
      suspendedAt: m.suspendedAt,
      removedAt: m.removedAt,
      user: m.user,
    })),
    invites: team.invites.map((inv) => ({
      id: inv.id,
      channel: inv.channel as CollaborationTeamInviteChannel,
      email: inv.email,
      phone: inv.phone,
      role: inv.role as CollaborationTeamRole,
      status: inv.status,
      expiresAtUtc: inv.expiresAtUtc,
      maxUses: inv.maxUses,
      useCount: inv.useCount,
      createdAt: inv.createdAt,
      deliveryStatus: inv.deliveryStatus,
    })),
    assignmentCount: team._count.assignments as number,
  };
}

export async function updateCollaborationTeam(
  input: {
    teamId: string;
    actorUserId: string;
    name?: string;
    description?: string | null;
    teamType?: string;
  },
  client: PrismaClient = defaultPrisma,
): Promise<void> {
  const { team } = await requireMemberWithPermission(
    client,
    input.teamId,
    input.actorUserId,
    "team.update_settings",
  );
  const data: Prisma.CollaborationTeamUpdateInput = {};
  const meta: Record<string, unknown> = {};
  let renamed = false;
  let descriptionChanged = false;
  let typeChanged = false;

  if (input.name !== undefined) {
    const name = validateName(input.name);
    data.name = name;
    meta.name = name;
    renamed = true;
  }
  if (input.description !== undefined) {
    const description = validateDescription(input.description);
    data.description = description;
    meta.description = description;
    descriptionChanged = true;
  }
  if (input.teamType !== undefined) {
    const teamType = validateTeamType(input.teamType);
    data.teamType = teamType;
    meta.teamType = teamType;
    typeChanged = true;
  }
  if (Object.keys(data).length === 0) return;

  await client.$transaction(async (tx) => {
    await tx.collaborationTeam.update({
      where: { id: input.teamId },
      data,
    });
    if (renamed)
      await recordActivity(tx, {
        teamId: input.teamId,
        workspaceId: team.workspaceId,
        actorUserId: input.actorUserId,
        eventType: "TEAM_RENAMED",
        metadata: meta,
      });
    if (descriptionChanged)
      await recordActivity(tx, {
        teamId: input.teamId,
        workspaceId: team.workspaceId,
        actorUserId: input.actorUserId,
        eventType: "TEAM_DESCRIPTION_CHANGED",
        metadata: meta,
      });
    if (typeChanged)
      await recordActivity(tx, {
        teamId: input.teamId,
        workspaceId: team.workspaceId,
        actorUserId: input.actorUserId,
        eventType: "TEAM_TYPE_CHANGED",
        metadata: meta,
      });
  });
}

export async function archiveCollaborationTeam(
  input: { teamId: string; actorUserId: string },
  client: PrismaClient = defaultPrisma,
): Promise<void> {
  const { team } = await requireMemberWithPermission(
    client,
    input.teamId,
    input.actorUserId,
    "team.archive",
  );
  if (team.status === "ARCHIVED") return;
  await client.$transaction(async (tx) => {
    await tx.collaborationTeam.update({
      where: { id: input.teamId },
      data: { status: "ARCHIVED", archivedAtUtc: new Date() },
    });
    await recordActivity(tx, {
      teamId: input.teamId,
      workspaceId: team.workspaceId,
      actorUserId: input.actorUserId,
      eventType: "TEAM_ARCHIVED",
    });
  });
}

// -----------------------------------------------------------------------------
// Members
// -----------------------------------------------------------------------------

export async function addExistingMember(
  input: {
    teamId: string;
    actorUserId: string;
    userIdToAdd: string;
    role?: string;
  },
  client: PrismaClient = defaultPrisma,
): Promise<{ id: string }> {
  const { team } = await requireMemberWithPermission(
    client,
    input.teamId,
    input.actorUserId,
    "team.member.invite",
  );
  const role = validateRole(input.role);

  // Confirm the user is a member of the parent workspace (cross-workspace
  // additions are forbidden — collaboration teams never cross workspace lines).
  const ws = await client.teamMember.findFirst({
    where: {
      teamId: team.workspaceId,
      userId: input.userIdToAdd,
      status: "ACTIVE",
    },
    select: { id: true },
  });
  if (!ws)
    throw E.invalid(
      "Target user is not an active member of the parent workspace.",
    );

  // Plan limit: maxMembersPerTeam.
  const plan = await resolveWorkspacePlan(client, team.workspaceId);
  const limits = getCollaborationTeamPlanLimits(plan);
  const activeCount = await client.collaborationTeamMember.count({
    where: { teamId: input.teamId, status: "ACTIVE" },
  });
  if (activeCount >= limits.maxMembersPerTeam)
    throw E.planLimit(
      `Plan ${plan} allows up to ${limits.maxMembersPerTeam} active members per team.`,
    );

  // Upsert — a previously removed member can be reinstated.
  const existing = await client.collaborationTeamMember.findUnique({
    where: {
      collaboration_team_member_team_user_uniq: {
        teamId: input.teamId,
        userId: input.userIdToAdd,
      },
    },
    select: { id: true, status: true },
  });

  const result = await client.$transaction(async (tx) => {
    let row;
    if (existing) {
      if (existing.status === "ACTIVE")
        throw E.conflict("User is already an active member of this team.");
      row = await tx.collaborationTeamMember.update({
        where: { id: existing.id },
        data: {
          role,
          status: "ACTIVE",
          invitedByUserId: input.actorUserId,
          joinedAt: new Date(),
          suspendedAt: null,
          removedAt: null,
          statusReason: null,
        },
        select: { id: true },
      });
      await recordActivity(tx, {
        teamId: input.teamId,
        workspaceId: team.workspaceId,
        actorUserId: input.actorUserId,
        eventType: "MEMBER_REINSTATED",
        targetType: "USER",
        targetId: input.userIdToAdd,
        metadata: { role },
      });
    } else {
      row = await tx.collaborationTeamMember.create({
        data: {
          teamId: input.teamId,
          userId: input.userIdToAdd,
          role,
          status: "ACTIVE",
          invitedByUserId: input.actorUserId,
        },
        select: { id: true },
      });
      await recordActivity(tx, {
        teamId: input.teamId,
        workspaceId: team.workspaceId,
        actorUserId: input.actorUserId,
        eventType: "MEMBER_ADDED",
        targetType: "USER",
        targetId: input.userIdToAdd,
        metadata: { role },
      });
    }
    return row;
  });
  return result;
}

export async function changeMemberRole(
  input: {
    teamId: string;
    actorUserId: string;
    memberId: string;
    role: string;
  },
  client: PrismaClient = defaultPrisma,
): Promise<void> {
  const { team, role: actorRole } = await requireMemberWithPermission(
    client,
    input.teamId,
    input.actorUserId,
    "team.member.change_role",
  );
  const newRole = validateRole(input.role);

  // Only LEAD can grant LEAD.
  if (newRole === "LEAD" && actorRole !== "LEAD")
    throw E.forbidden("team.transfer_lead");

  const member = await client.collaborationTeamMember.findUnique({
    where: { id: input.memberId },
    select: {
      id: true,
      userId: true,
      role: true,
      status: true,
      teamId: true,
    },
  });
  if (!member || member.teamId !== input.teamId) throw E.notFound("Member");
  if (member.role === newRole) return;

  // Prevent demoting the LAST lead.
  if (member.role === "LEAD" && newRole !== "LEAD") {
    const leadCount = await client.collaborationTeamMember.count({
      where: { teamId: input.teamId, role: "LEAD", status: "ACTIVE" },
    });
    if (leadCount <= 1)
      throw E.conflict(
        "Cannot demote the last LEAD. Transfer leadership first.",
      );
  }

  await client.$transaction(async (tx) => {
    await tx.collaborationTeamMember.update({
      where: { id: input.memberId },
      data: { role: newRole },
    });
    await recordActivity(tx, {
      teamId: input.teamId,
      workspaceId: team.workspaceId,
      actorUserId: input.actorUserId,
      eventType:
        member.role !== "LEAD" && newRole === "LEAD"
          ? "LEAD_TRANSFERRED"
          : "MEMBER_ROLE_CHANGED",
      targetType: "USER",
      targetId: member.userId,
      metadata: { from: member.role, to: newRole },
    });
  });
}

export async function suspendMember(
  input: {
    teamId: string;
    actorUserId: string;
    memberId: string;
    reason?: string | null;
  },
  client: PrismaClient = defaultPrisma,
): Promise<void> {
  const { team } = await requireMemberWithPermission(
    client,
    input.teamId,
    input.actorUserId,
    "team.member.suspend",
  );
  const member = await client.collaborationTeamMember.findUnique({
    where: { id: input.memberId },
    select: { id: true, userId: true, status: true, teamId: true },
  });
  if (!member || member.teamId !== input.teamId) throw E.notFound("Member");
  if (member.status !== "ACTIVE") return;
  await client.$transaction(async (tx) => {
    await tx.collaborationTeamMember.update({
      where: { id: input.memberId },
      data: {
        status: "SUSPENDED",
        suspendedAt: new Date(),
        statusReason: (input.reason ?? "").slice(0, 400) || null,
      },
    });
    await recordActivity(tx, {
      teamId: input.teamId,
      workspaceId: team.workspaceId,
      actorUserId: input.actorUserId,
      eventType: "MEMBER_SUSPENDED",
      targetType: "USER",
      targetId: member.userId,
    });
  });
}

export async function removeMember(
  input: {
    teamId: string;
    actorUserId: string;
    memberId: string;
  },
  client: PrismaClient = defaultPrisma,
): Promise<void> {
  const { team } = await requireMemberWithPermission(
    client,
    input.teamId,
    input.actorUserId,
    "team.member.remove",
  );
  const member = await client.collaborationTeamMember.findUnique({
    where: { id: input.memberId },
    select: { id: true, userId: true, status: true, role: true, teamId: true },
  });
  if (!member || member.teamId !== input.teamId) throw E.notFound("Member");
  if (member.status === "REMOVED") return;
  // Prevent removing the last LEAD.
  if (member.role === "LEAD") {
    const leadCount = await client.collaborationTeamMember.count({
      where: { teamId: input.teamId, role: "LEAD", status: "ACTIVE" },
    });
    if (leadCount <= 1)
      throw E.conflict("Cannot remove the last LEAD. Transfer leadership first.");
  }
  await client.$transaction(async (tx) => {
    await tx.collaborationTeamMember.update({
      where: { id: input.memberId },
      data: { status: "REMOVED", removedAt: new Date() },
    });
    await recordActivity(tx, {
      teamId: input.teamId,
      workspaceId: team.workspaceId,
      actorUserId: input.actorUserId,
      eventType: "MEMBER_REMOVED",
      targetType: "USER",
      targetId: member.userId,
    });
  });
}

// -----------------------------------------------------------------------------
// Invitations
// -----------------------------------------------------------------------------

export type CreatedInvite = {
  id: string;
  channel: CollaborationTeamInviteChannel;
  rawToken: string;
  acceptUrl: string;
  expiresAtUtc: Date;
};

const DEFAULT_INVITE_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

function buildAcceptUrl(rawToken: string): string {
  const base = (process.env.WEB_BASE_URL ?? "https://app.proovra.com").replace(
    /\/$/,
    "",
  );
  return `${base}/collaboration-teams/invites/${encodeURIComponent(rawToken)}/accept`;
}

async function enforceInviteLimits(
  client: PrismaClient,
  args: { teamId: string; workspaceId: string; actorUserId: string; channel: CollaborationTeamInviteChannel },
): Promise<void> {
  const plan = await resolveWorkspacePlan(client, args.workspaceId);
  const limits = getCollaborationTeamPlanLimits(plan);
  if (args.channel === "SMS" && !limits.smsInvitesEnabled)
    throw E.planLimit(`Plan ${plan} does not include SMS invites.`);
  if (args.channel === "LINK" && !limits.linkInvitesEnabled)
    throw E.planLimit(`Plan ${plan} does not include invite links.`);
  const pending = await client.collaborationTeamInvite.count({
    where: { teamId: args.teamId, status: "PENDING" },
  });
  if (pending >= limits.maxPendingInvitesPerTeam)
    throw E.planLimit(
      `Plan ${plan} allows up to ${limits.maxPendingInvitesPerTeam} pending invites per team.`,
    );
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const recent = await client.collaborationTeamInvite.count({
    where: { createdByUserId: args.actorUserId, createdAt: { gte: since } },
  });
  if (recent >= limits.maxInvitesPer24h)
    throw E.rateLimited(
      `You've issued ${recent} invites in the last 24h. Plan limit: ${limits.maxInvitesPer24h}.`,
    );
}

export async function createEmailInvite(
  input: {
    teamId: string;
    actorUserId: string;
    email: string;
    role?: string;
    expiresInMs?: number;
  },
  client: PrismaClient = defaultPrisma,
): Promise<CreatedInvite> {
  const { team } = await requireMemberWithPermission(
    client,
    input.teamId,
    input.actorUserId,
    "team.member.invite",
  );
  const email = validateEmail(input.email);
  const role = validateRole(input.role);
  await enforceInviteLimits(client, {
    teamId: input.teamId,
    workspaceId: team.workspaceId,
    actorUserId: input.actorUserId,
    channel: "EMAIL",
  });

  const { raw, hash } = generateInviteToken();
  const expiresAtUtc = new Date(
    Date.now() + (input.expiresInMs ?? DEFAULT_INVITE_TTL_MS),
  );

  const invite = await client.$transaction(async (tx) => {
    const created = await tx.collaborationTeamInvite.create({
      data: {
        teamId: input.teamId,
        workspaceId: team.workspaceId,
        channel: "EMAIL",
        email,
        tokenHash: hash,
        role,
        status: "PENDING",
        expiresAtUtc,
        maxUses: 1,
        createdByUserId: input.actorUserId,
      },
      select: { id: true, expiresAtUtc: true },
    });
    await recordActivity(tx, {
      teamId: input.teamId,
      workspaceId: team.workspaceId,
      actorUserId: input.actorUserId,
      eventType: "MEMBER_INVITED",
      targetType: "INVITE",
      targetId: created.id,
      metadata: { channel: "EMAIL", role, emailMasked: maskEmail(email) },
    });
    return created;
  });

  return {
    id: invite.id,
    channel: "EMAIL",
    rawToken: raw,
    acceptUrl: buildAcceptUrl(raw),
    expiresAtUtc: invite.expiresAtUtc,
  };
}

export async function createSmsInvite(
  input: {
    teamId: string;
    actorUserId: string;
    phone: string;
    role?: string;
    expiresInMs?: number;
  },
  client: PrismaClient = defaultPrisma,
): Promise<CreatedInvite> {
  const { team } = await requireMemberWithPermission(
    client,
    input.teamId,
    input.actorUserId,
    "team.member.invite",
  );
  const phone = validatePhone(input.phone);
  const role = validateRole(input.role);
  await enforceInviteLimits(client, {
    teamId: input.teamId,
    workspaceId: team.workspaceId,
    actorUserId: input.actorUserId,
    channel: "SMS",
  });

  const { raw, hash } = generateInviteToken();
  const expiresAtUtc = new Date(
    Date.now() + (input.expiresInMs ?? DEFAULT_INVITE_TTL_MS),
  );

  const invite = await client.$transaction(async (tx) => {
    const created = await tx.collaborationTeamInvite.create({
      data: {
        teamId: input.teamId,
        workspaceId: team.workspaceId,
        channel: "SMS",
        phone,
        tokenHash: hash,
        role,
        status: "PENDING",
        expiresAtUtc,
        maxUses: 1,
        createdByUserId: input.actorUserId,
      },
      select: { id: true, expiresAtUtc: true },
    });
    await recordActivity(tx, {
      teamId: input.teamId,
      workspaceId: team.workspaceId,
      actorUserId: input.actorUserId,
      eventType: "MEMBER_INVITED",
      targetType: "INVITE",
      targetId: created.id,
      metadata: { channel: "SMS", role, phoneMasked: maskPhone(phone) },
    });
    return created;
  });

  return {
    id: invite.id,
    channel: "SMS",
    rawToken: raw,
    acceptUrl: buildAcceptUrl(raw),
    expiresAtUtc: invite.expiresAtUtc,
  };
}

export async function createLinkInvite(
  input: {
    teamId: string;
    actorUserId: string;
    role?: string;
    maxUses?: number;
    expiresInMs?: number;
  },
  client: PrismaClient = defaultPrisma,
): Promise<CreatedInvite & { maxUses: number }> {
  const { team } = await requireMemberWithPermission(
    client,
    input.teamId,
    input.actorUserId,
    "team.member.invite",
  );
  const role = validateRole(input.role);
  const plan = await resolveWorkspacePlan(client, team.workspaceId);
  const limits = getCollaborationTeamPlanLimits(plan);
  if (!limits.linkInvitesEnabled)
    throw E.planLimit(`Plan ${plan} does not include invite links.`);

  const requestedUses = Math.max(1, input.maxUses ?? 1);
  const maxUses = Math.min(requestedUses, limits.maxInviteLinkUses);

  await enforceInviteLimits(client, {
    teamId: input.teamId,
    workspaceId: team.workspaceId,
    actorUserId: input.actorUserId,
    channel: "LINK",
  });

  const { raw, hash } = generateInviteToken();
  const expiresAtUtc = new Date(
    Date.now() + (input.expiresInMs ?? DEFAULT_INVITE_TTL_MS),
  );

  const invite = await client.$transaction(async (tx) => {
    const created = await tx.collaborationTeamInvite.create({
      data: {
        teamId: input.teamId,
        workspaceId: team.workspaceId,
        channel: "LINK",
        tokenHash: hash,
        role,
        status: "PENDING",
        expiresAtUtc,
        maxUses,
        createdByUserId: input.actorUserId,
        // Link invites don't have email/phone delivery, mark as DELIVERED
        // immediately so the dashboard shows a clean state.
        deliveryStatus: "DELIVERED",
      },
      select: { id: true, expiresAtUtc: true },
    });
    await recordActivity(tx, {
      teamId: input.teamId,
      workspaceId: team.workspaceId,
      actorUserId: input.actorUserId,
      eventType: "MEMBER_INVITED",
      targetType: "INVITE",
      targetId: created.id,
      metadata: { channel: "LINK", role, maxUses },
    });
    return created;
  });

  return {
    id: invite.id,
    channel: "LINK",
    rawToken: raw,
    acceptUrl: buildAcceptUrl(raw),
    expiresAtUtc: invite.expiresAtUtc,
    maxUses,
  };
}

export async function revokeInvite(
  input: { teamId: string; actorUserId: string; inviteId: string },
  client: PrismaClient = defaultPrisma,
): Promise<void> {
  const { team } = await requireMemberWithPermission(
    client,
    input.teamId,
    input.actorUserId,
    "team.invite.revoke",
  );
  const invite = await client.collaborationTeamInvite.findUnique({
    where: { id: input.inviteId },
    select: { id: true, teamId: true, status: true },
  });
  if (!invite || invite.teamId !== input.teamId) throw E.notFound("Invite");
  if (invite.status !== "PENDING") return;
  await client.$transaction(async (tx) => {
    await tx.collaborationTeamInvite.update({
      where: { id: input.inviteId },
      data: { status: "REVOKED", revokedAtUtc: new Date() },
    });
    await recordActivity(tx, {
      teamId: input.teamId,
      workspaceId: team.workspaceId,
      actorUserId: input.actorUserId,
      eventType: "INVITE_REVOKED",
      targetType: "INVITE",
      targetId: input.inviteId,
    });
  });
}

export async function recordInviteDeliveryResult(
  input: {
    inviteId: string;
    status: "SENT" | "DELIVERED" | "FAILED" | "BOUNCED";
    errorPreview?: string | null;
  },
  client: PrismaClient = defaultPrisma,
): Promise<void> {
  await client.collaborationTeamInvite
    .update({
      where: { id: input.inviteId },
      data: {
        deliveryStatus: input.status,
        deliveryErrorPreview: input.errorPreview
          ? input.errorPreview.slice(0, 280)
          : null,
      },
    })
    .catch(() => undefined);
}

/**
 * Accept an invite. Idempotent on the (token, userId) pair — calling
 * twice with the same accepted invite is a no-op return.
 */
export async function acceptInvite(
  input: { rawToken: string; actorUserId: string },
  client: PrismaClient = defaultPrisma,
): Promise<{ teamId: string; memberId: string }> {
  const hash = hashInviteToken(input.rawToken);
  const invite = await client.collaborationTeamInvite.findUnique({
    where: { tokenHash: hash },
    select: {
      id: true,
      teamId: true,
      workspaceId: true,
      role: true,
      status: true,
      expiresAtUtc: true,
      maxUses: true,
      useCount: true,
      acceptedByUserId: true,
    },
  });
  if (!invite) throw E.notFound("Invite");

  if (invite.status === "REVOKED")
    throw E.invalid("This invite has been revoked.");
  if (invite.expiresAtUtc.getTime() < Date.now()) {
    await client.collaborationTeamInvite.update({
      where: { id: invite.id },
      data: { status: "EXPIRED" },
    });
    throw E.invalid("This invite has expired.");
  }
  if (
    invite.status === "ACCEPTED" &&
    invite.acceptedByUserId === input.actorUserId
  ) {
    const existing = await client.collaborationTeamMember.findFirst({
      where: { teamId: invite.teamId, userId: input.actorUserId },
      select: { id: true },
    });
    if (existing) return { teamId: invite.teamId, memberId: existing.id };
  }
  if (invite.useCount >= invite.maxUses)
    throw E.invalid("This invite has reached its max uses.");

  // Confirm the accepting user is also a member of the parent workspace.
  // If they aren't, we can't add them to a collaboration team because
  // the constitutional rule is: collaboration teams live inside a
  // workspace, and only workspace members may join its teams. The
  // caller should redirect to a workspace-join flow.
  const wsMembership = await client.teamMember.findFirst({
    where: {
      teamId: invite.workspaceId,
      userId: input.actorUserId,
      status: "ACTIVE",
    },
    select: { id: true },
  });
  if (!wsMembership)
    throw E.invalid(
      "Join the parent workspace first; the team invite cannot be accepted standalone.",
    );

  // Plan limit on members.
  const plan = await resolveWorkspacePlan(client, invite.workspaceId);
  const limits = getCollaborationTeamPlanLimits(plan);
  const activeCount = await client.collaborationTeamMember.count({
    where: { teamId: invite.teamId, status: "ACTIVE" },
  });
  if (activeCount >= limits.maxMembersPerTeam)
    throw E.planLimit(
      `This team has reached its member limit (${limits.maxMembersPerTeam}).`,
    );

  const role = validateRole(invite.role);
  const result = await client.$transaction(async (tx) => {
    const existing = await tx.collaborationTeamMember.findUnique({
      where: {
        collaboration_team_member_team_user_uniq: {
          teamId: invite.teamId,
          userId: input.actorUserId,
        },
      },
      select: { id: true, status: true },
    });
    let memberId: string;
    if (existing) {
      if (existing.status !== "ACTIVE") {
        const m = await tx.collaborationTeamMember.update({
          where: { id: existing.id },
          data: {
            status: "ACTIVE",
            role,
            joinedAt: new Date(),
            suspendedAt: null,
            removedAt: null,
            statusReason: null,
          },
        });
        memberId = m.id;
      } else {
        memberId = existing.id;
      }
    } else {
      const m = await tx.collaborationTeamMember.create({
        data: {
          teamId: invite.teamId,
          userId: input.actorUserId,
          role,
          status: "ACTIVE",
        },
        select: { id: true },
      });
      memberId = m.id;
    }
    const nextUseCount = invite.useCount + 1;
    const nextStatus = nextUseCount >= invite.maxUses ? "ACCEPTED" : "PENDING";
    await tx.collaborationTeamInvite.update({
      where: { id: invite.id },
      data: {
        useCount: nextUseCount,
        status: nextStatus,
        acceptedByUserId:
          nextStatus === "ACCEPTED" ? input.actorUserId : invite.acceptedByUserId,
        acceptedAtUtc:
          nextStatus === "ACCEPTED" ? new Date() : null,
      },
    });
    await recordActivity(tx, {
      teamId: invite.teamId,
      workspaceId: invite.workspaceId,
      actorUserId: input.actorUserId,
      eventType: "INVITE_ACCEPTED",
      targetType: "INVITE",
      targetId: invite.id,
      metadata: { role },
    });
    return { teamId: invite.teamId, memberId };
  });

  return result;
}

// -----------------------------------------------------------------------------
// Activity feed
// -----------------------------------------------------------------------------

export async function listTeamActivity(
  input: {
    teamId: string;
    actorUserId: string;
    limit?: number;
    cursor?: string | null;
  },
  client: PrismaClient = defaultPrisma,
) {
  await requireMemberWithPermission(
    client,
    input.teamId,
    input.actorUserId,
    "team.activity.read",
  );
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  const rows = await client.collaborationTeamActivity.findMany({
    where: { teamId: input.teamId },
    orderBy: { createdAt: "desc" },
    take: limit + 1,
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
  });
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  return {
    items: items.map((r) => ({
      id: r.id,
      eventType: r.eventType as CollaborationTeamActivityEventType,
      actorUserId: r.actorUserId,
      targetType: r.targetType,
      targetId: r.targetId,
      metadata: r.metadata,
      createdAt: r.createdAt,
    })),
    nextCursor: hasMore ? items[items.length - 1]!.id : null,
  };
}

// -----------------------------------------------------------------------------
// Assignments
// -----------------------------------------------------------------------------

export async function createAssignment(
  input: {
    teamId: string;
    actorUserId: string;
    targetType: string;
    targetId: string;
    assigneeUserId?: string | null;
    priority?: string;
    dueAtUtc?: Date | null;
    note?: string | null;
  },
  client: PrismaClient = defaultPrisma,
): Promise<{ id: string }> {
  const { team } = await requireMemberWithPermission(
    client,
    input.teamId,
    input.actorUserId,
    "team.assignment.create",
  );
  const targetType = validateAssignmentTarget(input.targetType);
  const priority = validatePriority(input.priority);
  const note = input.note ? input.note.slice(0, 600) : null;

  if (input.assigneeUserId) {
    const assignee = await client.collaborationTeamMember.findFirst({
      where: {
        teamId: input.teamId,
        userId: input.assigneeUserId,
        status: "ACTIVE",
      },
      select: { id: true },
    });
    if (!assignee)
      throw E.invalid("Assignee is not an active member of this team.");
  }

  const result = await client.$transaction(async (tx) => {
    const a = await tx.collaborationTeamAssignment.create({
      data: {
        teamId: input.teamId,
        workspaceId: team.workspaceId,
        assigneeUserId: input.assigneeUserId ?? null,
        assignedByUserId: input.actorUserId,
        targetType,
        targetId: input.targetId,
        status: "OPEN",
        priority,
        dueAtUtc: input.dueAtUtc ?? null,
        note,
      },
      select: { id: true },
    });
    await recordActivity(tx, {
      teamId: input.teamId,
      workspaceId: team.workspaceId,
      actorUserId: input.actorUserId,
      eventType: "ASSIGNMENT_CREATED",
      targetType,
      targetId: input.targetId,
      metadata: {
        assignmentId: a.id,
        priority,
        assigneeUserId: input.assigneeUserId ?? null,
      },
    });
    return a;
  });
  return result;
}

export async function updateAssignment(
  input: {
    teamId: string;
    actorUserId: string;
    assignmentId: string;
    status?: string;
    priority?: string;
    assigneeUserId?: string | null;
    dueAtUtc?: Date | null;
    note?: string | null;
  },
  client: PrismaClient = defaultPrisma,
): Promise<void> {
  const assignment = await client.collaborationTeamAssignment.findUnique({
    where: { id: input.assignmentId },
    select: {
      id: true,
      teamId: true,
      workspaceId: true,
      assigneeUserId: true,
      status: true,
      priority: true,
    },
  });
  if (!assignment || assignment.teamId !== input.teamId)
    throw E.notFound("Assignment");

  // Status change to COMPLETED only requires team.assignment.complete; everything
  // else requires team.assignment.reassign (a superset).
  const isCompleteOnly =
    input.status === "COMPLETED" &&
    input.priority === undefined &&
    input.assigneeUserId === undefined &&
    input.dueAtUtc === undefined &&
    input.note === undefined;
  if (isCompleteOnly) {
    await requireMemberWithPermission(
      client,
      input.teamId,
      input.actorUserId,
      "team.assignment.complete",
    );
  } else {
    await requireMemberWithPermission(
      client,
      input.teamId,
      input.actorUserId,
      "team.assignment.reassign",
    );
  }

  const data: Prisma.CollaborationTeamAssignmentUpdateInput = {};
  const eventEmissions: Array<CollaborationTeamActivityEventType> = [];
  const meta: Record<string, unknown> = { assignmentId: assignment.id };

  if (input.status !== undefined) {
    const status = validateAssignmentStatus(input.status);
    data.status = status;
    if (status === "COMPLETED" && assignment.status !== "COMPLETED") {
      data.completedAtUtc = new Date();
      eventEmissions.push("ASSIGNMENT_COMPLETED");
    } else if (status === "CANCELLED" && assignment.status !== "CANCELLED") {
      eventEmissions.push("ASSIGNMENT_CANCELLED");
    } else if (status === "REASSIGNED" && assignment.status !== "REASSIGNED") {
      eventEmissions.push("ASSIGNMENT_REASSIGNED");
    }
  }
  if (input.priority !== undefined) {
    const priority = validatePriority(input.priority);
    data.priority = priority;
    if (priority !== assignment.priority) {
      eventEmissions.push("ASSIGNMENT_PRIORITY_CHANGED");
      meta.priority = priority;
    }
  }
  if (input.assigneeUserId !== undefined) {
    if (input.assigneeUserId) {
      const assignee = await client.collaborationTeamMember.findFirst({
        where: {
          teamId: input.teamId,
          userId: input.assigneeUserId,
          status: "ACTIVE",
        },
        select: { id: true },
      });
      if (!assignee)
        throw E.invalid("Assignee is not an active member of this team.");
    }
    data.assignee = input.assigneeUserId
      ? { connect: { id: input.assigneeUserId } }
      : { disconnect: true };
    eventEmissions.push("ASSIGNMENT_REASSIGNED");
    meta.assigneeUserId = input.assigneeUserId ?? null;
  }
  if (input.dueAtUtc !== undefined) {
    data.dueAtUtc = input.dueAtUtc;
    eventEmissions.push("ASSIGNMENT_DUE_CHANGED");
    meta.dueAtUtc = input.dueAtUtc ? input.dueAtUtc.toISOString() : null;
  }
  if (input.note !== undefined) {
    data.note = input.note ? input.note.slice(0, 600) : null;
  }
  if (Object.keys(data).length === 0) return;

  await client.$transaction(async (tx) => {
    await tx.collaborationTeamAssignment.update({
      where: { id: input.assignmentId },
      data,
    });
    for (const evt of eventEmissions) {
      await recordActivity(tx, {
        teamId: input.teamId,
        workspaceId: assignment.workspaceId,
        actorUserId: input.actorUserId,
        eventType: evt,
        targetType: "ASSIGNMENT",
        targetId: assignment.id,
        metadata: meta,
      });
    }
  });
}

export async function listAssignments(
  input: { teamId: string; actorUserId: string; status?: string | null },
  client: PrismaClient = defaultPrisma,
) {
  await requireMemberWithPermission(
    client,
    input.teamId,
    input.actorUserId,
    "team.read",
  );
  const rows = await client.collaborationTeamAssignment.findMany({
    where: {
      teamId: input.teamId,
      ...(input.status ? { status: validateAssignmentStatus(input.status) } : {}),
    },
    orderBy: [{ status: "asc" }, { priority: "desc" }, { createdAt: "desc" }],
    take: 200,
  });
  return rows.map((a) => ({
    id: a.id,
    targetType: a.targetType as CollaborationTeamAssignmentTarget,
    targetId: a.targetId,
    assigneeUserId: a.assigneeUserId,
    assignedByUserId: a.assignedByUserId,
    status: a.status as CollaborationTeamAssignmentStatus,
    priority: a.priority as CollaborationTeamAssignmentPriority,
    dueAtUtc: a.dueAtUtc,
    note: a.note,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
    completedAtUtc: a.completedAtUtc,
  }));
}

// =============================================================================
// Internal helpers exposed for tests
// =============================================================================

export const __internal__ = {
  generateInviteToken,
  hashInviteToken,
  base32Encode,
};

function maskEmail(email: string): string {
  const idx = email.indexOf("@");
  if (idx <= 1) return "***";
  const head = email[0];
  const tail = email.slice(idx);
  return `${head}***${tail}`;
}

function maskPhone(phone: string): string {
  if (phone.length <= 4) return "***";
  return `${phone.slice(0, 3)}***${phone.slice(-2)}`;
}
