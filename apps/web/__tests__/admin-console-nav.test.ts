/**
 * Admin Console navigation contract.
 *
 * Guards the routing fix: Enterprise Provisioning (and the platform ops
 * surfaces) must be reachable from the admin console nav — never a
 * direct-URL guess — and every admin nav item must route to a real page
 * (no dead tabs). Also pins that provisioning is surfaced in the command
 * palette / All Tools.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ADMIN_NAV_ITEMS,
  TENANT_SCOPED_ADMIN_PATHS,
} from "../components/admin/admin-nav-config";
import { ROUTE_REGISTRY } from "../lib/navigation/routeRegistry";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Map a concrete (non-dynamic) href to its (app) page file. */
function pageForHref(href: string): string {
  return resolve(APP_ROOT, `app/(app)${href}/page.tsx`);
}

test("admin nav exposes Enterprise Provisioning (no direct-URL guessing)", () => {
  const hrefs = ADMIN_NAV_ITEMS.map((i) => i.href);
  assert.ok(
    hrefs.includes("/admin/provisioning"),
    "admin nav must include /admin/provisioning",
  );
  const provItem = ADMIN_NAV_ITEMS.find((i) => i.href === "/admin/provisioning");
  assert.match(provItem!.label, /provision/i, "labelled as Provisioning");
});

test("admin nav exposes the control-plane surfaces", () => {
  const hrefs = ADMIN_NAV_ITEMS.map((i) => i.href);
  for (const href of [
    "/admin",
    "/admin/customers",
    "/admin/workspaces",
    "/admin/users",
    "/admin/billing",
    "/admin/operations",
    "/admin/evidence-ops",
    "/admin/platform-health",
    "/admin/audit",
    "/admin/platform/readiness",
  ]) {
    assert.ok(hrefs.includes(href), `admin nav must include ${href}`);
  }
});

/**
 * ADM-013 — the nav must not promise platform scope it does not deliver.
 *
 * `/admin/platform/observability` and its neighbours resolve a `teamId` from the
 * operator's OWN active workspace and call a tenant API. Listing them in a
 * platform-admin nav told an operator they were cross-tenant views; they are
 * not, and a page that shows one workspace's telemetry while implying it shows
 * every workspace's is a worse failure than a missing link. They stay reachable
 * by URL and command palette, with an explicit scope banner, until they are
 * re-homed out of `/admin/*`.
 */
test("admin nav excludes the workspace-scoped surfaces that live under /admin", () => {
  const hrefs = new Set(ADMIN_NAV_ITEMS.map((i) => i.href));
  for (const href of TENANT_SCOPED_ADMIN_PATHS) {
    assert.ok(
      !hrefs.has(href),
      `${href} is workspace-scoped and must not sit in the platform-admin nav`,
    );
  }
});

/**
 * ADM-013 — `/tools` is the TENANT All-Tools index. It used to sit in this nav
 * and led the operator straight out of the platform console into the product.
 */
test("admin nav does not leak into tenant surfaces", () => {
  const hrefs = ADMIN_NAV_ITEMS.map((i) => i.href);
  assert.ok(!hrefs.includes("/tools"), "/tools is a tenant surface, not admin");
  for (const href of hrefs) {
    assert.ok(
      href.startsWith("/admin"),
      `${href} is outside the admin console and must not be in its nav`,
    );
  }
});

/** Every entry states the operator question it answers (ADM-033 vocabulary). */
test("every admin nav item declares its purpose and group", () => {
  for (const item of ADMIN_NAV_ITEMS) {
    assert.ok(item.purpose.length > 0, `${item.href} must declare a purpose`);
    assert.ok(
      ["CONTROL_PLANE", "COMMERCIAL", "PLATFORM"].includes(item.group),
      `${item.href} must belong to a nav group`,
    );
  }
});

test("every admin nav item routes to a real page on disk (no dead tabs)", () => {
  for (const item of ADMIN_NAV_ITEMS) {
    assert.ok(
      existsSync(pageForHref(item.href)),
      `admin nav item "${item.label}" (${item.href}) must resolve to a page.tsx`,
    );
  }
});

test("platform.provisioning is surfaced in the command palette + All Tools", () => {
  const route = (ROUTE_REGISTRY as ReadonlyArray<Record<string, unknown>>).find(
    (r) => r.id === "platform.provisioning",
  );
  assert.ok(route, "platform.provisioning must be registered");
  assert.equal(route!.href, "/admin/provisioning");
  assert.equal(route!.commandPaletteVisible, true, "must be command-palette visible");
  assert.equal(route!.allToolsVisible, true, "must be All Tools visible");
});
