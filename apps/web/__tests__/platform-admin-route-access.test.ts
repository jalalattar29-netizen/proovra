/**
 * Platform Admin — INTERNAL route access contract.
 *
 * Regression lock for the bug where a Platform Admin passed the
 * PLATFORM_ADMIN elevation gate but was then denied at the granular
 * capability loop (DENIED_NO_CAPABILITY), so /operations* effectively
 * 404'd for admin@proovra.com. Elevation must satisfy the granular
 * platform-admin capabilities.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ROUTE_REGISTRY } from "../lib/navigation/routeRegistry";
import { resolveRouteAccess } from "../lib/navigation/routeAccessResolver";
import { canAccessSurface, type SurfaceUserContext } from "../lib/surface/access";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Routes that are platform-admin-scoped in the resolver (requiredActiveSpace
// or domain === PLATFORM_ADMIN). /tools is INTERNAL at the surface tier but
// ACCOUNT-scoped in the resolver, so it is tested separately.
/**
 * CONTRACT MIGRATION — Attention Architecture Phase 4B (2026-08-22).
 *
 * `/operations` LEFT this list, deliberately, and that is the point of the
 * phase rather than a weakening of this gate.
 *
 * It was registered as `platform.ops_center` with the platform-tier
 * `OPS_CENTER_VIEW` capability and `requiredActiveSpace: PLATFORM_ADMIN`,
 * which meant the one surface answering "what unresolved work does MY
 * workspace have?" was reachable only by PROOVRA staff. It is now
 * `workspace.operations`, gated on a valid active workspace plus
 * `OPERATIONS_VIEW`.
 *
 * The gate this file exists to enforce is UNCHANGED and is now stronger: the
 * platform consoles below are still platform-only, and a new test asserts the
 * property that actually matters after the unlock — a tenant who CAN reach
 * `/operations` still cannot reach any `/admin/platform/*` console.
 */
const PLATFORM_ADMIN_ROUTE_IDS = [
  "platform.observability", // /admin/platform/observability
  "operations.readiness", // /admin/platform/readiness
  "platform.provisioning", // /admin/provisioning
] as const;

function routeById(id: string) {
  const r = (ROUTE_REGISTRY as ReadonlyArray<{ id: string }>).find(
    (x) => x.id === id,
  );
  assert.ok(r, `route ${id} must be registered in ROUTE_REGISTRY`);
  return r as never;
}

const PLATFORM_ADMIN_CTX: SurfaceUserContext = {
  planFeatures: { intakeIncluded: null, professionalSurfacesIncluded: false },
  isPlatformAdmin: true,
  isEnterpriseWorkspace: false,
};

// A non-platform user on a plain (non-enterprise) plan — so ENTERPRISE and
// INTERNAL surface tiers both deny them.
const NON_PLATFORM_CTX: SurfaceUserContext = {
  planFeatures: { intakeIncluded: null, professionalSurfacesIncluded: true },
  isPlatformAdmin: false,
  isEnterpriseWorkspace: false,
};

test("Platform Admin can LOAD every platform-admin route with ZERO granular capabilities", () => {
  for (const id of PLATFORM_ADMIN_ROUTE_IDS) {
    const route = routeById(id);
    const res = resolveRouteAccess({
      route,
      activeSpaceType: "PERSONAL",
      isPlatformAdmin: true,
      capabilities: {}, // NO OPS_CENTER_VIEW / OBSERVABILITY_VIEW — elevation must suffice
    });
    assert.equal(res.canLoad, true, `${id} must be loadable by a platform admin`);
    assert.equal(res.canSeeNav, true, `${id} must be nav-visible to a platform admin`);
    assert.equal(res.accessState, "ALLOWED", `${id} must resolve ALLOWED`);
  }
});

test("Non-platform user CANNOT access platform-admin routes even WITH the capabilities", () => {
  for (const id of PLATFORM_ADMIN_ROUTE_IDS) {
    const route = routeById(id);
    const res = resolveRouteAccess({
      route,
      activeSpaceType: "ORGANIZATION",
      isPlatformAdmin: false,
      capabilities: {
        OPS_CENTER_VIEW: true,
        OBSERVABILITY_VIEW: true,
        PLATFORM_ADMIN: true,
      } as never,
    });
    assert.equal(res.canLoad, false, `${id} must be denied to a non-platform user`);
    assert.equal(res.accessState, "PLATFORM_ADMIN_ONLY");
  }
});

test("canAccessSurface: INTERNAL surfaces are admin-only", () => {
  const internalSurfaces = [
    "/admin/platform/observability",
    "/admin/platform/readiness",
    "/tools",
  ];
  for (const href of internalSurfaces) {
    assert.equal(
      canAccessSurface(PLATFORM_ADMIN_CTX, href),
      true,
      `platform admin must access ${href}`,
    );
    assert.equal(
      canAccessSurface(NON_PLATFORM_CTX, href),
      false,
      `non-platform user must NOT access ${href}`,
    );
  }
  // /admin/provisioning is ENTERPRISE at the surface tier; admin passes, a
  // plain PRO non-admin does not.
  assert.equal(canAccessSurface(PLATFORM_ADMIN_CTX, "/admin/provisioning"), true);
  assert.equal(canAccessSurface(NON_PLATFORM_CTX, "/admin/provisioning"), false);
});

test("/admin/provisioning loads for a Platform Admin in Personal Space", () => {
  const route = routeById("platform.provisioning");
  const res = resolveRouteAccess({
    route,
    activeSpaceType: "PERSONAL", // Personal Space — not an org
    isPlatformAdmin: true,
    capabilities: {},
  });
  assert.equal(res.canLoad, true, "provisioning must load from Personal Space");
});

test("no INTERNAL route 404s for a Platform Admin — every registered route has a page on disk", () => {
  const pages: Record<string, string> = {
    "workspace.operations": "app/(app)/operations/page.tsx",
    "platform.observability": "app/(app)/admin/platform/observability/page.tsx",
    "operations.readiness": "app/(app)/admin/platform/readiness/page.tsx",
    "platform.provisioning": "app/(app)/admin/provisioning/page.tsx",
    "workspace.tools": "app/(app)/tools/page.tsx",
  };
  for (const [id, page] of Object.entries(pages)) {
    routeById(id); // registered
    assert.ok(
      existsSync(resolve(APP_ROOT, page)),
      `${id} must resolve to a page on disk: ${page}`,
    );
  }
});

// ============================================================================
// ATTENTION ARCHITECTURE PHASE 4B (2026-08-22) — THE UNLOCK, AND ITS BOUNDARY.
//
// Unlocking tenant Operations is only safe if the platform boundary survives
// it. These four tests are the proof, and they are the reason the route was
// allowed to leave PLATFORM_ADMIN_ROUTE_IDS above.
// ============================================================================

test("a tenant WITH OPERATIONS_VIEW can load /operations", () => {
  const res = resolveRouteAccess({
    route: routeById("workspace.operations"),
    activeSpaceType: "ORGANIZATION",
    isPlatformAdmin: false,
    capabilities: { OPERATIONS_VIEW: true } as never,
  });
  assert.equal(res.canLoad, true, "a tenant operator must reach Operations");
  assert.equal(res.accessState, "ALLOWED");
});

test("a tenant WITHOUT OPERATIONS_VIEW cannot load /operations", () => {
  // A Free personal workspace produces no operational conditions, so it is
  // granted no OPERATIONS_VIEW and gets no Operations surface. This is
  // capability-driven, not a plan-name comparison anywhere.
  const res = resolveRouteAccess({
    route: routeById("workspace.operations"),
    activeSpaceType: "PERSONAL",
    isPlatformAdmin: false,
    capabilities: {} as never,
  });
  assert.equal(res.canLoad, false);
  assert.notEqual(res.accessState, "ALLOWED");
});

test("the tenant Operations route is NOT platform-gated any more", () => {
  const route = routeById("workspace.operations") as {
    requiredActiveSpace: string;
    requiredCapabilities: readonly string[];
  };
  assert.notEqual(
    route.requiredActiveSpace,
    "PLATFORM_ADMIN",
    "tenant Operations must not require the platform space",
  );
  assert.ok(
    route.requiredCapabilities.includes("OPERATIONS_VIEW"),
    "tenant Operations must be gated on OPERATIONS_VIEW",
  );
  // And it must NOT be gated on a platform-tier key, which would re-lock it
  // by a different name.
  for (const platformKey of [
    "OPS_CENTER_VIEW",
    "OBSERVABILITY_VIEW",
    "RUNBOOKS_VIEW",
    "PLATFORM_ADMIN",
  ]) {
    assert.ok(
      !route.requiredCapabilities.includes(platformKey),
      `tenant Operations must not require the platform key ${platformKey}`,
    );
  }
});

test("a tenant who CAN reach Operations still cannot reach any platform console", () => {
  // THE property the unlock had to preserve. Holding every Operations
  // capability grants nothing under /admin/platform/*.
  const operatorCapabilities = {
    OPERATIONS_VIEW: true,
    OPERATIONS_ACKNOWLEDGE: true,
    OPERATIONS_ASSIGN: true,
    OPERATIONS_RESOLVE: true,
    OPERATIONS_SUPPRESS: true,
  } as never;
  for (const id of PLATFORM_ADMIN_ROUTE_IDS) {
    const res = resolveRouteAccess({
      route: routeById(id),
      activeSpaceType: "ORGANIZATION",
      isPlatformAdmin: false,
      capabilities: operatorCapabilities,
    });
    assert.equal(
      res.canLoad,
      false,
      `${id} must stay denied to a tenant operator`,
    );
    assert.equal(res.accessState, "PLATFORM_ADMIN_ONLY");
  }
});
