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

// ---------------------------------------------------------------------------
// Entitlement and creation
// ---------------------------------------------------------------------------

/**
 * THE SERVER DECIDES THE AFFORDANCES; THE CLIENT RENDERS THEM.
 *
 * The entitlement envelope says so in its own words: "Server-decided
 * affordances. The browser renders these; it does not derive them. Each is the
 * same predicate its gate enforces, so an enabled control and a 2xx cannot
 * drift apart."
 *
 * The web console learned this the hard way — its own comment records a user
 * who "saw '1 of 2', got an enabled Create button, and met a 409" because the
 * console computed capacity itself. Native therefore computes nothing: it asks
 * whether it may create, and renders what it is told.
 */
export const COLLABORATION_ENTITLEMENT_PATH = "/v1/collaboration-teams/entitlement";

export const COLLABORATION_TEAMS_PATH = "/v1/collaboration-teams";

// The team types were a hand copy of the shared tuple, with nothing able to
// catch a drift. They are generated now, from the same source the API enum is
// built from. Re-exported so every existing import keeps working.
export { COLLABORATION_TEAM_TYPES, COLLABORATION_TEAM_ROLES } from "./domain-enums.generated";

export interface CollaborationEntitlement {
  canCreate: boolean;
  canInviteWorkspaceMember: boolean;
  teamsUsed: number | null;
  teamsLimit: number | null;
  /** Dimensions the workspace is currently over, named by the server. */
  exceededDimensions: string[];
  /** True when the plan does not include collaboration at all. */
  planLocked: boolean;
}

export function parseCollaborationEntitlement(payload: unknown): CollaborationEntitlement {
  const e = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  const teams = (e.teams && typeof e.teams === "object" ? e.teams : {}) as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

  const exceeded = Array.isArray(e.exceededDimensions)
    ? e.exceededDimensions.filter((x): x is string => typeof x === "string")
    : [];

  return {
    canCreate: e.canCreateCollaborationTeam === true,
    canInviteWorkspaceMember: e.canInviteWorkspaceMember === true,
    teamsUsed: n(teams.used),
    teamsLimit: n(teams.limit),
    exceededDimensions: exceeded,
    // A plan that does not include collaboration publishes no limit at all,
    // which is different from a limit that has been reached.
    planLocked: e.planLocked === true,
  };
}

/**
 * Why the create control is unavailable, in words, or null when it is.
 *
 * Never "you have reached your limit" derived from a count this client did the
 * arithmetic on — the server's own `canCreate` is the answer, and the counts
 * only explain it.
 */
export function createDisabledReason(
  entitlement: CollaborationEntitlement,
): string | null {
  if (entitlement.canCreate) return null;
  if (entitlement.planLocked) return "Collaboration groups are not included in this plan.";
  if (entitlement.exceededDimensions.includes("COLLABORATION_TEAMS")) {
    return entitlement.teamsLimit === null
      ? "This workspace has reached its collaboration group limit."
      : `This workspace is using all ${entitlement.teamsLimit} of its collaboration groups.`;
  }
  if (entitlement.exceededDimensions.includes("WORKSPACE_SEATS")) {
    return "This workspace is over its seat allowance.";
  }
  return "Creating a collaboration group is not available here.";
}

export function isValidTeamName(name: string): boolean {
  const v = name.trim();
  return v.length >= 1 && v.length <= 120;
}

export function buildCreateTeamBody(name: string, teamType: string, description?: string) {
  const body: Record<string, unknown> = { name: name.trim() };
  if (teamType) body.teamType = teamType;
  const d = (description ?? "").trim();
  if (d.length > 0) body.description = d;
  return body;
}

// ---------------------------------------------------------------------------
// WORK — the group's operational assignments
// ---------------------------------------------------------------------------
//
// GET   /v1/collaboration-teams/:teamId/assignments
//         ?status&targetType&priority&assignee&q&limit&cursor
// POST  /v1/collaboration-teams/:teamId/assignments
// PATCH /v1/collaboration-teams/:teamId/assignments/:assignmentId
//
// EVERY filter goes to the SERVER. The web tab's own comment records what
// happened when it did not: "The surface used to narrow the page it already
// held, which on a group with more work than one page hides rows and counts
// only what happened to be loaded." Native composes one query for the same
// reason, and pages on the same keyset cursor.
//
// The status, priority and target vocabularies are NOT retyped here. They are
// generated from `packages/shared` into `domain-enums.generated.ts`, so a new
// canonical status cannot exist and be missing natively.

import type { ProovraStatusTone } from "@proovra/ui";
import {
  COLLABORATION_TEAM_ASSIGNMENT_PRIORITIES,
  COLLABORATION_TEAM_ASSIGNMENT_STATUSES,
  COLLABORATION_TEAM_ASSIGNMENT_TARGETS,
  type CollaborationTeamAssignmentPriority,
  type CollaborationTeamAssignmentStatus,
  type CollaborationTeamAssignmentTarget,
} from "./domain-enums.generated";

export {
  COLLABORATION_TEAM_ASSIGNMENT_PRIORITIES,
  COLLABORATION_TEAM_ASSIGNMENT_STATUSES,
  COLLABORATION_TEAM_ASSIGNMENT_TARGETS,
};
export type {
  CollaborationTeamAssignmentPriority,
  CollaborationTeamAssignmentStatus,
  CollaborationTeamAssignmentTarget,
};

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};
const rows = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;
/**
 * Distinct from the `num` above, which answers 0 for an absent number.
 * A missing TOTAL is not a total of zero: it means the server did not say, and
 * a page summary that read "Showing 12 of 0" would be worse than none.
 */
const numOrNull = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/** The sentinel the Work filter uses to ask for team-level (unassigned) rows. */
export const ASSIGNEE_UNASSIGNED = "UNASSIGNED";

export interface AssignmentQuery {
  status?: string | null;
  targetType?: string | null;
  priority?: string | null;
  /** A member's user id, or ASSIGNEE_UNASSIGNED for team-level work. */
  assignee?: string | null;
  search?: string | null;
  limit?: number;
  cursor?: string | null;
}

export function buildAssignmentsPath(teamId: string, q: AssignmentQuery = {}): string {
  const p = new URLSearchParams();
  if (q.status) p.set("status", q.status);
  if (q.targetType) p.set("targetType", q.targetType);
  if (q.priority) p.set("priority", q.priority);
  if (q.assignee) p.set("assignee", q.assignee);
  if (q.search && q.search.trim()) p.set("q", q.search.trim());
  if (q.limit) p.set("limit", String(q.limit));
  if (q.cursor) p.set("cursor", q.cursor);
  const suffix = p.toString();
  return (
    `/v1/collaboration-teams/${encodeURIComponent(teamId)}/assignments` +
    (suffix ? `?${suffix}` : "")
  );
}

export function buildAssignmentPath(teamId: string, assignmentId: string): string {
  return (
    `/v1/collaboration-teams/${encodeURIComponent(teamId)}/assignments/` +
    encodeURIComponent(assignmentId)
  );
}

export interface AssignmentTargetView {
  resolved: boolean;
  label: string | null;
  sublabel: string | null;
  /** The canonical record's own state — case status, evidence status, review status. */
  state: string | null;
}

export interface TeamAssignment {
  id: string;
  targetType: string;
  targetId: string;
  target: AssignmentTargetView;
  assigneeUserId: string | null;
  status: string;
  priority: string;
  dueAtIso: string | null;
  /** SERVER-derived against the SERVER's clock. Never recomputed here. */
  overdue: boolean;
  note: string | null;
  updatedAtIso: string | null;
}

export interface AssignmentPage {
  assignments: TeamAssignment[];
  nextCursor: string | null;
  /**
   * The TRUE total for the current filter, not the page length.
   *
   * The endpoint used to truncate at two hundred with nothing in the response
   * to say so. A surface can now say "showing 50 of 380" instead of quietly
   * showing an incomplete list as if it were complete.
   */
  total: number | null;
}

export function parseAssignmentPage(payload: unknown): AssignmentPage {
  const d = obj(payload);
  const assignments = rows(d.assignments)
    .map((raw) => {
      const a = obj(raw);
      const id = str(a.id);
      if (!id) return null;
      const t = obj(a.target);
      return {
        id,
        targetType: str(a.targetType) ?? "",
        targetId: str(a.targetId) ?? "",
        target: {
          // `resolved: false` means the record could not be read in this
          // workspace. It is reported, not hidden and not guessed at.
          resolved: t.resolved === true,
          label: str(t.label),
          sublabel: str(t.sublabel),
          state: str(t.state),
        },
        assigneeUserId: str(a.assigneeUserId),
        status: str(a.status) ?? "OPEN",
        priority: str(a.priority) ?? "NORMAL",
        dueAtIso: str(a.dueAtUtc),
        overdue: a.overdue === true,
        note: str(a.note),
        updatedAtIso: str(a.updatedAt),
      };
    })
    .filter((a): a is TeamAssignment => a !== null);

  return {
    assignments,
    nextCursor: str(d.nextCursor),
    total: numOrNull(d.total),
  };
}

/**
 * What a row is FOR, when the record itself could not be read.
 *
 * An unresolved target is named as unavailable rather than rendered blank or
 * filled in from the id — an assignment whose case was deleted is still a real
 * assignment, and pretending the record is there would be worse than saying it
 * is not.
 */
export function assignmentTargetLabel(a: TeamAssignment): string {
  if (a.target.resolved && a.target.label) return a.target.label;
  return `${targetTypeLabel(a.targetType)} no longer available`;
}

export function targetTypeLabel(targetType: string): string {
  switch (targetType.toUpperCase()) {
    case "CASE":
      return "Case";
    case "EVIDENCE":
      return "Evidence";
    case "REVIEW":
      return "Review";
    default:
      return "Record";
  }
}

export function assignmentStatusLabel(status: string): string {
  const s = status.replace(/_/g, " ").toLowerCase();
  return s.length === 0 ? "Unknown" : s.charAt(0).toUpperCase() + s.slice(1);
}

export function assignmentStatusTone(status: string): ProovraStatusTone {
  switch (status.toUpperCase()) {
    case "COMPLETED":
      return "verified";
    case "IN_PROGRESS":
      return "pending";
    case "CANCELLED":
    case "REASSIGNED":
      return "neutral";
    default:
      return "neutral";
  }
}

export function assignmentPriorityLabel(priority: string): string {
  const s = priority.toLowerCase();
  return s.length === 0 ? "Normal" : s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Overdue is the SERVER's answer, and it is only meaningful while the work is
 * still open. A completed assignment that was late is history, not an alert.
 */
export function showsOverdue(a: TeamAssignment): boolean {
  const s = a.status.toUpperCase();
  return a.overdue && s !== "COMPLETED" && s !== "CANCELLED";
}

/** Terminal work is not transitioned again. */
export function assignmentIsTerminal(status: string): boolean {
  const s = status.toUpperCase();
  return s === "COMPLETED" || s === "CANCELLED" || s === "REASSIGNED";
}

export function buildAssignmentUpdateBody(input: {
  status?: string;
  priority?: string;
  assigneeUserId?: string | null;
  note?: string | null;
}) {
  const body: Record<string, unknown> = {};
  if (input.status) body.status = input.status;
  if (input.priority) body.priority = input.priority;
  // `null` is MEANINGFUL here — it makes the work team-level — so it is sent
  // when it is given, and the field is omitted only when it was not.
  if (input.assigneeUserId !== undefined) body.assigneeUserId = input.assigneeUserId;
  if (input.note !== undefined) body.note = input.note;
  return body;
}

/** "Showing 12 of 380" — the server's total, never the page length. */
export function assignmentPageSummary(loaded: number, total: number | null): string {
  if (total === null || total <= loaded) {
    return `${loaded} assignment${loaded === 1 ? "" : "s"}`;
  }
  return `Showing ${loaded} of ${total}`;
}

// ---------------------------------------------------------------------------
// SETTINGS — and the administrative activity history it carries
// ---------------------------------------------------------------------------
//
// PATCH  /v1/collaboration-teams/:teamId          { name, description, teamType }
// POST   /v1/collaboration-teams/:teamId/archive
// POST   /v1/collaboration-teams/:teamId/unarchive
// GET    /v1/collaboration-teams/:teamId/disposability
// DELETE /v1/collaboration-teams/:teamId
// GET    /v1/collaboration-teams/:teamId/activity?limit&cursor
//
// `updateTeam` supports EXACTLY { name, description, teamType }. The web tab
// says so in its own header and renders only sections with a real backing
// field; nothing here invents one either.

export function buildCollaborationTeamPath(teamId: string): string {
  return `/v1/collaboration-teams/${encodeURIComponent(teamId)}`;
}
export function buildTeamArchivePath(teamId: string): string {
  return `${buildCollaborationTeamPath(teamId)}/archive`;
}
export function buildTeamUnarchivePath(teamId: string): string {
  return `${buildCollaborationTeamPath(teamId)}/unarchive`;
}
/** The MEMBERSHIP a role change addresses, not the user. */
export function buildCollaborationMemberPath(teamId: string, memberId: string): string {
  return `${buildCollaborationTeamPath(teamId)}/members/${encodeURIComponent(memberId)}`;
}

export function buildTeamDisposabilityPath(teamId: string): string {
  return `${buildCollaborationTeamPath(teamId)}/disposability`;
}
export function buildTeamActivityPath(
  teamId: string,
  opts: { limit?: number; cursor?: string | null } = {},
): string {
  const p = new URLSearchParams({ limit: String(opts.limit ?? 25) });
  if (opts.cursor) p.set("cursor", opts.cursor);
  return `${buildCollaborationTeamPath(teamId)}/activity?${p.toString()}`;
}

export function buildTeamUpdateBody(input: {
  name: string;
  description: string;
  teamType: string;
}) {
  return {
    name: input.name.trim(),
    // An empty description is a CLEARED description, which is a real edit, so
    // it is sent as an empty string rather than omitted.
    description: input.description.trim(),
    teamType: input.teamType,
  };
}

export function validateTeamSettings(name: string): string | null {
  return isValidTeamName(name) ? null : "Give this team a name.";
}

export interface TeamDisposability {
  disposable: boolean;
  blockers: string[];
}

export function parseTeamDisposability(payload: unknown): TeamDisposability {
  const d = obj(obj(payload).disposition ?? payload);
  return {
    // Absent means NOT disposable. A default of "yes" on a permanent delete
    // would be the client deciding a destructive question the server owns.
    disposable: d.disposable === true,
    blockers: rows(d.blockers)
      .map((b) => (typeof b === "string" ? b : str(obj(b).message) ?? str(obj(b).code)))
      .filter((b): b is string => b !== null),
  };
}

/**
 * Deletion is the ACCIDENTAL-CREATION path, not a way to erase work.
 *
 * The server re-checks disposability inside its transaction and answers 409
 * TEAM_NOT_DISPOSABLE for a group with history. Archiving is the action for a
 * group that has done any — and archiving already frees the plan slot, so
 * deletion is never the route to more capacity. The surface says both.
 */
export const DELETE_TEAM_CONSEQUENCE =
  "This permanently deletes a group that has no work, no messages and no history. " +
  "It cannot be undone. Archiving is the action for a group that has done any work, " +
  "and archiving already frees the plan slot.";

export const ARCHIVE_TEAM_CONSEQUENCE =
  "The group stops being used for new work and its plan slot is freed. Its messages, " +
  "assignments and history are kept, and it can be reopened later.";

export interface TeamActivityItem {
  id: string;
  eventType: string;
  actorUserId: string | null;
  occurredAtIso: string | null;
}

export interface TeamActivityPage {
  items: TeamActivityItem[];
  nextCursor: string | null;
}

export function parseTeamActivity(payload: unknown): TeamActivityPage {
  const d = obj(payload);
  return {
    items: rows(d.items)
      .map((raw) => {
        const a = obj(raw);
        const id = str(a.id);
        if (!id) return null;
        return {
          id,
          eventType: str(a.eventType) ?? "unknown",
          actorUserId: str(a.actorUserId),
          occurredAtIso: str(a.createdAt),
        };
      })
      .filter((a): a is TeamActivityItem => a !== null),
    nextCursor: str(d.nextCursor),
  };
}

export function teamActivityLabel(eventType: string): string {
  const s = eventType.replace(/[._]/g, " ").trim();
  return s.length === 0 ? "Activity" : s.charAt(0).toUpperCase() + s.slice(1);
}

/** Only a LEAD administers the group; the web gates the whole tab on it. */
export function canAdministerTeam(role: string | null | undefined): boolean {
  return (role ?? "").toUpperCase() === "LEAD";
}
