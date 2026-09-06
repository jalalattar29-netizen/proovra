/**
 * PROOVRA Phase 7 — Collaboration Completion service.
 *
 * Consolidated backend for the Phase 7 collaboration features:
 *
 *   - User directory enrichment (safe per-viewer projection)
 *   - Comments (CRUD + soft-delete + audit)
 *   - Mentions (handle parsing + user/special resolution + audit)
 *   - In-app notifications (create + list + mark-read + unread count)
 *   - Notification preferences (per user × team)
 *   - Guests (invite, accept stub, revoke)
 *   - Access review (open + per-item decision + complete)
 *
 * Hard rules:
 *
 *   - All mutations go through this module. Routes are thin wrappers.
 *   - Every mutation produces a `CollaborationTeamActivity` row.
 *   - Cross-workspace leaks are structurally impossible — every read
 *     filters on `workspaceId` AND `teamId`, and every write checks
 *     the actor is an active team member.
 *   - Mention fanout respects preferences (mentions: false ⇒ no notif
 *     created; digest: MUTED ⇒ no notif created).
 *   - Comment bodies are sanitised via the shared helper before
 *     persistence.
 *   - Guest access is time-bounded by `expiresAtUtc` — the service
 *     rejects accept calls past expiry.
 *
 * Constitutional reference:
 *   docs/architecture/phase-7-collaboration-completion-final.md
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import {
  COLLABORATION_TEAM_COMMENT_TARGETS,
  buildCollaborationTeamUserDirectoryEntry,
  collaborationTeamRoleHasPermission,
  isSpecialCollaborationTeamMention,
  parseCollaborationTeamMentionHandles,
  sanitiseCollaborationTeamCommentBody,
  type CollaborationTeamAccessReviewDecision,
  type CollaborationTeamCommentTarget,
  type CollaborationTeamDigestMode,
  type CollaborationTeamMentionType,
  type CollaborationTeamNotificationType,
  type CollaborationTeamRole,
  type CollaborationTeamUserDirectoryEntry,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import {
  CollaborationTeamError,
  isCollaborationTeamModerator,
} from "./collaboration-team.service.js";

// =============================================================================
// Helpers
// =============================================================================

async function requireMemberRole(
  client: PrismaClient,
  teamId: string,
  userId: string,
): Promise<{
  role: CollaborationTeamRole;
  team: { id: string; workspaceId: string };
}> {
  const team = await client.collaborationTeam.findUnique({
    where: { id: teamId },
    select: { id: true, workspaceId: true },
  });
  if (!team)
    throw new CollaborationTeamError("team_not_found", "Team not found.", 404);
  const member = await client.collaborationTeamMember.findFirst({
    where: { teamId, userId, status: "ACTIVE" },
    select: { role: true },
  });
  if (!member)
    throw new CollaborationTeamError(
      "team_forbidden",
      "You must be an active team member.",
      403,
    );
  return { role: member.role as CollaborationTeamRole, team };
}

async function recordActivity(
  client: PrismaClient | Prisma.TransactionClient,
  args: {
    teamId: string;
    workspaceId: string;
    actorUserId: string | null;
    eventType: string;
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
// User directory enrichment (Stage 2)
// =============================================================================

/**
 * Resolve safe display fragments for a list of userIds.
 *
 *   - Always returns one entry per requested userId, even if the user
 *     row is missing (fallback "Team member" with the requested id).
 *   - Respects workspace-member boundary on the `email` field.
 */
export async function resolveUserDirectoryEntries(
  userIds: ReadonlyArray<string>,
  opts: { viewerIsWorkspaceMember: boolean },
  client: PrismaClient = defaultPrisma,
): Promise<Record<string, CollaborationTeamUserDirectoryEntry>> {
  const unique = Array.from(new Set(userIds.filter(Boolean)));
  if (unique.length === 0) return {};
  const rows = await client.user.findMany({
    where: { id: { in: unique } },
    select: {
      id: true,
      email: true,
      displayName: true,
      firstName: true,
      lastName: true,
      avatarUrl: true,
    },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: Record<string, CollaborationTeamUserDirectoryEntry> = {};
  for (const id of unique) {
    const row = byId.get(id);
    if (row) {
      out[id] = buildCollaborationTeamUserDirectoryEntry(row, opts);
    } else {
      out[id] = {
        userId: id,
        displayName: "Team member",
        initials: "??",
        avatarUrl: null,
        email: null,
        emailMasked: null,
      };
    }
  }
  return out;
}

// =============================================================================
// Comments (Stage 3) + Mentions (Stage 4)
// =============================================================================

const COMMENT_RATE_LIMIT_PER_MIN = 12;

function validateCommentTarget(t: string | null | undefined): CollaborationTeamCommentTarget {
  if (
    !t ||
    !(COLLABORATION_TEAM_COMMENT_TARGETS as ReadonlyArray<string>).includes(t)
  )
    throw new CollaborationTeamError(
      "team_invalid",
      `target_type must be one of ${COLLABORATION_TEAM_COMMENT_TARGETS.join(", ")}.`,
      400,
    );
  return t as CollaborationTeamCommentTarget;
}

export async function createComment(
  input: {
    teamId: string;
    actorUserId: string;
    targetType: string;
    targetId?: string | null;
    body: string;
  },
  client: PrismaClient = defaultPrisma,
): Promise<{ id: string; mentionCount: number; notificationCount: number }> {
  const { team } = await requireMemberRole(
    client,
    input.teamId,
    input.actorUserId,
  );
  const targetType = validateCommentTarget(input.targetType);
  const sanitised = sanitiseCollaborationTeamCommentBody(input.body);
  if (!sanitised.ok)
    throw new CollaborationTeamError("team_invalid", sanitised.reason, 400);

  // Rate limit: per-actor comment cap per minute, per team.
  const since = new Date(Date.now() - 60 * 1000);
  const recent = await client.collaborationTeamComment.count({
    where: {
      teamId: input.teamId,
      authorUserId: input.actorUserId,
      createdAt: { gte: since },
    },
  });
  if (recent >= COMMENT_RATE_LIMIT_PER_MIN)
    throw new CollaborationTeamError(
      "team_rate_limited",
      `Slow down — max ${COMMENT_RATE_LIMIT_PER_MIN} comments per minute.`,
      429,
    );

  const handles = parseCollaborationTeamMentionHandles(sanitised.body);

  // Resolve user mentions to userIds (active team members only — never
  // notify outside the team).
  const activeMembers = await client.collaborationTeamMember.findMany({
    where: { teamId: input.teamId, status: "ACTIVE" },
    select: {
      userId: true,
      role: true,
      user: {
        select: { email: true, displayName: true, firstName: true, lastName: true },
      },
    },
  });
  const memberByHandle = new Map<string, { userId: string; role: string }>();
  for (const m of activeMembers) {
    const emailLocal = m.user.email?.split("@")[0]?.toLowerCase();
    if (emailLocal) memberByHandle.set(emailLocal, { userId: m.userId, role: m.role });
    const display = m.user.displayName?.toLowerCase().replace(/\s+/g, ".");
    if (display && !memberByHandle.has(display))
      memberByHandle.set(display, { userId: m.userId, role: m.role });
  }

  const userMentions: Array<{
    mentionType: CollaborationTeamMentionType;
    mentionedUserId: string | null;
    rawHandle: string;
  }> = [];
  let hasTeamMention = false;
  let hasLeadMention = false;
  for (const handle of handles) {
    if (isSpecialCollaborationTeamMention(handle)) {
      if (handle === "team") hasTeamMention = true;
      else if (handle === "lead") hasLeadMention = true;
      continue;
    }
    const match = memberByHandle.get(handle);
    userMentions.push({
      mentionType: "USER",
      mentionedUserId: match?.userId ?? null,
      rawHandle: handle,
    });
  }

  const result = await client.$transaction(async (tx) => {
    const comment = await tx.collaborationTeamComment.create({
      data: {
        teamId: input.teamId,
        workspaceId: team.workspaceId,
        authorUserId: input.actorUserId,
        targetType,
        targetId: input.targetId ?? null,
        body: sanitised.body,
        status: "ACTIVE",
      },
      select: { id: true },
    });

    // Persist mention rows.
    const mentionRows: Array<{
      mentionType: CollaborationTeamMentionType;
      mentionedUserId: string | null;
      rawHandle: string | null;
    }> = [...userMentions];
    if (hasTeamMention)
      mentionRows.push({ mentionType: "TEAM", mentionedUserId: null, rawHandle: "team" });
    if (hasLeadMention)
      mentionRows.push({ mentionType: "LEAD", mentionedUserId: null, rawHandle: "lead" });

    if (mentionRows.length > 0) {
      await tx.collaborationTeamCommentMention.createMany({
        data: mentionRows.map((m) => ({
          commentId: comment.id,
          teamId: input.teamId,
          mentionType: m.mentionType,
          mentionedUserId: m.mentionedUserId,
          rawHandle: m.rawHandle,
        })),
      });
    }

    // Notification fanout — never notify the author themselves.
    const recipientIds = new Set<string>();
    for (const u of userMentions) {
      if (u.mentionedUserId && u.mentionedUserId !== input.actorUserId)
        recipientIds.add(u.mentionedUserId);
    }
    if (hasTeamMention) {
      for (const m of activeMembers)
        if (m.userId !== input.actorUserId) recipientIds.add(m.userId);
    }
    if (hasLeadMention) {
      for (const m of activeMembers)
        if (m.role === "LEAD" && m.userId !== input.actorUserId)
          recipientIds.add(m.userId);
    }

    // Filter by preferences.
    let notificationCount = 0;
    if (recipientIds.size > 0) {
      const recipientArr = Array.from(recipientIds);
      const prefs = await tx.collaborationTeamNotificationPreference.findMany({
        where: { teamId: input.teamId, userId: { in: recipientArr } },
        select: { userId: true, mentions: true, digest: true },
      });
      const prefByUser = new Map(prefs.map((p) => [p.userId, p]));
      const notifiable = recipientArr.filter((uid) => {
        const p = prefByUser.get(uid);
        if (!p) return true; // default: notify
        if (p.digest === "MUTED") return false;
        return p.mentions !== false;
      });
      if (notifiable.length > 0) {
        await tx.collaborationTeamNotification.createMany({
          data: notifiable.map((uid) => ({
            userId: uid,
            workspaceId: team.workspaceId,
            teamId: input.teamId,
            type: "MENTION_IN_COMMENT" satisfies CollaborationTeamNotificationType,
            title: "You were mentioned in a team comment",
            body: sanitised.body.slice(0, 240),
            targetType: "COMMENT",
            targetId: comment.id,
          })),
        });
        notificationCount = notifiable.length;
      }
    }

    await recordActivity(tx, {
      teamId: input.teamId,
      workspaceId: team.workspaceId,
      actorUserId: input.actorUserId,
      eventType: "COMMENT_CREATED",
      targetType: "COMMENT",
      targetId: comment.id,
      metadata: {
        targetType,
        targetId: input.targetId ?? null,
        mentionCount: mentionRows.length,
        notifiedCount: notificationCount,
      },
    });

    return {
      id: comment.id,
      mentionCount: mentionRows.length,
      notificationCount,
    };
  });

  return result;
}

export async function listComments(
  input: {
    teamId: string;
    actorUserId: string;
    targetType?: string | null;
    targetId?: string | null;
    limit?: number;
  },
  client: PrismaClient = defaultPrisma,
): Promise<{
  items: Array<{
    id: string;
    authorUserId: string;
    targetType: CollaborationTeamCommentTarget;
    targetId: string | null;
    body: string;
    status: string;
    createdAt: Date;
    updatedAt: Date;
    mentions: Array<{
      mentionType: CollaborationTeamMentionType;
      mentionedUserId: string | null;
      rawHandle: string | null;
    }>;
  }>;
  directory: Record<string, CollaborationTeamUserDirectoryEntry>;
}> {
  await requireMemberRole(client, input.teamId, input.actorUserId);
  const where: Prisma.CollaborationTeamCommentWhereInput = {
    teamId: input.teamId,
    status: { not: "DELETED" },
  };
  if (input.targetType)
    where.targetType = validateCommentTarget(input.targetType);
  if (input.targetId) where.targetId = input.targetId;
  const rows = await client.collaborationTeamComment.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(input.limit ?? 50, 1), 200),
    include: {
      mentions: {
        select: {
          mentionType: true,
          mentionedUserId: true,
          rawHandle: true,
        },
      },
    },
  });
  const actorIds = Array.from(
    new Set([
      ...rows.map((r) => r.authorUserId),
      ...rows.flatMap((r) =>
        r.mentions.map((m) => m.mentionedUserId).filter(Boolean) as string[],
      ),
    ]),
  );
  const directory = await resolveUserDirectoryEntries(
    actorIds,
    { viewerIsWorkspaceMember: true },
    client,
  );
  return {
    items: rows.map((r) => ({
      id: r.id,
      authorUserId: r.authorUserId,
      targetType: r.targetType as CollaborationTeamCommentTarget,
      targetId: r.targetId,
      body: r.body,
      status: r.status,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      mentions: r.mentions.map((m) => ({
        mentionType: m.mentionType as CollaborationTeamMentionType,
        mentionedUserId: m.mentionedUserId,
        rawHandle: m.rawHandle,
      })),
    })),
    directory,
  };
}

export async function editComment(
  input: {
    teamId: string;
    actorUserId: string;
    commentId: string;
    body: string;
  },
  client: PrismaClient = defaultPrisma,
): Promise<void> {
  const { team, role } = await requireMemberRole(
    client,
    input.teamId,
    input.actorUserId,
  );
  const comment = await client.collaborationTeamComment.findUnique({
    where: { id: input.commentId },
    select: { id: true, teamId: true, authorUserId: true, status: true },
  });
  if (!comment || comment.teamId !== input.teamId)
    throw new CollaborationTeamError("team_not_found", "Comment not found.", 404);
  if (comment.status === "DELETED")
    throw new CollaborationTeamError(
      "team_invalid",
      "Cannot edit a deleted comment.",
      409,
    );
  // Authors edit their own; LEAD/ADMIN can edit anyone (moderation).
  const isAuthor = comment.authorUserId === input.actorUserId;
  const isModerator = isCollaborationTeamModerator(role);
  if (!isAuthor && !isModerator)
    throw new CollaborationTeamError(
      "team_forbidden",
      "You can only edit your own comments.",
      403,
    );
  const sanitised = sanitiseCollaborationTeamCommentBody(input.body);
  if (!sanitised.ok)
    throw new CollaborationTeamError("team_invalid", sanitised.reason, 400);

  await client.$transaction(async (tx) => {
    await tx.collaborationTeamComment.update({
      where: { id: input.commentId },
      data: { body: sanitised.body, status: "EDITED" },
    });
    await recordActivity(tx, {
      teamId: input.teamId,
      workspaceId: team.workspaceId,
      actorUserId: input.actorUserId,
      eventType: "COMMENT_EDITED",
      targetType: "COMMENT",
      targetId: input.commentId,
    });
  });
}

export async function deleteComment(
  input: { teamId: string; actorUserId: string; commentId: string },
  client: PrismaClient = defaultPrisma,
): Promise<void> {
  const { team, role } = await requireMemberRole(
    client,
    input.teamId,
    input.actorUserId,
  );
  const comment = await client.collaborationTeamComment.findUnique({
    where: { id: input.commentId },
    select: { id: true, teamId: true, authorUserId: true, status: true },
  });
  if (!comment || comment.teamId !== input.teamId)
    throw new CollaborationTeamError("team_not_found", "Comment not found.", 404);
  if (comment.status === "DELETED") return;
  const isAuthor = comment.authorUserId === input.actorUserId;
  const isModerator = isCollaborationTeamModerator(role);
  if (!isAuthor && !isModerator)
    throw new CollaborationTeamError(
      "team_forbidden",
      "You can only delete your own comments.",
      403,
    );
  await client.$transaction(async (tx) => {
    await tx.collaborationTeamComment.update({
      where: { id: input.commentId },
      data: {
        status: "DELETED",
        deletedAtUtc: new Date(),
        deletedByUserId: input.actorUserId,
      },
    });
    await recordActivity(tx, {
      teamId: input.teamId,
      workspaceId: team.workspaceId,
      actorUserId: input.actorUserId,
      eventType: "COMMENT_DELETED",
      targetType: "COMMENT",
      targetId: input.commentId,
      metadata: { moderated: isModerator && !isAuthor },
    });
  });
}

// =============================================================================
// Notifications (Stage 5)
// =============================================================================

export async function listMyNotifications(
  input: {
    actorUserId: string;
    workspaceId: string;
    limit?: number;
    onlyUnread?: boolean;
  },
  client: PrismaClient = defaultPrisma,
) {
  const where: Prisma.CollaborationTeamNotificationWhereInput = {
    userId: input.actorUserId,
    workspaceId: input.workspaceId,
  };
  if (input.onlyUnread) where.readAt = null;
  const rows = await client.collaborationTeamNotification.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(input.limit ?? 30, 1), 100),
  });
  const unreadCount = await client.collaborationTeamNotification.count({
    where: {
      userId: input.actorUserId,
      workspaceId: input.workspaceId,
      readAt: null,
    },
  });
  return {
    items: rows.map((r) => ({
      id: r.id,
      teamId: r.teamId,
      type: r.type as CollaborationTeamNotificationType,
      title: r.title,
      body: r.body,
      targetType: r.targetType,
      targetId: r.targetId,
      readAt: r.readAt,
      createdAt: r.createdAt,
    })),
    unreadCount,
  };
}

export async function markNotificationRead(
  input: { actorUserId: string; notificationId: string },
  client: PrismaClient = defaultPrisma,
): Promise<void> {
  const n = await client.collaborationTeamNotification.findUnique({
    where: { id: input.notificationId },
    select: { id: true, userId: true, readAt: true },
  });
  if (!n)
    throw new CollaborationTeamError(
      "team_not_found",
      "Notification not found.",
      404,
    );
  if (n.userId !== input.actorUserId)
    throw new CollaborationTeamError(
      "team_forbidden",
      "Not your notification.",
      403,
    );
  if (n.readAt) return;
  await client.collaborationTeamNotification.update({
    where: { id: input.notificationId },
    data: { readAt: new Date() },
  });
}

export async function markAllNotificationsRead(
  input: { actorUserId: string; workspaceId: string },
  client: PrismaClient = defaultPrisma,
): Promise<void> {
  await client.collaborationTeamNotification.updateMany({
    where: {
      userId: input.actorUserId,
      workspaceId: input.workspaceId,
      readAt: null,
    },
    data: { readAt: new Date() },
  });
}

// Internal: create a notification (called by other services for
// assignment-assigned events etc.). NEVER notify the actor themselves.
export async function emitTeamNotifications(
  client: PrismaClient | Prisma.TransactionClient,
  args: {
    teamId: string;
    workspaceId: string;
    actorUserId: string | null;
    recipientUserIds: ReadonlyArray<string>;
    type: CollaborationTeamNotificationType;
    title: string;
    body: string | null;
    targetType: string | null;
    targetId: string | null;
  },
): Promise<number> {
  const filtered = args.recipientUserIds.filter(
    (id) => id && id !== args.actorUserId,
  );
  if (filtered.length === 0) return 0;
  await client.collaborationTeamNotification.createMany({
    data: filtered.map((uid) => ({
      userId: uid,
      workspaceId: args.workspaceId,
      teamId: args.teamId,
      type: args.type,
      title: args.title.slice(0, 200),
      body: args.body ? args.body.slice(0, 1000) : null,
      targetType: args.targetType,
      targetId: args.targetId,
    })),
  });
  return filtered.length;
}

// =============================================================================
// Preferences (Stage 6)
// =============================================================================

export async function getMyNotificationPreference(
  input: { teamId: string; actorUserId: string },
  client: PrismaClient = defaultPrisma,
): Promise<{
  mentions: boolean;
  assignments: boolean;
  inviteAccepted: boolean;
  digest: CollaborationTeamDigestMode;
}> {
  await requireMemberRole(client, input.teamId, input.actorUserId);
  const row = await client.collaborationTeamNotificationPreference.findUnique({
    where: {
      collaboration_team_notification_preference_team_user_uniq: {
        teamId: input.teamId,
        userId: input.actorUserId,
      },
    },
    select: {
      mentions: true,
      assignments: true,
      inviteAccepted: true,
      digest: true,
    },
  });
  return (
    (row as {
      mentions: boolean;
      assignments: boolean;
      inviteAccepted: boolean;
      digest: CollaborationTeamDigestMode;
    } | null) ?? {
      mentions: true,
      assignments: true,
      inviteAccepted: true,
      digest: "INSTANT",
    }
  );
}

export async function updateMyNotificationPreference(
  input: {
    teamId: string;
    actorUserId: string;
    mentions?: boolean;
    assignments?: boolean;
    inviteAccepted?: boolean;
    digest?: CollaborationTeamDigestMode;
  },
  client: PrismaClient = defaultPrisma,
): Promise<void> {
  await requireMemberRole(client, input.teamId, input.actorUserId);
  await client.collaborationTeamNotificationPreference.upsert({
    where: {
      collaboration_team_notification_preference_team_user_uniq: {
        teamId: input.teamId,
        userId: input.actorUserId,
      },
    },
    create: {
      teamId: input.teamId,
      userId: input.actorUserId,
      mentions: input.mentions ?? true,
      assignments: input.assignments ?? true,
      inviteAccepted: input.inviteAccepted ?? true,
      digest: input.digest ?? "INSTANT",
    },
    update: {
      ...(input.mentions !== undefined ? { mentions: input.mentions } : {}),
      ...(input.assignments !== undefined ? { assignments: input.assignments } : {}),
      ...(input.inviteAccepted !== undefined
        ? { inviteAccepted: input.inviteAccepted }
        : {}),
      ...(input.digest !== undefined ? { digest: input.digest } : {}),
    },
  });
}

// =============================================================================
// Guests (Stage 7)
// =============================================================================


export async function inviteGuest(
  input: {
    teamId: string;
    actorUserId: string;
    email: string;
    expiresInDays?: number;
    scopeNote?: string | null;
  },
  client: PrismaClient = defaultPrisma,
): Promise<{ id: string }> {
  const { role } = await requireMemberRole(
    client,
    input.teamId,
    input.actorUserId,
  );
  if (!collaborationTeamRoleHasPermission(role, "team.member.invite"))
    throw new CollaborationTeamError(
      "team_forbidden",
      "Only LEAD and ADMIN can invite guests.",
      403,
    );

  /**
   * RETIRED — it never granted anything.
   *
   * "Guests" wrote a `CollaborationTeamGuest` row and stopped. No email was
   * ever sent; `acceptedUserId` and `acceptedAtUtc` are written by ZERO code
   * paths in the repository; the status never left PENDING; and no read path
   * anywhere consulted the table for access. An operator pressing "Invite
   * guest" was told an external collaborator had been given time-bounded
   * access, and no access existed and no one was contacted.
   *
   * On an evidence platform that is worse than a missing feature. External
   * review has a real authority — `/review/external`, with grants, identity,
   * expiry and audit — and the honest move is to send people there rather than
   * to keep a second registry that only looks like one.
   *
   * Existing rows are untouched and still listed, so an operator who believes
   * they granted something can see exactly what is there and revoke it.
   */
  throw new CollaborationTeamError(
    "COLLABORATION_TEAM_GUESTS_RETIRED",
    "External reviewers are granted access in External Review, where the grant is real, time-bounded and audited. This surface never sent an invitation or granted access.",
    410,
  );

}

export async function listGuests(
  input: { teamId: string; actorUserId: string },
  client: PrismaClient = defaultPrisma,
) {
  /**
   * A GUEST LIST IS A LIST OF THIRD-PARTY ADDRESSES.
   *
   * This required only membership, so every VIEWER — and every EXTERNAL
   * collaborator, who holds `team.read` — could read the address of every
   * outside party the team had ever contacted. Reading a team is not a reason
   * to receive that.
   *
   * Gated on the same permission that CREATES a guest, because the people who
   * manage external access are the people who need to see who has it.
   */
  const { role } = await requireMemberRole(
    client,
    input.teamId,
    input.actorUserId,
  );
  if (!collaborationTeamRoleHasPermission(role, "team.member.invite")) {
    throw new CollaborationTeamError(
      "team_forbidden",
      "Only LEAD and ADMIN can see external collaborators.",
      403,
    );
  }
  const rows = await client.collaborationTeamGuest.findMany({
    where: { teamId: input.teamId },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  return rows.map((g) => ({
    id: g.id,
    email: g.email,
    status: g.status,
    expiresAtUtc: g.expiresAtUtc,
    scopeNote: g.scopeNote,
    invitedByUserId: g.invitedByUserId,
    acceptedAtUtc: g.acceptedAtUtc,
    revokedAtUtc: g.revokedAtUtc,
    createdAt: g.createdAt,
  }));
}

export async function revokeGuest(
  input: { teamId: string; actorUserId: string; guestId: string },
  client: PrismaClient = defaultPrisma,
): Promise<void> {
  const { team, role } = await requireMemberRole(
    client,
    input.teamId,
    input.actorUserId,
  );
  if (!collaborationTeamRoleHasPermission(role, "team.member.invite"))
    throw new CollaborationTeamError(
      "team_forbidden",
      "Only LEAD and ADMIN can revoke guests.",
      403,
    );
  const guest = await client.collaborationTeamGuest.findUnique({
    where: { id: input.guestId },
    select: { id: true, teamId: true, status: true },
  });
  if (!guest || guest.teamId !== input.teamId)
    throw new CollaborationTeamError("team_not_found", "Guest not found.", 404);
  if (guest.status !== "PENDING" && guest.status !== "ACCEPTED") return;
  await client.$transaction(async (tx) => {
    await tx.collaborationTeamGuest.update({
      where: { id: input.guestId },
      data: {
        status: "REVOKED",
        revokedAtUtc: new Date(),
        revokedByUserId: input.actorUserId,
      },
    });
    await recordActivity(tx, {
      teamId: input.teamId,
      workspaceId: team.workspaceId,
      actorUserId: input.actorUserId,
      eventType: "GUEST_REVOKED",
      targetType: "GUEST",
      targetId: input.guestId,
    });
  });
}

// =============================================================================
// Access reviews (Stage 8)
// =============================================================================

export async function openAccessReview(
  input: {
    teamId: string;
    actorUserId: string;
    dueAtUtc?: Date | null;
  },
  client: PrismaClient = defaultPrisma,
): Promise<{ id: string; itemCount: number }> {
  const { team, role } = await requireMemberRole(
    client,
    input.teamId,
    input.actorUserId,
  );
  if (!isCollaborationTeamModerator(role))
    throw new CollaborationTeamError(
      "team_forbidden",
      "Only LEAD and ADMIN can open access reviews.",
      403,
    );
  const activeMembers = await client.collaborationTeamMember.findMany({
    where: { teamId: input.teamId, status: "ACTIVE" },
    // PHASE 13 §4 (2026-08-17) — `userId` is selected alongside `id` so the
    // notification fan-out below needs no second read: the item rows key on the
    // membership id, the notifications key on the user.
    select: { id: true, userId: true },
  });
  const result = await client.$transaction(async (tx) => {
    const review = await tx.collaborationTeamAccessReview.create({
      data: {
        teamId: input.teamId,
        workspaceId: team.workspaceId,
        createdByUserId: input.actorUserId,
        status: "OPEN",
        dueAtUtc: input.dueAtUtc ?? null,
      },
      select: { id: true },
    });
    if (activeMembers.length > 0) {
      await tx.collaborationTeamAccessReviewItem.createMany({
        data: activeMembers.map((m) => ({
          reviewId: review.id,
          memberId: m.id,
          decision: "PENDING",
        })),
      });
    }
    await recordActivity(tx, {
      teamId: input.teamId,
      workspaceId: team.workspaceId,
      actorUserId: input.actorUserId,
      eventType: "ACCESS_REVIEW_OPENED",
      targetType: "ACCESS_REVIEW",
      targetId: review.id,
      metadata: { itemCount: activeMembers.length },
    });
    // PHASE 13 §4 (2026-08-17) — tell the members whose access is being
    // reviewed.
    //
    // `ACCESS_REVIEW_OPENED` is one of the ten declared
    // `CollaborationTeamNotificationType` values and was one of the nine with no
    // producer, while two live surfaces read the table it writes: the team
    // collaboration console's NotificationsCard and the Operations-Center
    // unified inbox, whose own comment promises exactly this class of row.
    // `emitTeamNotifications` existed to fan these out and was reached by
    // nothing.
    //
    // Inside the transaction on purpose: an access review that exists without
    // having told anyone is worse than one that was never opened, so the
    // notifications commit with the review and its items or not at all. The
    // helper filters the actor out of its own recipient list.
    await emitTeamNotifications(tx, {
      teamId: input.teamId,
      workspaceId: team.workspaceId,
      actorUserId: input.actorUserId,
      recipientUserIds: activeMembers.map((m) => m.userId),
      type: "ACCESS_REVIEW_OPENED",
      title: "Access review opened",
      body: "Your membership of this team is included in a new access review.",
      targetType: "ACCESS_REVIEW",
      targetId: review.id,
    });
    return { id: review.id, itemCount: activeMembers.length };
  });
  return result;
}

export async function listAccessReviews(
  input: { teamId: string; actorUserId: string },
  client: PrismaClient = defaultPrisma,
) {
  await requireMemberRole(client, input.teamId, input.actorUserId);
  const rows = await client.collaborationTeamAccessReview.findMany({
    where: { teamId: input.teamId },
    orderBy: { createdAt: "desc" },
    include: {
      items: {
        select: {
          id: true,
          memberId: true,
          decision: true,
          decidedAt: true,
          decidedByUserId: true,
          notes: true,
        },
      },
      _count: { select: { items: true } },
    },
    take: 50,
  });
  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    createdAt: r.createdAt,
    dueAtUtc: r.dueAtUtc,
    completedAtUtc: r.completedAtUtc,
    itemCount: r._count.items as number,
    items: r.items.map((i) => ({
      id: i.id,
      memberId: i.memberId,
      decision: i.decision as CollaborationTeamAccessReviewDecision,
      decidedAt: i.decidedAt,
      decidedByUserId: i.decidedByUserId,
      notes: i.notes,
    })),
  }));
}

export async function decideAccessReviewItem(
  input: {
    teamId: string;
    actorUserId: string;
    itemId: string;
    decision: CollaborationTeamAccessReviewDecision;
    notes?: string | null;
  },
  client: PrismaClient = defaultPrisma,
): Promise<void> {
  const { team, role } = await requireMemberRole(
    client,
    input.teamId,
    input.actorUserId,
  );
  if (!isCollaborationTeamModerator(role))
    throw new CollaborationTeamError(
      "team_forbidden",
      "Only LEAD and ADMIN can decide access review items.",
      403,
    );
  const item = await client.collaborationTeamAccessReviewItem.findUnique({
    where: { id: input.itemId },
    select: {
      id: true,
      review: { select: { teamId: true, id: true } },
    },
  });
  if (!item || item.review.teamId !== input.teamId)
    throw new CollaborationTeamError(
      "team_not_found",
      "Access review item not found.",
      404,
    );
  await client.$transaction(async (tx) => {
    await tx.collaborationTeamAccessReviewItem.update({
      where: { id: input.itemId },
      data: {
        decision: input.decision,
        decidedAt: new Date(),
        decidedByUserId: input.actorUserId,
        notes: input.notes ? input.notes.slice(0, 600) : null,
      },
    });
    await recordActivity(tx, {
      teamId: input.teamId,
      workspaceId: team.workspaceId,
      actorUserId: input.actorUserId,
      eventType: "ACCESS_REVIEW_ITEM_DECIDED",
      targetType: "ACCESS_REVIEW_ITEM",
      targetId: input.itemId,
      metadata: { decision: input.decision },
    });
  });
}

export async function completeAccessReview(
  input: { teamId: string; actorUserId: string; reviewId: string },
  client: PrismaClient = defaultPrisma,
): Promise<void> {
  const { team, role } = await requireMemberRole(
    client,
    input.teamId,
    input.actorUserId,
  );
  if (!isCollaborationTeamModerator(role))
    throw new CollaborationTeamError(
      "team_forbidden",
      "Only LEAD and ADMIN can complete access reviews.",
      403,
    );
  await client.$transaction(async (tx) => {
    /**
     * THE REVIEW MUST BELONG TO THIS TEAM, AND THE PREDICATE SAYS SO.
     *
     * This was `update({ where: { id: input.reviewId } })`. The actor was
     * checked against `input.teamId` and the row was then written by id alone,
     * so a LEAD of any team in any workspace could complete any access review
     * whose uuid they held — a cross-tenant write on a compliance control. Its
     * sibling `decideAccessReviewItem` has always checked
     * `item.review.teamId !== input.teamId`; this one never did.
     *
     * Expressed as `updateMany` with the binding IN the WHERE rather than a
     * read followed by a write: the containment condition and the mutation are
     * then one statement against one snapshot, and a zero count is the refusal
     * rather than something a later branch has to remember to check.
     */
    const completed = await tx.collaborationTeamAccessReview.updateMany({
      where: {
        id: input.reviewId,
        teamId: input.teamId,
        workspaceId: team.workspaceId,
        status: "OPEN",
      },
      data: { status: "COMPLETED", completedAtUtc: new Date() },
    });
    if (completed.count === 0) {
      throw new CollaborationTeamError(
        "team_not_found",
        "Access review not found.",
        404,
      );
    }

    /**
     * A DECISION THAT IS NOT APPLIED IS NOT A CONTROL.
     *
     * `decideAccessReviewItem` wrote a decision row and an activity row and
     * never touched `CollaborationTeamMember`. So an access review could be
     * marked complete with every item decided REMOVE, and every one of those
     * people would still be in the team — a compliance surface that recorded
     * intentions and enforced none of them, on a product whose customers point
     * at it during audits.
     *
     * Completion is where the decisions land, in the SAME transaction that
     * closes the review: a review cannot be complete while its outcome is
     * still pending, and a failure rolls both back together.
     *
     * KEEP is a decision too — it just has no write. PENDING items are left
     * alone rather than treated as either answer.
     */
    const decided = await tx.collaborationTeamAccessReviewItem.findMany({
      where: { reviewId: input.reviewId, decision: { in: ["REMOVE", "CHANGE_ROLE"] } },
      select: { id: true, decision: true, memberId: true },
    });

    for (const item of decided) {
      if (item.decision === "REMOVE") {
        // The last LEAD is protected here as everywhere else: a review may not
        // leave a team with nobody able to lead it.
        const member = await tx.collaborationTeamMember.findUnique({
          where: { id: item.memberId },
          select: { id: true, role: true, status: true, teamId: true },
        });
        if (!member || member.teamId !== input.teamId) continue;
        if (member.status !== "ACTIVE") continue;
        if (member.role === "LEAD") {
          const otherLeads = await tx.collaborationTeamMember.count({
            where: {
              teamId: input.teamId,
              id: { not: member.id },
              role: "LEAD",
              status: "ACTIVE",
            },
          });
          if (otherLeads === 0) {
            throw new CollaborationTeamError(
              "team_conflict",
              "This review would remove the last LEAD. Change that decision or transfer leadership first.",
              409,
            );
          }
        }
        await tx.collaborationTeamMember.update({
          where: { id: member.id },
          data: {
            status: "REMOVED",
            removedAt: new Date(),
            statusReason: "access review",
          },
        });
        await recordActivity(tx, {
          teamId: input.teamId,
          workspaceId: team.workspaceId,
          actorUserId: input.actorUserId,
          eventType: "MEMBER_REMOVED",
          targetType: "ACCESS_REVIEW_ITEM",
          targetId: item.id,
          metadata: { via: "ACCESS_REVIEW" },
        });
      } else {
        // CHANGE_ROLE without a target role is not a decision anyone can act
        // on. It demotes to VIEWER — the least authority the group has — which
        // is the safe reading of "this person should not hold what they hold".
        const member = await tx.collaborationTeamMember.findUnique({
          where: { id: item.memberId },
          select: { id: true, role: true, status: true, teamId: true },
        });
        if (!member || member.teamId !== input.teamId) continue;
        if (member.status !== "ACTIVE" || member.role === "VIEWER") continue;
        if (member.role === "LEAD") {
          const otherLeads = await tx.collaborationTeamMember.count({
            where: {
              teamId: input.teamId,
              id: { not: member.id },
              role: "LEAD",
              status: "ACTIVE",
            },
          });
          if (otherLeads === 0) {
            throw new CollaborationTeamError(
              "team_conflict",
              "This review would demote the last LEAD. Change that decision or transfer leadership first.",
              409,
            );
          }
        }
        await tx.collaborationTeamMember.update({
          where: { id: member.id },
          data: { role: "VIEWER" },
        });
        await recordActivity(tx, {
          teamId: input.teamId,
          workspaceId: team.workspaceId,
          actorUserId: input.actorUserId,
          eventType: "MEMBER_ROLE_CHANGED",
          targetType: "ACCESS_REVIEW_ITEM",
          targetId: item.id,
          metadata: { via: "ACCESS_REVIEW", from: member.role, to: "VIEWER" },
        });
      }
    }
    await recordActivity(tx, {
      teamId: input.teamId,
      workspaceId: team.workspaceId,
      actorUserId: input.actorUserId,
      eventType: "ACCESS_REVIEW_COMPLETED",
      targetType: "ACCESS_REVIEW",
      targetId: input.reviewId,
    });
  });
}

// =============================================================================
// Activity upgrade (Stage 9) — filtered + enriched listing
// =============================================================================

export async function listTeamActivityFiltered(
  input: {
    teamId: string;
    actorUserId: string;
    eventType?: string | null;
    actorFilter?: string | null;
    sinceUtc?: Date | null;
    untilUtc?: Date | null;
    limit?: number;
    cursor?: string | null;
  },
  client: PrismaClient = defaultPrisma,
) {
  await requireMemberRole(client, input.teamId, input.actorUserId);
  const where: Prisma.CollaborationTeamActivityWhereInput = {
    teamId: input.teamId,
  };
  if (input.eventType) where.eventType = input.eventType;
  if (input.actorFilter) where.actorUserId = input.actorFilter;
  if (input.sinceUtc || input.untilUtc) {
    where.createdAt = {};
    if (input.sinceUtc) where.createdAt.gte = input.sinceUtc;
    if (input.untilUtc) where.createdAt.lte = input.untilUtc;
  }
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  const rows = await client.collaborationTeamActivity.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: limit + 1,
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
  });
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const actorIds = items
    .map((r) => r.actorUserId)
    .filter(Boolean) as string[];
  const directory = await resolveUserDirectoryEntries(
    actorIds,
    { viewerIsWorkspaceMember: true },
    client,
  );
  return {
    items: items.map((r) => ({
      id: r.id,
      eventType: r.eventType,
      actorUserId: r.actorUserId,
      targetType: r.targetType,
      targetId: r.targetId,
      metadata: r.metadata,
      createdAt: r.createdAt,
    })),
    directory,
    nextCursor: hasMore ? items[items.length - 1]!.id : null,
  };
}
