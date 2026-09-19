/**
 * CANONICAL NATIVE COLLABORATION (Master Program §15, N4) — pure logic.
 *
 * PRO/TEAM collaboration is reachable on the backend via GET /v1/collaboration-
 * teams, which resolves the active workspace from the session (no teamId param)
 * and returns { teams: CollaborationTeamSummaryRow[], nextCursor }. A workspace
 * without the collaboration capability answers 403 — the screen renders an honest
 * "not available" state rather than the old dead "managed on web" stub.
 *
 * These pure helpers parse the envelope and build display strings; the RN screen
 * is a thin shell. Fields mirror collaboration-team.service.ts CollaborationTeamSummaryRow.
 */
import { humanizeEnum } from "./domain-display";

export interface CollaborationTeamRow {
  id: string;
  name: string;
  description?: string | null;
  memberCount?: number | null;
  pendingInviteCount?: number | null;
  openAssignmentCount?: number | null;
  viewerRole?: string | null;
  status?: string | null;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Parse the list envelope defensively: reads `teams[]`, keeps only valid rows. */
export function parseCollaborationTeams(data: unknown): CollaborationTeamRow[] {
  const d = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  const rows = Array.isArray(d["teams"]) ? (d["teams"] as CollaborationTeamRow[]) : [];
  return rows.filter((r) => r && typeof r.id === "string" && typeof r.name === "string");
}

export function parseCollaborationNextCursor(data: unknown): string | null {
  const d = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  return typeof d["nextCursor"] === "string" ? (d["nextCursor"] as string) : null;
}

/** "3 members · 1 pending invite" — omits the pending clause when zero. */
export function collaborationTeamSubtitle(row: CollaborationTeamRow): string {
  const members = num(row.memberCount);
  const pending = num(row.pendingInviteCount);
  const parts = [`${members} member${members === 1 ? "" : "s"}`];
  if (pending > 0) parts.push(`${pending} pending invite${pending === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

/** Human role label for the viewer's role chip, or null when they have none. */
export function collaborationRoleLabel(role: string | null | undefined): string | null {
  return role ? humanizeEnum(role) : null;
}

/* --------------------------------------------------------------- Team detail */

export interface CollaborationMember {
  id: string;
  role: string;
  status: string;
  displayName: string;
  email: string | null;
}

export interface CollaborationInvite {
  id: string;
  email: string;
  role: string;
  status: string;
}

export interface CollaborationTeamDetail {
  id: string;
  name: string;
  description: string | null;
  status: string;
  viewerRole: string | null;
  activeMemberCount: number;
  pendingInviteCount: number;
  members: CollaborationMember[];
  invites: CollaborationInvite[];
}

function o(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}
function s(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
function nOr0(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Parse GET /v1/collaboration-teams/:id → { team } into the detail shape, or null. */
export function parseCollaborationTeamDetail(data: unknown): CollaborationTeamDetail | null {
  const team = o(o(data)["team"]);
  const id = s(team["id"]);
  const name = s(team["name"]);
  if (!id || !name) return null;
  const members: CollaborationMember[] = [];
  for (const raw of Array.isArray(team["members"]) ? (team["members"] as unknown[]) : []) {
    const m = o(raw);
    const mid = s(m["id"]);
    if (!mid) continue;
    const user = o(m["user"]);
    members.push({
      id: mid,
      role: s(m["role"]) ?? "",
      status: s(m["status"]) ?? "",
      displayName: s(user["displayName"]) ?? s(user["email"]) ?? "Member",
      email: s(user["email"]),
    });
  }
  const invites: CollaborationInvite[] = [];
  for (const raw of Array.isArray(team["invites"]) ? (team["invites"] as unknown[]) : []) {
    const inv = o(raw);
    const iid = s(inv["id"]);
    if (!iid) continue;
    invites.push({
      id: iid,
      email: s(inv["email"]) ?? "Invited",
      role: s(inv["role"]) ?? "",
      status: s(inv["status"]) ?? "",
    });
  }
  return {
    id,
    name,
    description: s(team["description"]),
    status: s(team["status"]) ?? "",
    viewerRole: s(team["viewerRole"]),
    activeMemberCount: nOr0(team["activeMemberCount"]),
    pendingInviteCount: nOr0(team["pendingInviteCount"]),
    members,
    invites,
  };
}
