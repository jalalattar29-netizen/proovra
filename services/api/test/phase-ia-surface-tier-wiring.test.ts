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

  it("imports canAccessSurface + useSurfaceUserContext", () => {
    expect(SIDEBAR).toMatch(
      /import\s*\{\s*canAccessSurface\s*\}\s*from\s*["']\.\.\/\.\.\/lib\/surface\/access["']/,
    );
    expect(SIDEBAR).toMatch(
      /import\s*\{\s*useSurfaceUserContext\s*\}\s*from\s*["']\.\.\/\.\.\/lib\/surface\/useSurfaceUserContext["']/,
    );
  });

  it("pre-filters ROUTE_REGISTRY with canAccessSurface BEFORE the access resolver runs", () => {
    // The filter MUST appear before `const resolved = ` because that
    // is where the legacy access resolver iterates the registry.
    const filterIdx = SIDEBAR.indexOf("tierFilteredRegistry");
    const resolvedIdx = SIDEBAR.indexOf("const resolved =");
    expect(filterIdx).toBeGreaterThan(-1);
    expect(resolvedIdx).toBeGreaterThan(filterIdx);
    expect(SIDEBAR).toMatch(
      /tierFilteredRegistry\s*=\s*ROUTE_REGISTRY\.filter\([\s\S]{0,200}canAccessSurface/,
    );
  });

  it("resolved is built from tierFilteredRegistry, NOT raw ROUTE_REGISTRY", () => {
    // Pin that the legacy access resolver iterates ONLY the
    // tier-filtered subset.
    expect(SIDEBAR).toMatch(
      /const resolved\s*=\s*tierFilteredRegistry\.map\(/,
    );
  });
});

// ============================================================================
// CommandPalette — skips non-eligible routes during indexing
// ============================================================================

describe("Phase IA-surface-tier-wiring — CommandPalette", () => {
  const CP = readWeb("components/navigation/CommandPalette.tsx");

  it("imports canAccessSurface + useSurfaceUserContext", () => {
    expect(CP).toMatch(
      /import\s*\{\s*canAccessSurface\s*\}\s*from\s*["']\.\.\/\.\.\/lib\/surface\/access["']/,
    );
    expect(CP).toMatch(
      /import\s*\{\s*useSurfaceUserContext\s*\}\s*from\s*["']\.\.\/\.\.\/lib\/surface\/useSurfaceUserContext["']/,
    );
  });

  it("the index loop skips routes that fail canAccessSurface", () => {
    expect(CP).toMatch(
      /for \(const route of ROUTE_REGISTRY\)\s*\{[\s\S]{0,400}if \(!canAccessSurface\(surfaceUserCtx,\s*route\.href\)\)\s*continue/,
    );
  });
});

// ============================================================================
// /tools page — filters the registry before workflow exposure
// ============================================================================

describe("Phase IA-surface-tier-wiring — All Tools page", () => {
  const TOOLS = readWeb("app/(app)/tools/page.tsx");

  it("imports canAccessSurface + useSurfaceUserContext", () => {
    expect(TOOLS).toMatch(
      /import\s*\{\s*canAccessSurface\s*\}\s*from\s*["']\.\.\/\.\.\/\.\.\/lib\/surface\/access["']/,
    );
    expect(TOOLS).toMatch(
      /import\s*\{\s*useSurfaceUserContext\s*\}\s*from\s*["']\.\.\/\.\.\/\.\.\/lib\/surface\/useSurfaceUserContext["']/,
    );
  });

  it("the exposure useMemo filters ROUTE_REGISTRY before resolveRouteAccess runs", () => {
    expect(TOOLS).toMatch(
      /const tierFiltered\s*=\s*ROUTE_REGISTRY\.filter\([\s\S]{0,200}canAccessSurface\(surfaceUserCtx,\s*route\.href\)/,
    );
    expect(TOOLS).toMatch(/tierFiltered\.map\(/);
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

  it("/organizations is ENTERPRISE notFound (ENTERPRISE_ONLY)", () => {
    expect(TIERS).toMatch(
      /pathPrefix:\s*"\/organizations",\s*tier:\s*"ENTERPRISE",\s*directAccessPolicy:\s*"notFound"/,
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

  it("/organizations is ENTERPRISE with notFound policy (ENTERPRISE_ONLY)", () => {
    expect(TIERS).toMatch(
      /pathPrefix:\s*"\/organizations",\s*tier:\s*"ENTERPRISE",\s*directAccessPolicy:\s*"notFound"/,
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

  it("Organizations switcher group is gated on the resolved active-org options (account-menu refactor 2026-07-21)", () => {
    expect(TOPBAR).toMatch(/menu\.workspaces\.organizations\.length > 0/);
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
