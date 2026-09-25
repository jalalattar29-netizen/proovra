/**
 * TEAM RESPONSIBILITY ON THE RECORD (T-12 / RC-13) — the native port of
 * `apps/web/components/collaboration/TeamResponsibilityPanel.tsx`.
 *
 * Which collaboration group is coordinating this case / evidence record.
 * READ: GET /v1/collaboration-teams/responsibility?targetType&targetId (the
 * ONE group-responsibility authority). WRITE: the group's own assignment
 * writers — POST /:teamId/assignments to assign, PATCH /:teamId/assignments/:id
 * to edit or to remove (status CANCELLED). No second assignment model.
 *
 * It is not access: responsibility grants nobody the right to open a record.
 */

export type ResponsibilityTarget = "CASE" | "EVIDENCE";

export const RESPONSIBILITY_COPY = {
  title: "Team responsibility",
  loadFailed: "Team responsibility couldn't be loaded.",
  empty:
    "No collaboration team is currently responsible for this record. Assign it from a team’s Work tab to coordinate it there.",
  footnote: "Responsibility coordinates work. It does not change who owns this record or who can open it.",
  assignTitle: "Assign this record to a team",
  assignDescription:
    "The team becomes responsible for coordinating it. The record itself is unchanged — same owner, same place, same access.",
  editDescription: "Change who is responsible, how urgent it is, and when it is needed. The record itself is not affected.",
  teamLevelHelp: "Team-level work belongs to the whole team and notifies nobody in particular.",
  removeConsequence:
    "The team stops being responsible for it. The record itself is not changed, not unlinked and not deleted — it keeps its owner and stays exactly where it is.",
  saveFailed: "Could not save this team responsibility.",
  removeFailed: "Could not remove the team's responsibility.",
} as const;

export const ASSIGNEE_TEAM_LEVEL_SHORT = "Team-level";

export function buildTeamResponsibilityPath(targetType: ResponsibilityTarget, targetId: string): string {
  return `/v1/collaboration-teams/responsibility?targetType=${encodeURIComponent(targetType)}&targetId=${encodeURIComponent(targetId)}`;
}

/** The chosen team's roster, for the assignee picker (web: limit 100, ACTIVE only). */
export function buildResponsibilityMembersPath(teamId: string): string {
  return `/v1/collaboration-teams/${encodeURIComponent(teamId)}/members?limit=100`;
}

export interface TeamResponsibilityRow {
  id: string;
  teamId: string;
  teamName: string;
  assigneeUserId: string | null;
  status: string;
  priority: string;
  dueAtUtc: string | null;
  overdue: boolean;
  note: string | null;
}

function o(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}
function s(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

export function parseTeamResponsibility(payload: unknown): TeamResponsibilityRow[] {
  const list = o(payload)["assignments"];
  const out: TeamResponsibilityRow[] = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const r = o(raw);
    const id = s(r["id"]);
    const teamId = s(r["teamId"]);
    if (!id || !teamId) continue;
    out.push({
      id,
      teamId,
      teamName: s(r["teamName"]) ?? "Collaboration team",
      assigneeUserId: s(r["assigneeUserId"]),
      status: s(r["status"]) ?? "OPEN",
      priority: s(r["priority"]) ?? "NORMAL",
      dueAtUtc: s(r["dueAtUtc"]),
      overdue: r["overdue"] === true,
      note: s(r["note"]),
    });
  }
  return out;
}

export interface ResponsibilityMemberOption {
  userId: string;
  label: string;
}

/** ACTIVE members only — the server refuses anyone else as an assignee. */
export function parseResponsibilityMembers(payload: unknown): ResponsibilityMemberOption[] {
  const list = o(payload)["members"];
  const out: ResponsibilityMemberOption[] = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const m = o(raw);
    const userId = s(m["userId"]);
    if (!userId || s(m["status"]) !== "ACTIVE") continue;
    out.push({ userId, label: s(m["displayName"]) ?? s(m["email"]) ?? "Team member" });
  }
  return out;
}

export function responsibilityStatusLabel(status: string): string {
  return status === "IN_PROGRESS" ? "In progress" : status === "OPEN" ? "Open" : status;
}

export function responsibilityPriorityLabel(priority: string): string {
  return priority === "NORMAL" ? "Normal priority" : `${priority.charAt(0)}${priority.slice(1).toLowerCase()} priority`;
}

export function responsibilityPriorityTone(priority: string): "risk" | "pending" | "neutral" | "governance" {
  if (priority === "URGENT") return "risk";
  if (priority === "HIGH") return "pending";
  if (priority === "LOW") return "neutral";
  return "governance";
}

/**
 * DUE — the web's `datetime-local` value, "YYYY-MM-DD HH:MM" in the viewer's
 * LOCAL time (a `T` separator is accepted too). Touch adaptation: this build
 * ships no date-picker module, so the field is typed and validated.
 * Returns the UTC ISO string, `null` for an empty field, or `undefined` when
 * the text is not a real date.
 */
export function parseLocalDueInput(text: string): string | null | undefined {
  const t = text.trim();
  if (!t) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(t);
  if (!m) return undefined;
  const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number];
  const date = new Date(y, mo - 1, d, h, mi);
  const valid =
    date.getFullYear() === y && date.getMonth() === mo - 1 && date.getDate() === d && date.getHours() === h && date.getMinutes() === mi;
  return valid ? date.toISOString() : undefined;
}

/**
 * The edit prefill, in LOCAL time. (The web prefills `dueAtUtc.slice(0, 16)`
 * — the UTC wall time — into a local input, so every save of an unchanged
 * edit shifts the due time by the viewer's UTC offset. Native does not.)
 */
export function formatLocalDueInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export interface ResponsibilityValues {
  assigneeUserId: string;
  priority: string;
  dueAtUtc: string | null;
  note: string;
}

export function buildResponsibilityCreateBody(target: ResponsibilityTarget, targetId: string, v: ResponsibilityValues) {
  return {
    targetType: target,
    targetId,
    assigneeUserId: v.assigneeUserId || null,
    priority: v.priority,
    dueAtUtc: v.dueAtUtc,
    note: v.note.trim() || null,
  };
}

export function buildResponsibilityUpdateBody(v: ResponsibilityValues) {
  return {
    assigneeUserId: v.assigneeUserId || null,
    priority: v.priority,
    dueAtUtc: v.dueAtUtc,
    note: v.note.trim() || null,
  };
}

export const RESPONSIBILITY_REMOVE_BODY = { status: "CANCELLED" } as const;
