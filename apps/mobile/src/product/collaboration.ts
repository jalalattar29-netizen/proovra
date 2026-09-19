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
