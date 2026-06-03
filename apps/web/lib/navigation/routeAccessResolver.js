/**
 * PHASE 38.6 — Route access resolver.
 *
 * Pure function. Given a route definition + the actor's
 * activeSpace + capabilities + account + plan, returns the canonical
 * access decision.
 *
 * HARD HEADLINE GUARANTEE: workflow / persona is NEVER an input.
 *
 *   resolveRouteAccess({ route, activeSpace, capabilities, account, plan })
 *
 * The exposure resolver (`resolveWorkflowExposure`) takes the OUTPUT
 * of this function and buckets routes by workflow priority — but it
 * cannot change a `canLoad: false` into `true`, and it cannot remove
 * a `canLoad: true` route from the navigation tree entirely.
 *
 * Bounded `accessState` vocabulary so the page-level gate can render
 * the right structured state without making its own decisions.
 */
export const ACCESS_STATES = [
    "ALLOWED",
    "DENIED_NO_CAPABILITY",
    "NEEDS_ORGANIZATION",
    "NEEDS_PERSONAL_OR_ORG",
    "NEEDS_UPGRADE",
    "PLATFORM_ADMIN_ONLY",
    "RECOVERY_REQUIRED",
];
/**
 * Personal-first rescue helper — does the envelope contain any
 * evidence of a usable workspace beyond `activeSpace.type`?
 *
 * "Usable" means EITHER (a) the legacy `workspace.id` is set and the
 * workspace status is not explicitly "no-workspace", OR (b) the
 * canonical `personalSpace.id` is set with a non-degraded status.
 * Any of those signals satisfies PROOVRA's personal-first contract.
 *
 * This NEVER returns true for organization-only routes — callers
 * keep checking `activeSpaceType === "ORGANIZATION"` separately for
 * `ORGANIZATION_ONLY` decisions.
 */
function hasUsablePersonalOrOrgEvidence(input) {
    const ws = input.workspace;
    if (ws && typeof ws.id === "string" && ws.id.length > 0) {
        const status = (ws.status ?? "active").toLowerCase();
        if (status !== "no-workspace")
            return true;
    }
    const ps = input.personalSpace;
    if (ps && typeof ps.id === "string" && ps.id.length > 0) {
        const status = (ps.status ?? "active").toLowerCase();
        if (status === "active")
            return true;
    }
    return false;
}
/**
 * Resolve the canonical access decision for a route. Pure function.
 *
 * Decision order:
 *
 *   1. PLATFORM_ADMIN routes require platform admin elevation.
 *   2. Active-space requirement: NONE/PERSONAL_OR_ORG/ORGANIZATION_ONLY
 *      decides whether the actor's current activeSpace is acceptable.
 *      If the route requires an ORGANIZATION and the actor is in
 *      Personal Space, the access state is `NEEDS_ORGANIZATION`.
 *   3. Capability requirements: every key in `requiredCapabilities`
 *      must be present and `true`. If any is missing, the access state
 *      is `DENIED_NO_CAPABILITY` (or `HIDDEN_IF_NO_CAPABILITY` per the
 *      route's `fallbackBehavior`).
 *
 * Workflow / persona is NEVER consulted. Pinned by test.
 */
export function resolveRouteAccess(input) {
    const { route, activeSpaceType, isPlatformAdmin, capabilities } = input;
    // -------------------------------------------------------------------------
    // 1. Platform-admin elevation.
    // -------------------------------------------------------------------------
    if (route.requiredActiveSpace === "PLATFORM_ADMIN" || route.domain === "PLATFORM_ADMIN") {
        if (!isPlatformAdmin) {
            return {
                canLoad: false,
                // Platform admin surfaces are intentionally invisible to non-admins.
                canSeeNav: false,
                accessState: "PLATFORM_ADMIN_ONLY",
                reason: "Platform admin elevation is required for this surface.",
                primaryAction: null,
                secondaryAction: null,
            };
        }
    }
    // -------------------------------------------------------------------------
    // 2. Active-space requirement.
    // -------------------------------------------------------------------------
    if (route.requiredActiveSpace === "ORGANIZATION_ONLY") {
        if (activeSpaceType !== "ORGANIZATION") {
            return {
                canLoad: false,
                // Still nav-visible so the user can discover the surface and
                // see the "Create organization" CTA — never silently hidden.
                canSeeNav: true,
                accessState: "NEEDS_ORGANIZATION",
                reason: "This surface activates inside an organization workspace. Create or switch to an organization to continue.",
                primaryAction: { label: "Create or switch organization", href: "/workspaces" },
                secondaryAction: null,
            };
        }
    }
    else if (route.requiredActiveSpace === "PERSONAL_OR_ORG") {
        if (activeSpaceType !== "PERSONAL" && activeSpaceType !== "ORGANIZATION") {
            // PERSONAL-FIRST RESCUE: before refusing, look at any other
            // envelope evidence of a usable workspace. PROOVRA's product
            // contract is that a personal workspace is first-class, so any
            // healthy `workspace.id` OR `personalSpace.id` is sufficient.
            // This guards against a backend that returns a degraded
            // envelope where `activeSpace.type` is missing while
            // `personalSpace.id` is populated — without this fallback the
            // user sees "Workspace setup required" on every core route.
            //
            // NOTE: this branch ONLY fires for `PERSONAL_OR_ORG`. The
            // `ORGANIZATION_ONLY` branch above is unchanged; org-only
            // surfaces still strictly require `activeSpaceType === "ORGANIZATION"`.
            if (!hasUsablePersonalOrOrgEvidence(input)) {
                return {
                    canLoad: false,
                    canSeeNav: true,
                    accessState: "NEEDS_PERSONAL_OR_ORG",
                    reason: "This surface needs an active workspace. Set one up to continue.",
                    primaryAction: { label: "Open workspaces", href: "/workspaces" },
                    secondaryAction: null,
                };
            }
            // else: fall through to capability check — personal/workspace
            // evidence is sufficient for PERSONAL_OR_ORG routes.
        }
    }
    // requiredActiveSpace === "NONE" → no workspace check.
    // -------------------------------------------------------------------------
    // 3. Capability requirement.
    // -------------------------------------------------------------------------
    for (const cap of route.requiredCapabilities) {
        if (capabilities[cap] !== true) {
            // The fallback behaviour determines whether the route is hidden
            // or shows a structured "request access" state.
            if (route.fallbackBehavior === "HIDDEN_IF_NO_CAPABILITY") {
                return {
                    canLoad: false,
                    canSeeNav: false,
                    accessState: "DENIED_NO_CAPABILITY",
                    reason: `Missing required capability: ${cap}`,
                    primaryAction: null,
                    secondaryAction: null,
                };
            }
            return {
                canLoad: false,
                canSeeNav: true,
                accessState: "DENIED_NO_CAPABILITY",
                reason: "Your role doesn't include the permissions this surface needs. An admin can grant access.",
                primaryAction: { label: "Request access", href: "/settings" },
                secondaryAction: { label: "Browse all tools", href: "/tools" },
            };
        }
    }
    // -------------------------------------------------------------------------
    // ALLOWED.
    // -------------------------------------------------------------------------
    return {
        canLoad: true,
        canSeeNav: true,
        accessState: "ALLOWED",
        reason: "",
        primaryAction: null,
        secondaryAction: null,
    };
}
