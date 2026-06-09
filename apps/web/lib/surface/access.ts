/**
 * Phase IA-surface-tier — pure access-decision helpers.
 *
 * The single entry-point the rest of the app uses to ask "can this user
 * see / open this surface?". Wraps `tiers.ts` (the static rule table)
 * with the user-side input (plan + role + platform-admin flag) and
 * returns a bounded outcome.
 *
 * Pure functions. No React, no Next.js. Safe to call from middleware,
 * server components, client components, and tests.
 */

import type {
  WorkspacePlan,
  WorkspaceRole,
} from "../platform-context/types";

import {
  findSurfaceTierRule,
  getSurfaceTier,
  rolesUnlockingEnterprise,
  tiersAllowedByPlan,
  type DirectAccessPolicy,
  type SurfaceTier,
  type SurfaceTierRule,
} from "./tiers";

/**
 * Minimal user context the access decision needs. Built from
 * PlatformContext on the client and from the JWT / session on the
 * server (middleware). Any field can be null when unknown.
 */
export type SurfaceUserContext = {
  plan: WorkspacePlan | null;
  role: WorkspaceRole | null;
  isPlatformAdmin: boolean;
  /**
   * True iff the WORKSPACE is enterprise (PlatformContextFlags.isEnterpriseWorkspace).
   * Distinct from `plan` because enterprise gating is a flag today, not
   * a plan tier.
   */
  isEnterpriseWorkspace: boolean;
};

export const ANONYMOUS_SURFACE_CONTEXT: SurfaceUserContext = {
  plan: null,
  role: null,
  isPlatformAdmin: false,
  isEnterpriseWorkspace: false,
};

/**
 * The bounded outcome of an access decision.
 *
 *   allow      — user may both SEE and OPEN the surface.
 *   redirect   — user should be redirected (plan upsell path).
 *   notFound   — surface is hidden from the user entirely (no upsell).
 *   forbidden  — surface exists for the user's plan but they lack the
 *                role; render 403.
 */
export type AccessDecision =
  | { kind: "allow" }
  | { kind: "redirect"; to: string; reason: string }
  | { kind: "notFound"; reason: string }
  | { kind: "forbidden"; reason: string };

// ============================================================================
// Tier eligibility — does the user qualify for this tier of surfaces?
// ============================================================================

function isUserInTier(
  ctx: SurfaceUserContext,
  tier: SurfaceTier,
): boolean {
  // INTERNAL = platform admin only, regardless of workspace plan/role.
  if (tier === "INTERNAL") return ctx.isPlatformAdmin;

  // CORE is always allowed when the user has any session.
  if (tier === "CORE") return true;

  // PROFESSIONAL requires PRO or TEAM plan, OR enterprise workspace,
  // OR platform admin.
  if (tier === "PROFESSIONAL") {
    if (ctx.isPlatformAdmin) return true;
    if (ctx.isEnterpriseWorkspace) return true;
    return tiersAllowedByPlan(ctx.plan).has("PROFESSIONAL");
  }

  // ENTERPRISE — strictly enterprise-only.
  //
  // The platform's go-to-market target (individuals + small offices +
  // small professional teams) MUST see the simplified product even on
  // TEAM-plan workspaces. ENTERPRISE-tier surfaces (review ops,
  // governance, intelligence platform, executive dashboards,
  // investigation power tools, security center, organization admin)
  // are reserved for:
  //
  //   1. workspace plan === "ENTERPRISE"  (forward-compat with future
  //      WorkspacePlan enum value — checked as a string so today's
  //      enum lacks it, and the branch is inert until the enum grows)
  //   2. isEnterpriseWorkspace flag === true (already wired in the
  //      canonical envelope; the enterprise feature-flag path)
  //   3. isPlatformAdmin === true
  //
  // NOT unlocked by:
  //   * TEAM-plan OWNER / ADMIN
  //   * PRO-plan OWNER (every personal-account holder is OWNER of
  //     their own workspace by construction; role alone can NEVER be
  //     the gate)
  //   * MEMBER / VIEWER of any plan
  if (tier === "ENTERPRISE") {
    if (ctx.isPlatformAdmin) return true;
    if (ctx.isEnterpriseWorkspace) return true;
    // String comparison so a future `WorkspacePlan` enum value
    // "ENTERPRISE" picks this up without a TypeScript error today.
    if ((ctx.plan as string | null) === "ENTERPRISE") return true;
    return false;
  }

  return false;
}

// Reference helpers so unused-import lint passes — `rolesUnlockingEnterprise`
// is preserved in the public API surface (it's the documented contract
// from the tier module) but it is intentionally NOT consulted by the
// ENTERPRISE branch above. The role table cannot unlock ENTERPRISE on
// its own; only plan/flag/platform-admin do.
void rolesUnlockingEnterprise;

// ============================================================================
// Public API
// ============================================================================

/**
 * Can the user SEE this surface (sidebar / All Tools / command palette /
 * breadcrumbs)? Returns false for hidden surfaces. Driven entirely by
 * the static tier table + the user's plan/role.
 *
 * Hidden surfaces MUST also be unreachable by direct URL — that gate is
 * applied by `getDirectAccessDecision` (consumed by middleware +
 * SurfaceGate).
 */
export function canAccessSurface(
  ctx: SurfaceUserContext,
  pathname: string,
): boolean {
  const tier = getSurfaceTier(pathname);
  return isUserInTier(ctx, tier);
}

/**
 * Direct-URL decision. Returns the outcome the middleware / SurfaceGate
 * should apply when the user types the URL into the address bar.
 *
 *   allow      — the user is in the right tier. Render normally.
 *   redirect   — the rule asks for redirect (default → /home).
 *   notFound   — the rule asks for 404 (INTERNAL / hidden surfaces).
 *   forbidden  — reserved for a future role-only deny path; today we
 *                degrade to notFound for unmapped paths.
 *
 * The rule's `directAccessPolicy` field decides which outcome to use
 * when the user is OUT of tier. When IN tier the answer is always
 * `allow`.
 */
export function getDirectAccessDecision(
  ctx: SurfaceUserContext,
  pathname: string,
): AccessDecision {
  const rule = findSurfaceTierRule(pathname);
  // Unmapped paths default to CORE — allow.
  if (!rule) return { kind: "allow" };

  if (isUserInTier(ctx, rule.tier)) return { kind: "allow" };

  switch (rule.directAccessPolicy) {
    case "allow":
      return { kind: "allow" };
    case "redirect":
      return {
        kind: "redirect",
        to: rule.redirectTo ?? "/home",
        reason: rule.reason,
      };
    case "notFound":
      return { kind: "notFound", reason: rule.reason };
    case "forbidden":
      return { kind: "forbidden", reason: rule.reason };
  }
}

/**
 * Filter a list of `{ id, href }` surfaces by visibility for this user.
 * Used by the sidebar / All Tools / command palette to hide entries
 * the user can't access. Pure projection — does not mutate the input.
 */
export function getVisibleSurfaces<T extends { href: string }>(
  ctx: SurfaceUserContext,
  surfaces: ReadonlyArray<T>,
): T[] {
  return surfaces.filter((s) => canAccessSurface(ctx, s.href));
}

/**
 * Debug aid — return the full decision shape (tier + rule + outcome)
 * for a path. Used by the smoke tooling.
 */
export function describeSurfaceDecision(
  ctx: SurfaceUserContext,
  pathname: string,
): {
  pathname: string;
  tier: SurfaceTier;
  rule: SurfaceTierRule | null;
  inTier: boolean;
  decision: AccessDecision;
  policy: DirectAccessPolicy;
} {
  const rule = findSurfaceTierRule(pathname);
  const tier = rule?.tier ?? "CORE";
  const inTier = isUserInTier(ctx, tier);
  return {
    pathname,
    tier,
    rule,
    inTier,
    decision: getDirectAccessDecision(ctx, pathname),
    policy: rule?.directAccessPolicy ?? "allow",
  };
}
