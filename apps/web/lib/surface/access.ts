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

import {
  findSurfaceTierRule,
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
  // PHASE 12B Track 1A — the raw plan name was REMOVED from this context.
  // Every entitlement decision is a SERVER-projected boolean; the frontend
  // never branches on a plan name.
  //
  // PHASE 12 POINT 4 STEP 1 — the workspace ROLE was removed too. No rule in
  // this module ever consulted it after the Phase IA-surface-tier-correction
  // narrowing, and carrying it invited a role-shaped tier authority to
  // reappear. Surface eligibility is decided ONLY by the three
  // server-projected inputs below. Per-surface role/permission enforcement
  // stays where it belongs: the API route guards.
  isPlatformAdmin: boolean;
  /**
   * True iff the WORKSPACE is enterprise (PlatformContextFlags.isEnterpriseWorkspace,
   * server-derived from the commercial catalog / enterprise contract).
   */
  isEnterpriseWorkspace: boolean;
  /**
   * Canonical commercial entitlements from `envelope.planFeatures`
   * (backend PLAN_CAPABILITIES projection). `null`/absent = unknown
   * (envelope loading/degraded) — every rule then FAILS CLOSED.
   */
  planFeatures?: {
    intakeIncluded: boolean | null;
    /** PROFESSIONAL surface tier included (catalog-derived, server-projected). */
    professionalSurfacesIncluded: boolean | null;
  } | null;
};

export const ANONYMOUS_SURFACE_CONTEXT: SurfaceUserContext = {
  isPlatformAdmin: false,
  isEnterpriseWorkspace: false,
  planFeatures: null,
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

  // PROFESSIONAL — SERVER-projected entitlement only (catalog-derived
  // planFeatures.professionalSurfacesIncluded), OR enterprise workspace,
  // OR platform admin. Unknown/loading → fail closed.
  if (tier === "PROFESSIONAL") {
    if (ctx.isPlatformAdmin) return true;
    if (ctx.isEnterpriseWorkspace) return true;
    return ctx.planFeatures?.professionalSurfacesIncluded === true;
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
  //   1. isEnterpriseWorkspace flag === true (SERVER-derived from the
  //      commercial catalog / enterprise contract — incl. an ENTERPRISE plan)
  //   2. isPlatformAdmin === true
  //
  // NOT unlocked by:
  //   * TEAM-plan OWNER / ADMIN
  //   * PRO-plan OWNER (every personal-account holder is OWNER of
  //     their own workspace by construction; role alone can NEVER be
  //     the gate)
  //   * MEMBER / VIEWER of any plan
  if (tier === "ENTERPRISE") {
    if (ctx.isPlatformAdmin) return true;
    // The SERVER derives this flag from the commercial catalog / enterprise
    // contract (incl. an ENTERPRISE plan) — no client plan-name comparison.
    if (ctx.isEnterpriseWorkspace) return true;
    return false;
  }

  return false;
}

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
/**
 * OpsCenter visibility remediation (2026-07-18) — the ONE rule-level
 * decision. Platform admins always pass. When the rule carries an
 * `entitlementOverride` and the canonical entitlement value is KNOWN
 * (boolean), the entitlement decides; otherwise the tier decides
 * (fail-closed fallback while the envelope is loading).
 */
function isRuleAccessible(
  ctx: SurfaceUserContext,
  rule: SurfaceTierRule | null,
  tier: SurfaceTier,
): boolean {
  // Platform admins pass every tier (incl. INTERNAL) exactly as before;
  // an entitlement override must never hide a surface from them.
  if (ctx.isPlatformAdmin) return true;
  const overrideKey = rule?.entitlementOverride;
  if (overrideKey) {
    const value = ctx.planFeatures?.[overrideKey];
    if (typeof value === "boolean") return value;
  }
  return isUserInTier(ctx, tier);
}

export function canAccessSurface(
  ctx: SurfaceUserContext,
  pathname: string,
): boolean {
  const rule = findSurfaceTierRule(pathname);
  const tier = rule?.tier ?? "CORE";
  return isRuleAccessible(ctx, rule, tier);
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

  if (isRuleAccessible(ctx, rule, rule.tier)) return { kind: "allow" };

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
  const inTier = isRuleAccessible(ctx, rule, tier);
  return {
    pathname,
    tier,
    rule,
    inTier,
    decision: getDirectAccessDecision(ctx, pathname),
    policy: rule?.directAccessPolicy ?? "allow",
  };
}
