/**
 * THE ONE canonical Workspace People locator.
 *
 * =============================================================================
 * WHY THIS MODULE EXISTS
 * =============================================================================
 * The Workspace People surface — workspace MEMBERS, workspace INVITATIONS,
 * seats, roles, ownership transfer and closure — lives at `/teams/[id]`
 * (`app/(app)/teams/[id]/page.tsx`), keyed by the WORKSPACE id. It is the only
 * surface in the product that hosts the canonical workspace invitation form.
 *
 * Its INDEX (`/teams`) was deleted in Phase 2B and the bare path now 308s to
 * `/collaboration-teams` (next.config.js). That redirect was correct for a
 * retired duplicate Teams landing and wrong for everything else: three live
 * surfaces still linked `/teams` meaning "manage the people in this
 * workspace", and every one of them bounced the operator into the
 * Collaboration Teams product they had just come from.
 *
 * A workspace-keyed surface cannot be named by a static href, which is why
 * those links degraded to a bare `/teams` in the first place. This module is
 * the answer: ONE producer of the Workspace People href, and one static
 * resolver path for the places that must name the surface before the active
 * workspace is known (navigation registry entries, the command palette, a
 * link written in a component with no workspace in scope).
 *
 * IMPORTANT — this locator NAMES the surface; it GRANTS nothing. The server
 * remains authoritative: `/teams/:id` is gated by `TEAM_VIEW` plus persisted
 * workspace membership, and every invitation, role change and removal is
 * re-authorized there. A URL can never select a workspace the server would
 * refuse.
 */

/**
 * The static resolver path. Use it when the active workspace is not in scope;
 * `app/(app)/people/page.tsx` resolves the caller's active workspace from the
 * canonical platform-context envelope and replaces the URL with the keyed
 * surface below.
 *
 * It is a ROUTER, not a second surface: it renders no people, reads no
 * membership, and holds no copy of anything `/teams/[id]` owns.
 */
export const WORKSPACE_PEOPLE_PATH = "/people";

/**
 * Build the canonical Workspace People href.
 *
 * With a workspace id it names the keyed surface directly (one navigation, no
 * resolver hop). Without one — the envelope is still loading, or the caller
 * genuinely has no workspace in scope — it falls back to the static resolver,
 * which is the same destination reached one redirect later.
 *
 * A blank/whitespace id is treated as absent rather than interpolated: a
 * `/teams/` with no id is a 404, and a resolver hop is strictly better than
 * that.
 */
export function buildWorkspacePeopleHref(
  workspaceId?: string | null,
): string {
  const id = workspaceId?.trim();
  if (!id) return WORKSPACE_PEOPLE_PATH;
  return `/teams/${encodeURIComponent(id)}`;
}

/**
 * The canonical deep link for "bring someone NEW into this workspace".
 *
 * Collaboration Teams is built from people who already hold workspace
 * authority, so its Members surface has to be able to hand the operator off to
 * the canonical WORKSPACE invitation flow. That flow is a section of the
 * Workspace People surface, so this is the same href carrying an intent hint
 * the destination reads to focus its invite control.
 *
 * The hint is a UI affordance ONLY. It selects nothing, authorizes nothing and
 * is never trusted by the server; `POST /v1/teams/:id/invites` re-checks role,
 * seat allowance and invitation allowance regardless of how the operator
 * arrived.
 */
export const WORKSPACE_PEOPLE_INVITE_INTENT = "invite";

export function buildWorkspaceInviteHref(
  workspaceId?: string | null,
): string {
  return `${buildWorkspacePeopleHref(workspaceId)}?intent=${WORKSPACE_PEOPLE_INVITE_INTENT}`;
}
