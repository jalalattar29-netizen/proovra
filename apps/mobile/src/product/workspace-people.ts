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
