/**
 * Team remediation stage F — T-125 / T-126 against the REAL projection
 * (`GET /v1/platform/context`, live PostgreSQL): a Team owner's navigation
 * advertises no route that Team cannot open, and every plan-feature key a web
 * gate reads (route registry requiredPlanFeature / navPlanFeature, surface
 * tier entitlementOverride / readRetainedOverride) is projected as a boolean.
 *
 * Audited production (O-01): the Team navigation carried /redaction,
 * /workflows, /intelligence, /investigation, /packaging (404) and
 * /evidence-lifecycle, /workspaces (redirects).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import { ROUTE_REGISTRY } from "../../../apps/web/lib/navigation/routeRegistry";
import { SURFACE_TIER_RULES } from "../../../apps/web/lib/surface/tiers";

describe("T-125 / T-126 — platform-context navigation and plan features (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  const P = () => h.fixtures.personal;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    await prisma.entitlement.updateMany({ where: { userId: P().userId }, data: { active: false } });
    await prisma.entitlement.create({ data: { userId: P().userId, plan: "TEAM", active: true, credits: 0 } });
  }, 900_000);
  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  async function context() {
    const res = await h.app.inject({
      method: "GET",
      url: "/v1/platform/context",
      headers: { authorization: `Bearer ${P().token}`, "x-proovra-workspace-id": P().teamId },
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as {
      planFeatures: Record<string, unknown>;
      flags?: { isEnterpriseWorkspace?: boolean };
      navigation: {
        groups: Array<{ items: Array<{ href: string }> }>;
        sidebar: { groups: Array<{ items: Array<{ href: string }> }>; pillars: Array<{ items: Array<{ href: string }> }> };
      };
    };
  }

  it("a Team owner is not advertised a route Team cannot open, and keeps the Team tools", async () => {
    const env = await context();
    expect(env.flags?.isEnterpriseWorkspace ?? false).toBe(false);
    const hrefs = new Set<string>();
    for (const g of env.navigation.groups) for (const i of g.items) hrefs.add(i.href);
    for (const g of env.navigation.sidebar.groups) for (const i of g.items) hrefs.add(i.href);
    for (const p of env.navigation.sidebar.pillars) for (const i of p.items) hrefs.add(i.href);
    for (const gone of ["/redaction", "/workflows", "/intelligence", "/investigation", "/packaging", "/evidence-lifecycle", "/workspaces"]) {
      expect(hrefs.has(gone), `${gone} advertised to Team`).toBe(false);
    }
    for (const kept of ["/review", "/cases", "/collaboration-teams", "/intake-links"]) {
      expect(hrefs.has(kept), `${kept} missing for Team`).toBe(true);
    }
  });

  it("every plan-feature key a web gate reads is projected as a boolean", async () => {
    const env = await context();
    const keys = new Set<string>();
    for (const r of ROUTE_REGISTRY) {
      if (r.requiredPlanFeature) keys.add(r.requiredPlanFeature);
      if (r.navPlanFeature) keys.add(r.navPlanFeature);
    }
    // Stage E: a surface rule names its registry route (entitlementRouteId);
    // its plan keys are that route's, already collected above.
    for (const rule of SURFACE_TIER_RULES) {
      if (!rule.entitlementRouteId) continue;
      const route = ROUTE_REGISTRY.find((r) => r.id === rule.entitlementRouteId);
      expect(route, `surface rule ${rule.pathPrefix} names a registry route`).toBeTruthy();
      if (route?.readRetainedPlanFeature) keys.add(route.readRetainedPlanFeature);
    }
    expect(keys.size).toBeGreaterThan(5);
    for (const key of keys) {
      expect(typeof env.planFeatures[key], `planFeatures.${key}`).toBe("boolean");
    }
  });
});
