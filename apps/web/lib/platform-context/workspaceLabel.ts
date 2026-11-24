/**
 * T-115 / T-116 / T-109 — THE ONE label rule for the ACTIVE workspace.
 *
 * Team is a personal-workspace tier: a Team (or Pro) owner's workspace is a
 * PERSONAL workspace with other people in it. Every surface used to print the
 * structural kind instead ("Personal Space · Personal Space", "PERSONAL PLAN ·
 * TEAM"), which tells a Team owner their shared workspace is private. This
 * module derives one Team-aware description from the server projections —
 * `planFeatures.teamCollaborationIncluded`, the workspace member count,
 * `activeSpace.shared` and `displayName` — so the header chip, the context
 * banner and Settings say the same thing.
 *
 * Pure and envelope-only. It reads `envelope.workspace.*`, which the Phase
 * G4.3 guard keeps inside `lib/platform-context/`. Labels only: nothing here
 * grants or refuses anything.
 */
import type { PlatformContextEnvelope } from "./types";

type Envelope = PlatformContextEnvelope | null | undefined;

export const PERSONAL_SPACE_LABEL = "Personal Space";
export const TEAM_WORKSPACE_LABEL = "Team workspace";
export const SHARED_WORKSPACE_LABEL = "Shared workspace";
export const ORGANIZATION_WORKSPACE_LABEL = "Organization workspace";

export type ActiveWorkspaceDescription = {
  /**
   * PERSONAL_SOLO — the caller's own Personal Space with nobody else in it
   *   (or whose plan sells no collaboration): labelled exactly as before.
   * TEAM_OWNER — the caller's own Personal workspace on a collaboration plan
   *   with at least one other member.
   * SHARED — a personal workspace somebody else owns, which the caller joined.
   * ORGANIZATION — an organization workspace (Enterprise): unchanged.
   */
  kind: "PERSONAL_SOLO" | "TEAM_OWNER" | "SHARED" | "ORGANIZATION" | "UNKNOWN";
  /** The workspace's own name, never repeated by `kindLabel`. */
  name: string | null;
  /** What sort of workspace it is ("Personal Space", "Team workspace", …). */
  kindLabel: string;
  /** The caller's role, display form ("Owner", "Admin", …), or null. */
  roleLabel: string | null;
  /** True where the plan includes collaboration and others work here. */
  teamWorkspace: boolean;
};

const ROLE_DISPLAY: Record<string, string> = {
  OWNER: "Owner",
  Owner: "Owner",
  ADMIN: "Admin",
  MEMBER: "Member",
  VIEWER: "Viewer",
};

function displayRole(role: string | null | undefined): string | null {
  if (!role) return null;
  return ROLE_DISPLAY[role] ?? role;
}

/**
 * The ACTIVE workspace's member count (owner included), from the envelope's
 * workspace membership — only when that block describes the active space.
 * Null when unknown.
 */
export function activeWorkspaceMemberCount(envelope: Envelope): number | null {
  if (!envelope) return null;
  const ws = envelope.workspace;
  const active = envelope.activeSpace;
  if (!ws || ws.status !== "active" || !ws.id) return null;
  if (active?.id && active.id !== ws.id) return null;
  const n = ws.membership?.memberCount;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/**
 * True where the active PERSONAL workspace's plan includes collaboration and
 * somebody other than the owner is a member. Never true for an organization
 * (Enterprise keeps its own labels) and never for a plan without collaboration.
 */
export function isTeamPersonalWorkspace(envelope: Envelope): boolean {
  if (!envelope || envelope.activeSpace?.type !== "PERSONAL") return false;
  if (envelope.planFeatures?.teamCollaborationIncluded !== true) return false;
  if (envelope.activeSpace.shared === true) return true;
  const members = activeWorkspaceMemberCount(envelope);
  return members !== null && members > 1;
}

/** The own workspace's real name; never the structural "Personal Space". */
function ownWorkspaceName(envelope: PlatformContextEnvelope): string | null {
  const ws = envelope.workspace;
  const active = envelope.activeSpace;
  if (!ws || ws.status !== "active" || !ws.id) return null;
  if (active?.id && active.id !== ws.id) return null;
  const name = typeof ws.name === "string" ? ws.name.trim() : "";
  if (!name || name === PERSONAL_SPACE_LABEL) return null;
  return name;
}

export function describeActiveWorkspace(envelope: Envelope): ActiveWorkspaceDescription {
  const active = envelope?.activeSpace ?? null;
  if (!envelope || !active) {
    return { kind: "UNKNOWN", name: null, kindLabel: "Workspace", roleLabel: null, teamWorkspace: false };
  }
  if (active.type === "ORGANIZATION") {
    return {
      kind: "ORGANIZATION",
      name: active.displayName ?? null,
      kindLabel: ORGANIZATION_WORKSPACE_LABEL,
      roleLabel: displayRole(active.roleLabel),
      teamWorkspace: false,
    };
  }
  const team = isTeamPersonalWorkspace(envelope);
  if (active.shared === true) {
    return {
      kind: "SHARED",
      name: active.displayName || null,
      kindLabel: team ? TEAM_WORKSPACE_LABEL : SHARED_WORKSPACE_LABEL,
      roleLabel: displayRole(active.roleLabel),
      teamWorkspace: team,
    };
  }
  if (team) {
    return {
      kind: "TEAM_OWNER",
      name: ownWorkspaceName(envelope) ?? TEAM_WORKSPACE_LABEL,
      kindLabel: TEAM_WORKSPACE_LABEL,
      roleLabel: "Owner",
      teamWorkspace: true,
    };
  }
  return {
    kind: "PERSONAL_SOLO",
    name: PERSONAL_SPACE_LABEL,
    kindLabel: PERSONAL_SPACE_LABEL,
    roleLabel: "Owner",
    teamWorkspace: false,
  };
}

/**
 * "<name> · <kind>" without ever saying the same thing twice: the kind is
 * dropped when it equals the name ("Personal Space", not "Personal Space ·
 * Personal Space").
 */
export function workspaceNameWithKind(d: Pick<ActiveWorkspaceDescription, "name" | "kindLabel">): string {
  if (!d.name) return d.kindLabel;
  return d.name === d.kindLabel ? d.name : `${d.name} · ${d.kindLabel}`;
}
