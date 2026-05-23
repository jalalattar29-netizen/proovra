/**
 * PHASE 38.6 — Route exposure architecture source-contract + behavioral tests.
 *
 * The headline architectural guarantee: workflow / persona is NEVER an
 * input to access decisions. Workflow only changes navigation
 * placement; capabilities + active-space decide access.
 *
 * Covers:
 *   1. Route registry shape + bounded vocabularies + integrity
 *   2. resolveRouteAccess never reads workflow + never inflates access
 *   3. resolveWorkflowExposure never adds/removes routes
 *   4. PageRouteGate renders the six structured states correctly
 *   5. All Tools surface lists every reachable + requestable route
 *   6. Workflow tags only PRIORITIZE — every capability-allowed route
 *      is reachable somewhere (sidebar OR more-advanced OR all-tools)
 *   7. Account-tier routes never require workspace
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readWeb(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../../apps/web/${rel}`, import.meta.url)),
    "utf8",
  );
}

const REGISTRY = readWeb("lib/navigation/routeRegistry.ts");
const ACCESS_RESOLVER = readWeb("lib/navigation/routeAccessResolver.ts");
const EXPOSURE_RESOLVER = readWeb(
  "lib/navigation/workflowExposureResolver.ts",
);
const PAGE_GATE = readWeb("components/navigation/PageRouteGate.tsx");
const TOOLS_PAGE = readWeb("app/(app)/tools/page.tsx");

// =============================================================================
// PART 1 — Route registry shape + integrity
// =============================================================================

describe("Phase 38.6 — route registry", () => {
  it("exports the canonical RouteDefinition + bounded vocabularies", async () => {
    const mod = await import(
      "../../../apps/web/lib/navigation/routeRegistry.js"
    );
    expect(mod.ROUTE_DOMAINS.length).toBeGreaterThan(0);
    expect(mod.REQUIRED_ACTIVE_SPACES).toEqual([
      "NONE",
      "PERSONAL_OR_ORG",
      "ORGANIZATION_ONLY",
      "PLATFORM_ADMIN",
    ]);
    expect(mod.FALLBACK_BEHAVIORS).toContain("REQUEST_ACCESS");
    expect(mod.FALLBACK_BEHAVIORS).toContain("HIDDEN_IF_NO_CAPABILITY");
  });

  it("ROUTE_REGISTRY has unique ids", async () => {
    const mod = await import(
      "../../../apps/web/lib/navigation/routeRegistry.js"
    );
    const ids = mod.ROUTE_REGISTRY.map((r: { id: string }) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("ROUTE_REGISTRY entries declare every required field", async () => {
    const mod = await import(
      "../../../apps/web/lib/navigation/routeRegistry.js"
    );
    for (const r of mod.ROUTE_REGISTRY) {
      expect(typeof r.id).toBe("string");
      expect(r.href.startsWith("/")).toBe(true);
      expect(typeof r.label).toBe("string");
      expect(typeof r.description).toBe("string");
      expect(typeof r.domain).toBe("string");
      expect(Array.isArray(r.requiredCapabilities)).toBe(true);
      expect(typeof r.requiredActiveSpace).toBe("string");
      expect(typeof r.fallbackBehavior).toBe("string");
      expect(Array.isArray(r.workflowTags)).toBe(true);
      expect(typeof r.advancedByDefault).toBe("boolean");
      expect(typeof r.commandPaletteVisible).toBe("boolean");
      expect(typeof r.allToolsVisible).toBe("boolean");
      expect(typeof r.sidebarEligible).toBe("boolean");
    }
  });

  it("ACCOUNT-domain routes always declare requiredActiveSpace='NONE'", async () => {
    const mod = await import(
      "../../../apps/web/lib/navigation/routeRegistry.js"
    );
    const accountRoutes = mod.ROUTE_REGISTRY.filter(
      (r: { domain: string }) => r.domain === "ACCOUNT",
    );
    expect(accountRoutes.length).toBeGreaterThan(0);
    for (const r of accountRoutes) {
      expect(
        r.requiredActiveSpace,
        `${r.id} is ACCOUNT domain but requires ${r.requiredActiveSpace}`,
      ).toBe("NONE");
    }
  });

  it("getRouteDefinition returns null for unknown ids", async () => {
    const mod = await import(
      "../../../apps/web/lib/navigation/routeRegistry.js"
    );
    expect(mod.getRouteDefinition("does.not.exist")).toBeNull();
  });
});

// =============================================================================
// PART 2 — resolveRouteAccess: workflow is NEVER an input
// =============================================================================

describe("Phase 38.6 — resolveRouteAccess workflow independence", () => {
  it("the resolver never imports workflow / persona modules or types", () => {
    // The actual programmatic coupling check: no imports from
    // workflow* or persona* modules, no references to the relevant
    // type names in TypeScript-visible identifiers.
    expect(ACCESS_RESOLVER).not.toMatch(/from\s+["'].*workflow/i);
    expect(ACCESS_RESOLVER).not.toMatch(/from\s+["'].*persona/i);
    expect(ACCESS_RESOLVER).not.toMatch(/personaProfile/);
    expect(ACCESS_RESOLVER).not.toMatch(/WorkflowProfileCode/);
    expect(ACCESS_RESOLVER).not.toMatch(/WorkspacePersonaProfile/);
    expect(ACCESS_RESOLVER).not.toMatch(/primaryProfile/);
  });

  it("input type carries activeSpace + capabilities + plan — no workflow", () => {
    // Pin the field names.
    expect(ACCESS_RESOLVER).toMatch(/activeSpaceType/);
    expect(ACCESS_RESOLVER).toMatch(/capabilities/);
    expect(ACCESS_RESOLVER).toMatch(/isPlatformAdmin/);
    expect(ACCESS_RESOLVER).not.toMatch(/workflowProfile|primaryProfile/);
  });

  it("ALLOWED state requires every requiredCapability to be true", async () => {
    const mod = await import(
      "../../../apps/web/lib/navigation/routeAccessResolver.js"
    );
    const result = mod.resolveRouteAccess({
      route: {
        id: "test",
        href: "/test",
        label: "Test",
        description: "",
        domain: "PERSONAL_WORKSPACE",
        requiredCapabilities: ["EVIDENCE_VIEW", "REPORTS_VIEW"],
        requiredActiveSpace: "PERSONAL_OR_ORG",
        fallbackBehavior: "REQUEST_ACCESS",
        workflowTags: [],
        advancedByDefault: false,
        commandPaletteVisible: true,
        allToolsVisible: true,
        sidebarEligible: true,
      },
      activeSpaceType: "PERSONAL",
      isPlatformAdmin: false,
      capabilities: { EVIDENCE_VIEW: true, REPORTS_VIEW: false },
    });
    expect(result.canLoad).toBe(false);
    expect(result.accessState).toBe("DENIED_NO_CAPABILITY");
  });

  it("NEEDS_ORGANIZATION when route is ORGANIZATION_ONLY but actor is in PERSONAL", async () => {
    const mod = await import(
      "../../../apps/web/lib/navigation/routeAccessResolver.js"
    );
    const result = mod.resolveRouteAccess({
      route: {
        id: "test",
        href: "/test",
        label: "Test",
        description: "",
        domain: "REVIEW_OPERATIONS",
        requiredCapabilities: [],
        requiredActiveSpace: "ORGANIZATION_ONLY",
        fallbackBehavior: "CREATE_ORG",
        workflowTags: [],
        advancedByDefault: false,
        commandPaletteVisible: true,
        allToolsVisible: true,
        sidebarEligible: true,
      },
      activeSpaceType: "PERSONAL",
      isPlatformAdmin: false,
      capabilities: {},
    });
    expect(result.canLoad).toBe(false);
    expect(result.accessState).toBe("NEEDS_ORGANIZATION");
    expect(result.canSeeNav).toBe(true);
    expect(result.primaryAction?.href).toBe("/teams");
  });

  it("HIDDEN_IF_NO_CAPABILITY produces canSeeNav=false (truly hidden)", async () => {
    const mod = await import(
      "../../../apps/web/lib/navigation/routeAccessResolver.js"
    );
    const result = mod.resolveRouteAccess({
      route: {
        id: "test",
        href: "/test",
        label: "Test",
        description: "",
        domain: "PLATFORM_ADMIN",
        requiredCapabilities: ["PLATFORM_ADMIN"],
        requiredActiveSpace: "PLATFORM_ADMIN",
        fallbackBehavior: "HIDDEN_IF_NO_CAPABILITY",
        workflowTags: [],
        advancedByDefault: false,
        commandPaletteVisible: false,
        allToolsVisible: false,
        sidebarEligible: false,
      },
      activeSpaceType: "ORGANIZATION",
      isPlatformAdmin: false,
      capabilities: {},
    });
    expect(result.canLoad).toBe(false);
    expect(result.canSeeNav).toBe(false);
  });

  it("REQUEST_ACCESS fallback produces canSeeNav=true with structured CTAs", async () => {
    const mod = await import(
      "../../../apps/web/lib/navigation/routeAccessResolver.js"
    );
    const result = mod.resolveRouteAccess({
      route: {
        id: "governance.retention",
        href: "/governance/retention",
        label: "Retention",
        description: "",
        domain: "GOVERNANCE",
        requiredCapabilities: ["RETENTION_MANAGE"],
        requiredActiveSpace: "ORGANIZATION_ONLY",
        fallbackBehavior: "REQUEST_ACCESS",
        workflowTags: [],
        advancedByDefault: true,
        commandPaletteVisible: true,
        allToolsVisible: true,
        sidebarEligible: true,
      },
      activeSpaceType: "ORGANIZATION",
      isPlatformAdmin: false,
      capabilities: { RETENTION_MANAGE: false },
    });
    expect(result.canLoad).toBe(false);
    expect(result.canSeeNav).toBe(true);
    expect(result.accessState).toBe("DENIED_NO_CAPABILITY");
    expect(result.primaryAction).not.toBeNull();
    expect(result.secondaryAction?.href).toBe("/tools");
  });

  it("ALLOWED state grants canLoad + canSeeNav when all gates pass", async () => {
    const mod = await import(
      "../../../apps/web/lib/navigation/routeAccessResolver.js"
    );
    const result = mod.resolveRouteAccess({
      route: {
        id: "test",
        href: "/test",
        label: "Test",
        description: "",
        domain: "PERSONAL_WORKSPACE",
        requiredCapabilities: ["EVIDENCE_VIEW"],
        requiredActiveSpace: "PERSONAL_OR_ORG",
        fallbackBehavior: "DEGRADED",
        workflowTags: [],
        advancedByDefault: false,
        commandPaletteVisible: true,
        allToolsVisible: true,
        sidebarEligible: true,
      },
      activeSpaceType: "PERSONAL",
      isPlatformAdmin: false,
      capabilities: { EVIDENCE_VIEW: true },
    });
    expect(result.canLoad).toBe(true);
    expect(result.canSeeNav).toBe(true);
    expect(result.accessState).toBe("ALLOWED");
  });
});

// =============================================================================
// PART 3 — resolveWorkflowExposure never adds/removes routes
// =============================================================================

describe("Phase 38.6 — resolveWorkflowExposure invariants", () => {
  it("source never decides canLoad / access — only buckets", () => {
    expect(EXPOSURE_RESOLVER).not.toMatch(/canLoad\s*=/);
    expect(EXPOSURE_RESOLVER).not.toMatch(/accessState\s*=/);
  });

  it("every canSeeNav route lands in at least one bucket", async () => {
    const mod = await import(
      "../../../apps/web/lib/navigation/workflowExposureResolver.js"
    );
    const routes = makeFixtureRoutes(true);
    const out = mod.resolveWorkflowExposure({
      routes,
      primaryWorkflow: "LEGAL_CASEWORK",
      secondaryWorkflows: [],
    });
    const bucketed = new Set([
      ...out.primaryItems.map((i) => i.route.id),
      ...out.secondaryItems.map((i) => i.route.id),
      ...out.moreAdvancedItems.map((i) => i.route.id),
      ...out.allToolsItems.map((i) => i.route.id),
    ]);
    for (const r of routes) {
      if (r.access.canSeeNav) {
        expect(
          bucketed.has(r.route.id),
          `${r.route.id} is canSeeNav but missing from every bucket`,
        ).toBe(true);
      }
    }
  });

  it("canSeeNav=false routes are NOT exposed in sidebar OR all-tools", async () => {
    const mod = await import(
      "../../../apps/web/lib/navigation/workflowExposureResolver.js"
    );
    const hiddenRoute = {
      id: "platform.admin",
      route: {
        id: "platform.admin",
        href: "/admin",
        label: "Platform admin",
        description: "",
        domain: "PLATFORM_ADMIN" as const,
        requiredCapabilities: [],
        requiredActiveSpace: "PLATFORM_ADMIN" as const,
        fallbackBehavior: "HIDDEN_IF_NO_CAPABILITY" as const,
        workflowTags: [],
        advancedByDefault: true,
        commandPaletteVisible: false,
        allToolsVisible: false,
        sidebarEligible: false,
      },
      access: {
        canLoad: false,
        canSeeNav: false,
        accessState: "PLATFORM_ADMIN_ONLY" as const,
        reason: "",
        primaryAction: null,
        secondaryAction: null,
      },
    };
    const out = mod.resolveWorkflowExposure({
      routes: [hiddenRoute],
      primaryWorkflow: "LEGAL_CASEWORK",
      secondaryWorkflows: [],
    });
    expect(out.primaryItems).toHaveLength(0);
    expect(out.secondaryItems).toHaveLength(0);
    expect(out.moreAdvancedItems).toHaveLength(0);
    expect(out.allToolsItems).toHaveLength(0);
  });

  it("LAWYER workflow promotes case-tagged routes to primaryItems", async () => {
    const mod = await import(
      "../../../apps/web/lib/navigation/workflowExposureResolver.js"
    );
    const routes = makeFixtureRoutes(true);
    const out = mod.resolveWorkflowExposure({
      routes,
      primaryWorkflow: "LEGAL_CASEWORK",
      secondaryWorkflows: [],
    });
    const primaryIds = out.primaryItems.map((i) => i.route.id);
    expect(primaryIds).toContain("workspace.cases");
  });

  it("changing workflow re-buckets without changing the route set", async () => {
    const mod = await import(
      "../../../apps/web/lib/navigation/workflowExposureResolver.js"
    );
    const routes = makeFixtureRoutes(true);
    const lawyer = mod.resolveWorkflowExposure({
      routes,
      primaryWorkflow: "LEGAL_CASEWORK",
      secondaryWorkflows: [],
    });
    const reviewOps = mod.resolveWorkflowExposure({
      routes,
      primaryWorkflow: "REVIEW_OPERATIONS",
      secondaryWorkflows: [],
    });
    function ids(set: {
      primaryItems: { route: { id: string } }[];
      secondaryItems: { route: { id: string } }[];
      moreAdvancedItems: { route: { id: string } }[];
    }): Set<string> {
      return new Set([
        ...set.primaryItems.map((i) => i.route.id),
        ...set.secondaryItems.map((i) => i.route.id),
        ...set.moreAdvancedItems.map((i) => i.route.id),
      ]);
    }
    expect(ids(lawyer)).toEqual(ids(reviewOps));
  });

  it("workflow source never references the persona enum directly", () => {
    // The exposure resolver consumes workflow codes, not internal
    // persona enum values.
    expect(EXPOSURE_RESOLVER).not.toMatch(/"LAWYER"|"INSURANCE"|"JOURNALIST"/);
  });
});

// =============================================================================
// PART 4 — PageRouteGate
// =============================================================================

describe("Phase 38.6 — PageRouteGate", () => {
  it("renders children when access.canLoad is true", () => {
    expect(PAGE_GATE).toMatch(/if \(access\.canLoad\) return <>\{children\}<\/>/);
  });

  it("returns null for PLATFORM_ADMIN_ONLY (matches sidebar hide)", () => {
    expect(PAGE_GATE).toMatch(/"PLATFORM_ADMIN_ONLY"/);
    expect(PAGE_GATE).toMatch(/return null/);
  });

  it("exposes data attributes for testability", () => {
    expect(PAGE_GATE).toMatch(/data-page-route-gate\b/);
    expect(PAGE_GATE).toMatch(/data-page-route-gate-state/);
    expect(PAGE_GATE).toMatch(/data-page-route-gate-route-id/);
  });

  it("always offers an All Tools fallback link from a denied state", () => {
    expect(PAGE_GATE).toMatch(/href="\/tools"/);
    expect(PAGE_GATE).toMatch(/data-page-route-gate-all-tools/);
  });

  it("never imports workflow / persona modules; never reads persona fields", () => {
    expect(PAGE_GATE).not.toMatch(/from\s+["'].*workflow/i);
    expect(PAGE_GATE).not.toMatch(/from\s+["'].*persona/i);
    expect(PAGE_GATE).not.toMatch(/personaProfile/);
    expect(PAGE_GATE).not.toMatch(/primaryProfile/);
    expect(PAGE_GATE).not.toMatch(/WorkflowProfileCode/);
  });
});

// =============================================================================
// PART 5 — All Tools surface
// =============================================================================

describe("Phase 38.6 — All Tools surface", () => {
  it("consumes the canonical registry + both resolvers", () => {
    expect(TOOLS_PAGE).toMatch(/ROUTE_REGISTRY/);
    expect(TOOLS_PAGE).toMatch(/resolveRouteAccess/);
    expect(TOOLS_PAGE).toMatch(/resolveWorkflowExposure/);
  });

  it("renders the 'Workflow profiles personalize layout' safety copy", () => {
    expect(TOOLS_PAGE).toMatch(
      /Workflow profiles personalize layout, defaults, and\s+recommendations\. They do not change permissions or remove tools\./,
    );
  });

  it("renders status badges per access state (Available / Requires organization / Requires permission / Requires upgrade)", () => {
    expect(TOOLS_PAGE).toMatch(/Available/);
    expect(TOOLS_PAGE).toMatch(/Requires organization/);
    expect(TOOLS_PAGE).toMatch(/Requires permission/);
    expect(TOOLS_PAGE).toMatch(/Requires upgrade/);
  });

  it("renders a 'Recommended' chip for workflow-tagged primary routes", () => {
    expect(TOOLS_PAGE).toMatch(/data-all-tools-recommended-chip/);
  });

  it("search input is labeled (a11y)", () => {
    expect(TOOLS_PAGE).toMatch(/aria-label="Search tools"/);
  });

  it("denied tools render a 'Request access' or equivalent action — never silently disabled", () => {
    expect(TOOLS_PAGE).toMatch(/data-all-tools-primary-action/);
  });
});

// =============================================================================
// PART 6 — Capability-allowed → reachable somewhere
// =============================================================================

describe("Phase 38.6 — every capability-allowed route is reachable", () => {
  it("ROUTE_REGISTRY: every sidebarEligible route is also allToolsVisible (or carries a noted exception)", async () => {
    const mod = await import(
      "../../../apps/web/lib/navigation/routeRegistry.js"
    );
    for (const r of mod.ROUTE_REGISTRY) {
      if (r.sidebarEligible) {
        expect(
          r.allToolsVisible,
          `${r.id} is sidebarEligible but not allToolsVisible — would be invisible if workflow demotes it`,
        ).toBe(true);
      }
    }
  });

  it("ROUTE_REGISTRY: at least one canonical route is allToolsVisible (smoke check)", async () => {
    const mod = await import(
      "../../../apps/web/lib/navigation/routeRegistry.js"
    );
    const allTools = mod.ROUTE_REGISTRY.filter(
      (r: { allToolsVisible: boolean }) => r.allToolsVisible,
    );
    expect(allTools.length).toBeGreaterThan(5);
  });
});

// =============================================================================
// Fixtures
// =============================================================================

function makeFixtureRoutes(canSeeNav: boolean) {
  return [
    {
      route: {
        id: "workspace.home",
        href: "/home",
        label: "Home",
        description: "",
        domain: "PERSONAL_WORKSPACE" as const,
        requiredCapabilities: [],
        requiredActiveSpace: "PERSONAL_OR_ORG" as const,
        fallbackBehavior: "DEGRADED" as const,
        workflowTags: ["LEGAL_CASEWORK", "REVIEW_OPERATIONS"],
        advancedByDefault: false,
        commandPaletteVisible: true,
        allToolsVisible: true,
        sidebarEligible: true,
      },
      access: {
        canLoad: true,
        canSeeNav,
        accessState: "ALLOWED" as const,
        reason: "",
        primaryAction: null,
        secondaryAction: null,
      },
    },
    {
      route: {
        id: "workspace.cases",
        href: "/cases",
        label: "Cases",
        description: "",
        domain: "PERSONAL_WORKSPACE" as const,
        requiredCapabilities: [],
        requiredActiveSpace: "PERSONAL_OR_ORG" as const,
        fallbackBehavior: "DEGRADED" as const,
        workflowTags: ["LEGAL_CASEWORK"],
        advancedByDefault: false,
        commandPaletteVisible: true,
        allToolsVisible: true,
        sidebarEligible: true,
      },
      access: {
        canLoad: true,
        canSeeNav,
        accessState: "ALLOWED" as const,
        reason: "",
        primaryAction: null,
        secondaryAction: null,
      },
    },
    {
      route: {
        id: "platform.ops_center",
        href: "/ops",
        label: "Ops Center",
        description: "",
        domain: "OPS" as const,
        requiredCapabilities: [],
        requiredActiveSpace: "PERSONAL_OR_ORG" as const,
        fallbackBehavior: "REQUEST_ACCESS" as const,
        workflowTags: ["OPERATIONAL_ADMINISTRATION"],
        advancedByDefault: true,
        commandPaletteVisible: true,
        allToolsVisible: true,
        sidebarEligible: true,
      },
      access: {
        canLoad: true,
        canSeeNav,
        accessState: "ALLOWED" as const,
        reason: "",
        primaryAction: null,
        secondaryAction: null,
      },
    },
  ];
}
