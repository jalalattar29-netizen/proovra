/**
 * T-125 (Team remediation stage F; audit PRD-01, O-01, ARCH-09) — the SERVER
 * navigation payload (`GET /v1/platform/context` → navigation) advertises only
 * routes that LOAD for the context it is built for.
 *
 * Production advertised /redaction, /workflows, /intelligence, /investigation
 * and /packaging to a Team workspace, and every one answered "We couldn't find
 * that page". For FREE, PRO, TEAM and ENTERPRISE contexts (owner-level
 * capabilities, the plan's server-projected features), every item the server
 * projection emits must:
 *   - name a web route registry entry with the same href,
 *   - resolve through the web's resolveRouteAccess to canLoad,
 *   - pass the /path surface rule (lib/surface/tiers.ts) the page mounts, and
 *   - have a page file.
 * And the inverse: the Team context is no longer advertised the five routes.
 */
import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  NAV_SURFACE_GATES,
  buildNavigationProjection,
  filterNavigationRegistry,
  type NavSurfaceContext,
} from "../../../services/api/src/services/platform-context/navigation-registry";
import { CAPABILITY_KEYS as SERVER_CAPABILITY_KEYS } from "../../../services/api/src/services/platform-context/types";
import { ROUTE_REGISTRY } from "../lib/navigation/routeRegistry";
import { resolveRouteAccess } from "../lib/navigation/routeAccessResolver";
import { canAccessSurface } from "../lib/surface/access";

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "..", "app");

type Profile = {
  name: string;
  ctx: NavSurfaceContext;
};

const TEAM_FEATURES = {
  reportsIncluded: true, verificationPackageIncluded: true, intakeIncluded: true, casesIncluded: true,
  reviewerOperationsIncluded: true, basicRecordReviewIncluded: true, professionalSurfacesIncluded: true,
  reviewQueuesIncluded: true, teamCollaborationIncluded: true, externalReviewIncluded: true,
  redactionIncluded: false, redactionReadRetained: false,
};
const PROFILES: Profile[] = [
  {
    name: "FREE",
    ctx: { isPlatformAdmin: false, isEnterpriseWorkspace: false, activeSpaceType: "PERSONAL", planFeatures: {
      reportsIncluded: false, verificationPackageIncluded: false, intakeIncluded: false, casesIncluded: false,
      reviewerOperationsIncluded: false, basicRecordReviewIncluded: false, professionalSurfacesIncluded: false,
      reviewQueuesIncluded: false, teamCollaborationIncluded: false, externalReviewIncluded: false,
      redactionIncluded: false, redactionReadRetained: false,
    } },
  },
  {
    name: "PRO",
    ctx: { isPlatformAdmin: false, isEnterpriseWorkspace: false, activeSpaceType: "PERSONAL", planFeatures: {
      ...TEAM_FEATURES, reviewerOperationsIncluded: false, reviewQueuesIncluded: false, teamCollaborationIncluded: false,
    } },
  },
  { name: "TEAM", ctx: { isPlatformAdmin: false, isEnterpriseWorkspace: false, activeSpaceType: "PERSONAL", planFeatures: TEAM_FEATURES } },
  {
    name: "ENTERPRISE",
    ctx: { isPlatformAdmin: false, isEnterpriseWorkspace: true, activeSpaceType: "ORGANIZATION", planFeatures: { ...TEAM_FEATURES, redactionIncluded: true } },
  },
];

/** Owner-level capabilities: every capability except platform administration. */
const CAPS = Object.fromEntries(SERVER_CAPABILITY_KEYS.map((k) => [k, k !== "PLATFORM_ADMIN"])) as never;

function advertised(ctx: NavSurfaceContext) {
  const projection = buildNavigationProjection(CAPS, ctx);
  const items = new Map<string, { id: string; href: string }>();
  for (const g of projection.sidebar.groups) for (const i of g.items) items.set(i.id, i);
  for (const p of projection.sidebar.pillars) for (const i of p.items) items.set(i.id, i);
  for (const g of filterNavigationRegistry(CAPS, ctx)) for (const i of g.items) items.set(i.id, i);
  return [...items.values()];
}

function pageExists(href: string): boolean {
  const rel = href.replace(/^\//, "");
  return existsSync(resolve(APP, "(app)", rel, "page.tsx")) || existsSync(resolve(APP, rel, "page.tsx"));
}

for (const profile of PROFILES) {
  test(`${profile.name}: every advertised navigation item opens a page that loads in that context`, () => {
    const items = advertised(profile.ctx);
    assert.ok(items.length > 0, "the projection advertises something");
    for (const item of items) {
      const gate = NAV_SURFACE_GATES[item.id];
      assert.ok(gate, `${item.id} declares the web route it opens`);
      const route = ROUTE_REGISTRY.find((r) => r.id === gate.webRouteId);
      assert.ok(route, `${item.id} → ${gate.webRouteId} exists in the web route registry`);
      assert.equal(route.href, item.href, `${item.id} and ${route.id} name the same href`);
      const access = resolveRouteAccess({
        route,
        activeSpaceType: profile.ctx.activeSpaceType,
        isPlatformAdmin: profile.ctx.isPlatformAdmin,
        capabilities: CAPS,
        isEnterpriseWorkspace: profile.ctx.isEnterpriseWorkspace,
        planFeatures: profile.ctx.planFeatures as never,
        workspace: { id: "ws", status: "active" },
      } as never);
      assert.equal(access.canLoad, true, `${profile.name}: ${item.href} is advertised but ${access.accessState}`);
      assert.equal(
        canAccessSurface(
          { isPlatformAdmin: profile.ctx.isPlatformAdmin, isEnterpriseWorkspace: profile.ctx.isEnterpriseWorkspace, planFeatures: profile.ctx.planFeatures } as never,
          item.href,
        ),
        true,
        `${profile.name}: ${item.href} is advertised but its surface rule refuses it`,
      );
      assert.ok(pageExists(item.href), `${item.href} has a page`);
    }
  });
}

test("TEAM is no longer advertised the five routes that answered 'not found' in production", () => {
  const hrefs = advertised(PROFILES[2]!.ctx).map((i) => i.href);
  for (const gone of ["/redaction", "/workflows", "/intelligence", "/investigation", "/packaging", "/evidence-lifecycle", "/workspaces"]) {
    assert.ok(!hrefs.includes(gone), `${gone} must not be advertised to a Team workspace`);
  }
  // …while the Team tools it does have are.
  for (const kept of ["/review", "/cases", "/intake-links", "/collaboration-teams"]) {
    assert.ok(hrefs.includes(kept), `${kept} stays advertised to Team`);
  }
});

test("redaction follows redactionIncluded alone: an entitled non-Enterprise workspace is advertised it", () => {
  const ctx = { ...PROFILES[2]!.ctx, planFeatures: { ...TEAM_FEATURES, redactionIncluded: true } };
  assert.ok(advertised(ctx).some((i) => i.href === "/redaction"));
  const route = ROUTE_REGISTRY.find((r) => r.id === "workspace.review_redaction")!;
  const access = resolveRouteAccess({
    route, activeSpaceType: "PERSONAL", isPlatformAdmin: false, capabilities: CAPS, isEnterpriseWorkspace: false,
    planFeatures: ctx.planFeatures as never, workspace: { id: "ws", status: "active" },
  } as never);
  assert.equal(access.canSeeNav, true);
});
