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

export function buildWorkspaceMembersPath(teamId: string, cursor?: string | null): string {
  const base = `/v1/teams/${encodeURIComponent(teamId)}/members`;
  return cursor ? `${base}?cursor=${encodeURIComponent(cursor)}` : base;
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

  return {
    id: str(d.id),
    name: str(d.name),
    effectivePlan: str(d.effectivePlan),
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
        displayName: str(user.displayName) ?? email ?? "Unnamed member",
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
      };
    })
    .filter((c): c is WorkspaceCase => c !== null);
}

/** Cases not already linked, so the picker cannot offer a duplicate link. */
export function linkableCases(
  all: WorkspaceCase[],
  linked: WorkspaceCase[],
): WorkspaceCase[] {
  const have = new Set(linked.map((c) => c.id));
  return all.filter((c) => !have.has(c.id));
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

export function activityLabel(eventType: string): string {
  const s = eventType.replace(/[._]/g, " ").trim();
  return s.length === 0 ? "Activity" : s.charAt(0).toUpperCase() + s.slice(1);
}

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

/** Only the workspace OWNER may transfer ownership or close it. */
export function isWorkspaceOwner(overview: WorkspaceOverview): boolean {
  return (overview.currentUserRole ?? "").toUpperCase() === "OWNER";
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
