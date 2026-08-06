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
const PLATFORM_ADMIN_ROUTE_IDS = [
  "platform.ops_center", // /operations
  "platform.observability", // /operations/observability
  "operations.readiness", // /operations/readiness
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
    "/operations",
    "/operations/observability",
    "/operations/readiness",
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
    "platform.ops_center": "app/(app)/operations/page.tsx",
    "platform.observability": "app/(app)/operations/observability/page.tsx",
    "operations.readiness": "app/(app)/operations/readiness/page.tsx",
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
