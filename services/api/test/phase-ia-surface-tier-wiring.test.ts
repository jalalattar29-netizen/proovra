/**
 * Phase IA-surface-tier-wiring — integration source-contract tests.
 *
 * The static tier table + access helpers are pinned by
 * `phase-ia-surface-tier.test.ts`. THIS file pins the WIRING:
 *
 *   * `AppSidebarV2` calls `canAccessSurface` before resolving routes.
 *   * `CommandPalette` calls `canAccessSurface` before indexing routes.
 *   * `/tools` page calls `canAccessSurface` before resolving routes.
 *   * `SurfaceGate` consumes the shared `useSurfaceUserContext` hook.
 *   * Every ENTERPRISE route directory has a `layout.tsx` that wraps
 *     children in `SurfaceGate` (via `EnterpriseSurfaceLayout`).
 *   * Middleware imports `findSurfaceTierRule` and applies the
 *     INTERNAL gate.
 *
 * Wiring tests pin the call sites by regex over the actual source so
 * a future refactor that drops one of the filters trips the suite.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readWeb(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../../apps/web/${rel}`, import.meta.url)),
    "utf8",
  );
}

function webPath(rel: string): string {
  return fileURLToPath(new URL(`../../../apps/web/${rel}`, import.meta.url));
}

// ============================================================================
// AppSidebarV2 — filters the registry by surface tier
// ============================================================================

describe("Phase IA-surface-tier-wiring — AppSidebarV2", () => {
  const SIDEBAR = readWeb("components/app-shell-v2/AppSidebarV2.tsx");

  // PHASE 12B Track 1A — the two-stage gating (client canAccessSurface tier
  // pre-filter + resolver) was CONVERGED into the ONE resolver:
  // resolveRouteAccess consumes SERVER-projected flags/planFeatures booleans
  // directly. These pins assert the single-resolver wiring.
  it("resolves the FULL registry through resolveRouteAccess with server-projected booleans", () => {
    expect(SIDEBAR).toMatch(/resolveRouteAccess\(\{/);
    expect(SIDEBAR).toMatch(/isEnterpriseWorkspace:\s*envelope\?\.flags\?\.isEnterpriseWorkspace === true/);
    expect(SIDEBAR).toMatch(/planFeatures:\s*envelope\?\.planFeatures \?\? null/);
  });

  it("no client tier pre-filter remains (canAccessSurface not imported)", () => {
    expect(SIDEBAR).not.toMatch(/canAccessSurface/);
    expect(SIDEBAR).not.toMatch(/tierFilteredRegistry/);
  });
});

describe("Phase IA-surface-tier-wiring — CommandPalette (single resolver)", () => {
  const CP = readWeb("components/navigation/CommandPalette.tsx");

  it("indexes through resolveRouteAccess with server-projected booleans", () => {
    expect(CP).toMatch(/resolveRouteAccess\(\{/);
    expect(CP).toMatch(/planFeatures:\s*envelope\?\.planFeatures \?\? null/);
    expect(CP).not.toMatch(/canAccessSurface/);
  });
});

describe("Phase IA-surface-tier-wiring — All Tools page (single resolver)", () => {
  const TOOLS = readWeb("app/(app)/tools/page.tsx");

  it("exposure runs through resolveRouteAccess with server-projected booleans", () => {
    expect(TOOLS).toMatch(/resolveRouteAccess\(\{/);
    expect(TOOLS).toMatch(/planFeatures:\s*envelope\?\.planFeatures \?\? null/);
    expect(TOOLS).not.toMatch(/canAccessSurface/);
  });
});

// ============================================================================
// SurfaceGate — uses the shared hook (no duplicate context plumbing)
// ============================================================================

describe("Phase IA-surface-tier-wiring — SurfaceGate", () => {
  const GATE = readWeb("components/surface/SurfaceGate.tsx");

  it("imports useSurfaceUserContext from the shared hook module", () => {
    expect(GATE).toMatch(
      /import\s*\{\s*useSurfaceUserContext\s*\}\s*from\s*["']\.\.\/\.\.\/lib\/surface\/useSurfaceUserContext["']/,
    );
  });

  it("consumes the hook inside the component body", () => {
    expect(GATE).toMatch(/useSurfaceUserContext\(\)/);
  });

  it("does NOT re-implement the envelope-to-context conversion locally", () => {
    // The local `buildUserContext` from the first-pass implementation
    // is gone — the shared hook owns it.
    expect(GATE).not.toMatch(/function buildUserContext\(/);
  });
});

// ============================================================================
// ENTERPRISE route group layouts
// ============================================================================

describe("Phase IA-surface-tier-wiring — ENTERPRISE layout.tsx files", () => {
  const ENTERPRISE_DIRS = [
    "app/(app)/review",
    "app/(app)/reviewer-ops",
    "app/(app)/governance",
    "app/(app)/governance-platform",
    "app/(app)/security-center",
    "app/(app)/intelligence",
    "app/(app)/intelligence-quality",
    "app/(app)/investigation",
    "app/(app)/executive",
    "app/(app)/budget-center",
    "app/(app)/redaction",
    "app/(app)/audit-transparency",
  ];

  for (const dir of ENTERPRISE_DIRS) {
    it(`${dir}/layout.tsx exists and re-exports EnterpriseSurfaceLayout`, () => {
      const layoutPath = webPath(`${dir}/layout.tsx`);
      expect(existsSync(layoutPath)).toBe(true);
      const src = readFileSync(layoutPath, "utf8");
      expect(src).toMatch(
        /export\s*\{\s*default\s*\}\s*from\s*["']\.\.\/\.\.\/\.\.\/components\/surface\/EnterpriseSurfaceLayout["']/,
      );
    });
  }

  it("EnterpriseSurfaceLayout wraps children in SurfaceGate", () => {
    const SHARED = readWeb("components/surface/EnterpriseSurfaceLayout.tsx");
    expect(SHARED).toMatch(/<SurfaceGate>\{children\}<\/SurfaceGate>/);
  });

  // /admin keeps its own layout (PageRouteGate routeId="platform.admin").
  // The platform.admin gate already 404s non-admins, so SurfaceGate is
  // redundant there. Pin that the legacy gate remains so we don't
  // break the admin tree.
  it("/admin keeps its existing PageRouteGate (not replaced by SurfaceGate)", () => {
    const ADMIN = readWeb("app/(app)/admin/layout.tsx");
    expect(ADMIN).toMatch(/PageRouteGate\s+routeId="platform\.admin"/);
  });
});

// ============================================================================
// Middleware — INTERNAL surfaces rewrite at the edge
// ============================================================================

describe("Phase IA-surface-tier-wiring — middleware INTERNAL gate", () => {
  const MW = readWeb("middleware.ts");

  it("imports findSurfaceTierRule", () => {
    expect(MW).toMatch(
      /import\s*\{\s*findSurfaceTierRule\s*\}\s*from\s*["']\.\/lib\/surface\/tiers["']/,
    );
  });

  it("applies the tier gate ONLY on the app host", () => {
    expect(MW).toMatch(
      /if \(isAppHost\)\s*\{[\s\S]{0,500}applySurfaceTierGate\(req,\s*pathname\)/,
    );
  });

  it("INTERNAL surfaces rewrite to /not-found at the edge", () => {
    expect(MW).toMatch(
      /rule\.tier === "INTERNAL"[\s\S]{0,400}target\.pathname\s*=\s*"\/not-found"/,
    );
  });
});

// ============================================================================
// Tier rule changes — the simplified normal-user sidebar
// ============================================================================

describe("Phase IA-surface-tier-wiring — simplified normal-user sidebar", () => {
  const TIERS = readWeb("lib/surface/tiers.ts");

  // Phase IA-self-serve-simplification — workspaces/notifications/persona
  // were re-tiered AGAIN: they used to be PROFESSIONAL but the
  // self-serve simplification brief moved them to ENTERPRISE with
  // bounded redirects so they no longer appear as standalone product
  // surfaces.
  it("/workspaces is ENTERPRISE — self-serve redirects to /collaboration-teams (Phase 2B: no /teams loop)", () => {
    expect(TIERS).toMatch(
      /pathPrefix:\s*"\/workspaces",\s*tier:\s*"ENTERPRISE",\s*directAccessPolicy:\s*"redirect",\s*redirectTo:\s*"\/collaboration-teams"/,
    );
  });

  it("/notifications is ENTERPRISE — redirects to /settings", () => {
    expect(TIERS).toMatch(
      /pathPrefix:\s*"\/notifications",\s*tier:\s*"ENTERPRISE",\s*directAccessPolicy:\s*"redirect",\s*redirectTo:\s*"\/settings"/,
    );
  });

  /**
   * PHASE 13 (NEW-063) — the TIER is the pinned invariant; the direct-access
   * policy is now `allow`.
   *
   * The Organizations entity stays ENTERPRISE for VISIBILITY — nav, the command
   * palette and All Tools all read the tier — which is the pricing intent this
   * assertion exists to protect, and it is unchanged. Direct access is
   * membership-gated instead, per the 12B correction in `routeRegistry.ts`
   * ("the organizations LIST + member-safe DETAIL are MEMBERSHIP-gated, not
   * enterprise-workspace-gated") and the account-menu resolver contract
   * ("membership is the ONLY input — never plan"). `isEnterpriseWorkspace` is
   * derived from the ACTIVE workspace, so an ORG_OWNER whose active space is
   * their Personal Space was out of tier and `SurfaceGate` 404'd them on the
   * very link the account menu had just offered.
   */
  it("/organizations is ENTERPRISE tier with membership-gated direct access", () => {
    expect(TIERS).toMatch(
      /pathPrefix:\s*"\/organizations",\s*tier:\s*"ENTERPRISE",\s*directAccessPolicy:\s*"allow"/,
    );
  });

  it("no /persona surface-tier rule exists (feature deleted)", () => {
    // (2026-07-20) The /persona route + its ENTERPRISE→/settings redirect
    // rule were removed with the workspace-persona / workflow-personalization
    // feature. The deleted route family resolves through normal not-found
    // behavior — there is NO compatibility redirect.
    expect(TIERS).not.toMatch(/pathPrefix:\s*"\/persona"/);
  });

  it("the 9 FREE/PAYG CORE surfaces are still CORE (pricing-aligned)", () => {
    // Phase IA-surface-tier-pricing — /teams, /intake-links, /inbox
    // moved to PROFESSIONAL. The CORE set now matches the FREE/PAYG
    // sidebar in the pricing brief.
    const CORE = [
      "/home",
      "/capture",
      "/evidence",
      "/cases",
      "/search",
      "/reports",
      "/trust-center",
      "/settings",
      "/billing",
    ];
    for (const p of CORE) {
      const safe = p.replace(/\//g, "\\/");
      expect(
        TIERS,
        `${p} must remain CORE`,
      ).toMatch(new RegExp(`pathPrefix:\\s*"${safe}",\\s*tier:\\s*"CORE"`));
    }
  });

  it("tier wiring — /teams PROFESSIONAL; /intake-links entitlement-driven; /inbox CORE (2026-07-18)", () => {
    // OpsCenter visibility remediation: the Operations Center is an
    // OPERATIONAL surface (CORE — every plan; categories inside are
    // eligibility-governed) and intake follows the COMMERCIAL
    // ENTITLEMENT (planFeatures.intakeIncluded; PROFESSIONAL remains the
    // fail-closed fallback while the envelope is unknown). /teams keeps
    // its PRO/TEAM pricing tier.
    expect(TIERS).toMatch(/pathPrefix:\s*"\/teams",\s*tier:\s*"PROFESSIONAL"/);
    expect(TIERS).toMatch(
      /pathPrefix:\s*"\/intake-links",\s*tier:\s*"PROFESSIONAL",\s*entitlementOverride:\s*"intakeIncluded"/,
    );
    expect(TIERS).toMatch(/pathPrefix:\s*"\/inbox",\s*tier:\s*"CORE"/);
  });

  // PHASE 13 (NEW-063) — see the note on the equivalent assertion above. The
  // ENTERPRISE tier, and therefore the visibility posture, is unchanged; only
  // the direct-URL denial moved to the membership / server authority.
  it("/organizations is ENTERPRISE tier, direct access allowed (membership-gated)", () => {
    expect(TIERS).toMatch(
      /pathPrefix:\s*"\/organizations",\s*tier:\s*"ENTERPRISE",\s*directAccessPolicy:\s*"allow"/,
    );
  });

  it("/admin/organizations + /organization-admin are ENTERPRISE notFound", () => {
    expect(TIERS).toMatch(
      /pathPrefix:\s*"\/admin\/organizations",\s*tier:\s*"ENTERPRISE",\s*directAccessPolicy:\s*"notFound"/,
    );
    expect(TIERS).toMatch(
      /pathPrefix:\s*"\/organization-admin",\s*tier:\s*"ENTERPRISE",\s*directAccessPolicy:\s*"notFound"/,
    );
  });
});

// ============================================================================
// AppAccountToolbar — workspace switcher hides org actions for non-enterprise
// ============================================================================

describe("Phase IA-surface-tier-pricing — topbar workspace switcher", () => {
  // Product-reset: AppTopbarV2 (dead duplicate topbar) deleted; contract
  // retargeted to the live AppAccountToolbar.
  const TOPBAR = readWeb("components/app-shell-v2/AppAccountToolbar.tsx");
  // account-menu refactor 2026-07-21 — org gating moved out of the toolbar's
  // surface-access hooks and into the single client resolver, which decides
  // org visibility purely from ACTIVE org membership.
  const RESOLVER = readWeb("lib/navigation/accountMenu.ts");

  it("no longer imports canAccessSurface / useSurfaceUserContext — org gating is resolver-driven (account-menu refactor 2026-07-21)", () => {
    // The retired design decided org visibility in the toolbar via
    // canAccessSurface('/organizations'); the folded menu delegates all
    // visibility to resolveAccountMenu.
    expect(TOPBAR).not.toMatch(/canAccessSurface/);
    expect(TOPBAR).not.toMatch(/useSurfaceUserContext/);
    expect(TOPBAR).toMatch(
      /import\s*\{[\s\S]{0,80}resolveAccountMenu[\s\S]{0,80}\}\s*from\s*["']\.\.\/\.\.\/lib\/navigation\/accountMenu["']/,
    );
  });

  it("org visibility is decided by ACTIVE org membership in the resolver, not canSeeOrganizations (account-menu refactor 2026-07-21)", () => {
    // No toolbar-local canSeeOrganizations flag anymore.
    expect(TOPBAR).not.toMatch(/canSeeOrganizations/);
    // The resolver filters switchable orgs to ACTIVE memberships only.
    expect(RESOLVER).toMatch(/membershipStatus === "ACTIVE"/);
  });

  it("Organizations switcher groups are gated on the resolved active-org options (P3/P4 domain remediation 2026-07-21)", () => {
    // The toolbar renders EXACTLY the resolver's organization groups by
    // mapping them (an empty resolved list renders no ORGANIZATION group);
    // it never builds org options from anything but the resolved menu.
    expect(TOPBAR).toMatch(/menu\.workspaces\.organizations\.map\(/); // (P3/P4 domain remediation 2026-07-21)
    expect(TOPBAR).toMatch(/data-context-group="ORGANIZATION"/); // (P3/P4 domain remediation 2026-07-21)
  });

  it("Organization settings is membership-gated in the resolver; create/join/manage actions removed (account-menu refactor 2026-07-21)", () => {
    // The retired Actions block (Create/Join/Manage organization) is gone.
    expect(TOPBAR).not.toMatch(/Manage organizations/);
    // Organization settings appears only when the user has >=1 ACTIVE org
    // membership AND the destination is reachable.
    expect(RESOLVER).toMatch(
      /activeOrganizations\.length > 0 &&\s*routeLoads\("account\.organizations"/,
    );
    // The toolbar renders the org section only when it is non-empty.
    expect(TOPBAR).toMatch(/menu\.organization\.length > 0/);
  });
});
