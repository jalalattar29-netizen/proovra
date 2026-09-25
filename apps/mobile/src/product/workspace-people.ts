/**
 * WORKSPACE PEOPLE — pure projections for the members-and-invitations surface.
 *
 * Ports `apps/web/app/(app)/teams/[id]/page.tsx` over `GET /v1/teams/:id`,
 * `GET /v1/teams/:id/members` and `GET|POST|DELETE /v1/teams/:id/invites`
 * (plus resend).
 *
 * ===========================================================================
 * WHY THIS SURFACE EXISTS AT ALL
 * ===========================================================================
 * A PRO workspace sells 5 seats and a TEAM workspace 10. Until this existed on
 * the device there was no in-product path to fill seats 2..n from a phone: the
 * web's own index was deleted and `/people` is a RESOLVER that answers the one
 * question navigation cannot — *which* workspace's people — and then gets out
 * of the way. Native has no URL bar, so without a destination the seats a
 * customer paid for were unreachable.
 *
 * `/people` and `/workspaces` are therefore not separate native screens. They
 * resolve to this one, keyed by the ACTIVE workspace.
 *
 * ===========================================================================
 * THE COUNTS ARE THE SERVER'S, NOT THE LIST'S
 * ===========================================================================
 * The detail read returns a BOUNDED first page of members plus the true total
 * — the web route's own comment records that `include: { members: true }` once
 * answered an Enterprise workspace's detail request with a thousand
 * memberships. So `memberCount` and the seat figures come from `stats`, never
 * from `members.length`. Counting the page would under-report every workspace
 * larger than one page and tell an owner they had seats they do not.
 *
 * Pure: no React, no react-native, no fetch.
 */
import type { ProovraStatusTone } from "@proovra/ui";

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};
const rows = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export function buildWorkspacePath(teamId: string): string {
  return `/v1/teams/${encodeURIComponent(teamId)}`;
}

/** T-12 — the roster filters the web sends (WorkspaceMembersPanel.tsx:91-157; teams.routes.ts:96-104). */
export type MemberStatusFilter = "ALL" | "ACTIVE" | "SUSPENDED";
export const MEMBER_STATUS_FILTERS: ReadonlyArray<{ value: MemberStatusFilter; label: string }> = [
  { value: "ALL", label: "All statuses" },
  { value: "ACTIVE", label: "Active" },
  { value: "SUSPENDED", label: "Suspended" },
];

export function buildWorkspaceMembersPath(
  teamId: string,
  cursor?: string | null,
  filter?: { status?: MemberStatusFilter; q?: string; limit?: number } | null,
): string {
  const base = `/v1/teams/${encodeURIComponent(teamId)}/members`;
  const p = new URLSearchParams();
  // "ALL" is omitted, as the web omits it; the server's default is every status.
  if (filter?.status && filter.status !== "ALL") p.set("status", filter.status);
  if (filter?.q && filter.q.trim()) p.set("q", filter.q.trim());
  if (filter?.limit) p.set("limit", String(filter.limit));
  if (cursor) p.set("cursor", cursor);
  const qs = p.toString();
  return qs ? `${base}?${qs}` : base;
}

/** The web's filtered-empty copy; admins can search by address too. */
export function rosterNoMatchCopy(canSeeEmail: boolean) {
  return {
    title: "Nobody here matches that",
    body: canSeeEmail ? "Try a different name, address or status." : "Try a different name or status.",
  };
}

export function buildWorkspaceInvitesPath(teamId: string): string {
  return `/v1/teams/${encodeURIComponent(teamId)}/invites`;
}

export function buildWorkspaceInvitePath(teamId: string, inviteId: string): string {
  return `/v1/teams/${encodeURIComponent(teamId)}/invites/${encodeURIComponent(inviteId)}`;
}

export function buildWorkspaceInviteResendPath(teamId: string, inviteId: string): string {
  return `${buildWorkspaceInvitePath(teamId, inviteId)}/resend`;
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

export interface WorkspaceSeats {
  memberCount: number;
  seatLimit: number | null;
  seatUsed: number | null;
  seatAvailable: number | null;
  storageUsedLabel: string | null;
  storageLimitLabel: string | null;
}

export interface WorkspaceOverview {
  id: string | null;
  name: string | null;
  /** The owner's user id (teams.routes.ts:763). */
  ownerUserId: string | null;
  /**
   * The owner's NAME, resolved from the embedded first member page the way the
   * web does (teams/[id]/page.tsx:659). Null when the owner is not on that
   * page — the Overview then omits the row rather than printing "unknown".
   */
  ownerLabel: string | null;
  /** stats.pendingInviteCount / stats.caseCount (teams.routes.ts:211-214). */
  pendingInviteCount: number | null;
  caseCount: number | null;
  effectivePlan: string | null;
  currentUserRole: string | null;
  canManageMembers: boolean;
  canManageWorkspace: boolean;
  seats: WorkspaceSeats;
  /** True when the detail's member page does not hold every member. */
  hasMoreMembers: boolean;
}

export function parseWorkspaceOverview(payload: unknown): WorkspaceOverview {
  const d = obj(payload);
  const stats = obj(d.stats);
  const page = obj(d.memberPage);

  const ownerUserId = str(d.ownerUserId);
  const owner = ownerUserId
    ? rows(d.members).map(obj).find((m) => str(m.userId) === ownerUserId) ?? null
    : null;
  const ownerUser = obj(owner?.user);
  return {
    id: str(d.id),
    name: str(d.name),
    ownerUserId,
    ownerLabel: owner ? str(ownerUser.displayName)?.trim() || str(ownerUser.email)?.trim() || null : null,
    pendingInviteCount: num(stats.pendingInviteCount),
    caseCount: num(stats.caseCount),
    // The web normalises the plan label (normalizePlanLabel) and never invents one.
    effectivePlan: str(d.effectivePlan)?.trim().toUpperCase() || null,
    currentUserRole: str(d.currentUserRole),
    canManageMembers: d.canManageMembers === true,
    canManageWorkspace: d.canManageWorkspace === true,
    seats: {
      // The server's count, never the length of the page it happened to send.
      memberCount: num(stats.memberCount) ?? 0,
      seatLimit: num(stats.seatLimit),
      seatUsed: num(stats.seatUsed),
      seatAvailable: num(stats.seatAvailable),
      storageUsedLabel: str(stats.storageUsedLabel),
      storageLimitLabel: str(stats.storageLimitLabel),
    },
    hasMoreMembers: page.hasMore === true,
  };
}

export interface WorkspaceMember {
  id: string;
  userId: string | null;
  role: string;
  status: string;
  displayName: string;
  email: string | null;
  joinedAtIso: string | null;
}

export interface MemberPage {
  members: WorkspaceMember[];
  total: number | null;
  nextCursor: string | null;
}

export function parseWorkspaceMembers(payload: unknown): MemberPage {
  const d = obj(payload);

  const members = rows(d.members)
    .map((raw) => {
      const m = obj(raw);
      const id = str(m.id);
      if (!id) return null;
      const user = obj(m.user);
      const email = str(user.email);
      return {
        id,
        userId: str(m.userId),
        role: str(m.role) ?? "MEMBER",
        status: str(m.status) ?? "ACTIVE",
        // A member with no display name is shown by email, and one with
        // neither is shown as an unnamed member — never as a blank row.
        // `label` is the server's own contact-safe fallback (teams.routes.ts:1031).
        displayName: str(user.displayName)?.trim() || email || str(m.label) || "Unnamed member",
        email,
        joinedAtIso: str(m.createdAt),
      };
    })
    .filter((m): m is WorkspaceMember => m !== null);

  return {
    members,
    total: num(d.total),
    nextCursor: str(d.nextCursor),
  };
}

export interface WorkspaceInvite {
  id: string;
  email: string;
  role: string;
  createdAtIso: string | null;
  expiresAtIso: string | null;
  lastResentAtIso: string | null;
}

export function parseWorkspaceInvites(payload: unknown): WorkspaceInvite[] {
  return rows(obj(payload).invites ?? payload)
    .map((raw) => {
      const i = obj(raw);
      const id = str(i.id);
      const email = str(i.email);
      if (!id || !email) return null;
      return {
        id,
        email,
        role: str(i.role) ?? "MEMBER",
        createdAtIso: str(i.createdAt),
        expiresAtIso: str(i.expiresAt),
        lastResentAtIso: str(i.lastResentAt),
      };
    })
    .filter((i): i is WorkspaceInvite => i !== null);
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

const ROLE_LABELS: Readonly<Record<string, string>> = {
  OWNER: "Owner",
  ADMIN: "Admin",
  MEMBER: "Member",
  VIEWER: "Viewer",
  REVIEWER: "Reviewer",
};

export function roleLabel(role: string): string {
  return ROLE_LABELS[role] ?? role.replace(/_/g, " ").toLowerCase();
}

export function memberStatusTone(status: string): ProovraStatusTone {
  switch (status.toUpperCase()) {
    case "ACTIVE":
      return "verified";
    case "INVITED":
    case "PENDING":
      return "pending";
    case "SUSPENDED":
    case "REVOKED":
      return "risk";
    default:
      return "neutral";
  }
}

/**
 * How many seats are left, stated only when the server gave enough to say it.
 *
 * `null` is not zero. A workspace whose plan publishes no seat limit has an
 * unknown allowance, and rendering "0 seats available" would tell an owner
 * they cannot invite anyone when in fact nobody has said so.
 */
export function seatsSummary(seats: WorkspaceSeats): string | null {
  if (seats.seatLimit === null || seats.seatUsed === null) return null;
  const available = seats.seatAvailable ?? Math.max(0, seats.seatLimit - seats.seatUsed);
  return `${seats.seatUsed} of ${seats.seatLimit} seats used · ${available} available`;
}

/** Whether an invitation may still be sent, from the server's own figures. */
export function canInviteMore(seats: WorkspaceSeats): boolean | null {
  if (seats.seatLimit === null || seats.seatUsed === null) return null;
  return (seats.seatAvailable ?? seats.seatLimit - seats.seatUsed) > 0;
}

/**
 * The invite roles a user may grant.
 *
 * An OWNER is not in the list: ownership moves by transfer, not by invitation,
 * and offering it here would produce a request the server refuses.
 */
export const INVITABLE_ROLES: ReadonlyArray<string> = ["ADMIN", "MEMBER", "VIEWER"];

/** A minimal, honest email check — the server is the authority. */
export function looksLikeEmail(value: string): boolean {
  const v = value.trim();
  return v.length >= 3 && v.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

// ---------------------------------------------------------------------------
// Role changes on an existing member
// ---------------------------------------------------------------------------
//
// PATCH /v1/teams/:id/members/:memberId  { role }
//
// The route resolves `:memberId` against `TeamMember.id` — the MEMBERSHIP, not
// the user (WCR-02). A row without one is refused here rather than sent to a
// URL that answers 404.

export function buildWorkspaceMemberPath(teamId: string, memberId: string): string {
  return `/v1/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(memberId)}`;
}

export function buildRoleChangeBody(role: string) {
  return { role };
}

/**
 * The roles a member can be MOVED to.
 *
 * OWNER is deliberately not among them, and it is the same absence as on the
 * invite list: ownership is not a role you assign, it is transferred, and a
 * dropdown that offered it would be offering a different action under the
 * wrong name.
 */
export const MANAGEABLE_ROLES: ReadonlyArray<string> = ["ADMIN", "MEMBER", "VIEWER"];

/**
 * Whether this member's role can be changed here.
 *
 * Not the owner (see above), not a row the server sent without a membership
 * id, and not a membership that is no longer active — changing the role of a
 * revoked member would look like restoring them, which it is not.
 */
export function canChangeRole(member: WorkspaceMember, canManage: boolean): boolean {
  return (
    canManage &&
    member.id.length > 0 &&
    member.role.toUpperCase() !== "OWNER" &&
    member.status.toUpperCase() === "ACTIVE"
  );
}

/**
 * What a role change actually did, read back from the RELOADED row.
 *
 * The web panel does this and says why: an accepted request is not a completed
 * change. If the reread shows a different role, saying "done" would be the
 * client asserting something the server just contradicted.
 */
export function describeRoleChange(
  member: WorkspaceMember,
  requested: string,
  reread: WorkspaceMember | null,
): { ok: boolean; message: string } {
  if (!reread) {
    return {
      ok: false,
      message:
        "The role change was accepted, but the member list could not be reloaded to confirm it.",
    };
  }
  if (reread.role.toUpperCase() !== requested.toUpperCase()) {
    return {
      ok: false,
      message:
        "The role change was accepted, but the reloaded list shows a different role. Reload before trying again.",
    };
  }
  return { ok: true, message: `${member.displayName} is now ${roleLabel(requested)}` };
}

// ---------------------------------------------------------------------------
// Linked cases
// ---------------------------------------------------------------------------
//
// GET    /v1/teams/:id/cases          (any member)
// POST   /v1/teams/:id/cases/link     (MEMBER+)  { caseId }
// DELETE /v1/teams/:id/cases/:caseId  (ADMIN+)
//
// Linking and unlinking are gated differently and the surface must not treat
// them as one permission: a MEMBER can bring a case into the workspace and
// cannot take one out again.

export function buildWorkspaceCasesPath(teamId: string): string {
  return `/v1/teams/${encodeURIComponent(teamId)}/cases`;
}

export function buildWorkspaceCaseLinkPath(teamId: string): string {
  return `${buildWorkspaceCasesPath(teamId)}/link`;
}

export function buildWorkspaceCaseUnlinkPath(teamId: string, caseId: string): string {
  return `${buildWorkspaceCasesPath(teamId)}/${encodeURIComponent(caseId)}`;
}

export interface WorkspaceCase {
  id: string;
  name: string;
  status: string | null;
  createdAtIso: string | null;
  /** The workspace the case is already linked to, if any (the full Case row GET /v1/cases returns). */
  teamId: string | null;
}

export function parseWorkspaceCases(payload: unknown): WorkspaceCase[] {
  return rows(obj(payload).items)
    .map((raw) => {
      const c = obj(raw);
      const id = str(c.id);
      if (!id) return null;
      return {
        id,
        name: str(c.name) ?? "Untitled case",
        status: str(c.status),
        createdAtIso: str(c.createdAt),
        teamId: str(c.teamId),
      };
    })
    .filter((c): c is WorkspaceCase => c !== null);
}

/**
 * Cases not already linked, so the picker cannot offer a duplicate link — and
 * not linked to ANY workspace: the link route refuses a case that already has
 * a `teamId` ("Case is already linked to a team", teams.routes.ts:2599), so the
 * web filters `!item.teamId` (teams/[id]/page.tsx:966) and so does this.
 */
export function linkableCases(
  all: WorkspaceCase[],
  linked: WorkspaceCase[],
): WorkspaceCase[] {
  const have = new Set(linked.map((c) => c.id));
  return all.filter((c) => !have.has(c.id) && !c.teamId);
}

/** ADMIN and above may unlink; a MEMBER may only link. */
export function canUnlinkCase(role: string): boolean {
  const r = role.toUpperCase();
  return r === "OWNER" || r === "ADMIN";
}

export function canLinkCase(role: string): boolean {
  const r = role.toUpperCase();
  return r === "OWNER" || r === "ADMIN" || r === "MEMBER";
}

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

export function buildWorkspaceActivityPath(teamId: string, limit = 50): string {
  return `/v1/teams/${encodeURIComponent(teamId)}/activity?limit=${limit}`;
}

export interface WorkspaceActivity {
  id: string;
  eventType: string;
  actorLabel: string | null;
  targetType: string | null;
  occurredAtIso: string | null;
}

export function parseWorkspaceActivity(payload: unknown): WorkspaceActivity[] {
  return rows(obj(payload).activities)
    .map((raw) => {
      const a = obj(raw);
      const id = str(a.id);
      if (!id) return null;
      const actor = obj(a.actor);
      return {
        id,
        eventType: str(a.eventType) ?? "unknown",
        // An id is not a person. When the server could not resolve the actor
        // the field stays null and the surface says so in words.
        actorLabel: str(actor.displayName) ?? str(actor.email),
        targetType: str(a.targetType),
        occurredAtIso: str(a.createdAt),
      };
    })
    .filter((a): a is WorkspaceActivity => a !== null);
}

/**
 * The web's activity vocabulary (teams/[id]/page.tsx:220). A stored eventType
 * is never shown raw; anything unmapped degrades to sentence case (lowercased
 * first, so a SHOUTY enum does not shout).
 */
const ACTIVITY_LABELS: Readonly<Record<string, string>> = {
  invite_created: "Invitation sent",
  invite_revoked: "Invitation revoked",
  invite_accepted: "Invitation accepted",
  member_added: "Person added",
  member_removed: "Person removed",
  member_role_changed: "Role changed",
  team_renamed: "Workspace renamed",
  case_linked: "Case linked",
  case_unlinked: "Case removed",
  DECISION_LOGGED: "Review decision recorded",
  STAGE_CHANGED: "Review stage changed",
  REVIEWER_NOTE_CREATED: "Reviewer note added",
  reviewer_governance_flags_updated: "Reviewer governance updated",
  reviewer_sla_policy_updated: "Reviewer SLA policy updated",
  workspace_closed: "Workspace closed",
  workspace_reopened: "Workspace reopened",
  workspace_suspended: "Workspace suspended",
  workspace_resumed: "Workspace resumed",
  workspace_ownership_transferred: "Ownership transferred",
  "integration.api_key.created": "API key created",
  "integration.api_key.revoked": "API key revoked",
  "integration.api_key.rotated": "API key rotated",
  "integration.api_key.expiry_changed": "API key expiry changed",
  "integration.webhook.secret_rotated": "Webhook secret rotated",
  "integration.webhook.test_sent": "Webhook test sent",
  "integration.webhook.delivery_retried": "Webhook delivery retried",
};

export function activityLabel(eventType: string): string {
  const mapped = ACTIVITY_LABELS[eventType];
  if (mapped) return mapped;
  const s = eventType.replace(/[._]/g, " ").trim().toLowerCase();
  return s.length === 0 ? "Activity" : s.charAt(0).toUpperCase() + s.slice(1);
}

/** "What — who", as the web's humanizeActivity writes it. */
export function describeActivity(a: WorkspaceActivity): string {
  const what = activityLabel(a.eventType);
  return a.actorLabel ? `${what} — ${a.actorLabel}` : what;
}

/**
 * The web's marker colour (activityTone): access gained, access removed, a
 * change to the workspace itself, review work. Never the only carrier of
 * meaning — the sentence beside it says what happened.
 */
export function activityTone(eventType: string): ProovraStatusTone {
  switch (eventType) {
    case "member_added":
    case "invite_accepted":
    case "workspace_reopened":
    case "workspace_resumed":
      return "verified";
    case "member_removed":
    case "invite_revoked":
    case "workspace_closed":
    case "workspace_suspended":
    case "integration.api_key.revoked":
      return "risk";
    case "member_role_changed":
    case "team_renamed":
    case "invite_created":
    case "workspace_ownership_transferred":
      return "governance";
    case "DECISION_LOGGED":
    case "STAGE_CHANGED":
    case "REVIEWER_NOTE_CREATED":
      return "info";
    default:
      return "neutral";
  }
}

/** The web shows the twelve most recent events (teams/[id]/page.tsx:1708). */
export const RECENT_ACTIVITY_LIMIT = 12;

// ---------------------------------------------------------------------------
// Renaming the workspace
// ---------------------------------------------------------------------------

export function buildRenameBody(name: string) {
  return { name: name.trim() };
}

export function validateWorkspaceName(name: string): string | null {
  const n = name.trim();
  if (n.length === 0) return "A workspace needs a name.";
  return null;
}

// ---------------------------------------------------------------------------
// Workspace lifecycle: ownership transfer and closure
// ---------------------------------------------------------------------------
//
// POST /v1/teams/:id/transfer-ownership  { newOwnerUserId, stepUp? }
// GET  /v1/teams/:id/closure
// POST /v1/teams/:id/closure             { confirmation, reason?, stepUp? }
// POST /v1/teams/:id/closure/:requestId/cancel
//
// The closure contract is the organization's, field for field, so its
// projection is NOT restated here — a surface that closes a workspace imports
// `./closure`. What IS workspace-specific is the transfer body: this route
// takes `newOwnerUserId`, where the organization route takes `targetUserId`.
// Two fields that mean the same thing and are spelled differently are exactly
// the kind of detail a shared helper would paper over, so each names its own.

export function buildWorkspaceTransferPath(teamId: string): string {
  return `/v1/teams/${encodeURIComponent(teamId)}/transfer-ownership`;
}

export function buildWorkspaceTransferBody(newOwnerUserId: string) {
  return { newOwnerUserId };
}

export function buildWorkspaceClosurePath(teamId: string): string {
  return `/v1/teams/${encodeURIComponent(teamId)}/closure`;
}

export function buildWorkspaceClosureCancelPath(teamId: string, requestId: string): string {
  return `${buildWorkspaceClosurePath(teamId)}/${encodeURIComponent(requestId)}/cancel`;
}

/**
 * Only the workspace OWNER may transfer ownership, close or delete it. The
 * server projects that as `canManageWorkspace` (teams.routes.ts:846), the
 * web's only authority (teams/[id]/page.tsx:561); the role is the fallback for
 * a response that predates the projection.
 */
export function isWorkspaceOwner(
  overview: Pick<WorkspaceOverview, "currentUserRole"> & { canManageWorkspace?: boolean },
): boolean {
  return overview.canManageWorkspace === true || (overview.currentUserRole ?? "").toUpperCase() === "OWNER";
}

/**
 * Who can be made owner.
 *
 * Active members other than the current owner, and only rows carrying a user
 * id — the route takes `newOwnerUserId`, so a row known only by its membership
 * cannot be offered. Handing a workspace to a suspended or revoked member is
 * the one transfer that must never be on the list.
 */
export function workspaceTransferTargets(members: WorkspaceMember[]): WorkspaceMember[] {
  return members.filter(
    (m) =>
      m.role.toUpperCase() !== "OWNER" &&
      m.status.toUpperCase() === "ACTIVE" &&
      m.userId !== null,
  );
}

/** The workspace lifecycle refusals, said as what happened. */
export function workspaceLifecycleFailureMessage(err: unknown, fallback: string): string {
  const e = obj(err);
  const code = str(obj(obj(e.body).error).code) ?? str(e.code);
  switch (code) {
    case "owner_required":
      return "Only the workspace owner can do this.";
    case "target_not_member":
      return "That person is no longer a member of this workspace.";
    case "transfer_to_self":
      return "You already own this workspace.";
    case "closure_blocked":
      return "Closure is blocked. Resolve the listed items and try again.";
    case "confirmation_mismatch":
      return "The confirmation phrase does not match.";
    case "closure_request_active":
      return "A closure request for this workspace is already open.";
    default:
      return fallback;
  }
}

// ---------------------------------------------------------------------------
// T-14 — removing a member (web MemberRemovalDialog):
//   GET    /v1/teams/:id/members/:memberId/removal-impact   (ADMIN+)
//   DELETE /v1/teams/:id/members/:memberId   [{ transferToUserId }]
// A member who owns active records cannot be removed without an ADMIN/OWNER
// transfer target; the transfer happens atomically with the removal.
// ---------------------------------------------------------------------------

export function buildMemberRemovalImpactPath(teamId: string, memberId: string): string {
  return `/v1/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(memberId)}/removal-impact`;
}
export function buildMemberRemovePath(teamId: string, memberId: string): string {
  return `/v1/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(memberId)}`;
}

export interface RemovalImpact {
  ownedEvidence: number;
  ownedCases: number;
  openAssignments: number;
  requiresTransfer: boolean;
  targets: Array<{ userId: string; label: string; role: string }>;
}

export function parseRemovalImpact(payload: unknown): RemovalImpact {
  const d = obj(payload);
  const i = obj(d.impact);
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    ownedEvidence: n(i.ownedEvidence),
    ownedCases: n(i.ownedCases),
    openAssignments: n(i.openAssignments),
    requiresTransfer: i.requiresTransfer === true,
    targets: rows(d.eligibleTransferTargets)
      .map(obj)
      .filter((t) => str(t.userId))
      .map((t) => ({
        userId: str(t.userId) as string,
        label: str(t.displayName)?.trim() || str(t.email) || `User ${(str(t.userId) as string).slice(0, 8)}`,
        role: str(t.role) ?? "",
      })),
  };
}

/** The web's rule: a manager may remove anyone but themself and the owner. */
export function canRemoveMember(m: WorkspaceMember, canManage: boolean, selfUserId: string | null): boolean {
  return canManage && Boolean(m.userId) && m.userId !== selfUserId && m.role.toUpperCase() !== "OWNER";
}

export function removalImpactFailure(status: number | null, fallback: string | null): string {
  if (status === 403) return "You don't have permission to view this member's removal impact.";
  if (status === 404) return "This member is no longer in the workspace — refresh the page.";
  return fallback ?? "Failed to load removal impact. Try again.";
}

export function removalFailure(code: string | null, status: number | null, fallback: string | null): string {
  if (code === "TRANSFER_TARGET_REQUIRED") return "This member still owns active records. Pick a transfer target above before removing.";
  if (code === "INVALID_TRANSFER_TARGET") return "That transfer target isn't eligible anymore — refresh and try again.";
  if (status === 403) return "You don't have permission to remove members from this workspace.";
  return fallback ?? "Failed to remove member.";
}

// ---------------------------------------------------------------------------
// Web parity (teams/[id]/page.tsx + components) — summary, invitations,
// ownership-transfer candidates, delete.
// ---------------------------------------------------------------------------

/** Seats left from the SERVER's projection; null means UNKNOWN (rendered "—"). */
export function seatsAvailable(seats: WorkspaceSeats): number | null {
  if (seats.seatAvailable !== null) return seats.seatAvailable;
  if (seats.seatLimit !== null && seats.seatUsed !== null) return Math.max(0, seats.seatLimit - seats.seatUsed);
  return null;
}

/** The web roster's status text (WorkspaceMembersPanel statusText). */
export function memberStatusLabel(status: string): string {
  const s = status.toUpperCase();
  if (s === "SUSPENDED") return "Suspended";
  if (s === "REVOKED") return "Access removed";
  return "Active";
}

/**
 * The pending-invitations read has three outcomes and only one is a list
 * (teams/[id]/page.tsx:106): a 403 is "refused", anything else "failed".
 */
export type InvitesReadState = "ready" | "refused" | "failed";
export function invitesReadFailure(err: unknown): InvitesReadState {
  return obj(err).statusCode === 403 ? "refused" : "failed";
}

/** Bounded copy for the resend route's WorkspaceInvitationError codes (teams/[id]/page.tsx:109). */
export const RESEND_ERROR_COPY: Readonly<Record<string, string>> = {
  INVITE_NOT_FOUND: "That invitation no longer exists. The list has been reloaded.",
  INVITE_NOT_PENDING:
    "That invitation was already accepted or revoked, so it cannot be resent. The list has been reloaded.",
};

export function resendErrorCopy(err: unknown): string | null {
  const e = obj(err);
  const code = (str(obj(obj(e.body).error).code) ?? str(e.code) ?? "").toUpperCase();
  return RESEND_ERROR_COPY[code] ?? null;
}

/**
 * What a resend did, said from the RE-READ list and the route's `emailSent`
 * (POST …/resend → { invite, emailSent }, teams.routes.ts:2441).
 */
export function resendOutcome(
  invite: { id: string; email: string },
  emailSent: boolean,
  reread: WorkspaceInvite[] | null,
): { tone: "success" | "warning" | "error"; message: string } {
  if (!reread) {
    return {
      tone: "error",
      message:
        "The invitation was resent, but the invitation list could not be reloaded to confirm it. Reload the page.",
    };
  }
  if (!reread.some((r) => r.id === invite.id)) {
    return {
      tone: "error",
      message:
        "The resend was accepted, but the reloaded list no longer shows this invitation. Reload before trying again.",
    };
  }
  if (emailSent) {
    return { tone: "success", message: `Invitation resent to ${invite.email}. The previous link no longer works.` };
  }
  return {
    tone: "warning",
    message: `A new invitation link was issued for ${invite.email}, but the email could not be delivered. The previous link no longer works; try resending later.`,
  };
}

/**
 * D46 — the ownership-transfer picker reads the SERVER's eligible list
 * (GET /v1/teams/:id/members?eligible=ownership_transfer&q&cursor&limit,
 * teams.routes.ts:975) instead of filtering the roster page on screen, so every
 * eligible member of a large workspace is reachable.
 */
export const TRANSFER_CANDIDATE_PAGE_SIZE = 50;

export function buildTransferCandidatesPath(teamId: string, q: string, cursor: string | null): string {
  const p = new URLSearchParams({ eligible: "ownership_transfer", limit: String(TRANSFER_CANDIDATE_PAGE_SIZE) });
  if (q.trim()) p.set("q", q.trim());
  if (cursor) p.set("cursor", cursor);
  return `/v1/teams/${encodeURIComponent(teamId)}/members?${p.toString()}`;
}

export interface TransferCandidate {
  userId: string;
  label: string;
}

export function parseTransferCandidates(
  payload: unknown,
  currentUserId: string | null,
): { rows: TransferCandidate[]; nextCursor: string | null; total: number } {
  const d = obj(payload);
  const list = rows(d.members)
    .map(obj)
    .filter((m) => str(m.userId) && str(m.userId) !== currentUserId)
    .map((m) => {
      const u = obj(m.user);
      return {
        userId: str(m.userId) as string,
        label: str(u.displayName)?.trim() || str(u.email) || str(m.label) || "Workspace member",
      };
    });
  return { rows: list, nextCursor: str(d.nextCursor), total: num(d.total) ?? list.length };
}

/** The transfer refusals by status (WorkspaceOwnershipTransferCard denialCopy). */
export function transferDenialCopy(err: unknown, fallback: string | null): string {
  const status = num(obj(err).statusCode) ?? 0;
  if (status === 403) return "You don't have permission to transfer this workspace. Only its owner can.";
  if (status === 404) return "This workspace no longer exists.";
  if (status === 409) {
    return "Ownership couldn't be transferred: a personal space can't change owners, an organization workspace is governed at the organization level, and the new owner must already be an active member of this workspace.";
  }
  if (status === 429) return "Too many verification attempts. Wait a minute and try again.";
  return fallback ?? "Could not transfer ownership. Nothing was changed.";
}

export function transferOutcome(targetLabel: string, teamName: string): string {
  return `${targetLabel || "the new owner"} now owns ${teamName}. Billing ownership moved with it; you remain a member.`;
}

/**
 * DELETE /v1/teams/:id — OWNER only; 204 on success. It refuses with 403
 * (not owner / LEGAL_HOLD_BLOCKED) or 409 with its own sentence (an active
 * subscription, evidence still in the workspace — teams.routes.ts:1290,1312).
 */
export function deleteWorkspaceFailure(err: unknown, fallback: string | null): string {
  const e = obj(err);
  const body = obj(e.body);
  if (str(body.denial) === "LEGAL_HOLD_BLOCKED") {
    return "This workspace is under a legal hold and cannot be deleted.";
  }
  return str(body.message) ?? fallback ?? "Failed to delete workspace";
}
