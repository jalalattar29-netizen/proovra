/**
 * PROOVRA Phase 6 — Collaboration Teams API client.
 *
 * Thin typed wrapper over `apiFetch` for the backend mounted at
 * `/v1/collaboration-teams`. Invitations are EMAIL-ONLY (Entitlement
 * Alignment, 2026-07-14 — the SMS and shareable-link invite endpoints
 * were deleted product-wide). Every function:
 *
 *   - Returns a typed result (the route's response shape).
 *   - Throws an `ApiError` carrying `requestId` on non-2xx responses.
 *   - Never logs the raw invite token.
 *
 * Shared vocabulary (roles, channels, etc.) is re-exported from
 * `@proovra/shared` — components import canonical constants here and
 * never re-define them.
 */

import { apiFetch } from "../api";
import type {
  CollaborationTeamRole,
  CollaborationTeamType,
  CollaborationTeamStatus,
  CollaborationTeamMemberStatus,
  CollaborationTeamInviteChannel,
  CollaborationTeamInviteStatus,
  CollaborationTeamDeliveryStatus,
  CollaborationTeamActivityEventType,
  CollaborationTeamAssignmentStatus,
  CollaborationTeamAssignmentPriority,
  CollaborationTeamAssignmentTarget,
} from "@proovra/shared";

// =============================================================================
// Response shapes
// =============================================================================

export type CollaborationTeamSummary = {
  id: string;
  name: string;
  description: string | null;
  teamType: CollaborationTeamType;
  status: CollaborationTeamStatus;
  createdAt: string;
  updatedAt: string;
  archivedAtUtc: string | null;
  memberCount: number;
  pendingInviteCount: number;
  openAssignmentCount: number;
  lastActivityAt: string | null;
  viewerRole: CollaborationTeamRole | null;
};

export type CollaborationTeamMember = {
  id: string;
  userId: string;
  role: CollaborationTeamRole;
  status: CollaborationTeamMemberStatus;
  joinedAt: string;
  suspendedAt: string | null;
  removedAt: string | null;
  user: {
    id: string;
    email: string | null;
    displayName: string | null;
    firstName: string | null;
    lastName: string | null;
    avatarUrl: string | null;
  };
};

export type CollaborationTeamInvite = {
  id: string;
  channel: CollaborationTeamInviteChannel;
  email: string | null;
  phone: string | null;
  role: CollaborationTeamRole;
  status: CollaborationTeamInviteStatus;
  expiresAtUtc: string;
  maxUses: number;
  useCount: number;
  createdAt: string;
  deliveryStatus: CollaborationTeamDeliveryStatus;
};

export type CollaborationTeamDetail = {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  teamType: CollaborationTeamType;
  status: CollaborationTeamStatus;
  createdAt: string;
  updatedAt: string;
  archivedAtUtc: string | null;
  viewerRole: CollaborationTeamRole;
  /**
   * PHASE 12 POINT 4 STEP 1 — SERVER-projected viewer authority, computed by
   * the same predicates the collaboration-team gates enforce. Optional on the
   * wire type ONLY so a degraded response is representable; every consumer
   * treats an absent block as "no authority" (fail closed).
   */
  viewerCapabilities?: {
    canModerateComments: boolean;
    canManageGuests: boolean;
    canManageAccessReviews: boolean;
  };
  members: ReadonlyArray<CollaborationTeamMember>;
  invites: ReadonlyArray<CollaborationTeamInvite>;
  assignmentCount: number;
};

export type CollaborationTeamActivityItem = {
  id: string;
  eventType: CollaborationTeamActivityEventType;
  actorUserId: string | null;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type CollaborationTeamAssignment = {
  id: string;
  targetType: CollaborationTeamAssignmentTarget;
  targetId: string;
  assigneeUserId: string | null;
  assignedByUserId: string;
  status: CollaborationTeamAssignmentStatus;
  priority: CollaborationTeamAssignmentPriority;
  dueAtUtc: string | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
  completedAtUtc: string | null;
};

// =============================================================================
// API functions
// =============================================================================

const BASE = "/v1/collaboration-teams";

export async function listTeams(opts?: {
  includeArchived?: boolean;
}): Promise<ReadonlyArray<CollaborationTeamSummary>> {
  const qs = opts?.includeArchived ? "?includeArchived=true" : "";
  const res = (await apiFetch(`${BASE}${qs}`)) as {
    teams: CollaborationTeamSummary[];
  };
  return res.teams;
}

export async function createTeam(input: {
  name: string;
  description?: string | null;
  teamType?: CollaborationTeamType;
}): Promise<{ id: string }> {
  const res = (await apiFetch(BASE, {
    method: "POST",
    body: JSON.stringify(input),
  })) as { team: { id: string } };
  return res.team;
}

export async function getTeam(
  teamId: string,
): Promise<CollaborationTeamDetail> {
  const res = (await apiFetch(`${BASE}/${encodeURIComponent(teamId)}`)) as {
    team: CollaborationTeamDetail;
  };
  return res.team;
}

export async function updateTeam(
  teamId: string,
  input: {
    name?: string;
    description?: string | null;
    teamType?: CollaborationTeamType;
  },
): Promise<void> {
  await apiFetch(`${BASE}/${encodeURIComponent(teamId)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function archiveTeam(teamId: string): Promise<void> {
  await apiFetch(`${BASE}/${encodeURIComponent(teamId)}/archive`, {
    method: "POST",
  });
}

export async function addExistingMember(
  teamId: string,
  input: { userId: string; role?: CollaborationTeamRole },
): Promise<{ id: string }> {
  const res = (await apiFetch(
    `${BASE}/${encodeURIComponent(teamId)}/members`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  )) as { member: { id: string } };
  return res.member;
}

export async function updateMember(
  teamId: string,
  memberId: string,
  input: {
    role?: CollaborationTeamRole;
    status?: CollaborationTeamMemberStatus;
    reason?: string | null;
  },
): Promise<void> {
  await apiFetch(
    `${BASE}/${encodeURIComponent(teamId)}/members/${encodeURIComponent(memberId)}`,
    {
      method: "PATCH",
      body: JSON.stringify(input),
    },
  );
}

export async function removeMember(
  teamId: string,
  memberId: string,
): Promise<void> {
  await apiFetch(
    `${BASE}/${encodeURIComponent(teamId)}/members/${encodeURIComponent(memberId)}`,
    { method: "DELETE" },
  );
}

export async function inviteByEmail(
  teamId: string,
  input: {
    email: string;
    role?: CollaborationTeamRole;
    expiresInDays?: number;
  },
): Promise<{ id: string; channel: "EMAIL"; expiresAtUtc: string }> {
  const res = (await apiFetch(
    `${BASE}/${encodeURIComponent(teamId)}/invites/email`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  )) as {
    invite: { id: string; channel: "EMAIL"; expiresAtUtc: string };
  };
  return res.invite;
}

export async function revokeInvite(
  teamId: string,
  inviteId: string,
): Promise<void> {
  await apiFetch(
    `${BASE}/${encodeURIComponent(teamId)}/invites/${encodeURIComponent(inviteId)}/revoke`,
    { method: "POST" },
  );
}

/**
 * Result of accepting an invite token.
 *
 * Entitlement Alignment (2026-07-14): when the caller is ALREADY an
 * active member of the team the endpoint returns a SUCCESS shape with
 * `alreadyMember: true` (no new membership row; `memberId` may be
 * absent). Fresh joins return `alreadyMember` absent/false plus the
 * new `memberId`.
 */
export type CollaborationTeamInviteAcceptResult = {
  teamId: string;
  memberId?: string;
  alreadyMember?: boolean;
};

/**
 * Accept an invite token. The token is sent in the URL path and is
 * never logged client-side. On success returns the team id (plus the
 * member id for fresh joins) for redirect.
 */
export async function acceptInvite(
  rawToken: string,
): Promise<CollaborationTeamInviteAcceptResult> {
  return (await apiFetch(
    `/v1/collaboration-team-invites/${encodeURIComponent(rawToken)}/accept`,
    { method: "POST" },
  )) as CollaborationTeamInviteAcceptResult;
}

export async function listActivity(
  teamId: string,
  opts?: { limit?: number; cursor?: string | null },
): Promise<{
  items: ReadonlyArray<CollaborationTeamActivityItem>;
  nextCursor: string | null;
}> {
  const params: string[] = [];
  if (opts?.limit) params.push(`limit=${opts.limit}`);
  if (opts?.cursor) params.push(`cursor=${encodeURIComponent(opts.cursor)}`);
  const qs = params.length ? `?${params.join("&")}` : "";
  return (await apiFetch(
    `${BASE}/${encodeURIComponent(teamId)}/activity${qs}`,
  )) as {
    items: CollaborationTeamActivityItem[];
    nextCursor: string | null;
  };
}

export async function listAssignments(
  teamId: string,
  opts?: { status?: CollaborationTeamAssignmentStatus | null },
): Promise<ReadonlyArray<CollaborationTeamAssignment>> {
  const qs = opts?.status ? `?status=${encodeURIComponent(opts.status)}` : "";
  const res = (await apiFetch(
    `${BASE}/${encodeURIComponent(teamId)}/assignments${qs}`,
  )) as { assignments: CollaborationTeamAssignment[] };
  return res.assignments;
}

export async function createAssignment(
  teamId: string,
  input: {
    targetType: CollaborationTeamAssignmentTarget;
    targetId: string;
    assigneeUserId?: string | null;
    priority?: CollaborationTeamAssignmentPriority;
    dueAtUtc?: string | null;
    note?: string | null;
  },
): Promise<{ id: string }> {
  const res = (await apiFetch(
    `${BASE}/${encodeURIComponent(teamId)}/assignments`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  )) as { assignment: { id: string } };
  return res.assignment;
}

export async function updateAssignment(
  teamId: string,
  assignmentId: string,
  input: {
    status?: CollaborationTeamAssignmentStatus;
    priority?: CollaborationTeamAssignmentPriority;
    assigneeUserId?: string | null;
    dueAtUtc?: string | null;
    note?: string | null;
  },
): Promise<void> {
  await apiFetch(
    `${BASE}/${encodeURIComponent(teamId)}/assignments/${encodeURIComponent(assignmentId)}`,
    {
      method: "PATCH",
      body: JSON.stringify(input),
    },
  );
}
