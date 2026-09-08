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
  /**
   * Cross-group operational signal, counted server-side per row.
   *
   * The list could say how many groups existed and nothing about how any of
   * them were doing — so supervising twenty groups meant opening twenty.
   */
  overdueAssignmentCount: number;
  highPriorityAssignmentCount: number;
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
  /**
   * WCR-08 (2026-09-07) — THE AUTHORITATIVE COUNTS, WHICH THE SERVER HAS
   * ALWAYS SENT AND THIS TYPE NEVER DECLARED.
   *
   * `members` below is a BOUNDED PREVIEW of at most `memberPreviewLimit`
   * rows. The console computed "how many members are there?" and "is this
   * group at capacity?" by filtering that array — so above the preview limit
   * the header under-reported, the tab title under-reported, and `atCapacity`
   * stayed false past the real ceiling, leaving "Add member" enabled until the
   * server refused it.
   *
   * A bounded preview is never an authoritative population. These two fields
   * are the population; `members` is the first page of it.
   */
  activeMemberCount: number;
  pendingInviteCount: number;
  memberPreviewLimit: number;
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

/**
 * The record an assignment points at, resolved by the SERVER at read time.
 *
 * Never stored on the assignment: a case renamed on `/cases` reads as renamed
 * here the moment it changes. `resolved: false` means the record could not be
 * read in this workspace — deleted, or a legacy row written before targets
 * were validated — and the surface says so instead of inventing a title.
 */
export type CollaborationTeamAssignmentTargetView = {
  resolved: boolean;
  label: string | null;
  sublabel: string | null;
  /** The canonical record's own state — case status, evidence status, review status. */
  state: string | null;
  /** REVIEW only. Projected read-only from the canonical review workflow. */
  review: {
    slaStatus: string | null;
    dueAtUtc: string | null;
    escalationLevel: number;
  } | null;
};

export type CollaborationTeamAssignment = {
  id: string;
  targetType: CollaborationTeamAssignmentTarget;
  targetId: string;
  target: CollaborationTeamAssignmentTargetView;
  assigneeUserId: string | null;
  assignedByUserId: string;
  status: CollaborationTeamAssignmentStatus;
  priority: CollaborationTeamAssignmentPriority;
  dueAtUtc: string | null;
  /** SERVER-derived against the server's clock, so the list, the filter and the Overview agree. */
  overdue: boolean;
  note: string | null;
  createdAt: string;
  updatedAt: string;
  completedAtUtc: string | null;
};

/** The sentinel the Work filter uses to ask for team-level (unassigned) rows. */
export const ASSIGNEE_UNASSIGNED = "UNASSIGNED";

/**
 * The group's operational snapshot. Every number is counted by the database;
 * the surface renders them and derives nothing.
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
  members: { active: number; suspended: number; managers: number };
  workload: ReadonlyArray<{ userId: string; open: number; overdue: number }>;
  /**
   * The group members' EVIDENCE-REVIEW load, projected from the canonical
   * `ReviewerWorkloadSnapshot` rows that `/v1/reviewer-ops/workload` serves.
   * Not a second measurement — the same rows, narrowed to this group.
   *
   * `null` means the snapshot pass has produced nothing for anyone in this
   * group: UNKNOWN, not "everybody is free". Render it as unknown. A reviewer
   * with no snapshot and a reviewer with an empty queue are not the same
   * person, and only one of them is safe to load up.
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

/** One group's responsibility for a record, read from the RECORD's side. */
export type TeamResponsibility = {
  id: string;
  teamId: string;
  teamName: string;
  teamStatus: string;
  assigneeUserId: string | null;
  status: CollaborationTeamAssignmentStatus;
  priority: CollaborationTeamAssignmentPriority;
  dueAtUtc: string | null;
  overdue: boolean;
  note: string | null;
  createdAt: string;
};

// =============================================================================
// API functions
// =============================================================================

const BASE = "/v1/collaboration-teams";

export type CollaborationTeamPage = {
  teams: ReadonlyArray<CollaborationTeamSummary>;
  nextCursor: string | null;
  /**
   * Active groups matching the requested SCOPE, regardless of the current
   * filter. Under `PARTICIPATING` that is the viewer's own memberships.
   *
   * WCR-05 — NOT a capacity number, and it was read as one. Capacity comes
   * from `collaborationTeams.used` on the entitlement projection, which is
   * always workspace-wide; a member of one of a workspace's two groups was
   * shown "1 of 2" and given an enabled Create button that met a 409.
   */
  totalActive: number;
  /** Every ACTIVE group in the WORKSPACE, whoever is in them. */
  workspaceTotalActive: number;
  /** Which scope the server actually GRANTED, which may be narrower than asked. */
  scope: "PARTICIPATING" | "ALL";
  /** Whether this actor may ask for the workspace-wide directory at all. */
  canGovernWorkspace: boolean;
  /**
   * THE WORKSPACE-WIDE POSITION — every group, not the page.
   *
   * Present only for a caller the server granted the `ALL` scope to; `null`
   * for everyone else. Every number is computed from the workspace, so it does
   * not move as the operator pages or narrows the search — which is exactly
   * why it is separate from the per-row counts beside it.
   */
  rollup: CollaborationWorkspaceRollup | null;
};

/** @see CollaborationTeamPage.rollup */
export type CollaborationWorkspaceRollup = {
  groups: { active: number; withOpenWork: number };
  work: {
    open: number;
    unassigned: number;
    overdue: number;
    highPriority: number;
    /** Overdue OR high-priority, counted as DISTINCT rows — never a sum. */
    attention: number;
    dueSoon: number;
  };
  workload: {
    people: number;
    busiest: { userId: string; open: number; overdue: number } | null;
  };
};

/**
 * One page of groups.
 *
 * `search` goes to the DATABASE. The page used to filter and sort an
 * already-fetched array, and the array was whatever fitted under a hard
 * server-side cap of 100 — so on a larger workspace, searching could not find a
 * group that existed and the truncation was silent.
 */
export async function listTeams(opts?: {
  includeArchived?: boolean;
  search?: string | null;
  limit?: number;
  cursor?: string | null;
  /**
   * WCR-6A — ask for the workspace-wide directory instead of your own groups.
   *
   * The server GRANTS this only to an actor holding the workspace governance
   * capability and silently degrades to the participation view otherwise, so
   * a client may always ask. `scope` on the response says which one came back.
   */
  scope?: "PARTICIPATING" | "ALL";
}): Promise<CollaborationTeamPage> {
  const qs = new URLSearchParams();
  if (opts?.scope === "ALL") qs.set("scope", "all");
  if (opts?.includeArchived) qs.set("includeArchived", "true");
  if (opts?.search?.trim()) qs.set("q", opts.search.trim());
  if (opts?.limit) qs.set("limit", String(opts.limit));
  if (opts?.cursor) qs.set("cursor", opts.cursor);
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return (await apiFetch(`${BASE}${suffix}`)) as CollaborationTeamPage;
}

export type CollaborationEntitlement = {
  workspaceId: string;
  workspaceKind: string;
  plan: string;
  featureIncluded: boolean;
  mutationsAllowed: boolean;
  lifecycle: {
    state: string;
    reasonCode: string | null;
    graceEndsAtUtc: string | null;
  };
  workspaceSeats: {
    limit: number;
    used: number;
    remaining: number;
    overLimit: boolean;
    source: string;
  };
  collaborationTeams: {
    limit: number;
    /** ACTIVE groups in the WORKSPACE — never the viewer's own memberships. */
    used: number;
    remaining: number;
    overLimit: boolean;
    source: string;
  };
  collaborationTeamMembers: { limit: number; source: string };
  invitations: { pending: number; maxPending: number; maxPer24h: number };
  /**
   * Server-decided affordances. The console renders these; it does not derive
   * them from a plan name, a loaded page length or a raw column.
   */
  canCreateCollaborationTeam: boolean;
  canInviteWorkspaceMember: boolean;
  canAssignExistingMember: boolean;
  governance: { canViewAllTeams: boolean; allTeamsCount: number };
  exceededDimensions: ReadonlyArray<string>;
  upgradeHref: string | null;
};

/**
 * THE commercial projection. The surface renders these answers; it does not
 * compute a limit from a plan name or a raw column.
 */
export async function getCollaborationEntitlement(): Promise<CollaborationEntitlement> {
  return (await apiFetch(`${BASE}/entitlement`)) as CollaborationEntitlement;
}

export type EligibleWorkspaceMember = {
  userId: string;
  displayName: string;
  email: string | null;
  avatarUrl: string | null;
  workspaceRole: string;
};

/** Active workspace members not yet in this group — the directory it is built from. */
export async function listEligibleMembers(
  teamId: string,
  opts?: { search?: string | null; limit?: number; cursor?: string | null },
): Promise<{
  members: ReadonlyArray<EligibleWorkspaceMember>;
  nextCursor: string | null;
}> {
  const qs = new URLSearchParams();
  if (opts?.search?.trim()) qs.set("q", opts.search.trim());
  if (opts?.limit) qs.set("limit", String(opts.limit));
  if (opts?.cursor) qs.set("cursor", opts.cursor);
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return (await apiFetch(
    `${BASE}/${encodeURIComponent(teamId)}/eligible-members${suffix}`,
  )) as {
    members: EligibleWorkspaceMember[];
    nextCursor: string | null;
  };
}

export type CollaborationTeamMemberPage = {
  members: ReadonlyArray<{
    id: string;
    userId: string;
    role: CollaborationTeamRole;
    status: CollaborationTeamMemberStatus;
    joinedAt: string;
    suspendedAt: string | null;
    removedAt: string | null;
    displayName: string;
    email: string | null;
    avatarUrl: string | null;
  }>;
  nextCursor: string | null;
  totalActive: number;
};

/** One page of a group's membership, searched and filtered by the database. */
export async function listTeamMembers(
  teamId: string,
  opts?: {
    search?: string | null;
    status?: string | null;
    role?: string | null;
    limit?: number;
    cursor?: string | null;
  },
): Promise<CollaborationTeamMemberPage> {
  const qs = new URLSearchParams();
  if (opts?.search?.trim()) qs.set("q", opts.search.trim());
  if (opts?.status) qs.set("status", opts.status);
  if (opts?.role) qs.set("role", opts.role);
  if (opts?.limit) qs.set("limit", String(opts.limit));
  if (opts?.cursor) qs.set("cursor", opts.cursor);
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return (await apiFetch(
    `${BASE}/${encodeURIComponent(teamId)}/members${suffix}`,
  )) as CollaborationTeamMemberPage;
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

/**
 * THE `as` CAST WAS DOING THE LYING.
 *
 * `GET /v1/collaboration-teams/:teamId` shares its path prefix with the
 * STATIC `GET /v1/collaboration-teams/entitlement`, and Fastify's router
 * prefers a static segment over a parametric one. So `getTeam("entitlement")`
 * returned `200 OK` carrying an entitlement projection — an object with no
 * `team` key at all. The cast asserted otherwise, `res.team` evaluated to
 * `undefined`, nothing threw, and the detail page rendered "Couldn't load
 * team" with no request id because there had been no error to carry one.
 *
 * That is reachable from the address bar: `/collaboration-teams/entitlement`
 * is matched by the `[teamId]` segment. A shape mismatch must fail loudly at
 * the boundary that knows the contract rather than surface three layers up as
 * a mystery empty state.
 */
export async function getTeam(
  teamId: string,
): Promise<CollaborationTeamDetail & { viaWorkspaceGovernance: boolean }> {
  const res = (await apiFetch(`${BASE}/${encodeURIComponent(teamId)}`)) as {
    team?: CollaborationTeamDetail;
    viaWorkspaceGovernance?: boolean;
  };
  if (!res || typeof res !== "object" || !res.team) {
    throw new Error(
      "The response for this team did not contain a team. The link may not point at a team.",
    );
  }
  // The SERVER says whether this read came through workspace governance rather
  // than group membership. The surface renders it as a stated read-only state;
  // it never infers it from an empty role or a missing action.
  return {
    ...res.team,
    viaWorkspaceGovernance: res.viaWorkspaceGovernance === true,
  };
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

/**
 * Whether this group can be permanently deleted, and what stops it.
 *
 * The SERVER decides. Emptiness is a property of rows the browser cannot see —
 * assignments, discussion, access reviews, guests, real activity — so a client
 * that computed it would be guessing. Read before offering the control, never
 * inferred from a failed DELETE: teaching a destructive limit by letting the
 * operator hit it is exactly what §15.28 rules out.
 */
export type CollaborationTeamDisposability = {
  disposable: boolean;
  /** The history that blocks deletion, by kind. Empty when disposable. */
  blockers: ReadonlyArray<{ kind: string; count: number }>;
};

export async function getTeamDisposability(
  teamId: string,
): Promise<CollaborationTeamDisposability> {
  const res = (await apiFetch(
    `${BASE}/${encodeURIComponent(teamId)}/disposability`,
  )) as { disposition?: CollaborationTeamDisposability } | null;
  return res?.disposition ?? { disposable: false, blockers: [] };
}

/**
 * Permanently delete a group that carries no operational record.
 *
 * The server re-checks disposability inside its transaction and answers 409
 * `TEAM_NOT_DISPOSABLE` for a group with history — this is the accidental-
 * creation path, not a way to erase work. Archiving remains the action for a
 * group that has done any, and it already frees the capacity slot, so deletion
 * is never the route to more capacity.
 */
export async function deleteTeam(teamId: string): Promise<void> {
  await apiFetch(`${BASE}/${encodeURIComponent(teamId)}`, { method: "DELETE" });
}

/**
 * WCR-13 — reopen an archived group.
 *
 * Archiving was one-way while the confirmation dialog promised it was not.
 * Capacity is re-checked server-side: an archived group frees a plan slot, so
 * reopening competes with creating.
 */
export async function unarchiveTeam(teamId: string): Promise<void> {
  await apiFetch(`${BASE}/${encodeURIComponent(teamId)}/unarchive`, {
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

/**
 * Add SEVERAL existing workspace members to a group in one request.
 *
 * The picker accepted one radio-button selection per submit, so building a
 * group of twelve meant twelve round trips — unusable on a workspace where
 * people arrive in SSO/SCIM cohorts.
 *
 * The server loops the canonical single-member writer rather than batching, so
 * every person still gets their own authorization check, their own
 * parent-workspace membership check, their own plan-limit evaluation and their
 * own audit event. Partial success is reported, never hidden: one refusal must
 * not discard the additions that worked.
 */
export async function addExistingMembersBulk(
  teamId: string,
  input: { userIds: ReadonlyArray<string>; role?: CollaborationTeamRole },
): Promise<{
  added: ReadonlyArray<string>;
  failed: ReadonlyArray<{ userId: string; reason: string }>;
}> {
  const res = (await apiFetch(
    `${BASE}/${encodeURIComponent(teamId)}/members/bulk`,
    { method: "POST", body: JSON.stringify(input) },
  )) as {
    added?: string[];
    failed?: Array<{ userId: string; reason: string }>;
  };
  return { added: res.added ?? [], failed: res.failed ?? [] };
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

// WCR-24 (2026-09-07) — `inviteByEmail` DELETED.
//
// It posted to the per-group email-invite endpoint, which has answered a
// typed 410 since the
// per-group invitation writer was removed: a group is built from people who
// already hold workspace access, so it has nothing to invite. The function had
// no caller, and keeping a client for a retired endpoint is how one comes back.
//
// The two real operations are `POST /v1/teams/:id/invites` (bring the person
// into the WORKSPACE) and `addExistingMember` (assign them to the group).

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

/**
 * One PAGE of a group's assignments.
 *
 * The server used to truncate at two hundred with nothing in the response to
 * say so, and this returned a bare array that could not have carried the fact
 * anyway. It now returns the page, the cursor for the next one and the true
 * total, so a surface can say "showing 50 of 380" instead of quietly showing
 * an incomplete list as if it were complete.
 */
export async function listAssignments(
  teamId: string,
  opts?: {
    status?: CollaborationTeamAssignmentStatus | null;
    /** CASE | EVIDENCE | REVIEW */
    targetType?: CollaborationTeamAssignmentTarget | null;
    priority?: CollaborationTeamAssignmentPriority | null;
    /** A member's user id, or `ASSIGNEE_UNASSIGNED` for team-level work. */
    assignee?: string | null;
    /*
      `overdueOnly` is gone with the Work tab toggle that was its only caller.
      The SERVER still accepts `?overdue=true` and still computes overdue on
      every row — the metric, the red marker and the Overview attention count
      are untouched. What is removed is a client option nothing passes, which
      the next reader would otherwise have to prove dead before touching it.
    */
    /** Matches the assignment note or the assigned record's own name. */
    search?: string | null;
    limit?: number;
    cursor?: string | null;
  },
): Promise<{
  assignments: ReadonlyArray<CollaborationTeamAssignment>;
  nextCursor: string | null;
  total: number;
}> {
  const qs = new URLSearchParams();
  if (opts?.status) qs.set("status", opts.status);
  // EVERY filter goes to the server. The surface used to narrow the page it
  // already held, which on a group with more work than one page hides rows and
  // counts only what happened to be loaded.
  if (opts?.targetType) qs.set("targetType", opts.targetType);
  if (opts?.priority) qs.set("priority", opts.priority);
  if (opts?.assignee) qs.set("assignee", opts.assignee);
  if (opts?.search?.trim()) qs.set("q", opts.search.trim());
  if (opts?.limit) qs.set("limit", String(opts.limit));
  if (opts?.cursor) qs.set("cursor", opts.cursor);
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  const res = (await apiFetch(
    `${BASE}/${encodeURIComponent(teamId)}/assignments${suffix}`,
  )) as {
    assignments: CollaborationTeamAssignment[];
    nextCursor: string | null;
    total: number;
  };
  return {
    assignments: res.assignments,
    nextCursor: res.nextCursor ?? null,
    total: res.total ?? res.assignments.length,
  };
}

/**
 * The group's operational snapshot — counted server-side.
 *
 * Overview used to compute its health rows from the detail payload's member
 * and invite arrays, which are BOUNDED PREVIEWS. This is the same question
 * asked of the database, so it stays exact at any group size.
 */
export async function getTeamOverview(
  teamId: string,
): Promise<CollaborationTeamOverview> {
  const res = (await apiFetch(
    `${BASE}/${encodeURIComponent(teamId)}/overview`,
  )) as { overview: CollaborationTeamOverview };
  return res.overview;
}

/**
 * Which Collaboration Teams are responsible for a canonical record.
 *
 * The REVERSE read of the one group-responsibility authority — the same rows
 * the Work tab lists, keyed by the record instead of by the group. There is no
 * second store and no second writer behind this.
 *
 * It never grants access: the caller is already reading a record they can
 * reach, and this only says who is coordinating it.
 */
export async function listTeamResponsibility(input: {
  targetType: CollaborationTeamAssignmentTarget;
  targetId: string;
}): Promise<ReadonlyArray<TeamResponsibility>> {
  const qs = new URLSearchParams({
    targetType: input.targetType,
    targetId: input.targetId,
  });
  const res = (await apiFetch(`${BASE}/responsibility?${qs.toString()}`)) as {
    assignments: TeamResponsibility[];
  };
  return res.assignments ?? [];
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

export type AssignableTarget = {
  id: string;
  label: string;
  sublabel: string | null;
  status: string;
};

/**
 * The records a group may be assigned, from THIS workspace.
 *
 * Replaces asking the operator to paste a uuid copied out of another page's
 * URL. The server offers only what its own write path will accept.
 */
export async function listAssignableTargets(
  teamId: string,
  targetType: CollaborationTeamAssignmentTarget,
  opts?: { search?: string | null; limit?: number },
): Promise<{ targets: ReadonlyArray<AssignableTarget> }> {
  const qs = new URLSearchParams({ type: targetType });
  if (opts?.search?.trim()) qs.set("q", opts.search.trim());
  if (opts?.limit) qs.set("limit", String(opts.limit));
  return (await apiFetch(
    `${BASE}/${encodeURIComponent(teamId)}/assignable-targets?${qs.toString()}`,
  )) as { targets: AssignableTarget[] };
}
