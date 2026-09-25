/**
 * COLLABORATION TEAM DETAIL — pure projections for the tabbed group surface.
 *
 * Ports the logic of `apps/web/app/(app)/collaboration-teams/[teamId]/page.tsx`
 * and its `_tabs/*` (Overview, Members, Settings + Activity):
 *
 *   GET   /v1/collaboration-teams/:teamId/overview   → { overview }            (routes :1504)
 *   GET   /v1/collaboration-teams/:teamId/members    → { members, nextCursor, totalActive } (routes :1637)
 *   PATCH /v1/collaboration-teams/:teamId/members/:memberId { role? , status? } → { ok }
 *   DELETE /v1/collaboration-teams/:teamId/members/:memberId                  → { ok }
 *   GET   /v1/collaboration-teams/:teamId/activity   → { items, nextCursor }
 *
 * Pure: no React, no react-native, no fetch, no @proovra/shared (the role
 * table lives in ./collaboration-permissions so these tests load on their own).
 */

const o = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
const rows = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const n0 = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

// ---------------------------------------------------------------------------
// Tabs (page.tsx:78-130)
// ---------------------------------------------------------------------------

export const TEAM_TABS = ["overview", "work", "members", "discussion", "settings"] as const;
export type TeamTab = (typeof TEAM_TABS)[number];

/** Retired slugs land where their content went, never silently on Overview. */
const RETIRED_TAB_ALIASES: Readonly<Record<string, TeamTab>> = {
  assignments: "work",
  activity: "settings",
  invites: "members",
};

export function resolveTeamTab(raw: string | null | undefined): TeamTab {
  const t = (raw ?? "").trim();
  if ((TEAM_TABS as ReadonlyArray<string>).includes(t)) return t as TeamTab;
  return RETIRED_TAB_ALIASES[t] ?? "overview";
}

export const TEAM_TAB_LABELS: Readonly<Record<TeamTab, string>> = {
  overview: "Overview",
  work: "Work",
  members: "Members",
  discussion: "Discussion",
  settings: "Settings",
};

/** A group id is a uuid; anything else is not a team and is never requested (page.tsx:164). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isTeamId(id: string): boolean {
  return UUID_RE.test(id);
}
export const NOT_A_TEAM_MESSAGE =
  "That address isn't a team. Open a team from the Teams list to see its members, work and discussion.";

/** Title-case the template enum (page.tsx templateLabel). */
export function templateLabel(type: string): string {
  return type ? type.charAt(0).toUpperCase() + type.slice(1).toLowerCase() : "";
}

/** Compact relative time for "Last activity" (page.tsx formatRelative). */
export function formatRelative(iso: string | null, now: number = Date.now()): string {
  if (!iso) return "recently";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "recently";
  const mins = Math.round((now - then) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.round(months / 12)}y ago`;
}

// ---------------------------------------------------------------------------
// Overview (OverviewTab.tsx)
// ---------------------------------------------------------------------------

export function buildTeamOverviewPath(teamId: string): string {
  return `/v1/collaboration-teams/${encodeURIComponent(teamId)}/overview`;
}

export interface TeamOverview {
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
  workload: Array<{ userId: string; open: number; overdue: number }>;
}

/** { overview } (collaboration-team.service.ts:3467). */
export function parseTeamOverview(payload: unknown): TeamOverview {
  const ov = o(o(payload)["overview"]);
  const w = o(ov["work"]);
  const t = o(w["byTargetType"]);
  const m = o(ov["members"]);
  return {
    work: {
      open: n0(w["open"]),
      inProgress: n0(w["inProgress"]),
      completed: n0(w["completed"]),
      overdue: n0(w["overdue"]),
      dueSoon: n0(w["dueSoon"]),
      highPriority: n0(w["highPriority"]),
      unassigned: n0(w["unassigned"]),
      byTargetType: { CASE: n0(t["CASE"]), EVIDENCE: n0(t["EVIDENCE"]), REVIEW: n0(t["REVIEW"]) },
    },
    members: { active: n0(m["active"]), suspended: n0(m["suspended"]), managers: n0(m["managers"]) },
    workload: rows(ov["workload"])
      .map(o)
      .filter((r) => str(r["userId"]))
      .map((r) => ({ userId: str(r["userId"]) as string, open: n0(r["open"]), overdue: n0(r["overdue"]) })),
  };
}

export interface AttentionItem {
  key: "overdue" | "dueSoon" | "priority" | "unassigned";
  count: number;
  label: string;
  hint: string;
  tone: "risk" | "pending" | "governance";
}

/** The "Needs attention" rows, in the web's order, only where non-zero. */
export function attentionItems(w: TeamOverview["work"]): AttentionItem[] {
  const out: AttentionItem[] = [];
  if (w.overdue > 0) {
    out.push({ key: "overdue", count: w.overdue, label: w.overdue === 1 ? "item is overdue" : "items are overdue", hint: "Past its due date and still open.", tone: "risk" });
  }
  if (w.dueSoon > 0) {
    out.push({ key: "dueSoon", count: w.dueSoon, label: w.dueSoon === 1 ? "item is due soon" : "items are due soon", hint: "Due within the next three days.", tone: "pending" });
  }
  if (w.highPriority > 0) {
    out.push({ key: "priority", count: w.highPriority, label: "high or urgent priority", hint: "Open work the team marked as needing to go first.", tone: "pending" });
  }
  if (w.unassigned > 0) {
    out.push({ key: "unassigned", count: w.unassigned, label: "not assigned to anyone", hint: "Work the team holds but nobody has picked up.", tone: "governance" });
  }
  return out;
}

const PERMISSION_LABELS: Readonly<Record<string, string>> = {
  "team.read": "See this team and its work",
  "team.update_settings": "Change the team's name and description",
  "team.archive": "Archive or reopen this team",
  "team.delete": "Permanently delete this team when it holds no records",
  "team.transfer_lead": "Transfer the lead role",
  "team.member.invite": "Add workspace members to the team",
  "team.member.remove": "Remove members from the team",
  "team.member.suspend": "Suspend and reinstate members",
  "team.member.change_role": "Change a member's role",
  "team.invite.revoke": "Withdraw an outstanding invitation",
  "team.invite.resend": "Resend an outstanding invitation",
  "team.assignment.create": "Assign cases, evidence and reviews to this team",
  "team.assignment.reassign": "Reassign work and change priority or due date",
  "team.assignment.complete": "Mark assigned work complete",
  "team.assignment.cancel": "Remove work from this team",
  "team.activity.read": "See the team's activity history",
};

export function humanizePermission(p: string, isArchived: boolean): string {
  if (p === "team.archive") return isArchived ? "Reopen this team" : "Archive this team";
  return PERMISSION_LABELS[p] ?? p;
}

const PERMISSION_GROUPS: ReadonlyArray<{ title: string; match: (p: string) => boolean }> = [
  {
    title: "Team management",
    match: (p) => p === "team.update_settings" || p === "team.archive" || p === "team.delete" || p === "team.transfer_lead",
  },
  { title: "Members", match: (p) => p.startsWith("team.member.") },
  { title: "Work", match: (p) => p.startsWith("team.assignment.") },
  {
    title: "Invitations, audit and access",
    match: (p) => p.startsWith("team.invite.") || p === "team.activity.read" || p === "team.read",
  },
];

/** Presentation only: groups the permissions the SERVER's role table granted; an unmatched one lands in "Other". */
export function groupPermissions(permissions: readonly string[]): Array<{ title: string; items: string[] }> {
  const groups = PERMISSION_GROUPS.map((g) => ({ title: g.title, items: permissions.filter((p) => g.match(p)) })).filter(
    (g) => g.items.length > 0,
  );
  const claimed = new Set(groups.flatMap((g) => g.items));
  const rest = permissions.filter((p) => !claimed.has(p));
  return rest.length > 0 ? [...groups, { title: "Other", items: rest }] : groups;
}

/** One sentence DERIVED from the grants, never written per role (OverviewTab summarisePermissions). */
export function summarisePermissions(permissions: readonly string[]): string {
  if (permissions.length === 0) return "You have no management permissions on this team.";
  const can: string[] = [];
  if (permissions.some((p) => p.startsWith("team.member."))) can.push("team membership");
  if (permissions.some((p) => p.startsWith("team.assignment."))) can.push("work assignment");
  if (permissions.some((p) => p === "team.update_settings" || p === "team.archive" || p === "team.transfer_lead")) {
    can.push("the team's settings and lifecycle");
  }
  if (can.length === 0) return "You can see this team, its work and its activity history.";
  const list = can.length === 1 ? can[0] : `${can.slice(0, -1).join(", ")} and ${can[can.length - 1]}`;
  return `You can manage ${list}.`;
}

// ---------------------------------------------------------------------------
// Members (MembersTab.tsx)
// ---------------------------------------------------------------------------

export function buildTeamMembersPagePath(teamId: string, opts: { q?: string; cursor?: string | null; limit?: number } = {}): string {
  const p = new URLSearchParams();
  if (opts.q && opts.q.trim()) p.set("q", opts.q.trim());
  if (opts.cursor) p.set("cursor", opts.cursor);
  if (opts.limit) p.set("limit", String(opts.limit));
  const qs = p.toString();
  return `/v1/collaboration-teams/${encodeURIComponent(teamId)}/members${qs ? `?${qs}` : ""}`;
}

export interface TeamRosterRow {
  id: string;
  userId: string | null;
  role: string;
  status: string;
  displayName: string;
  email: string | null;
  joinedAtIso: string | null;
}

/** The paged roster: FLAT displayName/email (collaboration-team.service.ts:2489). */
export function parseTeamMembersPage(payload: unknown): { members: TeamRosterRow[]; nextCursor: string | null } {
  const d = o(payload);
  return {
    members: rows(d["members"])
      .map(o)
      .filter((m) => str(m["id"]))
      .map((m) => ({
        id: str(m["id"]) as string,
        userId: str(m["userId"]),
        role: str(m["role"]) ?? "MEMBER",
        status: str(m["status"]) ?? "ACTIVE",
        // NOT the address and NOT the uuid (MembersTab :526).
        displayName: str(m["displayName"]) ?? "Workspace member",
        email: str(m["email"]),
        joinedAtIso: str(m["joinedAt"]),
      })),
    nextCursor: str(d["nextCursor"]),
  };
}

const TEAM_ROLE_LABEL: Readonly<Record<string, string>> = {
  LEAD: "Lead",
  ADMIN: "Admin",
  MEMBER: "Member",
  VIEWER: "Viewer",
  EXTERNAL: "External collaborator",
};
export function teamRoleLabel(role: string): string {
  return TEAM_ROLE_LABEL[role] ?? templateLabel(role.replace(/_/g, " "));
}

export function teamMemberStatusTone(status: string): "verified" | "pending" | "risk" | "neutral" {
  switch (status) {
    case "ACTIVE":
      return "verified";
    case "PENDING":
    case "INVITED":
    case "SUSPENDED":
      return "pending";
    case "REMOVED":
      return "risk";
    default:
      return "neutral";
  }
}

/** The last ACTIVE Lead cannot be demoted, suspended or removed — the server refuses it too. */
export function isLastLead(member: { role: string }, activeLeadCount: number): boolean {
  return member.role === "LEAD" && activeLeadCount <= 1;
}

export const REMOVE_FROM_TEAM_CONSEQUENCE =
  "They stop being responsible for this team's assignments, work and activity. Their workspace access, role and evidence are unaffected — this only removes them from this Collaboration Team.";

// ---------------------------------------------------------------------------
// Activity (ActivityTab.tsx)
// ---------------------------------------------------------------------------

export type ActivityCategory = "members" | "invites" | "assignments" | "settings";

export function activityCategory(e: string): ActivityCategory {
  switch (e) {
    case "MEMBER_ADDED":
    case "MEMBER_SUSPENDED":
    case "MEMBER_REINSTATED":
    case "MEMBER_REMOVED":
    case "MEMBER_ROLE_CHANGED":
    case "LEAD_TRANSFERRED":
      return "members";
    case "MEMBER_INVITED":
    case "INVITE_RESENT":
    case "INVITE_REVOKED":
    case "INVITE_ACCEPTED":
    case "INVITE_EXPIRED":
      return "invites";
    case "ASSIGNMENT_CREATED":
    case "ASSIGNMENT_REASSIGNED":
    case "ASSIGNMENT_COMPLETED":
    case "ASSIGNMENT_CANCELLED":
    case "ASSIGNMENT_PRIORITY_CHANGED":
    case "ASSIGNMENT_DUE_CHANGED":
      return "assignments";
    default:
      return "settings";
  }
}

export const ACTIVITY_CATEGORY_LABEL: Readonly<Record<ActivityCategory, string>> = {
  members: "Members",
  invites: "Invites",
  assignments: "Assignments",
  settings: "Settings",
};

export function activityEventTone(e: string): "verified" | "risk" | "governance" | "pending" | "neutral" {
  switch (e) {
    case "ASSIGNMENT_COMPLETED":
    case "INVITE_ACCEPTED":
    case "MEMBER_REINSTATED":
    case "TEAM_REOPENED":
      return "verified";
    case "MEMBER_REMOVED":
    case "MEMBER_SUSPENDED":
    case "INVITE_REVOKED":
    case "ASSIGNMENT_CANCELLED":
    case "TEAM_ARCHIVED":
      return "risk";
    default:
      break;
  }
  const cat = activityCategory(e);
  return cat === "members" || cat === "assignments" ? "governance" : cat === "invites" ? "pending" : "neutral";
}

const ACTIVITY_LABEL: Readonly<Record<string, string>> = {
  TEAM_CREATED: "Team created",
  TEAM_RENAMED: "Team renamed",
  TEAM_DESCRIPTION_CHANGED: "Description updated",
  TEAM_TYPE_CHANGED: "Template changed",
  TEAM_ARCHIVED: "Team archived",
  TEAM_REOPENED: "Team reopened",
  MEMBER_INVITED: "Member invited",
  INVITE_RESENT: "Invite resent",
  INVITE_REVOKED: "Invite revoked",
  INVITE_ACCEPTED: "Invite accepted",
  INVITE_EXPIRED: "Invite expired",
  MEMBER_ADDED: "Member added",
  MEMBER_SUSPENDED: "Member suspended",
  MEMBER_REINSTATED: "Member reinstated",
  MEMBER_REMOVED: "Member removed",
  MEMBER_ROLE_CHANGED: "Role changed",
  LEAD_TRANSFERRED: "Lead transferred",
  ASSIGNMENT_CREATED: "Assignment created",
  ASSIGNMENT_REASSIGNED: "Assignment reassigned",
  ASSIGNMENT_COMPLETED: "Assignment completed",
  ASSIGNMENT_CANCELLED: "Assignment cancelled",
  ASSIGNMENT_PRIORITY_CHANGED: "Assignment priority changed",
  ASSIGNMENT_DUE_CHANGED: "Assignment due date changed",
};
export function teamEventLabel(e: string): string {
  return ACTIVITY_LABEL[e] ?? "Activity";
}

function humanWord(raw: string): string {
  const s = raw.replace(/_/g, " ").toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}
function humanRole(raw: unknown): string | null {
  return typeof raw === "string" && raw ? teamRoleLabel(raw) : null;
}
function metaString(md: Record<string, unknown>, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = md[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  return null;
}

export interface TeamActivityEntry {
  id: string;
  eventType: string;
  actorUserId: string | null;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown>;
  createdAtIso: string | null;
}

/** GET …/activity → { items: [{ id, eventType, actorUserId, targetType, targetId, metadata, createdAt }], nextCursor }. */
export function parseTeamActivityEntries(payload: unknown): { items: TeamActivityEntry[]; nextCursor: string | null } {
  const d = o(payload);
  return {
    items: rows(d["items"])
      .map(o)
      .filter((a) => str(a["id"]))
      .map((a) => ({
        id: str(a["id"]) as string,
        eventType: str(a["eventType"]) ?? "",
        actorUserId: str(a["actorUserId"]),
        targetType: str(a["targetType"]),
        targetId: str(a["targetId"]),
        metadata: o(a["metadata"]),
        createdAtIso: str(a["createdAt"]),
      })),
    nextCursor: str(d["nextCursor"]),
  };
}

/** A readable sentence from actor + metadata; never fabricates a name (ActivityTab activitySentence). */
export function activitySentence(item: TeamActivityEntry, actor: string | null): string {
  const md = item.metadata;
  const target = metaString(md, "targetName", "memberName", "displayName", "email", "name");
  const who = actor ?? "Someone";
  switch (item.eventType) {
    case "TEAM_CREATED":
      return actor ? `${actor} created the team` : "The team was created";
    case "TEAM_RENAMED":
      return actor ? `${actor} renamed the team` : "The team was renamed";
    case "TEAM_DESCRIPTION_CHANGED":
      return actor ? `${actor} updated the team description` : "The team description was updated";
    case "TEAM_TYPE_CHANGED":
      return actor ? `${actor} changed the team template` : "The team template was changed";
    case "TEAM_ARCHIVED":
      return actor ? `${actor} archived the team` : "The team was archived";
    case "TEAM_REOPENED":
      return actor ? `${actor} reopened the team` : "The team was reopened";
    case "MEMBER_INVITED":
      return target ? `${who} invited ${target}` : actor ? `${actor} invited a new member` : "A member was invited";
    case "INVITE_RESENT":
      return target ? `${who} resent the invite to ${target}` : "An invite was resent";
    case "INVITE_REVOKED":
      return target ? `${who} revoked the invite for ${target}` : "An invite was revoked";
    case "INVITE_ACCEPTED":
      return target ? `${target} accepted their invite` : "An invite was accepted";
    case "INVITE_EXPIRED":
      return target ? `The invite for ${target} expired` : "An invite expired";
    case "MEMBER_ADDED":
      return target ? `${target} joined the team` : "A member was added";
    case "MEMBER_SUSPENDED":
      return target ? `${who} suspended ${target}` : "A member was suspended";
    case "MEMBER_REINSTATED":
      return target ? `${who} reinstated ${target}` : "A member was reinstated";
    case "MEMBER_REMOVED":
      return target ? `${who} removed ${target}` : "A member was removed";
    case "MEMBER_ROLE_CHANGED": {
      const from = humanRole(md.fromRole ?? md.from ?? md.previousRole);
      const to = humanRole(md.toRole ?? md.to ?? md.role ?? md.newRole);
      const subject = target ? `${target}'s role` : "A member's role";
      if (from && to) return `${subject} changed from ${from} to ${to}`;
      if (to) return `${subject} changed to ${to}`;
      return `${subject} changed`;
    }
    case "LEAD_TRANSFERRED":
      return target ? `Team lead was transferred to ${target}` : "Team lead was transferred";
    case "ASSIGNMENT_CREATED":
      return actor ? `${actor} created an assignment` : "An assignment was created";
    case "ASSIGNMENT_REASSIGNED":
      return target ? `An assignment was reassigned to ${target}` : actor ? `${actor} reassigned an assignment` : "An assignment was reassigned";
    case "ASSIGNMENT_COMPLETED":
      return actor ? `${actor} completed an assignment` : "An assignment was completed";
    case "ASSIGNMENT_CANCELLED":
      return actor ? `${actor} cancelled an assignment` : "An assignment was cancelled";
    case "ASSIGNMENT_PRIORITY_CHANGED": {
      const from = metaString(md, "fromPriority", "from", "previousPriority");
      const to = metaString(md, "toPriority", "to", "priority", "newPriority");
      if (from && to) return `An assignment's priority changed from ${humanWord(from)} to ${humanWord(to)}`;
      if (to) return `An assignment's priority changed to ${humanWord(to)}`;
      return "An assignment's priority changed";
    }
    case "ASSIGNMENT_DUE_CHANGED":
      return "An assignment's due date changed";
    default:
      return teamEventLabel(item.eventType);
  }
}

/** The supporting reference line under a row (ActivityTab supportingDetail). */
export function activityDetail(item: TeamActivityEntry): string | null {
  if (item.targetType && item.targetId) return `${humanWord(item.targetType)} · ${item.targetId.slice(0, 8)}…`;
  if (item.targetType) return humanWord(item.targetType);
  return null;
}

export type ActivityGroupKey = "today" | "yesterday" | "earlier";
export const ACTIVITY_GROUP_LABEL: Readonly<Record<ActivityGroupKey, string>> = {
  today: "Today",
  yesterday: "Yesterday",
  earlier: "Earlier",
};

export function activityGroupOf(iso: string | null, now: Date = new Date()): ActivityGroupKey {
  const t = iso ? Date.parse(iso) : Number.NaN;
  if (Number.isNaN(t)) return "earlier";
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (t >= startOfToday) return "today";
  if (t >= startOfToday - 86_400_000) return "yesterday";
  return "earlier";
}

export function groupActivity<T extends { createdAtIso: string | null }>(
  items: readonly T[],
  now: Date = new Date(),
): Array<{ key: ActivityGroupKey; rows: T[] }> {
  const buckets: Record<ActivityGroupKey, T[]> = { today: [], yesterday: [], earlier: [] };
  for (const a of items) buckets[activityGroupOf(a.createdAtIso, now)].push(a);
  return (["today", "yesterday", "earlier"] as const).map((key) => ({ key, rows: buckets[key] })).filter((g) => g.rows.length > 0);
}
