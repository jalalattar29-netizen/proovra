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
 *   5. Escalations work, and they are SERVER projections only:
 *      - planFeatures.professionalSurfacesIncluded unlocks PROFESSIONAL tier
 *      - isEnterpriseWorkspace unlocks ENTERPRISE (no role ever does —
 *        Section K; PHASE 12 POINT 4 STEP 1 removed the role field itself)
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

import * as accessModule from "../../../apps/web/lib/surface/access.js";
import * as tiersModule from "../../../apps/web/lib/surface/tiers.js";
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
  getSurfaceTier,
  SURFACE_TIER_RULES,
  SURFACE_TIERS,
} from "../../../apps/web/lib/surface/tiers.js";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

// ============================================================================
// User-context personas the GTM brief named.
// ============================================================================

const PERSONAL_FREE_USER: SurfaceUserContext = {
  isPlatformAdmin: false,
  isEnterpriseWorkspace: false,
  // PHASE 12B Track 1A — server-projected entitlements (old plan: "FREE").
  planFeatures: { intakeIncluded: null, professionalSurfacesIncluded: false },
};

const PRO_INDIVIDUAL: SurfaceUserContext = {
  isPlatformAdmin: false,
  isEnterpriseWorkspace: false,
  // PHASE 12B Track 1A — server-projected entitlements (old plan: "PRO").
  planFeatures: { intakeIncluded: null, professionalSurfacesIncluded: true },
};

const SMALL_TEAM_MEMBER: SurfaceUserContext = {
  isPlatformAdmin: false,
  isEnterpriseWorkspace: false,
  // PHASE 12B Track 1A — server-projected entitlements (old plan: "TEAM").
  planFeatures: { intakeIncluded: null, professionalSurfacesIncluded: true },
};

const SMALL_TEAM_OWNER: SurfaceUserContext = {
  isPlatformAdmin: false,
  isEnterpriseWorkspace: false,
  // PHASE 12B Track 1A — server-projected entitlements (old plan: "TEAM").
  planFeatures: { intakeIncluded: null, professionalSurfacesIncluded: true },
};

const ENTERPRISE_ADMIN: SurfaceUserContext = {
  isPlatformAdmin: false,
  isEnterpriseWorkspace: true,
  // PHASE 12B Track 1A — server-projected entitlements (old plan: "TEAM").
  planFeatures: { intakeIncluded: null, professionalSurfacesIncluded: true },
};

const PLATFORM_ADMIN: SurfaceUserContext = {
  isPlatformAdmin: true,
  isEnterpriseWorkspace: false,
  // PHASE 12B Track 1A — server-projected entitlements (old plan: null).
  planFeatures: null,
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

describe("Phase IA-surface-tier-pricing — plan/entitlement gated surfaces", () => {
  // OpsCenter visibility remediation (2026-07-18):
  //   * /teams stays PROFESSIONAL (PRO/TEAM pricing brief).
  //   * /intake-links follows the COMMERCIAL ENTITLEMENT
  //     (planFeatures.intakeIncluded — PAYG included per the canonical
  //     catalog); the PROFESSIONAL tier remains only the fail-closed
  //     fallback used here because these fixture contexts carry no
  //     entitlement value.
  //   * /inbox is CORE — the Operations Center is an operational surface
  //     for every plan (categories inside are eligibility-governed).
  const PRO_TEAM_PATHS = ["/teams", "/intake-links"];

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

  it("CORE: /inbox (Operations Center) is visible to EVERY plan", () => {
    expect(getSurfaceTier("/inbox")).toBe("CORE");
    for (const ctx of [PERSONAL_FREE_USER, PRO_INDIVIDUAL, SMALL_TEAM_OWNER]) {
      expect(canAccessSurface(ctx, "/inbox")).toBe(true);
      expect(getDirectAccessDecision(ctx, "/inbox").kind).toBe("allow");
    }
  });

  it("ENTITLEMENT: /intake-links opens for a PAYG user whose envelope carries intakeIncluded", () => {
    expect(
      canAccessSurface(
        { ...PERSONAL_FREE_USER, planFeatures: { intakeIncluded: true, professionalSurfacesIncluded: false } },
        "/intake-links",
      ),
    ).toBe(true);
    // …and the entitlement can also close it regardless of tier.
    expect(
      canAccessSurface(
        { ...PRO_INDIVIDUAL, planFeatures: { intakeIncluded: false, professionalSurfacesIncluded: true } },
        "/intake-links",
      ),
    ).toBe(false);
  });
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
  /**
   * CONTRACT MIGRATION — Attention Architecture Phase 4B (2026-08-22).
   *
   * `/operations` LEFT this list. It was tiered INTERNAL with
   * `directAccessPolicy: "notFound"`, so the surface that answers "what
   * unresolved work does MY workspace have?" 404'd for every tenant — which
   * is not what this test was written to protect. PROOVRA's internal consoles
   * are `/ops` and `/admin/platform/*`, and both are still asserted below.
   *
   * The tier was never what gated it. Access is now decided by the
   * OPERATIONS_VIEW capability, which Phase 0 derives from whether a workspace
   * can PRODUCE operational conditions — so a Free personal space still gets
   * nothing, for a reason the product can state. The replacement assertions
   * live in `attention-arch-phase4b-workspace-operations.test.ts` and in
   * `apps/web/__tests__/platform-admin-route-access.test.ts`.
   */
  const INTERNAL_PATHS = ["/tools", "/ops", "/platform"];

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
        isPlatformAdmin: false,
        isEnterpriseWorkspace: false,
        planFeatures: { intakeIncluded: null, professionalSurfacesIncluded: true },
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
  it("an ENTERPRISE plan unlocks ENTERPRISE via the SERVER flag (backend ENTERPRISE_PLAN_KEYS)", () => {
    // PHASE 12B Track 1A — the SERVER derives isEnterpriseWorkspace from the
    // ENTERPRISE plan (platform-context.service ENTERPRISE_PLAN_KEYS); the
    // client never compares plan names.
    const ctx: SurfaceUserContext = {
      isPlatformAdmin: false,
      isEnterpriseWorkspace: true,
      planFeatures: { intakeIncluded: null, professionalSurfacesIncluded: true },
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
// Section K — no ROLE unlocks ENTERPRISE; only server flags do
// ============================================================================

describe("PHASE 12 POINT 4 STEP 1 — the surface context carries no role at all", () => {
  // `rolesUnlockingEnterprise` was the last role-shaped tier authority in the
  // frontend. After the Phase IA-surface-tier-correction narrowing it ignored
  // its `role` argument and returned `isPlatformAdmin`, had no production
  // caller (access.ts referenced it only with `void` to keep the import
  // lint-clean), and was kept alive purely by three source-regex assertions
  // here. Both the helper and the `SurfaceUserContext.role` field it fed are
  // deleted; these are the behavioural replacements.

  it("no ENTERPRISE surface opens without isEnterpriseWorkspace or platform admin", () => {
    // Every rule in the table that is ENTERPRISE-tier, checked against a
    // context that has NO enterprise flag and NO platform-admin flag but the
    // most generous entitlements a self-serve plan can carry.
    const bestNonEnterprise: SurfaceUserContext = {
      isPlatformAdmin: false,
      isEnterpriseWorkspace: false,
      planFeatures: {
        intakeIncluded: true,
        professionalSurfacesIncluded: true,
      },
    };
    const enterpriseRules = SURFACE_TIER_RULES.filter(
      (r) => r.tier === "ENTERPRISE",
    );
    expect(enterpriseRules.length).toBeGreaterThan(0);
    for (const rule of enterpriseRules) {
      // An entitlement override may legitimately open a rule to a paid
      // self-serve plan; the tier itself must never open on its own.
      if (rule.entitlementOverride) continue;
      // VISIBILITY is the invariant with NO exceptions: an ENTERPRISE rule
      // never puts its surface in nav, the command palette or All Tools for a
      // self-serve context, however generous that context's entitlements are.
      expect(
        canAccessSurface(bestNonEnterprise, rule.pathPrefix),
        `${rule.pathPrefix} must stay closed without an enterprise workspace`,
      ).toBe(false);
      /**
       * PHASE 13 (NEW-063) — DIRECT access may be delegated, but only
       * DELIBERATELY.
       *
       * A rule that declares `directAccessPolicy: "allow"` is stating that the
       * PLAN is not the right authority for reaching it by URL — that something
       * else decides, and that the something else is server-side. `/organizations`
       * is the case: the entity is MEMBERSHIP-gated (`routeRegistry.ts`'s 12B
       * correction, and the account-menu resolver's "membership is the ONLY
       * input — never plan"), and because `isEnterpriseWorkspace` is derived
       * from the ACTIVE workspace, an ORG_OWNER sitting in their Personal Space
       * is one of these non-enterprise contexts. Denying them was 404-ing the
       * exact link the account menu had offered.
       *
       * The exemption is keyed on the rule's own declared policy rather than on
       * a path allowlist here, so it cannot be acquired by accident: a rule only
       * gets it by saying so, and the visibility assertion above still binds.
       */
      if (rule.directAccessPolicy === "allow") continue;
      expect(
        getDirectAccessDecision(bestNonEnterprise, rule.pathPrefix).kind,
        `${rule.pathPrefix} must not resolve to allow on direct URL`,
      ).not.toBe("allow");
    }
  });

  it("the SAME context DOES open ENTERPRISE once the server sets the flag", () => {
    // Proves the previous test fails for the right reason: the only thing
    // that changed is a server-projected boolean.
    const enterprise: SurfaceUserContext = {
      isPlatformAdmin: false,
      isEnterpriseWorkspace: true,
      planFeatures: {
        intakeIncluded: true,
        professionalSurfacesIncluded: true,
      },
    };
    for (const rule of SURFACE_TIER_RULES.filter(
      (r) => r.tier === "ENTERPRISE" && !r.entitlementOverride,
    )) {
      expect(
        canAccessSurface(enterprise, rule.pathPrefix),
        `${rule.pathPrefix} must open for an enterprise workspace`,
      ).toBe(true);
    }
  });

  it("platform admin still passes every tier", () => {
    for (const rule of SURFACE_TIER_RULES) {
      expect(
        canAccessSurface(PLATFORM_ADMIN, rule.pathPrefix),
        `${rule.pathPrefix} must open for a platform admin`,
      ).toBe(true);
    }
  });

  it("a role cannot even be expressed in the surface context", () => {
    // Stays-removed guard, asserted on the PRODUCTION constant rather than on
    // source text: no `role` key exists to be compared against, so no
    // role-shaped tier authority can reappear without changing the contract.
    expect(Object.keys(ANONYMOUS_SURFACE_CONTEXT).sort()).toEqual([
      "isEnterpriseWorkspace",
      "isPlatformAdmin",
      "planFeatures",
    ]);
    expect("role" in ANONYMOUS_SURFACE_CONTEXT).toBe(false);
  });

  it("the surface module exports no role-based unlock helper", () => {
    expect(
      (tiersModule as Record<string, unknown>).rolesUnlockingEnterprise,
    ).toBeUndefined();
    expect(
      (accessModule as Record<string, unknown>).rolesUnlockingEnterprise,
    ).toBeUndefined();
  });

  it("the ENTERPRISE decision reads server flags only — no plan-name branch", () => {
    // Behavioural form of the old source pin: with the enterprise flag off,
    // NOTHING about the entitlement booleans can open an ENTERPRISE rule, and
    // with it on, the entitlement booleans are irrelevant.
    const enterpriseRule = SURFACE_TIER_RULES.find(
      (r) => r.tier === "ENTERPRISE" && !r.entitlementOverride,
    );
    expect(enterpriseRule).toBeTruthy();
    const path = enterpriseRule!.pathPrefix;
    for (const professionalSurfacesIncluded of [true, false, null]) {
      for (const intakeIncluded of [true, false, null]) {
        expect(
          canAccessSurface(
            {
              isPlatformAdmin: false,
              isEnterpriseWorkspace: false,
              planFeatures: { intakeIncluded, professionalSurfacesIncluded },
            },
            path,
          ),
        ).toBe(false);
        expect(
          canAccessSurface(
            {
              isPlatformAdmin: false,
              isEnterpriseWorkspace: true,
              planFeatures: { intakeIncluded, professionalSurfacesIncluded },
            },
            path,
          ),
        ).toBe(true);
      }
    }
  });
});


// ============================================================================
// Section L — Phase IA-surface-tier-pricing — Organizations ENTERPRISE_ONLY
// ============================================================================

const PAYG_USER: SurfaceUserContext = {
  isPlatformAdmin: false,
  isEnterpriseWorkspace: false,
  planFeatures: { intakeIncluded: true, professionalSurfacesIncluded: false },
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

  /**
   * PHASE 13 (NEW-063) — VISIBILITY is still denied for every one of these
   * personas. DIRECT ACCESS to the organizations ENTITY is not, and the
   * difference is deliberate.
   *
   * `/organizations` (the list, and the member-safe detail beneath it) is
   * MEMBERSHIP-gated, not plan-gated. `routeRegistry.ts` says so in its 12B
   * correction — "a FREE-plan personal user with an ACTIVE org membership must
   * reach their org list even while their ACTIVE workspace is personal" — and
   * `lib/navigation/accountMenu.ts` acts on it, offering "Organization
   * settings" whenever `activeOrganizations.length > 0`. Because
   * `isEnterpriseWorkspace` is derived from the ACTIVE WORKSPACE, an ORG_OWNER
   * sitting in their Personal Space is one of these non-enterprise personas —
   * and the old `notFound` policy 404'd them on the link the account menu had
   * just shown them.
   *
   * So the tier assertion below is unchanged and still exhaustive: none of
   * these personas may SEE the surface in nav, the command palette or All
   * Tools. What replaces the client-side 404 is stronger, not weaker —
   * `PageRouteGate`, the ENTERPRISE_ONLY route ids covering every ADMIN
   * surface beneath the detail, and the org routes' own server-side membership
   * checks. A persona with no membership reaches an empty list.
   *
   * The ADMIN paths in `ORG_PATHS` keep their `notFound` / `redirect`
   * treatment, so they are asserted separately rather than folded in.
   */
  const MEMBERSHIP_GATED_ORG_PATHS = ["/organizations"];

  for (const persona of NON_ENTERPRISE) {
    for (const path of ORG_PATHS) {
      const membershipGated = MEMBERSHIP_GATED_ORG_PATHS.includes(path);
      it(`${persona.name} cannot see ${path}${
        membershipGated ? " (direct access is membership-gated)" : " or open it"
      }`, () => {
        expect(canAccessSurface(persona.ctx, path)).toBe(false);
        const d = getDirectAccessDecision(persona.ctx, path);
        if (membershipGated) {
          // Hidden from navigation, reachable by URL; membership + the server
          // decide what is actually returned.
          expect(d.kind).toBe("allow");
        } else {
          // Per the brief: notFound or redirect — both must be acceptable.
          // The rule table uses notFound for the ADMIN surfaces.
          expect(["notFound", "redirect"]).toContain(d.kind);
        }
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
