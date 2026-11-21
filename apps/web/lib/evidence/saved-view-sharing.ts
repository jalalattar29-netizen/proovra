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
 * PRO-E1-08 (WS-ENT) — may the caller RENAME / DELETE this saved view? The
 * server rule (assertSavedViewAccess, evidence.saved-views.routes.ts): a
 * personal view is its owner's; a team view is editable by that workspace's
 * OWNER / ADMIN, or by its creator while they still hold the write a team
 * view needs. A MEMBER was offered Rename/Delete on a colleague's team view
 * and refused 403. An unknown role keeps the owner rule (server decides).
 */
export function mayEditSavedView(
  view: { ownerUserId?: string | null; teamId?: string | null },
  currentUserId: string | null | undefined,
  envelope: PlatformContextEnvelope | null | undefined,
): boolean {
  const owns = ownsSavedView(view, currentUserId);
  if (!view.teamId) return owns;
  const role = roleInWorkspace(envelope, view.teamId);
  if (role === "OWNER" || role === "ADMIN") return true;
  if (role === null) return owns;
  return owns && roleMayShareSavedViews(role);
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

/**
 * Closure 2 ("sem" item 4, PRO-E1-11) — the SEARCH console's saved-view
 * actions, offered on the server's own rule (search.routes.ts +
 * saved-search.service.ts) so the console never shows a control the server
 * refuses. The audience of the management block itself is unchanged (platform
 * administrators; PRO-E1-11 stays ACCEPTED_POLICY): this only stops that block
 * offering Rename / Delete on a view the viewer may not change.
 *
 *   rename  PATCH  /v1/search/saved-views/:id — the CREATOR only (anyone else
 *           404); a shared (TEAM) view also needs the write a shared view
 *           needs (`evidence.update_metadata`, PRO-E1-06).
 *   delete  DELETE /v1/search/saved-views/:id — the creator (a TEAM view again
 *           only with that write), or `operations.saved_views.manage` for a
 *           colleague's TEAM view.
 *
 * An unknown role keeps today's behaviour for the creator arm (the server
 * decides); an unknown caller id never claims a colleague's view.
 */
export type SearchSavedViewRef = { createdByUserId?: string | null; visibility: "PRIVATE" | "TEAM" };

function roleHolds(role: string | null | undefined, permission: string): boolean | null {
  if (!role || !WORKSPACE_ROLES.includes(role)) return null;
  return roleHasPermission(mapTeamRoleToCanonical(role as WorkspaceRole), permission as never);
}

export function mayRenameSearchSavedView(
  view: SearchSavedViewRef,
  currentUserId: string | null | undefined,
  role: string | null | undefined,
): boolean {
  if (!currentUserId || !view.createdByUserId || view.createdByUserId !== currentUserId) return false;
  if (view.visibility === "PRIVATE") return true;
  return roleHolds(role, "evidence.update_metadata") !== false;
}

export function mayDeleteSearchSavedView(
  view: SearchSavedViewRef,
  currentUserId: string | null | undefined,
  role: string | null | undefined,
): boolean {
  const manages = roleHolds(role, "operations.saved_views.manage") === true;
  const own = Boolean(currentUserId && view.createdByUserId && view.createdByUserId === currentUserId);
  if (own) {
    if (view.visibility === "PRIVATE") return true;
    return manages || roleHolds(role, "evidence.update_metadata") !== false;
  }
  // A colleague's view is listed only when it is TEAM; only the manager deletes it.
  return view.visibility === "TEAM" && manages;
}

/**
 * Closure 2 ("sem" item 4) — the REVIEWER console's saved queue views. Server
 * rule (DELETE /v1/reviewer-ops/saved-views/:id, deleteReviewerOpsSavedView):
 * the creator deletes their own view; a colleague's TEAM view only the
 * workspace OWNER / ADMIN. The console offered Delete on every row, and a
 * reviewer who pressed it on a colleague's shared view got "Could not delete
 * saved view.". An unknown role or caller offers only what the caller owns.
 */
export function mayDeleteReviewerSavedView(
  view: { createdByUserId?: string | null; visibility?: string | null },
  currentUserId: string | null | undefined,
  role: string | null | undefined,
): boolean {
  // A row without a creator (older API) keeps today's behaviour.
  if (!view.createdByUserId) return true;
  if (currentUserId && view.createdByUserId === currentUserId) return true;
  return view.visibility === "TEAM" && (role === "OWNER" || role === "ADMIN");
}
