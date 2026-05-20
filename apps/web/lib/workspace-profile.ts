/**
 * Phase 32.5 — Workspace profile + role-aware navigation foundation.
 *
 * The platform sidebar previously exposed every section to every
 * authenticated user. Admin-only links surfaced to MEMBER/VIEWER
 * roles, which received 403 on click — confusing the user without
 * gaining anything. The duplicate `/governance#retention` and
 * `/governance#legal-holds` anchor links also created the illusion
 * of four governance pages when there was only one hub.
 *
 * This module establishes the FOUNDATION for proper productization:
 *
 *   1. A bounded `WorkspaceProfile` enum that captures the persona
 *      a workspace was created for. Today the platform is rolled
 *      out with INDIVIDUAL + ENTERPRISE only; the other personas
 *      are RESERVED in the catalog so adding their dashboards
 *      doesn't require a schema change.
 *
 *   2. A bounded `WorkspaceRole` enum that maps to the existing
 *      backend role names. The sidebar uses this for client-side
 *      hiding of admin-only items (the backend always re-enforces).
 *
 *   3. A `SidebarVisibility` predicate that captures the role /
 *      profile combinations under which an item should appear.
 *      The actual filtering happens in AppSidebarV2; this module
 *      only owns the bounded vocabulary.
 *
 * Hard rules:
 *   * Client-side hiding is a UX nicety, NOT a security boundary.
 *     The backend permission checks remain authoritative.
 *   * The vocabulary is BOUNDED. Adding a profile or role requires
 *     a code change here AND a corresponding backend grant scheme.
 *   * No persona-specific business logic lives here — only the
 *     vocabulary the navigation registry uses to filter.
 */

export const WORKSPACE_PROFILES = [
  "INDIVIDUAL",
  "LEGAL",
  "INSURANCE",
  "INVESTIGATION",
  "JOURNALISM",
  "ENTERPRISE_ADMIN",
] as const;
export type WorkspaceProfile = (typeof WORKSPACE_PROFILES)[number];

export const WORKSPACE_ROLES = [
  "OWNER",
  "ADMIN",
  "MEMBER",
  "REVIEWER",
  "VIEWER",
  "EXTERNAL_REVIEWER",
] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

/**
 * Bounded visibility predicate.
 *
 * If `requiresPlatformAdmin` is true, the item only renders for
 * users where `isPlatformAdmin === true`.
 *
 * If `roles` is set, the item only renders when the user's
 * workspace role is one of the listed roles. Empty / undefined
 * means "any authenticated user".
 *
 * If `profiles` is set, the item only renders when the workspace's
 * profile is one of the listed profiles. Empty / undefined means
 * "any workspace profile".
 *
 * The predicates compose with AND: ALL must hold for the item to
 * show.
 */
export type SidebarVisibility = {
  requiresPlatformAdmin?: boolean;
  roles?: ReadonlyArray<WorkspaceRole>;
  profiles?: ReadonlyArray<WorkspaceProfile>;
};

/**
 * Filter a list of navigation items by the current user's role +
 * workspace profile + platform admin flag.
 *
 * Returns the items in the same order, with non-matching items
 * stripped. Items without a `visibility` block always show.
 */
export function filterByVisibility<T extends { visibility?: SidebarVisibility }>(
  items: ReadonlyArray<T>,
  context: {
    isPlatformAdmin: boolean;
    role: WorkspaceRole | null;
    profile: WorkspaceProfile | null;
  },
): T[] {
  return items.filter((item) => {
    const v = item.visibility;
    if (!v) return true;
    if (v.requiresPlatformAdmin && !context.isPlatformAdmin) return false;
    if (v.roles && v.roles.length > 0) {
      if (!context.role) return false;
      if (!v.roles.includes(context.role)) return false;
    }
    if (v.profiles && v.profiles.length > 0) {
      if (!context.profile) return false;
      if (!v.profiles.includes(context.profile)) return false;
    }
    return true;
  });
}
