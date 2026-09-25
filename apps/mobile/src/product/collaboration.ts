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
  overdueAssignmentCount?: number | null;
  highPriorityAssignmentCount?: number | null;
  viewerRole?: string | null;
  status?: string | null;
  /** T-12 — needed by the type filter and the activity sort. */
  teamType?: string | null;
  lastActivityAt?: string | null;
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

/**
 * "3 members · 5 open · 2 overdue · 1 high" — the web table's Members / Open
 * work / Overdue / High-urgent columns, as clauses that appear only when
 * non-zero (a phone row has no columns to leave blank).
 *
 * "Pending invites" is NOT a clause any more: the web dropped that column
 * (collaboration-teams/page.tsx:906) because it counted RETIRED
 * CollaborationTeamInvite rows — structurally zero since the writer was
 * removed, and misread as workspace invitations otherwise.
 */
export function collaborationTeamSubtitle(row: CollaborationTeamRow): string {
  const members = num(row.memberCount);
  const open = num(row.openAssignmentCount);
  const overdue = num(row.overdueAssignmentCount);
  const high = num(row.highPriorityAssignmentCount);
  const parts = [`${members} member${members === 1 ? "" : "s"}`];
  if (open > 0) parts.push(`${open} open`);
  if (overdue > 0) parts.push(`${overdue} overdue`);
  if (high > 0) parts.push(`${high} high`);
  return parts.join(" · ");
}

/**
 * The workspace ROLLUP band (collaboration-teams/page.tsx:492): present only on
 * a workspace-scoped response; a participation-scoped one carries null and the
 * band is hidden. Every number is the server's.
 */
export interface CollaborationRollupCard {
  key: "open" | "unassigned" | "attention" | "people";
  label: string;
  value: number;
  meta: string;
  tone: "info" | "governance" | "pending" | "risk";
}
export function parseCollaborationRollup(data: unknown): CollaborationRollupCard[] | null {
  const raw = o(data)["rollup"];
  if (!raw || typeof raw !== "object") return null;
  const groups = o(o(data)["rollup"])["groups"] as Record<string, unknown> | undefined ?? {};
  const work = o(o(o(data)["rollup"])["work"]);
  const load = o(o(o(data)["rollup"])["workload"]);
  const busiest = load["busiest"] ? o(load["busiest"]) : null;
  const g = o(groups);
  const active = num(g["active"]);
  const overdue = num(work["overdue"]);
  return [
    { key: "open", label: "Open work", value: num(work["open"]), meta: `across ${num(g["withOpenWork"])} of ${active} ${active === 1 ? "Team" : "Teams"}`, tone: "info" },
    { key: "unassigned", label: "Unassigned", value: num(work["unassigned"]), meta: "held by a Team, not by a person", tone: "governance" },
    { key: "attention", label: "Needs attention", value: num(work["attention"]), meta: `${overdue} overdue · ${num(work["highPriority"])} high priority`, tone: overdue > 0 ? "risk" : "pending" },
    {
      key: "people",
      label: "People carrying work",
      value: num(load["people"]),
      meta: busiest ? `heaviest load ${num(busiest["open"])} open` : "nothing assigned to an individual",
      tone: "info",
    },
  ];
}

/** Human role label for the viewer's role chip, or null when they have none. */
export function collaborationRoleLabel(role: string | null | undefined): string | null {
  return role ? humanizeEnum(role) : null;
}

/* --------------------------------------------------------------- Team detail */

export interface CollaborationMember {
  id: string;
  /** The PERSON — what an assignment names as its assignee. */
  userId: string | null;
  role: string;
  status: string;
  displayName: string;
  email: string | null;
  /** `joinedAt` (collaboration-team.service.ts:1073 / :2496). */
  joinedAtIso?: string | null;
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
  /**
   * The team's template. It was never read, so the Settings form started from
   * "GENERAL" and saving a rename silently re-typed every non-GENERAL team.
   */
  teamType: string;
  updatedAtIso: string | null;
  /** How many members the detail embeds; above it the roster is paged (web MembersTab :308). */
  memberPreviewLimit: number;
  /** Open work the team holds (`assignmentCount`), the Work tab's count. */
  assignmentCount: number;
  /** True when the viewer is here as a workspace governor, not a member (top-level on the reply). */
  viaWorkspaceGovernance: boolean;
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
      userId: s(m["userId"]),
      role: s(m["role"]) ?? "",
      status: s(m["status"]) ?? "",
      displayName:
        s(user["displayName"]) ??
        ([s(user["firstName"]), s(user["lastName"])].filter(Boolean).join(" ") || null) ??
        s(user["email"]) ??
        "Member",
      email: s(user["email"]),
      joinedAtIso: s(m["joinedAt"]),
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
    teamType: s(team["teamType"]) ?? "GENERAL",
    updatedAtIso: s(team["updatedAt"]),
    memberPreviewLimit: nOr0(team["memberPreviewLimit"]) || 25,
    assignmentCount: nOr0(team["assignmentCount"]),
    viaWorkspaceGovernance: o(data)["viaWorkspaceGovernance"] === true,
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

/* ------------------------------------------------ list filters (T-12) */

/**
 * The web list's four filters (collaboration-teams/page.tsx:699-766). SCOPE and
 * ARCHIVED go to the server (`scope=all` is granted only to governors; the
 * server says which view came back); status, type and sort apply to the page
 * in hand, exactly as the web applies them.
 */
export type TeamsScope = "PARTICIPATING" | "ALL";
export type TeamsStatusFilter = "ALL" | "ACTIVE" | "ARCHIVED";
export type TeamsSort = "ACTIVITY_DESC" | "ACTIVITY_ASC" | "NAME_ASC" | "MEMBERS_DESC";

export const TEAMS_SCOPE_OPTIONS: ReadonlyArray<{ value: TeamsScope; label: string }> = [
  { value: "ALL", label: "All workspace teams" },
  { value: "PARTICIPATING", label: "My teams" },
];
export const TEAMS_STATUS_OPTIONS: ReadonlyArray<{ value: TeamsStatusFilter; label: string }> = [
  { value: "ALL", label: "All statuses" },
  { value: "ACTIVE", label: "Active" },
  { value: "ARCHIVED", label: "Archived" },
];
export const TEAM_TYPE_LABELS: Readonly<Record<string, string>> = {
  GENERAL: "General",
  INVESTIGATION: "Investigation",
  LEGAL: "Legal",
  REVIEW: "Review",
  COMPLIANCE: "Compliance",
};
export const TEAMS_SORT_OPTIONS: ReadonlyArray<{ value: TeamsSort; label: string }> = [
  { value: "ACTIVITY_DESC", label: "Last activity (newest)" },
  { value: "ACTIVITY_ASC", label: "Last activity (oldest)" },
  { value: "NAME_ASC", label: "Name (A–Z)" },
  { value: "MEMBERS_DESC", label: "Most members" },
];

export function buildCollaborationTeamsPath(opts: {
  scope?: TeamsScope;
  includeArchived?: boolean;
  q?: string | null;
  cursor?: string | null;
  limit?: number;
}): string {
  const qs = new URLSearchParams();
  if (opts.scope === "ALL") qs.set("scope", "all");
  if (opts.includeArchived) qs.set("includeArchived", "true");
  if (opts.q && opts.q.trim()) qs.set("q", opts.q.trim());
  if (opts.cursor) qs.set("cursor", opts.cursor);
  if (opts.limit) qs.set("limit", String(opts.limit));
  const suffix = qs.toString();
  return suffix ? `/v1/collaboration-teams?${suffix}` : "/v1/collaboration-teams";
}

/** Does the response grant the workspace-wide view? (`canGovernWorkspace`). */
export function parseCanGovernWorkspace(data: unknown): boolean {
  const d = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  return d["canGovernWorkspace"] === true;
}

/** Status + type filter and sort over the page in hand (the web's visibleTeams). */
export function visibleTeams(
  teams: readonly CollaborationTeamRow[],
  f: { status: TeamsStatusFilter; type: string; sort: TeamsSort },
): CollaborationTeamRow[] {
  const at = (t: CollaborationTeamRow) => (t.lastActivityAt ? Date.parse(t.lastActivityAt) || 0 : 0);
  const out = teams.filter(
    (t) => (f.status === "ALL" || t.status === f.status) && (f.type === "ALL" || t.teamType === f.type),
  );
  switch (f.sort) {
    case "ACTIVITY_ASC":
      return out.sort((a, b) => at(a) - at(b));
    case "NAME_ASC":
      return out.sort((a, b) => a.name.localeCompare(b.name));
    case "MEMBERS_DESC":
      return out.sort((a, b) => (b.memberCount ?? 0) - (a.memberCount ?? 0));
    default:
      return out.sort((a, b) => at(b) - at(a));
  }
}

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
  /** The workspace plan the limit belongs to (web PlanLimitBadge planLabel). */
  plan: string | null;
  /**
   * WCR-12 — a restriction is not a lock. A downgraded or lapsed workspace
   * keeps its groups READABLE and loses growth (`mutationsAllowed`,
   * collaboration-entitlement.service.ts:226). Absent means allowed.
   */
  mutationsAllowed: boolean;
}

export function parseCollaborationEntitlement(payload: unknown): CollaborationEntitlement {
  const e = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  // The server names the group allowance `collaborationTeams` (collaboration-entitlement.service.ts).
  // This read `teams`, which is never sent, so used/limit were always unknown.
  const teams = (e.collaborationTeams && typeof e.collaborationTeams === "object" ? e.collaborationTeams : {}) as Record<string, unknown>;
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
    // The server says `featureIncluded` (limit > 0); `planLocked` was never sent.
    planLocked: e.featureIncluded === false,
    plan: typeof e.plan === "string" && e.plan.length > 0 ? e.plan : null,
    mutationsAllowed: e.mutationsAllowed !== false,
  };
}

/** The web's single plan-locked sentence (lib/feedback/team-entitlement-copy.ts:19). */
export const TEAMS_PLAN_LOCKED_COPY = "Teams are available on Pro, Team, and Enterprise plans.";

/**
 * The web's TEAM_LIMIT_REACHED message from the refusal's `details`
 * (`limit` + `plan`), or null when no usable limit was sent — numbers are
 * never fabricated (team-entitlement-copy.ts:28).
 */
export function formatTeamLimitReachedMessage(details: unknown): string | null {
  const d = (details && typeof details === "object" ? details : {}) as Record<string, unknown>;
  const limit = typeof d.limit === "number" && Number.isFinite(d.limit) ? d.limit : null;
  if (limit === null) return null;
  const raw = typeof d.plan === "string" ? d.plan.trim() : "";
  const plan = raw ? `${raw.charAt(0).toUpperCase()}${raw.slice(1).toLowerCase()} plan` : "plan";
  return `Your ${plan} includes up to ${limit} Team${limit === 1 ? "" : "s"}. Upgrade to create another Team.`;
}

/** The web's template hints (collaboration-teams/page.tsx:1626). */
export function teamTypeHint(t: string): string {
  switch (t) {
    case "GENERAL":
      return "Flexible team for any work";
    case "INVESTIGATION":
      return "Reconstruction & timeline work";
    case "LEGAL":
      return "Matter & disclosure";
    case "REVIEW":
      return "Reviewer ops & QC";
    case "COMPLIANCE":
      return "Governance & audit";
    default:
      return "";
  }
}

/** POST /v1/collaboration-teams → 201 { team: { id } } (collaboration-teams.routes.ts:497). */
export function parseCreatedTeamId(payload: unknown): string | null {
  const team = o(o(payload)["team"]);
  return typeof team["id"] === "string" && team["id"] ? (team["id"] as string) : null;
}

/** The GRANTED list scope (`scope` on GET /v1/collaboration-teams, collaboration-team.service.ts:751). */
export function parseGrantedScope(data: unknown): TeamsScope {
  return o(data)["scope"] === "ALL" ? "ALL" : "PARTICIPATING";
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
  // The web's three states (collaboration-teams/page.tsx:197) — locked,
  // restricted, at capacity — send a customer to different places.
  if (entitlement.planLocked) return TEAMS_PLAN_LOCKED_COPY;
  if (!entitlement.mutationsAllowed) {
    return "This workspace's billing needs attention before new Teams can be created.";
  }
  if (entitlement.exceededDimensions.includes("WORKSPACE_SEATS")) {
    return "This workspace is over its seat allowance.";
  }
  if (entitlement.teamsLimit !== null) {
    const max = entitlement.teamsLimit;
    return `Your ${entitlement.plan ? `${entitlement.plan} ` : ""}plan allows up to ${max} active Team${max === 1 ? "" : "s"}. Upgrade to add more.`;
  }
  return "Creating a Team is not available here.";
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

const BLOCKER_NOUN: Readonly<Record<string, [string, string]>> = {
  assignments: ["assignment", "assignments"],
  discussion: ["discussion comment", "discussion comments"],
  accessReviews: ["access review", "access reviews"],
  guests: ["guest", "guests"],
  activity: ["activity entry", "activity entries"],
};
function blockerSentence(kind: string | null, count: unknown): string | null {
  if (!kind || typeof count !== "number" || count <= 0) return null;
  const noun = BLOCKER_NOUN[kind];
  return noun ? `${count} ${count === 1 ? noun[0] : noun[1]}` : `${count} ${kind}`;
}

export function parseTeamDisposability(payload: unknown): TeamDisposability {
  const d = obj(obj(payload).disposition ?? payload);
  return {
    // Absent means NOT disposable. A default of "yes" on a permanent delete
    // would be the client deciding a destructive question the server owns.
    disposable: d.disposable === true,
    // Each blocker is `{ kind, count }` (collaboration-team.service.ts). Read as a
    // string or `.message`, every one was dropped, so the "cannot be deleted"
    // card never showed and the reason was never given.
    blockers: rows(d.blockers)
      .map((b) => (typeof b === "string" ? b : blockerSentence(str(obj(b).kind), obj(b).count) ?? str(obj(b).message) ?? str(obj(b).code)))
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

// ---------------------------------------------------------------------------
// Add existing workspace members to a group (T-12 — MembersTab.tsx:765-1066)
// ---------------------------------------------------------------------------

/** `collaborationTeamMembers.limit` from the entitlement envelope, or null when unknown. */
export function parseTeamMemberLimit(payload: unknown): number | null {
  const m = o(o(payload)["collaborationTeamMembers"]);
  const limit = m["limit"];
  return typeof limit === "number" && Number.isFinite(limit) && limit > 0 ? limit : null;
}

/** The web's `atCapacity`: only when the limit is KNOWN — an unknown limit never blocks. */
export function teamAtCapacity(activeMemberCount: number, limit: number | null): boolean {
  return limit !== null && activeMemberCount >= limit;
}

export function buildEligibleMembersPath(teamId: string, q: string, limit = 25): string {
  return `/v1/collaboration-teams/${encodeURIComponent(teamId)}/eligible-members?limit=${limit}${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ""}`;
}

export interface EligibleMember {
  userId: string;
  displayName: string;
  email: string | null;
  workspaceRole: string;
}

export function parseEligibleMembers(payload: unknown): EligibleMember[] {
  const out: EligibleMember[] = [];
  const list = o(payload)["members"];
  for (const raw of Array.isArray(list) ? list : []) {
    const m = o(raw);
    const userId = s(m["userId"]);
    if (!userId) continue;
    out.push({
      userId,
      displayName: s(m["displayName"]) ?? s(m["email"]) ?? "Unnamed member",
      email: s(m["email"]),
      workspaceRole: s(m["workspaceRole"]) ?? "",
    });
  }
  return out;
}

export function buildTeamMembersAddPath(teamId: string): string {
  return `/v1/collaboration-teams/${encodeURIComponent(teamId)}/members`;
}
export function buildTeamMembersBulkPath(teamId: string): string {
  return `/v1/collaboration-teams/${encodeURIComponent(teamId)}/members/bulk`;
}

export interface BulkAddResult {
  added: string[];
  failed: Array<{ userId: string; reason: string }>;
}
export function parseBulkAddResult(payload: unknown): BulkAddResult {
  const d = o(payload);
  const added = Array.isArray(d["added"]) ? (d["added"] as unknown[]).filter((x): x is string => typeof x === "string") : [];
  const failed: BulkAddResult["failed"] = [];
  for (const raw of Array.isArray(d["failed"]) ? (d["failed"] as unknown[]) : []) {
    const f = o(raw);
    const userId = s(f["userId"]);
    if (userId) failed.push({ userId, reason: s(f["reason"]) ?? "add_failed" });
  }
  return { added, failed };
}

/**
 * The web's outcome copy. Partial success is REPORTED, not rounded: both the
 * people who were added and the people who were not are facts the operator
 * needs, and the failures stay selected so they can see who did not make it.
 */
export function bulkAddOutcome(r: BulkAddResult): { message: string; tone: "success" | "info" | "error"; close: boolean } {
  if (r.failed.length === 0) return { message: `Added ${r.added.length} people to this team.`, tone: "success", close: true };
  return {
    message: `Added ${r.added.length}. ${r.failed.length} could not be added — the team may be at its member limit.`,
    tone: r.added.length > 0 ? "info" : "error",
    close: false,
  };
}

export function addSubmitLabel(selected: number): string {
  return selected > 1 ? `Add ${selected} to team` : "Add to team";
}

// ---------------------------------------------------------------------------
// GROUP DISCUSSION — /v1/collaboration-teams/:teamId/comments (web DiscussionTab).
//
// THE DEFECT THIS REPLACES: the native group screen mounted the EVIDENCE-anchored
// thread system (/v1/collaboration/threads?teamId=…) with a collaboration-group
// id. Those routes authorise a WORKSPACE membership, so the list always answered
// 404 (rendered "open to reviewers") and messages were fetched without the
// required teamId. A group conversation is the comments system, as on the web.
// ---------------------------------------------------------------------------
export function buildTeamCommentsPath(teamId: string): string {
  return `${buildCollaborationTeamPath(teamId)}/comments`;
}
export function buildTeamCommentPath(teamId: string, commentId: string): string {
  return `${buildTeamCommentsPath(teamId)}/${encodeURIComponent(commentId)}`;
}

export interface TeamComment {
  id: string;
  authorUserId: string;
  body: string;
  edited: boolean;
  createdAt: string | null;
}
export interface TeamCommentPage {
  items: TeamComment[];
  /** authorUserId → display name, from the server's own directory. */
  names: Record<string, string>;
}

export function parseTeamComments(payload: unknown): TeamCommentPage {
  const d = o(payload);
  const items: TeamComment[] = [];
  for (const raw of Array.isArray(d["items"]) ? (d["items"] as unknown[]) : []) {
    const c = o(raw);
    const id = s(c["id"]);
    const author = s(c["authorUserId"]);
    if (!id || !author) continue;
    items.push({ id, authorUserId: author, body: typeof c["body"] === "string" ? (c["body"] as string) : "", edited: c["status"] === "EDITED", createdAt: s(c["createdAt"]) });
  }
  const names: Record<string, string> = {};
  const dir = o(d["directory"]);
  for (const key of Object.keys(dir)) {
    const name = s(o(dir[key])["displayName"]);
    if (name) names[key] = name;
  }
  return { items, names };
}

/** The server's comment-moderation authority and whether the viewer is here only by workspace governance. */
export function parseTeamDiscussionAccess(data: unknown): { canModerate: boolean; viaWorkspaceGovernance: boolean } {
  const env = o(data);
  return {
    canModerate: o(o(env["team"])["viewerCapabilities"])["canModerateComments"] === true,
    viaWorkspaceGovernance: env["viaWorkspaceGovernance"] === true,
  };
}

export const TEAM_COMMENT_MAX = 4000;
export const TEAM_DISCUSSION_COPY = {
  title: "Discussion",
  visibility: "Comments are visible to active team members only. Mention teammates with @name.",
  placeholder: "Write a comment for the team…",
  post: "Post comment",
  posting: "Posting…",
  empty: "No comments yet",
  emptyBody: "Start the conversation with your team.",
  governanceTitle: "Discussion is for members of this team",
  governanceBody: "You are viewing this team as a workspace administrator. Joining the team is what grants a place in its conversation.",
  unknownAuthor: "Team member",
  updated: "Comment updated.",
  deleted: "Comment deleted.",
  loadFailed: "The team's comments could not be loaded.",
} as const;

// ---------------------------------------------------------------------------
// CREATE ASSIGNMENT (T-14 — web CreateAssignmentModal.tsx)
//   GET  /v1/collaboration-teams/:id/assignable-targets?type=&q=  → { targets[] }
//   POST /v1/collaboration-teams/:id/assignments
//        { targetType, targetId, assigneeUserId|null, priority, dueAtUtc|null, note|null }
// ---------------------------------------------------------------------------
export type AssignmentTargetType = "CASE" | "EVIDENCE" | "REVIEW";
export type AssignmentPriority = "LOW" | "NORMAL" | "HIGH" | "URGENT";
export const ASSIGNMENT_TARGET_OPTIONS: ReadonlyArray<{ value: AssignmentTargetType; label: string }> = [
  { value: "CASE", label: "Case" },
  { value: "EVIDENCE", label: "Evidence" },
  { value: "REVIEW", label: "Evidence review" },
];
export const ASSIGNMENT_PRIORITY_OPTIONS: ReadonlyArray<{ value: AssignmentPriority; label: string }> = [
  { value: "LOW", label: "Low" },
  { value: "NORMAL", label: "Normal" },
  { value: "HIGH", label: "High" },
  { value: "URGENT", label: "Urgent" },
];
export const ASSIGNEE_TEAM_LEVEL_LABEL = "Team-level (no specific assignee)";

export function buildAssignableTargetsPath(teamId: string, type: AssignmentTargetType, search: string): string {
  const q = search.trim();
  return `${buildCollaborationTeamPath(teamId)}/assignable-targets?type=${type}${q ? `&q=${encodeURIComponent(q)}` : ""}`;
}
export function buildCreateAssignmentPath(teamId: string): string {
  return `${buildCollaborationTeamPath(teamId)}/assignments`;
}

export interface AssignableTarget {
  id: string;
  label: string;
  sublabel: string | null;
}
export function parseAssignableTargets(payload: unknown): AssignableTarget[] {
  const list = o(payload)["targets"];
  const out: AssignableTarget[] = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const x = o(raw);
    const id = s(x["id"]);
    if (!id) continue;
    out.push({ id, label: s(x["label"]) ?? id.slice(0, 8), sublabel: s(x["sublabel"]) });
  }
  return out;
}

export function buildCreateAssignmentBody(input: {
  targetType: AssignmentTargetType;
  targetId: string;
  assigneeUserId: string | null;
  priority: AssignmentPriority;
  dueAtUtc: string | null;
  note: string;
}) {
  return {
    targetType: input.targetType,
    targetId: input.targetId,
    assigneeUserId: input.assigneeUserId || null,
    priority: input.priority,
    dueAtUtc: input.dueAtUtc,
    note: input.note.trim() ? input.note.trim() : null,
  };
}
