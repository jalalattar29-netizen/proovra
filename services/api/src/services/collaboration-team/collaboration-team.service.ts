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
  COLLABORATION_TEAM_ASSIGNMENT_PRIORITIES,
  COLLABORATION_TEAM_ASSIGNMENT_STATUSES,
  COLLABORATION_TEAM_ASSIGNMENT_TARGETS,
  COLLABORATION_TEAM_INVITE_TOKEN_PREFIX,
  COLLABORATION_TEAM_INVITE_TOKEN_RANDOM_BYTES,
  COLLABORATION_TEAM_ROLES,
  COLLABORATION_TEAM_TYPES,
  collaborationTeamRoleHasPermission,
  type CollaborationTeamActivityEventType,
  type CollaborationTeamAssignmentPriority,
  type CollaborationTeamAssignmentStatus,
  type CollaborationTeamAssignmentTarget,
  type CollaborationTeamInviteChannel,
  type CollaborationTeamPermission,
  type CollaborationTeamRole,
  type CollaborationTeamType,
} from "@proovra/shared";

import {
  workspaceCaseWhere,
  workspaceEvidenceWhere,
} from "@proovra/shared-runtime";

import { prisma as defaultPrisma } from "../../db.js";
import { effectiveGroupMemberWhere } from "./effective-membership.js";
/**
 * THE reviewer-workload authority, reused rather than reimplemented.
 *
 * `ReviewerWorkloadSnapshot` is written by `snapshotWorkspaceWorkload` on the
 * reviewer-ops reconcile pass and read by `/v1/reviewer-ops/workload`. The
 * group overview below projects the SAME rows for the group's own people; it
 * does not compute review load itself, does not write a snapshot, and does not
 * keep a mirror of one.
 */
import { listLatestWorkloadSnapshots } from "../reviewer-ops/workload.service.js";
// THE notification fan-out. A leaf module precisely so the assignment writers
// below can reach it: `collaboration-completion.service.ts`, where it used to
// live, imports FROM this file. Writing rows the canonical account inbox
// already reads — not a second notification store.
import { emitTeamNotifications } from "./team-notifications.js";
import {
  assertCanCreateCollaborationTeam,
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

/** How many members the detail payload previews before the paginated list. */
const DETAIL_MEMBER_PREVIEW = 25;

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

/**
 * READ permissions — the only ones a workspace governor may exercise on a
 * group they are not a member of.
 *
 * Kept as an explicit allow-list rather than a "does the name start with read"
 * heuristic: adding a permission to this set has to be a decision somebody
 * makes on purpose, because everything in it is reachable without group
 * membership.
 */
const GOVERNOR_READABLE_PERMISSIONS: ReadonlySet<CollaborationTeamPermission> =
  new Set<CollaborationTeamPermission>(["team.read", "team.activity.read"]);

async function requireMemberWithPermission(
  client: PrismaClient,
  teamId: string,
  actorUserId: string,
  permission: CollaborationTeamPermission,
  /**
   * The caller has already been proven a WORKSPACE GOVERNOR by
   * `authorizeCollaborationTeam` (`viaWorkspaceGovernance`). It is passed down
   * rather than re-derived so there is exactly one place that decides who
   * qualifies — the route binding — and this function cannot disagree with it.
   *
   * It NEVER confers a group role. A governor gets a bounded read and nothing
   * else: any permission outside `GOVERNOR_READABLE_PERMISSIONS` refuses here
   * exactly as it did before, so every mutation path is untouched.
   */
  viaWorkspaceGovernance = false,
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
  if (!member) {
    if (
      viaWorkspaceGovernance &&
      GOVERNOR_READABLE_PERMISSIONS.has(permission)
    ) {
      // VIEWER is the least-privileged role in the vocabulary and carries
      // exactly `team.read` + `team.activity.read`. Returning it keeps every
      // downstream `collaborationTeamRoleHasPermission` check meaningful
      // rather than introducing a null role every caller would have to handle
      // — and it cannot over-grant, because VIEWER can do nothing else.
      return { role: "VIEWER", team };
    }
    throw E.forbidden(permission);
  }
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

export type CollaborationTeamSummaryRow = {
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
  /**
   * The two numbers that tell a supervisor which group needs them. Both were
   * already computed and returned; neither was DECLARED, so every consumer of
   * this type was typed as though the list could not say how a group was
   * doing. Declaring them is not a new read — it is the contract catching up
   * with the query.
   *
   * Scope note: these describe the ROWS ON THIS PAGE. The workspace-wide
   * answer is `rollup` on the list response, which is computed from the
   * workspace and not from the page.
   */
  overdueAssignmentCount: number;
  highPriorityAssignmentCount: number;
  lastActivityAt: Date | null;
  viewerRole: CollaborationTeamRole | null;
};

/**
 * ===========================================================================
 * CROSS-GROUP ROLLUP — the workspace's operational position, not the page's.
 * ===========================================================================
 * An Enterprise operator supervising twenty groups needs to know how much work
 * the WORKSPACE is carrying, how much of it nobody owns, and how much of it is
 * in trouble. Every number here is computed from `workspaceId` on
 * `CollaborationTeamAssignment` — the column the model already indexes as
 * `[workspaceId, status]` — so the answer is identical whether the caller
 * asked for ten rows or a hundred, and does not change as they page.
 *
 * This is a projection over the ONE responsibility authority. It is not a
 * second attention engine and it stores nothing: there is no snapshot table
 * behind it, and the numbers are as fresh as the query.
 */
export type CollaborationWorkspaceRollup = {
  groups: {
    /** ACTIVE groups in the workspace. */
    active: number;
    /** Of those, how many are actually carrying open work. */
    withOpenWork: number;
  };
  work: {
    /** OPEN + IN_PROGRESS across every group. */
    open: number;
    /** Open work with no individual assignee — the group holds it, nobody does. */
    unassigned: number;
    overdue: number;
    highPriority: number;
    /**
     * Open work that is overdue OR high/urgent, counted as DISTINCT rows.
     *
     * Deliberately not `overdue + highPriority`: an urgent item that is also
     * late is one problem, and adding the two columns would report it twice
     * and inflate the only number a supervisor triages on.
     */
    attention: number;
    /** Open work falling due inside the same 72h horizon the group overview uses. */
    dueSoon: number;
  };
  workload: {
    /** Distinct people holding open work anywhere in the workspace. */
    people: number;
    /** The heaviest single load, or null when nothing is assigned to anyone. */
    busiest: { userId: string; open: number; overdue: number } | null;
  };
};

/**
 * The workspace-wide cross-group position.
 *
 * AUTHORIZATION IS THE CALLER'S. This function answers a question about the
 * WHOLE workspace, so it must only ever be reached by an actor who has proven
 * workspace governance — `listCollaborationTeams` calls it only under the
 * granted `ALL` scope, which the route grants only to `canGovernWorkspace`.
 * It takes no `actorUserId` precisely so it cannot be mistaken for a
 * participation-scoped read that filters itself.
 */
async function computeWorkspaceRollup(
  workspaceId: string,
  activeGroupCount: number,
  now: Date,
  client: PrismaClient,
): Promise<CollaborationWorkspaceRollup> {
  const openWork = {
    workspaceId,
    status: { in: [...OPEN_ASSIGNMENT_STATUSES] },
  } satisfies Prisma.CollaborationTeamAssignmentWhereInput;
  const overdueWhere = { dueAtUtc: { lt: now } };
  const urgentWhere = { priority: { in: ["HIGH", "URGENT"] } };

  const [
    open,
    unassigned,
    overdue,
    highPriority,
    attention,
    dueSoon,
    groupsWithWork,
    byAssignee,
    overdueByAssignee,
  ] = await Promise.all([
    client.collaborationTeamAssignment.count({ where: openWork }),
    client.collaborationTeamAssignment.count({
      where: { ...openWork, assigneeUserId: null },
    }),
    client.collaborationTeamAssignment.count({
      where: { ...openWork, ...overdueWhere },
    }),
    client.collaborationTeamAssignment.count({
      where: { ...openWork, ...urgentWhere },
    }),
    // DISTINCT rows in trouble — the OR is what stops an urgent-and-late item
    // being counted twice.
    client.collaborationTeamAssignment.count({
      where: { ...openWork, OR: [overdueWhere, urgentWhere] },
    }),
    client.collaborationTeamAssignment.count({
      where: {
        ...openWork,
        dueAtUtc: {
          gte: now,
          lt: new Date(now.getTime() + DUE_SOON_WINDOW_MS),
        },
      },
    }),
    // Bounded by the workspace's group cap, which the entitlement enforces.
    client.collaborationTeamAssignment.groupBy({
      by: ["teamId"],
      where: openWork,
      _count: { _all: true },
    }),
    // Bounded by workspace headcount, which the seat limit enforces.
    client.collaborationTeamAssignment.groupBy({
      by: ["assigneeUserId"],
      where: { ...openWork, assigneeUserId: { not: null } },
      _count: { _all: true },
    }),
    client.collaborationTeamAssignment.groupBy({
      by: ["assigneeUserId"],
      where: { ...openWork, assigneeUserId: { not: null }, ...overdueWhere },
      _count: { _all: true },
    }),
  ]);

  const overdueByUser = new Map<string, number>();
  for (const row of overdueByAssignee) {
    if (row.assigneeUserId) overdueByUser.set(row.assigneeUserId, row._count._all);
  }
  const loads = byAssignee
    .filter((r): r is typeof r & { assigneeUserId: string } =>
      Boolean(r.assigneeUserId),
    )
    .map((r) => ({
      userId: r.assigneeUserId,
      open: r._count._all,
      overdue: overdueByUser.get(r.assigneeUserId) ?? 0,
    }))
    // Ties broken by id so the "busiest" name is stable between two reads
    // that see the same numbers.
    .sort((a, b) => b.open - a.open || a.userId.localeCompare(b.userId));

  return {
    groups: { active: activeGroupCount, withOpenWork: groupsWithWork.length },
    work: { open, unassigned, overdue, highPriority, attention, dueSoon },
    workload: { people: loads.length, busiest: loads[0] ?? null },
  };
}

/**
 * One page of the groups this actor belongs to in this workspace.
 *
 * SEARCH AND SORT MOVED TO THE DATABASE. The list page filtered and sorted an
 * already-fetched array, and the array was whatever fitted under a hard
 * `take: 100` — so on a workspace with more groups than that, searching could
 * not find one that existed and the truncation was silent.
 *
 * Ordering is `(updatedAt desc, id desc)` and the cursor is the id, so a page
 * boundary is stable even when two groups share a timestamp.
 */
export async function listCollaborationTeams(
  input: {
    workspaceId: string;
    actorUserId: string;
    includeArchived?: boolean;
    search?: string | null;
    limit?: number;
    cursor?: string | null;
    /**
     * WCR-6A — PARTICIPATION or GOVERNANCE.
     *
     * `PARTICIPATING` (the default) answers "which groups am I in?" and is the
     * right view for everyone doing the work. `ALL` answers "what groups exist
     * in this workspace?" and is an ADMINISTRATIVE question — the caller must
     * have proven `identity.member.role.change` before asking it, which is
     * OWNER/ADMIN only.
     *
     * The two are separate parameters rather than one widened query because
     * the alternative on offer was to make every OWNER a member of every
     * group, and group membership carries Discussion and Assignment
     * participation with it. Seeing a group is not being in it.
     */
    scope?: "PARTICIPATING" | "ALL";
  },
  client: PrismaClient = defaultPrisma,
): Promise<{
  teams: CollaborationTeamSummaryRow[];
  nextCursor: string | null;
  /**
   * ACTIVE groups matching the requested SCOPE — the viewer's memberships
   * under PARTICIPATING, the whole workspace under ALL.
   *
   * NOT a capacity number. Capacity is `collaborationTeams.used` on the
   * entitlement projection, which is always workspace-wide. This counted the
   * viewer's memberships and was read as capacity, so a member of one of a
   * workspace's two groups saw "1 of 2" and an enabled Create button.
   */
  totalActive: number;
  /** ACTIVE groups in the WORKSPACE, whoever is in them. Always authoritative. */
  workspaceTotalActive: number;
  scope: "PARTICIPATING" | "ALL";
  /**
   * The workspace-wide cross-group position, or `null` when the caller is not
   * a workspace governor.
   *
   * It is gated on the GRANTED scope rather than the requested one. A
   * participation-scoped caller sees the groups they are in; telling them how
   * much work exists across groups they cannot see would leak the shape of the
   * workspace to somebody the route already decided may not survey it.
   */
  rollup: CollaborationWorkspaceRollup | null;
}> {
  const take = boundedPage(input.limit);
  const search = (input.search ?? "").trim();
  const scope = input.scope === "ALL" ? "ALL" : "PARTICIPATING";
  const participationFilter =
    scope === "ALL"
      ? {}
      : // Membership across all statuses, so a removed member can still see
        // history if a surface chooses to show it; `viewerRole` below is null
        // unless the membership is ACTIVE.
        { members: { some: { userId: input.actorUserId } } };
  const where = {
    workspaceId: input.workspaceId,
    ...(input.includeArchived ? {} : { status: "ACTIVE" }),
    ...participationFilter,
    ...(search
      ? {
          OR: [
            { name: { contains: search, mode: "insensitive" as const } },
            { description: { contains: search, mode: "insensitive" as const } },
          ],
        }
      : {}),
  } satisfies Prisma.CollaborationTeamWhereInput;

  const [totalActive, workspaceTotalActive] = await Promise.all([
    client.collaborationTeam.count({
      where: {
        workspaceId: input.workspaceId,
        status: "ACTIVE",
        ...participationFilter,
      },
    }),
    client.collaborationTeam.count({
      where: { workspaceId: input.workspaceId, status: "ACTIVE" },
    }),
  ]);

  const teams = await client.collaborationTeam.findMany({
    where,
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    take: take + 1,
    include: {
      _count: {
        select: {
          // WCR-11 — effective members only (see `effectiveGroupMemberWhere`).
          members: { where: effectiveGroupMemberWhere(input.workspaceId) },
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
  const page = teams.slice(0, take);

  /**
   * CROSS-GROUP OPERATIONAL COMPARISON — two grouped queries for the page.
   *
   * The list could say how many groups a workspace had and nothing about how
   * any of them were doing, so an Enterprise operator supervising twenty
   * groups had to open each one to find the one that was drowning. "How is
   * operational responsibility distributed across units?" is the governance
   * question, and it is exactly the question Home does not answer.
   *
   * `groupBy` over the page's ids — NOT one query per row, and NOT a count of
   * anything unbounded. Two queries regardless of page size, and they cost the
   * same whether a group holds ten items or ten thousand.
   */
  const now = new Date();
  const pageIds = page.map((t) => t.id);
  const [overdueRows, urgentRows] = pageIds.length
    ? await Promise.all([
        client.collaborationTeamAssignment.groupBy({
          by: ["teamId"],
          where: {
            teamId: { in: pageIds },
            status: { in: [...OPEN_ASSIGNMENT_STATUSES] },
            dueAtUtc: { lt: now },
          },
          _count: { _all: true },
        }),
        client.collaborationTeamAssignment.groupBy({
          by: ["teamId"],
          where: {
            teamId: { in: pageIds },
            status: { in: [...OPEN_ASSIGNMENT_STATUSES] },
            priority: { in: ["HIGH", "URGENT"] },
          },
          _count: { _all: true },
        }),
      ])
    : [[], []];
  const overdueByTeam = new Map(
    overdueRows.map((r) => [r.teamId, r._count._all]),
  );
  const urgentByTeam = new Map(urgentRows.map((r) => [r.teamId, r._count._all]));

  // Workspace-wide, and only for a caller the route granted the ALL scope to.
  // Computed from `workspaceId`, never from `pageIds` — the whole point is
  // that it does not move when the operator pages or narrows their search.
  const rollup =
    scope === "ALL"
      ? await computeWorkspaceRollup(
          input.workspaceId,
          workspaceTotalActive,
          now,
          client,
        )
      : null;

  return {
    nextCursor: teams.length > take ? page[page.length - 1]?.id ?? null : null,
    totalActive,
    workspaceTotalActive,
    scope,
    rollup,
    teams: page.map((t) => ({
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
    // The two numbers that tell a supervisor which group needs them.
    overdueAssignmentCount: overdueByTeam.get(t.id) ?? 0,
    highPriorityAssignmentCount: urgentByTeam.get(t.id) ?? 0,
    lastActivityAt: t.activity[0]?.createdAt ?? null,
    viewerRole:
      t.members[0] && t.members[0].status === "ACTIVE"
        ? (t.members[0].role as CollaborationTeamRole)
        : null,
    })),
  };
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
  input: {
    teamId: string;
    workspaceId: string;
    actorUserId: string;
    /** Proven by the route binding — a bounded READ for a workspace governor. */
    viaWorkspaceGovernance?: boolean;
  },
  client: PrismaClient = defaultPrisma,
) {
  /**
   * THE MEMBER ARRAY IS A FIRST PAGE, NOT THE POPULATION.
   *
   * This used to `include` every member with no `take` — 1,001 rows and
   * 386 KB against a real database, every address in the payload, rendered as
   * a thousand table rows with a thousand role dropdowns and no search anywhere
   * to escape it. The full membership now has its own paginated, searchable
   * endpoint (`GET .../members`); what the detail carries is the first page
   * plus the counts a header needs.
   */
  const team = await client.collaborationTeam.findUnique({
    where: { id: input.teamId },
    include: {
      members: {
        // WCR-11 — the preview shows EFFECTIVE members, so the first page and
        // the count beside it are counting the same population.
        where: effectiveGroupMemberWhere(input.workspaceId),
        orderBy: { joinedAt: "asc" },
        take: DETAIL_MEMBER_PREVIEW,
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
  // The viewer's own membership is proven independently of the page above: on a
  // large team the first page will not contain them.
  const viewerRow = await client.collaborationTeamMember.findFirst({
    where: { teamId: input.teamId, userId: input.actorUserId, status: "ACTIVE" },
    select: { role: true },
  });
  /**
   * A WORKSPACE GOVERNOR IS NOT A MEMBER, AND MUST NOT BE PROJECTED AS ONE.
   *
   * They reach this read through the third authorization state, proven at the
   * route (`viaWorkspaceGovernance`). They get VIEWER — the least-privileged
   * role in the vocabulary, carrying only `team.read` and
   * `team.activity.read` — so every `viewerRole`-driven affordance in the
   * client resolves to "can look, can do nothing", which is exactly true.
   *
   * They are NOT written into `collaboration_team_members`. Auto-joining every
   * owner to every group would grant Discussion participation and assignment
   * authority as a side effect of administration, which is the reason this gap
   * existed rather than an oversight.
   */
  if (!viewerRow && !input.viaWorkspaceGovernance) throw E.notFound("Team");
  const viewer = { role: viewerRow?.role ?? "VIEWER" };
  const [activeMemberCount, pendingInviteCount] = await Promise.all([
    client.collaborationTeamMember.count({
      // WCR-11 — effective members only.
      where: { teamId: input.teamId, ...effectiveGroupMemberWhere(input.workspaceId) },
    }),
    client.collaborationTeamInvite.count({
      where: { teamId: input.teamId, status: "PENDING" },
    }),
  ]);
  /**
   * An address is administrative data. A VIEWER reads the team; an EXTERNAL
   * collaborator holds `team.read` and is not even staff. Neither is a member
   * manager, and neither used to be stopped from receiving every teammate's
   * address in this payload.
   */
  const viewerCanSeeContact = collaborationTeamRoleHasPermission(
    viewer.role as CollaborationTeamRole,
    "team.member.invite",
  );
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
    activeMemberCount,
    pendingInviteCount,
    memberPreviewLimit: DETAIL_MEMBER_PREVIEW,
    members: team.members.map((m) => ({
      id: m.id,
      userId: m.userId,
      role: m.role as CollaborationTeamRole,
      status: m.status,
      joinedAt: m.joinedAt,
      suspendedAt: m.suspendedAt,
      removedAt: m.removedAt,
      user: {
        id: m.user.id,
        email: viewerCanSeeContact ? m.user.email : null,
        displayName: safeDisplayName(m.user),
        firstName: m.user.firstName,
        lastName: m.user.lastName,
        avatarUrl: m.user.avatarUrl,
      },
    })),
    invites: team.invites.map((inv) => ({
      id: inv.id,
      channel: inv.channel as CollaborationTeamInviteChannel,
      email: viewerCanSeeContact ? inv.email : maskEmail(inv.email ?? ""),
      // WCR-17 — the address was masked for a non-manager and the phone number
      // beside it was not, which makes the masking decorative: the same person
      // is identified either way. The population is finite and shrinking (no
      // SMS invitation can be created any more) but the historical rows are
      // still read by every VIEWER and EXTERNAL member of the group.
      phone: viewerCanSeeContact ? inv.phone : maskPhone(inv.phone),
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

/**
 * WCR-13 (2026-09-07) — REOPEN A GROUP.
 *
 * Archiving was one-way. There was no service function, no route and no client
 * call to undo it, and every mutation route passes `requireActiveTeam: true`,
 * so an archived group was frozen for ever — while the confirmation dialog told
 * the operator members would lose access *"until the team is unarchived"*.
 *
 * Two ways to close that: delete the promise, or keep it. Keeping it is the
 * right call on an evidence platform. Archiving is the ONLY way a workspace at
 * its group ceiling can free a slot, so making it irreversible turns a routine
 * tidy-up into a permanent loss of a group's assignments, discussion and
 * activity — and an operator who archived the wrong group had no recourse.
 *
 * REOPENING RE-CHECKS CAPACITY, and that is the whole subtlety. Archived groups
 * do not count against `maxCollaborationTeamsPerWorkspace` (correctly — the cap
 * is on ACTIVE groups). So a PRO workspace can archive one of its two groups,
 * create a third, and then try to reopen the first. Without a check that is a
 * way to hold three active groups on a plan that sells two. The guard runs
 * inside the same transaction and under the same per-workspace advisory lock as
 * creation, because reopening and creating compete for exactly the same slot.
 */
export async function unarchiveCollaborationTeam(
  input: { teamId: string; actorUserId: string },
  client: PrismaClient = defaultPrisma,
): Promise<void> {
  const { team } = await requireMemberWithPermission(
    client,
    input.teamId,
    input.actorUserId,
    // Reopening is the inverse of archiving and carries the same authority.
    "team.archive",
  );
  if (team.status === "ACTIVE") return;

  // Resolved OUTSIDE the transaction, once, so the in-transaction re-check
  // compares against the same numbers rather than resolving a second answer.
  const cap = await assertCanCreateCollaborationTeam(
    { workspaceId: team.workspaceId, actorUserId: input.actorUserId },
    client,
  );

  await client.$transaction(async (tx) => {
    await lockAndAssertCollaborationTeamCapacity(tx, {
      workspaceId: team.workspaceId,
      plan: cap.plan,
      maxCollaborationTeamsPerWorkspace: cap.maxCollaborationTeamsPerWorkspace,
    });
    await tx.collaborationTeam.update({
      where: { id: input.teamId },
      data: { status: "ACTIVE", archivedAtUtc: null },
    });
    await recordActivity(tx, {
      teamId: input.teamId,
      workspaceId: team.workspaceId,
      actorUserId: input.actorUserId,
      // `TEAM_REOPENED` already existed in the event vocabulary with no
      // producer — the feed was ready for this operation before the operation
      // was. Reusing it rather than minting a second name for one fact.
      eventType: "TEAM_REOPENED",
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

/**
 * WCR-15 (2026-09-07) — THE WAY BACK FROM SUSPENDED.
 *
 * `suspendMember` existed and nothing undid it. The route's schema accepted
 * `status: "ACTIVE"`, no branch handled it, and the response was `{ ok: true }`
 * — so the product could suspend a group member permanently and report the
 * reinstatement as successful.
 *
 * Reinstating is a MEMBERSHIP-STATUS change and carries the same authority as
 * suspending (`team.member.suspend`), not the role-change authority: putting
 * someone back is not a promotion, and requiring LEAD for it would leave an
 * ADMIN able to suspend people they cannot restore.
 *
 * REMOVED is deliberately NOT reinstatable here. A removal is a decision to end
 * the assignment, and the way back is to add the person again through
 * `addExistingMember` — which re-checks that they are still an ACTIVE member of
 * the workspace. Quietly flipping a REMOVED row to ACTIVE would skip that
 * check and could re-admit somebody who has since left the workspace entirely.
 */
export async function reinstateMember(
  input: { teamId: string; actorUserId: string; memberId: string },
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
  if (member.status === "ACTIVE") return;
  if (member.status === "REMOVED") {
    throw E.conflict(
      "This person was removed from the team. Add them again from the workspace directory.",
    );
  }

  // The workspace membership must still be live. A group row can outlive the
  // access behind it (see `effectiveGroupMemberWhere`), so un-suspending
  // without this check would restore a group seat to somebody who can no
  // longer enter the workspace at all.
  const workspaceMembership = await client.teamMember.findFirst({
    where: { teamId: team.workspaceId, userId: member.userId, status: "ACTIVE" },
    select: { id: true },
  });
  if (!workspaceMembership) {
    throw E.invalid(
      "This person is no longer an active member of the parent workspace.",
    );
  }

  await client.$transaction(async (tx) => {
    await tx.collaborationTeamMember.update({
      where: { id: input.memberId },
      data: { status: "ACTIVE", suspendedAt: null, statusReason: null },
    });
    await recordActivity(tx, {
      teamId: input.teamId,
      workspaceId: team.workspaceId,
      actorUserId: input.actorUserId,
      eventType: "MEMBER_REINSTATED",
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

// =============================================================================
// (RETIRED) createEmailInvite — the per-group invitation writer
// =============================================================================
//
// WORKSPACE AND COLLABORATION ARCHITECTURE CLOSURE (2026-09-06) — DELETED, so
// that a new `CollaborationTeamInvite` row is not merely unreached but
// unwritable.
//
// There is ONE invitation authority, and it invites into the WORKSPACE, where
// acceptance atomically claims a seat. A group is filled by ASSIGNING someone
// who already holds one (`addExistingMember`), which is why a second
// invitation system with its own token, its own expiry, its own capacity rules
// and its own accept path could only ever disagree with the entitlement that
// is actually sold.
//
// Its route was retired to a typed 410 in the reconciliation and this function
// then had no caller. Retiring a route stops the traffic; deleting the writer
// stops the possibility, which is the difference between a surface being off
// and an authority being gone.
//
// WHAT DELIBERATELY REMAINS, AND FOR HOW LONG:
//   * `acceptInvite` and `revokeInvite` — links that were already sent are in
//     people's mailboxes. Completing or withdrawing an obligation that was
//     validly issued is not a new write, and both paths are bounded by rows
//     that no longer come into existence, so the set they act on only shrinks.
//   * The `collaboration_team_invites` table and its history. No migration
//     drops it: the record that an invitation was sent is a fact about the
//     workspace, and this closure does not delete history.
//
// Both go when no PENDING legacy invitation remains and no accept link can
// still be in flight — one TTL after the last one was issued.

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

  /**
   * WCR-23 (2026-09-07) — A LEGACY ROW MAY NOT MINT AUTHORITY.
   *
   * The stored `role` was written straight onto the new membership. That was
   * safe once `assertGroupRoleWithinActorAuthority` guarded every writer — but
   * the writer this table's rows came from, `createEmailInvite`, was DELETED
   * *after* those rows existed and it enforced no ceiling. Any PENDING
   * invitation minted by a group ADMIN before the ceiling landed still carries
   * whatever role it was given, including LEAD, and this path would grant it.
   *
   * A compatibility path exists to honour obligations that were validly
   * issued. An escalation was not validly issued. LEAD is clamped to the
   * default rather than refused outright, because refusing would strand a
   * person who was legitimately invited to a group and merely handed the wrong
   * role by a bug — they join, and a real LEAD can promote them deliberately.
   *
   * The population is finite and shrinks to nothing: no writer can create
   * another of these rows.
   */
  const invitedRole = validateRole(invite.role);
  const role: CollaborationTeamRole =
    invitedRole === "LEAD" ? "MEMBER" : invitedRole;
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

// -----------------------------------------------------------------------------
// Assignment target validation
// -----------------------------------------------------------------------------

/**
 * Prove that a Case / Evidence / Review record exists inside THIS workspace.
 *
 * A Collaboration Team references its workspace's records; it never owns them
 * and never reaches outside. The scope predicates are the canonical ones from
 * `@proovra/shared-runtime`, so this agrees with every other read of the same
 * population — including the personal-workspace rule for legacy rows whose
 * `team_id` is NULL.
 *
 * The refusal is deliberately the same shape for "does not exist" and "belongs
 * to another workspace": the caller must not learn which.
 */
/**
 * Is this record in this workspace? ONE predicate, two callers.
 *
 * The write path asserts it (below) and the reverse projection asks it as a
 * question. Both must mean the same thing by "in this workspace" — including a
 * PERSONAL workspace's legacy `team_id IS NULL` rows, which only these
 * canonical scope predicates know how to identify — so there is one
 * implementation and the assert is a thin wrapper over it.
 */
export async function assignmentTargetExistsInWorkspace(
  client: PrismaClient,
  workspaceId: string,
  targetType: CollaborationTeamAssignmentTarget,
  targetId: string,
): Promise<boolean> {
  if (targetType === "CASE") {
    const found = await client.case.findFirst({
      where: { AND: [await workspaceCaseWhere(workspaceId, client), { id: targetId }] },
      select: { id: true },
    });
    return Boolean(found);
  }
  if (targetType === "EVIDENCE") {
    const found = await client.evidence.findFirst({
      where: {
        AND: [await workspaceEvidenceWhere(workspaceId, client), { id: targetId }],
      },
      select: { id: true },
    });
    return Boolean(found);
  }
  // REVIEW — a review workflow belongs to the workspace THROUGH its evidence.
  // Scoping it by its own nullable `team_id` would reproduce the original
  // defect on a second table; scoping through the relation cannot.
  const found = await client.evidenceReviewWorkflow.findFirst({
    where: {
      id: targetId,
      evidence: await workspaceEvidenceWhere(workspaceId, client),
    },
    select: { id: true },
  });
  return Boolean(found);
}

async function assertAssignmentTargetInWorkspace(
  client: PrismaClient,
  workspaceId: string,
  targetType: CollaborationTeamAssignmentTarget,
  targetId: string,
): Promise<void> {
  const ok = await assignmentTargetExistsInWorkspace(
    client,
    workspaceId,
    targetType,
    targetId,
  );
  if (ok) return;
  if (targetType === "CASE") throw E.notFound("Case");
  if (targetType === "EVIDENCE") throw E.notFound("Evidence record");
  throw E.notFound("Review");
}

/**
 * The records in this workspace that a group may be assigned.
 *
 * The console used to ask the operator to PASTE A UUID — "copy it from the
 * case detail page" — and then rendered what came back as `targetId.slice(0,8)…`
 * with no link. That is not a workflow anyone can perform twice; it is a text
 * box that happens to accept an identifier.
 *
 * Same scope predicates as the validation on the write path, so the picker can
 * only ever offer something the write will accept.
 */
export async function listAssignableTargets(
  input: {
    workspaceId: string;
    targetType: CollaborationTeamAssignmentTarget;
    search?: string | null;
    limit?: number;
  },
  client: PrismaClient = defaultPrisma,
): Promise<{
  targets: Array<{ id: string; label: string; sublabel: string | null; status: string }>;
}> {
  const take = boundedPage(input.limit);
  const search = (input.search ?? "").trim();

  if (input.targetType === "CASE") {
    const rows = await client.case.findMany({
      where: {
        AND: [
          await workspaceCaseWhere(input.workspaceId, client),
          ...(search
            ? [
                {
                  OR: [
                    { name: { contains: search, mode: "insensitive" as const } },
                    {
                      referenceNumber: {
                        contains: search,
                        mode: "insensitive" as const,
                      },
                    },
                  ],
                },
              ]
            : []),
        ],
      },
      orderBy: { updatedAt: "desc" },
      take,
      select: { id: true, name: true, referenceNumber: true, status: true },
    });
    return {
      targets: rows.map((r) => ({
        id: r.id,
        label: r.name,
        sublabel: r.referenceNumber,
        status: String(r.status),
      })),
    };
  }

  if (input.targetType === "EVIDENCE") {
    const rows = await client.evidence.findMany({
      where: {
        AND: [
          await workspaceEvidenceWhere(input.workspaceId, client),
          { lifecycleState: { not: "DESTROYED" } },
          ...(search
            ? [{ title: { contains: search, mode: "insensitive" as const } }]
            : []),
        ],
      },
      orderBy: { createdAt: "desc" },
      take,
      select: { id: true, title: true, status: true },
    });
    return {
      targets: rows.map((r) => ({
        id: r.id,
        label: r.title ?? "Untitled evidence record",
        sublabel: null,
        status: String(r.status),
      })),
    };
  }

  const rows = await client.evidenceReviewWorkflow.findMany({
    where: { evidence: await workspaceEvidenceWhere(input.workspaceId, client) },
    orderBy: { createdAt: "desc" },
    take,
    select: {
      id: true,
      status: true,
      evidence: { select: { title: true } },
    },
  });
  return {
    targets: rows.map((r) => ({
      id: r.id,
      label: r.evidence?.title
        ? `Review — ${r.evidence.title}`
        : "Review",
      sublabel: null,
      status: String(r.status),
    })),
  };
}

// -----------------------------------------------------------------------------
// Membership directories — the two bounded reads that replace the unbounded one
// -----------------------------------------------------------------------------

const MEMBER_PAGE_DEFAULT = 25;
const MEMBER_PAGE_MAX = 100;

function boundedPage(limit: number | undefined): number {
  if (!Number.isFinite(limit ?? NaN)) return MEMBER_PAGE_DEFAULT;
  return Math.min(Math.max(Math.trunc(limit as number), 1), MEMBER_PAGE_MAX);
}

/** Display name that never falls back to an address. */
function safeDisplayName(user: {
  displayName: string | null;
  firstName: string | null;
  lastName: string | null;
}): string {
  const full = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
  return user.displayName?.trim() || full || "Workspace member";
}

/**
 * ACTIVE workspace members who are not yet in this team.
 *
 * This is what a team is built from. The old flow asked for an email address
 * and sent an invitation the recipient could only accept if they were already
 * in the workspace — so the address was never the thing that granted access,
 * and asking for it only invited the operator to type one that could not work.
 */
export async function listEligibleWorkspaceMembersForTeam(
  input: {
    workspaceId: string;
    teamId: string;
    search?: string | null;
    limit?: number;
    cursor?: string | null;
  },
  client: PrismaClient = defaultPrisma,
): Promise<{
  members: Array<{
    userId: string;
    displayName: string;
    email: string | null;
    avatarUrl: string | null;
    workspaceRole: string;
  }>;
  nextCursor: string | null;
}> {
  const take = boundedPage(input.limit);
  const search = (input.search ?? "").trim();

  /**
   * WCR-21 (2026-09-07) — THE EXCLUSION IS A JOIN, NOT AN ARRAY.
   *
   * This loaded EVERY member of the group with an unbounded `findMany` and
   * shipped their ids back to PostgreSQL as a `notIn` array. Bounded at 500 by
   * the catalog today, so it was not hurting anyone — but it was the one
   * unbounded read left on a paginated path, and it grows with any Enterprise
   * contract that raises the per-group ceiling, which WCR-07 just made
   * possible.
   *
   * Expressed as a relation filter, the exclusion never leaves the database:
   * one query, no array, and it cannot get slower as a group grows. It also
   * fixes a subtler thing — the array was a SNAPSHOT taken microseconds before
   * the page query, so somebody added to the group in between could still be
   * offered as eligible.
   */
  const rows = await client.teamMember.findMany({
    where: {
      teamId: input.workspaceId,
      status: "ACTIVE",
      // ONE `user` clause. A second one would silently REPLACE this key rather
      // than combine with it, which would re-offer people already in the group
      // the moment somebody typed in the search box.
      user: {
        collaborationTeamMemberships: {
          none: {
            teamId: input.teamId,
            status: { in: ["ACTIVE", "SUSPENDED"] },
          },
        },
        ...(search
          ? {
              OR: [
                { displayName: { contains: search, mode: "insensitive" as const } },
                { firstName: { contains: search, mode: "insensitive" as const } },
                { lastName: { contains: search, mode: "insensitive" as const } },
                { email: { contains: search, mode: "insensitive" as const } },
              ],
            }
          : {}),
      },
    },
    orderBy: { id: "asc" },
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    take: take + 1,
    select: {
      id: true,
      role: true,
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
  });

  const page = rows.slice(0, take);
  return {
    members: page.map((r) => ({
      userId: r.user.id,
      displayName: safeDisplayName(r.user),
      // The person choosing who to add is a member manager by construction
      // (`team.member.invite`), and distinguishing two people with the same
      // name is the whole job of this list.
      email: r.user.email,
      avatarUrl: r.user.avatarUrl,
      workspaceRole: r.role,
    })),
    nextCursor: rows.length > take ? page[page.length - 1]?.id ?? null : null,
  };
}

/**
 * One page of a team's membership, filtered and searched by the DATABASE.
 *
 * `viewerCanSeeContact` is the privacy boundary: an address is administrative
 * data, and a VIEWER or an EXTERNAL collaborator holding `team.read` is not an
 * administrator. The detail endpoint used to hand every member's address to
 * everyone in the team, including guests.
 */
export async function listCollaborationTeamMembers(
  input: {
    teamId: string;
    /** Required — the proven workspace, for the effective-membership join. */
    workspaceId: string;
    viewerCanSeeContact: boolean;
    search?: string | null;
    status?: string | null;
    role?: string | null;
    limit?: number;
    cursor?: string | null;
  },
  client: PrismaClient = defaultPrisma,
): Promise<{
  members: Array<{
    id: string;
    userId: string;
    role: CollaborationTeamRole;
    status: string;
    joinedAt: Date;
    suspendedAt: Date | null;
    removedAt: Date | null;
    displayName: string;
    email: string | null;
    avatarUrl: string | null;
  }>;
  nextCursor: string | null;
  totalActive: number;
}> {
  const take = boundedPage(input.limit);
  const search = (input.search ?? "").trim();
  /**
   * WCR-11 — with no explicit `status` filter the caller means "the people who
   * are effectively in this group", which excludes anyone whose workspace
   * membership has ended. An EXPLICIT status filter is a deliberate request for
   * history (a roster of who was suspended, say) and is honoured as asked.
   */
  const effective = effectiveGroupMemberWhere(input.workspaceId);
  const where: Prisma.CollaborationTeamMemberWhereInput = {
    teamId: input.teamId,
    ...(input.status ? { status: input.status } : effective),
    ...(input.role ? { role: input.role } : {}),
    ...(search
      ? {
          user: {
            // `AND` because the effective-membership predicate above also
            // constrains `user`; a bare second `user` key would silently
            // replace it and re-admit departed members through the search box.
            AND: [
              {
                OR: [
                  { displayName: { contains: search, mode: "insensitive" } },
                  { firstName: { contains: search, mode: "insensitive" } },
                  { lastName: { contains: search, mode: "insensitive" } },
                  { email: { contains: search, mode: "insensitive" } },
                ],
              },
              ...(input.status
                ? []
                : [
                    {
                      teamMembers: {
                        some: { teamId: input.workspaceId, status: "ACTIVE" as const },
                      },
                    },
                  ]),
            ],
          },
        }
      : {}),
  };

  const [rows, totalActive] = await Promise.all([
    client.collaborationTeamMember.findMany({
      where,
      orderBy: { id: "asc" },
      ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
      take: take + 1,
      select: {
        id: true,
        userId: true,
        role: true,
        status: true,
        joinedAt: true,
        suspendedAt: true,
        removedAt: true,
        user: {
          select: {
            email: true,
            displayName: true,
            firstName: true,
            lastName: true,
            avatarUrl: true,
          },
        },
      },
    }),
    client.collaborationTeamMember.count({
      // WCR-11 — the total beside a page is the EFFECTIVE population, never
      // the raw row count, so "showing 25 of 40" cannot include leavers.
      where: { teamId: input.teamId, ...effective },
    }),
  ]);

  const page = rows.slice(0, take);
  return {
    members: page.map((m) => ({
      id: m.id,
      userId: m.userId,
      role: m.role as CollaborationTeamRole,
      status: m.status,
      joinedAt: m.joinedAt,
      suspendedAt: m.suspendedAt,
      removedAt: m.removedAt,
      displayName: safeDisplayName(m.user),
      email: input.viewerCanSeeContact ? m.user.email : null,
      avatarUrl: m.user.avatarUrl,
    })),
    nextCursor: rows.length > take ? page[page.length - 1]?.id ?? null : null,
    totalActive,
  };
}

export async function listTeamActivity(
  input: {
    teamId: string;
    actorUserId: string;
    limit?: number;
    cursor?: string | null;
    /** Proven by the route binding — a bounded READ for a workspace governor. */
    viaWorkspaceGovernance?: boolean;
  },
  client: PrismaClient = defaultPrisma,
) {
  await requireMemberWithPermission(
    client,
    input.teamId,
    input.actorUserId,
    "team.activity.read",
    input.viaWorkspaceGovernance,
  );
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  /**
   * WCR-14 (2026-09-07) — A STABLE ORDER, BECAUSE THE CURSOR NEEDS ONE.
   *
   * This ordered by `createdAt` alone and paged on `id`. Two rows sharing a
   * timestamp have no defined order between requests, so the boundary between
   * page N and page N+1 could move: rows repeat, rows vanish. It is not a rare
   * race — `recordActivity` runs inside the mutation's transaction and several
   * events are frequently written in one, so ties are the normal case, not the
   * edge case.
   *
   * `listAssignments` was given `(createdAt desc, id desc)` and a matching
   * index in the same pass that paginated it; activity was paginated and got
   * neither. Both halves land here: the tiebreak, and the index that lets
   * PostgreSQL walk this rather than sort the partition on every page
   * (`20280511000000_collaboration_activity_keyset_index`).
   */
  const rows = await client.collaborationTeamActivity.findMany({
    where: { teamId: input.teamId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
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

  /**
   * THE TARGET MUST EXIST, AND IT MUST BE IN THIS WORKSPACE.
   *
   * `targetId` was written straight through: any uuid at all was accepted as a
   * CASE, EVIDENCE or REVIEW reference, with no lookup, no tenant check and no
   * foreign key. A group could therefore carry an assignment pointing at a
   * record in someone else's workspace, or at nothing.
   *
   * It granted no access — a Collaboration Team owns nothing and confers
   * nothing, and every read of a Case or an Evidence record still goes through
   * its own authorization. What it did produce was a dangling reference inside
   * an evidence system, and a reference an operator cannot open is worse than
   * no reference at all.
   *
   * Validated through the canonical workspace scope predicates, not by a bare
   * `teamId` equality: a PERSONAL workspace's legacy `team_id IS NULL` rows are
   * identified by their owner, and `evidenceScopeFor` is the one rule that
   * knows it.
   */
  await assertAssignmentTargetInWorkspace(
    client,
    team.workspaceId,
    targetType,
    input.targetId,
  );

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

    /**
     * AN ASSIGNMENT NOBODY IS TOLD ABOUT IS NOT AN ASSIGNMENT.
     *
     * Work could be handed to a named person with a priority and a due date
     * and reach them only if they happened to open that group's Work tab. The
     * declared `ASSIGNMENT_ASSIGNED` notification type existed for this and
     * had no producer anywhere in the repository.
     *
     * Only the named assignee is notified. TEAM-LEVEL work (no assignee) is
     * deliberately silent: notifying every member that the group has a new
     * item turns the group into a mailing list, and unassigned work is exactly
     * what the Overview's "unassigned" count and the Work filter exist to
     * surface.
     *
     * In the transaction, so the notification and the assignment commit
     * together.
     */
    if (input.assigneeUserId) {
      await emitTeamNotifications(tx, {
        teamId: input.teamId,
        workspaceId: team.workspaceId,
        actorUserId: input.actorUserId,
        recipientUserIds: [input.assigneeUserId],
        type: "ASSIGNMENT_ASSIGNED",
        title: "Work assigned to you",
        body: "You have been made responsible for a record assigned to your team.",
        targetType: "ASSIGNMENT",
        targetId: a.id,
      });
    }
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
      // Needed to tell the person who handed the work over that it closed.
      assignedByUserId: true,
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

    /**
     * TELL THE PERSON WHOSE WORK THIS NOW IS.
     *
     * In the transaction, for the same reason the access-review fan-out is:
     * work that was handed to somebody without telling them is worse than work
     * that was never handed over, so the notification commits with the change
     * or not at all.
     *
     * DELIBERATELY NARROW. Only two transitions are worth interrupting
     * somebody for — becoming the assignee, and the work being finished — and
     * only the people they concern are told. Priority and due-date edits are
     * recorded on the activity timeline and do NOT notify: an operator
     * triaging twenty rows would otherwise send twenty interruptions, which is
     * how a notification channel gets muted and then ignored.
     */
    if (
      input.assigneeUserId !== undefined &&
      input.assigneeUserId &&
      input.assigneeUserId !== assignment.assigneeUserId
    ) {
      await emitTeamNotifications(tx, {
        teamId: input.teamId,
        workspaceId: assignment.workspaceId,
        actorUserId: input.actorUserId,
        recipientUserIds: [input.assigneeUserId],
        type: "ASSIGNMENT_ASSIGNED",
        title: "Work assigned to you",
        body: "You are now responsible for a record assigned to your team.",
        targetType: "ASSIGNMENT",
        targetId: assignment.id,
      });
    }
    if (data.status === "COMPLETED" && assignment.status !== "COMPLETED") {
      // The people who need to know a piece of work closed are the person who
      // was carrying it and the person who handed it over — not the whole
      // group, which would make completion the noisiest event in the product.
      const recipients = [
        assignment.assigneeUserId,
        assignment.assignedByUserId,
      ].filter((id): id is string => Boolean(id));
      if (recipients.length) {
        await emitTeamNotifications(tx, {
          teamId: input.teamId,
          workspaceId: assignment.workspaceId,
          actorUserId: input.actorUserId,
          recipientUserIds: Array.from(new Set(recipients)),
          type: "ASSIGNMENT_COMPLETED",
          title: "Assigned work completed",
          body: "Work assigned to your team has been marked completed.",
          targetType: "ASSIGNMENT",
          targetId: assignment.id,
        });
      }
    }
  });
}

/**
 * One page of a group's assignments.
 *
 * This returned `take: 200` with no cursor, which is a truncation rather than
 * a page: the two hundred and first assignment was simply invisible, with
 * nothing in the response to say so. Keyset pagination on a STABLE order
 * (`createdAt`, then `id` to break ties) makes the rest reachable and makes
 * "there is more" a fact the client is told rather than one it has to guess.
 *
 * The ordering changed with it. Sorting by status and priority first is a
 * presentation preference, and it is not stable enough to page on — two rows
 * with the same status and priority have no defined order between requests, so
 * a cursor over them can repeat or skip. The surface sorts what it displays;
 * the page boundary is the database's.
 */
/**
 * The identity of an assigned record, resolved at READ time.
 *
 * Deliberately NOT stored on the assignment row. A Collaboration Team holds a
 * REFERENCE to a canonical record and no copy of it: a case renamed on
 * `/cases` must read as renamed here the moment it changes, and a denormalised
 * label is a second copy of a fact that silently goes stale. `resolved: false`
 * says the record could not be read in this workspace and is the honest answer
 * — never a fabricated title.
 */
export type AssignmentTargetView = {
  resolved: boolean;
  label: string | null;
  sublabel: string | null;
  /** The canonical record's own state (case status, evidence status, review status). */
  state: string | null;
  /** REVIEW only — the review workflow's operational deadlines, projected read-only. */
  review: {
    slaStatus: string | null;
    dueAtUtc: Date | null;
    escalationLevel: number;
  } | null;
};

const UNRESOLVED_TARGET: AssignmentTargetView = {
  resolved: false,
  label: null,
  sublabel: null,
  state: null,
  review: null,
};

function targetKey(targetType: string, targetId: string): string {
  return `${targetType}:${targetId}`;
}

/**
 * RESOLVE A PAGE OF TARGETS IN THREE QUERIES, NEVER ONE PER ROW.
 *
 * The Work surface used to print the target TYPE ("Case") and a link that said
 * "Open case", because the list response carried nothing but a uuid. Twenty
 * rows read as twenty identical lines and the one question the row exists to
 * answer — *which* case? — could only be answered by opening each one.
 *
 * Two rules govern this function:
 *
 *   BATCHED. One `IN (...)` per target type present on the page, at most
 *   three queries regardless of page size. A per-row lookup would put a
 *   hundred queries behind one screen at the 200-row cap.
 *
 *   RE-SCOPED. Every lookup is intersected with the canonical workspace
 *   predicate rather than trusting the `workspaceId` on the assignment row.
 *   `assertAssignmentTargetInWorkspace` only started validating targets at
 *   WRITE time recently; rows written before that accepted any uuid at all,
 *   including one belonging to another tenant. Reading their label back
 *   without re-scoping would turn a dangling reference into a cross-workspace
 *   disclosure. A row that does not resolve renders as unresolved, which is
 *   also exactly what a since-deleted record should look like.
 *
 * This grants nothing. Every link still lands on a canonical page that
 * authorizes the caller independently.
 */
async function hydrateAssignmentTargets(
  client: PrismaClient,
  workspaceId: string,
  rows: ReadonlyArray<{ targetType: string; targetId: string }>,
): Promise<Map<string, AssignmentTargetView>> {
  const out = new Map<string, AssignmentTargetView>();
  if (rows.length === 0) return out;

  const idsByType = new Map<string, string[]>();
  for (const r of rows) {
    const list = idsByType.get(r.targetType);
    if (list) list.push(r.targetId);
    else idsByType.set(r.targetType, [r.targetId]);
  }

  const caseIds = idsByType.get("CASE") ?? [];
  const evidenceIds = idsByType.get("EVIDENCE") ?? [];
  const reviewIds = idsByType.get("REVIEW") ?? [];

  const [cases, evidence, reviews] = await Promise.all([
    caseIds.length
      ? client.case.findMany({
          where: {
            AND: [
              await workspaceCaseWhere(workspaceId, client),
              { id: { in: caseIds } },
            ],
          },
          select: {
            id: true,
            name: true,
            referenceNumber: true,
            status: true,
            priority: true,
          },
        })
      : Promise.resolve([]),
    evidenceIds.length
      ? client.evidence.findMany({
          where: {
            AND: [
              await workspaceEvidenceWhere(workspaceId, client),
              { id: { in: evidenceIds } },
            ],
          },
          select: {
            id: true,
            title: true,
            status: true,
            lifecycleState: true,
          },
        })
      : Promise.resolve([]),
    reviewIds.length
      ? client.evidenceReviewWorkflow.findMany({
          where: {
            AND: [
              { evidence: await workspaceEvidenceWhere(workspaceId, client) },
              { id: { in: reviewIds } },
            ],
          },
          select: {
            id: true,
            status: true,
            slaStatus: true,
            dueAt: true,
            escalationLevel: true,
            evidence: { select: { title: true } },
          },
        })
      : Promise.resolve([]),
  ]);

  for (const c of cases) {
    out.set(targetKey("CASE", c.id), {
      resolved: true,
      label: c.name,
      sublabel: c.referenceNumber,
      state: String(c.status),
      review: null,
    });
  }
  for (const e of evidence) {
    out.set(targetKey("EVIDENCE", e.id), {
      resolved: true,
      // Evidence titles are optional; the placeholder is the same one the
      // picker uses, so the two surfaces name the same record identically.
      label: e.title ?? "Untitled evidence record",
      sublabel: e.lifecycleState ? String(e.lifecycleState) : null,
      state: String(e.status),
      review: null,
    });
  }
  for (const r of reviews) {
    out.set(targetKey("REVIEW", r.id), {
      resolved: true,
      label: r.evidence?.title
        ? `Review — ${r.evidence.title}`
        : "Evidence review",
      sublabel: null,
      state: String(r.status),
      // Projected READ-ONLY from the canonical review workflow. Teams do not
      // own review state, set SLAs or escalate — this is the operational
      // context a responsible group needs in order to decide what to do next,
      // and the link goes to the console that owns the actions.
      review: {
        slaStatus: r.slaStatus ? String(r.slaStatus) : null,
        dueAtUtc: r.dueAt,
        escalationLevel: r.escalationLevel,
      },
    });
  }

  return out;
}

/** The sentinel the Work surface uses to ask for team-level (unassigned) rows. */
export const ASSIGNEE_UNASSIGNED = "UNASSIGNED";

/** Statuses that represent work still owed. Completed/cancelled work is not due. */
const OPEN_ASSIGNMENT_STATUSES = ["OPEN", "IN_PROGRESS"] as const;

/**
 * How many of a GROUP's own assignments a target-label search will scan.
 *
 * The search has to run in two steps because `targetId` is a plain uuid column
 * with no foreign key — there is no relation for Prisma to filter through. The
 * cheap direction is to bound by the GROUP's work (this cap) and search inside
 * it, not to search the workspace's records and hope the matches happen to be
 * assigned here: a workspace with ten thousand cases can match three thousand
 * of them while two belong to this team.
 */
const ASSIGNMENT_SEARCH_SCAN_CAP = 5000;

export async function listAssignments(
  input: {
    teamId: string;
    actorUserId: string;
    status?: string | null;
    /** CASE | EVIDENCE | REVIEW */
    targetType?: string | null;
    /** LOW | NORMAL | HIGH | URGENT */
    priority?: string | null;
    /** A member's user id, or `UNASSIGNED` for team-level work. */
    assigneeUserId?: string | null;
    /** `true` narrows to open work whose due date has passed. */
    overdueOnly?: boolean;
    /** Matches the assignment note or the assigned record's own label. */
    search?: string | null;
    limit?: number;
    cursor?: string | null;
    /** Proven by the route binding — a bounded READ for a workspace governor. */
    viaWorkspaceGovernance?: boolean;
  },
  client: PrismaClient = defaultPrisma,
) {
  const { team } = await requireMemberWithPermission(
    client,
    input.teamId,
    input.actorUserId,
    "team.read",
    input.viaWorkspaceGovernance,
  );

  /**
   * EVERY FILTER IS THE DATABASE'S, NOT THE PAGE'S.
   *
   * The Work surface filtered an already-fetched cursor page by search,
   * assignee and priority. On a group with more work than one page that is not
   * a filter at all — it hides rows the operator can see and shows a count
   * that means "matches on this page", while the row they are looking for sits
   * on page two. The status filter went to the server and the others did not,
   * so two controls beside each other behaved differently and neither said so.
   *
   * All of them compose into one WHERE and page with the same keyset cursor.
   */
  const now = new Date();

  /**
   * ONE status clause, composed from two inputs that can both name it.
   *
   * Spreading them separately let `overdueOnly` overwrite an explicit status:
   * asking for COMPLETED work that is overdue would silently have returned
   * OPEN work instead — a filter answering a question nobody asked. Overdue
   * only ever means "still owed", so an explicit terminal status intersected
   * with it is legitimately empty, and saying so is correct.
   */
  const explicitStatus = input.status
    ? validateAssignmentStatus(input.status)
    : null;
  const statusClause = input.overdueOnly
    ? explicitStatus
      ? (OPEN_ASSIGNMENT_STATUSES as ReadonlyArray<string>).includes(
          explicitStatus,
        )
        ? { status: explicitStatus }
        : { status: { in: [] as string[] } }
      : { status: { in: [...OPEN_ASSIGNMENT_STATUSES] } }
    : explicitStatus
      ? { status: explicitStatus }
      : {};

  const where: Record<string, unknown> = {
    teamId: input.teamId,
    ...statusClause,
    ...(input.targetType
      ? { targetType: validateAssignmentTarget(input.targetType) }
      : {}),
    ...(input.priority ? { priority: validatePriority(input.priority) } : {}),
    ...(input.assigneeUserId
      ? input.assigneeUserId === ASSIGNEE_UNASSIGNED
        ? { assigneeUserId: null }
        : { assigneeUserId: input.assigneeUserId }
      : {}),
    // Overdue is DERIVED, never stored: a column holding "is overdue" is a
    // fact that goes stale on its own the moment a clock ticks.
    ...(input.overdueOnly ? { dueAtUtc: { lt: now } } : {}),
  };

  /**
   * TARGET SEARCH — bounded, two-step, and honest about its bound.
   *
   * Step one reads this GROUP's assignment ids (capped). Step two asks the
   * canonical tables which of THOSE records match the term, re-scoped to the
   * workspace exactly as the hydration is. The result narrows the final page
   * query. A term therefore matches the assignment's own note or the name of
   * the record it points at — which is what an operator means by "search".
   */
  const term = (input.search ?? "").trim();
  if (term) {
    const scanned = await client.collaborationTeamAssignment.findMany({
      where: where as never,
      select: { targetType: true, targetId: true },
      take: ASSIGNMENT_SEARCH_SCAN_CAP,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    const matchedTargetIds = await searchAssignmentTargets(
      client,
      team.workspaceId,
      scanned,
      term,
    );
    where.OR = [
      { note: { contains: term, mode: "insensitive" } },
      ...(matchedTargetIds.length
        ? [{ targetId: { in: matchedTargetIds } }]
        : []),
    ];
  }

  const take = Math.min(Math.max(input.limit ?? 50, 1), 200);
  const found = await client.collaborationTeamAssignment.findMany({
    where: where as never,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: take + 1,
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
  });
  const rows = found.slice(0, take);
  const nextCursor = found.length > take ? rows[rows.length - 1].id : null;

  // ONE batched hydration for the whole page — see `hydrateAssignmentTargets`.
  const targets = await hydrateAssignmentTargets(
    client,
    team.workspaceId,
    rows,
  );

  const items = rows.map((a) => ({
    id: a.id,
    targetType: a.targetType as CollaborationTeamAssignmentTarget,
    targetId: a.targetId,
    // The record this assignment is ABOUT — resolved, never stored.
    target: targets.get(targetKey(a.targetType, a.targetId)) ?? UNRESOLVED_TARGET,
    assigneeUserId: a.assigneeUserId,
    assignedByUserId: a.assignedByUserId,
    status: a.status as CollaborationTeamAssignmentStatus,
    priority: a.priority as CollaborationTeamAssignmentPriority,
    dueAtUtc: a.dueAtUtc,
    // Derived here so the surface never re-derives it against a different
    // clock — and so "overdue" means the same thing in the list, the filter
    // and the Overview aggregate.
    overdue:
      a.dueAtUtc !== null &&
      a.dueAtUtc < now &&
      (OPEN_ASSIGNMENT_STATUSES as ReadonlyArray<string>).includes(a.status),
    note: a.note,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
    completedAtUtc: a.completedAtUtc,
  }));
  return {
    items,
    nextCursor,
    total: await client.collaborationTeamAssignment.count({ where: where as never }),
  };
}

/**
 * THE SAME RELATIONSHIP, READ FROM THE RECORD'S SIDE.
 *
 * `CollaborationTeamAssignment` has been the group-responsibility authority
 * since it shipped, and it was write-only in practice: no case surface, no
 * evidence surface, no review console and no inbox ever read it. A team could
 * be made responsible for a case, with an assignee, a priority and a due date,
 * and the case could not say so.
 *
 * This closes that without adding anything. It is a READ of the one authority
 * — the same rows the Work tab lists, keyed the other way. There is no
 * `responsibleTeamId` column, no mirror table and no second writer: assigning
 * from the Case page and assigning from the Team page both go through
 * `createAssignment`, which is what makes "bidirectional" a property of the UX
 * and not of the storage.
 *
 * SCOPE. The caller has already been bound to a workspace by
 * `requireWorkspace`; rows are filtered to that workspace AND intersected with
 * the canonical predicate for the record itself, so a legacy row written
 * before `assertAssignmentTargetInWorkspace` existed cannot surface another
 * tenant's group against a record here.
 *
 * IT GRANTS NOTHING. Responsibility is not access: `/cases/:id` and
 * `/evidence/:id` authorize their own reads and always did, and nothing here
 * changes what a caller may open. It answers "who is on this?", which is a
 * question about coordination, not custody.
 */
export async function listResponsibilityForTarget(
  input: {
    workspaceId: string;
    actorUserId: string;
    targetType: CollaborationTeamAssignmentTarget;
    targetId: string;
  },
  client: PrismaClient = defaultPrisma,
): Promise<{
  assignments: Array<{
    id: string;
    teamId: string;
    teamName: string;
    teamStatus: string;
    assigneeUserId: string | null;
    status: CollaborationTeamAssignmentStatus;
    priority: CollaborationTeamAssignmentPriority;
    dueAtUtc: Date | null;
    overdue: boolean;
    note: string | null;
    createdAt: Date;
  }>;
}> {
  /**
   * The record must be in THIS workspace before its responsibility is
   * described. Reusing the same predicate the write path validates against
   * means the two cannot disagree about what "in this workspace" means —
   * including a PERSONAL workspace's legacy `team_id IS NULL` rows, which only
   * these predicates know how to identify.
   */
  const inWorkspace = await assignmentTargetExistsInWorkspace(
    client,
    input.workspaceId,
    input.targetType,
    input.targetId,
  );
  if (!inWorkspace) return { assignments: [] };

  const now = new Date();
  const rows = await client.collaborationTeamAssignment.findMany({
    where: {
      workspaceId: input.workspaceId,
      targetType: input.targetType,
      targetId: input.targetId,
      // Terminal rows are history, not responsibility. A record shows who is
      // on it now; the group's own activity timeline holds who used to be.
      status: { in: [...OPEN_ASSIGNMENT_STATUSES] },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    // A record carried by more than a handful of groups at once is not a
    // coordination problem this panel can solve; the bound keeps one record's
    // panel from becoming an unbounded read.
    take: 20,
    select: {
      id: true,
      teamId: true,
      assigneeUserId: true,
      status: true,
      priority: true,
      dueAtUtc: true,
      note: true,
      createdAt: true,
      team: { select: { name: true, status: true } },
    },
  });

  return {
    assignments: rows.map((r) => ({
      id: r.id,
      teamId: r.teamId,
      teamName: r.team.name,
      teamStatus: r.team.status,
      assigneeUserId: r.assigneeUserId,
      status: r.status as CollaborationTeamAssignmentStatus,
      priority: r.priority as CollaborationTeamAssignmentPriority,
      dueAtUtc: r.dueAtUtc,
      overdue: r.dueAtUtc !== null && r.dueAtUtc < now,
      note: r.note,
      createdAt: r.createdAt,
    })),
  };
}

/**
 * THE GROUP'S OPERATIONAL SNAPSHOT — counted by the database, never by the page.
 *
 * Overview used to answer "is this team healthy?" from `team.members` and
 * `team.invites`, which are BOUNDED PREVIEWS (25 members, 50 invites). So
 * "Membership 25/25 active" was what a four-hundred-person Enterprise group
 * read, and every health row beside it was computed from the same truncated
 * array. WCR-08 fixed exactly this for the header badge and stopped there.
 *
 * Everything here is a `count` or a `groupBy` — the database counts, the page
 * renders. No aggregate loads rows to measure them, so the numbers stay exact
 * at any size and cost the same at any size.
 *
 * Every number is about ASSIGNED WORK and MEMBERSHIP, both of which the group
 * owns. Nothing here re-derives case or evidence state: those belong to their
 * own authorities and are read through the canonical link.
 */
export type CollaborationTeamOverview = {
  work: {
    open: number;
    inProgress: number;
    completed: number;
    overdue: number;
    dueSoon: number;
    highPriority: number;
    unassigned: number;
    byTargetType: { CASE: number; EVIDENCE: number; REVIEW: number };
  };
  members: {
    active: number;
    suspended: number;
    managers: number;
  };
  /** Per-member open workload, ordered heaviest first. Bounded. */
  workload: ReadonlyArray<{
    userId: string;
    open: number;
    overdue: number;
  }>;
  /**
   * =========================================================================
   * EVIDENCE-REVIEW LOAD — the OTHER thing this group's people are carrying.
   * =========================================================================
   * `workload` above counts this group's own assignments. It says nothing
   * about the evidence reviews the same people are holding elsewhere in the
   * workspace, so a lead could reassign work to the member with the lightest
   * group load and hand it to the person with the deepest review queue.
   *
   * These rows are the canonical `ReviewerWorkloadSnapshot` — the same rows
   * `/v1/reviewer-ops/workload` serves — narrowed to this group's effective
   * members. Nothing is recomputed and nothing is stored.
   *
   * `null` means the snapshot pass has never produced a row for anyone in this
   * group. That is reported as UNKNOWN rather than as zeros, because a reviewer
   * with no snapshot and a reviewer with an empty queue are not the same
   * person, and only one of them is safe to load up. `computedAtUtc` on each
   * row carries the age, so a stale answer can be labelled as one.
   */
  reviewLoad: ReadonlyArray<{
    userId: string;
    activeReviewCount: number;
    overdueReviewCount: number;
    dueSoonReviewCount: number;
    escalatedReviewCount: number;
    capacityScore: number;
    computedAtUtc: string;
  }> | null;
};

/** "Due soon" horizon. Product default, not a stored SLA — reviews own theirs. */
const DUE_SOON_WINDOW_MS = 72 * 60 * 60 * 1000;

/** Bounded workload list — a group is people, not a dataset. */
const WORKLOAD_MAX_MEMBERS = 50;

export async function getTeamOverview(
  input: {
    teamId: string;
    actorUserId: string;
    /** Proven by the route binding — a bounded READ for a workspace governor. */
    viaWorkspaceGovernance?: boolean;
  },
  client: PrismaClient = defaultPrisma,
): Promise<CollaborationTeamOverview> {
  const { team } = await requireMemberWithPermission(
    client,
    input.teamId,
    input.actorUserId,
    "team.read",
    input.viaWorkspaceGovernance,
  );
  const now = new Date();
  const dueSoonCutoff = new Date(now.getTime() + DUE_SOON_WINDOW_MS);
  const openWork = {
    teamId: input.teamId,
    status: { in: [...OPEN_ASSIGNMENT_STATUSES] },
  };

  const [
    byStatus,
    byTarget,
    overdue,
    dueSoon,
    highPriority,
    unassigned,
    memberRows,
    workloadOpen,
    workloadOverdue,
  ] = await Promise.all([
    client.collaborationTeamAssignment.groupBy({
      by: ["status"],
      where: { teamId: input.teamId },
      _count: { _all: true },
    }),
    client.collaborationTeamAssignment.groupBy({
      by: ["targetType"],
      where: openWork,
      _count: { _all: true },
    }),
    client.collaborationTeamAssignment.count({
      where: { ...openWork, dueAtUtc: { lt: now } },
    }),
    client.collaborationTeamAssignment.count({
      where: { ...openWork, dueAtUtc: { gte: now, lt: dueSoonCutoff } },
    }),
    client.collaborationTeamAssignment.count({
      where: { ...openWork, priority: { in: ["HIGH", "URGENT"] } },
    }),
    client.collaborationTeamAssignment.count({
      where: { ...openWork, assigneeUserId: null },
    }),
    // WCR-11 — effective members only, the same population the roster counts.
    client.collaborationTeamMember.groupBy({
      by: ["status"],
      where: { teamId: input.teamId, ...effectiveGroupMemberWhere(team.workspaceId) },
      _count: { _all: true },
    }),
    client.collaborationTeamAssignment.groupBy({
      by: ["assigneeUserId"],
      where: { ...openWork, assigneeUserId: { not: null } },
      _count: { _all: true },
    }),
    client.collaborationTeamAssignment.groupBy({
      by: ["assigneeUserId"],
      where: {
        ...openWork,
        assigneeUserId: { not: null },
        dueAtUtc: { lt: now },
      },
      _count: { _all: true },
    }),
  ]);

  const [managers, groupMemberRows] = await Promise.all([
    client.collaborationTeamMember.count({
      where: {
        teamId: input.teamId,
        status: "ACTIVE",
        role: { in: ["LEAD", "ADMIN"] },
        ...effectiveGroupMemberWhere(team.workspaceId),
      },
    }),
    // The group's own people, bounded by the same cap the workload list uses.
    client.collaborationTeamMember.findMany({
      where: {
        teamId: input.teamId,
        ...effectiveGroupMemberWhere(team.workspaceId),
      },
      select: { userId: true },
      take: WORKLOAD_MAX_MEMBERS,
    }),
  ]);

  /**
   * The review-load fan-in.
   *
   * Narrowed to this group's members BEFORE anything is returned: the
   * workspace snapshot covers every reviewer in the workspace, and this
   * surface is authorized for a group, not for the workspace's whole reviewer
   * roster. A caller who reached this overview through
   * `allowWorkspaceGovernorRead` could survey the workspace anyway — but the
   * caller who reached it as a group member could not, and the narrowing is
   * what makes one code path safe for both.
   *
   * A failure here degrades to UNKNOWN. Reviewer-ops is a neighbouring
   * subsystem, and a group's roster should not stop rendering because its
   * snapshot table is unavailable.
   */
  const groupMemberIds = new Set(groupMemberRows.map((m) => m.userId));
  let reviewLoad: CollaborationTeamOverview["reviewLoad"] = null;
  if (groupMemberIds.size > 0) {
    try {
      const snapshots = await listLatestWorkloadSnapshots(
        { teamId: team.workspaceId, limit: 500 },
        client,
      );
      const mine = snapshots
        .filter((r) => groupMemberIds.has(r.reviewerUserId))
        .map((r) => ({
          userId: r.reviewerUserId,
          activeReviewCount: r.activeReviewCount,
          overdueReviewCount: r.overdueReviewCount,
          dueSoonReviewCount: r.dueSoonReviewCount,
          escalatedReviewCount: r.escalatedReviewCount,
          capacityScore: r.capacityScore,
          computedAtUtc: r.computedAtUtc,
        }))
        .sort(
          (a, b) =>
            b.activeReviewCount - a.activeReviewCount ||
            a.userId.localeCompare(b.userId),
        );
      // No row for anyone in this group is UNKNOWN, not "everybody is free".
      reviewLoad = mine.length > 0 ? mine : null;
    } catch {
      reviewLoad = null;
    }
  }

  const statusCount = (s: string): number =>
    byStatus.find((r) => r.status === s)?._count._all ?? 0;
  const targetCount = (t: string): number =>
    byTarget.find((r) => r.targetType === t)?._count._all ?? 0;
  const memberCount = (s: string): number =>
    memberRows.find((r) => r.status === s)?._count._all ?? 0;

  const overdueByUser = new Map<string, number>();
  for (const row of workloadOverdue) {
    if (row.assigneeUserId) {
      overdueByUser.set(row.assigneeUserId, row._count._all);
    }
  }
  const workload = workloadOpen
    .filter((r): r is typeof r & { assigneeUserId: string } =>
      Boolean(r.assigneeUserId),
    )
    .map((r) => ({
      userId: r.assigneeUserId,
      open: r._count._all,
      overdue: overdueByUser.get(r.assigneeUserId) ?? 0,
    }))
    .sort((a, b) => b.open - a.open || a.userId.localeCompare(b.userId))
    .slice(0, WORKLOAD_MAX_MEMBERS);

  return {
    work: {
      open: statusCount("OPEN"),
      inProgress: statusCount("IN_PROGRESS"),
      completed: statusCount("COMPLETED"),
      overdue,
      dueSoon,
      highPriority,
      unassigned,
      byTargetType: {
        CASE: targetCount("CASE"),
        EVIDENCE: targetCount("EVIDENCE"),
        REVIEW: targetCount("REVIEW"),
      },
    },
    members: {
      active: memberCount("ACTIVE"),
      suspended: memberCount("SUSPENDED"),
      managers,
    },
    workload,
    reviewLoad,
  };
}

/**
 * Which of THESE assignment targets match a search term, by the canonical
 * record's own name. Bounded by the caller's already-capped id set and
 * re-scoped to the workspace — the same rule `hydrateAssignmentTargets`
 * follows, and for the same reason.
 */
async function searchAssignmentTargets(
  client: PrismaClient,
  workspaceId: string,
  rows: ReadonlyArray<{ targetType: string; targetId: string }>,
  term: string,
): Promise<string[]> {
  if (rows.length === 0) return [];
  const idsByType = new Map<string, string[]>();
  for (const r of rows) {
    const list = idsByType.get(r.targetType);
    if (list) list.push(r.targetId);
    else idsByType.set(r.targetType, [r.targetId]);
  }
  const caseIds = idsByType.get("CASE") ?? [];
  const evidenceIds = idsByType.get("EVIDENCE") ?? [];
  const reviewIds = idsByType.get("REVIEW") ?? [];
  const like = { contains: term, mode: "insensitive" as const };

  const [cases, evidence, reviews] = await Promise.all([
    caseIds.length
      ? client.case.findMany({
          where: {
            AND: [
              await workspaceCaseWhere(workspaceId, client),
              { id: { in: caseIds } },
              { OR: [{ name: like }, { referenceNumber: like }] },
            ],
          },
          select: { id: true },
        })
      : Promise.resolve([]),
    evidenceIds.length
      ? client.evidence.findMany({
          where: {
            AND: [
              await workspaceEvidenceWhere(workspaceId, client),
              { id: { in: evidenceIds } },
              { title: like },
            ],
          },
          select: { id: true },
        })
      : Promise.resolve([]),
    reviewIds.length
      ? client.evidenceReviewWorkflow.findMany({
          where: {
            AND: [
              { evidence: await workspaceEvidenceWhere(workspaceId, client) },
              { id: { in: reviewIds } },
              { evidence: { title: like } },
            ],
          },
          select: { id: true },
        })
      : Promise.resolve([]),
  ]);

  return [
    ...cases.map((r) => r.id),
    ...evidence.map((r) => r.id),
    ...reviews.map((r) => r.id),
  ];
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

/**
 * WCR-17 — the phone equivalent of `maskEmail`.
 *
 * Keeps the last two digits, which is enough for the person who sent the
 * invitation to recognise which one a row refers to, and not enough for anyone
 * else to contact them. `null` stays `null`: an absent number is not a secret
 * and rendering "***" for it would invent a value.
 */
function maskPhone(phone: string | null): string | null {
  if (!phone) return null;
  const trimmed = phone.trim();
  if (trimmed.length <= 2) return "***";
  return `***${trimmed.slice(-2)}`;
}
