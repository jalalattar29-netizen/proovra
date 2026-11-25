/**
 * WORKSPACE SCOPE — the ONE native rule for "which workspace is this, and who
 * am I in it" (Team remediation T-109, T-110, T-111, T-115, T-116).
 *
 * Team is a PERSONAL-workspace tier: a Team (or Pro) owner works in their own
 * Personal Workspace, invites people into it, and those people see it as a
 * workspace SHARED with them. None of that is the ORGANIZATION kind, so no
 * Team feature or label may be keyed on `activeSpace.type === "ORGANIZATION"`.
 *
 * Everything here reads the canonical `/v1/platform/context` envelope:
 *   activeSpace.{type, id, displayName, roleLabel, plan, shared}
 *   planFeatures.teamCollaborationIncluded   (the plan sells collaboration)
 *   workspace.{id, membership.memberCount}   (the active workspace's members)
 *   organizations[].{id, memberCount, role, …} (ORGANIZATION / joined rows)
 *
 * Pure: no React, no fetch.
 */

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const rows = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

export type WorkspaceRole = "OWNER" | "ADMIN" | "MEMBER" | "VIEWER";

export const WORKSPACE_ROLE_WORDS: Record<WorkspaceRole, string> = {
  OWNER: "Owner",
  ADMIN: "Admin",
  MEMBER: "Member",
  VIEWER: "Viewer",
};

/**
 *   ORGANIZATION       — an Enterprise / organization workspace (unchanged rules)
 *   SHARED_PERSONAL    — someone else's Personal Workspace the viewer joined
 *   OWN_COLLABORATIVE  — the viewer's own workspace, on a plan that sells
 *                        collaboration, with at least one other member
 *   OWN_PERSONAL       — the viewer's own workspace, nobody else in it
 *   UNKNOWN            — no envelope yet
 */
export type WorkspaceScopeKind = "ORGANIZATION" | "SHARED_PERSONAL" | "OWN_COLLABORATIVE" | "OWN_PERSONAL" | "UNKNOWN";

export interface WorkspaceScope {
  kind: WorkspaceScopeKind;
  /** The viewer's own role in the active workspace, when the server said it. */
  role: WorkspaceRole | null;
  /** `planFeatures.teamCollaborationIncluded` — fail-closed. */
  collaborationIncluded: boolean;
  /** Members of the ACTIVE workspace (owner included), or null when not reported. */
  memberCount: number | null;
  /** "Team", "Pro", … — the active plan as a word, or null when unknown. */
  planWord: string | null;
  /**
   * The workspace's name for the chrome: the organization's name, the shared
   * workspace's server name, "Your Team workspace" for a collaborating owner,
   * or null where the caller keeps its own personal-space label.
   */
  name: string | null;
}

export function asWorkspaceRole(v: unknown): WorkspaceRole | null {
  const s = typeof v === "string" ? v.trim().toUpperCase() : "";
  return s === "OWNER" || s === "ADMIN" || s === "MEMBER" || s === "VIEWER" ? s : null;
}

const PLAN_WORDS: Record<string, string> = {
  FREE: "Free",
  PAYG: "Pay as you go",
  PRO: "Pro",
  TEAM: "Team",
  BUSINESS: "Business",
  ENTERPRISE: "Enterprise",
};

export function planWordOf(plan: unknown): string | null {
  const p = str(plan);
  if (!p) return null;
  const up = p.toUpperCase();
  return PLAN_WORDS[up] ?? up.charAt(0) + up.slice(1).toLowerCase();
}

function finiteCount(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

/**
 * The active workspace's member count: the envelope's `workspace` section when
 * it describes the active workspace, else the matching `organizations[]` row.
 * Null when neither names it — an unknown count is not "one".
 */
export function activeWorkspaceMemberCount(envelope: unknown): number | null {
  const env = obj(envelope);
  const activeId = str(obj(env.activeSpace).id);
  if (!activeId) return null;
  const ws = obj(env.workspace);
  if (str(ws.id) === activeId) {
    const n = finiteCount(obj(ws.membership).memberCount);
    if (n !== null) return n;
  }
  const row = rows(env.organizations)
    .map(obj)
    .find((o) => str(o.id) === activeId && (o.membershipStatus === undefined || o.membershipStatus === "ACTIVE"));
  return row ? finiteCount(row.memberCount) : null;
}

export function resolveWorkspaceScope(envelope: unknown): WorkspaceScope {
  const env = obj(envelope);
  const active = obj(env.activeSpace);
  const collaborationIncluded = obj(env.planFeatures).teamCollaborationIncluded === true;
  const memberCount = activeWorkspaceMemberCount(envelope);
  const planWord = planWordOf(active.plan);
  const base = { collaborationIncluded, memberCount, planWord };

  if (active.type === "ORGANIZATION") {
    const activeId = str(active.id);
    const org =
      rows(env.organizations)
        .map(obj)
        .find((o) => str(o.id) === activeId && o.membershipStatus === "ACTIVE") ?? null;
    return {
      ...base,
      kind: "ORGANIZATION",
      role: asWorkspaceRole(org?.role),
      name: str(org?.displayName) ?? str(org?.name) ?? str(active.displayName),
    };
  }
  if (active.type === "PERSONAL" && active.shared === true) {
    // AUD-0047 — the server names a joined workspace after its owner and
    // carries the viewer's real role; it is never "Personal Space" / Owner.
    return {
      ...base,
      kind: "SHARED_PERSONAL",
      role: asWorkspaceRole(active.roleLabel),
      name: str(active.displayName) ?? "Shared workspace",
    };
  }
  if (active.type === "PERSONAL") {
    const collaborating = collaborationIncluded && memberCount !== null && memberCount > 1;
    return {
      ...base,
      kind: collaborating ? "OWN_COLLABORATIVE" : "OWN_PERSONAL",
      role: "OWNER",
      name: collaborating ? (planWord ? `Your ${planWord} workspace` : "Your shared workspace") : null,
    };
  }
  return { ...base, kind: "UNKNOWN", role: null, name: null };
}

/**
 * The header's workspace name (T-115). The server's `activeSpace.displayName`
 * everywhere except the viewer's own workspace once other people work in it:
 * there the server still says "Personal Space", which is wrong for a Team
 * owner with members.
 */
export function headerWorkspaceName(envelope: unknown, serverDisplayName: string | null): string {
  const scope = resolveWorkspaceScope(envelope);
  if (scope.kind === "OWN_COLLABORATIVE" && scope.name) return scope.name;
  return serverDisplayName ?? "Workspace";
}
