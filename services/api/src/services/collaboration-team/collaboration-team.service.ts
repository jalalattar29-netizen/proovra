/**
 * PROOVRA Phase 5 — Collaboration Team service.
 *
 * The canonical implementation of the Team Collaboration Platform.
 * All mutations + reads flow through this module. Route handlers
 * are thin wrappers that:
 *
 *   1. Prove the actor may act in the workspace, and that the group belongs
 *      to it, via `collaboration-authorization.ts` (the canonical
 *      `authorizeWorkspaceOrFail` primitive). There is no fallback: a request
 *      that cannot name a workspace it may act in is refused.
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
  absoluteInternalUrl,
  COLLABORATION_TEAM_ASSIGNMENT_PRIORITIES,
  COLLABORATION_TEAM_ASSIGNMENT_STATUSES,
  COLLABORATION_TEAM_ASSIGNMENT_TARGETS,
  COLLABORATION_TEAM_INVITE_TOKEN_PREFIX,
  COLLABORATION_TEAM_INVITE_TOKEN_RANDOM_BYTES,
  COLLABORATION_TEAM_ROLES,
  COLLABORATION_TEAM_TYPES,
  collaborationTeamRoleHasPermission,
  internalNavPath,
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
import {
  assertCanCreateCollaborationTeam,
  assertCanInviteCollaborationTeamMember,
  assertCollaborationTeamMemberLimit,
  lockAndAssertCollaborationTeamCapacity,
} from "./billing-guards.js";

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

/**
 * PHASE 12 POINT 4 STEP 1 — the ONE definition of collaboration-team
 * moderator authority.
 *
 * LEAD and ADMIN are the two roles that may moderate other members' comments,
 * manage guests, and run access reviews. `collaboration-completion.service.ts`
 * imports this for its enforcement gates and
 * `getCollaborationTeamDetail` projects it as `viewerCapabilities`, so the
 * affordance the browser renders and the rule the API enforces cannot drift.
 */
export function isCollaborationTeamModerator(
  role: string | null | undefined,
): boolean {
  return role === "LEAD" || role === "ADMIN";
}

/**
 * THE ONE group-role ceiling.
 *
 * `changeMemberRole` has always enforced "only a LEAD may grant LEAD" — and
 * `createEmailInvite` and `addExistingMember`, which reach the SAME role
 * column by a different door, enforced nothing. A group ADMIN could therefore
 * mint a LEAD by inviting one or by adding an existing workspace member as
 * one, and a LEAD they minted could promote them back. A rule that only one
 * of three writers applies is not a rule.
 *
 * Stated here, once, so every writer asks the same question.
 */
export function assertGroupRoleWithinActorAuthority(
  actorRole: CollaborationTeamRole,
  grantedRole: CollaborationTeamRole,
): void {
  if (grantedRole === "LEAD" && actorRole !== "LEAD") {
    throw new CollaborationTeamError(
      "team_forbidden",
      "Only a team LEAD can grant the LEAD role.",
      403,
    );
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

  // ---------------------------------------------------------------------------
  // Stable invite-accept codes (Teams Entitlement Alignment, 2026-07-14).
  //
  // Every KNOWN accept failure carries a machine code so the accept page
  // can render a specific state instead of parsing message text. The
  // route serialises these as `{ code, error, message, requestId }`.
  // Capacity / plan-restriction failures are NOT here — they propagate
  // from the canonical billing guards as BillingLimitError with
  // TEAM_MEMBER_LIMIT_REACHED / TEAM_INVITES_NOT_INCLUDED (+ details).
  // ---------------------------------------------------------------------------
  inviteNotFound: () =>
    new CollaborationTeamError(
      "INVITE_NOT_FOUND",
      "This invite does not exist. Ask the team to send a new one.",
      404,
    ),
  inviteExpired: () =>
    new CollaborationTeamError(
      "INVITE_EXPIRED",
      "This invite has expired. Ask the team to send a new one.",
      410,
    ),
  inviteRevoked: () =>
    new CollaborationTeamError(
      "INVITE_REVOKED",
      "This invite has been revoked.",
      410,
    ),
  inviteAlreadyUsed: () =>
    new CollaborationTeamError(
      "INVITE_ALREADY_USED",
      "This invite has already been used. Ask the team to send a new one.",
      409,
    ),
  workspaceMembershipRequired: () =>
    new CollaborationTeamError(
      "WORKSPACE_MEMBERSHIP_REQUIRED",
      "Join the parent workspace first; the team invite cannot be accepted standalone.",
      403,
    ),
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
//
// Teams Entitlement Alignment (2026-07-14): the legacy inline checks
// that read `Team.billingPlan` were DELETED. Every capacity / plan gate
// now goes through the canonical entitlement-based billing guards in
// ./billing-guards.ts (assertCanCreateCollaborationTeam /
// assertCollaborationTeamMemberLimit /
// assertCanInviteCollaborationTeamMember) so the service and the route
// layer can never disagree about the commercial contract.

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

  // Plan gate — canonical entitlement-based guard (billing identity is
  // the parent workspace's owner). Throws TEAM_PLAN_REQUIRED (402) on
  // zero-team plans (FREE / PAYG) and TEAM_LIMIT_REACHED (409) at-cap.
  const ws = await client.team.findUnique({
    where: { id: input.workspaceId },
    select: { ownerUserId: true },
  });
  if (!ws) throw E.notFound("Workspace");
  // BILLING COMMERCIAL CORRECTNESS (2026-08-27) — the cap is per WORKSPACE,
  // so the guard takes the workspace, not the owner's account.
  // The cap and the resolved plan come back from the guard so the in-transaction
  // re-check below compares against the SAME numbers, resolved once. Resolving
  // them twice would be two answers to one commercial question.
  const cap = await assertCanCreateCollaborationTeam(
    { workspaceId: input.workspaceId, actorUserId: input.actorUserId },
    client,
  );

  const result = await client.$transaction(async (tx) => {
    // The limit is RE-EVALUATED here, inside the creating transaction and
    // under a per-workspace advisory lock. The guard above is a count followed
    // by an unrelated insert; this is the authority. See
    // `lockAndAssertCollaborationTeamCapacity`.
    await lockAndAssertCollaborationTeamCapacity(tx, {
      workspaceId: input.workspaceId,
      plan: cap.plan,
      maxCollaborationTeamsPerWorkspace: cap.maxCollaborationTeamsPerWorkspace,
    });

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
          members: { where: { status: "ACTIVE" } },
          invites: { where: { status: "PENDING" } },
          assignments: { where: { status: { in: ["OPEN", "IN_PROGRESS"] } } },
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
  /**
   * `workspaceId` is the PROVEN workspace from the route's authorization
   * context, and it is required.
   *
   * This function used to take a team id and an actor and nothing else, so a
   * member of a team could read it while operating in a different workspace —
   * the read was bound to the group, never to the tenant that contains it.
   * Route-level binding now refuses that first; this assertion means the
   * service cannot be reached past it either, and a future caller cannot
   * reintroduce the hole by forgetting.
   */
  input: { teamId: string; workspaceId: string; actorUserId: string },
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
  if (!team || team.workspaceId !== input.workspaceId) throw E.notFound("Team");
  const viewer = team.members.find(
    (m) => m.userId === input.actorUserId && m.status === "ACTIVE",
  );
  if (!viewer) throw E.notFound("Team");
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
    // PHASE 12 POINT 4 STEP 1 — SERVER-projected viewer authority.
    //
    // The web console used to compute `viewerRole === "LEAD" || "ADMIN"` in
    // three places to decide whether to render comment moderation, guest
    // management and access-review controls. Each flag below is computed by
    // the SAME predicate its gate in `collaboration-completion.service.ts`
    // uses — `isCollaborationTeamModerator` for comment moderation
    // (editComment / deleteComment) and access reviews (openAccessReview /
    // decideAccessReviewItem / completeAccessReview), and the shared
    // permission catalog for guests (inviteGuest / revokeGuest). Those gates
    // remain the enforcement point on every direct API call.
    viewerCapabilities: {
      canModerateComments: isCollaborationTeamModerator(viewer.role),
      canManageGuests: collaborationTeamRoleHasPermission(
        viewer.role as CollaborationTeamRole,
        "team.member.invite",
      ),
      canManageAccessReviews: isCollaborationTeamModerator(viewer.role),
    },
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
  const { team, role: actorRole } = await requireMemberWithPermission(
    client,
    input.teamId,
    input.actorUserId,
    "team.member.invite",
  );
  const role = validateRole(input.role);
  assertGroupRoleWithinActorAuthority(actorRole, role);

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

  // Plan gate — canonical entitlement-based member-limit guard. Throws
  // TEAM_INVITES_NOT_INCLUDED (402) when the owner's plan includes zero
  // Teams (grandfathered growth lock) and TEAM_MEMBER_LIMIT_REACHED
  // (409, with details) at seat capacity.
  await assertCollaborationTeamMemberLimit(input.teamId, 1, client);

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
    select: { id: true, userId: true, status: true, role: true, teamId: true },
  });
  if (!member || member.teamId !== input.teamId) throw E.notFound("Member");
  if (member.status !== "ACTIVE") return;
  /**
   * A TEAM MAY NOT BE SUSPENDED OUT OF ITS OWN LEADERSHIP.
   *
   * `removeMember` and `changeMemberRole` both protect the last LEAD; suspend
   * did not, and suspension denies access exactly as removal does. An ADMIN
   * could therefore suspend the only LEAD and leave a team where nobody can
   * grant LEAD — `changeMemberRole` requires a LEAD actor to hand it out, and
   * there is no longer one.
   *
   * The count is taken inside the same transaction as the write below.
   */
  await client.$transaction(async (tx) => {
    if (member.role === "LEAD") {
      const remainingLeads = await tx.collaborationTeamMember.count({
        where: {
          teamId: input.teamId,
          id: { not: member.id },
          role: "LEAD",
          status: "ACTIVE",
        },
      });
      if (remainingLeads === 0) {
        throw E.conflict(
          "Cannot suspend the last LEAD. Transfer leadership first.",
        );
      }
    }
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
  // PHASE 11 — nav path (not a resource-id family), composed via
  // internalNavPath + absoluteInternalUrl.
  const base = process.env.WEB_BASE_URL ?? "https://app.proovra.com";
  return absoluteInternalUrl(
    base,
    internalNavPath(
      `/collaboration-teams/invites/${encodeURIComponent(rawToken)}/accept`,
    ),
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
  const { team, role: actorRole } = await requireMemberWithPermission(
    client,
    input.teamId,
    input.actorUserId,
    "team.member.invite",
  );
  const email = validateEmail(input.email);
  const role = validateRole(input.role);
  assertGroupRoleWithinActorAuthority(actorRole, role);
  // Canonical invite gate (EMAIL is the ONLY invitation channel):
  //   - TEAM_INVITES_NOT_INCLUDED (402) on zero-team plans,
  //   - TEAM_INVITE_LIMIT_REACHED (429) on pending-per-team / 24h caps.
  await assertCanInviteCollaborationTeamMember(input.teamId, "EMAIL", client);

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
 * Accept an invite. Idempotent — if the accepting user is ALREADY an
 * active member of the team (via this invite, another invite, or a
 * direct add), the call succeeds with `{ alreadyMember: true }` so the
 * UI can render "You are already a member" with a team link instead of
 * an error page. This short-circuit runs BEFORE the expiry / revoked /
 * capacity checks: an existing member re-clicking a stale invite link
 * must not see a failure.
 *
 * Stable failure codes (CollaborationTeamError.code):
 *   - INVITE_NOT_FOUND               (404)
 *   - INVITE_REVOKED                 (410)
 *   - INVITE_EXPIRED                 (410)
 *   - INVITE_ALREADY_USED            (409)
 *   - WORKSPACE_MEMBERSHIP_REQUIRED  (403)
 *
 * Capacity / plan-restriction failures propagate from the canonical
 * billing guard as BillingLimitError:
 *   - TEAM_INVITES_NOT_INCLUDED      (402, zero-team owner plan)
 *   - TEAM_MEMBER_LIMIT_REACHED      (409, with details)
 */
export async function acceptInvite(
  input: { rawToken: string; actorUserId: string },
  client: PrismaClient = defaultPrisma,
): Promise<{ teamId: string; workspaceId: string; memberId: string; alreadyMember: boolean }> {
  const hash = hashInviteToken(input.rawToken);
  /**
   * COMPATIBILITY REPAIR — the selector, not the model.
   *
   * `CollaborationTeamInvite` declares `@@unique([tokenHash], name:
   * "collaboration_team_invite_token_hash_uniq")`, and a NAMED single-field
   * unique is a trap in both directions:
   *
   *   - Prisma's RUNTIME validator wants the constraint's NAME, so
   *     `findUnique({ where: { tokenHash } })` threw
   *     `PrismaClientValidationError` on EVERY call and the accept route
   *     returned 500 for every token — valid, expired, revoked and unknown
   *     alike. Nobody could accept an invitation, in any plan, ever.
   *   - The generated TYPE does not carry that name as a property, and its
   *     `AtLeast<O, K>` produces a branch that is plain `O` when `K` is not a
   *     key of `O`, so `{ tokenHash }` type-checked and `{ <the name> }` does
   *     not. tsc could not have caught it and cannot express the fix.
   *
   * `findFirst` sidesteps both: `tokenHash` is an ordinary, fully-typed filter
   * field, the column is unique in the database so exactly one row can match,
   * and no cast is needed to talk past a generated type. Casting here would
   * have silenced the compiler while leaving the runtime call malformed.
   *
   * It went unnoticed because every test that names `acceptInvite` matches the
   * SOURCE TEXT of this file, and the one behavioural invite test runs against
   * a proxy-mocked Prisma that cannot produce a validation error.
   *
   * The model itself is deprecated by Phase 2 — but a deprecated endpoint that
   * 500s is still a live defect for every link already in someone's inbox, so
   * it is repaired before it is retired.
   */
  const invite = await client.collaborationTeamInvite.findFirst({
    where: { tokenHash: hash },
    select: {
      id: true,
      teamId: true,
      workspaceId: true,
      email: true,
      role: true,
      status: true,
      expiresAtUtc: true,
      maxUses: true,
      useCount: true,
      acceptedByUserId: true,
    },
  });
  if (!invite) throw E.inviteNotFound();

  // Already-a-member SUCCESS short-circuit (mandated UX): an active
  // member re-accepting any invite to their team gets a success
  // response with the team link, never an error.
  const activeMembership = await client.collaborationTeamMember.findFirst({
    where: {
      teamId: invite.teamId,
      userId: input.actorUserId,
      status: "ACTIVE",
    },
    select: { id: true },
  });
  if (activeMembership) {
    return {
      teamId: invite.teamId,
      workspaceId: invite.workspaceId,
      memberId: activeMembership.id,
      alreadyMember: true,
    };
  }

  if (invite.status === "REVOKED") throw E.inviteRevoked();
  if (invite.expiresAtUtc.getTime() < Date.now()) {
    await client.collaborationTeamInvite.update({
      where: { id: invite.id },
      data: { status: "EXPIRED" },
    });
    throw E.inviteExpired();
  }
  if (invite.status === "EXPIRED") throw E.inviteExpired();
  // Consumed by someone else (or by this user before their membership
  // was removed) — invites are single-use (maxUses is always written 1).
  if (invite.status === "ACCEPTED" || invite.useCount >= invite.maxUses)
    throw E.inviteAlreadyUsed();

  /**
   * BIND THE INVITE TO THE PERSON IT WAS ADDRESSED TO.
   *
   * The invite carries an email and nothing compared it to the accepting
   * account, so anyone who obtained the link — a forwarded mail, a shared
   * screen, a proxy log — could claim the role it carried. The workspace
   * invite path has always checked this (`teams.routes.ts`); this path never
   * did, and the role it hands out can be LEAD.
   *
   * Normalised on both sides so a case or whitespace difference is not
   * mistaken for a different person.
   */
  if (invite.email) {
    const actor = await client.user.findUnique({
      where: { id: input.actorUserId },
      select: { email: true },
    });
    const actorEmail = (actor?.email ?? "").trim().toLowerCase();
    if (!actorEmail || actorEmail !== invite.email.trim().toLowerCase()) {
      throw new CollaborationTeamError(
        "INVITE_EMAIL_MISMATCH",
        "Sign in with the address this invitation was sent to.",
        403,
      );
    }
  }

  // Confirm the accepting user is also a member of the parent workspace.
  // Constitutional rule: collaboration teams live inside a workspace,
  // and only workspace members may join its teams. The caller should
  // redirect to a workspace-join flow.
  const wsMembership = await client.teamMember.findFirst({
    where: {
      teamId: invite.workspaceId,
      userId: input.actorUserId,
      status: "ACTIVE",
    },
    select: { id: true },
  });
  if (!wsMembership) throw E.workspaceMembershipRequired();

  // Canonical capacity + plan gate (owner entitlement). Runs AFTER the
  // already-member short-circuit so it only fires when the accept would
  // actually add a seat. Propagates TEAM_MEMBER_LIMIT_REACHED /
  // TEAM_INVITES_NOT_INCLUDED with details.
  await assertCollaborationTeamMemberLimit(invite.teamId, 1, client);

  const role = validateRole(invite.role);
  const result = await client.$transaction(async (tx) => {
    /**
     * GUARDED CLAIM FIRST — the write that decides the race.
     *
     * This used to read `invite.useCount` OUTSIDE the transaction and then
     * write `useCount: invite.useCount + 1` with no predicate, so two
     * concurrent accepts of a single-use invite both read 0, both passed the
     * `useCount >= maxUses` check above, and both provisioned a membership.
     * No unique constraint could catch it, because the two memberships are for
     * two different users.
     *
     * `updateMany` with the consumption predicate in its WHERE is one atomic
     * statement against the row's committed state: exactly one caller sees
     * `count === 1` and proceeds; every other sees 0 and is refused. The
     * ORGANIZATION invite path has always done it this way
     * (`teams.routes.ts` invite accept); this brings the collaboration path to
     * the same standard rather than inventing a third.
     */
    const claimed = await tx.collaborationTeamInvite.updateMany({
      where: {
        id: invite.id,
        status: "PENDING",
        useCount: { lt: invite.maxUses },
      },
      data: {
        useCount: { increment: 1 },
        status: "ACCEPTED",
        acceptedByUserId: input.actorUserId,
        acceptedAtUtc: new Date(),
      },
    });
    if (claimed.count === 0) throw E.inviteAlreadyUsed();

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
    // The invite was already consumed by the guarded claim at the top of this
    // transaction. Writing it a second time here is what made the claim
    // non-atomic in the first place.
    await recordActivity(tx, {
      teamId: invite.teamId,
      workspaceId: invite.workspaceId,
      actorUserId: input.actorUserId,
      eventType: "INVITE_ACCEPTED",
      targetType: "INVITE",
      targetId: invite.id,
      metadata: { role },
    });
    return {
      teamId: invite.teamId,
      workspaceId: invite.workspaceId,
      memberId,
      alreadyMember: false,
    };
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
