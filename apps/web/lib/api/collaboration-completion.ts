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

export async function listNotifications(opts?: {
  limit?: number;
  unreadOnly?: boolean;
}): Promise<NotificationList> {
  const params: string[] = [];
  if (opts?.limit) params.push(`limit=${opts.limit}`);
  if (opts?.unreadOnly) params.push("unread=true");
  const qs = params.length ? `?${params.join("&")}` : "";
  return (await apiFetch(
    `/v1/collaboration-team-notifications${qs}`,
  )) as NotificationList;
}

export async function markNotificationRead(
  notificationId: string,
): Promise<void> {
  await apiFetch(
    `/v1/collaboration-team-notifications/${encodeURIComponent(notificationId)}/read`,
    { method: "POST" },
  );
}

export async function markAllNotificationsRead(): Promise<void> {
  await apiFetch("/v1/collaboration-team-notifications/read-all", {
    method: "POST",
  });
}

// =============================================================================
// Preferences
// =============================================================================

export async function getNotificationPreference(
  teamId: string,
): Promise<NotificationPreference> {
  const res = (await apiFetch(
    `${BASE}/${encodeURIComponent(teamId)}/notification-preferences`,
  )) as { preference: NotificationPreference };
  return res.preference;
}

export async function updateNotificationPreference(
  teamId: string,
  patch: Partial<NotificationPreference>,
): Promise<void> {
  await apiFetch(
    `${BASE}/${encodeURIComponent(teamId)}/notification-preferences`,
    { method: "PATCH", body: JSON.stringify(patch) },
  );
}

// =============================================================================
// Guests
// =============================================================================

export async function listGuests(
  teamId: string,
): Promise<ReadonlyArray<Guest>> {
  const res = (await apiFetch(
    `${BASE}/${encodeURIComponent(teamId)}/guests`,
  )) as { guests: Guest[] };
  return res.guests;
}

export async function inviteGuest(
  teamId: string,
  input: {
    email: string;
    expiresInDays?: number;
    scopeNote?: string | null;
  },
): Promise<{ id: string }> {
  const res = (await apiFetch(
    `${BASE}/${encodeURIComponent(teamId)}/guests/invite`,
    { method: "POST", body: JSON.stringify(input) },
  )) as { guest: { id: string } };
  return res.guest;
}

export async function revokeGuest(
  teamId: string,
  guestId: string,
): Promise<void> {
  await apiFetch(
    `${BASE}/${encodeURIComponent(teamId)}/guests/${encodeURIComponent(guestId)}/revoke`,
    { method: "PATCH" },
  );
}

// =============================================================================
// Access reviews
// =============================================================================

export async function listAccessReviews(
  teamId: string,
): Promise<ReadonlyArray<AccessReview>> {
  const res = (await apiFetch(
    `${BASE}/${encodeURIComponent(teamId)}/access-review`,
  )) as { reviews: AccessReview[] };
  return res.reviews;
}

export async function openAccessReview(
  teamId: string,
  input?: { dueAtUtc?: string | null },
): Promise<{ id: string; itemCount: number }> {
  const res = (await apiFetch(
    `${BASE}/${encodeURIComponent(teamId)}/access-review`,
    { method: "POST", body: JSON.stringify(input ?? {}) },
  )) as { review: { id: string; itemCount: number } };
  return res.review;
}

export async function decideAccessReviewItem(
  teamId: string,
  itemId: string,
  input: {
    decision: CollaborationTeamAccessReviewDecision;
    notes?: string | null;
  },
): Promise<void> {
  await apiFetch(
    `${BASE}/${encodeURIComponent(teamId)}/access-review/items/${encodeURIComponent(itemId)}`,
    { method: "PATCH", body: JSON.stringify(input) },
  );
}

export async function completeAccessReview(
  teamId: string,
  reviewId: string,
): Promise<void> {
  await apiFetch(
    `${BASE}/${encodeURIComponent(teamId)}/access-review/${encodeURIComponent(reviewId)}/complete`,
    { method: "POST" },
  );
}

// =============================================================================
// Activity v2
// =============================================================================

export async function listActivityV2(
  teamId: string,
  opts?: {
    eventType?: string;
    actor?: string;
    since?: string;
    until?: string;
    limit?: number;
    cursor?: string;
  },
): Promise<ActivityFeed> {
  const params: string[] = [];
  if (opts?.eventType) params.push(`eventType=${encodeURIComponent(opts.eventType)}`);
  if (opts?.actor) params.push(`actor=${encodeURIComponent(opts.actor)}`);
  if (opts?.since) params.push(`since=${encodeURIComponent(opts.since)}`);
  if (opts?.until) params.push(`until=${encodeURIComponent(opts.until)}`);
  if (opts?.limit) params.push(`limit=${opts.limit}`);
  if (opts?.cursor) params.push(`cursor=${encodeURIComponent(opts.cursor)}`);
  const qs = params.length ? `?${params.join("&")}` : "";
  return (await apiFetch(
    `${BASE}/${encodeURIComponent(teamId)}/activity/v2${qs}`,
  )) as ActivityFeed;
}
