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

import type { CapabilityKey } from "../platform-context/types";
import type { RouteDefinition } from "./routeRegistry";

export const ACCESS_STATES = [
  "ALLOWED",
  "DENIED_NO_CAPABILITY",
  "NEEDS_ORGANIZATION",
  "NEEDS_PERSONAL_OR_ORG",
  "NEEDS_UPGRADE",
  "PLATFORM_ADMIN_ONLY",
  "RECOVERY_REQUIRED",
] as const;
export type AccessState = (typeof ACCESS_STATES)[number];

export type RouteAccessInput = {
  route: RouteDefinition;
  /**
   * Active space type from the canonical envelope. `null` when there
   * is no active workspace (e.g. recovery path).
   */
  activeSpaceType: "PERSONAL" | "ORGANIZATION" | null;
  /** Whether the actor is a platform admin (capability also surfaces this). */
  isPlatformAdmin: boolean;
  /**
   * Map from capability key → boolean. Only the canonical capability
   * registry is consulted; persona/workflow profile is NOT consulted.
   */
  capabilities: Partial<Record<CapabilityKey, boolean>>;
  /**
   * Account-tier plan if known. Used for `NEEDS_UPGRADE` decisions on
   * the small set of routes that gate by plan. Defaults to "FREE".
   */
  accountPlan?: string | null;
};

export type RouteAccessResult = {
  canLoad: boolean;
  canSeeNav: boolean;
  accessState: AccessState;
  /** Bounded human reason for the structured state. */
  reason: string;
  /** Suggested CTA the page gate / sidebar can render. */
  primaryAction: { label: string; href: string } | null;
  /** Optional secondary CTA (e.g. "Switch workspace"). */
  secondaryAction: { label: string; href: string } | null;
};

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
export function resolveRouteAccess(
  input: RouteAccessInput,
): RouteAccessResult {
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
        reason:
          "This surface activates inside an organization workspace. Create or switch to an organization to continue.",
        primaryAction: { label: "Create or switch organization", href: "/teams" },
        secondaryAction: null,
      };
    }
  } else if (route.requiredActiveSpace === "PERSONAL_OR_ORG") {
    if (activeSpaceType !== "PERSONAL" && activeSpaceType !== "ORGANIZATION") {
      return {
        canLoad: false,
        canSeeNav: true,
        accessState: "NEEDS_PERSONAL_OR_ORG",
        reason:
          "This surface needs an active workspace. Set one up to continue.",
        primaryAction: { label: "Open workspaces", href: "/teams" },
        secondaryAction: null,
      };
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
        reason:
          "Your role doesn't include the permissions this surface needs. An admin can grant access.",
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
