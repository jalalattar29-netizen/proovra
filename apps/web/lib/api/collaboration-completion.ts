/**
 * PROOVRA Phase 7 — Collaboration Completion API client.
 *
 * Thin typed wrapper over `apiFetch` for the Phase 7 backend
 * (comments, mentions, notifications, preferences, guests, access
 * reviews, activity v2). Mirrors the Phase 6 `collaboration-teams.ts`
 * style for consistency.
 */

import { apiFetch } from "../api";
import type {
  CollaborationTeamAccessReviewDecision,
  CollaborationTeamAccessReviewStatus,
  CollaborationTeamCommentStatus,
  CollaborationTeamCommentTarget,
  CollaborationTeamDigestMode,
  CollaborationTeamGuestStatus,
  CollaborationTeamMentionType,
  CollaborationTeamNotificationType,
  CollaborationTeamUserDirectoryEntry,
} from "@proovra/shared";

// =============================================================================
// Response shapes
// =============================================================================

export type Comment = {
  id: string;
  authorUserId: string;
  targetType: CollaborationTeamCommentTarget;
  targetId: string | null;
  body: string;
  status: CollaborationTeamCommentStatus;
  createdAt: string;
  updatedAt: string;
  mentions: ReadonlyArray<{
    mentionType: CollaborationTeamMentionType;
    mentionedUserId: string | null;
    rawHandle: string | null;
  }>;
};

export type CommentList = {
  items: ReadonlyArray<Comment>;
  directory: Record<string, CollaborationTeamUserDirectoryEntry>;
};

export type InAppNotification = {
  id: string;
  teamId: string | null;
  type: CollaborationTeamNotificationType;
  title: string;
  body: string | null;
  targetType: string | null;
  targetId: string | null;
  readAt: string | null;
  createdAt: string;
};

export type NotificationList = {
  items: ReadonlyArray<InAppNotification>;
  unreadCount: number;
};

export type NotificationPreference = {
  mentions: boolean;
  assignments: boolean;
  inviteAccepted: boolean;
  digest: CollaborationTeamDigestMode;
};

export type Guest = {
  id: string;
  email: string;
  status: CollaborationTeamGuestStatus;
  expiresAtUtc: string;
  scopeNote: string | null;
  invitedByUserId: string;
  acceptedAtUtc: string | null;
  revokedAtUtc: string | null;
  createdAt: string;
};

export type AccessReview = {
  id: string;
  status: CollaborationTeamAccessReviewStatus;
  createdAt: string;
  dueAtUtc: string | null;
  completedAtUtc: string | null;
  itemCount: number;
  items: ReadonlyArray<{
    id: string;
    memberId: string;
    decision: CollaborationTeamAccessReviewDecision;
    decidedAt: string | null;
    decidedByUserId: string | null;
    notes: string | null;
  }>;
};

export type ActivityFeed = {
  items: ReadonlyArray<{
    id: string;
    eventType: string;
    actorUserId: string | null;
    targetType: string | null;
    targetId: string | null;
    metadata: Record<string, unknown>;
    createdAt: string;
  }>;
  directory: Record<string, CollaborationTeamUserDirectoryEntry>;
  nextCursor: string | null;
};

// =============================================================================
// Comments
// =============================================================================

const BASE = "/v1/collaboration-teams";

export async function listComments(
  teamId: string,
  opts?: {
    targetType?: CollaborationTeamCommentTarget;
    targetId?: string;
    limit?: number;
  },
): Promise<CommentList> {
  const params: string[] = [];
  if (opts?.targetType) params.push(`targetType=${opts.targetType}`);
  if (opts?.targetId) params.push(`targetId=${encodeURIComponent(opts.targetId)}`);
  if (opts?.limit) params.push(`limit=${opts.limit}`);
  const qs = params.length ? `?${params.join("&")}` : "";
  return (await apiFetch(
    `${BASE}/${encodeURIComponent(teamId)}/comments${qs}`,
  )) as CommentList;
}

export async function createComment(
  teamId: string,
  input: {
    targetType: CollaborationTeamCommentTarget;
    targetId?: string | null;
    body: string;
  },
): Promise<{ id: string }> {
  const res = (await apiFetch(`${BASE}/${encodeURIComponent(teamId)}/comments`, {
    method: "POST",
    body: JSON.stringify(input),
  })) as { comment: { id: string } };
  return res.comment;
}

export async function editComment(
  teamId: string,
  commentId: string,
  body: string,
): Promise<void> {
  await apiFetch(
    `${BASE}/${encodeURIComponent(teamId)}/comments/${encodeURIComponent(commentId)}`,
    { method: "PATCH", body: JSON.stringify({ body }) },
  );
}

export async function deleteComment(
  teamId: string,
  commentId: string,
): Promise<void> {
  await apiFetch(
    `${BASE}/${encodeURIComponent(teamId)}/comments/${encodeURIComponent(commentId)}`,
    { method: "DELETE" },
  );
}

// =============================================================================
// Notifications
// =============================================================================

/**
 * WORKSPACE AND COLLABORATION ARCHITECTURE CLOSURE (2026-09-06) — everything
 * below this point was DELETED, with the surfaces it called.
 *
 *   listNotifications / markNotificationRead / markAllNotificationsRead
 *     → the INBOX reads the same rows and marks the same `readAt`. Two
 *       clients over one column presented as two inboxes with two unread
 *       counts.
 *   getNotificationPreference / updateNotificationPreference
 *     → Settings. A third preference store with no stated precedence against
 *       workspace and organization policy is a store nobody can trust.
 *   listGuests / inviteGuest / revokeGuest
 *     → External Review. "Guests" wrote a row and granted nothing: no email
 *       was sent, no read path consulted the table, the status never left
 *       PENDING.
 *   listAccessReviews / openAccessReview / decideAccessReviewItem /
 *   completeAccessReview / listActivityV2
 *     → no consumer. The group's access review is reached from its own
 *       surface, and the Activity tab reads the canonical feed.
 *
 * The API routes answer a typed 410 naming where each one went, so a stale
 * client is told rather than 404'd. What remains here is the DISCUSSION
 * client, which the group's Discussion tab uses.
 */
