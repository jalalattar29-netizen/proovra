/**
 * Phase IA-surface-tier — visibility + direct-URL contract for the
 * product surface tier model.
 *
 * Pins the bounded outcomes the rest of the app relies on:
 *
 *   1. The CORE sidebar for a FREE/PAYG personal user shows ONLY the
 *      surfaces the GTM brief lists (home, capture, evidence, cases,
 *      intake-links, search, reports, teams, inbox, trust-center,
 *      settings, billing).
 *
 *   2. Hidden surfaces fall into one of two categories:
 *      - ENTERPRISE notFound (review/governance/intelligence/admin/
 *        executive/investigation/security-center/identity-security)
 *      - INTERNAL notFound (/tools /ops /operations /platform)
 *
 *   3. /settings/security remains CORE (visible to everyone) — the
 *      brief explicitly carves it out from the hidden security-center.
 *
 *   4. Direct URL access for hidden surfaces returns the bounded
 *      decision the middleware + SurfaceGate consume.
 *
 *   5. Plan/role escalations work:
 *      - PRO/TEAM plan unlocks PROFESSIONAL tier
 *      - Enterprise workspace flag OR OWNER/ADMIN role unlocks ENTERPRISE
 *      - isPlatformAdmin unlocks every tier including INTERNAL
 *
 * The tests run against the SHARED tier table at
 * apps/web/lib/surface/tiers.ts via the helpers at
 * apps/web/lib/surface/access.ts. The same module powers the
 * middleware + SurfaceGate, so the contract is enforced at every
 * enforcement point.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  ANONYMOUS_SURFACE_CONTEXT,
  canAccessSurface,
  describeSurfaceDecision,
  getDirectAccessDecision,
  getVisibleSurfaces,
  type SurfaceUserContext,
} from "../../../apps/web/lib/surface/access.js";
import {
  findSurfaceTierRule,
  getDirectAccessPolicy,
  getSurfaceTier,
  SURFACE_TIER_RULES,
  SURFACE_TIERS,
  type SurfaceTier,
} from "../../../apps/web/lib/surface/tiers.js";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

// ============================================================================
// User-context personas the GTM brief named.
// ============================================================================

const PERSONAL_FREE_USER: SurfaceUserContext = {
  plan: "FREE",
  role: "OWNER", // owner of their personal workspace
  isPlatformAdmin: false,
  isEnterpriseWorkspace: false,
};

const PRO_INDIVIDUAL: SurfaceUserContext = {
  plan: "PRO",
  role: "OWNER",
  isPlatformAdmin: false,
  isEnterpriseWorkspace: false,
};

const SMALL_TEAM_MEMBER: SurfaceUserContext = {
  plan: "TEAM",
  role: "MEMBER",
  isPlatformAdmin: false,
  isEnterpriseWorkspace: false,
};

const SMALL_TEAM_OWNER: SurfaceUserContext = {
  plan: "TEAM",
  role: "OWNER",
  isPlatformAdmin: false,
  isEnterpriseWorkspace: false,
};

const ENTERPRISE_ADMIN: SurfaceUserContext = {
  plan: "TEAM",
  role: "ADMIN",
  isPlatformAdmin: false,
  isEnterpriseWorkspace: true,
};

const PLATFORM_ADMIN: SurfaceUserContext = {
  plan: null,
  role: null,
  isPlatformAdmin: true,
  isEnterpriseWorkspace: false,
};

// ============================================================================
// Section A — the static rule table itself
// ============================================================================

describe("Phase IA-surface-tier — rule table sanity", () => {
  it("every rule uses a bounded tier", () => {
    for (const rule of SURFACE_TIER_RULES) {
      expect(SURFACE_TIERS).toContain(rule.tier);
    }
  });

  it("every rule pathPrefix starts with '/'", () => {
    for (const rule of SURFACE_TIER_RULES) {
      expect(rule.pathPrefix.startsWith("/")).toBe(true);
    }
  });

  it("findSurfaceTierRule matches on path-segment boundary, not substring", () => {
    // `/foo` matches `/foo` and `/foo/bar` but NOT `/foobar`.
    expect(findSurfaceTierRule("/tools")?.tier).toBe("INTERNAL");
    expect(findSurfaceTierRule("/tools/anything")?.tier).toBe("INTERNAL");
    // A hypothetical `/toolsmith` route would NOT match `/tools`. We
    // assert via the bounded predicate rather than a synthetic route.
    const fake = "/toolsmith";
    const rule = findSurfaceTierRule(fake);
    expect(rule?.pathPrefix ?? "").not.toBe("/tools");
  });

  it("first-match-wins for nested prefixes — /governance-platform NOT swallowed by /governance", () => {
    // /governance-platform comes BEFORE /governance in the table so the
    // platform-specific reason wins for its surface.
    expect(findSurfaceTierRule("/governance-platform")?.reason).toMatch(
      /governance platform/i,
    );
    expect(findSurfaceTierRule("/governance")?.reason).toMatch(
      /governance lifecycle/i,
    );
  });
});

// ============================================================================
// Section B — CORE sidebar for the GTM target persona
// ============================================================================

describe("Phase IA-surface-tier — CORE sidebar for FREE / PAYG user", () => {
  // Phase IA-surface-tier-pricing — the FREE / PAYG sidebar matches
  // the public pricing brief exactly:
  //   Home, Capture, Evidence, Cases, Search, Reports, Trust, Settings,
  //   Billing
  // /teams, /intake-links, /inbox are PRO/TEAM surfaces and are no
  // longer CORE.
  const CORE_PATHS = [
    "/home",
    "/capture",
    "/evidence",
    "/cases",
    "/search",
    "/reports",
    "/trust-center",
    "/settings",
    "/settings/security",
    "/billing",
  ];

  for (const path of CORE_PATHS) {
    it(`CORE: ${path} is visible to a FREE personal user`, () => {
      expect(getSurfaceTier(path)).toBe("CORE");
      expect(canAccessSurface(PERSONAL_FREE_USER, path)).toBe(true);
      expect(getDirectAccessDecision(PERSONAL_FREE_USER, path).kind).toBe(
        "allow",
      );
    });
  }
});

describe("Phase IA-surface-tier-pricing — PRO/TEAM sidebar adds Teams/Intake Links/Inbox", () => {
  // PRO and TEAM unlock /teams, /intake-links, /inbox per the pricing
  // brief. FREE/PAYG do not see these — direct URL → redirect /home.
  const PRO_TEAM_PATHS = ["/teams", "/intake-links", "/inbox"];

  for (const path of PRO_TEAM_PATHS) {
    it(`PROFESSIONAL: ${path} is visible to PRO user`, () => {
      expect(getSurfaceTier(path)).toBe("PROFESSIONAL");
      expect(canAccessSurface(PRO_INDIVIDUAL, path)).toBe(true);
    });
    it(`PROFESSIONAL: ${path} is visible to TEAM owner`, () => {
      expect(canAccessSurface(SMALL_TEAM_OWNER, path)).toBe(true);
    });
    it(`PROFESSIONAL: ${path} is hidden from FREE user`, () => {
      expect(canAccessSurface(PERSONAL_FREE_USER, path)).toBe(false);
      const d = getDirectAccessDecision(PERSONAL_FREE_USER, path);
      expect(d.kind).toBe("redirect");
    });
  }
});

// ============================================================================
// Section C — hidden surfaces for the target persona
// ============================================================================

describe("Phase IA-surface-tier — hidden surfaces for personal/small-office user", () => {
  // ENTERPRISE hides — should return notFound for personal/team user.
  const ENTERPRISE_PATHS = [
    "/review",
    "/review-operations",
    "/reviewer-ops",
    "/reviewer-workspace",
    "/redaction",
    "/governance",
    "/governance-platform",
    "/admin",
    "/admin/identity",
    "/organization-admin",
    "/security-center",
    "/identity-security",
    "/executive",
    "/intelligence",
    "/intelligence-platform",
    "/intelligence-quality",
    "/budget-center",
    "/investigation",
  ];

  for (const path of ENTERPRISE_PATHS) {
    it(`ENTERPRISE hidden: ${path} → notFound for FREE personal user`, () => {
      expect(getSurfaceTier(path)).toBe("ENTERPRISE");
      expect(canAccessSurface(PERSONAL_FREE_USER, path)).toBe(false);
      expect(getDirectAccessDecision(PERSONAL_FREE_USER, path).kind).toBe(
        "notFound",
      );
    });
  }

  // INTERNAL hides — should return notFound for ALL non-platform-admin
  // users including OWNER/ADMIN of any workspace.
  const INTERNAL_PATHS = ["/tools", "/ops", "/operations", "/platform"];

  for (const path of INTERNAL_PATHS) {
    it(`INTERNAL hidden: ${path} → notFound for non-platform-admin`, () => {
      expect(getSurfaceTier(path)).toBe("INTERNAL");
      expect(canAccessSurface(PERSONAL_FREE_USER, path)).toBe(false);
      expect(canAccessSurface(SMALL_TEAM_OWNER, path)).toBe(false);
      expect(canAccessSurface(ENTERPRISE_ADMIN, path)).toBe(false);
      expect(getDirectAccessDecision(SMALL_TEAM_OWNER, path).kind).toBe(
        "notFound",
      );
    });
  }
});

// ============================================================================
// Section D — escalation paths
// ============================================================================

describe("Phase IA-surface-tier — tier eligibility escalations", () => {
  it("PRO plan unlocks PROFESSIONAL surfaces (Teams/Intake Links/Inbox)", () => {
    // Phase IA-self-serve-simplification — advanced PROFESSIONAL
    // surfaces (integrations/workflows/exchange) moved to ENTERPRISE
    // because they are not packaged for self-serve. PRO now unlocks
    // only the simplified-product PROFESSIONAL surfaces.
    expect(canAccessSurface(PRO_INDIVIDUAL, "/teams")).toBe(true);
    expect(canAccessSurface(PRO_INDIVIDUAL, "/intake-links")).toBe(true);
    expect(canAccessSurface(PRO_INDIVIDUAL, "/inbox")).toBe(true);
    // PRO does NOT unlock ENTERPRISE (incl. the formerly-PROFESSIONAL
    // surfaces that moved up).
    expect(canAccessSurface(PRO_INDIVIDUAL, "/governance")).toBe(false);
    expect(canAccessSurface(PRO_INDIVIDUAL, "/integrations")).toBe(false);
    expect(canAccessSurface(PRO_INDIVIDUAL, "/workflows")).toBe(false);
    expect(canAccessSurface(PRO_INDIVIDUAL, "/exchange")).toBe(false);
  });

  it("FREE personal user does NOT see PROFESSIONAL surfaces", () => {
    // FREE on /teams → redirect /home (upsell path).
    expect(canAccessSurface(PERSONAL_FREE_USER, "/teams")).toBe(false);
    const decision = getDirectAccessDecision(PERSONAL_FREE_USER, "/teams");
    expect(decision.kind).toBe("redirect");
    if (decision.kind === "redirect") {
      expect(decision.to).toBe("/home");
    }
  });

  it("Enterprise workspace flag unlocks ENTERPRISE surfaces", () => {
    expect(canAccessSurface(ENTERPRISE_ADMIN, "/governance")).toBe(true);
    expect(canAccessSurface(ENTERPRISE_ADMIN, "/intelligence")).toBe(true);
    expect(canAccessSurface(ENTERPRISE_ADMIN, "/review")).toBe(true);
    // Even enterprise workspace does NOT unlock INTERNAL.
    expect(canAccessSurface(ENTERPRISE_ADMIN, "/tools")).toBe(false);
  });

  it("Phase IA-surface-tier-correction — TEAM-plan OWNER/ADMIN does NOT unlock ENTERPRISE", () => {
    // The platform's GTM target (individuals + small offices + small
    // teams) MUST see the simplified product. TEAM-plan owner/admin
    // is exactly the persona the brief lists as a hidden audience for
    // ENTERPRISE-tier surfaces. ENTERPRISE eligibility now requires
    // plan === "ENTERPRISE" OR isEnterpriseWorkspace OR isPlatformAdmin.
    expect(canAccessSurface(SMALL_TEAM_OWNER, "/governance")).toBe(false);
    expect(canAccessSurface(SMALL_TEAM_OWNER, "/intelligence")).toBe(false);
    expect(canAccessSurface(SMALL_TEAM_OWNER, "/review")).toBe(false);
    expect(canAccessSurface(SMALL_TEAM_OWNER, "/security-center")).toBe(false);
    expect(canAccessSurface(SMALL_TEAM_OWNER, "/executive")).toBe(false);
    // MEMBER role still no ENTERPRISE.
    expect(canAccessSurface(SMALL_TEAM_MEMBER, "/governance")).toBe(false);
  });

  it("Platform admin unlocks every tier including INTERNAL", () => {
    expect(canAccessSurface(PLATFORM_ADMIN, "/governance")).toBe(true);
    expect(canAccessSurface(PLATFORM_ADMIN, "/tools")).toBe(true);
    expect(canAccessSurface(PLATFORM_ADMIN, "/ops")).toBe(true);
    expect(canAccessSurface(PLATFORM_ADMIN, "/platform")).toBe(true);
  });
});

// ============================================================================
// Section E — getVisibleSurfaces filter
// ============================================================================

describe("Phase IA-surface-tier — getVisibleSurfaces projection", () => {
  it("filters a sidebar input down to CORE-only for a FREE user", () => {
    const sidebar = [
      { id: "home", href: "/home" },
      { id: "capture", href: "/capture" },
      { id: "tools", href: "/tools" },
      { id: "governance", href: "/governance" },
      { id: "review", href: "/review" },
      { id: "intelligence", href: "/intelligence" },
      { id: "billing", href: "/billing" },
    ];
    const visible = getVisibleSurfaces(PERSONAL_FREE_USER, sidebar);
    const visibleIds = visible.map((s) => s.id);
    expect(visibleIds).toContain("home");
    expect(visibleIds).toContain("capture");
    expect(visibleIds).toContain("billing");
    expect(visibleIds).not.toContain("tools");
    expect(visibleIds).not.toContain("governance");
    expect(visibleIds).not.toContain("review");
    expect(visibleIds).not.toContain("intelligence");
  });

  it("preserves input order", () => {
    const input = [
      { id: "billing", href: "/billing" },
      { id: "home", href: "/home" },
      { id: "capture", href: "/capture" },
    ];
    const output = getVisibleSurfaces(PERSONAL_FREE_USER, input);
    expect(output.map((s) => s.id)).toEqual(["billing", "home", "capture"]);
  });
});

// ============================================================================
// Section F — ANONYMOUS_SURFACE_CONTEXT fails closed
// ============================================================================

describe("Phase IA-surface-tier — anonymous context fails closed", () => {
  it("hides every non-CORE surface", () => {
    expect(canAccessSurface(ANONYMOUS_SURFACE_CONTEXT, "/tools")).toBe(false);
    expect(canAccessSurface(ANONYMOUS_SURFACE_CONTEXT, "/governance")).toBe(false);
    expect(canAccessSurface(ANONYMOUS_SURFACE_CONTEXT, "/integrations")).toBe(false);
    expect(canAccessSurface(ANONYMOUS_SURFACE_CONTEXT, "/review")).toBe(false);
  });

  it("still allows CORE surfaces (so the loading-state user can see Home)", () => {
    expect(canAccessSurface(ANONYMOUS_SURFACE_CONTEXT, "/home")).toBe(true);
    expect(canAccessSurface(ANONYMOUS_SURFACE_CONTEXT, "/capture")).toBe(true);
  });
});

// ============================================================================
// Section G — middleware integration point
// ============================================================================

describe("Phase IA-surface-tier — middleware integration", () => {
  const MW = readSource("../../../apps/web/middleware.ts");

  it("imports findSurfaceTierRule from the tiers module", () => {
    expect(MW).toMatch(
      /import\s*\{\s*findSurfaceTierRule\s*\}\s*from\s*["']\.\/lib\/surface\/tiers["']/,
    );
  });

  it("applies the surface-tier gate inside the app-host branch", () => {
    expect(MW).toMatch(
      /if \(isAppHost\)\s*\{[\s\S]{0,400}applySurfaceTierGate\(req,\s*pathname\)/,
    );
  });

  it("rewrites INTERNAL notFound surfaces to /not-found at the edge", () => {
    expect(MW).toMatch(
      /rule\.tier === "INTERNAL"[\s\S]{0,400}target\.pathname\s*=\s*"\/not-found"[\s\S]{0,200}NextResponse\.rewrite/,
    );
  });

  it("does NOT 404 ENTERPRISE notFound surfaces at the edge — defers to page-level gate", () => {
    // Middleware doesn't have plan/role info. ENTERPRISE-tier requests
    // must reach the page so the SurfaceGate (with full PlatformContext)
    // can correctly distinguish an enterprise customer from a personal
    // user.
    expect(MW).toMatch(
      /We DO NOT 404 here for ENTERPRISE/,
    );
  });
});

// ============================================================================
// Section H — describeSurfaceDecision is operator-readable
// ============================================================================

describe("Phase IA-surface-tier — describeSurfaceDecision", () => {
  it("returns the tier + rule + outcome shape", () => {
    const d = describeSurfaceDecision(PERSONAL_FREE_USER, "/governance");
    expect(d.tier).toBe("ENTERPRISE");
    expect(d.inTier).toBe(false);
    expect(d.decision.kind).toBe("notFound");
    expect(d.policy).toBe("notFound");
    expect(d.rule).not.toBeNull();
  });

  it("on an unmapped path defaults to CORE + allow", () => {
    const d = describeSurfaceDecision(
      PERSONAL_FREE_USER,
      "/some-unmapped-future-route",
    );
    expect(d.tier).toBe("CORE");
    expect(d.rule).toBeNull();
    expect(d.decision.kind).toBe("allow");
  });
});

// ============================================================================
// Section I — explicit /settings/security carve-out
// ============================================================================

// ============================================================================
// Section J — Phase IA-surface-tier-correction persona checklist
//
// The user's correction brief lists explicit persona × surface
// expectations. Pin each one so a future tier-rule edit can't quietly
// re-unlock ENTERPRISE for a non-enterprise persona.
// ============================================================================

describe("Phase IA-surface-tier-correction — explicit persona checklist", () => {
  // Persona × hidden ENTERPRISE surface — none of these personas may
  // access any of these surfaces. Drives a parametric assertion grid.
  const HIDDEN_ENTERPRISE_SURFACES = [
    "/review",
    "/reviewer-ops",
    "/governance",
    "/governance-platform",
    "/security-center",
    "/identity-security",
    "/admin",
    "/organization-admin",
    "/intelligence",
    "/intelligence-platform",
    "/intelligence-quality",
    "/budget-center",
    "/executive",
    "/investigation",
    "/redaction",
  ];

  // Personas that MUST NOT see ENTERPRISE surfaces, per the correction.
  const NON_ENTERPRISE_PERSONAS: Array<{
    name: string;
    ctx: SurfaceUserContext;
  }> = [
    { name: "FREE personal user", ctx: PERSONAL_FREE_USER },
    { name: "PRO individual", ctx: PRO_INDIVIDUAL },
    { name: "TEAM owner", ctx: SMALL_TEAM_OWNER },
    {
      name: "TEAM admin",
      ctx: {
        plan: "TEAM",
        role: "ADMIN",
        isPlatformAdmin: false,
        isEnterpriseWorkspace: false,
      },
    },
    { name: "TEAM member", ctx: SMALL_TEAM_MEMBER },
  ];

  for (const persona of NON_ENTERPRISE_PERSONAS) {
    for (const surface of HIDDEN_ENTERPRISE_SURFACES) {
      it(`${persona.name} cannot access ${surface}`, () => {
        expect(canAccessSurface(persona.ctx, surface)).toBe(false);
        const decision = getDirectAccessDecision(persona.ctx, surface);
        // Either notFound (ENTERPRISE default) or redirect (forbidden).
        expect(["notFound", "redirect", "forbidden"]).toContain(decision.kind);
      });
    }
    // INTERNAL: All Tools also unreachable for every non-platform-admin.
    it(`${persona.name} cannot access /tools (All Tools)`, () => {
      expect(canAccessSurface(persona.ctx, "/tools")).toBe(false);
      expect(getDirectAccessDecision(persona.ctx, "/tools").kind).toBe(
        "notFound",
      );
    });
  }

  // Enterprise persona — flag-driven access.
  it("Enterprise workspace admin CAN access every ENTERPRISE surface", () => {
    for (const surface of HIDDEN_ENTERPRISE_SURFACES) {
      expect(
        canAccessSurface(ENTERPRISE_ADMIN, surface),
        `${surface} must be reachable for enterprise admin`,
      ).toBe(true);
    }
  });

  // Plan-driven path (future-compat): a workspace whose plan field
  // grows the literal value "ENTERPRISE" should unlock ENTERPRISE
  // without any other config.
  it("future plan === 'ENTERPRISE' unlocks ENTERPRISE (forward-compat)", () => {
    const ctx: SurfaceUserContext = {
      // Cast through unknown because the current enum lacks the value.
      plan: "ENTERPRISE" as unknown as SurfaceUserContext["plan"],
      role: "OWNER",
      isPlatformAdmin: false,
      isEnterpriseWorkspace: false,
    };
    expect(canAccessSurface(ctx, "/governance")).toBe(true);
    expect(canAccessSurface(ctx, "/intelligence")).toBe(true);
    expect(canAccessSurface(ctx, "/executive")).toBe(true);
  });

  // Platform admin path — bypass for everything.
  it("Platform admin can access /tools AND every ENTERPRISE surface", () => {
    expect(canAccessSurface(PLATFORM_ADMIN, "/tools")).toBe(true);
    for (const surface of HIDDEN_ENTERPRISE_SURFACES) {
      expect(canAccessSurface(PLATFORM_ADMIN, surface)).toBe(true);
    }
  });

  // TEAM plan still gets PROFESSIONAL (no regression for legitimate
  // simplified-product surfaces). Phase IA-self-serve-simplification
  // narrowed the PROFESSIONAL tier to teams/intake-links/inbox; the
  // formerly-PROFESSIONAL integrations/workflows/exchange moved to
  // ENTERPRISE because they are not packaged for self-serve.
  it("TEAM owner DOES see the simplified PROFESSIONAL surfaces (Teams/Intake Links/Inbox)", () => {
    expect(canAccessSurface(SMALL_TEAM_OWNER, "/teams")).toBe(true);
    expect(canAccessSurface(SMALL_TEAM_OWNER, "/intake-links")).toBe(true);
    expect(canAccessSurface(SMALL_TEAM_OWNER, "/inbox")).toBe(true);
    // The advanced surfaces moved to ENTERPRISE — TEAM owner does NOT see them.
    expect(canAccessSurface(SMALL_TEAM_OWNER, "/integrations")).toBe(false);
    expect(canAccessSurface(SMALL_TEAM_OWNER, "/workflows")).toBe(false);
    expect(canAccessSurface(SMALL_TEAM_OWNER, "/exchange")).toBe(false);
  });
});

// ============================================================================
// Section K — pin the rolesUnlockingEnterprise narrowing
// ============================================================================

describe("Phase IA-surface-tier-correction — rolesUnlockingEnterprise narrowed", () => {
  const TIERS_SRC = readFileSync(
    fileURLToPath(
      new URL("../../../apps/web/lib/surface/tiers.ts", import.meta.url),
    ),
    "utf8",
  );

  it("the helper no longer returns true for OWNER / ADMIN role alone", () => {
    // Pre-fix shape (REGRESSION GUARD):
    //   if (role === "OWNER" || role === "ADMIN") return true;
    // The fix MUST remove that branch — platform admin is the only
    // role-based unlock.
    expect(TIERS_SRC).not.toMatch(
      /if \(role === "OWNER" \|\| role === "ADMIN"\) return true/,
    );
  });

  it("the helper still grants access to platform admin", () => {
    expect(TIERS_SRC).toMatch(
      /if \(isPlatformAdmin\) return true/,
    );
  });

  it("access.ts ENTERPRISE branch checks plan === 'ENTERPRISE' (forward-compat)", () => {
    const ACCESS_SRC = readFileSync(
      fileURLToPath(
        new URL("../../../apps/web/lib/surface/access.ts", import.meta.url),
      ),
      "utf8",
    );
    expect(ACCESS_SRC).toMatch(/\(ctx\.plan\s*as\s*string\s*\|\s*null\)\s*===\s*"ENTERPRISE"/);
    // The TEAM owner/admin branch MUST be gone.
    expect(ACCESS_SRC).not.toMatch(
      /ctx\.plan === "TEAM"\s*&&\s*\(ctx\.role === "OWNER"\s*\|\|\s*ctx\.role === "ADMIN"\)/,
    );
  });
});

// ============================================================================
// Section L — Phase IA-surface-tier-pricing — Organizations ENTERPRISE_ONLY
// ============================================================================

const PAYG_USER: SurfaceUserContext = {
  plan: "PAYG",
  role: "OWNER",
  isPlatformAdmin: false,
  isEnterpriseWorkspace: false,
};

describe("Phase IA-surface-tier-pricing — Organizations are ENTERPRISE_ONLY", () => {
  // Per the public pricing page:
  //   FREE / PAYG / PRO / TEAM users must NOT see Organizations.
  //   Self-serve plans manage collaboration through /teams only.
  const ORG_PATHS = [
    "/organizations",
    "/organization-admin",
    "/admin/organizations",
  ];
  const NON_ENTERPRISE = [
    { name: "FREE", ctx: PERSONAL_FREE_USER },
    { name: "PAYG", ctx: PAYG_USER },
    { name: "PRO", ctx: PRO_INDIVIDUAL },
    { name: "TEAM owner", ctx: SMALL_TEAM_OWNER },
    {
      name: "TEAM admin",
      ctx: {
        plan: "TEAM" as const,
        role: "ADMIN" as const,
        isPlatformAdmin: false,
        isEnterpriseWorkspace: false,
      },
    },
    { name: "TEAM member", ctx: SMALL_TEAM_MEMBER },
  ];

  for (const persona of NON_ENTERPRISE) {
    for (const path of ORG_PATHS) {
      it(`${persona.name} cannot see or open ${path}`, () => {
        expect(canAccessSurface(persona.ctx, path)).toBe(false);
        // Per the brief: notFound or redirect — both must be acceptable.
        // The rule table uses notFound for ENTERPRISE_ONLY.
        const d = getDirectAccessDecision(persona.ctx, path);
        expect(["notFound", "redirect"]).toContain(d.kind);
      });
    }
  }

  it("Enterprise workspace admin CAN see /organizations", () => {
    expect(canAccessSurface(ENTERPRISE_ADMIN, "/organizations")).toBe(true);
    expect(canAccessSurface(ENTERPRISE_ADMIN, "/organization-admin")).toBe(true);
  });

  it("Platform admin sees /organizations + admin routes", () => {
    expect(canAccessSurface(PLATFORM_ADMIN, "/organizations")).toBe(true);
    expect(canAccessSurface(PLATFORM_ADMIN, "/admin/organizations")).toBe(true);
    expect(canAccessSurface(PLATFORM_ADMIN, "/admin")).toBe(true);
  });
});

describe("Phase IA-surface-tier-pricing — Teams visibility per pricing tier", () => {
  it("PRO user sees /teams", () => {
    expect(canAccessSurface(PRO_INDIVIDUAL, "/teams")).toBe(true);
  });

  it("TEAM owner sees /teams", () => {
    expect(canAccessSurface(SMALL_TEAM_OWNER, "/teams")).toBe(true);
  });

  it("FREE user does NOT see /teams (upgrade-locked)", () => {
    expect(canAccessSurface(PERSONAL_FREE_USER, "/teams")).toBe(false);
    // Direct URL → redirect /home (upsell path, not 404 — the surface
    // exists for the plan above).
    const d = getDirectAccessDecision(PERSONAL_FREE_USER, "/teams");
    expect(d.kind).toBe("redirect");
  });

  it("PAYG user does NOT see /teams", () => {
    expect(canAccessSurface(PAYG_USER, "/teams")).toBe(false);
  });
});

describe("Phase IA-surface-tier — /settings/security stays CORE", () => {
  // The GTM brief explicitly carves /settings/security out from the
  // hidden /security-center. Pin the carve-out so a future rule edit
  // can't accidentally re-hide it.
  it("personal user sees /settings/security", () => {
    expect(canAccessSurface(PERSONAL_FREE_USER, "/settings/security")).toBe(true);
    expect(getDirectAccessDecision(PERSONAL_FREE_USER, "/settings/security").kind).toBe(
      "allow",
    );
  });

  it("personal user does NOT see /security-center", () => {
    expect(canAccessSurface(PERSONAL_FREE_USER, "/security-center")).toBe(false);
    expect(getDirectAccessDecision(PERSONAL_FREE_USER, "/security-center").kind).toBe(
      "notFound",
    );
  });
});
