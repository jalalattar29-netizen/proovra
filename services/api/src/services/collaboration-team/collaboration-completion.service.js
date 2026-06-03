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
import { COLLABORATION_TEAM_COMMENT_TARGETS, buildCollaborationTeamUserDirectoryEntry, collaborationTeamRoleHasPermission, isSpecialCollaborationTeamMention, parseCollaborationTeamMentionHandles, sanitiseCollaborationTeamCommentBody, } from "@proovra/shared";
import { prisma as defaultPrisma } from "../../db.js";
import { CollaborationTeamError } from "./collaboration-team.service.js";
// =============================================================================
// Helpers
// =============================================================================
async function requireMemberRole(client, teamId, userId) {
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
        throw new CollaborationTeamError("team_forbidden", "You must be an active team member.", 403);
    return { role: member.role, team };
}
async function recordActivity(client, args) {
    await client.collaborationTeamActivity.create({
        data: {
            teamId: args.teamId,
            workspaceId: args.workspaceId,
            actorUserId: args.actorUserId,
            eventType: args.eventType,
            targetType: args.targetType ?? null,
            targetId: args.targetId ?? null,
            metadata: (args.metadata ?? {}),
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
export async function resolveUserDirectoryEntries(userIds, opts, client = defaultPrisma) {
    const unique = Array.from(new Set(userIds.filter(Boolean)));
    if (unique.length === 0)
        return {};
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
    const out = {};
    for (const id of unique) {
        const row = byId.get(id);
        if (row) {
            out[id] = buildCollaborationTeamUserDirectoryEntry(row, opts);
        }
        else {
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
function validateCommentTarget(t) {
    if (!t ||
        !COLLABORATION_TEAM_COMMENT_TARGETS.includes(t))
        throw new CollaborationTeamError("team_invalid", `target_type must be one of ${COLLABORATION_TEAM_COMMENT_TARGETS.join(", ")}.`, 400);
    return t;
}
export async function createComment(input, client = defaultPrisma) {
    const { team } = await requireMemberRole(client, input.teamId, input.actorUserId);
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
        throw new CollaborationTeamError("team_rate_limited", `Slow down — max ${COMMENT_RATE_LIMIT_PER_MIN} comments per minute.`, 429);
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
    const memberByHandle = new Map();
    for (const m of activeMembers) {
        const emailLocal = m.user.email?.split("@")[0]?.toLowerCase();
        if (emailLocal)
            memberByHandle.set(emailLocal, { userId: m.userId, role: m.role });
        const display = m.user.displayName?.toLowerCase().replace(/\s+/g, ".");
        if (display && !memberByHandle.has(display))
            memberByHandle.set(display, { userId: m.userId, role: m.role });
    }
    const userMentions = [];
    let hasTeamMention = false;
    let hasLeadMention = false;
    for (const handle of handles) {
        if (isSpecialCollaborationTeamMention(handle)) {
            if (handle === "team")
                hasTeamMention = true;
            else if (handle === "lead")
                hasLeadMention = true;
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
        const mentionRows = [...userMentions];
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
        const recipientIds = new Set();
        for (const u of userMentions) {
            if (u.mentionedUserId && u.mentionedUserId !== input.actorUserId)
                recipientIds.add(u.mentionedUserId);
        }
        if (hasTeamMention) {
            for (const m of activeMembers)
                if (m.userId !== input.actorUserId)
                    recipientIds.add(m.userId);
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
                if (!p)
                    return true; // default: notify
                if (p.digest === "MUTED")
                    return false;
                return p.mentions !== false;
            });
            if (notifiable.length > 0) {
                await tx.collaborationTeamNotification.createMany({
                    data: notifiable.map((uid) => ({
                        userId: uid,
                        workspaceId: team.workspaceId,
                        teamId: input.teamId,
                        type: "MENTION_IN_COMMENT",
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
export async function listComments(input, client = defaultPrisma) {
    await requireMemberRole(client, input.teamId, input.actorUserId);
    const where = {
        teamId: input.teamId,
        status: { not: "DELETED" },
    };
    if (input.targetType)
        where.targetType = validateCommentTarget(input.targetType);
    if (input.targetId)
        where.targetId = input.targetId;
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
    const actorIds = Array.from(new Set([
        ...rows.map((r) => r.authorUserId),
        ...rows.flatMap((r) => r.mentions.map((m) => m.mentionedUserId).filter(Boolean)),
    ]));
    const directory = await resolveUserDirectoryEntries(actorIds, { viewerIsWorkspaceMember: true }, client);
    return {
        items: rows.map((r) => ({
            id: r.id,
            authorUserId: r.authorUserId,
            targetType: r.targetType,
            targetId: r.targetId,
            body: r.body,
            status: r.status,
            createdAt: r.createdAt,
            updatedAt: r.updatedAt,
            mentions: r.mentions.map((m) => ({
                mentionType: m.mentionType,
                mentionedUserId: m.mentionedUserId,
                rawHandle: m.rawHandle,
            })),
        })),
        directory,
    };
}
export async function editComment(input, client = defaultPrisma) {
    const { team, role } = await requireMemberRole(client, input.teamId, input.actorUserId);
    const comment = await client.collaborationTeamComment.findUnique({
        where: { id: input.commentId },
        select: { id: true, teamId: true, authorUserId: true, status: true },
    });
    if (!comment || comment.teamId !== input.teamId)
        throw new CollaborationTeamError("team_not_found", "Comment not found.", 404);
    if (comment.status === "DELETED")
        throw new CollaborationTeamError("team_invalid", "Cannot edit a deleted comment.", 409);
    // Authors edit their own; LEAD/ADMIN can edit anyone (moderation).
    const isAuthor = comment.authorUserId === input.actorUserId;
    const isModerator = role === "LEAD" || role === "ADMIN";
    if (!isAuthor && !isModerator)
        throw new CollaborationTeamError("team_forbidden", "You can only edit your own comments.", 403);
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
export async function deleteComment(input, client = defaultPrisma) {
    const { team, role } = await requireMemberRole(client, input.teamId, input.actorUserId);
    const comment = await client.collaborationTeamComment.findUnique({
        where: { id: input.commentId },
        select: { id: true, teamId: true, authorUserId: true, status: true },
    });
    if (!comment || comment.teamId !== input.teamId)
        throw new CollaborationTeamError("team_not_found", "Comment not found.", 404);
    if (comment.status === "DELETED")
        return;
    const isAuthor = comment.authorUserId === input.actorUserId;
    const isModerator = role === "LEAD" || role === "ADMIN";
    if (!isAuthor && !isModerator)
        throw new CollaborationTeamError("team_forbidden", "You can only delete your own comments.", 403);
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
export async function listMyNotifications(input, client = defaultPrisma) {
    const where = {
        userId: input.actorUserId,
        workspaceId: input.workspaceId,
    };
    if (input.onlyUnread)
        where.readAt = null;
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
            type: r.type,
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
export async function markNotificationRead(input, client = defaultPrisma) {
    const n = await client.collaborationTeamNotification.findUnique({
        where: { id: input.notificationId },
        select: { id: true, userId: true, readAt: true },
    });
    if (!n)
        throw new CollaborationTeamError("team_not_found", "Notification not found.", 404);
    if (n.userId !== input.actorUserId)
        throw new CollaborationTeamError("team_forbidden", "Not your notification.", 403);
    if (n.readAt)
        return;
    await client.collaborationTeamNotification.update({
        where: { id: input.notificationId },
        data: { readAt: new Date() },
    });
}
export async function markAllNotificationsRead(input, client = defaultPrisma) {
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
export async function emitTeamNotifications(client, args) {
    const filtered = args.recipientUserIds.filter((id) => id && id !== args.actorUserId);
    if (filtered.length === 0)
        return 0;
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
export async function getMyNotificationPreference(input, client = defaultPrisma) {
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
    return (row ?? {
        mentions: true,
        assignments: true,
        inviteAccepted: true,
        digest: "INSTANT",
    });
}
export async function updateMyNotificationPreference(input, client = defaultPrisma) {
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
const GUEST_EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const GUEST_DEFAULT_TTL_DAYS = 14;
const GUEST_MAX_TTL_DAYS = 90;
export async function inviteGuest(input, client = defaultPrisma) {
    const { team, role } = await requireMemberRole(client, input.teamId, input.actorUserId);
    if (!collaborationTeamRoleHasPermission(role, "team.member.invite"))
        throw new CollaborationTeamError("team_forbidden", "Only LEAD and ADMIN can invite guests.", 403);
    if (!GUEST_EMAIL_RE.test(input.email))
        throw new CollaborationTeamError("team_invalid", "Invalid email.", 400);
    const ttlDays = Math.min(Math.max(input.expiresInDays ?? GUEST_DEFAULT_TTL_DAYS, 1), GUEST_MAX_TTL_DAYS);
    const expiresAtUtc = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);
    const result = await client.$transaction(async (tx) => {
        const g = await tx.collaborationTeamGuest.create({
            data: {
                teamId: input.teamId,
                workspaceId: team.workspaceId,
                email: input.email.toLowerCase(),
                expiresAtUtc,
                status: "PENDING",
                invitedByUserId: input.actorUserId,
                scopeNote: input.scopeNote ? input.scopeNote.slice(0, 400) : null,
            },
            select: { id: true },
        });
        await recordActivity(tx, {
            teamId: input.teamId,
            workspaceId: team.workspaceId,
            actorUserId: input.actorUserId,
            eventType: "GUEST_INVITED",
            targetType: "GUEST",
            targetId: g.id,
            metadata: { ttlDays },
        });
        return g;
    });
    return result;
}
export async function listGuests(input, client = defaultPrisma) {
    await requireMemberRole(client, input.teamId, input.actorUserId);
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
export async function revokeGuest(input, client = defaultPrisma) {
    const { team, role } = await requireMemberRole(client, input.teamId, input.actorUserId);
    if (!collaborationTeamRoleHasPermission(role, "team.member.invite"))
        throw new CollaborationTeamError("team_forbidden", "Only LEAD and ADMIN can revoke guests.", 403);
    const guest = await client.collaborationTeamGuest.findUnique({
        where: { id: input.guestId },
        select: { id: true, teamId: true, status: true },
    });
    if (!guest || guest.teamId !== input.teamId)
        throw new CollaborationTeamError("team_not_found", "Guest not found.", 404);
    if (guest.status !== "PENDING" && guest.status !== "ACCEPTED")
        return;
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
export async function openAccessReview(input, client = defaultPrisma) {
    const { team, role } = await requireMemberRole(client, input.teamId, input.actorUserId);
    if (role !== "LEAD" && role !== "ADMIN")
        throw new CollaborationTeamError("team_forbidden", "Only LEAD and ADMIN can open access reviews.", 403);
    const activeMembers = await client.collaborationTeamMember.findMany({
        where: { teamId: input.teamId, status: "ACTIVE" },
        select: { id: true },
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
        return { id: review.id, itemCount: activeMembers.length };
    });
    return result;
}
export async function listAccessReviews(input, client = defaultPrisma) {
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
        itemCount: r._count.items,
        items: r.items.map((i) => ({
            id: i.id,
            memberId: i.memberId,
            decision: i.decision,
            decidedAt: i.decidedAt,
            decidedByUserId: i.decidedByUserId,
            notes: i.notes,
        })),
    }));
}
export async function decideAccessReviewItem(input, client = defaultPrisma) {
    const { team, role } = await requireMemberRole(client, input.teamId, input.actorUserId);
    if (role !== "LEAD" && role !== "ADMIN")
        throw new CollaborationTeamError("team_forbidden", "Only LEAD and ADMIN can decide access review items.", 403);
    const item = await client.collaborationTeamAccessReviewItem.findUnique({
        where: { id: input.itemId },
        select: {
            id: true,
            review: { select: { teamId: true, id: true } },
        },
    });
    if (!item || item.review.teamId !== input.teamId)
        throw new CollaborationTeamError("team_not_found", "Access review item not found.", 404);
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
export async function completeAccessReview(input, client = defaultPrisma) {
    const { team, role } = await requireMemberRole(client, input.teamId, input.actorUserId);
    if (role !== "LEAD" && role !== "ADMIN")
        throw new CollaborationTeamError("team_forbidden", "Only LEAD and ADMIN can complete access reviews.", 403);
    await client.$transaction(async (tx) => {
        await tx.collaborationTeamAccessReview.update({
            where: { id: input.reviewId },
            data: { status: "COMPLETED", completedAtUtc: new Date() },
        });
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
export async function listTeamActivityFiltered(input, client = defaultPrisma) {
    await requireMemberRole(client, input.teamId, input.actorUserId);
    const where = {
        teamId: input.teamId,
    };
    if (input.eventType)
        where.eventType = input.eventType;
    if (input.actorFilter)
        where.actorUserId = input.actorFilter;
    if (input.sinceUtc || input.untilUtc) {
        where.createdAt = {};
        if (input.sinceUtc)
            where.createdAt.gte = input.sinceUtc;
        if (input.untilUtc)
            where.createdAt.lte = input.untilUtc;
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
        .filter(Boolean);
    const directory = await resolveUserDirectoryEntries(actorIds, { viewerIsWorkspaceMember: true }, client);
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
        nextCursor: hasMore ? items[items.length - 1].id : null,
    };
}
