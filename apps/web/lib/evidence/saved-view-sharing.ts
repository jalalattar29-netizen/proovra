/**
 * B5B-F-303 / B2A-F-09 / B5A-F-14 (free-audit 0ea0, A2-14) — WHO MAY PUBLISH A
 * SHARED SAVED VIEW.
 *
 * A Viewer is read-only. The API now refuses a VIEWER that creates a shared
 * view: `POST /v1/siu/saved-views` with `visibility: "team" | "organization"`,
 * `POST /v1/search/saved-views` with `visibility: "TEAM"` and
 * `POST /v1/evidence/saved-views` with a `teamId` all answer
 * 403 `permission_denied` (`shared_view_requires_write_role`). Any role holding
 * `evidence.update_metadata` is unchanged, and private / personal views stay
 * open to everyone.
 *
 * So the client offers a Viewer only a personal view, and "Save view" keeps
 * working for them instead of failing with a 403. When the envelope does not
 * state the caller's role, nothing changes (the server stays the authority).
 *
 * `POST /v1/evidence/saved-views/:id/default` and `PATCH { isDefault }` are
 * owner-only too: "Make default" is offered only on the caller's own views.
 */
import { mapTeamRoleToCanonical, roleHasPermission } from "@proovra/shared";

import { roleInWorkspace } from "./record-actor-capabilities";
import type { PlatformContextEnvelope, WorkspaceRole } from "../platform-context/types";

const WORKSPACE_ROLES: readonly string[] = ["OWNER", "ADMIN", "MEMBER", "VIEWER"];

/** True unless the stated role lacks `evidence.update_metadata` (a Viewer). */
export function roleMayShareSavedViews(role: string | null | undefined): boolean {
  if (!role || !WORKSPACE_ROLES.includes(role)) return true;
  return roleHasPermission(mapTeamRoleToCanonical(role as WorkspaceRole), "evidence.update_metadata");
}

/** May the caller publish a shared view in workspace `teamId`? */
export function mayShareSavedViewsIn(
  envelope: PlatformContextEnvelope | null | undefined,
  teamId: string | null | undefined,
): boolean {
  if (!teamId) return false;
  return roleMayShareSavedViews(roleInWorkspace(envelope, teamId));
}

/** SIU saved-view visibility for a new view: "team" for a writer, "private" for a Viewer. */
export function siuSavedViewVisibility(
  envelope: PlatformContextEnvelope | null | undefined,
  teamId: string | null | undefined,
): "team" | "private" {
  if (!teamId) return "team";
  const role = roleInWorkspace(envelope, teamId);
  return roleMayShareSavedViews(role) ? "team" : "private";
}

/**
 * Does the caller own this saved view? An unknown caller or a row without an
 * owner keeps today's behaviour (the server refuses a non-owner).
 */
export function ownsSavedView(
  view: { ownerUserId?: string | null },
  currentUserId: string | null | undefined,
): boolean {
  if (!currentUserId || !view.ownerUserId) return true;
  return view.ownerUserId === currentUserId;
}
