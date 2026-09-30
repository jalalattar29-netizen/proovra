/**
 * UC-EXT-001 / UC-EXT-002 / UC-EXT-010 — what the popup reads from the API,
 * parsed PURELY so it is tested against the real contract.
 *
 * The popup used to read `body.workspaces ?? body.teams`, keys the
 * /v1/platform/context envelope (PlatformContextEnvelope, services/api
 * platform-context/types.ts) has never carried — so every signed-in user saw
 * "No workspace available" and could not capture. It also collapsed every
 * failure (401, 5xx, offline) into that same empty list.
 *
 * The canonical fields are:
 *   availableWorkspaces: [{ id, name, scope: "PERSONAL" | "TEAM", role }]
 *     — server-authorized (the Personal entry is withheld when the Personal
 *       Space is not allowed), ACTIVE memberships only;
 *   activeSpace: { type, id, ... } — the user's current space, preselected.
 * A workspace is offered only when its role grants `evidence.create` (the
 * permission every capture call is authorized against); the server still
 * decides on every request.
 */
import { roleHasPermission, type DbTeamRole } from "@proovra/shared";

export type CaptureWorkspace = { id: string; name: string; scope: "PERSONAL" | "TEAM"; role: string };

export type WorkspaceLoad =
  | { kind: "ok"; workspaces: CaptureWorkspace[]; activeId: string | null }
  | { kind: "signed_out" }
  | { kind: "error"; status: number | null };

const ROLES: ReadonlySet<string> = new Set(["OWNER", "ADMIN", "MEMBER", "VIEWER"]);

/** PURE: the capture-eligible workspaces in a /v1/platform/context envelope. */
export function parseCaptureWorkspaces(body: unknown): { workspaces: CaptureWorkspace[]; activeId: string | null } {
  const env = (body ?? {}) as {
    availableWorkspaces?: unknown;
    activeSpace?: { id?: unknown } | null;
  };
  const list = Array.isArray(env.availableWorkspaces) ? env.availableWorkspaces : [];
  const workspaces: CaptureWorkspace[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    const w = (raw ?? {}) as { id?: unknown; name?: unknown; scope?: unknown; role?: unknown };
    if (typeof w.id !== "string" || w.id.length === 0 || seen.has(w.id)) continue;
    const scope = w.scope === "PERSONAL" ? "PERSONAL" : "TEAM";
    const role = typeof w.role === "string" && ROLES.has(w.role) ? w.role : null;
    if (!role || !roleHasPermission(role as DbTeamRole, "evidence.create")) continue;
    const name =
      typeof w.name === "string" && w.name.trim() !== ""
        ? w.name.trim()
        : scope === "PERSONAL"
          ? "Personal Space"
          : "Workspace";
    seen.add(w.id);
    workspaces.push({ id: w.id, name, scope, role });
  }
  const activeRaw = env.activeSpace?.id;
  const activeId = typeof activeRaw === "string" && seen.has(activeRaw) ? activeRaw : (workspaces[0]?.id ?? null);
  return { workspaces, activeId };
}

/** PURE: classify the /v1/platform/context answer (UC-EXT-002). */
export function classifyContextResponse(status: number | null, body: unknown): WorkspaceLoad {
  if (status === 401) return { kind: "signed_out" };
  if (status === null || status < 200 || status >= 300) return { kind: "error", status };
  const parsed = parseCaptureWorkspaces(body);
  return { kind: "ok", ...parsed };
}

export type CaptureCase = { id: string; name: string };

export type CaseLoad =
  | { kind: "ok"; cases: CaptureCase[] }
  | { kind: "signed_out" }
  | { kind: "error"; status: number | null };

const CLOSED_CASE_STATUSES: ReadonlySet<string> = new Set(["ARCHIVED", "CLOSED"]);

/**
 * PURE: the cases of ONE workspace a capture may be filed into, from
 * GET /v1/cases (`{ items: Case[] }`, the caller's visible cases). Same rule
 * as the web's case selector: same workspace, not archived or closed. The
 * server re-checks the case on session open.
 */
export function parseEligibleCases(body: unknown, teamId: string): CaptureCase[] {
  const items = Array.isArray((body as { items?: unknown } | null)?.items)
    ? ((body as { items: unknown[] }).items)
    : [];
  const out: CaptureCase[] = [];
  for (const raw of items) {
    const c = (raw ?? {}) as { id?: unknown; name?: unknown; title?: unknown; teamId?: unknown; status?: unknown };
    if (typeof c.id !== "string" || c.teamId !== teamId) continue;
    if (typeof c.status === "string" && CLOSED_CASE_STATUSES.has(c.status)) continue;
    const label = typeof c.name === "string" && c.name.trim() ? c.name.trim() : typeof c.title === "string" && c.title.trim() ? c.title.trim() : "Untitled case";
    out.push({ id: c.id, name: label.slice(0, 120) });
  }
  return out;
}

export function classifyCasesResponse(status: number | null, body: unknown, teamId: string): CaseLoad {
  if (status === 401) return { kind: "signed_out" };
  if (status === null || status < 200 || status >= 300) return { kind: "error", status };
  return { kind: "ok", cases: parseEligibleCases(body, teamId) };
}
